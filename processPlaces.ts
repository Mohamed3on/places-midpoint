import puppeteer, { Page } from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Client, GeocodeResult, LatLngLiteral } from '@googlemaps/google-maps-services-js';
import pLimit from 'p-limit';
import { geometricMedianOnSphere } from './midpoint.js';

// --- Setup ---
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const client = new Client({});
const API_KEY = process.env.API_KEY || '';
const EARTH_RADIUS = 6371e3; // Earth's radius in meters

// --- Types ---
export type SavedPlace = {
  current?: boolean;
  address?: string;
  latLng?: { lat: number; lng: number };
  categories: string[];
  permanentlyClosed?: boolean;
};
export type SavedPlaces = Record<string, SavedPlace>;

// --- Argument Parsing ---
const parseArgv = () => {
  return yargs(hideBin(process.argv))
    .option('urls', {
      alias: 'u',
      type: 'array',
      description: 'List of URLs to scrape (takes precedence over default)',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output JSON file path for places data',
      default: 'places.json',
    })
    .option('region', {
      alias: 'r',
      type: 'string',
      description: 'Region hint for geocoding',
      default: 'berlin',
    })
    .help()
    .alias('help', 'h')
    .parseSync();
};

const argv = parseArgv();
const DEFAULT_URLS: string[] = ['https://maps.app.goo.gl/46JzN7qi1jqQpDVY6']; // Add more default URLs if needed

// --- Puppeteer Helpers (from index.ts) ---
export const disableImagesAndFontRequests = async (page: Page): Promise<void> => {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (['image', 'font', 'media'].includes(request.resourceType())) {
      request.abort();
    } else {
      request.continue();
    }
  });
};

export const scrollAllPlacesInAList = async (page: puppeteer.Page, numberOfPlaces: number) => {
  console.log('🚀 scrolling all places in the list');
  let currentlyDisplayedPlaces = await page.$$('.fontHeadlineSmall.rZF81c');
  let previousNumberOfPlaces = 0;
  let numberOfIterationsWithOutNewPlaces = 0;

  while (currentlyDisplayedPlaces.length < numberOfPlaces) {
    await page.evaluate(
      (element) => element?.scrollIntoView(),
      currentlyDisplayedPlaces[currentlyDisplayedPlaces.length - 1]
    );
    await new Promise((r) => setTimeout(r, 500)); // Wait for potential loading

    previousNumberOfPlaces = currentlyDisplayedPlaces.length;
    currentlyDisplayedPlaces = await page.$$('.fontHeadlineSmall.rZF81c');

    if (currentlyDisplayedPlaces.length === previousNumberOfPlaces) {
      numberOfIterationsWithOutNewPlaces++;
      if (numberOfIterationsWithOutNewPlaces >= 5) {
        console.log('No new places loaded after 5 attempts, breaking the loop');
        break;
      }
    } else {
      numberOfIterationsWithOutNewPlaces = 0;
    }
    console.log(`Loaded ${currentlyDisplayedPlaces.length} out of ${numberOfPlaces} places`);
  }
  console.log('Finished scrolling all places');
  return currentlyDisplayedPlaces;
};

const getPlaceInfoFromPage = async (page: Page) => {
  const placeElements = await page.$$('.BsJqK.xgHk6');
  const places = await Promise.all(
    placeElements.map(async (element) => {
      const name = await element.$eval(
        '.fontHeadlineSmall.rZF81c',
        (el) => el.textContent?.trim() || ''
      );
      const permanentlyClosed = await element
        .$eval('.IIrLbb', (el) => el.textContent?.includes('Permanently closed') || false)
        .catch(() => false); // Handle cases where the element might not exist
      return { name, permanentlyClosed };
    })
  );
  return places;
};

const getListName = async (page: Page) => {
  return await page.$eval('h1', (el) => el.textContent);
};

// --- Geocoding Helpers (from getLatLng.ts) ---
export const getLatLngAndAddress = async (
  placeName: string,
  region: string
): Promise<{ address: string; latLng: { lat: number; lng: number } } | null> => {
  if (!API_KEY) {
    console.error('API_KEY is missing. Please set it in your .env file.');
    return null;
  }
  try {
    const response = await client.geocode({
      params: {
        address: `${placeName}`,
        key: API_KEY,
        components: `administrative_area:${region}`,
      },
    });
    const results: GeocodeResult[] | undefined = response.data.results;
    if (results && results.length > 0) {
      console.log(`🌍 Geocoded ${placeName}: ${results[0].formatted_address}`);
      return { address: results[0].formatted_address, latLng: results[0].geometry.location };
    } else {
      console.warn(`No geocoding results for ${placeName} in ${region}`);
    }
  } catch (error) {
    console.error(`Error fetching lat/lng for place: ${placeName}`, error);
  }
  return null;
};

// --- Midpoint Helpers (from midpoint.ts) ---
function geographicMidpoint(coordinates: LatLngLiteral[]): LatLngLiteral {
  if (coordinates.length === 0) return { lat: 0, lng: 0 };
  let sumX = 0,
    sumY = 0,
    sumZ = 0;
  for (const coord of coordinates) {
    const latRad = (coord.lat * Math.PI) / 180;
    const lngRad = (coord.lng * Math.PI) / 180;
    sumX += Math.cos(latRad) * Math.cos(lngRad);
    sumY += Math.cos(latRad) * Math.sin(lngRad);
    sumZ += Math.sin(latRad);
  }
  const count = coordinates.length;
  const avgX = sumX / count,
    avgY = sumY / count,
    avgZ = sumZ / count;
  const lon = Math.atan2(avgY, avgX);
  const hyp = Math.sqrt(avgX * avgX + avgY * avgY);
  const lat = Math.atan2(avgZ, hyp);
  return { lat: (lat * 180) / Math.PI, lng: (lon * 180) / Math.PI };
}

function haversineDistance(p1: LatLngLiteral, p2: LatLngLiteral): number {
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((p1.lat * Math.PI) / 180) *
      Math.cos((p2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS * c;
}

async function centerOfMinimumDistance(coordinates: LatLngLiteral[]): Promise<LatLngLiteral> {
  if (coordinates.length === 0) return { lat: 0, lng: 0 };
  if (coordinates.length === 1) return coordinates[0];

  // Call the new geometric median function directly
  console.log(`📍 Calculating Center of Minimum Distance using geometricMedianOnSphere...`);
  const result = geometricMedianOnSphere(coordinates);
  return result;
}

async function getReverseGeocodedAddress(latLng: LatLngLiteral): Promise<string> {
  if (!API_KEY) {
    console.error('API_KEY is missing for reverse geocoding.');
    return 'Address lookup failed (Missing API Key)';
  }
  try {
    const response = await client.reverseGeocode({ params: { latlng: latLng, key: API_KEY } });
    return response.data.results[0]?.formatted_address || 'Address not found';
  } catch (error) {
    console.error(`Error getting address for ${latLng.lat},${latLng.lng}:`, error);
    return 'Address lookup failed';
  }
}

// --- File I/O ---
const readPlacesFromDisk = async (filePath: string): Promise<SavedPlaces> => {
  try {
    if (await fs.pathExists(filePath)) {
      return await fs.readJson(filePath);
    }
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
  }
  return {};
};

const savePlacesToDisk = async (filePath: string, data: SavedPlaces): Promise<void> => {
  try {
    await fs.outputJson(filePath, data, { spaces: 2 });
    console.log(`✅ Places data saved to ${filePath}`);
  } catch (error) {
    console.error(`Error saving data to ${filePath}:`, error);
  }
};

// --- Main Execution ---
(async () => {
  console.log('Starting place processing...');
  const placesFilePath = path.resolve(__dirname, argv.output);
  let savedPlaces: SavedPlaces = await readPlacesFromDisk(placesFilePath);

  // Set all existing places as not current initially
  Object.values(savedPlaces).forEach((place) => (place.current = false));

  const browser = await puppeteer.launch({
    headless: false, // Set to true for headless operation
    executablePath: '/opt/homebrew/bin/chromium', // Adjust if needed
    args: ['--disable-site-isolation-trials', '--lang=en-GB,en'],
  });
  const page = await browser.newPage();
  await disableImagesAndFontRequests(page);

  const urlsToScrape = (argv.urls as string[])?.length ? (argv.urls as string[]) : DEFAULT_URLS;
  console.log(`Scraping URLs: ${urlsToScrape.join(', ')}`);

  const permanentlyClosedPlaces: Record<string, string[]> = {}; // Track closed places per list

  try {
    // --- 1. Scraping ---
    console.log('\n--- Scraping Phase ---');
    for (const url of urlsToScrape) {
      console.log(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 }); // Increased timeout

      // Handle consent overlay
      if (page.url().includes('consent')) {
        // also if page text includes "Before you continue"
        const pageText = await page.evaluate(() => document.body.textContent || '');
        if (pageText.includes('Before you continue')) {
          try {
            const consentButton = await page.waitForSelector(
              '[aria-label="Accept all"], [aria-label="Alle akzeptieren"]',
              { timeout: 5000 }
            );
            if (consentButton) {
              console.log('Clicking consent button...');
              await consentButton.click();
              await page.waitForNavigation({ waitUntil: 'networkidle0' });
            }
          } catch (e) {
            console.log('Consent button not found or timed out.');
          }
        }
      }
      await page.waitForSelector('h1', { timeout: 30000 }); // Wait for list title

      const listName = await getListName(page);
      if (!listName) {
        console.error(`Could not find list name for URL: ${url}. Skipping.`);
        continue;
      }
      console.log(`👀 Processing list: ${listName}`);

      const numberOfPlacesText = await page.$eval('.fontBodyMedium h2', (el) => el.textContent);
      const numberOfPlaces = parseInt(numberOfPlacesText?.match(/\d+/g)?.[0] || '0');
      console.log(`List claims ${numberOfPlaces} places.`);

      if (numberOfPlaces > 0) {
        await scrollAllPlacesInAList(page, numberOfPlaces);
        const placesFromPage = await getPlaceInfoFromPage(page);
        console.log(`Scraped ${placesFromPage.length} places from the page.`);

        for (const { name: placeName, permanentlyClosed } of placesFromPage) {
          if (!placeName) continue; // Skip if name is empty

          if (!savedPlaces[placeName]) {
            console.log(`➕ Adding new place: ${placeName}`);
            savedPlaces[placeName] = { categories: [listName], current: true, permanentlyClosed };
          } else {
            console.log(`🔄 Updating existing place: ${placeName}`);
            savedPlaces[placeName].current = true;
            savedPlaces[placeName].permanentlyClosed = permanentlyClosed;
            if (!savedPlaces[placeName].categories.includes(listName)) {
              savedPlaces[placeName].categories.push(listName);
            }
          }

          if (permanentlyClosed) {
            if (!permanentlyClosedPlaces[listName]) permanentlyClosedPlaces[listName] = [];
            if (!permanentlyClosedPlaces[listName].includes(placeName)) {
              permanentlyClosedPlaces[listName].push(placeName);
            }
          }
        }
      } else {
        console.log(`Skipping scroll/scrape for ${listName} as it has 0 places.`);
      }
    }

    // Remove places that weren't seen in this run
    const placesToRemove = Object.entries(savedPlaces)
      .filter(([_, place]) => !place.current)
      .map(([name]) => name);

    if (placesToRemove.length > 0) {
      console.log(`\n🗑️ Removing ${placesToRemove.length} places not found in this run:`);
      placesToRemove.forEach((placeName) => {
        console.log(`   - ${placeName}`);
        delete savedPlaces[placeName];
      });
    }

    // --- 2. Geocoding ---
    console.log('\n--- Geocoding Phase ---');
    const placesToGeocode = Object.entries(savedPlaces).filter(
      ([_, place]) => !place.latLng || !place.address
    );
    console.log(`Found ${placesToGeocode.length} places needing geocoding.`);

    if (placesToGeocode.length > 0 && !API_KEY) {
      console.warn('API_KEY is missing. Skipping geocoding.');
    } else if (placesToGeocode.length > 0) {
      const limit = pLimit(10); // Limit concurrent geocoding requests
      const geocodePromises = placesToGeocode.map(([placeName, _]) =>
        limit(async () => {
          const result = await getLatLngAndAddress(placeName, argv.region);
          if (result) {
            savedPlaces[placeName].address = result.address;
            savedPlaces[placeName].latLng = result.latLng;
          } else {
            console.error(`Failed to geocode ${placeName}`);
            delete savedPlaces[placeName];
          }
        })
      );
      await Promise.all(geocodePromises);
      console.log('Geocoding complete.');
    }

    // --- 3. Save Enriched Data ---
    await savePlacesToDisk(placesFilePath, savedPlaces);

    // Log permanently closed places found during scrape
    console.log('\n--- Permanently Closed Places Found ---');
    if (Object.keys(permanentlyClosedPlaces).length === 0) {
      console.log('None found in scraped lists.');
    } else {
      for (const [listName, places] of Object.entries(permanentlyClosedPlaces)) {
        console.log(`${listName}:`);
        places.forEach((place) => console.log(`  - ${place}`));
      }
    }

    // --- 4. Midpoint Calculation ---
    console.log('\n--- Midpoint Calculation Phase ---');
    const coordinates = Object.values(savedPlaces)
      .map((place) => place.latLng)
      .filter((latLng): latLng is LatLngLiteral => latLng !== undefined); // Type guard

    // Deduplicate coordinates based on lat/lng string representation
    const uniqueCoordinateStrings = new Set(
      coordinates.map((coord) => `${coord.lat.toFixed(6)},${coord.lng.toFixed(6)}`)
    );
    const uniqueCoordinates = Array.from(uniqueCoordinateStrings).map((str) => {
      const [lat, lng] = str.split(',').map(Number);
      return { lat, lng };
    });

    if (uniqueCoordinates.length > 0) {
      console.log(
        `Calculating midpoints based on ${uniqueCoordinates.length} unique places with coordinates.`
      );

      const geoMidpoint = geographicMidpoint(uniqueCoordinates);
      const minDistMidpoint = await centerOfMinimumDistance(uniqueCoordinates); // This one can take time

      const [geoAddress, minDistAddress] = await Promise.all([
        getReverseGeocodedAddress(geoMidpoint),
        getReverseGeocodedAddress(minDistMidpoint),
      ]);

      console.log('\n--- Midpoint Results ---');
      console.log('📍 Geographic Midpoint:', { ...geoMidpoint, address: geoAddress });
      console.log('📍 Center of Minimum Distance:', {
        ...minDistMidpoint,
        address: minDistAddress,
      });

      // Optional: Save midpoints to a separate file
      // await fs.outputJson(path.resolve(__dirname, 'midpoints.json'), {
      //     geoMidpoint: { ...geoMidpoint, address: geoAddress },
      //     minDistMidpoint: { ...minDistMidpoint, address: minDistAddress }
      // }, { spaces: 2 });
      // console.log("✅ Midpoint data saved to midpoints.json");
    } else {
      console.log('No unique coordinates found to calculate midpoints.');
    }
  } catch (error) {
    console.error('\n💥 An error occurred during processing:', error);
    // Save whatever data we have gathered so far in case of error
    await savePlacesToDisk(placesFilePath, savedPlaces);
  } finally {
    await browser.close();
    console.log('\nBrowser closed. Processing finished.');
  }
})();

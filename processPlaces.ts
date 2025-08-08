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
    .option('parallel', {
      alias: 'p',
      type: 'boolean',
      description: 'Enable parallel processing of URLs in separate tabs',
      default: true,
    })
    .option('maxTabs', {
      alias: 'm',
      type: 'number',
      description: 'Maximum number of concurrent tabs (only used with --parallel)',
      default: 4,
    })
    .option('excludeClosed', {
      alias: 'x',
      type: 'boolean',
      description: 'Exclude permanently closed places from midpoint calculation',
      default: false,
    })
    .help()
    .alias('help', 'h')
    .parseSync();
};

const argv = parseArgv();
const DEFAULT_URLS: string[] = [
  'https://maps.app.goo.gl/nP5uZ5NwZbqmhLDv5',
  'https://maps.app.goo.gl/U3xkLFaf3cJeEmgw9',
  'https://maps.app.goo.gl/RLF9GLmoizghFYgr5',
  'https://maps.app.goo.gl/gdSA7CgMrQMyeC2y6',
]; // Add more default URLs if needed

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

      // Check for permanently closed status more precisely
      let permanentlyClosed = false;
      try {
        // First try the specific selector for "Permanently closed" text
        const closedElement = await element.$('.eXlrNe');
        if (closedElement) {
          const closedText = await closedElement.evaluate((el) => el.textContent?.trim() || '');
          const lowerText = closedText.toLowerCase();
          permanentlyClosed =
            lowerText.includes('permanently closed') ||
            lowerText.includes('dauerhaft geschlossen') ||
            lowerText.includes('cerrado permanentemente');
        }

        // Fallback: check broader IIrLbb elements for the text
        if (!permanentlyClosed) {
          const statusElements = await element.$$('.IIrLbb');
          for (const statusEl of statusElements) {
            const statusText = await statusEl.evaluate((el) => el.textContent?.trim() || '');
            const lowerText = statusText.toLowerCase();
            if (
              lowerText.includes('permanently closed') ||
              lowerText.includes('dauerhaft geschlossen') ||
              lowerText.includes('cerrado permanentemente')
            ) {
              permanentlyClosed = true;
              break;
            }
          }
        }
      } catch (e) {
        // Handle cases where elements might not exist
        permanentlyClosed = false;
      }

      // Debug logging for permanently closed detection
      if (permanentlyClosed) {
        console.log(`[Tab] 🚫 Detected permanently closed place: ${name}`);
      }

      return { name, permanentlyClosed };
    })
  );
  return places;
};

const getListName = async (page: Page) => {
  return await page.$eval('h1', (el) => el.textContent);
};

// --- Parallel Processing Function with Retry ---
const processUrlInTabWithRetry = async (
  browser: puppeteer.Browser,
  url: string,
  maxRetries: number = 2
): Promise<{
  savedPlaces: SavedPlaces;
  permanentlyClosedPlaces: Record<string, string[]>;
}> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Tab] Attempt ${attempt}/${maxRetries} for ${url}`);
      return await processUrlInTab(browser, url);
    } catch (error) {
      console.error(
        `[Tab] Attempt ${attempt} failed for ${url}:`,
        error instanceof Error ? error.message : String(error)
      );
      if (attempt === maxRetries) {
        console.error(`[Tab] All ${maxRetries} attempts failed for ${url}, returning empty result`);
        return { savedPlaces: {}, permanentlyClosedPlaces: {} };
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return { savedPlaces: {}, permanentlyClosedPlaces: {} };
};

// --- Helper Functions ---
const isPageResponsive = async (page: Page): Promise<boolean> => {
  if (page.isClosed()) return false;
  try {
    await page.evaluate(() => document.readyState);
    return true;
  } catch (e) {
    return false;
  }
};

const safeEvaluate = async <T>(page: Page, pageFunction: () => T, defaultValue: T): Promise<T> => {
  try {
    if (!(await isPageResponsive(page))) return defaultValue;
    return await page.evaluate(pageFunction);
  } catch (e) {
    console.log(`[Tab] Safe evaluate failed:`, e instanceof Error ? e.message : String(e));
    return defaultValue;
  }
};

// --- Core Processing Function ---
const processUrlInTab = async (
  browser: puppeteer.Browser,
  url: string
): Promise<{
  savedPlaces: SavedPlaces;
  permanentlyClosedPlaces: Record<string, string[]>;
}> => {
  const page = await browser.newPage();
  await disableImagesAndFontRequests(page);

  const localSavedPlaces: SavedPlaces = {};
  const localPermanentlyClosedPlaces: Record<string, string[]> = {};

  try {
    console.log(`[Tab] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    // Add a small delay to let the page settle
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check if page is still responsive
    if (page.isClosed()) {
      throw new Error('Page was closed during navigation');
    }

    // Handle consent overlay - check for "Before you continue" text first
    const pageText = await safeEvaluate(page, () => document.body.textContent || '', '');

    if (pageText.includes('Before you continue') || page.url().includes('consent')) {
      console.log(`[Tab] Detected consent page for ${url}, attempting to accept...`);
      try {
        // Try multiple selector strategies for the accept button
        const possibleSelectors = [
          '[aria-label="Accept all"]',
          '[aria-label="Alle akzeptieren"]',
          '[data-value="accept"]',
          '#L2AGLb', // Common Google consent button ID
          'button[data-ved*="accept"]',
          'button[jsname]', // Will check text content separately
        ];

        let buttonClicked = false;
        for (const selector of possibleSelectors) {
          try {
            // Check if page is still responsive before trying selector
            if (page.isClosed()) break;

            const button = await page.waitForSelector(selector, { timeout: 2000 });
            if (button) {
              // For button[jsname], check if text contains accept/akzeptieren
              if (selector === 'button[jsname]') {
                try {
                  const buttonText = await page.evaluate(
                    (el) => el.textContent?.toLowerCase() || '',
                    button
                  );
                  if (!buttonText.includes('accept') && !buttonText.includes('akzeptieren')) {
                    continue; // Skip this button, doesn't contain the right text
                  }
                } catch (evalError) {
                  console.log(
                    `[Tab] Error evaluating button text, skipping:`,
                    evalError instanceof Error ? evalError.message : String(evalError)
                  );
                  continue;
                }
              }
              console.log(`[Tab] Found consent button with selector: ${selector}`);
              await button.click();
              buttonClicked = true;
              break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }

        if (!buttonClicked && !page.isClosed()) {
          // Fallback: try to find any button containing "accept" text (case insensitive)
          const acceptButton = await safeEvaluate(
            page,
            () => {
              const buttons = Array.from(document.querySelectorAll('button'));
              return buttons.find(
                (button) =>
                  button.textContent?.toLowerCase().includes('accept') ||
                  button.textContent?.toLowerCase().includes('akzeptieren')
              );
            },
            null
          );

          if (acceptButton && (await isPageResponsive(page))) {
            try {
              console.log(`[Tab] Found consent button via text search`);
              await page.evaluate((btn) => btn.click(), acceptButton);
              buttonClicked = true;
            } catch (clickError) {
              console.log(
                `[Tab] Error clicking fallback button:`,
                clickError instanceof Error ? clickError.message : String(clickError)
              );
            }
          }
        }

        if (buttonClicked) {
          console.log(`[Tab] Clicked consent button, waiting for page to settle...`);
          try {
            // Wait for either navigation or the page to stabilize
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }),
              new Promise((resolve) => setTimeout(resolve, 5000)), // Fallback timeout
            ]);

            // Additional wait to ensure page is fully loaded
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Check if page is still responsive before checking content
            const newPageText = await safeEvaluate(page, () => document.body.textContent || '', '');
            if (newPageText.includes('Before you continue')) {
              console.log(`[Tab] Still on consent page, waiting longer...`);
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
          } catch (e) {
            console.log(
              `[Tab] Navigation timeout or error, continuing anyway:`,
              e instanceof Error ? e.message : String(e)
            );
            // Wait a bit longer and continue
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        } else {
          console.log(`[Tab] Could not find consent button to click.`);
        }
      } catch (e) {
        console.log(`[Tab] Error handling consent page:`, e);
      }
    }

    // Wait for the main content to load, with retry logic
    let listName: string | null = null;
    let retryCount = 0;
    const maxRetries = 3;

    while (!listName && retryCount < maxRetries) {
      try {
        await page.waitForSelector('h1', { timeout: 15000 });
        listName = await getListName(page);
        if (!listName) {
          console.log(`[Tab] Attempt ${retryCount + 1}: Could not find list name, retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (e) {
        console.log(
          `[Tab] Attempt ${retryCount + 1}: Error waiting for h1 element:`,
          e instanceof Error ? e.message : String(e)
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      retryCount++;
    }

    if (!listName) {
      console.error(
        `[Tab] Could not find list name for URL: ${url} after ${maxRetries} attempts. Skipping.`
      );
      return {
        savedPlaces: localSavedPlaces,
        permanentlyClosedPlaces: localPermanentlyClosedPlaces,
      };
    }
    console.log(`[Tab] 👀 Processing list: ${listName}`);

    // Check if page is responsive and get place count
    let numberOfPlaces = 0;
    try {
      const numberOfPlacesText = await page.$eval('.fontBodyMedium h2', (el) => el.textContent);
      numberOfPlaces = parseInt(numberOfPlacesText?.match(/\d+/g)?.[0] || '0');
      console.log(`[Tab] List claims ${numberOfPlaces} places.`);
    } catch (e) {
      console.log(
        `[Tab] Could not find place count element, assuming 0 places:`,
        e instanceof Error ? e.message : String(e)
      );
    }

    if (numberOfPlaces > 0) {
      await scrollAllPlacesInAList(page, numberOfPlaces);
      const placesFromPage = await getPlaceInfoFromPage(page);
      console.log(`[Tab] Scraped ${placesFromPage.length} places from the page.`);

      for (const { name: placeName, permanentlyClosed } of placesFromPage) {
        if (!placeName) continue; // Skip if name is empty

        console.log(`[Tab] ➕ Processing place: ${placeName}`);
        localSavedPlaces[placeName] = {
          categories: [listName],
          current: true,
          permanentlyClosed,
        };

        if (permanentlyClosed) {
          if (!localPermanentlyClosedPlaces[listName]) localPermanentlyClosedPlaces[listName] = [];
          if (!localPermanentlyClosedPlaces[listName].includes(placeName)) {
            localPermanentlyClosedPlaces[listName].push(placeName);
          }
        }
      }
    } else {
      console.log(`[Tab] Skipping scroll/scrape for ${listName} as it has 0 places.`);
    }
  } catch (error) {
    console.error(`[Tab] Error processing URL ${url}:`, error);
  } finally {
    await page.close();
  }

  return { savedPlaces: localSavedPlaces, permanentlyClosedPlaces: localPermanentlyClosedPlaces };
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

function centerOfMinimumDistance(coordinates: LatLngLiteral[]): LatLngLiteral {
  if (coordinates.length === 0) return { lat: 0, lng: 0 };
  if (coordinates.length === 1) return coordinates[0];

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

  const urlsToScrape = (argv.urls as string[])?.length ? (argv.urls as string[]) : DEFAULT_URLS;
  const mode = argv.parallel && urlsToScrape.length > 1 ? 'parallel' : 'sequential';
  console.log(`Scraping URLs (${mode}): ${urlsToScrape.join(', ')}`);

  const permanentlyClosedPlaces: Record<string, string[]> = {}; // Track closed places per list

  try {
    // --- 1. Scraping ---
    const startTime = Date.now();
    let results: Array<{
      savedPlaces: SavedPlaces;
      permanentlyClosedPlaces: Record<string, string[]>;
    }> = [];

    if (argv.parallel && urlsToScrape.length > 1) {
      console.log('\n--- Parallel Scraping Phase ---');
      console.log(
        `🚀 Processing ${urlsToScrape.length} URLs in parallel tabs (max ${argv.maxTabs} concurrent)...`
      );

      // Limit concurrent tabs to prevent overwhelming the system
      const limit = pLimit(argv.maxTabs);
      results = await Promise.all(
        urlsToScrape.map((url) => limit(() => processUrlInTabWithRetry(browser, url)))
      );
    } else {
      console.log('\n--- Sequential Scraping Phase ---');
      console.log(`Processing ${urlsToScrape.length} URLs sequentially...`);

      // Fallback to sequential processing
      for (const url of urlsToScrape) {
        const result = await processUrlInTabWithRetry(browser, url);
        results.push(result);
      }
    }

    const endTime = Date.now();
    console.log(`✅ Scraping completed in ${(endTime - startTime) / 1000}s`);

    // Merge results from all tabs
    for (const { savedPlaces: tabPlaces, permanentlyClosedPlaces: tabClosedPlaces } of results) {
      // Merge saved places
      for (const [placeName, place] of Object.entries(tabPlaces)) {
        if (!savedPlaces[placeName]) {
          console.log(`➕ Adding new place: ${placeName}`);
          savedPlaces[placeName] = { ...place, current: true };
        } else {
          console.log(`🔄 Updating existing place: ${placeName}`);
          savedPlaces[placeName].current = true;
          savedPlaces[placeName].permanentlyClosed = place.permanentlyClosed;
          // Merge categories
          for (const category of place.categories) {
            if (!savedPlaces[placeName].categories.includes(category)) {
              savedPlaces[placeName].categories.push(category);
            }
          }
        }
      }

      // Merge permanently closed places
      for (const [listName, places] of Object.entries(tabClosedPlaces)) {
        if (!permanentlyClosedPlaces[listName]) {
          permanentlyClosedPlaces[listName] = [];
        }
        for (const place of places) {
          if (!permanentlyClosedPlaces[listName].includes(place)) {
            permanentlyClosedPlaces[listName].push(place);
          }
        }
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

    // Filter places based on excludeClosed option
    const placesToInclude = Object.values(savedPlaces).filter((place) => {
      if (argv.excludeClosed && place.permanentlyClosed) {
        return false; // Exclude permanently closed places
      }
      return true; // Include all other places
    });

    console.log(
      `Including ${placesToInclude.length} places in midpoint calculation` +
        (argv.excludeClosed
          ? ` (excluding ${
              Object.values(savedPlaces).filter((p) => p.permanentlyClosed).length
            } permanently closed)`
          : '')
    );

    const coordinates = placesToInclude
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

      const minDistMidpoint = centerOfMinimumDistance(uniqueCoordinates);
      const minDistAddress = await getReverseGeocodedAddress(minDistMidpoint);

      console.log('\n--- Midpoint Results ---');
      console.log('📍 Center of Minimum Distance:', {
        ...minDistMidpoint,
        address: minDistAddress,
      });
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

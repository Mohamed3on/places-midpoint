import puppeteer, { Page } from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export type savedPlaces = Record<
  string,
  {
    current?: boolean;
    address?: string;
    latLng?: { lat: number; lng: number };
    categories: string[];
  }
>;

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

const urls: string[] = [
  'https://www.google.com/maps/@52.4646787,13.425419,14z/data=!4m3!11m2!2s1oSSrONb1Jhpnt-svN0qcbs9ZcBY!3e3',
  'https://www.google.com/maps/@52.4646751,13.425419,14z/data=!3m1!4b1!4m3!11m2!2s1vYVMJkyC8rwXV9OCHnWxOWhLyLg!3e3',
  'https://www.google.com/maps/@52.4646751,13.425419,14z/data=!4m3!11m2!2saHz41BFh8xiiItO6HLq44ecj06QKgA!3e3',
  'https://www.google.com/maps/@52.4646447,13.3636184,12z/data=!4m3!11m2!2s1b5xeEtFRiXarfIlzMnBgxNOUiC4!3e3',
  'https://goo.gl/maps/KPdcuaL5GGxzaMYp6',
  // Add more URLs here
];

export const scrollAllPlacesInAList = async (page: puppeteer.Page, numberOfPlaces: number) => {
  console.log('🚀 scrolling all places in the list');

  let currentlyDisplayedPlaces = await page.$$('.fontHeadlineSmall.rZF81c');
  let previousNumberOfPlaces = 0;
  let numberOfIterationsWithOutNewPlaces = 0;

  while (currentlyDisplayedPlaces.length < numberOfPlaces) {
    // scroll to the last element to trigger the loading of more places
    await page.evaluate((element) => {
      if (element) {
        element.scrollIntoView();
      }
    }, currentlyDisplayedPlaces[currentlyDisplayedPlaces.length - 1]);

    await new Promise((r) => setTimeout(r, 500));

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

const getPlaceInfo = async (page: Page) => {
  const names: string[] = (
    await page.$$eval('.fontHeadlineSmall.rZF81c', (names) => names.map((name) => name.textContent))
  ).filter((name): name is string => name !== null);

  return names;
};

const getListName = async (page: Page) => {
  return await page.$eval('h1', (el) => el.textContent);
};

const saveToFile = (filename: string, data: object) => {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`✅ Data saved to ${filename}`);
};

const parseArgv = () => {
  return yargs(hideBin(process.argv))
    .option('urls', {
      alias: 'u',
      type: 'array',
      description: 'List of URLs to scrape',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output JSON file path',
      default: 'places.json',
    })
    .help()
    .alias('help', 'h')
    .parseSync();
};

const argv = parseArgv();

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/opt/homebrew/bin/chromium',
    args: ['--disable-site-isolation-trials', '--lang=en-GB,en'],
    // userDataDir: path.join(__dirname, 'user_data'),
  });
  const page = await browser.newPage();
  await disableImagesAndFontRequests(page);

  const placesFilePath = path.join(__dirname, argv.output);
  const savedPlaces: savedPlaces = (await fs.pathExists(placesFilePath))
    ? await fs.readJson(placesFilePath)
    : {};

  // Set all places as not current at the beginning of the run
  for (const placeName in savedPlaces) {
    savedPlaces[placeName].current = false;
  }

  try {
    const urlsToScrape = (argv.urls as string[]) || urls;
    for (const url of urlsToScrape) {
      await page.goto(url);

      if (page.url().includes('consent')) {
        const consentButton = await page.$(
          '[aria-label="Accept all"], [aria-label="Alle akzeptieren"]'
        );
        consentButton && (await consentButton.click());
        await page.waitForNavigation();
      }

      await page.waitForSelector('h1');

      const listName = await getListName(page);
      console.log(`👀 ${listName}`);

      const numberOfPlacesText = await page.$eval('.fontBodyMedium h2', (el) => el.textContent);
      const numberOfPlaces = parseInt(numberOfPlacesText?.match(/\d+/g)?.[0] || '0');
      console.log('🚀 ~ numberOfPlaces:', numberOfPlaces);

      await scrollAllPlacesInAList(page, numberOfPlaces);
      const places = await getPlaceInfo(page);

      for (const placeName of places) {
        if (!savedPlaces[placeName]) {
          console.log(`👀 ${placeName} is new`);

          savedPlaces[placeName] = {
            categories: [listName!],
            current: true,
          };
        } else {
          savedPlaces[placeName].current = true;
          if (!savedPlaces[placeName].categories.includes(listName!)) {
            savedPlaces[placeName].categories.push(listName!);
          }
        }
      }
    }

    // Remove places that weren't seen in this run
    const placesToRemove = Object.keys(savedPlaces).filter(
      (placeName) => !savedPlaces[placeName].current
    );

    for (const placeName of placesToRemove) {
      console.log(`🗑️ Removing ${placeName} as it wasn't seen in this run`);
      delete savedPlaces[placeName];
    }

    saveToFile(argv.output, savedPlaces);
    console.log(`✅ Removed ${placesToRemove.length} places that weren't seen in this run`);
  } catch (error) {
    console.error('An error occurred:', error);
    saveToFile(argv.output, savedPlaces);
  } finally {
    await browser.close();
  }
})();

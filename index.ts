import puppeteer, { Page } from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  // Add more URLs here
];

export const scrollAllPlacesInAList = async (page: Page) => {
  console.log('🚀 scrolling all places in the list');
  await page.waitForSelector('h3');
  const numberOfPlacesText = await page.$eval('.vkU5O', (el) => el.textContent);
  const numberOfPlaces = parseInt(numberOfPlacesText?.match(/\d+/g)?.[0] || '0', 10);

  let currentlyDisplayedPlaces = await page.$$('h3');
  let previousNumberOfPlaces = 0;
  let numberOfIterationsWithOutNewPlaces = 0;
  while (
    currentlyDisplayedPlaces.length < numberOfPlaces &&
    numberOfIterationsWithOutNewPlaces < 5
  ) {
    // scroll to the last element to trigger the loading of more places
    await page.evaluate((element) => {
      if (element) {
        element.scrollIntoView();
      }
    }, currentlyDisplayedPlaces[currentlyDisplayedPlaces.length - 1]);

    await page.waitForTimeout(1300);

    previousNumberOfPlaces = currentlyDisplayedPlaces.length;

    currentlyDisplayedPlaces = await page.$$('h3');

    if (currentlyDisplayedPlaces.length === previousNumberOfPlaces) {
      numberOfIterationsWithOutNewPlaces++;
    } else {
      numberOfIterationsWithOutNewPlaces = 0;
    }
  }

  console.log(`👀 ${currentlyDisplayedPlaces.length} places displayed`);
  return currentlyDisplayedPlaces;
};

const getPlaceInfo = async (page: Page) => {
  const names: string[] = (
    await page.$$eval('.IMSio h3', (names) => names.map((name) => name.textContent))
  ).filter((name): name is string => name !== null);

  const addresses: string[] = (
    await page.$$eval('.IMSio .fKEVAc', (addresses) =>
      addresses.map((address) => address.textContent)
    )
  ).filter((address): address is string => address !== null);

  const places: Record<string, { address: string }> = {};
  for (let i = 0; i < names.length; i++) {
    places[names[i]] = {
      address: addresses[i],
    };
  }
  return places;
};

const getListName = async (page: Page) => {
  return await page.$eval('h1', (el) => el.textContent);
};

const saveToFile = (filename: string, data: object) => {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`✅ Data saved to ${filename}`);
};

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: path.join(__dirname, 'user_data'),
  });
  const page = await browser.newPage();
  await disableImagesAndFontRequests(page);

  type AllLists = Record<
    string,
    Record<string, { address: string; latLng?: { lat: number; lng: number } }>
  >;

  const partialFilePath = path.join(__dirname, 'places_partial.json');
  const allLists: AllLists = (await fs.pathExists(partialFilePath))
    ? await fs.readJson(partialFilePath)
    : {};

  try {
    for (const url of urls) {
      await page.goto(url);

      if (page.url().includes('consent')) {
        const consentButton = await page.$(
          '[aria-label="Accept all"], [aria-label="Alle akzeptieren"]'
        );
        consentButton && (await consentButton.click());
        await page.waitForNavigation();
      }

      await scrollAllPlacesInAList(page);
      const places = await getPlaceInfo(page);
      const listName = await getListName(page);
      if (listName) {
        allLists[listName] = places;
      }
    }
    saveToFile('places.json', allLists);
  } catch (error) {
    console.error('An error occurred:', error);
    saveToFile('places_partial.json', allLists);
  } finally {
    await browser.close();
  }
})();

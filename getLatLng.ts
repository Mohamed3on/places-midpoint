import { Client, GeocodeResult } from '@googlemaps/google-maps-services-js';
import fs from 'fs';
const client = new Client({});

import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.API_KEY || '';

import { LatLng } from '@googlemaps/google-maps-services-js';
import { readFromDisk } from './helpers.js';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const parseArgv = () => {
  return yargs(hideBin(process.argv))
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Input JSON file path',
      default: 'places.json',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output JSON file path (defaults to input file if not specified)',
    })
    .option('region', {
      alias: 'r',
      type: 'string',
      description: 'Region to search in',
      default: 'berlin',
    })
    .help()
    .alias('help', 'h')
    .parseSync();
};

const argv = parseArgv();

const places = readFromDisk(argv.input);

export const getLatLngAndAddress = async (
  placeName: string,
  region: string
): Promise<{ address: string; latLng: { lat: number; lng: number } } | null> => {
  try {
    const response = await client.geocode({
      params: {
        address: `${placeName} ${region}`,
        key: API_KEY,
      },
    });

    const results: GeocodeResult[] | undefined = response.data.results;

    if (results && results.length > 0) {
      console.log(`👀 ${placeName}:`, results[0].formatted_address);
      return {
        address: results[0].formatted_address,
        latLng: results[0].geometry.location,
      };
    }
  } catch (error) {
    console.error(`Error fetching lat/lng for place: ${placeName}`);
  }
  return null;
};

(async () => {
  for (let placeName in places) {
    if (places[placeName].latLng) {
      continue;
    }
    const result = await getLatLngAndAddress(placeName, argv.region);
    if (result) {
      places[placeName].address = result.address;
      places[placeName].latLng = result.latLng;
    } else {
      console.error(`No data found for ${placeName}`);
    }
  }

  const outputFile = argv.output || argv.input;
  fs.writeFileSync(outputFile, JSON.stringify(places, null, 2));
  console.log(`✅ Enriched data saved to ${outputFile}`);
})();

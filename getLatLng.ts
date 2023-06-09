import { Client, GeocodeResult } from '@googlemaps/google-maps-services-js';
import fs from 'fs';
const client = new Client({});

import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.API_KEY || '';

import { LatLng } from '@googlemaps/google-maps-services-js';
import { readFromDisk } from './helpers.js';

export const getLatLng = async (address: string): Promise<{ lat: number; lng: number } | null> => {
  try {
    const response = await client.geocode({
      params: {
        address,
        key: API_KEY,
      },
    });

    const results: GeocodeResult[] | undefined = response.data.results;

    if (results && results.length > 0) {
      return results[0].geometry.location;
    }
  } catch (error) {
    console.error(`Error fetching lat/lng for address: ${address}`, error);
  }
  return null;
};

const places = readFromDisk('places.json');

// output the length of each key in the places

// object to the console

for (let key in places) {
  if (places[key].latLng) {
    continue;
  }
  const latLng = await getLatLng(`${key} ${places[key]?.address} berlin`);
  if (latLng) {
    console.log(`👀 ${key} ${places[key]?.address} berlin`, latLng);
    places[key].latLng = latLng;
  } else {
    console.error(`no lat/lng for ${key} ${places[key]?.address}`);
  }
}

fs.writeFileSync('places_with_lat_lng.json', JSON.stringify(places, null, 2));

function convertDMSStringToLatLng(dmsString: string): LatLng | null {
  const regex = /^(\d+)°(\d+)'(\d+(?:\.\d+)?)\"([NS])\s+(\d+)°(\d+)'(\d+(?:\.\d+)?)\"([EW])$/;
  const match = dmsString.match(regex);

  if (!match) {
    return null;
  }

  const latD = parseInt(match[1], 10);
  const latM = parseInt(match[2], 10);
  const latS = parseFloat(match[3]);
  const latDir = match[4];

  const lngD = parseInt(match[5], 10);
  const lngM = parseInt(match[6], 10);
  const lngS = parseFloat(match[7]);
  const lngDir = match[8];

  const lat = (latD + latM / 60 + latS / 3600) * (latDir === 'N' ? 1 : -1);
  const lng = (lngD + lngM / 60 + lngS / 3600) * (lngDir === 'E' ? 1 : -1);

  return { lat, lng };
}

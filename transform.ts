import { readFromDisk } from './helpers.js';

import fs from 'fs';

interface LatLng {
  lat: number;
  lng: number;
}

interface Place {
  address: string;
  latLng: LatLng;
  categories?: string[];
}

type PlacesByCategory = {
  [category: string]: {
    [placeName: string]: Place;
  };
};

type PlacesOutput = {
  [placeName: string]: Place;
};

const input: PlacesByCategory = readFromDisk('new.json');
const output: PlacesOutput = {};

for (const place in input) {
  const latlng = input[place].latLng;

  if (!latlng) console.log(place);
}
// fs.writeFileSync('new.json', JSON.stringify(output, null, 2));

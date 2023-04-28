import { Client, LatLngLiteral } from '@googlemaps/google-maps-services-js';
import fs from 'fs';
const client = new Client({});
const EARTH_RADIUS = 6371e3; // Earth's radius in meters

import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.API_KEY || '';
// output the length of each key in the places

// object to the console

// function to calculate geographic midpoint
function geographicMidpoint(coordinates: LatLngLiteral[]) {
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  for (const coord of coordinates) {
    const latRad = (coord.lat * Math.PI) / 180;
    const lngRad = (coord.lng * Math.PI) / 180;

    sumX += Math.cos(latRad) * Math.cos(lngRad);
    sumY += Math.cos(latRad) * Math.sin(lngRad);
    sumZ += Math.sin(latRad);
  }

  const count = coordinates.length;
  const avgX = sumX / count;
  const avgY = sumY / count;
  const avgZ = sumZ / count;

  const lon = Math.atan2(avgY, avgX);
  const hyp = Math.sqrt(avgX * avgX + avgY * avgY);
  const lat = Math.atan2(avgZ, hyp);

  return {
    lat: (lat * 180) / Math.PI,
    lng: (lon * 180) / Math.PI,
  };
}

// function to calculate center of minimum distance
async function centerOfMinimumDistance(coordinates: LatLngLiteral[]) {
  const initialMidpoint = geographicMidpoint(coordinates);
  let minDistMidpoint = { ...initialMidpoint };
  let minDist = Infinity;

  const getNextPoints = (point: LatLngLiteral, testDistance: number) => {
    const deltas = [
      { lat: testDistance, lng: 0 },
      { lat: testDistance / Math.sqrt(2), lng: testDistance / Math.sqrt(2) },
      { lat: 0, lng: testDistance },
      { lat: -testDistance / Math.sqrt(2), lng: testDistance / Math.sqrt(2) },
      { lat: -testDistance, lng: 0 },
      { lat: -testDistance / Math.sqrt(2), lng: -testDistance / Math.sqrt(2) },
      { lat: 0, lng: -testDistance },
      { lat: testDistance / Math.sqrt(2), lng: -testDistance / Math.sqrt(2) },
    ];
    return deltas.map((delta) => ({
      lat: point.lat + delta.lat,
      lng: point.lng + delta.lng,
    }));
  };

  const getTotalDist = (point: LatLngLiteral, points: LatLngLiteral[]) =>
    points.reduce((totalDist, p) => totalDist + haversineDistance(point, p), 0);

  let testDistance = Math.PI / 2;
  while (testDistance > 1e-8) {
    const testPoints = getNextPoints(minDistMidpoint, testDistance);
    let updated = false;

    for (const testPoint of testPoints) {
      const dist = getTotalDist(testPoint, coordinates);
      if (dist < minDist) {
        minDist = dist;
        minDistMidpoint = testPoint;
        updated = true;
      }
    }

    if (!updated) {
      testDistance /= 2;
    }
  }

  return minDistMidpoint;
}

function haversineDistance(p1: LatLngLiteral, p2: LatLngLiteral) {
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((p1.lat * Math.PI) / 180) *
      Math.cos((p2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS * c;
}

interface CategoryMidpoint {
  lat: number;
  lng: number;
  address: string;
}

async function getAddress(latLng: LatLngLiteral): Promise<string> {
  const response = await client.reverseGeocode({
    params: {
      latlng: latLng,
      key: API_KEY,
    },
  });

  const result = response.data.results[0];
  const address = result.formatted_address;

  return address;
}

async function getMidpointsAndAddresses(places: any) {
  const globalCoordinates = [];

  for (const name in places) {
    const place = places[name];

    if (!place.latLng) continue;
    globalCoordinates.push(place.latLng);
  }

  const globalGeoMidpoint = geographicMidpoint(globalCoordinates);
  const globalMinDistMidpoint = await centerOfMinimumDistance(globalCoordinates);

  return {
    geoMidpoint: {
      ...globalGeoMidpoint,
      address: await getAddress(globalGeoMidpoint),
    },

    minDistMidpoint: {
      ...globalMinDistMidpoint,
      address: await getAddress(globalMinDistMidpoint),
    },
  };
}

(async () => {
  const readFromDisk = (path: string) => {
    const data = fs.readFileSync(path, { encoding: 'utf8' });
    return JSON.parse(data);
  };

  const places = readFromDisk('places.json');

  const midpoints = await getMidpointsAndAddresses(places);
  console.log(midpoints);
})();

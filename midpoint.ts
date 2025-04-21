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
      description: 'Output JSON file path',
      default: 'midpoints.json',
    })
    .help()
    .alias('help', 'h')
    .parseSync();
};

// --- helpers ----------------------------------------------------
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

type Vec3 = { x: number; y: number; z: number };

const llToVec = ({ lat, lng }: LatLngLiteral): Vec3 => {
  const φ = (lat * Math.PI) / 180;
  const λ = (lng * Math.PI) / 180;
  return { x: Math.cos(φ) * Math.cos(λ), y: Math.cos(φ) * Math.sin(λ), z: Math.sin(φ) };
};

const vecToLl = ({ x, y, z }: Vec3): LatLngLiteral => {
  const hyp = Math.hypot(x, y);
  return {
    lat: (Math.atan2(z, hyp) * 180) / Math.PI,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
  };
};

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const normalise = (v: Vec3): Vec3 => scale(v, 1 / norm(v));

// --- geometric median on the sphere -----------------------------
export const geometricMedianOnSphere = (
  coords: LatLngLiteral[],
  { tol = 1e-10, maxIter = 500 } = {}
): LatLngLiteral => {
  if (coords.length === 0) return { lat: 0, lng: 0 };
  if (coords.length === 1) return coords[0];

  // Start from the geographic midpoint (average unit vectors)
  let p = normalise(coords.map(llToVec).reduce((sum, v) => add(sum, v), { x: 0, y: 0, z: 0 }));

  for (let k = 0; k < maxIter; k++) {
    let num = { x: 0, y: 0, z: 0 };
    let denom = 0;

    for (const pt of coords) {
      const q = llToVec(pt);
      const ang = Math.acos(clamp(dot(p, q), -1, 1)); // great‑circle distance / R
      const w = 1 / Math.max(ang, 1e-15); // Weiszfeld weight
      num = add(num, scale(q, w));
      denom += w;
    }

    const pNext = normalise(scale(num, 1 / denom));
    if (Math.acos(clamp(dot(p, pNext), -1, 1)) < tol) break;
    p = pNext;
  }

  return vecToLl(p);
};

const argv = parseArgv();

(async () => {
  const readFromDisk = (path: string) => {
    const data = fs.readFileSync(path, { encoding: 'utf8' });
    return JSON.parse(data);
  };

  const places = readFromDisk(argv.input);

  const midpoints = await getMidpointsAndAddresses(places);
  console.log(midpoints);

  fs.writeFileSync(argv.output, JSON.stringify(midpoints, null, 2));
})();

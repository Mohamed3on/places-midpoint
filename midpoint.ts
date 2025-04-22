import { LatLngLiteral } from '@googlemaps/google-maps-services-js';

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

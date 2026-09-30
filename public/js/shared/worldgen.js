// Procedural worlds: an elevation field shaped by the chosen start, a sea level
// picked by quantile so every seed gets the intended amount of land, biomes from
// latitude and moisture, and rivers that run downhill to the sea.

import { Grid, SQRT3 } from './hex.js';
import { Rng, fbm, hashUnit } from './rng.js';
import { T, isWater, isLand } from './rules.js';

const LAND_SHARE = { continents: 0.4, pangaea: 0.46, archipelago: 0.3 };

export function generateWorld({ W, H, seed, start }) {
  const grid = new Grid(W, H);
  const N = grid.N;
  const terrain = new Array(N).fill(T.DEEP);
  const river = new Array(N).fill(-1);

  if (start === 'sea') {
    // A blank canvas: shallow water everywhere but a deep rim along the edges.
    for (let i = 0; i < N; i++) {
      const edge = Math.min(grid.col(i), W - 1 - grid.col(i), grid.row(i), H - 1 - grid.row(i));
      terrain[i] = edge <= 1 ? T.DEEP : T.SEA;
    }
    return { terrain, river };
  }

  const rng = new Rng(seed ^ 0x2545f491);
  const [spanX, spanY] = [SQRT3 * W, 1.5 * H];
  const elev = new Float64Array(N);
  const ridge = new Float64Array(N);
  const moist = new Float64Array(N);
  const noiseSeed = (seed >>> 0) % 1000003;
  const archipelago = start === 'archipelago';
  const freq = (archipelago ? 7.5 : 4.2) / spanX;

  // Continent centres, in [-1, 1] map coordinates.
  const centres = [];
  if (start === 'continents') {
    const count = rng.chance(0.5) ? 2 : 3;
    const spread = count === 2 ? 0.98 : 1.3;
    for (let k = 0; k < count; k++) {
      const x = -spread / 2 + (spread * k) / (count - 1) + rng.range(-0.06, 0.06);
      centres.push([x, rng.range(-0.32, 0.32), rng.range(0.3, 0.4)]);
    }
  } else if (start === 'pangaea') {
    centres.push([rng.range(-0.12, 0.12), rng.range(-0.1, 0.1), 0.78]);
  }

  for (let i = 0; i < N; i++) {
    const col = grid.col(i);
    const row = grid.row(i);
    const x = SQRT3 * (col + 0.5 * (row & 1));
    const y = 1.5 * row;
    const nx = (x / spanX) * 2 - 1;
    const ny = (y / spanY) * 2 - 1;
    let shape = 0;
    if (centres.length) {
      shape = -1;
      for (const [cx, cy, r] of centres) {
        const d = Math.hypot((nx - cx) / r, ((ny - cy) / r) * 0.9);
        shape = Math.max(shape, 1 - d);
      }
    }
    const n = fbm(x * freq, y * freq, noiseSeed, 5);
    const edge = Math.min(col, W - 1 - col, row, H - 1 - row);
    const edgeFade = edge < 3 ? (3 - edge) * 0.22 : 0;
    elev[i] = (archipelago ? n * 1.2 : n * 0.95 + shape * 0.55) - edgeFade;
    const rn = fbm(x * freq * 1.7 + 31.7, y * freq * 1.7 - 12.3, noiseSeed + 77, 3);
    ridge[i] = 1 - Math.abs(rn * 2 - 1);
    moist[i] = fbm(x * freq * 1.3 - 51.1, y * freq * 1.3 + 7.9, noiseSeed + 191, 4);
  }

  // Sea level at the quantile that leaves the intended share of land.
  const sorted = Float64Array.from(elev).sort();
  const sea = sorted[Math.floor(N * (1 - (LAND_SHARE[start] ?? 0.4)))];
  const land = [];
  for (let i = 0; i < N; i++) if (elev[i] > sea) land.push(i);

  // Relief: mountains and hills are the land tiles highest on a blend of height
  // and ridge noise, so they form chains rather than round blobs.
  const top = Math.max(...land.map((i) => elev[i]), sea + 1e-6);
  const height = (i) => (elev[i] - sea) / (top - sea);
  const relief = land.map((i) => [i, height(i) * 0.55 + ridge[i] * 0.45]).sort((a, b) => b[1] - a[1]);
  const mountains = Math.round(land.length * 0.08);
  const hills = Math.round(land.length * 0.14);
  const reliefOf = new Map();
  relief.forEach(([i], rank) => reliefOf.set(i, rank < mountains ? T.MOUNTAIN : rank < mountains + hills ? T.HILLS : 0));

  // Moisture as a rank among land tiles, so thresholds mean shares, not raw noise.
  const wetRank = new Map();
  [...land].sort((a, b) => moist[a] - moist[b]).forEach((i, rank) => wetRank.set(i, rank / Math.max(1, land.length - 1)));

  for (const i of land) {
    const relief = reliefOf.get(i);
    if (relief) {
      terrain[i] = relief;
      continue;
    }
    const lat = Math.abs(grid.row(i) / (H - 1) - 0.5) * 2;
    const temp = 1 - lat * 1.12 - height(i) * 0.2 + (hashUnit(i, seed, 3) - 0.5) * 0.12;
    const wet = wetRank.get(i);
    if (temp < 0.2) terrain[i] = T.TUNDRA;
    else if (wet < 0.2 && temp > 0.42) terrain[i] = T.DESERT;
    else if (wet > 0.8 && temp > 0.6) terrain[i] = T.JUNGLE;
    else if (wet > 0.85 && height(i) < 0.3) terrain[i] = T.SWAMP;
    else if (wet > 0.5) terrain[i] = T.FOREST;
    else terrain[i] = T.GRASS;
  }

  // Shallows hug every coast; open water further out is deep.
  for (let i = 0; i < N; i++) {
    if (isLand(terrain[i])) continue;
    let near = false;
    for (const n of grid.neighbors(i)) if (isLand(terrain[n])) near = true;
    if (!near && hashUnit(i, seed, 5) < 0.35) {
      for (const n of grid.within(i, 2)) if (isLand(terrain[n])) near = true;
    }
    terrain[i] = near ? T.SEA : T.DEEP;
  }

  carveRivers(grid, terrain, river, elev, rng, land.length);
  return { terrain, river };
}

function carveRivers(grid, terrain, river, elev, rng, landCount) {
  const sources = [];
  for (let i = 0; i < grid.N; i++) {
    const t = terrain[i];
    if (t !== T.MOUNTAIN && t !== T.HILLS) continue;
    if (grid.neighbors(i).some((n) => isWater(terrain[n]))) continue;
    sources.push(i);
  }
  rng.shuffle(sources);
  const wanted = Math.max(2, Math.round(landCount / 85));
  let made = 0;
  for (const src of sources) {
    if (made >= wanted) break;
    if (river[src] !== -1) continue;
    if (grid.within(src, 2).some((n) => river[n] !== -1)) continue;
    const path = [];
    const seen = new Set([src]);
    let cur = src;
    let end = -1;
    for (let step = 0; step < 40; step++) {
      const next = grid.neighbors(cur);
      const water = next.find((n) => isWater(terrain[n]));
      if (water !== undefined) {
        path.push([cur, grid.dirTo(cur, water)]);
        end = water;
        break;
      }
      const joined = next.find((n) => river[n] !== -1 && !seen.has(n));
      if (joined !== undefined && path.length >= 2) {
        path.push([cur, grid.dirTo(cur, joined)]);
        end = joined;
        break;
      }
      let best = -1;
      for (const n of next) if (!seen.has(n) && (best < 0 || elev[n] < elev[best])) best = n;
      if (best < 0) break;
      path.push([cur, grid.dirTo(cur, best)]);
      seen.add(best);
      cur = best;
    }
    if (end < 0 || path.length < 3) continue;
    for (const [i, d] of path) river[i] = d;
    made++;
  }
}

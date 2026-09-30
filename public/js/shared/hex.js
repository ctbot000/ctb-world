// Hex grid geometry. Pointy-top hexes in an "odd-r" offset layout: odd rows
// are shifted right by half a hex, so a W x H map is a tidy rectangle.
// Tiles are addressed by a single index, i = row * W + col.
//
// Directions, clockwise from east as seen on screen (y grows downward):
//   0 east, 1 north-east, 2 north-west, 3 west, 4 south-west, 5 south-east.
// Pure functions only: this module runs unchanged in the browser and in Node.

export const SQRT3 = Math.sqrt(3);

// (dcol, drow) per direction, for even rows and for odd rows.
const OFFSETS = [
  [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]],
  [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]],
];

// Unit corner offsets of a pointy-top hex, starting upper right, clockwise.
export const CORNERS = Array.from({ length: 6 }, (_, k) => {
  const a = (Math.PI / 180) * (60 * k - 30);
  return [Math.cos(a), Math.sin(a)];
});

// The edge shared with the neighbour in direction d runs from corner
// EDGE[d][0] to corner EDGE[d][1].
export const EDGE = Array.from({ length: 6 }, (_, d) => {
  const e = (6 - d) % 6;
  return [e, (e + 1) % 6];
});

export class Grid {
  constructor(W, H) {
    this.W = W;
    this.H = H;
    this.N = W * H;
    // Neighbour table: nbr[i * 6 + d] is the index in direction d, or -1.
    this.nbr = new Int32Array(this.N * 6).fill(-1);
    for (let i = 0; i < this.N; i++) {
      const col = i % W;
      const row = (i / W) | 0;
      const table = OFFSETS[row & 1];
      for (let d = 0; d < 6; d++) {
        const c = col + table[d][0];
        const r = row + table[d][1];
        if (c >= 0 && c < W && r >= 0 && r < H) this.nbr[i * 6 + d] = r * W + c;
      }
    }
    this._within = new Map();
  }

  col(i) {
    return i % this.W;
  }

  row(i) {
    return (i / this.W) | 0;
  }

  index(col, row) {
    return col >= 0 && col < this.W && row >= 0 && row < this.H ? row * this.W + col : -1;
  }

  valid(i) {
    return Number.isInteger(i) && i >= 0 && i < this.N;
  }

  neighbor(i, d) {
    return this.nbr[i * 6 + d];
  }

  // Valid neighbour indices of i.
  neighbors(i) {
    const out = [];
    for (let d = 0; d < 6; d++) {
      const n = this.nbr[i * 6 + d];
      if (n >= 0) out.push(n);
    }
    return out;
  }

  // Direction from a to an adjacent b, or -1 when they are not neighbours.
  dirTo(a, b) {
    for (let d = 0; d < 6; d++) if (this.nbr[a * 6 + d] === b) return d;
    return -1;
  }

  // Axial coordinates (q, r).
  axial(i) {
    const col = i % this.W;
    const row = (i / this.W) | 0;
    return [col - ((row - (row & 1)) >> 1), row];
  }

  fromAxial(q, r) {
    return this.index(q + ((r - (r & 1)) >> 1), r);
  }

  distance(a, b) {
    const [q1, r1] = this.axial(a);
    const [q2, r2] = this.axial(b);
    const dq = q1 - q2;
    const dr = r1 - r2;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  // Every tile within `radius` steps of i, i itself first, nearer rings first.
  within(i, radius) {
    if (radius <= 0) return [i];
    const key = i * 8 + radius;
    const cached = this._within.get(key);
    if (cached) return cached;
    const [q0, r0] = this.axial(i);
    const out = [];
    for (let dist = 0; dist <= radius; dist++) {
      for (let dq = -dist; dq <= dist; dq++) {
        for (let dr = Math.max(-dist, -dq - dist); dr <= Math.min(dist, -dq + dist); dr++) {
          if ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 !== dist) continue;
          const n = this.fromAxial(q0 + dq, r0 + dr);
          if (n >= 0) out.push(n);
        }
      }
    }
    if (this._within.size < 20000) this._within.set(key, out);
    return out;
  }

  // Tiles on a straight line from a to b, both included, each adjacent to the next.
  line(a, b) {
    const n = this.distance(a, b);
    if (n === 0) return [a];
    const [q1, r1] = this.axial(a);
    const [q2, r2] = this.axial(b);
    const out = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      // Nudge off exact ties so the rounding is consistent.
      const q = q1 + (q2 - q1) * t + 1e-6;
      const r = r1 + (r2 - r1) * t + 2e-6;
      const idx = this.fromAxial(...roundAxial(q, r));
      if (idx >= 0 && out[out.length - 1] !== idx) out.push(idx);
    }
    return out;
  }

  // Pixel centre of tile i for hexes of circumradius `size`; tile 0 sits at the origin.
  center(i, size) {
    const col = i % this.W;
    const row = (i / this.W) | 0;
    return [size * SQRT3 * (col + 0.5 * (row & 1)), size * 1.5 * row];
  }

  // The tile under pixel (x, y), or -1 when it falls outside the map.
  fromPixel(x, y, size) {
    const q = ((SQRT3 / 3) * x - y / 3) / size;
    const r = ((2 / 3) * y) / size;
    return this.fromAxial(...roundAxial(q, r));
  }

  // Size in pixels of the whole map's bounding box for hexes of `size`.
  extent(size) {
    return [size * SQRT3 * (this.W + 0.5), size * (1.5 * (this.H - 1) + 2)];
  }
}

export function roundAxial(q, r) {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

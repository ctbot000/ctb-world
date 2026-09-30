// Canvas 2D map renderer. Draws on demand (never in a free-running loop): the
// world is repainted when the replica or the camera changes, and only while
// short effects such as pings are running does it ask for successive frames.
//
// Shapes are batched into one path per colour, so a frame is a few dozen fill
// calls however many tiles are visible, and decorations are skipped when the
// hexes are too small to show them.

import { shadeColor } from './shared/game.js';
import { CORNERS, EDGE, SQRT3 } from './shared/hex.js';
import { hash3, hashUnit } from './shared/rng.js';
import * as R from './shared/rules.js';

const { T } = R;

export const HEX = 20; // hex circumradius in world units
export const SERIF = 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif';
export const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const SHADES = R.TERRAIN.map((t) => [shadeColor(t.color, -0.045), t.color, shadeColor(t.color, 0.05)]);
const RIVER = '#3f8ad0';
const COAST = 'rgba(28, 36, 24, 0.55)';
const MAX_ZOOM = 4.5;

const MIDS = EDGE.map(([a, b]) => [(CORNERS[a][0] + CORNERS[b][0]) / 2, (CORNERS[a][1] + CORNERS[b][1]) / 2]);

function hexPath(path, x, y, r) {
  path.moveTo(x + CORNERS[0][0] * r, y + CORNERS[0][1] * r);
  for (let k = 1; k < 6; k++) path.lineTo(x + CORNERS[k][0] * r, y + CORNERS[k][1] * r);
  path.closePath();
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const safe = (v) => (Number.isFinite(v) && v > 0 ? v : 0.01);

export class Renderer {
  // `source` is the Store, or anything shaped like it: { state, grid, at, cursors }.
  constructor(canvas, source, { minimap = null, interactive = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.source = source;
    this.interactive = interactive;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.view = { w: 0, h: 0, dpr: 1 };
    this.minZoom = 0.2;
    this.fitted = false;
    this.pending = 0;
    this.overlay = { hover: -1, brush: [], brushOk: true, selected: -1, tool: 'inspect', path: [] };
    this.pings = [];
    this.fronts = [];
    this.frontsKey = '';
    this.slot = new Int32Array(0);
    this.minimap = minimap ? new Minimap(minimap, this) : null;
    this.onCamera = null;
  }

  // ------------------------------------------------ camera

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // A collapsed or hidden surface measures 0: keep a floor rather than scale from nothing.
    const w = Math.max(50, Math.round(rect.width));
    const h = Math.max(50, Math.round(rect.height));
    if (w === this.view.w && h === this.view.h && dpr === this.view.dpr) return;
    this.view = { w, h, dpr };
    // Assigning the size clears the bitmap even when unchanged, so always repaint after.
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (!this.fitted) this.fit();
    else this.clampCamera();
    this.draw();
    this.minimap?.resize();
  }

  bounds() {
    const grid = this.source.grid;
    const [w, h] = grid.extent(HEX);
    return { x0: (-SQRT3 / 2) * HEX, y0: -HEX, w, h };
  }

  fit() {
    const grid = this.source.grid;
    if (!grid || !this.view.w) return;
    const b = this.bounds();
    this.cam.x = b.x0 + b.w / 2;
    this.cam.y = b.y0 + b.h / 2;
    const zoom = Math.min(this.view.w / (b.w + HEX * 1.5), this.view.h / (b.h + HEX * 1.5));
    this.cam.zoom = zoom;
    this.minZoom = zoom * 0.7;
    this.fitted = true;
    this.cameraChanged();
  }

  // Fill the view with the map (no margins), for backgrounds.
  cover() {
    const grid = this.source.grid;
    if (!grid || !this.view.w) return;
    const b = this.bounds();
    this.cam.x = b.x0 + b.w / 2;
    this.cam.y = b.y0 + b.h / 2;
    this.cam.zoom = Math.max(this.view.w / b.w, this.view.h / b.h) * 1.04;
    this.minZoom = this.cam.zoom;
    this.fitted = true;
  }

  clampCamera() {
    if (!this.source.grid) return;
    const b = this.bounds();
    this.cam.zoom = clamp(this.cam.zoom, this.minZoom, MAX_ZOOM);
    const mx = Math.max(0, b.w / 2 - this.view.w / (2 * this.cam.zoom) + HEX * 2);
    const my = Math.max(0, b.h / 2 - this.view.h / (2 * this.cam.zoom) + HEX * 2);
    const cx = b.x0 + b.w / 2;
    const cy = b.y0 + b.h / 2;
    this.cam.x = clamp(this.cam.x, cx - mx, cx + mx);
    this.cam.y = clamp(this.cam.y, cy - my, cy + my);
  }

  panBy(dx, dy) {
    this.cam.x -= dx / this.cam.zoom;
    this.cam.y -= dy / this.cam.zoom;
    this.clampCamera();
    this.cameraChanged();
  }

  zoomAt(sx, sy, factor) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.cam.zoom = clamp(this.cam.zoom * factor, this.minZoom, MAX_ZOOM);
    this.cam.x = wx - (sx - this.view.w / 2) / this.cam.zoom;
    this.cam.y = wy - (sy - this.view.h / 2) / this.cam.zoom;
    this.clampCamera();
    this.cameraChanged();
  }

  centerOn(i, zoom = null) {
    const grid = this.source.grid;
    if (!grid || i < 0) return;
    const [x, y] = grid.center(i, HEX);
    this.cam.x = x;
    this.cam.y = y;
    if (zoom) this.cam.zoom = clamp(zoom, this.minZoom, MAX_ZOOM);
    this.clampCamera();
    this.cameraChanged();
  }

  cameraChanged() {
    this.requestDraw();
    this.minimap?.requestDraw();
    this.onCamera?.();
  }

  toScreen(wx, wy) {
    return [(wx - this.cam.x) * this.cam.zoom + this.view.w / 2, (wy - this.cam.y) * this.cam.zoom + this.view.h / 2];
  }

  toWorld(sx, sy) {
    return [(sx - this.view.w / 2) / this.cam.zoom + this.cam.x, (sy - this.view.h / 2) / this.cam.zoom + this.cam.y];
  }

  tileAt(sx, sy) {
    const grid = this.source.grid;
    if (!grid) return -1;
    const [wx, wy] = this.toWorld(sx, sy);
    return grid.fromPixel(wx, wy, HEX);
  }

  tileToScreen(i) {
    const [x, y] = this.source.grid.center(i, HEX);
    return this.toScreen(x, y);
  }

  // ------------------------------------------------ scheduling

  requestDraw() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.draw();
    });
  }

  ping(i, color = '#f0cd7c') {
    if (i == null || i < 0) return;
    this.pings.push({ i, color, at: performance.now() });
    this.requestDraw();
  }

  draw() {
    const { ctx, view } = this;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const now = performance.now();
    this.pings = this.pings.filter((p) => now - p.at < 1600);
    this.drawWorld(ctx, this.cam, view, { overlays: this.interactive, now });
    if (this.pings.length) this.requestDraw();
  }

  // ------------------------------------------------ drawing

  drawWorld(ctx, cam, view, { overlays = true, now = performance.now(), background = '#0b101a' } = {}) {
    const s = this.source.state;
    const grid = this.source.grid;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, view.w, view.h);
    if (!s || !grid) return;
    const r = HEX * cam.zoom;
    const N = grid.N;
    if (this.slot.length !== N) this.slot = new Int32Array(N);
    this.slot.fill(-1);

    // Visible tiles and their screen centres.
    const [wx0, wy0] = [(0 - view.w / 2) / cam.zoom + cam.x, (0 - view.h / 2) / cam.zoom + cam.y];
    const [wx1, wy1] = [(view.w - view.w / 2) / cam.zoom + cam.x, (view.h - view.h / 2) / cam.zoom + cam.y];
    const row0 = Math.max(0, Math.floor((wy0 - HEX) / (1.5 * HEX)));
    const row1 = Math.min(s.H - 1, Math.ceil((wy1 + HEX) / (1.5 * HEX)));
    const col0 = Math.max(0, Math.floor(wx0 / (SQRT3 * HEX)) - 1);
    const col1 = Math.min(s.W - 1, Math.ceil(wx1 / (SQRT3 * HEX)) + 1);
    const vis = [];
    const xs = [];
    const ys = [];
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const i = row * s.W + col;
        this.slot[i] = vis.length;
        vis.push(i);
        xs.push((SQRT3 * HEX * (col + 0.5 * (row & 1)) - cam.x) * cam.zoom + view.w / 2);
        ys.push((1.5 * HEX * row - cam.y) * cam.zoom + view.h / 2);
      }
    }
    const X = (k) => xs[k];
    const Y = (k) => ys[k];

    // Terrain fills, one path per terrain shade. Slightly oversized hexes hide
    // the anti-aliased seams between neighbours of different colours.
    const buckets = new Map();
    for (let k = 0; k < vis.length; k++) {
      const i = vis[k];
      const key = s.terrain[i] * 3 + (hash3(i, 17) % 3);
      let path = buckets.get(key);
      if (!path) buckets.set(key, (path = new Path2D()));
      hexPath(path, X(k), Y(k), r + 0.6);
    }
    for (const [key, path] of buckets) {
      ctx.fillStyle = SHADES[Math.floor(key / 3)][key % 3];
      ctx.fill(path);
    }

    const detail = r >= 7;
    if (detail) this.drawDecor(ctx, s, vis, X, Y, r);

    // Coastlines.
    const coast = new Path2D();
    for (let k = 0; k < vis.length; k++) {
      const i = vis[k];
      if (!R.isLand(s.terrain[i])) continue;
      for (let d = 0; d < 6; d++) {
        const n = grid.neighbor(i, d);
        if (n >= 0 && R.isLand(s.terrain[n])) continue;
        const [a, b] = EDGE[d];
        coast.moveTo(X(k) + CORNERS[a][0] * r, Y(k) + CORNERS[a][1] * r);
        coast.lineTo(X(k) + CORNERS[b][0] * r, Y(k) + CORNERS[b][1] * r);
      }
    }
    ctx.strokeStyle = COAST;
    ctx.lineWidth = Math.max(1, r * 0.075);
    ctx.lineCap = 'round';
    ctx.stroke(coast);

    this.drawRivers(ctx, s, grid, vis, X, Y, r);
    if (r >= 20) this.drawGridLines(ctx, vis, X, Y, r);
    this.drawTerritory(ctx, s, grid, vis, X, Y, r);
    if (detail) this.drawRuins(ctx, s, X, Y, r);
    // Text is placed greedily, most important first, and anything that would
    // overlap text already placed is shifted or left out.
    this.drawFronts(ctx, s, grid, cam, view, r);
    const placed = [];
    this.drawLabels(ctx, s, X, Y, r, placed);
    this.drawSettlements(ctx, s, X, Y, r, placed);
    if (overlays) this.drawOverlays(ctx, s, grid, cam, view, r, now);
  }

  // Position of tile i on screen given the current frame's slots; null if off screen.
  slotOf(i) {
    const k = this.slot[i];
    return k >= 0 ? k : -1;
  }

  drawDecor(ctx, s, vis, X, Y, r) {
    const pines = new Path2D();
    const canopy = new Path2D();
    const peaks = new Path2D();
    const shade = new Path2D();
    const snow = new Path2D();
    const volcano = new Path2D();
    const lava = new Path2D();
    const hills = new Path2D();
    const dunes = new Path2D();
    const reeds = new Path2D();
    const frost = new Path2D();
    const cracks = new Path2D();
    const waves = new Path2D();
    const tufts = new Path2D();
    const fine = r >= 12;
    for (let k = 0; k < vis.length; k++) {
      const i = vis[k];
      const t = s.terrain[i];
      const x = X(k);
      const y = Y(k);
      const j = (n) => hashUnit(i, n, 91) - 0.5;
      switch (t) {
        case T.FOREST: {
          for (let n = 0; n < 3; n++) {
            const px = x + (n - 1) * r * 0.36 + j(n) * r * 0.16;
            const py = y + (n === 1 ? -r * 0.22 : r * 0.12) + j(n + 3) * r * 0.12;
            pines.moveTo(px, py - r * 0.3);
            pines.lineTo(px + r * 0.17, py + r * 0.14);
            pines.lineTo(px - r * 0.17, py + r * 0.14);
            pines.closePath();
          }
          break;
        }
        case T.JUNGLE: {
          for (let n = 0; n < 4; n++) {
            const px = x + ((n % 2) - 0.5) * r * 0.5 + j(n) * r * 0.14;
            const py = y + (Math.floor(n / 2) - 0.5) * r * 0.42 + j(n + 4) * r * 0.12;
            canopy.moveTo(px + r * 0.17, py);
            canopy.arc(px, py, safe(r * 0.17), 0, Math.PI * 2);
          }
          break;
        }
        case T.MOUNTAIN: {
          const w = r * 0.62;
          const hgt = r * 0.72;
          const bx = x + j(1) * r * 0.1;
          const by = y + r * 0.34;
          // A smaller peak behind, then the main one.
          for (const [ox, sc] of [
            [-r * 0.32, 0.7],
            [r * 0.08, 1],
          ]) {
            const px = bx + ox;
            const top = by - hgt * sc;
            peaks.moveTo(px - w * sc, by);
            peaks.lineTo(px, top);
            peaks.lineTo(px + w * sc, by);
            peaks.closePath();
            shade.moveTo(px, top);
            shade.lineTo(px + w * sc, by);
            shade.lineTo(px + w * sc * 0.2, by);
            shade.closePath();
            snow.moveTo(px, top);
            snow.lineTo(px + w * sc * 0.3, top + hgt * sc * 0.3);
            snow.lineTo(px - w * sc * 0.3, top + hgt * sc * 0.3);
            snow.closePath();
          }
          break;
        }
        case T.VOLCANO: {
          const w = r * 0.62;
          const by = y + r * 0.34;
          volcano.moveTo(x - w, by);
          volcano.lineTo(x - r * 0.16, y - r * 0.36);
          volcano.lineTo(x + r * 0.16, y - r * 0.36);
          volcano.lineTo(x + w, by);
          volcano.closePath();
          lava.moveTo(x - r * 0.16, y - r * 0.36);
          lava.lineTo(x + r * 0.16, y - r * 0.36);
          lava.lineTo(x + r * 0.05, y - r * 0.08);
          lava.lineTo(x - r * 0.08, y - r * 0.12);
          lava.closePath();
          break;
        }
        case T.HILLS: {
          for (const [ox, oy, sc] of [
            [-0.26, 0.12, 1],
            [0.24, -0.1, 0.8],
          ]) {
            const px = x + ox * r;
            const py = y + oy * r + r * 0.12;
            hills.moveTo(px - r * 0.28 * sc, py);
            hills.quadraticCurveTo(px, py - r * 0.36 * sc, px + r * 0.28 * sc, py);
          }
          break;
        }
        case T.DESERT: {
          for (const [ox, oy] of [
            [-0.22, -0.12],
            [0.2, 0.2],
          ]) {
            const px = x + ox * r + j(ox * 10) * r * 0.1;
            const py = y + oy * r;
            dunes.moveTo(px - r * 0.22, py);
            dunes.quadraticCurveTo(px, py - r * 0.16, px + r * 0.22, py);
          }
          break;
        }
        case T.SWAMP: {
          for (let n = 0; n < 3; n++) {
            const px = x + (n - 1) * r * 0.3 + j(n) * r * 0.1;
            const py = y + (n % 2 ? -r * 0.15 : r * 0.18);
            reeds.moveTo(px - r * 0.14, py);
            reeds.lineTo(px + r * 0.14, py);
            if (fine) {
              reeds.moveTo(px, py);
              reeds.lineTo(px + r * 0.02, py - r * 0.16);
            }
          }
          break;
        }
        case T.TUNDRA: {
          if (!fine) break;
          for (let n = 0; n < 3; n++) {
            const px = x + (n - 1) * r * 0.32 + j(n) * r * 0.14;
            const py = y + j(n + 5) * r * 0.5;
            frost.moveTo(px - r * 0.07, py);
            frost.lineTo(px + r * 0.07, py);
            frost.moveTo(px, py - r * 0.07);
            frost.lineTo(px, py + r * 0.07);
          }
          break;
        }
        case T.WASTE: {
          cracks.moveTo(x - r * 0.35, y - r * 0.05);
          cracks.lineTo(x - r * 0.1, y + r * 0.08);
          cracks.lineTo(x + r * 0.05, y - r * 0.12);
          cracks.lineTo(x + r * 0.32, y + r * 0.06);
          break;
        }
        case T.DEEP: {
          if (!fine || hashUnit(i, 5, 7) > 0.28) break;
          const px = x + j(1) * r * 0.5;
          const py = y + j(2) * r * 0.5;
          waves.moveTo(px - r * 0.2, py);
          waves.quadraticCurveTo(px - r * 0.1, py - r * 0.1, px, py);
          waves.quadraticCurveTo(px + r * 0.1, py + r * 0.1, px + r * 0.2, py);
          break;
        }
        case T.GRASS: {
          if (!fine || hashUnit(i, 6, 7) > 0.45) break;
          const px = x + j(1) * r * 0.6;
          const py = y + j(2) * r * 0.6;
          tufts.moveTo(px - r * 0.06, py);
          tufts.lineTo(px - r * 0.1, py - r * 0.12);
          tufts.moveTo(px + r * 0.02, py);
          tufts.lineTo(px + r * 0.04, py - r * 0.14);
          break;
        }
        default:
      }
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#34672f';
    ctx.fill(pines);
    ctx.fillStyle = '#2a6a2e';
    ctx.fill(canopy);
    ctx.fillStyle = '#7d736a';
    ctx.fill(peaks);
    ctx.fillStyle = '#5d554e';
    ctx.fill(shade);
    ctx.fillStyle = '#f4f1ea';
    ctx.fill(snow);
    ctx.fillStyle = '#3e302b';
    ctx.fill(volcano);
    ctx.fillStyle = '#ef5a2c';
    ctx.fill(lava);
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.strokeStyle = '#8a7f47';
    ctx.stroke(hills);
    ctx.strokeStyle = '#c6ac6a';
    ctx.stroke(dunes);
    ctx.strokeStyle = '#46633f';
    ctx.stroke(reeds);
    ctx.strokeStyle = '#6e6964';
    ctx.stroke(cracks);
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke(frost);
    ctx.strokeStyle = 'rgba(160, 200, 235, 0.35)';
    ctx.stroke(waves);
    ctx.strokeStyle = '#7aa64f';
    ctx.stroke(tufts);
  }

  drawRivers(ctx, s, grid, vis, X, Y, r) {
    const path = new Path2D();
    let any = false;
    for (let k = 0; k < vis.length; k++) {
      const i = vis[k];
      const d = s.river[i];
      if (d === -1) continue;
      any = true;
      const x = X(k);
      const y = Y(k);
      let out = null;
      if (d >= 0 && d < 6) {
        const n = grid.neighbor(i, d);
        if (n >= 0) {
          const mx = x + MIDS[d][0] * r;
          const my = y + MIDS[d][1] * r;
          out = R.isWater(s.terrain[n]) ? [x + MIDS[d][0] * r * 1.45, y + MIDS[d][1] * r * 1.45] : [mx, my];
        }
      }
      let fed = false;
      for (let e = 0; e < 6; e++) {
        const n = grid.neighbor(i, e);
        if (n < 0 || s.river[n] < 0 || s.river[n] > 5 || grid.neighbor(n, s.river[n]) !== i) continue;
        fed = true;
        path.moveTo(x + MIDS[e][0] * r, y + MIDS[e][1] * r);
        if (out) path.quadraticCurveTo(x, y, out[0], out[1]);
        else path.lineTo(x, y);
      }
      if (!fed && out) {
        path.moveTo(x, y);
        path.lineTo(out[0], out[1]);
      }
    }
    if (!any) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(20, 50, 80, 0.35)';
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.stroke(path);
    ctx.strokeStyle = RIVER;
    ctx.lineWidth = Math.max(1.3, r * 0.15);
    ctx.stroke(path);
  }

  drawGridLines(ctx, vis, X, Y, r) {
    const path = new Path2D();
    for (let k = 0; k < vis.length; k++) hexPath(path, X(k), Y(k), r);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.07)';
    ctx.lineWidth = 1;
    ctx.stroke(path);
  }

  drawTerritory(ctx, s, grid, vis, X, Y, r) {
    const fills = new Map();
    const borders = new Map();
    const inset = Math.max(1, r * 0.06);
    for (let k = 0; k < vis.length; k++) {
      const i = vis[k];
      const o = s.owner[i];
      if (!o) continue;
      let fill = fills.get(o);
      if (!fill) {
        fills.set(o, (fill = new Path2D()));
        borders.set(o, new Path2D());
      }
      hexPath(fill, X(k), Y(k), r + 0.5);
      const border = borders.get(o);
      const rr = r - inset;
      for (let d = 0; d < 6; d++) {
        const n = grid.neighbor(i, d);
        if (n >= 0 && s.owner[n] === o) continue;
        const [a, b] = EDGE[d];
        border.moveTo(X(k) + CORNERS[a][0] * rr, Y(k) + CORNERS[a][1] * rr);
        border.lineTo(X(k) + CORNERS[b][0] * rr, Y(k) + CORNERS[b][1] * rr);
      }
    }
    ctx.globalAlpha = 0.2;
    for (const [o, path] of fills) {
      ctx.fillStyle = s.races[o]?.color ?? '#ffffff';
      ctx.fill(path);
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    for (const [o, path] of borders) {
      ctx.strokeStyle = 'rgba(10, 12, 18, 0.45)';
      ctx.lineWidth = Math.max(2, r * 0.14);
      ctx.stroke(path);
      ctx.strokeStyle = s.races[o]?.color ?? '#ffffff';
      ctx.lineWidth = Math.max(1.2, r * 0.08);
      ctx.stroke(path);
    }
  }

  drawRuins(ctx, s, X, Y, r) {
    const path = new Path2D();
    let any = false;
    for (const ruin of Object.values(s.ruins)) {
      const k = this.slotOf(ruin.i);
      if (k < 0 || this.source.at.has(ruin.i)) continue;
      any = true;
      const x = X(k);
      const y = Y(k);
      const u = r * 0.1;
      path.rect(x - u * 3, y - u * 2, u * 1.2, u * 3.5);
      path.rect(x + u * 0.6, y - u * 1, u * 1.2, u * 2.5);
      path.rect(x - u * 3.2, y + u * 2, u * 6.6, u * 1);
    }
    if (!any) return;
    ctx.fillStyle = '#bdb3a2';
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(40, 32, 24, 0.8)';
    ctx.lineWidth = Math.max(0.8, r * 0.03);
    ctx.stroke(path);
  }

  drawLabels(ctx, s, X, Y, r, placed) {
    const labels = Object.values(s.labels);
    if (!labels.length) return;
    const size = clamp(r * 0.85, 12, 30);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const label of labels) {
      const k = this.slotOf(label.i);
      if (k < 0) continue;
      const t = s.terrain[label.i];
      const water = R.isWater(t);
      const high = t === T.MOUNTAIN || t === T.HILLS || t === T.VOLCANO;
      const text = high ? label.text.toUpperCase() : label.text;
      const x = X(k);
      ctx.font = `${water ? 'italic 500' : '600'} ${Math.round(size)}px ${SERIF}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = high ? `${Math.round(size * 0.12)}px` : '0px';
      const w = ctx.measureText(text).width;
      const base = Y(k) - (this.source.at.has(label.i) ? r * 0.95 : 0);
      const y = [base, base - size * 1.15, base + size * 1.15].find((cy) => fits(placed, box(x, cy, w, size)));
      if (y === undefined) continue;
      placed.push(box(x, y, w, size));
      ctx.lineWidth = Math.max(2, size * 0.26);
      ctx.strokeStyle = water ? 'rgba(8, 24, 44, 0.85)' : 'rgba(250, 244, 228, 0.9)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = water ? '#e6f2fc' : '#3a2c1c';
      ctx.fillText(text, x, y);
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  drawSettlements(ctx, s, X, Y, r, placed = []) {
    const list = Object.values(s.settlements);
    if (!list.length) return;
    const names = [];
    for (const st of list) {
      const k = this.slotOf(st.i);
      if (k < 0) continue;
      const race = s.races[st.race];
      const color = race?.color ?? '#cccccc';
      const x = X(k);
      const y = Y(k);
      if (r < 7) {
        ctx.beginPath();
        ctx.arc(x, y, safe(Math.max(2.4 + st.size * 0.35, r * (0.2 + 0.06 * st.size))), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#fff6df';
        ctx.stroke();
      } else {
        drawSettlementIcon(ctx, x, y, r, st.size, color);
      }
      if (st.wonder) drawStar(ctx, x + r * 0.5, y - r * 0.52, Math.max(3, r * 0.17));
      const showName = r >= 14 || (r >= 8 && st.size >= 3) || (r >= 4.5 && st.size >= 5);
      if (showName) names.push([st, x, y]);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    names.sort((a, b) => b[0].size - a[0].size || a[0].id - b[0].id);
    for (const [st, x, y] of names) {
      const size = clamp(r * 0.4, 9, 15) + (st.size >= 4 ? 1.5 : 0);
      ctx.font = `${st.size >= 3 ? 700 : 600} ${Math.round(size)}px ${SERIF}`;
      const ty = y + Math.max(4, r * 0.5);
      const b = box(x, ty + size / 2, ctx.measureText(st.name).width, size);
      if (!fits(placed, b)) continue;
      placed.push(b);
      ctx.lineWidth = Math.max(2, size * 0.3);
      ctx.strokeStyle = 'rgba(16, 12, 8, 0.85)';
      ctx.strokeText(st.name, x, ty);
      ctx.fillStyle = '#fff6df';
      ctx.fillText(st.name, x, ty);
    }
  }

  // Crossed swords between the nearest settlements of every pair at war.
  drawFronts(ctx, s, grid, cam, view, r) {
    const key = `${Object.keys(s.relations).length}:${JSON.stringify(s.relations)}:${Object.keys(s.settlements).length}:${s.era}`;
    if (key !== this.frontsKey) {
      this.frontsKey = key;
      this.fronts = [];
      const byRace = new Map();
      for (const st of Object.values(s.settlements)) {
        if (!byRace.has(st.race)) byRace.set(st.race, []);
        byRace.get(st.race).push(st);
      }
      for (const [k, rel] of Object.entries(s.relations)) {
        if (rel.state !== 'war') continue;
        const [a, b] = k.split('|').map(Number);
        let best = null;
        for (const sa of byRace.get(a) ?? []) {
          for (const sb of byRace.get(b) ?? []) {
            const d = grid.distance(sa.i, sb.i);
            if (!best || d < best.d) best = { d, a: sa.i, b: sb.i };
          }
        }
        if (best) this.fronts.push(best);
      }
    }
    for (const f of this.fronts) {
      const [ax, ay] = grid.center(f.a, HEX);
      const [bx, by] = grid.center(f.b, HEX);
      const x = ((ax + bx) / 2 - cam.x) * cam.zoom + view.w / 2;
      const y = ((ay + by) / 2 - cam.y) * cam.zoom + view.h / 2;
      if (x < -40 || y < -40 || x > view.w + 40 || y > view.h + 40) continue;
      drawSwords(ctx, x, y, Math.max(7, r * 0.34));
    }
  }

  drawOverlays(ctx, s, grid, cam, view, r, now) {
    const o = this.overlay;
    const at = (i) => {
      const [x, y] = grid.center(i, HEX);
      return [(x - cam.x) * cam.zoom + view.w / 2, (y - cam.y) * cam.zoom + view.h / 2];
    };
    // Other gods' cursors.
    for (const [pid, cursor] of this.source.cursors ?? []) {
      const p = s.players[pid];
      if (!p || now - cursor.at > 5000 || cursor.i < 0 || cursor.i >= grid.N) continue;
      const [x, y] = at(cursor.i);
      const path = new Path2D();
      hexPath(path, x, y, r * 0.92);
      ctx.lineWidth = Math.max(2, r * 0.1);
      ctx.strokeStyle = p.color;
      ctx.stroke(path);
      ctx.font = `600 11px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const w = ctx.measureText(p.name).width + 10;
      const ty = y - r * 0.95;
      ctx.fillStyle = p.color;
      roundRect(ctx, x - w / 2, ty - 16, w, 16, 5);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillText(p.name, x, ty - 2);
    }
    // Brush preview.
    if (o.brush.length) {
      const path = new Path2D();
      for (const i of o.brush) {
        const [x, y] = at(i);
        hexPath(path, x, y, r * 0.94);
      }
      ctx.fillStyle = o.brushOk ? 'rgba(255, 255, 255, 0.14)' : 'rgba(232, 98, 90, 0.2)';
      ctx.fill(path);
      ctx.lineWidth = Math.max(1.5, r * 0.07);
      ctx.strokeStyle = o.brushOk ? 'rgba(255, 255, 255, 0.85)' : 'rgba(232, 98, 90, 0.95)';
      ctx.stroke(path);
    } else if (o.hover >= 0 && o.hover < grid.N) {
      const [x, y] = at(o.hover);
      const path = new Path2D();
      hexPath(path, x, y, r * 0.94);
      ctx.lineWidth = Math.max(1.5, r * 0.06);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.stroke(path);
    }
    // River drag in progress.
    if (o.path.length > 1) {
      ctx.beginPath();
      o.path.forEach((i, k) => {
        const [x, y] = at(i);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = 'rgba(160, 215, 255, 0.8)';
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.setLineDash([r * 0.2, r * 0.2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.selected >= 0 && o.selected < grid.N) {
      const [x, y] = at(o.selected);
      const path = new Path2D();
      hexPath(path, x, y, r * 0.96);
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.strokeStyle = '#f0cd7c';
      ctx.stroke(path);
    }
    for (const ping of this.pings) {
      const t = (now - ping.at) / 1600;
      const [x, y] = at(ping.i);
      ctx.beginPath();
      ctx.arc(x, y, safe(r * (0.6 + t * 1.8)), 0, Math.PI * 2);
      ctx.strokeStyle = ping.color;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // The whole map as a PNG, `px` pixels per hex radius.
  async exportImage(px = 16) {
    const grid = this.source.grid;
    const b = this.bounds();
    const zoom = px / HEX;
    const pad = 24;
    const view = { w: Math.ceil(b.w * zoom) + pad * 2, h: Math.ceil(b.h * zoom) + pad * 2 + 40, dpr: 1 };
    const canvas = document.createElement('canvas');
    canvas.width = view.w;
    canvas.height = view.h;
    const ctx = canvas.getContext('2d');
    // The world sits below a 40px title band.
    const cam = { x: b.x0 + b.w / 2, y: b.y0 + b.h / 2 - 20 / zoom, zoom };
    const saved = this.slot;
    this.slot = new Int32Array(grid.N);
    this.frontsKey = '';
    this.drawWorld(ctx, cam, view, { overlays: false, background: '#101521' });
    this.slot = saved;
    this.frontsKey = '';
    const s = this.source.state;
    ctx.font = `600 22px ${SERIF}`;
    ctx.fillStyle = '#f0cd7c';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${s.settings.worldName}`, pad, 12);
    ctx.font = `14px ${SANS}`;
    ctx.fillStyle = '#9ba4b7';
    ctx.textAlign = 'right';
    ctx.fillText(`Year ${s.year} · CTB World`, view.w - pad, 18);
    return new Promise((done) => canvas.toBlob(done, 'image/png'));
  }
}

// Axis-aligned text box centred on (x, y), with a little breathing room.
function box(x, y, w, h) {
  const pad = 3;
  return [x - w / 2 - pad, y - h / 2 - pad / 2, x + w / 2 + pad, y + h / 2 + pad / 2];
}

function fits(placed, b) {
  return placed.every((p) => b[2] < p[0] || b[0] > p[2] || b[3] < p[1] || b[1] > p[3]);
}

function roundRect(ctx, x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function house(walls, roofs, x, y, u) {
  walls.rect(x - u, y - u * 0.15, u * 2, u * 1.35);
  roofs.moveTo(x - u * 1.3, y - u * 0.1);
  roofs.lineTo(x, y - u * 1.35);
  roofs.lineTo(x + u * 1.3, y - u * 0.1);
  roofs.closePath();
}

function tower(walls, roofs, x, y, u, height) {
  walls.rect(x - u * 0.8, y - height, u * 1.6, height + u * 1.2);
  roofs.moveTo(x - u * 1.05, y - height);
  roofs.lineTo(x, y - height - u * 1.4);
  roofs.lineTo(x + u * 1.05, y - height);
  roofs.closePath();
}

export function drawSettlementIcon(ctx, x, y, r, size, color) {
  const u = r * 0.16;
  const walls = new Path2D();
  const roofs = new Path2D();
  const layouts = {
    1: [[0, 0.1]],
    2: [
      [-1.25, 0.4],
      [1.25, -0.05],
    ],
    3: [
      [-1.5, 0.55],
      [1.5, 0.55],
      [0, -0.55],
    ],
  };
  // Shadow under the settlement, for legibility on any terrain.
  ctx.beginPath();
  ctx.ellipse(x, y + u * 1.3, safe(u * (2.2 + size * 0.45)), safe(u * 1.1), 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.fill();
  if (size >= 3) {
    ctx.beginPath();
    ctx.arc(x, y, safe(r * (size >= 5 ? 0.6 : 0.52)), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (size <= 3) {
    for (const [ox, oy] of layouts[size] ?? layouts[1]) house(walls, roofs, x + ox * u, y + oy * u, u);
  } else if (size === 4) {
    house(walls, roofs, x - u * 1.7, y + u * 0.6, u);
    house(walls, roofs, x + u * 1.7, y + u * 0.6, u);
    tower(walls, roofs, x, y + u * 0.2, u, u * 2.4);
  } else {
    tower(walls, roofs, x - u * 1.8, y + u * 0.5, u * 0.9, u * 1.8);
    tower(walls, roofs, x + u * 1.8, y + u * 0.5, u * 0.9, u * 1.8);
    walls.rect(x - u * 1.8, y - u * 0.4, u * 3.6, u * 2.1);
    tower(walls, roofs, x, y, u * 1.1, u * 2.9);
  }
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#f1e8d3';
  ctx.fill(walls);
  ctx.fillStyle = color;
  ctx.fill(roofs);
  ctx.lineWidth = Math.max(0.8, u * 0.28);
  ctx.strokeStyle = '#231a12';
  ctx.stroke(walls);
  ctx.stroke(roofs);
}

function drawStar(ctx, x, y, rad) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? rad * 0.45 : rad;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = '#f5c842';
  ctx.fill();
  ctx.lineWidth = Math.max(0.8, rad * 0.18);
  ctx.strokeStyle = '#5a3d05';
  ctx.stroke();
}

function drawSwords(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, safe(size * 1.05), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120, 20, 18, 0.85)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.12);
  ctx.strokeStyle = '#ffd9d2';
  ctx.stroke();
  ctx.lineCap = 'round';
  for (const sign of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(-size * 0.6 * sign, -size * 0.6);
    ctx.lineTo(size * 0.55 * sign, size * 0.55);
    ctx.moveTo(-size * 0.2 * sign, size * 0.35);
    ctx.lineTo(size * 0.35 * sign, -size * 0.2);
    ctx.strokeStyle = '#ffe9e4';
    ctx.lineWidth = Math.max(1.2, size * 0.16);
    ctx.stroke();
  }
  ctx.restore();
}

// The overview map in the corner: every tile as a dot, the camera's view as a box.
class Minimap {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.renderer = renderer;
    this.base = document.createElement('canvas');
    this.stale = true;
    this.pending = 0;
    this.lastBase = 0;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(40, Math.round(rect.width));
    const h = Math.max(30, Math.round(rect.height));
    if (this.w === w && this.h === h && this.dpr === dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.stale = true;
    this.draw();
  }

  invalidate() {
    this.stale = true;
    this.requestDraw();
  }

  requestDraw() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.draw();
    });
  }

  layout() {
    const r = this.renderer;
    const b = r.bounds();
    const scale = Math.min(this.w / b.w, this.h / b.h);
    return { b, scale, ox: (this.w - b.w * scale) / 2, oy: (this.h - b.h * scale) / 2 };
  }

  rebuild() {
    const src = this.renderer.source;
    const s = src.state;
    const grid = src.grid;
    const { b, scale, ox, oy } = this.layout();
    const base = this.base;
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    const ctx = base.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b101a';
    ctx.fillRect(0, 0, this.w, this.h);
    const r = HEX * scale;
    for (let i = 0; i < grid.N; i++) {
      const [x, y] = grid.center(i, HEX);
      const px = ox + (x - b.x0) * scale;
      const py = oy + (y - b.y0) * scale;
      const o = s.owner[i];
      ctx.fillStyle = o && s.races[o] ? s.races[o].color : R.TERRAIN[s.terrain[i]].color;
      ctx.fillRect(px - r * 0.9, py - r * 0.8, r * 1.8, r * 1.6);
    }
    this.stale = false;
    this.lastBase = performance.now();
  }

  draw() {
    const src = this.renderer.source;
    if (!src.state || !src.grid || !this.w) return;
    if (this.stale) this.rebuild();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { b, scale, ox, oy } = this.layout();
    const r = this.renderer;
    const [x0, y0] = r.toWorld(0, 0);
    const [x1, y1] = r.toWorld(r.view.w, r.view.h);
    ctx.strokeStyle = '#f0cd7c';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + (x0 - b.x0) * scale, oy + (y0 - b.y0) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
  }

  // World point for a click on the minimap.
  worldAt(sx, sy) {
    const { b, scale, ox, oy } = this.layout();
    return [(sx - ox) / scale + b.x0, (sy - oy) / scale + b.y0];
  }
}

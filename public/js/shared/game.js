// The authoritative game engine. One Game instance lives wherever the world is
// hosted (the Node server, or the host player's browser); everyone else keeps
// a replica built from its snapshot and the patches it broadcasts.
//
// State is plain JSON so it can be sent, saved and loaded as is. Every change
// goes through a setter that records what changed; flush() turns those records
// into a patch, and applyPatch() replays a patch onto a replica.

import { Grid } from './hex.js';
import { Rng, randomSeed } from './rng.js';
import * as R from './rules.js';
import { generateWorld } from './worldgen.js';
import { makeName } from './names.js';

const { T } = R;

export const PROTOCOL = 1;
export const STATE_VERSION = 1;

const ENTITY_KINDS = ['players', 'races', 'settlements', 'labels', 'relations', 'ruins'];
const PATCH_KEYS = { players: 'pl', races: 'rc', settlements: 'st', labels: 'lb', relations: 'rl', ruins: 'ru' };
const META_KEYS = ['phase', 'host', 'age', 'round', 'era', 'year', 'settings', 'seed'];

// ---------------------------------------------------------------- state

export function createState(settings, seed = randomSeed()) {
  const s = {
    v: STATE_VERSION,
    seed: seed >>> 0,
    settings: R.sanitizeSettings(settings),
    phase: 'lobby',
    host: 0,
    age: 1,
    round: 1,
    era: 0,
    year: 0,
    W: 0,
    H: 0,
    terrain: [],
    river: [],
    owner: [],
    players: {},
    races: {},
    settlements: {},
    labels: {},
    relations: {},
    ruins: {},
    chronicle: [],
    nextId: 1,
    rng: (seed ^ 0x9e3779b9) >>> 0,
  };
  fillWorld(s);
  return s;
}

function fillWorld(s) {
  const { W, H } = R.MAP_SIZES[s.settings.size];
  const world = generateWorld({ W, H, seed: s.seed, start: s.settings.start });
  s.W = W;
  s.H = H;
  s.terrain = world.terrain;
  s.river = world.river;
  s.owner = new Array(W * H).fill(0);
}

const int = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
const str = (v, max, dflt = '') => R.cleanText(v, max) || dflt;
const color = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : R.GOD_COLORS[0]);

// Rebuilds a state from untrusted input (a loaded file), keeping only what is
// well formed. Throws when the input is not a world at all.
export function normalizeState(input) {
  if (!input || typeof input !== 'object') throw new Error('Not a CTB World save.');
  const W = input.W;
  const H = input.H;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 8 || H < 8 || W > 128 || H > 128) {
    throw new Error('The saved world has an invalid size.');
  }
  const N = W * H;
  for (const key of ['terrain', 'river', 'owner']) {
    if (!Array.isArray(input[key]) || input[key].length !== N) throw new Error(`The saved world's ${key} map is damaged.`);
  }
  const s = createState(input.settings, int(input.seed, 0, 0xffffffff, 1));
  s.W = W;
  s.H = H;
  s.settings.size = Object.keys(R.MAP_SIZES).find((k) => R.MAP_SIZES[k].W === W && R.MAP_SIZES[k].H === H) ?? s.settings.size;
  s.terrain = input.terrain.map((t) => int(t, 0, R.TERRAIN_COUNT - 1, T.DEEP));
  s.river = input.river.map((d, i) => (R.isWater(s.terrain[i]) ? -1 : int(d, -1, 6, -1)));
  s.owner = new Array(N).fill(0);
  s.phase = ['lobby', 'playing', 'ended'].includes(input.phase) ? input.phase : 'lobby';
  s.age = int(input.age, 1, 3, 1);
  s.round = int(input.round, 1, 10000, 1);
  s.era = int(input.era, 0, 1e6, 0);
  s.year = int(input.year, 0, 1e8, 0);
  s.rng = int(input.rng, 0, 0xffffffff, s.rng);
  let maxId = 0;
  const seen = (id) => {
    maxId = Math.max(maxId, id);
    return id;
  };
  for (const p of Object.values(input.players ?? {})) {
    if (!p || !Number.isInteger(p.id) || p.id <= 0) continue;
    s.players[seen(p.id)] = {
      id: p.id,
      name: str(p.name, R.LIMITS.playerName, 'Nameless'),
      color: color(p.color),
      domain: Object.hasOwn(R.DOMAINS, p.domain) ? p.domain : 'earth',
      pp: Number.isFinite(p.pp) ? Math.min(1000, Math.max(0, Math.round(p.pp * 2) / 2)) : 0,
      ready: false,
      online: false,
      spectator: p.spectator === true,
      named: int(p.named, 0, 1e6, 0),
      legends: int(p.legends, 0, 1e6, 0),
      legendKey: typeof p.legendKey === 'string' ? p.legendKey.slice(0, 20) : '',
    };
  }
  for (const r of Object.values(input.races ?? {})) {
    if (!r || !Number.isInteger(r.id) || r.id <= 0 || !Object.hasOwn(R.ARCHETYPES, r.arch)) continue;
    s.races[seen(r.id)] = {
      id: r.id,
      name: str(r.name, R.LIMITS.entityName, 'Folk'),
      arch: r.arch,
      god: int(r.god, 0, 1e9, 0),
      color: color(r.color),
      born: int(r.born, 0, 1e8, 0),
      alive: r.alive !== false,
    };
  }
  const taken = new Set();
  for (const st of Object.values(input.settlements ?? {})) {
    if (!st || !Number.isInteger(st.id) || st.id <= 0 || !s.races[st.race]) continue;
    const i = int(st.i, 0, N - 1, -1);
    if (i < 0 || taken.has(i) || !R.canSettle(s.terrain[i])) continue;
    taken.add(i);
    s.settlements[seen(st.id)] = {
      id: st.id,
      name: str(st.name, R.LIMITS.entityName, 'Hearth'),
      race: st.race,
      i,
      size: int(st.size, 1, 5, 1),
      born: int(st.born, 0, 1e8, 0),
      wonder: Object.hasOwn(R.WONDERS, st.wonder) ? st.wonder : '',
    };
  }
  for (const l of Object.values(input.labels ?? {})) {
    if (!l || !Number.isInteger(l.id) || l.id <= 0) continue;
    const i = int(l.i, 0, N - 1, -1);
    const text = str(l.text, R.LIMITS.placeName);
    if (i < 0 || !text) continue;
    s.labels[seen(l.id)] = { id: l.id, i, text, god: int(l.god, 0, 1e9, 0) };
  }
  for (const [key, rel] of Object.entries(input.relations ?? {})) {
    const [a, b] = key.split('|').map(Number);
    if (!s.races[a] || !s.races[b] || a >= b || !rel || !['war', 'trade'].includes(rel.state)) continue;
    s.relations[key] = { state: rel.state, since: int(rel.since, 0, 1e6, 0) };
  }
  for (const ru of Object.values(input.ruins ?? {})) {
    const i = int(ru?.i, 0, N - 1, -1);
    if (i < 0 || !R.isLand(s.terrain[i])) continue;
    s.ruins[i] = { i, name: str(ru.name, R.LIMITS.entityName, 'Ruins'), era: int(ru.era, 0, 1e6, 0) };
  }
  if (Array.isArray(input.chronicle)) {
    for (const e of input.chronicle.slice(-R.LIMITS.chronicle)) {
      if (!e || !Number.isInteger(e.id) || typeof e.text !== 'string') continue;
      const entry = {
        id: seen(e.id),
        era: int(e.era, 0, 1e6, 0),
        year: int(e.year, 0, 1e8, 0),
        age: int(e.age, 1, 3, 1),
        kind: typeof e.kind === 'string' ? e.kind.slice(0, 12) : 'event',
        text: e.text.slice(0, 600),
      };
      if (Number.isInteger(e.god)) entry.god = e.god;
      if (Number.isInteger(e.i) && e.i >= 0 && e.i < N) entry.i = e.i;
      s.chronicle.push(entry);
    }
  }
  s.nextId = Math.max(int(input.nextId, 1, 1e9, 1), maxId + 1);
  s.host = 0;
  return s;
}

// Applies a patch from flush() to a replica. Used by every client.
export function applyPatch(state, patch) {
  if (patch.w) {
    Object.assign(state, patch.w);
  }
  if (patch.m) Object.assign(state, patch.m);
  if (patch.n) state.nextId = patch.n;
  const tl = patch.tl;
  if (tl) {
    for (let k = 0; k < tl.length; k += 4) {
      const i = tl[k];
      state.terrain[i] = tl[k + 1];
      state.river[i] = tl[k + 2];
      state.owner[i] = tl[k + 3];
    }
  }
  for (const kind of ENTITY_KINDS) {
    const map = patch[PATCH_KEYS[kind]];
    if (!map) continue;
    const target = state[kind];
    for (const [id, value] of Object.entries(map)) {
      if (value === null) delete target[id];
      else target[id] = value;
    }
  }
  if (patch.ch) {
    const log = state.chronicle;
    for (const entry of patch.ch) {
      if (!log.length || entry.id > log[log.length - 1].id) log.push(entry);
    }
    if (log.length > R.LIMITS.chronicle) log.splice(0, log.length - R.LIMITS.chronicle);
  }
  return state;
}

// Legacy per god, computed from state alone so every replica can show it.
export function computeScores(s) {
  const out = {};
  for (const p of Object.values(s.players)) {
    if (p.spectator) continue;
    out[p.id] = { legacy: 0, followers: 0, races: 0, wonders: 0, settlements: 0, names: 0, legends: 0 };
  }
  for (const race of Object.values(s.races)) {
    if (race.alive && out[race.god]) out[race.god].races++;
  }
  for (const st of Object.values(s.settlements)) {
    const o = out[s.races[st.race]?.god];
    if (!o) continue;
    o.followers += st.size;
    o.settlements++;
    if (st.wonder) o.wonders++;
  }
  for (const label of Object.values(s.labels)) if (out[label.god]) out[label.god].names++;
  for (const [id, o] of Object.entries(out)) {
    const p = s.players[id];
    o.names = Math.min(8, o.names);
    o.legends = p.domain === 'wisdom' ? Math.min(5, p.legends) : 0;
    o.legacy = o.followers + 3 * o.races + 5 * o.wonders + o.names + o.legends;
  }
  return out;
}

// "the north-west", "the heart of the world"...
export function regionName(W, H, i) {
  const col = i % W;
  const row = Math.floor(i / W);
  const x = col / Math.max(1, W - 1) - 0.5;
  const y = row / Math.max(1, H - 1) - 0.5;
  if (Math.abs(x) < 0.17 && Math.abs(y) < 0.17) return 'the heart of the world';
  const angle = Math.atan2(-y * 1.3, x);
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  const sector = Math.round(angle / (Math.PI / 4));
  const name = names[(sector + 8) % 8];
  const far = Math.max(Math.abs(x), Math.abs(y)) > 0.4 ? 'far ' : '';
  return `the ${far}${name}`;
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (n, one, many) => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`;

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export const relKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function emptyDirty() {
  return {
    meta: false,
    world: false,
    tiles: new Set(),
    players: new Set(),
    races: new Set(),
    settlements: new Set(),
    labels: new Set(),
    relations: new Set(),
    ruins: new Set(),
    chronicle: [],
  };
}

const ok = (extra) => ({ ok: true, ...extra });
const fail = (err) => ({ ok: false, err });

// ---------------------------------------------------------------- engine

export class Game {
  constructor(state) {
    this.s = state;
    this.grid = new Grid(state.W, state.H);
    this.rng = new Rng(state.rng);
    this.dirty = emptyDirty();
    this.shaping = new Map();
    this.at = new Map();
    for (const st of Object.values(state.settlements)) this.at.set(st.i, st.id);
    this.territoryStale = true;
    this.recomputeTerritory();
    this.dirty = emptyDirty();
  }

  static create(settings, seed) {
    return new Game(createState(settings, seed));
  }

  get sandbox() {
    return this.s.settings.mode === 'sandbox';
  }

  snapshot() {
    this.s.rng = this.rng.s;
    return this.s;
  }

  // ------------------------------------------------ change tracking

  touch(kind, id) {
    this.dirty[kind].add(String(id));
  }

  markMeta() {
    this.dirty.meta = true;
  }

  setTerrain(i, t) {
    const s = this.s;
    if (s.terrain[i] === t) return;
    const wasWater = R.isWater(s.terrain[i]);
    s.terrain[i] = t;
    this.dirty.tiles.add(i);
    if (R.isWater(t)) {
      if (s.river[i] !== -1) s.river[i] = -1;
      if (s.ruins[i]) this.removeRuin(i);
    }
    if (wasWater !== R.isWater(t)) this.territoryStale = true;
  }

  setRiver(i, d) {
    if (this.s.river[i] === d) return;
    this.s.river[i] = d;
    this.dirty.tiles.add(i);
  }

  log(kind, text, extra = {}) {
    const s = this.s;
    const entry = { id: s.nextId++, era: s.era, year: s.year, age: s.age, kind, text, ...extra };
    s.chronicle.push(entry);
    if (s.chronicle.length > R.LIMITS.chronicle) s.chronicle.splice(0, s.chronicle.length - R.LIMITS.chronicle);
    this.dirty.chronicle.push(entry);
    return entry;
  }

  flush() {
    const d = this.dirty;
    const s = this.s;
    const patch = { t: 'patch' };
    let any = false;
    if (d.world) {
      patch.w = { W: s.W, H: s.H, terrain: s.terrain, river: s.river, owner: s.owner };
      any = true;
    }
    if (d.meta || d.world) {
      patch.m = {};
      for (const key of META_KEYS) patch.m[key] = s[key];
      any = true;
    }
    if (d.tiles.size && !d.world) {
      const tl = [];
      for (const i of d.tiles) tl.push(i, s.terrain[i], s.river[i], s.owner[i]);
      patch.tl = tl;
      any = true;
    }
    for (const kind of ENTITY_KINDS) {
      if (!d[kind].size) continue;
      const map = {};
      for (const id of d[kind]) map[id] = s[kind][id] ?? null;
      patch[PATCH_KEYS[kind]] = map;
      any = true;
    }
    if (d.chronicle.length) {
      patch.ch = d.chronicle;
      any = true;
    }
    this.dirty = emptyDirty();
    if (!any) return null;
    patch.n = s.nextId;
    return patch;
  }

  // ------------------------------------------------ helpers

  settlementAt(i) {
    const id = this.at.get(i);
    return id ? this.s.settlements[id] : null;
  }

  raceOf(st) {
    return st ? this.s.races[st.race] : null;
  }

  godOf(race) {
    return race ? this.s.players[race.god] : null;
  }

  settlementsOf(raceId) {
    return Object.values(this.s.settlements).filter((st) => st.race === raceId);
  }

  racesOf(pid) {
    return Object.values(this.s.races).filter((r) => r.alive && r.god === pid);
  }

  region(i) {
    return regionName(this.s.W, this.s.H, i);
  }

  takenNames() {
    const taken = new Set();
    for (const st of Object.values(this.s.settlements)) taken.add(st.name.toLowerCase());
    for (const r of Object.values(this.s.races)) taken.add(r.name.toLowerCase());
    for (const ru of Object.values(this.s.ruins)) taken.add(ru.name.toLowerCase());
    return taken;
  }

  coastal(i) {
    return this.grid.neighbors(i).some((n) => R.isWater(this.s.terrain[n]));
  }

  // A site for a new settlement: settleable land with no settlement on it or next to it.
  canFound(i) {
    if (!R.canSettle(this.s.terrain[i])) return false;
    if (this.at.has(i)) return false;
    return !this.grid.neighbors(i).some((n) => this.at.has(n));
  }

  validTile(i) {
    return Number.isInteger(i) && i >= 0 && i < this.grid.N;
  }

  // ------------------------------------------------ players and setup

  addPlayer({ name, color: c, domain, spectator = false }) {
    const s = this.s;
    const id = s.nextId++;
    const p = {
      id,
      name,
      color: c,
      domain,
      pp: 0,
      ready: false,
      online: true,
      spectator,
      named: 0,
      legends: 0,
      legendKey: '',
    };
    if (s.phase === 'playing' && !spectator) p.pp = this.income(p);
    s.players[id] = p;
    this.touch('players', id);
    return p;
  }

  removePlayer(id) {
    if (!this.s.players[id]) return;
    delete this.s.players[id];
    this.touch('players', id);
  }

  updatePlayer(id, changes) {
    const p = this.s.players[id];
    if (!p) return;
    Object.assign(p, changes);
    this.touch('players', id);
  }

  setHost(pid) {
    if (this.s.host === pid) return;
    this.s.host = pid;
    this.markMeta();
  }

  setSettings(input) {
    const s = this.s;
    if (s.phase !== 'lobby') return fail('Settings can only change before the world begins.');
    const next = R.sanitizeSettings(input, s.settings);
    const regenerate = next.size !== s.settings.size || next.start !== s.settings.start;
    s.settings = next;
    this.markMeta();
    if (regenerate) this.regenerate(s.seed);
    return ok();
  }

  reroll(seed = randomSeed()) {
    if (this.s.phase !== 'lobby') return fail('The world has already begun.');
    this.regenerate(seed);
    return ok();
  }

  regenerate(seed) {
    const s = this.s;
    s.seed = seed >>> 0;
    fillWorld(s);
    this.grid = new Grid(s.W, s.H);
    for (const kind of ['races', 'settlements', 'labels', 'relations', 'ruins']) {
      for (const id of Object.keys(s[kind])) this.touch(kind, id);
      s[kind] = {};
    }
    this.at.clear();
    this.dirty.world = true;
    this.markMeta();
  }

  activePlayers() {
    return Object.values(this.s.players).filter((p) => !p.spectator);
  }

  start() {
    const s = this.s;
    if (s.phase !== 'lobby') return fail('The world has already begun.');
    const gods = this.activePlayers();
    if (!gods.length) return fail('There are no gods to shape the world.');
    s.phase = 'playing';
    s.age = 1;
    s.round = 1;
    s.era = 0;
    s.year = 0;
    for (const p of gods) {
      p.pp = this.income(p);
      p.ready = false;
      this.touch('players', p.id);
    }
    const names = listJoin(gods.map((p) => p.name));
    if (this.sandbox) {
      this.log('age', `${s.settings.worldName} lay open before ${names}, and there was no hurry.`);
    } else {
      this.log('age', `${s.settings.worldName} rose from the void, and ${names} gathered to shape it. ${R.AGES[0].name} began.`);
    }
    this.markMeta();
    return ok();
  }

  // Back to the lobby with a fresh world, keeping the gods and settings.
  restart(seed = randomSeed()) {
    const s = this.s;
    s.phase = 'lobby';
    s.age = 1;
    s.round = 1;
    s.era = 0;
    s.year = 0;
    s.chronicle = [];
    this.dirty.chronicle = [];
    for (const p of Object.values(s.players)) {
      Object.assign(p, { pp: 0, ready: false, named: 0, legends: 0, legendKey: '' });
      this.touch('players', p.id);
    }
    this.shaping.clear();
    this.regenerate(seed);
  }

  income(p) {
    if (this.sandbox || p.spectator) return 0;
    const s = this.s;
    let inc = R.AGES[s.age - 1].income;
    if (s.age === 1 && s.settings.start === 'sea') inc += 10;
    if (p.domain === 'wisdom') inc += 2;
    if (s.age >= 2) {
      let followers = 0;
      let wonders = 0;
      for (const st of Object.values(s.settlements)) {
        if (s.races[st.race]?.god !== p.id) continue;
        followers += st.size;
        if (st.wonder) wonders++;
      }
      inc += Math.min(4, Math.floor(followers / 6)) + wonders;
    }
    return inc;
  }

  // ------------------------------------------------ costs

  baseCost(type) {
    const def = R.ACTIONS[type];
    if (!def) return null;
    if (this.sandbox) return def.cost.find((c) => c != null) ?? 0;
    return def.cost[this.s.age - 1];
  }

  cost(p, type, units = 1) {
    const base = this.baseCost(type);
    if (base == null) return null;
    const mult = R.DOMAINS[p.domain]?.mult?.[type] ?? 1;
    return R.priceOf(base * units * mult);
  }

  charge(p, amount) {
    if (this.sandbox || amount <= 0) return true;
    if (p.pp < amount) return false;
    p.pp -= amount;
    this.touch('players', p.id);
    return true;
  }

  tooPoor(p, amount) {
    return fail(`That needs ${R.fmtPower(amount)} power; you have ${R.fmtPower(p.pp)}.`);
  }

  // ------------------------------------------------ actions

  act(pid, a) {
    const s = this.s;
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') return fail('Unknown deed.');
    const p = s.players[pid];
    if (!p) return fail('You are not part of this world.');
    if (p.spectator) return fail('Spectators can only watch.');
    if (s.phase !== 'playing') return fail(s.phase === 'lobby' ? 'The world has not begun yet.' : 'This world has ended.');
    const def = R.ACTIONS[a.type];
    const handler = HANDLERS[a.type];
    if (!def || !handler) return fail('Unknown deed.');
    if (def.wrath && !s.settings.wrath) return fail('Divine wrath is disabled in this world.');
    if (this.baseCost(a.type) == null) {
      return fail(`${def.name} is not possible until ${R.AGES[R.unlockAge(a.type) - 1].name}.`);
    }
    const result = handler.call(this, p, a);
    if (this.territoryStale) this.recomputeTerritory();
    return result;
  }

  setReady(pid, ready) {
    const p = this.s.players[pid];
    if (!p || p.spectator || this.s.phase !== 'playing' || p.ready === ready) return;
    p.ready = ready;
    this.touch('players', pid);
  }

  allReady() {
    const gods = this.activePlayers().filter((p) => p.online);
    return this.s.phase === 'playing' && gods.length > 0 && gods.every((p) => p.ready);
  }

  noteShape(p, tiles) {
    let rec = this.shaping.get(p.id);
    if (!rec) {
      rec = { counts: {}, xs: 0, ys: 0, n: 0, tiles: [] };
      this.shaping.set(p.id, rec);
    }
    for (const [i, what] of tiles) {
      rec.counts[what] = (rec.counts[what] ?? 0) + 1;
      rec.xs += i % this.s.W;
      rec.ys += Math.floor(i / this.s.W);
      rec.n++;
      if (rec.tiles.length < 400) rec.tiles.push(i);
    }
  }

  // The tiles a shaping deed covers: the brush around `i`, or an explicit list
  // (a drag sends only tiles it has not touched yet) that must stay within a
  // large brush of `i`.
  brushTiles(a) {
    const i = a.i;
    if (!Array.isArray(a.tiles)) return this.grid.within(i, int(a.r, 0, 2, 0));
    if (a.tiles.length < 1 || a.tiles.length > 19) return null;
    const seen = new Set();
    for (const t of a.tiles) {
      if (!this.validTile(t) || seen.has(t) || this.grid.distance(i, t) > 2) return null;
      seen.add(t);
    }
    return [...seen];
  }

  shape(p, a, next, what) {
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    const tiles = this.brushTiles(a);
    if (!tiles) return fail('That brush stroke does not fit on the map.');
    const changes = [];
    let blocked = '';
    for (const t of tiles) {
      const from = this.s.terrain[t];
      const to = next(from, t);
      if (to === from || to == null) continue;
      if (R.isWater(to) && this.at.has(t)) {
        blocked = `${this.settlementAt(t).name} stands there. Use a Deluge to drown a settlement.`;
        continue;
      }
      changes.push([t, to]);
    }
    if (!changes.length) return fail(blocked || what.none);
    const price = this.cost(p, a.type, changes.length);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    for (const [t, to] of changes) this.setTerrain(t, to);
    this.noteShape(
      p,
      changes.map(([t, to]) => [t, what.label(to)]),
    );
    return ok({ cost: price, changed: changes.length });
  }

  doRaise(p, a) {
    return this.shape(p, a, (t) => R.raised(t), {
      none: 'The land here can rise no higher.',
      label: (to) => (to === T.SEA ? 'shoal' : to === T.GRASS ? 'land' : to === T.HILLS ? 'hill' : 'mountain'),
    });
  }

  doLower(p, a) {
    return this.shape(p, a, (t) => R.lowered(t), {
      none: 'The sea here can sink no deeper.',
      label: (to) => (to === T.DEEP ? 'deep' : to === T.SEA ? 'sunk' : to === T.GRASS ? 'plain' : 'wornhill'),
    });
  }

  doBiome(p, a) {
    const b = a.b;
    if (!R.BIOMES.includes(b)) return fail('Pick a biome to paint.');
    return this.shape(p, a, (t) => (R.isFlat(t) ? b : null), {
      none: R.isFlat(this.s.terrain[a.i]) ? 'The land here already looks like that.' : 'Biomes can only cover flat land.',
      label: () => `biome${b}`,
    });
  }

  doRiver(p, a) {
    const s = this.s;
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    if (!R.isLand(s.terrain[i])) return fail('Rivers run over land.');
    let to = a.to;
    if (to === -1 || to === undefined) to = this.riverOutlet(i);
    else if (!this.validTile(to) || this.grid.dirTo(i, to) < 0) return fail('A river flows to a neighbouring tile.');
    const dir = to < 0 ? 6 : this.grid.dirTo(i, to);
    const fresh = [];
    if (s.river[i] === -1) fresh.push(i);
    const extend = to >= 0 && R.isLand(s.terrain[to]) && s.river[to] === -1;
    if (extend) fresh.push(to);
    if (s.river[i] === dir && !extend) return ok({ cost: 0, noop: true });
    const price = this.cost(p, 'river', fresh.length);
    if (fresh.length && !this.charge(p, price)) return this.tooPoor(p, price);
    this.setRiver(i, dir);
    if (extend) this.setRiver(to, 6);
    if (fresh.length) {
      this.noteShape(
        p,
        fresh.map((t) => [t, 'river']),
      );
    }
    return ok({ cost: fresh.length ? price : 0 });
  }

  // Where a river starting at i should go when no direction was given.
  riverOutlet(i) {
    const s = this.s;
    const next = this.grid.neighbors(i);
    const water = next.find((n) => R.isWater(s.terrain[n]));
    if (water !== undefined) return water;
    const joined = next.find((n) => s.river[n] >= 0 && s.river[n] !== 6 && this.grid.neighbor(n, s.river[n]) !== i);
    if (joined !== undefined) return joined;
    let best = -1;
    for (const n of next) {
      if (R.ELEVATION[s.terrain[n]] < R.ELEVATION[s.terrain[i]] && (best < 0 || R.ELEVATION[s.terrain[n]] < R.ELEVATION[s.terrain[best]])) {
        best = n;
      }
    }
    return best;
  }

  doUnriver(p, a) {
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    if (this.s.river[i] === -1) return fail('No river runs here.');
    const price = this.cost(p, 'unriver', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    this.setRiver(i, -1);
    this.noteShape(p, [[i, 'dry']]);
    return ok({ cost: price });
  }

  doName(p, a) {
    const s = this.s;
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    const text = R.cleanText(a.text, R.LIMITS.placeName);
    if (!text) return fail('Write a name first.');
    const existing = Object.values(s.labels).find((l) => l.i === i);
    if (existing) {
      if (existing.god !== p.id) return fail(`${s.players[existing.god]?.name ?? 'Another god'} already named this place.`);
      existing.text = text;
      this.touch('labels', existing.id);
      return ok({ cost: 0 });
    }
    const near = Object.values(s.labels).find((l) => this.grid.distance(l.i, i) <= 2);
    if (near) return fail(`Too close to “${near.text}”. Pick a spot further away.`);
    const price = this.cost(p, 'name', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    const id = s.nextId++;
    s.labels[id] = { id, i, text, god: p.id };
    this.touch('labels', id);
    p.named++;
    this.touch('players', p.id);
    this.log('name', `${p.name} named ${this.featurePhrase(i)} “${text}”.`, { god: p.id, i });
    return ok({ cost: price });
  }

  featurePhrase(i) {
    const t = this.s.terrain[i];
    const where = this.region(i);
    const phrase = {
      [T.DEEP]: 'the deep waters of',
      [T.SEA]: 'the waters of',
      [T.GRASS]: 'the plains of',
      [T.FOREST]: 'a forest in',
      [T.DESERT]: 'a desert in',
      [T.TUNDRA]: 'the frozen lands of',
      [T.SWAMP]: 'a marsh in',
      [T.JUNGLE]: 'a jungle in',
      [T.HILLS]: 'the hills of',
      [T.MOUNTAIN]: 'a mountain range in',
      [T.VOLCANO]: 'a burning mountain in',
      [T.WASTE]: 'the ashlands of',
    }[t];
    if (R.isLand(t) && this.islandSize(i) <= 12) return `an isle in ${where}`;
    return `${phrase} ${where}`;
  }

  islandSize(i, limit = 13) {
    const s = this.s;
    const seen = new Set([i]);
    const queue = [i];
    while (queue.length && seen.size < limit) {
      const cur = queue.pop();
      for (const n of this.grid.neighbors(cur)) {
        if (!seen.has(n) && R.isLand(s.terrain[n])) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen.size;
  }

  doLegend(p, a) {
    const s = this.s;
    const text = R.cleanText(a.text, R.LIMITS.legend);
    if (!text) return fail('Write the legend first.');
    const key = `${s.era}`;
    if (!this.sandbox && p.legendKey === key) return fail('You have already inscribed a legend this round.');
    const extra = { god: p.id };
    if (this.validTile(a.i)) extra.i = a.i;
    p.legendKey = key;
    p.legends++;
    this.touch('players', p.id);
    this.log('legend', text, extra);
    return ok({ cost: 0 });
  }

  doRace(p, a) {
    const s = this.s;
    const i = a.i;
    const arch = R.ARCHETYPES[a.arch];
    if (!arch) return fail('Choose what kind of people to awaken.');
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    if (!R.canSettle(s.terrain[i])) return fail('A people cannot live here.');
    if (!this.canFound(i)) return fail('Too close to another settlement.');
    if (s.owner[i] && s.races[s.owner[i]]?.god !== p.id) return fail(`This land belongs to the ${s.races[s.owner[i]].name}.`);
    if (this.racesOf(p.id).length >= R.LIMITS.racesPerGod) return fail(`A god can watch over at most ${R.LIMITS.racesPerGod} peoples.`);
    const price = this.cost(p, 'race', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    const taken = this.takenNames();
    const name = R.cleanText(a.name, R.LIMITS.entityName) || makeName(this.rng, a.arch, 'folk', taken);
    const id = s.nextId++;
    const shade = [0, 0.28, -0.24][Object.values(s.races).filter((r) => r.god === p.id).length % 3];
    s.races[id] = { id, name, arch: a.arch, god: p.id, color: shadeColor(p.color, shade), born: s.year, alive: true };
    this.touch('races', id);
    const home = this.addSettlement(s.races[id], i, 2);
    this.log(
      'race',
      `${p.name} awoke the ${name}, ${arch.name.toLowerCase()} of ${this.region(i)}, and they built their first village, ${home.name}.`,
      { god: p.id, i },
    );
    return ok({ cost: price });
  }

  addSettlement(race, i, size) {
    const s = this.s;
    const id = s.nextId++;
    const name = makeName(this.rng, race.arch, 'town', this.takenNames());
    s.settlements[id] = { id, name, race: race.id, i, size, born: s.year, wonder: '' };
    this.at.set(i, id);
    this.touch('settlements', id);
    if (s.ruins[i]) this.removeRuin(i);
    this.territoryStale = true;
    return s.settlements[id];
  }

  removeSettlement(st, { ruin = true } = {}) {
    const s = this.s;
    delete s.settlements[st.id];
    this.at.delete(st.i);
    this.touch('settlements', st.id);
    if (ruin && R.isLand(s.terrain[st.i])) {
      s.ruins[st.i] = { i: st.i, name: st.name, era: s.era };
      this.touch('ruins', st.i);
    }
    this.territoryStale = true;
  }

  removeRuin(i) {
    delete this.s.ruins[i];
    this.touch('ruins', i);
  }

  setSize(st, size) {
    if (st.size === size) return;
    st.size = size;
    this.touch('settlements', st.id);
    this.territoryStale = true;
  }

  doCity(p, a) {
    const s = this.s;
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    if (!R.canSettle(s.terrain[i])) return fail('No one can settle here.');
    if (!this.canFound(i)) return fail('Too close to another settlement.');
    const owner = s.owner[i];
    if (owner && s.races[owner]?.god !== p.id) return fail(`This land belongs to the ${s.races[owner].name}.`);
    let best = null;
    for (const race of this.racesOf(p.id)) {
      const arch = R.ARCHETYPES[race.arch];
      const reach = 4 + (arch.sail ? 2 : 0) + (race.arch === 'seafarers' && p.domain === 'sea' ? 1 : 0);
      for (const st of this.settlementsOf(race.id)) {
        const d = this.grid.distance(st.i, i);
        if (d <= reach && (!best || d < best.d)) best = { race, d };
      }
    }
    if (!best) {
      return fail(this.racesOf(p.id).length ? 'Too far from your peoples. Settle within 4 tiles of them.' : 'Awaken a people first.');
    }
    if (this.settlementsOf(best.race.id).length >= R.LIMITS.settlementsPerRace) {
      return fail(`The ${best.race.name} cannot hold more settlements.`);
    }
    const price = this.cost(p, 'city', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    const st = this.addSettlement(best.race, i, 1);
    this.log('city', `Guided by ${p.name}, the ${best.race.name} founded ${st.name} in ${this.region(i)}.`, { god: p.id, i });
    return ok({ cost: price });
  }

  targetSettlement(a) {
    if (!this.validTile(a.i)) return null;
    return this.settlementAt(a.i);
  }

  doBless(p, a) {
    const st = this.targetSettlement(a);
    if (!st) return fail('Pick a settlement to bless.');
    const race = this.raceOf(st);
    const max = R.ARCHETYPES[race.arch].maxSize;
    if (st.size >= max) return fail(`${st.name} cannot grow any larger.`);
    const price = this.cost(p, 'bless', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    this.setSize(st, st.size + 1);
    const whose = race.god === p.id ? '' : ` of the ${race.name}`;
    this.log('bless', `${p.name} blessed ${st.name}${whose} with plenty, and it grew into a ${R.SIZE_NAMES[st.size].toLowerCase()}.`, {
      god: p.id,
      i: st.i,
    });
    return ok({ cost: price });
  }

  wonderAllowed(st, key) {
    const s = this.s;
    const around = this.grid.within(st.i, 1);
    const has = (t) => around.some((n) => s.terrain[n] === t);
    switch (key) {
      case 'library':
        return st.size >= 3;
      case 'colossus':
        return st.size >= 2 && this.coastal(st.i);
      case 'skytemple':
        return has(T.MOUNTAIN) || has(T.VOLCANO);
      case 'worldtree':
        return around.filter((n) => s.terrain[n] === T.FOREST || s.terrain[n] === T.JUNGLE).length >= 2;
      case 'gardens':
        return s.river[st.i] !== -1;
      case 'pyramid':
        return has(T.DESERT);
      case 'frostspire':
        return has(T.TUNDRA);
      case 'arena':
        return st.size >= 4;
      default:
        return false;
    }
  }

  doWonder(p, a) {
    const s = this.s;
    const key = a.w;
    const def = R.WONDERS[key];
    if (!def) return fail('Choose a wonder to raise.');
    const st = this.targetSettlement(a);
    if (!st) return fail('Pick one of your settlements.');
    const race = this.raceOf(st);
    if (race.god !== p.id) return fail(`${st.name} belongs to another god's people.`);
    const built = Object.values(s.settlements).find((x) => x.wonder === key);
    if (built) return fail(`${def.name} already stands in ${built.name}.`);
    if (st.wonder) return fail(`${st.name} already has ${R.WONDERS[st.wonder].name}.`);
    if (!this.wonderAllowed(st, key)) return fail(`${def.name} needs ${def.need.charAt(0).toLowerCase()}${def.need.slice(1)}`);
    const price = this.cost(p, 'wonder', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    st.wonder = key;
    this.touch('settlements', st.id);
    this.log('wonder', `The ${race.name} raised ${def.name} in ${st.name}, a gift of ${p.name}.`, { god: p.id, i: st.i });
    return ok({ cost: price });
  }

  doWar(p, a) {
    const s = this.s;
    const st = this.targetSettlement(a);
    if (!st) return fail('Pick a settlement of the people to attack.');
    const foe = this.raceOf(st);
    if (foe.god === p.id) return fail('Pick a settlement of another god’s people.');
    let best = null;
    for (const race of this.racesOf(p.id)) {
      for (const own of this.settlementsOf(race.id)) {
        const d = this.grid.distance(own.i, st.i);
        if (d <= 6 && (!best || d < best.d)) best = { race, d };
      }
    }
    if (!best) return fail(`None of your peoples live near enough to march on ${st.name}.`);
    const key = relKey(best.race.id, foe.id);
    if (s.relations[key]?.state === 'war') return fail(`The ${best.race.name} are already at war with the ${foe.name}.`);
    const price = this.cost(p, 'war', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    this.setRelation(key, 'war');
    this.log('war', `${p.name} stirred the ${best.race.name} to war against the ${foe.name}.`, { god: p.id, i: st.i });
    return ok({ cost: price });
  }

  doPeace(p, a) {
    const s = this.s;
    const st = this.targetSettlement(a);
    if (!st) return fail('Pick a settlement of the people to pacify.');
    const race = this.raceOf(st);
    const wars = Object.entries(s.relations).filter(([key, rel]) => rel.state === 'war' && key.split('|').map(Number).includes(race.id));
    if (!wars.length) return fail(`The ${race.name} are not at war.`);
    const price = this.cost(p, 'peace', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    const foes = [];
    for (const [key] of wars) {
      const other = key.split('|').map(Number).find((id) => id !== race.id);
      foes.push(`the ${s.races[other]?.name}`);
      this.setRelation(key, null);
    }
    this.log('peace', `${p.name} brokered peace between the ${race.name} and ${listJoin(foes)}.`, { god: p.id, i: st.i });
    return ok({ cost: price });
  }

  setRelation(key, state) {
    const s = this.s;
    if (!state) {
      if (!s.relations[key]) return;
      delete s.relations[key];
    } else {
      if (s.relations[key]?.state === state) return;
      s.relations[key] = { state, since: s.era };
    }
    this.touch('relations', key);
  }

  // Shrinks a settlement by `by`; one that reaches nothing becomes ruins.
  harm(st, by) {
    const size = st.size - by;
    if (size <= 0) {
      this.removeSettlement(st);
      return true;
    }
    this.setSize(st, size);
    return false;
  }

  doErupt(p, a) {
    const s = this.s;
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    if (!R.isLand(s.terrain[i])) return fail('A volcano must break through land.');
    if (s.terrain[i] === T.VOLCANO) return fail('That volcano is already burning.');
    const price = this.cost(p, 'erupt', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    const lost = [];
    const hurt = [];
    for (const t of this.grid.within(i, 1)) {
      const st = this.settlementAt(t);
      if (st) (this.harm(st, t === i ? 99 : 2) ? lost : hurt).push(st.name);
      if (t === i) this.setTerrain(t, T.VOLCANO);
      else if (R.isFlat(s.terrain[t])) this.setTerrain(t, T.WASTE);
    }
    let text = `In ${p.name}'s wrath, a volcano tore open the land in ${this.region(i)}`;
    if (lost.length) text += `, burying ${listJoin(lost)} in ash`;
    if (hurt.length) text += `${lost.length ? ' and scorching' : ', scorching'} ${listJoin(hurt)}`;
    this.log('wrath', `${text}.`, { god: p.id, i });
    return ok({ cost: price });
  }

  doFlood(p, a) {
    const s = this.s;
    const i = a.i;
    if (!this.validTile(i)) return fail('Pick a place on the map.');
    const tiles = this.grid.within(i, 1).filter((t) => R.isFlat(s.terrain[t]) || s.terrain[t] === T.HILLS);
    if (!tiles.some((t) => R.isFlat(s.terrain[t]))) return fail('A deluge needs lowlands to drown.');
    const price = this.cost(p, 'flood', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    const drowned = [];
    const hurt = [];
    const sink = tiles.filter((t) => R.isFlat(s.terrain[t]) && this.coastal(t));
    for (const t of tiles) {
      const st = this.settlementAt(t);
      if (sink.includes(t)) {
        if (st) {
          drowned.push(st.name);
          this.removeSettlement(st, { ruin: false });
        }
        this.setTerrain(t, T.SEA);
      } else {
        if (R.isFlat(s.terrain[t])) this.setTerrain(t, T.SWAMP);
        if (st) (this.harm(st, 1) ? drowned : hurt).push(st.name);
      }
    }
    let text = `${p.name} sent a deluge over ${this.region(i)}`;
    if (drowned.length) text += `; ${listJoin(drowned)} ${drowned.length === 1 ? 'was' : 'were'} lost beneath the waters`;
    if (hurt.length) text += `${drowned.length ? ', and' : ';'} ${listJoin(hurt)} barely survived`;
    this.log('wrath', `${text}.`, { god: p.id, i });
    return ok({ cost: price });
  }

  doPlague(p, a) {
    const st = this.targetSettlement(a);
    if (!st) return fail('Pick a settlement of the people to strike.');
    const race = this.raceOf(st);
    const price = this.cost(p, 'plague', 1);
    if (!this.charge(p, price)) return this.tooPoor(p, price);
    for (const x of this.settlementsOf(race.id)) if (x.size > 1) this.setSize(x, x.size - 1);
    this.log('wrath', `${p.name} loosed a plague upon the ${race.name}, and every one of their settlements dwindled.`, {
      god: p.id,
      i: st.i,
    });
    return ok({ cost: price });
  }

  doRename(p, a) {
    const s = this.s;
    const kind = a.kind;
    const id = a.id;
    if (kind === 'race') {
      const race = s.races[id];
      if (!race || race.god !== p.id) return fail('You can only rename your own peoples.');
      const text = R.cleanText(a.text, R.LIMITS.entityName);
      if (!text) return fail('Write a name first.');
      race.name = text;
      this.touch('races', id);
    } else if (kind === 'settlement') {
      const st = s.settlements[id];
      if (!st || s.races[st.race]?.god !== p.id) return fail('You can only rename your own settlements.');
      const text = R.cleanText(a.text, R.LIMITS.entityName);
      if (!text) return fail('Write a name first.');
      st.name = text;
      this.touch('settlements', id);
    } else if (kind === 'label') {
      const label = s.labels[id];
      if (!label || label.god !== p.id) return fail('You can only change names you gave.');
      const text = R.cleanText(a.text, R.LIMITS.placeName);
      if (text) label.text = text;
      else {
        delete s.labels[id];
        p.named = Math.max(0, p.named - 1);
        this.touch('players', p.id);
      }
      this.touch('labels', id);
    } else {
      return fail('Unknown thing to rename.');
    }
    return ok({ cost: 0 });
  }

  // ------------------------------------------------ rounds

  endRound() {
    const s = this.s;
    if (s.phase !== 'playing') return;
    this.summarizeShaping();
    this.simulate();
    s.era++;
    s.year += 100;
    if (!this.sandbox) {
      if (s.round < s.settings.roundsPerAge) {
        s.round++;
      } else if (s.age < 3) {
        s.age++;
        s.round = 1;
        this.log('age', `${R.AGES[s.age - 1].name} began. ${R.AGES[s.age - 1].blurb.split('.')[0]}.`);
      } else {
        this.finish();
        return;
      }
    } else {
      s.round++;
    }
    for (const p of this.activePlayers()) {
      p.pp = Math.min(R.LIMITS.powerCap, p.pp + this.income(p));
      p.ready = false;
      this.touch('players', p.id);
    }
    this.markMeta();
  }

  finish() {
    const s = this.s;
    if (s.phase === 'ended') return;
    if (s.phase === 'playing') this.summarizeShaping();
    s.phase = 'ended';
    for (const p of Object.values(s.players)) {
      if (p.ready) {
        p.ready = false;
        this.touch('players', p.id);
      }
    }
    const scores = computeScores(s);
    const ranked = Object.entries(scores).sort((a, b) => b[1].legacy - a[1].legacy);
    if (ranked.length && !this.sandbox) {
      const [id, score] = ranked[0];
      const tied = ranked.filter(([, sc]) => sc.legacy === score.legacy).map(([pid]) => s.players[pid].name);
      const who = tied.length > 1 ? `${listJoin(tied)} were remembered equally` : `${s.players[id].name} was remembered above all other gods`;
      const complete = s.age === 3 && s.round >= s.settings.roundsPerAge;
      const how = complete ? `So ended the three Ages of ${s.settings.worldName}.` : `The gods brought ${s.settings.worldName} to an end in ${R.AGES[s.age - 1].name}.`;
      this.log('end', `${how} ${who}, with a legacy of ${score.legacy}.`);
    } else {
      this.log('end', `The gods of ${s.settings.worldName} laid down their work, and the world turned on without them.`);
    }
    this.markMeta();
  }

  summarizeShaping() {
    const s = this.s;
    const verbs = {
      shoal: ['raised', 'shoal from the deep', 'shoals from the deep'],
      land: ['raised', 'land from the sea', 'lands from the sea'],
      hill: ['heaped up', 'hill', 'hills'],
      mountain: ['piled up', 'mountain', 'mountains'],
      deep: ['deepened', 'stretch of sea', 'stretches of sea'],
      sunk: ['sank', 'land beneath the waves', 'lands beneath the waves'],
      plain: ['levelled', 'hill into plain', 'hills into plain'],
      wornhill: ['wore down', 'mountain', 'mountains'],
      [`biome${T.GRASS}`]: ['greened', 'plain', 'plains'],
      [`biome${T.FOREST}`]: ['planted', 'forest', 'forests'],
      [`biome${T.DESERT}`]: ['spread', 'desert', 'deserts'],
      [`biome${T.TUNDRA}`]: ['froze', 'land', 'lands'],
      [`biome${T.SWAMP}`]: ['soaked', 'marsh', 'marshes'],
      [`biome${T.JUNGLE}`]: ['grew', 'jungle', 'jungles'],
      river: ['carved rivers across', 'land', 'lands'],
      dry: ['dried up', 'river', 'rivers'],
    };
    for (const [pid, rec] of this.shaping) {
      const p = s.players[pid];
      if (!p || !rec.n) continue;
      const parts = Object.entries(rec.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([what, n]) => {
          const [verb, one, many] = verbs[what] ?? ['shaped', 'land', 'lands'];
          return `${verb} ${count(n, one, many)}`;
        });
      const cx = Math.round(rec.xs / rec.n);
      const cy = Math.round(rec.ys / rec.n);
      const centre = cy * s.W + cx;
      let spread = 0;
      for (const t of rec.tiles) spread += this.grid.distance(t, centre);
      spread /= rec.tiles.length;
      const where = spread > Math.max(s.W, s.H) / 5 ? 'across the world' : `in ${this.region(centre)}`;
      this.log('shape', `${p.name} ${listJoin(parts)} ${where}.`, { god: p.id, i: centre });
    }
    this.shaping.clear();
  }

  // ------------------------------------------------ simulation

  simulate() {
    const s = this.s;
    const rng = this.rng;
    for (let i = 0; i < this.grid.N; i++) {
      if (s.terrain[i] === T.WASTE && rng.chance(0.25)) this.setTerrain(i, T.GRASS);
      else if (s.terrain[i] === T.VOLCANO && rng.chance(0.12)) this.setTerrain(i, T.MOUNTAIN);
    }
    this.recomputeTerritory();
    this.updateRelations();
    this.recomputeTerritory();
    const events = new Map();
    const note = (race, kind, st) => {
      if (!events.has(race.id)) events.set(race.id, { founded: [], grew: [], shrank: [], lost: [] });
      events.get(race.id)[kind].push(st);
    };
    this.grow(note);
    this.expand(note);
    this.recomputeTerritory();
    for (const [raceId, ev] of events) {
      const race = s.races[raceId];
      if (!race) continue;
      const names = (list) => {
        const shown = list.slice(0, 3).map((st) => st.name);
        if (list.length > 3) shown.push(`${count(list.length - 3, 'other', 'others')}`);
        return listJoin(shown);
      };
      const clauses = [];
      for (let size = 5; size >= 3; size--) {
        const grew = ev.grew.filter((st) => st.size === size);
        if (!grew.length) continue;
        const into = grew.length === 1 ? `a ${R.SIZE_NAMES[size].toLowerCase()}` : R.SIZE_PLURALS[size];
        clauses.push(`${names(grew)} grew into ${into}`);
      }
      if (ev.shrank.length) clauses.push(`${names(ev.shrank)} dwindled`);
      if (ev.lost.length) clauses.push(`${names(ev.lost)} ${ev.lost.length === 1 ? 'was' : 'were'} abandoned`);
      let text;
      if (ev.founded.length) text = [`The ${race.name} founded ${names(ev.founded)}`, ...clauses].join('; ');
      else if (clauses.length) text = `Among the ${race.name}, ${clauses.join('; ')}`;
      else continue;
      const where = ev.founded[0] ?? ev.grew[0] ?? ev.shrank[0];
      this.log('people', `${text}.`, { god: race.god, i: where?.i });
    }
    this.checkExtinctions();
  }

  habitat(st, race = this.raceOf(st)) {
    const s = this.s;
    let h = this.siteHabitat(st.i, race);
    if (st.wonder) h += 3;
    for (const [key, rel] of Object.entries(s.relations)) {
      if (rel.state === 'trade' && key.split('|').map(Number).includes(race.id)) {
        h += 2;
        break;
      }
    }
    const domain = s.players[race.god]?.domain;
    if (domain === 'hearth' || domain === 'life') h += 1;
    for (const n of this.grid.within(st.i, 2)) {
      if (n !== st.i && this.at.has(n)) h -= 1;
    }
    return h;
  }

  siteHabitat(i, race) {
    const s = this.s;
    const arch = R.ARCHETYPES[race.arch];
    let h = 0;
    let nearRiver = false;
    for (const t of this.grid.within(i, 1)) {
      h += arch.hab[s.terrain[t]];
      if (t !== i && s.river[t] !== -1) nearRiver = true;
    }
    if (s.river[i] !== -1) h += arch.river;
    else if (nearRiver) h += 1;
    return h;
  }

  grow(note) {
    const s = this.s;
    const rng = this.rng;
    for (const st of Object.values(s.settlements)) {
      const race = this.raceOf(st);
      const arch = R.ARCHETYPES[race.arch];
      const h = this.habitat(st, race);
      if (st.size < arch.maxSize && h >= R.GROW_NEED[st.size] && rng.chance(0.45)) {
        this.setSize(st, st.size + 1);
        if (st.size >= 3) note(race, 'grew', st);
      } else if (h < R.SUPPORT[st.size] && st.born < s.year && rng.chance(0.4)) {
        if (this.harm(st, 1)) note(race, 'lost', st);
        else if (st.size >= 2) note(race, 'shrank', st);
      }
    }
  }

  expand(note) {
    const s = this.s;
    const rng = this.rng;
    for (const race of Object.values(s.races)) {
      if (!race.alive) continue;
      const arch = R.ARCHETYPES[race.arch];
      const own = this.settlementsOf(race.id).sort((a, b) => b.size - a.size || a.id - b.id);
      let room = R.LIMITS.settlementsPerRace - own.length;
      let quota = 1 + Math.floor(own.length / 5);
      for (const st of own) {
        if (room <= 0 || quota <= 0) break;
        if (st.size < 2) continue;
        if (!rng.chance((0.1 + 0.07 * st.size) * arch.expand)) continue;
        const site = this.findSite(st, race);
        if (site < 0) continue;
        const fresh = this.addSettlement(race, site, 1);
        note(race, 'founded', fresh);
        this.recomputeTerritory();
        room--;
        quota--;
      }
    }
  }

  // The best free site a settlement's people could reach and live on, or -1.
  findSite(st, race) {
    const s = this.s;
    const arch = R.ARCHETYPES[race.arch];
    const sail = arch.sail ? arch.sail + (s.players[race.god]?.domain === 'sea' ? 1 : 0) : 0;
    const range = Math.max(arch.range, sail);
    // Walk outward: over land for everyone, over water too for sailors.
    const dist = new Map([[st.i, 0]]);
    const queue = [st.i];
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      const d = dist.get(cur);
      if (d >= range) continue;
      for (const n of this.grid.neighbors(cur)) {
        if (dist.has(n)) continue;
        const water = R.isWater(s.terrain[n]);
        if (water && !sail) continue;
        if (!water && !sail && d + 1 > arch.range) continue;
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
    let best = -1;
    let bestScore = -Infinity;
    for (const [t, d] of dist) {
      if (d < 2 || !this.canFound(t)) continue;
      if (d > arch.range && !this.coastal(t)) continue;
      if (s.owner[t] && s.owner[t] !== race.id) continue;
      const score = this.siteHabitat(t, race) + this.rng.next() * 3 - (d > arch.range ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return bestScore >= 7 ? best : -1;
  }

  // Races whose territories touch, as relation keys.
  borders() {
    const s = this.s;
    const pairs = new Set();
    for (let i = 0; i < this.grid.N; i++) {
      const a = s.owner[i];
      if (!a) continue;
      for (let d = 0; d < 3; d++) {
        const n = this.grid.neighbor(i, d);
        if (n < 0) continue;
        const b = s.owner[n];
        if (b && b !== a) pairs.add(relKey(a, b));
      }
    }
    // Neighbours across a strait count too.
    const list = Object.values(s.settlements);
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        if (list[x].race !== list[y].race && this.grid.distance(list[x].i, list[y].i) <= 3) pairs.add(relKey(list[x].race, list[y].race));
      }
    }
    return pairs;
  }

  updateRelations() {
    const s = this.s;
    const rng = this.rng;
    const pairs = this.borders();
    for (const [key, rel] of Object.entries(s.relations)) {
      if (pairs.has(key)) continue;
      if (rel.state === 'war' ? rng.chance(0.5) : rng.chance(0.25)) this.setRelation(key, null);
    }
    for (const key of [...pairs].sort()) {
      const [a, b] = key.split('|').map(Number);
      const A = s.races[a];
      const B = s.races[b];
      if (!A?.alive || !B?.alive) continue;
      const temper = (R.ARCHETYPES[A.arch].temper + R.ARCHETYPES[B.arch].temper) / 2;
      const rel = s.relations[key];
      if (!rel) {
        const roll = rng.next();
        const war = 0.03 + temper * 0.1;
        if (roll < war) {
          this.setRelation(key, 'war');
          this.log('war', `Old grudges boiled over, and the ${A.name} and the ${B.name} went to war.`, { i: this.frontTile(A, B) });
        } else if (roll < war + 0.14) {
          this.setRelation(key, 'trade');
          this.log('trade', `The ${A.name} and the ${B.name} opened roads of trade between them.`, { i: this.frontTile(A, B) });
        }
      } else if (rel.state === 'trade') {
        if (rng.chance(0.02 + temper * 0.05)) {
          this.setRelation(key, 'war');
          this.log('war', `Trade between the ${A.name} and the ${B.name} soured into war.`, { i: this.frontTile(A, B) });
        } else if (rng.chance(0.08)) {
          this.setRelation(key, null);
        }
      } else if (rel.state === 'war') {
        this.battle(A, B);
        if (!s.relations[key]) continue;
        const length = s.era - rel.since;
        if (rng.chance(0.2 + 0.08 * length)) {
          this.setRelation(key, null);
          this.log('peace', `Weary of war, the ${A.name} and the ${B.name} made peace.`, { i: this.frontTile(A, B) });
        }
      }
    }
  }

  front(A, B) {
    let best = null;
    for (const sa of this.settlementsOf(A.id)) {
      for (const sb of this.settlementsOf(B.id)) {
        const d = this.grid.distance(sa.i, sb.i);
        if (!best || d < best.d) best = { sa, sb, d };
      }
    }
    return best;
  }

  frontTile(A, B) {
    const f = this.front(A, B);
    return f ? f.sb.i : undefined;
  }

  battle(A, B) {
    const s = this.s;
    const rng = this.rng;
    const f = this.front(A, B);
    if (!f || f.d > 6) return;
    const strength = (st, race) => {
      let v = st.size + rng.int(4) + R.ARCHETYPES[race.arch].might;
      if (s.players[race.god]?.domain === 'war') v += 1;
      if (s.terrain[st.i] === T.HILLS || s.terrain[st.i] === T.MOUNTAIN) v += 1;
      return v;
    };
    const a = strength(f.sa, A);
    const b = strength(f.sb, B);
    if (a === b) return;
    const [win, lose, winRace, loseRace] = a > b ? [f.sa, f.sb, A, B] : [f.sb, f.sa, B, A];
    if (lose.size > 1) {
      this.setSize(lose, lose.size - 1);
      if (lose.size >= 2) this.log('battle', `The ${winRace.name} besieged ${lose.name} of the ${loseRace.name}.`, { i: lose.i });
      return;
    }
    if (win.size >= 2 && rng.chance(0.6)) {
      lose.race = winRace.id;
      this.touch('settlements', lose.id);
      this.territoryStale = true;
      const prize = lose.wonder ? `, and ${R.WONDERS[lose.wonder].name} with it` : '';
      this.log('capture', `The ${winRace.name} captured ${lose.name} from the ${loseRace.name}${prize}.`, { god: winRace.god, i: lose.i });
    } else {
      this.removeSettlement(lose);
      this.log('raze', `The ${winRace.name} razed ${lose.name} of the ${loseRace.name}; only ruins remain.`, { god: winRace.god, i: lose.i });
    }
  }

  checkExtinctions() {
    const s = this.s;
    for (const race of Object.values(s.races)) {
      if (!race.alive || this.settlementsOf(race.id).length) continue;
      race.alive = false;
      this.touch('races', race.id);
      for (const key of Object.keys(s.relations)) if (key.split('|').map(Number).includes(race.id)) this.setRelation(key, null);
      this.log('fall', `The last of the ${race.name} vanished from the world.`, { god: race.god });
    }
  }

  // Also runs after actions; the ruins of a captured or razed settlement can
  // leave a race with nothing, which checkExtinctions catches at the next era.
  recomputeTerritory() {
    const s = this.s;
    const N = this.grid.N;
    const bestDist = new Float64Array(N).fill(Infinity);
    const bestSize = new Int8Array(N);
    const bestId = new Int32Array(N);
    const owner = new Int32Array(N);
    for (const st of Object.values(s.settlements)) {
      const radius = R.CLAIM[st.size];
      for (const t of this.grid.within(st.i, radius)) {
        if (R.isWater(s.terrain[t])) continue;
        const d = t === st.i ? 0 : this.grid.distance(st.i, t);
        const better =
          d < bestDist[t] || (d === bestDist[t] && (st.size > bestSize[t] || (st.size === bestSize[t] && st.id < bestId[t])));
        if (better) {
          bestDist[t] = d;
          bestSize[t] = st.size;
          bestId[t] = st.id;
          owner[t] = st.race;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      if (s.owner[i] !== owner[i]) {
        s.owner[i] = owner[i];
        this.dirty.tiles.add(i);
      }
    }
    this.territoryStale = false;
  }
}

const HANDLERS = {
  raise: Game.prototype.doRaise,
  lower: Game.prototype.doLower,
  biome: Game.prototype.doBiome,
  river: Game.prototype.doRiver,
  unriver: Game.prototype.doUnriver,
  name: Game.prototype.doName,
  legend: Game.prototype.doLegend,
  race: Game.prototype.doRace,
  city: Game.prototype.doCity,
  bless: Game.prototype.doBless,
  wonder: Game.prototype.doWonder,
  war: Game.prototype.doWar,
  peace: Game.prototype.doPeace,
  erupt: Game.prototype.doErupt,
  flood: Game.prototype.doFlood,
  plague: Game.prototype.doPlague,
};

// Rename is free and always possible, so it is not a costed deed in ACTIONS.
Game.prototype.rename = function rename(pid, a) {
  const p = this.s.players[pid];
  if (!p || p.spectator) return fail('Spectators can only watch.');
  return this.doRename(p, a);
};

// Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour.
export function shadeColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

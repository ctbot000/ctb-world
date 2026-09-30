// The rules as data: terrain, peoples, domains, wonders, actions, ages and the
// limits every host enforces. Shared by the engine, the server and the client.

export const T = Object.freeze({
  DEEP: 0,
  SEA: 1,
  GRASS: 2,
  FOREST: 3,
  DESERT: 4,
  TUNDRA: 5,
  SWAMP: 6,
  JUNGLE: 7,
  HILLS: 8,
  MOUNTAIN: 9,
  VOLCANO: 10,
  WASTE: 11,
});

export const TERRAIN = [
  { key: 'deep', name: 'Deep Ocean', color: '#1d4c79' },
  { key: 'sea', name: 'Shallow Sea', color: '#3a7db6' },
  { key: 'grass', name: 'Grassland', color: '#94c263' },
  { key: 'forest', name: 'Forest', color: '#5d9449' },
  { key: 'desert', name: 'Desert', color: '#e7d292' },
  { key: 'tundra', name: 'Tundra', color: '#dde6e9' },
  { key: 'swamp', name: 'Swamp', color: '#6e8e62' },
  { key: 'jungle', name: 'Jungle', color: '#3f8b41' },
  { key: 'hills', name: 'Hills', color: '#b5ab6b' },
  { key: 'mountain', name: 'Mountains', color: '#91877e' },
  { key: 'volcano', name: 'Volcano', color: '#5e4b45' },
  { key: 'waste', name: 'Ashen Waste', color: '#8d8782' },
];

export const TERRAIN_COUNT = TERRAIN.length;
export const isWater = (t) => t === T.DEEP || t === T.SEA;
export const isLand = (t) => t >= T.GRASS;
export const isFlat = (t) => (t >= T.GRASS && t <= T.JUNGLE) || t === T.WASTE;
export const isPeak = (t) => t === T.MOUNTAIN || t === T.VOLCANO;
export const canSettle = (t) => isLand(t) && t !== T.VOLCANO && t !== T.WASTE;

// Paintable covers for flat land, in palette order.
export const BIOMES = [T.GRASS, T.FOREST, T.DESERT, T.TUNDRA, T.SWAMP, T.JUNGLE];

// Height order used for river flow: deep sea, sea, flat land, hills, peaks.
export const ELEVATION = [-2, -1, 0, 0, 0, 0, 0, 0, 1, 2, 2, 0];

export function raised(t) {
  if (t === T.DEEP) return T.SEA;
  if (t === T.SEA) return T.GRASS;
  if (isFlat(t)) return T.HILLS;
  if (t === T.HILLS) return T.MOUNTAIN;
  return t;
}

export function lowered(t) {
  if (isPeak(t)) return T.HILLS;
  if (t === T.HILLS) return T.GRASS;
  if (isFlat(t)) return T.SEA;
  if (t === T.SEA) return T.DEEP;
  return t;
}

// Peoples. `hab` scores every terrain (indexed by terrain code) from 0 to 3
// for how well it feeds them; a settlement adds up its own tile and its six
// neighbours. `river` is the bonus for living on a river.
//                       deep sea grass forest desert tundra swamp jungle hills mount volc waste
export const ARCHETYPES = {
  plainsfolk: {
    name: 'Plainsfolk',
    icon: '🌾',
    blurb: 'Farmers of open grassland and river valleys.',
    hab: [0, 1, 3, 1, 0, 0, 1, 1, 1, 0, 0, 0],
    river: 2,
    expand: 1.0,
    range: 3,
    maxSize: 5,
    temper: 0.3,
    might: 0,
  },
  seafarers: {
    name: 'Seafarers',
    icon: '⛵',
    blurb: 'Fisherfolk and sailors who cross the sea to settle distant shores.',
    hab: [1, 2, 2, 1, 0, 0, 1, 1, 1, 0, 0, 0],
    river: 1,
    expand: 1.1,
    range: 3,
    sail: 5,
    maxSize: 5,
    temper: 0.3,
    might: 0,
  },
  highlanders: {
    name: 'Highlanders',
    icon: '⛏️',
    blurb: 'Miners and masons who thrive in hills and mountains.',
    hab: [0, 0, 1, 1, 0, 1, 0, 0, 3, 3, 1, 0],
    river: 1,
    expand: 0.85,
    range: 3,
    maxSize: 5,
    temper: 0.5,
    might: 1,
  },
  sylvan: {
    name: 'Sylvan',
    icon: '🍃',
    blurb: 'Quiet woodfolk of forest, jungle and marsh.',
    hab: [0, 1, 1, 3, 0, 0, 2, 3, 1, 0, 0, 0],
    river: 1,
    expand: 0.9,
    range: 3,
    maxSize: 5,
    temper: 0.2,
    might: 0,
  },
  nomads: {
    name: 'Nomads',
    icon: '🐎',
    blurb: 'Riders of desert and steppe. They spread fast and love a fight, but never build great cities.',
    hab: [0, 0, 2, 0, 3, 1, 0, 0, 1, 0, 0, 0],
    river: 2,
    expand: 1.4,
    range: 4,
    maxSize: 4,
    temper: 0.8,
    might: 1,
  },
  frostkin: {
    name: 'Frostkin',
    icon: '❄️',
    blurb: 'Hardy hunters of the frozen north and the cold coasts.',
    hab: [1, 1, 1, 1, 0, 3, 0, 0, 2, 1, 0, 0],
    river: 1,
    expand: 0.9,
    range: 3,
    maxSize: 5,
    temper: 0.5,
    might: 1,
  },
};

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

// Every god belongs to a domain, which makes some deeds cheaper (`mult`).
export const DOMAINS = {
  earth: { name: 'Stone', icon: '⛰️', perk: 'Raising and lowering land costs half.', mult: { raise: 0.5, lower: 0.5 } },
  sea: {
    name: 'Tides',
    icon: '🌊',
    perk: 'Rivers and deluges cost half, and your Seafarers sail farther.',
    mult: { river: 0.5, unriver: 0.5, flood: 0.5 },
  },
  life: {
    name: 'Wilds',
    icon: '🌿',
    perk: 'Painting biomes and blessing cost half, and your peoples grow faster.',
    mult: { biome: 0.5, bless: 0.5 },
  },
  hearth: {
    name: 'Hearth',
    icon: '🔥',
    perk: 'Peoples, settlements and wonders cost less, and your settlements grow faster.',
    mult: { race: 0.8, city: 0.6, wonder: 0.75 },
  },
  war: {
    name: 'Storms',
    icon: '⚡',
    perk: 'War and wrath cost half, and your peoples fight harder.',
    mult: { war: 0.5, erupt: 0.5, plague: 0.5 },
  },
  wisdom: {
    name: 'Stars',
    icon: '✨',
    perk: '+2 power every round. Naming places is free, and each legend adds legacy.',
    mult: { name: 0 },
  },
};

export const DOMAIN_KEYS = Object.keys(DOMAINS);

export const WONDERS = {
  library: { name: 'The Great Library', icon: '📚', need: 'A town or larger (size 3+).' },
  colossus: { name: 'The Colossus', icon: '🗿', need: 'A coastal village or larger.' },
  skytemple: { name: 'The Sky Temple', icon: '⛩️', need: 'A settlement on or beside mountains.' },
  worldtree: { name: 'The World Tree', icon: '🌳', need: 'A settlement touching two forest or jungle tiles.' },
  gardens: { name: 'The Hanging Gardens', icon: '🌺', need: 'A settlement on a river.' },
  pyramid: { name: 'The Sun Pyramid', icon: '🔺', need: 'A settlement on or beside desert.' },
  frostspire: { name: 'The Frost Spire', icon: '🧊', need: 'A settlement on or beside tundra.' },
  arena: { name: 'The Grand Arena', icon: '🏟️', need: 'A city or larger (size 4+).' },
};

export const WONDER_KEYS = Object.keys(WONDERS);

// Costs are in power, one entry per Age; null means "not yet possible".
// Shaping deeds cost that much per tile they change.
export const ACTIONS = {
  raise: {
    name: 'Raise Land',
    icon: '⛰️',
    group: 'shape',
    cost: [1, 2, 3],
    perTile: true,
    brush: true,
    help: 'Lift the sea into land, land into hills and hills into mountains.',
  },
  lower: {
    name: 'Lower Land',
    icon: '🕳️',
    group: 'shape',
    cost: [1, 2, 3],
    perTile: true,
    brush: true,
    help: 'Wear mountains down into hills and sink the lowlands beneath the sea.',
  },
  biome: {
    name: 'Paint Biome',
    icon: '🎨',
    group: 'shape',
    cost: [1, 2, 3],
    perTile: true,
    brush: true,
    help: 'Cover flat land with grass, forest, desert, tundra, swamp or jungle.',
  },
  river: {
    name: 'Carve River',
    icon: '〰️',
    group: 'shape',
    cost: [1, 2, 3],
    perTile: true,
    help: 'Drag across the land to carve a river. Tap an existing river to dry it up.',
  },
  unriver: { name: 'Dry Up River', icon: '〰️', group: 'shape', cost: [1, 2, 3], perTile: true, hidden: true, help: '' },
  name: {
    name: 'Name a Place',
    icon: '🏷️',
    group: 'lore',
    cost: [1, 1, 1],
    help: 'Give a mountain, sea, forest or isle a name that appears on the map.',
  },
  legend: {
    name: 'Inscribe Legend',
    icon: '📜',
    group: 'lore',
    cost: [0, 0, 0],
    help: 'Write a line of myth into the Chronicle. Free, once per round.',
  },
  race: {
    name: 'Awaken a People',
    icon: '👥',
    group: 'peoples',
    cost: [null, 10, 12],
    help: 'Create a new people and their first village. They grow and spread on their own.',
  },
  city: {
    name: 'Found Settlement',
    icon: '🏠',
    group: 'peoples',
    cost: [null, 5, 4],
    help: 'Found a hamlet for your people, within reach of their other settlements.',
  },
  bless: { name: 'Bless', icon: '✨', group: 'peoples', cost: [null, 4, 3], help: 'Make any settlement grow by one size.' },
  wonder: {
    name: 'Raise a Wonder',
    icon: '🏛️',
    group: 'peoples',
    cost: [null, 10, 8],
    help: 'Build one of eight unique wonders in one of your settlements.',
  },
  war: {
    name: 'Incite War',
    icon: '⚔️',
    group: 'strife',
    cost: [null, 6, 5],
    help: 'Drive your nearest people to war against the people of the settlement you pick.',
  },
  peace: { name: 'Broker Peace', icon: '🕊️', group: 'strife', cost: [null, 5, 4], help: 'End every war the chosen people is fighting.' },
  erupt: {
    name: 'Eruption',
    icon: '🌋',
    group: 'wrath',
    wrath: true,
    cost: [null, 7, 6],
    help: 'A volcano bursts from the land and buries everything around it in ash.',
  },
  flood: {
    name: 'Deluge',
    icon: '🌊',
    group: 'wrath',
    wrath: true,
    cost: [null, 6, 5],
    help: 'The sea swallows the coast and the lowlands turn to swamp.',
  },
  plague: {
    name: 'Plague',
    icon: '☠️',
    group: 'wrath',
    wrath: true,
    cost: [null, 8, 7],
    help: 'Every settlement of the chosen people shrinks by one size.',
  },
};

export const AGES = [
  {
    name: 'The Age of Shaping',
    short: 'Shaping',
    income: 20,
    blurb: 'The world is clay. Raise lands, carve rivers and name the seas. Peoples cannot wake yet.',
  },
  {
    name: 'The Age of Awakening',
    short: 'Awakening',
    income: 12,
    blurb: 'Peoples wake and spread. Found settlements and raise wonders; shaping costs more.',
  },
  {
    name: 'The Age of Empires',
    short: 'Empires',
    income: 12,
    blurb: 'Realms collide. Shaping is costly now, but wonders, war and wrath are cheap.',
  },
];

export const GOD_COLORS = ['#e8554e', '#f0963a', '#e2c93a', '#4fbf62', '#39b0d8', '#6f73ea', '#b465e0', '#e46aa8'];

export const SIZE_NAMES = ['Ruin', 'Hamlet', 'Village', 'Town', 'City', 'Metropolis'];
export const SIZE_PLURALS = ['ruins', 'hamlets', 'villages', 'towns', 'cities', 'metropolises'];
// Radius of land a settlement claims, by size.
export const CLAIM = [0, 1, 1, 2, 2, 3];
// Habitat needed to grow from each size to the next, and to hold a size.
export const GROW_NEED = [0, 9, 13, 17, 21, 99];
export const SUPPORT = [0, 3, 6, 9, 12, 15];

export const LIMITS = {
  playerName: 20,
  placeName: 28,
  entityName: 20,
  legend: 240,
  chat: 280,
  players: 8,
  racesPerGod: 3,
  settlementsPerRace: 12,
  powerCap: 40,
  chronicle: 1500,
};

export const MAP_SIZES = {
  small: { W: 36, H: 24, label: 'Small', hint: '2–3 gods' },
  medium: { W: 48, H: 32, label: 'Medium', hint: '3–5 gods' },
  large: { W: 64, H: 40, label: 'Large', hint: '5–8 gods' },
};

export const STARTS = {
  continents: { label: 'Continents', hint: 'Two or three great landmasses.' },
  pangaea: { label: 'Pangaea', hint: 'One vast continent.' },
  archipelago: { label: 'Archipelago', hint: 'A scatter of islands.' },
  sea: { label: 'Primordial Sea', hint: 'Nothing but water. Build every shore yourselves.' },
};

export const ROUND_TIMES = [0, 60, 90, 120, 180, 300];
export const ROUNDS_PER_AGE = [2, 3, 4, 5];

export const DEFAULT_SETTINGS = Object.freeze({
  worldName: 'Aerth',
  mode: 'ages',
  size: 'medium',
  start: 'continents',
  roundTime: 120,
  roundsPerAge: 3,
  wrath: true,
});

// Code points that must never reach a name: controls, zero-width marks, line
// separators and bidi overrides.
function unsafe(cp) {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  let text = '';
  for (const ch of value) text += unsafe(ch.codePointAt(0)) ? ' ' : ch;
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? chars.slice(0, max).join('').trim() : chars.join('');
}

export function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const src = input && typeof input === 'object' ? input : {};
  const pick = (key, ok) => (key in src && ok(src[key]) ? src[key] : base[key]);
  const worldName = cleanText(src.worldName ?? base.worldName, LIMITS.entityName) || base.worldName || DEFAULT_SETTINGS.worldName;
  return {
    worldName,
    mode: pick('mode', (v) => v === 'ages' || v === 'sandbox'),
    size: pick('size', (v) => Object.hasOwn(MAP_SIZES, v)),
    start: pick('start', (v) => Object.hasOwn(STARTS, v)),
    roundTime: pick('roundTime', (v) => ROUND_TIMES.includes(v)),
    roundsPerAge: pick('roundsPerAge', (v) => ROUNDS_PER_AGE.includes(v)),
    wrath: pick('wrath', (v) => typeof v === 'boolean'),
  };
}

// Power moves in half points, so a halved cost is never rounded away.
export function priceOf(raw) {
  if (!(raw > 0)) return 0;
  return Math.max(0.5, Math.ceil(raw * 2 - 1e-9) / 2);
}

export function fmtPower(value) {
  const whole = Math.floor(value + 1e-9);
  const half = value - whole >= 0.5 - 1e-9;
  if (!half) return String(whole);
  return whole ? `${whole}½` : '½';
}

// The first Age in which a deed becomes possible (1-based), or 0 if never.
export function unlockAge(type) {
  const index = ACTIONS[type]?.cost.findIndex((c) => c != null) ?? -1;
  return index + 1;
}

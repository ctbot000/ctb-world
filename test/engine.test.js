import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, applyPatch, computeScores, createState, normalizeState, relKey } from '../public/js/shared/game.js';
import { Rng } from '../public/js/shared/rng.js';
import * as R from '../public/js/shared/rules.js';

const { T } = R;

function newGame(settings = {}, seed = 7) {
  const game = Game.create({ size: 'small', ...settings }, seed);
  const a = game.addPlayer({ name: 'Ilyra', color: R.GOD_COLORS[0], domain: 'earth' });
  const b = game.addPlayer({ name: 'Thorn', color: R.GOD_COLORS[1], domain: 'war' });
  return { game, a, b };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// A tile of the wanted kind, away from the map edge.
function find(game, pred) {
  const { W, H } = game.s;
  for (let i = 0; i < game.grid.N; i++) {
    const c = i % W;
    const r = Math.floor(i / W);
    if (c < 3 || r < 3 || c > W - 4 || r > H - 4) continue;
    if (pred(game.s.terrain[i], i)) return i;
  }
  throw new Error('no such tile');
}

// Makes a patch of solid grassland around i so tests do not depend on the seed.
function meadow(game, i, radius = 3) {
  for (const t of game.grid.within(i, radius)) {
    game.s.terrain[t] = T.GRASS;
    game.s.river[t] = -1;
  }
}

// ...and a patch of open shallow sea.
function ocean(game, i, radius = 3) {
  for (const t of game.grid.within(i, radius)) {
    game.s.terrain[t] = T.SEA;
    game.s.river[t] = -1;
  }
  game.recomputeTerritory();
}

const middle = (game) => game.grid.index(Math.floor(game.s.W / 2), Math.floor(game.s.H / 2));

function toAge(game, age) {
  while (game.s.phase === 'playing' && game.s.age < age) game.endRound();
}

test('worlds are deterministic per seed and differ across seeds', () => {
  const a = createState({ size: 'small', start: 'continents' }, 99);
  const b = createState({ size: 'small', start: 'continents' }, 99);
  const c = createState({ size: 'small', start: 'continents' }, 100);
  assert.deepEqual(a.terrain, b.terrain);
  assert.deepEqual(a.river, b.river);
  assert.notDeepEqual(a.terrain, c.terrain);
  for (const start of Object.keys(R.STARTS)) {
    for (const size of Object.keys(R.MAP_SIZES)) {
      const s = createState({ size, start }, 5);
      assert.equal(s.terrain.length, s.W * s.H);
      const land = s.terrain.filter(R.isLand).length / s.terrain.length;
      if (start === 'sea') assert.equal(land, 0);
      else assert.ok(land > 0.2 && land < 0.6, `${start}/${size}: ${land}`);
      // Rivers only on land, and they point at a real neighbour.
      s.river.forEach((d, i) => {
        if (d === -1) return;
        assert.ok(R.isLand(s.terrain[i]), 'river on water');
      });
    }
  }
});

test('shaping costs power per tile and follows the elevation ladder', () => {
  const { game, a, b } = newGame();
  game.start();
  assert.equal(a.pp, 20);
  const i = find(game, (t) => t === T.SEA);
  const before = b.pp;
  let res = game.act(b.id, { type: 'raise', i });
  assert.ok(res.ok, res.err);
  assert.equal(game.s.terrain[i], T.GRASS);
  assert.equal(b.pp, before - 1);
  res = game.act(b.id, { type: 'raise', i });
  assert.equal(game.s.terrain[i], T.HILLS);
  res = game.act(b.id, { type: 'raise', i });
  assert.equal(game.s.terrain[i], T.MOUNTAIN);
  res = game.act(b.id, { type: 'raise', i, r: 0 });
  assert.equal(res.ok, false);
  assert.match(res.err, /no higher/);
  res = game.act(b.id, { type: 'lower', i });
  assert.equal(game.s.terrain[i], T.HILLS);
});

test('Stone halves shaping costs, and brushes charge for what they change', () => {
  const { game, a, b } = newGame();
  game.start();
  const i = middle(game);
  ocean(game, i, 6);
  const powerA = a.pp;
  assert.ok(game.act(a.id, { type: 'raise', i, r: 1 }).ok);
  assert.equal(powerA - a.pp, 3.5); // 7 tiles * 1 * 0.5: power moves in half points
  const powerB = b.pp;
  const j = game.grid.within(i, 4).find((k) => game.grid.distance(k, i) === 4);
  assert.ok(game.act(b.id, { type: 'raise', i: j, r: 1 }).ok);
  assert.equal(powerB - b.pp, 7);
});

test('not enough power is refused without changing anything', () => {
  const { game, b } = newGame();
  game.start();
  b.pp = 3;
  const i = middle(game);
  ocean(game, i, 3);
  const before = clone(game.s.terrain);
  const res = game.act(b.id, { type: 'raise', i, r: 2 });
  assert.equal(res.ok, false);
  assert.match(res.err, /needs 19 power/);
  assert.deepEqual(game.s.terrain, before);
  assert.equal(b.pp, 3);
});

test('peoples cannot wake in the Age of Shaping', () => {
  const { game, a } = newGame();
  game.start();
  const i = find(game, (t) => t === T.GRASS);
  const res = game.act(a.id, { type: 'race', i, arch: 'plainsfolk' });
  assert.equal(res.ok, false);
  assert.match(res.err, /Age of Awakening/);
});

test('rounds advance through three ages and then the world ends', () => {
  const { game, a } = newGame({ roundsPerAge: 2 });
  game.start();
  const seen = [];
  while (game.s.phase === 'playing') {
    seen.push(`${game.s.age}.${game.s.round}`);
    game.endRound();
  }
  assert.deepEqual(seen, ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2']);
  assert.equal(game.s.phase, 'ended');
  assert.equal(game.s.year, 600);
  assert.ok(game.s.chronicle.some((e) => e.kind === 'end'));
  assert.ok(a.pp <= R.LIMITS.powerCap);
});

test('a new people founds a village that claims land, and settlements spread', () => {
  const { game, a } = newGame({ roundsPerAge: 3 });
  game.start();
  toAge(game, 2);
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 5);
  game.recomputeTerritory();
  a.pp = 40;
  const res = game.act(a.id, { type: 'race', i, arch: 'plainsfolk', name: 'Vaneth' });
  assert.ok(res.ok, res.err);
  const race = Object.values(game.s.races)[0];
  assert.equal(race.name, 'Vaneth');
  assert.equal(race.god, a.id);
  const home = game.settlementAt(i);
  assert.equal(home.size, 2);
  for (const t of game.grid.within(i, 1)) assert.equal(game.s.owner[t], race.id);
  // Too close to the village: refused.
  assert.match(game.act(a.id, { type: 'city', i: game.grid.neighbor(i, 0) }).err, /Too close/);
  // Two steps away: a hamlet.
  const far = game.grid.within(i, 2).find((t) => game.grid.distance(i, t) === 2);
  assert.ok(game.act(a.id, { type: 'city', i: far }).ok);
  assert.equal(game.settlementAt(far).size, 1);
  // Let the people grow for a while on rich land.
  for (let k = 0; k < 4; k++) game.endRound();
  assert.ok(game.settlementsOf(race.id).length >= 2);
  assert.ok(home.size >= 3, `home size ${home.size}`);
});

test('wonders are unique and have requirements', () => {
  const { game, a, b } = newGame();
  game.start();
  toAge(game, 2);
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 4);
  a.pp = 40;
  b.pp = 40;
  assert.ok(game.act(a.id, { type: 'race', i, arch: 'plainsfolk' }).ok);
  const st = game.settlementAt(i);
  assert.match(game.act(a.id, { type: 'wonder', i, w: 'library' }).err, /size 3/);
  st.size = 3;
  assert.ok(game.act(a.id, { type: 'wonder', i, w: 'library' }).ok);
  assert.equal(st.wonder, 'library');
  assert.match(game.act(a.id, { type: 'wonder', i, w: 'arena' }).err, /already has/);
  assert.match(game.act(b.id, { type: 'wonder', i, w: 'arena' }).err, /another god/);
  assert.equal(computeScores(game.s)[a.id].wonders, 1);
});

test('war, peace and capture between two gods', () => {
  const { game, a, b } = newGame();
  game.start();
  toAge(game, 2);
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 5);
  const j = game.grid.within(i, 3).find((t) => game.grid.distance(i, t) === 3);
  a.pp = b.pp = 40;
  assert.ok(game.act(a.id, { type: 'race', i, arch: 'plainsfolk' }).ok);
  assert.ok(game.act(b.id, { type: 'race', i: j, arch: 'nomads' }).ok);
  const [ra, rb] = Object.values(game.s.races);
  assert.match(game.act(a.id, { type: 'war', i }).err, /another god/);
  assert.ok(game.act(a.id, { type: 'war', i: j }).ok);
  assert.equal(game.s.relations[relKey(ra.id, rb.id)].state, 'war');
  assert.ok(game.act(b.id, { type: 'peace', i: j }).ok);
  assert.equal(game.s.relations[relKey(ra.id, rb.id)], undefined);
  // Battles eventually settle the matter.
  game.setRelation(relKey(ra.id, rb.id), 'war');
  game.settlementAt(i).size = 5;
  game.settlementAt(j).size = 1;
  let rounds = 0;
  while (game.settlementAt(j)?.race === rb.id && rounds++ < 30) game.battle(ra, rb);
  const after = game.settlementAt(j);
  assert.ok(!after || after.race === ra.id, 'the weak village falls');
  game.checkExtinctions();
  assert.equal(rb.alive, false);
});

test('eruptions, deluges and plagues change the land and the peoples', () => {
  const { game, a, b } = newGame();
  game.start();
  toAge(game, 2);
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 5);
  a.pp = b.pp = 40;
  assert.ok(game.act(a.id, { type: 'race', i, arch: 'plainsfolk' }).ok);
  const race = Object.values(game.s.races)[0];
  const home = game.settlementAt(i);
  home.size = 4;
  assert.ok(game.act(b.id, { type: 'plague', i }).ok);
  assert.equal(home.size, 3);
  const k = game.grid.neighbor(i, 0);
  assert.ok(game.act(b.id, { type: 'erupt', i: k }).ok);
  assert.equal(game.s.terrain[k], T.VOLCANO);
  assert.equal(home.size, 1);
  assert.equal(game.s.terrain[game.grid.neighbor(k, 0)], T.WASTE);
  assert.ok(game.s.chronicle.some((e) => e.kind === 'wrath'));
  // With wrath switched off, nothing of the sort is allowed.
  game.s.settings.wrath = false;
  assert.match(game.act(b.id, { type: 'plague', i }).err, /disabled/);
  void race;
});

test('rivers are carved along a drag and dried up by tapping', () => {
  const { game, a } = newGame();
  game.start();
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 3);
  const n1 = game.grid.neighbor(i, 0);
  const n2 = game.grid.neighbor(n1, 0);
  assert.ok(game.act(a.id, { type: 'river', i, to: n1 }).ok);
  assert.equal(game.s.river[i], 0);
  assert.equal(game.s.river[n1], 6);
  assert.ok(game.act(a.id, { type: 'river', i: n1, to: n2 }).ok);
  assert.equal(game.s.river[n1], 0);
  assert.equal(game.act(a.id, { type: 'river', i, to: n2 }).ok, false);
  assert.ok(game.act(a.id, { type: 'unriver', i }).ok);
  assert.equal(game.s.river[i], -1);
  const sea = find(game, (t) => t === T.SEA);
  assert.match(game.act(a.id, { type: 'river', i: sea }).err, /over land/);
});

test('names label the map, legends are once per round', () => {
  const { game, a, b } = newGame();
  game.start();
  const i = find(game, (t) => t === T.SEA);
  assert.ok(game.act(a.id, { type: 'name', i, text: '  The   Glass Sea ' }).ok);
  const label = Object.values(game.s.labels)[0];
  assert.equal(label.text, 'The Glass Sea');
  assert.match(game.act(b.id, { type: 'name', i, text: 'Mine' }).err, /already named/);
  assert.match(game.act(b.id, { type: 'name', i: game.grid.neighbor(i, 0), text: 'Close' }).err, /Too close/);
  assert.ok(game.act(a.id, { type: 'legend', text: 'In the beginning there was salt.' }).ok);
  assert.match(game.act(a.id, { type: 'legend', text: 'Again' }).err, /already/);
  game.endRound();
  assert.ok(game.act(a.id, { type: 'legend', text: 'And then there was more salt.' }).ok);
  assert.ok(game.rename(a.id, { kind: 'label', id: label.id, text: '' }).ok);
  assert.equal(Object.keys(game.s.labels).length, 0);
});

test('sandbox worlds are free and never end on their own', () => {
  const { game, a } = newGame({ mode: 'sandbox' });
  game.start();
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 3);
  assert.ok(game.act(a.id, { type: 'race', i, arch: 'sylvan' }).ok);
  for (let k = 0; k < 20; k++) game.endRound();
  assert.equal(game.s.phase, 'playing');
  assert.equal(a.pp, 0);
  game.finish();
  assert.equal(game.s.phase, 'ended');
});

test('a saved world loads back into the same world', () => {
  const { game, a } = newGame();
  game.start();
  toAge(game, 2);
  const i = find(game, (t) => R.isLand(t));
  meadow(game, i, 3);
  a.pp = 40;
  game.act(a.id, { type: 'race', i, arch: 'highlanders' });
  game.act(a.id, { type: 'name', i: game.grid.neighbor(i, 1), text: 'Kettle Hill' });
  game.endRound();
  const saved = JSON.parse(JSON.stringify(game.snapshot()));
  const loaded = new Game(normalizeState(saved));
  for (const key of ['terrain', 'river', 'owner', 'races', 'settlements', 'labels', 'relations', 'ruins', 'chronicle', 'seed', 'age', 'round', 'year', 'rng']) {
    assert.deepEqual(loaded.s[key], saved[key], key);
  }
  assert.throws(() => normalizeState({ W: 3, H: 3 }), /invalid size/);
  assert.throws(() => normalizeState(null), /Not a CTB World save/);
  // Garbage entities are dropped rather than trusted.
  const bad = clone(saved);
  bad.settlements[999999] = { id: 999999, race: 12345, i: 0, size: 99 };
  bad.players[5] = { id: 5, name: '<b>x</b>‮', color: 'red', domain: 'nope' };
  const fixed = normalizeState(bad);
  assert.equal(fixed.settlements[999999], undefined);
  assert.equal(fixed.players[5].color, R.GOD_COLORS[0]);
  assert.equal(fixed.players[5].domain, 'earth');
});

// Plays whole games with bots doing random deeds, and checks after every step
// that the engine's invariants hold and that a replica fed only patches ends
// up identical to the host.
test('random games keep their invariants and replicas stay in sync', () => {
  for (const [seed, settings] of [
    [11, { size: 'small', start: 'continents', roundsPerAge: 3 }],
    [12, { size: 'medium', start: 'archipelago', roundsPerAge: 2 }],
    [13, { size: 'small', start: 'sea', roundsPerAge: 2 }],
    [14, { size: 'small', start: 'pangaea', mode: 'sandbox' }],
  ]) {
    const game = Game.create(settings, seed);
    const players = R.DOMAIN_KEYS.slice(0, 4).map((domain, k) =>
      game.addPlayer({ name: `God ${k}`, color: R.GOD_COLORS[k], domain }),
    );
    game.flush();
    const replica = clone(game.snapshot());
    const sync = () => {
      const patch = game.flush();
      if (patch) applyPatch(replica, clone(patch));
    };
    game.start();
    sync();
    const rng = new Rng(seed * 31);
    const types = Object.keys(R.ACTIONS);
    let rounds = 0;
    let successes = 0;
    while (game.s.phase === 'playing' && rounds < 14) {
      for (let step = 0; step < 60; step++) {
        const p = rng.pick(players);
        const type = rng.pick(types);
        const i = rng.int(game.grid.N);
        const own = Object.values(game.s.settlements).filter((st) => game.s.races[st.race].god === p.id);
        const target = type === 'wonder' && own.length ? rng.pick(own).i : i;
        const action = {
          type,
          i: target,
          r: rng.int(3),
          b: rng.pick(R.BIOMES),
          arch: rng.pick(R.ARCHETYPE_KEYS),
          w: rng.pick(R.WONDER_KEYS),
          to: rng.chance(0.5) ? -1 : game.grid.neighbor(i, rng.int(6)),
          text: `Deed ${step}`,
        };
        if (game.act(p.id, action).ok) successes++;
        sync();
        assertInvariants(game);
      }
      game.endRound();
      sync();
      assertInvariants(game);
      rounds++;
    }
    const host = clone(game.snapshot());
    delete host.rng;
    delete replica.rng;
    assert.deepEqual(replica, host, `replica diverged (seed ${seed})`);
    assert.ok(successes > 50, `only ${successes} deeds succeeded`);
  }
});

function assertInvariants(game) {
  const s = game.s;
  const seen = new Set();
  for (const st of Object.values(s.settlements)) {
    assert.ok(R.isLand(s.terrain[st.i]), `settlement ${st.name} on water`);
    assert.ok(!seen.has(st.i), 'two settlements on one tile');
    seen.add(st.i);
    assert.equal(game.at.get(st.i), st.id);
    assert.ok(st.size >= 1 && st.size <= 5);
    assert.ok(s.races[st.race]?.alive || s.races[st.race], 'settlement of unknown race');
  }
  assert.equal(game.at.size, seen.size);
  for (const p of Object.values(s.players)) assert.ok(p.pp >= 0 && p.pp <= 100, `power ${p.pp}`);
  for (const ru of Object.values(s.ruins)) assert.ok(R.isLand(s.terrain[ru.i]), 'ruins under water');
  for (const key of Object.keys(s.relations)) {
    const [a, b] = key.split('|').map(Number);
    assert.ok(a < b && s.races[a] && s.races[b], `bad relation ${key}`);
  }
  s.river.forEach((d, i) => {
    if (d !== -1) assert.ok(R.isLand(s.terrain[i]), 'river on water');
  });
  // Territory is exactly what the settlements claim.
  const owner = s.owner.slice();
  game.recomputeTerritory();
  assert.deepEqual(s.owner, owner, 'territory out of date');
}

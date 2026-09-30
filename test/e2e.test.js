// End to end: real Chrome pages play together, through the dedicated server
// and peer to peer through a local PeerServer. Each player gets its own
// browser context, so their saved profiles and tokens are separate, as on two
// devices. Set CHROME_PATH if Chrome is not in a standard location; without
// Chrome these tests are skipped.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PeerServer } from 'peer';
import puppeteer from 'puppeteer-core';
import { createGameServer } from '../server/server.js';

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((path) => path && existsSync(path));

const skip = CHROME ? false : 'Chrome not found; set CHROME_PATH';

let browser;
let server;
let base;
let signalServer;
let signal;
const signalSockets = new Set();
const pageErrors = [];

before(async () => {
  if (skip) return;
  server = createGameServer({ log: () => {} });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}/`;
  signalServer = await new Promise((done) => PeerServer({ port: 0, host: '127.0.0.1', path: '/' }, done));
  signalServer.on('connection', (socket) => {
    signalSockets.add(socket);
    socket.on('close', () => signalSockets.delete(socket));
  });
  signal = `http://127.0.0.1:${signalServer.address().port}/`;
  const args = [
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (process.env.CI) args.push('--no-sandbox');
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
});

after(async () => {
  await browser?.close();
  await server?.shutdown();
  if (signalServer) {
    const closed = new Promise((done) => signalServer.close(done));
    for (const socket of signalSockets) socket.destroy();
    await closed;
  }
});

async function openPlayer(url, profile) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${profile.name}: ${error.message}`));
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument((p) => {
    localStorage.setItem('ctbworld.profile', JSON.stringify(p));
    localStorage.setItem('ctbworld.seenHelp', 'true');
  }, profile);
  await page.goto(url);
  return page;
}

const inWorld = (page, timeout = 30000) => page.waitForFunction(() => window.ctbWorld?.store.state, { timeout });
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, { timeout }, arg);
const replica = (page) =>
  page.evaluate(() => {
    const copy = JSON.parse(JSON.stringify(window.ctbWorld.store.state));
    delete copy.rng;
    return copy;
  });

async function clickText(page, selector, text) {
  const handle = await page.waitForFunction(
    (selector, text) => [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text && !el.disabled),
    { timeout: 10000 },
    selector,
    text,
  );
  await page.bringToFront();
  await handle.asElement().click();
}

// Clicks the middle of tile i on the map, with the real mouse. The camera
// zooms in and centres on the tile first, clear of the panels that float over
// the map; at the fitted zoom it is clamped and cannot move the tile at all.
async function clickTile(page, i) {
  await page.bringToFront();
  const [x, y] = await page.evaluate((i) => {
    const r = window.ctbWorld.renderer;
    r.centerOn(i, Math.max(r.cam.zoom, 1.5));
    r.draw();
    return r.tileToScreen(i);
  }, i);
  const box = await (await page.$('#map')).boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
}

// A water tile near the middle of the map, where raising it is visible.
function middleWater(page) {
  return page.evaluate(() => {
    const { state: s, grid } = window.ctbWorld.store;
    const mid = grid.index(Math.floor(s.W / 2), Math.floor(s.H / 2));
    let best = -1;
    for (let i = 0; i < grid.N; i++) {
      if (s.terrain[i] > 1) continue;
      if (best < 0 || grid.distance(i, mid) < grid.distance(best, mid)) best = i;
    }
    return best;
  });
}

async function playTogether(hostUrl, guestUrl) {
  const host = await openPlayer(hostUrl, { name: 'Ilyra', color: '#e8554e', domain: 'earth' });
  await clickText(host, 'button', 'Create a world');
  await inWorld(host);
  await until(host, () => window.ctbWorld.store.code);
  const code = await host.evaluate(() => window.ctbWorld.store.code);
  assert.match(code, /^[2-9A-HJKMNP-Z]{5}$/);

  const guest = await openPlayer(guestUrl(code), { name: 'Thorn', color: '#39b0d8', domain: 'war' });
  assert.equal(await guest.$eval('#join-code', (el) => el.value), code, 'the invite link fills in the code');
  await clickText(guest, 'button', 'Join');
  await inWorld(guest);
  await until(host, () => Object.values(window.ctbWorld.store.state.players).filter((p) => p.online).length === 2);

  await clickText(host, '#lobby button', 'Begin the world');
  await until(guest, () => window.ctbWorld.store.phase === 'playing');

  // The guest raises land with a real click; the host sees it.
  const i = await middleWater(guest);
  const before = await host.evaluate((i) => window.ctbWorld.store.state.terrain[i], i);
  await guest.bringToFront();
  await guest.click('.tool[data-tool="raise"]');
  await clickTile(guest, i);
  await until(host, ([i, before]) => window.ctbWorld.store.state.terrain[i] === before + 1, [i, before]);

  // Chat both ways.
  await guest.click('[data-tab="chat"]');
  await guest.type('#chat-input', 'The sea is rising');
  await guest.keyboard.press('Enter');
  await until(host, () => window.ctbWorld.store.chat.some((m) => m.text === 'The sea is rising' && m.name === 'Thorn'));

  // Both end their turn: the round ends for everyone.
  await host.bringToFront();
  await host.click('#btn-ready');
  await guest.bringToFront();
  await guest.click('#btn-ready');
  await until(host, () => window.ctbWorld.store.state.round === 2);
  await until(guest, () => window.ctbWorld.store.state.round === 2);
  await delay(300);
  assert.deepEqual(await replica(guest), await replica(host), 'both players see the same world');
  await host.browserContext().close();
  await guest.browserContext().close();
}

test('two players build a world together on the dedicated server', { skip, timeout: 90000 }, async () => {
  await playTogether(base, (code) => `${base}?join=${code}`);
  assert.deepEqual(pageErrors, []);
});

test('a world hosted in a browser is joined peer to peer', { skip, timeout: 120000 }, async () => {
  const q = `net=p2p&signal=${encodeURIComponent(signal)}`;
  await playTogether(`${base}?${q}`, (code) => `${base}?${q}&join=${code}`);
  assert.deepEqual(pageErrors, []);
});

test('when the hosting browser reloads, the world resumes and its guests reconnect', { skip, timeout: 120000 }, async () => {
  const q = `net=p2p&signal=${encodeURIComponent(signal)}`;
  const host = await openPlayer(`${base}?${q}`, { name: 'Keeper', color: '#e2c93a', domain: 'wisdom' });
  await clickText(host, 'button', 'Create a world');
  await inWorld(host);
  await until(host, () => window.ctbWorld.session.link.state === 'online');
  const code = await host.evaluate(() => window.ctbWorld.store.code);
  const guest = await openPlayer(`${base}?${q}&join=${code}`, { name: 'Wanderer', color: '#b465e0', domain: 'life' });
  await clickText(guest, 'button', 'Join');
  await inWorld(guest);
  const you = await guest.evaluate(() => window.ctbWorld.store.me);
  await clickText(host, '#lobby button', 'Begin the world');
  await until(guest, () => window.ctbWorld.store.phase === 'playing');

  await host.reload();
  // The page resumes hosting by itself: same code, same world.
  await inWorld(host);
  assert.equal(await host.evaluate(() => window.ctbWorld.store.code), code);
  assert.equal(await host.evaluate(() => window.ctbWorld.store.phase), 'playing');
  // The guest finds the host again and is still the same god.
  await until(host, (you) => window.ctbWorld.store.state.players[you]?.online === true, you, 45000);
  await until(guest, () => window.ctbWorld.session.link.state === 'online', null, 45000);
  assert.equal(await guest.evaluate(() => window.ctbWorld.store.me), you);
  const i = await middleWater(guest);
  const before = await host.evaluate((i) => window.ctbWorld.store.state.terrain[i], i);
  await guest.evaluate((i) => window.ctbWorld.ui.act({ type: 'raise', i }), i);
  await until(host, ([i, before]) => window.ctbWorld.store.state.terrain[i] === before + 1, [i, before]);
  await host.browserContext().close();
  await guest.browserContext().close();
  assert.deepEqual(pageErrors, []);
});

test('a solo world plays through three Ages to the final reckoning', { skip, timeout: 90000 }, async () => {
  const page = await openPlayer(base, { name: 'Solo', color: '#4fbf62', domain: 'hearth' });
  await clickText(page, 'button', 'Play alone');
  await inWorld(page);
  await page.evaluate(() => {
    const W = window.ctbWorld;
    W.session.link.send({ t: 'host', cmd: 'settings', settings: { ...W.store.state.settings, roundsPerAge: 2 } });
  });
  await until(page, () => window.ctbWorld.store.state.settings.roundsPerAge === 2);
  await clickText(page, '#lobby button', 'Begin the world');
  await until(page, () => window.ctbWorld.store.phase === 'playing');
  for (let round = 1; round <= 2; round++) {
    await page.click('#btn-ready');
    await until(page, (era) => window.ctbWorld.store.state.era === era, round);
  }
  assert.equal(await page.evaluate(() => window.ctbWorld.store.state.age), 2);

  // Awaken a people on the richest free land, by clicking the map.
  const site = await page.evaluate(async () => {
    const R = await import('./js/shared/rules.js');
    const { state: s, grid, at } = window.ctbWorld.store;
    let best = -1;
    let score = -1;
    for (let i = 0; i < grid.N; i++) {
      if (!R.canSettle(s.terrain[i]) || at.has(i)) continue;
      // Away from the edges, where the camera can centre it clear of the panels.
      const col = i % s.W;
      const row = Math.floor(i / s.W);
      if (col < 8 || row < 6 || col > s.W - 9 || row > s.H - 7) continue;
      let h = 0;
      for (const t of grid.within(i, 1)) h += R.ARCHETYPES.plainsfolk.hab[s.terrain[t]];
      if (h > score) {
        score = h;
        best = i;
      }
    }
    return best;
  });
  await page.click('.tool[data-tool="race"]');
  await clickTile(page, site);
  await until(page, (i) => window.ctbWorld.store.settlementAt(i)?.size === 2, site);
  // The deed succeeded, so the tool put itself away.
  await until(page, () => window.ctbWorld.ui.tool === 'inspect');

  for (let round = 3; round <= 6; round++) {
    await page.click('#btn-ready');
    await until(page, (era) => window.ctbWorld.store.state.era === era || window.ctbWorld.store.phase === 'ended', round);
  }
  await until(page, () => window.ctbWorld.store.phase === 'ended');
  await until(page, () => document.getElementById('dlg').open && document.querySelector('.results'));
  const legacy = await page.$eval('.results td.total', (el) => Number(el.textContent));
  assert.ok(legacy >= 5, `legacy ${legacy}`);
  const chronicle = await page.evaluate(() => window.ctbWorld.store.state.chronicle.map((e) => e.kind));
  for (const kind of ['age', 'race', 'end']) assert.ok(chronicle.includes(kind), `chronicle has ${kind}`);
  await page.browserContext().close();
  assert.deepEqual(pageErrors, []);
});

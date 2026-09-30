// Entry point: the title screen, choosing how to connect, and the lifetime of
// a session (connect, play, autosave, leave).

import { $, download, h, replace } from './dom.js';
import { GameUI, slug } from './game-ui.js';
import { helpContent } from './help.js';
import { MapInput } from './input.js';
import { GuestLink, HostLink, WsLink, signalingOptions } from './net.js';
import { Renderer } from './render.js';
import { isValidCode, normalizeCode } from './shared/codes.js';
import { Game, PROTOCOL } from './shared/game.js';
import { Grid } from './shared/hex.js';
import { Rng, randomSeed } from './shared/rng.js';
import * as R from './shared/rules.js';
import * as sound from './sound.js';
import { load, save } from './storage.js';
import { Store } from './store.js';

const params = new URLSearchParams(location.search);
const AUTOSAVE_MS = 3000;

const app = {
  mode: 'p2p', // 'server' | 'p2p' — how "Create" and "Join" connect
  peerOptions: {},
  profile: { name: '', color: R.GOD_COLORS[0], domain: 'earth', ...load('profile', {}) },
  session: null,
};

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    app.peerOptions = signalingOptions(params);
  } catch (error) {
    setTitleStatus(error.message, true);
  }
  renderProfile();
  bindTitle();
  drawTitleBackground();
  app.mode = await detectMode();
  $('#net-mode').textContent = app.mode === 'server' ? 'Worlds are hosted by this server' : 'Peer-to-peer: the creator’s browser hosts each world';
  updateResume();

  const join = normalizeCode(params.get('join'));
  const resume = normalizeCode(params.get('resume'));
  const hosted = load('hosted', null);
  if (resume && hosted?.code === resume) {
    startResume();
  } else if (isValidCode(join)) {
    $('#join-code').value = join;
    const saved = load(`session.${join}`, null);
    if (saved?.token && app.profile.name) startJoin(join);
    else $('#profile-name').focus();
  }
}

async function detectMode() {
  const forced = params.get('net');
  if (forced === 'server' || forced === 'p2p') return forced;
  if (location.protocol === 'file:') return 'p2p';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('api/info', { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const info = await res.json();
      if (info?.app === 'ctb-world' && info.protocol === PROTOCOL) return 'server';
    }
  } catch {
    // no server here: a static host such as GitHub Pages
  }
  return 'p2p';
}

// ---------------------------------------------------------------- title

function renderProfile() {
  const p = app.profile;
  const name = $('#profile-name');
  name.value = p.name ?? '';
  name.addEventListener('input', () => {
    p.name = R.cleanText(name.value, R.LIMITS.playerName);
    save('profile', p);
  });
  const colors = $('#profile-colors');
  const renderColors = () =>
    replace(
      colors,
      ...R.GOD_COLORS.map((c) =>
        h('button.swatch', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(p.color === c),
          'aria-label': `Colour ${c}`,
          style: { background: c },
          onclick: () => {
            p.color = c;
            save('profile', p);
            renderColors();
          },
        }),
      ),
    );
  renderColors();
  const domains = $('#profile-domains');
  const perk = $('#domain-perk');
  const renderDomains = () => {
    perk.textContent = `${R.DOMAINS[p.domain]?.name ?? ''}: ${R.DOMAINS[p.domain]?.perk ?? ''}`;
    replace(
      domains,
      ...Object.entries(R.DOMAINS).map(([key, d]) =>
        h(
          'button.domain',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(p.domain === key),
            title: d.perk,
            onclick: () => {
              p.domain = key;
              save('profile', p);
              renderDomains();
            },
          },
          h('span.d-icon', {}, d.icon),
          h('strong', {}, d.name),
          h('small', {}, d.perk),
        ),
      ),
    );
  };
  renderDomains();
}

function bindTitle() {
  $('#btn-create').addEventListener('click', () => {
    sound.unlock();
    if (needName()) return;
    startCreate();
  });
  $('#btn-solo').addEventListener('click', () => {
    sound.unlock();
    if (needName()) return;
    startSolo();
  });
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sound.unlock();
    if (needName()) return;
    const code = normalizeCode($('#join-code').value);
    if (!isValidCode(code)) {
      setTitleStatus('A world code has 5 letters and digits, like K7QMX.', true);
      $('#join-code').focus();
      return;
    }
    startJoin(code);
  });
  $('#join-code').addEventListener('input', (e) => {
    const el = e.target;
    const code = normalizeCode(el.value);
    if (code !== el.value) el.value = code;
  });
  $('#btn-resume').addEventListener('click', () => {
    sound.unlock();
    startResume();
  });
  $('#btn-forget').addEventListener('click', () => {
    save('hosted', null);
    updateResume();
  });
  $('#btn-howto').addEventListener('click', () => {
    const dlg = $('#dlg');
    dlg.className = 'dialog wide';
    replace(dlg, h('div.dlg-body', {}, helpContent()), h('div.dlg-foot', {}, h('button.btn.primary', { type: 'button', onclick: () => dlg.close() }, 'Got it')));
    dlg.showModal();
  });
}

function needName() {
  const name = R.cleanText($('#profile-name').value, R.LIMITS.playerName);
  if (name) {
    app.profile.name = name;
    save('profile', app.profile);
    return false;
  }
  setTitleStatus('Choose your name as a god first.', true);
  $('#profile-name').focus();
  return true;
}

function setTitleStatus(text, error = false) {
  const el = $('#title-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function updateResume() {
  const saved = load('hosted', null);
  const row = $('#resume-row');
  const s = saved?.state;
  if (!s) {
    row.hidden = true;
    return;
  }
  const when =
    s.phase === 'ended' ? 'finished' : s.settings?.mode === 'sandbox' ? `year ${s.year}` : `Age ${['I', 'II', 'III'][s.age - 1] ?? '?'}, year ${s.year}`;
  $('#btn-resume').textContent = `Resume “${s.settings?.worldName ?? 'world'}” (${when}${saved.online ? ', hosted by you' : ', solo'})`;
  row.hidden = false;
}

// A living world behind the title: generated and simulated with the real engine.
function drawTitleBackground() {
  const canvas = $('#title-bg');
  const rng = new Rng(randomSeed());
  const game = Game.create({ size: 'large', start: rng.pick(['continents', 'pangaea', 'archipelago']), roundsPerAge: 2 }, randomSeed());
  const gods = [0, 1, 2, 3].map((k) => game.addPlayer({ name: `God ${k}`, color: R.GOD_COLORS[(k * 2 + rng.int(2)) % 8], domain: 'hearth' }));
  game.start();
  while (game.s.age < 2) game.endRound();
  for (const god of gods) {
    for (let tries = 0; tries < 40; tries++) {
      const i = rng.int(game.grid.N);
      const arch = rng.pick(R.ARCHETYPE_KEYS);
      god.pp = 40;
      if (game.siteHabitat(i, { arch }) >= 12 && game.act(god.id, { type: 'race', i, arch }).ok) break;
    }
  }
  for (let k = 0; k < 3; k++) game.endRound();
  const source = { state: game.s, grid: new Grid(game.s.W, game.s.H), at: new Map(Object.values(game.s.settlements).map((st) => [st.i, st])), cursors: new Map() };
  const renderer = new Renderer(canvas, source, { interactive: false });
  const paint = () => {
    renderer.fitted = false;
    renderer.view = { w: 0, h: 0, dpr: 1 };
    const rect = canvas.getBoundingClientRect();
    renderer.view = { w: Math.max(50, rect.width), h: Math.max(50, rect.height), dpr: Math.min(2, window.devicePixelRatio || 1) };
    canvas.width = Math.round(renderer.view.w * renderer.view.dpr);
    canvas.height = Math.round(renderer.view.h * renderer.view.dpr);
    renderer.cover();
    renderer.draw();
  };
  paint();
  let timer = 0;
  window.addEventListener('resize', () => {
    if ($('#title').hidden) return;
    clearTimeout(timer);
    timer = setTimeout(paint, 150);
  });
}

// ---------------------------------------------------------------- sessions

function joinMessage(extra = {}) {
  const p = app.profile;
  return { t: 'join', protocol: PROTOCOL, name: p.name, color: p.color, domain: p.domain, ...extra };
}

function serverUrl() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  return url.href;
}

function startCreate() {
  const settings = { worldName: '' };
  if (app.mode === 'server') {
    const link = new WsLink({ url: serverUrl() });
    begin(link, 'server-host', () => {
      const s = app.session;
      if (s?.code) return joinMessage({ code: s.code, token: s.token });
      return { ...joinMessage(), t: 'create', settings: randomSettings(settings) };
    });
  } else {
    const link = new HostLink({ settings: randomSettings(settings), online: true, peerOptions: app.peerOptions });
    begin(link, 'p2p-host', () => joinMessage());
  }
}

function startSolo() {
  const link = new HostLink({ settings: randomSettings({ roundTime: 0 }), online: false });
  begin(link, 'solo', () => joinMessage());
}

function startJoin(code) {
  const saved = load(`session.${code}`, null);
  const token = saved?.token;
  let link;
  if (app.mode === 'server') link = new WsLink({ url: serverUrl() });
  else link = new GuestLink({ code, peerOptions: app.peerOptions });
  begin(link, app.mode === 'server' ? 'server-guest' : 'p2p-guest', () => joinMessage({ code, token: app.session?.token ?? token }), code);
}

function startResume() {
  const saved = load('hosted', null);
  if (!saved?.state) return;
  let link;
  try {
    link = new HostLink({ save: saved, online: saved.online !== false, peerOptions: app.peerOptions });
  } catch (error) {
    setTitleStatus(`That saved world could not be opened: ${error.message}`, true);
    return;
  }
  begin(link, saved.online !== false ? 'p2p-host' : 'solo', () => joinMessage({ token: saved.hostToken }));
}

function randomSettings(extra) {
  const rng = new Rng(randomSeed());
  return { ...extra, worldName: extra.worldName || (rng.chance(0.5) ? R.DEFAULT_SETTINGS.worldName : worldNameFrom(rng)) };
}

function worldNameFrom(rng) {
  const a = ['Aer', 'Eld', 'Mir', 'Tel', 'Val', 'Ost', 'Car', 'Sol', 'Ith', 'Zeph', 'Bel', 'Lun', 'Nor', 'Thal'];
  const b = ['dor', 'ia', 'thas', 'os', 'mar', 'heim', 'ion', 'ara', 'esh', 'une', 'wyn', 'ea'];
  return rng.pick(a) + rng.pick(b);
}

function begin(link, kind, firstMessage, code = '') {
  endSession(false);
  const store = new Store();
  const session = { link, kind, store, code, token: '', started: false, ui: null, renderer: null, input: null, saveTimer: 0 };
  app.session = session;
  setTitleStatus(kind === 'p2p-guest' || kind === 'server-guest' ? `Looking for world ${code}…` : 'Creating your world…');
  toggleTitleButtons(false);

  link.addEventListener('message', (e) => onMessage(session, e.detail));
  link.addEventListener('status', (e) => onStatus(session, e.detail));
  link.addEventListener('code', (e) => {
    session.code = e.detail;
    store.code = e.detail;
    session.ui?.renderLobby();
    rememberUrl(session);
  });
  if (link instanceof HostLink) {
    link.room.onUpdate = () => scheduleAutosave(session);
  }
  link.start(firstMessage);
}

function toggleTitleButtons(enabled) {
  for (const id of ['#btn-create', '#btn-solo', '#btn-join', '#btn-resume']) $(id).disabled = !enabled;
}

function onStatus(session, { state, text }) {
  if (app.session !== session) return;
  session.ui?.setNet(state, text);
  if (!session.started) {
    if (state === 'failed') {
      setTitleStatus(text, true);
      endSession(false);
    } else if (text) {
      setTitleStatus(text);
    }
    if (session.kind === 'p2p-guest' && state === 'offline') showCancel();
  } else if (state === 'failed' || state === 'reconnecting' || state === 'id-taken') {
    session.ui?.toast(text, state === 'failed' ? 'error' : 'info', 4000);
  }
}

function showCancel() {
  const status = $('#title-status');
  if (status.querySelector('button')) return;
  status.append(
    ' ',
    h(
      'button.link',
      {
        type: 'button',
        onclick: () => {
          endSession(true);
          setTitleStatus('');
        },
      },
      'Cancel',
    ),
  );
}

function onMessage(session, msg) {
  if (app.session !== session) return;
  const { store } = session;
  switch (msg.t) {
    case 'welcome':
      session.code = msg.code;
      session.token = msg.token;
      store.welcome(msg);
      if (session.kind !== 'solo' && session.kind !== 'p2p-host') save(`session.${msg.code}`, { token: msg.token, at: Date.now() });
      if (session.kind === 'p2p-host' || session.kind === 'solo') session.hostToken = msg.token;
      if (!session.started) enterWorld(session);
      else session.ui.renderLobby();
      rememberUrl(session);
      break;
    case 'patch':
      store.patch(msg);
      break;
    case 'chat':
      store.addChat(msg);
      break;
    case 'cursor':
      store.setCursor(msg.pid, msg.i, msg.tool);
      break;
    case 'timer':
      store.setRemaining(msg.remaining);
      break;
    case 'error':
      fatal(session, msg);
      break;
    default:
      session.ui?.onMessage(msg);
  }
}

function fatal(session, msg) {
  const text = msg.text || 'The world closed the connection.';
  if (msg.code === 'missing' || msg.code === 'kicked') save(`session.${session.code}`, null);
  endSession(false);
  showTitle();
  setTitleStatus(text, true);
}

function enterWorld(session) {
  session.started = true;
  const { store } = session;
  $('#title').hidden = true;
  $('#world').hidden = false;
  setTitleStatus('');
  const canvas = $('#map');
  const renderer = new Renderer(canvas, store, { minimap: $('#minimap') });
  session.renderer = renderer;
  const ui = new GameUI({ store, renderer, actions: sessionActions(session) });
  session.ui = ui;
  session.input = new MapInput(canvas, renderer, () => store.grid, ui.intents());
  ui.setNet(session.link.state, session.link.statusText);
  ui.onChange({ all: true, welcome: true });
  session.resize = () => {
    renderer.resize();
    renderer.minimap?.resize();
  };
  session.observer = new ResizeObserver(session.resize);
  session.observer.observe(canvas);
  window.addEventListener('resize', session.resize);
  renderer.resize();
  renderer.fit();
  bindMinimap(session);
  if (window.matchMedia('(max-width: 900px)').matches && store.phase === 'lobby') ui.toggleSidebar(true);
  if (store.phase === 'lobby' && store.isHost && !load('seenHelp', false)) {
    save('seenHelp', true);
    setTimeout(() => ui.openHelp(), 400);
  }
  // Test hook: automation reads state and drives deeds through this.
  window.ctbWorld = { store, renderer, ui, session };
}

function bindMinimap(session) {
  const mini = $('#minimap');
  const jump = (e) => {
    const rect = mini.getBoundingClientRect();
    const [x, y] = session.renderer.minimap.worldAt(e.clientX - rect.left, e.clientY - rect.top);
    session.renderer.cam.x = x;
    session.renderer.cam.y = y;
    session.renderer.clampCamera();
    session.renderer.cameraChanged();
  };
  let dragging = false;
  mini.onpointerdown = (e) => {
    dragging = true;
    try {
      mini.setPointerCapture(e.pointerId);
    } catch {
      // not capturable
    }
    jump(e);
  };
  mini.onpointermove = (e) => {
    if (dragging) jump(e);
  };
  mini.onpointerup = () => {
    dragging = false;
  };
}

function rememberUrl(session) {
  const url = new URL(location.href);
  url.searchParams.delete('join');
  url.searchParams.delete('resume');
  if (session.kind === 'p2p-host') url.searchParams.set('resume', session.code);
  else if (session.kind !== 'solo' && session.code) url.searchParams.set('join', session.code);
  history.replaceState(null, '', url);
}

function scheduleAutosave(session) {
  if (session.saveTimer) return;
  session.saveTimer = setTimeout(() => {
    session.saveTimer = 0;
    autosave(session);
  }, AUTOSAVE_MS);
}

// Only a world that has begun is worth resuming; a lobby is not.
function autosave(session) {
  const link = session.link;
  if (!(link instanceof HostLink) || app.session !== session) return;
  if (link.room.game.s.phase === 'lobby') return;
  const data = link.exportSave();
  data.online = session.kind === 'p2p-host';
  data.hostToken = session.hostToken;
  save('hosted', data);
}

function endSession(toTitle = true) {
  const session = app.session;
  if (!session) return;
  app.session = null;
  if (session.link instanceof HostLink) {
    clearTimeout(session.saveTimer);
    if (session.started) autosave(session);
  }
  session.link.close();
  session.observer?.disconnect();
  if (session.resize) window.removeEventListener('resize', session.resize);
  session.ui?.destroy();
  session.input?.destroy();
  toggleTitleButtons(true);
  if (toTitle) showTitle();
}

function showTitle() {
  const url = new URL(location.href);
  url.searchParams.delete('join');
  url.searchParams.delete('resume');
  history.replaceState(null, '', url);
  $('#world').hidden = true;
  $('#title').hidden = false;
  document.title = 'CTB World';
  const dlg = $('#dlg');
  if (dlg.open) dlg.close();
  updateResume();
  window.ctbWorld = null;
}

function sessionActions(session) {
  return {
    send: (msg) => session.link.send(msg),
    leave: async () => {
      if (session.kind === 'p2p-host' && session.store.phase !== 'lobby') {
        const ok = await session.ui.confirm('Leave this world?', 'You host it, so it pauses for everyone. It is saved in this browser: resume it from the title screen.');
        if (!ok) return;
      }
      endSession(true);
    },
    inviteUrl: () => {
      if (session.kind === 'solo' || !session.code) return '';
      const url = new URL(location.pathname, location.href);
      url.searchParams.set('join', session.code);
      for (const key of ['signal', 'net']) if (params.get(key)) url.searchParams.set(key, params.get(key));
      return url.href;
    },
    copyInvite: async () => {
      const url = sessionActions(session).inviteUrl();
      try {
        if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
          await navigator.share({ title: 'Join my world in CTB World', text: `World code ${session.code}`, url });
          return;
        }
        await navigator.clipboard.writeText(url);
        session.ui.toast('Invite link copied. Send it to your friends!', 'info');
      } catch {
        session.ui.prompt({ title: 'Invite link', text: 'Copy this link and send it to your friends.', value: url, max: 500, ok: 'Done' });
      }
    },
    hostingNote: () =>
      ({
        'server-host': 'This world lives on the server, so it keeps going if you close your tab. Friends join with the code below.',
        'server-guest': 'This world lives on the server.',
        'p2p-host': 'Your browser hosts this world: keep this tab open while others play. It is saved here as you go.',
        'p2p-guest': 'Another player’s browser hosts this world.',
        solo: 'You are playing alone; nothing leaves this browser. Your world is saved here as you go.',
      })[session.kind] ?? '',
    saveWorld: () => {
      const s = session.store.state;
      const data = { app: 'ctb-world', kind: 'world', v: 1, savedAt: new Date().toISOString(), state: s };
      download(`${slug(s.settings.worldName)}-year-${s.year}.json`, JSON.stringify(data), 'application/json');
    },
    loadWorld: () => {
      const input = h('input', { type: 'file', accept: '.json,application/json' });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const state = data?.state ?? data;
          session.link.send({ t: 'host', cmd: 'load', state });
        } catch {
          session.ui.toast('That file is not a CTB World save.', 'error');
        }
      });
      input.click();
    },
    saveMap: async () => {
      const blob = await session.renderer.exportImage(16);
      if (blob) download(`${slug(session.store.state.settings.worldName)}-map.png`, blob, 'image/png');
    },
    saveChronicle: () => session.ui.saveChronicle(),
  };
}

// A page restored from the back/forward cache has a closed connection behind
// it; start over instead of showing a world that no longer updates.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && app.session) location.reload();
});

window.addEventListener('pagehide', () => {
  const session = app.session;
  if (!session) return;
  if (session.link instanceof HostLink) {
    autosave(session);
    session.link.close();
  }
});

boot();

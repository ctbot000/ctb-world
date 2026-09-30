// Everything on the world screen apart from the map itself: the deed toolbar
// and its options, the top bar, the lobby, the sidebar tabs, the tile
// inspector, toasts and dialogs. Talks to the world only through send().

import { $, $$, clear, download, h, plural, replace } from './dom.js';
import { helpContent } from './help.js';
import { HEX } from './render.js';
import { computeScores, regionName } from './shared/game.js';
import * as R from './shared/rules.js';
import * as sound from './sound.js';

const { T } = R;
const ROMAN = ['I', 'II', 'III'];

const TOOL_GROUPS = [
  ['look', ['inspect']],
  ['shape', ['raise', 'lower', 'biome', 'river']],
  ['lore', ['name', 'legend']],
  ['peoples', ['race', 'city', 'bless', 'wonder']],
  ['strife', ['war', 'peace']],
  ['wrath', ['erupt', 'flood', 'plague']],
];
const INSPECT = { name: 'Inspect', icon: '🔍', help: 'Drag to move the map. Click a tile to see what is there.' };
const KEYS = { 1: 'raise', 2: 'lower', 3: 'biome', 4: 'river', 5: 'name', 6: 'legend', 7: 'race', 8: 'city', 9: 'bless', 0: 'wonder' };
const PAINT = new Set(['raise', 'lower', 'biome']);
const BRUSHES = [
  [0, '1 tile'],
  [1, '7 tiles'],
  [2, '19 tiles'],
];
const HINTS = {
  raise: 'Click or drag to raise the land · [ and ] change the brush · Esc to stop',
  lower: 'Click or drag to lower the land · [ and ] change the brush · Esc to stop',
  biome: 'Click or drag over flat land to paint it · Esc to stop',
  river: 'Drag from high ground toward the sea to carve a river · tap a river to dry it up',
  name: 'Click a place to give it a name',
  race: 'Click open land to awaken your people there',
  city: 'Click land within reach of your people to found a hamlet',
  bless: 'Click any settlement to bless it',
  wonder: 'Click one of your settlements to raise the wonder there',
  war: 'Click a settlement of the people to attack',
  peace: 'Click a settlement of a people at war',
  erupt: 'Click the land where the volcano bursts out',
  flood: 'Click the lowlands to drown',
  plague: 'Click a settlement of the people to strike',
};
const KIND_ICON = {
  age: '🌅',
  end: '🏁',
  shape: '⛰️',
  name: '🏷️',
  legend: '📜',
  race: '👥',
  city: '🏠',
  bless: '✨',
  wonder: '🏛️',
  war: '⚔️',
  peace: '🕊️',
  trade: '🤝',
  battle: '🛡️',
  capture: '🚩',
  raze: '🔥',
  fall: '💀',
  wrath: '🌋',
  people: '🏘️',
};
const MAJOR = new Set(['age', 'end', 'race', 'wonder', 'war', 'peace', 'capture', 'raze', 'fall', 'wrath', 'legend', 'name', 'trade']);
const TOASTED = new Set(['age', 'end', 'race', 'wonder', 'war', 'peace', 'capture', 'raze', 'fall', 'wrath']);
const SOUND_OF = { war: 'war', capture: 'war', raze: 'war', battle: 'war', wrath: 'war', wonder: 'wonder', age: 'age', end: 'age', race: 'join' };

const fmtTime = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

export class GameUI {
  constructor({ store, renderer, actions }) {
    this.store = store;
    this.renderer = renderer;
    this.actions = actions;
    this.tool = 'inspect';
    this.opts = { brush: 0, biome: T.FOREST, arch: 'plainsfolk', wonder: '', raceName: '' };
    this.seq = 0;
    this.pending = new Map();
    this.stroke = null;
    this.strokeFailed = false;
    this.hover = -1;
    this.selected = -1;
    this.tab = 'gods';
    this.chronFilter = 'all';
    this.lastPhase = null;
    this.lastEra = null;
    this.cursorAt = 0;
    this.cursorQueued = -2;
    this.cursorTimer = 0;
    this.nudgedAt = 0;
    this.chronCount = 0;
    this.el = {
      canvas: $('#map'),
      toolbar: $('#toolbar'),
      options: $('#tool-options'),
      inspector: $('#inspector'),
      toasts: $('#toasts'),
      world: $('#hud-world'),
      age: $('#hud-age'),
      timer: $('#hud-timer'),
      power: $('#hud-power'),
      ready: $('#btn-ready'),
      pill: $('#net-pill'),
      sidebar: $('#sidebar'),
      lobby: $('#lobby'),
      tabs: $('#tabs'),
      gods: $('#tab-gods'),
      peoples: $('#tab-peoples'),
      chronicle: $('#tab-chronicle'),
      chat: $('#tab-chat'),
      chatLog: $('#chat-log'),
      chatForm: $('#chat-form'),
      chatInput: $('#chat-input'),
      chatBadge: $('#chat-badge'),
      dialog: $('#dlg'),
    };
    this.bind();
    this.timerTick = setInterval(() => this.updateTimer(), 250);
  }

  // ------------------------------------------------ plumbing

  send(msg) {
    this.actions.send(msg);
  }

  request(msg, meta = {}) {
    const seq = ++this.seq;
    this.pending.set(seq, meta);
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value);
    this.send({ ...msg, seq });
    return seq;
  }

  act(a, meta = {}) {
    return this.request({ t: 'act', a }, { ...meta, type: a.type });
  }

  get s() {
    return this.store.state;
  }

  get me() {
    return this.store.player;
  }

  canAct() {
    const p = this.me;
    return this.store.phase === 'playing' && p && !p.spectator;
  }

  // Every listener goes through one AbortController, so a world that is left
  // takes its handlers with it and the next world starts clean.
  bind() {
    const el = this.el;
    this.abort = new AbortController();
    const on = (target, type, fn) => target.addEventListener(type, fn, { signal: this.abort.signal });
    on(this.store, 'change', (e) => this.onChange(e.detail));
    on(el.ready, 'click', () => {
      const p = this.me;
      if (p) this.send({ t: 'ready', v: !p.ready });
      sound.unlock();
    });
    on($('#btn-help'), 'click', () => this.openHelp());
    on($('#btn-menu'), 'click', () => this.openMenu());
    on($('#btn-sound'), 'click', () => this.toggleSound());
    on($('#btn-panel'), 'click', () => this.toggleSidebar());
    on($('#btn-zoom-in'), 'click', () => this.renderer.zoomAt(this.renderer.view.w / 2, this.renderer.view.h / 2, 1.3));
    on($('#btn-zoom-out'), 'click', () => this.renderer.zoomAt(this.renderer.view.w / 2, this.renderer.view.h / 2, 1 / 1.3));
    on($('#btn-fit'), 'click', () => this.renderer.fit());
    for (const tab of $$('button', el.tabs)) on(tab, 'click', () => this.setTab(tab.dataset.tab));
    on(el.chatForm, 'submit', (e) => {
      e.preventDefault();
      const text = el.chatInput.value.trim();
      if (!text) return;
      this.send({ t: 'chat', text });
      el.chatInput.value = '';
    });
    on(document, 'keydown', (e) => this.onKey(e));
    on(el.lobby, 'focusout', () => {
      if (this.lobbyStale) setTimeout(() => this.renderLobby(), 0);
    });
    this.updateSoundButton();
  }

  destroy() {
    this.abort.abort();
    clearInterval(this.timerTick);
    clearTimeout(this.cursorTimer);
    this.closeDialog();
    clear(this.el.toolbar);
    clear(this.el.toasts);
    this.el.options.hidden = true;
    this.el.inspector.hidden = true;
    this.el.sidebar.classList.remove('open');
  }

  intents() {
    return {
      mode: () => this.mode(),
      hover: (i) => this.setHover(i),
      pick: (i, ev) => this.pick(i, ev),
      strokeStart: () => {
        this.stroke = new Set();
        this.strokeFailed = false;
      },
      paint: (i) => this.paint(i),
      strokeEnd: () => {
        this.stroke = null;
      },
      riverStep: (from, to) => this.act({ type: 'river', i: from, to }, { stroke: 'river' }),
      riverTap: (i) => this.act({ type: this.s.river[i] !== -1 ? 'unriver' : 'river', i, to: -1 }),
    };
  }

  // ------------------------------------------------ messages

  onMessage(msg) {
    switch (msg.t) {
      case 'ack':
        this.onAck(msg);
        break;
      case 'notice':
        this.toast(msg.text, msg.level === 'error' ? 'error' : 'info');
        if (msg.level === 'error') sound.play('error', 250);
        break;
      default:
    }
  }

  onAck(msg) {
    const meta = this.pending.get(msg.seq) ?? {};
    this.pending.delete(msg.seq);
    if (!msg.ok) {
      // A drag can fail on every tile for the same reason; say it once.
      if (meta.stroke) {
        if (this.strokeFailed && meta.stroke !== 'river') return;
        this.strokeFailed = true;
      }
      this.toast(msg.err || 'That did not work.', 'error');
      sound.play('error', 250);
      if (/power/.test(msg.err ?? '')) this.flashPower();
      return;
    }
    if (PAINT.has(msg.type) || msg.type === 'river' || msg.type === 'unriver') sound.play('shape', 70);
    else if (msg.type !== 'rename') sound.play('deed');
    if (meta.disarm && !meta.keep && this.tool === msg.type) this.setTool('inspect');
    if (meta.after) meta.after();
  }

  onChange(d) {
    const s = this.s;
    if (!s) return;
    if (d.welcome) {
      this.lastPhase = null;
      this.lastEra = s.era;
      this.chronCount = 0;
      this.selected = -1;
    }
    const phaseChanged = s.phase !== this.lastPhase;
    if (d.all || d.meta || d.players) this.renderHud();
    if (d.all || d.meta || d.players || d.settlements || d.races) this.renderToolbar();
    if (d.all || phaseChanged || d.meta || d.players) this.renderLobby();
    if (d.all || d.players || d.settlements || d.races || d.labels || d.meta) this.renderGods();
    if (d.all || d.races || d.settlements || d.relations || d.players) this.renderPeoples();
    if (d.all || d.chronicle) this.renderChronicle(d.chronicle);
    if (d.all || d.chat) this.renderChat(d.chat);
    if (d.all || d.tiles || d.settlements || d.labels || d.races || d.ruins) this.renderInspector();
    if (d.all || d.meta || d.settlements || d.players) this.renderToolOptions();
    if (d.chronicle && !d.welcome) this.announce(d.chronicle);
    if (phaseChanged) this.onPhase(this.lastPhase, s.phase, Boolean(d.welcome));
    if (!d.welcome && d.meta && s.era !== this.lastEra && s.phase === 'playing' && this.lastEra !== null) {
      sound.play('round');
      if (this.sandbox()) this.toast(`A century passes. It is now year ${s.year}.`, 'event', 2600);
      else if (s.round > 1) this.toast(`A century passes: round ${s.round} of ${s.settings.roundsPerAge}, year ${s.year}.`, 'event', 2600);
    }
    this.lastEra = s.era;
    this.lastPhase = s.phase;
    this.renderer.overlay.selected = this.selected;
    if (d.cursors || d.tiles || d.all || d.settlements || d.labels || d.races || d.relations || d.ruins || d.meta) this.renderer.requestDraw();
    if (d.tiles || d.all || d.settlements || d.races) this.renderer.minimap?.invalidate();
    if (d.world) this.renderer.fit();
    this.updateBrush();
  }

  onPhase(from, to, welcome) {
    if (to === 'playing' && from === 'lobby' && !welcome) {
      sound.play('age');
      setTimeout(() => this.toast('Pick a deed on the left, then click or drag on the map. Drag with 🔍 to move, scroll to zoom.', 'info', 7000), 1500);
    }
    if (to === 'ended') {
      this.setTool('inspect');
      if (!welcome || from === null) setTimeout(() => this.openResults(), welcome ? 300 : 1200);
    }
    if (to !== 'playing') this.setTool('inspect');
    if (to === 'lobby' && window.matchMedia('(max-width: 900px)').matches) this.el.sidebar.classList.add('open');
  }

  announce(entries) {
    const s = this.s;
    for (const e of entries) {
      if (e.i != null) this.renderer.ping(e.i, s.players[e.god]?.color ?? '#f0cd7c');
      const snd = SOUND_OF[e.kind];
      if (snd && e.god !== this.store.me) sound.play(snd, 400);
      if (TOASTED.has(e.kind) && (e.god !== this.store.me || e.kind === 'age' || e.kind === 'end')) this.toast(e.text, 'event', 5000);
    }
  }

  sandbox() {
    return this.s?.settings.mode === 'sandbox';
  }

  // ------------------------------------------------ tools

  mode() {
    if (!this.canAct()) return 'inspect';
    if (PAINT.has(this.tool)) return 'paint';
    if (this.tool === 'river') return 'river';
    if (this.tool === 'inspect') return 'inspect';
    return 'pick';
  }

  setTool(key) {
    if (key === 'legend') {
      if (this.canAct()) this.openLegend();
      return;
    }
    if (key !== 'inspect' && !this.canAct()) return;
    this.tool = key;
    this.el.canvas.dataset.tool = key;
    for (const btn of $$('.tool', this.el.toolbar)) btn.setAttribute('aria-pressed', String(btn.dataset.tool === key));
    this.renderToolOptions();
    this.updateBrush();
  }


  // Would this tool change tile t? Used for previews and to skip pointless sends.
  wouldChange(t) {
    const s = this.s;
    const cur = s.terrain[t];
    switch (this.tool) {
      case 'raise':
        return R.raised(cur) !== cur;
      case 'lower': {
        const next = R.lowered(cur);
        return next !== cur && !(R.isWater(next) && this.store.at.has(t));
      }
      case 'biome':
        return R.isFlat(cur) && cur !== this.opts.biome;
      default:
        return false;
    }
  }

  cost(type, units = 1) {
    const p = this.me;
    const s = this.s;
    if (!p || !s) return null;
    const def = R.ACTIONS[type];
    const base = this.sandbox() ? (def.cost.find((c) => c != null) ?? 0) : def.cost[s.age - 1];
    if (base == null) return null;
    const mult = R.DOMAINS[p.domain]?.mult?.[type] ?? 1;
    return R.priceOf(base * units * mult);
  }

  affordable(amount) {
    return amount != null && (this.sandbox() || (this.me?.pp ?? 0) >= amount);
  }

  paint(i) {
    if (!this.canAct()) return;
    const tiles = this.store.grid.within(i, this.opts.brush).filter((t) => !this.stroke?.has(t) && this.wouldChange(t));
    if (!tiles.length) return;
    for (const t of tiles) this.stroke?.add(t);
    this.act({ type: this.tool, i, tiles, b: this.opts.biome }, { stroke: this.stroke });
  }

  async pick(i, ev = {}) {
    const mode = this.mode();
    if (mode === 'inspect') {
      this.select(this.selected === i ? -1 : i);
      return;
    }
    const tool = this.tool;
    const keep = Boolean(ev.shift);
    if (tool === 'name') {
      const label = this.store.labelAt(i);
      const mine = label && label.god === this.store.me;
      const text = await this.prompt({
        title: mine ? 'Rename this place' : 'Name this place',
        text: `A name for ${this.placePhrase(i)}. It will appear on the map and in the Chronicle.`,
        value: mine ? label.text : '',
        max: R.LIMITS.placeName,
        placeholder: 'e.g. The Frostspine',
        ok: mine ? 'Rename' : `Name it${this.costSuffix('name')}`,
      });
      if (text == null) return;
      if (mine) this.request({ t: 'rename', kind: 'label', id: label.id, text }, { type: 'rename' });
      else this.act({ type: 'name', i, text }, { disarm: true, keep });
      return;
    }
    if (tool === 'race') {
      this.act({ type: 'race', i, arch: this.opts.arch, name: this.opts.raceName || undefined }, { disarm: true, keep, after: () => (this.opts.raceName = '') });
      return;
    }
    if (tool === 'wonder') {
      if (!this.opts.wonder) {
        this.toast('Choose which wonder to raise first.', 'error');
        return;
      }
      this.act({ type: 'wonder', i, w: this.opts.wonder }, { disarm: true, keep, after: () => (this.opts.wonder = '') });
      return;
    }
    this.act({ type: tool, i }, { disarm: true, keep });
  }

  costSuffix(type) {
    const c = this.cost(type);
    return c && !this.sandbox() ? ` (${R.fmtPower(c)} ⚡)` : '';
  }

  setHover(i) {
    if (i === this.hover) return;
    this.hover = i;
    this.updateBrush();
    if (this.selected < 0) this.renderInspector();
    this.queueCursor(i);
  }

  queueCursor(i) {
    this.cursorQueued = i;
    if (this.cursorTimer) return;
    const wait = Math.max(0, 110 - (performance.now() - this.cursorAt));
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = 0;
      this.cursorAt = performance.now();
      if (this.store.phase === 'lobby' && this.cursorQueued >= 0) return;
      this.send({ t: 'cursor', i: this.cursorQueued, tool: this.tool });
    }, wait);
  }

  updateBrush() {
    const o = this.renderer.overlay;
    const i = this.hover;
    o.hover = i;
    o.tool = this.tool;
    if (!this.s || i < 0 || this.mode() === 'inspect') {
      o.brush = [];
      this.renderer.requestDraw();
      return;
    }
    if (PAINT.has(this.tool)) {
      const tiles = this.store.grid.within(i, this.opts.brush);
      const changing = tiles.filter((t) => this.wouldChange(t)).length;
      o.brush = tiles;
      o.brushOk = changing > 0 && this.affordable(this.cost(this.tool, changing));
    } else {
      o.brush = [i];
      o.brushOk = this.validTarget(i);
    }
    this.renderer.requestDraw();
  }

  validTarget(i) {
    const s = this.s;
    const t = s.terrain[i];
    const st = this.store.settlementAt(i);
    const near = () => this.store.grid.neighbors(i).some((n) => this.store.at.has(n));
    switch (this.tool) {
      case 'river':
        return R.isLand(t);
      case 'race':
      case 'city':
        return R.canSettle(t) && !st && !near();
      case 'bless':
      case 'war':
      case 'peace':
      case 'plague':
        return Boolean(st);
      case 'wonder':
        return Boolean(st) && s.races[st.race]?.god === this.store.me;
      case 'erupt':
        return R.isLand(t) && t !== T.VOLCANO;
      case 'flood':
        return this.store.grid.within(i, 1).some((n) => R.isFlat(s.terrain[n]));
      default:
        return true;
    }
  }

  select(i) {
    this.selected = i;
    this.renderer.overlay.selected = i;
    this.renderer.requestDraw();
    this.renderInspector();
  }

  // ------------------------------------------------ keyboard

  onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable);
    if (this.el.dialog.open || typing || $('#world').hidden) return;
    if (e.key === 'Escape') {
      if (this.tool !== 'inspect') this.setTool('inspect');
      else this.select(-1);
      this.el.options.hidden = true;
      return;
    }
    if (e.key === 'Enter') {
      this.setTab('chat');
      if (window.matchMedia('(max-width: 900px)').matches) this.el.sidebar.classList.add('open');
      this.el.chatInput.focus();
      e.preventDefault();
      return;
    }
    if (e.key === '[' || e.key === ']') {
      this.opts.brush = Math.max(0, Math.min(2, this.opts.brush + (e.key === ']' ? 1 : -1)));
      this.renderToolOptions();
      this.updateBrush();
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      this.renderer.fit();
      return;
    }
    const tool = KEYS[e.key];
    if (tool) {
      const btn = $(`.tool[data-tool="${tool}"]`, this.el.toolbar);
      if (btn && !btn.disabled) this.setTool(tool);
    }
  }

  // ------------------------------------------------ top bar

  renderHud() {
    const s = this.s;
    const el = this.el;
    const p = this.me;
    el.world.textContent = s.settings.worldName;
    document.title = `${s.settings.worldName} · CTB World`;
    if (s.phase === 'lobby') el.age.textContent = 'Gathering the gods…';
    else if (s.phase === 'ended') el.age.textContent = `The world is complete · Year ${s.year}`;
    else if (this.sandbox()) el.age.textContent = `Sandbox · Era ${s.era + 1} · Year ${s.year}`;
    else el.age.textContent = `Age ${ROMAN[s.age - 1]} · ${R.AGES[s.age - 1].short} · Round ${s.round}/${s.settings.roundsPerAge} · Year ${s.year}`;

    const playing = s.phase === 'playing' && p && !p.spectator;
    el.power.hidden = !playing;
    if (playing) {
      if (this.sandbox()) replace(el.power, '⚡ ∞');
      else replace(el.power, `⚡ ${R.fmtPower(p.pp)}`, h('small', {}, ` +${this.incomeOf(p)}`));
    }
    el.ready.hidden = !playing;
    if (playing) {
      const gods = Object.values(s.players).filter((x) => !x.spectator && x.online);
      const ready = gods.filter((x) => x.ready).length;
      const label = this.sandbox() ? 'Next era' : 'End turn';
      el.ready.textContent = p.ready ? `Waiting ${ready}/${gods.length}` : label;
      el.ready.classList.toggle('ready', p.ready);
      el.ready.classList.toggle('primary', !p.ready);
      el.ready.title = p.ready ? 'Click to keep playing this round' : 'Finish your turn. The round ends when every god is ready or time runs out.';
    }
    this.updateTimer();
  }

  // Next round's income, as the engine will compute it.
  incomeOf(p) {
    const s = this.s;
    const nextAge = s.round >= s.settings.roundsPerAge ? Math.min(3, s.age + 1) : s.age;
    let inc = R.AGES[nextAge - 1].income;
    if (nextAge === 1 && s.settings.start === 'sea') inc += 10;
    if (p.domain === 'wisdom') inc += 2;
    if (nextAge >= 2) {
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

  flashPower() {
    const el = this.el.power;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  updateTimer() {
    const el = this.el.timer;
    const secs = this.store.secondsLeft();
    const show = this.store.phase === 'playing' && secs != null;
    el.hidden = !show;
    if (!show) return;
    el.textContent = fmtTime(secs);
    el.classList.toggle('low', secs <= 15);
    // A host whose tab is in the background may not notice its own deadline;
    // any message wakes it up.
    if (secs === 0 && performance.now() - this.nudgedAt > 3000 && performance.now() - this.store.deadline > 1500) {
      this.nudgedAt = performance.now();
      this.send({ t: 'ping' });
    }
  }

  setNet(state, text) {
    const pill = this.el.pill;
    pill.dataset.state = state;
    const labels = {
      online: 'Online',
      offline: 'Solo',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      'id-taken': 'Code busy',
      failed: 'Offline',
    };
    pill.textContent = labels[state] ?? state;
    pill.title = text || labels[state] || '';
  }

  toggleSound() {
    sound.setMuted(!sound.isMuted());
    if (!sound.isMuted()) sound.play('chat');
    this.updateSoundButton();
  }

  updateSoundButton() {
    const btn = $('#btn-sound');
    btn.textContent = sound.isMuted() ? '🔇' : '🔊';
    btn.title = sound.isMuted() ? 'Sound is off' : 'Sound is on';
  }

  toggleSidebar(force) {
    this.el.sidebar.classList.toggle('open', force);
  }

  // ------------------------------------------------ toolbar

  renderToolbar() {
    const s = this.s;
    const bar = this.el.toolbar;
    const p = this.me;
    clear(bar);
    const acting = this.canAct();
    for (const [group, keys] of TOOL_GROUPS) {
      if (group === 'wrath' && !s.settings.wrath) continue;
      const box = h('div.tool-group', { dataset: { group } });
      for (const key of keys) {
        const def = key === 'inspect' ? INSPECT : R.ACTIONS[key];
        const cost = key === 'inspect' ? null : this.cost(key);
        const locked = key !== 'inspect' && cost == null;
        const shortcut = Object.entries(KEYS).find(([, v]) => v === key)?.[0];
        let title = `${def.name}${shortcut ? ` (${shortcut})` : ''}\n${def.help}`;
        if (locked) title += `\nUnlocks in ${R.AGES[R.unlockAge(key) - 1].name}.`;
        else if (cost != null && !this.sandbox()) title += `\nCosts ${R.fmtPower(cost)} power${def.perTile ? ' per tile' : ''}.`;
        const btn = h(
          'button.tool',
          {
            type: 'button',
            title,
            'aria-label': def.name,
            'aria-pressed': String(this.tool === key),
            dataset: { tool: key },
            disabled: key !== 'inspect' && (!acting || locked),
            onclick: () => {
              sound.unlock();
              this.setTool(this.tool === key && key !== 'inspect' ? 'inspect' : key);
            },
            // Keep focus where it was, so Enter/Space do not re-trigger the button.
            onmousedown: (e) => e.preventDefault(),
          },
          def.icon,
          locked ? h('span.lock', {}, '🔒') : cost != null && !this.sandbox() ? h('span.cost', { style: { color: p && p.pp < cost ? '#ff8f86' : '' } }, R.fmtPower(cost)) : null,
        );
        box.append(btn);
      }
      bar.append(box);
    }
    if (this.tool !== 'inspect') {
      const btn = $(`.tool[data-tool="${this.tool}"]`, bar);
      if (!btn || btn.disabled) this.setTool('inspect');
    }
  }

  renderToolOptions() {
    const box = this.el.options;
    const tool = this.tool;
    if (!this.s || tool === 'inspect' || !this.canAct()) {
      box.hidden = true;
      return;
    }
    const def = R.ACTIONS[tool];
    const cost = this.cost(tool);
    const head = h(
      'div.opt-head',
      {},
      h('h3', {}, `${def.icon} ${def.name}`),
      h(
        'button.icon-btn.small',
        {
          type: 'button',
          title: this.optsCollapsed ? 'Show details' : 'Hide details',
          'aria-label': this.optsCollapsed ? 'Show details' : 'Hide details',
          onclick: () => {
            this.optsCollapsed = !this.optsCollapsed;
            this.renderToolOptions();
          },
        },
        this.optsCollapsed ? '▸' : '▾',
      ),
    );
    if (this.optsCollapsed) {
      replace(box, head);
      box.hidden = false;
      return;
    }
    const parts = [head, h('p', {}, def.help, cost != null && !this.sandbox() ? ` Costs ${R.fmtPower(cost)} power${def.perTile ? ' per tile' : ''}.` : '')];
    if (PAINT.has(tool)) {
      parts.push(
        h(
          'div.opt-row',
          { role: 'group', 'aria-label': 'Brush size' },
          BRUSHES.map(([r, label]) =>
            h(
              'button.opt',
              {
                type: 'button',
                'aria-pressed': String(this.opts.brush === r),
                onclick: () => {
                  this.opts.brush = r;
                  this.renderToolOptions();
                  this.updateBrush();
                },
              },
              label,
            ),
          ),
        ),
      );
    }
    if (tool === 'biome') {
      parts.push(
        h(
          'div.opt-row',
          { role: 'group', 'aria-label': 'Biome' },
          R.BIOMES.map((b) =>
            h(
              'button.opt',
              {
                type: 'button',
                'aria-pressed': String(this.opts.biome === b),
                onclick: () => {
                  this.opts.biome = b;
                  this.renderToolOptions();
                  this.updateBrush();
                },
              },
              h('span.chip', { style: { background: R.TERRAIN[b].color } }),
              R.TERRAIN[b].name,
            ),
          ),
        ),
      );
    }
    if (tool === 'race') {
      const chosen = R.ARCHETYPES[this.opts.arch];
      parts.push(
        h(
          'div.opt-grid',
          { role: 'radiogroup', 'aria-label': 'Kind of people' },
          Object.entries(R.ARCHETYPES).map(([key, a]) =>
            h(
              'button.opt',
              {
                type: 'button',
                title: a.blurb,
                'aria-pressed': String(this.opts.arch === key),
                onclick: () => {
                  this.opts.arch = key;
                  this.renderToolOptions();
                },
              },
              h('span', {}, a.icon),
              h('span', {}, a.name),
            ),
          ),
        ),
        h('p.opt-detail', {}, chosen.blurb, ` Best on ${bestLands(chosen)}.`),
      );
      const input = h('input', {
        placeholder: 'Name (optional, or one is chosen)',
        maxlength: R.LIMITS.entityName,
        value: this.opts.raceName,
        oninput: () => (this.opts.raceName = input.value),
      });
      parts.push(h('div', { style: { marginTop: '8px' } }, input));
      const mine = Object.values(this.s.races).filter((r) => r.alive && r.god === this.store.me).length;
      parts.push(h('p', { style: { marginTop: '8px' } }, `You watch over ${mine} of at most ${R.LIMITS.racesPerGod} peoples.`));
    }
    if (tool === 'wonder') {
      const built = new Map(Object.values(this.s.settlements).filter((st) => st.wonder).map((st) => [st.wonder, st]));
      const chosen = R.WONDERS[this.opts.wonder];
      parts.push(
        h(
          'div.opt-grid',
          { role: 'radiogroup', 'aria-label': 'Wonder' },
          Object.entries(R.WONDERS).map(([key, w]) => {
            const where = built.get(key);
            return h(
              'button.opt',
              {
                type: 'button',
                disabled: Boolean(where),
                title: where ? `${w.name} stands in ${where.name}.` : w.need,
                'aria-pressed': String(this.opts.wonder === key),
                onclick: () => {
                  this.opts.wonder = key;
                  this.renderToolOptions();
                },
              },
              h('span', {}, w.icon),
              h('span', {}, w.name.replace(/^The /, '')),
            );
          }),
        ),
        h('p.opt-detail', {}, chosen ? `${chosen.name}: ${chosen.need}` : 'Choose a wonder. Each exists once per world.'),
      );
    }
    if (HINTS[tool]) parts.push(h('p.opt-hint', {}, HINTS[tool]));
    replace(box, ...parts);
    box.hidden = false;
  }

  // ------------------------------------------------ inspector

  placePhrase(i) {
    const s = this.s;
    const t = s.terrain[i];
    return `this ${R.TERRAIN[t].name.toLowerCase()} in ${regionName(s.W, s.H, i)}`;
  }

  habitatAt(i, race) {
    const s = this.s;
    const arch = R.ARCHETYPES[race.arch];
    let h0 = 0;
    let nearRiver = false;
    for (const t of this.store.grid.within(i, 1)) {
      h0 += arch.hab[s.terrain[t]];
      if (t !== i && s.river[t] !== -1) nearRiver = true;
    }
    if (s.river[i] !== -1) h0 += arch.river;
    else if (nearRiver) h0 += 1;
    return h0;
  }

  renderInspector() {
    const box = this.el.inspector;
    const s = this.s;
    const i = this.selected >= 0 ? this.selected : this.hover;
    if (!s || i < 0 || i >= this.store.grid.N) {
      box.hidden = true;
      return;
    }
    const t = s.terrain[i];
    const me = this.store.me;
    const rows = [];
    const title = `${R.TERRAIN[t].name}${s.river[i] !== -1 ? ', with a river' : ''}`;
    rows.push(h('h4', {}, title), h('div.sub', {}, `${regionName(s.W, s.H, i).replace(/^the /, '')} · tile ${i % s.W},${Math.floor(i / s.W)}`));
    const label = this.store.labelAt(i);
    if (label) {
      const by = s.players[label.god]?.name ?? 'a forgotten god';
      rows.push(h('div.row', {}, `🏷️ “${label.text}”, named by ${by}`));
    }
    const owner = s.owner[i] ? s.races[s.owner[i]] : null;
    const st = this.store.settlementAt(i);
    if (st) {
      const race = s.races[st.race];
      const god = s.players[race?.god];
      rows.push(
        h(
          'div.row',
          {},
          h('span.dotc', { style: { background: race?.color } }),
          h('strong', {}, st.name),
          ` · ${R.SIZE_NAMES[st.size]} of the ${race?.name ?? '?'}`,
        ),
      );
      if (race) {
        const arch = R.ARCHETYPES[race.arch];
        const hab = this.habitatAt(i, race);
        const cap = R.GROW_NEED.findIndex((need, k) => k >= st.size && hab < need);
        const outlook = st.size >= arch.maxSize ? 'as large as it can grow' : cap > st.size ? `land supports a ${R.SIZE_NAMES[Math.min(cap, arch.maxSize)].toLowerCase()}` : 'room to grow';
        rows.push(h('div.sub', {}, `${arch.icon} ${arch.name} · god: ${god?.name ?? '—'} · founded year ${st.born}`));
        rows.push(h('div.sub', {}, `Land ${hab}: ${outlook}`));
      }
      if (st.wonder) rows.push(h('div.row', {}, `${R.WONDERS[st.wonder].icon} ${R.WONDERS[st.wonder].name}`));
    } else if (owner) {
      rows.push(h('div.row', {}, h('span.dotc', { style: { background: owner.color } }), `Land of the ${owner.name}`));
    }
    const ruin = s.ruins[i];
    if (ruin && !st) rows.push(h('div.row', {}, `🏚️ Ruins of ${ruin.name}`));
    if (!st && !R.isWater(t) && Object.values(s.races).some((r) => r.alive && r.god === me)) {
      const best = Object.values(s.races)
        .filter((r) => r.alive && r.god === me)
        .map((r) => [r, this.habitatAt(i, r)])
        .sort((a, b) => b[1] - a[1])[0];
      if (best) rows.push(h('div.sub', {}, `Land for the ${best[0].name}: ${best[1]}`));
    }
    const actions = [];
    if (this.selected >= 0) {
      if (st && s.races[st.race]?.god === me) {
        actions.push(h('button.btn.small', { type: 'button', onclick: () => this.renameEntity('settlement', st.id, st.name) }, 'Rename'));
      }
      if (label && label.god === me) {
        actions.push(h('button.btn.small', { type: 'button', onclick: () => this.renameEntity('label', label.id, label.text) }, 'Rename place'));
      }
      actions.push(h('button.btn.small.ghost', { type: 'button', onclick: () => this.select(-1) }, 'Close'));
    }
    if (actions.length) rows.push(h('div.actions', {}, actions));
    replace(box, ...rows);
    box.hidden = false;
  }

  async renameEntity(kind, id, current) {
    const text = await this.prompt({
      title: kind === 'race' ? 'Rename your people' : kind === 'label' ? 'Rename this place' : 'Rename this settlement',
      text: kind === 'label' ? 'Leave it empty to remove the name from the map.' : '',
      value: current,
      max: kind === 'label' ? R.LIMITS.placeName : R.LIMITS.entityName,
      ok: 'Rename',
      allowEmpty: kind === 'label',
    });
    if (text == null) return;
    this.request({ t: 'rename', kind, id, text }, { type: 'rename' });
  }

  // ------------------------------------------------ sidebar

  setTab(tab) {
    this.tab = tab;
    for (const btn of $$('button', this.el.tabs)) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    for (const key of ['gods', 'peoples', 'chronicle', 'chat']) this.el[key].hidden = key !== tab;
    if (tab === 'chat') {
      this.store.unread = 0;
      this.el.chatBadge.hidden = true;
      this.el.chatLog.scrollTop = this.el.chatLog.scrollHeight;
    }
    if (tab === 'chronicle') this.el.chronicle.scrollTop = this.el.chronicle.scrollHeight;
  }

  renderGods() {
    const s = this.s;
    const box = this.el.gods;
    const scores = computeScores(s);
    const gods = Object.values(s.players).sort((a, b) => Number(a.spectator) - Number(b.spectator) || (scores[b.id]?.legacy ?? 0) - (scores[a.id]?.legacy ?? 0) || a.id - b.id);
    const items = gods.map((p) => {
      const sc = scores[p.id];
      const d = R.DOMAINS[p.domain];
      const tags = [];
      if (p.id === s.host) tags.push(h('span.tag.host', {}, 'host'));
      if (p.id === this.store.me) tags.push(h('span.tag', {}, 'you'));
      if (p.spectator) tags.push(h('span.tag', {}, 'watching'));
      if (!p.online) tags.push(h('span.tag', {}, 'offline'));
      if (p.ready && s.phase === 'playing') tags.push(h('span.tag.ready', {}, 'ready'));
      const meta = p.spectator
        ? 'Watching the world'
        : `${d.icon} ${d.name}` +
          (s.phase !== 'lobby' && sc ? ` · ${plural(sc.settlements, 'settlement')} · ${plural(sc.wonders, 'wonder')}` : '') +
          (s.phase === 'playing' && !this.sandbox() ? ` · ⚡${R.fmtPower(p.pp)}` : '');
      return h(
        'div.god',
        { className: `${p.id === this.store.me ? 'me' : ''} ${p.online ? '' : 'offline'}` },
        h('span.dotc', { style: { background: p.color } }),
        h('span.name', {}, p.name, h('span.tags', {}, tags)),
        h('span.legacy', { title: 'Legacy' }, p.spectator || s.phase === 'lobby' ? '' : sc?.legacy ?? 0),
        h('span.meta', {}, meta),
      );
    });
    const parts = [h('h3.section-title', {}, s.phase === 'lobby' ? 'Gods in this world' : 'Legacy of the gods'), ...items];
    if (s.phase !== 'lobby') {
      parts.push(h('p.muted', { style: { fontSize: '12.5px' } }, 'Legacy: +1 per settlement size, +3 per living people, +5 per wonder, +1 per named place.'));
    }
    if (this.store.isHost && s.phase === 'playing') {
      parts.push(
        h('h3.section-title', {}, 'Host'),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button.btn.small', { type: 'button', onclick: () => this.send({ t: 'host', cmd: 'endRound' }) }, 'End round now'),
          h(
            'button.btn.small.danger',
            {
              type: 'button',
              onclick: async () => {
                if (await this.confirm('End the world now?', 'Legacy is counted as it stands, and the Chronicle closes.')) this.send({ t: 'host', cmd: 'endGame' });
              },
            },
            'End the world',
          ),
        ),
      );
    }
    replace(box, ...parts);
  }

  renderPeoples() {
    const s = this.s;
    const box = this.el.peoples;
    const races = Object.values(s.races);
    if (!races.length) {
      replace(box, h('p.empty', {}, s.phase === 'lobby' || s.age < 2 ? 'No peoples yet. They can be awakened from the Age of Awakening.' : 'No peoples yet. Use 👥 Awaken a People.'));
      return;
    }
    const stats = new Map(races.map((r) => [r.id, { n: 0, pop: 0, biggest: null }]));
    for (const st of Object.values(s.settlements)) {
      const x = stats.get(st.race);
      if (!x) continue;
      x.n++;
      x.pop += st.size;
      if (!x.biggest || st.size > x.biggest.size) x.biggest = st;
    }
    const rels = new Map();
    for (const [key, rel] of Object.entries(s.relations)) {
      const [a, b] = key.split('|').map(Number);
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        if (!rels.has(x)) rels.set(x, { war: [], trade: [] });
        rels.get(x)[rel.state].push(s.races[y]?.name ?? '?');
      }
    }
    races.sort((a, b) => Number(b.alive) - Number(a.alive) || stats.get(b.id).pop - stats.get(a.id).pop);
    const items = races.map((race) => {
      const arch = R.ARCHETYPES[race.arch];
      const st = stats.get(race.id);
      const god = s.players[race.god];
      const rel = rels.get(race.id);
      const mine = race.god === this.store.me;
      return h(
        'div.race',
        {
          className: race.alive ? '' : 'dead',
          style: { '--c': race.color },
          onclick: () => {
            if (st.biggest) {
              this.renderer.centerOn(st.biggest.i, Math.max(this.renderer.cam.zoom, 1.4));
              this.select(st.biggest.i);
            }
          },
        },
        h(
          'div.head',
          {},
          h('strong', {}, `the ${race.name}`),
          mine && race.alive
            ? h(
                'button.link',
                {
                  type: 'button',
                  onclick: (e) => {
                    e.stopPropagation();
                    this.renameEntity('race', race.id, race.name);
                  },
                },
                'rename',
              )
            : null,
        ),
        h(
          'div.info',
          {},
          `${arch.icon} ${arch.name} · `,
          h('span', { style: { color: god?.color } }, god?.name ?? 'forgotten'),
          race.alive ? ` · ${plural(st.n, 'settlement')} · size ${st.pop}` : ' · vanished',
        ),
        rel?.war.length ? h('div.rel.rel-war', {}, `⚔️ At war with the ${rel.war.join(', the ')}`) : null,
        rel?.trade.length ? h('div.rel.rel-trade', {}, `🤝 Trading with the ${rel.trade.join(', the ')}`) : null,
      );
    });
    replace(box, h('h3.section-title', {}, 'Peoples of the world'), ...items);
  }

  chronicleEntries() {
    const s = this.s;
    const f = this.chronFilter;
    return s.chronicle.filter((e) => f === 'all' || (f === 'major' && MAJOR.has(e.kind)) || (f === 'mine' && e.god === this.store.me));
  }

  renderChronicle(added) {
    const box = this.el.chronicle;
    const s = this.s;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    // Appending is enough for new entries under the current filter.
    if (added && this.chronList && this.chronCount + added.length === s.chronicle.length && this.chronFilter === 'all') {
      for (const e of added) this.appendChron(e);
      this.chronCount = s.chronicle.length;
    } else {
      const select = h(
        'select',
        {
          'aria-label': 'Show',
          onchange: () => {
            this.chronFilter = select.value;
            this.renderChronicle(null);
          },
        },
        h('option', { value: 'all' }, 'Everything'),
        h('option', { value: 'major' }, 'Major events'),
        h('option', { value: 'mine' }, 'My deeds'),
      );
      select.value = this.chronFilter;
      const tools = h(
        'div.chronicle-tools',
        {},
        select,
        h('button.btn.small', { type: 'button', onclick: () => this.actions.saveChronicle(), title: 'Save the Chronicle as a Markdown file' }, 'Save'),
      );
      this.chronList = h('div');
      this.lastAgeShown = 0;
      replace(box, tools, this.chronList);
      const entries = this.chronicleEntries();
      if (!entries.length) this.chronList.append(h('p.empty', {}, 'Nothing has happened yet. Every deed of the gods will be written here.'));
      for (const e of entries) this.appendChron(e);
      this.chronCount = s.chronicle.length;
    }
    if (atBottom || !added) box.scrollTop = box.scrollHeight;
  }

  appendChron(e) {
    const s = this.s;
    const list = this.chronList;
    list.querySelector('.empty')?.remove();
    if (e.age !== this.lastAgeShown && !this.sandbox()) {
      this.lastAgeShown = e.age;
      list.append(h('div.age-head', {}, R.AGES[e.age - 1]?.name ?? ''));
    }
    const god = s.players[e.god];
    const body =
      e.kind === 'legend'
        ? [h('span', {}, `“${e.text}”`), h('span.by', {}, ` — ${god?.name ?? 'a god'}`)]
        : [h('span', {}, e.text)];
    const item = h(
      'div.chron',
      {
        className: `${e.kind === 'legend' ? 'legend' : ''} ${e.i != null ? 'clickable' : ''}`,
        title: e.i != null ? 'Show on the map' : null,
        onclick:
          e.i != null
            ? () => {
                this.renderer.centerOn(e.i, Math.max(this.renderer.cam.zoom, 1.2));
                this.renderer.ping(e.i, god?.color ?? '#f0cd7c');
                this.select(e.i);
              }
            : null,
      },
      h('span', {}, KIND_ICON[e.kind] ?? '•'),
      h('div', {}, ...body),
      h('span.year', {}, `Year ${e.year}`),
    );
    list.append(item);
  }

  renderChat(added) {
    const log = this.el.chatLog;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const line = (m) => {
      if (m.sys) return h('li.sys', {}, m.text);
      return h('li', {}, h('span.who', { style: { color: m.color } }, m.name), m.text);
    };
    if (added) {
      log.append(line(added));
      while (log.children.length > 200) log.firstChild.remove();
      if (!added.sys && added.pid !== this.store.me) {
        sound.play('chat', 200);
        if (this.tab !== 'chat' || this.el.sidebar.hidden) {
          this.store.unread++;
          this.el.chatBadge.textContent = String(this.store.unread);
          this.el.chatBadge.hidden = false;
          if (!this.el.sidebar.classList.contains('open') && window.matchMedia('(max-width: 900px)').matches) this.toast(`${added.name}: ${added.text}`, 'info', 3000);
        }
      }
    } else {
      replace(log, ...this.store.chat.map(line));
    }
    if (atBottom || !added || added.pid === this.store.me) log.scrollTop = log.scrollHeight;
  }

  // ------------------------------------------------ lobby

  renderLobby() {
    const s = this.s;
    const box = this.el.lobby;
    const inLobby = s.phase === 'lobby';
    box.hidden = !inLobby;
    this.el.tabs.hidden = inLobby;
    for (const key of ['gods', 'peoples', 'chronicle', 'chat']) this.el[key].hidden = inLobby || key !== this.tab;
    if (!inLobby) return;
    // Rebuilding the form under someone's cursor would throw away what they
    // are typing; catch up when they leave the field.
    const active = document.activeElement;
    if (active && box.contains(active) && active.matches('input:not([type="checkbox"]), textarea')) {
      this.lobbyStale = true;
      return;
    }
    this.lobbyStale = false;
    const host = this.store.isHost;
    const set = s.settings;
    const me = this.me;
    const change = (patch) => this.send({ t: 'host', cmd: 'settings', settings: { ...set, ...patch } });
    const select = (value, options, onchange) => {
      const el = h(
        'select',
        { disabled: !host, onchange: () => onchange(el.value) },
        options.map(([v, label]) => h('option', { value: String(v) }, label)),
      );
      el.value = String(value);
      return el;
    };
    const nameInput = h('input', {
      value: set.worldName,
      maxlength: R.LIMITS.entityName,
      disabled: !host,
      onchange: () => change({ worldName: nameInput.value }),
    });
    const players = Object.values(s.players).map((p) =>
      h(
        'div.god',
        { className: `${p.id === this.store.me ? 'me' : ''} ${p.online ? '' : 'offline'}` },
        h('span.dotc', { style: { background: p.color } }),
        h('span.name', {}, p.name, h('span.tags', {}, p.id === s.host ? h('span.tag.host', {}, 'host') : null, p.id === this.store.me ? h('span.tag', {}, 'you') : null, p.spectator ? h('span.tag', {}, 'watching') : null)),
        host && p.id !== this.store.me
          ? h('button.link', { type: 'button', title: `Remove ${p.name}`, onclick: () => this.send({ t: 'host', cmd: 'kick', pid: p.id }) }, 'remove')
          : h('span'),
        h('span.meta', {}, p.spectator ? 'Watching' : `${R.DOMAINS[p.domain].icon} ${R.DOMAINS[p.domain].name} — ${R.DOMAINS[p.domain].perk}`),
      ),
    );
    const colorRow = h(
      'div.swatches',
      { role: 'radiogroup', 'aria-label': 'Your colour' },
      R.GOD_COLORS.map((c) => {
        const taken = Object.values(s.players).some((p) => p.id !== this.store.me && !p.spectator && p.color === c);
        return h('button.swatch', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(me?.color === c),
          'aria-label': c,
          disabled: taken,
          style: { background: c },
          onclick: () => this.send({ t: 'profile', color: c }),
        });
      }),
    );
    const domainSelect = select(
      me?.domain,
      Object.entries(R.DOMAINS).map(([k, d]) => [k, `${d.icon} ${d.name}`]),
      (v) => this.send({ t: 'profile', domain: v }),
    );
    domainSelect.disabled = false;
    const invite = this.actions.inviteUrl();
    const parts = [
      h('h2', {}, set.worldName),
      h('p.note', {}, this.actions.hostingNote()),
      invite
        ? h(
            'div.code-box',
            {},
            h('div', {}, h('div.muted', { style: { fontSize: '12px' } }, 'World code'), h('div.code', {}, this.store.code)),
            h('button.btn.small', { type: 'button', onclick: () => this.actions.copyInvite() }, 'Copy invite link'),
          )
        : null,
      h('h3.section-title', {}, `Gods (${Object.values(s.players).filter((p) => !p.spectator).length}/${R.LIMITS.players})`),
      ...players,
      me && !me.spectator
        ? h(
            'div',
            {},
            h('h3.section-title', {}, 'You'),
            h('div.settings-grid', {}, h('label', {}, 'Colour'), colorRow, h('label', {}, 'Domain'), domainSelect),
          )
        : null,
      h('h3.section-title', {}, host ? 'World settings' : 'World settings (the host decides)'),
      h(
        'div.settings-grid',
        {},
        h('label', {}, 'Name'),
        nameInput,
        h('label', {}, 'Game'),
        select(
          set.mode,
          [
            ['ages', 'Three Ages (scored)'],
            ['sandbox', 'Sandbox (free, no end)'],
          ],
          (v) => change({ mode: v }),
        ),
        h('label', {}, 'Map'),
        select(
          set.size,
          Object.entries(R.MAP_SIZES).map(([k, m]) => [k, `${m.label} · ${m.W}×${m.H} · ${m.hint}`]),
          (v) => change({ size: v }),
        ),
        h('label', {}, 'Start'),
        select(
          set.start,
          Object.entries(R.STARTS).map(([k, st]) => [k, st.label]),
          (v) => change({ start: v }),
        ),
        h('label', {}, 'Round timer'),
        select(
          set.roundTime,
          R.ROUND_TIMES.map((t) => [t, t ? `${t / 60 >= 1 && t % 60 === 0 ? `${t / 60} min` : `${t} s`}` : 'No timer']),
          (v) => change({ roundTime: Number(v) }),
        ),
        set.mode === 'ages' ? h('label', {}, 'Rounds per Age') : null,
        set.mode === 'ages'
          ? select(
              set.roundsPerAge,
              R.ROUNDS_PER_AGE.map((n) => [n, `${n} rounds (${n * 3} in all)`]),
              (v) => change({ roundsPerAge: Number(v) }),
            )
          : null,
        h('label', {}, 'Wrath'),
        h(
          'label.checkbox',
          {},
          h('input', { type: 'checkbox', checked: set.wrath, disabled: !host, onchange: (e) => change({ wrath: e.target.checked }) }),
          'Eruptions, deluges and plagues',
        ),
        h('label', {}, 'Terrain'),
        h(
          'div.seed',
          {},
          h('span.muted', { style: { flex: '1' } }, R.STARTS[set.start].hint),
          host ? h('button.btn.small', { type: 'button', onclick: () => this.send({ t: 'host', cmd: 'reroll' }) }, 'New map') : null,
        ),
      ),
      h(
        'div.actions',
        {},
        host
          ? h(
              'button.btn.primary.big',
              {
                type: 'button',
                onclick: () => {
                  sound.unlock();
                  this.send({ t: 'host', cmd: 'start' });
                },
              },
              'Begin the world',
            )
          : h('p.note', {}, 'Waiting for the host to begin…'),
        host ? h('button.btn', { type: 'button', onclick: () => this.actions.loadWorld() }, 'Load a saved world') : null,
        h('button.btn.ghost', { type: 'button', onclick: () => this.actions.leave() }, 'Leave'),
      ),
    ];
    replace(box, ...parts);
  }

  // ------------------------------------------------ toasts and dialogs

  toast(text, kind = 'info', ms = 3500) {
    if (!text) return;
    const box = this.el.toasts;
    const el = h('div.toast', { className: kind }, text);
    box.append(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
    }, ms);
  }

  openDialog(content, { wide = false, buttons = [] } = {}) {
    const dlg = this.el.dialog;
    if (dlg.open) dlg.close();
    dlg.className = `dialog${wide ? ' wide' : ''}`;
    const foot = h('div.dlg-foot', {}, buttons);
    replace(dlg, h('div.dlg-body', {}, content), buttons.length ? foot : null);
    dlg.showModal();
    return dlg;
  }

  closeDialog() {
    if (this.el.dialog.open) this.el.dialog.close();
  }

  prompt({ title, text = '', value = '', max = 40, placeholder = '', ok = 'OK', multiline = false, allowEmpty = false, extra = null }) {
    return new Promise((done) => {
      const input = multiline
        ? h('textarea', { maxlength: max, placeholder, value })
        : h('input', { maxlength: max, placeholder, value, spellcheck: 'false' });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.closeDialog();
        done(result);
      };
      const submit = () => {
        const v = input.value.trim();
        if (!v && !allowEmpty) {
          input.focus();
          return;
        }
        finish(v);
      };
      const form = h(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            submit();
          },
        },
        h('h2', {}, title),
        text ? h('p', {}, text) : null,
        input,
        extra,
      );
      const dlg = this.openDialog(form, {
        buttons: [h('button.btn', { type: 'button', onclick: () => finish(null) }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: submit }, ok)],
      });
      dlg.addEventListener('close', () => finish(null), { once: true });
      input.focus();
      if (!multiline) input.select();
    });
  }

  confirm(title, text) {
    return new Promise((done) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        this.closeDialog();
        done(v);
      };
      const dlg = this.openDialog([h('h2', {}, title), h('p', {}, text)], {
        buttons: [h('button.btn', { type: 'button', onclick: () => finish(false) }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => finish(true) }, 'Yes')],
      });
      dlg.addEventListener('close', () => finish(false), { once: true });
    });
  }

  async openLegend() {
    const s = this.s;
    const p = this.me;
    if (!p) return;
    if (!this.sandbox() && p.legendKey === String(s.era)) {
      this.toast('You have already inscribed a legend this round.', 'error');
      return;
    }
    const place = this.selected >= 0 ? this.selected : -1;
    const pin = h('input', { type: 'checkbox', checked: place >= 0 });
    const extra =
      place >= 0 ? h('label.checkbox', { style: { marginTop: '10px' } }, pin, `Set it at the selected place (${this.placePhrase(place).replace(/^this /, 'the ')})`) : null;
    const text = await this.prompt({
      title: 'Inscribe a legend',
      text: 'A line of myth for the Chronicle: a prophecy, a curse, the story of a hero. Free, once per round.',
      max: R.LIMITS.legend,
      placeholder: 'In the first days, the sea sang the mountains awake…',
      multiline: true,
      ok: 'Inscribe',
      extra,
    });
    if (text == null) return;
    this.act({ type: 'legend', text, i: place >= 0 && pin.checked ? place : undefined });
  }

  openHelp() {
    this.openDialog(helpContent(), { wide: true, buttons: [h('button.btn.primary', { type: 'button', onclick: () => this.closeDialog() }, 'Got it')] });
  }

  openMenu() {
    const s = this.s;
    const host = this.store.isHost;
    const invite = this.actions.inviteUrl();
    const content = [
      h('h2', {}, s.settings.worldName),
      h('p.muted', {}, this.actions.hostingNote()),
      invite ? h('p', {}, 'World code: ', h('strong', {}, this.store.code)) : null,
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
        invite ? h('button.btn', { type: 'button', onclick: () => this.actions.copyInvite() }, 'Copy invite link') : null,
        h('button.btn', { type: 'button', onclick: () => this.actions.saveWorld() }, 'Save world file'),
        h('button.btn', { type: 'button', onclick: () => this.actions.saveMap() }, 'Save map image'),
        h('button.btn', { type: 'button', onclick: () => this.actions.saveChronicle() }, 'Save chronicle'),
        h(
          'button.btn',
          {
            type: 'button',
            onclick: () => {
              this.closeDialog();
              this.openHelp();
            },
          },
          'How to play',
        ),
      ),
      host && s.phase === 'ended'
        ? h(
            'p',
            { style: { marginTop: '14px' } },
            h(
              'button.btn.primary',
              {
                type: 'button',
                onclick: () => {
                  this.closeDialog();
                  this.send({ t: 'host', cmd: 'restart' });
                },
              },
              'Start a new world with these gods',
            ),
          )
        : null,
    ];
    this.openDialog(content, {
      buttons: [
        h(
          'button.btn.danger',
          {
            type: 'button',
            onclick: () => {
              this.closeDialog();
              this.actions.leave();
            },
          },
          'Leave world',
        ),
        h('button.btn.primary', { type: 'button', onclick: () => this.closeDialog() }, 'Close'),
      ],
    });
  }

  openResults() {
    const s = this.s;
    if (!s || s.phase !== 'ended') return;
    const scores = computeScores(s);
    const ranked = Object.entries(scores).sort((a, b) => b[1].legacy - a[1].legacy);
    const end = [...s.chronicle].reverse().find((e) => e.kind === 'end');
    const biggest = Object.values(s.settlements).sort((a, b) => b.size - a.size || a.id - b.id)[0];
    const facts = [];
    if (biggest) facts.push(`Greatest settlement: ${biggest.name} of the ${s.races[biggest.race]?.name}, a ${R.SIZE_NAMES[biggest.size].toLowerCase()}.`);
    const wonders = Object.values(s.settlements).filter((st) => st.wonder).length;
    const living = Object.values(s.races).filter((r) => r.alive).length;
    facts.push(
      `${living ? plural(living, 'people', 'peoples') : 'No peoples'} ${living === 1 ? 'lives' : 'live'} on; ${wonders ? plural(wonders, 'wonder') : 'no wonders'} ${wonders === 1 ? 'stands' : 'stand'}; the Chronicle holds ${plural(s.chronicle.length, 'entry', 'entries')}.`,
    );
    const table = h(
      'table.results',
      {},
      h(
        'tr',
        {},
        h('th', {}, '#'),
        h('th', {}, 'God'),
        h('th', { title: '+1 per settlement size' }, 'Followers'),
        h('th', { title: '+3 per living people' }, 'Peoples ×3'),
        h('th', { title: '+5 per wonder' }, 'Wonders ×5'),
        h('th', { title: 'Named places, and legends for Stars gods' }, 'Lore'),
        h('th', {}, 'Legacy'),
      ),
      ranked.map(([id, sc], k) => {
        const p = s.players[id];
        return h(
          'tr',
          { className: k === 0 ? 'first' : '' },
          h('td', {}, k + 1),
          h('td', {}, h('span.dotc', { style: { background: p.color, marginRight: '6px' } }), p.name),
          h('td', {}, sc.followers),
          h('td', {}, sc.races),
          h('td', {}, sc.wonders),
          h('td', {}, sc.names + sc.legends),
          h('td.total', {}, sc.legacy),
        );
      }),
    );
    const content = [h('h2', {}, `The world of ${s.settings.worldName} is complete`), end ? h('p', {}, end.text) : null, table, ...facts.map((f) => h('p.muted', {}, f))];
    const buttons = [
      h(
        'button.btn',
        {
          type: 'button',
          onclick: () => {
            this.closeDialog();
            this.setTab('chronicle');
            this.toggleSidebar(true);
          },
        },
        'Read the Chronicle',
      ),
      h('button.btn', { type: 'button', onclick: () => this.actions.saveChronicle() }, 'Save chronicle'),
      h('button.btn', { type: 'button', onclick: () => this.actions.saveMap() }, 'Save map'),
      this.store.isHost
        ? h(
            'button.btn.primary',
            {
              type: 'button',
              onclick: () => {
                this.closeDialog();
                this.send({ t: 'host', cmd: 'restart' });
              },
            },
            'New world',
          )
        : h('button.btn.primary', { type: 'button', onclick: () => this.closeDialog() }, 'Close'),
    ];
    this.openDialog(content, { wide: true, buttons });
  }

  // Markdown chronicle for download.
  chronicleMarkdown() {
    const s = this.s;
    const scores = computeScores(s);
    const lines = [`# The Chronicle of ${s.settings.worldName}`, ''];
    const gods = Object.values(s.players).filter((p) => !p.spectator);
    lines.push(`_Shaped by ${gods.map((p) => `${p.name} (${R.DOMAINS[p.domain].name})`).join(', ')}._`, '');
    let age = 0;
    for (const e of s.chronicle) {
      if (e.age !== age && !this.sandbox()) {
        age = e.age;
        lines.push(`## ${R.AGES[age - 1].name}`, '');
      }
      const text = e.kind === 'legend' ? `*“${e.text}”* — ${s.players[e.god]?.name ?? 'a god'}` : e.text;
      lines.push(`- **Year ${e.year}.** ${text}`);
    }
    lines.push('', '## Legacy', '', '| God | Followers | Peoples | Wonders | Names | Legacy |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const [id, sc] of Object.entries(scores).sort((a, b) => b[1].legacy - a[1].legacy)) {
      lines.push(`| ${s.players[id].name} | ${sc.followers} | ${sc.races} | ${sc.wonders} | ${sc.names + sc.legends} | ${sc.legacy} |`);
    }
    lines.push('', `_Recorded by CTB World, year ${s.year}._`, '');
    return lines.join('\n');
  }

  saveChronicle() {
    const s = this.s;
    download(`${slug(s.settings.worldName)}-chronicle.md`, this.chronicleMarkdown(), 'text/markdown');
  }
}

function bestLands(arch) {
  return arch.hab
    .map((v, t) => [v, t])
    .filter(([v]) => v >= 2)
    .sort((x, y) => y[0] - x[0])
    .map(([, t]) => R.TERRAIN[t].name.toLowerCase())
    .join(', ');
}

export function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'world'
  );
}

export { HEX };

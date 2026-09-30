// A hosted world: the Game plus everything around it that is not game state —
// who is connected, reconnect tokens, chat, the round timer, host commands.
//
// Transport-agnostic. The host environment (Node server, host's browser, solo
// play) attaches connection objects with `send(text)` and optional `close()`,
// forwards every decoded message to receive(), and calls tick() about once a
// second so the round timer fires even when nobody is sending anything.

import { Game, PROTOCOL, normalizeState } from './game.js';
import * as R from './rules.js';

const LOBBY_GRACE_MS = 20000;
const CHAT_KEEP = 80;
const RATE_BURST = 120;
const RATE_PER_SEC = 60;
const CURSOR_MIN_MS = 45;

export function randomToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const ok = () => ({ ok: true });
const fail = (err) => ({ ok: false, err });

function uniqueName(game, name, self = 0) {
  const taken = new Set(
    Object.values(game.s.players)
      .filter((p) => p.id !== self)
      .map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, R.LIMITS.playerName - 3)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function freeColor(game, wanted, self = 0) {
  const used = new Set(
    Object.values(game.s.players)
      .filter((p) => p.id !== self && !p.spectator)
      .map((p) => p.color),
  );
  if (R.GOD_COLORS.includes(wanted) && !used.has(wanted)) return wanted;
  return R.GOD_COLORS.find((c) => !used.has(c)) ?? R.GOD_COLORS[0];
}

export class Room {
  constructor({ code = '', settings, save = null, now = () => Date.now(), log = () => {} } = {}) {
    this.code = code;
    this.now = now;
    this.log = log;
    this.clients = new Map();
    this.tokens = new Map();
    this.chat = [];
    this.deadline = 0;
    this.offlineSince = new Map();
    this.kicked = new Set();
    this.reservedHost = 0;
    this.onUpdate = null;
    if (save) {
      this.game = new Game(normalizeState(save.state));
      for (const [token, pid] of Array.isArray(save.tokens) ? save.tokens : []) {
        if (typeof token === 'string' && this.game.s.players[pid]) this.tokens.set(token, pid);
      }
      if (Array.isArray(save.chat)) {
        this.chat = save.chat
          .filter((m) => m && typeof m.text === 'string')
          .slice(-CHAT_KEEP)
          .map((m) => ({ t: 'chat', sys: m.sys === true, pid: m.pid, name: String(m.name ?? ''), color: m.color, text: m.text, ts: m.ts }));
      }
      // The saved host keeps the role while everyone finds their way back.
      if (this.game.s.players[save.host]) {
        this.game.s.host = save.host;
        this.reservedHost = save.host;
      }
      if (this.game.s.phase === 'playing') this.startTimer(false);
    } else {
      this.game = Game.create(settings);
    }
  }

  // ------------------------------------------------ connections

  attach(conn) {
    this.clients.set(conn, { pid: 0, token: '', budget: RATE_BURST, at: this.now(), cursorAt: 0 });
  }

  detach(conn) {
    const c = this.clients.get(conn);
    if (!c) return;
    this.clients.delete(conn);
    if (c.pid) this.leave(c.pid);
  }

  get online() {
    let n = 0;
    for (const c of this.clients.values()) if (c.pid) n++;
    return n;
  }

  connected(pid) {
    for (const c of this.clients.values()) if (c.pid === pid) return true;
    return false;
  }

  leave(pid) {
    const g = this.game;
    const p = g.s.players[pid];
    if (!p || this.connected(pid)) return;
    g.updatePlayer(pid, { online: false, ready: false });
    this.offlineSince.set(pid, this.now());
    if (g.s.host === pid) this.passHost();
    this.system(`${p.name} left.`);
    if (g.allReady()) this.endRound();
    this.flush();
  }

  passHost() {
    const g = this.game;
    const candidates = Object.values(g.s.players)
      .filter((p) => p.online && p.id !== g.s.host)
      .sort((a, b) => Number(a.spectator) - Number(b.spectator) || a.id - b.id);
    if (!candidates.length) return;
    g.setHost(candidates[0].id);
    this.system(`${candidates[0].name} is now the host.`);
  }

  // ------------------------------------------------ messages

  receive(conn, msg) {
    const c = this.clients.get(conn);
    if (!c || !msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (!this.allow(c)) return;
    try {
      if (!c.pid) {
        if (msg.t === 'join') this.join(conn, c, msg);
        else if (msg.t === 'ping') this.sendTo(conn, { t: 'pong' });
      } else {
        this.handle(conn, c, msg);
      }
    } catch (error) {
      this.log(error);
      this.sendTo(conn, { t: 'notice', level: 'error', text: `The host hit a snag: ${error.message}` });
    }
    this.tick();
  }

  allow(c) {
    const now = this.now();
    c.budget = Math.min(RATE_BURST, c.budget + ((now - c.at) / 1000) * RATE_PER_SEC);
    c.at = now;
    if (c.budget < 1) return false;
    c.budget -= 1;
    return true;
  }

  handle(conn, c, msg) {
    const g = this.game;
    const pid = c.pid;
    switch (msg.t) {
      case 'act': {
        const res = g.act(pid, msg.a);
        this.sendTo(conn, { t: 'ack', seq: msg.seq, ok: res.ok, err: res.err, cost: res.cost, type: msg.a?.type });
        break;
      }
      case 'rename': {
        const res = g.rename(pid, msg);
        this.sendTo(conn, { t: 'ack', seq: msg.seq, ok: res.ok, err: res.err, type: 'rename' });
        break;
      }
      case 'ready':
        g.setReady(pid, msg.v === true);
        if (g.allReady()) this.endRound();
        break;
      case 'chat':
        this.say(pid, msg.text);
        break;
      case 'cursor': {
        const now = this.now();
        if (now - c.cursorAt < CURSOR_MIN_MS) break;
        c.cursorAt = now;
        const i = Number.isInteger(msg.i) && msg.i >= 0 && msg.i < g.grid.N ? msg.i : -1;
        this.broadcast({ t: 'cursor', pid, i, tool: typeof msg.tool === 'string' ? msg.tool.slice(0, 12) : '' }, conn);
        break;
      }
      case 'profile':
        this.profile(conn, pid, msg);
        break;
      case 'host':
        this.hostCommand(conn, c, msg);
        break;
      case 'leave':
        this.clients.delete(conn);
        this.depart(pid);
        conn.close?.();
        break;
      case 'ping':
        this.sendTo(conn, { t: 'pong' });
        break;
      default:
        break;
    }
  }

  // A deliberate exit: gone at once from a lobby, offline in a running world.
  depart(pid) {
    const g = this.game;
    if (g.s.phase === 'lobby' && !this.connected(pid)) {
      const p = g.s.players[pid];
      if (!p) return;
      g.updatePlayer(pid, { online: false });
      if (g.s.host === pid) this.passHost();
      g.removePlayer(pid);
      this.forget(pid);
      this.system(`${p.name} left.`);
      this.flush();
    } else {
      this.leave(pid);
    }
  }

  forget(pid) {
    for (const [token, owner] of this.tokens) if (owner === pid) this.tokens.delete(token);
    this.offlineSince.delete(pid);
  }

  join(conn, c, msg) {
    const g = this.game;
    if (msg.protocol !== PROTOCOL) {
      this.sendTo(conn, { t: 'error', code: 'protocol', text: 'This world runs a different version of CTB World. Reload the page.' });
      return;
    }
    const name = R.cleanText(msg.name, R.LIMITS.playerName) || 'Nameless';
    let token = typeof msg.token === 'string' ? msg.token : '';
    let p = this.tokens.has(token) ? g.s.players[this.tokens.get(token)] : null;
    if (!p) {
      // No valid token: a god who is offline can be reclaimed by name.
      p = Object.values(g.s.players).find((x) => !x.online && !this.kicked.has(x.id) && x.name.toLowerCase() === name.toLowerCase()) ?? null;
      token = '';
    }
    if (p) {
      for (const [other, oc] of this.clients) {
        if (oc.pid === p.id && other !== conn) {
          oc.pid = 0;
          this.sendTo(other, { t: 'error', code: 'replaced', text: 'You joined this world from another tab or device.' });
          other.close?.();
        }
      }
      g.updatePlayer(p.id, { online: true });
      this.offlineSince.delete(p.id);
      this.system(`${p.name} returned.`);
    } else {
      const spectator = msg.spectate === true || g.activePlayers().length >= R.LIMITS.players;
      p = g.addPlayer({
        name: uniqueName(g, name),
        color: freeColor(g, msg.color),
        domain: Object.hasOwn(R.DOMAINS, msg.domain) ? msg.domain : R.DOMAIN_KEYS[Math.floor(Math.random() * R.DOMAIN_KEYS.length)],
        spectator,
      });
      this.system(spectator ? `${p.name} came to watch.` : `${p.name} joined the pantheon.`);
    }
    if (!token) {
      token = randomToken();
      this.tokens.set(token, p.id);
    }
    if (p.id === this.reservedHost) this.reservedHost = 0;
    if (!g.s.host || (!g.s.players[g.s.host]?.online && !this.reservedHost)) g.setHost(p.id);
    // Everyone already here hears about the arrival first; the newcomer gets
    // all of it in the snapshot.
    this.flush();
    c.pid = p.id;
    c.token = token;
    this.sendWelcome(conn, c);
  }

  sendWelcome(conn, c) {
    this.sendTo(conn, {
      t: 'welcome',
      protocol: PROTOCOL,
      code: this.code,
      you: c.pid,
      token: c.token,
      state: this.game.snapshot(),
      chat: this.chat,
      remaining: this.remaining(),
    });
  }

  welcomeAll() {
    for (const [conn, c] of this.clients) if (c.pid) this.sendWelcome(conn, c);
  }

  profile(conn, pid, msg) {
    const g = this.game;
    const p = g.s.players[pid];
    if (g.s.phase !== 'lobby') {
      this.notice(conn, 'Your name, colour and domain are fixed once the world begins.');
      return;
    }
    const changes = {};
    if (msg.name !== undefined) {
      const name = R.cleanText(msg.name, R.LIMITS.playerName);
      if (name && name !== p.name) changes.name = uniqueName(g, name, pid);
    }
    if (msg.color !== undefined) {
      if (freeColor(g, msg.color, pid) === msg.color) changes.color = msg.color;
      else this.notice(conn, 'Another god already wears that colour.');
    }
    if (Object.hasOwn(R.DOMAINS, msg.domain)) changes.domain = msg.domain;
    g.updatePlayer(pid, changes);
  }

  say(pid, text) {
    const p = this.game.s.players[pid];
    const clean = R.cleanText(text, R.LIMITS.chat);
    if (!p || !clean) return;
    this.pushChat({ t: 'chat', pid, name: p.name, color: p.color, text: clean, ts: this.now() });
  }

  system(text) {
    this.pushChat({ t: 'chat', sys: true, text, ts: this.now() });
  }

  pushChat(message) {
    this.chat.push(message);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.broadcast(message);
  }

  notice(conn, text, level = 'error') {
    this.sendTo(conn, { t: 'notice', level, text });
  }

  // ------------------------------------------------ host commands

  hostCommand(conn, c, msg) {
    const g = this.game;
    if (g.s.host !== c.pid) {
      this.notice(conn, 'Only the host can do that.');
      return;
    }
    let res = ok();
    switch (msg.cmd) {
      case 'settings':
        res = g.setSettings(msg.settings);
        break;
      case 'reroll':
        res = g.reroll();
        break;
      case 'start':
        res = g.start();
        if (res.ok) {
          this.flush();
          this.startTimer();
        }
        break;
      case 'endRound':
        this.endRound();
        break;
      case 'endGame':
        if (g.s.phase === 'playing') {
          g.finish();
          this.flush();
          this.stopTimer();
        }
        break;
      case 'restart':
        if (g.s.phase !== 'lobby') {
          g.restart();
          g.flush();
          this.stopTimer(false);
          this.system('A new world was born.');
          this.welcomeAll();
          this.changed();
        }
        break;
      case 'kick':
        res = this.kick(msg.pid);
        break;
      case 'handover': {
        const target = g.s.players[msg.pid];
        if (!target?.online) res = fail('Hand the world to someone who is here.');
        else {
          g.setHost(target.id);
          this.system(`${target.name} is now the host.`);
        }
        break;
      }
      case 'load':
        res = this.load(msg.state, c.pid);
        break;
      default:
        res = fail('Unknown command.');
    }
    if (!res.ok) this.notice(conn, res.err);
  }

  kick(pid) {
    const g = this.game;
    const p = g.s.players[pid];
    if (!p || pid === g.s.host) return fail('You cannot remove that god.');
    for (const [conn, c] of this.clients) {
      if (c.pid !== pid) continue;
      this.sendTo(conn, { t: 'error', code: 'kicked', text: 'The host removed you from this world.' });
      c.pid = 0;
      conn.close?.();
    }
    this.forget(pid);
    if (g.s.phase === 'lobby') g.removePlayer(pid);
    else {
      g.updatePlayer(pid, { online: false, ready: false });
      this.kicked.add(pid);
    }
    this.system(`${p.name} was removed by the host.`);
    if (g.allReady()) this.endRound();
    return ok();
  }

  // Replaces the world with a saved one. Players here are matched to the saved
  // gods by name; anyone unmatched joins as a new god.
  load(raw, hostPid) {
    const g = this.game;
    if (g.s.phase !== 'lobby') return fail('Load a world from the lobby, before the game starts.');
    let next;
    try {
      next = new Game(normalizeState(raw));
    } catch (error) {
      return fail(`That file could not be loaded: ${error.message}`);
    }
    const map = new Map();
    const claimed = new Set();
    for (const c of this.clients.values()) {
      if (!c.pid || map.has(c.pid)) continue;
      const cur = g.s.players[c.pid];
      if (!cur) continue;
      let target = Object.values(next.s.players).find((p) => !claimed.has(p.id) && p.name.toLowerCase() === cur.name.toLowerCase());
      if (!target) {
        target = next.addPlayer({
          name: uniqueName(next, cur.name),
          color: freeColor(next, cur.color),
          domain: cur.domain,
          spectator: cur.spectator || next.activePlayers().length >= R.LIMITS.players,
        });
      }
      claimed.add(target.id);
      next.updatePlayer(target.id, { online: true, ready: false });
      map.set(c.pid, target.id);
    }
    for (const c of this.clients.values()) if (c.pid) c.pid = map.get(c.pid) ?? 0;
    const tokens = new Map();
    for (const [token, pid] of this.tokens) if (map.has(pid)) tokens.set(token, map.get(pid));
    this.tokens = tokens;
    next.s.host = map.get(hostPid) ?? 0;
    next.flush();
    this.game = next;
    this.offlineSince.clear();
    this.kicked.clear();
    if (next.s.phase === 'playing') this.startTimer(false);
    else this.stopTimer(false);
    this.system(`The host loaded the world of ${next.s.settings.worldName}.`);
    this.welcomeAll();
    this.changed();
    return ok();
  }

  // ------------------------------------------------ time

  startTimer(announce = true) {
    const secs = this.game.s.settings.roundTime;
    this.deadline = this.game.s.phase === 'playing' && secs > 0 ? this.now() + secs * 1000 : 0;
    if (announce) this.broadcast({ t: 'timer', remaining: this.remaining() });
  }

  stopTimer(announce = true) {
    this.deadline = 0;
    if (announce) this.broadcast({ t: 'timer', remaining: null });
  }

  remaining() {
    return this.deadline ? Math.max(0, this.deadline - this.now()) : null;
  }

  endRound() {
    const g = this.game;
    if (g.s.phase !== 'playing') return;
    g.endRound();
    this.flush();
    if (g.s.phase === 'playing') this.startTimer();
    else this.stopTimer();
  }

  tick() {
    const g = this.game;
    const now = this.now();
    if (this.deadline && g.s.phase === 'playing' && now >= this.deadline) this.endRound();
    if (g.s.phase === 'lobby') {
      for (const [pid, since] of this.offlineSince) {
        if (now - since < LOBBY_GRACE_MS) continue;
        this.offlineSince.delete(pid);
        const p = g.s.players[pid];
        if (p && !p.online) {
          g.removePlayer(pid);
          this.forget(pid);
        }
      }
    }
    this.flush();
  }

  // ------------------------------------------------ output

  flush() {
    const patch = this.game.flush();
    if (!patch) return;
    this.broadcast(patch);
    this.changed();
  }

  changed() {
    this.onUpdate?.();
  }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const [conn, c] of this.clients) if (c.pid && conn !== except) this.safeSend(conn, text);
  }

  sendTo(conn, msg) {
    this.safeSend(conn, JSON.stringify(msg));
  }

  safeSend(conn, text) {
    try {
      conn.send(text);
    } catch (error) {
      this.log(error);
    }
  }

  exportSave() {
    return {
      app: 'ctb-world',
      kind: 'room',
      v: 1,
      code: this.code,
      savedAt: this.now(),
      host: this.game.s.host,
      tokens: [...this.tokens],
      chat: this.chat.slice(-CHAT_KEEP),
      state: this.game.snapshot(),
    };
  }

  close() {
    for (const conn of this.clients.keys()) {
      try {
        conn.close?.();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}

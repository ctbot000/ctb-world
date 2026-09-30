// The client's replica of the world, rebuilt from the host's welcome snapshot
// and kept current by its patches. Emits `change` with what changed, so views
// can redraw only what they need.

import { applyPatch, computeScores } from './shared/game.js';
import { Grid } from './shared/hex.js';

const CHAT_KEEP = 200;

export class Store extends EventTarget {
  state = null;
  grid = null;
  me = 0;
  code = '';
  token = '';
  chat = [];
  unread = 0;
  cursors = new Map();
  deadline = null;
  at = new Map();

  get player() {
    return this.state?.players[this.me] ?? null;
  }

  get isHost() {
    return Boolean(this.state) && this.state.host === this.me;
  }

  get phase() {
    return this.state?.phase ?? 'lobby';
  }

  get sandbox() {
    return this.state?.settings.mode === 'sandbox';
  }

  welcome(msg) {
    this.state = msg.state;
    this.me = msg.you;
    this.code = msg.code;
    this.token = msg.token;
    this.chat = Array.isArray(msg.chat) ? msg.chat.slice(-CHAT_KEEP) : [];
    this.unread = 0;
    this.cursors.clear();
    this.setRemaining(msg.remaining);
    this.grid = new Grid(this.state.W, this.state.H);
    this.index();
    this.emit({ all: true, welcome: true });
  }

  patch(msg) {
    if (!this.state) return;
    const before = { phase: this.state.phase, age: this.state.age, round: this.state.round, era: this.state.era };
    applyPatch(this.state, msg);
    if (msg.w) this.grid = new Grid(this.state.W, this.state.H);
    if (msg.st || msg.w) this.index();
    this.emit({
      tiles: Boolean(msg.tl || msg.w),
      world: Boolean(msg.w),
      meta: Boolean(msg.m),
      players: Boolean(msg.pl),
      races: Boolean(msg.rc),
      settlements: Boolean(msg.st),
      labels: Boolean(msg.lb),
      relations: Boolean(msg.rl),
      ruins: Boolean(msg.ru),
      chronicle: msg.ch ?? null,
      tileList: msg.tl ?? null,
      before,
    });
  }

  addChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.emit({ chat: msg });
  }

  setCursor(pid, i, tool) {
    if (i < 0) this.cursors.delete(pid);
    else this.cursors.set(pid, { i, tool, at: performance.now() });
    this.emit({ cursors: true });
  }

  setRemaining(remaining) {
    this.deadline = typeof remaining === 'number' ? performance.now() + remaining : null;
    this.emit({ timer: true });
  }

  secondsLeft() {
    if (this.deadline == null) return null;
    return Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000));
  }

  index() {
    this.at.clear();
    for (const st of Object.values(this.state.settlements)) this.at.set(st.i, st);
  }

  settlementAt(i) {
    return this.at.get(i) ?? null;
  }

  labelAt(i) {
    return Object.values(this.state.labels).find((l) => l.i === i) ?? null;
  }

  scores() {
    return computeScores(this.state);
  }

  emit(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }
}

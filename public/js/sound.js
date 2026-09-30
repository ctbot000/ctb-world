// Small synthesized sound effects. No audio files: every sound is a few
// oscillators with an envelope. Off until the first user gesture, as browsers
// require, and mutable.

import { load, save } from './storage.js';

let ctx = null;
let master = null;
let muted = load('muted', false);
const last = new Map();

function audio() {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, { at = 0, dur = 0.18, type = 'sine', gain = 0.5, slide = 0 } = {}) {
  const a = audio();
  if (!a || a.state !== 'running') return;
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const env = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const SOUNDS = {
  shape: () => tone(330 + Math.random() * 60, { dur: 0.08, type: 'triangle', gain: 0.18 }),
  deed: () => {
    tone(523, { dur: 0.22, type: 'triangle', gain: 0.3 });
    tone(784, { at: 0.06, dur: 0.3, type: 'sine', gain: 0.22 });
  },
  error: () => tone(160, { dur: 0.22, type: 'square', gain: 0.12, slide: 0.7 }),
  round: () => {
    for (const [k, f] of [523, 659, 784].entries()) tone(f, { at: k * 0.09, dur: 0.6, type: 'sine', gain: 0.22 });
  },
  age: () => {
    for (const [k, f] of [392, 523, 659, 784, 1046].entries()) tone(f, { at: k * 0.12, dur: 0.9, type: 'triangle', gain: 0.2 });
  },
  war: () => {
    tone(98, { dur: 0.35, type: 'sawtooth', gain: 0.2, slide: 0.6 });
    tone(73, { at: 0.18, dur: 0.4, type: 'sawtooth', gain: 0.18, slide: 0.6 });
  },
  wonder: () => {
    for (const [k, f] of [659, 831, 988, 1319].entries()) tone(f, { at: k * 0.07, dur: 0.5, type: 'sine', gain: 0.18 });
  },
  chat: () => tone(880, { dur: 0.07, type: 'sine', gain: 0.12 }),
  join: () => {
    tone(587, { dur: 0.15, type: 'sine', gain: 0.18 });
    tone(880, { at: 0.1, dur: 0.25, type: 'sine', gain: 0.18 });
  },
};

export function play(name, minGapMs = 60) {
  if (muted) return;
  const now = performance.now();
  if (now - (last.get(name) ?? -1e9) < minGapMs) return;
  last.set(name, now);
  try {
    SOUNDS[name]?.();
  } catch {
    // audio is best-effort
  }
}

// Browsers only let audio start from a user gesture.
export function unlock() {
  audio();
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  save('muted', value);
  if (value && ctx) ctx.suspend().catch(() => {});
  if (!value) audio();
}

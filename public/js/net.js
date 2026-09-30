// Links between the page and a world. Whatever the transport, a link is an
// EventTarget that emits `message` (a decoded message from the room) and
// `status` ({ state, text }), and has send(msg) and close().
//
//   HostLink   the world runs in this page: solo play, or hosting for others
//              over WebRTC data channels (PeerJS for signaling)
//   GuestLink  joins a world hosted in someone else's page
//   WsLink     joins or creates a world on the dedicated Node server
//
// States: connecting, online, offline (solo), reconnecting, id-taken, failed.

import { generateCode, peerIdFor } from './shared/codes.js';
import { Room } from './shared/room.js';

const CHUNK = 16000;
const PING_MS = 4000;
const SILENCE_MS = 16000;
const CONNECT_TIMEOUT_MS = 20000;
const PEER_START_TIMEOUT_MS = 15000;
const OFFLINE_RETRY_MS = 3000;
const MAX_RETRY_MS = 10000;
const RECONNECT_CONFIRM_MS = 5000;
// PeerServer holds undeliverable messages for 5 s before reporting them, once each.
const ECHO_WINDOW_MS = 4000;

// ---------------------------------------------------------------- framing

// Data channels cap message size, so long texts travel in pieces. Pieces never
// split a surrogate pair, which would not survive UTF-8 encoding.
export function splitText(text, size = CHUNK) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

let pieceSeq = 0;

export function sendText(conn, text) {
  if (text.length <= CHUNK) {
    conn.send(text);
    return;
  }
  const parts = splitText(text);
  const id = (++pieceSeq).toString(36);
  parts.forEach((part, k) => conn.send(`~${id}:${k}:${parts.length}:${part}`));
}

export class Reassembler {
  constructor() {
    this.pending = new Map();
  }

  // Returns the whole text once every piece has arrived, else null.
  accept(data) {
    if (data[0] !== '~') return data;
    const m = /^~([0-9a-z]+):(\d+):(\d+):/.exec(data);
    if (!m) return null;
    const [head, id, k, total] = m;
    const n = Number(total);
    if (n < 1 || n > 4096) return null;
    let entry = this.pending.get(id);
    if (!entry) {
      entry = { parts: new Array(n), count: 0 };
      this.pending.set(id, entry);
      if (this.pending.size > 16) this.pending.delete(this.pending.keys().next().value);
    }
    const index = Number(k);
    if (index >= n || entry.parts[index] !== undefined) return null;
    entry.parts[index] = data.slice(head.length);
    entry.count++;
    if (entry.count < n) return null;
    this.pending.delete(id);
    return entry.parts.join('');
  }
}

function parse(text) {
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

// PeerJS options from the page URL: the public PeerJS cloud unless
// ?signal=https://host:port/path names a self-hosted PeerServer; ?debug=1..3
// turns on PeerJS logging.
export function signalingOptions(params) {
  const options = {};
  const debug = Number.parseInt(params.get('debug') ?? '', 10);
  if (debug > 0) options.debug = Math.min(debug, 3);
  const raw = params.get('signal');
  if (!raw) return options;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`The signaling server address "${raw}" is not a valid URL.`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`The signaling server address must start with https:// or http:// (got "${raw}").`);
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  options.host = url.hostname;
  options.port = Number(url.port) || (secure ? 443 : 80);
  options.path = url.pathname || '/';
  options.secure = secure;
  const key = url.searchParams.get('key');
  if (key) options.key = key;
  return options;
}

class Link extends EventTarget {
  state = 'idle';
  statusText = '';

  setStatus(state, text = '') {
    if (state === this.state && text === this.statusText) return;
    this.state = state;
    this.statusText = text;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, text } }));
  }

  deliver(msg) {
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }
}

// ---------------------------------------------------------------- host

export class HostLink extends Link {
  constructor({ settings, save = null, online = false, peerOptions = {} } = {}) {
    super();
    this.online = online;
    this.peerOptions = peerOptions;
    this.fixedCode = Boolean(save?.code);
    this.room = new Room({
      code: save?.code || generateCode(),
      settings,
      save,
      log: (error) => console.error(error),
    });
    this.local = {
      send: (text) => queueMicrotask(() => this.deliver(JSON.parse(text))),
      close() {},
    };
    this.room.attach(this.local);
    this.guests = new Map();
    this.peer = null;
    this.everOnline = false;
    this.retryDelay = 1000;
    this.retryTimer = 0;
    this.closed = false;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  get code() {
    return this.room.code;
  }

  get guestCount() {
    return this.guests.size;
  }

  start(joinMessage) {
    this.send(joinMessage());
    if (this.online) this.connect();
    else this.setStatus('offline', 'Playing alone');
  }

  send(msg) {
    const copy = JSON.parse(JSON.stringify(msg));
    queueMicrotask(() => {
      if (!this.closed) this.room.receive(this.local, copy);
    });
  }

  tick() {
    this.room.tick();
    const now = Date.now();
    for (const guest of [...this.guests.values()]) {
      if (now - guest.lastSeen > SILENCE_MS) this.dropGuest(guest);
    }
  }

  connect() {
    if (this.closed) return;
    if (typeof Peer === 'undefined') {
      this.setStatus('failed', 'Online play is unavailable because PeerJS did not load. You can still play alone.');
      return;
    }
    if (this.state === 'idle' || this.state === 'offline') this.setStatus('connecting', 'Opening your world to other players…');
    const peer = new Peer(peerIdFor(this.code), this.peerOptions);
    this.peer = peer;
    peer.on('open', () => {
      if (peer !== this.peer) return;
      this.retryDelay = 1000;
      this.everOnline = true;
      this.setStatus('online', 'Others can join with the code');
    });
    peer.on('connection', (conn) => {
      if (peer === this.peer && !this.closed) this.addGuest(conn);
      else conn.close();
    });
    peer.on('call', (call) => call.close());
    // `disconnected`: the signaling socket dropped but the peer can reconnect.
    // `close`: the peer was destroyed. Guests already connected are unaffected
    // either way; only new guests have to wait.
    peer.on('disconnected', () => this.recover(peer));
    peer.on('close', () => this.recover(peer));
    peer.on('error', (error) => this.onPeerError(peer, error));
  }

  recover(peer) {
    if (this.closed || peer !== this.peer) return;
    if (this.state !== 'id-taken') this.setStatus('reconnecting', 'Reconnecting to the signaling server…');
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      if (this.closed || peer !== this.peer) return;
      if (peer.destroyed) this.connect();
      else if (peer.disconnected) {
        peer.reconnect();
        this.confirmReconnect(peer);
      }
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
  }

  // PeerServer confirms a reconnect with OPEN only if it had already dropped the
  // old socket; otherwise it moves the session silently and `open` never fires.
  confirmReconnect(peer) {
    setTimeout(() => {
      if (this.closed || peer !== this.peer || peer.open || peer.disconnected || peer.destroyed) return;
      if (peer.socket?._wsOpen?.()) {
        this.retryDelay = 1000;
        this.setStatus('online', 'Others can join with the code');
      } else {
        peer.destroy();
      }
    }, RECONNECT_CONFIRM_MS);
  }

  onPeerError(peer, error) {
    if (this.closed || peer !== this.peer) return;
    switch (error.type) {
      case 'unavailable-id':
        if (!this.fixedCode && !this.everOnline) {
          // A brand-new world whose random code is taken: pick another.
          this.room.code = generateCode();
          this.dispatchEvent(new CustomEvent('code', { detail: this.room.code }));
        } else {
          this.setStatus('id-taken', 'This world is still registered from an earlier session. Retrying…');
        }
        break;
      case 'browser-incompatible':
        this.fail('This browser does not support WebRTC, so others cannot join. You can still play alone.');
        break;
      case 'invalid-id':
      case 'invalid-key':
      case 'ssl-unavailable':
        this.fail(`The signaling server refused the connection (${error.type}).`);
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        if (this.state !== 'id-taken') this.setStatus('reconnecting', 'Cannot reach the signaling server. Retrying…');
        break;
      default:
      // peer-unavailable, webrtc: about one guest's connection, which cleans up on its own.
    }
  }

  fail(text) {
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    const peer = this.peer;
    this.peer = null;
    peer?.destroy();
    this.setStatus('failed', text);
  }

  addGuest(conn) {
    const guest = { conn, adapter: null, lastSeen: Date.now(), pieces: new Reassembler(), closed: false };
    conn.on('open', () => {
      if (this.closed || guest.closed) {
        conn.close();
        return;
      }
      guest.lastSeen = Date.now();
      guest.adapter = {
        send: (text) => {
          if (conn.open) sendText(conn, text);
        },
        close: () => setTimeout(() => this.dropGuest(guest), 200),
      };
      this.guests.set(conn, guest);
      this.room.attach(guest.adapter);
    });
    conn.on('data', (data) => {
      guest.lastSeen = Date.now();
      if (!guest.adapter || typeof data !== 'string') return;
      const text = guest.pieces.accept(data);
      const msg = text == null ? null : parse(text);
      if (msg) this.room.receive(guest.adapter, msg);
    });
    conn.on('close', () => this.dropGuest(guest));
    conn.on('error', () => this.dropGuest(guest));
  }

  dropGuest(guest) {
    if (guest.closed) return;
    guest.closed = true;
    this.guests.delete(guest.conn);
    if (guest.adapter) this.room.detach(guest.adapter);
    try {
      guest.conn.close();
    } catch {
      // already closed
    }
  }

  exportSave() {
    return this.room.exportSave();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    for (const guest of [...this.guests.values()]) this.dropGuest(guest);
    const peer = this.peer;
    this.peer = null;
    // Leave the signaling server first, so the code is free at once.
    if (peer && !peer.disconnected) peer.disconnect();
    peer?.destroy();
    this.room.close();
  }
}

// ---------------------------------------------------------------- guest

export class GuestLink extends Link {
  constructor({ code, peerOptions = {} }) {
    super();
    this.code = code;
    this.target = peerIdFor(code);
    this.peerOptions = peerOptions;
    this.peer = null;
    this.peerStartedAt = 0;
    this.conn = null;
    this.pieces = new Reassembler();
    this.lastSeen = 0;
    this.dialStartedAt = 0;
    this.dialTimer = 0;
    this.connectTimer = 0;
    this.retryDelay = 1000;
    this.heard = false;
    this.closed = false;
  }

  start(joinMessage) {
    this.joinMessage = joinMessage;
    this.heartbeat = setInterval(() => this.tick(), PING_MS);
    this.setStatus('connecting', 'Looking for the world…');
    if (typeof Peer === 'undefined') {
      this.setStatus('failed', 'Online play is unavailable because PeerJS did not load.');
      return;
    }
    this.createPeer();
  }

  send(msg) {
    if (this.conn?.open && this.heard) sendText(this.conn, JSON.stringify(msg));
  }

  // Our own peer id is random and disposable, so a peer that loses the
  // signaling server is replaced rather than reconnected.
  createPeer() {
    const peer = new Peer(this.peerOptions);
    this.peer = peer;
    this.peerStartedAt = Date.now();
    peer.on('open', () => {
      if (peer === this.peer && !this.conn) this.dial();
    });
    peer.on('connection', (conn) => conn.close());
    peer.on('call', (call) => call.close());
    peer.on('disconnected', () => this.signalingLost(peer));
    peer.on('close', () => this.signalingLost(peer));
    peer.on('error', (error) => this.onPeerError(peer, error));
  }

  replacePeer() {
    const old = this.peer;
    this.peer = null;
    old?.destroy();
    this.createPeer();
  }

  // An open data connection keeps working without signaling; a dial in
  // progress needs it, so start that one again.
  signalingLost(peer) {
    if (this.closed || peer !== this.peer || (this.conn?.open && this.heard)) return;
    this.hangUp();
    if (!this.dialTimer) this.scheduleDial(this.nextDelay());
  }

  onPeerError(peer, error) {
    if (this.closed || peer !== this.peer) return;
    switch (error.type) {
      case 'peer-unavailable':
        // Reported once per undeliverable message, a few seconds late: anything
        // soon after a dial, or while a redial is pending, is an echo.
        if (this.dialTimer || Date.now() - this.dialStartedAt < ECHO_WINDOW_MS) return;
        this.hangUp();
        this.setStatus('offline', 'The host of this world is not online. Waiting for them…');
        this.scheduleDial(OFFLINE_RETRY_MS);
        break;
      case 'browser-incompatible':
        this.fail('This browser does not support WebRTC, so it cannot join online worlds.');
        break;
      case 'invalid-id':
      case 'invalid-key':
      case 'ssl-unavailable':
        this.fail(`The signaling server refused the connection (${error.type}).`);
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        if (!this.heard) this.setStatus('reconnecting', 'Cannot reach the signaling server. Retrying…');
        break;
      default:
      // webrtc, disconnected: the dial they belong to fails or times out on its own.
    }
  }

  dial() {
    clearTimeout(this.dialTimer);
    this.dialTimer = 0;
    if (this.closed) return;
    const peer = this.peer;
    if (!peer?.open) {
      const starting = peer && !peer.disconnected && !peer.destroyed && Date.now() - this.peerStartedAt < PEER_START_TIMEOUT_MS;
      if (starting) this.scheduleDial(PEER_START_TIMEOUT_MS);
      else this.replacePeer();
      return;
    }
    this.hangUp();
    const conn = peer.connect(this.target, { serialization: 'raw', reliable: true });
    if (!conn) {
      this.scheduleDial(this.nextDelay());
      return;
    }
    this.conn = conn;
    this.pieces = new Reassembler();
    this.lastSeen = this.dialStartedAt = Date.now();
    this.connectTimer = setTimeout(() => {
      if (this.conn === conn && !this.heard) this.lost();
    }, CONNECT_TIMEOUT_MS);
    conn.on('open', () => {
      if (this.conn !== conn) return;
      this.lastSeen = Date.now();
      sendText(conn, JSON.stringify(this.joinMessage()));
    });
    conn.on('data', (data) => {
      if (this.conn !== conn || typeof data !== 'string') return;
      this.lastSeen = Date.now();
      const text = this.pieces.accept(data);
      const msg = text == null ? null : parse(text);
      if (!msg) return;
      if (msg.t === 'welcome') {
        clearTimeout(this.connectTimer);
        this.heard = true;
        this.retryDelay = 1000;
        this.setStatus('online', 'Connected to the host');
      }
      this.deliver(msg);
    });
    conn.on('close', () => {
      if (this.conn === conn) this.lost();
    });
    conn.on('error', () => {
      if (this.conn === conn) this.lost();
    });
  }

  lost() {
    this.hangUp();
    if (this.closed) return;
    this.setStatus('reconnecting', 'Lost the connection to the host. Reconnecting…');
    this.scheduleDial(this.nextDelay());
  }

  nextDelay() {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    return delay;
  }

  scheduleDial(delay) {
    clearTimeout(this.dialTimer);
    this.dialTimer = setTimeout(() => this.dial(), delay);
  }

  hangUp() {
    clearTimeout(this.connectTimer);
    const conn = this.conn;
    this.conn = null;
    this.heard = false;
    conn?.close();
  }

  tick() {
    if (!this.conn?.open || !this.heard) return;
    if (Date.now() - this.lastSeen > SILENCE_MS) {
      this.lost();
      return;
    }
    sendText(this.conn, JSON.stringify({ t: 'ping' }));
  }

  fail(text) {
    this.hangUp();
    clearTimeout(this.dialTimer);
    this.dialTimer = 0;
    const peer = this.peer;
    this.peer = null;
    peer?.destroy();
    this.setStatus('failed', text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.dialTimer);
    if (this.conn?.open && this.heard) sendText(this.conn, JSON.stringify({ t: 'leave' }));
    const conn = this.conn;
    this.conn = null;
    clearTimeout(this.connectTimer);
    setTimeout(() => {
      conn?.close();
      this.peer?.destroy();
    }, 150);
  }
}

// ---------------------------------------------------------------- server

export class WsLink extends Link {
  constructor({ url }) {
    super();
    this.url = url;
    this.ws = null;
    this.retryDelay = 1000;
    this.retryTimer = 0;
    this.lastSeen = 0;
    this.closed = false;
  }

  start(firstMessage) {
    this.firstMessage = firstMessage;
    this.heartbeat = setInterval(() => this.tick(), PING_MS);
    this.setStatus('connecting', 'Connecting to the server…');
    this.open();
  }

  open() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      ws.send(JSON.stringify(this.firstMessage()));
    });
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      const msg = parse(event.data);
      if (!msg) return;
      if (msg.t === 'welcome') {
        this.retryDelay = 1000;
        this.setStatus('online', 'Connected to the server');
      }
      this.deliver(msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws || this.closed) return;
      this.ws = null;
      this.setStatus('reconnecting', 'Lost the connection to the server. Reconnecting…');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.open(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  tick() {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastSeen > SILENCE_MS) {
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ t: 'ping' }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'leave' }));
    ws?.close();
  }
}

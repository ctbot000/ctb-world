// A small server-side WebSocket (RFC 6455) implementation on Node built-ins:
// the opening handshake, framing, masking, fragmentation, ping/pong and the
// closing handshake. Text messages only, which is all the game speaks.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE = 4 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Completes the handshake for an `upgrade` request and returns the connection,
// or answers 400 and returns null. `head` holds bytes the HTTP parser already
// read past the handshake: the client's first frames, which must not be lost.
export function acceptUpgrade(req, socket, head, { maxMessage = DEFAULT_MAX_MESSAGE } = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
  );
  const ws = new WebSocketConnection(socket, maxMessage);
  // Replay `head` once the caller has had a chance to attach its listeners.
  if (head?.length) queueMicrotask(() => ws.feed(Buffer.from(head)));
  return ws;
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, maxMessage = DEFAULT_MAX_MESSAGE) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentType = 0;
    this.fragmentSize = 0;
    this.closed = false;
    this.closing = false;
    this.alive = true;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => this.finish(1006));
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed && !this.closing) {
      const frame = this.parse();
      if (!frame) break;
      this.onFrame(frame);
    }
  }

  parse() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    if (b[0] & 0x70) return this.fail(1002, 'Reserved bits set');
    if (!(b[1] & 0x80)) return this.fail(1002, 'Client frames must be masked');
    let length = b[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) return this.fail(1009, 'Message too big');
      length = b.readUInt32BE(6);
      offset = 10;
    }
    if (length > this.maxMessage) return this.fail(1009, 'Message too big');
    if (b.length < offset + 4 + length) return null;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  onFrame({ fin, opcode, payload }) {
    if (opcode & 0x8) {
      if (!fin || payload.length > 125) return this.fail(1002, 'Bad control frame');
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closing) this.frame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        this.closing = true;
        this.socket.end();
        return this.finish(code);
      }
      if (opcode === 0x9) return this.frame(0xa, payload);
      if (opcode === 0xa) {
        this.alive = true;
        return undefined;
      }
      return this.fail(1002, 'Unknown opcode');
    }
    if (opcode === 0x0) {
      if (!this.fragmentType) return this.fail(1002, 'Unexpected continuation frame');
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (this.fragmentType) return this.fail(1002, 'Expected a continuation frame');
      this.fragmentType = opcode;
    } else {
      return this.fail(1002, 'Unknown opcode');
    }
    this.fragmentSize += payload.length;
    if (this.fragmentSize > this.maxMessage) return this.fail(1009, 'Message too big');
    this.fragments.push(payload);
    if (!fin) return undefined;
    const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    const type = this.fragmentType;
    this.fragments = [];
    this.fragmentType = 0;
    this.fragmentSize = 0;
    if (type === 0x2) return this.fail(1003, 'Binary messages are not supported');
    let text;
    try {
      text = utf8.decode(data);
    } catch {
      return this.fail(1007, 'Invalid UTF-8');
    }
    this.alive = true;
    this.emit('message', text);
    return undefined;
  }

  get open() {
    return !this.closed && !this.closing;
  }

  send(text) {
    if (!this.open) return;
    this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  frame(opcode, payload) {
    if (!this.socket.writable) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  ping() {
    if (!this.open) return;
    this.alive = false;
    this.frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed || this.closing) return;
    this.closing = true;
    const text = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.frame(0x8, payload);
    this.socket.end();
    // Give the peer a moment to answer the close, then drop the socket regardless.
    setTimeout(() => this.socket.destroy(), 2000).unref?.();
  }

  fail(code, reason) {
    this.close(code, reason);
    this.finish(code);
    return null;
  }

  terminate() {
    this.socket.destroy();
    this.finish(1006);
  }

  finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.emit('close', code);
  }
}

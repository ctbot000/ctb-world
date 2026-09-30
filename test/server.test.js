// The dedicated server end to end: static files, the WebSocket handshake and
// framing, and whole games played by real WebSocket clients.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { applyPatch, PROTOCOL } from '../public/js/shared/game.js';
import { T, isWater } from '../public/js/shared/rules.js';
import { createGameServer } from '../server/server.js';

let server;
let port;

before(async () => {
  server = createGameServer({ log: () => {} });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  port = server.address().port;
});

after(async () => {
  await server.shutdown();
});

// A WebSocket client that keeps a replica of the world, like the browser does.
class Client {
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.inbox = [];
    this.waiters = [];
    this.state = null;
    this.closed = new Promise((done) => this.ws.addEventListener('close', done));
    this.opened = new Promise((done, fail) => {
      this.ws.addEventListener('open', done);
      this.ws.addEventListener('error', fail);
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.t === 'welcome') {
        this.state = msg.state;
        this.you = msg.you;
        this.token = msg.token;
        this.code = msg.code;
      } else if (msg.t === 'patch' && this.state) {
        applyPatch(this.state, msg);
      }
      this.inbox.push(msg);
      for (const w of [...this.waiters]) w();
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  // Resolves with the first message (old or new) matching pred, and consumes it.
  next(pred, timeout = 3000) {
    return new Promise((done, fail) => {
      const check = () => {
        const index = this.inbox.findIndex(pred);
        if (index < 0) return false;
        const [msg] = this.inbox.splice(index, 1);
        this.waiters = this.waiters.filter((w) => w !== check);
        clearTimeout(timer);
        done(msg);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        fail(new Error(`timed out; inbox: ${this.inbox.map((m) => m.t).join(',')}`));
      }, timeout);
      if (!check()) this.waiters.push(check);
    });
  }

  // Waits until the replica satisfies pred.
  async until(pred, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (!(this.state && pred(this.state))) {
      if (Date.now() > deadline) throw new Error('replica never reached the expected state');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

async function create(name, extra = {}) {
  const c = new Client();
  await c.opened;
  c.send({ t: 'create', protocol: PROTOCOL, name, color: '#e8554e', domain: 'earth', settings: { size: 'small' }, ...extra });
  await c.next((m) => m.t === 'welcome');
  return c;
}

async function join(code, name, extra = {}) {
  const c = new Client();
  await c.opened;
  c.send({ t: 'join', protocol: PROTOCOL, code, name, color: '#39b0d8', domain: 'war', ...extra });
  c.first = await c.next((m) => m.t === 'welcome' || m.t === 'error');
  return c;
}

const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);

// fetch() normalises dot segments away; this sends the path exactly as written.
const statusOf = (path) =>
  new Promise((done, fail) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      done(res.statusCode);
    })
      .on('error', fail)
      .end();
  });

test('serves the game and its info endpoint, and nothing outside public/', async () => {
  const info = await (await get('/api/info')).json();
  assert.equal(info.app, 'ctb-world');
  assert.equal(info.protocol, PROTOCOL);
  const rules = await get('/js/shared/rules.js');
  assert.equal(rules.status, 200);
  assert.match(rules.headers.get('content-type'), /javascript/);
  assert.equal(rules.headers.get('cache-control'), 'no-store');
  assert.equal((await get('/nope.js')).status, 404);
  assert.equal(await statusOf('/%2e%2e%2fpackage.json'), 403);
  assert.equal(await statusOf('/..%2f..%2fpackage.json'), 403);
  assert.equal(await statusOf('/js/../../package.json'), 404);
});

test('two players create and join a world and play a round together', async () => {
  const a = await create('Ilyra');
  assert.equal(a.code.length, 5);
  assert.equal(a.state.host, a.you);
  const b = await join(a.code, 'Thorn');
  assert.equal(b.state.players[b.you].name, 'Thorn');
  await a.until((s) => s.players[b.you]?.online);

  // Chat reaches everyone.
  b.send({ t: 'chat', text: 'hello, world' });
  const heard = await a.next((m) => m.t === 'chat' && !m.sys);
  assert.equal(heard.text, 'hello, world');
  assert.equal(heard.name, 'Thorn');

  // Only the host may start.
  b.send({ t: 'host', cmd: 'start' });
  assert.match((await b.next((m) => m.t === 'notice')).text, /Only the host/);
  a.send({ t: 'host', cmd: 'start' });
  await b.until((s) => s.phase === 'playing');
  const timer = await b.next((m) => m.t === 'timer');
  assert.ok(timer.remaining > 100000 && timer.remaining <= 120000);

  // A deed by one player changes the other's replica.
  const i = a.state.terrain.findIndex((t, k) => isWater(t) && k > a.state.W * 3);
  const before = a.state.terrain[i];
  a.send({ t: 'act', seq: 1, a: { type: 'raise', i } });
  const ack = await a.next((m) => m.t === 'ack' && m.seq === 1);
  assert.equal(ack.ok, true, ack.err);
  await b.until((s) => s.terrain[i] === (before === T.DEEP ? T.SEA : T.GRASS));

  // Errors come back on the ack.
  a.send({ t: 'act', seq: 2, a: { type: 'race', i, arch: 'nomads' } });
  const refused = await a.next((m) => m.t === 'ack' && m.seq === 2);
  assert.equal(refused.ok, false);
  assert.match(refused.err, /Age of Awakening/);

  // Both ready: the round ends at once.
  a.send({ t: 'ready', v: true });
  b.send({ t: 'ready', v: true });
  await a.until((s) => s.round === 2);
  await b.until((s) => s.round === 2 && s.chronicle.some((e) => e.kind === 'shape'));
  const strip = (s) => ({ ...s, rng: 0 });
  assert.deepEqual(strip(b.state), strip(a.state));

  await a.close();
  await b.close();
});

test('a player who drops can reconnect with their token and keeps their god', async () => {
  const a = await create('Host');
  a.send({ t: 'host', cmd: 'start' });
  const b = await join(a.code, 'Wanderer');
  const { you, token } = b;
  await b.close();
  await a.until((s) => s.players[you]?.online === false);
  const again = await join(a.code, 'Someone else', { token });
  assert.equal(again.you, you);
  assert.equal(again.state.players[you].name, 'Wanderer');
  await a.until((s) => s.players[you]?.online === true);
  // Without a token, an offline god can be reclaimed by name.
  await again.close();
  await a.until((s) => s.players[you]?.online === false);
  const byName = await join(a.code, 'wanderer');
  assert.equal(byName.you, you);
  await byName.close();
  await a.close();
});

test('the host role passes on when the host leaves', async () => {
  const a = await create('First');
  const b = await join(a.code, 'Second');
  await a.close();
  await b.until((s) => s.host === b.you);
  await b.close();
});

test('joining a code that does not exist is refused', async () => {
  const c = await join('ZZZZZ', 'Lost');
  assert.equal(c.first.t, 'error');
  assert.equal(c.first.code, 'missing');
  await c.closed;
});

// ---------------------------------------------------------------- raw frames

function rawSocket() {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1', () => done(socket));
  });
}

function handshake(key = randomBytes(16).toString('base64')) {
  return [
    'GET /ws HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
}

function maskedFrame(text, { fin = true, opcode = 1, mask = true } = {}) {
  const payload = Buffer.from(text);
  const key = randomBytes(4);
  const header = [];
  header.push((fin ? 0x80 : 0) | opcode);
  if (payload.length < 126) header.push((mask ? 0x80 : 0) | payload.length);
  else header.push((mask ? 0x80 : 0) | 126, payload.length >> 8, payload.length & 255);
  const body = Buffer.from(payload);
  if (mask) for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(header), mask ? key : Buffer.alloc(0), body]);
}

function readAll(socket, until, timeout = 3000) {
  return new Promise((done, fail) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`timed out with ${data.length} bytes`)), timeout);
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (until(data)) {
        clearTimeout(timer);
        socket.off('data', onData);
        done(data);
      }
    };
    socket.on('data', onData);
  });
}

test('frames sent in the same packet as the handshake are not lost', async () => {
  const socket = await rawSocket();
  const hello = JSON.stringify({ t: 'ping' });
  // Handshake and first frame in one write: the server sees the frame in `head`.
  socket.write(Buffer.concat([Buffer.from(handshake()), maskedFrame(hello)]));
  const data = await readAll(socket, (d) => d.includes('pong'));
  assert.match(data.toString('latin1'), /101 Switching Protocols/);
  socket.destroy();
});

test('fragmented messages are reassembled, unmasked frames are rejected', async () => {
  const socket = await rawSocket();
  socket.write(handshake());
  await readAll(socket, (d) => d.includes('\r\n\r\n'));
  const text = JSON.stringify({ t: 'ping' });
  socket.write(maskedFrame(text.slice(0, 4), { fin: false }));
  socket.write(maskedFrame(text.slice(4), { fin: true, opcode: 0 }));
  await readAll(socket, (d) => d.includes('pong'));
  // A client frame without a mask is a protocol error: the server closes with 1002.
  socket.write(maskedFrame(text, { mask: false }));
  const closing = await readAll(socket, (d) => d.length >= 4 && d[0] === 0x88);
  assert.equal(closing.readUInt16BE(2), 1002);
  socket.destroy();
});

test('a malformed handshake gets a 400', async () => {
  const socket = await rawSocket();
  socket.write(handshake().replace('Sec-WebSocket-Version: 13', 'Sec-WebSocket-Version: 8'));
  const data = await readAll(socket, (d) => d.includes('\r\n\r\n'));
  assert.match(data.toString(), /400 Bad Request/);
  socket.destroy();
});

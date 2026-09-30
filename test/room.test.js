// The room protocol with fake connections and a fake clock: sessions, the
// round timer, host commands and saved worlds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reassembler, splitText } from '../public/js/net.js';
import { applyPatch, PROTOCOL } from '../public/js/shared/game.js';
import { Room } from '../public/js/shared/room.js';

function setup(settings = { size: 'small', roundTime: 60 }) {
  const clock = { t: 1000 };
  const room = new Room({ code: 'TEST2', settings, now: () => clock.t });
  return { room, clock };
}

// A connection that keeps a replica, like a real client.
function connect(room, name, extra = {}) {
  const c = {
    inbox: [],
    state: null,
    closed: false,
    send(text) {
      const msg = JSON.parse(text);
      if (msg.t === 'welcome') {
        c.state = msg.state;
        c.you = msg.you;
        c.token = msg.token;
      } else if (msg.t === 'patch' && c.state) applyPatch(c.state, msg);
      c.inbox.push(msg);
    },
    close() {
      c.closed = true;
    },
    last(t) {
      return [...c.inbox].reverse().find((m) => m.t === t);
    },
  };
  room.attach(c);
  room.receive(c, { t: 'join', protocol: PROTOCOL, name, color: '#e8554e', domain: 'earth', ...extra });
  return c;
}

test('the first to join hosts; colours stay unique; names are made unique', () => {
  const { room } = setup();
  const a = connect(room, 'Ilyra');
  const b = connect(room, 'ilyra');
  assert.equal(a.state.host, a.you);
  assert.notEqual(b.state.players[b.you].color, a.state.players[a.you].color);
  assert.equal(b.state.players[b.you].name, 'ilyra 2');
  // Everyone's replica agrees with the host.
  assert.deepEqual(a.state.players, room.game.s.players);
});

test('a version mismatch is refused', () => {
  const { room } = setup();
  const c = connect(room, 'Old', { protocol: PROTOCOL + 1 });
  assert.equal(c.last('error').code, 'protocol');
  assert.equal(Object.keys(room.game.s.players).length, 0);
});

test('the round timer ends the round and restarts itself', () => {
  const { room, clock } = setup();
  const a = connect(room, 'Ilyra');
  room.receive(a, { t: 'host', cmd: 'start' });
  assert.equal(a.last('timer').remaining, 60000);
  clock.t += 59000;
  room.tick();
  assert.equal(room.game.s.round, 1);
  clock.t += 1500;
  room.tick();
  assert.equal(room.game.s.round, 2);
  assert.equal(a.state.round, 2);
  assert.equal(a.last('timer').remaining, 60000);
});

test('rounds end as soon as every god who is here is ready', () => {
  const { room } = setup();
  const a = connect(room, 'A');
  const b = connect(room, 'B');
  room.receive(a, { t: 'host', cmd: 'start' });
  room.receive(a, { t: 'ready', v: true });
  assert.equal(room.game.s.round, 1);
  // B leaves without readying: the remaining gods are all ready.
  room.detach(b);
  assert.equal(room.game.s.round, 2);
});

test('someone who leaves a lobby is dropped after a grace period', () => {
  const { room, clock } = setup();
  const a = connect(room, 'A');
  const b = connect(room, 'B');
  room.detach(b);
  assert.equal(a.state.players[b.you].online, false);
  clock.t += 25000;
  room.tick();
  assert.equal(a.state.players[b.you], undefined);
});

test('the host can remove a god, who cannot come back by name', () => {
  const { room } = setup();
  const a = connect(room, 'A');
  const b = connect(room, 'B');
  room.receive(a, { t: 'host', cmd: 'start' });
  room.receive(a, { t: 'host', cmd: 'kick', pid: b.you });
  assert.equal(b.last('error').code, 'kicked');
  assert.ok(b.closed);
  const again = connect(room, 'B');
  assert.notEqual(again.you, b.you);
  // Only the host may use host commands.
  room.receive(again, { t: 'host', cmd: 'endGame' });
  assert.match(again.last('notice').text, /Only the host/);
});

test('flooding is rate limited', () => {
  const { room } = setup();
  const a = connect(room, 'A');
  for (let k = 0; k < 400; k++) room.receive(a, { t: 'chat', text: `spam ${k}` });
  const said = room.chat.filter((m) => !m.sys).length;
  assert.ok(said < 130, `${said} messages got through`);
});

test('a saved world loads with players matched by name', () => {
  const first = setup();
  const a = connect(first.room, 'Ilyra');
  connect(first.room, 'Thorn');
  first.room.receive(a, { t: 'host', cmd: 'start' });
  first.room.receive(a, { t: 'act', seq: 1, a: { type: 'legend', text: 'It began with salt.' } });
  const saved = JSON.parse(JSON.stringify(first.room.game.snapshot()));

  const second = setup();
  const host = connect(second.room, 'Thorn');
  const other = connect(second.room, 'Newcomer');
  second.room.receive(host, { t: 'host', cmd: 'load', state: saved });
  assert.equal(host.last('welcome').state.chronicle.at(-1).text, 'It began with salt.');
  const players = Object.values(second.room.game.s.players);
  assert.deepEqual(players.map((p) => p.name).sort(), ['Ilyra', 'Newcomer', 'Thorn']);
  // The host kept the saved Thorn, and is still the host.
  assert.equal(host.you, players.find((p) => p.name === 'Thorn').id);
  assert.equal(second.room.game.s.host, host.you);
  assert.equal(second.room.game.s.players[other.you].name, 'Newcomer');
  // Ilyra is offline until she comes back and claims her god by name.
  const ilyra = connect(second.room, 'Ilyra');
  assert.equal(ilyra.state.players[ilyra.you].name, 'Ilyra');
  assert.equal(second.room.game.s.players[ilyra.you].online, true);
  // Once the world runs, loading is refused; in a lobby, garbage is refused
  // without disturbing anything.
  second.room.receive(host, { t: 'host', cmd: 'load', state: saved });
  assert.match(host.last('notice').text, /from the lobby/);
  const third = setup();
  const h3 = connect(third.room, 'Host');
  third.room.receive(h3, { t: 'host', cmd: 'load', state: { nope: true } });
  assert.match(h3.last('notice').text, /could not be loaded/);
  assert.equal(third.room.game.s.players[h3.you].name, 'Host');
});

test('a hosted world survives a reload through its save, tokens included', () => {
  const { room } = setup();
  const a = connect(room, 'Host');
  const b = connect(room, 'Guest');
  room.receive(a, { t: 'host', cmd: 'start' });
  const save = JSON.parse(JSON.stringify(room.exportSave()));
  const again = new Room({ code: save.code, save });
  const guest = connect(again, 'Someone', { token: b.token });
  assert.equal(guest.you, b.you);
  const host = connect(again, 'Host', { token: a.token });
  assert.equal(host.you, a.you);
  assert.equal(again.game.s.host, a.you);
  assert.equal(again.game.s.phase, 'playing');
});

test('long messages are split without breaking characters and reassembled', () => {
  const text = `${'🌋'.repeat(9000)}${'x'.repeat(7)}${'한'.repeat(5000)}`;
  const parts = splitText(text, 1001);
  assert.ok(parts.length > 20);
  for (const part of parts) {
    const code = part.charCodeAt(part.length - 1);
    assert.ok(!(code >= 0xd800 && code <= 0xdbff), 'a piece ends inside a surrogate pair');
  }
  assert.equal(parts.join(''), text);
  // Framed the way sendText frames them, then reassembled out of order.
  const framed = parts.map((p, k) => `~ab:${k}:${parts.length}:${p}`);
  const r = new Reassembler();
  const order = framed.map((_, k) => k).reverse();
  let whole = null;
  for (const k of order) whole = r.accept(framed[k]) ?? whole;
  assert.equal(whole, text);
  assert.equal(r.accept('{"t":"ping"}'), '{"t":"ping"}');
});

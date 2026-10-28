// Platform tests using fake WebSockets (no network needed). Run with: deno run tests/platform.test.js
import { Platform } from '../server/platform.js';
import { games } from '../server/games.js';

const ok = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok  -', msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeSocket extends EventTarget {
  readyState = 1;
  inbox = [];
  send(json) {
    this.inbox.push(JSON.parse(json));
  }
  say(msg) {
    const e = new Event('message');
    e.data = JSON.stringify(msg);
    this.dispatchEvent(e);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  of(t) {
    return this.inbox.filter((m) => m.t === t);
  }
}

const platform = new Platform(games);
const connect = (name) => {
  const s = new FakeSocket();
  platform.connect(s);
  s.say({ t: 'hello', name });
  return s;
};

// solo mode: createRoom opens a private settings page first; 'start' then begins the game against bots
{
  const a = connect('Solo');
  ok(a.of('welcome').length === 1, 'client receives welcome');
  a.say({ t: 'createRoom', gameId: 'warlords', name: '', solo: true });
  const room = a.of('room').at(-1).room;
  ok(room.solo === true && room.status === 'lobby', 'solo: room is created in setup state (not auto-started)');
  ok(room.settings.bots === 3, 'solo: settings are pre-filled from soloSettings');
  ok(a.of('gameStart').length === 0, 'solo: no game until the player presses start');

  const other = connect('Other');
  ok(!other.of('rooms').at(-1).rooms.some((r) => r.solo), 'solo: room is hidden from the lobby list');
  other.say({ t: 'joinRoom', roomId: room.id });
  ok(other.of('error').at(-1)?.message === 'Room no longer exists', 'solo: nobody else can join');
  other.close();

  a.say({ t: 'setSettings', settings: { bots: 2, botSkill: 'hard', ballSpeed: 99999 } });
  const s2 = a.of('room').at(-1).room.settings;
  ok(s2.bots === 2 && s2.botSkill === 'hard' && s2.ballSpeed === 700, 'solo: settings can be edited and are clamped by the server');
  a.say({ t: 'setSettings', settings: { bots: 0 } });
  a.say({ t: 'start' });
  ok(a.of('error').at(-1)?.message.includes('opponent'), 'solo: starting with 0 bots is refused with a clear message');
  a.say({ t: 'setSettings', settings: { bots: 3 } });
  a.say({ t: 'start' });
  await sleep(300);
  ok(a.of('gameStart').length === 1, 'solo: game starts after start');
  ok(a.of('snapshot').length > 5, `solo: snapshots streaming (${a.of('snapshot').length} in 300 ms)`);
  const snap = a.of('snapshot').at(-1).data;
  ok(snap.bots.filter(Boolean).length === 3, 'solo: three bots');
  a.say({ t: 'input', data: { t: 120 } });
  await sleep(100);
  ok(a.of('snapshot').at(-1).data.paddles[0] === 120, 'mouse input reaches the paddle through the WebSocket path');
  a.close();
}

// multiplayer: host + guest, ready flow, settings, start, leave
{
  const a = connect('Ann');
  const b = connect('Bob');
  a.say({ t: 'createRoom', gameId: 'warlords', name: 'Test room' });
  const roomId = a.of('rooms').at(-1)?.rooms?.[0]?.id ?? b.of('rooms').at(-1)?.rooms?.[0]?.id;
  ok(!!roomId, 'room appears in the lobby list');
  b.say({ t: 'joinRoom', roomId });
  ok(a.of('room').at(-1).room.players.length === 2, 'guest joined, host sees 2 players');

  a.say({ t: 'start' });
  ok(a.of('error').at(-1)?.message === 'Not everyone is ready', 'cannot start until guest is ready');

  b.say({ t: 'setSettings', settings: { maxBalls: 8 } });
  ok(b.of('error').at(-1)?.message === 'Only the host can do that', 'guest cannot change settings');

  a.say({ t: 'setSettings', settings: { maxBalls: 99, bots: 0, ballSpeed: 400 } });
  ok(a.of('room').at(-1).room.settings.maxBalls === 8, 'settings are clamped by the server (99 -> 8)');

  b.say({ t: 'setReady', ready: true });
  a.say({ t: 'start' });
  await sleep(200);
  ok(a.of('gameStart').length === 1 && b.of('gameStart').length === 1, 'both clients got gameStart');
  ok(b.of('snapshot').length > 3, 'guest receives snapshots');

  b.close();
  await sleep(50);
  ok(a.of('room').at(-1).room.players.length === 1, 'host sees the guest leave mid-game');
  a.close();
}

// solo error handling: a game without a solo mode is refused cleanly
{
  const a = connect('X');
  a.say({ t: 'createRoom', gameId: 'nope', name: '' });
  ok(a.of('error').at(-1)?.message === 'Unknown game', 'unknown game gives an error');
  a.close();
}
console.log('platform tests passed');

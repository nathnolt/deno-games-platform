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
  ok(room.seats[0].playerId === a.of('welcome')[0].playerId, 'solo: you sit in seat 1');
  ok(room.seats.slice(1).every((s) => s.mode === 'bot'), 'solo: the other three seats are bots');
  ok(a.of('gameStart').length === 0, 'solo: no game until the player presses start');

  const other = connect('Other');
  ok(!other.of('rooms').at(-1).rooms.some((r) => r.solo), 'solo: room is hidden from the lobby list');
  other.say({ t: 'joinRoom', roomId: room.id });
  ok(other.of('error').at(-1)?.message === 'Room no longer exists', 'solo: nobody else can join');
  other.close();

  a.say({ t: 'setSettings', settings: { botSkill: 'hard', ballSpeed: 99999 } });
  const s2 = a.of('room').at(-1).room.settings;
  ok(s2.botSkill === 'hard' && s2.ballSpeed === 700, 'solo: settings can be edited and are clamped by the server');
  a.say({ t: 'setSeat', seat: 2, value: 'open' });
  ok(a.of('error').at(-1)?.message === 'A solo game has no open seats', 'solo: seats cannot be "open"');
  for (const seat of [1, 2, 3]) a.say({ t: 'setSeat', seat, value: 'closed' });
  a.say({ t: 'start' });
  ok(a.of('error').at(-1)?.message.includes('at least 2 seats'), 'solo: starting with every other seat closed is refused with a clear message');
  for (const seat of [1, 2, 3]) a.say({ t: 'setSeat', seat, value: 'bot' });
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

// solo: the human can sit in another seat
{
  const a = connect('Mover');
  a.say({ t: 'createRoom', gameId: 'warlords', name: '', solo: true });
  const me = a.of('welcome')[0].playerId;
  a.say({ t: 'setSeat', seat: 3, value: `player:${me}` });
  const seats = a.of('room').at(-1).room.seats;
  ok(seats[3].playerId === me && seats[0].mode === 'bot' && seats[0].playerId === null, 'solo: picking yourself in seat 4 moves you there and leaves a bot in seat 1');
  a.close();
}

// multiplayer: seats, spectators, ready flow, settings, start, leave
{
  const a = connect('Ann');
  const b = connect('Bob');
  const c = connect('Cid');
  a.say({ t: 'createRoom', gameId: 'warlords', name: 'Test room' });
  const roomId = a.of('rooms').at(-1)?.rooms?.[0]?.id ?? b.of('rooms').at(-1)?.rooms?.[0]?.id;
  ok(!!roomId, 'room appears in the lobby list');
  const id = (sock) => sock.of('welcome')[0].playerId;
  b.say({ t: 'joinRoom', roomId });
  let room = a.of('room').at(-1).room;
  ok(room.players.length === 2 && room.seats[0].playerId === id(a) && room.seats[1].playerId === id(b), 'host takes seat 1, the first guest is seated in seat 2');
  ok(room.seats.every((s) => s.mode === 'open'), 'all seats start open');

  // host controls the seats
  b.say({ t: 'setSeat', seat: 2, value: 'bot' });
  ok(b.of('error').at(-1)?.message === 'Only the host can do that', 'guest cannot change seat modes');
  a.say({ t: 'setSeat', seat: 2, value: 'bot' });
  a.say({ t: 'setSeat', seat: 3, value: 'closed' });
  room = a.of('room').at(-1).room;
  ok(room.seats[2].mode === 'bot' && room.seats[3].mode === 'closed', 'host can set a seat to bot / closed');
  b.say({ t: 'takeSeat', seat: 3 });
  ok(b.of('error').at(-1)?.message === 'That seat is not open', 'a closed seat cannot be taken');
  b.say({ t: 'takeSeat', seat: 0 });
  ok(b.of('error').at(-1)?.message === 'That seat is taken', 'an occupied seat cannot be taken');

  // spectators
  c.say({ t: 'joinRoom', roomId });
  room = a.of('room').at(-1).room;
  ok(room.players.find((p) => p.id === id(c)).slot === -1, 'with no open seat a newcomer joins as a spectator');
  a.say({ t: 'setSeat', seat: 3, value: 'open' });
  c.say({ t: 'takeSeat', seat: 3 });
  ok(a.of('room').at(-1).room.seats[3].playerId === id(c), 'a spectator can sit in a seat the host opened');
  c.say({ t: 'spectate' });
  ok(a.of('room').at(-1).room.players.find((p) => p.id === id(c)).slot === -1, 'a player can stand up and watch');
  a.say({ t: 'setSeat', seat: 0, value: `player:${id(c)}` });
  room = a.of('room').at(-1).room;
  ok(room.seats[0].playerId === id(c) && room.players.find((p) => p.id === id(a)).slot === -1, 'host seating someone in an occupied seat sends the old occupant to spectate');
  a.say({ t: 'setSeat', seat: 1, value: `player:${id(a)}` });
  room = a.of('room').at(-1).room;
  ok(room.seats[1].playerId === id(a) && room.players.find((p) => p.id === id(b)).slot === -1, 'host can seat himself again (bumping Bob to spectator)');
  a.say({ t: 'setSeat', seat: 0, value: `player:${id(a)}` });
  a.say({ t: 'setSeat', seat: 1, value: `player:${id(b)}` });
  room = a.of('room').at(-1).room;
  ok(room.seats[0].playerId === id(a) && room.seats[1].playerId === id(b), 'seats can be restored');
  c.say({ t: 'leaveRoom' });
  const summary = (await (async () => { const x = connect('Peek'); return x.of('rooms').at(-1).rooms.find((r) => r.id === roomId); })());
  ok(summary.players === 2 && summary.spectators === 0 && summary.openSeats === 1, 'lobby summary counts seated players, spectators and open seats');

  // ready + start
  a.say({ t: 'start' });
  ok(a.of('error').at(-1)?.message === 'Not everyone is ready', 'cannot start until seated guests are ready');

  b.say({ t: 'setSettings', settings: { maxBalls: 8 } });
  ok(b.of('error').at(-1)?.message === 'Only the host can do that', 'guest cannot change settings');

  a.say({ t: 'setSettings', settings: { maxBalls: 99, ballSpeed: 400 } });
  ok(a.of('room').at(-1).room.settings.maxBalls === 8, 'settings are clamped by the server (99 -> 8)');

  b.say({ t: 'setReady', ready: true });
  a.say({ t: 'start' });
  await sleep(200);
  ok(a.of('gameStart').length === 1 && b.of('gameStart').length === 1, 'both clients got gameStart');
  ok(b.of('snapshot').length > 3, 'guest receives snapshots');
  const snap = a.of('snapshot').at(-1).data;
  ok(JSON.stringify(snap.active) === '[true,true,true,false]' && snap.bots[2] === true, 'game uses the seats: 2 humans, 1 bot in seat 3, seat 4 empty');

  // joining mid-game = spectating
  const d = connect('Dee');
  d.say({ t: 'joinRoom', roomId });
  await sleep(100);
  const start = d.of('gameStart').at(-1);
  ok(!!start && start.room.players.find((p) => p.id === id(d)).slot === -1, 'joining a running game gives a game screen as a spectator');
  ok(d.of('snapshot').length > 2, 'spectator receives snapshots');
  d.say({ t: 'input', data: { t: 100 } });
  d.say({ t: 'takeSeat', seat: 3 });
  ok(d.of('error').at(-1)?.message === 'Seats cannot be changed during a game', 'seats are locked during a game');
  await sleep(100);
  ok(a.of('snapshot').at(-1).data.paddles.every((t) => t !== 100), "a spectator's input is ignored");
  d.close();

  b.close();
  await sleep(50);
  ok(a.of('room').at(-1).room.players.length === 1, 'host sees the guest leave mid-game');
  a.close();
  c.close();
}

// solo error handling: a game without a solo mode is refused cleanly
{
  const a = connect('X');
  a.say({ t: 'createRoom', gameId: 'nope', name: '' });
  ok(a.of('error').at(-1)?.message === 'Unknown game', 'unknown game gives an error');
  a.close();
}
console.log('platform tests passed');

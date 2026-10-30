import { Platform } from './server/platform.js';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok  -', m); };

class Fake extends EventTarget {
  readyState = 1; got = [];
  send(j) { this.got.push(JSON.parse(j)); }
  say(m) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(m) })); }
  last(t) { return [...this.got].reverse().find((m) => m.t === t); }
  close() { this.dispatchEvent(new Event('close')); }
}
const log = [];
const dropMeta = { id: 'drop', name: 'Drop', description: '', minPlayers: 1, maxPlayers: 3, tickRate: 20, dropIn: true, settings: [] };
const drop = { meta: dropMeta, create: (ctx) => ({
  onInput() {}, onLeave: (id) => log.push('leave:' + id), update() {}, snapshot: () => ({}),
  onJoin: (p) => { log.push('join:' + p.name + '@' + p.slot); return p.name !== 'Refused'; } }) };
const oldMeta = { id: 'old', name: 'Old', description: '', minPlayers: 2, maxPlayers: 4, tickRate: 20, settings: [] };
const old = { meta: oldMeta, create: () => ({ onInput() {}, onLeave() {}, update() {}, snapshot: () => ({}) }) };
const noMax = { meta: { id: 'nomax', name: 'N', description: '', tickRate: 20, settings: [] }, create: old.create };

const p = new Platform(new Map([['drop', drop], ['old', old], ['nomax', noMax]]));
const mk = (name) => { const s = new Fake(); p.connect(s); s.say({ t: 'hello', name }); return s; };

// default seat count
let a = mk('A'); a.say({ t: 'createRoom', gameId: 'nomax' });
ok(a.last('room').room.seats.length === 4, 'missing maxPlayers defaults to 4 seats');
a.say({ t: 'leaveRoom' });

// existing-style game unchanged: stays in lobby, late joiner is a spectator
a.say({ t: 'createRoom', gameId: 'old' });
ok(a.last('room').room.seats.length === 4 && a.last('room').room.status === 'lobby', 'normal game starts in lobby');
a.say({ t: 'leaveRoom' });

// drop-in game
a.say({ t: 'createRoom', gameId: 'drop' });
ok(a.last('gameStart'), 'drop-in room starts immediately on creation');
const room = a.last('gameStart').room;
ok(room.seats.length === 3 && room.players[0].slot === 0, 'meta.maxPlayers=3 gives 3 seats; creator seated');
const rid = room.id;
ok(a.last('rooms') && true, 'lobby list still sane');
const b = mk('B'); ok(b.last('rooms').rooms[0].dropIn === true && b.last('rooms').rooms[0].openSeats === 2, 'listed as drop-in with 2 open seats');
b.say({ t: 'joinRoom', roomId: rid });
ok(log.includes('join:B@1'), 'onJoin called for late joiner in slot 1');
ok(b.last('gameStart').room.players.find((x) => x.name === 'B').slot === 1, 'late joiner gets a real seat in gameStart');
ok(a.last('room').room.players.length === 2, 'existing player sees the update (room message)');
const c = mk('Refused'); c.say({ t: 'joinRoom', roomId: rid });
ok(c.last('gameStart').room.players.find((x) => x.name === 'Refused').slot === -1, 'onJoin returning false => spectator');
const d = mk('D'); d.say({ t: 'joinRoom', roomId: rid });
ok(log.includes('join:D@2'), 'refused seat was freed and reused');
const e = mk('E'); e.say({ t: 'joinRoom', roomId: rid });
ok(e.last('gameStart').room.players.find((x) => x.name === 'E').slot === -1, 'full room => spectator');
// leave frees seat
b.close();
ok(log.some((l) => l.startsWith('leave:')), 'onLeave called on disconnect');
const f = mk('F'); f.say({ t: 'joinRoom', roomId: rid });
ok(log.includes('join:F@1'), 'freed seat is reused by the next joiner');
// original: normal game mid-game join is still spectator
const o1 = mk('O1'); o1.say({ t: 'createRoom', gameId: 'old' }); const orid = o1.last('room').room.id;
const o2 = mk('O2'); o2.say({ t: 'joinRoom', roomId: orid }); o2.say({ t: 'setReady', ready: true });
o1.say({ t: 'start' });
const o3 = mk('O3'); o3.say({ t: 'joinRoom', roomId: orid });
ok(o3.last('gameStart').room.players.find((x) => x.name === 'O3').slot === -1, 'normal game: mid-game joiner still spectates');

// ── mid-match seat changes (drop-in): spectator -> player, player -> spectator ──
const room2Owner = mk('G'); room2Owner.say({ t: 'createRoom', gameId: 'drop' }); const rid2 = room2Owner.last('room').room.id;
const g2 = mk('H'), g3 = mk('I'), g4 = mk('J');
for (const x of [g2, g3, g4]) x.say({ t: 'joinRoom', roomId: rid2 });
ok(g4.last('gameStart').room.players.find((x) => x.name === 'J').slot === -1, 'J spectates a full 3-seat room');
ok(g4.last('room').room.dropIn === true, 'room state carries dropIn');
g4.say({ t: 'takeSeat', seat: 0 });
ok(g4.last('error')?.message?.includes('taken'), 'cannot take an occupied seat');
const before = log.length;
g3.say({ t: 'spectate' });
ok(log[before]?.startsWith('leave:'), 'Spectate mid-match reaches onLeave');
ok(g3.last('gameStart').room.players.find((x) => x.name === 'I').slot === -1, 'player who stood up is remounted as spectator');
g4.say({ t: 'takeSeat', seat: 2 });
ok(log.includes('join:J@2'), 'spectator takes freed seat mid-match -> onJoin');
ok(g4.last('gameStart').room.players.find((x) => x.name === 'J').slot === 2, 'taker is remounted with the new slot');
g2.say({ t: 'spectate' }); // frees seat 1
g4.say({ t: 'takeSeat', seat: 1 });
ok(g4.last('error')?.message?.includes('Stand up'), 'seated player cannot swap seats mid-match');
g3.say({ t: 'takeSeat', seat: 2 });
ok(g3.last('error')?.message?.includes('taken'), 'taken seat refused');
// normal game: seat changes mid-match still refused
o3.say({ t: 'takeSeat', seat: 2 });
ok(o3.last('error')?.message?.includes('cannot be changed'), 'normal game: seats stay locked mid-match');
o2.say({ t: 'spectate' });
ok(o2.last('error')?.message?.includes('cannot be changed'), 'normal game: cannot stand up mid-match');
console.log('ALL PASSED'); process.exit(0);

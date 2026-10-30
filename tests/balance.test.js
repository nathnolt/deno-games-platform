// Headless sim test. Run: deno run tests/balance.test.js
import { balance } from '../games/balance/server.js';
import { ST } from '../games/balance/shared.js';

const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok  -', m); };
const g = balance.create({ players: [{ id: 'a', name: 'A', slot: 0 }], bots: [], settings: {}, end: () => { throw new Error('must not end'); } });
const step = (n = 1) => { for (let i = 0; i < n; i++) g.update(1 / 30); };
const blocks = () => g.snapshot().b;
const idle = () => blocks().filter((b) => b[1] === ST.IDLE);

ok(idle().length === 4, 'four blocks wait in the front layer');
const first = idle()[0][0];
g.onInput('a', { pick: first });
ok(blocks().find((b) => b[0] === first)[1] === ST.HELD, 'player picks a block');
g.onJoin({ id: 'b', name: 'B', slot: 1 });
g.onInput('b', { pick: first });
ok(g.blocks.get(first).owner === 'a' && !g.players.get('b').held, 'a held block cannot be taken by another player');

g.onInput('a', { x: 0, y: 10 }); step(60);
g.onInput('a', { drop: true });
ok(blocks().length === 5 && idle().length === 4, 'a new block spawns the moment one is dropped');
step(90);
const s = blocks().find((b) => b[0] === first);
ok(s[1] === ST.STACK && Math.abs(s[3] - 1.5) < 0.01, 'dropped block lands on the base plate (y = 1.5)');

// second block onto the first
const second = idle()[0][0];
g.onInput('a', { pick: second }); g.onInput('a', { x: 0.3, y: 9 }); step(60); g.onInput('a', { drop: true }); step(90);
ok(Math.abs(g.blocks.get(second).y - 3.5) < 0.01, 'second block stacks on top (y = 3.5)');

// released outside the zone: goes back
const third = idle()[0][0];
const home = g.blocks.get(third).x;
g.onInput('a', { pick: third }); g.onInput('a', { x: 9, y: 8 }); step(60); g.onInput('a', { drop: true });
ok(g.blocks.get(third).st === ST.BACK, 'released outside the zone: block returns');
step(120);
ok(g.blocks.get(third).st === ST.IDLE && g.blocks.get(third).x === home, 'block is back in its slot');

// leaving while holding releases the block
g.onInput('b', { pick: third }); g.onLeave('b'); step(120);
ok(g.blocks.get(third).st === ST.IDLE, 'a leaving player frees the block they held');

// bad input never throws
for (const d of [null, 5, 'x', { x: NaN, y: 1 }, { pick: 'z' }, { pick: 99999 }, { drop: 1 }]) g.onInput('a', d);
ok(true, 'bad input is ignored');

// build to the goal -> tower completes, then resets
for (let i = 0; i < 10 && g.snapshot().n < 1; i++) {
  const id = idle()[0][0];
  g.onInput('a', { pick: id }); g.onInput('a', { x: 0, y: 16 }); step(60); g.onInput('a', { drop: true }); step(90);
}
ok(g.snapshot().n >= 1, 'a tall tower counts as built');
step(120);
ok(blocks().every((b) => b[1] === ST.IDLE), 'tower is cleared after the celebration');
console.log('all balance tests passed');

// Headless simulation test for Ramparts. Run with: deno run tests/ramparts.test.js
import { ramparts } from '../games/ramparts/server.js';
import { COLS, KEEPS, RING_TILES, TILE, pieceCells, PIECES } from '../games/ramparts/shared.js';
import { defaultSettings } from '../shared/settings.js';

const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok  -', m); };
const make = (over = {}, players = [{ id: 'p0', name: 'A', slot: 0 }], bots = [1, 2, 3]) => {
  const state = { result: null };
  const settings = { ...defaultSettings(ramparts.meta), ...over };
  const g = ramparts.create({ players, bots, settings, end: (r) => (state.result = r) });
  return { g, state, settings };
};
const run = (g, state, seconds, hz = 30) => { for (let i = 0; i < seconds * hz && !state.result; i++) g.update(1 / hz); };
const until = (g, state, phase, limit = 200, hz = 30) => { for (let i = 0; i < limit * hz && g.phase !== phase && !state.result; i++) g.update(1 / hz); };
const two = [{ id: 'p0', name: 'A', slot: 0 }, { id: 'p1', name: 'B', slot: 1 }];

// 1. piece geometry
for (let t = 0; t < PIECES.length; t++) {
  for (let r = 0; r < 4; r++) {
    const c = pieceCells(t, r);
    ok(c.length === PIECES[t].length && Math.min(...c.map((p) => p[0])) === 0 && Math.min(...c.map((p) => p[1])) === 0, `piece ${t} rot ${r} keeps its size and is normalised`);
  }
}

// 2. start: every active seat owns its castle, ringed by walls, and the ring encloses it
{
  const { g } = make();
  const s = g.snapshot();
  ok(s.phase === 'ready' && s.grid.length === COLS * 28, 'starts in the ready phase with a full grid');
  ok(s.ko.slice(0, 4).every((o, i) => o === i) && s.ko.slice(4).every((o) => o === -1), 'home castles owned by their seats, neutral ones free');
  ok(s.tc.every((n) => n > 0), `each seat encloses land at the start (${s.tc})`);
  for (let i = 0; i < 4; i++) ok(RING_TILES[i].every((t) => g.wall[t] === i), `ring of seat ${i} is built`);
  const empty = make({}, [{ id: 'p0', name: 'A', slot: 0 }], [1]).g;
  ok(empty.snapshot().ko[2] === -1 && empty.snapshot().tc[2] === 0, 'the home castle of an empty seat is free to capture');
}

// 3. phase flow and cannon placement rules
{
  const { g, state } = make();
  run(g, state, 3.2);
  ok(g.phase === 'place' && g.round === 1, 'ready -> place');
  ok(g.allow[0] === 2, 'home castle gives 2 cannons');
  const k = KEEPS[0];
  const mine = () => [...g.cannons.values()].filter((c) => c.slot === 0).length;
  g.onInput('p0', { c: [k.x, k.y] });
  g.onInput('p0', { c: [-5, 3] });
  g.onInput('p0', { c: [100, 100] });
  g.onInput('p0', { c: ['a', 1] });
  g.onInput('p0', 'garbage');
  g.onInput('nobody', { c: [k.x - 2, k.y - 2] });
  ok(mine() === 0, 'castle tile, out of range, non-integer, garbage and unknown-player inputs are all ignored');
  g.onInput('p0', { c: [k.x - 2, k.y - 2] });
  ok(mine() === 1 && g.allow[0] === 1, 'valid cannon placed');
  g.onInput('p0', { c: [k.x - 3, k.y - 3] });
  ok(g.allow[0] === 1, 'cannon on a wall tile refused');
  g.onInput('p0', { c: [k.x - 2, k.y + 1] });
  ok(g.allow[0] === 0 && mine() === 2, 'second cannon placed, allowance used up');
  g.onInput('p0', { c: [k.x + 2, k.y - 2] });
  ok(mine() === 2, 'no more than the allowance');
  until(g, state, 'battle', 5);
  ok(g.phase === 'battle', 'place ends early once everybody is done');
  ok([...g.cannons.values()].filter((c) => c.slot === 0 && c.active).length === 2, 'cannons inside the walls are active');
}

// 4. battle: firing, reload, impact destroys an enemy wall and never your own
{
  const { g, state } = make({}, two, []);
  run(g, state, 3.2);
  const k0 = KEEPS[0];
  const k1 = KEEPS[1];
  g.onInput('p0', { c: [k0.x - 2, k0.y - 2] });
  g.onInput('p0', { c: [k0.x - 2, k0.y + 1] });
  g.onInput('p1', { c: [k0.x, 0] });
  ok(![...g.cannons.values()].some((c) => c.slot === 1), "cannons cannot be placed in someone else's territory");
  g.onInput('p1', { c: [k1.x - 2, k1.y - 2] });
  g.onInput('p1', { c: [k1.x - 2, k1.y + 1] });
  until(g, state, 'battle', 20);
  g.update(1); // reload timers run out
  const target = RING_TILES[1][6];
  const aim = (t) => [(t % COLS + 0.5) * TILE, (Math.floor(t / COLS) + 0.5) * TILE];
  g.onInput('p0', { f: aim(target) });
  g.onInput('p0', { f: aim(target) });
  g.onInput('p0', { f: aim(target) });
  ok(g.balls.length === 2, 'two ready cannons fire two balls, the third click is blocked by the reload');
  run(g, state, 2);
  ok(g.wall[target] === -1, 'the targeted enemy wall tile is destroyed');
  ok(g.score[0] >= 5, 'shooter scores for the wall');
  ok(g.snapshot().tc[1] === 0, "a breached wall removes the owner's territory");
  g.update(3);
  const own = RING_TILES[0][3];
  g.onInput('p0', { f: aim(own) });
  run(g, state, 2);
  ok(g.wall[own] === 0, 'friendly walls are never damaged');
  g.onInput('p0', { f: [Infinity, NaN] });
  g.onInput('p0', { f: ['x', 2] });
  ok(true, 'malformed fire input does not throw');
}

// 5. cannon damage, hp and destruction
{
  const { g, state } = make({ cannonHp: 2 }, two, []);
  run(g, state, 3.2);
  const k1 = KEEPS[1];
  g.onInput('p0', { c: [KEEPS[0].x - 2, KEEPS[0].y - 2] });
  g.onInput('p1', { c: [k1.x - 2, k1.y - 2] });
  until(g, state, 'battle', 20);
  g.update(2);
  const c = [...g.cannons.values()].find((x) => x.slot === 1);
  const at = [(c.x + 1) * TILE, (c.y + 1) * TILE];
  g.onInput('p0', { f: at });
  g.update(2);
  ok([...g.cannons.values()].find((x) => x.id === c.id)?.hp === 1, 'first hit damages the cannon');
  g.update(2.5);
  g.onInput('p0', { f: at });
  g.update(2);
  ok(![...g.cannons.values()].some((x) => x.id === c.id), 'second hit destroys it');
  ok(g.score[0] >= 50, 'destroying a cannon scores');
}

// 6. build phase: a gap in the ring means no territory, a piece in the gap restores it
{
  const { g, state } = make({}, two, []);
  const before = g.terrCount[0];
  until(g, state, 'build', 90);
  ok(g.phase === 'build', 'reached the build phase');
  const hole = RING_TILES[0][8];
  g.wall[hole] = -1; // knock a hole in the ring (as a cannonball would)
  g.seq[g.pieceIdx[0]] = 0; // a single block
  g.onInput('p0', { p: [1, 1, 0] }); // any placement makes the server re-check the territory
  ok(g.terrCount[0] === 0, 'with a gap in the ring nothing is enclosed');
  g.seq[g.pieceIdx[0]] = 0;
  g.onInput('p0', { p: [hole % COLS, Math.floor(hole / COLS), 0] });
  ok(g.wall[hole] === 0 && g.terrCount[0] === before, 'a piece in the gap restores the territory');
  const i0 = g.pieceIdx[0];
  g.seq[i0] = 0;
  g.onInput('p0', { p: [hole % COLS, Math.floor(hole / COLS), 0] });
  ok(g.pieceIdx[0] === i0, 'a piece cannot overlap an existing wall');
  g.seq[i0] = 0;
  g.onInput('p0', { p: [19, 12, 0] }); // water
  ok(g.pieceIdx[0] === i0, 'a piece cannot be built on water');
  g.seq[i0] = 0;
  g.onInput('p0', { p: [KEEPS[4].x, KEEPS[4].y, 0] });
  ok(g.pieceIdx[0] === i0, 'a piece cannot be built on a castle');
  g.skipCool[0] = 0;
  g.onInput('p0', { d: 1 });
  ok(g.pieceIdx[0] === i0 + 1, 'a piece can be discarded');
  g.onInput('p0', { d: 1 });
  ok(g.pieceIdx[0] === i0 + 1, '...but not twice in a row');
}

// 7. a diagonal corner gap does not leak; a real gap does
{
  const { g, state } = make({}, two, []);
  until(g, state, 'build', 90);
  const { x, y } = KEEPS[0];
  const corner = (y - 3) * COLS + (x - 3);
  g.wall[corner] = -1;
  g.seq[g.pieceIdx[0]] = 0;
  g.onInput('p0', { p: [1, 1, 0] });
  ok(g.terrCount[0] > 0, 'the missing corner tile of the ring does not open the castle');
}

// 8. full matches against bots finish, for every skill, without errors
for (const botSkill of ['easy', 'normal', 'hard']) {
  const { g, state } = make({ botSkill, lives: 2, maxRounds: 6 });
  const t0 = performance.now();
  run(g, state, 1200);
  const ms = performance.now() - t0;
  ok(state.result && ['last', 'rounds', 'humans-out'].includes(state.result.reason), `${botSkill}: match with bots ends (${state.result?.reason}, ${state.result?.rounds} rounds, ${Math.round(ms)} ms sim)`);
  ok(state.result.winner >= 0, `${botSkill}: there is a winner (seat ${state.result.winner}, scores ${state.result.scores})`);
}

// 9. bots against bots: all-bot seats with one idle human who leaves
{
  const { g, state } = make({ botSkill: 'hard' });
  run(g, state, 30);
  g.onLeave('p0');
  ok(state.result?.reason === 'abandoned', 'the match ends when the last human leaves');
}

// 10. losing: no human castle enclosed -> lives drop, eliminated at 0
{
  const { g, state } = make({ lives: 1, maxRounds: 20 }, two, []);
  until(g, state, 'build', 90);
  for (const t of RING_TILES[0]) g.wall[t] = -1; // wipe seat 0's walls
  g.seq[g.pieceIdx[0]] = 0;
  g.onInput('p0', { p: [1, 1, 0] });
  run(g, state, 30);
  ok(g.alive[0] === false, 'a player with no enclosed castle and no lives left is eliminated');
  run(g, state, 10);
  ok(state.result?.winner === 1 && state.result.reason === 'last', 'the last player standing wins');
}

console.log('\nall Ramparts tests passed');

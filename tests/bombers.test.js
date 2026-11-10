// Headless simulation test for Bombers. Run: deno run tests/bombers.test.js
// (add it to the "test" task in deno.json:  ... && deno run tests/bombers.test.js)
import { bombers } from '../games/bombers/server.js';
import { defaultSettings } from '../shared/settings.js';

const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok  -', m); };
const base = defaultSettings(bombers.meta);
const STEP = 1 / 30;
const make = (settings, players, bots) => {
  const box = { result: null };
  box.g = bombers.create({ players, bots, settings: { ...base, ...settings }, end: (r) => (box.result = r) });
  return box;
};
const tick = (box, n = 1) => { const evs = []; for (let i = 0; i < n && !box.result; i++) { box.g.update(STEP); evs.push(...box.g.snapshot().ev); } return evs; };
const snap = (box) => { const s = box.g.snapshot(); return s; };
const A = { id: 'a', name: 'A', slot: 0 };
const B = { id: 'b', name: 'B', slot: 1 };

// 1. against bots, every skill level: the match always ends, snapshots stay small
for (const botSkill of ['easy', 'normal', 'hard']) {
  const box = make({ botSkill, roundsToWin: 2, roundTime: 60, arena: 'small' }, [A], [1, 2, 3]);
  let maxLen = 0;
  for (let i = 0; i < 30 * 60 * 20 && !box.result; i++) {
    box.g.update(STEP);
    maxLen = Math.max(maxLen, JSON.stringify(box.g.snapshot()).length);
  }
  ok(box.result && ['wins', 'limit'].includes(box.result.reason), `${botSkill} bots: match ends (${box.result?.reason}, winner ${box.result?.winner})`);
  ok(maxLen < 4000, `${botSkill} bots: snapshots stay small (max ${maxLen} chars)`);
}

// 2. moving, walls, bomb limit, bad input
{
  const box = make({ crates: 20 }, [A, B], []);
  tick(box, 90);
  ok(snap(box).ph === 'play', 'countdown, then play');
  const x0 = box.g.snapshot().p[0][0];
  box.g.onInput('a', { d: 2 });
  tick(box, 6);
  ok(box.g.snapshot().p[0][0] > x0, 'holding right moves right');
  box.g.onInput('a', { d: 1 });
  tick(box, 15);
  ok(box.g.snapshot().p[0][1] === 100, 'the border wall stops you');
  box.g.onInput('a', { d: 0 });
  box.g.onInput('a', { b: 1 });
  tick(box, 1);
  box.g.onInput('a', { b: 1 });
  tick(box, 5);
  ok(box.g.snapshot().b.length === 1, 'one bomb at a time with 1 starting bomb');
  for (const bad of [null, 'x', 7, { d: 9 }, { d: 1.5 }, { d: -1 }, { b: true }, { d: '2' }]) box.g.onInput('a', bad);
  box.g.onInput('nobody', { b: 1, d: 2 });
  const evs = tick(box, 100);
  ok(evs.some((e) => e[0] === 'die' && e[1] === 0), 'standing on your own bomb gets you killed');
  tick(box, 200);
  ok(box.g.snapshot().w[1] === 1, 'the survivor wins the round');
  box.g.onLeave('b');
  tick(box, 30 * 5);
  ok(box.result?.reason === 'forfeit' && box.result.winner === 0, 'the other player leaving ends the match (forfeit)');
}

// 3. walk off your bomb, the corner help slides you around a pillar, hide, survive
{
  const box = make({ crates: 20 }, [A, B], []);
  tick(box, 90);
  box.g.onInput('a', { b: 1 });
  tick(box, 1);
  box.g.onInput('a', { d: 2 });
  tick(box, 12); //              about 1.4 tiles to the right, past the pillar at (2,2)
  box.g.onInput('a', { d: 3 }); // down: pushed around the pillar into the x = 3 lane
  tick(box, 25);
  const p = box.g.snapshot().p[0];
  ok(p[0] === 300 && p[1] > 150, `walked off the bomb and around the corner (${p[0] / 100}, ${p[1] / 100})`);
  const evs = tick(box, 90);
  ok(evs.some((e) => e[0] === 'boom') && !evs.some((e) => e[0] === 'die'), 'the bomb went off and nobody died');
}

// 4. no sudden death: the round is a draw when the clock runs out
{
  const box = make({ suddenDeath: false, roundTime: 45 }, [A, { ...B, slot: 3 }], []);
  const evs = tick(box, 30 * 50);
  ok(evs.filter((e) => e[0] === 'end').map((e) => e[1]).join() === '-1', 'timeout = draw');
}

// 5. sudden death ends a round where nobody does anything
{
  const box = make({ roundTime: 45, roundsToWin: 1 }, [A, B], []);
  const evs = tick(box, 30 * 120);
  ok(evs.some((e) => e[0] === 'wall') && box.result, `sudden death walls close in and end it (${box.result?.reason})`);
}

// 6. everyone leaves
{
  const box = make({}, [A], [1]);
  tick(box, 100);
  box.g.onLeave('a');
  ok(box.result?.reason === 'abandoned', 'last human leaving ends the match');
}

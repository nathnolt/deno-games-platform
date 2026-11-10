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
  const box = make({ crates: 0 }, [A, B], []) // no crates: the same map every time;
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
  const box = make({ crates: 0 }, [A, B], []) // no crates: the same map every time;
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

// ── co-op ──
import { LEVELS } from '../games/bombers/levels.js';

// 7. battle needs two filled seats; co-op can be played alone
ok(typeof bombers.canStart({ players: [A], bots: [], settings: { ...base, mode: 'battle' } }) === 'string', 'battle alone is refused');
ok(bombers.canStart({ players: [A], bots: [], settings: { ...base, mode: 'coop' } }) === null, 'co-op alone is allowed');

// 8. every hand-made level is well formed and loads as drawn
for (const [n, L] of LEVELS.entries()) {
  const m = L.map;
  const w = m[0].length;
  const at = (chars) => m.flatMap((r, y) => [...r].flatMap((c, x) => (chars.includes(c) ? [[x, y]] : [])));
  const border = m.every((r, y) => r.length === w && r[0] === '#' && r[w - 1] === '#' && (y > 0 && y < m.length - 1 || /^#+$/.test(r)));
  const starts = at('1234');
  const seen = new Set([starts[0]?.join()]);
  const q = starts.slice(0, 1);
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = [x + dx, y + dy];
      if (m[k[1]]?.[k[0]] && m[k[1]][k[0]] !== '#' && !seen.has(k.join())) { seen.add(k.join()); q.push(k); }
    }
  }
  const unreachable = [...starts, ...at('Ee'), ...at('bcdgs'), ...at('BFSKXH')].filter((p) => !seen.has(p.join()));
  ok(border && starts.length === 4 && at('Ee').length === 1 && !unreachable.length, `level ${n + 1} "${L.name}" is well formed`);
  const box = make({ mode: 'coop', startLevel: n + 1 }, [A], []);
  const s = box.g.snapshot();
  ok(s.lvl === n + 1 && s.gw === w && s.g.length === w * m.length && s.th === L.theme && s.mo.length === at('bcdgs').length,
    `level ${n + 1} loads: ${w}×${m.length}, ${L.theme}, ${s.mo.length} monsters`);
}

// 9. dying on your own bomb costs lives; you come back shielded; no lives left = game over
{
  const box = make({ mode: 'coop', lives: 3 }, [A], []);
  tick(box, 90);
  const lives = [];
  let shielded = false;
  for (let i = 0; i < 30 * 40 && !box.result; i++) {
    box.g.onInput('a', { b: 1 });
    box.g.update(STEP);
    const snap = box.g.snapshot();
    for (const e of snap.ev) if (e[0] === 'die') lives.push(e[3]);
    if (snap.p[0]?.[10]) shielded = true;
  }
  ok(lives.join() === '2,1,0', `lives count down: ${lives.join()}`);
  ok(shielded, 'you come back with a shield');
  ok(box.result?.mode === 'coop' && box.result.reason === 'gameover', `then game over (${box.result?.reason})`);
}

// 10. with bot team-mates: the level only clears when EVERYONE is in the exit; power-ups carry over
{
  const box = make({ mode: 'coop', lives: 9, botSkill: 'hard' }, [A], [1, 2, 3]);
  let grid = '';
  let w = 0;
  const entered = [];
  let clearedAt = -1;
  let atClear = null;
  let kept = null;
  let level = 1;
  for (let i = 0; i < 30 * 60 * 10 && !box.result && kept === null; i++) {
    box.g.update(STEP);
    const s = box.g.snapshot();
    if (s.g) { grid = s.g; w = s.gw; }
    for (const e of s.ev) {
      if (e[0] === 'enter') entered.push(e[1]);
      if (e[0] === 'clear') { clearedAt = entered.length; atClear = s.p.map((p) => (p ? p.slice(5, 9).join() : '')); }
      if (e[0] === 'level') { level = e[1]; if (atClear) kept = s.p.every((p, k) => !p || p.slice(5, 9).join() === atClear[k]); }
    }
    // the "human" stays put until the exit is open and the bots are in, then walks there
    const me = s.p[0];
    let d = 0;
    if (s.ex?.[1] && me?.[4] && entered.length >= 3) {
      const from = Math.round(me[1] / 100) * w + Math.round(me[0] / 100);
      const bombs = new Set(s.b.map((b) => Math.round(b[2] / 100) * w + Math.round(b[1] / 100)));
      const prev = new Map([[from, -1]]);
      const q = [from];
      while (q.length) {
        const c = q.shift();
        if (c === s.ex[0]) break;
        for (const st of [-w, 1, w, -1]) {
          const n = c + st;
          if (grid[n] === '0' && !bombs.has(n) && !prev.has(n)) { prev.set(n, c); q.push(n); }
        }
      }
      let n = s.ex[0];
      if (prev.has(n) && n !== from) {
        while (prev.get(n) !== from) n = prev.get(n);
        d = { [-w]: 1, 1: 2, [w]: 3, [-1]: 4 }[n - from];
      }
    }
    box.g.onInput('a', { d });
  }
  ok(entered.slice(0, 3).sort().join() === '1,2,3' && entered[3] === 0, `bots walked into the exit first, then the human (${entered.join()})`);
  ok(clearedAt === 4, 'the level cleared only when all four were in');
  ok(level === 2 && kept === true, 'next level, power-ups kept');
}

// Headless simulation tests for Warlords. Run with: deno run tests/sim.test.js
import { warlords } from '../games/warlords/server.js';
import { defaultSettings } from '../shared/settings.js';
import { tFromPoint, paddleRects, TRACK } from '../games/warlords/shared.js';

const ok = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok  -', msg);
};
const run = (ctx, until, onTick) => {
  const g = warlords.create(ctx);
  let ended = null;
  ctx.end = (r) => (ended = r);
  const dt = 1 / 60;
  let t = 0, maxBalls = 0;
  while (!ended && t < 900) {
    onTick?.(g, t);
    g.update(dt);
    t += dt;
    const s = g.snapshot();
    maxBalls = Math.max(maxBalls, s.balls.length);
    for (const b of s.balls) if (!(b.x >= 0 && b.x <= 800 && b.y >= 0 && b.y <= 800)) throw new Error('ball escaped');
  }
  return { ended, t, maxBalls, g };
};
const botSlots = (n, from) => Array.from({ length: n }, (_, i) => from + i);
const humans = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, slot: i }));

// 1. four humans with random keyboard input finish a match, never exceeding max balls
{
  const settings = { ...defaultSettings(warlords.meta), ballSpeed: 500, ballInterval: 3, roundsToWin: 1 };
  const ps = humans(4);
  const r = run({ players: ps, bots: [], settings }, null, (g, t) => {
    if (Math.floor(t * 60) % 30 === 0) ps.forEach((p) => g.onInput(p.id, { dir: [-1, 0, 1][Math.floor(Math.random() * 3)] }));
  });
  ok(r.ended && r.ended.winner >= 0, `4-player match ends with a winner (slot ${r.ended?.winner}, ${r.t.toFixed(0)}s)`);
  ok(r.maxBalls <= settings.maxBalls, `never more than ${settings.maxBalls} balls (saw ${r.maxBalls})`);
}

// 2. solo: 1 human (idle) + 3 bots finishes; the human can lose rounds without stalling the match
{
  const settings = { ...defaultSettings(warlords.meta), ...warlords.meta.soloSettings, ballSpeed: 500, ballInterval: 3, roundsToWin: 2 };
  const r = run({ players: humans(1), bots: botSlots(3, 1), settings });
  ok(r.ended !== null, `solo vs 3 bots ends (${r.t.toFixed(0)}s, winner slot ${r.ended?.winner})`);
  const s = r.g.snapshot();
  ok(s.bots.filter(Boolean).length === 3 && s.active.every(Boolean), 'solo has 3 bots filling the other corners');
}

// 3. mouse: instant mode puts the paddle exactly on the requested track position
{
  const settings = { ...defaultSettings(warlords.meta), instantMouse: true };
  const g = warlords.create({ players: humans(2), bots: [], settings, end() {} });
  g.onInput('p0', { t: 150 });
  g.onInput('p1', { t: 9999 }); // absurd values are clamped
  g.update(1 / 60);
  const s = g.snapshot();
  ok(s.paddles[0] === 150, 'instant mouse sets paddle t immediately');
  ok(s.paddles[1] === TRACK, 'out-of-range mouse input is clamped to the track');
}

// 4. mouse geometry: pointing at a paddle's own position maps back to its t (all four corners)
{
  let good = true;
  for (let slot = 0; slot < 4; slot++) {
    for (const t of [-160, -50, 60, 160]) {
      const rs = paddleRects(slot, t); // one or two rectangles (bent round the corner)
      const r = rs[0];
      if (Math.abs(t) > 25 && Math.abs(tFromPoint(slot, r.x, r.y) - t) > 0.5) good = false;
    }
  }
  ok(good, 'tFromPoint points at a paddle (away from the corner) back to its t in every corner');
}

// 5. seats: bots only where the platform says so, closed/empty seats stay empty, a spectator's input is ignored
{
  const settings = defaultSettings(warlords.meta);
  const g = warlords.create({ players: [{ id: 'a', name: 'A', slot: 2 }], bots: [0], settings, end() {} });
  const s = g.snapshot();
  ok(JSON.stringify(s.active) === '[true,false,true,false]', 'only the seated player (seat 3) and the bot (seat 1) are active');
  ok(JSON.stringify(s.bots) === '[true,false,false,false]', 'seat 1 is a bot, seat 3 is human');
  g.onInput('watcher', { t: 100 });
  g.update(1 / 60);
  ok(g.snapshot().paddles.every((t) => t !== 100), 'input from someone without a seat does nothing');
}
console.log('sim tests passed');

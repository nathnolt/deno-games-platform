// Headless simulation tests for Warlords. Run with: deno run tests/sim.test.js
import { warlords } from '../games/warlords/server.js';
import { defaultSettings } from '../shared/settings.js';
import { tFromPoint, paddleRect, TRACK } from '../games/warlords/shared.js';

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
const humans = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, slot: i }));

// 1. four humans with random keyboard input finish a match, never exceeding max balls
{
  const settings = { ...defaultSettings(warlords.meta), ballSpeed: 500, ballInterval: 3, roundsToWin: 1 };
  const ps = humans(4);
  const r = run({ players: ps, settings }, null, (g, t) => {
    if (Math.floor(t * 60) % 30 === 0) ps.forEach((p) => g.onInput(p.id, { dir: [-1, 0, 1][Math.floor(Math.random() * 3)] }));
  });
  ok(r.ended && r.ended.winner >= 0, `4-player match ends with a winner (slot ${r.ended?.winner}, ${r.t.toFixed(0)}s)`);
  ok(r.maxBalls <= settings.maxBalls, `never more than ${settings.maxBalls} balls (saw ${r.maxBalls})`);
}

// 2. solo: 1 human (idle) + 3 bots finishes; the human can lose rounds without stalling the match
{
  const settings = { ...defaultSettings(warlords.meta), ...warlords.meta.soloSettings, ballSpeed: 500, ballInterval: 3, roundsToWin: 2 };
  const r = run({ players: humans(1), settings });
  ok(r.ended !== null, `solo vs 3 bots ends (${r.t.toFixed(0)}s, winner slot ${r.ended?.winner})`);
  const s = r.g.snapshot();
  ok(s.bots.filter(Boolean).length === 3 && s.active.every(Boolean), 'solo has 3 bots filling the other corners');
}

// 3. mouse: instant mode puts the paddle exactly on the requested track position
{
  const settings = { ...defaultSettings(warlords.meta), instantMouse: true };
  const g = warlords.create({ players: humans(2), settings, end() {} });
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
    for (const t of [-200, -50, 0, 60, 220]) {
      const r = paddleRect(slot, t);
      if (Math.abs(tFromPoint(slot, r.x, r.y) - t) > 0.5) good = false;
    }
  }
  ok(good, 'tFromPoint inverts paddleRect in every corner');
}

// 5. not enough players: canStart refuses 1 human + 0 bots, accepts with a bot
{
  const base = defaultSettings(warlords.meta);
  ok(warlords.canStart({ players: 1, settings: base }) !== null, 'alone without bots cannot start');
  ok(warlords.canStart({ players: 1, settings: { ...base, bots: 1 } }) === null, 'alone with 1 bot can start');
  ok(warlords.canStart({ players: 2, settings: base }) === null, 'two humans can start');
}
console.log('sim tests passed');

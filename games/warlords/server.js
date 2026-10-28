import { World } from '../../shared/ecs.js';
import {
  ARENA, BALL_R, BRICK_CELLS, TRACK, BallC, BrickC, KingC, PaddleC, Pos, Vel,
  PAD_C, PADDLE_THICK, brickRect, circleRect, heldCoords, heldPos, kingRect, launchVec, meta, paddleRects, tFromPoint,
} from './shared.js';

const SLOTS = [0, 1, 2, 3];
const COUNTDOWN = 3;
const ROUND_OVER = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

// ── ball speed tuning (all relative to the "Ball speed" setting) ──
// (top speed and slow-down come from the settings: maxSpeedMult, speedDecay)
const PADDLE_TRANSFER = 0.35; // how much of the paddle's own velocity is added to the ball (x speedUpStrength)
const ENGLISH = 0.6; //          sideways kick for hitting the paddle off-centre (x ball speed)
const LATERAL_FREE = 0.8; //     sideways speed (x base) the paddle can give before it is turned into forward speed
const MIN_FORWARD = 0.3; //      after a paddle hit at least this fraction of the speed leaves along the normal
const MAX_EVENTS = 40; //        per snapshot
const PEAK_WINDOW = 0.12; //     s: a release uses the paddle's fastest recent speed, so letting go isn't punished for a hand that slowed down
const HOLD_COOLDOWN = 0.5; //    seconds before a paddle can catch again after releasing
const PICKUP_COOLDOWN = 0.25; // seconds a just-launched ball (drawn blue) cannot be caught, and passes through the paddle that launched it

// ── bots ──
// speed:   fraction of the paddle speed while positioning
// react:   seconds between re-plans (where will a ball arrive?)
// error:   aim error in track units (px)
// flick:   paddle speed multiplier while sweeping through an incoming ball (0 = never flicks)
// hold:    chance to try to catch an incoming ball instead of just bouncing it
// holdFor: [min, max] seconds a bot keeps a caught ball while it lines up its shot
const SKILL = {
  easy: { speed: 0.5, react: 0.18, error: 40, flick: 0, hold: 0.15, holdFor: [1.2, 2.2] },
  normal: { speed: 0.9, react: 0.06, error: 12, flick: 0.9, hold: 0.45, holdFor: [1.0, 1.8] },
  hard: { speed: 1.2, react: 0.025, error: 3, flick: 1.4, hold: 0.6, holdFor: [0.9, 1.5] },
};
const BOT_FAST_FORWARD = 3; // simulation steps per tick once only bots are left alive (3 = three times as fast)
const BOT_HORIZON = 1.6; //  s: how far ahead a bot predicts a ball's path (with wall bounces)
const FLICK_LEAD = 0.06; //  s: a flick starts this long before the ball arrives, so the paddle is at full speed on contact
const newBotState = () => ({
  target: 0, mult: 0.7, next: 0, eta: Infinity, hitT: 0, flickDir: 1, ball: -1, err: 0, wantHold: false,
  heldE: null, enemy: -1, aimT: null, runT: 0, runDone: false, holdFor: 1,
});

class WarlordsGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = ctx.settings;
    this.world = new World();
    this.slotOf = new Map();
    this.active = [false, false, false, false]; // slot is occupied (human or bot)
    this.bot = [false, false, false, false];
    this.alive = [false, false, false, false]; // slot still in the current round
    this.mode = ['dir', 'dir', 'dir', 'dir']; // last input style per human: keyboard 'dir' or mouse 'target'
    this.dirs = [0, 0, 0, 0];
    this.targets = [0, 0, 0, 0];
    this.holding = [false, false, false, false]; // hold button is down (humans only)
    this.holdCool = [0, 0, 0, 0];
    this.holdLock = [false, false, false, false]; // a timed-out hold must be released and pressed again before it can catch again
    this.held = new Map(); // ball entity -> {slot, off, d, since, peak}: balls riding on a paddle
    this.fresh = new Map(); // ball entity -> {slot, left}: just launched; can't be caught and ignores the launching paddle
    this.botState = [null, null, null, null];
    this.scores = [0, 0, 0, 0];
    this.phase = 'countdown';
    this.timer = COUNTDOWN;
    this.round = 0;
    this.tick = 0;
    this.roundWinner = -1;
    this.nextBallId = 1;
    this.spawnTimer = 0;
    this.events = []; // one-shot things that happened this tick (sounds, shakes...); sent in the snapshot

    for (const p of ctx.players) {
      this.slotOf.set(p.id, p.slot);
      this.active[p.slot] = true;
    }
    this.humans = ctx.players.length;
    for (const slot of ctx.bots ?? []) { // seats the host set to "bot"
      if (slot >= 0 && slot < 4 && !this.active[slot]) {
        this.active[slot] = this.bot[slot] = true;
        this.botState[slot] = newBotState();
      }
    }
    this.#startRound();
  }

  // ── GameInstance ──
  onInput(playerId, data) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !data || typeof data !== 'object') return;
    if (typeof data.t === 'number' && Number.isFinite(data.t)) {
      this.targets[slot] = clamp(data.t, -TRACK, TRACK); // mouse: absolute position on the track
      this.mode[slot] = 'target';
    } else if (typeof data.dir === 'number') {
      this.dirs[slot] = Math.sign(data.dir); // keyboard: -1, 0, 1
      this.mode[slot] = 'dir';
    } else if (typeof data.hold === 'boolean') {
      this.holding[slot] = data.hold; // mouse button / space: catch balls on the front of the paddle
      if (!data.hold) this.holdLock[slot] = false;
    }
  }

  onLeave(playerId) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !this.active[slot]) return;
    this.active[slot] = false;
    this.holding[slot] = false;
    this.humans--;
    this.#eliminate(slot);
  }

  update(dt) {
    this.tick++;
    this.events = [];
    switch (this.phase) {
      case 'countdown':
        this.#paddleSystem(dt); // let people position themselves before the round starts
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = 'playing';
          this.spawnTimer = 0;
        }
        break;
      case 'playing': {
        // Only bots left alive: fast-forward (several simulation steps per tick) so nobody has to sit through it.
        const humansAlive = SLOTS.some((s) => this.alive[s] && !this.bot[s]);
        const steps = humansAlive ? 1 : BOT_FAST_FORWARD;
        for (let i = 0; i < steps && this.phase === 'playing'; i++) {
          this.#botSystem(dt);
          this.#paddleSystem(dt);
          this.#holdSystem(dt);
          this.#spawnSystem(dt);
          this.#ballSystem(dt);
          this.#checkRoundEnd();
        }
        break;
      }
      case 'roundOver':
        this.timer -= dt;
        if (this.timer <= 0) this.#afterRound();
        break;
    }
  }

  snapshot() {
    const w = this.world;
    const paddles = [0, 0, 0, 0];
    const bricks = [0, 0, 0, 0]; // bitmask of surviving bricks per slot
    for (const e of w.query(PaddleC)) {
      const p = w.get(e, PaddleC);
      paddles[p.slot] = r1(p.t);
    }
    for (const e of w.query(BrickC)) {
      const b = w.get(e, BrickC);
      bricks[b.slot] |= 1 << b.idx;
    }
    const balls = w.query(BallC, Pos, Vel).map((e) => {
      const p = w.get(e, Pos);
      const v = w.get(e, Vel);
      const held = this.held.get(e);
      const b = { id: w.get(e, BallC).id, x: r1(p.x), y: r1(p.y), vx: Math.round(v.x), vy: Math.round(v.y) };
      if (held) {
        b.h = held.slot + 1; // held by this slot (+1 so 0/undefined means free)
        const pe = w.query(PaddleC).find((x) => w.get(x, PaddleC).slot === held.slot);
        if (pe !== undefined) {
          const d = launchVec(held.slot, w.get(pe, PaddleC).t, held);
          b.ax = r2(d.x); // where the ball would fly if released now (for the aim line)
          b.ay = r2(d.y);
        }
      }
      const fr = this.fresh.get(e);
      if (fr) b.c = r2(fr.left / PICKUP_COOLDOWN); // 1 -> 0: blue fading back to white
      return b;
    });
    return {
      tick: this.tick,
      phase: this.phase,
      timer: this.timer,
      round: this.round,
      roundWinner: this.roundWinner,
      balls,
      paddles,
      alive: [...this.alive],
      active: [...this.active],
      bots: [...this.bot],
      bricks,
      scores: [...this.scores],
      ev: this.events, // one-shot events of this tick: {k, x, y, nx, ny, b, p, ...}
    };
  }

  // ── round flow ──
  #startRound() {
    this.round++;
    this.world = new World();
    this.alive = [...this.active];
    this.dirs = [0, 0, 0, 0];
    this.roundWinner = -1;
    const w = this.world;
    for (const slot of SLOTS) {
      if (!this.active[slot]) continue;
      w.add(w.create(), KingC, { slot });
      w.add(w.create(), PaddleC, { slot, t: 0, ds: 0 }); // ds: smoothed paddle speed along the track (px/s)
      BRICK_CELLS.forEach((_, idx) => w.add(w.create(), BrickC, { slot, idx }));
      this.targets[slot] = 0;
    }
    this.holdCool = [0, 0, 0, 0];
    this.holdLock = [false, false, false, false];
    this.held = new Map();
    this.fresh = new Map();
    for (const slot of SLOTS) if (this.bot[slot]) this.botState[slot] = newBotState();
    this.phase = 'countdown';
    this.timer = COUNTDOWN;
  }

  #checkRoundEnd() {
    const left = SLOTS.filter((s) => this.alive[s]);
    // The round runs until one base is left, even if you were knocked out (you can watch the bots finish it).
    // Only when every human has left the room do we cut it short; the sturdiest base takes the point.
    if (left.length > 1 && this.humans > 0) return;
    this.roundWinner = left.length === 1 ? left[0] : left.length > 1 ? this.#sturdiest(left) : -1;
    if (this.roundWinner >= 0) this.scores[this.roundWinner]++;
    this.phase = 'roundOver';
    this.timer = ROUND_OVER;
  }

  #sturdiest(slots) {
    const count = [0, 0, 0, 0];
    for (const e of this.world.query(BrickC)) count[this.world.get(e, BrickC).slot]++;
    return slots.reduce((best, s) => (count[s] > count[best] ? s : best), slots[0]);
  }

  #afterRound() {
    const activeCount = this.active.filter(Boolean).length;
    const best = Math.max(...this.scores);
    if (this.humans < 1 || activeCount < 2 || best >= this.s.roundsToWin) {
      const winner = best > 0 ? this.scores.indexOf(best) : -1;
      this.ctx.end({ winner, scores: [...this.scores] });
    } else {
      this.#startRound();
    }
  }

  #eliminate(slot) {
    if (!this.alive[slot]) return;
    this.alive[slot] = false;
    const w = this.world;
    for (const e of w.query(KingC)) if (w.get(e, KingC).slot === slot) w.destroy(e);
    for (const e of w.query(PaddleC)) if (w.get(e, PaddleC).slot === slot) w.destroy(e);
    for (const e of w.query(BrickC)) if (w.get(e, BrickC).slot === slot) w.destroy(e);
  }

  // ── systems ──
  /**
   * Bots predict where each loose ball will cross their defence zone (wall bounces included) and
   * stand there. Depending on skill they then either
   *  - flick: pre-position a little behind the impact point and sweep through it at full speed, so the
   *    paddle's own velocity is added to the ball, or
   *  - catch: hold the button as the ball arrives, then line up a shot at an enemy base and let go
   *    while swinging the paddle through the aim point (a flick release).
   */
  #botSystem(dt) {
    const w = this.world;
    const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    for (const slot of SLOTS) {
      if (!this.bot[slot] || !this.alive[slot]) continue;
      const st = this.botState[slot];
      const pe = w.query(PaddleC).find((x) => w.get(x, PaddleC).slot === slot);
      if (pe === undefined) continue;
      const pd = w.get(pe, PaddleC);
      const heldEntry = [...this.held].find(([, h]) => h.slot === slot);
      if (heldEntry) {
        this.#botHolding(slot, st, skill, pd, heldEntry);
        continue;
      }
      st.heldE = null;
      st.eta -= dt;
      st.next -= dt;
      if (st.next <= 0) this.#botPlan(slot, st, skill);

      const wantCatch = this.s.holdEnabled && st.wantHold && st.eta < 0.25 && st.eta > -0.1;
      this.holding[slot] = wantCatch;
      if (!wantCatch) this.holdLock[slot] = false;

      st.mult = skill.speed;
      st.target = st.hitT;
      if (skill.flick > 0 && this.s.speedUp && !wantCatch && st.eta < Infinity) {
        const fv = this.s.paddleSpeed * skill.flick;
        if (st.eta > FLICK_LEAD) {
          st.target = clamp(st.hitT - st.flickDir * fv * FLICK_LEAD, -TRACK, TRACK); // run-up spot
        } else if (st.eta > -0.12) {
          st.target = clamp(st.hitT + st.flickDir * 200, -TRACK, TRACK); // sweep through the impact point
          st.mult = skill.flick;
        }
      }
    }
  }

  #botPlan(slot, st, skill) {
    const w = this.world;
    st.next = skill.react;
    const king = kingRect(slot);
    let best = null;
    let nearest = null;
    let nd = Infinity;
    for (const e of w.query(BallC, Pos, Vel)) {
      if (this.held.has(e)) continue;
      const p = w.get(e, Pos);
      const d = Math.hypot(p.x - king.x, p.y - king.y);
      if (d < nd) { nd = d; nearest = p; }
      const hit = this.#predictArrival(slot, p, w.get(e, Vel));
      if (hit && (!best || hit.time < best.time)) best = { ...hit, id: w.get(e, BallC).id };
    }
    if (best) {
      if (best.id !== st.ball || best.time > st.eta + 0.3) { // a new approach: roll the dice again
        st.err = (Math.random() * 2 - 1) * skill.error;
        st.wantHold = this.s.holdEnabled && Math.random() < skill.hold;
        st.flickDir = Math.random() < 0.5 ? -1 : 1;
      }
      st.ball = best.id;
      st.eta = best.time;
      st.hitT = clamp(tFromPoint(slot, best.x, best.y) + st.err, -TRACK, TRACK);
      if (st.hitT > 4) st.flickDir = -1; //  sweep towards the inner corner: the ball gets thrown out into the arena
      else if (st.hitT < -4) st.flickDir = 1;
    } else {
      st.ball = -1;
      st.eta = Infinity;
      st.wantHold = false;
      st.hitT = nearest ? clamp(tFromPoint(slot, nearest.x, nearest.y), -TRACK, TRACK) : 0;
    }
  }

  /** Where and when (seconds from now) a ball will first enter the square around this slot's paddle track, or null. */
  #predictArrival(slot, p, v) {
    const sx = slot & 1;
    const sy = slot >> 1;
    const zone = PAD_C + PADDLE_THICK / 2 + BALL_R;
    const inZone = (x, y) => (sx ? ARENA - x : x) < zone && (sy ? ARENA - y : y) < zone;
    let { x, y } = p;
    let { x: vx, y: vy } = v;
    // a ball that is already in the zone and flying away (it just left our paddle) is no threat until it comes back
    let armed = !(inZone(x, y) && ((sx ? -vx : vx) > 0 || (sy ? -vy : vy) > 0));
    const step = 1 / 90;
    for (let t = 0; t < BOT_HORIZON; t += step) {
      const inside = inZone(x, y);
      if (inside && armed) return { time: t, x, y };
      if (!inside) armed = true;
      x += vx * step;
      y += vy * step;
      if (x < BALL_R) { x = BALL_R; vx = Math.abs(vx); } else if (x > ARENA - BALL_R) { x = ARENA - BALL_R; vx = -Math.abs(vx); }
      if (y < BALL_R) { y = BALL_R; vy = Math.abs(vy); } else if (y > ARENA - BALL_R) { y = ARENA - BALL_R; vy = -Math.abs(vy); }
    }
    return null;
  }

  /** A bot with a ball on its paddle: run up, then swing through the aim point and let go (so the throw is fast). */
  #botHolding(slot, st, skill, pd, [e, h]) {
    this.holding[slot] = true;
    if (st.heldE !== e) { // just caught it
      st.heldE = e;
      st.holdFor = skill.holdFor[0] + Math.random() * (skill.holdFor[1] - skill.holdFor[0]);
      st.enemy = -1;
      st.aimT = null;
    }
    if (st.enemy < 0 || !this.alive[st.enemy]) {
      st.enemy = this.#pickEnemy(slot);
      st.aimT = null;
    }
    const limit = this.s.holdInfinite ? st.holdFor : Math.min(st.holdFor, this.s.holdMax - 0.5);
    if (st.enemy < 0 || h.since >= limit) { // out of time (or nobody left to shoot at): just let go
      this.holding[slot] = false;
      return;
    }
    if (st.aimT === null) {
      // try every paddle position: where would the released ball fly straight at the enemy king?
      const king = kingRect(st.enemy);
      let bestT = 0;
      let bestErr = Infinity;
      for (let t = -TRACK; t <= TRACK; t += 6) {
        const bp = heldPos(slot, t, h);
        const d = launchVec(slot, t, h);
        const tx = king.x - bp.x;
        const ty = king.y - bp.y;
        const err = Math.acos(clamp((d.x * tx + d.y * ty) / (Math.hypot(tx, ty) || 1), -1, 1));
        if (err < bestErr) { bestErr = err; bestT = t; }
      }
      st.aimT = clamp(bestT + (Math.random() * 2 - 1) * skill.error, -TRACK, TRACK);
      const sign = TRACK - st.aimT >= st.aimT + TRACK ? 1 : -1; // run up from the side with more room
      st.runT = clamp(st.aimT + sign * 90, -TRACK, TRACK);
      st.runDone = false;
    }
    const sweep = Math.sign(st.aimT - st.runT) || 1;
    if (!st.runDone && (pd.t - st.runT) * sweep <= 4) st.runDone = true;
    if (!st.runDone) {
      st.target = st.runT;
      st.mult = skill.speed;
      return;
    }
    st.target = clamp(st.aimT + sweep * 150, -TRACK, TRACK);
    st.mult = skill.flick > 0 ? skill.flick : skill.speed;
    if ((pd.t - st.aimT) * sweep >= -4) this.holding[slot] = false; // passed the aim point at speed: let go
  }

  #pickEnemy(slot) {
    const foes = SLOTS.filter((s) => s !== slot && this.alive[s]);
    if (foes.length === 0) return -1;
    if (this.s.botSkill !== 'hard') return foes[Math.floor(Math.random() * foes.length)];
    const count = [0, 0, 0, 0]; // hard bots go for the weakest base
    for (const e of this.world.query(BrickC)) count[this.world.get(e, BrickC).slot]++;
    return foes.reduce((best, s) => (count[s] < count[best] ? s : best), foes[0]);
  }

  #paddleSystem(dt) {
    const w = this.world;
    const speed = this.s.paddleSpeed;
    const toward = (p, target, maxStep) => (p.t += clamp(target - p.t, -maxStep, maxStep));
    const smooth = 1 - Math.exp(-dt / 0.04); // ~40 ms low-pass so mouse jitter doesn't make the paddle speed noisy
    for (const e of w.query(PaddleC)) {
      const p = w.get(e, PaddleC);
      const slot = p.slot;
      const before = p.t;
      if (this.bot[slot]) toward(p, this.botState[slot].target, speed * this.botState[slot].mult * dt);
      else if (this.mode[slot] === 'target') {
        if (this.s.instantMouse) p.t = this.targets[slot]; // as fast as the mouse
        else toward(p, this.targets[slot], speed * dt);
      } else p.t += this.dirs[slot] * speed * dt;
      p.t = clamp(p.t, -TRACK, TRACK);
      const raw = dt > 0 ? (p.t - before) / dt : 0;
      p.ds = clamp(p.ds + (raw - p.ds) * smooth, -1500, 1500);
    }
  }

  #spawnSystem(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = this.s.ballInterval;
    const w = this.world;
    if (w.query(BallC).length >= this.s.maxBalls) return;
    const angle = Math.PI / 4 + (Math.random() - 0.5) * 0.8 + Math.floor(Math.random() * 4) * (Math.PI / 2);
    const e = w.create();
    const id = this.nextBallId++;
    w.add(e, BallC, { id });
    w.add(e, Pos, { x: ARENA / 2, y: ARENA / 2 });
    w.add(e, Vel, { x: Math.cos(angle) * this.s.ballSpeed, y: Math.sin(angle) * this.s.ballSpeed });
    this.#emit('spawn', { x: ARENA / 2, y: ARENA / 2 }, null, 0, 0, id);
  }

  #ballSystem(dt) {
    const w = this.world;
    const base = this.s.ballSpeed;
    for (const e of w.query(BallC, Pos, Vel)) {
      if (this.held.has(e)) continue; // riding on a paddle: moved by #holdSystem
      const p = w.get(e, Pos);
      const v = w.get(e, Vel);
      const id = w.get(e, BallC).id;
      // A boosted ball slowly relaxes back to the base speed.
      let speed = Math.hypot(v.x, v.y);
      if (speed > base) {
        const k = (base + (speed - base) * Math.exp(-this.s.speedDecay * dt)) / speed;
        v.x *= k;
        v.y *= k;
        speed *= k;
      }
      // Substep so a fast ball never tunnels through a brick (the ball may now be much faster than base).
      const steps = Math.max(1, Math.ceil((speed * dt) / 4));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        p.x += v.x * h;
        p.y += v.y * h;
        if (this.#collide(p, v, id, e)) break; // caught by a paddle
      }
    }
  }

  /** Balls riding on paddles follow them, and are released when the button goes up (or time / the paddle runs out). */
  #holdSystem(dt) {
    const w = this.world;
    for (let slot = 0; slot < 4; slot++) this.holdCool[slot] = Math.max(0, this.holdCool[slot] - dt);
    for (const [e, f] of [...this.fresh]) {
      f.left -= dt;
      if (f.left <= 0) this.fresh.delete(e);
    }
    for (const [e, h] of [...this.held]) {
      const p = w.get(e, Pos);
      const v = w.get(e, Vel);
      const pe = w.query(PaddleC).find((x) => w.get(x, PaddleC).slot === h.slot);
      h.since += dt;
      h.peak *= Math.exp(-dt / PEAK_WINDOW);
      let d = null;
      if (pe !== undefined) {
        const pd = w.get(pe, PaddleC);
        const pt = heldPos(h.slot, pd.t, h);
        p.x = pt.x;
        p.y = pt.y;
        for (const r of paddleRects(h.slot, pd.t)) { // where the paddle bends round the elbow the ball must never end up inside it
          const hit = circleRect(p.x, p.y, BALL_R, r);
          if (hit) { p.x += hit.nx * hit.depth; p.y += hit.ny * hit.depth; }
        }
        p.x = clamp(p.x, BALL_R, ARENA - BALL_R); // a ball held on a paddle end next to a wall must stay inside the arena
        p.y = clamp(p.y, BALL_R, ARENA - BALL_R);
        d = launchVec(h.slot, pd.t, h);
        h.peak = Math.max(h.peak, Math.abs(pd.ds));
      }
      const timedOut = !this.s.holdInfinite && h.since >= this.s.holdMax;
      if (pe !== undefined && this.holding[h.slot] && !timedOut) continue;
      if (timedOut && this.holding[h.slot]) this.holdLock[h.slot] = true; // temp hold ran out: let go of the button to catch again
      // release: along the line from just inside the corner through the ball, at a speed that depends
      // on how fast the paddle was moving (never below the minimum, never above the top speed)
      const base = this.s.ballSpeed;
      const speed = clamp(base * this.s.releaseMinSpeed + h.peak * this.s.releaseSpeedGain, base, base * this.s.maxSpeedMult);
      d ??= { x: Math.sign(p.x - ARENA / 2) || 1, y: 0 }; // paddle is gone (base destroyed): just let it go
      v.x = d.x * speed;
      v.y = d.y * speed;
      this.held.delete(e);
      this.fresh.set(e, { slot: h.slot, left: PICKUP_COOLDOWN });
      this.holdCool[h.slot] = HOLD_COOLDOWN;
      this.#emit('launch', p, v, d.x, d.y, w.get(e, BallC).id, { s: h.slot });
    }
  }

  /** Returns true if the ball was caught (so the caller stops moving it this tick). */
  #collide(p, v, id, e0) {
    const w = this.world;
    if (p.x < BALL_R) { if (v.x < 0) this.#emit('wall', p, v, 1, 0, id); p.x = BALL_R; v.x = Math.abs(v.x); }
    else if (p.x > ARENA - BALL_R) { if (v.x > 0) this.#emit('wall', p, v, -1, 0, id); p.x = ARENA - BALL_R; v.x = -Math.abs(v.x); }
    if (p.y < BALL_R) { if (v.y < 0) this.#emit('wall', p, v, 0, 1, id); p.y = BALL_R; v.y = Math.abs(v.y); }
    else if (p.y > ARENA - BALL_R) { if (v.y > 0) this.#emit('wall', p, v, 0, -1, id); p.y = ARENA - BALL_R; v.y = -Math.abs(v.y); }

    for (const e of w.query(PaddleC)) {
      const pd = w.get(e, PaddleC);
      if (this.fresh.get(e0)?.slot === pd.slot) continue; // just launched from this paddle: pass through it, don't bounce
      for (const r of paddleRects(pd.slot, pd.t)) {
        let hit = circleRect(p.x, p.y, BALL_R, r);
        if (!hit) continue;
        // A ball squeezed between a paddle and a wall (the paddle slid flush against it) would be pushed out the
        // nearest side, i.e. through the wall and out of the arena. When that happens, let it out the front instead.
        const ox = p.x + hit.nx * hit.depth;
        const oy = p.y + hit.ny * hit.depth;
        if (ox < BALL_R || ox > ARENA - BALL_R || oy < BALL_R || oy > ARENA - BALL_R) {
          const half = Math.abs(r.fx) * (r.w / 2) + Math.abs(r.fy) * (r.h / 2);
          hit = { nx: r.fx, ny: r.fy, depth: half + BALL_R - ((p.x - r.x) * r.fx + (p.y - r.y) * r.fy) };
        }
        return this.#paddleHit(p, v, hit, r, pd, id, e0);
      }
    }
    for (const e of w.query(BrickC)) {
      const b = w.get(e, BrickC);
      const hit = circleRect(p.x, p.y, BALL_R, brickRect(b.slot, b.idx));
      if (!hit) continue;
      this.#bounce(p, v, hit);
      w.destroy(e);
      this.#emit('brick', p, v, hit.nx, hit.ny, id, { s: b.slot, i: b.idx });
      return;
    }
    for (const e of w.query(KingC)) {
      const k = w.get(e, KingC);
      const hit = circleRect(p.x, p.y, BALL_R, kingRect(k.slot));
      if (!hit) continue;
      this.#bounce(p, v, hit);
      this.#emit('king', p, v, hit.nx, hit.ny, id, { s: k.slot });
      this.#eliminate(k.slot);
      return;
    }
  }

  /**
   * Ball meets paddle. If the player is holding the button the ball is caught wherever it touches the paddle (front, ends, back).
   * Otherwise, in the paddle's own frame (n = away from the paddle surface, t = along it):
   *  1. reflect the ball;
   *  2. "English": hitting the paddle off-centre bends the ball sideways;
   *  and, only when the speed-up setting is on:
   *  3. the paddle's own speed (along the track) is added to the ball, so a paddle swung into the
   *     ball hits harder, and one moving away takes some pace off;
   *  4. if the ball ends up leaving at a very shallow angle (lots of sideways speed), part of that
   *     sideways speed is turned into forward speed, like `ballysp *= 1+val; ballxsp /= 1+val` before;
   *  5. clamp: never slower than the base speed, never faster than maxSpeedMult x, always leaves
   *     the paddle.
   * With speed-up off the ball always keeps the base speed.
   */
  #paddleHit(p, v, hit, r, pd, id, e) {
    const base = this.s.ballSpeed;
    const speedUp = this.s.speedUp;
    const slot = pd.slot;

    // catch: button down, nothing held yet, ball not in its post-launch cooldown. The ball can touch ANY part
    // of the paddle (front, either end, back) and then stays exactly where it touched.
    // (a paddle that already holds a ball just bounces any other ball that touches it)
    if (this.s.holdEnabled && this.holding[slot] && !this.holdLock[slot] && this.holdCool[slot] <= 0 && !this.fresh.has(e) && ![...this.held.values()].some((h) => h.slot === slot)) {
      p.x += hit.nx * hit.depth; // resting on the surface, not sunk into it
      p.y += hit.ny * hit.depth;
      const c = heldCoords(slot, p.x, p.y, pd.t, r.horiz);
      const h = { slot, off: c.s - pd.t, d: c.d, since: 0, peak: 0 };
      this.held.set(e, h);
      const pt = heldPos(slot, pd.t, h);
      p.x = pt.x;
      p.y = pt.y;
      this.#emit('catch', p, v, hit.nx, hit.ny, id, { s: slot });
      v.x = 0;
      v.y = 0;
      return true;
    }

    this.#bounce(p, v, hit);
    const nx = hit.nx;
    const ny = hit.ny;
    const tx = -ny;
    const ty = nx;

    // 2. English
    const half = Math.abs(tx) * (r.w / 2) + Math.abs(ty) * (r.h / 2);
    const off = clamp(((p.x - r.x) * tx + (p.y - r.y) * ty) / half, -1, 1);
    let vn = v.x * nx + v.y * ny;
    let vt = v.x * tx + v.y * ty + off * base * ENGLISH;

    let speed = base;
    if (speedUp) {
      // 3. paddle velocity at the point of contact
      const gain = PADDLE_TRANSFER * this.s.speedUpStrength;
      vn += (r.dx * nx + r.dy * ny) * pd.ds * gain;
      vt += (r.dx * tx + r.dy * ty) * pd.ds * gain;
      // 4. shallow exits get straightened out and sped up
      const free = LATERAL_FREE * base;
      const lateral = Math.abs(vt);
      if (lateral > free) {
        const val = (this.s.speedUpStrength * (lateral - free)) / (2 * base);
        vn *= 1 + val;
        vt /= 1 + val;
      }
      speed = clamp(Math.hypot(vn, vt) * (this.s.hitBoost ?? 1), base, base * this.s.maxSpeedMult); // hitBoost: every hit adds pace
    }

    // 5. always leave the paddle
    const len = Math.hypot(vn, vt) || 1;
    const fn = Math.max(MIN_FORWARD, vn / len);
    const ft = (vt < 0 ? -1 : 1) * Math.sqrt(1 - fn * fn);
    v.x = (fn * nx + ft * tx) * speed;
    v.y = (fn * ny + ft * ty) * speed;
    this.#normalize(v, speed);
    this.#emit('paddle', p, v, nx, ny, id, { s: slot });
    return false;
  }

  #bounce(p, v, hit) {
    p.x += hit.nx * hit.depth;
    p.y += hit.ny * hit.depth;
    const dot = v.x * hit.nx + v.y * hit.ny;
    if (dot < 0) {
      v.x -= 2 * dot * hit.nx;
      v.y -= 2 * dot * hit.ny;
    }
    this.#normalize(v);
  }

  /** Keeps the given speed (default: the current one), and never (almost) axis-aligned, so a ball can't ping-pong forever. */
  #normalize(v, speed = Math.hypot(v.x, v.y)) {
    const min = 0.22;
    speed ||= this.s.ballSpeed;
    const len0 = Math.hypot(v.x, v.y) || 1;
    let nx = v.x / len0;
    let ny = v.y / len0;
    if (Math.abs(nx) < min) nx = (nx < 0 ? -1 : 1) * min;
    if (Math.abs(ny) < min) ny = (ny < 0 ? -1 : 1) * min;
    const len = Math.hypot(nx, ny);
    v.x = (nx / len) * speed;
    v.y = (ny / len) * speed;
  }

  /**
   * Records something the clients should hear / see once. (x, y) is where it happened, (nx, ny) the
   * surface normal (pointing at the ball), b the ball id, p how fast the ball was going (0 = base
   * speed, 1 = the maximum), plus event specific fields (s: slot, i: brick id).
   */
  #emit(kind, pos, v, nx, ny, id, extra = {}) {
    if (this.events.length >= MAX_EVENTS) return;
    const base = this.s.ballSpeed;
    const power = v ? clamp((Math.hypot(v.x, v.y) - base) / (base * Math.max(0.1, this.s.maxSpeedMult - 1)), 0, 1) : 0;
    this.events.push({ k: kind, x: r1(pos.x), y: r1(pos.y), nx: r2(nx), ny: r2(ny), b: id, p: r2(power), ...extra });
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const warlords = {
  meta,
  create: (ctx) => new WarlordsGame(ctx),
};

import { World } from '../../shared/ecs.js';
import {
  ARENA, BALL_R, BRICK_CELLS, TRACK, BallC, BrickC, KingC, PaddleC, Pos, Vel,
  brickRect, circleRect, kingRect, meta, paddleRect, tFromPoint,
} from './shared.js';

const SLOTS = [0, 1, 2, 3];
const COUNTDOWN = 3;
const ROUND_OVER = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// speed: fraction of the paddle speed limit, react: seconds between decisions, error: aim error in px
const SKILL = {
  easy: { speed: 0.45, react: 0.25, error: 70 },
  normal: { speed: 0.7, react: 0.12, error: 35 },
  hard: { speed: 1.0, react: 0.05, error: 10 },
};

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
    this.botState = [null, null, null, null];
    this.scores = [0, 0, 0, 0];
    this.phase = 'countdown';
    this.timer = COUNTDOWN;
    this.round = 0;
    this.tick = 0;
    this.roundWinner = -1;
    this.nextBallId = 1;
    this.spawnTimer = 0;

    for (const p of ctx.players) {
      this.slotOf.set(p.id, p.slot);
      this.active[p.slot] = true;
    }
    this.humans = ctx.players.length;
    let bots = Math.min(this.s.bots, 4 - this.humans);
    for (const slot of SLOTS) {
      if (bots > 0 && !this.active[slot]) {
        this.active[slot] = this.bot[slot] = true;
        this.botState[slot] = { target: 0, next: 0 };
        bots--;
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
    }
  }

  onLeave(playerId) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !this.active[slot]) return;
    this.active[slot] = false;
    this.humans--;
    this.#eliminate(slot);
  }

  update(dt) {
    this.tick++;
    switch (this.phase) {
      case 'countdown':
        this.#paddleSystem(dt); // let people position themselves before the round starts
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = 'playing';
          this.spawnTimer = 0;
        }
        break;
      case 'playing':
        this.#botSystem(dt);
        this.#paddleSystem(dt);
        this.#spawnSystem(dt);
        this.#ballSystem(dt);
        this.#checkRoundEnd();
        break;
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
      paddles[p.slot] = Math.round(p.t * 10) / 10;
    }
    for (const e of w.query(BrickC)) {
      const b = w.get(e, BrickC);
      bricks[b.slot] |= 1 << b.idx;
    }
    const balls = w.query(BallC, Pos).map((e) => {
      const p = w.get(e, Pos);
      return { id: w.get(e, BallC).id, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
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
      w.add(w.create(), PaddleC, { slot, t: 0 });
      BRICK_CELLS.forEach((_, idx) => w.add(w.create(), BrickC, { slot, idx }));
      this.targets[slot] = 0;
    }
    this.phase = 'countdown';
    this.timer = COUNTDOWN;
  }

  #checkRoundEnd() {
    const left = SLOTS.filter((s) => this.alive[s]);
    const humansLeft = left.filter((s) => !this.bot[s]).length;
    // Normal end: one (or zero) left. Also end when every human is out but bots remain,
    // so you don't have to watch bots fight; the sturdiest base takes the point.
    if (left.length > 1 && humansLeft > 0) return;
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
  #botSystem(dt) {
    const w = this.world;
    const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    for (const slot of SLOTS) {
      if (!this.bot[slot] || !this.alive[slot]) continue;
      const st = this.botState[slot];
      st.next -= dt;
      if (st.next > 0) continue;
      st.next = skill.react;
      const king = kingRect(slot);
      let nearest = null;
      let best = Infinity;
      for (const e of w.query(BallC, Pos)) {
        const p = w.get(e, Pos);
        const d = Math.hypot(p.x - king.x, p.y - king.y);
        if (d < best) { best = d; nearest = p; }
      }
      st.target = nearest
        ? clamp(tFromPoint(slot, nearest.x, nearest.y) + (Math.random() * 2 - 1) * skill.error, -TRACK, TRACK)
        : 0;
    }
  }

  #paddleSystem(dt) {
    const w = this.world;
    const speed = this.s.paddleSpeed;
    const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    const toward = (p, target, maxStep) => (p.t += clamp(target - p.t, -maxStep, maxStep));
    for (const e of w.query(PaddleC)) {
      const p = w.get(e, PaddleC);
      const slot = p.slot;
      if (this.bot[slot]) toward(p, this.botState[slot].target, speed * skill.speed * dt);
      else if (this.mode[slot] === 'target') {
        if (this.s.instantMouse) p.t = this.targets[slot]; // as fast as the mouse
        else toward(p, this.targets[slot], speed * dt);
      } else p.t = clamp(p.t + this.dirs[slot] * speed * dt, -TRACK, TRACK);
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
    w.add(e, BallC, { id: this.nextBallId++ });
    w.add(e, Pos, { x: ARENA / 2, y: ARENA / 2 });
    w.add(e, Vel, { x: Math.cos(angle) * this.s.ballSpeed, y: Math.sin(angle) * this.s.ballSpeed });
  }

  #ballSystem(dt) {
    const w = this.world;
    // Substep so a fast ball never tunnels through a brick.
    const steps = Math.max(1, Math.ceil((this.s.ballSpeed * dt) / 4));
    const h = dt / steps;
    for (const e of w.query(BallC, Pos, Vel)) {
      const p = w.get(e, Pos);
      const v = w.get(e, Vel);
      for (let i = 0; i < steps; i++) {
        p.x += v.x * h;
        p.y += v.y * h;
        this.#collide(p, v);
      }
    }
  }

  #collide(p, v) {
    const w = this.world;
    if (p.x < BALL_R) { p.x = BALL_R; v.x = Math.abs(v.x); }
    else if (p.x > ARENA - BALL_R) { p.x = ARENA - BALL_R; v.x = -Math.abs(v.x); }
    if (p.y < BALL_R) { p.y = BALL_R; v.y = Math.abs(v.y); }
    else if (p.y > ARENA - BALL_R) { p.y = ARENA - BALL_R; v.y = -Math.abs(v.y); }

    for (const e of w.query(PaddleC)) {
      const pd = w.get(e, PaddleC);
      const r = paddleRect(pd.slot, pd.t);
      const hit = circleRect(p.x, p.y, BALL_R, r);
      if (!hit) continue;
      this.#bounce(p, v, hit);
      // "English": where the ball lands on the paddle bends its direction.
      const long = r.w > r.h;
      const off = clamp(long ? (p.x - r.x) / (r.w / 2) : (p.y - r.y) / (r.h / 2), -1, 1);
      if (long) v.x += off * this.s.ballSpeed * 0.6;
      else v.y += off * this.s.ballSpeed * 0.6;
      this.#normalize(v);
      return;
    }
    for (const e of w.query(BrickC)) {
      const b = w.get(e, BrickC);
      const hit = circleRect(p.x, p.y, BALL_R, brickRect(b.slot, b.idx));
      if (!hit) continue;
      this.#bounce(p, v, hit);
      w.destroy(e);
      return;
    }
    for (const e of w.query(KingC)) {
      const k = w.get(e, KingC);
      const hit = circleRect(p.x, p.y, BALL_R, kingRect(k.slot));
      if (!hit) continue;
      this.#bounce(p, v, hit);
      this.#eliminate(k.slot);
      return;
    }
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

  /** Constant speed, and never (almost) axis-aligned, so a ball can't ping-pong forever. */
  #normalize(v) {
    const min = 0.22;
    const len0 = Math.hypot(v.x, v.y) || 1;
    let nx = v.x / len0;
    let ny = v.y / len0;
    if (Math.abs(nx) < min) nx = (nx < 0 ? -1 : 1) * min;
    if (Math.abs(ny) < min) ny = (ny < 0 ? -1 : 1) * min;
    const len = Math.hypot(nx, ny);
    v.x = (nx / len) * this.s.ballSpeed;
    v.y = (ny / len) * this.s.ballSpeed;
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const warlords = {
  meta,
  create: (ctx) => new WarlordsGame(ctx),
  canStart({ players, settings }) {
    const bots = Math.min(settings.bots, 4 - players);
    return players + bots >= 2 ? null : 'You need an opponent: set Bots to 1 or more, or invite a friend.';
  },
};

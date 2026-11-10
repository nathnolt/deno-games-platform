import {
  CRATE, DX, DY, FLAME_TIME, FLOOR, MAX_BOMBS, MAX_FIRE, MAX_SPEED, PU_BOMB, PU_FIRE, PU_KICK, PU_SPEED,
  SD_INTERVAL, SLIDE_SPEED, SOLID, arenaOf, isPillar, meta, spawnsOf, speedOf, spiralOf,
} from './shared.js';

const SLOTS = [0, 1, 2, 3];
const READY_TIME = 2.6; //   countdown before each round
const GRACE_TIME = 1.1; //   after only one player is left: keep simulating so a simultaneous death makes a draw
const RESULT_TIME = 3.6; //  round-over pause
const BOMB_GAP = 0.12; //    s: anti-spam between two bomb drops by the same player
const FAST_FORWARD = 3; //   simulation speed while only bots are still alive in the round

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const rnd = (a, b) => a + Math.random() * (b - a);

// ── bots ──
// react:  [min, max] seconds between two decisions while nothing is threatening the bot
// notice: seconds before the bot notices it is standing in a blast zone
// margin: extra safety (s) the bot keeps between itself and flames
// hunt:   0..1, how much the bot goes after players rather than crates
// slip:   chance per decision to ignore the escape check (easy bots sometimes trap themselves)
// grab:   how far (tiles) the bot walks for a power-up
const SKILL = {
  easy: { react: [0.55, 1.0], notice: 0.35, margin: 0.05, hunt: 0.15, slip: 0.04, grab: 4 },
  normal: { react: [0.22, 0.5], notice: 0.12, margin: 0.15, hunt: 0.45, slip: 0, grab: 8 },
  hard: { react: [0.06, 0.18], notice: 0, margin: 0.22, hunt: 0.85, slip: 0, grab: 14 },
};

class BombersGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = ctx.settings;
    const { w, h } = arenaOf(this.s.arena);
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.spawns = spawnsOf(w, h);
    this.spiral = spiralOf(w, h);
    this.skill = SKILL[this.s.botSkill] ?? SKILL.normal;

    this.slotOf = new Map(); // playerId -> slot
    this.active = [false, false, false, false];
    this.bot = [false, false, false, false];
    this.human = [false, false, false, false];
    this.wins = [0, 0, 0, 0];
    this.p = SLOTS.map((slot) => ({ slot, alive: false, x: 0, y: 0, dir: 0, face: 3, moving: false, bombs: 1, fire: 2, speed: 0, kick: false, want: false, gap: 0, limit: null }));
    this.botState = [null, null, null, null];

    this.grid = new Uint8Array(this.n);
    this.hidden = new Uint8Array(this.n); // crate -> power-up inside (0 = none). Never sent to clients
    this.bombs = [];
    this.bombAt = new Map(); // tile -> bomb
    this.flames = new Map(); // tile -> { t, mask, reveal }   mask: 1 horizontal, 2 vertical, 4 centre
    this.powerups = new Map(); // tile -> type
    this.nextBombId = 1;
    this.events = [];
    this.gridDirty = true;
    this.tick = 0;
    this.round = 0;
    this.roundsPlayed = 0;
    this.maxRounds = this.s.roundsToWin * 2 + 3; // draws can't go on forever
    this.phase = 'ready';
    this.timer = READY_TIME;
    this.clock = this.s.roundTime;
    this.sdIndex = 0;
    this.sdAcc = 0;
    this.roundWinner = -1;
    this.final = null;
    this.finished = false;
    this.ff = false;

    for (const pl of ctx.players) {
      if (pl.slot < 0 || pl.slot > 3) continue;
      this.slotOf.set(pl.id, pl.slot);
      this.active[pl.slot] = this.human[pl.slot] = true;
    }
    this.humans = this.slotOf.size;
    for (const slot of ctx.bots ?? []) {
      if (slot >= 0 && slot < 4 && !this.active[slot]) this.active[slot] = this.bot[slot] = true;
    }
    this.#newRound();
  }

  // ── GameInstance ──
  onInput(playerId, data) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !data || typeof data !== 'object') return;
    const p = this.p[slot];
    if (Number.isInteger(data.d) && data.d >= 0 && data.d <= 4) p.dir = data.d;
    if (data.b === 1 && p.gap <= 0) p.want = true;
  }

  onLeave(playerId) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined) return;
    this.slotOf.delete(playerId);
    this.humans--;
    this.human[slot] = false;
    this.active[slot] = false;
    if (this.p[slot].alive) this.#kill(slot, false);
    this.p[slot].dir = 0;
    if (this.humans < 1 && !this.finished) this.#finish({ winner: -1, wins: [...this.wins], reason: 'abandoned' });
  }

  update(dt) {
    try {
      // Only bots left alive this round (and some human is still watching): run the clock faster.
      this.ff = this.phase === 'play' && this.humans > 0 && !SLOTS.some((s) => this.human[s] && this.p[s].alive);
      const steps = this.ff ? FAST_FORWARD : 1;
      for (let i = 0; i < steps && !this.finished; i++) this.#step(dt, i === 0);
    } catch (err) { // never let a bug here take the whole server down
      console.error('Bombers update error', err);
    }
  }

  snapshot() {
    try {
      const snap = {
        tick: this.tick,
        ph: this.phase,
        tm: r1(Math.max(0, this.phase === 'play' || this.phase === 'grace' ? this.clock : this.timer)),
        rd: this.round,
        w: [...this.wins],
        ac: [...this.active],
        bt: [...this.bot],
        p: this.p.map((p) => (this.active[p.slot] || p.alive
          ? [Math.round(p.x * 100), Math.round(p.y * 100), p.face, p.moving ? 1 : 0, p.alive ? 1 : 0, p.bombs, p.fire, p.speed, p.kick ? 1 : 0]
          : null)),
        b: this.bombs.map((b) => [b.id, Math.round(b.x * 100), Math.round(b.y * 100), r2(Math.max(0, b.fuse) / this.s.fuse), b.owner]),
        f: [...this.flames].map(([i, f]) => [i, f.mask, r2(f.t / FLAME_TIME)]),
        u: [...this.powerups],
        sd: this.clock <= 0 && this.s.suddenDeath && this.phase === 'play' ? this.#nextSd() : -1,
        rw: this.roundWinner,
        ff: this.ff ? 1 : 0,
        ev: this.events.slice(0, 80),
      };
      this.events = []; // each event goes out exactly once
      if (this.final) snap.over = 1;
      if (this.gridDirty || this.tick % 30 === 0) { // the map only when it changed (and once a second for late joiners)
        snap.g = this.grid.join('');
        this.gridDirty = false;
      }
      return snap;
    } catch (err) {
      console.error('Bombers snapshot error', err);
      return { tick: this.tick, ph: this.phase, ev: [] };
    }
  }

  // ── rounds ──
  #newRound() {
    const { w, h } = this;
    this.round++;
    this.grid.fill(FLOOR);
    this.hidden.fill(0);
    this.bombs = [];
    this.bombAt.clear();
    this.flames.clear();
    this.powerups.clear();
    // Tiles right next to the spawns stay free so everybody can drop a first bomb and step aside.
    const keepFree = new Set();
    for (const [sx, sy] of this.spawns) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) keepFree.add((sy + dy) * w + sx + dx);
    }
    const crateChance = this.s.crates / 100;
    const puChance = this.s.powerups / 100;
    const table = [[PU_BOMB, 4], [PU_FIRE, 4], [PU_SPEED, 3]];
    if (this.s.kick) table.push([PU_KICK, 1.2]);
    const total = table.reduce((a, [, wt]) => a + wt, 0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (isPillar(w, h, x, y)) { this.grid[i] = SOLID; continue; }
        if (keepFree.has(i) || Math.random() >= crateChance) continue;
        this.grid[i] = CRATE;
        if (Math.random() < puChance) {
          let r = Math.random() * total;
          for (const [type, wt] of table) { if ((r -= wt) <= 0) { this.hidden[i] = type; break; } }
          if (!this.hidden[i]) this.hidden[i] = PU_BOMB;
        }
      }
    }
    for (const slot of SLOTS) {
      const p = this.p[slot];
      Object.assign(p, { alive: this.active[slot], dir: this.human[slot] ? p.dir : 0, moving: false, face: 3, bombs: this.s.startBombs, fire: this.s.startFire, speed: 0, kick: false, want: false, gap: 0, limit: null });
      [p.x, p.y] = this.spawns[slot];
      if (this.bot[slot]) this.botState[slot] = { t: rnd(0.2, 0.6), goal: -1, mode: 'idle', noticed: 0, stuck: 0 };
    }
    this.clock = this.s.roundTime;
    this.sdIndex = 0;
    this.sdAcc = 0;
    this.roundWinner = -1;
    this.phase = 'ready';
    this.timer = READY_TIME;
    this.gridDirty = true;
    this.events.push(['round', this.round]);
  }

  #step(dt, first) {
    if (this.finished) return;
    if (first) this.tick++;
    switch (this.phase) {
      case 'ready':
        this.timer -= dt;
        if (this.timer <= 0) { this.phase = 'play'; this.events.push(['go']); }
        break;
      case 'play':
      case 'grace':
        this.#play(dt);
        if (this.phase === 'play') {
          const alive = SLOTS.filter((s) => this.p[s].alive);
          if (alive.length <= 1) { this.phase = 'grace'; this.timer = GRACE_TIME; }
        } else if (this.phase === 'grace') {
          this.timer -= dt;
          if (this.timer <= 0) {
            const alive = SLOTS.filter((s) => this.p[s].alive);
            this.#endRound(alive.length === 1 ? alive[0] : -1);
          }
        }
        break;
      case 'result':
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.final) this.#finish(this.final);
          else this.#newRound();
        }
        break;
    }
  }

  #endRound(winner) {
    this.roundsPlayed++;
    this.roundWinner = winner;
    if (winner >= 0) this.wins[winner]++;
    this.phase = 'result';
    this.timer = RESULT_TIME;
    this.events.push(['end', winner]);
    for (const p of this.p) { p.moving = false; }
    if (winner >= 0 && this.wins[winner] >= this.s.roundsToWin) {
      this.final = { winner, wins: [...this.wins], rounds: this.roundsPlayed, reason: 'wins' };
    } else if (this.roundsPlayed >= this.maxRounds) {
      const best = Math.max(...SLOTS.map((s) => (this.active[s] ? this.wins[s] : -1)));
      const top = SLOTS.filter((s) => this.active[s] && this.wins[s] === best);
      this.final = { winner: top.length === 1 ? top[0] : -1, wins: [...this.wins], rounds: this.roundsPlayed, reason: 'limit' };
    } else if (SLOTS.filter((s) => this.active[s]).length < 2) { // everybody else left: no one to play against
      const left = SLOTS.find((s) => this.active[s]) ?? -1;
      this.final = { winner: left, wins: [...this.wins], rounds: this.roundsPlayed, reason: 'forfeit' };
    } else if (!SLOTS.some((s) => this.human[s])) {
      this.final = { winner: -1, wins: [...this.wins], rounds: this.roundsPlayed, reason: 'abandoned' };
    }
  }

  #finish(result) {
    if (this.finished) return;
    this.finished = true;
    this.ctx.end(result); // the platform sends {t:'gameEnd', result} and returns the room to setup
  }

  // ── the simulation ──
  #play(dt) {
    // round clock and sudden death
    if (this.phase === 'play') {
      if (this.clock > 0) {
        this.clock -= dt;
        if (this.clock <= 0) {
          this.clock = 0;
          if (!this.s.suddenDeath) { this.#endRound(-1); return; }
          this.events.push(['sd']);
        }
      } else if (this.s.suddenDeath) {
        this.sdAcc += dt;
        while (this.sdAcc >= SD_INTERVAL) { this.sdAcc -= SD_INTERVAL; this.#dropWall(); }
      }
    }

    // bots decide, then everybody moves and drops bombs
    const danger = SLOTS.some((s) => this.bot[s] && this.p[s].alive) ? this.#danger(null) : null;
    for (const slot of SLOTS) {
      const p = this.p[slot];
      p.gap = Math.max(0, p.gap - dt);
      if (!p.alive) continue;
      if (this.bot[slot]) this.#botThink(slot, dt, danger);
      const before = p.x + p.y;
      if (p.dir) {
        p.face = p.dir;
        this.#move(p, p.dir, speedOf(p.speed) * dt, p.limit);
      }
      p.moving = p.dir !== 0 && Math.abs(p.x + p.y - before) > 1e-6;
      if (p.want) { p.want = false; this.#dropBomb(p); }
      const i = this.#tileOf(p);
      const pu = this.powerups.get(i);
      if (pu) { this.powerups.delete(i); this.#powerUp(p, pu); }
    }

    // bombs: who can still walk off them, sliding, fuses, explosions
    for (const b of this.bombs) {
      for (const slot of b.pass) {
        const p = this.p[slot];
        if (!p.alive || Math.abs(p.x - b.x) >= 0.99 || Math.abs(p.y - b.y) >= 0.99) b.pass.delete(slot);
      }
      if (b.sx || b.sy) this.#slide(b, dt);
    }
    this.#indexBombs();
    for (const b of this.bombs) b.fuse -= dt;
    if (this.bombs.some((b) => b.fuse <= 0)) this.#explodeDue();

    // flames burn out; a burnt crate shows what it was hiding
    for (const [i, f] of this.flames) {
      f.t -= dt;
      if (f.t > 0) continue;
      this.flames.delete(i);
      if (f.reveal && this.grid[i] === FLOOR) this.powerups.set(i, f.reveal);
    }

    // anyone standing in fire is out
    for (const slot of SLOTS) {
      const p = this.p[slot];
      if (p.alive && this.flames.has(this.#tileOf(p))) this.#kill(slot, true);
    }
  }

  #tileOf(p) { return Math.round(p.y) * this.w + Math.round(p.x); }

  /** Does tile i stop player p? Walls, crates, and bombs the player is not already standing on. */
  #blocks(p, i) {
    if (i < 0 || i >= this.n || this.grid[i] !== FLOOR) return true;
    const b = this.bombAt.get(i);
    return !!b && !b.pass.has(p.slot);
  }

  /**
   * Grid movement with corner help, like the classics: you walk along a lane; when you turn, you are first pulled
   * onto the centre of the new lane. Pushing into a pillar while slightly off-centre slides you around it.
   * `limit` (bots only) stops the walk at an exact coordinate along the direction of travel.
   */
  #move(p, dir, dist, limit) {
    const horiz = DX[dir] !== 0;
    const s = horiz ? DX[dir] : DY[dir];
    let a = horiz ? p.x : p.y; //  along the direction of travel
    let l = horiz ? p.y : p.x; //  across it (the lane)
    const at = (along, lane) => (horiz ? lane * this.w + along : along * this.w + lane);
    const lc = Math.round(l);
    const ar = Math.round(a);
    const off = l - lc;
    const frontBlocked = (lane) => this.#blocks(p, at(ar + s, lane));

    if (Math.abs(off) > 1e-6) {
      if (frontBlocked(lc) && Math.abs(off) > 0.12) { // corner help: the other lane is open, slide toward it
        const l2 = lc + Math.sign(off);
        if (!this.#blocks(p, at(ar, l2)) && !frontBlocked(l2)) {
          l += Math.sign(off) * Math.min(dist, Math.abs(l2 - l));
          if (horiz) p.y = l; else p.x = l;
          return;
        }
      }
      const m = Math.min(Math.abs(off), dist); // first get onto the lane's centre line
      l -= Math.sign(off) * m;
      dist -= m;
    }
    if (dist > 1e-9) {
      let na = a + s * dist;
      if (limit != null) na = s > 0 ? Math.min(na, Math.max(a, limit)) : Math.max(na, Math.min(a, limit));
      if (frontBlocked(lc)) {
        na = s > 0 ? Math.min(na, Math.max(a, ar)) : Math.max(na, Math.min(a, ar));
        if (p.kick && Math.abs(na - ar) < 0.02) this.#tryKick(p, dir, at(ar + s, lc));
      }
      a = na;
    }
    if (horiz) { p.x = a; p.y = l; } else { p.y = a; p.x = l; }
  }

  #tryKick(p, dir, i) {
    const b = this.bombAt.get(i);
    if (!b || b.sx || b.sy || b.pass.has(p.slot)) return;
    if (!this.#slideFree(b, b.cell + DY[dir] * this.w + DX[dir])) return;
    b.sx = DX[dir];
    b.sy = DY[dir];
    this.events.push(['kick', p.slot, b.cell]);
  }

  /** Can a sliding bomb move onto tile i? */
  #slideFree(b, i) {
    if (i < 0 || i >= this.n || this.grid[i] !== FLOOR || this.powerups.has(i)) return false;
    const o = this.bombAt.get(i);
    if (o && o !== b) return false;
    const x = i % this.w;
    const y = (i - x) / this.w;
    return !this.p.some((p) => p.alive && Math.abs(p.x - x) < 0.95 && Math.abs(p.y - y) < 0.95);
  }

  #slide(b, dt) {
    const cx = Math.round(b.x);
    const cy = Math.round(b.y);
    const next = (cy + b.sy) * this.w + cx + b.sx;
    const pastCentre = b.sx ? (b.x - cx) * b.sx >= -1e-6 : (b.y - cy) * b.sy >= -1e-6;
    if (pastCentre && !this.#slideFree(b, next)) { // stop on this tile
      b.x = cx; b.y = cy; b.sx = 0; b.sy = 0;
    } else {
      b.x += b.sx * SLIDE_SPEED * dt;
      b.y += b.sy * SLIDE_SPEED * dt;
    }
    b.cell = Math.round(b.y) * this.w + Math.round(b.x);
  }

  #indexBombs() {
    this.bombAt.clear();
    for (const b of this.bombs) this.bombAt.set(b.cell, b);
  }

  #dropBomb(p) {
    const i = this.#tileOf(p);
    if (this.grid[i] !== FLOOR || this.bombAt.has(i)) return;
    if (this.bombs.filter((b) => b.owner === p.slot).length >= p.bombs) return;
    p.gap = BOMB_GAP;
    const x = i % this.w;
    const y = (i - x) / this.w;
    const pass = new Set();
    for (const q of this.p) if (q.alive && Math.abs(q.x - x) < 0.99 && Math.abs(q.y - y) < 0.99) pass.add(q.slot);
    const b = { id: this.nextBombId++, owner: p.slot, x, y, cell: i, fuse: this.s.fuse, fire: p.fire, pass, sx: 0, sy: 0 };
    this.bombs.push(b);
    this.bombAt.set(i, b);
    this.events.push(['drop', p.slot, i]);
  }

  #powerUp(p, type) {
    if (type === PU_BOMB) p.bombs = Math.min(MAX_BOMBS, p.bombs + 1);
    else if (type === PU_FIRE) p.fire = Math.min(MAX_FIRE, p.fire + 1);
    else if (type === PU_SPEED) p.speed = Math.min(MAX_SPEED, p.speed + 1);
    else if (type === PU_KICK) p.kick = true;
    this.events.push(['pick', p.slot, type]);
  }

  /** Explodes every bomb whose fuse ran out, and every bomb those blasts reach (chain reactions), in one tick. */
  #explodeDue() {
    let guard = 0;
    while (guard++ < 200) {
      const b = this.bombs.find((x) => x.fuse <= 0);
      if (!b) break;
      this.#explode(b);
    }
  }

  #explode(b) {
    const { w } = this;
    b.cell = Math.round(b.y) * w + Math.round(b.x);
    this.bombs.splice(this.bombs.indexOf(b), 1);
    if (this.bombAt.get(b.cell) === b) this.bombAt.delete(b.cell);
    this.#flame(b.cell, 4, 0);
    let crates = 0;
    for (let d = 1; d <= 4; d++) {
      const mask = DX[d] ? 1 : 2;
      let x = b.cell % w;
      let y = (b.cell - x) / w;
      for (let k = 1; k <= b.fire; k++) {
        x += DX[d];
        y += DY[d];
        if (x < 0 || y < 0 || x >= w || y >= this.h) break;
        const i = y * w + x;
        if (this.grid[i] === SOLID) break;
        if (this.grid[i] === CRATE) {
          this.grid[i] = FLOOR;
          this.gridDirty = true;
          this.#flame(i, mask, this.hidden[i]);
          this.hidden[i] = 0;
          crates++;
          break;
        }
        if (this.powerups.has(i)) { // a blast burns the power-up away
          this.powerups.delete(i);
          this.#flame(i, mask, 0);
          this.events.push(['burn', i]);
          break;
        }
        this.#flame(i, mask, 0);
        const o = this.bombAt.get(i);
        if (o) o.fuse = Math.min(o.fuse, 0); // chain reaction
      }
    }
    this.events.push(['boom', b.cell, b.owner, b.fire, crates]);
  }

  #flame(i, mask, reveal) {
    const f = this.flames.get(i);
    if (f) { f.t = FLAME_TIME; f.mask |= mask; if (reveal) f.reveal = reveal; } else this.flames.set(i, { t: FLAME_TIME, mask, reveal });
  }

  #kill(slot, announce) {
    const p = this.p[slot];
    p.alive = false;
    p.dir = this.human[slot] ? p.dir : 0;
    p.moving = false;
    if (announce) this.events.push(['die', slot, this.#tileOf(p)]);
  }

  #nextSd() {
    while (this.sdIndex < this.spiral.length && this.grid[this.spiral[this.sdIndex]] === SOLID) this.sdIndex++;
    return this.sdIndex < this.spiral.length ? this.spiral[this.sdIndex] : -1;
  }

  #dropWall() {
    const i = this.#nextSd();
    if (i < 0) return;
    this.sdIndex++;
    this.grid[i] = SOLID;
    this.hidden[i] = 0;
    this.gridDirty = true;
    this.powerups.delete(i);
    this.flames.delete(i);
    const b = this.bombAt.get(i);
    if (b) { this.bombs.splice(this.bombs.indexOf(b), 1); this.bombAt.delete(i); }
    this.events.push(['wall', i]);
    for (const slot of SLOTS) if (this.p[slot].alive && this.#tileOf(this.p[slot]) === i) this.#kill(slot, true);
  }

  // ── bots ──

  /** Blast cells of a bomb at tile i with range `fire`, as the bots predict them (crates and power-ups stop a ray). */
  #blastCells(i, fire) {
    const { w } = this;
    const out = [i];
    for (let d = 1; d <= 4; d++) {
      let x = i % w;
      let y = (i - x) / w;
      for (let k = 1; k <= fire; k++) {
        x += DX[d];
        y += DY[d];
        const j = y * w + x;
        if (this.grid[j] === SOLID) break;
        out.push(j);
        if (this.grid[j] === CRATE || this.powerups.has(j)) break;
      }
    }
    return out;
  }

  /**
   * Danger map: for every tile, when fire will arrive (start) and leave (end), in seconds from now, including chain
   * reactions. `extra` = a bomb the bot is thinking of dropping: { cell, fire }.
   */
  #danger(extra) {
    const start = new Float32Array(this.n).fill(Infinity);
    const end = new Float32Array(this.n).fill(-Infinity);
    for (const [i, f] of this.flames) { start[i] = 0; end[i] = f.t; }
    if (this.clock <= 0 && this.s.suddenDeath) { // sudden-death walls about to fall: fire that never goes out
      let t = SD_INTERVAL - this.sdAcc;
      for (let j = this.sdIndex; j < this.spiral.length && t < 2.6; j++) { // only the next few seconds of walls
        const i = this.spiral[j];
        if (this.grid[i] === SOLID) continue;
        start[i] = Math.min(start[i], t);
        end[i] = Infinity;
        t += SD_INTERVAL;
      }
    }
    const list = this.bombs.map((b) => ({ cell: b.cell, fire: b.fire, t: Math.max(0, b.fuse) }));
    if (extra) list.push({ cell: extra.cell, fire: extra.fire, t: this.s.fuse });
    for (const b of list) b.cells = this.#blastCells(b.cell, b.fire);
    const at = new Map(list.map((b) => [b.cell, b]));
    for (let pass = 0, changed = true; changed && pass < 12; pass++) {
      changed = false;
      for (const b of list) {
        for (const c of b.cells) {
          const o = at.get(c);
          if (o && o.t > b.t) { o.t = b.t; changed = true; }
        }
      }
    }
    for (const b of list) {
      for (const c of b.cells) {
        if (b.t < start[c]) start[c] = b.t;
        if (b.t + FLAME_TIME > end[c]) end[c] = b.t + FLAME_TIME;
      }
    }
    return { start, end, bombs: new Set(list.map((b) => b.cell)) };
  }

  /**
   * Breadth-first search from tile `from` over walkable tiles. `safe` = only step on tiles that are not in a blast
   * zone at all; otherwise a tile may be crossed if the fire is not there while the bot passes.
   */
  #bfs(from, danger, speed, safe, margin) {
    const { w } = this;
    const dist = new Int16Array(this.n).fill(-1);
    const prev = new Int16Array(this.n).fill(-1);
    const order = [from];
    dist[from] = 0;
    const step = 1 / speed;
    for (let q = 0; q < order.length; q++) {
      const i = order[q];
      for (let d = 1; d <= 4; d++) {
        const j = i + DY[d] * w + DX[d];
        if (j < 0 || j >= this.n || dist[j] >= 0 || this.grid[j] !== FLOOR || danger.bombs.has(j)) continue;
        const t = (dist[i] + 1) * step;
        if (danger.start[j] !== Infinity) {
          if (safe) continue;
          const okBefore = t + step + margin < danger.start[j]; // through before it blows
          const okAfter = t - margin > danger.end[j]; //          or after the fire is gone
          if (!okBefore && !okAfter) continue;
        }
        dist[j] = dist[i] + 1;
        prev[j] = i;
        order.push(j);
      }
    }
    return { dist, prev, order };
  }

  /** Nearest tile with no danger at all that the bot can reach in time, or -1. */
  #refuge(from, danger, speed, margin) {
    const r = this.#bfs(from, danger, speed, false, margin);
    for (const i of r.order) if (danger.start[i] === Infinity) return { goal: i, bfs: r, safe: true };
    // nowhere fully safe: at least go where the fire comes last
    let best = from;
    for (const i of r.order) if (danger.start[i] > danger.start[best] + 0.05) best = i;
    return { goal: best, bfs: r, safe: false };
  }

  #enemyTiles(slot) {
    const out = new Set();
    for (const q of this.p) if (q.alive && q.slot !== slot) out.add(this.#tileOf(q));
    return out;
  }

  /** How good is dropping a bomb on tile i: crates it would break, players it could catch. */
  #bombValue(i, fire, enemies, hunt) {
    let v = 0;
    for (const c of this.#blastCells(i, fire)) {
      if (this.grid[c] === CRATE) v += 1;
      if (enemies.has(c)) v += 1.5 + hunt * 3;
      if (this.powerups.has(c)) v -= 1.5; // don't burn power-ups
    }
    return v;
  }

  #botThink(slot, dt, danger) {
    const p = this.p[slot];
    const st = this.botState[slot];
    const k = this.skill;
    const speed = speedOf(p.speed);
    const here = this.#tileOf(p);
    p.limit = null;

    // 1. Am I standing where fire is coming? Then run, after a short "reaction" delay.
    if (danger.start[here] !== Infinity) {
      st.noticed += dt;
      if (st.noticed >= k.notice && (st.mode !== 'flee' || danger.start[st.goal] !== Infinity || st.t <= 0)) {
        const r = this.#refuge(here, danger, speed, k.margin);
        st.mode = 'flee';
        st.goal = r.goal;
        st.t = 0.25;
      }
    } else {
      st.noticed = 0;
      if (st.mode === 'flee') { st.mode = 'idle'; st.t = 0; }
    }

    st.t -= dt;
    if (st.mode !== 'flee' && st.t <= 0) {
      st.t = rnd(k.react[0], k.react[1]);
      this.#botDecide(slot, here, danger, speed);
    }

    // 2. Walk toward the goal.
    if (st.mode === 'bomb' && st.goal === here && this.#centred(p)) {
      this.#botTryBomb(slot, here, speed);
      st.mode = 'idle';
      st.t = 0;
    }
    this.#steer(p, here, st.goal, danger, speed, st.mode === 'flee');
  }

  #centred(p) { return Math.abs(p.x - Math.round(p.x)) < 0.08 && Math.abs(p.y - Math.round(p.y)) < 0.08; }

  #botTryBomb(slot, here, speed) {
    const p = this.p[slot];
    if (this.bombs.filter((b) => b.owner === slot).length >= p.bombs || this.bombAt.has(here)) return false;
    if (Math.random() >= this.skill.slip) {
      const d2 = this.#danger({ cell: here, fire: p.fire });
      const r = this.#refuge(here, d2, speed, this.skill.margin + 0.1);
      if (!r.safe || r.bfs.dist[r.goal] / speed > this.s.fuse - 0.35) return false; // no way out: don't
    }
    p.want = true;
    return true;
  }

  #botDecide(slot, here, danger, speed) {
    const p = this.p[slot];
    const st = this.botState[slot];
    const k = this.skill;
    const enemies = this.#enemyTiles(slot);
    const hunt = this.clock <= 0 ? 1 : k.hunt; // sudden death: the walls are coming, go for the kill
    const canBomb = this.bombs.filter((b) => b.owner === slot).length < p.bombs;

    // drop a bomb right here if it is worth it
    if (canBomb && this.#bombValue(here, p.fire, enemies, hunt) >= 1 && this.#centred(p) && this.#botTryBomb(slot, here, speed)) {
      st.mode = 'idle';
      return;
    }

    const r = this.#bfs(here, danger, speed, true, 0);
    // a power-up nearby?
    for (const i of r.order) {
      if (r.dist[i] > k.grab) break;
      if (this.powerups.has(i)) { st.mode = 'go'; st.goal = i; return; }
    }
    // the best spot to bomb (crates, or players if the bot is in a hunting mood)
    if (canBomb) {
      let best = -1;
      let bestScore = 0;
      for (const i of r.order) {
        const v = this.#bombValue(i, p.fire, enemies, hunt);
        if (v < 1) continue;
        const score = v - r.dist[i] * 0.35 + Math.random() * 0.3;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) { st.mode = 'bomb'; st.goal = best; return; }
    }
    // nothing to blow up nearby: go toward the closest player (through any walkable tiles)
    if (enemies.size) {
      for (const i of r.order) {
        if (r.dist[i] > 0 && [1, 2, 3, 4].some((d) => enemies.has(i + DY[d] * this.w + DX[d]))) { st.mode = 'go'; st.goal = i; return; }
      }
    }
    // wander
    const opts = r.order.filter((i) => r.dist[i] > 0 && r.dist[i] <= 4);
    st.mode = 'go';
    st.goal = opts.length ? opts[Math.floor(Math.random() * opts.length)] : here;
  }

  /** Point the bot one tile along the path toward `goal`, or centre it on the goal. */
  #steer(p, here, goal, danger, speed, fleeing) {
    if (goal < 0 || goal === here) {
      const cx = Math.round(p.x);
      const cy = Math.round(p.y);
      if (Math.abs(p.x - cx) > 0.04) { p.dir = p.x < cx ? 2 : 4; p.limit = cx; } else if (Math.abs(p.y - cy) > 0.04) { p.dir = p.y < cy ? 3 : 1; p.limit = cy; } else p.dir = 0;
      return;
    }
    const r = this.#bfs(here, danger, speed, !fleeing, this.skill.margin);
    if (r.dist[goal] < 0) { // goal not reachable any more: think again next tick
      this.botState[p.slot].t = 0;
      if (this.botState[p.slot].mode !== 'flee') this.botState[p.slot].mode = 'idle';
      p.dir = 0;
      return;
    }
    let n = goal;
    while (r.prev[n] !== here && r.prev[n] >= 0) n = r.prev[n];
    const dx = (n % this.w) - (here % this.w);
    const dy = Math.floor(n / this.w) - Math.floor(here / this.w);
    p.dir = dx > 0 ? 2 : dx < 0 ? 4 : dy > 0 ? 3 : 1;
    p.limit = dx ? n % this.w : Math.floor(n / this.w);
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const bombers = {
  meta,
  create: (ctx) => new BombersGame(ctx),
};

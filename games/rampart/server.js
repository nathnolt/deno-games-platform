import {
  COLS, ROWS, TILE, N, ARENA_W, ARENA_H, HIT_R, TERRAIN, KEEPS, KEEP_AT, RING_TILES, ringRect, isRingCorner,
  PIECES, PIECE_WEIGHTS, pieceCells, idx, inb, meta,
} from './shared.js';

const SLOTS = [0, 1, 2, 3];
const READY_TIME = 3;
const RESULT_TIME = 3.5;
const MAX_FLIGHT_WAIT = 3; //   s: after the battle timer ends, wait this long at most for balls in the air
const SKIP_COOLDOWN = 1; //     s between discarded pieces
const SEQ_LEN = 400;
const MIN_CANNONS = 2; //       a player holding a castle is always topped up to this many cannons
const SCORE_WALL = 5;
const SCORE_CANNON = 50;
const SCORE_KEEP = 25; //       per castle held at the end of a build phase (plus 1 per enclosed land tile)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const rnd = (a, b) => a + Math.random() * (b - a);

// ── bots ──
// place:  seconds between cannon placements        build: seconds between wall pieces
// react:  [min, max] seconds a bot waits between aiming at a new target
// error:  aim error in px (the blast radius is ~10 px, so 34 misses a lot)
// expand: also builds walls around a free castle once its own castles are closed
// hunt:   chance that a shot goes at a cannon instead of a wall
const SKILL = {
  easy: { place: 1.2, build: 1.5, react: [1.3, 2.6], error: 34, expand: false, hunt: 0 },
  normal: { place: 0.7, build: 0.95, react: [0.7, 1.5], error: 14, expand: true, hunt: 0.25 },
  hard: { place: 0.45, build: 0.6, react: [0.35, 0.9], error: 5, expand: true, hunt: 0.5 },
};

class RampartsGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = ctx.settings;
    this.slotOf = new Map(); // playerId -> slot
    this.active = [false, false, false, false]; // seat is occupied (human or bot)
    this.bot = [false, false, false, false];
    this.alive = [false, false, false, false];
    this.lives = [0, 0, 0, 0];
    this.score = [0, 0, 0, 0];
    this.allow = [0, 0, 0, 0]; //       cannons still to place this round
    this.pieceIdx = [0, 0, 0, 0]; //    position in the piece sequence
    this.skipCool = [0, 0, 0, 0];
    this.botState = [null, null, null, null];

    this.wall = new Int8Array(N).fill(-1); //  tile -> slot that owns the wall on it, or -1
    this.occ = new Int16Array(N); //            tile -> cannon id (0 = none)
    this.terr = SLOTS.map(() => new Uint8Array(N)); // per slot: 1 = enclosed by that slot's walls
    this.terrCount = [0, 0, 0, 0]; //           enclosed land tiles
    this.keepOwner = KEEPS.map(() => -1);
    this.cannons = new Map();
    this.nextCannonId = 1;
    this.balls = [];
    this.nextBallId = 1;
    this.seq = [];
    this.events = [];
    this.gridDirty = true;
    this.phase = 'ready';
    this.timer = READY_TIME;
    this.round = 0;
    this.tick = 0;
    this.cease = false; //  battle timer ran out: no new shots, waiting for the balls in the air
    this.waitFlight = 0;
    this.final = null; //   set when the match is decided; announced after the result pause
    this.finished = false;

    for (const p of ctx.players) {
      if (p.slot < 0 || p.slot > 3) continue;
      this.slotOf.set(p.id, p.slot);
      this.active[p.slot] = true;
    }
    this.humans = this.slotOf.size;
    for (const slot of ctx.bots ?? []) {
      if (slot >= 0 && slot < 4 && !this.active[slot]) {
        this.active[slot] = this.bot[slot] = true;
        this.botState[slot] = { t: 1, shotAt: 1, targets: null, refresh: 0 };
      }
    }
    for (const slot of SLOTS) {
      if (!this.active[slot]) continue;
      this.alive[slot] = true;
      this.lives[slot] = this.s.lives;
      this.#resetHome(slot);
    }
    this.#newSeq();
  }

  // ── GameInstance ──
  onInput(playerId, data) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !this.alive[slot] || !data || typeof data !== 'object') return;
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (Array.isArray(data.f)) {
      if (this.phase === 'battle' && num(data.f[0]) && num(data.f[1])) this.#fire(slot, data.f[0], data.f[1]);
    } else if (Array.isArray(data.c)) {
      if (this.phase === 'place' && Number.isInteger(data.c[0]) && Number.isInteger(data.c[1])) this.#placeCannon(slot, data.c[0], data.c[1]);
    } else if (Array.isArray(data.p)) {
      if (this.phase === 'build' && Number.isInteger(data.p[0]) && Number.isInteger(data.p[1]) && Number.isInteger(data.p[2])) {
        this.#placePiece(slot, data.p[0], data.p[1], data.p[2] & 3);
      }
    } else if (data.d === 1) {
      if (this.phase === 'build' && this.skipCool[slot] <= 0) { // the piece cannot be placed anywhere: throw it away
        this.pieceIdx[slot]++;
        this.skipCool[slot] = SKIP_COOLDOWN;
      }
    }
  }

  onLeave(playerId) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined) return;
    this.slotOf.delete(playerId);
    this.humans--;
    if (this.alive[slot]) this.#eliminate(slot);
    if (this.humans < 1 && !this.finished) this.#finish({ winner: -1, reason: 'abandoned' });
  }

  update(dt) {
    try {
      this.#step(dt);
    } catch (err) { // never let a bug here take the whole server down
      console.error('Ramparts update error', err);
    }
  }

  #step(dt) {
    if (this.finished) return;
    this.tick++;
    this.events = [];
    for (const slot of SLOTS) this.skipCool[slot] = Math.max(0, this.skipCool[slot] - dt);
    switch (this.phase) {
      case 'ready':
        this.timer -= dt;
        if (this.timer <= 0) this.#startPlace();
        break;
      case 'place': {
        this.timer -= dt;
        for (const slot of SLOTS) if (this.alive[slot] && this.bot[slot]) this.#botPlace(slot, dt);
        if (SLOTS.every((s) => !this.alive[s] || this.allow[s] <= 0)) this.timer = Math.min(this.timer, 0.7);
        if (this.timer <= 0) this.#startBattle();
        break;
      }
      case 'battle': {
        if (!this.cease) {
          this.timer -= dt;
          if (this.timer <= 0) { this.timer = 0; this.cease = true; this.waitFlight = MAX_FLIGHT_WAIT; }
        } else this.waitFlight -= dt;
        for (const c of this.cannons.values()) c.cd = Math.max(0, c.cd - dt);
        if (!this.cease) for (const slot of SLOTS) if (this.alive[slot] && this.bot[slot]) this.#botShoot(slot, dt);
        this.#ballSystem(dt);
        if (this.cease && (this.balls.length === 0 || this.waitFlight <= 0)) { this.balls.length = 0; this.#startBuild(); }
        break;
      }
      case 'build':
        this.timer -= dt;
        for (const slot of SLOTS) if (this.alive[slot] && this.bot[slot]) this.#botBuild(slot, dt);
        if (this.timer <= 0) this.#finishBuild();
        break;
      case 'result':
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.final) this.#finish(this.final);
          else this.#startPlace();
        }
        break;
    }
  }

  snapshot() {
    const reload = this.s.reload;
    const snap = {
      tick: this.tick,
      phase: this.phase,
      timer: r1(Math.max(0, this.timer)),
      round: this.round,
      cease: this.cease,
      cn: [...this.cannons.values()].map((c) => [c.id, c.slot, c.x, c.y, c.hp, r2(1 - clamp(c.cd / reload, 0, 1)), c.active ? 1 : 0]),
      balls: this.balls.map((b) => [b.id, b.owner, Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1), r2(b.t / b.dur), r2(b.dur)]),
      ko: [...this.keepOwner],
      lives: [...this.lives],
      score: [...this.score],
      allow: [...this.allow],
      alive: [...this.alive],
      active: [...this.active],
      bots: [...this.bot],
      tc: [...this.terrCount],
      pi: [...this.pieceIdx],
      pq: SLOTS.map((s) => (this.phase === 'build' && this.alive[s] ? [this.#pieceAt(this.pieceIdx[s]), this.#pieceAt(this.pieceIdx[s] + 1), this.#pieceAt(this.pieceIdx[s] + 2)] : [])),
      ev: this.events.slice(0, 60),
    };
    if (this.gridDirty || this.tick % 30 === 0) { // the wall / territory map is big: only sent when it changed (and once a second for late joiners)
      snap.grid = this.#gridString();
      this.gridDirty = false;
    }
    return snap;
  }

  // ── round flow ──
  #startPlace() {
    this.round++;
    this.phase = 'place';
    this.timer = this.s.placeTime;
    for (const slot of SLOTS) {
      this.allow[slot] = 0;
      if (!this.alive[slot]) continue;
      let a = 0;
      KEEPS.forEach((k, i) => {
        if (this.keepOwner[i] === slot && this.terr[slot][k.y * COLS + k.x]) a += i === slot ? this.s.cannonsHome : this.s.cannonsPerKeep;
      });
      if (a > 0) a = Math.max(a, MIN_CANNONS - this.#cannonCount(slot)); // catch-up: a player who still holds a castle can always get back to 2 cannons
      a = Math.min(a, this.s.maxCannons - this.#cannonCount(slot));
      this.allow[slot] = Math.max(0, a);
      if (!this.#hasCannonSpot(slot)) this.allow[slot] = 0;
      const bs = this.botState[slot];
      if (bs) bs.t = rnd(0.5, 1.2);
    }
    this.events.push({ k: 'p', n: 'place' });
  }

  #startBattle() {
    this.phase = 'battle';
    this.timer = this.s.battleTime;
    this.cease = false;
    this.balls.length = 0;
    for (const c of this.cannons.values()) {
      c.active = this.alive[c.slot] && this.#cannonInside(c);
      c.cd = rnd(0.4, 1);
    }
    for (const slot of SLOTS) {
      const bs = this.botState[slot];
      if (bs) { bs.shotAt = rnd(0.8, 1.6); bs.targets = null; bs.refresh = 0; }
    }
    this.events.push({ k: 'p', n: 'battle' });
  }

  #startBuild() {
    this.phase = 'build';
    this.timer = this.s.buildTime;
    this.#newSeq();
    this.pieceIdx = [0, 0, 0, 0];
    this.skipCool = [0, 0, 0, 0];
    for (const slot of SLOTS) { const bs = this.botState[slot]; if (bs) bs.t = rnd(0.6, 1.2); }
    this.events.push({ k: 'p', n: 'build' });
  }

  #finishBuild() {
    for (const slot of SLOTS) if (this.alive[slot]) this.#recomputeTerr(slot);
    // 1. who holds which castle: the old owner keeps it while it stays enclosed, otherwise an enclosing player takes it
    KEEPS.forEach((k, i) => {
      const t = k.y * COLS + k.x;
      const old = this.keepOwner[i];
      let owner = -1;
      if (old >= 0 && this.alive[old] && this.terr[old][t]) owner = old;
      else for (const s of SLOTS) if (this.alive[s] && this.terr[s][t]) { owner = s; break; }
      if (owner !== old) this.events.push({ k: 'kc', i, o: owner });
      this.keepOwner[i] = owner;
    });
    // 2. lives, scores
    for (const slot of SLOTS) {
      if (!this.alive[slot]) continue;
      const held = this.keepOwner.filter((o) => o === slot).length;
      if (held === 0) {
        this.lives[slot]--;
        this.events.push({ k: 'l', o: slot });
        if (this.lives[slot] <= 0) this.#eliminate(slot);
        else this.#resetHome(slot); // the castle gets a fresh ring of walls, like at the start of the game
      } else {
        this.score[slot] += this.terrCount[slot] + held * SCORE_KEEP;
      }
    }
    // 3. is the match over?
    const alive = SLOTS.filter((s) => this.alive[s]);
    const humansAlive = alive.some((s) => !this.bot[s]);
    let reason = null;
    if (alive.length <= 1) reason = 'last';
    else if (!humansAlive) reason = 'humans-out';
    else if (this.round >= this.s.maxRounds) reason = 'rounds';
    if (reason) this.final = this.#result(reason);
    this.phase = 'result';
    this.timer = RESULT_TIME;
    this.events.push({ k: 'p', n: 'result' });
  }

  #result(reason) {
    const order = SLOTS.filter((s) => this.active[s]).sort((a, b) =>
      Number(this.alive[b]) - Number(this.alive[a]) || this.score[b] - this.score[a] || this.terrCount[b] - this.terrCount[a]);
    return { winner: order.length ? order[0] : -1, reason, rounds: this.round, scores: [...this.score], lives: [...this.lives], alive: [...this.alive] };
  }

  #finish(result) {
    if (this.finished) return;
    this.finished = true;
    this.ctx.end(result); // the platform sends {t:'gameEnd', result} and returns the room to setup
  }

  #eliminate(slot) {
    this.alive[slot] = false;
    this.allow[slot] = 0;
    for (let i = 0; i < N; i++) if (this.wall[i] === slot) this.wall[i] = -1;
    for (const c of [...this.cannons.values()]) if (c.slot === slot) this.#removeCannon(c);
    this.keepOwner = this.keepOwner.map((o) => (o === slot ? -1 : o));
    this.terr[slot].fill(0);
    this.terrCount[slot] = 0;
    this.gridDirty = true;
    this.events.push({ k: 'x', o: slot });
  }

  /** (Re)builds the starting ring of walls around a seat's home castle and gives the castle back to it. */
  #resetHome(slot) {
    for (const i of RING_TILES[slot]) {
      const cid = this.occ[i];
      if (cid) { const c = this.cannons.get(cid); if (c) this.#removeCannon(c); }
      this.wall[i] = slot;
    }
    this.keepOwner[slot] = slot;
    this.#recomputeTerr(slot);
  }

  // ── territory ──
  /** Enclosed = cannot be reached from outside the map without crossing one of the slot's own walls (4-way moves, so a diagonal chain of walls is tight). */
  #recomputeTerr(slot) {
    const out = new Uint8Array(N);
    const q = new Int32Array(N);
    let h = 0;
    let t = 0;
    const wall = this.wall;
    const push = (i) => { if (!out[i] && wall[i] !== slot) { out[i] = 1; q[t++] = i; } };
    for (let x = 0; x < COLS; x++) { push(x); push((ROWS - 1) * COLS + x); }
    for (let y = 0; y < ROWS; y++) { push(y * COLS); push(y * COLS + COLS - 1); }
    while (h < t) {
      const i = q[h++];
      const x = i % COLS;
      if (x > 0) push(i - 1);
      if (x < COLS - 1) push(i + 1);
      if (i >= COLS) push(i - COLS);
      if (i < N - COLS) push(i + COLS);
    }
    const terr = this.terr[slot];
    let count = 0;
    for (let i = 0; i < N; i++) {
      const inside = !out[i] && wall[i] !== slot && this.alive[slot] ? 1 : 0;
      terr[i] = inside;
      if (inside && !TERRAIN[i]) count++;
    }
    this.terrCount[slot] = count;
    this.gridDirty = true;
  }

  #gridString() {
    let s = '';
    for (let i = 0; i < N; i++) {
      const w = this.wall[i];
      if (w >= 0) { s += String.fromCharCode(97 + w); continue; }
      let c = '.';
      for (const slot of SLOTS) if (this.terr[slot][i]) { c = String.fromCharCode(65 + slot); break; }
      s += c;
    }
    return s;
  }

  // ── cannons ──
  #cannonCount(slot) {
    let n = 0;
    for (const c of this.cannons.values()) if (c.slot === slot) n++;
    return n;
  }

  #cannonFits(slot, x, y) {
    if (x < 0 || y < 0 || x + 1 >= COLS || y + 1 >= ROWS) return false;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const i = (y + dy) * COLS + x + dx;
        if (TERRAIN[i] || !this.terr[slot][i] || this.wall[i] !== -1 || KEEP_AT[i] >= 0 || this.occ[i]) return false;
      }
    }
    return true;
  }

  #hasCannonSpot(slot) {
    for (let y = 0; y < ROWS - 1; y++) for (let x = 0; x < COLS - 1; x++) if (this.#cannonFits(slot, x, y)) return true;
    return false;
  }

  #cannonInside(c) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) if (!this.terr[c.slot][(c.y + dy) * COLS + c.x + dx]) return false;
    return true;
  }

  #placeCannon(slot, x, y) {
    if (this.allow[slot] <= 0 || !this.#cannonFits(slot, x, y)) return false;
    const c = { id: this.nextCannonId++, slot, x, y, hp: this.s.cannonHp, cd: 0, active: true };
    this.cannons.set(c.id, c);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.occ[(y + dy) * COLS + x + dx] = c.id;
    this.allow[slot]--;
    if (this.allow[slot] > 0 && !this.#hasCannonSpot(slot)) this.allow[slot] = 0;
    this.gridDirty = true;
    this.events.push({ k: 'cp', o: slot, x: (x + 1) * TILE, y: (y + 1) * TILE });
    return true;
  }

  #removeCannon(c) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.occ[(c.y + dy) * COLS + c.x + dx] = 0;
    this.cannons.delete(c.id);
  }

  // ── battle ──
  /** Fires the ready cannon (inside the walls) that is closest to the target. Returns false if none is ready. */
  #fire(slot, px, py) {
    if (this.phase !== 'battle' || this.cease || !this.alive[slot]) return false;
    const tx = clamp(px, 0, ARENA_W - 0.01);
    const ty = clamp(py, 0, ARENA_H - 0.01);
    let best = null;
    let bd = Infinity;
    for (const c of this.cannons.values()) {
      if (c.slot !== slot || !c.active || c.cd > 0) continue;
      const d = (tx - (c.x + 1) * TILE) ** 2 + (ty - (c.y + 1) * TILE) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return false;
    best.cd = this.s.reload;
    const x0 = (best.x + 1) * TILE;
    const y0 = (best.y + 1) * TILE;
    const dur = Math.max(0.25, Math.sqrt(bd) / this.s.ballSpeed);
    this.balls.push({ id: this.nextBallId++, owner: slot, x0, y0, x1: tx, y1: ty, t: 0, dur });
    this.events.push({ k: 'f', o: slot, c: best.id, x: x0, y: y0, tx: Math.round(tx), ty: Math.round(ty) });
    return true;
  }

  #ballSystem(dt) {
    const keep = [];
    for (const b of this.balls) {
      b.t += dt;
      if (b.t >= b.dur) this.#impact(b);
      else keep.push(b);
    }
    this.balls = keep;
  }

  #impact(b) {
    const { x1: x, y1: y, owner } = b;
    const tx0 = Math.floor((x - HIT_R) / TILE);
    const tx1 = Math.floor((x + HIT_R) / TILE);
    const ty0 = Math.floor((y - HIT_R) / TILE);
    const ty1 = Math.floor((y + HIT_R) / TILE);
    const damaged = new Set();
    const dirty = new Set();
    let walls = 0;
    let hurt = 0;
    let killed = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!inb(tx, ty)) continue;
        const cx = clamp(x, tx * TILE, (tx + 1) * TILE);
        const cy = clamp(y, ty * TILE, (ty + 1) * TILE);
        if ((x - cx) ** 2 + (y - cy) ** 2 > HIT_R * HIT_R) continue;
        const i = ty * COLS + tx;
        const w = this.wall[i];
        if (w >= 0 && w !== owner) {
          this.wall[i] = -1;
          dirty.add(w);
          walls++;
          this.score[owner] += SCORE_WALL;
        }
        const cid = this.occ[i];
        if (cid && !damaged.has(cid)) {
          const c = this.cannons.get(cid);
          if (c && c.slot !== owner) {
            damaged.add(cid);
            if (--c.hp <= 0) { this.#removeCannon(c); killed++; this.score[owner] += SCORE_CANNON; }
            else hurt++;
          }
        }
      }
    }
    for (const s of dirty) this.#recomputeTerr(s);
    if (killed || hurt) this.gridDirty = true;
    const ix = clamp(Math.floor(x / TILE), 0, COLS - 1);
    const iy = clamp(Math.floor(y / TILE), 0, ROWS - 1);
    this.events.push({ k: 'h', o: owner, x: Math.round(x), y: Math.round(y), w: walls, c: hurt, d: killed, wt: TERRAIN[iy * COLS + ix] });
  }

  // ── pieces ──
  #newSeq() {
    const total = PIECE_WEIGHTS.reduce((a, b) => a + b, 0);
    this.seq = [];
    for (let n = 0; n < SEQ_LEN; n++) {
      let r = Math.random() * total;
      let t = 0;
      while (t < PIECE_WEIGHTS.length - 1 && (r -= PIECE_WEIGHTS[t]) >= 0) t++;
      this.seq.push(t);
    }
  }

  #pieceAt(i) { return this.seq[i % SEQ_LEN]; }

  #tileFree(i) { return !TERRAIN[i] && this.wall[i] === -1 && KEEP_AT[i] < 0 && !this.occ[i]; }

  #placePiece(slot, x, y, rot) {
    const cells = pieceCells(this.#pieceAt(this.pieceIdx[slot]), rot);
    const tiles = [];
    for (const [cx, cy] of cells) {
      const tx = x + cx;
      const ty = y + cy;
      if (!inb(tx, ty) || !this.#tileFree(ty * COLS + tx)) return false;
      tiles.push(ty * COLS + tx);
    }
    for (const i of tiles) this.wall[i] = slot;
    this.pieceIdx[slot]++;
    this.#recomputeTerr(slot);
    this.events.push({ k: 'w', o: slot, x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, n: tiles.length });
    return true;
  }

  // ── bots ──
  #botPlace(slot, dt) {
    const bs = this.botState[slot];
    if (this.allow[slot] <= 0) return;
    bs.t -= dt;
    if (bs.t > 0) return;
    const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    bs.t = skill.place * rnd(0.8, 1.2);
    // distance of every enclosed tile from the wall: cannons further inside are safer
    const dist = new Int16Array(N).fill(-1);
    const q = [];
    for (let i = 0; i < N; i++) if (!this.terr[slot][i]) { dist[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const x = i % COLS;
      for (const j of [x > 0 ? i - 1 : -1, x < COLS - 1 ? i + 1 : -1, i - COLS, i + COLS]) {
        if (j >= 0 && j < N && dist[j] < 0) { dist[j] = dist[i] + 1; q.push(j); }
      }
    }
    let best = null;
    let bestScore = -1;
    for (let y = 0; y < ROWS - 1; y++) {
      for (let x = 0; x < COLS - 1; x++) {
        if (!this.#cannonFits(slot, x, y)) continue;
        const d = Math.min(dist[y * COLS + x], dist[y * COLS + x + 1], dist[(y + 1) * COLS + x], dist[(y + 1) * COLS + x + 1]);
        const sc = (skill === SKILL.easy ? 0 : d) + Math.random() * 1.5;
        if (sc > bestScore) { bestScore = sc; best = [x, y]; }
      }
    }
    if (best) this.#placeCannon(slot, best[0], best[1]);
    else this.allow[slot] = 0;
  }

  #botShoot(slot, dt) {
    const bs = this.botState[slot];
    const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    bs.shotAt -= dt;
    bs.refresh -= dt;
    if (bs.shotAt > 0) return;
    if (!SLOTS.some((s) => s !== slot && this.alive[s])) return;
    let ready = false;
    for (const c of this.cannons.values()) if (c.slot === slot && c.active && c.cd <= 0) { ready = true; break; }
    if (!ready) return;
    const enemies = SLOTS.filter((s) => s !== slot && this.alive[s]);
    const enemy = enemies[Math.floor(Math.random() * enemies.length)];
    let tx = -1;
    let ty = -1;
    const cannons = [...this.cannons.values()].filter((c) => c.slot === enemy);
    if (cannons.length && Math.random() < skill.hunt) {
      const c = cannons[Math.floor(Math.random() * cannons.length)];
      tx = (c.x + 1) * TILE;
      ty = (c.y + 1) * TILE;
    } else {
      // wall tiles that touch the enemy's territory are the ones that keep it closed
      const edge = [];
      for (let i = 0; i < N; i++) {
        if (this.wall[i] !== enemy) continue;
        const x = i % COLS;
        if ((x > 0 && this.terr[enemy][i - 1]) || (x < COLS - 1 && this.terr[enemy][i + 1]) || (i >= COLS && this.terr[enemy][i - COLS]) || (i < N - COLS && this.terr[enemy][i + COLS])) edge.push(i);
      }
      if (!edge.length) return;
      const inFlight = new Set(this.balls.map((b) => Math.floor(b.y1 / TILE) * COLS + Math.floor(b.x1 / TILE)));
      const fresh = edge.filter((i) => !inFlight.has(i));
      const pool = fresh.length ? fresh : edge;
      const i = pool[Math.floor(Math.random() * pool.length)];
      tx = (i % COLS + 0.5) * TILE;
      ty = (Math.floor(i / COLS) + 0.5) * TILE;
    }
    const e = skill.error;
    if (this.#fire(slot, tx + rnd(-e, e), ty + rnd(-e, e))) bs.shotAt = rnd(skill.react[0], skill.react[1]);
    else bs.shotAt = 0.15;
  }

  #botBuild(slot, dt) {
    const bs = this.botState[slot];
    bs.t -= dt;
    if (bs.t > 0) return;
    const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    bs.t = skill.build * rnd(0.8, 1.2);
    const want = this.#botWant(slot, skill);
    const type = this.#pieceAt(this.pieceIdx[slot]);
    let best = null;
    let bestScore = -Infinity;
    const seen = new Set();
    for (let rot = 0; rot < 4; rot++) {
      const cells = pieceCells(type, rot);
      const key = cells.map((c) => c.join(',')).sort().join(';');
      if (seen.has(key)) continue;
      seen.add(key);
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          let sc = Math.random() * 0.1;
          let ok = true;
          for (const [cx, cy] of cells) {
            const tx = x + cx;
            const ty = y + cy;
            if (!inb(tx, ty)) { ok = false; break; }
            const i = ty * COLS + tx;
            if (!this.#tileFree(i)) { ok = false; break; }
            sc += want[i];
            if ((tx > 0 && this.wall[i - 1] === slot) || (tx < COLS - 1 && this.wall[i + 1] === slot) || (ty > 0 && this.wall[i - COLS] === slot) || (ty < ROWS - 1 && this.wall[i + COLS] === slot)) sc += 0.15;
          }
          if (ok && sc > bestScore) { bestScore = sc; best = [x, y, rot]; }
        }
      }
    }
    if (best) this.#placePiece(slot, best[0], best[1], best[2]);
    else this.pieceIdx[slot]++; // nothing fits: discard it
  }

  /** Per-tile desirability for a bot's next wall piece: missing ring tiles around the castles it wants closed are worth a lot, the room inside the ring is kept free for cannons. */
  #botWant(slot, skill) {
    const want = new Float32Array(N).fill(-0.2);
    const targets = [];
    KEEPS.forEach((_, k) => { if (this.keepOwner[k] === slot) targets.push(k); });
    const missing = (k) => RING_TILES[k].some((i) => this.wall[i] !== slot && this.#tileFree(i) && !isRingCorner(k, i % COLS, Math.floor(i / COLS)));
    if (skill.expand && !targets.some(missing)) {
      let bestK = -1;
      let bd = Infinity;
      KEEPS.forEach((k, i) => {
        if (this.keepOwner[i] !== -1) return;
        const d = Math.abs(k.x - KEEPS[slot].x) + Math.abs(k.y - KEEPS[slot].y);
        if (d < bd) { bd = d; bestK = i; }
      });
      if (bestK >= 0) targets.push(bestK);
    }
    for (const k of targets) {
      const { x0, y0, x1, y1 } = ringRect(k);
      for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) if (inb(x, y)) want[idx(x, y)] = -1.2;
      for (const i of RING_TILES[k]) {
        if (this.wall[i] === slot || !this.#tileFree(i)) continue;
        want[i] = isRingCorner(k, i % COLS, Math.floor(i / COLS)) ? 0.4 : 3;
      }
    }
    return want;
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const ramparts = {
  meta,
  create: (ctx) => new RampartsGame(ctx),
};

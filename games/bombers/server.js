import {
  CRATE, CURSE_SPEED, CURSE_TIME, C_DIARRHEA, C_FUSE, C_NOBOMB, C_REVERSE, C_WEAK, CURSES, DX, DY, FLAME_TIME, FLOOR,
  MAX_BOMBS, MAX_FIRE, MAX_LIVES, MAX_SPEED, MONSTERS, M_BLOB, M_CHASER, M_DASHER, M_GHOST, M_SNEAK, OPP,
  PU_BOMB, PU_FIRE, PU_KICK, PU_LIFE, PU_SKULL, PU_SPEED, SD_INTERVAL, SHORT_FUSE, SLIDE_SPEED, SOLID,
  arenaOf, isPillar, meta, spawnsOf, speedOf, spiralOf,
} from './shared.js';

const SLOTS = [0, 1, 2, 3];
const READY_TIME = 2.6; //    countdown before each round / level
const GRACE_TIME = 1.1; //    battle: after only one player is left, a simultaneous death still makes a draw
const RESULT_TIME = 3.6; //   battle: round-over pause
const CLEAR_TIME = 3.4; //    co-op: level-clear pause
const RESPAWN_TIME = 2.2; //  co-op: seconds out before you come back
const SHIELD_TIME = 3; //     co-op: invulnerable after coming back
const BOMB_GAP = 0.12; //     s: anti-spam between two bomb drops by the same player
const FAST_FORWARD = 3; //    battle: simulation speed while only bots are still alive in the round
const CRATE_POINTS = 10;
const EXIT_SPAWN_MAX = 6; //  co-op: monsters a level's exit can release when bombed
const REV = [0, 3, 4, 1, 2]; // reversed controls

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weighted = (table) => {
  const total = table.reduce((a, [, wt]) => a + wt, 0);
  let r = Math.random() * total;
  for (const [v, wt] of table) if ((r -= wt) <= 0) return v;
  return table[0][0];
};

// ── bots ──
// react:  [min, max] seconds between two decisions while nothing is threatening the bot
// notice: seconds before the bot notices it is standing in a blast zone
// margin: extra safety (s) the bot keeps between itself and flames
// hunt:   0..1, how much the bot goes after its targets rather than crates
// slip:   chance per decision to ignore the escape check (easy bots sometimes trap themselves)
// grab:   how far (tiles) the bot walks for a power-up
const SKILL = {
  easy: { react: [0.55, 1.0], notice: 0.35, margin: 0.05, hunt: 0.15, slip: 0.04, grab: 4 },
  normal: { react: [0.22, 0.5], notice: 0.12, margin: 0.15, hunt: 0.45, slip: 0, grab: 8 },
  hard: { react: [0.06, 0.18], notice: 0, margin: 0.22, hunt: 0.85, slip: 0, grab: 14 },
};

/** Co-op: which monsters a level has. More of them, and nastier kinds, as you go. */
function levelPlan(level) {
  const n = Math.min(14, 3 + Math.floor(level * 0.9));
  const table = [[M_BLOB, Math.max(1, 6 - level * 0.5)]];
  if (level >= 2) table.push([M_CHASER, 2 + level * 0.3]);
  if (level >= 3) table.push([M_DASHER, 1.5 + level * 0.2]);
  if (level >= 4) table.push([M_GHOST, 1 + level * 0.2]);
  if (level >= 6) table.push([M_SNEAK, 0.6 + level * 0.15]);
  const out = [];
  for (let k = 0; k < n; k++) out.push(weighted(table));
  if (level >= 2 && !out.includes(M_CHASER)) out[0] = M_CHASER; // each new level shows its newest kind
  if (level >= 3 && level <= 5) out[1 % n] = [M_CHASER, M_DASHER, M_GHOST][Math.min(2, level - 3)];
  if (level === 6) out[1 % n] = M_SNEAK;
  return out;
}

class BombersGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = ctx.settings;
    this.coop = this.s.mode === 'coop';
    const { w, h } = arenaOf(this.s.arena);
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.spawns = spawnsOf(w, h);
    this.spiral = spiralOf(w, h);
    this.skill = SKILL[this.s.botSkill] ?? SKILL.normal;
    this.lifeEvery = Number(this.s.lifeEvery) || 0;

    this.slotOf = new Map(); // playerId -> slot
    this.active = [false, false, false, false];
    this.bot = [false, false, false, false];
    this.human = [false, false, false, false];
    this.wins = [0, 0, 0, 0]; //   battle
    this.lives = [0, 0, 0, 0]; //  co-op
    this.score = [0, 0, 0, 0]; //  co-op
    this.nextLife = [0, 0, 0, 0];
    this.out = [false, false, false, false]; // co-op: no lives left
    this.p = SLOTS.map((slot) => ({
      slot, alive: false, x: 0, y: 0, dir: 0, input: 0, face: 3, moving: false, bombs: 1, fire: 2, speed: 0, kick: false,
      want: false, gap: 0, limit: null, curse: 0, curseT: 0, inv: 0, respawn: 0,
    }));
    this.botState = [null, null, null, null];

    this.grid = new Uint8Array(this.n);
    this.hidden = new Uint8Array(this.n); // crate -> power-up inside (0 = none). Never sent to clients
    this.bombs = [];
    this.bombAt = new Map(); //  tile -> bomb
    this.flames = new Map(); //  tile -> { t, mask, reveal, owners, by }   mask: 1 horizontal, 2 vertical, 4 centre
    this.powerups = new Map(); // tile -> type
    this.monsters = [];
    this.pending = []; //        co-op: monsters about to come out of the exit { t, type }
    this.exit = null; //         co-op: { cell, shown, open }
    this.exitSpawned = 0;
    this.exitCool = 0;
    this.nextBombId = 1;
    this.nextMonsterId = 1;
    this.events = [];
    this.gridDirty = true;
    this.tick = 0;
    this.round = 0;
    this.level = 0;
    this.roundsPlayed = 0;
    this.maxRounds = this.s.roundsToWin * 2 + 3; // battle: draws can't go on forever
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
    for (const slot of SLOTS) {
      this.#resetPowers(this.p[slot]);
      this.lives[slot] = this.active[slot] ? this.s.lives : 0;
      this.nextLife[slot] = this.lifeEvery;
    }
    if (this.coop) this.#newLevel(); else this.#newRound();
  }

  // ── GameInstance ──
  onInput(playerId, data) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !data || typeof data !== 'object') return;
    const p = this.p[slot];
    if (Number.isInteger(data.d) && data.d >= 0 && data.d <= 4) p.input = data.d;
    if (data.b === 1 && p.gap <= 0) p.want = true;
  }

  onLeave(playerId) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined) return;
    this.slotOf.delete(playerId);
    this.humans--;
    this.human[slot] = false;
    this.active[slot] = false;
    this.out[slot] = true;
    this.lives[slot] = 0;
    const p = this.p[slot];
    if (p.alive) { p.alive = false; p.moving = false; }
    p.input = p.dir = 0;
    p.respawn = 0;
    if (this.humans < 1 && !this.finished) this.#finish(this.#result('abandoned', -1));
  }

  update(dt) {
    try {
      // Battle: only bots left alive this round (and some human is still watching): run the clock faster.
      this.ff = !this.coop && this.phase === 'play' && this.humans > 0 && !SLOTS.some((s) => this.human[s] && this.p[s].alive);
      const steps = this.ff ? FAST_FORWARD : 1;
      for (let i = 0; i < steps && !this.finished; i++) this.#step(dt, i === 0);
    } catch (err) { // never let a bug here take the whole server down
      console.error('Bombers update error', err);
    }
  }

  snapshot() {
    try {
      const timed = this.phase === 'play' || this.phase === 'grace';
      const snap = {
        tick: this.tick,
        m: this.coop ? 'coop' : 'battle',
        ph: this.phase,
        tm: r1(Math.max(0, timed ? this.clock : this.timer)),
        rd: this.round,
        ac: [...this.active],
        bt: [...this.bot],
        // per seat: x, y (×100), facing, moving, alive, bombs, fire, speed, kick, curse, shielded
        p: this.p.map((p) => (this.active[p.slot] || p.alive
          ? [Math.round(p.x * 100), Math.round(p.y * 100), p.face, p.moving ? 1 : 0, p.alive ? 1 : 0, p.bombs, p.fire, p.speed, p.kick ? 1 : 0, p.curse, p.inv > 0 ? 1 : 0]
          : null)),
        b: this.bombs.map((b) => [b.id, Math.round(b.x * 100), Math.round(b.y * 100), r2(Math.max(0, b.fuse) / b.fuse0), b.owner]),
        f: [...this.flames].map(([i, f]) => [i, f.mask, r2(f.t / FLAME_TIME)]),
        u: [...this.powerups],
        ev: this.events.slice(0, 80),
      };
      if (this.coop) {
        snap.lvl = this.level;
        snap.lv = [...this.lives];
        snap.sc = [...this.score];
        snap.rs = this.p.map((p) => (p.respawn > 0 ? r1(p.respawn) : 0));
        snap.mo = this.monsters.map((m) => [m.id, m.type, Math.round(m.x * 100), Math.round(m.y * 100), m.dir]);
        snap.ml = this.monsters.length + this.pending.length;
        snap.ex = this.exit && this.exit.shown ? [this.exit.cell, this.exit.open ? 1 : 0] : null;
      } else {
        snap.w = [...this.wins];
        snap.sd = this.clock <= 0 && this.s.suddenDeath && this.phase === 'play' ? this.#nextSd() : -1;
        snap.rw = this.roundWinner;
        snap.ff = this.ff ? 1 : 0;
      }
      if (this.final) snap.over = 1;
      this.events = []; // each event goes out exactly once
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

  // ── setup ──
  #resetPowers(p) {
    p.bombs = this.s.startBombs;
    p.fire = this.s.startFire;
    p.speed = 0;
    p.kick = false;
  }

  /** Pillars, border, random crates; the tiles next to every spawn stay free. Returns the crate tiles. */
  #buildArena() {
    const { w, h } = this;
    this.grid.fill(FLOOR);
    this.hidden.fill(0);
    this.bombs = [];
    this.bombAt.clear();
    this.flames.clear();
    this.powerups.clear();
    this.monsters = [];
    this.pending = [];
    const keepFree = new Set();
    for (const [sx, sy] of this.spawns) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) keepFree.add((sy + dy) * w + sx + dx);
    }
    const crates = [];
    const chance = this.s.crates / 100;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (isPillar(w, h, x, y)) { this.grid[i] = SOLID; continue; }
        if (keepFree.has(i) || Math.random() >= chance) continue;
        this.grid[i] = CRATE;
        crates.push(i);
      }
    }
    this.gridDirty = true;
    return crates;
  }

  #placePlayer(slot) {
    const p = this.p[slot];
    [p.x, p.y] = this.spawns[slot];
    Object.assign(p, { dir: 0, moving: false, face: 3, want: false, gap: 0, limit: null, curse: 0, curseT: 0 });
    if (this.bot[slot]) this.botState[slot] = { t: rnd(0.2, 0.6), goal: -1, mode: 'idle', noticed: 0 };
  }

  #newRound() { // battle
    this.round++;
    const crates = this.#buildArena();
    const puChance = this.s.powerups / 100;
    const table = [[PU_BOMB, 4], [PU_FIRE, 4], [PU_SPEED, 3]];
    if (this.s.kick) table.push([PU_KICK, 1.2]);
    if (this.s.curses) table.push([PU_SKULL, 1]);
    for (const i of crates) if (Math.random() < puChance) this.hidden[i] = weighted(table);
    for (const slot of SLOTS) {
      const p = this.p[slot];
      this.#resetPowers(p);
      this.#placePlayer(slot);
      p.alive = this.active[slot];
      p.inv = 0;
    }
    this.clock = this.s.roundTime;
    this.sdIndex = 0;
    this.sdAcc = 0;
    this.roundWinner = -1;
    this.phase = 'ready';
    this.timer = READY_TIME;
    this.events.push(['round', this.round]);
  }

  #newLevel() { // co-op
    this.level++;
    const { w } = this;
    let crates = this.#buildArena();
    const far = (i, d) => this.spawns.every(([sx, sy]) => Math.abs((i % w) - sx) + Math.abs(Math.floor(i / w) - sy) >= d);

    // the exit: under a crate, away from the spawns
    const exitPool = crates.filter((i) => far(i, 6));
    const exitCell = exitPool.length ? pick(exitPool) : crates.length ? pick(crates) : -1;
    if (exitCell >= 0) this.exit = { cell: exitCell, shown: false, open: false };
    else { // no crates at all: the exit just lies there
      const floor = [];
      for (let i = 0; i < this.n; i++) if (this.grid[i] === FLOOR && far(i, 6)) floor.push(i);
      this.exit = { cell: pick(floor), shown: true, open: false };
    }
    this.exitSpawned = 0;
    this.exitCool = 0;

    // only a few power-ups per level
    crates = crates.filter((i) => i !== this.exit.cell);
    const table = [[PU_BOMB, 3], [PU_FIRE, 3], [PU_SPEED, 2]];
    if (this.s.kick) table.push([PU_KICK, 1]);
    if (this.s.curses) table.push([PU_SKULL, 1]);
    const items = [];
    for (let k = 0; k < this.s.coopPowerups; k++) items.push(weighted(table));
    if (this.level % 3 === 0 || Math.random() < 0.15) items.push(PU_LIFE); // a heart now and then
    for (const type of items) {
      if (!crates.length) break;
      const at = Math.floor(Math.random() * crates.length);
      this.hidden[crates[at]] = type;
      crates.splice(at, 1);
    }

    // monsters, away from the players
    const plan = levelPlan(this.level);
    let spots = [];
    for (let i = 0; i < this.n; i++) if (this.grid[i] === FLOOR && far(i, 6) && i !== this.exit.cell) spots.push(i);
    if (spots.length < plan.length) { // packed level: clear some crates to make room
      const extra = crates.filter((i) => far(i, 6) && !this.hidden[i]);
      while (spots.length < plan.length && extra.length) {
        const i = extra.splice(Math.floor(Math.random() * extra.length), 1)[0];
        this.grid[i] = FLOOR;
        spots.push(i);
      }
    }
    for (const type of plan) {
      if (!spots.length) break;
      const i = spots.splice(Math.floor(Math.random() * spots.length), 1)[0];
      this.#spawnMonster(type, i);
    }

    for (const slot of SLOTS) {
      const p = this.p[slot];
      this.#placePlayer(slot);
      p.alive = this.active[slot] && !this.out[slot];
      p.respawn = 0;
      p.inv = 0;
    }
    this.phase = 'ready';
    this.timer = READY_TIME;
    this.events.push(['level', this.level]);
  }

  #spawnMonster(type, i) {
    const x = i % this.w;
    const y = (i - x) / this.w;
    this.monsters.push({ id: this.nextMonsterId++, type, x, y, tx: x, ty: y, dir: 0, think: 0 });
  }

  // ── phases ──
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
        if (this.coop || this.finished) break;
        if (this.phase === 'play') {
          if (SLOTS.filter((s) => this.p[s].alive).length <= 1) { this.phase = 'grace'; this.timer = GRACE_TIME; }
        } else if (this.phase === 'grace') {
          this.timer -= dt;
          if (this.timer <= 0) {
            const alive = SLOTS.filter((s) => this.p[s].alive);
            this.#endRound(alive.length === 1 ? alive[0] : -1);
          }
        }
        break;
      case 'result': // battle
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.final) this.#finish(this.final);
          else this.#newRound();
        }
        break;
      case 'clear': // co-op
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.level >= this.s.levels) this.#finish(this.#result('victory', -1));
          else this.#newLevel();
        }
        break;
    }
  }

  #result(reason, winner) {
    if (this.coop) return { mode: 'coop', reason, level: this.level, levels: this.s.levels, scores: [...this.score], total: this.score.reduce((a, b) => a + b, 0) };
    return { mode: 'battle', reason, winner, wins: [...this.wins], rounds: this.roundsPlayed };
  }

  #endRound(winner) { // battle
    this.roundsPlayed++;
    this.roundWinner = winner;
    if (winner >= 0) this.wins[winner]++;
    this.phase = 'result';
    this.timer = RESULT_TIME;
    this.events.push(['end', winner]);
    for (const p of this.p) p.moving = false;
    if (winner >= 0 && this.wins[winner] >= this.s.roundsToWin) {
      this.final = this.#result('wins', winner);
    } else if (this.roundsPlayed >= this.maxRounds) {
      const best = Math.max(...SLOTS.map((s) => (this.active[s] ? this.wins[s] : -1)));
      const top = SLOTS.filter((s) => this.active[s] && this.wins[s] === best);
      this.final = this.#result('limit', top.length === 1 ? top[0] : -1);
    } else if (SLOTS.filter((s) => this.active[s]).length < 2) { // everybody else left
      this.final = this.#result('forfeit', SLOTS.find((s) => this.active[s]) ?? -1);
    } else if (!SLOTS.some((s) => this.human[s])) {
      this.final = this.#result('abandoned', -1);
    }
  }

  #finish(result) {
    if (this.finished) return;
    this.finished = true;
    this.ctx.end(result); // the platform sends {t:'gameEnd', result} and returns the room to setup
  }

  // ── the simulation ──
  #play(dt) {
    if (!this.coop) {
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
    } else {
      this.clock += dt; // co-op: just counts up (level time)
      this.exitCool = Math.max(0, this.exitCool - dt);
      for (const sp of this.pending) sp.t -= dt;
      const due = this.pending.filter((sp) => sp.t <= 0 && !this.flames.has(this.exit.cell));
      if (due.length) {
        this.pending = this.pending.filter((sp) => !due.includes(sp));
        for (const sp of due) { this.#spawnMonster(sp.type, this.exit.cell); this.events.push(['spawnm', this.exit.cell, sp.type]); }
      }
      for (const slot of SLOTS) {
        const p = this.p[slot];
        if (p.alive || p.respawn <= 0) continue;
        p.respawn -= dt;
        if (p.respawn <= 0) this.#respawn(slot);
      }
    }

    // humans: what they hold, through the curse (bots are not fooled by reversed controls)
    for (const slot of SLOTS) {
      const p = this.p[slot];
      if (this.human[slot]) p.dir = p.curse === C_REVERSE ? REV[p.input] : p.input;
    }

    // bots decide, then everybody moves and drops bombs
    const danger = SLOTS.some((s) => this.bot[s] && this.p[s].alive) ? this.#danger(null) : null;
    for (const slot of SLOTS) {
      const p = this.p[slot];
      p.gap = Math.max(0, p.gap - dt);
      if (!p.alive) continue;
      p.inv = Math.max(0, p.inv - dt);
      if (p.curse) {
        p.curseT -= dt;
        if (p.curseT <= 0) { p.curse = 0; this.events.push(['cured', slot]); }
      }
      if (this.bot[slot]) this.#botThink(slot, dt, danger);
      const bx = p.x;
      const by = p.y;
      if (p.dir) {
        p.face = p.dir;
        this.#move(p, p.dir, (CURSE_SPEED[p.curse] ?? speedOf(p.speed)) * dt, p.limit);
      }
      p.moving = p.dir !== 0 && (p.x !== bx || p.y !== by);
      if (p.curse === C_DIARRHEA) p.want = true;
      if (p.want) { p.want = false; this.#dropBomb(p); }
      const i = this.#tileOf(p);
      const pu = this.powerups.get(i);
      if (pu) { this.powerups.delete(i); this.#powerUp(p, pu); }
    }

    // the skull's curse spreads by touch
    for (const a of this.p) {
      if (!a.alive || !a.curse) continue;
      for (const b of this.p) {
        if (b === a || !b.alive || b.curse || Math.abs(a.x - b.x) > 0.8 || Math.abs(a.y - b.y) > 0.8) continue;
        b.curse = a.curse;
        b.curseT = Math.max(4, a.curseT);
        this.events.push(['curse', b.slot, b.curse, a.slot]);
      }
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

    if (this.coop) this.#monsters(dt);

    // anyone standing in fire is out
    for (const slot of SLOTS) {
      const p = this.p[slot];
      if (!p.alive || p.inv > 0) continue;
      const f = this.flames.get(this.#tileOf(p));
      if (!f) continue;
      if (!this.coop || this.s.friendlyFire || f.owners & (1 << slot) || f.owners === 0) this.#kill(slot);
    }

    if (this.coop) this.#coopChecks();
  }

  #coopChecks() {
    const ex = this.exit;
    const open = ex.shown && this.monsters.length === 0 && this.pending.length === 0;
    if (open && !ex.open) this.events.push(['open', ex.cell]);
    ex.open = open;
    if (open && SLOTS.some((s) => this.p[s].alive && this.#tileOf(this.p[s]) === ex.cell)) {
      const bonus = 500 + this.level * 100;
      for (const slot of SLOTS) if (this.p[slot].alive) this.#addScore(slot, bonus);
      this.events.push(['clear', this.level, bonus]);
      this.phase = 'clear';
      this.timer = CLEAR_TIME;
      this.bombs = [];
      this.bombAt.clear();
      for (const p of this.p) { p.moving = false; p.curse = 0; }
      return;
    }
    // game over: nobody can play any more (or only bots could)
    const canPlay = (s) => this.active[s] && !this.out[s];
    if (!SLOTS.some(canPlay) || !SLOTS.some((s) => this.human[s] && canPlay(s))) this.#finish(this.#result('gameover', -1));
  }

  #addScore(slot, pts) {
    if (slot < 0 || !this.active[slot]) return;
    this.score[slot] += pts;
    while (this.lifeEvery > 0 && this.score[slot] >= this.nextLife[slot]) {
      this.nextLife[slot] += this.lifeEvery;
      if (this.lives[slot] < MAX_LIVES && !this.out[slot]) { this.lives[slot]++; this.events.push(['life', slot, 'points']); }
    }
  }

  #respawn(slot) {
    const p = this.p[slot];
    const [sx, sy] = this.spawns[slot];
    const i = sy * this.w + sx;
    if (this.flames.has(i) || this.grid[i] !== FLOOR) { p.respawn = 0.2; return; }
    this.#placePlayer(slot);
    p.alive = true;
    p.respawn = 0;
    p.inv = SHIELD_TIME;
    this.events.push(['spawn', slot]);
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
    if (this.monsters.some((m) => Math.abs(m.x - x) < 0.9 && Math.abs(m.y - y) < 0.9)) return false;
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

  #canBomb(p) {
    return p.curse !== C_NOBOMB && this.bombs.filter((b) => b.owner === p.slot).length < p.bombs;
  }

  #dropBomb(p) {
    const i = this.#tileOf(p);
    if (this.grid[i] !== FLOOR || this.bombAt.has(i) || !this.#canBomb(p)) return;
    if (this.coop && this.monsters.some((m) => Math.round(m.x) + Math.round(m.y) * this.w === i)) return;
    p.gap = BOMB_GAP;
    const x = i % this.w;
    const y = (i - x) / this.w;
    const pass = new Set();
    for (const q of this.p) if (q.alive && Math.abs(q.x - x) < 0.99 && Math.abs(q.y - y) < 0.99) pass.add(q.slot);
    const fuse = p.curse === C_FUSE ? SHORT_FUSE : this.s.fuse;
    const b = { id: this.nextBombId++, owner: p.slot, x, y, cell: i, fuse, fuse0: fuse, fire: p.curse === C_WEAK ? 1 : p.fire, pass, sx: 0, sy: 0 };
    this.bombs.push(b);
    this.bombAt.set(i, b);
    this.events.push(['drop', p.slot, i]);
  }

  #powerUp(p, type) {
    if (type === PU_BOMB) p.bombs = Math.min(MAX_BOMBS, p.bombs + 1);
    else if (type === PU_FIRE) p.fire = Math.min(MAX_FIRE, p.fire + 1);
    else if (type === PU_SPEED) p.speed = Math.min(MAX_SPEED, p.speed + 1);
    else if (type === PU_KICK) p.kick = true;
    else if (type === PU_LIFE) { if (this.lives[p.slot] < MAX_LIVES) this.lives[p.slot]++; this.events.push(['life', p.slot, 'heart']); }
    else if (type === PU_SKULL) {
      p.curse = 1 + Math.floor(Math.random() * (CURSES.length - 1));
      p.curseT = CURSE_TIME;
      this.events.push(['curse', p.slot, p.curse, -1]);
      return;
    }
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
    this.#flame(b.cell, 4, 0, b.owner);
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
          this.#flame(i, mask, this.hidden[i], b.owner);
          this.hidden[i] = 0;
          crates++;
          if (this.exit && i === this.exit.cell && !this.exit.shown) { this.exit.shown = true; this.events.push(['exit', i]); }
          break;
        }
        if (this.powerups.has(i)) { // a blast burns the power-up away
          this.powerups.delete(i);
          this.#flame(i, mask, 0, b.owner);
          this.events.push(['burn', i]);
          break;
        }
        this.#flame(i, mask, 0, b.owner);
        if (this.coop && this.exit?.shown && i === this.exit.cell) this.#exitHit();
        const o = this.bombAt.get(i);
        if (o) o.fuse = Math.min(o.fuse, 0); // chain reaction
      }
    }
    if (this.coop && b.owner >= 0) this.#addScore(b.owner, crates * CRATE_POINTS);
    this.events.push(['boom', b.cell, b.owner, b.fire, crates]);
  }

  /** Co-op: bombing an exposed exit lets more monsters out (a few at most per level). */
  #exitHit() {
    if (this.exitCool > 0 || this.exitSpawned >= EXIT_SPAWN_MAX) return;
    this.exitCool = 4;
    const kinds = levelPlan(this.level + 1);
    for (let k = 0; k < 2 && this.exitSpawned < EXIT_SPAWN_MAX; k++, this.exitSpawned++) {
      this.pending.push({ t: 0.9 + k * 0.4, type: kinds[kinds.length - 1 - k] ?? M_CHASER });
    }
    this.events.push(['exitHit', this.exit.cell]);
  }

  #flame(i, mask, reveal, owner) {
    const bit = owner >= 0 ? 1 << owner : 0;
    const f = this.flames.get(i);
    if (f) {
      f.t = FLAME_TIME;
      f.mask |= mask;
      f.owners |= bit;
      f.by = owner;
      if (reveal) f.reveal = reveal;
    } else this.flames.set(i, { t: FLAME_TIME, mask, reveal, owners: bit, by: owner });
  }

  #kill(slot) {
    const p = this.p[slot];
    if (!p.alive) return;
    p.alive = false;
    p.moving = false;
    p.curse = 0;
    if (!this.human[slot]) p.dir = 0;
    if (this.coop) {
      this.lives[slot] = Math.max(0, this.lives[slot] - 1);
      if (this.lives[slot] > 0) p.respawn = RESPAWN_TIME; else this.out[slot] = true;
      if (this.s.deathPenalty === 'all') this.#resetPowers(p);
      else if (this.s.deathPenalty === 'one') {
        p.bombs = Math.max(this.s.startBombs, p.bombs - 1);
        p.fire = Math.max(this.s.startFire, p.fire - 1);
        p.speed = Math.max(0, p.speed - 1);
        p.kick = false;
      }
    }
    this.events.push(['die', slot, this.#tileOf(p), this.coop ? this.lives[slot] : 0]);
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
    for (const slot of SLOTS) if (this.p[slot].alive && this.#tileOf(this.p[slot]) === i) this.#kill(slot);
  }

  // ── monsters (co-op) ──
  #monsters(dt) {
    const sneaky = this.monsters.some((m) => m.type === M_SNEAK);
    const danger = sneaky ? this.#danger(null, true) : null;
    for (const m of this.monsters) this.#monsterStep(m, dt, danger);

    // fire kills monsters
    const dead = [];
    for (const m of this.monsters) {
      const f = this.flames.get(Math.round(m.y) * this.w + Math.round(m.x));
      if (!f) continue;
      dead.push(m);
      const pts = MONSTERS[m.type].points;
      this.#addScore(f.by, pts);
      this.events.push(['mdie', m.id, m.type, Math.round(m.x * 100), Math.round(m.y * 100), f.by, pts]);
    }
    if (dead.length) this.monsters = this.monsters.filter((m) => !dead.includes(m));

    // monsters kill on touch
    for (const m of this.monsters) {
      for (const p of this.p) {
        if (p.alive && p.inv <= 0 && Math.abs(p.x - m.x) < 0.72 && Math.abs(p.y - m.y) < 0.72) this.#kill(p.slot);
      }
    }
  }

  #mtile(m) { return Math.round(m.y) * this.w + Math.round(m.x); }

  /** Can monster m step onto tile i? */
  #monPass(m, i, danger) {
    if (i < 0 || i >= this.n) return false;
    const g = this.grid[i];
    if (g === SOLID || (g === CRATE && m.type !== M_GHOST)) return false;
    if (this.bombAt.has(i) && this.#mtile(m) !== i) return false;
    if (m.type !== M_BLOB && this.flames.has(i)) return false; // blobs are too dumb to fear fire
    if (danger && m.type === M_SNEAK && danger.start[i] < 1.4 && danger.start[this.#mtile(m)] === Infinity) return false;
    return true;
  }

  #monsterStep(m, dt, danger) {
    let move = MONSTERS[m.type].speed * dt;
    const ti = m.ty * this.w + m.tx;
    const between = m.x !== m.tx || m.y !== m.ty;
    if (between && this.bombAt.has(ti) && Math.abs(m.x - m.tx) + Math.abs(m.y - m.ty) > 0.5) { // a bomb landed in front: turn back
      m.tx -= DX[m.dir];
      m.ty -= DY[m.dir];
      m.dir = OPP[m.dir];
    }
    for (let guard = 0; guard < 3 && move > 1e-6; guard++) {
      const dx = m.tx - m.x;
      const dy = m.ty - m.y;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > move) {
        m.x += Math.sign(dx) * Math.min(Math.abs(dx), move);
        m.y += Math.sign(dy) * Math.min(Math.abs(dy), move);
        return;
      }
      m.x = m.tx;
      m.y = m.ty;
      move -= d;
      const dir = this.#monsterDecide(m, danger);
      if (!dir) { m.dir = 0; return; }
      m.dir = dir;
      m.tx += DX[dir];
      m.ty += DY[dir];
    }
  }

  #monsterDecide(m, danger) {
    const here = this.#mtile(m);
    const opts = [1, 2, 3, 4].filter((d) => this.#monPass(m, here + DY[d] * this.w + DX[d], danger));
    if (!opts.length) return 0;
    const back = OPP[m.dir];
    const fwd = m.dir && opts.includes(m.dir);
    const ahead = opts.filter((d) => d !== back);
    const wander = () => (fwd && Math.random() < 0.8 ? m.dir : pick(ahead.length ? ahead : opts));
    switch (m.type) {
      case M_BLOB:
        return wander();
      case M_DASHER:
        return fwd ? m.dir : pick(ahead.length ? ahead : opts);
      case M_CHASER:
        return this.#chaseStep(m, 7, danger) || wander();
      case M_GHOST: {
        const t = this.#nearestPlayer(m);
        if (t && Math.random() < 0.75) {
          const dist = (d) => Math.abs(m.x + DX[d] - t.x) + Math.abs(m.y + DY[d] - t.y);
          return opts.reduce((a, b) => (dist(b) < dist(a) ? b : a));
        }
        return wander();
      }
      case M_SNEAK: {
        if (danger && danger.start[here] !== Infinity) { // in a blast zone: get out
          const ok = opts.filter((d) => danger.start[here + DY[d] * this.w + DX[d]] === Infinity);
          if (ok.length) return pick(ok);
        }
        return this.#chaseStep(m, 12, danger) || wander();
      }
    }
    return wander();
  }

  #nearestPlayer(m) {
    let best = null;
    let bd = Infinity;
    for (const p of this.p) {
      if (!p.alive) continue;
      const d = Math.abs(p.x - m.x) + Math.abs(p.y - m.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** First step of the shortest monster path to any living player within `max` steps, or 0. */
  #chaseStep(m, max, danger) {
    const targets = new Set(this.p.filter((p) => p.alive).map((p) => this.#tileOf(p)));
    if (!targets.size) return 0;
    const start = this.#mtile(m);
    const first = new Map([[start, 0]]);
    let frontier = [start];
    for (let depth = 0; depth < max && frontier.length; depth++) {
      const next = [];
      for (const i of frontier) {
        for (let d = 1; d <= 4; d++) {
          const j = i + DY[d] * this.w + DX[d];
          if (first.has(j) || !this.#monPass(m, j, danger)) continue;
          const f = i === start ? d : first.get(i);
          if (targets.has(j)) return f;
          first.set(j, f);
          next.push(j);
        }
      }
      frontier = next;
    }
    return 0;
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
   * reactions. `extra` = a bomb the bot is thinking of dropping: { cell, fire, fuse }. `bombsOnly` skips the
   * monsters and sudden-death walls (used by the monsters themselves).
   */
  #danger(extra, bombsOnly = false) {
    const start = new Float32Array(this.n).fill(Infinity);
    const end = new Float32Array(this.n).fill(-Infinity);
    for (const [i, f] of this.flames) { start[i] = 0; end[i] = f.t; }
    if (!bombsOnly && !this.coop && this.clock <= 0 && this.s.suddenDeath) { // walls about to fall: fire that never goes out
      let t = SD_INTERVAL - this.sdAcc;
      for (let j = this.sdIndex; j < this.spiral.length && t < 2.6; j++) {
        const i = this.spiral[j];
        if (this.grid[i] === SOLID) continue;
        start[i] = Math.min(start[i], t);
        end[i] = Infinity;
        t += SD_INTERVAL;
      }
    }
    if (!bombsOnly && this.coop) { // a monster's tile and the one it walks into
      for (const m of this.monsters) {
        for (const i of [this.#mtile(m), m.ty * this.w + m.tx]) { start[i] = Math.min(start[i], 0.25); end[i] = Infinity; }
      }
    }
    const list = this.bombs.map((b) => ({ cell: b.cell, fire: b.fire, t: Math.max(0, b.fuse) }));
    if (extra) list.push({ cell: extra.cell, fire: extra.fire, t: extra.fuse });
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
   * zone at all (and stay off skulls); otherwise a tile may be crossed if the fire is not there while the bot passes.
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
        if (safe && this.powerups.get(j) === PU_SKULL) continue;
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

  /** Nearest tile with no danger that the bot can reach in time; if there is none, the tile where fire comes last. */
  #refuge(from, danger, speed, margin) {
    const r = this.#bfs(from, danger, speed, false, margin);
    for (const i of r.order) if (danger.start[i] === Infinity) return { goal: i, bfs: r, safe: true };
    let best = from;
    for (const i of r.order) if (danger.start[i] > danger.start[best] + 0.05) best = i;
    return { goal: best, bfs: r, safe: false };
  }

  /** What the bot wants to hit: other players in battle, monsters in co-op. */
  #targetTiles(slot) {
    const out = new Set();
    if (this.coop) for (const m of this.monsters) { out.add(this.#mtile(m)); out.add(m.ty * this.w + m.tx); }
    else for (const q of this.p) if (q.alive && q.slot !== slot) out.add(this.#tileOf(q));
    return out;
  }

  /** How good is dropping a bomb on tile i: crates it would break, targets it could catch. */
  #bombValue(i, fire, targets, hunt) {
    let v = 0;
    for (const c of this.#blastCells(i, fire)) {
      if (this.grid[c] === CRATE) v += 1;
      if (targets.has(c)) v += 1.5 + hunt * 3;
      if (this.powerups.has(c) && this.powerups.get(c) !== PU_SKULL) v -= 1.5; // don't burn power-ups
      if (this.coop && this.exit?.shown && c === this.exit.cell) v -= 3; // don't wake the exit
    }
    return v;
  }

  #botThink(slot, dt, danger) {
    const p = this.p[slot];
    const st = this.botState[slot];
    const k = this.skill;
    const speed = CURSE_SPEED[p.curse] ?? speedOf(p.speed);
    const here = this.#tileOf(p);
    p.limit = null;

    // 1. Am I standing where fire (or a monster) is coming? Then run, after a short "reaction" delay.
    if (danger.start[here] !== Infinity && p.inv <= 0.3) {
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
    if (!this.#canBomb(p) || this.bombAt.has(here)) return false;
    if (Math.random() >= this.skill.slip) {
      const fuse = p.curse === C_FUSE ? SHORT_FUSE : this.s.fuse;
      const d2 = this.#danger({ cell: here, fire: p.curse === C_WEAK ? 1 : p.fire, fuse });
      const r = this.#refuge(here, d2, speed, this.skill.margin + 0.1);
      if (!r.safe || r.bfs.dist[r.goal] / speed > fuse - 0.35) return false; // no way out: don't
    }
    p.want = true;
    return true;
  }

  #botDecide(slot, here, danger, speed) {
    const p = this.p[slot];
    const st = this.botState[slot];
    const k = this.skill;
    const targets = this.#targetTiles(slot);
    const hunt = this.coop ? Math.max(0.5, k.hunt) : this.clock <= 0 ? 1 : k.hunt; // sudden death: go for the kill
    const canBomb = this.#canBomb(p);
    const fire = p.curse === C_WEAK ? 1 : p.fire;

    const r = this.#bfs(here, danger, speed, true, 0);
    // co-op: the exit is open, everybody out!
    if (this.coop && this.exit?.open && r.dist[this.exit.cell] >= 0) { st.mode = 'go'; st.goal = this.exit.cell; return; }

    // drop a bomb right here if it is worth it
    if (canBomb && this.#bombValue(here, fire, targets, hunt) >= 1 && this.#centred(p) && this.#botTryBomb(slot, here, speed)) {
      st.mode = 'idle';
      return;
    }

    // a power-up nearby? (never the skull)
    for (const i of r.order) {
      if (r.dist[i] > k.grab) break;
      const pu = this.powerups.get(i);
      if (pu && pu !== PU_SKULL) { st.mode = 'go'; st.goal = i; return; }
    }
    // the best spot to bomb
    if (canBomb) {
      let best = -1;
      let bestScore = 0;
      for (const i of r.order) {
        const v = this.#bombValue(i, fire, targets, hunt);
        if (v < 1) continue;
        const score = v - r.dist[i] * 0.35 + Math.random() * 0.3;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) { st.mode = 'bomb'; st.goal = best; return; }
    }
    // battle, nothing to blow up nearby: go toward the closest player
    if (!this.coop && targets.size) {
      for (const i of r.order) {
        if (r.dist[i] > 0 && [1, 2, 3, 4].some((d) => targets.has(i + DY[d] * this.w + DX[d]))) { st.mode = 'go'; st.goal = i; return; }
      }
    }
    // wander
    const opts = r.order.filter((i) => r.dist[i] > 0 && r.dist[i] <= 4);
    st.mode = 'go';
    st.goal = opts.length ? pick(opts) : here;
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
  canStart({ players, bots, settings }) {
    if (settings.mode !== 'coop' && players.length + bots.length < 2) return 'Battle needs at least 2 players or bots. Add a bot, or switch Mode to Co-op.';
    return null;
  },
};

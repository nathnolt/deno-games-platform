import { BLOCK, BLOCK_COLORS, GOAL_Y, HALF, inZone, meta, PLAT_HALF, PLAT_TOP, SLOT_X, SLOT_Y, ST, TABLE_HALF_W } from './shared.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

const GRAVITY = 45; //         units / s²
const FOLLOW = 25; //          how quickly a held block chases the pointer
const RETURN = 12; //          how quickly a refused block glides back to its slot
const RESET_DELAY = 3; //      seconds the finished tower stays before it is cleared
const MAX_X = TABLE_HALF_W - HALF;
const MAX_Y = 17;

class BalanceGame {
  constructor(ctx) {
    this.players = new Map(); // playerId -> { slot, held: block|null, tx, ty }
    this.blocks = new Map(); //  blockId  -> { id, home, color, st, x, y, vy, owner }
    this.nextId = 1;
    this.towers = 0;
    this.resetTimer = 0;
    for (let home = 0; home < SLOT_X.length; home++) this.#spawn(home);
    for (const p of ctx.players) this.onJoin(p); // whoever is seated when the match starts
  }

  // ── GameInstance ──
  onJoin({ id, slot }) {
    this.players.set(id, { slot, held: null, tx: 0, ty: 0 });
  }

  onLeave(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.held) this.#release(p, false); // whatever they were holding glides back to the front
    this.players.delete(playerId);
  }

  onInput(playerId, data) {
    const p = this.players.get(playerId); // spectators are not in the map: ignored
    if (!p || typeof data !== 'object' || data === null) return;

    if (Number.isInteger(data.pick)) {
      const b = this.blocks.get(data.pick);
      if (p.held || !b || b.st !== ST.IDLE) return; // already held by somebody (or by you): nothing happens
      b.st = ST.HELD;
      b.owner = playerId;
      p.held = b;
      p.tx = b.x;
      p.ty = b.y;
    } else if (data.drop === true) {
      if (p.held) this.#release(p, inZone(p.held.x, p.held.y));
    } else if (Number.isFinite(data.x) && Number.isFinite(data.y) && p.held) {
      p.tx = clamp(data.x, -MAX_X, MAX_X);
      p.ty = clamp(data.y, HALF, MAX_Y);
    }
  }

  update(dt) {
    const follow = 1 - Math.exp(-FOLLOW * dt);
    const back = 1 - Math.exp(-RETURN * dt);

    for (const p of this.players.values()) {
      if (!p.held) continue;
      p.held.x += (p.tx - p.held.x) * follow;
      p.held.y += (p.ty - p.held.y) * follow;
    }

    for (const b of this.blocks.values()) {
      if (b.st === ST.BACK) {
        const hx = SLOT_X[b.home];
        b.x += (hx - b.x) * back;
        b.y += (SLOT_Y - b.y) * back;
        if (Math.abs(b.x - hx) < 0.03 && Math.abs(b.y - SLOT_Y) < 0.03) {
          b.x = hx;
          b.y = SLOT_Y;
          b.st = ST.IDLE;
        }
      } else if (b.st === ST.FALL) {
        b.vy += GRAVITY * dt;
        b.y -= b.vy * dt;
        const rest = this.#surface(b) + HALF; // recomputed every tick: the tower may have grown under it
        if (b.y <= rest) {
          b.y = rest;
          b.vy = 0;
          b.st = ST.STACK;
          if (b.y + HALF >= GOAL_Y && this.resetTimer <= 0) {
            this.towers++;
            this.resetTimer = RESET_DELAY;
          }
        }
      }
    }

    if (this.resetTimer > 0 && (this.resetTimer -= dt) <= 0) {
      this.resetTimer = 0;
      for (const [id, b] of this.blocks) if (b.st === ST.STACK || b.st === ST.FALL) this.blocks.delete(id);
    }
  }

  snapshot() {
    const blocks = [];
    let top = 0;
    for (const b of this.blocks.values()) {
      const slot = b.owner ? (this.players.get(b.owner)?.slot ?? -1) : -1;
      blocks.push([b.id, b.st, round2(b.x), round2(b.y), slot, b.color]);
      if (b.st === ST.STACK) top = Math.max(top, b.y + HALF);
    }
    // Everything a late joiner needs to draw the current state; no names (those come from the room state).
    return { b: blocks, top: round2(top), n: this.towers, r: this.resetTimer > 0 ? 1 : 0 };
  }

  // ── rules ──
  /** Let go of the held block: into the zone it drops onto the tower (and a fresh block appears), otherwise it returns. */
  #release(p, drop) {
    const b = p.held;
    p.held = null;
    b.owner = null;
    if (drop) {
      b.st = ST.FALL;
      b.vy = 0;
      this.#spawn(b.home); // the new block takes the old one's place straight away
    } else {
      b.st = ST.BACK;
    }
  }

  /** Height of whatever the block would land on. Simple heightmap, no physics engine. */
  #surface(b) {
    let top = Math.abs(b.x) < PLAT_HALF + HALF ? PLAT_TOP : 0; // base plate, otherwise the table
    for (const c of this.blocks.values()) {
      if (c !== b && c.st === ST.STACK && Math.abs(c.x - b.x) < BLOCK - 0.01) top = Math.max(top, c.y + HALF);
    }
    return top;
  }

  #spawn(home) {
    const id = this.nextId++;
    this.blocks.set(id, {
      id, home, color: Math.floor(Math.random() * BLOCK_COLORS.length),
      st: ST.IDLE, x: SLOT_X[home], y: SLOT_Y, vy: 0, owner: null,
    });
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const balance = { meta, create: (ctx) => new BalanceGame(ctx) };

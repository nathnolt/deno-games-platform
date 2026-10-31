// SERVER: the authoritative physics simulation (planck.js = Box2D for JavaScript).
// Clients never simulate anything: they receive body positions every tick and draw them, so all players and
// spectators see exactly the same physics. The gameplay is 2D (x, y); the 3D look is purely client-side.
//
// planck is loaded straight from npm by Deno (no deno.json change needed). It needs no extra permissions.
import * as planck from 'npm:planck@1';
import {
  BODY, BOWL, bowlProfile, densityOf, frictionOf, getShape, GRAVITY, inDrop, levels, LOSE, materials, MATERIAL_KEYS,
  MAX_HOLD_X, MAX_HOLD_Y, meta, PHASE, SHAPE_KEYS, WATER_DENSITY, WATER_Y, zoneOf,
} from './shared.js';

const { Vec2 } = planck;

const STEP = 1 / 120; //          fixed physics step (the platform ticks at 30 Hz, so ~4 physics steps per snapshot)
const MAX_STEPS = 12; //          never do more than this per tick (protects the server if it falls behind)
const SETTLE_TIME = 2; //         seconds everything must be (almost) still after the last block to win
const SETTLE_SPEED = 0.25; //     "still" = linear and angular speed below this
const FREEZE_AFTER = 5; //        stop simulating this long after the level has ended
const FOLLOW = 30; //             how quickly a held block chases its player's pointer
const FLOAT_SIDES = 24; //        circles are approximated by a polygon when computing buoyancy
const BOWL_SEGMENTS = 36;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Clip a polygon (array of {x,y}) to the half-plane y <= y0 and return the area and centroid of what is left.
 * Used for buoyancy: the clipped part is the part of a block under water.
 */
export function clipBelow(pts, y0) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ain = a.y <= y0;
    const bin = b.y <= y0;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (y0 - a.y) / (b.y - a.y);
      out.push({ x: a.x + (b.x - a.x) * t, y: y0 });
    }
  }
  if (out.length < 3) return { area: 0, cx: 0, cy: 0 };
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const q = out[(i + 1) % out.length];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a2) < 1e-9) return { area: 0, cx: 0, cy: 0 };
  return { area: Math.abs(a2) / 2, cx: cx / (3 * a2), cy: cy / (3 * a2) };
}

class BalanceGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.players = new Map(); //  playerId -> { slot, held: null | { item, rec, tx, ty, trot } }
    this.phase = PHASE.MENU;
    this.levelIdx = -1;
    this.run = 0; //              bumps on every level start / return to menu, so clients know to rebuild their view
    this.world = null;
    this.recs = new Map(); //     blockId -> block record (everything drawn in the play area: statics, floats, placed, held)
    this.recOf = new Map(); //    planck Body -> record (blocks and the bowl)
    this.table = []; //           blocks lying on the table: a fixed row of slots, each an item or null
    this.queue = []; //           blocks that have not appeared on the table yet, in order
    this.floaters = [];
    this.total = 0;
    this.settle = 0;
    this.endedFor = 0;
    this.why = 0;
    this.acc = 0;
    for (const p of ctx.players) this.onJoin(p);
  }

  // ── GameInstance ──
  onJoin({ id, slot }) {
    if (!this.players.has(id)) this.players.set(id, { slot, held: null });
  }

  onLeave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.#putBack(p);
    this.players.delete(id);
    if (this.players.size === 0) this.ctx.end({ reason: 'everyone left' });
  }

  onInput(id, data) {
    const p = this.players.get(id); // spectators are not in the map: ignored
    if (!p || typeof data !== 'object' || data === null) return;
    try {
      this.#input(id, p, data);
    } catch (e) {
      console.error('balance: input failed', e);
    }
  }

  update(dt) {
    try {
      this.#update(dt);
    } catch (e) {
      console.error('balance: update failed, going back to the menu', e);
      this.#toMenu();
    }
  }

  snapshot() {
    const b = [];
    for (const r of this.recs.values()) {
      const pos = r.body.getPosition();
      let st = r.static ? BODY.STATIC : BODY.NORMAL;
      if (r.held) st = r.bad ? BODY.HELD_BAD : BODY.HELD;
      b.push([r.id, r.si, r.mi, round2(pos.x), round2(pos.y), round3(r.body.getAngle()), st, r.held ? r.owner : -1]);
    }
    const tbl = [];
    this.table.forEach((item, i) => {
      if (item) tbl.push([item.id, SHAPE_KEYS.indexOf(item.shape), MATERIAL_KEYS.indexOf(item.material), i, item.heldBy ? (this.players.get(item.heldBy)?.slot ?? -1) : -1]);
    });
    return {
      run: this.run,
      ph: this.phase,
      lv: this.levelIdx,
      host: this.#hostSlot(),
      b,
      tbl,
      n: this.table.length,
      left: this.#remaining(),
      total: this.total,
      why: this.why,
      still: round2(clamp(this.settle / SETTLE_TIME, 0, 1)),
    };
  }

  // ── input ──
  /** The "host" of the game is the lowest seat: only they may choose levels and restart (so nobody can ruin a game by accident). */
  #hostSlot() {
    let lo = -1;
    for (const p of this.players.values()) if (lo < 0 || p.slot < lo) lo = p.slot;
    return lo;
  }

  #input(id, p, d) {
    const isHost = p.slot === this.#hostSlot();
    if (Number.isInteger(d.start)) {
      if (isHost && d.start >= 0 && d.start < levels.length) this.#startLevel(d.start);
    } else if (d.restart === true) {
      if (isHost && this.levelIdx >= 0) this.#startLevel(this.levelIdx);
    } else if (d.menu === true) {
      if (isHost) this.#toMenu();
    } else if (this.phase !== PHASE.PLAY) {
      return;
    } else if (Number.isInteger(d.pick)) {
      this.#pick(id, p, d);
    } else if (d.drop === true) {
      this.#drop(p);
    } else if (d.cancel === true) {
      this.#putBack(p);
    } else if (p.held) {
      const zone = zoneOf(levels[this.levelIdx]);
      if (Number.isFinite(d.x)) p.held.tx = clamp(d.x, Math.max(zone.x0, -MAX_HOLD_X), Math.min(zone.x1, MAX_HOLD_X));
      if (Number.isFinite(d.y)) p.held.ty = clamp(d.y, WATER_Y - 12, MAX_HOLD_Y);
      if (Number.isFinite(d.rot)) p.held.trot = rad(clamp(d.rot, -1e5, 1e5));
    }
  }

  /** Take a block from the table. Its slot stays empty (no refill) until the block is dropped into the play area. */
  #pick(id, p, d) {
    if (p.held) return;
    const item = this.table.find((i) => i && i.id === d.pick && !i.heldBy);
    if (!item) return; // somebody else was faster, or it is not on the table
    const x = clamp(Number.isFinite(d.x) ? d.x : 0, -MAX_HOLD_X, MAX_HOLD_X);
    const y = clamp(Number.isFinite(d.y) ? d.y : 0, WATER_Y - 12, MAX_HOLD_Y);
    const rot = Number.isFinite(d.rot) ? rad(d.rot) : 0;
    item.heldBy = id;
    const rec = this.#makeBlock(item, x, y, rot, true, p.slot);
    p.held = { item, rec, tx: x, ty: y, trot: rot };
  }

  /** Put the block a player is holding back on the table, in its own slot. */
  #putBack(p) {
    const h = p.held;
    if (!h) return;
    this.#removeBlock(h.rec);
    h.item.heldBy = null;
    p.held = null;
  }

  /** Let go. Inside the drop zone (and not overlapping anything) it falls into the play area; outside, it returns to the table. */
  #drop(p) {
    const h = p.held;
    if (!h) return;
    const level = levels[this.levelIdx];
    const pos = h.rec.body.getPosition();
    if (!inDrop(level, pos.x, pos.y)) return this.#putBack(p);
    if (h.rec.bad) return; // overlapping something: refused, the player keeps holding it (the client shows it in red)

    const angle = h.rec.body.getAngle();
    const item = h.item;
    this.#removeBlock(h.rec);
    p.held = null;
    this.#makeBlock(item, pos.x, pos.y, angle, false); // same id, now a normal falling body
    this.table[item.slot] = this.queue.shift() ?? null; // only now does a new block appear in the empty slot
    if (this.table[item.slot]) this.table[item.slot].slot = item.slot;
    this.settle = 0;
  }

  // ── levels ──
  #startLevel(i) {
    this.#teardown();
    const level = levels[i];
    this.run++;
    this.levelIdx = i;
    this.phase = PHASE.PLAY;
    this.why = 0;
    this.settle = 0;
    this.endedFor = 0;
    this.acc = 0;
    this.world = new planck.World({ gravity: new Vec2(0, -GRAVITY) });

    // the wooden bowl: a ring of convex quads following the lower half of an ellipse
    const bowl = this.world.createBody({ type: 'static', position: new Vec2(0, 0) });
    const { inner, outer } = bowlProfile(BOWL_SEGMENTS);
    for (let k = 0; k < BOWL_SEGMENTS; k++) {
      const quad = [inner[k], inner[k + 1], outer[k + 1], outer[k]].map(([x, y]) => new Vec2(x, y));
      bowl.createFixture({ shape: new planck.Polygon(quad), friction: 0.6 });
    }
    this.recOf.set(bowl, { kind: 'bowl' });

    let nextId = 1;
    for (const ib of level.initialBlocks) {
      this.#makeBlock({ id: nextId++, shape: ib.shape, material: ib.material }, ib.x, ib.y, rad(ib.rot ?? 0), false);
    }
    const items = level.shapes.map((s) => ({ id: nextId++, shape: s.shape, material: s.material, heldBy: null, slot: -1 }));
    this.total = items.length;
    const n = Math.max(1, Math.min(level.chooseShapes, items.length));
    this.table = Array.from({ length: n }, (_, k) => {
      const item = items[k] ?? null;
      if (item) item.slot = k;
      return item;
    });
    this.queue = items.slice(n);
    for (const p of this.players.values()) p.held = null;
  }

  #toMenu() {
    this.#teardown();
    this.run++;
    this.phase = PHASE.MENU;
    this.levelIdx = -1;
    this.why = 0;
    this.total = 0;
  }

  #teardown() {
    this.world = null;
    this.recs.clear();
    this.recOf.clear();
    this.floaters = [];
    this.table = [];
    this.queue = [];
    for (const p of this.players.values()) p.held = null;
  }

  /** Blocks still to be placed: on the table, held, or waiting to appear. */
  #remaining() {
    let n = this.queue.length;
    for (const item of this.table) if (item) n++;
    return n;
  }

  // ── bodies ──
  /** Create the physics body for a block. A held block is a gravity-free sensor: it detects overlaps but pushes nothing. */
  #makeBlock(item, x, y, angle, held, owner = -1) {
    const mat = materials[item.material];
    const shape = getShape(item.shape);
    const isStatic = !!mat.static && !held;
    const body = this.world.createBody({
      type: isStatic ? 'static' : 'dynamic',
      position: new Vec2(x, y),
      angle,
      allowSleep: !held, // a sleeping sensor would stop reporting overlaps
      gravityScale: held ? 0 : 1,
      angularDamping: 0.05,
      linearDamping: 0.02,
    });
    const def = { density: densityOf(item.material), friction: frictionOf(item.material), restitution: isStatic ? 0 : 0.04, isSensor: held };
    const floatPolys = [];
    for (const part of shape.parts) {
      if (part.type === 'circle') {
        body.createFixture({ ...def, shape: new planck.Circle(new Vec2(part.cx, part.cy), part.r) });
        const poly = [];
        for (let k = 0; k < FLOAT_SIDES; k++) {
          const a = (k / FLOAT_SIDES) * Math.PI * 2;
          poly.push({ x: part.cx + Math.cos(a) * part.r, y: part.cy + Math.sin(a) * part.r });
        }
        floatPolys.push(poly);
      } else {
        body.createFixture({ ...def, shape: new planck.Polygon(part.pts.map(([px, py]) => new Vec2(px, py))) });
        floatPolys.push(part.pts.map(([px, py]) => ({ x: px, y: py })));
      }
    }
    let area = 0;
    for (const poly of floatPolys) area += clipBelow(poly, Infinity).area;

    const rec = {
      kind: 'block',
      id: item.id,
      si: SHAPE_KEYS.indexOf(item.shape),
      mi: MATERIAL_KEYS.indexOf(item.material),
      static: isStatic,
      float: !!mat.float,
      held,
      owner,
      bad: false,
      body,
      floatPolys,
      area,
    };
    this.recs.set(rec.id, rec);
    this.recOf.set(body, rec);
    if (rec.float && !held) this.floaters.push(rec);
    return rec;
  }

  #removeBlock(rec) {
    this.world.destroyBody(rec.body);
    this.recs.delete(rec.id);
    this.recOf.delete(rec.body);
    const k = this.floaters.indexOf(rec);
    if (k >= 0) this.floaters.splice(k, 1);
  }

  // ── simulation ──
  #update(dt) {
    if (!this.world) return;
    const over = this.phase === PHASE.WON || this.phase === PHASE.LOST;
    if (over) {
      this.endedFor += dt;
      if (this.endedFor > FREEZE_AFTER) return; // nothing left to see: stop spending CPU
    }

    this.#moveHeld(dt);

    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.#buoyancy();
      this.world.step(STEP, 8, 4);
      this.acc -= STEP;
      steps++;
    }
    if (this.acc > STEP) this.acc = 0; // fell behind: drop the backlog instead of spiralling

    const level = levels[this.levelIdx];
    for (const p of this.players.values()) {
      if (!p.held) continue;
      const pos = p.held.rec.body.getPosition();
      p.held.rec.bad = inDrop(level, pos.x, pos.y) && this.#overlapping(p.held.rec); // only matters inside the drop zone
    }
    if (this.phase === PHASE.PLAY) this.#rules(dt);
  }

  #moveHeld(dt) {
    const TAU = Math.PI * 2;
    const k = 1 - Math.exp(-FOLLOW * dt);
    for (const p of this.players.values()) {
      const h = p.held;
      if (!h) continue;
      const body = h.rec.body;
      const pos = body.getPosition();
      const a = body.getAngle();
      const da = ((((h.trot - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI; // shortest way round
      body.setTransform(new Vec2(pos.x + (h.tx - pos.x) * k, pos.y + (h.ty - pos.y) * k), a + da * k);
      body.setLinearVelocity(new Vec2(0, 0));
      body.setAngularVelocity(0);
    }
  }

  /** Archimedes: push each floating block up by the weight of the water its submerged part displaces. */
  #buoyancy() {
    for (const rec of this.floaters) {
      const b = rec.body;
      let wet = 0;
      for (const poly of rec.floatPolys) {
        const world = poly.map((q) => b.getWorldPoint(new Vec2(q.x, q.y)));
        const { area, cx, cy } = clipBelow(world, WATER_Y);
        if (area > 1e-6) {
          wet += area;
          b.applyForce(new Vec2(0, WATER_DENSITY * GRAVITY * area), new Vec2(cx, cy), true);
        }
      }
      const f = rec.area > 0 ? Math.min(1, wet / rec.area) : 0;
      b.setLinearDamping(0.05 + 2.2 * f); // water drag, so a raft bobs a few times and settles instead of bouncing forever
      b.setAngularDamping(0.1 + 4 * f);
    }
  }

  /** Is the (sensor) held block touching a placed block or the bowl? Other players' held blocks do not count. */
  #overlapping(rec) {
    for (let ce = rec.body.getContactList(); ce; ce = ce.next) {
      if (!ce.contact.isTouching()) continue;
      const other = this.recOf.get(ce.other);
      if (other && !other.held) return true;
    }
    return false;
  }

  #rules(dt) {
    const zone = zoneOf(levels[this.levelIdx]);
    let still = true;
    for (const rec of this.recs.values()) {
      if (rec.static || rec.held) continue;
      const body = rec.body;
      const p = body.getPosition();
      if (!rec.float) {
        if (p.y < WATER_Y) return this.#lose(LOSE.WATER);
        if (p.x < zone.x0 || p.x > zone.x1) return this.#lose(LOSE.OUT);
        for (let ce = body.getContactList(); ce; ce = ce.next) {
          if (ce.contact.isTouching() && this.recOf.get(ce.other)?.kind === 'bowl') return this.#lose(LOSE.BOWL);
        }
      }
      const v = body.getLinearVelocity();
      if (Math.hypot(v.x, v.y) > SETTLE_SPEED || Math.abs(body.getAngularVelocity()) > SETTLE_SPEED) still = false;
    }

    // won: every block is placed and the whole structure has stayed still for a moment
    if (this.#remaining() === 0 && still) {
      this.settle += dt;
      if (this.settle >= SETTLE_TIME) {
        this.phase = PHASE.WON;
        this.endedFor = 0;
      }
    } else {
      this.settle = 0;
    }
  }

  #lose(why) {
    this.phase = PHASE.LOST;
    this.why = why;
    this.endedFor = 0;
    this.settle = 0;
    for (const p of this.players.values()) this.#putBack(p);
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const balance = { meta, create: (ctx) => new BalanceGame(ctx) };

// SERVER: the authoritative physics simulation (planck.js = Box2D for JavaScript).
// Clients never simulate anything: they receive body positions every tick and draw them, so every
// player and spectator sees exactly the same physics.
//
// planck is loaded straight from npm by Deno (no deno.json change needed). It needs no extra permissions.
import * as planck from 'npm:planck@1';
import {
  BODY, BOWL, densityOf, frictionOf, getShape, GRAVITY, levels, LOSE, materials, MATERIAL_KEYS, MAX_HOLD_Y, meta, PHASE,
  SHAPE_KEYS, WATER_DENSITY, WATER_Y, zoneOf,
} from './shared.js';

const { Vec2 } = planck;

const STEP = 1 / 120; //          fixed physics step (the platform ticks at 30 Hz, so ~4 physics steps per snapshot)
const MAX_STEPS = 12; //          never do more than this per tick (protects the server if it falls behind)
const SETTLE_TIME = 2; //         seconds everything must be (almost) still after the last block to win
const SETTLE_SPEED = 0.25; //     "still" = linear and angular speed below this
const FREEZE_AFTER = 5; //        stop simulating this long after the level has ended
const FOLLOW = 30; //             how quickly the held block chases the pointer
const FLOAT_SIDES = 24; //        circles are approximated by a polygon when computing buoyancy

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
    this.player = null; //       playerId of the one seated player (null: nobody, everyone is spectating)
    this.phase = PHASE.MENU;
    this.levelIdx = -1;
    this.world = null;
    this.recs = new Map(); //     blockId -> block record (everything that is drawn: statics, floats, placed, held)
    this.recOf = new Map(); //    planck Body -> record (blocks and bowl walls)
    this.queue = []; //           blocks still to place, in order: { id, shape, material }
    this.held = null; //         { item, from, rec, tx, ty, trot }
    this.floaters = [];
    this.total = 0;
    this.settle = 0;
    this.endedFor = 0;
    this.why = 0;
    this.acc = 0;
    this.run = 0; //             bumps on every level start / return to menu, so clients know to rebuild their view
    for (const p of ctx.players) this.onJoin(p);
  }

  // ── GameInstance ──
  onJoin({ id }) {
    if (this.player === null) this.player = id;
  }

  onLeave(id) {
    if (id !== this.player) return;
    this.#cancelHeld();
    this.player = null;
  }

  onInput(id, data) {
    if (id !== this.player || typeof data !== 'object' || data === null) return;
    try {
      this.#input(data);
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
      const p = r.body.getPosition();
      let st = r.static ? BODY.STATIC : BODY.NORMAL;
      if (this.held && this.held.rec === r) st = r.bad ? BODY.HELD_BAD : BODY.HELD;
      b.push([r.id, r.si, r.mi, round2(p.x), round2(p.y), round3(r.body.getAngle()), st]);
    }
    return {
      ph: this.phase,
      run: this.run,
      lv: this.levelIdx,
      b,
      tray: this.#visible().map((i) => [i.id, SHAPE_KEYS.indexOf(i.shape), MATERIAL_KEYS.indexOf(i.material)]),
      left: this.queue.length + (this.held ? 1 : 0),
      total: this.total,
      why: this.why,
      still: round2(clamp(this.settle / SETTLE_TIME, 0, 1)),
    };
  }

  // ── input ──
  #input(d) {
    if (Number.isInteger(d.start)) {
      if (d.start >= 0 && d.start < levels.length && this.phase !== PHASE.PLAY) this.#startLevel(d.start);
    } else if (d.restart === true) {
      if (this.levelIdx >= 0) this.#startLevel(this.levelIdx);
    } else if (d.menu === true) {
      this.#toMenu();
    } else if (this.phase !== PHASE.PLAY) {
      return;
    } else if (Number.isInteger(d.pick)) {
      this.#pick(d);
    } else if (d.drop === true) {
      this.#drop();
    } else if (d.cancel === true) {
      this.#cancelHeld();
    } else if (this.held) {
      const zone = zoneOf(levels[this.levelIdx]);
      if (Number.isFinite(d.x)) this.held.tx = clamp(d.x, zone.x0, zone.x1);
      if (Number.isFinite(d.y)) this.held.ty = clamp(d.y, WATER_Y + 1, MAX_HOLD_Y);
      if (Number.isFinite(d.rot)) this.held.trot = rad(clamp(d.rot, -1e5, 1e5));
    }
  }

  #pick(d) {
    if (this.held) return;
    const level = levels[this.levelIdx];
    const idx = this.queue.slice(0, level.chooseShapes).findIndex((i) => i.id === d.pick);
    if (idx < 0) return;
    const [item] = this.queue.splice(idx, 1);
    const zone = zoneOf(level);
    const x = clamp(Number.isFinite(d.x) ? d.x : 0, zone.x0, zone.x1);
    const y = clamp(Number.isFinite(d.y) ? d.y : 10, WATER_Y + 1, MAX_HOLD_Y);
    const rot = Number.isFinite(d.rot) ? rad(d.rot) : 0;
    const rec = this.#makeBlock(item, x, y, rot, true);
    this.held = { item, from: idx, rec, tx: x, ty: y, trot: rot };
  }

  #cancelHeld() {
    const h = this.held;
    if (!h) return;
    this.#removeBlock(h.rec);
    this.queue.splice(Math.min(h.from, this.queue.length), 0, h.item); // back where it came from
    this.held = null;
  }

  #drop() {
    const h = this.held;
    if (!h || h.rec.bad) return; // not allowed while it overlaps something: the client shows it in red
    const p = h.rec.body.getPosition();
    const angle = h.rec.body.getAngle();
    this.#removeBlock(h.rec);
    this.held = null;
    this.#makeBlock(h.item, p.x, p.y, angle, false); // same id, now a normal falling body
    this.settle = 0;
  }

  // ── levels ──
  #startLevel(i) {
    this.#teardown();
    this.run++;
    const level = levels[i];
    this.levelIdx = i;
    this.phase = PHASE.PLAY;
    this.why = 0;
    this.settle = 0;
    this.endedFor = 0;
    this.acc = 0;
    this.world = new planck.World({ gravity: new Vec2(0, -GRAVITY) });

    // the bowl: floor + two walls, all static
    const { halfW, depth, wall, rim } = BOWL;
    const top = WATER_Y + rim;
    const wallH = top + depth;
    const walls = [
      [0, -depth - wall / 2, halfW + wall, wall / 2], //                         floor
      [-halfW - wall / 2, top - wallH / 2, wall / 2, wallH / 2], //              left wall
      [halfW + wall / 2, top - wallH / 2, wall / 2, wallH / 2], //               right wall
    ];
    for (const [x, y, hx, hy] of walls) {
      const body = this.world.createBody({ type: 'static', position: new Vec2(x, y) });
      body.createFixture({ shape: new planck.Box(hx, hy), friction: 0.6 });
      this.recOf.set(body, { kind: 'bowl' });
    }

    let nextId = 1;
    for (const ib of level.initialBlocks) {
      this.#makeBlock({ id: nextId++, shape: ib.shape, material: ib.material }, ib.x, ib.y, rad(ib.rot ?? 0), false);
    }
    this.queue = level.shapes.map((s) => ({ id: nextId++, shape: s.shape, material: s.material }));
    this.total = this.queue.length;
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
    this.queue = [];
    this.held = null;
  }

  #visible() {
    return this.phase === PHASE.PLAY ? this.queue.slice(0, levels[this.levelIdx].chooseShapes) : [];
  }

  // ── bodies ──
  /** Create the physics body for a block. A held block is a gravity-free sensor: it detects overlaps but pushes nothing. */
  #makeBlock(item, x, y, angle, held) {
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
    let area = 0;
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
        const pts = part.pts.map(([px, py]) => new Vec2(px, py));
        body.createFixture({ ...def, shape: new planck.Polygon(pts) });
        floatPolys.push(part.pts.map(([px, py]) => ({ x: px, y: py })));
      }
    }
    for (const poly of floatPolys) area += clipBelow(poly, Infinity).area;

    const rec = {
      kind: 'block',
      id: item.id,
      si: SHAPE_KEYS.indexOf(item.shape),
      mi: MATERIAL_KEYS.indexOf(item.material),
      static: isStatic,
      float: !!mat.float,
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

    if (this.held) this.held.rec.bad = this.#overlapping(this.held.rec);
    if (this.phase === PHASE.PLAY) this.#rules(dt);
  }

  #moveHeld(dt) {
    const h = this.held;
    if (!h) return;
    const body = h.rec.body;
    const p = body.getPosition();
    const k = 1 - Math.exp(-FOLLOW * dt);
    const a = body.getAngle();
    const TAU = Math.PI * 2;
    const da = ((((h.trot - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI; // shortest way round
    body.setTransform(new Vec2(p.x + (h.tx - p.x) * k, p.y + (h.ty - p.y) * k), a + da * k);
    body.setLinearVelocity(new Vec2(0, 0));
    body.setAngularVelocity(0);
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

  /** Is the (sensor) held block touching anything? */
  #overlapping(rec) {
    for (let ce = rec.body.getContactList(); ce; ce = ce.next) {
      if (ce.contact.isTouching() && this.recOf.has(ce.other)) return true;
    }
    return false;
  }

  #rules(dt) {
    const zone = zoneOf(levels[this.levelIdx]);
    let still = true;
    for (const rec of this.recs.values()) {
      if (rec.static || (this.held && this.held.rec === rec)) continue;
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
    if (this.queue.length === 0 && !this.held && still) {
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
    this.#cancelHeld();
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const balance = { meta, create: (ctx) => new BalanceGame(ctx) };

// The physics simulation of Balance (planck.js = Box2D for JavaScript). Runs on BOTH server and browser.
//
//   server.js   the authoritative game: one BalanceGame per room. Clients never simulate anything there: they receive body positions
//               every tick and draw them, so all players and spectators see exactly the same physics.
//   browser     the debug menu's LOCAL GAME (client.js, "sandbox"): a private BalanceGame that only you see, run on your own copy of the
//               definitions, so editing and testing levels never touches the room (nothing is sent to the server, nobody else is restarted).
//
// planck itself is not imported here: the server hands in `npm:planck@1` and the browser the module it loaded (usePlanck below).
// The gameplay is 2D (x, y); the 3D look is purely client-side.
import {
  applyDefinitions, BODY, bowlOf, bowlProfile, cloneDefinitions, DEBUG, densityOf, frictionOf, getShape, GRAVITY, groundYOf, inDrop, levels, LOSE,
  materials, MATERIAL_KEYS, MAX_HOLD_X, MAX_HOLD_Y, MIN_HOLD_Y, PHASE, PREVIEW_COUNT, SHAPE_KEYS, tuning, validateDefinitions, WATER_DENSITY, WATER_Y, zoneOf,
} from './shared.js';

let planck = null;
let Vec2 = null;
/** Hand in the planck module (once, before the first BalanceGame is made). */
export function usePlanck(module) {
  planck = module;
  Vec2 = module.Vec2;
}

// ── Rooms have their own definitions ──
// shared.js keeps ONE live set of definitions (tuning, shapes, levels ...) per process, and every room of this server is a BalanceGame in the same
// process. A room that has never changed anything shares BASE (the files as they were when the server started). The debug menu cannot change a room's set any more (its edits only reach the
// private local game in the browser, through loadDefinitions). Before a room does anything (input, tick, snapshot) its set is made the live one, so rooms never see each other's edits.
const BASE = cloneDefinitions();
let active = BASE; // whose definitions are live right now
function activate(defs) {
  if (!DEBUG || active === defs) return;
  applyDefinitions(defs, defs);
  active = defs;
}

const STEP = 1 / 120; //          fixed physics step (the platform ticks at 30 Hz, so ~4 physics steps per snapshot)
const MAX_STEPS = 12; //          never do more than this per tick (protects the server if it falls behind)
const WIN_HOLD = 0.8; //          seconds the third green dot stays lit (the countdown has run out, everything still has to stand) before the level counts as cleared
const WIN_SHOW = 2.6; //          seconds "level cleared" is shown before the game goes back to the level menu
const FREEZE_AFTER = 5; //        stop simulating this long after the level has ended
const FLOAT_SIDES = 24; //        circles are approximated by a polygon when computing buoyancy
const BOWL_SEGMENTS = 36;
const DEFS_BURST = 0.3; //        debug: seconds the new definitions ride along in every snapshot after a change
// countdown and follow come from `tuning` (definitions.js)
const LAB_ID_START = 100000; //   ids of blocks spawned in the level lab (they never clash with the ids of a level's own blocks)
const LAB_MAX_BLOCKS = 300;
const FRAGILE_REST = 0.2; //      seconds a block must rest on a fragile one before it counts
const START_GRACE = 0.8; //       seconds after a level starts during which start / restart clicks are ignored (two players clicking the same button)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const rad = (deg) => (deg * Math.PI) / 180;
const snapDeg = (deg) => Math.round(deg / 45) * 45; // held blocks only turn in steps of 45°

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

export class BalanceGame {
  constructor(ctx) {
    this.ctx = ctx;
    // ctx.sandboxDefs (browser only) = a private game of the debug menu: it runs on its own copy of the definitions and never leaves this page
    this.sandbox = !!ctx.sandboxDefs;
    this.grace = this.sandbox ? 0 : START_GRACE;
    this.defs = ctx.sandboxDefs ?? BASE; // debug: this room's definitions (BASE until somebody applies a change here)
    activate(this.defs);
    this.players = new Map(); //  playerId -> { slot, held: null | { item, rec, tx, ty, trot } }
    this.phase = PHASE.MENU;
    this.levelIdx = -1;
    this.run = 0; //              bumps on every level start / return to menu, so clients know to rebuild their view
    this.world = null;
    this.recs = new Map(); //     blockId -> block record (everything drawn in the play area: statics, floats, placed, held)
    this.recOf = new Map(); //    planck Body -> record (blocks and the bowl)
    this.table = []; //           the row of places on the table: each an item (a block that waits), or null (empty, or the outline of a block that is still to come)
    this.queue = []; //           blocks that have not appeared on the table yet, in order; the first PREVIEW_COUNT of them show as an outline on a place of the row (item.slot)
    this.floaters = [];
    this.total = 0;
    this.settle = 0;
    this.endedFor = 0;
    this.why = 0;
    this.acc = 0;
    this.startedAt = -Infinity;
    this.defsRev = 0; //          debug: bumps every time somebody changes the definitions
    this.defsBurst = 0; //        debug: > 0 while the definitions are attached to the snapshots
    this.lab = { on: false, paused: false, rules: false }; // debug: the level lab (no winning / losing, spawn blocks, freeze gravity), see #labInput
    this.rowSize = 0; //           how many places the row on the table has (blocks that wait + outlines of the next ones): fixed for a level, so nothing shifts
    this.floor = null; //          the level lab's invisible floor (the table top), see #labFloor
    this.labId = LAB_ID_START;
    for (const p of ctx.players) this.onJoin(p);
  }

  // ── GameInstance ──
  onJoin({ id, slot }) {
    activate(this.defs);
    if (!this.players.has(id)) this.players.set(id, { slot, held: null });
  }

  onLeave(id) {
    activate(this.defs);
    const p = this.players.get(id);
    if (!p) return;
    this.#putBack(p);
    this.players.delete(id); // drop-in game: it just goes on, even with nobody in it
    if (DEBUG && this.lab.on && this.lab.by === id) { // the level designer left with the lab still on: make it an ordinary level again
      this.lab = { on: false, paused: false, rules: false, by: null };
      if (this.levelIdx >= 0 && this.levelIdx < levels.length) this.#startLevel(this.levelIdx);
    }
  }

  onInput(id, data) {
    activate(this.defs);
    const p = this.players.get(id); // spectators are not in the map: ignored
    if (!p || typeof data !== 'object' || data === null) return;
    try {
      this.#input(id, p, data);
    } catch (e) {
      console.error('balance: input failed', e);
    }
  }

  update(dt) {
    activate(this.defs);
    if (this.defsBurst > 0) this.defsBurst -= dt;
    try {
      this.#update(dt);
    } catch (e) {
      console.error('balance: update failed, going back to the menu', e);
      this.#toMenu();
    }
  }

  snapshot() {
    activate(this.defs);
    const b = [];
    for (const r of this.recs.values()) {
      const pos = r.body.getPosition();
      let st = r.static ? BODY.STATIC : BODY.NORMAL;
      if (r.held) st = r.bad ? BODY.HELD_BAD : BODY.HELD;
      b.push([r.id, r.si, r.mi, round2(pos.x), round2(pos.y), round3(r.body.getAngle()), st, r.held ? r.owner : -1, r.load]);
    }
    const tbl = [];
    this.table.forEach((item, i) => {
      if (item) tbl.push([item.id, SHAPE_KEYS.indexOf(item.shape), MATERIAL_KEYS.indexOf(item.material), i, item.heldBy ? (this.players.get(item.heldBy)?.slot ?? -1) : -1]);
    });
    const nx = this.queue.slice(0, PREVIEW_COUNT).map((item) => [item.id, SHAPE_KEYS.indexOf(item.shape), item.slot]); // the next blocks to appear: id, SHAPE (not the material) and the place of the row where they show as an outline
    return {
      run: this.run,
      ph: this.phase,
      lv: this.levelIdx,
      b,
      tbl,
      ...(nx.length ? { nx } : {}),
      n: this.table.length,
      w: this.rowSize,
      left: this.#remaining(),
      total: this.total,
      why: this.why,
      still: round2(clamp(this.settle / (tuning.countdown ?? 3), 0, 1)), // progress of the countdown after the last block (0 = not running)
      ...(DEBUG ? { lab: this.lab.on ? (this.lab.paused ? 2 : 1) : 0, lr: this.lab.rules ? 1 : 0, drev: this.defsRev, ...(this.defsBurst > 0 ? { defs: this.#defs() } : {}) } : {}),
    };
  }

  #defs() {
    return (this.defsCache ??= cloneDefinitions());
  }

  // ── input ──
  /** Nobody is in charge: every seated player may choose levels, restart and go back to the menu. */
  #input(id, p, d) {
    if (DEBUG && (d.debugChunk || d.defsRequest)) return this.#debugInput(id, d);
    if (DEBUG && d.lab) return this.#labInput(id, p, d.lab);
    const settled = performance.now() - this.startedAt > this.grace * 1000;
    if (Number.isInteger(d.start)) {
      if (settled && d.start >= 0 && d.start < levels.length) this.#startLevel(d.start);
    } else if (d.restart === true) {
      if (settled && this.levelIdx >= 0) this.#startLevel(this.levelIdx);
    } else if (d.menu === true) {
      this.#toMenu();
    } else if (this.phase !== PHASE.PLAY) {
      return;
    } else if (Number.isInteger(d.pick)) {
      this.#pick(id, p, d);
    } else if (d.drop === true) {
      this.#drop(p);
    } else if (d.cancel === true) {
      this.#putBack(p);
    } else if (p.held) {
      if (Number.isFinite(d.x)) p.held.tx = clamp(d.x, -MAX_HOLD_X, MAX_HOLD_X);
      if (Number.isFinite(d.y)) p.held.ty = clamp(d.y, MIN_HOLD_Y, MAX_HOLD_Y);
      if (Number.isFinite(d.rot)) p.held.trot = rad(snapDeg(clamp(d.rot, -1e5, 1e5)));
    }
  }

  /**
   * Sandbox (browser): swap this game's definitions for a copy of `defs` (already checked by the caller). Nothing is written or sent.
   * The level restarts when the lists snapshots index into changed, or when it no longer exists; otherwise it keeps running (call
   * { lab: { play } } to restart it).
   */
  loadDefinitions(defs) {
    activate(this.defs);
    const keys = () => `${SHAPE_KEYS.join()}|${MATERIAL_KEYS.join()}`;
    const before = keys();
    applyDefinitions(defs);
    this.defs = cloneDefinitions();
    applyDefinitions(this.defs, this.defs);
    active = this.defs;
    this.defsCache = null;
    this.defsRev++;
    if (this.world) this.world.setGravity(new Vec2(0, -GRAVITY));
    if (this.levelIdx >= levels.length) this.#toMenu();
    else if (this.levelIdx >= 0 && keys() !== before) this.#startLevel(this.levelIdx);
  }

  /**
   * Sandbox (browser): only the LEVELS changed (a block was dragged ...). Cheaper than loadDefinitions: what was built from the shapes and
   * bowls is kept. A running level keeps running (call { lab: { play } } to restart it); a level that no longer exists sends us to the menu.
   */
  loadLevels(list) {
    activate(this.defs);
    levels.length = 0;
    levels.push(...JSON.parse(JSON.stringify(list)));
    this.defs.levels = JSON.parse(JSON.stringify(list));
    this.defsCache = null;
    this.defsRev++;
    if (this.levelIdx >= levels.length) this.#toMenu();
  }

  /** Debug menu: a player that just came in asks for the room's definitions. Nobody can change them from the menu: edits only ever reach the private local game. */
  #debugInput(id, d) {
    if (d.defsRequest) this.defsBurst = DEFS_BURST;
  }

  /**
   * Debug: the LEVEL LAB. While it is on nothing is won or lost, the drop zone is ignored, and the level designer can
   *   { on: bool }              switch the lab on / off (off = the level is a normal level again; it is restarted by the client)
   *   { rules: bool }           let the level be lost / won while the lab is on (to test failing); Reset (play / reload) starts it again
   *   { paused: bool }          freeze / unfreeze physics. Held blocks still move, so you can place blocks precisely and THEN let gravity act.
   *   { spawn: { shape, material, x, y, rot, held } }   a new block: held by you (default) or put straight into the world
   *   { grab: id }              pick up a block that is already in the world (also static ones: letting go makes it static again)
   *   { remove: id }            delete a block
   *   { reload: true }          start the current level again (the lab stays on), { play: n } start level n (ignores the start grace)
   */
  #labInput(id, p, c) {
    if (typeof c !== 'object' || c === null) return;
    const lab = this.lab;
    if (typeof c.on === 'boolean') {
      lab.on = c.on;
      lab.by = c.on ? id : null; // whoever switched it on: when they leave, the lab ends (see onLeave)
      if (!c.on) {
        lab.paused = false;
        lab.rules = false;
      }
      this.#labFloor();
      if (c.on && (this.phase === PHASE.WON || this.phase === PHASE.LOST)) {
        this.phase = PHASE.PLAY;
        this.why = 0;
        this.settle = 0;
        this.endedFor = 0;
      }
    }
    if (typeof c.paused === 'boolean' && lab.on) lab.paused = c.paused;
    if (typeof c.rules === 'boolean' && lab.on) lab.rules = c.rules;
    if (c.play !== undefined) {
      if (Number.isInteger(c.play) && c.play >= 0 && c.play < levels.length) this.#startLevel(c.play);
      return;
    }
    if (c.reload === true) {
      if (this.levelIdx >= 0 && this.levelIdx < levels.length) this.#startLevel(this.levelIdx);
      return;
    }
    if (!lab.on || !this.world || this.phase !== PHASE.PLAY) return;
    const num = (v, d, lo, hi) => clamp(Number.isFinite(v) ? v : d, lo, hi);

    if (c.spawn && typeof c.spawn === 'object') {
      const s = c.spawn;
      if (!SHAPE_KEYS.includes(s.shape) || !MATERIAL_KEYS.includes(s.material) || this.recs.size >= LAB_MAX_BLOCKS) return;
      const x = num(s.x, 0, -MAX_HOLD_X, MAX_HOLD_X);
      const y = num(s.y, 12, MIN_HOLD_Y, MAX_HOLD_Y);
      const rot = rad(num(s.rot, 0, -1e5, 1e5));
      const item = { id: this.labId++, shape: s.shape, material: s.material, heldBy: null, slot: -1, lab: true };
      if (s.held === false) {
        this.#makeBlock(item, x, y, rot, false);
        this.settle = 0;
      } else {
        this.#putBack(p);
        p.held = { item, rec: this.#makeBlock(item, x, y, rot, true, p.slot), tx: x, ty: y, trot: rot };
      }
    } else if (Number.isInteger(c.grab)) {
      const rec = this.recs.get(c.grab);
      if (!rec || rec.held || rec.kind !== 'block') return;
      this.#putBack(p);
      const pos = rec.body.getPosition();
      const angle = rec.body.getAngle();
      const item = { id: rec.id, shape: SHAPE_KEYS[rec.si], material: MATERIAL_KEYS[rec.mi], heldBy: null, slot: -1, lab: true };
      this.#removeBlock(rec);
      p.held = { item, rec: this.#makeBlock(item, pos.x, pos.y, angle, true, p.slot), tx: pos.x, ty: pos.y, trot: angle };
    } else if (Number.isInteger(c.remove)) {
      const rec = this.recs.get(c.remove);
      if (rec && !rec.held && rec.kind === 'block') this.#removeBlock(rec);
    }
  }

  /**
   * The level lab has a FLOOR: the table top, as a static body that is not drawn. Nothing is lost while the lab is on, so without a floor a block that misses the bowl
   * (or one that is let go of next to it) would fall through the bottom of the world for ever. Called when a level starts and when the lab is switched on or off.
   */
  #labFloor() {
    if (!this.world) return;
    if (this.floor && !this.lab.on) {
      this.world.destroyBody(this.floor);
      this.recOf.delete(this.floor);
      this.floor = null;
    } else if (!this.floor && this.lab.on) {
      const top = groundYOf(bowlOf(levels[this.levelIdx]));
      const half = MAX_HOLD_X + 40;
      this.floor = this.world.createBody({ type: 'static', position: new Vec2(0, top - 2) });
      this.floor.createFixture({ shape: new planck.Box(half, 2), friction: 0.6 });
      this.recOf.set(this.floor, { kind: 'floor' });
    }
  }

  /** Take a block from the table. Its slot stays empty (no refill) until the block is dropped into the play area. */
  #pick(id, p, d) {
    if (p.held) return;
    const item = this.table.find((i) => i && i.id === d.pick && !i.heldBy);
    if (!item) return; // somebody else was faster, or it is not on the table
    const x = clamp(Number.isFinite(d.x) ? d.x : 0, -MAX_HOLD_X, MAX_HOLD_X);
    const y = clamp(Number.isFinite(d.y) ? d.y : 0, MIN_HOLD_Y, MAX_HOLD_Y);
    const rot = Number.isFinite(d.rot) ? rad(snapDeg(d.rot)) : 0;
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

  /** Does the held block overlap a block that is already on the board? (It is a sensor, so its contacts tell us.) Such a block cannot be placed. */
  #overlaps(rec) {
    for (let ce = rec.body.getContactList(); ce; ce = ce.next) {
      const other = this.recOf.get(ce.other);
      if (other && other.kind === 'block' && !other.held && ce.contact.isTouching()) return true;
    }
    return false;
  }

  /** Let go. Always lets go: inside the drop zone the block falls into the play area, outside it returns to the table. */
  #drop(p) {
    const h = p.held;
    if (!h) return;
    const level = levels[this.levelIdx];
    const pos = h.rec.body.getPosition();
    // A block can only be dropped while it is inside the drop zone right now and does not overlap another block; otherwise it goes back to the table.
    // (the level lab lets you drop the blocks it made itself anywhere; the blocks of the level, from the table, follow the real rules there too:
    // letting go of one below the drop zone, or where it overlaps, sends it back to the table instead of dropping it into the water)
    if ((!this.lab.on || !h.item.lab) && (!inDrop(level, pos.x, pos.y) || this.#overlaps(h.rec))) return this.#putBack(p);

    const angle = h.rec.body.getAngle();
    const item = h.item;
    this.#removeBlock(h.rec);
    p.held = null;
    this.#makeBlock(item, pos.x, pos.y, angle, false); // same id, now a normal falling body
    if (!item.lab) { // (blocks made in the level lab were never on the table)
      // Nothing on the table moves. The next block appears where its OUTLINE was (the outline turns into the block), the place that was just
      // freed stays empty, unless there is another block to come into view: it gets its outline there.
      const free = item.slot;
      this.table[free] = null;
      const next = this.queue.shift() ?? null;
      if (next) this.table[next.slot] = next;
      for (const q of this.queue.slice(0, PREVIEW_COUNT)) if (q.slot < 0) q.slot = free;
    }
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
    this.startedAt = performance.now();
    this.world = new planck.World({ gravity: new Vec2(0, -GRAVITY) });

    // the bowl: a ring of convex quads following the profile of the bowl this level uses
    const bowl = this.world.createBody({ type: 'static', position: new Vec2(0, 0) });
    const { inner, outer } = bowlProfile(BOWL_SEGMENTS, bowlOf(level));
    for (let k = 0; k < BOWL_SEGMENTS; k++) {
      const quad = [inner[k], inner[k + 1], outer[k + 1], outer[k]].map(([x, y]) => new Vec2(x, y));
      bowl.createFixture({ shape: new planck.Polygon(quad), friction: 0.6 });
    }
    this.recOf.set(bowl, { kind: 'bowl' });

    this.labId = LAB_ID_START;
    this.#labFloor();
    let nextId = 1;
    for (const ib of level.initialBlocks) {
      this.#makeBlock({ id: nextId++, shape: ib.shape, material: ib.material }, ib.x, ib.y, rad(ib.rot ?? 0), false);
    }
    const items = level.shapes.map((s) => ({ id: nextId++, shape: s.shape, material: s.material, heldBy: null, slot: -1 }));
    this.total = items.length;
    const n = Math.max(1, Math.min(level.chooseShapes, items.length));
    this.rowSize = n + Math.min(PREVIEW_COUNT, items.length - n); // places of the row: the waiting blocks, then the outlines of the next ones (centred on all of it, fixed for the level)
    this.table = Array.from({ length: this.rowSize }, (_, k) => {
      const item = k < n ? items[k] : null;
      if (item) item.slot = k;
      return item;
    });
    this.queue = items.slice(n);
    this.queue.forEach((item, k) => { item.slot = k < this.rowSize - n ? n + k : -1; }); // the next ones show as an outline on the places after the blocks
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
    this.rowSize = 0;
    this.floor = null;
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
    const def = { density: densityOf(item.material), friction: frictionOf(item.material), restitution: isStatic ? 0 : 0.04, isSensor: held || (isStatic && !!mat.hazard) }; // (a hazard block, like the water block, is not solid: blocks fall straight through it, and touching it still loses, see #rules)
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
      floatLevel: mat.floatLevel ?? 0,
      buoy: null,
      held,
      owner,
      bad: false,
      hazard: !!mat.hazard, // (a static block that loses the level when another block touches it)
      stackLimit: mat.stackLimit ?? null, // blocks that may rest on this one; one more and it breaks (see #glass)
      load: 0, //           how many do rest on it (shown as the colour of its dot): 0 .. stackLimit
      seen: new Map(), //   block id -> seconds it has been resting on this one
      armed: false, // becomes true once the held block has been inside the drop zone; before that it is never shown as 'bad'
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
      if (this.phase === PHASE.WON && !this.lab.on && this.endedFor > WIN_SHOW) return this.#toMenu(); // "level cleared" has been shown: back to the levels
      if (this.endedFor > FREEZE_AFTER) return; // nothing left to see: stop spending CPU
    }

    this.#moveHeld(dt);

    this.acc += dt;
    let steps = 0;
    if (this.lab.paused || this.phase === PHASE.WON) this.acc = 0; // the lab froze physics; a cleared level is frozen as it stands (the winning tower stays still while "level cleared" is shown)
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
      const inside = inDrop(level, pos.x, pos.y);
      if (inside) p.held.rec.armed = true;
      p.held.rec.bad = (!this.lab.on || !p.held.item.lab) && this.#overlaps(p.held.rec); // red = it overlaps another block (and only then) // red = you have taken it out of the drop zone again (letting go sends it back to the table)
    }
    if (this.phase === PHASE.PLAY && !this.lab.paused) this.#fragile(dt);
    if (this.phase === PHASE.PLAY && (!this.lab.on || this.lab.rules)) this.#rules(dt); // (the level lab can switch the rules back on to test failing)
  }

  /**
   * Blocks with a stack limit (glass): count the blocks resting on top of them, directly or through other blocks. A block only counts
   * once it has rested there for a moment, so one that is still falling past does not. More than the limit and the block breaks.
   */
  #fragile(dt) {
    for (const rec of [...this.recs.values()]) {
      if (rec.stackLimit === null || rec.held || rec.static) continue;
      const above = new Set();
      const queue = [rec];
      while (queue.length) {
        const cur = queue.pop();
        for (let ce = cur.body.getContactList(); ce; ce = ce.next) {
          const other = this.recOf.get(ce.other);
          if (!other || other.kind !== 'block' || other.held || other.static || above.has(other.id) || other === rec) continue;
          if (!ce.contact.isTouching() || !this.#isAbove(ce.contact, cur.body, ce.other)) continue;
          above.add(other.id);
          queue.push(other);
        }
      }
      for (const id of above) rec.seen.set(id, (rec.seen.get(id) ?? 0) + dt);
      for (const id of [...rec.seen.keys()]) if (!above.has(id)) rec.seen.delete(id);
      let n = 0;
      for (const t of rec.seen.values()) if (t >= FRAGILE_REST) n++;
      if (n > rec.stackLimit) {
        this.#removeBlock(rec); // it shatters (the clients see it vanish and draw the shards)
        this.settle = 0;
        continue;
      }
      rec.load = n;
    }
  }

  /** Is `upper` resting on `lower` in this contact (the contact normal points up from lower to upper)? */
  #isAbove(contact, lower, upper) {
    try {
      const n = contact.getWorldManifold(undefined).normal; // points from fixture A to fixture B
      const lowerIsA = contact.getFixtureA().getBody() === lower;
      return (lowerIsA ? n.y : -n.y) > 0.5;
    } catch {
      return upper.getPosition().y > lower.getPosition().y;
    }
  }

  #moveHeld(dt) {
    const TAU = Math.PI * 2;
    const k = 1 - Math.exp(-tuning.follow * dt);
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
      // floatLevel: how much of the block is under water when it floats alone (0.5 = half). The push is scaled so that it never sinks
      // below that for long (a full push of 1 / floatLevel times its weight), but it still tilts: the push acts at the middle of the wet part.
      rec.buoy ??= rec.floatLevel > 0 && rec.area > 0 ? b.getMass() / (rec.floatLevel * rec.area * WATER_DENSITY) : 1;
      for (const poly of rec.floatPolys) {
        const world = poly.map((q) => b.getWorldPoint(new Vec2(q.x, q.y)));
        const { area, cx, cy } = clipBelow(world, WATER_Y);
        if (area > 1e-6) {
          wet += area;
          b.applyForce(new Vec2(0, WATER_DENSITY * rec.buoy * GRAVITY * area), new Vec2(cx, cy), true);
        }
      }
      const f = rec.area > 0 ? Math.min(1, wet / rec.area) : 0;
      b.setLinearDamping(0.05 + 2.2 * f); // water drag, so a raft bobs a few times and settles instead of bouncing forever
      b.setAngularDamping(0.1 + 4 * f);
    }
  }

  #rules(dt) {
    const zone = zoneOf(levels[this.levelIdx]);
    for (const rec of this.recs.values()) {
      if (rec.static || rec.held) continue;
      const body = rec.body;
      const p = body.getPosition();
      for (let ce = body.getContactList(); ce; ce = ce.next) { // touching a hazard block (floating blocks too)
        const other = this.recOf.get(ce.other);
        if (other?.hazard && other.static && ce.contact.isTouching()) return this.#lose(LOSE.HAZARD);
      }
      if (!rec.float) {
        if (p.y < WATER_Y) return this.#lose(LOSE.WATER);
        if (p.x < zone.x0 || p.x > zone.x1) return this.#lose(LOSE.OUT);
        for (let ce = body.getContactList(); ce; ce = ce.next) {
          if (ce.contact.isTouching() && this.recOf.get(ce.other)?.kind === 'bowl') return this.#lose(LOSE.BOWL);
        }
      }
    }

    // won: every block is placed and a countdown has run out (no check for stability: only losing blocks into the water or the bowl matters)
    if (this.#remaining() === 0) {
      this.settle += dt;
      if (this.settle >= (tuning.countdown ?? 3) + WIN_HOLD) { // (the dots fill up during `countdown`: the third one is on for the last WIN_HOLD seconds)
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

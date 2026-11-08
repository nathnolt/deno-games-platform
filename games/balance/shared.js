// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.
//
// The game CONTENT (materials, shapes, bowls, models, backgrounds, levels, tuning) is plain data in ./_definitions.js.
// This file is the logic around it: helpers, wire constants, validation, and the code the debug menu uses to edit and export it.

import { backgrounds, bowls, materials, models, tuning } from './_definitions.js';
import * as DEFS from './_definitions.js';
// _levels.js holds the levels GROUPED BY WORLD: { world1: { name: 'World 1', levels: [ {...}, ... ] }, ... } (the order of the worlds and of the levels in them
// is the order of the menu). The rest of the game works with two tables made from it: `worlds` ({ key: { name } }) and a flat list `levels` in which every
// level knows its world (level.world), worlds in order, levels in order. (The old format, a plain list of levels with the worlds table in
// _definitions.js, is still read.)
const levelFile = DEFS.levels;
const nestedFile = !!levelFile && !Array.isArray(levelFile);
/** The worlds the levels are grouped in. */
const worlds = nestedFile
  ? Object.fromEntries(Object.entries(levelFile).map(([k, w]) => [k, Object.fromEntries(Object.entries(w).filter(([f]) => f !== 'levels'))]))
  : (DEFS.worlds ?? { main: { name: 'Levels' } });
/** Every level of every world, in menu order, each with its `world`. */
const levels = nestedFile ? Object.entries(levelFile).flatMap(([k, w]) => (w.levels ?? []).map((lv) => ({ ...lv, world: k }))) : levelFile;
// _shapes.js holds the shapes GROUPED BY CATEGORY: { Tetris: { B: [ ...parts ], L: [ ... ] }, Fancy: { heart: [ ... ] }, ... } (the order of the categories
// and of the shapes in them is the order of the shape selects). The rest of the game works with two flat tables made from it: `shapes` ({ key: [parts] })
// and `shapeCategories` ({ key: 'Category name' }; a shape in 'Other' has no entry). (The old format, a flat table of shapes next to a `shapeCategories`
// table, is still read.)
const shapeFile = DEFS.shapes ?? {};
const nestedShapes = Object.values(shapeFile).some((v) => v && !Array.isArray(v));
export const OTHER_CATEGORY = 'Other';
/** The category of each shape: { shapeKey: 'Category name' }. A shape without one is in 'Other'. */
const shapeCategories = nestedShapes
  ? Object.fromEntries(Object.entries(shapeFile).flatMap(([c, group]) => (c === OTHER_CATEGORY ? [] : Object.keys(group).map((k) => [k, c]))))
  : (DEFS.shapeCategories ?? {});
/** Every shape of every category, in order. */
const shapes = nestedShapes ? Object.fromEntries(Object.values(shapeFile).flatMap((group) => Object.entries(group))) : shapeFile;
/** The shaders made or changed in the shader studio: { name: { type?, code } } (see _shaders.js). */
const shaderCode = DEFS.shaderCode ?? {};
export { backgrounds, bowls, levels, materials, models, shapes, shapeCategories, shaderCode, tuning, worlds };

/** The category name of a shape. */
export const categoryOf = (key, cats = shapeCategories) => (typeof cats[key] === 'string' && cats[key] ? cats[key] : OTHER_CATEGORY);
/**
 * The shape keys grouped by category: [[category, [keys]], ...]. The categories come in the order they first appear in the table of categories
 * ('Other' last); inside a category the shapes keep their own order.
 */
export function shapeGroups(keys, cats = shapeCategories) {
  const order = [];
  for (const k of Object.keys(cats)) { const c = categoryOf(k, cats); if (!order.includes(c)) order.push(c); }
  const groups = new Map();
  for (const k of keys) {
    const c = categoryOf(k, cats);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(k);
  }
  const names = [...groups.keys()].sort((a, b) => (a === OTHER_CATEGORY) - (b === OTHER_CATEGORY) || ((order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)));
  return names.map((c) => [c, groups.get(c)]);
}

/**
 * Debug menu switch. true = the in-game debug menu is available (the ` key or the button at the bottom left) and the server
 * accepts definition changes from the players. Leave it false for a real game: anybody in the room could change the rules.
 */
export const DEBUG = true;

/** The colours a player can choose for themselves (the defaults of the four seats are among them). */
export const PLAYER_COLORS = [
  ['red', '#ef4444'], ['orange', '#f97316'], ['yellow', '#eab308'], ['green', '#22c55e'], ['cyan', '#06b6d4'],
  ['blue', '#3b82f6'], ['purple', '#8b5cf6'], ['magenta', '#d946ef'], ['grey', '#6b7280'],
];
export const isPlayerColor = (c) => typeof c === 'string' && PLAYER_COLORS.some(([, hex]) => hex === c.toLowerCase());

/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'balance',
  name: 'Balance',
  description: 'Stack the blocks without letting anything fall. Join or leave whenever you like; everybody can pick levels (1-4 players).',
  minPlayers: 1,
  dropIn: true, // no setup page: people join and leave while the game runs, and nobody is in charge
  maxPlayers: 4, // up to four people work on the same tower; one person is also a normal single-player game
  seatNames: ['Red', 'Blue', 'Green', 'Yellow'],
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'],
  tickRate: 30, // snapshots per second; the physics runs on its own fixed (finer) step inside the server
  settings: [],
};

// ── World units ──────────────────────────────────────────────────────────────────────────────────────────────
// The GAMEPLAY is 2D: x = right, y = up, in the plane z = PLAY_Z. y = 0 is the surface of the water.
// The VISUALS are 3D: every block is the same DEPTH thick. Shape coordinates are in these same units
// (a 4x4 square is 4 units wide). Level x/y positions are the CENTRE of the shape.
//
//   z (towards the camera)
//   HOVER_Z   ← a block you hold is carried here once it is up in the play area (0 = exactly where it lands when you let go; on the way up it comes from the table)
//   FRONT_Z   ← blocks waiting on the table
//   PLAY_Z    ← the tower, the pillars and the bowl: this is where the physics happens
//
// The values below come from `tuning` in _definitions.js. They are `let` on purpose: when the debug menu changes the tuning,
// syncDefinitions() reassigns them and every module that imported them sees the new value.
export const WATER_Y = 0;
export const PLAY_Z = 0;
export let GRAVITY = 30;
export let WATER_DENSITY = 1;
export let DEPTH = 2.4;
export let FRONT_Z = 17;
/** How many of the blocks that are still to come (after the ones on the table) are shown as an outline on the table. Server and client agree on it. */
export const PREVIEW_COUNT = 2;
export let HOVER_Z = 0;
export let SLOT_GAP = 17;
export let MAX_HOLD_X = 120;
export let MAX_HOLD_Y = 60;
export let MIN_HOLD_Y = -25;
/** Default sideways limit. A block whose centre leaves it loses the level. Levels can override with `zone`. */
export const ZONE = { x0: -30, x1: 30 };
/** The DROP ZONE: let go of a block with its centre inside and it falls into the play area; let go outside and it goes back to the table. */
export const DROP = { x0: -120, x1: 120, y0: 1.5, y1: 100 };
/** What the camera must always show. Height follows the window aspect, but never less than h. */
export const VIEW = { w: 84, h: 46, cy: 10 };

/** Names of all shapes / materials, in order: snapshots refer to them by index. Reassigned by syncDefinitions(). */
export let SHAPE_KEYS = Object.keys(shapes);
export let MATERIAL_KEYS = Object.keys(materials);

let cache = new Map(); // getShape() results of the live definitions
const caches = new WeakMap(); // owner of a set of definitions -> its cache (a server with several rooms swaps between sets without rebuilding every shape)

/** Recompute everything derived from the definitions. Called once on load and after every change to them. */
export function syncDefinitions() {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const t = tuning;
  GRAVITY = num(t.gravity, 30);
  WATER_DENSITY = num(t.waterDensity, 1);
  DEPTH = num(t.depth, 2.4);
  FRONT_Z = num(t.frontZ, 17);
  HOVER_Z = num(t.hoverZ, 0);
  SLOT_GAP = num(t.slotGap, 17);
  MAX_HOLD_X = num(t.maxHoldX, 120);
  MAX_HOLD_Y = num(t.maxHoldY, 60);
  MIN_HOLD_Y = num(t.minHoldY, -25);
  Object.assign(ZONE, { x0: -30, x1: 30 }, t.zone);
  Object.assign(DROP, { x0: -120, x1: 120, y0: 1.5, y1: 100 }, t.drop);
  Object.assign(VIEW, { w: 84, h: 46, cy: 10 }, t.view);
  SHAPE_KEYS = Object.keys(shapes);
  MATERIAL_KEYS = Object.keys(materials);
  cache.clear();
}

// ── Materials ────────────────────────────────────────────────────────────────────────────────────────────────
export const frictionOf = (m) => (materials[m].friction ?? 10) / 20;
export const densityOf = (m) => (materials[m].weight ?? 10) / 10;

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The radius of the rounding of every block edge (tuning.round; an older _definitions.js calls it chamfer). */
export const roundOf = () => (Number.isFinite(tuning.round) ? tuning.round : Number.isFinite(tuning.chamfer) ? tuning.chamfer : 0);

/**
 * Round the corners of an outline: every corner that turns by more than `minTurn` becomes an arc of radius R that touches both edges (a convex corner
 * is cut off, a concave one is filled). An arc never takes more than 45% of an edge, so neighbouring arcs never meet: on a short edge the arc gets
 * smaller (and a corner that would need an arc under half of R stays sharp). Gentle bends, like the 7.5 degrees between the corners of a circle, are left alone.
 * @param {number[][]} pts  a loop, either way round
 * @param {number} R
 * @param {number} step  the angle one piece of an arc spans (radians)
 */
export function roundOutline(pts, R, minTurn = (20 * Math.PI) / 180, step = (30 * Math.PI) / 180) {
  pts = pts.filter((q, i) => { const p = pts[(i + pts.length - 1) % pts.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9; }); // (a point written twice in a row)
  if (!(R > 0) || pts.length < 3) return pts;
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const lu = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const lw = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ux = (a[0] - b[0]) / lu, uy = (a[1] - b[1]) / lu;
    const wx = (c[0] - b[0]) / lw, wy = (c[1] - b[1]) / lw;
    const inner = Math.acos(Math.max(-1, Math.min(1, ux * wx + uy * wy))); // the angle between the two edges: PI = straight on
    const turn = Math.PI - inner;
    if (turn < minTurn || turn > Math.PI * 0.97) { out.push(b); continue; }
    const half = Math.tan(turn / 2);
    let t = R * half; // how far from the corner the arc touches the edges
    const most = Math.min(lu, lw) * 0.45;
    let r = R;
    if (t > most) { t = most; r = t / half; }
    if (r < R * 0.5) { out.push(b); continue; }
    const bx = ux + wx, by = uy + wy;
    const bl = Math.hypot(bx, by) || 1;
    const dc = r / Math.sin(inner / 2); // from the corner to the middle of the arc, along the bisector
    const cx = b[0] + (bx / bl) * dc, cy = b[1] + (by / bl) * dc;
    const t1 = [b[0] + ux * t, b[1] + uy * t];
    const t2 = [b[0] + wx * t, b[1] + wy * t];
    const a1 = Math.atan2(t1[1] - cy, t1[0] - cx);
    let delta = Math.atan2(t2[1] - cy, t2[0] - cx) - a1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const m = Math.max(1, Math.ceil(Math.abs(delta) / step));
    out.push(t1);
    for (let k = 1; k < m; k++) out.push([cx + Math.cos(a1 + (delta * k) / m) * r, cy + Math.sin(a1 + (delta * k) / m) * r]);
    out.push(t2);
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Normalised geometry for a shape definition: parts centred on the bounding-box centre, polygons counter-clockwise.
 * Throws on a broken definition. (getShape() is the cached version for shapes by key.)
 * @returns {{ parts: ({type:'poly', pts:number[][]}|{type:'circle', cx:number, cy:number, r:number})[], visual: {pts:number[][]}[]|null, w:number, h:number, radius:number }}
 */
export function buildShape(def, key = '?') {
  if (!Array.isArray(def) || def.length === 0) throw new Error(`shape "${key}" has no parts`);
  const all = def.map((p) => {
    if (p.type === 'circle') {
      const r = p.diameter / 2;
      if (!(r > 0)) throw new Error(`bad diameter in shape "${key}"`);
      return { type: 'circle', cx: p.x ?? r, cy: p.y ?? r, r, cut: !!p.cut };
    }
    let pts = String(p.points ?? '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
    if (pts.length < 3 || pts.some((q) => q.length !== 2 || q.some((n) => !Number.isFinite(n)))) throw new Error(`bad points in shape "${key}"`);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    if (area < 0) pts = pts.reverse(); // counter-clockwise
    return { type: 'poly', pts, visual: !!p.visual, cut: !!p.cut };
  });
  const cutters = all.filter((p) => p.cut && !p.visual);
  const raw0 = all.filter((p) => !p.visual && !p.cut);
  const raw = raw0;
  const vis = all.filter((p) => p.visual);
  if (raw.length === 0) throw new Error(`shape "${key}" has only visual or cutting parts`);

  // The blocks are ROUNDED: the parts are joined in 2D (minus the `cut` parts), every corner gets an arc of tuning.round, and the collision is the
  // convex pieces of that rounded outline, so what you see is what bumps. The looks use a fine outline (64 sides per circle), the collision a coarser one
  // (every corner of the outline costs convex pieces). Shapes made of circles only stay as they are (they are round already).
  const R = roundOf();
  let visualFine = null;
  let boundsParts = raw; // (the bounding box, and so the middle of the block, is that of the shape before it was rounded: rounding never moves a block)
  if (cutters.length || (R > 0 && raw.some((p) => p.type === 'poly'))) {
    const outline = (n) => (p) => (p.type === 'circle' ? Array.from({ length: n }, (_, k) => [p.cx + Math.cos((k / n) * Math.PI * 2) * p.r, p.cy + Math.sin((k / n) * Math.PI * 2) * p.r]) : p.pts);
    const solve = (n) => (cutters.length ? differenceOutlines(raw.map(outline(n)), cutters.map(outline(n))) : unionOutlines(raw.map(outline(n))));
    const rounded = (regions) => (R > 0 ? regions.map((r) => ({ outer: roundOutline(r.outer, R), holes: r.holes.map((hl) => roundOutline(hl, R)) })) : regions);
    const fine = solve(64);
    if (!fine && cutters.length) throw new Error(`the cut removes the whole shape "${key}"`);
    if (fine) {
      const coarse = solve(24) ?? fine;
      const pieces = [];
      let ok = true;
      for (const r of rounded(coarse)) {
        const cp = convexPieces(r);
        if (!cp) { ok = false; break; }
        pieces.push(...cp);
      }
      if (!ok && cutters.length) throw new Error(`shape "${key}": the cut could not be split into convex pieces (try a simpler cut)`);
      if (ok) {
        boundsParts = coarse.map((r) => ({ type: 'poly', pts: r.outer }));
        raw.length = 0;
        raw.push(...pieces.map((pts) => ({ type: 'poly', pts })));
        visualFine = rounded(fine);
      }
    }
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of boundsParts) {
    if (p.type === 'circle') {
      x0 = Math.min(x0, p.cx - p.r); x1 = Math.max(x1, p.cx + p.r);
      y0 = Math.min(y0, p.cy - p.r); y1 = Math.max(y1, p.cy + p.r);
    } else {
      for (const [x, y] of p.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
  }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  let radius = 0;
  const parts = raw.map((p) => {
    if (p.type === 'circle') {
      radius = Math.max(radius, Math.hypot(p.cx - mx, p.cy - my) + p.r);
      return { type: 'circle', cx: p.cx - mx, cy: p.cy - my, r: p.r };
    }
    const pts = p.pts.map(([x, y]) => {
      radius = Math.max(radius, Math.hypot(x - mx, y - my));
      return [x - mx, y - my];
    });
    return { type: 'poly', pts };
  });
  const shiftPts = (pts) => pts.map(([x, y]) => [x - mx, y - my]);
  const visual = vis.length ? vis.map((p) => ({ pts: shiftPts(R > 0 ? roundOutline(p.pts, R) : p.pts), holes: [] }))
    : visualFine ? visualFine.map((r) => ({ pts: shiftPts(r.outer), holes: r.holes.map(shiftPts) })) : null;
  return { parts, visual, w: x1 - x0, h: y1 - y0, radius, ox: mx, oy: my };
}

/**
 * The union of several counter-clockwise polygons (convex parts, circles as many-sided polygons), as outlines for ONE extruded mesh.
 * Every edge is cut where other polygons' edges cross it, and a piece is kept when it lies on the outside of all the other polygons
 * (pieces shared by two touching parts cancel out). The kept pieces are chained into loops: solid on the left, so an outer outline is
 * counter-clockwise and a hole clockwise.
 * @param {number[][][]} polys
 * @returns {{outer:number[][], holes:number[][][]}[]|null}  null when something goes wrong (the caller then uses one mesh per part)
 */
export function unionOutlines(polys) {
  let size = 0;
  for (const p of polys) for (const [x, y] of p) size = Math.max(size, Math.abs(x), Math.abs(y));
  const eps = Math.max(1e-9, size * 1e-7);
  const key = ([x, y]) => `${Math.round(x / eps / 10)},${Math.round(y / eps / 10)}`;
  const onSeg = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) return false;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    if (t < -1e-9 || t > 1 + 1e-9) return false;
    return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < eps * 10;
  };
  const inside = (pt, poly) => { // strictly-inside test by crossing number (callers check the boundary first)
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const kept = [];
  polys.forEach((P, i) => {
    for (let e = 0; e < P.length; e++) {
      const a = P[e];
      const b = P[(e + 1) % P.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      if (L2 < eps * eps) continue;
      const ts = [0, 1];
      polys.forEach((Q, j) => {
        if (j === i) return;
        for (let f = 0; f < Q.length; f++) {
          const c = Q[f];
          const d = Q[(f + 1) % Q.length];
          if (onSeg(c, a, b)) ts.push(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / L2);
          const ex = d[0] - c[0], ey = d[1] - c[1];
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
          const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
        }
      });
      ts.sort((m, n) => m - n);
      for (let k = 0; k + 1 < ts.length; k++) {
        if (ts[k + 1] - ts[k] < 1e-9) continue;
        const p0 = [a[0] + dx * ts[k], a[1] + dy * ts[k]];
        const p1 = [a[0] + dx * ts[k + 1], a[1] + dy * ts[k + 1]];
        const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        let keep = true;
        for (let j = 0; j < polys.length && keep; j++) {
          if (j === i) continue;
          const Q = polys[j];
          let shared = null;
          for (let f = 0; f < Q.length; f++) {
            const c = Q[f];
            const d = Q[(f + 1) % Q.length];
            if (onSeg(mid, c, d)) { shared = [d[0] - c[0], d[1] - c[1]]; break; }
          }
          if (shared) { // lies along an edge of part j: the same direction = overlapping parts (keep one copy), opposite = they touch (both are inside)
            if (shared[0] * dx + shared[1] * dy < 0 || j < i) keep = false;
          } else if (inside(mid, Q)) keep = false;
        }
        if (keep) kept.push([p0, p1]);
      }
    }
  });
  return assembleRegions(kept, eps);
}

function pointInPoly(pt, poly) { // crossing-number test (callers check the boundary first)
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Parameters along the edge a→b where the edges of the loops `others` cross it or touch it (for cutting it into pieces). */
function edgeCuts(a, b, others, eps) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const ts = [0, 1];
  for (const Q of others) {
    for (let f = 0; f < Q.length; f++) {
      const c = Q[f];
      const d = Q[(f + 1) % Q.length];
      const tc = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / L2;
      if (tc > 0 && tc < 1 && Math.hypot(a[0] + dx * tc - c[0], a[1] + dy * tc - c[1]) < eps * 10) ts.push(tc);
      const ex = d[0] - c[0], ey = d[1] - c[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
      const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
  }
  return ts.sort((m, n) => m - n);
}

/** Is the point on an edge of one of the loops? Returns that edge's direction, or null. */
function edgeAt(pt, loops, eps) {
  for (const Q of loops) {
    for (let f = 0; f < Q.length; f++) {
      const c = Q[f];
      const d = Q[(f + 1) % Q.length];
      const dx = d[0] - c[0], dy = d[1] - c[1];
      const L2 = dx * dx + dy * dy;
      if (L2 === 0) continue;
      const t = ((pt[0] - c[0]) * dx + (pt[1] - c[1]) * dy) / L2;
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      if (Math.hypot(c[0] + dx * t - pt[0], c[1] + dy * t - pt[1]) < eps * 10) return [dx, dy];
    }
  }
  return null;
}

const inLoops = (pt, loops) => loops.reduce((odd, L) => (pointInPoly(pt, L) ? !odd : odd), false); // outlines and holes together: even-odd

/**
 * `solids` minus `cuts` (both lists of counter-clockwise polygons; each list is joined first). Same result format as unionOutlines.
 */
export function differenceOutlines(solids, cuts) {
  const A = unionOutlines(solids);
  if (!A) return null;
  if (!cuts.length) return A;
  const B = unionOutlines(cuts);
  if (!B) return A;
  const loopsA = A.flatMap((r) => [r.outer, ...r.holes]);
  const loopsB = B.flatMap((r) => [r.outer, ...r.holes]);
  let size = 0;
  for (const L of [...loopsA, ...loopsB]) for (const [x, y] of L) size = Math.max(size, Math.abs(x), Math.abs(y));
  const eps = Math.max(1e-9, size * 1e-7);
  const kept = [];
  const walk = (mine, other, rule) => {
    for (const L of mine) {
      for (let e = 0; e < L.length; e++) {
        const a = L[e];
        const b = L[(e + 1) % L.length];
        const ts = edgeCuts(a, b, other, eps);
        for (let k = 0; k + 1 < ts.length; k++) {
          if (ts[k + 1] - ts[k] < 1e-9) continue;
          const p0 = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
          const p1 = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
          const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
          const along = edgeAt(mid, other, eps);
          const out = rule(along, [b[0] - a[0], b[1] - a[1]], inLoops(mid, other));
          if (out === 1) kept.push([p0, p1]);
          else if (out === -1) kept.push([p1, p0]); // the edge of a cut becomes an edge of the result, walked the other way
        }
      }
    }
  };
  // a piece of the solid stays when it is outside every cut (or runs along a cut that only touches it from outside)
  walk(loopsA, loopsB, (along, dir, inside) => (along ? (along[0] * dir[0] + along[1] * dir[1] < 0 ? 1 : 0) : inside ? 0 : 1));
  // a piece of a cut stays (reversed) when it is inside the solid
  walk(loopsB, loopsA, (along, dir, inside) => (!along && inside ? -1 : 0));
  if (!kept.length) return null;
  return assembleRegions(kept, eps);
}

/** Is the polygon convex (counter-clockwise, collinear points allowed)? */
function convexLoop(pts, tol = 1e-9) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -tol) return false;
  }
  return true;
}

/**
 * Splits one region (an outline with holes) into convex polygons of at most `maxV` corners, for the collision of a shape with a cut.
 * Holes are joined to the outline by a bridge, the result is cut into triangles (ear clipping) and neighbouring triangles are merged
 * back together as long as they stay convex (Hertel-Mehlhorn). Returns null when it does not work out.
 */
export function convexPieces(region, maxV = 8) {
  const all = [region.outer, ...region.holes];
  let size = 0;
  for (const L of all) for (const [x, y] of L) size = Math.max(size, Math.abs(x), Math.abs(y));
  const eps = Math.max(1e-9, size * 1e-9);
  const same = (p, q) => Math.abs(p[0] - q[0]) < eps * 100 && Math.abs(p[1] - q[1]) < eps * 100;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const crosses = (p, q, r, t) => { // do p-q and r-t cross properly (not just touch at ends)?
    if (same(p, r) || same(p, t) || same(q, r) || same(q, t)) return false;
    const d1 = cross(p, q, r), d2 = cross(p, q, t), d3 = cross(r, t, p), d4 = cross(r, t, q);
    return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
  };
  // 1. bridges from the holes (right-most hole first) to the outline
  let poly = region.outer.map((p) => p.slice());
  const holes = region.holes.map((hl) => hl.map((p) => p.slice())).sort((m, n) => Math.max(...n.map((q) => q[0])) - Math.max(...m.map((q) => q[0])));
  for (const hole of holes) {
    let iM = 0;
    hole.forEach((q, i) => { if (q[0] > hole[iM][0]) iM = i; });
    const M = hole[iM];
    const order = poly.map((q, i) => i).sort((m, n) => Math.hypot(poly[m][0] - M[0], poly[m][1] - M[1]) - Math.hypot(poly[n][0] - M[0], poly[n][1] - M[1]));
    let found = -1;
    for (const iV of order) {
      const V = poly[iV];
      let ok = true;
      for (const L of [poly, ...holes]) {
        for (let f = 0; f < L.length && ok; f++) if (crosses(M, V, L[f], L[(f + 1) % L.length])) ok = false;
      }
      const mid = [(M[0] + V[0]) / 2, (M[1] + V[1]) / 2];
      if (ok && inLoops(mid, [region.outer, ...region.holes])) { found = iV; break; }
    }
    if (found < 0) return null;
    const V = poly[found];
    poly = [...poly.slice(0, found + 1), M, ...hole.slice(iM + 1), ...hole.slice(0, iM), M.slice(), V.slice(), ...poly.slice(found + 1)];
  }
  // 2. ear clipping
  const idx = poly.map((q, i) => i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 20000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = poly[idx[(k + idx.length - 1) % idx.length]], b = poly[idx[k]], c = poly[idx[(k + 1) % idx.length]];
      if (cross(a, b, c) <= eps) continue;
      let ear = true;
      for (const m of idx) {
        const q = poly[m];
        if (same(q, a) || same(q, b) || same(q, c)) continue;
        if (cross(a, b, q) >= -eps && cross(b, c, q) >= -eps && cross(c, a, q) >= -eps) { ear = false; break; }
      }
      if (!ear) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) { // only flat pieces are left: drop a collinear corner and go on
      const k = idx.findIndex((m, n) => Math.abs(cross(poly[idx[(n + idx.length - 1) % idx.length]], poly[m], poly[idx[(n + 1) % idx.length]])) <= eps);
      if (k < 0) return null;
      idx.splice(k, 1);
    }
  }
  if (idx.length === 3) {
    const [a, b, c] = idx.map((m) => poly[m]);
    if (cross(a, b, c) > eps) tris.push([a, b, c]);
  }
  if (!tris.length) return null;
  // 3. merge triangles back into convex pieces
  let pieces = tris;
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const P = pieces[i], Q = pieces[j];
        for (let ia = 0; ia < P.length; ia++) {
          const a = P[ia], b = P[(ia + 1) % P.length];
          const jb = Q.findIndex((q, n) => same(q, b) && same(Q[(n + 1) % Q.length], a));
          if (jb < 0) continue;
          const m = [];
          for (let n = 1; n <= P.length; n++) m.push(P[(ia + n) % P.length]); // b ... a
          for (let n = 2; n < Q.length; n++) m.push(Q[(jb + n) % Q.length]); // the corners of Q between a and b
          const clean = m.filter((q, n) => Math.abs(cross(m[(n + m.length - 1) % m.length], q, m[(n + 1) % m.length])) > eps);
          if (clean.length > maxV || clean.length < 3 || !convexLoop(clean, eps)) continue;
          pieces = pieces.filter((_, n) => n !== i && n !== j);
          pieces.push(clean);
          merged = true;
          break outer;
        }
      }
    }
  }
  return pieces;
}

/** Chains kept edge pieces (solid on their left) into closed loops: outer outlines counter-clockwise, holes clockwise, holes given to their outline. */
function assembleRegions(kept, eps) {
  const key = ([x, y]) => `${Math.round(x / eps / 10)},${Math.round(y / eps / 10)}`;
  const inside = pointInPoly;
  if (!kept.length) return null;
  const from = new Map();
  kept.forEach((sg, n) => {
    const k = key(sg[0]);
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(n);
  });
  const used = new Array(kept.length).fill(false);
  const loops = [];
  for (let n0 = 0; n0 < kept.length; n0++) {
    if (used[n0]) continue;
    const loop = [];
    let n = n0;
    for (let guard = 0; guard < kept.length + 2; guard++) {
      used[n] = true;
      loop.push(kept[n][0]);
      const endKey = key(kept[n][1]);
      if (endKey === key(kept[n0][0])) break;
      const cand = (from.get(endKey) ?? []).filter((m) => !used[m]);
      if (!cand.length) return null;
      let best = cand[0];
      if (cand.length > 1) { // a pinch point: take the rightmost turn so each lobe stays its own simple loop
        const ix = kept[n][1][0] - kept[n][0][0], iy = kept[n][1][1] - kept[n][0][1];
        let bestA = Infinity;
        for (const m of cand) {
          const ox = kept[m][1][0] - kept[m][0][0], oy = kept[m][1][1] - kept[m][0][1];
          const ang = Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy); // left turn > 0
          if (ang < bestA) { bestA = ang; best = m; }
        }
      }
      n = best;
      if (guard === kept.length + 1) return null;
    }
    if (key(kept[n][1]) !== key(kept[n0][0])) return null;
    // a loop that passes the same point twice (two parts touching at a corner) is cut into separate simple loops
    const stack = [];
    const seen = new Map();
    for (const pt of loop) {
      const k = key(pt);
      if (seen.has(k)) {
        const at = seen.get(k);
        const piece = stack.splice(at);
        for (const q of piece) seen.delete(key(q));
        loops.push(piece);
      }
      seen.set(k, stack.length);
      stack.push(pt);
    }
    if (stack.length) loops.push(stack);
  }
  const clean = loops.map((loop) => { // drop the corners that are only where two parts met on a straight line
    let pts = loop;
    for (let changed = true; changed && pts.length > 3;) {
      changed = false;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const dt = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
        if (Math.abs(cr) < 1e-9 * (1 + Math.abs(dt)) && dt > 0) { pts = pts.filter((_, m) => m !== i); changed = true; break; }
      }
    }
    return pts;
  });
  const area = (pts) => pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length]; return sum + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
  const outers = [];
  const holes = [];
  for (const pts of clean) {
    const A = area(pts);
    if (Math.abs(A) < eps * eps * 10 || pts.length < 3) continue;
    (A > 0 ? outers : holes).push(pts);
  }
  if (!outers.length) return null;
  const result = outers.map((outer) => ({ outer, holes: [] }));
  for (const hole of holes) {
    const owner = result.find((r) => inside(hole[0], r.outer) || hole.some((p) => inside(p, r.outer)));
    if (!owner) return null;
    owner.holes.push(hole);
  }
  return result;
}

export function getShape(key) {
  let s = cache.get(key);
  if (s) return s;
  if (!shapes[key]) throw new Error(`unknown shape "${key}"`);
  s = buildShape(shapes[key], key);
  cache.set(key, s);
  return s;
}

// ── Bowls and backgrounds ────────────────────────────────────────────────────────────────────────────────────
export const BOWL_DEFAULTS = {
  a: 18, b: 9, t: 1, rimY: 1, r: 4, zscale: 0.7, square: 5, squareBottom: 2, shader: 'bowlwood',
  water: { color: '#3d9bff', opacity: 0.4, reflect: 0.6, caustics: 0.9, causticsInset: 2 }, // caustics: the bright net of light on what is under the water (0 = none); causticsInset keeps it this far away from the walls (the bowl is narrower at the bottom). reflect: 0 = a plain pane, 1 = a mirror (the water mirrors the scenery)
};
/** Shadow settings. Global in `tuning.shadows`, and a background may override them with `light.shadows` (any of the fields).
 *   on          shadows at all        size   resolution of the shadow map (1024 - 8192)   range  width of the area the sun shades, world units
 *   softness    1 = crisp (3 texels wide edge), 2 = soft, 3 = softer     bias  depth offset in world units    normalBias  push along the surface, in texels */
export const SHADOW_DEFAULTS = { on: true, size: 4096, range: 170, softness: 1, bias: 0.12, normalBias: 1.5 };
export const shadowSettings = (light) => ({ ...SHADOW_DEFAULTS, ...(tuning.shadows ?? {}), ...(light?.shadows ?? {}) });
export const MAX_LIGHTS = 8; // point lights per background (the shaders have room for this many)
export const BLUR_CHOICES = ['none', 'light', 'heavy'];
export const BACKGROUND_DEFAULTS = {
  mist: '#e7e2d6',
  fog: [150, 520],
  ground: { colorA: '#cdc3a8', colorB: '#e6dec9', ripple: 2.2, style: 'sand', blur: 'light' },
  // The scenery is blurred in two strengths: `blur` (light) and `blurFar` (heavy), both in pixels. Every background model says which one it gets
  // (`blur: 'none' | 'light' | 'heavy'`, default light) and so does the floor (`ground.blur`). 0 for both = no blur at all.
  blur: 3,
  blurFar: 10,
  light: { dir: [-0.45, 0.85, 0.55], shadow: 0.55, time: 12 }, // where the light comes from (towards the light) and how dark its shadows are (0 = no shadows)
  bowlHeight: 4, // how high the bowl stands above the floor (= the thickness of the table)
  box: { w: 110, d: 52, z: 2, shader: 'floorwood' }, // the plain wooden table: width (x), depth (z), centre z, shader (unused when `table` is a model)
  models: [],
};

export const bowlKeyOf = (level) => (level?.bowl && bowls[level.bowl] ? level.bowl : Object.keys(bowls)[0]);
/** The world a level belongs to (the first world when it names none or an unknown one). */
export const worldKeyOf = (level) => (level?.world && worlds[level.world] ? level.world : Object.keys(worlds)[0]);
export const backgroundKeyOf = (level) => (level?.background && backgrounds[level.background] ? level.background : Object.keys(backgrounds)[0]);

/** The bowl of a level, with every missing field filled in. */
export function bowlOf(level) {
  const b = bowls[bowlKeyOf(level)] ?? {};
  return { ...BOWL_DEFAULTS, ...b, water: { ...BOWL_DEFAULTS.water, ...b.water } };
}

/** The background of a level, with every missing field filled in. */
export function backgroundOf(level) {
  const b = backgrounds[backgroundKeyOf(level)] ?? {};
  return { ...BACKGROUND_DEFAULTS, ...b, ground: { ...BACKGROUND_DEFAULTS.ground, ...b.ground }, light: { ...BACKGROUND_DEFAULTS.light, ...b.light }, box: { ...BACKGROUND_DEFAULTS.box, ...b.box }, models: b.models ?? [], lights: b.lights ?? [] };
}

/** Height of the table top = the outside of the bottom of the bowl. The waiting blocks lie on it. */
export const groundYOf = (bowl) => bowl.rimY - bowl.b - bowl.t;

/**
 * Outline of the bowl: a flat bottom with rounded corners, as inner and outer point lists (left rim to right rim).
 * Corner = a quarter ellipse (horizontal radius r, vertical radius b) so the walls leave the rim straight down and run into the
 * flat bottom smoothly. The point in the middle (index n / 2) is always on the centre line.
 * The server turns each pair of neighbouring points into a convex collision quad; the client turns the same ring into a 3D bowl.
 */
export function bowlProfile(n = 36, bowl = bowlOf(null)) {
  const { a, b, t, rimY } = bowl;
  const r = Math.min(Math.max(bowl.r, 0.05), a - 0.05);
  const f = a - r; // half the width of the flat bottom
  const s = Math.max(1, Math.round(n / 9)); // segments on each half of the flat bottom
  const k = n / 2 - s; //                    segments on each corner
  const inner = [];
  const outer = [];
  const add = (x, y, ox, oy) => { inner.push([x, y]); outer.push([ox, oy]); };
  const corner = (side, phi) => { // phi: 0 = bottom end of the corner, PI/2 = rim end
    const sx = Math.sin(phi);
    const cy = Math.cos(phi);
    add(side * (f + r * sx), rimY - b * cy, side * (f + (r + t) * sx), rimY - (b + t) * cy);
  };
  for (let i = 0; i <= k; i++) corner(-1, (Math.PI / 2) * (1 - i / k));
  for (let i = 1; i < 2 * s; i++) {
    const x = -f + (2 * f * i) / (2 * s);
    add(x, rimY - b, x, rimY - b - t);
  }
  for (let i = 0; i <= k; i++) corner(1, (Math.PI / 2) * (i / k));
  return { inner, outer };
}

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Sideways limits and drop zone for a level. */
export const zoneOf = (level) => level.zone ?? ZONE;
export const dropOf = (level) => level.drop ?? DROP;
export const inDrop = (level, x, y) => {
  const d = dropOf(level);
  return x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1;
};

/** Where waiting block number i of n lies on the table (centre), unrotated. groundY = groundYOf(bowl of the level). */
export function slotPos(i, n, shapeKey, groundY) {
  return { x: (i - (n - 1) / 2) * SLOT_GAP, y: groundY + getShape(shapeKey).h / 2 };
}

// ── Wire constants (server and client agree on these) ─────────────────────────────────────────────────────
export const PHASE = { MENU: 0, PLAY: 1, WON: 2, LOST: 3 };
/** Per-body state in snapshots. HELD_BAD = held, but outside the drop zone (letting go sends it back to the table). */
export const BODY = { NORMAL: 0, HELD: 1, HELD_BAD: 2, STATIC: 3 };
/** Why a level was lost. */
export const LOSE = { WATER: 1, OUT: 2, BOWL: 3, HAZARD: 4 };
export const LOSE_TEXT = {
  [LOSE.WATER]: 'A block fell into the water.',
  [LOSE.OUT]: 'A block fell out of the play area.',
  [LOSE.BOWL]: 'A block hit the bowl.',
  [LOSE.HAZARD]: 'A block touched the water block.',
};

// ── Definitions: copy, replace, check, export ────────────────────────────────────────────────────────────────
const TABLES = ['tuning', 'materials', 'shapes', 'shapeCategories', 'shaderCode', 'bowls', 'models', 'backgrounds', 'worlds', 'levels'];
export const DEFINITION_TABLES = TABLES;
const live = { tuning, materials, shapes, shapeCategories, shaderCode, bowls, models, backgrounds, worlds, levels };

/** A deep copy of all definitions (plain JSON data). */
export function cloneDefinitions() {
  return JSON.parse(JSON.stringify(live));
}

/** Replace the live definitions IN PLACE (every module keeps working with the same objects) and recompute what is derived from them. */
export function applyDefinitions(next, owner = null) {
  const copy = JSON.parse(JSON.stringify(next));
  for (const name of TABLES) {
    if (copy[name] === undefined) continue;
    const target = live[name];
    if (Array.isArray(target)) {
      target.length = 0;
      target.push(...copy[name]);
    } else {
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, copy[name]);
    }
  }
  syncDefinitions();
  if (owner && typeof owner === 'object') { // (the server passes the room's own definitions: what was built from them before is still valid)
    cache = caches.get(owner) ?? new Map();
    caches.set(owner, cache);
  }
}

function shadowErrors(s, where, err) {
  if (typeof s !== 'object' || !s) return err(`${where} must be an object`);
  if (s.on !== undefined && typeof s.on !== 'boolean') err(`${where}.on must be true or false`);
  if (s.size !== undefined && ![1024, 2048, 4096, 8192].includes(s.size)) err(`${where}.size must be 1024, 2048, 4096 or 8192`);
  if (s.range !== undefined && !(isNum(s.range) && s.range >= 20 && s.range <= 600)) err(`${where}.range must be from 20 to 600`);
  if (s.softness !== undefined && ![1, 2, 3].includes(s.softness)) err(`${where}.softness must be 1, 2 or 3`);
  if (s.bias !== undefined && !(isNum(s.bias) && s.bias >= 0 && s.bias <= 5)) err(`${where}.bias must be from 0 to 5`);
  if (s.normalBias !== undefined && !(isNum(s.normalBias) && s.normalBias >= 0 && s.normalBias <= 8)) err(`${where}.normalBias must be from 0 to 8`);
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

function polyConvex(pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) continue;
    if (sign && Math.sign(cr) !== sign) return false;
    sign = Math.sign(cr);
  }
  return true;
}

/**
 * Check a set of definitions. Returns a list of problems (empty = fine). Pass `{ shaderNames }` (the client knows them) to also
 * check shader names.
 */
export function validateDefinitions(defs, extra = {}) {
  const errs = [];
  const err = (m) => errs.push(m);
  const d = defs;
  const shaderOk = (name, where) => {
    if (typeof name !== 'string' || !name) err(`${where}: no shader`);
    else if (extra.shaderNames && !extra.shaderNames.includes(name)) err(`${where}: unknown shader "${name}"`);
  };
  const rect = (r, where, keys) => {
    if (typeof r !== 'object' || r === null) return err(`${where}: not an object`);
    for (const k of keys) if (!isNum(r[k])) err(`${where}.${k}: not a number`);
  };

  // tuning
  const t = d.tuning ?? {};
  for (const k of ['gravity', 'waterDensity', 'follow', 'depth', 'frontZ', 'hoverZ', 'slotGap', 'maxHoldX', 'maxHoldY', 'minHoldY']) {
    if (!isNum(t[k])) err(`tuning.${k}: not a number`);
  }
  if (t.mergeParts !== undefined && typeof t.mergeParts !== 'boolean') err('tuning.mergeParts must be true or false');
  if (t.countdown !== undefined && !(isNum(t.countdown) && t.countdown >= 0.5 && t.countdown <= 60)) err('tuning.countdown must be from 0.5 to 60 seconds');
  if (isNum(t.gravity) && t.gravity <= 0) err('tuning.gravity must be above 0');
  if (isNum(t.depth) && t.depth < 0.3) err('tuning.depth must be at least 0.3');
  for (const k of ['round', 'chamfer']) if (t[k] !== undefined && !isNum(t[k])) err(`tuning.${k} must be a number`); // (chamfer = the old name of round)
  if (isNum(t.round) && isNum(t.depth) && (t.round < 0 || t.round > t.depth / 2 - 0.02)) err('tuning.round must be between 0 and half the depth');
  if (isNum(t.chamfer) && isNum(t.depth) && (t.chamfer < 0 || t.chamfer > t.depth / 2 - 0.02)) err('tuning.chamfer must be between 0 and half the depth');
  rect(t.zone, 'tuning.zone', ['x0', 'x1']);
  rect(t.drop, 'tuning.drop', ['x0', 'x1', 'y0', 'y1']);
  rect(t.view, 'tuning.view', ['w', 'h', 'cy']);
  if (t.shadows !== undefined) shadowErrors(t.shadows, 'tuning.shadows', err);
  rect(t.camera, 'tuning.camera', ['fov', 'pitch', 'targetY']);
  if (isNum(t.camera?.fov) && (t.camera.fov < 5 || t.camera.fov > 100)) err('tuning.camera.fov must be between 5 and 100');
  if (isNum(t.camera?.pitch) && (t.camera.pitch < 0 || t.camera.pitch > 85)) err('tuning.camera.pitch must be between 0 and 85');

  // materials
  const mats = d.materials ?? {};
  if (Object.keys(mats).length === 0) err('there must be at least one material');
  for (const [k, m] of Object.entries(mats)) {
    if (!isNum(m.friction ?? 10)) err(`material ${k}: friction is not a number`);
    if (!isNum(m.weight ?? 10)) err(`material ${k}: weight is not a number`);
    if (m.floatLevel !== undefined && !(m.floatLevel > 0 && m.floatLevel <= 1)) err(`material ${k}: floatLevel must be above 0 and at most 1`);
    if (m.stackLimit !== undefined && !(Number.isInteger(m.stackLimit) && m.stackLimit >= 0 && m.stackLimit <= 20)) err(`material ${k}: stackLimit must be a whole number from 0 to 20`);
    if (m.explodesWith && !mats[m.explodesWith]) err(`material ${k}: explodesWith "${m.explodesWith}" is not a material`);
    shaderOk(m.shader, `material ${k}`);
  }

  // shapes
  const shp = d.shapes ?? {};
  if (Object.keys(shp).length === 0) err('there must be at least one shape');
  for (const [k, def] of Object.entries(shp)) {
    try {
      const s = buildShape(def, k);
      for (const p of s.parts) if (p.type === 'poly' && !polyConvex(p.pts)) err(`shape ${k}: a physics part is not convex (split it into several parts, or mark the outline 'visual')`);
      if (!(s.w > 0 && s.h > 0)) err(`shape ${k}: has no size`);
    } catch (e) {
      err(String(e.message));
    }
  }

  // bowls
  const bw = d.bowls ?? {};
  if (Object.keys(bw).length === 0) err('there must be at least one bowl');
  for (const [k, b] of Object.entries(bw)) {
    for (const f of ['a', 'b', 't', 'rimY', 'r', 'zscale']) if (!isNum(b[f])) err(`bowl ${k}: ${f} is not a number`);
    if (isNum(b.a) && b.a < 6) err(`bowl ${k}: a must be at least 6`);
    if (isNum(b.b) && b.b < 2) err(`bowl ${k}: b must be at least 2`);
    if (isNum(b.t) && b.t < 0.2) err(`bowl ${k}: t must be at least 0.2`);
    if (isNum(b.r) && isNum(b.a) && (b.r <= 0 || b.r > b.a - 0.05)) err(`bowl ${k}: r must be above 0 and at most a`);
    if (isNum(b.zscale) && b.zscale <= 0.1) err(`bowl ${k}: zscale must be above 0.1`);
    for (const f of ['square', 'squareBottom']) if (b[f] !== undefined && (!isNum(b[f]) || b[f] < 2)) err(`bowl ${k}: ${f} must be 2 or more`);
    if (b.water?.causticsInset !== undefined && !(isNum(b.water.causticsInset) && b.water.causticsInset >= 0)) err(`bowl ${k}: water.causticsInset must be 0 or more`);
    if (b.water?.caustics !== undefined && !(isNum(b.water.caustics) && b.water.caustics >= 0 && b.water.caustics <= 2)) err(`bowl ${k}: water.caustics must be from 0 to 2`);
    if (b.water?.reflect !== undefined && !(isNum(b.water.reflect) && b.water.reflect >= 0 && b.water.reflect <= 1)) err(`bowl ${k}: water.reflect must be from 0 to 1`);
    shaderOk(b.shader ?? BOWL_DEFAULTS.shader, `bowl ${k}`);
    if (b.model) {
      if (!d.models?.[b.model.model]) err(`bowl ${k}: unknown model "${b.model.model}"`);
      if (!isNum(b.model.scale)) err(`bowl ${k}: model scale is not a number`);
    }
  }

  // models
  for (const [k, m] of Object.entries(d.models ?? {})) {
    if (typeof m.file !== 'string' || !/^[\w\- .]+\.obj$/i.test(m.file)) err(`model ${k}: file must be the name of an .obj file`);
    if (m.shader !== undefined) shaderOk(m.shader, `model ${k}`);
    for (const [part, sh] of Object.entries(m.shaders ?? {})) shaderOk(sh, `model ${k}, part ${part}`);
  }

  // backgrounds
  const bgs = d.backgrounds ?? {};
  if (Object.keys(bgs).length === 0) err('there must be at least one background');
  for (const [k, b] of Object.entries(bgs)) {
    if (typeof b.mist !== 'string') err(`background ${k}: mist must be a colour`);
    if (b.blur !== undefined && !(isNum(b.blur) && b.blur >= 0 && b.blur <= 30)) err(`background ${k}: blur must be a number from 0 to 30`);
    if (b.blurFar !== undefined && !(isNum(b.blurFar) && b.blurFar >= 0 && b.blurFar <= 40)) err(`background ${k}: blurFar must be a number from 0 to 40`);
    if (b.ground?.blur !== undefined && !BLUR_CHOICES.includes(b.ground.blur)) err(`background ${k}: ground.blur must be none, light or heavy`);
    if (b.light !== undefined) {
      if (b.light.dir !== undefined && !isVec3(b.light.dir)) err(`background ${k}: light.dir needs 3 numbers`);
      if (b.light.time !== undefined && !(isNum(b.light.time) && b.light.time >= 0 && b.light.time <= 24)) err(`background ${k}: light.time (hour of the day) must be from 0 to 24`);
      if (b.light.shadow !== undefined && !(isNum(b.light.shadow) && b.light.shadow >= 0 && b.light.shadow <= 1)) err(`background ${k}: light.shadow must be from 0 to 1`);
    }
    if (b.ground?.style !== undefined && !['sand', 'wood', 'none'].includes(b.ground.style)) err(`background ${k}: ground.style must be sand, wood or none`);
    if (b.light?.shadows !== undefined) shadowErrors(b.light.shadows, `background ${k}: light.shadows`, err);
    if (b.lights !== undefined) {
      if (!Array.isArray(b.lights)) err(`background ${k}: lights must be a list`);
      else {
        if (b.lights.length > MAX_LIGHTS) err(`background ${k}: at most ${MAX_LIGHTS} lights`);
        b.lights.forEach((l, i) => {
          if (typeof l.color !== 'string') err(`background ${k}, light #${i + 1}: color is missing`);
          if (!(isNum(l.intensity) && l.intensity >= 0 && l.intensity <= 20)) err(`background ${k}, light #${i + 1}: intensity must be from 0 to 20`);
          if (!(isNum(l.range) && l.range > 0)) err(`background ${k}, light #${i + 1}: range must be above 0`);
          if (!isVec3(l.translate)) err(`background ${k}, light #${i + 1}: translate needs 3 numbers`);
        });
      }
    }
    if (b.box !== undefined) {
      for (const f of ['w', 'd']) if (b.box[f] !== undefined && !(isNum(b.box[f]) && b.box[f] >= 10 && b.box[f] <= 1000)) err(`background ${k}: box.${f} must be a number from 10 to 1000`);
      if (b.box.z !== undefined && !isNum(b.box.z)) err(`background ${k}: box.z must be a number`);
      if (b.box.shader !== undefined) shaderOk(b.box.shader, `background ${k}, table box`);
    }
    if (b.bowlHeight !== undefined && !(isNum(b.bowlHeight) && b.bowlHeight >= 0 && b.bowlHeight <= 100)) err(`background ${k}: bowlHeight must be a number from 0 to 100`);
    if (b.table) {
      const m = b.table;
      if (!d.models?.[m.model]) err(`background ${k}, table: unknown model "${m.model}"`);
      if (!isNum(m.scale) || m.scale <= 0) err(`background ${k}, table: scale must be above 0`);
      if (!isVec3(m.rotation)) err(`background ${k}, table: rotation needs 3 numbers`);
      if (!isVec3(m.translate)) err(`background ${k}, table: translate needs 3 numbers`);
    }
    (b.models ?? []).forEach((m, i) => {
      if (!d.models?.[m.model]) err(`background ${k}, model #${i + 1}: unknown model "${m.model}"`);
      if (!isNum(m.scale) || m.scale <= 0) err(`background ${k}, model #${i + 1}: scale must be above 0`);
      if (!isVec3(m.rotation)) err(`background ${k}, model #${i + 1}: rotation needs 3 numbers`);
      if (!isVec3(m.translate)) err(`background ${k}, model #${i + 1}: translate needs 3 numbers`);
      if (m.blur !== undefined && !BLUR_CHOICES.includes(m.blur)) err(`background ${k}, model #${i + 1}: blur must be none, light or heavy`);
    });
  }

  // shaders of the shader studio
  for (const [k, e] of Object.entries(d.shaderCode ?? {})) {
    if (!/^[A-Za-z][\w-]{0,39}$/.test(k)) err(`shader "${k}": the name starts with a letter and has at most 40 letters, digits, - or _`);
    else if (!e || typeof e.code !== 'string' || !e.code.trim()) err(`shader ${k}: it has no code`);
    else if (e.code.length > 40000) err(`shader ${k}: the code is too long (40000 characters at most)`);
    else if (e.type !== undefined && !['opaque', 'transparent', 'refract'].includes(e.type)) err(`shader ${k}: type must be opaque, transparent or refract`);
  }

  // shape categories
  for (const [k, c] of Object.entries(d.shapeCategories ?? {})) {
    if (!shp[k]) err(`shape category: there is no shape called "${k}"`);
    else if (typeof c !== 'string' || !c.trim() || c.length > 40) err(`shape ${k}: the category must be a name of 1 to 40 characters`);
  }

  // worlds
  const wds = d.worlds ?? {};
  if (Object.keys(wds).length === 0) err('there must be at least one world');
  for (const [k, w] of Object.entries(wds)) if (typeof w?.name !== 'string' || !w.name) err(`world ${k}: needs a name`);

  // levels
  const lvs = d.levels ?? [];
  if (lvs.length === 0) err('there must be at least one level');
  lvs.forEach((l, i) => {
    const w = `level ${i + 1} (${l.name})`;
    if (typeof l.name !== 'string' || !l.name) err(`${w}: needs a name`);
    if (!['easy', 'medium', 'hard'].includes(l.difficulty)) err(`${w}: difficulty must be easy, medium or hard`);
    if (l.time !== undefined && !(isNum(l.time) && l.time >= 0 && l.time <= 24)) err(`${w}: time (hour of the day, optional: overrides the background) must be from 0 to 24`);
    if (l.world !== undefined && !wds[l.world]) err(`${w}: unknown world "${l.world}"`);
    if (l.bowl !== undefined && !bw[l.bowl]) err(`${w}: unknown bowl "${l.bowl}"`);
    if (l.background !== undefined && !bgs[l.background]) err(`${w}: unknown background "${l.background}"`);
    if (!Number.isInteger(l.chooseShapes) || l.chooseShapes < 1) err(`${w}: chooseShapes must be a whole number of at least 1`);
    if (!Array.isArray(l.shapes) || l.shapes.length === 0) err(`${w}: needs at least one block to place`);
    for (const s of l.shapes ?? []) {
      if (!shp[s.shape]) err(`${w}: unknown shape "${s.shape}"`);
      if (!mats[s.material]) err(`${w}: unknown material "${s.material}"`);
    }
    for (const b of l.initialBlocks ?? []) {
      if (!shp[b.shape]) err(`${w}: unknown shape "${b.shape}" in the start blocks`);
      if (!mats[b.material]) err(`${w}: unknown material "${b.material}" in the start blocks`);
      if (!isNum(b.x) || !isNum(b.y) || !isNum(b.rot ?? 0)) err(`${w}: a start block has a position that is not a number`);
    }
    if (l.zone) rect(l.zone, `${w} zone`, ['x0', 'x1']);
    if (l.drop) rect(l.drop, `${w} drop`, ['x0', 'x1', 'y0', 'y1']);
  });
  return errs;
}

// ── Export: definitions as JavaScript source ─────────────────────────────────────────────────────────────────
const IDENT = /^[A-Za-z_$][\w$]*$/;
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** A value as JavaScript source: short things on one line, long ones spread out. */
export function toSource(v, indent = '', width = 118) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const isArr = Array.isArray(v);
  const items = isArr ? v.map((x) => toSource(x, `${indent}  `, width)) : Object.entries(v).map(([k, x]) => `${IDENT.test(k) ? k : quote(k)}: ${toSource(x, `${indent}  `, width)}`);
  if (items.length === 0) return isArr ? '[]' : '{}';
  const open = isArr ? '[' : '{';
  const close = isArr ? ']' : '}';
  const inline = isArr ? `[${items.join(', ')}]` : `{ ${items.join(', ')} }`;
  if (!inline.includes('\n') && indent.length + inline.length <= width) return inline;
  return `${open}\n${items.map((i) => `${indent}  ${i},`).join('\n')}\n${indent}${close}`;
}

/** `export const name = ...;` for one table. */
export function serializeTable(name, value) {
  return `export const ${name} = ${toSource(value)};\n`;
}

/** The header comment of _levels.js (what a level is made of). */
const LEVELS_HEAD = [
  '// Runs on BOTH server and browser. Pure data: the LEVELS of Balance. _definitions.js re-exports them, so nothing else changes.',
  '//',
  '// The levels are grouped by world: the order of the worlds and of the levels in them is the order of the menu.',
  '//   export const levels = { worldKey: { name: \'World name\', levels: [ { ...level }, ... ] }, ... }',
  '//',
  '// With `DEBUG = true` the level studio edits this file for you, but only when you press "Add level" (a new level is added at the end of its world),',
  '// "Update level" (an existing level is replaced) or "Save order" (the level order menu) and confirm it: the game server then rewrites THIS file',
  '// (comments are not kept) and every room gets the change. That needs write permission for the file:',
  '//   deno.json:  --allow-write=games/balance/_levels.js,games/balance/_shapes.js     (on the "start" and "dev" tasks)',
  '// (`deno task dev` watches the files and restarts the server after every save: use `deno task start` while you edit levels.)',
  '//',
  '// name, difficulty     shown in the menu (easy | medium | hard)',
  '// bowl, background     keys of `bowls` / `backgrounds` (the first one of each when left out)',
  '// time                 optional hour of the day (0-24): overrides the background',
  '// initialBlocks        present from the start: { shape, material, rot (degrees), x, y }  (x,y = centre, y=0 is the water surface)',
  "//                      'static' material = fixed to the world. Anything else is a normal physics body.",
  '// chooseShapes         how many blocks lie on the table at once = how many can be held at the same time (4 = all four players)',
  '// shapes               the ordered list of blocks you must place: { shape, material }. Rotate with Q / E while holding.',
  '// zone (optional)      { x0, x1 }: sideways limits (default tuning.zone). Leaving it, or touching the water/bowl, loses the level.',
  '// drop (optional)      { x0, x1, y0, y1 }: the drop zone rectangle (default tuning.drop)',
  '',
].join('\n');

/** The header comment of _shapes.js. */
const SHAPES_HEAD = [
  '// Runs on BOTH server and browser. Pure data: the SHAPES of Balance. _definitions.js re-exports them, so nothing else changes.',
  '//',
  '// With `DEBUG = true` the shape studio edits this file for you, but only when you press "Add shape" or "Update shape" and confirm it:',
  '// the game server then rewrites THIS file (comments are not kept) and every room gets the change. That needs write permission:',
  '//   deno.json:  --allow-write=games/balance/_levels.js,games/balance/_shapes.js     (on the "start" and "dev" tasks)',
  '//',
  '// A shape is a list of parts. Part types:',
  "//   { type: 'poly',   points: 'x,y x,y x,y ...' }   a CONVEX polygon (build concave shapes from several parts, like plus1)",
  "//   { type: 'circle', diameter: d, x?, y? }          x/y = centre, default (d/2, d/2)",
  '//   add `visual: true` to a poly to make it a drawing-only outline (it replaces the parts when the block is drawn)',
  '// Origin and orientation do not matter: every shape is re-centred on the middle of its bounding box when it is used.',
  '// The ORDER matters a little: snapshots refer to shapes by their place in this file (category by category), so new shapes are added at the end of their category.',
  '//',
  '// The shapes are grouped by category: the shape selects show the shapes under these names, in this order.',
  "//   export const shapes = { Tetris: { B: [ ...parts ], ... }, Basic: { ... }, Other: { ... } }",
  '',
].join('\n');

/** The header comment of _shaders.js. */
const SHADERS_HEAD = [
  '// Runs on BOTH server and browser. Pure data: ALL the SHADERS of the game (edit them in the shader studio of the debug menu). _definitions.js re-exports them.',
  '//',
  "//   export const shaderCode = { name: { type?: 'opaque' | 'transparent' | 'refract', code: `...GLSL...` }, ... }",
  '//',
  '// EVERY shader of the game is here (shaders.js only has the common part that all of them start with). The name is what materials, bowls, models and backgrounds',
  '// pick; a new name is a new shader.',
  '// `code` is what comes after the common part of every shader (the varyings, uniforms, noise functions, lighting and finish(): see shaders.js);',
  '// it has to define main() and end by setting gl_FragColor, usually with finish(colour, 1.0).',
  '// type: opaque (default) = a normal solid surface, transparent = drawn after the solid things without depth writes,',
  '//       refract = transparent AND it bends the picture behind it (needs the REFRACT_GLSL part: copy a glass shader to start).',
  '//',
  '// With `DEBUG = true` the shader studio writes this file for you when you press "Save shader" and confirm it (comments are not kept).',
  '// That needs write permission:',
  '//   deno.json:  --allow-write=games/balance/_levels.js,games/balance/_shapes.js,games/balance/_shaders.js     (on the "start" and "dev" tasks)',
  '',
].join('\n');

/** The whole _shaders.js file for the table of shaders (the code goes in template literals so it stays readable). */
export function serializeShaders(table) {
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const items = Object.entries(table ?? {}).map(([k, e]) => `  ${IDENT.test(k) ? k : quote(k)}: {\n${e.type ? `    type: '${e.type}',\n` : ''}    code: \`${esc(e.code)}\`,\n  },`);
  return `${SHADERS_HEAD}\nexport const shaderCode = {${items.length ? `\n${items.join('\n')}\n` : ''}};\n`;
}

/** The flat table of shapes as _shapes.js holds it: { Category: { shapeKey: [parts] } }. (Categories in order of first appearance, 'Other' last.) */
export function nestShapes(table, categories = {}) {
  const out = {};
  for (const [c, keys] of shapeGroups(Object.keys(table), categories)) out[c] = Object.fromEntries(keys.map((k) => [k, table[k]]));
  return out;
}

/** The whole _shapes.js file for a table of shapes and the table of their categories. */
export function serializeShapes(table, categories = {}) {
  return `${SHAPES_HEAD}\n${serializeTable('shapes', nestShapes(table, categories))}`;
}

/** The flat list of levels in menu order: the worlds in the order of the table of worlds, the levels of a world in the order they have in the list. */
export function orderLevels(list, worldTable) {
  const keys = Object.keys(worldTable);
  const rank = (lv) => Math.max(0, keys.indexOf(lv.world));
  return list.map((lv, i) => [lv, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([lv]) => lv);
}

/** The flat list of levels as _levels.js holds it: { worldKey: { name, levels: [...] } }. (A level without a known world goes to the first world.) */
export function nestLevels(list, worldTable) {
  const keys = Object.keys(worldTable);
  const out = Object.fromEntries(keys.map((k) => [k, { ...worldTable[k], levels: [] }]));
  for (const lv of list) {
    const { world, ...rest } = lv;
    out[keys.includes(world) ? world : keys[0]].levels.push(rest);
  }
  return out;
}

/** The whole _levels.js file for a flat list of levels (each knows its world) and the table of worlds. */
export function serializeLevels(list, worldTable) {
  return `${LEVELS_HEAD}\n${serializeTable('levels', nestLevels(list, worldTable))}`;
}

/** The whole _definitions.js file for the given definitions (the levels are written to _levels.js, see serializeLevels). */
export function serializeDefinitions(defs) {
  const head = [
    '// Runs on BOTH server and browser. Pure data, no code: everything that defines the CONTENT of Balance lives in this file.',
    `// Exported from the debug menu on ${new Date().toISOString().slice(0, 10)}. Reference of every field: see the comments in shared.js and the debug menu.`,
    '//',
    '//   tuning        numbers you can play with (gravity, camera, block depth ...)',
    '//   materials     friction, weight and shader of a block',
    '//   shapes        (in their own file, _shapes.js)',
    '//   bowls         the bowls the tower is built in',
    '//   models        .obj files in ./models and the shader of each part',
    '//   backgrounds   the scenery around the table',
    '//   levels        (in their own file, _levels.js, grouped in worlds)',
    '',
  ];
  const tables = TABLES.filter((n) => n !== 'levels' && n !== 'worlds' && n !== 'shapes' && n !== 'shapeCategories' && n !== 'shaderCode').map((n) => serializeTable(n, defs[n])).join('\n');
  return `${head.join('\n')}\n${tables}\n// ── Shapes: in ./_shapes.js, levels: in ./_levels.js (the studios rewrite those files when you press Add / Update) ──\nexport { shapes } from './_shapes.js';\nexport { shaderCode } from './_shaders.js';\nexport { levels } from './_levels.js';\n`;
}

syncDefinitions();

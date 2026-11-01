// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.
//
// The game CONTENT (materials, shapes, bowls, models, backgrounds, levels, tuning) is plain data in ./definitions.js.
// This file is the logic around it: helpers, wire constants, validation, and the code the debug menu uses to edit and export it.

import { backgrounds, bowls, levels, materials, models, shapes, tuning } from './definitions.js';
export { backgrounds, bowls, levels, materials, models, shapes, tuning };

/**
 * Debug menu switch. true = the in-game debug menu is available (the ` key or the button at the bottom left) and the server
 * accepts definition changes from the players. Leave it false for a real game: anybody in the room could change the rules.
 */
export const DEBUG = true;

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
//   HOVER_Z   ← a block you hold floats here, in front of everything (the drop zone is invisible, only the red tint tells you)
//   FRONT_Z   ← blocks waiting on the table
//   PLAY_Z    ← the tower, the pillars and the bowl: this is where the physics happens
//
// The values below come from `tuning` in definitions.js. They are `let` on purpose: when the debug menu changes the tuning,
// syncDefinitions() reassigns them and every module that imported them sees the new value.
export const WATER_Y = 0;
export const PLAY_Z = 0;
export let GRAVITY = 30;
export let WATER_DENSITY = 1;
export let DEPTH = 2.4;
export let FRONT_Z = 17;
export let HOVER_Z = 4.5;
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

const cache = new Map();

/** Recompute everything derived from the definitions. Called once on load and after every change to them. */
export function syncDefinitions() {
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const t = tuning;
  GRAVITY = num(t.gravity, 30);
  WATER_DENSITY = num(t.waterDensity, 1);
  DEPTH = num(t.depth, 2.4);
  FRONT_Z = num(t.frontZ, 17);
  HOVER_Z = num(t.hoverZ, 4.5);
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
      return { type: 'circle', cx: p.x ?? r, cy: p.y ?? r, r };
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
    return { type: 'poly', pts, visual: !!p.visual };
  });
  const raw = all.filter((p) => !p.visual);
  const vis = all.filter((p) => p.visual);
  if (raw.length === 0) throw new Error(`shape "${key}" has only visual parts`);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of raw) {
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
  const visual = vis.length ? vis.map((p) => ({ pts: p.pts.map(([x, y]) => [x - mx, y - my]) })) : null;
  return { parts, visual, w: x1 - x0, h: y1 - y0, radius };
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
  water: { color: '#3d9bff', opacity: 0.4, reflect: 0.6 }, // reflect: 0 = a plain pane, 1 = a mirror (the water mirrors the scenery)
};
export const BACKGROUND_DEFAULTS = {
  mist: '#e7e2d6',
  fog: [150, 520],
  ground: { colorA: '#cdc3a8', colorB: '#e6dec9', ripple: 2.2, style: 'sand' },
  blur: 3, //          how much the scenery behind the table is blurred (pixels, 0 = sharp)
  light: { dir: [-0.45, 0.85, 0.55], shadow: 0.4 }, // where the light comes from (towards the light) and how dark its shadows are (0 = no shadows)
  bowlHeight: 4, // how high the bowl stands above the floor (= the thickness of the table)
  box: { w: 110, d: 52, z: 2, shader: 'floorwood' }, // the plain wooden table: width (x), depth (z), centre z, shader (unused when `table` is a model)
  models: [],
};

export const bowlKeyOf = (level) => (level?.bowl && bowls[level.bowl] ? level.bowl : Object.keys(bowls)[0]);
export const backgroundKeyOf = (level) => (level?.background && backgrounds[level.background] ? level.background : Object.keys(backgrounds)[0]);

/** The bowl of a level, with every missing field filled in. */
export function bowlOf(level) {
  const b = bowls[bowlKeyOf(level)] ?? {};
  return { ...BOWL_DEFAULTS, ...b, water: { ...BOWL_DEFAULTS.water, ...b.water } };
}

/** The background of a level, with every missing field filled in. */
export function backgroundOf(level) {
  const b = backgrounds[backgroundKeyOf(level)] ?? {};
  return { ...BACKGROUND_DEFAULTS, ...b, ground: { ...BACKGROUND_DEFAULTS.ground, ...b.ground }, light: { ...BACKGROUND_DEFAULTS.light, ...b.light }, box: { ...BACKGROUND_DEFAULTS.box, ...b.box }, models: b.models ?? [] };
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
export const LOSE = { WATER: 1, OUT: 2, BOWL: 3 };
export const LOSE_TEXT = {
  [LOSE.WATER]: 'A block fell into the water.',
  [LOSE.OUT]: 'A block fell out of the play area.',
  [LOSE.BOWL]: 'A block hit the bowl.',
};

// ── Definitions: copy, replace, check, export ────────────────────────────────────────────────────────────────
const TABLES = ['tuning', 'materials', 'shapes', 'bowls', 'models', 'backgrounds', 'levels'];
export const DEFINITION_TABLES = TABLES;
const live = { tuning, materials, shapes, bowls, models, backgrounds, levels };

/** A deep copy of all definitions (plain JSON data). */
export function cloneDefinitions() {
  return JSON.parse(JSON.stringify(live));
}

/** Replace the live definitions IN PLACE (every module keeps working with the same objects) and recompute what is derived from them. */
export function applyDefinitions(next) {
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
  for (const k of ['gravity', 'waterDensity', 'settleTime', 'settleSpeed', 'follow', 'depth', 'chamfer', 'frontZ', 'hoverZ', 'slotGap', 'maxHoldX', 'maxHoldY', 'minHoldY']) {
    if (!isNum(t[k])) err(`tuning.${k}: not a number`);
  }
  if (isNum(t.gravity) && t.gravity <= 0) err('tuning.gravity must be above 0');
  if (isNum(t.depth) && t.depth < 0.3) err('tuning.depth must be at least 0.3');
  if (isNum(t.chamfer) && isNum(t.depth) && (t.chamfer < 0 || t.chamfer > t.depth / 2 - 0.02)) err('tuning.chamfer must be between 0 and half the depth');
  rect(t.zone, 'tuning.zone', ['x0', 'x1']);
  rect(t.drop, 'tuning.drop', ['x0', 'x1', 'y0', 'y1']);
  rect(t.view, 'tuning.view', ['w', 'h', 'cy']);
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
    if (b.light !== undefined) {
      if (b.light.dir !== undefined && !isVec3(b.light.dir)) err(`background ${k}: light.dir needs 3 numbers`);
      if (b.light.shadow !== undefined && !(isNum(b.light.shadow) && b.light.shadow >= 0 && b.light.shadow <= 1)) err(`background ${k}: light.shadow must be from 0 to 1`);
    }
    if (b.ground?.style !== undefined && !['sand', 'wood'].includes(b.ground.style)) err(`background ${k}: ground.style must be sand or wood`);
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
    });
  }

  // levels
  const lvs = d.levels ?? [];
  if (lvs.length === 0) err('there must be at least one level');
  lvs.forEach((l, i) => {
    const w = `level ${i + 1} (${l.name})`;
    if (typeof l.name !== 'string' || !l.name) err(`${w}: needs a name`);
    if (!['easy', 'medium', 'hard'].includes(l.difficulty)) err(`${w}: difficulty must be easy, medium or hard`);
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

/** The whole definitions.js file for the given definitions. */
export function serializeDefinitions(defs) {
  const head = [
    '// Runs on BOTH server and browser. Pure data, no code: everything that defines the CONTENT of Balance lives in this file.',
    `// Exported from the debug menu on ${new Date().toISOString().slice(0, 10)}. Reference of every field: see the comments in shared.js and the debug menu.`,
    '//',
    '//   tuning        numbers you can play with (gravity, camera, block depth ...)',
    '//   materials     friction, weight and shader of a block',
    '//   shapes        the block outlines',
    '//   bowls         the bowls the tower is built in',
    '//   models        .obj files in ./models and the shader of each part',
    '//   backgrounds   the scenery around the table',
    '//   levels        what to build, in which bowl, in front of which background',
    '',
  ];
  return `${head.join('\n')}\n${TABLES.map((n) => serializeTable(n, defs[n])).join('\n')}`;
}

syncDefinitions();

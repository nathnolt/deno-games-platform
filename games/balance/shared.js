// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.
//
// Everything that defines the game content lives here as plain data: materials, shapes and levels.
// To add a level, add an entry to `levels`. To add a block type, add an entry to `shapes`.

/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'balance',
  name: 'Balance',
  description: 'Stack the blocks without letting anything fall. Pick a level, place every block, and keep it all standing.',
  maxPlayers: 1, // one seat: single player. Anybody else who joins the room spectates the same live physics
  minPlayers: 1,
  dropIn: true, // no setup page: the level menu is part of the game itself
  tickRate: 30, // snapshots per second; the physics runs on its own fixed (finer) step inside the server
  settings: [],
};

// ── World units ──────────────────────────────────────────────────────────────────────────────────────────────
// x = right, y = up. y = 0 is the surface of the water. Shape coordinates are in these same units
// (a 4x4 square is 4 units wide). Level x/y positions are the CENTRE of the shape.

export const WATER_Y = 0;
export const GRAVITY = 30; // units / s²  (a bit heavy, so blocks feel chunky rather than floaty)
export const WATER_DENSITY = 1; // see densityOf(): material density = weight / 10, so weight 10 == as dense as water

/** The bowl of water at the bottom. Its walls are static; blocks that are not 'float' blocks lose the level if they touch it. */
export const BOWL = { halfW: 18, depth: 8, wall: 1.2, rim: 1.2 }; // rim = how far the walls stick up above the water

/** Default play zone. A block whose centre leaves it (sideways) loses the level. Levels can override with `zone`. */
export const ZONE = { x0: -30, x1: 30 };

/** What the camera must always show: a wide, zoomed-out view. Height follows the window aspect, but never less than h. */
export const VIEW = { w: 84, h: 46, cy: 9 };

/** The tray of blocks you can choose from: a column at the left edge of the view. */
export const TRAY = { x: -36, top: 27, gap: 7.6, cell: 6.6 };

/** How high above the water a held block may be carried. */
export const MAX_HOLD_Y = 34;

// ── Materials ────────────────────────────────────────────────────────────────────────────────────────────────
// friction: 0..20 (mu = friction / 20)         weight: density, 10 = same density as water (mass = area * weight / 10)
// static:   never moves                        float: dynamic, pushed up by the water, never counts as "fallen in the water"
// shader:   name of a GLSL shader in client/shaders.js
export const materials = {
  wood: { friction: 10, weight: 10, shader: 'wood' },
  glass: { friction: 4, weight: 5, shader: 'glass' },
  stone: { friction: 14, weight: 20, shader: 'stone1' },
  static: { static: true, friction: 12, shader: 'stone2' },
  floatBlock: { float: true, friction: 8, weight: 3, shader: 'float' },
};

export const frictionOf = (m) => (materials[m].friction ?? 10) / 20;
export const densityOf = (m) => (materials[m].weight ?? 10) / 10;

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────
// A shape is a list of parts. Part types:
//   { type: 'poly',   points: 'x,y x,y x,y ...' }   a CONVEX polygon (build concave shapes from several parts, like plus1)
//   { type: 'circle', diameter: d, x?, y? }          x/y = centre, default (d/2, d/2)
// Origin and orientation do not matter: every shape is re-centred on the middle of its bounding box when it is used.
export const shapes = {
  rect1: [{ type: 'poly', points: '0,0 4,0 4,1 0,1' }],
  square1: [{ type: 'poly', points: '0,0 4,0 4,4 0,4' }],
  small1: [{ type: 'poly', points: '0,0 2,0 2,2 0,2' }],
  plank1: [{ type: 'poly', points: '0,0 8,0 8,1 0,1' }],
  bridge1: [{ type: 'poly', points: '0,0 14,0 14,1.5 0,1.5' }],
  slab1: [{ type: 'poly', points: '0,0 12,0 12,1.5 0,1.5' }],
  raft1: [{ type: 'poly', points: '0,0 16,0 16,3 0,3' }],
  raft2: [{ type: 'poly', points: '0,0 11,0 11,3 0,3' }],
  pillar1: [{ type: 'poly', points: '0,0 2,0 2,10 0,10' }],
  tri1: [{ type: 'poly', points: '0,0 4,0 2,3' }],
  plus1: [
    { type: 'poly', points: '0,1 3,1 3,2 0,2' },
    { type: 'poly', points: '1,0 2,0 2,3 1,3' },
  ],
  circle1: [{ type: 'circle', diameter: 4 }],
  circle2: [{ type: 'circle', diameter: 2.5 }],
};

export const SHAPE_KEYS = Object.keys(shapes);
export const MATERIAL_KEYS = Object.keys(materials);

const cache = new Map();

/**
 * Normalised geometry for a shape: parts centred on the bounding-box centre, polygons counter-clockwise.
 * @returns {{ parts: ({type:'poly', pts:number[][]}|{type:'circle', cx:number, cy:number, r:number})[], w:number, h:number, radius:number }}
 */
export function getShape(key) {
  let s = cache.get(key);
  if (s) return s;
  const def = shapes[key];
  if (!def) throw new Error(`unknown shape "${key}"`);

  const raw = def.map((p) => {
    if (p.type === 'circle') {
      const r = p.diameter / 2;
      return { type: 'circle', cx: p.x ?? r, cy: p.y ?? r, r };
    }
    let pts = p.points.trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
    if (pts.length < 3 || pts.some((q) => q.length !== 2 || q.some((n) => !Number.isFinite(n)))) throw new Error(`bad points in shape "${key}"`);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    if (area < 0) pts = pts.reverse(); // counter-clockwise
    return { type: 'poly', pts };
  });

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

  s = { parts, w: x1 - x0, h: y1 - y0, radius };
  cache.set(key, s);
  return s;
}

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────────────────
// name, difficulty     shown in the menu
// initialBlocks        present from the start: { shape, material, rot (degrees), x, y }  (x,y = centre, y=0 is the water surface)
//                      'static' material = fixed to the world. Anything else is a normal physics body.
// chooseShapes         how many of the upcoming blocks are visible in the tray at once
// shapes               the ordered list of blocks you must place: { shape, material }. Rotate with Q / E while holding.
// zone (optional)      { x0, x1 }: sideways limits (default ZONE). Leaving it, or touching the water/bowl, loses the level.
//
// Pillars below are 'pillar1' (2 x 10) centred at y = -3: they stand on the bowl floor (y = -8) and top out at y = 2.
export const levels = [
  {
    name: 'First Steps',
    difficulty: 'easy',
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: -5, y: -3 },
      { shape: 'pillar1', material: 'static', rot: 0, x: 5, y: -3 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'plank1', material: 'wood' },
      { shape: 'square1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'square1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
    ],
  },
  {
    name: 'The Slope',
    difficulty: 'easy',
    // one short pillar with a slanted slab on top: the surface you build on is tilted
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: 0, y: -3 },
      { shape: 'slab1', material: 'static', rot: 14, x: 0, y: 2.75 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'rect1', material: 'wood' },
      { shape: 'square1', material: 'stone' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'plus1', material: 'wood' },
      { shape: 'tri1', material: 'wood' },
    ],
  },
  {
    name: 'Twin Pillars',
    difficulty: 'medium',
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: -7, y: -3 },
      { shape: 'pillar1', material: 'static', rot: 0, x: 7, y: -3 },
    ],
    chooseShapes: 4,
    shapes: [
      { shape: 'bridge1', material: 'wood' },
      { shape: 'square1', material: 'stone' },
      { shape: 'plank1', material: 'wood' },
      { shape: 'plus1', material: 'wood' },
      { shape: 'circle1', material: 'wood' },
      { shape: 'rect1', material: 'glass' },
      { shape: 'square1', material: 'wood' },
      { shape: 'tri1', material: 'wood' },
    ],
  },
  {
    name: 'Lily Pad',
    difficulty: 'medium',
    // no pillars: everything is built on a block that floats on the water. One-sided piles tip it over.
    initialBlocks: [{ shape: 'raft1', material: 'floatBlock', rot: 0, x: 0, y: 0.6 }],
    chooseShapes: 3,
    shapes: [
      { shape: 'rect1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'plank1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
    ],
  },
  {
    name: 'Glass Cannon',
    difficulty: 'hard',
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: 0, y: -3 },
      { shape: 'slab1', material: 'static', rot: -18, x: 0, y: 2.75 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'square1', material: 'stone' },
      { shape: 'plank1', material: 'glass' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'plus1', material: 'glass' },
      { shape: 'tri1', material: 'stone' },
      { shape: 'rect1', material: 'glass' },
      { shape: 'circle2', material: 'wood' },
      { shape: 'small1', material: 'wood' },
    ],
  },
  {
    name: 'Tightrope',
    difficulty: 'hard',
    zone: { x0: -22, x1: 22 },
    initialBlocks: [
      { shape: 'raft2', material: 'floatBlock', rot: 0, x: 0, y: 0.6 },
      { shape: 'pillar1', material: 'static', rot: 0, x: -14, y: -3 },
    ],
    chooseShapes: 2,
    shapes: [
      { shape: 'small1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'rect1', material: 'glass' },
      { shape: 'square1', material: 'wood' },
      { shape: 'small1', material: 'glass' },
    ],
  },
];

// ── Wire constants (server and client agree on these) ─────────────────────────────────────────────────────
export const PHASE = { MENU: 0, PLAY: 1, WON: 2, LOST: 3 };
/** Per-body state in snapshots. */
export const BODY = { NORMAL: 0, HELD: 1, HELD_BAD: 2, STATIC: 3 };
/** Why a level was lost. */
export const LOSE = { WATER: 1, OUT: 2, BOWL: 3 };
export const LOSE_TEXT = {
  [LOSE.WATER]: 'A block fell into the water.',
  [LOSE.OUT]: 'A block fell out of the play area.',
  [LOSE.BOWL]: 'A block hit the bowl.',
};

/** Sideways limits for a level. */
export const zoneOf = (level) => level.zone ?? ZONE;

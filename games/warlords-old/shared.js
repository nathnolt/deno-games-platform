import { defineComponent } from '../../shared/ecs.js';

// ── meta ──
/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'warlords',
  name: 'Warlords',
  description: 'Defend your warlord in the corner. Break the others. Last one standing wins the round.',
  minPlayers: 1, // solo is possible with bots; the server's canStart() checks the real minimum
  maxPlayers: 4,
  tickRate: 60,
  soloSettings: { bots: 3 },
  settings: [
    { type: 'number', key: 'bots', label: 'Bots (fill empty corners)', min: 0, max: 3, step: 1, default: 0 },
    {
      type: 'select', key: 'botSkill', label: 'Bot skill', default: 'normal',
      options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
    },
    { type: 'number', key: 'maxBalls', label: 'Max balls', min: 1, max: 8, step: 1, default: 3 },
    { type: 'number', key: 'ballInterval', label: 'Seconds between new balls', min: 3, max: 30, step: 1, default: 10 },
    { type: 'number', key: 'ballSpeed', label: 'Ball speed', min: 150, max: 700, step: 10, default: 320 },
    { type: 'boolean', key: 'instantMouse', label: 'Mouse moves paddle instantly', default: true },
    { type: 'number', key: 'paddleSpeed', label: 'Paddle speed limit', min: 200, max: 1500, step: 50, default: 700 },
    { type: 'number', key: 'roundsToWin', label: 'Rounds to win', min: 1, max: 9, step: 1, default: 3 },
  ],
};

// ── geometry ──
// Everything is defined for slot 0 (top-left corner) in local (u, v) coordinates
// measured from the corner, then mirrored into the other corners.
export const ARENA = 800;
export const BRICK = 24;
export const BLOCK = 3; // base = 3x3 cells: king in cell (0,0), 8 bricks around it
export const BLOCK_SIZE = BRICK * BLOCK;
export const GAP = 14;
export const PADDLE_LEN = 90;
export const PADDLE_THICK = 14;
export const BALL_R = 8;
export const TRACK = 240; // max paddle travel along each arm of its L-shaped track
export const PAD_C = BLOCK_SIZE + GAP + PADDLE_THICK / 2;

/** Brick cells (i, j) of the base, excluding the king cell (0,0). The array index is the brick id. */
export const BRICK_CELLS = [];
for (let i = 0; i < BLOCK; i++) for (let j = 0; j < BLOCK; j++) if (i || j) BRICK_CELLS.push([i, j]);

function rect(slot, u, v, w, h) {
  const sx = slot & 1;
  const sy = slot >> 1;
  return { x: sx ? ARENA - u : u, y: sy ? ARENA - v : v, w, h }; // x,y = center
}

/** Slots: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right. */
export const kingRect = (slot) => rect(slot, BRICK / 2, BRICK / 2, BRICK, BRICK);

export function brickRect(slot, idx) {
  const [i, j] = BRICK_CELLS[idx];
  return rect(slot, (i + 0.5) * BRICK, (j + 0.5) * BRICK, BRICK, BRICK);
}

/** Paddle position t in [-TRACK, TRACK]: t >= 0 slides along one wall, t < 0 along the other. */
export function paddleRect(slot, t) {
  return t >= 0
    ? rect(slot, PAD_C + t, PAD_C, PADDLE_LEN, PADDLE_THICK)
    : rect(slot, PAD_C, PAD_C - t, PADDLE_THICK, PADDLE_LEN);
}

/** Where on the paddle track is the point (x, y) closest to? Used by the mouse and by bots. */
export function tFromPoint(slot, x, y) {
  const u = slot & 1 ? ARENA - x : x;
  const v = slot >> 1 ? ARENA - y : y;
  const t = u >= v ? u - PAD_C : PAD_C - v;
  return Math.max(-TRACK, Math.min(TRACK, t));
}

/** +1 if increasing t moves the paddle clockwise on screen for this corner, else -1. */
export const clockwiseSign = (slot) => ((slot & 1) === (slot >> 1) ? 1 : -1);

/** Circle vs rectangle. Returns the push-out normal and depth, or null. */
export function circleRect(cx, cy, r, rc) {
  const dx = cx - rc.x;
  const dy = cy - rc.y;
  const hw = rc.w / 2;
  const hh = rc.h / 2;
  const ox = dx - Math.max(-hw, Math.min(hw, dx));
  const oy = dy - Math.max(-hh, Math.min(hh, dy));
  const d2 = ox * ox + oy * oy;
  if (d2 > r * r) return null;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return { nx: ox / d, ny: oy / d, depth: r - d };
  }
  const penX = hw - Math.abs(dx);
  const penY = hh - Math.abs(dy);
  return penX < penY
    ? { nx: Math.sign(dx) || 1, ny: 0, depth: penX + r }
    : { nx: 0, ny: Math.sign(dy) || 1, depth: penY + r };
}

// ── components (used by the server simulation and the client renderer, in separate Worlds) ──
export const Pos = defineComponent('Pos'); //       {x, y}
export const Vel = defineComponent('Vel'); //       {x, y}
export const BallC = defineComponent('Ball'); //    {id}
export const PaddleC = defineComponent('Paddle'); // {slot, t}
export const BrickC = defineComponent('Brick'); //  {slot, idx}
export const KingC = defineComponent('King'); //    {slot}

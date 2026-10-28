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
    { type: 'number', key: 'maxBalls', label: 'Max balls', min: 1, max: 8, step: 1, default: 4 },
    { type: 'number', key: 'ballInterval', label: 'Seconds between new balls', min: 3, max: 30, step: 1, default: 6 },
    { type: 'number', key: 'ballSpeed', label: 'Ball speed', min: 150, max: 700, step: 10, default: 380 },
    { type: 'boolean', key: 'speedUp', label: 'Balls speed up when hit by a paddle', default: true },
    { type: 'number', key: 'speedUpStrength', label: 'Speed-up strength: paddle swing + shallow angles (only with speed-up on)', min: 0.1, max: 3, step: 0.1, default: 1.6 },
    { type: 'number', key: 'hitBoost', label: 'Speed multiplier on EVERY paddle hit (only with speed-up on; 1 = none)', min: 1, max: 1.5, step: 0.01, default: 1.1 },
    { type: 'number', key: 'maxSpeedMult', label: 'Top ball speed, x base (speed-up and hold release)', min: 1.2, max: 8, step: 0.1, default: 3.5 },
    { type: 'number', key: 'speedDecay', label: 'Slow-down of fast balls per second (only with speed-up on)', min: 0, max: 1, step: 0.05, default: 0.05 },
    { type: 'boolean', key: 'holdEnabled', label: 'Hold the mouse button / Space to catch a ball on your paddle', default: true },
    { type: 'boolean', key: 'holdInfinite', label: 'Infinite hold: keep the ball as long as the button is down (off = temporary hold, see max seconds)', default: false },
    { type: 'number', key: 'holdMax', label: 'Max seconds a ball can be held (only with hold on and infinite hold off)', min: 1, max: 15, step: 1, default: 4 },
    { type: 'number', key: 'releaseMinSpeed', label: 'Minimum speed of a released ball, x base (only with hold on)', min: 1, max: 3, step: 0.1, default: 1.3 },
    { type: 'number', key: 'releaseSpeedGain', label: 'Extra release speed per paddle speed (only with hold on; 0 = always the minimum)', min: 0, max: 2, step: 0.1, default: 0.6 },
    { type: 'boolean', key: 'instantMouse', label: 'Mouse moves paddle instantly', default: true },
    { type: 'number', key: 'paddleSpeed', label: 'Paddle speed (keyboard, bots, and mouse when not instant)', min: 100, max: 1500, step: 50, default: 900 },
    { type: 'number', key: 'roundsToWin', label: 'Rounds to win', min: 1, max: 9, step: 1, default: 3 },
  ],
};

// ── geometry ──
// Everything is defined for slot 0 (top-left corner) in local (u, v) coordinates
// measured from the corner, then mirrored into the other corners.
export const ARENA = 800;
// ★ BASE SIZE KNOB: pixels per brick. Base = BLOCK * BRICK (24 -> 144 px, 28 -> 168 px, 32 -> 192 px).
//   Everything (king, paddle track, hold path, bots) scales with it. Try 26..32 and see what feels nicest.
export const BRICK = 28;
export const BLOCK = 6; //  base = 6x6 cells: the king fills the corner 2x2, 32 bricks around it (the snapshot mask is 32 bits)
export const KING_CELLS = 2;
export const BLOCK_SIZE = BRICK * BLOCK;
export const GAP = 14; //   keep below 2 * BALL_R or balls can squeeze between the paddle and the base
export const PADDLE_LEN = 45; // measured along the track (was 90)
export const PADDLE_THICK = 20; // chunkier, so the paddle is squarer like the Atari original
export const BALL_R = 8;

/**
 * The paddle track hugs the two exposed sides of the base like a "┘" (for slot 0):
 *
 *     wall ┌───────┬──────────────  v = 0 (top wall)
 *          │ base  │ ║  <- vertical arm   (u = PAD_C)
 *          ├───────┘ ║
 *          ╚═════════╝  <- horizontal arm (v = PAD_C), corner at (PAD_C, PAD_C)
 *
 * The paddle's position `t` is an arc length along that track, measured from the inner corner:
 *   t > 0  the paddle's centre is on the horizontal arm (under the base, towards the side wall)
 *   t < 0  the paddle's centre is on the vertical arm   (beside the base, towards the end wall)
 *   t = 0  the paddle is bent around the inner corner as an "L"
 * A paddle is PADDLE_LEN long *along the track*, so whenever it straddles the corner it
 * turns into two rectangles.
 */
export const PAD_C = BLOCK_SIZE + GAP + PADDLE_THICK / 2; // distance from the arena corner to the track
export const TRACK = PAD_C - PADDLE_LEN / 2; // max |t|: the paddle's end touches the wall

/** Brick cells (i, j) of the base, excluding the king cell (0,0). The array index is the brick id. */
export const BRICK_CELLS = [];
for (let i = 0; i < BLOCK; i++) for (let j = 0; j < BLOCK; j++) if (i >= KING_CELLS || j >= KING_CELLS) BRICK_CELLS.push([i, j]);
// The snapshot sends surviving bricks as one 32-bit mask per base.
if (BRICK_CELLS.length > 32) throw new Error('Warlords: at most 32 bricks per base (BLOCK / KING_CELLS)');

function rect(slot, u, v, w, h) {
  const sx = slot & 1;
  const sy = slot >> 1;
  return { x: sx ? ARENA - u : u, y: sy ? ARENA - v : v, w, h }; // x,y = center
}

/** Slots: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right. */
export const kingRect = (slot) => rect(slot, (KING_CELLS * BRICK) / 2, (KING_CELLS * BRICK) / 2, KING_CELLS * BRICK, KING_CELLS * BRICK);

export function brickRect(slot, idx) {
  const [i, j] = BRICK_CELLS[idx];
  return rect(slot, (i + 0.5) * BRICK, (j + 0.5) * BRICK, BRICK, BRICK);
}

/**
 * The paddle at track position t as 1 or 2 rectangles (2 when it is bent around the corner).
 * Each rectangle also says which way its material moves (dx, dy) when t increases, which the
 * server uses to turn "paddle speed along the track" into a velocity at the point of contact.
 * (fx, fy) is the rectangle's front: the unit normal of the face that points away from the base.
 * `horiz` is true for the rectangle lying on the horizontal arm. Centre-based, like every rect.
 */
export function paddleRects(slot, t) {
  const flipX = slot & 1 ? -1 : 1;
  const flipY = slot >> 1 ? -1 : 1;
  const half = PADDLE_LEN / 2;
  const th = PADDLE_THICK / 2;
  const a = t - half; // paddle end towards the vertical arm   (arc length from the corner)
  const b = t + half; // paddle end towards the horizontal arm
  const bent = a < 0 && b > 0;
  const out = [];
  if (b > 0) {
    const lo = PAD_C - b;
    const hi = bent ? PAD_C + th : PAD_C - a; // at the corner, extend by half a thickness to fill the elbow
    out.push({ ...rect(slot, (lo + hi) / 2, PAD_C, hi - lo, PADDLE_THICK), dx: -flipX, dy: 0, fx: 0, fy: flipY, horiz: true });
  }
  if (a < 0) {
    const lo = PAD_C + a;
    const hi = bent ? PAD_C + th : PAD_C + b;
    out.push({ ...rect(slot, PAD_C, (lo + hi) / 2, PADDLE_THICK, hi - lo), dx: 0, dy: flipY, fx: flipX, fy: 0, horiz: false });
  }
  return out;
}

/**
 * Aiming: where should the paddle be to defend against the point (x, y)? The paddle sits where a
 * ray from the arena corner through (x, y) crosses the track: pointing along the diagonal puts it
 * in the inner corner, pointing along a wall pushes it to that end of the track. Used by the mouse
 * and by bots. (Projecting onto the nearest point of the track would park the paddle in the corner
 * for every mouse position out in the arena.)
 */
export function tFromPoint(slot, x, y) {
  const u = slot & 1 ? ARENA - x : x;
  const v = slot >> 1 ? ARENA - y : y;
  let t = 0;
  if (u > 0 && u >= v) t = (PAD_C * v) / u - PAD_C; // crosses the vertical arm   (t <= 0)
  else if (v > 0) t = PAD_C - (PAD_C * u) / v; //      crosses the horizontal arm (t >= 0)
  return Math.max(-TRACK, Math.min(TRACK, t));
}

// ── holding a ball ──
// A held ball rides on the FRONT of the paddle (the side facing the middle of the arena), at a fixed
// place along the paddle. Its path is the outline of the "┘" paddle shape offset by the ball radius:
// two straight lines joined by a quarter circle around the outer corner of the elbow. Both the
// server (to move the ball) and the client (to aim) use these helpers.
const HOLD_R = BALL_R + 0.5; //                      stand-off from the paddle face (a hair more than touching)
const HOLD_O = PAD_C + PADDLE_THICK / 2; //          outer corner of the elbow, in (u, v)
const HOLD_A = (Math.PI * HOLD_R) / 4; //            half the length of the rounded part
const HOLD_K = PADDLE_THICK / 2 + HOLD_A;
/** Launch rays start this far inside the arena corner (not in it), so the extremes are never exactly horizontal / vertical. */
export const HOLD_ORIGIN = 40;

// centre-line arc s -> outline arc w, for a paddle centred at t. A straight paddle (one arm only) maps
// exactly (w = s +- HOLD_K). A paddle bent round the corner maps exactly too, except within half a
// thickness of the corner, where it is stretched so the ball swings smoothly round the elbow.
const HALF_T = PADDLE_THICK / 2;
const bentAt = (t) => t - PADDLE_LEN / 2 < 0 && t + PADDLE_LEN / 2 > 0;
function outlineW(s, t) {
  if (!bentAt(t)) return s + HOLD_K * (t > 0 ? 1 : -1);
  return Math.abs(s) >= HALF_T ? s + HOLD_K * Math.sign(s) : (s * (HALF_T + HOLD_K)) / HALF_T;
}
function outlineS(w, t) {
  if (!bentAt(t)) return w - HOLD_K * (t > 0 ? 1 : -1);
  return Math.abs(w) >= HALF_T + HOLD_K ? w - HOLD_K * Math.sign(w) : (w * HALF_T) / (HALF_T + HOLD_K);
}

/** World position of a held ball sitting at track position s (arc length from the inner corner, like `t`) of a paddle centred at t. */
export function heldPoint(slot, s, t) {
  const w = outlineW(s, t);
  let u;
  let v;
  if (w >= HOLD_A) { u = HOLD_O - (w - HOLD_A); v = HOLD_O + HOLD_R; } //        in front of the horizontal arm
  else if (w <= -HOLD_A) { u = HOLD_O + HOLD_R; v = HOLD_O + (w + HOLD_A); } //   in front of the vertical arm
  else {
    const phi = Math.PI / 4 - w / HOLD_R; //                                        around the elbow
    u = HOLD_O + HOLD_R * Math.sin(phi);
    v = HOLD_O + HOLD_R * Math.cos(phi);
  }
  return { x: slot & 1 ? ARENA - u : u, y: slot >> 1 ? ARENA - v : v };
}

/** Inverse of heldPoint: the track position s of a paddle centred at t that the ball at (x, y) is sitting in front of. */
export function heldS(slot, x, y, t) {
  const du = (slot & 1 ? ARENA - x : x) - HOLD_O;
  const dv = (slot >> 1 ? ARENA - y : y) - HOLD_O;
  let w;
  if (du > 0 && dv > 0) w = HOLD_R * (Math.PI / 4 - Math.atan2(du, dv));
  else if (du <= 0 && (dv > 0 || -du >= -dv)) w = HOLD_A - du;
  else w = -HOLD_A + dv;
  return outlineS(w, t);
}

/** Direction (unit vector) a ball held at (x, y) is released in: along the line from a point just inside the corner through the ball. */
export function launchDir(slot, x, y) {
  const qx = slot & 1 ? ARENA - HOLD_ORIGIN : HOLD_ORIGIN;
  const qy = slot >> 1 ? ARENA - HOLD_ORIGIN : HOLD_ORIGIN;
  const dx = x - qx;
  const dy = y - qy;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** +1 if increasing t moves the paddle clockwise around the base on screen for this corner, else -1. */
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

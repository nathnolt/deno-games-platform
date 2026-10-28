import { defineComponent } from '../../shared/ecs.js';

// ── meta ──
/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'warlords',
  name: 'Warlords',
  description: 'Defend your warlord in the corner. Break the others. Last one standing wins the round.',
  minPlayers: 2, // filled seats (players + bots) needed to start
  maxPlayers: 4, // the four corners = four seats
  seatNames: ['Top left', 'Top right', 'Bottom left', 'Bottom right'],
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'],
  tickRate: 60,
  soloSettings: {}, // Play solo = you in the first seat, bots in the other three (the room's seat rows can change that)
  settingGroups: [
    { id: 'match', label: 'Match' },
    { id: 'balls', label: 'Balls' },
    { id: 'controls', label: 'Paddle & controls' },
    { id: 'speedup', label: 'Speed-up', description: 'Balls get faster as they are hit. Only used when "Balls speed up" is on.', collapsed: true },
    { id: 'hold', label: 'Holding balls', description: 'Catch a ball on your paddle and release it. Only used when holding is on.', collapsed: true },
  ],
  settings: [
    // Match
    { type: 'number', key: 'roundsToWin', label: 'Rounds to win', min: 1, max: 9, step: 1, default: 3, group: 'match' },
    {
      type: 'select', key: 'botSkill', label: 'Bot skill', default: 'normal', group: 'match',
      options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
    },
    // Balls
    { type: 'number', key: 'maxBalls', label: 'Max balls', min: 1, max: 8, step: 1, default: 4, group: 'balls' },
    { type: 'number', key: 'ballInterval', label: 'Seconds between new balls', min: 3, max: 30, step: 1, default: 6, group: 'balls' },
    { type: 'number', key: 'ballSpeed', label: 'Ball speed', min: 150, max: 700, step: 10, default: 380, group: 'balls' },
    { type: 'number', key: 'maxSpeedMult', label: 'Top ball speed, x base (speed-up and hold release)', min: 1.2, max: 8, step: 0.1, default: 3.5, group: 'balls' },
    // Paddle & controls
    { type: 'boolean', key: 'instantMouse', label: 'Mouse moves paddle instantly', default: true, group: 'controls' },
    { type: 'number', key: 'paddleSpeed', label: 'Paddle speed (keyboard, bots, and mouse when not instant)', min: 100, max: 1500, step: 50, default: 900, group: 'controls' },
    // Speed-up
    { type: 'boolean', key: 'speedUp', label: 'Balls speed up when hit by a paddle', default: true, group: 'speedup' },
    { type: 'number', key: 'speedUpStrength', label: 'Speed-up strength: paddle swing + shallow angles (only with speed-up on)', min: 0.1, max: 3, step: 0.1, default: 1.6, group: 'speedup' },
    { type: 'number', key: 'hitBoost', label: 'Speed multiplier on EVERY paddle hit (only with speed-up on; 1 = none)', min: 1, max: 1.5, step: 0.01, default: 1.1, group: 'speedup' },
    { type: 'number', key: 'speedDecay', label: 'Slow-down of fast balls per second (only with speed-up on)', min: 0, max: 1, step: 0.05, default: 0.05, group: 'speedup' },
    // Holding balls
    { type: 'boolean', key: 'holdEnabled', label: 'Hold the mouse button / Space to catch a ball on your paddle', default: true, group: 'hold' },
    { type: 'boolean', key: 'holdInfinite', label: 'Infinite hold: keep the ball as long as the button is down (off = temporary hold, see max seconds)', default: false, group: 'hold' },
    { type: 'number', key: 'holdMax', label: 'Max seconds a ball can be held (only with hold on and infinite hold off)', min: 1, max: 15, step: 1, default: 4, group: 'hold' },
    { type: 'number', key: 'releaseMinSpeed', label: 'Minimum speed of a released ball, x base (only with hold on)', min: 1, max: 3, step: 0.1, default: 1.3, group: 'hold' },
    { type: 'number', key: 'releaseSpeedGain', label: 'Extra release speed per paddle speed (only with hold on; 0 = always the minimum)', min: 0, max: 2, step: 0.1, default: 0.6, group: 'hold' },
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
// A held ball is glued to the paddle exactly where it touched it, so it can sit on the front, on either
// end or on the back. Two numbers place it (see `h` = { off, d } in the server):
//   off  arc length along the track from the paddle's centre (like `t`, so the ball rides along when the paddle moves)
//   d    distance of the ball's centre from the paddle's centre line: > PADDLE_THICK / 2 in front of the paddle,
//        <= PADDLE_THICK / 2 beside an end or behind it
// In front of the paddle the ball follows the outline of the "┘" shape offset by its distance from the face: two straight
// lines joined by a quarter circle around the outer corner of the elbow. Beside an end or behind the paddle it follows the
// straight arm. Both the server (to move the ball) and the client (to aim) use these helpers.
const HALF_T = PADDLE_THICK / 2;
const HOLD_R = BALL_R + 0.5; //                      default stand-off from the paddle face (a hair more than touching)
const HOLD_O = PAD_C + HALF_T; //                    outer corner of the elbow, in (u, v)
/** Default `d`: a ball sitting in front of the paddle. */
export const HOLD_D = HALF_T + HOLD_R;
/**
 * Launch rays start this far inside the arena corner, in both directions. It equals half a paddle, which
 * is exactly how far from the wall the paddle's middle is at either extreme, so a ball held on the front
 * at an extreme leaves exactly along the wall (a cardinal direction).
 */
export const HOLD_ORIGIN = PADDLE_LEN / 2;

const arcA = (e) => (Math.PI * e) / 4; //            half the length of the rounded part, for a ball e in front of the face
/** 0 while the paddle lies straight on one arm, 1 once it is bent round the corner by at least half a thickness; smooth in between. */
const bendAt = (t) => Math.max(0, Math.min(1, Math.min(PADDLE_LEN / 2 - t, t + PADDLE_LEN / 2) / HALF_T));

// centre-line arc s -> outline arc w, for a paddle centred at t and a ball e in front of its face. A straight paddle
// (one arm only) maps exactly (w = s +- K). A paddle bent round the corner maps exactly too, except within half a
// thickness of the corner, where it is stretched so the ball swings smoothly round the elbow. The two maps are
// blended while the paddle starts to bend, so a ball near a paddle end never jumps. (w is a piecewise linear,
// increasing function of s with its breakpoints at s = +-HALF_T, which makes the inverse exact.)
function outlineW(s, t, e) {
  const k = HALF_T + arcA(e);
  const w0 = s + k * (t > 0 ? 1 : -1);
  const w1 = Math.abs(s) >= HALF_T ? s + k * Math.sign(s) : (s * (HALF_T + k)) / HALF_T;
  const beta = bendAt(t);
  return w0 + beta * (w1 - w0);
}
function outlineS(w, t, e) {
  const hi = outlineW(HALF_T, t, e);
  const lo = outlineW(-HALF_T, t, e);
  if (w >= hi) return HALF_T + (w - hi);
  if (w <= lo) return -HALF_T + (w - lo);
  return -HALF_T + ((w - lo) * 2 * HALF_T) / (hi - lo);
}

// Beside an end or behind the paddle the ball follows the straight arm; round the elbow the two arms are blended
// (over SIDE_BLEND px each side of the corner) so a ball off the centre line swings round instead of jumping.
const SIDE_BLEND = 14;
function sideUV(s, d) {
  const x = Math.max(0, Math.min(1, (s + SIDE_BLEND) / (2 * SIDE_BLEND)));
  const lam = x * x * (3 - 2 * x); // 0 = on the vertical arm, 1 = on the horizontal arm
  return { lam, u: lam * (PAD_C - s) + (1 - lam) * (PAD_C + d), v: lam * (PAD_C + d) + (1 - lam) * (PAD_C + s) };
}

/** World position of a held ball at track position s (arc length from the inner corner, like `t`), distance d from the centre line, of a paddle centred at t. */
export function heldPoint(slot, s, t, d = HOLD_D) {
  let u;
  let v;
  if (d > HALF_T) { //                                                              in front of the paddle
    const e = d - HALF_T;
    const a = arcA(e);
    const w = outlineW(s, t, e);
    if (w >= a) { u = HOLD_O - (w - a); v = HOLD_O + e; } //                        in front of the horizontal arm
    else if (w <= -a) { u = HOLD_O + e; v = HOLD_O + (w + a); } //                  in front of the vertical arm
    else {
      const phi = Math.PI / 4 - w / e; //                                           around the elbow
      u = HOLD_O + e * Math.sin(phi);
      v = HOLD_O + e * Math.cos(phi);
    }
  } else ({ u, v } = sideUV(s, d)); //                                              beside an end / behind
  return { x: slot & 1 ? ARENA - u : u, y: slot >> 1 ? ARENA - v : v };
}

/**
 * Inverse of heldPoint: the track position s and centre-line distance d of the ball at (x, y), for a paddle centred at t.
 * `horiz` says which of the paddle's rectangles the ball touched; it only matters beside / behind the paddle.
 */
export function heldCoords(slot, x, y, t, horiz) {
  const u = slot & 1 ? ARENA - x : x;
  const v = slot >> 1 ? ARENA - y : y;
  const du = u - HOLD_O;
  const dv = v - HOLD_O;
  if (dv > 0 || du > 0) { // in front of the paddle (or round its elbow)
    let e;
    let w;
    if (du > 0 && dv > 0) { e = Math.hypot(du, dv); w = e * (Math.PI / 4 - Math.atan2(du, dv)); }
    else if (dv > 0) { e = dv; w = arcA(e) - du; }
    else { e = du; w = -arcA(e) + dv; }
    return { s: outlineS(w, t, e), d: HALF_T + e };
  }
  const sh = PAD_C - u; //  arc position on the horizontal arm, valid when > 0
  const sv = v - PAD_C; //  arc position on the vertical arm, valid when <= 0
  const useH = sh > 0 && (horiz || !(sv <= 0));
  let s = useH ? sh : sv <= 0 ? sv : 0; // first guess: the straight arm the ball touched
  let d = useH ? v - PAD_C : sv <= 0 ? u - PAD_C : v - PAD_C;
  for (let i = 0; i < 10; i++) { // a few Newton steps make this the exact inverse of the blended mapping near the corner
    const q = sideUV(s, d);
    const eu = u - q.u;
    const ev = v - q.v;
    const a = -q.lam;
    const b = 1 - q.lam;
    const det = a * q.lam - b * b;
    s += (q.lam * eu - b * ev) / det;
    d += (-b * eu + a * ev) / det;
  }
  return { s, d };
}

/** Point on the centre line of the track at arc position s (like `t`), in world coordinates. */
export function trackPoint(slot, s) {
  const u = s >= 0 ? PAD_C - s : PAD_C;
  const v = s >= 0 ? PAD_C : PAD_C + s;
  return { x: slot & 1 ? ARENA - u : u, y: slot >> 1 ? ARENA - v : v };
}

/** World position of a held ball `h` = { off, d } for a paddle centred at t. */
export function heldPos(slot, t, h) {
  return heldPoint(slot, t + h.off, t, h.d);
}

/**
 * Direction (unit vector) a held ball is released in. Two vectors are combined (their angles averaged):
 *  A: from a point just inside the arena corner (HOLD_ORIGIN) to the middle of the paddle,
 *  B: from the middle of the paddle to the ball.
 * A ball on the FRONT at one of the two extreme paddle positions gets two parallel vectors along the wall, so it
 * shoots exactly along it (straight down the left wall / straight right along the top wall for the top-left corner).
 * A ball on a side or the back combines the same way, so it still goes sideways.
 */
export function launchVec(slot, t, h) {
  const b = heldPos(slot, t, h);
  const m = trackPoint(slot, t);
  const qx = slot & 1 ? ARENA - HOLD_ORIGIN : HOLD_ORIGIN;
  const qy = slot >> 1 ? ARENA - HOLD_ORIGIN : HOLD_ORIGIN;
  const unit = (x, y) => {
    const l = Math.hypot(x, y) || 1;
    return { x: Math.abs(x / l) < 1e-9 ? 0 : x / l, y: Math.abs(y / l) < 1e-9 ? 0 : y / l }; // snap rounding dust, so "exactly cardinal" is exact
  };
  const A = unit(m.x - qx, m.y - qy);
  const B = unit(b.x - m.x, b.y - m.y);
  const sx = A.x + B.x;
  const sy = A.y + B.y;
  return Math.hypot(sx, sy) < 1e-6 ? A : unit(sx, sy);
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

// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.
//
// RAMPARTS: a Rampart-style siege game. Every round has three timed phases:
//   place   put your new cannons inside your walls
//   battle  aim with the mouse and bombard the other players' walls and cannons
//   build   rebuild your walls with random Tetris-style pieces to close your castle again
// You may only use cannons that stand inside an unbroken wall. Enclosing a castle claims it (more cannons).
// Walls can only go on open ground, and never inside another player's castle zone or enclosed territory.
// You lose a life if no castle of yours is enclosed when the build phase ends, or if you are owed new cannons
// but your territory has no room for even one.
// Comeback help (setting): the current points leader is worth more to hit, trailing players get extra cannons.

/**
 * The points leader: the living player with the highest score, if that score is strictly higher than everyone else's
 * and above zero. -1 when nobody is clearly ahead. Used by the server (comeback rules) and the client (crown, bounty).
 */
export function leaderOf(score, alive) {
  let best = -1;
  let tie = false;
  for (let s = 0; s < score.length; s++) {
    if (!alive[s]) continue;
    if (best < 0 || score[s] > score[best]) { best = s; tie = false; } else if (score[s] === score[best]) tie = true;
  }
  return best >= 0 && !tie && score[best] > 0 ? best : -1;
}
/** Points multiplier for hitting the leader's walls and cannons, per comeback setting. */
export const BOUNTY = { off: 1, normal: 2, strong: 3 };

// ── meta ──
/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'ramparts',
  name: 'Ramparts',
  description: 'Place cannons, smash the other castles, then rebuild your walls before the clock runs out. Mouse only.',
  minPlayers: 2, // filled seats (players + bots) needed to start
  maxPlayers: 4,
  seatNames: ['Red keep', 'Blue keep', 'Green keep', 'Gold keep'],
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'],
  tickRate: 30,
  soloSettings: {}, // Play solo = you + bots in the other seats
  settingGroups: [
    // Keep field labels short: the setup form puts them in a narrow column. Explanations go in the group descriptions.
    { id: 'match', label: 'Match', description: 'You lose a life when no castle of yours is enclosed after the build phase. When the rounds run out, the best score wins.' },
    { id: 'comeback', label: 'Comeback help', description: 'Keeps the leader from running away with it. Normal: hits on the leader score ×2, players behind get +1 cannon, bots often target the leader. Strong: ×3, players far behind get +2 cannons, bots gang up on the leader.' },
    { id: 'timing', label: 'Phase timers', description: 'In seconds.' },
    { id: 'battle', label: 'Cannons & battle' },
    { id: 'building', label: 'Wall building', description: 'Discarding throws your current piece away (1 second cooldown). Pause between pieces stops click spamming.' },
    { id: 'castles', label: 'Castles & cannon rewards', description: 'New cannons you get each round, per castle you hold.', collapsed: true },
  ],
  settings: [
    // Match
    { type: 'number', key: 'lives', label: 'Lives', min: 1, max: 5, step: 1, default: 3, group: 'match' },
    { type: 'number', key: 'maxRounds', label: 'Max rounds', min: 3, max: 20, step: 1, default: 8, group: 'match' },
    {
      type: 'select', key: 'botSkill', label: 'Bot skill', default: 'normal', group: 'match',
      options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
    },
    {
      type: 'select', key: 'comeback', label: 'Comeback help', default: 'normal', group: 'comeback',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'normal', label: 'Normal' },
        { value: 'strong', label: 'Strong' },
      ],
    },
    // Timing
    { type: 'number', key: 'placeTime', label: 'Place cannons', min: 5, max: 30, step: 1, default: 12, group: 'timing' },
    { type: 'number', key: 'battleTime', label: 'Battle', min: 8, max: 40, step: 1, default: 18, group: 'timing' },
    { type: 'number', key: 'buildTime', label: 'Rebuild walls', min: 10, max: 60, step: 1, default: 25, group: 'timing' },
    // Battle
    { type: 'number', key: 'reload', label: 'Reload (seconds)', min: 0.8, max: 6, step: 0.1, default: 2.4, group: 'battle' },
    { type: 'number', key: 'ballSpeed', label: 'Cannonball speed', min: 200, max: 900, step: 10, default: 420, group: 'battle' },
    { type: 'number', key: 'cannonHp', label: 'Cannon hit points', min: 1, max: 4, step: 1, default: 2, group: 'battle' },
    // Wall building
    {
      type: 'select', key: 'discard', label: 'Discard pieces', default: 'any', group: 'building',
      options: [
        { value: 'any', label: 'Any time' },
        { value: 'stuck', label: 'Only when stuck' },
        { value: 'never', label: 'Never' },
      ],
    },
    { type: 'number', key: 'buildDelay', label: 'Pause between pieces (s)', min: 0, max: 3, step: 0.05, default: 1, group: 'building' },
    // Castles
    { type: 'number', key: 'cannonsHome', label: 'Home castle', min: 1, max: 4, step: 1, default: 2, group: 'castles' },
    { type: 'number', key: 'cannonsPerKeep', label: 'Each other castle', min: 0, max: 3, step: 1, default: 1, group: 'castles' },
    { type: 'number', key: 'maxCannons', label: 'Max cannons each', min: 4, max: 20, step: 1, default: 12, group: 'castles' },
  ],
};

export const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];

// ── geometry ──
export const COLS = 40;
export const ROWS = 28;
export const TILE = 20; // logical pixels per tile; the client scales the whole arena to fit
export const N = COLS * ROWS;
export const ARENA_W = COLS * TILE;
export const ARENA_H = ROWS * TILE;
export const HIT_R = 9.5; // cannonball blast radius in px: aimed at a tile centre it breaks that tile only, near an edge it can break 2-4

export const idx = (x, y) => y * COLS + x;
export const inb = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

/** Terrain: 0 = land (buildable), 1 = water (nothing can be built on it, but it never blocks an enclosure either). */
export const TERRAIN = new Uint8Array(N);
{
  const lake = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) TERRAIN[idx(x, y)] = 1; };
  lake(19, 10, 2, 8); // a channel down the middle
  for (const [x, y] of [[9, 14], [30, 14], [13, 3], [26, 3], [13, 23], [26, 23]]) lake(x, y, 2, 2);
}

/**
 * Castles ("keeps"), 2x2 tiles, (x, y) = top-left tile. Keeps 0..3 are the home castles of seats 0..3
 * (a home castle of an empty seat is simply a free castle to capture); keeps 4..7 are neutral.
 */
export const KEEPS = [
  { x: 6, y: 6 }, { x: 32, y: 6 }, { x: 6, y: 20 }, { x: 32, y: 20 },
  { x: 19, y: 3 }, { x: 19, y: 23 }, { x: 14, y: 12 }, { x: 24, y: 12 },
];
export const KEEP_AT = new Int8Array(N).fill(-1); // tile -> keep index
KEEPS.forEach((k, i) => { for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) KEEP_AT[idx(k.x + dx, k.y + dy)] = i; });

/** The wall ring that encloses a keep: an 8x8 square, 3 tiles away from the keep. (Its 4 corner tiles are optional: a diagonal gap does not leak.) */
export const RING_MARGIN = 3;
export const ringRect = (k) => ({ x0: KEEPS[k].x - RING_MARGIN, y0: KEEPS[k].y - RING_MARGIN, x1: KEEPS[k].x + 1 + RING_MARGIN, y1: KEEPS[k].y + 1 + RING_MARGIN });
export const RING_TILES = KEEPS.map((_, k) => {
  const { x0, y0, x1, y1 } = ringRect(k);
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
      if (inb(x, y) && !TERRAIN[idx(x, y)]) out.push(idx(x, y));
    }
  }
  return out;
});
/**
 * Protected zones. While a castle belongs to a living player, nobody else may put a wall piece in its ring or in
 * the ZONE_PAD tiles just outside it, even where the ring is broken. (Without this you could plug the holes in
 * somebody's wall and stop them from closing their castle.)
 */
export const ZONE_PAD = 1;
/** tile -> the keeps whose zone covers it (zones of neighbouring castles can overlap) */
export const ZONE_KEEPS = Array.from({ length: N }, () => []);
KEEPS.forEach((_, k) => {
  const { x0, y0, x1, y1 } = ringRect(k);
  for (let y = y0 - ZONE_PAD; y <= y1 + ZONE_PAD; y++) for (let x = x0 - ZONE_PAD; x <= x1 + ZONE_PAD; x++) if (inb(x, y)) ZONE_KEEPS[idx(x, y)].push(k);
});
/** Is tile `i` in the zone of a castle that a living player other than `slot` owns? (keepOwner: keep index -> slot or -1) */
export function inForeignZone(slot, i, keepOwner, alive) {
  for (const k of ZONE_KEEPS[i]) {
    const o = keepOwner[k];
    if (o >= 0 && o !== slot && alive[o]) return true;
  }
  return false;
}

export const isRingCorner = (k, x, y) => {
  const { x0, y0, x1, y1 } = ringRect(k);
  return (x === x0 || x === x1) && (y === y0 || y === y1);
};

// ── wall pieces (Tetris-style) ──
export const PIECES = [
  [[0, 0]], //                                    0 single
  [[0, 0], [1, 0]], //                            1 domino
  [[0, 0], [1, 0], [2, 0]], //                    2 bar of 3
  [[0, 0], [1, 0], [0, 1]], //                    3 small corner
  [[0, 0], [1, 0], [2, 0], [3, 0]], //            4 bar of 4
  [[0, 0], [0, 1], [0, 2], [1, 2]], //            5 L
  [[1, 0], [1, 1], [1, 2], [0, 2]], //            6 J
  [[0, 0], [1, 0], [2, 0], [1, 1]], //            7 T
  [[1, 0], [2, 0], [0, 1], [1, 1]], //            8 S
  [[0, 0], [1, 0], [1, 1], [2, 1]], //            9 Z
  [[0, 0], [1, 0], [0, 1], [1, 1]], //            10 square
  [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]], //    11 plus
  [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], //    12 big corner
  [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]], //    13 U
];
export const PIECE_WEIGHTS = [4, 6, 6, 9, 3, 8, 8, 8, 6, 6, 5, 2, 3, 3];

const rotCache = new Map();
/** The cells of piece `type` turned `rot` quarter-turns clockwise, shifted so the bounding box starts at (0,0). Returns [[x,y],...]. */
export function pieceCells(type, rot) {
  const key = type * 4 + (rot & 3);
  let c = rotCache.get(key);
  if (c) return c;
  c = PIECES[type].map(([x, y]) => [x, y]);
  for (let r = 0; r < (rot & 3); r++) c = c.map(([x, y]) => [-y, x]);
  const mx = Math.min(...c.map((p) => p[0]));
  const my = Math.min(...c.map((p) => p[1]));
  c = c.map(([x, y]) => [x - mx, y - my]);
  rotCache.set(key, c);
  return c;
}
export const pieceSize = (cells) => ({ w: Math.max(...cells.map((c) => c[0])) + 1, h: Math.max(...cells.map((c) => c[1])) + 1 });

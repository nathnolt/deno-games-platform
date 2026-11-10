// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.
//
// BOMBERS: a Bomberman-style arena game. Walk the maze, drop bombs to blow up crates and each other.
// Crates hide power-ups (more bombs, longer blasts, speed, kick). Last one standing wins the round;
// first to N round wins takes the match. When the round clock runs out, sudden death walls close in.
//
// Coordinates: tile (x, y) has its centre at (x, y), so it spans [x - 0.5, x + 0.5]. Players and sliding bombs
// have float positions in tile units; everything else sits on a tile index i = y * w + x.

// ── meta ──
/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'bombers',
  name: 'Bombers',
  description: 'Drop bombs, blow up crates, grab power-ups and be the last one standing. Arrow keys / WASD + Space, or touch.',
  minPlayers: 2, // filled seats (players + bots)
  maxPlayers: 4,
  seatNames: ['Red', 'Blue', 'Green', 'Gold'],
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'],
  tickRate: 30,
  soloSettings: {}, // Play solo = you + bots in the other seats
  settingGroups: [
    { id: 'match', label: 'Match', description: 'Last one standing wins a round. First to the target number of round wins takes the match.' },
    { id: 'arena', label: 'Arena', description: 'Sudden death: when the round clock runs out, walls spiral in from the edges. Off: the round ends in a draw.' },
    { id: 'power', label: 'Bombs & power-ups', description: 'Power-ups hide in crates: extra bomb, longer blast, speed, kick (walk into a bomb to send it sliding).', collapsed: true },
  ],
  settings: [
    { type: 'number', key: 'roundsToWin', label: 'Round wins needed', min: 1, max: 7, step: 1, default: 3, group: 'match' },
    { type: 'number', key: 'roundTime', label: 'Round time (s)', min: 45, max: 300, step: 15, default: 120, group: 'match' },
    {
      type: 'select', key: 'botSkill', label: 'Bot skill', default: 'normal', group: 'match',
      options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
    },
    {
      type: 'select', key: 'arena', label: 'Arena size', default: 'classic', group: 'arena',
      options: [{ value: 'small', label: 'Small (13×11)' }, { value: 'classic', label: 'Classic (15×13)' }, { value: 'large', label: 'Large (19×15)' }],
    },
    { type: 'number', key: 'crates', label: 'Crates (%)', min: 20, max: 95, step: 5, default: 70, group: 'arena' },
    { type: 'boolean', key: 'suddenDeath', label: 'Sudden death', default: true, group: 'arena' },
    { type: 'number', key: 'powerups', label: 'Crates with a power-up (%)', min: 0, max: 70, step: 5, default: 35, group: 'power' },
    { type: 'boolean', key: 'kick', label: 'Kick power-up', default: true, group: 'power' },
    { type: 'number', key: 'startBombs', label: 'Starting bombs', min: 1, max: 5, step: 1, default: 1, group: 'power' },
    { type: 'number', key: 'startFire', label: 'Starting blast range', min: 1, max: 6, step: 1, default: 2, group: 'power' },
    { type: 'number', key: 'fuse', label: 'Bomb fuse (s)', min: 1.5, max: 4, step: 0.1, default: 2.4, group: 'power' },
  ],
};

export const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];

// ── arena ──
export const ARENAS = { small: { w: 13, h: 11 }, classic: { w: 15, h: 13 }, large: { w: 19, h: 15 } };
export const arenaOf = (key) => ARENAS[key] ?? ARENAS.classic;

/** Tile kinds in the grid string the server sends: '0' floor, '1' solid wall, '2' crate. */
export const FLOOR = 0;
export const SOLID = 1;
export const CRATE = 2;

/** Is (x, y) a permanent wall: the border, or a pillar on every even/even tile inside. */
export const isPillar = (w, h, x, y) => x === 0 || y === 0 || x === w - 1 || y === h - 1 || (x % 2 === 0 && y % 2 === 0);

/** Spawn tiles, one per seat (the four corners). */
export const spawnsOf = (w, h) => [[1, 1], [w - 2, h - 2], [w - 2, 1], [1, h - 2]];

/**
 * Sudden death order: every inner tile, spiralling inward from the outer ring, clockwise from the top-left.
 * Returns tile indices. Pillars are included (they are already walls, the server simply skips them quickly).
 */
export function spiralOf(w, h) {
  const out = [];
  let x0 = 1, y0 = 1, x1 = w - 2, y1 = h - 2;
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) out.push(y0 * w + x);
    for (let y = y0 + 1; y <= y1; y++) out.push(y * w + x1);
    if (y1 > y0) for (let x = x1 - 1; x >= x0; x--) out.push(y1 * w + x);
    if (x1 > x0) for (let y = y1 - 1; y > y0; y--) out.push(y * w + x0);
    x0++; y0++; x1--; y1--;
  }
  return out;
}
/** Seconds between two sudden-death walls. */
export const SD_INTERVAL = 0.25;

// ── directions ── 0 none, 1 up, 2 right, 3 down, 4 left
export const DX = [0, 0, 1, 0, -1];
export const DY = [0, -1, 0, 1, 0];

// ── power-ups ──
export const PU_BOMB = 1;
export const PU_FIRE = 2;
export const PU_SPEED = 3;
export const PU_KICK = 4;
export const MAX_BOMBS = 8;
export const MAX_FIRE = 8;
export const MAX_SPEED = 4; // speed level 0..4

/** Walking speed in tiles per second for a speed level. */
export const speedOf = (lvl) => 3.6 + 0.55 * lvl;

/** How long flames stay on a tile, in seconds. */
export const FLAME_TIME = 0.55;
/** Sliding (kicked) bomb speed in tiles per second. */
export const SLIDE_SPEED = 8;

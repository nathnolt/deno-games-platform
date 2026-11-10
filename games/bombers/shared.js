// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.
import { LEVELS, THEME_KEYS, THEME_NAMES } from './levels.js';
//
// BOMBERS: a Bomberman-style game with two modes.
//   Battle  last one standing wins the round; first to N round wins takes the match. Sudden death walls close in
//           when the round clock runs out.
//   Co-op   everybody against the monsters, through hand-made levels (levels.js). Kill every monster, find the exit
//           under a crate, and EVERYONE walks into it. No timer. Power-ups are placed in each level and you keep
//           them into the next one. Each player has lives; monsters give points, and points give extra lives.
// The Skull (both modes) gives you a random curse for a while, and the curse spreads to anyone you touch.
//
// Coordinates: tile (x, y) has its centre at (x, y), so it spans [x - 0.5, x + 0.5]. Players, monsters and sliding
// bombs have float positions in tile units; everything else sits on a tile index i = y * w + x.

// ── meta ──
/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'bombers',
  name: 'Bombers',
  description: 'Battle each other or team up against monsters. Drop bombs, break crates, grab power-ups, beware the skull. Arrow keys / WASD + Space, or touch.',
  minPlayers: 1, // co-op works alone; battle needs 2 filled seats (checked in canStart)
  maxPlayers: 4,
  seatNames: ['Red', 'Blue', 'Green', 'Gold'],
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'],
  tickRate: 30,
  soloSettings: {}, // Play solo = you + bots in the other seats (opponents in battle, team-mates in co-op)
  settingGroups: [
    { id: 'battle', label: 'Battle mode', description: 'Last one standing wins a round. Round time 0 = no clock. Sudden death: when the clock runs out, walls spiral in (off: the round is a draw).' },
    { id: 'coop', label: 'Co-op mode', description: `${LEVELS.length} hand-made levels, no timer. Kill every monster, then everybody walks into the exit (hidden under a crate). Bombing the open exit releases more monsters. Power-ups are kept between levels.` },
    { id: 'arena', label: 'Battle arena', description: 'Co-op levels have their own maps and themes.' },
    { id: 'power', label: 'Bombs & power-ups', description: 'Skull: a random curse for 15 s (slow, too fast, reversed controls, bomb diarrhea, no bombs, weak bombs, short fuse). Touching someone passes it on.', collapsed: true },
  ],
  settings: [
    {
      type: 'select', key: 'mode', label: 'Mode', default: 'battle',
      options: [{ value: 'battle', label: 'Battle (everyone for themselves)' }, { value: 'coop', label: 'Co-op (team vs monsters)' }],
    },
    {
      type: 'select', key: 'botSkill', label: 'Bot skill', default: 'normal',
      options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
    },
    // battle
    { type: 'number', key: 'roundsToWin', label: 'Round wins needed', min: 1, max: 7, step: 1, default: 3, group: 'battle' },
    { type: 'number', key: 'roundTime', label: 'Round time (s, 0 = none)', min: 0, max: 300, step: 15, default: 120, group: 'battle' },
    { type: 'boolean', key: 'suddenDeath', label: 'Sudden death', default: true, group: 'battle' },
    { type: 'number', key: 'powerups', label: 'Crates with a power-up (%)', min: 0, max: 70, step: 5, default: 35, group: 'battle' },
    // co-op
    { type: 'number', key: 'lives', label: 'Lives', min: 1, max: 9, step: 1, default: 3, group: 'coop' },
    { type: 'number', key: 'startLevel', label: 'Start at level', min: 1, max: LEVELS.length, step: 1, default: 1, group: 'coop' },
    {
      type: 'select', key: 'monsterSpeed', label: 'Monster speed', default: 'slow', group: 'coop',
      options: [{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }],
    },
    {
      type: 'select', key: 'lifeEvery', label: 'Extra life every', default: '5000', group: 'coop',
      options: [{ value: '0', label: 'Never' }, { value: '3000', label: '3,000 points' }, { value: '5000', label: '5,000 points' }, { value: '10000', label: '10,000 points' }, { value: '20000', label: '20,000 points' }],
    },
    {
      type: 'select', key: 'deathPenalty', label: 'On death', default: 'one', group: 'coop',
      options: [{ value: 'none', label: 'Keep power-ups' }, { value: 'one', label: 'Lose one of each' }, { value: 'all', label: 'Lose all power-ups' }],
    },
    { type: 'boolean', key: 'friendlyFire', label: 'Team-mates\' bombs hurt you', default: false, group: 'coop' },
    // arena
    {
      type: 'select', key: 'arena', label: 'Arena size', default: 'classic', group: 'arena',
      options: [{ value: 'small', label: 'Small (13×11)' }, { value: 'classic', label: 'Classic (15×13)' }, { value: 'large', label: 'Large (19×15)' }],
    },
    { type: 'number', key: 'crates', label: 'Crates (%)', min: 20, max: 95, step: 5, default: 70, group: 'arena' },
    {
      type: 'select', key: 'theme', label: 'Theme', default: 'random', group: 'arena',
      options: [{ value: 'random', label: 'Different every round' }, ...THEME_KEYS.map((k) => ({ value: k, label: THEME_NAMES[k] }))],
    },
    // power-ups
    { type: 'boolean', key: 'curses', label: 'Skull power-up', default: true, group: 'power' },
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

/** Sudden death order: every inner tile, spiralling inward from the outer ring. Returns tile indices. */
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
export const OPP = [0, 3, 4, 1, 2];

// ── power-ups ──
export const PU_BOMB = 1;
export const PU_FIRE = 2;
export const PU_SPEED = 3;
export const PU_KICK = 4;
export const PU_SKULL = 5;
export const PU_LIFE = 6; // co-op only
export const MAX_BOMBS = 8;
export const MAX_FIRE = 8;
export const MAX_SPEED = 4; // speed level 0..4
export const MAX_LIVES = 9;

/** Walking speed in tiles per second for a speed level. */
export const speedOf = (lvl) => 3.6 + 0.55 * lvl;

// ── skull curses ── (index 0 = no curse)
export const C_SLOW = 1;
export const C_FAST = 2;
export const C_REVERSE = 3;
export const C_DIARRHEA = 4;
export const C_NOBOMB = 5;
export const C_WEAK = 6;
export const C_FUSE = 7;
export const CURSES = ['', 'Slow feet', 'Way too fast', 'Reversed controls', 'Bomb diarrhea', 'No bombs', 'Weak bombs', 'Short fuse'];
export const CURSE_TIME = 15;
export const CURSE_SPEED = { [C_SLOW]: 1.7, [C_FAST]: 8 };
export const SHORT_FUSE = 1;

// ── monsters (co-op) ── index = the type id sent in snapshots
// behaviour: wander = random walk · dash = straight until blocked · chase = walks to the nearest player
//            phase = drifts through crates toward players · smart = dodges blasts and hunts
export const MONSTERS = [ // speeds in tiles per second at "slow" (players walk 3.6)
  { key: 'blob', name: 'Blob', speed: 0.8, points: 100, behaviour: 'wander' },
  { key: 'chaser', name: 'Chaser', speed: 1.15, points: 200, behaviour: 'chase' },
  { key: 'dasher', name: 'Dasher', speed: 1.9, points: 300, behaviour: 'dash' },
  { key: 'ghost', name: 'Ghost', speed: 0.7, points: 400, behaviour: 'phase' },
  { key: 'sneak', name: 'Sneak', speed: 1.4, points: 800, behaviour: 'smart' },
];
/** Monster speed setting -> multiplier. */
export const MONSTER_SPEED = { slow: 1, normal: 1.45, fast: 1.9 };
export const M_BLOB = 0;
export const M_CHASER = 1;
export const M_DASHER = 2;
export const M_GHOST = 3;
export const M_SNEAK = 4;

export { LEVELS, THEME_KEYS, THEME_NAMES };

/** How long flames stay on a tile, in seconds. */
export const FLAME_TIME = 0.55;
/** Sliding (kicked) bomb speed in tiles per second. */
export const SLIDE_SPEED = 8;

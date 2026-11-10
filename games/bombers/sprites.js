// Client only. Pixel-art sprites for Bombers, drawn as text: one character = one pixel, '.' = transparent.
// Every sprite gets a dark outline added automatically around its shape, so the art below is fill only.
// Symmetric sprites are written as their LEFT HALF (8 columns) and mirrored. Sprites are 16×16 (one tile).

export const PX = 16; // pixels per tile in the low-res frame

const BASE = {
  k: '#14101e', w: '#f8fafc', W: '#cbd5e1', g: '#94a3b8', G: '#5b6576', d: '#232a3b', D: '#151a26',
  y: '#fde047', Y: '#d4a017', o: '#fb923c', O: '#c2410c', r: '#ef4444', R: '#991b1b', e: '#fecaca',
  p: '#f472b6', P: '#be185d', b: '#60a5fa', B: '#1d4ed8', n: '#4ade80', N: '#15803d',
  v: '#c084fc', V: '#6d28d9', t: '#5eead4', T: '#0f766e', s: '#fcd9b8',
};

const sym = (half) => half.map((row) => row + [...row].reverse().join(''));
const fix = (rows, w) => rows.map((r) => (r.length >= w ? r.slice(0, w) : r + '.'.repeat(w - r.length)));
const swap = (rows, at, repl) => rows.map((r, i) => (repl[i - at] !== undefined ? repl[i - at] : r));

// ── players ── C = seat colour, c = dark, L = light (filled in per seat)
const P_DOWN = sym([
  '........',
  '.......L',
  '.......L',
  '.......c',
  '......CC',
  '....CLCC',
  '...CLCCC',
  '...Cwwww',
  '..Cwwkww',
  '..Cwwkww',
  '..cCwwww',
  '...cCCCC',
  '....cCCC',
  '.....cc.',
  '....ccc.',
  '........',
]);
const LEGS_A = ['.....cc..cc.....', '....ccc..cc.....'];
const LEGS_B = ['.....cc..cc.....', '.....cc..ccc....'];
const P_UP = swap(P_DOWN, 7, ['...CCCCCCCCCC...', '..CCCLCCCCCCCC..', '..CCCCCCCCCCCC..', '..cCCCCCCCCCCc..']);
const P_SIDE = fix([
  '................',
  '......LL........',
  '......LL........',
  '.......c........',
  '......CCCC......',
  '....CLCCCCC.....',
  '...CLCCCCCCC....',
  '...CCCCwwwwwC...',
  '..CCCCwwwkwwC...',
  '..CCCCwwwkwwC...',
  '..cCCCwwwwwwc...',
  '...cCCCCCCCc....',
  '....cCCCCCc.....',
  '.....cc.cc......',
  '....ccc.ccc.....',
  '................',
], 16);
const SIDE_A = ['.....cc..cc.....', '....ccc...cc....'];
const SIDE_B = ['......c.cc......', '.....cc.ccc.....'];

export const PLAYER = {
  down: [P_DOWN, swap(P_DOWN, 13, LEGS_A), P_DOWN, swap(P_DOWN, 13, LEGS_B)],
  up: [P_UP, swap(P_UP, 13, LEGS_A), P_UP, swap(P_UP, 13, LEGS_B)],
  side: [P_SIDE, swap(P_SIDE, 13, SIDE_A), P_SIDE, swap(P_SIDE, 13, SIDE_B)],
};

export const GHOST_PLAYER = sym([
  '........',
  '........',
  '......ww',
  '....wwww',
  '...wwwww',
  '...wkkww',
  '..wwkkww',
  '..wwwwww',
  '..wwwwwk',
  '..wwwwww',
  '..wwwwww',
  '..wwwwww',
  '..w.www.',
  '..w..w..',
  '........',
  '........',
]);

// ── monsters ── (two animation frames each, index = monster type)
const BLOB0 = sym([
  '........',
  '........',
  '........',
  '......pp',
  '....pppp',
  '...ppppp',
  '..ppwwpp',
  '..ppwkpp',
  '..pppppp',
  '..ppppPP',
  '..pppppp',
  '..Pppppp',
  '...PPppp',
  '..PP.PPP',
  '........',
  '........',
]);
const BLOB1 = swap(BLOB0, 3, ['................', '......pppp......', '....pppppppp....', '...pppppppppp...', '..ppwwppppwwpp..', '..ppwkppppkwpp..', '..pppppppppppp..', '..ppppPPPPpppp..', '.pppppppppppppp.', '.PPpppppppppppP.', '..PPPPPPPPPPPP..']);
const CHASER0 = sym([
  '........',
  '...o....',
  '...oo..o',
  '...ooooo',
  '..oooooo',
  '..okkooo',
  '..owwkoo',
  '..owwkoo',
  '..oooooo',
  '..ooOOOO',
  '..oOwOwO',
  '..oooooo',
  '...Ooooo',
  '...OO..O',
  '..OOO...',
  '........',
]);
const CHASER1 = swap(CHASER0, 13, ['....OO....OO....', '...OOO....OOO...']);
const DASHER0 = sym([
  '........',
  '........',
  '........',
  '....bbbb',
  '...bbbbb',
  '..bbbbbb',
  '..byyyyy',
  '..bykyyy',
  '..bbbbbb',
  '..bBbbbb',
  '..bBBbbb',
  '...BBBBB',
  '....kk..',
  '....kk..',
  '........',
  '........',
]);
const DASHER1 = swap(DASHER0, 12, ['.....kk..kk.....', '.....kk..kk.....']);
const GHOSTM0 = sym([
  '........',
  '........',
  '.....www',
  '...wwwww',
  '..wwwwww',
  '..wwkkww',
  '..wwkkww',
  '..wwwwww',
  '..wwwwkk',
  '..wwwwkk',
  '..wwwwww',
  '..wwwwww',
  '..wwwwww',
  '..w.ww.w',
  '........',
  '........',
]);
const GHOSTM1 = swap(GHOSTM0, 13, ['..ww.ww..ww.ww..']);
const SNEAK0 = sym([
  '........',
  '........',
  '.....vvv',
  '...vvvvv',
  '..vvvvvv',
  '..VVVVVV',
  '..vwwkvv',
  '..vvvvvv',
  '..Vvvvvv',
  '..VVvvvv',
  '...VVvvv',
  '...yyyyy',
  '...VVVVV',
  '....VV..',
  '...VVV..',
  '........',
]);
const SNEAK1 = swap(SNEAK0, 13, ['.....VV..VV.....', '....VVV..VVV....']);
export const MONSTER = [[BLOB0, BLOB1], [CHASER0, CHASER1], [DASHER0, DASHER1], [GHOSTM0, GHOSTM1], [SNEAK0, SNEAK1]];

// ── power-up icons (12×12) ──
export const ICONS = {
  1: fix([ // bomb
    '............',
    '.........y..',
    '........y.y.',
    '.......W....',
    '....kkkW....',
    '...kkkkkk...',
    '..kWkkkkkk..',
    '..kWkkkkkk..',
    '..kkkkkkkk..',
    '..kkkkkkkk..',
    '...kkkkkk...',
    '....kkkk....',
  ], 12),
  2: sym([ // fire
    '......',
    '.....r',
    '....rr',
    '...rro',
    '..rroo',
    '..rooy',
    '.rooyy',
    '.rooyy',
    '.rooyw',
    '..rooy',
    '...rro',
    '......',
  ]),
  3: fix([ // speed: lightning bolt
    '............',
    '......yyy...',
    '.....yyy....',
    '....yyy.....',
    '...yyyyyy...',
    '......yyy...',
    '.....yyy....',
    '....yyy.....',
    '...yy.......',
    '..y.........',
    '............',
    '............',
  ], 12),
  4: fix([ // kick: boot
    '............',
    '...WWWW.....',
    '...WWWW.....',
    '...WWWW.....',
    '...WWWW.....',
    '...WWWWW....',
    '...WWWWWWW..',
    '..WWWWWWWWW.',
    '..WWWWWWWWW.',
    '..GGGGGGGGG.',
    '............',
    '............',
  ], 12),
  5: sym([ // skull
    '......',
    '...www',
    '..wwww',
    '.wwwww',
    '.wkkww',
    '.wkkww',
    '.wwwwk',
    '..wwww',
    '...wkw',
    '...www',
    '......',
    '......',
  ]),
  6: sym([ // heart
    '......',
    '......',
    '..rr..',
    '.rrrr.',
    'rrerrr',
    'rerrrr',
    'rrrrrr',
    '.rrrrr',
    '..rrrr',
    '...rrr',
    '....rr',
    '......',
  ]),
  star: sym([
    '......',
    '.....y',
    '.....y',
    '....yy',
    'yyyyyy',
    '.yyyyy',
    '..yyyy',
    '..yyyy',
    '.yyy.y',
    '.yy...',
    '......',
    '......',
  ]),
  monster: sym([
    '......',
    '......',
    '....pp',
    '..pppp',
    '.ppwwp',
    '.ppwkp',
    '.ppppp',
    '.ppppP',
    '.ppppp',
    '.PpPPp',
    '......',
    '......',
  ]),
};
/** Background colour of each power-up's tile. */
export const ICON_BG = { 1: '#1d4ed8', 2: '#9a3412', 3: '#0f766e', 4: '#6d28d9', 5: '#3b0764', 6: '#1f2937' };

// ── 3×5 pixel digits, for score pop-ups ──
export const DIGITS = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '011', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'], 8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'], '+': ['000', '010', '111', '010', '000'],
};

// ── building canvases ──
const cache = new Map();

/** Renders `rows` with `pal` (char -> colour) into a canvas, with an automatic outline. Cached by `key`. */
export function sprite(key, rows, pal = {}, outline = true) {
  let c = cache.get(key);
  if (c) return c;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const colours = { ...BASE, ...pal };
  const solid = (x, y) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] !== undefined && rows[y][x] !== '.';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch !== undefined && ch !== '.') {
        g.fillStyle = colours[ch] ?? '#ff00ff';
        g.fillRect(x, y, 1, 1);
      } else if (outline && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) {
        g.fillStyle = BASE.k;
        g.fillRect(x, y, 1, 1);
      }
    }
  }
  cache.set(key, c);
  return c;
}

/** A sprite mirrored left-right (cached). */
export function mirrored(key, src) {
  let c = cache.get(`${key}|m`);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  cache.set(`${key}|m`, c);
  return c;
}

/** A solid-colour silhouette of a sprite (hit flashes). */
export function silhouette(key, src, colour = '#ffffff') {
  let c = cache.get(`${key}|s${colour}`);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, c.width, c.height);
  cache.set(`${key}|s${colour}`, c);
  return c;
}

/** The power-up tile (16×16): a framed box with the icon. */
export function itemTile(type, blink = false) {
  const key = `item${type}${blink ? 'b' : ''}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = PX;
  c.height = PX;
  const g = c.getContext('2d');
  g.fillStyle = BASE.k;
  g.fillRect(1, 1, 14, 14);
  g.fillStyle = blink ? '#7c3aed' : '#e2e8f0';
  g.fillRect(2, 2, 12, 12);
  g.fillStyle = ICON_BG[type] ?? '#334155';
  g.fillRect(3, 3, 10, 10);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(3, 3, 10, 1);
  g.drawImage(sprite(`icon${type}`, ICONS[type], {}, false), 2, 2);
  cache.set(key, c);
  return c;
}

/** A 12×12 icon as a data URL, scaled up crisply, for the HTML HUD. */
export function iconURL(type, scale = 2) {
  const key = `url${type}x${scale}`;
  let u = cache.get(key);
  if (u) return u;
  const src = sprite(`hud${type}`, ICONS[type], {}, true);
  const c = document.createElement('canvas');
  c.width = src.width * scale;
  c.height = src.height * scale;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, c.width, c.height);
  u = c.toDataURL();
  cache.set(key, u);
  return u;
}

/** Palette for a seat colour (main / dark / light); `cursed` swaps in a sickly green. */
export function seatPalette(hex, cursed = false) {
  if (cursed) return { C: '#84cc16', c: '#3f6212', L: '#d9f99d' };
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const to = (f, t) => `#${v.map((x) => Math.round(x + (t - x) * f).toString(16).padStart(2, '0')).join('')}`;
  return { C: hex, c: to(0.45, 0), L: to(0.45, 255) };
}

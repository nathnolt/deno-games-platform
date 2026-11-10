// Client only. Level themes: how the floor, solid blocks, crates and the outer wall are drawn, in pixels
// (16×16 per tile, see sprites.js). Each theme is a set of small drawing functions on the low-res canvas:
//   floor(g, px, py, x, y, r)   block(g, px, py, r)   crate(g, px, py, r)   wall(g, px, py, x, y, r)
// `r(k)` is a stable random number 0..1 for this tile (so the decoration never flickers).
// To add a theme: add an entry here, add its key to THEME_KEYS in levels.js, and use it in a level.

const box = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

/** A block with a lit top, a darker front face and side shading: the shape shared by most solid blocks. */
function bevel(g, px, py, { base, top, front, side, edge }) {
  box(g, base, px, py, 16, 16);
  box(g, top, px, py, 16, 2);
  box(g, top, px, py, 1, 12);
  box(g, front, px, py + 12, 16, 4);
  box(g, side, px + 15, py, 1, 12);
  box(g, edge, px, py + 12, 16, 1);
}

/** Bricks for the outer walls. */
function bricks(g, px, py, x, y, { base, mortar, top }) {
  box(g, base, px, py, 16, 16);
  for (let row = 0; row < 4; row++) {
    box(g, top, px, py + row * 4, 16, 1);
    box(g, mortar, px, py + row * 4 + 3, 16, 1);
    box(g, mortar, px + ((row + x + y) % 2 ? 3 : 11), py + row * 4, 1, 3);
  }
}

/** A few 1-pixel specks on the floor. */
function specks(g, px, py, r, colours, n) {
  for (let k = 0; k < n; k++) box(g, colours[k % colours.length], px + Math.floor(r(k) * 15), py + 2 + Math.floor(r(k + 9) * 13), 1, 1);
}

export const THEMES = {
  // ── grass: stone blocks, wooden crates ──
  grass: {
    bg: '#0b1020', accent: '#4ade80', debris: ['#c47b37', '#4a2a0c'],
    floor(g, px, py, x, y, r) {
      box(g, (x + y) % 2 ? '#3d8a48' : '#398143', px, py, 16, 16);
      specks(g, px, py, r, ['#4fa25b', '#4fa25b', '#2f6e39'], 5);
      if (r(20) < 0.25) { box(g, '#f9a8d4', px + 4 + Math.floor(r(21) * 8), py + 5 + Math.floor(r(22) * 7), 1, 1); } // a flower
    },
    block(g, px, py) {
      bevel(g, px, py, { base: '#8b94a5', top: '#c3cad5', front: '#5c6677', side: '#6b7586', edge: '#4a5364' });
      box(g, '#9da6b5', px + 4, py + 4, 8, 5);
      box(g, '#b5bdc9', px + 4, py + 4, 8, 1);
      box(g, '#7a8394', px + 4, py + 9, 8, 1);
    },
    crate(g, px, py, r) {
      box(g, '#4a2a0c', px, py, 16, 16);
      box(g, r(1) < 0.5 ? '#b8702f' : '#c47b37', px + 1, py + 1, 14, 11);
      box(g, '#8a4f1e', px + 1, py + 12, 14, 3);
      box(g, '#e1a463', px + 1, py + 1, 14, 1);
      box(g, '#975a26', px + 1, py + 5, 14, 1);
      box(g, '#975a26', px + 1, py + 9, 14, 1);
      for (let k = 0; k < 9; k++) box(g, '#d18a45', px + 3 + k, py + 10 - k, 2, 1);
      for (const [nx, ny] of [[2, 2], [13, 2], [2, 10], [13, 10]]) box(g, '#4a2a0c', px + nx, py + ny, 1, 1);
      box(g, '#6b3d14', px + 1, py + 12, 14, 1);
    },
    wall(g, px, py, x, y) { bricks(g, px, py, x, y, { base: '#626a7b', mortar: '#3f4552', top: '#7b8495' }); },
  },

  // ── desert: sandstone with carvings, clay pots ──
  desert: {
    bg: '#1c140c', accent: '#fbbf24', debris: ['#c2603a', '#7a3519'],
    floor(g, px, py, x, y, r) {
      box(g, (x + y) % 2 ? '#dcb872' : '#d6b16a', px, py, 16, 16);
      specks(g, px, py, r, ['#ecd29a', '#b8914c', '#ecd29a'], 6);
      if (r(30) < 0.45) { // a ripple in the sand
        const rx = px + 2 + Math.floor(r(31) * 8);
        const ry = py + 4 + Math.floor(r(32) * 9);
        box(g, '#c49a55', rx, ry, 4, 1);
        box(g, '#c49a55', rx + 4, ry - 1, 2, 1);
      }
    },
    block(g, px, py, r) {
      bevel(g, px, py, { base: '#c9944f', top: '#e8bd7c', front: '#8f6232', side: '#a87840', edge: '#6e4823' });
      // a carved glyph
      const k = Math.floor(r(3) * 3);
      box(g, '#8f6232', px + 5, py + 4, 6, 1);
      if (k === 0) { box(g, '#8f6232', px + 5, py + 5, 1, 4); box(g, '#8f6232', px + 10, py + 5, 1, 4); box(g, '#8f6232', px + 7, py + 6, 2, 2); }
      else if (k === 1) { box(g, '#8f6232', px + 7, py + 5, 2, 5); box(g, '#8f6232', px + 5, py + 7, 6, 1); }
      else { box(g, '#8f6232', px + 5, py + 9, 6, 1); box(g, '#8f6232', px + 6, py + 6, 4, 1); box(g, '#8f6232', px + 7, py + 7, 2, 2); }
    },
    crate(g, px, py) { // clay pot
      box(g, '#7a3519', px + 4, py + 1, 8, 2);
      box(g, '#9c4a26', px + 5, py + 1, 6, 1);
      box(g, '#7a3519', px + 5, py + 3, 6, 1);
      box(g, '#7a3519', px + 2, py + 4, 12, 11);
      box(g, '#7a3519', px + 3, py + 15, 10, 1);
      box(g, '#b5562e', px + 3, py + 4, 10, 10);
      box(g, '#b5562e', px + 4, py + 14, 8, 1);
      box(g, '#d9774a', px + 4, py + 5, 2, 5);
      box(g, '#e8c48a', px + 3, py + 8, 10, 1); // painted band
      box(g, '#8f3d1f', px + 11, py + 6, 1, 7);
    },
    wall(g, px, py, x, y) { bricks(g, px, py, x, y, { base: '#b07d43', mortar: '#7d5427', top: '#d0a060' }); },
  },

  // ── ice: ice blocks, snow-capped ice cubes ──
  ice: {
    bg: '#06121c', accent: '#7dd3fc', debris: ['#e0f2fe', '#7cc4e4'],
    floor(g, px, py, x, y, r) {
      box(g, (x + y) % 2 ? '#cfe9f5' : '#c5e3f1', px, py, 16, 16);
      if (r(40) < 0.5) { // a crack
        let cx = px + 2 + Math.floor(r(41) * 10);
        let cy = py + 3 + Math.floor(r(42) * 8);
        for (let k = 0; k < 4; k++) { box(g, '#9ccbe0', cx, cy, 1, 1); cx += 1; cy += r(43 + k) < 0.5 ? 1 : 0; }
      }
      specks(g, px, py, r, ['#ffffff', '#ffffff', '#b2d9ea'], 4);
    },
    block(g, px, py) {
      bevel(g, px, py, { base: '#7cc4e4', top: '#e0f6ff', front: '#3f8fb8', side: '#5aa9cf', edge: '#2f7299' });
      for (let k = 0; k < 5; k++) box(g, '#c4ecfb', px + 3 + k, py + 9 - k, 1, 1); // shine
      for (let k = 0; k < 3; k++) box(g, '#c4ecfb', px + 8 + k, py + 9 - k, 1, 1);
      box(g, '#ffffff', px + 3, py + 3, 1, 1);
    },
    crate(g, px, py, r) { // frosted wooden crate under a cap of snow
      box(g, '#3b2a1e', px, py + 1, 16, 15);
      box(g, '#9a7656', px + 1, py + 2, 14, 10);
      box(g, '#6e5038', px + 1, py + 12, 14, 3);
      box(g, '#7d5c41', px + 1, py + 7, 14, 1);
      for (let k = 0; k < 8; k++) box(g, '#b39072', px + 3 + k, py + 11 - k, 2, 1);
      box(g, '#cfe6f2', px + 2, py + 9, 1, 2); // frost
      box(g, '#cfe6f2', px + 12, py + 10, 2, 1);
      box(g, '#ffffff', px, py, 16, 4); // snow cap
      box(g, '#dbe9f0', px, py + 3, 16, 1);
      box(g, '#ffffff', px + 2 + Math.floor(r(5) * 4), py + 4, 2, 2); // drips
      box(g, '#ffffff', px + 10 + Math.floor(r(6) * 3), py + 4, 1, 3);
    },
    wall(g, px, py, x, y) { bricks(g, px, py, x, y, { base: '#5d8fb0', mortar: '#3a6684', top: '#9ccbe6' }); },
  },

  // ── castle: stone columns, barrels, flagstone floor ──
  castle: {
    bg: '#0d0b14', accent: '#c4b5fd', debris: ['#9a5a2a', '#5a5a64'],
    floor(g, px, py, x, y, r) {
      box(g, (x + y) % 2 ? '#6c6579' : '#665f73', px, py, 16, 16);
      box(g, '#4c4657', px, py, 16, 1);
      box(g, '#4c4657', px, py, 1, 16);
      box(g, '#4c4657', px + 8, py + 8, 8, 1);
      box(g, '#4c4657', px + 8, py + 8, 1, 8);
      box(g, '#7c758a', px + 1, py + 1, 15, 1);
      specks(g, px, py, r, ['#5a5468', '#7c758a'], 3);
    },
    block(g, px, py) { // column
      box(g, '#2e2a38', px + 1, py + 13, 14, 3);
      box(g, '#a49db3', px + 1, py + 12, 14, 3); // base
      box(g, '#7d7690', px + 1, py + 14, 14, 1);
      box(g, '#8f88a0', px + 3, py + 3, 10, 9); // shaft
      box(g, '#b5aec4', px + 4, py + 3, 2, 9);
      box(g, '#6d6680', px + 11, py + 3, 2, 9);
      box(g, '#7d7690', px + 8, py + 3, 1, 9);
      box(g, '#c9c2d8', px + 1, py, 14, 3); // capital
      box(g, '#a49db3', px + 1, py + 2, 14, 1);
      box(g, '#2e2a38', px, py + 3, 16, 1);
    },
    crate(g, px, py) { // barrel
      box(g, '#3b2210', px + 3, py, 10, 16);
      box(g, '#3b2210', px + 2, py + 2, 12, 12);
      box(g, '#9a5a2a', px + 4, py + 1, 8, 14);
      box(g, '#9a5a2a', px + 3, py + 3, 10, 10);
      box(g, '#c27a3c', px + 5, py + 2, 2, 12);
      box(g, '#7a4420', px + 10, py + 3, 2, 10);
      box(g, '#6b6b78', px + 3, py + 4, 10, 1); // hoops
      box(g, '#6b6b78', px + 3, py + 11, 10, 1);
      box(g, '#9a9aa8', px + 5, py + 4, 2, 1);
      box(g, '#5c3418', px + 6, py + 1, 4, 1); // lid
    },
    wall(g, px, py, x, y) {
      bricks(g, px, py, x, y, { base: '#4f4860', mortar: '#332e40', top: '#6d6580' });
      if (y === 0 && x % 4 === 2) { // a banner now and then
        box(g, '#7f1d1d', px + 5, py + 2, 6, 11);
        box(g, '#b91c1c', px + 6, py + 2, 4, 10);
        box(g, '#fde047', px + 7, py + 5, 2, 2);
        box(g, '#7f1d1d', px + 5, py + 13, 2, 1);
        box(g, '#7f1d1d', px + 9, py + 13, 2, 1);
      }
    },
  },

  // ── volcano: obsidian blocks, cracked magma rocks, basalt floor with glowing cracks ──
  volcano: {
    bg: '#120707', accent: '#fb923c', debris: ['#fb923c', '#4a3a36'],
    floor(g, px, py, x, y, r) {
      box(g, (x + y) % 2 ? '#3d2e2c' : '#382a28', px, py, 16, 16);
      specks(g, px, py, r, ['#4e3c39', '#2c201f'], 5);
      if (r(50) < 0.35) { // a glowing crack
        let cx = px + 2 + Math.floor(r(51) * 10);
        let cy = py + 3 + Math.floor(r(52) * 9);
        for (let k = 0; k < 5; k++) {
          box(g, k % 2 ? '#ea580c' : '#f97316', cx, cy, 1, 1);
          if (r(53 + k) < 0.5) cx++; else cy++;
        }
      }
    },
    block(g, px, py) {
      bevel(g, px, py, { base: '#3a2b47', top: '#7a62a0', front: '#1d1426', side: '#2c2038', edge: '#0c0810' });
      box(g, '#8b74a3', px + 3, py + 3, 2, 1);
      box(g, '#8b74a3', px + 3, py + 4, 1, 1);
      box(g, '#3d2f4a', px + 6, py + 6, 5, 4);
      box(g, '#c2410c', px, py + 15, 16, 1); // lava glow at the foot
    },
    crate(g, px, py, r) { // cracked rock with magma inside
      box(g, '#1f1615', px + 1, py + 1, 14, 15);
      box(g, '#5a4a46', px + 2, py + 2, 12, 10);
      box(g, '#3f322f', px + 2, py + 12, 12, 3);
      box(g, '#76625d', px + 2, py + 2, 12, 1);
      let cx = px + 4 + Math.floor(r(7) * 3);
      let cy = py + 3;
      for (let k = 0; k < 8; k++) { // the crack
        box(g, k % 3 ? '#f97316' : '#fde047', cx, cy, 1, 1);
        if (r(8 + k) < 0.55) cy++; else cx++;
      }
      box(g, '#ea580c', px + 10, py + 9, 2, 1);
    },
    wall(g, px, py, x, y, r) {
      bricks(g, px, py, x, y, { base: '#43302d', mortar: '#2a1d1b', top: '#5e4440' });
      if (r(60) < 0.3) box(g, '#ea580c', px + 2 + Math.floor(r(61) * 10), py + 3 + 4 * Math.floor(r(62) * 3), 3, 1);
    },
  },
};

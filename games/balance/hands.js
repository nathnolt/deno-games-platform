// CLIENT ONLY: the cute hands. Three of them, drawn as SVG (so any player colour works without more files):
//   open   the normal cursor (also what turns the camera when you drag empty space)
//   point  the cursor over a block you can pick up
//   fist   you are holding a block (also shown above a block another player holds, in THEIR colour)
// Each is a mitten-like hand: a dark outline all around, the player's colour inside, a soft highlight.

const INK = '#1f2937';
export const CURSOR_SIZE = 56; // pixels of a cursor hand (the drawing itself is 32 units wide)

// Every shape is given twice: fat and dark underneath (that is the outline of the whole hand, no lines inside it), the colour on top.
const SHAPES = {
  open: {
    hot: [16, 16],
    parts: [
      '<rect x="8" y="14" width="18" height="14" rx="6.5"/>', // palm
      '<rect x="8.5" y="6" width="4.6" height="15" rx="2.3"/>', // fingers, left to right
      '<rect x="13.1" y="3" width="4.6" height="17" rx="2.3"/>',
      '<rect x="17.7" y="3.6" width="4.6" height="16.5" rx="2.3"/>',
      '<rect x="22.3" y="7" width="4.4" height="13.5" rx="2.2"/>',
      '<rect x="2.8" y="15.5" width="12" height="5.2" rx="2.6" transform="rotate(38 8 18)"/>', // thumb
    ],
    lines: '<path d="M13.1 10v6M17.7 9v7M22.3 11v5" />',
    shine: '<ellipse cx="11" cy="23.5" rx="3" ry="1.6"/>',
  },
  point: {
    hot: [14, 3.5],
    parts: [
      '<rect x="9" y="15" width="17" height="13" rx="5.5"/>', // palm
      '<rect x="11.6" y="3.5" width="5.2" height="19" rx="2.6"/>', // the finger that points
      '<rect x="17" y="13" width="4.6" height="8.5" rx="2.3"/>', // the curled ones
      '<rect x="21.4" y="14" width="4.4" height="8" rx="2.2"/>',
      '<rect x="3.5" y="17.5" width="11" height="5" rx="2.5" transform="rotate(25 8 20)"/>', // thumb
    ],
    lines: '<path d="M17 15.5v5M21.5 16.5v4" />',
    shine: '<ellipse cx="14.2" cy="9" rx="1" ry="3"/>',
  },
  fist: {
    hot: [16, 17],
    parts: [
      '<rect x="6" y="12" width="21" height="16" rx="7"/>', // the fist
      '<rect x="7.2" y="8.2" width="4.8" height="9" rx="2.4"/>', // knuckles
      '<rect x="12" y="7" width="4.8" height="9.5" rx="2.4"/>',
      '<rect x="16.8" y="7.2" width="4.8" height="9.5" rx="2.4"/>',
      '<rect x="21.4" y="8.6" width="4.6" height="9" rx="2.3"/>',
      '<rect x="6.5" y="19.5" width="14" height="5.6" rx="2.8"/>', // thumb across the front
    ],
    lines: '<path d="M12 10.5v4M16.8 10.5v4M21.5 11.5v4" />',
    shine: '<ellipse cx="22" cy="22.5" rx="2.6" ry="1.5"/>',
  },
};

/** The hot spot of a hand in its 32 x 32 drawing: the point that sits exactly under the pointer (the tip of the finger for the pointing hand). */
export const handHot = (kind) => (SHAPES[kind] ?? SHAPES.open).hot;

/** The SVG source of a hand: kind = 'open' | 'point' | 'fist', color = any CSS colour. */
export function handSvg(kind, color = '#ffffff', size = 32) {
  const s = SHAPES[kind] ?? SHAPES.open;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">`
    + `<g fill="${INK}" stroke="${INK}" stroke-width="3.6" stroke-linejoin="round">${s.parts.join('')}</g>`
    + `<g fill="${color}">${s.parts.join('')}</g>`
    + `<g fill="none" stroke="${INK}" stroke-width="1.3" stroke-linecap="round" opacity=".55">${s.lines}</g>`
    + `<g fill="#fff" opacity=".45">${s.shine}</g>`
    + '</svg>';
}

/** A CSS `cursor` value for a hand (its hot spot is where the click lands). */
export function handCursor(kind, color, fallback = 'default') {
  const s = SHAPES[kind] ?? SHAPES.open;
  const k = CURSOR_SIZE / 32;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(handSvg(kind, color, CURSOR_SIZE))}") ${Math.round(s.hot[0] * k)} ${Math.round(s.hot[1] * k)}, ${fallback}`;
}

/** The three cursors of one player colour, as CSS `cursor` values (client.js sets the one that fits on the canvas). */
export function handCursors(color) {
  return { open: handCursor('open', color, 'grab'), point: handCursor('point', color, 'pointer'), fist: handCursor('fist', color, 'grabbing') };
}

/** A picture of a hand for the canvas / three.js (a texture): calls back with a canvas once the SVG has loaded. */
export function handCanvas(kind, color, size = 128, done) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    done(c);
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(handSvg(kind, color))}`;
}

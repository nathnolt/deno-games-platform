// Runs on BOTH server and browser. Pure data: the SHAPES of Balance. _definitions.js re-exports them, so nothing else changes.
//
// With `DEBUG = true` the shape studio edits this file for you, but only when you press "Add shape" or "Update shape" and confirm it:
// the game server then rewrites THIS file (comments are not kept) and every room gets the change. That needs write permission:
//   deno.json:  --allow-write=games/balance/_levels.js,games/balance/_shapes.js     (on the "start" and "dev" tasks)
//
// A shape is a list of parts. Part types:
//   { type: 'poly',   points: 'x,y x,y x,y ...' }   a CONVEX polygon (build concave shapes from several parts, like plus1)
//   { type: 'circle', diameter: d, x?, y? }          x/y = centre, default (d/2, d/2)
//   add `visual: true` to a poly to make it a drawing-only outline (it replaces the parts when the block is drawn)
// Origin and orientation do not matter: every shape is re-centred on the middle of its bounding box when it is used.
// The ORDER matters a little: snapshots refer to shapes by their place in this list, so new shapes are added at the end.
//
// shapeCategories    the category of each shape ('Basic', 'Letters' ...): the shape selects show the shapes under these names. No category = 'Other'.

export const shapes = {
  B: [{ type: 'poly', points: '0,0 4,0 4,4 0,4' }],
  heart: [
    { type: 'poly', points: '4.682,2.121 2.561,4.242 0.44,2.121 2.561,0' },
    { type: 'circle', diameter: 3, x: 3.621, y: 3.1815 },
    { type: 'circle', diameter: 3, x: 1.5, y: 3.1815 },
  ],
  L: [{ type: 'poly', points: '0,2 0,6 2,6 2,2' }, { type: 'poly', points: '0,2 4,2 4,0 0,0' }],
  J: [{ type: 'poly', points: '4,2 4,6 2,6 2,2' }, { type: 'poly', points: '4,2 0,2 0,0 4,0' }],
  Z: [{ type: 'poly', points: '0,5 0,3 4,3 4,5' }, { type: 'poly', points: '2,3 2,1 6,1 6,3' }],
  S: [{ type: 'poly', points: '6,5 6,3 2,3 2,5' }, { type: 'poly', points: '4,3 4,1 0,1 0,3' }],
  T: [{ type: 'poly', points: '0,0 0,2 6,2 6,0 0,0' }, { type: 'poly', points: '2,2 2,4 4,4 4,2' }],
  triangle: [{ type: 'poly', points: '0,0 6,6 6,0' }],
  plus: [{ type: 'poly', points: '3,0 3,6 5,6 5,0' }, { type: 'poly', points: '1,4 7,4 7,2 1,2' }],
  arrow: [{ type: 'poly', points: '-4,1 1,1 1,-1 -4,-1' }, { type: 'poly', points: '0,2.828 2.828,0 0,-2.828' }],
  circle: [{ type: 'circle', diameter: 5 }],
  what: [{ type: 'circle', diameter: 2 }, { type: 'circle', diameter: 2, x: 6, y: 1 }],
  I: [{ type: 'poly', points: '0,2 0,0 8,0 8,2' }],
  cutcorner: [{ type: 'poly', points: '0,5 5,0 0,0' }, { type: 'poly', points: '5,5 2.5,2.5 5,0' }],
  halfcircle: [{ type: 'circle', diameter: 6, x: 3, y: 3 }, { type: 'poly', points: '0,3 6,3 6,0 0,0', cut: true }],
};

export const shapeCategories = {
  B: 'Tetris',
  heart: 'Fancy',
  L: 'Tetris',
  J: 'Tetris',
  Z: 'Tetris',
  S: 'Tetris',
  T: 'Tetris',
  triangle: 'Basic',
  plus: 'Fancy',
  arrow: 'Fancy',
  circle: 'Basic',
  what: 'Fancy',
  I: 'Tetris',
};

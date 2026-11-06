// Runs on BOTH server and browser. Pure data: the LEVELS of Balance. definitions.js re-exports them, so nothing else changes.
//
// With `DEBUG = true` the level studio edits this file for you, but only when you press "Add level" (a new level is added at the end) or
// "Update level" (an existing level is replaced) and confirm it: the game server then rewrites THIS file (comments are not kept) and every
// room gets the change. That needs write permission for the file:
//   deno.json:  --allow-write=games/balance/levels.js,games/balance/shapes.js     (on the "start" and "dev" tasks)
// (`deno task dev` watches the files and restarts the server after every save: use `deno task start` while you edit levels.)
//
// name, difficulty     shown in the menu (easy | medium | hard)
// world                key of `worlds` (definitions.js): the world this level is part of (the first world when left out)
// bowl, background     keys of `bowls` / `backgrounds` (the first one of each when left out)
// time                 optional hour of the day (0-24): overrides the background
// initialBlocks        present from the start: { shape, material, rot (degrees), x, y }  (x,y = centre, y=0 is the water surface)
//                      'static' material = fixed to the world. Anything else is a normal physics body.
// chooseShapes         how many blocks lie on the table at once = how many can be held at the same time (4 = all four players)
// shapes               the ordered list of blocks you must place: { shape, material }. Rotate with Q / E while holding.
// zone (optional)      { x0, x1 }: sideways limits (default tuning.zone). Leaving it, or touching the water/bowl, loses the level.
// drop (optional)      { x0, x1, y0, y1 }: the drop zone rectangle (default tuning.drop)

export const levels = [
  {
    name: 'Level 1',
    world: 'world1',
    difficulty: 'easy',
    bowl: 'bowl1',
    background: 'zen1',
    initialBlocks: [
      { shape: 'square1', material: 'static', rot: 0, x: -5, y: -4.4 },
      { shape: 'square1', material: 'static', rot: 0, x: -5, y: -0.4 },
      { shape: 'square1', material: 'static', rot: 0, x: 5, y: -4.4 },
      { shape: 'square1', material: 'static', rot: 0, x: 5, y: -0.4 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'square1', material: 'wood' },
      { shape: 'square1', material: 'glass' },
      { shape: 'square1', material: 'wood' },
      { shape: 'square1', material: 'wood' },
      { shape: 'square1', material: 'stone' },
      { shape: 'square1', material: 'wood' },
    ],
  },
  {
    name: 'Level 2',
    world: 'world1',
    difficulty: 'easy',
    bowl: 'bowl1',
    background: 'zen1',
    initialBlocks: [{ shape: 'triangle', material: 'static', rot: 135, x: -0.25, y: -0.75 }],
    chooseShapes: 3,
    shapes: [
      { shape: 'S', material: 'wood' },
      { shape: 'S2', material: 'wood' },
      { shape: 'triangle', material: 'wood' },
      { shape: 'square1', material: 'wood' },
    ],
  },
  {
    name: 'Level 3',
    difficulty: 'easy',
    world: 'world1',
    bowl: 'canoe',
    background: 'zen1',
    initialBlocks: [
      { shape: 'heart', material: 'static', rot: -45, x: -9, y: 1.25 },
      { shape: 'heart', material: 'static', rot: 45, x: 4.5, y: 1.75 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'L', material: 'wood' },
      { shape: 'L2', material: 'wood' },
      { shape: 'L', material: 'wood' },
      { shape: 'L2', material: 'wood' },
    ],
  },
  {
    name: 'Level 4',
    difficulty: 'easy',
    world: 'world1',
    bowl: 'bowl1',
    background: 'zen1',
    initialBlocks: [
      { shape: 'square1', material: 'static', rot: 45, x: -0.25, y: -4.75 },
      { shape: 'triangle', material: 'wood', rot: -45, x: 0, y: 2.25 },
      { shape: 'square1', material: 'static', rot: 45, x: 0.25, y: -4.75 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'arrow', material: 'wood' },
      { shape: 'arrow', material: 'wood' },
      { shape: 'arrow', material: 'wood' },
      { shape: 'arrow', material: 'wood' },
    ],
  },
  {
    name: 'Level 5',
    difficulty: 'easy',
    world: 'world1',
    bowl: 'bowl1',
    background: 'zen1',
    initialBlocks: [{ shape: 'circle', material: 'static', rot: 0, x: 0, y: 0.25 }],
    chooseShapes: 3,
    shapes: [
      { shape: 'heart', material: 'wood' },
      { shape: 'plus', material: 'wood' },
      { shape: 'arrow', material: 'wood' },
      { shape: 'S', material: 'wood' },
    ],
  },
];

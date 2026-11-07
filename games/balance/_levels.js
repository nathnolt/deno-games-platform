// Runs on BOTH server and browser. Pure data: the LEVELS of Balance. _definitions.js re-exports them, so nothing else changes.
//
// The levels are grouped by world: the order of the worlds and of the levels in them is the order of the menu.
//   export const levels = { worldKey: { name: 'World name', levels: [ { ...level }, ... ] }, ... }
//
// With `DEBUG = true` the level studio edits this file for you, but only when you press "Add level" (a new level is added at the end of its world),
// "Update level" (an existing level is replaced) or "Save order" (the level order menu) and confirm it: the game server then rewrites THIS file
// (comments are not kept) and every room gets the change. That needs write permission for the file:
//   deno.json:  --allow-write=games/balance/_levels.js,games/balance/_shapes.js     (on the "start" and "dev" tasks)
// (`deno task dev` watches the files and restarts the server after every save: use `deno task start` while you edit levels.)
//
// name, difficulty     shown in the menu (easy | medium | hard)
// bowl, background     keys of `bowls` / `backgrounds` (the first one of each when left out)
// time                 optional hour of the day (0-24): overrides the background
// initialBlocks        present from the start: { shape, material, rot (degrees), x, y }  (x,y = centre, y=0 is the water surface)
//                      'static' material = fixed to the world. Anything else is a normal physics body.
// chooseShapes         how many blocks lie on the table at once = how many can be held at the same time (4 = all four players)
// shapes               the ordered list of blocks you must place: { shape, material }. Rotate with Q / E while holding.
// zone (optional)      { x0, x1 }: sideways limits (default tuning.zone). Leaving it, or touching the water/bowl, loses the level.
// drop (optional)      { x0, x1, y0, y1 }: the drop zone rectangle (default tuning.drop)

export const levels = {
  world1: {
    name: 'World 1',
    levels: [
      {
        name: 'Level 2',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [{ shape: 'triangle', material: 'static', rot: 135, x: -0.25, y: -0.75 }],
        chooseShapes: 3,
        shapes: [
          { shape: 'Z', material: 'wood' },
          { shape: 'S', material: 'wood' },
          { shape: 'triangle', material: 'wood' },
          { shape: 'B', material: 'wood' },
        ],
      },
      {
        name: 'Tetromino',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [{ shape: 'I', material: 'static', rot: 0, x: 0, y: 0 }],
        chooseShapes: 3,
        shapes: [
          { shape: 'Z', material: 'wood' },
          { shape: 'T', material: 'wood' },
          { shape: 'L', material: 'wood' },
          { shape: 'B', material: 'wood' },
          { shape: 'I', material: 'wood' },
          { shape: 'S', material: 'wood' },
          { shape: 'J', material: 'wood' },
        ],
      },
      {
        name: 'Tetromino 2',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [{ shape: 'T', material: 'static', rot: 90, x: 0, y: 5 }],
        chooseShapes: 3,
        shapes: [{ shape: 'S', material: 'wood' }, { shape: 'S', material: 'wood' }, { shape: 'S', material: 'wood' }],
      },
      {
        name: 'Tetromino 3',
        difficulty: 'medium',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [{ shape: 'I', material: 'static', rot: 135, x: 0, y: 5 }],
        chooseShapes: 3,
        shapes: [
          { shape: 'B', material: 'wood' },
          { shape: 'J', material: 'wood' },
          { shape: 'T', material: 'wood' },
          { shape: 'L', material: 'wood' },
          { shape: 'I', material: 'wood' },
          { shape: 'Z', material: 'wood' },
          { shape: 'S', material: 'wood' },
        ],
      },
    ],
  },
  world2: { name: 'World 2', levels: [] },
  test: {
    name: 'Test',
    levels: [
      {
        name: 'Level 1',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [
          { shape: 'B', material: 'static', rot: 0, x: -5, y: -4.4 },
          { shape: 'B', material: 'static', rot: 0, x: -5, y: -0.4 },
          { shape: 'B', material: 'static', rot: 0, x: 5, y: -4.4 },
          { shape: 'B', material: 'static', rot: 0, x: 5, y: -0.4 },
        ],
        chooseShapes: 3,
        shapes: [
          { shape: 'B', material: 'wood' },
          { shape: 'B', material: 'glass' },
          { shape: 'B', material: 'wood' },
          { shape: 'B', material: 'wood' },
          { shape: 'B', material: 'wood' },
          { shape: 'B', material: 'wood' },
        ],
      },
      {
        name: '2',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [{ shape: 'B', material: 'static', rot: 0, x: -0.25, y: 6.75 }],
        chooseShapes: 3,
        shapes: [{ shape: 'B', material: 'wood' }],
      },
    ],
  },
  example: { name: 'Example', levels: [] },
  whacky: {
    name: 'Whacky',
    levels: [
      {
        name: 'Level 1',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [
          { shape: 'B', material: 'static', rot: 45, x: -0.25, y: -4 },
          { shape: 'triangle', material: 'wood', rot: -45, x: 0.2, y: 2.7 },
          { shape: 'B', material: 'static', rot: 45, x: 0.7000000000000001, y: -4 },
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
        name: 'Level 2',
        difficulty: 'easy',
        bowl: 'bowl1',
        background: 'zen1',
        initialBlocks: [
          { shape: 'B', material: 'floatBlockHeavy', rot: 0, x: -0.5, y: -0.01 },
          { shape: 'B', material: 'floatBlockHeavy', rot: 0, x: 3.8000000000000003, y: 0 },
        ],
        chooseShapes: 3,
        shapes: [{ shape: 'B', material: 'wood' }],
      },
      {
        name: 'Level 3',
        difficulty: 'easy',
        bowl: 'canoe',
        background: 'zen1',
        initialBlocks: [
          { shape: 'heart', material: 'static', rot: -45, x: -9, y: 1.25 },
          { shape: 'heart', material: 'static', rot: 45, x: 4.5, y: 1.75 },
        ],
        chooseShapes: 3,
        shapes: [
          { shape: 'L', material: 'wood' },
          { shape: 'J', material: 'wood' },
          { shape: 'L', material: 'wood' },
          { shape: 'J', material: 'wood' },
        ],
      },
    ],
  },
  coop: { name: 'Co-op', levels: [] },
  hard: { name: 'Hard', levels: [] },
  dumb: { name: 'Dumb', levels: [] },
};

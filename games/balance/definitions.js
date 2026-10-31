// Runs on BOTH server and browser. Pure data, no code: everything that defines the CONTENT of Balance lives in this file.
//
//   tuning        numbers you can play with (gravity, camera, block depth ...)
//   materials     how a block feels (friction, weight) and which shader draws it
//   shapes        the block outlines
//   bowls         the bowls the tower is built in (a generated bowl, optionally drawn with a model instead)
//   models        .obj files in ./models and which shader draws each part of them (models are only used for backgrounds / bowls)
//   backgrounds   the scenery around the table: ground, mist and placed models
//   levels        what to build, with which blocks, in which bowl and in front of which background
//
// With `DEBUG = true` in shared.js the in-game debug menu edits all of this live and exports a new copy of this file
// (Export tab: "Download definitions.js"). You can also edit this file by hand.

// ── Tuning ───────────────────────────────────────────────────────────────────────────────────────────────────
// Server (physics): gravity, waterDensity, settleTime, settleSpeed, follow. These apply when a level (re)starts.
// Look: depth, chamfer, camera.
// World units: x = right, y = up (y = 0 is the surface of the water), z = towards the camera.
export const tuning = {
  gravity: 30, //          units / s²  (a bit heavy, so blocks feel chunky rather than floaty)
  waterDensity: 1, //      material density = weight / 10, so weight 10 == as dense as water
  settleTime: 2, //        seconds everything must be (almost) still after the last block to win
  settleSpeed: 0.25, //    "still" = linear and angular speed below this
  follow: 30, //           how quickly a held block chases its player's pointer

  depth: 2.4, //           thickness of every block along z
  chamfer: 0.18, //        size of the 45° bevel on every edge of a block

  frontZ: 17, //           z of the blocks waiting on the table (in front of the bowl)
  hoverZ: 4.5, //          z of a block you hold: it floats in front of everything
  slotGap: 17, //          the waiting blocks lie in a row this far apart (centre to centre)

  maxHoldX: 45, //         how far sideways a held block may be carried
  maxHoldY: 60, //         how high above the water
  minHoldY: -25, //        and how low (the waiting blocks are closer to the camera, so their pick-up point is a bit low)

  zone: { x0: -30, x1: 30 }, //                       default sideways limit: a block whose centre leaves it loses the level
  drop: { x0: -23, x1: 23, y0: 1.5, y1: 100 }, //     default DROP ZONE (invisible): let go of a block inside it and it falls into the bowl
  view: { w: 84, h: 46, cy: 10 }, //                  what the camera must always show (width, height, centre height)
  camera: { fov: 28, pitch: 20, targetY: 8 }, //      vertical field of view, degrees the camera looks down, height it looks at
};

// ── Materials ────────────────────────────────────────────────────────────────────────────────────────────────
// friction: 0..20 (mu = friction / 20)         weight: density, 10 = same density as water (mass = area * weight / 10)
// static:   never moves                        float: dynamic, pushed up by the water, never counts as "fallen in the water"
// shader:   name of a GLSL shader in client/shaders.js
export const materials = {
  wood: { friction: 10, weight: 10, shader: 'wood' },
  ash: { friction: 8, weight: 8, shader: 'wood2' },
  glass: { friction: 4, weight: 5, shader: 'glass' },
  stone: { friction: 14, weight: 20, shader: 'stone1' },
  static: { static: true, friction: 12, shader: 'stone2' },
  floatBlock: { float: true, friction: 8, weight: 3, shader: 'float' },
};

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────
// A shape is a list of parts. Part types:
//   { type: 'poly',   points: 'x,y x,y x,y ...' }   a CONVEX polygon (build concave shapes from several parts, like plus1)
//   { type: 'circle', diameter: d, x?, y? }          x/y = centre, default (d/2, d/2)
//   add `visual: true` to a poly to make it a drawing-only outline (it replaces the parts when the block is drawn)
// Origin and orientation do not matter: every shape is re-centred on the middle of its bounding box when it is used.
export const shapes = {
  rect1: [{ type: 'poly', points: '0,0 4,0 4,1 0,1' }],
  square1: [{ type: 'poly', points: '0,0 4,0 4,4 0,4' }],
  small1: [{ type: 'poly', points: '0,0 2,0 2,2 0,2' }],
  plank1: [{ type: 'poly', points: '0,0 8,0 8,1 0,1' }],
  bridge1: [{ type: 'poly', points: '0,0 14,0 14,1.5 0,1.5' }],
  slab1: [{ type: 'poly', points: '0,0 12,0 12,1.5 0,1.5' }],
  raft1: [{ type: 'poly', points: '0,0 16,0 16,3 0,3' }],
  raft2: [{ type: 'poly', points: '0,0 11,0 11,3 0,3' }],
  pillar1: [{ type: 'poly', points: '0,0 2,0 2,10 0,10' }],
  pillar2: [{ type: 'poly', points: '0,0 2,0 2,7 0,7' }],
  tri1: [{ type: 'poly', points: '0,0 4,0 2,3' }],
  plus1: [
    { type: 'poly', points: '0,1 3,1 3,2 0,2' },
    { type: 'poly', points: '1,0 2,0 2,3 1,3' },
    { type: 'poly', visual: true, points: '1,0 2,0 2,1 3,1 3,2 2,2 2,3 1,3 1,2 0,2 0,1 1,1' },
  ],
  circle1: [{ type: 'circle', diameter: 4 }],
  circle2: [{ type: 'circle', diameter: 2.5 }],
};

// ── Bowls ────────────────────────────────────────────────────────────────────────────────────────────────────
// The bowl is a bowl of revolution: a flat bottom, rounded corners and straight walls. The physics sees the slice through the middle
// (z = 0), the 3D bowl is that slice turned around and squeezed along z.
//   a       half width at the rim                     b      depth of the inside below the rim
//   t       wall thickness                            rimY   height of the rim (y = 0 is the water)
//   r       horizontal radius of the rounded corners: the flat bottom is 2 * (a - r) wide. Small r = flat bottom, big r = round bowl.
//   zscale  how much the bowl is squeezed along z     square / squareBottom   shape seen from above at the rim / at the bottom
//                                                     (2 = circle, 5 = rounded square, higher = boxier)
//   shader  name of a GLSL shader in client/shaders.js (a 3D one: it gets the position on the bowl)
//   water   { color, opacity } of the water
//   model   optional: draw this model (see `models`) instead of the generated bowl. { model, scale, rotation: [x,y,z] degrees, translate: [x,y,z] }
//           The physics still uses the numbers above, so make the model the same size.
// Blocks that are not 'float' blocks lose the level if they touch the bowl.
// The floor of the bowl is at y = rimY - b - t: static blocks (pillars) that stand in it must reach down to rimY - b.
export const bowls = {
    bowl1: {
    a: 16.5,
    b: 8,
    t: 0.7,
    rimY: 1.6,
    r: 4.3,
    zscale: 0.8,
    square: 6.4,
    squareBottom: 5.9,
    shader: 'bowlwood',
    water: { color: '#71b5fe', opacity: 0.45 },
  },
  bowl2: {
    a: 22,
    b: 7,
    t: 0.8,
    rimY: 1,
    r: 6,
    zscale: 0.8,
    square: 3,
    squareBottom: 2,
    shader: 'ceramic',
    water: { color: '#6cc3d5', opacity: 0.45 },
  },
};


// ── Models ───────────────────────────────────────────────────────────────────────────────────────────────────
// Wavefront .obj files in ./models (triangles or polygons; vertex positions are what matters, no textures needed).
//   file     name of the file in ./models
//   shader   default shader for every part of the model
//   shaders  shader per PART. A part is a `usemtl` name, or the `o` / `g` name when there is no usemtl (Blender: material or object name)
//   smooth   true = use the normals from the file if it has them. Default: flat shading (the low-poly look)
// The Models tab of the debug menu lists the parts it found in each file.
export const models = {
  tree: { file: 'tree.obj', shaders: { trunk: 'bark', leaves: 'leaves' } },
  sakura: { file: 'tree.obj', shaders: { trunk: 'bark', leaves: 'blossom' } },
  pine: { file: 'pine.obj', shaders: { trunk: 'bark', needles: 'leaves' } },
  rock: { file: 'rock.obj', shader: 'stone1' },
  lantern: { file: 'lantern.obj', shader: 'stone1', shaders: { light: 'paper' } },
  bamboo: { file: 'bamboo.obj', shaders: { stalk: 'bamboo', leaves: 'leaves' } },
  mountain: { file: 'mountain.obj', shader: 'mountain' },
};

// ── Backgrounds ──────────────────────────────────────────────────────────────────────────────────────────────
// What surrounds the table. Positions are in WORLD units, relative to the middle of the table: x = right, z = towards the camera
// (negative = behind the table) and y = 0 is the FLOOR the table stands on.
//   mist    colour of the sky and of the far distance (everything fades into it)
//   fog     [near, far] distance from the camera where models start / finish fading into the mist
//   ground  raked sand around the table: colorA / colorB are the two sand tones the rake lines alternate between, ripple = how tight the rake lines are
//   models  [{ model, scale, rotation: [x, y, z] in degrees, translate: [x, y, z] }]
export const backgrounds = {
  zen1: {
    mist: '#e7e2d6',
    fog: [150, 520],
    ground: { colorA: '#cdc3a8', colorB: '#e6dec9', ripple: 2.2 },
    models: [
      { model: 'rock', scale: 5, rotation: [0, 20, 0], translate: [-66, 0, -28] },
      { model: 'rock', scale: 7, rotation: [0, 140, 0], translate: [64, 0, -44] },
      { model: 'rock', scale: 3.5, rotation: [0, 70, 0], translate: [-28, 0, -78] },
      { model: 'lantern', scale: 2, rotation: [0, 25, 0], translate: [-66, 0, 12] },
      { model: 'bamboo', scale: 3, rotation: [0, 0, 0], translate: [78, 0, -22] },
      { model: 'bamboo', scale: 3.4, rotation: [0, 40, 0], translate: [-84, 0, -40] },
      { model: 'tree', scale: 6, rotation: [0, 200, 0], translate: [34, 0, -96] },
      { model: 'mountain', scale: 5, rotation: [0, 0, 0], translate: [0, 0, -300] },
      { model: 'mountain', scale: 4, rotation: [0, 90, 0], translate: [-170, 0, -280] },
    ],
  },
  zen2: {
    mist: '#dde4df',
    fog: [130, 460],
    ground: { colorA: '#b4bfa9', colorB: '#d3dac8', ripple: 1.8 },
    models: [
      { model: 'pine', scale: 4, rotation: [0, 0, 0], translate: [-72, 0, -34] },
      { model: 'pine', scale: 5, rotation: [0, 80, 0], translate: [70, 0, -52] },
      { model: 'sakura', scale: 6, rotation: [0, 30, 0], translate: [-40, 0, -90] },
      { model: 'rock', scale: 6, rotation: [0, 200, 0], translate: [60, 0, 14] },
      { model: 'lantern', scale: 2, rotation: [0, 200, 0], translate: [66, 0, 30] },
      { model: 'mountain', scale: 6, rotation: [0, 30, 0], translate: [60, 0, -320] },
      { model: 'mountain', scale: 4.5, rotation: [0, 0, 0], translate: [-140, 0, -280] },
    ],
  },
};

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────────────────
// name, difficulty     shown in the menu (easy | medium | hard)
// bowl, background     keys of `bowls` / `backgrounds` (the first one of each when left out)
// initialBlocks        present from the start: { shape, material, rot (degrees), x, y }  (x,y = centre, y=0 is the water surface)
//                      'static' material = fixed to the world. Anything else is a normal physics body.
// chooseShapes         how many blocks lie on the table at once = how many can be held at the same time (4 = all four players)
// shapes               the ordered list of blocks you must place: { shape, material }. Rotate with Q / E while holding.
// zone (optional)      { x0, x1 }: sideways limits (default tuning.zone). Leaving it, or touching the water/bowl, loses the level.
// drop (optional)      { x0, x1, y0, y1 }: the drop zone rectangle (default tuning.drop)
//
// Pillars below are 'pillar1' (2 x 10) centred at y = -3: they stand on the floor of the bowl (y = -8) and top out at y = 2.
export const levels = [
  {
    name: 'First Steps',
    difficulty: 'easy',
    bowl: 'bowl1',
    background: 'zen1',
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: -5, y: -3 },
      { shape: 'pillar1', material: 'static', rot: 0, x: 5, y: -3 },
    ],
    chooseShapes: 4,
    shapes: [
      { shape: 'plank1', material: 'wood' },
      { shape: 'square1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'square1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
    ],
  },
  {
    name: 'The Slope',
    difficulty: 'easy',
    bowl: 'bowl1',
    background: 'zen1',
    // one short pillar with a slanted slab on top: the surface you build on is tilted
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: 0, y: -3 },
      { shape: 'slab1', material: 'static', rot: 14, x: 0, y: 2.75 },
    ],
    chooseShapes: 4,
    shapes: [
      { shape: 'rect1', material: 'wood' },
      { shape: 'square1', material: 'stone' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'plus1', material: 'wood' },
      { shape: 'tri1', material: 'wood' },
    ],
  },
  {
    name: 'Twin Pillars',
    difficulty: 'medium',
    bowl: 'bowl1',
    background: 'zen1',
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: -7, y: -3 },
      { shape: 'pillar1', material: 'static', rot: 0, x: 7, y: -3 },
    ],
    chooseShapes: 4,
    shapes: [
      { shape: 'bridge1', material: 'wood' },
      { shape: 'square1', material: 'stone' },
      { shape: 'plank1', material: 'wood' },
      { shape: 'plus1', material: 'wood' },
      { shape: 'circle1', material: 'wood' },
      { shape: 'rect1', material: 'glass' },
      { shape: 'square1', material: 'wood' },
      { shape: 'tri1', material: 'wood' },
    ],
  },
  {
    name: 'Lily Pad',
    difficulty: 'medium',
    bowl: 'bowl2',
    background: 'zen2',
    // no pillars: everything is built on a block that floats on the water. One-sided piles tip it over.
    initialBlocks: [{ shape: 'raft1', material: 'floatBlock', rot: 0, x: 0, y: 0.6 }],
    chooseShapes: 3,
    shapes: [
      { shape: 'rect1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'plank1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
    ],
  },
  {
    name: 'Glass Cannon',
    difficulty: 'hard',
    bowl: 'bowl1',
    background: 'zen2',
    initialBlocks: [
      { shape: 'pillar1', material: 'static', rot: 0, x: 0, y: -3 },
      { shape: 'slab1', material: 'static', rot: -18, x: 0, y: 2.75 },
    ],
    chooseShapes: 3,
    shapes: [
      { shape: 'square1', material: 'stone' },
      { shape: 'plank1', material: 'glass' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'plus1', material: 'glass' },
      { shape: 'tri1', material: 'stone' },
      { shape: 'rect1', material: 'glass' },
      { shape: 'circle2', material: 'wood' },
      { shape: 'small1', material: 'wood' },
    ],
  },
  {
    name: 'Tightrope',
    difficulty: 'hard',
    bowl: 'bowl1',
    background: 'zen2',
    zone: { x0: -22, x1: 22 },
    initialBlocks: [
      { shape: 'raft2', material: 'floatBlock', rot: 0, x: 0, y: 0.6 },
      { shape: 'pillar1', material: 'static', rot: 0, x: -14, y: -3 },
    ],
    chooseShapes: 2,
    shapes: [
      { shape: 'small1', material: 'wood' },
      { shape: 'rect1', material: 'wood' },
      { shape: 'small1', material: 'wood' },
      { shape: 'rect1', material: 'glass' },
      { shape: 'square1', material: 'wood' },
      { shape: 'small1', material: 'glass' },
    ],
  },
];

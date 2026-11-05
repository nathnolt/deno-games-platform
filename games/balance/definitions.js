// Runs on BOTH server and browser. Pure data, no code: everything that defines the CONTENT of Balance lives in this file.
//
//   tuning        numbers you can play with (gravity, camera, block depth ...)
//   materials     how a block feels (friction, weight) and which shader draws it
//   shapes        the block outlines
//   bowls         the bowls the tower is built in (a generated bowl, optionally drawn with a model instead)
//   models        .obj files in ./models and which shader draws each part of them (models are only used for backgrounds / bowls)
//   backgrounds   the scenery around the table: ground, mist and placed models
//   worlds        the groups the levels are shown in
//   levels        what to build, with which blocks, in which bowl and in front of which background
//
// With `DEBUG = true` in shared.js the in-game debug menu edits all of this live and exports a new copy of this file
// (Export tab: "Download definitions.js"). You can also edit this file by hand.

// ── Tuning ───────────────────────────────────────────────────────────────────────────────────────────────────
// Server (physics): gravity, waterDensity, countdown, follow. These apply when a level (re)starts.
// Look: depth, chamfer, camera.
// World units: x = right, y = up (y = 0 is the surface of the water), z = towards the camera.
export const tuning = {
  gravity: 30, //          units / s²  (a bit heavy, so blocks feel chunky rather than floaty)
  waterDensity: 1, //      material density = weight / 10, so weight 10 == as dense as water
  countdown: 3, //         seconds of the countdown after the last block is placed (three green dots appear, one per third); then the level is cleared
  follow: 30, //           how quickly a held block chases its player's pointer

  depth: 2.4, //           thickness of every block along z
  chamfer: 0.18, //        size of the 45° bevel on every edge of a block

  frontZ: 17, //           z of the blocks waiting on the table (in front of the bowl)
  hoverZ: 4.5, //          z of a block you hold: it floats in front of everything
  slotGap: 17, //          the waiting blocks lie in a row this far apart (centre to centre)
  mergeParts: true,
  maxHoldX: 120, //         how far sideways a held block may be carried
  maxHoldY: 60, //         how high above the water
  minHoldY: -25, //        and how low (the waiting blocks are closer to the camera, so their pick-up point is a bit low)

  zone: { x0: -30, x1: 30 }, //                       default sideways limit: a block whose centre leaves it loses the level
  drop: { x0: -120, x1: 120, y0: 1.5, y1: 100 }, //     default DROP ZONE (invisible): let go of a block inside it and it falls into the bowl
  view: { w: 72, h: 46, cy: 10 }, //                  what the camera must always show (width, height, centre height)
  camera: { fov: 21, pitch: 12, targetY: 10 }, //      vertical field of view, degrees the camera looks down, height it looks at
};




// ── Materials ────────────────────────────────────────────────────────────────────────────────────────────────
// friction: 0..20 (mu = friction / 20)         weight: density, 10 = same density as water (mass = area * weight / 10)
// static:   never moves                        float: dynamic, pushed up by the water, never counts as "fallen in the water"
// floatLevel: (float blocks) how deep it sits in the water when it floats alone: 0.5 = half under, 1 = just under. It never sinks, but it tilts.
// stackLimit: how many blocks may rest on top of this block (directly or through other blocks). One more and it breaks.
//           The block wears a coloured dot: green = nothing on it, orange = 1, red = 2 (= the limit), and it shatters at limit + 1.
// shader:   name of a GLSL shader in client/shaders.js
export const materials = {
  wood: { friction: 10, weight: 10, shader: 'wood' },
  ash: { friction: 8, weight: 8, shader: 'wood2' },
  glass: { friction: 4, weight: 5, shader: 'glass', stackLimit: 2 },
  stone: { friction: 14, weight: 20, shader: 'stone1' },
  static: { static: true, friction: 12, shader: 'stone2' },
  floatBlock: { float: true, friction: 8, weight: 3, shader: 'float', floatLevel: 0.5 },
  floatierBlock: { float: true, friction: 8, weight: 3, shader: 'float', floatLevel: 0.9 },
  floatBlockHeavy: { float: true, friction: 8, weight: 30, shader: 'float', floatLevel: 0.5 },
};

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────
// A shape is a list of parts. Part types:
//   { type: 'poly',   points: 'x,y x,y x,y ...' }   a CONVEX polygon (build concave shapes from several parts, like plus1)
//   { type: 'circle', diameter: d, x?, y? }          x/y = centre, default (d/2, d/2)
//   add `visual: true` to a poly to make it a drawing-only outline (it replaces the parts when the block is drawn)
// Origin and orientation do not matter: every shape is re-centred on the middle of its bounding box when it is used.
export const shapes = {
  square1: [{ type: 'poly', points: '0,0 4,0 4,4 0,4' }],
  heart: [
    { type: 'poly', points: '4.682,2.121 2.561,4.242 0.44,2.121 2.561,0' },
    { type: 'circle', diameter: 3, x: 3.621, y: 3.1815 },
    { type: 'circle', diameter: 3, x: 1.5, y: 3.1815 },
  ],
  L:  [{ type: 'poly', points: '0,0 0,7 2,7 2,0' }, { type: 'poly', points: '0,2 4,2 4,0 0,0' }],
  L2: [{ type: 'poly', points: '4,0 4,7 2,7 2,0' }, { type: 'poly', points: '4,2 0,2 0,0 4,0' }],
  S:  [{ type: 'poly', points: '0,4 0,2 4,2 4,4' }, { type: 'poly', points: '2,2 2,0 6,0 6,2' }],
  S2: [{ type: 'poly', points: '4,4 4,2 8,2 8,4' }, { type: 'poly', points: '2,2 2,0 6,0 6,2' }],
  T:  [{ type: 'poly', points: '0,0 0,2 6,2 6,0 0,0' }, { type: 'poly', points: '2,0 2,4 4,4 4,0' }],
  triangle: [{ type: 'poly', points: '0,0 6,6 6,0' }],
  plus: [{ type: 'poly', points: '3,0 3,6 5,6 5,0' }, { type: 'poly', points: '1,4 7,4 7,2 1,2' }],
  arrow: [{ type: 'poly', points: '-4,1 1,1 1,-1 -4,-1' }, { type: 'poly', points: '0,2.828 2.828,0 0,-2.828' }],
  circle: [{ type: 'circle', diameter: 5 }],
  what: [{ type: 'circle', diameter: 2 }, { type: 'circle', diameter: 2, x: 6, y: 1 }],
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
    a: 20.5,
    b: 8,
    t: 0.9,
    rimY: 1.5,
    r: 3.3,
    zscale: 0.6,
    square: 8.6,
    squareBottom: 9.1,
    shader: 'mahogany',
    water: { color: '#004585', opacity: 0.55, reflect: 1, caustics: 2, causticsInset: 2 },
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
    water: { color: '#6cc3d5', opacity: 0.45, reflect: 0.6 },
  },
  canoe: {
    a: 40,
    b: 7,
    t: 0.8,
    rimY: 3.3,
    r: 3.9,
    zscale: 0.11,
    square: 2,
    squareBottom: 2,
    shader: 'wood2',
    water: { color: '#647b8e', opacity: 0.55, reflect: 1, caustics: 2, causticsInset: 2 },
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
  board: { file: 'board.obj', shader: 'floorwood' },
  window: { file: 'window.obj', shader: 'mahogany' },                       // 24 x 30, origin at the middle of the bottom edge
  wall: { file: 'wall.obj', shaders: { plaster: 'plaster', trim: 'mahogany' } }, // 200 x 90 with a hole for the window (x -12..12, y 4..34)
  plant: { file: 'plant.obj', shaders: { pot: 'ceramic', soil: 'bark', leaves: 'leaves' } },
  stones: { file: 'stones.obj', shader: 'blackstone' },                      // three small black stones stacked up
};

// ── Backgrounds ──────────────────────────────────────────────────────────────────────────────────────────────
// What surrounds the table. Positions are in WORLD units, relative to the middle of the table: x = right, z = towards the camera
// (negative = behind the table) and y = 0 is the FLOOR the table stands on.
//   mist    colour of the sky and of the far distance (everything fades into it)
//   fog     [near, far] distance from the camera where models start / finish fading into the mist
//   ground  raked sand around the table: colorA / colorB are the two sand tones the rake lines alternate between, ripple = how tight the rake lines are
//   blur    how much the scenery is blurred (pixels; 0 = sharp), light  { dir: [x, y, z] towards the light, shadow: 0..1 how dark the shadows are }
//   ground.style  'sand' (rake lines) or 'wood' (planks)
//   bowlHeight  how high the bowl stands above the floor (the thickness of the table), default 4
//   box     the plain wooden table: { w, d, z, shader } = width (x), depth (z), z of its centre, shader (default 110, 52, 2, floorwood)
//   table   optional: a model for the table top instead of the plain wooden box { model, scale, rotation, translate } (translate y = 0 is the floor)
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

  // indoors: a plaster wall with a mahogany window behind the bowl, wooden floor, plants, three stacked black stones
  room1: {
    mist: '#f3ecdd',
    fog: [220, 700],
    ground: { colorA: '#7e4f2c', colorB: '#a46c3c', ripple: 2.2, style: 'wood' },
    blur: 3,
    light: { dir: [-0.45, 0.85, 0.55], shadow: 0.4 },
    models: [
      { model: 'wall', scale: 1.6, rotation: [0, 0, 0], translate: [0, 0, -62] },
      { model: 'window', scale: 1.6, rotation: [0, 0, 0], translate: [0, 6.4, -61.4] },
      { model: 'plant', scale: 1.7, rotation: [0, 20, 0], translate: [-50, 0, -46] },
      { model: 'plant', scale: 2.1, rotation: [0, 140, 0], translate: [56, 0, -44] },
      { model: 'plant', scale: 1.3, rotation: [0, 70, 0], translate: [-72, 0, 12] },
      { model: 'stones', scale: 1.4, rotation: [0, 30, 0], translate: [74, 0, 14] },
      { model: 'mountain', scale: 4, rotation: [0, 0, 0], translate: [0, 0, -330] }, // seen through the window
    ],
  },
};

// ── Worlds ───────────────────────────────────────────────────────────────────────────────────────────────────
// Levels are grouped in worlds: the menu shows a row of worlds at the top and the levels of the chosen one below it.
// A level names its world with `world: 'key'` (the first world when it names none).
export const worlds = {
  world1: { name: 'World 1' },
  world2: { name: 'World 2' },
};

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────────────────
// The levels live in their own file: ./levels.js (the debug menu rewrites it when you make or change levels).
export { levels } from './levels.js';

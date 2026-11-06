import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  applyDefinitions, backgroundKeyOf, cloneDefinitions, backgroundOf, BODY, bowlKeyOf, bowlOf, bowlProfile, buildShape, DEBUG, DEPTH, dropOf, DROP, FRONT_Z, getShape, groundYOf,
  HOVER_Z, levels, LOSE_TEXT, MAX_LIGHTS, shadowSettings, materials, MATERIAL_KEYS, meta, models, PHASE, PLAY_Z, PREVIEW_COUNT, SHAPE_KEYS, slotPos, tuning, unionOutlines, VIEW, WATER_Y, worldKeyOf, worlds,
} from './shared.js';

// The definitions as the files have them (debug: every new game starts from these, because the definitions in this page are edited in place).
const PRISTINE = DEBUG ? cloneDefinitions() : null;
import { flatNormals, parseObj } from './obj.js';
import { deformShaders, SHADOW_GLSL, refractShaders, shaders, transparentShaders, vertexShader, waveVertexShader } from './shaders.js';

// All styling lives in ./style.css (static, prefixed bb-). It is attached once, the first time the game is mounted.
function loadStyles() {
  if (document.querySelector('link[data-bb-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./style.css', import.meta.url).href;
  link.dataset.bbStyle = '';
  document.head.append(link);
}

const SEND_GAP = 33; //          ms between move messages (~30 per second)
const ROTATE_STEP = 45; //       a held block turns in steps of this many degrees (Q / E, or the mouse wheel)
const BOWL_SEGS = 72;
const SHADOW_NEAR = 60; //       the light camera looks at the table from 200 away
const SHADOW_FAR = 340;
const LAMP = ['#22c55e', '#f97316', '#ef4444']; // lamp on a fragile block: nothing on it, something on it, at its limit
const TABLE_INDEX = -2; // the instance number of the table model in the background studio (the models of the background are 0, 1, 2 ...)
const TABLE = { w: 110, d: 52, h: 4, z: 2 }; // the wooden table the bowl and the waiting blocks stand on (its top is the bottom of the bowl)

/** A colour as the raw numbers of its hex code: for our own shaders, which write colours to the screen without any conversion. */
/** What a scenery object's `blur` setting means: 'none' = sharp, 'heavy' = the strong blur, anything else = the light blur. */
const LIGHT0 = 1000; // the viewport number of the first light of a background (models are 0, 1, 2 ...; see debugModelAt)
const blurLevelOf = (v) => (v === 'none' ? 0 : v === 'heavy' ? 2 : 1);
const rawColor = (hex) => {
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return new THREE.Color().setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const RELEASE_DELAY = 50;  //   ms between letting go of the mouse and the block really dropping (pressing again in that time picks it back up)
const STORE = 'balance.done'; // localStorage: indexes of completed levels
const copyOf = (v) => JSON.parse(JSON.stringify(v));

/**
 * planck (the physics library) for the debug menu's local game. The server loads it from npm; a browser needs a URL. Best: put it in the
 * import map of client/index.html next to three ("planck": "https://esm.sh/planck@1"), then the first address below finds it. If it is not
 * there, the CDNs after it are tried.
 */
const PLANCK_FROM = ['planck', 'https://esm.sh/planck@1', 'https://cdn.jsdelivr.net/npm/planck@1/+esm'];
let planckLoading = null;
function loadPlanck() {
  if (!planckLoading) {
    planckLoading = (async () => {
      let last = null;
      for (const url of PLANCK_FROM) {
        try {
          const m = await import(url);
          const planck = m.World ? m : m.default?.World ? m.default : null;
          if (planck) return planck;
        } catch (e) {
          last = e;
        }
      }
      throw new Error(`the physics library (planck) could not be loaded in the browser (${last?.message ?? last}). Add "planck": "https://esm.sh/planck@1" to the import map in client/index.html.`);
    })();
    planckLoading.catch(() => { planckLoading = null; }); // (a failed load may be tried again)
  }
  return planckLoading;
}

const loadDone = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE) ?? '[]'));
  } catch {
    return new Set();
  }
};
const saveDone = (set) => {
  try {
    localStorage.setItem(STORE, JSON.stringify([...set]));
  } catch { /* private mode: progress just is not remembered */ }
};

/**
 * A prism with chamfered edges, built from a counter-clockwise outline. The outline is the real (physics) outline: the chamfer is
 * cut INTO the block, so nothing sticks out. Parts: front / back cap (inset by the chamfer), a 45° chamfer strip on each side, and the
 * side wall. UVs (what the shaders texture with): caps use (x, y); chamfers and walls use (distance along the outline, z), so the
 * texture runs along the edge instead of being smeared through the block. Normals are smooth along gentle curves (circles) and
 * crisp at corners.
 */
function chamferedPrism(outline, depth, c, holes = []) {
  const h = depth / 2;
  const R = Math.SQRT1_2;
  const SMOOTH = Math.cos(THREE.MathUtils.degToRad(35));
  const pos = [];
  const nor = [];
  const uvs = [];
  const idx = [];
  const vert = (x, y, z, nx, ny, nz, u, v) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uvs.push(u, v);
    return pos.length / 3 - 1;
  };
  const tri = (a, b, d, want) => { // winding is chosen so the face points the way `want` says
    const A = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
    const B = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
    const C = [pos[d * 3], pos[d * 3 + 1], pos[d * 3 + 2]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const cx = u[1] * w[2] - u[2] * w[1];
    const cy = u[2] * w[0] - u[0] * w[2];
    const cz = u[0] * w[1] - u[1] * w[0];
    if (cx * want[0] + cy * want[1] + cz * want[2] >= 0) idx.push(a, b, d);
    else idx.push(a, d, b);
  };

  // every loop keeps the solid on its left: the outline counter-clockwise, holes clockwise (so "outward" is always away from the solid)
  const loops = [outline, ...holes].map((pts) => {
    const N = pts.length;
    const P = pts.map(([x, y]) => new THREE.Vector2(x, y));
    const edgeN = P.map((p, i) => {
      const q = P[(i + 1) % N];
      return new THREE.Vector2(q.y - p.y, p.x - q.x).normalize();
    });
    const Q = P.map((p, i) => { // the loop moved into the solid by c (mitred corners)
      const n1 = edgeN[(i + N - 1) % N];
      const n2 = edgeN[i];
      const m = n1.clone().add(n2).multiplyScalar(1 / Math.max(0.25, 1 + n1.dot(n2)));
      return p.clone().addScaledVector(m, -c);
    });
    const arc = [0];
    for (let i = 0; i < N; i++) arc.push(arc[i] + P[i].distanceTo(P[(i + 1) % N]));
    return { N, P, edgeN, Q, arc };
  });

  // caps (with the holes cut out)
  for (const sign of [1, -1]) {
    const base = pos.length / 3;
    for (const L of loops) L.Q.forEach((q) => vert(q.x, q.y, sign * h, 0, 0, sign, q.x, q.y));
    const faces = THREE.ShapeUtils.triangulateShape(loops[0].Q.map((q) => q.clone()), loops.slice(1).map((L) => L.Q.map((q) => q.clone())));
    for (const [a, b, d] of faces) tri(base + a, base + b, base + d, [0, 0, sign]);
  }

  // chamfers and the side wall, edge by edge
  for (const { N, P, edgeN, Q, arc } of loops) {
    // normal of edge e as seen from one of its ends: smoothed with the neighbouring edge when the corner is gentle
    const normalAt = (e, atEnd) => {
      const own = edgeN[e];
      const other = edgeN[(e + (atEnd ? 1 : N - 1)) % N];
      return own.dot(other) > SMOOTH ? own.clone().add(other).normalize() : own;
    };
    for (let e = 0; e < N; e++) {
      const f = (e + 1) % N;
      const n0 = normalAt(e, false);
      const n1 = normalAt(e, true);
      const own = edgeN[e];
      const zs = h - c;
      // side wall: z from -zs to +zs
      const w0 = vert(P[e].x, P[e].y, -zs, n0.x, n0.y, 0, arc[e], -zs);
      const w1 = vert(P[f].x, P[f].y, -zs, n1.x, n1.y, 0, arc[e + 1], -zs);
      const w2 = vert(P[f].x, P[f].y, zs, n1.x, n1.y, 0, arc[e + 1], zs);
      const w3 = vert(P[e].x, P[e].y, zs, n0.x, n0.y, 0, arc[e], zs);
      tri(w0, w1, w2, [own.x, own.y, 0]);
      tri(w0, w2, w3, [own.x, own.y, 0]);
      // chamfer strips: from the wall edge (z = ±zs) inwards to the cap edge (z = ±h)
      for (const sign of [1, -1]) {
        const a = vert(P[e].x, P[e].y, sign * zs, n0.x * R, n0.y * R, sign * R, arc[e], sign * zs);
        const b = vert(P[f].x, P[f].y, sign * zs, n1.x * R, n1.y * R, sign * R, arc[e + 1], sign * zs);
        const d = vert(Q[f].x, Q[f].y, sign * h, n1.x * R, n1.y * R, sign * R, arc[e + 1], sign * h);
        const g = vert(Q[e].x, Q[e].y, sign * h, n0.x * R, n0.y * R, sign * R, arc[e], sign * h);
        tri(a, b, d, [own.x * R, own.y * R, sign * R]);
        tri(a, d, g, [own.x * R, own.y * R, sign * R]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * Give every vertex an attribute `edge`: its distance (in the face plane, x y) to the outline of the shape (outer outline and holes). The vertex shader of the
 * water block uses it to keep the edges of the block still while the middle of the faces moves: the player must always see where the real edge (the collision) is.
 * It depends on the position only, so vertices at the same place always get the same value.
 */
function addEdgeDistance(geo, loops) {
  const P = geo.getAttribute('position').array;
  const edge = new Float32Array(P.length / 3);
  for (let i = 0; i < edge.length; i++) {
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    let best = Infinity;
    for (const loop of loops) {
      for (let k = 0; k < loop.length; k++) {
        const [ax, ay] = loop[k];
        const [bx, by] = loop[(k + 1) % loop.length];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
      }
    }
    edge[i] = best;
  }
  geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
}

/**
 * Cut EVERY triangle of a geometry into 3 x 3 = 9 smaller ones (each edge in thirds). Every triangle is cut the same way, so neighbours always agree about
 * where their shared edge is cut: no gaps. Position, normal and uv are interpolated. Returns a geometry without index.
 */
function subdivide3(geo) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const P = src.getAttribute('position').array;
  const Nn = src.getAttribute('normal').array;
  const U = src.getAttribute('uv').array;
  const pos = [];
  const nor = [];
  const uvs = [];
  const at = (t, i, j) => { // the point (i, j) of the 3 x 3 grid of triangle t (corners 0, 1, 2): corner 0 + i/3 towards corner 1 + j/3 towards corner 2
    const s = i / 3;
    const u = j / 3;
    const w = 1 - s - u;
    const g = (arr, n) => Array.from({ length: n }, (_, k) => arr[(t * 3) * n + k] * w + arr[(t * 3 + 1) * n + k] * s + arr[(t * 3 + 2) * n + k] * u);
    return { p: g(P, 3), n: g(Nn, 3), u: g(U, 2) };
  };
  const push = (q) => {
    const l = Math.hypot(...q.n) || 1;
    pos.push(...q.p);
    nor.push(q.n[0] / l, q.n[1] / l, q.n[2] / l);
    uvs.push(...q.u);
  };
  for (let t = 0; t < P.length / 9; t++) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3 - i; j++) {
        push(at(t, i, j)); push(at(t, i + 1, j)); push(at(t, i, j + 1)); //                       (the 6 triangles that point the same way as the original)
        if (i + j < 2) { push(at(t, i + 1, j)); push(at(t, i + 1, j + 1)); push(at(t, i, j + 1)); } // (and the 3 between them)
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (src !== geo) src.dispose();
  geo.dispose();
  return out;
}

/**
 * A flat strip (in the xy plane, z = 0) that follows an outline on its OUTSIDE: `width` wide, so the shape itself stays free of it. For loops that keep the solid
 * on their left (outer = counter-clockwise, holes = clockwise: what shapeOutlines gives). uv = (distance along the line, 0 inner edge .. 1 outer edge).
 * This is the chalk outline of the blocks that are still to come.
 */
function outlineRibbon(outline, holes, width) {
  const pos = [];
  const uvs = [];
  const idx = [];
  for (const pts of [outline, ...holes]) {
    const N = pts.length;
    if (N < 3) continue;
    const P = pts.map(([x, y]) => new THREE.Vector2(x, y));
    const edgeN = P.map((p, k) => {
      const q = P[(k + 1) % N];
      return new THREE.Vector2(q.y - p.y, p.x - q.x).normalize();
    });
    const base = pos.length / 3;
    let arc = 0;
    for (let k = 0; k <= N; k++) { // (N + 1 columns: the last one is the first again, so the texture does not jump)
      const p = P[k % N];
      const n1 = edgeN[(k + N - 1) % N];
      const n2 = edgeN[k % N];
      const m = n1.clone().add(n2).multiplyScalar(1 / Math.max(0.35, 1 + n1.dot(n2))); // mitred corner (capped at sharp corners)
      pos.push(p.x, p.y, 0, p.x + m.x * width, p.y + m.y * width, 0);
      uvs.push(arc, 0, arc, 1);
      if (k < N) arc += p.distanceTo(P[(k + 1) % N]);
    }
    for (let k = 0; k < N; k++) {
      const a = base + k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3 * 3).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * The meshes of one shape: one chamfered prism per part, or (merge on, the default) the parts joined in 2D first and extruded once,
 * so there are no seams between touching parts. Collision never changes: it always uses the separate parts. A shape with a drawing-only
 * outline uses that outline as it is.
 * @returns {{pts:number[][], holes:number[][][]}[]}
 */
function shapeOutlines(shape, merge) {
  if (shape.visual) return shape.visual.map((v) => ({ pts: v.pts, holes: v.holes ?? [] }));
  const own = shape.parts.map((q) => (q.type === 'circle' ? circleOutline(q) : q.pts));
  if (merge && own.length > 1) {
    const u = unionOutlines(own);
    if (u) return u.map((r) => ({ pts: r.outer, holes: r.holes }));
  }
  return own.map((pts) => ({ pts, holes: [] }));
}

/** Is the point inside the polygon? (even-odd rule) */
function insidePoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Does this shape look the same when it is turned half a way round about its middle (so also after a quarter turn, or any turn in the steps of 45 degrees a
 * block makes), AND is its middle solid? Then something drawn on the middle of it stays exactly where it is while the block turns. Found by comparing a grid of points
 * with the points opposite them. (The shape is centred on the middle of its bounding box, and a half turn about that point keeps the bounding box.)
 */
const centreMemo = new WeakMap();
function lookSameWhenTurned(shape) {
  let known = centreMemo.get(shape);
  if (known !== undefined) return known;
  const outlines = shapeOutlines(shape, tuning.mergeParts !== false);
  const inside = (x, y) => outlines.some((o) => insidePoly(o.pts, x, y) && !o.holes.some((hole) => insidePoly(hole, x, y)));
  known = inside(0, 0);
  const N = 41;
  for (let i = 0; known && i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -shape.w / 2 + ((i + 0.37) * shape.w) / N; // (a grid shifted off the edges, so no point sits exactly on a corner or a straight edge)
      const y = -shape.h / 2 + ((j + 0.61) * shape.h) / N;
      if (inside(x, y) !== inside(-x, -y)) { known = false; break; }
    }
  }
  centreMemo.set(shape, known);
  return known;
}

/** Outline of a circle part as a counter-clockwise point list. */
function circleOutline(part, sides = 48) {
  return Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * Math.PI * 2;
    return [part.cx + Math.cos(a) * part.r, part.cy + Math.sin(a) * part.r];
  });
}

/** A block you hold: it stands up while it is lifted from 0 to TILT_UNTIL of the way to the play area, and moves back in z from BACK_FROM to the top. */
const TILT_UNTIL = 0.7;
const BACK_FROM = 0.4;
const GHOST_IN = 0.5; //  seconds: an outline fades in
const GHOST_OUT = 0.45; // seconds: it fades away when its block takes over
const smooth = (t) => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };
const backOf = (prog) => smooth((prog - BACK_FROM) / (1 - BACK_FROM));

class BalanceView {
  markerGeo = Object.assign(new THREE.SphereGeometry(0.55, 16, 12), { userData: { shared: true } }); // (never disposed with a scene)
  dotGeo = Object.assign(new THREE.CircleGeometry(1, 32), { userData: { shared: true } }); // the stack-limit lamp on glass
  shardGeo = Object.assign(new THREE.BoxGeometry(1, 1, 1), { userData: { shared: true } });
  shards = []; //            pieces of a block that just broke: { mesh, vx, vy, vz, spin, life }
  // visual effects (see #renderAll): shadows from a light, a blurred background, a reflective water surface. A pass that throws is switched off.
  fx = { off: new Set(), shadowRT: null, shadowCam: null, depthMat: null, reflRT: null, reflCam: null, kawase: null };
  refrU = { //                       glass looks through to a copy of the picture drawn so far (see #refractPass)
    uRefr: { value: null },
    uRefrOn: { value: 0 },
    uRefrRes: { value: new THREE.Vector2(1, 1) },
  };
  shadowU = {
    uShadowMap: { value: null },
    uShadowMat: { value: new THREE.Matrix4() },
    uShadowStr: { value: 0 },
    uShadowTexel: { value: new THREE.Vector2(1 / 4096, 1 / 4096) },
    uShadowRange: { value: 170 },
    uShadowDepth: { value: SHADOW_FAR - SHADOW_NEAR },
    uShadowR: { value: new THREE.Vector3(1, 0, 0) },
    uShadowU: { value: new THREE.Vector3(0, 1, 0) },
    uShadowBias: { value: 0.12 },
    uShadowNormal: { value: 1.5 },
    uShadowK: { value: 1 },
    // the light of the moment (see #applyDay): one sun / moon for shading and shadows, soft light from the sky and from the ground
    uLightDir: { value: new THREE.Vector3(-0.35, 0.8, 0.5).normalize() },
    uLightCol: { value: new THREE.Vector3(0.72, 0.7, 0.64) },
    uAmbSky: { value: new THREE.Vector3(0.6, 0.63, 0.68) },
    uAmbGround: { value: new THREE.Vector3(0.45, 0.41, 0.35) },
    // caustics under the water
    uWaterY: { value: WATER_Y },
    uCaus: { value: 0 },
    uBowlHalf: { value: new THREE.Vector2(20, 12) },
    // point lights of the background
    uLPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    uLCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    uLRange: { value: new Array(MAX_LIGHTS).fill(1) },
    uLN: { value: 0 },
  };
  lightMarkers = null; // debug: a little ball for every light (in frontScene, so it shows through everything)
  markersOn = false;
  fogs = []; //      the mist colours of the world: { value, base }, tinted by the time of day
  mistNow = new THREE.Color('#e7e2d6');
  waterU = { uRefl: { value: null }, uReflMat: { value: new THREE.Matrix4() }, uReflStr: { value: 0 } };
  bgFx = { blur: 0, light: null };
  scenery = null; //  the part of the world that is blurred: the floor and the models of the background
  mainGroup = null; // the table, the bowl and the water
  floorMesh = null;
  water = null;
  instGroups = new Map(); // debug: background model instance index -> its 3D group (the background studio picks and moves them)
  selIndex = null; //       debug: selected instance
  selBox = null; //         debug: box drawn around it
  floorY = 0;
  camHook = null; //        debug: { down(e) -> consumed?, move(e), up(e) } lets a studio use the pointer while the free camera is on
  hookDrag = false;
  objCache = new Map(); //   model file -> Promise of the parsed .obj
  modelGeo = new Map(); //   file|flat/smooth -> [{ name, geo }] (shared by every instance of the model)
  worldToken = 0; //         bumps whenever the world is rebuilt, so late-loading models of the old one are dropped
  sceneSig = null;
  groundY = -9; //           top of the table (set from the bowl of the level)
  bowlDef = null;
  currentLevel = null;
  userCam = { yaw: 0, pitch: 0, zoom: 1, pan: new THREE.Vector3() }; // the player's own view change on top of the fitted camera
  fit = null; //            { pos, target } of the fitted camera (what 'reset camera' goes back to)
  world = null; //          the three.js group of the table, bowl and water
  worldKey = null; //       key of the world whose levels the menu shows
  worldBtns = [];
  userDrag = null; //       { x, y, pan } while the player drags the camera
  freeCam = null; //         debug: orbit camera state, null = the normal fitted camera
  camDrag = null;
  dropHelper = null; //      debug: wireframe of the drop zone
  defsRev = 0; //            debug: which version of the definitions we have
  defsAsk = 0;
  firstDrev = undefined;
  gotRoomDefs = false;
  // The debug menu's LOCAL GAME ("sandbox"): a private BalanceGame (sim.js) that this page runs on its own copy of the definitions and shows
  // INSTEAD of the room's game. Nothing of it is sent anywhere. The room's game goes on without us: we only keep track of what it does.
  roomCtx = null; //         the platform's ctx (this.ctx is swapped for the local game's one while the local game is shown)
  roomSnap = null; //        the room's latest snapshot
  roomDefs = null; //        the definitions the room's game runs (null = the files as they were loaded, see PRISTINE)
  sandbox = null; //         { game, queue, timer, last, defs, ready } while the local game is shown, else null
  onSaved = null; //         debug: called with { id, ok, error?, index?, file? } when the server answers an explicit save of a level / shape
  lastSv = null;
  onSandbox = null; //       debug: called with (on, error) when the local game turns on or off
  onProblem = null; //      debug: called with a message when something in the drawing or the definitions went wrong (the debug menu shows it)
  problems = new Map(); //  message -> count (each message is reported once)
  onRun = null; //           debug: called when a level starts / restarts
  onSnap = null; //          debug: called with every snapshot (the level studio draws the live world from it)
  top = 0; //                debug: pixels at the top that the studio bar covers
  dock = 0; //               debug: pixels at the left that the studio panel covers (the game is drawn in the rest)
  ptr = null; //             pointer position in the play plane while carrying
  tableViews = new Map(); // blockId -> view of a block lying on the table
  bodyViews = new Map(); //  blockId -> view of a block in the play area (static, floating, falling, or held by somebody)
  poseMem = new Map(); //    blockId -> last drawn pose of a removed view (a block picked up / put back moves from there)
  geoCache = new Map(); //   shape key -> [{ geo }]
  ghosts = []; //           the chalk outlines of the blocks still to come, on fixed places of the row: [{ id, spot, group, geos, mat, t, out }]
  ghostFirst = true; //     the next snapshot is the first of this level (the outlines are simply there then, they do not fade in)
  players = []; //           room players: { id, name, slot }
  snap = null;
  run = -1;
  phase = -1;
  done = loadDone();

  // input state. mode: none | drag (button down, carrying) | released (sent drop, waiting to see)
  mode = 'none';
  local = { x: 0, y: 12, rot: 0 }; // where WE hold the block (play-plane coordinates, instant), rot in degrees
  prog = 0; //                       how far the block we hold is lifted (0 = down on the table where we picked it up, 1 = up in the play area)
  pickY = 0; //                      height of the pointer when we picked the block up
  grab = { x: 0, y: 0 }; //          pointer-to-block-centre offset, so the block does not jump
  modeTime = 0;
  downAt = { x: 0, y: 0, t: 0 };
  lastSent = 0;
  raf = 0;
  lastFrame = performance.now();
  uTime = { value: 0 };
  ray = Object.assign(new THREE.Raycaster(), { layers: Object.assign(new THREE.Layers(), { mask: 0b101 }) }); // (layer 0 and the glass of layer 2)
  ndc = new THREE.Vector2();
  hit = new THREE.Vector3();
  plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PLAY_Z);

  constructor(ctx) {
    if (PRISTINE) applyDefinitions(PRISTINE); // a new game (another room) starts from the files again: edits made in a room stay in that room
    this.ctx = ctx; // ctx.me.slot is -1 for spectators: they watch the same physics, no input
    this.roomCtx = ctx;
    this.spectator = ctx.me.slot < 0;
    loadStyles();
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); // stands in until a pass has made a real texture
    white.needsUpdate = true;
    this.shadowU.uShadowMap.value = white;
    this.waterU.uRefl.value = white;
    this.whiteTex = white;
    this.#buildScene();
    this.#buildUi();
    this.root = el('div', { class: 'bb-root' }, this.renderer.domElement, this.hud, this.cdEl, this.menu, this.result);
    ctx.container.append(this.root);
    this.#setScene(null);

    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(ctx.container);
    this.#resize();

    if (!this.spectator) {
      const c = this.renderer.domElement;
      c.addEventListener('pointerdown', this.#onDown);
      c.addEventListener('pointermove', this.#onMove);
      c.addEventListener('pointerup', this.#onUp);
      c.addEventListener('pointercancel', this.#onUp);
      c.addEventListener('wheel', this.#onWheel, { passive: false });
      c.addEventListener('contextmenu', this.#onContext);
      window.addEventListener('keydown', this.#onKeyDown);
    }
    this.onRoom(ctx.room);
    this.raf = requestAnimationFrame(this.#frame);

    if (DEBUG && !this.spectator) { // the debug menu is a separate file: nobody downloads it unless DEBUG is on
      import('./debug.js')
        .then((m) => {
          if (this.disposed) return;
          this.debug = m.createDebugMenu(this);
          this.root.append(this.debug.el);
        })
        .catch((e) => console.error('balance: debug menu failed to load', e));
    }
  }

  // ── GameView ──
  onRoom(room) {
    this.players = room.players.filter((p) => p.slot >= 0);
    this.legend.replaceChildren(
      ...this.players.map((p) => {
        const dot = el('span', { class: 'bb-dot' });
        dot.style.setProperty('--c', meta.seatColors[p.slot] ?? '#fff'); // the colour is the only dynamic style; the rest is in style.css
        return el('div', { class: 'bb-player' }, dot, p.id === this.ctx.me.id ? `${p.name} (you)` : p.name);
      }),
    );
    if (this.snap) this.#updateHud(this.snap);
  }

  onSnapshot(s) {
    if (DEBUG) {
      this.roomSnap = s;
      if (this.sandbox) { // the local game is shown: the room goes on without us, we only keep track of its definitions
        this.#syncDefs(s);
        return;
      }
    }
    this.#applySnapshot(s, true);
  }

  /** Draw a snapshot: the room's (`fromRoom`) or the local game's. */
  #applySnapshot(s, fromRoom) {
    this.snap = s;
    const now = performance.now();
    if (DEBUG && fromRoom) this.#syncDefs(s);

    if (s.run !== this.run) { // new level, restart or back to the menu: rebuild everything from scratch
      this.#clearViews();
      this.run = s.run;
      this.mode = 'none';
      this.#setScene(levels[s.lv] ?? null);
      this.onRun?.(s);
    }
    if (s.ph !== this.phase) this.#onPhase(s.ph, s);

    // 1. drop views whose block is gone (remembering where they were, so the block can move on smoothly from there)
    const inBody = new Set(s.b.map((r) => r[0]));
    const onTable = new Set(s.tbl.filter((r) => r[4] < 0).map((r) => r[0]));
    for (const [id, v] of this.bodyViews) {
      if (inBody.has(id)) continue;
      if (v.limit !== undefined && v.st === BODY.NORMAL && s.ph === PHASE.PLAY) this.#shatter(v); // a fragile block that was just lying there: it broke
      this.#remove(this.bodyViews, id, v);
    }
    for (const [id, v] of this.tableViews) if (!onTable.has(id)) this.#remove(this.tableViews, id, v);

    // 2. blocks on the table (the row is centred on all of its places, outlines included: `w`, fixed for the level, so nothing ever shifts)
    this.#syncGhosts(s);
    for (const [id, si, mi, slot, heldBy] of s.tbl) {
      if (heldBy >= 0) continue;
      let v = this.tableViews.get(id);
      if (!v) {
        const ghost = this.ghosts.find((g) => g.id === id);
        if (ghost && !this.poseMem.has(id)) { // this block was an outline: it comes out of it, right there (its outline was on its place)
          this.poseMem.set(id, { x: ghost.group.position.x, y: this.groundY + DEPTH / 2, z: FRONT_Z, s: 1, a: 0, tl: 0 });
        }
        v = this.#makeView(this.tableViews, id, si, mi, { table: true, slot, n: s.w ?? s.n });
        if (ghost) {
          v.reveal = 0;
          v.mats.forEach((m) => { m.uniforms.uReveal.value = 0; });
        }
      }
      v.slot = slot;
      v.n = s.w ?? s.n;
    }

    // 3. blocks in the play area
    let mine = null;
    for (const [id, si, mi, x, y, a, st, owner, load] of s.b) {
      const v = this.bodyViews.get(id) ?? this.#makeView(this.bodyViews, id, si, mi, { x, y, a, st, owner });
      Object.assign(v, { tx: x, ty: y, ta: a, st, owner });
      this.#setLoad(v, load ?? 0);
      v.static = st === BODY.STATIC;
      const held = st === BODY.HELD || st === BODY.HELD_BAD;
      if (held && owner === this.ctx.me.slot) mine = id;
      v.mats.forEach((m) => { m.uniforms.uBad.value = st === BODY.HELD_BAD ? 1 : 0; m.uniforms.uCausOn.value = held ? 0 : 1; }); // (a block in your hand is not in the water) // the only tint a block ever gets: red = outside the drop area
    }

    // reconcile our pointer state with what the server says we are holding
    if (this.mode === 'released') {
      if (mine === null) this.mode = 'none';
      else if (now - this.modeTime > 350) { // the server still says we hold it (message lost?): let go again
        this.ctx.sendInput({ drop: true });
        this.modeTime = now;
      }
    } else if ((this.mode === 'drag' || this.mode === 'releasing') && mine === null && now - this.modeTime > 500) {
      this.mode = 'none';
    }

    this.#updateHud(s);
    this.onSnap?.(s);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.sandbox?.timer);
    this.sandbox = null;
    this.observer.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener('pointerdown', this.#onDown);
    c.removeEventListener('pointermove', this.#onMove);
    c.removeEventListener('pointerup', this.#onUp);
    c.removeEventListener('pointercancel', this.#onUp);
    c.removeEventListener('wheel', this.#onWheel);
    c.removeEventListener('contextmenu', this.#onContext);
    window.removeEventListener('keydown', this.#onKeyDown);
    this.disposed = true;
    this.debug?.dispose();
    this.#clearViews();
    for (const parts of this.geoCache.values()) parts.forEach((p) => p.geo.dispose());
    this.#clearModelGeo();
    this.#disposeTree(this.scene);
    this.#disposeTree(this.frontScene);
    for (const k of ['shadowRT', 'reflRT']) this.fx[k]?.dispose();
    for (const t of [...(this.fx.kawase?.rts ?? []), ...(this.fx.kawase?.nearUp ?? []), ...(this.fx.kawase?.farUp ?? [])]) t?.dispose();
    for (const m of ['down', 'up', 'mix']) this.fx.kawase?.[m].dispose();
    this.fx.kawase?.maskRT?.dispose();
    this.fx.kawase?.maskMats.forEach((m) => m.dispose());
    this.fx.depthMat?.dispose();
    this.markerGeo.dispose();
    this.dotGeo.dispose();
    this.shardGeo.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.root.remove();
  }

  // ── debug menu support (everything the menu in debug.js needs from the view) ──
  /** Is somebody else's change to the definitions on its way? Then take it. (Only with DEBUG on.) */
  /** Report a problem once (console + the debug menu). */
  #report(msg, e) {
    if (this.problems.has(msg)) return;
    this.problems.set(msg, 1);
    console.error(`balance: ${msg}`, e ?? '');
    this.onProblem?.(msg);
  }

  #syncDefs(s) {
    if (s.sv && s.sv.id !== this.lastSv) { // how the server did with a level / shape that somebody asked it to save (only the one who asked knows the id)
      this.lastSv = s.sv.id;
      this.onSaved?.(s.sv);
    }
    if (s.drev !== undefined) this.firstDrev ??= s.drev; // (which version of the room's definitions we met when we came in)
    if (s.drev === undefined || s.drev === this.defsRev) return;
    if (s.defs) { // the server applied somebody's change (maybe ours): everybody takes over its version, at the same snapshot
      this.roomDefs = s.defs;
      this.defsRev = s.drev;
      if (!this.sandbox) { // (with the local game on, the room's version waits: it is applied when you go back to the room)
        applyDefinitions(s.defs);
        this.debugRefresh();
      }
      // Gameplay is shared (the room's game now uses this version, and everybody sees it), the debug menus are not: another player's
      // applied changes never touch your draft. The one exception is joining a room that already has changes: the draft starts from them.
      const joining = this.firstDrev > 0 && !this.gotRoomDefs;
      this.gotRoomDefs = true;
      if (joining) this.debug?.onRoomDefs?.();
    } else if (performance.now() - this.defsAsk > 1500) { // the server has newer definitions and has not sent them (we just joined)
      this.defsAsk = performance.now();
      this.roomCtx.sendInput({ defsRequest: true });
    }
  }

  /** Rebuild everything that is drawn from the definitions: the block geometry, the level cards and the world. */
  debugRefresh() {
    try {
      this.#refresh();
    } catch (e) {
      this.#report(`building the scene failed: ${e?.message ?? e}`, e);
    }
  }

  #refresh() {
    for (const parts of this.geoCache.values()) parts.forEach((p) => p.geo.dispose());
    this.geoCache.clear();
    this.#clearModelGeo();
    this.#clearViews(); // the next snapshot makes new ones
    this.#buildCards();
    this.#setScene(levels[this.snap?.lv] ?? null, true);
    if (this.snap) this.#updateHud(this.snap);
  }

  // ── the local game (debug): a private copy of the game that only this page runs ──
  /** Is the local game (and not the room's game) what this view shows? */
  get sandboxOn() {
    return !!this.sandbox;
  }

  /** The definitions the room's game runs right now (what "Reload from game" takes). */
  debugRoomDefs() {
    return this.roomDefs ?? PRISTINE;
  }

  /** The level the room's game is playing (-1 = its menu). */
  debugRoomLevel() {
    return this.roomSnap?.lv ?? -1;
  }

  /**
   * Show a private copy of the game instead of the room's: the server's own physics (sim.js) runs in THIS page on a copy of `defs` (the
   * debug menu's draft). Nothing goes to the server, nobody else sees or feels anything, and the room's game goes on without you.
   * Everything the view sends (this.ctx.sendInput: pick, drop, start, restart, lab ...) now goes to the local game.
   * @returns {Promise<boolean>} true when it runs; false when it could not start (the room's game is shown again, onSandbox got the reason)
   */
  debugSandboxOn(defs) {
    if (!DEBUG || this.spectator) return Promise.resolve(false);
    if (this.sandbox) {
      this.sandbox.defs = defs;
      return this.sandbox.ready;
    }
    const sb = { game: null, queue: [], timer: 0, last: performance.now(), defs, ready: null };
    this.sandbox = sb;
    const room = this.roomCtx;
    if (this.snap?.b?.some((r) => (r[6] === BODY.HELD || r[6] === BODY.HELD_BAD) && r[7] === room.me.slot)) room.sendInput({ cancel: true }); // (a block in your hand goes back to the table: you are leaving the room's game for a while)
    this.ctx = new Proxy({}, { get: (_, key) => (key === 'sendInput' ? this.#sandboxSend : Reflect.get(room, key, room)) }); // (the room's ctx, except that what the view sends goes to the local game)
    this.mode = 'none';
    this.onSandbox?.(true, '');
    sb.ready = (async () => {
      try {
        const [sim, planck] = await Promise.all([import('./sim.js'), loadPlanck()]);
        if (this.sandbox !== sb) return false; // switched off while it was loading
        sim.usePlanck(planck);
        sb.game = new sim.BalanceGame({ players: [{ id: room.me.id, slot: room.me.slot }], sandboxDefs: copyOf(sb.defs) });
        this.snap = null; // (the room's picture goes: the first snapshot of the local game starts from scratch)
        this.run = -1;
        this.phase = -1;
        this.debugRefresh(); // the definitions in this page are now the local game's: rebuild everything drawn from them
        for (const d of sb.queue.splice(0)) sb.game.onInput(room.me.id, d);
        sb.last = performance.now();
        sb.timer = setInterval(() => this.#sandboxTick(), 1000 / meta.tickRate);
        this.#sandboxTick();
        return true;
      } catch (e) {
        console.error('balance: the local game could not start', e);
        if (this.sandbox === sb) this.debugSandboxOff(`the local game could not start: ${e?.message ?? e}`);
        return false;
      }
    })();
    return sb.ready;
  }

  /** Back to the room's game, with the definitions it runs. (The local game is thrown away.) */
  debugSandboxOff(error = '') {
    const sb = this.sandbox;
    if (!sb) return;
    clearInterval(sb.timer);
    this.sandbox = null;
    this.ctx = this.roomCtx;
    this.mode = 'none';
    applyDefinitions(this.debugRoomDefs());
    this.snap = this.roomSnap;
    this.run = -1; // (the next snapshot rebuilds the views from the room's)
    this.phase = -1;
    this.debugRefresh();
    if (this.roomSnap) this.#applySnapshot(this.roomSnap, true);
    this.onSandbox?.(false, error);
  }

  /**
   * The draft changed: give it to the local game. `full` = more than the levels changed (shapes, materials, bowls, tuning, backgrounds ...):
   * then everything drawn is rebuilt too. A level that is running keeps running unless its block lists changed (see sim.js).
   */
  debugSandboxLoad(defs, full = true) {
    const sb = this.sandbox;
    if (!sb) return;
    sb.defs = defs;
    if (!sb.game) return; // still loading: it starts from the newest
    try {
      if (full) {
        sb.game.loadDefinitions(defs);
        this.debugRefresh();
      } else {
        sb.game.loadLevels(defs.levels);
        this.#buildCards();
      }
    } catch (e) {
      this.#report(`the local game could not take your edits: ${e?.message ?? e}`, e);
    }
  }

  /** Send something to the LOCAL game, never to the room: the studios use this, so that a missing local game can never turn their lab commands into messages to the server. */
  debugSend(d) {
    if (this.sandbox) this.#sandboxSend(d);
  }

  #sandboxSend = (d) => {
    const sb = this.sandbox;
    if (!sb || typeof d !== 'object' || d === null || d.debugChunk || d.defsRequest) return; // (definitions are not sent anywhere from here)
    if (sb.game) sb.game.onInput(this.roomCtx.me.id, d);
    else if (d.lab || d.start !== undefined || d.restart || d.menu) sb.queue.push(d); // (still loading: commands wait, pointer moves do not)
  };

  #sandboxTick() {
    const sb = this.sandbox;
    if (!sb?.game) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - sb.last) / 1000);
    sb.last = now;
    try {
      sb.game.update(dt);
      this.#applySnapshot(sb.game.snapshot(), false);
    } catch (e) {
      this.#report(`the local game failed: ${e?.message ?? e}`, e);
    }
  }

  /** Forget the downloaded .obj files (after you changed one on disk) and redraw. */
  debugReloadModels() {
    this.objCache.clear();
    this.debugRefresh();
  }

  /** The parts found in an .obj file of ./models: [{ name, triangles }]. Rejects when the file cannot be loaded. */
  async debugModelInfo(file) {
    const obj = await this.#objFile(file);
    return obj.parts.map((p) => ({ name: p.name, triangles: p.triangles }));
  }

  get shaderNames() {
    return Object.keys(shaders);
  }

  /** Orbit camera: drag = turn, right-drag = move, wheel = zoom. Off = the normal camera again. */
  debugFreeCam(on) {
    if (!on) {
      this.freeCam = null;
      this.#fitCamera();
      return;
    }
    const target = new THREE.Vector3(0, tuning.camera.targetY, 0);
    const off = this.camera.position.clone().sub(target);
    this.freeCam = { target, dist: off.length(), yaw: Math.atan2(off.x, off.z), pitch: Math.asin(off.y / off.length()) };
    this.mode = 'none';
  }

  /**
   * A small 3D window that shows one model with its shaders (for the Models tab and the background studio).
   *   preview.set(def)   def = { file, shader?, shaders?, smooth? } (a draft entry of `models`)     preview.dispose()
   * It turns slowly; drag to turn it yourself, wheel to zoom.
   */
  debugModelPreview(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e7e2d6');
    scene.add(new THREE.AmbientLight('#ffffff', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-20, 40, 40);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
    const cam = { yaw: 0.6, pitch: 0.35, dist: 50, target: new THREE.Vector3(), auto: true };
    let group = null;
    let token = 0;
    let drag = null;
    let raf = 0;
    let dead = false;
    let last = performance.now();

    const place = () => {
      const cp = Math.cos(cam.pitch);
      camera.position.set(cam.target.x + cam.dist * cp * Math.sin(cam.yaw), cam.target.y + cam.dist * Math.sin(cam.pitch), cam.target.z + cam.dist * cp * Math.cos(cam.yaw));
      camera.lookAt(cam.target);
    };
    const loop = () => {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (cam.auto && !drag) cam.yaw += ((now - last) / 1000) * 0.5;
      last = now;
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      place();
      renderer.render(scene, camera);
    };
    const onDown = (e) => { drag = { x: e.clientX, y: e.clientY }; cam.auto = false; canvas.setPointerCapture(e.pointerId); };
    const onMove = (e) => {
      if (!drag) return;
      cam.yaw -= (e.clientX - drag.x) * 0.008;
      cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - drag.y) * 0.008, -0.3, 1.5);
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => { drag = null; };
    const onWheel = (e) => { e.preventDefault(); cam.dist = THREE.MathUtils.clamp(cam.dist * Math.exp(e.deltaY * 0.001), 1, 5000); };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    raf = requestAnimationFrame(loop);

    return {
      set: async (def) => {
        const mine = ++token;
        let parts;
        try {
          parts = await this.#modelParts(def);
        } catch {
          return;
        }
        if (mine !== token || dead) return;
        if (group) {
          group.removeFromParent();
          group.traverse((o) => o.material?.dispose());
        }
        group = new THREE.Group();
        parts.forEach((p, i) => {
          const shader = def.shaders?.[p.name] ?? def.shader ?? 'stone1';
          group.add(new THREE.Mesh(p.geo, this.#blockMaterial(shader, (i * 0.37) % 1, THREE.DoubleSide, null, true)));
        });
        scene.add(group);
        const box = new THREE.Box3().setFromObject(group);
        const size = box.getSize(new THREE.Vector3());
        box.getCenter(cam.target);
        cam.dist = Math.max(size.x, size.y, size.z, 0.01) * 1.9;
      },
      dispose: () => {
        dead = true;
        cancelAnimationFrame(raf);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        if (group) group.traverse((o) => o.material?.dispose());
        renderer.dispose();
        renderer.forceContextLoss?.(); // (a browser only allows about 16 WebGL contexts and takes the OLDEST away: a closed window must give its own back)
      },
    };
  }

  /** Debug: switch one visual effect ('shadows', 'reflection', 'blur', 'refraction') off or on (it also comes back on after it had failed). */
  debugFx(name, on) {
    if (on) this.fx.off.delete(name);
    else this.fx.off.add(name);
    if (!on && name === 'shadows') this.shadowU.uShadowStr.value = 0;
    if (!on && name === 'reflection') this.waterU.uReflStr.value = 0;
  }

  /** The free camera back at the place the game puts it. */
  debugCameraHome() {
    this.debugFreeCam(false);
    this.debugFreeCam(true);
  }

  /** Aim the free camera at a point (and keep its distance). */
  debugLookAt(x, y, z) {
    if (this.freeCam) this.freeCam.target.set(x, y, z);
  }

  /** Index of the background model under the pointer (client coordinates), or null. */
  debugModelAt(clientX, clientY) {
    this.#setRay({ clientX, clientY });
    const meshes = [];
    for (const g of this.instGroups.values()) if (g.parent?.visible !== false) g.traverse((o) => o.isMesh && meshes.push(o)); // (the balls of the lights only while they are shown)
    return this.ray.intersectObjects(meshes, false)[0]?.object.userData.inst ?? null;
  }

  /** Where the pointer's ray meets the horizontal plane `y` above the floor: { x, z } in world units, or null. */
  debugGroundAt(clientX, clientY, y) {
    this.#setRay({ clientX, clientY });
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(this.floorY + y));
    const hit = new THREE.Vector3();
    return this.ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
  }

  /** Show a model instance's new numbers at once (the draft reaches the server and comes back a moment later). */
  debugSetInstance(index, inst) {
    const g = this.instGroups.get(index);
    if (!g) return;
    if (index >= LIGHT0) { // a light: position, colour, strength and reach, at once
      const k = index - LIGHT0;
      this.lightList[k] = { ...inst, translate: [...inst.translate] };
      g.position.set(inst.translate[0], inst.translate[1] + this.floorY, inst.translate[2]);
      g.children[0]?.material?.color?.copy?.(rawColor(inst.color ?? '#ffd9a0'));
      this.#applyLights();
      return;
    }
    const deg = Math.PI / 180;
    g.scale.setScalar(inst.scale ?? 1);
    const r = inst.rotation ?? [0, 0, 0];
    g.rotation.set(r[0] * deg, r[1] * deg, r[2] * deg, 'YXZ');
    const t = inst.translate ?? [0, 0, 0];
    g.position.set(t[0], t[1] + this.floorY, t[2]);
  }

  /** Draw a box around background model `index` (null = none). */
  debugSelectInstance(index) {
    this.selIndex = index;
    this.#attachSelBox();
  }

  /** Make room for a studio panel `px` pixels wide at the left: the game is drawn in the rest. */
  debugDock(px, top = 0) { // px = width of the studio panel at the left, top = height of the studio bar across the top (the game is drawn in the rest)
    this.dock = px;
    this.top = top;
    this.root.style.setProperty('--bb-dock', `${px}px`);
    this.root.style.setProperty('--bb-top', `${top}px`);
    this.#resize();
  }

  /** A red wireframe of the drop zone of the current level. */
  debugShowDrop(on) {
    if (on && !this.dropHelper) {
      this.dropHelper = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#e11d48' }));
      this.scene.add(this.dropHelper);
    }
    if (this.dropHelper) this.dropHelper.visible = on;
    this.#applyDay(); // (the level may have its own time of day on the same background)
    this.#updateDropHelper();
  }

  #updateDropHelper() {
    if (!this.dropHelper) return;
    const d = this.currentLevel ? dropOf(this.currentLevel) : DROP;
    const y1 = Math.min(d.y1, 45);
    this.dropHelper.position.set((d.x0 + d.x1) / 2, (d.y0 + y1) / 2, 0);
    this.dropHelper.scale.set(Math.max(0.01, d.x1 - d.x0), Math.max(0.01, y1 - d.y0), DEPTH + 0.4);
  }

  #applyFreeCam() {
    const f = this.freeCam;
    const cp = Math.cos(f.pitch);
    this.camera.position.set(f.target.x + f.dist * cp * Math.sin(f.yaw), f.target.y + f.dist * Math.sin(f.pitch), f.target.z + f.dist * cp * Math.cos(f.yaw));
    this.camera.lookAt(f.target);
    this.camera.updateMatrixWorld(true);
  }

  // ── scene ──
  /** What never changes: renderer, camera, lights and the two scenes. The world (floor, table, bowl, water, models) is built per level by #buildWorld. */
  #buildScene() {
    this.scene = new THREE.Scene();
    this.frontScene = new THREE.Scene(); // blocks somebody is holding: drawn last, on top of everything, so the table never hides them
    this.camera = new THREE.PerspectiveCamera(tuning.camera.fov, 1, 1, 1200);
    this.camera.layers.enable(1); // layer 1 = the outlines of the blocks to come: seen by the player, but not by the shadow or reflection cameras

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = false;
    this.renderer.domElement.className = 'bb-canvas';

    this.scene.add(new THREE.AmbientLight('#ffffff', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-20, 40, 40);
    this.scene.add(sun);
  }

  /** Show the world of a level (null = the menu). Only rebuilt when the bowl or the background changed, or when `force` is set. */
  #setScene(level, force = false) {
    this.currentLevel = level;
    const sig = `${bowlKeyOf(level)}|${backgroundKeyOf(level)}`;
    if (force || sig !== this.sceneSig) {
      this.sceneSig = sig;
      this.#buildWorld(bowlOf(level), backgroundOf(level));
    }
    this.#updateDropHelper();
  }

  // ── lights ──
  /** The point lights of the background: their numbers go to the shaders, and (debug) every light gets a little ball you can pick and move. */
  #buildLights() {
    if (this.lightMarkers) {
      this.lightMarkers.removeFromParent();
      this.#disposeTree(this.lightMarkers);
    }
    const list = (this.bgFx.lights ?? []).slice(0, MAX_LIGHTS);
    this.lightList = list.map((l) => ({ ...l, translate: [...l.translate] }));
    const markers = (this.lightMarkers = new THREE.Group());
    markers.visible = this.markersOn;
    list.forEach((l, k) => {
      const ball = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), new THREE.MeshBasicMaterial({ color: rawColor(l.color ?? '#ffd9a0') }));
      mesh.userData.inst = LIGHT0 + k;
      ball.add(mesh);
      ball.userData.inst = LIGHT0 + k;
      ball.position.set(l.translate[0], l.translate[1] + this.floorY, l.translate[2]);
      markers.add(ball);
      this.instGroups.set(LIGHT0 + k, ball);
    });
    this.frontScene.add(markers);
    this.#applyLights();
  }

  #applyLights() {
    const u = this.shadowU;
    const list = this.lightList ?? [];
    list.forEach((l, k) => {
      const c = rawColor(l.color ?? '#ffd9a0');
      const f = Math.max(0, l.intensity ?? 1);
      u.uLPos.value[k].set(l.translate[0], l.translate[1] + this.floorY, l.translate[2]);
      u.uLCol.value[k].set(c.r * f, c.g * f, c.b * f);
      u.uLRange.value[k] = Math.max(0.1, l.range ?? 40);
    });
    u.uLN.value = list.length;
  }

  /** Debug: show (or hide) the little balls that mark the lights. */
  debugShowLights(on) {
    this.markersOn = !!on;
    if (this.lightMarkers) this.lightMarkers.visible = this.markersOn;
  }

  // ── time of day ──
  /** The hour that is shown: the level's own `time`, else the background's `light.time`, else noon. */
  #hourNow() {
    return this.currentLevel?.time ?? this.bgFx.light?.time ?? 12;
  }

  /** Sun or moon, its colour, the sky light, the mist: all worked out from the hour. 6 = sunrise, 12 = noon, 18 = sunset, 0 = midnight. */
  #applyDay() {
    const h = this.#hourNow();
    const sm = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const mixv = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
    const elev = Math.sin(((h - 6) / 12) * Math.PI); // sun height: 1 at noon, 0 at 6 and 18, below 0 at night
    const day = sm(-0.12, 0.22, elev);
    const dusk = Math.exp(-(elev * elev) / (2 * 0.2 * 0.2)); // 1 right at the horizon
    // direction: the background's `light.dir` is the noon light; over the day it sweeps from one side to the other and gets lower at the ends
    const base = this.bgFx.light?.dir ?? [-0.45, 0.85, 0.55];
    const sweep = -Math.sin(((h - 12) / 12) * Math.PI);
    const dayDir = new THREE.Vector3(base[0] + sweep * 0.9, base[1] * (0.35 + 0.65 * Math.max(elev, 0.05)), base[2]);
    const moonDir = new THREE.Vector3(base[0] * -0.8 + 0.2, base[1] * 0.7, base[2]);
    const dir = dayDir.normalize().lerp(moonDir.normalize(), 1 - day).normalize();
    const sunCol = mixv([1.0, 0.55, 0.28], [1.0, 0.95, 0.85], sm(0.0, 0.55, elev)).map((x) => x * 0.76);
    const moonCol = [0.2, 0.26, 0.48];
    const lightCol = mixv(moonCol, sunCol, day);
    const sky = mixv(mixv([0.1, 0.13, 0.26], [0.6, 0.63, 0.7], day), [0.55, 0.42, 0.42], dusk * 0.55 * day);
    const ground = mixv(mixv([0.05, 0.06, 0.1], [0.45, 0.41, 0.35], day), [0.42, 0.3, 0.24], dusk * 0.5 * day);
    const tint = mixv(mixv([0.1, 0.13, 0.25], [1, 1, 1], day), [1.0, 0.7, 0.58], dusk * 0.65 * day);
    const u = this.shadowU;
    u.uLightDir.value.copy(dir);
    u.uLightCol.value.set(...lightCol);
    u.uAmbSky.value.set(...sky);
    u.uAmbGround.value.set(...ground);
    for (const f of this.fogs) f.value.setRGB(f.base.r * tint[0], f.base.g * tint[1], f.base.b * tint[2]);
    const mist = this.bgFx.mist ? rawColor(this.bgFx.mist) : new THREE.Color('#e7e2d6');
    this.mistNow.setRGB(mist.r * tint[0], mist.g * tint[1], mist.b * tint[2]);
    if (this.scene?.background?.isColor) {
      this.scene.background.set(this.bgFx.mist ?? '#e7e2d6');
      this.scene.background.r *= tint[0];
      this.scene.background.g *= tint[1];
      this.scene.background.b *= tint[2];
    }
  }

  /** Floor, table, bowl, water and the models of the background. */
  #buildWorld(bowl, bg) {
    if (this.world) {
      this.world.removeFromParent();
      this.#disposeTree(this.world);
    }
    this.instGroups.clear();
    this.#dropSelBox();
    const token = ++this.worldToken;
    const world = (this.world = new THREE.Group());
    this.scene.add(world);
    this.bowlDef = bowl;
    this.groundY = groundYOf(bowl);
    const bowlH = bg.bowlHeight ?? TABLE.h; // how high the bowl (= the top of the table) stands above the floor
    const floorY = this.groundY - bowlH;
    this.floorY = floorY;
    this.scene.background = new THREE.Color(bg.mist);
    const fog = { uFogColor: { value: rawColor(bg.mist) }, uFog: { value: new THREE.Vector2(bg.fog?.[0] ?? 150, bg.fog?.[1] ?? 520) } };
    this.fogs = [{ value: fog.uFogColor.value, base: rawColor(bg.mist) }];

    // the world is two groups: the SCENERY (floor, models of the background: this is what the blur pass blurs) and the MAIN part (table, bowl, water)
    const scenery = (this.scenery = new THREE.Group());
    const main = (this.mainGroup = new THREE.Group());
    world.add(scenery, main);
    this.bgFx = { blur: bg.blur ?? 0, blurFar: bg.blurFar ?? 0, light: bg.light ?? null, mist: bg.mist };
    this.shadowU.uCaus.value = bowl.water?.caustics ?? 0.9;
    const inset = bowl.water?.causticsInset ?? 2; // caustics stay this far inside the walls
    this.shadowU.uBowlHalf.value.set(Math.max(1, bowl.a - inset), Math.max(1, bowl.a * bowl.zscale - inset));

    // the ground: raked sand or wooden planks. Ripples run around the table like around a rock, and the far end fades into mist.
    this.floorMesh = null;
    if (bg.ground?.style !== 'none') { // ('no floor': just the sky colour behind the table)
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), this.#floorMaterial(bg, fog));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = floorY;
      floor.userData.blurLevel = blurLevelOf(bg.ground?.blur);
      scenery.add(floor);
      this.floorMesh = floor;
    }

    // the table: a 3D wooden rectangle (or a model). The bowl stands on it at the back, the waiting blocks lie on it at the front.
    if (bg.table?.model && models[bg.table.model]) {
      this.#addModel(main, bg.table, token, floorY, fog, TABLE_INDEX); // a model instead of the plain box
    } else {
      const th = Math.max(bowlH, 0.05);
      const table = new THREE.Mesh(new THREE.BoxGeometry(bg.box.w, th, bg.box.d), this.#blockMaterial(bg.box.shader, 0.7));
      table.position.set(0, this.groundY - th / 2, bg.box.z);
      main.add(table);
    }

    // the bowl: the profile turned around the vertical axis (flat bottom, rounded corners), or a model if the bowl has one
    const [wood, water] = this.#bowlMeshes(bowl);
    if (bowl.model) {
      wood.geometry.dispose();
      wood.material.dispose();
      this.#addModel(main, bowl.model, token, 0, null);
    } else {
      main.add(wood);
    }
    main.add(water);
    this.water = water;

    // the scenery
    bg.models.forEach((inst, i) => this.#addModel(scenery, inst, token, floorY, fog, i));
    this.bgFx.lights = bg.lights ?? [];
    this.#buildLights();
    this.#applyDay();
    this.#fitCamera();
  }

  /** The two meshes of a generated bowl: the wood (turned profile, outer wall up and inner wall down) and the water inside it. */
  #bowlMeshes(bowl, plain = false) {
    const { inner, outer } = bowlProfile(BOWL_SEGS, bowl);
    const half = (pts) => pts.slice(BOWL_SEGS / 2).map(([x, y]) => new THREE.Vector2(Math.abs(x), y)); // from the middle of the flat bottom up to the rim
    const profile = [...half(outer), ...half(inner).reverse()]; // the normals come out facing away from the wood
    const wood = new THREE.Mesh(this.#squareLathe(profile, bowl), this.#blockMaterial(bowl.shader, 0.35, THREE.DoubleSide, null, plain));
    wood.material.uniforms.uCausInward.value = 1;

    // the water: the inside of the bowl up to WATER_Y (a lathe for the sides and the bottom) and a finely meshed GRID for the surface,
    // which the vertex shader lifts into waves
    const wall = half(inner);
    const wp = [];
    for (let i = 0; i < wall.length; i++) {
      const p = wall[i];
      if (p.y <= WATER_Y) {
        wp.push(new THREE.Vector2(p.x * 0.996, p.y + 0.02));
      } else {
        const q = wall[i - 1];
        const t = (WATER_Y - q.y) / (p.y - q.y);
        wp.push(new THREE.Vector2((q.x + (p.x - q.x) * t) * 0.996, WATER_Y));
        break;
      }
    }
    const rw = wp[wp.length - 1].x; // half the width of the water surface
    const rz = rw * bowl.zscale;
    const yBot = bowl.rimY - bowl.b - bowl.t;
    const f = THREE.MathUtils.clamp((WATER_Y - yBot) / (bowl.rimY - yBot), 0, 1);
    const sq = Math.max(2, bowl.squareBottom + (bowl.square - bowl.squareBottom) * f * f * (3 - 2 * f)); // the outline is a superellipse |x/rw|^n + |z/rz|^n = 1
    const foot = { rw, rz, n: sq };
    const water = new THREE.Group();
    const sides = new THREE.Mesh(this.#squareLathe(wp, bowl), this.#waterMaterial(bowl, plain, null));
    const gridGeo = new THREE.PlaneGeometry(rw * 2.02, rz * 2.02, 150, 60);
    gridGeo.rotateX(-Math.PI / 2);
    const surface = new THREE.Mesh(gridGeo, this.#waterMaterial(bowl, plain, foot));
    surface.position.y = WATER_Y;
    sides.renderOrder = 5;
    surface.renderOrder = 5;
    surface.frustumCulled = false; // (the waves move it a little)
    water.add(sides, surface);
    return [wood, water];
  }

  /**
   * Water: see-through blue. The surface is a grid: the vertex shader lifts every point with a few crossing sine waves plus a slow value-noise swell
   * (`waveH`), the fragment shader works the slope out of the same function. The slope bends the reflection (the texture of #reflectPass), makes
   * the sun glitter, and the colour follows the light of the day. `foot` (the outline of the surface) is null for the sides of the water.
   */
  #waterMaterial(bowl, plain = false, foot = null) {
    const u = plain ? { uRefl: { value: null }, uReflMat: { value: new THREE.Matrix4() }, uReflStr: { value: 0 }, ...this.#plainLight() } : { ...this.waterU, ...this.shadowU };
    const WAVES = /* glsl */ `
float whash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float wnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(whash(i), whash(i + vec2(1.0, 0.0)), f.x), mix(whash(i + vec2(0.0, 1.0)), whash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float waveH(vec2 p, float t) {
  float h = 0.0;
  h += 0.10 * sin(dot(p, vec2(0.95, 0.31)) * 0.55 + t * 1.0);
  h += 0.05 * sin(dot(p, vec2(-0.37, 0.93)) * 0.90 + t * 1.3);
  h += 0.02 * sin(dot(p, vec2(0.71, 0.71)) * 1.70 + t * 1.9);
  h += (wnoise(p * 0.35 + vec2(t * 0.15, -t * 0.10)) - 0.5) * 0.20;
  h += (wnoise(p * 0.95 - vec2(t * 0.25, t * 0.20)) - 0.5) * 0.06;
  return h;
}`;
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: rawColor(bowl.water.color) }, uOpacity: { value: bowl.water.opacity }, uTime: this.uTime, ...u,
        uGrid: { value: foot ? 1 : 0 },
        uFoot: { value: new THREE.Vector3(foot?.rw ?? 1, foot?.rz ?? 1, foot?.n ?? 2) },
      },
      vertexShader: /* glsl */ `
varying vec3 vW;
varying vec3 vWN;
uniform float uTime;
uniform float uGrid;
${WAVES}
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  if (uGrid > 0.5) w.y += waveH(w.xz, uTime);
  vW = w.xyz;
  vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
      fragmentShader: /* glsl */ `
precision highp float;
varying vec3 vW;
varying vec3 vWN;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uGrid;
uniform vec3 uFoot;
uniform sampler2D uRefl;
uniform mat4 uReflMat;
uniform float uReflStr;
uniform vec3 uLightDir;
uniform vec3 uLightCol;
uniform vec3 uAmbSky;
${WAVES}
void main() {
  float top = 0.0;
  vec3 N = normalize(vWN);
  if (uGrid > 0.5) {
    vec2 m = abs(vW.xz) / uFoot.xy;
    if (pow(pow(m.x, uFoot.z) + pow(m.y, uFoot.z), 1.0 / uFoot.z) > 1.0) discard; // outside the bowl
    float h0 = waveH(vW.xz, uTime);
    float hx = waveH(vW.xz + vec2(0.12, 0.0), uTime);
    float hz = waveH(vW.xz + vec2(0.0, 0.12), uTime);
    N = normalize(vec3(-(hx - h0) / 0.12, 1.0, -(hz - h0) / 0.12));
    top = 1.0;
  }
  vec3 V = normalize(cameraPosition - vW);
  vec3 col = uColor * ((uAmbSky * 0.7 + uLightCol * 0.35) * 1.28); // the colour of the water follows the light of the day
  float alpha = uOpacity;
  float fres = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 3.0);
  if (uReflStr > 0.0 && top > 0.0) {
    vec4 pr = uReflMat * vec4(vW, 1.0);
    vec2 uv = pr.xy / pr.w + N.xz * 0.12; // the waves bend the mirror image
    vec3 refl = texture2D(uRefl, clamp(uv, 0.001, 0.999)).rgb;
    float k = clamp(uReflStr * (0.3 + 0.7 * fres), 0.0, 1.0) * top;
    col = mix(col, refl, k);
    alpha = mix(alpha, 1.0, k * 0.85);
  }
  float glint = pow(max(dot(N, normalize(uLightDir + V)), 0.0), 140.0) * top; // sun (or moon) glitter on the ripples
  col += uLightCol * (glint * 1.6);
  col *= 0.94 + 0.12 * N.x * top; // a little shading across the waves
  alpha = clamp(alpha + glint * 0.6 + fres * 0.12 * top, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  #floorMaterial(bg, fog) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMist: fog.uFogColor,
        uFogRange: fog.uFog,
        uA: { value: rawColor(bg.ground.colorA) },
        uB: { value: rawColor(bg.ground.colorB) },
        uRipple: { value: bg.ground.ripple },
        uHalf: { value: new THREE.Vector2((bg.box?.w ?? TABLE.w) / 2, (bg.box?.d ?? TABLE.d) / 2) },
        uC: { value: new THREE.Vector2(0, bg.box?.z ?? TABLE.z) },
        uStyle: { value: bg.ground.style === 'wood' ? 1 : 0 },
        ...this.shadowU,
      },
      vertexShader: /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
      fragmentShader: /* glsl */ `
precision highp float;
varying vec3 vW;
uniform vec3 uMist;
uniform vec2 uFogRange;
uniform vec3 uA;
uniform vec3 uB;
uniform float uRipple;
uniform vec2 uHalf;
uniform vec2 uC;
uniform float uStyle;
${SHADOW_GLSL}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 d = abs(vW.xz - uC) - uHalf;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); // distance to the table's edge
  float dc = length(vW - cameraPosition);
  float wob = noise(vW.xz * 0.05) * 3.0 + noise(vW.xz * 0.3) * 0.35;
  float rake = 0.5 + 0.5 * sin((dist + wob) * uRipple);
  rake = mix(0.5, rake, 1.0 - smoothstep(70.0, 220.0, dc)); // far away the lines would shimmer: let them melt into plain sand
  vec3 sand = mix(uA, uB, rake);
  sand *= 0.97 + 0.06 * noise(vW.xz * 2.5);
  if (uStyle > 0.5) { // wooden planks: rows 6 units wide, boards 36 long, every row shifted
    float row = floor(vW.z / 6.0);
    float off = hash(vec2(row, 1.0)) * 40.0;
    float col = floor((vW.x + off) / 36.0);
    vec3 base = mix(uA, uB, hash(vec2(row, col)));
    base *= 0.88 + 0.22 * noise(vec2((vW.x + off) * 0.25, vW.z * 3.0));
    float fy = fract(vW.z / 6.0);
    float fx = fract((vW.x + off) / 36.0);
    float seam = min(min(fy, 1.0 - fy) * 6.0, min(fx, 1.0 - fx) * 36.0);
    sand = base * (0.6 + 0.4 * smoothstep(0.0, 0.25, seam));
  }
  sand *= 0.7 + 0.3 * smoothstep(0.0, 10.0, dist); // the table's soft shadow
  sand *= sceneLight(vW, vec3(0.0, 1.0, 0.0)) * 0.86;
  gl_FragColor = vec4(mix(sand, uMist, smoothstep(uFogRange.x * 0.9, uFogRange.y, dc)), 1.0);
}`,
    });
  }

  // ── models (.obj files, only used for backgrounds and bowls) ──
  /** The parsed .obj file (fetched once). */
  #objFile(file) {
    let p = this.objCache.get(file);
    if (!p) {
      p = fetch(new URL(`./models/${file}`, import.meta.url))
        .then((r) => {
          if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
          return r.text();
        })
        .then(parseObj);
      p.catch(() => this.objCache.delete(file)); // a failed download is tried again next time
      this.objCache.set(file, p);
    }
    return p;
  }

  /** One geometry per part of a model, shared by every place the model is used. */
  async #modelParts(def) {
    const key = `${def.file}|${def.smooth ? 's' : 'f'}`;
    const obj = await this.#objFile(def.file);
    let g = this.modelGeo.get(key);
    if (!g) {
      g = obj.parts.map((p) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(p.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(def.smooth && p.normals ? p.normals : flatNormals(p.positions), 3));
        geo.userData.shared = true;
        return { name: p.name, geo };
      });
      this.modelGeo.set(key, g);
    }
    return g;
  }

  /** Place a model instance `{ model, scale, rotation: [x,y,z] degrees, translate: [x,y,z] }` into `parent` (when its file has arrived). */
  async #addModel(parent, inst, token, yOffset, fog, index) {
    const def = models[inst.model];
    if (!def) return;
    let parts;
    try {
      parts = await this.#modelParts(def);
    } catch (e) {
      console.warn(`balance: model "${inst.model}" could not be loaded`, e);
      return;
    }
    if (token !== this.worldToken) return; // the world was rebuilt while the file was loading
    const group = new THREE.Group();
    parts.forEach((p, i) => {
      const shader = def.shaders?.[p.name] ?? def.shader ?? 'stone1';
      const mat = this.#blockMaterial(shader, (i * 0.37) % 1, THREE.DoubleSide, fog);
      if (fog === null && index === undefined) mat.uniforms.uCausInward.value = 1; // (a model bowl)
      group.add(new THREE.Mesh(p.geo, mat));
    });
    group.userData.blurLevel = blurLevelOf(inst.blur); // 0 sharp, 1 light blur, 2 heavy blur (see #blurPass)
    group.scale.setScalar(inst.scale ?? 1);
    const deg = Math.PI / 180;
    const r = inst.rotation ?? [0, 0, 0];
    group.rotation.set(r[0] * deg, r[1] * deg, r[2] * deg, 'YXZ');
    const t = inst.translate ?? [0, 0, 0];
    group.position.set(t[0], t[1] + yOffset, t[2]);
    parent.add(group);
    if (index !== undefined) { // a model of the background (not the bowl): the background studio can find it again
      group.userData.inst = index;
      group.traverse((o) => { o.userData.inst = index; });
      this.instGroups.set(index, group);
      if (index === this.selIndex) this.#attachSelBox();
    }
  }

  #dropSelBox() {
    if (!this.selBox) return;
    this.selBox.removeFromParent();
    this.selBox.geometry.dispose();
    this.selBox.material.dispose();
    this.selBox = null;
  }

  #attachSelBox() {
    this.#dropSelBox();
    const g = this.instGroups.get(this.selIndex);
    if (!g) return;
    this.selBox = new THREE.BoxHelper(g, '#f43f5e');
    this.scene.add(this.selBox);
  }

  #clearModelGeo() {
    for (const parts of this.modelGeo.values()) parts.forEach((p) => p.geo.dispose());
    this.modelGeo.clear();
  }

  #disposeTree(root) {
    root.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
    });
  }

  /**
   * Revolve a (radius, y) profile around the vertical axis. The plan shape goes from `squareBottom` at the bottom to `square` at the rim
   * (a superellipse: 2 = circle, higher = squarer). The slice at z = 0 is always exactly the profile, so it still matches the physics.
   */
  #squareLathe(profile, bowl, segs = 128) {
    const yBot = bowl.rimY - bowl.b - bowl.t;
    const pos = [];
    for (const { x: r, y } of profile) {
      const f = THREE.MathUtils.clamp((y - yBot) / (bowl.rimY - yBot), 0, 1);
      const n = Math.max(2, bowl.squareBottom + (bowl.square - bowl.squareBottom) * f * f * (3 - 2 * f));
      const e = 2 / n;
      for (let j = 0; j < segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        const c = Math.cos(th);
        const s = Math.sin(th);
        pos.push(r * Math.sign(c) * Math.abs(c) ** e, y, r * bowl.zscale * Math.sign(s) * Math.abs(s) ** e);
      }
    }
    const idx = [];
    for (let i = 0; i < profile.length - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * segs + j;
        const b = i * segs + ((j + 1) % segs);
        idx.push(a, a + segs, b, b, a + segs, b + segs);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** The light uniforms for the little preview windows (other WebGL contexts: no shared textures, a fixed daylight). */
  #plainLight() {
    const v = (x) => ({ value: x });
    return {
      uShadowMap: v(this.whiteTex), uShadowMat: v(new THREE.Matrix4()), uShadowStr: v(0), uShadowTexel: v(new THREE.Vector2(1, 1)), uShadowRange: v(190), uShadowDepth: v(280), uShadowR: v(new THREE.Vector3(1, 0, 0)), uShadowU: v(new THREE.Vector3(0, 1, 0)), uShadowBias: v(0.12), uShadowNormal: v(1.5), uShadowK: v(1),
      uLightDir: v(new THREE.Vector3(-0.35, 0.8, 0.5).normalize()), uLightCol: v(new THREE.Vector3(0.72, 0.7, 0.64)),
      uAmbSky: v(new THREE.Vector3(0.6, 0.63, 0.68)), uAmbGround: v(new THREE.Vector3(0.45, 0.41, 0.35)),
      uWaterY: v(WATER_Y), uCaus: v(0), uBowlHalf: v(new THREE.Vector2(20, 12)),
      uLPos: v(Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3())), uLCol: v(Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3())), uLRange: v(new Array(MAX_LIGHTS).fill(1)), uLN: v(0),
    };
  }

  /** One ShaderMaterial per block; the time uniform is shared by all of them. */
  #blockMaterial(shaderName, seed, side = THREE.FrontSide, fog = null, plain = false) {
    const transparent = transparentShaders.has(shaderName);
    return new THREE.ShaderMaterial({
      vertexShader: deformShaders.has(shaderName) ? waveVertexShader : vertexShader,
      fragmentShader: shaders[shaderName] ?? shaders.stone1,
      uniforms: {
        uTime: this.uTime,
        uSeed: { value: seed },
        uGlow: { value: new THREE.Vector3() },
        uBad: { value: 0 },
        uCausOn: { value: 1 },
        uCausInward: { value: 0 }, // 1 = only the inside of this surface gets caustics (the bowl)
        uReveal: { value: 1 }, //     below 1 the block dissolves in (see finish() in shaders.js)
        uWaterColor: { value: rawColor(this.bowlDef?.water?.color ?? '#004585') }, // (the water block looks like the water of the bowl)
        uWaterOpacity: { value: this.bowlDef?.water?.opacity ?? 0.55 },
        uFogColor: fog?.uFogColor ?? { value: new THREE.Color(0, 0, 0) },
        uFog: fog?.uFog ?? { value: new THREE.Vector2(1e6, 2e6) }, // blocks never fade; background models do
        ...(plain ? { ...this.#plainLight(), uRefr: { value: null }, uRefrOn: { value: 0 }, uRefrRes: { value: new THREE.Vector2(1, 1) } } : { ...this.shadowU, ...this.refrU }), // (the little preview windows are other WebGL contexts: no shared textures)
      },
      transparent,
      depthWrite: !transparent,
      side,
    });
  }

  /**
   * Chamfered geometry for each part of a shape (or for its single visual outline, see plus1). Every block has the same depth.
   * `fine` = every triangle cut into 9 (for blocks whose vertex shader moves the surface, like the water block).
   */
  #geometries(key, fine = false) {
    const ck = fine ? `${key}:fine` : key;
    let g = this.geoCache.get(ck);
    if (g) return g;
    const shape = getShape(key);
    g = shapeOutlines(shape, tuning.mergeParts !== false).map((o) => {
      const geo = chamferedPrism(o.pts, DEPTH, tuning.chamfer, o.holes);
      if (!fine) return { geo };
      const out = subdivide3(geo);
      addEdgeDistance(out, [o.pts, ...(o.holes ?? [])]);
      return { geo: out };
    });
    this.geoCache.set(ck, g);
    return g;
  }

  /**
   * The blocks that have not appeared on the table yet: the next PREVIEW_COUNT of them are drawn as a chalk outline (the 'outline' shader) on the table,
   * in the places after the waiting blocks. Only the SHAPE is known (the server does not tell the material). The places never move:
   *  - when a block is used, the next block appears where ITS outline is: the outline fades away while the real block dissolves in out of it (see
   *    #applySnapshot). The place that was just freed stays empty, or gets the outline of the block that now comes into view (it fades in);
   *  - nothing that is on the table moves at all.
   * `s.nx` = [[id, shape, place], ...] in the order they will come (each on its own place of the row), `s.w` = places in the row.
   */
  #syncGhosts(s) {
    const first = this.ghostFirst;
    this.ghostFirst = false;
    const want = (s.nx ?? []).filter(([, si]) => SHAPE_KEYS[si] !== undefined);
    const w = s.w ?? s.n;
    const here = new Set(s.tbl.map((r) => r[0])); // (also the ones that are being held)
    for (const g of this.ghosts) {
      if (g.out) continue;
      if (here.has(g.id) || !want.some(([id]) => id === g.id)) { // it became a block (or the level changed under it): it fades away
        g.out = true;
        g.t = 0;
      }
    }
    for (const [id, si, spot] of want) {
      if (this.ghosts.some((g) => g.id === id) || !(spot >= 0)) continue;
      const shapeKey = SHAPE_KEYS[si];
      const shape = getShape(shapeKey);
      const mat = this.#blockMaterial('outline', (id * 0.37 + 0.1) % 1, THREE.DoubleSide);
      Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); // (on top of the table, never flickering with it)
      const group = new THREE.Group();
      const geos = [];
      const line = Math.min(0.35, Math.max(0.1, Math.min(shape.w, shape.h) * 0.08)); // width of the chalk line (a very small shape gets a thinner one)
      // the outline of the shape as the block has it (all parts merged, holes included), just outside the block
      for (const o of shapeOutlines(shape, tuning.mergeParts !== false)) {
        const geo = outlineRibbon(o.pts, o.holes ?? [], line);
        geos.push(geo);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.layers.set(1);
        mesh.renderOrder = 2;
        group.add(mesh);
      }
      const p = slotPos(spot, w, shapeKey, this.groundY);
      group.position.set(p.x, this.groundY + 0.05, FRONT_Z); // on the surface of the table, exactly where a block of this shape would lie
      group.rotation.x = -Math.PI / 2; //                      (flat, the same way up as a waiting block)
      const reuse = this.ghosts.some((g) => g.out && g.spot === spot); // the place was only just freed: wait until the old outline has gone
      const g = { id, spot, group, geos, mat, t: first ? GHOST_IN : reuse ? -GHOST_OUT : 0, out: false };
      mat.uniforms.uReveal.value = first ? 1 : 0;
      group.visible = first;
      this.scene.add(group);
      this.ghosts.push(g);
    }
  }

  /** Fade the outlines in and out (every frame). */
  #animateGhosts(dt) {
    for (const g of this.ghosts) {
      g.t += dt;
      const reveal = g.out ? 1 - Math.min(1, g.t / GHOST_OUT) : smooth(g.t / GHOST_IN);
      g.mat.uniforms.uReveal.value = reveal;
      g.group.visible = reveal > 0.001;
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      if (!g.out || g.t < GHOST_OUT) continue;
      this.#disposeGhost(g);
      this.ghosts.splice(i, 1);
    }
  }

  #disposeGhost(g) {
    g.group.removeFromParent();
    g.geos.forEach((geo) => geo.dispose());
    g.mat.dispose();
  }

  #clearGhosts() {
    for (const g of this.ghosts) this.#disposeGhost(g);
    this.ghosts = [];
    this.ghostFirst = true;
  }

  /** @param {Map} map  @param opts `{table, slot, n}` for a block on the table, `{x, y, a, st, owner}` for one in the play area */
  #makeView(map, id, si, mi, opts) {
    const shapeKey = SHAPE_KEYS[si];
    const shaderName = materials[MATERIAL_KEYS[mi]].shader;
    const mat = this.#blockMaterial(shaderName, (id * 0.6180339) % 1);

    if (opts.table) mat.uniforms.uCausOn.value = 0; // (waiting on the table: no caustics)
    const group = new THREE.Group();
    for (const { geo } of this.#geometries(shapeKey, deformShaders.has(shaderName))) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.id = id;
      if (transparentShaders.has(shaderName)) mesh.renderOrder = 3;
      if (refractShaders.has(shaderName)) mesh.layers.set(2); // layer 2 = glass: drawn in a pass of its own, after a copy of the picture has been made (#renderAll)
      group.add(mesh);
    }
    this.scene.add(group);

    // blocks with a stack limit (glass) carry a lamp: green = nothing on it, orange = something, red = at the limit (one more breaks it)
    const limit = materials[MATERIAL_KEYS[mi]].stackLimit;
    let dot = null;
    if (limit !== undefined && !materials[MATERIAL_KEYS[mi]].noLamp) {
      const sh = getShape(shapeKey);
      const r = THREE.MathUtils.clamp(Math.min(sh.w, sh.h) * 0.16, 0.3, 1.1);
      dot = new THREE.Mesh(this.dotGeo, new THREE.MeshBasicMaterial({ color: LAMP[0] }));
      dot.scale.set(r, r, 1);
      dot.position.set(0, lookSameWhenTurned(sh) ? 0 : sh.h / 2 - r - 0.55, DEPTH / 2 + 0.04); // (a block that looks the same turned round has it in the middle: it does not move when you turn the block)
      dot.userData.id = id;
      group.add(dot);
    }

    const v = {
      glass: refractShaders.has(shaderName),
      dot, limit, load: -1, // (limit also marks a block that shatters, with or without a lamp)
      id, group, mats: [mat], marker: null, size: getShape(shapeKey), shapeKey,
      table: !!opts.table, slot: opts.slot ?? 0, n: opts.n ?? 4,
      tx: opts.x ?? 0, ty: opts.y ?? 0, ta: opts.a ?? 0, st: opts.st ?? BODY.NORMAL, owner: opts.owner ?? -1,
      static: opts.st === BODY.STATIC,
      cur: null,
    };
    v.cur = this.poseMem.get(id) ?? this.#target(v); // a block that was picked up / put back moves on from where it was
    this.poseMem.delete(id);
    map.set(id, v);
    return v;
  }

  /** Colour of the lamp of a fragile block for the number of blocks resting on it. */
  #setLoad(v, load) {
    if (!v.dot || v.load === load) return;
    v.load = load;
    v.dot.material.color.set(LAMP[Math.min(LAMP.length - 1, load <= 0 ? 0 : load >= v.limit ? 2 : 1)]);
  }

  /** A block broke: a handful of glass shards fly off and fall. */
  #shatter(v) {
    const p = v.group.position;
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(this.shardGeo, new THREE.MeshBasicMaterial({ color: '#bfe6f2', transparent: true, opacity: 0.8 }));
      const size = 0.35 + Math.random() * 0.7;
      mesh.scale.set(size, size * (0.4 + Math.random() * 0.8), size * 0.4);
      mesh.position.set(p.x + (Math.random() - 0.5) * v.size.w, p.y + (Math.random() - 0.5) * v.size.h, p.z);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.scene.add(mesh);
      this.shards.push({ mesh, vx: (Math.random() - 0.5) * 14, vy: 3 + Math.random() * 9, vz: (Math.random() - 0.2) * 8, spin: (Math.random() - 0.5) * 12, life: 1.4 });
    }
  }

  #clearShards() {
    for (const sh of this.shards) {
      sh.mesh.removeFromParent();
      sh.mesh.material.dispose();
    }
    this.shards = [];
  }

  #remove(map, id, v) {
    this.poseMem.set(id, { ...v.cur });
    this.#dispose(v);
    map.delete(id);
  }

  #dispose(v) {
    v.group.removeFromParent();
    v.mats.forEach((m) => m.dispose());
    v.dot?.material.dispose();
    this.#dropMarker(v);
  }

  /** Another player's held block carries a small dot in their seat colour, so you can tell who holds what (the block itself is never tinted). */
  #dropMarker(v) {
    if (!v.marker) return;
    v.marker.removeFromParent();
    v.marker.material.dispose();
    v.marker = null;
  }

  #clearViews() {
    this.#clearShards();
    this.#clearGhosts();
    for (const v of this.bodyViews.values()) this.#dispose(v);
    for (const v of this.tableViews.values()) this.#dispose(v);
    this.bodyViews.clear();
    this.tableViews.clear();
    this.poseMem.clear();
  }

  #onPhase(ph, s) {
    this.phase = ph;
    if (ph !== PHASE.PLAY) this.mode = 'none';
    if (ph === PHASE.WON && !this.spectator && s.lv >= 0 && !this.sandbox) { // (a win in the local game is a test, not progress)
      this.done.add(s.lv);
      saveDone(this.done);
      this.#markDone();
    }
    this.menu.classList.toggle('bb-show', ph === PHASE.MENU);
    this.result.classList.toggle('bb-show', ph === PHASE.WON || ph === PHASE.LOST);
    this.result.classList.toggle('bb-won', ph === PHASE.WON);
    if (ph === PHASE.WON || ph === PHASE.LOST) this.#fillResult(ph, s);
  }

  // ── where things are drawn ──
  /**
   * Picking a block up does NOT move it. It stays where it is, lying on the table, and follows the pointer with the offset it was grabbed at.
   * Lifting it (the pointer going up) stands it up, and once it is on its way into the play area it moves back in z, until, where dropping is
   * allowed, it is exactly where it lands when you let go (upright, in the play plane, under the pointer).
   * `lift` runs from 0 (picked up) to 1 (the pointer is as high as the drop zone starts), and follows the pointer both ways: bringing the pointer
   * down again plays all of it in reverse (the block comes forward again, lies down and gets its grab offset back).
   */
  #liftOf(y, fromY) {
    const full = (this.currentLevel ? dropOf(this.currentLevel) : DROP).y0;
    return THREE.MathUtils.clamp((y - fromY) / Math.max(1, full - fromY), 0, 1);
  }

  /** Where a block lying on the table is seen in the play plane (height). */
  #tableLift() {
    const camY = this.camera.position;
    const kk = camY.z / (camY.z - FRONT_Z);
    return camY.y + (this.groundY + DEPTH / 2 - camY.y) * kk;
  }

  /** The block we hold: where it is (from the pointer and the grab offset). The offset is gone by the time the block is back in the play plane. */
  #follow() {
    if (!this.ptr) return;
    this.prog = this.#liftOf(this.ptr.y, this.pickY);
    const keep = 1 - backOf(this.prog);
    this.local.x = this.ptr.x + this.grab.x * keep;
    this.local.y = this.ptr.y + this.grab.y * keep;
  }

  #target(v) {
    if (v.table) {
      const p = slotPos(v.slot, v.n, v.shapeKey, this.groundY);
      return { x: p.x, y: this.groundY + DEPTH / 2, z: FRONT_Z, s: 1, a: 0, tl: 0 };
    }
    if (v.st === BODY.HELD || v.st === BODY.HELD_BAD) {
      const mine = v.owner === this.ctx.me.slot && this.#carrying();
      const [x, y, a] = mine ? [this.local.x, this.local.y, (this.local.rot * Math.PI) / 180] : [v.tx, v.ty, v.ta];
      let prog = this.prog;
      if (!mine) prog = this.#liftOf(y, this.#tableLift()); // somebody else's block: how far it has come follows from its height
      const tl = smooth(prog / TILT_UNTIL); //                   1 = standing up
      const z = FRONT_Z + (HOVER_Z - FRONT_Z) * backOf(prog); //  from the table back to the play plane
      // (x, y) is a point of the play plane: the block is drawn on the line of sight to it, at depth z, so it always looks to be under the pointer
      const c = this.camera.position;
      const t = (c.z - z) / c.z;
      const phi = (tl * Math.PI) / 2;
      const tall = (Math.abs(Math.sin(a)) * v.size.w + Math.abs(Math.cos(a)) * v.size.h) / 2; // half the height of the block when it stands
      const rest = this.groundY + (DEPTH / 2) * Math.cos(phi) + tall * Math.sin(phi); //          lowest centre that keeps it out of the table while it turns up
      return { x: c.x + (x - c.x) * t, y: Math.max(c.y + (y - c.y) * t, rest), z, s: 1, a, tl };
    }
    return { x: v.tx, y: v.ty, z: PLAY_Z, s: 1, a: v.ta, tl: 1 };
  }

  // ── UI (DOM) ──  (nobody is in charge: every player may press every button)
  #buildUi() {
    const send = (d) => !this.spectator && this.ctx.sendInput(d);

    // level menu
    this.cardsEl = el('div', { class: 'bb-cards' });
    this.menuSub = el('p', { class: 'bb-menu-sub' });
    this.worldsEl = el('div', { class: 'bb-worlds' }); // navigation at the top of the level menu: one button per world
    this.menu = el('div', { class: 'bb-menu' }, el('div', { class: 'bb-menu-inner' }, el('h1', { class: 'bb-menu-title' }, meta.name), this.menuSub, this.worldsEl, this.cardsEl));
    this.#buildCards();

    // in-game HUD
    this.titleEl = el('div', { class: 'bb-title' });
    this.legend = el('div', { class: 'bb-legend' });
    this.leftEl = el('div', { class: 'bb-left' });
    // the countdown after the last block: a white pill in the middle of the screen, a green dot appears at every third of it
    this.dots = [0, 1, 2].map(() => el('span', { class: 'bb-dot3' }));
    this.cdEl = el('div', { class: 'bb-count' }, el('div', { class: 'bb-pill' }, ...this.dots));
    this.restartBtn = el('button', { class: 'bb-btn', onclick: () => send({ restart: true }) }, 'Restart');
    this.levelsBtn = el('button', { class: 'bb-btn', onclick: () => send({ menu: true }) }, 'Levels');
    this.camBtn = el('button', { class: 'bb-btn', title: 'Back to the normal view (C)', onclick: () => this.#resetCamera() }, 'Reset camera');
    this.#applyDay();
    this.hintEl = el('div', { class: 'bb-hint' });
    this.hud = el(
      'div',
      { class: 'bb-hud' },
      el(
        'div',
        { class: 'bb-hud-top' },
        el('div', { class: 'bb-hud-left' }, this.titleEl, this.legend),
        el('div', { class: 'bb-hud-mid' }, this.leftEl),
        el('div', { class: 'bb-hud-btns' }, this.camBtn, ...(this.spectator ? [] : [this.restartBtn, this.levelsBtn])),
      ),
      this.hintEl,
    );

    // win / lose panel
    this.resultTitle = el('h2', { class: 'bb-result-title' });
    this.resultText = el('p', { class: 'bb-result-text' });
    this.resultBtns = el('div', { class: 'bb-result-btns' });
    this.result = el('div', { class: 'bb-result' }, el('div', { class: 'bb-result-box' }, this.resultTitle, this.resultText, this.resultBtns));
  }

  /** The world navigation and one card per level of the chosen world. Built again when the levels change (debug menu). */
  #buildCards() {
    const keys = Object.keys(worlds);
    if (!keys.includes(this.worldKey)) this.worldKey = keys[0];
    const inWorld = (k) => levels.map((lv, i) => [lv, i]).filter(([lv]) => worldKeyOf(lv) === k);
    this.worldBtns = keys.map((k) => el('button', {
      class: `bb-world${k === this.worldKey ? ' bb-on' : ''}${inWorld(k).length && inWorld(k).every(([, i]) => this.done.has(i)) ? ' bb-complete' : ''}`,
      onclick: () => { this.worldKey = k; this.#buildCards(); },
    }, worlds[k].name));
    this.worldsEl.replaceChildren(...this.worldBtns);
    this.worldsEl.classList.toggle('bb-hide', keys.length < 2);
    const own = inWorld(this.worldKey);
    this.cards = own.map(([lv, i], n) =>
      el(
        'button',
        { class: `bb-card bb-d-${lv.difficulty}`, 'data-lv': String(i), disabled: this.spectator, onclick: () => !this.spectator && this.ctx.sendInput({ start: i }) },
        el('span', { class: 'bb-num' }, String(n + 1)),
        el('span', { class: 'bb-card-name' }, lv.name),
        el('span', { class: 'bb-card-meta' }, `${lv.difficulty} · ${lv.shapes.length} blocks`),
        el('span', { class: 'bb-done', title: 'Completed' }, '✓'),
      ));
    this.cardsEl.replaceChildren(...(this.cards.length ? this.cards : [el('p', { class: 'bb-empty' }, 'No levels in this world yet.')]));
    this.#markDone();
  }

  #markDone() {
    this.cards.forEach((c) => c.classList.toggle('bb-complete', this.done.has(+c.dataset.lv)));
    Object.keys(worlds).forEach((k, n) => {
      const own = levels.map((lv, i) => [lv, i]).filter(([lv]) => worldKeyOf(lv) === k);
      this.worldBtns[n]?.classList.toggle('bb-complete', own.length > 0 && own.every(([, i]) => this.done.has(i)));
    });
  }

  /** Built once when the level ends (never on every snapshot: replacing a button under the pointer swallows the click). */
  #fillResult(ph, s) {
    const btn = (label, d, primary) => el('button', { class: `bb-btn${primary ? ' bb-primary' : ''}`, disabled: this.spectator, onclick: () => this.ctx.sendInput(d) }, label);
    if (ph === PHASE.WON) {
      this.resultTitle.textContent = 'Level cleared';
      this.resultText.textContent = '';
      this.resultBtns.replaceChildren(); // the server takes everybody back to the levels by itself
    } else {
      this.resultTitle.textContent = 'Level lost';
      this.resultText.textContent = LOSE_TEXT[s.why] ?? '';
      this.resultBtns.replaceChildren(btn('Try again', { restart: true }, true), btn('Levels', { menu: true }));
    }
  }

  #updateHud(s) {
    const solo = this.players.length <= 1;
    this.menuSub.textContent = this.spectator ? 'Watching: the players are choosing a level…' : 'Choose a level';
    this.cards.forEach((c) => (c.disabled = this.spectator));
    this.legend.classList.toggle('bb-hide', solo);
    this.hintEl.textContent = this.spectator
      ? 'Spectating'
      : 'Press a block on the table, drag it above the bowl and let go to drop it (red = not here, it goes back) · Q / E or mouse wheel turns it by 45° · right-click or X puts it back · drag the background to turn the camera, wheel zooms, right-drag moves (C resets)';

    const playing = s.ph !== PHASE.MENU;
    this.hud.classList.toggle('bb-hide', !playing);
    if (!playing) return;
    const lv = levels[s.lv];
    const inWorld = levels.filter((l) => worldKeyOf(l) === worldKeyOf(lv));
    this.titleEl.textContent = lv ? `${worlds[worldKeyOf(lv)]?.name ?? ''} · ${inWorld.indexOf(lv) + 1}. ${lv.name}` : '';
    this.titleEl.dataset.diff = lv?.difficulty ?? '';
    this.leftEl.textContent = `Blocks left: ${s.left} / ${s.total}`;
    const counting = s.ph === PHASE.PLAY && s.left === 0 && s.still > 0;
    this.cdEl.classList.toggle('bb-show', counting);
    this.dots.forEach((d, i) => d.classList.toggle('bb-on', counting && s.still >= (i + 1) / 3 - 0.01));
    const wk = worldKeyOf(lv);
    if (wk !== this.worldKey) { // the menu we come back to shows the world of this level
      this.worldKey = wk;
      this.#buildCards();
    }
  }

  // ── layout ──
  #resize() {
    const w = Math.max(1, this.ctx.container.clientWidth - this.dock);
    const h = Math.max(1, this.ctx.container.clientHeight - this.top);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.#fitCamera();
  }

  /**
   * The camera looks down at the table from the front; it moves back until everything that matters is on screen:
   * the full play width, the top of the tower, and the waiting blocks on the table in front of the bowl.
   */
  #fitCamera() {
    const cam = tuning.camera;
    this.camera.fov = cam.fov;
    this.camera.updateProjectionMatrix();
    if (this.freeCam) return;
    const pitch = THREE.MathUtils.degToRad(cam.pitch);
    const target = new THREE.Vector3(0, cam.targetY, 0);
    const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
    const have = Math.max(1, this.currentLevel?.shapes?.length ?? 1);
    const slots = Math.min(have, Math.min(8, Math.max(1, this.currentLevel?.chooseShapes ?? 4))); //  blocks on the table
    const places = Math.min(have, slots + PREVIEW_COUNT); //                                             + the outlines of the next ones, at most as many as the level has
    const slotX = ((places - 1) / 2) * tuning.slotGap + 7; //                                           the row is centred on all of them
    const key = [
      [-VIEW.w / 2, 10, 0], [VIEW.w / 2, 10, 0], [0, 30, 0], [-23, 28, 0], [23, 28, 0],
      [-slotX, this.groundY, FRONT_Z + DEPTH / 2], [slotX, this.groundY, FRONT_Z + DEPTH / 2],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const p = new THREE.Vector3();
    let dist = 40;
    for (; dist < 600; dist += 1) {
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld(true);
      if (key.every((k) => { p.copy(k).project(this.camera); return Math.abs(p.x) <= 0.94 && Math.abs(p.y) <= 0.94 && p.z < 1; })) break;
    }
    this.fit = { pos: this.camera.position.clone(), target };
    this.#applyUserCam();
  }

  /** The fitted camera, turned / moved / zoomed by what the player did with the mouse. */
  #applyUserCam() {
    const u = this.userCam;
    if (this.freeCam || !this.fit) return;
    if (!u.yaw && !u.pitch && u.zoom === 1 && u.pan.lengthSq() === 0) return; // untouched: the fitted camera as it is
    const off = this.fit.pos.clone().sub(this.fit.target);
    const len = off.length() * u.zoom;
    const yaw = Math.atan2(off.x, off.z) + u.yaw;
    const pitch = THREE.MathUtils.clamp(Math.asin(off.y / off.length()) + u.pitch, 0.05, 1.45);
    const target = this.fit.target.clone().add(u.pan);
    const cp = Math.cos(pitch);
    this.camera.position.set(target.x + len * cp * Math.sin(yaw), target.y + len * Math.sin(pitch), target.z + len * cp * Math.cos(yaw));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
  }

  /** Back to the camera the game fits to the table. */
  #resetCamera() {
    const u = this.userCam;
    u.yaw = 0;
    u.pitch = 0;
    u.zoom = 1;
    u.pan.set(0, 0, 0);
    this.#fitCamera();
  }

  #frame = () => {
    this.raf = requestAnimationFrame(this.#frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.uTime.value += dt;
    if (this.freeCam) this.#applyFreeCam();

    // the block we hold keeps following the pointer with its grab offset, which melts away as the block comes back into the play area
    if (this.#carrying() && this.ptr) {
      const { x, y } = this.local;
      this.#follow();
      if (Math.abs(this.local.x - x) > 0.001 || Math.abs(this.local.y - y) > 0.001) this.#sendMove(now);
    }

    const TAU = Math.PI * 2;
    const draw = (v, rate) => {
      const t = this.#target(v);
      const c = v.cur;
      const k = rate >= 1 ? 1 : 1 - Math.exp(-rate * dt);
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      c.z += (t.z - c.z) * k;
      c.s += (t.s - c.s) * k;
      c.tl = (c.tl ?? 1) + (t.tl - (c.tl ?? 1)) * k;
      c.a += (((((t.a - c.a + Math.PI) % TAU) + TAU) % TAU) - Math.PI) * k;
      v.group.position.set(c.x, c.y, c.z);
      v.group.rotation.z = c.a;
      v.group.rotation.x = -(1 - c.tl) * Math.PI / 2; // lying on the table → standing
      v.group.scale.setScalar(c.s);
    };

    for (const v of this.bodyViews.values()) {
      const mineHeld = v.owner === this.ctx.me.slot && (v.st === BODY.HELD || v.st === BODY.HELD_BAD) && this.#carrying();
      draw(v, v.static ? 1 : mineHeld ? 45 : 24);
    }
    for (const v of this.tableViews.values()) draw(v, 14);
    this.#animateGhosts(dt);
    for (const v of this.tableViews.values()) {
      if (v.reveal === undefined || v.reveal >= 1) continue; // a block that just came out of its outline dissolves in
      v.reveal = Math.min(1, v.reveal + dt / 0.55);
      v.mats.forEach((m) => { m.uniforms.uReveal.value = v.reveal; });
    }

    for (const v of this.bodyViews.values()) {
      const heldByOther = (v.st === BODY.HELD || v.st === BODY.HELD_BAD) && v.owner !== this.ctx.me.slot;
      if (heldByOther && !v.marker) {
        v.marker = new THREE.Mesh(this.markerGeo, new THREE.MeshBasicMaterial({ color: meta.seatColors[v.owner] ?? '#ffffff' }));
        this.frontScene.add(v.marker);
      } else if (!heldByOther) {
        this.#dropMarker(v);
      }
      if (v.marker) v.marker.position.set(v.group.position.x, v.group.position.y + v.size.radius * v.group.scale.x + 1.4, v.group.position.z);
    }
    for (const v of this.bodyViews.values()) {
      const want = v.st === BODY.HELD || v.st === BODY.HELD_BAD ? this.frontScene : this.scene;
      if (v.group.parent !== want) want.add(v.group);
    }

    this.selBox?.update();
    for (let i = this.shards.length - 1; i >= 0; i--) { // falling glass
      const sh = this.shards[i];
      sh.life -= dt;
      sh.vy -= 38 * dt;
      sh.mesh.position.x += sh.vx * dt;
      sh.mesh.position.y += sh.vy * dt;
      sh.mesh.position.z += sh.vz * dt;
      sh.mesh.rotation.x += sh.spin * dt;
      sh.mesh.rotation.z += sh.spin * dt * 0.7;
      sh.mesh.material.opacity = Math.max(0, Math.min(0.8, sh.life));
      if (sh.life <= 0) {
        sh.mesh.removeFromParent();
        sh.mesh.material.dispose();
        this.shards.splice(i, 1);
      }
    }

    try {
      this.#renderAll();
    } catch (e) {
      if (this.renderer.getContext?.().isContextLost?.()) return; // the browser took the WebGL context away (too many WebGL windows, or a GPU reset): three.js gets it back by itself, nothing to report
      this.#report(`drawing failed: ${e?.message ?? e}`, e);
      this.renderer.setRenderTarget(null);
      this.#showAll();
    }
  };

  // ── drawing: shadow map → reflection → (blurred background) → everything else → the blocks you hold ──
  #renderAll() {
    const r = this.renderer;
    const guard = (name, fn) => {
      if (this.fx.off.has(name)) return false;
      try {
        return fn();
      } catch (e) { // a pass that cannot run on this machine is switched off for good; the game itself keeps working
        this.#report(`the ${name} effect failed and was switched off: ${e?.message ?? e}`, e);
        this.fx.off.add(name);
        r.setRenderTarget(null);
        this.#showAll();
        return false;
      }
    };
    guard('shadows', () => this.#shadowPass());
    guard('reflection', () => this.#reflectPass());
    const blurred = guard('blur', () => this.#blurPass());
    if (this.fx.off.has('shadows')) this.shadowU.uShadowStr.value = 0; // (a pass that is off or failed must not leave its last result behind)
    if (this.fx.off.has('reflection')) this.waterU.uReflStr.value = 0;
    if (blurred) {
      r.clearDepth();
      const bgSave = this.scene.background;
      this.scene.background = null; // (a colour background would wipe the blurred picture)
      this.scenery.visible = false;
      r.render(this.scene, this.camera);
      this.scenery.visible = true;
      this.scene.background = bgSave;
    } else {
      r.clear();
      r.render(this.scene, this.camera);
    }
    // glass (layer 2): copy what has been drawn, then draw the glass on top of it, bending that copy
    const cam = this.camera;
    const normalMask = cam.layers.mask;
    const hasGlass = [...this.bodyViews.values(), ...this.tableViews.values()].some((v) => v.glass);
    this.refrU.uRefrOn.value = 0;
    if (hasGlass && guard('refraction', () => this.#refractPass())) this.refrU.uRefrOn.value = 1;
    if (hasGlass) {
      const autoClear = r.autoClear;
      const bgSave = this.scene.background;
      r.autoClear = false; // (the picture and its depth stay: the glass hides behind what is in front of it)
      this.scene.background = null;
      cam.layers.mask = 0b100;
      try {
        r.render(this.scene, cam);
      } finally {
        cam.layers.mask = normalMask;
        this.scene.background = bgSave;
        r.autoClear = autoClear;
      }
    }
    r.clearDepth();
    cam.layers.mask = normalMask | 0b100; // (the glass you hold is in the other scene)
    try {
      r.render(this.frontScene, cam);
    } finally {
      cam.layers.mask = normalMask;
    }
  }

  /** Copy the picture drawn so far into a texture for the glass to look through. Returns false when that is not possible. */
  #refractPass() {
    const r = this.renderer;
    const fx = this.fx;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.round(size.x));
    const h = Math.max(2, Math.round(size.y));
    if (!fx.refrTex || fx.refrW !== w || fx.refrH !== h) {
      fx.refrTex?.dispose();
      fx.refrTex = new THREE.FramebufferTexture(w, h);
      fx.refrW = w;
      fx.refrH = h;
      this.refrU.uRefr.value = fx.refrTex;
    }
    const origin = new THREE.Vector2(0, 0);
    if (r.copyFramebufferToTexture.length >= 2) r.copyFramebufferToTexture(origin, fx.refrTex); // (older three.js: position first)
    else r.copyFramebufferToTexture(fx.refrTex, origin);
    this.refrU.uRefrRes.value.set(w, h);
    return true;
  }

  #showAll() {
    for (const [c, v] of this.hidden ?? []) c.visible = v;
    this.hidden = [];
    if (this.world) this.world.visible = true;
    if (this.scenery) this.scenery.visible = true;
    if (this.mainGroup) this.mainGroup.visible = true;
    if (this.floorMesh) this.floorMesh.visible = true;
    if (this.water) this.water.visible = true;
    this.scene.overrideMaterial = null;
    this.frontScene.overrideMaterial = null;
  }

  /** Light that casts shadows: the world is drawn as depth from the light's side; every material looks the depth up (see SHADOW_GLSL). */
  #shadowPass() {
    const L = this.bgFx.light;
    const u = this.shadowU;
    const cfg = shadowSettings(L); // the global settings, or this background's own (see SHADOW_DEFAULTS in shared.js)
    if (!L || !cfg.on || !(L.shadow > 0)) {
      u.uShadowStr.value = 0;
      return false;
    }
    const fx = this.fx;
    const size = Math.min(cfg.size, this.renderer.capabilities?.maxTextureSize ?? cfg.size); // (as big as the graphics card allows)
    const half = cfg.range / 2;
    if (!fx.shadowRT || fx.shadowRT.width !== size) {
      fx.shadowRT?.dispose();
      // the shadow map IS the depth buffer of this target (a depth texture: 24 bits, read back as it is). The old way, packing the depth into the four
      // 8-bit colour channels, loses its precision on some graphics cards, and that shows up as stripes (shadow acne) over every flat surface.
      fx.shadowRT = new THREE.WebGLRenderTarget(size, size, {
        format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
        depthTexture: new THREE.DepthTexture(size, size),
      });
    }
    if (!fx.depthMat) fx.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }); // (the usual hardware slope bias: occluders are stored a little further away)
    if (!fx.shadowCam) {
      fx.shadowCam = new THREE.OrthographicCamera(-half, half, half, -half, SHADOW_NEAR, SHADOW_FAR);
      fx.shadowCam.layers.enable(2); // (glass casts a shadow too)
    }
    if (fx.shadowCam.right !== half) {
      Object.assign(fx.shadowCam, { left: -half, right: half, top: half, bottom: -half });
      fx.shadowCam.updateProjectionMatrix();
    }
    u.uShadowTexel.value.set(1 / size, 1 / size);
    u.uShadowRange.value = cfg.range;
    u.uShadowBias.value = cfg.bias;
    u.uShadowNormal.value = cfg.normalBias;
    u.uShadowK.value = THREE.MathUtils.clamp(Math.round(cfg.softness), 1, 3);
    const dir = this.shadowU.uLightDir.value.clone();
    const target = new THREE.Vector3(0, this.groundY + 6, 0);
    const cam = fx.shadowCam;
    cam.position.copy(target).addScaledVector(dir, 200);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    u.uShadowMat.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.uShadowR.value.setFromMatrixColumn(cam.matrixWorld, 0);
    u.uShadowU.value.setFromMatrixColumn(cam.matrixWorld, 1);

    const r = this.renderer;
    const oldColor = r.getClearColor(new THREE.Color());
    const oldAlpha = r.getClearAlpha();
    const bgSave = this.scene.background;
    this.scene.background = null;
    if (this.water) this.water.visible = false;
    if (this.lightMarkers) this.lightMarkers.visible = false;
    if (this.floorMesh) this.floorMesh.visible = false;
    this.scene.overrideMaterial = fx.depthMat;
    this.frontScene.overrideMaterial = fx.depthMat;
    r.setClearColor(0xffffff, 1); // white = infinitely far = nothing in the way
    r.setRenderTarget(fx.shadowRT);
    r.clear();
    r.render(this.scene, cam);
    r.render(this.frontScene, cam);
    r.setRenderTarget(null);
    r.setClearColor(oldColor, oldAlpha);
    this.scene.overrideMaterial = null;
    this.frontScene.overrideMaterial = null;
    this.scene.background = bgSave;
    if (this.water) this.water.visible = true;
    if (this.lightMarkers) this.lightMarkers.visible = this.markersOn;
    if (this.floorMesh) this.floorMesh.visible = true;
    u.uShadowMap.value = fx.shadowRT.depthTexture;
    u.uShadowStr.value = L.shadow;
    return true;
  }

  /** Hide everything that is not part of the scenery (blocks, table, bowl, water); optionally the floor too. */
  #soloScenery(on, hideFloor) {
    if (on) {
      this.hidden = [];
      for (const c of this.scene.children) {
        if (c === this.world) continue;
        this.hidden.push([c, c.visible]);
        c.visible = false;
      }
    } else {
      for (const [c, v] of this.hidden ?? []) c.visible = v; // (back to what each one was: the drop-zone outline is hidden on purpose)
      this.hidden = [];
    }
    if (this.mainGroup) this.mainGroup.visible = !on;
    if (hideFloor && this.floorMesh) this.floorMesh.visible = !on;
  }

  /** Planar reflection: the scenery seen from a camera mirrored in the water surface, drawn into a texture the water shader looks up. */
  #reflectPass() {
    const strength = this.bowlDef?.water?.reflect ?? 0;
    const u = this.waterU;
    if (!this.water || !(strength > 0)) {
      u.uReflStr.value = 0;
      return false;
    }
    const fx = this.fx;
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(16, Math.round(size.x / 2));
    const h = Math.max(16, Math.round(size.y / 2));
    if (!fx.reflRT) {
      fx.reflRT = new THREE.WebGLRenderTarget(w, h);
      fx.reflCam = new THREE.PerspectiveCamera();
    } else if (fx.reflRT.width !== w || fx.reflRT.height !== h) {
      fx.reflRT.setSize(w, h);
    }
    const cam = this.camera;
    cam.updateMatrixWorld(true);
    const plane = new THREE.Vector3(0, WATER_Y, 0);
    const normal = new THREE.Vector3(0, 1, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const view = new THREE.Vector3().subVectors(plane, camPos);
    if (view.dot(normal) > 0) { // the camera is under the water: nothing to reflect
      u.uReflStr.value = 0;
      return false;
    }
    view.reflect(normal).negate().add(plane);
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = new THREE.Vector3().subVectors(plane, look).reflect(normal).negate().add(plane);
    const vc = fx.reflCam;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    vc.lookAt(target);
    vc.near = cam.near;
    vc.far = cam.far;
    vc.updateMatrixWorld(true);
    vc.projectionMatrix.copy(cam.projectionMatrix);
    u.uReflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    const oldColor = r.getClearColor(new THREE.Color());
    const oldAlpha = r.getClearAlpha();
    const bgSave = this.scene.background;
    this.scene.background = null;
    this.#soloScenery(true, true);
    r.setClearColor(this.mistNow, 1);
    r.setRenderTarget(fx.reflRT);
    r.clear();
    r.render(this.scene, vc);
    r.setRenderTarget(null);
    this.#soloScenery(false, true);
    r.setClearColor(oldColor, oldAlpha);
    this.scene.background = bgSave;
    u.uRefl.value = fx.reflRT.texture;
    u.uReflStr.value = strength;
    return true;
  }

  /**
   * The scenery (floor and background models) is drawn at full size, then shrunk step by step (each step averages 5 taps into a texture half the
   * size) and grown back (8 taps): a DUAL KAWASE blur. That pyramid is built ONCE and read twice, grown back to two strengths: a light one (`blur`)
   * and a heavy one (`blurFar`). Every object says which one it gets (`blur: 'none' | 'light' | 'heavy'`, on every background model and in
   * `ground.blur`): the scenery is drawn a second time as a flat "mask" (the red channel of every object = its choice), and one last pass picks
   * sharp / light / heavy per pixel from that mask. (A blur with its own radius per pixel would cost far more; this costs one extra tiny chain.)
   */
  #blurPass() {
    const B = this.bgFx;
    const near = Math.max(0, B.blur ?? 0);
    const far = Math.max(0, B.blurFar ?? 0);
    if (!(near > 0 || far > 0) || !this.scenery) return false;
    const fx = this.fx;
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w0 = Math.max(16, Math.round(size.x));
    const h0 = Math.max(16, Math.round(size.y));
    const plan = (radius) => { // levels of the pyramid and the tap offset for a blur of about `radius` pixels (full-size pixels)
      if (!(radius > 0)) return null;
      const levels = THREE.MathUtils.clamp(Math.ceil(Math.log2(Math.max(radius, 1) / 3)), 1, 5);
      return { levels, offset: THREE.MathUtils.clamp(radius / 2 ** (levels + 1), 0.5, 3) };
    };
    const pn = plan(near);
    const pf = plan(far);
    const depthLevels = Math.max(pn?.levels ?? 1, pf?.levels ?? 1);
    if (!fx.kawase) {
      const vs = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
      const mk = (fs, extra = {}) => new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uHalf: { value: new THREE.Vector2() }, uOff: { value: 1 }, ...extra },
        vertexShader: vs,
        fragmentShader: fs,
        depthTest: false,
        depthWrite: false,
      });
      const down = mk(/* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uHalf;
uniform float uOff;
void main() {
  vec2 o = uHalf * uOff;
  vec4 s = texture2D(uTex, vUv) * 4.0;
  s += texture2D(uTex, vUv - o);
  s += texture2D(uTex, vUv + o);
  s += texture2D(uTex, vUv + vec2(o.x, -o.y));
  s += texture2D(uTex, vUv - vec2(o.x, -o.y));
  gl_FragColor = vec4(s.rgb / 8.0, 1.0);
}`);
      const up = mk(/* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uHalf;
uniform float uOff;
void main() {
  vec2 o = uHalf * uOff;
  vec4 s = texture2D(uTex, vUv + vec2(-o.x * 2.0, 0.0));
  s += texture2D(uTex, vUv + vec2(-o.x, o.y)) * 2.0;
  s += texture2D(uTex, vUv + vec2(0.0, o.y * 2.0));
  s += texture2D(uTex, vUv + vec2(o.x, o.y)) * 2.0;
  s += texture2D(uTex, vUv + vec2(o.x * 2.0, 0.0));
  s += texture2D(uTex, vUv + vec2(o.x, -o.y)) * 2.0;
  s += texture2D(uTex, vUv + vec2(0.0, -o.y * 2.0));
  s += texture2D(uTex, vUv + vec2(-o.x, -o.y)) * 2.0;
  gl_FragColor = vec4(s.rgb / 12.0, 1.0);
}`);
      const mix = mk(/* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;   // sharp
uniform sampler2D uNear;  // light blur
uniform sampler2D uFar;   // heavy blur
uniform sampler2D uMask;  // red: 0 = sharp, 0.5 = light blur, 1 = heavy blur
void main() {
  float m = floor(texture2D(uMask, vUv).r * 2.0 + 0.5);
  vec3 c = m < 0.5 ? texture2D(uTex, vUv).rgb : (m < 1.5 ? texture2D(uNear, vUv).rgb : texture2D(uFar, vUv).rgb);
  gl_FragColor = vec4(c, 1.0);
}`, { uNear: { value: null }, uFar: { value: null }, uMask: { value: null } });
      const maskMats = [0, 0.5, 1].map((v) => new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `precision highp float;\nvoid main() { gl_FragColor = vec4(${v.toFixed(3)}, 0.0, 0.0, 1.0); }`,
        side: THREE.DoubleSide,
      }));
      const scene = new THREE.Scene();
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), down);
      quad.frustumCulled = false;
      scene.add(quad);
      fx.kawase = { scene, quad, down, up, mix, maskMats, maskRT: null, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), rts: [], nearUp: [], farUp: [], key: '' };
    }
    const k = fx.kawase;
    const key = `${w0}x${h0}x${depthLevels}`;
    if (k.key !== key) { // (re)build the pyramids: `rts` shrinks (level 0 = the scene with its depth), `nearUp` and `farUp` hold the two ways back up
      [...k.rts, ...k.nearUp, ...k.farUp, k.maskRT].forEach((t) => t?.dispose());
      k.maskRT = new THREE.WebGLRenderTarget(w0, h0, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      const rt = (i, depth) => new THREE.WebGLRenderTarget(Math.max(2, w0 >> i), Math.max(2, h0 >> i), {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      });
      k.rts = [];
      k.nearUp = [];
      k.farUp = [];
      for (let i = 0; i <= depthLevels; i++) {
        k.rts.push(rt(i, i === 0));
        k.nearUp.push(i >= 1 && i < depthLevels ? rt(i, false) : null); // (level i of an up chain; the deepest level is read from `rts`)
        k.farUp.push(i >= 1 && i < depthLevels ? rt(i, false) : null);
      }
      k.key = key;
    }
    // 1. the scenery alone, on the colour of the sky
    const oldColor = r.getClearColor(new THREE.Color());
    const oldAlpha = r.getClearAlpha();
    const bgSave = this.scene.background;
    this.scene.background = null;
    this.#soloScenery(true, false);
    r.setClearColor(this.mistNow, 1);
    r.setRenderTarget(k.rts[0]);
    r.clear();
    r.render(this.scene, this.camera);
    // 1b. the mask: the same scenery, every object in one flat colour that says how much it is blurred
    const saved = [];
    this.scenery.traverse((o) => {
      if (!o.isMesh) return;
      let n = o;
      while (n && n.userData.blurLevel === undefined) n = n.parent;
      saved.push([o, o.material]);
      o.material = k.maskMats[n?.userData.blurLevel ?? 1];
    });
    r.setClearColor(0x808080, 1); // (empty sky = the light blur: nothing to see there anyway)
    r.setRenderTarget(k.maskRT);
    r.clear();
    r.render(this.scene, this.camera);
    for (const [o, m] of saved) o.material = m;
    this.#soloScenery(false, false);
    // 2. shrink (once), 3. grow back to each strength
    const pass = (mat, from, to, offset, half) => {
      k.quad.material = mat;
      mat.uniforms.uTex.value = from.texture;
      mat.uniforms.uHalf.value.set(0.5 / half.width, 0.5 / half.height); // (half a texel of the smaller of the two textures)
      mat.uniforms.uOff.value = offset;
      r.setRenderTarget(to);
      r.render(k.scene, k.cam);
    };
    for (let i = 0; i < depthLevels; i++) pass(k.down, k.rts[i], k.rts[i + 1], 1, k.rts[i + 1]);
    const grow = (p, store) => { // up the pyramid from level p.levels to level 1; the result is the texture at level 1 (half size)
      if (!p) return k.rts[0].texture;
      let from = k.rts[p.levels];
      for (let i = p.levels; i > 1; i--) {
        const to = store[i - 1];
        pass(k.up, from, to, p.offset, from);
        from = to;
      }
      if (p.levels === 1) return from.texture;
      return from.texture;
    };
    const nearTex = grow(pn, k.nearUp);
    const farTex = pf ? grow(pf, k.farUp) : nearTex;
    // 4. the mix, onto the screen
    r.setClearColor(oldColor, oldAlpha);
    const m = k.mix.uniforms;
    m.uTex.value = k.rts[0].texture;
    m.uMask.value = k.maskRT.texture;
    m.uNear.value = nearTex;
    m.uFar.value = farTex;
    k.quad.material = k.mix;
    r.setRenderTarget(null);
    r.clear();
    r.render(k.scene, k.cam);
    this.scene.background = bgSave;
    return true;
  }

  // ── input ──
  #carrying() {
    return this.mode === 'drag' || this.mode === 'releasing' || this.mode === 'released';
  }

  #setRay(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  /** Pointer position in the play plane (z = 0), in world units. */
  #toWorld(e) {
    this.#setRay(e);
    return this.ray.ray.intersectPlane(this.plane, this.hit) ? { x: this.hit.x, y: this.hit.y } : null;
  }

  /** Id of the table block under the pointer (the ray from #setRay must be current). */
  #tableAt() {
    const meshes = [];
    for (const v of this.tableViews.values()) v.group.children.forEach((c) => c.isMesh && meshes.push(c));
    return this.ray.intersectObjects(meshes, false)[0]?.object.userData.id ?? null;
  }

  #sendMove(now = performance.now(), force = false) {
    if (!force && now - this.lastSent < SEND_GAP) return;
    this.lastSent = now;
    this.ctx.sendInput({
      x: Math.round(this.local.x * 100) / 100,
      y: Math.round(this.local.y * 100) / 100,
      rot: Math.round(this.local.rot * 10) / 10,
    });
  }

  #onDown = (e) => {
    if (this.freeCam) {
      if (e.button === 0 && this.camHook?.down(e)) { // a studio took the pointer (e.g. it picked a background model)
        this.hookDrag = true;
        this.renderer.domElement.setPointerCapture(e.pointerId);
        return;
      }
      this.camDrag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 };
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
    // the camera: drag empty space to turn it, right / middle button (or Shift) to move it
    const startCam = () => {
      this.userDrag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
      this.renderer.domElement.setPointerCapture(e.pointerId);
    };
    if (e.button !== 0) {
      if (!this.#carrying()) startCam();
      return;
    }
    if (this.snap?.ph !== PHASE.PLAY) return startCam();
    const p = this.#toWorld(e);
    if (!p) return startCam();
    if (this.mode === 'releasing') { // pressed again right after letting go: the block was never dropped, carry on with it
      this.releaseToken++;
      this.ptr = p;
      this.mode = 'drag';
      this.modeTime = performance.now();
      this.#follow();
      this.#sendMove(performance.now(), true);
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return undefined;
    }
    if (this.mode !== 'none') return;
    const id = this.#tableAt();
    if (id === null) return startCam();
    const v = this.tableViews.get(id);
    // the block's centre, seen along the line of sight, lands at this point of the play plane: start there, no jump
    const cam = this.camera.position;
    const k = cam.z / (cam.z - v.cur.z);
    const cx = cam.x + (v.cur.x - cam.x) * k;
    const cy = cam.y + (v.cur.y - cam.y) * k;
    this.grab = { x: cx - p.x, y: cy - p.y }; // the block stays where it is: this is how far it is from the pointer (it melts away while the block comes back to the play plane)
    this.ptr = p;
    this.pickY = p.y;
    this.prog = 0;
    this.local = { x: cx, y: cy, rot: 0 };
    this.ctx.sendInput({ pick: id, x: cx, y: cy, rot: 0 });
    this.mode = 'drag';
    this.modeTime = performance.now();
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.renderer.domElement.setPointerCapture(e.pointerId);
  };

  #onMove = (e) => {
    if (this.hookDrag) {
      this.camHook?.move(e);
      return;
    }
    if (this.userDrag) {
      const d = this.userDrag;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      const u = this.userCam;
      if (d.pan) {
        const k = this.camera.position.distanceTo(this.fit?.target ?? new THREE.Vector3()) * 0.0016;
        u.pan.addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0), -dx * k);
        u.pan.addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1), dy * k);
        u.pan.x = THREE.MathUtils.clamp(u.pan.x, -80, 80);
        u.pan.y = THREE.MathUtils.clamp(u.pan.y, -40, 60);
        u.pan.z = THREE.MathUtils.clamp(u.pan.z, -80, 80);
      } else {
        u.yaw = THREE.MathUtils.clamp(u.yaw - dx * 0.005, -1.05, 1.05);
        u.pitch = THREE.MathUtils.clamp(u.pitch + dy * 0.005, -0.4, 1.0);
      }
      this.#applyUserCam();
      return;
    }
    if (this.freeCam) {
      const d = this.camDrag;
      if (!d) return;
      const f = this.freeCam;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.pan) {
        const k = f.dist * 0.0016;
        f.target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0), -dx * k);
        f.target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1), dy * k);
      } else {
        f.yaw -= dx * 0.005;
        f.pitch = THREE.MathUtils.clamp(f.pitch + dy * 0.005, -0.3, 1.55);
      }
      return;
    }
    const p = this.#toWorld(e);
    if (!this.#carrying()) {
      this.renderer.domElement.classList.toggle('bb-grab', this.snap?.ph === PHASE.PLAY && this.#tableAt() !== null);
      return;
    }
    if (!p || this.mode === 'releasing') return; // (just let go: the block stays where it is until it drops or is picked up again)
    this.ptr = p;
    this.#follow();
    this.#sendMove();
  };

  #onUp = (e) => {
    if (this.hookDrag) {
      this.hookDrag = false;
      this.camHook?.up(e);
      return;
    }
    if (this.userDrag) {
      this.userDrag = null;
      return;
    }
    if (this.freeCam) {
      this.camDrag = null;
      return;
    }
    if (this.mode !== 'drag') return;
    const p = this.#toWorld(e);
    if (p) {
      this.ptr = p;
      this.#follow();
    }
    this.#sendMove(performance.now(), true);
    // Letting go of the mouse lets go of the block, but not for RELEASE_DELAY ms: the block stays in the hand for a moment, and pressing again in
    // that time (a button that bounces, a very short release) just carries on. Only after the delay does it really drop.
    this.mode = 'releasing';
    this.modeTime = performance.now();
    const token = (this.releaseToken = (this.releaseToken ?? 0) + 1);
    setTimeout(() => {
      if (this.mode !== 'releasing' || this.releaseToken !== token) return;
      this.ctx.sendInput({ drop: true });
      this.mode = 'released';
      this.modeTime = performance.now();
    }, RELEASE_DELAY);
  };

  #onWheel = (e) => {
    if (this.freeCam) {
      e.preventDefault();
      this.freeCam.dist = THREE.MathUtils.clamp(this.freeCam.dist * Math.exp(e.deltaY * 0.001), 5, 900);
      return;
    }
    if (!this.#carrying()) { // nothing in your hand: the wheel zooms the camera
      e.preventDefault();
      this.userCam.zoom = THREE.MathUtils.clamp(this.userCam.zoom * Math.exp(e.deltaY * 0.001), 0.4, 2.2);
      this.#applyUserCam();
      return;
    }
    e.preventDefault();
    // Every notch turns the block one step at once, with no delay at all. Smooth wheels and trackpads send many small deltas instead, so those add up until they make a step; what is left over is forgotten after a short pause or a change of direction.
    const now = performance.now();
    const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1); // (lines and pages to pixels)
    const step = (dir) => this.#turn(dir);
    if (Math.abs(px) >= 50) { // a whole notch
      this.wheelAcc = 0;
      step(px < 0 ? 1 : -1);
    } else {
      if (now - (this.lastWheel ?? 0) > 250 || Math.sign(px) !== Math.sign(this.wheelAcc ?? 0)) this.wheelAcc = 0;
      this.wheelAcc = (this.wheelAcc ?? 0) + px;
      if (Math.abs(this.wheelAcc) >= 50) {
        step(this.wheelAcc < 0 ? 1 : -1);
        this.wheelAcc = 0;
      }
    }
    this.lastWheel = now;
  };

  #onContext = (e) => {
    e.preventDefault();
    if (!this.freeCam) this.#putBack();
  };

  #putBack() {
    if (!this.#carrying()) return;
    this.ctx.sendInput({ cancel: true });
    this.mode = 'none';
  }

  #onKeyDown = (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')) return; // typing in the debug menu is not playing
    const k = e.key.toLowerCase();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((k === 'q' || k === 'e') && this.#carrying()) this.#turn(k === 'q' ? 1 : -1);
    else if (k === 'x') this.#putBack();
    else if (k === 'c') this.#resetCamera();
  };

  /** Turn the block we hold one step (45°) to the left (+1) or right (-1). */
  #turn(dir) {
    this.local.rot = Math.round(this.local.rot / ROTATE_STEP) * ROTATE_STEP + dir * ROTATE_STEP;
    this.#sendMove(performance.now(), true);
  }
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const balance = { meta, mount: (ctx) => new BalanceView(ctx) };

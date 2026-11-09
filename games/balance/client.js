import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  applyDefinitions, backgroundKeyOf, cloneDefinitions, backgroundOf, BODY, bowlKeyOf, bowlOf, bowlProfile, buildShape, DEBUG, DEPTH, dropOf, DROP, FRONT_Z, getShape, groundYOf,
  HOVER_Z, LAMP_RADIUS, levels, LOSE_TEXT, paramValue, parseShaderParams, shaderCode, MAX_LIGHTS, shadowSettings, materials, MATERIAL_KEYS, meta, models, PHASE, PLAY_Z, PLAYER_COLORS, PREVIEW_COUNT, roundOf, SHAPE_KEYS, slotPos, tuning, unionOutlines, VIEW, WATER_Y, worldKeyOf, worlds,
} from './shared.js';

// The definitions as the files have them (debug: every new game starts from these, because the definitions in this page are edited in place).
const PRISTINE = DEBUG ? cloneDefinitions() : null;
import { flatNormals, parseObj } from './obj.js';
import { svg } from './ui.js';
import { CURSOR_SIZE, handCanvas, handCursors, handHot } from './hands.js';
import { bakeSizeOf, deformShaders, frag, hasBake, PRELUDE_LINES, SHADOW_GLSL, vertexShader, waterFrag, WATER_PRELUDE_LINES, waveVertexShader } from './shaders.js';

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
const BOWL_SEGS = 48; // points along the profile of the bowl (the turned shape); it is turned in LATHE_SEGS steps
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
const ROTATE_ANIM = 30; //      how fast the block in your hand turns to a new angle: it has turned 95% of the way in about 0.1 s
const RELEASE_DELAY = 50;  //   ms between letting go of the mouse and the block really dropping (pressing again in that time picks it back up)
const NO_BUILD_LINE = 0.12; // world units: the thickness of the red line around a no-build zone (the same for every zone)
const GFX_STORE = 'balance.gfx'; // localStorage: the graphics settings
/** Graphics presets. filter: 0 = off, 1 = trilinear, 2 = anisotropic 4x, 3 = anisotropic 16x (sampled textures and the smoothing of fine procedural patterns at steep angles); detail: 0 = flat surfaces, 1 = roughness maps, 2 = roughness and bump maps; scale = the share of the screen's pixels that is drawn. */
const GFX_PRESETS = {
  low: { detail: 0, filter: 0, shadows: false, reflection: false, blur: false, refraction: false, scale: 0.6, shadowSize: 1024 },
  medium: { detail: 1, filter: 1, shadows: true, reflection: true, blur: true, refraction: true, scale: 0.85, shadowSize: 2048 },
  high: { detail: 2, filter: 3, shadows: true, reflection: true, blur: true, refraction: true, scale: 1, shadowSize: 4096 }, // shadowSize: the biggest shadow map this setting allows (a background asks for 2048 by default)
};
const STORE = 'balance.done'; // localStorage: the completed levels (world|name)
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

/** What identifies a level in the list of completed ones: its world and name (its place in the list changes when levels are added or ordered). */
const levelId = (i) => (levels[i] ? `${worldKeyOf(levels[i])}|${levels[i].name}` : null);
const loadDone = () => {
  try {
    const ids = JSON.parse(localStorage.getItem(STORE) ?? '[]').map((v) => (typeof v === 'number' ? levelId(v) : v)); // (an older version stored the place in the list)
    return new Set(ids.filter(Boolean));
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
 * A prism with rounded front and back edges, built from a counter-clockwise outline. The outline is the real (physics) outline, already rounded in 2D by
 * buildShape: the rounding is cut INTO the block, so nothing sticks out. Parts: front / back cap (inset by the radius `c`), a quarter-round strip
 * on each side (ROUND_STEPS pieces), and the side wall. UVs (what the shaders texture with): caps use (x, y); the rounded edges and walls use (distance along the outline, z), so the
 * texture runs along the edge instead of being smeared through the block. Normals are smooth along gentle curves (circles) and
 * crisp at corners.
 */
const ROUND_STEPS = 4; // pieces of the quarter round along the front and back edges
function roundedPrism(outline, depth, c, holes = []) {
  const h = depth / 2;
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
      // on a convex corner the inset moves the corner along both edges by d * tan(turn / 2): never further than 45% of an edge, so the inset loop
      // never turns inside out (the little arcs of a rounded corner would, with an inset as big as their radius)
      const prev = P[(i + N - 1) % N];
      const next = P[(i + 1) % N];
      const e1 = p.clone().sub(prev);
      const e2 = next.clone().sub(p);
      let d = c;
      if (e1.x * e2.y - e1.y * e2.x > 0) {
        const turn = Math.atan2(e1.x * e2.y - e1.y * e2.x, e1.dot(e2));
        if (turn > 1e-6) d = Math.min(c, (0.45 * Math.min(e1.length(), e2.length())) / Math.tan(turn / 2));
      }
      return p.clone().addScaledVector(m, -d);
    });
    const arc = [0];
    for (let i = 0; i < N; i++) arc.push(arc[i] + P[i].distanceTo(P[(i + 1) % N]));
    return { N, P, edgeN, Q, arc };
  });

  // caps (with the holes cut out)
  for (const sign of [1, -1]) {
    const base = pos.length / 3;
    // (where a corner is rounded as much as the edge is, the inset arc shrinks to a single point: a point written twice is left out)
    const capLoops = loops.map((L) => L.Q.filter((q, i) => q.distanceTo(L.Q[(i + L.N - 1) % L.N]) > 1e-5));
    for (const Lq of capLoops) Lq.forEach((q) => vert(q.x, q.y, sign * h, 0, 0, sign, q.x, q.y));
    const faces = THREE.ShapeUtils.triangulateShape(capLoops[0].map((q) => q.clone()), capLoops.slice(1).map((Lq) => Lq.map((q) => q.clone())));
    for (const [a, b, d] of faces) tri(base + a, base + b, base + d, [0, 0, sign]);
  }

  // the rounded edges and the side wall, edge by edge
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
      // the rounded edge: a quarter circle from the wall edge (z = ±zs) inwards to the cap edge (z = ±h)
      for (const sign of [1, -1]) {
        const ring = (k, i, nn, u) => {
          const th = (k / ROUND_STEPS) * (Math.PI / 2);
          const co = Math.cos(th);
          const si = Math.sin(th);
          const t = 1 - co; // how far from the wall outline towards the inset one
          return vert(P[i].x + (Q[i].x - P[i].x) * t, P[i].y + (Q[i].y - P[i].y) * t, sign * (zs + c * si), nn.x * co, nn.y * co, sign * si, u, sign * (zs + c * si));
        };
        for (let k = 0; k < ROUND_STEPS; k++) {
          const mid = ((k + 0.5) / ROUND_STEPS) * (Math.PI / 2);
          const want = [own.x * Math.cos(mid), own.y * Math.cos(mid), sign * Math.sin(mid)];
          const a = ring(k, e, n0, arc[e]);
          const b = ring(k, f, n1, arc[e + 1]);
          const d = ring(k + 1, f, n1, arc[e + 1]);
          const g = ring(k + 1, e, n0, arc[e]);
          tri(a, b, d, want);
          tri(a, d, g, want);
        }
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
 * The meshes of one shape: one rounded prism per part, or (merge on, the default) the parts joined in 2D first and extruded once,
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

/**
 * Where the stack-limit lamp of a fragile block goes: as close as it can to the top middle, but with its whole circle on the block (a block with a corner cut off,
 * or a hole, has nothing at the top middle). Returns { x, y, r } (r is made smaller when the block is too thin for a full lamp). Remembered per shape.
 */
const lampMemo = new WeakMap();
function lampSpot(shape, r) {
  const key = `${r}`;
  let byR = lampMemo.get(shape);
  if (!byR) lampMemo.set(shape, (byR = new Map()));
  if (byR.has(key)) return byR.get(key);
  const outlines = shapeOutlines(shape, tuning.mergeParts !== false);
  const loops = outlines.flatMap((o) => [o.pts, ...(o.holes ?? [])]);
  const inside = (x, y) => outlines.some((o) => insidePoly(o.pts, x, y) && !(o.holes ?? []).some((hole) => insidePoly(hole, x, y)));
  const segDist = (x, y, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = THREE.MathUtils.clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  };
  const clearance = (x, y) => { // how far the point is from the nearest edge (negative = outside the block)
    let d = Infinity;
    for (const L of loops) for (let i = 0, j = L.length - 1; i < L.length; j = i++) d = Math.min(d, segDist(x, y, L[j], L[i]));
    return inside(x, y) ? d : -d;
  };
  const wantY = shape.h / 2 - r - 0.55;
  let best = { x: 0, y: wantY, r };
  if (clearance(0, wantY) < r * 0.9) {
    let bestScore = -Infinity;
    let widest = { x: 0, y: 0, c: -Infinity };
    const N = 60;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const x = -shape.w / 2 + (i / N) * shape.w;
        const y = -shape.h / 2 + (j / N) * shape.h;
        const c = clearance(x, y);
        if (c > widest.c) widest = { x, y, c };
        if (c >= r * 0.9) { // a whole lamp fits here: the nearest to the old place wins
          const score = -Math.hypot(x, (y - wantY) * 0.7);
          if (score > bestScore) { bestScore = score; best = { x, y, r }; }
        }
      }
    }
    if (bestScore === -Infinity) best = { x: widest.x, y: widest.y, r }; // (no whole lamp fits: the roomiest place, the lamp keeps its size)
  }
  byR.set(key, best);
  return best;
}

/** Outline of a circle part as a counter-clockwise point list. */
function circleOutline(part, sides = 48) {
  return Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * Math.PI * 2;
    return [part.cx + Math.cos(a) * part.r, part.cy + Math.sin(a) * part.r];
  });
}

/** The radius of the rounding of the front and back edges (the sides are rounded in 2D by buildShape with the same radius). */
const edgeRadius = () => Math.min(roundOf(), DEPTH / 2 - 0.02);

const WATER_BLOCK_OPACITY = 0.85; // how see-through the water of a water block is (its own setting: uBlockOpacity of the material; the bowl has its own opacity)

/**
 * uNoiseTex of the shader helpers (noiseT, noise3T, fbmT, voronoiT ...): 256 x 256 random numbers that repeat. Green is red shifted by (37, 17) texels, which
 * noise3T needs (one texture read then gives two layers of 3D noise). One object for the whole page: every renderer (also the preview windows) uploads it itself.
 */
let noiseTex = null;
function noiseTexture() {
  if (noiseTex) return noiseTex;
  const N = 256;
  const r = new Uint8Array(N * N);
  let s = 123456789; // (a fixed seed: the same picture on every machine and every start)
  for (let i = 0; i < r.length; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    r[i] = (((t ^ (t >>> 14)) >>> 0) & 255);
  }
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      d[o] = r[y * N + x];
      d[o + 1] = r[((y + 17) % N) * N + ((x + 37) % N)];
      d[o + 2] = r[((y + 101) % N) * N + ((x + 59) % N)];
      d[o + 3] = r[((y + 190) % N) * N + ((x + 7) % N)];
    }
  }
  noiseTex = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter;
  noiseTex.generateMipmaps = false;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

/**
 * The picture a shader draws ONCE (its  vec4 bake(vec2 uv)  ): the material reads it as uBake. The picture is shared: every material with the same code and the
 * same settings uses the same one (a hundred blocks of wood bake once). Every renderer that draws the material gets its own copy, drawn just before the first
 * time it is needed, and drawn again after material.userData.rebake() when a setting changed.
 *   spec = { code, fragment (the source of the baking pass), vertex (its vertex shader) }
 */
const bakeEntries = new Set(); // every baked picture that exists (for the profiler)
const bakePrograms = new Map(); // fragment source -> { scene, mat }  (one program per shader)
const bakeCaches = new WeakMap(); // renderer -> Map(key -> { rt, refs })
function attachBake(mat, spec, list) {
  const size = bakeSizeOf(spec.code);
  mat.uniforms.uBake = { value: null };
  mat.uniforms.uResolution = { value: new THREE.Vector2(size, size) };
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const keyOf = () => `${spec.code}\u0001${JSON.stringify(list.map((p) => { const v = mat.uniforms[p.name].value; return v?.toArray ? v.toArray() : v; }))}`;
  const held = new Map(); // renderer -> the cache entry this material uses now
  let version = 0;
  let seen = -1;
  const release = (renderer, key) => {
    const cache = bakeCaches.get(renderer);
    const e = cache?.get(key);
    if (e && --e.refs <= 0) { e.rt.dispose(); cache.delete(key); bakeEntries.delete(e); }
  };
  mat.userData.rebake = () => { version++; };
  mat.onBeforeRender = (renderer) => {
    let cache = bakeCaches.get(renderer);
    if (!cache) bakeCaches.set(renderer, (cache = new Map()));
    let cur = held.get(renderer);
    if (!cur || seen !== version) {
      const key = keyOf();
      if (!cur || cur.key !== key) {
        let e = cache.get(key);
        if (!e) {
          const rt = new THREE.WebGLRenderTarget(size, size, {
            type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, // (mipmaps: far away or at a slant the picture does not shimmer)
            wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, generateMipmaps: true,
            anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
          });
          e = { rt, refs: 0 };
          bakeEntries.add(e);
          cache.set(key, e);
          let prog = bakePrograms.get(spec.fragment);
          if (!prog) {
            const uniforms = {};
            for (const k of Object.keys(mat.uniforms)) uniforms[k] = { value: mat.uniforms[k].value };
            prog = { scene: new THREE.Scene(), mat: new THREE.ShaderMaterial({ uniforms, vertexShader: spec.vertex, fragmentShader: spec.fragment, depthTest: false, depthWrite: false }) };
            prog.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), prog.mat));
            prog.mat.uniforms.uSeed && (prog.mat.uniforms.uSeed.value = 0); // (the picture is the same for every block: no seed, no time)
            prog.mat.uniforms.uTime && (prog.mat.uniforms.uTime.value = 0);
            bakePrograms.set(spec.fragment, prog);
          }
          for (const k of Object.keys(prog.mat.uniforms)) if (mat.uniforms[k] && k !== 'uSeed' && k !== 'uTime' && k !== 'uBake') prog.mat.uniforms[k].value = mat.uniforms[k].value;
          const prev = renderer.getRenderTarget();
          const auto = renderer.autoClear;
          const shadowAuto = renderer.shadowMap.autoUpdate;
          renderer.shadowMap.autoUpdate = false;
          renderer.autoClear = true;
          renderer.setRenderTarget(rt);
          renderer.render(prog.scene, cam);
          renderer.setRenderTarget(prev);
          renderer.autoClear = auto;
          renderer.shadowMap.autoUpdate = shadowAuto;
        }
        e.refs++;
        if (cur) release(renderer, cur.key);
        cur = { key, e };
        held.set(renderer, cur);
      }
      seen = version;
    }
    mat.uniforms.uBake.value = cur.e.rt.texture;
  };
  mat.addEventListener('dispose', () => {
    for (const [renderer, cur] of held) release(renderer, cur.key);
    held.clear();
  });
}

const BAKE_VERTEX_WATER = /* glsl */ `
varying vec3 vW;
varying vec3 vWN;
varying vec2 vUv;
varying vec3 vPos;
void main() { vUv = uv; vW = vec3(0.0); vWN = vec3(0.0, 1.0, 0.0); vPos = vec3(0.0); gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BAKE_VERTEX_BLOCK = /* glsl */ `
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
varying vec3 vW;
varying vec3 vWN;
varying float vDist;
varying vec3 vRX;
varying vec3 vRY;
varying vec3 vRZ;
void main() { vP = uv * 4.0; vP3 = vec3(0.0); vN = vec3(0.0, 0.0, 1.0); vW = vec3(0.0); vWN = vN; vDist = 1.0; vRX = vec3(1.0, 0.0, 0.0); vRY = vec3(0.0, 1.0, 0.0); vRZ = vN; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * A small stand-alone view of a shader, for the shader studio: a sphere and a block, with the shader on them, lit by a fixed daylight. Like the shape preview
 * it only draws when something changes or when you drag it round, and dispose() gives the WebGL context back.
 * `makeMaterial({ code, type })` makes the material (the view knows how). `update(entry)` shows a new version of the shader.
 */
function shaderPreview3d(host, makeMaterial) {
  const H = 200;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(260, host.clientWidth || 360), H, false);
  const el = renderer.domElement;
  el.style.cssText = `display:block;width:100%;height:${H}px;border-radius:6px;background:linear-gradient(#cfd6e4,#8c97ad);touch-action:none;cursor:grab`;
  host.append(el);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, el.width / el.height, 0.1, 100);
  camera.position.set(0, 0, 9.5);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.45, 64, 48));
  const block = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9, 1.9));
  sphere.position.x = -1.7;
  block.position.x = 1.8;
  scene.add(sphere, block);
  let material = null;
  let yaw = 0.5;
  let pitch = -0.25;
  let error = '';
  renderer.debug.onShaderError = (gl, program, vs, fs) => { error = gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(program) || 'the shader does not compile'; };
  const render = () => {
    block.rotation.set(pitch, yaw, 0);
    sphere.rotation.set(pitch * 0.5, yaw * 0.5, 0);
    renderer.render(scene, camera);
  };
  let drag = null;
  const down = (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture?.(e.pointerId); el.style.cursor = 'grabbing'; };
  const move = (e) => {
    if (!drag) return;
    yaw += (e.clientX - drag.x) * 0.012;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag.y) * 0.012));
    drag = { x: e.clientX, y: e.clientY };
    render();
  };
  const up = () => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return {
    /** Show this version. Returns an error text, or '' when it compiled. */
    update(entry) {
      error = '';
      const old = material;
      try {
        material = makeMaterial(entry);
        sphere.material = material;
        block.material = material;
        render();
      } catch (e) {
        error = `${e?.message ?? e}`;
      }
      old?.dispose();
      return error;
    },
    dispose() {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      material?.dispose();
      sphere.geometry.dispose();
      block.geometry.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      el.remove();
    },
  };
}

/**
 * A small stand-alone 3D view of one shape, for the shape studio: it is only created when the player asks for it, draws only when the shape changes or
 * the player drags it round (never in a loop), and dispose() gives the WebGL context back. `update(def)` rebuilds the block from a shape definition
 * (exactly as the game does) and returns an error text when the definition is not valid.
 */
function shapePreview3d(host) {
  const H = 240;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(220, host.clientWidth || 320), H, false);
  renderer.domElement.style.cssText = `display:block;width:100%;height:${H}px;border-radius:6px;background:#141b30;touch-action:none;cursor:grab`;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-3, 5, 6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, renderer.domElement.width / renderer.domElement.height, 0.1, 500);
  const group = new THREE.Group();
  scene.add(group);
  const material = new THREE.MeshStandardMaterial({ color: 0xc9a26a, roughness: 0.55, metalness: 0 });
  let meshes = [];
  let yaw = 0.55;
  let pitch = -0.3;
  const render = () => {
    group.rotation.set(pitch, yaw, 0);
    renderer.render(scene, camera);
  };
  const clear = () => {
    for (const m of meshes) { group.remove(m); m.geometry.dispose(); }
    meshes = [];
  };
  let drag = null;
  const el = renderer.domElement;
  const down = (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture?.(e.pointerId); el.style.cursor = 'grabbing'; };
  const move = (e) => {
    if (!drag) return;
    yaw += (e.clientX - drag.x) * 0.012;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag.y) * 0.012));
    drag = { x: e.clientX, y: e.clientY };
    render();
  };
  const up = () => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return {
    update(def) {
      clear();
      let shape;
      try {
        shape = buildShape(def, '?');
        for (const o of shapeOutlines(shape, true)) {
          const mesh = new THREE.Mesh(roundedPrism(o.pts, DEPTH, edgeRadius(), o.holes ?? []), material);
          meshes.push(mesh);
          group.add(mesh);
        }
      } catch (e) {
        clear();
        render();
        return `${e?.message ?? e}`;
      }
      camera.position.set(0, 0, (Math.max(shape.radius, 1) * 1.25) / Math.tan(THREE.MathUtils.degToRad(15)));
      camera.lookAt(0, 0, 0);
      render();
      return '';
    },
    dispose() {
      clear();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      el.remove();
    },
  };
}

/** A block you hold: it stands up while it is lifted from 0 to TILT_UNTIL of the way to the play area, and moves back in z from BACK_FROM to the top. */
const TILT_UNTIL = 0.7;
const BACK_FROM = 0.4;
const GHOST_IN = 0.5; //  seconds: an outline fades in
const GHOST_OUT = 0.45; // seconds: it fades away when its block takes over
const smooth = (t) => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };
const backOf = (prog) => smooth((prog - BACK_FROM) / (1 - BACK_FROM));

class BalanceView {
  pcKey = ''; //            the chosen colours of the last snapshot (as text): when it changes, everything that shows a colour is updated
  nameEls = []; //          [slot, element] of every name at the top: its text colour follows the colour of the player
  colorIn = null; //        your own colour circle at the top (a button); `palette` is the popup with the nine colours
  palette = null;
  colorSent = false; //     the colour you chose last time (kept in this browser) has been sent to the room
  colorSentAt = 0;
  colorTimer = 0;
  pendingColor = '';
  hands = null; //          the three cursors (open / point / fist) in your colour: #syncCursor puts the right one on the canvas
  handCursorNow = ''; //    which of them is on the canvas now
  handViews = new Map(); //  slot -> { sprite, key, x, y }: the hands of the OTHER players, drawn where their pointers are
  curSentAt = 0;
  handTex = new Map(); //   colour -> texture of the closed hand shown over the block another player holds
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
    uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
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
  aaU = { value: 1 }; //       uAA of every block shader: how strongly fine patterns fade out where they get smaller than a pixel (the texture filtering setting)
  qualityU = { value: 1 }; // uQuality of every block shader: the surface detail setting of the graphics menu (0 low, 1 roughness maps, 2 roughness + bump maps)
  gfx = null; //            the graphics settings (see GFX_PRESETS), kept in this browser
  gfxPanel = null;
  floorMat = null; //       the material of the floor (debugLiveColors changes its colours without rebuilding the world)
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
  onStatsClosed = null; //    set by the debug menu: the profiler window was closed with its own button
  stats = null; //            the performance overlay (debugStats), or null
  waterBlockMats = new Set(); // the 'waterBlock' blocks that are drawn with the water shader of the bowl
  blockMats = new Set(); //    the materials of blocks whose shader has settings (debugLiveBlocks changes them while a slider is dragged)
  waterSel = null; //   { shader, params } of the water of the background that is shown
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
  exSeen = new Set(); //     ids of the explosions already drawn (the server repeats an explosion in its snapshots for a moment)
  fxList = []; //           running explosion effects: { sprite, t, life, step(k) }
  fxTex = null; //          the textures of the explosion (a soft glow and a ring)
  shakeT = 0; //            seconds of camera shake left
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
    this.hands = handCursors(meta.seatColors[ctx.me.slot] ?? '#ffffff'); // your cursor is a hand in YOUR colour
    this.#loadGfx();
    this.#buildGfx();
    this.#applyGfx(false);
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
      c.addEventListener('pointerleave', this.#onLeave);
      c.addEventListener('wheel', this.#onWheel, { passive: false });
      c.addEventListener('contextmenu', this.#onContext);
      window.addEventListener('keydown', this.#onKeyDown);
    }
    document.addEventListener('pointerdown', this.#closePalette);
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
  #closePalette = (e) => { if (this.palette && !e.target.closest?.('.bb-pick')) this.palette.classList.remove('bb-open'); };

  /** The colour of a seat: the one its player chose, else the default of the seat. */
  #colorOf(slot) {
    return this.snap?.pc?.[slot] ?? meta.seatColors[slot] ?? '#ffffff';
  }

  onRoom(room) {
    this.players = room.players.filter((p) => p.slot >= 0);
    // the names at the top, each in the colour of its player; next to your own name the colour input (a change goes to everybody)
    this.nameEls = [];
    this.colorIn = null;
    const kids = [];
    for (const p of this.players) {
      const mine = p.id === this.ctx.me.id;
      const name = el('span', { class: 'bb-pname' }, p.name);
      name.style.color = this.#colorOf(p.slot);
      this.nameEls.push([p.slot, name]);
      if (mine && !this.spectator) { // your colour circle, left of your name: it opens the nine colours to choose from
        const circle = el('button', { type: 'button', class: 'bb-pcolor', title: 'Your colour' });
        circle.style.background = this.#colorOf(p.slot);
        const palette = el('div', { class: 'bb-palette' }, ...PLAYER_COLORS.map(([label, hex]) => {
          const b = el('button', { type: 'button', class: 'bb-swatch', title: label, 'aria-label': label });
          b.style.background = hex;
          b.addEventListener('click', () => { this.#setMyColor(hex, true); palette.classList.remove('bb-open'); });
          return b;
        }));
        circle.addEventListener('click', () => palette.classList.toggle('bb-open'));
        this.colorIn = circle;
        this.palette = palette;
        kids.push(el('div', { class: 'bb-prow' }, el('span', { class: 'bb-pick' }, circle, palette), name));
      } else {
        kids.push(el('div', { class: 'bb-prow' }, el('span', { class: 'bb-pick bb-pick-none' }), name)); // (the empty place keeps the names in a straight column)
      }
    }
    this.legend.replaceChildren(...kids);
    if (this.snap) this.#updateHud(this.snap);
  }

  /** You picked a colour: remember it, and tell the room (at most ten times a second while the picker is being dragged; the last colour always goes). */
  #setMyColor(c, force) {
    if (!PLAYER_COLORS.some(([, hex]) => hex === c)) return;
    this.pendingColor = c;
    try { localStorage.setItem('balance.color', c); } catch { /* ignore */ }
    const flush = () => {
      clearTimeout(this.colorTimer);
      this.colorTimer = 0;
      this.colorSentAt = performance.now();
      this.ctx.sendInput({ color: this.pendingColor });
      if (this.sandbox) this.#sandboxSend({ color: this.pendingColor }); // (the local game of the debug menu has its own copy of you)
    };
    if (force || performance.now() - this.colorSentAt >= 100) flush();
    else if (!this.colorTimer) this.colorTimer = setTimeout(flush, 100);
  }

  /** A colour in the snapshot changed: the names, your input, your hand and the hands over the blocks of the others follow. */
  #colorsChanged() {
    if (!this.spectator) {
      this.hands = handCursors(this.#colorOf(this.ctx.me.slot));
      this.handCursorNow = ''; // (#syncCursor puts the new hand on the canvas)
    }
    for (const [slot, name] of this.nameEls) name.style.color = this.#colorOf(slot);
    if (this.colorIn) this.colorIn.style.background = this.#colorOf(this.ctx.me.slot);
    for (const h of this.handViews.values()) h.key = ''; // (the hands of the others get their new colour on the next frame)
    for (const t of this.handTex.values()) t.dispose();
    this.handTex.clear();
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
    const pcKey = JSON.stringify(s.pc ?? null);
    if (pcKey !== this.pcKey) { this.pcKey = pcKey; this.#colorsChanged(); }
    if (!this.colorSent && fromRoom && !this.spectator) { // the colour you chose the last time you were here (kept in this browser) goes to the room once
      this.colorSent = true;
      let c = '';
      try { c = localStorage.getItem('balance.color') ?? ''; } catch { /* ignore */ }
      if (c !== this.#colorOf(this.ctx.me.slot)) this.#setMyColor(c, true); // (a colour that is not one of the nine is ignored there)
    }
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

    for (const [id, x, y, chain] of s.ex ?? []) { // fuel met oxidizer
      if (this.exSeen.has(id)) continue;
      this.exSeen.add(id);
      this.#explosion(x, y, !!chain);
    }

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
      if (v.zoff === undefined) { // a start block can be moved towards or away from the camera (the z of the level's start layout; ids 1.. are the start blocks in order)
        const start = levels[s.lv]?.initialBlocks;
        v.zoff = start && id >= 1 && id <= start.length ? (start[id - 1].z ?? 0) : 0;
        v.cur.z = PLAY_Z + v.zoff;
      }
      Object.assign(v, { tx: x, ty: y, ta: a, st, owner });
      this.#setLoad(v, load ?? 0);
      v.static = st === BODY.STATIC;
      const held = st === BODY.HELD || st === BODY.HELD_BAD;
      if (held && owner === this.ctx.me.slot) mine = id;
      v.mats.forEach((m) => { m.uniforms.uBad.value = st === BODY.HELD_BAD ? 1 : 0; m.uniforms.uCausOn.value = held ? 0 : 1; if (m.uniforms.uShadowOff) m.uniforms.uShadowOff.value = held ? 1 : 0; }); // (a block in your hand is not in the water) // the only tint a block ever gets: red = outside the drop area
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
    document.removeEventListener('pointerdown', this.#closePalette);
    c.removeEventListener('pointerdown', this.#onDown);
    c.removeEventListener('pointermove', this.#onMove);
    c.removeEventListener('pointerup', this.#onUp);
    c.removeEventListener('pointercancel', this.#onUp);
    c.removeEventListener('pointerleave', this.#onLeave);
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
    for (const h of this.handViews.values()) h.sprite.material.dispose();
    this.handViews.clear();
    for (const t of this.handTex.values()) t.dispose();
    this.handTex.clear();
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

  /** The shape studio's 3D preview (only exists while it is shown): see shapePreview3d. */
  debugShape3d(host) {
    return shapePreview3d(host);
  }

  /**
   * The sky (mist) and ground colours of the draft, shown NOW and cheaply: only the colours change (a few uniforms), nothing is rebuilt. The debug menu calls this
   * while a colour is being dragged; the full update (the local game gets the draft, everything is rebuilt) follows when the colour is let go.
   */
  debugLiveColors(defs) {
    const bg = defs?.backgrounds?.[backgroundKeyOf(this.currentLevel)];
    if (!bg || !this.bgFx) return;
    if (typeof bg.mist === 'string') {
      this.bgFx.mist = bg.mist;
      for (const f of this.fogs) f.base.copy(rawColor(bg.mist));
    }
    const u = this.floorMat?.uniforms;
    if (u && bg.ground) {
      if (typeof bg.ground.colorA === 'string') u.uA.value.copy(rawColor(bg.ground.colorA));
      if (typeof bg.ground.colorB === 'string') u.uB.value.copy(rawColor(bg.ground.colorB));
    }
    this.#applyDay();
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
        const cur = this.currentLevel ? levels[this.snap?.lv] : null; // (the level studio's time slider: the new time shows without a restart)
        if (cur) { this.currentLevel = cur; this.#applyDay(); }
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

  get shaderNames() { //      the shaders a block, bowl or table can use (not the water shaders)
    return Object.keys(shaderCode).filter((n) => shaderCode[n].type !== 'water');
  }

  get waterShaderNames() { //  the shaders the water of a bowl can use
    return Object.keys(shaderCode).filter((n) => shaderCode[n].type === 'water');
  }

  /** The parameters (uniforms with a default in a comment) of a shader: [{ name, type, color, def, min?, max? }]. */
  debugShaderParams(name) {
    return parseShaderParams(shaderCode[name]?.code ?? '');
  }

  /** While a parameter of the water is dragged: change the uniforms of the water that is drawn, without rebuilding anything. */
  debugLiveWater(defs) {
    const params = defs?.backgrounds?.[backgroundKeyOf(this.currentLevel)]?.water?.params ?? {};
    if (this.waterSel) this.waterSel.params = params;
    const apply = (m, bgParams = params) => {
      const own = defs?.materials?.[m.userData.materialKey]?.shaderParams ?? {}; // (a water block: the settings of its material win over those of the background)
      const all = { ...bgParams, ...(m.userData.materialKey ? own : {}) };
      if (m.userData.materialKey !== undefined && m.userData.materialKey !== null) m.uniforms.uOpacity.value = all.uBlockOpacity ?? WATER_BLOCK_OPACITY;
      for (const p of m.userData.waterParams) this.#setParam(m.uniforms[p.name], p, all[p.name]);
      m.userData.rebake?.(); // (a baked picture may depend on the parameters)
    };
    this.mainGroup?.traverse((o) => { if (o.material?.userData?.waterParams) apply(o.material); });
    this.waterBlockMats.forEach((m) => apply(m, params));
  }

  /** The name of the water shader the bowl of the level uses now ('' = the classic water): the water block uses it too. */
  get debugWaterShaderName() {
    return this.waterSel?.shader && shaderCode[this.waterSel.shader]?.type === 'water' ? this.waterSel.shader : '';
  }

  /** A small window with a sphere and a block in the material `{ shader, params }` (the Materials tab). update(entry) shows another version. */
  debugMaterialPreview(host) {
    return shaderPreview3d(host, (e) => {
      const ws = e.shader === 'waterBlock' && this.debugWaterShaderName ? shaderCode[this.debugWaterShaderName] : null;
      return ws
        ? this.#waterBlockMaterial(ws, { ...this.waterSel.params, ...e.params }, null, true)
        : this.#blockMaterial(e.shader, 0.3, THREE.FrontSide, null, true, null, e.params, null);
    });
  }

  /** While a setting of a block shader is dragged: change the uniforms of the blocks that are drawn, without rebuilding anything. */
  debugLiveBlocks(defs) {
    this.debugLiveWater(defs); // (water blocks)
    for (const m of this.blockMats) {
      const params = this.#paramsOfKey(defs, m.userData.materialKey); // ('@table' = the table of the background)
      for (const p of m.userData.blockParams) this.#setParam(m.uniforms[p.name], p, params[p.name]);
      m.userData.rebake?.(); // (a baked picture may depend on the settings; the same settings share one picture)
    }
  }

  /** The settings a material key stands for: a material, '@table', '@bowl:key' or '@model:key:part'. */
  #paramsOfKey(defs, key) {
    if (key === '@table') return defs?.backgrounds?.[backgroundKeyOf(this.currentLevel)]?.box?.shaderParams ?? {};
    if (key?.startsWith('@bowl:')) return defs?.bowls?.[key.slice(6)]?.shaderParams ?? {};
    if (key?.startsWith('@model:')) {
      const [, model, ...part] = key.split(':');
      return defs?.models?.[model]?.shaderParams?.[part.join(':')] ?? {};
    }
    return defs?.materials?.[key]?.shaderParams ?? {};
  }

  #setParam(u, p, v) {
    const val = paramValue(p, v);
    if (p.color) u.value.copy(rawColor(val));
    else if (p.def.length === 1) u.value = val;
    else u.value.set(...val);
  }

  // ── the shader studio (debug): what it needs from the view ──
  /** (There are no built-in shaders any more: all of them are in _shaders.js.) */
  get debugBuiltinNames() {
    return [];
  }

  /** The code of a built-in shader, the part you edit (what is in shaders.js, without the common part every shader starts with). */
  debugShaderBody(name) {
    return shaderCode[name]?.code ?? '';
  }

  /** The type ('opaque' | 'transparent' | 'refract') the built-in shader of that name has. */
  debugBuiltinType(name) {
    return shaderCode[name]?.type ?? 'opaque';
  }

  /**
   * Compile `code` (what comes after the common part) in a scratch WebGL context, without drawing anything.
   * @returns {{ ok: boolean, errors: { line: number, text: string }[] }} the lines are lines of `code` (line 1 = its first line)
   */
  debugCheckShader(code, type = 'opaque') {
    const gl = (this.scratchGl ??= document.createElement('canvas').getContext('webgl2')); // (WebGL 2 = GLSL ES 3.00: what the game's own context speaks)
    if (!gl) return { ok: true, errors: [] }; // (no way to check here: the game will say)
    const water = type === 'water';
    // the same few lines three.js puts above every shader (one line each, so that the line numbers can be worked out)
    const head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n#define varying in\nout highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n#define texture2D texture\nuniform vec3 cameraPosition;\n';
    const headLines = (head.match(/\n/g) ?? []).length;
    const src = head + (water ? waterFrag(code) : frag(code)).replace('precision highp float;', '');
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    const ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    const log = ok ? '' : gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    const errors = [];
    for (const m of log.matchAll(/ERROR:\s*\d+:(\d+):\s*(.*)/g)) errors.push({ line: Math.max(1, +m[1] - headLines - (water ? WATER_PRELUDE_LINES : PRELUDE_LINES)), text: m[2].trim() });
    if (!ok && !errors.length) errors.push({ line: 1, text: log.trim() || 'the shader does not compile' });
    return { ok, errors };
  }

  /** A small stand-alone window that shows a sphere and a block with a shader made from `{ code, type }`: see shaderPreview3d. */
  debugShaderPreview(host) {
    return shaderPreview3d(host, (entry) => (entry.type === 'water'
      ? this.#waterMaterial({ water: { color: this.bowlDef?.water?.color ?? '#004585', opacity: 1 } }, true, null, entry)
      : this.#blockMaterial('stone1', 0.3, THREE.FrontSide, null, true, entry)));
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
   * It turns slowly; drag to turn it yourself, right-drag (or shift-drag) to pan, wheel to zoom.
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
    const onDown = (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; cam.auto = false; canvas.setPointerCapture(e.pointerId); };
    const onMove = (e) => {
      if (!drag) return;
      if (drag.pan) { // right or middle button, or shift: slide the picture (the view's own right and up)
        const k = (cam.dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, canvas.clientHeight);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        cam.target.addScaledVector(right, -(e.clientX - drag.x) * k).addScaledVector(up, (e.clientY - drag.y) * k);
        drag = { x: e.clientX, y: e.clientY, pan: true };
        return;
      }
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
    const onMenu = (e) => e.preventDefault(); // (the right button pans)
    canvas.addEventListener('contextmenu', onMenu);
    raf = requestAnimationFrame(loop);

    return {
      /** The settings of the shaders changed (a slider is dragged): update the uniforms of the parts, without loading anything. */
      setParams: (def) => {
        group?.traverse((o) => {
          const m = o.material;
          if (!m?.userData?.paramList) return;
          const params = def.shaderParams?.[o.userData.part] ?? {};
          for (const p of m.userData.paramList) this.#setParam(m.uniforms[p.name], p, params[p.name]);
          m.userData.rebake?.();
        });
      },
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
          const mesh = new THREE.Mesh(p.geo, this.#blockMaterial(shader, (i * 0.37) % 1, THREE.DoubleSide, null, true, null, def.shaderParams?.[p.name], null));
          mesh.userData.part = p.name;
          group.add(mesh);
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
        canvas.removeEventListener('contextmenu', onMenu);
        if (group) group.traverse((o) => o.material?.dispose());
        renderer.dispose();
        renderer.forceContextLoss?.(); // (a browser only allows about 16 WebGL contexts and takes the OLDEST away: a closed window must give its own back)
      },
    };
  }

  /**
   * Debug: the performance overlay (top left of the page). `o` = { fps, calls, memory, gpu, passes } (each true / false; all false = the overlay is gone):
   *   fps      frames per second and the time a frame takes (and how much of it is spent in the drawing code of the page)
   *   calls    draw calls and triangles of the whole frame (all passes together)
   *   memory   what three.js keeps: geometries, textures, shader programs
   *   gpu      the time the GPU needs for the drawing (only on browsers that offer EXT_disjoint_timer_query_webgl2)
   *   passes   every pass of the frame (shadow map, reflection, background, glass, bakes ...): its target, draw calls, triangles and time
   */
  debugStats(o) {
    const on = !!o && Object.values(o).some(Boolean);
    const r = this.renderer;
    if (!on) {
      if (this.stats) {
        r.render = this.stats.render;
        THREE.Object3D.prototype.onBeforeRender = this.stats.hook;
        r.info.autoReset = true;
        this.stats.el.remove();
        this.stats.win?.remove();
        this.stats = null;
      }
      return;
    }
    if (!this.stats) {
      const el = document.createElement('pre');
      el.style.cssText = 'position:fixed;left:6px;top:6px;z-index:99999;margin:0;padding:6px 8px;border-radius:6px;background:rgba(10,14,24,.78);color:#cfe8ff;font:11px/1.35 ui-monospace,Consolas,monospace;pointer-events:none;white-space:pre;max-width:46ch';
      document.body.append(el);
      const s = { el, render: r.render, hook: THREE.Object3D.prototype.onBeforeRender, passes: [], frames: 0, t0: performance.now(), fps: 0, ms: 0, cpu: 0, last: performance.now(), shown: 0, frameCalls: 0, frameTris: 0, gpuMs: null, query: null, ext: null, opts: o, win: null, curPass: '', seq: 0, frame: { obj: new Map(), mat: new Map(), pass: new Map(), kind: new Map(), pk: new Map() }, smooth: { obj: new Map(), mat: new Map(), pass: new Map(), kind: new Map(), pk: new Map() }, tab: 'obj' };
      s.ext = r.getContext().getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null;
      r.info.autoReset = false; // (the game draws several times per frame: count them all, and start again every frame ourselves)
      const orig = r.render;
      r.render = (scene, camera) => { // note every pass
        const info = r.info.render;
        const c0 = info.calls;
        const t0 = info.triangles;
        const a = performance.now();
        const rt = r.getRenderTarget();
        const prev = s.curPass;
        s.curPass = `${++s.seq} ${rt ? `${rt.width}x${rt.height}` : 'screen'}`; // (draw calls made while this runs belong to this pass)
        try { orig.call(r, scene, camera); } finally { s.curPass = prev; }
        s.passes.push({ target: rt ? `${rt.width}x${rt.height}` : 'screen', calls: info.calls - c0, tris: info.triangles - t0, ms: performance.now() - a });
      };
      const nameOf = (obj) => { // the first name on the way up: a block, a model, the bowl, the table ...
        for (let p = obj; p; p = p.parent) if (p.name) return p.name;
        return obj.isSprite ? 'sprite' : `unnamed ${obj.geometry?.type ?? obj.type}`;
      };
      const add = (map, key, tris, id) => {
        const e = map.get(key) ?? { calls: 0, tris: 0, ids: new Set() };
        e.calls++;
        e.tris += tris;
        e.ids.add(id); // (how many different meshes: a block made of three parts is three)
        map.set(key, e);
      };
      THREE.Object3D.prototype.onBeforeRender = function (renderer, scene, camera, geometry, material) { // (three.js calls this once for every draw call, and once per render for the scene itself: that one is no draw call)
        if (this.isScene || !geometry) return;
        const tris = geometry ? (geometry.index ? geometry.index.count : geometry.attributes?.position?.count ?? 0) / 3 : 0;
        const label = nameOf(this);
        const kind = label.split(' ')[0];
        add(s.frame.obj, label, tris, this.id);
        add(s.frame.kind, kind, tris, this.id);
        add(s.frame.mat, material?.userData?.label ?? `${material?.type ?? '?'} of ${label}`, tris, this.id);
        add(s.frame.pass, s.curPass || '?', tris, this.id);
        add(s.frame.pk, `${s.curPass || '?'}  ${kind}`, tris, this.id);
      };
      this.stats = s;
    }
    const s = this.stats;
    s.opts = o;
    if (o.window && !s.win) this.#statsWindow(s);
    else if (!o.window && s.win) { s.win.remove(); s.win = null; }
  }

  /** The draggable window of the draw call profiler: where the draw calls of a frame come from (objects, kinds of objects, materials, passes). */
  #statsWindow(s) {
    const win = document.createElement('div');
    win.style.cssText = 'position:fixed;left:40px;top:110px;width:460px;height:340px;min-width:260px;min-height:140px;z-index:99998;display:flex;flex-direction:column;resize:both;overflow:hidden;background:rgba(14,19,32,.94);color:#d7e6ff;border:1px solid #3a4870;border-radius:8px;font:11px/1.4 ui-monospace,Consolas,monospace;box-shadow:0 6px 24px rgba(0,0,0,.4)';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:#243050;cursor:move;user-select:none;touch-action:none';
    const title = document.createElement('strong');
    title.textContent = 'Draw calls';
    title.style.flex = '1';
    bar.append(title);
    const tabs = { obj: 'objects', kind: 'kinds', mat: 'materials', pass: 'passes', pk: 'pass x kind', tg: 'targets' };
    const body = document.createElement('pre');
    body.style.cssText = 'margin:0;padding:6px 8px;overflow:auto;flex:1;white-space:pre';
    const btns = {};
    for (const [key, label] of Object.entries(tabs)) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:inherit;padding:1px 7px;border-radius:4px;border:1px solid #4a5a88;background:#1a2340;color:inherit;cursor:pointer';
      b.onclick = () => { s.tab = key; s.shown = 0; for (const [k2, b2] of Object.entries(btns)) b2.style.background = k2 === key ? '#3b5bb5' : '#1a2340'; };
      btns[key] = b;
      bar.append(b);
    }
    btns[s.tab].style.background = '#3b5bb5';
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'font:inherit;border:0;background:none;color:inherit;cursor:pointer;font-size:14px';
    close.onclick = () => { s.opts.window = false; this.onStatsClosed?.(); this.debugStats(s.opts); };
    bar.append(close);
    let drag = null;
    bar.addEventListener('pointerdown', (e) => { if (e.target.tagName === 'BUTTON') return; drag = { x: e.clientX - win.offsetLeft, y: e.clientY - win.offsetTop }; bar.setPointerCapture(e.pointerId); });
    bar.addEventListener('pointermove', (e) => { if (!drag) return; win.style.left = `${Math.max(0, e.clientX - drag.x)}px`; win.style.top = `${Math.max(0, e.clientY - drag.y)}px`; });
    bar.addEventListener('pointerup', () => { drag = null; });
    win.append(bar, body);
    win.body = body;
    document.body.append(win);
    s.win = win;
  }

  /** Every render target the game keeps (shadow map, reflection, blur, glass, baked pictures) and the memory it takes, estimated. */
  #targetsReport() {
    const list = [];
    const seen = new Set();
    const walk = (v, name, depth) => {
      if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return;
      seen.add(v);
      if (v.isWebGLRenderTarget) { list.push([name, v]); return; }
      for (const [k2, v2] of Object.entries(v)) walk(v2, `${name}.${k2}`, depth + 1);
    };
    for (const [key, v] of Object.entries(this.fx ?? {})) walk(v, key, 0);
    for (const e of bakeEntries) list.push([`baked picture`, e.rt]);
    const bytesOf = (t) => ({ [THREE.HalfFloatType]: 8, [THREE.FloatType]: 16 }[t?.type] ?? 4);
    let total = 0;
    const lines = ['render targets (memory is an estimate)', '        size   MB  name'];
    for (const [name, rt] of list) {
      const mips = rt.texture?.generateMipmaps ? 1.34 : 1;
      const mb = (rt.width * rt.height * (bytesOf(rt.texture) * mips + (rt.depthBuffer || rt.depthTexture ? 4 : 0))) / 1048576;
      total += mb;
      lines.push(`${`${rt.width}x${rt.height}`.padStart(12)} ${mb.toFixed(1).padStart(4)}  ${name}${rt.depthTexture ? ' (+ depth texture)' : ''}`);
    }
    lines.push(`total about ${total.toFixed(0)} MB, plus the textures and geometries (see Memory)`);
    return lines.join('\n');
  }

  #statsBegin(now) {
    const s = this.stats;
    s.ms += (now - s.last - s.ms) * 0.1; // (smoothed time between frames)
    s.last = now;
    this.renderer.info.reset();
    s.passes = [];
    s.seq = 0;
    for (const m of Object.values(s.frame)) m.clear();
    s.renderStart = now;
    const gl = this.renderer.getContext();
    if (s.opts.gpu && s.ext && !s.query) { s.query = gl.createQuery(); gl.beginQuery(s.ext.TIME_ELAPSED_EXT, s.query); s.querying = true; }
  }

  #statsEnd() {
    const s = this.stats;
    const now = performance.now();
    const gl = this.renderer.getContext();
    if (s.querying) { gl.endQuery(s.ext.TIME_ELAPSED_EXT); s.querying = false; }
    if (s.query && !s.querying && gl.getQueryParameter(s.query, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(s.ext.GPU_DISJOINT_EXT)) s.gpuMs = gl.getQueryParameter(s.query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(s.query);
      s.query = null;
    }
    s.cpu += (now - s.renderStart - s.cpu) * 0.1;
    if (s.win) { // the draw calls of this frame, smoothed over a few frames
      for (const name of Object.keys(s.frame)) {
        const sm = s.smooth[name];
        for (const [key, e] of s.frame[name]) {
          const cur = sm.get(key) ?? { calls: e.calls, tris: e.tris, meshes: e.ids.size };
          cur.calls += (e.calls - cur.calls) * 0.15;
          cur.tris += (e.tris - cur.tris) * 0.15;
          cur.meshes = e.ids.size;
          sm.set(key, cur);
        }
        for (const [key, cur] of sm) if (!s.frame[name].has(key)) { cur.calls *= 0.85; cur.tris *= 0.85; if (cur.calls < 0.05) sm.delete(key); }
      }
    }
    const info = this.renderer.info;
    s.frameCalls = info.render.calls;
    s.frameTris = info.render.triangles;
    if (now - s.shown < 250) return;
    s.shown = now;
    const o = s.opts;
    const L = [];
    if (o.fps) L.push(`${(1000 / Math.max(0.1, s.ms)).toFixed(0)} fps   frame ${s.ms.toFixed(1)} ms   drawing code ${s.cpu.toFixed(1)} ms`);
    if (o.gpu) L.push(s.ext ? `GPU ${s.gpuMs === null ? '...' : `${s.gpuMs.toFixed(1)} ms`}` : 'GPU timer: not offered by this browser');
    if (o.calls) L.push(`draw calls ${s.frameCalls}   triangles ${s.frameTris.toLocaleString()}   lines/points ${info.render.lines + info.render.points}`);
    if (o.memory) L.push(`geometries ${info.memory.geometries}   textures ${info.memory.textures}   programs ${info.programs?.length ?? '?'}`);
    if (o.passes) {
      L.push('passes:');
      s.passes.slice(0, 14).forEach((p, i) => L.push(` ${String(i + 1).padStart(2)} ${p.target.padEnd(10)} ${String(p.calls).padStart(4)} calls ${String(p.tris).padStart(8)} tri ${p.ms.toFixed(1).padStart(5)} ms`));
      if (s.passes.length > 14) L.push(` ... ${s.passes.length - 14} more`);
    }
    s.el.style.display = L.length ? '' : 'none';
    s.el.textContent = L.join('\n');
    if (s.win) {
      if (s.tab === 'tg') {
        s.win.body.textContent = this.#targetsReport();
      } else {
        const rows = [...s.smooth[s.tab]].sort((a, b) => b[1].calls - a[1].calls);
        const total = rows.reduce((t, [, e]) => t + e.calls, 0) || 1;
        const what = { obj: 'object', kind: 'kind of object', mat: 'material / shader', pass: 'pass (number, target)', pk: 'pass, kind of object' }[s.tab];
        const lines = [`per frame: ${s.frameCalls} draw calls, ${s.frameTris.toLocaleString()} triangles (sorted by draw calls)`, ` calls    %  meshes  tri/call  ${what}`];
        for (const [key, e] of rows.slice(0, 60)) lines.push(`${e.calls.toFixed(1).padStart(6)} ${(100 * e.calls / total).toFixed(0).padStart(4)}% ${String(e.meshes ?? '').padStart(6)} ${Math.round(e.tris / Math.max(0.01, e.calls)).toLocaleString().padStart(9)}  ${key}`);
        if (rows.length > 60) lines.push(`... ${rows.length - 60} more`);
        s.win.body.textContent = lines.join('\n');
      }
    }
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
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => { // a shader that does not compile in the game itself: say so (instead of a surface that silently does not show)
      const log = (gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(program) || 'does not compile').trim();
      this.#report(`a shader does not compile: ${log.split('\n').slice(0, 3).join(' | ')}`);
    };
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
    this.waterSel = bg.water ?? null; // (which water shader the bowl's water uses, and its parameters: chosen in the background)
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
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), (this.floorMat = this.#floorMaterial(bg, fog)));
      floor.name = 'floor';
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
      const table = new THREE.Mesh(new THREE.BoxGeometry(bg.box.w, th, bg.box.d), this.#blockMaterial(bg.box.shader, 0.7, THREE.FrontSide, null, false, null, bg.box.shaderParams, '@table'));
      table.name = 'table';
      table.position.set(0, this.groundY - th / 2, bg.box.z);
      main.add(table);
    }

    // the bowl: the profile turned around the vertical axis (flat bottom, rounded corners), or a model if the bowl has one
    const [wood, water] = this.#bowlMeshes(bowl, false, bowlKeyOf(this.currentLevel));
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
  #bowlMeshes(bowl, plain = false, bowlKey = null) {
    const { inner, outer } = bowlProfile(BOWL_SEGS, bowl);
    const half = (pts) => pts.slice(BOWL_SEGS / 2).map(([x, y]) => new THREE.Vector2(Math.abs(x), y)); // from the middle of the flat bottom up to the rim
    const profile = [...half(outer), ...half(inner).reverse()]; // the normals come out facing away from the wood
    const wood = new THREE.Mesh(this.#squareLathe(profile, bowl), this.#blockMaterial(bowl.shader, 0.35, THREE.DoubleSide, null, plain, null, bowl.shaderParams, plain || !bowlKey ? null : `@bowl:${bowlKey}`));
    wood.name = 'bowl';
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
    const sides = new THREE.Mesh(this.#squareLathe(wp, bowl, 64), this.#waterMaterial(bowl, plain, null)); // (the inside face of the water: fewer steps)
    sides.name = 'bowl water sides';
    const GRID = 0.6; // world units between the points of the surface: the smallest waves are about 6 units long, so a finer grid only costs triangles
    const gridGeo = new THREE.PlaneGeometry(rw * 2.02, rz * 2.02, Math.max(12, Math.ceil(rw * 2.02 / GRID)), Math.max(8, Math.ceil(rz * 2.02 / GRID)));
    gridGeo.rotateX(-Math.PI / 2);
    const surface = new THREE.Mesh(gridGeo, this.#waterMaterial(bowl, plain, foot));
    surface.name = 'bowl water surface';
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
  #waterMaterial(bowl, plain = false, foot = null, draft = null) {
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
    const uniforms = {
        uColor: { value: rawColor(bowl.water.color) }, uOpacity: { value: bowl.water.opacity }, uTime: this.uTime, ...u,
        uSky: { value: plain ? new THREE.Color('#cfd6e4') : this.mistNow }, // the colour of the sky (the mist, tinted by the time of day): the water mirrors it
        uGrid: { value: foot ? 1 : 0 },
        uFoot: { value: new THREE.Vector3(foot?.rw ?? 1, foot?.rz ?? 1, foot?.n ?? 2) },
    };
    const vertexShader = /* glsl */ `
varying vec3 vW;
varying vec3 vWN;
varying vec2 vUv; //  for the water shaders of _shaders.js: about 0..1 across the bowl
varying vec3 vPos; // world position / 20
uniform float uTime;
uniform float uGrid;
${WAVES}
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  if (uGrid > 0.5) w.y += waveH(w.xz, uTime);
  vW = w.xyz;
  vUv = w.xz / 40.0 + 0.5;
  vPos = w.xyz * 0.05;
  vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
    const sel = this.waterSel ?? {}; //  the water shader and its parameters come from the background of the level (see #buildWorld)
    const ws = draft ?? (sel.shader && shaderCode[sel.shader]?.type === 'water' ? shaderCode[sel.shader] : null);
    if (ws) return this.#customWaterMaterial(ws.code, draft ? {} : sel.params, uniforms, vertexShader);
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
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
uniform vec3 uSky;
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
  // the sky: the water mirrors its colour (the horizon is the mist, higher up it is a little bluer and darker), most at a low angle, and a bit even head-on
  vec3 R = reflect(-V, N);
  vec3 skyCol = mix(uSky, uAmbSky * 1.3 + uSky * 0.35, clamp(R.y, 0.0, 1.0) * 0.6);
  float sk = (0.14 + 0.6 * fres) * top;
  col = mix(col, skyCol, sk);
  alpha = mix(alpha, 1.0, sk * 0.35);
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

  /** The water of a bowl drawn by a water shader of _shaders.js (see WATER_PRELUDE in shaders.js); its parameters come from the bowl's water.params. */
  /** The water of the bowl, drawn on a block (the 'waterBlock' material): the same shader and settings as the water of the bowl, seen from the front. */
  #waterBlockMaterial(ws, params, materialKey = null, plain = false) {
    const bowl = this.bowlDef ?? { water: { color: '#004585', opacity: 0.55 } };
    const uniforms = {
      ...(plain ? { uRefl: { value: null }, uReflMat: { value: new THREE.Matrix4() }, uReflStr: { value: 0 }, ...this.#plainLight() } : { ...this.waterU, ...this.shadowU }), // (the preview windows are other WebGL contexts)
      uColor: { value: rawColor(bowl.water.color) }, uOpacity: { value: params?.uBlockOpacity ?? WATER_BLOCK_OPACITY }, uTime: this.uTime, uSky: { value: plain ? new THREE.Color('#cfd6e4') : this.mistNow },
      uGrid: { value: 0 }, uFoot: { value: new THREE.Vector3(1, 1, 2) },
      uGlow: { value: new THREE.Vector3() }, uBad: { value: 0 }, uReveal: { value: 1 }, uCausOn: { value: 1 }, uCausInward: { value: 0 },
    };
    const vertexShader = /* glsl */ `
varying vec3 vW;
varying vec3 vWN;
varying vec2 vUv;
varying vec3 vPos;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vUv = w.xy / 40.0 + 0.5; //  seen from the front (the water of the bowl is seen from above: x, z)
  vPos = w.xyz * 0.05;
  vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
    const mat = this.#customWaterMaterial(ws.code, params, uniforms, vertexShader, true);
    mat.userData.materialKey = materialKey;
    return mat;
  }

  #customWaterMaterial(code, params, uniforms, vertexShader, block = false) {
    const list = parseShaderParams(code);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader,
      fragmentShader: block // (the water drawn on a BLOCK: it also dissolves in (uReveal), glows when held (uGlow) and turns red where it cannot be dropped (uBad), like every block)
        ? waterFrag(code)
          .replace('precision highp float;', 'precision highp float;\nuniform float uReveal;\nuniform float uBad;\nuniform vec3 uGlow;')
          .replace('gl_FragColor.a *= uOpacity;', 'gl_FragColor.a *= uOpacity * uReveal;\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.2, 0.2), uBad * 0.55) + uGlow * 0.28;')
        : waterFrag(code),
      transparent: true,
      depthWrite: false,
      side: block ? THREE.FrontSide : THREE.DoubleSide,
      extensions: { derivatives: true },
    });
    mat.uniforms.uNoiseTex = { value: noiseTexture() };
    mat.uniforms.uSeed = { value: 0 };
    mat.uniforms.uBake = { value: null }; // (a shader without bake() never reads it)
    mat.uniforms.uResolution = { value: new THREE.Vector2(1, 1) };
    for (const p of list) {
      mat.uniforms[p.name] = { value: p.color ? new THREE.Color() : p.def.length === 1 ? 0 : new THREE[`Vector${p.def.length}`]() };
      this.#setParam(mat.uniforms[p.name], p, params?.[p.name]);
    }
    if (hasBake(code)) attachBake(mat, { code, fragment: waterFrag(code, true), vertex: BAKE_VERTEX_WATER }, list);
    mat.userData.label = `water shader (${block ? 'block' : 'bowl'})`;
    mat.userData.waterParams = list; // (debugLiveWater changes their values while a slider is dragged)
    if (block) {
      this.waterBlockMats.add(mat);
      mat.addEventListener('dispose', () => this.waterBlockMats.delete(mat));
    }
    return mat;
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
    group.name = `model ${inst.model}`;
    parts.forEach((p, i) => {
      const shader = def.shaders?.[p.name] ?? def.shader ?? 'stone1';
      const mat = this.#blockMaterial(shader, (i * 0.37) % 1, THREE.DoubleSide, fog, false, null, def.shaderParams?.[p.name], `@model:${inst.model}:${p.name}`);
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
  #squareLathe(profile, bowl, segs = 96) {
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
  /** 'opaque' | 'transparent' | 'refract': what the blocks of this shader need (a shader of the shader studio brings its own type; a replaced built-in keeps the old one). */
  #shaderType(name) {
    return shaderCode[name]?.type ?? 'opaque';
  }

  /** The source of a shader: its entry in _shaders.js. */
  #fragmentOf(name) {
    return frag((shaderCode[name] ?? shaderCode.stone1)?.code ?? 'void main() { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); }'); // (an unknown name looks like stone1)
  }

  #blockMaterial(shaderName, seed, side = THREE.FrontSide, fog = null, plain = false, draft = null, params = null, materialKey = null) {
    const ws = !draft && shaderName === 'waterBlock' && this.waterSel?.shader && shaderCode[this.waterSel.shader]?.type === 'water' ? shaderCode[this.waterSel.shader] : null;
    if (ws) return this.#waterBlockMaterial(ws, { ...this.waterSel.params, ...params }, materialKey, plain); // (the water block looks like the water of the bowl; the settings of the material win)
    const type = draft ? draft.type ?? 'opaque' : this.#shaderType(shaderName); // (`draft` = { code, type } of a shader that is being edited: the preview of the shader studio)
    const transparent = type !== 'opaque';
    const mat = new THREE.ShaderMaterial({
      vertexShader: deformShaders.has(shaderName) ? waveVertexShader : vertexShader,
      fragmentShader: draft ? frag(draft.code) : this.#fragmentOf(shaderName),
      uniforms: {
        uTime: this.uTime,
        uSeed: { value: seed },
        uGlow: { value: new THREE.Vector3() },
        uBad: { value: 0 },
        uQuality: this.qualityU,
        uAA: this.aaU,
        uNoiseTex: { value: noiseTexture() },
        uShadowOff: { value: 0 },
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
      extensions: { derivatives: true }, // (the cheap bump map reads the difference between neighbouring pixels)
    });
    // the settings of the shader: uniforms it declares with a default in a comment (see parseShaderParams); the values come from the material
    const list = parseShaderParams(draft ? draft.code : shaderCode[shaderName]?.code ?? '');
    for (const p of list) {
      mat.uniforms[p.name] = { value: p.color ? new THREE.Color() : p.def.length === 1 ? 0 : new THREE[`Vector${p.def.length}`]() };
      this.#setParam(mat.uniforms[p.name], p, params?.[p.name]);
    }
    const bakeCode = draft ? draft.code : shaderCode[shaderName]?.code ?? '';
    if (hasBake(bakeCode)) attachBake(mat, { code: bakeCode, fragment: frag(bakeCode, true), vertex: BAKE_VERTEX_BLOCK }, list);
    mat.userData.label = draft ? 'draft' : shaderName;
    mat.userData.paramList = list;
    if (list.length && materialKey) {
      mat.userData.blockParams = list;
      mat.userData.materialKey = materialKey;
      this.blockMats.add(mat);
      mat.addEventListener('dispose', () => this.blockMats.delete(mat));
    }
    return mat;
  }

  /**
   * Rounded geometry for each part of a shape (or for its single visual outline, see plus1). Every block has the same depth.
   * `fine` = every triangle cut into 9 (for blocks whose vertex shader moves the surface, like the water block).
   */
  #geometries(key, fine = false) {
    const ck = fine ? `${key}:fine` : key;
    let g = this.geoCache.get(ck);
    if (g) return g;
    const shape = getShape(key);
    g = shapeOutlines(shape, tuning.mergeParts !== false).map((o) => {
      const geo = roundedPrism(o.pts, DEPTH, edgeRadius(), o.holes ?? []);
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
      g.w = w;
      if (g.out) continue;
      if (here.has(g.id) || !want.some(([id]) => id === g.id)) { // it became a block (or the level changed under it): it fades away
        if (!g.out) { g.out = true; g.t = 0; }
        const row = s.tbl.find((r) => r[0] === g.id);
        if (row) g.spot = row[3]; //                          (while it fades it slides to the place of its block)
      }
      g.w = w;
    }
    for (const [id, , spot] of want) { // the row closed up: an outline that is still to come moves one place along
      const g = this.ghosts.find((x) => x.id === id && !x.out);
      if (g && spot >= 0) g.spot = spot;
    }
    for (const [id, si, spot] of want) {
      if (this.ghosts.some((g) => g.id === id) || !(spot >= 0)) continue;
      const shapeKey = SHAPE_KEYS[si];
      const shape = getShape(shapeKey);
      const mat = this.#blockMaterial('outline', (id * 0.37 + 0.1) % 1, THREE.DoubleSide);
      Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); // (on top of the table, never flickering with it)
      const group = new THREE.Group();
      group.name = 'ghost outline';
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
      const g = { id, spot, w, shapeKey, group, geos, mat, t: first ? GHOST_IN : reuse ? -GHOST_OUT : 0, out: false };
      mat.uniforms.uReveal.value = first ? 1 : 0;
      group.visible = first;
      this.scene.add(group);
      this.ghosts.push(g);
    }
  }

  /** Fade the outlines in and out (every frame). */
  #animateGhosts(dt) {
    for (const g of this.ghosts) {
      const px = slotPos(g.spot, g.w, g.shapeKey, this.groundY).x; // slides along when the row closes up
      g.group.position.x += (px - g.group.position.x) * (1 - Math.exp(-4 * dt));
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
    const mat = this.#blockMaterial(shaderName, (id * 0.6180339) % 1, THREE.FrontSide, null, false, null, materials[MATERIAL_KEYS[mi]].shaderParams, MATERIAL_KEYS[mi]);

    if (opts.table) mat.uniforms.uCausOn.value = 0; // (waiting on the table: no caustics)
    const group = new THREE.Group();
    group.name = `block ${MATERIAL_KEYS[mi]} ${shapeKey}`;
    for (const { geo } of this.#geometries(shapeKey, deformShaders.has(shaderName))) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.id = id;
      if (this.#shaderType(shaderName) !== 'opaque') mesh.renderOrder = 3;
      if (this.#shaderType(shaderName) === 'refract') mesh.layers.set(2); // layer 2 = glass: drawn in a pass of its own, after a copy of the picture has been made (#renderAll)
      group.add(mesh);
    }
    const zone = materials[MATERIAL_KEYS[mi]].noBuild;
    const extra = [];
    const extraGeos = [];
    if (zone) { // a NO-BUILD ZONE: the see-through red inside (the block itself) and a bright red chalk outline on its front
      group.children.forEach((m) => m.layers.set(1)); // (layer 1 = seen by the camera, but no shadows)
      const shape = getShape(shapeKey);
      const line = NO_BUILD_LINE; // the same thickness for every zone
      const lineMat = this.#blockMaterial('noBuildLine', (id * 0.37 + 0.1) % 1, THREE.DoubleSide);
      Object.assign(lineMat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      extra.push(lineMat);
      for (const o of shapeOutlines(shape, tuning.mergeParts !== false)) {
        const geo = outlineRibbon(o.pts, o.holes ?? [], line);
        extraGeos.push(geo);
        const mesh = new THREE.Mesh(geo, lineMat); // (one line, in the middle of the zone's depth)
        mesh.position.z = 0;
        mesh.layers.set(1);
        mesh.renderOrder = 4;
        group.add(mesh);
      }
    }
    this.scene.add(group);

    // blocks with a stack limit (glass) carry a lamp: green = nothing on it, orange = something, red = at the limit (one more breaks it)
    const limit = materials[MATERIAL_KEYS[mi]].stackLimit;
    let dot = null;
    if (limit !== undefined && !materials[MATERIAL_KEYS[mi]].noLamp) {
      const sh = getShape(shapeKey);
      const r0 = LAMP_RADIUS;
      const same = lookSameWhenTurned(sh);
      const spot = sh.lamp ? { x: sh.lamp[0], y: sh.lamp[1], r: r0 } : same ? { x: 0, y: 0, r: r0 } : lampSpot(sh, r0); // (a block that looks the same turned round has it in the middle: it does not move when you turn the block. Any other: near the top, but on the block)
      dot = new THREE.Mesh(this.dotGeo, new THREE.MeshBasicMaterial({ color: LAMP[0] }));
      dot.name = 'stack lamp';
      dot.scale.set(spot.r, spot.r, 1);
      dot.position.set(spot.x, spot.y, DEPTH / 2 + 0.04);
      dot.userData.id = id;
      group.add(dot);
    }

    const v = {
      glass: this.#shaderType(shaderName) === 'refract',
      dot, limit, load: -1, // (limit also marks a block that shatters, with or without a lamp)
      id, group, mats: [mat, ...extra], extraGeos, marker: null, size: getShape(shapeKey), shapeKey,
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
      mesh.name = 'glass shard';
      const size = 0.35 + Math.random() * 0.7;
      mesh.scale.set(size, size * (0.4 + Math.random() * 0.8), size * 0.4);
      mesh.position.set(p.x + (Math.random() - 0.5) * v.size.w, p.y + (Math.random() - 0.5) * v.size.h, p.z);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.scene.add(mesh);
      this.shards.push({ mesh, vx: (Math.random() - 0.5) * 14, vy: 3 + Math.random() * 9, vz: (Math.random() - 0.2) * 8, spin: (Math.random() - 0.5) * 12, life: 1.4 });
    }
  }

  /** Soft glow and ring textures for the explosion (drawn once on a canvas). */
  #explosionTextures() {
    if (this.fxTex) return this.fxTex;
    const make = (draw) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      draw(cv.getContext('2d'));
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const glow = make((g) => {
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.25, 'rgba(255,255,255,0.75)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.22)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    });
    const ring = make((g) => {
      const gr = g.createRadialGradient(64, 64, 34, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.72, 'rgba(255,255,255,0.95)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    });
    return (this.fxTex = { glow, ring });
  }

  /**
   * Fuel and oxidizer touched: a big, unmistakable explosion at (x, y) of the play plane: a white flash that fills the screen for a moment, a fireball,
   * a shockwave ring, sparks that fly out and fall, dark smoke, and a shake of the camera.
   */
  #explosion(x, y, chain = false) {
    const tex = this.#explosionTextures();
    const z = 6; // a bit in front of the play plane
    const sc = chain ? 0.7 : 1; //   an explosion that came from another one is a bit smaller, without the flash of the screen
    const add = (map, color, life, from, to, opacity, step) => {
      const mat = new THREE.SpriteMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity });
      const sprite = new THREE.Sprite(mat);
      sprite.name = 'effect sprite';
      sprite.position.set(x, y, z);
      sprite.renderOrder = 60;
      this.frontScene.add(sprite);
      const fx = { sprite, t: 0, life, step: (k) => { const e = 1 - (1 - k) * (1 - k); sprite.scale.setScalar((from + (to - from) * e) * sc); mat.opacity = opacity * (1 - k) ** 1.5; step?.(k); } };
      this.fxList.push(fx);
      return fx;
    };
    add(tex.glow, '#fffbe0', 0.35, 6, 46, 1);                    // the white-hot flash
    add(tex.glow, '#ff8a1a', 0.8, 5, 34, 1);                     // the fireball
    add(tex.glow, '#ff3b0a', 1.1, 8, 40, 0.7);                   // its red edge
    add(tex.ring, '#ffe2a0', 0.6, 3, 56, 0.95);                  // the shockwave
    add(tex.ring, '#9fdcff', 0.8, 2, 40, 0.7);                   // a second, bluer one (the oxidizer)
    for (let i = 0; i < 44; i++) { // sparks
      const a = Math.random() * Math.PI * 2;
      const sp = 14 + Math.random() * 34;
      const life = 0.7 + Math.random() * 0.8;
      const hot = Math.random() < 0.5;
      const size = 0.9 + Math.random() * 1.8;
      const vx = Math.cos(a) * sp;
      const vy = Math.sin(a) * sp + 6;
      const fx = add(tex.glow, hot ? '#ffd24a' : '#ff6a1a', life, size, size * 0.4, 1);
      fx.vx = vx; fx.vy = vy; fx.grav = true;
    }
    for (let i = 0; i < 12; i++) { // smoke (normal blending, so it is dark)
      const mat = new THREE.SpriteMaterial({ map: tex.glow, color: '#2a2220', transparent: true, depthWrite: false, depthTest: false, opacity: 0.55 });
      const sprite = new THREE.Sprite(mat);
      sprite.name = 'shadow blob';
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 5;
      sprite.position.set(x + Math.cos(a) * r, y + Math.sin(a) * r, z - 0.5);
      sprite.renderOrder = 55;
      this.frontScene.add(sprite);
      const size = 7 + Math.random() * 8;
      this.fxList.push({ sprite, t: 0, life: 1.6 + Math.random() * 0.8, vx: (Math.random() - 0.5) * 6, vy: 3 + Math.random() * 5, step: (k) => { sprite.scale.setScalar(size * (0.5 + k)); mat.opacity = 0.55 * (1 - k) * Math.min(1, k * 8); } });
    }
    if (this.root && !chain) { // the whole screen flashes
      const flash = el('div', { class: 'bb-boom' });
      this.root.append(flash);
      requestAnimationFrame(() => { flash.style.opacity = '0'; });
      setTimeout(() => flash.remove(), 700);
    }
    this.shakeT = chain ? Math.max(this.shakeT, 0.35) : 0.6;
  }

  /** Move the explosion effects along (every frame). */
  #animateExplosions(dt) {
    for (let i = this.fxList.length - 1; i >= 0; i--) {
      const f = this.fxList[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      if (f.vx !== undefined) {
        if (f.grav) f.vy -= 38 * dt;
        f.sprite.position.x += f.vx * dt;
        f.sprite.position.y += f.vy * dt;
      }
      f.step(k);
      if (k >= 1) {
        f.sprite.removeFromParent();
        f.sprite.material.dispose();
        this.fxList.splice(i, 1);
      }
    }
    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dt);
  }

  #clearExplosions() {
    for (const f of this.fxList) {
      f.sprite.removeFromParent();
      f.sprite.material.dispose();
    }
    this.fxList = [];
    this.shakeT = 0;
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
    v.extraGeos?.forEach((g) => g.dispose());
    v.mats.forEach((m) => m.dispose());
    v.dot?.material.dispose();
    this.#dropMarker(v);
  }

  /** Another player's held block carries a small dot in their seat colour, so you can tell who holds what (the block itself is never tinted). */
  // ── graphics menu: what a player can switch off to make the game run better ──
  #loadGfx() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(GFX_STORE) ?? 'null'); } catch { /* ignore */ }
    const g = { preset: 'medium', ...GFX_PRESETS.medium };
    if (saved && typeof saved === 'object') {
      if (saved.preset === 'custom' || GFX_PRESETS[saved.preset]) g.preset = saved.preset;
      if (GFX_PRESETS[g.preset]) Object.assign(g, GFX_PRESETS[g.preset]);
      if (g.preset === 'custom') {
        if ([0, 1, 2].includes(saved.detail)) g.detail = saved.detail;
        if ([0, 1, 2, 3].includes(saved.filter)) g.filter = saved.filter;
        for (const k of ['shadows', 'reflection', 'blur', 'refraction']) if (typeof saved[k] === 'boolean') g[k] = saved[k];
        if (typeof saved.scale === 'number' && saved.scale >= 0.4 && saved.scale <= 1) g.scale = saved.scale;
      }
    }
    this.gfx = g;
  }

  /** Use the settings: the surface detail, the effects that are switched off, the resolution. */
  #applyGfx(resize = true) {
    const g = this.gfx;
    this.qualityU.value = g.detail;
    this.aaU.value = [0, 1, 1.5, 2][g.filter] ?? 1;
    if (this.fx?.reflRT) { this.fx.reflRT.dispose(); this.fx.reflRT = null; } // (made again with the new texture filtering)
    for (const k of ['shadows', 'reflection', 'blur', 'refraction']) this.debugFx(k, g[k]);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * g.scale);
    if (resize) this.#resize();
    try { localStorage.setItem(GFX_STORE, JSON.stringify(g)); } catch { /* ignore */ }
  }

  #buildGfx() {
    const g = this.gfx;
    const refs = {};
    const set = (patch) => { // one setting changed by hand: the preset becomes "custom"
      Object.assign(g, patch, { preset: 'custom' });
      refs.preset.value = 'custom';
      this.#applyGfx();
    };
    const select = (options, value, onchange) => {
      const e = el('select');
      for (const [v, l] of options) e.append(el('option', { value: String(v) }, l));
      e.value = String(value);
      e.addEventListener('change', () => onchange(e.value));
      return e;
    };
    const check = (key, label) => {
      const e = el('input', { type: 'checkbox' });
      e.checked = g[key];
      e.addEventListener('change', () => set({ [key]: e.checked }));
      refs[key] = e;
      return el('label', { class: 'bb-gfx-row' }, el('span', {}, label), e);
    };
    refs.preset = select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['custom', 'Custom']], g.preset, (v) => {
      if (!GFX_PRESETS[v]) return;
      Object.assign(g, GFX_PRESETS[v], { preset: v });
      refs.detail.value = String(g.detail);
      refs.filter.value = String(g.filter);
      refs.scale.value = String(g.scale);
      for (const k of ['shadows', 'reflection', 'blur', 'refraction']) refs[k].checked = g[k];
      this.#applyGfx();
    });
    refs.detail = select([[0, 'Flat'], [1, 'Roughness'], [2, 'Roughness and bumps']], g.detail, (v) => set({ detail: +v }));
    refs.filter = select([[0, 'Off'], [1, 'Trilinear'], [2, 'Anisotropic 4x'], [3, 'Anisotropic 16x']], g.filter, (v) => set({ filter: +v }));
    refs.scale = select([[0.6, '60%'], [0.75, '75%'], [0.85, '85%'], [1, '100%']], g.scale, (v) => set({ scale: +v }));
    this.gfxPanel = el('div', { class: 'bb-gfx' },
      el('div', { class: 'bb-gfx-title' }, 'Graphics'),
      el('label', { class: 'bb-gfx-row' }, el('span', {}, 'Preset'), refs.preset),
      el('label', { class: 'bb-gfx-row' }, el('span', {}, 'Surface detail'), refs.detail),
      el('label', { class: 'bb-gfx-row' }, el('span', {}, 'Texture filtering'), refs.filter),
      el('label', { class: 'bb-gfx-row' }, el('span', {}, 'Resolution'), refs.scale),
      check('shadows', 'Shadows'), check('reflection', 'Water reflections'), check('blur', 'Background blur'), check('refraction', 'Glass bending'),
      el('div', { class: 'bb-gfx-hint' }, 'If the game runs badly, pick Low.'));
    const btn = el('button', { type: 'button', class: 'bb-btn bb-gfx-btn', title: 'Graphics settings' }, 'Graphics');
    btn.addEventListener('click', () => this.gfxPanel.classList.toggle('bb-show'));
    this.root.append(btn, this.gfxPanel);
  }

  /** Your hand: closed while a block is in it, pointing over a block you can pick up, open otherwise. */
  #syncCursor() {
    if (!this.hands) return;
    const kind = this.#carrying() ? 'fist' : this.renderer.domElement.classList.contains('bb-grab') ? 'point' : 'open';
    if (kind === this.handCursorNow) return;
    this.handCursorNow = kind;
    this.renderer.domElement.style.cursor = this.hands[kind];
  }

  /** The picture of a hand (kind: open / point / fist) in one colour, made once (it shows where another player's pointer is). */
  #handTexture(kind, color) {
    const key = `${kind}|${color}`;
    let t = this.handTex.get(key);
    if (!t) {
      t = new THREE.Texture();
      t.colorSpace = THREE.SRGBColorSpace;
      handCanvas(kind, color, 128, (c) => { t.image = c; t.needsUpdate = true; }); // (it appears as soon as the SVG has loaded)
      this.handTex.set(key, t);
    }
    return t;
  }

  /**
   * The hands of the other players. They are drawn as pictures that always have the size of your own cursor (so a hand is as big as yours, whatever
   * the zoom), where the pointer of the player is (a point of the play plane), and they glide there between the messages.
   */
  #updateHands(dt) {
    const cu = this.snap?.ph === PHASE.MENU ? null : this.snap?.cu;
    const held = new Set();
    for (const v of this.bodyViews.values()) if (v.st === BODY.HELD || v.st === BODY.HELD_BAD) held.add(v.owner);
    const size = (CURSOR_SIZE * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.renderer.domElement.clientHeight);
    const k = 1 - Math.exp(-dt * 25);
    for (const [slot, h] of this.handViews) {
      if (cu?.[slot] && slot !== this.ctx.me.slot) continue;
      h.sprite.removeFromParent();
      h.sprite.material.dispose();
      this.handViews.delete(slot);
    }
    for (const [slot, c] of Object.entries(cu ?? {})) {
      const sl = +slot;
      if (sl === this.ctx.me.slot) continue;
      const kind = held.has(sl) ? 'fist' : c[2] === 2 ? 'open' : c[2] === 1 ? 'point' : 'open'; // (a fist without a block in it is a stale message)
      const color = this.#colorOf(sl);
      let h = this.handViews.get(sl);
      if (!h) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, sizeAttenuation: false }));
        sprite.renderOrder = 10;
        this.frontScene.add(sprite);
        h = { sprite, key: '', x: c[0], y: c[1] };
        this.handViews.set(sl, h);
      }
      const key = `${kind}|${color}`;
      if (h.key !== key) {
        h.key = key;
        h.sprite.material.map = this.#handTexture(kind, color);
        h.sprite.material.needsUpdate = true;
        const [hx, hy] = handHot(kind);
        h.sprite.center.set(hx / 32, 1 - hy / 32); // (the hot spot of the hand is at the pointer)
      }
      h.x += (c[0] - h.x) * k;
      h.y += (c[1] - h.y) * k;
      h.sprite.position.set(h.x, h.y, 0);
      h.sprite.scale.set(size, size, 1);
    }
  }

  #dropMarker(v) {
    if (!v.marker) return;
    v.marker.removeFromParent();
    v.marker.material.dispose();
    v.marker = null;
  }

  #clearViews() {
    this.#clearShards();
    this.#clearExplosions();
    this.exSeen.clear();
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
      this.done.add(levelId(s.lv));
      saveDone(this.done);
      this.#markDone();
    }
    if (ph === PHASE.MENU) this.#clearPlayView();
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
    return { x: v.tx, y: v.ty, z: PLAY_Z + (v.zoff ?? 0), s: 1, a: v.ta, tl: 1 };
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
    const inWorld = (k) => levels.map((lv, i) => [lv, i]).filter(([lv]) => worldKeyOf(lv) === k);
    const all = Object.keys(worlds);
    const keys = all.filter((k) => inWorld(k).length > 0); // worlds without any level are not shown
    this.worldKeys = keys.length ? keys : all.slice(0, 1);
    if (!this.worldKeys.includes(this.worldKey)) this.worldKey = this.worldKeys[0];
    this.worldBtns = this.worldKeys.map((k) => el('button', {
      class: `bb-world${k === this.worldKey ? ' bb-on' : ''}${inWorld(k).length && inWorld(k).every(([, i]) => this.done.has(levelId(i))) ? ' bb-complete' : ''}`,
      onclick: () => { this.worldKey = k; this.#buildCards(); },
    }, `${worlds[k].name} (${inWorld(k).length})`)); // (the number of levels in it)
    this.worldsEl.replaceChildren(...this.worldBtns);
    this.worldsEl.classList.toggle('bb-hide', this.worldKeys.length < 2);
    const own = inWorld(this.worldKey);
    const head = el('div', { class: 'bb-row bb-row-head' },
      el('span', { class: 'bb-col-name' }, 'Name'), el('span', { class: 'bb-col-type' }, 'Type'),
      el('span', { class: 'bb-col-diff' }, 'Difficulty'), el('span', { class: 'bb-col-done' }, 'Beaten'));
    this.cards = own.map(([lv, i]) =>
      el(
        'button',
        { class: `bb-row bb-card bb-d-${lv.difficulty}`, 'data-lv': String(i), disabled: this.spectator, onclick: () => !this.spectator && this.ctx.sendInput({ start: i }) },
        el('span', { class: 'bb-col-name' }, lv.name),
        el('span', { class: 'bb-col-type' }, lv.type ?? 'normal'), // (levels get types later: for now they are all normal)
        el('span', { class: 'bb-col-diff' }, lv.difficulty),
        el('span', { class: 'bb-col-done bb-done', title: 'Beaten', 'aria-label': 'Beaten' },
          svg('svg', { viewBox: '0 0 16 16', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg('path', { d: 'M3 8.5l3.2 3.2L13 4.8' }))),
      ));
    this.cardsEl.replaceChildren(el('div', { class: 'bb-table' }, ...(this.cards.length ? [head, ...this.cards] : [el('p', { class: 'bb-empty' }, 'No levels in this world yet.')])));
    this.#markDone();
  }

  #markDone() {
    this.cards.forEach((c) => c.classList.toggle('bb-complete', this.done.has(levelId(+c.dataset.lv))));
    (this.worldKeys ?? []).forEach((k, n) => {
      const own = levels.map((lv, i) => [lv, i]).filter(([lv]) => worldKeyOf(lv) === k);
      this.worldBtns[n]?.classList.toggle('bb-complete', own.length > 0 && own.every(([, i]) => this.done.has(levelId(i))));
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

  /** Everything that belongs to playing a level (the HUD, the countdown, the result) is switched off: the list of levels and the level share no visual state. */
  #clearPlayView() {
    this.cdEl.classList.remove('bb-show');
    this.dots.forEach((d) => d.classList.remove('bb-on'));
    this.hud.classList.add('bb-hide');
    this.result.classList.remove('bb-show', 'bb-won');
  }

  #updateHud(s) {
    this.menuSub.textContent = this.spectator ? 'Watching: the players are choosing a level…' : 'Choose a level';
    this.cards.forEach((c) => (c.disabled = this.spectator));
    this.hintEl.textContent = this.spectator
      ? 'Spectating'
      : 'Press a block on the table, drag it above the bowl and let go to drop it (red = not here, it goes back) · Q / E or mouse wheel turns it by 45° · right-click or X puts it back · drag the background to turn the camera, wheel zooms, right-drag moves (C resets)';

    const playing = s.ph !== PHASE.MENU;
    this.hud.classList.toggle('bb-hide', !playing);
    if (!playing) { this.#clearPlayView(); return; } // (the list of levels shows nothing of the level that was just played)
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
    if (this.stats) this.#statsBegin(now);
    if (this.freeCam) this.#applyFreeCam();

    // the block we hold keeps following the pointer with its grab offset, which melts away as the block comes back into the play area
    if (this.#carrying() && this.ptr) {
      const { x, y } = this.local;
      this.#follow();
      if (Math.abs(this.local.x - x) > 0.001 || Math.abs(this.local.y - y) > 0.001) this.#sendMove(now);
    }

    const TAU = Math.PI * 2;
    const draw = (v, rate, rotRate = rate, glide = false) => { // (rotRate: how fast the angle follows its target; 30 = it has turned 95% of the way in 0.1 s)
      const t = this.#target(v);
      const c = v.cur;
      const k = rate >= 1 && !glide ? 1 : 1 - Math.exp(-rate * dt); // (glide: a smooth follow at any rate)
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      c.z += (t.z - c.z) * k;
      c.s += (t.s - c.s) * k;
      c.tl = (c.tl ?? 1) + (t.tl - (c.tl ?? 1)) * k;
      const ka = rotRate === rate ? k : 1 - Math.exp(-rotRate * dt); // (an angle speed of its own is always a smooth follow; the other rates are "instant" from 1 up)
      c.a += (((((t.a - c.a + Math.PI) % TAU) + TAU) % TAU) - Math.PI) * ka;
      v.group.position.set(c.x, c.y, c.z);
      v.group.rotation.z = c.a;
      v.group.rotation.x = -(1 - c.tl) * Math.PI / 2; // lying on the table → standing
      v.group.scale.setScalar(c.s);
    };

    for (const v of this.bodyViews.values()) {
      const mineHeld = v.owner === this.ctx.me.slot && (v.st === BODY.HELD || v.st === BODY.HELD_BAD) && this.#carrying();
      draw(v, v.static ? 1 : mineHeld ? 45 : 24, mineHeld ? ROTATE_ANIM : undefined);
    }
    for (const v of this.tableViews.values()) draw(v, 4, undefined, true); // (the row closing up: 95% of the way in about 0.75 s)
    this.#animateGhosts(dt);
    this.#animateExplosions(dt);
    for (const v of this.tableViews.values()) {
      if (v.reveal === undefined || v.reveal >= 1) continue; // a block that just came out of its outline dissolves in
      v.reveal = Math.min(1, v.reveal + dt / 0.55);
      v.mats.forEach((m) => { m.uniforms.uReveal.value = v.reveal; });
    }

    this.#syncCursor();
    this.#updateHands(dt);
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

    const shake = this.shakeT > 0 ? this.shakeT / 0.6 : 0; // the camera shakes for a moment after an explosion
    const cam0 = shake ? this.camera.position.clone() : null;
    if (shake) this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * 2.2 * shake, (Math.random() - 0.5) * 2.2 * shake, 0));
    try {
      this.#renderAll();
    } catch (e) {
      if (this.renderer.getContext?.().isContextLost?.()) return; // the browser took the WebGL context away (too many WebGL windows, or a GPU reset): three.js gets it back by itself, nothing to report
      this.#report(`drawing failed: ${e?.message ?? e}`, e);
      this.renderer.setRenderTarget(null);
      this.#showAll();
    } finally {
      if (cam0) { this.camera.position.copy(cam0); this.camera.updateMatrixWorld(true); }
      if (this.stats) this.#statsEnd();
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
    const size = Math.min(cfg.size, this.gfx?.shadowSize ?? Infinity, this.renderer.capabilities?.maxTextureSize ?? cfg.size); // (as big as the graphics card and the graphics setting allow)
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
    if (!fx.depthMat) fx.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
    fx.depthMat.userData.label = 'shadow depth (replaces every material in the shadow pass)'; // (the usual hardware slope bias: occluders are stored a little further away)
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
      const f = this.gfx?.filter ?? 1; // texture filtering: mipmaps (trilinear) and anisotropy, so the reflection stays sharp at a steep angle
      fx.reflRT = new THREE.WebGLRenderTarget(w, h, f > 0
        ? { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: f === 1 ? 1 : Math.min(f === 2 ? 4 : 16, r.capabilities.getMaxAnisotropy?.() ?? 1) }
        : {});
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
      quad.name = 'post-processing quad';
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
      const over = this.snap?.ph === PHASE.PLAY && this.#tableAt() !== null;
      this.renderer.domElement.classList.toggle('bb-grab', over);
      this.#sendCursor(p, over ? 1 : 0);
      return;
    }
    if (!p || this.mode === 'releasing') return; // (just let go: the block stays where it is until it drops or is picked up again)
    this.ptr = p;
    this.#follow();
    this.#sendMove();
    this.#sendCursor(p, 2);
  };

  /** Tell the room where your pointer is (point of the play plane + which hand: 0 open, 1 pointing, 2 fist), so the others see your hand. */
  #sendCursor(p, hand, force = false) {
    if (!p || this.spectator) return;
    const now = performance.now();
    if (!force && now - this.curSentAt < SEND_GAP) return;
    this.curSentAt = now;
    this.ctx.sendInput({ cur: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, hand] });
  }

  #onLeave = () => { if (!this.spectator && !this.#carrying()) this.ctx.sendInput({ cur: null }); }; // (the pointer left the game: the others stop seeing your hand)

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

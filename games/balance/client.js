import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  applyDefinitions, backgroundKeyOf, backgroundOf, BODY, bowlKeyOf, bowlOf, bowlProfile, DEBUG, DEPTH, dropOf, DROP, FRONT_Z, getShape, groundYOf,
  HOVER_Z, levels, LOSE_TEXT, materials, MATERIAL_KEYS, meta, models, PHASE, PLAY_Z, SHAPE_KEYS, slotPos, tuning, VIEW, WATER_Y,
} from './shared.js';
import { flatNormals, parseObj } from './obj.js';
import { shaders, transparentShaders, vertexShader } from './shaders.js';

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
const ROTATE_SPEED = 150; //     degrees per second while Q / E is held
const WHEEL_STEP = 15; //        degrees per mouse-wheel notch
const BOWL_SEGS = 72;
const TABLE = { w: 110, d: 52, h: 4, z: 2 }; // the wooden table the bowl and the waiting blocks stand on (its top is the bottom of the bowl)

/** A colour as the raw numbers of its hex code: for our own shaders, which write colours to the screen without any conversion. */
const rawColor = (hex) => {
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return new THREE.Color().setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const STORE = 'balance.done'; // localStorage: indexes of completed levels

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
function chamferedPrism(outline, depth, c) {
  const N = outline.length;
  const h = depth / 2;
  const P = outline.map(([x, y]) => new THREE.Vector2(x, y));
  const edgeN = P.map((p, i) => {
    const q = P[(i + 1) % N];
    return new THREE.Vector2(q.y - p.y, p.x - q.x).normalize(); // outward for a counter-clockwise outline
  });
  const Q = P.map((p, i) => { // the outline moved inwards by c (mitred corners)
    const n1 = edgeN[(i + N - 1) % N];
    const n2 = edgeN[i];
    const m = n1.clone().add(n2).multiplyScalar(1 / Math.max(0.25, 1 + n1.dot(n2)));
    return p.clone().addScaledVector(m, -c);
  });
  const arc = [0];
  for (let i = 0; i < N; i++) arc.push(arc[i] + P[i].distanceTo(P[(i + 1) % N]));

  // normal of edge e as seen from one of its ends: smoothed with the neighbouring edge when the corner is gentle
  const SMOOTH = Math.cos(THREE.MathUtils.degToRad(35));
  const normalAt = (e, atEnd) => {
    const own = edgeN[e];
    const other = edgeN[(e + (atEnd ? 1 : N - 1)) % N];
    return own.dot(other) > SMOOTH ? own.clone().add(other).normalize() : own;
  };

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

  // caps
  for (const sign of [1, -1]) {
    const base = pos.length / 3;
    Q.forEach((q) => vert(q.x, q.y, sign * h, 0, 0, sign, q.x, q.y));
    for (const [a, b, d] of THREE.ShapeUtils.triangulateShape(Q.map((q) => q.clone()), [])) tri(base + a, base + b, base + d, [0, 0, sign]);
  }

  // chamfers and the side wall, edge by edge
  const R = Math.SQRT1_2;
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

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/** Outline of a circle part as a counter-clockwise point list. */
function circleOutline(part, sides = 48) {
  return Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * Math.PI * 2;
    return [part.cx + Math.cos(a) * part.r, part.cy + Math.sin(a) * part.r];
  });
}

class BalanceView {
  markerGeo = new THREE.SphereGeometry(0.55, 16, 12);
  objCache = new Map(); //   model file -> Promise of the parsed .obj
  modelGeo = new Map(); //   file|flat/smooth -> [{ name, geo }] (shared by every instance of the model)
  worldToken = 0; //         bumps whenever the world is rebuilt, so late-loading models of the old one are dropped
  sceneSig = null;
  groundY = -9; //           top of the table (set from the bowl of the level)
  bowlDef = null;
  currentLevel = null;
  freeCam = null; //         debug: orbit camera state, null = the normal fitted camera
  camDrag = null;
  dropHelper = null; //      debug: wireframe of the drop zone
  defsRev = 0; //            debug: which version of the definitions we have
  defsAsk = 0;
  onRun = null; //           debug: called when a level starts / restarts
  ptr = null; //             pointer position in the play plane while carrying
  tableViews = new Map(); // blockId -> view of a block lying on the table
  bodyViews = new Map(); //  blockId -> view of a block in the play area (static, floating, falling, or held by somebody)
  poseMem = new Map(); //    blockId -> last drawn pose of a removed view (a block picked up / put back moves from there)
  geoCache = new Map(); //   shape key -> [{ geo }]
  players = []; //           room players: { id, name, slot }
  snap = null;
  run = -1;
  phase = -1;
  done = loadDone();

  // input state. mode: none | drag (button down, carrying) | released (sent drop, waiting to see)
  mode = 'none';
  local = { x: 0, y: 12, rot: 0 }; // where WE hold the block (play-plane coordinates, instant), rot in degrees
  grab = { x: 0, y: 0 }; //          pointer-to-block-centre offset, so the block does not jump
  modeTime = 0;
  downAt = { x: 0, y: 0, t: 0 };
  keys = { q: false, e: false };
  lastSent = 0;
  raf = 0;
  lastFrame = performance.now();
  uTime = { value: 0 };
  ray = new THREE.Raycaster();
  ndc = new THREE.Vector2();
  hit = new THREE.Vector3();
  plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PLAY_Z);

  constructor(ctx) {
    this.ctx = ctx; // ctx.me.slot is -1 for spectators: they watch the same physics, no input
    this.spectator = ctx.me.slot < 0;
    loadStyles();
    this.#buildScene();
    this.#buildUi();
    this.root = el('div', { class: 'bb-root' }, this.renderer.domElement, this.hud, this.menu, this.result);
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
      window.addEventListener('keyup', this.#onKeyUp);
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
    this.snap = s;
    const now = performance.now();
    if (DEBUG) this.#syncDefs(s);

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
    for (const [id, v] of this.bodyViews) if (!inBody.has(id)) this.#remove(this.bodyViews, id, v);
    for (const [id, v] of this.tableViews) if (!onTable.has(id)) this.#remove(this.tableViews, id, v);

    // 2. blocks on the table
    for (const [id, si, mi, slot, heldBy] of s.tbl) {
      if (heldBy >= 0) continue;
      const v = this.tableViews.get(id) ?? this.#makeView(this.tableViews, id, si, mi, { table: true, slot, n: s.n });
      v.slot = slot;
      v.n = s.n;
    }

    // 3. blocks in the play area
    let mine = null;
    for (const [id, si, mi, x, y, a, st, owner] of s.b) {
      const v = this.bodyViews.get(id) ?? this.#makeView(this.bodyViews, id, si, mi, { x, y, a, st, owner });
      Object.assign(v, { tx: x, ty: y, ta: a, st, owner });
      v.static = st === BODY.STATIC;
      const held = st === BODY.HELD || st === BODY.HELD_BAD;
      if (held && owner === this.ctx.me.slot) mine = id;
      v.mats.forEach((m) => { m.uniforms.uBad.value = st === BODY.HELD_BAD ? 1 : 0; }); // the only tint a block ever gets: red = outside the drop area
    }

    // reconcile our pointer state with what the server says we are holding
    if (this.mode === 'released') {
      if (mine === null) this.mode = 'none';
      else if (now - this.modeTime > 350) { // the server still says we hold it (message lost?): let go again
        this.ctx.sendInput({ drop: true });
        this.modeTime = now;
      }
    } else if (this.mode === 'drag' && mine === null && now - this.modeTime > 500) {
      this.mode = 'none';
    }

    this.#updateHud(s);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener('pointerdown', this.#onDown);
    c.removeEventListener('pointermove', this.#onMove);
    c.removeEventListener('pointerup', this.#onUp);
    c.removeEventListener('pointercancel', this.#onUp);
    c.removeEventListener('wheel', this.#onWheel);
    c.removeEventListener('contextmenu', this.#onContext);
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    this.disposed = true;
    this.debug?.dispose();
    this.#clearViews();
    for (const parts of this.geoCache.values()) parts.forEach((p) => p.geo.dispose());
    this.#clearModelGeo();
    this.#disposeTree(this.scene);
    this.#disposeTree(this.frontScene);
    this.markerGeo.dispose();
    this.renderer.dispose();
    this.root.remove();
  }

  // ── debug menu support (everything the menu in debug.js needs from the view) ──
  /** Is somebody else's change to the definitions on its way? Then take it. (Only with DEBUG on.) */
  #syncDefs(s) {
    if (s.drev === undefined || s.drev === this.defsRev) return;
    if (s.defs) { // the server applied somebody's change (maybe ours): everybody takes over its version, at the same snapshot
      applyDefinitions(s.defs);
      this.defsRev = s.drev;
      this.debugRefresh();
      if (s.dfrom !== this.ctx.me.id) this.debug?.onRemoteChange?.(); // our own draft in the menu is already what we sent
    } else if (performance.now() - this.defsAsk > 1500) { // the server has newer definitions and has not sent them (we just joined)
      this.defsAsk = performance.now();
      this.ctx.sendInput({ defsRequest: true });
    }
  }

  /** Rebuild everything that is drawn from the definitions: the block geometry, the level cards and the world. */
  debugRefresh() {
    for (const parts of this.geoCache.values()) parts.forEach((p) => p.geo.dispose());
    this.geoCache.clear();
    this.#clearModelGeo();
    this.#clearViews(); // the next snapshot makes new ones
    this.#buildCards();
    this.#setScene(levels[this.snap?.lv] ?? null, true);
    if (this.snap) this.#updateHud(this.snap);
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

  /** A red wireframe of the drop zone of the current level. */
  debugShowDrop(on) {
    if (on && !this.dropHelper) {
      this.dropHelper = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#e11d48' }));
      this.scene.add(this.dropHelper);
    }
    if (this.dropHelper) this.dropHelper.visible = on;
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

  /** Floor, table, bowl, water and the models of the background. */
  #buildWorld(bowl, bg) {
    if (this.world) {
      this.world.removeFromParent();
      this.#disposeTree(this.world);
    }
    const token = ++this.worldToken;
    const world = (this.world = new THREE.Group());
    this.scene.add(world);
    this.bowlDef = bowl;
    this.groundY = groundYOf(bowl);
    const floorY = this.groundY - TABLE.h;
    this.scene.background = new THREE.Color(bg.mist);
    const fog = { uFogColor: { value: rawColor(bg.mist) }, uFog: { value: new THREE.Vector2(bg.fog?.[0] ?? 150, bg.fog?.[1] ?? 520) } };

    // the ground: raked sand. Ripples run around the table like around a rock, and the far end fades into mist.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), this.#floorMaterial(bg, fog));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = floorY;
    world.add(floor);

    // the table: a 3D wooden rectangle. The bowl stands on it at the back, the waiting blocks lie on it at the front.
    const table = new THREE.Mesh(new THREE.BoxGeometry(TABLE.w, TABLE.h, TABLE.d), this.#blockMaterial('floorwood', 0.7));
    table.position.set(0, this.groundY - TABLE.h / 2, TABLE.z);
    world.add(table);

    // the bowl: the profile turned around the vertical axis (flat bottom, rounded corners), or a model if the bowl has one
    const { inner, outer } = bowlProfile(BOWL_SEGS, bowl);
    const half = (pts) => pts.slice(BOWL_SEGS / 2).map(([x, y]) => new THREE.Vector2(Math.abs(x), y)); // from the middle of the flat bottom up to the rim
    if (bowl.model) {
      this.#addModel(world, bowl.model, token, 0, null);
    } else {
      const profile = [...half(outer), ...half(inner).reverse()]; // outer wall up, inner wall down: the normals come out facing away from the wood
      world.add(new THREE.Mesh(this.#squareLathe(profile, bowl), this.#blockMaterial(bowl.shader, 0.35, THREE.DoubleSide)));
    }

    // the water: the inside of the bowl up to WATER_Y (a lathe too: the side, closed by a flat top)
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
    wp.push(new THREE.Vector2(0, WATER_Y));
    const water = new THREE.Mesh(
      this.#squareLathe(wp, bowl),
      new THREE.MeshBasicMaterial({ color: bowl.water.color, transparent: true, opacity: bowl.water.opacity, depthWrite: false, side: THREE.DoubleSide }),
    );
    water.renderOrder = 5;
    world.add(water);

    // the scenery
    for (const inst of bg.models) this.#addModel(world, inst, token, floorY, fog);
    this.#fitCamera();
  }

  #floorMaterial(bg, fog) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMist: fog.uFogColor,
        uFogRange: fog.uFog,
        uA: { value: rawColor(bg.ground.colorA) },
        uB: { value: rawColor(bg.ground.colorB) },
        uRipple: { value: bg.ground.ripple },
        uHalf: { value: new THREE.Vector2(TABLE.w / 2, TABLE.d / 2) },
        uC: { value: new THREE.Vector2(0, TABLE.z) },
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
  sand *= 0.7 + 0.3 * smoothstep(0.0, 10.0, dist); // the table's soft shadow
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
  async #addModel(parent, inst, token, yOffset, fog) {
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
      group.add(new THREE.Mesh(p.geo, this.#blockMaterial(shader, (i * 0.37) % 1, THREE.DoubleSide, fog)));
    });
    group.scale.setScalar(inst.scale ?? 1);
    const deg = Math.PI / 180;
    const r = inst.rotation ?? [0, 0, 0];
    group.rotation.set(r[0] * deg, r[1] * deg, r[2] * deg, 'YXZ');
    const t = inst.translate ?? [0, 0, 0];
    group.position.set(t[0], t[1] + yOffset, t[2]);
    parent.add(group);
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

  /** One ShaderMaterial per block; the time uniform is shared by all of them. */
  #blockMaterial(shaderName, seed, side = THREE.FrontSide, fog = null) {
    const transparent = transparentShaders.has(shaderName);
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: shaders[shaderName] ?? shaders.stone1,
      uniforms: {
        uTime: this.uTime,
        uSeed: { value: seed },
        uGlow: { value: new THREE.Vector3() },
        uBad: { value: 0 },
        uFogColor: fog?.uFogColor ?? { value: new THREE.Color(0, 0, 0) },
        uFog: fog?.uFog ?? { value: new THREE.Vector2(1e6, 2e6) }, // blocks never fade; background models do
      },
      transparent,
      depthWrite: !transparent,
      side,
    });
  }

  /** Chamfered geometry for each part of a shape (or for its single visual outline, see plus1). Every block has the same depth. */
  #geometries(key) {
    let g = this.geoCache.get(key);
    if (g) return g;
    const shape = getShape(key);
    const outlines = shape.visual ? shape.visual.map((v) => v.pts) : shape.parts.map((p) => (p.type === 'circle' ? circleOutline(p) : p.pts));
    g = outlines.map((pts) => ({ geo: chamferedPrism(pts, DEPTH, tuning.chamfer) }));
    this.geoCache.set(key, g);
    return g;
  }

  /** @param {Map} map  @param opts `{table, slot, n}` for a block on the table, `{x, y, a, st, owner}` for one in the play area */
  #makeView(map, id, si, mi, opts) {
    const shapeKey = SHAPE_KEYS[si];
    const shaderName = materials[MATERIAL_KEYS[mi]].shader;
    const mat = this.#blockMaterial(shaderName, (id * 0.6180339) % 1);

    const group = new THREE.Group();
    for (const { geo } of this.#geometries(shapeKey)) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.id = id;
      if (transparentShaders.has(shaderName)) mesh.renderOrder = 3;
      group.add(mesh);
    }
    this.scene.add(group);

    const v = {
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

  #remove(map, id, v) {
    this.poseMem.set(id, { ...v.cur });
    this.#dispose(v);
    map.delete(id);
  }

  #dispose(v) {
    v.group.removeFromParent();
    v.mats.forEach((m) => m.dispose());
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
    for (const v of this.bodyViews.values()) this.#dispose(v);
    for (const v of this.tableViews.values()) this.#dispose(v);
    this.bodyViews.clear();
    this.tableViews.clear();
    this.poseMem.clear();
  }

  #onPhase(ph, s) {
    this.phase = ph;
    if (ph !== PHASE.PLAY) this.mode = 'none';
    if (ph === PHASE.WON && !this.spectator && s.lv >= 0) {
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
  /** A block held at play-plane point (x, y) is drawn nearer the camera, but along the same line of sight, so it looks like it is at (x, y). */
  #hoverPose(x, y, a) {
    const c = this.camera.position;
    const t = (c.z - HOVER_Z) / c.z;
    return { x: c.x + (x - c.x) * t, y: c.y + (y - c.y) * t, z: HOVER_Z, s: t, a };
  }

  #target(v) {
    if (v.table) {
      const p = slotPos(v.slot, v.n, v.shapeKey, this.groundY);
      return { x: p.x, y: p.y, z: FRONT_Z, s: 1, a: 0 };
    }
    if (v.st === BODY.HELD || v.st === BODY.HELD_BAD) {
      if (v.owner === this.ctx.me.slot && this.#carrying()) return this.#hoverPose(this.local.x, this.local.y, (this.local.rot * Math.PI) / 180);
      return this.#hoverPose(v.tx, v.ty, v.ta);
    }
    return { x: v.tx, y: v.ty, z: PLAY_Z, s: 1, a: v.ta };
  }

  // ── UI (DOM) ──  (nobody is in charge: every player may press every button)
  #buildUi() {
    const send = (d) => !this.spectator && this.ctx.sendInput(d);

    // level menu
    this.cardsEl = el('div', { class: 'bb-cards' });
    this.menuSub = el('p', { class: 'bb-menu-sub' });
    this.menu = el('div', { class: 'bb-menu' }, el('div', { class: 'bb-menu-inner' }, el('h1', { class: 'bb-menu-title' }, meta.name), this.menuSub, this.cardsEl));
    this.#buildCards();

    // in-game HUD
    this.titleEl = el('div', { class: 'bb-title' });
    this.legend = el('div', { class: 'bb-legend' });
    this.leftEl = el('div', { class: 'bb-left' });
    this.barFill = el('div', { class: 'bb-bar-fill' });
    this.barEl = el('div', { class: 'bb-bar' }, this.barFill);
    this.barLabel = el('div', { class: 'bb-bar-label' }, 'Hold steady…');
    this.restartBtn = el('button', { class: 'bb-btn', onclick: () => send({ restart: true }) }, 'Restart');
    this.levelsBtn = el('button', { class: 'bb-btn', onclick: () => send({ menu: true }) }, 'Levels');
    this.hintEl = el('div', { class: 'bb-hint' });
    this.hud = el(
      'div',
      { class: 'bb-hud' },
      el(
        'div',
        { class: 'bb-hud-top' },
        el('div', { class: 'bb-hud-left' }, this.titleEl, this.legend),
        el('div', { class: 'bb-hud-mid' }, this.leftEl, this.barEl, this.barLabel),
        el('div', { class: 'bb-hud-btns' }, ...(this.spectator ? [] : [this.restartBtn, this.levelsBtn])),
      ),
      this.hintEl,
    );

    // win / lose panel
    this.resultTitle = el('h2', { class: 'bb-result-title' });
    this.resultText = el('p', { class: 'bb-result-text' });
    this.resultBtns = el('div', { class: 'bb-result-btns' });
    this.result = el('div', { class: 'bb-result' }, el('div', { class: 'bb-result-box' }, this.resultTitle, this.resultText, this.resultBtns));
  }

  /** One card per level. Built again when the levels change (debug menu). */
  #buildCards() {
    this.cards = levels.map((lv, i) =>
      el(
        'button',
        { class: `bb-card bb-d-${lv.difficulty}`, disabled: this.spectator, onclick: () => !this.spectator && this.ctx.sendInput({ start: i }) },
        el('span', { class: 'bb-num' }, String(i + 1)),
        el('span', { class: 'bb-card-name' }, lv.name),
        el('span', { class: 'bb-card-meta' }, `${lv.difficulty} · ${lv.shapes.length} blocks`),
        el('span', { class: 'bb-done', title: 'Completed' }, '✓'),
      ));
    this.cardsEl.replaceChildren(...this.cards);
    this.#markDone();
  }

  #markDone() {
    this.cards.forEach((c, i) => c.classList.toggle('bb-complete', this.done.has(i)));
  }

  /** Built once when the level ends (never on every snapshot: replacing a button under the pointer swallows the click). */
  #fillResult(ph, s) {
    const btn = (label, d, primary) => el('button', { class: `bb-btn${primary ? ' bb-primary' : ''}`, disabled: this.spectator, onclick: () => this.ctx.sendInput(d) }, label);
    if (ph === PHASE.WON) {
      this.resultTitle.textContent = 'Level complete!';
      this.resultText.textContent = `All ${s.total} blocks are standing.`;
      const next = s.lv + 1 < levels.length;
      this.resultBtns.replaceChildren(...(next ? [btn('Next level', { start: s.lv + 1 }, true)] : []), btn('Replay', { restart: true }, !next), btn('Levels', { menu: true }));
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
      : 'Press a block on the table, drag it above the bowl and let go to drop it (red = not here, it goes back) · Q / E or mouse wheel rotates · right-click or X puts it back';

    const playing = s.ph !== PHASE.MENU;
    this.hud.classList.toggle('bb-hide', !playing);
    if (!playing) return;
    const lv = levels[s.lv];
    this.titleEl.textContent = lv ? `${s.lv + 1}. ${lv.name}` : '';
    this.titleEl.dataset.diff = lv?.difficulty ?? '';
    this.leftEl.textContent = `Blocks left: ${s.left} / ${s.total}`;
    const settling = s.ph === PHASE.PLAY && s.left === 0 && s.still > 0;
    this.barEl.classList.toggle('bb-show', settling);
    this.barLabel.classList.toggle('bb-show', settling);
    this.barFill.style.width = `${Math.round(s.still * 100)}%`;
  }

  // ── layout ──
  #resize() {
    const w = Math.max(1, this.ctx.container.clientWidth);
    const h = Math.max(1, this.ctx.container.clientHeight);
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
    const slotX = ((Math.min(8, Math.max(1, this.currentLevel?.chooseShapes ?? 4)) - 1) / 2) * tuning.slotGap + 7;
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
  }

  #frame = () => {
    this.raf = requestAnimationFrame(this.#frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.uTime.value += dt;
    if (this.freeCam) this.#applyFreeCam();

    // the block we hold slides until its centre is under the pointer, so rotating turns it around its middle
    if (this.#carrying() && this.ptr && (Math.abs(this.grab.x) > 0.01 || Math.abs(this.grab.y) > 0.01)) {
      const kk = 1 - Math.exp(-12 * dt);
      this.grab.x -= this.grab.x * kk;
      this.grab.y -= this.grab.y * kk;
      this.local.x = this.ptr.x + this.grab.x;
      this.local.y = this.ptr.y + this.grab.y;
      this.#sendMove(now);
    }

    // Q / E rotate the block we are holding
    if (this.#carrying() && (this.keys.q || this.keys.e)) {
      this.local.rot += ((this.keys.q ? 1 : 0) - (this.keys.e ? 1 : 0)) * ROTATE_SPEED * dt;
      this.#sendMove(now);
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
      c.a += (((((t.a - c.a + Math.PI) % TAU) + TAU) % TAU) - Math.PI) * k;
      v.group.position.set(c.x, c.y, c.z);
      v.group.rotation.z = c.a;
      v.group.scale.setScalar(c.s);
    };

    for (const v of this.bodyViews.values()) {
      const mineHeld = v.owner === this.ctx.me.slot && (v.st === BODY.HELD || v.st === BODY.HELD_BAD) && this.#carrying();
      draw(v, v.static ? 1 : mineHeld ? 45 : 24);
    }
    for (const v of this.tableViews.values()) draw(v, 14);

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

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.frontScene, this.camera);
  };

  // ── input ──
  #carrying() {
    return this.mode === 'drag' || this.mode === 'released';
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
      this.camDrag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 };
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
    if (this.snap?.ph !== PHASE.PLAY || e.button !== 0) return;
    const p = this.#toWorld(e);
    if (!p) return;
    if (this.mode !== 'none') return;
    const id = this.#tableAt();
    if (id === null) return;
    const v = this.tableViews.get(id);
    // the block's centre, seen along the line of sight, lands at this point of the play plane: start there, no jump
    const cam = this.camera.position;
    const k = cam.z / (cam.z - v.cur.z);
    const cx = cam.x + (v.cur.x - cam.x) * k;
    const cy = cam.y + (v.cur.y - cam.y) * k;
    this.grab = { x: cx - p.x, y: cy - p.y }; // fades to zero in #frame: the block ends up centred on the pointer, so it turns around its middle
    this.ptr = p;
    this.local = { x: cx, y: cy, rot: 0 };
    this.ctx.sendInput({ pick: id, x: cx, y: cy, rot: 0 });
    this.mode = 'drag';
    this.modeTime = performance.now();
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.renderer.domElement.setPointerCapture(e.pointerId);
  };

  #onMove = (e) => {
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
    if (!p) return;
    this.ptr = p;
    this.local.x = p.x + this.grab.x;
    this.local.y = p.y + this.grab.y;
    this.#sendMove();
  };

  #onUp = (e) => {
    if (this.freeCam) {
      this.camDrag = null;
      return;
    }
    if (this.mode !== 'drag') return;
    const p = this.#toWorld(e);
    if (p) {
      this.local.x = p.x + this.grab.x;
      this.local.y = p.y + this.grab.y;
    }
    this.#sendMove(performance.now(), true);
    this.ctx.sendInput({ drop: true }); // letting go of the mouse always lets go of the block
    this.mode = 'released';
    this.modeTime = performance.now();
  };

  #onWheel = (e) => {
    if (this.freeCam) {
      e.preventDefault();
      this.freeCam.dist = THREE.MathUtils.clamp(this.freeCam.dist * Math.exp(e.deltaY * 0.001), 5, 900);
      return;
    }
    if (!this.#carrying()) return;
    e.preventDefault();
    this.local.rot += (e.deltaY < 0 ? 1 : -1) * WHEEL_STEP;
    this.#sendMove(performance.now(), true);
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
    if (k === 'q' || k === 'e') this.keys[k] = true;
    else if (k === 'x') this.#putBack();
  };

  #onKeyUp = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'q' || k === 'e') this.keys[k] = false;
  };
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const balance = { meta, mount: (ctx) => new BalanceView(ctx) };

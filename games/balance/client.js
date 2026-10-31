import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  BODY, BOWL, BOWL_SQUARE, BOWL_ZSCALE, bowlProfile, DEPTH, FRONT_Z, getShape, GROUND_Y, HOVER_Z, levels, LOSE_TEXT, materials, MATERIAL_KEYS,
  meta, PHASE, PLAY_Z, SHAPE_KEYS, SLOT_GAP, slotPos, VIEW, WATER_Y,
} from './shared.js';
import { outlineColor, shaders, transparentShaders, vertexShader } from './shaders.js';

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
const FOV = 28;
const CAM_PITCH = 20; //         degrees the camera looks down
const CAM_TARGET_Y = 8; //       the point the camera looks at (x = 0, z = 0)
const BOWL_SEGS = 72;
const TABLE = { w: 110, d: 52, h: 4, z: 2 }; // the wooden table the bowl and the waiting blocks stand on
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

class BalanceView {
  ptr = null; //             pointer position in the play plane while carrying
  tableViews = new Map(); // blockId -> view of a block lying on the table
  bodyViews = new Map(); //  blockId -> view of a block in the play area (static, floating, falling, or held by somebody)
  poseMem = new Map(); //    blockId -> last drawn pose of a removed view (a block picked up / put back moves from there)
  geoCache = new Map(); //   shape key -> [{ geo, edges }]
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

    if (s.run !== this.run) { // new level, restart or back to the menu: rebuild everything from scratch
      this.#clearViews();
      this.run = s.run;
      this.mode = 'none';
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
      const glow = held ? new THREE.Color(meta.seatColors[owner] ?? '#ffffff') : null;
      v.mats.forEach((m) => {
        m.uniforms.uGlow.value.set(glow?.r ?? 0, glow?.g ?? 0, glow?.b ?? 0);
        m.uniforms.uBad.value = st === BODY.HELD_BAD ? 1 : 0;
      });
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
    this.#clearViews();
    for (const parts of this.geoCache.values()) parts.forEach((p) => { p.geo.dispose(); p.edges.dispose(); });
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
    });
    this.renderer.dispose();
    this.root.remove();
  }

  // ── scene ──
  #buildScene() {
    this.scene = new THREE.Scene();
    this.frontScene = new THREE.Scene(); // blocks somebody is holding: drawn last, on top of everything, so the table never hides them
    this.scene.background = new THREE.Color('#121833');
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 800);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = false;
    this.renderer.domElement.className = 'bb-canvas';

    this.scene.add(new THREE.AmbientLight('#ffffff', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-20, 40, 40);
    this.scene.add(sun);

    // the background: a dark floor and a wall with a soft gradient, far behind the table
    const floorY = GROUND_Y - TABLE.h;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ color: '#1c2550' }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = floorY;
    this.scene.add(floor);
    const grad = document.createElement('canvas');
    grad.width = 2;
    grad.height = 256;
    const g = grad.getContext('2d');
    const gg = g.createLinearGradient(0, 0, 0, 256);
    gg.addColorStop(0, '#0b1020');
    gg.addColorStop(1, '#2b3770');
    g.fillStyle = gg;
    g.fillRect(0, 0, 2, 256);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(900, 260), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(grad) }));
    wall.position.set(0, floorY + 130, -90);
    this.scene.add(wall);

    // the table: a 3D wooden rectangle. The bowl stands on it at the back, the waiting blocks lie on it at the front.
    const table = new THREE.Mesh(new THREE.BoxGeometry(TABLE.w, TABLE.h, TABLE.d), this.#blockMaterial('floorwood', 0.7));
    table.position.set(0, GROUND_Y - TABLE.h / 2, TABLE.z);
    this.scene.add(table);

    // the wooden bowl: a real bowl (the profile from shared.js turned around the vertical axis), round at the bottom and a rounded square at the rim.
    // Lathe profile: outer wall from the bottom up to the rim, then the inner wall back down (this orders the normals correctly).
    const { inner, outer } = bowlProfile(BOWL_SEGS);
    const half = (pts) => pts.slice(BOWL_SEGS / 2).map(([x, y]) => new THREE.Vector2(Math.abs(x), y));
    const profile = [...half(outer), ...half(inner).reverse()];
    this.bowl = new THREE.Mesh(
      this.#squareLathe(profile),
      this.#blockMaterial('bowlwood', 0.35, THREE.DoubleSide),
    );
    this.scene.add(this.bowl);

    // the water: the inside of the bowl up to WATER_Y, slightly transparent blue (a lathe too: the side, closed by a flat top)
    const k = (BOWL.rimY - WATER_Y) / BOWL.b;
    const thEnd = 2 * Math.PI - Math.asin(k);
    const wp = [];
    for (let i = 0; i <= 40; i++) {
      const th = 1.5 * Math.PI + ((thEnd - 1.5 * Math.PI) * i) / 40;
      wp.push(new THREE.Vector2(BOWL.a * Math.cos(th) * 0.996, BOWL.rimY + BOWL.b * Math.sin(th) + 0.02));
    }
    wp.push(new THREE.Vector2(0, WATER_Y));
    this.water = new THREE.Mesh(
      this.#squareLathe(wp),
      new THREE.MeshBasicMaterial({ color: '#3d9bff', transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.water.renderOrder = 5;
    this.scene.add(this.water);
  }

  /**
   * Revolve a (radius, y) profile around the vertical axis. The plan shape goes from a circle at the bottom to a rounded square
   * (superellipse) at the rim. The slice at z = 0 is always exactly the profile, so it still matches the physics.
   */
  #squareLathe(profile, segs = 128) {
    const yBot = BOWL.rimY - BOWL.b - BOWL.t;
    const pos = [];
    for (const { x: r, y } of profile) {
      const f = THREE.MathUtils.clamp((y - yBot) / (BOWL.rimY - yBot), 0, 1);
      const n = 2 + (BOWL_SQUARE - 2) * f * f * (3 - 2 * f);
      const e = 2 / n;
      for (let j = 0; j < segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        const c = Math.cos(th);
        const s = Math.sin(th);
        pos.push(r * Math.sign(c) * Math.abs(c) ** e, y, r * BOWL_ZSCALE * Math.sign(s) * Math.abs(s) ** e);
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
    // the outer wall (low in the profile) must face away from the axis; if the winding came out the other way round, flip it
    if (geo.attributes.normal.getX(Math.floor(profile.length / 4) * segs) < 0) {
      for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
      geo.setIndex(idx);
      geo.computeVertexNormals();
    }
    return geo;
  }

  /** One ShaderMaterial per block; the time uniform is shared by all of them. */
  #blockMaterial(shaderName, seed, side = THREE.FrontSide) {
    const transparent = transparentShaders.has(shaderName);
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: shaders[shaderName] ?? shaders.stone1,
      uniforms: { uTime: this.uTime, uSeed: { value: seed }, uGlow: { value: new THREE.Vector3() }, uBad: { value: 0 } },
      transparent,
      depthWrite: !transparent,
      side,
    });
  }

  /** Extruded geometry (and edge lines) for each part of a shape. Every block has the same depth. */
  #geometries(key) {
    let g = this.geoCache.get(key);
    if (g) return g;
    g = getShape(key).parts.map((part) => {
      const shape = new THREE.Shape();
      if (part.type === 'circle') shape.absarc(part.cx, part.cy, part.r, 0, Math.PI * 2, false);
      else part.pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false, curveSegments: 40 }).translate(0, 0, -DEPTH / 2);
      return { geo, edges: new THREE.EdgesGeometry(geo, 30) };
    });
    this.geoCache.set(key, g);
    return g;
  }

  /** @param {Map} map  @param opts `{table, slot, n}` for a block on the table, `{x, y, a, st, owner}` for one in the play area */
  #makeView(map, id, si, mi, opts) {
    const shapeKey = SHAPE_KEYS[si];
    const shaderName = materials[MATERIAL_KEYS[mi]].shader;
    const mat = this.#blockMaterial(shaderName, (id * 0.6180339) % 1);
    const edge = new THREE.LineBasicMaterial({ color: outlineColor[shaderName] ?? '#1a1020' });

    const group = new THREE.Group();
    for (const { geo, edges } of this.#geometries(shapeKey)) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.id = id;
      if (transparentShaders.has(shaderName)) mesh.renderOrder = 3;
      group.add(mesh, new THREE.LineSegments(edges, edge));
    }
    this.scene.add(group);

    const v = {
      id, group, mats: [mat], edge, size: getShape(shapeKey), shapeKey,
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
    v.edge.dispose();
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
      const p = slotPos(v.slot, v.n, v.shapeKey);
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
    this.cards = levels.map((lv, i) => {
      const card = el(
        'button',
        { class: `bb-card bb-d-${lv.difficulty}`, onclick: () => send({ start: i }) },
        el('span', { class: 'bb-num' }, String(i + 1)),
        el('span', { class: 'bb-card-name' }, lv.name),
        el('span', { class: 'bb-card-meta' }, `${lv.difficulty} · ${lv.shapes.length} blocks`),
        el('span', { class: 'bb-done', title: 'Completed' }, '✓'),
      );
      return card;
    });
    this.menuSub = el('p', { class: 'bb-menu-sub' });
    this.menu = el(
      'div',
      { class: 'bb-menu' },
      el('div', { class: 'bb-menu-inner' }, el('h1', { class: 'bb-menu-title' }, meta.name), this.menuSub, el('div', { class: 'bb-cards' }, ...this.cards)),
    );
    this.#markDone();

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
    this.camera.updateProjectionMatrix();

    // the camera looks down at the table from the front; move it back until everything that matters is on screen:
    // the full play width, the top of the tower, and the waiting blocks on the table in front of the bowl
    const pitch = THREE.MathUtils.degToRad(CAM_PITCH);
    const target = new THREE.Vector3(0, CAM_TARGET_Y, 0);
    const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
    const slotX = ((4 - 1) / 2) * SLOT_GAP + 7;
    const key = [
      [-VIEW.w / 2, 10, 0], [VIEW.w / 2, 10, 0], [0, 30, 0], [-23, 28, 0], [23, 28, 0],
      [-slotX, GROUND_Y, FRONT_Z + DEPTH / 2], [slotX, GROUND_Y, FRONT_Z + DEPTH / 2],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const p = new THREE.Vector3();
    let dist = 40;
    for (; dist < 400; dist += 1) {
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
    if (!this.#carrying()) return;
    e.preventDefault();
    this.local.rot += (e.deltaY < 0 ? 1 : -1) * WHEEL_STEP;
    this.#sendMove(performance.now(), true);
  };

  #onContext = (e) => {
    e.preventDefault();
    this.#putBack();
  };

  #putBack() {
    if (!this.#carrying()) return;
    this.ctx.sendInput({ cancel: true });
    this.mode = 'none';
  }

  #onKeyDown = (e) => {
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

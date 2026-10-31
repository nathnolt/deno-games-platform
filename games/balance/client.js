import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  BODY, BOWL, bowlProfile, DEPTH, dropOf, FRONT_Z, getShape, GROUND_Y, HOVER_Z, inDrop, levels, LOSE_TEXT, materials, MATERIAL_KEYS,
  meta, PHASE, PLAY_Z, SHAPE_KEYS, slotPos, VIEW, WATER_Y,
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
const BOWL_Z = DEPTH + 1.4; //   the wooden bowl is a little thicker than the blocks...
const WATER_Z = DEPTH + 0.9; //  ...and the water fills it, so it shows in front of the submerged blocks
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
  tableViews = new Map(); // blockId -> view of a block lying on the table
  bodyViews = new Map(); //  blockId -> view of a block in the play area (static, floating, falling, or held by somebody)
  poseMem = new Map(); //    blockId -> last drawn pose of a removed view (a block picked up / put back moves from there)
  geoCache = new Map(); //   shape key -> [{ geo, edges }]
  players = []; //           room players: { id, name, slot }
  snap = null;
  run = -1;
  phase = -1;
  done = loadDone();

  // input state. mode: none | drag (button down, carrying) | carry (carrying after a click) | released (sent drop, waiting to see)
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
      this.#onLevel(s.lv);
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
    let inZone = false;
    const level = levels[s.lv];
    for (const [id, si, mi, x, y, a, st, owner] of s.b) {
      const v = this.bodyViews.get(id) ?? this.#makeView(this.bodyViews, id, si, mi, { x, y, a, st, owner });
      Object.assign(v, { tx: x, ty: y, ta: a, st, owner });
      v.static = st === BODY.STATIC;
      const held = st === BODY.HELD || st === BODY.HELD_BAD;
      if (held && owner === this.ctx.me.slot) mine = id;
      if (held && level && inDrop(level, x, y)) inZone = true;
      const glow = held ? new THREE.Color(meta.seatColors[owner] ?? '#ffffff') : null;
      v.mats.forEach((m) => {
        m.uniforms.uGlow.value.set(glow?.r ?? 0, glow?.g ?? 0, glow?.b ?? 0);
        m.uniforms.uBad.value = st === BODY.HELD_BAD ? 1 : 0;
      });
    }
    this.anyHeldInZone = inZone;

    // reconcile our pointer state with what the server says we are holding
    if (this.mode === 'released') {
      if (mine === null) this.mode = 'none';
      else if (now - this.modeTime > 350) this.mode = 'carry'; // the drop was refused (overlap): keep carrying it
    } else if ((this.mode === 'drag' || this.mode === 'carry') && mine === null && now - this.modeTime > 500) {
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
      o.material?.dispose();
    });
    this.renderer.dispose();
    this.root.remove();
  }

  // ── scene ──
  #buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#121833');
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 600);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'bb-canvas';

    this.scene.add(new THREE.AmbientLight('#ffffff', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-20, 40, 40);
    this.scene.add(sun);

    // the table: the bowl stands on it at the back, waiting blocks lie on it at the front
    const table = new THREE.Mesh(new THREE.BoxGeometry(110, 3, 26), new THREE.MeshLambertMaterial({ color: '#5a3d26' }));
    table.position.set(0, GROUND_Y - 1.5, 4);
    this.scene.add(table);

    // the wooden bowl: the half-ellipse ring from shared.js, extruded
    const { inner, outer } = bowlProfile(48);
    const ring = new THREE.Shape();
    ring.moveTo(...outer[0]);
    outer.slice(1).forEach(([x, y]) => ring.lineTo(x, y));
    inner.slice().reverse().forEach(([x, y]) => ring.lineTo(x, y));
    ring.closePath();
    this.bowl = new THREE.Mesh(
      new THREE.ExtrudeGeometry(ring, { depth: BOWL_Z, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, -BOWL_Z / 2),
      this.#blockMaterial('bowlwood', 0.35),
    );
    this.bowl.position.z = PLAY_Z;
    this.scene.add(this.bowl);

    // the water: simple, slightly transparent blue. It is the part of the bowl's inside below WATER_Y.
    const k = (BOWL.rimY - WATER_Y) / BOWL.b;
    const th0 = Math.PI + Math.asin(k);
    const th1 = 2 * Math.PI - Math.asin(k);
    const water = new THREE.Shape();
    for (let i = 0; i <= 48; i++) {
      const th = th0 + ((th1 - th0) * i) / 48;
      const x = BOWL.a * Math.cos(th);
      const y = BOWL.rimY + BOWL.b * Math.sin(th);
      if (i === 0) water.moveTo(x, y);
      else water.lineTo(x, y);
    }
    water.closePath();
    this.water = new THREE.Mesh(
      new THREE.ExtrudeGeometry(water, { depth: WATER_Z, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, -WATER_Z / 2),
      new THREE.MeshBasicMaterial({ color: '#3d9bff', transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.water.renderOrder = 5;
    this.scene.add(this.water);

    // the drop zone: a translucent rectangle in the play plane, above the bowl and a bit wider than it
    this.zone = new THREE.Group();
    this.zoneFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.06, depthWrite: false }),
    );
    this.zoneLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => new THREE.Vector3(x, y, 0))),
      new THREE.LineBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.55 }),
    );
    this.zone.add(this.zoneFill, this.zoneLine);
    this.zone.position.z = DEPTH / 2 + 0.1;
    this.zone.renderOrder = 4;
    this.zone.visible = false;
    this.scene.add(this.zone);
  }

  /** One ShaderMaterial per block; the time uniform is shared by all of them. */
  #blockMaterial(shaderName, seed) {
    const transparent = transparentShaders.has(shaderName);
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: shaders[shaderName] ?? shaders.stone1,
      uniforms: { uTime: this.uTime, uSeed: { value: seed }, uGlow: { value: new THREE.Vector3() }, uBad: { value: 0 } },
      transparent,
      depthWrite: !transparent,
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
    this.scene.remove(v.group);
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

  #onLevel(lv) {
    const level = levels[lv];
    this.zone.visible = !!level;
    if (!level) return;
    const d = dropOf(level);
    this.zone.position.x = (d.x0 + d.x1) / 2;
    this.zone.position.y = (d.y0 + d.y1) / 2;
    this.zone.scale.set(d.x1 - d.x0, d.y1 - d.y0, 1);
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

  // ── UI (DOM) ──
  #isHost() {
    return !this.spectator && this.snap?.host === this.ctx.me.slot;
  }

  #hostName() {
    return this.players.find((p) => p.slot === this.snap?.host)?.name ?? 'the host';
  }

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

  #fillResult(ph, s) {
    const host = this.#isHost();
    const btn = (label, d, primary) => el('button', { class: `bb-btn${primary ? ' bb-primary' : ''}`, disabled: !host, onclick: () => this.ctx.sendInput(d) }, label);
    const wait = host ? [] : [el('div', { class: 'bb-wait' }, `Waiting for ${this.#hostName()}…`)];
    if (ph === PHASE.WON) {
      this.resultTitle.textContent = 'Level complete!';
      this.resultText.textContent = `All ${s.total} blocks are standing.`;
      const next = s.lv + 1 < levels.length;
      this.resultBtns.replaceChildren(...(next ? [btn('Next level', { start: s.lv + 1 }, true)] : []), btn('Replay', { restart: true }, !next), btn('Levels', { menu: true }), ...wait);
    } else {
      this.resultTitle.textContent = 'Level lost';
      this.resultText.textContent = LOSE_TEXT[s.why] ?? '';
      this.resultBtns.replaceChildren(btn('Try again', { restart: true }, true), btn('Levels', { menu: true }), ...wait);
    }
  }

  #updateHud(s) {
    const host = this.#isHost();
    const solo = this.players.length <= 1;
    this.menuSub.textContent = this.spectator ? 'Watching: the players are choosing a level…' : host ? 'Choose a level' : `Waiting for ${this.#hostName()} to choose a level…`;
    this.cards.forEach((c) => (c.disabled = !host));
    this.restartBtn.disabled = !host;
    this.levelsBtn.disabled = !host;
    this.legend.classList.toggle('bb-hide', solo);
    this.hintEl.textContent = this.spectator
      ? 'Spectating'
      : 'Click a block on the table and move it into the dashed zone · release or click to drop it · Q / E or mouse wheel rotates · right-click or X puts it back';

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
    if (this.result.classList.contains('bb-show') && this.resultBtns.children.length) this.#fillResult(s.ph, s);
  }

  // ── layout ──
  #resize() {
    const w = Math.max(1, this.ctx.container.clientWidth);
    const h = Math.max(1, this.ctx.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // always fit the whole play width (84 units) and at least 46 units of height at the play plane
    const t = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const dist = Math.max(VIEW.h / 2 / t, VIEW.w / 2 / (t * aspect));
    this.camera.position.set(0, VIEW.cy + 4, dist);
    this.camera.lookAt(0, VIEW.cy, 0);
    this.camera.updateMatrixWorld();
  }

  #frame = () => {
    this.raf = requestAnimationFrame(this.#frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.uTime.value += dt;

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

    // the drop zone glows while somebody holds a block inside it
    const holding = this.snap?.b.some((r) => r[6] === BODY.HELD || r[6] === BODY.HELD_BAD);
    this.zoneFill.material.opacity = this.anyHeldInZone ? 0.16 : holding ? 0.09 : 0.04;
    this.zoneLine.material.opacity = this.anyHeldInZone ? 0.95 : holding ? 0.7 : 0.35;

    this.renderer.render(this.scene, this.camera);
  };

  // ── input ──
  #carrying() {
    return this.mode === 'drag' || this.mode === 'carry' || this.mode === 'released';
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
    if (this.mode === 'carry') { // second click: let go
      this.local.x = p.x + this.grab.x;
      this.local.y = p.y + this.grab.y;
      this.#sendMove(performance.now(), true);
      this.ctx.sendInput({ drop: true });
      this.mode = 'released';
      this.modeTime = performance.now();
      return;
    }
    if (this.mode !== 'none') return;
    const id = this.#tableAt();
    if (id === null) return;
    const v = this.tableViews.get(id);
    // the block's centre, seen along the line of sight, lands at this point of the play plane: start there, no jump
    const cam = this.camera.position;
    const k = cam.z / (cam.z - v.cur.z);
    const cx = cam.x + (v.cur.x - cam.x) * k;
    const cy = cam.y + (v.cur.y - cam.y) * k;
    this.grab = { x: cx - p.x, y: cy - p.y };
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
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    if (moved > 12 || performance.now() - this.downAt.t > 300) { // dragged: letting go drops it
      this.#sendMove(performance.now(), true);
      this.ctx.sendInput({ drop: true });
      this.mode = 'released';
    } else {
      this.mode = 'carry'; // just a click: keep carrying until the next click
    }
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

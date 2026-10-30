import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  BOWL, getShape, levels, LOSE_TEXT, materials, MATERIAL_KEYS, meta, PHASE, BODY, SHAPE_KEYS, TRAY, VIEW, WATER_Y, zoneOf,
} from './shared.js';
import {
  backgroundFrag, backgroundVertex, outlineColor, shaders, vertexShader, waterFrag, waterVertex,
} from './shaders.js';

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
const OUTLINE = 0.09; //         outline thickness in world units
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

/** Grow a convex counter-clockwise polygon outwards by d (mitred corners). */
function offsetPoly(pts, d) {
  return pts.map((c, i) => {
    const p = pts[(i + pts.length - 1) % pts.length];
    const n = pts[(i + 1) % pts.length];
    const norm = (a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      return [dy / l, -dx / l]; // outward normal for a counter-clockwise polygon
    };
    const n1 = norm(p, c);
    const n2 = norm(c, n);
    const k = d / Math.max(0.25, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [c[0] + (n1[0] + n2[0]) * k, c[1] + (n1[1] + n2[1]) * k];
  });
}

class BalanceView {
  views = new Map(); //      blockId -> { group, mats, si, mi, st, tx, ty, ta, x, y, a, s, static }
  trayViews = new Map(); //  blockId -> view of a block waiting in the tray
  trayPose = new Map(); //   blockId -> last drawn pose of a tray block (so a picked block grows out of its slot)
  geoCache = new Map(); //   shape key -> { fill: [], outline: [] }
  snap = null;
  run = -1;
  phase = -1;
  done = loadDone();

  // input state. mode: none | drag (button down, carrying) | carry (carrying after a click) | released (sent drop, waiting to see)
  mode = 'none';
  local = { x: 0, y: 12, rot: 0 }; // where WE are holding the block (instant), rot in degrees
  modeTime = 0;
  downAt = { x: 0, y: 0, t: 0 };
  keys = { q: false, e: false };
  lastSent = 0;
  raf = 0;
  lastFrame = performance.now();
  half = { w: VIEW.w / 2, h: VIEW.h / 2 };
  uTime = { value: 0 };

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
    this.raf = requestAnimationFrame(this.#frame);
  }

  // ── GameView ──
  onSnapshot(s) {
    this.snap = s;
    const now = performance.now();

    if (s.run !== this.run) { // new level, restart or back to the menu: rebuild everything from scratch
      this.#clearViews();
      this.run = s.run;
      this.#onLevel(s.lv);
      this.mode = 'none';
    }
    if (s.ph !== this.phase) this.#onPhase(s.ph, s);

    this.#syncTray(s.tray); // first: a block that was just picked leaves the tray here and grows out of its slot below

    // blocks
    const seen = new Set();
    let heldId = null;
    for (const [id, si, mi, x, y, a, st] of s.b) {
      seen.add(id);
      let v = this.views.get(id);
      if (!v) v = this.#makeView(id, si, mi, x, y, a, st);
      v.st = st;
      v.tx = x;
      v.ty = y;
      v.ta = a;
      const held = st === BODY.HELD || st === BODY.HELD_BAD;
      if (held) heldId = id;
      v.mats.forEach((m) => {
        m.uniforms.uHeld.value = held ? 1 : 0;
        m.uniforms.uBad.value = st === BODY.HELD_BAD ? 1 : 0;
      });
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.#disposeView(v);
      this.views.delete(id);
    }
    this.heldId = heldId;

    // reconcile our pointer state with what the server says we are holding
    if (this.mode === 'released') {
      if (heldId === null) this.mode = 'none';
      else if (now - this.modeTime > 350) this.mode = 'carry'; // the drop was refused (overlap): keep carrying it
    } else if ((this.mode === 'drag' || this.mode === 'carry') && heldId === null && now - this.modeTime > 500) {
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
    for (const g of this.geoCache.values()) [...g.fill, ...g.outline].forEach((geo) => geo.dispose());
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
    this.camera = new THREE.OrthographicCamera(-VIEW.w / 2, VIEW.w / 2, VIEW.h / 2, -VIEW.h / 2, 0.1, 50);
    this.camera.position.set(0, VIEW.cy, 20);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'bb-canvas';

    // background
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 200),
      new THREE.ShaderMaterial({ vertexShader: backgroundVertex, fragmentShader: backgroundFrag, depthWrite: false }),
    );
    bg.position.set(0, VIEW.cy, -5);
    this.scene.add(bg);

    // the bowl: three static slabs, in the same stone as static blocks
    const { halfW, depth, wall, rim } = BOWL;
    const top = WATER_Y + rim;
    const wallH = top + depth;
    this.bowl = new THREE.Group();
    const stone = this.#blockMaterial('stone2', 0.5);
    for (const [x, y, w, h] of [
      [0, -depth - wall / 2, halfW * 2 + wall * 2, wall],
      [-halfW - wall / 2, top - wallH / 2, wall, wallH],
      [halfW + wall / 2, top - wallH / 2, wall, wallH],
    ]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), stone);
      m.position.set(x, y, 0.1);
      this.bowl.add(m);
    }
    this.scene.add(this.bowl);

    // water, drawn in front of the blocks
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2, depth + 0.6),
      new THREE.ShaderMaterial({
        vertexShader: waterVertex,
        fragmentShader: waterFrag,
        uniforms: { uTime: this.uTime, uDepth: { value: depth } },
        transparent: true,
        depthWrite: false,
      }),
    );
    this.water.position.set(0, -depth / 2 + 0.3, 1);
    this.scene.add(this.water);

    // sideways limits of the play area, shown while playing
    this.zoneLines = [-1, 1].map(() => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.14, 200),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, depthWrite: false }),
      );
      m.position.z = -1;
      m.visible = false;
      this.scene.add(m);
      return m;
    });

    // backdrop for the tray
    const panelW = TRAY.cell + 1.4;
    this.trayPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW, 60),
      new THREE.MeshBasicMaterial({ color: '#0b1020', transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.trayPanel.position.set(TRAY.x, VIEW.cy, -2);
    this.trayPanel.visible = false;
    this.scene.add(this.trayPanel);
  }

  /** One ShaderMaterial per block; the time uniform is shared by all of them. */
  #blockMaterial(shaderName, seed) {
    const src = shaders[shaderName] ?? shaders.stone1;
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: src,
      uniforms: { uTime: this.uTime, uSeed: { value: seed }, uHeld: { value: 0 }, uBad: { value: 0 } },
      transparent: shaderName === 'glass',
      depthWrite: shaderName !== 'glass',
      side: THREE.DoubleSide,
    });
  }

  #geometries(key) {
    let g = this.geoCache.get(key);
    if (g) return g;
    g = { fill: [], outline: [] };
    for (const part of getShape(key).parts) {
      if (part.type === 'circle') {
        g.fill.push(new THREE.CircleGeometry(part.r, 56).translate(part.cx, part.cy, 0));
        g.outline.push(new THREE.CircleGeometry(part.r + OUTLINE, 56).translate(part.cx, part.cy, 0));
      } else {
        const toShape = (pts) => new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
        g.fill.push(toShape(part.pts));
        g.outline.push(toShape(offsetPoly(part.pts, OUTLINE)));
      }
    }
    this.geoCache.set(key, g);
    return g;
  }

  #makeView(id, si, mi, x, y, a, st, tray = false) {
    const shapeKey = SHAPE_KEYS[si];
    const matKey = MATERIAL_KEYS[mi];
    const shaderName = materials[matKey].shader;
    const geos = this.#geometries(shapeKey);
    const mat = this.#blockMaterial(shaderName, (id * 0.6180339) % 1);
    const edge = new THREE.MeshBasicMaterial({ color: outlineColor[shaderName] ?? '#150f1f', side: THREE.DoubleSide });

    const group = new THREE.Group();
    geos.outline.forEach((geo) => {
      const m = new THREE.Mesh(geo, edge);
      m.position.z = 0;
      group.add(m);
    });
    geos.fill.forEach((geo) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.z = 0.02;
      group.add(m);
    });
    this.scene.add(group);

    const from = this.trayPose.get(id); // a block picked from the tray starts where (and as big as) it was
    const v = {
      group, mats: [mat], edge, si, mi, st, tray,
      static: st === BODY.STATIC,
      tx: x, ty: y, ta: a,
      x: from?.x ?? x, y: from?.y ?? y, a, s: from?.s ?? 1,
      size: getShape(shapeKey),
    };
    this.trayPose.delete(id);
    (tray ? this.trayViews : this.views).set(id, v);
    return v;
  }

  #disposeView(v) {
    this.scene.remove(v.group);
    v.mats.forEach((m) => m.dispose());
    v.edge.dispose();
  }

  #clearViews() {
    for (const v of this.views.values()) this.#disposeView(v);
    for (const v of this.trayViews.values()) this.#disposeView(v);
    this.views.clear();
    this.trayViews.clear();
    this.trayPose.clear();
  }

  #syncTray(tray) {
    const ids = new Set(tray.map((t) => t[0]));
    for (const [id, v] of this.trayViews) {
      if (ids.has(id)) continue;
      this.trayPose.set(id, { x: v.x, y: v.y, s: v.s }); // remembered: if it became a held block, it grows out of this spot
      this.#disposeView(v);
      this.trayViews.delete(id);
    }
    tray.forEach(([id, si, mi], i) => {
      let v = this.trayViews.get(id);
      const slotX = TRAY.x;
      const slotY = TRAY.top - i * TRAY.gap;
      if (!v) {
        v = this.#makeView(id, si, mi, slotX, slotY, 0, BODY.NORMAL, true);
        v.s = 0.01; // pops in
      }
      v.tx = slotX;
      v.ty = slotY;
      v.ta = 0;
      v.ts = Math.min(1, TRAY.cell / Math.max(v.size.w, v.size.h));
    });
  }

  #onLevel(lv) {
    const level = levels[lv];
    const zone = level ? zoneOf(level) : null;
    this.zoneLines.forEach((m, i) => {
      m.visible = !!zone;
      if (zone) m.position.x = i === 0 ? zone.x0 : zone.x1;
      m.position.y = VIEW.cy;
    });
  }

  #onPhase(ph, s) {
    this.phase = ph;
    this.trayPanel.visible = ph === PHASE.PLAY || ph === PHASE.WON || ph === PHASE.LOST;
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

  // ── UI (DOM) ──
  #buildUi() {
    const send = (d) => !this.spectator && this.ctx.sendInput(d);

    // level menu
    this.cards = levels.map((lv, i) => {
      const done = el('span', { class: 'bb-done', title: 'Completed' }, '✓');
      const card = el(
        'button',
        { class: `bb-card bb-d-${lv.difficulty}`, disabled: this.spectator, onclick: () => send({ start: i }) },
        el('span', { class: 'bb-num' }, String(i + 1)),
        el('span', { class: 'bb-card-name' }, lv.name),
        el('span', { class: 'bb-card-meta' }, `${lv.difficulty} · ${lv.shapes.length} blocks`),
        done,
      );
      card.dataset.i = String(i);
      return card;
    });
    this.menu = el(
      'div',
      { class: 'bb-menu' },
      el(
        'div',
        { class: 'bb-menu-inner' },
        el('h1', { class: 'bb-menu-title' }, meta.name),
        el('p', { class: 'bb-menu-sub' }, this.spectator ? 'Watching: the player is choosing a level…' : 'Choose a level'),
        el('div', { class: 'bb-cards' }, ...this.cards),
      ),
    );
    this.#markDone();

    // in-game HUD
    this.titleEl = el('div', { class: 'bb-title' });
    this.leftEl = el('div', { class: 'bb-left' });
    this.barFill = el('div', { class: 'bb-bar-fill' });
    this.barEl = el('div', { class: 'bb-bar' }, this.barFill);
    this.barLabel = el('div', { class: 'bb-bar-label' }, 'Hold steady…');
    const buttons = this.spectator
      ? []
      : [
        el('button', { class: 'bb-btn', title: 'Restart (R)', onclick: () => send({ restart: true }) }, 'Restart'),
        el('button', { class: 'bb-btn', onclick: () => send({ menu: true }) }, 'Levels'),
      ];
    this.hintEl = el(
      'div',
      { class: 'bb-hint' },
      this.spectator ? 'Spectating' : 'Click a block and move it, release to drop · Q / E or mouse wheel to rotate · right-click or X to put it back',
    );
    this.hud = el(
      'div',
      { class: 'bb-hud' },
      el('div', { class: 'bb-hud-top' }, this.titleEl, el('div', { class: 'bb-hud-mid' }, this.leftEl, this.barEl, this.barLabel), el('div', { class: 'bb-hud-btns' }, ...buttons)),
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
    const send = (d) => this.ctx.sendInput(d);
    const btn = (label, d, primary) => el('button', { class: `bb-btn${primary ? ' bb-primary' : ''}`, disabled: this.spectator, onclick: () => send(d) }, label);
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
    const aspect = w / h;
    const halfH = Math.max(VIEW.h / 2, VIEW.w / 2 / aspect); // always show the whole 84-unit-wide world, and at least 46 high
    const halfW = halfH * aspect;
    this.half = { w: halfW, h: halfH };
    Object.assign(this.camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.camera.updateProjectionMatrix();
  }

  #frame = () => {
    this.raf = requestAnimationFrame(this.#frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.uTime.value += dt;

    // Q / E rotate the block we are holding
    if (this.#carrying() && (this.keys.q || this.keys.e)) {
      this.local.rot += (this.keys.e ? -1 : 0) * ROTATE_SPEED * dt + (this.keys.q ? 1 : 0) * ROTATE_SPEED * dt;
      this.#sendMove(now);
    }

    const TAU = Math.PI * 2;
    const ease = (v, k) => {
      v.x += (v.tx - v.x) * k;
      v.y += (v.ty - v.y) * k;
      const da = ((((v.ta - v.a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
      v.a += da * k;
      v.s += ((v.ts ?? 1) - v.s) * (1 - Math.exp(-14 * dt));
    };
    const place = (v, z) => {
      v.group.position.set(v.x, v.y, z);
      v.group.rotation.z = v.a;
      v.group.scale.setScalar(v.s);
    };

    for (const v of this.views.values()) {
      const held = v.st === BODY.HELD || v.st === BODY.HELD_BAD;
      if (v.static) {
        v.x = v.tx; v.y = v.ty; v.a = v.ta; v.s = 1;
        place(v, 0.05);
      } else if (held && this.#carrying()) {
        // our own held block follows the pointer instantly (the server follows a moment later)
        v.tx = this.local.x;
        v.ty = this.local.y;
        v.ta = (this.local.rot * Math.PI) / 180;
        ease(v, 1 - Math.exp(-45 * dt));
        place(v, 0.6);
      } else {
        ease(v, 1 - Math.exp(-(held ? 25 : 22) * dt));
        place(v, held ? 0.6 : 0.2);
      }
    }
    for (const v of this.trayViews.values()) {
      ease(v, 1 - Math.exp(-14 * dt));
      place(v, 0.3);
    }

    this.renderer.render(this.scene, this.camera);
  };

  // ── input ──
  #carrying() {
    return this.mode === 'drag' || this.mode === 'carry' || this.mode === 'released';
  }

  #toWorld(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width * 2 - 1) * this.half.w,
      y: VIEW.cy + (1 - (e.clientY - r.top) / r.height * 2) * this.half.h,
    };
  }

  #trayAt(p) {
    let best = null;
    let bestD = Infinity;
    for (const [id, v] of this.trayViews) {
      const dx = Math.abs(p.x - v.x);
      const dy = Math.abs(p.y - v.y);
      const hw = (v.size.w * v.s) / 2 + 0.7;
      const hh = (v.size.h * v.s) / 2 + 0.7;
      if (dx <= hw && dy <= hh && dx + dy < bestD) {
        best = id;
        bestD = dx + dy;
      }
    }
    return best;
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
    if (this.mode === 'carry') {
      this.local.x = p.x;
      this.local.y = p.y;
      this.#sendMove(performance.now(), true);
      this.ctx.sendInput({ drop: true });
      this.mode = 'released';
      this.modeTime = performance.now();
      return;
    }
    if (this.mode !== 'none') return;
    const id = this.#trayAt(p);
    if (id === null) return;
    this.local = { x: p.x, y: p.y, rot: 0 };
    this.ctx.sendInput({ pick: id, x: p.x, y: p.y, rot: 0 });
    this.mode = 'drag';
    this.modeTime = performance.now();
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.renderer.domElement.setPointerCapture(e.pointerId);
  };

  #onMove = (e) => {
    const p = this.#toWorld(e);
    if (!this.#carrying()) {
      this.renderer.domElement.classList.toggle('bb-grab', this.snap?.ph === PHASE.PLAY && this.mode === 'none' && this.#trayAt(p) !== null);
      return;
    }
    this.local.x = p.x;
    this.local.y = p.y;
    this.#sendMove();
  };

  #onUp = (e) => {
    if (this.mode !== 'drag') return;
    const p = this.#toWorld(e);
    this.local.x = p.x;
    this.local.y = p.y;
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
    else if (k === 'r' && this.snap?.ph !== PHASE.MENU) this.ctx.sendInput({ restart: true });
  };

  #onKeyUp = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'q' || k === 'e') this.keys[k] = false;
  };
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const balance = { meta, mount: (ctx) => new BalanceView(ctx) };

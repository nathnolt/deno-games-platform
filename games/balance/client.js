import * as THREE from 'three'; // resolved by the import map in client/index.html
import { el } from '../../client/dom.js';
import {
  BACK_Z, BLOCK, BLOCK_COLORS, COLORS, DEPTH, FRONT_Z, GOAL_Y, HOVER_Z, inZone, meta, PLAT_HALF, PLAT_TOP,
  SLOT_X, ST, TABLE_HALF_W, ZONE,
} from './shared.js';

// All styling lives in ./style.css (static, prefixed bb-). It is attached once, the first time the game is mounted.
function loadStyles() {
  if (document.querySelector('link[data-bb-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./style.css', import.meta.url).href;
  link.dataset.bbStyle = '';
  document.head.append(link);
}

const VIEW_W = 28; // world units the camera must fit horizontally
const VIEW_H = 19; //                                  vertically
const VIEW_CY = 8.5; // the camera looks at this height
const SEND_GAP = 40; // ms between move messages (25 per second)

class BalanceView {
  blocks = new Map(); // id -> { mesh, st, tx, ty, slot }
  dragId = null; //      id of the block this player is dragging
  grab = { x: 0, y: 0 }; // pointer-to-block-centre offset, so the block does not jump
  lastSent = 0;
  lastPoint = null;
  raf = 0;
  lastFrame = performance.now();
  ndc = new THREE.Vector2();
  hit = new THREE.Vector3();
  raycaster = new THREE.Raycaster();
  dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(FRONT_Z + HOVER_Z));

  constructor(ctx) {
    this.ctx = ctx; // ctx.me.slot is -1 for spectators: they watch, no input
    this.spectator = ctx.me.slot < 0;
    this.geo = new THREE.BoxGeometry(BLOCK - 0.04, BLOCK - 0.04, DEPTH);

    loadStyles();
    this.#buildScene();
    this.#buildHud();
    this.root = el('div', { class: 'bb-root' }, this.renderer.domElement, this.hud);
    ctx.container.append(this.root);

    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(ctx.container);
    this.#resize();

    const c = this.renderer.domElement;
    if (!this.spectator) {
      c.addEventListener('pointerdown', this.#onDown);
      c.addEventListener('pointermove', this.#onMove);
      c.addEventListener('pointerup', this.#onUp);
      c.addEventListener('pointercancel', this.#onUp);
    }
    this.onRoom(ctx.room);
    this.raf = requestAnimationFrame(this.#frame);
  }

  // ── GameView ──
  onRoom(room) {
    this.legend.replaceChildren(
      ...room.players.filter((p) => p.slot >= 0).map((p) => {
        const dot = el('span', { class: 'bb-dot' });
        dot.style.setProperty('--c', COLORS[p.slot] ?? '#fff'); // the colour is the only dynamic style; the rest is in style.css
        return el('div', { class: 'bb-player' }, dot, p.id === this.ctx.me.id ? `${p.name} (you)` : p.name);
      }),
    );
  }

  onSnapshot(s) {
    const seen = new Set();
    for (const [id, st, x, y, slot, color] of s.b) {
      seen.add(id);
      const b = this.blocks.get(id) ?? this.#createBlock(id, color, st, x, y);
      b.st = st;
      b.tx = x;
      b.ty = y;
      b.slot = slot;
      const mat = b.mesh.material;
      mat.emissive.set(st === ST.HELD ? (COLORS[slot] ?? '#ffffff') : '#000000');
      mat.emissiveIntensity = st === ST.HELD ? 0.55 : 0;
    }
    for (const [id, b] of this.blocks) {
      if (seen.has(id)) continue;
      this.#removeBlock(b);
      this.blocks.delete(id);
    }

    // Lost the race for a block (someone else grabbed it first), or it vanished: stop dragging.
    if (this.dragId !== null) {
      const d = this.blocks.get(this.dragId);
      if (!d || (d.st === ST.HELD && d.slot !== this.ctx.me.slot)) this.dragId = null;
    }

    this.height.textContent = `Height ${s.top.toFixed(1)} / ${GOAL_Y}`;
    this.towersEl.textContent = `Towers built: ${s.n}`;
    this.banner.classList.toggle('bb-show', s.r === 1);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener('pointerdown', this.#onDown);
    c.removeEventListener('pointermove', this.#onMove);
    c.removeEventListener('pointerup', this.#onUp);
    c.removeEventListener('pointercancel', this.#onUp);
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.geo.dispose();
    this.renderer.dispose();
    this.root.remove();
  }

  // ── scene ──
  #buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d1226');
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'bb-canvas';

    this.scene.add(new THREE.AmbientLight('#ffffff', 0.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.8);
    sun.position.set(-10, 24, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 26, bottom: -6, near: 1, far: 80 });
    this.scene.add(sun);

    const add = (geo, color, x, y, z, { shadow = true, roughness = 0.85 } = {}) => {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness }));
      m.position.set(x, y, z);
      m.receiveShadow = true;
      m.castShadow = shadow;
      this.scene.add(m);
      return m;
    };

    add(new THREE.PlaneGeometry(70, 45), '#141b36', 0, 12, -5, { shadow: false }); // back wall
    add(new THREE.BoxGeometry(TABLE_HALF_W * 2, 1, 8), '#6b4a2e', 0, -0.5, 0); // table
    for (const [z, color] of [[FRONT_Z, '#80593a'], [BACK_Z, '#5c3f27']]) { // the two lanes
      const lane = add(new THREE.PlaneGeometry(TABLE_HALF_W * 2, DEPTH + 0.2), color, 0, 0.01, z, { shadow: false });
      lane.rotation.x = -Math.PI / 2;
    }
    add(new THREE.BoxGeometry(PLAT_HALF * 2, PLAT_TOP, 3), '#475569', 0, PLAT_TOP / 2, BACK_Z); // base plate

    // Drop zone: a translucent rectangle behind the tower, shown while somebody holds a block.
    const zw = ZONE.x1 - ZONE.x0;
    const zh = ZONE.y1 - ZONE.y0;
    const zoneGeo = new THREE.PlaneGeometry(zw, zh);
    this.zone = new THREE.Group();
    this.zoneFill = new THREE.Mesh(zoneGeo, new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.1, depthWrite: false }));
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(zoneGeo), new THREE.LineBasicMaterial({ color: '#7dd3fc' }));
    this.zone.add(this.zoneFill, outline);
    this.zone.position.set((ZONE.x0 + ZONE.x1) / 2, (ZONE.y0 + ZONE.y1) / 2, BACK_Z - DEPTH / 2 - 0.3);
    this.zone.visible = false;
    this.scene.add(this.zone);

    // Goal line
    const goal = new THREE.Mesh(new THREE.PlaneGeometry(zw, 0.06), new THREE.MeshBasicMaterial({ color: '#fbbf24' }));
    goal.position.set(0, GOAL_Y, BACK_Z - DEPTH / 2 - 0.25);
    this.scene.add(goal);
  }

  #buildHud() {
    this.height = el('div', { class: 'bb-stat' }, '');
    this.towersEl = el('div', { class: 'bb-stat' }, '');
    this.legend = el('div', { class: 'bb-legend' });
    this.banner = el('div', { class: 'bb-banner' }, 'Tower complete! Starting a new one…');
    const hint = this.spectator ? 'Spectating' : 'Drag a block into the blue zone and let go';
    this.hud = el('div', { class: 'bb-hud' }, this.height, this.towersEl, this.legend, el('div', { class: 'bb-hint' }, hint), this.banner);
  }

  #createBlock(id, colorIdx, st, x, y) {
    const mat = new THREE.MeshStandardMaterial({ color: BLOCK_COLORS[colorIdx] ?? '#fff', roughness: 0.55 });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.id = id;
    mesh.position.set(x, y, this.#layerZ(st));
    mesh.scale.setScalar(st === ST.IDLE ? 0.01 : 1); // fresh blocks pop in
    this.scene.add(mesh);
    const b = { mesh, st, tx: x, ty: y, slot: -1 };
    this.blocks.set(id, b);
    return b;
  }

  #removeBlock(b) {
    this.scene.remove(b.mesh);
    b.mesh.material.dispose(); // the geometry is shared and disposed in dispose()
  }

  #layerZ(st) {
    if (st === ST.HELD) return FRONT_Z + HOVER_Z;
    return st === ST.FALL || st === ST.STACK ? BACK_Z : FRONT_Z;
  }

  #resize() {
    const w = Math.max(1, this.ctx.container.clientWidth);
    const h = Math.max(1, this.ctx.container.clientHeight);
    this.renderer.setSize(w, h, false); // the canvas is sized by CSS (100% of .bb-root)
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const dist = Math.max(VIEW_H / 2 / t, VIEW_W / 2 / (t * this.camera.aspect)) + 3;
    this.camera.position.set(0, VIEW_CY + 4, dist);
    this.camera.lookAt(0, VIEW_CY, 0);
  }

  #frame = () => {
    this.raf = requestAnimationFrame(this.#frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    let anyHeld = false;
    let heldInZone = false;
    for (const b of this.blocks.values()) {
      const mine = b.st === ST.HELD && b.slot === this.ctx.me.slot;
      const k = 1 - Math.exp(-(mine ? 40 : 20) * dt);
      const p = b.mesh.position;
      p.x += (b.tx - p.x) * k;
      p.y += (b.ty - p.y) * k;
      p.z += (this.#layerZ(b.st) - p.z) * (1 - Math.exp(-14 * dt));
      const sc = b.mesh.scale.x;
      b.mesh.scale.setScalar(sc + (1 - sc) * (1 - Math.exp(-10 * dt)));
      if (b.st === ST.HELD) {
        anyHeld = true;
        if (inZone(b.tx, b.ty)) heldInZone = true;
      }
    }
    this.zone.visible = anyHeld;
    this.zoneFill.material.opacity = heldInZone ? 0.28 : 0.1;
    this.renderer.render(this.scene, this.camera);
  };

  // ── input ──
  #setRay(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  #pickAt(e) {
    this.#setRay(e);
    const meshes = [...this.blocks.values()].filter((b) => b.st === ST.IDLE).map((b) => b.mesh);
    return this.raycaster.intersectObjects(meshes, false)[0]?.object.userData.id ?? null;
  }

  #sendPos(e) {
    this.#setRay(e);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) return;
    this.lastPoint = { x: this.hit.x + this.grab.x, y: this.hit.y + this.grab.y };
    this.ctx.sendInput({ x: Math.round(this.lastPoint.x * 100) / 100, y: Math.round(this.lastPoint.y * 100) / 100 });
  }

  #onDown = (e) => {
    if (this.dragId !== null || e.button > 0) return;
    const id = this.#pickAt(e);
    if (id === null) return;
    const b = this.blocks.get(id);
    this.#setRay(e);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) return;
    this.grab = { x: b.tx - this.hit.x, y: b.ty - this.hit.y };
    this.dragId = id;
    this.renderer.domElement.classList.add('bb-grabbing');
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.ctx.sendInput({ pick: id }); // the server decides; if somebody else was faster the next snapshot cancels the drag
    this.#sendPos(e);
    this.lastSent = performance.now();
  };

  #onMove = (e) => {
    const c = this.renderer.domElement;
    if (this.dragId === null) {
      c.classList.toggle('bb-grab', this.#pickAt(e) !== null);
      return;
    }
    const now = performance.now();
    if (now - this.lastSent < SEND_GAP) return;
    this.lastSent = now;
    this.#sendPos(e);
  };

  #onUp = (e) => {
    if (this.dragId === null) return;
    this.#sendPos(e); // final position, then let go
    this.ctx.sendInput({ drop: true });
    this.dragId = null;
    this.renderer.domElement.classList.remove('bb-grabbing');
  };
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const balance = { meta, mount: (ctx) => new BalanceView(ctx) };

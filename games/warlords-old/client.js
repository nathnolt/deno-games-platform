import * as THREE from 'three'; // resolved by the import map in client/index.html
import { World, defineComponent } from '../../shared/ecs.js';
import { SnapshotBuffer, lerp } from '../../shared/interp.js';
import {
  ARENA, BALL_R, BRICK_CELLS, BallC, BrickC, KingC, PaddleC, Pos,
  brickRect, clockwiseSign, kingRect, meta, paddleRect, tFromPoint,
} from './shared.js';

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];
const Render = defineComponent('Render'); // client-only component: {mesh}

/**
 * Client side: no simulation. Server snapshots are mirrored into this view's own ECS World
 * (entities with Pos / Render components) and drawn with Three.js.
 *
 * Controls: the mouse steers your paddle directly (projected onto your L-shaped track);
 * arrow keys / WASD also work. With "instant mouse" on, your own paddle is drawn at the
 * mouse position immediately (client-side prediction), so it never feels laggy.
 */
class WarlordsView {
  constructor(ctx) {
    this.ctx = ctx;
    this.world = new World();
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, ARENA, ARENA, 0, -1, 1); // y is flipped in setRect()
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.buffer = new SnapshotBuffer(60);
    this.balls = new Map(); // network ball id -> entity
    this.names = new Map(ctx.room.players.map((p) => [p.slot, p.name]));
    this.instant = ctx.room.settings.instantMouse !== false;
    this.mouseT = null; // latest mouse position on the track (for prediction)
    this.pendingT = null;
    this.sentT = null;
    this.cw = false;
    this.ccw = false;
    this.lastDir = 0;

    const host = ctx.container;
    host.style.position = 'relative';
    this.hud = Object.assign(document.createElement('div'), { className: 'wl-hud' });
    this.banner = Object.assign(document.createElement('div'), { className: 'wl-banner' });
    this.hint = Object.assign(document.createElement('div'), {
      className: 'wl-hint',
      textContent: 'Move the mouse to steer your paddle (arrow keys / WASD also work)',
    });
    this.renderer.setClearColor(0x0b1020);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.append(this.renderer.domElement, this.hud, this.banner, this.hint);

    this.scene.add(this.#mesh(0x131b34, { x: ARENA / 2, y: ARENA / 2, w: ARENA, h: ARENA }, -0.5));
    for (let slot = 0; slot < 4; slot++) {
      const color = COLORS[slot];
      this.#spawn(KingC, { slot }, kingRect(slot), '#f8fafc');
      BRICK_CELLS.forEach((_, idx) => this.#spawn(BrickC, { slot, idx }, brickRect(slot, idx), color));
      this.#spawn(PaddleC, { slot, t: 0 }, paddleRect(slot, 0), color);
    }

    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(host);
    this.#resize();
    window.addEventListener('pointermove', this.#onPointer);
    window.addEventListener('keydown', this.#onKey);
    window.addEventListener('keyup', this.#onKey);
    this.raf = requestAnimationFrame(this.#frame);
  }

  // ── GameView ──
  onSnapshot(data) {
    this.buffer.push(data);
    this.#updateHud(data);
  }

  onEnd(result) {
    this.banner.textContent = result.winner >= 0 ? `${this.#name(result.winner)} wins the match` : 'Match ended';
    this.banner.style.color = result.winner >= 0 ? COLORS[result.winner] : '#e2e8f0';
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointermove', this.#onPointer);
    window.removeEventListener('keydown', this.#onKey);
    window.removeEventListener('keyup', this.#onKey);
    this.observer.disconnect();
    this.renderer.dispose();
    for (const el of [this.hud, this.banner, this.hint, this.renderer.domElement]) el.remove();
  }

  // ── input ──
  #onPointer = (e) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * ARENA;
    const y = ((e.clientY - r.top) / r.height) * ARENA;
    this.mouseT = this.pendingT = tFromPoint(this.ctx.me.slot, x, y);
  };

  #onKey = (e) => {
    const down = e.type === 'keydown';
    if (['ArrowLeft', 'ArrowUp', 'a', 'A', 'w', 'W'].includes(e.key)) this.ccw = down;
    else if (['ArrowRight', 'ArrowDown', 'd', 'D', 's', 'S'].includes(e.key)) this.cw = down;
    else return;
    e.preventDefault();
    const dir = (this.cw ? 1 : 0) - (this.ccw ? 1 : 0);
    if (dir === this.lastDir) return;
    this.lastDir = dir;
    this.mouseT = this.pendingT = null; // keyboard takes over until the mouse moves again
    this.sentT = null;
    this.ctx.sendInput({ dir: dir * clockwiseSign(this.ctx.me.slot) });
  };

  /** At most one mouse message per animation frame. */
  #sendMouse() {
    if (this.pendingT === null || this.pendingT === this.sentT) return;
    this.sentT = this.pendingT;
    this.ctx.sendInput({ t: Math.round(this.pendingT * 10) / 10 });
  }

  // ── ECS setup ──
  #spawn(component, value, rect, color) {
    const e = this.world.create();
    const mesh = this.#mesh(color, rect);
    this.scene.add(mesh);
    this.world.add(e, component, value);
    this.world.add(e, Render, { mesh });
  }

  #mesh(color, rect, z = 0) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color }));
    this.#setRect(mesh, rect, z);
    return mesh;
  }

  #setRect(mesh, r, z = 0) {
    mesh.position.set(r.x, ARENA - r.y, z);
    mesh.scale.set(r.w, r.h, 1);
  }

  // ── systems ──
  #frame = () => {
    this.raf = requestAnimationFrame(this.#frame);
    this.#sendMouse();
    const s = this.buffer.sample();
    if (s) {
      this.#interpolationSystem(s.a, s.b, s.alpha);
      this.#renderSystem();
    }
    this.renderer.render(this.scene, this.camera);
  };

  /** Applies the interpolated snapshot to the client world. */
  #interpolationSystem(a, b, alpha) {
    const w = this.world;
    for (const e of w.query(PaddleC, Render)) {
      const { slot } = w.get(e, PaddleC);
      const mesh = w.get(e, Render).mesh;
      mesh.visible = b.alive[slot];
      let t = lerp(a.paddles[slot], b.paddles[slot], alpha);
      if (slot === this.ctx.me.slot && this.instant && this.mouseT !== null) t = this.mouseT; // prediction
      this.#setRect(mesh, paddleRect(slot, t));
    }
    for (const e of w.query(BrickC, Render)) {
      const { slot, idx } = w.get(e, BrickC);
      w.get(e, Render).mesh.visible = (b.bricks[slot] & (1 << idx)) !== 0;
    }
    for (const e of w.query(KingC, Render)) {
      w.get(e, Render).mesh.visible = b.alive[w.get(e, KingC).slot];
    }

    const seen = new Set();
    for (const nb of b.balls) {
      const prev = a.balls.find((x) => x.id === nb.id) ?? nb;
      let e = this.balls.get(nb.id);
      if (e === undefined) {
        e = w.create();
        const mesh = new THREE.Mesh(new THREE.CircleGeometry(BALL_R, 20), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        this.scene.add(mesh);
        w.add(e, BallC, { id: nb.id });
        w.add(e, Pos, { x: nb.x, y: nb.y });
        w.add(e, Render, { mesh });
        this.balls.set(nb.id, e);
      }
      const p = w.get(e, Pos);
      p.x = lerp(prev.x, nb.x, alpha);
      p.y = lerp(prev.y, nb.y, alpha);
      seen.add(nb.id);
    }
    for (const [id, e] of this.balls) {
      if (seen.has(id)) continue;
      const mesh = w.get(e, Render).mesh;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      w.destroy(e);
      this.balls.delete(id);
    }
  }

  /** Copies Pos into mesh transforms for freely moving entities (balls). */
  #renderSystem() {
    const w = this.world;
    for (const e of w.query(Pos, Render)) {
      const p = w.get(e, Pos);
      w.get(e, Render).mesh.position.set(p.x, ARENA - p.y, 0.1);
    }
  }

  // ── HUD ──
  #name(slot) {
    return this.names.get(slot) ?? `Bot ${slot + 1}`;
  }

  #updateHud(s) {
    const parts = [];
    s.active.forEach((on, slot) => {
      if (!on) return;
      const span = document.createElement('span');
      span.textContent = `${this.#name(slot)}: ${s.scores[slot]}`;
      span.style.color = COLORS[slot];
      if (!s.alive[slot]) span.style.opacity = '0.45';
      if (slot === this.ctx.me.slot) span.style.fontWeight = '700';
      parts.push(span);
    });
    this.hud.replaceChildren(...parts);
    if (s.phase === 'countdown') {
      this.banner.textContent = `Round ${s.round}: ${Math.max(1, Math.ceil(s.timer))}`;
      this.banner.style.color = '#e2e8f0';
    } else if (s.phase === 'roundOver') {
      this.banner.textContent = s.roundWinner >= 0 ? `${this.#name(s.roundWinner)} takes the round` : 'Draw';
      this.banner.style.color = s.roundWinner >= 0 ? COLORS[s.roundWinner] : '#e2e8f0';
    } else {
      this.banner.textContent = '';
    }
  }

  #resize() {
    const h = this.ctx.container;
    const size = Math.max(200, Math.min(h.clientWidth, h.clientHeight));
    this.renderer.setSize(size, size);
  }
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const warlords = {
  meta,
  mount: (ctx) => new WarlordsView(ctx),
};

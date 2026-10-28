import * as THREE from 'three'; // resolved by the import map in client/index.html
import { World, defineComponent } from '../../shared/ecs.js';
import { SnapshotBuffer, lerp } from '../../shared/interp.js';
import {
  ARENA, BALL_R, BRICK_CELLS, BallC, BrickC, KingC, PaddleC, Pos, Vel,
  brickRect, clockwiseSign, kingRect, meta, paddleRects, tFromPoint,
} from './shared.js';
import { Sfx } from './audio.js';

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];
const Render = defineComponent('Render'); // client-only: {meshes: Object3D[], inner?: Mesh}
const Juice = defineComponent('Juice'); //   client-only: spring for squash & stretch {x, v, ang, born, flash}
const Fx = defineComponent('Fx'); //         client-only: short-lived particles / rings {kind, life, max, size, spin, r0, r1}

// ── juice tuning ──
const EVENT_DELAY = 60; //       ms; keep equal to the SnapshotBuffer delay so sounds line up with what is drawn
const SPRING_K = 420; //         squash spring stiffness
const SPRING_C = 15; //          squash spring damping (lower = jigglier)
const SHAKE = { wall: 3, brick: 1.5, paddle: 0.7, king: 14 }; // screen shake in arena units (arena = 800)
const SHAKE_DECAY = 11; //       per second
const FLICKER_MS = 190; //       how long a paddle flickers after hitting a ball
const MAX_FX = 160;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;

/**
 * Client side: no simulation. Server snapshots are mirrored into this view's own ECS World
 * (entities with Pos / Render / Juice components) and drawn with Three.js.
 *
 * Controls: the mouse "points" at what you want to defend against and your paddle slides around
 * your base to that side (see tFromPoint); arrow keys / WASD also work, M mutes. Hold the mouse
 * button (or Space) while a ball touches your paddle (anywhere on it) to catch it; let go to launch it
 * (a line is drawn showing where it will go). With "instant
 * mouse" on, your own paddle is drawn at the mouse position immediately (client-side
 * prediction), so it never feels laggy.
 *
 * Juice: the server sends one-shot events (ball hit paddle / brick / base / wall, new ball) inside
 * each snapshot. They are queued for EVENT_DELAY ms (the interpolation delay) and then drive
 * sounds, squash & stretch springs, paddle flicker, particles and screen shake.
 */
class WarlordsView {
  constructor(ctx) {
    this.ctx = ctx;
    this.world = new World();
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, ARENA, ARENA, 0, -1, 1); // y is flipped in #setRect()
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.buffer = new SnapshotBuffer(EVENT_DELAY);
    this.balls = new Map(); // network ball id -> entity
    this.names = new Map(ctx.room.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p.name]));
    this.spectating = ctx.me.slot < 0; // joined without a seat: watch only, send no input
    this.instant = ctx.room.settings.instantMouse !== false;
    this.baseSpeed = ctx.room.settings.ballSpeed;
    this.mouseT = null; // latest mouse position on the track (for prediction)
    this.pendingT = null;
    this.sentT = null;
    this.cw = false;
    this.ccw = false;
    this.lastDir = 0;
    this.holdOn = false; // hold button state we last told the server about

    // juice state
    this.sfx = new Sfx();
    this.queue = []; // {at, ev}: events waiting for their moment
    this.shake = 0;
    this.fxCount = 0;
    this.alive = [true, true, true, true];
    this.paddles = [null, null, null, null]; // slot -> paddle entity
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; // no shake / flicker then
    this.last = performance.now();
    this.colors = COLORS.map((c) => new THREE.Color(c));
    this.white = new THREE.Color('#ffffff');
    this.blue = new THREE.Color('#3b9eff');
    this.planeGeo = new THREE.PlaneGeometry(1, 1);
    this.circleGeo = new THREE.CircleGeometry(BALL_R, 24);
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 40);

    const host = ctx.container;
    host.style.position = 'relative';
    this.hud = Object.assign(document.createElement('div'), { className: 'wl-hud' });
    this.banner = Object.assign(document.createElement('div'), { className: 'wl-banner' });
    this.hint = Object.assign(document.createElement('div'), {
      className: 'wl-hint',
      textContent: this.spectating
        ? 'You are watching this match. M mutes.'
        : ctx.room.settings.holdEnabled !== false
        ? 'Mouse swings your paddle around your base. Hold the button (or Space) to catch a ball, swing, release to launch. Swing into balls to speed them up. M mutes.'
        : 'Mouse swings your paddle around your base (arrow keys / WASD also work). M mutes.',
    });
    this.muteBtn = Object.assign(document.createElement('button'), { className: 'wl-mute', type: 'button' });
    Object.assign(this.muteBtn.style, {
      position: 'absolute', right: '8px', bottom: '8px', width: '36px', height: '36px', padding: '0',
      border: '1px solid rgba(255,255,255,.2)', borderRadius: '8px', background: 'rgba(11,16,32,.7)',
      color: '#e2e8f0', fontSize: '18px', lineHeight: '1', cursor: 'pointer', zIndex: '5',
    });
    this.muteBtn.addEventListener('click', this.#toggleMute);
    this.#syncMuteButton();
    this.renderer.setClearColor(0x0b1020);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.append(this.renderer.domElement, this.hud, this.banner, this.hint, this.muteBtn);

    this.scene.add(this.#plane('#131b34', -0.5, { x: ARENA / 2, y: ARENA / 2, w: ARENA, h: ARENA }));
    for (let slot = 0; slot < 4; slot++) {
      const color = COLORS[slot];
      this.#spawn(KingC, { slot }, kingRect(slot), '#f8fafc');
      BRICK_CELLS.forEach((_, idx) => this.#spawn(BrickC, { slot, idx }, brickRect(slot, idx), color));
      // A paddle is up to two rectangles (it bends around the inner corner of the base).
      const e = this.world.create();
      const meshes = [this.#plane(color, 0.05), this.#plane(color, 0.05)];
      meshes.forEach((m) => this.scene.add(m));
      this.world.add(e, PaddleC, { slot, t: 0 });
      this.world.add(e, Render, { meshes });
      this.world.add(e, Juice, { x: 0, v: 0, ang: 0, born: 0, flash: 0 });
      this.paddles[slot] = e;
    }

    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(host);
    this.#resize();
    window.addEventListener('pointermove', this.#onPointer);
    window.addEventListener('pointerdown', this.#onDown);
    window.addEventListener('pointerup', this.#onUp);
    window.addEventListener('pointercancel', this.#onUp);
    window.addEventListener('blur', this.#onUp);
    window.addEventListener('keydown', this.#onKey);
    window.addEventListener('keyup', this.#onKey);
    this.sfx.unlock(); // works if the "Start game" click still counts as a gesture; otherwise the first click / key does it
    this.raf = requestAnimationFrame(this.#frame);
  }

  // ── GameView ──
  onSnapshot(data) {
    this.buffer.push(data);
    this.#updateHud(data);
    if (data.ev?.length && !document.hidden) {
      const at = performance.now() + EVENT_DELAY;
      for (const ev of data.ev) this.queue.push({ at, ev });
      if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    }
  }

  onEnd(result) {
    this.banner.textContent = result.winner >= 0 ? `${this.#name(result.winner)} wins the match` : 'Match ended';
    this.banner.style.color = result.winner >= 0 ? COLORS[result.winner] : '#e2e8f0';
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointermove', this.#onPointer);
    window.removeEventListener('pointerdown', this.#onDown);
    window.removeEventListener('pointerup', this.#onUp);
    window.removeEventListener('pointercancel', this.#onUp);
    window.removeEventListener('blur', this.#onUp);
    window.removeEventListener('keydown', this.#onKey);
    window.removeEventListener('keyup', this.#onKey);
    this.muteBtn.removeEventListener('click', this.#toggleMute);
    this.observer.disconnect();
    this.scene.traverse((o) => { // materials are per mesh, geometries are shared: both are freed here
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.planeGeo.dispose();
    this.circleGeo.dispose();
    this.ringGeo.dispose();
    this.renderer.dispose();
    this.sfx.dispose();
    for (const el of [this.hud, this.banner, this.hint, this.muteBtn, this.renderer.domElement]) el.remove();
  }

  // ── input ──
  #onPointer = (e) => {
    if (this.spectating) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * ARENA;
    const y = ((e.clientY - r.top) / r.height) * ARENA;
    this.mouseT = this.pendingT = tFromPoint(this.ctx.me.slot, x, y);
  };

  #onDown = (e) => {
    this.sfx.unlock();
    if (e.button === 0 && !e.target?.closest?.('.wl-mute')) this.#setHold(true);
  };

  #onUp = () => this.#setHold(false);

  /** Hold button: sent only when it changes. */
  #setHold(on) {
    if (this.spectating) return;
    if (on === this.holdOn) return;
    this.holdOn = on;
    this.ctx.sendInput({ hold: on });
  }

  #onKey = (e) => {
    const down = e.type === 'keydown';
    if (e.key === 'm' || e.key === 'M') {
      if (down && !e.repeat) this.#toggleMute();
      return;
    }
    if (this.spectating) return; // nothing below applies to a spectator
    if (e.key === ' ') { // Space = hold, for keyboard players
      e.preventDefault();
      this.#setHold(down);
      return;
    }
    if (['ArrowLeft', 'ArrowUp', 'a', 'A', 'w', 'W'].includes(e.key)) this.ccw = down;
    else if (['ArrowRight', 'ArrowDown', 'd', 'D', 's', 'S'].includes(e.key)) this.cw = down;
    else return;
    e.preventDefault();
    if (down) this.sfx.unlock();
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

  #toggleMute = () => {
    this.sfx.setMuted(!this.sfx.muted);
    this.#syncMuteButton();
  };

  #syncMuteButton() {
    this.muteBtn.textContent = this.sfx.muted ? '🔇' : '🔊';
    this.muteBtn.title = this.sfx.muted ? 'Sound off (M)' : 'Sound on (M)';
  }

  // ── ECS setup ──
  #plane(color, z, rect) {
    const mesh = new THREE.Mesh(this.planeGeo, new THREE.MeshBasicMaterial({ color }));
    if (rect) this.#setRect(mesh, rect, z);
    else mesh.position.z = z;
    return mesh;
  }

  #spawn(component, value, rect, color) {
    const e = this.world.create();
    const mesh = this.#plane(color, 0, rect);
    this.scene.add(mesh);
    this.world.add(e, component, value);
    this.world.add(e, Render, { meshes: [mesh] });
  }

  #setRect(mesh, r, z = 0, sx = 1, sy = 1) {
    mesh.position.set(r.x, ARENA - r.y, z);
    mesh.scale.set(r.w * sx, r.h * sy, 1);
  }

  // ── systems ──
  #frame = (now) => {
    this.raf = requestAnimationFrame(this.#frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.#sendMouse();
    this.#eventSystem(now);
    const s = this.buffer.sample();
    if (s) {
      this.#interpolationSystem(s.a, s.b, s.alpha);
      this.#juiceSystem(dt);
      this.#renderSystem(now);
    }
    this.#fxSystem(dt);
    this.#shakeSystem(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /** Applies the interpolated snapshot to the client world. */
  #interpolationSystem(a, b, alpha) {
    const w = this.world;
    this.alive = b.alive;
    for (const e of w.query(PaddleC)) {
      const pd = w.get(e, PaddleC);
      let t = lerp(a.paddles[pd.slot], b.paddles[pd.slot], alpha);
      if (pd.slot === this.ctx.me.slot && this.instant && this.mouseT !== null) t = this.mouseT; // prediction
      pd.t = t;
    }
    for (const e of w.query(BrickC, Render)) {
      const { slot, idx } = w.get(e, BrickC);
      w.get(e, Render).meshes[0].visible = (b.bricks[slot] & (1 << idx)) !== 0;
    }
    for (const e of w.query(KingC, Render)) {
      w.get(e, Render).meshes[0].visible = b.alive[w.get(e, KingC).slot];
    }

    const seen = new Set();
    for (const nb of b.balls) {
      const prev = a.balls.find((x) => x.id === nb.id) ?? nb;
      let e = this.balls.get(nb.id);
      if (e === undefined) {
        e = w.create();
        // outer group = impact squash (aligned to the surface normal), inner mesh = speed stretch (aligned to the velocity)
        const outer = new THREE.Group();
        const inner = new THREE.Mesh(this.circleGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
        outer.add(inner);
        this.scene.add(outer);
        w.add(e, BallC, { id: nb.id });
        w.add(e, Pos, { x: nb.x, y: nb.y });
        w.add(e, Vel, { x: nb.vx, y: nb.vy, sp: Math.hypot(nb.vx, nb.vy), h: 0 });
        const aim = this.#plane('#ffffff', 0.08); // dotted-ish guide line shown while the ball is held
        aim.material.transparent = true;
        aim.material.opacity = 0.5;
        aim.visible = false;
        this.scene.add(aim);
        w.add(e, Render, { meshes: [outer], inner, aim });
        w.add(e, Juice, { x: 0, v: 0, ang: 0, born: performance.now(), flash: 0 });
        this.balls.set(nb.id, e);
      }
      const p = w.get(e, Pos);
      p.x = lerp(prev.x, nb.x, alpha);
      p.y = lerp(prev.y, nb.y, alpha);
      const v = w.get(e, Vel); // direction from the newer snapshot, speed blended (so a bounce doesn't flip the stretch around)
      v.x = nb.vx;
      v.y = nb.vy;
      v.sp = lerp(Math.hypot(prev.vx ?? nb.vx, prev.vy ?? nb.vy), Math.hypot(nb.vx, nb.vy), alpha);
      v.h = nb.h ?? 0; // held by slot (h - 1)
      v.ax = nb.ax ?? 0; // launch direction while held (server computed)
      v.ay = nb.ay ?? 0;
      v.c = nb.c ?? 0; //   pickup cooldown: 1 = just launched (blue) -> 0 = white
      seen.add(nb.id);
    }
    for (const [id, e] of this.balls) {
      if (seen.has(id)) continue;
      const r = w.get(e, Render);
      this.scene.remove(r.meshes[0], r.aim);
      r.inner.material.dispose(); // the geometry is shared
      r.aim.material.dispose();
      w.destroy(e);
      this.balls.delete(id);
    }
  }

  /** Damped springs: a hit kicks `v`, `x` then wobbles back to 0. x > 0 = squashed, x < 0 = stretched. */
  #juiceSystem(dt) {
    const w = this.world;
    const step = Math.min(dt, 1 / 30);
    for (const e of w.query(Juice)) {
      const j = w.get(e, Juice);
      j.v += (-SPRING_K * j.x - SPRING_C * j.v) * step;
      j.x += j.v * step;
    }
  }

  /** Turns world state (+ springs) into mesh transforms. */
  #renderSystem(now) {
    const w = this.world;
    for (const e of w.query(PaddleC, Render, Juice)) {
      const { slot, t } = w.get(e, PaddleC);
      const { meshes } = w.get(e, Render);
      const j = w.get(e, Juice);
      const rects = paddleRects(slot, t);
      const x = clamp(j.x, -0.5, 0.6);
      const along = 1 + 0.25 * x; //  a hit squeezes the paddle thinner and stretches it a bit
      const across = 1 - 0.55 * x;
      const flicker = !this.reduced && now < j.flash && Math.floor(now / 45) % 2 === 0;
      meshes.forEach((m, i) => {
        const r = rects[i];
        m.visible = this.alive[slot] && r !== undefined;
        if (!r) return;
        this.#setRect(m, r, 0.05, r.horiz ? along : across, r.horiz ? across : along);
        m.material.color.copy(flicker ? this.white : this.colors[slot]);
      });
    }
    for (const e of w.query(BallC, Pos, Vel, Render, Juice)) {
      const p = w.get(e, Pos);
      const v = w.get(e, Vel);
      const { meshes, inner, aim } = w.get(e, Render);
      const j = w.get(e, Juice);
      const outer = meshes[0];
      outer.position.set(p.x, ARENA - p.y, 0.1);
      const velAng = Math.atan2(-v.y, v.x);
      if (Math.abs(j.x) < 0.02 && Math.abs(j.v) < 0.6) j.ang = velAng; // at rest: no impact axis
      const q = v.sp / this.baseSpeed;
      const stretch = 1 + clamp(0.1 + 0.25 * (q - 1), 0, 0.6); // faster = longer
      const age = (now - j.born) / 1000;
      const pop = age < 0.28 ? easeOutBack(age / 0.28) : 1; //     new balls pop in with a little overshoot
      const sq = clamp(j.x, -0.5, 0.6);
      outer.rotation.z = j.ang;
      outer.scale.set(pop * (1 - 0.8 * sq), pop * (1 + 0.5 * sq), 1);
      inner.rotation.z = velAng - j.ang;
      inner.scale.set(stretch, 1 / Math.sqrt(stretch), 1);
      inner.material.color.copy(this.white).lerp(this.blue, clamp(v.c, 0, 1)); // blue right after launch, fading back to white
      aim.visible = v.h > 0 && (v.ax !== 0 || v.ay !== 0);
      if (aim.visible) { // where the ball will go if released now
        const d = { x: v.ax, y: v.ay };
        const len = 90;
        aim.position.set(p.x + d.x * (BALL_R + len / 2), ARENA - (p.y + d.y * (BALL_R + len / 2)), 0.08);
        aim.rotation.z = Math.atan2(-d.y, d.x);
        aim.scale.set(len, 2.5, 1);
      }
    }
  }

  // ── events (sounds + juice) ──
  #eventSystem(now) {
    while (this.queue.length && this.queue[0].at <= now) {
      const { at, ev } = this.queue.shift();
      if (now - at < 250) this.#fire(ev); // stale (tab was in the background): skip
    }
  }

  #fire(ev) {
    const power = ev.p ?? 0;
    const pan = clamp((ev.x / ARENA) * 2 - 1, -1, 1) * 0.7;
    const gesture = { pan, power };
    switch (ev.k) {
      case 'wall':
        this.sfx.play('wall', gesture);
        this.#kick(SHAKE.wall * (0.7 + 0.6 * power));
        this.#squashBall(ev, 6 + 6 * power);
        break;
      case 'paddle': {
        this.sfx.play('paddle', gesture);
        this.#kick(SHAKE.paddle);
        this.#squashBall(ev, 6 + 6 * power);
        const j = this.world.get(this.paddles[ev.s], Juice);
        j.v = Math.min(14, j.v + 9 + 7 * power);
        j.flash = performance.now() + FLICKER_MS;
        this.#burst(ev.x, ev.y, [COLORS[ev.s], '#ffffff'], 4, 160, 5, 0.25, Math.atan2(ev.ny, ev.nx), 1.6);
        break;
      }
      case 'brick': {
        this.sfx.play('brick', gesture);
        this.#kick(SHAKE.brick);
        this.#squashBall(ev, 5 + 5 * power);
        const r = brickRect(ev.s, ev.i);
        this.#burst(r.x, r.y, [COLORS[ev.s], '#ffffff'], 7, 220, 7, 0.45, Math.atan2(ev.ny, ev.nx), 2.2);
        break;
      }
      case 'king': {
        this.sfx.play('king', gesture);
        this.#kick(SHAKE.king);
        this.#squashBall(ev, 12);
        const r = kingRect(ev.s);
        this.#burst(r.x, r.y, [COLORS[ev.s], '#ffffff', '#f8fafc'], 30, 380, 9, 0.8);
        this.#ring(r.x, r.y, '#ffffff', 90);
        break;
      }
      case 'catch': {
        this.sfx.play('catch', gesture);
        this.#kick(SHAKE.paddle);
        this.#squashBall(ev, 10);
        const j = this.world.get(this.paddles[ev.s], Juice);
        j.v = Math.min(14, j.v + 8);
        this.#burst(ev.x, ev.y, [COLORS[ev.s], '#ffffff'], 3, 90, 4, 0.2, Math.atan2(ev.ny, ev.nx), 1.6);
        break;
      }
      case 'launch': {
        this.sfx.play('launch', gesture);
        this.#squashBall({ b: ev.b, nx: -ev.nx, ny: -ev.ny }, 9); // squash against the release direction, then spring out
        this.#burst(ev.x, ev.y, [COLORS[ev.s], '#ffffff'], 5, 200, 5, 0.25, Math.atan2(ev.ny, ev.nx) + Math.PI, 1.2);
        break;
      }
      case 'spawn':
        this.sfx.play('spawn', gesture);
        this.#ring(ev.x, ev.y, '#ffffff', 46);
        break;
    }
  }

  #kick(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  #squashBall(ev, impulse) {
    const e = this.balls.get(ev.b);
    if (e === undefined) return;
    const j = this.world.get(e, Juice);
    j.ang = Math.atan2(-ev.ny, ev.nx); // squash along the surface normal (screen y is flipped)
    j.v = Math.min(16, j.v + impulse);
  }

  #shakeSystem(dt) {
    this.shake *= Math.exp(-SHAKE_DECAY * dt);
    if (this.shake < 0.05) this.shake = 0;
    const s = this.reduced ? 0 : this.shake;
    this.camera.position.set(s ? (Math.random() * 2 - 1) * s : 0, s ? (Math.random() * 2 - 1) * s : 0, 0);
  }

  // ── particles ──
  #addFx(mesh, fx, x, y, vx, vy) {
    const e = this.world.create();
    this.scene.add(mesh);
    this.world.add(e, Fx, fx);
    this.world.add(e, Pos, { x, y });
    this.world.add(e, Vel, { x: vx, y: vy });
    this.world.add(e, Render, { meshes: [mesh] });
    this.fxCount++;
  }

  /** Little squares flying out; `ang` (+/- spread/2) aims them, otherwise all directions. Coordinates are game coordinates. */
  #burst(x, y, colors, count, speed, size, life, ang = null, spread = Math.PI * 2) {
    for (let i = 0; i < count && this.fxCount < MAX_FX; i++) {
      const a = ang === null ? Math.random() * Math.PI * 2 : ang + (Math.random() - 0.5) * spread;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const mesh = new THREE.Mesh(this.planeGeo, new THREE.MeshBasicMaterial({
        color: colors[i % colors.length], transparent: true,
      }));
      const l = life * (0.7 + Math.random() * 0.5);
      this.#addFx(mesh, { kind: 'spark', life: l, max: l, size, spin: (Math.random() - 0.5) * 16 }, x, y, Math.cos(a) * sp, Math.sin(a) * sp);
    }
  }

  /** An expanding fading ring. */
  #ring(x, y, color, radius) {
    if (this.fxCount >= MAX_FX) return;
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    this.#addFx(mesh, { kind: 'ring', life: 0.4, max: 0.4, r0: BALL_R, r1: radius, size: 0, spin: 0 }, x, y, 0, 0);
  }

  #fxSystem(dt) {
    const w = this.world;
    for (const e of w.query(Fx, Pos, Vel, Render)) {
      const f = w.get(e, Fx);
      const mesh = w.get(e, Render).meshes[0];
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(mesh);
        mesh.material.dispose();
        w.destroy(e);
        this.fxCount--;
        continue;
      }
      const k = f.life / f.max;
      const p = w.get(e, Pos);
      const v = w.get(e, Vel);
      const drag = Math.exp(-3 * dt);
      p.x += v.x * dt;
      p.y += v.y * dt;
      v.x *= drag;
      v.y *= drag;
      mesh.position.set(p.x, ARENA - p.y, 0.2);
      if (f.kind === 'ring') {
        const r = lerp(f.r0, f.r1, 1 - k * k);
        mesh.scale.set(r, r, 1);
      } else {
        mesh.scale.set(f.size * k, f.size * k, 1);
        mesh.rotation.z += f.spin * dt;
      }
      mesh.material.opacity = k;
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

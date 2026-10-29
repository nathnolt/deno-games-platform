import { el } from '../../client/dom.js'; // the shell's tiny DOM helper
import {
  ARENA_H, ARENA_W, COLORS, COLS, HIT_R, KEEPS, KEEP_AT, N, ROWS, TERRAIN, TILE,
  ZONE_PAD, inForeignZone, meta, pieceCells, pieceSize, ringRect,
} from './shared.js';
import { Sfx } from './audio.js';

/**
 * Client side: no simulation. The server sends a compact snapshot every tick (phase, timer, cannons, balls in the
 * air, scores, and, only when it changed, the wall / territory map). This view draws it on a Canvas 2D and turns
 * the MOUSE into intents:
 *
 *   place phase   move: a 2x2 cannon follows the pointer · left click: put it down
 *   battle        move: aim · left click: fire the ready cannon closest to the target (hold = keep firing)
 *   build phase   move: the wall piece follows the pointer · left click: place · right click / wheel: rotate
 *                 · middle click: throw the piece away (if the room's "discard" setting allows it)
 *                 Other players' castle zones and territory are off limits (hatched on the board).
 *
 * Keyboard extras (optional): R or Space rotate, X discards, M mutes.
 * The client never decides anything: the server validates every click.
 */

const HEADER_H = 50; //   px: players + timer strip above the arena (see .rp-head in the CSS)
const FOOTER_H = 30; //   px: the one-line hint below it
const BANNER_MS = 2200;
const TOAST_MS = 2800;
const FIRE_REPEAT_MS = 120; // while the button is held
const MAX_PARTICLES = 320;

const PHASE_NAME = { ready: 'Get ready', place: 'Place cannons', battle: 'Battle', build: 'Rebuild walls', result: 'Round over' };
const PHASE_SUB = {
  place: 'Drop your new cannons inside your walls',
  battle: 'Break their walls. Keep yours closed.',
  build: 'Close your castle with the falling pieces',
};

// ── small colour helpers ──
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (c, to, a) => {
  const x = hex(c);
  const y = hex(to);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * a)},${Math.round(x[1] + (y[1] - x[1]) * a)},${Math.round(x[2] + (y[2] - x[2]) * a)})`;
};
const rgba = (c, a) => { const x = hex(c); return `rgba(${x[0]},${x[1]},${x[2]},${a})`; };
const PAL = COLORS.map((c) => ({ base: c, light: mix(c, '#ffffff', 0.38), dark: mix(c, '#000000', 0.42), mortar: mix(c, '#000000', 0.62), tint: rgba(c, 0.15) }));
const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class RampartsView {
  constructor(ctx) {
    this.ctx = ctx;
    this.me = ctx.me.slot;
    this.spectating = this.me < 0;
    this.maxHp = ctx.room.settings.cannonHp ?? 2;
    this.maxRounds = ctx.room.settings.maxRounds ?? 8;
    this.discardMode = ctx.room.settings.discard ?? 'any'; // 'any' | 'stuck' | 'never'
    this.hatch = null; //   lazily created pattern for other players' protected zones
    this.names = new Map(ctx.room.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p.name]));
    this.sfx = new Sfx();
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // state mirrored from the server
    this.snap = null;
    this.snapAt = 0;
    this.gridStr = '';
    this.wallOwner = new Int8Array(N).fill(-1);
    this.terrOwner = new Int8Array(N).fill(-1);
    this.occ = new Uint8Array(N);
    this.cannons = [];
    this.phase = '';
    this.ended = false;

    // local state
    this.mx = -1000; //  pointer in arena units (800 x 560)
    this.my = -1000;
    this.rot = 0;
    this.lastPi = -1;
    this.holding = false;
    this.lastFire = 0;
    this.aim = new Map(); //   cannon id -> barrel angle
    this.recoil = new Map(); // cannon id -> 1..0
    this.particles = [];
    this.pops = []; //         freshly built wall tiles: {i, t0}
    this.rings = []; //        expanding rings: {x, y, t0, color}
    this.shake = 0;
    this.layerDirty = true;
    this.timers = new Set();
    this.k = 1; //              canvas pixels per arena unit
    this.last = performance.now();

    // DOM: header (players + timer) / stage (canvas + banner) / footer (hint)
    this.chips = el('div', { class: 'rp-chips' });
    this.phaseName = el('span', { class: 'rp-phase-name' });
    this.timeEl = el('span', { class: 'rp-time' });
    this.roundEl = el('span', { class: 'rp-round' });
    this.muteBtn = el('button', { class: 'rp-mute', type: 'button', onclick: this.#toggleMute });
    this.head = el('div', { class: 'rp-head' }, this.chips, el('div', { class: 'rp-clock' }, this.phaseName, this.timeEl), el('div', { class: 'rp-side' }, this.roundEl, this.muteBtn));
    this.canvas = el('canvas', { class: 'rp-canvas' });
    this.banner = el('div', { class: 'rp-banner' });
    this.toasts = el('div', { class: 'rp-toasts' });
    this.stage = el('div', { class: 'rp-stage' }, this.canvas, this.banner, this.toasts);
    this.hint = el('div', { class: 'rp-hint' });
    this.root = el('div', { class: 'rp-root' }, this.head, this.stage, this.hint);
    ctx.container.append(this.root);
    this.g = this.canvas.getContext('2d');
    this.terrainCanvas = document.createElement('canvas');
    this.layerCanvas = document.createElement('canvas');
    this.#syncMuteButton();
    this.#setHint();

    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(ctx.container);
    this.#resize();

    this.canvas.addEventListener('pointerdown', this.#onDown);
    this.canvas.addEventListener('contextmenu', this.#onContext);
    this.canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    this.canvas.addEventListener('auxclick', this.#onContext);
    this.canvas.addEventListener('mousedown', this.#onMouseDown);
    window.addEventListener('pointermove', this.#onMove);
    window.addEventListener('pointerup', this.#onUp);
    window.addEventListener('pointercancel', this.#onUp);
    window.addEventListener('blur', this.#onUp);
    window.addEventListener('keydown', this.#onKey);
    this.sfx.unlock();
    this.raf = requestAnimationFrame(this.#frame);
  }

  // ── GameView ──
  onSnapshot(s) {
    this.snap = s;
    this.snapAt = performance.now();
    if (s.grid && s.grid !== this.gridStr) this.#parseGrid(s.grid);
    this.cannons = s.cn.map((c) => ({ id: c[0], slot: c[1], x: c[2], y: c[3], hp: c[4], ready: c[5], act: c[6] === 1 }));
    this.occ.fill(0);
    for (const c of this.cannons) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.occ[(c.y + dy) * COLS + c.x + dx] = 1;

    if (s.phase !== this.phase) {
      const first = this.phase === '';
      this.phase = s.phase;
      this.#setHint();
      if (PHASE_NAME[s.phase] && s.phase !== 'result') this.#showBanner(PHASE_NAME[s.phase], s.phase === 'ready' ? `Round 1 of ${this.maxRounds}` : PHASE_SUB[s.phase] ?? '');
      if (!first && s.phase !== 'ready') this.sfx.play('phase');
    }
    if (!this.spectating && s.pi && s.pi[this.me] !== this.lastPi) { // a new piece: start unrotated
      this.lastPi = s.pi[this.me];
      this.rot = 0;
    }
    for (const ev of s.ev ?? []) this.#event(ev);
    this.#updateHud(s);
  }

  onEnd(result) {
    this.ended = true;
    this.holding = false;
    this.canvas.style.cursor = 'default';
    const order = [0, 1, 2, 3].filter((slot) => result.scores?.[slot] !== undefined && this.#isSeat(slot)).sort((a, b) => (result.winner === a ? -1 : result.winner === b ? 1 : result.scores[b] - result.scores[a]));
    const title = result.reason === 'abandoned' ? 'Match ended' : result.winner >= 0 ? `${this.#name(result.winner)} wins!` : 'Match ended';
    const why = { last: 'Last castle standing', rounds: 'Most points after the final round', 'humans-out': 'All human players are out', abandoned: 'Everyone left' }[result.reason] ?? '';
    this.banner.replaceChildren(
      el('div', { class: 'rp-banner-title' }, title),
      el('div', { class: 'rp-banner-sub' }, why),
      el('div', { class: 'rp-final' }, ...order.map((slot) => el('div', { class: 'rp-final-row' }, el('i', { style: `background:${COLORS[slot]}` }), el('span', {}, this.#name(slot)), el('b', {}, String(result.scores[slot])), el('em', {}, result.alive?.[slot] ? 'standing' : 'out')))),
    );
    this.banner.classList.add('rp-show', 'rp-final-show');
    this.hint.textContent = 'Match over. Use "Back to setup" above to play again.';
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    window.removeEventListener('pointermove', this.#onMove);
    window.removeEventListener('pointerup', this.#onUp);
    window.removeEventListener('pointercancel', this.#onUp);
    window.removeEventListener('blur', this.#onUp);
    window.removeEventListener('keydown', this.#onKey);
    this.canvas.removeEventListener('pointerdown', this.#onDown);
    this.canvas.removeEventListener('contextmenu', this.#onContext);
    this.canvas.removeEventListener('auxclick', this.#onContext);
    this.canvas.removeEventListener('mousedown', this.#onMouseDown);
    this.canvas.removeEventListener('wheel', this.#onWheel);
    this.sfx.dispose();
    this.root.remove();
  }

  // ── helpers ──
  #isSeat(slot) { return this.snap ? this.snap.active[slot] : true; }

  #name(slot) {
    const n = this.names.get(slot) ?? `Bot ${slot + 1}`;
    return slot === this.me ? `${n} (you)` : n;
  }

  #alive() { return !this.spectating && !this.ended && this.snap?.alive[this.me]; }

  #timeout(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  #showBanner(title, sub) {
    this.banner.classList.remove('rp-final-show');
    this.banner.replaceChildren(el('div', { class: 'rp-banner-title' }, title), el('div', { class: 'rp-banner-sub' }, sub));
    this.banner.classList.remove('rp-show');
    void this.banner.offsetWidth; // restart the CSS animation
    this.banner.classList.add('rp-show');
    clearTimeout(this.bannerTimer);
    this.timers.delete(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { this.timers.delete(this.bannerTimer); if (!this.ended) this.banner.classList.remove('rp-show'); }, BANNER_MS);
    this.timers.add(this.bannerTimer);
  }

  #toast(text, color) {
    const t = el('div', { class: 'rp-toast' }, el('i', { style: `background:${color ?? '#e2e8f0'}` }), text);
    this.toasts.append(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    this.#timeout(() => t.remove(), TOAST_MS);
  }

  #setHint() {
    let t;
    if (this.spectating) t = 'You are watching this match. M mutes.';
    else if (this.snap && !this.snap.alive[this.me]) t = 'You are out of the match. Watching the rest. M mutes.';
    else {
      t = {
        ready: 'Get ready. The mouse does everything.',
        place: 'Move the mouse and click to set a cannon inside your walls. Cannons outside the walls cannot fire.',
        battle: 'Aim with the mouse, click to fire (hold to keep firing). One broken wall tile opens a castle. Keep yours closed.',
        build: `Click to place wall pieces. Right click or scroll rotates.${{ any: ' Middle click or X throws a piece away.', stuck: ' Middle click or X throws a piece away if it fits nowhere.', never: '' }[this.discardMode] ?? ''} You cannot build in another player's castle.`,
        result: 'Round over.',
      }[this.phase] ?? '';
    }
    this.hint.textContent = t;
  }

  #resize() {
    const host = this.ctx.container;
    const w = host.clientWidth || ARENA_W;
    const h = host.clientHeight || ARENA_H + HEADER_H + FOOTER_H;
    const scale = Math.max(0.2, Math.min((w - 4) / ARENA_W, (h - HEADER_H - FOOTER_H - 4) / ARENA_H));
    const cw = Math.floor(ARENA_W * scale);
    const ch = Math.floor(ARENA_H * scale);
    this.root.style.width = `${cw}px`;
    this.stage.style.width = `${cw}px`;
    this.stage.style.height = `${ch}px`;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.k = this.canvas.width / ARENA_W;
    for (const c of [this.terrainCanvas, this.layerCanvas]) { c.width = this.canvas.width; c.height = this.canvas.height; }
    this.#drawTerrain();
    this.layerDirty = true;
    this.root.style.fontSize = `${clamp(cw / 62, 11, 17)}px`;
  }

  #parseGrid(str) {
    const prevWall = this.wallOwner.slice();
    this.gridStr = str;
    for (let i = 0; i < N; i++) {
      const c = str.charCodeAt(i);
      if (c >= 97) { this.wallOwner[i] = c - 97; this.terrOwner[i] = -1; } else if (c >= 65) { this.wallOwner[i] = -1; this.terrOwner[i] = c - 65; } else { this.wallOwner[i] = -1; this.terrOwner[i] = -1; }
    }
    if (this.phase === 'build') {
      const now = performance.now();
      for (let i = 0; i < N; i++) if (this.wallOwner[i] >= 0 && prevWall[i] < 0) this.pops.push({ i, t0: now });
      if (this.pops.length > 120) this.pops.splice(0, this.pops.length - 120);
    }
    this.layerDirty = true;
  }

  /** The pointer in arena units, or null while it is not over the board. */
  #pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return null;
    return { x: ((e.clientX - r.left) / r.width) * ARENA_W, y: ((e.clientY - r.top) / r.height) * ARENA_H };
  }

  // ── input (all mouse) ──
  #onMove = (e) => {
    const p = this.#pointer(e);
    if (p) { this.mx = p.x; this.my = p.y; }
  };

  #onDown = (e) => {
    this.sfx.unlock();
    const p = this.#pointer(e);
    if (!p) return;
    this.mx = p.x;
    this.my = p.y;
    if (!this.#alive()) return;
    if (e.button === 1) { e.preventDefault(); this.#discard(); return; }
    if (e.button === 2) { if (this.phase === 'build') this.#rotate(1); return; }
    if (e.button !== 0) return;
    if (this.phase === 'battle') {
      this.holding = true;
      this.lastFire = 0;
      this.#tryFire(performance.now());
    } else if (this.phase === 'place') {
      this.#clickCannon();
    } else if (this.phase === 'build') {
      this.#clickPiece();
    }
  };

  #onUp = () => { this.holding = false; };

  #onContext = (e) => { e.preventDefault(); };

  #onMouseDown = (e) => { if (e.button === 1) e.preventDefault(); }; // no middle-click autoscroll

  #onWheel = (e) => {
    if (this.phase !== 'build' || !this.#alive()) return;
    e.preventDefault();
    this.#rotate(e.deltaY > 0 ? 1 : -1);
  };

  #onKey = (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyM') { this.#toggleMute(); return; }
    if (!this.#alive() || this.phase !== 'build') return;
    if (e.code === 'KeyR' || e.code === 'Space') { e.preventDefault(); this.#rotate(e.shiftKey ? -1 : 1); } else if (e.code === 'KeyX') this.#discard();
  };

  #rotate(d) {
    this.rot = (this.rot + d + 4) & 3;
    this.sfx.play('place', { power: 0.2 });
  }

  #discard() {
    if (this.phase !== 'build' || !this.#alive()) return;
    if (this.discardMode === 'never' || (this.discardMode === 'stuck' && this.#fitsAnywhere())) { this.sfx.play('deny'); return; }
    this.ctx.sendInput({ d: 1 }); // the server has the last word (cooldown, rule)
  }

  /** Does my current piece fit anywhere? (same test the server uses for the 'stuck' rule) */
  #fitsAnywhere() {
    const t = this.snap?.pq?.[this.me]?.[0];
    if (t === undefined) return true;
    for (let rot = 0; rot < 4; rot++) {
      const cells = pieceCells(t, rot);
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (this.#pieceOk({ cells, x, y })) return true;
    }
    return false;
  }

  #cannonSpot() { return [Math.round(this.mx / TILE - 1), Math.round(this.my / TILE - 1)]; }

  #pieceSpot() {
    const cells = this.#myCells();
    if (!cells) return null;
    const { w, h } = pieceSize(cells);
    return { cells, x: Math.round(this.mx / TILE - w / 2), y: Math.round(this.my / TILE - h / 2) };
  }

  #myCells() {
    const t = this.snap?.pq?.[this.me]?.[0];
    return t === undefined ? null : pieceCells(t, this.rot);
  }

  #tileFree(i) { return !TERRAIN[i] && this.wallOwner[i] < 0 && KEEP_AT[i] < 0 && !this.occ[i]; }

  /** Off limits for me: inside another living player's castle zone or enclosed territory. */
  #blocked(i) {
    const s = this.snap;
    if (!s) return false;
    if (inForeignZone(this.me, i, s.ko, s.alive)) return true;
    const t = this.terrOwner[i];
    return t >= 0 && t !== this.me && s.alive[t];
  }

  #cannonOk(x, y) {
    if (x < 0 || y < 0 || x + 1 >= COLS || y + 1 >= ROWS) return false;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = (y + dy) * COLS + x + dx;
      if (!this.#tileFree(i) || this.terrOwner[i] !== this.me) return false;
    }
    return true;
  }

  #pieceOk(spot) {
    for (const [cx, cy] of spot.cells) {
      const x = spot.x + cx;
      const y = spot.y + cy;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS || !this.#tileFree(y * COLS + x) || this.#blocked(y * COLS + x)) return false;
    }
    return true;
  }

  #clickCannon() {
    if (!this.snap || this.snap.allow[this.me] <= 0) { this.sfx.play('deny'); return; }
    const [x, y] = this.#cannonSpot();
    if (!this.#cannonOk(x, y)) { this.sfx.play('deny'); return; }
    this.ctx.sendInput({ c: [x, y] });
  }

  #clickPiece() {
    const spot = this.#pieceSpot();
    if (!spot || !this.#pieceOk(spot)) { this.sfx.play('deny'); return; }
    this.ctx.sendInput({ p: [spot.x, spot.y, this.rot] });
  }

  #tryFire(now) {
    if (!this.snap || now - this.lastFire < FIRE_REPEAT_MS) return;
    if (!this.cannons.some((c) => c.slot === this.me && c.act && c.ready >= 1)) return; // nothing ready: don't spam the server
    if (this.mx < 0 || this.my < 0 || this.mx > ARENA_W || this.my > ARENA_H) return;
    this.lastFire = now;
    this.ctx.sendInput({ f: [Math.round(this.mx * 10) / 10, Math.round(this.my * 10) / 10] });
  }

  #toggleMute = () => {
    this.sfx.setMuted(!this.sfx.muted);
    this.#syncMuteButton();
  };

  #syncMuteButton() {
    this.muteBtn.textContent = this.sfx.muted ? '🔇' : '🔊';
    this.muteBtn.title = this.sfx.muted ? 'Sound off (M)' : 'Sound on (M)';
  }

  // ── events from the server: sounds + particles ──
  #event(ev) {
    const pan = ev.x !== undefined ? clamp((ev.x / ARENA_W) * 2 - 1, -1, 1) : 0;
    switch (ev.k) {
      case 'f': {
        this.sfx.play('fire', { pan });
        this.aim.set(ev.c, Math.atan2(ev.ty - ev.y, ev.tx - ev.x));
        this.recoil.set(ev.c, 1);
        const a = Math.atan2(ev.ty - ev.y, ev.tx - ev.x);
        for (let n = 0; n < 7; n++) this.#particle({ x: ev.x + Math.cos(a) * 20, y: ev.y + Math.sin(a) * 20, vx: Math.cos(a) * rnd(30, 90) + rnd(-20, 20), vy: Math.sin(a) * rnd(30, 90) + rnd(-20, 20), life: rnd(0.4, 0.8), size: rnd(4, 9), color: 'rgba(210,210,210,0.55)', kind: 'smoke' });
        this.rings.push({ x: ev.x + Math.cos(a) * 20, y: ev.y + Math.sin(a) * 20, t0: performance.now(), color: '#fde68a', r1: 18, ms: 160 });
        break;
      }
      case 'h': {
        if (ev.d > 0) {
          this.sfx.play('boom', { pan });
          this.#explosion(ev.x, ev.y, 26);
          if (!this.reduced) this.shake = 7;
        } else if (ev.w > 0) {
          this.sfx.play('hit', { pan });
          this.#debris(ev.x, ev.y, 9 + ev.w * 4);
        } else if (ev.c > 0) {
          this.sfx.play('hit', { pan });
          this.#explosion(ev.x, ev.y, 10);
        } else if (ev.wt) {
          this.sfx.play('splash', { pan });
          this.#splash(ev.x, ev.y);
        } else {
          this.sfx.play('thud', { pan });
          this.#dust(ev.x, ev.y, 5);
        }
        break;
      }
      case 'w': this.sfx.play('place', { pan }); break;
      case 'cp':
        this.sfx.play('cannon', { pan });
        this.rings.push({ x: ev.x, y: ev.y, t0: performance.now(), color: COLORS[ev.o], r1: 34, ms: 380 });
        this.#dust(ev.x, ev.y, 8);
        break;
      case 'l':
        this.sfx.play('life');
        this.#toast(`${this.#name(ev.o)} ${ev.r === 'room' ? 'had no room for a cannon' : 'could not close a castle'} and lost a life`, COLORS[ev.o]);
        if (ev.o === this.me) this.#showBanner('Lost a life', ev.r === 'room' ? 'No room left in your castle for a new cannon' : 'Your walls did not enclose a castle');
        break;
      case 'kc':
        if (ev.o >= 0) { this.sfx.play('claim'); this.#toast(`${this.#name(ev.o)} claimed a castle`, COLORS[ev.o]); }
        break;
      case 'x':
        this.#toast(`${this.#name(ev.o)} is out of the match`, COLORS[ev.o]);
        if (ev.o === this.me) this.#setHint();
        break;
    }
  }

  #particle(p) { p.max = p.life; this.particles.push(p); if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES); }

  #debris(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const s = rnd(40, 170);
      this.#particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: rnd(0.4, 0.9), size: rnd(2, 5), color: Math.random() < 0.5 ? '#cbd5e1' : '#94a3b8', kind: 'chip', g: 420 });
    }
    this.#dust(x, y, 4);
  }

  #dust(x, y, n) { for (let i = 0; i < n; i++) this.#particle({ x, y, vx: rnd(-30, 30), vy: rnd(-30, 10), life: rnd(0.4, 0.9), size: rnd(4, 8), color: 'rgba(214,196,160,0.5)', kind: 'smoke' }); }

  #splash(x, y) {
    for (let i = 0; i < 12; i++) { const a = rnd(-Math.PI, 0); const s = rnd(40, 120); this.#particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.4, 0.8), size: rnd(2, 4), color: '#bfe3ff', kind: 'chip', g: 380 }); }
    this.rings.push({ x, y, t0: performance.now(), color: '#bfe3ff', r1: 22, ms: 420 });
  }

  #explosion(x, y, size) {
    for (let i = 0; i < 18; i++) {
      const a = rnd(0, Math.PI * 2);
      const s = rnd(30, 150);
      this.#particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.35, 0.8), size: rnd(3, 8), color: Math.random() < 0.5 ? '#fbbf24' : '#f97316', kind: 'spark' });
    }
    for (let i = 0; i < 8; i++) this.#particle({ x, y, vx: rnd(-40, 40), vy: rnd(-60, -10), life: rnd(0.7, 1.4), size: rnd(8, size / 1.4), color: 'rgba(60,60,60,0.55)', kind: 'smoke' });
    this.rings.push({ x, y, t0: performance.now(), color: '#fde68a', r1: size * 1.6, ms: 320 });
    this.#debris(x, y, 8);
  }

  // ── HUD ──
  #updateHud(s) {
    const t = Math.ceil(s.timer);
    this.timeEl.textContent = s.phase === 'ready' || s.phase === 'result' ? '' : String(t);
    this.timeEl.classList.toggle('rp-urgent', s.phase !== 'ready' && s.phase !== 'result' && s.timer <= 5 && !s.cease);
    this.phaseName.textContent = s.cease && s.phase === 'battle' ? 'Cease fire' : PHASE_NAME[s.phase] ?? '';
    this.roundEl.textContent = s.round ? `Round ${s.round}/${this.maxRounds}` : '';
    const key = JSON.stringify([s.active, s.alive, s.lives, s.score, s.allow, s.tc, s.ko, s.phase, this.cannons.map((c) => c.slot + ':' + (c.act ? 1 : 0))]);
    if (key === this.chipKey) return;
    this.chipKey = key;
    const rows = [];
    for (let slot = 0; slot < 4; slot++) {
      if (!s.active[slot]) continue;
      const owned = this.cannons.filter((c) => c.slot === slot).length;
      const castles = s.ko.filter((o) => o === slot).length;
      const extra = s.phase === 'place' && s.allow[slot] > 0 ? ` +${s.allow[slot]}` : '';
      rows.push(el('div', { class: `rp-chip${s.alive[slot] ? '' : ' rp-out'}${slot === this.me ? ' rp-me' : ''}`, style: `--c:${COLORS[slot]}` },
        el('i', {}),
        el('span', { class: 'rp-chip-name' }, this.#name(slot)),
        el('span', { class: 'rp-chip-lives', title: 'Lives' }, '♥'.repeat(Math.max(0, s.lives[slot])) || '✕'),
        el('span', { class: 'rp-chip-stat', title: 'Castles held' }, `♜${castles}`),
        el('span', { class: 'rp-chip-stat', title: 'Cannons (and new ones to place)' }, `◉${owned}${extra}`),
        el('b', { title: 'Score' }, String(s.score[slot])),
      ));
    }
    this.chips.replaceChildren(...rows);
    this.#setHint();
  }

  // ── rendering ──
  #frame = (now) => {
    this.raf = requestAnimationFrame(this.#frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.holding && this.phase === 'battle' && this.#alive()) this.#tryFire(now);
    this.#updateFx(dt);
    this.#draw(now);
  };

  #updateFx(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.g) p.vy += p.g * dt;
      if (p.kind === 'smoke') { p.vx *= 0.96; p.vy *= 0.96; p.size += dt * 6; }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const [id, r] of this.recoil) { const n = r - dt * 5; if (n <= 0) this.recoil.delete(id); else this.recoil.set(id, n); }
    this.shake = Math.max(0, this.shake - dt * 22);
  }

  #drawTerrain() {
    const g = this.terrainCanvas.getContext('2d');
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        const px = x * TILE;
        const py = y * TILE;
        if (TERRAIN[i]) {
          g.fillStyle = '#1f4a74';
          g.fillRect(px, py, TILE, TILE);
          continue;
        }
        g.fillStyle = (x + y) & 1 ? '#355a33' : '#385f36';
        g.fillRect(px, py, TILE, TILE);
        const h = hash(x, y);
        g.fillStyle = `rgba(0,0,0,${0.03 + h * 0.06})`;
        g.fillRect(px, py, TILE, TILE);
        if (h > 0.72) { // grass tufts
          g.strokeStyle = 'rgba(160,210,120,0.35)';
          g.lineWidth = 1;
          g.beginPath();
          const tx = px + 4 + hash(y, x) * 12;
          const ty = py + 6 + hash(x + 7, y) * 10;
          g.moveTo(tx, ty); g.lineTo(tx - 1.5, ty - 4); g.moveTo(tx, ty); g.lineTo(tx + 1.5, ty - 4);
          g.stroke();
        }
      }
    }
    // shore: a light edge on land tiles next to water
    g.fillStyle = 'rgba(214,196,150,0.55)';
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (TERRAIN[y * COLS + x]) continue;
      const px = x * TILE;
      const py = y * TILE;
      if (x > 0 && TERRAIN[y * COLS + x - 1]) g.fillRect(px, py, 3, TILE);
      if (x < COLS - 1 && TERRAIN[y * COLS + x + 1]) g.fillRect(px + TILE - 3, py, 3, TILE);
      if (y > 0 && TERRAIN[(y - 1) * COLS + x]) g.fillRect(px, py, TILE, 3);
      if (y < ROWS - 1 && TERRAIN[(y + 1) * COLS + x]) g.fillRect(px, py + TILE - 3, TILE, 3);
    }
  }

  /** Walls + territory tint, redrawn only when the server sends a new map. */
  #drawLayer() {
    const g = this.layerCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.layerCanvas.width, this.layerCanvas.height);
    g.setTransform(this.k, 0, 0, this.k, 0, 0);
    for (let i = 0; i < N; i++) {
      const x = i % COLS;
      const y = (i / COLS) | 0;
      const t = this.terrOwner[i];
      if (t >= 0 && !TERRAIN[i]) {
        g.fillStyle = PAL[t].tint;
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
        if (((x + y) & 1) === 0) { g.fillStyle = 'rgba(255,255,255,0.025)'; g.fillRect(x * TILE, y * TILE, TILE, TILE); }
      } else if (t >= 0) {
        g.fillStyle = PAL[t].tint;
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    for (let i = 0; i < N; i++) if (this.wallOwner[i] >= 0) this.#drawWall(g, i, this.wallOwner[i]);
  }

  #drawWall(g, i, slot) {
    const x = (i % COLS) * TILE;
    const y = ((i / COLS) | 0) * TILE;
    const p = PAL[slot];
    g.fillStyle = p.dark;
    g.fillRect(x, y + 3, TILE, TILE - 3); // front face
    g.fillStyle = p.base;
    g.fillRect(x, y, TILE, 4); //          lit top
    g.fillStyle = p.light;
    g.fillRect(x, y, TILE, 1.2);
    // bricks: two courses, offset joints
    g.strokeStyle = p.mortar;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y + 11.5); g.lineTo(x + TILE, y + 11.5);
    g.moveTo(x + 10, y + 3); g.lineTo(x + 10, y + 11.5);
    g.moveTo(x + 5, y + 11.5); g.lineTo(x + 5, y + TILE);
    g.moveTo(x + 15, y + 11.5); g.lineTo(x + 15, y + TILE);
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
  }

  #draw(now) {
    const g = this.g;
    if (this.layerDirty) { this.#drawLayer(); this.layerDirty = false; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const sh = this.shake > 0 ? this.shake : 0;
    const ox = sh ? rnd(-sh, sh) * this.k : 0;
    const oy = sh ? rnd(-sh, sh) * this.k : 0;
    g.drawImage(this.terrainCanvas, ox, oy);
    g.setTransform(this.k, 0, 0, this.k, ox, oy);
    this.#drawWater(g, now);
    g.setTransform(1, 0, 0, 1, ox, oy);
    g.drawImage(this.layerCanvas, 0, 0);
    g.setTransform(this.k, 0, 0, this.k, ox, oy);
    const s = this.snap;
    if (!s) return;
    this.#drawPops(g, now);
    this.#drawZones(g);
    for (let k = 0; k < KEEPS.length; k++) this.#drawKeep(g, k, s.ko[k], now);
    for (const c of this.cannons) this.#drawCannon(g, c, now);
    this.#drawBalls(g, now);
    this.#drawRings(g, now);
    this.#drawParticles(g);
    this.#drawCursor(g, now);
    this.#drawQueue(g);
    this.canvas.style.cursor = this.#alive() && (this.phase === 'battle' || this.phase === 'place' || this.phase === 'build') ? 'none' : 'default';
  }

  #drawWater(g, now) {
    const t = now / 1000;
    g.strokeStyle = 'rgba(190,225,255,0.28)';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (!TERRAIN[y * COLS + x]) continue;
      const px = x * TILE;
      const py = y * TILE;
      const o = Math.sin(t * 1.6 + x * 1.3 + y * 0.7) * 2;
      g.moveTo(px + 3 + o, py + 6); g.quadraticCurveTo(px + 8 + o, py + 3, px + 13 + o, py + 6);
      g.moveTo(px + 6 - o, py + 14); g.quadraticCurveTo(px + 11 - o, py + 11, px + 16 - o, py + 14);
    }
    g.stroke();
  }

  #drawPops(g, now) {
    this.pops = this.pops.filter((p) => now - p.t0 < 320);
    for (const p of this.pops) {
      const a = 1 - (now - p.t0) / 320;
      g.fillStyle = `rgba(255,255,255,${0.55 * a})`;
      g.fillRect((p.i % COLS) * TILE, ((p.i / COLS) | 0) * TILE, TILE, TILE);
    }
  }

  /** Build phase: hatch the castle zones of the other players, because walls cannot go there. */
  #drawZones(g) {
    if (this.phase !== 'build' || !this.#alive()) return;
    const s = this.snap;
    if (!this.hatch) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const p = c.getContext('2d');
      p.strokeStyle = 'rgba(255,255,255,0.2)';
      p.lineWidth = 1.5;
      p.beginPath(); p.moveTo(-1, 9); p.lineTo(9, -1); p.moveTo(-1, 1); p.lineTo(1, -1); p.moveTo(7, 9); p.lineTo(9, 7); p.stroke();
      this.hatch = g.createPattern(c, 'repeat');
    }
    g.save();
    g.setLineDash([6, 5]);
    g.lineWidth = 1.5;
    s.ko.forEach((o, k) => {
      if (o < 0 || o === this.me || !s.alive[o]) return;
      const r = ringRect(k);
      const x = Math.max(0, r.x0 - ZONE_PAD) * TILE;
      const y = Math.max(0, r.y0 - ZONE_PAD) * TILE;
      const w = (Math.min(COLS - 1, r.x1 + ZONE_PAD) + 1) * TILE - x;
      const h = (Math.min(ROWS - 1, r.y1 + ZONE_PAD) + 1) * TILE - y;
      if (this.hatch) { g.fillStyle = this.hatch; g.fillRect(x, y, w, h); }
      g.strokeStyle = rgba(COLORS[o], 0.7);
      g.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    });
    g.restore();
  }

  #drawKeep(g, k, owner, now) {
    const px = KEEPS[k].x * TILE;
    const py = KEEPS[k].y * TILE;
    const col = owner >= 0 ? COLORS[owner] : '#cbd5e1';
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(px + 3, py + 34, 36, 6);
    g.fillStyle = owner >= 0 ? mix(col, '#000000', 0.35) : '#64748b'; // plinth in the owner's colour
    g.fillRect(px + 1, py + 31, 38, 8);
    g.fillStyle = '#aab6c8';
    g.fillRect(px + 5, py + 12, 30, 21); //   keep body
    g.fillStyle = '#8795ab';
    g.fillRect(px + 5, py + 27, 30, 6);
    g.fillStyle = '#c7d0de';
    g.fillRect(px + 5, py + 12, 30, 3);
    for (const tx of [px + 2, px + 29]) { //  two towers
      g.fillStyle = '#9aa7bb';
      g.fillRect(tx, py + 6, 9, 27);
      g.fillStyle = '#c7d0de';
      g.fillRect(tx, py + 6, 9, 2.5);
      g.fillStyle = '#9aa7bb';
      for (let b = 0; b < 3; b++) g.fillRect(tx + b * 3.4, py + 3, 2.2, 3.5); // crenellations
    }
    g.fillStyle = '#3b4252'; //               gate
    g.beginPath();
    g.moveTo(px + 15, py + 33); g.lineTo(px + 15, py + 24); g.quadraticCurveTo(px + 20, py + 18, px + 25, py + 24); g.lineTo(px + 25, py + 33);
    g.fill();
    g.fillStyle = '#d9a441'; //               small window
    g.fillRect(px + 18.5, py + 15.5, 3, 4);
    const f = Math.sin(now / 180 + k) * 1.8; // flag
    g.strokeStyle = '#475569';
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(px + 20, py + 12); g.lineTo(px + 20, py - 3); g.stroke();
    g.fillStyle = col;
    g.beginPath(); g.moveTo(px + 20.5, py - 3); g.lineTo(px + 30 + f, py + 0.5 + f * 0.3); g.lineTo(px + 20.5, py + 4.5); g.closePath(); g.fill();
  }

  #drawCannon(g, c, now) {
    const cx = (c.x + 1) * TILE;
    const cy = (c.y + 1) * TILE;
    const col = COLORS[c.slot];
    const inside = [0, 1].every((dy) => [0, 1].every((dx) => this.terrOwner[(c.y + dy) * COLS + c.x + dx] === c.slot));
    const working = this.phase === 'battle' ? c.act : inside;
    const mine = c.slot === this.me && this.#alive();
    let ang = this.aim.get(c.id) ?? Math.atan2(ARENA_H / 2 - cy, ARENA_W / 2 - cx); // idle cannons face the middle of the map
    if (mine && this.phase === 'battle' && working) ang = Math.atan2(this.my - cy, this.mx - cx); // yours follow the mouse
    this.aim.set(c.id, ang);
    const rec = (this.recoil.get(c.id) ?? 0) * 5;
    g.save();
    g.globalAlpha = working ? 1 : 0.5;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(cx + 2, cy + 3, 16, 14, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2b3342'; //  carriage
    g.beginPath(); g.arc(cx, cy, 15, 0, Math.PI * 2); g.fill();
    g.lineWidth = 3;
    g.strokeStyle = col;
    g.stroke();
    g.fillStyle = '#3d4658';
    g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill();
    g.translate(cx, cy);
    g.rotate(ang);
    g.translate(-rec, 0);
    g.fillStyle = '#10141c'; //  barrel
    g.fillRect(-2, -4.5, 22, 9);
    g.fillStyle = '#4b5565';
    g.fillRect(-2, -4.5, 22, 2.5);
    g.fillStyle = '#10141c';
    g.fillRect(17, -5.5, 4, 11);
    g.fillStyle = '#1b2230';
    g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill();
    g.restore();
    if (c.hp < this.maxHp) { // cracks when damaged
      g.strokeStyle = 'rgba(255,120,80,0.9)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx - 8, cy - 11); g.lineTo(cx - 3, cy - 4); g.lineTo(cx - 7, cy + 1); g.lineTo(cx - 2, cy + 9); g.stroke();
    }
    if (this.phase === 'battle' && working) { // reload ring
      if (c.ready < 1) {
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.ready); g.stroke();
      } else if (mine) {
        g.strokeStyle = rgba(col, 0.55 + 0.25 * Math.sin(now / 160));
        g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, 18, 0, Math.PI * 2); g.stroke();
      }
    }
    if (!working && this.phase !== 'ready' && this.phase !== 'result') { // not inside the walls: a small red cross
      g.strokeStyle = 'rgba(248,113,113,0.95)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - 6, cy - 6); g.lineTo(cx + 6, cy + 6); g.moveTo(cx + 6, cy - 6); g.lineTo(cx - 6, cy + 6); g.stroke();
    }
  }

  #drawBalls(g, now) {
    const s = this.snap;
    const since = (now - this.snapAt) / 1000;
    for (const b of s.balls) {
      const [, owner, x0, y0, x1, y1, p0, dur] = b;
      const p = clamp(p0 + since / dur, 0, 1);
      const gx = x0 + (x1 - x0) * p;
      const gy = y0 + (y1 - y0) * p;
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const h = Math.sin(Math.PI * p) * Math.min(70, 12 + dist * 0.18);
      // target marker
      const pulse = 0.5 + 0.5 * Math.sin(now / 90);
      g.strokeStyle = rgba(COLORS[owner], 0.35 + 0.3 * pulse);
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(x1, y1, HIT_R + 2 + (1 - p) * 4, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(x1 - 4, y1); g.lineTo(x1 + 4, y1); g.moveTo(x1, y1 - 4); g.lineTo(x1, y1 + 4); g.stroke();
      // shadow on the ground, ball in the air
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.ellipse(gx, gy, 5 - h * 0.02, 3, 0, 0, Math.PI * 2); g.fill();
      const r = 4.5 + Math.sin(Math.PI * p) * 1.6;
      g.fillStyle = '#0f1218';
      g.beginPath(); g.arc(gx, gy - h, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.beginPath(); g.arc(gx - r * 0.35, gy - h - r * 0.35, r * 0.32, 0, Math.PI * 2); g.fill();
      g.strokeStyle = rgba(COLORS[owner], 0.9);
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(gx, gy - h, r + 0.8, 0, Math.PI * 2); g.stroke();
    }
  }

  #drawRings(g, now) {
    this.rings = this.rings.filter((r) => now - r.t0 < r.ms);
    for (const r of this.rings) {
      const a = (now - r.t0) / r.ms;
      g.strokeStyle = rgba(r.color.length === 7 ? r.color : '#ffffff', 1 - a);
      g.lineWidth = 2.5 * (1 - a) + 0.5;
      g.beginPath(); g.arc(r.x, r.y, 4 + r.r1 * a, 0, Math.PI * 2); g.stroke();
    }
  }

  #drawParticles(g) {
    for (const p of this.particles) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.kind === 'smoke') {
        g.globalAlpha = a;
        g.fillStyle = p.color;
        g.beginPath(); g.arc(p.x, p.y, p.size, 0, Math.PI * 2); g.fill();
      } else {
        g.globalAlpha = Math.min(1, a * 1.5);
        g.fillStyle = p.color;
        g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    g.globalAlpha = 1;
  }

  #drawCursor(g, now) {
    if (!this.#alive() || this.mx < 0 || this.my < 0 || this.mx > ARENA_W || this.my > ARENA_H) return;
    const s = this.snap;
    const col = COLORS[this.me];
    if (this.phase === 'place') {
      if (s.allow[this.me] <= 0) return;
      const [x, y] = this.#cannonSpot();
      const ok = this.#cannonOk(x, y);
      // valid = your colour with a white outline; invalid = dark with a red cross (distinct even for the red player)
      g.fillStyle = ok ? rgba(col, 0.5) : 'rgba(10,12,20,0.6)';
      g.fillRect(x * TILE, y * TILE, TILE * 2, TILE * 2);
      g.strokeStyle = ok ? '#ffffff' : '#9ca3af';
      g.lineWidth = 2;
      g.strokeRect(x * TILE + 1, y * TILE + 1, TILE * 2 - 2, TILE * 2 - 2);
      if (ok) {
        g.fillStyle = '#ffffff';
        g.beginPath(); g.arc((x + 1) * TILE, (y + 1) * TILE, 4, 0, Math.PI * 2); g.fill();
      } else this.#cross(g, (x + 1) * TILE, (y + 1) * TILE, 9);
    } else if (this.phase === 'build') {
      const spot = this.#pieceSpot();
      if (!spot) return;
      const ok = this.#pieceOk(spot);
      for (const [cx, cy] of spot.cells) {
        const px = (spot.x + cx) * TILE;
        const py = (spot.y + cy) * TILE;
        g.fillStyle = ok ? rgba(col, 0.75) : 'rgba(10,12,20,0.6)';
        g.fillRect(px, py, TILE, TILE);
        g.strokeStyle = ok ? '#ffffff' : '#9ca3af';
        g.lineWidth = 1.5;
        g.strokeRect(px + 0.75, py + 0.75, TILE - 1.5, TILE - 1.5);
        if (!ok) this.#cross(g, px + TILE / 2, py + TILE / 2, 4);
      }
    } else if (this.phase === 'battle' && !s.cease) {
      const ready = this.cannons.filter((c) => c.slot === this.me && c.act && c.ready >= 1);
      const anyAct = this.cannons.some((c) => c.slot === this.me && c.act);
      const c = ready.length ? '#ffffff' : anyAct ? '#fbbf24' : '#f87171';
      const x = this.mx;
      const y = this.my;
      if (ready.length) { // a faint line from the cannon that would fire
        let best = null;
        let bd = Infinity;
        for (const k of ready) { const d = Math.hypot(x - (k.x + 1) * TILE, y - (k.y + 1) * TILE); if (d < bd) { bd = d; best = k; } }
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.lineWidth = 1;
        g.setLineDash([4, 5]);
        g.beginPath(); g.moveTo((best.x + 1) * TILE, (best.y + 1) * TILE); g.lineTo(x, y); g.stroke();
        g.setLineDash([]);
      }
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 4;
      this.#crosshair(g, x, y);
      g.strokeStyle = c;
      g.lineWidth = 2;
      this.#crosshair(g, x, y);
      if (!anyAct) { // no cannon inside the walls: tell the player in the world, not only in the hint
        g.fillStyle = 'rgba(15,18,28,0.8)';
        g.fillRect(x + 14, y + 10, 118, 18);
        g.fillStyle = '#fca5a5';
        g.font = '600 11px system-ui, sans-serif';
        g.fillText('no cannon in your walls', x + 19, y + 23);
      }
    }
  }

  #cross(g, x, y, r) {
    g.strokeStyle = '#f87171';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke();
  }

  #crosshair(g, x, y) {
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.moveTo(x - 15, y); g.lineTo(x - 5, y);
    g.moveTo(x + 5, y); g.lineTo(x + 15, y);
    g.moveTo(x, y - 15); g.lineTo(x, y - 5);
    g.moveTo(x, y + 5); g.lineTo(x, y + 15);
    g.stroke();
  }

  /** The current wall piece and the two after it, bottom left of the board, during the build phase. */
  #drawQueue(g) {
    if (this.phase !== 'build' || !this.#alive()) return;
    const q = this.snap.pq[this.me];
    if (!q || !q.length) return;
    const w = 150;
    const h = 52;
    const x0 = 6;
    const y0 = ARENA_H - h - 4; // the strip below the bottom wall rings (they end at y = 500)
    g.fillStyle = 'rgba(10,14,26,0.72)';
    g.fillRect(x0, y0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    let cx = x0 + 8;
    q.forEach((type, n) => {
      const cells = pieceCells(type, n === 0 ? this.rot : 0);
      const sz = pieceSize(cells);
      const t = n === 0 ? 11 : 7;
      const ox = cx;
      const oy = y0 + (h - sz.h * t) / 2;
      g.globalAlpha = n === 0 ? 1 : 0.6;
      for (const [px, py] of cells) {
        g.fillStyle = COLORS[this.me];
        g.fillRect(ox + px * t, oy + py * t, t - 1, t - 1);
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.fillRect(ox + px * t, oy + py * t, t - 1, 2);
      }
      g.globalAlpha = 1;
      cx += sz.w * t + 14;
    });
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);

/** @type {import('../../shared/contracts.js').ClientGame} */
export const ramparts = {
  meta,
  mount: (ctx) => new RampartsView(ctx),
};

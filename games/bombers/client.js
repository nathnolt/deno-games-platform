import { el } from '../../client/dom.js'; // the shell's tiny DOM helper
import {
  COLORS, CRATE, DX, DY, FLAME_TIME, PU_BOMB, PU_FIRE, PU_KICK, PU_SPEED, SOLID, arenaOf, isPillar, meta,
} from './shared.js';
import { Sfx } from './audio.js';

/**
 * Client side: no simulation. The server sends a compact snapshot every tick; this view draws it on a Canvas 2D
 * (players and bombs interpolated between snapshots) and turns keys / touch into small intents:
 *   { d: 0..4 }  the direction you are holding (0 = none, 1 up, 2 right, 3 down, 4 left), sent when it changes
 *   { b: 1 }     drop a bomb
 * Keyboard: arrows or WASD to move, Space or Enter for a bomb, M mutes. Touch: stick bottom-left, bomb bottom-right.
 */

const BANNER_MS = 2000;
const INTERP_DELAY = 55; // ms: render a little in the past so there are two snapshots to blend
const MAX_PARTICLES = 500;
const PHASE_NAME = { ready: 'Get ready', play: 'Fight', grace: 'Fight', result: 'Round over' };
const KEY_DIR = { ArrowUp: 1, KeyW: 1, ArrowRight: 2, KeyD: 2, ArrowDown: 3, KeyS: 3, ArrowLeft: 4, KeyA: 4 };
const PU_NAME = { [PU_BOMB]: '+1 bomb', [PU_FIRE]: '+1 blast range', [PU_SPEED]: 'speed up', [PU_KICK]: 'kick' };

// ── small colour helpers ──
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (c, to, a) => {
  const x = hex(c);
  const y = hex(to);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * a)},${Math.round(x[1] + (y[1] - x[1]) * a)},${Math.round(x[2] + (y[2] - x[2]) * a)})`;
};
const PAL = COLORS.map((c) => ({ base: c, light: mix(c, '#ffffff', 0.4), dark: mix(c, '#000000', 0.45) }));
const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** The stylesheet lives next to this file and is added to <head> once (all classes are prefixed bm-). */
const STYLE_URL = new URL('./bombers.css', import.meta.url).href;
function loadStyle() {
  let link = document.getElementById('bm-style');
  if (!link) {
    link = document.createElement('link');
    link.id = 'bm-style';
    link.rel = 'stylesheet';
    link.href = STYLE_URL;
    link.addEventListener('load', () => { link.dataset.ready = '1'; });
    link.addEventListener('error', () => { link.dataset.ready = '1'; console.warn(`Bombers: could not load ${STYLE_URL}`); });
    document.head.append(link);
  }
  if (link.dataset.ready) return Promise.resolve();
  return new Promise((done) => { link.addEventListener('load', done, { once: true }); link.addEventListener('error', done, { once: true }); });
}

class BombersView {
  constructor(ctx) {
    this.ctx = ctx;
    loadStyle().then(() => { if (!this.disposed) this.#resize(); });
    this.me = ctx.me.slot;
    this.spectating = this.me < 0;
    const set = ctx.room.settings;
    const { w, h } = arenaOf(set.arena);
    this.w = w;
    this.h = h;
    this.roundsToWin = set.roundsToWin ?? 3;
    this.names = new Map(ctx.room.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p.name]));
    this.sfx = new Sfx();
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // mirrored state
    this.snaps = []; //   [{ at, s }] newest last
    this.snap = null;
    this.grid = new Uint8Array(w * h);
    this.gridStr = '';
    this.phase = '';
    this.ended = false;
    this.lastCount = 0;
    this.hudKey = '';

    // effects
    this.particles = [];
    this.ghosts = []; //  { x, y, slot, t0 }
    this.falls = []; //   { i, t0 }
    this.rings = []; //   { x, y, t0, color }
    this.shake = 0;
    this.timers = new Set();
    this.layerDirty = true;
    this.T = 32; //        css px per tile
    this.dpr = 1;
    this.last = performance.now();

    // input
    this.keys = []; //    held directions, last pressed last
    this.touchDir = 0;
    this.sentDir = 0;

    // DOM
    this.chips = el('div', { class: 'bm-chips' });
    this.phaseEl = el('span', { class: 'bm-phase' });
    this.timeEl = el('span', { class: 'bm-time' });
    this.ffEl = el('span', { class: 'bm-ff' });
    this.roundEl = el('span', { class: 'bm-round' });
    this.muteBtn = el('button', { class: 'bm-mute', type: 'button', onclick: this.#toggleMute });
    this.head = el('div', { class: 'bm-head' },
      el('div', { class: 'bm-clock' }, this.phaseEl, this.timeEl),
      this.chips,
      el('div', { class: 'bm-side' }, this.ffEl, this.roundEl, this.muteBtn));
    this.canvas = el('canvas', { class: 'bm-canvas' });
    this.banner = el('div', { class: 'bm-banner' });
    this.toasts = el('div', { class: 'bm-toasts' });
    this.stage = el('div', { class: 'bm-stage' }, this.canvas, this.banner, this.toasts);
    this.hint = el('div', { class: 'bm-hint' });
    this.knob = el('div', { class: 'bm-knob' });
    this.pad = el('div', { class: 'bm-pad' }, this.knob);
    this.bombBtn = el('div', { class: 'bm-bombbtn' });
    this.bombBtn.append(el('span', {}, 'BOMB'));
    this.bombBtn.style.display = 'grid';
    this.bombBtn.style.placeItems = 'center';
    this.touch = el('div', { class: 'bm-touch' }, this.pad, this.bombBtn);
    this.root = el('div', { class: 'bm-root' }, this.head, this.stage, this.hint, this.touch);
    ctx.container.style.position = 'relative';
    ctx.container.append(this.root);
    this.g = this.canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    if (!this.spectating && window.matchMedia?.('(pointer: coarse)').matches) this.root.classList.add('bm-touching');
    this.#syncMuteButton();
    this.#setHint();

    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(ctx.container);
    this.observer.observe(this.head);
    this.#resize();

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
    this.root.addEventListener('pointerdown', this.#onRootDown);
    this.pad.addEventListener('pointerdown', this.#onPadDown);
    this.pad.addEventListener('pointermove', this.#onPadMove);
    this.pad.addEventListener('pointerup', this.#onPadUp);
    this.pad.addEventListener('pointercancel', this.#onPadUp);
    this.bombBtn.addEventListener('pointerdown', this.#onBombBtn);
    this.bombBtn.addEventListener('pointerup', this.#onBombUp);
    this.bombBtn.addEventListener('pointercancel', this.#onBombUp);
    this.sfx.unlock();
    this.raf = requestAnimationFrame(this.#frame);
  }

  // ── GameView ──
  onRoom(room) {
    this.names = new Map(room.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p.name]));
    this.hudKey = '';
    if (this.snap) this.#updateHud(this.snap);
  }

  onSnapshot(s) {
    if (!s || !s.p) return;
    const now = performance.now();
    this.snaps.push({ at: now, s });
    if (this.snaps.length > 12) this.snaps.shift();
    this.snap = s;
    this.snapAt = now;
    if (s.g && s.g !== this.gridStr) this.#parseGrid(s.g);
    for (const ev of s.ev ?? []) this.#event(ev, s);
    if (s.ph !== this.phase) {
      this.phase = s.ph;
      this.#setHint();
    }
    if (s.ph === 'ready') {
      const n = Math.ceil(s.tm);
      if (n !== this.lastCount && n > 0 && n <= 3) this.sfx.play('count');
      this.lastCount = n;
    }
    this.#updateHud(s);
  }

  onEnd(result) {
    this.ended = true;
    this.#sendDir(0);
    const wins = result.wins ?? [0, 0, 0, 0];
    const seats = [0, 1, 2, 3].filter((slot) => this.snap?.ac?.[slot] || wins[slot] > 0 || this.names.has(slot));
    const order = seats.sort((a, b) => (a === result.winner ? -1 : b === result.winner ? 1 : wins[b] - wins[a]));
    const won = result.winner >= 0 && result.winner === this.me;
    const title = result.reason === 'abandoned' ? 'Match over' : won ? 'You win!' : result.winner >= 0 ? `${this.#name(result.winner, false)} wins!` : 'Draw!';
    const why = { wins: `First to ${this.roundsToWin} round ${this.roundsToWin === 1 ? 'win' : 'wins'}`, limit: `Round limit reached (${result.rounds} rounds)`, abandoned: 'Everyone left', forfeit: 'Everyone else left' }[result.reason] ?? '';
    clearTimeout(this.bannerTimer);
    this.banner.className = 'bm-banner bm-final';
    this.banner.style.setProperty('--c', result.winner >= 0 ? COLORS[result.winner] : '#e2e8f0');
    this.banner.replaceChildren(
      el('div', { class: 'bm-banner-kicker' }, 'Game over'),
      el('div', { class: 'bm-banner-title' }, title),
      el('div', { class: 'bm-banner-sub' }, why),
      el('div', { class: 'bm-final-rows' }, ...order.map((slot, n) => el('div', { class: `bm-final-row${slot === result.winner ? ' bm-win' : ''}`, style: `--c:${COLORS[slot]};--cl:${PAL[slot].light}` },
        el('span', { class: 'bm-final-pos' }, `${n + 1}.`),
        el('span', { class: 'bm-final-name' }, this.#name(slot)),
        el('b', {}, `${wins[slot]} ${wins[slot] === 1 ? 'win' : 'wins'}`)))),
    );
    if (won) this.sfx.play('win');
    this.hint.textContent = 'Match over. Use "Back to setup" above to play again.';
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    clearTimeout(this.bannerTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
    this.root.removeEventListener('pointerdown', this.#onRootDown);
    this.pad.removeEventListener('pointerdown', this.#onPadDown);
    this.pad.removeEventListener('pointermove', this.#onPadMove);
    this.pad.removeEventListener('pointerup', this.#onPadUp);
    this.pad.removeEventListener('pointercancel', this.#onPadUp);
    this.bombBtn.removeEventListener('pointerdown', this.#onBombBtn);
    this.bombBtn.removeEventListener('pointerup', this.#onBombUp);
    this.bombBtn.removeEventListener('pointercancel', this.#onBombUp);
    this.sfx.dispose();
    this.root.remove();
  }

  // ── helpers ──
  #name(slot, you = true) {
    const n = this.names.get(slot) ?? (this.snap?.bt?.[slot] ? `Bot ${slot + 1}` : meta.seatNames[slot]);
    return you && slot === this.me ? `${n} (you)` : n;
  }

  #timeout(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  #canPlay() { return !this.spectating && !this.ended; }

  #parseGrid(str) {
    const fresh = this.gridStr === '' || this.gridStr.length !== str.length;
    for (let i = 0; i < str.length && i < this.grid.length; i++) {
      const v = str.charCodeAt(i) - 48;
      if (!fresh && this.grid[i] === CRATE && v !== CRATE) this.#debris(i);
      this.grid[i] = v;
    }
    this.gridStr = str;
    this.layerDirty = true;
  }

  // ── events from the server ──
  #event(ev, s) {
    const [kind] = ev;
    switch (kind) {
      case 'round':
        this.particles.length = 0;
        this.ghosts.length = 0;
        this.falls.length = 0;
        this.rings.length = 0;
        this.snaps.length = 0; // positions jump back to the spawns: don't blend across rounds
        this.snaps.push({ at: performance.now(), s });
        this.#showBanner({ kicker: `First to ${this.roundsToWin}`, title: `Round ${ev[1]}`, sub: this.spectating ? 'Spectating' : 'Get ready…', color: this.spectating ? undefined : COLORS[this.me], ms: 2400 });
        break;
      case 'go':
        this.sfx.play('go');
        this.#showBanner({ title: 'Go!', ms: 800, color: this.spectating ? undefined : COLORS[this.me] });
        break;
      case 'drop':
        this.sfx.play('drop', { pan: this.#pan(ev[2]), power: 0.4 });
        break;
      case 'boom': {
        const [, cell, , fire, crates] = ev;
        const { x, y } = this.#xy(cell);
        this.sfx.play('boom', { pan: this.#pan(cell), power: clamp(fire / 8, 0, 1) });
        if (crates) this.sfx.play('crate', { pan: this.#pan(cell) });
        const mine = this.#mePos();
        const near = mine ? Math.hypot(mine.x - x, mine.y - y) : 6;
        this.shake = Math.min(1, this.shake + (near < 3 ? 0.55 : near < 6 ? 0.3 : 0.15));
        this.#burst(x, y, 16, ['#fde047', '#fb923c', '#f97316'], 3.2, 0.45);
        this.#smoke(x, y, 5);
        break;
      }
      case 'burn': {
        const { x, y } = this.#xy(ev[1]);
        this.#smoke(x, y, 3);
        break;
      }
      case 'pick': {
        const [, slot, type] = ev;
        const p = s.p[slot];
        if (p) this.rings.push({ x: p[0] / 100, y: p[1] / 100, t0: performance.now(), color: '#fde047' });
        if (slot === this.me) {
          this.sfx.play('pick', { power: 0.7 });
          this.#toast(`You got ${PU_NAME[type] ?? 'a power-up'}`, COLORS[slot]);
        } else this.sfx.play('pick', { power: 0.3, pan: p ? this.#panX(p[0] / 100) : 0 });
        break;
      }
      case 'kick':
        this.sfx.play('kick', { pan: this.#pan(ev[2]) });
        break;
      case 'die': {
        const [, slot, cell] = ev;
        const prev = this.snaps.length > 1 ? this.snaps[this.snaps.length - 2].s.p[slot] : null;
        const pos = prev ? { x: prev[0] / 100, y: prev[1] / 100 } : this.#xy(cell);
        this.ghosts.push({ ...pos, slot, t0: performance.now() });
        this.#burst(pos.x, pos.y, 22, [PAL[slot].light, COLORS[slot], '#ffffff'], 3.5, 0.7);
        this.sfx.play('die', { pan: this.#panX(pos.x) });
        if (slot === this.me) this.#showBanner({ title: 'You\'re out!', sub: 'Watch the rest of the round', color: COLORS[slot], ms: 1800 });
        else this.#toast(`${this.#name(slot)} was blown up`, COLORS[slot]);
        break;
      }
      case 'wall':
        this.falls.push({ i: ev[1], t0: performance.now() });
        this.sfx.play('wall', { pan: this.#pan(ev[1]), power: 0.5 });
        this.shake = Math.min(1, this.shake + 0.08);
        break;
      case 'sd':
        this.sfx.play('sd');
        this.#showBanner({ kicker: 'Time is up', title: 'Sudden death!', sub: 'The walls are closing in', color: '#ef4444', ms: 2200 });
        break;
      case 'end': {
        const winner = ev[1];
        const won = winner >= 0 && winner === this.me;
        if (won) this.sfx.play('win');
        const tally = [0, 1, 2, 3].filter((slot) => s.ac[slot] || s.w[slot] > 0).map((slot) => el('div', { class: 'bm-tally-row', style: `--cl:${PAL[slot].light}` },
          el('span', { class: 'bm-tally-name' }, this.#name(slot)),
          this.#stars(s.w[slot], 'bm-tally-wins')));
        this.#showBanner({
          kicker: `Round ${s.rd}`,
          title: winner < 0 ? 'Draw' : won ? 'You win the round!' : `${this.#name(winner, false)} wins the round`,
          sub: winner < 0 ? 'Nobody survived' : '',
          lines: [el('div', { class: 'bm-tally' }, ...tally)],
          color: winner >= 0 ? COLORS[winner] : undefined,
          ms: s.over ? 3400 : 3300,
        });
        break;
      }
    }
  }

  #xy(cell) { return { x: cell % this.w, y: Math.floor(cell / this.w) }; }
  #panX(x) { return clamp((x / (this.w - 1)) * 2 - 1, -1, 1) * 0.7; }
  #pan(cell) { return this.#panX(cell % this.w); }

  #mePos() {
    if (this.spectating || !this.snap) return null;
    const p = this.snap.p[this.me];
    return p && p[4] ? { x: p[0] / 100, y: p[1] / 100 } : null;
  }

  // ── HUD ──
  #stars(n, cls) {
    const span = el('span', { class: cls });
    const total = Math.max(this.roundsToWin, n);
    for (let k = 0; k < total; k++) span.append(k < n ? el('span', {}, '★') : el('span', { class: 'bm-no' }, '★'));
    return span;
  }

  #updateHud(s) {
    // clock
    let label = PHASE_NAME[s.ph] ?? '';
    let time = '';
    let urgent = false;
    if (s.ph === 'ready') time = String(Math.max(1, Math.ceil(s.tm)));
    else if (s.ph === 'play' || s.ph === 'grace') {
      if (s.sd >= 0 || (s.tm <= 0 && s.ph === 'play')) { label = 'Sudden death'; time = ''; urgent = true; } else {
        const t = Math.ceil(s.tm);
        time = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        urgent = t <= 10;
      }
    }
    this.phaseEl.textContent = label;
    this.timeEl.textContent = time;
    this.timeEl.classList.toggle('bm-urgent', urgent);
    this.phaseEl.style.color = urgent && !time ? '#f87171' : '';
    this.ffEl.textContent = s.ff ? '▶▶ ×3' : '';
    this.ffEl.title = s.ff ? 'Only bots left this round: fast-forward' : '';
    this.roundEl.textContent = `Round ${s.rd}`;

    // chips: only rebuilt when something on them changed
    const key = JSON.stringify([s.w, s.ac, s.bt, s.p.map((p) => (p ? [p[4], p[5], p[6], p[7], p[8]] : 0))]);
    if (key === this.hudKey) return;
    this.hudKey = key;
    const chips = [];
    for (let slot = 0; slot < 4; slot++) {
      const p = s.p[slot];
      if (!s.ac[slot] && !p && !s.w[slot]) continue;
      const dead = !p || !p[4];
      const cls = `bm-chip${slot === this.me ? ' bm-me' : ''}${dead ? ' bm-dead' : ''}`;
      const stats = p ? el('div', { class: 'bm-chip-stats' },
        el('span', { title: 'Bombs' }, `💣${p[5]}`),
        el('span', { title: 'Blast range' }, `🔥${p[6]}`),
        el('span', { title: 'Speed' }, `⚡${p[7]}`),
        ...(p[8] ? [el('span', { title: 'Kick' }, '🦶')] : [])) : el('div', { class: 'bm-chip-stats' }, 'left');
      chips.push(el('div', { class: cls, style: `--c:${COLORS[slot]};--cl:${PAL[slot].light}` },
        el('div', { class: 'bm-chip-top' }, el('span', { class: 'bm-chip-name' }, this.#name(slot)), this.#stars(s.w[slot], 'bm-chip-wins')),
        stats));
    }
    this.chips.replaceChildren(...chips);
  }

  #setHint() {
    if (this.ended) return;
    if (this.spectating) { this.hint.textContent = 'Spectating'; return; }
    if (this.root.classList.contains('bm-touching')) { this.hint.textContent = 'Stick (bottom left) to move · BOMB to drop a bomb'; return; }
    this.hint.replaceChildren(
      'Move ', el('kbd', {}, '←↑→↓'), ' or ', el('kbd', {}, 'WASD'), ' · Bomb ', el('kbd', {}, 'Space'), ' · Mute ', el('kbd', {}, 'M'),
    );
  }

  #showBanner({ kicker, title, sub, lines, ms = BANNER_MS, color }) {
    if (this.ended) return;
    this.banner.className = 'bm-banner';
    this.banner.style.setProperty('--bm-ms', `${ms}ms`);
    this.banner.style.setProperty('--c', color ?? '#e2e8f0');
    this.banner.replaceChildren(
      ...(kicker ? [el('div', { class: 'bm-banner-kicker' }, kicker)] : []),
      el('div', { class: 'bm-banner-title' }, title),
      ...(sub ? [el('div', { class: 'bm-banner-sub' }, sub)] : []),
      ...(lines ?? []),
    );
    void this.banner.offsetWidth; // restart the CSS animation
    this.banner.classList.add('bm-show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { if (!this.ended) this.banner.classList.remove('bm-show'); }, ms);
  }

  #toast(text, color) {
    const t = el('div', { class: 'bm-toast' }, el('i', { style: `background:${color}` }), text);
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
    this.#timeout(() => t.remove(), 2700);
  }

  #syncMuteButton() {
    this.muteBtn.textContent = this.sfx.muted ? '🔇' : '🔊';
    this.muteBtn.title = this.sfx.muted ? 'Sound off (M)' : 'Sound on (M)';
  }

  #toggleMute = () => {
    this.sfx.setMuted(!this.sfx.muted);
    this.#syncMuteButton();
  };

  // ── input ──
  #sendDir(d) {
    if (d === this.sentDir || this.spectating) return;
    this.sentDir = d;
    this.ctx.sendInput({ d });
  }

  #syncDir() {
    if (!this.#canPlay()) return this.#sendDir(0);
    this.#sendDir(this.touchDir || (this.keys.length ? this.keys[this.keys.length - 1] : 0));
  }

  #bomb() {
    if (!this.#canPlay()) return;
    this.sfx.unlock();
    this.ctx.sendInput({ b: 1 });
  }

  #typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  #onKeyDown = (e) => {
    if (this.#typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyM') { if (!e.repeat) this.#toggleMute(); return; }
    if (this.spectating) return;
    const d = KEY_DIR[e.code];
    if (d) {
      e.preventDefault();
      if (!e.repeat) {
        this.keys = this.keys.filter((k) => k !== d);
        this.keys.push(d);
        this.sfx.unlock();
        this.#syncDir();
      }
      return;
    }
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (!e.repeat) this.#bomb();
    }
  };

  #onKeyUp = (e) => {
    const d = KEY_DIR[e.code];
    if (!d) return;
    this.keys = this.keys.filter((k) => k !== d);
    this.#syncDir();
  };

  #onBlur = () => {
    this.keys = [];
    this.touchDir = 0;
    this.knob.style.transform = '';
    this.#syncDir();
  };

  #onRootDown = (e) => {
    this.sfx.unlock();
    if (e.pointerType === 'touch' && !this.spectating && !this.root.classList.contains('bm-touching')) {
      this.root.classList.add('bm-touching');
      this.#setHint();
    }
  };

  #padVector(e) {
    const r = this.pad.getBoundingClientRect();
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2), r: r.width / 2 };
  }

  #padUpdate(e) {
    const v = this.#padVector(e);
    const len = Math.hypot(v.x, v.y);
    const k = len > v.r * 0.55 ? (v.r * 0.55) / len : 1;
    this.knob.style.transform = `translate(${v.x * k}px, ${v.y * k}px)`;
    this.touchDir = len < 12 ? 0 : Math.abs(v.x) > Math.abs(v.y) ? (v.x > 0 ? 2 : 4) : (v.y > 0 ? 3 : 1);
    this.#syncDir();
  }

  #onPadDown = (e) => {
    e.preventDefault();
    this.pad.setPointerCapture?.(e.pointerId);
    this.padPointer = e.pointerId;
    this.#padUpdate(e);
  };

  #onPadMove = (e) => {
    if (e.pointerId !== this.padPointer) return;
    this.#padUpdate(e);
  };

  #onPadUp = (e) => {
    if (e.pointerId !== this.padPointer) return;
    this.padPointer = undefined;
    this.touchDir = 0;
    this.knob.style.transform = '';
    this.#syncDir();
  };

  #onBombBtn = (e) => {
    e.preventDefault();
    this.bombBtn.classList.add('bm-pressed');
    this.#bomb();
  };

  #onBombUp = () => { this.bombBtn.classList.remove('bm-pressed'); };

  // ── layout ──
  #resize() {
    if (this.disposed) return;
    const c = this.ctx.container;
    const availW = c.clientWidth - 16;
    const availH = c.clientHeight - this.head.offsetHeight - this.hint.offsetHeight - 12;
    const T = Math.max(10, Math.floor(Math.min(availW / this.w, availH / this.h)));
    this.T = T;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = T * this.w;
    const ch = T * this.h;
    this.stage.style.width = `${cw}px`;
    this.stage.style.height = `${ch}px`;
    this.canvas.width = Math.round(cw * this.dpr);
    this.canvas.height = Math.round(ch * this.dpr);
    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
    this.stage.style.fontSize = `${clamp(T / 40, 0.55, 1.1)}em`;
    this.layerDirty = true;
  }

  // ── static layer: floor, pillars, crates, sudden-death walls ──
  #drawLayer() {
    const g = this.layer.getContext('2d');
    const T = this.T;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, T * this.w, T * this.h);
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = this.grid[y * w + x];
        const px = x * T;
        const py = y * T;
        if (v === SOLID) {
          if (isPillar(w, h, x, y)) this.#drawPillar(g, px, py, T, x === 0 || y === 0 || x === w - 1 || y === h - 1);
          else this.#drawMetal(g, px, py, T);
          continue;
        }
        // floor: two shades of grass with a few specks
        g.fillStyle = (x + y) % 2 ? '#2f6e3b' : '#2b6636';
        g.fillRect(px, py, T, T);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        for (let k = 0; k < 3; k++) {
          const rx = hash(x * 7 + k, y * 3) * (T - 3);
          const ry = hash(x * 5, y * 11 + k) * (T - 3);
          g.fillRect(px + rx, py + ry, Math.max(1, T / 16), Math.max(1, T / 16));
        }
        // drop shadow from whatever stands above
        const above = y > 0 ? this.grid[(y - 1) * w + x] : SOLID;
        if (above === SOLID || above === CRATE) {
          g.fillStyle = 'rgba(0,0,0,0.28)';
          g.fillRect(px, py, T, T * 0.22);
        }
        if (v === CRATE) this.#drawCrate(g, px, py, T, x, y);
      }
    }
    this.layerDirty = false;
  }

  #drawPillar(g, px, py, T, border) {
    const base = border ? '#4b5563' : '#6b7280';
    g.fillStyle = base;
    g.fillRect(px, py, T, T);
    const b = Math.max(2, T * 0.12);
    g.fillStyle = border ? '#6b7280' : '#9ca3af'; // light top/left
    g.fillRect(px, py, T, b);
    g.fillRect(px, py, b, T);
    g.fillStyle = border ? '#374151' : '#4b5563'; // dark bottom/right
    g.fillRect(px, py + T - b, T, b);
    g.fillRect(px + T - b, py, b, T);
    if (!border) {
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(px + T * 0.3, py + T * 0.3, T * 0.4, T * 0.4);
    } else {
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = Math.max(1, T / 24);
      g.beginPath();
      g.moveTo(px, py + T / 2); g.lineTo(px + T, py + T / 2);
      g.moveTo(px + T / 2, py); g.lineTo(px + T / 2, py + T / 2);
      g.stroke();
    }
  }

  #drawMetal(g, px, py, T) { // a wall that fell during sudden death
    g.fillStyle = '#334155';
    g.fillRect(px, py, T, T);
    const b = Math.max(2, T * 0.1);
    g.fillStyle = '#475569';
    g.fillRect(px, py, T, b);
    g.fillRect(px, py, b, T);
    g.fillStyle = '#1e293b';
    g.fillRect(px, py + T - b, T, b);
    g.fillRect(px + T - b, py, b, T);
    g.save();
    g.beginPath();
    g.rect(px + b, py + T * 0.38, T - 2 * b, T * 0.24);
    g.clip();
    g.fillStyle = '#facc15';
    g.fillRect(px, py, T, T);
    g.fillStyle = '#111827';
    for (let k = -T; k < T * 2; k += T * 0.3) {
      g.beginPath();
      g.moveTo(px + k, py + T);
      g.lineTo(px + k + T * 0.15, py + T);
      g.lineTo(px + k + T * 0.15 + T, py);
      g.lineTo(px + k + T, py);
      g.fill();
    }
    g.restore();
  }

  #drawCrate(g, px, py, T, x, y) {
    const m = T * 0.06;
    const s = T - 2 * m;
    const tone = hash(x, y) * 0.12;
    g.fillStyle = mix('#b7712f', '#000000', tone);
    g.fillRect(px + m, py + m, s, s);
    g.strokeStyle = '#6b3d14';
    g.lineWidth = Math.max(1, T / 16);
    g.strokeRect(px + m + g.lineWidth / 2, py + m + g.lineWidth / 2, s - g.lineWidth, s - g.lineWidth);
    // planks
    g.strokeStyle = 'rgba(80,40,10,0.45)';
    g.lineWidth = Math.max(1, T / 30);
    g.beginPath();
    for (let k = 1; k < 3; k++) { g.moveTo(px + m, py + m + (s * k) / 3); g.lineTo(px + m + s, py + m + (s * k) / 3); }
    g.stroke();
    // cross brace
    g.strokeStyle = '#8a5220';
    g.lineWidth = Math.max(2, T / 9);
    g.beginPath();
    g.moveTo(px + m * 2.5, py + m * 2.5);
    g.lineTo(px + T - m * 2.5, py + T - m * 2.5);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(px + m, py + m, s, Math.max(1, T / 14));
  }

  // ── interpolation ──
  #sample(now) {
    const n = this.snaps.length;
    if (!n) return null;
    const t = now - INTERP_DELAY;
    let a = this.snaps[0];
    let b = this.snaps[n - 1];
    if (t >= b.at) return { a: b.s, b: b.s, k: 1 };
    for (let i = n - 1; i > 0; i--) {
      if (this.snaps[i - 1].at <= t) { a = this.snaps[i - 1]; b = this.snaps[i]; break; }
    }
    if (t <= a.at) return { a: a.s, b: a.s, k: 1 };
    return { a: a.s, b: b.s, k: clamp((t - a.at) / Math.max(1, b.at - a.at), 0, 1) };
  }

  // ── the frame ──
  #frame = (now) => {
    this.raf = requestAnimationFrame(this.#frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.snap) return;
    if (this.layerDirty) this.#drawLayer();
    const g = this.g;
    const T = this.T;
    const smp = this.#sample(now);
    const s = this.snap;

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, T * this.w, T * this.h);
    g.save();
    if (this.shake > 0.01 && !this.reduced) {
      const m = this.shake * T * 0.12;
      g.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
    }
    this.shake = Math.max(0, this.shake - dt * 2.6);
    g.drawImage(this.layer, 0, 0, T * this.w, T * this.h);

    this.#drawSdWarning(g, s, now);
    this.#drawFalls(g, now);
    this.#drawPowerups(g, s, now);
    this.#drawBombs(g, smp, now);
    this.#drawFlames(g, s, now);
    this.#drawPlayers(g, smp, now);
    this.#drawGhosts(g, now);
    this.#drawParticles(g, dt);
    this.#drawRings(g, now);
    g.restore();
  };

  #drawSdWarning(g, s, now) {
    if (s.sd < 0 || s.sd === undefined) return;
    const T = this.T;
    const { x, y } = this.#xy(s.sd);
    const a = 0.35 + 0.3 * Math.sin(now / 70);
    g.fillStyle = `rgba(239,68,68,${a})`;
    g.fillRect(x * T, y * T, T, T);
    g.strokeStyle = 'rgba(254,202,202,0.8)';
    g.lineWidth = Math.max(1, T / 20);
    g.strokeRect(x * T + 1, y * T + 1, T - 2, T - 2);
  }

  #drawFalls(g, now) {
    const T = this.T;
    this.falls = this.falls.filter((f) => now - f.t0 < 400);
    for (const f of this.falls) {
      const k = (now - f.t0) / 400;
      const { x, y } = this.#xy(f.i);
      // dust ring
      g.strokeStyle = `rgba(226,232,240,${0.5 * (1 - k)})`;
      g.lineWidth = Math.max(1, T / 14);
      g.beginPath();
      g.arc((x + 0.5) * T, (y + 0.5) * T, T * (0.5 + k * 0.5), 0, Math.PI * 2);
      g.stroke();
      if (k < 0.35) { // the block is still landing: draw it a bit above, with its shadow
        const lift = (1 - k / 0.35) * T * 0.8;
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(x * T, y * T, T, T);
        g.save();
        g.translate(0, -lift);
        this.#drawMetal(g, x * T, y * T, T);
        g.restore();
      }
    }
  }

  #drawPowerups(g, s, now) {
    const T = this.T;
    for (const [cell, type] of s.u ?? []) {
      const { x, y } = this.#xy(cell);
      if (this.grid[cell] !== 0) continue;
      const bob = this.reduced ? 0 : Math.sin(now / 260 + cell) * T * 0.04;
      const cx = (x + 0.5) * T;
      const cy = (y + 0.5) * T + bob;
      const r = T * 0.36;
      const bg = { [PU_BOMB]: '#1e3a8a', [PU_FIRE]: '#9a3412', [PU_SPEED]: '#065f46', [PU_KICK]: '#6b21a8' }[type] ?? '#334155';
      g.fillStyle = 'rgba(0,0,0,0.3)';
      this.#roundRect(g, cx - r + T * 0.05, cy - r + T * 0.07, r * 2, r * 2, r * 0.35);
      g.fill();
      g.fillStyle = bg;
      this.#roundRect(g, cx - r, cy - r, r * 2, r * 2, r * 0.35);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = Math.max(1, T / 22);
      g.stroke();
      this.#icon(g, type, cx, cy, r * 0.75);
    }
  }

  #icon(g, type, cx, cy, r) {
    g.save();
    g.translate(cx, cy);
    if (type === PU_BOMB) {
      g.fillStyle = '#111827';
      g.beginPath(); g.arc(0, r * 0.15, r * 0.62, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.beginPath(); g.arc(-r * 0.22, -r * 0.05, r * 0.16, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#d6d3d1'; g.lineWidth = r * 0.14;
      g.beginPath(); g.moveTo(r * 0.3, -r * 0.35); g.quadraticCurveTo(r * 0.5, -r * 0.8, r * 0.75, -r * 0.7); g.stroke();
      g.fillStyle = '#fde047'; g.beginPath(); g.arc(r * 0.78, -r * 0.72, r * 0.14, 0, Math.PI * 2); g.fill();
    } else if (type === PU_FIRE) {
      const flame = (k, color) => {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(0, -r * k);
        g.bezierCurveTo(r * 0.75 * k, -r * 0.2 * k, r * 0.65 * k, r * 0.8 * k, 0, r * 0.85 * k);
        g.bezierCurveTo(-r * 0.65 * k, r * 0.8 * k, -r * 0.75 * k, -r * 0.2 * k, 0, -r * k);
        g.fill();
      };
      flame(1, '#f97316');
      g.translate(0, r * 0.2);
      flame(0.62, '#fde047');
    } else if (type === PU_SPEED) { // lightning bolt
      g.fillStyle = '#fde047';
      g.beginPath();
      g.moveTo(r * 0.2, -r); g.lineTo(-r * 0.55, r * 0.1); g.lineTo(-r * 0.05, r * 0.1);
      g.lineTo(-r * 0.25, r); g.lineTo(r * 0.55, -r * 0.15); g.lineTo(r * 0.05, -r * 0.15);
      g.closePath();
      g.fill();
    } else if (type === PU_KICK) { // boot
      g.fillStyle = '#f5d0fe';
      g.beginPath();
      g.moveTo(-r * 0.45, -r * 0.85); g.lineTo(r * 0.1, -r * 0.85); g.lineTo(r * 0.1, r * 0.05);
      g.lineTo(r * 0.75, r * 0.25); g.quadraticCurveTo(r * 0.95, r * 0.75, r * 0.6, r * 0.75);
      g.lineTo(-r * 0.45, r * 0.75); g.closePath();
      g.fill();
      g.fillStyle = '#6b21a8';
      g.fillRect(-r * 0.45, r * 0.5, r * 1.25, r * 0.12);
    }
    g.restore();
  }

  #drawBombs(g, smp, now) {
    if (!smp) return;
    const T = this.T;
    const prev = new Map(smp.a.b.map((b) => [b[0], b]));
    for (const b of smp.b.b ?? []) {
      const a = prev.get(b[0]) ?? b;
      const x = lerp(a[1], b[1], smp.k) / 100;
      const y = lerp(a[2], b[2], smp.k) / 100;
      const fuse = b[3]; // 1 -> 0
      const owner = b[4];
      const cx = (x + 0.5) * T;
      const cy = (y + 0.5) * T;
      const rate = 6 + (1 - fuse) * 22;
      const pulse = this.reduced ? 1 : 1 + 0.07 * Math.sin((now / 1000) * rate);
      const r = T * 0.34 * pulse;
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.beginPath(); g.ellipse(cx + T * 0.04, cy + T * 0.3, r * 0.95, r * 0.35, 0, 0, Math.PI * 2); g.fill();
      const flash = fuse < 0.25 && Math.floor(now / 80) % 2 === 0;
      const grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
      grad.addColorStop(0, flash ? '#fca5a5' : '#6b7280');
      grad.addColorStop(0.45, flash ? '#b91c1c' : '#1f2937');
      grad.addColorStop(1, '#030712');
      g.fillStyle = grad;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      // owner band
      g.strokeStyle = COLORS[owner] ?? '#fff';
      g.lineWidth = Math.max(1.5, T / 14);
      g.beginPath(); g.arc(cx, cy, r * 0.8, Math.PI * 0.15, Math.PI * 0.85); g.stroke();
      // cap and fuse
      g.fillStyle = '#4b5563';
      g.fillRect(cx - r * 0.22, cy - r * 1.08, r * 0.44, r * 0.25);
      const fl = r * (0.25 + 0.45 * fuse);
      g.strokeStyle = '#d6d3d1';
      g.lineWidth = Math.max(1, T / 22);
      g.beginPath();
      g.moveTo(cx, cy - r * 1.05);
      g.quadraticCurveTo(cx + fl * 0.4, cy - r * 1.05 - fl, cx + fl, cy - r * 1.05 - fl * 0.8);
      g.stroke();
      const sx = cx + fl;
      const sy = cy - r * 1.05 - fl * 0.8;
      g.fillStyle = Math.random() < 0.5 ? '#fde047' : '#fb923c';
      g.beginPath(); g.arc(sx, sy, T * (0.05 + Math.random() * 0.04), 0, Math.PI * 2); g.fill();
      if (!this.reduced && Math.random() < 0.35) this.#spark(sx / T, sy / T);
    }
  }

  #drawFlames(g, s, now) {
    // burn down locally from the last snapshot, so flames still fade out once snapshots stop (end of the match)
    const age = (now - this.snapAt) / 1000 / FLAME_TIME;
    const flames = (s.f ?? []).map(([c, m, life]) => [c, m, life - age]).filter((f) => f[2] > 0);
    if (!flames.length) return;
    const T = this.T;
    const w = this.w;
    const byCell = new Map(flames.map((f) => [f[0], f]));
    const eff = (m) => (m & 4 ? 3 : m);
    const passes = [['#ef4444', 1], ['#f97316', 0.8], ['#fbbf24', 0.55], ['#fff7d6', 0.28]];
    for (const [color, scale] of passes) {
      g.fillStyle = color;
      for (const [cell, mask, life] of flames) {
        const k = life > 0.8 ? (1 - life) / 0.2 : life / 0.8; // grows fast, then shrinks
        const thick = T * 0.9 * scale * clamp(0.45 + 0.55 * k, 0, 1);
        if (thick < 0.5) continue;
        const x = cell % w;
        const y = (cell - x) / w;
        const cx = (x + 0.5) * T;
        const cy = (y + 0.5) * T;
        const m = eff(mask);
        g.beginPath();
        g.arc(cx, cy, thick / 2, 0, Math.PI * 2);
        g.fill();
        for (let d = 1; d <= 4; d++) {
          const axis = DX[d] ? 1 : 2;
          if (!(m & axis)) continue;
          const n = byCell.get(cell + DY[d] * w + DX[d]);
          const joined = n && eff(n[1]) & axis;
          const len = joined ? T * 0.52 : mask & 4 ? 0 : T * 0.36;
          if (len <= 0) continue;
          if (DX[d]) g.fillRect(DX[d] > 0 ? cx : cx - len, cy - thick / 2, len, thick);
          else g.fillRect(cx - thick / 2, DY[d] > 0 ? cy : cy - len, thick, len);
          if (!joined) { // rounded tip
            g.beginPath();
            g.arc(cx + DX[d] * len, cy + DY[d] * len, thick / 2, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    }
  }

  #drawPlayers(g, smp, now) {
    if (!smp) return;
    const T = this.T;
    const list = [];
    for (let slot = 0; slot < 4; slot++) {
      const b = smp.b.p[slot];
      if (!b || !b[4]) continue;
      const a = smp.a.p[slot] && smp.a.p[slot][4] ? smp.a.p[slot] : b;
      let x = lerp(a[0], b[0], smp.k) / 100;
      let y = lerp(a[1], b[1], smp.k) / 100;
      if (Math.abs(a[0] - b[0]) > 200 || Math.abs(a[1] - b[1]) > 200) { x = b[0] / 100; y = b[1] / 100; }
      list.push({ slot, x, y, face: b[2], moving: b[3] === 1 });
    }
    list.sort((p, q) => p.y - q.y);
    for (const p of list) this.#drawChar(g, p, now, T);
  }

  /** An original little round bomber: body in the seat colour, a pale face plate and an antenna. */
  #drawChar(g, { slot, x, y, face, moving }, now, T) {
    const pal = PAL[slot];
    const t = now / 1000;
    const step = moving && !this.reduced ? Math.sin(t * 16 + slot) : 0;
    const bob = Math.abs(step) * T * 0.05;
    const cx = (x + 0.5) * T;
    const cy = (y + 0.5) * T - bob;
    const r = T * 0.33;
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse((x + 0.5) * T, (y + 0.5) * T + r * 1.05, r * 0.95, r * 0.32, 0, 0, Math.PI * 2); g.fill();
    // feet
    g.fillStyle = pal.dark;
    const fx = face === 2 || face === 4 ? r * 0.25 : r * 0.42;
    g.beginPath(); g.ellipse(cx - fx, cy + r * 0.92 + step * T * 0.03, r * 0.3, r * 0.2, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + fx, cy + r * 0.92 - step * T * 0.03, r * 0.3, r * 0.2, 0, 0, Math.PI * 2); g.fill();
    // antenna
    g.strokeStyle = pal.dark;
    g.lineWidth = Math.max(1, T / 26);
    const sway = this.reduced ? 0 : Math.sin(t * 5 + slot) * r * 0.15 + step * r * 0.1;
    g.beginPath(); g.moveTo(cx, cy - r * 0.9); g.quadraticCurveTo(cx + sway, cy - r * 1.3, cx + sway * 1.6, cy - r * 1.55); g.stroke();
    g.fillStyle = pal.light;
    g.beginPath(); g.arc(cx + sway * 1.6, cy - r * 1.6, r * 0.2, 0, Math.PI * 2); g.fill();
    // body
    const grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r * 1.05);
    grad.addColorStop(0, pal.light);
    grad.addColorStop(0.55, pal.base);
    grad.addColorStop(1, pal.dark);
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    // face plate + eyes (none when facing away)
    if (face !== 1) {
      const ox = face === 2 ? r * 0.3 : face === 4 ? -r * 0.3 : 0;
      const oy = face === 3 ? r * 0.12 : 0;
      g.fillStyle = '#f8fafc';
      g.beginPath(); g.ellipse(cx + ox, cy + oy, r * (face === 3 ? 0.62 : 0.5), r * 0.42, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0f172a';
      const ex = face === 3 ? r * 0.2 : r * 0.14;
      const blink = Math.sin(t * 1.3 + slot * 2) > 0.985 ? 0.15 : 1;
      for (const sx of [-1, 1]) {
        g.beginPath(); g.ellipse(cx + ox * 1.25 + sx * ex, cy + oy - r * 0.02, r * 0.08, r * 0.15 * blink, 0, 0, Math.PI * 2); g.fill();
      }
    } else {
      g.fillStyle = 'rgba(255,255,255,0.2)';
      g.beginPath(); g.arc(cx, cy - r * 0.1, r * 0.35, 0, Math.PI * 2); g.fill();
    }
    // "this is you" marker
    if (slot === this.me) {
      const my = cy - r * 2.05 + (this.reduced ? 0 : Math.sin(t * 5) * T * 0.04);
      g.fillStyle = '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = Math.max(1, T / 30);
      g.beginPath(); g.moveTo(cx - r * 0.3, my - r * 0.28); g.lineTo(cx + r * 0.3, my - r * 0.28); g.lineTo(cx, my + r * 0.1); g.closePath();
      g.fill(); g.stroke();
    }
  }

  #drawGhosts(g, now) {
    const T = this.T;
    this.ghosts = this.ghosts.filter((gh) => now - gh.t0 < 1100);
    for (const gh of this.ghosts) {
      const k = (now - gh.t0) / 1100;
      const cx = (gh.x + 0.5) * T;
      const cy = (gh.y + 0.5) * T - k * T * 0.9;
      g.globalAlpha = (1 - k) * 0.85;
      g.fillStyle = PAL[gh.slot].light;
      g.beginPath();
      g.arc(cx, cy, T * 0.26, Math.PI, 0);
      g.lineTo(cx + T * 0.26, cy + T * 0.25);
      for (let w = 3; w >= 0; w--) g.lineTo(cx - T * 0.26 + (w * T * 0.52) / 3, cy + T * (w % 2 ? 0.17 : 0.25));
      g.closePath();
      g.fill();
      g.fillStyle = '#0f172a';
      g.beginPath(); g.arc(cx - T * 0.09, cy, T * 0.04, 0, Math.PI * 2); g.arc(cx + T * 0.09, cy, T * 0.04, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
  }

  #drawRings(g, now) {
    const T = this.T;
    this.rings = this.rings.filter((r) => now - r.t0 < 500);
    for (const r of this.rings) {
      const k = (now - r.t0) / 500;
      g.strokeStyle = r.color;
      g.globalAlpha = 1 - k;
      g.lineWidth = Math.max(1, T / 14);
      g.beginPath(); g.arc((r.x + 0.5) * T, (r.y + 0.5) * T, T * (0.3 + k * 0.6), 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }
  }

  // ── particles (in tile units) ──
  #push(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  #burst(x, y, n, colors, speed, life) {
    if (this.reduced) n = Math.ceil(n / 3);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.#push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, size: 0.05 + Math.random() * 0.06, color: colors[k % colors.length], drag: 3 });
    }
  }

  #smoke(x, y, n) {
    if (this.reduced) return;
    for (let k = 0; k < n; k++) {
      this.#push({ x: x + 0.5 + (Math.random() - 0.5) * 0.6, y: y + 0.5 + (Math.random() - 0.5) * 0.6, vx: (Math.random() - 0.5) * 0.4, vy: -0.3 - Math.random() * 0.4, life: 0.9, max: 0.9, size: 0.18 + Math.random() * 0.14, color: 'rgba(100,100,110,0.5)', drag: 0.5, grow: 0.25 });
    }
  }

  #spark(x, y) {
    this.#push({ x, y, vx: (Math.random() - 0.5) * 1.2, vy: -0.5 - Math.random() * 0.8, life: 0.3, max: 0.3, size: 0.03, color: '#fde047', drag: 1 });
  }

  #debris(cell) {
    const { x, y } = this.#xy(cell);
    const n = this.reduced ? 3 : 9;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = 1 + Math.random() * 2.2;
      this.#push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6, max: 0.6, size: 0.07 + Math.random() * 0.07, color: k % 2 ? '#b7712f' : '#6b3d14', drag: 3.5, square: true, spin: Math.random() * 6 });
    }
  }

  #drawParticles(g, dt) {
    const T = this.T;
    const keep = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const f = Math.exp(-p.drag * dt);
      p.vx *= f;
      p.vy *= f;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.grow) p.size += p.grow * dt;
      const a = clamp(p.life / p.max, 0, 1);
      g.globalAlpha = a;
      g.fillStyle = p.color;
      if (p.square) {
        g.save();
        g.translate(p.x * T, p.y * T);
        g.rotate((p.spin ?? 0) * (p.max - p.life) * 4);
        g.fillRect((-p.size * T) / 2, (-p.size * T) / 2, p.size * T, p.size * T);
        g.restore();
      } else {
        g.beginPath(); g.arc(p.x * T, p.y * T, p.size * T, 0, Math.PI * 2); g.fill();
      }
      keep.push(p);
    }
    g.globalAlpha = 1;
    this.particles = keep;
  }

  #roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const bombers = {
  meta,
  mount: (ctx) => new BombersView(ctx),
};

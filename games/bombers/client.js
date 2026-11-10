import { el } from '../../client/dom.js'; // the shell's tiny DOM helper
import {
  COLORS, CRATE, CURSES, DX, DY, FLAME_TIME, LEVELS, M_DASHER, M_GHOST, PU_BOMB, PU_FIRE, PU_KICK, PU_LIFE, PU_SKULL,
  PU_SPEED, SOLID, arenaOf, isPillar, meta,
} from './shared.js';
import { THEMES } from './themes.js';
import { DIGITS, GHOST_PLAYER, MONSTER, PLAYER, PX, iconURL, itemTile, mirrored, seatPalette, silhouette, sprite } from './sprites.js';
import { Sfx } from './audio.js';

/**
 * Client side: no simulation. The server sends a compact snapshot every tick; this view draws it in PIXEL ART:
 * everything is drawn into a small canvas at 16 pixels per tile and the browser scales that canvas up with
 * `image-rendering: pixelated`. Players, monsters and bombs are interpolated between snapshots (and rounded to
 * whole pixels). Inputs are small intents:
 *   { d: 0..4 }  the direction you are holding (0 none, 1 up, 2 right, 3 down, 4 left), sent when it changes
 *   { b: 1 }     drop a bomb
 * Keyboard: arrows or WASD to move, Space or Enter for a bomb, M mutes. Touch: stick bottom-left, bomb bottom-right.
 */

const BANNER_MS = 2000;
const INTERP_DELAY = 55; // ms: render a little in the past so there are two snapshots to blend
const MAX_PARTICLES = 400;
const KEY_DIR = { ArrowUp: 1, KeyW: 1, ArrowRight: 2, KeyD: 2, ArrowDown: 3, KeyS: 3, ArrowLeft: 4, KeyA: 4 };
const PU_NAME = { [PU_BOMB]: '+1 bomb', [PU_FIRE]: '+1 blast range', [PU_SPEED]: 'speed up', [PU_KICK]: 'kick', [PU_LIFE]: '+1 life' };
const FLAME_COLS = ['#d8341f', '#f97316', '#fcd34d', '#fff7d6'];
const MINI_SKULL = ['.www.', 'wkwkw', 'wwwww', '.wkw.'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
const LIGHT = COLORS.map((c) => seatPalette(c).L);

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

/** Rows for a round bomb of radius r (body 'd', shine 'W', cap 'G'), centred low in a 16×16 tile. */
function bombRows(r) {
  const rows = [];
  const cy = 9.5;
  for (let y = 0; y < PX; y++) {
    let row = '';
    for (let x = 0; x < PX; x++) {
      const dx = x + 0.5 - 8;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) {
        const sx = dx + r * 0.42;
        const sy = dy + r * 0.42;
        row += sx * sx + sy * sy <= 1.6 ? 'W' : 'd';
      } else if (y >= Math.floor(cy - r) - 2 && y < Math.floor(cy - r) && x >= 6 && x < 10) row += 'G';
      else row += '.';
    }
    rows.push(row);
  }
  return rows;
}
const BOMB_ROWS = [bombRows(5.4), bombRows(6.2)];

class BombersView {
  constructor(ctx) {
    this.ctx = ctx;
    loadStyle().then(() => { if (!this.disposed) this.#resize(); });
    this.me = ctx.me.slot;
    this.spectating = this.me < 0;
    const set = ctx.room.settings;
    this.coop = set.mode === 'coop';
    const start = LEVELS[Math.max(0, Math.min(LEVELS.length, set.startLevel ?? 1) - 1)];
    const { w, h } = this.coop ? { w: start.map[0].length, h: start.map.length } : arenaOf(set.arena);
    this.w = w;
    this.h = h;
    this.theme = THEMES[this.coop ? start.theme : 'grass'] ?? THEMES.grass;
    this.roundsToWin = set.roundsToWin ?? 3;
    this.levels = LEVELS.length;
    this.names = new Map(ctx.room.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p.name]));
    this.sfx = new Sfx();
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    // mirrored state
    this.snaps = []; //   [{ at, s }] newest last
    this.snap = null;
    this.snapAt = 0;
    this.grid = new Uint8Array(w * h);
    this.gridStr = '';
    this.phase = '';
    this.ended = false;
    this.lastCount = 0;
    this.hudKey = '';

    // effects (positions in tiles)
    this.particles = [];
    this.ghosts = []; //   dead players floating up { x, y, slot, t0 }
    this.mdeaths = []; //  monsters flashing out { x, y, type, t0 }
    this.popups = []; //   score numbers { x, y, text, t0, color }
    this.falls = []; //    sudden-death walls landing { i, t0 }
    this.shake = 0;
    this.timers = new Set();
    this.layerDirty = true;
    this.last = performance.now();

    // input
    this.keys = [];
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
    this.canvas.width = w * PX;
    this.canvas.height = h * PX;
    this.banner = el('div', { class: 'bm-banner' });
    this.toasts = el('div', { class: 'bm-toasts' });
    this.stage = el('div', { class: 'bm-stage' }, this.canvas, this.banner, this.toasts);
    this.hint = el('div', { class: 'bm-hint' });
    this.knob = el('div', { class: 'bm-knob' });
    this.pad = el('div', { class: 'bm-pad' }, this.knob);
    this.bombBtn = el('div', { class: 'bm-bombbtn' }, el('span', {}, 'BOMB'));
    this.touch = el('div', { class: 'bm-touch' }, this.pad, this.bombBtn);
    this.root = el('div', { class: 'bm-root' }, this.head, this.stage, this.hint, this.touch);
    ctx.container.style.position = 'relative';
    ctx.container.append(this.root);
    this.g = this.canvas.getContext('2d');
    this.g.imageSmoothingEnabled = false;
    this.layer = document.createElement('canvas');
    this.layer.width = w * PX;
    this.layer.height = h * PX;
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
    if (s.gw && s.g && (s.gw !== this.w || s.g.length !== this.w * this.h)) this.#setSize(s.gw, s.g.length / s.gw);
    if (s.th && THEMES[s.th] && THEMES[s.th] !== this.theme) { this.theme = THEMES[s.th]; this.layerDirty = true; }
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
    clearTimeout(this.bannerTimer);
    this.banner.className = 'bm-banner bm-final';
    if (result.mode === 'coop') this.#coopFinal(result);
    else this.#battleFinal(result);
    this.hint.textContent = 'Match over. Use "Back to setup" above to play again.';
  }

  #battleFinal(result) {
    const wins = result.wins ?? [0, 0, 0, 0];
    const seats = [0, 1, 2, 3].filter((slot) => this.snap?.ac?.[slot] || wins[slot] > 0 || this.names.has(slot));
    const order = seats.sort((a, b) => (a === result.winner ? -1 : b === result.winner ? 1 : wins[b] - wins[a]));
    const won = result.winner >= 0 && result.winner === this.me;
    const title = result.reason === 'abandoned' ? 'Match over' : won ? 'You win!' : result.winner >= 0 ? `${this.#name(result.winner, false)} wins!` : 'Draw!';
    const why = { wins: `First to ${this.roundsToWin} round ${this.roundsToWin === 1 ? 'win' : 'wins'}`, limit: `Round limit reached (${result.rounds} rounds)`, abandoned: 'Everyone left', forfeit: 'Everyone else left' }[result.reason] ?? '';
    this.banner.style.setProperty('--c', result.winner >= 0 ? COLORS[result.winner] : '#e2e8f0');
    this.banner.replaceChildren(
      el('div', { class: 'bm-banner-kicker' }, 'Game over'),
      el('div', { class: 'bm-banner-title' }, title),
      el('div', { class: 'bm-banner-sub' }, why),
      el('div', { class: 'bm-final-rows' }, ...order.map((slot, n) => el('div', { class: `bm-final-row${slot === result.winner ? ' bm-win' : ''}`, style: `--c:${COLORS[slot]};--cl:${LIGHT[slot]}` },
        el('span', { class: 'bm-final-pos' }, `${n + 1}.`),
        el('span', { class: 'bm-final-name' }, this.#name(slot)),
        el('b', {}, `${wins[slot]} ${wins[slot] === 1 ? 'win' : 'wins'}`)))),
    );
    if (won) this.sfx.play('win');
  }

  #coopFinal(result) {
    const scores = result.scores ?? [0, 0, 0, 0];
    const seats = [0, 1, 2, 3].filter((slot) => this.snap?.ac?.[slot] || scores[slot] > 0 || this.names.has(slot)).sort((a, b) => scores[b] - scores[a]);
    const win = result.reason === 'victory';
    const title = win ? 'Victory!' : result.reason === 'abandoned' ? 'Game over' : 'Game over';
    const why = win ? `All ${result.levels} levels cleared` : result.reason === 'abandoned' ? 'Everyone left' : `Reached level ${result.level} of ${result.levels}`;
    this.banner.style.setProperty('--c', win ? '#fde047' : '#ef4444');
    this.banner.replaceChildren(
      el('div', { class: 'bm-banner-kicker' }, 'Co-op'),
      el('div', { class: 'bm-banner-title' }, title),
      el('div', { class: 'bm-banner-sub' }, why),
      el('div', { class: 'bm-final-rows' },
        ...seats.map((slot, n) => el('div', { class: `bm-final-row${n === 0 ? ' bm-win' : ''}`, style: `--c:${COLORS[slot]};--cl:${LIGHT[slot]}` },
          el('span', { class: 'bm-final-pos' }, `${n + 1}.`),
          el('span', { class: 'bm-final-name' }, this.#name(slot)),
          el('b', {}, String(scores[slot])))),
        el('div', { class: 'bm-final-row bm-total' }, el('span', {}, ''), el('span', { class: 'bm-final-name' }, 'Team total'), el('b', {}, String(result.total ?? 0)))),
    );
    this.sfx.play(win ? 'win' : 'die');
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

  /** A level of another size: new canvases, then fit them to the screen again. */
  #setSize(w, h) {
    this.w = w;
    this.h = h;
    this.grid = new Uint8Array(w * h);
    this.gridStr = '';
    this.canvas.width = this.layer.width = w * PX;
    this.canvas.height = this.layer.height = h * PX;
    this.g.imageSmoothingEnabled = false;
    this.layerDirty = true;
    this.#resize();
  }

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

  #xy(cell) { return { x: cell % this.w, y: Math.floor(cell / this.w) }; }
  #panX(x) { return clamp((x / (this.w - 1)) * 2 - 1, -1, 1) * 0.7; }
  #pan(cell) { return this.#panX(cell % this.w); }

  #mePos() {
    if (this.spectating || !this.snap) return null;
    const p = this.snap.p[this.me];
    return p && p[4] ? { x: p[0] / 100, y: p[1] / 100 } : null;
  }

  #clearEffects(s) {
    this.particles.length = 0;
    this.ghosts.length = 0;
    this.mdeaths.length = 0;
    this.popups.length = 0;
    this.falls.length = 0;
    this.snaps.length = 0; // positions jump back to the spawns: don't blend across rounds
    this.snaps.push({ at: performance.now(), s });
  }

  // ── events from the server ──
  #event(ev, s) {
    const [kind] = ev;
    const myCol = this.spectating ? undefined : COLORS[this.me];
    switch (kind) {
      case 'round':
        this.#clearEffects(s);
        this.#showBanner({ kicker: `First to ${this.roundsToWin}`, title: `Round ${ev[1]}`, sub: this.spectating ? 'Spectating' : 'Get ready…', color: myCol, ms: 2400 });
        break;
      case 'level':
        this.#clearEffects(s);
        this.#showBanner({ kicker: `Level ${ev[1]} of ${this.levels}`, title: LEVELS[ev[1] - 1]?.name ?? `Level ${ev[1]}`, sub: 'Defeat every monster, then everybody into the exit', color: this.theme.accent, ms: 2600 });
        break;
      case 'go':
        this.sfx.play('go');
        this.#showBanner({ title: 'Go!', ms: 800, color: myCol });
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
        this.shake = Math.min(1, this.shake + (near < 3 ? 0.6 : near < 6 ? 0.35 : 0.18));
        this.#burst(x, y, 14, ['#fde047', '#fb923c', '#ffffff'], 3.4, 0.45);
        this.#smoke(x, y, 4);
        break;
      }
      case 'burn':
        this.#smoke(this.#xy(ev[1]).x, this.#xy(ev[1]).y, 3);
        break;
      case 'pick': {
        const [, slot, type] = ev;
        const p = s.p[slot];
        if (p) this.#burst(p[0] / 100, p[1] / 100, 10, ['#fde047', '#ffffff'], 2.2, 0.4);
        if (slot === this.me) {
          this.sfx.play(type === PU_LIFE ? 'oneup' : 'pick', { power: 0.7 });
          this.#toast(`You got ${PU_NAME[type] ?? 'a power-up'}`, COLORS[slot]);
        } else this.sfx.play('pick', { power: 0.3, pan: p ? this.#panX(p[0] / 100) : 0 });
        break;
      }
      case 'curse': {
        const [, slot, curse, from] = ev;
        this.sfx.play('curse', { pan: s.p[slot] ? this.#panX(s.p[slot][0] / 100) : 0 });
        if (slot === this.me) {
          this.#showBanner({ kicker: from >= 0 ? `Caught from ${this.#name(from, false)}` : 'Skull!', title: 'Cursed!', sub: CURSES[curse], color: '#84cc16', ms: 1800 });
        } else this.#toast(`${this.#name(slot)} is cursed: ${CURSES[curse]}${from >= 0 ? ` (from ${this.#name(from)})` : ''}`, '#84cc16');
        break;
      }
      case 'cured':
        if (ev[1] === this.me) this.#toast('The curse wore off', COLORS[this.me]);
        break;
      case 'kick':
        this.sfx.play('kick', { pan: this.#pan(ev[2]) });
        break;
      case 'die': {
        const [, slot, cell, livesLeft] = ev;
        const prev = this.snaps.length > 1 ? this.snaps[this.snaps.length - 2].s.p[slot] : null;
        const pos = prev ? { x: prev[0] / 100, y: prev[1] / 100 } : this.#xy(cell);
        this.ghosts.push({ ...pos, slot, t0: performance.now() });
        this.#burst(pos.x, pos.y, 18, [LIGHT[slot], COLORS[slot], '#ffffff'], 3.5, 0.7);
        this.sfx.play('die', { pan: this.#panX(pos.x) });
        if (slot === this.me) {
          if (!this.coop) this.#showBanner({ title: 'You\'re out!', sub: 'Watch the rest of the round', color: COLORS[slot], ms: 1800 });
          else if (livesLeft > 0) this.#showBanner({ title: 'Ouch!', sub: `${livesLeft} ${livesLeft === 1 ? 'life' : 'lives'} left`, color: COLORS[slot], ms: 1600 });
          else this.#showBanner({ title: 'No lives left', sub: 'Your team-mates play on', color: COLORS[slot], ms: 2200 });
        } else this.#toast(this.coop && livesLeft === 0 ? `${this.#name(slot)} is out of lives` : `${this.#name(slot)} was blown up`, COLORS[slot]);
        break;
      }
      case 'spawn':
        if (s.p[ev[1]]) this.#burst(s.p[ev[1]][0] / 100, s.p[ev[1]][1] / 100, 10, ['#ffffff', LIGHT[ev[1]]], 2, 0.5);
        break;
      case 'life': {
        const [, slot, why] = ev;
        if (why === 'points') this.sfx.play('oneup');
        this.#toast(`${slot === this.me ? 'You' : this.#name(slot)} got an extra life${why === 'points' ? ' for points' : ''}!`, COLORS[slot]);
        break;
      }
      case 'mdie': {
        const [, , type, x100, y100, by, pts] = ev;
        const x = x100 / 100;
        const y = y100 / 100;
        this.mdeaths.push({ x, y, type, t0: performance.now() });
        this.popups.push({ x, y, text: `${pts}`, t0: performance.now(), color: by >= 0 ? LIGHT[by] : '#ffffff' });
        this.#burst(x, y, 12, ['#ffffff', '#f472b6', '#fde047'], 2.6, 0.5);
        this.sfx.play('pop', { pan: this.#panX(x) });
        break;
      }
      case 'exit':
        this.#toast('You found the exit!', '#a78bfa');
        break;
      case 'open':
        this.sfx.play('open');
        this.#showBanner({ title: 'Exit open!', sub: 'Every monster is gone: everybody into the exit', color: '#22d3ee', ms: 1800 });
        break;
      case 'enter': {
        const slot = ev[1];
        if (s.ex) this.#burst(s.ex[0] % this.w, Math.floor(s.ex[0] / this.w), 14, ['#22d3ee', '#a78bfa', '#ffffff'], 2.4, 0.6);
        this.sfx.play('open', { power: 0.4 });
        const waiting = [0, 1, 2, 3].filter((k) => s.p[k] && s.ac[k] && !s.p[k][11] && (s.lv?.[k] ?? 1) > 0).length;
        if (slot === this.me) this.#showBanner({ title: 'You\'re in!', sub: waiting ? `Waiting for ${waiting} more` : 'Level clear!', color: '#22d3ee', ms: 1800 });
        else this.#toast(`${this.#name(slot)} is in the exit${waiting ? ` (${waiting} to go)` : ''}`, COLORS[slot]);
        break;
      }
      case 'exitHit':
        this.#toast('You bombed the exit: more monsters are coming out!', '#ef4444');
        break;
      case 'spawnm': {
        const { x, y } = this.#xy(ev[1]);
        this.#burst(x, y, 10, ['#a78bfa', '#ffffff'], 2, 0.5);
        break;
      }
      case 'clear':
        this.sfx.play('win');
        this.#showBanner({ kicker: LEVELS[ev[1] - 1]?.name ?? `Level ${ev[1]}`, title: 'Level clear!', sub: `+${ev[2]} points each`, color: '#fde047', ms: 3200 });
        break;
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
        const tally = [0, 1, 2, 3].filter((slot) => s.ac[slot] || s.w[slot] > 0).map((slot) => el('div', { class: 'bm-tally-row', style: `--cl:${LIGHT[slot]}` },
          el('span', { class: 'bm-tally-name' }, this.#name(slot)),
          this.#stars(s.w[slot])));
        this.#showBanner({
          kicker: `Round ${s.rd}`,
          title: winner < 0 ? 'Draw' : won ? 'You win the round!' : `${this.#name(winner, false)} wins the round`,
          sub: winner < 0 ? 'Nobody survived' : '',
          lines: [el('div', { class: 'bm-tally' }, ...tally)],
          color: winner >= 0 ? COLORS[winner] : undefined,
          ms: 3300,
        });
        break;
      }
    }
  }

  // ── HUD ──
  #img(type, cls = 'bm-ico') { return el('img', { class: cls, src: iconURL(type), alt: '' }); }

  #stars(n) {
    const span = el('span', { class: 'bm-stars' });
    const total = Math.max(this.roundsToWin, n);
    for (let k = 0; k < total; k++) span.append(this.#img('star', k < n ? 'bm-ico' : 'bm-ico bm-no'));
    return span;
  }

  #updateHud(s) {
    let label = '';
    let time = '';
    let urgent = false;
    if (this.coop) {
      label = s.ph === 'clear' ? 'Clear!' : `Level ${s.lvl ?? 1}`;
      this.phaseEl.title = LEVELS[(s.lvl ?? 1) - 1]?.name ?? '';
      time = s.ph === 'ready' ? String(Math.max(1, Math.ceil(s.tm))) : '';
      this.roundEl.replaceChildren(this.#img('monster'), ` ${s.ml ?? 0}`);
      this.roundEl.title = 'Monsters left';
    } else {
      label = { ready: 'Get ready', play: 'Fight', grace: 'Fight', result: 'Round over' }[s.ph] ?? '';
      if (s.ph === 'ready') time = String(Math.max(1, Math.ceil(s.tm)));
      else if ((s.ph === 'play' || s.ph === 'grace') && s.tm >= 0) { // tm -1: no round clock
        if (s.sd >= 0 || (s.tm <= 0 && s.ph === 'play')) { label = 'Sudden death'; urgent = true; } else {
          const t = Math.ceil(s.tm);
          time = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
          urgent = t <= 10;
        }
      }
      this.roundEl.textContent = `Round ${s.rd}`;
      this.ffEl.textContent = s.ff ? '▶▶×3' : '';
      this.ffEl.title = s.ff ? 'Only bots left this round: fast-forward' : '';
    }
    this.phaseEl.textContent = label;
    this.timeEl.textContent = time;
    this.timeEl.classList.toggle('bm-urgent', urgent);
    this.phaseEl.classList.toggle('bm-urgent', urgent && !time);

    // chips: only rebuilt when something on them changed
    const key = JSON.stringify([s.w, s.lv, s.sc, s.ac, s.bt, s.rs?.map((r) => r > 0), s.p.map((p) => (p ? [p[4], p[5], p[6], p[7], p[8], p[9], p[11]] : 0))]);
    if (key === this.hudKey) return;
    this.hudKey = key;
    const chips = [];
    for (let slot = 0; slot < 4; slot++) {
      const p = s.p[slot];
      const known = s.ac[slot] || p || (this.coop ? s.sc?.[slot] : s.w?.[slot]);
      if (!known) continue;
      const out = this.coop ? !s.ac[slot] || (s.lv[slot] === 0 && !(p && p[4])) : !p || !p[4];
      const inExit = p && p[11];
      const cls = `bm-chip${slot === this.me ? ' bm-me' : ''}${inExit ? ' bm-in' : out || (p && !p[4]) ? ' bm-dead' : ''}`;
      const top = this.coop
        ? el('span', { class: 'bm-lives' }, ...(inExit ? [el('span', { class: 'bm-in-tag' }, 'IN')] : []), this.#img(PU_LIFE), `×${s.lv[slot]}`)
        : this.#stars(s.w[slot]);
      const stats = p ? el('div', { class: 'bm-chip-stats' },
        el('span', { title: 'Bombs' }, this.#img(PU_BOMB), String(p[5])),
        el('span', { title: 'Blast range' }, this.#img(PU_FIRE), String(p[6])),
        el('span', { title: 'Speed' }, this.#img(PU_SPEED), String(p[7])),
        ...(p[8] ? [el('span', { title: 'Kick' }, this.#img(PU_KICK))] : []),
        ...(p[9] ? [el('span', { class: 'bm-cursed', title: `Cursed: ${CURSES[p[9]]}` }, this.#img(PU_SKULL))] : [])) : el('div', { class: 'bm-chip-stats' }, 'left');
      chips.push(el('div', { class: cls, style: `--c:${COLORS[slot]};--cl:${LIGHT[slot]}` },
        el('div', { class: 'bm-chip-top' }, el('span', { class: 'bm-chip-name' }, this.#name(slot)), top),
        ...(this.coop ? [el('div', { class: 'bm-chip-score' }, String(s.sc?.[slot] ?? 0).padStart(6, '0'))] : []),
        stats));
    }
    this.chips.replaceChildren(...chips);
  }

  #setHint() {
    if (this.ended) return;
    if (this.spectating) { this.hint.textContent = 'Spectating'; return; }
    if (this.root.classList.contains('bm-touching')) { this.hint.textContent = 'Stick to move · BOMB to drop a bomb'; return; }
    this.hint.replaceChildren(
      'Move ', el('kbd', {}, '←↑→↓'), ' / ', el('kbd', {}, 'WASD'), '  Bomb ', el('kbd', {}, 'Space'), '  Mute ', el('kbd', {}, 'M'),
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

  #padUpdate(e) {
    const r = this.pad.getBoundingClientRect();
    const vx = e.clientX - (r.left + r.width / 2);
    const vy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(vx, vy);
    const k = len > r.width * 0.28 ? (r.width * 0.28) / len : 1;
    this.knob.style.transform = `translate(${vx * k}px, ${vy * k}px)`;
    this.touchDir = len < 12 ? 0 : Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 2 : 4) : (vy > 0 ? 3 : 1);
    this.#syncDir();
  }

  #onPadDown = (e) => {
    e.preventDefault();
    this.pad.setPointerCapture?.(e.pointerId);
    this.padPointer = e.pointerId;
    this.#padUpdate(e);
  };

  #onPadMove = (e) => { if (e.pointerId === this.padPointer) this.#padUpdate(e); };

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

  // ── layout: the low-res canvas is scaled up by CSS, by a whole number of device pixels when that loses little ──
  #resize() {
    if (this.disposed) return;
    const c = this.ctx.container;
    const W = this.w * PX;
    const H = this.h * PX;
    const availW = c.clientWidth - 16;
    const availH = c.clientHeight - this.head.offsetHeight - this.hint.offsetHeight - 30;
    const fit = Math.max(0.25, Math.min(availW / W, availH / H));
    const dpr = window.devicePixelRatio || 1;
    let phys = Math.floor(fit * dpr);
    if (phys < 1 || phys / (fit * dpr) < 0.8) phys = fit * dpr;
    const scale = phys / dpr;
    this.stage.style.width = `${W * scale}px`;
    this.stage.style.height = `${H * scale}px`;
    this.stage.style.fontSize = `${clamp(scale / 2.4, 0.5, 1.2)}em`;
  }

  // ── static layer: floor, blocks, crates, walls in the level's theme (redrawn only when the map changes) ──
  #drawLayer() {
    const g = this.layer.getContext('2d');
    const { w, h } = this;
    const th = this.theme;
    g.clearRect(0, 0, w * PX, h * PX);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = this.grid[y * w + x];
        const px = x * PX;
        const py = y * PX;
        const r = (k) => hash(x * 31 + k, y * 17 + k * 7); // stable "random" per tile
        if (v === SOLID) {
          const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
          if (edge) th.wall(g, px, py, x, y, r);
          else if (!this.coop && !isPillar(w, h, x, y)) this.#tileMetal(g, px, py); // sudden-death wall
          else th.block(g, px, py, r);
          continue;
        }
        th.floor(g, px, py, x, y, r);
        const above = y > 0 ? this.grid[(y - 1) * w + x] : SOLID;
        if (above === SOLID || above === CRATE) { // shadow cast by the block above
          g.fillStyle = 'rgba(0,0,0,0.3)';
          g.fillRect(px, py, PX, 3);
          g.fillStyle = 'rgba(0,0,0,0.12)';
          g.fillRect(px, py + 3, PX, 1);
        }
        const left = x > 0 ? this.grid[y * w + x - 1] : SOLID;
        if (left === SOLID || left === CRATE) {
          g.fillStyle = 'rgba(0,0,0,0.16)';
          g.fillRect(px, py, 2, PX);
        }
        if (v === CRATE) th.crate(g, px, py, r);
      }
    }
    this.layerDirty = false;
  }

  #tileMetal(g, px, py) {
    g.fillStyle = '#3c4a5f'; g.fillRect(px, py, 16, 16);
    g.fillStyle = '#5b6c85'; g.fillRect(px, py, 16, 2);
    g.fillStyle = '#26303f'; g.fillRect(px, py + 13, 16, 3);
    for (let yy = 5; yy < 10; yy++) {
      for (let xx = 1; xx < 15; xx++) {
        g.fillStyle = ((xx + yy) >> 1) % 2 ? '#facc15' : '#111827';
        g.fillRect(px + xx, py + yy, 1, 1);
      }
    }
    g.fillStyle = '#a3b1c6';
    for (const [rx, ry] of [[2, 3], [13, 3], [2, 11], [13, 11]]) g.fillRect(px + rx, py + ry, 1, 1);
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
    const s = this.snap;
    const smp = this.#sample(now);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.theme.bg;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.shake > 0.05 && !this.reduced) {
      const m = Math.round(this.shake * 2.4);
      g.translate(Math.round((Math.random() * 2 - 1) * m), Math.round((Math.random() * 2 - 1) * m));
    }
    this.shake = Math.max(0, this.shake - dt * 2.8);
    g.drawImage(this.layer, 0, 0);

    this.#drawExit(g, s, now);
    this.#drawSdWarning(g, s, now);
    this.#drawFalls(g, now);
    this.#drawPowerups(g, s, now);
    this.#drawBombs(g, smp, now);
    this.#drawFlames(g, s, now);
    this.#drawActors(g, smp, now);
    this.#drawGhosts(g, now);
    this.#drawParticles(g, dt);
    this.#drawPopups(g, now);
  };

  #drawExit(g, s, now) {
    if (!s.ex) return;
    const [cell, open] = s.ex;
    const { x, y } = this.#xy(cell);
    const px = x * PX;
    const py = y * PX;
    g.fillStyle = '#14101e'; g.fillRect(px + 1, py + 1, 14, 14);
    g.fillStyle = '#6b7280'; g.fillRect(px + 2, py + 2, 12, 12);
    g.fillStyle = '#9ca3af'; g.fillRect(px + 2, py + 2, 12, 1);
    if (!open) {
      g.fillStyle = '#111827'; g.fillRect(px + 4, py + 4, 8, 9);
      g.fillStyle = '#9ca3af'; g.fillRect(px + 6, py + 4, 1, 9); g.fillRect(px + 9, py + 4, 1, 9);
      g.fillStyle = Math.floor(now / 500) % 2 ? '#ef4444' : '#7f1d1d'; g.fillRect(px + 7, py + 2, 2, 1);
      return;
    }
    const cols = ['#22d3ee', '#a78bfa', '#f0abfc', '#ffffff'];
    const phase = Math.floor(now / 110);
    for (let r = 0; r < 4; r++) {
      g.fillStyle = cols[(r + phase) % 4];
      g.fillRect(px + 4 + r, py + 4 + r, 8 - r * 2, 9 - r * 2);
    }
    g.fillStyle = '#4ade80'; g.fillRect(px + 7, py + 2, 2, 1);
    if (!this.reduced && Math.random() < 0.3) this.#push({ x: x + 0.5 + (Math.random() - 0.5) * 0.5, y: y + 0.4, vx: 0, vy: -0.8, life: 0.6, max: 0.6, size: 1, color: '#a5f3fc', drag: 0 });
  }

  #drawSdWarning(g, s, now) {
    if (s.sd === undefined || s.sd < 0) return;
    const { x, y } = this.#xy(s.sd);
    if (Math.floor(now / 90) % 2) return;
    g.fillStyle = 'rgba(239,68,68,0.55)';
    g.fillRect(x * PX, y * PX, PX, PX);
    g.fillStyle = '#fecaca';
    g.fillRect(x * PX, y * PX, PX, 1); g.fillRect(x * PX, y * PX + 15, PX, 1);
    g.fillRect(x * PX, y * PX, 1, PX); g.fillRect(x * PX + 15, y * PX, 1, PX);
  }

  #drawFalls(g, now) {
    this.falls = this.falls.filter((f) => now - f.t0 < 300);
    for (const f of this.falls) {
      const k = (now - f.t0) / 300;
      if (k > 0.45) continue;
      const { x, y } = this.#xy(f.i);
      const lift = Math.round((1 - k / 0.45) * 12);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x * PX, y * PX, PX, PX);
      this.#tileMetal(g, x * PX, y * PX - lift);
    }
  }

  #drawPowerups(g, s, now) {
    for (const [cell, type] of s.u ?? []) {
      if (this.grid[cell] !== 0) continue;
      const { x, y } = this.#xy(cell);
      const bob = this.reduced ? 0 : (Math.floor(now / 250 + cell) % 2);
      const tile = itemTile(type, type === PU_SKULL && Math.floor(now / 200) % 2 === 0);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(x * PX + 2, y * PX + 14, 12, 2);
      g.drawImage(tile, x * PX, y * PX - bob);
    }
  }

  #drawBombs(g, smp, now) {
    if (!smp) return;
    const prev = new Map(smp.a.b.map((b) => [b[0], b]));
    for (const b of smp.b.b ?? []) {
      const a = prev.get(b[0]) ?? b;
      const px = Math.round((lerp(a[1], b[1], smp.k) / 100) * PX);
      const py = Math.round((lerp(a[2], b[2], smp.k) / 100) * PX);
      const fuse = b[3]; // 1 -> 0
      const owner = b[4];
      const period = 260 + fuse * 340; // a slow throb that quickens a little as the fuse burns down (600 ms -> 260 ms)
      const big = !this.reduced && Math.floor(now / period) % 2 === 1;
      const flash = fuse < 0.22 && Math.floor(now / 140) % 2 === 0;
      const spr = sprite(`bomb${big ? 1 : 0}`, BOMB_ROWS[big ? 1 : 0]);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(px + 3, py + 14, 10, 2);
      g.drawImage(spr, px, py);
      if (flash) { // about to blow: flash red
        g.globalAlpha = 0.6;
        g.drawImage(silhouette(`bomb${big ? 1 : 0}`, spr, '#ef4444'), px, py);
        g.globalAlpha = 1;
      }
      // owner band
      g.fillStyle = COLORS[owner] ?? '#ffffff';
      g.fillRect(px + 5, py + 12, 6, 1);
      // fuse burning down and a spark
      const len = 1 + Math.round(fuse * 3);
      g.fillStyle = '#d6d3d1';
      for (let k = 0; k < len; k++) g.fillRect(px + 9 + k, py + 2 - k, 1, 1);
      const sx = px + 9 + len;
      const sy = py + 2 - len;
      g.fillStyle = ['#fde047', '#fb923c', '#ffffff'][Math.floor(now / 150) % 3];
      g.fillRect(sx, sy, 1, 1);
      if (Math.floor(now / 150) % 2) { g.fillRect(sx + 1, sy, 1, 1); g.fillRect(sx, sy - 1, 1, 1); }
    }
  }

  #drawFlames(g, s, now) {
    // burn down locally from the last snapshot, so flames still fade out once snapshots stop (end of the match)
    const age = (now - this.snapAt) / 1000 / FLAME_TIME;
    const flames = (s.f ?? []).map(([c, m, life]) => [c, m, life - age]).filter((f) => f[2] > 0);
    if (!flames.length) return;
    const w = this.w;
    const byCell = new Map(flames.map((f) => [f[0], f]));
    const eff = (m) => (m & 4 ? 3 : m);
    const flick = Math.floor(now / 90);
    for (let tier = 0; tier < 4; tier++) {
      g.fillStyle = FLAME_COLS[tier];
      for (const [cell, mask, life] of flames) {
        const k = life > 0.8 ? (1 - life) / 0.2 : life / 0.8; // grows fast, then shrinks
        let outer = 2 * Math.round((14 * clamp(0.4 + 0.6 * k, 0, 1)) / 2);
        if ((flick + cell) % 2 && !this.reduced) outer -= 2;
        const t = Math.max(0, outer - tier * 4);
        if (t <= 0) continue;
        const x = cell % w;
        const y = (cell - x) / w;
        const cx = x * PX + 8;
        const cy = y * PX + 8;
        const half = t / 2;
        const m = eff(mask);
        g.fillRect(cx - half, cy - half, t, t);
        for (let d = 1; d <= 4; d++) {
          const axis = DX[d] ? 1 : 2;
          if (!(m & axis)) continue;
          const n = byCell.get(cell + DY[d] * w + DX[d]);
          const joined = n && eff(n[1]) & axis;
          if (!joined && mask & 4) continue;
          const len = joined ? 8 : 5;
          if (DX[d]) g.fillRect(DX[d] > 0 ? cx : cx - len, cy - half, len, t);
          else g.fillRect(cx - half, DY[d] > 0 ? cy : cy - len, t, len);
          if (!joined) { // stepped, rounded tip
            for (let st = 1; st <= 2; st++) {
              const tt = t - st * 2;
              if (tt <= 0) break;
              if (DX[d]) g.fillRect(DX[d] > 0 ? cx + len + st - 1 : cx - len - st, cy - tt / 2, 1, tt);
              else g.fillRect(cx - tt / 2, DY[d] > 0 ? cy + len + st - 1 : cy - len - st, tt, 1);
            }
          }
        }
      }
    }
  }

  /** Players and monsters, sorted by their feet so nearer ones overlap farther ones. */
  #drawActors(g, smp, now) {
    if (!smp) return;
    const list = [];
    for (let slot = 0; slot < 4; slot++) {
      const b = smp.b.p[slot];
      if (!b || !b[4]) continue;
      const a = smp.a.p[slot] && smp.a.p[slot][4] ? smp.a.p[slot] : b;
      let x = lerp(a[0], b[0], smp.k) / 100;
      let y = lerp(a[1], b[1], smp.k) / 100;
      if (Math.abs(a[0] - b[0]) > 200 || Math.abs(a[1] - b[1]) > 200) { x = b[0] / 100; y = b[1] / 100; }
      list.push({ kind: 'p', slot, x, y, face: b[2], moving: b[3] === 1, curse: b[9], inv: b[10] });
    }
    if (smp.b.mo) {
      const prev = new Map((smp.a.mo ?? []).map((m) => [m[0], m]));
      for (const m of smp.b.mo) {
        const a = prev.get(m[0]) ?? m;
        list.push({ kind: 'm', id: m[0], type: m[1], x: lerp(a[2], m[2], smp.k) / 100, y: lerp(a[3], m[3], smp.k) / 100, dir: m[4] });
      }
    }
    for (const d of this.mdeaths) if (now - d.t0 < 260) list.push({ kind: 'md', ...d });
    this.mdeaths = this.mdeaths.filter((d) => now - d.t0 < 260);
    list.sort((p, q) => p.y - q.y);
    for (const a of list) {
      if (a.kind === 'p') this.#drawPlayer(g, a, now);
      else if (a.kind === 'm') this.#drawMonster(g, a, now);
      else this.#drawMonsterDeath(g, a, now);
    }
  }

  #drawPlayer(g, { slot, x, y, face, moving, curse, inv }, now) {
    const px = Math.round(x * PX);
    const py = Math.round(y * PX);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(px + 4, py + 13, 8, 2);
    g.fillRect(px + 3, py + 14, 10, 1);
    if (inv && Math.floor(now / 70) % 2) return; // shield: blink
    const frame = moving && !this.reduced ? Math.floor(now / 110) % 4 : 0;
    const view = face === 1 ? 'up' : face === 3 || !face ? 'down' : 'side';
    const sick = curse && Math.floor(now / 160) % 2 === 0;
    const key = `p${slot}${view}${frame}${sick ? 'c' : ''}`;
    let spr = sprite(key, PLAYER[view][frame], seatPalette(COLORS[slot], sick));
    if (face === 4) spr = mirrored(key, spr);
    const bob = frame % 2 ? 1 : 0;
    g.drawImage(spr, px, py - 4 - bob);
    if (curse) { // a little skull over the head
      const sk = sprite('miniskull', MINI_SKULL, {}, true);
      g.drawImage(sk, px + 5, py - 11 - bob + (Math.floor(now / 300) % 2));
    } else if (slot === this.me) { // "this is you"
      const my = py - 9 - bob + (this.reduced ? 0 : Math.floor(now / 300) % 2);
      g.fillStyle = '#14101e';
      g.fillRect(px + 5, my - 1, 7, 1);
      g.fillStyle = '#ffffff';
      g.fillRect(px + 5, my, 7, 1); g.fillRect(px + 6, my + 1, 5, 1); g.fillRect(px + 7, my + 2, 3, 1); g.fillRect(px + 8, my + 3, 1, 1);
    }
  }

  #drawMonster(g, { type, x, y, dir, id }, now) {
    const px = Math.round(x * PX);
    const py = Math.round(y * PX);
    const frame = Math.floor(now / (type === M_DASHER ? 90 : 180) + id) % 2;
    const key = `m${type}${frame}`;
    let spr = sprite(key, MONSTER[type][frame]);
    if (type === M_DASHER && dir === 4) spr = mirrored(key, spr);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(px + 4, py + 13, 8, 2);
    if (type === M_GHOST) {
      g.globalAlpha = 0.72;
      g.drawImage(spr, px, py - 3 - (Math.floor(now / 250 + id) % 2));
      g.globalAlpha = 1;
    } else g.drawImage(spr, px, py - 2);
  }

  #drawMonsterDeath(g, { type, x, y, t0 }, now) {
    const k = (now - t0) / 260;
    const spr = sprite(`m${type}0`, MONSTER[type][0]);
    const flash = silhouette(`m${type}0`, spr, Math.floor(k * 6) % 2 ? '#ffffff' : '#fde047');
    const shrink = Math.round(k * 6);
    g.drawImage(flash, Math.round(x * PX) + shrink, Math.round(y * PX) - 2 + shrink * 2, 16 - shrink * 2, 16 - shrink * 2);
  }

  #drawGhosts(g, now) {
    this.ghosts = this.ghosts.filter((gh) => now - gh.t0 < 1100);
    for (const gh of this.ghosts) {
      const k = (now - gh.t0) / 1100;
      g.globalAlpha = 1 - k;
      g.drawImage(sprite('ghostp', GHOST_PLAYER), Math.round(gh.x * PX), Math.round(gh.y * PX - 4 - k * 14));
      g.globalAlpha = 1;
    }
  }

  #drawPopups(g, now) {
    this.popups = this.popups.filter((p) => now - p.t0 < 1000);
    for (const p of this.popups) {
      const k = (now - p.t0) / 1000;
      const text = p.text;
      const wpx = text.length * 4 - 1;
      const x0 = Math.round(p.x * PX + 8 - wpx / 2);
      const y0 = Math.round(p.y * PX - 2 - k * 10);
      for (const [col, ox, oy] of [['#14101e', 1, 0], ['#14101e', -1, 0], ['#14101e', 0, 1], ['#14101e', 0, -1], [p.color, 0, 0]]) {
        g.fillStyle = col;
        for (let n = 0; n < text.length; n++) {
          const glyph = DIGITS[text[n]];
          if (!glyph) continue;
          for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) if (glyph[gy][gx] === '1') g.fillRect(x0 + n * 4 + gx + ox, y0 + gy + oy, 1, 1);
        }
      }
    }
  }

  // ── particles (positions in tiles, drawn as whole pixels) ──
  #push(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  #burst(x, y, n, colors, speed, life) {
    if (this.reduced) n = Math.ceil(n / 3);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.#push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, size: Math.random() < 0.3 ? 2 : 1, color: colors[k % colors.length], drag: 3 });
    }
  }

  #smoke(x, y, n) {
    if (this.reduced) return;
    for (let k = 0; k < n; k++) {
      this.#push({ x: x + 0.5 + (Math.random() - 0.5) * 0.6, y: y + 0.5 + (Math.random() - 0.5) * 0.6, vx: (Math.random() - 0.5) * 0.4, vy: -0.4 - Math.random() * 0.4, life: 0.8, max: 0.8, size: 3, color: '#6b7280', drag: 0.5, grow: true });
    }
  }

  #debris(cell) {
    const { x, y } = this.#xy(cell);
    const n = this.reduced ? 3 : 9;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = 1 + Math.random() * 2.2;
      this.#push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6, max: 0.6, size: 2, color: this.theme.debris[k % 2], drag: 3.5 });
    }
  }

  #drawParticles(g, dt) {
    const keep = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const f = Math.exp(-p.drag * dt);
      p.vx *= f;
      p.vy *= f;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const a = clamp(p.life / p.max, 0, 1);
      const size = p.grow ? Math.max(1, Math.round(p.size * (1.6 - a))) : p.size;
      g.globalAlpha = p.grow ? a * 0.6 : a > 0.3 ? 1 : a / 0.3;
      g.fillStyle = p.color;
      g.fillRect(Math.round(p.x * PX - size / 2), Math.round(p.y * PX - size / 2), size, size);
      keep.push(p);
    }
    g.globalAlpha = 1;
    this.particles = keep;
  }
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const bombers = {
  meta,
  mount: (ctx) => new BombersView(ctx),
};

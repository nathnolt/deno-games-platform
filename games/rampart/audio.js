// Client only. Sound effects: synthesized with Web Audio by default, but any of them can be replaced by a
// sound FILE (see SOUND_FILES). Browsers only start audio after a user gesture: call unlock() from
// click / key handlers (the shell's "Start game" click usually already counts).

/**
 * ★ SOUND FILES. Map a sound name to a file and that file plays instead of the synthesized sound.
 * Leave a name out (or comment it out) to keep the synthesized one. Files live in games/ramparts/sounds/
 * (wav, mp3, ogg, m4a and flac are all served). A file that is missing or can't be decoded falls back
 * to the synthesized sound.
 *
 * Names: fire, hit, boom, splash, thud, place, cannon, deny, phase, life, claim.
 * Entry: a URL string, or { url, volume (default 1), rate (default 1 = original pitch), jitter (random pitch spread, default 0.04) }.
 * To play only a part of a longer file, add start / end in seconds: { url: '.../sfx.wav', start: 0.4, end: 0.74 }.
 */
const SOUND_DIR = new URL('./sounds/', import.meta.url).href;
export const SOUND_FILES = {
  // fire: `${SOUND_DIR}fire.wav`,
  // hit: { url: `${SOUND_DIR}brick.wav`, volume: 0.9 },
  // boom: `${SOUND_DIR}boom.wav`,
};

const MUTE_KEY = 'ramparts.muted'; // per-player preference, so it lives in localStorage, not in the room settings

const readMuted = () => {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
};

export class Sfx {
  constructor() {
    this.muted = readMuted();
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.last = new Map(); // sound kind -> audio time it last played (stops machine-gun stacking)
    this.files = new Map(); // sound kind -> { buffer, volume, rate, jitter, start, end } once its file has loaded
    this.loading = false;
  }

  #ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC();
    } catch {
      return null;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    const limiter = c.createDynamicsCompressor(); // several hits at once shouldn't clip
    this.master.connect(limiter);
    limiter.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate >> 1, c.sampleRate); // 0.5 s of white noise, shared by all noisy sounds
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.#loadFiles();
    return c;
  }

  /** Fetches and decodes every file in SOUND_FILES, once. Until a file is ready (or if it fails) the synth plays. */
  #loadFiles() {
    if (this.loading) return;
    this.loading = true;
    const c = this.ctx;
    for (const [kind, spec] of Object.entries(SOUND_FILES)) {
      const o = typeof spec === 'string' ? { url: spec } : spec;
      fetch(o.url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${o.url}`))))
        .then((data) => c.decodeAudioData(data))
        .then((buffer) => {
          if (this.ctx !== c) return; // disposed meanwhile
          this.files.set(kind, { buffer, volume: o.volume ?? 1, rate: o.rate ?? 1, jitter: o.jitter ?? 0.04, start: o.start ?? 0, end: o.end ?? buffer.duration });
        })
        .catch((err) => console.warn(`Ramparts: sound file for "${kind}" not used (${err.message}); using the synthesized sound`));
    }
  }

  #playFile(f, out) {
    const c = this.ctx;
    const s = c.createBufferSource();
    const g = c.createGain();
    s.buffer = f.buffer;
    s.playbackRate.value = f.rate * (1 - f.jitter + Math.random() * 2 * f.jitter);
    g.gain.value = f.volume;
    s.connect(g);
    g.connect(out);
    s.start(c.currentTime, f.start, Math.max(0.01, f.end - f.start));
  }

  unlock() {
    const c = this.#ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  setMuted(muted) {
    this.muted = muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* private mode: not persisted */ }
    if (this.master) this.master.gain.value = muted ? 0 : 0.6;
    if (!muted) this.unlock();
  }

  dispose() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.files.clear();
    this.loading = false;
  }

  /**
   * @param {'fire'|'hit'|'boom'|'splash'|'thud'|'place'|'cannon'|'deny'|'phase'|'life'|'claim'} kind
   * @param {{pan?: number, power?: number}} opts pan -1..1 (where on the board), power 0..1 (how big it should sound)
   */
  play(kind, { pan = 0, power = 0.5 } = {}) {
    if (this.muted) return;
    const c = this.#ensure();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    if (t - (this.last.get(kind) ?? -1) < 0.035) return;
    this.last.set(kind, t);
    const out = this.#output(pan);
    const file = this.files.get(kind);
    if (file) return this.#playFile(file, out);
    const j = 0.94 + Math.random() * 0.12; // a little pitch variation keeps repeated sounds from sounding robotic
    switch (kind) {
      case 'fire': { // cannon shot: thump, blast of noise, falling saw
        this.#tone(out, 'sine', 150 * j, 42, 0.32, 0.55, t);
        this.#tone(out, 'sawtooth', 110 * j, 45, 0.2, 0.12, t);
        this.#hiss(out, 'lowpass', 1400, 0.22, 0.4, t);
        break;
      }
      case 'hit': { // stone wall shattering
        this.#hiss(out, 'bandpass', 1300 * j, 0.16, 0.5, t);
        this.#tone(out, 'triangle', 320 * j, 110, 0.14, 0.3, t);
        this.#hiss(out, 'highpass', 3500, 0.07, 0.18, t + 0.02);
        break;
      }
      case 'boom': { // a cannon is destroyed: low boom, rumble, falling saw
        this.#tone(out, 'sine', 170, 34, 0.7, 0.8, t);
        this.#tone(out, 'sawtooth', 120, 46, 0.45, 0.2, t);
        this.#hiss(out, 'lowpass', 900, 0.5, 0.6, t);
        this.#tone(out, 'square', 520, 90, 0.3, 0.1, t + 0.04);
        break;
      }
      case 'splash': { // ball falls in the water
        this.#hiss(out, 'bandpass', 2200, 0.22, 0.28, t);
        this.#tone(out, 'sine', 600 * j, 200, 0.12, 0.1, t);
        break;
      }
      case 'thud': { // ball hits bare ground or a castle
        this.#tone(out, 'sine', 120 * j, 60, 0.12, 0.3, t);
        this.#hiss(out, 'lowpass', 500, 0.1, 0.25, t);
        break;
      }
      case 'place': { // a wall piece clicks into place
        this.#tone(out, 'square', 330 * j, 200, 0.07, 0.16, t);
        this.#hiss(out, 'lowpass', 900, 0.04, 0.14, t);
        break;
      }
      case 'cannon': { // a cannon is set down: iron clank
        this.#tone(out, 'triangle', 190 * j, 80, 0.16, 0.4, t);
        this.#hiss(out, 'bandpass', 1500, 0.08, 0.25, t);
        this.#tone(out, 'sine', 900 * j, 700, 0.08, 0.1, t);
        break;
      }
      case 'deny': { // cannot do that here
        this.#tone(out, 'sawtooth', 150, 105, 0.12, 0.12, t);
        break;
      }
      case 'phase': { // new phase: two soft chimes
        this.#tone(out, 'sine', 523, 523, 0.22, 0.22, t);
        this.#tone(out, 'sine', 784, 784, 0.3, 0.2, t + 0.1);
        break;
      }
      case 'life': { // a life is lost: falling tone
        this.#tone(out, 'sawtooth', 330, 70, 0.6, 0.2, t);
        this.#tone(out, 'sine', 220, 50, 0.7, 0.4, t);
        break;
      }
      case 'claim': { // a castle is claimed: rising arpeggio
        this.#tone(out, 'triangle', 392, 392, 0.14, 0.22, t);
        this.#tone(out, 'triangle', 523, 523, 0.14, 0.22, t + 0.09);
        this.#tone(out, 'triangle', 659, 659, 0.26, 0.22, t + 0.18);
        break;
      }
    }
  }

  #output(pan) {
    const c = this.ctx;
    if (!c.createStereoPanner) return this.master;
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    return p;
  }

  #tone(out, type, f0, f1, dur, gain, t0) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  #hiss(out, filterType, freq, dur, gain, t0) {
    const c = this.ctx;
    const s = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    s.buffer = this.noise;
    f.type = filterType;
    f.frequency.value = freq;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f);
    f.connect(g);
    g.connect(out);
    s.start(t0, Math.random() * 0.2);
    s.stop(t0 + dur + 0.03);
  }
}

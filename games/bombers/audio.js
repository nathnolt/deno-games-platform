// Client only. Sound effects: synthesized with Web Audio by default, but any of them can be replaced by a
// sound FILE (see SOUND_FILES). Browsers only start audio after a user gesture: call unlock() from
// click / key handlers (the shell's "Start game" click usually already counts).

/**
 * ★ SOUND FILES. Map a sound name to a file and that file plays instead of the synthesized sound.
 * Leave a name out (or comment it out) to keep the synthesized one. Files live in games/bombers/sounds/
 * (wav, mp3, ogg, m4a and flac are all served). A file that is missing or can't be decoded falls back
 * to the synthesized sound.
 *
 * Names: drop, boom, crate, pick, kick, die, wall, go, sd, win, count.
 * Entry: a URL string, or { url, volume (default 1), rate (default 1 = original pitch), jitter (random pitch spread, default 0.04) }.
 * To play only a part of a longer file, add start / end in seconds: { url: '.../sfx.wav', start: 0.4, end: 0.74 }.
 */
const SOUND_DIR = new URL('./sounds/', import.meta.url).href;
export const SOUND_FILES = {
  // boom: `${SOUND_DIR}boom.wav`,
  // drop: { url: `${SOUND_DIR}drop.wav`, volume: 0.8 },
  // pick: { url: `${SOUND_DIR}sfx.wav`, start: 0.4, end: 0.74 },
};

const MUTE_KEY = 'bombers.muted'; // per-player preference, so it lives in localStorage, not in the room settings

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
        .catch((err) => console.warn(`Bombers: sound file for "${kind}" not used (${err.message}); using the synthesized sound`));
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
   * @param {'drop'|'boom'|'crate'|'pick'|'kick'|'die'|'wall'|'go'|'sd'|'win'|'count'} kind
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
    const pw = Math.max(0, Math.min(1, power));
    switch (kind) {
      case 'drop': { // a bomb is set down: soft thunk + fuse hiss
        this.#tone(out, 'sine', 220 * j, 90, 0.12, 0.35, t);
        this.#hiss(out, 'highpass', 5000, 0.25, 0.05, t + 0.03);
        break;
      }
      case 'boom': { // explosion: the bigger the blast range, the deeper and longer
        const len = 0.45 + pw * 0.4;
        this.#tone(out, 'sine', (140 - pw * 40) * j, 30, len, 0.85, t);
        this.#tone(out, 'sawtooth', 95 * j, 38, len * 0.6, 0.22, t);
        this.#hiss(out, 'lowpass', 1200 + pw * 800, len, 0.7, t);
        this.#hiss(out, 'bandpass', 3000, 0.08, 0.25, t);
        break;
      }
      case 'crate': { // wooden crate splinters
        this.#hiss(out, 'bandpass', 1800 * j, 0.14, 0.4, t);
        this.#tone(out, 'triangle', 260 * j, 120, 0.1, 0.25, t);
        this.#hiss(out, 'highpass', 4000, 0.06, 0.15, t + 0.03);
        break;
      }
      case 'pick': { // power-up: quick rising arpeggio
        this.#tone(out, 'square', 660 * j, 660 * j, 0.07, 0.09, t);
        this.#tone(out, 'square', 880 * j, 880 * j, 0.07, 0.09, t + 0.06);
        this.#tone(out, 'square', 1320 * j, 1320 * j, 0.12, 0.08, t + 0.12);
        break;
      }
      case 'kick': { // a bomb is kicked: thwack
        this.#tone(out, 'triangle', 420 * j, 140, 0.09, 0.35, t);
        this.#hiss(out, 'bandpass', 2500, 0.05, 0.2, t);
        break;
      }
      case 'die': { // a player is blown up: falling wail
        this.#tone(out, 'sawtooth', 520, 60, 0.7, 0.16, t);
        this.#tone(out, 'square', 780, 90, 0.5, 0.06, t + 0.05);
        break;
      }
      case 'wall': { // sudden-death wall slams down
        this.#tone(out, 'sine', 90 * j, 40, 0.25, 0.5, t);
        this.#hiss(out, 'lowpass', 600, 0.18, 0.35, t);
        break;
      }
      case 'go': { // round starts
        this.#tone(out, 'square', 523, 523, 0.1, 0.12, t);
        this.#tone(out, 'square', 1046, 1046, 0.25, 0.12, t + 0.1);
        break;
      }
      case 'count': { // countdown blip
        this.#tone(out, 'square', 523, 523, 0.08, 0.08, t);
        break;
      }
      case 'sd': { // sudden death: alarm
        for (let k = 0; k < 3; k++) {
          this.#tone(out, 'square', 880, 660, 0.18, 0.1, t + k * 0.22);
        }
        break;
      }
      case 'win': { // round won: little fanfare
        this.#tone(out, 'triangle', 523, 523, 0.14, 0.22, t);
        this.#tone(out, 'triangle', 659, 659, 0.14, 0.22, t + 0.12);
        this.#tone(out, 'triangle', 784, 784, 0.14, 0.22, t + 0.24);
        this.#tone(out, 'triangle', 1046, 1046, 0.4, 0.22, t + 0.36);
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

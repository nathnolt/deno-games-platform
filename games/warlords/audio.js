// Client only. Tiny synthesized sound effects (Web Audio), so the game needs no audio files
// (and no MIME-type changes in server/main.js). Browsers only start audio after a user gesture:
// call unlock() from click / key handlers (the shell's "Start game" click usually already counts).

const MUTE_KEY = 'warlords.muted'; // per-player preference, so it lives in localStorage, not in the room settings

const readMuted = () => {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
};

export class Sfx {
  constructor() {
    this.muted = readMuted();
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.last = new Map(); // sound kind -> audio time it last played (to stop machine-gun stacking)
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
    return c;
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
  }

  /**
   * @param {'paddle'|'brick'|'king'|'spawn'|'wall'|'catch'|'launch'} kind
   * @param {{pan?: number, power?: number}} opts pan -1..1 (where on the board), power 0..1 (how hard the ball is moving)
   */
  play(kind, { pan = 0, power = 0 } = {}) {
    if (this.muted) return;
    const c = this.#ensure();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    if (t - (this.last.get(kind) ?? -1) < 0.04) return;
    this.last.set(kind, t);
    const out = this.#output(pan);
    const jitter = 0.94 + Math.random() * 0.12; // a little pitch variation keeps repeated hits from sounding robotic
    switch (kind) {
      case 'paddle': { // classic "pong": a clean tone, higher for harder hits
        const f = (260 + 340 * power) * jitter;
        this.#tone(out, 'square', f, f * 0.85, 0.085, 0.2, t);
        this.#tone(out, 'triangle', f * 2, f * 1.4, 0.05, 0.16, t);
        break;
      }
      case 'brick': { // a bright crack plus a glassy ping
        this.#hiss(out, 'bandpass', 2600, 0.06, 0.32, t);
        this.#tone(out, 'triangle', 950 * jitter, 520, 0.1, 0.28, t);
        this.#tone(out, 'sine', 1900 * jitter, 1250, 0.06, 0.1, t);
        break;
      }
      case 'king': { // the warlord falls: low boom, rumble, falling saw
        this.#tone(out, 'sine', 170, 36, 0.65, 0.8, t);
        this.#tone(out, 'sawtooth', 120, 48, 0.45, 0.2, t);
        this.#hiss(out, 'lowpass', 900, 0.4, 0.55, t);
        this.#tone(out, 'square', 520, 90, 0.3, 0.1, t + 0.04);
        break;
      }
      case 'spawn': { // a rising blip
        this.#tone(out, 'sine', 220, 900, 0.26, 0.28, t);
        this.#tone(out, 'triangle', 440, 1800, 0.2, 0.1, t + 0.03);
        break;
      }
      case 'catch': { // the ball sticks: a dull "tock" with a little squelch
        this.#tone(out, 'sine', 240 * jitter, 120, 0.09, 0.3, t);
        this.#hiss(out, 'lowpass', 700, 0.05, 0.18, t);
        break;
      }
      case 'launch': { // let go: a quick rising whoosh and a snap
        this.#tone(out, 'triangle', 300 * jitter, 1100, 0.12, 0.22, t);
        this.#hiss(out, 'bandpass', 1800, 0.1, 0.2, t);
        break;
      }
      case 'wall': { // soft thud
        this.#tone(out, 'sine', 150 * jitter, 85, 0.07, 0.1 + 0.08 * power, t);
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

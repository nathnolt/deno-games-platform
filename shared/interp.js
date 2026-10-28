export const lerp = (a, b, t) => a + (b - a) * t;

/** Keeps recent snapshots and samples them `delayMs` in the past so motion looks smooth. */
export class SnapshotBuffer {
  #items = [];
  constructor(delayMs = 60) {
    this.delayMs = delayMs;
  }

  push(data) {
    this.#items.push({ time: performance.now(), data });
    if (this.#items.length > 30) this.#items.shift();
  }

  /** @returns {{a: any, b: any, alpha: number} | null} */
  sample() {
    const n = this.#items.length;
    if (!n) return null;
    const rt = performance.now() - this.delayMs;
    for (let i = n - 1; i >= 1; i--) {
      const a = this.#items[i - 1];
      const b = this.#items[i];
      if (a.time <= rt) {
        const alpha = Math.min(1, Math.max(0, (rt - a.time) / (b.time - a.time || 1)));
        return { a: a.data, b: b.data, alpha };
      }
    }
    return { a: this.#items[0].data, b: this.#items[0].data, alpha: 0 };
  }
}

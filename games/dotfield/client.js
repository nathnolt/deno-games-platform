import { COLORS, meta } from './shared.js';

class DotFieldView {
  names = new Map(); // playerId -> name, kept fresh by onRoom
  dots = []; //         [[playerId, slot, x, y], ...] from the latest snapshot
  lastSent = 0;

  constructor(ctx) {
    this.ctx = ctx; // ctx.me.slot is -1 for a spectator (also for a full room: the shell offers "Join game" in the top bar)
    this.canvas = document.createElement('canvas');
    ctx.container.append(this.canvas);
    this.observer = new ResizeObserver(() => this.#resize());
    this.observer.observe(ctx.container);
    if (ctx.me.slot >= 0) this.canvas.addEventListener('pointermove', this.#onMove);
    this.onRoom(ctx.room);
  }

  // ── GameView ──
  onRoom(room) {
    this.names = new Map(room.players.map((p) => [p.id, p.name])); // fires whenever somebody joins, leaves or renames
    this.#draw();
  }

  onSnapshot(s) {
    this.dots = s.dots;
    this.#draw();
  }

  dispose() {
    this.observer.disconnect();
    this.canvas.remove();
  }

  // ── input / drawing ──
  #onMove = (e) => {
    const now = performance.now();
    if (now - this.lastSent < 50) return; // at most 20 messages a second
    this.lastSent = now;
    const r = this.canvas.getBoundingClientRect();
    this.ctx.sendInput({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.ctx.container;
    this.canvas.width = this.canvas.height = Math.max(100, Math.min(w, h));
    this.#draw();
  }

  #draw() {
    const g = this.canvas.getContext('2d');
    const size = this.canvas.width;
    g.clearRect(0, 0, size, size);
    g.strokeStyle = '#26304f';
    g.strokeRect(0.5, 0.5, size - 1, size - 1);
    g.font = '14px system-ui';
    g.textAlign = 'center';
    for (const [id, slot, x, y] of this.dots) {
      g.fillStyle = COLORS[slot] ?? '#fff';
      g.beginPath();
      g.arc(x * size, y * size, id === this.ctx.me.id ? 12 : 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#e2e8f0';
      g.fillText(this.names.get(id) ?? '', x * size, y * size - 16);
    }
  }
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const dotfield = { meta, mount: (ctx) => new DotFieldView(ctx) };

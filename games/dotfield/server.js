import { meta } from './shared.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

class DotField {
  constructor(ctx) {
    this.dots = new Map(); // playerId -> { slot, x, y, tx, ty }
    for (const p of ctx.players) this.#add(p); // whoever is seated when the match starts (the room creator)
  }

  // ── GameInstance ──
  onJoin(player) {
    this.#add(player); // somebody took a free seat mid-match. Return false to refuse them (they then just watch)
  }

  onLeave(playerId) {
    this.dots.delete(playerId); // disconnect, "Leave" or "Spectate". Do NOT call ctx.end(): the match just goes on
  }

  onInput(playerId, data) {
    const d = this.dots.get(playerId); // spectators are not in the map: ignored
    if (!d || !Number.isFinite(data?.x) || !Number.isFinite(data?.y)) return;
    d.tx = clamp01(data.x);
    d.ty = clamp01(data.y);
  }

  update(dt) {
    const k = 1 - Math.exp(-6 * dt); // ease every dot toward its target
    for (const d of this.dots.values()) {
      d.x += (d.tx - d.x) * k;
      d.y += (d.ty - d.y) * k;
    }
  }

  snapshot() {
    // Names are NOT sent here: clients get them from the room state (see onRoom in client.js).
    return { dots: [...this.dots.entries()].map(([id, d]) => [id, d.slot, round3(d.x), round3(d.y)]) };
  }

  #add({ id, slot }) {
    this.dots.set(id, { slot, x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const dotfield = { meta, create: (ctx) => new DotField(ctx) };

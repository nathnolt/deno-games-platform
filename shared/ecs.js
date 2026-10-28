// A tiny ECS. Components are tokens; the data lives inside each World, so every
// room (and the client renderer) can own an independent world.

export const defineComponent = (name) => ({ name });

export class World {
  #nextId = 1;
  #entities = new Set();
  #stores = new Map();

  create() {
    const e = this.#nextId++;
    this.#entities.add(e);
    return e;
  }

  destroy(e) {
    this.#entities.delete(e);
    for (const s of this.#stores.values()) s.delete(e);
  }

  add(e, component, value) {
    this.#store(component).set(e, value);
    return value;
  }

  get(e, component) {
    return this.#store(component).get(e);
  }

  has(e, component) {
    return this.#store(component).has(e);
  }

  remove(e, component) {
    this.#store(component).delete(e);
  }

  /** Entities that have ALL the given components. Returns a copy, so mutating while looping is safe. */
  query(...components) {
    if (!components.length) return [...this.#entities];
    const stores = components.map((c) => this.#store(c)).sort((a, b) => a.size - b.size);
    const out = [];
    for (const e of stores[0].keys()) if (stores.every((s) => s.has(e))) out.push(e);
    return out;
  }

  #store(component) {
    let s = this.#stores.get(component);
    if (!s) this.#stores.set(component, (s = new Map()));
    return s;
  }
}

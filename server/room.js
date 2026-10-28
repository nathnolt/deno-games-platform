import { defaultSettings, sanitizeSettings } from '../shared/settings.js';

/**
 * A room is game-agnostic: members, host, readiness, settings and the tick loop.
 * What happens inside a match is delegated to the game's instance.
 */
export class Room {
  #members = new Map(); // clientId -> { client, ready, slot }
  #hostId = '';
  #settings;
  #status = 'lobby';
  #instance = null;
  #timer = null;

  /** @param {{solo?: boolean}} [options]  solo rooms hold one human, are hidden from the lobby list, and are never joinable */
  constructor(id, name, game, onChange, { solo = false } = {}) {
    this.id = id;
    this.name = name;
    this.game = game;
    this.onChange = onChange;
    this.solo = solo;
    this.#settings = defaultSettings(game.meta);
  }

  get empty() {
    return this.#members.size === 0;
  }

  join(client) {
    if (this.#status === 'playing') throw new Error('A game is in progress in this room');
    if (this.#members.size >= (this.solo ? 1 : this.game.meta.maxPlayers)) {
      throw new Error(this.solo ? 'This is a solo room' : 'Room is full');
    }
    const used = new Set([...this.#members.values()].map((m) => m.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    this.#members.set(client.id, { client, ready: false, slot });
    if (!this.#hostId) this.#hostId = client.id;
    client.room = this;
    this.broadcastState();
  }

  leave(client) {
    if (!this.#members.has(client.id)) return;
    if (this.#status === 'playing') this.#instance?.onLeave(client.id);
    this.#members.delete(client.id);
    client.room = null;
    client.send({ t: 'room', room: null });
    if (this.empty) return this.#stop();
    if (this.#hostId === client.id) this.#hostId = this.#members.keys().next().value;
    this.broadcastState();
  }

  setSettings(client, raw) {
    this.#requireHost(client);
    if (this.#status !== 'lobby') throw new Error('Cannot change settings during a game');
    this.#settings = sanitizeSettings(this.game.meta, raw);
    for (const m of this.#members.values()) if (m.client.id !== this.#hostId) m.ready = false;
    this.broadcastState();
  }

  setReady(client, ready) {
    const m = this.#members.get(client.id);
    if (m && this.#status === 'lobby') m.ready = ready;
    this.broadcastState();
  }

  start(client) {
    this.#requireHost(client);
    if (this.#status !== 'lobby') return;
    const { minPlayers, tickRate } = this.game.meta;
    if (this.#members.size < minPlayers) throw new Error(`Need at least ${minPlayers} players`);
    if ([...this.#members.values()].some((m) => m.client.id !== this.#hostId && !m.ready)) {
      throw new Error('Not everyone is ready');
    }
    const problem = this.game.canStart?.({ players: this.#members.size, settings: this.#settings });
    if (problem) throw new Error(problem);

    this.#status = 'playing';
    const state = this.state();
    this.#instance = this.game.create({
      players: state.players,
      settings: this.#settings,
      end: (result) => this.#endGame(result),
    });
    this.#broadcast({ t: 'gameStart', room: state });
    this.onChange();

    let last = performance.now();
    this.#timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.#instance?.update(dt);
      if (this.#instance) this.#broadcast({ t: 'snapshot', data: this.#instance.snapshot() });
    }, 1000 / tickRate);
  }

  input(client, data) {
    if (this.#status === 'playing') this.#instance?.onInput(client.id, data);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      gameId: this.game.meta.id,
      players: this.#members.size,
      maxPlayers: this.game.meta.maxPlayers,
      status: this.#status,
      solo: this.solo,
    };
  }

  state() {
    return {
      id: this.id,
      name: this.name,
      gameId: this.game.meta.id,
      hostId: this.#hostId,
      players: [...this.#members.values()].map((m) => ({
        id: m.client.id,
        name: m.client.name,
        ready: m.ready,
        slot: m.slot,
      })),
      settings: this.#settings,
      status: this.#status,
      solo: this.solo,
    };
  }

  broadcastState() {
    this.#broadcast({ t: 'room', room: this.state() });
  }

  #endGame(result) {
    if (this.#status !== 'playing') return;
    this.#stop();
    this.#status = 'lobby';
    for (const m of this.#members.values()) m.ready = false;
    this.#broadcast({ t: 'gameEnd', result });
    this.broadcastState();
    this.onChange();
  }

  #stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#instance = null;
  }

  #requireHost(client) {
    if (client.id !== this.#hostId) throw new Error('Only the host can do that');
  }

  #broadcast(msg) {
    // Serialize once, send to everyone: this runs 60 times a second per room.
    const json = JSON.stringify(msg);
    for (const m of this.#members.values()) m.client.sendRaw(json);
  }
}

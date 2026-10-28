import { defaultSettings, sanitizeSettings } from '../shared/settings.js';

/**
 * A room is game-agnostic: members, host, readiness, settings, SEATS and the tick loop.
 * What happens inside a match is delegated to the game's instance.
 *
 * Seats (one per `meta.maxPlayers`, shown to the host as one row each):
 *   mode 'open'   anyone can sit here. If `playerId` is set, that person is sitting in it ("Player").
 *   mode 'bot'    the game fills it with a bot.
 *   mode 'closed' nobody plays here.
 * Members without a seat are spectators. They can join at any time, even mid-game, and just watch.
 */
export class Room {
  #members = new Map(); // clientId -> { client, ready }
  #seats; //             [{ mode: 'open' | 'bot' | 'closed', playerId: string | null }]
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
    // Solo: the human takes the first seat, bots fill the rest. Multiplayer: everything starts open.
    this.#seats = Array.from({ length: game.meta.maxPlayers }, (_, i) => ({ mode: solo && i > 0 ? 'bot' : 'open', playerId: null }));
  }

  get empty() {
    return this.#members.size === 0;
  }

  join(client) {
    if (this.solo && this.#members.size >= 1) throw new Error('This is a solo room');
    this.#members.set(client.id, { client, ready: false });
    if (!this.#hostId) this.#hostId = client.id;
    client.room = this;
    // Before the game starts, take the first open seat if there is one; otherwise (or mid-game) just watch.
    if (this.#status === 'lobby') {
      const free = this.#seats.findIndex((s) => s.mode === 'open' && !s.playerId);
      if (free >= 0) this.#seats[free].playerId = client.id;
    }
    this.broadcastState();
    // Somebody arriving mid-game gets the game screen straight away, as a spectator.
    if (this.#status === 'playing') client.send({ t: 'gameStart', room: this.state() });
  }

  leave(client) {
    if (!this.#members.has(client.id)) return;
    const seat = this.#seatOf(client.id);
    if (this.#status === 'playing' && seat >= 0) this.#instance?.onLeave(client.id);
    if (seat >= 0) this.#vacate(seat);
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

  // ── seats ──
  /** A member sits in an open, empty seat (moving from their current one if any). */
  takeSeat(client, index) {
    this.#requireLobby();
    const seat = this.#seat(index);
    if (seat.playerId === client.id) return;
    if (seat.mode !== 'open') throw new Error('That seat is not open');
    if (seat.playerId) throw new Error('That seat is taken');
    this.#sit(client.id, index);
    this.broadcastState();
  }

  /** A member gives up their seat and watches instead. */
  spectate(client) {
    this.#requireLobby();
    if (this.solo) throw new Error('A solo game needs you in a seat');
    const seat = this.#seatOf(client.id);
    if (seat >= 0) this.#vacate(seat);
    this.broadcastState();
  }

  /**
   * Host only. value: 'open' | 'bot' | 'closed' | 'player:<memberId>'
   * Picking a person seats them here (they leave their old seat; whoever sat here is swapped into it,
   * or becomes a spectator). Picking bot/closed on an occupied seat turns its player into a spectator.
   */
  setSeat(client, index, value) {
    this.#requireHost(client);
    this.#requireLobby();
    const seat = this.#seat(index);
    if (typeof value !== 'string') throw new Error('Bad seat value');
    if (value.startsWith('player:')) {
      const id = value.slice(7);
      if (!this.#members.has(id)) throw new Error('That player is not in the room');
      if (seat.playerId === id) return;
      const oldSeat = this.#seatOf(id);
      const displaced = seat.playerId;
      if (oldSeat >= 0) this.#vacate(oldSeat);
      seat.mode = 'open';
      seat.playerId = id;
      if (displaced && oldSeat >= 0) this.#sit(displaced, oldSeat); // swap
    } else if (value === 'open' || value === 'bot' || value === 'closed') {
      if (this.solo && value === 'open') throw new Error('A solo game has no open seats');
      seat.playerId = null; // whoever sat here is sent to the spectators
      seat.mode = value;
    } else {
      throw new Error('Bad seat value');
    }
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
    const humans = this.#seated();
    const bots = this.#seats.flatMap((s, i) => (s.mode === 'bot' ? [i] : []));
    if (humans.length < 1) throw new Error('At least one person has to sit in a seat');
    if (humans.length + bots.length < minPlayers) {
      throw new Error(`Need at least ${minPlayers} seats filled (players or bots)`);
    }
    if (humans.some((h) => h.id !== this.#hostId && !this.#members.get(h.id).ready)) {
      throw new Error('Not everyone is ready');
    }
    const problem = this.game.canStart?.({ players: humans.length, bots: bots.length, settings: this.#settings });
    if (problem) throw new Error(problem);

    this.#status = 'playing';
    const state = this.state();
    this.#instance = this.game.create({
      players: humans,
      bots,
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
    const seated = this.#seated().length;
    return {
      id: this.id,
      name: this.name,
      gameId: this.game.meta.id,
      players: seated,
      spectators: this.#members.size - seated,
      maxPlayers: this.game.meta.maxPlayers,
      openSeats: this.#seats.filter((s) => s.mode === 'open' && !s.playerId).length,
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
      // slot = seat index, or -1 for a spectator
      players: [...this.#members.values()].map((m) => ({
        id: m.client.id,
        name: m.client.name,
        ready: m.ready,
        slot: this.#seatOf(m.client.id),
      })),
      seats: this.#seats.map((s) => ({ mode: s.mode, playerId: s.playerId })),
      settings: this.#settings,
      status: this.#status,
      solo: this.solo,
    };
  }

  broadcastState() {
    this.#broadcast({ t: 'room', room: this.state() });
  }

  // ── internals ──
  /** Seated humans as the game receives them: [{ id, name, slot }]. */
  #seated() {
    return this.#seats.flatMap((s, slot) => {
      const m = s.playerId ? this.#members.get(s.playerId) : null;
      return m ? [{ id: m.client.id, name: m.client.name, slot }] : [];
    });
  }

  #seat(index) {
    const seat = Number.isInteger(index) ? this.#seats[index] : undefined;
    if (!seat) throw new Error('No such seat');
    return seat;
  }

  #seatOf(id) {
    return this.#seats.findIndex((s) => s.playerId === id);
  }

  /** Puts a member in seat `index` (which must be free), leaving any seat they had. */
  #sit(id, index) {
    const old = this.#seatOf(id);
    if (old >= 0) this.#vacate(old);
    this.#seats[index].playerId = id;
  }

  /** Empties a seat. Solo rooms turn it into a bot seat (an open seat means nothing there). */
  #vacate(index) {
    const seat = this.#seats[index];
    seat.playerId = null;
    if (this.solo) seat.mode = 'bot';
  }

  #requireLobby() {
    if (this.#status !== 'lobby') throw new Error('Seats cannot be changed during a game');
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

import { defaultSettings, sanitizeSettings } from '../shared/settings.js';

const DEFAULT_MAX_PLAYERS = 4; // used when a game's meta has no maxPlayers

/**
 * A room is game-agnostic: members, host, readiness, settings, SEATS and the tick loop.
 * What happens inside a match is delegated to the game's instance.
 *
 * Seats (one per `meta.maxPlayers`, shown to the host as one row each):
 *   mode 'open'   anyone can sit here. If `playerId` is set, that person is sitting in it ("Player").
 *   mode 'bot'    the game fills it with a bot.
 *   mode 'closed' nobody plays here.
 * Members without a seat are spectators. They can join at any time, even mid-game, and just watch.
 *
 * Drop-in games (`meta.dropIn: true`) differ in two ways: the room starts the match as soon as it is created (no seat/setup
 * page), and a member who joins mid-match takes a free seat and the game is told via `instance.onJoin(player)`.
 * Spectators can also take a free seat mid-match (`takeSeat`), and seated players can stand up (`spectate`); both go through
 * `onJoin` / `onLeave`. Leaving mid-match works for every game through `instance.onLeave(id)`.
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
    this.maxPlayers = game.meta.maxPlayers ?? DEFAULT_MAX_PLAYERS;
    this.dropIn = !!game.meta.dropIn && !solo;
    this.#settings = defaultSettings(game.meta);
    // Solo: the human takes the first seat, bots fill the rest. Multiplayer: everything starts open.
    this.#seats = Array.from({ length: this.maxPlayers }, (_, i) => ({ mode: solo && i > 0 ? 'bot' : 'open', playerId: null }));
  }

  get empty() {
    return this.#members.size === 0;
  }

  join(client) {
    if (this.solo && this.#members.size >= 1) throw new Error('This is a solo room');
    this.#members.set(client.id, { client, ready: false });
    if (!this.#hostId) this.#hostId = client.id;
    client.room = this;
    // Before the game starts (or at any time in a drop-in game), take the first open seat if there is one;
    // otherwise (or mid-game in a normal game) just watch.
    const joinMidGame = this.#status === 'playing' && this.dropIn;
    if (this.#status === 'lobby' || joinMidGame) {
      const free = this.#seats.findIndex((s) => s.mode === 'open' && !s.playerId);
      if (free >= 0) {
        this.#seats[free].playerId = client.id;
        if (joinMidGame && !this.#tellGameAboutJoin(client, free)) this.#seats[free].playerId = null; // refused: watch instead
      }
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
    this.#requireSeatChange();
    const seat = this.#seat(index);
    if (seat.playerId === client.id) return;
    if (seat.mode !== 'open') throw new Error('That seat is not open');
    if (seat.playerId) throw new Error('That seat is taken');
    const midMatch = this.#status === 'playing'; // only possible in a drop-in game
    if (midMatch && this.#seatOf(client.id) >= 0) throw new Error('Stand up first: seats cannot be swapped during a match');
    this.#sit(client.id, index);
    if (midMatch && !this.#tellGameAboutJoin(client, index)) {
      seat.playerId = null;
      throw new Error('The game cannot take another player right now');
    }
    this.broadcastState();
    if (midMatch) client.send({ t: 'gameStart', room: this.state() }); // remount the game view with the new seat
  }

  /** A member gives up their seat and watches instead. */
  spectate(client) {
    this.#requireSeatChange();
    if (this.solo) throw new Error('A solo game needs you in a seat');
    const seat = this.#seatOf(client.id);
    const midMatch = this.#status === 'playing' && seat >= 0; // only possible in a drop-in game
    if (midMatch) this.#instance?.onLeave(client.id); // the game hears about it exactly like a disconnect
    if (seat >= 0) this.#vacate(seat);
    this.broadcastState();
    if (midMatch) client.send({ t: 'gameStart', room: this.state() }); // remount the game view as a spectator
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
    const { minPlayers = 1, tickRate } = this.game.meta;
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
      maxPlayers: this.maxPlayers,
      dropIn: this.dropIn,
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
      dropIn: this.dropIn,
    };
  }

  broadcastState() {
    this.#broadcast({ t: 'room', room: this.state() });
  }

  // ── internals ──
  /** Drop-in games: announce a newcomer. The game may refuse by returning false (e.g. it is full by its own rules). */
  #tellGameAboutJoin(client, slot) {
    try {
      return this.#instance?.onJoin?.({ id: client.id, name: client.name, slot }) !== false;
    } catch (err) {
      console.error(`onJoin failed in game "${this.game.meta.id}":`, err);
      return false;
    }
  }

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

  /** Seats change in the lobby, and also during a match in drop-in games. */
  #requireSeatChange() {
    if (this.#status !== 'lobby' && !this.dropIn) throw new Error('Seats cannot be changed during a game');
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

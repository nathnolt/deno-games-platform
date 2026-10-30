import { Room } from './room.js';

const OPEN = 1; // WebSocket.OPEN

/**
 * Connections, lobby and room management. Works with any standard WebSocket object
 * (addEventListener / send / readyState), so it needs no library and is easy to test.
 */
export class Platform {
  #clients = new Map();
  #rooms = new Map();

  constructor(games) {
    this.games = games;
  }

  connect(ws) {
    const client = {
      id: crypto.randomUUID(),
      name: 'Player',
      room: null,
      sendRaw: (json) => ws.readyState === OPEN && ws.send(json),
      send: (msg) => client.sendRaw(JSON.stringify(msg)),
    };
    this.#clients.set(client.id, client);

    const hello = () => {
      client.send({ t: 'welcome', playerId: client.id });
      client.send({ t: 'rooms', rooms: this.#roomList() });
    };
    if (ws.readyState === OPEN) hello();
    else ws.addEventListener('open', hello, { once: true });

    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > 4096) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      try {
        this.#handle(client, msg);
      } catch (err) {
        client.send({ t: 'error', message: err instanceof Error ? err.message : 'Something went wrong' });
      }
    });
    ws.addEventListener('close', () => {
      this.#leave(client);
      this.#clients.delete(client.id);
    });
  }

  #handle(c, msg) {
    switch (msg?.t) {
      case 'hello':
        c.name = String(msg.name ?? '').trim().slice(0, 20) || 'Player';
        c.room?.broadcastState();
        break;
      case 'createRoom': {
        const game = this.games.get(msg.gameId);
        if (!game) throw new Error('Unknown game');
        const solo = !!msg.solo;
        if (solo && !game.meta.soloSettings) throw new Error(`${game.meta.name} has no solo mode`);
        this.#leave(c);
        const id = Math.random().toString(36).slice(2, 6);
        const name = String(msg.name ?? '').trim().slice(0, 30) || (solo ? `Solo ${game.meta.name}` : `${c.name}'s room`);
        const room = new Room(id, name, game, () => this.#broadcastRooms(), { solo });
        this.#rooms.set(id, room);
        room.join(c);
        // Solo does NOT auto-start: the client shows a settings page (pre-filled with soloSettings), then sends 'start'.
        if (solo) room.setSettings(c, { ...game.meta.soloSettings });
        // Drop-in games have no setup page: the match starts right away and people join/leave while it runs.
        if (room.dropIn) room.start(c);
        this.#broadcastRooms();
        break;
      }
      case 'joinRoom': {
        const room = this.#rooms.get(msg.roomId);
        if (!room || room.solo) throw new Error('Room no longer exists');
        if (c.room === room) break;
        this.#leave(c);
        room.join(c); // never refused: no free seat (or a game in progress) just means you watch
        this.#broadcastRooms();
        break;
      }
      case 'leaveRoom':
        this.#leave(c);
        break;
      case 'setSettings':
        c.room?.setSettings(c, msg.settings);
        break;
      case 'takeSeat':
        c.room?.takeSeat(c, msg.seat);
        break;
      case 'spectate':
        c.room?.spectate(c);
        break;
      case 'setSeat':
        c.room?.setSeat(c, msg.seat, msg.value);
        break;
      case 'setReady':
        c.room?.setReady(c, !!msg.ready);
        break;
      case 'start':
        c.room?.start(c);
        break;
      case 'input':
        c.room?.input(c, msg.data);
        break;
    }
  }

  #leave(c) {
    const room = c.room;
    if (!room) return;
    room.leave(c);
    if (room.empty) this.#rooms.delete(room.id);
    this.#broadcastRooms();
  }

  #roomList() {
    return [...this.#rooms.values()].filter((r) => !r.solo).map((r) => r.summary()); // solo rooms are private
  }

  #broadcastRooms() {
    const json = JSON.stringify({ t: 'rooms', rooms: this.#roomList() });
    for (const c of this.#clients.values()) if (!c.room) c.sendRaw(json);
  }
}

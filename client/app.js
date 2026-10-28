import { Connection } from './net.js';
import { el } from './dom.js';
import { clientGames } from './games.js';
import { settingsForm } from './settings-form.js';

/**
 * The platform shell: lobby -> room (game-agnostic) -> setup (generated from the game's schema)
 * -> game plugin. It knows nothing about any specific game, only the ClientGame contract.
 */
class App {
  me = '';
  name = localStorage.getItem('name') || `Player${100 + Math.floor(Math.random() * 900)}`;
  rooms = [];
  room = null;
  screen = 'lobby'; // 'lobby' | 'room' | 'game'
  view = null;
  roomListEl = null;
  backBtn = null;
  gameHost = null;
  status = el('div', { class: 'status' });

  constructor(root) {
    this.root = root;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.conn = new Connection(
      wsUrl,
      (m) => this.onMessage(m),
      (open) => (this.status.textContent = open ? '' : 'Connecting to server…'),
    );
    this.go('lobby');
  }

  send(msg) {
    this.conn.send(msg);
  }

  onMessage(m) {
    switch (m.t) {
      case 'welcome':
        this.me = m.playerId;
        this.send({ t: 'hello', name: this.name });
        if (this.screen !== 'lobby') {
          this.room = null;
          this.go('lobby'); // we reconnected: the server forgot us
        }
        break;
      case 'rooms':
        this.rooms = m.rooms;
        if (this.screen === 'lobby') this.updateRoomList();
        break;
      case 'room':
        this.room = m.room;
        if (!m.room) {
          if (this.screen !== 'lobby') this.go('lobby');
        } else if (this.screen !== 'game') {
          this.go('room');
        }
        break;
      case 'gameStart':
        this.room = m.room;
        this.go('game');
        break;
      case 'snapshot':
        this.view?.onSnapshot(m.data);
        break;
      case 'gameEnd':
        this.view?.onEnd?.(m.result);
        this.backBtn?.classList.remove('hidden');
        break;
      case 'error':
        this.toast(m.message);
        break;
    }
  }

  go(screen) {
    this.view?.dispose();
    this.view = null;
    this.screen = screen;
    this.roomListEl = this.backBtn = this.gameHost = null;
    const body = screen === 'lobby' ? this.buildLobby() : screen === 'room' ? this.buildRoom() : this.buildGame();
    this.root.replaceChildren(this.status, body);
    if (screen === 'game') this.mountGame();
  }

  // ── lobby ──
  buildLobby() {
    const nameInput = el('input', {
      value: this.name,
      maxLength: 20,
      onchange: (e) => {
        this.name = e.target.value.trim() || this.name;
        localStorage.setItem('name', this.name);
        this.send({ t: 'hello', name: this.name });
      },
    });
    const gameSel = el('select', {}, ...[...clientGames.values()].map((g) => el('option', { value: g.meta.id }, g.meta.name)));
    const roomName = el('input', { placeholder: 'Room name (optional)', maxLength: 30 });
    const solo = el(
      'button',
      { class: 'primary', onclick: () => this.send({ t: 'createRoom', gameId: gameSel.value, name: roomName.value, solo: true }) },
      'Play solo',
    );
    const syncSolo = () => (solo.disabled = !clientGames.get(gameSel.value)?.meta.soloSettings);
    gameSel.addEventListener('change', syncSolo);
    syncSolo();

    this.roomListEl = el('div', { class: 'rooms' });
    this.updateRoomList();
    return el(
      'main',
      { class: 'panel' },
      el('h1', {}, 'Games platform'),
      el('label', { class: 'setting' }, el('span', {}, 'Your name'), nameInput),
      el('h2', {}, 'Start playing'),
      el(
        'div',
        { class: 'row' },
        gameSel,
        solo,
        roomName,
        el('button', { onclick: () => this.send({ t: 'createRoom', gameId: gameSel.value, name: roomName.value }) }, 'Create room'),
      ),
      el('h2', {}, 'Open rooms'),
      this.roomListEl,
    );
  }

  updateRoomList() {
    if (!this.roomListEl) return;
    if (!this.rooms.length) {
      this.roomListEl.replaceChildren(el('p', { class: 'muted' }, 'No rooms yet. Create one and share this page with friends.'));
      return;
    }
    this.roomListEl.replaceChildren(
      ...this.rooms.map((r) => {
        const join = el('button', { onclick: () => this.send({ t: 'joinRoom', roomId: r.id }) }, 'Join');
        join.disabled = r.players >= r.maxPlayers || r.status === 'playing';
        const gameName = clientGames.get(r.gameId)?.meta.name ?? r.gameId;
        return el(
          'div',
          { class: 'room-row' },
          el('strong', {}, r.name),
          el('span', { class: 'muted' }, `${gameName}, ${r.players}/${r.maxPlayers} players${r.status === 'playing' ? ', in game' : ''}`),
          join,
        );
      }),
    );
  }

  // ── room + game-dependent setup area ──
  buildRoom() {
    const room = this.room;
    const game = clientGames.get(room.gameId);
    if (room.solo) return this.buildSoloSetup(room, game);
    const isHost = room.hostId === this.me;
    const mine = room.players.find((p) => p.id === this.me);

    const players = room.players.map((p) =>
      el(
        'li',
        {},
        el('span', {}, p.name + (p.id === this.me ? ' (you)' : '')),
        el('span', { class: p.ready || p.id === room.hostId ? 'ok' : 'muted' }, p.id === room.hostId ? 'host' : p.ready ? 'ready' : 'not ready'),
      ),
    );
    const action = isHost
      ? el('button', { class: 'primary', onclick: () => this.send({ t: 'start' }) }, 'Start game')
      : el('button', { class: 'primary', onclick: () => this.send({ t: 'setReady', ready: !mine?.ready }) }, mine?.ready ? 'Not ready' : 'Ready');

    return el(
      'main',
      { class: 'panel' },
      el('h1', {}, room.name),
      el('p', { class: 'muted' }, `${game.meta.name}: ${game.meta.description}`),
      el('h2', {}, `Players (${room.players.length}/${game.meta.maxPlayers})`),
      el('ul', { class: 'players' }, ...players),
      el('h2', {}, `${game.meta.name} setup`),
      settingsForm(game.meta, room.settings, isHost, (settings) => this.send({ t: 'setSettings', settings })),
      el('div', { class: 'row' }, action, el('button', { onclick: () => this.send({ t: 'leaveRoom' }) }, 'Leave room')),
      isHost ? el('p', { class: 'muted' }, 'Everyone else must be ready before you can start.') : '',
    );
  }

  /** Solo setup page: same schema-generated form as a multiplayer room, minus players/ready. Always editable. */
  buildSoloSetup(room, game) {
    return el(
      'main',
      { class: 'panel' },
      el('h1', {}, `${game.meta.name}: solo`),
      el('p', { class: 'muted' }, game.meta.description),
      el('h2', {}, 'Solo settings'),
      settingsForm(game.meta, room.settings, true, (settings) => this.send({ t: 'setSettings', settings })),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'primary', onclick: () => this.send({ t: 'start' }) }, 'Start game'),
        el('button', { onclick: () => this.send({ t: 'setSettings', settings: { ...game.meta.soloSettings } }) }, 'Reset to defaults'),
        el('button', { onclick: () => this.send({ t: 'leaveRoom' }) }, 'Back to lobby'),
      ),
    );
  }

  // ── game ──
  buildGame() {
    const room = this.room;
    const game = clientGames.get(room.gameId);
    this.gameHost = el('div', { class: 'game-host' });
    this.backBtn = el('button', { class: 'hidden', onclick: () => this.go('room') }, 'Back to setup');
    return el(
      'div',
      { class: 'game-screen' },
      el('div', { class: 'topbar' }, el('span', {}, `${game.meta.name}: ${room.name}`), this.backBtn, el('button', { onclick: () => this.send({ t: 'leaveRoom' }) }, 'Leave')),
      this.gameHost,
    );
  }

  mountGame() {
    const room = this.room;
    const slot = room.players.find((p) => p.id === this.me)?.slot ?? 0;
    this.view = clientGames.get(room.gameId).mount({
      container: this.gameHost,
      me: { id: this.me, slot },
      room,
      sendInput: (data) => this.send({ t: 'input', data }),
    });
  }

  toast(message) {
    const t = el('div', { class: 'toast' }, message);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }
}

new App(document.getElementById('app'));

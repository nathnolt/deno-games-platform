// Documentation of the plugin contracts (JSDoc only, no runtime code, no TypeScript needed).
// Editors like VS Code pick these up for autocomplete.
//
// ── Wire protocol (JSON over one WebSocket) ──
// client → server
//   {t:'hello', name} {t:'createRoom', gameId, name, solo?} {t:'joinRoom', roomId} {t:'leaveRoom'}
//   {t:'setSettings', settings} {t:'setReady', ready} {t:'start'} {t:'input', data}
//   {t:'takeSeat', seat} {t:'spectate'} {t:'setSeat', seat, value}   (value: 'open' | 'bot' | 'closed' | 'player:<id>', host only)
// server → client
//   {t:'welcome', playerId} {t:'rooms', rooms} {t:'room', room|null} {t:'gameStart', room}
//   {t:'snapshot', data} {t:'gameEnd', result} {t:'error', message}
// `input`, `snapshot` and `result` are opaque to the platform; only the game plugin understands them.

/**
 * Server side of a game (games/<id>/server.js exports one of these).
 * @typedef {object} ServerGame
 * @property {import('./settings.js').GameMeta} meta
 * @property {(ctx: GameContext) => GameInstance} create
 * @property {(info: {players: number, bots: number, settings: object}) => string | null} [canStart]  return an error message to block starting
 *     (the platform already checks: at least one human seated, humans + bots >= meta.minPlayers, all seated guests ready)
 *
 * @typedef {object} GameContext
 * @property {{id: string, name: string, slot: number}[]} players   humans sitting in a seat; slot = seat index
 * @property {number[]} bots       seat indexes the host set to "bot": the game drives these. Seats not listed in
 *                                 players or bots are empty (closed, or open but nobody sat there)
 * @property {object} settings     already sanitized
 * @property {(result: unknown) => void} end   call when the match is over
 *
 * @typedef {object} GameInstance
 * @property {(playerId: string, data: unknown) => void} onInput
 * @property {(playerId: string) => void} onLeave
 * @property {(dt: number) => void} update
 * @property {() => unknown} snapshot
 */

/**
 * Client side of a game (games/<id>/client.js exports one of these).
 * @typedef {object} ClientGame
 * @property {import('./settings.js').GameMeta} meta
 * @property {(ctx: ClientGameContext) => GameView} mount
 *
 * @typedef {object} ClientGameContext
 * @property {HTMLElement} container
 * @property {{id: string, slot: number}} me   slot is -1 when you are only watching: don't send input, don't draw "your" things
 * @property {object} room         room state at game start: players [{id, name, ready, slot}] (slot -1 = spectator),
 *                                 seats [{mode, playerId}], settings
 * @property {(data: unknown) => void} sendInput
 *
 * @typedef {object} GameView
 * @property {(data: unknown) => void} onSnapshot
 * @property {(result: unknown) => void} [onEnd]
 * @property {() => void} dispose
 */
export {};

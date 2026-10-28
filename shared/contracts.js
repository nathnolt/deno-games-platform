// Documentation of the plugin contracts (JSDoc only, no runtime code, no TypeScript needed).
// Editors like VS Code pick these up for autocomplete.
//
// ── Wire protocol (JSON over one WebSocket) ──
// client → server
//   {t:'hello', name} {t:'createRoom', gameId, name, solo?} {t:'joinRoom', roomId} {t:'leaveRoom'}
//   {t:'setSettings', settings} {t:'setReady', ready} {t:'start'} {t:'input', data}
// server → client
//   {t:'welcome', playerId} {t:'rooms', rooms} {t:'room', room|null} {t:'gameStart', room}
//   {t:'snapshot', data} {t:'gameEnd', result} {t:'error', message}
// `input`, `snapshot` and `result` are opaque to the platform; only the game plugin understands them.

/**
 * Server side of a game (games/<id>/server.js exports one of these).
 * @typedef {object} ServerGame
 * @property {import('./settings.js').GameMeta} meta
 * @property {(ctx: GameContext) => GameInstance} create
 * @property {(info: {players: number, settings: object}) => string | null} [canStart]  return an error message to block starting
 *
 * @typedef {object} GameContext
 * @property {{id: string, name: string, slot: number}[]} players
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
 * @property {{id: string, slot: number}} me
 * @property {object} room         room state, including settings and players
 * @property {(data: unknown) => void} sendInput
 *
 * @typedef {object} GameView
 * @property {(data: unknown) => void} onSnapshot
 * @property {(result: unknown) => void} [onEnd]
 * @property {() => void} dispose
 */
export {};

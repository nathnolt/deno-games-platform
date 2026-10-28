# Games platform (Deno, plain JavaScript)

Multiplayer games over WebSockets. One Deno process serves the pages **and** the WebSocket endpoint.
No npm, no TypeScript, no bundler, no `ws` package: Deno has WebSocket servers built in, and the browser
loads the ES modules directly. The only external file is Three.js, loaded from a CDN through an import map.

```
deno task start      # http://localhost:8000   (PORT env var to change)
deno task dev        # same, restarts on file changes
deno task test       # headless sim tests + platform tests with fake sockets
```
Open the page in several tabs / devices, or hit **Play solo** for 1 human vs bots (with a settings page first).

Every room has **seat rows** (one per corner/seat). The host sets each to *Open* / *Bot* / *Closed* or seats a specific person;
guests press *Sit here* on an open seat or watch as **spectators** (also mid-game). See "Seats" below.

**Building a new game? Read [`GAMES_PLATFORM_GUIDE.md`](GAMES_PLATFORM_GUIDE.md)**: one self-contained file covering the Deno
environment, loading libraries/assets, settings, the front-end contract, and a complete example game.

## Layout

```
server/main.js       Deno.serve: static files + /ws upgrade
server/platform.js   connections, lobby, rooms (works with any standard WebSocket object)
server/room.js       game-agnostic room: host, seats, spectators, ready, settings, tick loop
server/games.js      server-side game registry
shared/              ECS, settings schema + validation, snapshot interpolation, JSDoc contracts
client/              app shell: lobby, room, schema-generated setup form; client/games.js registry
games/warlords/      shared.js (meta, geometry, components) · server.js (simulation, bots) · client.js (Three.js)
                     audio.js (synth sounds, replaceable by files in sounds/ via SOUND_FILES)
tests/               node/deno-compatible test scripts
```

## Flow

lobby -> **room** (game-independent: host, seats, ready) -> **setup** (game-dependent, generated from `meta.settings`)
-> **game** (server ticks the plugin at `meta.tickRate`, clients render interpolated snapshots) -> back to setup.

## Seats

Each game's `meta.maxPlayers` is its number of seats; the room page lists them as rows with an optional name/color
(`meta.seatNames`, `meta.seatColors`). The host's dropdown per row: **Open** (anyone can sit), **Bot**, **Closed**, or a
person in the room (seats them there, swapping if needed). Guests see the rows read-only, with **Sit here** / **Stand up**.
Anyone who joins with no free seat, or while a match runs, is a **spectator** (`ctx.me.slot === -1`). A game receives
`ctx.players` (seated humans) and `ctx.bots` (bot seat indexes); there is no `bots` setting any more.
To start: one human seated, humans + bots >= `meta.minPlayers`, every seated guest ready.

## Warlords

- **Mouse**: your paddle follows the mouse (projected onto your L-shaped track). With "Mouse moves paddle instantly"
  (default) there is no speed limit, and your own paddle is drawn at the cursor immediately (client-side prediction).
  Turn it off to cap the mouse with "Paddle speed limit". Arrow keys / WASD also work.
- **Solo / bots**: *Play solo* creates a private room (hidden from the lobby, nobody can join) and opens a **solo settings page**
  with the same schema-generated form, pre-filled from `meta.soloSettings` (3 bots for Warlords). Tweak anything, press
  *Start game*; after the match, *Back to setup* returns to that page. Bots are seats the host sets to *Bot*;
  "Bot skill" sets their speed, reaction time and aim error; hard bots flick and catch-and-throw. When you are knocked out
  the round plays on, and once only bots are left it fast-forwards (`BOT_FAST_FORWARD` in `server.js`).
- **Sounds**: synthesized by default. Put sound files in `games/warlords/sounds/` and map them in `SOUND_FILES` (`audio.js`);
  `brick.wav` and `paddle.wav` (cut from `sfx.wav`) are wired up already. Comment a line out to use the synth again.
- Server runs at 60 Hz; snapshots are sent every tick as JSON.

## Adding a game

1. Create `games/mygame/{shared,server,client}.js`.
2. `shared.js` exports `meta` (id, players, tick rate, settings schema, optional `soloSettings` which enables Play solo + its settings page).
3. `server.js` exports a `ServerGame`: `create(ctx)` returns `{ onInput, onLeave, update(dt), snapshot() }`;
   call `ctx.end(result)` when the match is over; optional `canStart({players, settings})`.
4. `client.js` exports a `ClientGame`: `mount(ctx)` returns `{ onSnapshot, onEnd?, dispose }` and draws into `ctx.container`.
5. Register it in `server/games.js` and `client/games.js`.

Contracts are documented (JSDoc) in `shared/contracts.js`.

## Going online

Run it on any host with Deno (`deno task start`) behind HTTPS; the client automatically uses `wss://` on https pages.
Deno Deploy also works: the code only uses `Deno.serve`, `Deno.upgradeWebSocket` and `Deno.readFile`.
To run Three.js offline, download the file from the import map in `client/index.html` into `client/vendor/` and point the map at it.

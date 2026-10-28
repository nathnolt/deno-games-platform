# Games Platform: Game Development Guide

**Purpose of this document:** everything you need to build a new game for this platform, in one file. It explains the
runtime (Deno), how the server and browser share code, how to load libraries and assets, how settings work (including
the solo settings page), how the front-end plugs in, and it ends with a complete, tested example game you can copy.

> **If you are an AI assistant or a developer who received this file:** you do not need the rest of the repository
> to understand the rules. A new game is **three files + two registry lines** (+ optional CSS). Read sections 1 to 3 for
> the rules, section 10 for a template, and section 12 for the checklist.

---

## Table of contents

1. [Architecture in 60 seconds](#1-architecture-in-60-seconds)
2. [The Deno environment](#2-the-deno-environment)
3. [Loading libraries, extensions and assets](#3-loading-libraries-extensions-and-assets)
4. [Lifecycle and wire protocol](#4-lifecycle-and-wire-protocol)
5. [The game plugin contract](#5-the-game-plugin-contract)
6. [Settings (multiplayer setup and solo settings page)](#6-settings)
7. [Building the front-end](#7-building-the-front-end)
8. [Writing the server simulation](#8-writing-the-server-simulation)
9. [Registering your game](#9-registering-your-game)
10. [Complete worked example: Tap Race](#10-complete-worked-example-tap-race)
11. [Testing](#11-testing)
12. [Checklist and common pitfalls](#12-checklist-and-common-pitfalls)
13. [Reference: what Warlords demonstrates](#13-reference-what-warlords-demonstrates)

---

## 1. Architecture in 60 seconds

One Deno process does two jobs on one port: it serves static files (the browser app) and it accepts WebSocket
connections at `/ws`. The server is **authoritative**: it runs the game simulation and streams state to clients; clients
only render that state and send inputs.

```
 Browser                                   Deno server (one process)
┌────────────────────────┐   WebSocket    ┌─────────────────────────────────────┐
│ client/app.js (shell)  │ ◄────────────► │ server/main.js     static files +   │
│  lobby / room / setup  │   JSON text    │                    /ws upgrade      │
│  settings form         │                │ server/platform.js connections,     │
│                        │                │                    lobby, rooms     │
│ games/<id>/client.js   │                │ server/room.js     host, seats,     │
│  draws snapshots,      │                │                    ready, settings, │
│  sends input           │                │                    ticks            │
│                        │                │ games/<id>/server.js  THE RULES     │
└────────────────────────┘                └─────────────────────────────────────┘
          both import:  shared/*  and  games/<id>/shared.js   (plain ES modules)
```

The platform is **game-agnostic**. It handles players, rooms, host, seats (open / bot / closed, spectators), ready state, settings validation, the tick loop and
message routing. A game only supplies: metadata + settings schema, a server simulation, and a client view. The
platform never looks inside `input`, `snapshot` or `result`; those payloads belong to the game.

### File layout

```
deno.json                 tasks (start, dev, test) and permissions
server/main.js            Deno.serve: static files + /ws
server/platform.js        connections, lobby, room management
server/room.js            game-agnostic room: host, seats, spectators, ready, settings, tick loop
server/games.js           SERVER registry of games            <- you edit this
shared/ecs.js             tiny Entity-Component-System (optional to use)
shared/interp.js          SnapshotBuffer + lerp for smooth rendering (optional)
shared/settings.js        settings schema types, defaultSettings(), sanitizeSettings()
shared/contracts.js       JSDoc of the plugin contracts + wire protocol
client/index.html         page + import map
client/app.js             app shell: lobby, room, solo setup page, game screen
client/games.js           CLIENT registry of games            <- you edit this
client/settings-form.js   settings form generated from the schema
client/dom.js             el() helper
client/style.css          global styles                        <- you may append to this
games/<id>/shared.js      meta + geometry/constants/components used by both sides
games/<id>/server.js      ServerGame: simulation, bots, rules
games/<id>/client.js      ClientGame: rendering + input
tests/                    plain scripts, run with `deno run`
```

---

## 2. The Deno environment

### What Deno gives you (and why there is no npm, no bundler, no TypeScript)

| Need | How it is done here |
|---|---|
| HTTP server | `Deno.serve({ port }, handler)`, handler takes a standard `Request` and returns a `Response` |
| WebSocket server | `Deno.upgradeWebSocket(req)` returns `{ socket, response }`. `socket` is a **standard browser-style WebSocket** (`addEventListener`, `send`, `readyState`) |
| Read files | `Deno.readFile(url)` |
| Env vars | `Deno.env.get('PORT')` |
| IDs / timing | `crypto.randomUUID()`, `performance.now()`, `setInterval` are globals |
| Modules | Native ES modules, `import ... from './file.js'`. **Always include the `.js` extension** |
| Language | Plain JavaScript (modern: private `#fields`, `??`, top-level `await`, etc.). JSDoc comments give editor hints; there is no compile step |

`server/main.js` is the only file that touches `Deno.*` APIs. `platform.js` and `room.js` only use the standard WebSocket
interface, which is why the tests can drive them with fake sockets and no network.

### Running

```bash
deno task start      # http://localhost:8000   (PORT=3000 deno task start to change)
deno task dev        # same, restarts on file changes
deno task test       # sim tests + platform tests (no network needed)
```

`deno.json` defines the tasks:

```json
{
  "tasks": {
    "start": "deno run --allow-net --allow-read=. --allow-env=PORT server/main.js",
    "dev": "deno run --watch --allow-net --allow-read=. --allow-env=PORT server/main.js",
    "test": "deno run tests/sim.test.js && deno run tests/platform.test.js"
  }
}
```

### Permissions (Deno is sandboxed by default)

| Flag | Why it is needed |
|---|---|
| `--allow-net` | listen on a port, accept WebSockets |
| `--allow-read=.` | serve files from the project folder only (paths are relative to where the task runs, i.e. the project root) |
| `--allow-env=PORT` | read only the `PORT` variable |

If your game needs more (a library that reads other env vars, writes a file, calls an external API), the run fails with
an error naming the missing permission. Add the **narrowest** flag to the tasks in `deno.json` (for example an extra
`--allow-env=MY_VAR`, or `--allow-write=./data` for one folder). Do not use `-A` / `--allow-all`.

### Module rules (the part people get wrong)

There are **three kinds of code**, and what each may import is different:

| Kind | Where | Runs in | May import | Must NOT use |
|---|---|---|---|---|
| **Server** | `server/*`, `games/<id>/server.js` | Deno | `shared/*`, `games/<id>/shared.js`, `npm:`/`jsr:`/URL specifiers, names from `deno.json` `imports` | DOM, `window`, anything from `client/` |
| **Client** | `client/*`, `games/<id>/client.js` | Browser | `shared/*`, `games/<id>/shared.js`, `client/dom.js`, names from the **import map** in `client/index.html` (e.g. `three`), full `https://` URLs | `Deno.*`, `npm:` specifiers, anything from `server/` |
| **Shared** | `shared/*`, `games/<id>/shared.js` | Both | other shared files with **relative paths and `.js`** | DOM, `Deno.*`, bare specifiers (neither side can resolve the same name unless both maps define it) |

Consequences:

- Put anything both sides must agree on (constants, geometry, component definitions, the `meta` object) in `shared.js`.
- `import * as THREE from 'three'` works in `client.js` **only** because of the import map in the browser. It would fail
  on the server. Never import `client.js` from server code (the server registry imports only `server.js`).
- Relative imports are resolved by the browser as URLs, so `'../../shared/ecs.js'` works because `/shared/` is served
  (see below).

### How static files are served (`server/main.js`)

```js
const PUBLIC_DIRS = ['/client/', '/shared/', '/games/'];
// allowed if: path starts with a public dir, has no '..', and does NOT end with '/server.js'
// '/' is rewritten to '/client/index.html'
```

Rules to remember:

1. **Only `/client/`, `/shared/` and `/games/` are public.** `/server/`, `/tests/`, `deno.json` are never served.
2. **Any file named `server.js` is blocked** from being served (so `games/<id>/server.js` stays private). A *different*
   server-only filename inside `games/<id>/` (say `bots.js`) **would be publicly downloadable**. Keep server-only code in
   `server.js` or accept that it is readable. **Never put secrets in anything under `games/`, `shared/` or `client/`.**
3. Content type comes from the `TYPES` table (`.html .js .css .json .svg .png .jpg .webp .wav .mp3 .ogg .m4a .flac`). Any
   other extension is sent as `application/octet-stream`; see section 3 to add fonts, models.
4. Responses are sent with `cache-control: no-cache`, so a browser refresh always picks up your edits.

### Going online

Run `deno task start` on any host with Deno, behind HTTPS (the client picks `wss://` automatically on https pages).
Deno Deploy also works because the code only uses `Deno.serve`, `Deno.upgradeWebSocket` and `Deno.readFile`.
All game state lives **in memory**: restarting the server ends all rooms. There is no database or accounts layer.

---

## 3. Loading libraries, extensions and assets

### 3.1 Server-side libraries (Deno)

No `node_modules`. Import by specifier; Deno downloads and caches on first run.

```js
// directly in a server file
import { shuffle } from 'jsr:@std/random@1';
import _ from 'npm:lodash-es@4';
import seedrandom from 'npm:seedrandom@3';
```

To get short names, add an `imports` map to `deno.json` (Deno reads it automatically for `deno run`/`deno task`):

```json
{
  "imports": {
    "@std/random": "jsr:@std/random@1",
    "seedrandom": "npm:seedrandom@3"
  },
  "tasks": { "...": "..." }
}
```

```js
import seedrandom from 'seedrandom';   // server code only!
```

Rules:

- Use bare/`npm:` names **only in `games/<id>/server.js`** (or `server/*`). A shared file that uses a bare name breaks the
  browser, because the browser does not read `deno.json`.
- Pin versions (`@4`, `@1.2.3`).
- If the library needs a permission (env, file, net), add the narrowest flag to the tasks (see Permissions).
- Prefer not to add a library for something five lines of JS can do. The platform is intentionally dependency-free.

### 3.2 Client-side libraries (browser)

There is no bundler, so the browser loads modules directly. Two supported ways:

**A. Import map (preferred; pinned and shared by every game).** `client/index.html` already has one:

```html
<script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js" } }
</script>
```

Add entries to that same object, then use bare names in `games/<id>/client.js`:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/",
    "howler": "https://cdn.jsdelivr.net/npm/howler@2.2.4/dist/howler.min.js"
  }
}
</script>
```

```js
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

Keep addon versions identical to the core package. The import map must appear in `index.html` **before** the module
script, and there is only one map for the whole app, so adding a library means editing `client/index.html`
(mention that edit in your hand-off).

**B. Full URL import inside the client file** (no edit to `index.html`):

```js
import confetti from 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.module.mjs';
```

Works, but pinning/updating is scattered across files; use it for a one-off.

**Offline / self-hosted:** download the file into `client/vendor/` (public, `.js` already has the right MIME type) and
point the import map at `/client/vendor/the-file.js`. No code changes needed.

You can also skip libraries entirely: Warlords uses Three.js, but Tap Race (section 10) is plain DOM, and a Canvas 2D
game needs nothing at all.

### 3.3 Assets (images, audio, fonts, 3D models)

1. Put files under your game's folder, e.g. `games/mygame/assets/hit.mp3`. It is public automatically.
2. Make sure the extension is in `TYPES` in `server/main.js`, otherwise it is served as `application/octet-stream`
   (images still show, but audio/fonts/wasm can misbehave):

```js
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  // images and audio are already in the real table; add what else you need:
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};
```

3. Reference them relative to the module so the path never breaks if the folder moves:

```js
const hit = new Audio(new URL('./assets/hit.mp3', import.meta.url));
```

Also: browsers only start audio after a user gesture. Create/play sounds in response to clicks or key presses.

Warlords shows a nice pattern for sound: effects are synthesized by default, and `SOUND_FILES` in `games/warlords/audio.js`
maps a sound name to a file in `games/warlords/sounds/` (optionally a `start`/`end` slice of a longer file). A missing or
undecodable file falls back to the synthesized sound.

### 3.4 Adding a *game* ("plugin") to the platform

Games are plugins registered in two small files; see section 9. Nothing else in the platform needs to change.

---

## 4. Lifecycle and wire protocol

```
lobby ──► room (host, seats, ready) ──► setup (settings form) ──► game (tick loop) ──► back to setup
   └─ "Play solo" ──► private solo room ──► solo settings page ──► game ──► back to the solo settings page
```

### Messages (JSON text over one WebSocket)

Client to server:

| `t` | Fields | Notes |
|---|---|---|
| `hello` | `name` | sent on connect and on rename (max 20 chars) |
| `createRoom` | `gameId`, `name?`, `solo?` | `solo: true` creates a **private** solo room (needs `meta.soloSettings`) |
| `joinRoom` | `roomId` | fails only for solo rooms. With no free seat, or while a game runs, you join as a **spectator** |
| `takeSeat` | `seat` | sit in an open, empty seat (moving from your current one). Lobby only |
| `spectate` | | give up your seat and watch. Lobby only |
| `setSeat` | `seat`, `value` | **host only**, lobby only. `value`: `'open'` \| `'bot'` \| `'closed'` \| `'player:<id>'` (seat that person) |
| `leaveRoom` | | |
| `setSettings` | `settings` | host only, only while not playing. Sanitized server-side |
| `setReady` | `ready` | guests only matter; the host is implicitly ready |
| `start` | | host only |
| `input` | `data` | opaque to the platform, forwarded to `onInput` |

Server to client: `welcome {playerId}`, `rooms {rooms}`, `room {room|null}`, `gameStart {room}`,
`snapshot {data}`, `gameEnd {result}`, `error {message}`.

Limits: inbound messages must be **strings of at most 4096 characters**, otherwise they are silently dropped.
Inputs must therefore be small, and should be sent on change rather than every frame when possible.

### Room state (what `room` messages contain)

```js
{ id, name, gameId, hostId,
  players: [{ id, name, ready, slot }],     // slot = seat index, or -1 for a spectator
  seats:   [{ mode, playerId }],            // one per meta.maxPlayers; mode 'open' | 'bot' | 'closed'
  settings, status: 'lobby' | 'playing', solo }
```

- **Seats** are numbers `0..maxPlayers-1`. The room page shows one row per seat; the **host** has a dropdown per row:
  *Open* (anyone may sit), *Bot*, *Closed*, or one of the people in the room (seats them there). Others see who sits where
  and can press *Sit here* on an open seat or *Stand up*. A seat with `playerId` set is a seated **player**.
- Whoever joins before the game starts takes the first open seat; with none free they are a **spectator**
  (`slot: -1`). Spectators may join at any time, including mid-game: they get the game screen with `ctx.me.slot === -1`.
- Seats are locked while a match runs. To start: at least one human seated, humans + bots >= `meta.minPlayers`, and every
  seated guest ready (spectators don't need to be). Empty open seats simply stay empty.
- The **host** is the creator; if the host leaves, the next member becomes host. The host may also spectate.
- Changing settings clears every guest's *ready* flag.
- When the match ends (`ctx.end(result)`), the room returns to `'lobby'`, all ready flags reset, clients get
  `gameEnd`, and the UI offers **Back to setup**.
- If a player disconnects mid-game, the server calls `onLeave(playerId)`. If everyone leaves, the room is destroyed.
- If a client reconnects, it is a **new** connection with a new id: the server forgot it and the UI returns to the lobby.

### Solo rooms

`createRoom` with `solo: true` creates a room that:

- contains exactly one human (seat 1) with **bots in every other seat**, is **not** listed in the lobby, and **cannot be joined**,
- is created with `meta.soloSettings` applied on top of the schema defaults,
- shows the same seat rows (each other seat can be *Bot* or *Closed*; you can also pick which seat you sit in),
- is **not started automatically**: the client shows the **solo settings page** (a form generated from `meta.settings`,
  with *Start game*, *Reset to defaults* and *Back to lobby* buttons). Pressing *Start game* sends `start`,
- returns to that same settings page after each match, so the player can tweak and replay.

---

## 5. The game plugin contract

A game is a folder `games/<id>/` with three files. (Full JSDoc lives in `shared/contracts.js`.)

### 5.1 `shared.js` exports `meta`

```js
export const meta = {
  id: 'mygame',            // unique, lowercase, no spaces
  name: 'My Game',         // display name
  description: 'One sentence shown on the setup screen.',
  minPlayers: 2,           // platform refuses to start below this many FILLED seats (humans + bots; at least one human)
  maxPlayers: 4,           // the number of seats: the room page shows one row per seat
  seatNames: ['Red', 'Blue', 'Green', 'Yellow'],   // OPTIONAL label per seat
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'], // OPTIONAL dot color per seat
  tickRate: 20,            // server updates per second (e.g. 20 for turn-ish/casual, 60 for fast action)
  soloSettings: {},        // OPTIONAL. If present, the lobby enables "Play solo" (you + bots). See section 6
  settings: [ /* SettingField[] — see section 6 */ ],
};
```

Who plays where, and which seats are bots, is decided by the **seat rows in the room**, not by a game setting: do not add
a `bots` setting. The platform checks `minPlayers` for you; use `canStart` only for game-specific rules.

### 5.2 `server.js` exports a `ServerGame`

```js
export const mygame = {
  meta,
  create(ctx) { return new MyGameInstance(ctx); },     // called once per match
  canStart({ players, bots, settings }) { return null; }, // optional: return a message string to block starting
};
```

`ctx` (GameContext):

| Field | Meaning |
|---|---|
| `ctx.players` | `[{ id, name, slot }]` humans sitting in a seat when the match starts (`slot` = seat index) |
| `ctx.bots` | `[slot, ...]` seats the host set to *Bot*: your game drives these. Seats in neither list are empty |
| `ctx.settings` | the room's settings, already sanitized (always complete and in range) |
| `ctx.end(result)` | call exactly when the match is over. `result` is any JSON-serializable value; clients receive it in `onEnd(result)` |

The instance (GameInstance) must implement:

| Method | Called | Purpose |
|---|---|---|
| `onInput(playerId, data)` | whenever that client sends `input` | `data` is **untrusted**: validate type and range, ignore bad input silently |
| `onLeave(playerId)` | a human disconnects or leaves mid-game | remove them; call `ctx.end` if the match cannot continue |
| `update(dt)` | every tick; `dt` in seconds, capped at 0.1 | advance the simulation |
| `snapshot()` | every tick, right after `update` | return the JSON-serializable state clients need to draw |

### 5.3 `client.js` exports a `ClientGame`

```js
export const mygame = {
  meta,                                   // same object as the server's
  mount(ctx) { return new MyGameView(ctx); },
};
```

`ctx` (ClientGameContext):

| Field | Meaning |
|---|---|
| `ctx.container` | an empty `div.game-host`, centered and filling the space under the top bar. Append your DOM/canvas to it |
| `ctx.me` | `{ id, slot }` — your player id and seat. **`slot` is `-1` for a spectator**: send no input and don't draw "your" things |
| `ctx.room` | room state at game start: `ctx.room.players` (names, slots) and `ctx.room.settings` |
| `ctx.sendInput(data)` | sends `{t:'input', data}` to your `onInput` |

`mount` returns a view with:

| Method | Purpose |
|---|---|
| `onSnapshot(data)` | the object returned by `snapshot()` on the server arrives here every tick |
| `onEnd(result)` *(optional)* | the match finished: show the result. The shell then shows **Back to setup** |
| `dispose()` | the shell is leaving the game screen: remove every listener, timer, animation frame, DOM node, GL context |

---

## 6. Settings

### 6.1 Defining settings

Settings are **data, not UI code**. You list fields in `meta.settings` and the platform generates the form, validates
values server-side, and delivers them to both sides. Three field types exist:

```js
{ type: 'number',  key: 'target',    label: 'Taps to win', min: 10, max: 200, step: 5, default: 50 }
{ type: 'boolean', key: 'penalty',   label: 'Penalty for early taps',                  default: true }
{ type: 'select',  key: 'botSkill',  label: 'Bot skill', default: 'normal',
  options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }] }
```

Rules:

- `key` must be unique within the game; it is the property name on `ctx.settings`.
- `default` is **required**; it is used when a value is missing or invalid.
- Numbers are clamped to `[min, max]` and rounded to `step` (if given). Selects must match an option `value`. Booleans
  must be real booleans. **Unknown keys are dropped.** All of this happens in `sanitizeSettings()` on the server, so
  your game can always trust `ctx.settings`.

### 6.2 How settings flow

```
form change ─► {t:'setSettings', settings} ─► Room.setSettings ─► sanitizeSettings(meta, raw)
                                                            └► broadcast room state to everyone (guests un-readied)
start        ─► seat checks ─► canStart({players, bots, settings}) ─► create(ctx)  // ctx.settings = the sanitized object
```

- **Server:** read `ctx.settings.<key>` in `create(ctx)` (copy what you need) and in your systems.
- **Client:** read `ctx.room.settings.<key>` in `mount(ctx)`. Settings cannot change during a match, so reading once is fine.
- Only the **host** can edit; guests see the form disabled. Settings are locked while a match runs.
- Every field is always shown. If a field only matters conditionally (say, speed limit only when "instant" is off),
  say so in its label. The generated form has no show/hide logic.

### 6.3 Solo settings page

Add `soloSettings` to `meta` to make the lobby's **Play solo** button available for your game:

```js
soloSettings: { botSkill: 'normal' },   // any subset of keys; missing keys use their schema defaults ({} = just the defaults)
```

What happens:

1. *Play solo* creates a private solo room and applies `soloSettings` over the defaults.
2. The client shows the **solo settings page**: the seat rows (you in seat 1, bots elsewhere), the same schema-generated
   form, **always editable**, plus **Start game**, **Reset settings** (re-applies `soloSettings`) and **Back to lobby**.
3. **Start game** runs the usual checks. If they fail, the message appears as a toast (e.g. "Need at least 2 seats filled
   (players or bots)"), and the player stays on the page.
4. After the match, **Back to setup** returns to the same page with the same values.

Design guidance for solo-capable games:

- Make `soloSettings` a sensible *quick start*; the bots in the other seats come from the platform.
- Use `canStart` to explain impossible combinations instead of silently fixing them.
- Because the solo page shows **every** field, keep labels clear: players see them without a "multiplayer" context.
- Not defining `soloSettings` disables the *Play solo* button for that game; the server rejects `solo: true` for it.

### 6.4 Adding a new kind of field (rare)

If you need something other than number/boolean/select (a text field, a color picker), three places change, together:

1. `shared/settings.js`: extend the `SettingField` JSDoc typedef and add a branch in `sanitizeSettings` (**validation is
   mandatory** — never let raw client values through).
2. `client/settings-form.js`: add the matching input in `rows` and its value extraction in `collect`.
3. Use the new `type` in your `meta.settings`.

Every game benefits automatically, including the solo page.

### 6.5 Settings that are *not* schema fields

Per-player preferences (volume, theme, name) are not room settings. Store them on the client, e.g. `localStorage`
(the shell already stores the player name this way), and keep them out of `meta.settings`.

---

## 7. Building the front-end

### 7.1 What the shell gives you, and what it expects

The shell (`client/app.js`) owns the lobby, room list, setup forms and the game screen frame (top bar with *Leave* and,
after the match, *Back to setup*). It creates `ctx.container` and calls `mount(ctx)` **once per match**. You draw inside
the container and nothing else. When the shell leaves the game screen it calls `dispose()`.

`.game-host` is a flex container that centers its children. For absolutely-positioned overlays (HUD, banners) set
`container.style.position = 'relative'` as Warlords does.

### 7.2 The data flow of a view

```
server snapshot ─► onSnapshot(data) ─► (store / interpolate) ─► your render code
user input ─► DOM event ─► ctx.sendInput(small object) ─► server onInput
```

The client has **no authority**: it does not decide scores, collisions or winners. It mirrors what the server sends.

Two patterns:

- **Event/UI-style games** (like Tap Race, card or board games): render directly inside `onSnapshot`.
- **Real-time motion games** (like Warlords): push snapshots into `SnapshotBuffer` and render on
  `requestAnimationFrame`:

```js
import { SnapshotBuffer, lerp } from '../../shared/interp.js';

this.buffer = new SnapshotBuffer(60);            // render 60 ms in the past so there are always two snapshots to blend
onSnapshot(data) { this.buffer.push(data); }
#frame = () => {
  this.raf = requestAnimationFrame(this.#frame);
  const s = this.buffer.sample();                // { a, b, alpha } or null
  if (s) draw(lerp(s.a.x, s.b.x, s.alpha));
};
```

`SnapshotBuffer` keeps the last 30 snapshots and samples between the two surrounding the delayed time.

### 7.3 Input guidelines

- Send **small** JSON objects (limit 4096 chars). Prefer *intent* (`{tap:true}`, `{dir:-1}`, `{t:123.4}`) over raw event dumps.
- Send on change, or at most once per animation frame for continuous input (Warlords sends the mouse once per frame
  and only if it changed).
- For responsiveness, optionally **predict locally**: draw your own element at the input position immediately and let
  server snapshots correct everything else (Warlords' "instant mouse").
- Remember the seat: `ctx.me.slot`. Mirror per-seat geometry/direction on the client if your layout differs per seat.

### 7.4 Rendering options

- **DOM** (simplest): create elements with `el()` from `client/dom.js` (`el('button', { class: 'x', onclick: fn }, 'Label')`).
  Props starting with `on` become event listeners (lowercase event name), `class` sets `className`, other props set
  properties or attributes. Pass **strings** or nodes as children.
- **Canvas 2D**: append a `<canvas>` to `ctx.container`; size it from a `ResizeObserver` on the container.
- **Three.js / WebGL**: add `three` via the import map (already present). Warlords uses an orthographic camera on flat
  planes. Call `renderer.dispose()` in `dispose()`.

For responsive layout, observe the container, not the window:

```js
this.observer = new ResizeObserver(() => this.#resize());
this.observer.observe(ctx.container);
```

### 7.5 Styling

- Global styles live in `client/style.css`; colors are CSS variables (`--bg --panel --line --text --muted --accent`).
  Reuse them so your game matches the shell. Buttons with `class="primary"` get the accent color.
- **Prefix every class** with a short game prefix (`wl-` Warlords, `tr-` Tap Race) and append your CSS to
  `client/style.css`, so games cannot collide.
- Use `pointer-events: none` on HUD overlays so they do not block the mouse. Use `touch-action: none` (canvas) or
  `manipulation` (buttons) for touch games.

### 7.6 `dispose()` is mandatory hygiene

Every time a match ends and the player replays, a new view is mounted. Anything you leave behind leaks and fires on
the next match. In `dispose()`:

- `cancelAnimationFrame`, `clearInterval`/`clearTimeout`
- `window.removeEventListener(...)` for every global listener (use arrow-function class fields so the reference is stable)
- `ResizeObserver.disconnect()`
- Three.js: `renderer.dispose()` (and dispose geometries/materials you created)
- remove the DOM nodes you appended to the container

### 7.7 Ending a match on the client

`onEnd(result)` receives whatever you passed to `ctx.end(result)`. Show it (banner, scoreboard). Do **not** navigate
away: the shell shows **Back to setup**, which takes the players to the room setup (or the solo settings page).

---

## 8. Writing the server simulation

### 8.1 The tick loop (owned by `Room`)

```
every 1000/tickRate ms:
  dt = min(elapsed seconds, 0.1)
  instance.update(dt)
  broadcast { t:'snapshot', data: instance.snapshot() }   // JSON, once per tick, to everyone in the room
```

- Use `dt` for **all** motion and timers, never a fixed step assumption.
- Snapshots are serialized every tick: keep them small (round numbers, bitmasks, arrays of numbers). Do not include
  data clients already know (names, settings, static geometry); put those in `meta`/shared constants.
- After `ctx.end(...)` the loop stops and no further snapshot is sent for that match.
- **Never throw from `update()` or `snapshot()`.** They run inside `setInterval`; an uncaught error there is not
  caught by the platform and would crash the whole server process (all rooms). Errors thrown from `onInput` are caught and
  shown to that player as a toast, but still avoid them.

### 8.2 Trust nothing from the client

- Validate every field of `data` in `onInput` (type, finiteness, range). Clamp or ignore.
- Rate-limit actions that can be spammed (Tap Race ignores taps closer than 50 ms).
- Clients never send state ("my score is 10"), only intent ("I tapped").

### 8.3 Bots

Bots are just seats the server drives. The host picks them in the room's seat rows and the platform hands them over as
`ctx.bots` (seat indexes). Mark them active, update them inside `update(dt)`, and put `bots: [...]` in the snapshot so the
client can label them ("Bot 2"). A skill table keyed by a `select` setting keeps difficulty tunable:

```js
const SKILL = { easy: {...}, normal: {...}, hard: {...} };
const skill = SKILL[this.s.botSkill] ?? SKILL.normal;
```

### 8.4 Leaving, ending and early-outs

- `onLeave(playerId)`: mark the seat inactive; if no humans remain, call `ctx.end(...)`, otherwise do not leave bots
  playing forever. (Spectators leaving never reach `onLeave`, and their `onInput` ids are not in `ctx.players`: ignore them.)
- Always have a path to `ctx.end`. A match that can stall (bots only, nobody scoring) will tick forever.
- `ctx.end(result)` returns the room to setup, so a "match" = one pass through the setup screen. Multi-round structures
  (Warlords' *rounds to win*) live **inside** your simulation as phases (`countdown`, `playing`, `roundOver`).

### 8.5 The optional ECS

`shared/ecs.js` is a minimal Entity-Component-System. Use it when you have many similar entities (balls, bricks);
skip it for simple state (Tap Race uses plain arrays).

```js
import { World, defineComponent } from '../../shared/ecs.js';
const Pos = defineComponent('Pos');              // components are tokens; data lives in the World
const world = new World();
const e = world.create();
world.add(e, Pos, { x: 0, y: 0 });
for (const id of world.query(Pos, Vel)) { const p = world.get(id, Pos); /* ... */ }
world.destroy(e);                                 // query() returns a copy: destroying while looping is safe
```

Define components in `shared.js` so server and client use the same tokens (each side owns its own `World`).

---

## 9. Registering your game

Two one-line registrations. Nothing else in the platform changes.

`server/games.js`:

```js
import { warlords } from '../games/warlords/server.js';
import { mygame } from '../games/mygame/server.js';       // <- add

export const games = new Map();
for (const g of [warlords, mygame]) games.set(g.meta.id, g); // <- add to the array
```

`client/games.js`:

```js
import { warlords } from '../games/warlords/client.js';
import { mygame } from '../games/mygame/client.js';        // <- add

export const clientGames = new Map();
for (const g of [warlords, mygame]) clientGames.set(g.meta.id, g);
```

Optional extras, only if your game needs them: append CSS to `client/style.css`, add entries to the import map in
`client/index.html`, add MIME types to `TYPES` in `server/main.js`, add `npm:`/`jsr:` imports to `deno.json`.

The game appears in the lobby's game dropdown on next page load; *Play solo* is enabled if `meta.soloSettings` exists.

---

## 10. Complete worked example: Tap Race

A tiny but complete game: 1 to 4 players (humans + bots) tap as fast as they can; first to the target wins. It uses all
three setting types, `soloSettings`, `canStart`, bots, input validation/rate limiting, `onEnd` and `dispose`. The
server logic was run end-to-end through the real platform (solo flow, bot match, `gameEnd`). Copy the folder, rename,
and change the rules.

### `games/taprace/shared.js`

```js
// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.

/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'taprace', // unique; used as the registry key and in every message
  name: 'Tap Race',
  description: 'Tap faster than everyone else. First to the target wins.',
  minPlayers: 2, // filled seats (players + bots) needed to start
  maxPlayers: 4, // seats
  seatColors: ['#ef4444', '#3b82f6', '#22c55e', '#eab308'],
  tickRate: 20, // server updates per second; a simple game does not need 60
  soloSettings: { botSkill: 'normal' }, // presence of this field enables "Play solo" (you + bots in the other seats)
  settings: [
    { type: 'number', key: 'target', label: 'Taps to win', min: 10, max: 200, step: 5, default: 50 },
    {
      type: 'select', key: 'botSkill', label: 'Bot skill', default: 'normal',
      options: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }],
    },
    { type: 'boolean', key: 'penalty', label: 'Lose a tap when tapping during the countdown', default: true },
  ],
};

export const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308']; // one per slot
```

### `games/taprace/server.js`

```js
import { meta } from './shared.js';

const BOT_TAPS_PER_SECOND = { easy: 3, normal: 5, hard: 8 };
const MIN_TAP_GAP_MS = 50; // anti-cheat: a human cannot tap faster than 20/s, whatever the client sends
const COUNTDOWN = 3;

class TapRaceGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = ctx.settings; // already sanitized by the platform
    this.slotOf = new Map(); // playerId -> slot
    this.active = [false, false, false, false];
    this.bot = [false, false, false, false];
    this.counts = [0, 0, 0, 0];
    this.lastTap = [0, 0, 0, 0];
    this.botAcc = [0, 0, 0, 0]; // fractional taps owed to each bot
    this.countdown = COUNTDOWN;
    this.finished = false;

    for (const p of ctx.players) {
      this.slotOf.set(p.id, p.slot);
      this.active[p.slot] = true;
    }
    this.humans = ctx.players.length;
    for (const slot of ctx.bots) this.active[slot] = this.bot[slot] = true; // seats the host set to "Bot"
  }

  // ── GameInstance ──
  onInput(playerId, data) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || data?.tap !== true) return; // never trust input: validate everything
    const now = performance.now();
    if (now - this.lastTap[slot] < MIN_TAP_GAP_MS) return;
    this.lastTap[slot] = now;
    this.#tap(slot);
  }

  onLeave(playerId) {
    const slot = this.slotOf.get(playerId);
    if (slot === undefined || !this.active[slot]) return;
    this.active[slot] = false;
    this.humans--;
    if (this.humans < 1 && !this.finished) this.#finish(-1); // nobody left to play: close the match
  }

  update(dt) {
    if (this.finished) return;
    if (this.countdown > 0) {
      this.countdown -= dt;
      return;
    }
    const rate = BOT_TAPS_PER_SECOND[this.s.botSkill] ?? BOT_TAPS_PER_SECOND.normal;
    for (let slot = 0; slot < meta.maxPlayers; slot++) {
      if (!this.bot[slot]) continue;
      this.botAcc[slot] += rate * dt * (0.7 + Math.random() * 0.6);
      while (this.botAcc[slot] >= 1 && !this.finished) {
        this.botAcc[slot]--;
        this.#tap(slot);
      }
    }
  }

  snapshot() {
    // Sent to every client every tick as JSON: keep it small and plain.
    return { countdown: this.countdown, counts: [...this.counts], active: [...this.active], bots: [...this.bot] };
  }

  // ── rules ──
  #tap(slot) {
    if (this.finished || !this.active[slot]) return;
    if (this.countdown > 0) {
      if (this.s.penalty) this.counts[slot] = Math.max(0, this.counts[slot] - 1);
      return;
    }
    if (++this.counts[slot] >= this.s.target) this.#finish(slot);
  }

  #finish(winner) {
    this.finished = true;
    this.ctx.end({ winner, counts: [...this.counts] }); // the platform sends {t:'gameEnd', result} and returns the room to setup
  }
}

/** @type {import('../../shared/contracts.js').ServerGame} */
export const taprace = {
  meta,
  create: (ctx) => new TapRaceGame(ctx),
  // no canStart needed: the platform already requires 2 filled seats (minPlayers) and one human
};
```

### `games/taprace/client.js`

```js
import { el } from '../../client/dom.js'; // client games may reuse the shell's tiny DOM helper
import { COLORS, meta } from './shared.js';

class TapRaceView {
  constructor(ctx) {
    this.ctx = ctx; // { container, me: {id, slot}, room, sendInput }
    this.names = new Map(ctx.room.players.filter((p) => p.slot >= 0).map((p) => [p.slot, p.name]));
    this.target = ctx.room.settings.target;

    this.bars = el('div', { class: 'tr-bars' });
    this.banner = el('div', { class: 'tr-banner' });
    this.button = el('button', { class: 'primary tr-button', onpointerdown: () => this.#tap() }, 'TAP');
    this.root = el('div', { class: 'tr-root' }, this.banner, this.bars, this.button);
    ctx.container.append(this.root);

    window.addEventListener('keydown', this.#onKey);
  }

  // ── GameView ──
  onSnapshot(s) {
    this.banner.textContent = s.countdown > 0 ? `Get ready: ${Math.ceil(s.countdown)}` : 'Tap!';
    this.bars.replaceChildren(
      ...s.active.flatMap((on, slot) => {
        if (!on) return [];
        const name = this.names.get(slot) ?? `Bot ${slot + 1}`;
        const fill = el('div', { class: 'tr-fill' });
        fill.style.width = `${Math.min(100, (s.counts[slot] / this.target) * 100)}%`;
        fill.style.background = COLORS[slot];
        return [el('div', { class: 'tr-row' }, el('span', {}, `${name}${slot === this.ctx.me.slot ? ' (you)' : ''}`), el('div', { class: 'tr-track' }, fill))];
      }),
    );
  }

  onEnd(result) {
    this.button.disabled = true;
    this.banner.textContent = result.winner >= 0 ? `${this.names.get(result.winner) ?? `Bot ${result.winner + 1}`} wins!` : 'Match ended';
  }

  dispose() {
    window.removeEventListener('keydown', this.#onKey); // ALWAYS remove global listeners here
    this.root.remove();
  }

  // ── input ──
  #tap() {
    this.ctx.sendInput({ tap: true });
  }

  #onKey = (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    this.#tap();
  };
}

/** @type {import('../../shared/contracts.js').ClientGame} */
export const taprace = {
  meta,
  mount: (ctx) => new TapRaceView(ctx),
};
```

### Append to `client/style.css`

```css
/* Tap Race. Every game prefixes its classes (tr- here, wl- for Warlords) so styles never collide. */
.tr-root { width: min(480px, 92vw); display: flex; flex-direction: column; gap: 1rem; }
.tr-banner { text-align: center; font: 700 1.6rem Palatino, Georgia, serif; }
.tr-row { display: grid; grid-template-columns: 8rem 1fr; align-items: center; gap: .5rem; margin: .3rem 0; }
.tr-track { height: 1rem; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.tr-fill { height: 100%; transition: width .08s linear; }
.tr-button { font-size: 2rem; padding: 1.2rem; touch-action: manipulation; }
```

### Register (section 9)

```js
// server/games.js
import { taprace } from '../games/taprace/server.js';
for (const g of [warlords, taprace]) games.set(g.meta.id, g);

// client/games.js
import { taprace } from '../games/taprace/client.js';
for (const g of [warlords, taprace]) clientGames.set(g.meta.id, g);
```

Then `deno task start`, open `http://localhost:8000`, pick **Tap Race**, press **Play solo**. You land on the solo settings
page showing the four seat rows (you + 3 bots), *Taps to win*, *Bot skill* and the penalty checkbox.

---

## 11. Testing

Tests are plain scripts (no framework) run with `deno run`. Two styles:

**1. Headless simulation test.** Call `create()` directly and step the game yourself. No sockets, no timers, fast:

```js
import { taprace } from '../games/taprace/server.js';
import { defaultSettings } from '../shared/settings.js';

const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok  -', m); };
let result = null;
const settings = { ...defaultSettings(taprace.meta), botSkill: 'hard', target: 20 };
const g = taprace.create({
  players: [{ id: 'p0', name: 'A', slot: 0 }],
  bots: [1, 2, 3],
  settings,
  end: (r) => (result = r),
});
for (let i = 0; i < 20 * 60 && !result; i++) g.update(1 / 20);   // simulate up to 60 s at 20 ticks/s
ok(result && result.winner >= 0, 'match against bots finishes with a winner');
ok(g.snapshot().bots.filter(Boolean).length === 3, 'the three bot seats are bots');
```

**2. Platform test with a fake WebSocket.** Drives the real `Platform` and `Room` (see `tests/platform.test.js`): a
`FakeSocket extends EventTarget` with `send(json)` collecting messages and `say(msg)` dispatching a `message` event.
Useful assertions for a new game: *solo creates a room but does not start until `start`*, *settings are clamped*, *only the
host can change settings*, *snapshots stream after start*, *input reaches the simulation*.

Solo-specific behavior covered by the existing tests: solo rooms are hidden from the lobby list, cannot be joined,
settings are editable and clamped, seats can be changed, starting with too few filled seats is refused.

Front-end code is not covered by these tests: check it by opening two browser tabs (multiplayer) and *Play solo*.

---

## 12. Checklist and common pitfalls

**Checklist for a new game**

- [ ] `games/<id>/shared.js` exports `meta` (unique `id`, `maxPlayers`, `tickRate`, `settings` with defaults)
- [ ] `minPlayers` (filled seats) set; `soloSettings` set if the game can be played alone
- [ ] `ctx.bots` honoured, spectators (`ctx.me.slot === -1`) handled in the client, optional `seatNames` / `seatColors`
- [ ] `games/<id>/server.js` exports `{ meta, create, canStart? }`; instance has `onInput`, `onLeave`, `update`, `snapshot`
- [ ] `games/<id>/client.js` exports `{ meta, mount }`; view has `onSnapshot`, `dispose` (and `onEnd`)
- [ ] Registered in **both** `server/games.js` and `client/games.js`
- [ ] Every code path eventually calls `ctx.end(result)`
- [ ] `onInput` validates everything; nothing in `update`/`snapshot` can throw
- [ ] `dispose()` removes every listener, frame, timer, observer and DOM node
- [ ] CSS classes are prefixed; CSS appended to `client/style.css`
- [ ] New libraries: server ones via `npm:`/`jsr:`/`deno.json`, client ones via the import map; no bare names in shared code
- [ ] New asset types added to `TYPES`
- [ ] A sim test and (optionally) a platform test

**Pitfalls**

| Symptom | Cause |
|---|---|
| Browser: `Failed to resolve module specifier "x"` | bare import with no import-map entry; or a shared file importing something only Deno can resolve |
| `404` for a game file | file is not under `/client/`, `/shared/` or `/games/`, or it is named `server.js` (blocked on purpose) |
| Import works in Deno but not in browser (or vice versa) | missing `.js` extension, or crossing the server/client boundary |
| Audio/font/model fails to load | extension missing from `TYPES` (served as `octet-stream`) |
| Game keeps old behaviour after the first replay | `dispose()` forgot a listener/timer, so two views are alive |
| Server crashes mid-match | exception thrown inside `update()` or `snapshot()` |
| Input seems ignored | message over 4096 chars, not JSON-serializable, or rejected by your own validation |
| "Need at least N seats filled" | `minPlayers` counts humans + bots; the host fills seats in the room (Bot / Sit here) |
| Spectator's client errors on `slot` -1 | guard `ctx.me.slot < 0`: no input, no "your" highlighting |
| Solo button disabled | game has no `meta.soloSettings` |
| Settings value is `undefined` on the server | key missing from `meta.settings` (unknown keys are dropped by `sanitizeSettings`) |
| Stutter on real-time games | rendering raw snapshots; use `SnapshotBuffer`, or predict your own input |
| Smooth locally, laggy online | ticks too slow for the game; raise `tickRate`, and keep snapshots small |

---

## 13. Reference: what Warlords demonstrates

`games/warlords/` is the larger, real-time example to read after Tap Race:

| File | Shows |
|---|---|
| `shared.js` | `meta` with all setting types, seat names/colors and `soloSettings`; geometry helpers used identically by server and client; ECS component tokens |
| `server.js` | multi-round state machine (`countdown` → `playing` → `roundOver`), systems (bots, paddles, spawning, balls), ECS `World` recreated per round, collision substeps to avoid tunnelling, bots from `ctx.bots`, fast-forward when only bots are left |
| `client.js` | Three.js scene (orthographic camera), a client-side ECS `World` with a client-only `Render` component, `SnapshotBuffer` interpolation, mouse + keyboard input, client-side prediction for the player's own paddle, spectator mode, HUD/banner overlays, sound effects from files with synth fallback, full `dispose()` |

The key idea to carry over: **shared** code defines the rules' geometry and constants, the **server** runs the
authoritative simulation and emits compact snapshots, and the **client** is a pure function of the latest snapshots plus
local input.

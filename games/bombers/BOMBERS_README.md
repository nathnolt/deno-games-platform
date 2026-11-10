# Bombers (Bomberman-style game)

Unzip at the project root. It adds `games/bombers/` and `tests/bombers.test.js`, and changes no platform files.

## Register (two lines each)

```js
// server/games.js
import { bombers } from '../games/bombers/server.js';
for (const g of [warlords, ramparts, bombers]) games.set(g.meta.id, g);

// client/games.js
import { bombers } from '../games/bombers/client.js';
for (const g of [warlords, ramparts, bombers]) clientGames.set(g.meta.id, g);
```

Optional: add `&& deno run tests/bombers.test.js` to the `test` task in `deno.json`.

## Files
| File | What it does |
|---|---|
| `shared.js` | meta + settings (3 groups), arena sizes, power-up ids, sudden-death spiral |
| `server.js` | the simulation: grid movement with corner help, bombs, chain reactions, kick, power-ups hidden in crates, rounds, sudden death, bots (danger-map + BFS), fast-forward ×3 when only bots are left alive |
| `client.js` | Canvas 2D view: interpolated players and bombs, flames, particles, HUD chips, banners, keyboard + touch stick |
| `audio.js` | synthesized sound effects (same pattern as Ramparts: drop files in `games/bombers/sounds/` and list them in `SOUND_FILES`) |
| `bombers.css` | loaded by `client.js` itself, all classes prefixed `bm-` (nothing to paste into `client/style.css`) |

## Controls
Arrows or WASD to move, Space or Enter to drop a bomb, M to mute. On touch screens: stick at the bottom left, BOMB button at the bottom right.

## Input protocol
`{ d: 0..4 }` held direction (0 none, 1 up, 2 right, 3 down, 4 left), sent only when it changes. `{ b: 1 }` drops a bomb. The server checks both values.

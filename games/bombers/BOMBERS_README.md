# Bombers (Bomberman-style game) — v2

Unzip at the project root. It replaces `games/bombers/` (one new file: `sprites.js`) and `tests/bombers.test.js`.
No platform files change. If you registered v1, nothing else to do; otherwise:

```js
// server/games.js
import { bombers } from '../games/bombers/server.js';   // and add bombers to the array
// client/games.js
import { bombers } from '../games/bombers/client.js';   // and add bombers to the array
```

## What's new in v2
- **Skull power-up** (setting "Skull power-up", both modes): a random curse for 15 s. Slow feet, way too fast,
  reversed controls, bomb diarrhea (you drop bombs non-stop), no bombs, weak bombs (range 1), short fuse (1 s).
  The curse spreads to anyone you touch. Cursed players turn sickly green with a skull over their head.
- **Co-op mode** (setting "Mode"): the team against monsters, level after level.
  - Kill every monster, then step on the exit. The exit hides under a crate. Bombing the exit once it's
    uncovered lets out more monsters.
  - Only a few power-ups per level (setting), and you keep them into the next level. The "On death" setting
    picks whether you keep them, lose one of each, or lose them all when you die.
  - Lives per player (setting, default 3). You come back after 2 s with a 3 s shield. Hearts hide in some
    crates (every 3rd level for sure), and points give extra lives (setting, default every 5,000).
  - Points: Blob 100, Chaser 200, Dasher 300, Ghost 400, Sneak 800, crate 10, level clear 500 + 100 × level.
  - Monsters: **Blob** wanders and walks into fire; **Chaser** paths to the nearest player; **Dasher** runs
    straight until it hits something; **Ghost** drifts through crates toward you; **Sneak** dodges blasts and hunts.
    New kinds appear from levels 2, 3, 4 and 6.
  - Team-mates' bombs don't hurt you unless you turn that on. Bot seats are team-mates.
  - Game over when no human has lives left. Victory after the last level (setting, default 10).
- **Pixel-art look**: the board is drawn at 16 px per tile and scaled up with hard pixels (whole-pixel scaling
  when that costs less than 20 % size). Sprites live in `sprites.js` as text (one character = one pixel, outline
  added automatically), so they are easy to edit.
- **Pixel font**: "Press Start 2P" loaded from Google Fonts by `bombers.css` (free licence). Offline, a monospace
  font is used instead; to self-host, put the font file in `games/bombers/` and change the `@import`.

## Settings
Mode and bot skill are at the top. Then four groups: Battle mode, Co-op mode, Arena, and Bombs & power-ups.
Battle needs 2 filled seats (`canStart` explains this). Co-op can be played alone.

## Controls
Arrows or WASD to move, Space or Enter to drop a bomb, M to mute. On touch screens: stick at the bottom left,
BOMB button at the bottom right.

// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.

/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'balance',
  name: 'Balance Tower',
  description: 'Co-op stacking. Grab blocks from the front of the table and drop them onto the shared tower.',
  maxPlayers: 6, // seats; everyone after that spectates until a seat frees up
  minPlayers: 1,
  dropIn: true, // no setup page: people come and go while the tower grows
  tickRate: 30, // a bit higher than Dot Field so falling blocks look smooth
  settings: [],
};

// ── world units: x = left/right, y = up, z = towards the camera. The table top is y = 0. ──
export const BLOCK = 2; //            a block is a 2x2 square (plus depth, see DEPTH)
export const HALF = BLOCK / 2;
export const DEPTH = 2.4; //          thickness of a block along z
export const FRONT_Z = 1.6; //        front layer: blocks waiting to be picked up
export const BACK_Z = -1.6; //        back layer: the tower
export const HOVER_Z = 0.4; //        a held block floats this much closer to the camera

export const TABLE_HALF_W = 13; //    table spans x -13..13, z -4..4
export const PLAT_HALF = 3.5; //      the base plate the tower starts on (x -3.5..3.5)
export const PLAT_TOP = 0.5;

export const SLOT_X = [-9.5, -6.5, 6.5, 9.5]; // where blocks wait in the front layer
export const SLOT_Y = HALF; //                   they rest on the table

/** The drop zone: release a held block with its centre inside this rectangle and it falls onto the tower. */
export const ZONE = { x0: -4.5, x1: 4.5, y0: 0, y1: 18 };
export const inZone = (x, y) => x >= ZONE.x0 && x <= ZONE.x1 && y >= ZONE.y0 && y <= ZONE.y1;

export const GOAL_Y = 12; //          tower top at this height = tower complete (6 blocks on the plate)

/** Block states in snapshots. */
export const ST = { IDLE: 0, HELD: 1, BACK: 2, FALL: 3, STACK: 4 };

export const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4']; // player colours per seat
export const BLOCK_COLORS = ['#f59e0b', '#10b981', '#60a5fa', '#f472b6', '#a78bfa', '#f87171']; // block body colours

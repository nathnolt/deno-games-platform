// Runs on BOTH server and browser. No DOM, no Deno APIs, no imports from client/ or server/.

/** @type {import('../../shared/settings.js').GameMeta} */
export const meta = {
  id: 'dotfield',
  name: 'Dot Field',
  description: 'Drift around a shared field. Join or leave whenever you like.',
  maxPlayers: 8, // number of seats (default 4 when omitted). Everyone after that spectates until a seat frees up
  minPlayers: 1, // a drop-in game must be able to run with one person
  dropIn: true, // ★ no setup page; the match starts when the room is created; people come and go
  tickRate: 20,
  settings: [], // no settings: the setup section is hidden (and a drop-in game never shows it anyway)
};

export const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316', '#ec4899'];

import { warlords } from '../games/warlords/server.js';
import { ramparts } from '../games/rampart/server.js';
import { dotfield } from '../games/dotfield/server.js';

const availableGames = [
	warlords,
	ramparts,
	dotfield
]

// To add a game: create games/<id>/{shared,server,client}.js and list its ServerGame here
// (and its ClientGame in client/games.js).
export const games = new Map();
for (const g of availableGames) games.set(g.meta.id, g);

import { warlords } from '../games/warlords/client.js';
import { ramparts } from '../games/rampart/client.js';

const availableGames = [
	warlords,
	ramparts
]

// To add a game: create games/<id>/{shared,server,client}.js and list its ClientGame here
// (and its ServerGame in server/games.js).
export const clientGames = new Map();
for (const g of availableGames) clientGames.set(g.meta.id, g);

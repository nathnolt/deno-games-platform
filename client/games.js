import { warlords } from '../games/warlords/client.js';
import { ramparts } from '../games/rampart/client.js';
import { dotfield } from '../games/dotfield/client.js';
import { balance } from '../games/balance/client.js';

const availableGames = [
	warlords,
	ramparts,
	balance,
	dotfield
]

// To add a game: create games/<id>/{shared,server,client}.js and list its ClientGame here
// (and its ServerGame in server/games.js).
export const clientGames = new Map();
for (const g of availableGames) clientGames.set(g.meta.id, g);

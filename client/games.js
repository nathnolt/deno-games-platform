import { warlords } from '../games/warlords/client.js';

// To add a game: create games/<id>/{shared,server,client}.js and list its ClientGame here
// (and its ServerGame in server/games.js).
export const clientGames = new Map();
for (const g of [warlords]) clientGames.set(g.meta.id, g);

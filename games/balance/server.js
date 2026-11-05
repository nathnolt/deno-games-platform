// SERVER: the room's game. The authoritative physics simulation (planck.js = Box2D for JavaScript) lives in sim.js, which the debug menu's
// local game (a private copy that runs in the browser) uses too: this file only plugs planck into it and hands the platform its game object.
//
// planck is loaded straight from npm by Deno (no deno.json change needed). It needs no extra permissions.
import * as planck from 'npm:planck@1';
import { meta } from './shared.js';
import { BalanceGame, usePlanck } from './sim.js';

usePlanck(planck);

export { clipBelow } from './sim.js';

/** @type {import('../../shared/contracts.js').ServerGame} */
export const balance = { meta, create: (ctx) => new BalanceGame(ctx) };

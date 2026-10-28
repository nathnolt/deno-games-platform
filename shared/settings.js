/**
 * @typedef {{type:'number',key:string,label:string,min:number,max:number,step?:number,default:number}
 *   | {type:'boolean',key:string,label:string,default:boolean}
 *   | {type:'select',key:string,label:string,options:{value:string,label:string}[],default:string}} SettingField
 *
 * @typedef {object} GameMeta
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {number} minPlayers          minimum number of FILLED seats (humans + bots) needed to start; at least one must be human
 * @property {number} maxPlayers          number of seats; the room shows one row per seat
 * @property {string[]} [seatNames]       optional label per seat, e.g. ['Top left', ...]
 * @property {string[]} [seatColors]      optional CSS color per seat, shown next to its row
 * @property {number} tickRate            server updates per second
 * @property {SettingField[]} settings    drives the generated setup form
 * @property {Record<string, number|boolean|string>} [soloSettings]  if set, the lobby offers "Play solo" (you in seat 1, bots in the rest; {} = just the defaults)
 */

export function defaultSettings(meta) {
  const out = {};
  for (const f of meta.settings) out[f.key] = f.default;
  return out;
}

/** Never trust client settings: clamp, round and fall back to defaults. */
export function sanitizeSettings(meta, raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const f of meta.settings) {
    const v = input[f.key];
    if (f.type === 'number') {
      let n = typeof v === 'number' && Number.isFinite(v) ? v : f.default;
      if (f.step) n = Math.round(n / f.step) * f.step;
      out[f.key] = Math.min(f.max, Math.max(f.min, n));
    } else if (f.type === 'boolean') {
      out[f.key] = typeof v === 'boolean' ? v : f.default;
    } else {
      out[f.key] = typeof v === 'string' && f.options.some((o) => o.value === v) ? v : f.default;
    }
  }
  return out;
}

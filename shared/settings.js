/**
 * @typedef {{type:'number',key:string,label:string,group?:string,min:number,max:number,step?:number,default:number}
 *   | {type:'boolean',key:string,label:string,group?:string,default:boolean}
 *   | {type:'select',key:string,label:string,group?:string,options:{value:string,label:string}[],default:string}} SettingField
 *
 * A visual section of the setup form. Purely presentational: values stay a flat { key: value } object.
 * @typedef {object} SettingGroup
 * @property {string} id               referenced by SettingField.group
 * @property {string} label            section title
 * @property {string} [description]    optional muted line under the title
 * @property {boolean} [collapsed]     start folded (the player can open it). Default: open
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
 * @property {SettingGroup[]} [settingGroups]  optional sections for the setup form; fields join one via `group: '<id>'`
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

/**
 * Splits meta.settings into the sections the form shows. Presentation only: it never changes keys or values.
 *  - `loose`: fields with no `group` (shown first, without a header)
 *  - `groups`: declared groups in `settingGroups` order that contain at least one field, then any group id used
 *    by a field but not declared (titled with its id), in order of first use. Empty groups are skipped.
 * @returns {{loose: SettingField[], groups: (SettingGroup & {fields: SettingField[]})[]}}
 */
export function groupSettings(meta) {
  const byId = new Map();
  for (const g of meta.settingGroups ?? []) byId.set(g.id, { ...g, fields: [] });
  const loose = [];
  for (const f of meta.settings) {
    if (!f.group) {
      loose.push(f);
      continue;
    }
    if (!byId.has(f.group)) byId.set(f.group, { id: f.group, label: f.group, fields: [] });
    byId.get(f.group).fields.push(f);
  }
  return { loose, groups: [...byId.values()].filter((g) => g.fields.length) };
}

import { el } from './dom.js';
import { groupSettings } from '../shared/settings.js';

// The room page is rebuilt whenever the server broadcasts room state (e.g. after every settings change),
// so remember which groups the player folded/unfolded; otherwise they would snap back each time.
const openState = new Map(); // `${gameId}/${groupId}` -> boolean

/**
 * Default setup UI, generated from the game's settings schema. Only the host can edit.
 * Fields without a `group` come first; each group in meta.settingGroups is a collapsible section.
 */
export function settingsForm(meta, values, editable, onChange) {
  const inputs = new Map();
  const collect = () => {
    const out = {};
    for (const f of meta.settings) {
      const i = inputs.get(f.key);
      out[f.key] = f.type === 'number' ? Number(i.value) : f.type === 'boolean' ? i.checked : i.value;
    }
    onChange(out);
  };

  const row = (f) => {
    let input;
    if (f.type === 'number') {
      input = el('input', { type: 'number', min: f.min, max: f.max, step: f.step ?? 1, value: String(values[f.key]) });
    } else if (f.type === 'boolean') {
      input = el('input', { type: 'checkbox', checked: Boolean(values[f.key]) });
    } else {
      input = el('select', {}, ...f.options.map((o) => el('option', { value: o.value, textContent: o.label })));
      input.value = String(values[f.key]);
    }
    input.disabled = !editable;
    input.addEventListener('change', collect);
    inputs.set(f.key, input);
    return el('label', { class: 'setting' }, el('span', {}, f.label), input);
  };

  const { loose, groups } = groupSettings(meta);

  const sections = groups.map((g) => {
    const key = `${meta.id}/${g.id}`;
    const open = openState.get(key) ?? !g.collapsed;
    return el(
      'details',
      { class: 'settings-group', open, ontoggle: (e) => openState.set(key, e.target.open) },
      el('summary', {}, g.label),
      g.description ? el('p', { class: 'muted settings-group-desc' }, g.description) : '',
      ...g.fields.map(row),
    );
  });

  return el('div', { class: 'settings' }, ...loose.map(row), ...sections);
}

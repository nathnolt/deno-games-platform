import { el } from './dom.js';

/** Default setup UI, generated from the game's settings schema. Only the host can edit. */
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

  const rows = meta.settings.map((f) => {
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
  });
  return el('div', { class: 'settings' }, ...rows);
}

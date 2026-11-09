// CLIENT ONLY: the shader chooser (a dialog with every shader drawn on a 3D ball, in categories) and the rows of settings of a shader.
// Used by the debug menu (materials, bowls, models, backgrounds), the background studio and the Shaders menu (shader-library.js).
import { paramValue, resolveShader } from './shared.js';
import { h, svg } from './ui.js';

const fixed = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
export const BASE_CATEGORY = 'Base shaders';

// ── the chooser ──
const thumbCache = new Map(); // key (name + code + settings) -> data URL of the ball

const keyOf = (r) => `${r.name}|${r.code.length}|${r.code.slice(0, 80)}|${JSON.stringify(r.params)}`;

/**
 * The shaders that can be picked here, in categories: [{ category, items: [{ name, final, base, entry }] }]. `water` = the water shaders, else the block shaders.
 * Parameterised shaders come under their own category, base shaders under "Base shaders".
 */
export function shaderGroups(table, { water = false, only = 'all' } = {}) {
  const cats = new Map();
  for (const name of Object.keys(table ?? {})) {
    const r = resolveShader(name, table);
    if (!r || (r.type === 'water') !== water) continue;
    if (only === 'base' && r.final) continue;
    if (only === 'final' && !r.final) continue;
    const cat = r.final ? r.category ?? 'Other' : BASE_CATEGORY;
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push({ name, final: r.final, base: r.base, entry: r });
  }
  const order = [...cats.keys()].sort((a, b) => (a === BASE_CATEGORY) - (b === BASE_CATEGORY) || a.localeCompare(b));
  return order.map((category) => ({ category, items: cats.get(category).sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Fills `img` elements with the picture of each shader (from the cache, or drawn by the view one by one). Returns { cancel }. */
function paintThumbs(view, jobs) { // jobs: [{ entry, img }]
  const todo = [];
  for (const j of jobs) {
    const k = keyOf(j.entry);
    const hit = thumbCache.get(k);
    if (hit) j.img.src = hit;
    else todo.push({ key: k, entry: j.entry, img: j.img });
  }
  if (!todo.length) return { cancel() {} };
  const by = new Map();
  for (const t of todo) { if (!by.has(t.key)) by.set(t.key, []); by.get(t.key).push(t.img); }
  const items = [...by.keys()].map((key) => ({ key, entry: todo.find((t) => t.key === key).entry }));
  return view.debugShaderThumbs(items, (key, url) => {
    if (!url) return;
    thumbCache.set(key, url);
    for (const img of by.get(key)) img.src = url;
  });
}

const ball = (entry) => { const img = h('img', { class: 'bb-sp-ball', alt: '', draggable: 'false' }); return { img, entry }; };

/** The dialog. onPick(name) is called with the chosen shader name ('' = the "none" item, when allowEmpty). */
export function openShaderDialog({ view, table, water = false, only = 'all', value = '', allowEmpty = false, emptyLabel = '(none)', title = 'Choose a shader', onPick }) {
  let filter = only === 'all' ? 'all' : only;
  let painter = null;
  const close = () => { painter?.cancel(); back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const body = h('div', { class: 'bb-st-pick-body' });
  const seg = h('div', { class: 'bb-st-seg' });
  const draw = () => {
    painter?.cancel();
    seg.replaceChildren(...(only === 'all' ? [['all', 'All'], ['final', 'Parameterized'], ['base', 'Base']] : []).map(([k, l]) => h('button', { type: 'button', class: filter === k ? 'bb-on' : '', onclick: () => { filter = k; draw(); } }, l)));
    const jobs = [];
    const kids = [];
    if (allowEmpty) kids.push(h('div', { class: 'bb-st-pick-grid' }, h('button', { type: 'button', class: `bb-st-pick-item${value === '' ? ' bb-on' : ''}`, onclick: () => { close(); onPick(''); } }, h('span', {}, emptyLabel))));
    const groups = shaderGroups(table(), { water, only: filter });
    if (!groups.length) kids.push(h('p', { class: 'bb-dbg-note' }, 'No shaders here yet. Make some in the Shaders menu.'));
    for (const g of groups) {
      kids.push(h('div', { class: 'bb-st-pick-cat' }, h('h4', {}, `${g.category} · ${g.items.length}`), h('div', { class: 'bb-st-pick-grid' }, g.items.map((it) => {
        const b = ball(it.entry);
        jobs.push(b);
        return h('button', { type: 'button', class: `bb-st-pick-item${it.name === value ? ' bb-on' : ''}`, title: it.final ? `${it.name}: ${it.base} with its settings` : `${it.name}: a base shader`, onclick: () => { close(); onPick(it.name); } },
          h('span', { class: 'bb-sp-thumb' }, b.img), h('span', {}, it.name), it.final ? h('small', {}, it.base) : null);
      }))));
    }
    body.replaceChildren(...kids);
    painter = paintThumbs(view, jobs.map((j) => ({ entry: j.entry, img: j.img })));
  };
  const back = h('div', { class: 'bb-st-dlg-back', onpointerdown: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'bb-st-dlg bb-st-pick', role: 'dialog' },
      h('button', { type: 'button', class: 'bb-st-dlg-x', title: 'Close', onclick: close }, '✕'),
      h('h3', {}, title), seg, body));
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  draw();
}

/**
 * A button that shows the shader (a little ball and its name) and opens the chooser. `obj[key]` is the shader name; onPick(name) runs after it changed.
 * @param o { view, table(): the shaders (the draft's shaderCode), value, onPick(name), water?, only?: 'all' | 'base', allowEmpty?, emptyLabel? }
 */
export function shaderPicker({ view, table, value, onPick, water = false, only = 'all', allowEmpty = false, emptyLabel = '(none)', title }) {
  const r = value ? resolveShader(value, table()) : null;
  const b = r ? ball(r) : null;
  const btn = h('button', { type: 'button', class: 'bb-dbg-btn bb-sp-btn', title: 'Choose a shader', onclick: () => openShaderDialog({ view, table, water, only, value, allowEmpty, emptyLabel, title, onPick }) },
    b ? h('span', { class: 'bb-sp-thumb bb-sp-small' }, b.img) : null,
    h('span', { class: 'bb-sp-name' }, value || emptyLabel), r?.final ? h('small', {}, r.base) : null, h('span', {}, '▾'));
  if (b) paintThumbs(view, [b]);
  return btn;
}

/** The rows: one control per parameter (a colour picker, a slider with a number, number boxes), and one sun pad for uSunTurn + uSunHeight. */
export function paramRows({ h, view, list, params, live, commit, reset: afterReset }) {
  const field = (text, ...controls) => h('label', { class: 'bb-dbg-field' }, h('span', { class: 'bb-dbg-lab' }, text), h('span', { class: 'bb-dbg-ctl bb-wp-row' }, ...controls));
  const btn = (text, fn, title) => h('button', { type: 'button', class: 'bb-dbg-btn', title, onclick: fn }, text);
  const out = [];
  // the sun: shaders with uSunTurn (compass direction) and uSunHeight (degrees above the horizon) get ONE pad to drag the sun on instead of two sliders
  const pTurn = list.find((p) => p.name === 'uSunTurn' && p.def.length === 1);
  const pHeight = list.find((p) => p.name === 'uSunHeight' && p.def.length === 1);
  if (pTurn && pHeight) {
    const R = 54;
    const C = 64;
    const get = () => [paramValue(pTurn, params.uSunTurn), paramValue(pHeight, params.uSunHeight)];
    const lo = pHeight.min ?? -10;
    const span = 90 - lo; // the centre is straight above (90), the rim is the lowest height
    const place = () => {
      const [turn, height] = get();
      const rad = Math.max(0, Math.min(1, (90 - height) / span)) * R;
      const a = (turn * Math.PI) / 180;
      const x = C + rad * Math.sin(a);
      const y = C + rad * Math.cos(a); // (the front, where the camera is, is the bottom)
      sunG.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      readout.textContent = `turn ${Math.round(turn)}°  ·  height ${Math.round(height)}°`;
    };
    const sunG = svg('g', {}, svg('circle', { r: 13, fill: '#ffd24a', opacity: 0.25 }), svg('circle', { r: 7, fill: '#ffd24a', stroke: '#fff7d0', 'stroke-width': 1.5 }));
    const ring = (f) => svg('circle', { cx: C, cy: C, r: R * f, fill: 'none', stroke: '#fff', 'stroke-opacity': 0.18, 'stroke-dasharray': '2 3' });
    const txt = (x, y, s) => { const t = svg('text', { x, y, 'text-anchor': 'middle', fill: '#fff', 'fill-opacity': 0.6, 'font-size': 9 }); t.textContent = s; return t; };
    const pad = svg('svg', { viewBox: '0 0 128 128', width: 128, height: 128, style: 'touch-action:none;cursor:crosshair;flex:none' },
      svg('circle', { cx: C, cy: C, r: R + 4, fill: '#16243a', stroke: '#fff', 'stroke-opacity': 0.35 }),
      ring(1 / 3), ring(2 / 3),
      svg('line', { x1: C, y1: C - R, x2: C, y2: C + R, stroke: '#fff', 'stroke-opacity': 0.12 }),
      svg('line', { x1: C - R, y1: C, x2: C + R, y2: C, stroke: '#fff', 'stroke-opacity': 0.12 }),
      txt(C, 11, 'behind'), txt(C, 124, 'front (you)'),
      sunG);
    const readout = h('code', { class: 'bb-wp-num', style: 'min-width:0;width:13em;height:1.4em;line-height:1.4em;text-align:left;overflow:hidden' }); // (a fixed size: the numbers changing must not move anything)
    const aim = (e) => {
      const r = pad.getBoundingClientRect();
      const dx = ((e.clientX - r.left) / r.width) * 128 - C;
      const dy = ((e.clientY - r.top) / r.height) * 128 - C;
      params.uSunTurn = Math.round((Math.atan2(dx, dy) * 180) / Math.PI * 10) / 10;
      params.uSunHeight = Math.round((90 - Math.min(1, Math.hypot(dx, dy) / R) * span) * 10) / 10;
      place();
      live();
    };
    let drag = false;
    pad.addEventListener('pointerdown', (e) => { drag = true; pad.setPointerCapture?.(e.pointerId); aim(e); });
    pad.addEventListener('pointermove', (e) => { if (drag) aim(e); });
    const end = () => { if (!drag) return; drag = false; commit(); };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
    const reset = btn('↺', () => { delete params.uSunTurn; delete params.uSunHeight; afterReset(); }, 'back to the default sun');
    place();
    out.push(h('div', { class: 'bb-dbg-field' }, h('span', { class: 'bb-dbg-lab' }, 'sun (drag it)'), h('span', { class: 'bb-dbg-ctl', style: 'flex-direction:column;align-items:flex-end;gap:4px' }, pad, h('span', { class: 'bb-wp-row' }, readout, reset))));
  }
  for (const p of list) {
    if (pTurn && pHeight && (p === pTurn || p === pHeight)) continue;
    const cur = paramValue(p, params[p.name]);
    const reset = btn('↺', () => { delete params[p.name]; afterReset(); }, 'back to the default of the shader');
    let ctl;
    if (p.color) {
      ctl = h('input', { type: 'color', value: cur });
      ctl.addEventListener('input', () => { params[p.name] = ctl.value; live(); });
      ctl.addEventListener('change', () => { params[p.name] = ctl.value; commit(); });
    } else if (p.def.length === 1) {
      const lo = p.min ?? Math.min(0, p.def[0] * 3);
      const hi = p.max ?? Math.max(1, p.def[0] * 3);
      const range = h('input', { type: 'range', class: 'bb-wp-range', min: lo, max: hi, step: (hi - lo) / 200, value: cur });
      const num = h('code', { class: 'bb-wp-num' }, fixed(cur)); // (a fixed width: the number growing a digit must not push the row onto the next line)
      range.addEventListener('input', () => { params[p.name] = parseFloat(range.value); num.textContent = fixed(params[p.name]); live(); });
      range.addEventListener('change', () => commit());
      ctl = h('span', { class: 'bb-wp-row' }, range, num);
    } else {
      ctl = h('span', { class: 'bb-wp-row' }, ...cur.map((v, i) => {
        const x = h('input', { type: 'number', step: 'any', class: 'bb-dbg-n', value: v });
        x.addEventListener('input', () => { const n = parseFloat(x.value); if (!Number.isFinite(n)) return; const arr = [...paramValue(p, params[p.name])]; arr[i] = n; params[p.name] = arr; live(); });
        x.addEventListener('change', () => commit());
        return x;
      }));
    }
    out.push(field(`${p.name}${p.name in params ? '' : ' (default)'}`, ctl, reset));
  }
  return out;
}

// The controls of the WATER of a background: which water shader it uses (a shader of type 'water' in _shaders.js, or the classic water) and the
// parameters of that shader (uniforms it declares with a default in a comment). Used by the debug menu and by the background studio.
import { paramValue } from './shared.js';
import { svg } from './ui.js';

const fixed = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/**
 * @param o  { h, view, bg, touch(kind, quiet?, live?), draft(), rerender() }
 * Returns a list of nodes. The water of the background is `bg.water = { shader?, params? }`.
 */
export function waterControls({ h, view, bg, touch, draft, rerender }) {
  const field = (text, ...controls) => h('label', { class: 'bb-dbg-field' }, h('span', { class: 'bb-dbg-lab' }, text), h('span', { class: 'bb-dbg-ctl bb-wp-row' }, ...controls));
  const note = (text) => h('p', { class: 'bb-dbg-note' }, text);
  const btn = (text, fn, title) => h('button', { type: 'button', class: 'bb-dbg-btn', title, onclick: fn }, text);

  const sel = h('select', {}, [['', '(classic water)'], ...view.waterShaderNames.map((n) => [n, n])].map(([v, l]) => h('option', { value: v }, l)));
  sel.value = bg.water?.shader ?? '';
  sel.addEventListener('change', () => {
    if (sel.value === '') { delete bg.water?.shader; if (bg.water && !Object.keys(bg.water).length) delete bg.water; } else (bg.water ??= {}).shader = sel.value;
    touch('backgrounds');
    rerender();
  });
  const out = [field('water shader', sel)];

  const name = bg.water?.shader;
  if (!name) return [...out, note('The water of the bowl. Pick a shader of type "water" (made in the shader studio) to change how it looks.')];
  const list = view.debugShaderParams(name);
  if (!list.length) return [...out, note(`The shader "${name}" has no parameters. A uniform with a default in a comment, like  uniform float uGlitter;  // 1.0 [0, 3]  becomes one.`)];
  const params = (bg.water.params ??= {});
  // while a control is dragged only the uniforms of the water that is drawn change (cheap); the game gets the draft when it is let go
  return [...out, ...paramRows({
    h, view, list, params,
    live: () => { touch('backgrounds', true, true); view.debugLiveWater(draft()); },
    commit: () => touch('backgrounds'),
    reset: () => { touch('backgrounds'); view.debugLiveWater(draft()); rerender(); },
  })];
}

/**
 * Controls for the parameters (uniforms with a default in a comment) of a BLOCK shader, for a material: `mat.shaderParams = { uBump: 0.2 }`.
 * @param o  { h, view, mat, touch(kind, quiet?, live?), draft(), rerender() }  Returns a list of nodes (empty when the shader has no parameters).
 */
export function blockShaderControls({ h, view, mat, touch, draft, rerender, shader = mat.shader, kind = 'materials' }) {
  const list = view.debugShaderParams(shader).filter((p) => p.name !== 'uBlockOpacity');
  if (!list.length) return [];
  const params = (mat.shaderParams ??= {});
  const prune = () => { if (!Object.keys(params).length) delete mat.shaderParams; };
  return paramRows({
    h, view, list, params,
    live: () => { touch(kind, true, true); view.debugLiveBlocks(draft()); },
    commit: () => { prune(); touch(kind); },
    reset: () => { prune(); touch(kind); view.debugLiveBlocks(draft()); rerender(); },
  });
}

/** The rows: one control per parameter (a colour picker, a slider with a number, number boxes), and one sun pad for uSunTurn + uSunHeight. */
function paramRows({ h, view, list, params, live, commit, reset: afterReset }) {
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

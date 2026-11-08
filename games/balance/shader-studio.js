// CLIENT ONLY: the SHADER STUDIO of the debug menu (created by studio.js, loaded by debug.js, so only with DEBUG on).
//
// Edit the GLSL of any shader (the built-in ones too), make copies of them or write new ones, and see the result at once: in a small preview
// (a sphere and a block) and in the local game next to the panel, where every block, the bowl and the scenery that use the shader change.
//
// ALL shaders live in _shaders.js (shaders.js only has the common part every shader starts with). A copy or a new shader has a name of its own,
// and then it can be picked everywhere a shader is chosen (materials, bowls, models, backgrounds).
// Like everything in the debug menu the edits are only in your DRAFT. "Save shader" (after a confirmation) writes ONE shader to _shaders.js.

import { h } from './ui.js';

const KEY = /^[A-Za-z][\w-]{0,39}$/;
const WIDTH = 580;
const TYPES = [['opaque', 'solid'], ['transparent', 'see-through'], ['refract', 'see-through and bends the picture behind it'], ['water', 'WATER of a bowl (picked in the bowl editor)']];
const BLANK = `void main() {
  vec3 c = vec3(0.6, 0.55, 0.5);
  gl_FragColor = finish(c, 1.0);
}
`;
const HELP = `Everything here is GLSL (fragment shader). You write what comes after the common part, which already gives you:
  vP (2D coordinates of the block face), vP3 (position in the mesh), vW / vWN (world position / normal), vN, uTime, uSeed (differs per block)
  hash(vec2), noise(vec2), fbm(vec2)           value noise, 0..1
  perlin(vec3) -1..1, pfbm(vec3) 0..1          Perlin (gradient) noise
  finish(colour, alpha)                         the lighting, shadows, fog: end with  gl_FragColor = finish(c, 1.0);
Shine (optional, set before finish): gShine (strength, 0 = none), gBlow (0..1: where the sun hits, it is brighter and a bit blown out)
ROUGHNESS MAP: gRough = (0 glossy .. 1 rough); it is a value per pixel, so make it from noise:  gRough = 0.3 + 0.6 * pfbm(q);
BUMP MAP: gNormal = woodBump(q, 0.1, 1.0) or rockBump(q, 0.3, 1.0), then gHasN = 1.0;   (q = a position, the last number: 1 = a position in the
  mesh (blocks that move), 0 = in the world). Your own height: take its slope and use  gNormal = bumpedNormal(grad, 0.3, 1.0);  (see shaders.js)
Extra light: gSpec (always), gGlint (only where the sun is not in shadow)
MORE HELPERS (block and water shaders): PI, TAU, saturate, remap(v,a,b,c,d), rot2(angle), luma(c), hash11/21/22/31/33, noise3/fbm3 (vec3 value noise, 0..1),
  voronoi(vec2) -> (distance, edge distance, cell id), palette(t,a,b,c,d), hsv2rgb / rgb2hsv, 2D distance shapes sdCircle sdBox sdRoundBox sdSegment sdRing
  sdHexagon sdTriangle, smin, sdfFill(d) (a distance -> 1 inside with a one-pixel edge), checker(p), plot(v, y), graphBG(uv), viewDir(), surfNormal(),
  fresnel(n, v, power), lambert(n, l), blinn(n, l, v, shininess)
Light: uLightDir, uLightCol, uAmbSky.   Camera: cameraPosition.   For see-through shaders see the glass shaders.

FAST NOISE (block and water shaders): noiseT(vec2) noise3T(vec3) fbmT(vec2) fbm3T(vec3) voronoiT(vec2) hashT(vec2) read a picture of random numbers (uNoiseTex)
  instead of calculating hashes: much cheaper than noise / fbm3 / voronoi. noiseTile(p, period) / fbmTile(p, period) repeat exactly every "period" cells.
BAKING (water shaders): write  vec4 bake(vec2 uv)  and the picture it draws is made ONCE (not every frame); in main() read it with texture(uBake, uv) (it repeats).
  A first line like  // bake 1024  sets its size (default 512). It is drawn again when you change a parameter. uResolution = its size.
TYPE 'water' (the water of a bowl, picked in the background editor) has ANOTHER common part: vUv (about 0..1 across the bowl), vPos (world / 20), vW, vWN,
  uTime, uColor, uLightDir, uLightCol, uSky, noise(vec2) fbm(vec2) noise3(vec3) fbm3(vec3) (0..1), viewDir(), fresnel(n, v, power),
  bumpFromHeight(h, k) (a normal tilted by the slope of a height). End with gl_FragColor = vec4(colour, 1.0): the opacity of the bowl's water is applied after.
  PARAMETERS: a uniform declared with a default in a comment becomes a control in the bowl editor:
    uniform float uGlitter;    // 1.0 [0, 3]            slider (default, [min, max])
    uniform vec3 uHighlight;   // color 1.0 0.95 0.8    colour picker
    uniform vec2 uFlow;        // 0.2 0.1               number boxes`;

/**
 * @param view  the BalanceView
 * @param api   { draft(), touch(kind), saveItem(request), problems(), showProblems(el), close(), confirmDialog(options) } (see studio.js / debug.js)
 */
export function shaderStudio(view, api) {
  const st = { open: false, sel: '', text: '', type: 'opaque' };
  let timer = 0;
  let preview = null;

  const D = () => api.draft();
  const table = () => (D().shaderCode ??= {});
  const builtin = () => []; // (every shader is in _shaders.js now; shaders.js only has the common part)
  const isBuiltin = (n) => builtin().includes(n);
  const allNames = () => [...builtin(), ...Object.keys(table()).filter((n) => !isBuiltin(n))];
  const baseType = (n) => (isBuiltin(n) ? view.debugBuiltinType(n) : 'opaque');
  const codeOf = (n) => table()[n]?.code ?? view.debugShaderBody(n);
  const typeOf = (n) => table()[n]?.type ?? baseType(n);
  const saved = (n) => view.debugRoomDefs()?.shaderCode?.[n] ?? null; // (what _shaders.js has: the room's version)
  const dirty = (n) => JSON.stringify(table()[n] ?? null) !== JSON.stringify(saved(n));
  const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, onclick: fn }, text);

  const probEl = h('span', { class: 'bb-st-prob' });
  const head = h('div', { class: 'bb-st-head' }, h('strong', {}, 'Shader studio'), probEl, h('span', { class: 'bb-dbg-grow' }), btn('Close', () => api.close()));
  const pick = h('select', { class: 'bb-sh-pick' });
  const typeSel = h('select', {}, TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const actions = h('div', { class: 'bb-dbg-row' });
  const previewHost = h('div', { class: 'bb-sh-preview' });
  const code = h('textarea', { class: 'bb-sh-code', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off' });
  const errEl = h('div', { class: 'bb-sh-errors' });
  const saveRow = h('div', { class: 'bb-dbg-row' });
  const body = h('div', { class: 'bb-st-body bb-sh-body' },
    h('div', { class: 'bb-dbg-row' }, pick),
    actions,
    h('div', { class: 'bb-dbg-row' }, h('span', { class: 'bb-st-mini' }, 'type'), typeSel),
    previewHost, code, errEl, saveRow,
    h('details', { class: 'bb-sh-help' }, h('summary', {}, 'What can I use in a shader?'), h('pre', {}, HELP)));
  const root = h('div', { class: 'bb-st bb-st-dock' }, head, body);

  // ── what is shown ──
  function fillPick() {
    const mark = (n) => `${n}${table()[n] ? (isBuiltin(n) ? ' (changed)' : '') : ''}${dirty(n) ? ' •' : ''}`;
    const group = (label, names) => h('optgroup', { label }, names.map((n) => h('option', { value: n }, mark(n))));
    const mine = Object.keys(table()).filter((n) => !isBuiltin(n));
    pick.replaceChildren(group('Shaders', mine));
    pick.value = st.sel;
  }

  function renderActions() {
    const n = st.sel;
    const kids = [btn('Copy…', copy), btn('New…', create)];
    if (isBuiltin(n)) kids.push(btn('Reset to original', reset, table()[n] ? '' : 'bb-off'));
    else kids.push(btn('Delete', remove, 'bb-dbg-danger'));
    actions.replaceChildren(...kids);
    const d = dirty(n);
    const inFile = !!saved(n);
    const nothing = !d;
    saveRow.replaceChildren(
      btn(d ? 'Save shader' : 'Saved', save, nothing ? 'bb-off' : 'bb-dbg-go'),
      h('span', { class: 'bb-dbg-note' }, d ? (table()[n] ? 'Writes this shader to _shaders.js: every room uses it from then on.' : 'Takes your change back out of _shaders.js.') : inFile ? 'This is what _shaders.js has.' : 'Nothing to save.'));
  }

  function showErrors(r) {
    errEl.replaceChildren(...(r.ok ? [] : r.errors.map((e) => h('button', { type: 'button', class: 'bb-sh-err', onclick: () => goto(e.line) }, `line ${e.line}: ${e.text}`))));
  }

  /** Put the cursor at the start of a line of the code. */
  function goto(line) {
    const lines = code.value.split('\n');
    let at = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) at += lines[i].length + 1;
    code.focus();
    code.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
  }

  /** Load the selected shader into the editor and the preview. */
  function load() {
    const n = st.sel;
    st.text = codeOf(n);
    st.type = typeOf(n);
    code.value = st.text;
    typeSel.value = st.type;
    showErrors({ ok: true, errors: [] });
    fillPick();
    renderActions();
    preview?.update({ code: st.text, type: st.type });
    api.showProblems(probEl);
  }

  // ── editing ──
  /** The code or the type changed: check it; when it compiles, it goes into the draft (the preview and the local game follow). */
  function apply() {
    clearTimeout(timer);
    timer = 0;
    const n = st.sel;
    const r = view.debugCheckShader(st.text, st.type);
    showErrors(r);
    if (!r.ok) return; // (the draft keeps the last version that compiled)
    const same = isBuiltin(n) && st.text === view.debugShaderBody(n) && st.type === baseType(n);
    if (same) delete table()[n];
    else table()[n] = { ...(st.type !== baseType(n) ? { type: st.type } : {}), code: st.text };
    preview?.update({ code: st.text, type: st.type });
    api.touch('shaderCode');
    fillPick();
    renderActions();
  }

  code.addEventListener('input', () => {
    st.text = code.value;
    clearTimeout(timer);
    timer = setTimeout(apply, 300);
  });
  code.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const a = code.selectionStart;
    code.setRangeText('  ', a, code.selectionEnd, 'end');
    st.text = code.value;
    clearTimeout(timer);
    timer = setTimeout(apply, 300);
  });
  typeSel.addEventListener('change', () => { st.type = typeSel.value; apply(); });
  pick.addEventListener('change', () => { clearTimeout(timer); timer = 0; st.sel = pick.value; load(); });

  function askName(text, suggestion) {
    const raw = window.prompt(text, suggestion);
    if (raw === null) return null;
    const name = raw.trim();
    if (!KEY.test(name)) { window.alert('A shader name starts with a letter and uses letters, digits, _ and - only (40 characters at most).'); return null; }
    if (allNames().includes(name)) { window.alert(`There is a shader called "${name}" already.`); return null; }
    return name;
  }
  function copy() {
    const name = askName(`Name of the copy of "${st.sel}":`, `${st.sel}_copy`);
    if (!name) return;
    table()[name] = { ...(st.type !== 'opaque' ? { type: st.type } : {}), code: st.text };
    st.sel = name;
    api.touch('shaderCode');
    load();
  }
  function create() {
    const name = askName('Name of the new shader:', 'myshader');
    if (!name) return;
    table()[name] = { code: BLANK };
    st.sel = name;
    api.touch('shaderCode');
    load();
  }
  function reset() {
    if (!table()[st.sel]) return;
    delete table()[st.sel];
    api.touch('shaderCode');
    load();
  }
  /** Where a shader name is used (materials, bowls, models, backgrounds): the names of those tables. */
  function usedIn(name) {
    const d = D();
    const hit = (t) => JSON.stringify(t ?? {}).includes(`"${name}"`);
    return ['materials', 'bowls', 'models', 'backgrounds'].filter((t) => hit(d[t]));
  }
  function remove() {
    const where = usedIn(st.sel);
    if (!window.confirm(`Delete the shader "${st.sel}"?${where.length ? `\nIt is used in: ${where.join(', ')}. Pick another shader there afterwards.` : ''}`)) return;
    delete table()[st.sel];
    st.sel = allNames()[0];
    api.touch('shaderCode');
    load();
  }

  function save() {
    const n = st.sel;
    if (!dirty(n)) return;
    clearTimeout(timer);
    if (timer) apply();
    const entry = table()[n];
    const r = view.debugCheckShader(st.text, st.type);
    if (entry && !r.ok) { showErrors(r); window.alert('The shader does not compile: fix it first.'); return; }
    api.confirmDialog({
      title: entry ? 'Save shader' : 'Remove shader from file',
      text: entry
        ? `Write the shader "${n}" to _shaders.js? Every room uses it from then on. This only adds or replaces this one shader.`
        : `Take "${n}" out of _shaders.js? ${isBuiltin(n) ? 'The original is used again.' : 'The shader is gone.'}`,
      label: entry ? 'Save shader' : 'Remove',
      run: () => api.saveItem(entry ? { kind: 'shader', op: 'update', key: n, value: { ...entry } } : { kind: 'shader', op: 'delete', key: n }),
      onDone: () => setTimeout(() => { if (st.open) { fillPick(); renderActions(); } }, 700), // (the room's new definitions arrive a moment after the file is written)
    });
  }

  return {
    el: root,
    show() {
      st.open = true;
      if (!allNames().includes(st.sel)) st.sel = allNames()[0];
      root.classList.add('bb-show');
      root.style.width = `${WIDTH}px`;
      view.debugDock(WIDTH);
      preview = view.debugShaderPreview(previewHost);
      load();
    },
    hide() {
      if (!st.open) return;
      st.open = false;
      clearTimeout(timer);
      timer = 0;
      preview?.dispose();
      preview = null;
      root.classList.remove('bb-show');
      view.debugDock(0);
    },
    changed(kind) {
      if (!st.open) return;
      api.showProblems(probEl);
      if (kind === 'all') { if (!allNames().includes(st.sel)) st.sel = allNames()[0]; load(); }
    },
    refresh() {
      if (st.open) load();
    },
    dispose() {
      this.hide();
      root.remove();
    },
  };
}

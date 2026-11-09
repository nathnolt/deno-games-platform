// CLIENT ONLY: the SHADERS menu of the debug menu (created by studio.js, loaded by debug.js, so only with DEBUG on).
//
// The GLSL of the game lives in BASE shaders (written by hand in _shaders.js). Here you make the shaders the game actually uses: pick a base shader, set its
// settings (the uniforms it declares with a default in a comment), give the result a name and a category. Every such PARAMETERISED shader is an entry
// { base, category, params } of _shaders.js, and it can be picked wherever a shader is chosen (materials, bowls, models, backgrounds, the water): the shader
// chooser shows them all on 3D balls, in their categories, next to the base shaders.
// Like everything in the debug menu the edits are only in your DRAFT. "Save shader" (after a confirmation) writes ONE shader to _shaders.js.

import { resolveShader } from './shared.js';
import { openShaderDialog, paramRows, shaderGroups } from './shader-ui.js';
import { h } from './ui.js';

const KEY = /^[A-Za-z][\w-]{0,39}$/;
const WIDTH = 520;
const DEFAULT_CATEGORY = 'My shaders';
const HELP = `A BASE shader is GLSL, written by hand in _shaders.js. This menu does not edit code: it makes parameterised shaders from them.
  1. New... pick a base shader, give the new shader a name.
  2. Change its settings (every uniform the base shader declares with a default in a comment, like  uniform float uGlitter; // 1.0 [0, 3]  is a setting).
  3. Give it a category (the shader chooser groups the shaders by it), and press Save shader to write it to _shaders.js.
Then pick it in the Materials, Bowls, Models and Backgrounds tabs. A water block (base shader "waterBlock") shows the water of the background: its settings
(and the opacity) replace the ones of that water for the block only.`;

/**
 * @param view  the BalanceView
 * @param api   { draft(), touch(kind, quiet?, live?), saveItem(request), problems(), showProblems(el), close(), confirmDialog(options) } (see studio.js / debug.js)
 */
export function shaderStudio(view, api) {
  const st = { open: false, sel: '' };
  let preview = null;

  const D = () => api.draft();
  const table = () => (D().shaderCode ??= {});
  const finals = () => Object.keys(table()).filter((n) => table()[n] && typeof table()[n].code !== 'string');
  const saved = (n) => view.debugRoomDefs()?.shaderCode?.[n] ?? null; // (what _shaders.js has: the room's version)
  const dirty = (n) => JSON.stringify(table()[n] ?? null) !== JSON.stringify(saved(n));
  const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, onclick: fn }, text);
  const field = (label, ...controls) => h('label', { class: 'bb-dbg-field' }, h('span', { class: 'bb-dbg-lab' }, label), h('span', { class: 'bb-dbg-ctl bb-wp-row' }, ...controls));

  const probEl = h('span', { class: 'bb-st-prob' });
  const head = h('div', { class: 'bb-st-head' }, h('strong', {}, 'Shaders'), probEl, h('span', { class: 'bb-dbg-grow' }), btn('Close', () => api.close()));
  const pick = h('select', { class: 'bb-sh-pick' });
  const actions = h('div', { class: 'bb-dbg-row' });
  const infoEl = h('div', { class: 'bb-dbg-note' });
  const editor = h('div', { class: 'bb-st-body-in' });
  const previewHost = h('div', { class: 'bb-sh-preview' });
  const rowsEl = h('div', { class: 'bb-dbg-sec' });
  const saveRow = h('div', { class: 'bb-dbg-row' });
  const body = h('div', { class: 'bb-st-body bb-sh-body' },
    h('div', { class: 'bb-dbg-row' }, pick), actions, infoEl, editor, previewHost, rowsEl, saveRow,
    h('details', { class: 'bb-sh-help' }, h('summary', {}, 'How does this work?'), h('pre', {}, HELP)));
  const root = h('div', { class: 'bb-st bb-st-dock' }, head, body);

  /** What the preview shows for the selected shader: the base shader's code with the settings. */
  const entryOf = (n) => { const r = resolveShader(n, table()); return r ? { ...r, name: n } : null; };

  // ── what is shown ──
  function fillPick() {
    const names = finals();
    const cats = new Map();
    for (const n of names) {
      const c = table()[n].category ?? 'Other';
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c).push(n);
    }
    const mark = (n) => `${n}${dirty(n) ? ' •' : ''}`;
    pick.replaceChildren(...[...cats.keys()].sort().map((c) => h('optgroup', { label: c }, cats.get(c).sort().map((n) => h('option', { value: n }, mark(n))))));
    if (!names.length) pick.replaceChildren(h('option', { value: '' }, '(no parameterised shaders yet)'));
    pick.value = st.sel;
  }

  function renderActions() {
    const n = st.sel;
    actions.replaceChildren(btn('New…', create, 'bb-dbg-go'), btn('Copy…', copy, n ? '' : 'bb-off'), btn('Delete', remove, n ? 'bb-dbg-danger' : 'bb-off'));
    if (!n) { saveRow.replaceChildren(); return; }
    const d = dirty(n);
    const inFile = !!saved(n);
    saveRow.replaceChildren(
      btn(d ? 'Save shader' : 'Saved', save, d ? 'bb-dbg-go' : 'bb-off'),
      h('span', { class: 'bb-dbg-note' }, d ? (table()[n] ? 'Writes this shader to _shaders.js: every room uses it from then on.' : 'Takes your change back out of _shaders.js.') : inFile ? 'This is what _shaders.js has.' : 'Nothing to save.'));
  }

  /** The settings of a shader: its own uniforms; for a water block also the opacity and the settings of the water of the background. */
  function paramList(base) {
    if (base !== 'waterBlock') return view.debugShaderParams(base, table());
    const water = view.debugWaterShaderName;
    infoEl.textContent = water
      ? `A water block shows the water shader of the background ("${water}"). The settings here replace the ones of the background for this block only.`
      : 'The background uses the classic water, so the block keeps its own look. Pick a water shader in the Backgrounds tab to use it here.';
    return [{ name: 'uBlockOpacity', type: 'float', color: false, def: [0.85], min: 0, max: 1 }, ...(water ? view.debugShaderParams(water, table()) : [])];
  }

  /** The editor of the selected shader: category, base shader, settings. */
  function load() {
    const n = st.sel;
    const e = table()[n];
    infoEl.textContent = '';
    fillPick();
    renderActions();
    api.showProblems(probEl);
    if (!n || !e) {
      editor.replaceChildren(h('p', { class: 'bb-dbg-note' }, 'Press New… to make a shader from a base shader.'));
      rowsEl.replaceChildren();
      preview?.update({ name: '', code: 'void main() { gl_FragColor = vec4(0.5, 0.5, 0.5, 1.0); }', type: 'opaque', params: {} });
      return;
    }
    const cats = [...new Set(finals().map((x) => table()[x].category).filter(Boolean))];
    const catIn = h('input', { type: 'text', value: e.category ?? '', list: 'bb-sh-cats', placeholder: DEFAULT_CATEGORY, maxlength: 40 });
    catIn.addEventListener('change', () => { const v = catIn.value.trim(); if (v) e.category = v.slice(0, 40); else delete e.category; api.touch('shaderCode'); fillPick(); renderActions(); });
    const baseBtn = btn(`${e.base} ▾`, () => openShaderDialog({
      view, table, only: 'base', value: e.base, title: 'Choose the base shader',
      onPick: (b) => {
        if (!b || b === e.base) return;
        if (!resolveShader(b, table())) return;
        e.base = b;
        delete e.params;
        api.touch('shaderCode');
        load();
      },
    }));
    editor.replaceChildren(
      h('datalist', { id: 'bb-sh-cats' }, [...new Set([...cats, DEFAULT_CATEGORY])].map((c) => h('option', { value: c }))),
      field('category', catIn),
      field('base shader', baseBtn),
    );
    const base = resolveShader(e.base, table());
    if (!base) { rowsEl.replaceChildren(h('div', { class: 'bb-dbg-err' }, `The base shader "${e.base}" does not exist.`)); return; }
    const list = paramList(e.base);
    const params = (e.params ??= {});
    const prune = () => { if (!Object.keys(params).length) delete e.params; };
    const refresh = () => preview?.update(entryOf(n));
    rowsEl.replaceChildren(...(list.length
      ? paramRows({
        h, view, list, params,
        live: () => { api.touch('shaderCode', true, true); view.debugLiveBlocks(D()); refresh(); },
        commit: () => { prune(); api.touch('shaderCode'); fillPick(); renderActions(); },
        reset: () => { prune(); api.touch('shaderCode'); view.debugLiveBlocks(D()); load(); },
      })
      : [h('p', { class: 'bb-dbg-note' }, `The base shader "${e.base}" has no settings. A uniform with a default in a comment, like  uniform float uGlitter; // 1.0 [0, 3]  becomes one (in _shaders.js).`)]));
    if (list.length) rowsEl.prepend(btn('Reset all settings', () => { delete e.params; api.touch('shaderCode'); view.debugLiveBlocks(D()); load(); }));
    refresh();
  }

  // ── making and removing ──
  function askName(text, suggestion) {
    const raw = window.prompt(text, suggestion);
    if (raw === null) return null;
    const name = raw.trim();
    if (!KEY.test(name)) { window.alert('A shader name starts with a letter and uses letters, digits, _ and - only (40 characters at most).'); return null; }
    if (name in table()) { window.alert(`There is a shader called "${name}" already (base shaders count too).`); return null; }
    return name;
  }
  function create() {
    openShaderDialog({
      view, table, only: 'base', value: table()[st.sel]?.base ?? '', title: 'New shader: choose its base shader',
      onPick: (base) => {
        if (!base) return;
        const name = askName(`Name of the new shader (a version of "${base}"):`, `${base}_1`);
        if (!name) return;
        table()[name] = { base, category: table()[st.sel]?.category ?? DEFAULT_CATEGORY };
        st.sel = name;
        api.touch('shaderCode');
        load();
      },
    });
  }
  function copy() {
    const e = table()[st.sel];
    if (!e) return;
    const name = askName(`Name of the copy of "${st.sel}":`, `${st.sel}_copy`);
    if (!name) return;
    table()[name] = JSON.parse(JSON.stringify(e));
    st.sel = name;
    api.touch('shaderCode');
    load();
  }
  /** Where a shader name is used (materials, bowls, models, backgrounds, other shaders): the names of those tables. */
  function usedIn(name) {
    const d = D();
    const hit = (t) => JSON.stringify(t ?? {}).includes(`"${name}"`);
    return ['materials', 'bowls', 'models', 'backgrounds'].filter((t) => hit(d[t]));
  }
  function remove() {
    const where = usedIn(st.sel);
    if (!window.confirm(`Delete the shader "${st.sel}"?${where.length ? `\nIt is used in: ${where.join(', ')}. Pick another shader there afterwards.` : ''}`)) return;
    delete table()[st.sel];
    st.sel = finals()[0] ?? '';
    api.touch('shaderCode');
    load();
  }

  function save() {
    const n = st.sel;
    if (!n || !dirty(n)) return;
    const entry = table()[n];
    api.confirmDialog({
      title: entry ? 'Save shader' : 'Remove shader from file',
      text: entry
        ? `Write the shader "${n}" to _shaders.js? Every room uses it from then on. This only adds or replaces this one shader.`
        : `Take "${n}" out of _shaders.js? The shader is gone.`,
      label: entry ? 'Save shader' : 'Remove',
      run: () => api.saveItem(entry ? { kind: 'shader', op: 'update', key: n, value: JSON.parse(JSON.stringify(entry)) } : { kind: 'shader', op: 'delete', key: n }),
      onDone: () => setTimeout(() => { if (st.open) { fillPick(); renderActions(); } }, 700), // (the room's new definitions arrive a moment after the file is written)
    });
  }

  pick.addEventListener('change', () => { st.sel = pick.value; load(); });

  return {
    el: root,
    show() {
      st.open = true;
      if (!finals().includes(st.sel)) st.sel = finals()[0] ?? '';
      root.classList.add('bb-show');
      root.style.width = `${WIDTH}px`;
      view.debugDock(WIDTH);
      preview = view.debugShaderPreview(previewHost);
      load();
    },
    hide() {
      if (!st.open) return;
      st.open = false;
      preview?.dispose();
      preview = null;
      root.classList.remove('bb-show');
      view.debugDock(0);
    },
    changed(kind) {
      if (!st.open) return;
      api.showProblems(probEl);
      if (kind === 'all') { if (!finals().includes(st.sel)) st.sel = finals()[0] ?? ''; load(); }
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


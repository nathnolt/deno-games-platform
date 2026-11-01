// CLIENT ONLY: the debug menu. It is only loaded when DEBUG is true in shared.js (client.js imports it on demand).
//
// Open it with the ` key or the button at the bottom left. Tabs:
//   Settings     every number in `tuning`
//   Levels       edit / add / copy / delete / reorder levels, their start blocks and the blocks to place, bowl and background; Play
//   Shapes       edit and add block shapes, with a drawing of the outline
//   Materials    friction, weight, shader
//   Bowls        the bowl maker (flat bottom, corner radius, squareness, shader, water, optional model)
//   Models       the .obj models: file, shader per part
//   Backgrounds  ground, mist and the placed models
//   Export       download definitions.js, copy single tables, import JSON
//
// Two bigger tools open from the header (they live in studio.js):
//   Shape studio  every shape side by side at one scale next to the bowl, corner editing, and a 3D preview as it looks in the game
//   Level studio  a blueprint of the level next to the running game, with a live test lab (spawn / grab blocks, freeze gravity, capture)
//
// How edits travel: you change a DRAFT copy of the definitions. When it is valid it is sent to the server (after a short pause),
// the server applies it and sends it back to every player, and each client redraws. So the server and every client always see
// the same definitions at the same moment. Changes that touch the physics (shapes, bowls, materials, tuning, levels) apply to the
// level that is running when it restarts (or switch on "auto-restart").
// Your draft is also kept in this browser (localStorage) so a reload does not lose it: "Discard saved edits" on the Export tab clears it.

import * as S from './shared.js';
import { createStudio } from './studio.js';
import { clone, h, NS, svg } from './ui.js';

const STORE = 'balance.debug.defs';
const PHYSICS = new Set(['tuning', 'materials', 'shapes', 'bowls', 'levels']);

const TUNING_HELP = {
  gravity: 'units / s². Applies at restart.',
  waterDensity: 'How hard the water pushes floating blocks up. Applies at restart.',
  settleTime: 'Seconds the tower must stand still after the last block to win.',
  settleSpeed: '"Still" = every block slower than this.',
  follow: 'How fast a held block chases the pointer.',
  depth: 'Thickness of every block (z).',
  chamfer: 'Size of the 45° bevel on every block edge.',
  frontZ: 'z of the waiting blocks on the table.',
  hoverZ: 'z of the block you hold.',
  slotGap: 'Distance between the waiting blocks.',
  maxHoldX: 'How far sideways a held block may go.',
  maxHoldY: 'How high a held block may go.',
  minHoldY: 'How low a held block may go.',
  zone: 'Default sideways limits: a block whose centre leaves it loses the level.',
  drop: 'Default drop zone: let go inside it and the block falls into the bowl.',
  view: 'What the camera must always show.',
  camera: 'fov = vertical field of view, pitch = degrees looking down, targetY = height it looks at.',
};

const KEY = /^[A-Za-z][\w-]*$/;

export function createDebugMenu(view) {
  let draft = S.cloneDefinitions();
  const state = {
    tab: 'settings', open: false, sel: {}, freeCam: false, showDrop: false, autoRestart: false,
    needsRestart: false, problems: [], restored: false, base: null, staleDropped: false,
    fxShadows: true, fxReflection: true, fxBlur: true,
  };
  let timer = 0;
  let infoToken = 0;
  let modelPrev = null; // the preview window of the Models tab
  const shaderNames = () => view.shaderNames;
  const keys = (table) => Object.keys(draft[table]);
  const pick = (name, list) => {
    if (!list.includes(state.sel[name])) state.sel[name] = list[0];
    return state.sel[name];
  };

  // ── draft -> server ──────────────────────────────────────────────────────────────────────────────────────
  function validate() {
    state.problems = S.validateDefinitions(draft, { shaderNames: shaderNames() });
    renderStatus();
    return state.problems.length === 0;
  }

  /** Something in the draft changed. `kind` is the table. */
  function touch(kind) {
    if (PHYSICS.has(kind)) state.needsRestart = true;
    clearTimeout(timer);
    if (validate()) timer = setTimeout(send, 300);
    if (kind === 'models' && modelPrev) modelPrev.set(draft.models[state.sel.model] ?? {});
    studio.changed(kind); // an open studio redraws (the const is defined further down; touch() is only called after the menu exists)
  }

  // The platform drops inbound messages over 4096 characters and the full definitions are far bigger, so they travel as
  // small pieces of JSON text (1500 characters stays under the limit even when quotes get escaped) that the server glues back together.
  let sendId = 0;
  function sendDefs(defs) {
    const text = JSON.stringify(defs);
    const id = ++sendId;
    const n = Math.ceil(text.length / 1500);
    for (let i = 0; i < n; i++) view.ctx.sendInput({ debugChunk: { id, i, n, s: text.slice(i * 1500, (i + 1) * 1500) } });
  }

  function send() {
    clearTimeout(timer);
    timer = 0;
    if (!validate()) return;
    sendDefs(draft);
    try {
      if (state.base !== null) { // (kept together with a fingerprint of the definitions.js it was made from: see the restore at the bottom)
        localStorage.setItem(STORE, JSON.stringify({ base: state.base, draft }));
        state.restored = true;
      }
    } catch { /* private mode */ }
    if (state.autoRestart && !studio.current && state.needsRestart && view.snap && view.snap.ph !== S.PHASE.MENU) view.ctx.sendInput({ restart: true });
    renderStatus();
  }

  /** Send anything that is waiting, so a following command (play, restart) is handled with the new definitions. */
  function flush() {
    if (timer) send();
  }

  // ── small widgets ────────────────────────────────────────────────────────────────────────────────────────
  const field = (text, ...controls) => h('label', { class: 'bb-dbg-field' }, h('span', { class: 'bb-dbg-lab' }, text), h('span', { class: 'bb-dbg-ctl' }, ...controls));
  const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, onclick: fn }, text);
  const section = (title, ...kids) => h('div', { class: 'bb-dbg-sec' }, title ? h('h4', {}, title) : null, ...kids);
  const note = (text) => h('p', { class: 'bb-dbg-note' }, text);
  const err = (text) => h('div', { class: 'bb-dbg-err' }, text);

  function num(text, obj, key, kind, o = {}) {
    const i = h('input', { type: 'number', step: o.step ?? 'any', min: o.min, max: o.max, value: obj[key] ?? '' });
    i.addEventListener('input', () => {
      if (i.value === '' && o.optional) {
        delete obj[key];
        touch(kind);
        return;
      }
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) return;
      obj[key] = o.int ? Math.round(v) : v;
      touch(kind);
    });
    return field(text, i);
  }
  function text(label, obj, key, kind, o = {}) {
    const i = h('input', { type: 'text', value: obj[key] ?? '', placeholder: o.placeholder });
    i.addEventListener('input', () => {
      if (i.value === '' && o.optional) delete obj[key];
      else obj[key] = i.value;
      touch(kind);
    });
    return field(label, i);
  }
  function check(label, obj, key, kind, then) {
    const i = h('input', { type: 'checkbox', checked: !!obj[key] });
    i.addEventListener('change', () => {
      if (i.checked) obj[key] = true;
      else delete obj[key];
      touch(kind);
      then?.();
    });
    return field(label, i);
  }
  /** options: ['a', 'b'] or [['value', 'label'], ...]. An option with value '' removes the key. */
  function select(label, options, obj, key, kind, then) {
    const s = h('select', {}, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v }, l); }));
    s.value = obj[key] ?? '';
    s.addEventListener('change', () => {
      if (s.value === '') delete obj[key];
      else obj[key] = s.value;
      touch(kind);
      then?.();
    });
    return field(label, s);
  }
  function color(label, obj, key, kind) {
    const v = /^#[0-9a-f]{6}$/i.test(obj[key] ?? '') ? obj[key] : '#888888';
    const i = h('input', { type: 'color', value: v });
    i.addEventListener('input', () => {
      obj[key] = i.value;
      touch(kind);
    });
    return field(label, i, h('code', {}, v));
  }
  function slider(label, obj, key, kind, min, max, step) {
    const r = h('input', { type: 'range', min, max, step, value: obj[key] });
    const n = h('input', { type: 'number', step, class: 'bb-dbg-n', value: obj[key] });
    const set = (v, from) => {
      if (!Number.isFinite(v)) return;
      obj[key] = v;
      if (from !== r) r.value = v;
      if (from !== n) n.value = v;
      touch(kind);
    };
    r.addEventListener('input', () => set(parseFloat(r.value), r));
    n.addEventListener('input', () => set(parseFloat(n.value), n));
    return field(label, r, n);
  }
  function vec(label, arr, kind, step = 1) {
    return field(label, ...arr.map((_, i) => {
      const n = h('input', { type: 'number', step, class: 'bb-dbg-n', value: arr[i] });
      n.addEventListener('input', () => {
        const v = parseFloat(n.value);
        if (!Number.isFinite(v)) return;
        arr[i] = v;
        touch(kind);
      });
      return n;
    }));
  }
  function ask(message, def = '') {
    const k = window.prompt(message, def);
    if (k === null) return null;
    return k.trim();
  }
  function newKey(table, message, def) {
    const k = ask(message, def);
    if (k === null) return null;
    if (!KEY.test(k)) { window.alert('Use letters, digits, - and _ (starting with a letter).'); return null; }
    if (draft[table][k]) { window.alert(`"${k}" already exists.`); return null; }
    return k;
  }

  // ── where things are used (so nothing is deleted that is still needed) ─────────────────────────────────────
  const usedBy = {
    shapes: (k) => draft.levels.filter((l) => l.initialBlocks.some((b) => b.shape === k) || l.shapes.some((b) => b.shape === k)).map((l) => `level "${l.name}"`),
    materials: (k) => draft.levels.filter((l) => l.initialBlocks.some((b) => b.material === k) || l.shapes.some((b) => b.material === k)).map((l) => `level "${l.name}"`),
    bowls: (k) => draft.levels.filter((l) => l.bowl === k).map((l) => `level "${l.name}"`),
    backgrounds: (k) => draft.levels.filter((l) => l.background === k).map((l) => `level "${l.name}"`),
    models: (k) => [
      ...Object.entries(draft.backgrounds).filter(([, b]) => (b.models ?? []).some((m) => m.model === k)).map(([n]) => `background "${n}"`),
      ...Object.entries(draft.bowls).filter(([, b]) => b.model?.model === k).map(([n]) => `bowl "${n}"`),
    ],
  };
  const renameRefs = {
    shapes: (a, b) => draft.levels.forEach((l) => [...l.initialBlocks, ...l.shapes].forEach((x) => { if (x.shape === a) x.shape = b; })),
    materials: (a, b) => draft.levels.forEach((l) => [...l.initialBlocks, ...l.shapes].forEach((x) => { if (x.material === a) x.material = b; })),
    bowls: (a, b) => draft.levels.forEach((l) => { if (l.bowl === a) l.bowl = b; }),
    backgrounds: (a, b) => draft.levels.forEach((l) => { if (l.background === a) l.background = b; }),
    models: (a, b) => {
      Object.values(draft.backgrounds).forEach((bg) => (bg.models ?? []).forEach((m) => { if (m.model === a) m.model = b; }));
      Object.values(draft.bowls).forEach((bw) => { if (bw.model?.model === a) bw.model.model = b; });
    },
  };

  /** Select + New / Copy / Rename / Delete for a table that is an object of named things. */
  function tableBar(table, name, singular, blank) {
    const list = keys(table);
    const current = pick(name, list);
    const s = h('select', { class: 'bb-dbg-grow' }, list.map((k) => h('option', { value: k }, k)));
    s.value = current;
    s.addEventListener('change', () => { state.sel[name] = s.value; render(); });
    const put = (k, v, after) => { // insert after the current one, keeping the order of the others
      const entries = Object.entries(draft[table]);
      const at = entries.findIndex(([x]) => x === after) + 1;
      entries.splice(at, 0, [k, v]);
      draft[table] = Object.fromEntries(entries);
      state.sel[name] = k;
      touch(table);
      render();
    };
    return h('div', { class: 'bb-dbg-row' }, s,
      btn('New', () => { const k = newKey(table, `Name of the new ${singular}:`, `${singular}${list.length + 1}`); if (k) put(k, blank(), current); }),
      btn('Copy', () => { const k = newKey(table, `Name of the copy:`, `${current}-copy`); if (k) put(k, clone(draft[table][current]), current); }),
      btn('Rename', () => {
        const k = newKey(table, `New name for "${current}":`, current + '2');
        if (!k) return;
        draft[table] = Object.fromEntries(Object.entries(draft[table]).map(([x, v]) => [x === current ? k : x, v]));
        renameRefs[table]?.(current, k);
        state.sel[name] = k;
        touch(table);
        render();
      }),
      btn('Delete', () => {
        if (list.length <= 1) return window.alert(`There must be at least one ${singular}.`);
        const used = usedBy[table]?.(current) ?? [];
        if (used.length) return window.alert(`"${current}" is still used by:\n${used.join('\n')}\n\nChange those first.`);
        if (!window.confirm(`Delete ${singular} "${current}"?`)) return;
        delete draft[table][current];
        touch(table);
        render();
      }, 'bb-dbg-danger'),
    );
  }

  // ── tabs ─────────────────────────────────────────────────────────────────────────────────────────────────
  const TABS = {
    settings: { label: 'Settings', render: tabSettings },
    levels: { label: 'Levels', render: tabLevels },
    shapes: { label: 'Shapes', render: tabShapes },
    materials: { label: 'Materials', render: tabMaterials },
    bowls: { label: 'Bowls', render: tabBowls },
    models: { label: 'Models', render: tabModels },
    backgrounds: { label: 'Backgrounds', render: tabBackgrounds },
    export: { label: 'Export', render: tabExport },
  };

  function tabSettings() {
    const t = draft.tuning;
    const out = [note('Everything in `tuning`. Physics numbers apply when the level restarts.')];
    const plain = h('div', {});
    for (const [k, v] of Object.entries(t)) {
      if (typeof v === 'number') plain.append(num(k, t, k, 'tuning'), h('p', { class: 'bb-dbg-hint' }, TUNING_HELP[k] ?? ''));
    }
    out.push(section('Numbers', plain));
    for (const [k, v] of Object.entries(t)) {
      if (typeof v !== 'object') continue;
      out.push(section(k, h('p', { class: 'bb-dbg-hint' }, TUNING_HELP[k] ?? ''), ...Object.keys(v).map((f) => num(f, v, f, 'tuning'))));
    }
    return out;
  }

  function tabLevels() {
    const L = draft.levels;
    const idx = Math.min(Math.max(0, state.sel.level ?? (view.snap?.lv >= 0 ? view.snap.lv : 0)), L.length - 1);
    state.sel.level = idx;
    const lv = L[idx];
    lv.initialBlocks ??= [];
    lv.shapes ??= [];
    const s = h('select', { class: 'bb-dbg-grow' }, L.map((l, i) => h('option', { value: i }, `${i + 1}. ${l.name}`)));
    s.value = idx;
    s.addEventListener('change', () => { state.sel.level = +s.value; render(); });
    const move = (d) => {
      const j = idx + d;
      if (j < 0 || j >= L.length) return;
      [L[idx], L[j]] = [L[j], L[idx]];
      state.sel.level = j;
      touch('levels');
      render();
    };
    const shapeOpts = keys('shapes');
    const matOpts = keys('materials');
    const out = [
      h('div', { class: 'bb-dbg-row' }, s,
        btn('New', () => {
          L.push({ name: `Level ${L.length + 1}`, difficulty: 'easy', bowl: keys('bowls')[0], background: keys('backgrounds')[0], initialBlocks: [], chooseShapes: 3, shapes: [{ shape: shapeOpts[0], material: matOpts[0] }] });
          state.sel.level = L.length - 1;
          touch('levels');
          render();
        }),
        btn('Copy', () => { L.splice(idx + 1, 0, { ...clone(lv), name: `${lv.name} copy` }); state.sel.level = idx + 1; touch('levels'); render(); }),
        btn('Delete', () => {
          if (L.length <= 1) return window.alert('There must be at least one level.');
          if (!window.confirm(`Delete level "${lv.name}"?`)) return;
          L.splice(idx, 1);
          touch('levels');
          render();
        }, 'bb-dbg-danger')),
      h('div', { class: 'bb-dbg-row' }, btn('↑ Earlier', () => move(-1)), btn('↓ Later', () => move(1)),
        btn('▶ Play this level', () => { flush(); view.ctx.sendInput({ start: idx }); }, 'bb-dbg-go')),
      section('Level',
        text('name', lv, 'name', 'levels'),
        select('difficulty', ['easy', 'medium', 'hard'], lv, 'difficulty', 'levels'),
        select('bowl', keys('bowls'), lv, 'bowl', 'levels'),
        select('background', keys('backgrounds'), lv, 'background', 'levels'),
        num('blocks on the table', lv, 'chooseShapes', 'levels', { int: true, min: 1 }),
        customRect(lv, 'zone', ['x0', 'x1'], 'own sideways limits'),
        customRect(lv, 'drop', ['x0', 'x1', 'y0', 'y1'], 'own drop zone'),
      ),
      section(`Start blocks (${lv.initialBlocks.length})`, note("Present from the start. 'static' material = fixed. x, y = centre, y = 0 is the water."),
        ...lv.initialBlocks.map((b, i) => blockRow(b, lv.initialBlocks, i, true)),
        btn('+ Add start block', () => { lv.initialBlocks.push({ shape: shapeOpts[0], material: matOpts[0], rot: 0, x: 0, y: 0 }); touch('levels'); render(); })),
      section(`Blocks to place (${lv.shapes.length})`, note('In this order. The first ones lie on the table.'),
        ...lv.shapes.map((b, i) => blockRow(b, lv.shapes, i, false)),
        btn('+ Add block', () => { lv.shapes.push({ shape: shapeOpts[0], material: matOpts[0] }); touch('levels'); render(); })),
    ];
    return out;
  }

  /** The checkbox + fields of an optional rectangle (zone / drop) of a level. */
  function customRect(lv, key, fields, label) {
    const box = h('div', {});
    const on = h('input', { type: 'checkbox', checked: !!lv[key] });
    on.addEventListener('change', () => {
      if (on.checked) lv[key] = { ...draft.tuning[key] };
      else delete lv[key];
      touch('levels');
      render();
    });
    box.append(field(label, on));
    if (lv[key]) fields.forEach((f) => box.append(num(`  ${f}`, lv[key], f, 'levels')));
    return box;
  }

  function blockRow(b, list, i, withPose) {
    const pick = (opts, key) => {
      const s = h('select', { class: 'bb-dbg-grow' }, opts.map((o) => h('option', { value: o }, o)));
      s.value = b[key];
      s.addEventListener('change', () => { b[key] = s.value; touch('levels'); });
      return s;
    };
    const n = (key) => {
      const x = h('input', { type: 'number', step: 'any', class: 'bb-dbg-n', value: b[key] ?? 0 });
      x.addEventListener('input', () => { const v = parseFloat(x.value); if (Number.isFinite(v)) { b[key] = v; touch('levels'); } });
      return h('label', { class: 'bb-dbg-mini' }, key, x);
    };
    const top = h('div', { class: 'bb-dbg-row' },
      h('span', { class: 'bb-dbg-idx' }, i + 1), pick(keys('shapes'), 'shape'), pick(keys('materials'), 'material'),
      ...(withPose ? [] : [
        btn('↑', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; touch('levels'); render(); } }),
        btn('↓', () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; touch('levels'); render(); } }),
      ]),
      btn('✕', () => { list.splice(i, 1); touch('levels'); render(); }, 'bb-dbg-danger'));
    return h('div', { class: 'bb-dbg-block' }, top, withPose ? h('div', { class: 'bb-dbg-row bb-dbg-pose' }, n('rot'), n('x'), n('y')) : null);
  }

  function tabShapes() {
    const out = [tableBar('shapes', 'shape', 'shape', () => [{ type: 'poly', points: '0,0 4,0 4,2 0,2' }])];
    const key = state.sel.shape;
    const def = draft.shapes[key];
    const previewHost = h('div', {});
    const redraw = () => previewHost.replaceChildren(shapePreview(def));
    redraw();
    out.push(previewHost);
    out.push(note('Polygons must be CONVEX (build other shapes from several parts). A "visual" polygon is only drawn: use it for the outline of a concave shape made of several parts, like plus1. Points are x,y pairs; the block is re-centred automatically.'));
    def.forEach((p, i) => {
      const box = h('div', { class: 'bb-dbg-part' });
      const head = h('div', { class: 'bb-dbg-row' },
        h('strong', { class: 'bb-dbg-grow' }, `Part ${i + 1}: ${p.type}`),
        btn('✕', () => { def.splice(i, 1); touch('shapes'); render(); }, 'bb-dbg-danger'));
      box.append(head);
      const onEdit = () => { touch('shapes'); redraw(); };
      if (p.type === 'circle') {
        for (const f of ['diameter', 'x', 'y']) {
          const i2 = h('input', { type: 'number', step: 'any', class: 'bb-dbg-n', placeholder: f === 'diameter' ? '' : 'auto', value: p[f] ?? '' });
          i2.addEventListener('input', () => {
            const v = parseFloat(i2.value);
            if (Number.isFinite(v)) p[f] = v;
            else if (f !== 'diameter') delete p[f];
            onEdit();
          });
          box.append(field(f, i2));
        }
      } else {
        const t = h('textarea', { rows: 2, spellcheck: 'false' }, p.points ?? '');
        t.addEventListener('input', () => { p.points = t.value; onEdit(); });
        box.append(t);
        const v = h('input', { type: 'checkbox', checked: !!p.visual });
        v.addEventListener('change', () => { if (v.checked) p.visual = true; else delete p.visual; onEdit(); });
        box.append(field('visual only', v));
      }
      out.push(box);
    });
    out.push(h('div', { class: 'bb-dbg-row' },
      btn('+ Polygon', () => { def.push({ type: 'poly', points: '0,0 2,0 2,2 0,2' }); touch('shapes'); render(); }),
      btn('+ Circle', () => { def.push({ type: 'circle', diameter: 2 }); touch('shapes'); render(); })));
    return out;
  }

  /** A drawing of a shape: blue = physics parts, dashed orange = visual outline, grid = 1 unit, axes through the centre. */
  function shapePreview(def) {
    let sh;
    try {
      sh = S.buildShape(def, '?');
    } catch (e) {
      return err(String(e.message));
    }
    const pad = 1;
    const w = sh.w + pad * 2;
    const hh = sh.h + pad * 2;
    const g = svg('g', { transform: 'scale(1,-1)' }); // y up
    for (let x = Math.ceil(-w / 2); x <= w / 2; x++) g.append(svg('line', { x1: x, y1: -hh / 2, x2: x, y2: hh / 2, stroke: x === 0 ? '#64748b' : '#2b354f', 'stroke-width': x === 0 ? 0.05 : 0.025 }));
    for (let y = Math.ceil(-hh / 2); y <= hh / 2; y++) g.append(svg('line', { x1: -w / 2, y1: y, x2: w / 2, y2: y, stroke: y === 0 ? '#64748b' : '#2b354f', 'stroke-width': y === 0 ? 0.05 : 0.025 }));
    for (const p of sh.parts) {
      const style = { fill: 'rgba(99,179,237,.35)', stroke: '#7dd3fc', 'stroke-width': 0.06 };
      g.append(p.type === 'circle' ? svg('circle', { cx: p.cx, cy: p.cy, r: p.r, ...style }) : svg('polygon', { points: p.pts.map((q) => q.join(',')).join(' '), ...style }));
    }
    for (const p of sh.visual ?? []) g.append(svg('polygon', { points: p.pts.map((q) => q.join(',')).join(' '), fill: 'none', stroke: '#fbbf24', 'stroke-width': 0.07, 'stroke-dasharray': '0.25 0.15' }));
    const root = svg('svg', { viewBox: `${-w / 2} ${-hh / 2} ${w} ${hh}`, class: 'bb-dbg-svg' }, g);
    return h('div', { class: 'bb-dbg-preview' }, root, h('div', { class: 'bb-dbg-hint' }, `${sh.w.toFixed(2)} × ${sh.h.toFixed(2)} units`));
  }

  function tabMaterials() {
    const out = [tableBar('materials', 'material', 'material', () => ({ friction: 10, weight: 10, shader: 'wood' }))];
    const m = draft.materials[state.sel.material];
    if (m.float) m.floatLevel ??= 0.5;
    out.push(
      section(null,
        slider('friction', m, 'friction', 'materials', 0, 20, 0.5),
        slider('weight', m, 'weight', 'materials', 0, 40, 0.5),
        check('static (never moves)', m, 'static', 'materials'),
        check('float (buoyant)', m, 'float', 'materials', () => render()),
        m.float ? slider('float level (part under water)', m, 'floatLevel', 'materials', 0.1, 1, 0.05) : null,
        num('stack limit (breaks above this many)', m, 'stackLimit', 'materials', { min: 0, max: 20, int: true, optional: true }),
        select('shader', shaderNames(), m, 'shader', 'materials'),
        note(`friction coefficient ${((m.friction ?? 10) / 20).toFixed(2)} · density ${((m.weight ?? 10) / 10).toFixed(2)} (water = 1)`)),
      note('Block shaders (wood, glass, stone1, stone2, float) use the face of the block; 3D shaders (wood2, ceramic, bark ...) work everywhere.'),
    );
    return out;
  }

  function tabBowls() {
    const out = [tableBar('bowls', 'bowl', 'bowl', () => clone(draft.bowls[keys('bowls')[0]]))];
    const key = state.sel.bowl;
    const b = draft.bowls[key];
    b.water ??= { color: '#3d9bff', opacity: 0.4 };
    b.water.reflect ??= 0.6;
    const flat = Math.max(0, 2 * (b.a - b.r));
    out.push(
      btn('Use this bowl in the current level', () => {
        const lv = draft.levels[view.snap?.lv ?? -1];
        if (!lv) return window.alert('Start a level first.');
        lv.bowl = key;
        touch('levels');
        render();
      }),
      section('Shape (side view)',
        slider('a: half width at the rim', b, 'a', 'bowls', 6, 40, 0.5),
        slider('b: depth of the inside', b, 'b', 'bowls', 2, 20, 0.5),
        slider('t: wall thickness', b, 't', 'bowls', 0.2, 3, 0.1),
        slider('r: corner radius', b, 'r', 'bowls', 0.2, Math.max(1, b.a), 0.1),
        slider('rimY: height of the rim', b, 'rimY', 'bowls', -2, 5, 0.1),
        note(`flat bottom ${flat.toFixed(1)} wide · inside floor at y = ${(b.rimY - b.b).toFixed(1)} · table top at y = ${(b.rimY - b.b - b.t).toFixed(1)}. Small r = flat bottom, big r = round bowl. Static blocks (pillars) must reach down to the inside floor.`)),
      section('Shape (seen from above)',
        slider('zscale: squeeze along z', b, 'zscale', 'bowls', 0.3, 1.5, 0.05),
        slider('square at the rim', b, 'square', 'bowls', 2, 10, 0.1),
        slider('square at the bottom', b, 'squareBottom', 'bowls', 2, 10, 0.1),
        note('2 = round, 5 = rounded square, higher = boxier.')),
      section('Look',
        select('shader', shaderNames(), b, 'shader', 'bowls'),
        color('water colour', b.water, 'color', 'bowls'),
        slider('water opacity', b.water, 'opacity', 'bowls', 0, 1, 0.05),
        slider('water reflection', b.water, 'reflect', 'bowls', 0, 1, 0.05)),
      section('Model instead of the generated bowl (optional)', modelPicker(b)),
    );
    return out;
  }

  /** model / scale / rotation / translate for the optional model of a bowl. */
  function modelPicker(b) {
    const box = h('div', {});
    const s = h('select', {}, [h('option', { value: '' }, '(none: generated bowl)'), ...keys('models').map((k) => h('option', { value: k }, k))]);
    s.value = b.model?.model ?? '';
    s.addEventListener('change', () => {
      if (s.value === '') delete b.model;
      else b.model = { model: s.value, scale: b.model?.scale ?? 1, rotation: b.model?.rotation ?? [0, 0, 0], translate: b.model?.translate ?? [0, 0, 0] };
      touch('bowls');
      render();
    });
    box.append(field('model', s));
    if (b.model) box.append(num('scale', b.model, 'scale', 'bowls'), vec('rotation °', b.model.rotation, 'bowls', 5), vec('translate', b.model.translate, 'bowls', 0.5), note('The physics still uses the numbers above: make the model the same size.'));
    return box;
  }

  function tabModels() {
    const out = [tableBar('models', 'model', 'model', () => ({ file: 'rock.obj', shader: 'stone1' }))];
    const key = state.sel.model;
    const m = draft.models[key];
    const list = h('div', {}, 'loading…');
    const token = ++infoToken;
    const load = () => view.debugModelInfo(m.file).then((parts) => {
      if (token !== infoToken) return;
      list.replaceChildren(...parts.map((p) => {
        const s = h('select', {}, [h('option', { value: '' }, `(default: ${m.shader ?? 'stone1'})`), ...shaderNames().map((n) => h('option', { value: n }, n))]);
        s.value = m.shaders?.[p.name] ?? '';
        s.addEventListener('change', () => {
          m.shaders ??= {};
          if (s.value) m.shaders[p.name] = s.value;
          else delete m.shaders[p.name];
          if (!Object.keys(m.shaders).length) delete m.shaders;
          touch('models');
        });
        return field(`${p.name} (${p.triangles} tri)`, s);
      }));
      if (!parts.length) list.replaceChildren(err('The file has no faces.'));
    }).catch((e) => { if (token === infoToken) list.replaceChildren(err(`Cannot load ${m.file}: ${e.message}`)); });
    load();
    // a little window with the model, as the game draws it (turns slowly; drag to turn, wheel to zoom)
    const canvas = h('canvas', { class: 'bb-st-canvas' });
    const prevBox = h('div', { class: 'bb-dbg-modelprev' }, canvas);
    modelPrev?.dispose();
    modelPrev = null;
    try {
      modelPrev = view.debugModelPreview(canvas);
      modelPrev.set(m);
    } catch (e) { prevBox.append(h('div', { class: 'bb-dbg-err' }, String(e.message ?? e))); }
    out.push(
      section('Preview', prevBox),
      section(null,
        text('file in ./models', m, 'file', 'models'),
        select('default shader', [['', '(stone1)'], ...shaderNames()], m, 'shader', 'models'),
        check('smooth (use normals of the file)', m, 'smooth', 'models'),
        h('div', { class: 'bb-dbg-row' }, btn('Reload the file', () => view.debugReloadModels()), btn('Show this part list again', () => render()))),
      section('Parts and their shaders', note('A part is a `usemtl` name (or the `o` / `g` name when there is none) in the .obj file.'), list),
      btn('+ Put this model in the current background', () => {
        const lv = draft.levels[view.snap?.lv ?? -1];
        const bgKey = lv?.background ?? state.sel.background ?? keys('backgrounds')[0];
        (draft.backgrounds[bgKey].models ??= []).push({ model: key, scale: 1, rotation: [0, 0, 0], translate: [0, 0, -40] });
        state.sel.background = bgKey;
        touch('backgrounds');
        state.tab = 'backgrounds';
        render();
      }),
    );
    return out;
  }

  function tabBackgrounds() {
    const out = [tableBar('backgrounds', 'background', 'background', () => ({ mist: '#e7e2d6', fog: [150, 520], ground: { colorA: '#cdc3a8', colorB: '#e6dec9', ripple: 2.2 }, models: [] }))];
    const key = state.sel.background;
    const bg = draft.backgrounds[key];
    bg.ground ??= { colorA: '#cdc3a8', colorB: '#e6dec9', ripple: 2.2 };
    bg.fog ??= [150, 520];
    bg.models ??= [];
    bg.blur ??= 3;
    bg.light ??= { dir: [-0.45, 0.85, 0.55], shadow: 0.4 };
    bg.light.dir ??= [-0.45, 0.85, 0.55];
    bg.light.shadow ??= 0.4;
    bg.ground.style ??= 'sand';
    bg.bowlHeight ??= 4;
    bg.box ??= { w: 110, d: 52, z: 2, shader: 'floorwood' };
    out.push(
      btn('Use this background in the current level', () => {
        const lv = draft.levels[view.snap?.lv ?? -1];
        if (!lv) return window.alert('Start a level first.');
        lv.background = key;
        touch('levels');
        render();
      }),
      note('Positions are in world units relative to the middle of the table: x = right, z = towards the camera (negative = behind the table), y = 0 is the floor. Tick "Free camera" at the top to fly around while you place things.'),
      section('Sky and ground',
        color('mist (sky, distance)', bg, 'mist', 'backgrounds'),
        field('fog near / far', ...[0, 1].map((i) => {
          const n = h('input', { type: 'number', step: 10, class: 'bb-dbg-n', value: bg.fog[i] });
          n.addEventListener('input', () => { const v = parseFloat(n.value); if (Number.isFinite(v)) { bg.fog[i] = v; touch('backgrounds'); } });
          return n;
        })),
        color('sand grooves', bg.ground, 'colorA', 'backgrounds'),
        color('sand ridges', bg.ground, 'colorB', 'backgrounds'),
        slider('rake spacing', bg.ground, 'ripple', 'backgrounds', 0.3, 6, 0.1),
        select('floor', [['sand', 'raked sand'], ['wood', 'wooden planks']], bg.ground, 'style', 'backgrounds'),
        num('bowl height above the floor', bg, 'bowlHeight', 'backgrounds', { min: 0, max: 100 }),
        num('table width (x)', bg.box, 'w', 'backgrounds', { min: 10, max: 1000 }),
        num('table depth (z)', bg.box, 'd', 'backgrounds', { min: 10, max: 1000 }),
        num('table centre z', bg.box, 'z', 'backgrounds'),
        select('table shader', shaderNames(), bg.box, 'shader', 'backgrounds'),
        slider('background blur (px)', bg, 'blur', 'backgrounds', 0, 12, 0.5),
        slider('shadow darkness', bg.light, 'shadow', 'backgrounds', 0, 1, 0.05),
        vec('light direction', bg.light.dir, 'backgrounds', 0.1)),
      section(`Models (${bg.models.length})`,
        ...bg.models.map((m, i) => h('div', { class: 'bb-dbg-part' },
          h('div', { class: 'bb-dbg-row' },
            h('select', { class: 'bb-dbg-grow', value: m.model, onchange: (e) => { m.model = e.target.value; touch('backgrounds'); } }, keys('models').map((k) => h('option', { value: k, selected: k === m.model }, k))),
            btn('Copy', () => { bg.models.splice(i + 1, 0, clone(m)); touch('backgrounds'); render(); }),
            btn('✕', () => { bg.models.splice(i, 1); touch('backgrounds'); render(); }, 'bb-dbg-danger')),
          num('scale', m, 'scale', 'backgrounds'),
          vec('rotation °', m.rotation, 'backgrounds', 5),
          vec('translate', m.translate, 'backgrounds', 1))),
        btn('+ Add model', () => { bg.models.push({ model: keys('models')[0], scale: 1, rotation: [0, 0, 0], translate: [0, 0, -40] }); touch('backgrounds'); render(); })),
    );
    return out;
  }

  function tabExport() {
    const out = [];
    const copy = (label, textFn) => btn(label, (e) => {
      const b = e.currentTarget;
      const done = () => { const old = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = old), 1200); };
      const t = textFn();
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
      else fallbackCopy(t, done);
    });
    const save = (label, name, textFn, mime = 'text/javascript') => btn(label, () => {
      const url = URL.createObjectURL(new Blob([textFn()], { type: mime }));
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    out.push(
      state.problems.length ? err('The definitions have problems (see the red box). They are exported anyway.') : null,
      section('Whole file', note('Replace games/balance/definitions.js with this. (Comments in the file are not kept.)'),
        h('div', { class: 'bb-dbg-row' }, save('Download definitions.js', 'definitions.js', () => S.serializeDefinitions(draft)), copy('Copy', () => S.serializeDefinitions(draft)))),
      section('One table at a time', note('Paste into definitions.js over the same `export const ...`.'),
        ...S.DEFINITION_TABLES.map((t) => h('div', { class: 'bb-dbg-row' }, h('span', { class: 'bb-dbg-grow' }, t),
          copy('Copy', () => S.serializeTable(t, draft[t])), save('Download', `${t}.js`, () => S.serializeTable(t, draft[t]))))),
    );
    const ta = h('textarea', { rows: 6, spellcheck: 'false', placeholder: 'Paste JSON here: a whole set of definitions, or only some tables (e.g. {"levels": [...]})' });
    const msg = h('div', {});
    out.push(
      section('JSON', h('div', { class: 'bb-dbg-row' }, copy('Copy all as JSON', () => JSON.stringify(draft, null, 1)), save('Download JSON', 'definitions.json', () => JSON.stringify(draft, null, 1), 'application/json')),
        ta, btn('Import (replaces the tables it contains)', () => {
          try {
            const next = { ...clone(draft), ...JSON.parse(ta.value) };
            const probs = S.validateDefinitions(next, { shaderNames: shaderNames() });
            if (probs.length) return msg.replaceChildren(err(probs.slice(0, 8).join('\n')));
            draft = next;
            PHYSICS.forEach((k) => touch(k));
            touch('backgrounds');
            render();
          } catch (e) {
            msg.replaceChildren(err(`Not valid JSON: ${e.message}`));
          }
        }), msg),
      section('Saved edits', note(state.restored ? 'Your edits are kept in this browser and used again after a reload, instead of the definitions.js on the server.' : 'Nothing saved yet.'),
        btn('Discard saved edits and reload', () => {
          try { localStorage.removeItem(STORE); } catch { /* ignore */ }
          window.location.reload();
        }, 'bb-dbg-danger')),
    );
    return out;
  }

  function fallbackCopy(t, done) {
    const ta = h('textarea', { class: 'bb-dbg-offscreen' }, t);
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { window.prompt('Copy this:', t); }
    ta.remove();
  }

  // ── the panel ────────────────────────────────────────────────────────────────────────────────────────────
  const statusEl = h('div', { class: 'bb-dbg-status' });
  const tabsEl = h('div', { class: 'bb-dbg-tabs' });
  const bodyEl = h('div', { class: 'bb-dbg-body' });

  const helper = (label, key, apply) => {
    const i = h('input', { type: 'checkbox', checked: state[key] });
    i.addEventListener('change', () => { state[key] = i.checked; apply?.(i.checked); });
    return h('label', { class: 'bb-dbg-chk' }, i, label);
  };
  const header = h('div', { class: 'bb-dbg-head' },
    h('strong', {}, 'Debug'),
    helper('Free camera', 'freeCam', (on) => view.debugFreeCam(on)),
    helper('Show drop zone', 'showDrop', (on) => view.debugShowDrop(on)),
    helper('Auto-restart', 'autoRestart'),
    helper('Shadows', 'fxShadows', (on) => view.debugFx('shadows', on)),
    helper('Reflection', 'fxReflection', (on) => view.debugFx('reflection', on)),
    helper('Blur', 'fxBlur', (on) => view.debugFx('blur', on)),
    h('span', { class: 'bb-dbg-grow' }),
    btn('Shape studio', () => openStudio('shapes'), 'bb-dbg-go'),
    btn('Level studio', () => openStudio('levels'), 'bb-dbg-go'),
    btn('Background studio', () => openStudio('backgrounds'), 'bb-dbg-go'),
    btn('Clear saved data', () => {
      if (!window.confirm('Clear everything this game keeps in this browser (your saved debug edits and which levels you completed) and reload?')) return;
      try { localStorage.removeItem(STORE); localStorage.removeItem('balance.done'); } catch { /* ignore */ }
      window.location.reload();
    }, 'bb-dbg-danger'),
    btn('Restart', () => { flush(); view.ctx.sendInput({ restart: true }); }),
    btn('Menu', () => view.ctx.sendInput({ menu: true })),
    btn('✕', () => setOpen(false)));
  const panel = h('div', { class: 'bb-dbg-panel' }, header, statusEl, tabsEl, bodyEl);
  const toggle = h('button', { type: 'button', class: 'bb-dbg-toggle', title: 'Debug menu ( ` )', onclick: () => setOpen(!state.open) }, '🛠 Debug');
  // the studios (studio.js): a shape editor and a level editor with a live test lab. They edit the same draft as the tabs.
  const studio = createStudio(view, {
    draft: () => draft,
    touch,
    flush,
    problems: () => state.problems,
    showProblems(el) {
      const n = state.problems.length;
      el.textContent = n ? `⚠ ${n} problem${n > 1 ? 's' : ''}: ${state.problems[0]}` : '';
      el.title = state.problems.join('\n');
      el.classList.toggle('bb-on', n > 0);
    },
    w: { field, section, num, text, check, select, color, slider, btn, note },
    open: (name) => openStudio(name),
    close: () => closeStudio(),
  });
  const root = h('div', { class: 'bb-dbg' }, toggle, panel, studio.el);

  function openStudio(name) {
    setOpen(false);
    flush();
    root.classList.add('bb-st-open');
    studio.open(name);
  }
  function closeStudio() {
    flush();
    studio.close();
    root.classList.remove('bb-st-open');
    setOpen(true); // back to the debug menu
  }

  function setOpen(on) {
    state.open = on;
    panel.classList.toggle('bb-show', on);
    if (!on) { modelPrev?.dispose(); modelPrev = null; }
    toggle.classList.toggle('bb-hide', on);
    if (on) render();
  }

  function renderStatus() {
    const kids = [];
    if (state.staleDropped) kids.push(h('div', { class: 'bb-dbg-warn' }, 'Edits saved by an earlier visit were thrown away because definitions.js has changed since. '));
    if (state.problems.length) kids.push(h('div', { class: 'bb-dbg-err' }, h('strong', {}, `${state.problems.length} problem${state.problems.length > 1 ? 's' : ''}, nothing is sent until fixed:`), '\n', state.problems.slice(0, 6).join('\n')));
    if (state.needsRestart && !state.problems.length) kids.push(h('div', { class: 'bb-dbg-warn' }, 'Physics changes apply when the level restarts. ', btn('Restart now', () => { flush(); view.ctx.sendInput({ restart: true }); })));
    statusEl.replaceChildren(...kids);
  }

  function renderTabs() {
    tabsEl.replaceChildren(...Object.entries(TABS).map(([k, t]) => h('button', { type: 'button', class: `bb-dbg-tab${k === state.tab ? ' bb-on' : ''}`, onclick: () => { state.tab = k; render(); } }, t.label)));
  }

  function render() {
    if (!state.open) return;
    renderTabs();
    renderStatus();
    const top = bodyEl.scrollTop;
    if (state.tab !== 'models') { modelPrev?.dispose(); modelPrev = null; }
    bodyEl.replaceChildren(...[TABS[state.tab].render()].flat().filter(Boolean));
    bodyEl.scrollTop = top;
  }

  const onKey = (e) => {
    if (e.key !== '`' || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')) return;
    e.preventDefault();
    if (studio.current) closeStudio();
    else setOpen(!state.open);
  };
  window.addEventListener('keydown', onKey);

  view.onRun = () => {
    state.needsRestart = false;
    renderStatus();
  };

  // Edits from a previous visit. They are only used when they were made from THIS definitions.js: a new file (you changed it, or got a new
  // version) starts clean, otherwise old saved edits would silently override everything in it (new backgrounds, new tuning ...).
  const fingerprint = (text) => {
    let x = 5381;
    for (let i = 0; i < text.length; i++) x = ((x * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${text.length}:${x}`;
  };
  fetch(new URL('./definitions.js', import.meta.url), { cache: 'no-cache' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => {
      state.base = fingerprint(text);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { /* broken save */ }
      if (!saved) return;
      if (saved.base === state.base && saved.draft && S.validateDefinitions(saved.draft, { shaderNames: shaderNames() }).length === 0) {
        draft = saved.draft;
        state.restored = true;
        sendDefs(draft); // the server (and everybody else) gets them too
        validate();
        render();
        studio.refresh();
      } else {
        try { localStorage.removeItem(STORE); } catch { /* ignore */ }
        state.staleDropped = true;
        render();
      }
    })
    .catch(() => { /* no definitions.js to compare with: nothing is restored or saved */ });
  validate();

  return {
    el: root,
    /** Somebody else changed the definitions: their version is now the draft. */
    onRemoteChange() {
      draft = S.cloneDefinitions();
      validate();
      render();
      studio.refresh();
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      studio.dispose();
      modelPrev?.dispose();
      clearTimeout(timer);
      view.onRun = null;
      view.debugFreeCam(false);
      view.debugShowDrop(false);
      root.remove();
    },
  };
}

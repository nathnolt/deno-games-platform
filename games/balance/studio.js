// CLIENT ONLY: the two studios of the debug menu (loaded by debug.js, so only with DEBUG on).
//
//   SHAPE STUDIO  A 2D board that shows EVERY shape at the same scale, side by side, next to the cross-section of a bowl, so you can judge
//                 how they fit together. Drag corners to reshape, click an edge to add a corner, right-click a corner to remove it.
//
//   BACKGROUND STUDIO  The game with the free camera on and a panel to place the models of a background (move / turn / scale, collapsed rows,
//                 a preview window for the model you are about to add, a button that puts the camera back where the game has it).
//
//   LEVEL STUDIO  A blueprint (side view of the bowl, water, drop zone, limits and blocks) next to the running game. Two modes:
//                   Layout     the game shows the start layout frozen; drag blocks in the blueprint to place them, Q / E turn them.
//                   Live test  gravity is on and you can spawn any shape, grab and move any block (also the static ones), freeze
//                              and unfreeze gravity, reset, and capture what you built as the new start layout.
//                 While the studio is open nothing is won or lost (the "lab" mode of the local game).
//
// All of them edit the same DRAFT as the rest of the debug menu (see debug.js), and NOTHING here is shared with the room. The level and
// background studios show and test the draft in the LOCAL GAME: a private copy of the game that runs in this page (client.js, sim.js), so
// nobody else is restarted and nothing goes over the network while you edit. The draft is never sent to the room.
// The ONE exception is on purpose and explicit: the buttons "Add level" / "Update level" (level studio) and "Add shape" / "Update shape" (shape studio).
// After a confirmation they send that ONE level / shape to the server, which writes _levels.js / _shapes.js; every room then uses it.

import * as S from './shared.js';
import { clone, h, svg } from './ui.js';

const KEY = /^[A-Za-z][\w-]*$/;

/**
 * A confirmation: a dialog over a dimmed page with a confirm button and Cancel; the X, Escape and a click on the backdrop close it too.
 * `run()` does the work and resolves { ok, error? }: a failure stays in the dialog (so you can read it and try again), a success closes it and calls `onDone`.
 */
function confirmDialog({ title, text, label, run, onDone }) {
  const before = document.activeElement;
  let busy = false;
  const close = () => {
    if (busy) return;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    before?.focus?.();
  };
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  const err = h('div', { class: 'bb-dbg-err bb-st-dlg-err' });
  const ok = h('button', { type: 'button', class: 'bb-dbg-btn bb-dbg-go' }, label);
  ok.addEventListener('click', async () => {
    busy = true;
    ok.disabled = true;
    ok.textContent = 'Saving…';
    err.textContent = '';
    let r;
    try { r = await run(); } catch (e) { r = { ok: false, error: `${e?.message ?? e}` }; }
    busy = false;
    if (r.ok) { close(); onDone?.(r); return; }
    ok.disabled = false;
    ok.textContent = label;
    err.textContent = r.error ?? 'That did not work.';
  });
  const back = h('div', { class: 'bb-st-dlg-back' },
    h('div', { class: 'bb-st-dlg', role: 'dialog', 'aria-modal': 'true' },
      h('button', { type: 'button', class: 'bb-st-dlg-x', title: 'Close', onclick: close }, '✕'),
      h('h3', {}, title),
      h('p', {}, text),
      err,
      h('div', { class: 'bb-st-dlg-btns' }, ok, h('button', { type: 'button', class: 'bb-dbg-btn', onclick: close }, 'Cancel'))));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  ok.focus();
}
/** A select of shapes with the category names as group headings. */
function shapeSelect(d, value, onchange) {
  const groups = S.shapeGroups(Object.keys(d.shapes), d.shapeCategories ?? {});
  const s = h('select', {}, groups.map(([c, ks]) => h('optgroup', { label: c }, ks.map((k) => h('option', { value: k }, k)))));
  s.value = value;
  s.addEventListener('change', () => onchange(s.value));
  return s;
}
/** A wide dialog with every shape on view at once, under its category heading. A click picks one; the X, Escape and the backdrop close it. */
function shapePicker(d, current, color, onPick) {
  const before = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    before?.focus?.();
  };
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  const groups = S.shapeGroups(Object.keys(d.shapes), d.shapeCategories ?? {});
  const back = h('div', { class: 'bb-st-dlg-back' },
    h('div', { class: 'bb-st-dlg bb-st-pick', role: 'dialog', 'aria-modal': 'true' },
      h('button', { type: 'button', class: 'bb-st-dlg-x', title: 'Close', onclick: close }, '✕'),
      h('h3', {}, 'Choose a shape'),
      h('div', { class: 'bb-st-pick-body' }, groups.map(([c, ks]) => h('section', { class: 'bb-st-pick-cat' },
        h('h4', {}, `${c} (${ks.length})`),
        h('div', { class: 'bb-st-pick-grid' }, ks.map((k) => h('button', {
          type: 'button',
          class: `bb-st-pick-item${k === current ? ' bb-on' : ''}`,
          title: k,
          onclick: () => { close(); onPick(k); },
        }, thumb(d.shapes[k], color, 84, 64), h('span', {}, k)))))))));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  back.querySelector('.bb-on')?.scrollIntoView?.({ block: 'center' });
}
/**
 * The level order menu: the worlds and the levels in them as _levels.js has them now (what the room runs), with buttons to move a level up or down inside its
 * world and a world up or down. "Save order" writes the new order to _levels.js. Nothing is written before that.
 */
function orderDialog(view, api, onDone) {
  const rd = view.debugRoomDefs();
  const before = document.activeElement;
  let busy = false;
  const close = () => {
    if (busy) return;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    before?.focus?.();
  };
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  const err = h('div', { class: 'bb-dbg-err bb-st-dlg-err' });
  const body = h('div', { class: 'bb-st-ord-body' });
  const save = h('button', { type: 'button', class: 'bb-dbg-btn bb-dbg-go' }, 'Save order');
  const small = (text, fn, off, title) => h('button', { type: 'button', class: 'bb-dbg-btn', title, disabled: off, onclick: fn }, text);
  const W = rd?.worlds ?? {};
  const first = Object.keys(W)[0];
  const worldOf = (lv) => (lv.world && W[lv.world] ? lv.world : first);
  const order = Object.keys(W);
  const lists = Object.fromEntries(order.map((k) => [k, []]));
  (rd?.levels ?? []).forEach((lv, i) => lists[worldOf(lv)].push(i));
  const start = JSON.stringify([order, lists]);
  const swap = (arr, i, by) => { const j = i + by; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; render(); };
  function render() {
    save.disabled = busy || JSON.stringify([order, lists]) === start;
    put(body, order.map((k, wi) => h('section', { class: 'bb-st-ord-world' },
      h('div', { class: 'bb-st-ord-head' },
        h('strong', {}, `${W[k].name ?? k}`), h('span', { class: 'bb-dbg-note' }, `${lists[k].length} level${lists[k].length === 1 ? '' : 's'}`), h('span', { class: 'bb-dbg-grow' }),
        small('▲', () => swap(order, wi, -1), wi === 0, 'Move this world up'), small('▼', () => swap(order, wi, 1), wi === order.length - 1, 'Move this world down')),
      lists[k].length
        ? lists[k].map((li, n) => h('div', { class: 'bb-st-ord-row' },
          h('span', { class: 'bb-dbg-idx' }, n + 1), h('span', { class: 'bb-st-ord-name' }, rd.levels[li].name), h('span', { class: 'bb-dbg-note' }, rd.levels[li].difficulty ?? ''),
          small('▲', () => swap(lists[k], n, -1), n === 0, 'Earlier in this world'), small('▼', () => swap(lists[k], n, 1), n === lists[k].length - 1, 'Later in this world')))
        : h('p', { class: 'bb-dbg-note' }, 'No levels in this world.'))));
  }
  save.addEventListener('click', async () => {
    busy = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    err.textContent = '';
    let r;
    try { r = await api.saveItem({ kind: 'order', op: 'update', worlds: order, order: lists, names: rd.levels.map((l) => l.name) }); } catch (e) { r = { ok: false, error: `${e?.message ?? e}` }; }
    busy = false;
    save.textContent = 'Save order';
    if (r.ok) {
      close();
      onDone?.({ worlds: [...order], ids: order.flatMap((k) => lists[k].map((i) => `${k}|${rd.levels[i].name}`)), file: r.file });
      return;
    }
    err.textContent = r.error ?? 'That did not work.';
    render();
  });
  const back = h('div', { class: 'bb-st-dlg-back' },
    h('div', { class: 'bb-st-dlg bb-st-ord', role: 'dialog', 'aria-modal': 'true' },
      h('button', { type: 'button', class: 'bb-st-dlg-x', title: 'Close', onclick: close }, '✕'),
      h('h3', {}, 'Level order'),
      rd ? h('p', { class: 'bb-dbg-note' }, 'Move levels up and down inside their world, and worlds up and down. This is the order of the menu. Nothing changes until you press Save order, which rewrites _levels.js.') : h('p', {}, 'The levels of the room have not arrived yet: close this and try again in a moment.'),
      body,
      err,
      h('div', { class: 'bb-st-dlg-btns' }, rd ? save : null, h('button', { type: 'button', class: 'bb-dbg-btn', onclick: close }, 'Cancel'))));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  if (rd) render();
}
// How big the studio panels are is YOUR view, not game state: it lives in this page only (not stored anywhere, not sent to the server or the other players).
const dockPref = { w: 470, bp: 300 }; // width of the level / background studio panel, height of the blueprint (px)
/** A handle on the right edge of a docked studio panel: drag it to make the panel (and so the blueprint) wider; the game gets the rest. */
function dockGrip(root, view) {
  const g = h('div', { class: 'bb-st-gripx', title: 'Drag to make this panel wider or narrower (only for you: not shared with the other players)' });
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    const move = (ev) => {
      dockPref.w = Math.round(Math.min(Math.max(ev.clientX - root.getBoundingClientRect().left, 320), window.innerWidth * 0.85));
      root.style.width = `${dockPref.w}px`;
      view.debugDock(dockPref.w, view.top);
    };
    const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
  root.append(g);
}
const SHADER_COLOR = { wood: '#c99a62', wood2: '#dcc294', glass: '#9fd3e6', waterBlock: '#2f7fc4', crackedGlass: '#b9dcee', stone1: '#8f9298', stone2: '#6d717a', float: '#86b0d6' };
const LIGHT0 = 1000; // the viewport number of the first light (models are 0, 1, 2 ... see client.js)
const BLUR_CHOICES = [['none', 'sharp (none)'], ['light', 'light blur'], ['heavy', 'heavy blur']];
const SNAPS = [['0', 'free'], ['0.1', '0.1'], ['0.25', '0.25'], ['0.5', '0.5'], ['1', '1']];
const ACCENT = '#f43f5e';

const f3 = (n) => String(Math.round(n * 1000) / 1000);
const parsePts = (str) => String(str ?? '').trim().split(/\s+/).filter(Boolean).map((p) => p.split(',').map(Number));
const ptsStr = (pts) => pts.map(([x, y]) => `${f3(x)},${f3(y)}`).join(' ');
const snapTo = (v, step) => (step > 0 ? Math.round(v / step) * step : Math.round(v * 1000) / 1000);
const deg = (r) => (r * 180) / Math.PI;
/** replaceChildren that skips null / false and flattens lists (a bare `null` would otherwise be drawn as the text "null"). */
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '');

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}
const circleOf = (p) => ({ x: p.x ?? p.diameter / 2, y: p.y ?? p.diameter / 2, r: p.diameter / 2 });
/** Bounding box [x0, y0, x1, y1] of the parts that make up the body (drawing-only outlines are left out). */
function boxOf(def) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of def) {
    if (p.visual || p.cut) continue;
    if (p.type === 'circle') {
      const c = circleOf(p);
      b = [Math.min(b[0], c.x - c.r), Math.min(b[1], c.y - c.r), Math.max(b[2], c.x + c.r), Math.max(b[3], c.y + c.r)];
    } else {
      for (const [x, y] of parsePts(p.points)) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    }
  }
  return Number.isFinite(b[0]) && b.every(Number.isFinite) ? b : [0, 0, 1, 1];
}
const shapeCache = new Map();
/** The built shape (centred, counter-clockwise) of a shape definition, or null while it is not valid. */
function built(def) {
  const k = JSON.stringify(def);
  if (!shapeCache.has(k)) {
    try { shapeCache.set(k, S.buildShape(def, '?')); } catch { shapeCache.set(k, null); }
    if (shapeCache.size > 400) shapeCache.delete(shapeCache.keys().next().value);
  }
  return shapeCache.get(k);
}
const matColor = (draft, key) => SHADER_COLOR[draft.materials[key]?.shader] ?? '#b9b0a0';

const bowlFull = (draft, key) => {
  const b = draft.bowls[key] ?? {};
  return { ...S.BOWL_DEFAULTS, ...b, water: { ...S.BOWL_DEFAULTS.water, ...b.water } };
};

/** SVG thumbnail of a shape definition, fitted into `w` x `hgt` pixels. */
function thumb(def, color, w = 46, hgt = 34) {
  const b = boxOf(def);
  const bw = Math.max(0.1, b[2] - b[0]);
  const bh = Math.max(0.1, b[3] - b[1]);
  const k = Math.min((w - 4) / bw, (hgt - 4) / bh);
  const root = svg('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: 'bb-st-thumb' });
  const g = svg('g', { transform: `translate(${(w - bw * k) / 2 - b[0] * k} ${(hgt + bh * k) / 2 + b[1] * k}) scale(${k} ${-k})` });
  const common = { fill: color, stroke: '#1f2937', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' };
  const bs = def.some((p) => p.type !== 'circle') ? built(def) : null; // (the result of the cuts and of the rounding)
  const looks = bs?.visual ?? null; // the outline the block really has in the game: rounded, with its cuts (holes) taken out
  if (looks) {
    const loop = (pts) => `M${pts.map(([x, y]) => `${x + bs.ox} ${y + bs.oy}`).join('L')}Z`;
    g.append(svg('path', { d: looks.map((v) => [v.pts, ...(v.holes ?? [])].map(loop).join('')).join(''), 'fill-rule': 'evenodd', ...common }));
  }
  for (const p of looks ? [] : def) {
    if (p.visual || p.cut) continue;
    if (p.type === 'circle') {
      const c = circleOf(p);
      g.append(svg('circle', { cx: c.x, cy: c.y, r: c.r, ...common }));
    } else {
      g.append(svg('polygon', { points: p.points, ...common }));
    }
  }
  root.append(g);
  return root;
}

/**
 * A pan / zoom SVG board in world units (y up). Content is drawn into `board.g` by the owner; strokes should use
 * vector-effect="non-scaling-stroke". `down(world, event)` may return { move(world, event), up(world, event) } to start a drag,
 * anything else pans the board.
 */
function makeBoard({ down, context, wheel, resized, hover }) {
  const root = svg('svg', { class: 'bb-st-svg' });
  const g = svg('g');
  root.append(g);
  const v = { tx: 0, ty: 0, k: 10, fitted: false, userMoved: false, bounds: null };
  const size = () => {
    const r = root.getBoundingClientRect();
    return { w: r.width || 600, h: r.height || 400, r };
  };
  const apply = () => g.setAttribute('transform', `translate(${v.tx} ${v.ty}) scale(${v.k} ${-v.k})`);
  const worldAt = (cx, cy) => {
    const { r } = size();
    return { x: (cx - r.left - v.tx) / v.k, y: -(cy - r.top - v.ty) / v.k };
  };
  const inside = (cx, cy) => {
    const { r } = size();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  };
  const board = {
    el: root, g, v, worldAt, inside,
    /** The visible world rectangle. */
    view() {
      const { w, h: hh } = size();
      return { x0: -v.tx / v.k, x1: (w - v.tx) / v.k, y1: v.ty / v.k, y0: -(hh - v.ty) / v.k };
    },
    fit(b = v.bounds) {
      if (!b) return;
      v.bounds = b;
      const { w, h: hh } = size();
      v.k = Math.max(0.5, Math.min(w / (b[2] - b[0]), hh / (b[3] - b[1])) * 0.94);
      v.tx = w / 2 - ((b[0] + b[2]) / 2) * v.k;
      v.ty = hh / 2 + ((b[1] + b[3]) / 2) * v.k;
      v.fitted = true;
      v.userMoved = false;
      apply();
    },
    apply,
  };

  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    root.setPointerCapture(e.pointerId);
    drag = down?.(worldAt(e.clientX, e.clientY), e) ?? { pan: true, x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) {
      hover?.(worldAt(e.clientX, e.clientY), e);
      return;
    }
    if (drag.pan) {
      v.tx = drag.tx + (e.clientX - drag.x);
      v.ty = drag.ty + (e.clientY - drag.y);
      v.userMoved = true;
      apply();
      resized?.(false);
    } else {
      drag.move?.(worldAt(e.clientX, e.clientY), e);
    }
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.pan) d.up?.(worldAt(e.clientX, e.clientY), e);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    context?.(worldAt(e.clientX, e.clientY), e);
  });
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (wheel?.(e)) return;
    const w = worldAt(e.clientX, e.clientY);
    const nk = Math.min(400, Math.max(0.8, v.k * Math.exp(-e.deltaY * 0.0015)));
    const { r } = size();
    v.tx = e.clientX - r.left - w.x * nk;
    v.ty = e.clientY - r.top + w.y * nk;
    v.k = nk;
    v.userMoved = true;
    apply();
    resized?.(true);
  }, { passive: false });
  new ResizeObserver(() => {
    if (!v.fitted && v.bounds) board.fit();
    else if (!v.userMoved && v.bounds) board.fit();
    resized?.(true);
  }).observe(root);
  return board;
}

/** Grid + bowl + water, drawn into `g` (world units). `px` = size of one screen pixel in world units. */
function drawGrid(g, view, step, px) {
  const lines = [];
  const major = [];
  const x0 = Math.floor(view.x0 / step) * step;
  const y0 = Math.floor(view.y0 / step) * step;
  if ((view.x1 - view.x0) / step > 400 || (view.y1 - view.y0) / step > 400) return;
  for (let x = x0; x <= view.x1; x += step) (Math.round(x / step) % 5 === 0 ? major : lines).push(`M${x} ${view.y0}V${view.y1}`);
  for (let y = y0; y <= view.y1; y += step) (Math.round(y / step) % 5 === 0 ? major : lines).push(`M${view.x0} ${y}H${view.x1}`);
  g.append(
    svg('path', { d: lines.join(''), stroke: 'rgba(148,163,184,.13)', fill: 'none', 'vector-effect': 'non-scaling-stroke' }),
    svg('path', { d: major.join(''), stroke: 'rgba(148,163,184,.28)', fill: 'none', 'vector-effect': 'non-scaling-stroke' }),
  );
  void px;
}

/** A grid aligned with the shape being drawn or edited: lines every snap step from the shape's own 0,0 (amber axes), whole units stronger and numbered. */
function drawShapeGrid(g, view, ox, oy, snap, k, px) {
  let step = snap > 0 ? snap : 1;
  while (step * k < 7) step *= 5; // too dense to see: show every 5th line
  const unit = step < 1 ? 1 : step * 5;
  const lines = [];
  const major = [];
  const axes = [];
  const nums = [];
  const x0 = Math.floor((view.x0 - ox) / step) * step;
  const y0 = Math.floor((view.y0 - oy) / step) * step;
  if ((view.x1 - view.x0) / step > 600 || (view.y1 - view.y0) / step > 600) return;
  const near = (v, m) => Math.abs(v / m - Math.round(v / m)) < 1e-6;
  for (let lx = x0; lx + ox <= view.x1; lx += step) {
    const x = lx + ox;
    const path = Math.abs(lx) < 1e-9 ? axes : near(lx, unit) ? major : lines;
    path.push(`M${x} ${view.y0}V${view.y1}`);
    if (near(lx, unit) && Math.abs(lx) > 1e-9 && unit * k >= 26) nums.push(svg('text', { transform: `translate(${x + 3 * px} ${oy - 12 * px}) scale(1 -1)`, 'font-size': 10 * px, fill: 'rgba(251,191,36,.8)', 'font-family': 'system-ui, sans-serif' }, f3(lx)));
  }
  for (let ly = y0; ly + oy <= view.y1; ly += step) {
    const y = ly + oy;
    const path = Math.abs(ly) < 1e-9 ? axes : near(ly, unit) ? major : lines;
    path.push(`M${view.x0} ${y}H${view.x1}`);
    if (near(ly, unit) && Math.abs(ly) > 1e-9 && unit * k >= 26) nums.push(svg('text', { transform: `translate(${ox + 3 * px} ${y + 3 * px}) scale(1 -1)`, 'font-size': 10 * px, fill: 'rgba(251,191,36,.8)', 'font-family': 'system-ui, sans-serif' }, f3(ly)));
  }
  const line = (d, stroke, w = 1) => svg('path', { d: d.join(''), stroke, fill: 'none', 'stroke-width': w, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' });
  g.append(line(lines, 'rgba(250,204,21,.16)'), line(major, 'rgba(250,204,21,.34)'), line(axes, 'rgba(251,146,60,.85)', 1.5), ...nums);
}

/** Copy text to the clipboard (button b shows 'Copied ✓'). */
function copyText(t, b) {
  const done = () => { const old = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = old), 1200); };
  const fallback = () => {
    const ta = h('textarea', { class: 'bb-dbg-offscreen' }, t);
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { window.prompt('Copy this:', t); }
    ta.remove();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, fallback); else fallback();
}
let clipId = 0;
/** The bowl: wood, water inside up to the water line, and the table top under it. */
function drawBowl(g, bowl) {
  const { inner, outer } = S.bowlProfile(48, bowl);
  const id = `bbclip${clipId++}`;
  const innerPoly = inner.map(([x, y]) => `${f3(x)},${f3(y)}`).join(' ');
  const wood = [...inner, ...[...outer].reverse()].map(([x, y]) => `${f3(x)},${f3(y)}`).join(' ');
  const groundY = S.groundYOf(bowl);
  g.append(
    svg('clipPath', { id }, svg('polygon', { points: innerPoly })),
    svg('rect', { x: -bowl.a - 1, y: groundY - 4, width: bowl.a * 2 + 2, height: S.WATER_Y - groundY + 4, fill: bowl.water.color, opacity: Math.min(0.6, bowl.water.opacity + 0.1), 'clip-path': `url(#${id})` }),
    svg('polygon', { points: wood, fill: '#b98a56', stroke: '#6b4a26', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', opacity: 0.95 }),
    svg('line', { x1: -bowl.a - 8, x2: bowl.a + 8, y1: S.WATER_Y, y2: S.WATER_Y, stroke: '#38bdf8', 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke', opacity: 0.7 }),
  );
}

const CUT_STYLE = { fill: 'rgba(239,68,68,.22)', stroke: '#ef4444', 'stroke-dasharray': '5 3' };
function drawParts(def, fill, stroke, extra = {}) {
  const out = [];
  for (const p of def) {
    const common = { fill, stroke, 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke', ...extra };
    if (p.type === 'circle') {
      const c = circleOf(p);
      out.push(svg('circle', { cx: c.x, cy: c.y, r: c.r, ...common, ...(p.visual ? { 'stroke-dasharray': '3 3', fill: 'none' } : {}), ...(p.cut ? CUT_STYLE : {}) }));
    } else {
      out.push(svg('polygon', { points: p.points, ...common, ...(p.visual ? { 'stroke-dasharray': '3 3', fill: 'none' } : {}), ...(p.cut ? CUT_STYLE : {}) }));
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
//  SHAPE STUDIO
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
function shapeStudio(view, api) {
  const st = { sel: null, part: 0, editing: false, calc: false, show3d: false, draw: null, closeOnFirst: true, snap: 1, mat: '(mixed)', bowl: null, open: false, msg: '', newName: '', tf: { x: 1.5, y: 1.5, lock: true } };
  let manual = {}; //   shapes the user moved on the board: key -> { ox, oy } (only where a shape is drawn, never its data)
  let layout = null; // { cells: { key: { ox, oy, ax, ay } }, rows: [{ y, x0, x1 }], bowlKey }
  let raf = 0;
  let listTimer = 0;

  const D = () => api.draft();
  const keys = () => Object.keys(D().shapes);
  const snapV = (v) => snapTo(v, st.snap);

  // ── layout: bowl at the left, then every shape on a shelf, wrapped into rows. A shape keeps its place while you drag its corners. ──
  function bowlKey() {
    const d = D();
    if (!d.bowls[st.bowl]) st.bowl = d.bowls[d.levels[view.snap?.lv ?? -1]?.bowl] ? d.levels[view.snap.lv].bowl : Object.keys(d.bowls)[0];
    return st.bowl;
  }
  function relayout() {
    const d = D();
    const bowl = bowlFull(d, bowlKey());
    const gY = Math.round(S.groundYOf(bowl)); // (every cell starts on a whole grid point, so shapes can be compared side by side)
    const start = Math.ceil(bowl.a + bowl.t + 5);
    const maxX = start + 46;
    const cells = {};
    const rows = [];
    let x = start;
    let y = gY;
    let rowH = 0;
    let row = { y, x0: start - 2, x1: start };
    for (const key of keys()) {
      const b = boxOf(d.shapes[key]);
      const w = b[2] - b[0];
      const hh = b[3] - b[1];
      if (x > start && x + w > maxX) {
        rows.push(row);
        y -= Math.ceil(rowH) + 4;
        x = start;
        rowH = 0;
        row = { y, x0: start - 2, x1: start };
      }
      cells[key] = { ox: x, oy: y, ax: b[0], ay: b[1], w, h: hh };
      x += Math.ceil(w) + 2;
      rowH = Math.max(rowH, hh);
      row.x1 = Math.max(row.x1, x);
    }
    for (const key of Object.keys(manual)) if (cells[key]) Object.assign(cells[key], manual[key]);
    rows.push(row);
    const top = gY + Math.max(bowl.rimY - gY + 3, 12);
    layout = { cells, rows, bowlKey: bowlKey(), bounds: [-bowl.a - bowl.t - 3, y - 4, maxX + 3, top] };
  }
  const shift = (key) => {
    const c = layout.cells[key];
    return c ? { x: c.ox - c.ax, y: c.oy - c.ay } : { x: 0, y: 0 };
  };

  // ── the 2D board ──
  const board = makeBoard({
    down(w, e) {
      const t = e.target;
      const role = t.dataset?.role;
      const d = D();
      const def = d.shapes[st.sel];
      if (st.draw) {
        drawClick(w);
        return { move() {}, up() {} };
      }
      if (role && def && st.editing) {
        const part = def[+t.dataset.part];
        const sh = shift(st.sel);
        const local = (q) => ({ x: snapV(q.x - sh.x), y: snapV(q.y - sh.y) });
        if (role === 'v') {
          const pts = parsePts(part.points);
          const i = +t.dataset.idx;
          return { move(q) { const p = local(q); pts[i] = [p.x, p.y]; part.points = ptsStr(pts); edited(true); }, up() { edited(); } };
        }
        if (role === 'e') {
          const pts = parsePts(part.points);
          const i = +t.dataset.idx;
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          pts.splice(i + 1, 0, [snapV((a[0] + b[0]) / 2), snapV((a[1] + b[1]) / 2)]);
          part.points = ptsStr(pts);
          edited(true);
          return { move(q) { const p = local(q); pts[i + 1] = [p.x, p.y]; part.points = ptsStr(pts); edited(true); }, up() { edited(); } };
        }
        if (role === 'c') {
          const c0 = circleOf(part);
          return { move(q) { const p = local(q); part.x = p.x; part.y = p.y; part.diameter = c0.r * 2; edited(true); }, up() { edited(); } };
        }
        if (role === 'r') {
          return {
            move(q) {
              const c = circleOf(part);
              part.x = c.x;
              part.y = c.y;
              part.diameter = Math.max(0.2, snapTo(Math.hypot(q.x - sh.x - c.x, q.y - sh.y - c.y) * 2, st.snap || 0.05));
              edited(true);
            },
            up() { edited(); },
          };
        }
      }
      const hit = t.closest?.('[data-shape]');
      if (hit) {
        const key = hit.dataset.shape;
        const body = t.closest?.('[data-pbody]');
        const whole = !st.editing || key !== st.sel || e.shiftKey || e.altKey || !body; // only while editing does a subshape under the pointer move
        if (key !== st.sel) select(key);
        if (!whole) {
          const i = +body.dataset.pbody;
          if (i !== st.part) focusPart(i);
          return partDrag(w, i);
        }
        return shapeDrag(key, w);
      }
      return null;
    },
    hover(w) {
      if (!st.draw) return;
      const sh = drawShift();
      st.draw.cur = [snapV(w.x - sh.x), snapV(w.y - sh.y)];
      scheduleDraw();
    },
    context(w, e) {
      const t = e.target;
      if (t.dataset?.role !== 'v') return;
      const part = D().shapes[st.sel]?.[+t.dataset.part];
      const pts = part ? parsePts(part.points) : [];
      if (pts.length <= 3) return;
      pts.splice(+t.dataset.idx, 1);
      part.points = ptsStr(pts);
      edited();
    },
    resized() { scheduleDraw(); },
  });

  /** Drag a whole shape across the board: only where it is DRAWN changes (to compare it with the others), never its points. */
  function shapeDrag(key, w) {
    const c = layout.cells[key];
    const o = { x: c.ox, y: c.oy };
    return {
      move(q) {
        c.ox = o.x + snapV(q.x - w.x);
        c.oy = o.y + snapV(q.y - w.y);
        manual[key] = { ox: c.ox, oy: c.oy };
        scheduleDraw();
      },
      up() {},
    };
  }
  /** Drag one part of the selected shape: all its points (or the circle centre) move together. */
  function partDrag(w, i) {
    const part = D().shapes[st.sel][i];
    const circle = part.type === 'circle';
    const orig = circle ? circleOf(part) : parsePts(part.points);
    return {
      move(q) {
        const dx = snapV(q.x - w.x);
        const dy = snapV(q.y - w.y);
        if (circle) {
          part.x = orig.x + dx;
          part.y = orig.y + dy;
          part.diameter = orig.r * 2;
        } else {
          part.points = ptsStr(orig.map(([x, y]) => [x + dx, y + dy]));
        }
        edited(true);
      },
      up() { edited(); },
    };
  }
  function focusPart(i) {
    st.part = i;
    renderInspector();
    scheduleDraw();
  }

  // ── drawing a new polygon, point by point ──
  const drawShift = () => shift(st.sel);
  function startDraw() {
    if (!st.sel) return;
    st.editing = true;
    st.draw = { pts: [], cur: null };
    focus();
    st.msg = '';
    board.el.classList.add('bb-st-drawing');
    renderHead();
    renderList();
    renderInspector();
    scheduleDraw();
  }
  function cancelDraw() {
    if (!st.draw) return;
    st.draw = null;
    board.el.classList.remove('bb-st-drawing');
    renderHead();
    scheduleDraw();
  }
  function finishDraw() {
    const dr = st.draw;
    if (!dr) return;
    if (dr.pts.length < 3) return fail('A polygon needs at least 3 points: click the board to put them down.');
    const def = D().shapes[st.sel];
    def.push({ type: 'poly', points: ptsStr(dr.pts) });
    st.part = def.length - 1;
    st.msg = '';
    cancelDraw();
    renderList();
    edited();
    return undefined;
  }
  function drawClick(w) {
    const dr = st.draw;
    const sh = drawShift();
    const p = [snapV(w.x - sh.x), snapV(w.y - sh.y)];
    if (st.closeOnFirst && dr.pts.length >= 3 && Math.hypot(w.x - sh.x - dr.pts[0][0], w.y - sh.y - dr.pts[0][1]) < 9 / board.v.k) return finishDraw(); // click the first point to close
    const last = dr.pts[dr.pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) dr.pts.push(p);
    scheduleDraw();
    return undefined;
  }
  function setEditing(on) {
    if (on === st.editing) return;
    st.editing = on;
    if (!on) cancelDraw();
    renderInspector();
    scheduleDraw();
  }
  function removeSubshape(i) {
    const def = D().shapes[st.sel];
    if (!def) return;
    if (def.length <= 1) return fail('A shape needs at least one subshape (delete the whole shape from the list instead).');
    def.splice(i, 1);
    st.part = Math.max(0, Math.min(st.part, def.length - 1));
    st.msg = '';
    renderList();
    edited();
    return undefined;
  }
  const onKey = (e) => {
    if (!st.open || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!st.draw) {
      if (st.editing && (e.key === 'Delete' || e.key === 'Backspace')) {
        removeSubshape(st.part);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Enter') finishDraw();
    else if (e.key === 'Escape') cancelDraw();
    else if (e.key === 'Backspace') { st.draw.pts.pop(); scheduleDraw(); } else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  function scheduleDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function draw() {
    if (!st.open) return;
    if (!layout || keys().some((k) => !layout.cells[k])) relayout();
    const d = D();
    const g = board.g;
    g.replaceChildren();
    const { k } = board.v;
    const px = 1 / k;
    const bowl = bowlFull(d, layout.bowlKey);
    const view2 = board.view();
    const ownGrid = (st.draw || st.editing) && st.sel;
    if (!ownGrid) drawGrid(g, view2, k > 12 ? 1 : 5, px); // (editing a shape shows its own grid instead: two grids through each other were confusing)
    drawBowl(g, bowl);
    const label = (text, x, y, size, fill = '#cbd5e1', anchor = 'start') => svg('text', { transform: `translate(${x} ${y}) scale(1 -1)`, 'font-size': size * px, fill, 'text-anchor': anchor, 'font-family': 'system-ui, sans-serif' }, text);
    g.append(label(`bowl "${layout.bowlKey}"  ${f3(bowl.a * 2)} wide at the rim, ${f3(bowl.b)} deep`, -bowl.a, S.groundYOf(bowl) - 1.6, 11));
    if (ownGrid) {
      const gs = shift(st.sel);
      drawShapeGrid(g, view2, gs.x, gs.y, st.snap, k, px);
    }
    for (const r of layout.rows) {
      g.append(svg('line', { x1: r.x0, x2: r.x1, y1: r.y, y2: r.y, stroke: '#8a7a5c', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    }
    const mats = Object.keys(d.materials).filter((m) => !d.materials[m].static);
    let n = 0;
    const top = svg('g'); // the handles of the selected shape: above every shape
    for (const key of keys()) {
      const def = d.shapes[key];
      const sh = shift(key);
      const sel = key === st.sel;
      const matKey = st.mat === '(mixed)' ? mats[n++ % mats.length] : st.mat;
      const col = matColor(d, matKey);
      const grp = svg('g', { transform: `translate(${sh.x} ${sh.y})`, 'data-shape': key, class: 'bb-st-shape' });
      const kids = drawParts(def, col, sel ? ACCENT : '#1f2937', { opacity: sel ? 1 : 0.92 });
      kids.forEach((node, i) => {
        node.setAttribute('data-pbody', i);
        if (sel && st.editing && def.length > 1) {
          node.setAttribute('stroke', i === st.part ? ACCENT : '#64748b');
          if (i !== st.part) node.setAttribute('opacity', 0.6);
        }
      });
      grp.append(...kids);
      const calc = st.calc && key === st.sel && !calcTimer; // (while the shape is being edited the calculated one waits until the mouse is still)
      if (calc) kids.forEach((node) => node.setAttribute('opacity', 0.22));
      if (calc || def.some((q) => q.cut)) { // the result: the outline the block really has (dark; rounded, cuts taken out), and how it is split for collision (thin lines)
        const bt = built(def);
        if (bt) {
          const cx = bt.ox, cy = bt.oy;
          const shiftBack = (pts) => pts.map(([x, y]) => `${x + cx},${y + cy}`).join(' ');
          const loopPath = (pts) => `M${pts.map(([x, y]) => `${x + cx} ${y + cy}`).join('L')}Z`;
          if (calc && bt.visual) grp.append(svg('path', { d: bt.visual.map((v) => [v.pts, ...(v.holes ?? [])].map(loopPath).join('')).join(''), 'fill-rule': 'evenodd', fill: col, opacity: 0.85, 'pointer-events': 'none' }));
          for (const q of bt.parts) {
            grp.append(q.type === 'circle'
              ? svg('circle', { cx: q.cx + cx, cy: q.cy + cy, r: q.r, fill: 'none', stroke: 'rgba(15,23,42,.35)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' })
              : svg('polygon', { points: shiftBack(q.pts), fill: 'none', stroke: calc ? 'rgba(15,23,42,.45)' : 'rgba(15,23,42,.2)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
          }
          for (const v of bt.visual ?? []) for (const loop of [v.pts, ...(v.holes ?? [])]) grp.append(svg('polygon', { points: shiftBack(loop), fill: 'none', stroke: '#0f172a', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
        }
      }
      for (const [pi, p] of def.entries()) { // a part that is not convex cannot be a collision shape
        if (p.type !== 'circle' && !p.visual && !p.cut && !isConvex(parsePts(p.points))) grp.append(svg('polygon', { points: p.points, fill: 'none', stroke: '#ef4444', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
        void pi;
      }
      g.append(grp);
      const c = layout.cells[key];
      const box = boxOf(def);
      g.append(label(key, c.ox + (box[2] - box[0]) / 2, c.oy - 1.7, sel ? 12 : 10.5, sel ? '#fff' : '#94a3b8', 'middle'));
      if (sel) {
        g.append(label(`${f3(box[2] - box[0])} × ${f3(box[3] - box[1])}${st.editing ? '  (editing)' : ''}`, c.ox + (box[2] - box[0]) / 2, c.oy - 3.2, 10.5, '#fda4af', 'middle'));
        for (const [pi, p] of def.entries()) {
          if (!st.editing || pi !== st.part) continue; // handles only while editing, and only for the subshape you work on
          const hg = svg('g', { transform: `translate(${sh.x} ${sh.y})` });
          if (p.type === 'circle') {
            const cc = circleOf(p);
            hg.append(
              svg('circle', { cx: cc.x, cy: cc.y, r: 5.5 * px, fill: '#fff', stroke: ACCENT, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'data-role': 'c', 'data-part': pi, class: 'bb-st-handle' }),
              svg('circle', { cx: cc.x + cc.r, cy: cc.y, r: 5.5 * px, fill: ACCENT, stroke: '#fff', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', 'data-role': 'r', 'data-part': pi, class: 'bb-st-handle' }),
            );
          } else {
            const pts = parsePts(p.points);
            pts.forEach((a, i) => {
              const b = pts[(i + 1) % pts.length];
              hg.append(svg('circle', { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, r: 3.5 * px, fill: 'rgba(255,255,255,.5)', stroke: ACCENT, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'data-role': 'e', 'data-part': pi, 'data-idx': i, class: 'bb-st-handle' }));
            });
            pts.forEach((a, i) => hg.append(svg('circle', { cx: a[0], cy: a[1], r: 5.5 * px, fill: p.visual ? '#fde68a' : '#fff', stroke: ACCENT, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'data-role': 'v', 'data-part': pi, 'data-idx': i, class: 'bb-st-handle' })));
          }
          top.append(hg);
        }
      }
    }
    if (st.draw) {
      const sh = drawShift();
      const dr = st.draw;
      const all = dr.cur ? [...dr.pts, dr.cur] : dr.pts;
      const dg = svg('g', { transform: `translate(${sh.x} ${sh.y})`, 'pointer-events': 'none' });
      if (all.length > 1) dg.append(svg('polyline', { points: all.map((q) => q.join(',')).join(' '), fill: 'none', stroke: '#fde047', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': dr.cur ? '' : '' }));
      if (dr.pts.length >= 3 && dr.cur) dg.append(svg('line', { x1: dr.cur[0], y1: dr.cur[1], x2: dr.pts[0][0], y2: dr.pts[0][1], stroke: '#fde047', 'stroke-width': 1, 'stroke-dasharray': '3 4', 'vector-effect': 'non-scaling-stroke', opacity: 0.6 }));
      dr.pts.forEach((q, i) => dg.append(svg('circle', { cx: q[0], cy: q[1], r: (i === 0 ? 7 : 5) * px, fill: i === 0 && st.closeOnFirst ? '#fde047' : '#fff', stroke: '#92400e', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' })));
      if (dr.cur) dg.append(svg('text', { transform: `translate(${dr.cur[0] + 8 * px} ${dr.cur[1] + 8 * px}) scale(1 -1)`, 'font-size': 11 * px, fill: '#fde047', 'font-family': 'system-ui, sans-serif' }, `${dr.pts.length + 1}: ${f3(dr.cur[0])}, ${f3(dr.cur[1])}`));
      top.append(dg);
    }
    g.append(top);
  }

  // ── editing ──
  /** The selected shape changed. `live` = still dragging (only redraw). */
  function edited(live = false) {
    const cur = D().shapes[st.sel];
    if (cur) st.part = Math.max(0, Math.min(st.part, cur.length - 1));
    api.touch('shapes', false, live); // validates (nothing is sent anywhere) and calls changed() below; while dragging that all waits until the mouse is still for a moment
    scheduleDraw();
    bumpCalc();
    pvRefresh();
    if (!live) renderInspector();
    else renderInfo();
  }
  /** Zoom the board to one shape (the overview keeps everything in view; this is for precise work). */
  function focus(key = st.sel) {
    if (!layout) relayout();
    const c = layout.cells[key];
    if (!c) return;
    const w = Math.max(c.w, 12) * 0.75;
    const hh = Math.max(c.h, 8) * 0.9;
    board.fit([c.ox + c.w / 2 - w, c.oy + c.h / 2 - hh, c.ox + c.w / 2 + w, c.oy + c.h / 2 + hh]);
    scheduleDraw();
  }
  function select(key) {
    if (key !== st.sel) {
      st.part = 0;
      st.editing = false;
      cancelDraw();
    }
    st.sel = key;
    st.msg = '';
    renderList();
    renderInspector();
    scheduleDraw();
    pvRefresh(true);
  }
  function usage(key) {
    let n = 0;
    for (const L of D().levels) if (L.initialBlocks.some((b) => b.shape === key) || L.shapes.some((s) => s.shape === key)) n++;
    return n;
  }
  const fitSoon = () => requestAnimationFrame(() => { relayout(); board.fit(layout.bounds); scheduleDraw(); });
  const fail = (msg) => { st.msg = msg; renderList(); };
  function addShape(key, def) {
    const d = D();
    if (!KEY.test(key)) return fail('A shape name starts with a letter and uses letters, digits, _ and - only.');
    if (d.shapes[key]) return fail(`"${key}" already exists.`);
    d.shapes[key] = def;
    st.msg = '';
    st.sel = key;
    st.newName = '';
    layout = null;
    api.touch('shapes');
    renderAll();
    fitSoon();
    return undefined;
  }
  /** An empty shape: no starting outline. It is invalid (and not sent anywhere) until you add a polygon or circle. */
  function newEmpty(raw) {
    const key = raw.trim();
    addShape(key, []);
    if (st.sel === key) {
      st.editing = true;
      st.part = 0;
      renderAll();
      requestAnimationFrame(() => requestAnimationFrame(() => focus(key)));
    }
  }
  function rename(from, to) {
    const d = D();
    if (!KEY.test(to)) return fail('A shape name starts with a letter and uses letters, digits, _ and - only.');
    if (to === from) return undefined;
    if (d.shapes[to]) return fail(`"${to}" already exists.`);
    const entries = Object.entries(d.shapes).map(([k, v]) => [k === from ? to : k, v]);
    for (const k of Object.keys(d.shapes)) delete d.shapes[k];
    for (const [k, v] of entries) d.shapes[k] = v;
    if (d.shapeCategories && Object.hasOwn(d.shapeCategories, from)) {
      const cs = Object.entries(d.shapeCategories).map(([k, v]) => [k === from ? to : k, v]);
      for (const k of Object.keys(d.shapeCategories)) delete d.shapeCategories[k];
      for (const [k, v] of cs) d.shapeCategories[k] = v;
    }
    for (const L of d.levels) {
      L.initialBlocks.forEach((b) => { if (b.shape === from) b.shape = to; });
      L.shapes.forEach((s) => { if (s.shape === from) s.shape = to; });
    }
    const orig = renamedFrom[from] ?? (inFile(from) ? from : undefined); // (the name this shape has in _shapes.js: saving then renames it there too)
    delete renamedFrom[from];
    if (orig && orig !== to) renamedFrom[to] = orig;
    st.sel = to;
    st.msg = '';
    layout = null;
    api.touch('shapes');
    api.touch('levels');
    renderAll();
    return undefined;
  }
  const categoryOfSel = (key) => D().shapeCategories?.[key] ?? '';
  function setCategory(key, raw) {
    const d = D();
    const c = `${raw ?? ''}`.trim().slice(0, 40);
    const cats = (d.shapeCategories ??= {});
    if (c) cats[key] = c; else delete cats[key];
    api.touch('shapes');
    renderList();
  }
  function removeShape(key) {
    const d = D();
    const n = usage(key);
    if (n) return fail(`"${key}" is used in ${n} level${n > 1 ? 's' : ''}: replace it there first.`);
    if (keys().length <= 1) return fail('Keep at least one shape.');
    const at = keys().indexOf(key);
    delete d.shapes[key];
    if (d.shapeCategories) delete d.shapeCategories[key];
    st.sel = keys()[Math.min(at, keys().length - 1)];
    st.msg = '';
    layout = null;
    api.touch('shapes');
    renderAll();
    fitSoon();
    return undefined;
  }
  /** Apply fn([x, y]) -> [x, y] to every corner and circle centre, then move the lot so its lower left corner is 0,0. */
  function transform(fn) {
    const def = D().shapes[st.sel];
    for (const p of def) {
      if (p.type === 'circle') {
        const c = circleOf(p);
        const [x, y] = fn([c.x, c.y]);
        p.x = x;
        p.y = y;
      } else {
        p.points = ptsStr(parsePts(p.points).map(fn));
      }
    }
    toOrigin();
  }
  /** Scales every subshape (and circle position) from the shape's 0,0; a circle stays round (diameter by the geometric mean when X and Y differ). */
  const scaleBy = (kx, ky = kx) => {
    if (!(kx > 0 && ky > 0)) return fail('A scale must be a number above 0.');
    const def = D().shapes[st.sel];
    for (const p of def) {
      if (p.type === 'circle') { const c = circleOf(p); p.diameter *= Math.sqrt(kx * ky); p.x = c.x * kx; p.y = c.y * ky; } else p.points = ptsStr(parsePts(p.points).map(([x, y]) => [x * kx, y * ky]));
    }
    toOrigin();
    return undefined;
  };
  /** The transform menu for the whole shape: scale X / Y (linked by default) with the resulting size shown. */
  function transformMenu() {
    const def = D().shapes[st.sel];
    const b = boxOf(def);
    const w0 = b[2] - b[0];
    const h0 = b[3] - b[1];
    const t = st.tf;
    const info = h('span', { class: 'bb-dbg-note' });
    const upd = () => { info.textContent = `${f3(w0)} × ${f3(h0)}  →  ${f3(w0 * t.x)} × ${f3(h0 * t.y)}`; };
    const num = (label, key) => {
      const inp = h('input', { type: 'number', step: 'any', min: 0, value: t[key], style: 'width:72px' });
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!(v > 0)) return;
        t[key] = v;
        if (t.lock) { t.x = v; t.y = v; const o = inp.closest('details')?.querySelectorAll('input[type=number]'); o?.forEach((e) => { if (e !== inp) e.value = v; }); }
        upd();
      });
      return h('label', { class: 'bb-st-mini' }, label, inp);
    };
    const lock = h('input', { type: 'checkbox', checked: t.lock });
    lock.addEventListener('change', () => { t.lock = lock.checked; if (t.lock) { t.y = t.x; renderInspector(); } });
    upd();
    return h('details', { class: 'bb-st-tf', open: st.tfOpen ? '' : null, ontoggle: (e) => { st.tfOpen = e.currentTarget.open; } },
      h('summary', {}, 'Transform whole shape (scale)'),
      h('div', { class: 'bb-st-row' }, num('scale X', 'x'), num('scale Y', 'y'), h('label', { class: 'bb-st-mini', title: 'Keep X and Y the same (no stretching)' }, lock, 'link')),
      h('div', { class: 'bb-st-row' }, info),
      h('div', { class: 'bb-st-row' },
        btn('Apply', () => scaleBy(t.x, t.y), 'bb-dbg-go'),
        ...[0.5, 0.75, 1.5, 2].map((k) => btn(`×${k}`, () => scaleBy(k)))),
      h('p', { class: 'bb-dbg-note' }, 'Scales every subshape, circles and drawing-only outlines together, around the shape\'s 0,0 corner. Unlink X and Y to stretch (circles stay round).'));
  }
  /** Doubles the points of one polygon: a new corner in the middle of every edge (the outline does not change). */
  function doublePoints(i) {
    const p = D().shapes[st.sel]?.[i];
    if (!p || p.type === 'circle') return;
    const pts = parsePts(p.points);
    const out = [];
    pts.forEach((q, j) => { const n = pts[(j + 1) % pts.length]; out.push(q, [(q[0] + n[0]) / 2, (q[1] + n[1]) / 2]); });
    p.points = ptsStr(out);
    renderInspector();
    edited();
  }
  function toOrigin() {
    const def = D().shapes[st.sel];
    const b = boxOf(def);
    for (const p of def) {
      if (p.type === 'circle') {
        const c = circleOf(p);
        p.x = c.x - b[0];
        p.y = c.y - b[1];
      } else {
        p.points = ptsStr(parsePts(p.points).map(([x, y]) => [x - b[0], y - b[1]]));
      }
    }
    edited();
  }

  // ── panels ──
  const listEl = h('div', { class: 'bb-st-list' });
  const listHead = h('div', { class: 'bb-st-listhead' });
  const inspEl = h('div', { class: 'bb-st-insp' });
  const infoEl = h('div', { class: 'bb-st-info' });

  function renderList() {
    const d = D();
    const mats = Object.keys(d.materials).filter((m) => !d.materials[m].static);
    const nodes = [];
    let i = 0;
    for (const [cat, ks] of S.shapeGroups(keys(), d.shapeCategories ?? {})) {
      nodes.push(h('div', { class: 'bb-st-cat' }, `${cat} (${ks.length})`));
      for (const key of ks) {
        const n = usage(key);
        const color = matColor(d, st.mat === '(mixed)' ? mats[i++ % mats.length] : st.mat);
        nodes.push(h('button', { type: 'button', class: `bb-st-item${key === st.sel ? ' bb-on' : ''}`, onclick: () => { select(key); focus(key); } },
          thumb(d.shapes[key], color),
          h('span', { class: 'bb-st-itemname' }, key), n ? h('span', { class: 'bb-st-badge', title: `used in ${n} level(s)` }, `×${n}`) : null));
      }
    }
    put(listEl, ...nodes);
    const nameIn = h('input', { type: 'text', placeholder: 'new shape name', value: st.newName });
    nameIn.addEventListener('input', () => { st.newName = nameIn.value; });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') newEmpty(nameIn.value); });
    const renameIn = h('input', { type: 'text', value: st.sel ?? '', maxlength: 40 });
    renameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') rename(st.sel, renameIn.value.trim()); });
    const catIn = h('input', { type: 'text', list: 'bb-st-cats', maxlength: 40, placeholder: S.OTHER_CATEGORY, value: categoryOfSel(st.sel) });
    catIn.addEventListener('change', () => setCategory(st.sel, catIn.value));
    catIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') catIn.blur(); });
    const catList = h('datalist', { id: 'bb-st-cats' }, [...new Set(Object.values(d.shapeCategories ?? {}))].map((c) => h('option', { value: c })));
    put(listHead,
      h('div', { class: 'bb-st-row' }, nameIn, btn('New (empty)', () => newEmpty(nameIn.value))),
      st.sel ? h('div', { class: 'bb-st-row' },
        btn('Duplicate', () => { let n = `${st.sel}_copy`; for (let i = 2; D().shapes[n]; i++) n = `${st.sel}_copy${i}`; const cat = categoryOfSel(st.sel); addShape(n, clone(D().shapes[st.sel])); if (st.sel === n && cat) setCategory(n, cat); }),
        btn('Delete', () => removeShape(st.sel), 'bb-dbg-danger')) : null,
      st.sel ? h('div', { class: 'bb-st-row' }, h('span', { class: 'bb-st-mini' }, 'name'), renameIn, btn('Rename', () => rename(st.sel, renameIn.value.trim()), '', 'Rename this shape (also in the levels that use it). Saving it with Update shape renames it in the files too')) : null,
      st.sel ? h('div', { class: 'bb-st-row' }, h('span', { class: 'bb-st-mini' }, 'category'), catIn, catList) : null,
      st.sel ? h('div', { class: 'bb-st-row' }, h('span', { class: 'bb-st-mini' }, 'export'),
        btn('Copy', (e) => copyText(shapeSource(st.sel), e.currentTarget), '', 'Copy as a line for the shapes table in _shapes.js')) : null,
      st.msg ? h('div', { class: 'bb-dbg-err' }, st.msg) : null);
  }

  // ── export of ONE shape ──
  const shapeSource = (key) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${S.toSource(D().shapes[key])},\n`;

  const btn = (text, fn, cls = '', title = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, title, onclick: fn }, text);

  function renderInfo() {
    const def = D().shapes[st.sel];
    if (!def) return put(infoEl);
    const b = boxOf(def);
    let area = 0;
    for (const p of def) {
      if (p.visual) continue;
      if (p.cut) continue;
      area += (p.cut ? -1 : 1) * (p.type === 'circle' ? Math.PI * (p.diameter / 2) ** 2 : polyArea(parsePts(p.points)));
    }
    const concave = def.some((p) => p.type !== 'circle' && !p.visual && !p.cut && !isConvex(parsePts(p.points)));
    const n = usage(st.sel);
    let cutErr = null;
    if (def.some((p) => p.cut)) { try { S.buildShape(def, st.sel); } catch (e) { cutErr = String(e.message); } }
    put(infoEl,
      cutErr ? h('div', { class: 'bb-dbg-err' }, cutErr) : null,
      h('div', {}, `size ${f3(b[2] - b[0])} × ${f3(b[3] - b[1])} · area ${f3(area)} · used in ${n} level${n === 1 ? '' : 's'}`),
      concave ? h('div', { class: 'bb-dbg-err' }, 'A part is not convex (a corner points inwards). Split it into several convex parts, or fix the corner.') : null);
  }

  function renderInspector() {
    const d = D();
    const def = d.shapes[st.sel];
    if (!def) return put(inspEl, h('p', { class: 'bb-dbg-note' }, 'No shape selected.'));
    renderInfo();
    const toggle = st.editing
      ? btn('✓ Done editing', () => setEditing(false), 'bb-dbg-go')
      : btn('✎ Edit shape', () => setEditing(true), 'bb-dbg-go');
    if (!st.editing) {
      return put(inspEl,
        h('div', { class: 'bb-st-row' }, toggle, h('span', { class: 'bb-dbg-note' }, `${def.length} subshape${def.length === 1 ? '' : 's'}`)),
        h('p', { class: 'bb-dbg-note' }, 'Dragging shapes on the board only moves where they are drawn, to compare their size and fit with the others: nothing about the shape changes. Press Edit shape to work on its subshapes.'));
    }
    const rows = def.map((p, i) => {
      const head = h('div', { class: 'bb-st-row' }, h('strong', {}, `subshape ${i + 1}`), h('span', { class: 'bb-dbg-note' }, p.type === 'circle' ? 'circle' : `polygon, ${parsePts(p.points).length} points`), h('span', { class: 'bb-dbg-grow' }));
      const cutBox = h('input', { type: 'checkbox', checked: !!p.cut });
      cutBox.addEventListener('change', () => { if (cutBox.checked) { p.cut = true; delete p.visual; } else delete p.cut; edited(); renderInspector(); });
      head.append(h('label', { class: 'bb-dbg-chk', title: 'CSG: this subshape is cut away from the other subshapes (a rectangle out of a circle, a hole in a plate). The collision becomes convex pieces of what is left.' }, cutBox, 'cut'));
      if (p.type !== 'circle') {
        const vis = h('input', { type: 'checkbox', checked: !!p.visual });
        vis.addEventListener('change', () => { if (vis.checked) { p.visual = true; delete p.cut; } else delete p.visual; edited(); renderInspector(); });
        head.append(h('label', { class: 'bb-dbg-chk', title: 'A drawing-only outline: it replaces the other subshapes when the block is drawn (collision stays as it is)' }, vis, 'drawing only'));
      }
      head.append(btn('✕', () => removeSubshape(i), 'bb-dbg-danger'));
      let body;
      if (p.type === 'circle') {
        const mk = (label, get, set) => {
          const inp = h('input', { type: 'number', step: 'any', value: get() });
          inp.addEventListener('input', () => { const v = parseFloat(inp.value); if (Number.isFinite(v) && (label !== 'diameter' || v > 0)) { set(v); edited(true); } });
          inp.addEventListener('change', () => edited());
          return h('label', { class: 'bb-st-mini' }, label, inp);
        };
        body = h('div', { class: 'bb-st-row' }, mk('diameter', () => p.diameter, (v) => { p.diameter = v; }), mk('x', () => circleOf(p).x, (v) => { p.x = v; }), mk('y', () => circleOf(p).y, (v) => { p.y = v; }));
      } else {
        head.append(btn('Points ×2', () => doublePoints(i), '', 'Add a corner in the middle of every edge'));
        const ta = h('input', { type: 'text', value: p.points, spellcheck: 'false', class: 'bb-st-pts' });
        ta.addEventListener('input', () => { p.points = ta.value; api.touch('shapes'); scheduleDraw(); renderInfo(); });
        ta.addEventListener('change', () => edited());
        body = h('div', {}, ta);
      }
      head.addEventListener('click', (e) => { if (!e.target.closest('button,input,label') && i !== st.part) focusPart(i); });
      return h('div', { class: `bb-dbg-part${i === st.part ? ' bb-st-focus' : ''}` }, head, body);
    });
    put(inspEl,
      h('div', { class: 'bb-st-row' }, toggle),
      ...rows,
      h('div', { class: 'bb-st-row' },
        btn('+ polygon', startDraw),
        btn('+ circle', () => { def.push({ type: 'circle', diameter: 2 }); st.part = def.length - 1; edited(); })),
      h('div', { class: 'bb-st-row' },
        h('span', { class: 'bb-st-mini' }, 'whole shape'),
        btn('Mirror ↔', () => transform(([x, y]) => [-x, y])),
        btn('Mirror ↕', () => transform(([x, y]) => [x, -y])),
        btn('Rotate 90°', () => transform(([x, y]) => [-y, x])),

        btn('To 0,0', toOrigin)),
      transformMenu(),
      h('p', { class: 'bb-dbg-note' }, 'Editing: drag a subshape to move it (all its points move together) · Delete removes the selected subshape · drag a corner to move it · click a small dot on an edge to insert a corner · right-click a corner to remove it. + polygon: click the board to put down points 1, 2, 3 …, then Enter, click the first point, or Done (Backspace removes the last point, Esc cancels). Shift-drag moves the whole shape on the board only. Every subshape must be convex: build an L or a plus from several subshapes and, if you like, add a "drawing only" outline for the looks.'));
    return undefined;
  }

  // ── the screen ──
  const sel = (options, value, onchange) => {
    const s = h('select', {}, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v }, l); }));
    s.value = value;
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };
  const head = h('div', { class: 'bb-st-head' });
  const probEl = h('span', { class: 'bb-st-prob' });
  const renderProb = () => api.showProblems(probEl);
  const renamedFrom = {}; // new name -> the name in _shapes.js
  const inFile = (key) => Object.hasOwn(view.debugRoomDefs()?.shapes ?? {}, key); // is this shape in _shapes.js (as far as the room knows)?
  function saveShape() {
    const key = st.sel;
    const value = D().shapes[key];
    if (!value) return;
    if (api.problems().length) { st.msg = `Fix this first: ${api.problems()[0]}`; renderList(); return; }
    const was = renamedFrom[key];
    const add = !inFile(key) && !was;
    confirmDialog({
      title: add ? 'Add shape' : 'Update shape',
      text: add
        ? `Are you sure you want to add shape “${key}”? It is written to _shapes.js and every room gets it.`
        : was
          ? `Are you sure you want to rename shape “${was}” to “${key}”? It is renamed in _shapes.js and in every level of _levels.js that uses it, and every room gets the change.`
          : `Are you sure you want to update shape “${key}”? It replaces the shape in _shapes.js and every room gets the new version.`,
      label: add ? 'Add shape' : 'Update shape',
      run: () => api.saveItem({ kind: 'shape', op: add ? 'add' : 'update', key, was, value: clone(value), category: D().shapeCategories?.[key] ?? '' }),
      onDone: (r) => { delete renamedFrom[key]; st.msg = ''; st.saved = add ? `Shape “${key}” was added to ${r.file}.` : `Shape “${key}” was updated in ${r.file}.`; renderHead(); },
    });
  }
  function renderHead() {
    const d = D();
    renderProb();
    put(head,
      h('strong', {}, 'Shape studio'),
      d.shapes[st.sel] ? btn(inFile(st.sel) ? 'Update shape' : 'Add shape', saveShape, 'bb-dbg-go', inFile(st.sel) ? 'Replace this shape in _shapes.js (asks to confirm first)' : 'Add this shape to _shapes.js (asks to confirm first)') : null,
      st.saved ? h('span', { class: 'bb-st-msg' }, st.saved) : null,
      st.draw ? btn('Done ⏎', finishDraw, 'bb-dbg-go') : btn('+ Polygon', startDraw, 'bb-dbg-go'),
      st.draw ? btn('Cancel', cancelDraw) : null,
      h('label', { class: 'bb-st-mini', title: 'Clicking the first point again closes the polygon and finishes it' }, h('input', { type: 'checkbox', checked: st.closeOnFirst, onchange: (e) => { st.closeOnFirst = e.target.checked; scheduleDraw(); } }), 'click first point to finish'),
      h('label', { class: 'bb-st-mini', title: 'On (default): the subshapes are joined in 2D and extruded as one block, without seams. Collision always uses the separate parts. (Same as Settings → mergeParts)' },
        h('input', { type: 'checkbox', checked: d.tuning.mergeParts !== false, onchange: (e) => { d.tuning.mergeParts = e.target.checked; api.touch('tuning'); } }), 'merge parts'),
      h('label', { class: 'bb-st-mini' }, 'snap', sel(SNAPS, String(st.snap), (v) => { st.snap = parseFloat(v); })),
      h('label', { class: 'bb-st-mini' }, 'material', sel(['(mixed)', ...Object.keys(d.materials)], st.mat, (v) => { st.mat = v; renderList(); scheduleDraw() })),
      h('label', { class: 'bb-st-mini' }, 'bowl', sel(Object.keys(d.bowls), bowlKey(), (v) => { st.bowl = v; layout = null; scheduleDraw() })),
      btn('Tidy', () => { manual = {}; layout = null; relayout(); board.fit(layout.bounds); scheduleDraw(); }),
      btn('Fit all', () => { board.fit(layout.bounds); scheduleDraw(); }),
      btn('Zoom to shape', () => focus()),
      h('span', { class: 'bb-dbg-grow' }),
      probEl,
      btn('Level studio', () => api.open('levels')),
      btn('✕ Close', () => api.close()));
  }

  // ── previews of the CALCULATED shape: rounded, cuts taken out, and how it is split into convex pieces for collision. Both are off until you ask: the 2D
  // one lies over the shape on the board, the 3D one is a small window that exists only while it is shown. Neither is calculated while you are still
  // changing the shape: they wait until it has been still for a moment. ──
  const host3d = h('div', { class: 'bb-st-3d bb-hide' });
  const err3d = h('div', { class: 'bb-dbg-err bb-hide' });
  const previewRow = h('div', { class: 'bb-st-row' });
  let pv = null;
  let pvTimer = 0;
  let calcTimer = 0;
  function renderPreviewBar() {
    put(previewRow,
      h('span', { class: 'bb-st-mini' }, 'preview'),
      btn(st.calc ? '▣ 2D shown' : '▢ 2D', () => set2d(!st.calc), st.calc ? 'bb-dbg-go' : '', 'Show the shape as it is calculated: the rounded outline the block has, and the convex pieces its collision is made of'),
      view.debugShape3d ? btn(st.show3d ? '▣ 3D shown' : '▢ 3D', () => set3d(!st.show3d), st.show3d ? 'bb-dbg-go' : '', 'A small 3D view of the block. Drag it to turn it. It only exists while it is shown, and follows your changes when you stop moving') : null);
  }
  function set2d(on) {
    st.calc = on;
    clearTimeout(calcTimer);
    calcTimer = 0;
    renderPreviewBar();
    scheduleDraw();
  }
  function bumpCalc() {
    if (!st.calc) return;
    clearTimeout(calcTimer);
    calcTimer = setTimeout(() => { calcTimer = 0; scheduleDraw(); }, 200);
  }
  function pvRefresh(now = false) {
    clearTimeout(pvTimer);
    pvTimer = 0;
    if (!pv) return;
    const run = () => {
      pvTimer = 0;
      if (!pv) return;
      const def = D().shapes[st.sel];
      const msg = def ? pv.update(def) : 'No shape selected.';
      err3d.textContent = msg;
      err3d.classList.toggle('bb-hide', !msg);
    };
    if (now) run(); else pvTimer = setTimeout(run, 250);
  }
  function set3d(on) {
    if (on === !!pv) { st.show3d = on; return; }
    st.show3d = on;
    if (on) {
      host3d.classList.remove('bb-hide');
      try {
        pv = view.debugShape3d(host3d);
      } catch (e) {
        pv = null;
        st.show3d = false;
        host3d.classList.add('bb-hide');
        err3d.textContent = `The 3D view could not start: ${e?.message ?? e}`;
        err3d.classList.remove('bb-hide');
      }
      pvRefresh(true);
    } else {
      clearTimeout(pvTimer);
      pvTimer = 0;
      pv?.dispose();
      pv = null;
      host3d.classList.add('bb-hide');
      err3d.classList.add('bb-hide');
    }
    renderPreviewBar();
  }

  const right = h('div', { class: 'bb-st-right' },
    h('div', { class: 'bb-st-preview' }, previewRow, host3d, err3d), infoEl, inspEl);
  const root = h('div', { class: 'bb-st bb-st-full' },
    head,
    h('div', { class: 'bb-st-cols' }, h('div', { class: 'bb-st-left' }, listHead, listEl), h('div', { class: 'bb-st-board' }, board.el), right));

  board.el.addEventListener('dblclick', (e) => {
    const sh = e.target.closest?.('[data-shape]');
    if (sh) { select(sh.dataset.shape); focus(); }
  });

  function renderAll() {
    const d = D();
    if (!d.shapes[st.sel]) st.sel = keys()[0] ?? null;
    renderHead();
    renderList();
    renderInspector();
    scheduleDraw();
  }

  return {
    el: root,
    show() {
      st.open = true;
      root.classList.add('bb-show');
      layout = null;
      st.sel = D().shapes[st.sel] ? st.sel : keys()[0];
      renderAll();
      renderPreviewBar();
      requestAnimationFrame(() => { relayout(); board.fit(layout.bounds); scheduleDraw(); });
    },
    hide() {
      cancelDraw();
      set3d(false); // (the 3D window gives its WebGL context back)
      st.open = false;
      root.classList.remove('bb-show');
    },
    /** The draft changed (by this studio, another tab of the menu, or another player). */
    changed(kind, live = false) {
      if (!st.open) return;
      if (kind === 'shapes' || kind === 'tuning' || kind === 'all') { bumpCalc(); pvRefresh(); }
      if (live && kind === 'shapes') { // dragging a corner: only the board follows the mouse; the list of thumbnails is rebuilt when the mouse is still
        scheduleDraw();
        clearTimeout(listTimer);
        listTimer = setTimeout(() => { listTimer = 0; if (st.open) { renderProb(); renderList(); } }, 200);
        return;
      }
      renderProb();
      if (kind === 'shapes' || kind === 'materials' || kind === 'bowls' || kind === 'tuning' || kind === 'all') {
        if (kind === 'all') layout = null;
        if (!layout) relayout();
        renderList();
        scheduleDraw();
          }
    },
    refresh() {
      layout = null;
      if (st.open) renderAll();
    },
    dispose() {
      this.hide();
      window.removeEventListener('keydown', onKey);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
//  LEVEL STUDIO
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
function levelStudio(view, api) {
  const st = { lvl: 0, mode: 'layout', sel: -1, snap: 0.25, mat: 'wood', open: false, lab: -1, ph: 1, rules: false, msg: '', armDelete: 0 };
  let applyTimer = 0;
  let raf = 0;
  let live = null; // a block we are carrying in live mode: { rot, off, x, y, last }

  const D = () => api.draft();
  const L = () => D().levels[st.lvl];
  const lab = (c) => view.debugSend({ lab: c }); // (the local game only: debugSend never reaches the room)
  const snapV = (v) => snapTo(v, st.snap);
  const btn = (text, fn, cls = '', title = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, title, onclick: fn }, text);
  const sel = (options, value, onchange, cls = '') => {
    const s = h('select', { class: cls }, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v }, l); }));
    s.value = value;
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };
  const nonStatic = () => Object.keys(D().materials);

  // ── the lab of the local game (everything here stays in this page) ──
  /** Give the draft to the local game, then restart the level in it so it shows the draft (the lab stays on, and frozen in layout mode). */
  function applyNow() {
    clearTimeout(applyTimer);
    applyTimer = 0;
    if (!st.open) return;
    timed('syncNow', () => api.syncNow());
    if (api.problems().length || !L()) {
      if (api.problems().length) { st.msg = `Not shown in the test until this is fixed: ${api.problems()[0]}`; renderBar(); }
      return;
    }
    if (st.msg.startsWith('Not shown')) { st.msg = ''; renderBar(); }
    timed('restart level', () => { lab({ play: st.lvl }); lab({ paused: st.mode === 'layout' }); });
  }
  // A DEBOUNCE: while a block is being dragged the blueprint (cheap, 2D) follows the mouse, but the 3D game is only rebuilt once the mouse has been still for
  // SYNC_QUIET ms (and when the button is released). Restarting the level rebuilds every block mesh, which is far too heavy to do while moving.
  // Timings: run  window.bbPerf = true  in the console to see how long each step takes (nothing is stored).
  const SYNC_QUIET = 180;
    const timed = (name, fn) => { if (!window.bbPerf) return fn(); const t = performance.now(); const r = fn(); console.debug(`[bbPerf] ${name}: ${(performance.now() - t).toFixed(1)} ms`); return r; };
  function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { applyTimer = 0; applyNow(); }, SYNC_QUIET);
  }
  /** Layout: give the draft to the local game and restart the frozen layout with it. Live test: only give it (the running test is not disturbed). */
  function scheduleSync() {
    if (st.mode === 'layout') return scheduleApply();
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => { applyTimer = 0; if (st.open) timed('syncNow', () => api.syncNow()); }, SYNC_QUIET);
    return undefined;
  }

  // ── blueprint ──
  const bowlOfLevel = () => bowlFull(D(), L()?.bowl in D().bowls ? L().bowl : Object.keys(D().bowls)[0]);
  function bounds() {
    const bowl = bowlOfLevel();
    const zone = { ...D().tuning.zone, ...L()?.zone };
    return [Math.min(zone.x0, -bowl.a) - 6, S.groundYOf(bowl) - 3, Math.max(zone.x1, bowl.a) + 6, 30];
  }

  const board = makeBoard({
    down(w, e) {
      const l = L();
      if (!l) return null;
      const node = e.target.closest?.('[data-i],[data-id]');
      if (st.mode === 'layout') {
        if (!node || node.dataset.i === undefined) {
          st.sel = -1;
          renderBody();
          scheduleDraw();
          return null;
        }
        const i = +node.dataset.i;
        const b = l.initialBlocks[i];
        st.sel = i;
        renderBody();
        scheduleDraw(); // (the selection outline: without this it only appeared at the next redraw, e.g. after a zoom or a move)
        const off = { x: w.x - b.x, y: w.y - b.y };
        return { move(q) { b.x = snapV(q.x - off.x); b.y = snapV(q.y - off.y); api.touch('levels', false, true); scheduleDraw(); }, up() { renderBody(); } };
      }
      // live test: grab a block of the running level
      if (!node || node.dataset.id === undefined) return null;
      const id = +node.dataset.id;
      const body = view.snap?.b.find((r) => r[0] === id);
      if (!body || body[6] === S.BODY.HELD || body[6] === S.BODY.HELD_BAD) return null;
      lab({ grab: id });
      return startLive({ x: body[3], y: body[4], rot: deg(body[5]), off: { x: w.x - body[3], y: w.y - body[4] } });
    },
    resized() { scheduleDraw(); },
  });

  function scheduleDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function blockNode(d, shapeKey, materialKey, x, y, rotRad, attrs, style = {}) {
    const def = d.shapes[shapeKey];
    if (!def) return null;
    const grp = svg('g', { transform: `translate(${x} ${y}) rotate(${deg(rotRad)})`, ...attrs });
    const built0 = built(def);
    if (!built0) return grp;
    const static_ = d.materials[materialKey]?.static;
    const common = { fill: matColor(d, materialKey), stroke: style.stroke ?? (static_ ? '#374151' : '#3b2a14'), 'stroke-width': style.width ?? 1.1, 'vector-effect': 'non-scaling-stroke', opacity: style.opacity ?? 0.93, ...(style.dash ? { 'stroke-dasharray': style.dash } : {}) };
    if (built0.visual) { // the block as it is in the game: rounded (and the collision is the same outline)
      const loop = (pts) => `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}Z`;
      grp.append(svg('path', { d: built0.visual.map((v) => [v.pts, ...(v.holes ?? [])].map(loop).join('')).join(''), 'fill-rule': 'evenodd', ...common }));
    } else {
      for (const p of built0.parts) grp.append(p.type === 'circle' ? svg('circle', { cx: p.cx, cy: p.cy, r: p.r, ...common }) : svg('polygon', { points: p.pts.map((q) => q.join(',')).join(' '), ...common }));
    }
    if (static_) grp.append(svg('circle', { cx: 0, cy: 0, r: 0.18, fill: '#111827', opacity: 0.6 }));
    return grp;
  }

  function draw() {
    if (!st.open) return;
    const d = D();
    const l = L();
    const g = board.g;
    g.replaceChildren();
    if (!l) return;
    const { k } = board.v;
    const px = 1 / k;
    const bowl = bowlOfLevel();
    const gY = S.groundYOf(bowl);
    const zone = { ...d.tuning.zone, ...l.zone };
    const drop = { ...d.tuning.drop, ...l.drop };
    const vw = board.view();
    drawGrid(g, vw, 1, px);
    const top = Math.min(drop.y1, vw.y1 + 2);
    g.append(
      svg('rect', { x: drop.x0, y: drop.y0, width: Math.max(0, drop.x1 - drop.x0), height: Math.max(0, top - drop.y0), fill: 'rgba(52,211,153,.07)', stroke: '#34d399', 'stroke-dasharray': '5 4', 'vector-effect': 'non-scaling-stroke' }),
      svg('line', { x1: zone.x0, x2: zone.x0, y1: gY - 3, y2: 60, stroke: '#ef4444', 'stroke-dasharray': '2 4', 'vector-effect': 'non-scaling-stroke' }),
      svg('line', { x1: zone.x1, x2: zone.x1, y1: gY - 3, y2: 60, stroke: '#ef4444', 'stroke-dasharray': '2 4', 'vector-effect': 'non-scaling-stroke' }),
      svg('rect', { x: Math.min(zone.x0, -bowl.a) - 40, y: gY - 4, width: Math.max(zone.x1, bowl.a) - Math.min(zone.x0, -bowl.a) + 80, height: 4, fill: '#8a6a43', opacity: 0.85 }),
    );
    drawBowl(g, bowl);
    const label = (text, x, y, size, fill) => svg('text', { transform: `translate(${x} ${y}) scale(1 -1)`, 'font-size': size * px, fill, 'font-family': 'system-ui, sans-serif' }, text);
    g.append(label('drop zone', drop.x0 + 0.4, Math.min(top, vw.y1) - 1.6, 10.5, '#34d399'), label('limit', zone.x0 + 0.4, vw.y1 - 3.4, 10.5, '#f87171'), label('limit', zone.x1 - 3.6, vw.y1 - 3.4, 10.5, '#f87171'));

    if (st.mode === 'layout') {
      l.initialBlocks.forEach((b, i) => {
        const node = blockNode(d, b.shape, b.material, b.x, b.y, ((b.rot ?? 0) * Math.PI) / 180, { 'data-i': i, class: 'bb-st-block' }, i === st.sel ? { stroke: ACCENT, width: 2.4 } : {});
        if (node) g.append(node);
      });
    } else {
      for (const [id, si, mi, x, y, a, state] of view.snap?.b ?? []) {
        const held = state === S.BODY.HELD || state === S.BODY.HELD_BAD;
        const node = blockNode(d, S.SHAPE_KEYS[si], S.MATERIAL_KEYS[mi], x, y, a, { 'data-id': id, class: 'bb-st-block' }, held ? { opacity: 0.55, dash: '4 3', stroke: ACCENT, width: 2 } : {});
        if (node) g.append(node);
      }
    }
  }

  // ── live carrying: the blueprint is the controller of a block held on the server ──
  function startLive({ x, y, rot, off }) {
    live = { rot, off, x, y, last: 0 };
    const send = (force) => {
      const now = performance.now();
      if (!force && now - live.last < 33) return;
      live.last = now;
      view.debugSend({ x: Math.round(live.x * 100) / 100, y: Math.round(live.y * 100) / 100, rot: Math.round(live.rot * 10) / 10 });
    };
    live.send = send;
    return {
      move(q) { live.x = q.x - live.off.x; live.y = q.y - live.off.y; send(false); },
      up(q) { if (q) { live.x = q.x - live.off.x; live.y = q.y - live.off.y; } send(true); view.debugSend({ drop: true }); live = null; },
    };
  }
  /** A palette thumbnail was pressed. Live: a new block appears in your hand. Layout: drag = a block in the start layout, click = add to the blocks to place. */
  function paletteDown(e, shape) {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let drag = null;
    const fromPointer = (ev) => (board.inside(ev.clientX, ev.clientY) ? board.worldAt(ev.clientX, ev.clientY) : null);
    if (st.mode === 'live') {
      const w0 = fromPointer(e) ?? { x: 0, y: 14 };
      lab({ spawn: { shape, material: st.mat, x: w0.x, y: w0.y, rot: 0 } });
      drag = startLive({ x: w0.x, y: w0.y, rot: 0, off: { x: 0, y: 0 } });
    }
    const move = (ev) => {
      const w = fromPointer(ev);
      if (st.mode === 'layout') {
        if (!drag && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
          const l = L();
          const w1 = w ?? { x: 0, y: 8 };
          l.initialBlocks.push({ shape, material: st.mat, rot: 0, x: snapV(w1.x), y: snapV(w1.y) });
          st.sel = l.initialBlocks.length - 1;
          const b = l.initialBlocks[st.sel];
          drag = { move(q) { b.x = snapV(q.x); b.y = snapV(q.y); api.touch('levels', false, true); scheduleDraw(); }, up() { renderBody(); } };
          api.touch('levels');
          renderBody();
        }
      }
      if (drag && w) drag.move(w, ev);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (drag) drag.up(fromPointer(ev), ev);
      else if (st.mode === 'layout' && L()) { // a click
        L().shapes.push({ shape, material: st.mat === 'static' ? 'wood' : st.mat });
        api.touch('levels');
        renderBody();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function capture() {
    const l = L();
    const bodies = (view.snap?.b ?? []).filter((r) => r[6] !== S.BODY.HELD && r[6] !== S.BODY.HELD_BAD);
    l.initialBlocks = bodies.map(([, si, mi, x, y, a]) => {
      let r = Math.round(deg(a) * 10) / 10;
      r = ((((r + 180) % 360) + 360) % 360) - 180;
      return { shape: S.SHAPE_KEYS[si], material: S.MATERIAL_KEYS[mi], rot: r, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    });
    st.sel = -1;
    st.msg = `Captured ${bodies.length} block${bodies.length === 1 ? '' : 's'} as the start layout.`;
    api.touch('levels'); // first the new layout goes to the local game ...
    setMode('layout'); //   ... then the level restarts with it
  }

  function setMode(m) {
    st.mode = m;
    if (live) { view.debugSend({ cancel: true }); live = null; }
    if (m === 'layout') applyNow(); // restart with the draft, frozen
    else applyNow(); // always restart from the layout as it is now (not only when an edit is still waiting), with gravity on
    renderAll();
  }

  // ── panel ──
  const head = h('div', { class: 'bb-st-head bb-st-topbar' });
  const bar = h('div', { class: 'bb-st-bar' });
  const palette = h('div', { class: 'bb-st-palette' });
  const body = h('div', { class: 'bb-st-body' });

  const probEl = h('span', { class: 'bb-st-prob' });
  // Which levels of the draft are in _levels.js already? A level object that was in the file keeps its place in it (by object, so reordering, renaming or deleting other
  // levels does not confuse it); a level made here (New, Copy) is new until it has been added. First match is by name, when the studio opens or the draft is replaced.
  // A draft level knows the level of _levels.js it came from by its world and name (not by its place in the list, which changes when levels are added or ordered).
  const origin = new WeakMap(); // draft level -> { name, world, pending?: index }
  const fileLevels = () => view.debugRoomDefs()?.levels ?? [];
  const fileWorlds = () => view.debugRoomDefs()?.worlds ?? D().worlds;
  const worldKeyIn = (lv, worlds) => (lv.world && worlds[lv.world] ? lv.world : Object.keys(worlds)[0]);
  /** Where is the file version of this draft level in the room's list of levels? undefined = it is not in the file (yet). */
  function fileIndexOf(lv) {
    const o = origin.get(lv);
    if (!o) return undefined;
    const W = fileWorlds();
    const i = fileLevels().findIndex((f) => f.name === o.name && worldKeyIn(f, W) === o.world);
    if (i >= 0) { delete o.pending; return i; }
    return o.pending; // (just saved: the room's list has not arrived yet)
  }
  function syncOrigins() {
    const file = fileLevels();
    const W = fileWorlds();
    const taken = new Set(D().levels.map((lv) => fileIndexOf(lv)).filter((i) => i !== undefined));
    for (const lv of D().levels) {
      if (fileIndexOf(lv) !== undefined) continue;
      const wk = worldKeyIn(lv, D().worlds);
      const j = file.findIndex((f, i) => !taken.has(i) && f.name === lv.name && worldKeyIn(f, W) === wk);
      if (j >= 0) { origin.set(lv, { name: lv.name, world: wk }); taken.add(j); }
    }
  }
  const worldName = (lv) => { const w = D().worlds ?? {}; const key = lv.world in w ? lv.world : Object.keys(w)[0]; return w[key]?.name ?? key ?? '(none)'; };
  function saveLevel() {
    const lv = L();
    if (!lv) return;
    if (api.problems().length) { st.msg = `Fix this first: ${api.problems()[0]}`; renderBar(); return; }
    syncOrigins();
    const at = fileIndexOf(lv);
    const add = at === undefined;
    const was = add ? undefined : fileLevels()[at]?.name;
    const value = clone(lv);
    confirmDialog({
      title: add ? 'Add level' : 'Update level',
      text: add
        ? `Are you sure you want to add level “${lv.name}” to world “${worldName(lv)}”? It is written to _levels.js and every room gets it.`
        : `Are you sure you want to update level “${lv.name}” in world “${worldName(lv)}”? It replaces the level in _levels.js and every room gets the new version.`,
      label: add ? 'Add level' : 'Update level',
      run: () => api.saveItem({ kind: 'level', op: add ? 'add' : 'update', index: at, was, value, worldDef: value.world ? clone(D().worlds[value.world] ?? null) : null }),
      onDone: (r) => {
        origin.set(lv, { name: lv.name, world: worldKeyIn(lv, D().worlds), pending: r.index });
        st.msg = add ? `Level “${lv.name}” was added to ${r.file}.` : `Level “${lv.name}” was updated in ${r.file}.`;
        renderHead();
        renderBar();
      },
    });
  }
  /** The order menu; when its order is saved the draft follows it (the draft's own list of levels is only used by the studio). */
  function openOrder() {
    orderDialog(view, api, ({ worlds, ids }) => {
      const d = D();
      const cur = d.levels[st.lvl];
      const wRank = [...worlds, ...Object.keys(d.worlds).filter((k) => !worlds.includes(k))];
      const idOf = (lv) => { const o = origin.get(lv); return `${o?.world ?? worldKeyIn(lv, d.worlds)}|${o?.name ?? lv.name}`; };
      const sorted = d.levels
        .map((lv, i) => [lv, i, wRank.indexOf(worldKeyIn(lv, d.worlds)), ids.indexOf(idOf(lv))])
        .sort((a, b) => a[2] - b[2] || (a[3] < 0 ? 1e6 : a[3]) - (b[3] < 0 ? 1e6 : b[3]) || a[1] - b[1])
        .map(([lv]) => lv);
      d.levels.splice(0, d.levels.length, ...sorted);
      const reordered = Object.fromEntries(wRank.map((k) => [k, d.worlds[k]]).filter(([, w]) => w));
      for (const k of Object.keys(d.worlds)) delete d.worlds[k];
      Object.assign(d.worlds, reordered);
      st.lvl = Math.max(0, d.levels.indexOf(cur));
      st.msg = 'The level order was saved to _levels.js.';
      api.touch('worlds');
      api.touch('levels');
      renderAll();
    });
  }
  /** Two selects: the world, and the level within that world (a level without a world is in the first world). */
  function levelSelects(d) {
    const wkeys = Object.keys(d.worlds);
    const worldOf = (lv) => (lv.world && d.worlds[lv.world] ? lv.world : wkeys[0]);
    const cur = d.levels[st.lvl];
    const curWorld = cur ? worldOf(cur) : wkeys[0];
    const inWorld = (k) => d.levels.map((lv, i) => [lv, i]).filter(([lv]) => worldOf(lv) === k);
    const shown = wkeys.filter((k) => k === curWorld || inWorld(k).length > 0);
    const go = (i) => { st.lvl = i; st.sel = -1; fitSoon(); applyNow(); renderAll(); };
    return [
      sel(shown.map((k) => [k, `${d.worlds[k].name ?? k} (${inWorld(k).length})`]), curWorld, (k) => { const first = inWorld(k)[0]; if (first) go(first[1]); }, 'bb-st-lvsel'),
      sel(inWorld(curWorld).map(([lv, i], n) => [String(i), `${n + 1}. ${lv.name}`]), String(st.lvl), (v) => go(+v), 'bb-st-lvsel'),
    ];
  }

  function renderHead() {
    const d = D();
    api.showProblems(probEl);
    syncOrigins();
    put(head,
      h('strong', {}, 'Level studio'),
      ...levelSelects(d),
      btn('New', newLevel), btn('Copy', copyLevel),
      btn('▶ Playtest', () => api.playtest(st.lvl), 'bb-dbg-go'),
      btn(fileIndexOf(L()) === undefined ? 'Add level' : 'Update level', saveLevel, 'bb-dbg-go', fileIndexOf(L()) === undefined ? 'Add this level to the end of its world in _levels.js (asks to confirm first)' : 'Replace this level in _levels.js (asks to confirm first)'),
      btn('Level order', openOrder, '', 'Change the order of the levels in each world (and of the worlds) and save it to _levels.js'),
      btn('Export ⧉', (e) => copyText(`${S.toSource(d.levels[st.lvl])},\n`, e.currentTarget), '', 'Copy this level as a source entry for the levels list in _definitions.js'),
      btn(st.armDelete ? 'Really?' : 'Delete', deleteLevel, 'bb-dbg-danger'),
      probEl,
      btn('Shapes', () => api.open('shapes')),
      h('button', { type: 'button', class: 'bb-dbg-btn bb-st-x', title: 'Close the studio', onclick: () => api.close() }, '✕'));
  }

  function renderBar() {
    const paused = view.snap?.lab === 2;
    put(bar,
      h('div', { class: 'bb-st-seg' },
        h('button', { type: 'button', class: st.mode === 'layout' ? 'bb-on' : '', onclick: () => st.mode !== 'layout' && setMode('layout'), title: 'Edit the start layout: the game shows it frozen' }, 'Layout'),
        h('button', { type: 'button', class: st.mode === 'live' ? 'bb-on' : '', onclick: () => st.mode !== 'live' && setMode('live'), title: 'Gravity on: spawn, grab and move blocks, test the level' }, 'Live test')),
      st.mode === 'live'
        ? [
          btn(paused ? '▶ Gravity on' : '⏸ Freeze', () => lab({ paused: !paused }), paused ? 'bb-dbg-go' : ''),
          btn('⟲ Reset', () => { st.msg = ''; applyNow(); }),
          h('label', { class: 'bb-dbg-chk', title: 'Off: nothing is won or lost while you test. On: the level can be failed (block in the water, out of bounds, touching the bowl) or won, like in the real game. Press Reset to try again.' },
            (() => { const c = h('input', { type: 'checkbox', checked: st.rules }); c.addEventListener('change', () => { st.rules = c.checked; lab({ rules: st.rules }); }); return c; })(), 'fail enabled'),
          btn('⤓ Capture as start layout', capture, 'bb-dbg-go'),
        ]
        : [btn('Restart test', () => applyNow(), 'bb-dbg-go'), btn('Fit', () => board.fit(bounds()))],
      h('label', { class: 'bb-st-mini' }, 'snap', sel(SNAPS, String(st.snap), (v) => { st.snap = parseFloat(v); })),
      h('div', { class: 'bb-st-hint' }, st.mode === 'live'
        ? 'Drag a shape from the palette into the bowl (or click it to drop it at the top). Drag any block to move it, Q / E or the wheel turn what you hold, Esc deletes it. Freeze gravity to place things precisely, then switch it on.'
        : 'Drag blocks to move them, Q / E turn the selected one, Delete removes it. Drag a palette shape into the blueprint to add a start block; click it to add it to the blocks to place.'),
      st.msg ? h('div', { class: 'bb-st-hint bb-st-msg' }, st.msg) : null);
  }

  function renderPalette() {
    const d = D();
    put(palette,
      h('div', { class: 'bb-st-row' }, h('span', { class: 'bb-st-mini' }, 'palette'), h('label', { class: 'bb-st-mini' }, 'material', sel(nonStatic(), st.mat, (v) => { st.mat = v; renderPalette(); }))),
      h('div', { class: 'bb-st-strip' }, S.shapeGroups(Object.keys(d.shapes), d.shapeCategories ?? {}).flatMap(([cat, ks]) => [
        h('div', { class: 'bb-st-strip-cat' }, `${cat} (${ks.length})`),
        ...ks.map((key) => h('button', { type: 'button', class: 'bb-st-chip', title: `${key} · ${cat}`, onpointerdown: (e) => paletteDown(e, key) }, thumb(d.shapes[key], matColor(d, st.mat), 50, 36), h('span', {}, key))),
      ])));
  }

  /** The shape of a start block / block to place: a select grouped by category, and a button for the dialog with all shapes. */
  const shapeField = (obj) => h('span', { class: 'bb-st-shapefield' },
    shapeSelect(D(), obj.shape, (v) => { obj.shape = v; api.touch('levels'); renderBody(); }),
    h('button', {
      type: 'button',
      class: 'bb-dbg-btn',
      title: 'See all shapes',
      onclick: () => shapePicker(D(), obj.shape, matColor(D(), obj.material), (k) => { obj.shape = k; api.touch('levels'); renderBody(); scheduleDraw(); }),
    }, '▦'));
  const mini = (options, obj, key) => sel(options, obj[key], (v) => { obj[key] = v; api.touch('levels'); });
  const numIn = (obj, key, step, cb) => {
    const i = h('input', { type: 'number', step, class: 'bb-dbg-n', value: obj[key] ?? 0 });
    i.addEventListener('input', () => { const v = parseFloat(i.value); if (Number.isFinite(v)) { obj[key] = v; api.touch('levels'); cb?.(); } });
    return i;
  };

  function renderBody() {
    const d = D();
    const l = L();
    if (!l) return put(body, h('p', { class: 'bb-dbg-note' }, 'There are no levels yet. Press New.'));
    const w = api.w;
    const shapesList = Object.keys(d.shapes);
    const matList = Object.keys(d.materials);
    const out = [];

    // properties
    const zoneOn = !!l.zone;
    const dropOn = !!l.drop;
    out.push(w.section('Level',
      w.text('name', l, 'name', 'levels'),
      w.select('world', [['', `(first world: ${d.worlds[Object.keys(d.worlds)[0]]?.name ?? ''})`], ...Object.keys(d.worlds).map((k) => [k, `${d.worlds[k].name} (${k})`])], l, 'world', 'levels', renderHead),
      w.select('difficulty', ['easy', 'medium', 'hard'], l, 'difficulty', 'levels'),
      w.select('bowl', Object.keys(d.bowls), l, 'bowl', 'levels', renderAll),
      w.select('background', Object.keys(d.backgrounds), l, 'background', 'levels'),
      w.num('blocks on the table', l, 'chooseShapes', 'levels', { min: 1, max: 8, int: true }),
      w.field('own side limits', (() => {
        const c = h('input', { type: 'checkbox', checked: zoneOn });
        c.addEventListener('change', () => { if (c.checked) l.zone = { ...D().tuning.zone }; else delete l.zone; api.touch('levels'); renderBody(); });
        return c;
      })(), zoneOn ? numIn(l.zone, 'x0', 1, scheduleDraw) : null, zoneOn ? numIn(l.zone, 'x1', 1, scheduleDraw) : null),
      w.field('own drop zone', (() => {
        const c = h('input', { type: 'checkbox', checked: dropOn });
        c.addEventListener('change', () => { if (c.checked) l.drop = { ...D().tuning.drop }; else delete l.drop; api.touch('levels'); renderBody(); });
        return c;
      })()),
      dropOn ? h('div', { class: 'bb-st-row' }, ...['x0', 'x1', 'y0', 'y1'].map((k) => h('label', { class: 'bb-st-mini' }, k, numIn(l.drop, k, 1, scheduleDraw)))) : null));

    // start layout
    const startRows = l.initialBlocks.map((b, i) => {
      const row = h('div', { class: `bb-st-seq bb-st-start${i === st.sel ? ' bb-on' : ''}` },
        h('span', { class: 'bb-dbg-idx' }, i + 1),
        shapeField(b), mini(matList, b, 'material'),
        ...[['x', 0.25], ['y', 0.25], ['rot', 5]].map(([k, step]) => h('label', { class: 'bb-st-mini' }, k, numIn(b, k, step, scheduleDraw))),
        btn('⧉', () => { l.initialBlocks.push({ ...b, x: b.x + 1, y: b.y + 1 }); st.sel = l.initialBlocks.length - 1; api.touch('levels'); renderBody(); scheduleDraw(); }),
        btn('✕', () => { l.initialBlocks.splice(i, 1); st.sel = -1; api.touch('levels'); renderBody(); scheduleDraw(); }, 'bb-dbg-danger'));
      // touching a row selects that block on the blueprint (without rebuilding the rows: that would drop the focus of the field being edited)
      row.addEventListener('focusin', () => {
        if (st.sel === i) return;
        st.sel = i;
        row.parentNode?.querySelectorAll('.bb-st-start').forEach((r) => r.classList.toggle('bb-on', r === row));
        scheduleDraw();
      });
      row.addEventListener('pointerdown', () => row.dispatchEvent(new Event('focusin')));
      return row;
    });
    out.push(w.section(`Start layout (${l.initialBlocks.length})`,
      startRows.length ? h('div', { class: 'bb-st-scroll' }, ...startRows) : h('span', { class: 'bb-dbg-note' }, 'Empty: drag a shape from the palette into the blueprint.')));

    // blocks to place
    const seq = l.shapes.map((s, i) => {
      const n = Math.min(l.chooseShapes, l.shapes.length);
      return h('div', { class: `bb-st-seq${i < n ? ' bb-first' : ''}`, title: i < n ? 'on the table from the start' : 'appears later' },
        h('span', { class: 'bb-dbg-idx' }, i + 1),
        thumb(d.shapes[s.shape] ?? [], matColor(d, s.material), 34, 26),
        shapeField(s), mini(matList, s, 'material'),
        btn('↑', () => { if (i > 0) { [l.shapes[i - 1], l.shapes[i]] = [l.shapes[i], l.shapes[i - 1]]; api.touch('levels'); renderBody(); } }),
        btn('↓', () => { if (i < l.shapes.length - 1) { [l.shapes[i + 1], l.shapes[i]] = [l.shapes[i], l.shapes[i + 1]]; api.touch('levels'); renderBody(); } }),
        btn('⧉', () => { l.shapes.splice(i + 1, 0, { ...s }); api.touch('levels'); renderBody(); }),
        btn('✕', () => { if (l.shapes.length > 1) { l.shapes.splice(i, 1); api.touch('levels'); renderBody(); } }, 'bb-dbg-danger'));
    });
    let area = 0;
    for (const s of l.shapes) {
      for (const p of d.shapes[s.shape] ?? []) if (!p.visual) area += p.type === 'circle' ? Math.PI * (p.diameter / 2) ** 2 : polyArea(parsePts(p.points));
    }
    out.push(w.section(`Blocks to place (${l.shapes.length})`,
      h('p', { class: 'bb-dbg-note' }, `The first ${Math.min(l.chooseShapes, l.shapes.length)} (highlighted) lie on the table at the start. Total area ${f3(area)}.`),
      h('div', { class: 'bb-st-scroll' }, ...seq),
      h('div', { class: 'bb-st-row' }, btn('+ add block', () => {
        const material = matList.find((m) => !d.materials[m].static) ?? matList[0];
        shapePicker(D(), null, matColor(D(), material), (k) => { l.shapes.push({ shape: k, material }); api.touch('levels'); renderBody(); });
      }))));
    put(body, ...out);
  }

  function renderAll() {
    renderHead();
    renderBar();
    renderPalette();
    renderBody();
    scheduleDraw();
  }

  // ── levels ──
  function newLevel() {
    const d = D();
    const shape = Object.keys(d.shapes)[0];
    d.levels.push({ name: 'New level', difficulty: 'easy', ...(L()?.world ? { world: L().world } : {}), bowl: Object.keys(d.bowls)[0], background: Object.keys(d.backgrounds)[0], initialBlocks: [], chooseShapes: 3, shapes: [{ shape, material: Object.keys(d.materials).find((m) => !d.materials[m].static) ?? 'wood' }] });
    st.lvl = d.levels.length - 1;
    afterLevelChange();
  }
  function copyLevel() {
    const d = D();
    if (!L()) return;
    const c = clone(L());
    c.name += ' copy';
    d.levels.splice(st.lvl + 1, 0, c);
    st.lvl++;
    afterLevelChange();
  }
  function deleteLevel() {
    if (!st.armDelete) {
      st.armDelete = setTimeout(() => { st.armDelete = 0; renderHead(); }, 2500);
      return renderHead();
    }
    clearTimeout(st.armDelete);
    st.armDelete = 0;
    const d = D();
    if (d.levels.length <= 1) return renderHead();
    d.levels.splice(st.lvl, 1);
    st.lvl = Math.min(st.lvl, d.levels.length - 1);
    afterLevelChange();
    return undefined;
  }
  function afterLevelChange() {
    st.sel = -1;
    api.touch('levels');
    fitSoon();
    renderAll();
    applyNow();
  }
  const fitSoon = () => requestAnimationFrame(() => { if (L()) board.fit(bounds()); scheduleDraw(); });

  // ── keyboard ──
  const onKey = (e) => {
    if (!st.open || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const step = e.shiftKey ? 1 : 15;
    if (live) {
      if (k === 'q' || k === 'e') { live.rot += (k === 'q' ? 1 : -1) * step; live.send(true); e.preventDefault(); } else if (k === 'escape') { view.debugSend({ cancel: true }); live = null; }
      return;
    }
    const b = st.mode === 'layout' ? L()?.initialBlocks[st.sel] : null;
    if (!b) return;
    if (k === 'q' || k === 'e') {
      b.rot = Math.round((((((b.rot ?? 0) + (k === 'q' ? 1 : -1) * step + 180) % 360) + 360) % 360 - 180) * 10) / 10;
      api.touch('levels');
      renderBody();
      scheduleDraw();
      e.preventDefault();
    } else if (k === 'delete' || k === 'backspace') {
      L().initialBlocks.splice(st.sel, 1);
      st.sel = -1;
      api.touch('levels');
      renderBody();
      scheduleDraw();
      e.preventDefault();
    }
  };

  // the blueprint turns a block it carries with the wheel
  const wheelHook = (e) => {
    if (!live) return false;
    live.rot += (e.deltaY < 0 ? 1 : -1) * 15;
    live.send(true);
    return true;
  };
  board.el.addEventListener('wheel', (e) => { if (wheelHook(e)) e.stopImmediatePropagation(); }, { capture: true, passive: false });

  const bpEl = h('div', { class: 'bb-st-bp' }, board.el);
  bpEl.style.height = `${dockPref.bp}px`;
  const gripY = h('div', { class: 'bb-st-gripy', title: 'Drag to make the blueprint taller or shorter (only for you: not shared with the other players)' });
  gripY.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gripY.setPointerCapture(e.pointerId);
    const move = (ev) => { dockPref.bp = Math.round(Math.min(Math.max(ev.clientY - bpEl.getBoundingClientRect().top, 120), window.innerHeight - 230)); bpEl.style.height = `${dockPref.bp}px`; };
    const up = () => { gripY.removeEventListener('pointermove', move); gripY.removeEventListener('pointerup', up); requestAnimationFrame(() => { if (L()) board.fit(bounds()); scheduleDraw(); }); };
    gripY.addEventListener('pointermove', move);
    gripY.addEventListener('pointerup', up);
  });
  // two bars: the studio bar (head) runs across the whole window at the top, the panel with the blueprint sits at the left under it and the game fills the rest
  const dockPanel = h('div', { class: 'bb-st-dock bb-st-dockin' }, bar, bpEl, gripY, palette, body);
  const root = h('div', { class: 'bb-st bb-st-level' }, head, dockPanel);
  dockGrip(dockPanel, view);
  const fitTop = () => { if (st.open) view.debugDock(dockPref.w, head.offsetHeight); }; // (the bar wraps onto more lines in a narrow window)
  new ResizeObserver(fitTop).observe(head);
  window.addEventListener('keydown', onKey);

  let askedAt = 0;
  const onSnap = (s) => {
    if (!st.open) return;
    // the lab must be on while we are open (another player's studio, a server restart ...)
    if (s.lab === 0 && performance.now() - askedAt > 1500) {
      askedAt = performance.now();
      lab({ on: true, paused: st.mode === 'layout', rules: st.rules });
      applyNow();
    }
    if (s.lab !== st.lab) {
      st.lab = s.lab;
      renderBar();
    }
    if (s.ph !== st.ph) { // the level was lost or won (only with "fail enabled")
      st.ph = s.ph;
      if (s.ph === S.PHASE.LOST) st.msg = `Level failed: ${S.LOSE_TEXT[s.why] ?? ''} Press Reset to try again.`;
      else if (s.ph === S.PHASE.WON) st.msg = 'Level won! Press Reset to try again.';
      else if (/^Level (failed|won)/.test(st.msg)) st.msg = '';
      renderBar();
    }
    if (s.lv >= 0 && s.lv !== st.lvl && s.lv < D().levels.length && s.run !== st.run) { // somebody started another level
      st.lvl = s.lv;
      st.run = s.run;
      fitSoon();
      renderAll();
    }
    st.run = s.run;
    if (s.lv < 0 && performance.now() - askedAt > 1500) { // back at the menu: the studio wants a level
      askedAt = performance.now();
      lab({ play: st.lvl });
    }
    if (st.mode === 'live') scheduleDraw();
  };

  return {
    el: root,
    show() {
      const d = D();
      st.open = true;
      st.mode = 'layout';
      const cur = view.snap?.lv ?? -1;
      st.lvl = Math.max(0, Math.min(cur >= 0 ? cur : st.lvl, d.levels.length - 1));
      st.sel = -1;
      st.msg = '';
      root.classList.add('bb-show');
      dockPanel.style.width = `${dockPref.w}px`;
      view.debugDock(dockPref.w, head.offsetHeight);
      view.onSnap = onSnap;
      st.rules = false;
      st.ph = 1;
      lab({ on: true, paused: true, rules: false });
      renderAll();
      requestAnimationFrame(() => { if (L()) board.fit(bounds()); scheduleDraw(); });
      applyNow();
    },
    hide() {
      if (!st.open) return;
      st.open = false;
      clearTimeout(applyTimer);
      if (live) { view.debugSend({ cancel: true }); live = null; }
      root.classList.remove('bb-show');
      view.debugDock(0, 0);
      view.onSnap = null;
      lab({ on: false });
      lab({ reload: true }); // an ordinary level again (in the local game)
    },
    changed(kind) {
      if (!st.open) return;
      api.showProblems(probEl);
      if (kind === 'levels' || kind === 'all') {
        st.lvl = Math.min(st.lvl, Math.max(0, D().levels.length - 1));
        scheduleSync(); // every edit reaches the local game (and so the test) at once; nothing leaves this page
        scheduleDraw();
      } else if (kind === 'shapes' || kind === 'materials' || kind === 'bowls' || kind === 'tuning') {
        renderPalette();
        scheduleDraw();
        scheduleSync();
      }
    },
    refresh() { // somebody else's version was adopted: show it (keep your own selection when it still exists)
      if (!st.open) return;
      st.lvl = Math.min(st.lvl, Math.max(0, D().levels.length - 1));
      if (st.sel >= (L()?.initialBlocks.length ?? 0)) st.sel = -1;
      renderAll();
      scheduleDraw();
    },
    dispose() {
      this.hide();
      window.removeEventListener('keydown', onKey);
    },
  };
}

// ───────────────────────────── BACKGROUND STUDIO ─────────────────────────────
/**
 * The game (a level of your choice, frozen) with the free camera on, and a panel to place background models: pick one in the
 * viewport (drag = move over the floor, Shift-drag = up / down, Q / E = turn, Delete = remove) or type exact numbers.
 * Every model is a collapsed row; "Camera to game view" puts the camera back where the game has it.
 */
function backgroundStudio(view, api) {
  const st = { lvl: 0, bg: '', sel: -1, snap: 0.5, rsnap: 5, tool: 'none', axis: 1, open: false, add: '', prev: null };
  let applyTimer = 0;
  let drag = null;
  let askedAt = 0;
  const openRows = new Set();

  const D = () => api.draft();
  const L = () => D().levels[st.lvl];
  const lab = (c) => view.debugSend({ lab: c }); // (the local game only: debugSend never reaches the room)
  const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, onclick: fn }, text);
  const sel = (options, value, onchange, cls = '') => {
    const s = h('select', { class: cls }, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v }, l); }));
    s.value = value;
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };
  const bgKey = () => {
    const d = D();
    const k = L()?.background;
    return k && d.backgrounds[k] ? k : Object.keys(d.backgrounds)[0];
  };
  const BG = () => D().backgrounds[bgKey()];
  const models = () => (BG().models ??= []);
  const TABLE_I = -2; // the table model has this number in the viewport (see client.js)
  const lights = () => (BG().lights ??= []);
  const inst = (i) => (i >= LIGHT0 ? lights()[i - LIGHT0] : i === TABLE_I ? BG().table : models()[i]);
  const snapV = (v) => snapTo(v, st.snap);
  const freshTable = () => ({ model: D().models.board ? 'board' : Object.keys(D().models)[0], scale: 1, rotation: [0, 0, 0], translate: [0, 0, 2] });
  const fresh = (model) => ({ model, scale: 1, rotation: [0, 0, 0], translate: [0, 0, -40] });

  const probEl = h('span', { class: 'bb-st-prob' });
  const head = h('div', { class: 'bb-st-head' }, h('strong', {}, 'Background studio'), probEl, h('span', { class: 'bb-dbg-grow' }),
    btn('Close', () => api.close()));
  const bar = h('div', { class: 'bb-st-bar' });
  const body = h('div', { class: 'bb-st-body' });
  const root = h('div', { class: 'bb-st bb-st-dock' }, head, bar, body);
  dockGrip(root, view);

  function applyLevel() {
    clearTimeout(applyTimer);
    applyTimer = 0;
    if (!st.open) return;
    api.syncNow();
    if (api.problems().length || !L()) return;
    lab({ play: st.lvl });
  }

  /** the numbers of one model changed: show it at once, tell the draft */
  function pushInst(i) {
    view.debugSetInstance(i, inst(i));
    api.touch('backgrounds', true); // (quiet: the view already shows it, the local game is not rebuilt for every pixel of a drag)
  }
  function select(i, scroll = false) {
    st.sel = i;
    if (i !== -1) openRows.add(i);
    view.debugSelectInstance(i !== -1 ? i : null);
    renderBody();
    if (scroll && i !== -1) body.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function structural() { // models added / removed / reordered / switched: the game rebuilds them when the draft comes back
    api.touch('backgrounds');
    renderBody();
  }

  const numIn = (get, set, step = 1) => {
    const n = h('input', { type: 'number', step, class: 'bb-dbg-n', value: get() });
    n.addEventListener('input', () => { const v = parseFloat(n.value); if (Number.isFinite(v)) set(v); });
    return n;
  };
  const row3 = (label, arr, i, step) => h('label', { class: 'bb-dbg-field' }, h('span', {}, label),
    ...['x', 'y', 'z'].map((a, k) => h('span', { class: 'bb-st-axis' }, a, numIn(() => arr[k], (v) => { arr[k] = v; if (i === -1) api.touch('backgrounds'); else pushInst(i); }, step))));

  function setTool(k) {
    st.tool = k;
    renderBar();
  }
  function renderBar() {
    const d = D();
    put(bar,
      h('div', { class: 'bb-st-row' },
        h('span', { class: 'bb-st-mini' }, 'level'),
        sel(d.levels.map((lv, i) => [String(i), `${i + 1}. ${lv.name}`]), String(st.lvl), (v) => { st.lvl = +v; st.sel = -1; openRows.clear(); applyLevel(); renderAll(); }, 'bb-dbg-grow')),
      h('div', { class: 'bb-st-row' },
        h('span', { class: 'bb-st-mini' }, 'background'),
        sel(Object.keys(d.backgrounds), bgKey(), (v) => { L().background = v; st.sel = -1; openRows.clear(); api.touch('levels'); renderAll(); }, 'bb-dbg-grow')),
      h('div', { class: 'bb-st-row' },
        btn('Refresh view', () => applyLevel(), 'bb-dbg-go'),
        btn('⌖ Camera to game view', () => view.debugCameraHome(), 'bb-dbg-go'),
        h('span', { class: 'bb-st-mini' }, 'snap'),
        sel(SNAPS, String(st.snap), (v) => { st.snap = +v; }),
        h('span', { class: 'bb-st-mini' }, 'angle'),
        sel([['0', 'free'], ['1', '1°'], ['5', '5°'], ['15', '15°'], ['45', '45°']], String(st.rsnap), (v) => { st.rsnap = +v; }),
      ),
      h('div', { class: 'bb-st-row' },
        h('div', { class: 'bb-st-seg' }, ...[['none', '∅ None (N)'], ['move', '✥ Move (W)'], ['rotate', '⟳ Rotate (R)'], ['scale', '⤢ Scale (S)']].map(([k, l]) => h('button', { type: 'button', class: st.tool === k ? 'bb-on' : '', onclick: () => setTool(k) }, l))),
        st.tool === 'rotate' ? h('div', { class: 'bb-st-seg', title: 'The axis the drag turns around' }, ...['x', 'y', 'z'].map((a, k) => h('button', { type: 'button', class: st.axis === k ? 'bb-on' : '', onclick: () => { st.axis = k; renderBar(); } }, a.toUpperCase()))) : null),
      h('div', { class: 'bb-st-hint' }, st.tool === 'none'
        ? 'None: clicking in the view never touches a model, so you can tweak the settings without moving anything by accident. Camera: drag to turn, right-drag to move, wheel to zoom. Pick Move (W), Rotate (R) or Scale (S) to edit models in the view.'
        : st.tool === 'move'
        ? 'Move: click a model in the view and drag it over the floor; Shift-drag lifts it (fast). Camera: drag the empty space to turn, right-drag to move, wheel to zoom. Delete removes the model.'
        : st.tool === 'rotate'
          ? 'Rotate: click a model and drag left / right to turn it around the chosen axis (Shift = slower). Q / E also turn it. Camera: drag the empty space.'
          : 'Scale: click a model and drag up / down to make it bigger or smaller (Shift = slower).'));
  }

  function renderBody() {
    const d = D();
    const bg = BG();
    bg.ground ??= { colorA: '#cdc3a8', colorB: '#e6dec9', ripple: 2.2 };
    bg.fog ??= [150, 520];
    bg.blur ??= 3;
    bg.blurFar ??= 10;
    bg.ground.blur ??= 'light';
    bg.light ??= { dir: [-0.45, 0.85, 0.55], shadow: 0.4 };
    bg.light.time ??= 12;
    bg.light.dir ??= [-0.45, 0.85, 0.55];
    bg.light.shadow ??= 0.4;
    bg.ground.style ??= 'sand';
    bg.bowlHeight ??= 4;
    bg.box ??= { w: 110, d: 52, z: 2, shader: 'floorwood' };
    const w = api.w;
    const ms = models();
    if (st.prev) { st.prev.dispose(); st.prev = null; }
    const canvas = h('canvas', { class: 'bb-st-canvas' });
    const addKeys = Object.keys(d.models);
    if (!addKeys.includes(st.add)) st.add = addKeys[0] ?? '';
    const addBox = h('div', { class: 'bb-st-addbox' },
      h('div', { class: 'bb-dbg-modelprev' }, canvas),
      h('div', { class: 'bb-st-row' },
        sel(addKeys, st.add, (v) => { st.add = v; showPrev(); }, 'bb-dbg-grow'),
        btn('+ Add', () => {
          if (!st.add) return;
          ms.push(fresh(st.add));
          const t = view.debugGroundAt?.(innerWidth * 0.6, innerHeight * 0.6, 0);
          if (t) ms[ms.length - 1].translate = [snapV(t.x), 0, snapV(t.z)];
          openRows.add(ms.length - 1);
          st.sel = ms.length - 1;
          structural();
          view.debugSelectInstance(st.sel);
        }, 'bb-dbg-go')));
    const showPrev = () => {
      st.prev?.dispose();
      st.prev = null;
      const def = d.models[st.add];
      if (!def) return;
      try {
        st.prev = view.debugModelPreview(canvas);
        st.prev.set(def);
      } catch (e) { addBox.append(h('div', { class: 'bb-dbg-err' }, String(e.message ?? e))); }
    };

    const row = (m, i, title, extra = []) => {
      const det = h('details', { class: `bb-st-inst${i === st.sel ? ' bb-on' : ''}`, 'data-i': String(i), open: openRows.has(i) },
        h('summary', {}, h('span', { class: 'bb-st-itemname' }, title), h('span', { class: 'bb-st-badge' }, `${f3(m.translate[0])}, ${f3(m.translate[1])}, ${f3(m.translate[2])}`)),
        h('div', { class: 'bb-st-instbody' },
          h('div', { class: 'bb-st-row' },
            sel(Object.keys(d.models), m.model, (v) => { m.model = v; structural(); }, 'bb-dbg-grow'),
            btn('⌖', () => { view.debugLookAt(m.translate[0], m.translate[1] + view.floorY, m.translate[2]); select(i); }, ''),
            btn('⤓', () => { m.translate[1] = 0; pushInst(i); renderBody(); }, ''),
            ...extra),
          h('label', { class: 'bb-dbg-field' }, h('span', {}, 'scale'), numIn(() => m.scale ?? 1, (v) => { if (v > 0) { m.scale = v; pushInst(i); } }, 0.1)),
          i === TABLE_I ? null : h('label', { class: 'bb-dbg-field' }, h('span', {}, 'blur'), sel(BLUR_CHOICES, m.blur ?? 'light', (v) => { m.blur = v; structural(); })),
          row3('rotation °', m.rotation, i, 5),
          row3('translate', m.translate, i, 0.5)));
      det.addEventListener('toggle', () => { if (det.open) openRows.add(i); else openRows.delete(i); });
      det.querySelector('summary').addEventListener('click', () => { if (st.sel !== i) { st.sel = i; view.debugSelectInstance(i); for (const e of body.querySelectorAll('.bb-st-inst')) e.classList.toggle('bb-on', e.dataset.i === String(i)); } });
      return det;
    };
    const rows = ms.map((m, i) => row(m, i, `${i + 1}. ${m.model}`, [
      btn('⧉', () => { ms.splice(i + 1, 0, clone(m)); ms[i + 1].translate[0] += 3; openRows.add(i + 1); st.sel = i + 1; structural(); view.debugSelectInstance(st.sel); }, ''),
      btn('✕', () => { removeAt(i); }, 'bb-dbg-danger')]));
    // shadow settings: this background's own, or (when it has none) the global ones from the Settings tab
    const shadowUi = (bgd) => {
      const own = h('input', { type: 'checkbox', checked: !!bgd.light.shadows });
      own.addEventListener('change', () => {
        if (own.checked) bgd.light.shadows = { ...S.SHADOW_DEFAULTS, ...(D().tuning.shadows ?? {}) };
        else delete bgd.light.shadows;
        api.touch('backgrounds');
        renderBody();
      });
      const g = bgd.light.shadows ?? (D().tuning.shadows ??= { ...S.SHADOW_DEFAULTS });
      for (const [k, v] of Object.entries(S.SHADOW_DEFAULTS)) g[k] ??= v;
      const kind = bgd.light.shadows ? 'backgrounds' : 'tuning';
      const on = h('input', { type: 'checkbox', checked: g.on !== false });
      on.addEventListener('change', () => { g.on = on.checked; api.touch(kind); });
      const size = sel([['1024', '1024'], ['2048', '2048'], ['4096', '4096 (default)'], ['8192', '8192 (heavy)']], String(g.size), (v) => { g.size = +v; api.touch(kind); });
      const soft = sel([['1', 'crisp'], ['2', 'soft'], ['3', 'softer']], String(g.softness), (v) => { g.softness = +v; api.touch(kind); });
      return [
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'own settings for this background'), own),
        h('div', { class: 'bb-st-hint' }, bgd.light.shadows ? 'Editing this background\'s own shadow settings.' : 'Editing the GLOBAL shadow settings (tick the box above to give this background its own).'),
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'shadows on'), on),
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'resolution'), size),
        w.field('area shaded (width)', numIn(() => g.range, (v) => { if (v >= 20 && v <= 600) { g.range = v; api.touch(kind); } }, 10)),
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'edge softness'), soft),
        w.slider('depth bias', g, 'bias', kind, 0, 4, 0.02),
        w.slider('normal bias (texels)', g, 'normalBias', kind, 0, 6, 0.1),
      ];
    };
    const lightsList = lights();
    const lightRows = lightsList.map((l, k) => {
      const i = LIGHT0 + k;
      const det = h('details', { class: `bb-st-inst${i === st.sel ? ' bb-on' : ''}`, 'data-i': String(i), open: openRows.has(i) },
        h('summary', {}, h('span', { class: 'bb-st-itemname' }, `${k + 1}. light`), h('span', { class: 'bb-st-badge' }, `${f3(l.translate[0])}, ${f3(l.translate[1])}, ${f3(l.translate[2])}`)),
        h('div', { class: 'bb-st-instbody' },
          h('div', { class: 'bb-st-row' },
            btn('⌖', () => { view.debugLookAt(l.translate[0], l.translate[1] + view.floorY, l.translate[2]); select(i); }, ''),
            btn('⧉', () => { lightsList.splice(k + 1, 0, clone(l)); lightsList[k + 1].translate[0] += 4; openRows.add(i + 1); st.sel = i + 1; structural(); view.debugSelectInstance(st.sel); }, ''),
            btn('✕', () => { removeAt(i); }, 'bb-dbg-danger')),
          w.color('colour', l, 'color', 'backgrounds'),
          w.slider('intensity', l, 'intensity', 'backgrounds', 0, 6, 0.1),
          h('label', { class: 'bb-dbg-field' }, h('span', {}, 'reach'), numIn(() => l.range, (v) => { if (v > 0) { l.range = v; pushInst(i); } }, 5)),
          row3('translate', l.translate, i, 0.5)));
      det.addEventListener('toggle', () => { if (det.open) openRows.add(i); else openRows.delete(i); });
      det.querySelector('summary').addEventListener('click', () => { if (st.sel !== i) { st.sel = i; view.debugSelectInstance(i); for (const e of body.querySelectorAll('.bb-st-inst')) e.classList.toggle('bb-on', e.dataset.i === String(i)); } });
      return det;
    });
    const tableBox = bg.table
      ? row(bg.table, TABLE_I, `Table: ${bg.table.model}`, [btn('Plain box', () => { removeAt(TABLE_I); }, 'bb-dbg-danger')])
      : h('div', { class: 'bb-st-row' }, h('span', { class: 'bb-st-mini' }, 'Plain wooden box.'), btn('Use a model', () => { bg.table = freshTable(); openRows.add(TABLE_I); st.sel = TABLE_I; structural(); view.debugSelectInstance(TABLE_I); }));

    put(body,
      h('details', { class: 'bb-st-inst bb-st-fold' }, h('summary', {}, 'Sky and ground'),
        h('div', { class: 'bb-st-instbody' },
          w.color('mist (sky, distance)', bg, 'mist', 'backgrounds'),
          w.field('fog near / far', ...[0, 1].map((k) => numIn(() => bg.fog[k], (v) => { bg.fog[k] = v; api.touch('backgrounds'); }, 10))),
          w.color('sand grooves', bg.ground, 'colorA', 'backgrounds'),
          w.color('sand ridges', bg.ground, 'colorB', 'backgrounds'),
          w.slider('rake spacing', bg.ground, 'ripple', 'backgrounds', 0.3, 6, 0.1),
          w.select('floor', [['sand', 'raked sand'], ['wood', 'wooden planks'], ['none', 'no floor']], bg.ground, 'style', 'backgrounds'),
          w.slider('time of day (hour)', bg.light, 'time', 'backgrounds', 0, 24, 0.25),
          w.slider('shadow darkness', bg.light, 'shadow', 'backgrounds', 0, 1, 0.05),
          row3('light direction', bg.light.dir, -1, 0.1))),
      h('details', { class: 'bb-st-inst bb-st-fold' }, h('summary', {}, 'Blur (light and heavy)'),
        h('div', { class: 'bb-st-instbody' },
          w.slider('light blur (px)', bg, 'blur', 'backgrounds', 0, 20, 0.5),
          w.slider('heavy blur (px)', bg, 'blurFar', 'backgrounds', 0, 40, 0.5),
          w.select('floor', BLUR_CHOICES, bg.ground, 'blur', 'backgrounds'),
          h('div', { class: 'bb-st-hint' }, 'Every model below picks none, light or heavy blur.'))),
      h('details', { class: 'bb-st-inst bb-st-fold' }, h('summary', {}, 'Shadows'),
        h('div', { class: 'bb-st-instbody' }, ...shadowUi(bg))),
      h('div', { class: 'bb-st-sub' }, 'Table and bowl'),
      h('label', { class: 'bb-dbg-field' }, h('span', {}, 'bowl height above the floor'), numIn(() => bg.bowlHeight ?? 4, (v) => { if (v >= 0) { bg.bowlHeight = v; api.touch('backgrounds'); } }, 0.5)),
      bg.table ? null : h('div', { class: 'bb-st-instbody' },
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'table width (x)'), numIn(() => bg.box.w, (v) => { if (v >= 10) { bg.box.w = v; api.touch('backgrounds'); } }, 1)),
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'table depth (z)'), numIn(() => bg.box.d, (v) => { if (v >= 10) { bg.box.d = v; api.touch('backgrounds'); } }, 1)),
        h('label', { class: 'bb-dbg-field' }, h('span', {}, 'table centre z'), numIn(() => bg.box.z, (v) => { bg.box.z = v; api.touch('backgrounds'); }, 1)),
        w.select('table shader', view.shaderNames, bg.box, 'shader', 'backgrounds')),
      tableBox,
      h('div', { class: 'bb-st-sub' }, `Models (${ms.length})`, h('span', { class: 'bb-dbg-grow' }),
        btn('Collapse all', () => { openRows.clear(); renderBody(); }, '')),
      ...rows,
      h('div', { class: 'bb-st-sub' }, `Lights (${lightsList.length})`, h('span', { class: 'bb-dbg-grow' }),
        btn('+ Add light', () => {
          if (lightsList.length >= 8) return;
          lightsList.push({ color: '#ffd9a0', intensity: 1.2, range: 60, translate: [0, 12, 0] });
          openRows.add(LIGHT0 + lightsList.length - 1);
          st.sel = LIGHT0 + lightsList.length - 1;
          structural();
          view.debugSelectInstance(st.sel);
        }, '')),
      ...lightRows,
      h('div', { class: 'bb-st-sub' }, 'Add a model'),
      addBox);
    showPrev();
  }

  function removeAt(i) {
    if (i === TABLE_I) delete BG().table;
    else if (i >= LIGHT0) lights().splice(i - LIGHT0, 1);
    else models().splice(i, 1);
    openRows.clear();
    st.sel = -1;
    view.debugSelectInstance(null);
    structural();
  }
  function renderAll() {
    api.showProblems(probEl);
    renderBar();
    renderBody();
  }

  // ── the viewport: the pointer hook of the free camera ──
  const hook = {
    down(e) {
      if (st.tool === 'none') return false;
      const i = view.debugModelAt(e.clientX, e.clientY);
      if (i === null || i === undefined || !inst(i)) return false;
      select(i, true);
      const m = inst(i);
      if (i >= LIGHT0 && st.tool !== 'move') return true; // (a light has no rotation or size: only Move works on it)
      drag = { i, vertical: e.shiftKey, start: { x: e.clientX, y: e.clientY }, t0: [...m.translate], r0: [...m.rotation], s0: m.scale ?? 1, off: null };
      if (st.tool === 'move' && !drag.vertical) {
        drag.last = view.debugGroundAt(e.clientX, e.clientY, m.translate[1]); // (the model follows the pointer by what it moved since: Shift makes that a quarter)
        drag.acc = { x: m.translate[0], z: m.translate[2] };
      }
      return true;
    },
    move(e) {
      if (!drag) return;
      const m = inst(drag.i);
      if (!m) return;
      const dx = e.clientX - drag.start.x;
      const dy = e.clientY - drag.start.y;
      const slow = e.shiftKey && st.tool !== 'move' ? 0.25 : 1; // (hold Shift while dragging: a quarter of the speed)
      if (st.tool === 'rotate') {
        const a = drag.r0[st.axis] + dx * 0.6 * slow;
        m.rotation[st.axis] = snapTo(((a % 360) + 360) % 360, st.rsnap);
      } else if (st.tool === 'scale') {
        m.scale = Math.max(0.01, Math.round(drag.s0 * Math.exp(-dy * 0.008 * slow) * 1000) / 1000);
      } else if (drag.vertical) {
        // about a quarter of the camera distance per 100 pixels, so it keeps up at any zoom
        const k = 0.012 * Math.max(8, Math.min(400, view.freeCam?.dist ?? 80));
        m.translate[1] = snapV(drag.t0[1] - dy * k);
      } else {
        const g = view.debugGroundAt(e.clientX, e.clientY, m.translate[1]);
        if (!g) return;
        if (drag.last) {
          const f = e.shiftKey ? 0.25 : 1; // Shift pressed during a normal drag: a quarter of the speed (Shift at the start = lift instead)
          drag.acc.x += (g.x - drag.last.x) * f;
          drag.acc.z += (g.z - drag.last.z) * f;
        }
        drag.last = g;
        m.translate[0] = snapV(drag.acc.x);
        m.translate[2] = snapV(drag.acc.z);
      }
      pushInst(drag.i);
    },
    up() {
      if (drag) { drag = null; renderBody(); }
    },
  };

  const onKey = (e) => {
    if (!st.open || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n' || k === 'w' || k === 'r' || k === 's') { setTool({ n: 'none', w: 'move', r: 'rotate', s: 'scale' }[k]); return; }
    const m = st.sel === -1 ? null : inst(st.sel);
    if (!m) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeAt(st.sel);
    } else if ((k === 'q' || k === 'e') && st.tool !== 'none' && m.rotation) {
      const sgn = k === 'q' ? -1 : 1;
      const step = st.rsnap > 0 ? st.rsnap : 5;
      m.rotation[st.axis] = ((m.rotation[st.axis] + sgn * (e.shiftKey ? 1 : step * 3)) % 360 + 360) % 360;
      pushInst(st.sel);
      renderBody();
    }
  };
  window.addEventListener('keydown', onKey);

  const onSnap = (s) => {
    if (!st.open) return;
    if (s.lab === 0 && performance.now() - askedAt > 1500) {
      askedAt = performance.now();
      lab({ on: true, paused: true, rules: false });
      applyLevel();
    }
    if (s.lv < 0 && performance.now() - askedAt > 1500) {
      askedAt = performance.now();
      lab({ play: st.lvl });
    }
  };

  return {
    el: root,
    show() {
      const d = D();
      st.open = true;
      const cur = view.snap?.lv ?? -1;
      st.lvl = Math.max(0, Math.min(cur >= 0 ? cur : st.lvl, d.levels.length - 1));
      st.sel = -1;
      openRows.clear();
      root.classList.add('bb-show');
      root.style.width = `${dockPref.w}px`;
      view.debugDock(dockPref.w);
      view.onSnap = onSnap;
      lab({ on: true, paused: true, rules: false });
      view.debugFreeCam(true);
      view.debugShowLights(true);
      view.camHook = hook;
      renderAll();
      applyLevel();
    },
    hide() {
      if (!st.open) return;
      st.open = false;
      clearTimeout(applyTimer);
      view.debugShowLights(false);
      drag = null;
      st.prev?.dispose();
      st.prev = null;
      root.classList.remove('bb-show');
      view.camHook = null;
      view.debugSelectInstance(null);
      view.debugFreeCam(false);
      view.debugDock(0);
      view.onSnap = null;
      lab({ on: false });
      lab({ reload: true });
    },
    changed(kind) {
      if (!st.open) return;
      api.showProblems(probEl);
      if (kind === 'levels' || kind === 'all') {
        st.lvl = Math.min(st.lvl, Math.max(0, D().levels.length - 1));
      }
      if (kind === 'all') renderAll();
      else if (kind === 'models') renderBody();
    },
    refresh() {
      if (st.open) renderAll();
    },
    dispose() {
      this.hide();
      window.removeEventListener('keydown', onKey);
    },
  };
}

/**
 * @param view  the BalanceView
 * @param api   { draft(): the current draft, touch(kind, quiet?, live?), saveItem(request): ask the server to add / update ONE level or shape in its file (after a confirmation), syncNow(): give the draft to the local game now, playtest(levelIndex): leave the studio and play it in the local game,
 *                problems(): string[], showProblems(el), w: the widget builders of the debug menu, open(name), close() }
 */
export function createStudio(view, api) {
  const shapesS = shapeStudio(view, api);
  const levelsS = levelStudio(view, api);
  const bgS = backgroundStudio(view, api);
  const pane = (n) => (n === 'shapes' ? shapesS : n === 'backgrounds' ? bgS : levelsS);
  const root = h('div', { class: 'bb-st-host' }, shapesS.el, levelsS.el, bgS.el);
  let current = null;
  return {
    el: root,
    get current() { return current; },
    open(name) {
      if (current === name) return;
      this.close();
      current = name;
      root.classList.add('bb-st-on');
      pane(name).show();
    },
    close() {
      if (!current) return;
      pane(current).hide();
      current = null;
      root.classList.remove('bb-st-on');
    },
    /** The draft changed: `kind` is the table ('levels', 'shapes' ...) or 'all' (replaced wholesale). */
    changed(kind, live = false) {
      if (current) pane(current).changed(kind, live);
    },
    refresh() {
      if (current) pane(current).refresh();
    },
    dispose() {
      this.close();
      shapesS.dispose();
      levelsS.dispose();
      bgS.dispose();
      root.remove();
    },
  };
}

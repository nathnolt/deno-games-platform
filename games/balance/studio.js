// CLIENT ONLY: the two studios of the debug menu (loaded by debug.js, so only with DEBUG on).
//
//   SHAPE STUDIO  A 2D board that shows EVERY shape at the same scale, side by side, next to the cross-section of a bowl, so you can judge
//                 how they fit together. Drag corners to reshape, click an edge to add a corner, right-click a corner to remove it.
//                 Next to it a 3D preview draws the same shapes with the game's own geometry and shaders, standing on the table in
//                 front of the bowl, updating while you edit.
//
//   BACKGROUND STUDIO  The game with the free camera on and a panel to place the models of a background (move / turn / scale, collapsed rows,
//                 a preview window for the model you are about to add, a button that puts the camera back where the game has it).
//
//   LEVEL STUDIO  A blueprint (side view of the bowl, water, drop zone, limits and blocks) next to the running game. Two modes:
//                   Layout     the game shows the start layout frozen; drag blocks in the blueprint to place them, Q / E turn them.
//                   Live test  gravity is on and you can spawn any shape, grab and move any block (also the static ones), freeze
//                              and unfreeze gravity, reset, and capture what you built as the new start layout.
//                 While the studio is open nothing is won or lost (the server's "lab" mode).
//
// Both edit the same DRAFT as the rest of the debug menu (see debug.js), so everything is sent to the server, shared with the other
// players and exported like any other edit.

import * as S from './shared.js';
import { clone, h, svg } from './ui.js';

const KEY = /^[A-Za-z][\w-]*$/;
const DOCK = 470; // width of the level studio panel
const SHADER_COLOR = { wood: '#c99a62', wood2: '#dcc294', glass: '#9fd3e6', stone1: '#8f9298', stone2: '#6d717a', float: '#86b0d6' };
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
    if (p.visual) continue;
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
  for (const p of def) {
    if (p.visual) continue;
    const common = { fill: color, stroke: '#1f2937', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' };
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

function drawParts(def, fill, stroke, extra = {}) {
  const out = [];
  for (const p of def) {
    const common = { fill, stroke, 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke', ...extra };
    if (p.type === 'circle') {
      const c = circleOf(p);
      out.push(svg('circle', { cx: c.x, cy: c.y, r: c.r, ...common, ...(p.visual ? { 'stroke-dasharray': '3 3', fill: 'none' } : {}) }));
    } else {
      out.push(svg('polygon', { points: p.points, ...common, ...(p.visual ? { 'stroke-dasharray': '3 3', fill: 'none' } : {}) }));
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
//  SHAPE STUDIO
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
function shapeStudio(view, api) {
  const st = { sel: null, part: 0, editing: false, draw: null, closeOnFirst: true, snap: 1, mat: '(mixed)', bowl: null, open: false, msg: '', newName: '' };
  let manual = {}; //   shapes the user moved on the board: key -> { ox, oy } (only where a shape is drawn, never its data)
  let layout = null; // { cells: { key: { ox, oy, ax, ay } }, rows: [{ y, x0, x1 }], bowlKey }
  let preview = null;
  let raf = 0;
  let previewRaf = 0;

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
    const gY = S.groundYOf(bowl);
    const start = bowl.a + bowl.t + 5;
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
        y -= rowH + 4;
        x = start;
        rowH = 0;
        row = { y, x0: start - 2, x1: start };
      }
      cells[key] = { ox: x, oy: y, ax: b[0], ay: b[1], w, h: hh };
      x += w + 2.5;
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
      const sh = shift(st.sel);
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
  function startDraw() {
    if (!st.sel) return;
    st.editing = true;
    st.draw = { pts: [], cur: null };
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
    const sh = shift(st.sel);
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
    drawGrid(g, view2, k > 12 ? 1 : 5, px);
    drawBowl(g, bowl);
    const label = (text, x, y, size, fill = '#cbd5e1', anchor = 'start') => svg('text', { transform: `translate(${x} ${y}) scale(1 -1)`, 'font-size': size * px, fill, 'text-anchor': anchor, 'font-family': 'system-ui, sans-serif' }, text);
    g.append(label(`bowl "${layout.bowlKey}"  ${f3(bowl.a * 2)} wide at the rim, ${f3(bowl.b)} deep`, -bowl.a, S.groundYOf(bowl) - 1.6, 11));
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
      for (const [pi, p] of def.entries()) { // a part that is not convex cannot be a collision shape
        if (p.type !== 'circle' && !p.visual && !isConvex(parsePts(p.points))) grp.append(svg('polygon', { points: p.points, fill: 'none', stroke: '#ef4444', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
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
    if (st.draw && st.sel) {
      const sh = shift(st.sel);
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
    api.touch('shapes'); // validates + sends after a short pause, and calls changed() below
    scheduleDraw();
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
    updatePreview();
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
  function rename(from, to) {
    const d = D();
    if (!KEY.test(to)) return fail('A shape name starts with a letter and uses letters, digits, _ and - only.');
    if (to === from) return undefined;
    if (d.shapes[to]) return fail(`"${to}" already exists.`);
    const entries = Object.entries(d.shapes).map(([k, v]) => [k === from ? to : k, v]);
    for (const k of Object.keys(d.shapes)) delete d.shapes[k];
    for (const [k, v] of entries) d.shapes[k] = v;
    for (const L of d.levels) {
      L.initialBlocks.forEach((b) => { if (b.shape === from) b.shape = to; });
      L.shapes.forEach((s) => { if (s.shape === from) s.shape = to; });
    }
    st.sel = to;
    st.msg = '';
    layout = null;
    api.touch('shapes');
    api.touch('levels');
    renderAll();
    return undefined;
  }
  function removeShape(key) {
    const d = D();
    const n = usage(key);
    if (n) return fail(`"${key}" is used in ${n} level${n > 1 ? 's' : ''}: replace it there first.`);
    if (keys().length <= 1) return fail('Keep at least one shape.');
    const at = keys().indexOf(key);
    delete d.shapes[key];
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
  const canvas = h('canvas', { class: 'bb-st-canvas' });

  function renderList() {
    const d = D();
    const mats = Object.keys(d.materials).filter((m) => !d.materials[m].static);
    put(listEl, ...keys().map((key, i) => {
      const n = usage(key);
      return h('button', { type: 'button', class: `bb-st-item${key === st.sel ? ' bb-on' : ''}`, onclick: () => { select(key); focus(key); } },
        thumb(d.shapes[key], matColor(d, st.mat === '(mixed)' ? mats[i % mats.length] : st.mat)),
        h('span', { class: 'bb-st-itemname' }, key), n ? h('span', { class: 'bb-st-badge', title: `used in ${n} level(s)` }, `×${n}`) : null);
    }));
    const nameIn = h('input', { type: 'text', placeholder: 'new shape name', value: st.newName });
    nameIn.addEventListener('input', () => { st.newName = nameIn.value; });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addShape(nameIn.value.trim(), [{ type: 'poly', points: '0,0 4,0 4,1 0,1' }]); });
    put(listHead,
      h('div', { class: 'bb-st-row' }, nameIn, btn('New', () => addShape(nameIn.value.trim(), [{ type: 'poly', points: '0,0 4,0 4,1 0,1' }]))),
      st.sel ? h('div', { class: 'bb-st-row' },
        btn('Duplicate', () => { let n = `${st.sel}_copy`; for (let i = 2; D().shapes[n]; i++) n = `${st.sel}_copy${i}`; addShape(n, clone(D().shapes[st.sel])); }),
        btn('Delete', () => removeShape(st.sel), 'bb-dbg-danger')) : null,
      st.msg ? h('div', { class: 'bb-dbg-err' }, st.msg) : null);
  }

  const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, onclick: fn }, text);

  function renderInfo() {
    const def = D().shapes[st.sel];
    if (!def) return put(infoEl);
    const b = boxOf(def);
    let area = 0;
    for (const p of def) {
      if (p.visual) continue;
      area += p.type === 'circle' ? Math.PI * (p.diameter / 2) ** 2 : polyArea(parsePts(p.points));
    }
    const concave = def.some((p) => p.type !== 'circle' && !p.visual && !isConvex(parsePts(p.points)));
    const n = usage(st.sel);
    put(infoEl,
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
      if (p.type !== 'circle') {
        const vis = h('input', { type: 'checkbox', checked: !!p.visual });
        vis.addEventListener('change', () => { if (vis.checked) p.visual = true; else delete p.visual; edited(); });
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
      h('p', { class: 'bb-dbg-note' }, 'Editing: drag a subshape to move it (all its points move together) · Delete removes the selected subshape · drag a corner to move it · click a small dot on an edge to insert a corner · right-click a corner to remove it. + polygon: click the board to put down points 1, 2, 3 …, then Enter, click the first point, or Done (Backspace removes the last point, Esc cancels). Shift-drag moves the whole shape on the board only. Every subshape must be convex: build an L or a plus from several subshapes and, if you like, add a "drawing only" outline for the looks.'));
    return undefined;
  }

  // ── 3D preview ──
  function updatePreview() {
    if (!st.open || !preview) return;
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = 0;
      if (!preview) return;
      const d = D();
      const mats = Object.keys(d.materials).filter((m) => !d.materials[m].static);
      const items = keys().map((key, i) => ({
        def: d.shapes[key],
        shader: d.materials[st.mat === '(mixed)' ? mats[i % mats.length] : st.mat]?.shader ?? 'wood',
        selected: key === st.sel,
      }));
      try {
        preview.set({ items, bowl: bowlFull(d, bowlKey()), depth: d.tuning.depth, chamfer: d.tuning.chamfer });
      } catch (e) {
        console.error('balance: shape preview failed', e);
      }
    });
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
  function renderHead() {
    const d = D();
    renderProb();
    put(head,
      h('strong', {}, 'Shape studio'),
      st.draw ? btn('Done ⏎', finishDraw, 'bb-dbg-go') : btn('+ Polygon', startDraw, 'bb-dbg-go'),
      st.draw ? btn('Cancel', cancelDraw) : null,
      h('label', { class: 'bb-st-mini', title: 'Clicking the first point again closes the polygon and finishes it' }, h('input', { type: 'checkbox', checked: st.closeOnFirst, onchange: (e) => { st.closeOnFirst = e.target.checked; scheduleDraw(); } }), 'click first point to finish'),
      h('label', { class: 'bb-st-mini' }, 'snap', sel(SNAPS, String(st.snap), (v) => { st.snap = parseFloat(v); })),
      h('label', { class: 'bb-st-mini' }, 'preview material', sel(['(mixed)', ...Object.keys(d.materials)], st.mat, (v) => { st.mat = v; renderList(); scheduleDraw(); updatePreview(); })),
      h('label', { class: 'bb-st-mini' }, 'bowl', sel(Object.keys(d.bowls), bowlKey(), (v) => { st.bowl = v; layout = null; scheduleDraw(); updatePreview(); })),
      btn('Tidy', () => { manual = {}; layout = null; relayout(); board.fit(layout.bounds); scheduleDraw(); }),
      btn('Fit all', () => { board.fit(layout.bounds); scheduleDraw(); }),
      btn('Zoom to shape', () => focus()),
      h('span', { class: 'bb-dbg-grow' }),
      probEl,
      btn('Level studio', () => api.open('levels')),
      btn('✕ Close', () => api.close()));
  }

  const right = h('div', { class: 'bb-st-right' },
    h('div', { class: 'bb-st-3d' }, canvas, h('span', { class: 'bb-st-3dhint' }, 'In the game · drag = turn · wheel = zoom · double-click = reset')),
    infoEl, inspEl);
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
    updatePreview();
  }

  return {
    el: root,
    show() {
      st.open = true;
      root.classList.add('bb-show');
      layout = null;
      st.sel = D().shapes[st.sel] ? st.sel : keys()[0];
      if (!preview) preview = view.debugPreview(canvas);
      renderAll();
      requestAnimationFrame(() => { relayout(); board.fit(layout.bounds); scheduleDraw(); });
    },
    hide() {
      cancelDraw();
      st.open = false;
      root.classList.remove('bb-show');
      preview?.dispose();
      preview = null;
    },
    /** The draft changed (by this studio, another tab of the menu, or another player). */
    changed(kind) {
      if (!st.open) return;
      renderProb();
      if (kind === 'shapes' || kind === 'materials' || kind === 'bowls' || kind === 'tuning' || kind === 'all') {
        if (kind === 'all') layout = null;
        if (!layout) relayout();
        renderList();
        scheduleDraw();
        updatePreview();
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
  const lab = (c) => view.ctx.sendInput({ lab: c });
  const snapV = (v) => snapTo(v, st.snap);
  const btn = (text, fn, cls = '') => h('button', { type: 'button', class: `bb-dbg-btn ${cls}`, onclick: fn }, text);
  const sel = (options, value, onchange, cls = '') => {
    const s = h('select', { class: cls }, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v }, l); }));
    s.value = value;
    s.addEventListener('change', () => onchange(s.value));
    return s;
  };
  const nonStatic = () => Object.keys(D().materials);

  // ── talking to the lab on the server ──
  /** Send pending edits, then restart the level so the game shows them (the lab stays on, and frozen in layout mode). */
  function applyNow() {
    clearTimeout(applyTimer);
    applyTimer = 0;
    if (!st.open) return;
    api.flush();
    if (api.problems().length || !L()) {
      if (api.problems().length) { st.msg = `Not applied to the game until this is fixed: ${api.problems()[0]}`; renderBar(); }
      return;
    }
    if (st.msg.startsWith('Not applied')) { st.msg = ''; renderBar(); }
    lab({ play: st.lvl });
    lab({ paused: st.mode === 'layout' });
  }
  function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(applyNow, 350);
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
        const off = { x: w.x - b.x, y: w.y - b.y };
        return { move(q) { b.x = snapV(q.x - off.x); b.y = snapV(q.y - off.y); api.touch('levels'); scheduleDraw(); }, up() { renderBody(); } };
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
    for (const p of built0.parts) {
      const common = { fill: matColor(d, materialKey), stroke: style.stroke ?? (static_ ? '#374151' : '#3b2a14'), 'stroke-width': style.width ?? 1.1, 'vector-effect': 'non-scaling-stroke', opacity: style.opacity ?? 0.93, ...(style.dash ? { 'stroke-dasharray': style.dash } : {}) };
      grp.append(p.type === 'circle' ? svg('circle', { cx: p.cx, cy: p.cy, r: p.r, ...common }) : svg('polygon', { points: p.pts.map((q) => q.join(',')).join(' '), ...common }));
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
      view.ctx.sendInput({ x: Math.round(live.x * 100) / 100, y: Math.round(live.y * 100) / 100, rot: Math.round(live.rot * 10) / 10 });
    };
    live.send = send;
    return {
      move(q) { live.x = q.x - live.off.x; live.y = q.y - live.off.y; send(false); },
      up(q) { if (q) { live.x = q.x - live.off.x; live.y = q.y - live.off.y; } send(true); view.ctx.sendInput({ drop: true }); live = null; },
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
          drag = { move(q) { b.x = snapV(q.x); b.y = snapV(q.y); api.touch('levels'); scheduleDraw(); }, up() { renderBody(); } };
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
    api.touch('levels'); // first the new layout goes to the server ...
    setMode('layout'); //   ... then the level restarts with it
  }

  function setMode(m) {
    st.mode = m;
    if (live) { view.ctx.sendInput({ cancel: true }); live = null; }
    if (m === 'layout') applyNow(); // restart with the draft, frozen
    else applyNow(); // always restart from the layout as it is now (not only when an edit is still waiting), with gravity on
    renderAll();
  }

  // ── panel ──
  const head = h('div', { class: 'bb-st-head' });
  const bar = h('div', { class: 'bb-st-bar' });
  const palette = h('div', { class: 'bb-st-palette' });
  const body = h('div', { class: 'bb-st-body' });

  const probEl = h('span', { class: 'bb-st-prob' });
  function renderHead() {
    const d = D();
    api.showProblems(probEl);
    put(head,
      h('strong', {}, 'Level studio'),
      sel(d.levels.map((lv, i) => [String(i), `${i + 1}. ${lv.name}`]), String(st.lvl), (v) => { st.lvl = +v; st.sel = -1; fitSoon(); applyNow(); renderAll(); }, 'bb-dbg-grow'),
      btn('New', newLevel), btn('Copy', copyLevel),
      btn(st.armDelete ? 'Really?' : 'Delete', deleteLevel, 'bb-dbg-danger'),
      probEl,
      btn('Shapes', () => api.open('shapes')),
      btn('✕', () => api.close()));
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
        : [btn('Fit', () => board.fit(bounds()))],
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
      h('div', { class: 'bb-st-strip' }, Object.keys(d.shapes).map((key) => h('button', { type: 'button', class: 'bb-st-chip', title: key, onpointerdown: (e) => paletteDown(e, key) }, thumb(d.shapes[key], matColor(d, st.mat), 50, 36), h('span', {}, key)))));
  }

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
    const rows = l.initialBlocks.map((b, i) => h('button', { type: 'button', class: `bb-st-pill${i === st.sel ? ' bb-on' : ''}`, onclick: () => { st.sel = i; renderBody(); scheduleDraw(); } }, `${b.shape} · ${b.material}`));
    const b = l.initialBlocks[st.sel];
    out.push(w.section(`Start layout (${l.initialBlocks.length})`,
      h('div', { class: 'bb-st-pills' }, rows.length ? rows : h('span', { class: 'bb-dbg-note' }, 'Empty: drag a shape from the palette into the blueprint.')),
      b ? h('div', { class: 'bb-st-sel' },
        h('div', { class: 'bb-st-row' }, mini(shapesList, b, 'shape'), mini(matList, b, 'material')),
        h('div', { class: 'bb-st-row' },
          ...[['x', 0.25], ['y', 0.25], ['rot', 5]].map(([k, step]) => h('label', { class: 'bb-st-mini' }, k, numIn(b, k, step, scheduleDraw))),
          btn('⧉', () => { l.initialBlocks.push({ ...b, x: b.x + 1, y: b.y + 1 }); st.sel = l.initialBlocks.length - 1; api.touch('levels'); renderBody(); }),
          btn('✕', () => { l.initialBlocks.splice(st.sel, 1); st.sel = -1; api.touch('levels'); renderBody(); }, 'bb-dbg-danger'))) : null));

    // blocks to place
    const seq = l.shapes.map((s, i) => {
      const n = Math.min(l.chooseShapes, l.shapes.length);
      return h('div', { class: `bb-st-seq${i < n ? ' bb-first' : ''}`, title: i < n ? 'on the table from the start' : 'appears later' },
        h('span', { class: 'bb-dbg-idx' }, i + 1),
        thumb(d.shapes[s.shape] ?? [], matColor(d, s.material), 34, 26),
        mini(shapesList, s, 'shape'), mini(matList, s, 'material'),
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
      ...seq,
      h('div', { class: 'bb-st-row' }, btn('+ add block', () => { l.shapes.push({ shape: shapesList[0], material: matList.find((m) => !d.materials[m].static) ?? matList[0] }); api.touch('levels'); renderBody(); }))));
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
    d.levels.push({ name: 'New level', difficulty: 'easy', bowl: Object.keys(d.bowls)[0], background: Object.keys(d.backgrounds)[0], initialBlocks: [], chooseShapes: 3, shapes: [{ shape, material: Object.keys(d.materials).find((m) => !d.materials[m].static) ?? 'wood' }] });
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
      if (k === 'q' || k === 'e') { live.rot += (k === 'q' ? 1 : -1) * step; live.send(true); e.preventDefault(); } else if (k === 'escape') { view.ctx.sendInput({ cancel: true }); live = null; }
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

  const root = h('div', { class: 'bb-st bb-st-dock' }, head, bar, h('div', { class: 'bb-st-bp' }, board.el), palette, body);
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
      view.debugDock(DOCK);
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
      if (live) { view.ctx.sendInput({ cancel: true }); live = null; }
      root.classList.remove('bb-show');
      view.debugDock(0);
      view.onSnap = null;
      lab({ on: false });
      lab({ reload: true }); // an ordinary level again
    },
    changed(kind) {
      if (!st.open) return;
      api.showProblems(probEl);
      if (kind === 'levels' || kind === 'all') {
        st.lvl = Math.min(st.lvl, Math.max(0, D().levels.length - 1));
        if (st.mode === 'layout') scheduleApply();
        scheduleDraw();
      } else if (kind === 'shapes' || kind === 'materials' || kind === 'bowls' || kind === 'tuning') {
        renderPalette();
        scheduleDraw();
        if (st.mode === 'layout') scheduleApply();
      }
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
  const lab = (c) => view.ctx.sendInput({ lab: c });
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
  const inst = (i) => (i === TABLE_I ? BG().table : models()[i]);
  const snapV = (v) => snapTo(v, st.snap);
  const freshTable = () => ({ model: D().models.board ? 'board' : Object.keys(D().models)[0], scale: 1, rotation: [0, 0, 0], translate: [0, 0, 2] });
  const fresh = (model) => ({ model, scale: 1, rotation: [0, 0, 0], translate: [0, 0, -40] });

  const probEl = h('span', { class: 'bb-st-prob' });
  const head = h('div', { class: 'bb-st-head' }, h('strong', {}, 'Background studio'), probEl, h('span', { class: 'bb-dbg-grow' }),
    btn('Close', () => api.close()));
  const bar = h('div', { class: 'bb-st-bar' });
  const body = h('div', { class: 'bb-st-body' });
  const root = h('div', { class: 'bb-st bb-st-dock' }, head, bar, body);

  function applyLevel() {
    clearTimeout(applyTimer);
    applyTimer = 0;
    if (!st.open) return;
    api.flush();
    if (api.problems().length || !L()) return;
    lab({ play: st.lvl });
  }

  /** the numbers of one model changed: show it at once, tell the draft */
  function pushInst(i) {
    view.debugSetInstance(i, inst(i));
    api.touch('backgrounds');
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
          w.select('floor', [['sand', 'raked sand'], ['wood', 'wooden planks']], bg.ground, 'style', 'backgrounds'),
          w.slider('time of day (hour)', bg.light, 'time', 'backgrounds', 0, 24, 0.25),
          w.slider('shadow darkness', bg.light, 'shadow', 'backgrounds', 0, 1, 0.05),
          row3('light direction', bg.light.dir, -1, 0.1))),
      h('details', { class: 'bb-st-inst bb-st-fold' }, h('summary', {}, 'Blur (light and heavy)'),
        h('div', { class: 'bb-st-instbody' },
          w.slider('light blur (px)', bg, 'blur', 'backgrounds', 0, 20, 0.5),
          w.slider('heavy blur (px)', bg, 'blurFar', 'backgrounds', 0, 40, 0.5),
          w.select('floor', BLUR_CHOICES, bg.ground, 'blur', 'backgrounds'),
          h('div', { class: 'bb-st-hint' }, 'Every model below picks none, light or heavy blur.'))),
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
      h('div', { class: 'bb-st-sub' }, 'Add a model'),
      addBox);
    showPrev();
  }

  function removeAt(i) {
    if (i === TABLE_I) delete BG().table;
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
      drag = { i, vertical: e.shiftKey, start: { x: e.clientX, y: e.clientY }, t0: [...m.translate], r0: [...m.rotation], s0: m.scale ?? 1, off: null };
      if (st.tool === 'move' && !drag.vertical) {
        const g = view.debugGroundAt(e.clientX, e.clientY, m.translate[1]);
        drag.off = g ? { x: m.translate[0] - g.x, z: m.translate[2] - g.z } : { x: 0, z: 0 };
      }
      return true;
    },
    move(e) {
      if (!drag) return;
      const m = inst(drag.i);
      if (!m) return;
      const dx = e.clientX - drag.start.x;
      const dy = e.clientY - drag.start.y;
      const slow = e.shiftKey && st.tool !== 'move' ? 0.2 : 1;
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
        m.translate[0] = snapV(g.x + drag.off.x);
        m.translate[2] = snapV(g.z + drag.off.z);
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
    } else if ((k === 'q' || k === 'e') && st.tool !== 'none') {
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
      view.debugDock(DOCK);
      view.onSnap = onSnap;
      lab({ on: true, paused: true, rules: false });
      view.debugFreeCam(true);
      view.camHook = hook;
      renderAll();
      applyLevel();
    },
    hide() {
      if (!st.open) return;
      st.open = false;
      clearTimeout(applyTimer);
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
 * @param api   { draft(): the current draft, touch(kind), flush(), problems(): string[], w: the widget builders of the debug menu,
 *                statusEl, open(name), close() }
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
    changed(kind) {
      if (current) pane(current).changed(kind);
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

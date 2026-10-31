// CLIENT ONLY: tiny DOM helpers shared by the debug menu (debug.js) and the studios (studio.js).

export const NS = 'http://www.w3.org/2000/svg';

/** Tiny element builder: h('div', { class: 'x', onclick }, child, 'text', [more children]). Props are applied in order (put `type` first). */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
export const svg = (name, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  kids.forEach((k) => e.append(k));
  return e;
};
export const clone = (v) => JSON.parse(JSON.stringify(v));

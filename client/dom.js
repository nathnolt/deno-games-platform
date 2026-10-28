/** Tiny hyperscript helper: el('button', { class: 'x', onclick: fn }, 'Label') */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  node.append(...children);
  return node;
}

// CLIENT ONLY: a tiny Wavefront .obj reader. No three.js in here, so it is easy to test.
//
// Understands: v, vn, f (any number of corners, `v`, `v/vt`, `v//vn`, `v/vt/vn`, negative indices), o, g, usemtl. Everything else is ignored
// (no textures, no material files: colour comes from the shaders in definitions.js).
//
// A model is split into PARTS so each part can have its own shader. A face belongs to the part named by the last `usemtl`
// (Blender: the material) or, when there is none, by the last `o` / `g` (Blender: the object). Faces before any name are the part "default".

/**
 * @param {string} text contents of the .obj file
 * @returns {{ parts: { name: string, positions: number[], normals: number[] | null, triangles: number }[] }}
 *   positions / normals are flat lists, three numbers per corner, three corners per triangle (nothing is indexed)
 */
export function parseObj(text) {
  const V = [];
  const VN = [];
  const parts = new Map();
  let group = 'default';
  let mtl = null;

  const part = () => {
    const name = mtl ?? group;
    let p = parts.get(name);
    if (!p) parts.set(name, (p = { name, positions: [], normals: [], hasNormals: true, triangles: 0 }));
    return p;
  };
  const idx = (s, len) => {
    const i = parseInt(s, 10);
    return i < 0 ? len + i : i - 1;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    switch (t[0]) {
      case 'v': V.push([+t[1], +t[2], +t[3]]); break;
      case 'vn': VN.push([+t[1], +t[2], +t[3]]); break;
      case 'o':
      case 'g': group = t.slice(1).join(' ') || 'default'; break;
      case 'usemtl': mtl = t.slice(1).join(' ') || null; break;
      case 'f': {
        const corners = t.slice(1).map((c) => {
          const [vi, , ni] = c.split('/');
          return { p: V[idx(vi, V.length)], n: ni ? VN[idx(ni, VN.length)] : null };
        });
        if (corners.length < 3 || corners.some((c) => !c.p)) break;
        const p = part();
        for (let k = 1; k < corners.length - 1; k++) { // fan: a quad becomes two triangles
          for (const c of [corners[0], corners[k], corners[k + 1]]) {
            p.positions.push(...c.p);
            if (c.n) p.normals.push(...c.n);
            else p.hasNormals = false;
          }
          p.triangles++;
        }
        break;
      }
      default: break;
    }
  }
  return {
    parts: [...parts.values()].map((p) => ({
      name: p.name,
      positions: p.positions,
      normals: p.hasNormals && p.normals.length === p.positions.length ? p.normals : null,
      triangles: p.triangles,
    })),
  };
}

/** Flat normals: every triangle gets the normal of its own face. Returns a list the same length as `positions`. */
export function flatNormals(positions) {
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i += 9) {
    const ux = positions[i + 3] - positions[i], uy = positions[i + 4] - positions[i + 1], uz = positions[i + 5] - positions[i + 2];
    const wx = positions[i + 6] - positions[i], wy = positions[i + 7] - positions[i + 1], wz = positions[i + 8] - positions[i + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) { out[i + k * 3] = nx; out[i + k * 3 + 1] = ny; out[i + k * 3 + 2] = nz; }
  }
  return out;
}

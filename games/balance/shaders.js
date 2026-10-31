// CLIENT ONLY: GLSL for every material. A material in shared.js names one of these with `shader: '...'`.
// To add a look: add a fragment shader here (copy one, change main()) and point a material at it.
//
// What a block shader can use (declared in `prelude`):
//   vP        position on the block's face, in world units, centred on the shape and rotating with it (textures stay glued to the block)
//   vP3       position in the mesh's own 3D space (used by the bowl and the table, which are not flat blocks)
//   uSeed     random number per block, so two wooden blocks do not have identical grain
//   uTime     seconds
//   finish()  call it for the final colour: it adds simple lighting (so the 3D sides are shaded), the coloured glow of a block
//             somebody is holding, and the red tint of a block that cannot be dropped where it is

export const vertexShader = /* glsl */ `
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
void main() {
  vP = position.xy;
  vP3 = position;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const prelude = /* glsl */ `
precision highp float;
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
uniform float uTime;
uniform float uSeed;
uniform vec3 uGlow;
uniform float uBad;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}
vec4 finish(vec3 c, float a) {
  vec3 n = normalize(vN);
  float light = 0.52 + 0.55 * max(dot(n, normalize(vec3(-0.35, 0.6, 0.72))), 0.0) + 0.12 * max(n.y, 0.0);
  c *= light;
  c = mix(c, vec3(1.0, 0.2, 0.2), uBad * 0.55);
  c += uGlow * 0.28;
  return vec4(c, a);
}
`;

const frag = (body) => prelude + body;

/** name -> fragment shader source. */
export const shaders = {
  wood: frag(/* glsl */ `
void main() {
  vec2 p = vP + uSeed * 17.0;
  float warp = fbm(p * vec2(0.5, 1.6));
  float rings = sin((p.y * 3.2 + warp * 5.0) * 3.14159);
  vec3 c = mix(vec3(0.64, 0.42, 0.21), vec3(0.45, 0.27, 0.12), 0.5 + 0.3 * rings);
  c *= 0.9 + 0.2 * fbm(p * 6.0);
  gl_FragColor = finish(c, 1.0);
}`),

  // the wooden bowl: darker, turned-wood bands that follow the curve all the way round
  bowlwood: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float warp = fbm(q.xz * 0.3 + vec2(q.y * 0.25, 3.0));
  float rings = sin((q.y * 1.7 + warp * 4.0) * 3.14159);
  vec3 c = mix(vec3(0.50, 0.30, 0.14), vec3(0.34, 0.19, 0.08), 0.5 + 0.4 * rings);
  c *= 0.88 + 0.24 * fbm(vec2(q.x + q.z, q.y * 3.0) * 1.5);
  gl_FragColor = finish(c, 1.0);
}`),

  // the table: wide planks running left to right
  floorwood: frag(/* glsl */ `
void main() {
  vec2 p = vec2(vP3.x, vP3.z + vP3.y) + uSeed * 9.0;
  float plank = floor(p.y / 3.2);
  vec2 q = vec2(p.x * 0.35 + hash(vec2(plank, 3.0)) * 40.0, p.y);
  float warp = fbm(vec2(q.x * 0.5, q.y * 2.5));
  float grain = sin((q.y * 2.0 + warp * 6.0) * 3.14159);
  vec3 base = mix(vec3(0.60, 0.40, 0.20), vec3(0.44, 0.27, 0.12), hash(vec2(plank, 7.0)));
  vec3 c = mix(base, base * 0.8, 0.5 + 0.3 * grain);
  c *= 0.9 + 0.2 * fbm(q * vec2(1.0, 4.0));
  float f = fract(p.y / 3.2);
  c *= 1.0 - smoothstep(0.03, 0.0, min(f, 1.0 - f)) * 0.5;
  gl_FragColor = finish(c, 1.0);
}`),

  glass: frag(/* glsl */ `
void main() {
  vec2 p = vP + uSeed * 5.0;
  vec3 c = mix(vec3(0.55, 0.80, 0.93), vec3(0.82, 0.95, 1.0), 0.5 + 0.5 * sin(p.x * 0.7 + p.y * 0.5));
  float streak = smoothstep(0.0, 0.35, sin((p.x - p.y) * 1.2 + 1.0));
  c += streak * 0.16;
  gl_FragColor = finish(c, 0.8);
}`),

  stone1: frag(/* glsl */ `
void main() {
  vec2 p = vP + uSeed * 11.0;
  vec3 c = vec3(0.52, 0.53, 0.58) * (0.72 + 0.5 * fbm(p * 3.0));
  c += step(0.93, hash(floor(p * 14.0))) * 0.22;
  float vein = smoothstep(0.02, 0.0, abs(fbm(p * 1.3) - 0.5));
  c = mix(c, vec3(0.78, 0.8, 0.86), vein * 0.5);
  gl_FragColor = finish(c, 1.0);
}`),

  // fixed, unmovable material: darker slate with chiselled lines, clearly different from anything you can pick up
  stone2: frag(/* glsl */ `
void main() {
  vec2 p = vP + uSeed * 3.0;
  vec3 c = vec3(0.30, 0.34, 0.43) * (0.8 + 0.4 * fbm(p * 2.5));
  float rows = smoothstep(0.03, 0.0, abs(fract(p.y * 0.8) - 0.5) - 0.47);
  float hatch = step(0.5, fract((p.x + p.y) * 2.2)) * 0.035;
  c = c * (1.0 - rows * 0.35) + hatch;
  gl_FragColor = finish(c, 1.0);
}`),

  // buoyant block: orange / cream stripes like a lifebuoy
  float: frag(/* glsl */ `
void main() {
  vec2 p = vP;
  float s = step(0.5, fract(p.x * 0.42 + 0.1));
  vec3 c = mix(vec3(0.95, 0.42, 0.18), vec3(0.97, 0.94, 0.88), s);
  gl_FragColor = finish(c, 1.0);
}`),
};

/** Shaders whose blocks are see-through (drawn after the opaque ones, no depth writes). */
export const transparentShaders = new Set(['glass']);

/** Colour of the edge lines drawn around blocks of each shader (default '#1a1020'). */
export const outlineColor = { glass: '#5f9fbf', stone2: '#0c0f16' };

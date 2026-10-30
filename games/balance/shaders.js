// CLIENT ONLY: GLSL for every material. A material in shared.js names one of these with `shader: '...'`.
// To add a look: add a fragment shader here (copy one, change main()) and point a material at it.
//
// What a block shader can use (declared in `prelude`):
//   vP        position inside the shape, in world units, centred on the shape and rotating with it (so textures stay glued to the block)
//   uSeed     random number per block, so two wooden blocks do not have identical grain
//   uTime     seconds
//   finish()  call it for the final colour: it adds the "being held" glow and the red "cannot drop here" tint

export const vertexShader = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const prelude = /* glsl */ `
precision highp float;
varying vec2 vP;
uniform float uTime;
uniform float uSeed;
uniform float uHeld;
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
  c = mix(c, vec3(1.0, 0.22, 0.22), uBad * 0.6);
  c += uHeld * 0.07;
  return vec4(c, a);
}
`;

const frag = (body) => prelude + body;

/** name -> fragment shader source. `transparent: true` for shaders that output alpha < 1. */
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

  glass: frag(/* glsl */ `
void main() {
  vec2 p = vP + uSeed * 5.0;
  vec3 c = mix(vec3(0.55, 0.80, 0.93), vec3(0.82, 0.95, 1.0), 0.5 + 0.5 * sin(p.x * 0.7 + p.y * 0.5));
  float streak = smoothstep(0.0, 0.35, sin((p.x - p.y) * 1.2 + 1.0));
  c += streak * 0.16;
  gl_FragColor = finish(c, 0.82);
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
  vec3 c = vec3(0.22, 0.25, 0.32) * (0.8 + 0.4 * fbm(p * 2.5));
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
  c *= 0.93 + 0.07 * sin(uTime * 1.3 + p.x);
  gl_FragColor = finish(c, 1.0);
}`),
};

/** Colour of the outline drawn around blocks of each shader (default '#150f1f'). */
export const outlineColor = { glass: '#5f9fbf', stone2: '#0c0f16' };

// ── scenery ──
export const waterVertex = /* glsl */ `
varying vec2 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** Water: wavy surface at y = 0, drawn over the blocks so submerged parts look submerged. */
export const waterFrag = /* glsl */ `
precision highp float;
varying vec2 vW;
uniform float uTime;
uniform float uDepth;
void main() {
  float surf = 0.18 * sin(vW.x * 0.9 + uTime * 1.6) + 0.12 * sin(vW.x * 1.7 - uTime * 1.1);
  if (vW.y > surf) discard;
  float d = clamp((surf - vW.y) / uDepth, 0.0, 1.0);
  vec3 c = mix(vec3(0.30, 0.72, 0.92), vec3(0.03, 0.18, 0.42), pow(d, 0.6));
  c += 0.07 * sin(vW.x * 2.0 + vW.y * 3.0 + uTime) * (1.0 - d);
  c += smoothstep(0.14, 0.0, surf - vW.y) * 0.35;
  gl_FragColor = vec4(c, mix(0.58, 0.85, d));
}`;

export const backgroundVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const backgroundFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vec3 top = vec3(0.10, 0.12, 0.26);
  vec3 bottom = vec3(0.05, 0.06, 0.14);
  vec3 c = mix(bottom, top, smoothstep(0.0, 1.0, vUv.y));
  c += 0.05 * smoothstep(0.7, 0.0, distance(vUv, vec2(0.5, 0.65)));
  gl_FragColor = vec4(c, 1.0);
}`;

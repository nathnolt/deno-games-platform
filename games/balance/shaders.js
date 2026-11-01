// CLIENT ONLY: GLSL for every material. A material in shared.js names one of these with `shader: '...'`.
// To add a look: add a fragment shader here (copy one, change main()) and point a material at it.
//
// What a block shader can use (declared in `prelude`):
//   vP        texture coordinates in world units, glued to the block (front/back: x, y; sides and chamfers: distance along the edge, z)
//   vP3       position in the mesh's own 3D space. Shaders that use it (bowlwood, wood2, ceramic, bark ...) work on ANY mesh: bowls, models, blocks
//   uSeed     random number per block, so two wooden blocks do not have identical grain
//   uTime     seconds
//   finish()  call it for the final colour: it adds simple lighting (so the 3D sides are shaded), the coloured glow of a block
//             somebody is holding, and the red tint of a block that cannot be dropped where it is

/** The shadow lookup shared by every lit material (and the floor): `shadowAt(worldPosition, worldNormal)` is 1 in light, less in shadow. */
export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMat;
uniform float uShadowStr;
uniform vec2 uShadowTexel;
float unpackShadowDepth(vec4 v) { return dot(v, vec4(255.0 / 256.0 / 16777216.0, 255.0 / 256.0 / 65536.0, 255.0 / 256.0 / 256.0, 255.0 / 256.0)); }
float shadowAt(vec3 wp, vec3 n) {
  if (uShadowStr <= 0.0) return 1.0;
  vec4 sp = uShadowMat * vec4(wp + n * 0.15, 1.0);
  vec3 p = sp.xyz / sp.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float lit = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      float d = unpackShadowDepth(texture2D(uShadowMap, p.xy + vec2(float(i), float(j)) * uShadowTexel));
      lit += (p.z - 0.0012 > d) ? 0.0 : 1.0;
    }
  }
  return 1.0 - uShadowStr * (1.0 - lit / 9.0);
}
`;

export const vertexShader = /* glsl */ `
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
varying vec3 vW;
varying vec3 vWN;
varying float vDist;
void main() {
  vP = uv; //   texture coordinates made by the client: the front face is (x, y), the sides run along the outline and up the depth
  vP3 = position;
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  vWN = normalize(mat3(modelMatrix) * normal);
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const prelude = /* glsl */ `
precision highp float;
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
varying vec3 vW;
varying vec3 vWN;
varying float vDist;
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform float uTime;
uniform float uSeed;
uniform vec3 uGlow;
uniform float uBad;

${SHADOW_GLSL}
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
  if (!gl_FrontFacing) n = -n; // two-sided surfaces (the bowl, models) are lit from the side you are looking at
  float light = 0.52 + 0.55 * max(dot(n, normalize(vec3(-0.35, 0.6, 0.72))), 0.0) + 0.12 * max(n.y, 0.0);
  vec3 wn = normalize(vWN);
  if (!gl_FrontFacing) wn = -wn;
  c *= light * shadowAt(vW, wn);
  c = mix(c, vec3(1.0, 0.2, 0.2), uBad * 0.55);
  c += uGlow * 0.28;
  c = mix(c, uFogColor, smoothstep(uFog.x, uFog.y, vDist)); // distant background models melt into the mist
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

  // dark red-brown mahogany: long straight grain with darker streaks (3D: works on any mesh)
  mahogany: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float warp = fbm(vec2(q.x * 0.15 + q.z * 0.1, q.y * 0.9));
  float grain = sin((q.y * 2.6 + q.z * 1.3 + warp * 7.0) * 3.14159);
  float streak = fbm(vec2(q.x * 0.5 + q.z * 0.5, q.y * 6.0));
  vec3 c = mix(vec3(0.36, 0.12, 0.07), vec3(0.20, 0.06, 0.04), 0.5 + 0.35 * grain);
  c = mix(c, vec3(0.50, 0.19, 0.10), smoothstep(0.55, 0.9, streak) * 0.6);
  c *= 0.9 + 0.18 * fbm(vec2(q.x + q.z, q.y * 14.0));
  gl_FragColor = finish(c, 1.0);
}`),

  // small black pebbles: dark, smooth, with a few pale flecks
  blackstone: frag(/* glsl */ `
void main() {
  vec3 q = vP3 * 2.0;
  float n = fbm(q.xy + q.z * 0.7);
  vec3 c = mix(vec3(0.05, 0.05, 0.06), vec3(0.17, 0.17, 0.19), n);
  c += step(0.965, hash(floor(q.xy * 9.0 + q.z * 5.0))) * 0.25;
  gl_FragColor = finish(c, 1.0);
}`),

  // plain warm plaster for indoor walls
  plaster: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  vec3 c = vec3(0.80, 0.72, 0.60) * (0.95 + 0.07 * fbm(q.xy * 0.6 + q.z));
  c *= 0.97 + 0.03 * hash(floor(q.xy * 6.0));
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

  // ── 3D shaders (they use vP3, so they fit bowls and models) ──

  // pale ash / beech: lighter than 'bowlwood', bands that follow the height
  wood2: frag(/* glsl */ `
void main() {
  vec3 q = vP3 + uSeed * 9.0;
  float warp = fbm(q.xz * 0.3 + vec2(q.y * 0.25, 7.0));
  float rings = sin((q.y * 2.2 + warp * 3.5) * 3.14159);
  vec3 c = mix(vec3(0.84, 0.68, 0.46), vec3(0.72, 0.54, 0.33), 0.5 + 0.35 * rings);
  c *= 0.92 + 0.16 * fbm(vec2(q.x + q.z, q.y * 4.0) * 1.2);
  gl_FragColor = finish(c, 1.0);
}`),

  // white glaze with a cobalt band round the rim and a wavy line lower down
  ceramic: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float a = atan(q.z, q.x);
  float rim = smoothstep(0.06, 0.0, abs(q.y - 0.0) - 0.5);
  float wave = smoothstep(0.08, 0.0, abs(q.y + 2.6 + 0.5 * sin(a * 7.0)) - 0.18);
  vec3 c = mix(vec3(0.95, 0.95, 0.92), vec3(0.20, 0.36, 0.60), clamp(rim + wave, 0.0, 1.0) * 0.92);
  c *= 0.96 + 0.06 * noise(q.xz * 5.0 + q.y * 2.0);
  gl_FragColor = finish(c, 1.0);
}`),

  bark: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float a = atan(q.z, q.x);
  float streak = fbm(vec2(a * 3.0, q.y * 0.9));
  vec3 c = mix(vec3(0.24, 0.17, 0.12), vec3(0.44, 0.32, 0.21), streak);
  c *= 0.82 + 0.3 * noise(vec2(a * 9.0, q.y * 3.0));
  gl_FragColor = finish(c, 1.0);
}`),

  leaves: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float n = fbm(q.xy * 1.2 + q.zy * 0.8);
  vec3 c = mix(vec3(0.20, 0.42, 0.20), vec3(0.47, 0.66, 0.28), n);
  gl_FragColor = finish(c, 1.0);
}`),

  blossom: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float n = fbm(q.xy * 1.4 + q.zy * 0.9);
  vec3 c = mix(vec3(0.93, 0.68, 0.76), vec3(1.0, 0.90, 0.92), n);
  gl_FragColor = finish(c, 1.0);
}`),

  bamboo: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float knot = smoothstep(0.05, 0.0, abs(fract(q.y) - 0.92) - 0.06);
  vec3 c = mix(vec3(0.40, 0.58, 0.26), vec3(0.56, 0.70, 0.34), noise(vec2(q.y * 2.0, q.x * 9.0 + q.z * 9.0)));
  c = mix(c, vec3(0.28, 0.40, 0.18), knot * 0.8);
  gl_FragColor = finish(c, 1.0);
}`),

  // paper lantern light: warm and brighter than everything around it
  paper: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  vec3 c = vec3(1.18, 0.98, 0.66) * (0.9 + 0.1 * noise(q.xy * 8.0));
  gl_FragColor = finish(c, 1.0);
}`),

  // grey-blue rock turning to snow near the top (made for mountain.obj: 40 units tall)
  mountain: frag(/* glsl */ `
void main() {
  vec3 q = vP3;
  float snow = smoothstep(27.0 + 3.0 * fbm(q.xz * 0.15), 36.0, q.y);
  vec3 c = mix(vec3(0.46, 0.53, 0.60), vec3(0.62, 0.68, 0.72), fbm(q.xz * 0.12 + q.y * 0.05));
  c = mix(c, vec3(0.95, 0.96, 0.97), snow);
  gl_FragColor = finish(c, 1.0);
}`),
};

/** Shaders whose blocks are see-through (drawn after the opaque ones, no depth writes). */
export const transparentShaders = new Set(['glass']);

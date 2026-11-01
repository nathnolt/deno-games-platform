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

/** Light shared by every lit material (and the floor). ONE light in world space drives both the shading and the shadow map, so they always agree:
 *   uLightDir  towards the sun / moon      uLightCol  its colour times its strength (changes with the time of day)
 *   uAmbSky / uAmbGround  the soft light from above and from below (a hemisphere): shadows are never black, they take the colour of the sky
 *   sceneLight(position, normal) -> the colour a surface is multiplied with. Wrap lighting softens the edge between lit and dark side,
 *   and the shadow map only ever removes the DIRECT light.
 *   shadowAt(position, normal) -> 1 in light, 0 in shadow: normal-offset + slope bias against acne, and a contact-hardening soft edge
 *   (the further a block is above what it shades, the softer the shadow gets: blocker search, then a rotated 16-tap disc). */
export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMat;
uniform float uShadowStr;
uniform vec2 uShadowTexel;
uniform float uShadowRange;
uniform float uShadowDepth;
uniform vec3 uLightDir;
uniform vec3 uLightCol;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
float unpackShadowDepth(vec4 v) { return dot(v, vec4(255.0 / 256.0 / 16777216.0, 255.0 / 256.0 / 65536.0, 255.0 / 256.0 / 256.0, 255.0 / 256.0)); }
float shadowNoise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 vogel(int i, int n, float phi) {
  float r = sqrt((float(i) + 0.5) / float(n));
  float th = float(i) * 2.399963 + phi;
  return vec2(cos(th), sin(th)) * r;
}
float shadowAt(vec3 wp, vec3 n) {
  if (uShadowStr <= 0.0) return 1.0;
  float ndl = clamp(dot(n, uLightDir), 0.0, 1.0);
  float texW = uShadowTexel.x * uShadowRange; // world size of one shadow texel
  vec4 sp = uShadowMat * vec4(wp + n * texW * (1.2 + 2.8 * (1.0 - ndl)), 1.0);
  vec3 p = sp.xyz / sp.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float zr = p.z - (0.0003 + 0.0007 * (1.0 - ndl));
  float phi = 6.2831853 * shadowNoise(gl_FragCoord.xy);
  float sum = 0.0;
  float cnt = 0.0;
  for (int i = 0; i < 12; i++) { // 1. who is in the way?
    float d = unpackShadowDepth(texture2D(uShadowMap, p.xy + vogel(i, 12, phi) * uShadowTexel * 6.0));
    if (d < zr) { sum += d; cnt += 1.0; }
  }
  if (cnt < 0.5) return 1.0;
  float gap = (zr - sum / cnt) * uShadowDepth; // 2. how far above this surface is it (world units)
  float rad = clamp(gap * 0.07 / texW, 1.2, 7.0); //   the further, the softer
  float lit = 0.0;
  for (int i = 0; i < 16; i++) { // 3. soft edge
    float d = unpackShadowDepth(texture2D(uShadowMap, p.xy + vogel(i, 16, phi + 1.7) * uShadowTexel * rad));
    lit += (d < zr) ? 0.0 : 1.0;
  }
  return lit / 16.0;
}
vec3 sceneLight(vec3 wp, vec3 n) {
  float ndl = dot(n, uLightDir);
  float wrap = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
  float sh = shadowAt(wp, n);
  float k = clamp(uShadowStr * 1.8, 0.0, 1.0); // (the strength in definitions.js: 0 = no shadows, 0.55+ = fully dark)
  sh = 1.0 - k * (1.0 - sh);
  sh = mix(1.0, sh, smoothstep(-0.05, 0.25, ndl)); // the side turned away from the light is dark anyway: no map noise there
  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
  return amb + uLightCol * (wrap * sh);
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
uniform float uWaterY;
uniform float uCaus;
uniform vec2 uBowlHalf;

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
// caustics: the bright net the ripples of the water throw on whatever is under it (a tiling pattern of folded sines)
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
vec4 finish(vec3 c, float a) {
  vec3 wn = normalize(vWN);
  if (!gl_FrontFacing) wn = -wn; // two-sided surfaces (the bowl, models) are lit from the side you are looking at
  vec3 L = sceneLight(vW, wn);
  float depth = uWaterY - vW.y;
  if (uCaus > 0.0 && depth > 0.0) { // under the water, inside the bowl
    vec2 m = abs(vW.xz) / uBowlHalf;
    float inside = 1.0 - smoothstep(0.9, 1.0, pow(pow(m.x, 4.0) + pow(m.y, 4.0), 0.25));
    vec2 q = vW.xz + uLightDir.xz / max(uLightDir.y, 0.3) * depth; // where the ray crossed the surface
    float k = caustic(q * 0.3, uTime * 0.55) * (0.35 + 0.65 * clamp(dot(wn, uLightDir) + 0.4, 0.0, 1.0));
    float fade = exp(-depth * 0.06) * smoothstep(0.0, 0.5, depth) * inside;
    L += uLightCol * (k * uCaus * fade * 2.4);
    c = mix(c, c * vec3(0.8, 0.93, 1.0), 0.55 * fade);
  }
  c *= L * 0.86;
  float rim = pow(1.0 - clamp(dot(wn, normalize(cameraPosition - vW)), 0.0, 1.0), 3.0);
  c += uAmbSky * (rim * 0.16);
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

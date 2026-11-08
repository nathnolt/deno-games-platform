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
 *   (a smooth 3x3-texel filter, no noise). */
export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMat;
uniform float uShadowStr;
uniform vec2 uShadowTexel;
uniform float uShadowRange;
uniform float uShadowDepth;
uniform vec3 uShadowR; // the sun camera's right and up axes in the world
uniform vec3 uShadowU;
uniform float uShadowBias; // depth offset, world units
uniform float uShadowNormal; // normal offset, in shadow texels
uniform int uShadowK; // 1 = crisp, 2 = soft, 3 = softer
uniform vec3 uLightDir;
uniform vec3 uLightCol;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uLPos[8]; // point lights of the background (world position, colour times intensity, reach); 8 = MAX_LIGHTS in shared.js
uniform vec3 uLCol[8];
uniform float uLRange[8];
uniform int uLN;
float unpackShadowDepth(vec4 v) { return dot(v, vec4(255.0 / 256.0 / 16777216.0, 255.0 / 256.0 / 65536.0, 255.0 / 256.0 / 256.0, 255.0 / 256.0)); }
float shadowAt(vec3 wp, vec3 n) {
  if (uShadowStr <= 0.0) return 1.0;
  float ndl = clamp(dot(n, uLightDir), 0.0, 1.0);
  float texW = uShadowTexel.x * uShadowRange; // world size of one shadow texel
  vec4 sp = uShadowMat * vec4(wp + n * (texW * uShadowNormal * (0.5 + (1.0 - ndl))), 1.0); // normal offset: the surface is moved off itself before the lookup
  vec3 p = sp.xyz / sp.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  // RECEIVER PLANE: how fast the depth changes across the shadow map on this very surface, worked out from its NORMAL (smooth over the whole
  // surface, unlike screen-space derivatives which are constant per 2x2 pixels and draw lines). Every texel is compared with the depth the
  // surface really has THERE: this is what keeps sloped surfaces free of acne stripes.
  vec2 slope = vec2(dot(n, uShadowR), dot(n, uShadowU)) * (uShadowRange / (uShadowDepth * max(ndl, 0.12)));
  slope = clamp(slope, vec2(-4.0), vec2(4.0));
  float zr = p.z - (uShadowBias / uShadowDepth) * (0.5 + (1.0 - ndl));
  // a SMOOTH box filter, (2K+1)x(2K+1) texels with the outermost ones weighted by where the point lies between texel centres ("bilinear PCF").
  // No random rotation or noise: nothing that could beat against the texel grid.
  vec2 t = p.xy / uShadowTexel - 0.5;
  vec2 f = fract(t);
  vec2 base = floor(t) + 0.5;
  float lit = 0.0;
  for (int j = -3; j <= 4; j++) {
    if (j < -uShadowK || j > uShadowK + 1) continue;
    float wy = (j == -uShadowK) ? 1.0 - f.y : ((j == uShadowK + 1) ? f.y : 1.0);
    for (int i = -3; i <= 4; i++) {
      if (i < -uShadowK || i > uShadowK + 1) continue;
      float wx = (i == -uShadowK) ? 1.0 - f.x : ((i == uShadowK + 1) ? f.x : 1.0);
      vec2 uv = (base + vec2(float(i), float(j))) * uShadowTexel;
      float d = texture2D(uShadowMap, uv).r; // (a real depth texture: 24 bits, no packing)
      lit += wx * wy * ((d < zr + dot(uv - p.xy, slope)) ? 0.0 : 1.0);
    }
  }
  float k2 = float(2 * uShadowK + 1);
  return lit / (k2 * k2);
}
float gDirect = 0.0; // how much the sun lights the surface (wrap diffuse times shadow): the last sceneLight() call leaves it here, for the blown-out look
float gSh = 1.0; // how much of the sun reaches the surface (1 = fully lit, lower in shadow): the last sceneLight() call leaves it here, for the shine
vec3 sceneLight(vec3 wp, vec3 n) {
  float ndl = dot(n, uLightDir);
  float wrap = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
  float sh = shadowAt(wp, n);
  float k = clamp(uShadowStr * 1.8, 0.0, 1.0); // (the strength in definitions.js: 0 = no shadows, 0.55+ = fully dark)
  sh = 1.0 - k * (1.0 - sh);
  sh = mix(1.0, sh, smoothstep(-0.05, 0.25, ndl)); // the side turned away from the light is dark anyway: no map noise there
  gSh = sh;
  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
  vec3 lamps = vec3(0.0);
  for (int i = 0; i < 8; i++) { // point lights: no shadows, they fade out smoothly at their range
    if (i >= uLN) break;
    vec3 d = uLPos[i] - wp;
    float dist = length(d);
    float att = clamp(1.0 - dist / uLRange[i], 0.0, 1.0);
    float w = clamp((dot(n, d / max(dist, 0.001)) + 0.35) / 1.35, 0.0, 1.0);
    lamps += uLCol[i] * (w * att * att);
  }
  gDirect = wrap * sh;
  return amb + uLightCol * (wrap * sh) + lamps;
}
`;

export const vertexShader = /* glsl */ `
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
varying vec3 vW;
varying vec3 vWN;
varying float vDist;
varying vec3 vRX; // the mesh's own x / y / z axes in the world (its rotation): a bump map made in the mesh's space is turned into the world with them
varying vec3 vRY;
varying vec3 vRZ;
void main() {
  mat3 R = mat3(modelMatrix);
  vRX = R[0]; vRY = R[1]; vRZ = R[2];
  vP = uv; //   texture coordinates made by the client: the front face is (x, y), the sides run along the outline and up the depth
  vP3 = position;
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  vWN = normalize(mat3(modelMatrix) * normal);
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

/**
 * Like vertexShader, but the faces of the block ripple: every vertex is pushed forwards or backwards (along the depth of the block) by a wave. The EDGES stay
 * where they are: how much a vertex moves is multiplied by its `edge` (distance to the outline of the shape, see addEdgeDistance in client.js), which is 0 on
 * the outline, so the outline of the block, and so its collision, never changes: you always see exactly where it is. The movement is a function of the
 * vertex position only, so vertices at the same place move together: the surface stays closed. Only what is drawn moves; the physics does not.
 */
export const waveVertexShader = /* glsl */ `
attribute float edge;
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
varying vec3 vW;
varying vec3 vWN;
varying float vDist;
varying vec3 vRX; // the mesh's own x / y / z axes in the world (its rotation): a bump map made in the mesh's space is turned into the world with them
varying vec3 vRY;
varying vec3 vRZ;
uniform float uTime;
uniform float uSeed;
float vhash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vhash(i), vhash(i + vec2(1.0, 0.0)), f.x), mix(vhash(i + vec2(0.0, 1.0)), vhash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float swell(vec2 p, float t) { // slow waves, about -0.3 .. 0.3
  float h = 0.0;
  h += 0.10 * sin(dot(p, vec2(0.95, 0.31)) * 0.55 + t * 1.0);
  h += 0.05 * sin(dot(p, vec2(-0.37, 0.93)) * 0.90 + t * 1.3);
  h += (vnoise(p * 0.35 + vec2(t * 0.15, -t * 0.10)) - 0.5) * 0.30;
  h += (vnoise(p * 0.95 - vec2(t * 0.25, t * 0.20)) - 0.5) * 0.10;
  return h;
}
void main() {
  mat3 R = mat3(modelMatrix);
  vRX = R[0]; vRY = R[1]; vRZ = R[2];
  vP = uv;
  vP3 = position;
  float still = smoothstep(0.2, 1.3, edge); // 0 on the outline and the bevel, 1 well inside
  vec3 pos = position + vec3(0.0, 0.0, swell(position.xy + uSeed * 7.0, uTime) * 1.4 * still);
  vW = (modelMatrix * vec4(pos, 1.0)).xyz;
  vWN = normalize(mat3(modelMatrix) * normal);
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

/** Shaders whose blocks are drawn with waveVertexShader and a geometry cut into 3 x 3 (the faces ripple, the edges stay). */
export const deformShaders = new Set([]); // (the water block no longer uses it: no subdivided faces, the ripples are in the fragment shader only)

const prelude = /* glsl */ `
precision highp float;
varying vec2 vP;
varying vec3 vP3;
varying vec3 vN;
varying vec3 vW;
varying vec3 vWN;
varying float vDist;
varying vec3 vRX;
varying vec3 vRY;
varying vec3 vRZ;
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform float uTime;
uniform float uSeed;
uniform vec3 uGlow;
uniform float uBad;
uniform float uWaterY;
uniform float uCaus;
uniform float uCausOn; // 0 = this block gets no caustics (it is held, or waits on the table)
uniform float uCausInward;
uniform float uReveal; // 1 = the block is whole; below 1 it is dissolving in (a block that just came out of its outline on the table)
uniform vec2 uBowlHalf;
uniform float uAA; // graphics setting (texture filtering): 0 = off, 1 = trilinear, 1.5 = anisotropic 4x, 2 = anisotropic 16x: how early fine patterns fade out
uniform float uQuality; // graphics setting: 0 = low (no extra surface detail), 1 = medium (roughness maps), 2 = high (roughness maps and bump maps)

${SHADOW_GLSL}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// fbm is FILTERED: an octave whose cells are smaller than a pixel (steep camera angles, far away) is replaced by its average, so nothing shimmers or
// turns into streaks. (fwidth = how far p moves across one screen pixel; uAA = the texture filtering setting, 0 = off but still a little smoothing.)
float fbm(vec2 p) {
  vec2 fw = fwidth(p);
  float w = max(fw.x, fw.y) * (0.6 + 0.4 * uAA);
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    float keep = 1.0 - smoothstep(0.25, 0.7, w); // 1 while a cell covers several pixels, 0 when it is smaller than one
    s += a * mix(0.5, noise(p), keep);
    p *= 2.03; w *= 2.03; a *= 0.5;
  }
  return s;
}
// PERLIN (gradient) noise in 3D, from -1 to 1: every lattice point has a random direction, smooth quintic blending. pfbm = several octaves of it.
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 pgrad(vec3 p) { return vec3(h13(p), h13(p + 19.19), h13(p + 47.77)) * 2.0 - 1.0; } // (a random direction: no sin / cos / sqrt, this runs 8 times per noise call)
float perlin(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(pgrad(i), f);
  float n100 = dot(pgrad(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(pgrad(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(pgrad(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(pgrad(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(pgrad(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(pgrad(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(pgrad(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  return clamp(1.15 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z), -1.0, 1.0);
}
float pfbm(vec3 p) { // 0..1
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * perlin(p); p *= 2.02; a *= 0.5; }
  return clamp(s * 1.0 + 0.5, 0.0, 1.0);
}
// BUMP MAPS: a shader defines a height h(q) (any function of a position) and takes its slope: the surface normal then leans away from the slope.
//   float e = 0.03; float h0 = h(q);  vec3 g = vec3(h(q + vec3(e,0,0)) - h0, h(q + vec3(0,e,0)) - h0, h(q + vec3(0,0,e)) - h0) / e;
//   gNormal = bumpedNormal(g, 0.3, 1.0);  gHasN = 1.0;        (space: 1 = q is a position in the MESH (blocks that move), 0 = q is a position in the WORLD)
vec3 toWorld(vec3 o) { return vRX * o.x + vRY * o.y + vRZ * o.z; }
vec3 bumpedNormal(vec3 grad, float k, float space) {
  vec3 n0 = normalize(vWN);
  if (!gl_FrontFacing) n0 = -n0;
  vec3 g = space > 0.5 ? toWorld(grad) : grad;
  return normalize(n0 - k * (g - dot(g, n0) * n0));
}
// The CHEAP bump map, from the height you already have: the slope of h across the screen (derivatives of neighbouring pixels) tilts the normal. It needs
// no extra samples of the height (the 4-sample way above costs four times as much), and any pattern can be a height: the grain of a wood, the lumps of a stone.
//   if (uQuality > 1.5) { gNormal = bumpFromHeight(height, 0.045); gHasN = 1.0; }
vec3 bumpFromHeight(float h, float k) {
  vec3 n0 = normalize(vWN);
  if (!gl_FrontFacing) n0 = -n0;
  vec3 dpdx = dFdx(vW), dpdy = dFdy(vW);
  vec3 r1 = cross(dpdy, n0), r2 = cross(n0, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  vec3 t = k * grad / max(abs(det), 1e-8);
  float tl = length(t);
  t *= min(1.0, 0.35 / max(tl, 1e-6)); // cap the tilt: derivative noise can't produce harsh spikes
  return normalize(n0 - t);
}
// A roughness map: base plus a bit of Perlin noise around the position q (medium quality and up; at low quality it is just base).
float roughMap(vec3 q, float base, float amt) { return uQuality < 0.5 ? base : clamp(base + amt * perlin(q), 0.05, 1.0); }
// Anti-aliasing for procedural patterns: pass how many pattern cycles fit in one screen pixel (e.g. fwidth(p.y) * frequency); returns 1 while the
// pattern is still readable and fades to 0 where it is finer than a pixel (steep viewing angles, far away), so it blends to its average instead of shimmering.
float aaFade(float cyclesPerPixel) { return 1.0 - smoothstep(0.12, 0.45, cyclesPerPixel * (0.6 + 0.4 * uAA)); }
// two ready-made heights: wood (fine grain stretched along x) and rock (lumps, bumps, grain)
float woodHeight(vec3 q) { return 0.5 * perlin(q * vec3(0.6, 3.2, 0.6)) + 0.25 * perlin(q * vec3(1.5, 9.0, 1.5)) + 0.1 * perlin(q * 24.0); }
float rockHeight(vec3 q) { return 0.55 * perlin(q * 1.5) + 0.3 * perlin(q * 4.6) + 0.16 * perlin(q * 13.0) + 0.07 * perlin(q * 31.0); }
vec3 woodBump(vec3 q, float k, float space) {
  float e = 0.03, h0 = woodHeight(q);
  return bumpedNormal(vec3(woodHeight(q + vec3(e, 0.0, 0.0)) - h0, woodHeight(q + vec3(0.0, e, 0.0)) - h0, woodHeight(q + vec3(0.0, 0.0, e)) - h0) / e, k, space);
}
vec3 rockBump(vec3 q, float k, float space) {
  float e = 0.03, h0 = rockHeight(q);
  return bumpedNormal(vec3(rockHeight(q + vec3(e, 0.0, 0.0)) - h0, rockHeight(q + vec3(0.0, e, 0.0)) - h0, rockHeight(q + vec3(0.0, 0.0, e)) - h0) / e, k, space);
}
// caustics: the bright net the ripples of the water throw on whatever is under it (a tiling pattern of folded sines)
float caustic(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0; // (the big offset matters: close to 0 the folding below blows up)
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return min(pow(abs(c), 8.0), 1.5);
}
vec3 gNormal = vec3(0.0, 1.0, 0.0); // a shader can light the block with its OWN normal (a bump map): set gNormal and gHasN = 1.0 before finish()
float gHasN = 0.0;
vec3 gSpec = vec3(0.0); //  and add shine on top of the lighting (highlights are not multiplied by the colour of the surface)
vec3 gGlint = vec3(0.0); // like gSpec, but only where the sun is not in shadow (multiplied by how lit the surface is)
float gBlow = 0.0; //    where the sun hits the surface it gets brighter and a little blown out (0 = not at all, 1 = a lot)
float gShine = 0.0; //   strength of the highlight of this surface (0 = none: the shader does not shine)
float gRough = 0.6; //    how rough it is: 0 = a small hard highlight, 1 = a wide dull glow. A shader may change it from place to place (non-uniform shine)
vec4 finish(vec3 c, float a) {
  float dissolveEdge = 0.0;
  if (uReveal < 1.0) { // dissolve: the block appears out of noise, with a pale rim where it is just appearing
    float d = fbm(vP3.xy * 0.9 + vP3.z * 0.7 + uSeed * 9.0);
    float k = uReveal * 1.12;
    if (d > k) discard;
    dissolveEdge = smoothstep(k - 0.07, k, d);
  }
  vec3 albedo = c;
  vec3 wn = normalize(vWN);
  if (!gl_FrontFacing) wn = -wn; // two-sided surfaces (the bowl, models) are lit from the side you are looking at
  if (gHasN > 0.5) wn = gNormal;
  vec3 L = sceneLight(vW, wn);
  float depth = uWaterY - vW.y;
  if (uCaus * uCausOn > 0.0 && depth > 0.0) { // under the water, inside the bowl
    vec2 m = abs(vW.xz) / uBowlHalf;
    float inside = 1.0 - smoothstep(0.9, 1.0, pow(pow(m.x, 4.0) + pow(m.y, 4.0), 0.25));
    vec2 q = vW.xz + uLightDir.xz / max(uLightDir.y, 0.3) * depth; // where the ray crossed the surface
    float k = caustic(q * 0.11, uTime * 0.55) * (0.35 + 0.65 * clamp(dot(wn, uLightDir) + 0.4, 0.0, 1.0));
    vec3 gn = normalize(vWN); // (the true normal: for the bowl only the inside counts, not the outside or the underside)
    float inward = uCausInward > 0.5 ? max(step(dot(gn.xz, vW.xz), 0.0), step(0.5, gn.y)) : 1.0;
    float fade = exp(-depth * 0.06) * smoothstep(0.0, 0.5, depth) * inside * inward;
    L += uLightCol * (k * uCaus * fade * 2.4);
    c = mix(c, c * vec3(0.8, 0.93, 1.0), 0.55 * fade);
  }
  c *= L * 0.86;
  c += gSpec + gGlint * gSh;
  if (gBlow > 0.0) { // overexposure: the part the sun lights up pushes towards white
    float lit = smoothstep(0.45, 1.0, gDirect);
    c *= 1.0 + gBlow * 0.75 * lit;
    c = mix(c, vec3(1.0, 0.97, 0.9), gBlow * 0.5 * lit * lit);
  }
  if (gShine > 0.0) { // where the sun hits the surface it brightens the colour of the surface itself; the rougher, the wider and duller the bright part
    vec3 V = normalize(cameraPosition - vW);
    vec3 H = normalize(uLightDir + V);
    float nh = clamp(dot(wn, H), 0.0, 1.0);
    float nl = clamp(dot(wn, uLightDir), 0.0, 1.0);
    float r = clamp(gRough, 0.05, 1.0);
    float lobe = pow(nh, mix(160.0, 4.0, r * r)) * mix(1.0, 0.25, r);
    float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(wn, V), 0.0, 1.0), 5.0);
    vec3 tint = mix(vec3(1.0), clamp(albedo * 2.2, 0.0, 1.4), 0.6);
    c += uLightCol * tint * (lobe * gShine * (0.55 + fres) * gSh * smoothstep(0.0, 0.2, nl));
  }
  float rim = pow(1.0 - clamp(dot(wn, normalize(cameraPosition - vW)), 0.0, 1.0), 3.0);
  c += uAmbSky * (rim * 0.16);
  c = mix(c, vec3(1.0, 0.2, 0.2), uBad * 0.55);
  c += uGlow * 0.28;
  c = mix(c, uFogColor, smoothstep(uFog.x, uFog.y, vDist)); // distant background models melt into the mist
  c = mix(c, vec3(1.0, 0.98, 0.92), dissolveEdge * 0.85);
  return vec4(c, a);
}
`;

export const frag = (body) => prelude + body;
/** How many lines come before the code of a shader (what is shown in the shader studio starts after them): the line numbers of an error are corrected with it. */
export const PRELUDE_LINES = (prelude.match(/\n/g) ?? []).length;

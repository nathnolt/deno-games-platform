// Runs on BOTH server and browser. Pure data: ALL the SHADERS of the game. _definitions.js re-exports them.
//
// Two kinds of entries. BASE shaders hold GLSL (you write them by hand in this file):
//   name: { type?: 'opaque' | 'transparent' | 'refract' | 'water', code: `...GLSL...` }
// PARAMETERISED shaders are made in the Shaders menu of the debug menu: a base shader with its settings, in a category:
//   name: { base: 'woodBaked', category: 'Wood', params: { uRings: 4.5, uWoodLight: '#d2aa79' } }
// Materials, bowls, models, backgrounds and the water pick either kind by name (the shader chooser shows them all, in their categories).
//
// `code` is what comes after the common part of every shader (the varyings, uniforms, noise functions, lighting and finish(): see shaders.js);
// it has to define main() and end by setting gl_FragColor, usually with finish(colour, 1.0).
// type: opaque (default) = a normal solid surface, transparent = drawn after the solid things without depth writes,
//       refract = transparent AND it bends the picture behind it (needs the REFRACT_GLSL part: copy a glass shader to start),
//       water = the water of a bowl (picked in the background editor): a different common part (WATER_PRELUDE in shaders.js).
// A uniform with a default in a comment, like  uniform float uGlitter; // 1.0 [0, 3]  or  uniform vec3 uC; // color 1 0.9 0.8,  becomes a setting in the Shaders menu.
//
// With `DEBUG = true` the Shaders menu writes this file for you when you press "Save shader" and confirm it (comments are not kept).
// That needs write permission:
//   deno.json:  --allow-write=games/balance/_levels.js,games/balance/_shapes.js,games/balance/_shaders.js     (on the "start" and "dev" tasks)

export const shaderCode = {
  wood: {
    code: `
// the grain fades to its average where it gets finer than a pixel (aaFade), so it does not shimmer or turn to stripes at steep camera angles
void main() {
  vec2 p = vP + uSeed * 17.0;
  vec2 fw = fwidth(p);
  float fp = max(fw.x, fw.y);
  float aaR = aaFade(fp * 2.6), aaF = aaFade(fp * 6.0);
  float warp = fbm(p * vec2(0.5, 1.6));
  float rings = sin((p.y * 3.2 + warp * 5.0) * 3.14159) * aaR;
  float fib = mix(0.5, fbm(p * 6.0), aaF);
  vec3 c = mix(vec3(0.64, 0.42, 0.21), vec3(0.45, 0.27, 0.12), 0.5 + 0.3 * rings);
  c *= 0.9 + 0.2 * fib;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(0.2 * rings + 0.2 * (fib - 0.5), 0.045); gHasN = 1.0; } // the bump IS the grain: the same rings that colour the wood
  gBlow = 0.4;
  gShine = 0.3;
  gRough = roughMap(vec3(p * 2.0, 1.0), 0.55, 0.3 * aaR);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  woodBaked: {
    code: `
// Wood, baked and seamlessly tiling, with NO knots. Curviness is adjustable:
//   uCurl   = how much the grain flows and wanders (0 = ruler-straight, like quarter-sawn wood)
//   uArch   = flat-sawn "cathedral" arches: nested peaks along the board
//   uCurls  = how many waves fit along one tile
// uSize makes the whole grain bigger or smaller (no re-baking needed); uRings sets how many rings fit in a tile.
uniform vec3 uWoodLight;   // color 0.80 0.62 0.40
uniform vec3 uWoodDark;    // color 0.42 0.25 0.12
uniform float uRings;      // 10.0 [2, 40]
uniform float uCurl;       // 0.7 [0, 1.5]
uniform float uArch;       // 0.5 [0, 1]
uniform float uShine;      // 1.2 [0, 3]
uniform float uCurls;      // 2.0 [1, 6]
uniform float uSize;       // 1.0 [0.3, 6]
uniform float uBump;       // 0.07 [0, 0.3]
uniform vec2 uTiles;       // 1.0 1.0 [1, 8]

const vec2 TILE = vec2(2.0, 1.0);     // one tile covers 2 units along the board and 1 unit across

// ring coordinate: ring lines along the board, bent by (1) a slow flowing wobble and (2) nested arches.
// Everything here repeats with the tile, and r grows by exactly 1 from the bottom of the tile to the top.
float trunk(vec2 q) {
  float w = floor(uCurls + 0.5);                          // waves per tile along the board (a whole number so it tiles)
  vec2 p = vec2(q.x * w * 0.5, q.y * 2.0);
  float r = q.y;
  r += uCurl * 0.3 * fbmTile(p, vec2(w, 2.0));            // slow flowing wobble
  r += uCurl * 0.04 * noiseTile(vec2(p.x * 3.0, p.y * 4.0), vec2(w * 3.0, 8.0));   // smaller ripples
  // arches: every ring is the same peak shape shifted, so the peaks nest like a cathedral window
  float a = 0.5 + 0.5 * cos(6.28318 * (p.x + 0.35 * noiseTile(p, vec2(w, 2.0))));
  r -= uArch * 0.3 * a * a * (0.8 + 0.2 * sin(6.28318 * q.y));
  r += 0.012 * noiseTile(vec2(q.x * 3.0, q.y * 14.0), vec2(6.0, 14.0));
  return r;
}

// ---------------------------------------------------------------- runs ONCE
// bake 2048
vec4 bake(vec2 tuv) {
  vec2 uv = tuv * TILE;
  float rings = floor(uRings + 0.5);                    // a whole number of rings per tile, so they line up at the seam
  float r = trunk(uv);

  // growth rings: slow darkening, then a sharp edge; every ring has its own tone
  float x = r * rings;
  float tone = pow(fract(x), 4.0);
  float ringTone = hash11(mod(floor(x), rings)) - 0.5;

  // fibres and pores along the grain (they follow the rings, and tile)
  float fibre = 0.65 * noiseTile(vec2(uv.x * 2.0, r * 110.0), vec2(4.0, 110.0)) + 0.35 * noiseTile(vec2(uv.x * 7.0, r * 240.0), vec2(14.0, 240.0));
  float pore = smoothstep(0.86, 0.97, noiseTile(vec2(uv.x * 45.0, r * 150.0), vec2(90.0, 150.0)));

  float t = clamp(tone * 0.75 + ringTone * 0.25 + (0.5 - fibre) * 0.32, 0.0, 1.0);
  vec3 col = mix(uWoodLight, uWoodDark, t);
  col *= 1.0 - 0.28 * pore;

  float h = tone * 0.18 + fibre * 0.1 - pore * 0.08;      // height for the bump map
  return vec4(col, h);
}

// ---------------------------------------------------------------- every frame
void main() {
  vec4 b = texture(uBake, vUv * uTiles / uSize + uSeed * vec2(0.37, 0.61)); // (a seed: every block has its own piece of the board)       // colour (rgb) and height (a); repeats past 0..1
  gNormal = bumpFromHeight(b.a, uBump);
  gHasN = 1.0;

  gShine = uShine;
  gRough = 0.3;
  gBlow = 0.1;
  gl_FragColor = finish(b.rgb, 1.0);
}
`,
  },
  bowlwood: {
    code: `
void main() {
  vec3 q = vP3;
  float warp = fbm(q.xz * 0.3 + vec2(q.y * 0.25, 3.0));
  float rings = sin((q.y * 1.7 + warp * 4.0) * 3.14159) * aaFade(fwidth(q.y * 1.7 + warp * 4.0) * 0.5);
  float fib = fbm(vec2(q.x + q.z, q.y * 3.0) * 1.5);
  vec3 c = mix(vec3(0.50, 0.30, 0.14), vec3(0.34, 0.19, 0.08), 0.5 + 0.4 * rings);
  c *= 0.88 + 0.24 * fib;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(0.5 * rings + 0.5 * fib, 0.045); gHasN = 1.0; }
  gBlow = 0.35;
  gShine = 0.4;
  gRough = roughMap(q * 0.8, 0.45, 0.3);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  floorwood: {
    code: `
// Wood planks as a 3D solid: the grain is carved through the whole object, so it never stretches on
// curved or sloped surfaces. Planks are stacked along the Y axis, the grain runs along X.
uniform vec3  uLight;     // color 0.60 0.40 0.20
uniform vec3  uDark;      // color 0.44 0.27 0.12
uniform float uSize;      // 0.5 [0.2, 5]     overall scale (bigger = larger planks and grain)
uniform float uPlank;     // 0.58 [0.1, 2]     plank width
uniform float uVariant;   // 0.0 [0, 10]      another arrangement of the grain (was uSeed: that name is the block's own seed)
uniform float uGrain;     // 0.9 [0, 1.5]     dark grain lines
uniform float uWobble;    // 5.8 [0, 8]      how much the grain wanders
uniform float uSeam;      // 0.2 [0, 1]       gap between planks
uniform float uBump;      // 0.1 [0, 0.2]
uniform float uShine;     // 0.8 [0, 3]

void main() {
  vec3 p = vPos / uSize + uVariant * 9.0;
  float u = p.y / uPlank;
  float plank = floor(u);
  p.x += hash11(plank) * 40.0;                              // each plank gets different grain

  float lines = (p.y + p.z) * 4.0 + fbm3T(p * vec3(0.5, 2.0, 2.0)) * uWobble;
  float grain = sin(lines * 3.14159) * uGrain;
  float fibre = fbm3T(p * vec3(1.0, 6.0, 6.0));

  vec3 c = mix(uLight, uDark, hash11(plank + 7.0));         // each plank gets a different colour
  c *= 0.85 + 0.2 * fibre - 0.15 * grain;

  float edge = min(fract(u), 1.0 - fract(u));
  float seam = smoothstep(0.03 + fwidth(u), 0.0, edge);
  c *= 1.0 - seam * uSeam;

  gNormal = bumpFromHeight(0.5 * grain + 0.5 * fibre - seam, uBump);
  gHasN = 1.0;
  gShine = uShine;
  gRough = 0.4;
  gl_FragColor = finish(c, 1.0);
}`,
  },
  mahogany: {
    code: `
// Mahogany: dark red-brown wood, 3D (the grain is carved through the whole object). The defaults are the old look.
uniform vec3 uBase;        // color 0.36 0.12 0.07   the main wood colour
uniform vec3 uDark;        // color 0.20 0.06 0.04   the dark lines of the grain
uniform vec3 uStreakColor; // color 0.50 0.19 0.10   the lighter streaks
uniform float uSize;       // 1.0 [0.2, 5]     overall scale (bigger = larger grain)
uniform float uGrainScale; // 2.6 [0.5, 8]     how many grain lines (up the object)
uniform float uGrainAmount; // 0.35 [0, 0.5]   how dark the grain lines are
uniform float uWarp;       // 7.0 [0, 15]      how much the grain wanders
uniform float uStreaks;    // 0.6 [0, 1]       the lighter streaks
uniform float uFibre;      // 0.18 [0, 0.6]    fine fibres
uniform float uBump;       // 0.041 [0, 0.2]   how deep the grain feels
uniform float uShine;      // 0.55 [0, 2]
uniform float uRough;      // 0.35 [0, 1]      reflections: low = glossy, high = dull

void main() {
  vec3 q = vP3 / uSize;
  float warp = fbm(vec2(q.x * 0.15 + q.z * 0.1, q.y * 0.9));
  float lines = q.y * uGrainScale + q.z * 1.3 + warp * uWarp;
  float grain = sin(lines * 3.14159) * aaFade(fwidth(lines) * 0.5);
  float streak = fbm(vec2(q.x * 0.5 + q.z * 0.5, q.y * 6.0));
  float fib = fbm(vec2(q.x + q.z, q.y * 14.0));
  vec3 c = mix(uBase, uDark, 0.5 + uGrainAmount * grain);
  c = mix(c, uStreakColor, smoothstep(0.55, 0.9, streak) * uStreaks);
  c *= 0.9 + uFibre * fib;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(0.5 * grain + 0.5 * fib, uBump); gHasN = 1.0; }
  gBlow = 0.3;
  gShine = uShine;
  gRough = roughMap(q * 0.6, uRough, 0.3);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  blackstone: {
    code: `
void main() {
  vec3 q = vP3 * 2.0;
  float n = fbm(q.xy + q.z * 0.7);
  vec3 c = mix(vec3(0.05, 0.05, 0.06), vec3(0.17, 0.17, 0.19), n);
  c += step(0.965, hash(floor(q.xy * 9.0 + q.z * 5.0))) * 0.25;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(n, 0.090); gHasN = 1.0; }
  gBlow = 0.15;
  gShine = 0.6;
  gRough = roughMap(q * 0.5, 0.3, 0.35);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  plaster: {
    code: `
void main() {
  vec3 q = vP3;
  vec3 c = vec3(0.80, 0.72, 0.60) * (0.95 + 0.07 * fbm(q.xy * 0.6 + q.z));
  c *= 0.97 + 0.03 * hash(floor(q.xy * 6.0));
  gl_FragColor = finish(c, 1.0);
}`,
  },
  glass: {
    type: 'refract',
    code: `
uniform sampler2D uRefr;
uniform float uRefrOn;
uniform vec2 uRefrRes;
// rgb = what the glass shows: the picture behind it, bent (a little more at the edges and by waves in the glass), tinted, with a bit of the glass's own colour (keep).
vec4 glassOut(vec3 own, vec2 p, float keep, vec2 piece) { // piece: extra bend for this part of the glass (a shard of cracked glass)
  if (uRefrOn < 0.5) return vec4(own, 0.2 + keep * 0.6); // no picture to look through: a pale pane
  vec2 warp = vec2(fbm(p * 0.9), fbm(p * 0.9 + 4.3)) - 0.5;
  vec2 off = warp * 0.05 + normalize(vN).xy * 0.035 + piece;
  vec2 uv = gl_FragCoord.xy / uRefrRes;
  vec3 bg = vec3(
    texture2D(uRefr, clamp(uv + off * 0.9, 0.002, 0.998)).r, // (the three colours bend a tiny bit differently)
    texture2D(uRefr, clamp(uv + off, 0.002, 0.998)).g,
    texture2D(uRefr, clamp(uv + off * 1.1, 0.002, 0.998)).b);
  bg *= vec3(0.9, 0.97, 1.0);
  return vec4(mix(bg, own, clamp(keep, 0.0, 1.0)), 1.0);
}

void main() {
  vec2 p = vP + uSeed * 5.0;
  vec3 c = mix(vec3(0.55, 0.80, 0.93), vec3(0.82, 0.95, 1.0), 0.5 + 0.5 * sin(p.x * 0.7 + p.y * 0.5));
  float streak = smoothstep(0.0, 0.35, sin((p.x - p.y) * 1.2 + 1.0));
  c += streak * 0.16;
  vec4 f = finish(c, 1.0);
  float rim = pow(1.0 - abs(normalize(vN).z), 2.0); // the bevelled edges catch more light and are less clear
  gl_FragColor = glassOut(f.rgb, p, 0.1 + 0.4 * rim + streak * 0.06, vec2(0.0));
}`,
  },
  crackedGlass: {
    type: 'refract',
    code: `
uniform sampler2D uRefr;
uniform float uRefrOn;
uniform vec2 uRefrRes;
// rgb = what the glass shows: the picture behind it, bent (a little more at the edges and by waves in the glass), tinted, with a bit of the glass's own colour (keep).
vec4 glassOut(vec3 own, vec2 p, float keep, vec2 piece) { // piece: extra bend for this part of the glass (a shard of cracked glass)
  if (uRefrOn < 0.5) return vec4(own, 0.2 + keep * 0.6); // no picture to look through: a pale pane
  vec2 warp = vec2(fbm(p * 0.9), fbm(p * 0.9 + 4.3)) - 0.5;
  vec2 off = warp * 0.05 + normalize(vN).xy * 0.035 + piece;
  vec2 uv = gl_FragCoord.xy / uRefrRes;
  vec3 bg = vec3(
    texture2D(uRefr, clamp(uv + off * 0.9, 0.002, 0.998)).r, // (the three colours bend a tiny bit differently)
    texture2D(uRefr, clamp(uv + off, 0.002, 0.998)).g,
    texture2D(uRefr, clamp(uv + off * 1.1, 0.002, 0.998)).b);
  bg *= vec3(0.9, 0.97, 1.0);
  return vec4(mix(bg, own, clamp(keep, 0.0, 1.0)), 1.0);
}

vec3 cells(vec2 p, float per) { // nearest and second nearest point of a jittered grid (sideways it repeats after per cells), and a random number for the nearest cell
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 k = vec2(mod(i.x + g.x + per, per), i.y + g.y);
      vec2 o = vec2(hash(k), hash(k + 17.3));
      float d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; id = hash(k + 31.7); } else if (d < d2) { d2 = d; }
    }
  }
  return vec3(d1, d2, id);
}
void main() {
  vec2 p = vP + uSeed * 13.0;
  vec2 hit = (vec2(hash(vec2(uSeed, 1.0)), hash(vec2(uSeed, 2.0))) - 0.5) * 2.4; // where it was hit
  vec2 v = vP - hit;
  vec2 w = v + 0.35 * vec2(fbm(v * 1.1 + uSeed), fbm(v * 1.1 + 6.0 + uSeed)); // crooked cracks
  float r = length(w) + 0.001;
  float ang = atan(w.y, w.x) * 14.0 / 6.2831853; // 14 cracks run out from the hit
  vec3 big = cells(vec2(ang, r * 0.55), 14.0);        // shards: narrow at the hit, longer further out
  vec3 fine = cells(vec2(ang * 2.0, r * 1.1 + 3.0), 28.0); // smaller cracks inside the shards
  float edge = big.y - big.x;
  float crack = 1.0 - smoothstep(0.0, 0.05, edge); // thin lines
  float hair = (1.0 - smoothstep(0.0, 0.03, fine.y - fine.x)) * step(0.45, hash(vec2(fine.z * 7.0, big.z))); // some of the small ones, not all
  if (big.z > 0.94 && r > 2.8 && edge > 0.06) discard; // a missing shard, only away from the hit
  vec2 q = vP + uSeed * 5.0;
  vec3 c = mix(vec3(0.55, 0.80, 0.93), vec3(0.82, 0.95, 1.0), 0.5 + 0.5 * sin(q.x * 0.7 + q.y * 0.5));
  c *= 0.94 + 0.12 * big.z;                                   // every shard is a little lighter or darker
  c += smoothstep(0.16, 0.06, edge) * (1.0 - crack) * 0.12;    // the rim of a shard catches light, next to the crack
  vec4 f = finish(c, 1.0);
  float line = clamp(max(crack, hair * 0.7), 0.0, 1.0);
  vec3 own = mix(f.rgb, vec3(0.02, 0.03, 0.05), line);         // the cracks are black
  vec2 tilt = (vec2(hash(vec2(big.z, 3.7)), hash(vec2(big.z, 8.1))) - 0.5) * 0.09; // each shard bends the light its own way
  float rim = pow(1.0 - abs(normalize(vN).z), 2.0);
  gl_FragColor = glassOut(own, p * 1.7, max(0.1 + 0.4 * rim, line * 0.95), tilt);
}`,
  },
  waterBlock: {
    type: 'refract',
    code: `
uniform sampler2D uRefr;
uniform float uRefrOn;
uniform vec2 uRefrRes;
// rgb = what the glass shows: the picture behind it, bent (a little more at the edges and by waves in the glass), tinted, with a bit of the glass's own colour (keep).
vec4 glassOut(vec3 own, vec2 p, float keep, vec2 piece) { // piece: extra bend for this part of the glass (a shard of cracked glass)
  if (uRefrOn < 0.5) return vec4(own, 0.2 + keep * 0.6); // no picture to look through: a pale pane
  vec2 warp = vec2(fbm(p * 0.9), fbm(p * 0.9 + 4.3)) - 0.5;
  vec2 off = warp * 0.05 + normalize(vN).xy * 0.035 + piece;
  vec2 uv = gl_FragCoord.xy / uRefrRes;
  vec3 bg = vec3(
    texture2D(uRefr, clamp(uv + off * 0.9, 0.002, 0.998)).r, // (the three colours bend a tiny bit differently)
    texture2D(uRefr, clamp(uv + off, 0.002, 0.998)).g,
    texture2D(uRefr, clamp(uv + off * 1.1, 0.002, 0.998)).b);
  bg *= vec3(0.9, 0.97, 1.0);
  return vec4(mix(bg, own, clamp(keep, 0.0, 1.0)), 1.0);
}

uniform vec3 uWaterColor;
uniform float uWaterOpacity;
vec2 grad2(vec2 i) { float a = hash(i) * 6.2831853; return vec2(cos(a), sin(a)); }
float perlin(vec2 p) { // gradient (Perlin) noise, about -0.7 .. 0.7
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(dot(grad2(i), f), dot(grad2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(grad2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(grad2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
float wh(vec2 p, float t) { // the wave height of the water of the bowl (waveH in client.js) plus finer Perlin ripples, on the face of the block
  float h = 0.0;
  h += 0.10 * sin(dot(p, vec2(0.95, 0.31)) * 0.55 + t * 1.0);
  h += 0.05 * sin(dot(p, vec2(-0.37, 0.93)) * 0.90 + t * 1.3);
  h += 0.02 * sin(dot(p, vec2(0.71, 0.71)) * 1.70 + t * 1.9);
  h += (noise(p * 0.35 + vec2(t * 0.15, -t * 0.10)) - 0.5) * 0.20;
  h += (noise(p * 0.95 - vec2(t * 0.25, t * 0.20)) - 0.5) * 0.06;
  h += perlin(p * 0.65 + vec2(t * 0.22, t * 0.17)) * 0.34; // ripples (twice as large)
  h += perlin(p * 1.55 - vec2(t * 0.38, t * 0.12)) * 0.16; // finer ones (twice as large)
  return h;
}
void main() {
  vec2 p = vP + uSeed * 7.0;
  float t = uTime;
  float h0 = wh(p, t);
  vec2 slope = vec2(wh(p + vec2(0.1, 0.0), t) - h0, wh(p + vec2(0.0, 0.1), t) - h0) / 0.1;
  float front = smoothstep(0.6, 0.95, abs(normalize(vWN).z)); // the big flat faces (the front of the block): the ripples are strongest there
  vec3 N = normalize(normalize(vWN) + vec3(-slope, 0.0) * (2.0 + 2.5 * front)); // the waves tilt the surface
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 3.0);
  vec3 col = uWaterColor * ((uAmbSky * 0.7 + uLightCol * 0.35) * 1.28); // the colour of the water follows the light of the day
  col *= 0.8 + 0.4 * (perlin(p * 0.225 + vec2(t * 0.08, -t * 0.05)) + 0.5);  // deeper and shallower patches drifting through the water
  float rip = perlin(p * 1.1 + vec2(t * 0.3, -t * 0.2));
  col *= 1.0 + front * (0.5 * rip + 0.28 * smoothstep(0.35, 0.7, abs(perlin(p * 0.8 - vec2(t * 0.18, t * 0.25))) )); // visible light and dark ripples, with bright lines
  // reflection: the sky (and the ground) as the tilted surface mirrors it, stronger at a low angle
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uAmbGround, uAmbSky, smoothstep(-0.2, 0.7, R.y)) * 1.15;
  float refl = clamp(0.12 + 0.75 * fres, 0.0, 0.85);
  col = mix(col, sky, refl * 0.55);
  float glint = pow(max(dot(N, normalize(uLightDir + V)), 0.0), 140.0);   // sun (or moon) glitter on the ripples
  col += uLightCol * (glint * 0.9);
  col *= 0.94 + 0.12 * N.x;
  float keep = clamp(uWaterOpacity + fres * 0.12 + refl * 0.2 + glint * 0.6, 0.0, 1.0);
  gl_FragColor = glassOut(col, p, keep, slope * (0.03 + 0.03 * front));
}`,
  },
  outline: {
    type: 'transparent',
    code: `
void main() {
  vec2 p = vP + uSeed * 17.0;
  float across = smoothstep(0.0, 0.3, vP.y) * smoothstep(1.0, 0.7, vP.y); // soft edges on both sides of the line
  float rough = 0.55 + 0.45 * fbm(vec2(p.x * 2.2, vP.y * 2.5));             // the chalk is thicker and thinner along the line
  float dust = step(0.82, hash(floor(vec2(p.x * 9.0, vP.y * 4.0)))) * 0.25; // grains
  float a = clamp(across * (rough - dust) * 1.15, 0.0, 1.0) * 0.92 * uReveal; // (uReveal: the line fades in and out)
  gl_FragColor = vec4(vec3(0.97, 0.97, 0.94), a);
}`,
  },
  stone1: {
    code: `
// Rock (fast): one texture noise gives the bump and the colour. Lit by the game's own sun / moon through finish(). The SETTINGS are per material
// (debug menu, Materials tab).
uniform float uBump;  // 0.12 [0, 1]
uniform float uScale; // 6.0 [1, 20]
uniform vec3 uColor;  // color 0.5 0.5 0.5
uniform float uContrast; // 0.7 [0, 3]
uniform float uGlare; // 0.2 [0, 1]
void main() {
  float h = fbm3T(vPos * uScale + uSeed * 11.0);
  gNormal = bumpFromHeight(h, uBump);
  gHasN = 1.0;
  gShine = 0.5;
  gRough = 0.85;
  gBlow = uGlare;                      // how much the lit side is brightened and whitened by the sun (less = more visible grain)
  vec3 c = uColor * (0.95 + uContrast * (h - 0.5));  // high parts a little lighter, low parts darker
  gl_FragColor = finish(c, 1.0);
}`,
  },
  stone2: {
    code: `
float heightAt(vec3 q) { return 0.6 * perlin(q * 1.5) + 0.3 * perlin(q * 4.6) + 0.06 * perlin(q * 9.0); } // lumps, bumps, grain
void main() {
  vec3 q = vW * 0.9 + uSeed * 11.0;
  float h0 = heightAt(q);
  if (uQuality > 1.5) { gNormal = bumpFromHeight(h0, 0.135); gHasN = 1.0; }

  // colour: blue-grey slate, blotchy, with paler and darker grains
  float blot = pfbm(q * 0.7);
  vec3 c = mix(vec3(0.20, 0.23, 0.30), vec3(0.42, 0.44, 0.50), smoothstep(0.25, 0.75, blot));
  c *= 0.86 + 0.28 * (perlin(q * 18.0) * 0.5 + 0.5);                                            // grain
  c = mix(c, vec3(0.64, 0.66, 0.70), smoothstep(0.5, 0.62, perlin(q * 15.0)) * 0.5);           // pale mineral specks
  c *= 1.0 - 0.4 * smoothstep(0.1, -0.35, h0);                                                   // the low parts are darker

  // shine: the roughness varies with its own noise (non-uniform reflection); the highlight itself is added in finish()
  gRough = roughMap(q * 0.9 + 21.0, 0.62, 0.45);
  gShine = 0.55;
  gBlow = 0.35;
  gl_FragColor = finish(c, 1.0);
}`,
  },
  float: {
    code: `
void main() {
  vec2 p = vP;
  float s = step(0.5, fract(p.x * 0.42 + 0.1));
  vec3 c = mix(vec3(0.95, 0.42, 0.18), vec3(0.97, 0.94, 0.88), s);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  wood2: {
    code: `
void main() {
  vec3 q = vP3 + uSeed * 9.0;
  float warp = fbm(q.xz * 0.3 + vec2(q.y * 0.25, 7.0));
  float rings = sin((q.y * 2.2 + warp * 3.5) * 3.14159) * aaFade(fwidth(q.y * 2.2 + warp * 3.5) * 0.5);
  float fib = fbm(vec2(q.x + q.z, q.y * 4.0) * 1.2);
  vec3 c = mix(vec3(0.84, 0.68, 0.46), vec3(0.72, 0.54, 0.33), 0.5 + 0.35 * rings);
  c *= 0.92 + 0.16 * fib;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(0.5 * rings + 0.5 * fib, 0.045); gHasN = 1.0; }
  gBlow = 0.4;
  gShine = 0.3;
  gRough = roughMap(q * 0.7, 0.5, 0.3);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  ceramic: {
    code: `
void main() {
  vec3 q = vP3;
  float a = atan(q.z, q.x);
  float rim = smoothstep(0.06, 0.0, abs(q.y - 0.0) - 0.5);
  float wave = smoothstep(0.08, 0.0, abs(q.y + 2.6 + 0.5 * sin(a * 7.0)) - 0.18);
  vec3 c = mix(vec3(0.95, 0.95, 0.92), vec3(0.20, 0.36, 0.60), clamp(rim + wave, 0.0, 1.0) * 0.92);
  c *= 0.96 + 0.06 * noise(q.xz * 5.0 + q.y * 2.0);
  gBlow = 0.25;
  gShine = 0.9;
  gRough = roughMap(q * 1.2, 0.14, 0.12);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  ceramicGlaze: {
    code: `
// Teal-green stoneware glaze: vertical streaks where the glaze ran down, a fine speckle, rust brown
// where it thins out near the top, and a glossy mirror coat on top. 3D, so it fits any shape.
// The up direction of the glaze is the object's Y axis. The reflection comes from a pre-drawn map
// (bake), so it costs one texture read; edit uTop / uHorizon / uBottom to match your own background.
uniform vec3  uTeal; // color 0.07 0.46 0.42   main glaze colour
uniform vec3  uDeep; // color 0.03 0.22 0.26   darker streaks
uniform vec3  uPale; // color 0.4 0.72 0.6   lighter patches
uniform vec3  uRust; // color 0.388 0.851 0.698   tint where the glaze is thin (near the top)
uniform float uScale; // 2.927 [0.3, 4]   size of the pattern
uniform float uStreak; // 0.55 [0, 1]   how streaky (1 = long drips, 0 = cloudy)
uniform float uRustAmt; // 0.46 [0, 1]   brown near the top
uniform float uReflect; // 0.598 [0, 1]   mirror reflection over the whole surface
uniform float uGloss; // 0.863 [0, 1.5]   brightness of the highlights
uniform float uVariant; // 0.0 [0, 10]   a different pattern
uniform vec3  uTop; // color 0 0.8 1   reflected colour straight up
uniform vec3  uHorizon; // color 0.984 0.855 0.576   reflected colour at eye level
uniform vec3  uBottom; // color 0.157 0.051 0.349   reflected colour straight down
uniform float uGrain; // 0.481 [0, 0.5]   grain in the reflected scene
uniform float uWindow; // 0.802 [0, 3]   brightness of the soft light panel in the reflection

// REFLECTION MAP, drawn ONCE (the studio bakes this into uBake whenever you change code or a slider).
// It is a "sphere of surroundings" unrolled into a picture: x = direction around, y = up/down.
// bake 256
vec3 dirFromMap(vec2 uv) {
  float lon = (uv.x - 0.5) * 6.2831853, lat = (uv.y - 0.5) * 3.1415927;
  return vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
}
vec4 bake(vec2 uv) {
  vec3 r = dirFromMap(uv);
  vec3 c = r.y > 0.0 ? mix(uHorizon, uTop, pow(r.y, 0.6)) : mix(uHorizon, uBottom, pow(-r.y, 0.5));
  c += vec3(1.0, 0.98, 0.94) * smoothstep(0.80, 0.90, dot(r, normalize(vec3(0.5, 0.55, 0.65)))) * 1.8 * uWindow;  // soft light panel
  c += vec3(1.0, 0.7, 0.4) * smoothstep(0.93, 0.96, dot(r, normalize(vec3(-0.7, 0.3, 0.4)))) * 1.5 * uWindow;      // warm lamp
  c *= 1.0 + (noise3T(r * 60.0) - 0.5) * uGrain * 2.0;                                                            // grain
  return vec4(c, 1.0);
}
// look the surroundings up for a direction
vec3 room(vec3 r) {
  vec2 uv = vec2(atan(r.z, r.x) / 6.2831853 + 0.5, asin(clamp(r.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  return textureLod(uBake, uv, 0.0).rgb;
}

// three layers of noise are plenty for the fine streaks (fbm3T uses five)
float fbm3Fine(vec3 p) { return (0.5 * noise3T(p) + 0.25 * noise3T(p * 2.03 + 17.1) + 0.125 * noise3T(p * 4.1 + 9.2)) / 0.875; }

void main() {
  vec3 p = vPos * uScale + uVariant * 7.0;
  vec3 s = mix(vec3(1.0), vec3(5.0, 0.7, 5.0), uStreak);            // squash the noise along Y: streaks run up and down
  float a = fbm3T(p * s);                                            // big streaks
  float b = fbm3Fine(p * s * 3.0 + 11.0);                               // finer streaks
  float t = clamp(a * 0.7 + b * 0.5, 0.0, 1.0);

  vec3 c = mix(uDeep, uTeal, smoothstep(0.2, 0.55, t));
  c = mix(c, uPale, smoothstep(0.55, 0.85, t) * 0.8);
  c *= 0.9 + 0.2 * noise3T(p * 14.0);                                  // fine speckle in the glaze

  float top = smoothstep(0.45, 1.0, vPos.y * 0.7 + 0.5 + (b - 0.5) * 0.7);
  c = mix(c, uRust, top * top * uRustAmt);                          // brown near the top, broken up by the streaks

  gNormal = bumpFromHeight(a, 0.004);
  gHasN = 1.0;

  vec3 n = gNormal, v = viewDir();
  float k = 1.0 - clamp(dot(n, v), 0.0, 1.0), k2 = k * k;
  float f = 0.05 + 0.95 * k2 * k2;                                  // fresnel: pow(k, 4) by multiplying
  gSpec = room(reflect(-v, n)) * mix(uReflect * 0.35, 1.0, f) * uGloss;
  gShine = 1.8 * uGloss;
  gRough = 0.15;
  gl_FragColor = finish(c, 1.0);
}
`,
  },
  bark: {
    code: `
void main() {
  vec3 q = vP3;
  float a = atan(q.z, q.x);
  float streak = fbm(vec2(a * 3.0, q.y * 0.9));
  vec3 c = mix(vec3(0.24, 0.17, 0.12), vec3(0.44, 0.32, 0.21), streak);
  c *= 0.82 + 0.3 * noise(vec2(a * 9.0, q.y * 3.0));
  gl_FragColor = finish(c, 1.0);
}`,
  },
  leaves: {
    code: `
void main() {
  vec3 q = vP3;
  float n = fbm(q.xy * 1.2 + q.zy * 0.8);
  vec3 c = mix(vec3(0.20, 0.42, 0.20), vec3(0.47, 0.66, 0.28), n);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  blossom: {
    code: `
void main() {
  vec3 q = vP3;
  float n = fbm(q.xy * 1.4 + q.zy * 0.9);
  vec3 c = mix(vec3(0.93, 0.68, 0.76), vec3(1.0, 0.90, 0.92), n);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  bamboo: {
    code: `
void main() {
  vec3 q = vP3;
  float knot = smoothstep(0.05, 0.0, abs(fract(q.y) - 0.92) - 0.06);
  vec3 c = mix(vec3(0.40, 0.58, 0.26), vec3(0.56, 0.70, 0.34), noise(vec2(q.y * 2.0, q.x * 9.0 + q.z * 9.0)));
  c = mix(c, vec3(0.28, 0.40, 0.18), knot * 0.8);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  paper: {
    code: `
void main() {
  vec3 q = vP3;
  vec3 c = vec3(1.18, 0.98, 0.66) * (0.9 + 0.1 * noise(q.xy * 8.0));
  gl_FragColor = finish(c, 1.0);
}`,
  },
  mountain: {
    code: `
void main() {
  vec3 q = vP3;
  float snow = smoothstep(27.0 + 3.0 * fbm(q.xz * 0.15), 36.0, q.y);
  vec3 c = mix(vec3(0.46, 0.53, 0.60), vec3(0.62, 0.68, 0.72), fbm(q.xz * 0.12 + q.y * 0.05));
  c = mix(c, vec3(0.95, 0.96, 0.97), snow);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  fuel: {
    code: `
// FUEL: a volatile, glowing orange-red liquid that boils and flickers, with warning stripes. It meets the oxidizer (blue-white) and both explode.
void main() {
  vec2 p = vP * 0.7 + uSeed * 13.0;
  float t = uTime * 0.35;
  float n = fbm(p * 1.3 + vec2(t, -t * 0.6));
  float n2 = fbm(p * 2.6 - vec2(t * 0.8, t * 0.3) + n * 1.5);           // the boiling
  float heat = smoothstep(0.2, 0.6, n2) * 0.8 + 0.2 * smoothstep(0.3, 0.9, n); // (a lot of the surface is hot)
  vec3 c = mix(vec3(0.42, 0.06, 0.03), vec3(0.95, 0.2, 0.04), heat);
  c = mix(c, vec3(1.0, 0.62, 0.12), smoothstep(0.55, 0.9, heat));
  float stripe = step(0.5, fract((vP.x + vP.y) * 0.32));                    // diagonal warning stripes (dark / bright)
  c *= 0.72 + 0.28 * stripe;
  float pulse = 0.85 + 0.15 * sin(uTime * 3.2 + n * 6.0);
  gShine = 0.25;
  gRough = 0.45;
  vec4 o = finish(c, 1.0);
  o.rgb += vec3(1.0, 0.4, 0.08) * (0.25 + 0.6 * heat) * pulse;                // it glows
  gl_FragColor = o;
}`,
  },
  oxidizer: {
    code: `
// OXIDIZER: an icy blue-white crystal with electric cracks that flicker. Next to the fuel (orange-red) it is unmistakable: they explode when they touch.
void main() {
  vec2 p = vP * 0.9 + uSeed * 7.0;
  float n = fbm(p * 2.0 + uTime * 0.12);
  float ridges = 1.0 - abs(2.0 * fbm(p * 3.4 + 3.0) - 1.0);              // thin lines where a noise crosses its middle
  float flick = 0.55 + 0.45 * sin(uTime * 7.0 + n * 12.0);
  float arc = smoothstep(0.9, 1.0, ridges) * flick;
  vec3 c = mix(vec3(0.03, 0.16, 0.30), vec3(0.12, 0.58, 0.85), n);
  c = mix(c, vec3(0.8, 0.97, 1.0), smoothstep(0.62, 0.9, n) * 0.5);        // pale, frosty patches
  float stripe = step(0.5, fract((vP.x - vP.y) * 0.32));                   // warning stripes, the other way round than the fuel
  c *= 0.72 + 0.28 * stripe;
  c += vec3(0.5, 0.9, 1.0) * arc;
  float pulse = 0.85 + 0.15 * sin(uTime * 2.6 + n * 5.0);
  gShine = 0.7;
  gRough = 0.25;
  vec4 o = finish(c, 1.0);
  o.rgb += vec3(0.15, 0.6, 1.0) * (0.2 + 0.7 * arc) * pulse;                  // it glows
  gl_FragColor = o;
}`,
  },
  noBuildZone: {
    type: 'transparent',
    code: `
// NO-BUILD ZONE (the inside): a mostly see-through red, with a faint slow hatching so it does not look like a stain. The red line around it is 'noBuildLine'.
void main() {
  float hatch = 0.5 + 0.5 * sin((vP.x + vP.y) * 1.3 - uTime * 0.9);
  gl_FragColor = vec4(1.0, 0.1, 0.08, 0.13 + 0.05 * hatch);
}`,
  },
  noBuildLine: {
    type: 'transparent',
    code: `
// NO-BUILD ZONE (the outline): a thin, solid, bright red line (a hair of softness at its two edges so it does not look jagged), pulsing a little.
void main() {
  float across = smoothstep(0.0, 0.18, vP.y) * smoothstep(1.0, 0.82, vP.y);
  float pulse = 0.92 + 0.08 * sin(uTime * 2.5);
  gl_FragColor = vec4(1.0, 0.1, 0.08, across * pulse);
}`,
  },
  ocean: {
    type: 'water',
    code: `
// Ocean water, optimised: the expensive swirly noise is drawn ONCE by bake() into a picture,
// and every frame only reads that picture (2 texture reads instead of ~10 fbm calls).

uniform vec3 uHighlight;      // color 1.0 0.95 0.8
uniform vec3 uDeepColor;      // color 0.02 0.1 0.3   the water where it is deep (the dark patches)
uniform vec3 uLightColor;     // color 0.1 0.55 0.85   the water where it is light (the bright patches)
uniform vec3 uTint;           // color 0.9 0.95 1.0   tint of the mirrored sky
uniform float uGlitter;       // 1.0 [0, 3]
uniform float uWaves;         // 0.14 [0, 0.4]
uniform float uFlow;          // 1.0 [0, 4]
uniform float uSunOwn;        // 1.0 [0, 1]
uniform float uSunTurn;       // 180.0 [-180, 180]
uniform float uSunHeight;     // 30.0 [-10, 90]
uniform float uReflect;       // 1.0 [0, 2]   how much of the sky and the sun the water mirrors (0 = only its own colour)
uniform float uMirror;        // 1.0 [0, 1]   how much of the SCENERY (rocks, trees, the sky) it mirrors, like the classic water. 1 = the "reflect" of the bowl's water, 0 = none

// The sun of this water: 1 = your own sun (turn 180 = behind the water as seen from the front, height = degrees above the horizon), 0 = the sun / moon of the level
vec3 sunDir() {
  float a = radians(uSunTurn), e = radians(uSunHeight);
  vec3 own = vec3(cos(e) * sin(a), sin(e), cos(e) * cos(a));
  return normalize(mix(uLightDir, own, uSunOwn));
}

// ---------------------------------------------------------------- runs ONCE (not every frame)
// bake 1024
vec4 bake(vec2 uv) {
  vec2 p = uv * 3.0;                                   // 3 noise cells across; the picture tiles every 3
  vec2 q = vec2(fbmTile(p, 3.0), fbmTile(p + vec2(5.2, 1.3), 3.0));
  vec2 r = vec2(fbmTile(p + 4.0 * q + vec2(1.7, 9.2), 3.0), fbmTile(p + 4.0 * q + vec2(8.3, 2.8), 3.0));
  float f = fbmTile(p + 4.0 * r, 3.0);                 // the swirly pattern from the original
  float h = fbmTile(p * 2.0 + 3.0 * r, 6.0);           // wave height: the same flow, finer
  return vec4(f, length(q), h, 1.0);
}

// Sky and sun reflection. The three highlight sizes share one chain of squarings (s^2 ... s^256).
vec3 env(vec3 r) {
  vec3 sky = vec3(0.3, 0.55, 0.95);
  vec3 ground = vec3(0.04, 0.1, 0.22);
  vec3 c = mix(ground, sky, smoothstep(-0.1, 0.25, r.y));
  float s = max(dot(r, sunDir()), 0.0);
  float s2 = s * s;      float s4 = s2 * s2;     float s8 = s4 * s4;
  float s16 = s8 * s8;   float s32 = s16 * s16;  float s64 = s32 * s32;
  float s128 = s64 * s64; float s256 = s128 * s128;
  c += uHighlight * (s256 * 4.0 + s64 * 0.8 + s8 * 0.12) * uGlitter;
  return c;
}

void main() {
  // the two water colours
  vec3 deepBlue = uDeepColor;
  vec3 lightBlue = uLightColor;
  vec3 tint = uTint;

  // two copies of the baked picture drifting in different directions
  float t = uTime * 0.02 * uFlow;
  vec4 a = texture(uBake, vUv + vec2(t, t * 0.6));
  vec4 b = texture(uBake, vUv * 1.37 + vec2(-t * 0.8, t) + 0.5);

  float f = a.r;
  vec3 water = mix(deepBlue, lightBlue, f);
  water = mix(water, deepBlue, clamp(a.g * 0.5, 0.0, 1.0));
  water *= 0.4 + f * 1.2;

  // wave bumps -> reflection direction
  float h = a.b * 0.7 + b.b * 0.5;
  vec3 v = viewDir();
  vec3 n = bumpFromHeight(h, uWaves);
  vec3 r = reflect(-v, n);

  // (1 - n.v)^4 as two squarings
  float k = 1.0 - clamp(dot(n, v), 0.0, 1.0);
  float k2 = k * k;
  float fr = 0.15 + 0.85 * k2 * k2;
  float fres = clamp(fr * uReflect, 0.0, 1.0);
  vec3 col = mix(water, env(r) * tint, fres);
  vec4 sc = surroundings(n);                           // the classic mirror image of the surroundings, on top of the sky
  col = mix(col, sc.rgb, clamp(sc.a * uMirror * (0.3 + 0.7 * fr), 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`,
  },
  oakWood: {
    base: 'woodBaked',
    category: 'Wood',
    params: {
      uRings: 4.47,
      uCurl: 0.465,
      uArch: 0.15,
      uShine: 1.26,
      uCurls: 1,
      uSize: 1.041,
      uBump: 0.1395,
      uWoodLight: '#d2aa79',
      uWoodDark: '#754a29',
    },
  },
  plankFloor: {
    base: 'floorwood',
    category: 'Wood',
    params: {
      uSize: 1.664,
      uPlank: 1.1545,
      uVariant: 4.05,
      uGrain: 0.5625,
      uWobble: 4.88,
      uSeam: 0.1,
      uBump: 0.104,
      uShine: 0.84,
      uLight: '#d6a371',
      uDark: '#714219',
    },
  },
  slateStone: {
    base: 'stone1',
    category: 'Stone',
    params: {
      uBump: 0.255,
      uScale: 3.945,
      uColor: '#6e6e6e',
    },
  },
  yellowGlaze: {
    base: 'ceramicGlaze',
    category: 'Ceramic',
    params: {
      uScale: 1.299,
      uTeal: '#e8d454',
      uDeep: '#ac8b16',
      uPale: '#db9f1f',
      uRust: '#6d6e21',
      uVariant: 7.1,
      uGrain: 0.5,
      uWindow: 1.155,
      uTop: '#03a1c9',
      uHorizon: '#dfc690',
      uBottom: '#372b10',
      uStreak: 0.15,
      uRustAmt: 0.57,
      uReflect: 0.46,
      uGloss: 0.48,
    },
  },
  seaBlock: {
    base: 'waterBlock',
    category: 'Water',
    params: {
      uBlockOpacity: 0.9,
      uGlitter: 2.52,
      uWaves: 0.378,
      uFlow: 2.02,
      uSunOwn: 0.615,
      uSunTurn: -3.5,
      uSunHeight: -10,
    },
  },
  calmOcean: {
    base: 'ocean',
    category: 'Water',
    params: {
      uSunHeight: -0.1,
      uHighlight: '#ffffff',
      uGlitter: 0.165,
      uWaves: 0.19,
      uSunOwn: 0.87,
      uSunTurn: 176.1,
    },
  },
  terracotta: {
    base: 'ceramicGlaze',
    category: 'Wood',
    params: {
      uTeal: '#da3b07',
      uDeep: '#d57d58',
      uPale: '#9e2f00',
      uRust: '#e67133',
      uScale: 1.7615,
      uStreak: 0.51,
      uRustAmt: 0.245,
      uReflect: 0.19,
      uGloss: 0.2175,
      uVariant: 5.2,
      uWindow: 1.365,
      uGrain: 0.32,
      uTop: '#11bde8',
    },
  },
  nightOcean: {
    base: 'ocean',
    category: 'Water',
    params: {
      uSunHeight: -10,
      uHighlight: '#ffffff',
      uGlitter: 0,
      uWaves: 0.198,
      uSunOwn: 0,
      uSunTurn: 1.2,
      uLightColor: '#1b3546',
      uTint: '#ffffff',
      uReflect: 0,
      uMirror: 0.09,
      uDeepColor: '#01091e',
    },
  },
  bowlwood2: {
    base: 'mahogany',
    category: 'Wood',
    params: {
      uBase: '#ec946f',
      uDark: '#371810',
      uStreakColor: '#ffffff',
      uSize: 0.656,
      uGrainScale: 2.9,
      uGrainAmount: 0.09,
      uWarp: 6.9,
      uStreaks: 0.49,
      uFibre: 0.153,
      uBump: 0.036,
      uShine: 0.87,
      uRough: 0.975,
    },
  },
};

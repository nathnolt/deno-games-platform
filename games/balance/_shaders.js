// Runs on BOTH server and browser. Pure data: ALL the SHADERS of the game (edit them in the shader studio of the debug menu). _definitions.js re-exports them.
//
//   export const shaderCode = { name: { type?: 'opaque' | 'transparent' | 'refract', code: `...GLSL...` }, ... }
//
// EVERY shader of the game is here (shaders.js only has the common part that all of them start with). The name is what materials, bowls, models and backgrounds
// pick; a new name is a new shader.
// `code` is what comes after the common part of every shader (the varyings, uniforms, noise functions, lighting and finish(): see shaders.js);
// it has to define main() and end by setting gl_FragColor, usually with finish(colour, 1.0).
// type: opaque (default) = a normal solid surface, transparent = drawn after the solid things without depth writes,
//       refract = transparent AND it bends the picture behind it (needs the REFRACT_GLSL part: copy a glass shader to start).
//
// With `DEBUG = true` the shader studio writes this file for you when you press "Save shader" and confirm it (comments are not kept).
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
void main() {
  vec2 p = vec2(vP3.x, vP3.z + vP3.y) + uSeed * 9.0;
  float plank = floor(p.y / 3.2);
  vec2 q = vec2(p.x * 0.35 + hash(vec2(plank, 3.0)) * 40.0, p.y);
  float warp = fbm(vec2(q.x * 0.5, q.y * 2.5));
  float grain = sin((q.y * 2.0 + warp * 6.0) * 3.14159) * aaFade(fwidth(q.y * 2.0 + warp * 6.0) * 0.5);
  float fib = fbm(q * vec2(1.0, 4.0));
  vec3 base = mix(vec3(0.60, 0.40, 0.20), vec3(0.44, 0.27, 0.12), hash(vec2(plank, 7.0)));
  vec3 c = mix(base, base * 0.8, 0.5 + 0.3 * grain);
  c *= 0.9 + 0.2 * fib;
  float f = fract(p.y / 3.2);
  float sw = 0.03 + fwidth(p.y) / 3.2;                              // the seam stays at least about a pixel wide, and fainter when it is wider (no dotted lines)
  float seam = smoothstep(sw, 0.0, min(f, 1.0 - f)) * (0.03 / sw);
  c *= 1.0 - seam * 0.5;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(0.5 * grain + 0.5 * fib - 1.5 * seam, 0.041); gHasN = 1.0; } // grain and the grooves between the planks
  gBlow = 0.3;
  gShine = 0.3;
  gRough = roughMap(vec3(p * 0.7, 2.0), 0.6, 0.3);
  gl_FragColor = finish(c, 1.0);
}`,
  },
  mahogany: {
    code: `
void main() {
  vec3 q = vP3;
  float warp = fbm(vec2(q.x * 0.15 + q.z * 0.1, q.y * 0.9));
  float grain = sin((q.y * 2.6 + q.z * 1.3 + warp * 7.0) * 3.14159) * aaFade(fwidth(q.y * 2.6 + q.z * 1.3 + warp * 7.0) * 0.5);
  float streak = fbm(vec2(q.x * 0.5 + q.z * 0.5, q.y * 6.0));
  float fib = fbm(vec2(q.x + q.z, q.y * 14.0));
  vec3 c = mix(vec3(0.36, 0.12, 0.07), vec3(0.20, 0.06, 0.04), 0.5 + 0.35 * grain);
  c = mix(c, vec3(0.50, 0.19, 0.10), smoothstep(0.55, 0.9, streak) * 0.6);
  c *= 0.9 + 0.18 * fib;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(0.5 * grain + 0.5 * fib, 0.041); gHasN = 1.0; }
  gBlow = 0.3;
  gShine = 0.55;
  gRough = roughMap(q * 0.6, 0.35, 0.3);
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
// Weathered slate. ONE height drives everything: the bump is its slope and the colour follows its value (high = lighter, low = darker), so the
// grain of the relief and the grain of the colour are the same grain. Fine layers fade out with aaFade() where they get smaller than a pixel.
void main() {
  vec3 q = vW * 1.7 + uSeed * 11.0;
  float fq = max(length(fwidth(q)), 1e-5);                          // how much of the pattern one pixel covers
  float aaA = aaFade(fq * 8.0), aaB = aaFade(fq * 16.0), aaC = aaFade(fq * 30.0);
  float lump = 0.55 * perlin(q * 1.4) + 0.4 * perlin(q * 3.6) * aaA + 0.25 * perlin(q * 8.0) * aaB;      // soft rock surface
  float fine = perlin(q * 16.0) * aaB;                                                                    // fine grain
  float ridge = smoothstep(0.17, 0.0, abs(perlin(q * 1.8 + 5.0 + 0.3 * perlin(q * 4.0)))); // thin wandering lines
  float crev = ridge * smoothstep(-0.1, 0.3, perlin(q * 0.7 + 3.0));                       // crevices: only in some places, fading in and out
  float h0 = lump + 0.35 * fine - 1.3 * crev;
  if (uQuality > 1.5) { gNormal = bumpFromHeight(h0, 0.11); gHasN = 1.0; }

  float blot = pfbm(q * 0.5);
  vec3 c = mix(vec3(0.36, 0.38, 0.44), vec3(0.50, 0.52, 0.57), smoothstep(0.3, 0.7, blot));   // blue-grey slate, gentle patches
  c *= 0.8 + 0.34 * smoothstep(-0.8, 0.9, h0);                                                  // the colour follows the height
  c *= 1.0 + 0.16 * fine;                                                                       // the same fine grain, light and dark
  float speck = smoothstep(0.6, 0.78, perlin(q * 27.0)) * aaC;
  c = mix(c, vec3(0.66, 0.68, 0.72), speck * 0.35);                                             // a few pale mineral grains
  c *= 1.0 - 0.55 * crev;                                                                       // dark crevices
  gRough = roughMap(q * 0.8 + 21.0, 0.65, 0.35 * aaA) + 0.2 * crev;
  gShine = 0.35 * (1.0 - 0.6 * crev);
  gBlow = 0.28;
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
// NO-BUILD ZONE (the inside): a mostly see-through red, with a faint slow hatching so it does not look like a stain. The red chalk line is 'noBuildLine'.
void main() {
  float hatch = 0.5 + 0.5 * sin((vP.x + vP.y) * 1.3 - uTime * 0.9);
  gl_FragColor = vec4(1.0, 0.1, 0.08, 0.13 + 0.05 * hatch);
}`,
  },
  noBuildLine: {
    type: 'transparent',
    code: `
// NO-BUILD ZONE (the outline): the same chalk line as the outline of the blocks that are still to come, but a bright, slightly pulsing red.
void main() {
  vec2 p = vP + uSeed * 17.0;
  float across = smoothstep(0.0, 0.3, vP.y) * smoothstep(1.0, 0.7, vP.y);
  float rough = 0.7 + 0.3 * fbm(vec2(p.x * 2.2, vP.y * 2.5));
  float dust = step(0.86, hash(floor(vec2(p.x * 9.0, vP.y * 4.0)))) * 0.2;
  float pulse = 0.9 + 0.1 * sin(uTime * 2.5);
  float a = clamp(across * (rough - dust) * 1.25, 0.0, 1.0) * pulse;
  gl_FragColor = vec4(1.0, 0.1, 0.08, a);
}`,
  },
};

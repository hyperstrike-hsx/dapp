/**
 * The wall bakery's fragment program: one tileable square of wall drawn three ways (colour, normal,
 * and occlusion/roughness/metal with the height in alpha). Everything repeats exactly across the
 * square, so every lattice the noise and the bonds stand on has a whole number of cells.
 */
export const WALL_VERTEX = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }
`;

export const WALL_FRAGMENT = /* glsl */`
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform int uMode, uKind;
uniform float uSeed, uSpan, uTexel, uDepth, uBump;
uniform vec4 uP[9];
uniform vec3 uC[8];

/** h height 0..1, c linear colour, r roughness, ao occlusion, m metal, k a number of the unit's own, e metres in from the unit's edge. */
struct Surf { float h; vec3 c; float r; float ao; float m; float k; float e; };

float h11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
vec3 h32(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yzz) * q.zyx); }

/** Gradient noise that repeats every \`per\` cells. About -0.8..0.8. */
float gn(vec2 p, vec2 per, float s) {
  vec2 i = floor(p), f = p - i, u = f * f * f * (f * (f * 6. - 15.) + 10.);
  vec2 o = vec2(s * 13.7 + uSeed * 3.1, s * 5.3 + uSeed * 7.7);
  vec2 a = h22(mod(i, per) + o) * 2. - 1., b = h22(mod(i + vec2(1., 0.), per) + o) * 2. - 1.;
  vec2 c = h22(mod(i + vec2(0., 1.), per) + o) * 2. - 1., d = h22(mod(i + vec2(1., 1.), per) + o) * 2. - 1.;
  return mix(mix(dot(a, f), dot(b, f - vec2(1., 0.)), u.x), mix(dot(c, f - vec2(0., 1.)), dot(d, f - vec2(1., 1.)), u.x), u.y) * 1.6;
}
/** Fractal noise from \`freq\` cells across the square. About -0.6..0.6. */
float fbm(vec2 uv, vec2 freq, int octaves, float s) {
  float a = .5, t = 0., n = 0.;
  for (int o = 0; o < octaves; o++) { t += a * gn(uv * freq, freq, s + float(o) * 1.7); n += a; freq *= 2.; a *= .5; }
  return t / n;
}
float ridge(vec2 uv, vec2 freq, int octaves, float s) {
  float a = .5, t = 0., n = 0.;
  for (int o = 0; o < octaves; o++) { t += a * (1. - abs(gn(uv * freq, freq, s + float(o) * 1.7)) * 1.6); n += a; freq *= 2.; a *= .5; }
  return t / n;
}
vec2 voroTo = vec2(0.);
/** Cells: x distance to the nearest point, y distance to the nearest border, zw the cell; voroTo is the way to that point. */
vec4 voro(vec2 p, vec2 per, float s, float jitter) {
  vec2 n = floor(p), f = p - n, mg = vec2(0.), mr = vec2(0.);
  vec2 so = vec2(s * 9.1 + uSeed * 1.7, s * 3.3 + uSeed * 5.9);
  float md = 8.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), r = g + (h22(mod(n + g, per) + so) - .5) * jitter + .5 - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float me = 8.;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j)), r = g + (h22(mod(n + g, per) + so) - .5) * jitter + .5 - f;
    if (dot(mr - r, mr - r) > 1e-5) me = min(me, dot(.5 * (mr + r), normalize(r - mr)));
  }
  voroTo = mr;
  return vec4(sqrt(md), me, mod(n + mg, per));
}

float jit(float i, float n, float s) { return h11(mod(i, n) * 1.37 + s * 17.31 + uSeed) - .5; }
/** The cell of a jittered row of n that holds t: its index and its two ends, in cells. */
vec3 cell1(float t, float n, float j, float s) {
  float i = floor(t), lo = i + j * jit(i, n, s), hi = i + 1. + j * jit(i + 1., n, s);
  if (t < lo) { i -= 1.; hi = lo; lo = i + j * jit(i, n, s); }
  else if (t >= hi) { i += 1.; lo = hi; hi = i + 1. + j * jit(i + 1., n, s); }
  return vec3(i, lo, hi);
}

struct Mason {
  float cols, rows, bond, jx, jy;
  /** Joint width (m), mortar level 0..1, arris radius (m), wander of the courses (m). */
  float joint, level, bevel, wobble;
  /** 0 brick, 1 rock-faced stone, 2 glazed, 3 cast block, 4 tooled stone, 5 travertine. */
  float face, relief, chips, hvar, tilt, cvar, grime, dark, flash, ragged, crust;
};

Surf masonry(vec2 uv, Mason m, vec3 cA, vec3 cB, vec3 cC, vec3 cM) {
  uv += m.wobble / uSpan * vec2(gn(uv * 14., vec2(14.), 21.), gn(uv * 14., vec2(14.), 22.));
  vec3 ry = cell1(uv.y * m.rows, m.rows, m.jy, 3.);
  float rm = mod(ry.x, m.rows), n = m.cols, off = 0.;
  bool flemish = false;
  if (m.bond < .5) off = .5 * mod(rm, 2.);
  else if (m.bond < 1.5) off = mod(rm, 3.) / 3.;
  else if (m.bond < 2.5) off = 0.;
  else if (m.bond < 3.5) { flemish = true; off = .5 * mod(rm, 2.); }
  else if (m.bond < 4.5) { if (mod(rm, 2.) > .5) { n *= 2.; off = .5; } }
  else if (m.bond < 5.5) off = h11(rm * 3.7 + 9.1 + uSeed);
  else { if (mod(rm, 6.) > 4.5) { n *= 2.; off = .5; } else off = .5 * mod(rm, 2.); }
  float t = uv.x * n + off, idn = n;
  vec3 cx;
  if (flemish) { float k = floor(t), fr = t - k; idn = n * 2.; cx = fr < .6667 ? vec3(k * 2., k, k + .6667) : vec3(k * 2. + 1., k + .6667, k + 1.); }
  else cx = cell1(t, n, m.jx, rm + 11.);
  vec3 id = h32(vec2(mod(cx.x, idn), rm) + uSeed * 1.31 + .5);
  vec2 size = vec2((cx.z - cx.y) / n, (ry.z - ry.y) / m.rows) * uSpan;
  vec2 q = vec2((t - cx.y) / n, uv.y - ry.y / m.rows) * uSpan - size * .5;
  vec2 hf = size * .5 - m.joint * (.5 + m.ragged * .6 * (id.z - .3));
  float rad = min(m.bevel, min(hf.x, hf.y) * .6);
  vec2 dd = abs(q) - (hf - rad);
  float d = length(max(dd, 0.)) + min(max(dd.x, dd.y), 0.) - rad;
  // Arrises worn and broken by the weather.
  float bite = max(0., gn(uv * 41. + id.xy * 9., vec2(41.), 33.)) + .5 * max(0., gn(uv * 97., vec2(97.), 34.));
  d += m.chips * .006 * bite + m.ragged * .0012 * gn(uv * 160., vec2(160.), 35.);
  float e = -d, body = smoothstep(0., m.bevel + .0006, e), least = min(hf.x, hf.y);
  float det, rough = .9;
  float fleck = 0.;
  if (m.face < .5) {
    // Sand-faced clay: grit, the drag of the cutting wire, kiln dents, folds and burnt-out pebbles.
    float grit = fbm(uv, vec2(256.), 3, 41.), drag = gn(uv * vec2(4., 380.) + id.xy * 3., vec2(4., 380.), 43.) * (.5 + .5 * id.y);
    float dent = fbm(uv + id.xy, vec2(20.), 3, 44.), pit = smoothstep(.5, .72, gn(uv * 170. + id.yx * 13., vec2(170.), 45.));
    float fold = smoothstep(.45, .8, gn(uv * vec2(70., 16.) + id.xy * 5., vec2(70., 16.), 42.)) * step(.5, id.z);
    det = .6 * grit + .3 * drag + .6 * dent - 1.5 * pit - .6 * fold;
    fleck = .5 * grit - .7 * pit - .3 * fold;
    rough = .86 + .1 * id.y;
  } else if (m.face < 1.5) {
    float pillow = sqrt(clamp(e / (least * .75), 0., 1.));
    det = 1.6 * (pillow - 1.) + 1.5 * (ridge(uv + id.xy, vec2(18.), 4, 46.) - .6) + .35 * fbm(uv, vec2(120.), 3, 47.);
    rough = .92;
  } else if (m.face < 2.5) {
    det = -.8 * (1. - smoothstep(0., least * .5, e)) + .12 * gn(uv * 30. + id.xy * 5., vec2(30.), 48.);
    rough = .1 + .1 * id.y + .1 * smoothstep(.1, .5, fbm(uv, vec2(40.), 3, 49.));
  } else if (m.face < 3.5) {
    vec4 pit = voro(uv * 220., vec2(220.), 50., 1.);
    det = .35 * fbm(uv, vec2(90.), 3, 51.) - 1.3 * (1. - smoothstep(.0, .32, pit.x)) * step(.55, h12(pit.zw + 3.)) - .7 * smoothstep(.55, .75, gn(uv * 60., vec2(60.), 52.));
    rough = .95;
  } else if (m.face < 4.5) {
    float line = uv.x * 190. + uv.y * 60. + 6. * gn(uv * 12. + id.xy * 4., vec2(12.), 53.);
    det = .45 * (abs(fract(line + id.x * 7.) - .5) * 2. - .5) * smoothstep(0., .012, e) + .3 * fbm(uv, vec2(70.), 3, 54.);
    rough = .88;
  } else {
    // Travertine: bedded bands, and the voids the spring left along them.
    float band = fbm(uv + vec2(0., id.x * .37), vec2(3., 46.), 4, 55.);
    float pore = smoothstep(.34, .6, gn(uv * vec2(40., 170.) + id.xy * 7., vec2(40., 170.), 56.) + .5 * band);
    det = .25 * band - 2.2 * pore + .12 * fbm(uv, vec2(140.), 2, 57.);
    rough = .62 + .25 * pore;
  }
  float chip = smoothstep(.22, .5, gn(uv * 26. + id.xy * 7., vec2(26.), 58.)) * (1. - smoothstep(0., .016, e));
  float face = 1. - m.hvar * id.x + m.tilt * dot(q / hf, id.yz - .5) + m.relief * det - m.chips * .5 * chip;
  float sand = fbm(uv, vec2(230.), 3, 61.);
  float mortar = m.level + .1 * sand + .07 * gn(uv * 31., vec2(31.), 62.);
  float h = mix(mortar, max(face, mortar - .05), body);
  // Colour: a mix of the two body tones, a share of overburnt ones, mottling and a dark heart.
  vec3 base = mix(cA, cB, smoothstep(.25, .75, id.y + .3 * gn(uv * 3., vec2(3.), 63.)));
  if (id.x > 1. - m.dark) base = mix(base, cC, .55 + .45 * id.z);
  float blot = fbm(uv + id.xy * 3., vec2(24.), 3, 64.), fine = fbm(uv + id.yx * 5., vec2(64.), 3, 65.);
  base *= 1. + m.cvar * (1.2 * blot + .8 * fine + 1.1 * (id.z - .5));
  base *= 1. + m.cvar * (m.face < .5 ? .7 : .2) * (h32(id.xy * 91.7 + 3.1) - .5) * vec3(.6, 1., 1.3);
  // Fired hard at the heart: a share of the units carry a dark core; others a pale crust of kiln scum and salts.
  vec2 l = q / hf;
  float core = 1. - smoothstep(.2, .95, length(l * vec2(.75, 1.05) + (id.zx - .5) * .7) + 1.1 * blot + .5 * fine);
  base = mix(base, cC * (.7 + .5 * id.x), step(id.y, m.flash) * core * (.3 + .65 * h11(id.x * 77.7 + 5.)));
  float crust = smoothstep(.02, .3, .7 * blot + .8 * fine + .2 * (id.z - .5)) * step(1. - m.crust, id.y);
  base = mix(base, cM * 1.35 + .06, crust * .75);
  base *= 1. + .2 * fleck - .22 * m.chips * chip;
  // Iron spots and grains of sand in the face.
  float spot = gn(uv * 330. + id.xy * 11., vec2(330.), 66.);
  base *= 1. - .5 * smoothstep(.42, .62, spot) * step(m.face, .5) + .35 * smoothstep(.45, .7, -spot) * step(m.face, .5);
  if (m.face > 4.5) base *= 1. - .3 * smoothstep(.3, .6, gn(uv * vec2(40., 170.) + id.xy * 7., vec2(40., 170.), 56.));
  if (m.face > .5 && m.face < 1.5) base *= .82 + .3 * ridge(uv + id.xy, vec2(18.), 3, 46.);
  // Cast and cut faces: the aggregate or the grain of the stone, and what the weather has left on it.
  if (m.face > 2.5 && m.face < 4.5) base *= 1. + .3 * fbm(uv, vec2(190.), 3, 59.) - .3 * smoothstep(.3, .7, gn(uv * 90. + id.xy * 3., vec2(90.), 60.)) + .2 * det;
  vec3 joint = cM * (1. + .3 * sand + .2 * fbm(uv, vec2(60.), 3, 67.) + .14 * gn(uv * 5., vec2(5.), 68.));
  joint *= 1. - .35 * smoothstep(.4, .7, gn(uv * 280., vec2(280.), 70.));
  float edge = smoothstep(-.0006, .0016, e);
  // Mortar dragged over the arris when the joint was struck.
  float smear = (1. - smoothstep(0., .014, e)) * smoothstep(-.15, .35, gn(uv * 34. + id.xy * 3., vec2(34.), 71.)) * m.ragged;
  base = mix(base, joint, .5 * smear);
  vec3 c = mix(joint, base, edge);
  c *= 1. - m.grime * (.5 * (1. - body) * edge + .36 * smoothstep(-.15, .45, fbm(uv, vec2(3.), 4, 69.)));
  c *= 1. + .3 * m.grime * fbm(uv, vec2(2.), 3, 72.);
  float ao = mix(mix(.45, .92, m.level), 1., smoothstep(-.002, m.bevel * 2. + .004, e)) * (1. - .35 * clamp(-det * m.relief * 3., 0., 1.));
  return Surf(h, c, mix(.96, rough, edge), ao, 0., id.x, e);
}

Surf rubble(vec2 uv) {
  vec2 per = uP[0].xy;
  float cell = uSpan * 2. / (per.x + per.y);
  uv += .22 * cell / uSpan * vec2(fbm(uv, vec2(7.), 3, 23.), fbm(uv, vec2(7.), 3, 24.));
  vec4 v = voro(uv * per, per, 5., uP[0].z);
  vec2 to = voroTo;
  vec3 id = h32(v.zw + 7.3 + uSeed);
  float e = v.y * cell - uP[0].w * (.35 + .9 * id.z) - .006 * (gn(uv * 44., vec2(44.), 25.) + .5 * gn(uv * 120., vec2(120.), 34.)) * uP[2].z;
  float body = smoothstep(0., uP[2].x, e), pillow = sqrt(clamp(e / (cell * .3), 0., 1.));
  // Every stone is split on its own planes: a face that leans its own way, broken into ledges.
  float rock = ridge(uv + id.xy, vec2(22.), 4, 26.), ledge = fbm(uv + id.yx * 3., vec2(40.), 3, 35.);
  float det = 1.5 * (rock - .6) + .7 * ledge + .4 * fbm(uv, vec2(140.), 3, 27.);
  float face = 1. - uP[2].y * id.x - uP[1].x * (1. - pillow) + uP[1].y * det - uP[2].y * 1.4 * dot(to, id.yz - .5);
  float sand = fbm(uv, vec2(150.), 3, 28.);
  float mortar = uP[1].z + .08 * sand + .08 * gn(uv * 19., vec2(19.), 29.);
  float h = mix(mortar, max(face, mortar - .05), body);
  vec3 base = mix(uC[0], uC[1], smoothstep(.2, .8, id.y));
  if (id.x > 1. - uP[3].x) base = mix(base, uC[2], .7);
  base *= 1. + uP[1].w * (1.2 * fbm(uv + id.xy * 3., vec2(14.), 3, 30.) + 1.3 * (id.z - .5)) + .25 * ledge;
  base *= 1. + .22 * uP[1].w * (h32(id.xy * 57.3 + 1.7) - .5) * vec3(.7, 1., 1.3);
  // Bedding through each stone, a different way in each, and lichen on some.
  vec2 way = floor(mix(vec2(-30.), vec2(30.), id.xy));
  base *= 1. + .1 * uP[3].y * sin(6.2832 * (dot(uv, way) + 2.5 * fbm(uv, vec2(9.), 3, 31.)));
  base *= .8 + .36 * rock;
  base = mix(base, base * vec3(.8, .86, .7) + vec3(.02, .03, .0), uP[2].w * .6 * smoothstep(.1, .4, fbm(uv, vec2(9.), 4, 36.)) * step(.5, id.z));
  vec3 joint = uC[3] * (1. + .3 * sand + .2 * fbm(uv, vec2(40.), 3, 32.));
  float edge = smoothstep(-.001, .003, e);
  vec3 c = mix(joint, base, edge);
  c *= 1. - uP[2].w * (.55 * (1. - body) * edge + .3 * smoothstep(-.15, .45, fbm(uv, vec2(3.), 4, 33.)));
  float ao = mix(mix(.35, .9, uP[1].z), 1., smoothstep(-.004, uP[2].x * 2.5 + .008, e)) * (1. - .3 * clamp(-det * uP[1].y * 3., 0., 1.));
  return Surf(h, c, mix(.97, .9, edge), ao, 0., id.x, e);
}

Surf plaster(vec2 uv) {
  float trowel = uP[0].x, grain = uP[0].y, crack = uP[0].z, pebble = uP[0].w;
  float patches = uP[1].x, strata = uP[2].w;
  float sweep = fbm(uv, vec2(5., 11.), 4, 71.) + .6 * fbm(uv, vec2(13., 6.), 3, 72.);
  float h = .78 + .1 * uP[3].w * fbm(uv, vec2(2.), 3, 73.) + trowel * .16 * sweep + grain * .05 * fbm(uv, vec2(260.), 2, 74.);
  // Roughcast: stones thrown on and washed over.
  vec4 peb = voro(uv * 150., vec2(150.), 75., 1.);
  float stone = (1. - smoothstep(.1, .5, peb.x)) * step(.35, h12(peb.zw + 1.));
  h += pebble * .16 * stone;
  float layer = fbm(vec2(uv.x * .5, uv.y) + .02 * gn(uv * 3., vec2(3.), 76.), vec2(2., 26.), 3, 77.);
  h += strata * (.12 * layer + .1 * smoothstep(.15, .3, gn(uv * vec2(30., 90.), vec2(30., 90.), 78.)));
  vec3 c = mix(uC[0], uC[1], smoothstep(-.35, .35, fbm(uv, vec2(3.), 5, 79.) + .35 * sweep));
  c *= 1. + .1 * fbm(uv, vec2(180.), 2, 80.) + .12 * pebble * (stone - .4) + strata * .5 * layer;
  float r = uP[3].x, ao = 1. - .3 * pebble * (1. - stone) - .25 * clamp(-trowel * sweep, 0., 1.);
  // Cracks, in the parts of the wall that have moved.
  vec4 cr = voro(uv * uP[3].z + .35 * vec2(gn(uv * 9., vec2(9.), 81.), gn(uv * 9., vec2(9.), 82.)), vec2(uP[3].z), 83., 1.);
  float where = smoothstep(.02, .3, fbm(uv, vec2(2.), 3, 84.) + crack - .5);
  float line = (1. - smoothstep(0., .012 + .012 * crack, cr.y)) * where * step(.001, crack);
  h -= .22 * line; c *= 1. - .55 * line; ao *= 1. - .4 * line;
  // Rain streaks and stains.
  float run = smoothstep(.0, .5, fbm(uv, vec2(34., 2.), 4, 85.)) * smoothstep(-.3, .3, fbm(uv, vec2(3., 2.), 3, 86.));
  c = mix(c, c * uC[4], uP[2].x * run);
  c = mix(c, c * uC[4], uP[2].y * smoothstep(.05, .45, fbm(uv, vec2(4.), 5, 87.)));
  c *= 1. + uP[2].z * .5 * (h12(floor(uv * 700.) + uSeed) - .5);
  // Where the render has fallen away, the wall behind shows.
  float e = 1.;
  if (patches > 0.) {
    float field = .5 + 1.1 * fbm(uv, vec2(3.), 5, 88.) + .08 * fbm(uv, vec2(40.), 3, 89.);
    float gone = smoothstep(patches, patches - .012, field), rim = smoothstep(patches + .05, patches, field) * (1. - gone);
    Mason m = Mason(uP[1].y, uP[1].z, 0., .12, .1, .012, .25, .004, .003, uP[1].w, .09, .5, .1, .08, .22, .5, .1, .3, .6, .1);
    Surf under = masonry(uv, m, uC[2], uC[5], uC[6], uC[3]);
    h = mix(h - .06 * rim, under.h * .5, gone);
    c = mix(mix(c, uC[3] * 1.15, .6 * rim), under.c, gone);
    r = mix(r, under.r, gone); ao = mix(ao, under.ao * .85, gone);
    e = field - patches;
  }
  return Surf(h, c, r, ao, 0., .5, e);
}

Surf concrete(vec2 uv) {
  float boards = uP[0].x, upright = uP[0].y, stepH = uP[0].z, grain = uP[0].w;
  vec2 bu = upright > .5 ? uv.yx : uv;
  float h = .82 + .05 * fbm(uv, vec2(2.), 4, 101.) + .035 * fbm(uv, vec2(150.), 3, 102.), ao = 1.;
  vec3 c = mix(uC[0], uC[1], smoothstep(-.3, .3, fbm(uv, vec2(4.), 5, 103.)));
  float e = 1.;
  if (boards > 0.) {
    vec3 by = cell1(bu.y * boards, boards, .25, 104.);
    float id = h11(mod(by.x, boards) * 3.1 + 7. + uSeed), across = (bu.y * boards - by.y) / (by.z - by.y);
    // Each board left its own level, its grain and a fin of grout at its edges.
    float lines = fbm(vec2(bu.x + id * 3.7, bu.y), vec2(3., boards * 26.), 3, 105.) + .5 * gn(vec2(bu.x * 2. + id, bu.y * boards * 9.), vec2(2., boards * 9.), 106.);
    float fin = 1. - smoothstep(0., .035, min(across, 1. - across));
    // Butt ends, staggered board to board.
    float ends = 1. - smoothstep(0., .0016, abs(fract(bu.x * 2. + id * 5.) - .5) * .5);
    h += stepH * (id - .5) + grain * .1 * lines + .09 * fin * (.4 + id) - .05 * ends;
    c *= 1. + .2 * (id - .5) + grain * .2 * lines - .16 * fin;
    ao *= 1. - .2 * fin;
  }
  // Formwork ties: a cone hole at each, and what has run from it since.
  vec2 ties = uP[1].xy;
  if (ties.x > 0.) {
    vec2 g = uv * ties, f = fract(g) - .5;
    float d = length(f / ties) * uSpan, hole = 1. - smoothstep(uP[1].z * .35, uP[1].z, d);
    h -= uP[1].w * hole; ao *= 1. - .6 * hole; c *= 1. - .45 * hole;
    float below = step(f.y, 0.) * exp(f.y * 5.) * (1. - smoothstep(0., uP[1].z * 1.6, abs(f.x) / ties.x * uSpan + .004 * gn(uv * 40., vec2(40.), 107.)));
    c = mix(c, c * uC[3], uP[3].y * below * step(.4, h12(floor(g) + 5.)));
  }
  // Blowholes left by air against the form.
  vec4 pit = voro(uv * 90., vec2(90.), 108., 1.);
  float hole = (1. - smoothstep(.03, .09 + .1 * uP[2].y, pit.x)) * step(1. - uP[2].x, h12(pit.zw + 9.));
  h -= .3 * hole; c *= 1. - .5 * hole; ao *= 1. - .5 * hole;
  // Pour lines: where one lift ended and the next began.
  float lift = uv.y * uP[2].z + .04 * gn(uv * vec2(6., 1.), vec2(6., 1.), 109.) * uP[2].z;
  float seam = (1. - smoothstep(0., .03, abs(fract(lift) - .5))) * step(.5, uP[2].z);
  h -= .05 * seam; c *= 1. - .14 * seam + .08 * (h11(mod(floor(lift + .5), max(1., uP[2].z)) + 3.) - .5) * step(.5, uP[2].z);
  // Exposed aggregate.
  if (uP[2].w > 0.) {
    vec4 ag = voro(uv * 120., vec2(120.), 110., 1.);
    vec3 aid = h32(ag.zw + 2.);
    float st = smoothstep(.03, .16, ag.y) * step(.25, aid.x);
    h += uP[2].w * (.12 * st * (.6 + .4 * aid.y) - .06);
    c = mix(c * .8, mix(uC[4], uC[5], aid.y) * (.8 + .4 * aid.z), st * uP[2].w);
    ao *= 1. - .25 * uP[2].w * (1. - st);
  }
  // Panel joints.
  vec2 panels = uP[4].xy;
  if (panels.x > 0.) {
    vec2 f = abs(fract(uv * panels) - .5) / panels * uSpan;
    e = min(f.x, f.y);
    float groove = 1. - smoothstep(uP[4].z * .35, uP[4].z, e);
    h -= uP[4].w * groove; ao *= 1. - .55 * groove; c *= 1. - .3 * groove;
    float pid = h12(floor(uv * panels) + 4. + uSeed);
    c *= 1. + .12 * (pid - .5);
  }
  float run = smoothstep(.05, .5, fbm(uv, vec2(30., 2.), 4, 111.)) * smoothstep(-.3, .3, fbm(uv, vec2(3., 2.), 3, 112.));
  c = mix(c, c * uC[2], uP[3].x * run);
  c = mix(c, c * uC[2], uP[3].z * smoothstep(.05, .45, fbm(uv, vec2(4.), 5, 113.)));
  c *= 1. + .12 * fbm(uv, vec2(200.), 2, 114.);
  return Surf(h, c, uP[3].w + .06 * fbm(uv, vec2(20.), 3, 115.), ao, 0., .5, e);
}

Surf surf(vec2 uv) {
  Surf s;
  if (uKind == 0) {
    Mason m = Mason(uP[0].x, uP[0].y, uP[0].z, uP[0].w, uP[2].w, uP[1].x, uP[1].y, uP[1].z, uP[1].w, uP[2].x, uP[2].y, uP[2].z, uP[3].x, uP[3].y, uP[3].z, uP[3].w, uP[4].x, uP[4].y, uP[4].z, uP[5].x);
    s = masonry(uv, m, uC[0], uC[1], uC[2], uC[3]);
    s.r = mix(s.r, s.r * uP[4].w, smoothstep(-.0005, .002, s.e));
  } else if (uKind == 1) s = rubble(uv);
  else if (uKind == 2) s = plaster(uv);
  else s = concrete(uv);
  // Paint over the lot, flaking unit by unit.
  if (uP[7].x > 0.) {
    float field = clamp(.5 + 1.2 * fbm(uv, vec2(4.), 5, 121.) + .1 * fbm(uv, vec2(60.), 3, 122.) + uP[7].w * (s.k - .5), 0., 1.);
    float on = smoothstep(uP[7].x + .01, uP[7].x - .01, field), lip = on * smoothstep(uP[7].x - .07, uP[7].x, field);
    vec3 coat = uC[6] * (1. + .1 * fbm(uv, vec2(7.), 4, 123.) + .05 * fbm(uv, vec2(150.), 2, 124.));
    coat *= mix(1., s.ao, .5);
    s.c = mix(s.c, coat, on * uP[7].z);
    s.r = mix(s.r, uP[7].y, on);
    s.h += .03 * on + .04 * lip;
  }
  // Soot runs, and salts bloomed out of the wall.
  float run = smoothstep(.0, .45, fbm(uv, vec2(64., 1.), 4, 125.)) * smoothstep(-.25, .3, fbm(uv, vec2(5., 1.), 3, 126.));
  s.c *= 1. - uP[8].x * (.55 * run + .25 * smoothstep(-.3, .4, fbm(uv, vec2(2., 3.), 4, 129.)));
  float bloom = smoothstep(.12, .5, fbm(uv, vec2(6.), 5, 127.)) * smoothstep(-.002, .004, s.e);
  s.c = mix(s.c, vec3(.62, .6, .56), .5 * uP[8].y * bloom);
  // Moss and damp in the joints.
  float damp = smoothstep(0., .4, fbm(uv, vec2(5.), 4, 128.)) * (1. - smoothstep(0., .006, s.e));
  s.c = mix(s.c, uC[7], uP[8].z * damp);
  s.h = clamp(s.h, 0., 1.);
  return s;
}

void main() {
  Surf s = surf(vUv);
  if (uMode == 0) outColor = vec4(max(s.c, 0.), 1.);
  else if (uMode == 2) outColor = vec4(clamp(s.ao, 0., 1.), clamp(s.r, .04, 1.), s.m, s.h);
  else {
    float e = uTexel;
    float dx = surf(vUv + vec2(e, 0.)).h - surf(vUv - vec2(e, 0.)).h, dy = surf(vUv + vec2(0., e)).h - surf(vUv - vec2(0., e)).h;
    vec3 n = normalize(vec3(-vec2(dx, dy) * uDepth * uBump / (2. * e * uSpan), 1.));
    outColor = vec4(n * .5 + .5, 1.);
  }
}
`;

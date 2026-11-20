import type * as THREE from "three";

// Weapon skins.
//
// The finishes follow the index illustrations in public/indexes: every weapon wears the green
// lacquer, gilt serpent and ivory of HS-BLUE20.
//
// A skin is painted in the shader, not into a texture: every weapon is modelled in the same
// space (metres, bore along -Z, +Y up), so a few lines of code can say "a band here, a stripe
// down the stock, a serpent along the receiver" and stay sharp at any distance at no texture cost.

/** One coat of a skin: what the surface becomes where the paint code says so. */
export type Coat = { color: THREE.ColorRepresentation; roughness: number; metalness: number };

/**
 * A painted scheme laid over a finish. `paint` is GLSL run for every pixel. It reads `p` (the
 * point in weapon space), `facing` (1 looking straight at the surface, 0 along it) and the
 * surface so far (`diffuseColor`, `roughnessFactor`, `metalnessFactor`), and sets `a`, `b`
 * and `c` (0–1): how much of each coat shows there. It may tint `coatA`, `coatB`, `coatC`.
 * Coats go on in that order and under the edge wear, so handling rubs through them.
 */
export type Skin = { key: string; paint: string; coats: Coat[] };

export const SKIN_COATS = 3;

/** Value noise shared by the edge wear and the skins. */
export const NOISE_GLSL = /* glsl */`
  float wearHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float wearNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(wearHash(i), wearHash(i + vec3(1, 0, 0)), f.x), mix(wearHash(i + vec3(0, 1, 0)), wearHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(wearHash(i + vec3(0, 0, 1)), wearHash(i + vec3(1, 0, 1)), f.x), mix(wearHash(i + vec3(0, 1, 1)), wearHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float wearFbm(vec3 p) { return wearNoise(p) * 0.55 + wearNoise(p * 2.7 + 9.1) * 0.3 + wearNoise(p * 7.1 + 3.7) * 0.15; }
`;

export const SKIN_VERTEX_PARS = /* glsl */`
  uniform mat4 skinFrame;
  varying vec3 vSkin;
`;
/** `aRifle` is the vertex at rest in the model's own space; the frame carries it into weapon space. */
export const SKIN_VERTEX = "vSkin = (skinFrame * vec4(aRifle, 1.0)).xyz;";

export const SKIN_PARS = /* glsl */`
  uniform vec3 skinColor[${SKIN_COATS}];
  uniform vec2 skinFinish[${SKIN_COATS}];
  varying vec3 vSkin;
  // Antialiased tests: 1 above a level, and 1 between two.
  float skinOver(float v, float level) { float w = fwidth(v) + 1e-6; return smoothstep(level - w, level + w, v); }
  float skinIn(float v, float lo, float hi) { return skinOver(v, lo) * (1.0 - skinOver(v, hi)); }
  // A field drawn out along the bore and stirred once: its contours are the scrolls of cloud.
  float skinFlow(vec3 p) {
    vec3 q = p * vec3(1.0, 1.0, 0.42);
    vec3 stir = vec3(wearNoise(q * 15.0 + 3.1), wearNoise(q * 15.0 + 17.3), wearNoise(q * 15.0 + 29.7)) - 0.5;
    return wearFbm(q * 10.0 + stir * 1.5);
  }
  // Hairlines along the contours of a field, fading out where they would be finer than a pixel.
  float skinLines(float field, float count, float thin) {
    float g = field * count, w = fwidth(g);
    return (1.0 - smoothstep(thin, thin + w, abs(fract(g) - 0.5))) * clamp(1.6 - w * 2.4, 0.0, 1.0);
  }
  // Overlapping scales: 0 on the rim of each scale, 1 at its heart.
  float skinScales(vec2 uv) {
    vec2 a = fract(uv) - 0.5, b = fract(uv + 0.5) - 0.5;
    return 1.0 - smoothstep(0.3, 0.5, min(length(a * vec2(1.0, 1.35)), length(b * vec2(1.0, 1.35))) * 1.25);
  }
`;

/** The block that runs a skin's paint code and lays its coats on, placed before the edge wear. */
export const skinApply = (paint: string) => /* glsl */`
  {
    vec3 p = vSkin;
    float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    float a = 0.0, b = 0.0, c = 0.0;
    vec3 coatA = skinColor[0], coatB = skinColor[1], coatC = skinColor[2];
    float texel = roughnessFactor;
    ${paint}
    a = clamp(a, 0.0, 1.0); b = clamp(b, 0.0, 1.0); c = clamp(c, 0.0, 1.0);
    // The base's own roughness texture still shows through a coat, so paint is not a flat sticker.
    float grain = mix(0.82, 1.18, texel);
    diffuseColor.rgb = mix(diffuseColor.rgb, coatA, a);
    roughnessFactor = mix(roughnessFactor, skinFinish[0].x * grain, a);
    metalnessFactor = mix(metalnessFactor, skinFinish[0].y, a);
    diffuseColor.rgb = mix(diffuseColor.rgb, coatB, b);
    roughnessFactor = mix(roughnessFactor, skinFinish[1].x * grain, b);
    metalnessFactor = mix(metalnessFactor, skinFinish[1].y, b);
    diffuseColor.rgb = mix(diffuseColor.rgb, coatC, c);
    roughnessFactor = mix(roughnessFactor, skinFinish[2].x * grain, c);
    metalnessFactor = mix(metalnessFactor, skinFinish[2].y, c);
  }
`;

// ---- HS-BLUE20: green lacquer, a gilt serpent among clouds, ivory caps --------

const LACQUER: Coat = { color: "#0c3a26", roughness: 0.22, metalness: 0 };
const GILT: Coat = { color: "#e6aa42", roughness: 0.3, metalness: 1 };
const IVORY: Coat = { color: "#efe2c2", roughness: 0.42, metalness: 0 };
const lacquer = (key: string, paint: string): Skin => ({ key, paint, coats: [LACQUER, GILT, IVORY] });
const f = (n: number) => n.toFixed(4);

/** Lacquer is not one flat green: it pools a little darker and lighter. */
const DEPTH = "coatA *= 0.78 + 0.44 * wearNoise(p * 34.0 + 7.0);";
/**
 * The serpent every lacquered weapon carries: a scaled body winding along the bore from `tail` to
 * `head`, about the height `mid` (GLSL, may read p.z), swaying by `sway` and as thick as `girth`
 * (each given at the tail, then at the head), with a crest of fins along its back and scrolls of
 * cloud around it. Leaves `figure`: all of that gilt work together.
 */
const serpent = (tail: number, head: number, mid: string, sway: [number, number], girth: [number, number], coils = 46) => /* glsl */`
  float along = clamp((p.z - ${f(tail)}) / ${f(head - tail)}, 0.0, 1.0);
  float within = step(0.002, along) * step(along, 0.998);
  float wind = p.y - ((${mid}) + mix(${f(sway[0])}, ${f(sway[1])}, along) * sin(p.z * ${f(coils)} + 0.6));
  float girth = mix(${f(girth[0])}, ${f(girth[1])}, smoothstep(0.05, 0.9, along)) * smoothstep(0.0, 0.05, along) * (1.0 - smoothstep(0.93, 1.0, along));
  float snake = (1.0 - skinOver(abs(wind), girth)) * within;
  float scales = skinScales(vec2(p.z * 210.0, wind * 150.0));
  float crest = skinIn(wind, girth, girth + 0.0045) * step(0.35, fract(p.z * 95.0)) * within;
  float cloud = skinLines(skinFlow(p * 1.3 + 4.0), 7.0, 0.075) * (1.0 - skinIn(abs(wind), 0.0, girth + 0.006) * within);
  float figure = max(max(snake, crest), cloud);
  coatB *= mix(1.0, 0.5 + 0.6 * scales, snake);
  ${DEPTH}
`;
/** Clouds alone, for parts the serpent does not reach. */
const CLOUDS = /* glsl */`
  float figure = skinLines(skinFlow(p * 1.3 + 4.0), 7.0, 0.075);
  ${DEPTH}
`;
/** Gilt all over: bolt carriers and butt plates. */
const GILDED = lacquer("gilded", "b = 1.0;");

/** The AK's serpent runs from the butt, up the stock and along the receiver. */
const AK_SERPENT = serpent(0.25, -0.2, "mix(0.022, 0.004 - 0.3 * (p.z - 0.06), smoothstep(0.02, 0.08, p.z))", [0.011, 0.017], [0.003, 0.0105], 44);
/** AK-47, by the model's material names. */
export const AK_SKINS: Record<string, Skin> = {
  Material_1: lacquer("ak-steel", /* glsl */`
    ${AK_SERPENT}
    float low = 1.0 - skinOver(p.y, -0.036);
    float receiver = skinIn(p.z, -0.214, 0.04) * (1.0 - low);
    // The magazine follows an arc: two gilt lines along its curve, an ivory foot closed with a band.
    vec2 arm = p.zy - vec2(-0.39, 0.037);
    float reach = length(arm), turn = atan(arm.y, arm.x);
    float magazine = low * skinIn(p.z, -0.3, -0.1);
    float curve = max(skinIn(reach, 0.2105, 0.2137), skinIn(reach, 0.2575, 0.2607)) * skinOver(turn, -0.77);
    a = max(receiver, magazine);
    c = magazine * (1.0 - skinOver(turn, -0.8));
    b = max(receiver * figure, magazine * max(curve, skinIn(turn, -0.8, -0.775)));
    // Gilt furniture on the blacked steel: crown and foresight, the rear sight, the selector.
    float furniture = max(max(1.0 - skinOver(p.z, -0.59), skinOver(p.y, 0.0865) * skinIn(p.z, -0.28, -0.214)), skinOver(p.x, 0.0185) * skinIn(p.z, -0.15, -0.02));
    b = max(b, (1.0 - a) * furniture);
  `),
  Material_2: lacquer("ak-furniture", /* glsl */`
    ${AK_SERPENT}
    float guard = 1.0 - skinOver(p.z, -0.2);
    float grip = skinIn(p.z, -0.1, 0.047) * (1.0 - skinOver(p.y, 0.008));
    float stock = skinOver(p.z, 0.02) * (1.0 - grip);
    a = 1.0;
    // Ivory at the nose of the handguard, the foot of the grip and the butt, each closed with a gilt band.
    c = max(max(guard * (1.0 - skinOver(p.z, -0.38)), grip * (1.0 - skinOver(p.y, -0.088))), stock * skinOver(p.z, 0.25));
    float bands = max(max(guard * max(skinIn(p.z, -0.38, -0.373), skinIn(p.z, -0.213, -0.206)), grip * skinIn(p.y, -0.088, -0.082)), stock * skinIn(p.z, 0.243, 0.25));
    b = max(figure * (1.0 - c), bands);
  `),
  Material_3: GILDED,
  Material_5: GILDED,
};

/** M4A1 (bore at y 0.066): the serpent runs the receivers and the handguard. */
export const M4_SKINS: Record<string, Skin> = {
  anodized: lacquer("m4-metal", /* glsl */`
    ${serpent(0.04, -0.348, "0.058", [0.012, 0.019], [0.0032, 0.0105], 42)}
    float guard = skinIn(p.z, -0.38, -0.178);
    float receivers = skinIn(p.z, -0.17, 0.05) * (1.0 - skinOver(p.y, 0.0975));
    a = max(guard, receivers);
    c = guard * (1.0 - skinOver(p.z, -0.358));
    b = max(a * figure * (1.0 - c), guard * max(skinIn(p.z, -0.358, -0.351), skinIn(p.z, -0.19, -0.181)));
  `),
  polymer: lacquer("m4-polymer", /* glsl */`
    ${CLOUDS}
    float stock = skinOver(p.z, 0.12);
    float grip = skinIn(p.z, -0.04, 0.07);
    float magazine = skinIn(p.z, -0.17, -0.08);
    a = 1.0;
    c = max(max(stock * skinOver(p.z, 0.258), grip * (1.0 - skinOver(p.y, -0.089))), magazine * (1.0 - skinOver(p.y, -0.168)));
    // A gilt line down the middle of the magazine.
    float spine = p.z - (-0.116 + 0.105 * p.y);
    float bands = max(max(stock * skinIn(p.z, 0.25, 0.258), grip * skinIn(p.y, -0.089, -0.083)), magazine * max(skinIn(p.y, -0.168, -0.161), skinIn(spine, -0.0028, 0.0028) * skinIn(p.y, -0.155, -0.03)));
    b = max(figure * (1.0 - c), bands);
  `),
};
/** Gilt furniture on the M4's steel: delta ring, foresight block, castle nut, crown and flash hider. */
const M4_TRIM = lacquer("m4-trim", /* glsl */`
  b = max(max(skinIn(p.z, -0.182, -0.166), skinIn(p.z, -0.42, -0.384)), max(skinIn(p.z, 0.044, 0.06), 1.0 - skinOver(p.z, -0.53)));
`);
M4_SKINS.parkerized = M4_TRIM;
M4_SKINS.blued = M4_TRIM;

/** FAMAS (bore at y 0.05): the serpent runs the whole one-piece body, butt to muzzle. */
export const FAMAS_SKINS: Record<string, Skin> = {
  grey: lacquer("famas-body", /* glsl */`
    ${serpent(0.37, -0.19, "mix(0.047, 0.012, smoothstep(0.0, 0.25, p.z))", [0.03, 0.012], [0.0035, 0.0105], 40)}
    float body = 1.0 - skinOver(p.y, 0.083);
    float grip = skinIn(p.z, -0.004, 0.06) * (1.0 - skinOver(p.y, -0.04));
    a = 1.0;
    c = max(body * max(skinOver(p.z, 0.376), 1.0 - skinOver(p.z, -0.198)), grip * (1.0 - skinOver(p.y, -0.094)));
    float bands = max(body * max(skinIn(p.z, 0.368, 0.376), skinIn(p.z, -0.198, -0.191)), grip * skinIn(p.y, -0.094, -0.088));
    // One gilt line along the carrying handle.
    bands = max(bands, skinIn(p.y, 0.1505, 0.1555) * skinIn(p.z, -0.17, 0.1));
    b = max(figure * (1.0 - c), bands);
  `),
};
/** The FAMAS's steel: a lacquered magazine with an ivory foot; gilt launcher rings, flash hider and cocking handle. */
const FAMAS_TRIM = lacquer("famas-trim", /* glsl */`
  ${CLOUDS}
  float magazine = skinIn(p.z, 0.09, 0.17) * (1.0 - skinOver(p.y, -0.004));
  a = magazine;
  c = magazine * (1.0 - skinOver(p.y, -0.17));
  b = magazine * max(figure * (1.0 - c), skinIn(p.y, -0.17, -0.163));
  float off = length(p.xy - vec2(0.0, 0.05));
  float rings = skinIn(off, 0.0102, 0.02) * skinIn(p.z, -0.295, -0.23);
  b = max(b, max(max(rings, 1.0 - skinOver(p.z, -0.33)), skinOver(p.y, 0.093) * skinIn(p.z, -0.085, -0.052)));
`);
FAMAS_SKINS.parkerized = FAMAS_TRIM;
FAMAS_SKINS.blued = FAMAS_TRIM;

/** Uzi: the serpent runs the receiver; ivory at the nose of the fore-end, under the grip and at the foot of the magazine. */
export const UZI_SKINS: Record<string, Skin> = {
  parkerized: lacquer("uzi-receiver", /* glsl */`
    ${serpent(0.108, -0.155, "0.04", [0.009, 0.014], [0.003, 0.009], 48)}
    float body = skinIn(p.z, -0.165, 0.152) * skinOver(p.y, 0.004);
    a = body;
    // Gilt sight ears stand over the lacquer, and a gilt band closes the receiver ahead of the butt plate.
    b = max(body * max(figure, skinIn(p.z, 0.126, 0.133)), skinOver(p.y, 0.0815));
  `),
  polymer: lacquer("uzi-polymer", /* glsl */`
    ${CLOUDS}
    float fore = 1.0 - skinOver(p.z, -0.038);
    float knob = skinOver(p.y, 0.07);
    a = 1.0 - knob;
    c = a * max(fore * (1.0 - skinOver(p.z, -0.149)), (1.0 - fore) * (1.0 - skinOver(p.y, -0.097)));
    float bands = max(fore * skinIn(p.z, -0.149, -0.142), (1.0 - fore) * max(skinIn(p.y, -0.097, -0.091), skinIn(p.y, -0.004, 0.012)));
    b = max(a * max(figure * (1.0 - c), bands), knob);
  `),
  blued: lacquer("uzi-steel", /* glsl */`
    ${CLOUDS}
    // The magazine below the grip is lacquered, with an ivory foot; the barrel nut is gilt.
    float magazine = 1.0 - skinOver(p.y, -0.1);
    a = magazine;
    c = magazine * (1.0 - skinOver(p.y, -0.226));
    b = max(magazine * max(figure * (1.0 - c), skinIn(p.y, -0.226, -0.219)), skinIn(p.z, -0.195, -0.158) * skinOver(p.y, 0.02));
  `),
};

/**
 * Desert Eagle (bore at y 0.043): the serpent runs the slide and the fixed barrel, tail at the
 * hammer and head at the muzzle; the frame is lacquer and cloud, the grips ivory, and every small
 * part — sights, trigger, hammer, safety, crown, the foot of the magazine — is gilt.
 */
export const DEAGLE_SKINS: Record<string, Skin> = {
  anodized: lacquer("deagle-slide", /* glsl */`
    ${serpent(0.04, -0.214, "0.0335", [0.0045, 0.008], [0.0022, 0.006], 62)}
    a = 1.0;
    // Gilt closes the muzzle, the front of the slide where it meets the barrel, and the slide's heel.
    float bands = max(max(1.0 - skinOver(p.z, -0.2185), skinIn(p.z, -0.0715, -0.0665)), skinIn(p.z, 0.0365, 0.0405));
    b = max(figure, bands);
  `),
  parkerized: lacquer("deagle-frame", /* glsl */`
    ${CLOUDS}
    a = 1.0;
    b = max(figure, 1.0 - skinOver(p.z, -0.2005));
  `),
  polymer: lacquer("deagle-grips", /* glsl */`
    // Ivory panels with the grain running down them, closed top and bottom with a gilt line.
    b = max(skinIn(p.y, -0.0145, -0.0115), skinIn(p.y, -0.0825, -0.0795));
    c = 1.0 - b;
    coatC *= 0.92 + 0.12 * wearNoise(vec3(p.z * 46.0, p.y * 260.0, 3.0));
  `),
  blued: GILDED,
};

// ---- The bolt-action itself: the same scheme over its own baked surfaces ------


/** Bolt-action rifle, by the model's material names. Its baked maps say which texels are timber. */
export const RIFLE_SKINS: Record<string, Skin> = {
  bolt_action_rifle_7_62: {
    key: "rifle-lacquer",
    coats: [LACQUER, GILT, IVORY],
    paint: /* glsl */`
      float timber = 1.0 - smoothstep(0.3, 0.6, metalnessFactor);
      // Lacquer over the stock, with a breath of the grain left in it.
      float figure = dot(diffuseColor.rgb, vec3(0.4, 0.5, 0.1));
      coatA *= 0.62 + figure * 1.5;
      a = timber;
      // A scaled serpent winds the length of the stock, thickening toward the butt...
      float along = clamp((p.z + 0.88) / 1.16, 0.0, 1.0);
      float mid = mix(mix(0.047, 0.008, smoothstep(-0.3, -0.1, p.z)), -0.03, smoothstep(0.05, 0.29, p.z));
      float sway = mix(0.011, 0.03, smoothstep(0.0, 0.25, p.z));
      float body = p.y - (mid + sway * sin(p.z * 46.0 + 0.6));
      float girth = mix(0.0035, 0.0125, smoothstep(0.05, 0.9, along)) * (1.0 - smoothstep(0.93, 1.0, along));
      float serpent = 1.0 - skinOver(abs(body), girth);
      float scales = skinScales(vec2(p.z * 210.0, body * 150.0));
      // ...with a crest of fins along its back, among scrolls of cloud.
      float crest = skinIn(body, girth, girth + 0.0045) * step(0.35, fract(p.z * 95.0));
      float flow = skinFlow(p * 1.3 + 4.0);
      float cloud = skinLines(flow, 7.0, 0.075) * (1.0 - skinIn(abs(body), 0.0, girth + 0.006));
      b = timber * max(max(serpent, crest), cloud);
      coatB *= mix(1.0, 0.5 + 0.6 * scales, serpent);
      // Ivory at the butt and the fore-end cap, each closed with a gilt band.
      c = timber * max(skinOver(p.z, 0.262), 1.0 - skinOver(p.z, -0.84));
      b = max(b * (1.0 - c), timber * max(skinIn(p.z, 0.254, 0.262), skinIn(p.z, -0.84, -0.833)));
      // Steel is blacked, with gilt furniture: crown and foresight, bolt handle, guard and butt plate.
      float metal = 1.0 - timber;
      diffuseColor.rgb *= mix(1.0, 0.42, metal);
      float furniture = max(max(1.0 - skinOver(p.z, -0.9), skinOver(p.x, 0.021)), max(skinOver(p.z, 0.283), (1.0 - skinOver(p.y, 0.0)) * skinIn(p.z, -0.2, 0.0)));
      b = max(b, metal * furniture);
    `,
  },
  bolt_action_rifle_7_62_accesories: {
    key: "rifle-scope",
    coats: [LACQUER, GILT, IVORY],
    paint: /* glsl */`
      // The scope: a lacquered tube, ivory toward each end, gilt rings and mount.
      float tube = skinOver(p.y, 0.089);
      a = tube;
      c = tube * max(skinIn(p.z, -0.176, -0.162), skinIn(p.z, -0.104, -0.092));
      b = max(tube * max(max(skinIn(p.z, -0.18, -0.176), skinIn(p.z, -0.162, -0.158)), max(skinIn(p.z, -0.108, -0.104), skinIn(p.z, -0.092, -0.088))), 1.0 - tube);
      b = max(b, tube * max(1.0 - skinOver(p.z, -0.184), skinOver(p.z, -0.083)));
    `,
  },
};

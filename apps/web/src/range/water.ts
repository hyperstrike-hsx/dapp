import * as THREE from "three";

// Water for every range: one set of GLSL building blocks and three ready materials.
//
//   waterMaterial(...)    open water and pools. A standard material, so the sun, its shadows, the sky probe
//                         and the fog fall on it as on everything else. On top of that it has wind waves that
//                         never alias, ripples carried by a current, rings, lapping against banks, a bed seen
//                         through the water with caustics on it, colour that deepens with depth, and foam.
//   fallMaterial(...)     falling water: chutes, weirs, jets and threads.
//   causticMaterial(...)  the light water throws back up onto walls and soffits standing over it.
//   waterMirror(...)      the banks and whatever else stands over the water, for waterMaterial to mirror.
//
// A map describes its own water to waterMaterial with a few lines of GLSL (`field`): how deep it is at a
// point, how far that point is from a bank, which way the water runs there and where it is torn white.
// Everything is worked out from world position, so nothing needs textures or a second render of the scene
// (a mirror draws its own few triangles a second time, small, and nothing else).
//
// Two rules keep moving water honest, and both are easy to break:
//   - Never multiply the clock by something that varies from place to place. A pattern drawn at
//     `position - time * speed(position)` shears a little more every second and ends up running backwards.
//     Falling water is drawn against the time since it left the lip (`wFallTime`); a current is drawn in
//     two copies half a cycle apart, each faded out before it has sheared far (`wPhase`).
//   - Never let a ripple be finer than the pixel it lands in. Every train of waves takes the pixel's
//     footprint on the water and, once too fine to draw, turns into roughness instead of noise.

/** Noise, waves, foam, caustics and optics. Every name starts with `w`. Define W_LEAN before it for the cheap forms. */
export const WATER_GLSL = /* glsl */`
  float wHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  vec2 wHash2(vec2 p) { vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  /** Noise with its slope: x is the value, yz how fast it changes along each axis. */
  vec3 wNoiseD(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0), du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    float a = wHash(i), b = wHash(i + vec2(1.0, 0.0)), c = wHash(i + vec2(0.0, 1.0)), d = wHash(i + vec2(1.0, 1.0));
    float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
    return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
  }
  float wFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += wNoise(p) * a; p = p * 2.03 + 17.3; a *= 0.5; } return s / 0.9375; }
  /** Cells: x the distance to the nearest point, y to the next. Small y - x is a cell wall. \`morph\` moves the points. */
  vec2 wCells(vec2 p, float morph) {
    vec2 i = floor(p), f = fract(p);
    float f1 = 8.0, f2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.42 * sin(morph + 6.2832 * wHash2(i + g));
      vec2 d = g + o - f;
      float dd = dot(d, d);
      if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
    }
    return sqrt(vec2(f1, f2));
  }
  /** How far a field changes per metre, from how it changes across the pixel. */
  vec2 wGradient(float f, vec2 p) {
    vec2 px = dFdx(p), py = dFdy(p);
    float fx = dFdx(f), fy = dFdy(f), det = px.x * py.y - px.y * py.x;
    return abs(det) < 1e-12 ? vec2(0.0) : vec2(fx * py.y - fy * px.y, fy * px.x - fx * py.x) / det;
  }

  // ---- Waves -----------------------------------------------------------------------------------
  /** One train of waves as a slope. Too fine for its pixel, it stops rippling and roughens the mirror instead. */
  void wTrain(vec2 p, vec2 heading, float span, float steep, float phase, float footprint, inout vec2 slope, inout float height, inout float lost) {
    float seen = 1.0 - smoothstep(0.22 * span, 0.7 * span, footprint);
    float a = dot(heading, p) * 6.2832 / span - phase;
    slope += heading * steep * seen * cos(a);
    height += steep * span * 0.159 * seen * sin(a);
    lost += (1.0 - seen * seen) * steep * steep * 0.5;
  }
  vec2 wTurn(vec2 v, float c, float s) { return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }
  /**
   * A wind sea: trains fanned about the wind, the longest \`span\` metres from crest to crest, each moving at
   * the speed water of its length really moves at (times \`rate\`). The fine ones come and go in patches, as
   * gusts cross the water. Returns the slope in xy and the height in z; \`lost\` is what could not be drawn.
   */
  vec3 wSea(vec2 p, float t, vec2 wind, float span, float steep, float rate, float footprint, out float lost) {
    vec2 slope = vec2(0.0);
    float height = 0.0;
    lost = 0.0;
    // Long trains bend a little, so no two crests run parallel for long.
    vec2 q = p + (vec2(wNoise(p * 0.55 / span + t * 0.02), wNoise(p * 0.55 / span + 31.7 - t * 0.017)) - 0.5) * span * 0.62;
    // The harbour's mirror and glitter are ruffled by these same gusts: maps/docks.ts (gustAt) repeats this line.
    float gust = smoothstep(0.32, 0.74, wNoise(p * 0.2 / span - wind * t * 0.11 + 4.0));
    float fine = steep * mix(0.42, 1.2, gust);
    float w = rate * 7.85 / sqrt(span);
    wTrain(q, wTurn(wind, 0.9394, -0.3429), span, steep * 0.55, w * t, footprint, slope, height, lost);
    wTrain(q, wTurn(wind, 0.8776, 0.4794), span * 0.61, steep * 0.75, w * 1.28 * t, footprint, slope, height, lost);
    wTrain(q, wTurn(wind, 0.9928, -0.1197), span * 0.36, steep, w * 1.67 * t, footprint, slope, height, lost);
    wTrain(q, wTurn(wind, 0.6600, 0.7513), span * 0.22, fine * 1.1, w * 2.13 * t, footprint, slope, height, lost);
    #ifndef W_LEAN
      wTrain(p, wTurn(wind, 0.7648, -0.6442), span * 0.133, fine * 1.1, w * 2.74 * t, footprint, slope, height, lost);
      wTrain(p, wTurn(wind, 0.9553, 0.2955), span * 0.082, fine, w * 3.49 * t, footprint, slope, height, lost);
      wTrain(p, wTurn(wind, 0.4536, -0.8912), span * 0.05, fine * 0.85, w * 4.47 * t, footprint, slope, height, lost);
    #endif
    return vec3(slope, height);
  }
  /** The slope of fine ripples of about \`size\` metres, for water too sheltered or too small for a sea. */
  vec2 wRipples(vec2 p, float t, float size, float footprint) {
    float seen = 1.0 - smoothstep(0.25 * size, 0.9 * size, footprint);
    if (seen <= 0.0) return vec2(0.0);
    vec3 a = wNoiseD(p / size + vec2(t * 0.31, t * 0.17)), b = wNoiseD(p * 1.9 / size - vec2(t * 0.23, t * 0.36) + 9.1);
    return (a.yz + b.yz * 0.6) * seen;
  }
  /** A ring spreading from a drop: xy where it fell, z when, w how hard. */
  vec2 wRing(vec2 p, vec4 ring, float t) {
    float age = t - ring.z;
    if (age <= 0.0 || age >= 8.0) return vec2(0.0);
    vec2 d = p - ring.xy;
    float r = length(d) + 0.001, front = age * 0.55, band = (r - front) / 0.4;
    return (d / r) * cos((r - front) * 15.0) * exp(-band * band) * ring.w * (1.0 - age / 8.0) / (1.0 + front * 1.4);
  }
  /** Rings that never stop, round where a jet or a fall lands: xy where, z how hard, w how far they carry (metres). */
  vec2 wSource(vec2 p, vec4 source, float t) {
    vec2 d = p - source.xy;
    float r = length(d) + 0.001;
    return (d / r) * sin(r * 30.0 / sqrt(source.w) - t * 7.5) * exp(-r * 2.4 / source.w) * source.z;
  }

  // ---- Currents and falls ------------------------------------------------------------------------
  /**
   * For drawing something carried by a current. x and y are how many seconds to carry the first and the
   * second copy (take the pattern at \`p - flow * seconds\`), z the share of the first. Each copy runs for
   * \`period\` seconds and is faded out while it is put back, so the pattern keeps its shape for ever.
   */
  vec3 wPhase(vec2 p, float t, float period) {
    float a = fract(t / period + wNoise(p * 0.11) * 0.7), b = fract(a + 0.5);
    return vec3((a - 0.5) * period, (b - 0.5) * period, 1.0 - abs(2.0 * a - 1.0));
  }
  /** Seconds since water \`along\` metres down a fall left the lip, at \`speed\` m/s there and gaining \`gain\` m/s every second. */
  float wFallTime(float along, float speed, float gain) {
    return gain > 0.001 ? (sqrt(speed * speed + 2.0 * gain * along) - speed) / gain : along / speed;
  }

  // ---- Foam and caustics --------------------------------------------------------------------------
  /** Foam as it lies on water, as a height: clots, strings of bubbles between them, pin-holes where it is thick. */
  float wFoamBody(vec2 p) {
    // Curled, so that no wall of a cell runs straight.
    vec2 q = p + (vec2(wNoise(p * 0.83 + 1.7), wNoise(p * 0.83 + 9.2)) - 0.5) * 1.5;
    float clots = wNoise(q * 0.31 + 3.7) * 0.6 + wNoise(q * 0.97 + 5.3) * 0.4;
    vec2 a = wCells(q * 0.8, 0.0);
    float strings = 1.0 - smoothstep(0.0, 0.42, a.y - a.x + (wNoise(q * 2.7) - 0.5) * 0.3);
    #ifndef W_LEAN
      vec2 b = wCells(q * 2.6 + 11.7, 0.0);
      strings = max(strings, (1.0 - smoothstep(0.0, 0.5, b.y - b.x)) * 0.7);
      float holes = 1.0 - smoothstep(0.0, 0.34, b.x);
    #else
      float holes = 1.0 - smoothstep(0.0, 0.3, a.x);
    #endif
    return clamp(clots * 0.74 + strings * 0.34 - holes * 0.16, 0.0, 1.0);
  }
  /** How much of the water the foam covers where its height is \`body\`: \`amount\` 0 is none, 1 solid white. */
  float wFoamCover(float body, float amount) {
    float line = 1.0 - amount * 1.12;
    return smoothstep(line - 0.07, line + 0.1, body) * smoothstep(0.0, 0.08, amount);
  }
  /**
   * Foam carried along by a current of \`flow\` m/s; \`size\` is the width of a bubble cell in metres.
   * x is how much of the water it covers, y how thick it lies there (for shading it).
   */
  vec2 wFoam(vec2 p, vec2 flow, float t, float size, float amount) {
    if (amount <= 0.004) return vec2(0.0);
    vec3 phase = wPhase(p, t, 3.4);
    // Drawn out along the current, the faster the longer.
    float speed = length(flow);
    vec2 along = speed > 0.001 ? flow / speed : vec2(1.0, 0.0), across = vec2(-along.y, along.x);
    float draw = mix(1.0, 0.36, smoothstep(0.3, 4.0, speed));
    vec2 qa = p - flow * phase.x, qb = p - flow * phase.y;
    float a = wFoamBody(vec2(dot(qa, along) * draw, dot(qa, across)) / size), b = wFoamBody(vec2(dot(qb, along) * draw, dot(qb, across)) / size + 19.3);
    // Blended as heights and cut afterwards, so the edge of the foam stays crisp through the change-over.
    float body = mix(b, a, phase.z);
    return vec2(wFoamCover(body, amount), body);
  }
  /**
   * Light gathered into a net of bright lines by the waves above it: 0 in the dark of a mesh, about 1 on a
   * line, more where lines meet. The net is bent twice over so that none of it runs straight, and its lines
   * swell and thin from place to place as real ones do.
   */
  float wCaustic(vec2 p, float t) {
    vec2 q = p + (vec2(wNoise(p * 0.7 + t * 0.13), wNoise(p * 0.7 + 5.2 - t * 0.11)) - 0.5) * 1.1;
    vec2 bend = vec2(wNoise(q * 2.1 + 3.0 + t * 0.19), wNoise(q * 2.1 + 8.2 - t * 0.16)) - 0.5;
    float wide = 0.07 + 0.24 * wNoise(p * 0.8 + 3.0 - t * 0.07);
    vec2 a = wCells(q * 1.1 + bend * 0.38, t * 1.1);
    float net = 1.0 - smoothstep(0.0, wide, a.y - a.x);
    net *= sqrt(net) * (0.45 + 0.9 * a.x);
    #ifndef W_LEAN
      vec2 b = wCells(q.yx * 2.1 - bend * 0.5 + 4.1, t * 1.5 + 2.0);
      float fine = 1.0 - smoothstep(0.0, wide * 1.2, b.y - b.x);
      fine *= sqrt(fine) * (0.45 + 0.9 * b.x);
      net = net * 0.85 + fine * 0.4 + net * fine * 0.8;
    #endif
    return net;
  }

  // ---- Optics --------------------------------------------------------------------------------------
  /** The share of light a water surface mirrors, by the cosine of the angle it is seen at. */
  float wFresnel(float cosine) { return 0.02 + 0.98 * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0); }
  /** What is left of light after \`run\` metres of water in which \`clarity\` metres leave about a third: red goes first. */
  vec3 wThrough(float run, float clarity) { return exp(-run / (clarity * vec3(0.42, 1.0, 0.82))); }
  /** A sharp glint of the sun off a surface of the given roughness. */
  float wGlint(vec3 normal, vec3 toEye, vec3 toSun, float rough) {
    float d = max(dot(normal, normalize(toEye + toSun)), 0.0), a = max(rough * rough, 0.0004);
    float k = d * d * (a * a - 1.0) + 1.0;
    return a * a / (3.14159 * k * k);
  }
`;

const glsl = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(+value.toFixed(5)));

/**
 * Field GLSL for water lying in a basin: a round or oval pool of radii `rx`, `rz` about (`x`, `z`), `depth`
 * metres deep in the middle and shelving up to its rim.
 */
export function basinField(x: number, z: number, rx: number, rz: number, depth: number) {
  return /* glsl */`
    void wField(vec2 p, float t, out float depth, out float shore, out vec2 flow, out float churn) {
      vec2 d = (p - vec2(${glsl(x)}, ${glsl(z)})) / vec2(${glsl(rx)}, ${glsl(rz)});
      shore = max(1.0 - length(d), 0.0) * ${glsl(Math.min(rx, rz))};
      depth = ${glsl(depth)} * (0.45 + 0.55 * smoothstep(0.0, ${glsl(Math.min(rx, rz) * 0.6)}, shore));
      flow = vec2(0.0);
      churn = 0.0;
    }
  `;
}
/** Field GLSL for water in a straight-sided trough or tank between (`x0`, `z0`) and (`x1`, `z1`). */
export function troughField(x0: number, z0: number, x1: number, z1: number, depth: number) {
  return /* glsl */`
    void wField(vec2 p, float t, out float depth, out float shore, out vec2 flow, out float churn) {
      shore = max(min(min(p.x - ${glsl(Math.min(x0, x1))}, ${glsl(Math.max(x0, x1))} - p.x), min(p.y - ${glsl(Math.min(z0, z1))}, ${glsl(Math.max(z0, z1))} - p.y)), 0.0);
      depth = ${glsl(depth)};
      flow = vec2(0.0);
      churn = 0.0;
    }
  `;
}
const OPEN_FIELD = /* glsl */`
  void wField(vec2 p, float t, out float depth, out float shore, out vec2 flow, out float churn) {
    depth = waterDepth; shore = 1e3; flow = vec2(0.0); churn = 0.0;
  }
`;

export type WaterOptions = {
  /** Seconds, advanced by the map. */
  time: { value: number };
  /**
   * GLSL defining `void wField(vec2 p, float t, out float depth, out float shore, out vec2 flow, out float churn)`
   * for a point `p` (world x, z): depth of water in metres, distance to the nearest bank or thing standing in the
   * water, the current in m/s, and 0..1 how torn the water is there (white water). It may use everything in
   * WATER_GLSL and the uniforms listed in `uniforms`. Left out, the water is open and `depth` deep everywhere.
   */
  field?: string;
  /** Uniforms the field reads, declared for it: name to GLSL type and value. */
  uniforms?: Record<string, { type: string; value: unknown }>;
  /** Depth in metres where no field is given (default 3). */
  depth?: number;
  /** Which way the waves travel on the ground, as [x, z] (default [0.34, -0.94]). */
  wind?: [number, number];
  /** Crest to crest of the longest waves in metres (default 2.7), and how steep they are (default 0.034; 0 for none). */
  span?: number;
  steep?: number;
  /** Speed of the waves against the real thing (default 0.55: calmer than life reads better at a glance). */
  rate?: number;
  /** Fine ripples everywhere: their size in metres (default 0.35) and strength (default 0.03; 0 for none). */
  rippleSize?: number;
  ripple?: number;
  /** How hard a current wrinkles the surface (default 0.07), where the field gives one. */
  flowRipple?: number;
  /** Wavelets thrown back by banks and things standing in the water (default 0.03; 0 for none). */
  lap?: number;
  /** The colour deep water sends back (default a dark canal green). */
  deep?: THREE.ColorRepresentation;
  /** The colour of the bed where it shows through (default silt). */
  bed?: THREE.ColorRepresentation;
  /** Size in metres of the stones and patches on the bed (default 0.45). */
  bedGrain?: number;
  /** Metres of water that leave about a third of the light (default 1.4: murky; 6 or more is clear). */
  clarity?: number;
  /** How bright the net of light on the bed is (default 0.9; 0 for none) and the size of its meshes in metres (default 0.5). */
  caustics?: number;
  causticSize?: number;
  foam?: THREE.ColorRepresentation;
  /** Foam against the banks: how far out it reaches in metres (default 0.5) and how much (default 0.5; 0 for none). */
  shoreReach?: number;
  shoreFoam?: number;
  /** Old foam lying about in drifting patches, 0..1 (default 0). */
  driftFoam?: number;
  /** Width of a bubble cell in the foam, metres (default 0.3). */
  foamSize?: number;
  /** Mirror quality: 0.03 is glass (default 0.06). */
  roughness?: number;
  /** The brightest the sun's glint on the water may be, against a sunlit white wall at about 1 (default 2.5). */
  glare?: number;
  envMapIntensity?: number;
  /** Rings from drops, started by the map: xy where, z when (seconds), w how hard. */
  rings?: { value: THREE.Vector4[] };
  /** Rings that never stop: xy where, z how hard, w how far they carry. */
  sources?: THREE.Vector4[];
  /** The way to the sun and its colour, for light coming through the backs of waves (left out: none). */
  toSun?: THREE.Vector3;
  sunColour?: THREE.ColorRepresentation;
  /**
   * Extra GLSL run last in the fragment's water block; it may change `diffuseColor`, `roughnessFactor`, `normal`
   * and `totalEmissiveRadiance`. It may read, and must not declare again: `p` (world x, z), `t`, `footprint`,
   * `depth`, `shore`, `flow`, `speed`, `churn`, `slope`, `height`, `wNormal`, `toEye`, `bedAt`, `body`, `foam`.
   */
  finish?: string;
  /** What stands over the water, mirrored in it and broken up by its waves (see waterMirror). Left out, it mirrors the sky alone. */
  mirror?: WaterMirror;
  /** Cheaper forms throughout: fewer wave trains, one scale of foam and caustics. For PERFORMANCE quality. */
  lean?: boolean;
  /** Tells apart two waters with different fields or options in one map (default "water"). */
  key?: string;
};

/**
 * Water as a standard material. Lay it on any flat geometry facing up; it works in world space, so the
 * mesh may be any shape and size. Returns the material with its uniforms on `userData.water`.
 */
export function waterMaterial(options: WaterOptions) {
  const wind = new THREE.Vector2(...(options.wind ?? [0.34, -0.94])).normalize();
  const rings = options.rings ?? { value: [] };
  const sources = options.sources ?? [];
  const uniforms: Record<string, { value: unknown }> = {
    waterTime: options.time,
    waterDepth: { value: options.depth ?? 3 },
    waterWind: { value: wind },
    // span, steepness, rate, ripple size
    waterSea: { value: new THREE.Vector4(options.span ?? 2.7, options.steep ?? 0.034, options.rate ?? 0.55, options.rippleSize ?? 0.35) },
    // fine ripple, flow ripple, lapping, roughness
    waterSkin: { value: new THREE.Vector4(options.ripple ?? 0.03, options.flowRipple ?? 0.07, options.lap ?? 0.03, options.roughness ?? 0.06) },
    waterDeep: { value: new THREE.Color(options.deep ?? 0x0a1a14) },
    waterBed: { value: new THREE.Color(options.bed ?? 0x6b6a55) },
    // clarity, caustic strength, caustic size, bed grain
    waterBody: { value: new THREE.Vector4(options.clarity ?? 1.4, options.caustics ?? 0.9, options.causticSize ?? 0.5, options.bedGrain ?? 0.45) },
    waterFoam: { value: new THREE.Color(options.foam ?? 0xbdc4c4) },
    // shore reach, shore amount, drifting foam, cell size
    waterFoaming: { value: new THREE.Vector4(options.shoreReach ?? 0.5, options.shoreFoam ?? 0.5, options.driftFoam ?? 0, options.foamSize ?? 0.3) },
    waterSun: { value: options.toSun ? options.toSun.clone().normalize() : new THREE.Vector3(0, 1, 0) },
    waterSunColour: { value: new THREE.Color(options.toSun ? options.sunColour ?? 0xffffff : 0x000000) },
    waterGlare: { value: options.glare ?? 2.5 },
  };
  if (options.mirror) { uniforms.waterMirror = options.mirror.picture; uniforms.waterMirrorLens = options.mirror.lens; }
  if (rings.value.length) uniforms.waterRings = rings;
  if (sources.length) uniforms.waterSources = { value: sources };
  for (const [name, { value }] of Object.entries(options.uniforms ?? {})) uniforms[name] = { value };
  const declared = Object.entries(options.uniforms ?? {}).map(([name, { type }]) => `uniform ${type} ${name};`).join("\n");

  const pars = /* glsl */`
    ${options.lean ? "#define W_LEAN" : ""}
    varying vec3 vWaterWorld;
    uniform float waterTime;
    uniform float waterDepth;
    uniform vec2 waterWind;
    uniform vec4 waterSea;
    uniform vec4 waterSkin;
    uniform vec3 waterDeep;
    uniform vec3 waterBed;
    uniform vec4 waterBody;
    uniform vec3 waterFoam;
    uniform vec4 waterFoaming;
    uniform vec3 waterSun;
    uniform vec3 waterSunColour;
    uniform float waterGlare;
    ${rings.value.length ? `uniform vec4 waterRings[${rings.value.length}];` : ""}
    ${sources.length ? `uniform vec4 waterSources[${sources.length}];` : ""}
    ${declared}
    ${WATER_GLSL}
    ${options.field ?? OPEN_FIELD}
    // What the water mirrors besides the sky: rgb the light, a how much of the sky it stands in front of.
    vec4 wMirrored = vec4(0.0);
    ${options.mirror ? MIRROR_GLSL : ""}
  `;
  const body = /* glsl */`
  {
    vec2 p = vWaterWorld.xz;
    float t = waterTime;
    float footprint = max(length(dFdx(p)), length(dFdy(p)));
    float depth, shore, churn;
    vec2 flow;
    wField(p, t, depth, shore, flow, churn);
    float speed = length(flow);

    // ---- The surface: wind waves, fine ripples, what the current carries, rings, lapping -------------
    vec2 slope = vec2(0.0);
    float height = 0.0, lost = 0.0;
    if (waterSea.y > 0.0) {
      vec3 sea = wSea(p, t, waterWind, waterSea.x, waterSea.y, waterSea.z, footprint, lost);
      slope += sea.xy;
      height += sea.z;
    }
    if (waterSkin.x > 0.0) slope += wRipples(p, t, waterSea.w, footprint) * waterSkin.x;
    vec3 phase = wPhase(p, t, 3.4);
    if (speed > 0.02) {
      // Wrinkles drawn out along the current, and boils where it is torn.
      float size = 0.5 + speed * 0.12, seen = 1.0 - smoothstep(0.25 * size, 0.9 * size, footprint);
      vec2 along = flow / speed, across = vec2(-along.y, along.x);
      vec2 a = p - flow * phase.x, b = p - flow * phase.y + 13.7;
      vec2 ua = vec2(dot(a, along) * 0.45, dot(a, across) * 1.6) / size, ub = vec2(dot(b, along) * 0.45, dot(b, across) * 1.6) / size;
      vec3 na = wNoiseD(ua) + 0.5 * wNoiseD(ua * 2.3 + 5.1), nb = wNoiseD(ub) + 0.5 * wNoiseD(ub * 2.3 + 5.1);
      vec2 g = mix(nb.yz, na.yz, phase.z);
      float hard = waterSkin.y * min(0.35 + speed * 0.3, 1.6) * (1.0 + churn * 1.5) * seen;
      slope += (along * g.x * 0.45 + across * g.y * 1.6) * hard;
      lost += (1.0 - seen) * hard * hard * 0.4;
      height += (mix(nb.x, na.x, phase.z) - 0.75) * hard * 0.3;
    }
    ${rings.value.length ? `for (int i = 0; i < ${rings.value.length}; i++) slope += wRing(p, waterRings[i], t);` : ""}
    ${sources.length ? `for (int i = 0; i < ${sources.length}; i++) slope += wSource(p, waterSources[i], t);` : ""}
    // Wavelets a bank throws back: they leave it square on and die within a few metres.
    vec2 off = wGradient(min(shore, 8.0), p);
    if (waterSkin.z > 0.0 && shore < 6.0) {
      float ln = length(off);
      if (ln > 0.01) {
        float seen = 1.0 - smoothstep(0.15, 0.5, footprint);
        slope += (off / ln) * cos(shore * 8.5 - t * 2.6 + wNoise(p * 0.8) * 5.0) * exp(-shore * 1.25) * waterSkin.z * seen;
      }
    }
    vec3 wNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
    normal = normalize((viewMatrix * vec4(wNormal, 0.0)).xyz);

    // ---- The body: the bed seen through the water, and the water's own colour where it is deep --------
    vec3 toEye = normalize(cameraPosition - vWaterWorld);
    vec3 into = refract(-toEye, wNormal, 0.75);
    float run = depth / max(-into.y, 0.25);
    vec2 bedAt = p + into.xz * run;
    float grain = wNoise(bedAt / waterBody.w) * 0.55 + wNoise(bedAt * 3.1 / waterBody.w + 8.0) * 0.3 + wNoise(bedAt * 0.23 / waterBody.w) * 0.15;
    vec3 bed = waterBed * (0.5 + grain);
    #ifndef W_LEAN
      if (waterBody.y > 0.0) bed *= 1.0 + wCaustic(bedAt / waterBody.z, t) * waterBody.y * exp(-depth * 0.5 / waterBody.x);
    #endif
    vec3 body = mix(waterDeep, bed, wThrough(run + depth, waterBody.x));

    // ---- Foam: against the banks, where the water is torn, and old foam drifting ----------------------
    float lapping = 0.6 + 0.4 * sin(t * 1.1 + wNoise(p * 0.35) * 6.2832);
    float amount = churn + waterFoaming.y * exp(-shore / max(waterFoaming.x, 0.01) * (1.6 - 0.8 * lapping)) * lapping;
    amount += waterFoaming.z * smoothstep(0.52, 0.8, wNoise((p - flow * phase.x) * 0.16 + 2.0) * phase.z + wNoise((p - flow * phase.y) * 0.16 + 9.0) * (1.0 - phase.z));
    vec2 drift = speed > 0.02 ? flow : waterWind * 0.06;
    float foamSeen = 1.0 - smoothstep(0.6 * waterFoaming.w, 2.4 * waterFoaming.w, footprint);
    vec2 froth = wFoam(p, drift, t, waterFoaming.w, clamp(amount, 0.0, 1.0));
    float foam = mix(clamp(amount * 0.75, 0.0, 1.0), froth.x, foamSeen);
    // Thick foam is whiter than thin: it keeps its grain even in full sun.
    diffuseColor.rgb = mix(body, waterFoam * mix(0.86, 0.5 + 0.95 * froth.y, foamSeen), foam);
    roughnessFactor = clamp(mix(waterSkin.w + sqrt(lost) * 1.5, 0.9, foam), 0.0, 1.0);

    // Sun coming through the backs of the waves toward the eye.
    float glow = pow(clamp(dot(toEye, -normalize(waterSun + wNormal * 0.45)), 0.0, 1.0), 3.0) * clamp(0.35 + height * 9.0 + length(slope) * 2.5, 0.0, 1.0);
    totalEmissiveRadiance += waterSunColour * mix(waterDeep, vec3(0.1, 0.3, 0.22), 0.5) * glow * (1.0 - foam) * 0.6;
    ${options.finish ?? ""}
    ${options.mirror ? "wMirrored = wMirror(-toEye, slope, sqrt(lost)) * vec2(1.0, 1.0 - smoothstep(0.3, 0.7, roughnessFactor)).xxxy;" : ""}
  }
  `;
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: options.roughness ?? 0.06, metalness: 0, envMapIntensity: options.envMapIntensity ?? 1.15 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWaterWorld;${options.mirror ? "\nvarying vec4 vWaterClip;" : ""}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;${options.mirror ? "\nvWaterClip = gl_Position;" : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${pars}`)
      .replace("#include <normal_fragment_maps>", body)
      // Where a bank stands in front of the sky, it is the bank the water mirrors: same angle, same share of the light.
      .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>${options.mirror ? "\nradiance = mix(radiance, wMirrored.rgb, wMirrored.a);" : ""}`)
      // The sun's glint is kept, but not let grow into a white sheet when the bloom gets hold of it.
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\nreflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(waterGlare));");
  };
  const key = `water:${options.key ?? "water"}:${options.lean ? 1 : 0}:${rings.value.length}:${sources.length}:${options.mirror ? 1 : 0}`;
  material.customProgramCacheKey = () => key;
  material.userData.water = uniforms;
  return material;
}

/** How the water material reads a mirror's picture. Needs `toEye`'s world, the view matrix and the clip position. */
const MIRROR_GLSL = /* glsl */`
  uniform sampler2D waterMirror;
  // x, y: the lens (the camera's projection scale); z: how hard waves bend the picture, 1 as in life; w: how bright it is.
  uniform vec4 waterMirrorLens;
  varying vec4 vWaterClip;
  /**
   * Where in the picture to look from water sloping by \`slope\`, seen along \`ray\` (eye to water). The slope
   * turns the mirrored ray: up for a face tilted toward the eye, a little sideways for one tilted across. In
   * a flat mirror that is the eye's own ray turned the other way up, and less for what stands close behind
   * the water than for what is far beyond it (\`beyond\`: the share of the light's path that lies past the water).
   */
  vec2 wMirrorAt(vec2 at, vec3 ray, vec2 slope, float beyond) {
    vec3 turned = vec3(2.0 * ray.y * slope.x, -2.0 * dot(ray.xz, slope), 2.0 * ray.y * slope.y) * beyond * waterMirrorLens.z;
    vec3 was = mat3(viewMatrix) * ray, now = mat3(viewMatrix) * (ray + turned);
    return at + (now.xy / max(-now.z, 0.05) - was.xy / max(-was.z, 0.05)) * waterMirrorLens.xy * 0.5;
  }
  /** The picture as this water shows it: bent by the waves it has (\`slope\`), smeared by those too fine to draw (\`rough\`). */
  vec4 wMirror(vec3 ray, vec2 slope, float rough) {
    vec2 at = vWaterClip.xy / vWaterClip.w * 0.5 + 0.5;
    vec4 plain = texture2D(waterMirror, at);
    // Nothing there: sky. A wave may still bring a roof into it, and roofs are far.
    float beyond = mix(0.8, clamp((plain.a - 0.25) / 0.75, 0.0, 1.0), clamp(plain.a * 4.0, 0.0, 1.0));
    // Waves too fine to see tilt every way at once: mostly they draw the picture out toward the eye.
    vec2 ahead = normalize(ray.xz + vec2(1e-5, 0.0)) * rough;
    vec2 from = wMirrorAt(at, ray, slope - ahead * 0.9, beyond), to = wMirrorAt(at, ray, slope + ahead * 0.9, beyond);
    vec2 texels = vec2(textureSize(waterMirror, 0));
    #ifdef W_LEAN
      const int TAPS = 2;
    #else
      const int TAPS = 5;
    #endif
    float fine = log2(max(length((to - from) * texels) / float(TAPS), 1.0));
    vec4 sum = vec4(0.0);
    for (int i = 0; i < TAPS; i++) {
      vec4 tap = textureLod(waterMirror, mix(from, to, (float(i) + 0.5) / float(TAPS)), fine);
      float there = clamp(tap.a * 4.0, 0.0, 1.0);
      sum += vec4(tap.rgb * there, there);
    }
    return vec4(sum.rgb / max(sum.a, 0.001) * waterMirrorLens.w, sum.a / float(TAPS));
  }
`;

export type MirrorOptions = {
  /** Height of the water. */
  level: number;
  /** The way to the sun, the colour of its light, and of the light in the shade. */
  toSun: THREE.Vector3;
  light: THREE.Color;
  shade: THREE.Color;
  /** The picture's size against the screen's (default 0.5). */
  scale?: number;
  /** How hard waves bend the picture: 1 as in life (default), less for a calmer mirror. */
  bend?: number;
  /** How bright the mirrored things are against the things themselves (default 1). Shaded banks mirrored in lit water read better a little over. */
  gain?: number;
};
export type WaterMirror = {
  picture: { value: THREE.Texture };
  lens: { value: THREE.Vector4 };
  /** What to mirror, as one geometry in world space with `color` and `normal`. Its triangles are drawn in order: farthest first. */
  show: (geometry: THREE.BufferGeometry) => void;
  /** The air between: the fog's colour and density (FogExp2). */
  haze: (colour: THREE.Color, density: number) => void;
  /** Draws the picture for a camera. Call before the frame that camera draws. */
  render: (renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) => void;
  dispose: () => void;
};

/**
 * A picture of what stands over a sheet of water, as the eye sees it in a flat mirror. Each vertex is slid
 * along the line from the eye to its mirror image until it lies on the water, so the picture is right from
 * wherever the camera is, and it costs one small draw of those triangles and no second view of the scene.
 * The water material bends and smears it with its own waves, and gives it the share of the light that water
 * mirrors at that angle, in place of the sky's.
 *
 * Alpha says what is there: 0 nothing (sky), otherwise 0.25 plus 0.75 times the share of the light's path
 * that lies beyond the water, which is how far a wave can throw that part of the picture about.
 */
export function waterMirror(options: MirrorOptions): WaterMirror {
  const level = glsl(options.level);
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const lens = { value: new THREE.Vector4(1, 1, options.bend ?? 1, options.gain ?? 1) };
  const hazeUniform = { value: new THREE.Vector4(1, 1, 1, 0) }, hazeColour = new THREE.Color(1, 1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { mirrorSun: { value: options.toSun.clone().normalize() }, mirrorLight: { value: options.light }, mirrorShade: { value: options.shade }, mirrorHaze: hazeUniform },
    vertexColors: true,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    vertexShader: /* glsl */`
      uniform vec3 mirrorSun;
      uniform vec3 mirrorLight;
      uniform vec3 mirrorShade;
      varying vec3 vColour;
      varying vec2 vPlane;
      varying float vSlid;
      void main() {
        float lift = max(position.y - ${level}, 0.0);
        float eye = max(cameraPosition.y - ${level}, 0.4);
        // How far along the line to its image the vertex stops. Unlike the image's height or its distance,
        // this runs straight across a flattened triangle, so the rest is worked out from it per pixel: a
        // quay wall is one piece a hundred metres long, and anything taken at its corners is wrong between.
        float slid = eye / (eye + lift);
        vec2 p = mix(cameraPosition.xz, position.xz, slid);
        vColour = color * (mirrorShade + mirrorLight * max(dot(normal, mirrorSun), 0.0));
        vPlane = p;
        vSlid = slid;
        gl_Position = projectionMatrix * viewMatrix * vec4(p.x, ${level}, p.y, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec4 mirrorHaze;
      varying vec3 vColour;
      varying vec2 vPlane;
      varying float vSlid;
      void main() {
        float eye = max(cameraPosition.y - ${level}, 0.4), away = length(vPlane - cameraPosition.xz), slid = max(vSlid, 0.02);
        // Haze over the whole path the light takes: down to the water and on to the thing mirrored.
        float path = sqrt(eye * eye + away * away) / slid;
        gl_FragColor = vec4(mix(vColour, mirrorHaze.rgb, 1.0 - exp(-mirrorHaze.a * mirrorHaze.a * path * path)), 1.0 - 0.75 * slid);
      }
    `,
  });
  const scene = new THREE.Scene(), size = new THREE.Vector2(), was = new THREE.Color();
  let mesh: THREE.Mesh | null = null;
  return {
    picture: { value: target.texture },
    lens,
    show(geometry) {
      if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
      mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
    },
    haze(colour, density) { hazeColour.copy(colour); hazeUniform.value.set(colour.r, colour.g, colour.b, density); },
    render(renderer, camera) {
      renderer.getDrawingBufferSize(size).multiplyScalar(options.scale ?? 0.5).ceil();
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      lens.value.x = camera.projectionMatrix.elements[0];
      lens.value.y = camera.projectionMatrix.elements[5];
      const current = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
      renderer.getClearColor(was);
      renderer.setRenderTarget(target);
      // Where nothing is mirrored the picture is the air's own colour, so the soft edge of a roof fades into it.
      renderer.setClearColor(hazeColour, 0);
      renderer.clear(true, false, false);
      if (mesh) renderer.render(scene, camera);
      renderer.setClearColor(was, alpha);
      renderer.setRenderTarget(current);
    },
    dispose() { target.dispose(); material.dispose(); mesh?.geometry.dispose(); },
  };
}

export type FallOptions = {
  time: { value: number };
  /** Metres across (default 1). The geometry's uv.x runs 0..1 across the fall and uv.y is metres down it from the lip. */
  width?: number;
  /** Speed at the lip in m/s (default 2) and how much it gains every second (default 7: a steep face; 9.8 is free fall). */
  speed?: number;
  gain?: number;
  /** Metres from the lip at which the glassy sheet starts to break, and over how many it turns white (default 0.6 and 3). */
  glass?: number;
  breakup?: number;
  /** Width in metres of the strands the white water is drawn out into (default 0.45). */
  strand?: number;
  /** Colours of the unbroken sheet, of white water in the light and of white water in its own shadow. */
  sheet?: THREE.ColorRepresentation;
  white?: THREE.ColorRepresentation;
  shade?: THREE.ColorRepresentation;
  /** Overall brightness against the scene's exposure (default 1). */
  gain2?: number;
  /** How solid the fall is, 0..1 (default 1), and how much of each edge is ragged, as a share of the width (default 0.07; 0 for a tube). */
  opacity?: number;
  edge?: number;
  /** A round jet or thread instead of a sheet: uv.x runs round it, and it is shaded as a rod of water. */
  round?: boolean;
  /** Takes the scene's fog (default true). */
  fog?: boolean;
  lean?: boolean;
};

/**
 * Falling water. Patterns are drawn against the time since the water left the lip, so each moves at the
 * speed of the water where it is, is drawn out as the water gathers speed, and can never run backwards.
 */
export function fallMaterial(options: FallOptions) {
  const fog = options.fog ?? true;
  const uniforms: Record<string, { value: unknown }> = {
    ...(fog ? THREE.UniformsUtils.clone(THREE.UniformsLib.fog) : {}),
    time: options.time,
    // width, speed, gain, strand
    fallRun: { value: new THREE.Vector4(options.width ?? 1, options.speed ?? 2, options.gain ?? 7, options.strand ?? 0.45) },
    // glass, breakup, opacity, edge
    fallForm: { value: new THREE.Vector4(options.glass ?? 0.6, options.breakup ?? 3, options.opacity ?? 1, options.edge ?? 0.07) },
    fallSheet: { value: new THREE.Color(options.sheet ?? 0x1f4a48) },
    fallWhite: { value: new THREE.Color(options.white ?? 0xffffff).multiplyScalar(options.gain2 ?? 1) },
    fallShade: { value: new THREE.Color(options.shade ?? 0x8fa3b4).multiplyScalar(options.gain2 ?? 1) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog,
    transparent: true,
    depthWrite: false,
    side: options.round ? THREE.FrontSide : THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      varying vec3 vFallNormal;
      varying vec3 vFallView;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vFallNormal = normalMatrix * normal;
        vFallView = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      ${options.lean ? "#define W_LEAN" : ""}
      ${options.round ? "#define FALL_ROUND" : ""}
      #include <common>
      #include <fog_pars_fragment>
      uniform float time;
      uniform vec4 fallRun;
      uniform vec4 fallForm;
      uniform vec3 fallSheet;
      uniform vec3 fallWhite;
      uniform vec3 fallShade;
      varying vec2 vUv;
      varying vec3 vFallNormal;
      varying vec3 vFallView;
      ${WATER_GLSL}
      void main() {
        float along = max(vUv.y, 0.0), x = vUv.x * fallRun.x;
        // Everything below is drawn against \`run\`, which stays the same for a drop of water all the way down.
        float since = wFallTime(along, fallRun.y, fallRun.z);
        float run = since - time;
        float s = fallRun.w;
        // Strands the sheet is combed into, filaments within them, and the rolls and clots that ride down: it is
        // these, a few metres long and going by, that show from far off how fast the water is falling.
        float strands = wFbm(vec2(x / s, run * 1.15));
        float threads = 1.0 - abs(2.0 * wNoise(vec2(x * 2.1 / s + strands * 1.4, run * 2.4)) - 1.0);
        float rolls = wNoise(vec2(x * 0.16 / s + 3.0, run * 3.3));
        float clots = wNoise(vec2(x * 1.5 / s + strands * 0.8, run * 6.5));
        float grain = wNoise(vec2(x * 4.3 / s, run * 21.0));
        float water = 0.3 * strands + 0.2 * threads * threads + 0.24 * rolls + 0.16 * clots + 0.1 * grain;
        // Where the sheet breaks: lower down where it is thick, at once where it is thin.
        float white = smoothstep(0.0, 1.0, (along - fallForm.x + (strands - 0.5) * fallForm.y * 0.9) / max(fallForm.y, 0.01));
        // Unbroken water: dark, a little of the sky in it, brighter where it thickens over a roll.
        vec3 glass = fallSheet * (0.55 + 1.3 * strands + 0.5 * rolls) + fallWhite * 0.16 * smoothstep(0.55, 0.9, clots);
        // White water: lit strands with blue-grey between them, and a relief from one strand to the next.
        float relief = wFbm(vec2((x + 0.22 * s) / s, run * 1.15)) - strands;
        float lit = smoothstep(0.3, 0.62, water) + relief * 1.6;
        vec3 torn = mix(fallShade, fallWhite, clamp(lit, 0.0, 1.0)) * (0.88 + 0.24 * grain);
        vec3 colour = mix(glass, torn, white);
        float alpha = mix(0.82, 1.0, white);
        // Thin places in the white water let what is behind it show.
        alpha *= 1.0 - 0.55 * white * smoothstep(0.5, 0.3, water);
        #ifdef FALL_ROUND
          // A rod of water: bright down its middle, dark at its rims, the way it bends what is behind it.
          float facing = abs(normalize(vFallNormal).z);
          colour *= 0.55 + 0.75 * facing * facing;
          alpha *= 0.55 + 0.45 * facing;
        #else
          // Ragged edges, thin enough near them for what is behind to show.
          float edge = min(vUv.x, 1.0 - vUv.x);
          alpha *= smoothstep(0.0, fallForm.w * (0.6 + 1.1 * clots) + 0.0001, edge + (strands - 0.5) * fallForm.w * 0.8);
        #endif
        gl_FragColor = vec4(colour, alpha * fallForm.z);
        #include <fog_fragment>
      }
    `,
  });
  return material;
}

export type CausticOptions = {
  time: { value: number };
  /** Height of the water the light comes off, and how many metres above it the light still reaches (default 3). */
  level: number;
  reach?: number;
  /** Colour and strength of the light (default a warm white at 0.5). */
  colour?: THREE.ColorRepresentation;
  strength?: number;
  /** Size of the meshes of the net in metres (default 0.7). */
  size?: number;
  /**
   * GLSL defining `float wLit(vec2 p)`: the share of the light that leaves the water at `p` (world x, z), for
   * water that lies partly in shadow. It may use everything in WATER_GLSL. Left out, all of it is lit.
   */
  lit?: string;
  /** The geometry carries a float attribute `share`: how much of the light each corner takes, to fade it out along or up a wall. */
  share?: boolean;
  lean?: boolean;
};

/**
 * Light thrown up by water onto what stands over it: the moving net seen on a quay wall or under a bridge.
 * Put it on geometry laid a hair proud of the lit surfaces; it only adds light. Soffits (faces looking down)
 * are lit in plan, walls along their length.
 */
export function causticMaterial(options: CausticOptions) {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: options.time,
      // level, reach, size, strength
      causticForm: { value: new THREE.Vector4(options.level, options.reach ?? 3, options.size ?? 0.7, options.strength ?? 0.5) },
      causticColour: { value: new THREE.Color(options.colour ?? 0xfff0d2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */`
      ${options.share ? "attribute float share;" : ""}
      varying vec3 vWorld;
      varying vec3 vFace;
      varying float vShare;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vFace = normalize(mat3(modelMatrix) * normal);
        vShare = ${options.share ? "share" : "1.0"};
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      ${options.lean ? "#define W_LEAN" : ""}
      uniform float time;
      uniform vec4 causticForm;
      uniform vec3 causticColour;
      varying vec3 vWorld;
      varying vec3 vFace;
      varying float vShare;
      ${WATER_GLSL}
      ${options.lit ?? ""}
      void main() {
        vec3 face = abs(vFace);
        // The net is laid along a wall and drawn out up it, as light glancing up off the water is.
        vec2 at = face.y > 0.55 ? vWorld.xz : face.x > face.z ? vec2(vWorld.z, vWorld.y * 0.55) : vec2(vWorld.x, vWorld.y * 0.55);
        float lift = max(vWorld.y - causticForm.x, 0.0);
        float net = wCaustic(at / causticForm.z, time * 0.8);
        // It comes and goes as the water under it stirs and settles.
        float stir = 0.55 + 0.45 * wNoise(at * 0.3 + vec2(time * 0.09, -time * 0.06));
        float light = net * stir * exp(-lift * 2.2 / causticForm.y) * causticForm.w * vShare${options.lit ? " * wLit(vWorld.xz)" : ""};
        gl_FragColor = vec4(causticColour * light, 1.0);
      }
    `,
  });
}

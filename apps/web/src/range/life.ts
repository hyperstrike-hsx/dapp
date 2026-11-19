import * as THREE from "three";
import type { Kit, RangeOptions } from "./kit";
import type { CueName } from "./cues";
import { WIND_GLSL, applyWind, type Wind } from "./wind";

// The life of a range: animals, things the wind carries and fittings that move.
//
//   const wind = createWind({ heading: 0.6, strength: 0.3, gustiness: 0.6 });
//   const life = createLife(kit, options, { wind, seed: 5 });
//
//   life.birds("pigeon", { perches: [{ from: [-9, 4.6, -20], to: [-9, 4.6, -8] }], count: 9 });
//   life.soaring("gull", { centre: [0, 0, -12], radius: 16, height: 14, count: 4 });
//   life.chickens({ areas: [[-8.4, -3, -6.5, 6]], count: 5 });
//   life.drift("leaves", { volume: { x: [-9, 9], y: [0, 3], z: [-24, 8] }, count: 70 });
//   life.insects([[3.2, 2.9, -11]], { kind: "moths" });
//   life.sway(lantern, { amplitude: 0.12, period: 2.4, creak: "chainRattle" });
//   life.cloth(awningMaterial, { amplitude: 0.05, pin: "ends" }).snap([4, 3, -6]);
//   life.plume("smoke", [6, 7.2, -30], { rise: 6 });
//   life.flicker(tubeLight, "tube");
//
//   return { ...kit.finish({ ... }), startle: life.startle, struck: life.struck };
//
// Conventions
//   - One wind: everything here reads the Wind it is given, on the CPU and in its shaders.
//   - `update` and `dispose` are registered with the kit, and the animals' hit proxies are pushed
//     into the kit's `shootable`, so a map built on `kit.finish` only forwards `startle` and
//     `struck`. Calling `update` or `dispose` again by hand is harmless.
//   - Nothing here casts a shadow (the sun map is frozen) or blocks the player; ground animals
//     carry a soft contact decal instead. Everything takes fog and stays out of the light probe.
//   - Animals are placed by instance matrices written on the CPU (so occlusion and culling see
//     them where they are) and posed in the vertex shader; particles live wholly in shaders.
//   - PERFORMANCE halves the counts and leaves out insects and motes.
//   - Deterministic from the seed, except reactions to the player; `update` does not allocate.

export type V3 = [number, number, number];
/** An axis-aligned box in the world: `y[0]` is the ground the things in it rest on. */
export type Volume = { x: [number, number]; y: [number, number]; z: [number, number] };

export type DriftKind = "leaves" | "paper" | "dust" | "embers" | "motes" | "spindrift" | "petals";
export type DriftOptions = {
  volume: Volume;
  /** Number of pieces on HIGH (halved on PERFORMANCE). */
  count?: number;
  /** Colours drawn from per piece (leaves, petals, paper), or the one tint (dust, spindrift, embers, motes). */
  colors?: THREE.ColorRepresentation[];
  /** Size multiplier. */
  scale?: number;
  /** Opacity multiplier for the soft kinds. */
  opacity?: number;
  /** Leaves and petals: share that falls from the top of the volume instead of blowing along the ground. */
  falling?: number;
};

export type InsectKind = "moths" | "flies" | "fireflies";
export type InsectOptions = {
  kind: InsectKind;
  /** Insects per place. */
  count?: number;
  /** How far they stray from the place, in metres. */
  radius?: number;
  color?: THREE.ColorRepresentation;
};

export type SwayOptions = {
  /** Swing in radians at a steady strong wind (default 0.12). */
  amplitude?: number;
  /** Seconds per swing (default 2.4; a pendulum of length L has 2 * sqrt(L)). */
  period?: number;
  /** "x" / "z": hinged about that local axis (a sign on its bracket). "both": hangs free (a lamp on a chain). */
  axis?: "x" | "z" | "both";
  /** Sound at the ends of a wide swing. */
  creak?: CueName;
  /** 0..1, how quickly a swing dies (default 0.08). */
  damping?: number;
};
export type SwayHandle = {
  /** Sets it swinging: `strength` in radians per second, direction in world xz (defaults to downwind). */
  kick: (strength: number, x?: number, z?: number) => void;
};

export type ClothPin = "top" | "bottom" | "left" | "right" | "ends" | "sides" | "corners" | "edges" | "none" | { height: number; reach: number };
export type ClothOptions = {
  /** Depth of the ripples in metres at a strong wind (default 0.06). */
  amplitude?: number;
  /** Ripples per metre, relative (default 1): raise it for small pieces. */
  frequency?: number;
  /**
   * Where the cloth is held, by uv: "top" is v = 1, "left" is u = 0, "ends" both u edges, "sides" both v edges,
   * or `{ height, reach }` for cloth without 0..1 uvs: held at world height `height`, free `reach` metres below.
   * "left" and "right" make a flag: it also flaps in its own plane and hangs in a lull, so u must run along the
   * mesh's local x and the fly end should point downwind (`rotation.y = heading + Math.PI / 2` for "left").
   */
  pin?: ClothPin;
  /** How far the free part is pushed downwind, relative (default 0.5; 0 for stretched cloth). */
  lean?: number;
  /** Fine flutter at the free edge, relative (default 1). */
  flutter?: number;
};
export type ClothHandle = {
  /** Listens for strong gusts at this place and cracks the cloth there (`clothSnap`). Returns the handle. */
  snap: (at: V3) => ClothHandle;
};

export type PlumeKind = "smoke" | "steam" | "breath";
export type PlumeOptions = {
  /** Height the plume climbs before it has thinned to nothing, in metres. */
  rise?: number;
  /** Width at the source and at the top, in metres. */
  size?: [number, number];
  /** Seconds a puff lives. */
  life?: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  /** Puffs per source on HIGH. */
  density?: number;
  /** How far a strong wind bends the top over, in metres. */
  lean?: number;
  /** Light of its own added on top of the scene's (a vent lit by a red lamp), in linear HDR. */
  glow?: THREE.ColorRepresentation;
  /** Steam in bursts: one every `every` seconds (jittered), each `length` seconds long. */
  burst?: { every: number; length: number };
  /** Sound when a burst starts (default `steamHiss` for steam bursts). */
  cue?: CueName | null;
};

export type FlickerPattern = "tube" | "neon" | "dead" | "candle" | "lantern" | "arc";
export type FlickerTarget = THREE.Light | THREE.Material | { color: THREE.Color } | ((level: number) => void);
export type FlickerOptions = {
  /** Where its sound comes from; a light's own position is used when left out. */
  at?: V3;
  /** False keeps it silent. */
  cue?: boolean;
  /** Speed multiplier (default 1). */
  rate?: number;
};

export type BirdSpecies = "pigeon" | "sparrow" | "gull" | "crow" | "swift";
/** Somewhere to sit: a point, or a line (a ridge, a truss, a wire) that birds space themselves along. */
export type Perch = V3 | { from: V3; to: V3; /** A wire or a rail: too thin to take a contact shadow. */ thin?: boolean };
export type BirdOptions = {
  perches: Perch[];
  /** Birds on HIGH (halved on PERFORMANCE); never more than the perches have room for. */
  count?: number;
  /** The air they wheel about in when flushed; by default a box some metres above the perches. Once in it they stay in it. */
  roam?: Volume;
  /** Where a newcomer flies in from (a door, a skylight) when the roam is walled in; by default from beyond the roam. */
  from?: V3;
  /** False leaves them out of the things a bullet can hit (default true: a hit bird is a puff of feathers). */
  shootable?: boolean;
  /** How near the player may come before they fly, in metres (pigeon 2.4, sparrow 3, gull 3, crow 4.2). */
  wary?: number;
};
export type SoaringOptions = {
  /** The middle of their circling, on the ground. */
  centre: V3;
  /** How far out they range (default 14). */
  radius?: number;
  /** Height above the centre (default 12). */
  height?: number;
  count?: number;
};
export type ChickenOptions = {
  /** Open floor they may use, as [x0, z0, x1, z1] rectangles. */
  areas: Array<[number, number, number, number]>;
  /** Birds on HIGH, the cock included (default 5). */
  count?: number;
  /** Height of the floor (default 0). */
  y?: number;
  /** A cock among them (default: when there are three or more). */
  cock?: boolean;
  /** Plumage colours the hens are drawn from. */
  breeds?: THREE.ColorRepresentation[];
  /** How near the player may come before they trot off, in metres (default 2.6). */
  shy?: number;
};

export type Life = {
  /** A flock that sits on the perches, flushes when startled, wheels about and comes back. */
  birds: (species: BirdSpecies, options: BirdOptions) => THREE.Object3D | null;
  /** Birds that never land: circles and figure-eights high overhead. */
  soaring: (species: BirdSpecies, options: SoaringOptions) => THREE.Object3D | null;
  /** Hens and a cock that wander, scratch and peck, and keep clear of the player. */
  chickens: (options: ChickenOptions) => THREE.Object3D | null;
  /** Things the wind carries, wrapping around inside a box. */
  drift: (kind: DriftKind, options: DriftOptions) => THREE.Object3D | null;
  /** Moths round lamps, flies over produce or rubbish, fireflies over grass. */
  insects: (places: V3[], options: InsectOptions) => THREE.Object3D | null;
  /** Swings an object whose origin is its pivot as a damped pendulum pushed by the wind. */
  sway: (object: THREE.Object3D, options?: SwayOptions) => SwayHandle;
  /** Makes a mesh material ripple in the wind (awnings, flags, laundry, tarps, banners). */
  cloth: (material: THREE.Material | THREE.Material[], options?: ClothOptions) => ClothHandle;
  /** Smoke, steam or breath rising from one place or several. */
  plume: (kind: PlumeKind, at: V3 | V3[], options?: PlumeOptions) => THREE.Object3D;
  /** Drives a light, an emissive material, a glow or a callback like a failing lamp or a flame. */
  flicker: (target: FlickerTarget | FlickerTarget[], pattern: FlickerPattern, options?: FlickerOptions) => { level: () => number };
  update: (now: number) => void;
  startle: (at: THREE.Vector3, loudness: number) => void;
  struck: (object: THREE.Object3D, point: THREE.Vector3) => boolean;
  /** The hit proxies of this life (already in the kit's `shootable`). */
  shootable: THREE.Object3D[];
  dispose: () => void;
};

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function rng(seed: number) {
  let state = (seed | 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise summed over four octaves, as a repeating single-channel texture. */
function noiseTexture(size: number, seed: number) {
  const data = new Uint8Array(size * size), sum = new Float32Array(size * size), next = rng(seed);
  let amplitude = 1, total = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    const cells = 4 << octave, lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = next();
    for (let y = 0; y < size; y += 1) {
      const fy = (y / size) * cells, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty), r0 = (iy % cells) * cells, r1 = ((iy + 1) % cells) * cells;
      for (let x = 0; x < size; x += 1) {
        const fx = (x / size) * cells, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx), x0 = ix % cells, x1 = (ix + 1) % cells;
        const top = lattice[r0 + x0] + (lattice[r0 + x1] - lattice[r0 + x0]) * sx, bottom = lattice[r1 + x0] + (lattice[r1 + x1] - lattice[r1 + x0]) * sx;
        sum[y * size + x] += (top + (bottom - top) * sy) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < data.length; i += 1) data[i] = Math.round(clamp(sum[i] / total, 0, 1) * 255);
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------------------------
// Shaders: soft sprites (dust, spindrift, embers, motes, insects, plumes)
// ---------------------------------------------------------------------------------------------

const SOFT_COMMON = /* glsl */ `
uniform float lifeTime;
uniform float lifeViewport;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vDepth;
${WIND_GLSL}
vec2 windHeading() { float s = length(windVector); return s > 0.0001 ? windVector / s : vec2(0.0, -1.0); }
float pick(vec4 v, float c) { return c < 1.0 ? mix(v.x, v.y, c) : c < 2.0 ? mix(v.y, v.z, c - 1.0) : mix(v.z, v.w, clamp(c - 2.0, 0.0, 1.0)); }
/** Places the quad corner of a camera-facing sprite; things thinner than a pixel are widened and thinned out instead of flickering. */
void billboard(vec3 centre, float size, float turn, float minPixels) {
  vec4 mv = viewMatrix * vec4(centre, 1.0);
  float pixels = size * projectionMatrix[1][1] * lifeViewport * 0.5 / max(0.05, -mv.z);
  float grow = max(1.0, minPixels / max(pixels, 0.0001));
  vAlpha /= grow * grow;
  float s = sin(turn), c = cos(turn);
  mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * size * grow;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const SOFT_FOG = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
float fogAmount(float depth) {
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    #else
      return smoothstep(fogNear, fogFar, depth);
    #endif
  #else
    return 0.0;
  #endif
}
`;

/** A glowing or dark dot. */
const DOT_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vDepth;
${SOFT_FOG}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  float a = vAlpha * exp(-r2 * 3.2) * (1.0 - smoothstep(0.7, 1.0, r2));
  if (a < 0.002) discard;
  float fog = fogAmount(vDepth);
  #ifdef SOFT_ADDITIVE
    gl_FragColor = vec4(vTint, a * (1.0 - fog));
  #else
    #ifdef USE_FOG
      gl_FragColor = vec4(mix(vTint, fogColor, fog), a);
    #else
      gl_FragColor = vec4(vTint, a);
    #endif
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A wisp of smoke, steam, dust or blown snow: a noisy soft body lit by the sky and the sun. */
const WISP_FRAGMENT = /* glsl */ `
uniform sampler2D lifeNoise;
uniform vec3 lifeAmbient;
uniform vec3 lifeSun;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vDepth;
varying vec4 vWisp;
varying vec3 vSunView;
varying vec3 vGlow;
varying float vGround;
${SOFT_FOG}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  bool streak = vWisp.z < 0.0;
  vec2 grain = streak ? vec2(0.3, 2.2) : vec2(vWisp.z);
  float n = texture2D(lifeNoise, vUv * grain + vWisp.xy).r;
  float m = texture2D(lifeNoise, streak ? vUv * grain * 2.3 + vWisp.xy * vec2(1.6, 3.1) : vUv * grain * 2.3 - vWisp.yx).r;
  float body = 1.0 - smoothstep(0.15, 1.0, r + (n - 0.5) * vWisp.w + (m - 0.5) * vWisp.w * 0.4);
  float a = vAlpha * body * vGround;
  if (a < 0.003) discard;
  vec3 normal = normalize(vec3(p, 0.8));
  float side = dot(normal, vSunView) * 0.5 + 0.5;
  vec3 lit = lifeAmbient * (0.8 + 0.2 * p.y) + lifeSun * (0.2 + 0.8 * side) * (1.0 - 0.3 * body);
  vec3 colour = vTint * lit + vGlow * (0.4 + 0.6 * body);
  // Blown snow is white on white: its thin edges are drawn as the shade they cast, so it reads on snow too.
  if (streak) colour = vTint * (lifeAmbient * 0.9 + lifeSun * 0.1) * mix(vec3(0.66, 0.74, 0.88), vec3(0.92, 0.95, 1.0), body);
  #ifdef USE_FOG
    colour = mix(colour, fogColor, fogAmount(vDepth));
  #endif
  gl_FragColor = vec4(colour, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WISP_VARYINGS = /* glsl */ `
uniform vec3 lifeSunDir;
varying vec4 vWisp;
varying vec3 vSunView;
varying vec3 vGlow;
varying float vGround;
`;

/** Low puffs of dust, or snow streaming over the ground, carried along the wind in a box. */
const DUST_VERTEX = /* glsl */ `
${SOFT_COMMON}
${WISP_VARYINGS}
attribute vec4 lifeSeed;
uniform vec3 driftMin;
uniform vec3 driftSize;
uniform vec4 driftTravel;
uniform vec4 driftAloft;
uniform vec4 driftLook;   // size, opacity, 1 for streaks lying on the ground, noise contrast
uniform vec3 driftTint;
void main() {
  vUv = uv;
  float cls = lifeSeed.w * 3.0;
  float run = pick(driftTravel, cls) * (0.7 + 0.6 * lifeSeed.z), aloft = pick(driftAloft, cls);
  vec2 d = windHeading(), c = vec2(-d.y, d.x), span = driftSize.xz;
  vec2 q = mod(lifeSeed.xy * span + d * run + c * sin(run * 0.31 + lifeSeed.z * 40.0) * 0.7, span);
  vec2 e = q / span;
  float edge = smoothstep(0.0, 0.12, e.x) * smoothstep(0.0, 0.12, 1.0 - e.x) * smoothstep(0.0, 0.12, e.y) * smoothstep(0.0, 0.12, 1.0 - e.y);
  float age = fract(run * 0.06 + lifeSeed.z * 3.0 + lifeSeed.w);
  float size = driftLook.x * mix(0.55, 1.35, lifeSeed.z) * (0.6 + 0.8 * age);
  bool lying = driftLook.z > 0.5 && lifeSeed.w < 0.62;
  vTint = driftTint;
  vGlow = vec3(0.0);
  vSunView = (viewMatrix * vec4(lifeSunDir, 0.0)).xyz;
  // A negative grain marks a streak: its noise is drawn out along the wind and streams down it.
  vWisp = vec4(lifeSeed.x * 7.0 + (lying ? -run * 0.1 : run * 0.02), lifeSeed.y * 5.0, lying ? -1.0 : 0.8, driftLook.w);
  vAlpha = driftLook.y * edge * sin(age * 3.14159) * aloft;
  vec3 centre = vec3(driftMin.x + q.x, driftMin.y, driftMin.z + q.y);
  if (lying) {
    // A streak lying just over the ground, long along the wind.
    float len = size * 6.5, wide = size * 1.7;
    vec3 at = centre + vec3(0.0, 0.03 + lifeSeed.z * 0.1, 0.0) + vec3(d.x, 0.0, d.y) * (position.x * len) - vec3(c.x, 0.0, c.y) * (position.y * wide);
    vec4 mv = viewMatrix * vec4(at, 1.0);
    vDepth = -mv.z;
    vGround = 1.0;
    gl_Position = projectionMatrix * mv;
  } else {
    centre.y += size * 0.42 + age * size * 0.35;
    // Fade the foot of the puff so it never draws a line where it meets the ground.
    vGround = smoothstep(-0.5, -0.12, position.y);
    billboard(centre, size, 0.0, 0.0);
  }
}
`;

/** Sparks rising from a fire, or dust motes hanging in the light. */
const SPECK_VERTEX = /* glsl */ `
${SOFT_COMMON}
attribute vec4 lifeSeed;
uniform vec3 driftMin;
uniform vec3 driftSize;
uniform vec4 driftTravel;
uniform vec4 driftLook;   // size, opacity, 1 for embers, unused
uniform vec3 driftTint;
void main() {
  vUv = uv;
  vec2 d = windHeading();
  float gust = windAt(driftMin.xz + driftSize.xz * 0.5);
  if (driftLook.z > 0.5) {
    float age = fract(lifeTime * (0.16 + 0.2 * lifeSeed.w) + lifeSeed.z * 9.0);
    vec3 at = driftMin + vec3(lifeSeed.x * driftSize.x, age * driftSize.y * (0.45 + 0.55 * lifeSeed.w), lifeSeed.y * driftSize.z);
    float swirl = lifeTime * (1.3 + lifeSeed.z) + lifeSeed.w * 40.0;
    at.xz += d * gust * age * age * driftSize.y * 1.4 + vec2(sin(swirl), cos(swirl * 0.83)) * 0.16 * age;
    float heat = pow(1.0 - age, 1.4) * smoothstep(0.0, 0.04, age);
    float flick = 0.65 + 0.35 * sin(lifeTime * (9.0 + lifeSeed.z * 14.0) + lifeSeed.w * 90.0);
    vTint = driftTint * mix(vec3(0.55, 0.06, 0.01), vec3(1.6, 0.85, 0.3), heat) * 3.0;
    vAlpha = driftLook.y * heat * flick;
    billboard(at, driftLook.x * (0.5 + lifeSeed.z) * (1.0 - 0.5 * age), 0.0, 1.6);
  } else {
    vec3 wander = vec3(sin(lifeTime * 0.21 + lifeSeed.w * 50.0), sin(lifeTime * 0.17 + lifeSeed.z * 30.0) * 0.6, cos(lifeTime * 0.19 + lifeSeed.w * 70.0)) * 0.45;
    vec3 q = mod(lifeSeed.xyz * driftSize + vec3(d.x, -0.04, d.y) * driftTravel.x * 0.12 + wander, driftSize);
    vec3 e = q / driftSize;
    float edge = smoothstep(0.0, 0.1, e.x) * smoothstep(0.0, 0.1, 1.0 - e.x) * smoothstep(0.0, 0.1, e.y) * smoothstep(0.0, 0.1, 1.0 - e.y) * smoothstep(0.0, 0.1, e.z) * smoothstep(0.0, 0.1, 1.0 - e.z);
    vTint = driftTint;
    vAlpha = driftLook.y * edge * (0.45 + 0.55 * sin(lifeTime * (0.5 + lifeSeed.z) + lifeSeed.w * 90.0));
    billboard(driftMin + q, driftLook.x * (0.6 + 0.8 * lifeSeed.z), 0.0, 1.4);
  }
}
`;

/** Moths round a lamp, flies over a heap, fireflies over grass. */
const INSECT_VERTEX = /* glsl */ `
${SOFT_COMMON}
attribute vec4 lifeSeed;
attribute vec4 lifeHome;   // place, radius
uniform vec4 insectLook;   // size, opacity, kind (0 moths, 1 flies, 2 fireflies), unused
uniform vec3 insectTint;
vec3 hop(float n, float s) { return fract(sin(vec3(n * 12.9898 + s * 78.233, n * 39.346 + s * 11.135, n * 73.156 + s * 52.235)) * 43758.5453) * 2.0 - 1.0; }
void main() {
  vUv = uv;
  float s = lifeSeed.w, kind = insectLook.z, t = lifeTime;
  vec3 at = lifeHome.xyz;
  float size = insectLook.x * (0.7 + 0.6 * lifeSeed.z);
  vTint = insectTint;
  vAlpha = insectLook.y;
  if (kind < 0.5) {
    // Moths: tight, restless loops that keep falling back toward the light.
    float w = 2.2 + lifeSeed.x * 2.6, pull = 0.35 + 0.65 * abs(sin(t * (0.23 + lifeSeed.y * 0.3) + s * 30.0));
    vec3 loop = vec3(sin(t * w + s * 40.0) + 0.4 * sin(t * w * 2.7 + s * 9.0), 0.7 * sin(t * w * 1.3 + s * 21.0) + 0.3 * sin(t * w * 3.1), cos(t * w * 0.9 + s * 33.0) + 0.4 * cos(t * w * 2.3 + s * 17.0));
    at += loop * lifeHome.w * 0.6 * pull;
    // Wings catch the light on every other beat.
    vAlpha *= 0.6 + 0.4 * sin(t * 43.0 + s * 80.0);
    vTint *= 1.1 + 1.7 * (1.0 - pull);
  } else if (kind < 1.5) {
    // Flies: hover, dart to somewhere else, hover.
    float beat = t * (1.6 + lifeSeed.x * 1.4) + s * 20.0, step0 = floor(beat), f = fract(beat);
    float go = smoothstep(0.0, 0.3, f);
    vec3 a = hop(step0, s), b = hop(step0 + 1.0, s);
    at += mix(a, b, go) * lifeHome.w * vec3(1.0, 0.55, 1.0) + vec3(sin(t * 31.0 + s * 60.0), cos(t * 27.0 + s * 44.0), sin(t * 23.0 + s * 12.0)) * 0.012;
    at.y += lifeHome.w * 0.55;
  } else {
    // Fireflies: a slow drift low over the ground and a soft blink every few seconds.
    vec3 drift = vec3(sin(t * (0.11 + lifeSeed.x * 0.1) + s * 40.0), 0.0, cos(t * (0.09 + lifeSeed.y * 0.1) + s * 23.0)) + 0.35 * vec3(sin(t * 0.5 + s * 9.0), 0.0, cos(t * 0.43 + s * 5.0));
    at += drift * lifeHome.w * 0.7;
    at.y += (0.35 + 0.65 * lifeSeed.z) * lifeHome.w * 0.45 + 0.12 * sin(t * 0.7 + s * 15.0);
    float blink = fract(t / (2.6 + lifeSeed.x * 3.5) + s * 7.0);
    vAlpha *= smoothstep(0.0, 0.06, blink) * (1.0 - smoothstep(0.1, 0.34, blink));
    vTint *= 3.0;
  }
  billboard(at, size, 0.0, kind < 0.5 ? 2.6 : kind < 1.5 ? 1.5 : 2.2);
}
`;

/** Smoke, steam and breath: puffs that are born small, climb, spread, lean with the wind and thin away. */
const PLUME_VERTEX = /* glsl */ `
${SOFT_COMMON}
${WISP_VARYINGS}
attribute vec4 lifeSeed;   // phase in the cycle, three randoms
attribute vec4 lifeHome;   // source, seed of the source
uniform vec4 plumeShape;   // rise, life in seconds, lean, spread
uniform vec4 plumeLook;    // size at the source, size at the top, opacity, rise easing
uniform vec3 plumeBurst;   // period (0 = continuous), length, jitter
uniform vec3 plumeTint;
uniform vec3 plumeGlow;
void main() {
  vUv = uv;
  float age = fract(lifeTime / plumeShape.y + lifeSeed.x);
  float born = lifeTime - age * plumeShape.y;
  float gate = 1.0;
  if (plumeBurst.x > 0.0) {
    float cycle = born / plumeBurst.x + lifeHome.w * 7.0, n = floor(cycle), since = (cycle - n) * plumeBurst.x;
    float start = fract(n * 0.618 + lifeHome.w) * plumeBurst.z;
    gate = smoothstep(start, start + 0.12, since) * (1.0 - smoothstep(start + plumeBurst.y, start + plumeBurst.y + 0.25, since));
  }
  float climb = pow(age, plumeLook.w);
  vec3 at = lifeHome.xyz + vec3(0.0, plumeShape.x * climb, 0.0);
  float gust = windAt(lifeHome.xz);
  vec2 d = windHeading();
  at.xz += d * gust * plumeShape.z * pow(age, 1.5);
  at.xz += vec2(sin(lifeSeed.y * 40.0 + lifeTime * 0.6 + age * 3.0), cos(lifeSeed.z * 31.0 + lifeTime * 0.45 + age * 2.3)) * plumeShape.w * age;
  at.y += sin(lifeSeed.w * 25.0 + lifeTime * 0.5) * plumeShape.w * 0.3 * age;
  float size = mix(plumeLook.x, plumeLook.y, sqrt(age)) * (0.8 + 0.4 * lifeSeed.w);
  vTint = plumeTint;
  vGlow = plumeGlow * (1.0 - age);
  vSunView = (viewMatrix * vec4(lifeSunDir, 0.0)).xyz;
  vWisp = vec4(lifeSeed.y * 9.0, lifeSeed.z * 9.0 - age * 0.35, 0.75, 1.0);
  vGround = 1.0;
  vAlpha = plumeLook.z * gate * smoothstep(0.0, 0.1, age) * pow(1.0 - age, 1.6);
  billboard(at, size, lifeSeed.y * 6.283 + (lifeSeed.z - 0.5) * age * 2.2, 0.0);
}
`;

/** The burst of down where something feathered is hit: a few soft puffs that swell, drift and thin away. */
const POOF_VERTEX = /* glsl */ `
${SOFT_COMMON}
${WISP_VARYINGS}
attribute vec4 poofBorn;   // where, when
attribute vec4 poofLook;   // tint, seed + size * 16 in the whole part
void main() {
  vUv = uv;
  float seed = fract(poofLook.w), scale = floor(poofLook.w) / 16.0;
  float age = (lifeTime - poofBorn.w) / (0.7 + seed * 0.6), spread = 1.0 - exp(-max(age, 0.0) * 5.0);
  vec3 way = normalize(vec3(sin(seed * 40.0), 0.25 + fract(seed * 7.0), cos(seed * 40.0)));
  vec3 at = poofBorn.xyz + (way * spread * (0.1 + 0.3 * fract(seed * 13.0)) + vec3(0.0, 0.14 * age, 0.0)) * scale;
  at.xz += windHeading() * windAt(poofBorn.xz) * 0.5 * age * age;
  vTint = poofLook.rgb;
  vGlow = vec3(0.0);
  vSunView = (viewMatrix * vec4(lifeSunDir, 0.0)).xyz;
  vWisp = vec4(seed * 9.0, seed * 5.0 - age * 0.2, 0.8, 1.1);
  vGround = 1.0;
  vAlpha = age < 0.0 || age > 1.0 ? 0.0 : 0.62 * smoothstep(0.0, 0.05, age) * pow(1.0 - age, 1.4);
  billboard(at, (0.2 + 0.42 * spread) * (0.7 + 0.6 * fract(seed * 3.0)) * scale, seed * 6.283 + age, 0.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Shaders: flakes (leaves, petals, paper) and cloth, patched into lit standard materials
// ---------------------------------------------------------------------------------------------

const FLAKE_PARS = /* glsl */ `
attribute vec4 lifeSeed;
attribute vec4 flakeLook;   // size, yaw at rest, variant, 1 when it falls from above
attribute vec3 flakeTint;
uniform float lifeTime;
uniform vec3 driftMin;
uniform vec3 driftSize;
uniform vec4 driftTravel;
uniform vec4 driftAloft;
uniform vec4 flakeMove;     // hop height, tumble per metre, fall seconds, flutter width
uniform vec4 flakeShape;    // kind (0 leaf, 1 petal, 2 paper), curl, drift of a fall in metres, unused
varying vec2 vFlakeUv;
varying vec3 vFlakeTint;
varying float vFlakeVariant;
float flakePick(vec4 v, float c) { return c < 1.0 ? mix(v.x, v.y, c) : c < 2.0 ? mix(v.y, v.z, c - 1.0) : mix(v.z, v.w, clamp(c - 2.0, 0.0, 1.0)); }
vec3 flakeTurnX(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 flakeTurnY(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
vec3 flakeTurnZ(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
`;

const FLAKE_VERTEX = /* glsl */ `
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vec3 flakeAt;
{
  vFlakeUv = uv;
  vFlakeTint = flakeTint;
  vFlakeVariant = flakeLook.z;
  float steady = length(windVector);
  vec2 d = steady > 0.0001 ? windVector / steady : vec2(0.0, -1.0), c = vec2(-d.y, d.x), span = driftSize.xz;
  float size = flakeLook.x, shown = 1.0, tiltX, tiltZ, yaw = flakeLook.y, height;
  vec2 q;
  // The piece itself: a card in the xz plane, creased or cupped by kind.
  vec3 p = position;
  float bag = flakeShape.x > 1.5 && flakeLook.z > 0.86 ? 1.0 : 0.0;
  float cup = flakeShape.y * (flakeShape.x < 0.5 ? abs(p.x) * 1.1 : flakeShape.x < 1.5 ? dot(p.xz, p.xz) * 1.6 : sin(p.z * 5.0 + lifeSeed.w * 6.0) * 0.22 + p.x * p.z * 0.9);
  cup = mix(cup, 0.55 * (1.0 - 4.0 * p.x * p.x) * (1.0 - 4.0 * p.z * p.z), bag);
  vec3 slope = vec3(flakeShape.x < 0.5 ? sign(p.x) * 1.1 * flakeShape.y : 0.0, 1.0, 0.0);
  if (flakeLook.w < 0.5) {
    // Blown along the ground: it moves only while its own gust class is aloft, hopping and tumbling.
    float cls = lifeSeed.w * 3.0;
    float run = flakePick(driftTravel, cls) * (0.6 + 0.8 * lifeSeed.z), aloft = flakePick(driftAloft, cls);
    q = mod(lifeSeed.xy * span + d * run + c * sin(run * 0.9 + lifeSeed.z * 40.0) * 0.35, span);
    vec2 e = q / span;
    shown = smoothstep(0.0, 0.06, e.x) * smoothstep(0.0, 0.06, 1.0 - e.x) * smoothstep(0.0, 0.06, e.y) * smoothstep(0.0, 0.06, 1.0 - e.y);
    float hop = abs(sin(run * (1.1 + lifeSeed.z) + lifeSeed.w * 30.0));
    height = aloft * flakeMove.x * (0.12 + 0.88 * pow(lifeSeed.z, 3.0)) * hop * min(driftSize.y, 1.0 + driftSize.y * lifeSeed.z);
    float spin = run * flakeMove.y + lifeSeed.w * 50.0;
    tiltX = (lifeSeed.x - 0.5) * 0.3 + aloft * 2.3 * sin(spin);
    tiltZ = (lifeSeed.y - 0.5) * 0.3 + aloft * 1.6 * cos(spin * 0.71 + 1.0);
    yaw += run * 0.8;
    cup *= 1.0 + bag * aloft * 0.5 * sin(lifeTime * 7.0 + lifeSeed.w * 30.0);
  } else {
    // Falling from above: a see-saw descent, a rest on the ground, then gone and back at the top.
    float cycle = flakeMove.z * (0.7 + 0.6 * lifeSeed.z) / 0.72;
    float u = fract(lifeTime / cycle + lifeSeed.w * 7.0), air = min(u / 0.72, 1.0), still = 1.0 - air * air * air;
    float gust = windAt(driftMin.xz + lifeSeed.xy * span);
    float swing = air * (4.0 + lifeSeed.z * 5.0) * 3.14159 + lifeSeed.w * 20.0;
    q = lifeSeed.xy * span + d * (flakeShape.z * air * steady / max(steady, 0.3)) + c * sin(swing) * flakeMove.w * still * (0.7 + gust);
    q += d * gust * flakeMove.w * 1.5 * still * air;
    height = driftSize.y * (1.0 - air) + 0.06 * still * cos(swing * 2.0);
    tiltX = (lifeSeed.x - 0.5) * 0.3 + still * 0.5 * sin(swing * 0.5 + lifeSeed.z * 9.0);
    tiltZ = (lifeSeed.y - 0.5) * 0.3 + still * 1.1 * cos(swing);
    yaw += still * swing * 0.25;
    shown = smoothstep(0.0, 0.04, u) * (1.0 - smoothstep(0.92, 1.0, u));
  }
  p.y += cup;
  p *= size * shown;
  p = flakeTurnY(flakeTurnZ(flakeTurnX(p, tiltX), tiltZ), yaw);
  objectNormal = normalize(flakeTurnY(flakeTurnZ(flakeTurnX(slope, tiltX), tiltZ), yaw));
  flakeAt = vec3(driftMin.x + q.x, driftMin.y + 0.006 + lifeSeed.w * 0.012 + height, driftMin.z + q.y) + p;
}
`;

const FLAKE_FRAGMENT_PARS = /* glsl */ `
uniform vec4 flakeShape;
varying vec2 vFlakeUv;
varying vec3 vFlakeTint;
varying float vFlakeVariant;
`;

const FLAKE_FRAGMENT = /* glsl */ `
{
  vec2 p = vFlakeUv - 0.5;
  float edge, shade = 1.0;
  if (flakeShape.x < 0.5) {
    // Leaf: a pointed blade with a midrib, browner toward the tip.
    float blade = 0.3 * (1.0 - pow(abs(p.y * 2.0), 1.7)) * (0.82 + 0.18 * sin(p.y * 9.0 + vFlakeVariant * 20.0));
    edge = blade - abs(p.x + 0.04 * sin(p.y * 6.0 + vFlakeVariant * 9.0));
    shade = (1.0 - 0.3 * smoothstep(0.035, 0.0, abs(p.x))) * (0.8 + 0.4 * (p.y + 0.5)) * (1.0 - 0.25 * smoothstep(0.1, 0.0, edge));
  } else if (flakeShape.x < 1.5) {
    // Petal: a rounded lobe, pale at the claw.
    edge = 0.46 - length(p * vec2(1.25 + 0.5 * (0.5 - p.y), 1.0));
    shade = 0.82 + 0.3 * (p.y + 0.5);
  } else if (vFlakeVariant > 0.86) {
    // A carrier bag: a soft-cornered sheet.
    vec2 b = abs(p) - 0.36;
    edge = 0.12 - length(max(b, 0.0));
    shade = 0.92 + 0.12 * sin(p.x * 23.0 + p.y * 17.0);
  } else {
    // Paper: a sheet with a torn side and faint lines of print.
    edge = min(0.5 - abs(p.x), 0.5 - abs(p.y)) + 0.04 * sin(p.y * 31.0 + vFlakeVariant * 50.0) * step(0.3, p.x) - 0.02;
    float lines = step(0.55, fract(p.y * 11.0 + vFlakeVariant * 3.0)) * step(abs(p.x + 0.04), 0.36) * step(vFlakeVariant, 0.6);
    shade = 1.0 - 0.3 * lines;
  }
  diffuseColor.rgb *= vFlakeTint * shade * (gl_FrontFacing ? 1.0 : 0.85);
  diffuseColor.a = clamp(0.5 + edge * 14.0, 0.0, 1.0);
}
`;

const CLOTH_PARS = /* glsl */ `
uniform vec4 clothShape;   // amplitude, frequency, lean, flutter
uniform vec4 clothPin;     // mode, height, reach, unused
float clothHold(vec2 st, float worldY) {
  float m = clothPin.x;
  if (m < 0.5) return 1.0 - st.y;
  if (m < 1.5) return st.y;
  if (m < 2.5) return st.x;
  if (m < 3.5) return 1.0 - st.x;
  if (m < 4.5) return sin(st.x * 3.14159);
  if (m < 5.5) return sin(st.y * 3.14159);
  if (m < 6.5) { float a = sin(st.x * 3.14159), b = sin(st.y * 3.14159); return a + b - a * b; }
  if (m < 7.5) return sin(st.x * 3.14159) * sin(st.y * 3.14159);
  if (m < 8.5) return (clothPin.y - worldY) / clothPin.z;
  return 1.0;
}
/** Offset of a cloth vertex in object space, and the normal of the rippled surface. */
vec3 clothShift(vec3 p, vec3 n, vec2 st, out vec3 bent) {
  #ifdef USE_INSTANCING
    mat4 m = modelMatrix * instanceMatrix;
  #else
    mat4 m = modelMatrix;
  #endif
  vec3 w = (m * vec4(p, 1.0)).xyz;
  mat3 r = mat3(m);
  float scale = max(length(r[0]), 0.0001);
  float hold = clamp(clothHold(st, w.y), 0.0, 1.0);
  float steady = length(windVector);
  vec2 d = steady > 0.0001 ? windVector / steady : vec2(0.0, -1.0), c = vec2(-d.y, d.x);
  float gust = windAt(w.xz), k = clothShape.y;
  // Three trains of ripples: down the wind, across it and a fine flutter, so cloth of any facing moves.
  vec3 g1 = vec3(d.x, 0.55, d.y) * (5.2 * k), g2 = vec3(c.x + d.x * 0.5, -0.8, c.y + d.y * 0.5) * (8.7 * k), g3 = vec3(d.x + c.x, 1.3, d.y + c.y) * (19.0 * k);
  float p1 = dot(w, g1) - windTime * 4.4, p2 = dot(w, g2) - windTime * 6.1 + 1.7, p3 = dot(w, g3) - windTime * 13.0;
  float fine = clothShape.w * 0.22 * gust * hold;
  float wave = 0.6 * sin(p1) + 0.3 * sin(p2) + fine * sin(p3);
  vec3 slope = (0.6 * cos(p1)) * g1 + (0.3 * cos(p2)) * g2 + (fine * cos(p3)) * g3;
  float flag = step(1.5, clothPin.x) * step(clothPin.x, 3.5);
  float amount = clothShape.x * (mix(0.25, 0.5, flag) + 1.3 * gust) * hold;
  vec3 shift = n * (amount * wave / scale);
  shift += (vec3(d.x, -0.15, d.y) * (clothShape.z * clothShape.x * hold * hold * gust * 3.0)) * r / (scale * scale);
  // A flag held by one edge also flaps in its own plane: the fly end rides up and down, and hangs in a lull.
  float limp = 1.0 - smoothstep(0.12, 0.55, gust);
  float flap = amount * 0.8 * sin(p1 * 0.5 + 0.9) + clothShape.x * hold * hold * (0.4 * sin(p2 * 0.5) - 2.2 * limp);
  shift += (vec3(0.0, flag * flap, 0.0) * r) / (scale * scale);
  shift.x -= flag * (clothPin.x < 2.5 ? 1.0 : -1.0) * clothShape.x * hold * hold * 0.9 * limp / scale;
  vec3 grad = ((slope * amount) * r) / scale;
  // The tilt is drawn a little stronger than it is: folds this shallow would not shade enough to read as cloth.
  bent = normalize(n - 1.9 * (grad - n * dot(grad, n)));
  return shift;
}
`;

const CLOTH_PINS: Record<Exclude<ClothPin, object>, number> = { top: 0, bottom: 1, left: 2, right: 3, ends: 4, sides: 5, corners: 6, edges: 7, none: 9 };

// ---------------------------------------------------------------------------------------------
// Shaders: birds and chickens
// ---------------------------------------------------------------------------------------------
// One rig for everything with feathers. The geometry rests in the standing pose with its wings
// folded round the body (what the occlusion pass draws); the shader opens them into the spread
// wing kept in `avianWing` and beats that, turns the neck and head, steps the legs and pitches the
// body about the hips, all from sixteen numbers per instance.

const AVIAN_PARS = /* glsl */ `
attribute vec4 avianColor;        // rgb, a = plumage (takes the instance tint and the feather pattern)
attribute vec4 avianPivot;        // the joint this vertex turns about; w = wings: x of the normal on the spread wing
attribute vec4 avianRig;          // part, weight, second weight (wings: share of the span kept when folded), sheen
attribute vec4 avianWing;         // wings: place on the spread wing; neck and head: the skull joint; w = wings: z of that normal
attribute vec4 poseA;             // inner wing angle, outer wing angle, fold, walk phase
attribute vec4 poseB;             // head yaw, neck pitch, head nod, head tilt
attribute vec4 poseC;             // step length, tail fan, crouch, body pitch
attribute vec4 poseD;             // tail pitch, fluff, leg tuck, head bob
attribute vec4 avianKin;          // instance tint (three bytes in one number), lacing contrast, hip height, hip z
varying vec4 vAvian;
varying vec2 vFeather;
varying vec2 vAvianLook;
vec3 avianTurnX(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 avianTurnY(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
vec3 avianTurnZ(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
`;

const AVIAN_VERTEX = /* glsl */ `
vec3 objectNormal = normal;
vec3 avianAt = position;
{
  float part = avianRig.x, w = avianRig.y, leg = 0.0;
  vec3 tint = vec3(mod(avianKin.x, 256.0), mod(floor(avianKin.x / 256.0), 256.0), floor(avianKin.x / 65536.0)) * (1.4 / 255.0);
  vec3 joint = avianPivot.xyz;
  vAvian = vec4(avianColor.rgb * mix(vec3(1.0), tint, avianColor.a), avianColor.a);
  vFeather = uv;
  vAvianLook = vec2(avianRig.w, avianKin.y);
  if (part > 0.5 && part < 2.5) {
    // Wing: beat about the shoulder (the hand trails and folds in on the upstroke), then swept back and draped over the flank as it folds.
    float side = part < 1.5 ? 1.0 : -1.0, fold = poseA.z, shut = smoothstep(0.25, 1.0, fold);
    float lift = mix(poseA.x, poseA.y, smoothstep(0.25, 1.0, w)) * (1.0 - fold);
    float flex = clamp((poseA.x - poseA.y) * 0.8, 0.0, 0.45) * w * (1.0 - fold);
    vec3 q = vec3(avianWing.x * mix(1.0, avianRig.z, fold) * (1.0 - flex), avianWing.y, avianWing.z * mix(1.0, 0.9, fold));
    q = avianTurnY(avianTurnZ(q, lift), 1.42 * fold);
    vec3 n = vec3(avianPivot.w, sqrt(max(0.0, 1.0 - avianPivot.w * avianPivot.w - avianWing.w * avianWing.w)), avianWing.w);
    n = avianTurnY(avianTurnZ(n, lift), 1.42 * fold);
    avianAt = mix(joint + vec3(q.x * side, q.y, q.z), position, shut);
    objectNormal = normalize(mix(vec3(n.x * side, n.y, n.z), normal, shut));
  } else if (part > 2.5 && part < 3.5) {
    // Neck and head: the head nods and tilts on the skull, the neck bends and turns from its base.
    float head = avianRig.z;
    vec3 p = avianTurnZ(avianTurnX(avianAt - avianWing.xyz, poseB.z * head), poseB.w * head) + avianWing.xyz - joint;
    objectNormal = avianTurnZ(avianTurnX(objectNormal, poseB.z * head), poseB.w * head);
    p = avianTurnY(avianTurnX(p, poseB.y * w), poseB.x * w);
    objectNormal = avianTurnY(avianTurnX(objectNormal, poseB.y * w), poseB.x * w);
    // A walking fowl holds its head still in the air while the body catches up, then thrusts it forward.
    float beat = fract(poseA.w / 3.14159265);
    float hold = beat < 0.72 ? 0.5 - beat / 0.72 : smoothstep(0.72, 1.0, beat) - 0.5;
    p.z += hold * 2.0 * poseC.x * poseD.w * w;
    avianAt = p + joint;
  } else if (part > 3.5 && part < 4.5) {
    // Tail: fans sideways, lifts and dips from its root.
    vec3 p = avianAt - joint;
    p.x += avianRig.z * w * poseC.y * length(p.yz) * 0.8;
    avianAt = joint + avianTurnX(p, poseD.x * w);
    objectNormal = avianTurnX(objectNormal, poseD.x * w);
  } else if (part > 4.5) {
    // Legs: the foot is planted for half the stride and swings forward, lifted, for the other half.
    leg = w;
    float stride = fract(poseA.w / 6.2831853 + (part > 5.5 ? 0.5 : 0.0)), swing = (stride - 0.5) * 2.0;
    float fz = stride < 0.5 ? 1.0 - 4.0 * stride : 2.0 * smoothstep(0.0, 1.0, swing) - 1.0;
    float fy = stride < 0.5 ? 0.0 : sin(swing * 3.14159265);
    float knee = 4.0 * w * (1.0 - w);
    avianAt.z += poseC.x * (w * fz - knee * fy * 0.5);
    avianAt.y += poseC.x * w * fy * 0.7;
    // Tucked back under the tail in flight.
    avianAt = joint + avianTurnX((avianAt - joint) * (1.0 - 0.3 * poseD.z), 1.3 * poseD.z);
  }
  avianAt += objectNormal * (poseD.y * 0.11 * avianKin.z * avianColor.a * (1.0 - step(4.5, part)) * (1.0 - step(0.5, part) * step(part, 2.5)));
  // Body pitch about the hips and a crouch; planted feet stay where they are.
  vec3 hip = vec3(0.0, avianKin.z, avianKin.w);
  float free = 1.0 - leg;
  avianAt = hip + avianTurnX(avianAt - hip, poseC.w * free);
  objectNormal = avianTurnX(objectNormal, poseC.w * free);
  avianAt.y -= poseC.z * free;
}
`;

const AVIAN_FRAGMENT_PARS = /* glsl */ `
varying vec4 vAvian;
varying vec2 vFeather;
varying vec2 vAvianLook;
`;

const AVIAN_FRAGMENT = /* glsl */ `
{
  // Feathers: rows of overlapping scallops, each shaded toward its rim, paler along its shaft and a tone of its own.
  vec2 g = vFeather;
  g.x += 0.5 * floor(g.y);
  vec2 f = fract(g) - 0.5;
  float tone = fract(sin(dot(floor(g), vec2(12.9898, 78.233))) * 43758.5453);
  float rim = smoothstep(0.12, 0.52, length(f * vec2(0.9, 1.0)) * (0.85 + 0.3 * f.y));
  float shaft = 1.0 - smoothstep(0.0, 0.06, abs(f.x));
  float lace = (rim * vAvianLook.y - shaft * 0.05 + (tone - 0.5) * 0.45 * vAvianLook.y) * vAvian.a;
  vec3 colour = vAvian.rgb * (1.0 - lace);
  // Gloss where the plumage has a sheen: dark green that turns to purple with the angle of view.
  float facing = abs(dot(normalize(vViewPosition), normalize(vNormal)));
  vec3 shine = mix(vec3(0.11, 0.05, 0.17), vec3(0.03, 0.19, 0.12), smoothstep(0.35, 0.85, facing + 0.25 * sin(g.y * 1.7)));
  colour = mix(colour, colour * 0.6 + shine * (0.45 + 0.55 * rim), vAvianLook.x * 0.75);
  diffuseColor.rgb *= colour;
}
`;

const AVIAN_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(0.42, roughnessFactor, vAvian.a) - 0.3 * vAvianLook.x;
`;

/** Where a ground animal meets the ground: a soft dark patch, faded per instance by `instanceColor.r`. */
const DECAL_VERTEX = /* glsl */ `
varying vec2 vUv;
varying float vFade;
varying float vDepth;
void main() {
  vUv = uv;
  vFade = instanceColor.r;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const DECAL_FRAGMENT = /* glsl */ `
uniform float decalDepth;
varying vec2 vUv;
varying float vFade;
varying float vDepth;
${SOFT_FOG}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = dot(p, p);
  float a = decalDepth * vFade * (1.0 - smoothstep(0.0, 1.0, r)) * (1.0 - fogAmount(vDepth));
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/** Feathers knocked loose: flung out, slowed by the air, then see-sawing down to lie on the ground. */
const FEATHER_PARS = /* glsl */ `
attribute vec4 featherBorn;    // where, when
attribute vec4 featherFling;   // velocity, seed
attribute vec4 featherLook;    // rgb, size
uniform float lifeTime;
varying vec3 vFeatherTint;
varying vec2 vFeatherUv;
vec3 featherTurnX(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
vec3 featherTurnY(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
vec3 featherTurnZ(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
`;
const FEATHER_VERTEX = /* glsl */ `
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vec3 featherAt;
{
  vFeatherTint = featherLook.rgb;
  vFeatherUv = uv;
  float seed = featherFling.w, age = lifeTime - featherBorn.w, lasts = 7.0 + seed * 4.0;
  float drag = 3.2 + seed * 2.0, sink = 0.45 + seed * 0.5;
  // Flung, slowed, then falling at its own slow pace: the time it lands is known, so it can stop there.
  float lands = (featherBorn.y - 0.02 + featherFling.y / drag) / sink + 1.0 / drag;
  float t = clamp(age, 0.0, max(lands, 0.05)), eased = (1.0 - exp(-drag * t)) / drag;
  float steady = length(windVector);
  vec2 d = steady > 0.0001 ? windVector / steady : vec2(0.0, -1.0);
  float gust = windAt(featherBorn.xz);
  vec3 at = featherBorn.xyz + featherFling.xyz * eased;
  at.y -= sink * (t - eased);
  at.xz += d * gust * 1.6 * (t - eased);
  float sway = t * (2.6 + seed * 2.0) + seed * 40.0, air = 1.0 - smoothstep(lands - 0.5, lands, age);
  at.xz += vec2(sin(sway), cos(sway * 0.8)) * 0.07 * min(1.0, t) * air;
  at.y = max(at.y, 0.012 + seed * 0.01);
  float shown = step(0.0, age) * smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(lasts - 1.2, lasts, age));
  vec3 p = position;
  p.y += 0.35 * p.z * p.z + 0.5 * abs(p.x);
  p *= featherLook.w * shown;
  float tumble = air * (2.0 * sin(sway * 1.3) + (1.0 - min(1.0, t * 2.0)) * 9.0 * seed);
  p = featherTurnY(featherTurnZ(featherTurnX(p, tumble * 0.7), air * 0.9 * cos(sway)), seed * 40.0 + air * sway * 0.4);
  objectNormal = normalize(featherTurnY(featherTurnZ(featherTurnX(vec3(0.0, 1.0, 0.0), tumble * 0.7), air * 0.9 * cos(sway)), seed * 40.0 + air * sway * 0.4));
  featherAt = at + p;
}
`;
const FEATHER_FRAGMENT = /* glsl */ `
{
  vec2 p = vFeatherUv - 0.5;
  float vane = 0.24 * (1.0 - pow(abs(p.y * 2.0), 2.4)) * (0.7 + 0.6 * (0.5 - p.y));
  float edge = vane - abs(p.x);
  diffuseColor.rgb *= vFeatherTint * (1.0 - 0.3 * smoothstep(0.02, 0.0, abs(p.x))) * (0.85 + 0.15 * sin(p.y * 60.0 + p.x * 30.0));
  diffuseColor.a = clamp(0.5 + edge * 16.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Geometry: birds and chickens
// ---------------------------------------------------------------------------------------------

type Paint = readonly [number, number, number];
const paint = (hex: number): Paint => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const blend = (a: Paint, b: Paint, t: number): Paint => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const turnX = (p: V3, a: number): V3 => { const s = Math.sin(a), c = Math.cos(a); return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]]; };
const turnY = (p: V3, a: number): V3 => { const s = Math.sin(a), c = Math.cos(a); return [c * p[0] + s * p[2], p[1], c * p[2] - s * p[0]]; };
const turnZ = (p: V3, a: number): V3 => { const s = Math.sin(a), c = Math.cos(a); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };

const BODY = 0, WING = 1, WING_OTHER = 2, NECK = 3, TAIL = 4, LEG = 5, LEG_OTHER = 6;
const NOWHERE: V3 = [0, 0, 0];

type Vertex = { colour: Paint; plumage?: number; sheen?: number; part?: number; w?: number; w2?: number; pivot?: V3; aux?: V3; u?: number; v?: number };

/** A growing mesh with the attributes the avian shader reads. */
class Form {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly colour: number[] = [];
  readonly pivot: number[] = [];
  readonly rig: number[] = [];
  readonly wing: number[] = [];
  readonly wingNormal: number[] = [];
  readonly index: number[] = [];
  get count() { return this.position.length / 3; }
  add(x: number, y: number, z: number, v: Vertex) {
    const pivot = v.pivot ?? NOWHERE, aux = v.aux ?? NOWHERE;
    this.position.push(x, y, z); this.normal.push(0, 1, 0); this.uv.push(v.u ?? 0, v.v ?? 0);
    this.colour.push(v.colour[0], v.colour[1], v.colour[2], v.plumage ?? 1);
    this.pivot.push(pivot[0], pivot[1], pivot[2]); this.rig.push(v.part ?? BODY, v.w ?? 0, v.w2 ?? 0, v.sheen ?? 0);
    this.wing.push(aux[0], aux[1], aux[2]); this.wingNormal.push(0, 1, 0);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) { this.index.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.index.push(a, b, d, b, c, d); }
  /** Smooth normals for everything added since the marks, in the standing pose or on the spread wing. */
  shade(vertexFrom: number, indexFrom: number, spread = false) {
    const source = spread ? this.wing : this.position, target = spread ? this.wingNormal : this.normal;
    for (let i = vertexFrom * 3; i < target.length; i += 1) target[i] = 0;
    for (let i = indexFrom; i < this.index.length; i += 3) {
      const a = this.index[i] * 3, b = this.index[i + 1] * 3, c = this.index[i + 2] * 3;
      const ux = source[b] - source[a], uy = source[b + 1] - source[a + 1], uz = source[b + 2] - source[a + 2];
      const vx = source[c] - source[a], vy = source[c + 1] - source[a + 1], vz = source[c + 2] - source[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { target[k] += nx; target[k + 1] += ny; target[k + 2] += nz; }
    }
    for (let i = vertexFrom * 3; i < target.length; i += 3) {
      const length = Math.hypot(target[i], target[i + 1], target[i + 2]);
      if (length > 1e-12) { target[i] /= length; target[i + 1] /= length; target[i + 2] /= length; } else { target[i] = 0; target[i + 1] = 1; target[i + 2] = 0; }
    }
  }
  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute("avianColor", new THREE.Float32BufferAttribute(this.colour, 4));
    // Sixteen attribute slots is all there is: the spread wing's normal rides in the spare fourth components.
    const pivot = new Float32Array(this.count * 4), wing = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i += 1) {
      pivot.set([this.pivot[i * 3], this.pivot[i * 3 + 1], this.pivot[i * 3 + 2], this.wingNormal[i * 3]], i * 4);
      wing.set([this.wing[i * 3], this.wing[i * 3 + 1], this.wing[i * 3 + 2], this.wingNormal[i * 3 + 2]], i * 4);
    }
    geometry.setAttribute("avianPivot", new THREE.BufferAttribute(pivot, 4));
    geometry.setAttribute("avianRig", new THREE.Float32BufferAttribute(this.rig, 4));
    geometry.setAttribute("avianWing", new THREE.BufferAttribute(wing, 4));
    geometry.setIndex(this.index);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

type Ring = { at: V3; w: number; h: number; vertex: (dorsal: number, side: number) => Vertex };

/** A skin lofted over rings along a path: bodies, necks, legs, toes. The seam runs along the underside. */
function tube(form: Form, rings: Ring[], segs: number, cols: number, rows = 1) {
  const from = form.count, indexFrom = form.index.length;
  let run = 0;
  for (let i = 0; i < rings.length; i += 1) {
    const prev = rings[Math.max(0, i - 1)].at, next = rings[Math.min(rings.length - 1, i + 1)].at, ring = rings[i];
    let tx = next[0] - prev[0], ty = next[1] - prev[1], tz = next[2] - prev[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const rx = Math.abs(tx) > 0.9 ? 0 : 1, rz = 1 - rx;
    let bx = ty * rz, by = tz * rx - tx * rz, bz = -ty * rx;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    const sx = by * tz - bz * ty, sy = bz * tx - bx * tz, sz = bx * ty - by * tx;
    if (i > 0) run += Math.hypot(ring.at[0] - rings[i - 1].at[0], ring.at[1] - rings[i - 1].at[1], ring.at[2] - rings[i - 1].at[2]);
    for (let j = 0; j <= segs; j += 1) {
      const a = -Math.PI / 2 + (j / segs) * TAU, ca = Math.cos(a), sa = Math.sin(a), data = ring.vertex(sa, ca);
      form.add(ring.at[0] + sx * ring.w * ca + bx * ring.h * sa, ring.at[1] + sy * ring.w * ca + by * ring.h * sa, ring.at[2] + sz * ring.w * ca + bz * ring.h * sa,
        { ...data, u: (j / segs) * cols, v: run * rows });
    }
  }
  const step = segs + 1;
  for (let i = 0; i < rings.length - 1; i += 1) for (let j = 0; j < segs; j += 1) {
    const a = from + i * step + j;
    form.quad(a, a + 1, a + 1 + step, a + step);
  }
  form.shade(from, indexFrom);
  // The two edges of the seam share one normal.
  for (let i = 0; i < rings.length; i += 1) {
    const a = (from + i * step) * 3, b = (from + i * step + segs) * 3;
    for (let k = 0; k < 3; k += 1) { const mean = form.normal[a + k] + form.normal[b + k]; form.normal[a + k] = mean; form.normal[b + k] = mean; }
    const length = Math.hypot(form.normal[a], form.normal[a + 1], form.normal[a + 2]) || 1;
    for (let k = 0; k < 3; k += 1) { form.normal[a + k] /= length; form.normal[b + k] /= length; }
  }
}

type WingShape = { span: number; chord: number; point: number; sweep: number; camber: number };

/** The folded wing as a shell round the body: its radii, the height of the body's axis fore and aft, how far it tapers, the arc it covers, how far the tips climb, its length and where it starts. */
type WingRest = { rx: number; ry: number; y0: number; y1: number; taper: number; from: number; to: number; lift: number; length: number; z0: number };

/** Both wings: built spread (what the shader beats) and, as the pose at rest, folded round the body with the tips over the rump. */
function wings(form: Form, shoulder: V3, shape: WingShape, ns: number, nc: number, rest: WingRest, cell: number, colour: (t: number, c: number) => [Paint, number]) {
  const from = form.count, indexFrom = form.index.length, knee = 0.78 - 0.42 * shape.point, shut: V3[] = [];
  for (let i = 0; i <= ns; i += 1) {
    const t = i / ns, taper = t < knee ? 1 : Math.pow(Math.max(0, 1 - Math.pow((t - knee) / (1 - knee), 2.2)), 0.7);
    const chord = shape.chord * (1 - 0.18 * t) * Math.max(taper, 0.03), lead = shape.chord * 0.32 - shape.sweep * shape.chord * 1.7 * t * t;
    for (let j = 0; j <= nc; j += 1) {
      const c = j / nc, [tint, sheen] = colour(t, c);
      const q: V3 = [t * shape.span, shape.camber * shape.chord * 4 * c * (1 - c) - 0.04 * shape.span * t * t, lead - c * chord];
      form.add(0, 0, 0, { colour: tint, sheen, part: WING, w: t, w2: rest.length / shape.span, pivot: shoulder, aux: q, u: (t * shape.span) / cell, v: (c * shape.chord) / cell });
      // Folded: the span runs back along the flank, the chord wraps up round the body toward the spine.
      const reach = (c * chord) / shape.chord, radius = 1 - rest.taper * Math.pow(t, 2.5), theta = Math.min(1.45, rest.from + rest.lift * t * t + reach * (rest.to - rest.from));
      shut.push([rest.rx * radius * Math.cos(theta), rest.y0 + (rest.y1 - rest.y0) * t + rest.ry * radius * Math.sin(theta), rest.z0 - t * rest.length]);
    }
  }
  for (let i = 0; i < ns; i += 1) for (let j = 0; j < nc; j += 1) {
    const a = from + i * (nc + 1) + j, b = a + nc + 1;
    form.quad(a, b, b + 1, a + 1);
  }
  form.shade(from, indexFrom, true);
  const count = form.count - from, indexTo = form.index.length;
  for (let n = 0; n < count; n += 1) {
    const k = from + n;
    const copy = form.add(0, 0, 0, {
      colour: [form.colour[k * 4], form.colour[k * 4 + 1], form.colour[k * 4 + 2]], plumage: form.colour[k * 4 + 3], sheen: form.rig[k * 4 + 3], part: WING_OTHER, w: form.rig[k * 4 + 1], w2: form.rig[k * 4 + 2],
      pivot: [-shoulder[0], shoulder[1], shoulder[2]], aux: [form.wing[k * 3], form.wing[k * 3 + 1], form.wing[k * 3 + 2]], u: form.uv[k * 2], v: form.uv[k * 2 + 1],
    });
    for (let c = 0; c < 3; c += 1) form.wingNormal[copy * 3 + c] = form.wingNormal[k * 3 + c];
    form.position[k * 3] = shut[n][0]; form.position[k * 3 + 1] = shut[n][1]; form.position[k * 3 + 2] = shut[n][2];
    form.position[copy * 3] = -shut[n][0]; form.position[copy * 3 + 1] = shut[n][1]; form.position[copy * 3 + 2] = shut[n][2];
  }
  for (let i = indexFrom; i < indexTo; i += 3) form.tri(form.index[i] + count, form.index[i + 2] + count, form.index[i + 1] + count);
  form.shade(from, indexFrom);
}

/** A fan of tail feathers from a root: `rise` tips it up, `tent` folds it into a ridge. */
function tailFan(form: Form, root: V3, length: number, angle: number, o: { fork?: number; rise?: number; tent?: number; nf: number; cell: number }, colour: (r: number, lateral: number) => [Paint, number]) {
  const from = form.count, indexFrom = form.index.length, rows = [0.08, 0.5, 0.85, 1], rise = o.rise ?? -0.15, slope = Math.hypot(1, rise);
  for (let i = 0; i < rows.length; i += 1) for (let j = 0; j <= o.nf; j += 1) {
    const lateral = (j / o.nf) * 2 - 1, phi = lateral * angle * (0.35 + 0.65 * rows[i]);
    const reach = length * rows[i] * (1 - (o.fork ?? 0) * (1 - Math.abs(lateral)) * rows[i]) * (i === rows.length - 1 ? 1 - 0.1 * lateral * lateral : 1), [tint, sheen] = colour(rows[i], lateral);
    form.add(root[0] + Math.sin(phi) * reach, root[1] + (rise * reach) / slope - Math.abs(lateral) * (o.tent ?? 0.06) * reach, root[2] - (Math.cos(phi) * reach) / slope,
      { colour: tint, sheen, part: TAIL, w: rows[i], w2: lateral, pivot: root, u: (lateral * angle * length) / o.cell, v: reach / o.cell });
  }
  for (let i = 0; i < rows.length - 1; i += 1) for (let j = 0; j < o.nf; j += 1) {
    const a = from + i * (o.nf + 1) + j, b = a + o.nf + 1;
    form.quad(a, a + 1, b + 1, b);
  }
  form.shade(from, indexFrom);
}

/** An eye on each side of the head: a dark pupil proud of a ring of iris. */
function eyes(form: Form, at: V3, radius: number, iris: Paint, rig: Vertex) {
  for (const side of [1, -1]) {
    const from = form.count, indexFrom = form.index.length;
    form.add(side * (at[0] + radius * 0.55), at[1], at[2], { ...rig, colour: [0.004, 0.004, 0.005], plumage: 0 });
    for (let j = 0; j < 7; j += 1) {
      const a = (j / 7) * TAU;
      form.add(side * (at[0] - radius * 0.2), at[1] + Math.cos(a) * radius, at[2] + Math.sin(a) * radius, { ...rig, colour: iris, plumage: 0 });
    }
    for (let j = 0; j < 7; j += 1) { if (side > 0) form.tri(from, from + 1 + j, from + 1 + ((j + 1) % 7)); else form.tri(from, from + 1 + ((j + 1) % 7), from + 1 + j); }
    form.shade(from, indexFrom);
  }
}

type BirdLook = {
  /** Linear scale of the pigeon-shaped template, body girth, neck length and head size relative to it. */
  size: number; girth: number; neck: number; head: number;
  beak: { length: number; depth: number; colour: number; cere?: number; tip?: number };
  wing: WingShape;
  tail: { length: number; angle: number; fork: number };
  leg: { length: number; thick: number; colour: number };
  eye: number;
  /** Folded wing: the share of its span it reaches back along the body. */
  fold: number;
  lacing: number;
  /** Region 0 body (along 0 tail .. 1 breast), 1 neck, 2 head; dorsal -1 belly .. 1 back. */
  body: (region: number, along: number, dorsal: number) => [Paint, number];
  wingColour: (t: number, c: number) => [Paint, number];
  tailColour: (r: number, lateral: number) => [Paint, number];
};

// z, height above the hip, half width, half height: a pigeon from tail root to forehead.
const BIRD_TEMPLATE: Array<[number, number, number, number]> = [
  [-0.1, 0.016, 0, 0], [-0.092, 0.018, 0.014, 0.012], [-0.068, 0.024, 0.03, 0.026], [-0.038, 0.03, 0.044, 0.041], [-0.004, 0.036, 0.05, 0.049],
  [0.03, 0.045, 0.048, 0.048], [0.054, 0.058, 0.04, 0.041], [0.068, 0.076, 0.03, 0.031], [0.076, 0.096, 0.022, 0.023],
  [0.082, 0.112, 0.0195, 0.0195], [0.094, 0.117, 0.0185, 0.018], [0.106, 0.114, 0.0135, 0.0135],
];

function buildBird(look: BirdLook, high: boolean) {
  const form = new Form(), s = look.size, hip = look.leg.length, segs = high ? 12 : 8;
  const nbz = 0.068 * s, nby = hip + 0.076 * s, ntz = nbz + 0.014 * s * look.neck, nty = nby + 0.036 * s * look.neck;
  const neckBase: V3 = [0, nby, nbz], skull: V3 = [0, nty + 0.002 * s, ntz + 0.004 * s * look.head];
  const rings: Ring[] = BIRD_TEMPLATE.map(([z, y, w, h], i) => {
    const region = i <= 6 ? 0 : i <= 8 ? 1 : 2, along = Math.min(1, i / 6);
    const vertex = (dorsal: number): Vertex => {
      const [colour, sheen] = look.body(region, along, dorsal);
      return region === 0 ? { colour, sheen } : { colour, sheen, part: NECK, w: i === 7 ? 0 : i === 8 ? 0.55 : 1, w2: i <= 8 ? 0 : i === 9 ? 0.5 : 1, pivot: neckBase, aux: skull };
    };
    if (i <= 6) return { at: [0, hip + y * s, z * s], w: w * s * look.girth, h: h * s * look.girth, vertex };
    if (i <= 8) { const mix = i === 7 ? look.girth : (look.girth + look.head) / 2; return { at: [0, nby + (y - 0.076) * s * look.neck, nbz + (z - 0.068) * s * look.neck], w: w * s * mix, h: h * s * mix, vertex }; }
    return { at: [0, nty + (y - 0.112) * s * look.head, ntz + (z - 0.082) * s * look.head], w: w * s * look.head, h: h * s * look.head, vertex };
  });
  // The beak carries on from the forehead, a little downward.
  const brow = rings[rings.length - 1].at, beak = look.beak, headRig: Vertex = { colour: paint(beak.colour), plumage: 0, part: NECK, w: 1, w2: 1, pivot: neckBase, aux: skull };
  const beakAt = (along: number): V3 => [0, brow[1] - 0.004 * s * look.head - along * beak.length * 0.27, brow[2] + 0.005 * s * look.head + along * beak.length * 0.96];
  rings.push({ at: beakAt(0), w: beak.depth * 0.48, h: beak.depth * 0.55, vertex: (dorsal) => ({ ...headRig, colour: beak.cere !== undefined && dorsal > 0.2 ? paint(beak.cere) : paint(beak.colour) }) });
  rings.push({ at: beakAt(0.55), w: beak.depth * 0.3, h: beak.depth * 0.36, vertex: () => headRig });
  rings.push({ at: beakAt(1), w: 0, h: 0, vertex: () => ({ ...headRig, colour: paint(beak.tip ?? beak.colour) }) });
  tube(form, rings, segs, Math.round(14 * Math.sqrt(look.girth)), 1 / (0.02 * s));
  eyes(form, [0.0178 * s * look.head, nty + 0.007 * s * look.head, ntz + 0.012 * s * look.head], 0.0044 * s * look.head, paint(look.eye), headRig);
  wings(form, [0.034 * s * look.girth, hip + 0.06 * s, 0.036 * s], look.wing, high ? 8 : 5, 3,
    { rx: 0.054 * s * look.girth, ry: 0.053 * s * look.girth, y0: hip + 0.052 * s, y1: hip + 0.021 * s, taper: 0.6, from: -0.45, to: 1.2, lift: 1.15, length: look.fold * look.wing.span, z0: 0.05 * s }, 0.026 * s, look.wingColour);
  tailFan(form, [0, hip + 0.02 * s, -0.086 * s], look.tail.length, look.tail.angle, { fork: look.tail.fork, nf: high ? 6 : 4, cell: 0.03 * s }, look.tailColour);
  // Legs: thin shanks and four toes that lie on the perch.
  const legColour = paint(look.leg.colour), t = look.leg.thick;
  for (const side of [1, -1]) {
    const part = side > 0 ? LEG : LEG_OTHER, hipAt: V3 = [side * 0.02 * s * look.girth, hip + 0.004 * s, -0.012 * s], foot: V3 = [side * 0.023 * s * look.girth, t, -0.004 * s];
    const rig = (w: number): Vertex => ({ colour: legColour, plumage: 0, part, w, pivot: hipAt });
    tube(form, [
      { at: hipAt, w: t * 1.5, h: t * 1.5, vertex: () => rig(0) }, { at: [foot[0], hip * 0.5, foot[2] - 0.006 * s], w: t, h: t, vertex: () => rig(0.5) }, { at: foot, w: t, h: t, vertex: () => rig(1) },
    ], 4, 1);
    const from = form.count, indexFrom = form.index.length, reach = 0.026 * s * (0.6 + 0.4 * look.girth);
    for (const [angle, length] of [[-0.6, reach], [0, reach * 1.15], [0.6, reach], [Math.PI, reach * 0.6]]) {
      const dx = Math.sin(angle + side * 0.12), dz = Math.cos(angle + side * 0.12), a = form.count;
      form.add(foot[0] - dz * t * 0.9, t * 0.9, foot[2] + dx * t * 0.9, rig(1)); form.add(foot[0] + dz * t * 0.9, t * 0.9, foot[2] - dx * t * 0.9, rig(1));
      form.add(foot[0] + dx * length, t * 0.25, foot[2] + dz * length, rig(1));
      form.tri(a, a + 1, a + 2);
    }
    form.shade(from, indexFrom);
  }
  return { geometry: form.build(), kin: [hip, -0.012 * s] as [number, number], triangles: form.index.length / 3, lacing: look.lacing };
}

const GREY = paint(0x8d949e);

const BIRD_LOOKS: Record<BirdSpecies, BirdLook> = {
  // A rock dove: blue-grey, two dark bars on the wing, a glossed neck.
  pigeon: {
    size: 1, girth: 1, neck: 1, head: 1,
    beak: { length: 0.019, depth: 0.011, colour: 0x2b2b30, cere: 0xd8d2c8 },
    wing: { span: 0.29, chord: 0.125, point: 0.55, sweep: 0.12, camber: 0.07 },
    tail: { length: 0.115, angle: 0.26, fork: 0 }, leg: { length: 0.043, thick: 0.0032, colour: 0xa63a40 }, eye: 0xe07a18, fold: 0.5, lacing: 0.16,
    body: (region, along, dorsal) => region === 2 ? [paint(0x4f5966), 0] : region === 1 ? [paint(0x3e4652), 0.7] : along > 0.75 ? [blend(paint(0x6a6474), GREY, Math.max(0, dorsal)), 0.25 * (along - 0.75) * 4] : [blend(paint(0x7b828c), dorsal > 0 && along < 0.4 ? paint(0xb9bec4) : GREY, Math.abs(dorsal)), 0],
    wingColour: (t, c) => [t > 0.62 ? blend(paint(0x8a9099), paint(0x25272c), (t - 0.62) / 0.38) : (c > 0.5 && c < 0.66) || c > 0.86 ? paint(0x1e2024) : paint(0x9aa0a8), 0],
    tailColour: (r) => [r > 0.8 ? paint(0x1c1d21) : paint(0x70767f), 0],
  },
  // A cock house sparrow: chestnut and streaked brown above, grey below, a black bib.
  sparrow: {
    size: 0.46, girth: 1.18, neck: 0.8, head: 1.3,
    beak: { length: 0.0095, depth: 0.0082, colour: 0x2c2620 },
    wing: { span: 0.112, chord: 0.062, point: 0.3, sweep: 0.1, camber: 0.08 },
    tail: { length: 0.058, angle: 0.2, fork: 0.12 }, leg: { length: 0.022, thick: 0.0016, colour: 0x9a7460 }, eye: 0x1a120c, fold: 0.52, lacing: 0.38,
    body: (region, along, dorsal) => region === 2 ? [dorsal > 0.35 ? paint(0x77726c) : dorsal > -0.3 ? paint(0x6e3c22) : paint(0x16130f), 0] : region === 1 ? [dorsal > 0.1 ? paint(0x6e3c22) : dorsal > -0.5 ? paint(0xa8a294) : paint(0x16130f), 0] : [dorsal > 0.15 ? paint(0x6b4a2a) : along > 0.8 && dorsal < -0.6 ? paint(0x2a241e) : paint(0x9d9484), 0],
    wingColour: (t, c) => [c > 0.28 && c < 0.4 && t < 0.6 ? paint(0xc4beb0) : t > 0.6 ? paint(0x3d2e20) : paint(0x66482a), 0],
    tailColour: () => [paint(0x4d3a28), 0],
  },
  // A gull: white, a pale grey mantle, black wingtips with white mirrors.
  gull: {
    size: 1.5, girth: 0.92, neck: 1.1, head: 0.9,
    beak: { length: 0.05, depth: 0.017, colour: 0xe6bd2e, tip: 0xc23a1e },
    wing: { span: 0.62, chord: 0.17, point: 0.95, sweep: 0.2, camber: 0.08 },
    tail: { length: 0.14, angle: 0.3, fork: 0 }, leg: { length: 0.075, thick: 0.0045, colour: 0xd7a79a }, eye: 0xf0e6a0, fold: 0.34, lacing: 0.05,
    body: (region, along, dorsal) => [region === 0 && dorsal > 0.25 && along > 0.15 && along < 0.95 ? paint(0x848d97) : paint(0xcfcfca), 0],
    wingColour: (t, c) => [t > 0.94 ? paint(0xcfcfca) : t > 0.74 ? paint(0x121316) : c > 0.9 ? paint(0xcfcfca) : paint(0x848d97), 0],
    tailColour: () => [paint(0xcfcfca), 0],
  },
  // A crow: black all over with a blue-purple gloss.
  crow: {
    size: 1.38, girth: 1, neck: 1, head: 1.05,
    beak: { length: 0.055, depth: 0.021, colour: 0x101012 },
    wing: { span: 0.45, chord: 0.2, point: 0.2, sweep: 0.08, camber: 0.07 },
    tail: { length: 0.17, angle: 0.3, fork: 0 }, leg: { length: 0.07, thick: 0.005, colour: 0x141416 }, eye: 0x1c120c, fold: 0.5, lacing: 0.3,
    body: (region, _along, dorsal) => [paint(0x0e0e12), region === 0 ? 0.07 + 0.07 * Math.max(0, dorsal) : 0.1],
    wingColour: (t) => [paint(0x0c0c10), t < 0.6 ? 0.13 : 0.05],
    tailColour: () => [paint(0x0b0b0e), 0.07],
  },
  // A swift: a sooty cigar on scythe wings, never seen at rest.
  swift: {
    size: 0.52, girth: 0.82, neck: 0.6, head: 1.05,
    beak: { length: 0.004, depth: 0.006, colour: 0x1a1612 },
    wing: { span: 0.205, chord: 0.05, point: 1, sweep: 0.75, camber: 0.05 },
    tail: { length: 0.06, angle: 0.3, fork: 0.5 }, leg: { length: 0.01, thick: 0.0012, colour: 0x1a1612 }, eye: 0x100c08, fold: 0.72, lacing: 0.2,
    body: (region, _along, dorsal) => [region === 1 && dorsal < -0.3 ? paint(0x8f867a) : paint(0x2c2620), 0],
    wingColour: () => [paint(0x29231e), 0],
    tailColour: () => [paint(0x262019), 0],
  },
};

/** A hen or a cock: plumage is left near white so the instance tint is the breed. */
function buildChicken(cock: boolean, high: boolean) {
  const form = new Form(), k = cock ? 1.16 : 1, segs = high ? 16 : 10;
  const at = (y: number, z: number): V3 => [0, y * k, z * k];
  const neckBase = at(0.3, 0.128), skull = at(0.392 + (cock ? 0.012 : 0), 0.15);
  const white: Paint = [1, 1, 1], hackle: Paint = cock ? paint(0xa9702a) : [1.12, 1.04, 0.9], saddle: Paint = cock ? paint(0x6a2c14) : white, dark: Paint = cock ? paint(0x0d1512) : [0.62, 0.6, 0.58];
  const face = paint(0xa32a24), horn = paint(0xc9a35c), shank = paint(0xc59a2c), red = paint(0xb4181a), lift = cock ? 0.012 : 0;
  // z, y, half width, half height, region (0 body, 1 neck, 2 head, 3 face, 4 beak)
  const stations: Array<[number, number, number, number, number]> = [
    [-0.172, 0.292, 0, 0, 0], [-0.166, 0.29, 0.024, 0.026, 0], [-0.142, 0.282, 0.056, 0.052, 0], [-0.095, 0.26, 0.086, 0.078, 0], [-0.035, 0.237, 0.099, 0.092, 0],
    [0.03, 0.236, 0.096, 0.09, 0], [0.085, 0.25, 0.081, 0.08, 0], [0.118, 0.274, 0.062, 0.063, 0], [0.132, 0.303, 0.045, 0.046, 1], [0.14, 0.338 + lift * 0.5, 0.032, 0.034, 1],
    [0.145, 0.368 + lift, 0.0265, 0.028, 1], [0.149, 0.392 + lift, 0.025, 0.026, 2], [0.164, 0.402 + lift, 0.0245, 0.025, 2], [0.179, 0.398 + lift, 0.018, 0.02, 3],
    [0.19, 0.393 + lift, 0.009, 0.011, 4], [0.203, 0.388 + lift, 0.0055, 0.0065, 4], [0.215, 0.381 + lift, 0, 0, 4],
  ];
  const rings: Ring[] = stations.map(([z, y, w, h, region], i) => ({
    at: at(y, z), w: w * k * (region === 1 && cock ? 1.12 : 1), h: h * k,
    vertex: (dorsal): Vertex => {
      if (region === 0) {
        const along = i / 7, breast = along > 0.6 && dorsal < 0.2;
        return { colour: cock ? (breast || dorsal < -0.3 ? dark : along < 0.45 ? saddle : paint(0x5c2412)) : blend(white, [0.86, 0.84, 0.82], Math.max(0, -dorsal)), sheen: cock && (breast || dorsal < -0.3) ? 0.35 : 0, plumage: cock ? 0.25 : 1 };
      }
      const rig = { part: NECK, w: i === 8 ? 0.12 : i === 9 ? 0.5 : i === 10 ? 0.85 : 1, w2: i <= 10 ? 0 : i === 11 ? 0.6 : 1, pivot: neckBase, aux: skull };
      if (region === 1) return { ...rig, colour: hackle, plumage: cock ? 0.2 : 1 };
      if (region === 2) return { ...rig, colour: dorsal > -0.1 || i === 11 ? hackle : face, plumage: dorsal > -0.1 || i === 11 ? (cock ? 0.2 : 1) : 0 };
      if (region === 3) return { ...rig, colour: face, plumage: 0 };
      return { ...rig, colour: horn, plumage: 0 };
    },
  }));
  tube(form, rings, segs, 30, 1 / 0.019);
  const headRig: Vertex = { colour: red, plumage: 0, part: NECK, w: 1, w2: 1, pivot: neckBase, aux: skull };
  eyes(form, [0.0235 * k, (0.404 + lift) * k, 0.169 * k], 0.0052 * k, paint(0xd9861c), headRig);
  // Comb: a serrated blade along the crown, two skins and the rim between them.
  {
    const tall = cock ? 0.042 : 0.017, thick = 0.0028 * k, points = cock ? 6 : 5, from = form.count, indexFrom = form.index.length, row: number[][] = [];
    for (const side of [1, -1]) {
      const base: number[] = [], top: number[] = [];
      for (let i = 0; i <= points * 2; i += 1) {
        const u = i / (points * 2), z = (0.186 - u * 0.05) * k, crown = (0.418 + lift - Math.pow(Math.abs(u - 0.42), 2) * 0.09) * k;
        const peak = i % 2 === 1 ? 1 : 0.42, bulge = Math.sin(Math.PI * Math.min(1, u * 1.15 + 0.08)) * (cock ? 1 : 0.9);
        base.push(form.add(side * thick, crown - 0.006 * k, z, headRig));
        top.push(form.add(side * thick * 0.4, crown + tall * k * peak * bulge, z - (cock ? 0.004 : 0.002) * k * peak, headRig));
      }
      for (let i = 0; i < points * 2; i += 1) { if (side > 0) form.quad(base[i], base[i + 1], top[i + 1], top[i]); else form.quad(base[i + 1], base[i], top[i], top[i + 1]); }
      row.push(top);
    }
    for (let i = 0; i < points * 2; i += 1) form.quad(row[0][i], row[0][i + 1], row[1][i + 1], row[1][i]);
    form.shade(from, indexFrom);
  }
  // Wattles under the beak and a pale ear lobe.
  for (const side of [1, -1]) {
    const drop = (cock ? 0.046 : 0.022) * k, x = side * 0.0085 * k, y = (0.383 + lift) * k, z = 0.181 * k;
    tube(form, [
      { at: [x, y, z], w: 0.004 * k, h: 0.006 * k, vertex: () => headRig }, { at: [x * 1.2, y - drop * 0.55, z - 0.002], w: 0.006 * k, h: 0.011 * k, vertex: () => headRig },
      { at: [x * 1.2, y - drop * 0.9, z - 0.003], w: 0.0045 * k, h: 0.008 * k, vertex: () => headRig }, { at: [x * 1.2, y - drop, z - 0.003], w: 0, h: 0, vertex: () => headRig },
    ], 6, 1);
  }
  // Wings, small and rounded; they only open when she bolts.
  const wingTint = (t: number, c: number): [Paint, number] => cock ? [c > 0.45 && c < 0.7 && t < 0.7 ? paint(0x12303a) : t > 0.55 ? paint(0x7c4c22) : saddle, c > 0.45 && c < 0.7 && t < 0.7 ? 0.5 : 0] : [blend(white, [0.72, 0.7, 0.68], t * c), 0];
  const before = form.count;
  wings(form, [0.078 * k, 0.292 * k, 0.062 * k], { span: 0.225 * k, chord: 0.15 * k, point: 0.15, sweep: 0.1, camber: 0.1 }, high ? 7 : 5, high ? 4 : 3,
    { rx: 0.105 * k, ry: 0.098 * k, y0: 0.243 * k, y1: 0.262 * k, taper: 0.18, from: -0.55, to: 0.75, lift: 0.5, length: 0.18 * k, z0: 0.078 * k }, 0.025, wingTint);
  if (cock) for (let i = before; i < form.count; i += 1) form.colour[i * 4 + 3] = 0.25;
  // Tail: a tented fan held high; the cock adds a spray of sickles that arch over and droop.
  const root: V3 = at(0.288, -0.15);
  tailFan(form, root, (cock ? 0.2 : 0.17) * k, 0.36, { rise: cock ? 1.5 : 0.95, tent: 0.95, nf: high ? 8 : 6, cell: 0.04 }, (r) => [cock ? dark : blend([0.8, 0.78, 0.76], [0.52, 0.5, 0.49], r), cock ? 0.45 : 0]);
  if (cock) {
    for (let i = 0; i < form.count; i += 1) if (form.rig[i * 4] === TAIL) form.colour[i * 4 + 3] = 0.15;
    const from = form.count, indexFrom = form.index.length, steps = high ? 8 : 5;
    for (let n = 0; n < 9; n += 1) {
      const spread = (n - 4) / 4, reach = (0.3 - 0.07 * Math.abs(spread) + 0.03 * ((n * 7) % 3)) * k, bend = 2.3 + 0.35 * ((n * 5) % 4) / 3, wide = 0.016 * k;
      let y = root[1] + 0.01, z = root[2] + 0.01, x = spread * 0.022 * k;
      const a = form.count;
      for (let i = 0; i <= steps; i += 1) {
        const u = i / steps, phi = 1.25 - u * bend, half = wide * Math.sin(Math.PI * Math.min(1, 0.12 + u * 0.88)) + 0.0015;
        for (const edge of [-1, 1]) form.add(x + edge * half, y, z, { colour: dark, plumage: 0.15, sheen: 0.32, part: TAIL, w: 0.3 + 0.7 * u, w2: spread, pivot: root, u: edge * 0.5, v: u * 6 });
        y += (Math.sin(phi) * reach) / steps; z -= (Math.cos(phi) * reach) / steps; x += (spread * 0.05 * k) / steps;
      }
      for (let i = 0; i < steps; i += 1) form.quad(a + i * 2, a + i * 2 + 1, a + i * 2 + 3, a + i * 2 + 2);
    }
    form.shade(from, indexFrom);
  }
  // Legs: a feathered thigh, a scaled shank and four toes.
  for (const side of [1, -1]) {
    const part = side > 0 ? LEG : LEG_OTHER, x = side * 0.05 * k, hipAt: V3 = [x, 0.2 * k, -0.02 * k], hock: V3 = [x * 1.04, 0.105 * k, -0.04 * k], ankle: V3 = [x * 1.04, 0.014 * k, -0.012 * k];
    const feather = (w: number): Vertex => ({ colour: cock ? dark : [0.9, 0.88, 0.86], sheen: cock ? 0.3 : 0, plumage: cock ? 0.25 : 1, part, w, pivot: hipAt });
    const scale = (w: number): Vertex => ({ colour: shank, plumage: 0, part, w, pivot: hipAt });
    tube(form, [
      { at: [x * 0.9, 0.225 * k, -0.012 * k], w: 0.044 * k, h: 0.05 * k, vertex: () => feather(0) }, { at: [x, 0.165 * k, -0.028 * k], w: 0.036 * k, h: 0.04 * k, vertex: () => feather(0.2) },
      { at: [x * 1.03, 0.12 * k, -0.038 * k], w: 0.02 * k, h: 0.022 * k, vertex: () => feather(0.42) }, { at: hock, w: 0.0105 * k, h: 0.0115 * k, vertex: () => feather(0.5) },
    ], high ? 8 : 6, 12, 1 / 0.019);
    tube(form, [
      { at: hock, w: 0.0075 * k, h: 0.0085 * k, vertex: () => scale(0.5) }, { at: [x * 1.04, 0.06 * k, -0.027 * k], w: 0.0062 * k, h: 0.0068 * k, vertex: () => scale(0.75) }, { at: ankle, w: 0.0075 * k, h: 0.0075 * k, vertex: () => scale(1) },
    ], 5, 1);
    for (const [angle, length] of [[-0.55, 0.05], [0, 0.058], [0.55, 0.05], [Math.PI, 0.024]]) {
      const dx = Math.sin(angle + side * 0.1), dz = Math.cos(angle + side * 0.1), reach = length * k;
      tube(form, [
        { at: [ankle[0], 0.009 * k, ankle[2]], w: 0.0055 * k, h: 0.0055 * k, vertex: () => scale(1) }, { at: [ankle[0] + dx * reach * 0.6, 0.0065 * k, ankle[2] + dz * reach * 0.6], w: 0.0042 * k, h: 0.004 * k, vertex: () => scale(1) },
        { at: [ankle[0] + dx * reach, 0.004 * k, ankle[2] + dz * reach], w: 0.001, h: 0.001, vertex: () => ({ ...scale(1), colour: [0.2, 0.17, 0.12] }) },
      ], 4, 1);
    }
  }
  return { geometry: form.build(), kin: [0.2 * k, -0.02 * k] as [number, number], triangles: form.index.length / 3, height: 0.44 * k };
}

// ---------------------------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------------------------

export function createLife(kit: Kit, options: RangeOptions, config: { seed?: number; wind: Wind }): Life {
  const { scene, high } = kit;
  const { wind } = config;
  const baseSeed = config.seed ?? 1;
  let salt = 0;
  /** A random stream of its own for each thing built, so adding one does not reshuffle the others. */
  const stream = (name: number) => rng(baseSeed * 7919 + name * 104729 + (salt += 1) * 31);
  const scaled = (count: number) => (high ? count : Math.max(1, Math.ceil(count / 2)));

  const shared = {
    lifeTime: { value: 0 },
    lifeViewport: { value: 1080 },
    lifeAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) },
    lifeSun: { value: new THREE.Color(0, 0, 0) },
    lifeSunDir: { value: new THREE.Vector3(0, 1, 0) },
    lifeNoise: { value: null as THREE.Texture | null },
  };
  const windUniforms = { windTime: wind.uniforms.windTime, windVector: wind.uniforms.windVector, windGusts: wind.uniforms.windGusts };

  const ticks: Array<(time: number, dt: number) => void> = [];
  const startles: Array<(x: number, y: number, z: number, loudness: number, time: number) => void> = [];
  const strikes: Array<(object: THREE.Object3D, point: THREE.Vector3, time: number) => boolean> = [];
  const shootable: THREE.Object3D[] = [];
  const owned: THREE.Object3D[] = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const restores: Array<() => void> = [];
  const own = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item; };
  let time = 0, lastNow = -1, origin = -1, disposed = false;

  /** Adds something of ours to the scene: no shadow, no collision, not in the light probe, and in the floor mirror only when asked. */
  const add = <T extends THREE.Object3D>(object: T, mirrored = false) => {
    object.traverse((node) => { node.userData.walkThrough = true; node.castShadow = false; });
    if (!object.name) object.name = "life";
    scene.add(object);
    owned.push(object);
    kit.probeHidden.push(object);
    if (!mirrored) kit.mirrorHidden.push(object);
    return object;
  };

  // ---- Sound -----------------------------------------------------------------------------------
  // Cue positions come from a small ring of vectors: nothing is allocated when a sound plays, and a
  // listener that keeps the vector for a moment still has the right place.
  const cue = options.cue;
  const places = Array.from({ length: 16 }, () => new THREE.Vector3()), voice = { gain: 1, pitch: 1 };
  let placeIndex = 0;
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => {
    if (!cue) return;
    const at = places[placeIndex = (placeIndex + 1) % places.length].set(x, y, z);
    voice.gain = gain; voice.pitch = pitch;
    cue(name, at, voice);
  };

  // ---- Shared resources ------------------------------------------------------------------------
  const noise = () => (shared.lifeNoise.value ??= own(noiseTexture(128, baseSeed * 17 + 3)));
  let quadGeometry: THREE.BufferGeometry | null = null;
  const quad = () => (quadGeometry ??= own(new THREE.PlaneGeometry(1, 1)));

  /**
   * An instanced mesh whose instances are placed by its shader. It sits at the origin with identity
   * instances and a bound given by hand, so culling (and anything that recomputes bounds) is right.
   */
  const shaderInstances = (base: THREE.BufferGeometry, material: THREE.Material, count: number, bounds: THREE.Sphere, attributes: Record<string, THREE.InstancedBufferAttribute>) => {
    const geometry = own(new THREE.BufferGeometry());
    for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.attributes[name]);
    geometry.setIndex(base.index);
    for (const name of Object.keys(attributes)) geometry.setAttribute(name, attributes[name]);
    geometry.boundingSphere = bounds.clone();
    geometry.boundingBox = bounds.getBoundingBox(new THREE.Box3());
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, identity);
    mesh.boundingSphere = bounds.clone();
    mesh.boundingBox = geometry.boundingBox.clone();
    mesh.receiveShadow = false;
    return mesh;
  };
  const volumeBounds = (volume: Volume, margin: number) => {
    const centre = new THREE.Vector3((volume.x[0] + volume.x[1]) / 2, (volume.y[0] + volume.y[1]) / 2, (volume.z[0] + volume.z[1]) / 2);
    return new THREE.Sphere(centre, Math.hypot(volume.x[1] - volume.x[0], volume.y[1] - volume.y[0], volume.z[1] - volume.z[0]) / 2 + margin);
  };
  const seeds = (count: number, random: () => number) => {
    const data = new Float32Array(count * 4);
    for (let i = 0; i < data.length; i += 1) data[i] = random();
    return new THREE.InstancedBufferAttribute(data, 4);
  };
  const softMaterial = (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, additive: boolean) => own(new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...windUniforms, lifeTime: shared.lifeTime, lifeViewport: shared.lifeViewport, ...uniforms },
    defines: additive ? { SOFT_ADDITIVE: 1 } : {},
    transparent: true, depthWrite: false, fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  }));
  const wispUniforms = () => ({ lifeNoise: shared.lifeNoise, lifeAmbient: shared.lifeAmbient, lifeSun: shared.lifeSun, lifeSunDir: shared.lifeSunDir });

  // ---- Drift -----------------------------------------------------------------------------------
  // The wind at the middle of a box is integrated on the CPU into four "gust classes": light pieces
  // move in any breeze, heavy ones only in the gusts. A piece's shader blends two classes by its
  // seed, so it travels exactly while it is aloft and lies still, flat, once the gust has passed.
  const DRIFT: Record<DriftKind, { count: number; classes: [number, number]; speed: number }> = {
    leaves: { count: 60, classes: [0.6, 1.35], speed: 5.5 },
    petals: { count: 50, classes: [0.5, 1.2], speed: 4 },
    paper: { count: 10, classes: [0.75, 1.5], speed: 6.5 },
    dust: { count: 14, classes: [0.85, 1.45], speed: 6 },
    spindrift: { count: 44, classes: [0.4, 1.1], speed: 9 },
    embers: { count: 40, classes: [0, 0], speed: 1 },
    motes: { count: 90, classes: [0, 0], speed: 1 },
  };
  const LEAF_COLOURS = [0x8a5a1c, 0xa8782a, 0x6e4a1e, 0xb08a34, 0x7a6a2a, 0x94441a];
  // Kept well under white: in full sun anything paler than this burns out and blooms.
  const PETAL_COLOURS = [0xd9a8b6, 0xdcc4c9, 0xd296a8, 0xe0d4d2];
  const PAPER_COLOURS = [0xb2aea3, 0xa69f8e, 0xb9b6ae, 0x98794f, 0xaaadaf];
  let flakeGrids: Record<number, THREE.BufferGeometry> = {};
  const flakeGrid = (cells: number) => {
    if (flakeGrids[cells]) return flakeGrids[cells];
    const geometry = own(new THREE.PlaneGeometry(1, 1, cells, cells));
    geometry.rotateX(-Math.PI / 2);
    return (flakeGrids[cells] = geometry);
  };

  const drift: Life["drift"] = (kind, o) => {
    if (kind === "motes" && !high) return null;
    const spec = DRIFT[kind], random = stream(11), count = scaled(o.count ?? spec.count), volume = o.volume, scale = o.scale ?? 1;
    const min = new THREE.Vector3(volume.x[0], volume.y[0], volume.z[0]), size = new THREE.Vector3(volume.x[1] - volume.x[0], volume.y[1] - volume.y[0], volume.z[1] - volume.z[0]);
    const cx = min.x + size.x / 2, cz = min.z + size.z / 2;
    const travel = new THREE.Vector4(), aloft = new THREE.Vector4();
    const uniforms: Record<string, THREE.IUniform> = { driftMin: { value: min }, driftSize: { value: size }, driftTravel: { value: travel }, driftAloft: { value: aloft } };
    const [low, top] = spec.classes;
    ticks.push((_time, dt) => {
      const strength = wind.uniforms.windVector.value.length(), now = wind.at(cx, cz), gust = strength > 0.0001 ? now / strength : 0;
      for (let k = 0; k < 4; k += 1) {
        const from = low + ((top - low) * k) / 3, target = top > low ? smooth(from, from + 0.22, gust) : 1, held = aloft.getComponent(k);
        const next = held + (target - held) * Math.min(1, dt * (target > held ? 4.5 : 1.4));
        aloft.setComponent(k, next);
        travel.setComponent(k, travel.getComponent(k) + next * now * spec.speed * dt);
      }
    });
    let mesh: THREE.InstancedMesh;
    if (kind === "leaves" || kind === "petals" || kind === "paper") {
      const flakeKind = kind === "leaves" ? 0 : kind === "petals" ? 1 : 2;
      const palette = (o.colors ?? (flakeKind === 0 ? LEAF_COLOURS : flakeKind === 1 ? PETAL_COLOURS : PAPER_COLOURS)).map((c) => new THREE.Color(c));
      const falling = o.falling ?? (flakeKind === 0 ? 0.25 : flakeKind === 1 ? 0.6 : 0);
      const look = new Float32Array(count * 4), tint = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        const variant = random(), bag = flakeKind === 2 && variant > 0.86;
        look[i * 4] = scale * (flakeKind === 0 ? 0.07 + random() * 0.06 : flakeKind === 1 ? 0.022 + random() * 0.016 : bag ? 0.3 : 0.1 + random() * 0.16);
        look[i * 4 + 1] = random() * TAU;
        look[i * 4 + 2] = variant;
        look[i * 4 + 3] = random() < falling ? 1 : 0;
        const colour = bag ? new THREE.Color(0xb4b8bb) : palette[Math.floor(random() * palette.length)], shade = 0.8 + random() * 0.3;
        tint[i * 3] = colour.r * shade; tint[i * 3 + 1] = colour.g * shade; tint[i * 3 + 2] = colour.b * shade;
      }
      const material = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: flakeKind === 2 ? 0.7 : 0.82, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: high, envMapIntensity: 0.7 }));
      const move = new THREE.Vector4(flakeKind === 2 ? 0.35 : 1.3, flakeKind === 2 ? 2.2 : 5.5, flakeKind === 1 ? 7 : 5, flakeKind === 1 ? 0.22 : 0.3);
      const shape = new THREE.Vector4(flakeKind, flakeKind === 2 ? 0.5 : flakeKind === 1 ? 0.6 : 0.5, flakeKind === 1 ? 1.2 : 1.8, 0);
      material.onBeforeCompile = (shader) => {
        applyWind(shader, wind);
        Object.assign(shader.uniforms, uniforms, { lifeTime: shared.lifeTime, flakeMove: { value: move }, flakeShape: { value: shape } });
        shader.vertexShader = shader.vertexShader
          .replace("void main() {", `${FLAKE_PARS}\nvoid main() {`)
          .replace("#include <beginnormal_vertex>", FLAKE_VERTEX)
          .replace("#include <begin_vertex>", "vec3 transformed = flakeAt;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\n${FLAKE_FRAGMENT_PARS}`)
          .replace("#include <color_fragment>", `#include <color_fragment>\n${FLAKE_FRAGMENT}`);
      };
      material.customProgramCacheKey = () => "life-flake";
      mesh = shaderInstances(flakeGrid(flakeKind === 2 ? 4 : 2), material, count, volumeBounds(volume, 1), {
        lifeSeed: seeds(count, random), flakeLook: new THREE.InstancedBufferAttribute(look, 4), flakeTint: new THREE.InstancedBufferAttribute(tint, 3),
      });
      mesh.receiveShadow = true;
    } else if (kind === "dust" || kind === "spindrift") {
      noise();
      const tint = new THREE.Color(o.colors?.[0] ?? (kind === "dust" ? 0xb9a688 : 0xf2f6fb));
      const look = new THREE.Vector4((kind === "dust" ? 1.1 : 0.55) * scale, (kind === "dust" ? 0.2 : 0.8) * (o.opacity ?? 1), kind === "spindrift" ? 1 : 0, kind === "dust" ? 1.1 : 1.3);
      const material = softMaterial(DUST_VERTEX, WISP_FRAGMENT, { ...uniforms, ...wispUniforms(), driftLook: { value: look }, driftTint: { value: tint } }, false);
      mesh = shaderInstances(quad(), material, count, volumeBounds(volume, 3), { lifeSeed: seeds(count, random) });
    } else {
      const ember = kind === "embers";
      const tint = new THREE.Color(o.colors?.[0] ?? (ember ? 0xffffff : 0xfff1d6));
      const look = new THREE.Vector4((ember ? 0.03 : 0.011) * scale, (ember ? 1 : 0.5) * (o.opacity ?? 1), ember ? 1 : 0, 0);
      const material = softMaterial(SPECK_VERTEX, DOT_FRAGMENT, { ...uniforms, driftLook: { value: look }, driftTint: { value: tint } }, true);
      mesh = shaderInstances(quad(), material, count, volumeBounds(volume, ember ? size.y * 1.5 : 1), { lifeSeed: seeds(count, random) });
    }
    mesh.name = `life-${kind}`;
    return add(mesh);
  };

  // ---- Insects ---------------------------------------------------------------------------------
  const insects: Life["insects"] = (spots, o) => {
    if (!high || !spots.length) return null;
    const random = stream(13), kind = o.kind === "moths" ? 0 : o.kind === "flies" ? 1 : 2;
    const each = o.count ?? [5, 7, 6][kind], radius = o.radius ?? [0.42, 0.34, 2.2][kind], count = spots.length * each;
    const home = new Float32Array(count * 4), bounds = new THREE.Box3();
    for (let i = 0; i < count; i += 1) {
      const spot = spots[Math.floor(i / each)];
      home[i * 4] = spot[0]; home[i * 4 + 1] = spot[1]; home[i * 4 + 2] = spot[2]; home[i * 4 + 3] = radius * (0.7 + random() * 0.6);
      bounds.expandByPoint(new THREE.Vector3(spot[0], spot[1], spot[2]));
    }
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    sphere.radius += radius * 2.5 + 0.5;
    const tint = new THREE.Color(o.color ?? [0xfff0d0, 0x14110d, 0xc8ff5a][kind]);
    const look = new THREE.Vector4([0.042, 0.007, 0.03][kind], [0.95, 0.9, 1][kind], kind, 0);
    const material = softMaterial(INSECT_VERTEX, DOT_FRAGMENT, { insectLook: { value: look }, insectTint: { value: tint } }, kind !== 1);
    const mesh = shaderInstances(quad(), material, count, sphere, { lifeSeed: seeds(count, random), lifeHome: new THREE.InstancedBufferAttribute(home, 4) });
    mesh.name = `life-${o.kind}`;
    return add(mesh);
  };

  // ---- Plumes ----------------------------------------------------------------------------------
  const PLUME: Record<PlumeKind, { rise: number; size: [number, number]; life: number; color: number; opacity: number; density: number; lean: number; spread: number; ease: number }> = {
    smoke: { rise: 5, size: [0.4, 2.2], life: 7, color: 0x85807b, opacity: 0.7, density: 20, lean: 5, spread: 0.5, ease: 0.8 },
    steam: { rise: 3, size: [0.2, 1.5], life: 3.6, color: 0xe9eef2, opacity: 0.34, density: 11, lean: 2.6, spread: 0.3, ease: 0.6 },
    breath: { rise: 0.5, size: [0.08, 0.5], life: 2.2, color: 0xf4f7fa, opacity: 0.2, density: 5, lean: 0.8, spread: 0.1, ease: 0.7 },
  };
  const plume: Life["plume"] = (kind, at, o = {}) => {
    noise();
    const spec = PLUME[kind], random = stream(17), sources = (typeof at[0] === "number" ? [at] : at) as V3[];
    const each = Math.max(3, Math.round((o.density ?? spec.density) * (high ? 1 : 0.6))), count = sources.length * each;
    const rise = o.rise ?? spec.rise, size = o.size ?? spec.size, seconds = o.life ?? spec.life * Math.sqrt(rise / spec.rise), lean = o.lean ?? spec.lean * (rise / spec.rise);
    const home = new Float32Array(count * 4), seed = new Float32Array(count * 4), sourceSeeds = sources.map(() => random()), bounds = new THREE.Box3();
    for (let i = 0; i < count; i += 1) {
      const s = Math.floor(i / each), spot = sources[s];
      home[i * 4] = spot[0]; home[i * 4 + 1] = spot[1]; home[i * 4 + 2] = spot[2]; home[i * 4 + 3] = sourceSeeds[s];
      // Evenly spaced births, jittered, so the column never pulses.
      seed[i * 4] = ((i % each) + random() * 0.7) / each; seed[i * 4 + 1] = random(); seed[i * 4 + 2] = random(); seed[i * 4 + 3] = random();
      bounds.expandByPoint(new THREE.Vector3(spot[0], spot[1], spot[2])).expandByPoint(new THREE.Vector3(spot[0], spot[1] + rise, spot[2]));
    }
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    sphere.radius += lean * 1.6 + size[1];
    const burst = o.burst ? new THREE.Vector3(Math.max(o.burst.every, seconds + o.burst.length + 0.5), o.burst.length, Math.max(0, o.burst.every * 0.45)) : new THREE.Vector3(0, 0, 0);
    const material = softMaterial(PLUME_VERTEX, WISP_FRAGMENT, {
      ...wispUniforms(),
      plumeShape: { value: new THREE.Vector4(rise, seconds, lean, spec.spread * (rise / spec.rise)) },
      plumeLook: { value: new THREE.Vector4(size[0], size[1], o.opacity ?? spec.opacity, spec.ease) },
      plumeBurst: { value: burst },
      plumeTint: { value: new THREE.Color(o.color ?? spec.color) },
      plumeGlow: { value: new THREE.Color(o.glow ?? 0x000000) },
    }, false);
    const mesh = shaderInstances(quad(), material, count, sphere, { lifeSeed: new THREE.InstancedBufferAttribute(seed, 4), lifeHome: new THREE.InstancedBufferAttribute(home, 4) });
    mesh.name = `life-${kind}`;
    const sound = o.cue === undefined ? (kind === "steam" ? "steamHiss" : null) : o.cue;
    if (o.burst && sound) {
      // The same schedule the shader gates the puffs with, so the hiss lands on the jet.
      const heard = sources.map(() => -1);
      ticks.push((now) => {
        for (let s = 0; s < sources.length; s += 1) {
          const cycle = now / burst.x + sourceSeeds[s] * 7, n = Math.floor(cycle), since = (cycle - n) * burst.x;
          const start = ((n * 0.618 + sourceSeeds[s]) % 1) * burst.z;
          if (since >= start && heard[s] !== n) {
            const first = heard[s] === -1;
            heard[s] = n;
            if (!first || since < start + 0.3) say(sound, sources[s][0], sources[s][1], sources[s][2], 0.7 + 0.3 * sourceSeeds[s], 0.9 + 0.25 * ((n * 0.37 + sourceSeeds[s]) % 1));
          }
        }
      });
    }
    return add(mesh);
  };

  // ---- Sway ------------------------------------------------------------------------------------
  type Swing = { object: THREE.Object3D; base: THREE.Quaternion; toLocal: THREE.Quaternion; at: THREE.Vector3; amplitude: number; omega: number; damping: number; both: boolean; aboutX: boolean; ax: number; vx: number; az: number; vz: number; phase: number; creak: CueName | null; creaked: number; swung: boolean; root: THREE.Object3D };
  const swings: Swing[] = [];
  const swingEuler = new THREE.Euler(), swingTurn = new THREE.Quaternion(), swingWind = new THREE.Vector3();
  // However hard or often it is hit, a hanging thing swings only so far.
  const bound = (s: Swing) => {
    const most = clamp(s.amplitude * 6, 0.3, 0.8) * s.omega;
    s.vx = clamp(s.vx, -most, most); s.vz = clamp(s.vz, -most, most);
  };
  const sway: Life["sway"] = (object, o = {}) => {
    const random = stream(19);
    object.updateWorldMatrix(true, false);
    const world = object.getWorldQuaternion(new THREE.Quaternion());
    const swing: Swing = {
      object, base: object.quaternion.clone(), toLocal: world.invert(), at: object.getWorldPosition(new THREE.Vector3()),
      amplitude: o.amplitude ?? 0.12, omega: TAU / (o.period ?? 2.4), damping: o.damping ?? 0.08, both: (o.axis ?? "both") === "both", aboutX: o.axis === "x",
      ax: 0, vx: 0, az: 0, vz: 0, phase: random() * 100, creak: o.creak ?? null, creaked: -10, swung: false, root: object,
    };
    swings.push(swing);
    restores.push(() => { object.quaternion.copy(swing.base); if (!object.matrixAutoUpdate) object.updateMatrix(); });
    return {
      kick(strength, x, z) {
        swingWind.set(x ?? wind.direction.x, 0, z ?? wind.direction.y).normalize().applyQuaternion(swing.toLocal);
        if (!swing.aboutX) swing.vz += strength * swingWind.x;
        if (swing.both || swing.aboutX) swing.vx -= strength * swingWind.z;
        bound(swing);
      },
    };
  };
  ticks.push((now, dt) => {
    for (let i = 0; i < swings.length; i += 1) {
      const s = swings[i], gust = wind.at(s.at.x, s.at.z);
      // Eddies of its own on top of the field, so two lamps side by side do not swing as one.
      const push = s.amplitude * gust * (1 + 0.35 * Math.sin(now * 1.7 + s.phase) + 0.2 * Math.sin(now * 4.3 + s.phase * 1.7));
      swingWind.set(wind.direction.x, 0, wind.direction.y).applyQuaternion(s.toLocal);
      const targetZ = s.aboutX ? 0 : push * swingWind.x, targetX = s.both || s.aboutX ? -push * swingWind.z : 0;
      const k = s.omega * s.omega, drag = 2 * s.damping * s.omega;
      // Two half steps keep a stiff, short pendulum stable on a slow frame.
      for (let step = 0; step < 2; step += 1) {
        const h = dt / 2;
        s.vx += (-k * (s.ax - targetX) - drag * s.vx) * h; s.ax += s.vx * h;
        s.vz += (-k * (s.az - targetZ) - drag * s.vz) * h; s.az += s.vz * h;
      }
      const reach = Math.abs(s.ax) + Math.abs(s.az), speed = Math.abs(s.vx) + Math.abs(s.vz);
      // It creaks as it turns at the end of a real swing, not while a steady wind holds it over:
      // it must have been moving since the last creak, and no fitting speaks more than every few seconds.
      if (speed > s.amplitude * s.omega * 0.4) s.swung = true;
      if (s.creak && s.swung && reach > s.amplitude * 0.45 && speed < s.amplitude * s.omega * 0.12 && now - s.creaked > Math.max(2.6, 2 * Math.PI / s.omega)) {
        s.creaked = now + Math.random() * 2.5;
        s.swung = false;
        say(s.creak, s.at.x, s.at.y, s.at.z, clamp(reach / (s.amplitude * 1.6), 0.25, 1), 0.9 + 0.2 * Math.sin(now * 7 + s.phase));
      }
      s.object.quaternion.copy(s.base).multiply(swingTurn.setFromEuler(swingEuler.set(s.ax, 0, s.az)));
      if (!s.object.matrixAutoUpdate) s.object.updateMatrix();
    }
  });
  // A bullet sets a hanging thing swinging away from the shooter.
  strikes.push((object, point) => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      for (let i = 0; i < swings.length; i += 1) {
        const s = swings[i];
        if (s.object !== node) continue;
        const dx = point.x - player.x, dz = point.z - player.z, length = Math.hypot(dx, dz) || 1;
        swingWind.set(dx / length, 0, dz / length).applyQuaternion(s.toLocal);
        const hit = clamp(s.amplitude * 4, 0.18, 0.5) * s.omega;
        if (!s.aboutX) s.vz += hit * swingWind.x;
        if (s.both || s.aboutX) s.vx -= hit * swingWind.z;
        bound(s);
        if (s.creak) { s.creaked = time; say(s.creak, s.at.x, s.at.y, s.at.z, 1, 1.15); }
        return true;
      }
    }
    return false;
  });

  // ---- Cloth -----------------------------------------------------------------------------------
  type Snap = { x: number; y: number; z: number; was: number; next: number };
  const snaps: Snap[] = [];
  let snapSeed = 0;
  const cloth: Life["cloth"] = (material, o = {}) => {
    const pin = o.pin ?? "top", byHeight = typeof pin === "object";
    const shape = new THREE.Vector4(o.amplitude ?? 0.06, o.frequency ?? 1, o.lean ?? 0.5, o.flutter ?? 1);
    const hold = new THREE.Vector4(byHeight ? 8 : CLOTH_PINS[pin], byHeight ? pin.height : 0, byHeight ? Math.max(0.01, pin.reach) : 1, 0);
    for (const item of Array.isArray(material) ? material : [material]) {
      const before = item.onBeforeCompile, ownKey = Object.prototype.hasOwnProperty.call(item, "customProgramCacheKey") ? item.customProgramCacheKey.bind(item) : null, source = before.toString();
      item.onBeforeCompile = (shader, renderer) => {
        before.call(item, shader, renderer);
        if (shader.vertexShader.includes("clothShift")) return;
        if (shader.vertexShader.includes("float windAt(")) Object.assign(shader.uniforms, windUniforms); else applyWind(shader, wind);
        shader.uniforms.clothShape = { value: shape };
        shader.uniforms.clothPin = { value: hold };
        shader.vertexShader = shader.vertexShader
          .replace("void main() {", `${CLOTH_PARS}\nvoid main() {`)
          .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n{ vec3 clothBent; clothShift(position, objectNormal, uv, clothBent); objectNormal = clothBent; }")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\n{ vec3 clothBent; transformed += clothShift(position, normal, uv, clothBent); }");
      };
      item.customProgramCacheKey = () => `${ownKey ? ownKey() : source}|life-cloth`;
      item.needsUpdate = true;
    }
    const handle: ClothHandle = {
      snap(at) { snaps.push({ x: at[0], y: at[1], z: at[2], was: 0, next: 2 + ((snapSeed += 1) * 0.618) % 3 }); return handle; },
    };
    return handle;
  };
  ticks.push((now) => {
    const strength = wind.uniforms.windVector.value.length();
    for (let i = 0; i < snaps.length; i += 1) {
      const s = snaps[i], gust = wind.at(s.x, s.z), mark = Math.max(0.32, strength * 1.3);
      // A crack as the gust front arrives, and now and then another while it blows hard.
      const arrives = gust > mark && s.was <= mark, again = gust > mark * 1.15 && now > s.next + 1.5 + ((i * 0.618) % 1) * 3;
      if ((arrives || again) && now > s.next) {
        s.next = now + 0.9 + ((now * 3.7 + i) % 1) * 1.6;
        say("clothSnap", s.x, s.y, s.z, clamp(0.35 + gust * 0.7, 0.3, 1), 0.85 + ((now * 5.3 + i * 0.37) % 1) * 0.4);
      }
      s.was = gust;
    }
  });

  // ---- Flicker ---------------------------------------------------------------------------------
  type Flick = { set: Array<(level: number) => void>; pattern: FlickerPattern; random: () => number; level: number; mode: number; until: number; flip: number; held: number; phase: number; rate: number; at: THREE.Vector3 | null; cue: boolean };
  const flicks: Flick[] = [];
  const drive = (target: FlickerTarget): ((level: number) => void) => {
    if (typeof target === "function") return target;
    const light = target as THREE.Light;
    if (light.isLight) { const base = light.intensity; restores.push(() => { light.intensity = base; }); return (level) => { light.intensity = base * level; }; }
    const material = target as THREE.MeshStandardMaterial;
    if (material.isMaterial && material.emissive && material.emissive.r + material.emissive.g + material.emissive.b > 0) {
      const base = material.emissiveIntensity;
      restores.push(() => { material.emissiveIntensity = base; });
      return (level) => { material.emissiveIntensity = base * level; };
    }
    const tinted = target as { color: THREE.Color };
    if (tinted.color?.isColor) { const base = tinted.color.clone(); restores.push(() => { tinted.color.copy(base); }); return (level) => { tinted.color.copy(base).multiplyScalar(level); }; }
    return () => {};
  };
  const flicker: Life["flicker"] = (target, pattern, o = {}) => {
    const random = stream(23), list = Array.isArray(target) ? target : [target];
    const light = list.find((item) => typeof item !== "function" && (item as THREE.Light).isLight) as THREE.Light | undefined;
    const at = o.at ? new THREE.Vector3(...o.at) : light ? (light.updateWorldMatrix(true, false), light.getWorldPosition(new THREE.Vector3())) : null;
    const flick: Flick = { set: list.map(drive), pattern, random, level: 1, mode: 0, until: 1 + random() * 6, flip: 0, held: 1, phase: random() * 100, rate: o.rate ?? 1, at, cue: o.cue !== false };
    flicks.push(flick);
    return { level: () => flick.level };
  };
  const flickSound = (f: Flick, name: CueName, gain: number) => { if (f.cue && f.at) say(name, f.at.x, f.at.y, f.at.z, gain, 0.9 + f.random() * 0.25); };
  ticks.push((clock) => {
    for (let i = 0; i < flicks.length; i += 1) {
      const f = flicks[i], r = f.random, now = clock * f.rate;
      let level = 1;
      if (f.pattern === "tube") {
        // A failing tube: steady, then a fit of stutters, sometimes going dark and striking again.
        if (f.mode === 0) {
          level = 0.96 + 0.04 * Math.sin(now * 47 + f.phase);
          if (now > f.until) { f.mode = 1; f.until = now + 0.25 + r() * 1.2; f.flip = now; f.held = 0.1; flickSound(f, "tubeFlicker", 0.8); }
        } else if (f.mode === 1) {
          if (now >= f.flip) { f.held = f.held > 0.5 ? 0.04 + r() * 0.22 : 0.75 + r() * 0.35; f.flip = now + 0.025 + r() * r() * 0.15; }
          level = f.held;
          if (now > f.until) { if (r() < 0.35) { f.mode = 2; f.until = now + 0.3 + r() * 1.4; } else { f.mode = 0; f.until = now + 2 + r() * 8; } }
        } else if (f.mode === 2) {
          level = 0.03;
          if (now > f.until) { f.mode = 3; f.flip = now; flickSound(f, "tubeFlicker", 0.6); }
        } else {
          const e = now - f.flip;
          level = e < 0.06 ? 1.25 : e < 0.15 ? 0.08 : e < 0.21 ? 1.1 : 0.55 + 0.45 * Math.min(1, (e - 0.21) / 0.5);
          if (e > 0.71) { f.mode = 0; f.until = now + 3 + r() * 9; }
        }
      } else if (f.pattern === "neon") {
        // Neon: steady with a faint shimmer, and a short brown-out now and then.
        level = 0.95 + 0.035 * Math.sin(now * 31 + f.phase) + 0.015 * Math.sin(now * 113 + f.phase * 2);
        if (f.mode === 0) { if (now > f.until) { f.mode = 1; f.until = now + 0.12 + r() * 0.3; f.flip = now; f.held = 0.4; flickSound(f, "neonBuzz", 0.5); } }
        else { if (now >= f.flip) { f.held = f.held > 0.6 ? 0.25 + r() * 0.3 : 0.85 + r() * 0.15; f.flip = now + 0.03 + r() * 0.07; } level *= f.held; if (now > f.until) { f.mode = 0; f.until = now + 6 + r() * 16; } }
      } else if (f.pattern === "dead") {
        // The dead letter of a sign: a faint glow that keeps trying to strike and sometimes holds for a second.
        if (f.mode === 0) { level = 0.035 + 0.015 * Math.sin(now * 23 + f.phase); if (now > f.until) { f.mode = 1; f.until = now + 0.2 + r() * 0.7; f.flip = now; f.held = 0; flickSound(f, "neonBuzz", 0.7); } }
        else if (f.mode === 1) {
          if (now >= f.flip) { f.held = f.held > 0.3 ? 0.03 : 0.45 + r() * 0.6; f.flip = now + 0.03 + r() * 0.08; }
          level = f.held;
          if (now > f.until) { if (r() < 0.3) { f.mode = 2; f.until = now + 0.5 + r() * 1.8; } else { f.mode = 0; f.until = now + 1.2 + r() * 5; } }
        } else { level = 0.9 + 0.08 * Math.sin(now * 37 + f.phase); if (now > f.until) { f.mode = 0; f.until = now + 2 + r() * 6; } }
      } else if (f.pattern === "candle" || f.pattern === "lantern") {
        // A flame: slow breathing, a quick tremble, and for a candle the odd gutter in a draught.
        const depth = f.pattern === "candle" ? 1 : 0.4, draught = f.at ? wind.at(f.at.x, f.at.z) : 0.2;
        level = 1 - depth * (0.16 + 0.1 * Math.sin(now * 2.3 + f.phase) + 0.07 * Math.sin(now * 7.9 + f.phase * 1.3) + 0.05 * Math.sin(now * 17.3 + f.phase * 2.1) * (1 + draught * 2));
        if (f.pattern === "candle") {
          if (f.mode === 0) { if (now > f.until) { f.mode = 1; f.flip = now; } }
          else { const e = (now - f.flip) / 0.35; level *= 1 - 0.5 * Math.sin(Math.min(1, e) * Math.PI); if (e >= 1) { f.mode = 0; f.until = now + (3 + r() * 9) / (1 + draught * 3); } }
        }
      } else {
        // A welding arc: bursts of hard, uneven light with dark pauses while the rod is moved.
        if (f.mode === 0) { level = 0; if (now > f.until) { f.mode = 1; f.until = now + 0.4 + r() * 2.2; f.flip = now; flickSound(f, "sparkZap", 0.9); } }
        else {
          if (now >= f.flip) { f.held = r() < 0.12 ? 0.05 : 0.5 + r() * 1.1; f.flip = now + 0.016 + r() * 0.05; if (r() < 0.03) flickSound(f, "sparkZap", 0.5); }
          level = f.held;
          if (now > f.until) { f.mode = 0; f.until = now + 1.2 + r() * 5.5; }
        }
      }
      f.level = level;
      for (let k = 0; k < f.set.length; k += 1) f.set[k](level);
    }
  });

  // ---- Feathered things: one material, contact decals, loose feathers ----------------------------
  const player = { x: 0, y: 1.62, z: 7.2, fx: 0, fz: -1, seen: false };
  /** Whatever camera draws this mesh tells us where the player stands and looks (the floor mirror is skipped). */
  const watch = (mesh: THREE.Mesh) => {
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const e = camera.matrixWorld.elements;
      if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera || e[13] < 0) return;
      player.x = e[12]; player.y = e[13]; player.z = e[14]; player.fx = -e[8]; player.fz = -e[10]; player.seen = true;
    };
  };

  let avianShared: THREE.MeshStandardMaterial | null = null;
  const avianMaterial = () => {
    if (avianShared) return avianShared;
    const material = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.85 }));
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", `${AVIAN_PARS}\nvoid main() {`)
        .replace("#include <beginnormal_vertex>", AVIAN_VERTEX)
        .replace("#include <begin_vertex>", "vec3 transformed = avianAt;");
      shader.fragmentShader = shader.fragmentShader
        .replace("void main() {", `${AVIAN_FRAGMENT_PARS}\nvoid main() {`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${AVIAN_FRAGMENT}`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${AVIAN_ROUGHNESS}`);
    };
    material.customProgramCacheKey = () => "life-avian";
    return (avianShared = material);
  };

  type Flock = { mesh: THREE.InstancedMesh; pose: Float32Array; poses: THREE.InstancedInterleavedBuffer; matrix: Float32Array };
  /** An instanced batch of one model: matrices and sixteen pose numbers per instance, both rewritten every frame. */
  const flock = (base: THREE.BufferGeometry, count: number, kin: [number, number], tints: Float32Array, name: string): Flock => {
    const geometry = own(new THREE.BufferGeometry());
    for (const key of Object.keys(base.attributes)) geometry.setAttribute(key, base.attributes[key]);
    geometry.setIndex(base.index);
    geometry.boundingBox = base.boundingBox; geometry.boundingSphere = base.boundingSphere;
    const pose = new Float32Array(count * 16), poses = new THREE.InstancedInterleavedBuffer(pose, 16);
    poses.setUsage(THREE.DynamicDrawUsage);
    ["poseA", "poseB", "poseC", "poseD"].forEach((key, i) => geometry.setAttribute(key, new THREE.InterleavedBufferAttribute(poses, 4, i * 4)));
    // Tint (three bytes in one number, 0..1.4 each), lacing, hip height, hip z.
    const kins = new Float32Array(count * 4), byte = (v: number) => Math.round(clamp(v / 1.4, 0, 1) * 255);
    for (let i = 0; i < count; i += 1) kins.set([byte(tints[i * 4]) + byte(tints[i * 4 + 1]) * 256 + byte(tints[i * 4 + 2]) * 65536, tints[i * 4 + 3], kin[0], kin[1]], i * 4);
    geometry.setAttribute("avianKin", new THREE.InstancedBufferAttribute(kins, 4));
    const mesh = new THREE.InstancedMesh(geometry, avianMaterial(), count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = name;
    watch(mesh);
    add(mesh, true);
    return { mesh, pose, poses, matrix: mesh.instanceMatrix.array as Float32Array };
  };
  /** Writes an instance matrix: forward is +z turned by `yaw`, nose up by `pitch`, banked by `roll`. */
  const put = (m: Float32Array, o: number, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, scale: number) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), ca = Math.cos(pitch), sa = -Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    m[o] = (cy * cr + sy * sa * sr) * scale; m[o + 1] = ca * sr * scale; m[o + 2] = (cy * sa * sr - sy * cr) * scale; m[o + 3] = 0;
    m[o + 4] = (sy * sa * cr - cy * sr) * scale; m[o + 5] = ca * cr * scale; m[o + 6] = (sy * sr + cy * sa * cr) * scale; m[o + 7] = 0;
    m[o + 8] = sy * ca * scale; m[o + 9] = -sa * scale; m[o + 10] = cy * ca * scale; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
  };
  const wrap = (a: number) => { let v = a % TAU; if (v > Math.PI) v -= TAU; else if (v < -Math.PI) v += TAU; return v; };

  // Contact decals: one batch for every animal that stands on something.
  const DECALS = 96;
  let decals: THREE.InstancedMesh | null = null, decalCount = 0, decalsDirty = false;
  const decal = () => {
    if (!decals) {
      const geometry = own(new THREE.PlaneGeometry(1, 1));
      geometry.rotateX(-Math.PI / 2);
      const material = own(new THREE.ShaderMaterial({
        vertexShader: DECAL_VERTEX, fragmentShader: DECAL_FRAGMENT, uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), decalDepth: { value: 0.6 } },
        transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      decals = new THREE.InstancedMesh(geometry, material, DECALS);
      decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const none = new THREE.Color(0, 0, 0);
      for (let i = 0; i < DECALS; i += 1) decals.setColorAt(i, none);
      decals.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      decals.count = 0;
      decals.frustumCulled = false;
      decals.name = "life-contact";
      decals.renderOrder = -1;
      add(decals);
    }
    if (decalCount >= DECALS) return -1;
    decals.count = decalCount += 1;
    return decalCount - 1;
  };
  // Under a sun the patch is pulled out a little away from it, so it reads as the animal's shadow.
  const shade = { x: 0, z: 0, reach: 0, yaw: 0 };
  const setDecal = (slot: number, x: number, y: number, z: number, wide: number, long: number, yaw: number, fade: number) => {
    if (slot < 0 || !decals) return;
    const m = decals.instanceMatrix.array as Float32Array, o = slot * 16, c = Math.cos(yaw), s = Math.sin(yaw);
    m[o] = c * wide; m[o + 1] = 0; m[o + 2] = -s * wide; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = s * long; m[o + 9] = 0; m[o + 10] = c * long; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y + 0.004; m[o + 14] = z; m[o + 15] = 1;
    (decals.instanceColor!.array as Float32Array)[slot * 3] = fade;
    decalsDirty = true;
  };

  // Loose feathers: a ring of them shared by everything that can be hit.
  const FEATHERS = high ? 128 : 64;
  let feathers: { mesh: THREE.InstancedMesh; born: THREE.InstancedBufferAttribute; fling: THREE.InstancedBufferAttribute; look: THREE.InstancedBufferAttribute; next: number; until: number; down: THREE.InstancedMesh; downBorn: THREE.InstancedBufferAttribute; downLook: THREE.InstancedBufferAttribute; downNext: number } | null = null;
  const POOFS = 32;
  const featherRandom = rng(baseSeed * 613 + 9);
  const puff = (x: number, y: number, z: number, pushX: number, pushZ: number, count: number, r: number, g: number, b: number, size: number) => {
    if (!feathers) {
      const geometry = own(new THREE.PlaneGeometry(1, 1, 2, 3));
      geometry.rotateX(-Math.PI / 2);
      const material = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: high, envMapIntensity: 0.8 }));
      material.onBeforeCompile = (shader) => {
        applyWind(shader, wind);
        shader.uniforms.lifeTime = shared.lifeTime;
        shader.vertexShader = shader.vertexShader
          .replace("void main() {", `${FEATHER_PARS}\nvoid main() {`)
          .replace("#include <beginnormal_vertex>", FEATHER_VERTEX)
          .replace("#include <begin_vertex>", "vec3 transformed = featherAt;");
        shader.fragmentShader = shader.fragmentShader
          .replace("void main() {", "varying vec3 vFeatherTint;\nvarying vec2 vFeatherUv;\nvoid main() {")
          .replace("#include <color_fragment>", `#include <color_fragment>\n${FEATHER_FRAGMENT}`);
      };
      material.customProgramCacheKey = () => "life-feather";
      const born = new THREE.InstancedBufferAttribute(new Float32Array(FEATHERS * 4).fill(-1000), 4), fling = new THREE.InstancedBufferAttribute(new Float32Array(FEATHERS * 4), 4), look = new THREE.InstancedBufferAttribute(new Float32Array(FEATHERS * 4), 4);
      const mesh = shaderInstances(geometry, material, FEATHERS, new THREE.Sphere(new THREE.Vector3(0, 2, -9), 60), { featherBorn: born, featherFling: fling, featherLook: look });
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.name = "life-feathers";
      add(mesh);
      noise();
      const downBorn = new THREE.InstancedBufferAttribute(new Float32Array(POOFS * 4).fill(-1000), 4), downLook = new THREE.InstancedBufferAttribute(new Float32Array(POOFS * 4), 4);
      const down = shaderInstances(quad(), softMaterial(POOF_VERTEX, WISP_FRAGMENT, wispUniforms(), false), POOFS, new THREE.Sphere(new THREE.Vector3(0, 2, -9), 60), { poofBorn: downBorn, poofLook: downLook });
      down.frustumCulled = false;
      down.name = "life-down";
      add(down);
      feathers = { mesh, born, fling, look, next: 0, until: 0, down, downBorn, downLook, downNext: 0 };
    }
    const f = feathers, n = Math.min(count, FEATHERS), random = featherRandom;
    for (let i = 0; i < n; i += 1) {
      const k = f.next * 4, turn = random() * TAU, up = random(), speed = 1.2 + random() * 3.2, big = random() < 0.2 ? 1.5 : 1;
      f.next = (f.next + 1) % FEATHERS;
      const born = f.born.array as Float32Array, fling = f.fling.array as Float32Array, look = f.look.array as Float32Array, shade = 0.75 + random() * 0.4;
      born[k] = x + (random() - 0.5) * 0.12; born[k + 1] = y + (random() - 0.5) * 0.12; born[k + 2] = z + (random() - 0.5) * 0.12; born[k + 3] = time + random() * 0.06;
      fling[k] = Math.cos(turn) * speed * (1 - up * 0.5) + pushX * (0.5 + random()); fling[k + 1] = 0.6 + up * 3.4; fling[k + 2] = Math.sin(turn) * speed * (1 - up * 0.5) + pushZ * (0.5 + random()); fling[k + 3] = random();
      look[k] = r * shade; look[k + 1] = g * shade; look[k + 2] = b * shade; look[k + 3] = size * (0.6 + random() * 0.7) * big;
    }
    // And the down that hangs in the air for a moment where it was.
    for (let i = 0, clouds = count > 20 ? 7 : 4; i < clouds; i += 1) {
      const k = f.downNext * 4, born = f.downBorn.array as Float32Array, look = f.downLook.array as Float32Array;
      f.downNext = (f.downNext + 1) % POOFS;
      born[k] = x; born[k + 1] = y; born[k + 2] = z; born[k + 3] = time + i * 0.012;
      look[k] = 0.35 + r * 0.5; look[k + 1] = 0.35 + g * 0.5; look[k + 2] = 0.34 + b * 0.5; look[k + 3] = Math.min(0.999, random()) + Math.round(size * 14 * 16);
    }
    f.born.needsUpdate = f.fling.needsUpdate = f.look.needsUpdate = f.downBorn.needsUpdate = f.downLook.needsUpdate = true;
    f.until = time + 12;
    f.mesh.visible = f.down.visible = true;
  };

  // Things bullets can hit that are never drawn: one box per animal, moved with it.
  let proxyGeometry: THREE.BufferGeometry | null = null, proxyMaterial: THREE.Material | null = null;
  const proxy = (wide: number, tall: number, long: number) => {
    proxyGeometry ??= own(new THREE.BoxGeometry(1, 1, 1));
    proxyMaterial ??= own(new THREE.MeshBasicMaterial());
    const mesh = new THREE.Mesh(proxyGeometry, proxyMaterial);
    mesh.scale.set(wide, tall, long);
    mesh.visible = false;
    mesh.userData.walkThrough = true;
    mesh.name = "life-proxy";
    scene.add(mesh);
    owned.push(mesh);
    shootable.push(mesh);
    kit.shootable.push(mesh);
    return mesh;
  };

  // ---- Birds ----------------------------------------------------------------------------------
  type Habit = { speed: number; flap: number; burst: number; depth: number; glide: number; turn: number; spacing: number; call: CueName | null; every: [number, number]; stance: number; wary: number; quick: number; bound: boolean };
  const HABITS: Record<BirdSpecies, Habit> = {
    pigeon: { speed: 9, flap: 5.2, burst: 8.5, depth: 0.95, glide: 0.25, turn: 2.6, spacing: 0.24, call: "pigeonCoo", every: [5, 13], stance: 0.3, wary: 2.4, quick: 1, bound: false },
    sparrow: { speed: 7, flap: 11, burst: 14, depth: 1, glide: 0.5, turn: 4, spacing: 0.13, call: "sparrowChirp", every: [3, 9], stance: 0.5, wary: 3, quick: 2.2, bound: true },
    gull: { speed: 8.5, flap: 3.1, burst: 4.4, depth: 0.75, glide: 0.55, turn: 1.7, spacing: 0.5, call: "gullCry", every: [9, 24], stance: 0.12, wary: 3, quick: 0.8, bound: false },
    crow: { speed: 8, flap: 3.6, burst: 5.2, depth: 0.85, glide: 0.12, turn: 2.1, spacing: 0.45, call: "crowCaw", every: [10, 26], stance: 0.22, wary: 4.2, quick: 1, bound: false },
    swift: { speed: 12, flap: 8, burst: 10, depth: 0.7, glide: 0.5, turn: 3.6, spacing: 0.2, call: null, every: [20, 40], stance: 0.2, wary: 3, quick: 1, bound: false },
  };
  const birdModels: Partial<Record<BirdSpecies, ReturnType<typeof buildBird>>> = {};
  const birdModel = (species: BirdSpecies) => {
    const known = birdModels[species];
    if (known) return known;
    const model = buildBird(BIRD_LOOKS[species], high);
    own(model.geometry);
    return (birdModels[species] = model);
  };
  const PIGEON_TINTS: V3[] = [[1, 1, 1], [1, 1, 1], [1, 1, 1], [0.5, 0.5, 0.56], [1.2, 1.17, 1.12], [1.1, 0.8, 0.68], [0.75, 0.76, 0.8]];
  const birdTints = (species: BirdSpecies, count: number, lacing: number, random: () => number) => {
    const tints = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      const base = species === "pigeon" ? PIGEON_TINTS[Math.floor(random() * PIGEON_TINTS.length)] : NOWHERE, shade = 0.9 + random() * 0.2;
      tints[i * 4] = (species === "pigeon" ? base[0] : 1) * shade; tints[i * 4 + 1] = (species === "pigeon" ? base[1] : 1) * shade; tints[i * 4 + 2] = (species === "pigeon" ? base[2] : 1) * shade; tints[i * 4 + 3] = lacing;
    }
    return tints;
  };

  const PERCHED = 0, CROUCHED = 1, FLYING = 2, HOMING = 3, SETTLING = 4, AWAY = 5;
  const FEATHER_TINTS: Record<BirdSpecies, Paint> = { pigeon: paint(0x8d949e), sparrow: paint(0x80592f), gull: paint(0xcfcfca), crow: paint(0x16161a), swift: paint(0x2c2620) };
  type Slot = { x: number; y: number; z: number; yaw: number; ax: number; az: number; thin: boolean; by: number };
  const newBird = () => ({
    state: PERCHED, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, course: 0, pitch: 0, roll: 0, scale: 1, slot: 0, home: 0, hop: -1, goAt: -1, scared: false, fromX: 0, fromZ: 0, until: 0, since: -10, back: 0, closing: false,
    effort: 0, phase: 0, depth: 0, gliding: false, glideAt: 0,
    hy: 0, nod: 0, tilt: 0, hyTo: 0, nodTo: 0, tiltTo: 0, lookAt: 0, act: 0, actAt: 0, actUntil: 0, actSide: 1, side: 0, sideTo: 0,
    fold: 1, crouch: 0, lean: 0, fan: 0, tuck: 0, fluff: 0, neck: 0, tail: 0, shade: 0, decal: -1, seed: 0, ox: 1, oy: 1, oz: 1, wa: 1, wb: 1, wc: 1,
    kept: false, jinked: -10,
  });

  const birds: Life["birds"] = (species, o) => {
    const habit = HABITS[species], random = stream(29), model = birdModel(species), slots: Slot[] = [], wary = o.wary ?? habit.wary;
    for (const perch of o.perches) {
      const from = Array.isArray(perch) ? perch : perch.from, to = Array.isArray(perch) ? perch : perch.to, thin = !Array.isArray(perch) && perch.thin === true;
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], length = Math.hypot(dx, dy, dz), n = Math.max(1, Math.floor(length / habit.spacing) + 1);
      for (let i = 0; i < n; i += 1) {
        const t = n === 1 ? 0.5 : clamp((i + (random() - 0.5) * 0.4) / (n - 1), 0, 1), x = from[0] + dx * t, z = from[2] + dz * t;
        // Facing across the perch, mostly toward the middle of the range; a few look the other way.
        let px = -x, pz = -9 - z;
        if (length > 0.05) { px = -dz; pz = dx; if (px * -x + pz * (-9 - z) < 0) { px = -px; pz = -pz; } }
        slots.push({ x, y: from[1] + dy * t, z, yaw: Math.atan2(px, pz) + (random() - 0.5) * 0.9 + (random() < 0.16 ? Math.PI : 0), ax: length > 0.05 ? dx / length : 0, az: length > 0.05 ? dz / length : 0, thin, by: -1 });
      }
    }
    for (let i = slots.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)), held = slots[i]; slots[i] = slots[j]; slots[j] = held; }
    const count = Math.min(scaled(o.count ?? 6), slots.length);
    if (count === 0) return null;
    let lowX = Infinity, highX = -Infinity, lowZ = Infinity, highZ = -Infinity, top = -Infinity, lowest = Infinity;
    for (const slot of slots) { lowX = Math.min(lowX, slot.x); highX = Math.max(highX, slot.x); lowZ = Math.min(lowZ, slot.z); highZ = Math.max(highZ, slot.z); top = Math.max(top, slot.y); lowest = Math.min(lowest, slot.y); }
    const roam = o.roam ?? { x: [(lowX + highX) / 2 - 7, (lowX + highX) / 2 + 7], y: [top + 2.5, top + 6], z: [(lowZ + highZ) / 2 - 7, (lowZ + highZ) / 2 + 7] };
    const rcx = (roam.x[0] + roam.x[1]) / 2, rcy = (roam.y[0] + roam.y[1]) / 2, rcz = (roam.z[0] + roam.z[1]) / 2, rhx = (roam.x[1] - roam.x[0]) / 2, rhy = (roam.y[1] - roam.y[0]) / 2, rhz = (roam.z[1] - roam.z[0]) / 2;
    // In a small roam they fly slower, so that their turning circle fits inside it.
    const roomy = Math.min(habit.speed, Math.max(3.5, Math.min(rhx, rhz) * habit.turn));
    const batch = flock(model.geometry, count, model.kin, birdTints(species, count, model.lacing, random), `life-${species}`);
    const size = BIRD_LOOKS[species].size, hip = model.kin[0], feather = FEATHER_TINTS[species];
    const all = Array.from({ length: count }, (_, i) => {
      const b = newBird(), slot = slots[i];
      slot.by = i;
      b.slot = b.home = i; b.x = slot.x; b.y = slot.y; b.z = slot.z; b.yaw = b.course = slot.yaw; b.scale = 0.93 + random() * 0.14; b.seed = random();
      b.lookAt = random() * 2; b.actAt = 1 + random() * 8; b.phase = random() * TAU; b.shade = 1;
      b.ox = 1.2 + random() * 2.6; b.oy = 0.5 + random() * 1.2; b.oz = 1.2 + random() * 2.6; b.wa = 0.5 + random() * 0.7; b.wb = 0.6 + random() * 0.8; b.wc = 0.5 + random() * 0.7;
      b.decal = decal();
      return b;
    });
    const targets = o.shootable === false ? null : all.map(() => proxy(0.13 * size, 0.17 * size, 0.3 * size));
    let anchor = random() * TAU, callAt = 2 + random() * 6, hopAt = 5 + random() * 9, flushAt = -1, flushGain = 0, flushX = 0, flushY = 0, flushZ = 0, quietUntil = 0;
    const freeSlot = (b: { home: number; x: number; z: number }, apart: number) => {
      if (apart === 0 && slots[b.home].by < 0 && !(player.seen && Math.hypot(slots[b.home].x - player.x, slots[b.home].y - player.y, slots[b.home].z - player.z) < wary + 1.5)) return b.home;
      let pick = -1, seen = 0;
      for (let k = 0; k < slots.length; k += 1) {
        if (slots[k].by >= 0 || Math.hypot(slots[k].x - b.x, slots[k].z - b.z) < apart) continue;
        if (player.seen && Math.hypot(slots[k].x - player.x, slots[k].y - player.y, slots[k].z - player.z) < wary + 1.5) continue;
        seen += 1;
        if (random() * seen < 1) pick = k;
      }
      return pick;
    };

    ticks.push((now, dt) => {
      anchor += dt * (habit.speed / Math.max(5, Math.max(rhx, rhz))) * 0.75;
      const ax = rcx + Math.sin(anchor) * rhx * 0.85, ay = rcy + Math.sin(anchor * 0.71 + 1) * rhy * 0.8, az = rcz + Math.cos(anchor * 1.31 + 0.7) * rhz * 0.85;
      if (flushAt >= 0 && now >= flushAt) { say("wingsFlush", flushX, flushY, flushZ, flushGain, 0.92 + random() * 0.16); flushAt = -1; }
      // Now and then one of them calls, and one flies to another perch for reasons of its own.
      if (now > callAt) {
        callAt = now + habit.every[0] + random() * (habit.every[1] - habit.every[0]);
        const b = all[Math.floor(random() * count)];
        if (now > quietUntil && habit.call && b.state === PERCHED && b.act === 0 && b.goAt < 0) { b.act = 4; b.since = now; b.actUntil = now + (species === "pigeon" ? 2.2 : species === "sparrow" ? 1.3 : species === "gull" ? 1.6 : 1.9); b.actSide = 0; }
      }
      if (now > hopAt) {
        hopAt = now + 6 + random() * 13;
        const b = all[Math.floor(random() * count)];
        if (now > quietUntil && b.state === PERCHED && b.act === 0 && b.goAt < 0) {
          const to = freeSlot(b, 1.2);
          if (to >= 0) { slots[to].by = all.indexOf(b); b.hop = to; b.goAt = now; b.scared = false; }
        }
      }
      for (let i = 0; i < count; i += 1) {
        const b = all[i];
        if (b.state === AWAY) {
          if (now < b.until) { put(batch.matrix, i * 16, b.x, -40, b.z, 0, 0, 0, 0.001); setDecal(b.decal, b.x, b.y, b.z, 0.1, 0.1, 0, 0); continue; }
          // Another turns up from beyond the roam.
          if (o.from) {
            const dx = rcx - o.from[0], dy = rcy - o.from[1], dz = rcz - o.from[2], far = Math.hypot(dx, dy, dz) || 1;
            b.x = o.from[0]; b.y = o.from[1]; b.z = o.from[2];
            b.vx = (dx / far) * habit.speed; b.vy = (dy / far) * habit.speed; b.vz = (dz / far) * habit.speed;
          } else {
            const bearing = random() * TAU;
            b.x = rcx + Math.sin(bearing) * (rhx + 8); b.y = rcy + Math.min(rhy, 1 + random() * 2); b.z = rcz + Math.cos(bearing) * (rhz + 8);
            b.vx = -Math.sin(bearing) * habit.speed; b.vy = 0; b.vz = -Math.cos(bearing) * habit.speed;
          }
          b.yaw = b.course = Math.atan2(b.vx, b.vz); b.kept = false;
          b.state = FLYING; b.back = now + 4 + random() * 8; b.fold = 0; b.tuck = 1; b.effort = 0.3; b.pitch = b.roll = 0; b.shade = 0;
        }
        let fold = 1, crouch = 0, lean = -habit.stance, fan = 0, tuck = 0, fluff = 0, neck = habit.stance * 0.7, tail = habit.stance * 0.9, wingIn = 0, wingOut = 0, lift = 0, shake = 0, shade = 0;
        if (b.state === PERCHED || b.state === SETTLING) {
          const slot = slots[b.slot];
          shade = slot.thin ? 0 : 1;
          b.side += (b.sideTo - b.side) * Math.min(1, dt * 5);
          const ease = Math.min(1, dt * 14);
          b.x += (slot.x + slot.ax * b.side - b.x) * ease; b.y += (slot.y - b.y) * ease; b.z += (slot.z + slot.az * b.side - b.z) * ease;
          b.yaw += wrap(slot.yaw - b.yaw) * Math.min(1, dt * 6); b.pitch -= b.pitch * Math.min(1, dt * 10); b.roll -= b.roll * Math.min(1, dt * 10);
          // The head moves in quick looks with stillness between them.
          if (now >= b.lookAt) {
            b.lookAt = now + (0.25 + random() * random() * 2.6) / habit.quick;
            b.hyTo = (random() - 0.5) * 2.6; b.nodTo = (random() - 0.5) * 0.5; b.tiltTo = random() < 0.25 ? (random() - 0.5) * 0.7 : 0;
          }
          if (b.state === SETTLING) {
            // Just down: a last beat or two, the wings shut, the body rocks and steadies.
            const e = now - b.since;
            fold = e > 0.16 ? 1 : 0.15;
            wingIn = wingOut = 0.5 * Math.exp(-e * 9) * Math.sin(e * 38);
            crouch = hip * 0.35 * Math.exp(-e * 6) * Math.cos(e * 15);
            tail += 0.5 * Math.exp(-e * 5) * Math.sin(e * 17);
            fan = Math.exp(-e * 6);
            if (e > 0.9) { b.state = PERCHED; b.actAt = now + 1 + random() * 5; }
          } else if (b.act === 0) {
            if (now >= b.actAt && b.goAt < 0) {
              const pick = random();
              b.since = now;
              if (pick < 0.3) { b.act = 1; b.actUntil = now + 1.5 + random() * 3; b.actSide = random() < 0.5 ? -1 : 1; }
              else if (pick < 0.52 && (slot.ax !== 0 || slot.az !== 0)) { b.act = 2; b.actUntil = now + 0.5; b.sideTo = clamp(b.sideTo + (random() - 0.5) * habit.spacing * 0.9, -habit.spacing * 0.3, habit.spacing * 0.3); }
              else if (pick < 0.66) { b.act = 3; b.actUntil = now + 0.9; }
              else b.actAt = now + 1.5 + random() * 6;
            }
          } else {
            const e = now - b.since;
            if (b.act === 1) {
              // Preening: the head reaches back over a shoulder and nibbles.
              b.hyTo = b.actSide * 2.25; b.nodTo = 0.7 + 0.16 * Math.sin(now * 21 + b.seed * 9); b.tiltTo = b.actSide * 0.3; fluff = 0.5; b.lookAt = now + 0.2;
            } else if (b.act === 2) {
              // A shuffle along the perch.
              crouch = hip * 0.18 * Math.abs(Math.sin(e * 25)); lift = hip * 0.1 * Math.abs(Math.sin(e * 25));
            } else if (b.act === 3) {
              // A ruffle: fluffed out, shaken, sleeked again.
              fluff = Math.sin(Math.min(1, e / 0.9) * Math.PI); shake = 0.14 * fluff * Math.sin(e * 55); tail += 0.3 * fluff;
            } else if (species === "pigeon") {
              // Cooing: puffed up, bowing low and coming up again.
              if (b.actSide === 0) { b.actSide = 1; say("pigeonCoo", b.x, b.y, b.z, 0.7 + random() * 0.3, 0.92 + random() * 0.16); }
              fluff = 0.9; lean = -habit.stance + 0.55 * Math.max(0, Math.sin(e * 5.6)); neck = 0.5; fan = 0.5; b.hyTo = 0; b.lookAt = now + 0.2;
            } else if (species === "sparrow") {
              // Chirping: a run of notes, each with a flick of the tail.
              const note = Math.floor(e / 0.32);
              if (note >= b.actSide && note < 4) { b.actSide = note + 1; say("sparrowChirp", b.x, b.y, b.z, 0.6 + random() * 0.4, 0.9 + random() * 0.3); }
              tail += 0.7 * Math.max(0, Math.sin((e % 0.32) * 20)); lean = -habit.stance - 0.12 * Math.max(0, Math.sin((e % 0.32) * 20));
            } else if (species === "gull") {
              // The long call: head down, then thrown back.
              if (b.actSide === 0 && e > 0.35) { b.actSide = 1; say("gullCry", b.x, b.y, b.z, 0.8 + random() * 0.2, 0.92 + random() * 0.16); }
              b.nodTo = e < 0.35 ? 0.5 : -0.9; neck = e < 0.35 ? 0.5 : -0.25; b.hyTo = 0; b.lookAt = now + 0.2;
            } else {
              // Cawing: a lunge forward with each note.
              const note = Math.floor(e / 0.6);
              if (note >= b.actSide && note < 3) { b.actSide = note + 1; say("crowCaw", b.x, b.y, b.z, 0.8 + random() * 0.2, 0.9 + random() * 0.18); }
              const lunge = Math.max(0, Math.sin((e % 0.6) * 5.2));
              lean = -habit.stance + 0.4 * lunge; neck = 0.35 * lunge; fan = 0.6 * lunge; b.nodTo = -0.2 * lunge; b.hyTo = 0; b.lookAt = now + 0.2;
            }
            if (now >= b.actUntil) { b.act = 0; b.actAt = now + 1.5 + random() * 6; }
          }
          // Someone walking up to it is as good as a shot.
          if (b.goAt < 0 && player.seen) {
            const dx = b.x - player.x, dy = b.y - player.y + 0.4, dz = b.z - player.z;
            if (dx * dx + dy * dy + dz * dz < wary * wary) { b.goAt = now + random() * 0.2; b.scared = true; b.fromX = player.x; b.fromZ = player.z; b.back = 0; if (flushAt < 0) { flushAt = b.goAt + 0.1; flushGain = 0.4; flushX = b.x; flushY = b.y; flushZ = b.z; } }
          }
          if (b.goAt >= 0 && now >= b.goAt) { b.state = CROUCHED; b.until = now + 0.08 + random() * 0.09; b.act = 0; }
        } else if (b.state === CROUCHED) {
          // The moment before: down on the legs, leaning out, wings coming unstuck.
          shade = slots[b.slot].thin ? 0 : 1;
          crouch = hip * 0.4; fold = 0.5; lean = 0.2; wingIn = wingOut = 0.5; neck = 0.2;
          if (now >= b.until) {
            let dx = b.x - b.fromX, dz = b.z - b.fromZ;
            const far = Math.hypot(dx, dz);
            if (!b.scared || far < 0.01) { dx = Math.sin(b.yaw); dz = Math.cos(b.yaw); } else { dx /= far; dz /= far; }
            if (b.hop < 0) {
              // Away from the fright, but out into the air it will wheel in rather than into the wall behind its perch.
              const ox = rcx - b.x, oz = rcz - b.z, open = Math.hypot(ox, oz);
              if (open > 1) { dx = dx * 0.6 + (ox / open) * 0.8; dz = dz * 0.6 + (oz / open) * 0.8; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
            }
            const fanOut = (random() - 0.5) * 1.7, cs = Math.cos(fanOut), sn = Math.sin(fanOut), push = b.scared ? 3 + random() * 2.5 : 1.5 + random();
            b.vx = (dx * cs - dz * sn) * push; b.vz = (dx * sn + dz * cs) * push; b.vy = b.scared ? 3.6 + random() * 2.2 : 2.4 + random();
            b.course = Math.atan2(b.vx, b.vz);
            b.effort = 1; b.goAt = -1; b.gliding = false; b.glideAt = now + 1.2 + random(); b.closing = false; b.kept = false;
            if (b.hop >= 0) { slots[b.slot].by = -1; b.slot = b.hop; b.hop = -1; b.state = HOMING; b.until = now + 12; if (flushAt < 0) { flushAt = now; flushGain = 0.3; flushX = b.x; flushY = b.y; flushZ = b.z; } }
            else { slots[b.slot].by = -1; b.slot = -1; b.state = FLYING; if (b.back < now) b.back = now + 15 + random() * 25; }
          }
        } else {
          tuck = 1; lean = 0; neck = 0.12; fold = 0; tail = 0;
          let gx: number, gy: number, gz: number, cruise = roomy, turn = habit.turn, landed = false;
          if (b.state === HOMING) {
            const slot = slots[b.slot], dx = slot.x - b.x, dy = slot.y - b.y, dz = slot.z - b.z, far = Math.hypot(dx, dy, dz);
            gx = slot.x; gz = slot.z;
            // Slower the nearer it gets, so the perch is never inside its turning circle.
            cruise = Math.min(habit.speed, Math.max(3.2, far * 1.3));
            if (far > 2.6 && !b.closing) gy = slot.y + 1 + far * 0.12;
            else {
              // The last metres: aimed at the perch, slowing, reared back on spread wings and tail, feet reaching.
              if (!b.closing) { b.closing = true; b.until = now + 3.2; }
              const close = clamp(1 - far / 2.6, 0, 1);
              gy = slot.y + 0.05 + far * 0.22; cruise = Math.max(1.1, far * 2.5); turn = 7.5;
              lean = -0.75 * close; fan = close; tuck = far < 1.3 ? 0 : 1; b.effort = Math.max(b.effort, 0.5 + 0.5 * close); b.gliding = false;
              landed = far < 0.09 || now > b.until || (far < 0.4 && dx * b.vx + dy * b.vy + dz * b.vz < 0);
            }
          } else {
            // With the flock: a place of its own round a point that wheels about the roam.
            gx = clamp(ax + Math.sin(now * b.wa + b.seed * 40) * b.ox, roam.x[0], roam.x[1]); gy = clamp(ay + Math.sin(now * b.wb + b.seed * 70) * b.oy, roam.y[0], roam.y[1]); gz = clamp(az + Math.cos(now * b.wc + b.seed * 90) * b.oz, roam.z[0], roam.z[1]);
            const out = Math.max(Math.abs(b.x - rcx) - rhx, Math.abs(b.y - rcy) - rhy, Math.abs(b.z - rcz) - rhz);
            if (out < 0) b.kept = true;
            else if (b.kept) { gx = rcx; gy = rcy; gz = rcz; turn *= 2.5; cruise *= 0.75; }
            if (now > b.back) {
              const to = freeSlot(b, 0);
              if (to >= 0) { slots[to].by = i; b.slot = to; b.state = HOMING; b.until = now + 14; b.closing = false; } else b.back = now + 3;
            }
          }
          if (landed) {
            b.state = SETTLING; b.since = now; b.vx = b.vy = b.vz = 0; b.sideTo = b.side = 0; b.act = 0; b.effort = 0; b.depth = 0;
          } else {
            const dx = gx - b.x, dy = gy - b.y, dz = gz - b.z, dist = Math.hypot(dx, dy, dz) || 1;
            let speed = Math.hypot(b.vx, b.vy, b.vz) || 0.01;
            // Turn towards the goal at a real rate: the old blend of headings barely turned for a goal astern.
            const hx = b.vx / speed, hy = b.vy / speed, hz = b.vz / speed, tx = dx / dist, ty = dy / dist, tz = dz / dist;
            const along = clamp(hx * tx + hy * ty + hz * tz, -1, 1);
            let px = tx - hx * along, py = ty - hy * along, pz = tz - hz * along, across = Math.hypot(px, py, pz);
            if (along < 0) {
              // A goal behind it is turned to on the level, never by looping over or under.
              py *= 0.2;
              if (Math.hypot(px, pz) < 0.05) { const side = b.seed < 0.5 ? -1 : 1; px = hz * side; pz = -hx * side; }
            }
            const pl = Math.hypot(px, py, pz) || 1, bend = Math.min(Math.acos(along), turn * dt * (along > 0 ? across : 1));
            let ux = hx * Math.cos(bend) + (px / pl) * Math.sin(bend), uy = hy * Math.cos(bend) + (py / pl) * Math.sin(bend), uz = hz * Math.cos(bend) + (pz / pl) * Math.sin(bend);
            const ul = Math.hypot(ux, uy, uz) || 1;
            ux /= ul; uy /= ul; uz /= ul;
            speed += (cruise * (1 - 0.3 * uy) - speed) * Math.min(1, dt * (b.closing ? 4 : 1.6));
            b.vx = ux * speed; b.vy = uy * speed; b.vz = uz * speed;
            b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
            // Nothing it flies from or to is lower than its lowest perch: it never dips through that floor.
            if (b.y < lowest + 0.04) { b.y = lowest + 0.04; b.vy = Math.max(0, b.vy); }
            if (b.kept && b.state === FLYING) {
              // The roam is the air it has: a metre of grace, and no further.
              const edge = 0.6;
              if (b.x < roam.x[0] - edge) { b.x = roam.x[0] - edge; b.vx = Math.max(0, b.vx); } else if (b.x > roam.x[1] + edge) { b.x = roam.x[1] + edge; b.vx = Math.min(0, b.vx); }
              if (b.y < roam.y[0] - edge) { b.y = roam.y[0] - edge; b.vy = Math.max(0, b.vy); } else if (b.y > roam.y[1] + edge) { b.y = roam.y[1] + edge; b.vy = Math.min(0, b.vy); }
              if (b.z < roam.z[0] - edge) { b.z = roam.z[0] - edge; b.vz = Math.max(0, b.vz); } else if (b.z > roam.z[1] + edge) { b.z = roam.z[1] + edge; b.vz = Math.min(0, b.vz); }
            }
            const course = Math.atan2(b.vx, b.vz), swing = wrap(course - b.course);
            b.course = course;
            b.yaw += wrap(course - b.yaw) * Math.min(1, dt * 9);
            b.roll += (clamp(dt > 0 ? (-swing / dt) * 0.42 : 0, -1.1, 1.1) - b.roll) * Math.min(1, dt * 5);
            b.pitch += (Math.asin(clamp(uy, -1, 1)) * 0.8 - b.pitch) * Math.min(1, dt * 6);
            // Wings: hard beats off the perch and in the climb, easier in the cruise, held out in a glide.
            b.effort = Math.max(0, b.effort - dt * 0.9);
            const work = Math.max(b.effort, clamp(b.vy / 3, 0, 1) * 0.6);
            if (now > b.glideAt) {
              if (b.gliding) { b.gliding = false; b.glideAt = now + (habit.bound ? 0.25 + random() * 0.35 : 0.8 + random() * 2.6); }
              else if (work < 0.35 && random() < habit.glide * 1.6) { b.gliding = true; b.glideAt = now + (habit.bound ? 0.12 + random() * 0.14 : 0.35 + random() * 1.5 * habit.glide * 2); }
              else b.glideAt = now + 0.4 + random();
            }
            b.depth += ((b.gliding ? 0 : habit.depth * (0.75 + 0.45 * work)) - b.depth) * Math.min(1, dt * 10);
            b.phase += dt * TAU * (habit.flap + (habit.burst - habit.flap) * work);
            const held = (0.1 + 0.2 * (1 - b.depth / habit.depth)) * (habit.bound ? 0.3 : 1);
            wingIn = held + b.depth * Math.sin(b.phase); wingOut = held + b.depth * 1.25 * Math.sin(b.phase - 0.9);
            if (habit.bound && b.gliding) fold = 0.85;
            lift = -Math.cos(b.phase) * 0.012 * size * (b.depth / habit.depth);
            b.hyTo = clamp(swing * 6, -0.5, 0.5); b.nodTo = b.closing ? 0.3 : 0; b.tiltTo = 0;
          }
        }
        b.fold += (fold - b.fold) * Math.min(1, dt * (fold < b.fold ? 18 : 7));
        b.crouch += (crouch - b.crouch) * Math.min(1, dt * 22); b.lean += (lean - b.lean) * Math.min(1, dt * 9); b.fan += (fan - b.fan) * Math.min(1, dt * 8);
        b.tuck += (tuck - b.tuck) * Math.min(1, dt * 6); b.fluff += (fluff - b.fluff) * Math.min(1, dt * 5); b.neck += (neck - b.neck) * Math.min(1, dt * 8); b.tail += (tail - b.tail) * Math.min(1, dt * 16);
        const quick = Math.min(1, dt * 18 * habit.quick);
        b.hy += (b.hyTo - b.hy) * quick; b.nod += (b.nodTo - b.nod) * quick; b.tilt += (b.tiltTo - b.tilt) * quick;
        b.shade += (shade - b.shade) * Math.min(1, dt * 9);
        const p = i * 16, pose = batch.pose;
        pose[p] = wingIn; pose[p + 1] = wingOut; pose[p + 2] = b.fold; pose[p + 3] = 0;
        pose[p + 4] = b.hy; pose[p + 5] = b.neck; pose[p + 6] = b.nod; pose[p + 7] = b.tilt;
        pose[p + 8] = 0; pose[p + 9] = b.fan; pose[p + 10] = b.crouch; pose[p + 11] = b.lean;
        pose[p + 12] = b.tail; pose[p + 13] = b.fluff; pose[p + 14] = b.tuck; pose[p + 15] = 0;
        put(batch.matrix, p, b.x, b.y + lift, b.z, b.yaw, b.pitch, b.roll + shake, b.scale);
        setDecal(b.decal, b.x, b.slot >= 0 ? slots[b.slot].y : b.y, b.z, 0.16 * size, 0.24 * size, b.yaw, b.shade);
        if (targets) { targets[i].position.set(b.x, b.y + 0.085 * size, b.z); targets[i].rotation.y = b.yaw; }
      }
      batch.poses.needsUpdate = true;
      batch.mesh.instanceMatrix.needsUpdate = true;
    });

    startles.push((x, y, z, loudness, now) => {
      const reach = 50 * loudness;
      let leaving = 0, soonest = 1e9, cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < count; i += 1) {
        const b = all[i], far = Math.hypot(b.x - x, b.y - y, b.z - z);
        if (far > reach || b.state === AWAY) continue;
        if (b.state === FLYING || b.state === HOMING) {
          // Already up: jink away and stay up longer.
          // One jink a burst, not one a round, and never faster than it can fly.
          if (now - b.jinked > 1.6) {
            b.jinked = now;
            const dx = b.x - x, dz = b.z - z, flat = Math.hypot(dx, dz) || 1;
            b.vx += (dx / flat) * 2.5; b.vz += (dz / flat) * 2.5; b.vy += 1.2;
            const speed = Math.hypot(b.vx, b.vy, b.vz), most = habit.speed * 1.25;
            if (speed > most) { b.vx *= most / speed; b.vy *= most / speed; b.vz *= most / speed; }
          }
          b.effort = 1; b.gliding = false;
          b.back = Math.max(b.back, now + 15 + random() * 25);
          if (b.state === HOMING) { slots[b.slot].by = -1; b.slot = -1; b.state = FLYING; b.closing = false; }
        } else if (b.goAt < 0 || b.hop >= 0 || !b.scared) {
          // Nearest first, the rest a beat behind: the alarm runs along the perch.
          const wait = far / 60 + random() * random() * 0.45;
          if (b.hop >= 0) { slots[b.hop].by = -1; b.hop = -1; }
          if (b.state !== CROUCHED) b.goAt = now + wait;
          b.scared = true; b.fromX = x; b.fromZ = z; b.back = now + 15 + random() * 13 + random() * 12;
          leaving += 1; soonest = Math.min(soonest, wait); cx += b.x; cy += b.y; cz += b.z;
        }
      }
      if (leaving) { flushAt = now + soonest + 0.08; flushGain = clamp(0.4 + leaving * 0.1, 0, 1); flushX = cx / leaving; flushY = cy / leaving; flushZ = cz / leaving; }
      quietUntil = now + 5 + random() * 4;
    });

    // A hit: a puff of feathers; another of its kind flies in later.
    if (targets) strikes.push((object, point, now) => {
      const i = (targets as THREE.Object3D[]).indexOf(object);
      if (i < 0) return false;
      const b = all[i];
      if (b.state !== AWAY) {
        const dx = b.x - player.x, dz = b.z - player.z, far = Math.hypot(dx, dz) || 1;
        puff(point.x, point.y, point.z, (dx / far) * 1.5, (dz / far) * 1.5, 18, feather[0], feather[1], feather[2], 0.062 * Math.sqrt(size));
        if (b.slot >= 0) slots[b.slot].by = -1;
        if (b.hop >= 0) { slots[b.hop].by = -1; b.hop = -1; }
        b.slot = -1; b.goAt = -1; b.state = AWAY; b.until = now + 25 + random() * 20;
        targets[i].position.y = -40;
      }
      return true;
    });
    return batch.mesh;
  };

  const soaring: Life["soaring"] = (species, o) => {
    const habit = HABITS[species], random = stream(31), model = birdModel(species), count = scaled(o.count ?? 3);
    const cx = o.centre[0], cz = o.centre[2], radius = o.radius ?? 14, height = o.centre[1] + (o.height ?? 12), size = BIRD_LOOKS[species].size;
    const batch = flock(model.geometry, count, model.kin, birdTints(species, count, model.lacing, random), `life-${species}-soaring`);
    // How long it beats and how long it glides: gulls and swifts mostly glide, a crow rows.
    const beats: [number, number] = species === "gull" ? [0.7, 1.4] : species === "swift" ? [0.25, 0.6] : species === "crow" ? [4, 9] : [1.5, 3.5];
    const glides: [number, number] = species === "gull" ? [3, 8] : species === "swift" ? [0.5, 1.6] : species === "crow" ? [0.4, 1.1] : [0.5, 1.2];
    const all = Array.from({ length: count }, () => {
      const bearing = random() * TAU, out = Math.sqrt(random()) * radius * 0.8;
      return {
        x: cx + Math.sin(bearing) * out, y: height + (random() - 0.5) * 2, z: cz + Math.cos(bearing) * out, yaw: random() * TAU, turn: 0, turnTo: 0, hand: random() < 0.5 ? -1 : 1, flipAt: 0,
        pace: 0.85 + random() * 0.3, roll: 0, pitch: 0, phase: random() * TAU, depth: 0, beating: false, beatAt: random() * 3, boost: 0, seed: random(), wy: 0.12 + random() * 0.2, scale: 0.93 + random() * 0.14, hy: 0,
      };
    });
    let callAt = 4 + random() * 10;
    ticks.push((now, dt) => {
      if (habit.call && now > callAt) {
        callAt = now + (habit.every[0] + random() * (habit.every[1] - habit.every[0])) * 1.3;
        const b = all[Math.floor(random() * count)];
        say(habit.call, b.x, b.y, b.z, 0.7 + random() * 0.3, 0.9 + random() * 0.2);
      }
      for (let i = 0; i < count; i += 1) {
        const b = all[i], dx = cx - b.x, dz = cz - b.z, speed = habit.speed * b.pace * (1 + b.boost);
        // A steady turn that changes hand now and then (circles, then eights); past the edge it turns for home.
        if (now > b.flipAt) {
          b.flipAt = now + (species === "swift" ? 0.7 + random() * 2.2 : 5 + random() * 13);
          if (random() < 0.7) b.hand = -b.hand;
          b.turnTo = (b.hand * speed) / (radius * (0.22 + random() * 0.4));
        }
        let want = b.turnTo;
        if (dx * dx + dz * dz > radius * radius) want = clamp(wrap(Math.atan2(dx, dz) - b.yaw) * 1.5, -habit.turn, habit.turn);
        b.turn += (want - b.turn) * Math.min(1, dt * (species === "swift" ? 4 : 1.2));
        b.yaw += b.turn * dt;
        b.x += Math.sin(b.yaw) * speed * dt; b.z += Math.cos(b.yaw) * speed * dt;
        const climb = (height + Math.sin(now * b.wy + b.seed * 50) * (o.height ?? 12) * 0.12 + (species === "swift" ? Math.sin(now * b.wy * 5 + b.seed * 20) * 1.5 : 0) - b.y) * 0.7;
        b.y += climb * dt;
        b.boost = Math.max(0, b.boost - dt * 0.35);
        b.roll += (clamp(((-b.turn * speed) / 9.8) * 0.9, -1.05, 1.05) - b.roll) * Math.min(1, dt * 3);
        b.pitch += (clamp(climb / speed, -0.4, 0.4) - b.pitch) * Math.min(1, dt * 3);
        if (now > b.beatAt) {
          b.beating = !b.beating;
          const span = b.beating ? beats : glides;
          b.beatAt = now + span[0] + random() * (span[1] - span[0]);
        }
        b.depth += ((b.beating || b.boost > 0.2 ? habit.depth * 0.8 : 0) - b.depth) * Math.min(1, dt * 6);
        b.phase += dt * TAU * habit.flap * (1 + b.boost);
        // Gliding, the arm is raised and the hand droops: the shallow M of a gull overhead.
        const still = 1 - b.depth / (habit.depth * 0.8), p = i * 16, pose = batch.pose;
        b.hy += (clamp(b.turn * 0.8, -0.6, 0.6) + 0.3 * Math.sin(now * 0.6 + b.seed * 30) - b.hy) * Math.min(1, dt * 3);
        pose[p] = 0.13 * still + b.depth * Math.sin(b.phase); pose[p + 1] = -0.09 * still + b.depth * 1.25 * Math.sin(b.phase - 0.9); pose[p + 2] = 0; pose[p + 3] = 0;
        pose[p + 4] = b.hy; pose[p + 5] = 0.12; pose[p + 6] = 0.15; pose[p + 7] = 0;
        pose[p + 8] = 0; pose[p + 9] = 0.25 + 0.5 * Math.min(1, Math.abs(b.roll)); pose[p + 10] = 0; pose[p + 11] = 0;
        pose[p + 12] = 0; pose[p + 13] = 0; pose[p + 14] = 1; pose[p + 15] = 0;
        put(batch.matrix, p, b.x, b.y - Math.cos(b.phase) * 0.012 * size * (1 - still), b.z, b.yaw, b.pitch, b.roll, b.scale);
      }
      batch.poses.needsUpdate = true;
      batch.mesh.instanceMatrix.needsUpdate = true;
    });
    startles.push((x, _y, z, loudness) => {
      for (let i = 0; i < count; i += 1) {
        const b = all[i];
        if (Math.hypot(b.x - x, b.z - z) > 60 * loudness) continue;
        b.boost = 0.5 + random() * 0.3; b.beating = true; b.beatAt = time + 1.5 + random() * 1.5;
      }
    });
    return batch.mesh;
  };

  // ---- Chickens --------------------------------------------------------------------------------
  const STATIONS: ReadonlyArray<readonly [number, number]> = [[-5.5, -6], [0, -8], [5.5, -6], [-4, -18], [4, -18]];
  const HEN_BREEDS: THREE.ColorRepresentation[] = [0x8a4a2a, 0xb9b3a6, 0x2c2826, 0x94764a, 0x77736d, 0x5e3620];
  const FLEE = [0, 0.55, -0.55, 1.1, -1.1, 1.7, -1.7, 2.4, -2.4, Math.PI];
  const IDLE = 0, WALK = 1, PECK = 2, SCRATCH = 3, ALERT = 4, TROT = 5, BOLT = 6, GONE = 7;

  const chickens: Life["chickens"] = (o) => {
    const random = stream(37), ground = o.y ?? 0, blocked = options.blocked, shy = o.shy ?? 2.6;
    const areas = o.areas.map((a) => [Math.min(a[0], a[2]) + 0.12, Math.min(a[1], a[3]) + 0.12, Math.max(a[0], a[2]) - 0.12, Math.max(a[1], a[3]) - 0.12]);
    const sizes = areas.map((a) => Math.max(0.01, (a[2] - a[0]) * (a[3] - a[1])));
    const whole = sizes.reduce((sum, value) => sum + value, 0);
    /** Floor a hen may stand on: inside an area, not walled off, clear of the stations. */
    const open = (x: number, z: number) => {
      let inside = false;
      for (let i = 0; i < areas.length && !inside; i += 1) { const a = areas[i]; inside = x >= a[0] && x <= a[2] && z >= a[1] && z <= a[3]; }
      if (!inside || (blocked !== undefined && blocked(x, z))) return false;
      for (let i = 0; i < STATIONS.length; i += 1) { const dx = x - STATIONS[i][0], dz = z - STATIONS[i][1]; if (dx * dx + dz * dz < 6.25) return false; }
      return true;
    };
    const reach = (x0: number, z0: number, x1: number, z1: number) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.3));
      for (let s = 1; s <= steps; s += 1) if (!open(x0 + ((x1 - x0) * s) / steps, z0 + ((z1 - z0) * s) / steps)) return false;
      return true;
    };
    const breeds = (o.breeds ?? HEN_BREEDS).map((colour) => new THREE.Color(colour));
    const newHen = (cock: boolean) => {
      const breed = breeds[Math.floor(random() * breeds.length)];
      return {
        cock, state: IDLE, x: 0, z: 0, yaw: random() * TAU, aim: 0, speed: 0, tx: 0, tz: 0, until: 0.5 + random() * 4, since: 0, phase: random() * TAU, step: 0.045, stuck: 0,
        threatX: 0, threatZ: 0, veer: 0, fleeAt: 0, hand: random() < 0.5 ? -1 : 1, frightAt: -100, nerve: 9 + random() * 7, pecks: 0, preen: 0, hop: 0, hopV: 0, leap: false,
        hy: 0, nod: 0, tilt: 0, hyTo: 0, nodTo: 0, tiltTo: 0, lookAt: random() * 2, neck: 0, lean: 0, crouch: 0, fold: 1, fan: 0, bob: 0, fluff: 0,
        grow: 1, scale: cock ? 1 : 0.92 + random() * 0.16, seed: random(), decal: -1, index: 0, batch: null as unknown as Flock, proxy: null as unknown as THREE.Mesh,
        r: cock ? 0.3 : breed.r, g: cock ? 0.1 : breed.g, b: cock ? 0.04 : breed.b, lacing: 0.14 + random() * 0.2,
      };
    };
    type Hen = ReturnType<typeof newHen>;
    const all: Hen[] = [];
    const clear = (x: number, z: number, self: Hen) => {
      for (let j = 0; j < all.length; j += 1) {
        const other = all[j], dx = other.x - x, dz = other.z - z;
        if (other !== self && other.state !== GONE && dx * dx + dz * dz < 0.12) return false;
      }
      return true;
    };
    /** Finds a hen somewhere to stand: near the others to begin with, away from the player's eyes when she comes back. */
    const settle = (h: Hen, away: boolean) => {
      for (let tries = 0; tries < 70; tries += 1) {
        const mate = !away && all.length > 0 && tries < 40 && random() < 0.7 ? all[Math.floor(random() * all.length)] : null;
        let x: number, z: number;
        if (mate && mate !== h) { const a = random() * TAU, r = 0.5 + random() * 1.3; x = mate.x + Math.sin(a) * r; z = mate.z + Math.cos(a) * r; }
        else {
          let pick = random() * whole, k = 0;
          while (k < areas.length - 1 && pick > sizes[k]) { pick -= sizes[k]; k += 1; }
          x = areas[k][0] + random() * (areas[k][2] - areas[k][0]); z = areas[k][1] + random() * (areas[k][3] - areas[k][1]);
        }
        if (!open(x, z) || !clear(x, z, h)) continue;
        if (away && tries < 50) { const dx = x - player.x, dz = z - player.z, far = Math.hypot(dx, dz); if (far < 4 || (far < 10 && dx * player.fx + dz * player.fz > 0.2 * far)) continue; }
        h.x = x; h.z = z;
        return true;
      }
      return false;
    };
    const total = scaled(o.count ?? 5), withCock = o.cock ?? total >= 3;
    for (let i = 0; i < total; i += 1) { const h = newHen(withCock && i === 0); if (settle(h, false)) all.push(h); }
    if (all.length === 0) return null;
    const batches: Flock[] = [];
    for (const cock of [false, true]) {
      const members = all.filter((h) => h.cock === cock);
      if (members.length === 0) continue;
      const model = buildChicken(cock, high), tints = new Float32Array(members.length * 4);
      own(model.geometry);
      members.forEach((h, i) => { tints.set(cock ? [1, 1, 1, 0.3] : [h.r, h.g, h.b, h.lacing], i * 4); h.index = i; });
      const batch = flock(model.geometry, members.length, model.kin, tints, cock ? "life-cock" : "life-hens");
      for (const h of members) {
        const k = cock ? 1.16 : 1;
        h.batch = batch; h.decal = decal(); h.proxy = proxy(0.24 * k, 0.42 * k, 0.46 * k);
      }
      batches.push(batch);
    }

    let cluckAt = 1 + random() * 3, squawkAt = 0;
    ticks.push((now, dt) => {
      if (now > cluckAt) {
        cluckAt = now + 2.5 + random() * 4.5;
        const h = all[Math.floor(random() * all.length)];
        if (h.state < TROT) say("chickenCluck", h.x, ground + 0.3, h.z, 0.45 + random() * 0.4, (h.cock ? 0.78 : 0.95) + random() * 0.2);
      }
      for (let i = 0; i < all.length; i += 1) {
        const h = all[i], p = h.index * 16, pose = h.batch.pose, k = h.cock ? 1.16 : 1;
        if (h.state === GONE) {
          if (now >= h.until && settle(h, true)) { h.state = IDLE; h.grow = 0; h.until = now + 1 + random() * 2; h.yaw = random() * TAU; h.speed = 0; h.hop = h.hopV = 0; h.fold = 1; h.preen = 0; }
          else {
            if (now >= h.until) h.until = now + 2;
            put(h.batch.matrix, p, h.x, -40, h.z, 0, 0, 0, 0.001);
            setDecal(h.decal, h.x, ground, h.z, 0.1, 0.1, 0, 0);
            continue;
          }
        }
        h.grow = Math.min(1, h.grow + dt * 1.6);
        const near = player.seen ? Math.hypot(h.x - player.x, h.z - player.z) : 99;
        if (near < shy && h.state < TROT) {
          // Someone walking up: off she trots, grumbling.
          h.state = TROT; h.until = now + 0.7 + random() * 0.8; h.fleeAt = 0; h.stuck = 0; h.veer = (random() - 0.5) * 0.8; h.preen = 0;
          if (random() < 0.5) say("chickenCluck", h.x, ground + 0.3, h.z, 0.8, 1.12 + random() * 0.16);
        }
        if (now >= h.lookAt) {
          h.lookAt = now + 0.3 + random() * random() * 2.4;
          h.hyTo = (random() - 0.5) * 2.4; h.nodTo = (random() - 0.5) * 0.35; h.tiltTo = random() < 0.3 ? (random() - 0.5) * 0.9 : 0;
        }
        let pace = 0, stride = 0.045 * k, turn = 3.5, neck = 0, lean = h.cock ? -0.1 : 0, crouch = 0, fold = 1, bob = 0, fluff = 0, fan = 0, wingIn = 0, wingOut = 0, snap = 9;
        const e = now - h.since;
        if (h.state === IDLE) {
          if (now < h.preen) {
            // Preening: the head reaches back over a shoulder and works through the feathers.
            h.hyTo = h.hand * 2.3; h.nodTo = 0.6 + 0.15 * Math.sin(now * 21 + h.seed * 9); h.tiltTo = h.hand * 0.25; fluff = 0.5; h.lookAt = now + 0.2;
          } else if (now >= h.until) {
            const pick = random();
            h.since = now;
            if (pick < 0.5) {
              // Somewhere to go: a few steps off, in the open, often toward another of the flock.
              for (let tries = 0; tries < 6 && h.state === IDLE; tries += 1) {
                const mate = random() < 0.4 ? all[Math.floor(random() * all.length)] : h, a = random() * TAU, r = mate === h ? 0.8 + random() * 2.6 : 0.5 + random();
                const tx = mate.x + Math.sin(a) * r, tz = mate.z + Math.cos(a) * r;
                if (mate.state === GONE || !reach(h.x, h.z, tx, tz)) continue;
                h.tx = tx; h.tz = tz; h.state = WALK; h.until = now + 12;
              }
              if (h.state === IDLE) h.until = now + 0.5 + random();
            } else if (pick < 0.78) { h.state = PECK; h.pecks = 2 + Math.floor(random() * 4); }
            else if (pick < 0.9) h.state = SCRATCH;
            else if (pick < 0.95) { h.preen = now + 1.5 + random() * 2; h.hand = -h.hand; h.until = h.preen + 0.5 + random() * 2; }
            else h.until = now + 1 + random() * 3;
          }
        } else if (h.state === WALK) {
          const dx = h.tx - h.x, dz = h.tz - h.z;
          if (dx * dx + dz * dz < 0.02 || now > h.until) {
            h.since = now;
            if (random() < 0.6) { h.state = PECK; h.pecks = 1 + Math.floor(random() * 4); } else { h.state = IDLE; h.until = now + 0.6 + random() * 2.5; }
          } else { h.aim = Math.atan2(dx, dz); pace = (h.cock ? 0.36 : 0.3) * (0.85 + 0.3 * h.seed); bob = 1; neck = 0.06; h.hyTo = clamp(h.hyTo, -0.6, 0.6); }
        } else if (h.state === PECK) {
          // Tipped forward with her tail in the air: the head hovers over the ground and stabs at it.
          const t = e - 0.32, n = Math.floor(t / 0.5), u = t / 0.5 - n;
          if (t > 0 && n >= h.pecks) { h.state = IDLE; h.until = now + 0.5 + random() * 2; }
          const stab = t < 0 ? 0 : u < 0.24 ? smooth(0, 0.24, u) : u < 0.4 ? 1 : 1 - smooth(0.4, 0.75, u);
          lean = 0.66; crouch = 0.02 * k; neck = 0.95 + 0.55 * stab; snap = 30;
          h.nodTo = 0.15 + 0.2 * stab; h.hyTo = 0.3 * Math.sin(Math.max(0, n) * 12.9 + h.seed * 40); h.tiltTo = 0; h.lookAt = now + 0.3;
        } else if (h.state === SCRATCH) {
          // Raking the ground back with one foot and then the other, then a look at what turned up.
          if (e < 0.9) { h.phase += (dt * TAU) / 0.3; h.step += (0.06 * k - h.step) * Math.min(1, dt * 10); }
          lean = 0.3; neck = 0.45; crouch = 0.015 * k; h.nodTo = 0.3; h.hyTo = 0.25 * h.hand; h.tiltTo = 0; h.lookAt = now + 0.3;
          if (e > 1.2) { h.state = PECK; h.since = now - 0.2; h.pecks = 2 + Math.floor(random() * 3); }
        } else if (h.state === ALERT) {
          // Bolt upright and still, one eye on whatever it was.
          neck = -0.32; lean -= 0.12; crouch = e < 0.25 ? 0.03 * k * Math.sin((e / 0.25) * Math.PI) : -0.004;
          h.hyTo = clamp(wrap(Math.atan2(h.threatX - h.x, h.threatZ - h.z) - h.yaw) - h.hand * 1.25, -2.5, 2.5); h.nodTo = 0; h.tiltTo = 0; h.lookAt = now + 0.4;
          if (now > h.until) { h.state = IDLE; h.until = now + 0.5 + random() * 2; }
        } else if (h.state === TROT) {
          if (player.seen && near < 7) { h.threatX = player.x; h.threatZ = player.z; }
          pace = near < shy * 0.55 ? 2.4 : 1.35; stride = 0.075 * k; turn = 7; bob = 0.7; neck = -0.12; lean += 0.06;
          h.hyTo = 0; h.nodTo = 0; h.tiltTo = 0; h.lookAt = now + 0.3;
          h.stuck = h.speed < 0.05 ? h.stuck + dt : 0;
          if ((now > h.until && near > shy + 1.6) || h.stuck > 0.8) { h.state = ALERT; h.since = now; h.until = now + (h.stuck > 0.8 ? 2 : 0.7) + random() * 1.6; }
        } else {
          // Bolting: a start, a leap, then flat out with the wings going and the neck stretched.
          const left = h.until - now;
          if (e >= 0) {
            if (h.leap) { h.leap = false; h.hopV = 1.7 + random() * 1.2; }
            pace = 2.2 + 1.3 * clamp(left / 0.6, 0, 1); stride = 0.115 * k; turn = 10; fold = 0; fan = 0.7; neck = 0.3; lean += 0.2;
            const beat = now * 58 + h.seed * 30;
            wingIn = 0.2 + 0.8 * Math.sin(beat); wingOut = 0.1 + 0.95 * Math.sin(beat - 0.8);
            if (h.hop === 0 && h.hopV === 0 && random() < dt * 1.5) h.hopV = 0.9 + random();
          } else { crouch = 0.045 * k; neck = 0.2; }
          h.hyTo = 0; h.nodTo = -0.15; h.tiltTo = 0; h.lookAt = now + 0.3;
          if (left < 0) { h.state = TROT; h.stuck = 0; h.until = now + 0.5 + random() * 0.8; }
        }
        if (pace > 0) {
          if (h.state >= TROT && now >= h.fleeAt) {
            // Away from the fright by the first way that is open, looked for a few times a second.
            h.fleeAt = now + 0.22;
            const away = Math.atan2(h.x - h.threatX, h.z - h.threatZ) + h.veer;
            for (let c = 0; c < FLEE.length; c += 1) {
              const a = away + FLEE[c] * h.hand, sx = Math.sin(a), cz = Math.cos(a);
              if (open(h.x + sx * 0.4, h.z + cz * 0.4) && open(h.x + sx * 0.9, h.z + cz * 0.9)) { h.aim = a; break; }
            }
          }
          const off = wrap(h.aim - h.yaw);
          h.yaw += clamp(off, -turn * dt, turn * dt);
          h.speed += (pace * Math.max(0.15, Math.cos(off)) - h.speed) * Math.min(1, dt * (h.state === BOLT ? 12 : 5));
        } else h.speed -= h.speed * Math.min(1, dt * 8);
        if (h.speed > 0.02) {
          const nx = h.x + Math.sin(h.yaw) * h.speed * dt, nz = h.z + Math.cos(h.yaw) * h.speed * dt;
          if (open(nx, nz) && (h.state !== WALK || clear(nx, nz, h))) {
            h.x = nx; h.z = nz;
            h.step += (stride - h.step) * Math.min(1, dt * 6);
            h.phase += (TAU * h.speed * dt) / (4 * h.step);
          } else {
            h.speed = 0; h.fleeAt = 0;
            if (h.state === WALK) { h.state = IDLE; h.since = now; h.until = now + 0.3 + random(); }
          }
        }
        if (h.phase > TAU * 16) h.phase -= TAU * 16;
        if (h.hop > 0 || h.hopV > 0) { h.hop += h.hopV * dt; h.hopV -= 9.8 * dt; if (h.hop <= 0) h.hop = h.hopV = 0; }
        const moving = Math.min(1, h.speed * 3), quick = Math.min(1, dt * 20);
        h.neck += (neck - h.neck) * Math.min(1, dt * snap); h.lean += (lean - h.lean) * Math.min(1, dt * 7); h.crouch += (crouch - h.crouch) * Math.min(1, dt * 14);
        h.fold += (fold - h.fold) * Math.min(1, dt * (fold < h.fold ? 20 : 6)); h.fan += (fan - h.fan) * Math.min(1, dt * 8); h.bob += (bob - h.bob) * Math.min(1, dt * 6); h.fluff += (fluff - h.fluff) * Math.min(1, dt * 4);
        h.hy += (h.hyTo - h.hy) * quick; h.nod += (h.nodTo - h.nod) * quick; h.tilt += (h.tiltTo - h.tilt) * quick;
        pose[p] = wingIn; pose[p + 1] = wingOut; pose[p + 2] = h.fold; pose[p + 3] = h.phase;
        pose[p + 4] = h.hy; pose[p + 5] = h.neck; pose[p + 6] = h.nod; pose[p + 7] = h.tilt;
        pose[p + 8] = h.step; pose[p + 9] = h.fan; pose[p + 10] = h.crouch + h.step * 0.3 * (0.5 - 0.5 * Math.cos(2 * h.phase)) * moving; pose[p + 11] = h.lean;
        pose[p + 12] = 0; pose[p + 13] = h.fluff; pose[p + 14] = clamp(h.hop * 5, 0, 0.6); pose[p + 15] = h.bob;
        const size = h.scale * h.grow * h.grow * (3 - 2 * h.grow);
        put(h.batch.matrix, p, h.x, ground + h.hop, h.z, h.yaw, 0, 0.05 * Math.sin(h.phase) * moving, size);
        const cast = shade.reach * 0.2 * k * size;
        setDecal(h.decal, h.x + shade.x * cast, ground, h.z + shade.z * cast, 0.38 * k * size, (0.46 * k + shade.reach * 0.24) * size, shade.reach > 0.1 ? shade.yaw : h.yaw, h.grow * (1 - clamp(h.hop * 2.5, 0, 0.6)));
        h.proxy.position.set(h.x, ground + 0.23 * k + h.hop, h.z);
        h.proxy.rotation.y = h.yaw;
      }
      for (let i = 0; i < batches.length; i += 1) { batches[i].poses.needsUpdate = true; batches[i].mesh.instanceMatrix.needsUpdate = true; }
    });

    // A shot: the ones that have not just had a fright bolt, the rest only start and stare.
    startles.push((x, _y, z, loudness, now) => {
      let squawks = 0;
      for (let i = 0; i < all.length; i += 1) {
        const h = all[i], far = Math.hypot(h.x - x, h.z - z);
        if (h.state === GONE || far > 16 * loudness) continue;
        h.threatX = x; h.threatZ = z;
        if (now - h.frightAt > h.nerve || far < 5) {
          if (h.state !== BOLT) {
            h.leap = true; h.since = now + far / 60 + random() * 0.14;
            if (squawks < 2 && now > squawkAt) { squawks += 1; say("chickenSquawk", h.x, ground + 0.3, h.z, 0.7 + random() * 0.3, (h.cock ? 0.85 : 1) + random() * 0.2); }
          }
          h.state = BOLT; h.until = Math.max(h.since, now) + 0.9 + random() * 1.1; h.veer = (random() - 0.5) * 1.2; h.fleeAt = 0; h.frightAt = now; h.preen = 0;
        } else if (h.state < ALERT) { h.state = ALERT; h.since = now + random() * 0.1; h.until = now + 0.6 + random() * 1.2; h.preen = 0; }
      }
      if (squawks) squawkAt = now + 1.2;
    });

    // A hit: nothing left but feathers; another turns up later somewhere the player is not looking.
    strikes.push((object, point, now) => {
      for (let i = 0; i < all.length; i += 1) {
        const h = all[i];
        if (h.proxy !== object) continue;
        if (h.state !== GONE) {
          const dx = h.x - player.x, dz = h.z - player.z, far = Math.hypot(dx, dz) || 1;
          puff(point.x, Math.max(ground + 0.12, point.y), point.z, (dx / far) * 1.8, (dz / far) * 1.8, 46, h.r, h.g, h.b, 0.1);
          say("chickenSquawk", h.x, ground + 0.3, h.z, 1, 1.1 + random() * 0.2);
          h.state = GONE; h.until = now + 20 + random() * 20;
          h.proxy.position.y = -40;
          squawkAt = now + 0.6;
        }
        return true;
      }
      return false;
    });
    return batches[0].mesh;
  };

  // ---- Frame -----------------------------------------------------------------------------------
  let sun: THREE.DirectionalLight | null = null, sunSearch = 0;
  const viewport = new THREE.Vector2(), sunAim = new THREE.Vector3();
  const update = (now: number) => {
    if (disposed || now === lastNow) return;
    if (origin < 0) origin = now;
    const dt = lastNow < 0 ? 0 : clamp((now - lastNow) / 1000, 0, 0.1);
    lastNow = now;
    time = (now - origin) / 1000;
    wind.update(now);
    shared.lifeTime.value = time;
    shared.lifeViewport.value = kit.renderer.getDrawingBufferSize(viewport).y;
    // Smoke and dust are lit by what lights the map: the sky (its fog colour stands for it) and the sun.
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) shared.lifeAmbient.value.copy(fog.color);
    if (!sun && (sunSearch -= 1) < 0) {
      sunSearch = 90;
      for (const child of scene.children) if ((child as THREE.DirectionalLight).isDirectionalLight && child.castShadow) { sun = child as THREE.DirectionalLight; break; }
    }
    if (sun) {
      shared.lifeSun.value.copy(sun.color).multiplyScalar(sun.intensity / Math.PI);
      shared.lifeSunDir.value.copy(sun.position).sub(sunAim.copy(sun.target.position)).normalize();
      const dir = shared.lifeSunDir.value, flat = Math.hypot(dir.x, dir.z);
      if (sun.visible && sun.intensity > 0.2 && flat > 0.01 && dir.y > 0.05) { shade.x = -dir.x / flat; shade.z = -dir.z / flat; shade.reach = Math.min(1.5, flat / dir.y); shade.yaw = Math.atan2(shade.x, shade.z); } else shade.reach = 0;
    }
    for (let i = 0; i < ticks.length; i += 1) ticks[i](time, dt);
    if (decals && decalsDirty) { decals.instanceMatrix.needsUpdate = true; decals.instanceColor!.needsUpdate = true; decalsDirty = false; }
    if (feathers && feathers.mesh.visible && time > feathers.until) feathers.mesh.visible = feathers.down.visible = false;
  };

  const startle: Life["startle"] = (at, loudness) => {
    for (let i = 0; i < startles.length; i += 1) startles[i](at.x, at.y, at.z, loudness, time);
  };
  const struck: Life["struck"] = (object, point) => {
    for (let i = 0; i < strikes.length; i += 1) if (strikes[i](object, point, time)) return true;
    return false;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    restores.forEach((restore) => restore());
    owned.forEach((object) => object.removeFromParent());
    for (const mesh of shootable) { const at = kit.shootable.indexOf(mesh); if (at >= 0) kit.shootable.splice(at, 1); }
    disposables.forEach((item) => item.dispose());
    flakeGrids = {};
  };

  kit.updates.push(update);
  kit.track({ dispose });

  return { birds, soaring, chickens, drift, insects, sway, cloth, plume, flicker, update, startle, struck, shootable, dispose };
}

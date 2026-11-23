import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { brushedMetal, paintedSteel, pbrMaterial, steel, tile } from "./pbr";
import { BRAND, FIRE_SHADER, STRIKE_ORANGE, canvasTexture, createKit, hazardTexture, iBeam, jerseyBarrier, projectUv, softBox, softDiscTexture, worldBox, type RangeEnvironment, type RangeOptions, type Transform } from "./kit";
import { createLife } from "./life";
import { createProps, type PropItem, type PropKind } from "./props";
import { createTrees, type TreeItem } from "./trees";
import { createWind } from "./wind";
import { waterMaterial } from "./water";
import { leanAssets } from "./touch";

export { projectUv } from "./kit";
export type { RangeEnvironment, RangeQuality } from "./kit";

// The physical range: architecture, structure, fixtures, props and lighting.
//
// Lighting model: the room is sealed, so the only daylight is a sun that enters
// through three roof lights and casts real shadows of the glazing bars, trusses
// and ducts. Everything else is lit by what is actually in the room — lamp
// tubes, screens and the furnace — captured once into a local reflection probe
// that replaces the outdoor sky as the image-based light.

const SKYLIGHTS = [2.1, -10.3, -22.7];
const SKYLIGHT_HALF = { x: 3.45, z: 1.725 };
const SKYLIGHT_Y = 6.2;
/** The roof light that has lost a pane (the middle one). */
const BROKEN_LIGHT = SKYLIGHTS[1];

/** Emissive display with a glossy face so screens pick up reflections like real panels. */
export function displayMaterial(texture: THREE.Texture, gain = 1) {
  return new THREE.MeshPhysicalMaterial({
    color: 0x010203,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: gain,
    roughness: 0.3,
    metalness: 0,
    // Soft sheen only: lamp hot-spots must never hide market copy.
    specularIntensity: 0.35,
    envMapIntensity: 0.5,
  });
}

/** Flames for the furnace firebox: additive tongues that rise off the bed and thin out toward the crown. */
const HEARTH_FRAGMENT = /* glsl */`
  uniform float time;
  uniform float seed;
  uniform float gain;
  uniform float lift;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += noise(p) * a; p = p * 2.02 + 11.3; a *= 0.5; } return s; }
  void main() {
    vec2 p = vec2(vUv.x * 3.4 + seed, vUv.y * 1.9);
    float rise = time * 1.3;
    float warp = fbm(p * 1.2 + vec2(seed, -rise * 0.5));
    float turbulence = fbm(p * 1.8 + vec2(warp * 1.6, -rise));
    // Separate tongues: the bed burns unevenly, so the flame height wanders along its width.
    float tongues = 0.72 + 0.28 * sin(vUv.x * 11.0 + seed * 2.0 + sin(time * 0.6 + seed) * 1.5) + 0.18 * (noise(vec2(vUv.x * 5.0 + seed, time * 0.35)) - 0.5);
    float body = turbulence * 1.6 * tongues - vUv.y * lift + 0.34;
    float heat = clamp(smoothstep(0.12, 0.95, body), 0.0, 1.4);
    vec3 color = vec3(1.0, 0.09, 0.012) * smoothstep(0.0, 0.5, heat) * 2.0
               + vec3(1.0, 0.42, 0.04) * smoothstep(0.3, 0.85, heat) * 4.0
               + vec3(1.0, 0.86, 0.5) * smoothstep(0.76, 1.2, heat) * 4.6;
    float edge = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.9, vUv.x) * smoothstep(1.0, 0.72, vUv.y);
    gl_FragColor = vec4(color * gain * edge, 1.0);
  }
`;

/** Rings spreading from where a drop lands: two crests that fade as they widen. */
const RIPPLE_FRAGMENT = /* glsl */`
  uniform float age;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0, rings = 0.0;
    for (int i = 0; i < 2; i++) {
      float t = age - float(i) * 0.24;
      if (t > 0.0) rings += smoothstep(0.075, 0.0, abs(r - t * 0.6)) * max(0.0, 1.0 - t / 1.35);
    }
    gl_FragColor = vec4(vec3(0.46, 0.72, 0.7) * rings * smoothstep(1.0, 0.8, r) * 0.8, 1.0);
  }
`;

export function buildRange(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const props = createProps(kit);
  const { scene, high, anisotropy, shootable, keep, track, photoSet, wall, place, instances } = kit;
  // One draught for the whole hall, drawn in under the Bay 01 door and across to the furnace stack:
  // the plants, the birds, smoke, dust and everything that hangs all read it.
  const wind = createWind({ heading: -0.95, strength: 0.14, gustiness: 0.5 });
  const life = createLife(kit, options, { wind, seed: 61 });
  const cue = options.cue;
  const PI = Math.PI;
  const side2 = [-1, 1];
  const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s?: [number, number, number]): Transform => ({ position: [x, y, z], rotation: [rx, ry, rz], ...(s ? { scale: s } : {}) });
  /** Euler angles for something turned about world axes one step after another: lay it down, then swing it round. */
  const turned = (...steps: Array<["x" | "y" | "z", number]>): [number, number, number] => {
    const whole = new THREE.Quaternion(), step = new THREE.Quaternion(), axis = new THREE.Vector3();
    for (const [name, angle] of steps) whole.premultiply(step.setFromAxisAngle(axis.set(name === "x" ? 1 : 0, name === "y" ? 1 : 0, name === "z" ? 1 : 0), angle));
    const euler = new THREE.Euler().setFromQuaternion(whole, "XYZ");
    return [euler.x, euler.y, euler.z];
  };

  // ---- Materials -----------------------------------------------------------
  const slab = photoSet("/textures/concrete_floor_worn_001-2k", 38 / 4.2, 52 / 4.2);
  const cast = wall("castStained");
  const corrugated = photoSet("/textures/corrugated_iron_02-2k", 1, 1, false);
  const treadPlate = photoSet("/textures/metal_plate-2k", 1, 1, false);
  const greenSteel = photoSet("/textures/green_metal_rust-2k", 1, 1, false);
  const rustySteel = photoSet("/textures/rusty_metal_02-2k", 1, 1, false);
  const planks = photoSet("/textures/weathered_brown_planks-2k", 1, 1, false);
  const brick = wall("foundryCommon", 1.3);

  const machinePaint = keep(paintedSteel(anisotropy, [0.04, 0.062, 0.068], 211, 0.12));
  const darkSteel = keep(steel(anisotropy, [0.1, 0.11, 0.12], 0.46, 23));
  const beamSteel = keep(steel(anisotropy, [0.16, 0.17, 0.175], 0.58, 29));
  const duct = keep(tile(brushedMetal(anisotropy, [0.5, 0.52, 0.53], 31), 3, 14));
  const yellowSet = keep(paintedSteel(anisotropy, [0.5, 0.3, 0.025], 411, 0.55, 512));

  // Photographed corrugated sheet pulled toward the room's teal grade.
  const claddingMaterial = new THREE.MeshStandardMaterial({ ...corrugated, color: new THREE.Color(0.8, 1.22, 1.3), roughness: 0.9, metalness: 0.45, normalScale: new THREE.Vector2(1.4, 1.4), envMapIntensity: 0.9 });
  const machineMaterial = pbrMaterial(machinePaint, { envMapIntensity: 1 });
  const structural = pbrMaterial(beamSteel, { envMapIntensity: 0.9 });
  const darkMetal = pbrMaterial(darkSteel, { envMapIntensity: 1.1 });
  const ductMaterial = pbrMaterial(duct, { envMapIntensity: 1.1 });
  const deckMaterial = new THREE.MeshStandardMaterial({ ...corrugated, color: new THREE.Color(1.5, 1.72, 1.75), roughness: 0.8, metalness: 0.6, normalScale: new THREE.Vector2(1.8, 1.8), envMapIntensity: 0.8 });
  const plateMaterial = new THREE.MeshStandardMaterial({ ...treadPlate, color: new THREE.Color(0.85, 1.05, 1.1), roughness: 0.85, metalness: 0.65, normalScale: new THREE.Vector2(1.5, 1.5), envMapIntensity: 0.9 });
  const greenPaint = new THREE.MeshStandardMaterial({ ...greenSteel, color: new THREE.Color(0.62, 0.95, 1.25), roughness: 0.8, metalness: 0.3, envMapIntensity: 0.9 });
  const rustMaterial = new THREE.MeshStandardMaterial({ ...rustySteel, color: new THREE.Color(0.5, 0.5, 0.48), roughness: 0.95, metalness: 0.45, envMapIntensity: 0.7 });
  const orangePaint = new THREE.MeshStandardMaterial({ ...rustySteel, color: new THREE.Color(0.95, 0.4, 0.12), roughness: 0.85, metalness: 0.3, envMapIntensity: 0.8 });
  const planksMaterial = new THREE.MeshStandardMaterial({ ...planks, color: new THREE.Color(1.25, 1.05, 0.85), roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const yellowPaint = pbrMaterial(yellowSet, { envMapIntensity: 1 });
  const redPaint = new THREE.MeshStandardMaterial({ color: 0x8e1710, roughness: 0.36, metalness: 0.25, envMapIntensity: 1 });
  const conePlastic = new THREE.MeshStandardMaterial({ color: 0xc4521a, roughness: 0.55, metalness: 0, envMapIntensity: 0.7 });
  const darkGlass = new THREE.MeshStandardMaterial({ color: 0x05090a, roughness: 0.08, metalness: 0.2, envMapIntensity: 1.6 });
  const concrete = new THREE.MeshStandardMaterial({ ...cast, normalScale: new THREE.Vector2(0.9, 0.9), color: 0xa3a69d, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 });
  // Lamp light the shadowless point lights cannot give the lower walls is painted once into a light map:
  // a warm pool round every bulkhead lamp and the wash of the LED guide along the foot of each wall.
  const bayZ = [4, -2, -8, -14, -20, -26];
  const wallLight = track(canvasTexture(2048, 512, (c) => {
    c.fillStyle = "#000"; c.fillRect(0, 0, 2048, 512);
    c.globalCompositeOperation = "lighter";
    side2.forEach((side, row) => {
      const px = (z: number) => (z + 30) / 42 * 2048, py = (y: number) => row * 256 + (1 - (y - 0.2) / 4.2) * 256;
      c.save(); c.beginPath(); c.rect(0, row * 256, 2048, 256); c.clip();
      const wash = c.createLinearGradient(0, py(1.5), 0, py(0.2));
      const led = side < 0 ? "150,84,26" : "44,128,112";
      wash.addColorStop(0, `rgba(${led},0)`); wash.addColorStop(0.62, `rgba(${led},0.34)`); wash.addColorStop(0.82, `rgba(${led},0.8)`); wash.addColorStop(1, `rgba(${led},0.3)`);
      c.fillStyle = wash; c.fillRect(0, py(1.5), 2048, py(0.2) - py(1.5));
      for (const z of bayZ) {
        const pool = c.createRadialGradient(0, 0, 0, 0, 0, 1);
        pool.addColorStop(0, "rgba(255,150,62,0.95)"); pool.addColorStop(0.2, "rgba(255,132,50,0.62)"); pool.addColorStop(0.5, "rgba(214,98,34,0.24)"); pool.addColorStop(1, "rgba(160,70,20,0)");
        c.save(); c.translate(px(z), py(2.95)); c.scale(3.1 * 48.76, 2.3 * 60.95); c.fillStyle = pool; c.beginPath(); c.arc(0, 0, 1, 0, PI * 2); c.fill(); c.restore();
      }
      c.restore();
    });
  }));
  wallLight.channel = 1;
  const brickMaterial = new THREE.MeshStandardMaterial({ ...brick, normalScale: new THREE.Vector2(1.25, 1.25), color: 0xc9b9aa, roughness: 0.96, metalness: 0, aoMapIntensity: 0.9, envMapIntensity: 0.45, lightMap: wallLight, lightMapIntensity: 4.5 });
  // Furnace finishes: plate that has been hot for years, and a refractory lining lit by its own fire.
  const casingMaterial = new THREE.MeshStandardMaterial({ ...rustySteel, color: new THREE.Color(0.34, 0.3, 0.275), roughness: 0.8, metalness: 0.6, envMapIntensity: 0.8 });
  const fireBrick = new THREE.MeshStandardMaterial({ ...brick, color: new THREE.Color(0.72, 0.58, 0.48), roughness: 1, metalness: 0, envMapIntensity: 0.15, emissive: new THREE.Color(1, 0.3, 0.06), emissiveMap: brick.map, emissiveIntensity: 1.5 });

  // ---- Floor ---------------------------------------------------------------
  const floorMaterial = new THREE.MeshStandardMaterial({
    ...slab,
    normalScale: new THREE.Vector2(1.15, 1.15),
    color: 0xa9aca6,
    roughness: 0.86,
    metalness: 0,
    aoMapIntensity: 0.85,
    envMapIntensity: 0.4,
  });
  const reflection = kit.floor(floorMaterial, { width: 38, depth: 52, z: -8 }, {
    lane: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.8),
    edge: new THREE.Color(0.62, 0.6, 0.52),
  });

  // ---- Walls ---------------------------------------------------------------
  // Where the kerb and the LED guide stop on each side wall: door openings and the furnace.
  const wallBreaks: Record<number, Array<[number, number]>> = { [-1]: [[-5.62, -3.58], [4.86, 8.74]], [1]: [[-13.42, -9.78], [-7.22, -5.18]] };
  const wallRuns = (side: number, from: number, to: number) => {
    const runs: Array<[number, number]> = [];
    let start = from;
    for (const [a, b] of wallBreaks[side]) { runs.push([start, a]); start = b; }
    runs.push([start, to]);
    return runs;
  };
  side2.forEach((side, row) => {
    place(new THREE.Mesh(worldBox(0.7, 8, 48, 2.4), claddingMaterial), side * 10, 4, -9, true, true);
    // Brickwork at true brick size, with a second UV set addressing its strip of the light map.
    const brickwork = worldBox(0.12, 4.2, 42, 1.3);
    const position = brickwork.attributes.position, lightUv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i += 1) {
      lightUv[i * 2] = (position.getZ(i) + 21) / 42;
      lightUv[i * 2 + 1] = 1 - (row + 1 - (position.getY(i) + 2.1) / 4.2) / 2;
    }
    brickwork.setAttribute("uv1", new THREE.BufferAttribute(lightUv, 2));
    place(new THREE.Mesh(brickwork, brickMaterial), side * 9.6, 2.3, -9, false, true);
  });
  // Cast kerb at the foot of the brickwork, broken at every door, and a steel capping above it.
  place(new THREE.Mesh(mergeGeometries(side2.flatMap((side) => wallRuns(side, -30, 12).map(([a, b]) => softBox(0.3, 0.32, b - a, 0.03, 2.2).translate(side * 9.48, 0.16, (a + b) / 2)))), concrete), 0, 0, 0, false, true);
  instances(worldBox(0.2, 0.09, 42, 1.4), structural, side2.map((side) => T(side * 9.56, 4.44, -9)), false, false);
  place(new THREE.Mesh(worldBox(20, 7, 0.6, 2.4), claddingMaterial), 0, 3.5, -29, true, true);
  place(new THREE.Mesh(worldBox(20, 8, 0.6, 2.4), claddingMaterial), 0, 4, 10, true, true);

  // ---- Structure -----------------------------------------------------------
  instances(iBeam(0.44, 0.46, 6.25, 0.045, 0.035), structural, bayZ.flatMap((z) => [-9.42, 9.42].map((x) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, Math.PI / 2, 0] as [number, number, number] }))));
  // Base plates with anchor bolts.
  instances(worldBox(0.62, 0.035, 0.6, 1.4), structural, bayZ.flatMap((z) => [-9.4, 9.4].map((x) => ({ position: [x, 0.018, z] as [number, number, number] }))), false, false);
  instances(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 6), darkMetal, bayZ.flatMap((z) => [-9.4, 9.4].flatMap((x) => [[-0.25, -0.24], [0.25, -0.24], [-0.25, 0.24], [0.25, 0.24]].map(([ox, oz]) => ({ position: [x + ox, 0.05, z + oz] as [number, number, number] })))), false, false);

  // Gallery decks along both walls with brackets and a two-rail balustrade.
  instances(softBox(2.2, 0.24, 5.3, 0.02, 1.3), plateMaterial, bayZ.flatMap((z) => [-8.55, 8.55].map((x) => ({ position: [x, 3.78, z - 2.7] as [number, number, number] }))));
  instances(worldBox(1.9, 0.14, 0.1, 1.4), structural, bayZ.flatMap((z) => [-8.5, 8.5].map((x) => ({ position: [x, 3.59, z - 0.34] as [number, number, number] }))), false);
  const railTransforms = bayZ.flatMap((z) => [-7.62, 7.62].map((x) => ({ x, z: z - 2.7 })));
  const railGeometry = new THREE.CylinderGeometry(0.024, 0.024, 5.3, 8);
  railGeometry.rotateX(Math.PI / 2);
  instances(railGeometry, ductMaterial, railTransforms.flatMap(({ x, z }) => [4.92, 4.42].map((y) => ({ position: [x, y, z] as [number, number, number] }))), false);
  instances(new THREE.CylinderGeometry(0.022, 0.022, 1.04, 8), ductMaterial, bayZ.flatMap((z) => [-7.62, 7.62].flatMap((x) => [z - 5.1, z - 3.5, z - 1.9, z - 0.3].map((postZ) => ({ position: [x, 4.42, postZ] as [number, number, number] })))), false);
  instances(worldBox(0.012, 0.1, 5.3, 1.4), structural, railTransforms.map(({ x, z }) => ({ position: [x, 3.96, z] as [number, number, number] })), false, false);

  // Open-web roof trusses.
  const trussZ = [8, 1.8, -4.4, -10.6, -16.8, -23];
  instances(worldBox(19.3, 0.11, 0.15, 1.4), structural, trussZ.flatMap((z) => [6.14, 5.72].map((y) => ({ position: [0, y, z] as [number, number, number] }))), false);
  const webRun = 1.2, webRise = 0.42, webAngle = Math.atan2(webRise, webRun);
  instances(worldBox(Math.hypot(webRun, webRise), 0.05, 0.05, 1.4), structural, trussZ.flatMap((z) => Array.from({ length: 16 }, (_, index) => ({
    position: [-9 + webRun / 2 + index * webRun, 5.93, z] as [number, number, number],
    rotation: [0, 0, index % 2 ? -webAngle : webAngle] as [number, number, number],
  }))), false);
  instances(worldBox(0.05, 0.42, 0.05, 1.4), structural, trussZ.flatMap((z) => [-9.6, -4.8, 0, 4.8, 9.6].map((x) => ({ position: [x, 5.93, z] as [number, number, number] }))), false);
  // Purlins tie the trusses together under the deck.
  instances(worldBox(0.08, 0.1, 38, 1.4), structural, [-8.4, -6, 6, 8.4].map((x) => ({ position: [x, 6.19, -9.5] as [number, number, number] })), false, false);

  // ---- Roof ----------------------------------------------------------------
  // One sheet of decking: the side runs, and centre panels that reach under the roof-light kerbs and into
  // the end walls so no daylight (or sun) gets in except through the glazing.
  const deckSpans: Array<[number, number, number, number]> = [
    [-10, -3.7, -31.5, 12.5], [3.7, 10, -31.5, 12.5],
    [-3.7, 3.7, SKYLIGHTS[0] + 1.98, 9.95], [-3.7, 3.7, SKYLIGHTS[1] + 1.98, SKYLIGHTS[0] - 1.98], [-3.7, 3.7, SKYLIGHTS[2] + 1.98, SKYLIGHTS[1] - 1.98], [-3.7, 3.7, -28.9, SKYLIGHTS[2] - 1.98],
  ];
  place(new THREE.Mesh(mergeGeometries(deckSpans.map(([x0, x1, z0, z1]) => projectUv(new THREE.BoxGeometry(x1 - x0, 0.18, z1 - z0).translate((x0 + x1) / 2, 6.34, (z0 + z1) / 2), 2.6))), deckMaterial), 0, 0, 0, true);
  const grime = track(canvasTexture(2048, 1024, (c) => {
    c.clearRect(0, 0, 2048, 1024);
    c.scale(2, 2);
    // Clean centres, dirt gathered along the glazing bars and run-off streaks down the slope.
    for (let pane = 0; pane < 6; pane += 1) {
      const px = (pane % 3) * 341.3, py = Math.floor(pane / 3) * 256;
      const g = c.createRadialGradient(px + 170, py + 128, 30, px + 170, py + 128, 215);
      g.addColorStop(0, "rgba(190,205,200,0.08)"); g.addColorStop(0.7, "rgba(170,185,175,0.2)"); g.addColorStop(1, "rgba(120,130,115,0.62)");
      c.fillStyle = g; c.fillRect(px, py, 342, 256);
    }
    let seed = 913;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 260; i += 1) {
      const x = next() * 1024, y = next() * 512, len = 20 + next() * 120;
      c.strokeStyle = `rgba(${110 + next() * 60},${125 + next() * 50},${110 + next() * 40},${0.05 + next() * 0.16})`;
      c.lineWidth = 1 + next() * 5; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (next() - 0.5) * 8, y + len); c.stroke();
    }
    for (let i = 0; i < 2600; i += 1) { c.fillStyle = `rgba(90,100,85,${next() * 0.26})`; c.fillRect(next() * 1024, next() * 512, 0.5 + next() * 1.5, 0.5 + next() * 2); }
  }));
  grime.anisotropy = anisotropy;
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ea, map: grime, transparent: true, opacity: 0.9, roughness: 0.06, metalness: 0, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false });
  // The middle roof light has lost the pane in its south-west corner and cracked the one beside it:
  // the same sheet of glazing with two cells cut out and the shards left standing in their frames.
  const brokenGlazing = () => {
    const whole = new THREE.PlaneGeometry(6.9, 3.45, 6, 4).toNonIndexed(), position = whole.attributes.position, uv = whole.attributes.uv;
    const cellW = 1.15, cellH = 0.8625, points: number[] = [], uvs: number[] = [];
    for (let face = 0; face < position.count; face += 3) {
      const cx = (position.getX(face) + position.getX(face + 1) + position.getX(face + 2)) / 3, cy = (position.getY(face) + position.getY(face + 1) + position.getY(face + 2)) / 3;
      if (cx < -1.15 && cy < -cellH) continue;
      for (let v = face; v < face + 3; v += 1) { points.push(position.getX(v), position.getY(v), 0); uvs.push(uv.getX(v), uv.getY(v)); }
    }
    /** What is left in a cell: a fan of triangles round the first corner, in cell units. */
    const shard = (cell: number, corners: number[][]) => {
      for (let i = 1; i < corners.length - 1; i += 1) for (const [u, v] of [corners[0], corners[i], corners[i + 1]]) {
        const x = -3.45 + (cell + u) * cellW, y = -1.725 + v * cellH;
        points.push(x, y, 0); uvs.push((x + 3.45) / 6.9, (y + 1.725) / 3.45);
      }
    };
    for (const corners of [[[0, 1], [0.42, 1], [0, 0.55]], [[1, 1], [1, 0.5], [0.7, 1]], [[1, 0], [0.55, 0], [1, 0.28]], [[0, 0], [0, 0.22], [0.3, 0]]]) shard(0, corners);
    shard(1, [[1, 1], [1, 0], [0.62, 0], [0.38, 0.45], [0.12, 0.3], [0, 0.62], [0, 1]]);
    whole.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(points.map((_, index) => (index % 3 === 2 ? 1 : 0)), 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    return geometry;
  };
  SKYLIGHTS.forEach((z) => {
    const kerbs: Array<[number, number, number, number, number]> = [
      [7.8, 0.34, 0, z - 1.98, 0], [7.8, 0.34, 0, z + 1.98, 0], [0.34, 3.62, -3.73, z, 0], [0.34, 3.62, 3.73, z, 0],
    ];
    kerbs.forEach(([w, d, x, kz]) => place(new THREE.Mesh(worldBox(w, 0.3, d, 1.4), structural), x, 6.32, kz, true));
    // Glazing bars: these are what print the window pattern into the sun patches.
    for (const x of [-1.15, 1.15]) place(new THREE.Mesh(worldBox(0.07, 0.08, 3.62, 1.4), structural), x, 6.22, z, true);
    place(new THREE.Mesh(worldBox(6.9, 0.08, 0.07, 1.4), structural), 0, 6.22, z, true);
    const pane = new THREE.Mesh(z === BROKEN_LIGHT ? brokenGlazing() : new THREE.PlaneGeometry(6.9, 3.45), glass);
    pane.rotation.x = -Math.PI / 2;
    pane.position.set(0, 6.26, z);
    scene.add(pane);
  });

  // ---- Lamps ---------------------------------------------------------------
  const lampSpots = trussZ.flatMap((z) => [-5, 0, 5].filter((x) => x !== 0 || !SKYLIGHTS.some((sky) => Math.abs(sky - z) < 2.6)).map((x) => ({ x, z })));
  instances(softBox(2.86, 0.09, 0.24, 0.02, 1.4), darkMetal, lampSpots.map(({ x, z }) => ({ position: [x, 5.565, z] as [number, number, number] })), false);
  instances(worldBox(0.012, 0.16, 0.012, 1.4), darkMetal, lampSpots.flatMap(({ x, z }) => [-1.1, 1.1].map((o) => ({ position: [x + o, 5.66, z] as [number, number, number] }))), false, false);
  const tubeMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd9fff6).multiplyScalar(4.2), toneMapped: false });
  const tubeGeometry = new THREE.CylinderGeometry(0.028, 0.028, 2.66, 10);
  tubeGeometry.rotateZ(Math.PI / 2);
  // One fitting over the right-hand stations is on its way out: its tubes have a material of their own to stutter with.
  const failing = lampSpots.find(({ x, z }) => x === 5 && z === -4.4) ?? lampSpots[0];
  const tubePair = (spots: Array<{ x: number; z: number }>) => spots.flatMap(({ x, z }) => [-0.055, 0.055].map((o) => ({ position: [x, 5.5, z + o] as [number, number, number] })));
  instances(tubeGeometry, tubeMaterial, tubePair(lampSpots.filter((spot) => spot !== failing)), false, false);
  const failingTube = tubeMaterial.clone();
  instances(tubeGeometry, failingTube, tubePair([failing]), false, false).name = "foundry-failing-tube";
  life.flicker(failingTube, "tube", { at: [failing.x, 5.5, failing.z] });
  // Warm bulkhead lamps on every column give the cool room its colour contrast.
  const bulkheadMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb468).multiplyScalar(4.2), toneMapped: false });
  instances(softBox(0.1, 0.3, 0.2, 0.03, 1), darkMetal, bayZ.flatMap((z) => [-9.16, 9.16].map((x) => ({ position: [x, 3.1, z] as [number, number, number] }))), false);
  instances(softBox(0.05, 0.2, 0.13, 0.02, 1), bulkheadMaterial, bayZ.flatMap((z) => [-9.105, 9.105].map((x) => ({ position: [x, 3.1, z] as [number, number, number] }))), false, false);

  // ---- Services ------------------------------------------------------------
  const ductGeometry = new THREE.CylinderGeometry(0.23, 0.23, 39, 20);
  ductGeometry.rotateX(Math.PI / 2);
  instances(ductGeometry, ductMaterial, [-7.2, 7.2].map((x) => ({ position: [x, 5.3, -10.5] as [number, number, number] })), false);
  const flange = new THREE.CylinderGeometry(0.255, 0.255, 0.05, 20);
  flange.rotateX(Math.PI / 2);
  const ductJoints = Array.from({ length: 14 }, (_, index) => 8.2 - index * 2.9);
  instances(flange, structural, ductJoints.flatMap((z) => [-7.2, 7.2].map((x) => ({ position: [x, 5.3, z] as [number, number, number] }))), false, false);
  instances(worldBox(0.014, 0.66, 0.014, 1), darkMetal, ductJoints.filter((_, index) => index % 2 === 0).flatMap((z) => [-7.2, 7.2].flatMap((x) => [-0.24, 0.24].map((o) => ({ position: [x + o, 5.83, z + 0.08] as [number, number, number] })))), false, false);
  // Electrical conduit runs with junction boxes at each column.
  const conduit = new THREE.CylinderGeometry(0.022, 0.022, 41.6, 8);
  conduit.rotateX(Math.PI / 2);
  instances(conduit, ductMaterial, [-9.56, 9.56].flatMap((x) => [4.62, 4.72, 4.82].map((y) => ({ position: [x, y, -9] as [number, number, number] }))), false, false);
  instances(softBox(0.1, 0.34, 0.26, 0.015, 1), machineMaterial, bayZ.flatMap((z) => [-9.56, 9.56].map((x) => ({ position: [x, 4.72, z + 0.62] as [number, number, number] }))), false, false);
  const cableMaterial = new THREE.MeshStandardMaterial({ color: 0x0c0e10, roughness: 0.55, metalness: 0 });
  for (const x of [-5.2, 0, 5.2]) {
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(x - 1.2, 5.9, 6), new THREE.Vector3(x, 5.42 - Math.abs(x) * 0.02, -4),
      new THREE.Vector3(x + 0.8, 5.66, -15), new THREE.Vector3(x - 0.4, 5.4, -27),
    ]), 72, 0.022, 6, false), cableMaterial);
    cable.castShadow = true;
    scene.add(cable);
  }

  // ---- Wall LED guides -----------------------------------------------------
  const ledOrange = new THREE.MeshBasicMaterial({ color: new THREE.Color(STRIKE_ORANGE).multiplyScalar(2.4), toneMapped: false });
  const ledMint = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(2.2), toneMapped: false });
  const ledRun = (side: number, x: number) => wallRuns(side, -29.5, 11.5).map(([a, b]) => T(side * x, 0.44, (a + b) / 2, 0, 0, 0, [1, 1, b - a]));
  instances(worldBox(0.03, 0.035, 1, 1), ledOrange, ledRun(-1, 9.47), false, false);
  instances(worldBox(0.03, 0.035, 1, 1), ledMint, ledRun(1, 9.47), false, false);
  instances(worldBox(0.06, 0.08, 1, 1.4), darkMetal, side2.flatMap((side) => ledRun(side, 9.5)), false, false);
  const laneMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(1.9), toneMapped: false });
  instances(worldBox(0.03, 0.006, 16, 1), laneMaterial, [-3.2, 3.2].map((x) => ({ position: [x, 0.006, -17] as [number, number, number] })), false, false);

  // ---- Props ---------------------------------------------------------------
  // Concrete barriers as cover: [x, z, yaw]. They are solid to the player, so each one either leaves a full
  // lane beside it or closes right up to its neighbour: the one by the far-left station stands lengthwise
  // against its platform, and nothing stands in the run up to the furnace mouth.
  const barriers: Array<[number, number, number]> = [[-6.95, 5, 0.08], [-8.05, -10.5, -0.08], [-6.3, -18, PI / 2], [6.5, 0, -0.08], [6.3, -14.4, 0.08], [5.7, -22.4, -0.08]];
  instances(jerseyBarrier(2.4), concrete, barriers.map(([x, z, yaw]) => T(x, 0, z, 0, yaw, 0)));
  const hazard = track(hazardTexture());
  hazard.repeat.set(3, 1);
  hazard.anisotropy = anisotropy;
  const hazardMaterial = new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.42, metalness: 0, envMapIntensity: 0.8 });
  for (const side of [-1, 1]) {
    instances(new THREE.BoxGeometry(2.32, 0.16, 0.012), hazardMaterial, barriers.map(([x, z, yaw]) => (
      { position: [x + Math.sin(yaw) * 0.118 * side, 0.82, z + Math.cos(yaw) * 0.118 * side] as [number, number, number], rotation: turned(["x", side * -0.095], ["y", yaw]) }
    )), false, false);
  }

  // Service doors with frames, kick plates and pull handles.
  const doors: Array<[number, number]> = [[-9.56, -4.6], [9.56, -6.2]];
  instances(softBox(0.16, 2.72, 1.72, 0.012, 2), machineMaterial, doors.map(([x, z]) => ({ position: [x, 1.38, z] as [number, number, number] })));
  instances(worldBox(0.22, 2.92, 0.12, 1.4), structural, doors.flatMap(([x, z]) => [-0.95, 0.95].map((o) => ({ position: [x, 1.46, z + o] as [number, number, number] }))), false, false);
  // The head fits between the jambs, so the frame has no doubled faces at its corners.
  instances(worldBox(0.22, 0.12, 1.78, 1.4), structural, doors.map(([x, z]) => ({ position: [x, 2.86, z] as [number, number, number] })), false, false);
  instances(worldBox(0.012, 0.3, 1.6, 1.4), ductMaterial, doors.map(([x, z]) => ({ position: [x - Math.sign(x) * 0.085, 0.24, z] as [number, number, number] })), false, false);
  instances(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 8), ductMaterial, doors.map(([x, z]) => ({ position: [x - Math.sign(x) * 0.12, 1.2, z + 0.62] as [number, number, number] })), false, false);

  // ==== Detail pass ==========================================================
  // Everything below is dressing: it is merged per material (one draw call each)
  // or instanced, never casts sun shadows unless it sits in a roof light, and
  // stays against the walls, on the steelwork or overhead.
  type Bag = { material: THREE.Material; metres: number; hit: boolean; shadow: boolean; parts: THREE.BufferGeometry[] };
  const bags: Bag[] = [];
  const bag = (material: THREE.Material, metres = 0, hit = false, shadow = false) => {
    const created: Bag = { material, metres, hit, shadow, parts: [] };
    bags.push(created);
    return created;
  };
  const base = new THREE.Matrix4();
  const scratch = new THREE.Matrix4(), scratchQ = new THREE.Quaternion(), scratchE = new THREE.Euler(), scratchV = new THREE.Vector3(), scratchS = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const putM = (target: Bag, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    const part = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    if (target.metres) projectUv(part, target.metres);
    part.applyMatrix4(matrix).applyMatrix4(base);
    for (const name of Object.keys(part.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") part.deleteAttribute(name);
    target.parts.push(part);
  };
  const put = (target: Bag, geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) =>
    putM(target, geometry, scratch.compose(scratchV.set(x, y, z), scratchQ.setFromEuler(scratchE.set(rx, ry, rz)), scratchS.set(s, s, s)));
  const box = (target: Bag, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => put(target, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  const rbox = (target: Bag, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => put(target, new RoundedBoxGeometry(w, h, d, 2, r), x, y, z, rx, ry, rz);
  /** Round bar between two points. */
  const rod = (target: Bag, r: number, a: number[], c: number[], seg = 8) => {
    const from = new THREE.Vector3(a[0], a[1], a[2]), to = new THREE.Vector3(c[0], c[1], c[2]);
    const along = to.clone().sub(from), length = along.length();
    putM(target, new THREE.CylinderGeometry(r, r, length, seg), new THREE.Matrix4().compose(from.add(to).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, along.normalize()), new THREE.Vector3(1, 1, 1)));
  };
  /** Square bar between two points. */
  const bar = (target: Bag, w: number, a: number[], c: number[]) => {
    const from = new THREE.Vector3(a[0], a[1], a[2]), to = new THREE.Vector3(c[0], c[1], c[2]);
    const along = to.clone().sub(from), length = along.length();
    putM(target, new THREE.BoxGeometry(w, length, w), new THREE.Matrix4().compose(from.add(to).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, along.normalize()), new THREE.Vector3(1, 1, 1)));
  };
  /** Pipe through a list of points with swept bends. */
  const pipe = (target: Bag, r: number, points: number[][], bend = 0.12, radial = 10) => {
    const P = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const path = new THREE.CurvePath<THREE.Vector3>();
    let from = P[0];
    for (let i = 1; i < P.length; i += 1) {
      const corner = P[i];
      if (i < P.length - 1) {
        const before = corner.clone().addScaledVector(corner.clone().sub(P[i - 1]).normalize(), -bend);
        const after = corner.clone().addScaledVector(P[i + 1].clone().sub(corner).normalize(), bend);
        path.add(new THREE.LineCurve3(from, before));
        path.add(new THREE.QuadraticBezierCurve3(before, corner, after));
        from = after;
      } else path.add(new THREE.LineCurve3(from, corner));
    }
    put(target, new THREE.TubeGeometry(path, Math.max(6, Math.ceil(path.getLength() / 0.09)), r, radial, false), 0, 0, 0);
  };
  /** Runs `build` with every placement moved to a local origin and heading. */
  const at = (x: number, y: number, z: number, yaw: number, build: () => void) => {
    base.makeRotationY(yaw).setPosition(x, y, z);
    build();
    base.identity();
  };
  /** Long straight run along z with the texture tiled along its length. */
  const runZ = (r: number, length: number, seg = 12) => {
    const geometry = new THREE.CylinderGeometry(r, r, length, seg, 1, true);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setY(i, uv.getY(i) * length / 1.5);
    geometry.rotateX(PI / 2);
    return geometry;
  };
  const lathe = (profile: number[][], seg = 16) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), seg);
  /** A bag for parts that move: filled like any other, then merged into meshes of their own by `assemble`. */
  const loose = (material: THREE.Material, metres = 0): Bag => ({ material, metres, hit: false, shadow: false, parts: [] });
  /**
   * Meshes for an assembly that moves: they cast no sun shadow (the sun map is rendered once) and stay
   * out of the floor plan. `hit` lets bullets find them.
   */
  const assemble = <G extends THREE.Object3D>(group: G, filled: Bag[], hit = false) => {
    for (const { material, parts } of filled) {
      if (parts.length === 0) continue;
      const mesh = new THREE.Mesh(mergeGeometries(parts), material);
      parts.forEach((part) => part.dispose());
      mesh.receiveShadow = true;
      mesh.userData.walkThrough = true;
      group.add(mesh);
      if (hit) shootable.push(mesh);
    }
    return group;
  };

  const steelB = bag(structural, 1.4), steelHit = bag(structural, 1.4, true);
  const darkB = bag(darkMetal, 1.2), darkHit = bag(darkMetal, 1.2, true);
  const greenB = bag(greenPaint, 1.6, true), greenFine = bag(greenPaint, 1.6);
  // The entrance end has no lamp of its own, so what stands there carries a baked wash from its fixtures.
  const washed = (material: THREE.MeshStandardMaterial, amount: number) => {
    const copy = material.clone();
    copy.emissive = new THREE.Color(0.7, 1, 0.95);
    copy.emissiveMap = material.map;
    copy.emissiveIntensity = amount;
    return copy;
  };
  const greenLit = bag(washed(greenPaint, 0.3), 1.6, true), whiteB = bag(tubeMaterial);
  const yellowB = bag(yellowPaint, 1.2, true);
  const redB = bag(redPaint, 0, true);
  const rubberB = bag(cableMaterial);
  const brushedB = bag(ductMaterial, 2);
  const plateB = bag(plateMaterial, 1.3, true);
  const rustB = bag(rustMaterial, 1.5, true);
  const orangeB = bag(orangePaint, 1.5, true);
  const planksB = bag(planksMaterial, 1.2, true);
  const machineB = bag(machineMaterial, 1.6, true);
  const glassB = bag(darkGlass);
  const coneB = bag(conePlastic);
  const amberB = bag(bulkheadMaterial), mintB = bag(ledMint), orangeLedB = bag(ledOrange);
  const skyBars = bag(structural, 1.4, false, true);
  const hazardB = bag(hazardMaterial);

  // ---- Printed matter: one 2K sheet of signs and plates ----------------------
  // The signwriter has spent too long on the trading floor: every plate is a working foundry notice that
  // a skin trader reads twice. Big type carries the joke from the lanes, the small print the second one.
  const CELLS = {
    danger: [0, 0, 1024, 512], tradeUp: [1024, 0, 1024, 512], fire: [0, 512, 512, 512], aid: [512, 512, 512, 512], tally: [1024, 512, 1024, 512],
    load: [0, 1024, 512, 512], volt: [512, 1024, 512, 512], cage: [1024, 1024, 1024, 256], exit: [1024, 1280, 512, 256], truck: [1536, 1280, 512, 256],
    pattern: [0, 1536, 1024, 256], crew: [1024, 1536, 1024, 128], hoist: [1024, 1664, 512, 128], gas: [1536, 1664, 512, 128],
    label: [256, 1792, 256, 256], grades: [512, 1792, 1024, 256], tag: [1536, 1792, 512, 256],
  } as const;
  const sheet = track(canvasTexture(2048, 2048, (c) => {
    const HEAD = '"Barlow Condensed", "Arial Narrow", Impact, sans-serif', BODY = '"Barlow", "Helvetica Neue", Arial, sans-serif', MONO = '"IBM Plex Mono", "Courier New", monospace';
    let seed = 4711;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    /** `fit` is the widest the line may run: the type steps down until it does, so no frame ever crops a word. */
    const text = (value: string, x: number, y: number, font: string, fill: string, align: CanvasTextAlign = "left", spacing = 0, fit = 0) => {
      c.font = font; c.fillStyle = fill; c.textAlign = align; c.textBaseline = "alphabetic";
      (c as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
      for (let size = Number(/(\d+)px/.exec(font)?.[1] ?? 0); fit > 0 && size > 12 && c.measureText(value).width > fit;) c.font = font.replace(/\d+px/, `${size -= 2}px`);
      c.fillText(value, x, y);
    };
    const round = (x: number, y: number, w: number, h: number, r: number) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
    /** Enamelled plate with a rim, four fixing holes and service wear. */
    const plate = (cell: readonly number[], fill: string, rim: string) => {
      const [x, y, w, h] = cell;
      c.fillStyle = rim; round(x, y, w, h, 18); c.fill();
      c.fillStyle = fill; round(x + 10, y + 10, w - 20, h - 20, 12); c.fill();
      for (const [hx, hy] of [[26, 26], [w - 26, 26], [26, h - 26], [w - 26, h - 26]]) {
        c.fillStyle = "#1a1c1c"; c.beginPath(); c.arc(x + hx, y + hy, 7, 0, PI * 2); c.fill();
        c.fillStyle = "#8a8f8c"; c.beginPath(); c.arc(x + hx - 1, y + hy - 1, 4, 0, PI * 2); c.fill();
      }
    };
    const wear = (cell: readonly number[], amount: number) => {
      const [x, y, w, h] = cell;
      c.save(); round(x, y, w, h, 18); c.clip();
      for (let i = 0; i < amount; i += 1) {
        const px = x + next() * w, py = y + next() * h;
        c.strokeStyle = `rgba(${20 + next() * 40},${22 + next() * 30},${18 + next() * 24},${0.05 + next() * 0.22})`;
        c.lineWidth = 0.6 + next() * 2.2; c.beginPath(); c.moveTo(px, py); c.lineTo(px + (next() - 0.5) * 70, py + (next() - 0.3) * 60); c.stroke();
      }
      for (let i = 0; i < amount * 3; i += 1) { c.fillStyle = `rgba(70,45,22,${next() * 0.2})`; c.fillRect(x + next() * w, y + next() * h, 1 + next() * 4, 1 + next() * 3); }
      const grade = c.createLinearGradient(0, y, 0, y + h);
      grade.addColorStop(0, "rgba(0,0,0,0)"); grade.addColorStop(1, "rgba(40,30,16,0.22)");
      c.fillStyle = grade; c.fillRect(x, y, w, h);
      c.restore();
    };
    c.clearRect(0, 0, 2048, 2048);

    // DANGER: the heat-treatment bay. The rule under the heading is a strip of case colours: the mottled
    // blues, purples and straw that quenching leaves on hardened steel.
    plate(CELLS.danger, "#e9e6da", "#17191a");
    c.fillStyle = "#b3261c"; round(30, 30, 964, 150, 10); c.fill();
    c.fillStyle = "#e9e6da"; c.beginPath(); c.ellipse(512, 105, 300, 58, 0, 0, PI * 2); c.fill();
    text("DANGER", 512, 136, `800 96px ${HEAD}`, "#b3261c", "center", 14);
    text("CASE HARDENED", 512, 288, `800 118px ${HEAD}`, "#16181a", "center", 4, 900);
    text("HEAT TREATMENT · QUENCH UNTIL BLUE", 512, 350, `600 46px ${HEAD}`, "#16181a", "center", 3, 900);
    c.save(); c.beginPath(); c.rect(60, 372, 904, 16); c.clip();
    c.fillStyle = "#33415c"; c.fillRect(60, 372, 904, 16);
    for (let i = 0; i < 170; i += 1) {
      c.fillStyle = ["#2a5cb4", "#5b3f92", "#c9a24a", "#1c3a78", "#8a94a0"][Math.floor(next() * 5)]; c.globalAlpha = 0.35 + next() * 0.5;
      c.beginPath(); c.ellipse(60 + next() * 904, 372 + next() * 16, 6 + next() * 26, 3 + next() * 7, next() * PI, 0, PI * 2); c.fill();
    }
    c.restore();
    text("Pattern 661 not guaranteed. Blue gems are luck, not workmanship.", 64, 426, `500 26px ${BODY}`, "#2a2c2c", "left", 0, 896);
    text("Results vary by seed. Float 0.00: handle with gloves.", 64, 458, `500 26px ${BODY}`, "#2a2c2c", "left", 0, 670);
    text("FND/07 · SEED 661", 962, 458, `500 20px ${MONO}`, "#5a5c58", "right");
    wear(CELLS.danger, 70);

    // The furnace's terms, as four roundels: ten ingots in, one pour, one ingot out, no money back.
    plate(CELLS.tradeUp, "#e9e6da", "#17191a");
    c.fillStyle = "#1f4f7a"; round(1054, 30, 964, 120, 10); c.fill();
    text("TRADE-UP CONTRACT", 1536, 119, `800 84px ${HEAD}`, "#e9e6da", "center", 6, 900);
    const ingot = (x: number, y: number, w: number, h: number) => { c.beginPath(); c.moveTo(x - w / 2, y); c.lineTo(x + w / 2, y); c.lineTo(x + w * 0.36, y - h); c.lineTo(x - w * 0.36, y - h); c.closePath(); c.fill(); };
    ["TEN IN", "ONE POUR", "ONE OUT", "NO REFUNDS"].forEach((word, index) => {
      const cx = 1174 + index * 242, cy = 268;
      c.fillStyle = index === 3 ? "#f3f1e8" : "#1f4f7a"; c.beginPath(); c.arc(cx, cy, 88, 0, PI * 2); c.fill();
      c.strokeStyle = "#e9e6da"; c.lineWidth = 9; c.fillStyle = "#e9e6da";
      if (index === 0) for (let row = 0; row < 4; row += 1) for (let n = 0; n < 4 - row; n += 1) ingot(cx + (n - (3 - row) / 2) * 34, cy + 52 - row * 24, 30, 18);
      if (index === 1) {
        c.beginPath(); c.moveTo(cx - 48, cy + 50); c.lineTo(cx - 48, cy - 8); c.arc(cx, cy - 8, 48, PI, 0); c.lineTo(cx + 48, cy + 50); c.closePath(); c.stroke();
        c.beginPath(); c.moveTo(cx, cy - 34); c.bezierCurveTo(cx + 40, cy + 4, cx + 26, cy + 38, cx, cy + 38); c.bezierCurveTo(cx - 26, cy + 38, cx - 40, cy + 4, cx, cy - 34); c.fill();
        c.fillStyle = "#1f4f7a"; c.beginPath(); c.moveTo(cx, cy + 2); c.bezierCurveTo(cx + 16, cy + 18, cx + 10, cy + 30, cx, cy + 30); c.bezierCurveTo(cx - 10, cy + 30, cx - 16, cy + 18, cx, cy + 2); c.fill();
      }
      if (index === 2) {
        ingot(cx, cy + 40, 116, 52);
        c.beginPath(); for (let point = 0; point < 8; point += 1) { const r = point % 2 ? 6 : 24, a = point * PI / 4; c.lineTo(cx + 42 + Math.sin(a) * r, cy - 42 - Math.cos(a) * r); } c.closePath(); c.fill();
      }
      if (index === 3) {
        c.strokeStyle = "#b3261c"; c.lineWidth = 16; c.beginPath(); c.arc(cx, cy, 78, 0, PI * 2); c.stroke();
        text("$", cx, cy + 42, `800 124px ${HEAD}`, "#16181a", "center");
        c.beginPath(); c.moveTo(cx - 55, cy - 55); c.lineTo(cx + 55, cy + 55); c.stroke();
      } else { c.fillStyle = "#16181a"; c.beginPath(); c.moveTo(cx + 105, cy - 20); c.lineTo(cx + 137, cy); c.lineTo(cx + 105, cy + 20); c.closePath(); c.fill(); }
      text(word, cx, 404, `700 40px ${HEAD}`, "#16181a", "center", 4, 226);
    });
    text("Ten of a grade in, one of the next out. The float is final.  ·  FND/10", 1536, 462, `500 26px ${BODY}`, "#2a2c2c", "center", 0, 900);
    wear(CELLS.tradeUp, 60);

    // Fire point: a smoke canister where the extinguisher used to be drawn.
    plate(CELLS.fire, "#a82218", "#17191a");
    text("FIRE", 256, 652, `800 132px ${HEAD}`, "#f0ece0", "center", 10);
    text("POINT 03", 256, 742, `700 84px ${HEAD}`, "#f0ece0", "center", 6);
    c.fillStyle = "#f0ece0"; round(60, 778, 392, 6, 3); c.fill();
    c.fillStyle = "#f0ece0"; round(92, 838, 62, 128, 12); c.fill(); round(108, 812, 30, 30, 5); c.fill();
    c.fillStyle = "#a82218"; c.fillRect(92, 872, 62, 9); c.fillRect(92, 928, 62, 9);
    c.strokeStyle = "#f0ece0"; c.lineWidth = 7; c.beginPath(); c.moveTo(136, 818); c.lineTo(168, 836); c.lineTo(168, 902); c.stroke();
    c.beginPath(); c.arc(94, 816, 13, 0, PI * 2); c.stroke();
    text("THROW SMOKE", 196, 850, `700 44px ${HEAD}`, "#f0ece0", "left", 2, 274);
    text("Burns for 7 seconds.", 196, 896, `500 28px ${BODY}`, "#f0ece0", "left", 0, 274);
    text("Smoke it or wait.", 196, 932, `500 28px ${BODY}`, "#f0ece0", "left", 0, 274);
    text("REFILL $300 · CHK 11/26", 196, 976, `500 22px ${MONO}`, "#f3c9b8", "left", 0, 274);
    wear(CELLS.fire, 45);

    // First aid.
    plate(CELLS.aid, "#1f6a47", "#17191a");
    c.fillStyle = "#f0ece0"; round(512 + 201, 556, 110, 270, 10); c.fill(); round(512 + 121, 636, 270, 110, 10); c.fill();
    text("FIRST AID", 768, 908, `800 86px ${HEAD}`, "#f0ece0", "center", 8);
    text("HE'S LIT, 90?  BURNS KIT", 768, 952, `600 32px ${HEAD}`, "#cfe6d6", "center", 3, 440);
    text("TEAM-FLASHED?  EYE WASH", 768, 990, `600 32px ${HEAD}`, "#cfe6d6", "center", 3, 440);
    wear(CELLS.aid, 40);

    // Days-without board over the goods door: an orange counter that has not moved in a while. The count, its
    // caption and the small print sit in the lower two thirds, the band the cable tray never covers from the lanes.
    plate(CELLS.tally, "#16191a", "#0a0c0c");
    c.strokeStyle = "#d7a23a"; c.lineWidth = 8; round(1060, 548, 952, 440, 8); c.stroke();
    text("BAY 1.6 · GOODS IN · KEEP DOOR CLEAR · SOUND HORN", 1100, 630, `500 30px ${MONO}`, "#9aa39f", "left", 0, 880);
    ["DAYS WITHOUT", "A TEAM KILL"].forEach((line, index) => text(line, 1100, 776 + index * 84, `800 92px ${HEAD}`, "#e6e2d4", "left", 4, 520));
    text("STATTRAK COUNTER  ·  RESETS ON TRADE", 1100, 930, `600 40px ${HEAD}`, "#e6e2d4", "left", 4, 880);
    c.fillStyle = "#050606"; round(1644, 700, 340, 176, 12); c.fill();
    c.strokeStyle = "#4a4e4c"; c.lineWidth = 5; round(1644, 700, 340, 176, 12); c.stroke();
    const LIT: Record<string, string> = { 1: "bc", 3: "abcdg", 7: "abc" };
    [..."1337"].forEach((digit, index) => {
      const x = 1670 + index * 80, y = 718, w = 48, h = 140, k = 9, gap = 3;
      const bars: Record<string, [number, number, number, number]> = {
        a: [x, y, x + w, y], g: [x, y + h / 2, x + w, y + h / 2], d: [x, y + h, x + w, y + h],
        f: [x, y, x, y + h / 2], b: [x + w, y, x + w, y + h / 2], e: [x, y + h / 2, x, y + h], c: [x + w, y + h / 2, x + w, y + h],
      };
      for (const [name, [x0, y0, x1, y1]] of Object.entries(bars)) {
        c.fillStyle = LIT[digit].includes(name) ? "#ff8a24" : "#170d07";
        c.beginPath();
        if (y0 === y1) { c.moveTo(x0 + gap, y0); c.lineTo(x0 + gap + k, y0 - k); c.lineTo(x1 - gap - k, y0 - k); c.lineTo(x1 - gap, y0); c.lineTo(x1 - gap - k, y0 + k); c.lineTo(x0 + gap + k, y0 + k); }
        else { c.moveTo(x0, y0 + gap); c.lineTo(x0 + k, y0 + gap + k); c.lineTo(x0 + k, y1 - gap - k); c.lineTo(x0, y1 - gap); c.lineTo(x0 - k, y1 - gap - k); c.lineTo(x0 - k, y0 + gap + k); }
        c.closePath(); c.fill();
      }
    });
    wear(CELLS.tally, 80);

    // Rack load notice: the cap every wallet stops at.
    plate(CELLS.load, "#d9a62c", "#17191a");
    text("RACK R-02", 256, 1120, `800 76px ${HEAD}`, "#16181a", "center", 5);
    c.fillStyle = "#16181a"; c.fillRect(48, 1140, 416, 5);
    text("MAX LOAD", 256, 1218, `700 64px ${HEAD}`, "#16181a", "center", 5);
    text("$16000", 256, 1330, `800 124px ${HEAD}`, "#16181a", "center", 0, 420);
    text("PER OPERATOR · NO EXCEPTIONS", 256, 1380, `600 30px ${HEAD}`, "#16181a", "center", 2, 420);
    text("Spend it or drop for a teammate.", 256, 1430, `500 24px ${BODY}`, "#2a2415", "center", 0, 420);
    text("LOSS BONUS $1400 TO $3400", 256, 1482, `500 20px ${MONO}`, "#3a3117", "center", 0, 420);
    wear(CELLS.load, 55);

    // Electrical warning.
    plate(CELLS.volt, "#e3b52e", "#17191a");
    c.fillStyle = "#16181a"; c.beginPath(); c.moveTo(768, 1060); c.lineTo(930, 1340); c.lineTo(606, 1340); c.closePath(); c.fill();
    c.fillStyle = "#e3b52e"; c.beginPath(); c.moveTo(768, 1104); c.lineTo(892, 1318); c.lineTo(644, 1318); c.closePath(); c.fill();
    c.fillStyle = "#16181a"; c.beginPath(); c.moveTo(784, 1150); c.lineTo(736, 1240); c.lineTo(772, 1240); c.lineTo(748, 1304); c.lineTo(806, 1214); c.lineTo(770, 1214); c.closePath(); c.fill();
    text("ZEUS INSIDE", 768, 1420, `800 82px ${HEAD}`, "#16181a", "center", 4, 430);
    text("ONE SHOT · POINT BLANK ONLY", 768, 1462, `700 36px ${HEAD}`, "#16181a", "center", 2, 430);
    text("DB-2 · $200 · RECHARGE 30 s", 768, 1500, `500 22px ${MONO}`, "#3a3117", "center", 0, 430);
    wear(CELLS.volt, 45);

    // Door plates: the store on the west wall, the pattern shop beside the furnace.
    plate(CELLS.cage, "#dfe2dc", "#17191a");
    text("CONTRABAND CAGE", 1536, 1176, `800 116px ${HEAD}`, "#16181a", "center", 8, 930);
    text("KEEP SHUT · ONE ITEM ONLY · IT HOWLS", 1536, 1236, `600 36px ${HEAD}`, "#3a3d3c", "center", 5, 930);
    wear(CELLS.cage, 35);
    plate(CELLS.pattern, "#dfe2dc", "#17191a");
    text("PATTERN SHOP", 512, 1688, `800 116px ${HEAD}`, "#16181a", "center", 8, 930);
    text("SEEDS 0 TO 1000 · NO RE-ROLLS · NO FAVOURITES", 512, 1748, `600 36px ${HEAD}`, "#3a3d3c", "center", 5, 930);
    wear(CELLS.pattern, 35);

    // Exit box face.
    c.fillStyle = "#0f5f3c"; c.fillRect(1024, 1280, 512, 256);
    text("ROTATE", 1054, 1426, `800 128px ${HEAD}`, "#eaf6ee", "left", 6, 340);
    text("EXIT · IT WAS A FAKE", 1056, 1496, `600 36px ${HEAD}`, "#c4e6d1", "left", 4, 440);
    c.fillStyle = "#eaf6ee"; c.beginPath(); c.moveTo(1512, 1380); c.lineTo(1458, 1334); c.lineTo(1458, 1364); c.lineTo(1410, 1364); c.lineTo(1410, 1396); c.lineTo(1458, 1396); c.lineTo(1458, 1426); c.closePath(); c.fill();

    // Over the truck charger.
    plate(CELLS.truck, "#1f4f7a", "#17191a");
    text("KNIFE ROUND", 1792, 1380, `800 70px ${HEAD}`, "#f0ece0", "center", 3, 440);
    text("DECIDES WHO DRIVES THE TRUCK", 1792, 1428, `600 32px ${HEAD}`, "#f0ece0", "center", 2, 440);
    text("On charge: brake on, forks down, key out.", 1792, 1470, `500 22px ${BODY}`, "#cfdbe6", "center", 0, 440);
    text("Licence: Master Guardian and up. Silvers walk.", 1792, 1500, `500 22px ${BODY}`, "#cfdbe6", "center", 0, 420);
    wear(CELLS.truck, 30);

    // Locker plates: a full team, and the one who fills in when somebody leaves.
    ["IGL", "AWP", "ENTRY", "LURK", "RIFLE", "BOT"].forEach((role, i) => {
      const cx = 1024 + 85 + i * 170.6;
      c.fillStyle = "#dfe2dc"; round(cx - 68, 1556, 136, 88, 8); c.fill();
      c.strokeStyle = "#16181a"; c.lineWidth = 4; round(cx - 62, 1562, 124, 76, 5); c.stroke();
      text(role, cx, 1618, `800 50px ${HEAD}`, "#16181a", "center", 2, 108);
    });

    // Hoist rating, cylinder store, extinguisher label, quality board, lock-out tag.
    plate(CELLS.hoist, "#d9a62c", "#17191a");
    text("BOOST · SWL 2 t", 1280, 1752, `800 76px ${HEAD}`, "#16181a", "center", 3, 440);
    plate(CELLS.gas, "#e9e6da", "#17191a");
    text("NO WALLBANGS", 1792, 1722, `800 54px ${HEAD}`, "#b3261c", "center", 3, 450);
    text("GAS STORE · AN AK GOES RIGHT THROUGH", 1792, 1764, `600 26px ${HEAD}`, "#16181a", "center", 2, 410);
    c.fillStyle = "#e9e6da"; round(262, 1798, 244, 244, 10); c.fill();
    c.fillStyle = "#16181a"; c.fillRect(262, 1798, 244, 54);
    text("SPRAY CONTROL", 384, 1838, `800 36px ${HEAD}`, "#e9e6da", "center", 1, 224);
    ["1  PULL PIN", "2  PULL DOWN", "3  THEN LEFT", "4  THEN RIGHT"].forEach((line, index) => text(line, 280, 1890 + index * 34, `700 26px ${HEAD}`, "#16181a"));
    text("30 RDS · SPRAY & PRAY LTD", 280, 2030, `500 15px ${MONO}`, "#4a4c48", "left", 0, 212);
    // Quality board: the same bar of steel at five grades of wear, graded by float.
    plate(CELLS.grades, "#e9e6da", "#17191a");
    text("QUALITY BOARD", 556, 1858, `800 50px ${HEAD}`, "#16181a", "left", 3);
    text("PRESS F TO INSPECT", 1492, 1858, `700 34px ${HEAD}`, "#3a3d3c", "right", 3);
    c.fillStyle = "#d7702a"; c.fillRect(556, 1870, 936, 5);
    ([["FACTORY NEW", "0.00 – 0.07", "no fingerprints"], ["MINIMAL WEAR", "0.07 – 0.15", "“looks FN to me”"], ["FIELD-TESTED", "0.15 – 0.38", "the honest grade"], ["WELL-WORN", "0.38 – 0.45", "nobody orders it"], ["BATTLE-SCARRED", "0.45 – 1.00", "has character"]] as const).forEach(([name, float, remark], grade) => {
      const x = 556 + grade * 190, y = 1884, w = 176, h = 46;
      c.save(); round(x, y, w, h, 5); c.clip();
      const steel = c.createLinearGradient(0, y, 0, y + h);
      steel.addColorStop(0, "#c3c8ca"); steel.addColorStop(0.5, "#9aa0a3"); steel.addColorStop(1, "#7d8386");
      c.fillStyle = steel; c.fillRect(x, y, w, h);
      for (let i = 0; i < 26; i += 1) { c.fillStyle = `rgba(255,255,255,${0.04 + next() * 0.1})`; c.fillRect(x, y + next() * h, w, 1); }
      for (let i = 0; i < [0, 5, 20, 46, 90][grade]; i += 1) {
        const px = x + next() * w, py = y + next() * h;
        c.strokeStyle = `rgba(${28 + next() * 30},${28 + next() * 26},${26 + next() * 22},${0.45 + next() * 0.4})`; c.lineWidth = 0.8 + next() * (1 + grade * 0.6);
        c.beginPath(); c.moveTo(px, py); c.lineTo(px + (next() - 0.5) * (20 + grade * 12), py + (next() - 0.5) * 16); c.stroke();
      }
      for (let i = 0; i < [0, 0, 4, 12, 30][grade]; i += 1) {
        c.fillStyle = `rgba(${96 + next() * 50},${50 + next() * 24},${22 + next() * 14},${0.4 + next() * 0.45})`;
        c.beginPath(); c.ellipse(x + next() * w, y + next() * h, 2 + next() * (3 + grade * 2), 1.5 + next() * (2 + grade), next() * PI, 0, PI * 2); c.fill();
      }
      c.restore();
      c.strokeStyle = "#16181a"; c.lineWidth = 2.5; round(x, y, w, h, 5); c.stroke();
      text(name, x, 1961, `700 28px ${HEAD}`, "#16181a", "left", 1, w);
      text(float, x, 1988, `500 21px ${MONO}`, "#3a3d3c", "left", 0, w);
      text(remark, x, 2016, `italic 500 21px ${BODY}`, "#5a5c58", "left", 0, w);
    });
    c.fillStyle = "#c9c2a4"; round(1560, 1808, 464, 224, 14); c.fill();
    c.fillStyle = "#16181a"; c.beginPath(); c.arc(1592, 1840, 10, 0, PI * 2); c.fill();
    text("TRADE HOLD", 1792, 1872, `800 44px ${HEAD}`, "#16181a", "center", 3);
    text("7 DAYS · DO NOT OPERATE", 1792, 1912, `600 24px ${HEAD}`, "#16181a", "center", 2);
    text("ON 03/20  ·  OFF 03/27", 1792, 1962, `500 26px ${MONO}`, "#2a2c2a", "center", 0, 420);
    text("reason:  new phone. again.", 1792, 2004, `italic 500 24px ${BODY}`, "#2b3f6a", "center");
  }));
  sheet.anisotropy = anisotropy;
  const sheetMaterial = new THREE.MeshStandardMaterial({ map: sheet, alphaTest: 0.4, roughness: 0.5, metalness: 0.1, emissive: 0xffffff, emissiveMap: sheet, emissiveIntensity: 0.12, envMapIntensity: 0.7 });
  const signB = bag(sheetMaterial);
  // The days-without board is a lit box: it hangs above the door floods, in the darkest part of the wall,
  // and its counter has to read from the far lanes.
  const litSheet = sheetMaterial.clone();
  litSheet.emissiveIntensity = 0.62;
  const litSignB = bag(litSheet);
  /** A printed plate from the sheet; `back` adds the steel backing plate behind it. */
  const sign = (name: keyof typeof CELLS, w: number, h: number, x: number, y: number, z: number, ry: number, back = true, target = signB) => {
    const [cx, cy, cw, ch] = CELLS[name];
    const geometry = new THREE.PlaneGeometry(w, h);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (cx + uv.getX(i) * cw) / 2048, 1 - (cy + (1 - uv.getY(i)) * ch) / 2048);
    put(target, geometry, x, y, z, 0, ry, 0);
    if (back) put(darkB, new THREE.BoxGeometry(w + 0.03, h + 0.03, 0.012), x - Math.sin(ry) * 0.008, y, z - Math.cos(ry) * 0.008, 0, ry, 0);
  };
  /** Plate on a side wall's brickwork (or on the cladding above 4.4 m). */
  const wallSign = (side: number, name: keyof typeof CELLS, w: number, h: number, y: number, z: number, proud = 0.016, target = signB) =>
    sign(name, w, h, side * ((y > 4.4 ? 9.65 : 9.54) - proud), y, z, -side * PI / 2, true, target);

  // ---- Steelwork ------------------------------------------------------------
  // Eaves beams carry the trusses between columns.
  instances(worldBox(0.2, 0.22, 39, 1.4), structural, side2.map((s) => T(s * 9.3, 5.55, -9.5)), false, false);
  instances(worldBox(0.08, 0.1, 38, 1.4), structural, [-4.6, 4.6].map((x) => T(x, 6.19, -9.5)), false, false);
  // Wind bracing in the upper wall of each bay, with gussets and turnbuckles.
  const braceBays = bayZ.slice(0, -1).map((z) => z - 3);
  const braceLength = Math.hypot(5.5, 1.1), braceAngle = Math.atan2(1.1, 5.5);
  const braceGeometry = new THREE.CylinderGeometry(0.014, 0.014, braceLength, 6);
  braceGeometry.rotateX(PI / 2);
  instances(braceGeometry, structural, braceBays.flatMap((z) => side2.flatMap((s) => [-1, 1].map((d) => T(s * 9.52, 5.5, z, d * braceAngle, 0, 0)))), false, false);
  const turnbuckle = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 6);
  turnbuckle.rotateX(PI / 2);
  instances(turnbuckle, darkMetal, braceBays.flatMap((z) => side2.flatMap((s) => [-1, 1].map((d) => T(s * 9.52, 5.5 + d * 0.22, z - 1.1, d * braceAngle, 0, 0)))), false, false);
  instances(new THREE.BoxGeometry(0.012, 0.3, 0.42), structural, bayZ.flatMap((z) => side2.flatMap((s) => [4.98, 6.02].map((y) => T(s * 9.52, y, z)))), false, false);
  // Truss node plates, column stiffeners and striped column guards.
  instances(new THREE.BoxGeometry(0.2, 0.16, 0.17), structural, trussZ.flatMap((z) => Array.from({ length: 17 }, (_, index) => T(-9 + index * webRun, index % 2 ? 6.1 : 5.76, z))), false, false);
  instances(new THREE.BoxGeometry(0.4, 0.014, 0.4), structural, bayZ.flatMap((z) => side2.flatMap((s) => [1.2, 3.5, 5.44].map((y) => T(s * 9.42, y, z)))), false, false);
  const hazardBandTexture = track(hazard.clone());
  hazardBandTexture.wrapT = THREE.RepeatWrapping;
  hazardBandTexture.repeat.set(1.5, 0.5);
  hazardBandTexture.needsUpdate = true;
  const hazardBand = new THREE.MeshStandardMaterial({ map: hazardBandTexture, roughness: 0.5, metalness: 0.1, envMapIntensity: 0.8 });
  const guardGeometry = mergeGeometries([new THREE.BoxGeometry(0.02, 1.05, 0.5), new THREE.BoxGeometry(0.2, 1.05, 0.02).translate(0.1, 0, -0.25), new THREE.BoxGeometry(0.2, 1.05, 0.02).translate(0.1, 0, 0.25)]);
  instances(guardGeometry, hazardBand, bayZ.flatMap((z) => side2.map((s) => T(s * 9.17, 0.56, z, 0, s < 0 ? PI : 0, 0))), true, false);

  // ---- Gallery: joists, fascia, struts, grating infill and end rails ---------
  instances(worldBox(2.05, 0.11, 0.06, 1.4), structural, bayZ.flatMap((z) => side2.flatMap((s) => [-4.6, -3.55, -2.5, -1.45, -0.75].map((o) => T(s * 8.55, 3.61, z - 2.7 + o + 2.65 - 0.4)))), false, false);
  instances(worldBox(0.04, 0.3, 32.55, 1.4), structural, side2.map((s) => T(s * 7.44, 3.78, -12.325)), false, false);
  for (const z of bayZ) for (const s of side2) for (const o of [-0.17, 0.17]) bar(steelB, 0.045, [s * 9.19, 2.72, z + o], [s * 7.74, 3.56, z + o]);
  const grating = track(canvasTexture(128, 128, (c) => {
    c.clearRect(0, 0, 128, 128);
    c.fillStyle = "#2b3133";
    for (let x = 0; x < 128; x += 16) c.fillRect(x, 0, 7, 128);
    c.fillStyle = "#3a4245";
    for (let y = 0; y < 128; y += 64) c.fillRect(0, y, 128, 9);
  }, true));
  grating.anisotropy = anisotropy;
  const gratingMaterial = new THREE.MeshStandardMaterial({ map: grating, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.8, envMapIntensity: 0.8 });
  const gratingGeometry = new THREE.PlaneGeometry(2.2, 0.72);
  { const uv = gratingGeometry.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 9, uv.getY(i) * 3); }
  gratingGeometry.rotateX(PI / 2);
  const gapZ = bayZ.slice(1).map((z) => z + 0.3);
  instances(gratingGeometry, gratingMaterial, gapZ.flatMap((z) => side2.map((s) => T(s * 8.55, 3.86, z))), false, false);
  instances(worldBox(2.2, 0.06, 0.05, 1.4), structural, gapZ.flatMap((z) => side2.flatMap((s) => [-0.34, 0.34].map((o) => T(s * 8.55, 3.83, z + o)))), false, false);
  instances(railGeometry, ductMaterial, gapZ.flatMap((z) => side2.flatMap((s) => [4.92, 4.42].map((y) => T(s * 7.62, y, z, 0, 0, 0, [1, 1, 0.72 / 5.3])))), false, false);
  // Rail returns, a mid post and a toe board at the open end of each gallery.
  for (const s of side2) {
    for (const y of [4.42, 4.92]) rod(brushedB, 0.024, [s * 7.62, y, 3.95], [s * 9.5, y, 3.95]);
    rod(brushedB, 0.022, [s * 8.6, 3.9, 3.95], [s * 8.6, 4.92, 3.95]);
    box(steelB, 1.9, 0.1, 0.012, s * 8.56, 3.96, 3.944);
  }

  // ---- Roof lights: frames, secondary bars, vent stays -----------------------
  for (const z of SKYLIGHTS) {
    for (const x of [-2.3, 0, 2.3]) box(skyBars, 0.03, 0.05, 3.5, x, 6.235, z);
    for (const o of [-0.86, 0.86]) box(skyBars, 6.9, 0.04, 0.028, 0, 6.24, z + o);
    for (const o of [-1.76, 1.76]) box(steelB, 7.0, 0.05, 0.07, 0, 6.15, z + o);
    for (const x of [-3.5, 3.5]) box(steelB, 0.07, 0.05, 3.5, x, 6.15, z);
    if (high) {
      for (const x of [-3.45, -1.15, 1.15, 3.45]) for (const o of [-1.7, 0, 1.7]) box(darkB, 0.11, 0.03, 0.11, x * 0.995, 6.17, z + o);
      for (const x of [-2.9, 2.9]) { rod(brushedB, 0.01, [x, 6.14, z + 1.7], [x, 5.86, z + 1.2], 6); box(darkB, 0.05, 0.08, 0.05, x, 5.84, z + 1.18); }
    }
  }

  // ---- Lamps: cages and fake pools for the bulkheads, caps for the battens ---
  const cageGeometry = mergeGeometries([
    ...[-0.1, 0, 0.1].map((y) => new THREE.BoxGeometry(0.07, 0.008, 0.19).translate(0.035, y, 0)),
    ...[-0.09, -0.03, 0.03, 0.09].map((z) => new THREE.BoxGeometry(0.008, 0.26, 0.008).translate(0.07, 0, z)),
    new THREE.BoxGeometry(0.03, 0.36, 0.25).translate(-0.045, 0, 0),
  ]);
  instances(cageGeometry, darkMetal, bayZ.flatMap((z) => side2.map((s) => T(s * 9.105, 3.1, z, 0, s < 0 ? 0 : PI, 0))), false, false);
  instances(new THREE.CylinderGeometry(0.011, 0.011, 1.4, 6), ductMaterial, bayZ.flatMap((z) => side2.map((s) => T(s * 9.17, 3.95, z - 0.06))), false, false);
  const poolTexture = track(softDiscTexture());
  const poolMaterial = new THREE.MeshBasicMaterial({ map: poolTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  // Painted light: warm spill under each bulkhead, cool spill from the door flood and the locker batten.
  const warmPool = new THREE.Color(1, 0.5, 0.17).multiplyScalar(0.085), coolPool = new THREE.Color(0.62, 1, 0.94).multiplyScalar(0.1);
  const poolSpots: Array<[Transform, THREE.Color]> = [
    // Floor pools ride at heights nothing else tops out at (bollard plates stop at 20 mm, thresholds at 12 mm).
    ...bayZ.flatMap((z) => side2.map((s) => [T(s * 8.5, 0.024, z, -PI / 2, 0, 0, [3.4, 3, 1]), warmPool] as [Transform, THREE.Color])),
    [T(-9.44, 2.3, 6.8, 0, PI / 2, 0, [5.4, 4.6, 1]), coolPool],
    [T(-8.2, 0.016, 6.8, -PI / 2, 0, 0, [4.2, 5.4, 1]), coolPool],
    [T(-7.93, 1.3, 9.16, 0, PI, 0, [3.6, 2.6, 1]), coolPool],
    [T(8.3, 2.2, 9.66, 0, PI, 0, [3.4, 3.4, 1]), coolPool],
  ];
  const pools = instances(new THREE.PlaneGeometry(1, 1), poolMaterial, poolSpots.map(([transform]) => transform), false, false);
  poolSpots.forEach(([, color], index) => pools.setColorAt(index, color));
  pools.receiveShadow = false;
  pools.renderOrder = 2;
  kit.probeHidden.push(pools);
  instances(softBox(0.06, 0.11, 0.26, 0.015, 1), darkMetal, lampSpots.flatMap(({ x, z }) => [-1.4, 1.4].map((o) => T(x + o, 5.545, z))), false, false);

  // ---- Services -------------------------------------------------------------
  // +x wall: three pipes over the gallery (process, lagged steam, fire main).
  const pipeX = 9.05, pipeLength = 38.2, pipeMid = -9.5;
  instances(runZ(0.05, pipeLength), greenPaint, [T(pipeX, 4.86, pipeMid)], false, false);
  instances(runZ(0.085, pipeLength, 14), ductMaterial, [T(pipeX, 5.07, pipeMid)], false, false);
  instances(runZ(0.055, pipeLength), redPaint, [T(pipeX, 5.3, pipeMid)], false, false);
  const pipeFlange = new THREE.CylinderGeometry(0.085, 0.085, 0.022, 14);
  pipeFlange.rotateX(PI / 2);
  instances(pipeFlange, structural, Array.from({ length: 7 }, (_, index) => 7 - index * 6).flatMap((z) => [T(pipeX, 4.86, z - 1.5), T(pipeX, 4.86, z - 1.53), T(pipeX, 5.3, z + 1.2, 0, 0, 0, [1.1, 1.1, 1]), T(pipeX, 5.3, z + 1.23, 0, 0, 0, [1.1, 1.1, 1])]), false, false);
  if (high) {
    const band = new THREE.CylinderGeometry(0.089, 0.089, 0.03, 14, 1, true);
    band.rotateX(PI / 2);
    instances(band, structural, Array.from({ length: 38 }, (_, index) => T(pipeX, 5.07, 9 - index)), false, false);
  }
  for (const z of bayZ) {
    box(steelB, 0.05, 0.62, 0.05, 9.15, 5.08, z + 0.3);
    box(steelB, 0.16, 0.04, 0.05, 9.08, 4.78, z + 0.3);
    box(steelB, 0.16, 0.03, 0.05, 9.08, 5.39, z + 0.3);
  }
  const handwheel = (x: number, y: number, z: number, r: number) => {
    put(redB, new THREE.TorusGeometry(r, r * 0.13, 6, 18), x, y, z, PI / 2, 0, 0);
    box(redB, r * 2, r * 0.14, r * 0.16, x, y, z); box(redB, r * 0.16, r * 0.14, r * 2, x, y, z);
    rod(brushedB, r * 0.12, [x, y - r * 1.5, z], [x, y + r * 0.2, z], 6);
  };
  const valve = (x: number, y: number, z: number, r: number, wheelUp = true) => {
    put(steelB, new THREE.SphereGeometry(r * 1.9, 12, 8), x, y, z);
    for (const o of [-1, 1]) put(steelB, new THREE.CylinderGeometry(r * 2.1, r * 2.1, 0.03, 12), x, y, z + o * r * 2.4, PI / 2, 0, 0);
    put(steelB, new THREE.CylinderGeometry(r * 0.9, r * 1.2, r * 2.6, 8), x, y + (wheelUp ? 1 : -1) * r * 2.2, z);
    handwheel(x, y + (wheelUp ? r * 4.4 : -r * 4.4), z, r * 2.1);
  };
  valve(pipeX, 4.86, -4.9, 0.05, false);
  valve(pipeX, 5.3, -0.9, 0.055);
  valve(pipeX, 5.3, -18.4, 0.055);
  // Fire main drop to the hose reel, and a sprinkler grid under the trusses.
  pipe(redB, 0.03, [[pipeX, 5.3, -9.1], [9.44, 5.3, -9.1], [9.44, 1.62, -9.1]], 0.1, 8);
  for (const x of [-6.65, 6.65]) rod(redB, 0.026, [x, 5.62, -28.5], [x, 5.62, 9.5]);
  pipe(redB, 0.032, [[-6.65, 5.62, -27.6], [pipeX, 5.62, -27.6], [pipeX, 5.3, -27.6]], 0.1, 8);
  const sprinklerZ = Array.from({ length: 12 }, (_, index) => 7.6 - index * 3.1);
  instances(lathe([[0, -0.08], [0.03, -0.08], [0.03, -0.075], [0.008, -0.07], [0.008, -0.04], [0.014, -0.03], [0.012, 0], [0, 0]], 8), ductMaterial, sprinklerZ.flatMap((z) => [-6.65, 6.65].map((x) => T(x, 5.6, z))), false, false);
  instances(new THREE.BoxGeometry(0.012, 0.6, 0.03), darkMetal, sprinklerZ.filter((_, index) => index % 2 === 0).flatMap((z) => [-6.65, 6.65].map((x) => T(x, 5.94, z + 0.5))), false, false);

  // -x wall: ladder tray with cable bundles, boxes and drops.
  const trayX = -9.2;
  instances(worldBox(0.018, 0.075, pipeLength, 1.4), structural, [-0.16, 0.16].map((o) => T(trayX + o, 5.0, pipeMid)), false, false);
  instances(new THREE.BoxGeometry(0.32, 0.016, 0.035), structural, Array.from({ length: high ? 77 : 39 }, (_, index) => T(trayX, 4.975, 9.4 - index * (high ? 0.5 : 1))), false, false);
  for (const z of bayZ) { box(steelB, 0.42, 0.05, 0.05, -9.23, 4.93, z + 0.3); bar(steelB, 0.03, [-9.4, 4.6, z + 0.3], [-9.06, 4.9, z + 0.3]); }
  [[-0.1, 0.026, 0], [-0.04, 0.02, 1.3], [0.02, 0.03, 2.1], [0.09, 0.022, 0.6], [0.125, 0.014, 2.9]].forEach(([offset, radius, phase], index) => {
    const points = Array.from({ length: 21 }, (_, step) => new THREE.Vector3(trayX + offset + Math.sin(step * 1.7 + phase) * 0.012, 4.99 + radius + Math.abs(Math.sin(step * 0.9 + phase)) * 0.008, 9.5 - step * 1.9));
    put(index === 3 ? brushedB : rubberB, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 140, radius, 6, false), 0, 0, 0);
  });
  for (const z of [0.9, -11.1, -17.2, -23.1]) { rbox(machineB, 0.22, 0.15, 0.3, 0.015, trayX - 0.02, 5.11, z); rod(brushedB, 0.012, [trayX - 0.02, 5.1, z + 0.15], [trayX - 0.02, 5.03, z + 0.4], 6); }
  // Slack loops hanging off the tray between brackets.
  for (const [z, drop] of [[-5, 0.34], [-16.6, 0.26], [1.6, 0.3]]) {
    put(rubberB, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(trayX + 0.13, 5.0, z + 1.4), new THREE.Vector3(trayX + 0.2, 5.0 - drop * 0.7, z + 0.75), new THREE.Vector3(trayX + 0.21, 5.0 - drop, z), new THREE.Vector3(trayX + 0.2, 5.0 - drop * 0.7, z - 0.75), new THREE.Vector3(trayX + 0.13, 5.0, z - 1.4)]), 28, 0.016, 6, false), 0, 0, 0);
  }

  // Duct outlets angled into the hall, and a monorail hoist between two trusses.
  const outlet = mergeGeometries([new THREE.CylinderGeometry(0.15, 0.15, 0.34, 14).translate(0, -0.17, 0), new THREE.CylinderGeometry(0.2, 0.17, 0.08, 14).translate(0, -0.37, 0)]);
  instances(outlet, ductMaterial, [5.2, -0.8, -6.8, -12.8, -18.8, -24.8].flatMap((z) => side2.map((s) => T(s * 7.2, 5.3, z, 0, 0, -s * 1.05))), false, false);
  const louvre = mergeGeometries([-0.1, -0.03, 0.04, 0.11].map((x) => new THREE.BoxGeometry(0.012, 0.03, 0.3).applyMatrix4(new THREE.Matrix4().makeRotationZ(0.5)).translate(x, -0.4, 0)));
  if (high) instances(louvre, darkMetal, [5.2, -0.8, -6.8, -12.8, -18.8, -24.8].flatMap((z) => side2.map((s) => T(s * 7.2, 5.3, z, 0, 0, -s * 1.05))), false, false);

  // The monorail runs from over the soak box by the furnace to over the quench tank; the hoist itself is built with them.
  const hoistZ = -13.55, soakX = 5.45, tankX = -5.4;
  box(steelB, 13, 0.016, 0.16, 0, 5.57, hoistZ); box(steelB, 13, 0.22, 0.012, 0, 5.455, hoistZ); box(steelB, 13, 0.018, 0.16, 0, 5.34, hoistZ);
  for (const x of [-6, -2, 2, 6]) { rod(steelB, 0.014, [x, 5.57, hoistZ], [x, 6.25, hoistZ], 6); box(steelB, 0.12, 0.02, 0.2, x, 5.585, hoistZ); }
  for (const x of [-6.45, 6.45]) box(yellowB, 0.06, 0.18, 0.2, x, 5.43, hoistZ);

  // ---- Bay 01 roller door on the -x wall --------------------------------------
  const doorZ = 6.8, doorHalf = 1.7;
  {
    const slat = new THREE.Shape();
    slat.moveTo(-0.02, 0); slat.lineTo(0, 0);
    for (let y = 0; y < 3.59; y += 0.09) { slat.lineTo(0.022, y + 0.02); slat.lineTo(0.022, y + 0.045); slat.lineTo(0.004, y + 0.062); slat.lineTo(0, y + 0.09); }
    slat.lineTo(-0.02, 3.6); slat.closePath();
    const curtain = new THREE.ExtrudeGeometry(slat, { depth: doorHalf * 2, bevelEnabled: false });
    curtain.translate(0, 0, -doorHalf);
    put(greenLit, curtain, -9.51, 0.06, doorZ);
    for (const o of [-doorHalf - 0.06, doorHalf + 0.06]) {
      box(steelHit, 0.1, 3.72, 0.12, -9.47, 1.86, doorZ + o);
      box(steelHit, 0.05, 3.72, 0.2, -9.515, 1.86, doorZ + o * 1.04);
      box(steelB, 0.12, 0.012, 0.2, -9.46, 0.006, doorZ + o);
      if (high) for (const y of [0.4, 1.3, 2.2, 3.1]) put(darkB, new THREE.CylinderGeometry(0.016, 0.016, 0.02, 6), -9.415, y, doorZ + o, 0, 0, PI / 2);
    }
    put(hazardB, new THREE.BoxGeometry(doorHalf * 2, 0.11, 0.05), -9.475, 0.075, doorZ, 0, PI / 2, 0);
    // Rubber seal under the bottom rail, set back from its face.
    box(rubberB, 0.04, 0.02, doorHalf * 2, -9.475, 0.01, doorZ);
    rbox(greenLit, 0.44, 0.48, doorHalf * 2 + 0.5, 0.03, -9.33, 3.94, doorZ);
    for (const o of [-doorHalf - 0.26, doorHalf + 0.26]) box(steelB, 0.5, 0.54, 0.02, -9.32, 3.94, doorZ + o);
    box(steelB, 0.02, 0.05, doorHalf * 2 + 0.5, -9.105, 3.72, doorZ);
    // Chain hoist on the -z end: gearbox, hand-chain wheel, chain loop and cleat.
    const chainZ = doorZ - doorHalf - 0.44;
    rbox(steelHit, 0.3, 0.32, 0.24, 0.03, -9.3, 3.94, chainZ - 0.02);
    put(steelB, new THREE.CylinderGeometry(0.15, 0.15, 0.04, 18), -9.3, 3.94, chainZ - 0.18, PI / 2, 0, 0);
    put(darkB, new THREE.TorusGeometry(0.15, 0.012, 5, 18), -9.3, 3.94, chainZ - 0.18);
    // The hand chain has been left off its cleat and swings along the wall in the draught from under the door.
    const handChain = loose(darkMetal, 1.2);
    for (const o of [-0.15, 0.15]) rod(handChain, 0.007, [o, 0, 0], [o * 0.5, -2.84, 0], 5);
    put(handChain, new THREE.TorusGeometry(0.075, 0.007, 5, 12, PI), 0, -2.84, 0, 0, 0, PI);
    if (high) for (let up = 0.1; up < 2.7; up += 0.11) for (const o of [-1, 1]) put(handChain, new THREE.SphereGeometry(0.012, 5, 4), o * (0.075 + up / 2.84 * 0.075), up - 2.84, 0);
    const chainLoop = assemble(new THREE.Group(), [handChain], true);
    chainLoop.position.set(-9.3, 3.94, chainZ - 0.18);
    scene.add(chainLoop);
    life.sway(chainLoop, { amplitude: 0.5, period: 3.3, axis: "x", damping: 0.05, creak: "chainRattle" });
    box(steelB, 0.06, 0.2, 0.04, -9.5, 1.3, chainZ - 0.18);
    // Control station and beacon.
    rbox(yellowB, 0.09, 0.3, 0.16, 0.012, -9.49, 1.45, doorZ + doorHalf + 0.3);
    for (const [y, lamp] of [[1.54, mintB], [1.45, amberB], [1.36, orangeLedB]] as Array<[number, Bag]>) put(lamp, new THREE.CylinderGeometry(0.022, 0.022, 0.02, 10), -9.44, y, doorZ + 2.3, 0, 0, PI / 2);
    rod(brushedB, 0.011, [-9.52, 1.6, doorZ + 2.3], [-9.52, 3.7, doorZ + 2.3], 6);
    put(amberB, lathe([[0, 0], [0.06, 0], [0.06, 0.07], [0.04, 0.11], [0, 0.12]], 12), -9.3, 4.2, doorZ + 1.6);
    box(darkB, 0.16, 0.03, 0.16, -9.3, 4.19, doorZ + 1.6);
    // Bollards guarding the jambs.
    for (const o of [-doorHalf - 0.3, doorHalf + 0.3]) {
      put(yellowB, lathe([[0, 0], [0.085, 0], [0.085, 1.0], [0.06, 1.06], [0, 1.07]], 14), -9.12, 0, doorZ + o);
      put(steelB, new THREE.CylinderGeometry(0.14, 0.14, 0.02, 14), -9.12, 0.01, doorZ + o);
      for (const y of [0.55, 0.8]) put(darkB, new THREE.CylinderGeometry(0.087, 0.087, 0.09, 14, 1, true), -9.12, y, doorZ + o);
    }
    // The board stands off the cladding on two rails, in front of the conduit runs that cross this bay.
    wallSign(-1, "tally", 1.9, 0.95, 4.86, doorZ - 0.2, 0.14, litSignB);
    for (const y of [4.44, 5.28]) box(darkB, 0.126, 0.04, 1.84, -9.587, y, doorZ - 0.2);
    // Twin flood over the door and a batten over the lockers: the fixtures the wash comes from.
    for (const o of [-0.7, 0.7]) {
      rbox(darkB, 0.2, 0.16, 0.34, 0.02, -9.2, 4.3, doorZ + o, 0, 0, -0.6);
      box(whiteB, 0.012, 0.11, 0.28, -9.115, 4.24, doorZ + o, 0, 0, -0.6);
      bar(steelB, 0.03, [-9.3, 4.32, doorZ + o], [-9.6, 4.34, doorZ + o]);
    }
    rbox(darkB, 1.3, 0.06, 0.12, 0.015, -7.93, 2.27, 9.6);
    rod(whiteB, 0.016, [-8.5, 2.225, 9.58], [-7.36, 2.225, 9.58], 8);
    rbox(darkB, 1.3, 0.06, 0.12, 0.015, 8.15, 3.42, 9.6);
    rod(whiteB, 0.016, [7.58, 3.375, 9.58], [8.72, 3.375, 9.58], 8);
  }

  // ---- Lockers on the tape wall, -x corner -----------------------------------
  for (let i = 0; i < 6; i += 1) {
    const x = -9.08 + i * 0.46;
    rbox(greenLit, 0.45, 1.84, 0.5, 0.012, x, 1.02, 9.44);
    box(greenLit, 0.4, 1.74, 0.012, x, 1.02, 9.186);
    for (const y of [1.68, 1.64, 1.6, 1.56, 0.44, 0.4, 0.36]) box(darkB, 0.26, 0.012, 0.01, x, y, 9.178);
    rbox(brushedB, 0.03, 0.12, 0.02, 0.006, x + 0.16, 1.05, 9.172);
    put(darkB, new THREE.CylinderGeometry(0.012, 0.012, 0.012, 8), x + 0.16, 1.0, 9.16, PI / 2, 0, 0);
    for (const y of [0.4, 1.7]) put(brushedB, new THREE.CylinderGeometry(0.009, 0.009, 0.09, 6), x - 0.205, y, 9.178);
  }
  box(darkHit, 2.78, 0.1, 0.46, -7.93, 0.05, 9.45);
  box(greenFine, 2.78, 0.03, 0.56, -7.93, 1.955, 9.42, 0.1, 0, 0);
  sign("crew", 2.73, 0.34, -7.93, 1.36, 9.176, PI, false);
  for (const [x, yaw] of [[-8.7, 0.4], [-7.5, -0.7]]) at(x, 1.99, 9.42, yaw, () => {
    put(yellowB, new THREE.SphereGeometry(0.13, 14, 8, 0, PI * 2, 0, PI / 2).scale(1, 0.95, 1.15), 0, 0, 0);
    put(yellowB, new THREE.CylinderGeometry(0.15, 0.155, 0.012, 14).scale(1, 1, 1.25), 0, 0.006, 0.02);
    box(yellowB, 0.03, 0.035, 0.3, 0, 0.115, 0);
  });
  sign("danger", 2.3, 1.15, -7.93, 2.95, 9.68, PI);
  sign("tradeUp", 2.2, 1.1, 8.15, 2.75, 9.68, PI);
  // The quality board hangs on the open brick of the east wall, where the lanes see it: the forklift is parked across the tape wall.
  wallSign(1, "grades", 2.2, 0.55, 1.9, 6.1);

  // ---- Racking and stock --------------------------------------------------------
  // Pallets, crates, drums, cartons and sacks come from the shared props library, queued here by kind
  // and placed in one batch each. Nothing in a foundry is new: every tint is a worked, dusty version
  // of the library's, and whatever stands near the hearth is dulled further by soot.
  const stock = new Map<PropKind, PropItem[]>();
  const sootColour = new THREE.Color(0x2a2420);
  /** 1 at the furnace mouth, gone eight metres away. */
  const sootAt = (x: number, z: number) => Math.max(0, 1 - Math.hypot(x - 8.4, z + 11.6) / 8);
  const stand = (kind: PropKind, x: number, y: number, z: number, rotation: [number, number, number], tint: number, extra: Partial<PropItem> = {}) => {
    // The room is lit low and warm, so the library's true-to-life timber and steel are lifted to read in it.
    const lift = kind.startsWith("crate") || kind === "pallet" ? 2.7 : kind.startsWith("carton") ? 1.45 : 1.8;
    const item: PropItem = { position: [x, y, z], rotation, tint: new THREE.Color(tint).multiplyScalar(lift).lerp(sootColour, sootAt(x, z) * 0.62), ...extra };
    stock.set(kind, [...(stock.get(kind) ?? []), item]);
  };
  const tall = (kind: PropKind) => props.get(kind).size[1];
  const yawed = (angle: number): [number, number, number] => [0, angle, 0];
  let jitterSeed = 99, dealt = 0;
  const jitter = (amount: number) => { jitterSeed = (jitterSeed * 1664525 + 1013904223) >>> 0; return (jitterSeed / 4294967296 - 0.5) * 2 * amount; };
  const deal = (palette: number[]) => palette[dealt++ % palette.length];
  const TIMBER = [0xcdb894, 0xb9a37e, 0xd6c3a0], SKID = [0xb7a486, 0xa08d70, 0xc4b294], BOARD = [0xd9c9aa, 0xc6b592, 0xe2d4b8], JUTE = [0xd3c6ac, 0xc2b294, 0xddd2ba], OLIVE = [0x6f7a48, 0x5f6a3e, 0x7a8052];
  // A print or stencil turned to face the room from the west wall, and from the east wall.
  const EAST = PI / 2, WEST = -PI / 2;
  const deck = tall("pallet"), crate = tall("crateLarge"), ammo = tall("crateAmmo");

  // Longspan shelving: shallow enough to stand between the kerb and the walkway, so it holds hand-loaded
  // stock on boarded levels instead of pallets.
  const rackBack = -9.27, rackFront = -8.87, stockX = -9.025, rackBays = [-23.325, -21.375], rackLevels = [1.31, 2.41];
  for (const z of [-24.3, -22.35, -20.4]) {
    for (const x of [rackBack, rackFront]) { box(greenB, 0.085, 3.3, 0.07, x, 1.65, z); box(steelB, 0.12, 0.01, 0.13, x + 0.012, 0.005, z); }
    for (const y of [0.15, 1.2, 2.25, 3.2]) bar(greenFine, 0.028, [rackBack, y, z], [rackFront, y, z]);
    for (const [index, y] of [0.15, 1.2, 2.25].entries()) bar(greenFine, 0.024, [index % 2 ? rackFront : rackBack, y, z], [index % 2 ? rackBack : rackFront, y + 1.05, z]);
  }
  for (const z of rackBays) for (const y of rackLevels) {
    for (const x of [rackBack, rackFront]) {
      box(orangeB, 0.045, 0.11, 1.865, x + 0.066, y - 0.055, z);
      if (high) for (const e of [-0.925, 0.925]) box(orangeB, 0.058, 0.19, 0.012, x + 0.066, y - 0.06, z + e);
    }
    box(planksB, 0.445, 0.028, 1.85, -9.005, y + 0.014, z);
  }
  const shelfTop = (level: number) => rackLevels[level] + 0.028, bearer = 0.06;
  // Floor level, first bay: an oil drum laid on chocked bearers, bung up, and a part-used one stood beside it.
  const drumRadius = props.get("drum").size[0] / 2;
  for (const z of [-24.02, -23.5]) {
    box(planksB, 0.5, bearer, 0.07, -9.0, bearer / 2, z);
    for (const side of [-1, 1]) {
      const wedge = new THREE.Shape();
      wedge.moveTo(0.15, 0); wedge.lineTo(0.31, 0); wedge.lineTo(0.31, 0.19); wedge.closePath();
      put(planksB, new THREE.ExtrudeGeometry(wedge, { depth: 0.06, bevelEnabled: false }).translate(0, 0, -0.03), -9.0, bearer, z, 0, side > 0 ? 0 : PI, 0);
    }
  }
  stand("drum", -9.0, bearer + drumRadius, -24.2, [PI / 2, PI / 2 + 0.5, 0], 0x1c6a64, { variant: 0 });
  stand("drum", -9.012, 0, -22.76, yawed(EAST - 0.4), 0x8a4a1c, { variant: 3 });
  // Second bay: cartons kept off the slab on bearers, the heavy ones at the bottom.
  for (const o of [-0.62, 0, 0.62]) box(planksB, 0.42, bearer, 0.07, stockX, bearer / 2, rackBays[1] + o);
  stand("cartonLarge", -9.02, bearer, -21.98, yawed(EAST + 0.03), deal(BOARD));
  stand("cartonLarge", -9.01, bearer, -21.34, yawed(EAST - 0.04), deal(BOARD));
  stand("cartonLarge", -9.03, bearer + tall("cartonLarge"), -21.9, yawed(EAST + 0.07), deal(BOARD));
  stand("carton", -9.0, bearer, -20.74, yawed(EAST + 0.05), deal(BOARD));
  stand("cartonFlat", -9.02, bearer + tall("cartonLarge"), -21.31, yawed(EAST - 0.06), deal(BOARD));
  stand("cartonFlat", -8.99, bearer + tall("cartonLarge") + tall("cartonFlat"), -21.35, yawed(EAST + 0.12), deal(BOARD));
  stand("cartonSmall", -9.01, bearer + tall("carton"), -20.72, yawed(EAST - 0.3), deal(BOARD));
  stand("cartonSmall", -9.04, bearer + tall("cartonLarge") * 2, -21.84, yawed(0.5), deal(BOARD));
  // One that came off the shelf and was driven over.
  stand("cartonCrushed", -8.6, 0, -20.86, yawed(EAST + 0.5), BOARD[1]);
  // First level: two ingot stacks, and cartons, one of them opened for what was in it.
  const ingots: Transform[] = [];
  for (const end of [-0.42, 0.42]) for (let layer = 0; layer < 3; layer += 1) for (let i = 0; i < 3 - layer; i += 1) {
    ingots.push(T(stockX + (i - (2 - layer) / 2) * 0.162, shelfTop(0) + 0.006 + layer * 0.092, rackBays[0] + end + jitter(0.015), 0, PI / 2 + jitter(0.025), 0));
  }
  for (const [index, z] of [-22.04, -21.545, -21.05].entries()) stand("carton", stockX + jitter(0.012), shelfTop(0), z, yawed(EAST + jitter(0.05)), deal(BOARD), { variant: index === 1 ? 2 : 0 });
  stand("carton", stockX - 0.01, shelfTop(0) + tall("carton"), -21.97, yawed(EAST - 0.08), deal(BOARD), { variant: 0 });
  stand("cartonOpen", stockX, shelfTop(0) + tall("carton"), -21.07, yawed(EAST + 0.1), deal(BOARD));
  stand("cartonTall", stockX + 0.01, shelfTop(0), -20.62, yawed(EAST + 0.04), deal(BOARD));
  // Top level: sacks of flux laid two deep, and the light cartons.
  for (const [z, layers] of [[-23.84, 3], [-23.04, 2]]) for (let layer = 0; layer < layers; layer += 1) {
    stand("sackLying", -9.005 + jitter(0.012), shelfTop(1) + layer * 0.19, z + jitter(0.03), yawed((layer % 2 ? WEST : EAST) + jitter(0.06)), deal(JUTE), { variant: 3 });
  }
  stand("cartonLarge", -9.02, shelfTop(1), -21.99, yawed(EAST - 0.03), deal(BOARD));
  stand("cartonLarge", -9.01, shelfTop(1), -21.35, yawed(EAST + 0.05), deal(BOARD));
  stand("cartonTall", -9.02, shelfTop(1), -20.84, yawed(EAST - 0.1), deal(BOARD));
  stand("cartonFlat", -9.0, shelfTop(1) + tall("cartonLarge"), -21.95, yawed(EAST + 0.2), deal(BOARD));
  stand("cartonSmall", -9.03, shelfTop(1) + tall("cartonLarge"), -21.3, yawed(0.7), deal(BOARD));
  // Load notice at eye height on the brick by the rack's end, under the corner of the range sign on this wall.
  wallSign(-1, "load", 0.5, 0.5, 1.62, -19.1);

  // Goods in, by the roller door: empties stacked at the wall, a mixed pallet of cartons, two pattern
  // crates stood off it and the oil drums.
  for (let i = 0; i < 6; i += 1) {
    const last = i === 5 ? 1 : 0;
    stand("pallet", -8.9 + jitter(0.03) + last * 0.08, i * deck, -0.55 + jitter(0.03) - last * 0.07, yawed(EAST + jitter(0.06) + last * 0.22), deal(SKID));
  }
  stand("pallet", -8.86, 0, 2.55, yawed(EAST + 0.04), deal(SKID));
  stand("cartonLarge", -9.03, deck, 2.25, yawed(EAST + 0.03), deal(BOARD));
  stand("cartonLarge", -9.03, deck, 2.89, yawed(EAST - 0.03), deal(BOARD));
  stand("cartonLarge", -9.02, deck + tall("cartonLarge"), 2.31, yawed(EAST + 0.09), deal(BOARD));
  stand("cartonFlat", -9.02, deck + tall("cartonLarge"), 2.94, yawed(EAST - 0.05), deal(BOARD));
  stand("cartonFlat", -9.0, deck + tall("cartonLarge") + tall("cartonFlat"), 2.9, yawed(EAST + 0.16), deal(BOARD));
  stand("cartonOpen", -9.03, deck + tall("cartonLarge") * 2, 2.3, yawed(EAST - 0.12), deal(BOARD));
  stand("carton", -8.61, deck, 2.2, yawed(EAST - 0.02), deal(BOARD), { variant: 1 });
  stand("carton", -8.6, deck, 2.7, yawed(EAST + 0.04), deal(BOARD), { variant: 1 });
  stand("carton", -8.6, deck + tall("carton"), 2.24, yawed(EAST + 0.11), deal(BOARD), { variant: 1 });
  stand("cartonSmall", -8.6, deck + tall("carton"), 2.74, yawed(EAST - 0.4), deal(BOARD));
  stand("pallet", -7.56, 0, 1.22, yawed(EAST - 0.04), deal(SKID));
  stand("crateLarge", -7.56, deck, 1.22, yawed(EAST - 0.06), deal(TIMBER), { variant: 2 });
  stand("crateLarge", -7.48, 0, 2.52, yawed(EAST + 0.09), deal(TIMBER), { variant: 1 });
  stand("crateSlat", -7.62, deck + crate, 1.1, yawed(EAST + 0.35), deal(TIMBER));
  stand("crateSlat", -7.5, crate, 2.68, yawed(0.3), deal(TIMBER));
  stand("crateSlat", -7.45, props.get("crateSlat").size[2] / 2, 3.15, turned(["x", PI / 2], ["y", 0.22]), deal(TIMBER));
  stand("drum", -8.74, 0, 3.62, yawed(EAST + 0.5), 0x8a4a1c, { variant: 0 });
  stand("drum", -8.7, 0, 4.27, yawed(EAST - 0.7), 0x23272a, { variant: 2 });
  stand("drumPlastic", -8.14, 0, 3.93, yawed(EAST + 0.2), 0x1d4a82);

  // East wall, short of the plant door: a crate for despatch with range ammunition left on it, two drums
  // of quench oil, a pallet leant on the wall and the wash-down drum by the gas store.
  stand("pallet", 8.82, 0, -2.98, yawed(EAST - 0.04), deal(SKID));
  stand("crateLarge", 8.82, deck, -2.98, yawed(WEST + 0.05), deal(TIMBER), { variant: 3 });
  stand("crateAmmo", 8.8, deck + crate, -3.14, yawed(WEST + 0.1), deal(OLIVE), { variant: 0 });
  stand("crateAmmo", 8.84, deck + crate + ammo, -3.05, yawed(WEST - 0.33), deal(OLIVE), { variant: 1 });
  stand("drum", 8.97, 0, -3.93, yawed(WEST + 0.6), 0x23272a, { variant: 0 });
  stand("drum", 8.74, 0, -2.0, yawed(WEST - 0.3), 0x8a4a1c, { variant: 3 });
  {
    // Stood on its long edge with its head on the brickwork, clear of the kerb.
    const lean = 0.56, foot = 9.115;
    stand("pallet", foot + 0.4 * Math.sin(lean), 0.4 * Math.cos(lean), 0.55, turned(["x", lean - PI / 2], ["y", PI / 2]), deal(SKID));
  }
  stand("drumPlastic", 8.72, 0, 3.48, yawed(WEST + 0.4), 0x8f8c80, { variant: 3 });

  // West wall between the far stations: the ammunition point, a crate and a drum.
  stand("crateLarge", -8.86, 0, -14.93, yawed(EAST + 0.05), deal(TIMBER), { variant: 0 });
  stand("crateSlat", -8.9, crate, -15.06, yawed(EAST + 0.5), deal(TIMBER));
  stand("pallet", -8.84, 0, -16.2, yawed(EAST - 0.03), deal(SKID));
  stand("crateAmmo", -9.045, deck, -16.22, yawed(EAST + 0.02), deal(OLIVE));
  stand("crateAmmo", -8.635, deck, -16.17, yawed(EAST - 0.02), deal(OLIVE), { variant: 0 });
  stand("crateAmmo", -9.05, deck + ammo, -16.19, yawed(EAST - 0.03), deal(OLIVE));
  stand("crateAmmo", -8.63, deck + ammo, -16.26, yawed(EAST + 0.03), deal(OLIVE), { variant: 1 });
  stand("crateAmmo", -8.82, deck + ammo * 2, -16.18, yawed(0.2), deal(OLIVE), { variant: 2 });
  stand("drum", -8.78, 0, -17.55, yawed(EAST + 0.7), 0x1c6a64, { variant: 2 });

  // Furnace charge, at the wall beside the hearth: cut sacks of coke breeze, flux and moulding sand.
  stand("sackOpen", 8.76, 0, -14.02, yawed(0.4), JUTE[1], { variant: 3, tint2: 0x24211e });
  stand("sackOpen", 8.9, 0, -14.66, yawed(1.9), JUTE[0], { variant: 3, tint2: 0xcfc8b4 });
  stand("sackOpen", 8.82, 0, -15.28, yawed(-0.8), JUTE[2], { variant: 3, tint2: 0xb08c54 });
  // A quench drum under the hose reel on the other side of it.
  stand("drum", 8.9, 0, -8.8, yawed(WEST - 0.5), 0x2a2622, { variant: 3 });

  // Past the workbench: sacks staged on a pallet, a crate, and the drums in the corner.
  stand("pallet", 8.84, 0, -18.95, yawed(EAST + 0.05), deal(SKID));
  stand("sackLying", 8.84, deck, -19.21, yawed(0.03), deal(JUTE), { variant: 3 });
  stand("sackLying", 8.83, deck, -18.7, yawed(PI - 0.05), deal(JUTE), { variant: 3 });
  stand("sackLying", 8.86, deck + 0.19, -19.17, yawed(PI + 0.06), deal(JUTE), { variant: 3 });
  stand("sackLying", 8.82, deck + 0.19, -18.73, yawed(0.09), deal(JUTE), { variant: 3 });
  stand("sackLying", 8.83, deck + 0.38, -18.97, yawed(EAST + 0.16), deal(JUTE), { variant: 3 });
  stand("sack", 8.74, 0, -19.93, yawed(WEST + 0.3), deal(JUTE), { variant: 3 });
  stand("crateLarge", 8.84, 0, -20.98, yawed(WEST - 0.06), deal(TIMBER), { variant: 1 });
  stand("crateAmmo", 8.82, crate, -20.72, yawed(PI + 0.12), deal(OLIVE), { variant: 3 });
  stand("crateSlat", 8.86, crate, -21.24, yawed(WEST + 0.1), deal(TIMBER));
  stand("drum", 8.95, 0, -22.15, yawed(WEST + 0.3), 0x8a4a1c, { variant: 1 });
  stand("drumPlastic", 8.9, 0, -22.82, yawed(WEST - 0.5), 0x1d4a82);

  for (const [kind, items] of stock) props.place(kind, items, { vary: 0.7 });
  {
    const ingot = new THREE.Shape();
    ingot.moveTo(-0.075, 0); ingot.lineTo(0.075, 0); ingot.lineTo(0.055, 0.085); ingot.lineTo(-0.055, 0.085); ingot.closePath();
    const geometry = new THREE.ExtrudeGeometry(ingot, { depth: 0.62, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.012, bevelSegments: 1 });
    geometry.translate(0, 0, -0.31);
    geometry.rotateY(PI / 2);
    instances(geometry, ductMaterial, ingots, true, false);
  }

  // ---- Forklift parked along the tape wall in the +x corner, forks grounded -----
  // It stands wholly behind z = 8.3, where the walkway ends, so nobody can walk into it.
  const tyre = (r: number, w: number) => lathe([[r * 0.5, -w / 2], [r - 0.035, -w / 2], [r, -w / 2 + 0.035], [r, w / 2 - 0.035], [r - 0.035, w / 2], [r * 0.5, w / 2]], 20).rotateZ(PI / 2);
  at(7.72, 0, 8.9, PI / 2 + 0.03, () => {
    // Wheels.
    for (const x of [-0.5, 0.5]) {
      put(rubberB, tyre(0.28, 0.2), x, 0.28, -0.5);
      put(yellowB, new THREE.CylinderGeometry(0.15, 0.15, 0.17, 14), x, 0.28, -0.5, 0, 0, PI / 2);
      put(darkB, new THREE.CylinderGeometry(0.06, 0.06, 0.2, 8), x, 0.28, -0.5, 0, 0, PI / 2);
      put(rubberB, tyre(0.22, 0.16), x * 0.86, 0.22, 0.86);
      put(yellowB, new THREE.CylinderGeometry(0.12, 0.12, 0.14, 12), x * 0.86, 0.22, 0.86, 0, 0, PI / 2);
    }
    // Chassis, bonnet, counterweight.
    rbox(yellowB, 0.98, 0.42, 1.55, 0.05, 0, 0.52, 0.2);
    for (const x of [-0.5, 0.5]) rbox(yellowB, 0.12, 0.1, 0.66, 0.03, x, 0.6, -0.5);
    rbox(yellowB, 0.9, 0.36, 0.86, 0.06, 0, 0.9, 0.52);
    rbox(darkHit, 1.04, 0.78, 0.44, 0.12, 0, 0.72, 1.2);
    box(darkB, 0.5, 0.2, 0.02, 0, 0.85, 1.425);
    for (let i = 0; i < 5; i += 1) box(steelB, 0.46, 0.012, 0.01, 0, 0.78 + i * 0.035, 1.437);
    rod(steelB, 0.03, [0, 0.38, 1.42], [0, 0.38, 1.5], 8);
    // Dash, steering, levers, seat.
    rbox(yellowB, 0.9, 0.5, 0.2, 0.04, 0, 0.98, -0.28);
    rod(darkB, 0.022, [-0.12, 1.2, -0.25], [-0.12, 1.42, -0.08], 8);
    put(rubberB, new THREE.TorusGeometry(0.16, 0.017, 6, 20), -0.12, 1.43, -0.07, -0.95, 0, 0);
    for (const a of [0, 2.1, 4.2]) bar(darkB, 0.016, [-0.12, 1.43, -0.07], [-0.12 + Math.cos(a) * 0.15, 1.43 + Math.sin(a) * 0.15 * 0.58, -0.07 + Math.sin(a) * 0.15 * 0.81]);
    for (const [index, x] of [0.2, 0.27, 0.34].entries()) { rod(brushedB, 0.008, [x, 1.2, -0.22], [x, 1.4, -0.26 + index * 0.02], 5); put(index === 0 ? redB : rubberB, new THREE.SphereGeometry(0.022, 8, 6), x, 1.41, -0.26 + index * 0.02); }
    rbox(rubberB, 0.46, 0.1, 0.44, 0.04, 0, 1.14, 0.48);
    rbox(rubberB, 0.46, 0.5, 0.1, 0.04, 0, 1.42, 0.74, -0.14, 0, 0);
    // Overhead guard.
    const posts: Array<[number[], number[]]> = [];
    for (const x of [-0.47, 0.47]) { posts.push([[x, 1.05, -0.36], [x * 0.96, 2.12, -0.2]], [[x, 1.05, 0.94], [x * 0.96, 2.12, 0.84]]); }
    posts.forEach(([a, c]) => bar(yellowB, 0.055, a, c));
    for (const x of [-0.45, 0.45]) bar(yellowB, 0.055, [x, 2.12, -0.22], [x, 2.12, 0.86]);
    for (const z of [-0.2, 0.84]) bar(yellowB, 0.055, [-0.47, 2.12, z], [0.47, 2.12, z]);
    for (const z of [0, 0.16, 0.32, 0.48, 0.64]) bar(darkB, 0.022, [-0.45, 2.13, z], [0.45, 2.13, z]);
    put(amberB, lathe([[0, 0], [0.05, 0], [0.05, 0.06], [0.035, 0.1], [0, 0.105]], 12), 0.36, 2.15, 0.78);
    for (const x of [-0.47, 0.47]) { put(darkB, new THREE.CylinderGeometry(0.055, 0.045, 0.07, 12), x, 1.86, -0.3, PI / 2, 0, 0); put(brushedB, new THREE.CylinderGeometry(0.046, 0.046, 0.01, 12), x, 1.86, -0.338, PI / 2, 0, 0); }
    // LPG bottle on the counterweight.
    put(brushedB, lathe([[0, -0.36], [0.1, -0.35], [0.15, -0.28], [0.15, 0.28], [0.1, 0.35], [0.04, 0.37], [0.04, 0.41], [0, 0.41]], 16), 0, 1.27, 1.2, 0, 0, PI / 2);
    for (const x of [-0.18, 0.18]) put(darkB, new THREE.TorusGeometry(0.153, 0.008, 4, 16), x, 1.27, 1.2, 0, PI / 2, 0);
    // Mast: channels, cross-heads, lift ram, chains, tilt rams.
    for (const x of [-0.33, 0.33]) { box(darkHit, 0.07, 2.15, 0.12, x, 1.16, -0.74); box(steelB, 0.05, 1.9, 0.08, x * 0.8, 1.2, -0.75); bar(brushedB, 0.03, [x, 0.62, -0.3], [x, 0.9, -0.7]); }
    for (const y of [0.16, 1.25, 2.2]) box(darkB, 0.73, 0.07, 0.06, 0, y, -0.72);
    rod(brushedB, 0.035, [0, 0.2, -0.72], [0, 1.9, -0.72], 10);
    rod(darkB, 0.05, [0, 0.2, -0.72], [0, 1.1, -0.72], 10);
    for (const x of [-0.1, 0.1]) box(darkB, 0.03, 1.75, 0.012, x, 1.12, -0.79);
    // Carriage, load backrest and forks.
    for (const y of [0.235, 0.555]) box(darkB, 0.92, 0.09, 0.035, 0, y, -0.83);
    for (const x of [-0.42, -0.21, 0, 0.21, 0.42]) box(darkB, 0.025, 0.72, 0.025, x, 0.915, -0.83);
    box(darkB, 0.9, 0.03, 0.03, 0, 1.275, -0.83);
    const fork = new THREE.Shape();
    fork.moveTo(0, 0.64); fork.lineTo(0.045, 0.64); fork.lineTo(0.045, 0.085); fork.quadraticCurveTo(0.05, 0.045, 0.09, 0.045); fork.lineTo(1.08, 0.014); fork.lineTo(1.1, 0); fork.lineTo(0.03, 0); fork.quadraticCurveTo(0, 0, 0, 0.03); fork.closePath();
    for (const x of [-0.2, 0.2]) {
      const geometry = new THREE.ExtrudeGeometry(fork, { depth: 0.1, bevelEnabled: false, curveSegments: 5 });
      geometry.translate(0, 0, -0.05);
      put(steelHit, geometry, x, 0.035, -0.86, 0, PI / 2, 0);
    }
  });
  // Charger on the wall behind it, its lead coiled on a hook.
  rbox(machineB, 0.24, 0.62, 0.46, 0.02, 9.41, 1.5, 9.1);
  box(darkB, 0.012, 0.2, 0.3, 9.285, 1.62, 9.1);
  for (const [z, lamp] of [[9.0, mintB], [9.1, mintB], [9.2, orangeLedB]] as Array<[number, Bag]>) box(lamp, 0.012, 0.02, 0.05, 9.28, 1.6, z);
  put(rubberB, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(9.42, 1.2, 9.0), new THREE.Vector3(9.47, 0.98, 8.86), new THREE.Vector3(9.5, 0.96, 8.7), new THREE.Vector3(9.5, 1.08, 8.6)]), 16, 0.013, 6, false), 0, 0, 0);
  for (const [index, r] of [0.14, 0.125, 0.11].entries()) put(rubberB, new THREE.TorusGeometry(r, 0.013, 5, 22), 9.512 - index * 0.022, 1.22 - (0.14 - r), 8.6, 0, PI / 2, 0);
  box(steelB, 0.1, 0.022, 0.03, 9.49, 1.372, 8.6);
  rbox(darkB, 0.05, 0.11, 0.05, 0.01, 9.45, 1.0, 8.52);
  wallSign(1, "truck", 0.9, 0.45, 2.45, 8.4);

  // ---- Walls: doors, boards, fire points, first aid, gas store, bench ---------
  for (const [x, z] of doors) {
    const s = Math.sign(x), face = x - s * 0.085;
    // Pressed panel beads, vision panel, hinges, closer, lever and lock.
    for (const [y, h] of [[0.92, 0.66], [2.15, 0.2]]) for (const e of [-1, 1]) { box(machineB, 0.012, 0.03, 1.3, face, y + e * h / 2, z); box(machineB, 0.012, h, 0.03, face, y, z + e * 0.65); }
    box(steelB, 0.02, 0.58, 0.36, face, 1.72, z + 0.38);
    box(glassB, 0.024, 0.5, 0.28, face, 1.72, z + 0.38);
    for (const y of [0.3, 1.38, 2.5]) put(brushedB, new THREE.CylinderGeometry(0.02, 0.02, 0.13, 8), face - s * 0.01, y, z - 0.86);
    rbox(steelB, 0.07, 0.07, 0.3, 0.012, face - s * 0.03, 2.62, z - 0.6);
    bar(brushedB, 0.014, [face - s * 0.05, 2.62, z - 0.5], [face - s * 0.11, 2.78, z - 0.12]);
    box(brushedB, 0.012, 0.24, 0.07, face, 1.08, z + 0.72);
    rod(brushedB, 0.011, [face, 1.1, z + 0.72], [face - s * 0.06, 1.1, z + 0.72], 6);
    rod(brushedB, 0.011, [face - s * 0.06, 1.1, z + 0.73], [face - s * 0.06, 1.1, z + 0.58], 6);
    put(plateB, new THREE.BoxGeometry(0.34, 0.012, 1.74), x - s * 0.2, 0.006, z);
    // Illuminated exit box over the head of the frame.
    rbox(darkB, 0.09, 0.26, 0.56, 0.012, x - s * 0.1, 3.14, z);
    sign("exit", 0.5, 0.2, x - s * 0.147, 3.14, z, -s * PI / 2, false);
    rod(brushedB, 0.01, [x - s * 0.02, 3.27, z], [x - s * 0.02, 3.6, z], 6);
  }
  sign("cage", 0.62, 0.155, doors[0][0] + 0.094, 1.3, doors[0][1] - 0.25, PI / 2, false);
  sign("pattern", 0.62, 0.155, doors[1][0] - 0.094, 1.3, doors[1][1] + 0.25, -PI / 2, false);

  // Distribution boards on the -x wall.
  {
    const x = -9.41;
    rbox(machineB, 0.26, 1.3, 0.9, 0.015, x, 1.5, -7.1);
    box(greenFine, 0.012, 1.2, 0.8, x + 0.13, 1.5, -7.1);
    rbox(machineB, 0.2, 0.74, 0.56, 0.015, x - 0.03, 1.55, -6.25);
    box(greenFine, 0.012, 0.66, 0.48, x + 0.074, 1.55, -6.25);
    sign("volt", 0.3, 0.3, x + 0.138, 1.82, -7.1, PI / 2, false);
    sign("tag", 0.24, 0.12, x + 0.082, 1.74, -6.25, PI / 2, false);
    put(darkB, new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), x + 0.15, 1.3, -6.82, 0, 0, PI / 2);
    box(redB, 0.03, 0.14, 0.035, x + 0.175, 1.3, -6.82, 0.5, 0, 0);
    for (const [index, lamp] of [mintB, mintB, orangeLedB].entries()) put(lamp, new THREE.CylinderGeometry(0.016, 0.016, 0.014, 8), x + 0.14, 1.24, -7.36 + index * 0.08, 0, 0, PI / 2);
    for (const z of [-7.48, -6.48]) for (const y of [1.0, 2.0]) put(brushedB, new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6), x + 0.135, y, z);
    rbox(brushedB, 0.02, 0.1, 0.03, 0.005, x + 0.145, 1.5, -6.72);
    // Trunking and conduits up to the tray.
    box(steelB, 0.1, 0.1, 1.5, x - 0.06, 2.3, -6.8);
    for (const z of [-7.3, -7.15, -7.0, -6.25]) rod(brushedB, 0.014, [x - 0.05, 2.15, z], [x - 0.05, z < -6.5 ? 2.26 : 1.92, z], 6);
    for (const z of [-7.25, -7.05]) pipe(brushedB, 0.016, [[x - 0.06, 2.35, z], [x - 0.06, 3.5, z]], 0.05, 6);
    for (const z of [-7.25, -7.05]) pipe(rubberB, 0.016, [[-9.6, 3.95, z], [-9.6, 4.9, z], [trayX - 0.08, 5.02, z]], 0.08, 6);
    box(rubberB, 0.9, 0.012, 1.7, -8.85, 0.006, -6.85);
  }

  // Extinguishers: body, valve head, lever, gauge, hose and wall strap.
  const extinguisher = (x: number, y: number, z: number, yaw: number) => at(x, y, z, yaw, () => {
    put(redB, lathe([[0, 0], [0.072, 0], [0.078, 0.012], [0.078, 0.4], [0.062, 0.46], [0.026, 0.5], [0.026, 0.52], [0, 0.52]], 16), 0, 0, 0.09);
    put(darkB, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8), 0, 0.545, 0.09);
    box(darkB, 0.022, 0.016, 0.15, 0, 0.59, 0.12, 0.25, 0, 0);
    box(darkB, 0.022, 0.014, 0.12, 0, 0.555, 0.13);
    put(brushedB, new THREE.CylinderGeometry(0.02, 0.02, 0.012, 10), 0.035, 0.545, 0.09, 0, 0, PI / 2);
    put(rubberB, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.03, 0.545, 0.09), new THREE.Vector3(-0.1, 0.5, 0.1), new THREE.Vector3(-0.1, 0.3, 0.1), new THREE.Vector3(-0.092, 0.12, 0.1)]), 12, 0.011, 6, false), 0, 0, 0);
    box(steelB, 0.2, 0.03, 0.012, 0, 0.3, 0.006);
    put(steelB, new THREE.TorusGeometry(0.08, 0.006, 4, 14, PI), 0, 0.3, 0.09, PI / 2, 0, 0);
    box(steelB, 0.1, 0.012, 0.16, 0, -0.006, 0.08);
    const label = CELLS.label, geometry = new THREE.CylinderGeometry(0.0795, 0.0795, 0.17, 12, 1, true, -0.8, 1.6);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (label[0] + uv.getX(i) * label[2]) / 2048, 1 - (label[1] + (1 - uv.getY(i)) * label[3]) / 2048);
    put(signB, geometry, 0, 0.26, 0.09);
  });
  extinguisher(-9.54, 0.72, -2.72, PI / 2); extinguisher(-9.54, 0.72, -3.05, PI / 2);
  wallSign(-1, "fire", 0.46, 0.46, 2.0, -2.88);
  extinguisher(6.5, 0.72, 9.7, PI); extinguisher(6.82, 0.72, 9.7, PI);
  sign("fire", 0.46, 0.46, 6.66, 2.0, 9.68, PI);

  // First-aid cabinet and eyewash on the +x wall.
  rbox(greenB, 0.16, 0.46, 0.4, 0.02, 9.46, 1.55, -0.6);
  box(brushedB, 0.012, 0.05, 0.03, 9.375, 1.55, -0.44);
  wallSign(1, "aid", 0.42, 0.42, 2.2, -0.6);
  for (const z of [-1.0, -1.14]) put(greenFine, lathe([[0, 0], [0.04, 0], [0.04, 0.14], [0.018, 0.18], [0.018, 0.21], [0, 0.21]], 10), 9.47, 1.34, z);
  box(steelB, 0.1, 0.012, 0.3, 9.49, 1.335, -1.07);

  // Gas cylinder store, chained to a wall frame.
  {
    const cylinder = lathe([[0, 0], [0.108, 0], [0.115, 0.012], [0.115, 1.2], [0.09, 1.32], [0.046, 1.38], [0.046, 1.42], [0, 1.42]], 18);
    [1.42, 1.69, 1.96, 2.23].forEach((z, index) => {
      put(index % 2 ? rustB : greenB, cylinder.clone(), 9.18, 0.03, z, 0, index * 1.1, 0);
      put(darkB, lathe([[0.03, 0], [0.058, 0.005], [0.058, 0.1], [0.04, 0.14], [0, 0.145]], 12), 9.18, 1.45, z);
      put(index % 2 ? redB : brushedB, new THREE.CylinderGeometry(0.117, 0.117, 0.07, 18, 1, true), 9.18, 1.16, z);
    });
    cylinder.dispose();
    box(plateB, 0.34, 0.03, 1.2, 9.15, 0.015, 1.83);
    // The frame stands on the kerb; its arms reach out past the bottles to carry the chains.
    for (const z of [1.24, 2.41]) { box(steelHit, 0.05, 1.0, 0.05, 9.5, 0.82, z); for (const y of [0.55, 1.08]) bar(steelB, 0.04, [9.5, y, z], [9.02, y, z]); }
    for (const y of [0.55, 1.08]) {
      const points = Array.from({ length: 9 }, (_, step) => new THREE.Vector3(9.05, y - Math.sin(step / 8 * PI) * 0.035 - (step % 2) * 0.004, 1.24 + step * (1.17 / 8)));
      put(darkB, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, 0.008, 5, false), 0, 0, 0);
    }
    wallSign(1, "gas", 0.8, 0.2, 1.95, 1.83);
  }

  // Hose reel by the furnace, fed from the fire main.
  at(9.44, 1.5, -9.1, 0, () => {
    for (const o of [-0.085, 0.085]) {
      put(redB, new THREE.TorusGeometry(0.3, 0.014, 6, 28), -0.14 + o, 0, 0, 0, PI / 2, 0);
      put(redB, new THREE.CylinderGeometry(0.07, 0.07, 0.012, 14), -0.14 + o, 0, 0, 0, 0, PI / 2);
      for (let spoke = 0; spoke < 6; spoke += 1) box(redB, 0.01, 0.3, 0.03, -0.14 + o, Math.cos(spoke * PI / 3) * 0.15, Math.sin(spoke * PI / 3) * 0.15, spoke * PI / 3, 0, 0);
    }
    for (const [r, o] of [[0.26, -0.03], [0.26, 0.03], [0.23, 0], [0.2, -0.03], [0.2, 0.03]]) put(rubberB, new THREE.TorusGeometry(r, 0.022, 6, 28), -0.14 + o, 0, 0, 0, PI / 2, 0);
    put(brushedB, new THREE.CylinderGeometry(0.04, 0.04, 0.24, 10), -0.14, 0, 0, 0, 0, PI / 2);
    put(rubberB, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.14, -0.26, 0.02), new THREE.Vector3(-0.15, -0.5, 0.1), new THREE.Vector3(-0.13, -0.62, 0.2)]), 10, 0.02, 6, false), 0, 0, 0);
    put(brushedB, new THREE.CylinderGeometry(0.012, 0.022, 0.12, 8), -0.125, -0.66, 0.24, 0.9, 0, 0);
    box(steelB, 0.04, 0.5, 0.3, -0.02, 0, 0);
    valve(-0.0, 0.42, 0, 0.03);
  });

  // Workbench under the +x sign: frame, plank top, vice, toolbox, bins, tins.
  at(9.14, 0, -16.9, 0, () => {
    for (const x of [-0.3, 0.13]) for (const z of [-1.15, 1.15]) box(steelHit, 0.05, 0.86, 0.05, x, 0.43, z);
    for (const z of [-1.15, 1.15]) { box(steelB, 0.43, 0.04, 0.04, -0.085, 0.2, z); box(steelB, 0.6, 0.04, 0.04, 0, 0.8, z); }
    for (const x of [-0.3, 0.3]) box(steelB, 0.04, 0.04, 2.26, x, 0.8, 0);
    put(planksB, new RoundedBoxGeometry(2.42, 0.06, 0.74, 1, 0.008), 0, 0.89, 0, 0, PI / 2, 0);
    // The shelf drops in between the end rails, its top just under theirs.
    box(plateB, 0.46, 0.02, 2.25, -0.085, 0.204, 0);
    // Louvre panel with parts bins.
    box(darkHit, 0.02, 0.62, 2.36, 0.36, 1.26, 0);
    for (let row = 0; row < 3; row += 1) for (let i = 0; i < 9; i += 1) {
      const target = [redB, yellowB, greenB][(row + i * 2) % 3];
      rbox(target, 0.12, 0.085, 0.2, 0.01, 0.29, 1.05 + row * 0.19, -0.98 + i * 0.245 + (row % 2) * 0.03, 0, 0, 0.12);
    }
    // Engineer's vice.
    box(steelHit, 0.2, 0.05, 0.2, -0.16, 0.945, 0.86);
    rbox(steelHit, 0.12, 0.13, 0.16, 0.02, -0.16, 1.03, 0.86);
    box(steelB, 0.34, 0.07, 0.07, -0.2, 1.06, 0.86);
    for (const x of [-0.11, -0.28]) box(darkB, 0.03, 0.11, 0.14, x, 1.12, 0.86);
    rod(brushedB, 0.012, [-0.36, 1.06, 0.86], [-0.52, 1.06, 0.86], 6);
    rod(brushedB, 0.008, [-0.5, 0.97, 0.86], [-0.5, 1.15, 0.86], 5);
    // Toolbox, tins, a coiled lead and a strip light under the sign.
    rbox(redB, 0.26, 0.2, 0.52, 0.02, 0.02, 1.02, -0.6);
    rbox(redB, 0.24, 0.05, 0.5, 0.02, 0.02, 1.145, -0.6);
    put(brushedB, new THREE.TorusGeometry(0.07, 0.008, 5, 12, PI), 0.02, 1.17, -0.6, 0, PI / 2, 0);
    for (const [x, z, r] of [[-0.1, 0.1, 0.07], [0.06, 0.26, 0.055], [-0.05, 0.4, 0.055]]) { put(brushedB, new THREE.CylinderGeometry(r, r, r * 1.7, 14), x, 0.92 + r * 0.85, z); put(darkB, new THREE.TorusGeometry(r, 0.004, 4, 14), x, 0.92 + r * 1.7, z, PI / 2, 0, 0); }
    for (const r of [0.13, 0.115, 0.1]) put(coneB, new THREE.TorusGeometry(r, 0.012, 5, 20), -0.1, 0.228 + (0.13 - r) * 0.8, 0.5, PI / 2, 0, 0);
    rbox(greenB, 0.38, 0.3, 0.5, 0.02, -0.1, 0.364, -0.6);
    rbox(steelHit, 0.36, 0.22, 0.36, 0.02, -0.1, 0.324, -0.05);
    // Stool tucked under the front edge.
    put(rubberB, new THREE.CylinderGeometry(0.16, 0.16, 0.04, 16), -0.52, 0.62, -0.2);
    for (const a of [0.4, 2.5, 4.6]) bar(steelB, 0.022, [-0.52 + Math.cos(a) * 0.08, 0.6, -0.2 + Math.sin(a) * 0.08], [-0.52 + Math.cos(a) * 0.19, 0, -0.2 + Math.sin(a) * 0.19]);
    put(steelB, new THREE.TorusGeometry(0.14, 0.008, 4, 14), -0.52, 0.22, -0.2, PI / 2, 0, 0);
  });

  // Hand pallet truck left by the racking.
  at(-8.94, 0, -18.95, 0.08, () => {
    for (const x of [-0.19, 0.19]) { rbox(redB, 0.16, 0.045, 1.16, 0.012, x, 0.085, -0.58); put(darkB, new THREE.CylinderGeometry(0.04, 0.04, 0.1, 10), x, 0.04, -1.05, 0, 0, PI / 2); }
    rbox(redB, 0.54, 0.09, 0.16, 0.02, 0, 0.11, 0.04);
    rbox(redB, 0.16, 0.34, 0.14, 0.02, 0, 0.3, 0.1);
    put(brushedB, new THREE.CylinderGeometry(0.03, 0.03, 0.3, 10), 0, 0.36, 0.2);
    for (const x of [-0.06, 0.06]) put(rubberB, new THREE.CylinderGeometry(0.09, 0.09, 0.05, 14), x, 0.09, 0.2, 0, 0, PI / 2);
    rod(darkB, 0.018, [0, 0.4, 0.14], [0, 1.12, 0.46]);
    put(darkB, new THREE.TorusGeometry(0.1, 0.014, 6, 16), 0, 1.2, 0.5, 1.15, 0, 0);
  });

  // Fuel line into the furnace casing with a lever valve and regulator.
  pipe(yellowB, 0.028, [[pipeX, 4.86, -13.52], [9.36, 4.86, -13.52], [9.36, 1.25, -13.52], [9.36, 1.25, -13.2]], 0.1, 8);
  put(steelB, new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10), 9.36, 2.2, -13.52);
  box(redB, 0.2, 0.018, 0.03, 9.28, 2.2, -13.52);
  put(steelB, lathe([[0, 0], [0.06, 0.01], [0.075, 0.05], [0.06, 0.09], [0, 0.1]], 12), 9.36, 1.7, -13.52, 0, 0, PI / 2);
  put(brushedB, new THREE.CylinderGeometry(0.035, 0.035, 0.016, 12), 9.3, 1.75, -13.45, PI / 2, 0, 0);

  // ---- Floor marks: joints, drains, oil, tyres, hatching ----------------------
  instances(new THREE.BoxGeometry(18.9, 0.004, 0.022), new THREE.MeshStandardMaterial({ color: 0x0b0c0c, roughness: 0.9, metalness: 0 }), bayZ.map((z) => T(0, 0.0015, z - 3 + 0.02)), false, false);
  const DECALS = {
    oilA: [0, 0, 512, 512], tyre: [512, 0, 512, 512], hatch: [0, 512, 512, 512], drain: [512, 512, 256, 256], oilB: [768, 512, 256, 256], scuff: [512, 768, 512, 256],
    scorch: [1024, 0, 512, 512], soot: [1024, 512, 512, 512], wear: [1536, 0, 512, 1024],
  } as const;
  const decalSheet = track(canvasTexture(2048, 1024, (c) => {
    c.clearRect(0, 0, 2048, 1024);
    let seed = 2026;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const blot = (cx: number, cy: number, r: number, dark: number) => {
      for (let i = 0; i < 26; i += 1) {
        const a = next() * PI * 2, d = next() * r * 0.55, rr = r * (0.22 + next() * 0.4);
        const g = c.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr);
        g.addColorStop(0, `rgba(6,7,7,${dark * (0.25 + next() * 0.3)})`); g.addColorStop(0.7, `rgba(10,9,7,${dark * 0.16})`); g.addColorStop(1, "rgba(10,9,7,0)");
        c.fillStyle = g; c.beginPath(); c.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, PI * 2); c.fill();
      }
    };
    blot(256, 256, 230, 1); blot(210, 300, 110, 1.3);
    blot(896, 640, 116, 1.2);
    // Twin tyre tracks sweeping through a quarter turn.
    for (const r of [300, 430]) for (let pass = 0; pass < 5; pass += 1) {
      c.strokeStyle = `rgba(8,8,8,${0.1 + next() * 0.12})`; c.lineWidth = 26 - pass * 4; c.setLineDash([40 + next() * 160, 6 + next() * 30]);
      c.beginPath(); c.arc(512 + 20, 492, r + (next() - 0.5) * 6, PI * 0.02, PI * 0.5); c.stroke();
    }
    c.setLineDash([]);
    // Keep-clear hatching, worn through where the trucks turn.
    c.save(); c.beginPath(); c.rect(12, 524, 488, 488); c.clip();
    c.strokeStyle = "rgba(176,130,40,0.8)"; c.lineWidth = 16;
    for (let d = -512; d < 512; d += 62) { c.beginPath(); c.moveTo(d, 1024); c.lineTo(d + 512, 512); c.stroke(); }
    c.restore();
    c.strokeStyle = "rgba(176,130,40,0.85)"; c.lineWidth = 18; c.strokeRect(21, 533, 470, 470);
    c.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 2600; i += 1) { c.fillStyle = `rgba(0,0,0,${next() * 0.7})`; c.fillRect(next() * 512, 512 + next() * 512, 1 + next() * 9, 1 + next() * 3); }
    for (let i = 0; i < 14; i += 1) { const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, "rgba(0,0,0,0.8)"); g.addColorStop(1, "rgba(0,0,0,0)"); c.save(); c.translate(next() * 512, 512 + next() * 512); c.scale(30 + next() * 80, 14 + next() * 30); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, PI * 2); c.fill(); c.restore(); }
    c.globalCompositeOperation = "source-over";
    // Cast-iron gully grate.
    c.fillStyle = "#17191a"; c.fillRect(516, 516, 248, 248);
    c.fillStyle = "#2c3032"; c.fillRect(528, 528, 224, 224);
    c.fillStyle = "#050606";
    for (let x = 544; x < 740; x += 28) for (const y of [544, 648]) { c.beginPath(); c.roundRect(x, y, 14, 88, 7); c.fill(); }
    c.fillStyle = "#3a3f41"; for (const [x, y] of [[536, 536], [744, 536], [536, 744], [744, 744]]) { c.beginPath(); c.arc(x, y, 5, 0, PI * 2); c.fill(); }
    // Drag scuffs.
    for (let i = 0; i < 40; i += 1) { c.strokeStyle = `rgba(12,12,11,${0.08 + next() * 0.2})`; c.lineWidth = 1 + next() * 5; const y = 790 + next() * 210; c.beginPath(); c.moveTo(530 + next() * 120, y); c.lineTo(760 + next() * 250, y + (next() - 0.5) * 30); c.stroke(); }
    // Scorched ground in front of the furnace: burnt-in soot, slag spatter and a few pale ash flecks.
    {
      const burn = c.createRadialGradient(1280, 256, 20, 1280, 256, 250);
      burn.addColorStop(0, "rgba(8,7,6,0.74)"); burn.addColorStop(0.45, "rgba(14,11,8,0.46)"); burn.addColorStop(0.75, "rgba(40,28,18,0.14)"); burn.addColorStop(1, "rgba(40,28,18,0)");
      c.fillStyle = burn; c.fillRect(1024, 0, 512, 512);
      for (let i = 0; i < 260; i += 1) {
        const a = next() * PI * 2, d = Math.pow(next(), 0.6) * 232, r = 1 + next() * next() * 9;
        c.fillStyle = `rgba(${6 + next() * 20},${5 + next() * 12},${4 + next() * 8},${0.35 + next() * 0.5})`;
        c.beginPath(); c.ellipse(1280 + Math.cos(a) * d, 256 + Math.sin(a) * d, r, r * (0.5 + next() * 0.5), a, 0, PI * 2); c.fill();
      }
      for (let i = 0; i < 46; i += 1) {
        const a = next() * PI * 2, d = 40 + next() * 190;
        c.fillStyle = `rgba(${150 + next() * 60},${120 + next() * 40},${90 + next() * 30},${0.08 + next() * 0.14})`;
        c.beginPath(); c.arc(1280 + Math.cos(a) * d, 256 + Math.sin(a) * d, 1 + next() * 3, 0, PI * 2); c.fill();
      }
    }
    // Soot licking up a face from the heat below it: dense at the foot, torn into streaks higher up.
    {
      c.save(); c.beginPath(); c.rect(1024, 512, 512, 512); c.clip();
      const smoke = c.createLinearGradient(0, 1024, 0, 512);
      smoke.addColorStop(0, "rgba(5,4,4,0.88)"); smoke.addColorStop(0.3, "rgba(8,6,5,0.62)"); smoke.addColorStop(0.7, "rgba(12,9,7,0.24)"); smoke.addColorStop(1, "rgba(12,9,7,0)");
      c.fillStyle = smoke; c.fillRect(1024, 512, 512, 512);
      c.globalCompositeOperation = "destination-out";
      for (let i = 0; i < 90; i += 1) {
        const x = 1024 + next() * 512, top = 512 + next() * 300, w = 6 + next() * 40;
        const gap = c.createLinearGradient(0, top, 0, top + 200 + next() * 250);
        gap.addColorStop(0, `rgba(0,0,0,${0.5 + next() * 0.5})`); gap.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = gap; c.fillRect(x - w / 2, 512, w, 512);
      }
      for (const [from, to] of [[1024, 1104], [1536, 1456]]) {
        const side = c.createLinearGradient(from, 0, to, 0);
        side.addColorStop(0, "rgba(0,0,0,1)"); side.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = side; c.fillRect(Math.min(from, to), 512, 80, 512);
      }
      c.globalCompositeOperation = "source-over";
      c.restore();
    }
    // A walked and wheeled lane: fine dark rubbing along the run, gathered toward its middle, fading at both ends.
    c.lineCap = "round";
    for (let i = 0; i < 520; i += 1) {
      const across = (next() + next() + next()) / 3, x = 1566 + across * 452, from = 30 + next() * 880, length = 40 + next() * 260, to = Math.min(from + length, 1000);
      const fade = Math.sin(Math.min(1, (from + to) / 2048) * PI);
      c.strokeStyle = `rgba(${10 + next() * 14},${11 + next() * 12},${11 + next() * 10},${(0.05 + next() * 0.1) * (0.3 + fade * 0.7)})`;
      c.lineWidth = 2 + next() * 16;
      c.beginPath(); c.moveTo(x, from); c.bezierCurveTo(x + (next() - 0.5) * 16, from + length * 0.3, x + (next() - 0.5) * 16, from + length * 0.7, x + (next() - 0.5) * 22, to); c.stroke();
    }
    // Pale scratches where the sealer has gone and grit has been dragged along the run.
    for (let i = 0; i < 300; i += 1) {
      const across = (next() + next()) / 2, x = 1572 + across * 440, from = 60 + next() * 860, length = 14 + next() * 120;
      c.strokeStyle = `rgba(${150 + next() * 50},${158 + next() * 44},${150 + next() * 40},${0.05 + next() * 0.13})`;
      c.lineWidth = 0.8 + next() * 2.2;
      c.beginPath(); c.moveTo(x, from); c.lineTo(x + (next() - 0.5) * 10, Math.min(from + length, 996)); c.stroke();
    }
  }));
  decalSheet.anisotropy = anisotropy;
  const decalMaterial = new THREE.MeshStandardMaterial({ map: decalSheet, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.32, metalness: 0, envMapIntensity: 0.9 });
  // Soot and scorching are dry: the same sheet without the oily sheen.
  const matteDecal = decalMaterial.clone();
  matteDecal.roughness = 0.96;
  matteDecal.envMapIntensity = 0.25;
  const decalB = bag(decalMaterial), sootB = bag(matteDecal);
  /** A flat card showing one cell of the decal sheet, standing in the xy plane. */
  const decalCard = (name: keyof typeof DECALS, w: number, h: number) => {
    const [cx, cy, cw, ch] = DECALS[name];
    const geometry = new THREE.PlaneGeometry(w, h);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (cx + 2 + uv.getX(i) * (cw - 4)) / 2048, 1 - (cy + 2 + (1 - uv.getY(i)) * (ch - 4)) / 1024);
    return geometry;
  };
  let decalY = 0.004;
  const decal = (name: keyof typeof DECALS, w: number, d: number, x: number, z: number, yaw: number, y?: number, target = decalB) =>
    put(target, decalCard(name, w, d).rotateX(-PI / 2), x, y ?? (decalY += 0.0003), z, 0, yaw, 0);
  decal("hatch", doorHalf * 2, 1.9, -8.45, doorZ, PI / 2);
  decal("tyre", 4.6, 4.6, -6.2, 5.6, PI);
  decal("tyre", 4.2, 4.2, 6.4, 6.6, -PI / 2);
  decal("oilA", 1.7, 1.7, 7.9, 8.75, 0.6);
  decal("oilB", 0.9, 0.9, -8.5, 3.9, 1.1);
  decal("oilA", 1.3, 1.3, 8.6, -22.1, 2.2);
  decal("oilB", 1.1, 1.1, -8.6, -18.6, 0.3);
  decal("oilB", 0.8, 0.8, 8.5, -8.6, 2.6);
  decal("scuff", 2.6, 1.3, -7.9, -21.4, PI / 2);
  decal("scuff", 2.4, 1.2, 7.6, 4.9, 0.2);
  decal("scuff", 2.2, 1.1, 7.9, -17.4, PI / 2 + 0.1);
  for (const [x, z] of [[-9.0, 1.0], [9.0, -8.5], [-9.0, -17.0], [9.0, 4.2]]) decal("drain", 0.36, 0.36, x, z, 0);
  // Wear: the lane walked from the firing line to the stations and on to the control desk, and the run to the furnace.
  decal("wear", 2.6, 9.6, 0.05, 2.5, 0, undefined, sootB);
  decal("wear", 2.4, 11, -0.05, -17.5, PI, undefined, sootB);
  decal("wear", 2.2, 4.6, 4.5, -11.6, PI / 2, undefined, sootB);

  // Grit round the sacks: one speckle card, tinted per spill. Coke breeze, flux and moulding sand by the
  // hearth, trodden toward the furnace mouth, and what the staged sacks have shed past the workbench.
  const gritTexture = track(canvasTexture(512, 512, (c) => {
    c.clearRect(0, 0, 512, 512);
    let seed = 515;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // A thin drift of powder, thickest where it fell, with loose grains thrown out past its ragged edge.
    for (let i = 0; i < 46; i += 1) {
      const a = next() * PI * 2, d = Math.pow(next(), 1.4) * 120, x = 256 + Math.cos(a) * d, y = 256 + Math.sin(a) * d, r = 34 + next() * 70;
      const drift = c.createRadialGradient(x, y, 0, x, y, r);
      drift.addColorStop(0, `rgba(255,255,255,${0.1 + next() * 0.12})`); drift.addColorStop(0.6, "rgba(255,255,255,0.05)"); drift.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = drift; c.beginPath(); c.arc(x, y, r, 0, PI * 2); c.fill();
    }
    for (let i = 0; i < 9000; i += 1) {
      const a = next() * PI * 2, d = Math.pow(next(), 1.5) * 246 * (0.7 + 0.3 * Math.sin(a * 3 + 1)), r = 0.45 + next() * next() * 1.5;
      c.fillStyle = `rgba(255,255,255,${0.22 + next() * 0.5})`;
      c.beginPath(); c.arc(256 + Math.cos(a) * d, 256 + Math.sin(a) * d, r, 0, PI * 2); c.fill();
    }
  }));
  gritTexture.anisotropy = anisotropy;
  const gritMaterial = new THREE.MeshStandardMaterial({ map: gritTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 1, metalness: 0, envMapIntensity: 0.3 });
  const spills: Array<[number, number, number, number, number]> = [
    [8.46, -14.0, 1.05, 0.4, 0x151311], [8.6, -14.72, 0.95, 2.1, 0xd6d0c0], [8.5, -15.32, 1.15, 4.0, 0xb4955f],
    [8.1, -13.72, 0.8, 1.2, 0x1b1815], [7.95, -14.55, 0.7, 5.2, 0x8f7a54], [8.3, -19.05, 1.1, 0.9, 0xcbc4b2], [8.38, -20.0, 0.75, 3.3, 0xbdb5a2],
  ];
  const grit = instances(new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2), gritMaterial, spills.map(([x, z, size, yaw], index) => T(x, 0.0135 + index * 0.0004, z, 0, yaw, 0, [size, 1, size * 0.8])), false, false);
  spills.forEach((spill, index) => grit.setColorAt(index, new THREE.Color(spill[4])));
  grit.renderOrder = 1;

  // ---- Contact shadows: a soft dark edge under everything standing on the slab ---
  const contactTexture = track(canvasTexture(128, 128, (c) => {
    c.clearRect(0, 0, 128, 128);
    c.fillStyle = "rgba(0,0,0,0.058)";
    for (let i = 0; i < 24; i += 1) { const inset = 3 + i * 1.25; c.beginPath(); c.roundRect(inset, inset, 128 - inset * 2, 128 - inset * 2, Math.max(4, 26 - i * 0.7)); c.fill(); }
  }));
  const contactMaterial = new THREE.MeshBasicMaterial({ map: contactTexture, color: 0x000000, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, fog: false });
  const contactSpots: Transform[] = [];
  /** Footprint `w` by `d` metres: the card overhangs it so only its soft edge shows round the object. */
  const contact = (x: number, z: number, w: number, d: number, yaw = 0, y = 0.003) => contactSpots.push(T(x, y, z, 0, yaw, 0, [w * 1.45 + 0.14, 1, d * 1.45 + 0.14]));
  for (const [kind, items] of stock) {
    const [w, , d] = props.get(kind).size;
    for (const { position, rotation } of items) if (position[1] === 0 && rotation && rotation[0] === 0) contact(position[0], position[2], w, d, rotation[1]);
  }
  barriers.forEach(([x, z, yaw]) => contact(x, z, 2.44, 0.6, yaw));
  contact(9.06, 0.55, 0.3, 1.2);
  bayZ.forEach((z) => side2.forEach((s) => contact(s * 9.36, z, 0.6, 0.62)));
  contact(8.05, 8.9, 2.4, 1.15, 0.03);
  contact(-7.93, 9.42, 2.8, 0.5);
  contact(9.07, -16.9, 0.62, 2.4);
  contact(-9.07, -22.35, 0.5, 4);
  contact(9.15, 1.83, 0.34, 1.2);
  contact(-8.94, -19.5, 0.56, 1.3, 0.08);
  contact(8.72, -11.6, 0.8, 3.6, 0, 0.0155);
  contact(tankX, hoistZ, 1.6, 1.0);
  contact(soakX, hoistZ, 1.06, 1.06);
  // The foot of each side wall, the tape wall and the control desk.
  for (const s of side2) contactSpots.push(T(s * 9.77, 0.003, -9, 0, 0, 0, [1.2, 1, 100]));
  contactSpots.push(T(0, 0.003, 10.14, 0, 0, 0, [60, 1, 1.2]), T(0, 0.003, -24.9, 0, 0, 0, [34, 1, 1.5]));
  const contacts = instances(new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2), contactMaterial, contactSpots, false, false);
  contacts.renderOrder = 0.5;

  // ---- Furnace: lined firebox, lift door, burner and hearth ---------------------
  // The kit supplies the machine everyone shares (plinth, cap, flue, door frame, fire bars and the
  // fire itself). Here its solid body gives way to a steel casing round a brick-lined chamber, so the
  // fire burns at the back of a real cavity; everything sits inside the kit furnace's own outline.
  const casingB = bag(casingMaterial, 1.5, true), liningB = bag(fireBrick, 1.15, true);
  at(9.18, 0, -11.6, -PI / 2, () => {
    // Casing: two piers, a lintel and a sill, the infill plates set back a centimetre like bolted panels.
    for (const s of side2) rbox(casingB, 0.4, 3.5, 1.15, 0.025, s * 1.45, 1.75, 0);
    box(casingB, 2.52, 0.88, 1.138, 0, 3.06, -0.006);
    box(casingB, 2.52, 0.74, 1.138, 0, 0.37, -0.006);
    // Refractory lining: cheeks, crown, hearth and back wall, standing two centimetres proud of the frame.
    for (const s of side2) box(liningB, 0.15, 1.88, 0.89, s * 1.175, 1.68, 0.115);
    for (const y of [0.815, 2.545]) box(liningB, 2.2, 0.15, 0.89, 0, y, 0.115);
    box(liningB, 2.5, 1.88, 0.13, 0, 1.68, -0.395);
    // Sill plate the charge is raked over.
    box(darkHit, 2.3, 0.035, 0.35, 0, 0.885, 0.705);
    // Lift door hung clear of the mouth: slab with a hot brick lip, stiffeners, guides, sheaves and counterweights.
    rbox(casingB, 2.72, 1.2, 0.1, 0.015, 0, 3.02, 0.93);
    box(liningB, 2.5, 0.07, 0.085, 0, 2.39, 0.93);
    box(casingB, 3.2, 0.06, 0.04, 0, 3.22, 1.0);
    box(casingB, 2.72, 0.06, 0.04, 0, 3.5, 1.0);
    for (const s of side2) box(casingB, 0.07, 0.72, 0.014, s * 0.9, 2.82, 0.987);
    put(sootB, decalCard("soot", 2.66, 0.74), 0, 2.81, 0.985);
    for (const s of side2) {
      box(steelB, 0.07, 1.52, 0.098, s * 1.4, 2.86, 0.881);
      box(steelB, 0.03, 1.52, 0.045, s * 1.42, 2.86, 0.9525);
      box(steelB, 0.07, 1.56, 0.022, s * 1.4, 1.3, 0.842);
      put(steelB, new THREE.CylinderGeometry(0.135, 0.135, 0.045, 18), s * 1.54, 3.42, 0.81, 0, 0, PI / 2);
      put(darkB, new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), s * 1.54, 3.42, 0.81, 0, 0, PI / 2);
      for (const o of [-0.036, 0.036]) box(steelB, 0.012, 0.15, 0.3, s * 1.54 + o, 3.42, 0.715);
      rod(darkB, 0.011, [s * 1.54, 1.66, 0.675], [s * 1.54, 3.42, 0.675], 5);
      rod(darkB, 0.011, [s * 1.54, 3.27, 0.945], [s * 1.54, 3.42, 0.945], 5);
      box(darkB, 0.05, 0.07, 0.07, s * 1.54, 3.25, 0.965);
      for (let plate = 0; plate < 4; plate += 1) rbox(casingB, 0.15, 0.135, 0.13, 0.012, s * 1.54, 1.12 + plate * 0.145, 0.675);
      // Buckstays and a riveted seam on each flank.
      for (const z of [0.02, 0.4]) box(casingB, 0.05, 3.2, 0.1, s * 1.675, 1.85, z);
      box(casingB, 0.012, 0.09, 0.9, s * 1.656, 1.75, 0.12);
      for (let i = 0; i < 9; i += 1) put(casingB, new THREE.SphereGeometry(0.016, 6, 3, 0, PI * 2, 0, PI / 2), s * 1.662, 1.75, -0.28 + i * 0.1, 0, 0, -s * PI / 2);
      for (let i = 0; i < 13; i += 1) put(casingB, new THREE.SphereGeometry(0.016, 6, 3, 0, PI * 2, 0, PI / 2), s * 1.6, 0.42 + i * 0.235, 0.575, PI / 2, 0, 0);
    }
    for (let i = 0; i < 15; i += 1) put(casingB, new THREE.SphereGeometry(0.016, 6, 3, 0, PI * 2, 0, PI / 2), -1.12 + i * 0.16, 0.37, 0.563, PI / 2, 0, 0);
    // Burner block where the fuel line arrives, and a glowing sight port on the other flank.
    put(casingB, lathe([[0, 0], [0.13, 0], [0.13, 0.03], [0.095, 0.03], [0.095, 0.2], [0.06, 0.24], [0, 0.24]], 14), -1.65, 1.25, -0.18, 0, 0, PI / 2);
    put(steelB, new THREE.CylinderGeometry(0.075, 0.075, 0.04, 14), 1.67, 1.55, 0.2, 0, 0, PI / 2);
    put(orangeLedB, new THREE.CylinderGeometry(0.045, 0.045, 0.012, 12), 1.692, 1.55, 0.2, 0, 0, PI / 2);
  });
  // Chequer-plate hearth apron in two sheets, scorched where the door opens onto it.
  for (const o of [-0.9025, 0.9025]) box(plateB, 2.2, 0.012, 1.795, 7.47, 0.006, -11.6 + o);
  decal("scorch", 2.7, 2.9, 7.55, -11.6, 0, 0.017, sootB);

  // ---- Heat treatment line: soak box, quench tank and the hoist that works between them ----
  // A basket of blanks soaks in the box by the furnace. Every minute or so the monorail hoist lifts it
  // out glowing, runs it across the hall, dips it in the quench tank in a cloud of steam and brings it
  // back. What travels is built as meshes of its own: walk-through, clear of heads, out of the floor
  // plan, and without a sun shadow (the line runs between the roof lights, and the sun map is frozen).
  at(soakX, 0, hoistZ, 0, () => {
    box(darkHit, 1.06, 0.05, 1.06, 0, 0.025, 0);
    for (const s of side2) {
      // Steel casing, a firebrick lining standing two centimetres proud of it, corner angles and a band.
      box(casingB, 0.016, 0.9, 0.98, s * 0.482, 0.5, 0);
      box(casingB, 0.948, 0.9, 0.016, 0, 0.5, s * 0.482);
      box(liningB, 0.1, 0.9, 0.948, s * 0.424, 0.52, 0);
      box(liningB, 0.748, 0.9, 0.1, 0, 0.52, s * 0.424);
      for (const o of side2) box(casingB, 0.05, 0.94, 0.05, s * 0.5, 0.52, o * 0.5);
      box(casingB, 0.012, 0.06, 1, s * 0.496, 0.62, 0);
      box(casingB, 1, 0.06, 0.012, 0, 0.62, s * 0.496);
    }
    // The hearth the basket stands on.
    box(liningB, 0.748, 0.03, 0.748, 0, 0.47, 0);
    // Burner block and its hose.
    put(casingB, lathe([[0, 0], [0.09, 0], [0.09, 0.03], [0.065, 0.03], [0.065, 0.16], [0.04, 0.19], [0, 0.19]], 12), 0.49, 0.3, 0.18, 0, 0, -PI / 2);
    pipe(rubberB, 0.014, [[0.66, 0.3, 0.18], [0.84, 0.3, 0.18], [0.84, 0.02, 0.32]], 0.08, 6);
  });
  // The heat inside the box is painted on: white-orange at the hearth, dying up the walls.
  const soakGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
  {
    const faces = [0, 1, 2, 3].map((k) => new THREE.PlaneGeometry(0.736, 0.48, 1, 6).translate(0, 0.73, -0.368).rotateY(k * PI / 2));
    faces.push(new THREE.PlaneGeometry(0.736, 0.736).rotateX(-PI / 2).translate(0, 0.49, 0));
    const lining = mergeGeometries(faces);
    faces.forEach((face) => face.dispose());
    const position = lining.attributes.position, colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      const glow = Math.pow(1 - THREE.MathUtils.clamp((position.getY(i) - 0.49) / 0.47, 0, 1), 1.7);
      colors[i * 3] = 0.05 + 1.7 * glow; colors[i * 3 + 1] = 0.006 + 0.36 * glow * glow; colors[i * 3 + 2] = 0.03 * glow * glow;
    }
    lining.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const liner = new THREE.Mesh(lining, soakGlow);
    liner.position.set(soakX, 0, hoistZ);
    liner.userData.walkThrough = true;
    scene.add(liner);
  }
  at(tankX, 0, hoistZ, 0, () => {
    // Welded plate tank on skids: stiffened sides, a painted rim, an overflow and a drain cock.
    for (const s of side2) {
      box(darkHit, 1.6, 0.1, 0.12, 0, 0.05, s * 0.3);
      box(machineB, 0.03, 0.82, 1, s * 0.735, 0.54, 0);
      box(machineB, 1.44, 0.82, 0.03, 0, 0.54, s * 0.485);
      box(yellowB, 1.58, 0.04, 0.07, 0, 0.97, s * 0.485);
      box(yellowB, 0.07, 0.04, 0.9, s * 0.755, 0.97, 0);
      for (const x of [-0.4, 0, 0.4]) box(machineB, 0.04, 0.7, 0.025, x, 0.52, s * 0.5125);
    }
    box(machineB, 1.5, 0.03, 1, 0, 0.115, 0);
    box(machineB, 1.44, 0.02, 0.94, 0, 0.77, 0);
    pipe(brushedB, 0.022, [[0.75, 0.84, -0.3], [0.9, 0.84, -0.3], [0.9, 0.03, -0.3]], 0.07, 8);
    put(steelB, new THREE.CylinderGeometry(0.028, 0.028, 0.14, 8), -0.82, 0.24, 0.22, 0, 0, PI / 2);
    handwheel(-0.86, 0.33, 0.22, 0.055);
  });
  // The quench water: black and oily, never quite still, with a line of scum along the plates. When the charge
  // goes in, the middle of it boils white, glows for a moment with the steel under it and throws a ring at the walls.
  const quenchClock = { value: 0 }, quenchRings = { value: [new THREE.Vector4(tankX, hoistZ, -100, 0)] };
  const quenchWater = track(waterMaterial({
    time: quenchClock, key: "foundry-quench", lean: !high,
    uniforms: { quenchBoil: { type: "float", value: 0 }, quenchGlow: { type: "float", value: 0 } },
    field: /* glsl */`
      void wField(vec2 p, float t, out float depth, out float shore, out vec2 flow, out float churn) {
        vec2 from = p - vec2(${tankX.toFixed(3)}, ${hoistZ.toFixed(3)});
        shore = max(min(0.72 - abs(from.x), 0.47 - abs(from.y)), 0.0);
        depth = 0.62;
        float r = length(from) + 0.001;
        flow = (from / r) * 0.1 * quenchBoil * exp(-r / 0.35);
        churn = quenchBoil * exp(-pow(r / 0.34, 2.0)) * (0.3 + 0.8 * wNoise(p * 7.0 + vec2(t * 2.3, -t * 1.9)));
      }
    `,
    finish: /* glsl */`
      vec2 hot = p - vec2(${tankX.toFixed(3)}, ${hoistZ.toFixed(3)});
      totalEmissiveRadiance += vec3(1.0, 0.24, 0.03) * quenchGlow * quenchGlow * 2.2 * exp(-dot(hot, hot) / 0.07) * (1.0 - foam * 0.6);
    `,
    steep: 0, ripple: 0.03, rippleSize: 0.16, lap: 0.02, flowRipple: 0.09,
    deep: 0x070d0b, bed: 0x161816, bedGrain: 0.2, clarity: 0.45, caustics: 0,
    foam: 0x383d3b, foamSize: 0.03, shoreReach: 0.04, shoreFoam: 0.3, driftFoam: 0.22,
    rings: quenchRings, roughness: 0.05, envMapIntensity: 1.6,
  }));
  const quenchSurface = new THREE.Mesh(track(new THREE.PlaneGeometry(1.44, 0.94).rotateX(-PI / 2)), quenchWater);
  quenchSurface.position.set(tankX, 0.8, hoistZ);
  quenchSurface.userData.walkThrough = true;
  scene.add(quenchSurface);
  kit.mirrorHidden.push(quenchSurface);
  decal("oilA", 2.5, 2.1, tankX + 0.2, hoistZ + 0.1, 0.5);
  decal("scorch", 2, 2, soakX, hoistZ, 0.9, undefined, sootB);

  // Case-hardening colours for the blanks: what the quench leaves on the steel.
  const caseColours = track(canvasTexture(128, 128, (c) => {
    c.fillStyle = "#5d6468"; c.fillRect(0, 0, 128, 128);
    let seed = 661;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 70; i += 1) {
      const x = next() * 128, y = next() * 128, r = 8 + next() * 26, [red, green, blue] = [[34, 70, 150], [70, 48, 128], [168, 124, 48], [28, 96, 122]][i % 4];
      const blot = c.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, `rgba(${red},${green},${blue},0.85)`); blot.addColorStop(1, `rgba(${red},${green},${blue},0)`);
      c.fillStyle = blot; c.beginPath(); c.arc(x, y, r, 0, PI * 2); c.fill();
    }
  }));
  const chargeMaterial = new THREE.MeshStandardMaterial({ map: caseColours, roughness: 0.42, metalness: 0.85, emissive: new THREE.Color(1, 0.3, 0.047), emissiveIntensity: 2.3, envMapIntensity: 1.2 });
  // Hook heights (the eye of the block): carrying, set down on the hearth of the box, and under water in the tank. The chain pays out from the drum.
  const HOOK_HIGH = 3.6, BOX_LOW = 1.72, TANK_LOW = 1.4, DRUM_Y = 4.88;
  /** Travelling steel that a bullet rings off without leaving a hole hanging in the air. */
  const moving = new Set<THREE.Object3D>();
  const trolley = new THREE.Group(), hookBlock = new THREE.Group(), pendant = new THREE.Group();
  trolley.name = "foundry-hoist";
  {
    const yellow = loose(yellowPaint, 1.2), dark = loose(darkMetal, 1.2), steel = loose(structural, 1.4), plates = loose(sheetMaterial);
    for (const o of [-0.1, 0.1]) { box(yellow, 0.34, 0.3, 0.014, 0, 5.3, o); for (const x of [-0.11, 0.11]) put(dark, new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), x, 5.39, o * 0.6, PI / 2, 0, 0); }
    rbox(yellow, 0.52, 0.3, 0.34, 0.04, 0, 5.02, 0);
    put(dark, new THREE.CylinderGeometry(0.11, 0.11, 0.24, 14), 0.37, 5.02, 0, 0, 0, PI / 2);
    put(steel, new THREE.CylinderGeometry(0.09, 0.09, 0.14, 14), -0.33, 5.02, 0, 0, 0, PI / 2);
    sign("hoist", 0.44, 0.11, 0, 5.02, 0.172, 0, false, plates);
    sign("hoist", 0.44, 0.11, 0, 5.02, -0.172, PI, false, plates);
    assemble(trolley, [yellow, dark, steel, plates], true).children.forEach((mesh) => moving.add(mesh));
  }
  {
    // Bottom block and hook, hung from the eye at the group's origin so the load swings about it.
    const yellow = loose(yellowPaint, 1.2), steel = loose(structural, 1.4), charge = loose(chargeMaterial);
    rbox(yellow, 0.2, 0.26, 0.11, 0.03, 0, -0.1, 0);
    put(steel, new THREE.CylinderGeometry(0.075, 0.075, 0.03, 14), 0, -0.09, 0.062, PI / 2, 0, 0);
    rod(steel, 0.018, [0, -0.22, 0], [0, -0.32, 0], 6);
    put(steel, new THREE.TorusGeometry(0.065, 0.02, 7, 14, PI * 1.45), 0, -0.38, 0, 0, 0, PI * 0.95);
    // The charge: a bail on the hook, a square basket with a plate floor, and two rows of blanks standing in it.
    const top = -0.76, bottom = -1.2, half = 0.22;
    put(charge, new THREE.TorusGeometry(0.05, 0.011, 6, 12), 0, -0.475, 0, 0, PI / 2, 0);
    for (const s of side2) rod(charge, 0.011, [0, -0.52, 0], [s * half, top, 0], 6);
    for (const y of [top, bottom]) for (const s of side2) { box(charge, 0.44, 0.02, 0.02, 0, y, s * half); box(charge, 0.02, 0.02, 0.42, s * half, y, 0); }
    for (const sx of side2) for (const sz of side2) box(charge, 0.02, 0.42, 0.02, sx * half, (top + bottom) / 2, sz * half);
    box(charge, 0.42, 0.008, 0.42, 0, bottom + 0.016, 0);
    for (let i = 0; i < 7; i += 1) for (const row of [-0.09, 0.09]) {
      const tall = 0.28 + ((i * 3 + (row > 0 ? 1 : 0)) % 4) * 0.025;
      box(charge, 0.006, tall, 0.05, -0.159 + i * 0.053, bottom + 0.022 + tall / 2, row, 0, (i % 3 - 1) * 0.25, i % 2 ? 0.1 : -0.08);
    }
    assemble(hookBlock, [yellow, steel, charge], true);
  }
  {
    // Pendant control on its own cable, hung from the trolley.
    const rubber = loose(cableMaterial), yellow = loose(yellowPaint, 1.2);
    put(rubber, new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.3, -0.58, 0.04), new THREE.Vector3(0.42, -1.48, 0.02), new THREE.Vector3(0.42, -2.16, 0.02)]), 20, 0.011, 6, false), 0, 0, 0);
    rbox(yellow, 0.08, 0.26, 0.06, 0.015, 0.42, -2.28, 0.02);
    assemble(pendant, [rubber, yellow], true);
  }
  // Load chain (two falls that stretch as the hook goes down) and a warning beacon under the body.
  const fall = new THREE.Mesh(mergeGeometries([-0.025, 0.025].map((o) => new THREE.CylinderGeometry(0.008, 0.008, 1, 5).translate(o, -0.5, 0))), darkMetal);
  fall.position.y = DRUM_Y;
  const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.04, 0.07, 10), beaconMaterial);
  beacon.position.set(-0.19, 4.832, 0);
  fall.userData.walkThrough = beacon.userData.walkThrough = true;
  hookBlock.position.y = BOX_LOW;
  pendant.position.set(0.2, DRUM_Y, 0.1);
  trolley.position.set(soakX, 0, hoistZ);
  trolley.add(fall, beacon, hookBlock, pendant);
  scene.add(trolley);
  const loadSwing = life.sway(hookBlock, { amplitude: 0.3, period: 2.2, damping: 0.1 });
  const pendantSwing = life.sway(pendant, { amplitude: 0.3, period: 3, damping: 0.06 });
  // The steam is the life kit's plume, standing over the tank all the time and let out only for a quench.
  const STEAM = 0.55;
  const quenchSteam = life.plume("steam", [tankX, 0.95, hoistZ], { rise: 3.3, size: [0.6, 2.4], life: 3.2, density: 18, color: 0x7c8589, opacity: STEAM, lean: 7 }) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  const steamLook = quenchSteam.material?.uniforms?.plumeLook?.value as THREE.Vector4 | undefined;
  quenchSteam.visible = false;
  life.drift("embers", { volume: { x: [soakX - 0.3, soakX + 0.3], y: [0.95, 3.1], z: [hoistZ - 0.3, hoistZ + 0.3] }, count: 26 });

  // One run, in seconds from its start: what is heard, and when.
  const hoistAt = new THREE.Vector3(), tankAt = new THREE.Vector3(tankX, 1, hoistZ), soakAt = new THREE.Vector3(soakX, 1, hoistZ), hoistVoice = { gain: 1, pitch: 1 };
  let tune = 1;
  const hoistSay = (name: "alarmBlip" | "craneMotor" | "chainRattle", gain: number, pitch: number) => {
    hoistVoice.gain = gain; hoistVoice.pitch = pitch * tune;
    cue?.(name, hoistAt.set(trolley.position.x, 4.6, hoistZ), hoistVoice);
  };
  /** The load lags a trolley that starts and runs on past one that stops: `push` is +1 towards +x. */
  const swing = (push: number) => { loadSwing.kick(0.42 * push, 1, 0); pendantSwing.kick(0.3 * push, 1, 0); };
  const QUENCH = 16.15, RUN = 37.4;
  const marks: Array<[number, () => void]> = [
    [0, () => hoistSay("alarmBlip", 0.9, 1)],
    [1.1, () => hoistSay("craneMotor", 0.8, 1.16)],
    [5.2, () => { hoistSay("craneMotor", 1, 0.94); swing(1); }],
    [8.6, () => hoistSay("craneMotor", 1, 0.98)],
    [12.7, () => { hoistSay("chainRattle", 0.8, 1); swing(-1); }],
    [13.7, () => hoistSay("craneMotor", 0.8, 1.16)],
    [QUENCH, () => { hoistVoice.gain = 1.2; hoistVoice.pitch = 0.95 + Math.random() * 0.15; cue?.("quenchHiss", tankAt, hoistVoice); quenchRings.value[0].set(tankX, hoistZ, quenchClock.value, 0.55); }],
    [20.5, () => hoistSay("craneMotor", 0.8, 1.16)],
    [24.6, () => { hoistSay("craneMotor", 1, 0.94); swing(-1); }],
    [28, () => hoistSay("craneMotor", 1, 0.98)],
    [32.1, () => { hoistSay("chainRattle", 0.6, 1.08); swing(1); }],
    [33.1, () => hoistSay("craneMotor", 0.8, 1.16)],
    [36.7, () => { hoistVoice.gain = 0.5; hoistVoice.pitch = 0.8; cue?.("hammerClank", soakAt, hoistVoice); }],
  ];
  const eased = (t: number, from: number, to: number) => { const k = THREE.MathUtils.clamp((t - from) / (to - from), 0, 1); return k * k * (3 - 2 * k); };
  let runAt = -1, nextRun = -1, mark = 0, heat = 1, steam = 0, lastSeconds = -1, present = false, quenchFrom = -1;
  kit.updates.push((now) => {
    const seconds = now / 1000, dt = lastSeconds < 0 ? 0 : THREE.MathUtils.clamp(seconds - lastSeconds, 0, 0.1);
    lastSeconds = seconds;
    if (quenchFrom < 0) quenchFrom = seconds;
    quenchClock.value = seconds - quenchFrom;
    if (nextRun < 0) nextRun = seconds + 5;
    // Whoever has just taken the pointer sees a run within seconds, not a minute later.
    const locked = typeof document !== "undefined" && document.pointerLockElement === kit.renderer.domElement;
    if (locked && !present && runAt < 0 && nextRun - seconds > 6) nextRun = seconds + 4 + Math.random() * 2;
    present = locked;
    if (runAt < 0 && seconds >= nextRun) { runAt = seconds; mark = 0; tune = 0.96 + Math.random() * 0.08; }
    let t = runAt < 0 ? -1 : seconds - runAt;
    if (t >= RUN) { runAt = -1; t = -1; nextRun = seconds + 28 + Math.random() * 22; }
    while (t >= 0 && mark < marks.length && t >= marks[mark][0]) { marks[mark][1](); mark += 1; }
    // Lift, across, dip, lift, back, set down.
    const across = t < 0 ? 0 : eased(t, 5.5, 12.9) - eased(t, 24.9, 32.3);
    const lifted = t < 0 ? 0 : eased(t, 1.5, 4.9) - eased(t, 13.9, 17.3) + eased(t, 20.9, 24.3) - eased(t, 33.3, 36.7);
    trolley.position.x = soakX + (tankX - soakX) * across;
    const low = across > 0.5 ? TANK_LOW : BOX_LOW;
    hookBlock.position.y = low + (HOOK_HIGH - low) * lifted;
    fall.scale.y = DRUM_Y - hookBlock.position.y;
    // The charge leaves the box bright orange, dulls a little in the air, goes black in the tank and heats again in the box.
    heat = t >= QUENCH ? Math.max(0, heat - dt * 1.5) : t >= 1.5 ? Math.max(0.62, heat - dt * 0.028) : Math.min(1, heat + dt * 0.1);
    chargeMaterial.emissive.setRGB(1, 0.1 + 0.2 * heat, 0.012 + 0.035 * heat);
    chargeMaterial.emissiveIntensity = 2.3 * heat * heat;
    steam = t >= QUENCH && t < QUENCH + 3.5 ? Math.min(1, steam + dt * 3) : Math.max(0, steam - dt * 0.4);
    quenchSteam.visible = steam > 0.01;
    quenchWater.userData.water.quenchBoil.value = steam;
    quenchWater.userData.water.quenchGlow.value = t >= QUENCH ? heat : 0;
    if (steamLook) steamLook.z = STEAM * steam;
    const flash = t < 0 ? 0.02 : Math.sin(seconds * 10) > 0.1 ? 1 : 0.06;
    beaconMaterial.color.setRGB(5 * flash, 2 * flash, 0.2 * flash);
    soakGlow.color.setScalar(0.86 + Math.sin(seconds * 1.9) * 0.09 + Math.sin(seconds * 5.3 + 1) * 0.05);
  });

  // ---- Fans ---------------------------------------------------------------------------------
  // Two big slow ceiling fans stir the air over the lanes, and beside each a roof extractor turns in
  // its curb with the sky behind it. Only the rotors move.
  const spinners: Array<{ rotor: THREE.Mesh; speed: number }> = [];
  const spinner = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, speed: number) => {
    const rotor = new THREE.Mesh(geometry, material);
    rotor.position.set(x, y, z);
    rotor.receiveShadow = true;
    rotor.userData.walkThrough = true;
    scene.add(rotor);
    shootable.push(rotor);
    moving.add(rotor);
    spinners.push({ rotor, speed });
  };
  const sweep = projectUv(mergeGeometries([
    new THREE.CylinderGeometry(0.17, 0.17, 0.12, 18),
    ...Array.from({ length: 5 }, (_, k) => mergeGeometries([new THREE.BoxGeometry(1.36, 0.014, 0.21).translate(0.83, 0, 0), new THREE.BoxGeometry(0.018, 0.1, 0.2).translate(1.515, 0.045, 0)]).rotateX(0.13).rotateY(k * PI * 2 / 5)),
  ]), 1.5);
  for (const [x, z, speed] of [[-2.6, -1.4, 3.1], [2.6, -6.6, -2.6]]) {
    rod(brushedB, 0.03, [x, 5.68, z], [x, 6.25, z], 8);
    put(darkB, new THREE.CylinderGeometry(0.12, 0.15, 0.2, 16), x, 5.6, z);
    for (let k = 0; k < 3; k += 1) rod(darkB, 0.004, [x, 5.72, z], [x + Math.cos(k * 2.1 + 0.5) * 0.7, 6.25, z + Math.sin(k * 2.1 + 0.5) * 0.7], 4);
    spinner(sweep, ductMaterial, x, 5.45, z, speed);
  }
  const daylight = bag(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.6, 0.95).multiplyScalar(1.25), toneMapped: false }));
  const impeller = mergeGeometries([
    new THREE.CylinderGeometry(0.09, 0.09, 0.09, 12),
    ...Array.from({ length: 6 }, (_, k) => new THREE.BoxGeometry(0.43, 0.012, 0.2).translate(0.3, 0, 0).rotateX(0.4).rotateY(k * PI / 3)),
  ]);
  for (const [x, z, speed] of [[2.6, -1.4, 6.4], [-2.6, -6.6, -5.6]]) {
    // Built hanging from the deck (local +z is down): curb plate, cowl, the sky, motor on its struts, wire guard.
    base.makeRotationX(PI / 2).setPosition(x, 6.25, z);
    box(steelB, 1.36, 1.36, 0.03, 0, 0, 0.015);
    put(steelB, lathe([[0.56, 0], [0.62, 0], [0.62, 0.16], [0.56, 0.16], [0.56, 0]], 28), 0, 0, 0.03, PI / 2, 0, 0);
    put(daylight, new THREE.CircleGeometry(0.56, 28), 0, 0, 0.045);
    put(darkB, new THREE.CylinderGeometry(0.1, 0.1, 0.1, 12), 0, 0, 0.085, PI / 2, 0, 0);
    for (let k = 0; k < 3; k += 1) box(darkB, 1.13, 0.03, 0.02, 0, 0, 0.06 + k * 0.001, 0, 0, k * PI / 3);
    for (const r of [0.2, 0.38, 0.55]) put(darkB, new THREE.TorusGeometry(r, 0.006, 4, 28), 0, 0, 0.196);
    for (let k = 0; k < 4; k += 1) box(darkB, 1.12, 0.008, 0.008, 0, 0, 0.196 + k * 0.0006, 0, 0, k * PI / 4);
    base.identity();
    spinner(impeller, darkMetal, x, 6.115, z, speed);
  }
  kit.updates.push((now) => {
    for (let i = 0; i < spinners.length; i += 1) spinners[i].rotor.rotation.y = (now / 1000 * spinners[i].speed) % (PI * 2);
  });

  // ---- Pendant lamps on long chains over the near lanes: they swing in the draught, further when shot, and their light swings with them ----
  const pendantGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.6, 0.27).multiplyScalar(1.5), toneMapped: false });
  const pendantPool = new THREE.MeshBasicMaterial({ map: poolTexture, color: new THREE.Color(1, 0.52, 0.2).multiplyScalar(0.28), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const PENDANT_TOP = 6.25, PENDANT_DROP = 2.55, pendantZ = -2;
  const pendants = [-5.9, 5.9].map((x) => {
    const spun = loose(ductMaterial, 1.5), lit = loose(pendantGlow);
    rod(spun, 0.011, [0, 0, 0], [0, -PENDANT_DROP + 0.05, 0], 5);
    // A spun aluminium shade, the reflector and the bulb alight inside.
    put(spun, lathe([[0.3, -0.21], [0.29, -0.19], [0.07, -0.04], [0.04, 0.04], [0, 0.05]], 20), 0, -PENDANT_DROP, 0);
    put(lit, lathe([[0, -0.03], [0.065, -0.045], [0.285, -0.195], [0.3, -0.21]], 20), 0, -PENDANT_DROP, 0);
    put(lit, new THREE.SphereGeometry(0.05, 10, 8), 0, -PENDANT_DROP - 0.2, 0);
    const lamp = assemble(new THREE.Group(), [spun, lit], true);
    lamp.position.set(x, PENDANT_TOP, pendantZ);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4).rotateX(-PI / 2), pendantPool);
    pool.position.set(x, 0.021, pendantZ);
    pool.renderOrder = 1;
    pool.userData.walkThrough = true;
    scene.add(lamp, pool);
    life.sway(lamp, { amplitude: 0.6, period: 3.2, damping: 0.05, creak: "chainRattle" });
    return { lamp, pool, x };
  });
  kit.updates.push(() => {
    // Where each lamp points is where its light falls.
    for (let i = 0; i < pendants.length; i += 1) {
      const { lamp, pool, x } = pendants[i];
      pool.position.x = x + PENDANT_TOP * Math.tan(lamp.rotation.z);
      pool.position.z = pendantZ - PENDANT_TOP * Math.tan(lamp.rotation.x);
    }
  });

  // ---- The broken roof light drips: last night's rain off the glazing bar, the puddle it keeps wet and its rings ----
  const dripX = -2.85, dripZ = BROKEN_LIGHT + 1.35, dripTop = 6.2, dripFall = Math.sqrt((dripTop - 0.04) / 4.9);
  decal("oilB", 1.5, 1.5, dripX + 0.05, dripZ - 0.05, 2.1);
  const drop = new THREE.Mesh(new THREE.SphereGeometry(0.011, 6, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.62, 0.86, 0.84), toneMapped: false }));
  const ripple = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9).rotateX(-PI / 2), new THREE.ShaderMaterial({
    vertexShader: FIRE_SHADER.vertexShader, fragmentShader: RIPPLE_FRAGMENT, uniforms: { age: { value: 9 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  }));
  ripple.position.set(dripX, 0.022, dripZ);
  ripple.renderOrder = 2;
  drop.userData.walkThrough = ripple.userData.walkThrough = true;
  scene.add(drop, ripple);
  kit.mirrorHidden.push(drop, ripple);
  kit.probeHidden.push(drop, ripple);
  const dripAt = new THREE.Vector3(dripX, 0.05, dripZ), dripVoice = { gain: 0.8, pitch: 1 };
  let dripFrom = -1, dripWait = 1.6, landed = -9;
  kit.updates.push((now) => {
    const seconds = now / 1000;
    if (dripFrom < 0) dripFrom = seconds;
    const t = seconds - dripFrom;
    if (t < dripWait) {
      // Swelling on the bar.
      const swell = t / dripWait;
      drop.position.set(dripX, dripTop - 0.012 * swell, dripZ);
      drop.scale.setScalar(0.35 + 0.65 * swell);
    } else if (t < dripWait + dripFall) {
      const fallen = t - dripWait;
      drop.position.y = dripTop - 0.012 - 4.9 * fallen * fallen;
      drop.scale.set(0.8, 2, 0.8);
    } else {
      landed = seconds;
      dripFrom = seconds;
      dripWait = 1.3 + Math.random() * 1.9;
      dripVoice.gain = 0.6 + Math.random() * 0.3; dripVoice.pitch = 0.85 + Math.random() * 0.4;
      cue?.("drip", dripAt, dripVoice);
    }
    ripple.material.uniforms.age.value = seconds - landed;
  });

  // ---- Someone is welding behind the pattern-shop door: arc light leaks round the leaf and spills under it across the floor ----
  const arcLight = new THREE.MeshBasicMaterial({ map: poolTexture, color: new THREE.Color(0.5, 0.72, 1).multiplyScalar(1.1), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  {
    // The gaps at the foot and the jambs take the middle of the soft disc, so they burn at full strength.
    const leaks = [new THREE.BoxGeometry(0.012, 0.012, 1.6).translate(0.075, -0.008, 0), ...side2.map((s) => new THREE.BoxGeometry(0.012, 2.66, 0.02).translate(0.075, 1.33, s * 0.875))];
    for (const leak of leaks) for (let i = 0; i < leak.attributes.uv.count; i += 1) leak.attributes.uv.setXY(i, 0.5, 0.5);
    const spill = new THREE.Mesh(mergeGeometries([new THREE.PlaneGeometry(4.4, 3.6).rotateX(-PI / 2), ...leaks]), arcLight);
    spill.name = "foundry-arc";
    spill.position.set(9.4, 0.02, -6.2);
    spill.renderOrder = 2;
    spill.userData.walkThrough = true;
    scene.add(spill);
    kit.probeHidden.push(spill);
    kit.mirrorHidden.push(spill);
    life.flicker(arcLight, "arc", { at: [9.9, 1.1, -6.2], rate: 0.8 });
  }

  // ---- Life: pigeons in the roof, dust in the shafts, smoke under the glass, a weeping steam joint ----
  // The pigeons come in through the broken pane for the warmth. They want open air over their heads to
  // get up in, so they keep to the entrance end: the patch of sun on the floor under the first roof
  // light and the tops of the two barriers either side of the apron. When they are put up they
  // wheel over the apron between the door and the first stations, under the fans and clear of the
  // station frames; one that is lost is replaced by another dropping in through the missing pane.
  life.birds("pigeon", {
    perches: [
      [-3.6, 0, 4.4], [-4.3, 0, 5], [-2.6, 0, 3.5], [-4.9, 0, 4.1],
      { from: [-7.4, 1.058, 5.036], to: [-6.5, 1.058, 4.964] },
      { from: [6.05, 1.058, -0.036], to: [6.95, 1.058, 0.036] },
    ],
    count: 5,
    roam: { x: [-4.4, 4.4], y: [4.15, 4.3], z: [-2.2, 5.2] },
    from: [-2.875, 6.25, BROKEN_LIGHT + 1.29],
  });
  for (const z of SKYLIGHTS) life.drift("motes", { volume: { x: [-5.3, 3.3], y: [0.3, 6], z: [z - 1.5, z + 4.3] }, count: 110, scale: 1.5 });
  life.plume("smoke", SKYLIGHTS.flatMap((z) => [[-1.9, 4.1, z + 1.3], [1.3, 4.3, z + 0.5]] as Array<[number, number, number]>), { rise: 1.2, size: [1, 2.8], life: 11, density: 8, color: 0x8a8782, opacity: 0.42, lean: 9 });
  // A flanged joint on the lagged steam main lets go every so often, clear of the gallery where the hall can see it.
  const leakZ = 5.6;
  for (const o of [-0.016, 0.016]) put(steelB, new THREE.CylinderGeometry(0.115, 0.115, 0.024, 14), pipeX, 5.07, leakZ + o, PI / 2, 0, 0);
  life.plume("steam", [pipeX - 0.09, 5.12, leakZ], { rise: 1.7, size: [0.1, 1.1], life: 1.9, density: 16, color: 0x8b9498, opacity: 0.9, lean: 0.8, burst: { every: 16, length: 1.6 } });

  // ---- Beyond the roof lights -----------------------------------------------------
  // What the glazing looks out on: the furnace stack climbing past the roof, a taller bay either
  // side, the melting shop beyond the control end and a water tower behind the tape wall. Real
  // geometry, lit by the same sun, with a painted sky fill because the room's light probe is
  // an interior. None of it casts into the hall.
  const skyFill = new THREE.Color(0.44, 0.58, 0.8);
  const outdoorMaterials = new Set<THREE.Material>();
  const outdoor = (source: THREE.MeshStandardMaterial, tint: THREE.Color, fill: number) => {
    const copy = source.clone();
    copy.color = tint;
    copy.emissive = skyFill.clone();
    copy.emissiveMap = source.map;
    copy.emissiveIntensity = fill;
    copy.envMapIntensity = 0;
    // The hall's fog is indoor murk; distance outside is carried by the tints instead.
    copy.fog = false;
    outdoorMaterials.add(copy);
    return copy;
  };
  const yardSheet = bag(outdoor(claddingMaterial, new THREE.Color(0.86, 0.94, 1), 0.2), 2.4);
  const yardSteel = bag(outdoor(rustMaterial, new THREE.Color(0.4, 0.38, 0.38), 0.14), 2.5);
  const yardPaint = bag(outdoor(greenPaint, new THREE.Color(0.82, 0.95, 1), 0.2), 3);
  const yardHaze = bag(outdoor(concrete, new THREE.Color(0.6, 0.69, 0.8), 0.36), 4);
  const yardGlassMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.31, 0.46), fog: false });
  outdoorMaterials.add(yardGlassMaterial);
  const yardGlass = bag(yardGlassMaterial);
  {
    // Furnace stack: flashing skirt, stiffening bands, a maintenance ring and a rain cowl.
    const stackX = 9.28, stackZ = -12.65;
    put(yardSteel, new THREE.CylinderGeometry(0.3, 0.3, 9.9, 18, 1, true), stackX, 11.38, stackZ);
    put(yardSteel, lathe([[0.64, 0], [0.64, 0.05], [0.33, 0.5], [0.3, 0.5]], 18), stackX, 6.43, stackZ);
    for (const y of [8.6, 11, 15.4]) put(yardSteel, new THREE.CylinderGeometry(0.335, 0.335, 0.09, 18, 1, true), stackX, y, stackZ);
    put(yardSteel, lathe([[0.3, 0], [0.98, 0], [0.98, 0.05], [0.3, 0.05]], 18), stackX, 12.6, stackZ);
    put(yardSteel, new THREE.TorusGeometry(0.98, 0.02, 5, 18), stackX, 13.65, stackZ, PI / 2, 0, 0);
    for (let i = 0; i < 6; i += 1) rod(yardSteel, 0.018, [stackX + Math.cos(i * PI / 3) * 0.98, 12.65, stackZ + Math.sin(i * PI / 3) * 0.98], [stackX + Math.cos(i * PI / 3) * 0.98, 13.65, stackZ + Math.sin(i * PI / 3) * 0.98], 5);
    put(yardSteel, lathe([[0, 0], [0.54, 0], [0.05, 0.3], [0, 0.3]], 18), stackX, 16.62, stackZ);
    for (let i = 0; i < 3; i += 1) rod(yardSteel, 0.02, [stackX + Math.cos(i * 2.094) * 0.3, 16.3, stackZ + Math.sin(i * 2.094) * 0.3], [stackX + Math.cos(i * 2.094) * 0.42, 16.64, stackZ + Math.sin(i * 2.094) * 0.42], 5);
    // The taller bays either side: sheeted walls with a strip of glazing under the eaves.
    for (const [s, top] of [[1, 17.5], [-1, 14.5]]) {
      box(yardSheet, 1, top - 5.5, 66, s * 13.6, (top + 5.5) / 2, -10);
      box(yardSteel, 1.3, 0.26, 66.4, s * 13.5, top + 0.1, -10);
      box(yardGlass, 0.06, 1.9, 60, s * 13.07, top - 4.1, -10);
      for (const y of [top - 5.1, top - 3.1]) box(yardSteel, 0.12, 0.12, 60, s * 13.04, y, -10);
      for (let i = 0; i <= 30; i += 1) box(yardSteel, 0.1, 1.9, 0.11, s * 13.03, top - 4.1, -40 + i * 2);
    }
    for (let i = 0; i < 9; i += 1) {
      put(yardSteel, new THREE.CylinderGeometry(0.45, 0.45, 0.8, 12, 1, true), -13.9, 15.1, -36 + i * 6.5);
      put(yardSteel, lathe([[0, 0], [0.7, 0], [0.08, 0.38], [0, 0.38]], 12), -13.9, 15.55, -36 + i * 6.5);
    }
    // Melting shop beyond the control end: a low shed with roof monitors, two stoves, an inclined
    // conveyor into a transfer tower, and the main chimney. Hazed toward the sky by distance.
    box(yardHaze, 36, 4.6, 6.4, 0, 7.5, -35.4);
    for (const x of [-12, -4, 4, 12]) box(yardHaze, 5.2, 1.3, 2.2, x, 10.4, -35.4);
    for (const [x, z, h] of [[-7.4, -42, 19.5], [-2.1, -43.6, 21.5]]) {
      put(yardHaze, new THREE.CylinderGeometry(2.3, 2.3, h - 6, 28, 1, true), x, (h + 6) / 2, z);
      put(yardHaze, new THREE.SphereGeometry(2.3, 28, 8, 0, PI * 2, 0, PI / 2).scale(1, 0.62, 1), x, h, z);
      put(yardHaze, lathe([[2.3, 0], [3, 0], [3, 0.09], [2.3, 0.09]], 28), x, h - 3.6, z);
      put(yardHaze, new THREE.TorusGeometry(3, 0.035, 4, 28), x, h - 2.5, z, PI / 2, 0, 0);
      for (const y of [h - 8, h - 0.6]) put(yardHaze, new THREE.CylinderGeometry(2.35, 2.35, 0.3, 28, 1, true), x, y, z);
    }
    bar(yardHaze, 1.8, [-13, 9.4, -39.4], [3.4, 17.6, -40.6]);
    box(yardHaze, 3.4, 6.2, 3.4, 4.6, 18, -40.8);
    box(yardHaze, 3.9, 0.3, 3.9, 4.6, 21.2, -40.8);
    for (const x of [3.1, 6.1]) for (const z of [-42.3, -39.3]) bar(yardHaze, 0.3, [x, 14.9, z], [x + (x < 4.6 ? -0.5 : 0.5), 6, z]);
    for (const z of [-40.9, -38.3]) bar(yardHaze, 0.26, [-5, 12.7, -39.9], [-5, 6, z]);
    put(yardHaze, new THREE.CylinderGeometry(0.75, 1.2, 31, 20, 1, true), 9.4, 21.5, -47);
    for (const y of [29.5, 33.5]) put(yardSteel, new THREE.CylinderGeometry(0.86, 0.9, 1.7, 20, 1, true), 9.4, y, -47);
    put(yardHaze, new THREE.CylinderGeometry(0.84, 0.84, 0.35, 20, 1, true), 9.4, 36.85, -47);
  }
  // Water tower behind the tape wall: tank, conical roof, six raking legs, ring girders and rod bracing.
  at(-5.5, 0, 19.6, 0.3, () => {
    put(yardPaint, new THREE.CylinderGeometry(2.7, 2.7, 3.4, 24, 1, true), 0, 14.9, 0);
    put(yardPaint, lathe([[0, -1.15], [1.3, -0.98], [2.25, -0.48], [2.7, 0]], 24), 0, 13.2, 0);
    put(yardPaint, lathe([[2.7, 0], [2.84, 0], [0.25, 0.95], [0, 0.95]], 24), 0, 16.6, 0);
    for (const y of [13.25, 16.55]) put(yardSteel, new THREE.CylinderGeometry(2.74, 2.74, 0.16, 24, 1, true), 0, y, 0);
    put(yardSteel, new THREE.CylinderGeometry(0.4, 0.4, 8.2, 12, 1, true), 0, 8.1, 0);
    put(yardSteel, lathe([[2.7, 0], [3.5, 0], [3.5, 0.07], [2.7, 0.07]], 24), 0, 13.05, 0);
    put(yardSteel, new THREE.TorusGeometry(3.5, 0.028, 4, 24), 0, 14.15, 0, PI / 2, 0, 0);
    const leg = (k: number, y: number) => { const r = 2.3 + (13 - y) / 9 * 1.25, a = k * PI / 3; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
    for (let k = 0; k < 6; k += 1) {
      bar(yardSteel, 0.24, leg(k, 13.05), leg(k, 4));
      for (const y of [10, 7]) bar(yardSteel, 0.13, leg(k, y), leg(k + 1, y));
      for (const [from, to] of [[13, 10], [10, 7]]) { rod(yardSteel, 0.035, leg(k, from), leg(k + 1, to), 5); rod(yardSteel, 0.035, leg(k + 1, from), leg(k, to), 5); }
      rod(yardSteel, 0.022, [Math.cos(k * PI / 3 + 0.5) * 3.5, 13.1, Math.sin(k * PI / 3 + 0.5) * 3.5], [Math.cos(k * PI / 3 + 0.5) * 3.5, 14.15, Math.sin(k * PI / 3 + 0.5) * 3.5], 5);
    }
  });

  // ---- Small clutter (skipped on the performance tier) ------------------------
  if (high) {
    const cone = (x: number, z: number, tilt = 0) => at(x, 0, z, 0, () => {
      rbox(coneB, 0.36, 0.03, 0.36, 0.01, 0, 0.015, 0);
      put(coneB, lathe([[0.135, 0.03], [0.03, 0.68], [0, 0.69]], 16), 0, 0, 0, tilt, 0, 0);
      put(brushedB, new THREE.CylinderGeometry(0.076, 0.094, 0.12, 16, 1, true), 0, 0.42, 0, tilt, 0, 0);
    });
    cone(-8.55, 4.95); cone(-8.7, 9.0); cone(5.35, 8.75); cone(9.05, 5.1);
    // Bucket, broom and a cable reel.
    put(brushedB, lathe([[0, 0], [0.11, 0], [0.14, 0.27], [0.146, 0.275], [0.146, 0.285], [0.132, 0.285], [0.105, 0.012], [0, 0.012]], 16), -9.0, 0, -2.2);
    put(darkB, new THREE.TorusGeometry(0.145, 0.005, 4, 16, PI), -9.0, 0.28, -2.2, 0.5, 0.4, 0);
    rod(planksB, 0.014, [9.38, 1.5, 2.9], [9.1, 0.05, 3.05], 6);
    box(planksB, 0.07, 0.05, 0.36, 9.09, 0.04, 3.05, 0, 0.1, 0);
    box(rubberB, 0.06, 0.07, 0.34, 9.085, 0.0, 3.05, 0, 0.1, 0);
    at(8.95, 0.3, -24.0, 0.3, () => {
      for (const o of [-0.14, 0.14]) put(planksB, new THREE.CylinderGeometry(0.3, 0.3, 0.025, 20), o, 0, 0, 0, 0, PI / 2);
      put(rubberB, new THREE.CylinderGeometry(0.2, 0.2, 0.26, 18), 0, 0, 0, 0, 0, PI / 2);
      put(planksB, new THREE.CylinderGeometry(0.09, 0.09, 0.3, 12), 0, 0, 0, 0, 0, PI / 2);
    });
    // Wheel chocks and offcuts by the door, bolt tubs on the base plates.
    for (const [x, z, yaw] of [[-9.2, 9.1, 0.4], [-9.02, 4.78, 1.9]]) box(rubberB, 0.24, 0.12, 0.14, x, 0.06, z, 0, yaw, 0.0);
    for (const [x, z, yaw, len] of [[-9.25, -12.5, 0.05, 1.6], [-9.295, -12.5, 0.0, 1.9], [9.29, 0.3, 0.02, 1.2]]) box(steelB, 0.05, 0.05, len, x, 0.03 + (len > 1.7 ? 0.05 : 0), z, 0, yaw, 0);
    sign("tag", 0.2, 0.1, -9.12 + 0.088, 0.9, doorZ - doorHalf - 0.3, PI / 2, false);
  }

  // ---- Flush the batches -------------------------------------------------------
  for (const { material, hit, shadow, parts } of bags) {
    if (parts.length === 0) continue;
    const merged = mergeGeometries(parts);
    parts.forEach((part) => part.dispose());
    const mesh = place(new THREE.Mesh(merged, material), 0, 0, 0, shadow, hit);
    if (material === decalMaterial || material === matteDecal) mesh.renderOrder = 1;
    if (outdoorMaterials.has(material)) mesh.receiveShadow = false;
  }

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: machineMaterial, darkMetal, structural, duct: casingMaterial });
  {
    // The casing built above replaces the kit's solid body, which would otherwise fill the firebox.
    const body = furnace.group.children.find((child) => child instanceof THREE.Mesh && child.material === machineMaterial) as THREE.Mesh | undefined;
    if (body) {
      furnace.group.remove(body);
      body.geometry.dispose();
      const index = shootable.indexOf(body);
      if (index >= 0) shootable.splice(index, 1);
    }
    // Fire in depth: flames against the back wall, a second sheet licking forward, a bed of coals
    // on the hearth and sparks lifting out through the bars.
    const hearthFire = (seed: number, gain: number, lift: number) => new THREE.ShaderMaterial({
      vertexShader: FIRE_SHADER.vertexShader, fragmentShader: HEARTH_FRAGMENT,
      uniforms: { time: { value: 0 }, seed: { value: seed }, gain: { value: gain }, lift: { value: lift } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    });
    const fires = [hearthFire(0, 0.4, 1.1), hearthFire(4.7, 0.26, 1.45)];
    const card = furnace.meshes.find((mesh) => mesh.material instanceof THREE.ShaderMaterial);
    if (card) {
      (card.material as THREE.Material).dispose();
      card.material = fires[0];
      card.position.set(0, 1.68, -0.3);
      card.scale.set(2.2 / 2.42, 1.58 / 1.86, 1);
      card.renderOrder = 3;
    }
    const front = new THREE.Mesh(new THREE.PlaneGeometry(2.16, 1.5), fires[1]);
    front.position.set(0, 1.66, 0.14);
    front.renderOrder = 4;
    furnace.group.add(front);

    const R = (n: number) => { const v = Math.sin(n * 127.1 + 31.7) * 43758.5453; return v - Math.floor(v); };
    const lumps: THREE.BufferGeometry[] = [];
    const char = new THREE.Color(0.035, 0.016, 0.01), ember = new THREE.Color();
    for (let i = 0; i < 72; i += 1) {
      const r = 0.05 + R(i * 3.7 + 1) * 0.06;
      const lump = new THREE.IcosahedronGeometry(r, 0);
      lump.rotateY(R(i * 1.3) * 6).rotateX(R(i * 2.1) * 6);
      lump.scale(1, 0.62, 1);
      const heat = 0.35 + R(i * 5.3 + 2) * 0.65;
      ember.setRGB(2.3 * heat, 0.4 * heat * heat, 0.03 * heat);
      const position = lump.getAttribute("position"), colors = new Float32Array(position.count * 3);
      for (let v = 0; v < position.count; v += 1) {
        // Crusted black on top, bright where each lump faces down into the bed.
        const hot = THREE.MathUtils.smoothstep(-position.getY(v) / (r * 0.62), -0.15, 0.9);
        colors[v * 3] = THREE.MathUtils.lerp(char.r, ember.r, hot);
        colors[v * 3 + 1] = THREE.MathUtils.lerp(char.g, ember.g, hot);
        colors[v * 3 + 2] = THREE.MathUtils.lerp(char.b, ember.b, hot);
      }
      lump.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const row = i % 6, depth = -0.24 + row * 0.135 + R(i * 7.1) * 0.05;
      lump.translate(-1.0 + R(i * 9.7 + 3) * 2.0, 0.905 + R(i * 4.3) * 0.03 + (row < 2 ? 0.05 : 0), depth);
      lumps.push(lump);
    }
    const coalMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
    const coals = new THREE.Mesh(mergeGeometries(lumps), coalMaterial);
    lumps.forEach((lump) => lump.dispose());
    furnace.group.add(coals);
    // The bed itself, glowing between the lumps.
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.86).rotateX(-PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 0.24, 0.02), toneMapped: false, fog: false }));
    bed.position.set(0, 0.893, 0.115);
    furnace.group.add(bed);

    // Sparks: a steady lift through the bars (HIGH only), and every so often the fire surges and throws
    // a spray of them out over the apron.
    const steady = high ? 40 : 0, spray = high ? 90 : 40, sparkCount = steady + spray;
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sparkCount * 3), 3));
    sparkGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sparkCount * 3), 3));
    sparkGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.6, 1.4), 4);
    const sparks = new THREE.Points(sparkGeometry, new THREE.PointsMaterial({ size: 0.04, map: poolTexture, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));
    sparks.renderOrder = 5;
    furnace.group.add(sparks);
    kit.mirrorHidden.push(sparks);
    const hearthLight = furnace.group.children.find((child): child is THREE.PointLight => child instanceof THREE.PointLight);
    const mouth = new THREE.Vector3(8.3, 1.6, -11.6), surgeVoice = { gain: 1, pitch: 1 };
    let surgeAt = -100, nextSurge = -1;
    kit.updates.push((now) => {
      const seconds = now / 1000;
      if (nextSurge < 0) nextSurge = seconds + 8 + Math.random() * 6;
      if (seconds >= nextSurge) {
        surgeAt = seconds;
        nextSurge = seconds + 13 + Math.random() * 13;
        surgeVoice.gain = 0.85 + Math.random() * 0.3; surgeVoice.pitch = 0.8 + Math.random() * 0.4;
        cue?.("sparkZap", mouth, surgeVoice);
      }
      const since = seconds - surgeAt, surge = since < 0.12 ? since / 0.12 : Math.exp(-(since - 0.12) / 0.8);
      for (const fire of fires) fire.uniforms.time.value = seconds;
      fires[0].uniforms.gain.value = 0.4 * (1 + surge * 1.2);
      fires[1].uniforms.gain.value = 0.26 * (1 + surge * 1.7);
      coalMaterial.color.setScalar(0.86 + Math.sin(seconds * 1.7) * 0.08 + Math.sin(seconds * 4.3 + 1) * 0.06 + surge * 0.5);
      // The kit has just set the hearth light and its glow in the haze for this frame: the surge lifts both.
      if (hearthLight) hearthLight.intensity *= 1 + surge * 0.9;
      furnace.glow.color.multiplyScalar(1 + surge * 0.9);
      const position = sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
      const color = sparks.geometry.getAttribute("color") as THREE.BufferAttribute;
      for (let i = 0; i < steady; i += 1) {
        const age = (seconds * (0.22 + R(i * 3.1) * 0.3) + R(i * 7.7)) % 1;
        const drift = R(i * 5.9) - 0.5, out = R(i * 11.3);
        position.setXYZ(i,
          drift * 1.7 + Math.sin(seconds * 3 + i) * 0.03 * age,
          0.98 + age * (0.9 + R(i * 2.3) * 1.3) - age * age * 0.25,
          -0.1 + out * 0.5 + age * (0.2 + out * 0.55));
        const fade = Math.sin(Math.min(1, age * 1.15) * PI) * (0.6 + 0.4 * Math.sin(seconds * 31 + i * 1.7));
        color.setXYZ(i, 5 * fade, 1.9 * fade * (1 - age * 0.6), 0.35 * fade * (1 - age));
      }
      for (let k = 0; k < spray; k += 1) {
        const i = steady + k, flight = since - R(k * 3.3 + 5) * 0.22, span = 0.8 + R(k * 6.1 + 2) * 0.9;
        if (flight < 0 || flight > span) { color.setXYZ(i, 0, 0, 0); continue; }
        const up = 0.5 + R(k * 4.7 + 3) * 2.3, from = 1 + R(k * 7.9) * 0.9, out = 0.9 + R(k * 8.3 + 4) * 1.7;
        let y = from + up * flight - 4.2 * flight * flight;
        if (y < 0.03) {
          // One bounce off the apron.
          const landing = (up + Math.sqrt(up * up + 16.8 * (from - 0.03))) / 8.4, after = flight - landing;
          y = Math.max(0.03, 0.03 + (8.4 * landing - up) * 0.3 * after - 4.2 * after * after);
        }
        position.setXYZ(i, (R(k * 5.1) - 0.5) * 1.6 + (R(k * 2.9 + 1) - 0.5) * 2 * flight, y, 0.5 + out * flight * (1 - 0.18 * flight));
        const fade = 1 - flight / span;
        color.setXYZ(i, 6 * fade, 2.6 * fade * fade, 0.5 * fade * fade * fade);
      }
      position.needsUpdate = true;
      color.needsUpdate = true;
    });
  }

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xbcd3d6, 0x2b2620, 0.3));
  const sun = new THREE.DirectionalLight(0xfff0d8, 7.5);
  const sunTravel = new THREE.Vector3(-5, -16, 7).normalize();
  sun.target.position.set(0, 0, -9.5);
  sun.position.copy(sun.target.position).addScaledVector(sunTravel, -42);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(high ? 4096 : leanAssets() ? 1024 : 2048);
  sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24;
  sun.shadow.camera.near = 8; sun.shadow.camera.far = 72;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);
  // Soft overhead fill from the lamp rows (the probe carries the rest).
  const fills = [3, -9, -21].map((z, index) => {
    const lampFill = new THREE.PointLight(0xd3f1ec, 52, 19, 2);
    lampFill.position.set(index === 1 ? -3.4 : 3.4, 5.1, z);
    scene.add(lampFill);
    return lampFill;
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 520, x: 18, y: [0.2, 5.8], z: [-28, 8], color: 0xfff3dc });

  // ---- Plants: what a foundry grows by itself -----------------------------------
  // Weeds and tufts of dry grass in the joint at the foot of the walls, round the column bases, along
  // slab joints and wherever water stands; ivy that has come in through the broken pane of the middle
  // roof light, with what it has shed on the floor below.
  const trees = createTrees(kit, { seed: 61, wind, sun });
  const footX = 9.28;
  /** `kind` 0 upright, 1 rosette, 2 a strip (laid along the wall it stands against). */
  const weed = (x: number, z: number, kind: number, scale = 1): TreeItem => ({ at: [x, 0, z], variant: kind, scale, yaw: kind === 2 ? (Math.abs(x) > 9 ? PI / 2 : 0) : x * 3.1 + z * 1.7 });
  trees.place("weeds", [
    // Foot of the west wall and the door threshold.
    ...[[8.62, 0], [5.02, 2], [3.7, 0], [2.9, 1], [-0.3, 2], [-3.3, 0], [-6.1, 2], [-9.4, 0], [-12.2, 1], [-12.9, 2], [-15.1, 0], [-21.2, 2], [-24.1, 0]].map(([z, kind]) => weed(-footX, z, kind)),
    // Foot of the east wall.
    ...[[7.5, 2], [5.3, 0], [3.1, 1], [1.2, 2], [-1.3, 0], [-3.8, 2], [-8.3, 0], [-14.3, 1], [-16.1, 2], [-21.4, 0], [-23.9, 2]].map(([z, kind]) => weed(footX, z, kind)),
    // Under the chart wall.
    ...[[-5.9, 2], [-3.4, 0], [1.9, 2], [4.6, 1], [6.4, 0]].map(([x, kind]) => weed(x, 9.6, kind, 0.9)),
    // Column bases.
    ...bayZ.slice(0, 5).flatMap((z, index) => side2.map((s) => weed(s * 9.02, z + (index % 2 ? 0.37 : -0.37), index % 2, 0.9))),
    // Slab joints, barrier feet, the wet round the tank, and under the broken pane where the rain comes in.
    weed(8.2, -4.97, 1), weed(-7.9, -10.95, 0), weed(-7.2, -10.97, 1), weed(7.9, -16.97, 1), weed(-7.8, -22.97, 0), weed(6.1, 0.38, 1), weed(5.4, -22.05, 0),
    weed(tankX - 0.95, hoistZ + 0.42, 0), weed(tankX + 0.62, hoistZ + 0.62, 1),
    weed(-2.9, BROKEN_LIGHT + 1.5, 1, 1.1), weed(-2.4, BROKEN_LIGHT + 1, 0, 1.1), weed(-3.5, BROKEN_LIGHT + 0.8, 1),
  ]);
  trees.place("grass", [
    ...[[-footX, 6.1], [-footX, 7.4], [-footX, 1.6], [-footX, -8.2], [-footX, -20.2], [footX, 6.3], [footX, -2.6], [footX, -15.2], [footX, -22.6]].map(([x, z], index): TreeItem => ({ at: [x, 0, z], variant: index % 2, dry: 0.55, yaw: index * 1.9 })),
    { at: [-3.3, 0, BROKEN_LIGHT + 1.3], variant: 1, dry: 0.15 }, { at: [tankX - 0.8, 0, hoistZ - 0.55], variant: 0, dry: 0.4 },
  ]);
  trees.place("ivy", [
    { at: [-2.85, 6.16, BROKEN_LIGHT + 1.74], yaw: PI, variant: 2, scale: [0.5, 1, 1] },
    { at: [-3.5, 6.16, BROKEN_LIGHT + 1.26], yaw: PI / 2, variant: 2, scale: [0.38, 0.75, 1] },
  ], { hit: false });
  trees.place("leafLitter", [{ at: [-2.9, 0.012, BROKEN_LIGHT + 1.4], variant: 0, scale: 0.8 }, { at: [-9.2, 0.012, doorZ], variant: 1, yaw: PI / 2 }]);

  const toSun = sunTravel.clone().negate();
  const probe = new THREE.Vector3();

  const range = kit.finish({
    furnace,
    materials: { darkMetal, machine: machineMaterial, structural, brushed: ductMaterial },
    sun,
    fills,
    reflection,
    look: {
      sky: "/environment/bonzai-sky.hdr", skyIntensity: 1, skyRotation: 0,
      background: 0x6f8fa8, fog: 0x16201f, fogDensity: high ? 0.0045 : 0.011,
      haze: new THREE.Color(0.022, 0.038, 0.042), hazeDensity: 0.015, hazeCeiling: 6.3, hazeFade: 0.25,
      environmentIntensity: 1.2, exposure: 1, far: 110,
    },
    sunlitAt(point) {
      const t = (SKYLIGHT_Y - point.y) / toSun.y;
      if (t <= 0) return 0;
      probe.copy(point).addScaledVector(toSun, t);
      const edgeX = 1 - THREE.MathUtils.smoothstep(Math.abs(probe.x), SKYLIGHT_HALF.x - 0.35, SKYLIGHT_HALF.x);
      let lit = 0;
      for (const z of SKYLIGHTS) lit = Math.max(lit, 1 - THREE.MathUtils.smoothstep(Math.abs(probe.z - z), SKYLIGHT_HALF.z - 0.35, SKYLIGHT_HALF.z));
      return lit * edgeX;
    },
  });
  const ring = { gain: 0.5, pitch: 1 };
  let rang = 0;
  return {
    ...range,
    // Gunfire flushes the pigeons; a bullet sets whatever hangs swinging.
    startle: life.startle,
    struck(object, point) {
      if (life.struck(object, point)) return true;
      if (!moving.has(object)) return false;
      const now = performance.now();
      if (now - rang > 600) { rang = now; ring.pitch = 1.35 + Math.random() * 0.5; cue?.("hammerClank", point, ring); }
      return true;
    },
  };
}

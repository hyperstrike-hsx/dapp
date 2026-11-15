import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { comboMultiplier, killScore, spawnOrder, wavePlan, zombieStats, type ZombieKind } from "./hordeRules";
import type { Glow } from "./volumetric";

// Wave mode.
//
// The dead climb out of the range floor in escalating waves. Figures are
// articulated from rigid segments and animated procedurally — shamble, sprint,
// lunge, stagger, collapse — so there is no skeleton or clip data to ship, and
// a shot can take a head or an arm clean off. Everything is pooled: no
// allocation while the mode runs.

export type HordePhase = "idle" | "intro" | "wave" | "break" | "over";
export type HordeHud = {
  phase: HordePhase;
  wave: number;
  remaining: number;
  score: number;
  best: number;
  kills: number;
  health: number;
  multiplier: number;
  /** Seconds left on the combo window and on the next-wave countdown. */
  combo: number;
  countdown: number;
  boost: number;
  banner: string;
  detail: string;
  bannerId: number;
  hitId: number;
  headshot: boolean;
  killId: number;
  hurtId: number;
};

export type Obstacle = { x: number; z: number; r: number };
export type HordeOptions = {
  scene: THREE.Scene;
  obstacles: Obstacle[];
  audio: () => AudioContext;
  onHud: (hud: HordeHud) => void;
  onHurt: (amount: number) => void;
};

export type Horde = {
  readonly phase: HordePhase;
  readonly active: boolean;
  /** Meshes a bullet can hit. */
  targets: THREE.Object3D[];
  glows: Glow[];
  /** Outgoing damage multiplier (overdrive pickup). */
  damageBoost: () => number;
  start: (now: number) => void;
  stop: () => void;
  /** Applies a bullet. Returns true when it struck a zombie. */
  hit: (object: THREE.Object3D, point: THREE.Vector3, direction: THREE.Vector3, damage: number, headshot: number, now: number) => boolean;
  update: (now: number, dt: number, player: THREE.Vector3, yaw: number) => void;
  /** 0..1 blend of the room toward its wave-mode staging. */
  mood: () => number;
  dispose: () => void;
};

const POOL = 20, GORE = 420, STAINS = 36;
const BOUNDS = { x: 8.3, zMin: -23, zMax: 7.2 };
const BEST_KEY = "hyperstrike.horde.best";

type Segment = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
type Limb = { root: THREE.Group; joint: THREE.Group; upper: Segment; lower: Segment; gone: boolean };
type Zombie = {
  root: THREE.Group;
  hips: THREE.Group;
  spine: THREE.Group;
  head: THREE.Group;
  skull: Segment;
  eyes: Segment;
  arms: [Limb, Limb];
  legs: [Limb, Limb];
  blob: THREE.Mesh;
  meshes: Segment[];
  kind: ZombieKind;
  state: "free" | "rising" | "chasing" | "attacking" | "dying" | "dead";
  health: number;
  speed: number;
  damage: number;
  scale: number;
  phase: number;
  timer: number;
  stagger: number;
  facing: number;
  fall: number;
  struck: boolean;
  groanAt: number;
  quirk: number;
  headless: boolean;
};

const SKIN: Array<[number, number, number]> = [[0.36, 0.42, 0.33], [0.44, 0.43, 0.37], [0.3, 0.37, 0.36], [0.47, 0.4, 0.36]];
const SHIRT: Array<[number, number, number]> = [[0.2, 0.22, 0.26], [0.36, 0.3, 0.2], [0.42, 0.12, 0.1], [0.14, 0.19, 0.15]];
const TROUSER: Array<[number, number, number]> = [[0.09, 0.1, 0.13], [0.16, 0.13, 0.1], [0.11, 0.12, 0.11], [0.07, 0.07, 0.08]];
const BLOOD: [number, number, number] = [0.2, 0.012, 0.012];

function tinted(geometry: THREE.BufferGeometry, color: [number, number, number], matrix?: THREE.Matrix4) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  if (matrix) flat.applyMatrix4(matrix);
  const count = flat.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const position = flat.attributes.position;
  for (let i = 0; i < count; i += 1) {
    // Mottle so flat colours read as stained cloth and bruised skin.
    const n = Math.sin(position.getX(i) * 71.3 + position.getY(i) * 37.7 + position.getZ(i) * 53.1) * 0.5 + 0.5;
    const shade = 0.72 + n * 0.42;
    colors[i * 3] = color[0] * shade; colors[i * 3 + 1] = color[1] * shade; colors[i * 3 + 2] = color[2] * shade;
  }
  flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return flat;
}
const move = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), new THREE.Vector3(sx, sy, sz));
const fuse = (parts: THREE.BufferGeometry[]) => { const merged = mergeGeometries(parts, false)!; parts.forEach((part) => part.dispose()); return merged; };
/** Capsule hanging from the origin down -Y. */
const hanging = (radius: number, length: number) => { const g = new THREE.CapsuleGeometry(radius, length - radius * 2, 3, 8); g.translate(0, -length / 2, 0); return g; };

function softDisc(inner: string, outer: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, inner); gradient.addColorStop(0.55, inner); gradient.addColorStop(1, outer);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function createHorde(options: HordeOptions): Horde {
  const { scene, obstacles } = options;
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const disposables: Array<{ dispose: () => void }> = [];
  const keep = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item; };

  // ---- Shared geometry: four outfits, coloured per vertex ---------------------
  const flesh = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.7 }));
  const eyeMaterials = {
    walker: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 3.4, 0.5), toneMapped: false })),
    runner: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(4.2, 1.5, 0.15), toneMapped: false })),
    brute: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.25, 0.15), toneMapped: false })),
  };
  const eyeGeometry = keep(fuse([-0.042, 0.042].map((x) => { const g = new THREE.SphereGeometry(0.017, 8, 6); g.translate(x, 0.035, 0.094); return g; })));
  const outfits = SKIN.map((skin, index) => {
    const shirt = SHIRT[index], trouser = TROUSER[index];
    const dark: [number, number, number] = [skin[0] * 0.45, skin[1] * 0.4, skin[2] * 0.4];
    return {
      pelvis: keep(fuse([tinted(new THREE.SphereGeometry(0.16, 10, 8), trouser, move(0, 0, 0, 1.08, 0.72, 0.8))])),
      torso: keep(fuse([
        tinted(new THREE.CapsuleGeometry(0.155, 0.3, 4, 10), shirt, move(0, 0.3, 0, 1.12, 1, 0.74)),
        tinted(new THREE.SphereGeometry(0.1, 8, 6), shirt, move(-0.19, 0.5, 0, 1, 0.8, 0.9)),
        tinted(new THREE.SphereGeometry(0.1, 8, 6), shirt, move(0.19, 0.5, 0, 1, 0.8, 0.9)),
        tinted(new THREE.CylinderGeometry(0.055, 0.07, 0.12, 8), skin, move(0, 0.6, 0.01)),
        // An open wound keeps the silhouette from reading as a mannequin.
        tinted(new THREE.SphereGeometry(0.075, 8, 6), BLOOD, move(0.06 - index * 0.04, 0.28, 0.1, 1, 1.3, 0.35)),
      ])),
      skull: keep(fuse([
        tinted(new THREE.SphereGeometry(0.108, 12, 10), skin, move(0, 0.03, 0, 0.92, 1.12, 1)),
        tinted(new THREE.BoxGeometry(0.12, 0.07, 0.1), skin, move(0, -0.075, 0.03)),
        tinted(new THREE.BoxGeometry(0.085, 0.025, 0.03), BLOOD, move(0, -0.07, 0.083)),
        tinted(new THREE.SphereGeometry(0.03, 6, 5), dark, move(-0.042, 0.035, 0.082, 1, 0.8, 0.6)),
        tinted(new THREE.SphereGeometry(0.03, 6, 5), dark, move(0.042, 0.035, 0.082, 1, 0.8, 0.6)),
        ...(index % 2 === 0 ? [tinted(new THREE.SphereGeometry(0.112, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), [0.05, 0.04, 0.035], move(0, 0.05, -0.012, 0.95, 1.05, 1.02))] : []),
      ])),
      upperArm: keep(fuse([tinted(hanging(0.052, 0.31), index === 2 ? skin : shirt)])),
      foreArm: keep(fuse([tinted(hanging(0.043, 0.28), skin), tinted(new THREE.SphereGeometry(0.05, 8, 6), dark, move(0, -0.3, 0.01, 0.8, 1.2, 1))])),
      thigh: keep(fuse([tinted(hanging(0.082, 0.45), trouser)])),
      shin: keep(fuse([tinted(hanging(0.062, 0.44), trouser), tinted(new THREE.BoxGeometry(0.1, 0.07, 0.24), [0.05, 0.045, 0.04], move(0, -0.44, 0.06))])),
    };
  });
  const blobMap = keep(softDisc("rgba(0,0,0,0.62)", "rgba(0,0,0,0)"));
  const blobMaterial = keep(new THREE.MeshBasicMaterial({ map: blobMap, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  const blobGeometry = keep(new THREE.PlaneGeometry(1.25, 1.25).rotateX(-Math.PI / 2));

  const zombies: Zombie[] = [];
  const segment = (geometry: THREE.BufferGeometry, zone: string, index: number, parent: THREE.Object3D, list: Segment[]) => {
    const mesh = new THREE.Mesh(geometry, flesh) as Segment;
    mesh.userData.zombie = index;
    mesh.userData.zone = zone;
    mesh.castShadow = true;
    parent.add(mesh);
    list.push(mesh);
    return mesh;
  };
  const buildZombie = (index: number): Zombie => {
    const outfit = outfits[index % outfits.length];
    const meshes: Segment[] = [];
    const root = new THREE.Group();
    root.rotation.order = "YXZ";
    root.visible = false;
    const hips = new THREE.Group();
    hips.position.y = 0.93;
    root.add(hips);
    segment(outfit.pelvis, "body", index, hips, meshes);
    const spine = new THREE.Group();
    spine.position.y = 0.06;
    hips.add(spine);
    segment(outfit.torso, "body", index, spine, meshes);
    const head = new THREE.Group();
    head.position.set(0, 0.72, 0.015);
    spine.add(head);
    const skull = segment(outfit.skull, "head", index, head, meshes);
    const eyes = new THREE.Mesh(eyeGeometry, eyeMaterials.walker) as Segment;
    head.add(eyes);
    const limb = (parent: THREE.Object3D, x: number, y: number, upper: THREE.BufferGeometry, lower: THREE.BufferGeometry, length: number, zone: string): Limb => {
      const limbRoot = new THREE.Group();
      limbRoot.position.set(x, y, 0);
      parent.add(limbRoot);
      const upperMesh = segment(upper, zone, index, limbRoot, meshes);
      const joint = new THREE.Group();
      joint.position.y = -length;
      limbRoot.add(joint);
      return { root: limbRoot, joint, upper: upperMesh, lower: segment(lower, zone, index, joint, meshes), gone: false };
    };
    const arms: [Limb, Limb] = [limb(spine, -0.235, 0.5, outfit.upperArm, outfit.foreArm, 0.3, "arm0"), limb(spine, 0.235, 0.5, outfit.upperArm, outfit.foreArm, 0.3, "arm1")];
    const legs: [Limb, Limb] = [limb(hips, -0.095, -0.04, outfit.thigh, outfit.shin, 0.44, "leg"), limb(hips, 0.095, -0.04, outfit.thigh, outfit.shin, 0.44, "leg")];
    const blob = new THREE.Mesh(blobGeometry, blobMaterial);
    blob.position.y = 0.012;
    blob.renderOrder = 2;
    root.add(blob);
    group.add(root);
    return { root, hips, spine, head, skull, eyes, arms, legs, blob, meshes, kind: "walker", state: "free", health: 0, speed: 0, damage: 0, scale: 1, phase: 0, timer: 0, stagger: 0, facing: 0, fall: 1, struck: false, groanAt: 0, quirk: Math.random(), headless: false };
  };

  // ---- Gore, stains, spawn rifts, pickups -------------------------------------
  const goreMap = keep(softDisc("rgba(255,255,255,1)", "rgba(255,255,255,0)"));
  const gorePosition = new Float32Array(GORE * 3).fill(-999), goreColor = new Float32Array(GORE * 3), goreVelocity = new Float32Array(GORE * 3);
  const goreLife = new Float32Array(GORE);
  const goreGeometry = keep(new THREE.BufferGeometry());
  goreGeometry.setAttribute("position", new THREE.BufferAttribute(gorePosition, 3));
  goreGeometry.setAttribute("color", new THREE.BufferAttribute(goreColor, 3));
  const gore = new THREE.Points(goreGeometry, keep(new THREE.PointsMaterial({ map: goreMap, size: 0.085, vertexColors: true, transparent: true, alphaTest: 0.08, depthWrite: false, sizeAttenuation: true })));
  gore.frustumCulled = false;
  group.add(gore);
  let goreCursor = 0;
  const spray = (at: THREE.Vector3, direction: THREE.Vector3, count: number, speed: number, color: [number, number, number], spread = 1) => {
    for (let i = 0; i < count; i += 1) {
      const o = goreCursor * 3, s = speed * (0.35 + Math.random());
      gorePosition[o] = at.x; gorePosition[o + 1] = at.y; gorePosition[o + 2] = at.z;
      goreVelocity[o] = (direction.x + (Math.random() - 0.5) * spread) * s;
      goreVelocity[o + 1] = (direction.y + (Math.random() - 0.2) * spread) * s;
      goreVelocity[o + 2] = (direction.z + (Math.random() - 0.5) * spread) * s;
      const shade = 0.6 + Math.random() * 0.6;
      goreColor[o] = color[0] * shade; goreColor[o + 1] = color[1] * shade; goreColor[o + 2] = color[2] * shade;
      goreLife[goreCursor] = 0.45 + Math.random() * 0.5;
      goreCursor = (goreCursor + 1) % GORE;
    }
  };
  const RED: [number, number, number] = [0.42, 0.015, 0.015], DUST: [number, number, number] = [0.3, 0.29, 0.26];

  const stainMaterial = keep(new THREE.MeshBasicMaterial({ map: goreMap, color: 0x2a0303, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
  const stainGeometry = keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const stains = Array.from({ length: STAINS }, () => { const mesh = new THREE.Mesh(stainGeometry, stainMaterial); mesh.visible = false; mesh.renderOrder = 1; group.add(mesh); return { mesh, size: 1, grown: 1 }; });
  let stainCursor = 0;
  const stain = (x: number, z: number, size: number) => {
    const entry = stains[stainCursor];
    stainCursor = (stainCursor + 1) % STAINS;
    entry.mesh.position.set(x, 0.009 + stainCursor * 0.0002, z);
    entry.mesh.rotation.y = Math.random() * 6.28;
    entry.size = size; entry.grown = 0.25;
    entry.mesh.visible = true;
  };

  const riftMaterial = keep(new THREE.MeshBasicMaterial({ map: goreMap, color: new THREE.Color(0.7, 2.4, 0.5), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const rifts = Array.from({ length: 8 }, () => { const mesh = new THREE.Mesh(stainGeometry, riftMaterial.clone()); mesh.visible = false; mesh.scale.setScalar(2.2); mesh.position.y = 0.02; group.add(mesh); return { mesh, life: 0 }; });
  rifts.forEach((rift) => keep(rift.mesh.material));
  let riftCursor = 0;

  type PickupKind = "OVERDRIVE" | "MEDKIT" | "SHOCKWAVE";
  const pickupColors: Record<PickupKind, THREE.Color> = { OVERDRIVE: new THREE.Color(5, 1.6, 0.2), MEDKIT: new THREE.Color(0.4, 4.5, 1.2), SHOCKWAVE: new THREE.Color(0.5, 2.4, 5.5) };
  const pickupMaterial = keep(new THREE.MeshBasicMaterial({ toneMapped: false, wireframe: false }));
  const pickupHalo = keep(new THREE.MeshBasicMaterial({ map: goreMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.6 }));
  const pickup = { mesh: new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.22, 0)), pickupMaterial), halo: new THREE.Mesh(stainGeometry, pickupHalo), kind: "MEDKIT" as PickupKind, life: 0 };
  pickup.mesh.visible = false; pickup.halo.visible = false; pickup.halo.scale.setScalar(1.8);
  group.add(pickup.mesh, pickup.halo);
  const shock = new THREE.Mesh(keep(new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2)), keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.6, 6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide })));
  shock.visible = false; shock.position.y = 0.4;
  group.add(shock);
  let shockLife = 0;

  // Alarm beacons restage the room in red.
  const beacons = [[-6.5, 4.4, 2], [6.5, 4.4, -10], [-6.5, 4.4, -20]].map(([x, y, z]) => {
    const light = new THREE.PointLight(0xff1a12, 0, 26, 1.6);
    light.position.set(x, y, z);
    group.add(light);
    return light;
  });
  const glows: Glow[] = beacons.map((light) => ({ position: light.position.clone(), color: new THREE.Color(0, 0, 0) }));

  // ---- Sound --------------------------------------------------------------------
  const listener = new THREE.Vector3();
  let listenerYaw = 0;
  let drone: { stop: () => void } | null = null;
  const voice = (at: THREE.Vector3 | null, build: (context: AudioContext, out: AudioNode, time: number) => void, gain = 1) => {
    try {
      const context = options.audio();
      const volume = context.createGain();
      let level = gain, pan = 0;
      if (at) {
        const dx = at.x - listener.x, dz = at.z - listener.z, distance = Math.hypot(dx, dz);
        level *= 1 / (1 + distance * 0.22);
        pan = THREE.MathUtils.clamp(Math.sin(Math.atan2(dx, -dz) + listenerYaw) * Math.min(1, distance / 3), -1, 1);
      }
      volume.gain.value = level;
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      volume.connect(panner).connect(context.destination);
      build(context, volume, context.currentTime);
    } catch { /* audio is optional */ }
  };
  const noise = (context: AudioContext, out: AudioNode, time: number, frequency: number, length: number, gain: number, type: BiquadFilterType = "lowpass") => {
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * length), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 1.5;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency;
    const volume = context.createGain();
    volume.gain.value = gain;
    source.connect(filter).connect(volume).connect(out);
    source.start(time);
  };
  const tone = (context: AudioContext, out: AudioNode, time: number, type: OscillatorType, from: number, to: number, length: number, gain: number) => {
    const oscillator = context.createOscillator(), volume = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, time);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), time + length);
    volume.gain.setValueAtTime(0.0001, time);
    volume.gain.exponentialRampToValueAtTime(gain, time + Math.min(0.04, length * 0.3));
    volume.gain.exponentialRampToValueAtTime(0.0001, time + length);
    oscillator.connect(volume).connect(out);
    oscillator.start(time);
    oscillator.stop(time + length + 0.02);
  };
  const sounds = {
    groan: (at: THREE.Vector3, pitch: number) => voice(at, (c, out, t) => {
      const filter = c.createBiquadFilter();
      filter.type = "bandpass"; filter.frequency.value = 420 * pitch; filter.Q.value = 2.2;
      filter.connect(out);
      const length = 0.7 + Math.random() * 0.6;
      tone(c, filter, t, "sawtooth", (95 + Math.random() * 30) * pitch, (62 + Math.random() * 20) * pitch, length, 0.9);
      tone(c, filter, t + 0.05, "sawtooth", 143 * pitch, 88 * pitch, length * 0.8, 0.4);
    }, 0.5),
    thud: (at: THREE.Vector3) => voice(at, (c, out, t) => { noise(c, out, t, 520, 0.09, 1); tone(c, out, t, "sine", 150, 60, 0.09, 0.5); }, 0.5),
    pop: (at: THREE.Vector3) => voice(at, (c, out, t) => { noise(c, out, t, 1400, 0.14, 1, "bandpass"); noise(c, out, t, 300, 0.2, 1); tone(c, out, t, "sine", 210, 50, 0.16, 0.8); }, 0.7),
    marker: (headshot: boolean) => voice(null, (c, out, t) => { tone(c, out, t, "square", headshot ? 2300 : 1500, headshot ? 1800 : 1300, 0.045, 0.5); }, 0.12),
    hurt: () => voice(null, (c, out, t) => { noise(c, out, t, 260, 0.22, 1); tone(c, out, t, "sine", 90, 38, 0.24, 1); }, 0.75),
    stinger: () => voice(null, (c, out, t) => { tone(c, out, t, "sawtooth", 58, 36, 1.6, 0.5); tone(c, out, t, "sine", 44, 30, 2, 0.9); noise(c, out, t, 180, 1.4, 0.4); }, 0.5),
    alarm: () => voice(null, (c, out, t) => { for (let i = 0; i < 6; i += 1) tone(c, out, t + i * 0.42, "square", i % 2 ? 392 : 523, i % 2 ? 380 : 510, 0.36, 0.3); }, 0.14),
    chime: () => voice(null, (c, out, t) => { [660, 880, 1320].forEach((f, i) => tone(c, out, t + i * 0.07, "sine", f, f, 0.22, 0.5)); }, 0.3),
    clear: () => voice(null, (c, out, t) => { [392, 494, 587, 784].forEach((f, i) => tone(c, out, t + i * 0.11, "triangle", f, f, 0.34, 0.5)); }, 0.24),
    heart: () => voice(null, (c, out, t) => { tone(c, out, t, "sine", 62, 40, 0.13, 1); tone(c, out, t + 0.19, "sine", 56, 36, 0.15, 0.8); }, 0.5),
    boom: () => voice(null, (c, out, t) => { tone(c, out, t, "sine", 120, 28, 0.9, 1); noise(c, out, t, 700, 0.6, 0.7); }, 0.7),
  };
  const startDrone = () => {
    try {
      const context = options.audio();
      const volume = context.createGain();
      volume.gain.value = 0;
      volume.gain.linearRampToValueAtTime(0.05, context.currentTime + 3);
      const filter = context.createBiquadFilter();
      filter.type = "lowpass"; filter.frequency.value = 170;
      const oscillators = [41.2, 41.9, 61.7].map((frequency) => { const o = context.createOscillator(); o.type = "sawtooth"; o.frequency.value = frequency; o.connect(filter); o.start(); return o; });
      filter.connect(volume).connect(context.destination);
      drone = { stop() { volume.gain.cancelScheduledValues(context.currentTime); volume.gain.setTargetAtTime(0, context.currentTime, 0.3); oscillators.forEach((o) => o.stop(context.currentTime + 1.5)); } };
    } catch { drone = null; }
  };

  // ---- Game state -----------------------------------------------------------------
  let best = 0;
  try { best = Number(window.localStorage.getItem(BEST_KEY)) || 0; } catch { best = 0; }
  const hud: HordeHud = { phase: "idle", wave: 0, remaining: 0, score: 0, best, kills: 0, health: 100, multiplier: 1, combo: 0, countdown: 0, boost: 0, banner: "", detail: "", bannerId: 0, hitId: 0, headshot: false, killId: 0, hurtId: 0 };
  let phase: HordePhase = "idle";
  let queue: ZombieKind[] = [];
  let spawnTimer = 0, phaseTimer = 0, maxAlive = 0, spawnEvery = 1;
  let streak = 0, comboTimer = 0, lastHurt = -1e9, heartTimer = 0, boostTimer = 0, hudTimer = 0, mood = 0;
  const targets: THREE.Object3D[] = [];
  const player = new THREE.Vector3();
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

  const publish = () => {
    hud.phase = phase;
    hud.remaining = queue.length + zombies.filter((z) => z.state !== "free" && z.state !== "dying" && z.state !== "dead").length;
    hud.multiplier = comboMultiplier(streak);
    hud.combo = Math.max(0, comboTimer);
    hud.countdown = phase === "break" || phase === "intro" ? Math.max(0, Math.ceil(phaseTimer)) : 0;
    hud.boost = Math.max(0, boostTimer);
    hud.health = Math.max(0, Math.round(hud.health));
    options.onHud({ ...hud });
  };
  const banner = (text: string, detail = "") => { hud.banner = text; hud.detail = detail; hud.bannerId += 1; };
  const refreshTargets = () => {
    targets.length = 0;
    zombies.forEach((z) => { if (z.state === "rising" || z.state === "chasing" || z.state === "attacking") z.meshes.forEach((mesh) => { if (mesh.visible) targets.push(mesh); }); });
  };

  const beginWave = (wave: number) => {
    const plan = wavePlan(wave);
    hud.wave = wave;
    queue = spawnOrder(plan);
    maxAlive = Math.min(POOL, plan.maxAlive);
    spawnEvery = plan.spawnEvery;
    spawnTimer = 0.6;
    phase = "wave";
    banner(`WAVE ${wave}`, plan.brutes > 0 ? "BRUTES INCOMING" : plan.runners > 0 ? "RUNNERS IN THE PACK" : "THEY ARE COMING THROUGH THE FLOOR");
    sounds.stinger();
    publish();
  };

  const spawn = (kind: ZombieKind, now: number) => {
    const z = zombies.find((candidate) => candidate.state === "free");
    if (!z) return false;
    let x = 0, zz = 0, found = false;
    for (let attempt = 0; attempt < 24 && !found; attempt += 1) {
      x = (Math.random() * 2 - 1) * BOUNDS.x;
      zz = BOUNDS.zMin + Math.random() * (BOUNDS.zMax - BOUNDS.zMin);
      const distance = Math.hypot(x - player.x, zz - player.z);
      found = distance > 7 && distance < 22 && obstacles.every((o) => Math.hypot(x - o.x, zz - o.z) > o.r + 0.7)
        && zombies.every((other) => other.state === "free" || Math.hypot(x - other.root.position.x, zz - other.root.position.z) > 1.4);
    }
    if (!found) return false;
    const stats = zombieStats(kind, hud.wave);
    z.kind = kind; z.health = stats.health; z.speed = stats.speed * (0.88 + Math.random() * 0.24); z.damage = stats.damage; z.scale = stats.scale * (0.95 + Math.random() * 0.1);
    z.state = "rising"; z.timer = 0; z.stagger = 0; z.fall = Math.random() < 0.5 ? 1 : -1; z.struck = false; z.headless = false;
    z.phase = Math.random() * 6.28; z.quirk = Math.random(); z.groanAt = now + 400 + Math.random() * 2500;
    z.root.position.set(x, -1.75 * z.scale, zz);
    z.root.scale.setScalar(z.scale);
    if (kind === "brute") z.spine.scale.set(1.32, 1.08, 1.3); else z.spine.scale.setScalar(1);
    z.facing = Math.atan2(player.x - x, player.z - zz);
    z.root.rotation.set(0, z.facing, 0);
    z.meshes.forEach((mesh) => { mesh.visible = true; });
    z.arms.forEach((arm) => { arm.gone = false; });
    z.eyes.visible = true;
    z.eyes.material = eyeMaterials[kind];
    z.blob.visible = true;
    z.root.visible = true;
    const rift = rifts[riftCursor];
    riftCursor = (riftCursor + 1) % rifts.length;
    rift.mesh.position.set(x, 0.02, zz); rift.life = 1.6; rift.mesh.visible = true;
    spray(tmp.set(x, 0.05, zz), tmp2.set(0, 1.4, 0), 26, 2.2, DUST, 1.6);
    sounds.groan(z.root.position, kind === "brute" ? 0.62 : kind === "runner" ? 1.35 : 1);
    refreshTargets();
    return true;
  };

  const kill = (z: Zombie, headshot: boolean, direction: THREE.Vector3, now: number) => {
    z.state = "dying"; z.timer = 0;
    // Fall away from the shot.
    const forward = tmp2.set(Math.sin(z.facing), 0, Math.cos(z.facing));
    z.fall = forward.dot(direction) > 0 ? 1 : -1;
    streak += 1; comboTimer = 3.6;
    hud.kills += 1; hud.killId += 1;
    hud.score += killScore(z.kind, hud.wave, headshot, streak - 1);
    if (headshot) banner("HEADSHOT", `+${killScore(z.kind, hud.wave, true, streak - 1)}`);
    else if (streak > 0 && streak % 5 === 0) banner(`${streak} KILL STREAK`, `SCORE ×${comboMultiplier(streak)}`);
    if (!pickup.mesh.visible && phase === "wave" && Math.random() < (z.kind === "brute" ? 0.6 : 0.085)) {
      const roll = Math.random();
      pickup.kind = hud.health < 45 || roll < 0.4 ? "MEDKIT" : roll < 0.75 ? "OVERDRIVE" : "SHOCKWAVE";
      pickup.life = 14;
      pickup.mesh.position.set(z.root.position.x, 0.75, z.root.position.z);
      pickup.halo.position.set(z.root.position.x, 0.03, z.root.position.z);
      pickupMaterial.color.copy(pickupColors[pickup.kind]);
      pickupHalo.color.copy(pickupColors[pickup.kind]);
      pickup.mesh.visible = true; pickup.halo.visible = true;
    }
    void now;
    refreshTargets();
  };

  const damage = (z: Zombie, amount: number, headshot: boolean, point: THREE.Vector3, direction: THREE.Vector3, now: number) => {
    z.health -= amount;
    z.stagger = z.kind === "brute" ? 0.45 : 1;
    spray(point, tmp.copy(direction).multiplyScalar(0.6).setY(0.35), headshot ? 14 : 8, 3.2, RED, 1.1);
    if (z.health > 0) { sounds.thud(point); return; }
    if (headshot) {
      z.headless = true;
      z.skull.visible = false; z.eyes.visible = false;
      z.head.getWorldPosition(tmp);
      spray(tmp, tmp2.set(direction.x * 0.5, 1.1, direction.z * 0.5), 46, 4.6, RED, 1.9);
      sounds.pop(point);
    } else sounds.thud(point);
    kill(z, headshot, direction, now);
  };

  const hurt = (amount: number, now: number) => {
    if (phase === "over") return;
    hud.health -= amount;
    hud.hurtId += 1;
    lastHurt = now;
    streak = 0; comboTimer = 0;
    sounds.hurt();
    options.onHurt(amount);
    if (hud.health <= 0) {
      hud.health = 0;
      phase = "over";
      if (hud.score > best) { best = hud.score; hud.best = best; try { window.localStorage.setItem(BEST_KEY, String(best)); } catch { /* private mode */ } }
      banner("YOU WERE OVERRUN", `WAVE ${hud.wave} · ${hud.kills} KILLS`);
      sounds.boom();
    }
    publish();
  };

  const release = (z: Zombie) => { z.state = "free"; z.root.visible = false; };

  const pose = (z: Zombie, dt: number, moving: number) => {
    const runner = z.kind === "runner", brute = z.kind === "brute";
    const stride = runner ? 0.95 : brute ? 0.5 : 0.55;
    const s = Math.sin(z.phase), c = Math.cos(z.phase);
    const k = Math.min(1, dt * 12);
    const to = (object: THREE.Object3D, x: number, y: number, zr: number) => {
      object.rotation.x += (x - object.rotation.x) * k;
      object.rotation.y += (y - object.rotation.y) * k;
      object.rotation.z += (zr - object.rotation.z) * k;
    };
    const lean = (runner ? 0.5 : brute ? 0.3 : 0.2 + z.quirk * 0.16) - z.stagger * 0.5;
    to(z.spine, lean, s * 0.12 * moving, c * (brute ? 0.13 : 0.08) * moving + (z.quirk - 0.5) * 0.2);
    to(z.hips, 0, 0, s * 0.07 * moving);
    z.hips.position.y = 0.93 - (runner ? 0.06 : 0.02) + Math.abs(c) * 0.035 * moving;
    to(z.head, (z.headless ? 0 : -lean * 0.6) + Math.sin(z.phase * 0.5) * 0.08, Math.sin(z.phase * 0.37 + z.quirk * 9) * 0.25, (z.quirk - 0.5) * 0.7);
    z.legs.forEach((leg, i) => {
      const swing = (i === 0 ? s : -s) * stride * moving;
      // A dragging leg gives each walker its own gait.
      const drag = !runner && i === (z.quirk > 0.5 ? 1 : 0) ? 0.45 : 1;
      to(leg.root, -swing * drag + (runner ? -0.25 : 0), 0, (i === 0 ? -1 : 1) * 0.04);
      to(leg.joint, Math.max(0, (i === 0 ? -c : c)) * stride * 1.3 * moving * drag + 0.1 + (runner ? 0.3 : 0), 0, 0);
    });
    z.arms.forEach((arm, i) => {
      const side = i === 0 ? -1 : 1;
      if (z.state === "attacking") {
        const wind = z.timer < 0.34 ? z.timer / 0.34 : 1 - Math.min(1, (z.timer - 0.34) / 0.16);
        to(arm.root, -1.2 - wind * 1.5 + (z.timer >= 0.34 ? 1.1 : 0), 0, side * (0.25 - wind * 0.2));
        to(arm.joint, -0.5 + wind * 0.3, 0, 0);
      } else if (runner) {
        to(arm.root, (i === 0 ? -s : s) * 1 * moving - 0.5, 0, side * 0.25);
        to(arm.joint, -1.1, 0, 0);
      } else if (brute) {
        to(arm.root, -0.5 + (i === 0 ? -s : s) * 0.3 * moving, 0, side * 0.5);
        to(arm.joint, -0.6, 0, 0);
      } else {
        const droop = i === (z.quirk > 0.5 ? 0 : 1) ? 0.55 : 0;
        to(arm.root, -1.32 + droop + (i === 0 ? s : c) * 0.1, 0, side * (0.1 - droop * 0.2));
        to(arm.joint, -0.28 - droop * 0.5 + c * 0.08, 0, 0);
      }
    });
  };

  const hordeUpdate = (now: number, dt: number) => {
    let alive = 0;
    for (const z of zombies) {
      if (z.state === "free") continue;
      z.timer += dt;
      z.stagger = Math.max(0, z.stagger - dt * 4);
      const position = z.root.position;
      if (z.state === "rising") {
        alive += 1;
        const t = Math.min(1, z.timer / 1.35);
        position.y = -1.75 * z.scale * (1 - t * t * (3 - 2 * t));
        z.phase += dt * 5;
        pose(z, dt, 0.25);
        z.arms.forEach((arm, i) => { arm.root.rotation.x = -2.6 + Math.sin(z.phase + i * 2) * 0.35; arm.joint.rotation.x = -0.4; });
        if (t >= 1) { z.state = "chasing"; z.timer = 0; }
        continue;
      }
      if (z.state === "dying") {
        const t = Math.min(1, z.timer / 0.62);
        const fallen = t * t;
        z.root.rotation.x = -z.fall * fallen * (Math.PI / 2 - 0.06);
        position.y = Math.sin(fallen * Math.PI / 2) * 0.13 * z.scale;
        z.legs.forEach((leg, i) => { leg.root.rotation.x += ((i ? 0.5 : -0.2) - leg.root.rotation.x) * dt * 6; leg.joint.rotation.x += ((i ? 0.9 : 0.3) - leg.joint.rotation.x) * dt * 6; });
        z.arms.forEach((arm, i) => { arm.root.rotation.x += ((i ? -0.6 : -2.2) - arm.root.rotation.x) * dt * 6; arm.root.rotation.z += ((i ? 0.9 : -0.7) - arm.root.rotation.z) * dt * 6; });
        z.blob.visible = false;
        if (t >= 1) {
          z.state = "dead"; z.timer = 0;
          stain(position.x - Math.sin(z.facing) * z.fall * 0.9, position.z - Math.cos(z.facing) * z.fall * 0.9, 1.3 + Math.random() * 0.9);
          spray(tmp.set(position.x, 0.1, position.z), tmp2.set(0, 0.8, 0), 10, 1.6, DUST, 2);
          options.onHurt(0);
        }
        continue;
      }
      if (z.state === "dead") {
        if (z.timer > 3.2) position.y -= dt * 0.28;
        if (z.timer > 4.6) release(z);
        continue;
      }
      alive += 1;
      const dx = player.x - position.x, dz = player.z - position.z;
      const distance = Math.hypot(dx, dz) || 1;
      const over = phase === "over";
      let moving = 0;
      if (z.state === "attacking") {
        if (!z.struck && z.timer >= 0.36) {
          z.struck = true;
          if (distance < 1.9 && !over) hurt(z.damage, now);
        }
        if (z.timer >= 0.95) { z.state = "chasing"; z.timer = 0; }
      } else if (distance < (z.kind === "brute" ? 1.55 : 1.25) && !over) {
        z.state = "attacking"; z.timer = 0; z.struck = false;
        sounds.groan(position, z.kind === "brute" ? 0.7 : 1.5);
      } else {
        // Steer for the player, around the stations and each other.
        let sx = dx / distance, sz = dz / distance;
        if (over) { sx = Math.sin(z.facing + Math.sin(now * 0.0004 + z.quirk * 20) * 0.02); sz = Math.cos(z.facing); }
        for (const o of obstacles) {
          const ox = position.x - o.x, oz = position.z - o.z, od = Math.hypot(ox, oz) || 1;
          const push = 1 - (od - o.r) / 1.1;
          if (push > 0) {
            // Slide around the obstacle on whichever side leads to the player.
            const turn = Math.sign(ox * sz - oz * sx) || 1;
            sx += (ox / od) * push * 1.6 + (-oz / od) * turn * -push * 1.2;
            sz += (oz / od) * push * 1.6 + (ox / od) * turn * -push * 1.2;
          }
        }
        for (const other of zombies) {
          if (other === z || other.state === "free" || other.state === "dead" || other.state === "dying") continue;
          const ox = position.x - other.root.position.x, oz = position.z - other.root.position.z, od = Math.hypot(ox, oz);
          if (od > 0.001 && od < 0.85) { sx += (ox / od) * (0.85 - od) * 2.4; sz += (oz / od) * (0.85 - od) * 2.4; }
        }
        const length = Math.hypot(sx, sz) || 1;
        const pace = z.speed * (over ? 0.3 : 1) * (1 - z.stagger * 0.75);
        position.x = THREE.MathUtils.clamp(position.x + (sx / length) * pace * dt, -BOUNDS.x - 0.4, BOUNDS.x + 0.4);
        position.z = THREE.MathUtils.clamp(position.z + (sz / length) * pace * dt, BOUNDS.zMin - 2, BOUNDS.zMax + 1);
        let turn = Math.atan2(sx, sz) - z.facing;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        z.facing += turn * Math.min(1, dt * 5);
        moving = Math.min(1, pace / Math.max(0.4, z.speed));
        z.phase += dt * pace * (z.kind === "runner" ? 2.5 : z.kind === "brute" ? 2.3 : 3.6);
      }
      if (z.state === "attacking") z.facing = Math.atan2(dx, dz);
      z.root.rotation.set(0, z.facing, 0);
      position.y = 0;
      pose(z, dt, moving);
      if (now > z.groanAt) {
        z.groanAt = now + 2600 + Math.random() * 5200;
        sounds.groan(position, z.kind === "brute" ? 0.6 : z.kind === "runner" ? 1.3 : 0.9 + z.quirk * 0.3);
      }
    }
    return alive;
  };

  const reset = () => {
    zombies.forEach(release);
    stains.forEach((entry) => { entry.mesh.visible = false; });
    rifts.forEach((rift) => { rift.mesh.visible = false; rift.life = 0; });
    pickup.mesh.visible = false; pickup.halo.visible = false;
    shock.visible = false;
    gorePosition.fill(-999); goreLife.fill(0);
    goreGeometry.attributes.position.needsUpdate = true;
    targets.length = 0;
    queue = [];
    streak = 0; comboTimer = 0; boostTimer = 0;
  };

  return {
    get phase() { return phase; },
    get active() { return phase !== "idle"; },
    targets,
    glows,
    damageBoost: () => (boostTimer > 0 ? 2 : 1),
    start(now) {
      if (zombies.length === 0) for (let i = 0; i < POOL; i += 1) zombies.push(buildZombie(i));
      reset();
      group.visible = true;
      Object.assign(hud, { wave: 0, score: 0, kills: 0, health: 100, banner: "", detail: "" });
      phase = "intro";
      phaseTimer = 4.2;
      lastHurt = now;
      banner("CONTAINMENT BREACH", "SURVIVE THE RANGE");
      sounds.alarm();
      if (!drone) startDrone();
      publish();
    },
    stop() {
      reset();
      phase = "idle";
      drone?.stop();
      drone = null;
      publish();
    },
    hit(object, point, direction, amount, headshot, now) {
      const z = zombies[object.userData.zombie as number];
      if (!z || (z.state !== "rising" && z.state !== "chasing" && z.state !== "attacking")) return false;
      const zone = object.userData.zone as string;
      const head = zone === "head";
      hud.hitId += 1; hud.headshot = head;
      sounds.marker(head);
      let dealt = amount * (boostTimer > 0 ? 2 : 1);
      if (head) dealt *= headshot;
      else if (zone === "leg") dealt *= 0.7;
      else if (zone.startsWith("arm")) {
        dealt *= 0.6;
        const arm = z.arms[Number(zone.slice(3))];
        // Heavy hits take the forearm off.
        if (!arm.gone && dealt > 20 && Math.random() < 0.45) {
          arm.gone = true;
          arm.lower.visible = false;
          spray(point, tmp.copy(direction).setY(0.5), 22, 3.6, RED, 1.6);
          refreshTargets();
        }
      }
      damage(z, dealt, head, point, direction, now);
      publish();
      return true;
    },
    mood: () => mood,
    update(now, dt, playerPosition, yaw) {
      listenerYaw = yaw;
      const target = phase === "idle" ? 0 : 1;
      mood += (target - mood) * Math.min(1, dt * 1.6);
      if (phase === "idle") {
        if (mood < 0.01 && group.visible) group.visible = false;
        beacons.forEach((light, i) => { light.intensity = 0; glows[i].color.setScalar(0); });
        return;
      }
      player.copy(playerPosition);
      listener.copy(playerPosition);
      const sweep = now * 0.004;
      beacons.forEach((light, i) => {
        const pulse = Math.max(0, Math.sin(sweep + i * 2.1)) ** 3;
        light.intensity = mood * (8 + pulse * 62);
        glows[i].color.setRGB(1, 0.06, 0.04).multiplyScalar(mood * (0.12 + pulse * 0.9));
      });

      if (phase === "intro") {
        phaseTimer -= dt;
        if (phaseTimer <= 0) beginWave(1);
      } else if (phase === "wave") {
        spawnTimer -= dt;
        const alive = zombies.filter((z) => z.state === "rising" || z.state === "chasing" || z.state === "attacking").length;
        if (queue.length > 0 && spawnTimer <= 0 && alive < maxAlive) {
          if (spawn(queue[0], now)) queue.shift();
          spawnTimer = spawnEvery * (0.7 + Math.random() * 0.6);
        }
      } else if (phase === "break") {
        phaseTimer -= dt;
        if (phaseTimer <= 0) beginWave(hud.wave + 1);
      }

      const alive = hordeUpdate(now, dt);
      if (phase === "wave" && queue.length === 0 && alive === 0) {
        phase = "break";
        phaseTimer = 7;
        const bonus = 250 * hud.wave;
        hud.score += bonus;
        hud.health = Math.min(100, hud.health + 30);
        banner(`WAVE ${hud.wave} CLEARED`, `+${bonus} BONUS · NEXT WAVE INCOMING`);
        sounds.clear();
        publish();
      }

      // Player upkeep.
      if (comboTimer > 0) { comboTimer -= dt; if (comboTimer <= 0) streak = 0; }
      if (boostTimer > 0) boostTimer -= dt;
      if (phase !== "over" && now - lastHurt > 5000 && hud.health < 100) hud.health = Math.min(100, hud.health + dt * 7);
      if (phase !== "over" && hud.health < 36) { heartTimer -= dt; if (heartTimer <= 0) { heartTimer = 0.82; sounds.heart(); } }

      // Pickup.
      if (pickup.mesh.visible) {
        pickup.life -= dt;
        pickup.mesh.rotation.y += dt * 2.4;
        pickup.mesh.position.y = 0.75 + Math.sin(now * 0.004) * 0.1;
        const blink = pickup.life < 3 ? (Math.sin(now * 0.03) > 0 ? 1 : 0.15) : 1;
        pickup.mesh.scale.setScalar(blink);
        pickupHalo.opacity = 0.55 * blink;
        if (Math.hypot(pickup.mesh.position.x - player.x, pickup.mesh.position.z - player.z) < 1.15 && phase !== "over") {
          if (pickup.kind === "MEDKIT") { hud.health = 100; banner("MEDKIT", "HEALTH RESTORED"); }
          else if (pickup.kind === "OVERDRIVE") { boostTimer = 12; banner("OVERDRIVE", "DOUBLE DAMAGE · 12 S"); }
          else {
            banner("SHOCKWAVE", "CLEARING THE FLOOR");
            shock.position.set(player.x, 0.4, player.z); shock.visible = true; shockLife = 0.001;
            sounds.boom();
            options.onHurt(0.5);
            zombies.forEach((z) => {
              if (z.state !== "chasing" && z.state !== "attacking" && z.state !== "rising") return;
              const d = Math.hypot(z.root.position.x - player.x, z.root.position.z - player.z);
              if (d < 13) { z.spine.getWorldPosition(tmp); damage(z, z.kind === "brute" ? 450 : 9999, false, tmp.clone(), tmp2.set(z.root.position.x - player.x, 0, z.root.position.z - player.z).normalize().clone(), now); }
            });
          }
          sounds.chime();
          pickup.mesh.visible = false; pickup.halo.visible = false;
        } else if (pickup.life <= 0) { pickup.mesh.visible = false; pickup.halo.visible = false; }
      }
      if (shockLife > 0) {
        shockLife += dt;
        const t = shockLife / 0.7;
        shock.scale.setScalar(1 + t * 13);
        (shock.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);
        if (t >= 1) { shockLife = 0; shock.visible = false; }
      }

      // Effects.
      let any = false;
      for (let i = 0; i < GORE; i += 1) {
        if (goreLife[i] <= 0) continue;
        any = true;
        goreLife[i] -= dt;
        const o = i * 3;
        goreVelocity[o + 1] -= 9.8 * dt;
        gorePosition[o] += goreVelocity[o] * dt; gorePosition[o + 1] += goreVelocity[o + 1] * dt; gorePosition[o + 2] += goreVelocity[o + 2] * dt;
        if (gorePosition[o + 1] < 0.02 || goreLife[i] <= 0) { goreLife[i] = 0; gorePosition[o + 1] = -999; }
      }
      if (any) { goreGeometry.attributes.position.needsUpdate = true; goreGeometry.attributes.color.needsUpdate = true; }
      stains.forEach((entry) => { if (entry.mesh.visible && entry.grown < 1) { entry.grown = Math.min(1, entry.grown + dt * 0.5); entry.mesh.scale.setScalar(entry.size * entry.grown); } });
      rifts.forEach((rift) => {
        if (rift.life <= 0) return;
        rift.life -= dt;
        (rift.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.min(1, rift.life) * 0.8);
        if (rift.life <= 0) rift.mesh.visible = false;
      });

      hudTimer -= dt;
      if (hudTimer <= 0) { hudTimer = 0.2; publish(); }
    },
    dispose() {
      drone?.stop();
      scene.remove(group);
      disposables.forEach((item) => item.dispose());
    },
  };
}

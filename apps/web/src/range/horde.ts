import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { comboMultiplier, killScore, spawnOrder, wavePlan, zombieStats, type ZombieKind } from "./hordeRules";
import type { Glow } from "./volumetric";
import { createZombieModel, loadZombies, type ClipKey, type ZombieLibrary, type ZombieModel } from "./zombieModels";

// Wave mode.
//
// The dead climb out of the range floor in escalating waves. Bodies are skinned
// models with clip animation (see zombieModels.ts), loaded the first time the
// mode starts. Bullets hit unseen shapes that follow the bones, so a shot knows
// whether it took a head, an arm or a leg; heads and forearms come off by
// collapsing their bones. Everything is pooled: no allocation while the mode runs.
//
// Entering the mode must not stall a frame, and two things would: a light added to the
// scene (three.js builds every lit shader again for the new count) and a material drawn
// for the first time (its shader is compiled on the spot). So the alarm beacons take over
// lights the room already has, and the bodies and effects are compiled in the background
// while the alarm sounds; the first wave waits for that.

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
  /** True where one of the map's own props stands (the floor plan of range/solids.ts, once it exists). */
  solid?: (x: number, z: number) => boolean;
  audio: () => AudioContext;
  /** Where sounds connect (a mix bus with room reverb); the context's output if absent. */
  bus?: () => AudioNode;
  /**
   * Point lights of the room that the alarm may take over while the mode runs, three at most.
   * Their owner must leave a light alone while `holds` is true for it, and have it dark by
   * the time the mood reaches `ALARM_FROM`.
   */
  lamps?: THREE.PointLight[];
  /** Compiles the shaders of everything under `root` ahead of its first frame, without holding one up. */
  warm?: (root: THREE.Object3D) => Promise<unknown>;
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
  /** Fetches the models and compiles their shaders ahead of `start`, so the mode opens without waiting. */
  prepare: () => void;
  start: (now: number) => void;
  stop: () => void;
  /** True while the alarm is using this light (see `lamps`). */
  holds: (light: THREE.Light) => boolean;
  /** Applies a bullet. Returns true when it struck a zombie. */
  hit: (object: THREE.Object3D, point: THREE.Vector3, direction: THREE.Vector3, damage: number, headshot: number, now: number) => boolean;
  update: (now: number, dt: number, player: THREE.Vector3, yaw: number) => void;
  /** 0..1 blend of the room toward its wave-mode staging. */
  mood: () => number;
  dispose: () => void;
};

const POOL = 20, GORE = 420, STAINS = 36;
/** The mood at which the alarm beacons come up: below it the room's own lamps are still fading out. */
export const ALARM_FROM = 0.4;
const BOUNDS = { x: 8.3, zMin: -23, zMax: 7.2 };
const BEST_KEY = "hyperstrike.horde.best";

type Zone = "head" | "body" | "arm0" | "arm1" | "leg";
/** An unseen shape that follows one bone or a pair of them, for bullets to hit. */
type Proxy = { mesh: THREE.Mesh; zone: Zone; from: THREE.Bone; to: THREE.Bone | null; radius: number; lower: boolean; live: boolean };
type Zombie = {
  root: THREE.Group;
  model: ZombieModel;
  head: THREE.Bone;
  chest: THREE.Bone;
  forearms: [THREE.Bone, THREE.Bone];
  eyes: THREE.Mesh;
  proxies: Proxy[];
  actions: Partial<Record<ClipKey, THREE.AnimationAction>>;
  playing: ClipKey | null;
  gait: ClipKey;
  blob: THREE.Mesh;
  kind: ZombieKind;
  state: "free" | "rising" | "chasing" | "attacking" | "dying" | "dead";
  health: number;
  speed: number;
  damage: number;
  scale: number;
  timer: number;
  stagger: number;
  facing: number;
  fall: number;
  struck: boolean;
  groanAt: number;
  quirk: number;
  headless: boolean;
  armGone: [boolean, boolean];
  /** The obstacle being walked around (-1 for none) and the side chosen to pass it on. */
  skirting: number;
  detour: number;
  /** Seconds spent pressed against one of the map's props; long enough and it shoulders through. */
  held: number;
  /** The sidestep being held to get round a prop: its axis (0 none, 1 x, 2 z) and direction. */
  sideAxis: number;
  sidestep: number;
};

/** Seconds an attack lasts, and when in it the blow lands. */
const ATTACK = 0.95, STRIKE = 0.36;

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
  const solid = options.solid ?? (() => false);
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const disposables: Array<{ dispose: () => void }> = [];
  const keep = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item; };

  // ---- Shared pieces --------------------------------------------------------------
  const eyeMaterials = {
    walker: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 3.4, 0.5), toneMapped: false })),
    runner: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(4.2, 1.5, 0.15), toneMapped: false })),
    brute: keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.25, 0.15), toneMapped: false })),
  };
  const eyeGeometry = keep(mergeGeometries([-0.034, 0.034].map((x) => new THREE.SphereGeometry(0.011, 8, 6).translate(x, 0, 0)), false)!);
  // Bullets test these instead of the skinned mesh: cheap, and each one names the part it covers.
  const proxyMaterial = keep(new THREE.MeshBasicMaterial({ visible: false }));
  const limbGeometry = keep(new THREE.CylinderGeometry(1, 1, 1, 8));
  const headGeometry = keep(new THREE.SphereGeometry(1, 10, 8));
  const blobMap = keep(softDisc("rgba(0,0,0,0.62)", "rgba(0,0,0,0)"));
  const blobMaterial = keep(new THREE.MeshBasicMaterial({ map: blobMap, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  const blobGeometry = keep(new THREE.PlaneGeometry(1.25, 1.25).rotateX(-Math.PI / 2));

  const zombies: Zombie[] = [];
  let library: ZombieLibrary | null = null, disposed = false;
  /** Set once the pool is built and its shaders are compiled: from then on showing a zombie costs nothing. */
  let staged = false;
  let preparing: Promise<void> | null = null;
  const PARTS: Array<[Zone, string, string | null, number, boolean]> = [
    ["head", "bip Head", null, 0.135, false],
    ["body", "bip Pelvis", "bip Neck", 0.2, false],
    ["arm0", "bip L UpperArm", "bip L Forearm", 0.075, false],
    ["arm0", "bip L Forearm", "bip L Hand", 0.065, true],
    ["arm1", "bip R UpperArm", "bip R Forearm", 0.075, false],
    ["arm1", "bip R Forearm", "bip R Hand", 0.065, true],
    ["leg", "bip L Thigh", "bip L Calf", 0.105, false],
    ["leg", "bip L Calf", "bip L Foot", 0.085, false],
    ["leg", "bip R Thigh", "bip R Calf", 0.105, false],
    ["leg", "bip R Calf", "bip R Foot", 0.085, false],
  ];
  const buildZombie = (index: number, models: ZombieLibrary): Zombie => {
    // Step through the bodies so neighbouring slots differ in build and skeleton.
    const model = createZombieModel(models, index * 3);
    const root = new THREE.Group();
    root.rotation.order = "YXZ";
    root.visible = false;
    root.add(model.object);
    const head = model.bone("bip Head");
    // Eyes are placed in the bind pose, then ride the head bone.
    root.updateMatrixWorld(true);
    const eyes = new THREE.Mesh(eyeGeometry, eyeMaterials.walker);
    head.getWorldPosition(eyes.position).add(tmp.set(0, 0.075, 0.098));
    root.add(eyes);
    head.attach(eyes);
    const proxies = PARTS.map(([zone, from, to, radius, lower]): Proxy => {
      const mesh = new THREE.Mesh(to ? limbGeometry : headGeometry, proxyMaterial);
      mesh.userData.zombie = index;
      mesh.userData.zone = zone;
      mesh.visible = false;
      group.add(mesh);
      return { mesh, zone, from: model.bone(from), to: to ? model.bone(to) : null, radius, lower, live: true };
    });
    const blob = new THREE.Mesh(blobGeometry, blobMaterial);
    blob.position.y = 0.012;
    blob.renderOrder = 2;
    root.add(blob);
    group.add(root);
    return {
      root, model, head, chest: model.bone("bip Spine1"), forearms: [model.bone("bip L Forearm"), model.bone("bip R Forearm")], eyes, proxies, actions: {}, playing: null, gait: "walk", blob,
      kind: "walker", state: "free", health: 0, speed: 0, damage: 0, scale: 1, timer: 0, stagger: 0, facing: 0, fall: 1, struck: false, groanAt: 0, quirk: Math.random(), headless: false, armGone: [false, false], skirting: -1, detour: 0, held: 0, sideAxis: 0, sidestep: 0,
    };
  };
  const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
  const prepare = () => {
    preparing ??= (async () => {
      const models = await loadZombies();
      if (disposed) return;
      library = models;
      // A body and its skeleton take a millisecond or two to copy: two a frame goes unnoticed.
      for (let i = 0; i < POOL; i += 1) {
        zombies.push(buildZombie(i, models));
        if (i % 2 === 1) { await nextFrame(); if (disposed) return; }
      }
      // The skinned body, the gore, the pickups: compiled now rather than on the frame that first shows them.
      await options.warm?.(group);
      staged = !disposed;
    })().catch((error) => {
      console.error("Zombie models failed to load", error);
      // Let a later start try again.
      preparing = null;
      if (phase !== "idle") { banner("ZOMBIE MODELS FAILED TO LOAD", "CHECK /models/zombies"); publish(); }
    });
  };

  // Cross-fades to a clip; `once` plays it through a single time and holds the last frame.
  const play = (z: Zombie, key: ClipKey, fade: number, once = false) => {
    let action = z.actions[key];
    if (!action) {
      action = z.model.mixer.clipAction(library!.clips[z.model.skeleton][key]);
      z.actions[key] = action;
    }
    if (z.playing === key && !once) return action;
    const previous = z.playing ? z.actions[z.playing] : undefined;
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.setEffectiveWeight(1);
    if (!once) action.time = Math.random() * action.getClip().duration;
    action.play();
    if (previous && previous !== action) action.crossFadeFrom(previous, fade, false);
    z.playing = key;
    return action;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  /** Moves the hit shapes onto the bones as they are posed this frame. */
  const placeProxies = (z: Zombie) => {
    z.root.updateMatrixWorld(true);
    const girth = z.scale * (z.kind === "brute" ? 1.15 : 1);
    for (const proxy of z.proxies) {
      proxy.from.getWorldPosition(a);
      if (!proxy.to) {
        // The head bone sits at the base of the skull.
        proxy.mesh.position.copy(a).addScaledVector(tmp.setFromMatrixColumn(proxy.from.matrixWorld, 0).normalize(), 0.09 * z.scale);
        proxy.mesh.scale.setScalar(proxy.radius * z.scale);
      } else {
        proxy.to.getWorldPosition(b);
        const length = a.distanceTo(b) || 0.001;
        proxy.mesh.position.lerpVectors(a, b, 0.5);
        proxy.mesh.quaternion.setFromUnitVectors(UP, b.sub(a).divideScalar(length));
        proxy.mesh.scale.set(proxy.radius * girth, length * 1.15, proxy.radius * girth);
      }
      proxy.mesh.updateMatrixWorld();
    }
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

  // Alarm beacons restage the room in red. They are lights the room already has, moved and
  // recoloured for as long as the mode runs, so the scene's light count never changes. Where
  // the room has too few to lend, the rest are ours and stay in the scene, dark, from the start.
  const BEACONS = [new THREE.Vector3(-6.5, 4.4, 2), new THREE.Vector3(6.5, 4.4, -10), new THREE.Vector3(-6.5, 4.4, -20)];
  const ALARM_RED = 0xff1a12, ALARM_REACH = 26, ALARM_DECAY = 1.6;
  const alarm = new THREE.Group();
  scene.add(alarm);
  const lent = (options.lamps ?? []).slice(0, BEACONS.length);
  const beacons = BEACONS.map((position, index) => {
    if (lent[index]) return lent[index];
    const light = new THREE.PointLight(ALARM_RED, 0, ALARM_REACH, ALARM_DECAY);
    light.position.copy(position);
    alarm.add(light);
    return light;
  });
  type Home = { parent: THREE.Object3D | null; position: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; decay: number };
  let homes: Home[] | null = null;
  const takeLamps = () => {
    homes = lent.map((light, index) => {
      const home: Home = { parent: light.parent, position: light.position.clone(), color: light.color.clone(), intensity: light.intensity, distance: light.distance, decay: light.decay };
      alarm.add(light);
      light.position.copy(BEACONS[index]);
      light.color.setHex(ALARM_RED);
      light.distance = ALARM_REACH; light.decay = ALARM_DECAY; light.intensity = 0;
      return home;
    });
  };
  const returnLamps = () => {
    homes?.forEach((home, index) => {
      const light = lent[index];
      (home.parent ?? scene).add(light);
      light.position.copy(home.position);
      light.color.copy(home.color);
      light.distance = home.distance; light.decay = home.decay; light.intensity = home.intensity;
    });
    homes = null;
  };
  const glows: Glow[] = BEACONS.map((position) => ({ position: position.clone(), color: new THREE.Color(0, 0, 0) }));
  /** Sweeps the beacons. `level` is 0 until the room's own lamps are out, then follows the mood up to 1. */
  const sweepAlarm = (now: number) => {
    const level = THREE.MathUtils.smoothstep(mood, ALARM_FROM, 1);
    if (level > 0 && !homes) takeLamps();
    else if (level === 0 && homes) returnLamps();
    const sweep = now * 0.004;
    beacons.forEach((light, i) => {
      const pulse = Math.max(0, Math.sin(sweep + i * 2.1)) ** 3;
      if (homes || !lent[i]) light.intensity = level * (8 + pulse * 62);
      glows[i].color.setRGB(1, 0.06, 0.04).multiplyScalar(level * (0.12 + pulse * 0.9));
    });
  };

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
      volume.connect(panner).connect(options.bus?.() ?? context.destination);
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
  // Vowels as three formant frequencies, pitched down a little: these throats are slack.
  const VOWELS = { ah: [700, 1050, 2350], uh: [580, 980, 2300], oh: [470, 760, 2300], oo: [310, 800, 2150], eh: [520, 1720, 2400], rr: [430, 1150, 1550] } as const;
  const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
  let breathNoise: AudioBuffer | null = null;
  /**
   * A voice: a rough buzz and breath (the throat) pushed through three moving resonances
   * (the mouth). `rasp` chops the buzz at `raspHz`, which is what makes it a growl.
   */
  const vocal = (c: AudioContext, out: AudioNode, t: number, v: { length: number; pitch: [number, number, number]; from: readonly number[]; to: readonly number[]; rasp: number; raspHz: number; breath: number; attack: number }) => {
    const end = t + v.length;
    const throat = c.createGain();
    throat.gain.value = 1 - v.rasp / 2;
    const chop = c.createOscillator(), chopDepth = c.createGain();
    chop.type = "sawtooth"; chop.frequency.setValueAtTime(v.raspHz, t); chop.frequency.linearRampToValueAtTime(v.raspHz * 0.7, end);
    chopDepth.gain.value = v.rasp / 2;
    chop.connect(chopDepth).connect(throat.gain);
    // Unsteady pitch: a slow wobble plus a faster flutter.
    const wobble = c.createOscillator(), wobbleDepth = c.createGain(), flutter = c.createOscillator(), flutterDepth = c.createGain();
    wobble.frequency.value = 4 + Math.random() * 3; wobbleDepth.gain.value = v.pitch[0] * 0.035;
    flutter.frequency.value = 19 + Math.random() * 9; flutterDepth.gain.value = v.pitch[0] * 0.02;
    wobble.connect(wobbleDepth); flutter.connect(flutterDepth);
    const cords = [["sawtooth", 1, 0.8], ["square", 0.5, 0.35]] as const;
    const oscillators: OscillatorNode[] = [chop, wobble, flutter];
    for (const [type, ratio, gain] of cords) {
      const oscillator = c.createOscillator(), level = c.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(v.pitch[0] * ratio, t);
      oscillator.frequency.linearRampToValueAtTime(v.pitch[1] * ratio, t + v.length * 0.35);
      oscillator.frequency.linearRampToValueAtTime(v.pitch[2] * ratio, end);
      wobbleDepth.connect(oscillator.frequency); flutterDepth.connect(oscillator.frequency);
      level.gain.value = gain;
      oscillator.connect(level).connect(throat);
      oscillators.push(oscillator);
    }
    if (!breathNoise || breathNoise.sampleRate !== c.sampleRate) {
      breathNoise = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const data = breathNoise.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    const breath = c.createBufferSource(), breathLevel = c.createGain();
    breath.buffer = breathNoise; breath.loop = true;
    breathLevel.gain.value = v.breath;
    breath.connect(breathLevel).connect(throat);
    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(1, t + v.attack);
    envelope.gain.setValueAtTime(1, t + v.length * 0.55);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    envelope.connect(out);
    [1, 0.55, 0.22].forEach((gain, index) => {
      const formant = c.createBiquadFilter(), level = c.createGain();
      formant.type = "bandpass"; formant.Q.value = 5 + index * 2.5;
      formant.frequency.setValueAtTime(v.from[index], t);
      formant.frequency.linearRampToValueAtTime(v.to[index], t + v.length * 0.7);
      level.gain.value = gain * 2.2;
      throat.connect(formant).connect(level).connect(envelope);
    });
    oscillators.forEach((oscillator) => { oscillator.start(t); oscillator.stop(end + 0.05); });
    breath.start(t, Math.random() * 0.5); breath.stop(end + 0.05);
  };
  const sounds = {
    /** A long, hollow moan from a wandering zombie: the vowel drifts as the jaw hangs. */
    moan: (at: THREE.Vector3, pitch: number) => voice(at, (c, out, t) => {
      const from = pick(["oo", "oh", "uh"] as const), to = pick(["ah", "uh", "oh"] as const), base = (88 + Math.random() * 22) * pitch;
      vocal(c, out, t, { length: 1.5 + Math.random() * 1.3, pitch: [base * 0.9, base * (1.08 + Math.random() * 0.1), base * 0.72], from: VOWELS[from], to: VOWELS[to], rasp: 0.3 + Math.random() * 0.2, raspHz: 27 + Math.random() * 8, breath: 0.16, attack: 0.28 });
    }, 0.62),
    /** A short throaty growl: mostly vocal fry. */
    growl: (at: THREE.Vector3, pitch: number) => voice(at, (c, out, t) => {
      const base = (66 + Math.random() * 14) * pitch;
      vocal(c, out, t, { length: 0.7 + Math.random() * 0.5, pitch: [base, base * 1.12, base * 0.8], from: VOWELS.rr, to: VOWELS.oh, rasp: 0.85, raspHz: 30 + Math.random() * 10, breath: 0.28, attack: 0.1 });
    }, 0.7),
    /** The lunge: a sharp open-mouthed snarl. */
    snarl: (at: THREE.Vector3, pitch: number) => voice(at, (c, out, t) => {
      const base = (130 + Math.random() * 30) * pitch;
      vocal(c, out, t, { length: 0.38 + Math.random() * 0.16, pitch: [base, base * 1.5, base * 0.85], from: VOWELS.eh, to: VOWELS.ah, rasp: 0.7, raspHz: 42 + Math.random() * 10, breath: 0.5, attack: 0.03 });
    }, 0.85),
    /** Going down: a falling groan that breaks up into a wet rattle. */
    death: (at: THREE.Vector3, pitch: number) => voice(at, (c, out, t) => {
      const base = (135 + Math.random() * 25) * pitch;
      vocal(c, out, t, { length: 1.0 + Math.random() * 0.5, pitch: [base, base * 0.8, base * 0.42], from: VOWELS.ah, to: VOWELS.oo, rasp: 0.95, raspHz: 13 + Math.random() * 5, breath: 0.4, attack: 0.03 });
    }, 0.75),
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
      filter.connect(volume).connect(options.bus?.() ?? context.destination);
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
    // The first wave waits for the bodies to be ready; the count holds at one until they are.
    hud.countdown = phase === "break" || phase === "intro" ? Math.max(phase === "intro" && !staged ? 1 : 0, Math.ceil(phaseTimer)) : 0;
    hud.boost = Math.max(0, boostTimer);
    hud.health = Math.max(0, Math.round(hud.health));
    options.onHud({ ...hud });
  };
  const banner = (text: string, detail = "") => { hud.banner = text; hud.detail = detail; hud.bannerId += 1; };
  const refreshTargets = () => {
    targets.length = 0;
    zombies.forEach((z) => { if (z.state === "rising" || z.state === "chasing" || z.state === "attacking") z.proxies.forEach((proxy) => { if (proxy.live) targets.push(proxy.mesh); }); });
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
      found = distance > 7 && distance < 22 && !solid(x, zz) && obstacles.every((o) => Math.hypot(x - o.x, zz - o.z) > o.r + 0.7)
        && zombies.every((other) => other.state === "free" || Math.hypot(x - other.root.position.x, zz - other.root.position.z) > 1.4);
    }
    if (!found) return false;
    const stats = zombieStats(kind, hud.wave);
    z.kind = kind; z.health = stats.health; z.speed = stats.speed * (0.88 + Math.random() * 0.24); z.damage = stats.damage; z.scale = stats.scale * (0.95 + Math.random() * 0.1);
    z.state = "rising"; z.timer = 0; z.stagger = 0; z.fall = Math.random() < 0.5 ? 1 : -1; z.struck = false; z.headless = false;
    z.quirk = Math.random(); z.groanAt = now + 400 + Math.random() * 2500;
    z.root.position.set(x, -1.75 * z.scale, zz);
    // Brutes are broad as well as tall.
    z.root.scale.set(z.scale * (kind === "brute" ? 1.15 : 1), z.scale, z.scale * (kind === "brute" ? 1.15 : 1));
    z.facing = Math.atan2(player.x - x, player.z - zz);
    z.root.rotation.set(0, z.facing, 0);
    z.proxies.forEach((proxy) => { proxy.live = true; });
    z.armGone = [false, false];
    z.skirting = -1; z.detour = 0; z.held = 0; z.sideAxis = 0; z.sidestep = 0;
    z.head.scale.setScalar(1);
    z.forearms.forEach((bone) => bone.scale.setScalar(1));
    z.eyes.material = eyeMaterials[kind];
    z.gait = chooseGait(z);
    z.model.mixer.stopAllAction();
    z.playing = null;
    animate(z, 0, 0);
    z.blob.visible = true;
    z.root.visible = true;
    const rift = rifts[riftCursor];
    riftCursor = (riftCursor + 1) % rifts.length;
    rift.mesh.position.set(x, 0.02, zz); rift.life = 1.6; rift.mesh.visible = true;
    spray(tmp.set(x, 0.05, zz), tmp2.set(0, 1.4, 0), 26, 2.2, DUST, 1.6);
    sounds.growl(z.root.position, kind === "brute" ? 0.7 : kind === "runner" ? 1.3 : 1);
    refreshTargets();
    return true;
  };

  const kill = (z: Zombie, headshot: boolean, direction: THREE.Vector3, now: number) => {
    z.state = "dying"; z.timer = 0;
    // A head that is gone makes no sound.
    if (!headshot) sounds.death(z.root.position, z.kind === "brute" ? 0.62 : z.kind === "runner" ? 1.25 : 0.9 + z.quirk * 0.25);
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
      z.head.getWorldPosition(tmp);
      // Collapsing the bone takes the head, jaw and eyes with it.
      z.head.scale.setScalar(0.001);
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

  /** Picks the gait whose natural speed best suits how fast this zombie moves. */
  const chooseGait = (z: Zombie): ClipKey => {
    if (z.kind === "runner") return "run";
    const pace = library!.pace[z.model.skeleton];
    const options: ClipKey[] = z.kind === "brute" ? ["aggressive", "walk"] : ["shamble", "limp", "walk", "aggressive"];
    const fit = (key: ClipKey) => Math.abs(Math.log(z.speed / (pace[key] * z.scale || 1)));
    const best = Math.min(...options.map(fit));
    // Anything nearly as good is fair game, so a pack does not march in step.
    const close = options.filter((key) => fit(key) < best + 0.25);
    return close[Math.floor(z.quirk * close.length) % close.length];
  };
  /** Advances the skeleton: clip for the state, playback matched to ground speed, flinch on a hit. */
  const animate = (z: Zombie, dt: number, pace: number) => {
    let rate = 1;
    if (z.state === "rising") { play(z, "alert", 0.2); rate = 1.6; }
    else if (z.state === "attacking") rate = z.actions[z.playing!]!.getClip().duration / ATTACK;
    else if (z.state === "dying" || z.state === "dead") rate = Math.max(0, 0.5 - z.timer * 1.2);
    else {
      play(z, z.gait, 0.25);
      rate = THREE.MathUtils.clamp(pace / (library!.pace[z.model.skeleton][z.gait] * z.scale || 1), 0.35, 2.6);
    }
    z.model.mixer.update(dt * rate);
    // Bullets knock the torso back; the mixer writes the bone again next frame.
    if (z.stagger > 0) z.chest.rotateZ(-z.stagger * 0.45);
  };

  const hordeUpdate = (now: number, dt: number) => {
    let alive = 0;
    const cover = obstacles.reduce((deepest, o) => Math.max(deepest, o.r + 0.2 - Math.hypot(player.x - o.x, player.z - o.z)), 0);
    for (const z of zombies) {
      if (z.state === "free") continue;
      z.timer += dt;
      z.stagger = Math.max(0, z.stagger - dt * 4);
      const position = z.root.position;
      if (z.state === "rising") {
        alive += 1;
        const t = Math.min(1, z.timer / 1.35);
        position.y = -1.75 * z.scale * (1 - t * t * (3 - 2 * t));
        animate(z, dt, 0);
        placeProxies(z);
        if (t >= 1) { z.state = "chasing"; z.timer = 0; }
        continue;
      }
      if (z.state === "dying") {
        const t = Math.min(1, z.timer / 0.62);
        const fallen = t * t;
        z.root.rotation.x = -z.fall * fallen * (Math.PI / 2 - 0.06);
        position.y = Math.sin(fallen * Math.PI / 2) * 0.13 * z.scale;
        animate(z, dt, 0);
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
      let moved = 0;
      // A player standing on a station is out of arm's reach from its edge, so reach grows by how deep they stand.
      const reach = cover + (z.kind === "brute" ? 1.55 : 1.25);
      if (z.state === "attacking") {
        if (!z.struck && z.timer >= STRIKE) {
          z.struck = true;
          if (distance < reach + 0.65 && !over) hurt(z.damage, now);
        }
        if (z.timer >= ATTACK) { z.state = "chasing"; z.timer = 0; }
      } else if (distance < reach && !over) {
        z.state = "attacking"; z.timer = 0; z.struck = false;
        play(z, Math.random() < 0.5 ? "attackLeft" : "attackRight", 0.12, true);
        sounds.snarl(position, z.kind === "brute" ? 0.62 : z.kind === "runner" ? 1.25 : 0.95 + z.quirk * 0.2);
      } else {
        // Steer for the player, around the stations and each other.
        let sx = dx / distance, sz = dz / distance;
        if (over) { sx = Math.sin(z.facing + Math.sin(now * 0.0004 + z.quirk * 20) * 0.02); sz = Math.cos(z.facing); }
        const hx = sx, hz = sz;
        let skirting = -1;
        for (let i = 0; i < obstacles.length; i += 1) {
          const o = obstacles[i];
          const ox = position.x - o.x, oz = position.z - o.z, od = Math.hypot(ox, oz) || 1;
          const push = Math.min(1.4, 1 - (od - o.r) / 1.1);
          // Only an obstacle that lies ahead needs going around.
          const inward = -(hx * ox + hz * oz) / od;
          if (push <= 0 || inward <= 0) continue;
          skirting = i;
          // Pick a side once and keep it until clear: re-deciding every frame is what left
          // zombies shuffling on the spot when the player stood straight across a station.
          if (z.skirting !== i || z.detour === 0) {
            const lead = -oz * hx + ox * hz;
            z.detour = Math.abs(lead) > 0.12 ? Math.sign(lead) : z.quirk > 0.5 ? 1 : -1;
          }
          const tx = (-oz / od) * z.detour, tz = (ox / od) * z.detour;
          // Drop the part of the heading that runs into the obstacle, then slide along its edge.
          sx += (ox / od) * inward * push + tx * push * 1.8 + (ox / od) * Math.max(0, push - 0.7);
          sz += (oz / od) * inward * push + tz * push * 1.8 + (oz / od) * Math.max(0, push - 0.7);
        }
        z.skirting = skirting;
        if (skirting < 0) z.detour = 0;
        for (const other of zombies) {
          if (other === z || other.state === "free" || other.state === "dead" || other.state === "dying") continue;
          const ox = position.x - other.root.position.x, oz = position.z - other.root.position.z, od = Math.hypot(ox, oz);
          if (od > 0.001 && od < 0.85) { sx += (ox / od) * (0.85 - od) * 2.4; sz += (oz / od) * (0.85 - od) * 2.4; }
        }
        const length = Math.hypot(sx, sz) || 1;
        const pace = z.speed * (over ? 0.3 : 1) * (1 - z.stagger * 0.75);
        const fromX = position.x, fromZ = position.z;
        position.x = THREE.MathUtils.clamp(position.x + (sx / length) * pace * dt, -BOUNDS.x - 0.4, BOUNDS.x + 0.4);
        position.z = THREE.MathUtils.clamp(position.z + (sz / length) * pace * dt, BOUNDS.zMin - 2, BOUNDS.zMax + 1);
        // Steering is a suggestion; this is the wall. Nothing ends a frame inside an obstacle.
        for (const o of obstacles) {
          const ox = position.x - o.x, oz = position.z - o.z, od = Math.hypot(ox, oz);
          if (od < o.r) { const out = od > 0.001 ? o.r / od : 1; position.x = o.x + (od > 0.001 ? ox * out : o.r); position.z = o.z + oz * out; }
        }
        // The map's crates, carts and stalls. There is no route finding here, so a blocked zombie
        // first keeps whatever part of its heading is still open (which slides it along a stall front),
        // and otherwise sidesteps across its heading, towards the middle of the range where the lanes
        // are clear, holding that side until it is round. One that stays pinned for a second shoulders
        // through rather than standing behind a barrel all wave.
        if (z.held < 1 && !solid(fromX, fromZ) && solid(position.x, position.z)) {
          const step = pace * dt, wantX = Math.sign(sx), wantZ = Math.sign(sz);
          const openX = (dir: number) => dir !== 0 && !solid(fromX + dir * step, fromZ);
          const openZ = (dir: number) => dir !== 0 && !solid(fromX, fromZ + dir * step);
          // Never let the heading undo a sidestep in progress: that is how one ends up pacing a crate.
          const keepX = Math.abs(sx) > 0.35 * length && !(z.sideAxis === 1 && wantX !== z.sidestep) && openX(wantX);
          const keepZ = Math.abs(sz) > 0.35 * length && !(z.sideAxis === 2 && wantZ !== z.sidestep) && openZ(wantZ);
          let moveX = 0, moveZ = 0, patience = 1;
          if (keepZ && (!keepX || Math.abs(sz) >= Math.abs(sx))) { moveZ = wantZ; patience = 0.2; }
          else if (keepX) { moveX = wantX; patience = 0.2; }
          else {
            if (z.sideAxis === 0) {
              if (Math.abs(sz) >= Math.abs(sx)) { z.sideAxis = 1; z.sidestep = Math.abs(fromX) > 1 ? -Math.sign(fromX) : z.quirk > 0.5 ? 1 : -1; }
              else { z.sideAxis = 2; z.sidestep = Math.abs(dz) > 0.5 ? Math.sign(dz) : z.quirk > 0.5 ? 1 : -1; }
            }
            if (z.sideAxis === 1 && openX(z.sidestep)) moveX = z.sidestep;
            else if (z.sideAxis === 2 && openZ(z.sidestep)) moveZ = z.sidestep;
          }
          position.x = fromX + moveX * step;
          position.z = fromZ + moveZ * step;
          z.held += dt * patience;
        } else if (!solid(position.x, position.z)) {
          z.held = Math.max(0, z.held - dt * 0.5);
          if (z.held === 0) z.sideAxis = 0;
        }
        let turn = Math.atan2(sx, sz) - z.facing;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        z.facing += turn * Math.min(1, dt * 5);
        moved = pace;
      }
      if (z.state === "attacking") z.facing = Math.atan2(dx, dz);
      z.root.rotation.set(0, z.facing, 0);
      position.y = 0;
      animate(z, dt, moved);
      placeProxies(z);
      if (now > z.groanAt) {
        z.groanAt = now + 2600 + Math.random() * 5200;
        const voicePitch = z.kind === "brute" ? 0.62 : z.kind === "runner" ? 1.3 : 0.85 + z.quirk * 0.35;
        if (Math.random() < (z.kind === "runner" ? 0.6 : 0.3)) sounds.growl(position, voicePitch);
        else sounds.moan(position, voicePitch);
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
    prepare,
    holds: (light) => homes !== null && lent.includes(light as THREE.PointLight),
    start(now) {
      prepare();
      reset();
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
      // A weapon with no headshot multiplier (the knife) cuts the head like any other part.
      const head = zone === "head" && headshot > 0;
      hud.hitId += 1; hud.headshot = head;
      sounds.marker(head);
      let dealt = amount * (boostTimer > 0 ? 2 : 1);
      if (head) dealt *= headshot;
      else if (zone === "leg") dealt *= 0.7;
      else if (zone.startsWith("arm")) {
        dealt *= 0.6;
        const side = Number(zone.slice(3));
        // Heavy hits take the forearm off.
        if (!z.armGone[side] && dealt > 20 && Math.random() < 0.45) {
          z.armGone[side] = true;
          z.forearms[side].scale.setScalar(0.001);
          z.proxies.forEach((proxy) => { if (proxy.zone === zone && proxy.lower) proxy.live = false; });
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
      if (phase === "idle" && mood < 0.002) mood = 0;
      sweepAlarm(now);
      if (phase === "idle") {
        if (group.visible) group.visible = false;
        return;
      }
      // Nothing of the mode is drawn before its shaders are compiled.
      if (staged && !group.visible) group.visible = true;
      player.copy(playerPosition);
      listener.copy(playerPosition);

      if (phase === "intro") {
        phaseTimer -= dt;
        if (phaseTimer <= 0 && staged) beginWave(1);
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
              if (d < 13) { z.chest.getWorldPosition(tmp); damage(z, z.kind === "brute" ? 450 : 9999, false, tmp.clone(), tmp2.set(z.root.position.x - player.x, 0, z.root.position.z - player.z).normalize().clone(), now); }
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
      disposed = true;
      returnLamps();
      library?.dispose();
      drone?.stop();
      scene.remove(group, alarm);
      disposables.forEach((item) => item.dispose());
    },
  };
}

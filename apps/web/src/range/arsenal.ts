import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ARSENAL, type WeaponId, type WeaponSpec } from "./arsenalSpec";
import type { Mover } from "./collider";
import { blendPose, resolvePose, type HandPose, type ResolvedPose } from "./hands";
import { DEAGLE_SKINS, FAMAS_SKINS, M4_SKINS, UZI_SKINS, type Skin } from "./skins";
import { createFinishKit, prepareRifle, surfaceBuilt, surfaceWeapon, type FinishKit, type WeaponSurfacing } from "./weapon";

// The six weapons.
//
// Every weapon lives in the same "weapon space": real metres, bore along -Z,
// +Y up, origin where the web of the firing hand meets the grip. The AK and
// the bolt-action are authored models normalised into that space; the M4, FAMAS,
// Uzi and Desert Eagle are modelled here from extruded side profiles, turned parts and
// chamfered blocks, then surfaced with the same edge-wear materials and skinned
// after the index illustrations (see skins.ts).
//
// Each weapon carries its grips (where both hands rest) and timelines for the
// reload and, where the action shows it, for what happens between shots: the
// bolt-action being worked, the pistol's slide coming back.

type V3 = [number, number, number];
export type ReloadSound = "magOut" | "magIn" | "rack" | "slap" | "boltUp" | "boltBack" | "boltHome" | "cloth";
/**
 * `toRest` blends the pose back toward the weapon's resting grip: 1 is that grip exactly, wherever fitting seated it.
 * `via` marks a place the hand only passes through, on its way round something: it does not slow down for it.
 */
type HandKey = { t: number; pose: HandPose; toRest?: number; via?: boolean };
type PartKey = { t: number; p?: V3; r?: V3; hide?: boolean };
export type Timeline = {
  /** Keys are dense samples of a motion that carries its own easing: read them straight, without easing each step. */
  sampled?: boolean;
  left?: HandKey[];
  right?: HandKey[];
  body?: PartKey[];
  parts?: Record<string, PartKey[]>;
  sounds?: Array<{ t: number; kind: ReloadSound }>;
  /** Moment a spent case leaves the action, where that is not the instant of the shot (bolt-action). */
  eject?: number;
};

export type RigPose = { left: ResolvedPose; right: ResolvedPose; bodyPosition: THREE.Vector3; bodyRotation: THREE.Euler };

export type WeaponRig = {
  spec: WeaponSpec;
  /** Weapon-space root. Empty until an authored model has loaded. */
  root: THREE.Group;
  muzzle: THREE.Object3D;
  /** Where spent cases leave, in weapon space. */
  port: THREE.Vector3;
  /** Extra placement of the whole weapon in view: metres and radians. */
  view: { p: V3; r: V3 };
  reload: Timeline;
  cycle?: Timeline;
  /** True once the weapon's geometry is in `root`. */
  ready: boolean;
  /** Runs `apply` once over the two resting grips, which it may move. */
  fit: (apply: (pose: ResolvedPose, left: boolean) => void) => void;
  /** Parts that move during a reload, with where each rests. */
  movers: () => Mover[];
  /** Poses hands and moving parts. `timeline` null rests everything. */
  pose: (timeline: Timeline | null, t: number, out: RigPose) => void;
};

export type Arsenal = { rigs: WeaponRig[]; byId: (id: WeaponId) => WeaponRig; dispose: () => void };

const ease = (t: number) => t * t * (3 - 2 * t);
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const hand = (p: V3, f: V3, n: V3, curl: number | number[]): HandPose => ({ p, f, n, curl });
const moved = (pose: HandPose, by: V3, curl?: number | number[]): HandPose => ({ ...pose, p: add(pose.p, by), curl: curl ?? pose.curl });

// ---- Modelling helpers ------------------------------------------------------

type Builder = ReturnType<typeof createBuilder>;

function createBuilder() {
  const root = new THREE.Group();
  const parts = new Map<string, THREE.Group>([["body", root]]);
  const pending: Array<{ group: THREE.Group; finish: string; geometry: THREE.BufferGeometry }> = [];
  let current = root;
  const place = (geometry: THREE.BufferGeometry, at: V3, finish: string, rotation?: V3) => {
    if (rotation) geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(at[0] - current.position.x, at[1] - current.position.y, at[2] - current.position.z);
    pending.push({ group: current, finish, geometry });
  };
  return {
    root,
    parts,
    /** Subsequent geometry belongs to a separately animated part pivoting at `pivot`. */
    part(name: string, pivot: V3 = [0, 0, 0]) {
      if (name === "body") { current = root; return; }
      const group = new THREE.Group();
      group.position.set(...pivot);
      root.add(group);
      parts.set(name, group);
      current = group;
    },
    box(w: number, h: number, d: number, at: V3, finish: string, rotation?: V3, chamfer = 0.0016) {
      const c = Math.min(chamfer, w * 0.3, h * 0.3, d * 0.3);
      place(c > 0.0004 ? new RoundedBoxGeometry(w, h, d, 1, c) : new THREE.BoxGeometry(w, h, d), at, finish, rotation);
    },
    /** Cylinder along `axis`, optionally tapered (r → r2 toward +axis). */
    cyl(r: number, length: number, at: V3, finish: string, axis: "x" | "y" | "z" = "z", r2 = r, segments = 18) {
      const geometry = new THREE.CylinderGeometry(r2, r, length, segments, 1);
      if (axis === "z") geometry.rotateX(Math.PI / 2);
      if (axis === "x") geometry.rotateZ(-Math.PI / 2);
      place(geometry, at, finish);
    },
    /** Hollow tube along Z. */
    tube(outer: number, inner: number, length: number, at: V3, finish: string, segments = 24) {
      const h = length / 2;
      const geometry = new THREE.LatheGeometry([[inner, -h], [outer, -h], [outer, h], [inner, h], [inner, -h]].map(([x, y]) => new THREE.Vector2(x, y)), segments);
      geometry.rotateX(Math.PI / 2);
      place(geometry, at, finish);
    },
    /** Side silhouette as [z, y] points, extruded to `width` across X with chamfered edges. */
    profile(points: Array<[number, number]>, width: number, finish: string, x = 0, bevel = 0.002) {
      this.shape(new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y))), width, finish, x, bevel, 1);
    },
    /** The same from a drawn shape (z across, y up), which may have curves and holes. */
    shape(shape: THREE.Shape, width: number, finish: string, x = 0, bevel = 0.002, curveSegments = 12) {
      const b = Math.min(bevel, width * 0.3);
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: width - b * 2, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, curveSegments });
      geometry.rotateY(-Math.PI / 2);
      place(geometry, [x + width / 2 - b, 0, 0], finish);
    },
    /** Geometry already in weapon space. */
    solid(geometry: THREE.BufferGeometry, finish: string) {
      place(geometry, [0, 0, 0], finish);
    },
    /** Accessory rail: a base strip with recoil-lug teeth. `side` is the outward direction. */
    rail(z0: number, z1: number, at: [number, number], side: "top" | "bottom" | "left" | "right", finish: string) {
      const length = Math.abs(z1 - z0), mid = (z0 + z1) / 2;
      const vertical = side === "top" || side === "bottom";
      const out = side === "top" || side === "right" ? 1 : -1;
      const size = (across: number, thick: number, d: number): [number, number, number] => vertical ? [across, thick, d] : [thick, across, d];
      const shift = (o: number): V3 => vertical ? [at[0], at[1] + o * out, 0] : [at[0] + o * out, at[1], 0];
      const base = shift(0.002);
      this.box(...size(0.0155, 0.004, length), [base[0], base[1], mid], finish, undefined, 0.0008);
      const count = Math.floor(length / 0.01);
      for (let i = 0; i < count; i += 1) {
        const tooth = shift(0.0056);
        const geometry = new THREE.BoxGeometry(...size(0.021, 0.0034, 0.0052));
        place(geometry, [tooth[0], tooth[1], Math.max(z0, z1) - 0.005 - i * 0.01], finish);
      }
    },
    /** Adds an un-surfaced mesh (glass, emitters) to the current part. */
    raw(mesh: THREE.Mesh, at: V3) {
      mesh.position.set(at[0] - current.position.x, at[1] - current.position.y, at[2] - current.position.z);
      current.add(mesh);
    },
    /** Merges queued geometry into one mesh per part and finish, and paints `skins` over the finishes they name. */
    finish(kit: FinishKit, skins?: Record<string, Skin>) {
      const groups = new Map<string, { group: THREE.Group; finish: string; geometries: THREE.BufferGeometry[] }>();
      pending.forEach(({ group, finish, geometry }) => {
        const key = `${group.id}:${finish}`;
        const entry = groups.get(key) ?? { group, finish, geometries: [] };
        const flat = geometry.index ? geometry.toNonIndexed() : geometry;
        if (flat !== geometry) geometry.dispose();
        // Merging needs every piece to carry the same attributes; the surfacing unwraps them again anyway.
        if (!flat.attributes.uv) flat.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(flat.attributes.position.count * 2), 2));
        entry.geometries.push(flat);
        groups.set(key, entry);
      });
      groups.forEach(({ group, finish, geometries }) => {
        const merged = mergeGeometries(geometries, false)!;
        geometries.forEach((geometry) => geometry.dispose());
        const mesh = new THREE.Mesh(merged);
        mesh.userData.finish = finish;
        group.add(mesh);
      });
      return surfaceBuilt(root, kit, skins);
    },
  };
}

type Built = { root: THREE.Group; parts: Map<string, THREE.Object3D[]>; muzzle: V3; port: V3; dispose: () => void };
const builtParts = (b: Builder) => new Map([...b.parts].filter(([name]) => name !== "body").map(([name, group]) => [name, [group as THREE.Object3D]]));

function gripProfile(top0: number, top1: number, rake: number, length: number): Array<[number, number]> {
  return [[top0, 0.006], [top1, 0.006], [top1 + rake * 0.35, -length * 0.42], [top1 + rake + 0.004, -length], [top0 + rake + 0.012, -length], [top0 + rake * 0.55 + 0.004, -length * 0.45]];
}

function redDot(b: Builder, at: V3, extras: THREE.Material[], geometries: THREE.BufferGeometry[]) {
  const [x, y, z] = at;
  b.box(0.028, 0.014, 0.05, [x, y - 0.026, z], "anodized");
  b.box(0.034, 0.008, 0.014, [x, y - 0.03, z + 0.012], "anodized");
  b.tube(0.0205, 0.017, 0.088, at, "anodized");
  b.tube(0.0225, 0.0195, 0.012, [x, y, z - 0.04], "anodized");
  b.tube(0.0225, 0.0195, 0.012, [x, y, z + 0.04], "anodized");
  b.cyl(0.0085, 0.014, [x, y + 0.026, z + 0.012], "anodized", "y");
  b.cyl(0.0085, 0.014, [x + 0.026, y, z + 0.012], "anodized", "x");
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x31150f, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.32, envMapIntensity: 2.2, side: THREE.DoubleSide, depthWrite: false });
  const emitter = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.25, 0.18), toneMapped: false });
  const lens = new THREE.CircleGeometry(0.0172, 24), dot = new THREE.CircleGeometry(0.0011, 10);
  extras.push(glass, emitter);
  geometries.push(lens, dot);
  b.raw(new THREE.Mesh(lens, glass), [x, y, z - 0.036]);
  b.raw(new THREE.Mesh(lens, glass), [x, y, z + 0.036]);
  b.raw(new THREE.Mesh(dot, emitter), [x, y, z - 0.0355]);
}

function buildM4(kit: FinishKit): Built {
  const b = createBuilder(), B = 0.066;
  const extras: THREE.Material[] = [], geometries: THREE.BufferGeometry[] = [];
  // Upper and lower receivers.
  b.profile([[0.042, B - 0.03], [0.042, B + 0.014], [0.03, B + 0.03], [-0.168, B + 0.03], [-0.168, B - 0.03]], 0.04, "anodized");
  b.rail(0.028, -0.166, [0, B + 0.03], "top", "anodized");
  b.profile([[0.046, B - 0.03], [0.046, 0.014], [0.014, 0.002], [-0.04, 0.002], [-0.04, 0.01], [-0.086, 0.01], [-0.086, -0.03], [-0.146, -0.022], [-0.152, B - 0.03]], 0.037, "anodized");
  b.box(0.012, 0.003, 0.05, [0, -0.034, -0.063], "anodized");
  b.box(0.012, 0.03, 0.003, [0, -0.02, -0.04], "anodized", [0.35, 0, 0]);
  b.box(0.005, 0.024, 0.006, [0, -0.012, -0.058], "blued", [-0.3, 0, 0]);
  b.profile(gripProfile(0.014, -0.036, 0.03, 0.1), 0.03, "polymer", 0, 0.004);
  for (let i = 0; i < 6; i += 1) b.box(0.032, 0.003, 0.034, [0, -0.03 - i * 0.011, 0.002 + i * 0.0035], "polymer", [0.3, 0, 0], 0.001);
  // Buffer tube and stock.
  b.cyl(0.0145, 0.21, [0, B - 0.004, 0.15], "anodized");
  b.cyl(0.02, 0.012, [0, B - 0.004, 0.052], "parkerized", "z", 0.02, 12);
  b.profile([[0.125, B + 0.016], [0.272, B + 0.016], [0.28, B - 0.108], [0.256, B - 0.116], [0.214, B - 0.046], [0.125, B - 0.03]], 0.036, "polymer", 0, 0.004);
  b.box(0.038, 0.128, 0.012, [0, B - 0.047, 0.283], "rubber", undefined, 0.004);
  // Controls.
  b.cyl(0.0075, 0.022, [0.0245, B + 0.004, 0.022], "anodized");
  b.box(0.008, 0.016, 0.02, [0.022, B + 0.006, -0.03], "anodized");
  b.box(0.002, 0.021, 0.064, [0.0203, B + 0.002, -0.086], "blued", undefined, 0);
  b.box(0.003, 0.02, 0.062, [0.0225, B - 0.021, -0.086], "anodized", [0, 0, -0.25], 0.0008);
  b.cyl(0.0045, 0.006, [-0.021, 0.03, 0.006], "parkerized", "x");
  b.box(0.003, 0.006, 0.022, [-0.0215, 0.03, -0.004], "parkerized");
  b.box(0.004, 0.022, 0.012, [-0.0205, B - 0.022, -0.078], "parkerized");
  b.cyl(0.005, 0.006, [0.021, 0.02, -0.07], "parkerized", "x");
  // Barrel assembly.
  b.cyl(0.027, 0.014, [0, B, -0.174], "parkerized", "z", 0.027, 20);
  b.cyl(0.0268, 0.196, [0, B, -0.279], "anodized", "z", 0.0268, 8);
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const at: [number, number] = side === "top" ? [0, B + 0.0245] : side === "bottom" ? [0, B - 0.0245] : side === "left" ? [-0.0245, B] : [0.0245, B];
    b.rail(-0.184, -0.374, at, side, "anodized");
  }
  b.cyl(0.0088, 0.37, [0, B, -0.352], "parkerized");
  b.cyl(0.0125, 0.032, [0, B, -0.402], "parkerized");
  b.profile([[-0.386, B + 0.008], [-0.418, B + 0.008], [-0.408, B + 0.066], [-0.397, B + 0.066]], 0.011, "parkerized");
  for (const x of [-0.0065, 0.0065]) b.box(0.002, 0.016, 0.012, [x, B + 0.072, -0.4025], "parkerized", undefined, 0.0006);
  b.box(0.0022, 0.012, 0.0022, [0, B + 0.07, -0.4025], "blued", undefined, 0);
  b.cyl(0.0125, 0.006, [0, B, -0.536], "parkerized");
  b.cyl(0.0112, 0.044, [0, B, -0.558], "blued", "z", 0.0112, 12);
  redDot(b, [0, B + 0.074, -0.085], extras, geometries);
  // Moving parts.
  b.part("charge", [0, B + 0.022, 0.04]);
  b.box(0.012, 0.008, 0.06, [0, B + 0.022, 0.018], "anodized");
  b.box(0.054, 0.009, 0.012, [0, B + 0.022, 0.05], "anodized");
  b.part("bolt", [0.0206, B + 0.002, -0.086]);
  b.box(0.003, 0.015, 0.056, [0.0206, B + 0.002, -0.086], "bright", undefined, 0.0006);
  b.part("mag", [0, -0.02, -0.116]);
  b.profile([[-0.09, 0.012], [-0.142, 0.014], [-0.152, -0.1], [-0.165, -0.186], [-0.108, -0.196], [-0.1, -0.1]], 0.023, "polymer", 0, 0.003);
  for (let i = 0; i < 5; i += 1) b.box(0.0255, 0.004, 0.05, [0, -0.06 - i * 0.026, -0.124 - i * 0.0026], "polymer", [-0.1, 0, 0], 0.001);
  b.box(0.027, 0.008, 0.062, [0, -0.193, -0.137], "polymer", [-0.17, 0, 0]);
  const surface = b.finish(kit, M4_SKINS);
  return { root: b.root, parts: builtParts(b), muzzle: [0, B, -0.582], port: [0.03, B, -0.085], dispose() { surface.dispose(); extras.forEach((m) => m.dispose()); geometries.forEach((g) => g.dispose()); } };
}

function buildFamas(kit: FinishKit): Built {
  const b = createBuilder(), B = 0.05;
  // One-piece bullpup body: handguard, receiver and stock.
  b.profile([[-0.21, B + 0.03], [-0.21, B - 0.03], [-0.13, B - 0.046], [0.02, B - 0.05], [0.074, B - 0.05], [0.09, -0.03], [0.168, -0.03], [0.2, -0.052], [0.398, -0.092], [0.404, B + 0.03], [0.362, B + 0.047], [0.17, B + 0.047], [0.15, B + 0.03]], 0.05, "grey", 0, 0.006);
  b.box(0.053, 0.14, 0.014, [0, -0.012, 0.408], "rubber", undefined, 0.005);
  for (let i = 0; i < 5; i += 1) b.box(0.052, 0.004, 0.05, [0, B - 0.004 - i * 0.008, -0.165], "grey", undefined, 0.001);
  b.box(0.03, 0.012, 0.31, [0, B + 0.034, -0.03], "parkerized");
  // Grip and whole-hand trigger guard.
  b.profile(gripProfile(0.016, -0.034, 0.028, 0.105), 0.032, "grey", 0, 0.004);
  // The guard is one loop: down from the body ahead of the trigger, and back to the foot of the grip.
  b.box(0.02, 0.006, 0.084, [0, -0.1018, -0.0428], "grey", [-0.043, 0, 0], 0.002);
  b.box(0.02, 0.112, 0.007, [0, -0.05, -0.085], "grey", [-0.046, 0, 0], 0.002);
  b.box(0.005, 0.03, 0.007, [0, -0.012, -0.05], "blued", [-0.25, 0, 0]);
  // The carrying handle that gives the rifle its silhouette.
  b.profile([[0.142, B + 0.03], [0.098, B + 0.03], [0.082, B + 0.098], [0.112, B + 0.098]], 0.022, "grey", 0, 0.003);
  b.profile([[-0.162, B + 0.03], [-0.206, B + 0.03], [-0.182, B + 0.098], [-0.158, B + 0.098]], 0.022, "grey", 0, 0.003);
  b.box(0.022, 0.014, 0.3, [0, B + 0.103, -0.035], "grey", undefined, 0.003);
  for (const x of [-0.009, 0.009]) b.box(0.003, 0.006, 0.29, [x, B + 0.112, -0.035], "grey", undefined, 0.001);
  b.box(0.01, 0.014, 0.006, [0, B + 0.118, 0.1], "parkerized");
  b.box(0.003, 0.014, 0.004, [0, B + 0.118, -0.172], "parkerized", undefined, 0);
  // Folded bipod legs along both sides.
  for (const x of [-0.03, 0.03]) {
    b.cyl(0.0045, 0.21, [x, B + 0.04, -0.085], "parkerized", "z", 0.0045, 10);
    b.box(0.006, 0.012, 0.014, [x, B + 0.036, 0.022], "parkerized");
  }
  b.box(0.07, 0.012, 0.016, [0, B + 0.038, -0.188], "parkerized");
  // Barrel with launcher rings and flash hider.
  b.cyl(0.0088, 0.17, [0, B, -0.292], "parkerized");
  for (const z of [-0.238, -0.262, -0.286]) b.cyl(0.0115, 0.008, [0, B, z], "parkerized");
  b.cyl(0.0108, 0.046, [0, B, -0.357], "blued", "z", 0.0108, 12);
  b.cyl(0.0125, 0.005, [0, B, -0.335], "blued");
  b.box(0.002, 0.02, 0.064, [0.0256, B + 0.008, 0.1], "blued", undefined, 0);
  b.part("bolt", [0.0258, B + 0.008, 0.1]);
  b.box(0.003, 0.014, 0.054, [0.0258, B + 0.008, 0.1], "bright", undefined, 0.0006);
  b.part("charge", [0, B + 0.048, -0.07]);
  b.box(0.014, 0.022, 0.02, [0, B + 0.05, -0.07], "parkerized");
  b.box(0.034, 0.007, 0.012, [0, B + 0.058, -0.066], "parkerized");
  b.part("mag", [0, -0.03, 0.128]);
  b.profile([[0.103, -0.006], [0.158, -0.006], [0.153, -0.19], [0.096, -0.184]], 0.024, "parkerized", 0, 0.002);
  b.box(0.027, 0.007, 0.062, [0, -0.19, 0.1245], "parkerized", [0.1, 0, 0]);
  for (let i = 0; i < 2; i += 1) b.box(0.0256, 0.12, 0.004, [0, -0.11, 0.115 + i * 0.022], "parkerized", [0.035, 0, 0], 0.001);
  const surface = b.finish(kit, FAMAS_SKINS);
  return { root: b.root, parts: builtParts(b), muzzle: [0, B, -0.382], port: [0.034, B + 0.008, 0.1], dispose: surface.dispose };
}

function buildUzi(kit: FinishKit): Built {
  const b = createBuilder(), B = 0.045;
  // Stamped receiver with stiffening ribs and top cover.
  b.box(0.042, 0.066, 0.3, [0, 0.04, -0.01], "parkerized", undefined, 0.003);
  for (const x of [-0.0215, 0.0215]) for (const y of [0.028, 0.05]) b.box(0.0024, 0.007, 0.21, [x, y, -0.03], "parkerized", undefined, 0.001);
  b.box(0.036, 0.008, 0.284, [0, 0.0765, -0.01], "parkerized", undefined, 0.002);
  b.box(0.012, 0.004, 0.11, [0, 0.0815, -0.06], "blued", undefined, 0);
  for (const x of [-0.0125, 0.0125]) {
    b.box(0.003, 0.024, 0.022, [x, 0.092, -0.142], "parkerized", undefined, 0.001);
    b.box(0.003, 0.024, 0.02, [x, 0.092, 0.112], "parkerized", undefined, 0.001);
  }
  b.box(0.0022, 0.016, 0.003, [0, 0.09, -0.142], "blued", undefined, 0);
  b.box(0.012, 0.014, 0.004, [0, 0.089, 0.112], "blued", undefined, 0.0008);
  // Barrel nut and barrel.
  b.cyl(0.0178, 0.032, [0, B, -0.176], "blued", "z", 0.0178, 14);
  b.cyl(0.0195, 0.006, [0, B, -0.163], "blued", "z", 0.0195, 14);
  b.cyl(0.008, 0.09, [0, B, -0.202], "blued");
  // Fore-end, grip with grip safety, guard and trigger.
  b.box(0.047, 0.042, 0.118, [0, -0.008, -0.1], "polymer", undefined, 0.005);
  for (let i = 0; i < 6; i += 1) b.box(0.0495, 0.03, 0.005, [0, -0.008, -0.058 - i * 0.017], "polymer", undefined, 0.0012);
  b.profile([[0.024, 0.01], [-0.03, 0.01], [-0.033, -0.108], [0.026, -0.108]], 0.035, "polymer", 0, 0.004);
  b.box(0.012, 0.064, 0.006, [0, -0.045, 0.028], "parkerized");
  b.box(0.012, 0.003, 0.046, [0, -0.036, -0.055], "parkerized");
  b.box(0.012, 0.032, 0.003, [0, -0.021, -0.079], "parkerized", [-0.12, 0, 0]);
  b.box(0.005, 0.024, 0.006, [0, -0.014, -0.05], "blued", [-0.25, 0, 0]);
  b.box(0.002, 0.021, 0.052, [0.0214, 0.058, -0.05], "blued", undefined, 0);
  // Folded steel stock.
  for (const x of [-0.011, 0.011]) b.box(0.004, 0.012, 0.15, [x, -0.002, 0.085], "parkerized", undefined, 0.001);
  b.box(0.034, 0.012, 0.014, [0, -0.002, 0.158], "parkerized");
  b.box(0.036, 0.06, 0.008, [0, 0.03, 0.146], "parkerized", undefined, 0.002);
  b.part("bolt", [0.0216, 0.058, -0.05]);
  b.box(0.003, 0.015, 0.044, [0.0216, 0.058, -0.05], "bright", undefined, 0.0006);
  b.part("charge", [0, 0.088, -0.075]);
  b.cyl(0.0115, 0.012, [0, 0.089, -0.075], "polymer", "y", 0.0105, 16);
  b.box(0.008, 0.006, 0.024, [0, 0.082, -0.075], "blued");
  b.part("mag", [0, -0.1, -0.004]);
  b.box(0.021, 0.2, 0.037, [0, -0.14, -0.004], "blued", undefined, 0.002);
  b.box(0.024, 0.007, 0.041, [0, -0.243, -0.004], "blued");
  for (let i = 0; i < 3; i += 1) b.box(0.0222, 0.1, 0.004, [0, -0.175, -0.016 + i * 0.012], "blued", undefined, 0.001);
  const surface = b.finish(kit, UZI_SKINS);
  return { root: b.root, parts: builtParts(b), muzzle: [0, B, -0.249], port: [0.03, 0.058, -0.05], dispose: surface.dispose };
}

/** A cross-section drawn as [x, y] points, run along the bore from `front` back to `rear`, with chamfered ends. */
function prism(section: Array<[number, number]>, front: number, rear: number, bevel = 0.0014) {
  const shape = new THREE.Shape(section.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: rear - front - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1 });
  return geometry.translate(0, 0, front + bevel);
}

/** How far the Desert Eagle's grip leans back for each metre it drops, how far its slide travels, and where the grip ends. */
const DEAGLE = { rake: 0.22, travel: 0.042, foot: -0.092 };

/**
 * Desert Eagle: a gas-operated pistol as long as a carbine's receiver. The barrel is fixed to the
 * frame and stands clear of the slide, slab-sided below and bevelled up to a slotted rib; the slide
 * is the block behind it and two arms that run forward under it, and all of that comes back on a shot.
 */
function buildDeagle(kit: FinishKit): Built {
  const b = createBuilder(), B = 0.043, RAKE = DEAGLE.rake;
  // The same bevelled shoulders on barrel and slide, the barrel's rib standing a little higher.
  const shouldered = (foot: number, top: number, rib: number): Array<[number, number]> => [[-0.0153, foot], [0.0153, foot], [0.0153, B + 0.003], [rib, top - 0.0035], [rib, top], [-rib, top], [-rib, top - 0.0035], [-0.0153, B + 0.003]];

  // Barrel, fixed: rib slotted for a scope mount, ramp foresight, crowned muzzle with the gas plug under it.
  b.solid(prism(shouldered(0.026, B + 0.0222, 0.0078), -0.226, -0.0702), "anodized");
  for (let i = 0; i < 9; i += 1) b.box(0.0156, 0.0016, 0.0046, [0, B + 0.0226, -0.094 - i * 0.0115], "anodized", undefined, 0.0005);
  b.profile([[-0.2195, 0.0648], [-0.2045, 0.0648], [-0.2065, 0.0718], [-0.2125, 0.0718]], 0.0034, "blued", 0, 0.0008);
  b.tube(0.0086, 0.0064, 0.004, [0, B, -0.2268], "blued", 20);
  b.cyl(0.0064, 0.002, [0, B, -0.2262], "rubber", "z", 0.0064, 16);
  b.cyl(0.0032, 0.003, [0, B - 0.0118, -0.2262], "blued", "z", 0.0032, 10);

  // Frame: one bar from the nose to the tang over the web of the hand, with the works under the barrel and slide.
  b.profile([[-0.208, 0.0145], [0.035, 0.0145], [0.0445, 0.0075], [0.037, -0.002], [-0.2, -0.002], [-0.208, 0.004]], 0.0296, "parkerized", 0, 0.0022);
  b.box(0.018, 0.012, 0.124, [0, 0.0205, -0.133], "rubber", undefined, 0.001);
  b.box(0.02, 0.021, 0.1, [0, 0.0255, -0.02], "rubber", undefined, 0.001);
  // The next round, waiting under the slide: it shows when the slide is back.
  b.cyl(0.0064, 0.03, [0, 0.0395, -0.052], "brass", "z", 0.0064, 12);
  // Squared trigger guard, cut from one piece, and the trigger in it.
  const guard = new THREE.Shape([[-0.014, 0.002], [-0.096, 0.002], [-0.0985, -0.006], [-0.0965, -0.032], [-0.089, -0.0415], [-0.014, -0.0415]].map(([z, y]) => new THREE.Vector2(z, y)));
  guard.holes.push(new THREE.Path([[-0.033, -0.0022], [-0.0905, -0.0022], [-0.0915, -0.03], [-0.086, -0.0365], [-0.036, -0.0365], [-0.03, -0.03]].map(([z, y]) => new THREE.Vector2(z, y))));
  b.shape(guard, 0.0108, "parkerized", 0, 0.002, 1);
  b.box(0.0056, 0.021, 0.0052, [0, -0.0125, -0.0495], "blued", [0.16, 0, 0], 0.0014);
  // Grip: the frame's own straps, raked back, with a panel let into each side and a medallion in each panel.
  const FOOT = DEAGLE.foot, PANEL = FOOT + 0.006;
  const front = (y: number) => -0.027 - RAKE * y, back = (y: number) => 0.0295 - RAKE * (y + 0.012);
  b.profile([[-0.027, 0.003], [0.034, 0.003], [back(-0.012), -0.012], [back(-0.05) + 0.0015, -0.05], [back(FOOT), FOOT], [front(FOOT), FOOT]], 0.027, "parkerized", 0, 0.0045);
  b.profile([[front(-0.008) + 0.0045, -0.008], [back(-0.012) - 0.0065, -0.008], [back(-0.016) - 0.004, -0.016], [back(PANEL) - 0.0045, PANEL], [front(PANEL) + 0.0045, PANEL]], 0.0345, "polymer", 0, 0.003);
  b.cyl(0.0056, 0.0358, [0, -0.046, 0.0108], "blued", "x", 0.0056, 16);
  // Hammer spur behind the slide; slide stop, its pin and the magazine catch on the frame.
  b.box(0.0066, 0.0125, 0.006, [0, 0.0265, 0.0478], "blued", [0.5, 0, 0], 0.0014);
  b.box(0.0028, 0.005, 0.03, [-0.0152, 0.0088, -0.05], "blued", undefined, 0.001);
  b.cyl(0.0034, 0.0326, [0, 0.0066, -0.082], "blued", "x", 0.0034, 10);
  b.cyl(0.0034, 0.004, [-0.0138, -0.011, -0.0205], "blued", "x", 0.0034, 10);

  // Slide: the block behind the barrel, its two arms forward under the barrel joined at the nose, and what rides on it.
  b.part("bolt", [0, B, -0.07]);
  b.solid(prism(shouldered(0.0145, 0.0605, 0.0086), -0.0715, 0.044, 0.0018), "anodized");
  for (const x of [-0.0124, 0.0124]) b.box(0.0058, 0.0125, 0.132, [x, 0.0205, -0.137], "anodized", undefined, 0.0012);
  b.box(0.0306, 0.0125, 0.008, [0, 0.0205, -0.2], "anodized", undefined, 0.0012);
  // Slanted grasping grooves, the safety with its lever on both sides, the rear sight.
  for (let i = 0; i < 6; i += 1) b.box(0.0318, 0.026, 0.0022, [0, 0.0315, -0.004 + i * 0.0048], "anodized", [0.3, 0, 0], 0.0006);
  b.cyl(0.0044, 0.0336, [0, 0.0405, 0.0368], "blued", "x", 0.0044, 12);
  for (const x of [-0.0158, 0.0158]) b.box(0.003, 0.0052, 0.015, [x, 0.038, 0.0288], "blued", [0.42, 0, 0], 0.001);
  b.box(0.021, 0.0045, 0.011, [0, 0.0622, 0.034], "blued", undefined, 0.001);
  for (const x of [-0.0068, 0.0068]) b.box(0.0064, 0.0062, 0.0085, [x, 0.0668, 0.0348], "blued", undefined, 0.001);
  // Ejection port on the right shoulder, and the bolt that fills it.
  b.box(0.002, 0.0118, 0.031, [0.0121, 0.0538, -0.05], "bright", [0, 0, 0.467], 0.0004);
  b.cyl(0.0088, 0.03, [0, B, -0.078], "bright", "z", 0.0088, 14);

  // Seven rounds of .50 in a single stack: a magazine as deep as the grip, lying along its rake.
  const lean = -Math.atan(RAKE);
  b.part("mag", [0, FOOT, 0.02]);
  b.box(0.0165, 0.096, 0.042, [0, -0.046, 0.0108], "bright", [lean, 0, 0], 0.0016);
  b.cyl(0.0062, 0.034, [0, 0.0005, 0], "brass", "z", 0.0062, 12);
  b.box(0.0285, 0.0065, 0.058, [0, FOOT - 0.0035, 0.0205], "blued", undefined, 0.0018);

  const surface = b.finish(kit, DEAGLE_SKINS);
  return { root: b.root, parts: builtParts(b), muzzle: [0, B, -0.229], port: [0.016, 0.056, -0.05], dispose: surface.dispose };
}

// ---- Authored models --------------------------------------------------------

/**
 * Brings a loaded model into weapon space: bore along -Z, Y up, with the
 * muzzle at `muzzleAt`. Named nodes become independently animated parts.
 */
function mountAuthored(root: THREE.Group, object: THREE.Object3D, surfacing: WeaponSurfacing, muzzleAt: V3, partNames: Record<string, RegExp>) {
  const z = surfacing.bore.clone().negate(), y = new THREE.Vector3(0, 1, 0), x = new THREE.Vector3().crossVectors(y, z);
  const holder = new THREE.Group();
  holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).invert();
  holder.add(object);
  holder.position.set(...muzzleAt).sub(surfacing.muzzle.clone().applyQuaternion(holder.quaternion));
  root.add(holder);
  root.updateMatrixWorld(true);
  // The skin is painted in weapon space; this is how the model's own space gets there.
  surfacing.frame.multiplyMatrices(holder.matrix, object.matrix);
  const parts = new Map<string, THREE.Object3D[]>();
  const found: Array<[string, THREE.Object3D]> = [];
  object.traverse((child) => {
    for (const [name, pattern] of Object.entries(partNames)) if (pattern.test(child.name)) found.push([name, child]);
  });
  found.forEach(([name, child]) => {
    root.attach(child);
    parts.set(name, [...(parts.get(name) ?? []), child]);
  });
  return parts;
}

// ---- Timelines --------------------------------------------------------------

const MAG_TILT: PartKey = { t: 0, p: [-0.045, 0.035, 0.03], r: [0.24, 0.2, -0.5] };
const at = (t: number, key: PartKey): PartKey => ({ ...key, t });
const OFFSCREEN_LEFT: V3 = [-0.16, -0.46, 0.12];

/**
 * Detachable magazine change: grab, strip, fetch a fresh one, seat it. Ends at `end`.
 * `out` is where the hand goes for the fresh magazine, out of sight below the view.
 */
function magazineSwap(hold: HandPose, grasp: HandPose, pull: V3, pullTilt: V3, end: number, out = OFFSCREEN_LEFT) {
  const s = end / 0.66;
  const away = (curl: number): HandPose => ({ ...grasp, p: out, curl });
  // The magazine goes with the hand that holds it.
  const carried: V3 = [out[0] - grasp.p[0], out[1] - grasp.p[1], out[2] - grasp.p[2]];
  return {
    left: [
      { t: 0.15 * s, pose: moved(grasp, [-0.03, -0.01, 0], 0.15) },
      { t: 0.21 * s, pose: moved(grasp, [0, 0, 0], 0.85) },
      { t: 0.29 * s, pose: moved(grasp, pull, 0.85) },
      { t: 0.4 * s, pose: away(0.85) },
      { t: 0.47 * s, pose: away(0.85) },
      { t: 0.58 * s, pose: moved(grasp, pull, 0.85) },
      { t: 0.64 * s, pose: moved(grasp, [0, 0.004, 0], 0.85) },
      { t: 0.66 * s, pose: moved(grasp, [0, 0, 0], 0.8) },
    ] as HandKey[],
    mag: [
      { t: 0.21 * s },
      { t: 0.29 * s, p: pull, r: pullTilt },
      { t: 0.4 * s, p: carried, r: pullTilt, hide: true },
      { t: 0.47 * s, p: carried, r: pullTilt },
      { t: 0.58 * s, p: pull, r: pullTilt },
      { t: 0.64 * s, p: [0, 0.004, 0] },
      { t: 0.66 * s },
    ] as PartKey[],
    sounds: [{ t: 0.1 * s, kind: "cloth" as const }, { t: 0.23 * s, kind: "magOut" as const }, { t: 0.63 * s, kind: "magIn" as const }],
    hold,
  };
}

// ---- Bolt-action choreography -----------------------------------------------
//
// Working a bolt only reads right if the hand stays on the knob while it swings up and
// slides back, so the rifle's timelines are not keyed pose by pose. Each is described
// once — where the bolt is, how the rifle is canted, what the firing hand is holding —
// and then sampled into dense keys, the hand being placed from the bolt (or the clip)
// itself on every sample.

type Shape = (k: number) => number;
/** Quick off the mark, easing into the stop. */
const settle: Shape = (k) => 1 - (1 - k) ** 3;
/** The same, less abruptly: a reach that arrives with something in hand. */
const arrive: Shape = (k) => 1 - (1 - k) ** 2;
/** Gathers speed and stops dead against whatever it meets. */
const slam: Shape = (k) => k ** 1.8;
type Beat<T> = [at: number, value: T, shape?: Shape];
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mix3 = (a: V3, b: V3, k: number): V3 => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
const scaled = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const turnZ = (v: V3, angle: number): V3 => { const c = Math.cos(angle), s = Math.sin(angle); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; };

/** A value that moves from beat to beat, each move shaped by the beat it arrives at. */
function along<T>(beats: Array<Beat<T>>, blend: (a: T, b: T, k: number) => T) {
  return (t: number): T => {
    let i = 0;
    while (i < beats.length - 1 && beats[i + 1][0] <= t) i += 1;
    const a = beats[i], b = beats[i + 1];
    return !b || t <= a[0] ? a[1] : blend(a[1], b[1], (b[2] ?? ease)((t - a[0]) / (b[0] - a[0])));
  };
}
/** A knock that dies away: it peaks at 1 a sixth of the way through, rebounds a little and is gone by the end. */
const knock = (x: number) => (x <= 0 || x >= 1 ? 0 : 2.6 * Math.exp(-4 * x) * Math.sin(2.2 * Math.PI * x) * (1 - x));

/** The bolt as modelled: the axis it turns about, where its knob is when closed, how far it lifts and how far it draws. */
const BOLT = { axis: [0, 0.0629], knob: [0.0345, 0.0332, -0.1155] as V3, lift: 1.2, draw: 0.088 };
const knobAt = (lift: number, draw: number): V3 => {
  const [x, y] = turnZ([BOLT.knob[0] - BOLT.axis[0], BOLT.knob[1] - BOLT.axis[1], 0], lift);
  return [BOLT.axis[0] + x, BOLT.axis[1] + y, BOLT.knob[2] + draw];
};

/**
 * The receiver is roofed over under the scope and opens to the right, so a clip is offered up to the port
 * leaning out to that side. Its rounds run down the clip, in through the port and then down into the magazine.
 */
const CLIP = (() => {
  const lean = 0.7, pitch = 0.0118, throat = 0.0203;
  const mouth: V3 = [0.016, 0.0635, -0.128], out: V3 = [Math.cos(lean), Math.sin(lean), 0];
  /** Where a round is once it has travelled `s` past the mouth of the port; negative while it is still on the clip. */
  const path = (s: number): V3 => add(mouth, s <= throat ? scaled(out, -s) : add(scaled(out, -throat), [0, throat - s, 0]));
  return { lean, pitch, out, path, seat: (i: number) => path(-i * pitch), /** Travel that takes the last round under the bolt. */ home: pitch * 4 + throat + 0.006 };
})();

/** The pose that puts `local` — a point in the hand's own frame: -Z along the fingers, -Y out of the palm, -X toward the thumb — on `target`. */
function holding(target: V3, local: V3, f: V3, n: V3, curl: number[]): HandPose {
  const offset = new THREE.Vector3(...local).applyQuaternion(resolvePose(hand([0, 0, 0], f, n, 0)).quaternion);
  return hand([target[0] - offset.x, target[1] - offset.y, target[2] - offset.z], f, n, curl);
}

type Hold = HandPose | ((t: number) => HandPose) | "grip";
/** The hand arrives at `hold` at `at`, shaped by `shape` and swinging out by `arc` on the way. */
type Move = { at: number; hold: Hold; shape?: Shape; arc?: V3 };

function handKeys(moves: Move[], steps: number, grip: HandPose): HandKey[] {
  const curls = (pose: HandPose) => (typeof pose.curl === "number" ? new Array<number>(5).fill(pose.curl) : pose.curl);
  const read = (hold: Hold, t: number) => (hold === "grip" ? null : typeof hold === "function" ? hold(t) : hold);
  const keys: HandKey[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    let j = 0;
    while (j < moves.length - 1 && moves[j + 1].at <= t) j += 1;
    const a = moves[j], b = moves[j + 1];
    const moving = Boolean(b) && t > a.at;
    const k = moving ? (b.shape ?? ease)((t - a.at) / (b.at - a.at)) : 0;
    const from = read(a.hold, t), to = moving ? read(b.hold, t) : from;
    const A = from ?? to, B = to ?? from;
    if (!A || !B) { keys.push({ t, pose: grip, toRest: 1 }); continue; }
    const cA = curls(A), cB = curls(B);
    const swing = moving && b.arc ? scaled(b.arc, Math.sin(Math.PI * k)) : [0, 0, 0] as V3;
    keys.push({
      t,
      pose: { p: add(mix3(A.p, B.p, k), swing), f: mix3(A.f, B.f, k), n: mix3(A.n, B.n, k), curl: cA.map((c, finger) => mix(c, cB[finger], k)) },
      // Leaving or regaining the grip: the resting grip is only known once fitted, so it is blended in when the keys are resolved.
      toRest: (from ? 0 : 1 - k) + (to ? 0 : k),
    });
  }
  return keys;
}

function partKeys(steps: number, at: (t: number) => Omit<PartKey, "t">): PartKey[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({ t: i / steps, ...at(i / steps) }));
}

type Knock = { at: number; lasts: number; p?: V3; r?: V3 };
/** The rifle's attitude: a cant that moves from beat to beat, plus the knocks it takes from the action being worked. */
function bodyKeys(steps: number, cant: Array<Beat<{ p: V3; r: V3 }>>, knocks: Knock[], lean?: (t: number) => { p: V3; r: V3 }): PartKey[] {
  const base = along(cant, (a, b, k) => ({ p: mix3(a.p, b.p, k), r: mix3(a.r, b.r, k) }));
  return partKeys(steps, (t) => {
    let { p, r } = base(t);
    const extra = lean?.(t);
    if (extra) { p = add(p, extra.p); r = add(r, extra.r); }
    for (const hit of knocks) {
      const amount = knock((t - hit.at) / hit.lasts);
      if (amount === 0) continue;
      if (hit.p) p = add(p, scaled(hit.p, amount));
      if (hit.r) r = add(r, scaled(hit.r, amount));
    }
    return { p, r };
  });
}

/** The bolt-action's per-shot cycle and its stripper-clip reload. `grip` is the firing hand's resting pose. */
function boltAction(grip: HandPose): { cycle: Timeline; reload: Timeline } {
  const level = { p: [0, 0, 0] as V3, r: [0, 0, 0] as V3 };
  // The knob is pinched between the thumb and the first two fingers, the palm facing the receiver from its right:
  // curled any tighter around it, the fingers would be inside the stock. `at` is the knob in the hand's own frame,
  // and the hand turns with the handle by `follow` of its lift.
  const KNOB = { f: [-0.05, 0.3, -0.95] as V3, n: [-0.97, 0.2, 0.1] as V3, at: [-0.025, -0.055, -0.064] as V3, follow: 0.45 };
  const CLOSED = [0.4, 0.46, 0.8, 0.9, 0.5], OPEN = [0.22, 0.3, 0.5, 0.6, 0.2];
  const onKnob = (lift: number, draw: number, curl = CLOSED, off: V3 = [0, 0, 0]) => {
    const turn = lift * KNOB.follow;
    return holding(add(knobAt(lift, draw), turnZ(off, turn)), KNOB.at, turnZ(KNOB.f, turn), turnZ(KNOB.n, turn), curl);
  };
  /** The firing hand on the bolt, wherever `lift` and `draw` have it. `ready` is the open hand just short of the knob. */
  const riding = (lift: (t: number) => number, draw: (t: number) => number) => ({
    held: (t: number) => onKnob(lift(t), draw(t)),
    ready: (t: number) => onKnob(lift(t), draw(t), OPEN, [0.02, -0.01, 0.012]),
  });
  const boltParts = (steps: number, lift: (t: number) => number, draw: (t: number) => number) => ({
    bolt: partKeys(steps, (t) => ({ p: [0, 0, draw(t)], r: [0, 0, lift(t)] })),
    striker: partKeys(steps, (t) => ({ p: [0, 0, draw(t)] })),
  });

  // ---- Between shots: up, back, forward, down — 1150 ms.
  const cycle = (() => {
    const ms = (x: number) => x / 1150, steps = 72;
    const lift = along<number>([[ms(265), 0], [ms(385), BOLT.lift, slam], [ms(735), BOLT.lift], [ms(810), 0, slam]], mix);
    const draw = along<number>([[ms(400), 0], [ms(540), BOLT.draw, slam], [ms(585), BOLT.draw], [ms(720), 0, slam]], mix);
    const onBolt = riding(lift, draw);
    const worked = { p: [-0.006, 0.004, 0.006] as V3, r: [0.03, 0.03, 0.16] as V3 };
    return {
      sampled: true,
      right: handKeys([
        { at: ms(70), hold: "grip" },
        { at: ms(235), hold: onBolt.ready, arc: [0.012, -0.012, 0] },
        { at: ms(265), hold: onBolt.held },
        { at: ms(830), hold: onBolt.held },
        { at: ms(860), hold: onBolt.ready },
        { at: ms(1070), hold: "grip", arc: [0.01, -0.016, 0] },
      ], steps, grip),
      body: bodyKeys(steps, [
        [ms(60), level], [ms(265), worked, settle], [ms(760), worked],
        [ms(1010), { p: [0.001, -0.003, -0.002], r: [-0.006, -0.004, -0.02] }], [ms(1150), level],
      ], [
        { at: ms(385), lasts: ms(150), r: [0, 0, 0.012] },
        { at: ms(540), lasts: ms(220), p: [0, 0.002, 0.005], r: [0.014, 0, 0.012] },
        { at: ms(720), lasts: ms(200), p: [0, 0, -0.005], r: [-0.012, 0, 0] },
        { at: ms(810), lasts: ms(180), p: [0, -0.002, 0], r: [0, 0, -0.03] },
      ]),
      parts: boltParts(steps, lift, draw),
      // The handle ticks against its stop. `boltBack` is a slide that ends in a click 85 ms on, so it starts that much before
      // the bolt reaches the rear; `boltHome` is the bolt going home, then the handle locking down 90 ms later.
      sounds: [{ t: ms(385), kind: "boltUp" }, { t: ms(455), kind: "boltBack" }, { t: ms(720), kind: "boltHome" }],
      eject: ms(540),
    } satisfies Timeline;
  })();

  // ---- Reload: open the action, strip in five rounds from a clip, close it — 3100 ms.
  const reload = (() => {
    const ms = (x: number) => x / 3100, steps = 186;
    const lift = along<number>([[ms(330), 0], [ms(480), BOLT.lift, slam], [ms(2675), BOLT.lift], [ms(2750), 0, slam]], mix);
    const draw = along<number>([[ms(500), 0], [ms(680), BOLT.draw, slam], [ms(2500), BOLT.draw], [ms(2660), 0, slam]], mix);
    const onBolt = riding(lift, draw);
    /** How far the thumb has driven the rounds down the clip. Its own travel ends at the port; the last round snaps under the bolt way. */
    const reach = CLIP.pitch * 4 + 0.006;
    const push = along<number>([[ms(1760), 0], [ms(2010), reach], [ms(2050), CLIP.home, settle]], mix);

    // The clip is carried under the thumb, whose tip rests on the outermost round; the palm faces the port.
    const PRESS = { f: [0, 0.12, -1] as V3, n: [-0.99, -0.15, 0] as V3, thumb: [-0.049, -0.067, -0.054] as V3, curl: [0.45, 0.6, 0.8, 0.9, 0.42] };
    const onClip = (driven: number, off: V3 = [0, 0, 0]) => holding(
      add(add(CLIP.path(Math.min(driven, reach) - CLIP.pitch * 4), scaled(CLIP.out, 0.0075)), add([0, 0, 0.012], off)),
      PRESS.thumb, PRESS.f, PRESS.n, PRESS.curl,
    );
    const seated = onClip(0), offered = onClip(0, scaled(CLIP.out, 0.034));
    const pouch = hand([0.21, -0.36, 0.2], [-0.1, 0.25, -0.96], [-0.9, 0.2, 0.3], PRESS.curl);
    const flicked = { ...onClip(reach, [0.06, 0.03, 0.045]), n: [-0.5, -0.82, 0.25] as V3, curl: [0.25, 0.28, 0.32, 0.36, 0.15] };
    const right: Move[] = [
      { at: ms(60), hold: "grip" },
      { at: ms(295), hold: onBolt.ready, arc: [0.014, -0.014, 0] },
      { at: ms(330), hold: onBolt.held },
      { at: ms(760), hold: onBolt.held },
      { at: ms(800), hold: onBolt.ready },
      { at: ms(1040), hold: pouch, arc: [0.05, 0, 0.03] },
      { at: ms(1240), hold: pouch },
      { at: ms(1600), hold: offered, shape: arrive, arc: [0.03, 0.03, 0] },
      { at: ms(1680), hold: seated },
      { at: ms(1760), hold: (t) => onClip(push(t)) },
      { at: ms(2110), hold: (t) => onClip(push(t)) },
      { at: ms(2230), hold: flicked, shape: settle },
      { at: ms(2465), hold: onBolt.ready, arc: [0.02, 0.01, 0] },
      { at: ms(2500), hold: onBolt.held },
      { at: ms(2790), hold: onBolt.held },
      { at: ms(2820), hold: onBolt.ready },
      { at: ms(3040), hold: "grip", arc: [0.01, -0.016, 0] },
    ];
    const rightKeys = handKeys(right, steps, grip);

    // Until it is seated the clip goes wherever the hand that holds it goes.
    const shown = ms(1250), seatedAt = ms(1680), flickAt = ms(2125), shut = ms(2660);
    const grasp = resolvePose(seated), inverse = grasp.quaternion.clone().invert();
    const carried = (t: number, rest: V3): Omit<PartKey, "t"> => {
      if (t < shown) return { hide: true };
      if (t >= seatedAt) return {};
      const key = rightKeys[Math.min(steps, Math.round(t * steps))];
      const now = resolvePose(key.pose), turn = now.quaternion.clone().multiply(inverse);
      const at = new THREE.Vector3(...rest).sub(grasp.position).applyQuaternion(turn).add(now.position);
      const r = new THREE.Euler().setFromQuaternion(turn);
      return { p: [at.x - rest[0], at.y - rest[1], at.z - rest[2]], r: [r.x, r.y, r.z] };
    };
    const stripAt = add(CLIP.seat(2), [0, 0, 0.0276]);
    const parts: Record<string, PartKey[]> = {
      ...boltParts(steps, lift, draw),
      // Emptied, the clip is flicked out to the right and tumbles away.
      clip: partKeys(steps, (t) => {
        if (t < flickAt) return carried(t, stripAt);
        const s = (t - flickAt) * 3.1;
        return { p: [1.5 * s - 2.6 * s * s, 1.0 * s - 4.2 * s * s, 0.5 * s], r: [9 * s, 5 * s, -16 * s], hide: s > 0.34 };
      }),
    };
    for (let i = 0; i < 5; i += 1) {
      const rest = CLIP.seat(i);
      parts[`clip${i + 1}`] = partKeys(steps, (t) => {
        if (t < seatedAt) return carried(t, rest);
        const at = CLIP.path(push(t) - i * CLIP.pitch);
        return { p: [at[0] - rest[0], at[1] - rest[1], at[2] - rest[2]], hide: t >= shut };
      });
    }

    const worked = { p: [-0.006, 0, 0.008] as V3, r: [0.03, 0.03, 0.16] as V3 };
    const presented = { p: [-0.035, -0.012, 0.03] as V3, r: [0.12, 0.1, 0.45] as V3 };
    const pressed = along<number>([[ms(1760), 0], [ms(2010), 1], [ms(2060), 1], [ms(2230), 0, settle]], mix);
    return {
      sampled: true,
      right: rightKeys,
      body: bodyKeys(steps, [
        [0, level], [ms(80), { p: [0.003, -0.005, -0.003], r: [-0.012, -0.008, -0.03] }], [ms(330), worked, settle], [ms(740), worked],
        [ms(1240), presented], [ms(2250), presented], [ms(2500), worked], [ms(2780), worked],
        [ms(2990), { p: [0.002, -0.004, -0.003], r: [-0.01, -0.006, -0.025] }], [ms(3100), level],
      ], [
        { at: ms(480), lasts: ms(180), r: [0, 0, 0.014] },
        { at: ms(680), lasts: ms(260), p: [0, 0.002, 0.006], r: [0.018, 0, 0.012] },
        { at: ms(1680), lasts: ms(220), p: [-0.002, -0.005, 0], r: [-0.012, 0, -0.016] },
        { at: ms(2030), lasts: ms(200), p: [0, -0.003, 0], r: [-0.01, 0, 0] },
        { at: ms(2660), lasts: ms(240), p: [0, 0, -0.006], r: [-0.015, 0, 0] },
        { at: ms(2750), lasts: ms(200), p: [0, -0.003, 0], r: [0, 0, -0.03] },
      ], (t) => { const k = pressed(t); return { p: scaled([-0.004, -0.007, 0], k), r: scaled([-0.02, 0, -0.03], k) }; }),
      parts,
      sounds: [
        { t: ms(480), kind: "boltUp" }, { t: ms(595), kind: "boltBack" }, { t: ms(1030), kind: "cloth" },
        { t: seatedAt, kind: "magIn" }, { t: ms(2010), kind: "slap" },
        // The emptied clip pinging off the receiver: the same light tick as the handle makes.
        { t: flickAt, kind: "boltUp" },
        { t: shut, kind: "boltHome" },
      ],
    } satisfies Timeline;
  })();

  return { cycle, reload };
}

// ---- Rigs -------------------------------------------------------------------

type RigSetup = {
  id: WeaponId;
  view: { p: V3; r: V3 };
  right: HandPose;
  left: HandPose;
  reload: Timeline;
  cycle?: Timeline;
};

/** How far the firing hand is turned in round a handle, and where the root of the thumb is in the hand's own frame. */
const GRIP_TURN = 0.384, THUMB_ROOT: V3 = [-0.036, 0.009, 0.026];
/**
 * The firing hand on a handle. It is turned in round the handle, which sits in the fork of the
 * thumb, and the thumb is laid on the weapon's left side: `root` is where the root of the thumb
 * goes, behind the top of the handle, and `thumb` where its tip rests. `dip` is how far the
 * fingers point down, which follows the rake of the handle.
 */
const firing = (root: V3, thumb: V3, dip = -0.29): HandPose => ({
  ...holding(root, THUMB_ROOT, [Math.sin(GRIP_TURN), dip, -Math.cos(GRIP_TURN)], [-Math.cos(GRIP_TURN), 0, -Math.sin(GRIP_TURN)], [0.42, 0.92, 0.96, 1, 0.5]),
  thumb, cup: 0.012,
});
/** The supporting hand under a fore-end, with its thumb laid up the weapon's left side at `thumb`. */
const support = (p: V3, thumb: V3, curl = 0.72): HandPose => ({ ...hand(p, [0.86, 0.5, -0.08], [-0.5, 0.86, 0], [curl, curl + 0.04, curl + 0.04, curl, 0.25]), thumb });
const overTop = (p: V3, curl = 0.6): HandPose => hand(p, [0.96, -0.2, 0.15], [0.2, -0.97, 0], curl);
const sideGrasp = (p: V3, curl = 0.85): HandPose => hand(p, [0.12, -0.25, -0.96], [1, 0, 0], curl);

function setups(): RigSetup[] {
  // AK-47: rock the magazine out and in, then reach over to run the charging handle.
  const akLeft = support([-0.014, -0.004, -0.33], [-0.027, 0.044, -0.405]);
  const akSwap = magazineSwap(akLeft, sideGrasp([-0.032, -0.085, -0.2]), [0, -0.1, -0.075], [-0.55, 0, 0], 0.62);
  const akHandle = overTop([0.02, 0.118, -0.215]);
  const ak: RigSetup = {
    id: "ak47", view: { p: [0, 0, 0], r: [0, 0, 0] },
    right: firing([0.02, -0.018, 0.049], [-0.025, -0.004, -0.04]), left: akLeft,
    reload: {
      left: [...akSwap.left, { t: 0.76, pose: moved(akHandle, [-0.02, 0.03, 0], 0.3) }, { t: 0.81, pose: akHandle }, { t: 0.87, pose: moved(akHandle, [0, 0, 0.075]) }, { t: 0.9, pose: moved(akHandle, [-0.01, 0.02, 0.07], 0.2) }],
      body: [at(0.13, MAG_TILT), at(0.66, MAG_TILT), { t: 0.78, p: [-0.05, 0.03, 0.02], r: [0.14, 0.12, 0.62] }, { t: 0.9, p: [-0.05, 0.03, 0.03], r: [0.16, 0.12, 0.62] }],
      parts: { mag: akSwap.mag, bolt: [{ t: 0.81 }, { t: 0.87, p: [0, 0, 0.075] }, { t: 0.895 }] },
      sounds: [...akSwap.sounds, { t: 0.82, kind: "rack" }],
    },
  };

  // M4A1: straight magazine swap, then slap the bolt release.
  const m4Left = support([-0.016, 0.01, -0.28], [-0.033, 0.052, -0.35]);
  const m4Swap = magazineSwap(m4Left, sideGrasp([-0.03, -0.11, -0.118]), [0, -0.17, 0.012], [0.06, 0, 0], 0.66);
  const m4Slap = hand([-0.047, 0.05, -0.085], [0, 0.55, -0.83], [1, 0, 0], [0.12, 0.12, 0.15, 0.2, 0.1]);
  const m4: RigSetup = {
    id: "m4", view: { p: [0, 0, 0], r: [0, 0, 0] },
    right: firing([0.02, -0.002, 0.048], [-0.027, 0.002, -0.038]), left: m4Left,
    reload: {
      left: [...m4Swap.left, { t: 0.76, pose: moved(m4Slap, [-0.07, 0, 0.02]) }, { t: 0.8, pose: m4Slap }, { t: 0.86, pose: moved(m4Slap, [-0.04, -0.01, 0]) }],
      body: [at(0.13, MAG_TILT), at(0.68, MAG_TILT), { t: 0.795, p: [-0.03, 0.03, 0.02], r: [0.16, 0.16, -0.24] }, { t: 0.82, p: [0, 0.028, 0.02], r: [0.15, 0.1, -0.12] }],
      parts: { mag: m4Swap.mag, bolt: [{ t: 0, p: [0, 0, 0.05] }, { t: 0.8, p: [0, 0, 0.05] }, { t: 0.815 }], charge: [{ t: 0.8 }, { t: 0.81, p: [0, 0, 0.004] }, { t: 0.83 }] },
      sounds: [...m4Swap.sounds, { t: 0.8, kind: "slap" }],
    },
  };

  // FAMAS: the magazine sits behind the grip, below the bottom of the view, so the rifle is rolled onto its
  // side to bring it up into sight; the charging handle is under the carrying handle.
  // The handguard is a short, deep slab between the muzzle end of the body and the trigger guard: the
  // supporting hand lies across under it, placed by hand, its thumb up the left side.
  const faLeft: HandPose = { ...hand([-0.013, -0.003, -0.137], [0.85, 0.51, -0.15], [-0.5, 0.86, 0.16], [0.9, 0.92, 0.92, 0.85, 0.25]), thumb: [-0.037, 0.064, -0.204], cup: 0.006 };
  // The magazine is taken low, clear of the firing hand in front of it.
  const faGrasp = sideGrasp([-0.034, -0.14, 0.128]);
  const faSwap = magazineSwap(faLeft, faGrasp, [0, -0.19, 0.01], [0.05, 0, 0], 0.56, [0.03, -0.445, 0.156]);
  // The hand comes alongside the receiver as a fist, and its forefinger goes in under the carrying
  // handle to hook the charging handle and draw it back.
  const faHandle = hand([-0.1232, 0.07, -0.0616], [0.866, 0, -0.5], [0.5, 0, 0.866], [0.42, 1, 1, 1, 0.3]);
  const faTilt: PartKey = { t: 0, p: [-0.05, 0.13, -0.06], r: [0.12, 0.15, -1] };
  const faRack: PartKey = { t: 0, p: [-0.03, 0.03, 0.02], r: [0.14, 0.22, 0.2] };
  const famas: RigSetup = {
    id: "famas", view: { p: [0.0, 0, -0.13], r: [0, 0, 0] },
    right: { ...firing([0.012, -0.006, 0.056], [-0.029, -0.026, -0.028], -0.05), curl: [0.6, 0.92, 0.96, 1, 0.5], cup: 0.028 }, left: faLeft,
    reload: {
      left: [
        // Off the handguard: down, and out round the firing hand to the magazine behind it.
        { t: 0.023, pose: moved(faLeft, [-0.02, -0.05, 0], [0.4, 0.4, 0.4, 0.4, 0.25]), via: true },
        { t: 0.058, pose: moved(faGrasp, [-0.086, 0.02, -0.148], 0.3), via: true },
        ...faSwap.left,
        // Out to the left again and up to the charging handle.
        { t: 0.673, pose: moved(faHandle, [-0.087, -0.1, 0.082], [0.4, 1, 1, 1, 0.3]), via: true },
        { t: 0.706, pose: moved(faHandle, [-0.045, 0, -0.02], [0.05, 1, 1, 1, 0.2]), via: true },
        { t: 0.73, pose: faHandle },
        { t: 0.79, pose: moved(faHandle, [0, 0, 0.08]) },
        { t: 0.825, pose: moved(faHandle, [-0.05, 0, 0.07], [0.05, 0.8, 0.8, 0.8, 0.2]) },
        // Down the left side, and back under the handguard from below.
        { t: 0.925, pose: hand([-0.15, -0.09, -0.09], faLeft.f, faLeft.n, [0.6, 0.65, 0.65, 0.6, 0.25]), via: true },
        { t: 0.956, pose: moved(faLeft, [-0.025, -0.085, 0], [0.45, 0.45, 0.45, 0.45, 0.25]), via: true },
      ],
      body: [
        at(0.12, faTilt), at(0.2, faTilt),
        // The rifle gives as the magazine is pulled out of it, and again as the fresh one goes home.
        { t: 0.245, p: [-0.058, 0.125, -0.06], r: [0.12, 0.15, -1.03] }, at(0.31, faTilt), at(0.515, faTilt),
        { t: 0.546, p: [-0.043, 0.135, -0.06], r: [0.12, 0.15, -0.97] }, at(0.575, faTilt),
        at(0.69, faRack), at(0.73, faRack), { t: 0.79, p: [-0.03, 0.032, 0.032], r: [0.165, 0.22, 0.2] }, { t: 0.825, p: [-0.03, 0.03, 0.02], r: [0.13, 0.22, 0.2] },
      ],
      parts: { mag: faSwap.mag, charge: [{ t: 0.73 }, { t: 0.79, p: [0, 0, 0.08] }, { t: 0.815 }], bolt: [{ t: 0.73 }, { t: 0.79, p: [0, 0, 0.05] }, { t: 0.815 }] },
      sounds: [...faSwap.sounds, { t: 0.74, kind: "rack" }],
    },
  };

  // Uzi: magazine through the grip, palm it home, then draw the cocking knob. The foot of the grip is
  // below the bottom of the view, so the gun is rolled onto its side to bring the magazine up into sight.
  const uziLeft = support([-0.014, -0.048, -0.1], [-0.036, -0.005, -0.15]);
  const uziSwap = magazineSwap(uziLeft, sideGrasp([-0.03, -0.2, -0.006]), [0, -0.2, 0], [0, 0, 0], 0.58, [0.113, -0.41, 0.066]);
  const uziPalm = hand([-0.015, -0.275, 0.0], [0.9, 0.4, 0], [-0.4, 0.9, 0], 0.15);
  const uziKnob = overTop([-0.01, 0.112, -0.075], 0.55);
  const uziTilt: PartKey = { t: 0, p: [-0.05, 0.13, -0.05], r: [0.12, 0.15, -1] };
  const uzi: RigSetup = {
    id: "uzi", view: { p: [-0.02, 0.015, -0.03], r: [0, 0, 0] },
    right: firing([0.023, -0.02, 0.061], [-0.03, -0.014, -0.022], -0.06), left: uziLeft,
    reload: {
      left: [...uziSwap.left, { t: 0.63, pose: moved(uziPalm, [0, -0.06, 0]) }, { t: 0.67, pose: uziPalm }, { t: 0.72, pose: moved(uziPalm, [-0.02, -0.04, 0]) }, { t: 0.81, pose: moved(uziKnob, [-0.02, 0.02, 0], 0.3) }, { t: 0.85, pose: uziKnob }, { t: 0.9, pose: moved(uziKnob, [0, 0, 0.065]) }, { t: 0.93, pose: moved(uziKnob, [-0.02, 0.02, 0.06], 0.25) }],
      body: [at(0.13, uziTilt), at(0.6, uziTilt), { t: 0.67, p: [-0.037, 0.138, -0.05], r: [0.14, 0.15, -1] }, at(0.72, uziTilt), { t: 0.82, p: [-0.04, 0.02, 0.02], r: [0.1, 0.16, 0.4] }, { t: 0.93, p: [-0.04, 0.02, 0.025], r: [0.11, 0.16, 0.4] }],
      parts: { mag: uziSwap.mag, charge: [{ t: 0.85 }, { t: 0.9, p: [0, 0, 0.065] }, { t: 0.92 }], bolt: [{ t: 0.85 }, { t: 0.9, p: [0, 0, 0.04] }, { t: 0.92 }] },
      sounds: [...uziSwap.sounds, { t: 0.67, kind: "slap" }, { t: 0.86, kind: "rack" }],
    },
  };

  // Bolt-action: the firing hand works the bolt; reloading strips five rounds in from a clip.
  // The wrist of the stock is held from the side, with the thumb over the top of it.
  const riRight: HandPose = { ...hand([0.03, -0.012, 0.035], [0, -0.5, -0.87], [-1, 0, 0.05], [0.42, 0.92, 0.96, 1, 0.55]), thumb: [-0.023, 0.022, 0.02] };
  const rifle: RigSetup = {
    id: "rifle", view: { p: [0.03, 0.01, 0.06], r: [0, -0.03, 0] },
    right: riRight, left: support([-0.014, -0.028, -0.36], [-0.026, 0.044, -0.41]),
    ...boltAction(riRight),
  };
  // Desert Eagle: held out in one hand. The empty magazine is dropped; the other hand brings a full one up
  // from below, palms it home, then reaches over the slide and runs it.
  const pull: V3 = [0, -0.165, 0.165 * DEAGLE.rake], below = add(pull, [-0.11, -0.2, 0.09]);
  const deCup = hand([-0.008, DEAGLE.foot - 0.042, 0.026], [0.93, 0.28, -0.24], [-0.26, 0.96, 0.08], [0.5, 0.52, 0.55, 0.6, 0.3]);
  const deSlide = overTop([-0.012, 0.087, 0.008], 0.62);
  const deTilt: PartKey = { t: 0, p: [-0.07, 0.085, 0.03], r: [0.48, 0.3, -0.72] };
  const deRack: PartKey = { t: 0, p: [-0.045, 0.02, 0.02], r: [0.1, 0.2, 0.42] };
  const deagle: RigSetup = {
    id: "deagle", view: { p: [-0.03, 0.04, -0.15], r: [-0.03, 0.11, 0.05] },
    // The thumb lies along the frame under the slide.
    right: firing([0.02, -0.01, 0.062], [-0.03, 0.008, -0.03], -0.12),
    left: hand([-0.2, -0.44, 0.12], [0.35, 0.3, -0.89], [0.75, 0.55, 0.37], [0.5, 0.55, 0.6, 0.6, 0.35]),
    reload: {
      left: [
        { t: 0.26, pose: moved(deCup, below) }, { t: 0.38, pose: moved(deCup, pull) }, { t: 0.42, pose: moved(deCup, pull) }, { t: 0.5, pose: moved(deCup, [0, 0.004, 0]) }, { t: 0.53, pose: deCup },
        { t: 0.6, pose: moved(deCup, [-0.03, -0.05, 0.01], 0.2) },
        { t: 0.69, pose: moved(deSlide, [-0.03, 0.03, 0], 0.3) }, { t: 0.74, pose: deSlide }, { t: 0.8, pose: moved(deSlide, [0, 0, DEAGLE.travel]) }, { t: 0.83, pose: moved(deSlide, [-0.02, 0.025, DEAGLE.travel], 0.25) },
      ],
      body: [at(0.09, deTilt), at(0.46, deTilt), { t: 0.5, p: [-0.07, 0.098, 0.03], r: [0.52, 0.3, -0.72] }, at(0.56, deTilt), at(0.7, deRack), { t: 0.8, p: [-0.045, 0.02, 0.028], r: [0.12, 0.2, 0.42] }, at(0.84, deRack)],
      parts: {
        // Dropped free: it slides out along the grip, then falls away.
        mag: [{ t: 0.11 }, { t: 0.17, p: [0, -0.07, 0.07 * DEAGLE.rake] }, { t: 0.24, p: [0.02, -0.4, 0.14], r: [0.6, 0, 0.3], hide: true }, { t: 0.26, p: below }, { t: 0.38, p: pull }, { t: 0.42, p: pull }, { t: 0.5, p: [0, 0.004, 0] }, { t: 0.53 }],
        bolt: [{ t: 0.74 }, { t: 0.8, p: [0, 0, DEAGLE.travel] }, { t: 0.825 }],
      },
      sounds: [{ t: 0.04, kind: "cloth" }, { t: 0.11, kind: "magOut" }, { t: 0.49, kind: "magIn" }, { t: 0.52, kind: "slap" }, { t: 0.75, kind: "rack" }],
    },
    // Every shot throws the slide back and flips the muzzle up about the wrist.
    cycle: {
      body: [{ t: 0 }, { t: 0.2, p: [0, 0.008, 0.012], r: [0.2, 0, 0] }, { t: 1 }],
      parts: { bolt: [{ t: 0 }, { t: 0.17, p: [0, 0, DEAGLE.travel] }, { t: 0.62 }] },
    },
  };
  return [ak, m4, famas, uzi, rifle, deagle];
}

const identityKey: PartKey = { t: 0 };
const euler = new THREE.Euler(), delta = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3();

function sampleKeys(keys: PartKey[] | undefined, t: number, outP: THREE.Vector3, outR: THREE.Vector3, sampled = false) {
  outP.set(0, 0, 0); outR.set(0, 0, 0);
  if (!keys || keys.length === 0) return false;
  let a = identityKey, b: PartKey = { t: 1 };
  if (t <= keys[0].t) { a = { t: 0, ...(keys[0].t === 0 ? keys[0] : {}) }; b = keys[0]; }
  else {
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i].t <= t) { a = keys[i]; b = keys[i + 1] ?? { t: 1 }; }
    }
  }
  const span = b.t - a.t;
  const along = span > 0 ? THREE.MathUtils.clamp((t - a.t) / span, 0, 1) : 1;
  const k = sampled ? along : ease(along);
  outP.lerpVectors(va.set(...(a.p ?? [0, 0, 0])), vb.set(...(b.p ?? [0, 0, 0])), k);
  outR.lerpVectors(va.set(...(a.r ?? [0, 0, 0])), vb.set(...(b.r ?? [0, 0, 0])), k);
  return Boolean(a.hide);
}

type PosedKey = { t: number; pose: ResolvedPose; via?: boolean };

function sampleHand(keys: PosedKey[], rest: ResolvedPose, t: number, out: ResolvedPose, sampled = false) {
  let a: PosedKey = { t: 0, pose: rest }, b: PosedKey = { t: 1, pose: rest };
  for (const key of keys) {
    if (key.t <= t) a = key;
    else { b = key; break; }
  }
  if (b.t <= a.t) b = { t: 1, pose: rest };
  const along = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1);
  // The hand stops at a key, except one it only passes through: it carries its speed into and out of that.
  const k = sampled || (a.via && b.via) ? along : a.via ? along * (2 - along) : b.via ? along * along : ease(along);
  blendPose(a.pose, b.pose, k, out);
}

export function createArsenal(anisotropy: number, manager: THREE.LoadingManager, isDisposed: () => boolean): Arsenal {
  const kit = createFinishKit(anisotropy);
  const disposers: Array<() => void> = [() => kit.dispose()];
  const config = setups();

  const makeRig = (setup: RigSetup, built: Built | null): WeaponRig => {
    const spec = ARSENAL.find((weapon) => weapon.id === setup.id)!;
    const root = built?.root ?? new THREE.Group();
    const muzzle = new THREE.Object3D();
    root.add(muzzle);
    const port = new THREE.Vector3();
    type Rest = { object: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion };
    const parts = new Map<string, Rest[]>();
    const adopt = (source: Map<string, THREE.Object3D[]>) => source.forEach((objects, name) => parts.set(name, objects.map((object) => ({ object, position: object.position.clone(), quaternion: object.quaternion.clone() }))));
    if (built) {
      muzzle.position.set(...built.muzzle);
      port.set(...built.port);
      adopt(built.parts);
      disposers.push(built.dispose);
    }
    const restRight = resolvePose(setup.right), restLeft = resolvePose(setup.left);
    const resolved = new Map<HandKey[], PosedKey[]>();
    const track = (keys: HandKey[] | undefined, rest: ResolvedPose) => {
      if (!keys) return null;
      let list = resolved.get(keys);
      if (!list) {
        list = keys.map((key) => { const pose = resolvePose(key.pose); return { t: key.t, pose: key.toRest ? blendPose(pose, rest, key.toRest, pose) : pose, via: key.via }; });
        resolved.set(keys, list);
      }
      return list;
    };
    const p = new THREE.Vector3(), r = new THREE.Vector3();
    return {
      spec, root, muzzle, port, view: setup.view, reload: setup.reload, cycle: setup.cycle,
      ready: Boolean(built),
      fit(apply) {
        apply(restLeft, true);
        apply(restRight, false);
        // Keys that lean on the resting grips were resolved against where those used to be.
        resolved.clear();
      },
      movers: () => [...parts.values()].flat(),
      pose(timeline, t, out) {
        const left = timeline ? track(timeline.left, restLeft) : null, right = timeline ? track(timeline.right, restRight) : null, sampled = timeline?.sampled;
        if (left) sampleHand(left, restLeft, t, out.left, sampled); else blendPose(restLeft, restLeft, 0, out.left);
        if (right) sampleHand(right, restRight, t, out.right, sampled); else blendPose(restRight, restRight, 0, out.right);
        sampleKeys(timeline?.body, t, out.bodyPosition, r, sampled);
        out.bodyRotation.set(r.x, r.y, r.z);
        parts.forEach((rests, name) => {
          const hidden = sampleKeys(timeline?.parts?.[name], t, p, r, sampled);
          // The stripper clip and its rounds only exist while a timeline is handling them.
          const always = name.startsWith("clip") && !timeline?.parts?.[name];
          delta.setFromEuler(euler.set(r.x, r.y, r.z));
          rests.forEach((rest) => {
            rest.object.position.copy(rest.position).add(p);
            rest.object.quaternion.copy(delta).multiply(rest.quaternion);
            rest.object.visible = !(hidden || always);
          });
        });
      },
      // Late-bound for authored models.
      ...({ adopt } as object),
    } as WeaponRig & { adopt: typeof adopt };
  };

  const rigs = config.map((setup) => {
    if (setup.id === "m4") return makeRig(setup, buildM4(kit));
    if (setup.id === "famas") return makeRig(setup, buildFamas(kit));
    if (setup.id === "uzi") return makeRig(setup, buildUzi(kit));
    if (setup.id === "deagle") return makeRig(setup, buildDeagle(kit));
    return makeRig(setup, null);
  });
  const byId = (id: WeaponId) => rigs.find((rig) => rig.spec.id === id)!;
  const loader = new GLTFLoader(manager);

  loader.load("/models/ak-platform.glb", ({ scene: object }) => {
    if (isDisposed()) return;
    const rig = byId("ak47") as WeaponRig & { adopt: (parts: Map<string, THREE.Object3D[]>) => void };
    const surfacing = surfaceWeapon(object, anisotropy);
    disposers.push(surfacing.dispose);
    rig.adopt(mountAuthored(rig.root, object, surfacing, [0, 0.065, -0.656], { mag: /^AK-47[ _]2[ _]Mag[ _]1$/, bolt: /^AK-47[ _]2[ _]Bolt[ _]Carrier[ _]1$/ }));
    rig.muzzle.position.set(0, 0.065, -0.66);
    rig.ready = true;
    rig.port.set(0.03, 0.07, -0.16);
  });

  loader.load("/models/bolt-action-rifle/rifle.gltf", ({ scene: object }) => {
    if (isDisposed()) return;
    const rig = byId("rifle") as WeaponRig & { adopt: (parts: Map<string, THREE.Object3D[]>) => void };
    const surfacing = prepareRifle(object, anisotropy);
    disposers.push(surfacing.dispose);
    // The bolt body turns and slides; the cocking piece behind it only slides.
    const parts = mountAuthored(rig.root, object, surfacing, [0, 0.07, -0.936], { bolt: /bolt_a$/i, striker: /bolt_b$/i });
    // Five rounds on a stripper clip, shown only while reloading. Each round is its own part,
    // as they leave the clip one after another.
    const brass = new THREE.MeshStandardMaterial({ color: 0xb8863a, metalness: 1, roughness: 0.32 });
    const copper = new THREE.MeshStandardMaterial({ color: 0xa5562c, metalness: 1, roughness: 0.36 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8d877b, metalness: 0.9, roughness: 0.5 });
    const tube = (front: number, back: number, length: number, z: number) => new THREE.CylinderGeometry(front, back, length, 12).rotateX(-Math.PI / 2).translate(0, 0, z);
    const caseGeometry = mergeGeometries([tube(0.0058, 0.0062, 0.05, 0), tube(0.0071, 0.0071, 0.0016, 0.0258)], false)!;
    const bulletGeometry = tube(0.0012, 0.0039, 0.026, -0.038);
    const length = CLIP.pitch * 4 + 0.017;
    const stripGeometry = mergeGeometries([-1, 0, 1].map((side) => side === 0
      ? new THREE.BoxGeometry(0.0156, length, 0.0011)
      : new THREE.BoxGeometry(0.0013, length, 0.0042).translate(side * 0.0078, 0, -0.0016)), false)!;
    for (let i = 0; i < 5; i += 1) {
      const round = new THREE.Group();
      round.add(new THREE.Mesh(caseGeometry, brass), new THREE.Mesh(bulletGeometry, copper));
      round.position.set(...CLIP.seat(i));
      parts.set(`clip${i + 1}`, [round]);
    }
    const strip = new THREE.Mesh(stripGeometry, steel);
    strip.position.set(...add(CLIP.seat(2), [0, 0, 0.0276]));
    strip.rotation.z = CLIP.lean - Math.PI / 2;
    parts.set("clip", [strip]);
    parts.forEach((objects, name) => { if (name.startsWith("clip")) objects.forEach((object) => { object.visible = false; rig.root.add(object); }); });
    disposers.push(() => { brass.dispose(); copper.dispose(); steel.dispose(); caseGeometry.dispose(); bulletGeometry.dispose(); stripGeometry.dispose(); });
    rig.adopt(parts);
    rig.muzzle.position.set(0, 0.07, -0.94);
    rig.ready = true;
    rig.port.set(0.025, 0.08, -0.09);
  });

  return { rigs, byId, dispose() { disposers.forEach((dispose) => dispose()); } };
}

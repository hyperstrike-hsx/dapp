import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ARSENAL, type WeaponId, type WeaponSpec } from "./arsenalSpec";
import type { Mover } from "./collider";
import { blendPose, resolvePose, type HandPose, type ResolvedPose } from "./hands";
import { createFinishKit, prepareRifle, surfaceBuilt, surfaceWeapon, type FinishKit, type WeaponSurfacing } from "./weapon";

// The five weapons.
//
// Every weapon lives in the same "weapon space": real metres, bore along -Z,
// +Y up, origin where the web of the firing hand meets the grip. The AK and
// the bolt-action are authored models normalised into that space; the M4, FAMAS
// and Uzi are modelled here from extruded side profiles, turned parts and
// chamfered blocks, then surfaced with the same edge-wear materials.
//
// Each weapon carries its grips (where both hands rest) and timelines for the
// reload and, for the bolt-action, for working the action between shots.

type V3 = [number, number, number];
export type ReloadSound = "magOut" | "magIn" | "rack" | "slap" | "boltUp" | "boltBack" | "boltHome" | "cloth";
type HandKey = { t: number; pose: HandPose };
type PartKey = { t: number; p?: V3; r?: V3; hide?: boolean };
export type Timeline = {
  left?: HandKey[];
  right?: HandKey[];
  body?: PartKey[];
  parts?: Record<string, PartKey[]>;
  sounds?: Array<{ t: number; kind: ReloadSound }>;
  /** Moment a spent case leaves the action (bolt-action). */
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
      const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
      const b = Math.min(bevel, width * 0.3);
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: width - b * 2, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, curveSegments: 1 });
      geometry.rotateY(-Math.PI / 2);
      place(geometry, [x + width / 2 - b, 0, 0], finish);
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
    /** Merges queued geometry into one mesh per part and finish. */
    finish(kit: FinishKit) {
      const groups = new Map<string, { group: THREE.Group; finish: string; geometries: THREE.BufferGeometry[] }>();
      pending.forEach(({ group, finish, geometry }) => {
        const key = `${group.id}:${finish}`;
        const entry = groups.get(key) ?? { group, finish, geometries: [] };
        const flat = geometry.index ? geometry.toNonIndexed() : geometry;
        if (flat !== geometry) geometry.dispose();
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
      return surfaceBuilt(root, kit);
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
  const surface = b.finish(kit);
  return { root: b.root, parts: builtParts(b), muzzle: [0, B, -0.582], port: [0.03, B, -0.085], dispose() { surface.dispose(); extras.forEach((m) => m.dispose()); geometries.forEach((g) => g.dispose()); } };
}

function buildFamas(kit: FinishKit): Built {
  const b = createBuilder(), B = 0.05;
  // One-piece bullpup body: handguard, receiver and stock.
  b.profile([[-0.21, B + 0.03], [-0.21, B - 0.03], [-0.13, B - 0.046], [0.02, B - 0.05], [0.075, -0.03], [0.168, -0.03], [0.2, -0.052], [0.398, -0.092], [0.404, B + 0.03], [0.362, B + 0.047], [0.17, B + 0.047], [0.15, B + 0.03]], 0.05, "grey", 0, 0.006);
  b.box(0.053, 0.14, 0.014, [0, -0.012, 0.408], "rubber", undefined, 0.005);
  for (let i = 0; i < 5; i += 1) b.box(0.052, 0.004, 0.05, [0, B - 0.004 - i * 0.008, -0.165], "grey", undefined, 0.001);
  b.box(0.03, 0.012, 0.31, [0, B + 0.034, -0.03], "parkerized");
  // Grip and whole-hand trigger guard.
  b.profile(gripProfile(0.016, -0.034, 0.028, 0.105), 0.032, "grey", 0, 0.004);
  b.box(0.02, 0.006, 0.112, [0, -0.09, -0.062], "grey", [-0.27, 0, 0], 0.002);
  b.box(0.02, 0.056, 0.007, [0, -0.046, -0.121], "grey", [-0.1, 0, 0], 0.002);
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
  const surface = b.finish(kit);
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
  const surface = b.finish(kit);
  return { root: b.root, parts: builtParts(b), muzzle: [0, B, -0.249], port: [0.03, 0.058, -0.05], dispose: surface.dispose };
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

/** Detachable magazine change: grab, strip, fetch a fresh one, seat it. Ends at `end`. */
function magazineSwap(hold: HandPose, grasp: HandPose, pull: V3, pullTilt: V3, end: number) {
  const s = end / 0.66;
  const away = (curl: number): HandPose => ({ ...grasp, p: OFFSCREEN_LEFT, curl });
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
      { t: 0.4 * s, p: add(OFFSCREEN_LEFT, [0.03, 0.1, -0.1]), r: pullTilt, hide: true },
      { t: 0.47 * s, p: add(OFFSCREEN_LEFT, [0.03, 0.1, -0.1]), r: pullTilt },
      { t: 0.58 * s, p: pull, r: pullTilt },
      { t: 0.64 * s, p: [0, 0.004, 0] },
      { t: 0.66 * s },
    ] as PartKey[],
    sounds: [{ t: 0.1 * s, kind: "cloth" as const }, { t: 0.23 * s, kind: "magOut" as const }, { t: 0.63 * s, kind: "magIn" as const }],
    hold,
  };
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

const GRIP_F: V3 = [0, -0.34, -0.94];
const firing = (p: V3, f: V3 = GRIP_F): HandPose => hand(p, f, [-1, 0, 0.05], [0.42, 0.92, 0.96, 1, 0.55]);
const support = (p: V3, curl = 0.72): HandPose => hand(p, [0.86, 0.5, -0.08], [-0.5, 0.86, 0], [curl, curl + 0.04, curl + 0.04, curl, 0.25]);
const overTop = (p: V3, curl = 0.6): HandPose => hand(p, [0.96, -0.2, 0.15], [0.2, -0.97, 0], curl);
const sideGrasp = (p: V3, curl = 0.85): HandPose => hand(p, [0.12, -0.25, -0.96], [1, 0, 0], curl);

function setups(): RigSetup[] {
  // AK-47: rock the magazine out and in, then reach over to run the charging handle.
  const akLeft = support([-0.014, -0.004, -0.33]);
  const akSwap = magazineSwap(akLeft, sideGrasp([-0.032, -0.085, -0.2]), [0, -0.1, -0.075], [-0.55, 0, 0], 0.62);
  const akHandle = overTop([0.02, 0.118, -0.215]);
  const ak: RigSetup = {
    id: "ak47", view: { p: [0, 0, 0], r: [0, 0, 0] },
    right: firing([0.031, -0.052, 0.024]), left: akLeft,
    reload: {
      left: [...akSwap.left, { t: 0.76, pose: moved(akHandle, [-0.02, 0.03, 0], 0.3) }, { t: 0.81, pose: akHandle }, { t: 0.87, pose: moved(akHandle, [0, 0, 0.075]) }, { t: 0.9, pose: moved(akHandle, [-0.01, 0.02, 0.07], 0.2) }],
      body: [at(0.13, MAG_TILT), at(0.66, MAG_TILT), { t: 0.78, p: [-0.05, 0.03, 0.02], r: [0.14, 0.12, 0.62] }, { t: 0.9, p: [-0.05, 0.03, 0.03], r: [0.16, 0.12, 0.62] }],
      parts: { mag: akSwap.mag, bolt: [{ t: 0.81 }, { t: 0.87, p: [0, 0, 0.075] }, { t: 0.895 }] },
      sounds: [...akSwap.sounds, { t: 0.82, kind: "rack" }],
    },
  };

  // M4A1: straight magazine swap, then slap the bolt release.
  const m4Left = support([-0.016, 0.01, -0.28]);
  const m4Swap = magazineSwap(m4Left, sideGrasp([-0.03, -0.11, -0.118]), [0, -0.17, 0.012], [0.06, 0, 0], 0.66);
  const m4Slap = hand([-0.047, 0.05, -0.085], [0, 0.55, -0.83], [1, 0, 0], [0.12, 0.12, 0.15, 0.2, 0.1]);
  const m4: RigSetup = {
    id: "m4", view: { p: [0, 0, 0], r: [0, 0, 0] },
    right: firing([0.031, -0.048, 0.006]), left: m4Left,
    reload: {
      left: [...m4Swap.left, { t: 0.76, pose: moved(m4Slap, [-0.07, 0, 0.02]) }, { t: 0.8, pose: m4Slap }, { t: 0.86, pose: moved(m4Slap, [-0.04, -0.01, 0]) }],
      body: [at(0.13, MAG_TILT), at(0.68, MAG_TILT), { t: 0.795, p: [-0.03, 0.03, 0.02], r: [0.16, 0.16, -0.24] }, { t: 0.82, p: [0, 0.028, 0.02], r: [0.15, 0.1, -0.12] }],
      parts: { mag: m4Swap.mag, bolt: [{ t: 0, p: [0, 0, 0.05] }, { t: 0.8, p: [0, 0, 0.05] }, { t: 0.815 }], charge: [{ t: 0.8 }, { t: 0.81, p: [0, 0, 0.004] }, { t: 0.83 }] },
      sounds: [...m4Swap.sounds, { t: 0.8, kind: "slap" }],
    },
  };

  // FAMAS: the magazine sits behind the grip; the charging handle is under the carry handle.
  const faLeft = support([-0.016, -0.014, -0.15]);
  const faSwap = magazineSwap(faLeft, sideGrasp([-0.034, -0.11, 0.128]), [0, -0.19, 0.01], [0.05, 0, 0], 0.66);
  const faHandle = hand([-0.036, 0.108, -0.052], [0.75, 0.3, -0.58], [0.55, -0.1, 0.83], [0.75, 0.75, 0.5, 0.4, 0.2]);
  const faTilt: PartKey = { t: 0, p: [-0.06, 0.07, 0.0], r: [0.42, 0.3, -0.6] };
  const famas: RigSetup = {
    id: "famas", view: { p: [0.0, 0, -0.13], r: [0, 0, 0] },
    right: firing([0.032, -0.05, 0.008]), left: faLeft,
    reload: {
      left: [...faSwap.left, { t: 0.77, pose: moved(faHandle, [-0.03, 0.01, 0], 0.3) }, { t: 0.81, pose: faHandle }, { t: 0.87, pose: moved(faHandle, [0, 0, 0.08]) }, { t: 0.9, pose: moved(faHandle, [-0.02, 0, 0.07], 0.25) }],
      body: [at(0.13, faTilt), at(0.67, faTilt), { t: 0.78, p: [-0.03, 0.03, 0.02], r: [0.14, 0.22, 0.2] }, { t: 0.9, p: [-0.03, 0.03, 0.025], r: [0.15, 0.22, 0.2] }],
      parts: { mag: faSwap.mag, charge: [{ t: 0.81 }, { t: 0.87, p: [0, 0, 0.08] }, { t: 0.895 }], bolt: [{ t: 0.81 }, { t: 0.87, p: [0, 0, 0.05] }, { t: 0.895 }] },
      sounds: [...faSwap.sounds, { t: 0.82, kind: "rack" }],
    },
  };

  // Uzi: magazine through the grip, palm it home, then draw the cocking knob.
  const uziLeft = support([-0.014, -0.048, -0.1]);
  const uziSwap = magazineSwap(uziLeft, sideGrasp([-0.03, -0.2, -0.006]), [0, -0.2, 0], [0, 0, 0], 0.58);
  const uziPalm = hand([-0.015, -0.275, 0.0], [0.9, 0.4, 0], [-0.4, 0.9, 0], 0.15);
  const uziKnob = overTop([-0.01, 0.112, -0.075], 0.55);
  const uziTilt: PartKey = { t: 0, p: [-0.06, 0.06, 0.02], r: [0.3, 0.25, -0.5] };
  const uzi: RigSetup = {
    id: "uzi", view: { p: [-0.02, 0.015, -0.03], r: [0, 0, 0] },
    right: firing([0.032, -0.052, 0.0], [0, -0.06, -1]), left: uziLeft,
    reload: {
      left: [...uziSwap.left, { t: 0.63, pose: moved(uziPalm, [0, -0.06, 0]) }, { t: 0.67, pose: uziPalm }, { t: 0.72, pose: moved(uziPalm, [-0.02, -0.04, 0]) }, { t: 0.81, pose: moved(uziKnob, [-0.02, 0.02, 0], 0.3) }, { t: 0.85, pose: uziKnob }, { t: 0.9, pose: moved(uziKnob, [0, 0, 0.065]) }, { t: 0.93, pose: moved(uziKnob, [-0.02, 0.02, 0.06], 0.25) }],
      body: [at(0.13, uziTilt), at(0.6, uziTilt), { t: 0.67, p: [-0.06, 0.075, 0.02], r: [0.34, 0.25, -0.5] }, at(0.72, uziTilt), { t: 0.82, p: [-0.04, 0.02, 0.02], r: [0.1, 0.16, 0.4] }, { t: 0.93, p: [-0.04, 0.02, 0.025], r: [0.11, 0.16, 0.4] }],
      parts: { mag: uziSwap.mag, charge: [{ t: 0.85 }, { t: 0.9, p: [0, 0, 0.065] }, { t: 0.92 }], bolt: [{ t: 0.85 }, { t: 0.9, p: [0, 0, 0.04] }, { t: 0.92 }] },
      sounds: [...uziSwap.sounds, { t: 0.67, kind: "slap" }, { t: 0.86, kind: "rack" }],
    },
  };

  // Bolt-action: the firing hand works the bolt; reloading feeds a stripper clip.
  const riRight = firing([0.03, -0.012, 0.035], [0, -0.5, -0.87]);
  const riLeft = support([-0.014, -0.028, -0.36]);
  const knob = hand([0.066, 0.03, -0.078], [-0.2, 0.25, -0.95], [-0.9, 0.35, 0.2], [0.7, 0.75, 0.75, 0.7, 0.5]);
  const lifted = moved(knob, [-0.028, 0.062, 0]);
  const drawn = moved(lifted, [0, 0, 0.088]);
  const open: PartKey = { t: 0, p: [0, 0, 0.088], r: [0, 0, 1.05] };
  const clipHand = hand([0.062, 0.135, -0.07], [-0.8, -0.5, -0.33], [-0.45, 0.2, 0.87], [0.6, 0.7, 0.8, 0.8, 0.3]);
  const rifle: RigSetup = {
    id: "rifle", view: { p: [0.03, 0.01, 0.06], r: [0, -0.03, 0] },
    right: riRight, left: riLeft,
    cycle: {
      right: [{ t: 0.07, pose: riRight }, { t: 0.24, pose: knob }, { t: 0.37, pose: lifted }, { t: 0.54, pose: drawn }, { t: 0.7, pose: lifted }, { t: 0.82, pose: knob }, { t: 0.86, pose: knob }],
      body: [{ t: 0.24, p: [0, 0, 0], r: [0.02, 0, 0.1] }, { t: 0.54, p: [0, 0.004, 0.012], r: [0.05, 0.03, 0.2] }, { t: 0.7, p: [0, 0, -0.006], r: [0.02, 0.01, 0.16] }, { t: 0.84, p: [0, -0.003, 0], r: [0, 0, 0.04] }],
      parts: { bolt: [{ t: 0.24 }, { t: 0.37, r: [0, 0, 1.05] }, at(0.54, open), { t: 0.7, r: [0, 0, 1.05] }, { t: 0.82 }] },
      sounds: [{ t: 0.3, kind: "boltUp" }, { t: 0.46, kind: "boltBack" }, { t: 0.72, kind: "boltHome" }],
      eject: 0.5,
    },
    reload: {
      right: [
        { t: 0.07, pose: knob }, { t: 0.12, pose: lifted }, { t: 0.19, pose: drawn },
        { t: 0.3, pose: { ...clipHand, p: [0.22, -0.3, 0.25] } }, { t: 0.36, pose: { ...clipHand, p: [0.22, -0.3, 0.25] } },
        { t: 0.5, pose: clipHand }, { t: 0.56, pose: moved(clipHand, [0, -0.012, 0]) }, { t: 0.68, pose: moved(clipHand, [0, -0.05, 0], [0.8, 0.8, 0.85, 0.85, 0.9]) },
        { t: 0.74, pose: moved(clipHand, [0.04, 0.03, 0.03], 0.4) }, { t: 0.82, pose: drawn }, { t: 0.9, pose: lifted }, { t: 0.95, pose: knob },
      ],
      body: [{ t: 0.1, p: [-0.03, 0.025, 0.03], r: [0.12, 0.16, 0.42] }, { t: 0.8, p: [-0.03, 0.025, 0.03], r: [0.12, 0.16, 0.42] }, { t: 0.92, p: [-0.01, 0.01, 0], r: [0.05, 0.05, 0.15] }],
      parts: {
        bolt: [{ t: 0.07 }, { t: 0.12, r: [0, 0, 1.05] }, at(0.19, open), at(0.82, open), { t: 0.9, r: [0, 0, 1.05] }, { t: 0.95 }],
        clip: [{ t: 0, p: [0.19, -0.5, 0.33], hide: true }, { t: 0.36, p: [0.19, -0.5, 0.33] }, { t: 0.5, p: [0, 0.035, 0] }, { t: 0.56, p: [0, 0.008, 0] }, { t: 0.68, p: [0, -0.022, 0], hide: true }, { t: 1, hide: true }],
      },
      sounds: [{ t: 0.1, kind: "boltUp" }, { t: 0.16, kind: "boltBack" }, { t: 0.55, kind: "magIn" }, { t: 0.66, kind: "slap" }, { t: 0.86, kind: "boltHome" }],
    },
  };
  return [ak, m4, famas, uzi, rifle];
}

const identityKey: PartKey = { t: 0 };
const euler = new THREE.Euler(), delta = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3();

function sampleKeys(keys: PartKey[] | undefined, t: number, outP: THREE.Vector3, outR: THREE.Vector3) {
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
  const k = span > 0 ? ease(THREE.MathUtils.clamp((t - a.t) / span, 0, 1)) : 1;
  outP.lerpVectors(va.set(...(a.p ?? [0, 0, 0])), vb.set(...(b.p ?? [0, 0, 0])), k);
  outR.lerpVectors(va.set(...(a.r ?? [0, 0, 0])), vb.set(...(b.r ?? [0, 0, 0])), k);
  return Boolean(a.hide);
}

function sampleHand(keys: Array<{ t: number; pose: ResolvedPose }>, rest: ResolvedPose, t: number, out: ResolvedPose) {
  let a = { t: 0, pose: rest }, b = { t: 1, pose: rest };
  for (const key of keys) {
    if (key.t <= t) a = key;
    else { b = key; break; }
  }
  if (b.t <= a.t) b = { t: 1, pose: rest };
  blendPose(a.pose, b.pose, ease(THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1)), out);
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
    const resolved = new Map<HandKey[], Array<{ t: number; pose: ResolvedPose }>>();
    const track = (keys: HandKey[] | undefined) => {
      if (!keys) return null;
      let list = resolved.get(keys);
      if (!list) { list = keys.map((key) => ({ t: key.t, pose: resolvePose(key.pose) })); resolved.set(keys, list); }
      return list;
    };
    const p = new THREE.Vector3(), r = new THREE.Vector3();
    return {
      spec, root, muzzle, port, view: setup.view, reload: setup.reload, cycle: setup.cycle,
      ready: Boolean(built),
      fit(apply) {
        apply(restLeft, true);
        apply(restRight, false);
      },
      movers: () => [...parts.values()].flat(),
      pose(timeline, t, out) {
        const left = timeline ? track(timeline.left) : null, right = timeline ? track(timeline.right) : null;
        if (left) sampleHand(left, restLeft, t, out.left); else blendPose(restLeft, restLeft, 0, out.left);
        if (right) sampleHand(right, restRight, t, out.right); else blendPose(restRight, restRight, 0, out.right);
        sampleKeys(timeline?.body, t, out.bodyPosition, r);
        out.bodyRotation.set(r.x, r.y, r.z);
        parts.forEach((rests, name) => {
          const hidden = sampleKeys(timeline?.parts?.[name], t, p, r);
          const always = name === "clip" && !timeline?.parts?.clip;
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
    return makeRig(setup, null);
  });
  const byId = (id: WeaponId) => rigs.find((rig) => rig.spec.id === id)!;
  const loader = new GLTFLoader(manager);

  loader.load("/models/ak-platform.glb", ({ scene: object }) => {
    if (isDisposed()) return;
    const rig = byId("ak47") as WeaponRig & { adopt: (parts: Map<string, THREE.Object3D[]>) => void };
    const surfacing = surfaceWeapon(object, anisotropy, manager);
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
    const parts = mountAuthored(rig.root, object, surfacing, [0, 0.07, -0.936], { bolt: /bolt_[ab]$/i });
    // A five-round stripper clip, shown only while reloading.
    const brass = new THREE.MeshStandardMaterial({ color: 0xb8863a, metalness: 1, roughness: 0.32 });
    const copper = new THREE.MeshStandardMaterial({ color: 0xa5562c, metalness: 1, roughness: 0.36 });
    const caseGeometry = new THREE.CylinderGeometry(0.0058, 0.0062, 0.05, 10), bulletGeometry = new THREE.CylinderGeometry(0.0012, 0.0039, 0.026, 10);
    caseGeometry.rotateX(-Math.PI / 2); bulletGeometry.rotateX(-Math.PI / 2);
    const clip = new THREE.Group();
    for (let i = 0; i < 5; i += 1) {
      const round = new THREE.Mesh(caseGeometry, brass), bullet = new THREE.Mesh(bulletGeometry, copper);
      round.position.y = i * 0.0118;
      bullet.position.set(0, i * 0.0118, -0.038);
      clip.add(round, bullet);
    }
    clip.position.set(0, 0.085, -0.075);
    clip.visible = false;
    rig.root.add(clip);
    parts.set("clip", [clip]);
    disposers.push(() => { brass.dispose(); copper.dispose(); caseGeometry.dispose(); bulletGeometry.dispose(); });
    rig.adopt(parts);
    rig.muzzle.position.set(0, 0.07, -0.94);
    rig.ready = true;
    rig.port.set(0.025, 0.08, -0.09);
  });

  return { rigs, byId, dispose() { disposers.forEach((dispose) => dispose()); } };
}

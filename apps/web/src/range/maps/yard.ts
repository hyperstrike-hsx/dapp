import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial } from "../pbr";
import { canvasTexture, createKit, iBeam, projectUv, sunlitFromBoxes, type RangeEnvironment, type RangeOptions, type Transform } from "../kit";
import { createProps, type PropItem, type PropKind } from "../props";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createWind } from "../wind";
import type { Glow } from "../volumetric";

// Siding: a freight yard at night in steady rain.
//
// The range is laid out on the old transfer road, a sunken lane between two high-level sidings. West of it
// stands the goods shed, its canopy reaching out over the dock road where boxcars wait; east of it a concrete
// retaining wall and the brick base of the signal cabin, the furnace against it. Beyond the far end the yard
// runs on into the dark at the upper level: stub roads to their buffer stops, a signal gantry across them,
// a diesel idling on the hump road with its headlight on the range, high masts and a water tower in the rain.
//
// Light: no moon. The key is the high mast behind and to the left of the firing line (the `sun`), a cold
// flood that throws the shed canopy, the wagons and the posts down the lane. Everything else is practicals:
// sodium lamps under the shed canopy, cold fittings on the retaining wall, enamel pendants under the tin
// roof of the firing line. Those are too many to be light objects, so the surfaces round them add their
// light in the shader (`lit`), and the rain is drawn additively and lit by the same lamps: it only shows
// where a lamp finds it, which is what puts the cones in the air.
//
// Weather: rain is one instanced shader that follows the eye (two layers), sheltered under the two roofs.
// Drips, the gutter's overflow and the downpipe are a second one; rings open on the wet ground in the floor
// shader and as sprites. Nothing that moves casts a shadow: the key's map is rendered once.

type V3 = [number, number, number];
type Part = [THREE.BufferGeometry, number];
type Facing = "x+" | "x-" | "z+" | "z-" | "y+";
type Cell = [number, number, number, number];

const PI = Math.PI;
const WALL_X = 9.54, WALL_TOP = 4.5, BACK_Z = 9.7, FAR_Z = -28.6;
/** The yard stands this far above the transfer road; rail top on its sidings; the height of the bank the high road runs on. */
const YARD = 2.6, RAIL = YARD + 0.35, HUMP = 2.2;
const WEST_ROAD = -11.9, EAST_ROAD = 14.4, STUBS = [-7, 0, 7], SIDINGS = [19, 29.5, 34.1, -28.6, -33.2, -37.8];
const GANTRY_Z = -34, GANTRY_Y = 10.5;
const LOCO = { x: -7, z: -42.6 };
/** Direction from the range up to the key mast: behind the firing line and to its left. */
const TO_SUN = new THREE.Vector3(-0.3, 0.66, 0.74).normalize();
/** Where the wind blows to (see wind.ts), and how far the rain drifts per metre it falls (x, z). */
const WIND_HEADING = -0.36, SLANT: [number, number] = [0.09, -0.24];
/** The tin roof over the firing line: its low front edge, the height there, and its rise per metre toward the back wall. */
const TIN = { front: 3.1, low: 4.85, pitch: 0.4 };
const tinY = (z: number) => TIN.low + TIN.pitch * (z - TIN.front);
const SHED = { x0: -24, x1: -14.5, z0: -34, z1: 2.2, eaves: 8.3, ridge: 11.6, edge: -9.2, edgeY: 7.1 };
const CABIN = { x1: 12.5, z0: -14.5, z1: -6.5, floor: 4.7, eaves: 7.3, ridge: 8.9 };
const DEPOT = { x0: -10.3, x1: 12.4, z1: 17.7, top: 10.2 };
/** Buttress piers on the side walls, kept clear of the range signs and the alarm lamps. */
const W_PIERS = [-27.4, -23.7, -19.82, -14.05, -6.6, -3.0, 0.6];
const E_PIERS = [-27.6, -19.95, -3.2, 0.4];
const COLD = 0xd4e4ff, SODIUM = 0xffa040, WARM = 0xffc27e;
const ATLAS = 2048;

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Any geometry made mergeable: indexed, with a uv and one vertex colour (`null` keeps the colours it has). */
function ready(geometry: THREE.BufferGeometry, colour: THREE.Color | null) {
  const count = geometry.attributes.position.count, part = new THREE.BufferGeometry();
  part.setAttribute("position", geometry.attributes.position);
  part.setAttribute("normal", geometry.attributes.normal);
  part.setAttribute("uv", geometry.attributes.uv ?? new THREE.Float32BufferAttribute(count * 2, 2));
  if (colour) {
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) { colours[i * 3] = colour.r; colours[i * 3 + 1] = colour.g; colours[i * 3 + 2] = colour.b; }
    part.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  } else part.setAttribute("color", geometry.attributes.color);
  part.setIndex(geometry.index ?? Array.from({ length: count }, (_, i) => i));
  return part;
}

/** One geometry out of parts that each have a colour of their own (sRGB hex). */
function assemble(parts: Part[]) {
  const colour = new THREE.Color();
  return mergeGeometries(parts.map(([geometry, hex]) => ready(geometry, colour.set(hex))));
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

function cyl(radius: number, height: number, x: number, y: number, z: number, axis: "x" | "y" | "z" = "y", segments = 12, top = radius) {
  const geometry = new THREE.CylinderGeometry(top, radius, height, segments);
  if (axis === "x") geometry.rotateZ(PI / 2); else if (axis === "z") geometry.rotateX(PI / 2);
  return geometry.translate(x, y, z);
}

function rod(a: V3, b: V3, radius: number, segments = 6) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), segments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  return geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

/** A square-section member between two points. */
function beam(a: V3, b: V3, w: number, d = w) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const geometry = new THREE.BoxGeometry(w, from.distanceTo(to), d);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  return geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

function tube(points: V3[], radius: number, segments = 20, radial = 6) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))), segments, radius, radial, false);
}

/** A flat panel centred on a point and facing along an axis. */
function quad(w: number, h: number, x: number, y: number, z: number, facing: Facing, turn = 0) {
  const geometry = new THREE.PlaneGeometry(w, h);
  if (facing === "x+") geometry.rotateY(PI / 2);
  else if (facing === "x-") geometry.rotateY(-PI / 2);
  else if (facing === "z-") geometry.rotateY(PI);
  else if (facing === "y+") { geometry.rotateX(-PI / 2); if (turn) geometry.rotateY(turn); }
  return geometry.translate(x, y, z);
}

/** Points a quad's UVs at one cell of the atlas. */
function cellUv<T extends THREE.BufferGeometry>(geometry: T, cell: Cell): T {
  const [px, py, pw, ph] = cell, uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (px + uv.getX(i) * pw) / ATLAS, 1 - (py + (1 - uv.getY(i)) * ph) / ATLAS);
  return geometry;
}

/** Flat-shaded faces from convex polygons wound anticlockwise as seen from outside. */
function polys(faces: V3[][]) {
  const position: number[] = [];
  for (const face of faces) for (let i = 1; i < face.length - 1; i += 1) position.push(...face[0], ...face[i], ...face[i + 1]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(position.length / 3 * 2, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** A pitched roof with its eaves at y = 0, centred on the origin, the ridge along z; `hip` pulls the ridge ends in. */
function roof(width: number, length: number, rise: number, hip = 0) {
  const x = width / 2, z = length / 2;
  const a: V3 = [-x, 0, -z], b: V3 = [-x, 0, z], c: V3 = [x, 0, z], d: V3 = [x, 0, -z], r0: V3 = [0, rise, -z + hip], r1: V3 = [0, rise, z - hip];
  return polys([[a, b, r1, r0], [c, d, r0, r1], [d, a, r0], [b, c, r1], [a, d, c, b]]);
}

/** A square lattice member between two points: four chords laced on every face. */
function laced(a: V3, b: V3, size: [number, number], panels: number, chord = 0.1, lace = 0.03) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), u = to.clone().sub(from), length = u.length();
  u.normalize();
  const v = Math.abs(u.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const w = new THREE.Vector3().crossVectors(u, v).normalize();
  v.crossVectors(w, u).normalize();
  const corner = (t: number, sv: number, sw: number) => from.clone().addScaledVector(u, t * length).addScaledVector(v, sv * size[0] / 2).addScaledVector(w, sw * size[1] / 2).toArray() as V3;
  const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]], parts: THREE.BufferGeometry[] = [];
  for (const [sv, sw] of corners) parts.push(beam(corner(0, sv, sw), corner(1, sv, sw), chord));
  for (let i = 0; i < panels; i += 1) {
    const t0 = i / panels, t1 = (i + 1) / panels;
    corners.forEach(([sv, sw], k) => {
      const [nv, nw] = corners[(k + 1) % 4];
      parts.push(rod(i % 2 ? corner(t0, sv, sw) : corner(t0, nv, nw), i % 2 ? corner(t1, nv, nw) : corner(t1, sv, sw), lace, 4));
      if (i > 0) parts.push(rod(corner(t0, sv, sw), corner(t0, nv, nw), lace, 4));
    });
  }
  return parts;
}

// ---- Rolling stock -----------------------------------------------------------------------------------
// Modelled about the middle of the vehicle with y = 0 at rail top and its length along z. White parts take
// the livery (an instance colour); dark parts stay dark under it.

const STOCK_DARK = 0x1a1918, STOCK_ROOF = 0xa9a9a9;

function bogie(parts: Part[], z: number, axles = [-0.9, 0.9], frame = 2.5) {
  for (const side of [-1, 1]) {
    parts.push([box(0.14, 0.34, frame, side * 1.0, 0.54, z), STOCK_DARK]);
    parts.push([box(0.2, 0.22, 0.5, side * 1.0, 0.38, z), STOCK_DARK]);
  }
  parts.push([box(2.1, 0.26, 0.42, 0, 0.6, z), STOCK_DARK]);
  for (const at of axles) {
    parts.push([cyl(0.07, 2.0, 0, 0.46, z + at, "x", 6), STOCK_DARK]);
    for (const side of [-1, 1]) parts.push([cyl(0.46, 0.13, side * 0.7175, 0.46, z + at, "x", 16), 0x2b2724]);
  }
}

function ladder(parts: Part[], x: number, z: number, y0: number, y1: number, along: "x" | "z", width = 0.42) {
  const dx = along === "x" ? width / 2 : 0, dz = along === "z" ? width / 2 : 0;
  for (const side of [-1, 1]) parts.push([box(0.035, y1 - y0, 0.035, x + side * dx, (y0 + y1) / 2, z + side * dz), STOCK_DARK]);
  for (let y = y0 + 0.2; y < y1; y += 0.38) parts.push([box(along === "x" ? width : 0.03, 0.03, along === "z" ? width : 0.03, x, y, z), STOCK_DARK]);
}

function boxcarGeometry() {
  const P: Part[] = [], L = 12.2, W = 2.95, floor = 1.1, top = 4.05, H = top - floor;
  P.push([box(W, H, L, 0, floor + H / 2, 0), 0xffffff]);
  const crown = new THREE.Shape();
  crown.moveTo(-W / 2 - 0.05, top - 0.03); crown.lineTo(W / 2 + 0.05, top - 0.03); crown.lineTo(W / 2 + 0.05, top + 0.03); crown.lineTo(0.8, top + 0.25); crown.lineTo(-0.8, top + 0.25); crown.lineTo(-W / 2 - 0.05, top + 0.03);
  crown.closePath();
  P.push([new THREE.ExtrudeGeometry(crown, { depth: L + 0.12, bevelEnabled: false }).translate(0, 0, -(L + 0.12) / 2), STOCK_ROOF]);
  P.push([box(0.5, 0.04, L - 0.5, 0, top + 0.35, 0), STOCK_DARK]);
  for (let i = -4; i <= 4; i += 1) P.push([box(0.44, 0.1, 0.06, 0, top + 0.29, i * 1.4), STOCK_DARK]);
  for (const side of [-1, 1]) {
    const x = side * (W / 2 + 0.03);
    for (let i = 0; i < 14; i += 1) {
      const z = -L / 2 + 0.25 + i * (L - 0.5) / 13;
      if (Math.abs(z) > 1.7) P.push([box(0.06, H - 0.1, 0.07, x, floor + H / 2, z), 0xffffff]);
    }
    // The sliding door on its runners, proud of the side.
    P.push([box(0.07, H - 0.25, 3.0, x + side * 0.03, floor + H / 2 - 0.02, 0), 0xe9e9e9]);
    for (const z of [-1.44, -0.48, 0.48, 1.44]) P.push([box(0.05, H - 0.3, 0.07, x + side * 0.08, floor + H / 2 - 0.02, z), 0xe9e9e9]);
    for (const y of [floor + 0.85, floor + 1.8]) P.push([box(0.05, 0.07, 2.95, x + side * 0.08, y, 0), 0xe9e9e9]);
    P.push([box(0.08, 0.08, 6.2, x + side * 0.02, top - 0.1, 1.55), STOCK_DARK]);
    P.push([box(0.08, 0.06, 6.2, x + side * 0.02, floor + 0.04, 1.55), STOCK_DARK]);
    P.push([box(0.1, 0.26, L, side * (W / 2 - 0.02), floor - 0.1, 0), STOCK_DARK]);
    ladder(P, x + side * 0.07, side * (L / 2 - 0.45), floor - 0.2, top + 0.1, "z");
  }
  for (const end of [-1, 1]) {
    for (const y of [1.75, 2.55, 3.35]) P.push([box(W - 0.2, 0.22, 0.07, 0, y, end * (L / 2 + 0.03)), 0xffffff]);
    P.push([box(0.3, 0.3, 0.7, 0, 0.88, end * (L / 2 + 0.3)), STOCK_DARK]);
    P.push([box(W, 0.3, 0.12, 0, floor - 0.12, end * (L / 2 - 0.04)), STOCK_DARK]);
  }
  P.push([new THREE.TorusGeometry(0.24, 0.025, 6, 14).translate(0.8, 3.3, L / 2 + 0.16), STOCK_DARK]);
  P.push([box(0.5, 0.36, L + 0.5, 0, 0.84, 0), STOCK_DARK]);
  bogie(P, -4.2); bogie(P, 4.2);
  return assemble(P);
}

function tankGeometry() {
  const P: Part[] = [], R = 1.42, half = 5.1, cy = 1.3 + R;
  const profile = [[0, -half - 0.44], [0.7, -half - 0.37], [1.15, -half - 0.18], [R, -half + 0.12], [R, half - 0.12], [1.15, half + 0.18], [0.7, half + 0.37], [0, half + 0.44]].map(([x, y]) => new THREE.Vector2(x, y));
  P.push([new THREE.LatheGeometry(profile, 24).rotateX(PI / 2).translate(0, cy, 0), 0xffffff]);
  for (const z of [-3.9, -1.3, 1.3, 3.9]) P.push([new THREE.CylinderGeometry(R + 0.025, R + 0.025, 0.1, 24, 1, true).rotateX(PI / 2).translate(0, cy, z), STOCK_DARK]);
  // Manway, its platform and rails, a ladder up each side.
  P.push([cyl(0.5, 0.5, 0, cy + R + 0.2, 0, "y", 14), 0xffffff]);
  P.push([cyl(0.55, 0.07, 0, cy + R + 0.47, 0, "y", 14), STOCK_DARK]);
  P.push([box(2.0, 0.05, 1.8, 0, cy + R + 0.06, 0), STOCK_DARK]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.push([box(0.04, 0.95, 0.04, sx * 0.97, cy + R + 0.55, sz * 0.87), STOCK_DARK]);
  for (const sz of [-1, 1]) P.push([box(1.98, 0.04, 0.04, 0, cy + R + 1.02, sz * 0.87), STOCK_DARK]);
  for (const side of [-1, 1]) {
    ladder(P, side * (R + 0.07), 0, 1.0, cy + R + 0.1, "z");
    P.push([rod([side * (R + 0.14), cy - 0.25, -half], [side * (R + 0.14), cy - 0.25, half], 0.022, 5), STOCK_DARK]);
    P.push([box(0.12, 0.24, half * 2 + 1.7, side * 1.2, 1.0, 0), STOCK_DARK]);
  }
  P.push([box(0.55, 0.4, half * 2 + 1.9, 0, 0.9, 0), STOCK_DARK]);
  for (const end of [-1, 1]) {
    P.push([box(2.5, 0.55, 0.5, 0, 1.35, end * (half - 1.0)), STOCK_DARK]);
    P.push([box(2.7, 0.1, 0.9, 0, 1.15, end * (half + 0.5)), STOCK_DARK]);
    P.push([box(0.3, 0.3, 0.7, 0, 0.88, end * (half + 1.2)), STOCK_DARK]);
    P.push([box(2.6, 0.04, 0.04, 0, 2.1, end * (half + 0.9)), STOCK_DARK]);
    for (const side of [-1, 1]) P.push([box(0.04, 1.0, 0.04, side * 1.28, 1.6, end * (half + 0.9)), STOCK_DARK]);
  }
  bogie(P, -(half - 1.0)); bogie(P, half - 1.0);
  return assemble(P);
}

function hopperGeometry() {
  const P: Part[] = [], L = 12.4, W = 3.0, top = 4.3, sill = 1.15, knee = 3.0;
  const side = new THREE.Shape();
  side.moveTo(-L / 2, top); side.lineTo(-L / 2, knee); side.lineTo(-L / 2 + 1.9, sill); side.lineTo(L / 2 - 1.9, sill); side.lineTo(L / 2, knee); side.lineTo(L / 2, top);
  side.closePath();
  P.push([new THREE.ExtrudeGeometry(side, { depth: W, bevelEnabled: false }).translate(0, 0, -W / 2).rotateY(-PI / 2), 0xffffff]);
  for (const s of [-1, 1]) for (let i = 0; i < 11; i += 1) {
    const z = -L / 2 + 0.3 + i * (L - 0.6) / 10, low = sill + (knee - sill) * (1 - Math.min(1, (L / 2 - Math.abs(z)) / 1.9));
    P.push([box(0.07, top - low - 0.04, 0.09, s * (W / 2 + 0.035), (top + low) / 2, z), 0xffffff]);
  }
  P.push([box(W + 0.12, 0.14, L + 0.08, 0, top - 0.02, 0), 0xffffff]);
  P.push([box(W - 0.5, 0.16, L - 0.3, 0, top + 0.12, 0), STOCK_ROOF]);
  P.push([box(0.5, 0.04, L - 0.4, 0.95, top + 0.24, 0), STOCK_DARK]);
  for (const z of [-4.2, -1.4, 1.4, 4.2]) P.push([cyl(0.4, 0.1, -0.3, top + 0.24, z, "y", 12), STOCK_ROOF]);
  for (const z of [-3.0, 0, 3.0]) P.push([new THREE.CylinderGeometry(1.2, 0.34, 0.72, 4, 1).rotateY(PI / 4).translate(0, sill - 0.36, z), 0xffffff]);
  for (const end of [-1, 1]) {
    const z = end * (L / 2 + 0.5);
    P.push([box(W, 0.07, 0.75, 0, 1.08, end * (L / 2 + 0.2)), STOCK_DARK]);
    for (const s of [-1, 1]) P.push([box(0.08, top - 1.1, 0.08, s * 1.42, (top + 1.1) / 2, z), 0xffffff]);
    P.push([box(W - 0.1, 0.08, 0.08, 0, top - 0.3, z), 0xffffff]);
    P.push([beam([-1.4, 1.15, z], [1.4, top - 0.4, z], 0.06), 0xffffff]);
    ladder(P, end * 1.05, z + end * 0.06, 1.1, top + 0.1, "x");
    P.push([box(0.3, 0.3, 0.7, 0, 0.88, end * (L / 2 + 0.75)), STOCK_DARK]);
  }
  P.push([box(0.5, 0.34, L + 1.2, 0, 0.88, 0), STOCK_DARK]);
  bogie(P, -4.7); bogie(P, 4.7);
  return assemble(P);
}

/** The diesel: a hood unit, its short nose and cab toward +z. Windows, lamps and number boards are added where it stands. */
function locoGeometry() {
  const P: Part[] = [], BLUE = 0x2b6a94, YELLOW = 0xe2ad22, GREY = 0xb9bdc0, deck = 1.62;
  P.push([box(2.95, 0.34, 17, 0, deck - 0.17, 0), STOCK_DARK]);
  P.push([box(2.0, 2.4, 11.4, 0, deck + 1.2, -2.5), BLUE]);
  P.push([box(1.6, 0.14, 11.2, 0, deck + 2.45, -2.5), BLUE]);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i += 1) P.push([box(0.03, 1.75, 1.05, side * 1.01, deck + 1.0, -5.0 + i * 1.3), BLUE]);
    P.push([box(0.04, 1.3, 2.4, side * 1.02, deck + 1.55, -6.9), STOCK_DARK]);
    P.push([box(0.04, 0.42, 9.0, side * 1.015, deck + 2.12, -1.4), YELLOW]);
    P.push([rod([side * 1.42, deck + 1.05, -8.3], [side * 1.42, deck + 1.05, 3.2], 0.022, 5), GREY]);
    for (let i = 0; i <= 8; i += 1) P.push([rod([side * 1.42, deck, -8.3 + i * 1.4375], [side * 1.42, deck + 1.05, -8.3 + i * 1.4375], 0.02, 5), GREY]);
    P.push([cyl(0.2, 3.2, side * 1.15, 1.08, 0, "z", 8), STOCK_DARK]);
    for (const end of [-1, 1]) P.push([box(0.5, 0.05, 0.32, side * 1.2, 0.55, end * 8.25), STOCK_DARK], [box(0.5, 0.05, 0.32, side * 1.2, 1.0, end * 8.3), STOCK_DARK]);
  }
  P.push([box(3.0, 2.7, 2.5, 0, deck + 1.35, 4.5), YELLOW]);
  P.push([box(3.12, 0.12, 2.8, 0, deck + 2.76, 4.5), GREY], [box(2.5, 0.1, 2.5, 0, deck + 2.86, 4.5), GREY]);
  P.push([box(2.0, 1.55, 2.3, 0, deck + 0.775, 6.9), YELLOW]);
  P.push([box(0.66, 0.36, 0.22, 0, deck + 2.5, 5.84), STOCK_DARK]);
  for (const end of [-1, 1]) {
    P.push([box(2.95, 0.95, 0.16, 0, 0.92, end * 8.5), end > 0 ? YELLOW : STOCK_DARK]);
    P.push([box(0.3, 0.3, 0.7, 0, 0.88, end * 8.8), STOCK_DARK]);
    P.push([rod([-1.42, deck + 1.05, end * 8.42], [1.42, deck + 1.05, end * 8.42], 0.022, 5), GREY]);
    for (const x of [-1.42, -0.5, 0.5, 1.42]) P.push([rod([x, deck, end * 8.42], [x, deck + 1.05, end * 8.42], 0.02, 5), GREY]);
  }
  for (const z of [-1.2, 0.3]) P.push([cyl(0.17, 0.5, 0, deck + 2.7, z, "y", 10), STOCK_DARK]);
  for (const z of [-7.4, -6.1, -4.8]) P.push([cyl(0.55, 0.1, 0, deck + 2.57, z, "y", 14), STOCK_DARK]);
  P.push([box(0.5, 0.12, 0.16, 0.7, deck + 3.0, 4.0), STOCK_DARK], [cyl(0.1, 0.16, -0.95, deck + 2.99, 5.1, "y", 8), STOCK_DARK]);
  P.push([cyl(0.72, 4.4, 0, 0.84, 0, "z", 14), STOCK_DARK]);
  bogie(P, -5.6, [-1.5, 0, 1.5], 4.2); bogie(P, 5.6, [-1.5, 0, 1.5], 4.2);
  return assemble(P);
}

// ---- Words -------------------------------------------------------------------------------------------
// One sheet for every plate, stencil and lit pane in the yard. Plates are opaque; stencils are white on
// nothing and take their ink from the vertex colour; lit panes are drawn by an unlit material.

type Spec = { name: string; w: number; h: number; draw: (context: CanvasRenderingContext2D, w: number, h: number) => void };
const NOTICE = "\"Arial Narrow\", \"Helvetica Neue\", Arial, sans-serif", STENCIL = "Impact, \"Arial Black\", \"Arial Narrow\", sans-serif";

function setLines(context: CanvasRenderingContext2D, w: number, h: number, lines: Array<[string, number]>, font: string, colours: string[]) {
  const total = lines.reduce((sum, [, size]) => sum + size, 0), unit = h * 0.84 / total;
  let y = h * 0.08;
  context.textAlign = "center"; context.textBaseline = "middle";
  lines.forEach(([text, size], index) => {
    let px = unit * size * 0.8;
    context.font = `700 ${px}px ${font}`;
    const wide = context.measureText(text).width;
    if (wide > w * 0.9) { px *= w * 0.9 / wide; context.font = `700 ${px}px ${font}`; }
    context.fillStyle = colours[Math.min(index, colours.length - 1)];
    context.fillText(text, w / 2, y + unit * size / 2);
    y += unit * size;
  });
}

/** An enamel or painted plate: ground, border, lines of text, and what the weather has done to it. */
function plate(name: string, w: number, h: number, ground: string, ink: string | string[], lines: Array<[string, number]>, seed = 1, band?: string): Spec {
  return { name, w, h, draw: (context) => {
    const next = rng(seed * 977 + name.length * 31);
    context.fillStyle = ground; context.fillRect(0, 0, w, h);
    if (band) { context.fillStyle = band; context.fillRect(0, 0, w, h * 0.3); }
    const inks = Array.isArray(ink) ? ink : [ink];
    context.strokeStyle = inks[inks.length - 1]; context.lineWidth = Math.max(2, h * 0.025);
    context.strokeRect(h * 0.05, h * 0.05, w - h * 0.1, h - h * 0.1);
    setLines(context, w, h, lines, NOTICE, inks);
    // Chips at the fixing holes, rust weeping from them, a film of grime toward the foot.
    for (const [x, y] of [[0.06, 0.12], [0.94, 0.12], [0.06, 0.88], [0.94, 0.88]]) {
      context.fillStyle = "#2a1c12"; context.beginPath(); context.arc(x * w, y * h, h * 0.03, 0, PI * 2); context.fill();
      const run = context.createLinearGradient(0, y * h, 0, y * h + h * (0.2 + next() * 0.4));
      run.addColorStop(0, "rgba(96,52,22,.6)"); run.addColorStop(1, "rgba(96,52,22,0)");
      context.fillStyle = run; context.fillRect(x * w - h * 0.02, y * h, h * 0.04, h * 0.6);
    }
    for (let i = 0; i < 26; i += 1) {
      const r = h * (0.01 + next() * 0.03);
      context.fillStyle = `rgba(${40 + next() * 40},${26 + next() * 20},16,${0.25 + next() * 0.4})`;
      context.beginPath(); context.arc(next() * w, next() * h, r, 0, PI * 2); context.fill();
    }
    const grime = context.createLinearGradient(0, 0, 0, h);
    grime.addColorStop(0, "rgba(20,16,12,.05)"); grime.addColorStop(1, "rgba(20,16,12,.3)");
    context.fillStyle = grime; context.fillRect(0, 0, w, h);
  } };
}

/** Stencilled lettering on nothing: the bridges of the stencil are cut back out of the letters. */
function stencil(name: string, w: number, h: number, lines: Array<[string, number]>, bridges = true): Spec {
  return { name, w, h, draw: (context) => {
    setLines(context, w, h, lines, STENCIL, ["#ffffff"]);
    if (bridges) {
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = "#000";
      for (let x = h * 0.21; x < w; x += h * 0.37) context.fillRect(x, 0, Math.max(1.5, h * 0.016), h);
      const next = rng(w + h);
      for (let i = 0; i < 90; i += 1) { context.globalAlpha = 0.5; context.fillRect(next() * w, next() * h, 2 + next() * 9, 1 + next() * 3); }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    }
  } };
}

/** A lit window: the lamp inside, whatever stands against it, glazing bars. */
function pane(name: string, w: number, h: number, bays: number, inside: (context: CanvasRenderingContext2D, w: number, h: number) => void, warm = "#ffb45e"): Spec {
  return { name, w, h, draw: (context) => {
    const glow = context.createRadialGradient(w * 0.5, h * 0.2, 0, w * 0.5, h * 0.3, w * 0.7);
    glow.addColorStop(0, "#fff0c8"); glow.addColorStop(0.25, warm); glow.addColorStop(1, "#5c3312");
    context.fillStyle = glow; context.fillRect(0, 0, w, h);
    inside(context, w, h);
    context.fillStyle = "#17120e";
    for (let i = 0; i <= bays; i += 1) context.fillRect(i * (w - 8) / bays, 0, 8, h);
    context.fillRect(0, 0, w, 6); context.fillRect(0, h - 6, w, 6); context.fillRect(0, h * 0.36, w, 5);
    // Rain on the glass.
    const next = rng(w * 3 + h);
    context.strokeStyle = "rgba(20,14,8,.35)"; context.lineWidth = 1.5;
    for (let i = 0; i < 70; i += 1) { const x = next() * w, y = next() * h; context.beginPath(); context.moveTo(x, y); context.lineTo(x + 2, y + 6 + next() * 22); context.stroke(); }
  } };
}

function atlasSpecs(): Spec[] {
  const WHITE = "#e9e6da", RED = "#a3241b", BLUE = "#17304a", YELLOW = "#d9a520", BLACK = "#16130f", GREEN = "#1f4a34";
  return [
    plate("depot", 1800, 200, "#1b2630", ["#e8e2cf"], [["CACHE & CARRY  ·  GOODS DEPOT  ·  SIDING 11", 1]], 3),
    plate("cabin", 1000, 132, BLUE, WHITE, [["SIDING B JCN", 1]], 5),
    plate("road", 620, 180, BLUE, WHITE, [["ROAD 11", 1.5], ["FIRING ROAD", 0.8]], 7),
    plate("beware", 512, 300, WHITE, [RED, BLACK, RED], [["BEWARE OF TRAINS", 1.3], ["AND OF FLANKERS", 0.8]], 11),
    plate("doorStuck", 512, 256, YELLOW, BLACK, [["DOOR STUCK", 1.5], ["USE OTHER DOOR", 0.8]], 13),
    plate("shunting", 512, 200, WHITE, BLACK, [["LOOSE SHUNTING", 1], ["PROHIBITED", 1]], 17),
    plate("private", 512, 300, RED, WHITE, [["PRIVATE SIDING", 1.2], ["TRESPASSERS WILL BE", 0.7], ["TRADED UP", 1.1]], 19),
    plate("eco", 440, 240, GREEN, WHITE, [["ECO ROUND", 1.3], ["LAMPS OUT AT 23:00", 0.7], ["SAVE THE OIL", 0.7]], 23),
    plate("corners", 512, 200, WHITE, [BLUE], [["CHECK CORNERS", 1], ["BEFORE SHUNTING", 1]], 29),
    plate("planting", 512, 200, YELLOW, BLACK, [["NO PLANTING ON", 1], ["THE RUNNING LINE", 1]], 31),
    plate("stop", 330, 420, RED, WHITE, [["STOP", 1.4], ["LOOK", 1.4], ["LISTEN", 1.4], ["FOR FOOTSTEPS", 0.6]], 37),
    plate("speed", 330, 420, WHITE, [BLACK, RED, BLACK], [["SPEED", 0.7], ["5", 2.2], ["NO RUSHING", 0.6], ["(EXCEPT B)", 0.5]], 41),
    plate("relay", 330, 200, YELLOW, BLACK, [["RELAY CABINET RC-11", 0.8], ["DANGER 650 V", 1.3], ["ISOLATE BEFORE DEFUSING", 0.6]], 43),
    plate("loss", 330, 420, "#d8d2be", [BLACK], [["LOSS BONUS", 1.1], ["PAID FRIDAYS", 0.8], ["1400 · 1900 · 2400", 0.7], ["2900 · 3400", 0.7], ["NO ADVANCES", 0.6]], 47),
    plate("cases", 400, 500, "#20303a", ["#e8c15a", WHITE], [["10 000", 1.6], ["CASES", 1.4], ["KEYS SOLD", 0.8], ["SEPARATELY", 0.8], ["ENQUIRE AT DEPOT", 0.5]], 53),
    plate("frame", 400, 150, BLACK, WHITE, [["FRAME B   1 SHORT · 2 LONG · 3 MID", 1]], 59),
    plate("endOfLine", 400, 180, WHITE, [RED, BLACK], [["END OF LINE", 1.3], ["GG", 0.9]], 61),
    plate("furnace", 512, 200, BLACK, [YELLOW], [["FURNACE ROAD", 1.1], ["STAND CLEAR OF THE DOOR", 0.7]], 67),
    plate("fire", 300, 300, RED, WHITE, [["FIRE", 1.5], ["BUCKETS", 0.9], ["NOT FOR TEA", 0.5]], 71),
    plate("forceBuy", 620, 220, "#3a2a1c", ["#e3c787", WHITE], [["FORCE BUY WAREHOUSE", 1.1], ["TRADE COUNTER · NO REFUNDS", 0.7]], 73),
    stencil("rush", 1200, 300, [["RUSH B RAILWAY", 1.6], ["DON'T STOP", 0.8]]),
    stencil("rushNo", 520, 200, [["RBRX 322", 1.3], ["CAPY 16000  LD LMT 4750", 0.6]]),
    stencil("eco2", 1200, 300, [["ECO ROUND FREIGHT", 1.5], ["WE SAVE · YOU SAVE", 0.8]]),
    stencil("eco2No", 520, 200, [["ECRX 0800", 1.3], ["LT WT 0.07 FLOAT  FN", 0.6]]),
    stencil("cache", 1200, 300, [["CACHE & CARRY", 1.6], ["KEYS SOLD SEPARATELY", 0.8]]),
    stencil("cacheNo", 520, 200, [["CCLX 10000", 1.3], ["PATTERN 661  BLT 11-26", 0.6]]),
    stencil("loss2", 1200, 300, [["LOSS BONUS LINE", 1.6], ["IT ADDS UP", 0.8]]),
    stencil("loss2No", 520, 200, [["LBLX 3400", 1.3], ["CAPY 1400  LD LMT 3400", 0.6]]),
    stencil("fuel", 1200, 260, [["FORCE BUY FUELS", 1.5], ["FLOAT 0.0700 · FACTORY NEW", 0.7]]),
    stencil("fuelNo", 520, 200, [["FBFX 4750", 1.3], ["DO NOT HUMP", 0.7]]),
    stencil("trade", 1200, 300, [["TRADE UP GRAIN Co.", 1.5], ["10 IN · 1 OUT", 0.8]]),
    stencil("tradeNo", 520, 200, [["TUGX 1001", 1.3], ["WELL WORN  CU FT 4750", 0.6]]),
    stencil("hsx", 620, 200, [["HSX 1337", 1]]),
    stencil("tower", 900, 240, [["SIDING", 1]], false),
    { name: "chalk", w: 520, h: 200, draw: (context, w, h) => {
      context.fillStyle = "#ffffff"; context.textAlign = "center"; context.textBaseline = "middle";
      context.font = `400 ${h * 0.4}px "Bradley Hand", "Marker Felt", "Segoe Print", "Comic Sans MS", cursive`;
      context.fillText("GG WP · EZ", w / 2, h * 0.3);
      context.fillText("B  → →", w / 2, h * 0.74);
    } },
    { name: "dark", w: 24, h: 24, draw: (context, w, h) => { context.fillStyle = "#1b1c1d"; context.fillRect(0, 0, w, h); } },
    { name: "numbers", w: 260, h: 110, draw: (context, w, h) => {
      context.fillStyle = "#0c0c0a"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#fff3cf"; context.font = `700 ${h * 0.72}px ${NOTICE}`; context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText("1337", w / 2, h * 0.54);
    } },
    pane("levers", 1000, 300, 8, (context, w, h) => {
      // The lever frame against the windows, the block shelf above it, a kettle on the stove.
      context.fillStyle = "#1c130b"; context.fillRect(0, h * 0.86, w, h * 0.14);
      const next = rng(88);
      for (let i = 0; i < 22; i += 1) {
        const x = w * 0.08 + i * w * 0.036, lean = next() < 0.3 ? 14 : -5, colour = ["#6d1410", "#15365c", "#0f0d0b", "#8a6a12"][Math.floor(next() * 4)];
        context.strokeStyle = colour; context.lineWidth = 7; context.beginPath(); context.moveTo(x, h * 0.9); context.lineTo(x + lean, h * 0.52); context.stroke();
        context.strokeStyle = "#b9b4a8"; context.lineWidth = 5; context.beginPath(); context.moveTo(x + lean, h * 0.56); context.lineTo(x + lean, h * 0.5); context.stroke();
      }
      context.fillStyle = "#2a1c10"; context.fillRect(w * 0.06, h * 0.08, w * 0.82, h * 0.1);
      for (let i = 0; i < 9; i += 1) { context.fillStyle = "#3d2a17"; context.fillRect(w * (0.09 + i * 0.09), h * 0.1, w * 0.05, h * 0.2); context.fillStyle = i % 3 ? "#b9342a" : "#3f9d58"; context.beginPath(); context.arc(w * (0.115 + i * 0.09), h * 0.2, 7, 0, PI * 2); context.fill(); }
      context.fillStyle = "#17100a"; context.fillRect(w * 0.9, h * 0.42, w * 0.07, h * 0.5); context.fillRect(w * 0.925, 0, w * 0.02, h * 0.45);
    }),
    pane("office", 300, 420, 2, (context, w, h) => {
      context.fillStyle = "rgba(60,36,14,.75)"; context.fillRect(0, 0, w, h * 0.42);
      context.fillStyle = "#24170c"; context.fillRect(w * 0.12, h * 0.66, w * 0.5, h * 0.34); context.fillRect(w * 0.7, h * 0.5, w * 0.16, h * 0.5);
    }, "#f2b765"),
    pane("officeDim", 300, 420, 2, (context, w, h) => {
      context.fillStyle = "rgba(12,14,20,.86)"; context.fillRect(0, 0, w, h);
      context.fillStyle = "rgba(90,110,140,.25)"; context.fillRect(w * 0.1, h * 0.5, w * 0.3, h * 0.2);
    }, "#52657a"),
  ];
}

function buildAtlas() {
  const specs = atlasSpecs(), cells = new Map<string, Cell>();
  let x = 0, y = 0, row = 0;
  for (const spec of specs) {
    if (x + spec.w + 8 > ATLAS) { x = 0; y += row; row = 0; }
    cells.set(spec.name, [x + 4, y + 4, spec.w, spec.h]);
    x += spec.w + 8; row = Math.max(row, spec.h + 8);
  }
  const texture = canvasTexture(ATLAS, ATLAS, (context) => {
    for (const spec of specs) {
      const [cx, cy] = cells.get(spec.name)!;
      context.save();
      context.translate(cx, cy);
      context.beginPath(); context.rect(0, 0, spec.w, spec.h); context.clip();
      spec.draw(context, spec.w, spec.h);
      context.restore();
    }
  });
  return { texture, cells };
}

// ---- Weather and light, drawn ------------------------------------------------------------------------

const glsl = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** Light of the practicals at a point: shaded fittings throw downward only; a negative reach marks a bare lamp. */
const lampGlsl = (count: number) => /* glsl */`
  uniform vec4 yardLampAt[${count}];
  uniform vec3 yardLampTint[${count}];
  vec3 yardLamps(vec3 p, vec3 n) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${count}; i++) {
      vec3 d = yardLampAt[i].xyz - p;
      float reach = abs(yardLampAt[i].w), r2 = dot(d, d);
      if (r2 < reach * reach) {
        float r = sqrt(r2) + 0.0001, edge = 1.0 - r2 / (reach * reach);
        float facing = max(dot(n, d) / r * 0.8 + 0.2, 0.0);
        float shade = yardLampAt[i].w < 0.0 ? 1.0 : 0.08 + 0.92 * smoothstep(-0.12, 0.3, d.y / r);
        sum += yardLampTint[i] * (facing * shade * edge * edge / (r2 + 2.5));
      }
    }
    return sum;
  }`;

/** Rings opened by the rain on standing water, as a slope to add to the surface normal (needs `floorHash`). */
const RING_GLSL = /* glsl */`
  vec2 yardRings(vec2 p, float time) {
    vec2 sum = vec2(0.0);
    for (int layer = 0; layer < 2; layer++) {
      float k = float(layer);
      vec2 q = p * (2.1 + k * 1.3) + k * 7.31;
      vec2 cell = floor(q), f = fract(q);
      float h = floorHash(cell + k * 31.7);
      float beat = time * (1.1 + h * 0.9) + h * 23.0;
      float t = fract(beat), n = floor(beat);
      vec2 centre = 0.3 + 0.4 * vec2(floorHash(cell + n * 0.37 + 3.1), floorHash(cell - n * 0.53 + 9.7));
      vec2 d = f - centre;
      float r = length(d), front = t * 0.3;
      float ring = sin((r - front) * 70.0) * smoothstep(0.045, 0.0, abs(r - front)) * (1.0 - t) * (1.0 - t);
      sum += d / max(r, 0.001) * ring;
    }
    return sum;
  }`;

/** True (1.0) where the rain cannot reach a point: under the tin roof of the firing line or the shed canopy. */
const SHELTER_GLSL = /* glsl */`
  float yardShelter(vec3 p) {
    float underTin = step(${glsl(TIN.front - 0.3)}, p.z - (${glsl(SLANT[1])}) * max(${glsl(TIN.low)} - p.y, 0.0)) * step(abs(p.x), 9.9) * step(p.y, ${glsl(TIN.low)} + ${glsl(TIN.pitch)} * max(p.z - ${glsl(TIN.front)}, 0.0));
    float underShed = step(p.x - ${glsl(SLANT[0])} * max(${glsl(SHED.edgeY)} - p.y, 0.0), ${glsl(SHED.edge)}) * step(${glsl(SHED.x0)}, p.x) * step(p.z, ${glsl(SHED.z1)}) * step(${glsl(SHED.z0)}, p.z) * step(p.y, ${glsl(SHED.edgeY)});
    return max(underTin, underShed);
  }`;

const streakFragment = /* glsl */`
  varying vec3 vTint;
  varying vec2 vAt;
  void main() {
    float across = 1.0 - abs(vAt.x) * 2.0;
    gl_FragColor = vec4(vTint * across * (0.3 + 0.7 * vAt.y) * smoothstep(0.0, 0.12, vAt.y), 1.0);
    #include <colorspace_fragment>
  }`;

/** A streak quad: x across (-0.5..0.5), y from its tail (0) to its head (1). */
function streakGeometry(count: number) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
  return geometry;
}

export function buildYard(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const props = createProps(kit);
  const wind = createWind({ heading: WIND_HEADING, strength: 0.45, gustiness: 0.55 });
  const life = createLife(kit, options, { wind, seed: 11 });
  const { scene, high, anisotropy, keep, track, photoSet } = kit;
  const metals = kit.metals();
  const random = rng(1107);
  /** Rolls for what happens while the range runs; the build keeps its own stream so the yard is the same every time. */
  const chance = rng(4242);
  const cuePlaces = Array.from({ length: 8 }, () => new THREE.Vector3());
  let cuePlace = 0;
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => {
    options.cue?.(name, cuePlaces[cuePlace = (cuePlace + 1) % cuePlaces.length].set(x, y, z), { gain, pitch });
  };
  const clock = { value: 0 }, viewHeight = { value: 810 };

  // ---- Practicals ----------------------------------------------------------
  // Every lamp near the lane: where it hangs, what it burns, how hard and how far.
  type Lamp = { at: V3; colour: number; power: number; reach: number; bare?: boolean };
  const LAMPS: Lamp[] = [
    { at: [-9.0, 6.25, -24.2], colour: SODIUM, power: 46, reach: 14 },
    { at: [-9.0, 6.25, -14.05], colour: SODIUM, power: 46, reach: 14 },
    { at: [-9.0, 6.25, -4.8], colour: SODIUM, power: 46, reach: 14 },
    { at: [8.95, 5.55, -19.95], colour: COLD, power: 32, reach: 13 },
    { at: [8.95, 5.55, -3.2], colour: COLD, power: 32, reach: 13 },
    { at: [9.1, 6.3, -10.5], colour: WARM, power: 4, reach: 8, bare: true },
    { at: [-6.9, 4.28, 4.0], colour: WARM, power: 52, reach: 16 },
    { at: [-2.3, 4.28, 4.0], colour: WARM, power: 52, reach: 16 },
    { at: [2.3, 4.28, 4.0], colour: WARM, power: 52, reach: 16 },
    { at: [6.9, 4.28, 4.0], colour: WARM, power: 52, reach: 16 },
    { at: [-8.72, 1.4, -23.45], colour: 0xff2a14, power: 3, reach: 4.5, bare: true },
    { at: [-8.3, 3.3, 9.42], colour: WARM, power: 9, reach: 7, bare: true },
    { at: [-3.4, YARD + 8.36, -37.6], colour: SODIUM, power: 85, reach: 19 },
    { at: [15.75, YARD + 6.9, 1.8], colour: SODIUM, power: 80, reach: 16 },
  ];
  const lampAt = { value: LAMPS.map((lamp) => new THREE.Vector4(...lamp.at, lamp.bare ? -lamp.reach : lamp.reach)) };
  const lampTint = { value: LAMPS.map((lamp) => new THREE.Color(lamp.colour).multiplyScalar(lamp.power)) };
  const lampFull = lampTint.value.map((tint) => tint.clone());
  /** The fitting on the retaining wall that is on its way out. */
  const FAILING = 3;
  const LAMP_GLSL = lampGlsl(LAMPS.length);
  /** Lets a surface take the light of the practicals. */
  const lit = <T extends THREE.MeshStandardMaterial>(material: T, name: string): T => {
    const before = material.onBeforeCompile, key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before.call(material, shader, renderer);
      shader.uniforms.yardLampAt = lampAt;
      shader.uniforms.yardLampTint = lampTint;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vYardWorld;")
        .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
          vec4 yardPlaced = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            yardPlaced = instanceMatrix * yardPlaced;
          #endif
          vYardWorld = (modelMatrix * yardPlaced).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vYardWorld;\n${LAMP_GLSL}`)
        .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directDiffuse += yardLamps(vYardWorld, inverseTransformDirection(normal, viewMatrix)) * material.diffuseContribution;");
    };
    material.customProgramCacheKey = () => `${key}|yard-lit-${name}`;
    return material;
  };
  (["structural", "darkMetal", "brushed", "machine", "crate"] as const).forEach((name) => lit(metals[name], name));

  // ---- Materials -----------------------------------------------------------
  const finish = (name: string, parameters: THREE.MeshStandardMaterialParameters) => lit(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.6, vertexColors: true, ...parameters }), name);
  const brick = finish("brick", { ...photoSet("/textures/brick_wall_001-2k", 1, 1, true), roughness: 0.92 });
  const concrete = finish("concrete", { ...photoSet("/textures/concrete_wall_007-2k", 1, 1, false), roughness: 0.94 });
  const tin = finish("tin", { ...photoSet("/textures/corrugated_iron_02-2k", 1, 1, false), metalness: 0.4, envMapIntensity: 0.8, side: THREE.DoubleSide });
  const rust = finish("rust", { ...photoSet("/textures/rusty_metal_02-2k", 1, 1, false), metalness: 0.25, roughness: 0.85 });
  const timber = finish("timber", { ...photoSet("/textures/weathered_brown_planks-2k", 1, 1, false), roughness: 0.9 });
  const paint = lit(pbrMaterial(keep(paintedSteel(anisotropy, [0.8, 0.8, 0.8], 1107, 0.42, 1024)), { vertexColors: true, envMapIntensity: 0.9 }), "paint");
  const iron = finish("iron", { roughness: 0.48, metalness: 0.65, envMapIntensity: 1 });
  const slate = finish("slate", { roughness: 0.42, metalness: 0.1, envMapIntensity: 0.9 });
  const glazing = new THREE.MeshStandardMaterial({ color: 0x0a1014, roughness: 0.06, metalness: 0.7, envMapIntensity: 1.5 });
  const glowAny = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const atlas = buildAtlas();
  track(atlas.texture);
  atlas.texture.anisotropy = anisotropy;
  const plates = lit(new THREE.MeshStandardMaterial({ map: atlas.texture, emissiveMap: atlas.texture, emissive: 0xffffff, emissiveIntensity: 0.07, vertexColors: true, roughness: 0.42, metalness: 0.1, envMapIntensity: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), "plates");
  const marks = lit(new THREE.MeshStandardMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.42, roughness: 0.7, metalness: 0, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), "marks");
  const panes = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, toneMapped: false });
  /** Metres one tile of a photographed finish spans, for the finishes that are projected. */
  const tileOf = new Map<THREE.Material, number>([[brick, 1.6], [concrete, 3.2], [tin, 2], [rust, 1.8], [timber, 1.7], [paint, 2.2], [slate, 2]]);

  // ---- Batches -------------------------------------------------------------
  // Everything static is merged into one mesh per finish (and per shadow / hit / mirror class), so the detail
  // costs triangles, not draw calls. "fine" parts are left out on PERFORMANCE and out of the floor mirror.
  type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean; mirror?: boolean; uv?: number };
  type Batch = { material: THREE.Material; shadow: boolean; hit: boolean; mirror: boolean; parts: THREE.BufferGeometry[] };
  const batches = new Map<string, Batch>();
  const tone = new THREE.Color(), tone2 = new THREE.Color();
  const put = <T extends THREE.BufferGeometry>(material: THREE.Material, geometry: T, colour: number | null = 0xffffff, opt: Opt = {}): T => {
    if (opt.fine && !high) return geometry;
    const shadow = opt.shadow ?? true, hit = opt.hit ?? false, mirror = !opt.fine && (opt.mirror ?? true);
    const key = `${material.uuid}|${+shadow}${+hit}${+mirror}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { material, shadow, hit, mirror, parts: [] });
    const metres = opt.uv ?? tileOf.get(material) ?? 0;
    if (metres > 0) projectUv(geometry, metres);
    batch.parts.push(ready(geometry, colour === null ? null : tone.set(colour)));
    return geometry;
  };
  const flush = () => {
    for (const batch of batches.values()) {
      const merged = mergeGeometries(batch.parts);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.castShadow = batch.shadow && !(batch.material instanceof THREE.MeshBasicMaterial);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      scene.add(mesh);
      if (batch.hit) kit.shootable.push(mesh);
      if (!batch.mirror) kit.mirrorHidden.push(mesh);
    }
    batches.clear();
  };
  /** What stands in or over the lane: casts and stops bullets. What stands back from it: casts. The rest is scenery. */
  const SOLID: Opt = { shadow: true, hit: true }, CAST: Opt = { shadow: true }, FINE: Opt = { fine: true }, FLAT: Opt = { mirror: false };
  const sign = (name: string, w: number, h: number, x: number, y: number, z: number, facing: Facing, kind: "plate" | "mark" | "pane" = "plate", colour = 0xffffff, opt: Opt = FLAT) =>
    put(kind === "plate" ? plates : kind === "mark" ? marks : panes, cellUv(quad(w, h, x, y, z, facing), atlas.cells.get(name)!), colour, { ...opt, uv: 0 });

  // Lamps seen: a hot lens, and the wet air lit up round it.
  type Halo = { at: V3; size: number; colour: number; gain: number; blink?: number };
  const halos: Halo[] = [];
  const halo = (at: V3, size: number, colour: number, gain = 1, blink = 0) => halos.push({ at, size, colour, gain, blink }) - 1;
  /** Cones of lit rain under the big lamps: apex, drop, radius at the foot. */
  const cones: THREE.BufferGeometry[] = [];
  const shaft = (from: V3, to: V3, radius: number, colour: number, gain: number) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), length = a.distanceTo(b);
    const geometry = new THREE.CylinderGeometry(0.16, radius, length, 24, 1, true).translate(0, -length / 2, 0);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), b.sub(a).normalize())).translate(...from);
    cones.push(ready(geometry, tone.set(colour).multiplyScalar(gain)));
  };
  const cone = (at: V3, drop: number, radius: number, colour: number, gain: number) => shaft(at, [at[0], at[1] - drop, at[2]], radius, colour, gain);
  const lens = (geometry: THREE.BufferGeometry, colour: number, gain: number, opt: Opt = {}) => {
    tone.set(colour).multiplyScalar(gain);
    const count = geometry.attributes.position.count, colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) { colours[i * 3] = tone.r; colours[i * 3 + 1] = tone.g; colours[i * 3 + 2] = tone.b; }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    return put(glowAny, geometry, null, opt);
  };

  // ---- Ground --------------------------------------------------------------
  const asphalt = photoSet("/textures/asphalt_02-2k", 21 / 3.2, 40 / 3.2, false);
  const ground = new THREE.MeshStandardMaterial({ ...asphalt, color: 0xd4d6da, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.95, metalness: 0, envMapIntensity: 0.6 });
  const reflection = kit.floor(ground, { width: 21, depth: 40, z: -9.5 }, {
    lane: new THREE.Color(0.5, 0.49, 0.44),
    edge: new THREE.Color(0.56, 0.39, 0.09),
    markings: 0.8,
    wet: 0.2,
  });
  {
    // The floor's own shader, taught three things: the ground is dry under the tin roof, rain opens rings on the
    // standing water outside it, and the practicals light it.
    const inner = ground.onBeforeCompile;
    ground.onBeforeCompile = (shader, renderer) => {
      inner.call(ground, shader, renderer);
      shader.uniforms.yardTime = clock;
      shader.uniforms.yardLampAt = lampAt;
      shader.uniforms.yardLampTint = lampTint;
      shader.fragmentShader = shader.fragmentShader
        .replace("float floorWet = 0.0;", `float floorWet = 0.0;\nuniform float yardTime;\n${LAMP_GLSL}\n${RING_GLSL}\nvec2 yardRing = vec2(0.0);\nfloat yardOpen = 1.0;`)
        .replace("+ floorWetBias;", `+ floorWetBias - 0.7 * smoothstep(${glsl(TIN.front - 1.3)}, ${glsl(TIN.front + 1.2)}, slab.y);\nyardOpen = 1.0 - smoothstep(${glsl(TIN.front - 1.6)}, ${glsl(TIN.front + 0.2)}, slab.y);`)
        .replace("float damp = smoothstep(0.5, 0.63, basin);", "float damp = max(smoothstep(0.5, 0.63, basin), 0.72 * yardOpen);")
        .replace("normal = normalize(mix(normal, nonPerturbedNormal, max(floorWet * 0.985, damp * 0.35)));", /* glsl */`normal = normalize(mix(normal, nonPerturbedNormal, max(floorWet * 0.985, damp * 0.35)));
          yardRing = yardRings(slab, yardTime) * yardOpen;
          normal = normalize(normal + (viewMatrix * vec4(yardRing.x, 0.0, yardRing.y, 0.0)).xyz * (0.08 + 0.4 * floorWet));`)
        .replace("vec2 ripple = (normal.xy - nonPerturbedNormal.xy) * mix(0.09, 0.004, floorWet);", "vec2 ripple = (normal.xy - nonPerturbedNormal.xy) * mix(0.09, 0.004, floorWet) + yardRing * 0.012 * floorWet;")
        .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directDiffuse += yardLamps(vFloorWorld, vec3(0.0, 1.0, 0.0)) * material.diffuseContribution;");
    };
    ground.customProgramCacheKey = () => "hyperstrike-floor-v1|yard";
  }
  // The yard itself, at the upper level on every side of the lane.
  const yardGround = finish("yard", { map: track(asphalt.map.clone()), normalMap: track(asphalt.normalMap.clone()), roughnessMap: track(asphalt.roughnessMap.clone()), normalScale: new THREE.Vector2(1.4, 1.4), roughness: 0.78, envMapIntensity: 0.9 });
  for (const texture of [yardGround.map!, yardGround.normalMap!, yardGround.roughnessMap!]) { texture.repeat.set(1, 1); texture.needsUpdate = true; }
  tileOf.set(yardGround, 3.2);
  const GROUND = 0xa9acb2, BALLAST = 0xb5a590;
  // Laid in a grid so that the wear can vary across it: oil and cinders where engines stand, paler where water lies.
  for (const [x0, x1, z0, z1] of [[-340, -10.04, -340, 180], [10.04, 340, -340, 180], [-10.04, 10.04, -340, FAR_Z - 0.6], [-10.04, 10.04, DEPOT.z1, 180]]) {
    const w = x1 - x0, d = z1 - z0, plane = new THREE.PlaneGeometry(w, d, Math.ceil(w / 7), Math.ceil(d / 7)).rotateX(-PI / 2).translate((x0 + x1) / 2, YARD, (z0 + z1) / 2);
    const at = plane.attributes.position, colours = new Float32Array(at.count * 3);
    for (let i = 0; i < at.count; i += 1) {
      const x = at.getX(i), z = at.getZ(i);
      const broad = 0.5 + 0.27 * Math.sin(x * 0.083 + Math.sin(z * 0.047) * 2.1) + 0.23 * Math.sin(z * 0.071 + Math.sin(x * 0.039) * 2.7 + 1.3);
      const fine = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453, grain = fine - Math.floor(fine);
      tone.set(GROUND).lerp(tone2.set(broad > 0.5 ? 0xc7b9a2 : 0x55585e), Math.abs(broad - 0.5) * 1.1).multiplyScalar(0.82 + grain * 0.3);
      colours[i * 3] = tone.r; colours[i * 3 + 1] = tone.g; colours[i * 3 + 2] = tone.b;
    }
    plane.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    put(yardGround, plane, null);
  }

  // ---- The walls of the lane -----------------------------------------------
  const BRICK = 0xcdbbab, BLUE_BRICK = 0x6f7480, STONE = 0xb4b0a6, POURED = 0xa7a6a0;
  const laneLength = BACK_Z - FAR_Z, laneMid = (BACK_Z + FAR_Z) / 2;
  // West: the brick retaining wall of the goods shed's dock road.
  put(brick, box(0.5, WALL_TOP, laneLength, -WALL_X - 0.25, WALL_TOP / 2, laneMid), BRICK, SOLID);
  put(brick, box(0.05, 0.6, laneLength, -WALL_X + 0.025, 0.3, laneMid), BLUE_BRICK, SOLID);
  put(concrete, box(0.68, 0.2, laneLength, -WALL_X - 0.25, WALL_TOP - 0.1, laneMid), STONE, SOLID);
  for (const z of W_PIERS) {
    put(brick, box(0.26, WALL_TOP - 0.2, 0.56, -WALL_X + 0.13, (WALL_TOP - 0.2) / 2, z), BRICK, SOLID);
    put(brick, box(0.3, 0.6, 0.62, -WALL_X + 0.15, 0.3, z), BLUE_BRICK, SOLID);
    put(concrete, box(0.34, 0.14, 0.66, -WALL_X + 0.15, WALL_TOP - 0.27, z), STONE, SOLID);
  }
  // East: board-marked concrete either side of the cabin's brick base.
  for (const [z0, z1] of [[FAR_Z, CABIN.z0], [CABIN.z1, BACK_Z]]) {
    put(concrete, box(0.5, WALL_TOP, z1 - z0, WALL_X + 0.25, WALL_TOP / 2, (z0 + z1) / 2), POURED, SOLID);
    put(concrete, box(0.64, 0.16, z1 - z0, WALL_X + 0.25, WALL_TOP - 0.08, (z0 + z1) / 2), STONE, SOLID);
    put(concrete, box(0.06, 0.34, z1 - z0, WALL_X - 0.03, 0.17, (z0 + z1) / 2), 0x8f8e88, SOLID);
  }
  for (const z of E_PIERS) put(concrete, box(0.24, WALL_TOP - 0.16, 0.6, WALL_X - 0.12, (WALL_TOP - 0.16) / 2, z), 0xb0afa8, SOLID);
  put(brick, box(CABIN.x1 - WALL_X, CABIN.floor, CABIN.z1 - CABIN.z0, (CABIN.x1 + WALL_X) / 2, CABIN.floor / 2, (CABIN.z0 + CABIN.z1) / 2), BRICK, SOLID);
  put(brick, box(0.05, 0.6, CABIN.z1 - CABIN.z0, WALL_X - 0.025, 0.3, (CABIN.z0 + CABIN.z1) / 2), BLUE_BRICK, SOLID);
  put(concrete, box(CABIN.x1 - WALL_X + 0.16, 0.2, CABIN.z1 - CABIN.z0 + 0.16, (CABIN.x1 + WALL_X) / 2, CABIN.floor - 0.1, (CABIN.z0 + CABIN.z1) / 2), STONE, SOLID);
  // Far end: the yard's own retaining wall, and the hoarding the end of the middle road is boarded off with.
  put(concrete, box(20.08, YARD, 0.6, 0, YARD / 2, FAR_Z - 0.3), POURED, SOLID);
  put(concrete, box(20.2, 0.16, 0.72, 0, YARD - 0.02, FAR_Z - 0.3), STONE);
  put(timber, box(4.6, 3.9, 0.08, 0, YARD + 1.95, FAR_Z + 0.02), 0x4a4640, { shadow: true });
  for (const x of [-2.2, 0, 2.2]) put(iron, box(0.12, 4.1, 0.12, x, YARD + 2.05, FAR_Z - 0.1), 0x2a2a2a);

  // ---- The depot behind the firing line ---------------------------------------
  // Its end wall is the back of the range. Above the tin roof: a painted name, windows, a hipped slate roof.
  {
    const w = DEPOT.x1 - DEPOT.x0, d = DEPOT.z1 - BACK_Z, cx = (DEPOT.x0 + DEPOT.x1) / 2, cz = (DEPOT.z1 + BACK_Z) / 2;
    put(brick, box(w, DEPOT.top, d, cx, DEPOT.top / 2, cz), BRICK, SOLID);
    put(concrete, box(w + 0.3, 0.3, d + 0.3, cx, DEPOT.top - 0.15, cz), STONE, CAST);
    put(slate, roof(d + 0.5, w + 0.5, 2.6, 3.4).rotateY(PI / 2).translate(cx, DEPOT.top, cz), 0x262b31, CAST);
    put(brick, box(16.54, 0.7, 0.06, 1.27, 0.35, BACK_Z - 0.03), BLUE_BRICK, SOLID);
    sign("depot", 12.6, 1.4, 0.6, 8.95, BACK_Z - 0.02, "z-", "plate", 0xffffff, {});
    for (const x of [-9.0, -7.3, 8.1, 9.7, 11.3]) {
      const dark = x === -7.3 || x === 11.3;
      sign(dark ? "officeDim" : "office", 1.05, 1.5, x, 8.85, BACK_Z - 0.02, "z-", "pane", dark ? 0x9aa6b8 : 0xffffff, {});
      put(concrete, box(1.3, 0.12, 0.16, x, 8.04, BACK_Z - 0.04), STONE);
      put(concrete, box(1.3, 0.16, 0.1, x, 9.68, BACK_Z - 0.03), STONE);
      if (!dark) halo([x, 8.85, BACK_Z - 0.3], 2.2, WARM, 0.35);
    }
    // Lamps on swan necks over the name.
    for (const x of [-4.2, 0.6, 5.4]) {
      put(iron, tube([[x, 10.0, BACK_Z], [x, 10.15, BACK_Z - 0.3], [x, 10.02, BACK_Z - 0.62]], 0.022, 8, 5), 0x2c2c2c, FINE);
      put(paint, new THREE.CylinderGeometry(0.05, 0.2, 0.14, 12).translate(x, 9.96, BACK_Z - 0.62), 0x2f4a3e);
      lens(new THREE.CircleGeometry(0.13, 12).rotateX(PI / 2).translate(x, 9.885, BACK_Z - 0.62), WARM, 3.2);
      halo([x, 9.86, BACK_Z - 0.62], 1.6, WARM, 0.7);
    }
  }

  // ---- The tin roof over the firing line --------------------------------------
  // A lean-to off the depot wall on steel rafters, a lattice girder across its low front edge so nothing stands
  // in the lane. Its gutter is full and running over; the downpipe at the west post empties across the ground.
  {
    const STEEL = 0x3f4a50, front = TIN.front, low = TIN.low;
    for (const side of [-1, 1]) {
      put(paint, iBeam(0.2, 0.2, low - 0.2, 0.02, 0.014).translate(side * 9.3, 0, front), STEEL, SOLID);
      put(concrete, box(0.44, 0.14, 0.44, side * 9.3, 0.07, front), POURED, SOLID);
      put(iron, box(0.3, 0.02, 0.3, side * 9.3, 0.15, front), 0x2a2a2a);
    }
    laced([-9.3, low - 0.14, front], [9.3, low - 0.14, front], [0.62, 0.3], 12, 0.09, 0.028).forEach((part) => put(paint, part, STEEL, CAST));
    const rafters = [-9.3, -5.58, -1.86, 1.86, 5.58, 9.3];
    for (const x of rafters) {
      put(paint, beam([x, low + 0.02, front], [x, tinY(BACK_Z) + 0.02, BACK_Z - 0.04], 0.2, 0.1), STEEL, CAST);
      put(iron, box(0.24, 0.3, 0.08, x, tinY(BACK_Z) - 0.05, BACK_Z - 0.04), 0x2c2c2c);
      put(paint, beam([x, low - 0.3, front + 0.1], [x, tinY(front + 1.4) - 0.08, front + 1.4], 0.06), STEEL);
    }
    for (let i = 0; i < 6; i += 1) {
      const z = front - 0.1 + i * (BACK_Z - front - 0.2) / 5;
      put(paint, box(18.9, 0.08, 0.1, 0, tinY(z) + 0.16, z), STEEL, CAST);
    }
    // Sheets a metre wide, no two weathered alike, a couple replaced.
    const tilt = Math.atan(TIN.pitch), run = (BACK_Z - (front - 0.42)) / Math.cos(tilt);
    for (let i = 0; i < 20; i += 1) {
      const x = -9.5 + i, shade = 0.72 + random() * 0.3, fresh = i === 6 || i === 14;
      const sheet = box(0.985, 0.025, run).rotateX(-tilt).translate(x, tinY((front - 0.42 + BACK_Z) / 2) + 0.225, (front - 0.42 + BACK_Z) / 2);
      put(tin, sheet, tone.setRGB(shade * (fresh ? 1.15 : 0.9), shade * (fresh ? 1.2 : 0.86), shade * (fresh ? 1.25 : 0.8)).getHex(), SOLID);
    }
    put(tin, box(19.6, 0.3, 0.02, 0, tinY(BACK_Z) + 0.3, BACK_Z - 0.02), 0x8d9296);
    // Its ends are sheeted in above the side walls' height, to keep the weather off the firing line.
    for (const side of [-1, 1]) {
      const x = side * 9.93, z0 = front - 0.42, cheek = polys(side > 0
        ? [[[x, low - 0.1, z0], [x, low - 0.1, BACK_Z], [x, tinY(BACK_Z) + 0.2, BACK_Z], [x, tinY(z0) + 0.2, z0]], [[x, low - 0.1, BACK_Z], [x, low - 0.1, z0], [x, tinY(z0) + 0.2, z0], [x, tinY(BACK_Z) + 0.2, BACK_Z]]]
        : [[[x, low - 0.1, BACK_Z], [x, low - 0.1, z0], [x, tinY(z0) + 0.2, z0], [x, tinY(BACK_Z) + 0.2, BACK_Z]], [[x, low - 0.1, z0], [x, low - 0.1, BACK_Z], [x, tinY(BACK_Z) + 0.2, BACK_Z], [x, tinY(z0) + 0.2, z0]]]);
      const uv = cheek.attributes.uv, at = cheek.attributes.position;
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, at.getZ(i) / 2, at.getY(i) / 2);
      put(tin, cheek, 0x7f8588, { shadow: true, uv: 0 });
      put(paint, box(0.08, 0.1, BACK_Z - z0, side * 9.9, low - 0.1, (BACK_Z + z0) / 2), STEEL, CAST);
    }
    // Gutter along the low edge, falling to the west post.
    const gz = front - 0.5, gy = tinY(front - 0.42) + 0.04;
    for (const [dy, dz, h, d] of [[-0.06, 0, 0.012, 0.16], [0, -0.08, 0.12, 0.012], [0, 0.08, 0.12, 0.012]]) put(iron, box(19.5, h, d, 0, gy + dy, gz + dz).rotateZ(0.004), 0x3a4044, CAST);
    for (let x = -9; x <= 9; x += 2.25) put(iron, box(0.03, 0.2, 0.22, x, gy + 0.02, gz + 0.02), 0x2c2c2c, FINE);
    put(iron, tube([[-9.55, gy - 0.1, gz], [-9.55, gy - 0.4, gz + 0.12], [-9.12, 4.0, front - 0.02], [-9.12, 3.4, front - 0.14]], 0.055, 14, 8), 0x3a4044, CAST);
    put(iron, cyl(0.055, 2.7, -9.12, 2.1, front - 0.14, "y", 8), 0x3a4044, CAST);
    put(iron, tube([[-9.12, 0.78, front - 0.14], [-9.12, 0.58, front - 0.17], [-9.07, 0.45, front - 0.36]], 0.06, 8, 8), 0x3a4044);
    for (const y of [0.9, 2.2, 3.5]) put(iron, box(0.16, 0.03, 0.16, -9.14, y, front - 0.12), 0x242424, FINE);
    // Pendants under the girder.
    LAMPS.slice(6, 10).forEach((lamp) => {
      const [x, y, z] = lamp.at;
      put(iron, cyl(0.008, 0.36, x, y + 0.3, z, "y", 5), 0x202020);
      put(paint, new THREE.CylinderGeometry(0.05, 0.25, 0.15, 14).translate(x, y + 0.08, z), 0x2f5a48);
      put(paint, cyl(0.05, 0.08, x, y + 0.18, z, "y", 8), 0x2a2a2a);
      lens(new THREE.CircleGeometry(0.2, 14).rotateX(PI / 2).translate(x, y - 0.002, z), WARM, 2.6);
      lens(new THREE.SphereGeometry(0.05, 8, 6).translate(x, y - 0.03, z), 0xfff0d0, 6);
      halo([x, y - 0.05, z], 1.5, WARM, 0.8);
      put(paint, beam([x, y + 0.48, z], [x, low - 0.42, front + 0.08], 0.04), STEEL);
    });
  }

  // ---- West: the goods shed, its canopy and the dock road ------------------------
  {
    const cx = (SHED.x0 + SHED.x1) / 2, cz = (SHED.z0 + SHED.z1) / 2, w = SHED.x1 - SHED.x0, l = SHED.z1 - SHED.z0;
    put(brick, box(w, SHED.eaves - YARD, l, cx, (SHED.eaves + YARD) / 2, cz), BRICK, CAST);
    put(tin, roof(w + 0.6, l + 0.5, SHED.ridge - SHED.eaves).translate(cx, SHED.eaves, cz), 0x7b858c, { shadow: true, uv: 0 });
    // The canopy: sheets from the eaves out over the dock road to posts on the lane wall.
    const fall = SHED.eaves - 0.1 - SHED.edgeY, span = SHED.x1 - SHED.edge, slope = Math.atan2(fall, span), midX = (SHED.x1 + SHED.edge) / 2, midY = SHED.edgeY + fall / 2;
    for (let i = 0; i < 18; i += 1) {
      const z = SHED.z0 + 1 + i * 2.012, shade = 0.36 + random() * 0.16;
      const sheet = new THREE.PlaneGeometry(span / Math.cos(slope) + 0.3, 2.0).rotateX(-PI / 2);
      const uv = sheet.attributes.uv, position = sheet.attributes.position;
      for (let k = 0; k < uv.count; k += 1) uv.setXY(k, position.getZ(k) / 2 + i * 0.37, position.getX(k) / 2);
      put(tin, sheet.rotateZ(-slope).translate(midX, midY + 0.16, z), tone.setRGB(shade, shade * 0.97, shade * 0.93).getHex(), { shadow: true, uv: 0 });
      // Boarded underneath: that is the side the lane sees, washed by the lamps hung from its edge.
      put(timber, box(span / Math.cos(slope) + 0.3, 0.04, 2.0).rotateZ(-slope).translate(midX, midY + 0.12, z), tone.setRGB(0.5 + shade * 0.5, 0.48 + shade * 0.5, 0.44 + shade * 0.45).getHex());
    }
    const posts = W_PIERS.filter((z) => z < SHED.z1);
    for (const z of posts) {
      put(paint, iBeam(0.18, 0.18, SHED.edgeY - 0.2 - WALL_TOP, 0.018, 0.012).translate(-WALL_X - 0.25, WALL_TOP, z), 0x3d4a44, CAST);
      put(iron, box(0.34, 0.03, 0.34, -WALL_X - 0.25, WALL_TOP + 0.015, z), 0x2a2a2a);
      put(paint, beam([-WALL_X - 0.25, SHED.edgeY - 0.14, z], [SHED.x1, SHED.eaves - 0.24, z], 0.22, 0.1), 0x3d4a44, CAST);
      for (const dz of [-1, 1]) put(paint, beam([-WALL_X - 0.25, SHED.edgeY - 1.0, z], [-WALL_X - 0.25, SHED.edgeY - 0.24, z + dz * 0.8], 0.06), 0x3d4a44, FINE);
      put(paint, beam([-WALL_X - 0.25, SHED.edgeY - 1.0, z], [SHED.edge + 0.05, SHED.edgeY - 0.3, z], 0.06), 0x3d4a44, FINE);
    }
    put(paint, box(0.1, 0.22, l, -WALL_X - 0.25, SHED.edgeY - 0.25, cz), 0x3d4a44, CAST);
    for (const x of [-11.0, -12.6]) put(paint, box(0.08, 0.1, l, x, SHED.edgeY + (SHED.edge - x) * -fall / span + 0.34, cz), 0x3d4a44);
    // Valance boards along the canopy edge, cut to points, and the gutter behind them.
    put(timber, box(0.035, 0.42, l, SHED.edge, SHED.edgeY - 0.14, cz), 0x8a8474, CAST);
    for (let z = SHED.z0 + 0.15; z < SHED.z1; z += 0.3) put(timber, new THREE.CylinderGeometry(0, 0.105, 0.14, 4, 1).rotateY(PI / 4).scale(0.24, 1, 1.42).rotateX(PI).translate(SHED.edge, SHED.edgeY - 0.42, z), 0x8a8474, FINE);
    // Sodium lamps hung from the edge beam, over the lane's left side.
    LAMPS.slice(0, 3).forEach((lamp) => {
      const [x, y, z] = lamp.at;
      put(iron, tube([[SHED.edge - 0.3, SHED.edgeY - 0.25, z], [x - 0.1, y + 0.42, z], [x, y + 0.3, z]], 0.02, 8, 5), 0x262626);
      put(paint, new THREE.CylinderGeometry(0.07, 0.3, 0.2, 14).translate(x, y + 0.12, z), 0x33392f, CAST);
      lens(new THREE.CircleGeometry(0.24, 14).rotateX(PI / 2).translate(x, y + 0.018, z), SODIUM, 3.4);
      lens(new THREE.SphereGeometry(0.07, 8, 6).translate(x, y - 0.02, z), 0xffd28a, 7);
      halo([x, y - 0.06, z], 2.3, SODIUM, 1);
      cone([x, y, z], y - 0.02, 3.6, SODIUM, 0.16);
    });
    // The dock: a platform at wagon-floor height along the shed, doors standing open on the light inside.
    put(concrete, box(1.6, 1.3, l, SHED.x1 + 0.8, YARD + 0.65, cz), POURED);
    for (const z of [-27, -16, -5]) {
      put(timber, box(0.1, 3.2, 3.4, SHED.x1 + 0.03, YARD + 1.3 + 1.6, z + 3.6), 0x6a5a48);
      lens(quad(3.2, 3.0, SHED.x1 + 0.02, YARD + 1.3 + 1.5, z, "x+"), WARM, 0.5);
      halo([SHED.x1 + 0.5, YARD + 3.2, z], 5, WARM, 0.3);
    }
  }

  // ---- East: the signal cabin on its brick base, the railing along the wall -----------
  {
    const cx = (CABIN.x1 + WALL_X) / 2, cz = (CABIN.z0 + CABIN.z1) / 2, w = CABIN.x1 - WALL_X, l = CABIN.z1 - CABIN.z0, PLANK = 0x8b8f86, TRIM = 0x2c4a3c;
    // Operating floor: weatherboards below the sill, a band of windows on three sides, boards above.
    put(timber, box(w, 0.85, l, cx, CABIN.floor + 0.425, cz), PLANK, CAST);
    put(timber, box(w, 0.4, l, cx, CABIN.eaves - 0.2, cz), PLANK, CAST);
    put(timber, box(w - 0.3, 1.4, l - 0.3, cx, CABIN.floor + 1.5, cz), 0x30261c);
    const sill = CABIN.floor + 0.85, head = CABIN.eaves - 0.4, glass = head - sill;
    sign("levers", l - 0.24, glass, WALL_X - 0.012, sill + glass / 2, cz, "x-", "pane", 0xffffff, {});
    sign("levers", l - 0.24, glass, CABIN.x1 + 0.012, sill + glass / 2, cz, "x+", "pane", 0xd0d0d0, {});
    for (const [z, facing] of [[CABIN.z0 - 0.012, "z-"], [CABIN.z1 + 0.012, "z+"]] as Array<[number, Facing]>) lens(quad(w - 0.3, glass, cx, sill + glass / 2, z, facing), WARM, 0.75);
    for (let i = 0; i <= 8; i += 1) {
      const z = CABIN.z0 + 0.06 + i * (l - 0.12) / 8;
      for (const x of [WALL_X - 0.02, CABIN.x1 + 0.02]) put(paint, box(0.1, glass + 0.1, 0.1, x, sill + glass / 2, z), TRIM, i % 4 === 0 ? CAST : FINE);
    }
    for (const z of [CABIN.z0 - 0.02, CABIN.z1 + 0.02]) for (const x of [WALL_X + 0.05, cx, CABIN.x1 - 0.05]) put(paint, box(0.1, glass + 0.1, 0.1, x, sill + glass / 2, z), TRIM);
    put(paint, box(w + 0.16, 0.08, l + 0.16, cx, sill - 0.02, cz), TRIM);
    sign("cabin", 3.3, 0.44, WALL_X - 0.03, CABIN.floor + 0.44, cz + 1.2, "x-");
    // Hipped slate roof, deep eaves, a stove pipe through the far slope.
    put(slate, roof(w + 0.9, l + 0.9, CABIN.ridge - CABIN.eaves, 1.9).translate(cx, CABIN.eaves, cz), 0x2a3038, CAST);
    put(timber, box(w + 0.9, 0.07, l + 0.9, cx, CABIN.eaves - 0.03, cz), 0x6f7168, CAST);
    for (const z of [CABIN.z0 + 1.45, CABIN.z1 - 1.45]) put(iron, cyl(0.03, 0.5, cx, CABIN.ridge + 0.2, z, "y", 6), 0x242424);
    put(iron, cyl(0.09, 1.5, CABIN.x1 - 0.7, CABIN.ridge - 0.1, CABIN.z1 - 1.6, "y", 8), 0x2a2a2a);
    put(iron, new THREE.ConeGeometry(0.18, 0.14, 8).translate(CABIN.x1 - 0.7, CABIN.ridge + 0.76, CABIN.z1 - 1.6), 0x2a2a2a);
    // The furnace flue climbs the cabin's face and goes through the eaves in a lead collar, a cowl on top.
    put(iron, cyl(0.36, 0.1, 9.28, CABIN.eaves + 0.14, -12.65, "y", 16), 0x4a4f55);
    put(iron, new THREE.ConeGeometry(0.46, 0.22, 16).translate(9.28, 8.46, -12.65), 0x2e3134);
    for (const turn of [0, PI / 2]) put(iron, box(0.04, 0.2, 0.62).rotateY(turn).translate(9.28, 8.26, -12.65), 0x2e3134);
    for (const y of [4.9, 6.4]) put(iron, box(0.34, 0.05, 0.72, 9.4, y, -12.65), 0x2a2a2a, FINE);
    // Stairs up the cabin's far end from the yard, and its door lamp.
    for (let i = 0; i < 8; i += 1) put(timber, box(1.0, 0.05, 0.3, CABIN.x1 - 0.6, YARD + 0.26 * (i + 1), CABIN.z0 - 2.6 + i * 0.3), 0x6f6658);
    put(timber, box(1.1, 0.06, 0.3 + 0.2, CABIN.x1 - 0.6, CABIN.floor, CABIN.z0 - 0.25), 0x6f6658);
    put(iron, beam([CABIN.x1 - 1.12, YARD + 1.2, CABIN.z0 - 2.6], [CABIN.x1 - 1.12, CABIN.floor + 1.0, CABIN.z0 - 0.1], 0.04), 0x2a2a2a);
    lens(new THREE.SphereGeometry(0.07, 8, 6).translate(CABIN.x1 - 0.9, CABIN.eaves - 0.6, CABIN.z0 - 0.12), WARM, 5);
    halo([CABIN.x1 - 0.9, CABIN.eaves - 0.6, CABIN.z0 - 0.2], 1.6, WARM, 0.7);
    halo([WALL_X - 0.4, sill + glass * 0.55, cz], 6.5, WARM, 0.22);
    // Pipe railing along the top of the retaining wall.
    for (const [z0, z1] of [[FAR_Z, CABIN.z0], [CABIN.z1, BACK_Z]]) {
      for (const y of [WALL_TOP + 0.55, WALL_TOP + 1.05]) put(iron, rod([WALL_X + 0.25, y, z0], [WALL_X + 0.25, y, z1], 0.022, 5), 0x30363a, CAST);
      for (let z = z0 + 0.1; z < z1; z += 1.6) put(iron, cyl(0.025, 1.08, WALL_X + 0.25, WALL_TOP + 0.54, z, "y", 5), 0x30363a, CAST);
    }
    // Cold well-glass fittings on brackets off the wall.
    LAMPS.slice(3, 5).forEach((lamp) => {
      const [x, y, z] = lamp.at;
      put(iron, cyl(0.035, y + 0.35 - WALL_TOP, WALL_X + 0.25, (y + 0.35 + WALL_TOP) / 2, z, "y", 6), 0x30363a, CAST);
      put(iron, tube([[WALL_X + 0.25, y + 0.3, z], [x + 0.2, y + 0.42, z], [x, y + 0.22, z]], 0.025, 8, 5), 0x30363a);
      put(paint, new THREE.CylinderGeometry(0.09, 0.2, 0.16, 12).translate(x, y + 0.12, z), 0x7c8388, CAST);
      if (lamp === LAMPS[FAILING]) return;
      lens(new THREE.CylinderGeometry(0.11, 0.08, 0.16, 10).translate(x, y - 0.03, z), COLD, 4.2);
      halo([x, y - 0.05, z], 2.0, COLD, 1);
      cone([x, y, z], y - 0.02, 3.2, COLD, 0.12);
    });
  }
  const failing = {
    lens: new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 0.16, 10).translate(LAMPS[FAILING].at[0], LAMPS[FAILING].at[1] - 0.03, LAMPS[FAILING].at[2]), new THREE.MeshBasicMaterial({ toneMapped: false })),
    halo: halo([LAMPS[FAILING].at[0], LAMPS[FAILING].at[1] - 0.05, LAMPS[FAILING].at[2]], 2.0, COLD, 1),
  };
  scene.add(failing.lens);
  kit.mirrorHidden.push(failing.lens);

  // ---- Track -----------------------------------------------------------------
  // Upper-level roads: a ballast bed, sleepers, rails. `lift` is the hump under the diesel's road.
  const sleepers: Transform[] = [], RAIL_STEEL = 0x4d443c;
  const road = (x: number, z0: number, z1: number, lift = 0) => {
    const mid = (z0 + z1) / 2, length = z1 - z0;
    if (lift) {
      // The high road stands on a concrete bank, a pipe rail along each edge.
      put(concrete, box(4.5, lift, length, x, YARD + lift / 2, mid), POURED);
      for (const side of [-1, 1]) {
        put(concrete, box(0.5, 0.16, length, x + side * 2.05, YARD + lift + 0.08, mid), STONE);
        for (const y of [0.6, 1.1]) put(iron, rod([x + side * 2.2, YARD + lift + y, z0], [x + side * 2.2, YARD + lift + y, z1], 0.022, 5), 0x30363a);
        for (let z = z0 + 0.2; z < z1; z += 2.4) put(iron, cyl(0.025, 1.1, x + side * 2.2, YARD + lift + 0.55, z, "y", 5), 0x30363a);
      }
    }
    put(yardGround, box(3.5, 0.14, length, x, YARD + lift + 0.07, mid), BALLAST);
    for (const side of [-1, 1]) put(rust, box(0.07, 0.15, length, x + side * 0.7525, RAIL + lift - 0.075, mid), RAIL_STEEL);
    for (let z = z0 + 0.3; z < z1; z += 0.68) sleepers.push({ position: [x, YARD + lift + 0.14, z], rotation: [0, (random() - 0.5) * 0.04, 0] });
  };
  road(WEST_ROAD, -150, 60);
  road(EAST_ROAD, -150, 60);
  for (const x of SIDINGS) road(x, -150, 70);
  for (const x of STUBS) road(x, x === LOCO.x ? -74 : -130, FAR_Z - 1.6, x === LOCO.x ? HUMP : 0);
  {
    // The high road comes up to its bank on a ramp from the far end of the yard.
    const x = LOCO.x, z0 = -132, z1 = -74, top = YARD + HUMP, tilt = Math.atan2(HUMP, z1 - z0);
    put(concrete, polys([
      [[x - 2.25, YARD, z0], [x - 2.25, top, z1], [x + 2.25, top, z1], [x + 2.25, YARD, z0]],
      [[x - 2.25, YARD, z0], [x - 2.25, YARD, z1], [x - 2.25, top, z1]],
      [[x + 2.25, YARD, z0], [x + 2.25, top, z1], [x + 2.25, YARD, z1]],
    ]), POURED);
    put(yardGround, beam([x, YARD + 0.07, z0], [x, top + 0.07, z1], 3.5, 0.14), BALLAST);
    for (const side of [-1, 1]) put(rust, beam([x + side * 0.7525, YARD + 0.275, z0], [x + side * 0.7525, top + 0.275, z1], 0.07, 0.15), RAIL_STEEL);
    for (let z = z0 + 0.3; z < z1; z += 0.68) sleepers.push({ position: [x, YARD + 0.14 + HUMP * (z - z0) / (z1 - z0), z], rotation: [-tilt, 0, 0] });
  }
  // Buffer stops at the lane's edge: rail-built frames, a timber beam, a red lamp.
  for (const x of STUBS) {
    const y = RAIL + (x === LOCO.x ? HUMP : 0), z = FAR_Z - 1.9;
    for (const side of [-1, 1]) {
      put(rust, beam([x + side * 0.75, y, z - 1.5], [x + side * 0.75, y + 1.05, z], 0.09), RAIL_STEEL);
      put(rust, beam([x + side * 0.75, y, z + 0.1], [x + side * 0.75, y + 1.05, z], 0.09), RAIL_STEEL);
    }
    put(timber, box(2.3, 0.3, 0.26, x, y + 1.0, z + 0.12), 0x7a3026);
    lens(new THREE.SphereGeometry(0.08, 8, 6).translate(x, y + 1.3, z + 0.1), 0xff2a14, 5);
    halo([x, y + 1.3, z + 0.2], 1.3, 0xff2a14, 0.9);
  }

  // ---- Rolling stock on the roads ------------------------------------------------
  type Wagon = { kind: "box" | "tank" | "hopper"; x: number; z: number; paint: number; turn?: boolean; lift?: number; name?: string; ink?: number };
  const wagons: Wagon[] = [
    { kind: "box", x: WEST_ROAD, z: -22.2, paint: 0x8a3a26, name: "rush", ink: 0xe8e2d0 },
    { kind: "box", x: WEST_ROAD, z: -8.9, paint: 0x2f6d6a, name: "eco2", ink: 0xe8e2d0 },
    { kind: "box", x: WEST_ROAD, z: 4.4, paint: 0xb88a1e, name: "cache", ink: 0x1a1612, turn: true },
    { kind: "box", x: WEST_ROAD, z: -35.5, paint: 0x5d6770 },
    { kind: "box", x: WEST_ROAD, z: -48.8, paint: 0x7d3324 },
    { kind: "hopper", x: EAST_ROAD, z: -21.6, paint: 0xa9a48f, name: "trade", ink: 0x7a1d16 },
    { kind: "tank", x: EAST_ROAD, z: -0.4, paint: 0xb9bcb6, name: "fuel", ink: 0x8a1d16 },
    { kind: "box", x: EAST_ROAD, z: -35.2, paint: 0x2d4f7a, name: "loss2", ink: 0xe8e2d0 },
    { kind: "tank", x: EAST_ROAD, z: -48.6, paint: 0x8c8f8a },
    { kind: "hopper", x: EAST_ROAD, z: 13.2, paint: 0x6d3a2a },
    { kind: "box", x: 0, z: -40.2, paint: 0x6a2f24, name: "loss2", ink: 0xe8e2d0 },
    { kind: "tank", x: 0, z: -53.6, paint: 0x2a2c2e },
    { kind: "hopper", x: 0, z: -67.2, paint: 0x9a957f },
    { kind: "hopper", x: 7, z: -44.5, paint: 0x55606a, name: "trade", ink: 0xe8e2d0 },
    { kind: "box", x: 7, z: -58, paint: 0x2f6d6a },
    { kind: "box", x: 7, z: -71.4, paint: 0xa7801c },
    // Rakes standing on the sidings either side: seen from the lane only between and over what is nearer.
    ...([[19, 6.2, "box", 0x6d3a2a], [19, -7.2, "hopper", 0x8a8f8a], [19, -20.6, "box", 0x2f4f6a], [19, -52, "tank", 0x2a2c2e], [19, -65.4, "tank", 0xa9aaa4], [19, -78.8, "box", 0x7d3324],
      [29.5, -4, "hopper", 0x6d3a2a], [29.5, -17.4, "hopper", 0x6d3a2a], [29.5, -30.8, "hopper", 0x70757a], [29.5, -76, "box", 0xa7801c], [29.5, -89.4, "box", 0x2f6d6a],
      [34.1, 14, "box", 0x5d6770], [34.1, -42, "tank", 0x8c8f8a], [34.1, -55.4, "box", 0x8a3a26], [34.1, -68.8, "box", 0x2d4f7a],
      [-28.6, -44, "box", 0x2f6d6a], [-28.6, -57.4, "box", 0x8a3a26], [-28.6, -70.8, "hopper", 0x9a957f], [-28.6, 20, "tank", 0x2a2c2e],
      [-33.2, -8, "box", 0xa7801c], [-33.2, 5.4, "box", 0x5d6770], [-33.2, -96, "hopper", 0x6d3a2a], [-33.2, -109.4, "hopper", 0x6d3a2a],
      [-37.8, -30, "tank", 0xa9aaa4], [-37.8, -64, "box", 0x7d3324], [-37.8, -77.4, "box", 0x2d4f7a], [-37.8, -90.8, "box", 0x6a2f24],
      [WEST_ROAD, -80, "box", 0xa7801c], [EAST_ROAD, -70, "hopper", 0x55606a], [0, -96, "box", 0x2f4f6a], [7, -100, "tank", 0x8c8f8a]] as Array<[number, number, Wagon["kind"], number]>)
      .map(([x, z, kind, paint]) => ({ kind, x, z, paint })),
  ];
  const stock = { box: boxcarGeometry(), tank: tankGeometry(), hopper: hopperGeometry() };
  for (const kind of ["box", "tank", "hopper"] as const) {
    const group = wagons.filter((wagon) => wagon.kind === kind);
    const mesh = kit.instances(stock[kind], paint, group.map((wagon) => ({ position: [wagon.x, RAIL + (wagon.lift ?? 0), wagon.z] as V3, rotation: [0, wagon.turn ? PI : 0, 0] as V3 })), true, true);
    group.forEach((wagon, index) => mesh.setColorAt(index, tone.set(wagon.paint).multiplyScalar(0.8 + random() * 0.3)));
    mesh.instanceColor!.needsUpdate = true;
  }
  // Reporting marks and the owner's name, stencilled high on the side that faces the lane (and on the other).
  for (const wagon of wagons) {
    if (!wagon.name) continue;
    const y = RAIL, ink = wagon.ink ?? 0xe8e2d0;
    for (const side of [-1, 1]) {
      const facing: Facing = side > 0 ? "x+" : "x-";
      if (wagon.kind === "box") {
        const x = wagon.x + side * 1.57;
        sign(wagon.name, 3.5, 0.875, x, y + 3.35, wagon.z - side * 3.75, facing, "mark", ink);
        sign(`${wagon.name}No`, 1.9, 0.73, x, y + 3.4, wagon.z + side * 3.9, facing, "mark", ink);
        sign("chalk", 0.9, 0.35, x + side * 0.1, y + 2.2, wagon.z + 0.2, facing, "mark", 0xd8d8d0, FINE);
      } else if (wagon.kind === "tank") {
        const x = wagon.x + side * 1.3;
        sign(wagon.name, 4.4, 0.95, x, y + 3.52, wagon.z - side * 2.6, facing, "mark", ink);
        sign(`${wagon.name}No`, 1.9, 0.73, x, y + 3.5, wagon.z + side * 3.2, facing, "mark", ink);
      } else {
        const x = wagon.x + side * 1.585;
        sign(wagon.name, 2.9, 0.725, x, y + 3.7, wagon.z - side * 2.9, facing, "mark", ink);
        sign(`${wagon.name}No`, 1.6, 0.62, x, y + 3.7, wagon.z + side * 3.5, facing, "mark", ink);
      }
    }
  }

  // ---- Beyond the far end: the yard running on into the dark -----------------------
  // The signal gantry across the roads. Its heads stand above the bridge so they clear the control centre
  // from the firing line; each shows one aspect, and the aspects change (see "Things that happen").
  const HEADS = [WEST_ROAD, -7, 0, 7, EAST_ROAD];
  const ASPECTS = [new THREE.Color(1, 0.08, 0.04), new THREE.Color(1, 0.55, 0.06), new THREE.Color(0.1, 1, 0.42)];
  const headY = (aspect: number) => GANTRY_Y + 3.05 - aspect * 0.5;
  {
    const STEEL = 0x4c555c, z = GANTRY_Z, x0 = -17.4, x1 = 18.6;
    for (const x of [x0, 3.5, x1]) laced([x, YARD, z], [x, GANTRY_Y + 1.3, z], [0.9, 1.2], 4, 0.12, 0.035).forEach((part) => put(paint, part, STEEL));
    laced([x0, GANTRY_Y + 0.65, z], [x1, GANTRY_Y + 0.65, z], [1.3, 1.2], 16, 0.12, 0.035).forEach((part) => put(paint, part, STEEL));
    put(iron, box(x1 - x0, 0.04, 1.1, (x0 + x1) / 2, GANTRY_Y + 1.34, z), 0x2e3336);
    for (const dz of [-0.55, 0.55]) {
      for (const y of [GANTRY_Y + 1.9, GANTRY_Y + 2.4]) put(iron, rod([x0, y, z + dz], [x1, y, z + dz], 0.02, 4), 0x30363a);
      for (let x = x0; x <= x1 + 0.01; x += 2.25) put(iron, cyl(0.02, 1.06, x, GANTRY_Y + 1.87, z + dz, "y", 4), 0x30363a);
    }
    for (const x of HEADS) {
      put(paint, box(0.12, 2.6, 0.12, x, GANTRY_Y + 2.6, z + 0.62), STEEL);
      put(paint, box(0.78, 1.8, 0.07, x, GANTRY_Y + 2.55, z + 0.72), 0x101112);
      put(paint, box(0.5, 0.3, 0.05, x, GANTRY_Y + 1.42, z + 0.72), 0xd8d4c4);
      for (let aspect = 0; aspect < 3; aspect += 1) {
        const visor = new THREE.CylinderGeometry(0.16, 0.16, 0.3, 10, 1, true, -PI / 2, PI).rotateX(PI / 2).translate(x, headY(aspect), z + 0.9);
        put(tin, visor, 0x161616, { uv: 0 });
      }
    }
    const rungs: Part[] = [];
    ladder(rungs, x0 - 0.55, z, YARD, GANTRY_Y + 1.4, "z", 0.45);
    rungs.forEach(([part]) => put(iron, part, 0x30363a));
  }
  const aspectLens = new THREE.InstancedMesh(new THREE.CircleGeometry(0.115, 14), new THREE.MeshBasicMaterial({ toneMapped: false }), HEADS.length * 3);
  {
    const matrix = new THREE.Matrix4();
    HEADS.forEach((x, head) => { for (let aspect = 0; aspect < 3; aspect += 1) aspectLens.setMatrixAt(head * 3 + aspect, matrix.makeTranslation(x, headY(aspect), GANTRY_Z + 0.765)); });
    aspectLens.frustumCulled = false;
    scene.add(aspectLens);
  }
  const aspectHalo = HEADS.map((x) => halo([x, headY(0), GANTRY_Z + 0.9], 1.7, 0xff2a14, 2.2));

  // The diesel on the hump road, nose and headlight toward the range, ticking over.
  const locoY = RAIL + HUMP, noseZ = LOCO.z + 8.5;
  {
    put(paint, locoGeometry().translate(LOCO.x, locoY, LOCO.z), null);
    const cab = LOCO.z + 4.5, glassY = locoY + 1.62 + 1.95;
    for (const x of [-0.7, 0.7]) put(glazing, quad(0.95, 0.62, LOCO.x + x, glassY, cab + 1.262, "z+"), 0xffffff);
    for (const side of [-1, 1]) put(glazing, quad(1.5, 0.7, LOCO.x + side * 1.512, glassY - 0.05, cab, side > 0 ? "x+" : "x-"), 0xffffff);
    // Twin sealed beams over the windscreens, number boards either side, ditch lights on the pilot.
    for (const x of [-0.15, 0.15]) lens(new THREE.CircleGeometry(0.11, 12).translate(LOCO.x + x, locoY + 1.62 + 2.5, cab + 1.455), 0xfff4dc, 14);
    for (const x of [-0.95, 0.95]) sign("numbers", 0.62, 0.26, LOCO.x + x, locoY + 1.62 + 2.5, cab + 1.265, "z+", "pane", 0xffffff, {});
    for (const x of [-0.85, 0.85]) lens(new THREE.CircleGeometry(0.09, 10).translate(LOCO.x + x, locoY + 1.05, noseZ + 0.09), 0xfff4dc, 8);
    lens(quad(1.3, 0.3, LOCO.x, glassY - 0.25, cab + 1.25, "z+"), 0x7dffb4, 0.12);
    for (const side of [-1, 1]) sign("hsx", 2.6, 0.84, LOCO.x + side * 1.02, locoY + 1.62 + 1.2, LOCO.z - 1.6, side > 0 ? "x+" : "x-", "mark", 0xf0e9d2);
    // Wasp stripes on the nose.
    for (let i = 0; i < 6; i += 1) put(paint, box(0.3, 1.2, 0.01, 0, 0, 0).rotateZ(0.6).translate(LOCO.x - 1.15 + i * 0.46, locoY + 0.95, noseZ + 0.085), 0x161616);
  }
  const headlight = halo([LOCO.x, locoY + 4.12, LOCO.z + 6.1], 2.4, 0xfff0d2, 9);
  shaft([LOCO.x, locoY + 4.12, LOCO.z + 6.2], [LOCO.x + 1.2, locoY + 2.1, LOCO.z + 34], 1.15, 0xfff0d2, 0.14);
  for (const x of [-0.85, 0.85]) halo([LOCO.x + x, locoY + 1.05, noseZ + 0.2], 2.2, 0xfff0d2, 1.1);

  // High masts: the key behind the firing line, and the yard's own going away into the rain.
  const masts: Array<[number, number, number, number]> = [[-25, 24.5, 30, COLD], [-23, -47, 25, COLD], [24, -66, 27, COLD], [-4, -96, 29, COLD], [40, -28, 25, COLD], [-46, -16, 25, SODIUM], [39.5, -112, 27, SODIUM], [-43, -128, 29, COLD]];
  masts.forEach(([x, z, h, colour], index) => {
    put(iron, new THREE.CylinderGeometry(0.14, 0.36, h, 10).translate(x, YARD + h / 2, z), 0x3a4046);
    put(iron, cyl(1.5, 0.28, x, YARD + h, z, "y", 12), 0x2a2e32);
    for (let i = 0; i < 6; i += 1) {
      const a = i * PI / 3;
      lens(box(0.5, 0.05, 0.36).rotateY(-a).translate(x + Math.cos(a) * 1.15, YARD + h - 0.17, z + Math.sin(a) * 1.15), colour, 5);
    }
    halo([x, YARD + h - 0.3, z], index ? 9 : 12, colour, index ? 1.5 : 2.2);
    cone([x, YARD + h - 0.2, z], h - 0.2, h * 0.62, colour, index ? 0.09 : 0.14);
    put(concrete, box(1.2, 0.5, 1.2, x, YARD + 0.25, z), POURED);
  });
  // Sodium posts between the roads.
  const posts: Array<[number, number]> = [[-3.4, -38.55], [3.5, -52], [-3.5, -66], [10.5, -42], [-16, -56], [16.7, -38], [10.5, -74], [-3.5, -90], [16.7, 0.85], [16.7, -84], [-25.7, -70], [3.5, -112], [24.2, -22], [-31, -22], [24.2, 30], [-25.7, -112]];
  for (const [x, z] of posts) {
    put(iron, new THREE.CylinderGeometry(0.06, 0.1, 8.4, 8).translate(x, YARD + 4.2, z), 0x3a4046);
    put(iron, rod([x, YARD + 8.3, z], [x, YARD + 8.5, z + 0.9], 0.04, 6), 0x3a4046);
    lens(box(0.2, 0.06, 0.5, x, YARD + 8.42, z + 0.95), SODIUM, 5);
    halo([x, YARD + 8.36, z + 0.95], 3.4, SODIUM, 1.2);
  }
  // The pole route along the east side: three arms of wires, sagging from pole to pole into the dark.
  {
    const x = 16.75, polesAt = [26, 8.5, -9.5, -27.5, -45.5, -63.5, -81.5], top = YARD + 8.3, POLE = 0x4a3f34;
    polesAt.forEach((z, index) => {
      put(timber, new THREE.CylinderGeometry(0.1, 0.15, 8.4, 8).translate(x, YARD + 4.2, z), POLE);
      for (let arm = 0; arm < 3; arm += 1) {
        const y = top - 0.35 - arm * 0.55;
        put(timber, box(1.9 - arm * 0.2, 0.09, 0.09, x, y, z + 0.1), POLE);
        for (const side of [-1, 1]) for (const out of [0.4, 0.8 - arm * 0.1]) {
          put(slate, cyl(0.03, 0.1, x + side * out, y + 0.09, z + 0.1, "y", 6), 0xd8dcd8, FINE);
          if (index > 0 && high) {
            const from = polesAt[index - 1] + 0.1, to = z + 0.1, wx = x + side * out, wy = y + 0.14;
            put(iron, tube([[wx, wy, from], [wx, wy - 0.42, (from + to) / 2], [wx, wy, to]], 0.007, 8, 3), 0x1c1c1c, FINE);
          }
        }
      }
    });
    // ... and the lamp that stands over the oil siding.
    const [lx, ly, lz] = LAMPS[13].at;
    put(iron, new THREE.CylinderGeometry(0.06, 0.1, ly - YARD + 0.3, 8).translate(16.7, (ly + 0.3 + YARD) / 2, lz), 0x3a4046);
    put(iron, rod([16.7, ly + 0.22, lz], [lx - 0.1, ly + 0.14, lz], 0.04, 6), 0x3a4046);
    lens(box(0.5, 0.06, 0.2, lx, ly + 0.05, lz), SODIUM, 5);
    halo([lx, ly, lz], 2.6, SODIUM, 1.2);
    cone([lx, ly, lz], ly - YARD, 4.2, SODIUM, 0.14);
  }
  // The water tower.
  {
    const x = 24, z = -50, base = YARD, deck = base + 12.5, STEEL = 0x4a4e50;
    for (let i = 0; i < 6; i += 1) {
      const a = i * PI / 3 + 0.3, b = a + PI / 3, foot = 3.6, head = 3.0;
      put(iron, beam([x + Math.cos(a) * foot, base, z + Math.sin(a) * foot], [x + Math.cos(a) * head, deck, z + Math.sin(a) * head], 0.24), STEEL);
      for (const [y0, y1] of [[0.4, 6.2], [6.2, 12.2]]) {
        const r0 = foot + (head - foot) * y0 / 12.5, r1 = foot + (head - foot) * y1 / 12.5;
        put(iron, rod([x + Math.cos(a) * r0, base + y0, z + Math.sin(a) * r0], [x + Math.cos(b) * r1, base + y1, z + Math.sin(b) * r1], 0.035, 4), STEEL);
        put(iron, rod([x + Math.cos(b) * r0, base + y0, z + Math.sin(b) * r0], [x + Math.cos(a) * r1, base + y1, z + Math.sin(a) * r1], 0.035, 4), STEEL);
      }
    }
    put(iron, cyl(4.3, 0.12, x, deck + 0.06, z, "y", 20), 0x34383a);
    put(paint, cyl(3.9, 5.4, x, deck + 2.82, z, "y", 28), 0x6f7a80, { uv: 0 });
    for (const y of [0.6, 2.7, 4.8]) put(iron, new THREE.CylinderGeometry(3.93, 3.93, 0.1, 28, 1, true).translate(x, deck + 0.12 + y, z), 0x2f3336);
    put(slate, new THREE.ConeGeometry(4.15, 1.5, 28).translate(x, deck + 6.27, z), 0x30353a);
    put(iron, cyl(0.2, 12, x, base + 6.2, z, "y", 8), STEEL);
    put(iron, rod([x - 3.4, deck + 0.8, z + 2.6], [x - 6.6, deck - 2.4, z + 4.6], 0.16, 8), STEEL);
    lens(new THREE.SphereGeometry(0.12, 8, 6).translate(x, deck + 7.15, z), 0xff2a14, 6);
    halo([x, deck + 7.15, z], 2.4, 0xff2a14, 1, 2.6);
    // The name is painted round the tank, on the side the range sees.
    const letters = new THREE.CylinderGeometry(3.93, 3.93, 1.5, 20, 1, true, PI * 1.72, PI * 0.5).translate(x, deck + 3.1, z);
    put(marks, cellUv(letters, atlas.cells.get("tower")!), 0xd8d4c8, { uv: 0 });
  }
  // A second gantry far down the yard, and the coaling stage: shapes against the glow, a few lamps on them.
  {
    const z = -84, STEEL = 0x3c4348;
    for (const x of [-15, 16]) put(paint, box(0.5, 9, 0.5, x, YARD + 4.5, z), STEEL);
    put(paint, box(31.5, 0.9, 0.7, 0.5, YARD + 9.2, z), STEEL);
    [-11.9, -7, 0, 7, 14.4].forEach((x, index) => {
      put(paint, box(0.7, 1.7, 0.06, x, YARD + 10.6, z + 0.4), 0x101112);
      halo([x, YARD + 10.6 + (index % 2 ? 0.5 : -0.5), z + 0.6], 2.4, index % 2 ? 0xff2a14 : 0x22ff7a, 1.3);
    });
    put(concrete, box(9, 17, 8, -46, YARD + 8.5, -92), 0x7c7a74);
    put(concrete, box(10.4, 1.2, 9.2, -46, YARD + 17.6, -92), 0x6c6a66);
    put(tin, roof(9.4, 10.6, 2.2).translate(-46, YARD + 18.2, -92), 0x5d646a, { uv: 0 });
    put(iron, beam([-41.5, YARD + 12, -92], [-35.5, YARD + 5.4, -92], 1.1, 0.9), 0x3a3f43);
    for (const [dx, dy] of [[-2.4, 11], [2.2, 14.2], [0.4, 6.5]]) { lens(quad(0.8, 1.1, -46 + dx, YARD + dy, -87.98, "z+"), WARM, 1.6); halo([-46 + dx, YARD + dy, -87.8], 2.6, WARM, 0.8); }
  }
  // Lamps too far off to be more than a point in the rain.
  for (let i = 0; i < 46; i += 1) {
    const a = random() * PI * 2, r = 110 + random() * 150, x = Math.cos(a) * r, z = -30 + Math.sin(a) * r * (Math.sin(a) < 0 ? 1 : 0.5), pick = random();
    halo([x, YARD + 9 + random() * 20, z], 4 + random() * 4, pick < 0.55 ? SODIUM : pick < 0.85 ? COLD : pick < 0.93 ? 0xff2a14 : 0x22ff7a, 0.9 + random() * 0.8, pick > 0.97 ? 1.7 : 0);
  }

  const placed = new Map<PropKind, PropItem[]>();
  const prop = (kind: PropKind, x: number, y: number, z: number, yaw = 0, extra: Partial<PropItem> = {}) => {
    if (!placed.has(kind)) placed.set(kind, []);
    placed.get(kind)!.push({ position: [x, y, z], rotation: [0, yaw, 0], ...extra });
  };

  // ---- Near detail ---------------------------------------------------------------
  const DARK_IRON = 0x2a2c2e, RAIL_HEAD = 0xaeb4ba, PIPE = 0x30363a;
  // Hand tramways, two-foot gauge, laid flush: one along the shed wall from the depot door to its buffer stop,
  // one from the far end to the furnace for the coal tubs.
  const tramway = (x: number, z0: number, z1: number) => {
    const mid = (z0 + z1) / 2, length = z1 - z0;
    for (const side of [-1, 1]) {
      put(rust, box(0.055, 0.024, length, x + side * 0.305, 0.012, mid), 0x6d635a);
      put(iron, box(0.022, 0.004, length, x + side * 0.305, 0.026, mid), RAIL_HEAD, FINE);
    }
    for (let z = z0 + 0.25; z < z1; z += 0.7) put(timber, box(0.98, 0.014, 0.17, x, 0.007, z), 0x55493c);
  };
  tramway(-8.72, -23.4, 9.5);
  tramway(8.72, -24.6, -14.9);
  {
    // Buffer stop at the end of the shed line: bent rail, a timber baulk, the red lamp on its stalk.
    const x = -8.72, z = -23.6, OLD_RAIL = 0x7a6f66;
    for (const side of [-1, 1]) {
      put(rust, tube([[x + side * 0.305, 0.02, z + 1.0], [x + side * 0.305, 0.3, z + 0.38], [x + side * 0.305, 0.7, z + 0.12], [x + side * 0.305, 0.78, z - 0.25]], 0.035, 12, 6), OLD_RAIL, SOLID);
      put(rust, beam([x + side * 0.305, 0.02, z - 0.55], [x + side * 0.305, 0.74, z - 0.05], 0.06), OLD_RAIL, SOLID);
    }
    put(timber, box(0.95, 0.2, 0.16, x, 0.72, z + 0.2), 0x8a2f24, SOLID);
    put(iron, cyl(0.02, 0.62, x, 1.0, z - 0.02, "y", 6), DARK_IRON);
    put(paint, cyl(0.075, 0.17, x, 1.38, z - 0.02, "y", 10), 0x202020);
    lens(new THREE.CircleGeometry(0.055, 12).translate(x, 1.38, z + 0.056), 0xff2a14, 7);
    halo([x, 1.38, z + 0.1], 0.9, 0xff2a14, 1);
    sign("endOfLine", 0.8, 0.36, -WALL_X + 0.006, 1.6, -25.4, "x+");
  }
  {
    // A platform trolley on the shed line by the depot door, two cases on it.
    const x = -8.72, z = 6.3;
    put(timber, box(0.82, 0.05, 1.35, x, 0.405, z), 0x8f7a5c, SOLID);
    put(paint, box(0.7, 0.08, 1.2, x, 0.34, z), 0x3f5a48, SOLID);
    for (const dz of [-0.42, 0.42]) {
      put(iron, cyl(0.02, 0.72, x, 0.172, z + dz, "x", 6), DARK_IRON);
      for (const side of [-1, 1]) put(iron, cyl(0.146, 0.05, x + side * 0.305, 0.172, z + dz, "x", 14), 0x3a3a3a);
    }
    put(iron, tube([[x - 0.36, 0.42, z + 0.66], [x - 0.37, 0.98, z + 0.76], [x, 1.04, z + 0.77], [x + 0.37, 0.98, z + 0.76], [x + 0.36, 0.42, z + 0.66]], 0.016, 18, 5), DARK_IRON);
    prop("crateSmall", x - 0.04, 0.43, z - 0.3, 0.06);
    prop("crateSmall", x + 0.03, 0.43, z + 0.24, -0.08);
    prop("cartonLarge", x - 0.02, 0.87, z - 0.26, 0.3);
  }
  {
    // A tipper tub of furnace coal on the other line, and the baulk that stops it short of the furnace.
    const x = 8.72, z = -17.4, OXIDE = 0x7a3a2c;
    const section = new THREE.Shape();
    section.moveTo(-0.46, 1.02); section.lineTo(-0.15, 0.5); section.lineTo(0.15, 0.5); section.lineTo(0.46, 1.02);
    section.closePath();
    put(paint, new THREE.ExtrudeGeometry(section, { depth: 1.2, bevelEnabled: false }).translate(x, 0, z - 0.6), OXIDE, SOLID);
    for (const end of [-1, 1]) {
      put(paint, box(0.98, 0.05, 0.05, x, 1.02, z + end * 0.6), OXIDE);
      put(paint, beam([x - 0.3, 0.36, z + end * 0.68], [x, 0.8, z + end * 0.68], 0.05), 0x2c2c2c);
      put(paint, beam([x + 0.3, 0.36, z + end * 0.68], [x, 0.8, z + end * 0.68], 0.05), 0x2c2c2c);
      put(iron, cyl(0.02, 0.72, x, 0.172, z + end * 0.4, "x", 6), DARK_IRON);
      for (const side of [-1, 1]) put(iron, cyl(0.146, 0.05, x + side * 0.305, 0.172, z + end * 0.4, "x", 14), 0x3a3a3a);
    }
    for (const side of [-1, 1]) put(paint, box(0.07, 0.1, 1.5, x + side * 0.3, 0.34, z), 0x2c2c2c, SOLID);
    for (let i = 0; i < 9; i += 1) put(slate, new THREE.DodecahedronGeometry(0.13 + random() * 0.09).translate(x + (random() - 0.5) * 0.5, 0.98 + random() * 0.1, z + (i / 8 - 0.5) * 0.95), 0x141416);
    put(timber, box(0.95, 0.2, 0.22, x, 0.1, -14.78), 0x5a4a38);
    for (const side of [-1, 1]) put(iron, box(0.05, 0.26, 0.3, x + side * 0.36, 0.13, -14.74), DARK_IRON);
    // Coal for the furnace, penned with old sleepers against the cabin wall, a shovel stood in it.
    for (const [w, d, px, pz] of [[0.09, 1.6, 8.66, -8.5], [0.86, 0.09, 9.1, -9.3], [0.86, 0.09, 9.1, -7.7]]) put(timber, box(w, 0.72, d, px, 0.36, pz), 0x4f4336, SOLID);
    put(slate, new THREE.ConeGeometry(0.62, 0.5, 9).scale(0.66, 1, 1.15).translate(9.12, 0.5, -8.5), 0x121214);
    for (let i = 0; i < 12; i += 1) put(slate, new THREE.DodecahedronGeometry(0.07 + random() * 0.07).translate(8.78 + random() * 0.66, 0.34 + random() * 0.22, -9.15 + random() * 1.3), 0x161618);
    put(timber, rod([8.9, 0.5, -8.0], [8.75, 1.34, -7.92], 0.018, 6), 0x8a7458);
    put(iron, box(0.2, 0.26, 0.02, 8.92, 0.4, -8.02), 0x4a4d50);
  }
  {
    // The ground frame for the stub-road points: three levers, their rodding away along the foot of the wall.
    const x = 9.12, z = -1.6;
    put(iron, box(0.4, 0.08, 1.06, x, 0.04, z), DARK_IRON, SOLID);
    put(iron, box(0.3, 0.26, 0.94, x, 0.2, z), 0x363a3d, SOLID);
    [0x9a2018, 0x1f4f8a, 0x161616].forEach((colour, index) => {
      const lz = z - 0.3 + index * 0.3, lean = index === 1 ? 0.22 : -0.26, tx = x + Math.sin(lean) * 1.18, ty = 0.24 + Math.cos(lean) * 1.18;
      put(paint, beam([x, 0.24, lz], [x + Math.sin(lean) * 0.94, 0.24 + Math.cos(lean) * 0.94, lz], 0.05, 0.03), colour, SOLID);
      put(iron, rod([x + Math.sin(lean) * 0.94, 0.24 + Math.cos(lean) * 0.94, lz], [tx, ty, lz], 0.017, 6), 0xc8ccd0);
      put(iron, rod([x + Math.sin(lean) * 0.7 - 0.05, 0.24 + Math.cos(lean) * 0.7, lz + 0.03], [tx - 0.05, ty - 0.08, lz + 0.03], 0.008, 4), 0x9a9da0, FINE);
    });
    sign("frame", 1.0, 0.375, WALL_X - 0.006, 1.95, z, "x-");
    for (const rx of [9.38, 9.46]) put(iron, rod([rx, 0.13, z - 0.5], [rx, 0.13, -7.2], 0.014, 5), 0x55585a);
    for (let rz = -2.6; rz > -7.2; rz -= 1.5) put(iron, box(0.22, 0.1, 0.07, 9.42, 0.05, rz), DARK_IRON);
    put(iron, box(0.3, 0.16, 0.42, 9.38, 0.08, -7.36), 0x363a3d);
  }
  {
    // The relay cabinet for the gantry: it clacks whenever a signal changes.
    const x = 9.3, z = 4.05, GREY = 0x8d949a;
    put(concrete, box(0.52, 0.12, 0.86, x, 0.06, z), POURED, SOLID);
    put(paint, box(0.42, 1.5, 0.76, x, 0.87, z), GREY, SOLID);
    put(paint, box(0.52, 0.04, 0.86, x - 0.02, 1.64, z), GREY, SOLID);
    put(iron, box(0.008, 1.38, 0.014, x - 0.212, 0.87, z), 0x1c1c1c);
    for (const dz of [-0.19, 0.19]) {
      for (let i = 0; i < 5; i += 1) put(iron, box(0.012, 0.016, 0.26, x - 0.214, 1.3 + i * 0.045, z + dz), 0x55595c, FINE);
      put(iron, box(0.02, 0.1, 0.024, x - 0.22, 0.86, z + dz * 0.26), 0x1c1c1c);
      for (const y of [0.3, 1.44]) put(iron, box(0.014, 0.08, 0.03, x - 0.214, y, z + dz * 1.92), 0x55595c, FINE);
    }
    sign("relay", 0.5, 0.3, x - 0.214, 1.08, z, "x-");
    lens(new THREE.SphereGeometry(0.016, 8, 6).translate(x - 0.214, 1.55, z + 0.3), 0x38ff8a, 5);
    halo([x - 0.26, 1.55, z + 0.3], 0.28, 0x38ff8a, 0.7);
    // Its cables go up the wall and away along it in conduit.
    put(iron, cyl(0.022, 1.7, 9.5, 2.5, z - 0.26, "y", 6), PIPE);
    for (const y of [3.3, 3.38]) put(iron, rod([9.5, y, z - 0.26], [9.5, y, CABIN.z1 - 0.02], 0.016, 5), PIPE);
    for (let cz = 3.0; cz > CABIN.z1; cz -= 1.25) put(iron, box(0.03, 0.16, 0.04, 9.525, 3.34, cz), DARK_IRON, FINE);
  }
  {
    // A caged ladder up the retaining wall to the yard.
    const z = 1.45;
    for (const dz of [-0.22, 0.22]) put(iron, box(0.05, 5.5, 0.012, 9.4, 2.95, z + dz), PIPE, SOLID);
    for (let y = 0.4; y < 5.6; y += 0.3) put(iron, cyl(0.012, 0.44, 9.4, y, z, "z", 5), PIPE);
    for (const y of [1.2, 2.6, 4.0]) put(iron, box(0.14, 0.03, 0.5, 9.47, y, z), DARK_IRON, FINE);
    for (let y = 2.5; y < 5.7; y += 0.76) put(iron, new THREE.TorusGeometry(0.36, 0.012, 4, 14, PI * 1.15).rotateX(PI / 2).rotateY(PI * 0.5 + PI * 0.575).translate(9.3, y, z), PIPE);
    for (const a of [-0.9, 0, 0.9]) put(iron, box(0.02, 3.3, 0.006, 9.3 - Math.cos(a) * 0.36, 4.05, z + Math.sin(a) * 0.36), PIPE, FINE);
  }
  {
    // Fire buckets on their board (west), and the stuck door of the depot behind the firing line.
    for (const z of [-1.95, -1.5, -1.05]) {
      put(paint, new THREE.CylinderGeometry(0.15, 0.1, 0.26, 12).translate(-WALL_X + 0.19, 1.26, z), 0xa8281c, SOLID);
      put(iron, new THREE.TorusGeometry(0.13, 0.008, 4, 10, PI).rotateY(PI / 2).translate(-WALL_X + 0.19, 1.39, z), DARK_IRON, FINE);
      put(iron, box(0.14, 0.02, 0.02, -WALL_X + 0.07, 1.54, z), DARK_IRON, FINE);
    }
    put(timber, box(0.03, 0.14, 1.4, -WALL_X + 0.015, 1.56, -1.5), 0x6a5a48);
    sign("fire", 0.5, 0.5, -WALL_X + 0.006, 2.2, -1.5, "x+");
    const dx = -8.3, GREEN = 0x5d6f5c;
    put(timber, box(2.4, 2.7, 0.06, dx, 1.37, BACK_Z - 0.05), GREEN, SOLID);
    for (const y of [0.22, 1.37, 2.56]) put(timber, box(2.4, 0.14, 0.03, dx, y, BACK_Z - 0.095), GREEN);
    for (const side of [-1, 1]) {
      put(timber, beam([dx + side * 1.13, 0.3, BACK_Z - 0.095], [dx + side * 0.07, 1.3, BACK_Z - 0.095], 0.12, 0.03), GREEN);
      put(timber, beam([dx + side * 0.07, 1.44, BACK_Z - 0.095], [dx + side * 1.13, 2.48, BACK_Z - 0.095], 0.12, 0.03), GREEN);
      put(iron, cyl(0.07, 0.03, dx + side * 0.8, 2.86, BACK_Z - 0.1, "z", 10), DARK_IRON);
      put(iron, box(0.05, 0.22, 0.012, dx + side * 0.8, 2.74, BACK_Z - 0.105), DARK_IRON);
    }
    put(iron, box(3.3, 0.05, 0.07, dx + 0.4, 2.93, BACK_Z - 0.08), DARK_IRON);
    put(iron, box(0.1, 0.16, 0.05, dx + 1.1, 1.2, BACK_Z - 0.12), 0x7a6a3a);
    sign("doorStuck", 0.9, 0.45, dx, 1.74, BACK_Z - 0.112, "z-");
  }
  // A bulkhead lamp over the stuck door; a steam trap venting up the wall by the cabin.
  put(paint, box(0.3, 0.16, 0.12, -8.3, 3.3, BACK_Z - 0.06), 0x2c2c2c);
  lens(box(0.24, 0.1, 0.05, -8.3, 3.3, BACK_Z - 0.14), WARM, 3);
  halo([-8.3, 3.3, BACK_Z - 0.22], 1.2, WARM, 0.7);
  // ... and its twin over the notices in the other corner.
  put(paint, box(0.3, 0.16, 0.12, 8, 4.2, BACK_Z - 0.06), 0x2c2c2c);
  put(iron, cyl(0.012, 2.9, 8.19, 5.65, BACK_Z - 0.02, "y", 5), DARK_IRON, FINE);
  lens(box(0.24, 0.1, 0.05, 8, 4.2, BACK_Z - 0.14), WARM, 3);
  halo([8, 4.2, BACK_Z - 0.22], 1.2, WARM, 0.7);
  put(iron, cyl(0.03, 4.5, 9.48, 2.45, -6.18, "y", 7), 0x4a4038);
  put(iron, tube([[9.48, 4.7, -6.18], [9.47, 4.84, -6.18], [9.36, 4.9, -6.18]], 0.03, 6, 7), 0x4a4038);
  for (const y of [0.9, 2.4, 3.9]) put(iron, box(0.1, 0.03, 0.12, 9.5, y, -6.18), DARK_IRON, FINE);
  put(iron, cyl(0.07, 0.14, 9.48, 1.3, -6.18, "y", 8), 0x7a2a1c);
  // Notices: enamel on the walls wherever the range leaves them bare.
  sign("beware", 1.5, 0.88, -WALL_X + 0.006, 2.15, -5.2, "x+");
  sign("speed", 0.55, 0.7, -WALL_X + 0.006, 2.1, -3.85, "x+");
  sign("stop", 0.5, 0.64, -WALL_X + 0.006, 1.85, -7.6, "x+");
  sign("eco", 0.9, 0.49, -WALL_X + 0.006, 2.1, 1.85, "x+");
  sign("planting", 1.2, 0.47, -WALL_X + 0.006, 2.25, 8.1, "x+");
  sign("shunting", 1.3, 0.51, -WALL_X + 0.006, 2.3, -21.9, "x+");
  sign("furnace", 1.3, 0.51, WALL_X - 0.006, 2.2, -8.2, "x-");
  sign("private", 1.3, 0.76, WALL_X - 0.006, 2.2, -5.0, "x-");
  sign("corners", 1.2, 0.47, WALL_X - 0.006, 2.2, 6.7, "x-");
  sign("loss", 0.55, 0.7, 7.0, 2.15, BACK_Z - 0.006, "z-");
  sign("cases", 0.72, 0.9, 7.95, 2.15, BACK_Z - 0.006, "z-");
  sign("forceBuy", 1.24, 0.44, 8.7, 3.1, BACK_Z - 0.006, "z-");
  // A bucket under the one sheet of the tin roof that lets water through.
  put(iron, new THREE.CylinderGeometry(0.16, 0.115, 0.27, 12, 1, true).translate(7.9, 0.135, 6.3), 0x6a6f72);
  put(iron, new THREE.CircleGeometry(0.14, 12).rotateX(-PI / 2).translate(7.9, 0.22, 6.3), 0x15191c);


  // ---- Props -----------------------------------------------------------------
  prop("pallet", 8.55, 0, 8.6, 0.06);
  prop("crateLarge", 8.55, 0.145, 8.62, 0.1);
  prop("crateSmall", 8.5, 0.985, 8.6, 0.5);
  prop("drum", 7.5, 0, 9.0, 0.4, { tint: 0x7a2a1c });
  prop("drum", 6.86, 0, 9.12, 1.9, { tint: 0x2f4a5c });
  prop("pallet", -7.5, 0, 8.95, 1.52);
  prop("sack", -7.6, 0.145, 9.0, 0.3);
  prop("sack", -7.2, 0.145, 8.8, 1.2);
  prop("sackLying", -7.45, 0.42, 8.92, 0.8);

  // ---- Things that hang and swing --------------------------------------------------
  // The road's nameboard on two rods under the girder, and a chain hoist on the girder by the downpipe.
  const DARK_CELL = atlas.cells.get("dark")!, girderFoot = TIN.low - 0.45;
  const hang = (parts: Part[], material: THREE.Material, x: number, z: number) => {
    const mesh = new THREE.Mesh(assemble(parts), material);
    mesh.position.set(x, girderFoot, z);
    mesh.userData.walkThrough = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    return mesh;
  };
  const board: Part[] = [
    [cellUv(box(1.9, 0.56, 0.03, 0, -0.74, 0), DARK_CELL), 0xffffff],
    [cellUv(quad(1.86, 0.52, 0, -0.74, 0.018, "z+"), atlas.cells.get("road")!), 0x9a9a9a],
    [cellUv(quad(1.86, 0.52, 0, -0.74, -0.018, "z-"), atlas.cells.get("road")!), 0x9a9a9a],
  ];
  for (const x of [-0.8, 0.8]) board.push([cellUv(box(0.016, 0.48, 0.016, x, -0.23, 0), DARK_CELL), 0xffffff]);
  const nameboard = life.sway(hang(board, plates, 4.6, TIN.front), { amplitude: 0.09, period: 1.8, axis: "x", creak: "signCreak", damping: 0.1 });
  const links: Part[] = [[box(0.2, 0.3, 0.15, 0, -0.17, 0), 0x8a6a1e], [cyl(0.11, 0.05, 0, -0.17, 0.09, "z", 12), DARK_IRON], [box(0.06, 0.12, 0.05, 0.03, -2.2, 0), DARK_IRON]];
  for (let i = 0; i < 26; i += 1) links.push([new THREE.TorusGeometry(0.024, 0.006, 4, 8).rotateY(i % 2 ? PI / 2 : 0).translate(0.03, -0.36 - i * 0.07, 0), 0x6a6e70]);
  for (let i = 0; i < 17; i += 1) links.push([new THREE.TorusGeometry(0.018, 0.005, 4, 8).rotateY(i % 2 ? PI / 2 : 0).translate(-0.08, -0.34 - i * 0.055, 0.02), 0x55595c]);
  links.push([new THREE.TorusGeometry(0.06, 0.015, 5, 10, PI * 1.45).rotateZ(-PI * 0.95).translate(0.03, -2.31, 0), DARK_IRON]);
  const hoist = life.sway(hang(links, iron, -7.3, TIN.front + 0.02), { amplitude: 0.06, period: 3, axis: "both", creak: "chainRattle" });

  // ---- Furnace ---------------------------------------------------------------
  // The flue stands in the floodlight: a sooted zinc that does not flare like polished duct.
  const flueMetal = new THREE.MeshStandardMaterial({ color: 0x5d6466, metalness: 0.5, roughness: 0.7, envMapIntensity: 0.5 });
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: flueMetal }, 4.6);

  // ---- Everything gathered above, drawn -------------------------------------------
  for (const [kind, items] of placed) props.place(kind, items, { seed: 11 });
  kit.instances(box(2.5, 0.14, 0.24), timber, sleepers, false, false);
  flush();

  // Halos: one patch per lamp, turned to the eye. Rain does to them what it does to a real lamp: further off the
  // glow is wider and weaker.
  const haloPlace = new Float32Array(halos.length * 4), haloTint = new Float32Array(halos.length * 4);
  halos.forEach((entry, index) => {
    haloPlace.set([...entry.at, entry.size], index * 4);
    tone.set(entry.colour).multiplyScalar(entry.gain);
    haloTint.set([tone.r, tone.g, tone.b, entry.blink ?? 0], index * 4);
  });
  const haloPlaces = new THREE.InstancedBufferAttribute(haloPlace, 4), haloTints = new THREE.InstancedBufferAttribute(haloTint, 4);
  {
    const geometry = new THREE.InstancedBufferGeometry();
    const rim = Array.from({ length: 8 }, (_, corner) => [Math.cos((corner + 0.5) * PI / 4) * 0.54, Math.sin((corner + 0.5) * PI / 4) * 0.54, 0]).flat();
    geometry.setIndex(Array.from({ length: 8 }, (_, corner) => [0, corner + 1, (corner + 1) % 8 + 1]).flat());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, ...rim], 3));
    geometry.setAttribute("halo", haloPlaces);
    geometry.setAttribute("tint", haloTints);
    geometry.instanceCount = halos.length;
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), yardTime: clock },
      vertexShader: /* glsl */`
        attribute vec4 halo;
        attribute vec4 tint;
        uniform float yardTime, fogDensity;
        varying vec2 vAt;
        varying vec3 vTint;
        void main() {
          vec4 centre = viewMatrix * vec4(halo.xyz, 1.0);
          float range = length(centre.xyz);
          float spread = 1.0 + range * 0.03;
          float clear = exp(-pow(fogDensity * range, 2.0) * 0.4);
          centre.xyz -= normalize(centre.xyz) * min(halo.w * 0.3, range * 0.5);
          centre.xy += position.xy * halo.w * spread;
          vAt = position.xy * 2.0;
          float pulse = tint.a > 0.0 ? 0.25 + 0.75 * smoothstep(0.2, 0.9, sin(yardTime * tint.a)) : 1.0;
          vTint = tint.rgb * clear * pulse * smoothstep(0.3, 1.6, range) / sqrt(spread);
          gl_Position = projectionMatrix * centre;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vAt;
        varying vec3 vTint;
        void main() {
          float r = length(vAt);
          float glow = pow(max(0.0, 1.0 - r), 2.6) * 0.4 + exp(-r * r * 30.0) * 0.9;
          // Wet air and a wet lens pull the glare out sideways.
          glow += exp(-vAt.y * vAt.y * 900.0) * pow(max(0.0, 1.0 - abs(vAt.x)), 3.0) * 0.16;
          gl_FragColor = vec4(vTint * glow, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.name = "halos";
    scene.add(mesh);
    kit.probeHidden.push(mesh);
  }
  // Cones: the rain lit up under the masts and the big lamps.
  if (cones.length) {
    const mesh = new THREE.Mesh(mergeGeometries(cones), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true, vertexColors: true, side: THREE.DoubleSide,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), yardTime: clock },
      vertexShader: /* glsl */`
        uniform float fogDensity;
        varying vec3 vTint, vNormalView, vView, vWorld;
        varying vec2 vUv;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec4 seen = viewMatrix * world;
          vNormalView = normalize(normalMatrix * normal);
          vView = -seen.xyz;
          vTint = color * exp(-pow(fogDensity * length(seen.xyz), 2.0) * 0.5);
          vUv = uv; vWorld = world.xyz;
          gl_Position = projectionMatrix * seen;
        }`,
      fragmentShader: /* glsl */`
        uniform float yardTime;
        varying vec3 vTint, vNormalView, vView, vWorld;
        varying vec2 vUv;
        void main() {
          float facing = abs(dot(normalize(vNormalView), normalize(vView)));
          float streak = fract(sin(dot(floor(vec2(vUv.x * 220.0, vWorld.y * 1.6 + yardTime * 13.0 + floor(vUv.x * 220.0) * 0.37)), vec2(12.9898, 78.233))) * 43758.5453);
          float body = pow(facing, 1.7) * (0.25 * vUv.y + 0.75 * vUv.y * vUv.y) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
          gl_FragColor = vec4(vTint * body * (0.75 + 0.5 * streak), 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    mesh.renderOrder = 3;
    mesh.userData.walkThrough = true;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  }

  // ---- Sky -------------------------------------------------------------------
  // No picture: a low overcast that the yard's own lamps stain from below, dissolving into the fog colour at the horizon.
  {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 14, 0, PI * 2, 0, PI * 0.55), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: true,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), yardTime: clock },
      vertexShader: /* glsl */`
        varying vec3 vSky;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vSky = world.xyz - vec3(0.0, 1.6, -9.0);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */`
        uniform float yardTime;
        uniform vec3 fogColor;
        varying vec3 vSky;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += noise(p) * a; p = p * 2.03 + 11.7; a *= 0.5; } return s / 0.9375; }
        void main() {
          vec3 dir = normalize(vSky);
          float up = max(dir.y, 0.0);
          vec2 sheet = dir.xz / (up + 0.2) + vec2(0.012, -0.03) * yardTime;
          float cloud = fbm(sheet * 0.7) * 0.65 + fbm(sheet * 2.3 + 4.0) * 0.35;
          vec3 colour = fogColor * mix(0.55, 1.45, smoothstep(0.3, 0.72, cloud));
          // The yard's lamps on the underside of the cloud: sodium low toward the far end, cold over the key mast.
          float low = pow(1.0 - up, 3.0);
          colour += vec3(1.0, 0.5, 0.2) * 0.05 * low * (0.35 + 0.65 * smoothstep(-0.2, 0.9, -dir.z)) * (0.5 + cloud);
          colour += vec3(0.6, 0.75, 1.0) * 0.035 * pow(max(dot(dir, normalize(vec3(-0.34, 0.36, 0.86))), 0.0), 6.0) * (0.4 + cloud);
          gl_FragColor = vec4(mix(colour, fogColor, exp(-pow(up * 3.4, 1.5))), 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    dome.scale.set(285, 120, 285);
    dome.position.set(0, -6, -9);
    dome.renderOrder = 1;
    dome.frustumCulled = false;
    dome.userData.walkThrough = true;
    scene.add(dome);
  }

  // ---- Light -----------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x3d4a66, 0x17150f, 1.0));
  const sun = kit.sunLight({ color: 0xcfe0ff, intensity: 5, toSun: TO_SUN, extent: 34, distance: 58, near: 4, far: 120, radius: 2 });
  const lamp = (colour: number, intensity: number, reach: number, x: number, y: number, z: number) => {
    const light = new THREE.PointLight(colour, intensity, reach, 2);
    light.position.set(x, y, z);
    scene.add(light);
    return light;
  };
  // Four real lamps for what the practicals' shader cannot reach (props, the furniture of the range, whoever walks in).
  const fills = [
    // (The two under the tin roof stand hard against the back wall, so that their glint in the chart's glass falls outside it.)
    lamp(WARM, 64, 17, -8.3, 3.6, 9.05),
    lamp(WARM, 64, 17, 8, 4.2, 9.05),
    lamp(SODIUM, 80, 20, -8.2, 5.9, -14),
    lamp(COLD, 60, 18, 8.2, 5.3, -3.6),
  ];

  // ---- Rain ------------------------------------------------------------------
  // Streaks falling on the wind through a box that follows the eye. They are drawn additively and take their
  // light from the lamps, so the rain is seen where a lamp finds it and nowhere else.
  type RainLamp = { at: V3; colour: number; power: number; fall: number };
  const rainLamps: RainLamp[] = [
    ...LAMPS.slice(0, 10).map((entry) => ({ at: entry.at, colour: entry.colour, power: entry.power * 0.04, fall: 0.2 })),
    ...masts.slice(1, 5).map(([x, z, h, colour]) => ({ at: [x, YARD + h, z] as V3, colour, power: 2.6, fall: 0.004 })),
    { at: [LOCO.x, locoY + 4.1, noseZ + 4] as V3, colour: 0xfff0d2, power: 1.6, fall: 0.012 },
  ];
  const rainUniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    yardTime: clock, viewHeight,
    rainSlant: { value: new THREE.Vector2(...SLANT) },
    rainFrom: { value: TO_SUN },
    rainKey: { value: new THREE.Color(0xcfe0ff).multiplyScalar(0.5) },
    rainLampAt: { value: rainLamps.map((entry) => new THREE.Vector4(...entry.at, entry.fall)) },
    rainLampTint: { value: rainLamps.map((entry) => new THREE.Color(entry.colour).multiplyScalar(entry.power)) },
  };
  const RAIN_LIGHT = /* glsl */`
    uniform vec4 rainLampAt[${rainLamps.length}];
    uniform vec3 rainLampTint[${rainLamps.length}];
    uniform vec3 rainKey, rainFrom;
    uniform float fogDensity;
    ${SHELTER_GLSL}
    vec3 rainLight(vec3 p, vec3 toEye, float away) {
      vec3 sum = vec3(0.012, 0.015, 0.02);
      for (int i = 0; i < ${rainLamps.length}; i++) {
        vec3 d = rainLampAt[i].xyz - p;
        sum += rainLampTint[i] * smoothstep(-0.6, 0.6, d.y) / (1.0 + dot(d, d) * rainLampAt[i].w);
      }
      // Rain between the eye and the key mast is back-lit and bright; with the mast behind you it barely shows.
      float toward = max(dot(-toEye / away, rainFrom), 0.0);
      sum += rainKey * (0.1 + 1.5 * pow(toward, 5.0));
      return sum * exp(-pow(fogDensity * away, 2.0) * 0.5);
    }`;
  const rain = (count: number, size: V3, length: number, width: number, gain: number) => {
    const geometry = streakGeometry(count), seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i += 1) seeds[i] = Math.random();
    geometry.setAttribute("seed", new THREE.InstancedBufferAttribute(seeds, 4));
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true,
      uniforms: { ...rainUniforms, rainBox: { value: new THREE.Vector3(...size) }, rainLook: { value: new THREE.Vector3(length, width, gain) } },
      vertexShader: /* glsl */`
        attribute vec4 seed;
        uniform float yardTime, viewHeight;
        uniform vec3 rainBox, rainLook;
        uniform vec2 rainSlant;
        varying vec3 vTint;
        varying vec2 vAt;
        ${RAIN_LIGHT}
        void main() {
          float speed = 7.5 + seed.w * 3.5;
          float fallen = mod(seed.y * rainBox.y + yardTime * speed, rainBox.y);
          vec2 at = seed.xz * rainBox.xz + rainSlant * fallen;
          at = cameraPosition.xz + mod(at - cameraPosition.xz + 0.5 * rainBox.xz, rainBox.xz) - 0.5 * rainBox.xz;
          vec3 fall = normalize(vec3(rainSlant.x, -1.0, rainSlant.y));
          vec3 head = vec3(at.x, rainBox.y - fallen, at.y), tail = head - fall * rainLook.x * (0.6 + 0.7 * seed.w);
          vec3 centre = (head + tail) * 0.5, toEye = cameraPosition - centre;
          float away = length(toEye);
          float pixel = 2.0 * away / (projectionMatrix[1][1] * viewHeight);
          float width = max(rainLook.y, pixel * 1.25);
          vec3 world = mix(tail, head, position.y) + normalize(cross(fall, toEye)) * position.x * width;
          float shown = (1.0 - yardShelter(centre)) * smoothstep(0.5, 1.8, away) * smoothstep(rainBox.x * 0.5, rainBox.x * 0.36, away);
          vTint = rainLight(centre, toEye, away) * rainLook.z * (rainLook.y / width) * shown * (0.45 + 0.55 * seed.w);
          vAt = position.xy;
          gl_Position = shown > 0.0 ? projectionMatrix * viewMatrix * vec4(world, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: streakFragment,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.userData.walkThrough = true;
    mesh.name = "rain";
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  };
  rain(high ? 5200 : 2000, [28, 14, 28], 0.55, 0.005, 1.2);
  rain(high ? 4200 : 1400, [76, 30, 76], 1.3, 0.014, 1.4);

  // Water coming off edges: each drip a streak that falls from rest, lands, and forms again. The gutter of the
  // tin roof runs over all along its length; the shed canopy and the cabin eaves drip into the lane; the downpipe
  // throws its water out across the ground; one sheet of the tin leaks into a bucket.
  type Drip = { from: V3; every: number; floor?: number; width?: number; kick?: [number, number]; streak?: number; phase?: number };
  const LEAK = { at: [7.9, tinY(6.3) - 0.01, 6.3] as V3, every: 4.6, phase: 0.3, fall: Math.sqrt((tinY(6.3) - 0.23) / 4.9) };
  const drips: Drip[] = [{ from: LEAK.at, every: LEAK.every, phase: LEAK.phase, floor: 0.22, width: 0.013 }];
  const gutterY = tinY(TIN.front - 0.42) - 0.03, gutterZ = TIN.front - 0.59;
  for (let x = -9.4; x <= 9.4; x += high ? 0.29 : 0.6) drips.push({ from: [x + (random() - 0.5) * 0.2, gutterY, gutterZ], every: 0.45 + random() * 1.3 });
  for (let z = FAR_Z + 0.3; z < SHED.z1; z += high ? 0.42 : 0.9) drips.push({ from: [SHED.edge + 0.02, SHED.edgeY - 0.36, z + random() * 0.3], every: 0.7 + random() * 1.8 });
  for (let z = CABIN.z0 - 0.3; z < CABIN.z1 + 0.3; z += high ? 0.36 : 0.8) drips.push({ from: [WALL_X - 0.45, CABIN.eaves - 0.08, z + random() * 0.2], every: 0.8 + random() * 1.6, floor: z > -13.5 && z < -9.7 ? 3.6 : 0 });
  for (let i = 0; i < (high ? 56 : 28); i += 1) drips.push({ from: [-9.07 + (random() - 0.5) * 0.07, 0.45 + (random() - 0.5) * 0.06, TIN.front - 0.38], every: 0.3 + random() * 0.08, kick: [0.1 + (random() - 0.5) * 0.5, -1.3 - random() * 0.7], width: 0.02, streak: 0.07 });
  {
    const count = drips.length, geometry = streakGeometry(count), from = new Float32Array(count * 3), aux = new Float32Array(count * 4), kick = new Float32Array(count * 3);
    drips.forEach((drip, index) => {
      from.set(drip.from, index * 3);
      aux.set([drip.every, drip.phase ?? random(), drip.floor ?? 0, drip.width ?? 0.007], index * 4);
      kick.set([drip.kick?.[0] ?? 0, drip.kick?.[1] ?? 0, drip.streak ?? 0.035], index * 3);
    });
    geometry.setAttribute("from", new THREE.InstancedBufferAttribute(from, 3));
    geometry.setAttribute("aux", new THREE.InstancedBufferAttribute(aux, 4));
    geometry.setAttribute("kick", new THREE.InstancedBufferAttribute(kick, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true,
      uniforms: { ...rainUniforms, dripGain: { value: 0.7 } },
      vertexShader: /* glsl */`
        attribute vec3 from;
        attribute vec4 aux;
        attribute vec3 kick;
        uniform float yardTime, viewHeight, dripGain;
        varying vec3 vTint;
        varying vec2 vAt;
        ${RAIN_LIGHT}
        void main() {
          float t = fract(yardTime / aux.x + aux.y) * aux.x;
          float landed = sqrt(max(from.y - aux.z, 0.0) / 4.9);
          vec3 velocity = vec3(kick.x, -9.8 * t - 0.4, kick.y);
          vec3 head = from + vec3(kick.x * t, -4.9 * t * t, kick.y * t);
          vec3 tail = head - velocity * kick.z;
          tail.y = min(tail.y, from.y);
          vec3 centre = (head + tail) * 0.5, toEye = cameraPosition - centre;
          float away = length(toEye);
          float pixel = 2.0 * away / (projectionMatrix[1][1] * viewHeight);
          float width = max(aux.w, pixel * 1.2);
          vec3 world = mix(tail, head, position.y) + normalize(cross(normalize(velocity), toEye)) * position.x * width;
          float shown = step(t, landed) * smoothstep(0.7, 3.0, away);
          vTint = rainLight(centre, toEye, away) * dripGain * (aux.w / width) * shown;
          vAt = position.xy;
          gl_Position = shown > 0.0 ? projectionMatrix * viewMatrix * vec4(world, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: streakFragment,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.userData.walkThrough = true;
    mesh.name = "drips";
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  }
  {
    // Where the rain lands: a flash and a ring, somewhere new each time.
    const spots: number[] = [], forms: number[] = [];
    for (let i = 0; i < (high ? 300 : 110); i += 1) {
      spots.push(-9.4 + random() * 18.8, FAR_Z + 0.2 + random() * (TIN.front - 0.9 - FAR_Z), 0.45 + random() * 0.7, random());
      forms.push(1.4, 0.13 + random() * 0.12);
    }
    for (let i = 0; i < 12; i += 1) {
      spots.push(-8.98 + (random() - 0.5) * 0.36, TIN.front - 0.85 + (random() - 0.5) * 0.4, 0.2 + random() * 0.2, random());
      forms.push(0.3, 0.22 + random() * 0.22);
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 2, 1, 2, 3, 1]);
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5], 3));
    geometry.setAttribute("spot", new THREE.InstancedBufferAttribute(new Float32Array(spots), 4));
    geometry.setAttribute("form", new THREE.InstancedBufferAttribute(new Float32Array(forms), 2));
    geometry.instanceCount = spots.length / 4;
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true, side: THREE.DoubleSide,
      uniforms: { ...rainUniforms, ringGain: { value: 0.3 } },
      vertexShader: /* glsl */`
        attribute vec4 spot;
        attribute vec2 form;
        uniform float yardTime, ringGain;
        varying vec3 vTint;
        varying vec2 vAt;
        varying float vAge;
        ${RAIN_LIGHT}
        float ringHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          float beat = yardTime / spot.z + spot.w, n = floor(beat), t = fract(beat);
          vec2 centre = spot.xy + (vec2(ringHash(vec2(n, spot.w * 91.7)), ringHash(vec2(spot.w * 37.3, n))) - 0.5) * form.x;
          float radius = form.y * (0.25 + 0.75 * sqrt(t));
          vec3 world = vec3(centre.x + position.x * radius, 0.014, centre.y + position.z * radius);
          vec3 toEye = cameraPosition - world;
          float away = length(toEye);
          vAt = position.xz * 2.0;
          vAge = t;
          vTint = rainLight(vec3(centre.x, 0.4, centre.y), toEye, away) * ringGain * (1.0 - t) * (1.0 - t);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vTint;
        varying vec2 vAt;
        varying float vAge;
        void main() {
          float r = length(vAt);
          float ring = smoothstep(0.42, 0.0, abs(r - 0.56)) * 0.6 + smoothstep(0.45, 0.0, r) * smoothstep(0.22, 0.0, vAge) * 3.0;
          gl_FragColor = vec4(vTint * ring, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.userData.walkThrough = true;
    mesh.name = "rings";
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  }

  // ---- Things that happen --------------------------------------------------------
  const beat = { began: -1, change: 9, gustWas: 0, gustHeard: -100, drop: -1, surge: 14 };
  const aspects = HEADS.map((x) => (x === LOCO.x || x === 7 ? 0 : x === 0 ? 2 : 1));
  const showAspect = (head: number) => {
    for (let aspect = 0; aspect < 3; aspect += 1) aspectLens.setColorAt(head * 3 + aspect, aspect === aspects[head] ? tone.copy(ASPECTS[aspect]).multiplyScalar(7) : tone.setRGB(0.012, 0.012, 0.012));
    aspectLens.instanceColor!.needsUpdate = true;
    const colour = ASPECTS[aspects[head]], slot = aspectHalo[head] * 4;
    haloPlace[slot + 1] = headY(aspects[head]);
    haloTint.set([colour.r * 2.2, colour.g * 2.2, colour.b * 2.2], slot);
    haloPlaces.needsUpdate = true; haloTints.needsUpdate = true;
  };
  HEADS.forEach((_, head) => showAspect(head));
  const drawing = new THREE.Vector2();
  kit.updates.push((now) => {
    const seconds = now / 1000;
    clock.value = seconds % 3600;
    viewHeight.value = kit.renderer.getDrawingBufferSize(drawing).y;
    if (beat.began < 0) beat.began = seconds;
    const since = seconds - beat.began;

    // The gantry: a road is cleared or put back to danger, and the relays in the cabinet by the firing line answer.
    if (since > beat.change) {
      beat.change = since + 9 + chance() * 16;
      // The diesel's road stays at danger; of the others, one that has stood at danger longest is the likeliest to clear.
      const free = HEADS.map((x, head) => head).filter((head) => HEADS[head] !== LOCO.x), held = free.filter((head) => aspects[head] === 0);
      const from = held.length > 1 && chance() < 0.7 ? held : free, head = from[Math.floor(chance() * from.length)];
      aspects[head] = aspects[head] === 0 ? (chance() < 0.4 ? 1 : 2) : aspects[head] === 1 ? (chance() < 0.6 ? 2 : 0) : (chance() < 0.5 ? 1 : 0);
      showAspect(head);
      say("relayClack", 9.05, 1.2, 4.05, 0.8, 0.9 + chance() * 0.2);
    }

    // The diesel's headlight breathes with the engine.
    const idle = 0.9 + 0.06 * Math.sin(seconds * 9.4) + 0.04 * Math.sin(seconds * 23.1);
    haloTint.set([9 * idle, 8.4 * idle, 7.2 * idle], headlight * 4);
    haloTints.needsUpdate = true;

    // A gust front reaching the player is heard coming from upwind.
    const gust = wind.at(0, 0);
    if (gust > 0.5 && beat.gustWas <= 0.5 && since - beat.gustHeard > 9) {
      beat.gustHeard = since;
      say("windGust", wind.direction.x * -12, 4, wind.direction.y * -12, 0.5 + gust * 0.4, 0.9 + chance() * 0.2);
      // ... and the tin roof shifts on its purlins, and what hangs from the girder is set swinging.
      if (chance() < 0.7) say("metalCreak", (chance() - 0.5) * 14, 5.6, 5.6, 0.35 + gust * 0.3, 0.85 + chance() * 0.3);
      nameboard.kick(0.2 + chance() * 0.2);
      hoist.kick(0.12 + chance() * 0.12);
    }
    beat.gustWas = gust;

    // The leak over the right-hand end of the firing line lands in its bucket.
    const drop = Math.floor((clock.value - LEAK.fall) / LEAK.every + LEAK.phase);
    if (drop !== beat.drop) {
      if (beat.drop >= 0) say("drip", LEAK.at[0], 0.3, LEAK.at[2], 0.35, 0.9 + chance() * 0.25);
      beat.drop = drop;
    }
    // Now and then the gutter sends a slug of water down the pipe.
    if (since > beat.surge) {
      beat.surge = since + 22 + chance() * 26;
      say("splash", -9.0, 0.3, TIN.front - 0.6, 0.4, 0.9 + chance() * 0.2);
    }
  });

  // Exhaust from the diesel's stacks, smoke from the furnace flue and the cabin stove.
  life.plume("smoke", [[LOCO.x, locoY + 4.6, LOCO.z - 1.2], [LOCO.x, locoY + 4.6, LOCO.z + 0.3]], { rise: 7, size: [0.4, 3.2], color: 0x3a3d42, opacity: 0.6, lean: 8, density: 16 });
  life.plume("smoke", [9.28, 8.6, -12.65], { rise: 5, size: [0.5, 2.4], color: 0x4a4744, opacity: 0.5, lean: 6 });
  life.plume("smoke", [CABIN.x1 - 0.7, CABIN.ridge + 0.9, CABIN.z1 - 1.6], { rise: 3, size: [0.2, 1.3], color: 0x6a6a6c, opacity: 0.35, lean: 4, density: 9 });
  // Steam from the diesel's train-heating boiler drifts across its nose; mist lies in the lane.
  life.plume("steam", [LOCO.x - 1.2, locoY + 0.9, LOCO.z + 7.6], { rise: 3.4, size: [0.4, 2.6], opacity: 0.4, lean: 5, glow: 0x2a251c });
  life.drift("dust", { volume: { x: [-9.3, 9.3], y: [0, 1.5], z: [FAR_Z + 0.5, 1.5] }, count: 30, colors: [0x8fa0b8], scale: 3.2, opacity: 1 });
  // The steam trap by the cabin blows off; the diesel's compressor unloads with a sigh of air.
  life.plume("steam", [9.34, 4.92, -6.18], { rise: 2.2, size: [0.12, 1.1], opacity: 0.5, burst: { every: 34, length: 2.2 } });
  life.plume("steam", [LOCO.x + 1.4, locoY + 0.7, LOCO.z + 5.2], { rise: 1.8, size: [0.2, 1.5], opacity: 0.45, burst: { every: 58, length: 1.3 }, cue: "trainBrake" });

  // The well-glass fitting at the far end of the retaining wall is failing: it strikes, holds, drops out.
  {
    const lens = new THREE.Color(COLD).multiplyScalar(4.2), glare = new THREE.Color(COLD), wet = rainUniforms.rainLampTint.value[FAILING].clone();
    life.flicker((level) => {
      lampTint.value[FAILING].copy(lampFull[FAILING]).multiplyScalar(level);
      rainUniforms.rainLampTint.value[FAILING].copy(wet).multiplyScalar(level);
      failing.lens.material.color.copy(lens).multiplyScalar(0.03 + 0.97 * level);
      haloTint.set([glare.r * level, glare.g * level, glare.b * level], failing.halo * 4);
      haloTints.needsUpdate = true;
    }, "tube", { at: LAMPS[FAILING].at });
  }

  // Crows roosting out of the rain on the wall top under the shed canopy: a shot sends them up.
  life.birds("crow", {
    perches: [{ from: [-9.66, WALL_TOP, -12.9], to: [-9.66, WALL_TOP, -7.4] }, { from: [-9.66, WALL_TOP, -18.9], to: [-9.66, WALL_TOP, -15.0] }],
    count: 5,
    roam: { x: [-8, 8], y: [6.5, 12], z: [-24, -2] },
  });

  const sunlit = sunlitFromBoxes(TO_SUN, [
    new THREE.Box3(new THREE.Vector3(DEPOT.x0, 0, BACK_Z), new THREE.Vector3(DEPOT.x1, DEPOT.top + 1.5, DEPOT.z1)),
    new THREE.Box3(new THREE.Vector3(-9.9, tinY(TIN.front), TIN.front - 0.4), new THREE.Vector3(9.9, tinY(TIN.front) + 0.3, 5.4)),
    new THREE.Box3(new THREE.Vector3(-9.9, tinY(5.4), 5.4), new THREE.Vector3(9.9, tinY(5.4) + 0.3, 7.6)),
    new THREE.Box3(new THREE.Vector3(-9.9, tinY(7.6), 7.6), new THREE.Vector3(9.9, tinY(7.6) + 0.3, BACK_Z)),
    new THREE.Box3(new THREE.Vector3(SHED.x0, SHED.edgeY, SHED.z0), new THREE.Vector3(SHED.edge, SHED.eaves + 1, SHED.z1)),
    new THREE.Box3(new THREE.Vector3(WEST_ROAD - 1.5, RAIL + 1, -28.3), new THREE.Vector3(WEST_ROAD + 1.5, RAIL + 4.3, 10.5)),
    new THREE.Box3(new THREE.Vector3(-10.1, 0, FAR_Z), new THREE.Vector3(-WALL_X, WALL_TOP, BACK_Z)),
    new THREE.Box3(new THREE.Vector3(WALL_X, 0, CABIN.z0), new THREE.Vector3(CABIN.x1, CABIN.ridge, CABIN.z1)),
  ]);

  const glows: Glow[] = [
    { position: new THREE.Vector3(LOCO.x, locoY + 4.1, noseZ - 1.5), color: new THREE.Color(0xfff0d2).multiplyScalar(1.0) },
    { position: new THREE.Vector3(-9.0, 6.1, -14.05), color: new THREE.Color(SODIUM).multiplyScalar(0.7) },
    { position: new THREE.Vector3(8.95, 5.4, -19.95), color: new THREE.Color(COLD).multiplyScalar(0.5) },
  ];

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows,
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: 0x0b1019, fog: 0x0e1520, fogDensity: high ? 0.0115 : 0.0135,
      haze: new THREE.Color(0.012, 0.016, 0.024), hazeDensity: 0.011, hazeCeiling: 16, hazeFade: 7,
      environmentIntensity: 0.9, exposure: 1.05, far: 330,
    },
    sunlitAt: sunlit,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck: (object, point) => life.struck(object, point) };
}

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial, roofDeck } from "../pbr";
import {
  BRAND, archedWall, canvasTexture, createKit, hazardTexture, iBeam, projectUv, softBox, softDiscTexture, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions,
} from "../kit";
import { createProps, type PropItem, type PropKind } from "../props";
import { createWind } from "../wind";
import { createTrees, type TreeItem } from "../trees";
import { createLife } from "../life";

// Airframe: a maintenance hangar with its doors rolled open onto a desert apron at noon.
//
// Lighting model: the hall is shaded. The sun, matched to the sky's own sun, comes
// in two ways only: as a hard wedge through the open doors at the far end, and as
// bands through three glazed strips in the bowstring roof, whose glazing bars and
// trusses print into the dusty air. Everything else is bounce, taken from a probe
// of the lit hall, plus the high-bay lamps, the mezzanine office and the workshop.
//
// Geometry model: almost everything static is merged into one mesh per material
// (see `batch`), so the detail costs triangles, not draw calls.

type V3 = [number, number, number];

/** One merged mesh in the making: every call adds a piece in the current frame. */
interface Batch {
  add(geometry: THREE.BufferGeometry, x?: number, y?: number, z?: number, r?: V3, s?: V3, tint?: number): Batch;
  box(w: number, h: number, d: number, x: number, y: number, z: number, r?: V3, tint?: number): Batch;
  rbox(w: number, h: number, d: number, radius: number, x: number, y: number, z: number, r?: V3): Batch;
  cyl(top: number, bottom: number, h: number, x: number, y: number, z: number, r?: V3, segments?: number, open?: boolean, tint?: number): Batch;
  sphere(radius: number, x: number, y: number, z: number, s?: V3, segments?: number): Batch;
  torus(radius: number, tube: number, x: number, y: number, z: number, r?: V3, segments?: number, s?: V3): Batch;
  /** A round bar from a to b. */
  rod(a: V3, b: V3, radius: number, segments?: number): Batch;
  /** A bar of rectangular section `t` by `depth` from a to b. */
  bar(a: V3, b: V3, t: number, depth?: number): Batch;
  /** A bent pipe or hose through the points. */
  pipe(points: V3[], radius: number, segments?: number, radial?: number): Batch;
  /** The same batch with a fixed colour, sheen and own light, for pieces whose light is stored in the vertices. */
  tinted(tint: number, shine?: number, glow?: number): Batch;
}

/**
 * The sun of `goegap-2k.hdr` (0.535, 0.725, 0.433), turned to stand beyond the doors. The key light
 * keeps its bearing but sits a few degrees lower, so the wedge reaches further into the hall.
 */
const SKY_TURN = 1.88;
const SUN_ELEVATION = 0.68;
const SUN_COLOUR = 0xfff1dc, SUN_INTENSITY = 9, SUN_GAIN = SUN_INTENSITY / Math.PI;
const TO_SUN = new THREE.Vector3(0.535, 0, 0.433).normalize().multiplyScalar(Math.cos(SUN_ELEVATION)).setY(Math.sin(SUN_ELEVATION)).applyAxisAngle(new THREE.Vector3(0, 1, 0), SKY_TURN);

// Hall section: a circular-arc roof on walls at x = HALL.x0 and HALL.x1.
const HALL = { x0: -34, x1: 19, zBack: 10, zDoor: -31 };
const XC = (HALL.x0 + HALL.x1) / 2, HALF = (HALL.x1 - HALL.x0) / 2;
const EAVE = 13, RISE = 5.5, APEX = EAVE + RISE;
const RADIUS = (HALF * HALF + RISE * RISE) / (2 * RISE);
const TIE = 12.8;
const DOOR_TOP = 12.6;
const DOOR_CLEAR = { x0: -23.9, x1: 9.7 };
const ROOFLIGHTS = [-16.5, -24.5, -30.4];
const ROOFLIGHT_HALF = 1.2, ROOFLIGHT_REACH = 21;
const TRUSS_Z = [7, 0.5, -6, -12.5, -20.5, -28.2];
const PLANE = { x: -19.5, z: 5 };
const TRACKS = [-31.3, -31.78];

const roofY = (x: number) => APEX - RADIUS + Math.sqrt(RADIUS * RADIUS - (x - XC) * (x - XC));
const roofSlope = (x: number) => Math.atan(-(x - XC) / Math.sqrt(RADIUS * RADIUS - (x - XC) * (x - XC)));

/** A strip of the roof shell between two z lines, following the arc from x0 to x1. */
function roofBand(z0: number, z1: number, x0: number, x1: number, segments: number, lift = 0) {
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const x = x0 + (x1 - x0) * (i / segments), y = roofY(x) + lift;
    positions.push(x, y, z0, x, y, z1);
    uvs.push(z0 / 1.7, x / 1.7, z1 / 1.7, x / 1.7);
    if (i < segments) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** End wall filling the section under the arc, from `base` up, standing at z = 0..thickness. */
function gableGeometry(base: number, thickness: number, openings: Array<[number, number, number, number]> = []) {
  const shape = new THREE.Shape();
  const left = HALL.x0 - 0.6, right = HALL.x1 + 0.6;
  shape.moveTo(left, base); shape.lineTo(right, base);
  for (let i = 0; i <= 36; i += 1) { const x = right + (left - right) * (i / 36); shape.lineTo(x, roofY(x) + 0.05); }
  shape.closePath();
  for (const [x0, x1, y0, y1] of openings) {
    const hole = new THREE.Path();
    hole.moveTo(x0, y0); hole.lineTo(x0, y1); hole.lineTo(x1, y1); hole.lineTo(x1, y0); hole.closePath();
    shape.holes.push(hole);
  }
  return projectUv(new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }), 2.4);
}

/** Skin stretched over a row of matching closed sections; `u` per section and `v` per ring point override the default unwrap. */
function loft(sections: THREE.Vector3[][], uvScale: [number, number] = [1, 1], u?: number[], v?: number[]) {
  const ring = sections[0].length, positions: number[] = [], uvs: number[] = [], index: number[] = [];
  sections.forEach((section, s) => {
    for (let j = 0; j <= ring; j += 1) {
      const p = section[j % ring];
      positions.push(p.x, p.y, p.z);
      uvs.push((u ? u[s] : s / (sections.length - 1)) * uvScale[0], (v ? v[j] : j / ring) * uvScale[1]);
    }
  });
  const row = ring + 1;
  for (let s = 0; s < sections.length - 1; s += 1) for (let j = 0; j < ring; j += 1) {
    const a = s * row + j, b = a + 1, c = a + row, d = c + 1;
    index.push(a, c, b, b, c, d);
  }
  // Flat caps on both ends.
  for (const s of [0, sections.length - 1]) {
    const centre = sections[s].reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / ring);
    const at = positions.length / 3;
    positions.push(centre.x, centre.y, centre.z);
    uvs.push(uvs[s * row * 2], uvs[s * row * 2 + 1]);
    for (let j = 0; j < ring; j += 1) index.push(at, s * row + j, s * row + j + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// Aerofoil sections as [chord fraction, thickness], upper side from the leading edge aft, then the lower side back.
type Section = Array<[number, number]>;
const FOIL_FULL: Section = [
  [0, 0], [0.02, 0.028], [0.08, 0.05], [0.2, 0.066], [0.35, 0.07], [0.55, 0.058], [0.8, 0.03], [1, 0.004],
  [1, -0.004], [0.8, -0.012], [0.55, -0.026], [0.35, -0.034], [0.2, -0.034], [0.08, -0.028], [0.02, -0.016],
];
/** The fixed part of a section that carries a flap, aileron, elevator or rudder. */
const FOIL_MAIN: Section = [
  [0, 0], [0.02, 0.028], [0.08, 0.05], [0.2, 0.066], [0.35, 0.07], [0.55, 0.058], [0.705, 0.041],
  [0.705, -0.018], [0.55, -0.026], [0.35, -0.034], [0.2, -0.034], [0.08, -0.028], [0.02, -0.016],
];
/** The moving surface, with a rounded nose sitting in the shroud gap. */
const FOIL_FLAP: Section = [[0.716, 0.012], [0.73, 0.036], [0.8, 0.03], [1, 0.004], [1, -0.004], [0.8, -0.012], [0.73, -0.016]];

/** One aerofoil ring: leading edge at `lead`, chord running toward -z, thickness along `up`; `droop` hinges it down about 73 % chord. */
function foil(section: Section, lead: THREE.Vector3, chord: number, thickness: number, up: THREE.Vector3, droop = 0) {
  const cos = Math.cos(droop), sin = Math.sin(droop);
  return section.map(([c, t]) => {
    const dc = c - 0.73, dt = t * thickness - 0.01;
    const cc = droop ? 0.73 + dc * cos + dt * sin : c, tt = droop ? 0.01 + dt * cos - dc * sin : t * thickness;
    return lead.clone().add(new THREE.Vector3(0, 0, -cc * chord)).addScaledVector(up, tt * chord);
  });
}
/** Texture v around a section: 0..0.5 along the upper side, 1..0.5 along the lower. */
const foilV = (section: Section) => [...section.map(([c, t], i) => (t >= 0 && i < section.length / 2 + 1 ? c / 2 : 1 - c / 2)), 1 - section[0][0] / 2];

// ---- Fuselage of CS-DE2: nose at z = 0, tail at z = -26.2, on its gear above y = 0 ----
const FUSE_LENGTH = 26.2;
const STATIONS: Array<[number, number]> = [
  [0, 0.02], [0.12, 0.3], [0.4, 0.6], [0.9, 0.95], [1.6, 1.3], [2.5, 1.62], [3.6, 1.86], [4.8, 1.95], [8, 1.95], [11, 1.95], [14, 1.95],
  [15.5, 1.93], [17.5, 1.75], [19.5, 1.45], [21.5, 1.1], [23.5, 0.75], [25.2, 0.42], [26, 0.2], [26.2, 0.02],
];
/** Barrel radius at station `s`, a Hermite curve through the table. */
function radiusAt(s: number) {
  let i = 0;
  while (i < STATIONS.length - 2 && STATIONS[i + 1][0] < s) i += 1;
  const [s0, r0] = STATIONS[i], [s1, r1] = STATIONS[i + 1];
  const before = STATIONS[Math.max(0, i - 1)], after = STATIONS[Math.min(STATIONS.length - 1, i + 2)];
  const h = s1 - s0, t = THREE.MathUtils.clamp((s - s0) / h, 0, 1);
  const m0 = i === 0 ? (r1 - r0) / h : (r1 - before[1]) / (s1 - before[0]), m1 = (after[1] - r0) / (after[0] - s0);
  const t2 = t * t, t3 = t2 * t;
  return Math.max(0.02, (2 * t3 - 3 * t2 + 1) * r0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * r1 + (t3 - t2) * h * m1);
}
const centreAt = (s: number) => 3.3 - (s < 4.8 ? ((4.8 - s) / 4.8) ** 2 * 0.55 : 0) + (s > 14 ? ((s - 14) / 12.2) ** 1.7 * 1.75 : 0);
/** Point on the skin: v = 0 is the keel, 0.5 the crown, 0.75 the side that faces +x. `lift` stands it off the surface. */
function skinPoint(s: number, v: number, lift = 0) {
  const r = radiusAt(s) + lift, angle = v * Math.PI * 2;
  return new THREE.Vector3(-r * Math.sin(angle), centreAt(s) - r * Math.cos(angle), -s);
}
const steps = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
const FUSE_S = [0, 0.04, 0.12, 0.25, 0.4, 0.62, 0.9, 1.2, 1.5, 1.8, 2.1, 2.45, 2.75, 3.05, 3.3, 3.6, 4.2, 4.8, 6.4, 8, 9.5, 11, 12.5, 14, 14.8, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5, 21.5, 22.5, 23.5, 24.4, 25.2, 25.7, 26, 26.2];
/** A patch of the fuselage skin over the given stations and v range; cells for which `hole` is true are left open. */
function skinPatch(stations: number[], v0: number, v1: number, around: number, lift = 0, flip = false, hole?: (s: number, v: number) => boolean) {
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  stations.forEach((s) => {
    for (let j = 0; j <= around; j += 1) {
      const v = v0 + ((v1 - v0) * j) / around, p = skinPoint(s, v, lift);
      positions.push(p.x, p.y, p.z);
      uvs.push(s / FUSE_LENGTH, v);
    }
  });
  const row = around + 1;
  for (let s = 0; s < stations.length - 1; s += 1) for (let j = 0; j < around; j += 1) {
    if (hole?.((stations[s] + stations[s + 1]) / 2, v0 + ((v1 - v0) * (j + 0.5)) / around)) continue;
    const a = s * row + j, b = a + 1, c = a + row, d = c + 1;
    if (flip) index.push(a, c, b, b, c, d); else index.push(a, b, c, b, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
const COCKPIT = { s0: 1.8, s1: 3.05, half: 0.146 };
const cockpitHole = (s: number, v: number) => s > COCKPIT.s0 && s < COCKPIT.s1 && Math.abs(v - 0.5) < COCKPIT.half;

/** Paint scheme unwrapped along the fuselage: x runs nose to tail, y around the barrel. Returns colour and relief. */
function liveryTextures(size: number) {
  const W = size, H = size / 2, metre = W / FUSE_LENGTH, k = W / 2048;
  const row = (v: number) => (1 - v) * H;
  const windows: number[] = [];
  for (let s = 5.6; s < 15.2; s += 0.95) windows.push(s);
  const doors: Array<[number, number, number, number]> = [[4.0, 0.2, 0.9, 0.16], [4.0, 0.64, 0.9, 0.16], [15.6, 0.64, 1.9, 0.18], [16.2, 0.21, 0.8, 0.13]];
  // Service hatches low on both flanks: [station, v of the lower edge on the +x side, length in metres, height in v, label].
  const hatches: Array<[number, number, number, number, string]> = [
    [2.2, 0.842, 0.5, 0.03, "AVIONICS · NET_GRAPH 1"], [6.1, 0.875, 0.52, 0.03, "HYD · SURF OIL ONLY"], [7.5, 0.893, 0.4, 0.026, "WATER · POOL DAY"], [9.7, 0.872, 0.62, 0.032, "FUEL CONTROL · 1:55 RESERVE"],
    [13.3, 0.878, 0.5, 0.03, "OXYGEN · ABOVE VERTIGO"], [17.0, 0.852, 0.62, 0.034, "BATTERY 1.6"], [19.3, 0.84, 0.5, 0.03, "APU · NOT AN AWP"],
  ];
  const map = canvasTexture(W, H, (context) => {
    context.fillStyle = "#e3e5e2";
    context.fillRect(0, 0, W, H);
    // Grey keel, with a navy cheat line and an orange pinstripe above it on both sides.
    context.fillStyle = "#8a9296";
    context.fillRect(0, row(0.17), W, H - row(0.17)); context.fillRect(0, 0, W, row(0.83));
    context.fillStyle = "#1c3550";
    context.fillRect(0, row(0.215), W, row(0.17) - row(0.215)); context.fillRect(0, row(0.83), W, row(0.785) - row(0.83));
    context.fillStyle = "#d9822b";
    context.fillRect(0, row(0.234), W, 9 * k); context.fillRect(0, row(0.766) - 9 * k, W, 9 * k);
    // The cheat line sweeps up over the rear fuselage toward the fin.
    for (const side of [0, 1]) {
      const v = (a: number) => row(side ? 1 - a : a);
      context.fillStyle = "#1c3550";
      context.beginPath(); context.moveTo(17.2 * metre, v(0.17)); context.lineTo(26.2 * metre, v(0.17)); context.lineTo(26.2 * metre, v(0.5)); context.lineTo(22.6 * metre, v(0.5)); context.quadraticCurveTo(19 * metre, v(0.3), 17.2 * metre, v(0.215)); context.closePath(); context.fill();
      context.strokeStyle = "#d9822b"; context.lineWidth = 9 * k;
      context.beginPath(); context.moveTo(17 * metre, v(0.236)); context.quadraticCurveTo(19 * metre, v(0.32), 22.4 * metre, v(0.5)); context.stroke();
    }
    // Radome and anti-glare panel ahead of the windscreen.
    context.fillStyle = "#2b2f33";
    context.fillRect(0, 0, 0.95 * metre, H);
    context.fillStyle = "#23272a";
    context.beginPath(); context.moveTo(0.95 * metre, row(0.56)); context.lineTo(1.72 * metre, row(0.6)); context.lineTo(1.72 * metre, row(0.4)); context.lineTo(0.95 * metre, row(0.44)); context.closePath(); context.fill();
    // Cabin window surrounds.
    for (const s of windows) for (const v of [0.3, 0.7]) {
      context.fillStyle = "#0d1317";
      context.beginPath(); context.roundRect(s * metre, row(v) - 19 * k, 22 * k, 38 * k, 9 * k); context.fill();
      context.strokeStyle = "#9aa1a4"; context.lineWidth = 2 * k; context.stroke();
    }
    // Door and hatch outlines with hinge and handle marks.
    for (const [s, v, w, dv] of doors) {
      context.strokeStyle = "rgba(34,40,44,.85)"; context.lineWidth = 3 * k;
      context.beginPath(); context.roundRect(s * metre, row(v + dv), w * metre, row(v) - row(v + dv), 10 * k); context.stroke();
      context.strokeStyle = "rgba(196,48,36,.8)"; context.lineWidth = 1.5 * k;
      context.beginPath(); context.roundRect(s * metre - 5 * k, row(v + dv) - 5 * k, w * metre + 10 * k, row(v) - row(v + dv) + 10 * k, 13 * k); context.stroke();
    }
    // Service hatches: outline, quarter-turn fasteners, a latch, the label above.
    for (const [s, v, w, dv] of hatches) for (const flank of [0, 1]) {
      const top = flank ? row(v + dv) : row(1 - v), height = Math.abs(row(v) - row(v + dv));
      context.fillStyle = "rgba(255,255,255,.1)"; context.strokeStyle = "rgba(26,32,36,.8)"; context.lineWidth = 2.2 * k;
      context.beginPath(); context.roundRect(s * metre, top, w * metre, height, 5 * k); context.fill(); context.stroke();
      context.fillStyle = "rgba(26,32,36,.75)";
      for (let i = 0; i <= 4; i += 1) for (const edge of [0.14, 0.86]) context.fillRect(s * metre + (0.08 + 0.21 * i) * w * metre - k, top + height * edge - k, 2.6 * k, 2.6 * k);
      context.fillStyle = "#c9a227"; context.fillRect((s + w * 0.44) * metre, top + height * 0.4, w * 0.12 * metre, height * 0.2);
    }
    // Propeller plane warning bands, stopping short of the titles.
    context.fillStyle = "#b9261c";
    for (const [v0, v1] of [[0.24, 0.332], [0.668, 0.76]]) context.fillRect(8.02 * metre - 4 * k, row(v1), 8 * k, row(v0) - row(v1));
    // Frame and stringer seams, each with a row of rivets.
    context.fillStyle = "rgba(20,26,30,.2)";
    const frames: number[] = [], stringers = [0.04, 0.08, 0.125, 0.26, 0.33, 0.4, 0.45, 0.5, 0.55, 0.6, 0.67, 0.74, 0.875, 0.92, 0.96];
    for (let x = 1.4; x < FUSE_LENGTH; x += 0.61) frames.push(x);
    frames.forEach((x, i) => { if (i % 2 === 0) context.fillRect(x * metre, 0, 2 * k, H); });
    for (const v of stringers) context.fillRect(0.95 * metre, row(v), W, 2 * k);
    for (const x of frames) for (let y = 0; y < H; y += 7 * k) {
      context.fillStyle = "rgba(24,30,34,.26)"; context.fillRect(x * metre + 5 * k, y, 1.6 * k, 1.6 * k);
      context.fillStyle = "rgba(255,255,255,.3)"; context.fillRect(x * metre + 5 * k, y - 1.2 * k, 1.6 * k, 1.2 * k);
    }
    for (const v of stringers) for (let x = 0.95 * metre; x < W; x += 7 * k) {
      context.fillStyle = "rgba(24,30,34,.24)"; context.fillRect(x, row(v) + 5 * k, 1.6 * k, 1.6 * k);
    }
    // Titles, registration and stencils, drawn the right way round for each side.
    // `v` is given for the flank facing the range (v > 0.5); `far` is the station on the other flank, where the text runs tail to nose.
    const write = (text: string, s: number, v: number, px: number, colour: string, font = "700", spacing = 0, far: number | null = s, near = true) => {
      context.fillStyle = colour;
      context.font = `${font} ${px * k}px "Helvetica Neue", Arial, sans-serif`;
      context.textAlign = "center"; context.textBaseline = "middle";
      (context as unknown as { letterSpacing: string }).letterSpacing = `${spacing * k}px`;
      if (near) { context.save(); context.translate(s * metre, row(v)); context.scale(1, -1); context.fillText(text, 0, 0); context.restore(); }
      if (far !== null) { context.save(); context.translate(far * metre, row(1 - v)); context.scale(-1, 1); context.fillText(text, 0, 0); context.restore(); }
    };
    // The airline's name keeps its word order on both sides.
    write("COUNTER-STRAFE", 8.3, 0.637, 42, "#1c3550", "800", 7, 9.4);
    write("A I R", 12.14, 0.636, 20, "#d9822b", "600", 3, 5.56);
    // Registration on the shoulder aft of the door, clear of the sweep.
    write("CS-DE2", 18.3, 0.61, 52, "#1c3550");
    write("CS-DE2", 3.4, 0.7, 22, "#1c3550");
    write("\u201cFLYING SCOUTSMAN\u201d", 2.9, 0.725, 11, "#3b4a58", "600", 1);
    write("RESCUE  ▸  PULL HANDLE · HOSTAGES OUT FIRST", 4.45, 0.812, 8, "#b9261c", "700");
    write("NO BHOP", 12.2, 0.56, 9, "#b9261c", "700");
    write("STATIC PORT · NO STICKERS", 3.55, 0.672, 7, "#b9261c", "700");
    write("GROUND POWER 28 V DC · NO ZEUS", 4.85, 0.86, 9, "#20262a", "700");
    write("BOOST SPOT", 3.2, 0.9, 8, "#20262a", "700");
    write("DE2", 0.55, 0.62, 26, "#c9ced0");
    for (const [s, v, w, , name] of hatches) write(name, s + w / 2, v - 0.008, 7, "#20262a", "700");
    write("WALLBANG HERE IN EMERGENCY", 9.9, 0.596, 8, "#b9261c", "700");
    write("TYRE PRESSURE 128 PSI  ·  NOT 64", 12.2, 0.905, 7, "#20262a", "700");
    write("TOW LIMIT ± 60°  ·  M_YAW 0.022", 3.2, 0.93, 7, "#b9261c", "700");
    write("BOOST HERE", 21.6, 0.86, 8, "#20262a", "700");
    write("EMERGENCY EXIT  ·  NO RAGE QUITS", 15.6 + 0.95, 0.835, 9, "#b9261c", "700", 0, null);
    write("CARGO  ·  MAX 1 450 KG  ·  NO NEGEVS", 16.6, 0.64, 8, "#20262a", "700", 0, 16.6, false);
    // Exhaust and hydraulic grime trailing aft.
    let seed = 4177;
    for (let i = 0; i < 900; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = (seed % W), y = (seed >>> 11) % H, length = (30 + ((seed >>> 22) & 127)) * k;
      context.fillStyle = `rgba(38,36,32,${0.016 + ((seed >>> 8) & 7) * 0.005})`;
      context.fillRect(x, y, length, (2 + ((seed >>> 5) & 3)) * k);
    }
    for (const v of [0.02, 0.98, 0.07]) { const g = context.createLinearGradient(8 * metre, 0, 24 * metre, 0); g.addColorStop(0, "rgba(30,26,20,0)"); g.addColorStop(0.3, "rgba(30,26,20,.28)"); g.addColorStop(1, "rgba(30,26,20,0)"); context.fillStyle = g; context.fillRect(8 * metre, row(v) - 14 * k, 16 * metre, 28 * k); }
  });
  // Relief: lap seams and door gaps cut in, window surrounds proud.
  const B = 2048, bm = B / FUSE_LENGTH, brow = (v: number) => (1 - v) * (B / 2);
  const bump = canvasTexture(B, B / 2, (context) => {
    context.fillStyle = "#808080";
    context.fillRect(0, 0, B, B / 2);
    context.fillStyle = "#585858";
    for (let x = 1.4; x < FUSE_LENGTH; x += 1.22) context.fillRect(x * bm, 0, 2, B / 2);
    for (const v of [0.04, 0.08, 0.125, 0.26, 0.33, 0.4, 0.45, 0.5, 0.55, 0.6, 0.67, 0.74, 0.875, 0.92, 0.96]) context.fillRect(0.95 * bm, brow(v), B, 1.5);
    context.fillRect(0.95 * bm - 1, 0, 3, B / 2);
    context.strokeStyle = "#303030"; context.lineWidth = 2.5;
    for (const [s, v, w, dv] of doors) { context.beginPath(); context.roundRect(s * bm, brow(v + dv), w * bm, brow(v) - brow(v + dv), 5); context.stroke(); }
    context.lineWidth = 1.5;
    for (const [s, v, w, dv] of hatches) for (const flank of [0, 1]) { context.beginPath(); context.roundRect(s * bm, flank ? brow(v + dv) : brow(1 - v), w * bm, Math.abs(brow(v) - brow(v + dv)), 3); context.stroke(); }
    context.strokeStyle = "#b4b4b4"; context.lineWidth = 2;
    for (const s of windows) for (const v of [0.3, 0.7]) { context.beginPath(); context.roundRect(s * bm - 2, brow(v) - 12, 15, 24, 6); context.stroke(); }
  });
  bump.colorSpace = THREE.NoColorSpace;
  return { map, bump };
}

/**
 * Wing skin for both half-wings: u runs root to tip, the -x wing in the first half of the sheet and the +x wing in the
 * second; v wraps the section as `foilV` does, so upper surfaces lie along the bottom of the sheet and lower surfaces
 * along the top, leading edges at the rims. Lettering is turned to read from the ground under the wing.
 */
function wingTexture(size: number) {
  const W = size, H = size / 4, half = W / 2, k = W / 4096;
  return canvasTexture(W, H, (context) => {
    let seed = 8087;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const side of [-1, 1]) for (const lower of [false, true]) {
      const x = (t: number) => (side > 0 ? half : 0) + t * half, y = (c: number) => (lower ? c / 2 : 1 - c / 2) * H;
      const fill = (t0: number, t1: number, c0: number, c1: number, colour: string) => { context.fillStyle = colour; context.fillRect(x(t0), Math.min(y(c0), y(c1)), x(t1) - x(t0), Math.abs(y(c1) - y(c0))); };
      const label = (value: string, t: number, c: number, px: number, colour: string, weight = "700") => {
        context.save(); context.translate(x(t), y(c)); context.scale(lower === side > 0 ? 1 : -1, lower ? 1 : -1);
        context.fillStyle = colour; context.font = `${weight} ${px * k}px "Helvetica Neue", Arial, sans-serif`; context.textAlign = "center"; context.textBaseline = "middle";
        context.fillText(value, 0, 0); context.restore();
      };
      fill(0, 1, 0, 1, lower ? "#c4c9ca" : "#e2e4e1");
      // Skin panels weathered a little differently from bay to bay.
      for (let i = 0; i < 25; i += 1) for (const [c0, c1] of [[0.062, 0.3], [0.3, 0.58], [0.58, 0.705]]) fill(i / 25, (i + 1) / 25, c0, c1, `rgba(${next() > 0.5 ? "255,255,255" : "0,0,0"},${next() * 0.05})`);
      // Ribs and spars as seams, each with its rivet row.
      for (let i = 1; i < 25; i += 1) fill(i / 25 - 0.0005, i / 25 + 0.0005, 0.062, 1, "rgba(22,28,32,.34)");
      for (const c of [0.16, 0.3, 0.44, 0.58]) fill(0, 1, c - 0.002, c + 0.002, "rgba(22,28,32,.3)");
      context.fillStyle = "rgba(24,30,34,.36)";
      for (let i = 1; i < 25; i += 1) for (let c = 0.075; c < 0.99; c += 0.0125) context.fillRect(x(i / 25) + 5 * k, y(c), 2 * k, 2 * k);
      for (const c of [0.16, 0.3, 0.44, 0.58]) for (let t = 0.004; t < 1; t += 0.0035) context.fillRect(x(t), y(c) + (lower ? 5 : -7) * k, 2 * k, 2 * k);
      // Shroud line, the ends of the flap and aileron bays, a trim tab in the aileron.
      fill(0, 1, 0.7, 0.71, "rgba(8,12,16,.8)");
      for (const t of [0.13, 0.36, 0.46, 0.68, 0.7, 0.95]) fill(t - 0.001, t + 0.001, 0.705, 1, "rgba(8,12,16,.8)");
      context.strokeStyle = "rgba(22,28,32,.6)"; context.lineWidth = 2 * k;
      context.strokeRect(x(0.74), Math.min(y(0.88), y(1)), x(0.86) - x(0.74), Math.abs(y(1) - y(0.88)));
      // De-icing boot along the leading edge.
      fill(0, 1, 0, 0.055, "#15171a"); fill(0, 1, 0.055, 0.062, "#7d8488");
      if (lower) {
        // Inspection panels between the ribs, each on a ring of screws.
        for (let i = 1; i < 24; i += 2) for (const c of [0.37, 0.51]) {
          const t = (i + 0.5) / 25;
          if ((t > 0.33 && t < 0.49) || (side > 0 && t > 0.5 && t < 0.92)) continue;
          const cx = x(t), cy = y(c), rx = 27 * k, ry = 15 * k;
          context.fillStyle = "rgba(255,255,255,.16)"; context.beginPath(); context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); context.fill();
          context.strokeStyle = "rgba(22,28,32,.62)"; context.lineWidth = 1.6 * k; context.stroke();
          context.fillStyle = "rgba(22,28,32,.62)";
          for (let a = 0; a < 8; a += 1) context.fillRect(cx + Math.cos(a * Math.PI / 4) * rx * 0.8 - k, cy + Math.sin(a * Math.PI / 4) * ry * 0.78 - k, 2.4 * k, 2.4 * k);
        }
        // Registration under one wing; jacking pad, drains, tie-down and refuel panel called out in small type.
        if (side > 0) label("CS-DE2", 0.71, 0.4, 202, "#1c3550", "800");
        for (const [t, c] of [[0.345, 0.3], [0.93, 0.2]]) {
          context.fillStyle = "#b9261c"; context.beginPath(); context.moveTo(x(t), y(c) - 13 * k); context.lineTo(x(t) + 13 * k, y(c) + 10 * k); context.lineTo(x(t) - 13 * k, y(c) + 10 * k); context.closePath(); context.fill();
          label(t < 0.5 ? "BOOST SPOT" : "TIE DOWN · NOCLIP OFF", t, c + 0.06, 13, "#b9261c");
        }
        for (const t of [0.1, 0.26, 0.55, 0.78]) {
          context.fillStyle = "#30373b"; context.beginPath(); context.arc(x(t), y(0.64), 6 * k, 0, Math.PI * 2); context.fill();
          label("LOSS BONUS DRAIN", t, 0.665, 9, "#20262a");
        }
        context.strokeStyle = "rgba(22,28,32,.75)"; context.lineWidth = 2.4 * k; context.strokeRect(x(0.215), y(0.19), 86 * k, 58 * k);
        context.strokeStyle = "#b9261c"; context.lineWidth = 1.6 * k; context.strokeRect(x(0.215) - 5 * k, y(0.19) - 5 * k, 96 * k, 68 * k);
        label("PRESSURE REFUEL  ·  JET A-1  ·  NOT MOLOTOV GRADE", 0.236, 0.275, 9, "#b9261c");
        for (const [t, c] of [[0.8, 0.82], [0.24, 0.84], [0.57, 0.84]]) label("NO PUSH · LET THEM COME", t, c, 12, "#b9261c");
        // Exhaust soot and oil trailing aft of the nacelle.
        for (const [t, reach] of [[0.385, 0.06], [0.435, 0.06], [0.41, 0.045]]) {
          const stain = context.createLinearGradient(0, y(0.22), 0, y(1));
          stain.addColorStop(0, "rgba(26,22,18,0)"); stain.addColorStop(0.35, "rgba(26,22,18,.4)"); stain.addColorStop(1, "rgba(26,22,18,.08)");
          context.fillStyle = stain; context.fillRect(x(t - reach / 2), y(0.22), x(reach) - x(0), y(1) - y(0.22));
        }
      } else {
        // Walkway band by the root, filler caps, stencils on the moving surfaces.
        fill(0.01, 0.1, 0.1, 0.68, "rgba(34,38,42,.82)");
        for (const t of [0.2, 0.6]) {
          context.strokeStyle = "#b9261c"; context.lineWidth = 3 * k; context.beginPath(); context.arc(x(t), y(0.36), 15 * k, 0, Math.PI * 2); context.stroke();
          context.fillStyle = "#30373b"; context.beginPath(); context.arc(x(t), y(0.36), 9 * k, 0, Math.PI * 2); context.fill();
          label("JET A-1 · $16000 MAX", t, 0.44, 12, "#b9261c");
        }
        for (const t of [0.24, 0.57, 0.82]) label("NO SURFING", t, 0.85, 14, "#b9261c");
      }
      // Dirt drawn aft by the airflow, heavier under the wing.
      for (let i = 0; i < 260; i += 1) {
        const t = next(), c = 0.07 + next() * 0.7, length = 0.05 + next() * 0.22;
        context.fillStyle = `rgba(40,36,30,${(lower ? 0.035 : 0.02) + next() * 0.04})`;
        context.fillRect(x(t), Math.min(y(c), y(Math.min(1, c + length))), (2 + next() * 6) * k, Math.abs(y(Math.min(1, c + length)) - y(c)));
      }
    }
  });
}

/** Fin scheme: u runs root to tip, v wraps both sides (see `foilV`). */
function finTexture() {
  const W = 1024, H = 1024;
  return canvasTexture(W, H, (context) => {
    // Both sides are drawn through `plot(chord, span)`.
    const plot = (c: number, t: number, side: number): [number, number] => [t * W, side ? (c / 2) * H : (1 - c / 2) * H];
    const poly = (points: Array<[number, number]>, colour: string) => {
      for (const side of [0, 1]) {
        context.fillStyle = colour;
        context.beginPath();
        points.forEach(([c, t], i) => { const [x, y] = plot(c, t, side); if (i) context.lineTo(x, y); else context.moveTo(x, y); });
        context.closePath(); context.fill();
      }
    };
    context.fillStyle = "#1c3550";
    context.fillRect(0, 0, W, H);
    poly([[0, 0], [1, 0], [1, 0.1], [0, 0.22]], "#e3e5e2");
    poly([[0, 0.22], [1, 0.1], [1, 0.135], [0, 0.255]], "#d9822b");
    // Emblem: a disc with two arrowheads thrown apart from a stop bar, left and right at once.
    const at = (x: number, y: number): [number, number] => [0.46 + x / 3.4, 0.6 + y / 6.05];
    const disc = (r: number, colour: string) => poly(Array.from({ length: 40 }, (_, i) => at(Math.cos(i * Math.PI / 20) * r, Math.sin(i * Math.PI / 20) * r)), colour);
    disc(1.05, "#e3e5e2"); disc(0.93, "#d9822b");
    for (const side of [-1, 1]) poly([at(side * 0.74, 0), at(side * 0.16, 0.44), at(side * 0.16, -0.44)], "#1c3550");
    poly([at(-0.05, -0.52), at(0.05, -0.52), at(0.05, 0.52), at(-0.05, 0.52)], "#e3e5e2");
    // Rudder hinge line and rivets.
    for (const side of [0, 1]) {
      context.fillStyle = "rgba(8,14,20,.5)";
      const [, y] = plot(0.71, 0, side);
      context.fillRect(0, y - 1, W, 3);
      for (let x = 0; x < W; x += 9) { context.fillStyle = "rgba(230,236,240,.22)"; context.fillRect(x, plot(0.2, 0, side)[1], 2, 2); context.fillRect(x, plot(0.5, 0, side)[1], 2, 2); }
    }
  });
}

/** Painted markings of the aircraft stand beside the range bay. */
function standTexture(width: number, depth: number) {
  const size = 2048, sx = size / width, sz = size / depth;
  return canvasTexture(size, size, (context) => {
    context.clearRect(0, 0, size, size);
    const line = (x0: number, z0: number, x1: number, z1: number, colour: string, metres = 0.15, dash: number[] = []) => {
      context.strokeStyle = colour; context.lineWidth = metres * sx; context.setLineDash(dash.map((d) => d * sz));
      context.beginPath(); context.moveTo(x0 * sx, z0 * sz); context.lineTo(x1 * sx, z1 * sz); context.stroke();
    };
    // Lead-in line under the fuselage with a nose-wheel stop bar.
    line(14.5, 0, 14.5, depth, "rgba(226,172,32,.9)", 0.2);
    line(13.1, 31.7, 15.9, 31.7, "rgba(226,172,32,.9)", 0.3);
    context.fillStyle = "rgba(226,172,32,.9)";
    context.font = `700 ${0.7 * sx}px "Helvetica Neue", Arial, sans-serif`;
    context.textAlign = "center"; context.textBaseline = "middle";
    context.save(); context.translate(16.9 * sx, 31.7 * sz); context.scale(1, sz / sx); context.fillText("DE2", 0, 0); context.restore();
    // Wing-tip and propeller clearance envelope.
    context.strokeStyle = "rgba(196,48,36,.85)"; context.lineWidth = 0.14 * sx; context.setLineDash([0.9 * sz, 0.5 * sz]);
    context.strokeRect(1.6 * sx, 6.6 * sz, 23.4 * sx, 28.4 * sz);
    context.setLineDash([]);
    for (const x of [9.9, 19.1]) { context.beginPath(); context.ellipse(x * sx, 27.7 * sz, 2.3 * sx, 2.3 * sz, 0, 0, Math.PI * 2); context.stroke(); }
    // Equipment bays, hatched.
    for (const [x, z, w, d] of [[21.1, 15.4, 2.4, 4.6], [16.2, 35.6, 2.2, 3.4], [2.4, 2.2, 4.6, 3.2]]) {
      context.save();
      context.beginPath(); context.rect(x * sx, z * sz, w * sx, d * sz); context.clip();
      context.strokeStyle = "rgba(232,230,220,.55)"; context.lineWidth = 0.09 * sx;
      for (let k = -8; k < 14; k += 0.6) { context.beginPath(); context.moveTo((x + k) * sx, z * sz); context.lineTo((x + k + d) * sx, (z + d) * sz); context.stroke(); }
      context.restore();
      context.strokeStyle = "rgba(232,230,220,.85)"; context.lineWidth = 0.12 * sx;
      context.strokeRect(x * sx, z * sz, w * sx, d * sz);
    }
    // Green walkway along the bay partition, with footprints of use.
    context.fillStyle = "rgba(42,120,84,.6)";
    context.fillRect(21.9 * sx, 0, 1.3 * sx, 30.6 * sz);
    line(21.9, 0, 21.9, 30.6, "rgba(232,230,220,.85)", 0.1);
    line(23.2, 0, 23.2, 30.6, "rgba(232,230,220,.85)", 0.1);
    // Tyre marks along the lead-in and oil stains under the engines.
    for (const x of [12.38, 16.62, 14.26, 14.74]) { context.fillStyle = "rgba(14,14,14,.16)"; context.fillRect(x * sx - 0.16 * sx, 0, 0.32 * sx, 30 * sz); }
    for (const [x, z, r] of [[9.9, 26.4, 0.9], [19.1, 26.8, 1.1], [14.5, 21, 0.7], [14.2, 33.6, 0.5]]) {
      const g = context.createRadialGradient(x * sx, z * sz, 0, x * sx, z * sz, r * sx);
      g.addColorStop(0, "rgba(16,14,10,.5)"); g.addColorStop(1, "rgba(16,14,10,0)");
      context.fillStyle = g; context.fillRect((x - r) * sx, (z - r) * sz, r * 2 * sx, r * 2 * sz);
    }
    // Wear: scuffs rubbed through the paint.
    context.globalCompositeOperation = "destination-out";
    let seed = 907;
    for (let i = 0; i < 7000; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      context.fillStyle = `rgba(0,0,0,${0.15 + ((seed >>> 28) & 7) * 0.07})`;
      context.fillRect(seed % size, (seed >>> 10) % size, 2 + ((seed >>> 20) & 15), 1 + ((seed >>> 25) & 3));
    }
    context.globalCompositeOperation = "source-over";
  });
}

/** Apron paint beyond the doors: taxi lines sweeping out of the hangar and numbered stands. */
function apronTexture() {
  const size = 2048, m = size / 84;
  return canvasTexture(size, size, (context) => {
    context.clearRect(0, 0, size, size);
    context.lineCap = "round";
    const yellow = "rgba(226,172,32,.9)";
    // Lead-out from the aircraft stand, curving onto the taxi lane; black-backed like real apron paint.
    const leadOut = () => {
      context.beginPath(); context.moveTo(30.5 * m, 0); context.lineTo(30.5 * m, 20 * m); context.quadraticCurveTo(30.5 * m, 42 * m, 8 * m, 42 * m); context.lineTo(0, 42 * m); context.stroke();
      context.beginPath(); context.moveTo(30.5 * m, 20 * m); context.quadraticCurveTo(30.5 * m, 42 * m, 56 * m, 42 * m); context.lineTo(84 * m, 42 * m); context.stroke();
    };
    context.strokeStyle = "rgba(18,18,18,.55)"; context.lineWidth = 0.6 * m; leadOut();
    context.strokeStyle = yellow; context.lineWidth = 0.32 * m; leadOut();
    // Taxi lane edges, double.
    for (const z of [33.5, 34.1, 50.1, 50.7]) { context.lineWidth = 0.16 * m; context.beginPath(); context.moveTo(0, z * m); context.lineTo(84 * m, z * m); context.stroke(); }
    // Hangar threshold: red no-parking band along the door line.
    context.strokeStyle = "rgba(196,48,36,.85)"; context.lineWidth = 0.22 * m;
    context.beginPath(); context.moveTo(8 * m, 1.6 * m); context.lineTo(62 * m, 1.6 * m); context.stroke();
    context.beginPath(); context.moveTo(8 * m, 5.2 * m); context.lineTo(62 * m, 5.2 * m); context.stroke();
    context.lineWidth = 0.14 * m;
    for (let x = 8; x < 62; x += 1.6) { context.beginPath(); context.moveTo(x * m, 5.2 * m); context.lineTo((x + 1.6) * m, 1.6 * m); context.stroke(); }
    context.fillStyle = "rgba(232,230,220,.9)";
    context.font = `700 ${1.3 * m}px "Helvetica Neue", Arial, sans-serif`;
    context.textAlign = "center"; context.textBaseline = "middle";
    for (const x of [18, 48]) context.fillText("PEEKER\u2019S ADVANTAGE  ·  CLEAR DOORS", x * m, 7.4 * m, 27 * m);
    // Remote stands with lead-in tees, numbers and equipment boxes.
    for (const [x, label] of [[4, "64"], [44, "128"]] as Array<[number, string]>) {
      context.strokeStyle = "rgba(232,230,220,.85)"; context.lineWidth = 0.2 * m;
      context.strokeRect(x * m, 56 * m, 30 * m, 24 * m);
      context.strokeStyle = yellow; context.lineWidth = 0.3 * m;
      context.beginPath(); context.moveTo((x + 15) * m, 50.7 * m); context.lineTo((x + 15) * m, 74 * m); context.stroke();
      context.beginPath(); context.moveTo((x + 13) * m, 74 * m); context.lineTo((x + 17) * m, 74 * m); context.stroke();
      context.fillStyle = "rgba(18,18,18,.6)"; context.fillRect((x + 31.4) * m, 56.6 * m, 6.4 * m, 5.6 * m);
      context.fillStyle = yellow;
      context.font = `700 ${(label.length > 2 ? 3.3 : 4.6) * m}px "Helvetica Neue", Arial, sans-serif`;
      context.fillText(label, (x + 34.6) * m, 59.6 * m);
      context.strokeStyle = "rgba(196,48,36,.8)"; context.lineWidth = 0.16 * m;
      context.strokeRect((x + 1.2) * m, 57.2 * m, 5 * m, 7 * m);
      for (let k = 0; k < 5; k += 1) { context.beginPath(); context.moveTo((x + 1.2 + k) * m, 57.2 * m); context.lineTo((x + 2.2 + k) * m, 64.2 * m); context.stroke(); }
    }
    context.globalCompositeOperation = "destination-out";
    let seed = 1213;
    for (let i = 0; i < 6000; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      context.fillStyle = `rgba(0,0,0,${0.12 + ((seed >>> 28) & 7) * 0.06})`;
      context.fillRect(seed % size, (seed >>> 10) % size, 2 + ((seed >>> 20) & 15), 1 + ((seed >>> 25) & 3));
    }
    context.globalCompositeOperation = "source-over";
  });
}

// Signs, placards and boards share one sheet; a region is [x, y, width, height] in pixels.
const SHEET = 2048;
const SIGNS = {
  fascia: [0, 0, 2048, 192], pegboard: [0, 192, 1536, 512], fuel: [1536, 192, 512, 256], power: [1536, 448, 512, 256],
  notice: [0, 704, 1024, 640], shop: [1024, 704, 1024, 256], ear: [1024, 960, 256, 256], smoke: [1280, 960, 256, 256], scope: [1536, 960, 256, 256], fire: [1792, 960, 256, 256],
  nitrogen: [1024, 1216, 512, 256], panel: [1536, 1216, 512, 384], bind: [0, 1344, 1024, 256], decoy: [1024, 1600, 1024, 192], departures: [0, 1600, 1024, 192],
  plan: [0, 1792, 1024, 256], tags: [1024, 1792, 512, 128], noscope: [1024, 1920, 1024, 128], club: [1024, 1472, 512, 64], taxi: [1024, 1536, 512, 64],
} satisfies Record<string, [number, number, number, number]>;
type SignName = keyof typeof SIGNS;

function signSheet() {
  return canvasTexture(SHEET, SHEET, (context) => {
    const sans = '"Helvetica Neue", Arial, sans-serif';
    /** Sets `value` at `px`, or smaller when it would run past `max` pixels: nothing is cut off by its plate. */
    const text = (value: string, x: number, y: number, px: number, colour: string, weight = "700", align: CanvasTextAlign = "left", spacing = 0, max = 0) => {
      context.fillStyle = colour; context.font = `${weight} ${px}px ${sans}`; context.textAlign = align; context.textBaseline = "middle";
      (context as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
      const wide = context.measureText(value).width, gaps = value.length * spacing;
      if (max && wide > max) context.font = `${weight} ${(px * (max - gaps)) / (wide - gaps)}px ${sans}`;
      context.fillText(value, x, y);
    };
    const grime = (x: number, y: number, w: number, h: number, seed: number, amount = 0.05) => {
      let s = seed;
      for (let i = 0; i < (w * h) / 500; i += 1) { s = (s * 1664525 + 1013904223) >>> 0; context.fillStyle = `rgba(20,16,10,${amount * (((s >>> 24) & 7) / 7)})`; context.fillRect(x + (s % w), y + ((s >>> 11) % h), 2 + ((s >>> 20) & 31), 1 + ((s >>> 27) & 3)); }
    };
    const region = (name: SignName, draw: (w: number, h: number) => void) => {
      const [x, y, w, h] = SIGNS[name];
      context.save(); context.beginPath(); context.rect(x, y, w, h); context.clip(); context.translate(x, y); draw(w, h); context.restore();
    };
    // Office fascia lettering.
    region("fascia", (w, h) => {
      context.fillStyle = "#1c3550"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#d9822b"; context.fillRect(0, h - 22, w, 10);
      // The mark: a rabbit's head, ears up.
      context.beginPath(); context.arc(104, 112, 38, 0, Math.PI * 2); context.fill();
      for (const lean of [-1, 1]) { context.beginPath(); context.ellipse(104 + lean * 21, 50, 11, 40, lean * 0.2, 0, Math.PI * 2); context.fill(); }
      context.fillStyle = "#1c3550";
      for (const eye of [-13, 13]) { context.beginPath(); context.arc(104 + eye, 106, 5, 0, Math.PI * 2); context.fill(); }
      text("BHOP AVIATION SERVICES", 190, 70, 84, "#e9ece8", "800", "left", 6, 1410);
      text("WE KEEP YOUR SPEED  ·  APPROVAL SV_ENABLEBUNNYHOPPING 1", 194, 138, 46, "#aebccb", "700", "left", 2, 1410);
      text("BAY B", w - 60, 84, 110, "#d9822b", "800", "right", 4);
      grime(0, 0, w, h, 71);
    });
    // Shadow board behind the workshop bench.
    region("pegboard", (w, h) => {
      context.fillStyle = "#b9a47c"; context.fillRect(0, 0, w, h);
      context.fillStyle = "rgba(60,44,22,.5)";
      for (let y = 12; y < h; y += 24) for (let x = 12; x < w; x += 24) { context.beginPath(); context.arc(x, y, 2.6, 0, Math.PI * 2); context.fill(); }
      const shadow = "#27323a", steelTone = "#c9ced1";
      // Spanners in descending size.
      for (let i = 0; i < 11; i += 1) {
        const x = 70 + i * 62, length = 300 - i * 17, y = 60;
        context.fillStyle = shadow; context.fillRect(x - 15, y - 12, 30, length + 24);
        context.fillStyle = steelTone; context.fillRect(x - 6, y + 22, 12, length - 44);
        for (const end of [y + 14, y + length - 14]) { context.beginPath(); context.arc(x, end, 15 - i * 0.5, 0, Math.PI * 2); context.fill(); context.fillStyle = shadow; context.fillRect(x - 5, end - (end > 200 ? -4 : 18), 10, 14); context.fillStyle = steelTone; }
      }
      // Hammers, a hacksaw, pliers and screwdrivers.
      for (const [x, colour] of [[800, "#8a5a2c"], [880, "#8a5a2c"], [960, "#b9261c"]] as Array<[number, string]>) {
        context.fillStyle = shadow; context.fillRect(x - 46, 50, 92, 300);
        context.fillStyle = colour; context.fillRect(x - 9, 110, 18, 228);
        context.fillStyle = "#3d4448"; context.fillRect(x - 38, 62, 76, 44);
      }
      context.strokeStyle = shadow; context.lineWidth = 30; context.strokeRect(1050, 70, 280, 110);
      context.strokeStyle = "#d9822b"; context.lineWidth = 12; context.strokeRect(1050, 70, 280, 110);
      context.fillStyle = "#20262a"; context.fillRect(1310, 96, 110, 58);
      for (let i = 0; i < 9; i += 1) {
        const x = 1040 + i * 50;
        context.fillStyle = shadow; context.fillRect(x - 14, 232, 28, 240);
        context.fillStyle = ["#b9261c", "#1c3550", "#d9822b"][i % 3]; context.fillRect(x - 9, 240, 18, 96);
        context.fillStyle = steelTone; context.fillRect(x - 3, 336, 6, 128 - i * 6);
      }
      context.fillStyle = shadow; context.fillRect(60, 392, 700, 96);
      context.fillStyle = steelTone;
      for (let i = 0; i < 16; i += 1) { context.beginPath(); context.arc(96 + i * 42, 440, 12 + (i % 5) * 1.6, 0, Math.PI * 2); context.fill(); }
      text("TOOL CONTROL  —  INSPECT WITH F, THEN PUT IT BACK", 70, 368, 20, "#3b2c14", "700", "left", 2, 900);
      text("BOARD 1.6", w - 30, 34, 30, "#3b2c14", "800", "right");
      grime(0, 0, w, h, 5, 0.08);
    });
    const placard = (name: SignName, background: string, ink: string, title: string, lines: string[], diamond?: string) => region(name, (w, h) => {
      context.fillStyle = background; context.fillRect(0, 0, w, h);
      context.strokeStyle = ink; context.lineWidth = 8; context.strokeRect(10, 10, w - 20, h - 20);
      let left = 34;
      if (diamond) {
        context.save(); context.translate(110, h / 2); context.rotate(Math.PI / 4);
        context.fillStyle = diamond; context.fillRect(-58, -58, 116, 116); context.strokeStyle = "#111"; context.lineWidth = 5; context.strokeRect(-58, -58, 116, 116); context.restore();
        // Class 3 carries the flame; the green diamond is class 2 and carries a gas bottle.
        const gas = diamond === "#3c9a52";
        text(gas ? "2" : "3", 110, h / 2 + 34, 34, "#111", "800", "center");
        context.fillStyle = "#111"; context.beginPath();
        if (gas) { context.roundRect(98, h / 2 - 34, 24, 42, 8); context.rect(105, h / 2 - 44, 10, 12); }
        else { context.moveTo(110, h / 2 - 44); context.quadraticCurveTo(136, h / 2 - 6, 110, h / 2 + 8); context.quadraticCurveTo(84, h / 2 - 6, 110, h / 2 - 44); }
        context.fill();
        left = 216;
      }
      text(title, left, 70, title.length > 9 ? 50 : 66, ink, "800", "left", 2, w - left - 26);
      lines.forEach((line, i) => text(line, left, 126 + i * 34, 23, ink, "600", "left", 1, w - left - 26));
      grime(0, 0, w, h, title.length * 17, 0.07);
    });
    placard("fuel", "#e9e6da", "#1a1a1a", "JET A-1", ["FLAMMABLE  ·  UN 1863", "NO MOLLIES NEAR BOWSER", "BOND BEFORE FUELLING"], "#c8281e");
    placard("power", "#d9a21f", "#1a1a1a", "ZEUS 28 V", ["GROUND POWER UNIT  GP-27", "ONE CHARGE PER ROUND · $200", "CHOCK WHEELS · STOW CABLE"]);
    placard("nitrogen", "#e9e6da", "#1a1a1a", "N2", ["78% OF AIR. 0% OF AIM.", "DRY NITROGEN · 3000 PSI", "STRUTS & TYRES · CART N2-03"], "#3c9a52");
    // Staff noticeboard: cork, with pinned sheets.
    region("notice", (w, h) => {
      context.fillStyle = "#8a6a44"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#b08a5a"; context.fillRect(16, 16, w - 32, h - 32);
      grime(16, 16, w - 32, h - 32, 91, 0.2);
      const sheet = (x: number, y: number, sw: number, sh: number, tilt: number, colour: string, title: string, rows: number, accent = "#1c3550") => {
        context.save(); context.translate(x + sw / 2, y + sh / 2); context.rotate(tilt);
        context.fillStyle = "rgba(0,0,0,.25)"; context.fillRect(-sw / 2 + 4, -sh / 2 + 5, sw, sh);
        context.fillStyle = colour; context.fillRect(-sw / 2, -sh / 2, sw, sh);
        text(title, -sw / 2 + 12, -sh / 2 + 24, 17, accent, "800", "left", 0, sw - 24);
        context.fillStyle = "rgba(30,34,38,.55)";
        for (let i = 0; i < rows; i += 1) context.fillRect(-sw / 2 + 12, -sh / 2 + 46 + i * 13, (sw - 24) * (0.55 + ((i * 37) % 45) / 100), 4);
        context.fillStyle = "#c8281e"; context.beginPath(); context.arc(0, -sh / 2 + 9, 6, 0, Math.PI * 2); context.fill();
        context.restore();
      };
      sheet(40, 40, 230, 300, -0.03, "#f3f1e8", "SHIFT ROSTER · MR12", 18);
      sheet(290, 34, 210, 150, 0.02, "#f6e7a6", "DECOY SWEEP 06:30", 6, "#7a4a08");
      sheet(292, 200, 220, 280, 0.01, "#f3f1e8", "CS-DE2 C-CHECK", 16);
      sheet(530, 44, 220, 300, -0.015, "#f3f1e8", "CROSSHAIR CHECK", 18);
      sheet(770, 40, 210, 170, 0.035, "#cfe3f2", "NO TEAM FLASHES", 8);
      sheet(772, 230, 210, 250, -0.02, "#f3f1e8", "TYRES: 128, NOT 64", 14);
      sheet(44, 360, 230, 240, 0.02, "#f7d9c8", "HOT WORK: NO MOLLY", 13, "#8a1f14");
      sheet(540, 366, 210, 230, 0.03, "#f3f1e8", "STORES SHUT: GG WP", 12);
      sheet(300, 500, 220, 110, -0.04, "#e3f0d4", "CANTEEN: NO CHICKEN", 4, "#2a5a1c");
      sheet(776, 500, 200, 100, 0.02, "#f6e7a6", "WANTED: 5TH FOR MM", 3, "#7a4a08");
    });
    region("shop", (w, h) => {
      context.fillStyle = "#e9e6da"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#1c3550"; context.fillRect(0, 0, 230, h);
      text("MW", 115, h / 2 + 4, 132, "#e9e6da", "800", "center", 0, 196);
      text("SCROLL-WHEEL SHOP", 262, 92, 64, "#1c3550", "800", "left", 3, w - 262 - 34);
      text("BIND \"MWHEELUP\" \"+JUMP\"  ·  FITTED WHILE YOU WAIT", 264, 168, 30, "#39444c", "700", "left", 1, w - 264 - 34);
      context.fillStyle = "#d9822b"; context.fillRect(230, h - 26, w - 230, 12);
      grime(0, 0, w, h, 23);
    });
    const round = (name: SignName, ring: string, fill: string, glyph: (w: number) => void, caption: string) => region(name, (w, h) => {
      context.fillStyle = "#f1efe6"; context.fillRect(0, 0, w, h);
      context.fillStyle = fill; context.beginPath(); context.arc(w / 2, 104, 82, 0, Math.PI * 2); context.fill();
      context.strokeStyle = ring; context.lineWidth = 14; context.beginPath(); context.arc(w / 2, 104, 80, 0, Math.PI * 2); context.stroke();
      glyph(w);
      context.fillStyle = "#16191b"; context.fillRect(0, 204, w, 52);
      text(caption, w / 2, 231, 23, "#f1efe6", "800", "center", 1, w - 24);
      grime(0, 0, w, h, caption.length * 31, 0.07);
    });
    round("ear", "#1d5fa8", "#1d5fa8", (w) => {
      context.strokeStyle = "#fff"; context.lineWidth = 12; context.beginPath(); context.arc(w / 2, 108, 44, Math.PI, 0); context.stroke();
      context.fillStyle = "#fff"; context.fillRect(w / 2 - 62, 100, 26, 50); context.fillRect(w / 2 + 36, 100, 26, 50);
    }, "LISTEN FOR STEPS");
    round("smoke", "#c8281e", "#f1efe6", (w) => {
      // A smoke canister, struck through: body with its band, fuze, lever and pin ring, a wisp above.
      const cx = w / 2;
      context.fillStyle = "#16191b";
      context.beginPath(); context.roundRect(cx - 19, 84, 38, 62, 7); context.fill();
      context.fillRect(cx - 11, 72, 22, 14);
      context.beginPath(); context.moveTo(cx + 11, 74); context.lineTo(cx + 30, 82); context.lineTo(cx + 26, 124); context.lineTo(cx + 21, 124); context.lineTo(cx + 23, 86); context.lineTo(cx + 11, 81); context.closePath(); context.fill();
      context.strokeStyle = "#16191b"; context.lineWidth = 4; context.beginPath(); context.arc(cx - 19, 70, 8, 0, Math.PI * 2); context.stroke();
      context.fillStyle = "#f1efe6"; context.fillRect(cx - 19, 102, 38, 8);
      context.fillStyle = "rgba(22,25,27,.4)";
      for (const [px, py, r] of [[cx - 4, 56, 9], [cx + 10, 46, 11], [cx + 27, 54, 8]]) { context.beginPath(); context.arc(px, py, r, 0, Math.PI * 2); context.fill(); }
      context.strokeStyle = "#c8281e"; context.lineWidth = 14; context.beginPath(); context.moveTo(cx - 56, 48); context.lineTo(cx + 56, 160); context.stroke();
    }, "NO SMOKES");
    round("scope", "#d9a21f", "#d9a21f", (w) => {
      // A telescopic sight picture, struck through.
      const cx = w / 2, cy = 96;
      context.strokeStyle = "#16191b"; context.lineWidth = 9; context.beginPath(); context.arc(cx, cy, 44, 0, Math.PI * 2); context.stroke();
      context.lineWidth = 4;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { context.beginPath(); context.moveTo(cx + dx * 10, cy + dy * 10); context.lineTo(cx + dx * 42, cy + dy * 42); context.stroke(); }
      context.strokeStyle = "#c8281e"; context.lineWidth = 12; context.beginPath(); context.moveTo(cx - 40, cy - 40); context.lineTo(cx + 40, cy + 40); context.stroke();
      text("AIM FIRST", cx, 163, 14, "#16191b", "800", "center", 1);
    }, "NO-SCOPE ZONE");
    round("fire", "#c8281e", "#c8281e", (w) => {
      context.fillStyle = "#fff"; context.fillRect(w / 2 - 20, 70, 40, 84); context.fillRect(w / 2 - 9, 52, 18, 20); context.fillRect(w / 2 - 34, 56, 30, 9);
    }, "FOR FIRE. NOT TILT.");
    // Distribution board door.
    region("panel", (w, h) => {
      context.fillStyle = "#8f979b"; context.fillRect(0, 0, w, h);
      context.strokeStyle = "#5b6266"; context.lineWidth = 6; context.strokeRect(14, 14, w - 28, h - 28);
      context.fillStyle = "#d9a21f"; context.beginPath(); context.moveTo(92, 52); context.lineTo(148, 150); context.lineTo(36, 150); context.closePath(); context.fill();
      context.fillStyle = "#16191b"; context.beginPath(); context.moveTo(98, 78); context.lineTo(82, 116); context.lineTo(96, 116); context.lineTo(86, 142); context.lineTo(108, 104); context.lineTo(94, 104); context.closePath(); context.fill();
      text("CONSOLE DB-1.6", 176, 78, 30, "#16191b", "800", "left", 0, w - 176 - 26);
      text("400 V  ·  SV_CHEATS 0  ·  ISOLATE BEFORE OPENING", 176, 118, 14, "#16191b", "600", "left", 0, w - 176 - 26);
      text("FED FROM AUTOEXEC.CFG  ·  WAY 14", 176, 144, 14, "#16191b", "600", "left", 0, w - 176 - 26);
      for (let i = 0; i < 12; i += 1) {
        const x = 40 + (i % 6) * 74, y = 196 + Math.floor(i / 6) * 86;
        context.fillStyle = "#e9e6da"; context.fillRect(x, y, 62, 22);
        // Ways 5 and 10 are the ones switched off.
        text(["FPS_MAX", "NET_GRAPH", "VIEWMODEL", "CROSSHAIR", "NOCLIP", "MWHEEL", "CL_BOB", "RATE", "SENS", "SV_CHEATS", "4:3", "SPARE"][i], x + 31, y + 12, 11, "#16191b", "700", "center", 0, 58);
        context.fillStyle = "#20262a"; context.fillRect(x + 14, y + 28, 34, 44);
        context.fillStyle = i % 5 === 4 ? "#c8281e" : "#3c9a52"; context.fillRect(x + 24, y + (i % 5 === 4 ? 52 : 34), 14, 14);
      }
      grime(0, 0, w, h, 53, 0.07);
    });
    // Hazard board over the bay by the firing line, chevrons along both edges.
    region("bind", (w, h) => {
      context.fillStyle = "#d9a21f"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#16191b";
      for (let x = -h; x < w; x += 64) for (const [foot, top] of [[h, h - 34], [34, 0]]) { context.beginPath(); context.moveTo(x, foot); context.lineTo(x + 32, foot); context.lineTo(x + 66, top); context.lineTo(x + 34, top); context.closePath(); context.fill(); }
      text("JUMP-THROW:", w / 2, 78, 74, "#16191b", "800", "center", 4, w - 70);
      text("BIND BEFORE FLIGHT", w / 2, 148, 74, "#16191b", "800", "center", 4, w - 70);
      text("ALIAS \"+JT\" \"+JUMP;-ATTACK\"   ·   NO BIND, NO PUSHBACK", w / 2, 202, 21, "#16191b", "700", "center", 2, w - 70);
      grime(0, 0, w, h, 247, 0.07);
    });
    // The red streamer, as a banner on the hangar wall.
    region("decoy", (w, h) => {
      context.fillStyle = "#c8281e"; context.fillRect(0, 0, w, h);
      text("REMOVE DECOY BEFORE FLIGHT", w / 2, h * 0.42, h * 0.34, "#f1efe6", "800", "center", 4, w - 70);
      text("CHECK INTAKES, GEAR BAYS AND POCKETS   ·   ONE DECOY, ONE GO-AROUND", w / 2, h * 0.7, h * 0.12, "#f1efe6", "700", "center", 2, w - 70);
      grime(0, 0, w, h, 338, 0.07);
    });
    // Route board over the next bay: painted, with the day's states on slats. Two columns, so the names stay large.
    region("departures", (w, h) => {
      context.fillStyle = "#14283c"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#1c3550"; context.fillRect(0, 0, w, 30);
      context.fillStyle = "#d9822b"; context.fillRect(0, 30, w, 3);
      context.fillStyle = "rgba(233,236,232,.16)"; context.fillRect(w / 2 - 1, 42, 2, h - 52);
      text("DEPARTURES", 18, 16, 21, "#e9ece8", "800", "left", 3);
      text("COUNTER-STRAFE AIR   ·   TOWER: VERTIGO 128.000", w - 18, 16, 15, "#d9822b", "800", "right", 1);
      const flights: Array<[string, string, string]> = [["OFFICE", "BOARDING", "#8fd6a0"], ["ITALY", "GO GO GO", "#8fd6a0"], ["ASSAULT", "HELD: CAMPERS", "#e8b04a"], ["MILITIA", "NEGATIVE", "#f0705a"], ["AGENCY", "ON TIME", "#8fd6a0"]];
      flights.forEach(([to, state, tone], i) => {
        const x = Math.floor(i / 3) * (w / 2), y = 62 + (i % 3) * 51;
        text(to, x + 20, y, 44, "#e9ece8", "800", "left", 2);
        text(state, x + w / 2 - 20, y - 9, 22, tone, "800", "right", 1);
        text(`GATE cs_${i + 1}`, x + w / 2 - 20, y + 14, 14, "#aebccb", "700", "right", 1);
      });
      text("cs_ GATES: HOSTAGES BOARD LAST", w * 0.75, 164, 21, "#aebccb", "800", "center", 1, w / 2 - 44);
      grime(0, 0, w, h, 131, 0.05);
    });
    // Hangar planning board.
    region("plan", (w, h) => {
      context.fillStyle = "#f4f3ec"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#1c3550"; context.fillRect(0, 0, w, 40);
      text("FLEET PLAN  —  128-TICK CHECKS", 16, 21, 22, "#f4f3ec", "800", "left", 2);
      text("MR12", w - 16, 21, 22, "#d9822b", "800", "right");
      context.strokeStyle = "#39566b"; context.lineWidth = 1.5;
      for (let i = 0; i < 15; i += 1) { context.beginPath(); context.moveTo(150 + i * 60, 40); context.lineTo(150 + i * 60, h); context.stroke(); }
      ["CS-DE2", "CS-INF", "CS-NUK", "CS-AZT", "ENG 1.6", "MWHEELS"].forEach((label, i) => {
        const y = 62 + i * 33;
        text(label, 14, y, 19, "#16191b", "800", "left", 0, 130);
        context.fillStyle = ["#d9822b", "#2f6f7a", "#a33a2a", "#3c9a52", "#1c3550", "#8a6a44"][i];
        context.fillRect(160 + ((i * 97) % 300), y - 10, 180 + ((i * 131) % 380), 20);
        context.fillStyle = "rgba(22,25,27,.3)"; context.fillRect(160 + ((i * 97) % 300) + 190 + ((i * 131) % 380), y - 10, 90, 20);
        context.beginPath(); context.strokeStyle = "#c9cdc6"; context.moveTo(0, y + 17); context.lineTo(w, y + 17); context.stroke();
      });
      context.fillStyle = "#c8281e"; context.fillRect(566, 40, 3, h);
    });
    // Name board of the hangar across the apron, and the lit faces of four taxi signs.
    region("club", (w, h) => {
      context.fillStyle = "#26384a"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#7d5a2c"; context.fillRect(0, h - 7, w, 7);
      text("NOCLIP FLYING CLUB", w / 2, h / 2 - 1, 38, "#a9b1af", "800", "center", 5, w - 28);
    });
    region("taxi", (w, h) => {
      ([["#e0ad16", "#141414", "A \u2192", 40], ["#141414", "#e0ad16", "B", 46], ["#e0ad16", "#141414", "64", 46], ["#e0ad16", "#141414", "128", 46]] as Array<[string, string, string, number]>).forEach(([background, ink, value, px], i) => {
        context.fillStyle = background; context.fillRect(i * 128, 0, 128, h);
        context.strokeStyle = ink; context.lineWidth = 3; context.strokeRect(i * 128 + 5, 5, 118, h - 10);
        text(value, i * 128 + 64, h / 2 + 2, px, ink, "800", "center", 1, 100);
      });
    });
    // Small labels and tags cut from one strip.
    region("tags", (w, h) => {
      context.fillStyle = "#f1efe6"; context.fillRect(0, 0, w, h);
      const tag = (x: number, colour: string, ink: string, head: string, sub: string) => {
        context.fillStyle = colour; context.fillRect(x, 0, 128, h);
        context.strokeStyle = ink; context.lineWidth = 3; context.strokeRect(x + 5, 5, 118, h - 10);
        text(head, x + 64, 50, 30, ink, "800", "center", 0, 104);
        text(sub, x + 64, 88, 13, ink, "700", "center", 0, 104);
      };
      tag(0, "#c8281e", "#f1efe6", "DO NOT PEEK", "AWP ON ANGLE");
      tag(128, "#1c3550", "#e9ece8", "SKILL ISSUE", "UNSERVICEABLE");
      tag(256, "#3c9a52", "#f1efe6", "GG WP", "SERVICEABLE");
      tag(384, "#d9a21f", "#16191b", "NT", "SCRAP: NICE TRY");
    });
    // Range rule over the shop window, between hazard chevrons.
    region("noscope", (w, h) => {
      context.fillStyle = "#d9a21f"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#16191b";
      for (const x0 of [0, w - 118]) for (let x = x0 - h; x < x0 + 118; x += 56) { context.beginPath(); context.moveTo(x, h); context.lineTo(x + 28, h); context.lineTo(x + 28 + h, 0); context.lineTo(x + h, 0); context.closePath(); context.fill(); }
      context.fillStyle = "#d9a21f"; context.fillRect(118, 0, w - 236, h);
      context.strokeStyle = "#16191b"; context.lineWidth = 5; context.strokeRect(120.5, 2.5, w - 241, h - 5);
      text("NO-SCOPE ZONE", w / 2, 50, 86, "#16191b", "800", "center", 6, w - 290);
      text("QUICK-SCOPES BY PRIOR PERMISSION ONLY   ·   AIM FIRST, THEN FLY", w / 2, 104, 20, "#16191b", "700", "center", 2, w - 290);
      grime(0, 0, w, h, 419, 0.07);
    });
  });
}

/** Profiled sheeting as a multiply map for the hangars across the field: ribs, lap joints, rain streaks, odd sheets. Tiles every six metres. */
function sheetingTexture() {
  return canvasTexture(512, 512, (context) => {
    context.fillStyle = "#ededed"; context.fillRect(0, 0, 512, 512);
    let seed = 6113;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 22; i += 1) { context.fillStyle = `rgba(${next() > 0.5 ? "255,255,255" : "0,0,0"},${0.03 + next() * 0.06})`; context.fillRect(Math.floor(next() * 16) * 32, 0, 32 * (1 + Math.floor(next() * 3)), 512); }
    for (let x = 0; x < 512; x += 32) { context.fillStyle = "rgba(0,0,0,.15)"; context.fillRect(x, 0, 4, 512); context.fillStyle = "rgba(255,255,255,.5)"; context.fillRect(x + 4, 0, 3, 512); }
    for (let i = 0; i < 170; i += 1) {
      const x = next() * 512, y = next() * 512, length = 40 + next() * 260, streak = context.createLinearGradient(0, y, 0, y + length);
      streak.addColorStop(0, `rgba(58,44,28,${0.05 + next() * 0.1})`); streak.addColorStop(1, "rgba(58,44,28,0)");
      context.fillStyle = streak; context.fillRect(x, y, 2 + next() * 8, length);
    }
    for (const y of [0, 256]) { context.fillStyle = "rgba(0,0,0,.28)"; context.fillRect(0, y, 512, 3); context.fillStyle = "rgba(255,255,255,.4)"; context.fillRect(0, y + 3, 512, 2); }
  }, true);
}

/** The wall display in the planning office: the aircraft in work, set large enough to read from the range floor. */
function statusTexture() {
  return canvasTexture(1024, 512, (context) => {
    const sans = '"Helvetica Neue", Arial, sans-serif';
    const fitted = (value: string, weight: string, px: number, max: number) => {
      context.font = `${weight} ${px}px ${sans}`;
      const wide = context.measureText(value).width;
      if (wide > max) context.font = `${weight} ${(px * max) / wide}px ${sans}`;
    };
    context.fillStyle = "#061016"; context.fillRect(0, 0, 1024, 512);
    context.textBaseline = "middle";
    context.fillStyle = "#8ef5e3"; context.font = `700 34px ${sans}`;
    context.fillText("LINE STATUS  ·  CS-DE2  ·  STAND 2", 32, 38);
    context.fillStyle = "#e89a42"; context.textAlign = "right"; context.fillText("1:55", 992, 38);
    context.fillStyle = "#8ef5e3"; context.fillRect(32, 64, 960, 3);
    context.textAlign = "left";
    context.fillStyle = "#e89a42"; fitted("128-TICK", "800", 178, 944); context.fillText("128-TICK", 30, 160);
    context.fillStyle = "#e6f4f2"; fitted("C-CHECK", "800", 178, 944); context.fillText("C-CHECK", 30, 318);
    // Progress, and what the hangar thinks of shorter intervals.
    context.fillStyle = "rgba(142,245,227,.16)"; context.fillRect(40, 408, 830, 28);
    context.fillStyle = "#8ef5e3"; context.fillRect(40, 408, 830 * 0.62, 28);
    context.fillStyle = "#e6f4f2"; context.font = `700 34px ${sans}`; context.textAlign = "right"; context.fillText("62 %", 986, 423);
    context.fillStyle = "#9fb8bb"; context.font = `600 26px ${sans}`; context.textAlign = "left"; context.fillText("64-TICK CHECKS NOT ACCEPTED", 40, 476);
    context.fillStyle = "#ff5a48"; context.font = `700 26px ${sans}`; context.textAlign = "right"; context.fillText("CS-NUK  AOG · NO 2 PROP", 986, 476);
  });
}

export function buildHangar(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  // One wind for the whole place: it comes in off the apron through the open doors, in gusts, and everything that
  // moves in air reads it (plants, birds, blown leaves, the windsock, the idle propeller, the hoist chain).
  const wind = createWind({ heading: 3.45, strength: 0.4, gustiness: 0.62 });
  const daylight: { sun: THREE.DirectionalLight | null } = { sun: null };
  const trees = createTrees(kit, { seed: 2041, wind, sun: () => daylight.sun ?? TO_SUN });
  const life = createLife(kit, options, { wind, seed: 2041 });
  // Its own dice, so nothing here shifts the seeded layout of the stores.
  let lifeSeed = 77411;
  const chance = () => { lifeSeed = (lifeSeed * 1664525 + 1013904223) >>> 0; return lifeSeed / 4294967296; };
  const metals = kit.metals();

  // ---- Materials -----------------------------------------------------------
  const FLOOR = { width: 230, depth: 73, z: 3.5 };
  const slab = photoSet("/textures/concrete_floor_worn_001-2k", FLOOR.width / 4.6, FLOOR.depth / 4.6);
  const brick = photoSet("/textures/brick_wall_001-2k", 1, 1);
  const corrugated = photoSet("/textures/corrugated_iron_02-2k", 1, 1, false);
  const treadPlate = photoSet("/textures/metal_plate-2k", 1, 1, false);
  const castWall = photoSet("/textures/concrete_wall_007-2k", 1, 1, false);
  const asphalt = photoSet("/textures/asphalt_02-2k", FLOOR.width / 6, 3, false);
  const hardpan = photoSet("/textures/sandstone_cracks-2k", 1, 1, false);
  const paint = (rgb: V3, seed: number, wear: number, size = 512, extra: THREE.MeshStandardMaterialParameters = {}) =>
    pbrMaterial(keep(paintedSteel(anisotropy, rgb, seed, wear, size)), { envMapIntensity: 0.9, ...extra });
  // The sheeting photo is bare, dark iron: the tints are pushed past white to bring it up to pale paint.
  const cladding = new THREE.MeshStandardMaterial({ ...corrugated, normalScale: new THREE.Vector2(1.5, 1.5), color: new THREE.Color(2.5, 2.9, 3.0), roughness: 0.82, metalness: 0.12, envMapIntensity: 0.8 });
  const doorPaint = new THREE.MeshStandardMaterial({ ...corrugated, normalScale: new THREE.Vector2(1.5, 1.5), color: new THREE.Color(1.2, 1.95, 2.4), roughness: 0.85, metalness: 0.12, envMapIntensity: 0.8 });
  const officePaint = paint([0.56, 0.58, 0.56], 829, 0.2);
  const yellow = paint([0.72, 0.46, 0.035], 839, 0.6);
  const red = paint([0.46, 0.035, 0.03], 853, 0.35);
  const skin = paint([0.6, 0.62, 0.62], 857, 0.1, 1024, { side: THREE.DoubleSide, envMapIntensity: 1 });
  const bluePaint = paint([0.08, 0.2, 0.36], 311, 0.75);
  const deckMaterial = pbrMaterial(keep(roofDeck(anisotropy, 41)), { envMapIntensity: 0.8, side: THREE.DoubleSide, normalScale: new THREE.Vector2(1.2, 1.2) });
  const concrete = new THREE.MeshStandardMaterial({ ...castWall, normalScale: new THREE.Vector2(0.9, 0.9), color: 0xc9c5b8, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 });
  const panel = new THREE.MeshStandardMaterial({ ...castWall, normalScale: new THREE.Vector2(1.1, 1.1), color: 0xb9c6c8, roughness: 0.9, metalness: 0, envMapIntensity: 0.8 });
  const plaster = new THREE.MeshStandardMaterial({ ...castWall, normalScale: new THREE.Vector2(0.4, 0.4), color: 0xe6e2d2, roughness: 0.95, metalness: 0, envMapIntensity: 0.4 });
  const brickMaterial = new THREE.MeshStandardMaterial({ ...brick, normalScale: new THREE.Vector2(1.25, 1.25), color: 0xc4b6a8, roughness: 0.96, metalness: 0, aoMapIntensity: 0.9, envMapIntensity: 0.45 });
  const plateMaterial = new THREE.MeshStandardMaterial({ ...treadPlate, normalScale: new THREE.Vector2(1.4, 1.4), color: 0x9aa3a8, roughness: 0.7, metalness: 0.75, envMapIntensity: 0.9 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.88, metalness: 0, envMapIntensity: 0.5 });
  // Plain paints and plastics share one material and take their colour from the vertices; so do the two cabin trims.
  const plainPaint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
  const cabinTrim = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.3 });
  const darkGlass = new THREE.MeshPhysicalMaterial({ color: 0x0a1418, roughness: 0.08, metalness: 0, envMapIntensity: 1.6 });
  const clearGlass = new THREE.MeshPhysicalMaterial({ color: 0x9fc0c4, transparent: true, opacity: 0.2, roughness: 0.05, metalness: 0, envMapIntensity: 1.8, side: THREE.DoubleSide, depthWrite: false });
  const emissive = (hex: number, gain: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(gain), toneMapped: false });
  const hazardMap = track(hazardTexture());
  hazardMap.anisotropy = anisotropy;
  const hazardPaint = new THREE.MeshStandardMaterial({ map: hazardMap, roughness: 0.5, metalness: 0, envMapIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const sheet = track(signSheet());
  sheet.anisotropy = anisotropy;
  const signMaterial = new THREE.MeshStandardMaterial({ map: sheet, roughness: 0.6, metalness: 0, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const status = track(statusTexture());
  status.anisotropy = anisotropy;

  // ---- Batches: static geometry merged per material ---------------------------
  // `frame` is the current local-to-world transform; `within` nests one.
  const frame = new THREE.Matrix4();
  const scratch = { m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler(), s: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() };
  const UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);
  const within = (x: number, y: number, z: number, yaw: number, build: () => void, scale = 1) => {
    const saved = frame.clone();
    frame.multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(scale, scale, scale)));
    build();
    frame.copy(saved);
  };
  /** `flat` paints each piece in its own colour through the vertices, so one material and one draw serve many paints; `into` parents the mesh to something that moves. */
  // Flashing lights of the field (the beacon, obstruction lamps, the departing aircraft's own) are one set of points
  // timed in the shader. Each is [x, y, z, r, g, b, period, phase, width, rest, size].
  const lamps: number[][] = [];
  /** A lamp that pulses every `period` seconds: `width` is the pulse as a share of the period, `rest` the level between pulses. */
  const lamp = (x: number, y: number, z: number, hex: number, gain: number, size: number, period: number, phase = 0, width = 0.2, rest = 0) => {
    const at = new THREE.Vector3(x, y, z).applyMatrix4(frame), colour = new THREE.Color(hex).multiplyScalar(gain);
    lamps.push([at.x, at.y, at.z, colour.r, colour.g, colour.b, period, phase, width, rest, size]);
    return lamps.length - 1;
  };
  type BatchOptions = { shadow?: boolean; metres?: number; fine?: boolean; mirror?: boolean; hit?: boolean; baked?: boolean | "sun"; flat?: boolean; order?: number; into?: THREE.Object3D };
  const pending: Array<() => void> = [];
  // Outdoor pieces are lit once, here: the sun, the sky above, the bright apron below and a glint toward the doors.
  const glintAxis = TO_SUN.clone().add(new THREE.Vector3(0, 0.06, 1)).normalize();
  const batch = (material: THREE.Material, o: BatchOptions = {}): Batch => {
    const parts: THREE.BufferGeometry[] = [];
    const skip = !!o.fine && !high;
    const keepNames = o.baked || o.flat ? ["position", "normal", "uv", "color"] : ["position", "normal", "uv"];
    const push = (source: THREE.BufferGeometry, matrix: THREE.Matrix4, tint?: number, shine = 0, glow = 0) => {
      if (skip) { source.dispose(); return; }
      const geometry = source.index ? source.toNonIndexed() : source;
      if (geometry !== source) source.dispose();
      for (const name of Object.keys(geometry.attributes)) if (!keepNames.includes(name)) geometry.deleteAttribute(name);
      geometry.morphAttributes = {};
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      const count = geometry.attributes.position.count;
      if (!geometry.attributes.uv) geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      geometry.applyMatrix4(scratch.m.copy(frame).multiply(matrix));
      if (o.baked) {
        const colour = new THREE.Color(tint ?? 0xffffff), normal = geometry.attributes.normal, position = geometry.attributes.position, colours = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) {
          const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
          let r: number, g: number, b: number, glint = 0;
          if (o.baked === "sun") {
            // Warm sun, blue sky from above, warm bounce off the apron from below; less of both close to the ground.
            const open = 0.74 + 0.26 * THREE.MathUtils.smoothstep(position.getY(i), 0, 3.5);
            const direct = SUN_GAIN * Math.max(0, nx * TO_SUN.x + ny * TO_SUN.y + nz * TO_SUN.z), sky = (0.25 + 0.2 * ny) * open, bounce = (0.24 - 0.2 * ny) * open;
            r = direct + sky * 0.8 + bounce * 1.06 + glow; g = direct * 0.9 + sky * 0.93 + bounce * 0.93 + glow; b = direct * 0.76 + sky * 1.18 + bounce * 0.74 + glow;
            if (shine) glint = shine * Math.max(0, nx * glintAxis.x + ny * glintAxis.y + nz * glintAxis.z) ** 36;
          } else {
            // Light the piece once, from the ceiling tubes.
            r = g = b = (0.58 + 0.42 * Math.max(0, -0.42 * nx + 0.82 * ny + 0.2 * nz) + (ny < -0.5 ? 0.3 : 0)) * (0.72 + 0.28 * THREE.MathUtils.smoothstep(position.getY(i), 4.8, 7.6));
          }
          colours[i * 3] = colour.r * r + glint; colours[i * 3 + 1] = colour.g * g + glint; colours[i * 3 + 2] = colour.b * b + glint;
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      } else if (o.flat) {
        // The third figure of `tinted` is a gain here: self-lit pieces carry their brightness in the colour.
        const colour = new THREE.Color(tint ?? 0xffffff).multiplyScalar(glow || 1), colours = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) { colours[i * 3] = colour.r; colours[i * 3 + 1] = colour.g; colours[i * 3 + 2] = colour.b; }
        geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      }
      parts.push(geometry);
    };
    const local = (x: number, y: number, z: number, r?: V3, s?: V3) => new THREE.Matrix4().compose(scratch.p.set(x, y, z), scratch.q.setFromEuler(scratch.e.set(...(r ?? [0, 0, 0] as V3))), scratch.s.set(...(s ?? [1, 1, 1] as V3)));
    const make = (fixed?: number, shine = 0, glow = 0): Batch => {
      const api: Batch = {
        add(geometry, x = 0, y = 0, z = 0, r, s, tint) { push(geometry, local(x, y, z, r, s), tint ?? fixed, shine, glow); return api; },
        box(w, h, d, x, y, z, r, tint) { push(new THREE.BoxGeometry(w, h, d), local(x, y, z, r), tint ?? fixed, shine, glow); return api; },
        rbox(w, h, d, radius, x, y, z, r) { push(new RoundedBoxGeometry(w, h, d, 2, radius), local(x, y, z, r), fixed, shine, glow); return api; },
        cyl(top, bottom, h, x, y, z, r, segments = 12, open = false, tint) { push(new THREE.CylinderGeometry(top, bottom, h, segments, 1, open), local(x, y, z, r), tint ?? fixed, shine, glow); return api; },
        sphere(radius, x, y, z, s, segments = 12) { push(new THREE.SphereGeometry(radius, segments, Math.max(6, Math.round(segments * 0.6))), local(x, y, z, undefined, s), fixed, shine, glow); return api; },
        torus(radius, tube, x, y, z, r, segments = 20, s) { push(new THREE.TorusGeometry(radius, tube, 6, segments), local(x, y, z, r, s), fixed, shine, glow); return api; },
        rod(a, b, radius, segments = 8) {
          scratch.a.set(...a); scratch.b.set(...b);
          const length = scratch.b.distanceTo(scratch.a);
          const q = new THREE.Quaternion().setFromUnitVectors(UP, scratch.b.clone().sub(scratch.a).normalize());
          push(new THREE.CylinderGeometry(radius, radius, length, segments), new THREE.Matrix4().compose(scratch.a.clone().add(scratch.b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), fixed, shine, glow);
          return api;
        },
        bar(a, b, t, depth = t) {
          scratch.a.set(...a); scratch.b.set(...b);
          const length = scratch.b.distanceTo(scratch.a);
          const q = new THREE.Quaternion().setFromUnitVectors(RIGHT, scratch.b.clone().sub(scratch.a).normalize());
          push(new THREE.BoxGeometry(length, t, depth), new THREE.Matrix4().compose(scratch.a.clone().add(scratch.b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), fixed, shine, glow);
          return api;
        },
        pipe(points, radius, segments = 32, radial = 6) {
          push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), segments, radius, radial, false), new THREE.Matrix4(), fixed, shine, glow);
          return api;
        },
        tinted(tint, sheen = 0, light = 0) { return make(tint, sheen, light); },
      };
      return api;
    };
    pending.push(() => {
      if (!parts.length) return;
      const merged = mergeGeometries(parts, false);
      parts.forEach((part) => part.dispose());
      if (o.metres) projectUv(merged, o.metres);
      const mesh = new THREE.Mesh(track(merged), material);
      mesh.castShadow = !!o.shadow;
      mesh.receiveShadow = true;
      if (o.order !== undefined) mesh.renderOrder = o.order;
      (o.into ?? scene).add(mesh);
      if (o.hit) kit.shootable.push(mesh);
      if (o.mirror === false || o.fine) kit.mirrorHidden.push(mesh);
    });
    return make();
  };
  /** Position-first box and bar calls, as the structural code reads best. */
  const members = (b: Batch) => {
    const set = {
      b,
      box(x: number, y: number, z: number, w: number, h: number, d: number, rotation?: V3) { b.box(w, h, d, x, y, z, rotation); return set; },
      bar(a: V3, c: V3, t: number, depth = t) { b.bar(a, c, t, depth); return set; },
    };
    return set;
  };
  const steelB = batch(metals.structural, { shadow: true }), darkB = batch(metals.darkMetal, { shadow: true }), yellowB = batch(yellow, { shadow: true }), brightB = batch(metals.brushed, { shadow: true });
  const steelwork = members(steelB), darkwork = members(darkB), yellowwork = members(yellowB), brightwork = members(brightB);
  const redB = batch(red, { shadow: true }), whiteB = batch(officePaint, { shadow: true }), machineB = batch(metals.machine, { shadow: true });
  const paintB = batch(plainPaint, { flat: true, mirror: false }), trimB = batch(cabinTrim, { flat: true, mirror: false });
  // Black rubber leaves nothing to see in the slab's dull mirror, so the tyres stay out of that pass.
  const rubberB = batch(rubber, { shadow: true, mirror: false }), hoseB = paintB.tinted(0xb8861a), skinB = batch(skin, { shadow: true }), glassB = batch(darkGlass, { mirror: false }), clearB = batch(clearGlass, { mirror: false });
  const concreteB = batch(concrete, { shadow: true, metres: 2.4, hit: true }), plasterB = batch(plaster, { metres: 3 }), claddingB = batch(cladding, { shadow: true, metres: 2.4, hit: true }), deckB = batch(deckMaterial, { shadow: true });
  const panelB = batch(panel, { shadow: true, metres: 2.8, hit: true }), brickB = batch(brickMaterial, { shadow: true, metres: 2.8, hit: true }), doorB = batch(doorPaint, { shadow: true, metres: 2.2 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xd8e8ea, transparent: true, opacity: 0.14, roughness: 0.08, metalness: 0, envMapIntensity: 1.4, side: THREE.DoubleSide, depthWrite: false });
  const roofGlass = batch(glass, { mirror: false }), hazardB = batch(hazardPaint, { mirror: false });
  // Everything beyond the doors stands in open sun, outside the shadow frame and the hall's light probe: it is lit once, into its vertices.
  const farMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  const farB = batch(farMaterial, { baked: "sun", mirror: false });
  const sheeting = track(sheetingTexture());
  sheeting.anisotropy = anisotropy;
  const farSheetMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, map: sheeting });
  const farSheetB = batch(farSheetMaterial, { baked: "sun", mirror: false, metres: 6 });
  const plateB = batch(plateMaterial, { shadow: true, metres: 1.3 }), timberB = batch(metals.crate, { shadow: true }), clothB = trimB.tinted(0x2b3a4a), liningB = trimB.tinted(0x3a4044);
  const orangeB = paintB.tinted(0xd9571c), plasticB = paintB.tinted(0xe9e6dc), blueB = batch(bluePaint, { shadow: true });
  // Clutter that only the full-quality tier carries.
  const fineSteel = batch(metals.structural, { fine: true }), fineDark = batch(metals.darkMetal, { fine: true }), fineBright = batch(metals.brushed, { fine: true }), fineRed = batch(red, { fine: true }), fineYellow = batch(yellow, { fine: true });
  // Self-lit pieces stay readable when wave mode kills the lamps.
  const glowB = batch(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), { flat: true, mirror: false });
  const warmGlow = glowB.tinted(0xffd9a0, 0, 3.2), coolGlow = glowB.tinted(0xe6f4ff, 0, 3.2), mintGlow = glowB.tinted(BRAND, 0, 1.6);
  const redGlow = glowB.tinted(0xff2a1c, 0, 3), greenGlow = glowB.tinted(0x2cff7a, 0, 2.4), amberGlow = glowB.tinted(0xff8a1c, 0, 2.6);
  const signB = batch(signMaterial, { mirror: false }), statusB = batch(new THREE.MeshBasicMaterial({ map: status, color: new THREE.Color(1.5, 1.5, 1.5), toneMapped: false }), { mirror: false });
  const bakedB = batch(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), { baked: true, mirror: false });

  /** A flat sign cut from the sheet, facing +z before `r`. */
  const sign = (name: SignName, w: number, h: number, x: number, y: number, z: number, r?: V3, into: Batch = signB, cut: [number, number] = [0, 1]) => {
    const [x0, sy, full, sh] = SIGNS[name], sx = x0 + full * cut[0], sw = full * (cut[1] - cut[0]);
    const geometry = new THREE.PlaneGeometry(w, h), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (sx + uv.getX(i) * sw) / SHEET, 1 - (sy + (1 - uv.getY(i)) * sh) / SHEET);
    into.add(geometry, x, y, z, r);
  };
  /** Tyre with rounded shoulders on a dished hub; the axle runs along local x (or z). */
  const wheel = (x: number, y: number, z: number, radius: number, width: number, hub: Batch, along: "x" | "y" | "z" = "x", segments = 22) => {
    const w = width / 2, rim = radius * 0.56;
    // Big tyres carry three circumferential grooves across the tread.
    const tread = radius < 0.4 ? [[radius, -w * 0.45], [radius, w * 0.45]] : [-0.45, -0.3, 0, 0.3, 0.45].flatMap((f, i) => (i === 0 || i === 4 ? [[radius, w * f]] : [[radius, w * (f - 0.055)], [radius * 0.968, w * (f - 0.02)], [radius * 0.968, w * (f + 0.02)], [radius, w * (f + 0.055)]]));
    const tyre = new THREE.LatheGeometry([[rim, -w * 0.82], [radius * 0.84, -w], [radius * 0.96, -w * 0.82], ...tread, [radius * 0.96, w * 0.82], [radius * 0.84, w], [rim, w * 0.82]].map(([r, h]) => new THREE.Vector2(r, h)), segments);
    const dish = new THREE.LatheGeometry([[0, w * 0.5], [rim * 0.28, w * 0.5], [rim * 0.36, w * 0.3], [rim * 0.86, w * 0.42], [rim * 1.02, w * 0.84], [rim * 1.02, -w * 0.84], [rim * 0.86, -w * 0.42], [rim * 0.36, -w * 0.3], [rim * 0.28, -w * 0.5], [0, -w * 0.5]].map(([r, h]) => new THREE.Vector2(r, h)), segments);
    const r: V3 = along === "x" ? [0, 0, Math.PI / 2] : along === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    rubberB.add(tyre, x, y, z, r);
    hub.add(dish, x, y, z, r);
  };

  let randomSeed = 20417;
  const random = () => { randomSeed = (randomSeed * 1664525 + 1013904223) >>> 0; return randomSeed / 4294967296; };

  // Crates, drums, kegs, pallets, cartons and tins come from the shared props library. `put` works in the current
  // frame and gathers them per kind, so each kind is instanced once for the whole map.
  const props = createProps(kit);
  const stock = new Map<PropKind, PropItem[]>();
  const put = (kind: PropKind, x: number, y: number, z: number, yaw = 0, more: { tilt?: number; tint?: number; tint2?: number; variant?: number } = {}) => {
    const { tilt = 0, ...look } = more;
    const position = new THREE.Vector3(), turn = new THREE.Quaternion(), size = new THREE.Vector3();
    scratch.m.copy(frame).multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1))).decompose(position, turn, size);
    const rotation = new THREE.Euler().setFromQuaternion(turn);
    if (!stock.has(kind)) stock.set(kind, []);
    stock.get(kind)!.push({ ...look, position: [position.x, position.y, position.z], rotation: [rotation.x, rotation.y, rotation.z], scale: [size.x, size.y, size.z] });
  };
  /** How high a kind stands, for stacking. */
  const tall = (kind: PropKind) => props.get(kind).size[1];
  const DECK = tall("pallet"), CRATE_TOP = DECK + tall("crateLarge"), AMMO = tall("crateAmmo"), TOTE = tall("cratePlastic");

  // ---- Floor ---------------------------------------------------------------
  // The mirror slab covers the hall only, so the range lane stops at the door line; the apron is laid separately.
  const floorMaterial = new THREE.MeshStandardMaterial({ ...slab, normalScale: new THREE.Vector2(1.1, 1.1), color: 0xc4c5c0, roughness: 0.86, metalness: 0, aoMapIntensity: 0.85, envMapIntensity: 0.4 });
  const reflection = kit.floor(floorMaterial, FLOOR, {
    lane: new THREE.Color(0.8, 0.56, 0.07),
    edge: new THREE.Color(0.66, 0.64, 0.56),
    wet: -0.2,
  });
  // Outdoor ground looks toward the sun at a grazing angle: its highlight is held down so the apron does not burn out.
  const apronMaterial = new THREE.MeshPhysicalMaterial({ ...slab, normalScale: new THREE.Vector2(1.1, 1.1), color: new THREE.Color(1.42, 1.36, 1.24), roughness: 0.95, metalness: 0, aoMapIntensity: 0.85, envMapIntensity: 0.35, specularIntensity: 0.22 });
  const taxiMaterial = new THREE.MeshPhysicalMaterial({ ...asphalt, normalScale: new THREE.Vector2(1.2, 1.2), color: new THREE.Color(0.86, 0.85, 0.83), roughness: 0.95, metalness: 0, envMapIntensity: 0.3, specularIntensity: 0.22 });
  const desertMaterial = new THREE.MeshPhysicalMaterial({ map: hardpan.map, normalMap: hardpan.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), color: new THREE.Color(1.18, 1.0, 0.82), roughness: 1, metalness: 0, envMapIntensity: 0.15, specularIntensity: 0.08 });
  const FLOOR_EDGE = FLOOR.z - FLOOR.depth / 2, APRON_X = 190;
  /** A strip of outdoor ground; `tile` is the world size one unit of UV covers, so paving keeps its scale. */
  const groundQuad = (x0: number, x1: number, z0: number, z1: number, tile: [number, number], y = 0) => {
    const geometry = new THREE.PlaneGeometry(x1 - x0, z0 - z1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    const uv = geometry.attributes.uv, position = geometry.attributes.position;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, position.getX(i) / tile[0], -position.getZ(i) / tile[1]);
    return geometry;
  };
  const lay = (material: THREE.Material, quads: THREE.BufferGeometry[], hit = true) => {
    const mesh = new THREE.Mesh(track(mergeGeometries(quads)), material);
    quads.forEach((quad) => quad.dispose());
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (hit) kit.shootable.push(mesh);
    kit.mirrorHidden.push(mesh);
  };
  // Hangar apron, taxi lane and remote stands; around them the dry pan the airfield was levelled out of, a step lower.
  lay(apronMaterial, [groundQuad(-APRON_X, APRON_X, FLOOR_EDGE, -64.5, [FLOOR.width, FLOOR.depth]), groundQuad(-APRON_X, APRON_X, -82.5, -126, [FLOOR.width, FLOOR.depth]), groundQuad(-150, 150, -134, -192, [FLOOR.width, FLOOR.depth])]);
  lay(taxiMaterial, [groundQuad(-400, 400, -64.5, -82.5, [FLOOR.width, 18]), groundQuad(-APRON_X, APRON_X, -126, -134, [FLOOR.width, 18]), groundQuad(84, 100, -134, -260, [18, FLOOR.width])]);
  lay(desertMaterial, [groundQuad(-420, 420, 60, -420, [9, 9], -0.06)], false);
  const decal = (map: THREE.Texture, width: number, depth: number, x: number, z: number) => {
    map.anisotropy = anisotropy;
    const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 0.62, metalness: 0, envMapIntensity: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), x, 0.006, z, false);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -8;
    return mesh;
  };
  decal(track(standTexture(24, 40.4)), 24, 40.4, -22, -10.5);
  decal(track(apronTexture()), 84, 84, -8, -73.4);
  // Door tracks: a pair of rails either side of a groove for each leaf line, between tread-plate thresholds over the drain.
  for (const z of TRACKS) {
    for (const o of [-0.055, 0.055]) steelwork.box(XC, 0.014, z + o, 54, 0.028, 0.035);
    darkwork.box(XC, 0.004, z, 54, 0.008, 0.075);
  }
  plateB.box(34, 0.02, 0.4, (DOOR_CLEAR.x0 + DOOR_CLEAR.x1) / 2, 0.004, -30.55).box(34, 0.02, 0.3, (DOOR_CLEAR.x0 + DOOR_CLEAR.x1) / 2, 0.004, -31.54);

  // ---- Hall shell ----------------------------------------------------------
  /** A hazard-striped strip facing +z before `r`; one stripe pair per 0.8 m. */
  const hazardStrip = (w: number, h: number, x: number, y: number, z: number, r?: V3) => {
    const geometry = new THREE.PlaneGeometry(w, h), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * (w / 0.8));
    hazardB.add(geometry, x, y, z, r);
  };
  /** A pane of glass in an opening, facing +z before `r`. */
  const pane = (w: number, h: number, x: number, y: number, z: number, r?: V3) => roofGlass.add(new THREE.PlaneGeometry(w, h), x, y, z, r);
  // Side walls: sheeting below and above a clerestory that is a real opening onto the sky, glazed in steel sashes.
  const wallHeight = EAVE + 0.4, band = { y0: 8.1, y1: 10.7, z0: -29.5, z1: 8.5 };
  const wallPiers = [band.z1 + 1.05, ...TRUSS_Z.slice(1, 5), band.z0 - 1.05].map((z, i, all) => [z, i === 0 || i === all.length - 1 ? 2.1 : 0.7]);
  for (const [x, side] of [[HALL.x0 - 0.3, 1], [HALL.x1 + 0.3, -1]] as Array<[number, number]>) {
    claddingB.box(0.6, band.y0, 42.2, x, band.y0 / 2, -10.5).box(0.6, wallHeight - band.y1, 42.2, x, (wallHeight + band.y1) / 2, -10.5);
    wallPiers.forEach(([z, width]) => claddingB.box(0.6, band.y1 - band.y0, width, x, (band.y0 + band.y1) / 2, z));
    concreteB.add(softBox(0.16, 1.5, 41.4, 0.03, 2.4), x + side * 0.36, 0.75, -10.5);
    for (let i = 0; i < wallPiers.length - 1; i += 1) {
      const z1 = wallPiers[i][0] - wallPiers[i][1] / 2, z0 = wallPiers[i + 1][0] + wallPiers[i + 1][1] / 2, lights = Math.round((z1 - z0) / 1.3);
      steelwork.box(x, band.y0 + 0.05, (z0 + z1) / 2, 0.16, 0.1, z1 - z0).box(x, band.y1 - 0.05, (z0 + z1) / 2, 0.16, 0.1, z1 - z0).box(x, 9.62, (z0 + z1) / 2, 0.055, 0.05, z1 - z0);
      for (let k = 0; k <= lights; k += 1) steelwork.box(x, (band.y0 + band.y1) / 2, z0 + 0.04 + ((z1 - z0 - 0.08) * k) / lights, k % 4 === 0 ? 0.12 : 0.07, band.y1 - band.y0 - 0.2, k % 4 === 0 ? 0.08 : 0.05);
      pane(z1 - z0 - 0.08, band.y1 - band.y0 - 0.2, x - side * 0.012, (band.y0 + band.y1) / 2, (z0 + z1) / 2, [0, side * Math.PI / 2, 0]);
    }
    // Weathering drip sill under the sashes and sheeting rails behind the cladding.
    steelwork.box(x + side * 0.33, band.y0 - 0.06, -10.5, 0.12, 0.08, 38.4);
    for (const y of [2.6, 4.6, 6.6, 11.8]) steelwork.box(x + side * 0.36, y, -10.5, 0.1, 0.16, 41.2);
  }
  // Back wall (the chart hangs on its face at z = 9.7), pierced by a row of high lights, and the gable over the doors.
  const backLights = Array.from({ length: 8 }, (_, i) => [XC - 21.75 + i * 5.5, XC - 16.75 + i * 5.5, 9, 11.4] as [number, number, number, number]);
  claddingB.add(gableGeometry(0, 0.6, backLights), 0, 0, 9.7);
  backLights.forEach(([x0, x1, y0, y1]) => {
    steelwork.box((x0 + x1) / 2, y0 + 0.05, 10, x1 - x0, 0.1, 0.16).box((x0 + x1) / 2, y1 - 0.05, 10, x1 - x0, 0.1, 0.16).box((x0 + x1) / 2, 10.42, 10, x1 - x0, 0.05, 0.055);
    for (let k = 0; k <= 4; k += 1) steelwork.box(x0 + 0.04 + ((x1 - x0 - 0.08) * k) / 4, (y0 + y1) / 2, 10, k % 4 === 0 ? 0.08 : 0.05, y1 - y0 - 0.2, k % 4 === 0 ? 0.12 : 0.07);
    pane(x1 - x0 - 0.08, y1 - y0 - 0.2, (x0 + x1) / 2, (y0 + y1) / 2, 10.012, [0, Math.PI, 0]);
  });
  steelwork.box(XC, 8.9, 9.64, 44.4, 0.08, 0.12);
  claddingB.add(gableGeometry(DOOR_TOP + 0.9, 0.5), 0, 0, HALL.zDoor - 0.25);
  // Door header: a box girder carrying the top guides, with stiffeners and a hazard band along its soffit edge.
  steelB.add(worldBox(54.6, 1, 1.5, 1.6), XC, DOOR_TOP + 0.5, HALL.zDoor - 0.55);
  hazardStrip(33.4, 0.3, (DOOR_CLEAR.x0 + DOOR_CLEAR.x1) / 2, DOOR_TOP + 0.2, HALL.zDoor + 0.212);
  for (let x = HALL.x0 + 1.5; x < HALL.x1; x += 3) { steelwork.box(x, DOOR_TOP + 0.44, HALL.zDoor + 0.235, 0.14, 0.88, 0.07); fineSteel.box(0.3, 0.3, 0.03, x, DOOR_TOP + 0.5, HALL.zDoor + 0.285); }
  // Top guides: a pair of channels under the girder for each track, on hangers.
  for (const z of TRACKS) for (const o of [-0.2, 0.2]) steelwork.box(XC, DOOR_TOP - 0.13, z + o, 54, 0.26, 0.025);
  for (let x = HALL.x0 + 2.5; x < HALL.x1; x += 4) for (const z of TRACKS) fineSteel.box(0.1, 0.05, 0.46, x, DOOR_TOP - 0.02, z);

  // Sliding door leaves, rolled back and stacked at both jambs; each has two lights at head height of a tail fin.
  const leaf = { width: 7.1, height: DOOR_TOP, y0: 6.7, y1: 8.6 };
  const leaves: Array<[number, number]> = [[-30.6, TRACKS[0]], [-27.45, TRACKS[1]], [16.3, TRACKS[0]], [13.25, TRACKS[1]]];
  leaves.forEach(([x, z]) => {
    doorB.box(leaf.width, leaf.y0, 0.18, x, leaf.y0 / 2, z).box(leaf.width, leaf.height - leaf.y1, 0.18, x, (leaf.height + leaf.y1) / 2, z);
    for (const [x0, x1] of [[-leaf.width / 2, -3.02], [-0.42, 0.42], [3.02, leaf.width / 2]]) doorB.box(x1 - x0, leaf.y1 - leaf.y0, 0.18, x + (x0 + x1) / 2, (leaf.y0 + leaf.y1) / 2, z);
    for (const ox of [-1.72, 1.72]) {
      steelwork.box(x + ox, leaf.y0 + 0.04, z, 2.6, 0.08, 0.1).box(x + ox, leaf.y1 - 0.04, z, 2.6, 0.08, 0.1).box(x + ox, (leaf.y0 + leaf.y1) / 2, z, 0.05, leaf.y1 - leaf.y0 - 0.16, 0.07).box(x + ox, 7.9, z, 2.44, 0.05, 0.05);
      for (const o of [-1.26, 1.26]) steelwork.box(x + ox + o, (leaf.y0 + leaf.y1) / 2, z, 0.08, leaf.y1 - leaf.y0 - 0.16, 0.1);
      pane(2.44, leaf.y1 - leaf.y0 - 0.16, x + ox, (leaf.y0 + leaf.y1) / 2, z + 0.02);
    }
    for (const face of [-1, 1]) {
      // The framing lies on the sheeting (never inside it); stiles stand 1 cm proud of the rails they cross.
      const fz = z + face * 0.13;
      for (const ox of [-leaf.width / 2 + 0.11, 0, leaf.width / 2 - 0.11]) steelwork.box(x + ox, leaf.height / 2, z + face * 0.135, 0.22, leaf.height, 0.09);
      for (const y of [0.16, 3.2, 6.1, 9.2, leaf.height - 0.12]) steelwork.box(x, y, fz, leaf.width, y === 0.16 ? 0.32 : 0.2, 0.08);
      // Diagonal wind bracing in the lower panels.
      for (const ox of [-1.72, 1.72]) for (const [y0, y1] of [[0.32, 3.1], [3.3, 6]]) steelwork.bar([x + ox - 1.6, y0, fz], [x + ox + 1.6, y1, fz], 0.1, 0.05).bar([x + ox - 1.6, y1, fz], [x + ox + 1.6, y0, fz], 0.1, 0.03);
    }
    // Bottom rollers in their housings, top guide rollers and a pull handle.
    for (const ox of [-2.8, -0.9, 0.9, 2.8]) {
      darkB.cyl(0.13, 0.13, 0.1, x + ox, 0.13, z, [Math.PI / 2, 0, 0], 14);
      steelwork.box(x + ox, 0.2, z, 0.42, 0.3, 0.26);
    }
    fineBright.rod([x - leaf.width / 2 + 0.3, 1.0, z + 0.2], [x - leaf.width / 2 + 0.3, 1.5, z + 0.2], 0.02);
  });

  // Roof shell: solid deck with three glazed strips across the span.
  const lightEdges = ROOFLIGHTS.flatMap((z) => [z + ROOFLIGHT_HALF, z - ROOFLIGHT_HALF]);
  const solidRuns = [HALL.zBack + 0.9, ...lightEdges, HALL.zDoor - 0.9];
  for (let i = 0; i < solidRuns.length; i += 2) deckB.add(roofBand(solidRuns[i], solidRuns[i + 1], HALL.x0 - 0.9, HALL.x1 + 0.9, 40));
  ROOFLIGHTS.forEach((z) => {
    for (const [x0, x1] of [[HALL.x0 - 0.9, XC - ROOFLIGHT_REACH], [XC + ROOFLIGHT_REACH, HALL.x1 + 0.9]]) deckB.add(roofBand(z + ROOFLIGHT_HALF, z - ROOFLIGHT_HALF, x0, x1, 6));
    roofGlass.add(roofBand(z + ROOFLIGHT_HALF, z - ROOFLIGHT_HALF, XC - ROOFLIGHT_REACH, XC + ROOFLIGHT_REACH, 32, 0.04));
    // Glazing bars print the pattern into the sun bands; kerbs frame the strip.
    const bars = 24;
    for (let i = 0; i <= bars; i += 1) {
      const x = XC - ROOFLIGHT_REACH + (2 * ROOFLIGHT_REACH * i) / bars;
      steelwork.box(x, roofY(x) - 0.03, z, i % 6 === 0 ? 0.16 : 0.07, 0.12, ROOFLIGHT_HALF * 2 + 0.2, [0, 0, roofSlope(x)]);
      if (i < bars) {
        const next = x + (2 * ROOFLIGHT_REACH) / bars;
        for (const [edge, t] of [[ROOFLIGHT_HALF + 0.06, 0.16], [-ROOFLIGHT_HALF - 0.06, 0.16], [0, 0.07]]) steelwork.bar([x, roofY(x) - 0.05, z + edge], [next, roofY(next) - 0.05, z + edge], t);
      }
    }
  });

  // Bowstring trusses on wall columns, with gusset plates at every panel point.
  const panels = 22;
  TRUSS_Z.forEach((z) => {
    const node = (i: number): V3 => { const x = HALL.x0 + 0.35 + ((HALL.x1 - HALL.x0 - 0.7) * i) / panels; return [x, Math.max(TIE + 0.12, roofY(x) - 0.3), z]; };
    steelwork.box(XC, TIE, z, HALL.x1 - HALL.x0 - 0.5, 0.24, 0.2);
    for (let i = 0; i < panels; i += 1) {
      const a = node(i), b = node(i + 1);
      steelwork.bar(a, b, 0.24, 0.2);
      if (i > 0) {
        steelwork.bar([a[0], TIE, z], a, 0.1);
        steelwork.box(a[0], TIE + 0.04, z, 0.56, 0.4, 0.225).box(a[0], a[1] - 0.04, z, 0.5, 0.36, 0.225, [0, 0, roofSlope(a[0])]);
        for (const [ox, oy] of [[-0.2, -0.08], [0.2, -0.08], [-0.2, 0.14], [0.2, 0.14]]) fineSteel.cyl(0.022, 0.022, 0.26, a[0] + ox, TIE + oy, z, [Math.PI / 2, 0, 0], 6);
      }
      if (i > 0 && i < panels - 1) steelwork.bar(i < panels / 2 ? [a[0], TIE, z] : [b[0], TIE, z], i < panels / 2 ? b : a, 0.09);
    }
  });
  const columns = TRUSS_Z.flatMap((z) => [HALL.x0 + 0.3, HALL.x1 - 0.3].map((x) => [x, z]));
  columns.forEach(([x, z]) => steelB.add(iBeam(0.5, 0.56, TIE + 0.1, 0.05, 0.04), x, 0, z));
  columns.forEach(([x, z]) => {
    steelwork.box(x, 0.02, z, 0.8, 0.04, 0.86).box(x, TIE - 0.3, z, 0.62, 0.03, 0.66);
    for (const ox of [-0.3, 0.3]) for (const oz of [-0.34, 0.34]) fineSteel.cyl(0.028, 0.028, 0.1, x + ox, 0.07, z + oz, undefined, 6);
  });
  // Purlins under the deck and a ridge-line of wind bracing rods.
  for (let i = 1; i < 16; i += 1) {
    const x = HALL.x0 + ((HALL.x1 - HALL.x0) * i) / 16;
    steelwork.box(x, roofY(x) - 0.14, -10.5, 0.1, 0.18, 41.2, [0, 0, roofSlope(x)]);
  }
  for (let i = 0; i < TRUSS_Z.length - 1; i += 1) for (const x of [-25, 10]) {
    brightwork.bar([x, TIE, TRUSS_Z[i]], [x + 7, TIE, TRUSS_Z[i + 1]], 0.035).bar([x + 7, TIE, TRUSS_Z[i]], [x, TIE, TRUSS_Z[i + 1]], 0.035);
  }
  // Sprinkler mains hung under the ties, fed from a riser in the back corner.
  const sprinklerY = TIE - 0.34;
  for (const x of [-27.5, -15, -3.5, 5, 14.5]) {
    redB.rod([x, sprinklerY, 8.9], [x, sprinklerY, -30.2], 0.055);
    for (let z = 7.6; z > -30; z -= 3.3) { fineRed.cyl(0.018, 0.018, 0.16, x, sprinklerY - 0.1, z, undefined, 6); fineBright.cyl(0.05, 0.02, 0.03, x, sprinklerY - 0.19, z, undefined, 8); }
    TRUSS_Z.forEach((z) => fineSteel.rod([x, TIE - 0.12, z + 0.16], [x, sprinklerY, z + 0.16], 0.008, 5));
  }
  redB.rod([-31, sprinklerY, 8.9], [14.5, sprinklerY, 8.9], 0.075).rod([-31, sprinklerY, 8.9], [-31, 0, 8.9], 0.075);
  redB.torus(0.16, 0.018, -31, 1.3, 8.72, undefined, 16).cyl(0.11, 0.11, 0.24, -31, 1.3, 8.9, undefined, 12).cyl(0.11, 0.11, 0.2, -31, 2.1, 8.9, undefined, 12);
  // Cable ladder along the back wall with drops, and trunking down the columns.
  steelwork.box(XC, 7.9, 9.5, 50, 0.04, 0.05).box(XC, 7.9, 9.22, 50, 0.04, 0.05);
  for (let x = HALL.x0 + 1; x < HALL.x1; x += 0.6) fineSteel.box(0.03, 0.02, 0.3, x, 7.89, 9.36);
  for (const [oz, r] of [[9.28, 0.022], [9.34, 0.016], [9.4, 0.026], [9.45, 0.014]]) rubberB.rod([HALL.x0 + 1, 7.93, oz], [HALL.x1 - 1, 7.93, oz], r, 6);
  for (let x = HALL.x0 + 3; x < HALL.x1; x += 4) fineSteel.bar([x, 7.9, 9.2], [x, 7.55, 9.66], 0.04);

  // ---- Range bay: partition on the aircraft side ---------------------------
  // The partition's posts: the second stands a quarter metre off the grid, clear of the alarm lamp World hangs at z = -7.7.
  const bayZ = [-2, -8, -14, -20, -26], postZ = [-2, -8.25, -14, -20, -26];
  panelB.box(0.4, 4.6, 29.6, -9.74, 2.3, -14.6);
  steelB.add(softBox(0.52, 0.1, 39.4, 0.02, 1.4), -9.74, 4.65, -9.7);
  // Toward the firing line the partition opens into two bays under a deep lintel.
  panelB.box(0.4, 1.3, 9.8, -9.74, 3.95, 5.1);
  for (const z of [0.1, 4.95, 9.4]) panelB.add(softBox(0.5, 3.32, 0.6, 0.03, 2.8), -9.74, 1.66, z);
  hazardStrip(9.2, 0.22, -9.528, 3.41, 4.95, [0, Math.PI / 2, 0]);
  hazardStrip(9.2, 0.22, -9.952, 3.45, 4.95, [0, -Math.PI / 2, 0]);
  // Guard rails across the open bays: tube rails on posts with base plates and a kick board.
  for (const [z0, z1] of [[0.4, 4.65], [5.25, 9.1]]) {
    for (const y of [1.08, 0.58]) yellowB.rod([-9.74, y, z0], [-9.74, y, z1], 0.028);
    for (let z = z0 + 0.25; z < z1; z += 1.25) { yellowB.cyl(0.03, 0.03, 1.1, -9.74, 0.55, z, undefined, 8); fineYellow.box(0.16, 0.012, 0.16, -9.74, 0.008, z); }
    yellowwork.box(-9.74, 0.09, (z0 + z1) / 2, 0.02, 0.14, z1 - z0);
  }
  sign("departures", 3.2, 0.6, -9.53, 4.06, 2.5, [0, Math.PI / 2, 0]);
  sign("bind", 3.2, 0.8, -9.53, 3.98, 7.2, [0, Math.PI / 2, 0]);
  // Steel posts stiffen the partition; bulkhead lamps ride on them.
  for (const z of postZ) for (const x of [-9.48, -10]) steelB.add(softBox(0.14, 4.6, 0.22, 0.015, 1.4), x, 2.3, z);
  // Formwork tie holes and panel joints in the cast partition.
  for (let z = -28.6; z < 0; z += 2.4) fineDark.box(0.01, 4.5, 0.025, -9.537, 2.3, z);
  for (let z = -27.4; z < 0; z += 1.2) for (const y of [0.7, 2.2, 3.7]) fineDark.cyl(0.022, 0.022, 0.012, -9.537, y, z, [0, 0, Math.PI / 2], 8);

  // ---- Range bay: workshop block and mezzanine office ----------------------
  const blockZ = -10.45, blockRun = 40.3;
  // The brick front is pierced for the shop window and the roller shutter.
  const shopWindow = { z: 2.6, width: 2.68, sill: 1.36, head: 2.74 }, shutter = { z: 7.2, width: 3.04, head: 3.26, raised: 1.02 };
  const front = archedWall(blockRun, 4.5, 0.4, [
    { x: -(shopWindow.z - blockZ), width: shopWindow.width, spring: shopWindow.head, sill: shopWindow.sill, flat: true },
    { x: -(shutter.z - blockZ), width: shutter.width, spring: shutter.head, flat: true },
  ], 2.8);
  front.rotateY(Math.PI / 2);
  brickB.add(front, 9.74, 0, blockZ);
  concreteB.add(softBox(0.3, 0.32, 36.2, 0.03, 2.2), 9.6, 0.16, -12.5);
  concreteB.box(0.3, 0.32, 0.9, 9.6, 0.16, 9.2);
  concreteB.add(softBox(9.9, 0.34, blockRun, 0.03, 2.4), 14.4, 4.67, blockZ);
  brickB.box(9.01, 4.5, 0.4, 14.445, 2.25, -30.4);
  for (const z of [...bayZ, 4.6]) steelB.add(softBox(0.14, 4.5, 0.22, 0.015, 1.4), 9.48, 2.25, z);
  // Brick-on-edge course and a stone coping band under the slab.
  concreteB.box(0.46, 0.14, blockRun, 9.72, 4.43, blockZ);

  // Shop window: steel frame set in the reveal, sill, glass.
  const reveal = 9.72;
  concreteB.box(0.56, 0.09, shopWindow.width + 0.24, 9.7, shopWindow.sill - 0.03, shopWindow.z);
  darkwork.box(reveal, shopWindow.head - 0.035, shopWindow.z, 0.09, 0.07, shopWindow.width).box(reveal, shopWindow.sill + 0.035, shopWindow.z, 0.09, 0.07, shopWindow.width);
  for (const o of [-shopWindow.width / 2 + 0.035, -0.45, 0.45, shopWindow.width / 2 - 0.035]) darkwork.box(reveal, 2.05, shopWindow.z + o, 0.09, shopWindow.head - shopWindow.sill, Math.abs(o) < 1 ? 0.045 : 0.07);
  darkwork.box(reveal, 2.4, shopWindow.z, 0.07, 0.04, shopWindow.width);
  clearB.add(new THREE.PlaneGeometry(shopWindow.width - 0.07, shopWindow.head - shopWindow.sill - 0.07), reveal, 2.05, shopWindow.z, [0, -Math.PI / 2, 0]);
  steelwork.box(9.575, shopWindow.head + 0.1, shopWindow.z, 0.1, 0.18, shopWindow.width + 0.5);
  // Roller shutter, part raised: interlocking laths, guides, bottom rail and hood.
  const lath = new THREE.Shape();
  const laths = Math.round((shutter.head - shutter.raised) / 0.085);
  lath.moveTo(0, shutter.raised);
  for (let i = 0; i < laths; i += 1) { const y = shutter.raised + i * 0.085; lath.lineTo(-0.004, y + 0.012); lath.lineTo(-0.022, y + 0.03); lath.lineTo(-0.022, y + 0.058); lath.lineTo(-0.004, y + 0.076); lath.lineTo(0, y + 0.085); }
  lath.lineTo(0.012, shutter.raised + laths * 0.085); lath.lineTo(0.012, shutter.raised);
  lath.closePath();
  brightB.add(new THREE.ExtrudeGeometry(lath, { depth: shutter.width - 0.08, bevelEnabled: false }), 9.78, 0, shutter.z - shutter.width / 2 + 0.04);
  darkwork.box(9.77, shutter.raised - 0.04, shutter.z, 0.06, 0.1, shutter.width - 0.06);
  rubberB.box(0.05, 0.035, shutter.width - 0.08, 9.77, shutter.raised - 0.105, shutter.z);
  fineBright.rod([9.72, shutter.raised - 0.02, shutter.z - 0.3], [9.72, shutter.raised - 0.02, shutter.z + 0.3], 0.012);
  for (const side of [-1, 1]) { steelwork.box(9.78, shutter.head / 2, shutter.z + side * (shutter.width / 2 - 0.04), 0.1, shutter.head, 0.08); yellowB.cyl(0.07, 0.07, 1, 9.36, 0.5, shutter.z + side * (shutter.width / 2 + 0.2), undefined, 14).sphere(0.07, 9.36, 1, shutter.z + side * (shutter.width / 2 + 0.2), [1, 0.5, 1], 12); fineDark.cyl(0.073, 0.073, 0.1, 9.36, 0.75, shutter.z + side * (shutter.width / 2 + 0.2), undefined, 14, true).cyl(0.11, 0.11, 0.012, 9.36, 0.006, shutter.z + side * (shutter.width / 2 + 0.2), undefined, 14); }
  steelwork.box(9.84, shutter.head + 0.02, shutter.z, 0.3, 0.36, shutter.width + 0.2).box(9.575, shutter.head + 0.1, shutter.z, 0.1, 0.18, shutter.width + 0.5);
  sign("shop", 3.0, 0.75, 9.528, 3.86, shutter.z, [0, -Math.PI / 2, 0]);
  sign("ear", 0.44, 0.44, 9.528, 2.0, 5.1, [0, -Math.PI / 2, 0]);
  sign("noscope", 3.2, 0.4, 9.528, 3.34, shopWindow.z, [0, -Math.PI / 2, 0]);
  sign("smoke", 0.6, 0.6, 9.528, 2.05, 0.2, [0, -Math.PI / 2, 0]);
  // Push-button station and conduit for the shutter.
  fineYellow.box(0.07, 0.24, 0.12, 9.5, 1.4, 5.35);
  greenGlow.cyl(0.018, 0.018, 0.02, 9.46, 1.47, 5.35, [0, 0, Math.PI / 2], 8); redGlow.cyl(0.018, 0.018, 0.02, 9.46, 1.36, 5.35, [0, 0, Math.PI / 2], 8);
  fineSteel.rod([9.51, 1.52, 5.35], [9.51, 4.1, 5.35], 0.012, 6);

  // Inside the workshop: plastered walls, a bench under the shadow board, racking, and wheels waiting by the door.
  plasterB.box(0.2, 4.5, 9.9, 14.3, 2.25, 4.65).box(4.3, 4.5, 0.2, 12.1, 2.25, -0.3);
  // The tube by the window is on its way out: it is a piece of its own so it can stutter with the workshop's lamp.
  const tubeMaterial = emissive(0xe6f4ff, 3.2), failingTube = batch(tubeMaterial, { mirror: false });
  for (const z of [2.4, 7]) { darkwork.box(12.1, 4.44, z, 0.2, 0.07, 1.56); (z < 3 ? failingTube : coolGlow).box(0.12, 0.02, 1.46, 12.1, 4.4, z); }
  sign("pegboard", 3.9, 1.3, 14.18, 2.0, 2.6, [0, -Math.PI / 2, 0]);
  timberB.box(0.03, 1.4, 4.0, 14.2, 2.0, 2.6);
  const vice = (x: number, y: number, z: number) => {
    darkB.cyl(0.09, 0.11, 0.05, x, y + 0.025, z, undefined, 14).box(0.12, 0.14, 0.3, x, y + 0.12, z).box(0.17, 0.09, 0.04, x, y + 0.22, z + 0.11).box(0.17, 0.09, 0.04, x, y + 0.22, z + 0.21).box(0.08, 0.07, 0.24, x, y + 0.13, z + 0.22);
    darkB.box(0.1, 0.02, 0.1, x, y + 0.2, z - 0.08);
    fineBright.rod([x, y + 0.13, z + 0.2], [x, y + 0.13, z + 0.44], 0.013).rod([x - 0.12, y + 0.15, z + 0.42], [x + 0.12, y + 0.1, z + 0.42], 0.008, 6).sphere(0.014, x - 0.12, y + 0.15, z + 0.42, undefined, 6).sphere(0.014, x + 0.12, y + 0.1, z + 0.42, undefined, 6);
  };
  const benchLamp = (x: number, y: number, z: number) => {
    darkB.cyl(0.07, 0.08, 0.025, x, y + 0.012, z, undefined, 12).rod([x, y, z], [x + 0.06, y + 0.38, z + 0.04], 0.012, 6).rod([x + 0.06, y + 0.38, z + 0.04], [x + 0.28, y + 0.5, z + 0.18], 0.012, 6);
    darkB.cyl(0.03, 0.075, 0.11, x + 0.3, y + 0.47, z + 0.2, [0.5, 0, -0.5], 12, true);
    warmGlow.sphere(0.026, x + 0.31, y + 0.45, z + 0.21, undefined, 8);
  };
  /** Steel-framed bench with a timber top, drawers, back rail, vice and lamp; front toward +z, centred on x. */
  const workbench = (length: number) => {
    timberB.rbox(length, 0.07, 0.8, 0.012, 0, 0.9, 0);
    for (const x of [-length / 2 + 0.06, length / 2 - 0.06]) for (const z of [-0.33, 0.33]) steelB.box(0.06, 0.87, 0.06, x, 0.435, z);
    steelB.box(length - 0.1, 0.05, 0.05, 0, 0.82, 0.33).box(length - 0.1, 0.05, 0.05, 0, 0.82, -0.33).box(length - 0.12, 0.03, 0.66, 0, 0.22, 0).box(length, 0.34, 0.03, 0, 1.1, -0.385);
    redB.box(0.62, 0.52, 0.66, -length / 2 + 0.46, 0.6, 0.02);
    for (const y of [0.42, 0.56, 0.7, 0.8]) fineBright.box(0.46, 0.018, 0.02, -length / 2 + 0.46, y, 0.36);
    vice(length / 2 - 0.5, 0.935, 0.12);
    benchLamp(-length / 2 + 0.28, 0.935, -0.26);
    // Parts bins along the back rail, a torque wrench case and loose stock.
    const tones = [redB, yellowB, blueB];
    for (let i = 0; i < Math.floor((length - 1.4) / 0.2); i += 1) tones[i % 3].box(0.17, 0.13, 0.22, -length / 2 + 0.8 + i * 0.2, 1.0, -0.24, [0.2, 0, 0]);
    fineDark.rbox(0.5, 0.09, 0.2, 0.02, 0.2, 0.98, 0.14, [0, 0.2, 0]);
    fineBright.cyl(0.02, 0.02, 0.5, -0.4, 0.955, 0.2, [0, 0.6, Math.PI / 2], 8).cyl(0.03, 0.03, 0.3, -0.5, 0.965, 0.05, [0, -0.3, Math.PI / 2], 8);
    // Spares in cartons on the under-shelf, tins of grease and sealant on the top.
    put("cartonLarge", -0.2, 0.235, 0.03, -0.08);
    put("carton", length / 2 - 1.3, 0.235, 0.02, 0.12);
    put("cartonSmall", length / 2 - 0.75, 0.235, 0.08, 0.5);
    put("tin", 0.74, 0.935, 0.05, 0.4); put("tin", 0.85, 0.935, -0.05, 2.1); put("tin", 0.91, 0.935, 0.13, 4);
  };
  /** Pallet racking: `bays` of 2.7 m carrying spares in cartons, small crates and tote crates; front toward +z. `load` is how full it stands. */
  const racking = (bays: number, height: number, levels: number, load: number) => {
    const width = bays * 2.7, rise = (height - 0.5) / (levels - 1 || 1);
    for (let i = 0; i <= bays; i += 1) for (const z of [-0.5, 0.5]) {
      blueB.box(0.09, height, 0.07, -width / 2 + i * 2.7, height / 2, z);
      fineSteel.box(0.16, 0.012, 0.14, -width / 2 + i * 2.7, 0.006, z);
      if (z > 0) for (let y = 0.3; y < height - 0.6; y += 0.6) blueB.bar([-width / 2 + i * 2.7, y, -0.5], [-width / 2 + i * 2.7, y + 0.6, 0.5], 0.03);
    }
    const askew = () => (random() - 0.5) * 0.14;
    /** Middle of a thing `depth` deep, pulled to the front of the shelf where the picker left it. */
    const front = (depth: number) => 0.41 - depth / 2 - random() * 0.07;
    for (let level = 0; level < levels; level += 1) {
      const y = 0.12 + level * rise, deck = y + 0.07, clear = level < levels - 1 ? rise - 0.2 : 2;
      for (const z of [-0.5, 0.5]) orangeB.box(width, 0.11, 0.05, 0, y, z);
      steelB.box(width - 0.1, 0.02, 0.96, 0, y + 0.06, 0);
      for (let bay = 0; bay < bays; bay += 1) {
        const end = -width / 2 + (bay + 1) * 2.7 - 0.14;
        for (let x = end - 2.42 + random() * 0.2; x < end - 0.45; x += 0.05 + random() * 0.18) {
          const room = end - x, pick = random();
          if (random() > load) x += 0.45 + random() * 0.7;
          else if (pick < 0.2 && room > 1.26) {
            // Two large cartons, sometimes a third across the joint.
            put("cartonLarge", x + 0.31, deck, front(0.46), askew()); put("cartonLarge", x + 0.95, deck, front(0.46), askew());
            if (clear > 0.86 && random() < 0.6) put("cartonLarge", x + 0.5 + random() * 0.26, deck + tall("cartonLarge"), front(0.46) - 0.02, askew());
            x += 1.26;
          } else if (pick < 0.42 && room > 0.98) {
            // A pair of cartons with one more on top.
            put("carton", x + 0.24, deck, front(0.35), askew()); put("carton", x + 0.74, deck, front(0.35), askew());
            if (clear > 0.66) put(random() < 0.5 ? "carton" : "cartonSmall", x + 0.34 + random() * 0.3, deck + tall("carton"), front(0.35) - 0.02, askew() * 3);
            x += 0.98;
          } else if (pick < 0.56 && room > 0.68) {
            // A small crate with flat packs left on it.
            put("crateSmall", x + 0.34, deck, front(0.5), askew());
            for (let k = 0, packs = clear > 0.72 ? Math.floor(random() * 3) : 0; k < packs; k += 1) put("cartonFlat", x + 0.34 + (random() - 0.5) * 0.05, deck + tall("crateSmall") + k * tall("cartonFlat"), front(0.48), askew() * 2);
            x += 0.68;
          } else if (pick < 0.68 && clear > 0.62 && room > 0.76) {
            put("cartonTall", x + 0.19, deck, front(0.35), askew()); put("cartonTall", x + 0.57, deck, front(0.35), askew());
            x += 0.76;
          } else if (pick < 0.8) {
            // Tote crates, stacked.
            const tint = [0x1c4fa0, 0x2a2c2e, 0x1f7a3a][Math.floor(random() * 3)];
            for (let k = 0, totes = Math.min(clear > 0.83 ? 3 : 2, 1 + Math.floor(random() * 3)); k < totes; k += 1) put("cratePlastic", x + 0.21 + (random() - 0.5) * 0.02, deck + k * TOTE, front(0.3), askew() * 0.5, { tint });
            x += 0.42;
          } else if (room > 0.6) {
            for (let k = 0, packs = 2 + Math.floor(random() * 3); k < packs; k += 1) put("cartonFlat", x + 0.3 + (random() - 0.5) * 0.04, deck + k * tall("cartonFlat"), front(0.41), askew() * 2);
            x += 0.6;
          }
        }
      }
    }
  };
  within(13.72, 0, 2.6, -Math.PI / 2, () => workbench(4.2));
  // Pillar drill on the bench end and a bench grinder.
  steelB.box(0.44, 0.9, 0.44, 13.75, 0.45, 5.3);
  darkB.box(0.3, 0.04, 0.4, 13.75, 0.92, 5.3).cyl(0.035, 0.035, 0.75, 13.86, 1.3, 5.3, undefined, 10).rbox(0.2, 0.26, 0.5, 0.03, 13.72, 1.63, 5.3).cyl(0.012, 0.03, 0.14, 13.56, 1.43, 5.3, undefined, 8).box(0.24, 0.02, 0.24, 13.6, 1.17, 5.3);
  within(12.2, 0, 0.35, 0, () => racking(1, 3.4, 4, 0.9));
  // Wheels: a stack lying flat and two standing against it, seen under the shutter.
  for (let i = 0; i < 4; i += 1) wheel(11.3, 0.19 + i * 0.37, 7.9, 0.55, 0.36, brightB, "y", 16);
  wheel(11.25, 0.55, 6.5, 0.55, 0.36, brightB, "z", 16); wheel(11.9, 0.55, 6.65, 0.55, 0.36, brightB, "z", 16);
  wheel(12.3, 0.42, 8.6, 0.42, 0.24, brightB, "x", 16); wheel(12.62, 0.42, 8.55, 0.42, 0.24, brightB, "x", 16);
  put("crateLarge", 13.4, 0, 8.6, -Math.PI / 2 + 0.15);
  redB.rbox(1.15, 0.86, 0.52, 0.025, 13.75, 0.57, 6.4, [0, -Math.PI / 2, 0]);
  rubberB.box(0.56, 0.04, 1.19, 13.75, 1.02, 6.4);
  sign("tags", 1.6, 0.4, 14.19, 3.3, 7.2, [0, -Math.PI / 2, 0]);
  // The workshop keeps its own light, so its window still glows when wave mode kills the hall lamps.
  const shopLight = new THREE.PointLight(0xffe2b8, 30, 9.5, 2);
  shopLight.position.set(12.3, 3.5, 4.8);
  scene.add(shopLight);
  life.flicker([shopLight, tubeMaterial], "tube", { at: [12.1, 4.4, 2.4] });

  // Upper floor set back behind a walkway: a glazed office front with the rooms modelled behind it.
  const officeX = 11.5;
  const deskPlants: TreeItem[] = [];
  const windowZ = [-27.4, -23.2, -19, -14.8, -10.6, -6.4, -2.2, 2, 6.2];
  const sill = 5.59, head = 7.31;
  whiteB.box(0.3, sill - 4.84, blockRun - 0.6, officeX + 0.15, (sill + 4.84) / 2, blockZ).box(0.3, 7.94 - head, blockRun - 0.6, officeX + 0.15, (head + 7.94) / 2, blockZ);
  [-32.25, ...windowZ, 11.35].forEach((z, i, all) => { if (i) { const z0 = all[i - 1] + 1.65, z1 = z - 1.65; whiteB.box(0.3, head - sill, z1 - z0, officeX + 0.15, (sill + head) / 2, (z0 + z1) / 2); } });
  steelB.add(softBox(8.6, 0.3, blockRun - 0.2, 0.03, 2.4), officeX + 3.7, 8.05, blockZ);
  whiteB.add(worldBox(7.2, 3.1, 0.3, 2.4), officeX + 3.9, 6.39, -30.3);
  sign("fascia", 5.6, 0.525, officeX - 0.012, 7.63, -8.5, [0, -Math.PI / 2, 0]);
  const signGlow = batch(new THREE.MeshBasicMaterial({ map: sheet, color: new THREE.Color(1.15, 1.08, 0.95), toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { mirror: false });
  const room = { back: 15.3, floor: 4.86, ceiling: 7.9 };
  bakedB.box(0.1, 3.1, blockRun - 0.8, room.back + 0.05, 6.38, blockZ, undefined, 0xe6dcc6).box(room.back - officeX, 0.06, blockRun - 0.8, (room.back + officeX) / 2 + 0.15, room.ceiling, blockZ, undefined, 0xf1eee4).box(room.back - officeX, 0.04, blockRun - 0.8, (room.back + officeX) / 2 + 0.15, room.floor, blockZ, undefined, 0x596068);
  for (const z of [-21.1, -8.5, 4.1]) bakedB.box(room.back - officeX - 0.4, 3.0, 0.1, (room.back + officeX) / 2 + 0.2, 6.38, z, undefined, 0xd7ddd8);
  const spines = [0xa33a2a, 0x2f6f7a, 0xd9c9a0, 0x3d4a56, 0xc98a2e, 0xe9e6dc, 0x1c3550];
  windowZ.forEach((z, index) => {
    const variant = index % 3;
    // The frame sits 4 cm back in the reveal, wholly inside the opening, with one pane of glass at its middle.
    clearB.add(new THREE.PlaneGeometry(3.22, head - sill - 0.08), officeX + 0.1, (sill + head) / 2, z, [0, -Math.PI / 2, 0]);
    darkwork.box(officeX - 0.05, head + 0.03, z, 0.1, 0.06, 3.46).box(officeX - 0.06, sill - 0.03, z, 0.12, 0.06, 3.5);
    darkwork.box(officeX + 0.1, head - 0.04, z, 0.12, 0.08, 3.3).box(officeX + 0.1, sill + 0.04, z, 0.12, 0.08, 3.3);
    for (const o of [-1.61, -0.56, 0.56, 1.61]) darkwork.box(officeX + 0.1, (sill + head) / 2, z + o, 0.12, head - sill - 0.16, Math.abs(o) < 1 ? 0.045 : 0.08);
    // Ceiling tubes in their trays and a grid of tiles.
    for (const [x, oz] of [[12.7, -0.8], [14.2, 0.8]]) { warmGlow.box(0.14, 0.03, 1.3, x, room.ceiling - 0.05, z + oz); bakedB.box(0.3, 0.02, 1.5, x, room.ceiling - 0.035, z + oz, undefined, 0xbfc4c0); }
    for (const oz of [-1.8, -0.6, 0.6, 1.8]) bakedB.box(room.back - officeX - 0.3, 0.012, 0.03, (room.back + officeX) / 2 + 0.15, room.ceiling - 0.035, z + oz, undefined, 0xa9aeaa);
    // Desk under the window with screens, chair backs behind.
    bakedB.box(0.72, 0.04, 2.7, officeX + 0.75, sill - 0.04, z, undefined, 0xc9b592);
    for (const side of [-1, 1]) {
      bakedB.box(0.05, 0.32, 0.54, officeX + 0.8, sill + 0.24, z + side * 0.72, [0, side * 0.9, 0], 0x15181a).cyl(0.02, 0.05, 0.1, officeX + 0.8, sill + 0.03, z + side * 0.72, undefined, 8, false, 0x15181a);
      mintGlow.box(0.006, 0.28, 0.5, officeX + 0.8 + 0.03 * Math.cos(side * 0.9), sill + 0.24, z + side * 0.72 - 0.03 * Math.sin(side * 0.9), [0, side * 0.9, 0]);
      bakedB.box(0.09, 0.5, 0.46, officeX + 1.7, sill + 0.12, z + side * 0.7 + 0.1, [0, side * 0.3, 0], 0x2b3a4a);
    }
    // A bay tree in a pot at the end of every other desk, tall enough to show over the sill from the lanes.
    if (index % 2 === 0) deskPlants.push({ at: [officeX + 0.5, sill - 0.02, z - 1.12], yaw: z * 1.7, scale: 0.5 + (index % 4) * 0.03, variant: 2 });
    if (variant === 0) {
      // Shelves of lever-arch files.
      for (const y of [6.05, 6.5, 6.95, 7.4]) {
        bakedB.box(0.32, 0.035, 3.3, room.back - 0.17, y, z, undefined, 0x8a6a44);
        if (y < 7.3) for (let k = 0, at = -1.55; at < 1.5; k += 1) { const w = 0.05 + random() * 0.05, h = 0.26 + random() * 0.1; if (random() > 0.12) bakedB.box(0.24, h, w, room.back - 0.17, y + 0.02 + h / 2, z + at + w / 2, [random() > 0.9 ? 0.2 : 0, 0, 0], spines[(k * 7 + index) % spines.length]); at += w + 0.008; }
      }
    } else if (variant === 1) {
      // Line-status display and a wall clock.
      bakedB.box(0.06, 1.12, 2.14, room.back - 0.04, 6.75, z - 0.3, undefined, 0x15181a);
      const screen = new THREE.PlaneGeometry(2.0, 1.0);
      statusB.add(screen, room.back - 0.075, 6.75, z - 0.3, [0, -Math.PI / 2, 0]);
      bakedB.cyl(0.18, 0.18, 0.04, room.back - 0.03, 7.2, z + 1.25, [0, 0, Math.PI / 2], 16, false, 0xf1eee4).box(0.012, 0.13, 0.014, room.back - 0.055, 7.25, z + 1.25, undefined, 0x15181a).box(0.012, 0.014, 0.1, room.back - 0.055, 7.2, z + 1.21, undefined, 0x15181a);
      bakedB.box(0.5, 1.9, 0.9, room.back - 0.26, 5.82, z + 1.2, undefined, 0x8f979b);
    } else {
      // Planning board, noticeboard and a tall cabinet.
      sign("plan", 2.4, 0.6, room.back - 0.01, 7.25, z, [0, -Math.PI / 2, 0], signGlow);
      sign("notice", 1.5, 0.94, room.back - 0.01, 6.4, z - 0.7, [0, -Math.PI / 2, 0], signGlow);
      bakedB.box(0.5, 1.95, 0.9, room.back - 0.26, 5.84, z + 1.1, undefined, 0x6f7a80).box(0.012, 1.8, 0.012, room.back - 0.52, 5.84, z + 1.1, undefined, 0x15181a);
    }
    // Venetian blind, drawn to a different height in each room.
    const drop = [5, 12, 2][variant];
    for (let k = 0; k < drop; k += 1) bakedB.box(0.035, 0.008, 3.24, officeX + 0.26, head - 0.06 - k * 0.045, z, [0, 0, 0.5], 0xefe6cf);
    bakedB.box(0.05, 0.04, 3.28, officeX + 0.26, head - 0.02, z, undefined, 0xdcd6c4);
  });
  // Walkway balustrade along the block edge, with a kick plate and a tread-plate deck.
  for (const y of [5.94, 5.42]) brightB.rod([9.72, y, -30.3], [9.72, y, 9.5], 0.024);
  for (let z = -30.2; z < 9.6; z += 1.52) { brightB.cyl(0.022, 0.022, 1.1, 9.72, 5.39, z, undefined, 8); fineBright.box(0.12, 0.012, 0.12, 9.72, 4.85, z); }
  darkwork.box(9.72, 4.92, blockZ, 0.016, 0.14, blockRun - 0.4);
  plateB.box(1.7, 0.016, blockRun - 0.5, 10.6, 4.85, blockZ);
  // Rooftop plant on the office: condensers with fan grilles, linked by ductwork.
  [-22, -6, 4].forEach((z) => {
    machineB.rbox(1.5, 0.9, 2.2, 0.04, 15.6, 8.65, z);
    for (const oz of [-0.55, 0.55]) { fineDark.torus(0.4, 0.03, 15.6, 9.11, z + oz, [Math.PI / 2, 0, 0], 16); fineDark.box(0.8, 0.012, 0.04, 15.6, 9.115, z + oz).box(0.04, 0.012, 0.8, 15.6, 9.115, z + oz); }
    for (let k = 0; k < 9; k += 1) fineDark.box(0.012, 0.6, 0.02, 14.845, 8.65, z - 0.9 + k * 0.225);
    for (const ox of [-0.6, 0.6]) steelwork.box(15.6 + ox, 8.22, z, 0.1, 0.06, 2.3);
  });
  brightB.box(0.5, 0.4, 16, 13.4, 8.42, -14).box(0.5, 0.4, 10, 13.4, 8.42, -1);
  for (let z = -21.5; z < 4; z += 1.6) fineSteel.box(0.54, 0.44, 0.03, 13.4, 8.42, z);

  // ---- Wall services in the bay --------------------------------------------
  const bulkheadMaterial = emissive(0xffb468, 4.2);
  const bulkheads = [...postZ.map((z) => [-9.36, z]), ...bayZ.map((z) => [9.36, z])];
  bulkheads.forEach(([x, z]) => darkB.add(softBox(0.1, 0.3, 0.2, 0.03, 1), x, 3.1, z));
  instances(softBox(0.05, 0.2, 0.13, 0.02, 1), bulkheadMaterial, bulkheads.map(([x, z]) => ({ position: [x < 0 ? x + 0.055 : x - 0.055, 3.1, z] as V3 })), false, false);
  bulkheads.forEach(([x, z]) => { const face = x < 0 ? x + 0.085 : x - 0.085; for (const o of [-0.045, 0, 0.045]) fineDark.box(0.008, 0.22, 0.008, face, 3.1, z + o); for (const o of [-0.07, 0.07]) fineDark.box(0.008, 0.008, 0.15, face, 3.1 + o, z); });
  // Each lamp throws a painted pool on its wall, so the walls keep their shape with the hall lights down.
  const pool = track(softDiscTexture());
  const poolMesh = instances(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: pool, color: new THREE.Color(0xffa860).multiplyScalar(0.13), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    bulkheads.map(([x, z]) => ({ position: [x < 0 ? -9.512 : 9.512, 2.72, z] as V3, rotation: [0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0] as V3, scale: [2.6, 3.2, 1] as V3 })), false, false);
  poolMesh.receiveShadow = false;
  kit.mirrorHidden.push(poolMesh);
  kit.probeHidden.push(poolMesh);
  amberGlow.box(0.03, 0.035, 28.54, -9.4, 0.44, -14.6);
  mintGlow.box(0.03, 0.035, 37.94, 9.4, 0.44, -9.8);
  darkwork.box(-9.43, 0.44, -14.6, 0.06, 0.08, 28.6).box(9.43, 0.44, -9.8, 0.06, 0.08, 38);
  // Compressed-air mains on clips, with a drop to the hose reel.
  for (const y of [4.2, 4.32]) brightB.rod([-9.5, y, -29.1], [-9.5, y, -0.1], 0.03);
  for (let z = -28; z < 0; z += 2) fineSteel.box(0.05, 0.22, 0.04, -9.52, 4.26, z);
  brightB.rod([-9.5, 4.2, -6.5], [-9.5, 1.86, -6.5], 0.016, 6);
  fineRed.cyl(0.03, 0.03, 0.07, -9.5, 2.3, -6.5, undefined, 8); fineRed.box(0.02, 0.02, 0.12, -9.46, 2.3, -6.5);
  // Hose reel on the partition, its hose run out along the wall foot.
  const reelAt: V3 = [-9.3, 1.5, -6.5];
  hoseB.torus(0.24, 0.07, ...reelAt, [0, Math.PI / 2, 0], 28);
  for (const o of [-0.1, 0.1]) redB.cyl(0.34, 0.34, 0.02, reelAt[0] + o, reelAt[1], reelAt[2], [0, 0, Math.PI / 2], 24);
  darkB.box(0.2, 0.5, 0.12, reelAt[0] - 0.14, reelAt[1] + 0.1, reelAt[2]);
  hoseB.pipe([[-9.3, 1.28, -6.5], [-9.26, 0.5, -6.56], [-9.2, 0.03, -6.8], [-9.12, 0.022, -7.5], [-8.98, 0.022, -7.9], [-9.1, 0.022, -8.3], [-9.2, 0.022, -7.9]], 0.02, 64);
  fineBright.cyl(0.024, 0.016, 0.1, -9.2, 0.03, -7.86, [Math.PI / 2, 0, 0], 8);
  // Brick side: cable tray under the slab with drops to the lamps, a distribution board and a fire point.
  steelwork.box(9.47, 4.16, -10.3, 0.13, 0.02, 38.6);
  for (const o of [-0.06, 0.06]) steelwork.box(9.47 + o, 4.19, -10.3, 0.012, 0.07, 38.6);
  for (const [o, r] of [[-0.035, 0.014], [-0.005, 0.01], [0.025, 0.016]]) rubberB.rod([9.47 + o, 4.19, -29.4], [9.47 + o, 4.19, 8.8], r, 6);
  for (let z = -29; z < 9; z += 1.9) fineSteel.box(0.14, 0.05, 0.04, 9.47, 4.13, z);
  bayZ.forEach((z) => fineSteel.rod([9.5, 4.16, z + 0.2], [9.5, 3.26, z + 0.2], 0.011, 6));
  postZ.forEach((z) => fineSteel.rod([-9.5, 4.2, z + 0.2], [-9.5, 3.26, z + 0.2], 0.011, 6));
  steelB.rbox(0.16, 1.0, 0.75, 0.02, 9.46, 1.75, -2.0);
  sign("panel", 0.7, 0.94, 9.375, 1.75, -2.0, [0, -Math.PI / 2, 0]);
  fineSteel.rod([9.5, 2.25, -2.0], [9.5, 4.16, -2.0], 0.02, 6).rod([9.5, 2.25, -1.85], [9.5, 4.16, -1.85], 0.014, 6);
  fineDark.box(0.03, 0.12, 0.03, 9.37, 1.7, -1.68);
  sign("fire", 0.6, 0.6, 9.528, 2.36, -6.9, [0, -Math.PI / 2, 0]);
  // Extinguishers hang on the board, clear of the floor strip.
  redB.box(0.1, 0.96, 0.5, 9.49, 1.32, -6.9);
  for (const o of [-0.12, 0.12]) { redB.cyl(0.07, 0.07, 0.44, 9.37, 1.14, -6.9 + o, undefined, 12).sphere(0.07, 9.37, 1.36, -6.9 + o, undefined, 10); fineDark.cyl(0.02, 0.025, 0.08, 9.37, 1.46, -6.9 + o, undefined, 8).rod([9.37, 1.47, -6.9 + o], [9.33, 1.22, -6.9 + o + 0.05], 0.008, 5).box(0.08, 0.03, 0.16, 9.41, 1.3, -6.9 + o); }
  redB.box(0.016, 0.1, 0.1, 9.53, 1.5, -0.6); fineDark.box(0.02, 0.04, 0.04, 9.52, 1.5, -0.6);

  // ---- The aircraft --------------------------------------------------------
  const livery = liveryTextures(high ? 4096 : 2048);
  track(livery.map).anisotropy = anisotropy;
  track(livery.bump).anisotropy = anisotropy;
  const liveryB = batch(new THREE.MeshStandardMaterial({ map: livery.map, bumpMap: livery.bump, bumpScale: 1.6, roughness: 0.36, metalness: 0.05, envMapIntensity: 1 }), { shadow: true });
  const finMap = track(finTexture());
  finMap.anisotropy = anisotropy;
  const finB = batch(new THREE.MeshStandardMaterial({ map: finMap, roughness: 0.4, metalness: 0.05, envMapIntensity: 1, side: THREE.DoubleSide }), { shadow: true });
  const wingMap = track(wingTexture(high ? 4096 : 2048));
  wingMap.anisotropy = anisotropy;
  const wingB = batch(new THREE.MeshStandardMaterial({ map: wingMap, roughness: 0.4, metalness: 0.05, envMapIntensity: 1, side: THREE.DoubleSide }), { shadow: true });
  // Flight-deck glazing: dark, glossy and only part clear, so it catches the roof lights before it shows the seats.
  const canopyB = batch(new THREE.MeshPhysicalMaterial({ color: 0x1d3038, transparent: true, opacity: 0.46, roughness: 0.03, metalness: 0, envMapIntensity: 4.2, side: THREE.DoubleSide, depthWrite: false }), { mirror: false });
  const bladeMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1e21, roughness: 0.42, metalness: 0.35, envMapIntensity: 1, side: THREE.DoubleSide });
  const bladeB = batch(bladeMaterial, { shadow: true, mirror: false });
  // The lane-side propeller of the aircraft in the hall is left free and windmills in the draught: its blades are a
  // mesh of their own on a turning hub, and cast no shadow, since the sun's shadows are drawn once.
  const propMount = new THREE.Group(), propSpin = new THREE.Group();
  propMount.add(propSpin);
  scene.add(propMount);
  const spinB = batch(bladeMaterial, { mirror: false, into: propSpin });
  const up = new THREE.Vector3(0, 1, 0), out = new THREE.Vector3(1, 0, 0);
  /** A wing, tailplane or fin as spanwise pieces; a piece given a droop angle is split into fixed part and moving surface. */
  const liftSurface = (into: Batch, lead: (t: number) => THREE.Vector3, chord: (t: number) => number, thick: (t: number) => number, normal: THREE.Vector3, pieces: Array<[number, number, number?]>, uv: [number, number] = [1, 1], shift = 0) => {
    for (const [t0, t1, droop] of pieces) {
      const ring = (section: Section, t: number, angle = 0) => foil(section, lead(t), chord(t), thick(t), normal, angle);
      const u = [t0 + shift, t1 + shift];
      if (droop === undefined) { into.add(loft([ring(FOIL_FULL, t0), ring(FOIL_FULL, t1)], uv, u, foilV(FOIL_FULL))); continue; }
      into.add(loft([ring(FOIL_MAIN, t0), ring(FOIL_MAIN, t1)], uv, u, foilV(FOIL_MAIN)));
      const gap = Math.min(0.004, (t1 - t0) * 0.02);
      into.add(loft([ring(FOIL_FLAP, t0 + gap, droop), ring(FOIL_FLAP, t1 - gap, droop)], uv, u, foilV(FOIL_FLAP)));
    }
  };
  const latheZ = (points: number[][], segments: number, start = 0, length = Math.PI * 2) => {
    const geometry = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments, start, length);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  };
  const ALONG: V3 = [Math.PI / 2, 0, 0];
  /** Six feathered blades about the z axis at the origin, with their root cuffs. */
  const propBlades = (blades: Batch, cuffs: Batch) => {
    for (let k = 0; k < 6; k += 1) {
      const sections = steps(0, 1, 9).map((t) => {
        const r = 0.26 + 1.72 * t, chord = (0.11 + 0.25 * Math.sin(Math.PI * Math.min(1, t * 0.8 + 0.12)) ** 0.8) * (t > 0.97 ? 0.55 : 1), thickness = chord * (0.34 - 0.24 * Math.min(1, t * 2.2));
        const pitch = 1.5 - 0.55 * t, cos = Math.cos(pitch), sin = Math.sin(pitch);
        return steps(0, 1, 10).slice(0, 10).map((a) => {
          const cx = Math.cos(a * Math.PI * 2) * chord / 2, cy = Math.sin(a * Math.PI * 2) * thickness / 2;
          return new THREE.Vector3(cx * cos - cy * sin, r, cx * sin + cy * cos);
        });
      });
      const blade = loft(sections);
      blade.rotateZ((k / 6) * Math.PI * 2 + 0.3);
      blades.add(blade);
      cuffs.cyl(0.075, 0.085, 0.14, Math.sin(-(k / 6) * Math.PI * 2 - 0.3) * 0.25, Math.cos(-(k / 6) * Math.PI * 2 - 0.3) * 0.25, 0, [0, 0, (k / 6) * Math.PI * 2 + 0.3], 10);
    }
  };
  /** A propeller about the z axis at the origin: the spinner always, and the blades unless this is the one that turns. */
  const propeller = (turning = false) => {
    if (turning) frame.decompose(propMount.position, propMount.quaternion, propMount.scale);
    else propBlades(bladeB, fineDark);
    brightB.add(latheZ([[0, 0], [0.1, 0.03], [0.2, 0.16], [0.27, 0.38], [0.3, 0.62], [0.3, 0.74]], 20), 0, 0, 0.36);
  };
  /** Turboprop core with its accessories; front face at the origin, running toward -z. */
  const engineCore = () => {
    brightB.cyl(0.3, 0.26, 0.36, 0, 0, -0.18, ALONG, 18);
    darkB.cyl(0.25, 0.25, 0.3, 0, 0, -0.5, ALONG, 18);
    steelB.cyl(0.25, 0.3, 0.5, 0, 0, -0.9, ALONG, 18);
    brightB.cyl(0.34, 0.34, 0.46, 0, 0, -1.38, ALONG, 20);
    darkB.cyl(0.33, 0.22, 0.34, 0, 0, -1.78, ALONG, 18);
    for (const z of [-0.35, -0.65, -1.15, -1.61]) steelB.torus(z > -1 ? 0.27 : 0.345, 0.02, 0, 0, z, undefined, 24);
    fineBright.torus(0.385, 0.013, 0, 0, -1.3, undefined, 24);
    for (let k = 0; k < 12; k += 1) { const a = (k / 12) * Math.PI * 2; fineBright.cyl(0.012, 0.016, 0.07, Math.cos(a) * 0.36, Math.sin(a) * 0.36, -1.3, [0, 0, a - Math.PI / 2], 6); steelB.cyl(0.012, 0.012, 0.03, Math.cos(a) * 0.3, Math.sin(a) * 0.3, -0.02, ALONG, 6); }
    darkB.rbox(0.36, 0.22, 0.44, 0.03, 0, -0.36, -0.62);
    brightB.cyl(0.085, 0.085, 0.3, 0.17, -0.44, -0.92, ALONG, 12);
    steelB.box(0.14, 0.14, 0.2, -0.18, -0.42, -0.92).cyl(0.05, 0.05, 0.16, -0.05, -0.5, -0.5, ALONG, 10);
    yellowB.cyl(0.075, 0.075, 0.28, 0.33, 0.08, -0.7, undefined, 12);
    fineDark.cyl(0.03, 0.03, 0.03, 0.33, 0.235, -0.7, undefined, 8);
    hoseB.pipe([[0.33, 0.22, -0.72], [0.38, 0.3, -0.9], [0.32, 0.32, -1.2], [0.2, 0.34, -1.36]], 0.014, 16, 5);
    rubberB.pipe([[-0.18, -0.34, -0.92], [-0.34, -0.22, -1.0], [-0.39, 0, -1.2], [-0.3, 0.22, -1.3]], 0.012, 16, 5);
    rubberB.pipe([[-0.1, -0.28, -0.5], [-0.3, -0.12, -0.42], [-0.3, 0.14, -0.3], [-0.14, 0.27, -0.2]], 0.01, 16, 5);
    fineBright.pipe([[0.1, -0.3, -0.5], [0.3, -0.2, -0.55], [0.35, 0, -0.9], [0.37, 0.1, -1.25]], 0.01, 16, 5);
    fineBright.pipe([[0, 0.27, -0.48], [0.02, 0.36, -0.8], [0, 0.4, -1.2], [0, 0.36, -1.5]], 0.018, 16, 6);
    for (const x of [-0.22, 0.22]) fineRed.cyl(0.016, 0.016, 0.09, x, 0.29, -1.44, [0, 0, x > 0 ? -0.6 : 0.6], 6);
  };
  const NACELLE = [[0.3, 0], [0.5, 0.12], [0.6, 0.4], [0.62, 0.7], [0.64, 1.9], [0.608, 2.6], [0.58, 3.2], [0.4, 4.4], [0.16, 5.1], [0, 5.15]];
  const aircraft = (detail: boolean) => {
    liveryB.add(skinPatch(FUSE_S, 0, 1, detail ? 96 : 48, 0, false, detail ? cockpitHole : undefined));
    // Flight-deck glazing: posts, sill and header frames stand proud of the skin.
    const paneS = steps(COCKPIT.s0, COCKPIT.s1, 5);
    for (const v of [0.5, 0.448, 0.552, 0.4, 0.6]) darkB.add(skinPatch(paneS, v - 0.0055, v + 0.0055, 1, 0.014));
    for (const v of [0.5 - COCKPIT.half - 0.004, 0.5 + COCKPIT.half + 0.004]) darkB.add(skinPatch(steps(COCKPIT.s0 - 0.08, COCKPIT.s1 + 0.08, 6), v - 0.007, v + 0.007, 1, 0.014));
    for (const s of [COCKPIT.s0 - 0.04, COCKPIT.s1 + 0.04]) darkB.add(skinPatch([s - 0.045, s + 0.045], 0.5 - COCKPIT.half - 0.01, 0.5 + COCKPIT.half + 0.01, 28, 0.014));
    (detail ? canopyB : glassB).add(skinPatch(paneS, 0.5 - COCKPIT.half, 0.5 + COCKPIT.half, 28, detail ? -0.008 : 0.006));
    for (let s = 5.6; s < 15.2; s += 0.95) for (const v of [0.3, 0.7]) glassB.add(skinPatch([s + 0.015, s + 0.275], v - 0.0165, v + 0.0165, 2, 0.006));
    if (detail) {
      // Flight deck behind the glass: lining, coaming, panel, console and two seats.
      liningB.add(skinPatch(steps(1.3, 3.7, 8), 0, 1, 32, -0.04, true));
      liningB.add(new THREE.CircleGeometry(radiusAt(3.7) - 0.04, 24), 0, centreAt(3.7), -3.7).add(new THREE.CircleGeometry(radiusAt(1.3) - 0.04, 24), 0, centreAt(1.3), -1.3, [0, Math.PI, 0]);
      liningB.box(2.7, 0.05, 2.4, 0, 2.95, -2.5);
      rubberB.rbox(2.0, 0.13, 0.62, 0.05, 0, 4.0, -2.08).box(1.9, 0.52, 0.06, 0, 3.7, -2.4, [-0.25, 0, 0]).box(0.36, 0.5, 0.95, 0, 3.22, -2.78).rbox(0.62, 0.06, 0.8, 0.02, 0, 4.74, -2.92);
      for (const x of [-0.7, -0.32, 0.32, 0.7]) mintGlow.box(0.3, 0.24, 0.008, x, 3.76, -2.44, [-0.25, 0, 0]);
      for (const x of [-0.08, 0.08]) fineBright.rod([x, 3.47, -2.6], [x, 3.62, -2.52], 0.012, 6);
      for (let k = 0; k < 10; k += 1) (k % 3 ? coolGlow : amberGlow).box(0.02, 0.006, 0.02, -0.22 + (k % 5) * 0.11, 4.705, -2.7 - Math.floor(k / 5) * 0.3);
      for (const x of [-0.56, 0.56]) {
        clothB.rbox(0.5, 0.12, 0.5, 0.04, x, 3.56, -2.95).rbox(0.48, 0.86, 0.12, 0.05, x, 4.0, -3.22, [0.12, 0, 0]).rbox(0.3, 0.2, 0.1, 0.04, x, 4.52, -3.3);
        liningB.box(0.3, 0.55, 0.4, x, 3.25, -2.95);
        fineDark.rod([x, 3.3, -2.5], [x, 3.92, -2.6], 0.02, 6).torus(0.12, 0.018, x, 3.98, -2.62, [0.3, 0, 0], 12);
      }
      // Wipers, pitot heads, angle-of-attack vanes and static ports.
      for (const side of [-1, 1]) {
        const a = skinPoint(1.84, 0.5 + side * 0.03, 0.03), b = skinPoint(2.55, 0.5 + side * 0.06, 0.03);
        fineDark.rod([a.x, a.y, a.z], [b.x, b.y, b.z], 0.008, 5);
        for (const [s, v] of [[1.25, 0.5 + side * 0.2], [1.4, 0.5 + side * 0.24]]) {
          const root = skinPoint(s, v), tip = skinPoint(s, v, 0.1);
          fineBright.rod([root.x, root.y, root.z], [tip.x, tip.y, tip.z], 0.012, 6).rod([tip.x, tip.y, tip.z], [tip.x, tip.y, tip.z + 0.22], 0.01, 6);
        }
        const vane = skinPoint(1.7, 0.5 + side * 0.27, 0.01);
        fineBright.cyl(0.03, 0.03, 0.02, vane.x, vane.y, vane.z, [0, 0, Math.PI / 2], 8).box(0.07, 0.012, 0.05, vane.x + side * 0.04, vane.y, vane.z);
      }
      // Crew door furniture on the side facing the bay: handle in its recess, hinge fairings, a foot step.
      const handle = skinPoint(4.72, 0.71, 0.004);
      fineBright.rod([handle.x + 0.012, handle.y - 0.08, handle.z], [handle.x + 0.012, handle.y + 0.08, handle.z], 0.011, 6);
      fineDark.box(0.01, 0.24, 0.1, handle.x - 0.003, handle.y, handle.z);
      for (const v of [0.66, 0.775]) { const hinge = skinPoint(4.0, v, 0.01); skinB.sphere(0.05, hinge.x, hinge.y, hinge.z, [0.6, 1, 2.2], 8); }
    }
    // High wing with a little anhedral: flaps inboard and outboard of the nacelle, aileron beyond.
    for (const side of [-1, 1]) {
      const wingLead = (t: number) => new THREE.Vector3(side * t * 11.5, 5.32 - t * 0.38, -9.8 - t * 0.7), wingChord = (t: number) => (3.9 - 2 * t) * (t > 0.999 ? 0.7 : 1);
      liftSurface(wingB, wingLead, wingChord, (t) => 1.55 - 0.4 * t, up, [[0, 0.13], [0.13, 0.36, 0.14], [0.36, 0.46], [0.46, 0.68, 0.14], [0.68, 0.7], [0.7, 0.95, side * 0.06], [0.95, 0.97], [0.97, 1]], [0.5, 1], side > 0 ? 1 : 0);
      // Flap track fairings, static wicks and the tip light.
      for (const t of [0.19, 0.3, 0.52, 0.63]) { const p = wingLead(t); skinB.sphere(1, p.x, p.y - 0.17, p.z - wingChord(t) * 0.74, [0.07, 0.11, 0.8], 10); }
      for (const t of [0.74, 0.82, 0.9, 0.99]) { const p = wingLead(t); fineDark.rod([p.x, p.y, p.z - wingChord(t)], [p.x, p.y - 0.02, p.z - wingChord(t) - 0.24], 0.005, 4); }
      const tip = wingLead(1);
      (side > 0 ? redGlow : greenGlow).sphere(0.05, tip.x + side * 0.02, tip.y + 0.02, tip.z - 0.12, [1, 1, 2], 8);
      coolGlow.sphere(0.035, tip.x + side * 0.02, tip.y + 0.01, tip.z - 1.2, undefined, 6);
      // Tailplane on top of the fin, with its elevator.
      liftSurface(skinB, (t) => new THREE.Vector3(side * t * 4.3, 10.42, -22.9 - t), (t) => 2.3 - 1.1 * t, () => 1.1, up, [[0, 0.06], [0.06, 0.95, -0.05], [0.95, 1]], [3, 2]);
      for (const t of [0.5, 0.75, 0.98]) fineDark.rod([side * t * 4.3, 10.42, -25.2 + t * 0.1], [side * t * 4.3, 10.4, -25.45 + t * 0.1], 0.005, 4);
      // Main gear sponson with its bay doors.
      skinB.sphere(1, side * 1.72, 1.72, -12.2, [0.62, 0.62, 2.7], 20);
      for (const z of [-11.4, -13]) skinB.box(0.02, 0.34, 0.9, side * 2.3, 1.2, z, [0, 0, side * 0.3]);
      // Trailing-arm main leg: oleo, bogie beam, torque links, brace and brake lines.
      whiteB.cyl(0.09, 0.09, 0.8, side * 1.86, 1.42, -12.2, undefined, 14);
      brightB.cyl(0.058, 0.058, 0.56, side * 1.86, 0.8, -12.2, undefined, 12);
      whiteB.rbox(0.16, 0.16, 1.5, 0.04, side * 1.9, 0.55, -12.2).cyl(0.11, 0.11, 0.1, side * 1.86, 1.04, -12.2, undefined, 12);
      darkB.bar([side * 1.86, 1.0, -12.3], [side * 1.86, 0.82, -12.52], 0.05, 0.1).bar([side * 1.86, 0.82, -12.52], [side * 1.86, 0.62, -12.3], 0.05, 0.1);
      whiteB.rod([side * 1.86, 1.6, -12.2], [side * 1.6, 1.75, -11.3], 0.035).rod([side * 1.86, 1.6, -12.2], [side * 1.4, 1.9, -12.2], 0.035);
      rubberB.pipe([[side * 1.84, 1.7, -12.12], [side * 1.8, 1.2, -12.05], [side * 1.86, 0.8, -11.95], [side * 1.98, 0.6, -11.7]], 0.01, 12, 5);
      brightB.rod([side * 1.9, 0.55, -11.55], [side * 2.3, 0.55, -11.55], 0.05).rod([side * 1.9, 0.55, -12.85], [side * 2.3, 0.55, -12.85], 0.05);
      for (const z of [-11.55, -12.85]) wheel(side * 2.12, 0.55, z, 0.55, 0.36, brightB);
      // Turboprop nacelle slung under the wing.
      const ex = side * 4.6, ey = 4.58, open = detail && side === 1;
      if (!open) skinB.add(latheZ(NACELLE, 24), ex, ey, -8.3);
      else {
        // Cowl doors propped open on the side toward the range bay, the engine bare between its firewalls.
        skinB.add(latheZ(NACELLE.slice(0, 4), 24), ex, ey, -8.3).add(latheZ(NACELLE.slice(5), 24), ex, ey, -8.3).add(latheZ(NACELLE.slice(3, 6), 6, -Math.PI / 6, Math.PI / 3), ex, ey, -8.3);
        for (const d of [-1, 1]) {
          const door = latheZ(NACELLE.slice(3, 6), 12, d > 0 ? Math.PI / 6 : -Math.PI / 6 - 0.8 * Math.PI, 0.8 * Math.PI);
          door.translate(-d * 0.315, -0.546, 0); door.rotateZ(d * 1.05); door.translate(d * 0.315, 0.546, 0);
          skinB.add(door, ex, ey, -8.3);
          for (const z of [-9.25, -10.6]) fineBright.rod([ex + d * 0.3, ey - 0.28, z], [ex + d * 1.08, ey - 0.26, z], 0.012, 6);
        }
        darkB.cyl(0.61, 0.61, 0.025, ex, ey, -9.0, ALONG, 24).cyl(0.6, 0.6, 0.025, ex, ey, -10.9, ALONG, 24);
        within(ex, ey - 0.03, -9.03, 0, engineCore, 0.94);
        for (const d of [-1, 1]) for (const z of [-9.3, -10.5]) steelB.rod([ex + d * 0.24, ey + 0.2, z], [ex + d * 0.12, ey + 0.6, z + 0.1], 0.02, 6);
      }
      // Cowl split lines, intake lip, oil-cooler scoop and exhaust stubs.
      for (const [z, r] of [[-9.0, 0.624], [-10.9, 0.612]]) fineDark.torus(r, 0.008, ex, ey, z, undefined, 28);
      // Chin intake: an open scoop under the nose of the nacelle, its throat dark behind a bright lip.
      const scoop = new THREE.CylinderGeometry(0.2, 0.2, 0.95, 16, 1, true);
      scoop.rotateX(Math.PI / 2);
      skinB.add(scoop, ex, ey - 0.56, -8.82, undefined, [1.5, 0.72, 1]);
      brightB.torus(0.2, 0.022, ex, ey - 0.56, -8.345, undefined, 18, [1.5, 0.72, 1]);
      darkB.add(new THREE.CircleGeometry(0.2, 16), ex, ey - 0.56, -8.46, undefined, [1.5, 0.72, 1]);
      skinB.rbox(0.34, 0.2, 0.9, 0.08, ex, ey - 0.62, -9.9);
      for (const d of [-1, 1]) bladeB.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(d * 0.4, -0.1, -10.5), new THREE.Vector3(d * 0.56, -0.12, -10.75), new THREE.Vector3(d * 0.7, -0.1, -11.2)]), 8, 0.1, 10, false), ex, ey, 0);
      skinB.box(0.16, 0.5, 2.6, ex, ey + 0.52, -10.6);
      within(ex, ey, -8.02, 0, () => propeller(open));
    }
    // Wing-to-body fairing.
    skinB.rbox(2.5, 0.62, 4.6, 0.28, 0, 5.12, -11.6);
    // Swept fin with its rudder, bullet fairing and tail light.
    liftSurface(finB, (t) => new THREE.Vector3(0, 4.4 + t * 6.05, -19.4 - t * 3.3), (t) => 4.7 - 2.2 * t, () => 1.25, out, [[0, 0.1], [0.1, 0.9, 0.07], [0.9, 1]]);
    skinB.sphere(0.22, 0, 10.45, -22.6, [1, 1, 3.2], 14);
    coolGlow.sphere(0.04, 0, 10.45, -25.32, undefined, 6);
    // Nose gear: oleo with steering collar, torque links, drag brace, twin wheels and bay doors.
    whiteB.cyl(0.075, 0.075, 0.7, 0, 1.3, -3.2, undefined, 14).cyl(0.1, 0.1, 0.09, 0, 0.98, -3.2, undefined, 12);
    brightB.cyl(0.05, 0.05, 0.52, 0, 0.68, -3.2, undefined, 12).rod([-0.3, 0.42, -3.2], [0.3, 0.42, -3.2], 0.045);
    darkB.bar([0, 0.94, -3.28], [0, 0.72, -3.48], 0.045, 0.09).bar([0, 0.72, -3.48], [0, 0.5, -3.28], 0.045, 0.09);
    whiteB.rod([0, 1.35, -3.2], [0, 1.62, -2.4], 0.03).rbox(0.12, 0.12, 0.16, 0.03, 0, 0.42, -3.2);
    fineBright.cyl(0.05, 0.05, 0.04, 0, 1.1, -3.11, ALONG, 10);
    for (const x of [-0.24, 0.24]) { wheel(x, 0.42, -3.2, 0.42, 0.24, brightB); skinB.box(0.02, 0.36, 0.8, x * 1.4, 1.3, -3.2, [0, 0, x > 0 ? 0.3 : -0.3]); }
    // Beacons and aerials.
    redGlow.sphere(0.07, 0, 5.47, -12.6, [1, 0.8, 1], 8).sphere(0.07, 0, 1.33, -10, [1, 0.8, 1], 8);
    const blade = new THREE.Shape();
    blade.moveTo(0, 0); blade.lineTo(0.34, 0); blade.lineTo(0.46, 0.36); blade.lineTo(0.34, 0.36); blade.closePath();
    for (const [y, z, flip] of [[5.2, -6.2, 0], [5.24, -7.9, 0], [1.34, -8.4, 1], [1.4, -14.5, 1]]) {
      const geometry = new THREE.ExtrudeGeometry(blade, { depth: 0.024, bevelEnabled: false });
      geometry.translate(0, 0, -0.012); geometry.rotateY(Math.PI / 2);
      if (flip) geometry.rotateZ(Math.PI);
      bladeB.add(geometry, 0, y, z);
    }
    fineBright.rod([0.24, 7.2, -21.6], [0.24, 7.25, -22.9], 0.008, 4).rod([-0.24, 7.2, -21.6], [-0.24, 7.25, -22.9], 0.008, 4);
  };
  within(PLANE.x, 0, PLANE.z, 0, () => aircraft(true));
  propBlades(spinB, spinB);
  // A second airframe out on remote stand 07, in the sun.
  within(-18, 0, -99.5, Math.PI / 2 + 0.08, () => aircraft(false));

  // Wheel chocks, yellow, hard against the tyres, roped in pairs.
  const chockShape = new THREE.Shape();
  chockShape.moveTo(-0.17, 0); chockShape.lineTo(0.17, 0); chockShape.lineTo(0.12, 0.2); chockShape.lineTo(0.02, 0.2); chockShape.closePath();
  const chock = new THREE.ExtrudeGeometry(chockShape, { depth: 0.5, bevelEnabled: false });
  chock.translate(0, 0, -0.25);
  chock.rotateY(Math.PI / 2);
  const chocks: Array<[number, number, number]> = [];
  // The long slope of each wedge lies against its tyre: tangent to the 0.55 m mains 0.407 m out, to the 0.42 m nose wheels 0.35 m out.
  for (const side of [-1, 1]) chocks.push([PLANE.x + side * 2.12, PLANE.z - 11.55 + 0.407, Math.PI], [PLANE.x + side * 2.12, PLANE.z - 12.85 - 0.407, 0]);
  chocks.push([PLANE.x, PLANE.z - 3.2 + 0.35, Math.PI], [PLANE.x, PLANE.z - 3.2 - 0.35, 0]);
  chocks.forEach(([x, z, yaw], index) => yellowB.add(chock.clone(), x, 0, z, [0, yaw, 0], index > 3 ? [1.5, 1, 1] : undefined));
  chock.dispose();
  hoseB.pipe([[PLANE.x + 0.39, 0.12, PLANE.z - 2.83], [PLANE.x + 0.66, 0.014, PLANE.z - 3.0], [PLANE.x + 0.68, 0.014, PLANE.z - 3.4], [PLANE.x + 0.39, 0.12, PLANE.z - 3.57]], 0.008, 16, 4);

  // ---- Ground equipment ----------------------------------------------------
  /** Access stand: tread-plate deck on four legs with guard rails and a stair running toward `run` along z. */
  const accessStand = (x: number, z: number, w: number, d: number, h: number, run: 1 | -1) => {
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, head = run > 0 ? z1 : z0;
    for (const lx of [x0 + 0.05, x1 - 0.05]) for (const lz of [z0 + 0.05, z1 - 0.05]) {
      yellowwork.box(lx, h / 2, lz, 0.08, h, 0.08).box(lx, h + 0.55, lz, 0.05, 1.1, 0.05);
      rubberB.cyl(0.09, 0.09, 0.06, lx + 0.07, 0.09, lz, [0, 0, Math.PI / 2], 12);
      fineDark.box(0.05, 0.14, 0.12, lx + 0.07, 0.16, lz);
    }
    plateB.box(w, 0.05, d, x, h, z);
    yellowwork.box(x, h - 0.08, z0 + 0.05, w, 0.1, 0.06).box(x, h - 0.08, z1 - 0.05, w, 0.1, 0.06).box(x0 + 0.05, h - 0.08, z, 0.06, 0.1, d).box(x1 - 0.05, h - 0.08, z, 0.06, 0.1, d);
    for (const lx of [x0 + 0.05, x1 - 0.05]) {
      yellowwork.bar([lx, 0.25, z0 + 0.05], [lx, h - 0.2, z1 - 0.05], 0.04).bar([lx, 0.3, z0 + 0.05], [lx, 0.3, z1 - 0.05], 0.05);
      for (const y of [h + 1.08, h + 0.56]) yellowB.rod([lx, y, z0 + 0.05], [lx, y, z1 - 0.05], 0.024);
      yellowwork.box(lx, h + 0.1, z, 0.012, 0.14, d - 0.1);
    }
    const tail = run > 0 ? z0 + 0.05 : z1 - 0.05;
    for (const y of [h + 1.08, h + 0.56]) yellowB.rod([x0 + 0.05, y, tail], [x1 - 0.05, y, tail], 0.024);
    yellowwork.bar([x0 + 0.05, 0.25, tail], [x1 - 0.05, h - 0.2, tail], 0.04);
    // Stair with open treads and handrails.
    const reach = h * 1.05, foot = head + run * reach;
    for (const lx of [x0 + 0.06, x1 - 0.06]) {
      yellowwork.bar([lx, h - 0.06, head], [lx, 0.06, foot], 0.14, 0.04).box(lx, 0.55, foot, 0.045, 1.1, 0.045);
      yellowB.rod([lx, h + 1.08, head], [lx, 1.05, foot], 0.024);
    }
    const treads = Math.round(h / 0.24);
    for (let i = 1; i < treads; i += 1) plateB.box(w - 0.16, 0.03, 0.25, x, h - (h * i) / treads, head + run * (reach * i) / treads);
  };
  accessStand(-13.15, -7.2, 1.8, 3.2, 3.3, -1);
  accessStand(-16.9, 2.6, 1.3, 1.9, 1.7, 1);

  // Roller cabinets: red carcass, black top, brushed drawer pulls, loose tools on top.
  const chests: Array<[number, number, number]> = [[-9.02, -2.65, Math.PI / 2], [-9.02, -4.0, Math.PI / 2], [9.0, -20.6, -Math.PI / 2], [-12.4, -12.6, -Math.PI / 2 + 0.2], [-15.6, 3.9, 0.3]];
  instances(softBox(1.15, 0.86, 0.52, 0.025, 1.2), red, chests.map(([x, z, yaw]) => ({ position: [x, 0.57, z] as V3, rotation: [0, yaw, 0] as V3 })));
  chests.forEach(([x, z, yaw], index) => within(x, 0, z, yaw, () => {
    rubberB.rbox(1.19, 0.04, 0.56, 0.012, 0, 1.02, 0);
    for (const y of [0.26, 0.42, 0.56, 0.7, 0.82, 0.92]) { fineBright.box(1.02, 0.022, 0.016, 0, y, 0.268); fineDark.box(1.1, 0.006, 0.006, 0, y + 0.06, 0.262); }
    for (const a of [-0.48, 0.48]) for (const b of [-0.19, 0.19]) { rubberB.cyl(0.07, 0.07, 0.05, a, 0.07, b, [0, 0, Math.PI / 2], 10); fineSteel.box(0.07, 0.03, 0.1, a, 0.135, b); }
    fineBright.rod([-0.6, 0.86, -0.1], [-0.6, 0.86, 0.1], 0.014, 6).rod([-0.575, 0.86, -0.1], [-0.6, 0.86, -0.1], 0.012, 5).rod([-0.575, 0.86, 0.1], [-0.6, 0.86, 0.1], 0.012, 5);
    fineBright.cyl(0.012, 0.012, 0.3, -0.2 + index * 0.05, 1.052, 0.05, [0, 0.4 + index, Math.PI / 2], 6).box(0.2, 0.012, 0.03, 0.25, 1.046, -0.1, [0, index * 0.7, 0]);
    fineRed.rbox(0.26, 0.1, 0.16, 0.015, 0.3, 1.09, 0.1, [0, 0.3 - index * 0.4, 0]);
    orangeB.cyl(0.05, 0.05, 0.14, -0.38, 1.11, -0.12, undefined, 10);
  }));

  // Tow tractor hitched to the nose gear.
  within(PLANE.x, 0, 7.55, 0, () => {
    yellowB.rbox(1.5, 0.52, 2.7, 0.07, 0, 0.62, 0).rbox(1.3, 0.3, 1.1, 0.06, 0, 1.02, -0.72);
    darkB.rbox(1.56, 0.2, 2.8, 0.04, 0, 0.32, 0);
    rubberB.rbox(0.52, 0.12, 0.5, 0.04, -0.3, 0.94, 0.42).rbox(0.52, 0.5, 0.1, 0.04, -0.3, 1.16, 0.7).rbox(1.6, 0.16, 0.12, 0.03, 0, 0.42, -1.42).rbox(1.6, 0.16, 0.12, 0.03, 0, 0.42, 1.42);
    darkB.torus(0.17, 0.016, -0.3, 1.2, 0.08, [-0.5 + Math.PI / 2, 0, 0], 20).cyl(0.018, 0.018, 0.4, -0.3, 1.04, -0.02, [-0.5, 0, 0], 6);
    for (const x of [-0.72, 0.72]) for (const z of [-0.86, 0.86]) { wheel(x, 0.36, z, 0.36, 0.26, yellowB); darkB.rbox(0.34, 0.05, 0.9, 0.02, x, 0.76, z); }
    // Grille, lamps, hitch, mirrors, roll hoop with beacon and the fleet number.
    for (let k = 0; k < 7; k += 1) fineDark.box(0.9, 0.018, 0.02, 0, 0.5 + k * 0.045, -1.352);
    for (const x of [-0.55, 0.55]) { plasticB.cyl(0.07, 0.07, 0.03, x, 0.66, -1.36, ALONG, 12); redGlow.box(0.12, 0.06, 0.01, x, 0.7, 1.356); }
    darkB.box(0.12, 0.08, 0.3, 0, 0.42, -1.55).cyl(0.02, 0.02, 0.18, 0, 0.47, -1.64, undefined, 8);
    darkB.rod([-0.7, 0.86, 0.95], [-0.7, 1.75, 0.95], 0.025).rod([0.7, 0.86, 0.95], [0.7, 1.75, 0.95], 0.025).rod([-0.7, 1.75, 0.95], [0.7, 1.75, 0.95], 0.025);
    amberGlow.cyl(0.06, 0.07, 0.12, 0, 1.83, 0.95, undefined, 12);
    for (const x of [-0.72, 0.72]) { fineDark.rod([x, 1.1, -0.3], [x * 1.2, 1.3, -0.3], 0.008, 5).box(0.02, 0.16, 0.1, x * 1.2, 1.36, -0.3); }
    fineDark.box(0.3, 0.1, 0.04, 0.3, 1.0, -0.14, [-0.5, 0, 0]);
    hoseB.cyl(0.05, 0.05, 0.1, 0.45, 1.22, -1.05, undefined, 10);
  });
  // Tow bar from the hitch to the nose leg, on its own little wheels, with a shear-pin head.
  yellowB.rod([PLANE.x, 0.42, 2.06], [PLANE.x, 0.42, 6.1], 0.045, 10);
  darkB.box(0.3, 0.12, 0.2, PLANE.x, 0.42, 2.0).cyl(0.03, 0.03, 0.3, PLANE.x, 0.42, 5.98, undefined, 8);
  for (const o of [-0.2, 0.2]) rubberB.cyl(0.11, 0.11, 0.07, PLANE.x + o, 0.11, 4.4, [0, 0, Math.PI / 2], 12);
  yellowwork.box(PLANE.x, 0.25, 4.4, 0.04, 0.34, 0.04).box(PLANE.x, 0.11, 4.4, 0.4, 0.03, 0.03);
  fineRed.box(0.3, 0.12, 0.01, PLANE.x, 0.56, 3.2);

  // Ground power cart with its cable run to the fuselage.
  within(-15.3, 0, -1.2, 0, () => {
    whiteB.rbox(1.2, 0.9, 1.9, 0.06, 0, 0.75, 0);
    darkB.rbox(1.26, 0.12, 1.96, 0.03, 0, 0.26, 0);
    for (const [x, z] of [[-0.62, -0.6], [0.62, -0.6], [-0.62, 0.6], [0.62, 0.6]]) wheel(x, 0.2, z, 0.2, 0.14, yellowB);
    for (let k = 0; k < 9; k += 1) fineDark.box(0.012, 0.03, 0.8, 0.607, 0.5 + k * 0.055, -0.4, [0, 0, 0.5]);
    darkB.box(0.02, 0.4, 0.6, 0.606, 0.85, 0.5);
    for (let k = 0; k < 3; k += 1) [greenGlow, amberGlow, redGlow][k].cyl(0.018, 0.018, 0.02, 0.62, 0.95, 0.32 + k * 0.1, [0, 0, Math.PI / 2], 8);
    fineBright.cyl(0.05, 0.05, 0.015, 0.62, 0.8, 0.4, [0, 0, Math.PI / 2], 12).cyl(0.05, 0.05, 0.015, 0.62, 0.8, 0.6, [0, 0, Math.PI / 2], 12);
    sign("power", 0.8, 0.4, 0, 0.8, 0.956);
    darkB.cyl(0.04, 0.05, 0.4, -0.3, 1.38, -0.6, undefined, 10).rod([0, 0.3, 0.98], [0, 0.42, 1.9], 0.025).torus(0.07, 0.015, 0, 0.44, 1.96, [Math.PI / 2, 0, 0], 12);
    fineDark.rod([-0.62, 1.0, -0.2], [-0.62, 1.0, 0.4], 0.012, 6).rod([-0.61, 1.0, -0.2], [-0.6, 0.94, -0.2], 0.012, 6).rod([-0.61, 1.0, 0.4], [-0.6, 0.94, 0.4], 0.012, 6);
  });
  rubberB.pipe([[-15.9, 0.6, -1.2], [-16.5, 0.05, -1.3], [-17.2, 0.03, -1.9], [-17.6, 0.03, -1.0], [-18.1, 0.5, -0.6], [-18.35, 1.7, -0.4]], 0.035, 48);
  rubberB.torus(0.22, 0.035, -15.92, 0.85, -1.5, [0, Math.PI / 2, 0], 20);

  /** Wheeled dry-powder extinguisher with its hose and horn. */
  const extinguisher = () => {
    redB.cyl(0.17, 0.17, 0.82, 0, 0.62, 0, [0.12, 0, 0], 16).sphere(0.17, 0, 1.03, 0.05, [1, 0.7, 1], 14);
    plasticB.cyl(0.173, 0.173, 0.2, 0, 0.7, 0.01, [0.12, 0, 0], 16, true);
    darkB.cyl(0.035, 0.05, 0.1, 0, 1.16, 0.065, [0.12, 0, 0], 8).rod([-0.2, 0.16, -0.12], [-0.2, 1.22, -0.26], 0.016).rod([0.2, 0.16, -0.12], [0.2, 1.22, -0.26], 0.016).rod([-0.2, 1.22, -0.26], [0.2, 1.22, -0.26], 0.016).box(0.42, 0.03, 0.3, 0, 0.18, 0.02);
    rubberB.torus(0.13, 0.02, 0.19, 0.75, 0, [0, Math.PI / 2, 0], 16).cyl(0.03, 0.06, 0.26, 0.2, 0.42, 0.1, [0.3, 0, 0], 8);
    fineBright.cyl(0.03, 0.03, 0.02, 0.06, 1.12, 0.14, ALONG, 10);
    for (const x of [-0.24, 0.24]) wheel(x, 0.16, -0.1, 0.16, 0.05, redB, "x", 14);
  };
  within(-10.7, 0, 8.55, -0.5, extinguisher);
  within(-12.9, 0, -1.9, 2.2, extinguisher);
  within(-25.6, 0, 2.2, 1.1, extinguisher);
  /** Nitrogen servicing cart: four cylinders in a wheeled frame with a regulator and hose. */
  const nitrogenCart = () => {
    yellowB.box(1.1, 0.06, 0.7, 0, 0.3, 0).box(1.01, 0.05, 0.05, 0, 1.0, 0.33).box(1.01, 0.05, 0.05, 0, 1.0, -0.33).box(0.05, 0.75, 0.05, -0.53, 0.66, 0.33).box(0.05, 0.75, 0.05, 0.53, 0.66, 0.33).box(0.05, 0.75, 0.05, -0.53, 0.66, -0.33).box(0.05, 0.75, 0.05, 0.53, 0.66, -0.33);
    for (const [x, z] of [[-0.27, 0.16], [0.27, 0.16], [-0.27, -0.16], [0.27, -0.16]]) { steelB.cyl(0.115, 0.115, 1.3, x, 0.98, z, undefined, 14).sphere(0.115, x, 1.63, z, [1, 0.8, 1], 12); rubberB.cyl(0.117, 0.117, 0.24, x, 1.52, z, undefined, 14, true); fineBright.cyl(0.025, 0.035, 0.1, x, 1.76, z, undefined, 8); fineRed.cyl(0.045, 0.045, 0.012, x, 1.83, z, undefined, 8); }
    fineBright.pipe([[-0.27, 1.76, 0.16], [0, 1.86, 0.2], [0.27, 1.76, 0.16], [0.45, 1.5, 0.36]], 0.008, 16, 4);
    darkB.box(0.24, 0.2, 0.08, 0.3, 1.3, 0.39);
    for (const x of [0.24, 0.36]) { plasticB.cyl(0.045, 0.045, 0.02, x, 1.32, 0.44, ALONG, 12); }
    hoseB.torus(0.16, 0.022, -0.25, 1.2, 0.4, undefined, 18);
    sign("nitrogen", 0.8, 0.4, 0, 0.62, 0.362);
    for (const x of [-0.45, 0.45]) wheel(x, 0.18, 0.42, 0.18, 0.07, yellowB, "z", 14);
    darkB.rod([-0.53, 1.0, 0], [-0.9, 1.05, 0], 0.016).rod([-0.9, 1.05, -0.25], [-0.9, 1.05, 0.25], 0.016);
  };
  within(-11.4, 0, 3.2, Math.PI / 2 + 0.3, nitrogenCart);
  /** Tripod jack with a hydraulic ram reaching `height`. */
  const jack = (height: number) => {
    const spread = 0.42 + height * 0.14;
    for (let k = 0; k < 3; k += 1) {
      const a = (k / 3) * Math.PI * 2 + 0.5, cx = Math.cos(a), cz = Math.sin(a);
      yellowB.rod([cx * spread, 0.05, cz * spread], [cx * 0.1, height * 0.58, cz * 0.1], 0.032).rod([cx * spread, 0.05, cz * spread], [0, 0.22, 0], 0.02);
      darkB.cyl(0.08, 0.1, 0.05, cx * spread, 0.025, cz * spread, undefined, 10);
    }
    yellowB.cyl(0.09, 0.09, height * 0.6, 0, height * 0.3 + 0.2, 0, undefined, 12).cyl(0.13, 0.13, 0.08, 0, height * 0.6, 0, undefined, 12);
    brightB.cyl(0.05, 0.05, height * 0.42, 0, height * 0.79 - 0.03, 0, undefined, 10);
    darkB.cyl(0.035, 0.07, 0.06, 0, height - 0.03, 0, undefined, 10);
    redB.box(0.14, 0.26, 0.12, 0.17, 0.5, 0);
    fineBright.rod([0.24, 0.55, 0], [0.5, 0.95, 0], 0.012, 6);
  };
  within(PLANE.x, 0, PLANE.z, 0, () => {
    for (const x of [-8.6, 8.6]) within(x, 0, -11.15, x, () => jack(4.9));
    within(0, 0, -2.25, 0.4, () => jack(1.6));
    within(0, 0, -19, 1.3, () => jack(2.14));
    // Drip trays under the engines and the main gear, with absorbent mats.
    for (const [x, z] of [[-4.6, -9.6], [4.6, -9.6], [1.9, -13.6]]) {
      darkB.box(1.3, 0.02, 1.0, x, 0.012, z);
      for (const o of [-0.5, 0.5]) darkB.box(1.3, 0.07, 0.02, x, 0.04, z + o).box(0.02, 0.07, 1.0, x + o * 1.3, 0.04, z);
      plasticB.box(0.5, 0.012, 0.4, x + 0.2, 0.03, z - 0.1, [0, 0.3, 0]);
    }
    // Remove-before-flight streamers on pitot covers and gear pins.
    for (const [x, y, z] of [[0.62, 3.9, -1.3], [-0.62, 3.9, -1.3], [0.1, 1.0, -3.3], [1.95, 1.2, -12.1], [-1.95, 1.2, -12.1]]) fineRed.box(0.012, 0.42, 0.045, x, y - 0.2, z, [0.05, 0.4, 0.06]);
  });
  // Parts racking along the far wall, and a second run by the back wall.
  within(-32.3, 0, 2.6, Math.PI / 2, () => racking(4, 5.4, 4, 0.42));
  within(-32.3, 0, -14.2, Math.PI / 2, () => racking(3, 5.4, 4, 0.22));
  // Wheel rack: built-up wheels standing in a cradle, tagged.
  within(-26.6, 0, 8.95, 0, () => {
    for (const z of [-0.3, 0.3]) steelB.rod([-1.7, 0.1, z], [1.7, 0.1, z], 0.03);
    for (const x of [-1.7, 1.7]) steelB.box(0.05, 1.0, 0.7, x, 0.5, 0).box(0.3, 0.02, 0.8, x, 0.01, 0);
    steelB.rod([-1.7, 0.98, 0.33], [1.7, 0.98, 0.33], 0.02);
    for (let k = 0; k < 6; k += 1) { wheel(-1.35 + k * 0.54, 0.6, 0, 0.55, 0.36, brightB, "x", 14); fineYellow.box(0.1, 0.16, 0.004, -1.35 + k * 0.54, 0.9, 0.56); }
  });
  // Spare propeller on a build stand.
  within(-21.9, 0, 8.6, Math.PI, () => {
    yellowB.box(1.6, 0.08, 0.1, 0, 0.04, -0.5).box(1.6, 0.08, 0.1, 0, 0.04, 0.5).box(0.1, 0.08, 1.1, 0, 0.04, 0).cyl(0.07, 0.07, 2.2, 0, 1.1, -0.3, undefined, 12);
    yellowB.rod([0, 0.1, 0.5], [0, 1.6, -0.25], 0.035).rod([-0.75, 0.1, -0.5], [0, 1.5, -0.3], 0.03).rod([0.75, 0.1, -0.5], [0, 1.5, -0.3], 0.03);
    darkB.cyl(0.11, 0.11, 0.5, 0, 2.2, -0.1, ALONG, 12);
    within(0, 2.2, 0.2, 0, propeller);
  });
  // Spare engine on its transport stand, inlet blanked.
  within(-12.5, 0, 6.9, 0.95, () => {
    for (const x of [-0.5, 0.5]) { yellowB.rod([x, 0.24, -1.2], [x, 0.24, 1.2], 0.04); for (const z of [-0.9, 0.9]) { yellowB.rod([x, 0.24, z], [x * 0.66, 0.92, z], 0.035); wheel(x, 0.11, z * 1.2, 0.11, 0.06, darkB, "x", 12); } }
    for (const z of [-1.2, -0.9, 0.9, 1.2]) yellowB.rod([-0.5, 0.24, z], [0.5, 0.24, z], 0.035);
    for (const z of [-0.9, 0.9]) yellowB.torus(0.42, 0.03, 0, 1.2, z, [0, 0, Math.PI], 16, [1, 1, 1]);
    within(0, 1.22, 0.98, 0, engineCore, 1.05);
    redB.cyl(0.33, 0.33, 0.03, 0, 1.22, 1.0, ALONG, 18);
    fineYellow.box(0.16, 0.22, 0.004, 0.2, 1.0, 1.02);
    yellowB.rod([0, 0.24, 1.2], [0, 0.5, 1.9], 0.025).rod([-0.2, 0.5, 1.9], [0.2, 0.5, 1.9], 0.02);
  });
  // Fitter's bench against the back wall on the aircraft side.
  within(-14.4, 0, 9.22, Math.PI, () => workbench(3.4));
  sign("decoy", 3.9, 0.73, -14.4, 2.75, 9.67, [0, Math.PI, 0]);
  sign("scope", 0.8, 0.8, -11.5, 2.7, 9.67, [0, Math.PI, 0]);
  sign("ear", 0.8, 0.8, -17.3, 2.7, 9.67, [0, Math.PI, 0]);
  // Self-retracting air lines hung from the trusses.
  for (const [x, z] of [[-14, 0.5], [-26, 0.5], [-14, -12.5], [-27, -20.5]]) {
    steelwork.box(x, TIE - 0.26, z, 0.3, 0.3, 0.08);
    redB.cyl(0.3, 0.3, 0.14, x, TIE - 0.6, z, ALONG, 18);
    fineDark.cyl(0.07, 0.07, 0.18, x, TIE - 0.6, z, ALONG, 10);
    hoseB.pipe([[x + 0.3, TIE - 0.6, z], [x + 0.31, 9, z], [x + 0.3, 5, z + 0.04], [x + 0.3, 2.5, z]], 0.018, 20, 5);
    fineRed.sphere(0.05, x + 0.3, 2.9, z, undefined, 8);
    fineBright.cyl(0.022, 0.016, 0.12, x + 0.3, 2.45, z, undefined, 8);
  }

  // Cones.
  const cone = new THREE.LatheGeometry([[0.2, 0], [0.2, 0.03], [0.12, 0.04], [0.035, 0.68], [0, 0.69]].map(([r, y]) => new THREE.Vector2(r, y)), 14);
  const coneSpots: Array<[number, number]> = [[-11.2, 1.2], [-11.4, -9.6], [-12.2, -16], [-13.6, 4.6], [-22.5, 6.8], [-8.95, 0.9], [8.95, -17.6], [-25, -9.6], [-14.9, -0.9 - 3.3]];
  coneSpots.forEach(([x, z]) => { orangeB.add(cone.clone(), x, 0, z); plasticB.cyl(0.075, 0.094, 0.11, x, 0.4, z, undefined, 14, true); });

  // Stores about the bay and the hall. Each group is built facing +z and turned to face the room: the west wall is at
  // z = -0.64 in a frame set at x = -8.9, the lamp channel on it 14 cm nearer.
  /** A shipping crate on a pallet, both a little out of square. */
  const palletLoad = (x: number, z: number, turn: number) => { put("pallet", x, 0, z, turn); put("crateLarge", x + 0.02, DECK, z - 0.01, turn * -0.8); };
  // Partition side: two palletised crates, one strapped down, ammunition-pattern cases for the range on the other,
  // and a spare pallet leant on the end.
  within(-8.9, 0, -15.95, Math.PI / 2, () => {
    palletLoad(-0.68, 0, 0.04);
    put("crateAmmo", -0.66, CRATE_TOP, -0.215, 0.05, { tint: 0x9aa068 }); put("crateAmmo", -0.6, CRATE_TOP, 0.225, -0.07, { tint: 0xa89f6c }); put("crateAmmo", -0.72, CRATE_TOP + AMMO, 0.02, 0.5, { tint: 0x8c9860 });
    palletLoad(0.7, 0.02, -0.05);
    within(0.72, 0, 0.01, 0.04, () => {
      for (const x of [-0.3, 0.27]) {
        orangeB.box(0.045, 0.004, 0.884, x, CRATE_TOP + 0.005, 0).box(0.045, CRATE_TOP - 0.07, 0.004, x, (CRATE_TOP + 0.07) / 2 + 0.002, 0.44);
        fineDark.box(0.06, 0.11, 0.028, x, 0.62, 0.456);
        fineBright.box(0.05, 0.1, 0.01, x, 0.67, 0.476, [0.5, 0, 0]);
      }
    });
    put("pallet", 1.4, 0.391, 0.12, Math.PI / 2 + 0.04, { tilt: 1.361 });
  });
  // By the doors: drums of oil and waste fuel on a steel bund, a keg of grease in the fourth place, a plastic drum beside.
  within(-8.72, 0, -22.5, Math.PI / 2, () => {
    for (const x of [-0.55, 0, 0.55]) yellowB.box(0.2, 0.1, 1.3, x, 0.05, 0);
    yellowB.box(1.3, 0.14, 1.3, 0, 0.17, 0);
    for (const o of [-0.635, 0.635]) yellowB.box(1.3, 0.06, 0.03, 0, 0.27, o).box(0.03, 0.06, 1.24, o, 0.27, 0);
    darkB.box(1.24, 0.02, 1.24, 0, 0.25, 0);
    for (let k = -5; k <= 5; k += 1) fineDark.box(1.22, 0.008, 0.03, 0, 0.264, k * 0.11);
    put("drum", -0.31, 0.262, -0.31, 0.5, { tint: 0x1c4c8c }); put("drum", 0.31, 0.262, -0.31, -0.9, { tint: 0x1c4c8c }); put("drum", -0.3, 0.262, 0.31, 0.2, { tint: 0x8a2c1c });
    put("keg", 0.33, 0.262, 0.31, 1.1);
    put("drumPlastic", -1.04, 0, -0.26, 0.3);
  });
  // Brick side: a plastic drum, an oil drum and a keg hard against the plinth, clear of the lane round the station.
  within(9.05, 0, -4.0, -Math.PI / 2, () => { put("drumPlastic", 0.42, 0, 0, -0.2); put("drum", -0.3, 0, 0.03, 0.5, { tint: 0x1c6a64 }); put("keg", -0.9, 0, -0.1, 2.2); });
  // Under the brick wall: cases stacked on a pallet, the top ones as they were put down.
  within(8.9, 0, -15.6, -Math.PI / 2, () => {
    put("pallet", 0, 0, 0, -0.04);
    const sand = 0xb3a878, khaki = 0x9aa068;
    put("crateAmmo", -0.03, DECK, -0.205, 0.02, { tint: khaki }); put("crateAmmo", 0.02, DECK + AMMO, -0.205, -0.03, { tint: sand }); put("crateAmmo", -0.01, DECK + AMMO * 2, -0.2, 0.06, { tint: khaki });
    put("crateAmmo", 0.05, DECK, 0.215, -0.04, { tint: sand }); put("crateAmmo", 0, DECK + AMMO, 0.245, 0.1, { tint: sand });
  });
  // By the doors on the brick side a delivery is half unpacked: the crate it came in, and a pallet with an open
  // slatted crate, an open carton and the cartons still to be shelved.
  within(8.9, 0, -23.6, -Math.PI / 2, () => {
    put("crateLarge", -0.95, 0, -0.02, 0.08);
    within(0.42, 0, 0, -0.05, () => {
      put("pallet", 0, 0, 0);
      put("crateSlat", -0.32, DECK, 0.21, 0.05); put("cartonSmall", -0.445, DECK + 0.013, 0.21, 0.04); put("cartonSmall", -0.15, DECK + 0.013, 0.2, Math.PI / 2 - 0.06);
      put("cartonOpen", 0.39, DECK, 0.25, -0.03);
      put("cartonLarge", -0.3, DECK, -0.21, 0.03); put("cartonLarge", 0.32, DECK, -0.2, -0.05); put("cartonLarge", -0.02, DECK + tall("cartonLarge"), -0.2, 0.12);
    });
  });
  // On the aircraft side, in view through the open bays: totes of consumables and cartons on a pallet, hydraulic fluid and a keg.
  within(-12.2, 0, 1.3, Math.PI / 2 - 0.22, () => {
    put("pallet", 0, 0, 0);
    [[-0.38, 3, 0x1c4fa0], [0.04, 2, 0x1c4fa0], [0.45, 2, 0x2a2c2e]].forEach(([x, count, tint]) => { for (let k = 0; k < count; k += 1) put("cratePlastic", x + (k % 2) * 0.012, DECK + k * TOTE, 0.21, (k - 1) * 0.04, { tint }); });
    put("cartonLarge", -0.29, DECK, -0.2, 0.04); put("cartonLarge", 0.33, DECK, -0.19, -0.03); put("carton", 0.24, DECK + tall("cartonLarge"), -0.2, 0.2);
  });
  put("drum", -10.5, 0, 4.05, 1.2, { tint: 0xc4961c }); put("keg", -10.45, 0, 1.55, 0.4);
  // Behind the tail and by the far racking.
  within(-13.5, 0, -20.5, 0.1, () => { palletLoad(-0.62, 0, 0.03); put("crateLarge", 0.78, 0, -0.08, -0.14); });
  within(-27, 0, 4.2, 0.5, () => { palletLoad(0, 0, -0.03); put("cartonLarge", -0.26, CRATE_TOP, 0.05, 0.2); put("cartonLarge", 0.36, CRATE_TOP, -0.1, -0.1); });
  // Tie-down rings let into the stand.
  for (const [x, z] of [[-28, -6.3], [-11, -6.3], [-19.5, 2.9], [-19.5, -15.5]]) { fineSteel.torus(0.07, 0.012, x, 0.014, z, [Math.PI / 2, 0, 0], 12); fineDark.cyl(0.12, 0.12, 0.008, x, 0.004, z, undefined, 12); }

  // ---- High-bay lamps ------------------------------------------------------
  const lampSpots = TRUSS_Z.slice(0, 5).flatMap((z) => [-27, -19.5, -12, -4, 4, 14].map((x) => ({ x, z })));
  const bell = new THREE.LatheGeometry([[0.06, 0.5], [0.06, 0.42], [0.1, 0.4], [0.11, 0.3], [0.16, 0.24], [0.27, 0.1], [0.36, 0.01], [0.375, 0], [0.375, -0.012]].map(([r, y]) => new THREE.Vector2(r, y)), 24);
  instances(bell, new THREE.MeshStandardMaterial({ color: 0x8a9094, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide }), lampSpots.map(({ x, z }) => ({ position: [x, 10.2, z] as V3 })), false);
  lampSpots.forEach(({ x, z }) => coolGlow.add(new THREE.CircleGeometry(0.3, 20), x, 10.24, z, [Math.PI / 2, 0, 0]));
  lampSpots.forEach(({ x, z }) => { darkwork.box(x, (10.7 + TIE) / 2, z, 0.025, TIE - 10.7, 0.025); fineDark.box(0.16, 0.14, 0.24, x, 10.78, z); });

  // ---- Apron and airfield --------------------------------------------------
  // The sun's shadow frame stops at the door line, so shadows out here are worked out once: each caster hands in the
  // points of its convex body, and their projection along the sun is filled into two ground maps.
  const shades: Array<{ points: Array<[number, number]>; alpha: number }> = [];
  const hull = (points: Array<[number, number]>) => {
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
    for (const p of sorted) { while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (const p of sorted.reverse()) { while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
  };
  const cast = (points: V3[], alpha = 1) => {
    const flat = points.map(([x, y, z]) => {
      const p = new THREE.Vector3(x, y, z).applyMatrix4(frame);
      return [p.x - (TO_SUN.x / TO_SUN.y) * p.y, p.z - (TO_SUN.z / TO_SUN.y) * p.y] as [number, number];
    });
    shades.push({ points: hull(flat), alpha });
  };
  const castBox = (w: number, h: number, d: number, x: number, y: number, z: number, alpha = 1) => {
    const points: V3[] = [];
    for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) points.push([x + sx * w, y + sy * h, z + sz * d]);
    cast(points, alpha);
  };
  const castCyl = (radius: number, y0: number, y1: number, x: number, z: number, alpha = 1, top = radius) => {
    const points: V3[] = [];
    for (let k = 0; k < 12; k += 1) { const a = (k / 12) * Math.PI * 2; points.push([x + Math.cos(a) * radius, y0, z + Math.sin(a) * radius], [x + Math.cos(a) * top, y1, z + Math.sin(a) * top]); }
    cast(points, alpha);
  };
  /** Baked pieces by colour: `shine` glints toward the hangar, `glow` adds light of its own (sky in a window). */
  const F = (hex: number, shine = 0, glow = 0) => farB.tinted(hex, shine, glow);
  const sheeted = (hex: number, shine = 0, glow = 0) => farSheetB.tinted(hex, shine, glow);
  const SKYGLASS = F(0x8fb2d6, 0.5, 0.62), DARKGLASS = F(0x1b2a33, 0.7, 0.2), TYRE = F(0x0d0e0f), FARSTEEL = F(0x6c757a, 0.2), FARWHITE = F(0xeeece4, 0.3), FARCONCRETE = F(0xcbc4b3);

  // Paint beyond the reach of the apron map: taxi-lane edges and centreline run on to both ends of the field.
  for (const [x0, x1] of [[-330, -50], [34, 330]]) {
    const mid = (x0 + x1) / 2, length = x1 - x0;
    for (const z of [-64.9, -65.5, -81.5, -82.1]) F(0xd9a520).box(length, 0.012, 0.16, mid, 0.03, z);
    F(0x18181a).box(length, 0.012, 0.6, mid, 0.02, -73.4);
    F(0xd9a520).box(length, 0.012, 0.32, mid, 0.036, -73.4);
  }
  // Stand guidance boards and taxi signs: lit boxes on frangible legs.
  const taxiSign = (cut: [number, number], x: number, z: number, yaw = 0, width = 1.1) => within(x, 0, z, yaw, () => {
    darkB.box(width + 0.1, 0.65, 0.2, 0, 0.62, 0).box(0.06, 0.32, 0.06, -width * 0.32, 0.16, 0).box(0.06, 0.32, 0.06, width * 0.32, 0.16, 0);
    sign("taxi", width, 0.55, 0, 0.62, 0.105, undefined, signGlow, cut);
    cast([[-width / 2, 0, 0], [width / 2, 0, 0], [-width / 2, 0.93, 0], [width / 2, 0.93, 0], [0, 0.93, 0.2], [0, 0, 0.2]]);
  });
  taxiSign([0, 0.25], -42, -63.4, 0.12);
  taxiSign([0.25, 0.5], 22.5, -63.2, -0.1);
  taxiSign([0.5, 0.75], -33.6, -84.6);
  taxiSign([0.75, 1], 6.4, -84.6);

  /** A neighbouring hangar, front toward +z: sheeted walls under a bowstring roof, sliding leaves, lean-to annex. */
  const farHangar = (w: number, d: number, h: number, o: { wall: number; door: number; trim: number; digit: string; open?: number; annex?: 1 | -1; name?: boolean }) => {
    const rise = w * 0.11, arc = (x: number) => h + rise * (1 - (2 * x / w) ** 2), front = d / 2;
    const wall = sheeted(o.wall), trim = F(o.trim, 0.2), door = sheeted(o.door, 0.15), frameSteel = F(0x59646b, 0.2), roofing = sheeted(0xb9bdbb, 0.3);
    const gable = () => {
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0);
      for (let i = 0; i <= 20; i += 1) { const x = w / 2 - (w * i) / 20; shape.lineTo(x, arc(x)); }
      shape.closePath();
      return new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false });
    };
    wall.add(gable(), 0, 0, front - 0.4).add(gable(), 0, 0, -front);
    for (const side of [-1, 1]) {
      wall.box(0.4, h, d - 0.8, side * (w / 2 - 0.2), h / 2, 0);
      // Translucent sheeting band and a downpipe at each corner.
      F(0xe6dfc2, 0, 0.16).box(0.5, 1.5, d - 4, side * (w / 2 - 0.2), h * 0.7, 0);
      for (const z of [front - 0.6, -front + 0.6]) frameSteel.box(0.16, h, 0.16, side * (w / 2 + 0.12), h / 2, z);
      frameSteel.box(0.22, 0.22, d + 0.6, side * (w / 2 + 0.14), h + 0.05, 0);
    }
    FARCONCRETE.box(w + 0.3, 0.7, d + 0.3, 0, 0.35, 0);
    // Roof sheets in facets along the arc, a fascia over the gable and a ridge ventilator.
    for (let i = 0; i < 14; i += 1) {
      const x0 = -w / 2 - 0.4 + ((w + 0.8) * i) / 14, x1 = x0 + (w + 0.8) / 14, y0 = arc(Math.max(-w / 2, Math.min(w / 2, x0))), y1 = arc(Math.max(-w / 2, Math.min(w / 2, x1)));
      const length = Math.hypot(x1 - x0, y1 - y0) + 0.06;
      roofing.box(length, 0.24, d + 1.2, (x0 + x1) / 2, (y0 + y1) / 2 + 0.1, 0, [0, 0, Math.atan2(y1 - y0, x1 - x0)]);
      trim.box(length, 0.5, 0.12, (x0 + x1) / 2, (y0 + y1) / 2 - 0.08, front + 0.62, [0, 0, Math.atan2(y1 - y0, x1 - x0)]);
    }
    frameSteel.box(1.6, 0.9, d * 0.8, 0, h + rise + 0.6, 0);
    F(0xb9bdbb, 0.3).box(2.2, 0.14, d * 0.8 + 0.4, 0, h + rise + 1.1, 0);
    for (let k = 0; k < 4; k += 1) FARSTEEL.cyl(0.5, 0.5, 0.9, w * 0.25 * (k % 2 ? 1 : -1), arc(w * 0.25) + 0.6, -front + (d * (k + 0.5)) / 4 * 0.9 + d * 0.05, undefined, 10);
    redGlow.sphere(0.16, 0, h + rise + 1.4, front * 0.8, undefined, 8);
    lamp(0, h + rise + 1.4, front * 0.8, 0xff2a1c, 6, 1.8, 2.4, 0.25, 0.2, 0.06);
    // Doorway: header girder, floor track, and leaves on two tracks; open leaves stack behind their neighbours.
    const doorW = w * 0.76, doorH = h * 0.78, leaves = 6, leafW = doorW / leaves, open = o.open ?? 0;
    frameSteel.box(doorW + 3, 0.7, 0.6, 0, doorH + 0.35, front + 0.3).box(0.5, doorH, 0.5, -doorW / 2 - 0.9, doorH / 2, front + 0.25).box(0.5, doorH, 0.5, doorW / 2 + 0.9, doorH / 2, front + 0.25);
    if (open) {
      // The dark of the hall behind the gap, with the nose of whatever stands inside.
      F(0x15191c, 0, 0.1).box(leafW * open, doorH, 0.1, -doorW / 2 + (leafW * open) / 2, doorH / 2, front + 0.02);
      F(0x566068, 0, 0.14).box(leafW * open * 0.5, 0.5, 0.1, -doorW / 2 + (leafW * open) / 2, doorH * 0.48, front + 0.04).box(0.4, doorH * 0.36, 0.1, -doorW / 2 + (leafW * open) / 2, doorH * 0.2, front + 0.04);
      F(0xd8c27a, 0, 0.5).box(leafW * open * 0.8, 0.3, 0.1, -doorW / 2 + (leafW * open) / 2, doorH * 0.9, front + 0.04);
    }
    for (let i = 0; i < leaves; i += 1) {
      const slid = i < open, x = -doorW / 2 + leafW * ((slid ? i + open : i) + 0.5), z = front + (slid ? 0.63 : i % 2 ? 0.41 : 0.19), face = z + 0.07;
      door.box(leafW - 0.1, doorH - 0.1, 0.14, x, doorH / 2 + 0.05, z);
      for (const sx of [-1, 1]) frameSteel.box(0.2, doorH - 0.1, 0.12, x + sx * (leafW / 2 - 0.15), doorH / 2 + 0.05, face);
      for (const fy of [0.03, 0.34, 0.56, 0.97]) frameSteel.box(leafW - 0.5, 0.2, 0.12, x, doorH * fy + 0.1, face);
      for (const sx of [-0.27, 0, 0.27]) SKYGLASS.box(leafW * 0.2, doorH * 0.1, 0.12, x + sx * leafW, doorH * 0.7, face);
      if (i === leaves - 2) F(0x2b3338).box(1.0, 2.1, 0.12, x + 0.4, 1.25, face);
    }
    FARSTEEL.box(doorW + 3, 0.06, 0.9, 0, 0.73, front + 0.5);
    // Number on the gable, name board under it.
    const digitH = Math.min(4.6, (arc(0) - doorH - 1.6) * 0.72), digitY = doorH + 0.9 + (arc(0) - doorH - 0.9) * 0.5;
    const strokes: Record<string, [number, number, number, number]> = { a: [0, 0.5, 0.5, 0], g: [0, 0, 0.5, 0], d: [0, -0.5, 0.5, 0], f: [-0.25, 0.25, 0, 0.5], b: [0.25, 0.25, 0, 0.5], e: [-0.25, -0.25, 0, 0.5], c: [0.25, -0.25, 0, 0.5] };
    const stroke = digitH * 0.15;
    for (const key of ({ "1": "bc", "2": "abged", "4": "fgbc", "5": "afgcd", "6": "afgedc", "7": "abc" } as Record<string, string>)[o.digit] ?? "") {
      const [sx, sy, sw, sh] = strokes[key];
      F(0xf2f0e8, 0, 0.12).box(sw * digitH + stroke, sh * digitH + stroke, 0.14, (o.name ? w * 0.3 : 0) + sx * digitH, digitY + sy * (digitH - stroke), front + 0.02);
    }
    if (o.name) sign("club", 13.6, 1.7, -w * 0.06, digitY, front + 0.06, undefined, signGlow);
    // Lean-to offices and stores along one side.
    if (o.annex) {
      const ax = o.annex * (w / 2 + 4.4), ad = d * 0.62, az = front - ad / 2 - 1.5;
      sheeted(0xd9d2bf).box(8.8, 6.4, ad, ax, 3.2, az);
      FARCONCRETE.box(9.4, 0.3, ad + 0.6, ax, 6.55, az);
      for (const y of [1.9, 4.7]) { SKYGLASS.box(7.2, 1.3, 0.14, ax, y, az + ad / 2 + 0.01); for (let k = -3; k <= 3; k += 1) FARWHITE.box(0.12, 1.4, 0.16, ax + k * 1.2, y, az + ad / 2 + 0.02); }
      for (let k = 0; k < Math.floor(ad / 3.4); k += 1) SKYGLASS.box(0.14, 1.2, 2.2, ax + o.annex * 4.41, 4.7, az - ad / 2 + 2.2 + k * 3.4);
      F(0x2b3338).box(1.1, 2.2, 0.14, ax + 2.6, 1.1, az + ad / 2 + 0.03);
      for (let k = 0; k < 3; k += 1) FARSTEEL.box(1.4, 0.9, 1.0, ax - 2.4 + k * 2.2, 7.15, az + ad * 0.2 - k * 2);
      castBox(8.8, 6.7, ad, ax, 3.35, az);
    }
    cast([[-w / 2, 0, -front], [w / 2, 0, -front], [-w / 2, 0, front], [w / 2, 0, front], [-w / 2, h, -front], [w / 2, h, -front], [-w / 2, h, front], [w / 2, h, front],
      [0, h + rise + 1.1, -front], [0, h + rise + 1.1, front], [-w / 4, arc(w / 4), -front], [w / 4, arc(w / 4), -front], [-w / 4, arc(w / 4), front], [w / 4, arc(w / 4), front]]);
  };
  within(-80, 0, -160, 0.06, () => farHangar(46, 30, 13, { wall: 0xd6d0bd, door: 0x4f7890, trim: 0x2c4a63, digit: "2", annex: -1, name: true, open: 2 }));
  within(54, 0, -168, -0.1, () => farHangar(52, 34, 15, { wall: 0xb9c5c9, door: 0xb5632c, trim: 0x7a3f1c, digit: "4", annex: 1 }));
  within(-112, 0, -98, Math.PI / 2, () => farHangar(40, 28, 12, { wall: 0xc8b594, door: 0x6c7f58, trim: 0x3d4a33, digit: "1" }));
  within(104, 0, -116, -Math.PI / 2, () => farHangar(40, 28, 11.5, { wall: 0xd9d6cc, door: 0x86929a, trim: 0x39566b, digit: "5", open: 1 }));

  // Control tower: ribbed shaft over an operations block, a raked glass cab under a wide roof, aerials above.
  within(-34, 0, -172, 0.25, () => {
    const shaft = F(0xd0c9b8), cab = F(0x20333f, 0.9, 0.34);
    F(0xd9d2bf).box(17, 7, 12, 6.5, 3.5, 0.5);
    FARCONCRETE.box(17.6, 0.4, 12.6, 6.5, 7.2, 0.5);
    for (const y of [2.1, 5]) { SKYGLASS.box(13.6, 1.3, 0.14, 7, y, 6.46); for (let k = 0; k <= 8; k += 1) FARWHITE.box(0.14, 1.4, 0.16, 0.2 + k * 1.7, y, 6.47); }
    FARSTEEL.box(2.0, 1.2, 1.6, 9, 8, -1).box(1.2, 0.8, 1.2, 12, 7.8, 2);
    castBox(17, 7.4, 12, 6.5, 3.7, 0.5);
    shaft.cyl(3.0, 3.4, 27, 0, 13.5, 0, [0, Math.PI / 8, 0], 8);
    for (let k = 0; k < 4; k += 1) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; F(0xbdb5a3).box(0.7, 27, 0.7, Math.cos(a) * 3.05, 13.5, Math.sin(a) * 3.05, [0, -a, 0]); }
    for (let y = 4.2; y < 25; y += 3.4) { DARKGLASS.box(0.9, 1.7, 0.2, 0, y, 2.98); DARKGLASS.box(0.2, 1.7, 0.9, -2.98, y, 0); }
    for (const y of [9, 18]) F(0xbdb5a3).cyl(3.32, 3.36, 0.4, 0, y, 0, [0, Math.PI / 8, 0], 8);
    shaft.cyl(5.5, 3.1, 3.2, 0, 28.6, 0, [0, Math.PI / 8, 0], 8);
    FARCONCRETE.cyl(6.7, 6.7, 0.34, 0, 30.37, 0, [0, Math.PI / 8, 0], 8);
    cab.cyl(6.2, 5.3, 3.5, 0, 32.3, 0, [0, Math.PI / 8, 0], 8);
    FARWHITE.cyl(5.36, 5.36, 0.5, 0, 30.79, 0, [0, Math.PI / 8, 0], 8);
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2, b = a + Math.PI / 4;
      FARWHITE.rod([Math.cos(a) * 5.36, 30.6, Math.sin(a) * 5.36], [Math.cos(a) * 6.26, 34.1, Math.sin(a) * 6.26], 0.11, 5);
      FARSTEEL.rod([Math.cos(a) * 6.55, 30.5, Math.sin(a) * 6.55], [Math.cos(a) * 6.55, 31.65, Math.sin(a) * 6.55], 0.05, 4);
      for (const y of [31.1, 31.65]) FARSTEEL.rod([Math.cos(a) * 6.55, y, Math.sin(a) * 6.55], [Math.cos(b) * 6.55, y, Math.sin(b) * 6.55], 0.045, 4);
    }
    FARWHITE.cyl(7.1, 6.9, 0.55, 0, 34.33, 0, [0, Math.PI / 8, 0], 8).cyl(3.2, 3.8, 0.9, 0, 35.05, 0, undefined, 12);
    FARWHITE.sphere(1.25, -1.6, 36.3, 0.8, undefined, 14);
    FARSTEEL.cyl(0.07, 0.1, 7, 1, 39, -0.4, undefined, 5).cyl(0.05, 0.05, 4, -0.2, 37.5, -1.6, undefined, 5).box(1.6, 0.06, 0.06, 1, 40.6, -0.4).box(0.06, 0.06, 1.2, 1, 39.6, -0.4);
    redGlow.sphere(0.2, 1, 42.6, -0.4, undefined, 8).sphere(0.14, -0.2, 39.6, -1.6, undefined, 6);
    greenGlow.sphere(0.2, 0, 35.7, 2.6, undefined, 8);
    // The aerodrome beacon: a white flash, then a green one, each every four and a half seconds.
    lamp(0, 35.7, 2.6, 0xf4f8ff, 16, 3.4, 4.5, 0, 0.04);
    lamp(0, 35.7, 2.6, 0x38ff86, 13, 3.4, 4.5, 0.5, 0.04);
    lamp(1, 42.6, -0.4, 0xff2a1c, 7, 2, 2.4, 0.5, 0.2, 0.06);
    castCyl(3.4, 0, 27, 0, 0, 1, 3.0);
    castCyl(5.3, 28, 30.4, 0, 0, 1, 6.7);
    castCyl(6.7, 30.4, 34.6, 0, 0, 1, 7.1);
  });

  // Flood-light masts behind the remote stands: tapered pole, climbing ladder with rest platform, a head frame of eight lamps.
  for (const x of [-49, -5, 33]) within(x, 0, -114.5, 0, () => {
    FARCONCRETE.cyl(0.7, 0.8, 0.6, 0, 0.3, 0, undefined, 10);
    FARSTEEL.cyl(0.15, 0.32, 25, 0, 13.1, 0, undefined, 8);
    F(0x3a4146).box(0.5, 1.1, 0.34, 0, 1.6, 0.36);
    for (const sx of [-0.2, 0.2]) FARSTEEL.box(0.045, 17, 0.045, sx, 11.5, -0.38);
    for (let y = 3.4; y < 20; y += 0.9) FARSTEEL.box(0.4, 0.04, 0.04, 0, y, -0.38);
    FARSTEEL.cyl(0.95, 0.95, 0.07, 0, 20.4, 0, undefined, 10);
    for (let k = 0; k < 10; k += 1) { const a = (k / 10) * Math.PI * 2; FARSTEEL.box(0.045, 1.1, 0.045, Math.cos(a) * 0.92, 20.95, Math.sin(a) * 0.92); }
    FARSTEEL.torus(0.92, 0.03, 0, 21.5, 0, [Math.PI / 2, 0, 0], 10);
    for (const y of [24.3, 25.4]) {
      FARSTEEL.box(4.6, 0.14, 0.14, 0, y, 0);
      for (const sx of [-1.95, -0.65, 0.65, 1.95]) { F(0x30373c).box(0.9, 0.62, 0.42, sx, y - 0.1, 0.34, [0.55, 0, 0]); F(0xdfe6ea, 0.8, 0.5).box(0.76, 0.5, 0.06, sx, y - 0.22, 0.54, [0.55, 0, 0]); }
    }
    for (const sx of [-2.2, 2.2]) FARSTEEL.box(0.1, 1.4, 0.1, sx, 24.85, 0);
    redGlow.sphere(0.14, 0, 25.9, 0, undefined, 6);
    lamp(0, 25.9, 0, 0xff2a1c, 7, 1.8, 2.4, 0, 0.2, 0.06);
    cast([[-0.3, 0, 0], [0.3, 0, 0], [-0.15, 24, 0], [0.15, 24, 0]]);
    castBox(4.8, 1.9, 0.6, 0, 24.9, 0.2);
    castCyl(0.95, 20.4, 20.5, 0, 0);
  });

  /** A parked turboprop in open sun, lit in its vertices: the same airframe as CS-DE2 at a tenth of the cost. */
  const aircraftShade = () => {
    const body: V3[] = [];
    for (const s of [0.3, 1.6, 4.8, 9, 14, 19.5, 23.5, 26]) { const r = radiusAt(s), c = centreAt(s); body.push([-r, c, -s], [r, c, -s], [0, c - r, -s], [0, c + r, -s]); }
    cast(body);
    cast([[0, 5.32, -9.8], [0, 5.32, -13.7], [-11.5, 4.94, -10.5], [-11.5, 4.94, -11.83], [11.5, 4.94, -10.5], [11.5, 4.94, -11.83]]);
    cast([[0, 10.42, -22.9], [0, 10.42, -25.2], [-4.3, 10.42, -23.9], [-4.3, 10.42, -25.1], [4.3, 10.42, -23.9], [4.3, 10.42, -25.1]]);
    cast([[0, 4.4, -19.4], [0, 10.45, -22.7], [0, 10.45, -25.2], [0, 4.4, -24.1]]);
    for (const side of [-1, 1]) {
      cast([[side * 4.6 - 0.64, 4.58, -8.4], [side * 4.6 + 0.64, 4.58, -8.4], [side * 4.6, 3.94, -8.4], [side * 4.6, 5.22, -8.4], [side * 4.6 - 0.5, 4.58, -13], [side * 4.6 + 0.5, 4.58, -13], [side * 4.6, 4.1, -13], [side * 4.6, 5.1, -13]]);
      castBox(1.3, 2.3, 3.4, side * 1.9, 1.15, -12.2);
    }
    castBox(0.7, 1.7, 1.0, 0, 0.85, -3.2);
  };
  const farAircraft = (trim: number, tail: number, bare = 0, P: (hex: number, shine?: number, glow?: number) => Batch = F, airborne = false) => {
    const body = P(0xe7e8e4, 0.5), band = P(trim, 0.3), dark = P(0x141a1e, 0.6, 0.14), strut = P(0xa3a9ab, 0.2), black = P(0x15171a, 0.2);
    const S = [0, 0.12, 0.4, 0.9, 1.6, 2.5, 3.6, 4.8, 8, 11, 14, 15.5, 17.5, 19.5, 21.5, 23.5, 25.2, 26, 26.2];
    body.add(skinPatch(S, 0, 1, 20));
    P(0x8a9296, 0.2).add(skinPatch(S.slice(4, 16), -0.16, 0.16, 6, 0.03));
    black.add(skinPatch(S.slice(0, 4), 0, 1, 20, 0.03));
    for (const v of [0.19, 0.81]) band.add(skinPatch(steps(1.2, 24, 12), v - 0.022, v + 0.022, 1, 0.04));
    for (let s = 5.6; s < 15.2; s += 0.95) for (const v of [0.3, 0.7]) dark.add(skinPatch([s, s + 0.3], v - 0.02, v + 0.02, 1, 0.05));
    dark.add(skinPatch(steps(COCKPIT.s0, COCKPIT.s1, 3), 0.5 - COCKPIT.half, 0.5 + COCKPIT.half, 6, 0.04));
    for (const side of [-1, 1]) {
      liftSurface(body, (t) => new THREE.Vector3(side * t * 11.5, 5.32 - t * 0.38, -9.8 - t * 0.7), (t) => (3.9 - 2 * t) * (t > 0.999 ? 0.7 : 1), (t) => 1.55 - 0.4 * t, up, [[0, 1]]);
      liftSurface(body, (t) => new THREE.Vector3(side * t * 4.3, 10.42, -22.9 - t), (t) => 2.3 - 1.1 * t, () => 1.1, up, [[0, 1]]);
      body.sphere(1, side * 1.72, 1.72, -12.2, [0.62, 0.62, 2.7], 12);
      strut.cyl(0.09, 0.09, 1.3, side * 1.86, 1.15, -12.2, undefined, 6);
      for (const z of [-11.55, -12.85]) black.cyl(0.55, 0.55, 0.36, side * 2.12, 0.55, z, [0, 0, Math.PI / 2], 14);
      const ex = side * 4.6, ey = 4.58;
      body.add(latheZ(NACELLE, 14), ex, ey, -8.3);
      band.cyl(0.66, 0.66, 0.5, ex, ey, -9.3, ALONG, 14, true);
      dark.torus(0.2, 0.05, ex, ey - 0.5, -8.44, undefined, 10, [1.5, 0.7, 1]);
      if (bare === side) { strut.cyl(0.16, 0.2, 0.3, ex, ey, -8.2, ALONG, 10); continue; }
      strut.add(latheZ([[0, 0], [0.1, 0.03], [0.2, 0.16], [0.27, 0.38], [0.3, 0.62], [0.3, 0.74]], 10), ex, ey, -7.66);
      if (!airborne) for (let k = 0; k < 6; k += 1) { const a = (k / 6) * Math.PI * 2 + 0.3; black.box(0.26, 1.72, 0.05, ex + Math.sin(a) * 1.12, ey + Math.cos(a) * 1.12, -8.02, [0, 0, -a]); }
    }
    body.rbox(2.5, 0.62, 4.6, 0.28, 0, 5.12, -11.6);
    liftSurface(P(tail, 0.3), (t) => new THREE.Vector3(0, 4.4 + t * 6.05, -19.4 - t * 3.3), (t) => 4.7 - 2.2 * t, () => 1.25, out, [[0, 1]]);
    body.sphere(0.22, 0, 10.45, -22.6, [1, 1, 3.2], 8);
    strut.cyl(0.075, 0.075, 1.3, 0, 1.05, -3.2, undefined, 6);
    for (const x of [-0.24, 0.24]) black.cyl(0.42, 0.42, 0.24, x, 0.42, -3.2, [0, 0, Math.PI / 2], 12);
    if (airborne) return;
    redGlow.sphere(0.08, 0, 5.47, -12.6, undefined, 6);
    aircraftShade();
  };
  // A sister ship on stand 128, nose to the hangar and waiting for its No 2 propeller; two more out by the far hangars.
  within(9, 0, -85.6, 0.03, () => {
    farAircraft(0x1c3550, 0x1c3550, -1);
    // The removed propeller on its transport stand, and a work platform under the bare shaft.
    within(-9.4, 0, -4.2, 0.4, () => {
      F(0xc79a1e).box(2.4, 0.12, 2.4, 0, 0.5, 0).box(0.12, 0.5, 0.12, -1.1, 0.25, -1.1).box(0.12, 0.5, 0.12, 1.1, 0.25, -1.1).box(0.12, 0.5, 0.12, -1.1, 0.25, 1.1).box(0.12, 0.5, 0.12, 1.1, 0.25, 1.1);
      for (let k = 0; k < 6; k += 1) { const a = (k / 6) * Math.PI * 2; F(0x15171a, 0.2).box(0.26, 0.05, 1.72, Math.sin(a) * 1.12, 0.74, Math.cos(a) * 1.12, [0, a, 0]); }
      F(0xa3a9ab, 0.3).cyl(0.3, 0.3, 0.5, 0, 0.8, 0, undefined, 10);
      cast([[-2, 0.74, -2], [2, 0.74, -2], [-2, 0.74, 2], [2, 0.74, 2]], 0.7);
    });
    within(-4.6, 0, -6.4, 0, () => {
      const stand = F(0xc79a1e, 0.2);
      for (const sx of [-0.9, 0.9]) for (const sz of [-0.7, 0.7]) stand.box(0.1, 3.4, 0.1, sx, 1.7, sz).box(0.07, 1.1, 0.07, sx, 3.95, sz);
      F(0x8d969b, 0.3).box(2.0, 0.08, 1.6, 0, 3.4, 0);
      stand.box(2.0, 0.07, 0.07, 0, 4.5, 0.7).box(2.0, 0.07, 0.07, 0, 4.5, -0.7).box(0.07, 0.07, 1.4, -0.9, 4.5, 0).box(0.07, 0.07, 1.4, 0.9, 4.5, 0);
      stand.bar([-0.9, 0.2, 0.7], [-0.9, 3.3, -0.7], 0.07).bar([0.9, 0.2, 0.7], [0.9, 3.3, -0.7], 0.07).bar([-0.9, 0.2, 0.7], [0.9, 3.3, 0.7], 0.07);
      cast([[-1, 3.4, -0.8], [1, 3.4, -0.8], [-1, 3.4, 0.8], [1, 3.4, 0.8]], 0.85);
    });
  });
  within(30, 0, -139, -1.05, () => farAircraft(0xb5632c, 0xb5632c));
  within(-140, 0, -128, 2.2, () => within(0, 0, 0, 0, () => farAircraft(0x2f6f7a, 0xe7e8e4), 0.78));

  // Fuel farm behind the service road: three bunded tanks with stair, rail and manifold.
  within(-6, 0, -196, 0, () => {
    [-13.5, 0, 13.5].forEach((x, index) => {
      FARWHITE.cyl(5.4, 5.4, 10, x, 5, 0, undefined, 24);
      FARWHITE.sphere(5.4, x, 10, 0, [1, 0.16, 1], 20);
      F(index === 1 ? 0xb5632c : 0x1c3550, 0.2).cyl(5.46, 5.46, 1.0, x, 8.6, 0, undefined, 24, true);
      for (const y of [3.2, 6.4]) F(0xc9cbc6).cyl(5.45, 5.45, 0.12, x, y, 0, undefined, 24, true);
      for (let k = 0; k < 16; k += 1) { const a = 0.5 + k * 0.17; FARSTEEL.box(0.9, 0.08, 0.5, x + Math.cos(a) * 5.85, 0.6 + k * 0.6, Math.sin(a) * 5.85, [0, -a, 0]); }
      for (let k = 0; k < 12; k += 1) { const a = (k / 12) * Math.PI * 2; FARSTEEL.box(0.06, 1.0, 0.06, x + Math.cos(a) * 5.3, 10.5, Math.sin(a) * 5.3); }
      FARSTEEL.torus(5.3, 0.04, x, 11, 0, [Math.PI / 2, 0, 0], 24).cyl(0.3, 0.3, 0.7, x, 11.1, 0, undefined, 8);
      castCyl(5.4, 0, 10.6, x, 0);
    });
    FARCONCRETE.box(42, 1.3, 0.4, 0, 0.65, 7.6).box(0.4, 1.3, 15.2, -21, 0.65, 0).box(0.4, 1.3, 15.2, 21, 0.65, 0);
    F(0xc9a227, 0.3).box(30, 0.3, 0.3, 0, 1.75, 6.6);
    for (const x of [-13.5, 0, 13.5]) F(0xc9a227, 0.3).box(0.3, 0.3, 1.5, x, 1.75, 5.9);
    F(0xa33a2a).box(1.6, 1.6, 1.2, 17, 2.1, 8.6);
    castBox(42, 1.3, 0.4, 0, 0.65, 7.6);
  });

  // Surveillance radar on a lattice tower, out past the left-hand hangars.
  within(-128, 0, -196, 0.5, () => {
    const lattice = F(0xc8c9c4, 0.1), red = F(0xb5362a, 0.1);
    for (let bay = 0; bay < 6; bay += 1) {
      const y0 = bay * 4.4, y1 = y0 + 4.4, r0 = 3.2 - bay * 0.36, r1 = r0 - 0.36, paint = bay % 2 ? lattice : red;
      for (let k = 0; k < 4; k += 1) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4, b = a + Math.PI / 2;
        const leg0: V3 = [Math.cos(a) * r0, y0, Math.sin(a) * r0], leg1: V3 = [Math.cos(a) * r1, y1, Math.sin(a) * r1], next0: V3 = [Math.cos(b) * r0, y0, Math.sin(b) * r0], next1: V3 = [Math.cos(b) * r1, y1, Math.sin(b) * r1];
        paint.bar(leg0, leg1, 0.2).bar(leg1, next1, 0.12).bar(leg0, next1, 0.1).bar(next0, leg1, 0.1);
      }
    }
    FARSTEEL.box(4.6, 0.2, 4.6, 0, 26.5, 0);
    for (let k = 0; k < 12; k += 1) { const a = (k / 12) * Math.PI * 2; FARSTEEL.box(0.06, 1.1, 0.06, Math.cos(a) * 2.9, 27.1, Math.sin(a) * 2.9); }
    FARSTEEL.torus(2.9, 0.04, 0, 27.65, 0, [Math.PI / 2, 0, 0], 12);
    FARWHITE.cyl(1.9, 2.1, 1.4, 0, 27.3, 0, undefined, 12).sphere(3.1, 0, 30.4, 0, undefined, 18);
    redGlow.sphere(0.2, 0, 33.7, 0, undefined, 6);
    lamp(0, 33.7, 0, 0xff2a1c, 7, 2, 2.4, 0.75, 0.2, 0.06);
    cast([[-2.3, 0, -2.3], [2.3, 0, -2.3], [-2.3, 0, 2.3], [2.3, 0, 2.3], [-0.8, 26, -0.8], [0.8, 26, -0.8], [-0.8, 26, 0.8], [0.8, 26, 0.8]], 0.5);
    castCyl(3.1, 27.5, 33.4, 0, 0);
    castBox(4.6, 0.2, 4.6, 0, 26.5, 0);
  });

  // Vehicles about the far side: vans, a crew bus, a flatbed, staff cars by the tower.
  const farVan = (tint: number, kind: "van" | "flatbed" | "bus" = "van") => {
    const paintwork = F(tint, 0.4), long = kind === "bus" ? 7.4 : 5;
    if (kind === "flatbed") paintwork.box(3.3, 0.28, 2.0, -0.85, 0.95, 0); else paintwork.box(long - 1.5, kind === "bus" ? 2.2 : 1.9, 2.0, -0.75, kind === "bus" ? 1.6 : 1.5, 0);
    paintwork.box(1.5, 1.5, 2.0, long / 2 - 0.75, 1.2, 0);
    DARKGLASS.box(0.1, 0.62, 1.7, long / 2 - 0.02, 1.52, 0).box(0.8, 0.5, 2.1, long / 2 - 0.75, 1.55, 0);
    if (kind === "bus") DARKGLASS.box(long - 2.2, 0.62, 2.1, -0.75, 2.05, 0);
    for (const x of [-long / 2 + 1.1, long / 2 - 1.0]) for (const z of [-0.9, 0.9]) TYRE.cyl(0.4, 0.4, 0.3, x, 0.4, z, ALONG, 10);
    castBox(long, kind === "flatbed" ? 1.9 : 2.5, 2.0, 0, kind === "flatbed" ? 0.95 : 1.25, 0);
  };
  const farCar = (tint: number) => {
    F(tint, 0.6).box(4.2, 0.62, 1.74, 0, 0.62, 0);
    DARKGLASS.box(2.1, 0.5, 1.56, -0.15, 1.17, 0);
    F(tint, 0.6).box(1.9, 0.06, 1.5, -0.15, 1.44, 0);
    for (const x of [-1.35, 1.35]) for (const z of [-0.8, 0.8]) TYRE.cyl(0.33, 0.33, 0.24, x, 0.33, z, ALONG, 8);
    castBox(4.2, 1.45, 1.74, 0, 0.72, 0);
  };
  within(-52, 0, -138, 0.3, () => farVan(0xe7e4d8));
  within(-64, 0, -139.5, 1.7, () => farVan(0xc79a1e, "flatbed"));
  within(18, 0, -146, -0.2, () => farVan(0xe7e4d8, "bus"));
  within(74, 0, -144, 1.2, () => farVan(0x39566b));
  within(-98, 0, -124, 0.1, () => farVan(0xb5362a, "flatbed"));
  [0xe7e4d8, 0x8a2f24, 0x2c4a63, 0x9aa0a3, 0x1d1f22, 0xd8c27a, 0xe7e4d8].forEach((tint, index) => within(-15 + index * 2.9, 0, -160.5 + (index % 3) * 0.2, Math.PI / 2 + (index % 2 ? 0.04 : -0.03), () => farCar(tint)));

  // Perimeter fence behind the buildings: chain link on posts under three strands of wire, drawn once per bay.
  const fenceMap = track(canvasTexture(512, 256, (context) => {
    context.clearRect(0, 0, 512, 256);
    context.strokeStyle = "rgba(168,174,176,.82)"; context.lineWidth = 1.1;
    for (let i = -256; i < 512; i += 13) { context.beginPath(); context.moveTo(i, 46); context.lineTo(i + 210, 256); context.moveTo(i + 210, 46); context.lineTo(i, 256); context.stroke(); }
    context.strokeStyle = "rgba(190,196,198,.95)"; context.lineWidth = 3;
    for (const y of [47, 150, 253]) { context.beginPath(); context.moveTo(0, y); context.lineTo(512, y); context.stroke(); }
    context.lineWidth = 1.4;
    for (const y of [8, 20, 32]) { context.beginPath(); context.moveTo(0, y); context.lineTo(512, y); context.stroke(); for (let x = 6; x < 512; x += 22) { context.beginPath(); context.moveTo(x - 3, y - 3); context.lineTo(x + 3, y + 3); context.moveTo(x + 3, y - 3); context.lineTo(x - 3, y + 3); context.stroke(); } }
    context.fillStyle = "rgba(150,156,158,1)"; context.fillRect(250, 40, 12, 216);
    context.lineWidth = 6; context.strokeStyle = "rgba(150,156,158,1)"; context.beginPath(); context.moveTo(256, 44); context.lineTo(238, 4); context.stroke();
  }, true));
  fenceMap.anisotropy = anisotropy;
  const fenceMaterial = new THREE.MeshBasicMaterial({ map: fenceMap, color: 0xb9b6ac, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const fenceRun = (x0: number, z0: number, x1: number, z1: number) => {
    const length = Math.hypot(x1 - x0, z1 - z0), geometry = new THREE.PlaneGeometry(length, 3.1), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * Math.round(length / 3.6));
    geometry.rotateY(Math.atan2(-(z1 - z0), x1 - x0));
    geometry.translate((x0 + x1) / 2, 1.55, (z0 + z1) / 2);
    return geometry;
  };
  const fenceRuns = [fenceRun(-262, -214, 262, -214), fenceRun(-262, -214, -262, -40), fenceRun(262, -40, 262, -214)];
  const fence = new THREE.Mesh(track(mergeGeometries(fenceRuns)), fenceMaterial);
  fenceRuns.forEach((run) => run.dispose());
  fence.renderOrder = -5;
  scene.add(fence);
  kit.mirrorHidden.push(fence);
  // Gate house and barrier where the service road leaves the field.
  within(92, 0, -211, 0, () => {
    F(0xd9d2bf).box(4.2, 3, 3.4, 0, 1.5, 0);
    FARCONCRETE.box(5.2, 0.24, 4.4, 0, 3.12, 0);
    SKYGLASS.box(3.2, 1.1, 0.14, 0, 1.9, 1.66);
    F(0xb5362a).box(7, 0.16, 0.16, -6, 1.1, 2.2);
    FARWHITE.box(0.3, 1.2, 0.3, -2.5, 0.6, 2.2);
    castBox(5.2, 3.2, 4.4, 0, 1.6, 0);
  });

  // Fuel bowser waiting on the apron.
  within(-2, 0, -58, 0.5, () => {
    const tank = new THREE.CapsuleGeometry(1.15, 5.2, 8, 24);
    whiteB.add(tank, -0.9, 2.05, 0, [0, 0, Math.PI / 2]);
    for (const x of [-3.2, -0.9, 1.4]) steelB.torus(1.16, 0.04, x, 2.05, 0, [0, Math.PI / 2, 0], 28);
    plateB.box(5.6, 0.04, 0.7, -0.9, 3.24, 0);
    for (const x of [-2.4, 0.4]) darkB.cyl(0.3, 0.3, 0.14, x, 3.3, 0, undefined, 16);
    for (const z of [-0.36, 0.36]) { brightB.rod([-3.7, 3.7, z], [1.9, 3.7, z], 0.02, 6); for (let x = -3.7; x <= 1.9; x += 1.4) brightB.rod([x, 3.24, z], [x, 3.7, z], 0.02, 6); }
    for (const z of [-0.2, 0.2]) brightB.rod([-4.72, 0.8, z], [-4.3, 3.3, z], 0.02, 6);
    for (let k = 0; k < 8; k += 1) brightB.rod([-4.72 + k * 0.055, 0.95 + k * 0.32, -0.2], [-4.72 + k * 0.055, 0.95 + k * 0.32, 0.2], 0.015, 5);
    sign("fuel", 2.4, 1.2, -0.9, 2.1, 1.158); sign("fuel", 2.4, 1.2, -0.9, 2.1, -1.158, [0, Math.PI, 0]);
    // Pump cabinet with hose reel and meter.
    steelB.rbox(1.5, 0.9, 0.5, 0.03, -2.4, 1.2, 1.12);
    rubberB.torus(0.3, 0.07, -2.7, 1.2, 1.4, undefined, 20);
    redB.cyl(0.36, 0.36, 0.04, -2.7, 1.2, 1.36, ALONG, 18);
    plasticB.cyl(0.12, 0.12, 0.03, -1.95, 1.3, 1.385, ALONG, 14);
    darkB.box(9.4, 0.3, 2.2, 0.4, 0.75, 0).rbox(2.5, 0.3, 0.3, 0.05, 5.0, 0.6, 0, [0, Math.PI / 2, 0]);
    yellowB.rbox(2.1, 2.2, 2.4, 0.12, 3.9, 1.6, 0);
    glassB.box(0.04, 0.8, 2.1, 4.96, 2.1, 0).box(1.0, 0.7, 0.04, 4.2, 2.15, 1.205).box(1.0, 0.7, 0.04, 4.2, 2.15, -1.205);
    for (const z of [-0.85, 0.85]) { plasticB.cyl(0.11, 0.11, 0.04, 4.96, 1.05, z, [0, 0, Math.PI / 2], 12); darkB.rod([4.6, 2.4, z * 1.42], [4.9, 2.5, z * 1.7], 0.012, 5).box(0.04, 0.34, 0.2, 4.9, 2.4, z * 1.7); }
    amberGlow.cyl(0.07, 0.08, 0.12, 3.6, 2.77, 0.6, undefined, 12);
    darkB.cyl(0.05, 0.05, 1.6, 2.7, 2.2, 1.0, undefined, 8);
    for (const x of [-3.2, -1.9, 3.6]) for (const z of [-1.05, 1.05]) { wheel(x, 0.5, z, 0.5, 0.34, steelB, "z", 16); rubberB.box(1.2, 0.04, 0.4, x, 1.08, z); }
    orangeB.add(cone.clone(), 5.9, 0, 1.5).add(cone.clone(), -5.4, 0, -1.6);
    yellowB.add(chock.clone(), 3.985, 0, 1.05, [0, -Math.PI / 2, 0]).add(chock.clone(), 3.215, 0, 1.05, [0, Math.PI / 2, 0]);
    // Its shadow: tank, cab, chassis and wheels.
    const tankShade: V3[] = [];
    for (const x of [-4.6, -3.8, 2.0, 2.8]) for (let k = 0; k < 8; k += 1) { const a = (k / 8) * Math.PI * 2, r = Math.abs(x + 0.9) > 3 ? 0.7 : 1.15; tankShade.push([x, 2.05 + Math.cos(a) * r, Math.sin(a) * r]); }
    cast(tankShade);
    castBox(2.1, 2.2, 2.4, 3.9, 1.6, 0);
    castBox(9.4, 0.9, 2.3, 0.4, 0.45, 0);
    castBox(5.6, 0.5, 0.75, -0.9, 3.45, 0, 0.5);
  });
  // Windsock on a hinged mast.
  within(13, 0, -61.5, 0, () => {
    concreteB.cyl(0.4, 0.4, 0.3, 0, 0.15, 0, undefined, 12);
    for (let k = 0; k < 6; k += 1) (k % 2 ? redB : plasticB).cyl(0.06, 0.07, 1.1, 0, 0.85 + k * 1.1, 0, undefined, 10);
    // The hoop swivels to face downwind; the sock on it is the moving piece below, and throws no painted shadow.
    brightB.torus(0.42, 0.02, wind.direction.x * 0.05, 7.1, wind.direction.y * 0.05, [0, Math.atan2(wind.direction.x, wind.direction.y), 0], 16);
    redGlow.sphere(0.08, 0, 7.6, 0, undefined, 8);
    cast([[-0.07, 0, 0], [0.07, 0, 0], [-0.06, 7.2, 0], [0.06, 7.2, 0]]);
    castCyl(0.4, 0, 0.3, 0, 0);
  });
  // The sock: five bands on one mesh that fills and streams in a gust and hangs in a lull, reading the wind at the
  // mast. Its few hundred vertices are placed each frame rather than bent in a shader, so the depth and occlusion
  // passes see the same shape as the eye. Its long axis is local +x, turned downwind.
  const SOCK = { x: 13, y: 7.1, z: -61.5, yaw: Math.atan2(-wind.direction.y, wind.direction.x), length: 3.1, rows: 25, around: 14 };
  const sockMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const sockAt = new THREE.BufferAttribute(new Float32Array(SOCK.rows * (SOCK.around + 1) * 3), 3), sockTint = new THREE.BufferAttribute(new Float32Array(SOCK.rows * (SOCK.around + 1) * 3), 3);
  const sockPaints = [new THREE.Color(0xd9571c), new THREE.Color(0xe9e6dc)], sockSun = TO_SUN.clone().applyAxisAngle(UP, -SOCK.yaw);
  const sock = (() => {
    const index: number[] = [];
    for (let row = 0; row < SOCK.rows; row += 1) if (row % 5 < 4) for (let j = 0; j < SOCK.around; j += 1) {
      const p = row * (SOCK.around + 1) + j, q = p + SOCK.around + 1;
      index.push(p, q, p + 1, p + 1, q, q + 1);
    }
    sockAt.setUsage(THREE.DynamicDrawUsage);
    sockTint.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", sockAt);
    geometry.setAttribute("color", sockTint);
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(1.4, -1, 0), 4);
    const mesh = new THREE.Mesh(track(geometry), track(sockMaterial));
    mesh.position.set(SOCK.x, SOCK.y, SOCK.z);
    mesh.rotation.y = SOCK.yaw;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    return mesh;
  })();
  /** Shapes the sock for the wind at its mast: rows of five to a band, so the bands keep hard edges. */
  const streamSock = (t: number) => {
    const blow = wind.at(SOCK.x, SOCK.z), fill = THREE.MathUtils.smoothstep(blow, 0, 0.34);
    for (let row = 0, v = 0; row < SOCK.rows; row += 1) {
      const band = Math.floor(row / 5), along = (band + (row % 5) / 4) / 5, paint = sockPaints[band % 2];
      const bend = (1 - fill) * 1.3 * (0.3 + 0.7 * along) + 0.06 + 0.05 * Math.sin(t * 1.7) * along, c = Math.cos(bend), s = Math.sin(bend);
      const live = along * (0.25 + blow), lift = Math.sin(along * 9 - t * 9.5) * 0.09 * live, side = Math.cos(along * 7 - t * 7.7) * 0.1 * live;
      const reach = along * SOCK.length, radius = (0.42 - 0.3 * along) * (1 - (0.5 - 0.5 * fill) * along);
      for (let j = 0; j <= SOCK.around; j += 1, v += 1) {
        const a = (j / SOCK.around) * Math.PI * 2, ny = Math.cos(a), nz = Math.sin(a);
        sockAt.setXYZ(v, reach * c + ny * radius * s, ny * radius * c - reach * s + lift, nz * radius + side);
        const shade = 0.5 + 2.86 * Math.max(0, ny * s * sockSun.x + ny * c * sockSun.y + nz * sockSun.z);
        sockTint.setXYZ(v, paint.r * shade, paint.g * shade, paint.b * shade);
      }
    }
    sockAt.needsUpdate = true;
    sockTint.needsUpdate = true;
  };
  streamSock(0);
  // Aircraft tractor parked off the lead-out line, its tow bar laid out behind.
  within(-11.6, 0, -39.4, 0.32, () => {
    // Ballast chassis between four big wheels, tread-plate deck, bumpers proud at both ends.
    yellowB.rbox(4.3, 0.52, 1.44, 0.06, 0, 0.68, 0).rbox(1.5, 0.52, 2.16, 0.06, 0, 0.68, 0);
    plateB.box(4.2, 0.03, 1.4, 0, 0.955, 0);
    darkB.box(4.1, 0.14, 1.3, 0, 0.36, 0);
    for (const x of [-1.38, 1.38]) for (const z of [-0.9, 0.9]) {
      wheel(x, 0.5, z, 0.5, 0.36, yellowB, "z", 16);
      darkB.add(new THREE.TorusGeometry(0.6, 0.06, 6, 14, Math.PI), x, 0.5, z + Math.sign(z) * 0.15);
      yellowB.box(1.26, 0.06, 0.42, x, 1.12, z).box(0.06, 0.3, 0.42, x - 0.6, 0.98, z).box(0.06, 0.3, 0.42, x + 0.6, 0.98, z);
    }
    for (const end of [-1, 1]) {
      darkB.rbox(0.22, 0.44, 2.2, 0.05, end * 2.2, 0.6, 0);
      hazardStrip(2.0, 0.26, end * 2.316, 0.6, 0, [0, end * Math.PI / 2, 0]);
      darkB.box(0.26, 0.1, 0.26, end * 2.42, 0.44, 0);
      brightB.cyl(0.03, 0.03, 0.2, end * 2.44, 0.5, 0, undefined, 8);
    }
    // Open-sided cab on four posts: screen, roof, seat, wheel, dash.
    for (const x of [0.36, 1.74]) for (const z of [-0.74, 0.74]) darkB.box(0.06, 1.02, 0.06, x, 1.47, z);
    yellowB.rbox(1.62, 0.07, 1.7, 0.03, 1.05, 2.0, 0);
    yellowB.box(1.32, 0.42, 0.04, 1.05, 1.17, 0.74).box(1.32, 0.42, 0.04, 1.05, 1.17, -0.74).box(0.04, 0.42, 1.44, 1.74, 1.17, 0).box(0.04, 0.42, 1.44, 0.36, 1.17, 0);
    clearB.add(new THREE.PlaneGeometry(1.42, 0.58), 1.741, 1.68, 0, [0, Math.PI / 2, 0]).add(new THREE.PlaneGeometry(1.42, 0.58), 0.359, 1.68, 0, [0, Math.PI / 2, 0]);
    darkB.box(0.26, 0.24, 1.3, 1.56, 1.26, 0);
    rubberB.rbox(0.5, 0.1, 0.5, 0.04, 0.82, 1.13, 0.3).rbox(0.1, 0.5, 0.5, 0.04, 0.6, 1.4, 0.3);
    fineDark.rod([1.44, 1.3, 0.3], [1.22, 1.5, 0.3], 0.018, 6).torus(0.17, 0.02, 1.2, 1.52, 0.3, [0, Math.PI / 2, -0.8], 14);
    darkB.cyl(0.07, 0.07, 0.04, 1.05, 2.055, 0, undefined, 10);
    amberGlow.cyl(0.06, 0.07, 0.11, 1.05, 2.13, 0, undefined, 12);
    for (const z of [-0.98, 0.98]) { fineDark.rod([1.74, 1.9, z * 0.76], [1.86, 1.84, z], 0.012, 5).box(0.03, 0.22, 0.14, 1.87, 1.8, z); }
    // Engine cover behind the cab: louvres, stack, air cleaner, filler caps.
    yellowB.rbox(1.9, 0.6, 1.4, 0.07, -1.05, 1.27, 0);
    for (const z of [-0.705, 0.705]) for (let k = 0; k < 5; k += 1) darkB.box(1.0, 0.035, 0.02, -1.05, 1.1 + k * 0.085, z);
    brightB.cyl(0.045, 0.045, 0.75, -1.72, 1.94, 0.44, undefined, 10);
    darkB.cyl(0.13, 0.13, 0.3, -0.5, 1.72, -0.4, undefined, 12).cyl(0.06, 0.06, 0.05, -1.4, 1.6, -0.3, undefined, 8);
    redB.cyl(0.07, 0.07, 0.36, -0.02, 1.16, 0.6, undefined, 10);
    for (const z of [-0.5, 0.5]) { brightB.cyl(0.09, 0.09, 0.05, 2.085, 0.78, z, [0, 0, Math.PI / 2], 12); coolGlow.cyl(0.07, 0.07, 0.02, 2.115, 0.78, z, [0, 0, Math.PI / 2], 12); }
    for (const z of [-0.6, 0.6]) redGlow.box(0.02, 0.07, 0.16, -2.165, 0.82, z);
    plateB.box(0.5, 0.03, 0.26, 0, 0.5, 1.2).box(0.5, 0.03, 0.26, 0, 0.5, -1.2);
    castBox(4.6, 0.95, 2.2, 0, 0.47, 0);
    castBox(1.62, 1.1, 1.7, 1.05, 1.5, 0);
    castBox(1.9, 0.6, 1.4, -1.05, 1.27, 0);
    within(-4.9, 0, 0.3, 0.12, () => {
      yellowB.rbox(4.6, 0.11, 0.11, 0.03, 0, 0.42, 0).box(0.5, 0.24, 0.34, -2.36, 0.42, 0);
      brightB.torus(0.09, 0.025, 2.38, 0.42, 0, [Math.PI / 2, 0, 0], 12);
      darkB.box(0.08, 0.3, 1.1, -0.8, 0.3, 0);
      for (const z of [-0.6, 0.6]) wheel(-0.8, 0.2, z, 0.2, 0.12, steelB, "z", 14);
      castBox(4.7, 0.2, 0.3, 0, 0.42, 0);
      castBox(0.3, 0.4, 1.3, -0.8, 0.2, 0);
    });
  });
  // Water-filled barriers closing the lane beside the open leaves, and a wheeled extinguisher at the door post.
  for (let k = 0; k < 4; k += 1) within(13.2 + k * 2.08, 0, -36.2 - k * 0.12, 0.05 * (k % 2 ? 1 : -1), () => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.3, 0); shape.lineTo(0.3, 0); shape.lineTo(0.3, 0.16); shape.lineTo(0.13, 0.42); shape.lineTo(0.1, 0.84); shape.lineTo(-0.1, 0.84); shape.lineTo(-0.13, 0.42); shape.lineTo(-0.3, 0.16); shape.closePath();
    const body = new THREE.ExtrudeGeometry(shape, { depth: 1.96, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
    body.translate(0, 0.02, -0.98); body.rotateY(Math.PI / 2);
    (k % 2 ? plasticB : redB).add(body);
    fineDark.cyl(0.05, 0.05, 0.03, 0.5, 0.875, 0, undefined, 10);
    castBox(2.0, 0.86, 0.62, 0, 0.43, 0);
  });
  within(11.6, 0, -33.6, -0.5, () => {
    redB.cyl(0.19, 0.19, 0.9, 0, 0.7, 0, undefined, 18).sphere(0.19, 0, 1.15, 0, undefined, 14);
    darkB.cyl(0.04, 0.05, 0.12, 0, 1.38, 0, undefined, 8).box(0.03, 0.9, 0.03, -0.2, 0.95, 0.22).box(0.03, 0.9, 0.03, -0.2, 0.95, -0.22).box(0.03, 0.03, 0.47, -0.2, 1.4, 0);
    rubberB.pipe([[0, 1.4, 0], [0.16, 1.3, 0.1], [0.24, 0.8, 0.12], [0.2, 0.36, 0.16]], 0.016, 14, 5);
    for (const z of [-0.26, 0.26]) wheel(-0.06, 0.16, z, 0.16, 0.06, steelB, "z", 12);
    darkB.box(0.3, 0.04, 0.42, 0.05, 0.23, 0);
    castCyl(0.2, 0, 1.4, 0, 0);
  });
  // Baggage carts on stand 08 and a belt loader by the visiting aircraft.
  for (let k = 0; k < 3; k += 1) within(22 + k * 3.5, 0, -90.5 - k * 0.5, Math.PI / 2 - 0.14, () => {
    whiteB.box(1.5, 0.12, 2.9, 0, 0.55, 0);
    blueB.box(1.56, 0.06, 3.0, 0, 2.05, 0);
    for (const sx of [-0.72, 0.72]) for (const sz of [-1.4, 1.4]) blueB.box(0.06, 1.44, 0.06, sx, 1.33, sz);
    for (const sx of [-0.6, 0.6]) for (const sz of [-1, 1]) wheel(sx, 0.24, sz, 0.24, 0.14, yellowB, "x", 8);
    // The load rides under a tarpaulin, strapped down.
    const load = 0.5 + ((k * 2) % 3) * 0.11;
    F(0x46583f).rbox(1.36, load, 2.5 - k * 0.3, 0.12, 0, 0.61 + load / 2, k * 0.12 - 0.1);
    for (const sz of [-0.7, 0.5]) F(0xc8641c).box(1.385, load + 0.012, 0.05, 0, 0.61 + load / 2, sz);
    darkB.rod([0, 0.45, 1.45], [0, 0.45, 2.1], 0.03, 6);
    castBox(1.56, 0.1, 3.0, 0, 2.05, 0);
    castBox(1.5, 0.9, 2.9, 0, 0.75, 0);
  });
  within(-30, 0, -88.5, 0.2, () => {
    yellowB.rbox(1.8, 0.8, 4.4, 0.08, 0, 0.75, 0);
    darkB.box(1.0, 0.16, 6.2, 0, 1.7, 0.4, [0.16, 0, 0]);
    rubberB.box(0.8, 0.04, 6.0, 0, 1.8, 0.4, [0.16, 0, 0]);
    for (const sx of [-0.8, 0.8]) for (const sz of [-1.5, 1.5]) wheel(sx, 0.36, sz, 0.36, 0.24, darkB, "x", 10);
    castBox(1.8, 1.15, 4.4, 0, 0.58, 0);
    cast([[-0.5, 2.25, -2.7], [0.5, 2.25, -2.7], [-0.5, 1.1, 3.5], [0.5, 1.1, 3.5], [-0.5, 1.3, 3.5], [0.5, 1.3, 3.5]]);
  });
  within(-18, 0, -99.5, Math.PI / 2 + 0.08, aircraftShade);
  // Blue taxiway edge lights and apron tie-downs on the remote stands.
  const blueGlow = glowB.tinted(0x2a6cff, 0, 3);
  for (let x = -184; x <= 184; x += 12) for (const z of [-64.2, -82.8]) { blueGlow.cyl(0.06, 0.07, 0.12, x, 0.26, z, undefined, 8); F(0xc79a1e).cyl(0.09, 0.11, 0.2, x, 0.1, z, undefined, 8); }
  for (const [x, z] of [[-28, -90], [-28, -109], [-40, -99.5], [-20, -99.5]]) fineSteel.torus(0.1, 0.016, x, 0.016, z, [Math.PI / 2, 0, 0], 12);

  // The two shadow maps: a fine one for the hangar apron, a coarse one for the rest of the field.
  const SHADE_FAR = { x0: -204.8, z0: -33, w: 409.6, d: 204.8, y: 0.05 }, SHADE_NEAR = { x0: -44, z0: -33, w: 80, d: 40, y: 0.014 };
  const inNear = (points: Array<[number, number]>) => {
    const x = points.reduce((sum, p) => sum + p[0], 0) / points.length, z = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    return x > SHADE_NEAR.x0 && x < SHADE_NEAR.x0 + SHADE_NEAR.w && z < SHADE_NEAR.z0 && z > SHADE_NEAR.z0 - SHADE_NEAR.d;
  };
  for (const region of [SHADE_FAR, SHADE_NEAR]) {
    const map = track(canvasTexture(2048, 1024, (context) => {
      context.clearRect(0, 0, 2048, 1024);
      const sx = 2048 / region.w, sz = 1024 / region.d;
      if (region === SHADE_NEAR && "filter" in context) context.filter = "blur(1.2px)";
      for (const { points, alpha } of shades) {
        if (points.length < 3 || inNear(points) !== (region === SHADE_NEAR)) continue;
        context.fillStyle = `rgba(0,0,0,${alpha})`;
        context.beginPath();
        points.forEach(([x, z], i) => { const px = (x - region.x0) * sx, py = (z - region.z0 + region.d) * sz; if (i) context.lineTo(px, py); else context.moveTo(px, py); });
        context.closePath(); context.fill();
      }
    }));
    map.anisotropy = anisotropy;
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(region.w, region.d)), new THREE.MeshBasicMaterial({ map, color: 0x000000, transparent: true, opacity: 0.64, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(region.x0 + region.w / 2, region.y, region.z0 - region.d / 2);
    mesh.renderOrder = -7;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
  }

  // Dust haze lying on the horizon: a band around the field that takes the far ground and the foot of the hills
  // into the same pale air, so the built airfield and the photographed desert meet without an edge.
  const hazeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
  {
    const positions: number[] = [], colours: number[] = [], index: number[] = [];
    const rows: Array<[number, number]> = [[-3, 0], [0.2, 0.52], [1.8, 0.56], [4.5, 0.36], [10, 0.14], [22, 0]], columns = 56, R = 384;
    for (let i = 0; i <= columns; i += 1) {
      const a = -Math.PI / 2 + (i / columns - 0.5) * Math.PI * 1.36, edge = THREE.MathUtils.smoothstep(Math.min(i, columns - i), 0, 6);
      rows.forEach(([y, alpha]) => { positions.push(Math.cos(a) * R, y, -12 + Math.sin(a) * R); colours.push(1, 1, 1, alpha * edge); });
      if (i < columns) for (let j = 0; j < rows.length - 1; j += 1) { const p = i * rows.length + j, q = p + rows.length; index.push(p, q, p + 1, p + 1, q, q + 1); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 4));
    geometry.setIndex(index);
    const band = new THREE.Mesh(track(geometry), hazeMaterial);
    band.renderOrder = -6;
    scene.add(band);
    kit.mirrorHidden.push(band);
  }

  // ---- Life and motion -----------------------------------------------------
  // Plants. Indoors only what a working hangar grows: a bay tree on a desk in the office windows and weeds where the
  // slab meets the walls. Outside, straw-dry grass at the foot of the front wall and the masts, and olives and scrub
  // past the wire.
  kit.mirrorHidden.push(...trees.place("potLaurel", deskPlants, { detail: "mid", shadow: false, hit: false }));
  const weeds: TreeItem[] = [];
  for (const z of [-28, -26.6, -18.7, -11.6, -6.6]) weeds.push({ at: [-9.47, 0, z + (chance() - 0.5) * 0.5], yaw: Math.PI / 2, scale: 0.7 + chance() * 0.45, variant: 2, dry: 0.3 + chance() * 0.4 });
  for (const z of [-28.4, -27, -18.2, -7.2, 1.6]) weeds.push({ at: [9.47, 0, z + (chance() - 0.5) * 0.5], yaw: -Math.PI / 2, scale: 0.7 + chance() * 0.45, variant: 2, dry: 0.3 + chance() * 0.4 });
  for (let x = -23; x < 9.5; x += 2.1 + chance() * 3.4) weeds.push({ at: [x, 0, TRACKS[0] - 0.24 + (chance() - 0.5) * 0.1], yaw: (chance() - 0.5) * 0.2, scale: 0.75 + chance() * 0.5, variant: 2, dry: 0.5 + chance() * 0.4 });
  kit.mirrorHidden.push(...trees.place("weeds", weeds, { shadow: false, hit: false }));
  const straw: TreeItem[] = [];
  const tufts = (x: number, z: number, spread: number, count: number) => {
    for (let k = 0; k < count; k += 1) straw.push({ at: [x + (chance() - 0.5) * spread, 0, z + (chance() - 0.5) * Math.min(spread, 1.2)], yaw: chance() * 6.28, scale: 0.8 + chance() * 0.7, variant: 1, dry: 0.75 + chance() * 0.25 });
  };
  tufts(14.4, -32.3, 8.4, 9); tufts(-29.2, -32.3, 8.6, 9); tufts(10.3, -32.1, 0.8, 3); tufts(-24.6, -32.1, 0.8, 3);
  tufts(SOCK.x, SOCK.z, 1.5, 4);
  for (const x of [-49, -5, 33]) tufts(x, -114.5, 2.4, 4);
  tufts(-2, -214.6, 60, 9);
  kit.mirrorHidden.push(...trees.place("grass", straw, { detail: "mid", shadow: false, hit: false }));
  const grove: TreeItem[] = [];
  for (let k = 0; k < 10; k += 1) grove.push({ at: [-168 + k * 33 + (chance() - 0.5) * 18, 0, -266 - chance() * 22], yaw: chance() * 6.28, scale: 0.95 + chance() * 0.5, variant: 0, dry: 0.25 });
  for (let k = 0; k < 8; k += 1) grove.push({ at: [-150 + k * 40 + (chance() - 0.5) * 26, 0, -262 - chance() * 8], yaw: chance() * 6.28, scale: 0.3 + chance() * 0.16, variant: 0, dry: 0.45 });
  kit.mirrorHidden.push(...trees.place("olive", grove, { detail: "far", shadow: false, hit: false }));

  // Pigeons on the lane edge of the partition cap, where they show from the lanes and have air on both sides. A shot
  // sends them out through the open door to wheel over the apron against the sky, and they come back in the same
  // way. A flushed flock ranges ten to twenty metres beyond its box in every direction, up and down included, which
  // no space under this roof can hold: the box is out on the apron for that reason, and nothing perches against a wall.
  life.birds("pigeon", {
    perches: [{ from: [-9.5, 4.7, -26.4], to: [-9.5, 4.7, -15.2] }, { from: [-9.5, 4.7, -12.6], to: [-9.5, 4.7, -3.4] }],
    count: 8, roam: { x: [-12, 0], y: [8, 11], z: [-54, -42] }, wary: 3,
  });
  // Swallows nest in the roof and hawk under it, over the partition between the hall and the near lanes: close
  // enough to the firing line to read as birds, and low enough to cross the bright doorway as seen from there. They
  // overshoot their circle by up to eight metres, which is what keeps this one clear of the east wall and the back.
  const swallows = new THREE.Vector3(-7.8, 8, -8.5);
  life.soaring("swift", { centre: [swallows.x, 0, swallows.z], radius: 8, height: 7.3, count: 6 });
  // Dry leaves come in off the apron and skitter up the lanes in the gusts.
  life.drift("leaves", { volume: { x: [-7, 7], y: [0, 2.2], z: [-25, 2] }, count: 110, scale: 1.4, colors: [0xb89a5e, 0xa88648, 0x8a6a3c, 0x9a7b45], falling: 0 });

  // Chain hoist on the truss over the left of the lanes. Its block hangs on eight and a half metres of chain, clear
  // of heads, and swings in the draught; a bullet sets it going.
  const HOIST = { x: -7.3, z: -12.5, top: TIE - 0.62 };
  yellowB.rbox(0.62, 0.4, 0.36, 0.05, HOIST.x, TIE - 0.42, HOIST.z);
  darkB.box(0.3, 0.14, 0.3, HOIST.x, TIE - 0.17, HOIST.z).cyl(0.13, 0.13, 0.2, HOIST.x + 0.4, TIE - 0.42, HOIST.z, [0, 0, Math.PI / 2], 14);
  const hoist = new THREE.Group();
  hoist.position.set(HOIST.x, HOIST.top, HOIST.z);
  scene.add(hoist);
  {
    const hoistB = batch(plainPaint, { flat: true, mirror: false, hit: true, into: hoist });
    const chain = hoistB.tinted(0x24272a), block = hoistB.tinted(0xb8861a), hook = hoistB.tinted(0x565c60);
    for (const x of [-0.04, 0.04]) chain.box(0.024, 8.5, 0.024, x, -4.25, 0);
    block.rbox(0.24, 0.42, 0.2, 0.04, 0, -8.68, 0);
    chain.cyl(0.1, 0.1, 0.22, 0, -8.62, 0, [Math.PI / 2, 0, 0], 14);
    hook.cyl(0.03, 0.03, 0.14, 0, -8.96, 0, undefined, 8).torus(0.085, 0.024, 0, -9.12, 0, undefined, 14);
  }
  life.sway(hoist, { amplitude: 0.03, period: 5.9, axis: "both", creak: "chainRattle", damping: 0.05 });

  // The house flag on the back wall, high over the chart: three bands of cloth hung from a batten, breathing in the
  // draught and cracking in a hard gust.
  {
    const width = 4.6, height = 3.1, bands: Array<[number, number, number]> = [[0, 0.34, 0xe08a2e], [0.34, 0.4, 0xe9e6dc], [0.4, 1, 0x24466b]];
    const parts = bands.map(([v0, v1, hex]) => {
      const geometry = new THREE.PlaneGeometry(width, (v1 - v0) * height, 24, Math.max(1, Math.round((v1 - v0) * 16)));
      geometry.translate(0, ((v0 + v1) / 2 - 0.5) * height, 0);
      const position = geometry.attributes.position, uv = geometry.attributes.uv, colour = new THREE.Color(hex), colours = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i += 1) {
        uv.setXY(i, position.getX(i) / width + 0.5, position.getY(i) / height + 0.5);
        colours[i * 3] = colour.r; colours[i * 3 + 1] = colour.g; colours[i * 3 + 2] = colour.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      return geometry;
    });
    const cloth = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    const flag = new THREE.Mesh(track(mergeGeometries(parts)), track(cloth));
    parts.forEach((part) => part.dispose());
    flag.position.set(0, 9.85, 9.46);
    flag.rotation.y = Math.PI;
    scene.add(flag);
    kit.mirrorHidden.push(flag);
    life.cloth(cloth, { amplitude: 0.05, pin: "top", lean: 0.12, flutter: 0.7 }).snap([0, 8.6, 9.46]);
    darkB.box(4.8, 0.06, 0.06, 0, 11.43, 9.46);
    for (const x of [-2.3, 2.3]) darkB.box(0.04, 0.04, 0.24, x, 11.43, 9.57);
  }

  // Heat shimmer: at a grazing angle the far apron shows pools of sky that crawl and break up. One sheet just over
  // the slab; the shader fades it in with distance and shallowness of view.
  const shimmerTint = new THREE.Color(1.5, 1.72, 2.05);
  const shimmerMaterial = new THREE.ShaderMaterial({
    uniforms: { shimmerTime: wind.uniforms.windTime, shimmerSky: { value: shimmerTint.clone() } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() { vec4 world = modelMatrix * vec4(position, 1.0); vWorld = world.xyz; gl_Position = projectionMatrix * viewMatrix * world; }`,
    fragmentShader: /* glsl */ `
      uniform float shimmerTime;
      uniform vec3 shimmerSky;
      varying vec3 vWorld;
      void main() {
        vec3 toEye = cameraPosition - vWorld;
        float graze = 1.0 - smoothstep(0.011, 0.034, abs(toEye.y) / length(toEye));
        float streak = sin(vWorld.x * 0.21 + sin(vWorld.z * 0.13 + shimmerTime * 0.5) * 2.0 + shimmerTime * 0.8)
          * sin(vWorld.z * 0.9 + sin(vWorld.x * 0.05 - shimmerTime * 0.37) * 3.0 - shimmerTime * 1.7);
        gl_FragColor = vec4(shimmerSky, graze * smoothstep(0.12, 0.7, streak) * 0.5);
      }`,
    transparent: true, depthWrite: false,
  });
  {
    const sheet = new THREE.Mesh(track(new THREE.PlaneGeometry(380, 150).rotateX(-Math.PI / 2)), track(shimmerMaterial));
    sheet.position.set(0, 0.075, -137);
    sheet.renderOrder = -4;
    scene.add(sheet);
    kit.mirrorHidden.push(sheet);
  }

  // The departure, the event of the place: every minute or so a turboprop rolls behind the east wall (heard first),
  // clears the door jamb low over the windsock, crosses the apron outside the doors and climbs out to the left of
  // the tower, between the flood-light masts. It is the parked airframe again, lit in its vertices for the one
  // heading it flies, with blurred propeller discs; it throws no shadow. Distances run along its track from the
  // point (x, z); it comes into view from the firing line at about -6.
  const FLIGHT = { x: 13, z: -64, hx: -0.6222, hz: -0.7828, speed: 53, from: -236, lift: -107.5, to: 430, climb: 0.17 };
  const departure = new THREE.Group();
  departure.visible = false;
  scene.add(departure);
  {
    const flightB = batch(farMaterial, { baked: "sun", mirror: false, into: departure });
    const discB = batch(new THREE.MeshBasicMaterial({ color: 0x1a1d21, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }), { mirror: false, into: departure });
    within(0, 0, 0, Math.atan2(FLIGHT.hx, FLIGHT.hz), () => within(0, 0, 11.5, 0, () => {
      farAircraft(0xd9822b, 0x1c3550, 0, (hex, shine, glow) => flightB.tinted(hex, shine, glow), true);
      for (const side of [-1, 1]) discB.add(new THREE.CircleGeometry(1.98, 28), side * 4.6, 4.58, -8.0);
    }));
  }
  // Its own lights ride in the lamp set: a red beacon under the belly and a white strobe at each wing tip.
  const flightLamps = ([[0, 2, 0, 0xff2a1c, 9, 2.4, 1.1, 0, 0.09], [11.5, 4.94, 0.5, 0xf4f8ff, 14, 2.2, 1.1, 0.5, 0.035], [-11.5, 4.94, 0.5, 0xf4f8ff, 14, 2.2, 1.1, 0.5, 0.035]] as number[][])
    .map(([x, y, z, hex, gain, size, period, phase, width]) => ({ index: lamp(0, -1000, 0, hex, gain, size, period, phase, width), local: new THREE.Vector3(x, y, z).applyAxisAngle(UP, Math.atan2(FLIGHT.hx, FLIGHT.hz)) }));

  // The lamp set itself.
  const eye = { x: 0, z: 0, fx: 0, fy: 0, fz: 0, seen: false }, home = { x: 0, z: 0, fx: 0, fy: 0, fz: 0, seen: false };
  const lampAt = new THREE.BufferAttribute(new Float32Array(lamps.flatMap((l) => l.slice(0, 3))), 3);
  lampAt.setUsage(THREE.DynamicDrawUsage);
  const lampMaterial = new THREE.ShaderMaterial({
    uniforms: { lampTime: wind.uniforms.windTime, lampScale: { value: 400 } },
    vertexShader: /* glsl */ `
      uniform float lampTime;
      uniform float lampScale;
      attribute vec3 tint;
      attribute vec4 pulse;
      attribute float size;
      varying vec3 vTint;
      void main() {
        vec4 seen = modelViewMatrix * vec4(position, 1.0);
        float far = length(seen.xyz);
        // Stand clear of the lamp's own glass, which would otherwise hide the flare.
        seen.xyz -= normalize(seen.xyz) * min(far * 0.5, size * 0.5 + 0.4);
        gl_Position = projectionMatrix * seen;
        float t = fract(lampTime / pulse.x + pulse.y) - 0.5;
        vTint = tint * (pulse.w + (1.0 - pulse.w) * exp(-(t * t) / (pulse.z * pulse.z))) * exp(-far * far * 0.0000025);
        gl_PointSize = max(size * lampScale / far, 4.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vTint;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        gl_FragColor = vec4(vTint * (smoothstep(0.3, 0.0, r) + 0.3 * pow(max(0.0, 1.0 - r), 2.0)), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", lampAt);
    geometry.setAttribute("tint", new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.slice(3, 6)), 3));
    geometry.setAttribute("pulse", new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.slice(6, 10)), 4));
    geometry.setAttribute("size", new THREE.Float32BufferAttribute(lamps.map((l) => l[10]), 1));
    const points = new THREE.Points(track(geometry), track(lampMaterial));
    points.frustumCulled = false;
    // Whatever camera draws the lamps says where the player stands and looks.
    points.onBeforeRender = (_renderer, _scene, camera) => { const e = camera.matrixWorld.elements; eye.x = e[12]; eye.z = e[14]; eye.fx = -e[8]; eye.fy = -e[9]; eye.fz = -e[10]; eye.seen = true; };
    scene.add(points);
    kit.mirrorHidden.push(points);
  }

  // What moves by hand, and what is heard where it happens.
  const heading = new THREE.Vector3(FLIGHT.hx, 0, FLIGHT.hz), pitchAxis = heading.clone().cross(UP).normalize(), roll = new THREE.Quaternion();
  const cueAt = new THREE.Vector3(), doorway = new THREE.Vector3(-2, 5, HALL.zDoor), nextBay = new THREE.Vector3(PLANE.x + 4.6, 4.2, PLANE.z - 9.4);
  const clock = { last: 0, since: -1, still: 0, flightAt: -1, flightFrom: 0, flying: false, echoed: false, spin: 0.5, gustWas: 0, gustAt: 0, wrenchAt: 0, wrenchLeft: 0, creakAt: 0, screamAt: 0 };
  kit.updates.push((now) => {
    const t = now / 1000, dt = Math.min(0.1, Math.max(0, t - clock.last));
    clock.last = t;
    if (clock.since < 0) { clock.since = t; clock.wrenchAt = t + 9; clock.creakAt = t + 15; clock.gustAt = t + 3; clock.screamAt = t + 6; }
    if (clock.flightAt < 0) {
      // The first departure waits for the player. The camera rests where the briefing leaves it (half a second of
      // stillness marks that pose); four seconds after it first moves from there the engines are heard. If it never
      // moves, half a minute is enough.
      const shift = Math.abs(eye.x - home.x) + Math.abs(eye.z - home.z) + Math.abs(eye.fx - home.fx) + Math.abs(eye.fy - home.fy) + Math.abs(eye.fz - home.fz);
      if (!home.seen) {
        if (eye.seen && shift < 0.004) { clock.still += 1; home.seen = clock.still > 30; }
        else { clock.still = 0; home.x = eye.x; home.z = eye.z; home.fx = eye.fx; home.fy = eye.fy; home.fz = eye.fz; }
      }
      if ((home.seen && shift > 0.004) || t - clock.since > 30) clock.flightAt = t + 4;
    }
    lampMaterial.uniforms.lampScale.value = options.renderer.domElement.height / 1.4;

    // The free propeller follows the wind with the inertia of a few hundred kilos of blades.
    clock.spin += (0.2 + 1.9 * wind.at(propMount.position.x, propMount.position.z) - clock.spin) * Math.min(1, dt * 0.5);
    propSpin.rotation.z += clock.spin * dt;
    if (t > clock.creakAt) { clock.creakAt = t + 16 + chance() * 18; options.cue?.("metalCreak", propMount.position, { gain: 0.45, pitch: 0.85 + chance() * 0.3 }); }
    // The swallows are heard under the roof as they pass.
    if (t > clock.screamAt) { clock.screamAt = t + 13 + chance() * 17; options.cue?.("swiftScream", swallows, { gain: 0.5 + chance() * 0.2, pitch: 0.92 + chance() * 0.2 }); }
    // The sock veers a little about the wind's line.
    sock.rotation.y = SOCK.yaw + 0.16 * Math.sin(t * 0.31) + 0.07 * Math.sin(t * 0.83);
    streamSock(t);

    // A gust front reaching the doorway is heard there.
    const gust = wind.at(doorway.x, doorway.z);
    if (gust > 0.5 && clock.gustWas <= 0.5 && t > clock.gustAt) { clock.gustAt = t + 12 + chance() * 8; options.cue?.("windGust", doorway, { gain: 0.5 + gust * 0.4, pitch: 0.9 + chance() * 0.2 }); }
    clock.gustWas = gust;
    // Someone in the next bay is on the engine with an air wrench: two to four pulls, then a long pause.
    if (t > clock.wrenchAt) {
      if (clock.wrenchLeft <= 0) clock.wrenchLeft = 2 + Math.floor(chance() * 3);
      clock.wrenchLeft -= 1;
      clock.wrenchAt = t + (clock.wrenchLeft > 0 ? 0.7 + chance() * 0.5 : 12 + chance() * 16);
      options.cue?.("airWrench", nextBay, { gain: 0.7 + chance() * 0.25, pitch: 0.92 + chance() * 0.16 });
    }

    // The departure: the engines are heard four seconds before the aircraft clears the east jamb.
    if (!clock.flying && clock.flightAt > 0 && t > clock.flightAt) {
      clock.flying = true; clock.echoed = false; clock.flightFrom = t;
      clock.flightAt = t + 55 + chance() * 28;
      departure.visible = true;
      options.cue?.("propPass", cueAt.set(FLIGHT.x, 20, FLIGHT.z), { gain: 2.6, pitch: 0.94 + chance() * 0.12 });
    }
    if (clock.flying) {
      const e = t - clock.flightFrom, s = FLIGHT.from + e * FLIGHT.speed, climb = Math.max(0, s - FLIGHT.lift), ease = 1 - Math.exp(-climb / 30);
      departure.position.set(FLIGHT.x + s * FLIGHT.hx, FLIGHT.climb * (climb - 30 * ease), FLIGHT.z + s * FLIGHT.hz);
      departure.quaternion.setFromAxisAngle(pitchAxis, Math.atan(FLIGHT.climb * ease) * 1.2 + 0.035 * ease).multiply(roll.setFromAxisAngle(heading, 0.035 * Math.sin(e * 0.9)));
      for (const { index, local } of flightLamps) { cueAt.copy(local).applyQuaternion(departure.quaternion).add(departure.position); lampAt.setXYZ(index, cueAt.x, cueAt.y, cueAt.z); }
      if (!clock.echoed && e > 6.6) {
        // The climb-out, further off and lower in pitch.
        clock.echoed = true;
        options.cue?.("propPass", cueAt.set(FLIGHT.x + (s + 190) * FLIGHT.hx, 60, FLIGHT.z + (s + 190) * FLIGHT.hz), { gain: 1.4, pitch: 0.86 + chance() * 0.06 });
      }
      if (s > FLIGHT.to) {
        clock.flying = false;
        departure.visible = false;
        for (const { index } of flightLamps) lampAt.setXYZ(index, 0, -1000, 0);
      }
      lampAt.needsUpdate = true;
    }
  });

  // Spares on shelves and benches sit out of the sun and away from the bay floor: those kinds neither cast nor mirror.
  const shelved: PropKind[] = ["carton", "cartonSmall", "cartonLarge", "cartonFlat", "cartonTall", "crateSmall", "cratePlastic", "tin"];
  stock.forEach((items, kind) => {
    const light = shelved.includes(kind), meshes = props.place(kind, items, light ? { shadow: false } : {});
    if (light) kit.mirrorHidden.push(...meshes);
  });
  pending.forEach((build) => build());

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, roofY(9.3) - 3.5);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xcfd6da, 0x8a7f6c, 0.55));
  const sun = kit.sunLight({ color: SUN_COLOUR, intensity: SUN_INTENSITY, toSun: TO_SUN, extent: 38, distance: 64, near: 6, far: 130, radius: 2.2 });
  // Re-centre the shadow frame on the hall so the whole roof casts.
  daylight.sun = sun;
  const shift = new THREE.Vector3(XC, 0, -1);
  sun.position.add(shift);
  sun.target.position.add(shift);
  // Fit the shadow frame to the hall, squared to the door line: the air beyond the doors then falls outside it and
  // stays clear instead of washing the view white when looking out toward the sun.
  const shadowCamera = sun.shadow.camera;
  shadowCamera.up.crossVectors(new THREE.Vector3(1, 0, 0), TO_SUN.clone().negate()).normalize();
  shadowCamera.left = -31; shadowCamera.right = 31; shadowCamera.top = 13.6; shadowCamera.bottom = -31;
  shadowCamera.updateProjectionMatrix();
  // The airfield is lit in its vertices, so it follows the sun by hand when a wave turns the light; the haze takes the fog's colour.
  const calm = new THREE.Color(SUN_COLOUR).multiplyScalar(SUN_INTENSITY), fenceTint = fenceMaterial.color.clone();
  kit.updates.push(() => {
    const r = (sun.color.r * sun.intensity) / calm.r, g = (sun.color.g * sun.intensity) / calm.g, b = (sun.color.b * sun.intensity) / calm.b;
    farMaterial.color.setRGB(r, g, b);
    farSheetMaterial.color.setRGB(r, g, b);
    sockMaterial.color.setRGB(r, g, b);
    shimmerMaterial.uniforms.shimmerSky.value.setRGB(shimmerTint.r * r, shimmerTint.g * g, shimmerTint.b * b);
    fenceMaterial.color.setRGB(fenceTint.r * r, fenceTint.g * g, fenceTint.b * b);
    if (scene.fog) hazeMaterial.color.copy(scene.fog.color);
  });
  // Three hall fills plus the workshop lamp: four point lights in all.
  const fills = [3, -9, -21].map((z, index) => {
    const lampFill = new THREE.PointLight(0xf2ecdf, 70, 24, 2);
    lampFill.position.set(index === 1 ? -3.4 : 3.4, 7.6, z);
    scene.add(lampFill);
    return lampFill;
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 620, x: 19, y: [0.2, 9], z: [-29, 8], color: 0xfff0d2, opacity: 0.22 });

  const blocked = sunlitFromBoxes(TO_SUN, [
    new THREE.Box3(new THREE.Vector3(-9.94, 0, -29.4), new THREE.Vector3(-9.54, 4.6, 0)),
    new THREE.Box3(new THREE.Vector3(-9.94, 3.3, 0), new THREE.Vector3(-9.54, 4.6, 10)),
    new THREE.Box3(new THREE.Vector3(9.54, 0, -30.6), new THREE.Vector3(19, 8.2, 10)),
  ]);
  const hit = new THREE.Vector3();

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 2.2, skyRotation: SKY_TURN, skyClamp: 5,
      background: 0x86a9d6, fog: 0xcdbfa6, fogDensity: high ? 0.0026 : 0.004,
      haze: new THREE.Color(0.03, 0.034, 0.036), hazeDensity: 0.0048, hazeCeiling: 12.6, hazeFade: 2,
      environmentIntensity: 1, exposure: 1.02, far: 460,
    },
    sunlitAt(point) {
      if (point.z < HALL.zDoor) return 1;
      if (!blocked(point)) return 0;
      // Through the doorway?
      const toDoor = (point.z - HALL.zDoor) / -TO_SUN.z;
      hit.copy(point).addScaledVector(TO_SUN, toDoor);
      if (hit.y < DOOR_TOP) return hit.x > DOOR_CLEAR.x0 && hit.x < DOOR_CLEAR.x1 ? 1 : 0;
      // Otherwise the ray meets the roof: lit only under a glazed strip.
      let t = (16.5 - point.y) / TO_SUN.y;
      for (let i = 0; i < 3; i += 1) t = (roofY(point.x + TO_SUN.x * t) - point.y) / TO_SUN.y;
      hit.copy(point).addScaledVector(TO_SUN, t);
      if (Math.abs(hit.x - XC) > ROOFLIGHT_REACH) return 0;
      let lit = 0;
      for (const z of ROOFLIGHTS) lit = Math.max(lit, 1 - THREE.MathUtils.smoothstep(Math.abs(hit.z - z), ROOFLIGHT_HALF - 0.3, ROOFLIGHT_HALF));
      return lit;
    },
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  // A shot flushes the birds; a bullet in a bird or the hoist is the life kit's to answer.
  return { ...range, startle: life.startle, struck: (object, point) => life.struck(object, point) };
}

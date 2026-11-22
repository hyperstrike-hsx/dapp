import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { canvasTexture, createKit, projectUv, type RangeEnvironment, type RangeOptions } from "../kit";
import { createTrees, type TreeItem } from "../trees";
import { createLife } from "../life";
import { createProps } from "../props";
import { applyWind, createWind } from "../wind";

// Canopy: the paved court of a stone ruin that the forest has taken back.
//
// The court lies sunk between stepped terraces of big dressed blocks. Trees stand on every step and
// close over it; the sun is high and ahead of the firing line, a little to the east, and reaches the
// ground only where the leaves leave a hole. Each hole is planned (SHAFTS): the canopy, the forest
// trees and the big crown over the gateway are all cut clear of the same slanting cylinders, so the
// shadow map hands the haze real shafts and the floor real patches. Beyond the far end a broad stair
// climbs to a gateway with a tall corbelled doorway, half taken by a buttressed tree.
//
// Plan (metres; +x east, -z down-range):
//   court floor   y 0     |x| < 9.54, z -29 .. 9.7
//   terrace A     y 4.5   to |x| 13.5 (the court's retaining walls carry the four signs)
//   terrace B     y 7.3   to |x| 17.5, and behind the back wall
//   terrace C     y 10    beyond
//   gateway deck  y 6     z < -35, reached by the stair from the court's far end

type V3 = [number, number, number];
type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean; walk?: boolean };

const TO_SUN = new THREE.Vector3(0.35, 1, -0.7).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const WALL = 9.54, BACK = 9.7, FAR = -29;
const TOP_A = 4.5, EDGE_B = 13.5, TOP_B = 7.3, EDGE_C = 17.5, TOP_C = 10, EDGE_D = 23.5;
const DECK = 6, STAIR_END = -35, GATE = -37.5, GATE_BACK = -40.5;
/** Course lines of the court's walls: a plinth, four courses, the carved band and the coping. */
const ROWS = [0, 0.45, 1.27, 2.09, 2.91, 3.73], BAND = 4.18;

/** Where the sun comes down through the leaves: the middle of each patch on what it lights, and its radius. */
const SHAFTS: Array<{ at: V3; radius: number }> = [
  { at: [-1.5, 0, -12.5], radius: 2.3 },
  { at: [5.2, 0, -22.5], radius: 1.7 },
  { at: [-5.5, 0, 0.5], radius: 1.5 },
  { at: [-8.9, 1.2, -3.4], radius: 1.4 },
  { at: [7.4, 0, 6.6], radius: 1.2 },
  { at: [-7.4, 0, -21.6], radius: 1.5 },
  { at: [-12, TOP_A, -9], radius: 1.6 },
  { at: [12.4, TOP_A, -17], radius: 1.5 },
  { at: [-11.6, TOP_A, 3.2], radius: 1.3 },
  { at: [2.6, 0, -3.2], radius: 0.9 },
];
/** Distance from a point to the axis of a shaft. */
const offAxis = (x: number, y: number, z: number, shaft: { at: V3 }) => {
  const dx = x - shaft.at[0], dy = y - shaft.at[1], dz = z - shaft.at[2], t = dx * TO_SUN.x + dy * TO_SUN.y + dz * TO_SUN.z;
  return Math.hypot(dx - TO_SUN.x * t, dy - TO_SUN.y * t, dz - TO_SUN.z * t);
};
/** How far a point stands clear of every shaft (negative inside one). */
const clearOfShafts = (x: number, y: number, z: number) => SHAFTS.reduce((least, shaft) => Math.min(least, offAxis(x, y, z, shaft) - shaft.radius), Infinity);
/** The open sky behind the gateway, which lets the sun over its shoulders and through its door. */
const inClearing = (x: number, z: number) => ((x - 3) / 15) ** 2 + ((z + 55) / 12.5) ** 2 < 1;

function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

function xf(at: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 | number = 1) {
  const s: V3 = typeof scale === "number" ? [scale, scale, scale] : scale;
  return new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...s));
}

/** Strips a geometry to unindexed position, normal and uv, so any two pieces merge. */
function plain(geometry: THREE.BufferGeometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") flat.deleteAttribute(name);
  if (!flat.attributes.normal) flat.computeVertexNormals();
  if (!flat.attributes.uv) flat.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(flat.attributes.position.count * 2), 2));
  flat.clearGroups();
  return flat;
}

/** A block with eased edges: flat faces joined by strips that shade as worn arrises. Unindexed, 44 triangles. */
function chamferBox(w: number, h: number, d: number, chamfer: number) {
  const half = [w / 2, h / 2, d / 2], r = Math.max(0.002, Math.min(chamfer, half[0] * 0.4, half[1] * 0.4, half[2] * 0.4));
  const position: number[] = [], normal: number[] = [];
  type P = { p: V3; n: V3 };
  // The vertex of corner `s` that lies on the face across `axis`.
  const corner = (s: V3, axis: number): P => ({
    p: [0, 1, 2].map((k) => s[k] * (k === axis ? half[k] : half[k] - r)) as V3,
    n: [0, 1, 2].map((k) => (k === axis ? s[k] : 0)) as V3,
  });
  const tri = (p0: P, p1: P, p2: P) => {
    const ux = p1.p[0] - p0.p[0], uy = p1.p[1] - p0.p[1], uz = p1.p[2] - p0.p[2], vx = p2.p[0] - p0.p[0], vy = p2.p[1] - p0.p[1], vz = p2.p[2] - p0.p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const facing = nx * (p0.p[0] + p1.p[0] + p2.p[0]) + ny * (p0.p[1] + p1.p[1] + p2.p[1]) + nz * (p0.p[2] + p1.p[2] + p2.p[2]);
    for (const q of facing >= 0 ? [p0, p1, p2] : [p0, p2, p1]) { position.push(q.p[0], q.p[1], q.p[2]); normal.push(q.n[0], q.n[1], q.n[2]); }
  };
  const quad = (p0: P, p1: P, p2: P, p3: P) => { tri(p0, p1, p2); tri(p0, p2, p3); };
  const signs = [-1, 1];
  for (let axis = 0; axis < 3; axis += 1) {
    const j = (axis + 1) % 3, k = (axis + 2) % 3;
    for (const s of signs) {
      const at = (sj: number, sk: number) => { const v: V3 = [0, 0, 0]; v[axis] = s; v[j] = sj; v[k] = sk; return v; };
      quad(corner(at(-1, -1), axis), corner(at(1, -1), axis), corner(at(1, 1), axis), corner(at(-1, 1), axis));
      // The strip between this face and the next axis's, running along the third.
      for (const sj of signs) quad(corner(at(sj, -1), axis), corner(at(sj, 1), axis), corner(at(sj, 1), j), corner(at(sj, -1), j));
    }
  }
  for (const sx of signs) for (const sy of signs) for (const sz of signs) { const s: V3 = [sx, sy, sz]; tri(corner(s, 0), corner(s, 1), corner(s, 2)); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(position.length / 3 * 2), 2));
  return geometry;
}

/** A tapering round limb through points: a trunk, a root, a liana. `swell` shapes the section (flutes, a flared foot). */
function limb(points: V3[], radii: number[], sides = 7, steps = points.length * 4, metres = 2.2, swell?: (t: number, angle: number) => number) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "centripetal");
  const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  const at = new THREE.Vector3(), tangent = new THREE.Vector3(), side = new THREE.Vector3(0, 0, 1), other = new THREE.Vector3(), last = new THREE.Vector3();
  const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length, turns = Math.max(1, Math.round(Math.PI * 2 * mean / metres));
  let along = 0;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps, f = t * (radii.length - 1), k0 = Math.min(radii.length - 2, Math.floor(f)), radius = radii[k0] + (radii[k0 + 1] - radii[k0]) * (f - k0);
    curve.getPoint(t, at); curve.getTangent(t, tangent);
    if (i === 0 && Math.abs(tangent.z) > 0.9) side.set(1, 0, 0);
    side.addScaledVector(tangent, -side.dot(tangent)).normalize();
    other.crossVectors(tangent, side);
    if (i > 0) along += at.distanceTo(last);
    last.copy(at);
    for (let k = 0; k <= sides; k += 1) {
      const angle = (k % sides) / sides * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle), r = radius * (swell ? swell(t, angle) : 1);
      const ox = side.x * c + other.x * s, oy = side.y * c + other.y * s, oz = side.z * c + other.z * s;
      position.push(at.x + ox * r, at.y + oy * r, at.z + oz * r); normal.push(ox, oy, oz); uv.push(k / sides * turns, along / metres);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < steps; i += 1) for (let k = 0; k < sides; k += 1) { const a = i * ring + k; index.push(a, a + 1, a + ring + 1, a, a + ring + 1, a + ring); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

/** A buttress root in its own frame: a thin fin running out along +x from the trunk's axis, highest against the trunk. */
function buttress(reach: number, height: number, thick: number, steps = 8) {
  const position: number[] = [], uv: number[] = [], index: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps, x = reach * t, top = height * Math.pow(1 - t, 1.9) + 0.16 * (1 - t) + 0.05, half = thick * (1 - 0.55 * t) / 2;
    const ring: Array<[number, number]> = [[-half * 1.7, -0.5], [-half, top * 0.5], [0, top], [half, top * 0.5], [half * 1.7, -0.5]];
    ring.forEach(([z, y], k) => { position.push(x, y, z + Math.sin(t * 4.2) * thick * 0.5); uv.push(x / 1.7, k * 0.3 + y / 2.2); });
  }
  for (let i = 0; i < steps; i += 1) for (let k = 0; k < 4; k += 1) { const a = i * 5 + k; index.push(a, a + 5, a + 6, a, a + 6, a + 1); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** Atlas cells of the leaf sheet as [u0, v0, u1, v1]: two sprays for the canopy, one great leaf, one hanging creeper. */
const CELL: Array<[number, number, number, number]> = [[0.004, 0.004, 0.496, 0.496], [0.504, 0.004, 0.996, 0.496], [0.004, 0.504, 0.496, 0.996], [0.504, 0.504, 0.996, 0.996]];

/**
 * The leaf sheet: sprays of broad leaves, drawn once. It carries its own mip chain, each level cut so that
 * the same share of it passes the alpha test, so the canopy neither thins nor clots with distance.
 */
function leafAtlas(size: number, seed: number, anisotropy: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d", { willReadFrequently: true })!, cell = size / 2, random = rng(seed);
  const leaf = (x: number, y: number, angle: number, length: number, width: number, shade: number) => {
    c.save(); c.translate(x, y); c.rotate(angle);
    const base = [30 + shade * 34, 70 + shade * 56, 20 + shade * 20], tone = (k: number) => `rgb(${base.map((v) => Math.round(Math.min(255, v * k))).join(",")})`;
    const fill = c.createLinearGradient(0, 0, length, 0);
    fill.addColorStop(0, tone(0.7)); fill.addColorStop(0.55, tone(1)); fill.addColorStop(1, tone(1.14));
    c.fillStyle = fill;
    c.beginPath(); c.moveTo(0, 0);
    c.bezierCurveTo(length * 0.22, -width * 0.74, length * 0.72, -width * 0.6, length, 0);
    c.bezierCurveTo(length * 0.72, width * 0.6, length * 0.22, width * 0.74, 0, 0);
    c.fill();
    c.strokeStyle = "rgba(168,200,104,.6)"; c.lineWidth = Math.max(1, length * 0.024);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(length * 0.95, 0); c.stroke();
    c.strokeStyle = "rgba(16,44,12,.42)"; c.lineWidth = Math.max(0.7, length * 0.011);
    for (let k = 1; k <= 5; k += 1) for (const s of [-1, 1]) {
      const from = length * (0.1 + k * 0.14);
      c.beginPath(); c.moveTo(from, 0); c.lineTo(from + length * 0.13, s * width * 0.45 * (1 - Math.abs(k - 2.4) / 5.2)); c.stroke();
    }
    c.restore();
  };
  const spray = (ox: number, oy: number, twigs: number, each: number, long: number, wide: number) => {
    const cx = ox + cell / 2, cy = oy + cell / 2, reach = cell * 0.46;
    for (let t = 0; t < twigs; t += 1) {
      const heading = t / twigs * Math.PI * 2 + random() * 0.5, bend = (random() - 0.5) * 0.9, span = reach * (0.72 + random() * 0.28);
      c.strokeStyle = "rgb(52,44,26)"; c.lineWidth = Math.max(1.5, cell * 0.008); c.lineCap = "round";
      c.beginPath(); c.moveTo(cx, cy);
      const stations: Array<[number, number, number]> = [];
      for (let k = 1; k <= each; k += 1) {
        const f = k / each, a = heading + bend * f * f, x = cx + Math.cos(a) * span * f * 0.82, y = cy + Math.sin(a) * span * f * 0.82;
        c.lineTo(x, y); stations.push([x, y, a]);
      }
      c.stroke();
      stations.forEach(([x, y, a], k) => {
        const size = long * (0.75 + random() * 0.5) * (k === each - 1 ? 1.1 : 1), turn = k === each - 1 ? (random() - 0.5) * 0.4 : (k % 2 ? 1 : -1) * (0.75 + random() * 0.5);
        // A leaf may not run out of its cell: it would show as a cut edge on the card.
        const tip = [x + Math.cos(a + turn) * size, y + Math.sin(a + turn) * size];
        const fit = Math.min(1, ...[tip[0] - ox, ox + cell - tip[0], tip[1] - oy, oy + cell - tip[1]].map((room) => (room < cell * 0.03 ? 0.6 : 1)));
        leaf(x, y, a + turn, size * fit, size * wide * fit, random());
      });
    }
  };
  spray(0, 0, 9, 7, cell * 0.2, 0.46);
  spray(cell, 0, 13, 9, cell * 0.135, 0.5);
  // One great leaf, base at the bottom of its cell.
  leaf(cell * 0.5, size - cell * 0.02, -Math.PI / 2, cell * 0.95, cell * 0.44, 0.55);
  // A creeper hanging from the top of its cell: three stems and small leaves.
  for (let stem = 0; stem < 3; stem += 1) {
    const x0 = cell * (1.3 + stem * 0.2), sway = cell * (0.05 + random() * 0.05), phase = random() * 6, long = cell * (0.98 - stem * 0.14 - random() * 0.1);
    const along = (t: number): [number, number] => [x0 + Math.sin(t * 5.2 + phase) * sway, cell + cell * 0.012 + t * long];
    c.strokeStyle = "rgb(58,50,30)"; c.lineWidth = Math.max(1.5, cell * 0.009);
    c.beginPath(); c.moveTo(...along(0));
    for (let k = 1; k <= 24; k += 1) c.lineTo(...along(k / 24));
    c.stroke();
    for (let k = 0; k < 15; k += 1) {
      const t = (k + 0.4 + random() * 0.4) / 15, [x, y] = along(t), sideways = (k % 2 ? 1 : -1) * (0.9 + random() * 0.5);
      leaf(x, y, Math.PI / 2 + sideways, cell * (0.085 + random() * 0.035), cell * 0.085, random());
    }
  }
  const data = new Uint8Array(c.getImageData(0, 0, size, size).data.buffer.slice(0));
  // Texels no leaf covers take a leaf's colour, so nothing dark bleeds in at the edges.
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] < 40) { data[i] = 44; data[i + 1] = 82; data[i + 2] = 28; }
  const regionCover = (pixels: Uint8Array, width: number, q: number, cut: number) => {
    const span = width / 2, x0 = (q % 2) * span, y0 = (q >> 1) * span;
    let covered = 0;
    for (let y = y0; y < y0 + span; y += 1) for (let x = x0; x < x0 + span; x += 1) if (pixels[(y * width + x) * 4 + 3] >= cut) covered += 1;
    return covered / (span * span);
  };
  const want = [0, 1, 2, 3].map((q) => regionCover(data, size, q, 128));
  const levels: Array<{ data: Uint8Array; width: number; height: number }> = [{ data, width: size, height: size }];
  let from = data, width = size;
  while (width > 1) {
    const half = width >> 1, to = new Uint8Array(half * half * 4), row = width * 4;
    for (let y = 0; y < half; y += 1) for (let x = 0; x < half; x += 1) {
      const p = y * 2 * row + x * 8, out = (y * half + x) * 4;
      for (let k = 0; k < 4; k += 1) to[out + k] = (from[p + k] + from[p + 4 + k] + from[p + row + k] + from[p + row + 4 + k] + 2) >> 2;
    }
    if (half >= 8) for (let q = 0; q < 4; q += 1) {
      // The alpha that leaves the wanted share above it becomes the cut-off.
      let cut = 255;
      while (cut > 24 && regionCover(to, half, q, cut) < want[q]) cut -= 6;
      const gain = Math.min(3.5, 128 / cut), span = half / 2, x0 = (q % 2) * span, y0 = (q >> 1) * span;
      if (gain > 1.02) for (let y = y0; y < y0 + span; y += 1) for (let x = x0; x < x0 + span; x += 1) { const at = (y * half + x) * 4 + 3; to[at] = Math.min(255, to[at] * gain); }
    }
    levels.push({ data: to, width: half, height: half });
    from = to; width = half;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.mipmaps = levels as unknown as THREE.DataTexture["mipmaps"];
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Bark: long fibrous ridges, tileable round a limb. */
function barkTexture() {
  return canvasTexture(512, 512, (c) => {
    const random = rng(31);
    c.fillStyle = "#6d6253"; c.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 900; i += 1) {
      const x = random() * 512, y = random() * 512, long = 30 + random() * 190, shade = random(), width = 1 + random() * 3.5;
      c.strokeStyle = shade < 0.55 ? `rgba(${28 + shade * 40},${24 + shade * 34},${18 + shade * 26},${0.3 + random() * 0.4})` : `rgba(${150 + shade * 40},${140 + shade * 36},${116 + shade * 30},${0.12 + random() * 0.2})`;
      c.lineWidth = width;
      const bends = [(random() - 0.5) * 9, (random() - 0.5) * 9, (random() - 0.5) * 12];
      for (const wrap of [0, -512, 512]) for (const fold of [0, -512]) {
        c.beginPath(); c.moveTo(x + wrap, y + fold);
        c.bezierCurveTo(x + wrap + bends[0], y + fold + long * 0.3, x + wrap + bends[1], y + fold + long * 0.7, x + wrap + bends[2], y + fold + long);
        c.stroke();
      }
    }
  }, true);
}

/** The forest beyond the terraces: trunks and stacked foliage, cut ragged along the top, repeating along the wall. */
function forestTexture() {
  return canvasTexture(2048, 512, (c) => {
    const random = rng(58);
    c.clearRect(0, 0, 2048, 512);
    for (let layer = 0; layer < 4; layer += 1) {
      const depth = layer / 3, top = 40 + layer * 62, light = 1 - depth * 0.55;
      for (let i = 0; i < 46; i += 1) {
        const x = random() * 2048, crown = 46 + random() * 70, y = top + random() * 70, lean = (random() - 0.5) * 30;
        c.strokeStyle = `rgb(${Math.round(42 * light)},${Math.round(48 * light)},${Math.round(34 * light)})`;
        c.lineWidth = 5 + random() * 9;
        for (const wrap of [0, -2048, 2048]) { c.beginPath(); c.moveTo(x + wrap, y); c.lineTo(x + wrap + lean, 512); c.stroke(); }
        for (let k = 0; k < 16; k += 1) {
          const bx = x + (random() - 0.5) * crown * 2.2, by = y + (random() - 0.5) * crown * 1.1, r = crown * (0.3 + random() * 0.35), tone = light * (0.72 + random() * 0.5);
          c.fillStyle = `rgb(${Math.round(52 * tone)},${Math.round(92 * tone)},${Math.round(40 * tone)})`;
          for (const wrap of [0, -2048, 2048]) { c.beginPath(); c.ellipse(bx + wrap, by, r, r * 0.72, 0, 0, Math.PI * 2); c.fill(); }
        }
      }
      c.fillStyle = `rgba(${Math.round(30 * light)},${Math.round(52 * light)},${Math.round(26 * light)},.9)`;
      c.fillRect(0, top + 150, 2048, 512);
    }
  }, true);
}

export function buildRuin(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, track, photoSet } = kit;
  const metals = kit.metals();
  const random = rng(4711);
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.5, ...parameters });

  // ---- Batching: one mesh per material and class ------------------------------
  const batches = new Map<string, { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] }>();
  /** Takes a piece that already stands where it belongs. "fine" pieces are left out on PERFORMANCE and of the floor mirror. */
  const add = (material: THREE.Material, geometry: THREE.BufferGeometry, opt: Opt = {}) => {
    const full = { shadow: opt.shadow ?? true, hit: opt.hit ?? false, fine: opt.fine ?? false, walk: opt.walk ?? false };
    if (full.fine && !high) { geometry.dispose(); return; }
    const key = `${material.uuid}|${+full.shadow}${+full.hit}${+full.fine}${+full.walk}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { material, opt: full, parts: [] });
    batch.parts.push(plain(geometry));
  };
  /** Places a copy of a shared geometry. */
  const put = (material: THREE.Material, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, opt: Opt = {}) => add(material, geometry.clone().applyMatrix4(matrix), opt);
  const flush = () => {
    for (const batch of batches.values()) {
      const merged = mergeGeometries(batch.parts);
      batch.parts.forEach((part) => part.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(track(merged), batch.material);
      mesh.castShadow = batch.opt.shadow;
      mesh.receiveShadow = true;
      if (batch.opt.walk) mesh.userData.walkThrough = true;
      scene.add(mesh);
      if (batch.opt.hit) kit.shootable.push(mesh);
      if (batch.opt.fine) kit.mirrorHidden.push(mesh);
    }
    batches.clear();
  };
  /** A plain slab between two corners, its texture laid in world metres. */
  const box = (material: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, opt: Opt = { hit: true }, metres = 2.4) => {
    const geometry = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    add(material, projectUv(geometry, metres), opt);
  };
  /** A dressed block: eased edges, and its own piece of the stone so no mark runs from block to block. */
  const stone = (material: THREE.Material, w: number, h: number, d: number, matrix: THREE.Matrix4, chamfer = 0.03, opt: Opt = { hit: true }, metres = 2.4) => {
    const geometry = (high ? chamferBox(w, h, d, chamfer) : new THREE.BoxGeometry(w, h, d).toNonIndexed()).applyMatrix4(matrix);
    projectUv(geometry, metres);
    const ou = random(), ov = random(), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) + ou, uv.getY(i) + ov);
    add(material, geometry, opt);
  };

  // ---- Weathering ----------------------------------------------------------
  // Every stone and every trunk takes the same weather, worked out from where it stands: the photograph
  // is greyed and tinted, run-off streaks the upright faces, lichen blotches them and moss takes the
  // tops and the damp patches, running on from block to block as it would.
  const WEATHER = /* glsl */ `
    varying vec3 vRuinAt;
    varying vec3 vRuinUp;
    float ruinHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float ruinNoise(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(ruinHash(i), ruinHash(i + vec3(1, 0, 0)), f.x), mix(ruinHash(i + vec3(0, 1, 0)), ruinHash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(ruinHash(i + vec3(0, 0, 1)), ruinHash(i + vec3(1, 0, 1)), f.x), mix(ruinHash(i + vec3(0, 1, 1)), ruinHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }`;
  const glsl = (value: number) => value.toFixed(3);
  const weathered = <T extends THREE.MeshStandardMaterial>(material: T, o: { key: string; keep?: number; tint?: V3; moss?: number; damp?: number }) => {
    const keep = o.keep ?? 1, tint = o.tint ?? [1, 1, 1], moss = o.moss ?? 1, damp = o.damp ?? 1;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRuinAt;\nvarying vec3 vRuinUp;")
        .replace("#include <project_vertex>", /* glsl */ `#include <project_vertex>
          vec4 ruinAt = vec4(transformed, 1.0);
          vec3 ruinUp = objectNormal;
          #ifdef USE_INSTANCING
            ruinAt = instanceMatrix * ruinAt;
            ruinUp = mat3(instanceMatrix) * ruinUp;
          #endif
          vRuinAt = (modelMatrix * ruinAt).xyz;
          vRuinUp = normalize(mat3(modelMatrix) * ruinUp);`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${WEATHER}\nfloat ruinMoss = 0.0;`)
        .replace("#include <map_fragment>", /* glsl */ `#include <map_fragment>
          {
            vec3 q = vRuinAt;
            float big = ruinNoise(q * 0.42 + 3.7), mid = ruinNoise(q * 1.9 + 11.0), fine = ruinNoise(q * 7.5);
            float up = clamp(vRuinUp.y, 0.0, 1.0);
            float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            diffuseColor.rgb = mix(vec3(grey), diffuseColor.rgb, ${glsl(keep)}) * vec3(${tint.map(glsl).join(", ")});
            float lichen = smoothstep(0.6, 0.7, ruinNoise(q * 3.1 + 40.0)) * smoothstep(0.4, 0.6, big);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.4, 0.44, 0.33), lichen * ${glsl(0.4 * moss)});
            float streak = ruinNoise(vec3((q.x + q.z) * 2.6, q.y * 0.2, (q.x - q.z) * 0.8));
            diffuseColor.rgb *= mix(1.0, 0.5, smoothstep(0.48, 0.8, streak) * (1.0 - up) * ${glsl(damp)});
            ruinMoss = clamp(smoothstep(0.5, 0.72, big * 0.62 + mid * 0.3 + fine * 0.14 + up * 0.3) * ${glsl(moss)}, 0.0, 0.94);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.045, 0.085, 0.022), vec3(0.14, 0.2, 0.05), fine * 0.6 + mid * 0.4), ruinMoss);
          }`)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, ruinMoss);");
    };
    material.customProgramCacheKey = () => `ruin-weather-${o.key}`;
    return material;
  };

  // ---- Materials -----------------------------------------------------------
  const wallSet = photoSet("/textures/concrete_wall_007-2k", 1, 1, false);
  const sandSet = photoSet("/textures/sandstone_cracks-2k", 1, 1, false);
  const cobbleSet = photoSet("/textures/cobblestone_floor_04-2k", 1, 1, false);
  const ashlar = weathered(standard({ ...wallSet, normalScale: new THREE.Vector2(1.4, 1.4), envMapIntensity: 0.45 }), { key: "ashlar", keep: 0.55, tint: [1.32, 1.32, 1.17], moss: 0.7 });
  const buff = weathered(standard({ ...sandSet, normalScale: new THREE.Vector2(1.5, 1.5), envMapIntensity: 0.4 }), { key: "buff", keep: 0.3, tint: [0.86, 0.86, 0.75], moss: 0.9 });
  const deep = weathered(standard({ ...sandSet, normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.25 }), { key: "deep", keep: 0.2, tint: [0.4, 0.43, 0.36], moss: 1.2 });
  const paving = weathered(standard({ ...cobbleSet, normalScale: new THREE.Vector2(1.3, 1.3), envMapIntensity: 0.4 }), { key: "paving", keep: 0.7, tint: [0.8, 0.84, 0.72], moss: 1.1, damp: 0 });
  const voidDark = new THREE.MeshBasicMaterial({ color: 0x030604 });
  const barkMap = track(barkTexture());
  barkMap.anisotropy = anisotropy;
  const bark = weathered(standard({ map: barkMap, bumpMap: barkMap, bumpScale: 2.2, side: THREE.DoubleSide, envMapIntensity: 0.35 }), { key: "bark", tint: [1.28, 1.2, 1.06], moss: 0.38, damp: 0.4 });

  // ---- Wind ----------------------------------------------------------------
  // Hardly any air moves down here: a slow breath from the south-east, with the odd gust that gets through.
  const wind = createWind({ heading: 2.5, strength: 0.16, gustiness: 0.85 });
  let sun: THREE.DirectionalLight | undefined;
  const trees = createTrees(kit, { seed: 14, wind, sun: () => sun ?? TO_SUN });
  const life = createLife(kit, options, { wind, seed: 23 });

  // ---- Leaves --------------------------------------------------------------
  // The canopy, the big understorey leaves and the creepers share one sheet and one material. Light that
  // falls on the far side of a leaf shows through it on this one, which is most of what a canopy looks like
  // from below.
  const leafMap = track(leafAtlas(high ? 1024 : 512, 77, anisotropy));
  const leafMaterial = standard({ map: leafMap, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: high, vertexColors: true, roughness: 0.6, envMapIntensity: 0.55 });
  leafMaterial.onBeforeCompile = (shader) => {
    applyWind(shader, wind);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 leafSway;")
      .replace("#include <begin_vertex>", /* glsl */ `#include <begin_vertex>
        {
          float gust = windAt(position.xz);
          float beat = leafSway.x * 6.2832 + windTime * (0.6 + fract(leafSway.x * 7.0) * 0.7);
          vec3 push = vec3(windVector.x, 0.0, windVector.y) * 2.4 + vec3(sin(beat), cos(beat * 1.31) * 0.7, cos(beat * 0.83));
          transformed += push * leafSway.y * (0.3 + gust * 1.6);
        }`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_physical_pars_fragment>", /* glsl */ `#include <lights_physical_pars_fragment>
      void RE_Direct_Leaf(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
        RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
        float through = saturate(dot(-geometryNormal, directLight.direction) + 0.25);
        reflectedLight.directDiffuse += directLight.color * material.diffuseColor * vec3(0.86, 1.08, 0.4) * (through * 0.3);
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_Leaf`);
  };
  leafMaterial.customProgramCacheKey = () => "ruin-leaf";
  const leafBuilder = () => {
    const position: number[] = [], normal: number[] = [], uv: number[] = [], color: number[] = [], sway: number[] = [], index: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3(), g = new THREE.Vector3(), p = new THREE.Vector3();
    const vert = (q: THREE.Vector3, m: THREE.Vector3, u: number, v: number, tint: V3, phase: number, amp: number) => {
      position.push(q.x, q.y, q.z); normal.push(m.x, m.y, m.z); uv.push(u, v); color.push(tint[0], tint[1], tint[2]); sway.push(phase, amp);
    };
    return {
      get triangles() { return index.length / 3; },
      /** A flat spray of leaves: where, which way it faces, its turn in its own plane, its size and its atlas cell. */
      card(centre: THREE.Vector3, facing: THREE.Vector3, roll: number, width: number, height: number, cell: number, tint: V3, amp: number, phase: number) {
        n.copy(facing).normalize();
        a.set(0, 0, 1); if (Math.abs(n.z) > 0.9) a.set(1, 0, 0);
        a.addScaledVector(n, -a.dot(n)).normalize().applyAxisAngle(n, roll);
        b.crossVectors(n, a);
        // Normals look to the sun's side of the card, so its own shadow never lands on it.
        if (n.dot(TO_SUN) < 0) n.negate();
        const [u0, v0, u1, v1] = CELL[cell], first = position.length / 3;
        ([[-1, -1, u0, v1], [1, -1, u1, v1], [1, 1, u1, v0], [-1, 1, u0, v0]] as number[][]).forEach(([sa, sb, u, v], k) => {
          p.copy(centre).addScaledVector(a, sa * width / 2).addScaledVector(b, sb * height / 2);
          vert(p, n, u, v, tint, phase + k * 0.06, amp);
        });
        index.push(first, first + 1, first + 2, first, first + 2, first + 3);
      },
      /** A long leaf or a hanging strand: a ribbon along `spine`, the cell's length running along it from its foot (or from its top, `hung`). */
      ribbon(spine: THREE.Vector3[], across: THREE.Vector3, width: number, cell: number, tint: V3, amp: number, phase: number, hung = false, fold = 0.12) {
        const [u0, v0, u1, v1] = CELL[cell], first = position.length / 3, count = spine.length;
        for (let i = 0; i < count; i += 1) {
          const t = i / (count - 1);
          a.copy(spine[Math.min(count - 1, i + 1)]).sub(spine[Math.max(0, i - 1)]).normalize();
          b.copy(across).addScaledVector(a, -across.dot(a)).normalize();
          g.crossVectors(b, a);
          n.copy(g); if (n.dot(TO_SUN) < 0) n.negate();
          for (const s of [-1, 0, 1]) {
            p.copy(spine[i]).addScaledVector(b, s * width / 2).addScaledVector(g, Math.abs(s) * fold * width);
            vert(p, n, u0 + (u1 - u0) * (s * 0.5 + 0.5), hung ? v0 + (v1 - v0) * t : v1 + (v0 - v1) * t, tint, phase, amp * t * t);
          }
        }
        for (let i = 0; i < count - 1; i += 1) for (let s = 0; s < 2; s += 1) { const q = first + i * 3 + s; index.push(q, q + 1, q + 4, q, q + 4, q + 3); }
      },
      /** One mesh of everything added. Leaves never stand in the player's way. */
      mesh(shadow = true, mirrored = true) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
        geometry.setAttribute("leafSway", new THREE.Float32BufferAttribute(sway, 2));
        geometry.setIndex(index);
        const mesh = new THREE.Mesh(track(geometry), leafMaterial);
        mesh.castShadow = shadow; mesh.receiveShadow = true;
        mesh.userData.walkThrough = true;
        scene.add(mesh);
        if (!mirrored) kit.mirrorHidden.push(mesh);
        return mesh;
      },
    };
  };
  const leafTint = (light = 1): V3 => { const k = light * (0.74 + random() * 0.4), warm = random(); return [k * (0.86 + warm * 0.3), k, k * (0.7 + random() * 0.3)]; };

  // ---- Ground --------------------------------------------------------------
  // Flagstones: the photographed stone is greyed, cut into big staggered flags with moss in the joints, and
  // pools lie where the drips fall (POOLS) as well as where the slab's own hollows put them.
  const POOLS: Array<[number, number, number]> = [
    [-3.6, -11.4, 1.5], [1.2, -14.2, 1.1], [-6.9, -2.6, 1.0], [6.2, -20.6, 1.3], [-6.6, 2.2, 1.0], [3.4, 2.6, 0.9],
    [-7.2, -22.6, 1.2], [7.6, -4.2, 0.8], [0.6, -23.2, 1.0], [6.8, 6.9, 0.9], [-2.2, 6.3, 0.7], [-8.3, -3.0, 0.85],
  ];
  const ground = standard({ ...photoSet("/textures/sandstone_cracks-2k", 96 / 3.4, 104 / 3.4, false), normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.4 });
  const reflection = kit.floor(ground, { width: 96, depth: 104, z: -12 }, {
    lane: new THREE.Color(0.74, 0.76, 0.66),
    edge: new THREE.Color(0.78, 0.6, 0.22),
    markings: 0.5,
    wet: -0.07,
  });
  {
    const wetFloor = ground.onBeforeCompile;
    ground.onBeforeCompile = (shader, renderer) => {
      wetFloor.call(ground, shader, renderer);
      shader.fragmentShader = shader.fragmentShader
        .replace("float floorWet = 0.0;", /* glsl */ `float floorWet = 0.0;
          const vec3 RUIN_POOLS[${POOLS.length}] = vec3[${POOLS.length}](${POOLS.map((pool) => `vec3(${pool.map(glsl).join(", ")})`).join(", ")});
          float ruinPools(vec2 at) {
            float most = 0.0;
            for (int i = 0; i < ${POOLS.length}; i++) { vec2 d = at - RUIN_POOLS[i].xy; most = max(most, 1.0 - dot(d, d) / (RUIN_POOLS[i].z * RUIN_POOLS[i].z)); }
            return most;
          }`)
        .replace("0.06 + floorWetBias;", "0.06 + floorWetBias + ruinPools(slab) * 0.42;")
        .replace("#include <map_fragment>", /* glsl */ `#include <map_fragment>
          {
            vec2 at = vFloorWorld.xz;
            float course = floor(at.y / 1.1);
            float shifted = at.x + mod(course, 2.0) * 0.8 + floorHash(vec2(course, 3.0)) * 0.5;
            vec2 flag = vec2(floor(shifted / 1.6), course);
            vec2 within = vec2(fract(shifted / 1.6) * 1.6, fract(at.y / 1.1) * 1.1);
            float joint = min(min(within.x, 1.6 - within.x), min(within.y, 1.1 - within.y)) + (floorNoise(at * 2.7) - 0.5) * 0.05;
            float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            diffuseColor.rgb = mix(vec3(grey), diffuseColor.rgb, 0.24) * vec3(0.76, 0.75, 0.66) * (0.8 + 0.34 * floorHash(flag + 7.0));
            float patches = floorFbm(at * 0.55 + 9.0) + smoothstep(6.0, 9.4, abs(at.x)) * 0.22;
            float moss = max(1.0 - smoothstep(0.012, 0.05, joint), smoothstep(0.52, 0.7, patches) * (1.0 - smoothstep(0.0, 0.42, joint) * 0.75));
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.035, 0.05, 0.022), vec3(0.085, 0.11, 0.045), floorNoise(at * 11.0)), moss * 0.85);
          }`);
    };
    ground.customProgramCacheKey = () => "ruin-floor";
  }

  // ---- Masonry -------------------------------------------------------------
  // A wall face is laid in courses of blocks half a metre deep with open joints, in front of a dark
  // backing, so a joint is a real shadowed slit and a missing block a real hole. On a face `u` runs along
  // it (to the left of someone looking out of it), `v` up and `w` out.
  type Face = { at: V3; out: V3 };
  type Hole = [number, number, number, number];
  const onFace = (face: Face, u: number, v: number, w: number) => {
    const out = new THREE.Vector3(...face.out), along = new THREE.Vector3().crossVectors(UP, out);
    return new THREE.Matrix4().makeBasis(along, UP, out).setPosition(new THREE.Vector3(...face.at).addScaledVector(along, u).addScaledVector(UP, v).addScaledVector(out, w));
  };
  type Courses = { material: THREE.Material; length: [number, number]; proud?: number; depth?: number; chamfer?: number; holes?: Hole[]; flush?: (u: number, v: number) => boolean; missing?: number; opt?: Opt };
  const masonry = (face: Face, u0: number, u1: number, rows: number[], o: Courses) => {
    const depth = o.depth ?? 0.5, gap = 0.014;
    for (let r = 0; r < rows.length - 1; r += 1) {
      const v0 = rows[r], v1 = rows[r + 1], vm = (v0 + v1) / 2;
      let ranges: Array<[number, number]> = [[u0, u1]];
      for (const [h0, h1, hv0, hv1] of o.holes ?? []) {
        if (hv0 >= v1 - 0.01 || hv1 <= v0 + 0.01) continue;
        ranges = ranges.flatMap(([a, b]) => (h1 <= a || h0 >= b ? [[a, b]] : [[a, Math.min(b, h0)], [Math.max(a, h1), b]]) as Array<[number, number]>).filter(([a, b]) => b - a > 0.1);
      }
      for (const [a, b] of ranges) {
        let u = a, first = true;
        while (u < b - 0.01) {
          let length = o.length[0] + random() * (o.length[1] - o.length[0]);
          if (first) length *= 0.45 + random() * 0.55;
          first = false;
          if (b - (u + length) < o.length[0] * 0.55) length = b - u;
          const start = u, mid = u + length / 2;
          u += length;
          const flush = o.flush ? o.flush(start + 0.05, vm) || o.flush(mid, vm) || o.flush(u - 0.05, vm) : false;
          if (!flush && r > 0 && random() < (o.missing ?? 0)) continue;
          const proud = flush ? 0 : (o.proud ?? 0.05) * (random() < 0.14 ? 1.7 : 1) * random();
          stone(o.material, length - gap, v1 - v0 - gap, depth, onFace(face, mid, vm, proud - depth / 2), flush ? 0.014 : o.chamfer ?? 0.032, o.opt ?? { hit: true });
        }
      }
    }
  };
  /** The carved band: a proud course set with round bosses and stepped squares turn about, over a row of dentils. */
  const carvedBand = (face: Face, u0: number, u1: number, v0: number, v1: number, material: THREE.Material, holes: Hole[] = []) => {
    masonry(face, u0, u1, [v0, v1], { material, length: [1.8, 2.6], proud: 0, depth: 0.56, chamfer: 0.02, holes, flush: () => true });
    const boss = new THREE.SphereGeometry(0.15, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).scale(1, 1, 0.42);
    const tablet = chamferBox(0.3, 0.3, 0.07, 0.02), stud = chamferBox(0.15, 0.15, 0.07, 0.02), dentil = new THREE.BoxGeometry(0.15, 0.1, 0.09);
    const open = (u: number) => holes.every(([h0, h1, hv0, hv1]) => u < h0 - 0.2 || u > h1 + 0.2 || hv0 >= v1 || hv1 <= v0);
    const pitch = 0.62, count = Math.floor((u1 - u0) / pitch), lead = (u1 - u0 - count * pitch) / 2 + pitch / 2, vm = (v0 + v1) / 2;
    for (let i = 0; i < count; i += 1) {
      const u = u0 + lead + i * pitch;
      if (!open(u) || random() < 0.08) continue;
      if (i % 2) put(material, boss, onFace(face, u, vm, 0.058), { hit: true });
      else { put(material, tablet, onFace(face, u, vm, 0.07), { hit: true }); put(material, stud, onFace(face, u, vm, 0.12), { hit: true }); }
    }
    for (let u = u0 + 0.16; u < u1 - 0.1; u += 0.3) if (open(u) && random() > 0.06) put(material, dentil, onFace(face, u, v0 - 0.05, 0.03), { shadow: false, fine: true });
    boss.dispose(); tablet.dispose(); stud.dispose(); dentil.dispose();
  };

  // ---- The court's retaining walls -------------------------------------------
  const WEST: Face = { at: [-WALL, 0, 0], out: [1, 0, 0] }, EAST: Face = { at: [WALL, 0, 0], out: [-1, 0, 0] };
  // On the west face u = -z, on the east face u = z. Blocks behind a sign, and behind the game's alarm lamps
  // on the west wall, stand flush with the face at |x| = 9.54.
  const signs = { west: [[-13.7, -8.3, 1.27, 3.73], [-19.6, -14.4, 1.27, 3.73]], east: [[-25.7, -20.3, 1.27, 3.73], [-19.6, -14.4, 1.27, 3.73]] };
  const behind = (zones: number[][], z: number, v: number) => zones.some(([z0, z1, v0, v1]) => z > z0 && z < z1 && v > v0 && v < v1);
  const westFlush = (u: number, v: number) => behind(signs.west, -u, v) || (v > 2.91 && v < 3.73 && [3.5, -7.7, -20.5].some((z) => Math.abs(-u - z) < 0.7));
  const eastFlush = (u: number, v: number) => behind(signs.east, u, v) || (v > 2.91 && u > -13.3 && u < -12.0);
  /** A corbelled niche two courses high: the hole it leaves in the courses, and the stepped head and sill that dress it. */
  const niche = (face: Face, uc: number, holes: Hole[], material: THREE.Material, width = 1.0, v0 = ROWS[2], v1 = ROWS[4]) => {
    holes.push([uc - width / 2, uc + width / 2, v0, v1]);
    const rise = (v1 - v0) * 0.17;
    for (let step = 0; step < 2; step += 1) for (const side of [-1, 1]) {
      const reach = width * 0.17 * (step + 1);
      stone(material, reach, rise - 0.012, 0.47, onFace(face, uc + side * (width / 2 - reach / 2), v1 - rise * (1.5 - step), -0.2), 0.022);
    }
    stone(material, width + 0.24, 0.1, 0.62, onFace(face, uc, v0 - 0.05, -0.16), 0.025);
  };
  const westHoles: Hole[] = [], eastHoles: Hole[] = [];
  for (const z of [-5.9, 1.6, 6.5]) niche(WEST, -z, westHoles, ashlar);
  for (const z of [-6.7, -2.3, 1.9]) niche(EAST, z, eastHoles, ashlar);
  // The spout's panel on the west wall, the doorway of a passage on the east, and the chase the flue rises in.
  westHoles.push([2.4, 3.6, ROWS[2], ROWS[4]]);
  eastHoles.push([4.2, 5.8, ROWS[1], ROWS[5]], [-13.0, -12.3, ROWS[5], TOP_A]);
  // Lengths of coping gone, where roots have pushed it off.
  const westGaps: Hole[] = [[21.4, 26.4, BAND, TOP_A], [-8.2, -6.6, BAND, TOP_A], [3.8, 5.1, BAND, TOP_A]], eastGaps: Hole[] = [[-7.6, -2.4, BAND, TOP_A], [6.4, 8.2, BAND, TOP_A], [-28.6, -26.9, BAND, TOP_A]];
  for (const [face, u0, u1, holes, gaps, flush] of [[WEST, -BACK, -STAIR_END, westHoles, westGaps, westFlush], [EAST, STAIR_END, BACK, eastHoles, eastGaps, eastFlush]] as Array<[Face, number, number, Hole[], Hole[], (u: number, v: number) => boolean]>) {
    masonry(face, u0, u1, ROWS.slice(0, 2), { material: ashlar, length: [1.5, 2.3], proud: 0.02, depth: 0.58, chamfer: 0.04, holes });
    masonry(face, u0, u1, ROWS.slice(1), { material: ashlar, length: [1.15, 2.1], proud: 0.055, holes, flush, missing: 0.035 });
    carvedBand(face, u0, u1, ROWS[5], BAND, ashlar, holes);
    masonry(face, u0, u1, [BAND, TOP_A], { material: ashlar, length: [1.4, 2.4], proud: 0.05, depth: 0.7, chamfer: 0.05, holes: [...holes, ...gaps] });
    const side = face.out[0] > 0 ? -1 : 1;
    if (side < 0) box(deep, -WALL - 1.1, -WALL - 0.45, 0, TOP_A, STAIR_END, BACK);
    else for (const [y0, z0, z1] of [[0, STAIR_END, 4.2], [0, 5.8, BACK], [ROWS[5], 4.2, 5.8]]) box(deep, WALL + 0.45, WALL + 1.1, y0, TOP_A, z0, z1);
    box(paving, side * (WALL + 0.52), side * (EDGE_B + 0.5), TOP_A - 0.5, TOP_A, STAIR_END, BACK, { hit: true }, 3);
  }

  // ---- The upper terraces -----------------------------------------------------
  // Two more steps climb back from the court on both sides and behind it, in bigger, rougher blocks.
  const riser = (face: Face, u0: number, u1: number, height: number, holes: Hole[] = []) => {
    const course = height / 3.2;
    masonry(face, u0, u1, [0, course, course * 2, course * 3], { material: buff, length: [1.5, 2.8], proud: 0.07, chamfer: 0.045, holes, missing: 0.04 });
    masonry(face, u0, u1, [course * 3, height], { material: buff, length: [1.6, 2.6], proud: 0.05, depth: 0.66, chamfer: 0.05, holes, missing: 0.1 });
    for (const [h0, h1, hv0, hv1] of holes) add(voidDark, new THREE.PlaneGeometry(h1 - h0, hv1 - hv0).applyMatrix4(onFace(face, (h0 + h1) / 2, (hv0 + hv1) / 2, -0.43)), { shadow: false });
  };
  for (const side of [-1, 1]) {
    const face = (x: number, y: number): Face => ({ at: [side * x, y, 0], out: [-side, 0, 0] }), span = (z0: number, z1: number): [number, number] => (side < 0 ? [-z1, -z0] : [z0, z1]);
    const doors = (zs: number[], width: number, height: number): Hole[] => zs.map((z) => { const u = side < 0 ? -z : z; return [u - width / 2, u + width / 2, 0, height]; });
    riser(face(EDGE_B, TOP_A), ...span(-52, BACK), TOP_B - TOP_A, doors(side < 0 ? [-10.5, -24, 2.5] : [-6, -19.5, 4], 1.3, 1.75));
    riser(face(EDGE_C, TOP_B), ...span(-52, 15), TOP_C - TOP_B, doors(side < 0 ? [-16, 1] : [-13, -27], 1.5, 1.7));
    box(deep, side * (EDGE_B + 0.45), side * (EDGE_B + 1.1), TOP_A, TOP_B, -52, BACK);
    box(deep, side * (EDGE_C + 0.45), side * (EDGE_C + 1.1), TOP_B, TOP_C, -52, 15);
    box(paving, side * (EDGE_B + 0.52), side * (EDGE_C + 0.5), TOP_B - 0.5, TOP_B, -52, 15, { hit: true }, 3);
    box(paving, side * (EDGE_C + 0.52), side * EDGE_D, TOP_C - 0.5, TOP_C, -52, 21, { hit: true }, 3);
  }
  riser({ at: [0, TOP_B, 15], out: [0, 0, -1] }, -EDGE_C, EDGE_C, TOP_C - TOP_B, [[-6.7, -5.2, 0, 1.7], [7.4, 8.9, 0, 1.7]]);
  box(deep, -EDGE_C, EDGE_C, TOP_B, TOP_C, 15.45, 16.1);
  box(paving, -EDGE_B - 0.5, EDGE_B + 0.5, TOP_B - 0.5, TOP_B, BACK + 0.52, 15.5, { hit: true }, 3);
  box(paving, -EDGE_D, EDGE_D, TOP_C - 0.5, TOP_C, 15.52, 21, { hit: true }, 3);
  // The forest floor the terraces run out into.
  const forestFloor = standard({ color: 0x33402a, envMapIntensity: 0.2 });
  for (const [x0, x1, z0, z1] of [[-64, -EDGE_D, -86, 50], [EDGE_D, 64, -86, 50], [-EDGE_D, EDGE_D, 21, 50], [-EDGE_D, -EDGE_B, -86, -52], [EDGE_B, EDGE_D, -86, -52]]) box(forestFloor, x0, x1, TOP_C - 0.6, TOP_C - 0.02, z0, z1, { shadow: false });
  box(forestFloor, -EDGE_B, EDGE_B, DECK - 0.6, DECK - 0.03, -86, -52, { shadow: false });

  // ---- The back wall -----------------------------------------------------------
  // Higher than the side walls: the chart hangs on it. Its parapet has come down in lengths.
  const BACKWALL: Face = { at: [0, 0, BACK], out: [0, 0, -1] };
  const BACK_ROWS = [0, 0.45, 1.27, 2.09, 2.91, 3.73, 4.55, 5.37, 6.19, 7.01];
  {
    const holes: Hole[] = [];
    for (const x of [-7.9, 7.9]) niche(BACKWALL, -x, holes, ashlar, 1.0, BACK_ROWS[2], BACK_ROWS[4]);
    const flush = (u: number, v: number) => Math.abs(u) < 6.3 && v > 0.45;
    masonry(BACKWALL, -WALL, WALL, BACK_ROWS.slice(0, 2), { material: ashlar, length: [1.5, 2.3], proud: 0.02, depth: 0.58, chamfer: 0.04 });
    masonry(BACKWALL, -WALL, WALL, BACK_ROWS.slice(1), { material: ashlar, length: [1.15, 2.1], proud: 0.055, holes, flush, missing: 0.03 });
    for (const side of [-1, 1]) masonry(BACKWALL, side < 0 ? -EDGE_B : WALL, side < 0 ? -WALL : EDGE_B, [TOP_A, 5.37, 6.19, 7.01], { material: ashlar, length: [1.2, 2.1], proud: 0.055, missing: 0.04 });
    carvedBand(BACKWALL, -EDGE_B, EDGE_B, 7.01, 7.4, ashlar);
    box(deep, -EDGE_B - 0.5, EDGE_B + 0.5, 0, 7.4, BACK + 0.45, BACK + 1.1);
    // What is left of the parapet: columns of one, two or three blocks, and gaps.
    for (let u = -EDGE_B; u < EDGE_B - 0.4;) {
      const length = Math.min(EDGE_B - u, 1.1 + random() * 1.0), lump = Math.sin(u * 0.55 + 1.3) + Math.sin(u * 1.7) * 0.5 + (random() - 0.5) * 0.9, tall = lump > 0.75 ? 3 : lump > 0.1 ? 2 : lump > -0.7 ? 1 : 0;
      for (let k = 0; k < tall; k += 1) stone(ashlar, length - 0.014 - k * 0.05 * random(), 0.6, 0.62, onFace(BACKWALL, u + length / 2, 7.4 + 0.3 + k * 0.614, -0.3 + (random() - 0.5) * 0.05), 0.04);
      u += length;
    }
  }

  // ---- The far end: stair, deck and gateway --------------------------------------
  for (let step = 0; step < 12; step += 1) box(buff, -WALL - 0.5, WALL + 0.5, step * 0.5, step * 0.5 + 0.5, STAIR_END, FAR - step * 0.5, { hit: true });
  box(paving, -EDGE_B - 0.5, EDGE_B + 0.5, DECK - 0.6, DECK, -52, STAIR_END, { hit: true }, 3);
  box(buff, -EDGE_B - 0.5, EDGE_B + 0.5, 0, DECK - 0.6, STAIR_END - 0.6, STAIR_END, { hit: true });
  const GATEFACE: Face = { at: [0, DECK, GATE], out: [0, 0, 1] };
  {
    const HALF = 12, DOOR = 2, SPRING = 5.16, STEP = 0.42, door: Hole[] = [[-DOOR, DOOR, 0, 8.1]];
    const rows = Array.from({ length: 10 }, (_, k) => k * 0.9);
    masonry(GATEFACE, -HALF, HALF, rows, { material: buff, length: [1.3, 2.4], proud: 0.07, chamfer: 0.045, holes: door, missing: 0.03 });
    carvedBand(GATEFACE, -HALF, HALF, 8.1, 8.55, buff);
    masonry(GATEFACE, -HALF, HALF, [8.55, 9], { material: buff, length: [1.5, 2.4], proud: 0.06, depth: 0.72, chamfer: 0.05, missing: 0.08 });
    for (const side of [-1, 1]) {
      box(deep, side * (DOOR + 0.45), side * HALF, DECK, DECK + 9, GATE_BACK, GATE - 0.45);
      // The jambs of the passage, and the corbels that close over it course by course.
      masonry({ at: [side * DOOR, DECK, side < 0 ? GATE : GATE_BACK], out: [-side, 0, 0] }, 0, GATE - GATE_BACK, Array.from({ length: 7 }, (_, k) => k * 0.86), { material: buff, length: [1.0, 1.7], proud: 0.03, chamfer: 0.04 });
      for (let k = 0; k < 7; k += 1) {
        const reach = 0.26 * (k + 1);
        stone(buff, reach, STEP - 0.014, GATE - GATE_BACK + 0.06, xf([side * (DOOR - reach / 2), DECK + SPRING + STEP * (k + 0.5), (GATE + GATE_BACK) / 2 + 0.03]), 0.04);
      }
      // A raised surround steps up with the corbels.
      stone(buff, 0.62, SPRING, 0.2, xf([side * (DOOR + 0.31), DECK + SPRING / 2, GATE + 0.12]), 0.04);
      for (let k = 0; k < 7; k += 1) stone(buff, 0.62, STEP - 0.014, 0.2, xf([side * (DOOR + 0.31 - 0.26 * (k + 1)), DECK + SPRING + STEP * (k + 0.5) + 0.5, GATE + 0.12]), 0.04);
    }
    box(deep, -DOOR - 0.45, DOOR + 0.45, DECK + 8.1, DECK + 9, GATE_BACK, GATE - 0.45);
    // Second and third tiers, set back, the third broken away at its west end.
    const tier2: Face = { at: [0, DECK + 9, GATE - 0.6], out: [0, 0, 1] }, tier3: Face = { at: [0, DECK + 11.2, GATE - 1.1], out: [0, 0, 1] };
    masonry(tier2, -8.5, 8.5, [0, 0.8, 1.6], { material: buff, length: [1.3, 2.3], proud: 0.07, chamfer: 0.045, missing: 0.05 });
    carvedBand(tier2, -8.5, 8.5, 1.6, 1.95, buff);
    masonry(tier2, -8.5, 8.5, [1.95, 2.2], { material: buff, length: [1.4, 2.2], proud: 0.06, depth: 0.7, missing: 0.14 });
    box(deep, -8.5, 8.5, DECK + 9, DECK + 11.2, GATE_BACK + 0.3, GATE - 1.05);
    masonry(tier3, -4.6, 4.6, [0, 0.8, 1.6], { material: buff, length: [1.2, 2.1], proud: 0.07, chamfer: 0.045, holes: [[-4.6, -1.9, 0.8, 1.6]], missing: 0.06 });
    box(deep, -4.6, 4.6, DECK + 11.2, DECK + 12, GATE_BACK + 0.6, GATE - 1.55);
    box(deep, -1.9, 4.6, DECK + 12, DECK + 12.8, GATE_BACK + 0.6, GATE - 1.55);
    for (const [x, tall] of [[0.2, 1.5], [2.1, 1.1], [3.9, 1.7]]) stone(buff, 0.95, tall, 0.95, xf([x, DECK + 12.8 + tall / 2, GATE - 1.9], [0, (random() - 0.5) * 0.1, 0]), 0.05);
  }

  // ---- The tree in the gateway ---------------------------------------------------
  // It stands on the deck against the east jamb and half fills the doorway. Its buttresses run out over the
  // deck and down the stair as roots; its limbs go up into the canopy, leaning out over the court.
  const giant = (foot: V3, height: number, girth: number, lean: V3, seed: number, limbs: number, spread: number) => {
    const local = rng(seed), [x, y, z] = foot, tip: V3 = [x + lean[0], y + height, z + lean[2]];
    const flutes = 4 + Math.floor(local() * 3), twist = local() * 6;
    add(bark, limb(
      [[x, y - 0.5, z], [x + lean[0] * 0.08, y + height * 0.2, z + lean[2] * 0.08], [x + lean[0] * 0.3, y + height * 0.48, z + lean[2] * 0.3], [x + lean[0] * 0.68, y + height * 0.78, z + lean[2] * 0.68], tip],
      [girth * 1.35, girth, girth * 0.86, girth * 0.74, girth * 0.62], high ? 16 : 9, 18, 2.6,
      (t, angle) => 1 + 0.2 * Math.cos(flutes * angle + twist) * Math.max(0, 1 - t * 2.2) + 0.5 * Math.pow(Math.max(0, 1 - t * 9), 2),
    ), { hit: true });
    const fin = (angle: number, reach: number, rise: number) => add(bark, buttress(reach, rise, girth * 0.3).applyMatrix4(xf([x + Math.cos(angle) * girth * 0.5, y, z - Math.sin(angle) * girth * 0.5], [0, angle, 0])), { hit: true });
    for (let k = 0; k < flutes; k += 1) fin((k + local() * 0.5) / flutes * Math.PI * 2 + twist, girth * (1.9 + local() * 1.4), girth * (2.2 + local() * 1.5));
    const ends: THREE.Vector3[] = [];
    for (let k = 0; k < limbs; k += 1) {
      const a = (k + local() * 0.6) / limbs * Math.PI * 2, reach = spread * (0.7 + local() * 0.45), cx = Math.cos(a), cz = Math.sin(a), up = 3 + local() * 3.5;
      const end: V3 = [tip[0] + cx * reach + lean[0] * 0.5, tip[1] + up, tip[2] + cz * reach + lean[2] * 0.5];
      add(bark, limb([[tip[0], tip[1] - 1.2, tip[2]], [tip[0] + cx * reach * 0.3, tip[1] + up * 0.45, tip[2] + cz * reach * 0.3], [tip[0] + cx * reach * 0.68 + lean[0] * 0.3, tip[1] + up * 0.85, tip[2] + cz * reach * 0.68 + lean[2] * 0.3], end], [girth * 0.5, girth * 0.36, girth * 0.22, girth * 0.1], 7, 10));
      ends.push(new THREE.Vector3(...end));
    }
    return { tip: new THREE.Vector3(...tip), ends };
  };
  const GATE_TREE: V3 = [2.55, DECK, GATE + 1.25];
  const gateTree = giant(GATE_TREE, 15.5, 1.3, [-0.9, 0, 2.6], 5, 6, 8.5);
  {
    // Roots: over the deck and down the stair to the court, and down the face of the gateway beside the door.
    const stairAt = (z: number) => (z > FAR ? 0 : z > STAIR_END ? Math.min(DECK, Math.ceil((FAR - z) / 0.5) * 0.5) : DECK);
    for (const [x0, x1, thick, wander] of [[1.2, -3.2, 0.3, 1.2], [2.8, 1.6, 0.36, -0.8], [4.0, 5.8, 0.28, 0.9], [1.8, -0.4, 0.2, 0.5], [3.6, 8.4, 0.22, -1.1]] as number[][]) {
      const points: V3[] = [];
      for (let k = 0; k <= 9; k += 1) {
        const t = k / 9, z = GATE + 1.6 + t * (FAR + 1.2 - GATE - 1.6), x = x0 + (x1 - x0) * t + Math.sin(t * 5 + x0) * wander * 0.4;
        points.push([x, stairAt(z) + thick * 0.45 + (z < STAIR_END ? 0 : 0.14), z]);
      }
      add(bark, limb(points, [thick * 1.5, thick * 1.2, thick, thick * 0.8, thick * 0.55, thick * 0.3], 7, 30), { hit: true });
    }
    for (const [x, top, foot, thick] of [[4.1, 11.5, 0, 0.2], [5.0, 13.4, 0, 0.16], [6.1, 9.2, 0, 0.13], [3.9, 14.6, 5.5, 0.12], [7.2, 12.2, 3, 0.1]] as number[][]) {
      const points: V3[] = [[GATE_TREE[0] + 0.5, DECK + top + 1.2, GATE + 1.0]];
      for (let k = 0; k <= 5; k += 1) { const t = k / 5; points.push([x + Math.sin(t * 4 + x) * 0.5 * (1 - t), DECK + top + (foot - top) * t, GATE + 0.12 + thick * 0.6]); }
      add(bark, limb(points, [thick * 1.3, thick, thick * 0.85, thick * 0.7], 6, 22), { hit: true });
    }
  }

  // ---- Emergents and stranglers ---------------------------------------------------
  // A few more buttressed giants: two on the very edge of the court's walls, one behind the back wall, the
  // rest further up the terraces. Where one stands on a wall its roots have pushed the coping off and
  // run down the face to the paving.
  const emergents = [
    giant([-10.7, TOP_A, -24.1], 12.5, 0.72, [1.3, 0, 0.7], 11, 4, 6),
    giant([10.7, TOP_A, -4.9], 13, 0.78, [-1.1, 0, -0.6], 12, 4, 6.5),
    giant([7.6, TOP_B, 11.3], 11, 0.7, [-0.6, 0, -0.9], 13, 4, 6),
    giant([-15.3, TOP_B, -19.2], 12, 0.85, [0.8, 0, 0.3], 14, 5, 7),
    giant([15.7, TOP_B, -2.4], 12, 0.9, [-0.7, 0, 0.5], 15, 5, 7),
    giant([-0.8, TOP_B, 13.1], 12.5, 0.8, [0.3, 0, -0.6], 16, 5, 7),
  ];
  /** Roots that come over the top of a wall at `uc` and run down its face, to the ground (`toe`) or part of the way. */
  const cascade = (face: Face, uc: number, top: number, spread: number, count: number, seed: number, foot = 0, toe = true) => {
    const local = rng(seed), at = (u: number, v: number, w: number) => new THREE.Vector3().setFromMatrixPosition(onFace(face, u, v, w)).toArray() as V3;
    for (let k = 0; k < count; k += 1) {
      const f = count > 1 ? k / (count - 1) - 0.5 : 0, thick = (toe ? 0.07 : 0.035) + local() * (toe ? 0.1 : 0.05), wander = (local() - 0.5) * 0.9, end = uc + f * spread * 2 + (local() - 0.5) * 0.3;
      const points: V3[] = [at(uc + f * 0.5, top + (toe ? 0.55 : 0.1), -1.0), at(uc + f * spread * 0.5, top + 0.2 + thick, -0.4), at(uc + f * spread * 0.8, top + thick * 0.5 + 0.04, 0.08 + thick)];
      const low = foot + (toe ? 0 : local() * 0.5);
      for (let i = 1; i <= 5; i += 1) {
        const t = i / 5;
        points.push(at(uc + f * spread * (0.8 + 1.2 * t) + Math.sin(t * 4 + k * 1.7) * wander * 0.35 * (1 - t) + (end - uc - f * spread * 2) * t, low + (top - low) * (1 - t) + (i === 5 && toe ? thick * 0.6 : 0), 0.08 + thick * 0.8));
      }
      if (toe) points.push(at(end + wander * 0.5, thick * 0.45, 0.5 + local() * 0.45));
      add(bark, limb(points, [thick * 1.5, thick * 1.3, thick * 1.15, thick, thick * 0.9, thick * 0.75, thick * (toe ? 0.55 : 0.3)], 6, high ? 34 : 18), { hit: true, walk: true });
    }
  };
  cascade(WEST, 24.1, TOP_A, 2.25, high ? 8 : 5, 61);
  cascade(EAST, -4.9, TOP_A, 2.4, high ? 8 : 5, 62);
  cascade(BACKWALL, -7.75, 7.4, 1.0, high ? 6 : 4, 63);
  cascade(BACKWALL, 7.9, 7.4, 0.8, 3, 64, 2.4, false);

  // ---- The canopy ----------------------------------------------------------------
  // Crowns on a loose grid over the whole place, each a dome of leaf sprays with a few more hung inside it.
  // A spray that would stand in one of the planned shafts is left out, and so is the sky behind the gateway.
  const levelAt = (x: number, z: number) => {
    const ax = Math.abs(x);
    if (ax < EDGE_B && z < STAIR_END) return DECK;
    if (ax < WALL && z < BACK) return 0;
    const out = Math.max(ax - WALL, (z - BACK) + (EDGE_B - WALL));
    return out < EDGE_B - WALL ? TOP_A : out < EDGE_C - WALL ? TOP_B : TOP_C;
  };
  const trunkSpots: Array<{ x: number; z: number; top: number; radius: number }> = [];
  {
    const inner = leafBuilder(), outer = leafBuilder(), at = new THREE.Vector3(), facing = new THREE.Vector3();
    const crown = (cx: number, cz: number, top: number, radius: number, depth: number, count: number, into: ReturnType<typeof leafBuilder>, under = true) => {
      const hang = Math.round(count * 0.4);
      for (let k = 0; k < count + (under ? hang : 0); k += 1) {
        const size = 3.3 + random() * 1.5, phase = random(), roll = random() * 6.28;
        if (k < count) {
          const f = (k + 0.5) / count, polar = Math.acos(1 - f * 0.78), spin = k * 2.39996 + cx;
          facing.set(Math.sin(polar) * Math.cos(spin), Math.cos(polar), Math.sin(polar) * Math.sin(spin));
          at.set(cx + facing.x * radius, top - depth + facing.y * depth, cz + facing.z * radius);
          facing.set(facing.x / radius + (random() - 0.5) * 0.08, facing.y / depth + (random() - 0.5) * 0.08, facing.z / radius + (random() - 0.5) * 0.08);
        } else {
          const r = Math.sqrt(random()) * radius * 0.8, spin = random() * 6.28;
          at.set(cx + Math.cos(spin) * r, top - depth - 0.4 - random() * 1.6, cz + Math.sin(spin) * r);
          facing.set((random() - 0.5) * 0.7, 1, (random() - 0.5) * 0.7);
        }
        if (clearOfShafts(at.x, at.y, at.z) < size * 0.33 || inClearing(at.x, at.z)) continue;
        into.card(at, facing, roll, size, size, random() < 0.6 ? 0 : 1, leafTint(k < count ? 1 : 0.8), 0.16 + random() * 0.14, phase);
      }
    };
    const pitch = 6.4, each = high ? 26 : 15;
    for (let gz = -76; gz <= 34; gz += pitch * 0.87) for (let gx = -50 + (Math.round(gz / (pitch * 0.87)) % 2 ? pitch / 2 : 0); gx <= 50; gx += pitch) {
      const cx = gx + (random() - 0.5) * 2.6, cz = gz + (random() - 0.5) * 2.6, radius = 4.6 + random() * 1.5;
      if (inClearing(cx, cz)) continue;
      const overGate = Math.abs(cx) < 15 && cz < -31 && cz > -46;
      const top = (overGate ? 27 : 20.5) + random() * 3.2 + (Math.abs(cx) > EDGE_C ? 2 : 0);
      const near = Math.abs(cx) < 30 && cz > -62 && cz < 26;
      crown(cx, cz, top, radius, 2.6 + random() * 1.4, near ? each : Math.round(each * 0.6), near ? inner : outer, near);
      trunkSpots.push({ x: cx, z: cz, top: top - 3, radius });
    }
    // The gateway tree's own crown, forward of its trunk so the sun still comes over the gateway behind it.
    crown(gateTree.tip.x + 0.4, gateTree.tip.z + 2.4, 31.5, 9.5, 5.5, high ? 120 : 60, inner);
    for (const end of gateTree.ends) crown(end.x, end.z, end.y + 2.2, 4.2, 2.6, high ? 26 : 12, inner, false);
    for (const tree of emergents) {
      crown(tree.tip.x, tree.tip.z, tree.tip.y + 6.5, 5.6, 3.2, high ? 40 : 20, inner);
      for (const end of tree.ends) crown(end.x, end.z, end.y + 1.8, 3.6, 2.2, high ? 14 : 7, inner, false);
    }
    inner.mesh(true, true);
    outer.mesh(false, false);
  }

  // ---- Forest trunks ----------------------------------------------------------------
  // Most crowns that stand over ground get a trunk under them: a plain column of bark with a flared foot.
  {
    const trunk = new THREE.LatheGeometry([[1.75, 0], [1.3, 0.012], [1.08, 0.035], [1.0, 0.08], [0.9, 0.5], [0.78, 1]].map(([r, h]) => new THREE.Vector2(r, h)), high ? 10 : 7);
    const uv = trunk.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 6);
    const spots = trunkSpots.filter(({ x, z, radius }) => {
      const level = levelAt(x, z);
      if (level === 0 || (level === DECK && z > -52) || Math.abs(x) > 46 || z < -74 || z > 32) return false;
      if (Math.abs(x) < WALL + 1.2 || (Math.abs(x) < EDGE_B && z > BACK && z < BACK + 1.4)) return false;
      for (let y = level + 1; y < 22; y += 1.5) if (clearOfShafts(x, y, z) < 0.9) return false;
      return radius > 4.4 && random() < 0.66;
    });
    kit.instances(track(trunk), bark, spots.map(({ x, z, top }) => {
      const level = levelAt(x, z), girth = 0.2 + random() * random() * 0.6;
      return { position: [x, level - 0.1, z] as V3, rotation: [(random() - 0.5) * 0.2, random() * 6.28, (random() - 0.5) * 0.2] as V3, scale: [girth, top - level + 1.6, girth] as V3 };
    }), false, true);
  }

  // ---- The forest beyond -------------------------------------------------------------
  {
    const map = track(forestTexture());
    map.repeat.set(3, 1);
    const wall = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, color: 0x46553f });
    for (const [x, z, turn, width] of [[0, -84, 0, 126], [0, 48, Math.PI, 126], [-62, -18, Math.PI / 2, 134], [62, -18, -Math.PI / 2, 134]]) {
      const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(width, 40)), wall);
      mesh.position.set(x, 26, z); mesh.rotation.y = turn;
      scene.add(mesh);
    }
  }

  // ---- Forest trees (the shared library) -----------------------------------------------
  // Planes do duty as the forest's broadleaf trees, grown half as big again; any that would stand in a
  // shaft is left out.
  {
    const clear = ({ at, scale }: TreeItem) => { const s = typeof scale === "number" ? scale : 1; return clearOfShafts(at[0], at[1] + 7.4 * s, at[2]) > 4.3 * s * 0.8 && clearOfShafts(at[0], at[1] + 4 * s, at[2]) > 1.2; };
    const stand = (x: number, z: number, scale: number, variant: number, yaw: number): TreeItem => ({ at: [x, levelAt(x, z), z], scale, variant, yaw, tint: 0xd9e6c8 });
    const near = [stand(-11.7, -6.4, 1.45, 0, 0.4), stand(-11.9, -18.8, 1.5, 2, 2.1), stand(-11.5, 6.2, 1.35, 1, 4.0), stand(11.8, -1.4, 1.5, 2, 1.2), stand(11.6, -15.8, 1.4, 0, 3.3), stand(12.2, -27.4, 1.5, 1, 5.2), stand(-12.0, -29.5, 1.4, 1, 0.9), stand(11.8, 7.4, 1.3, 0, 2.6)];
    const mid = [stand(-15.6, -12.8, 1.5, 1, 1.0), stand(-15.4, 0.4, 1.6, 0, 3.1), stand(-15.8, -25.6, 1.5, 2, 4.4), stand(15.5, -8.2, 1.6, 1, 0.3), stand(15.8, -21.6, 1.5, 2, 2.2), stand(15.4, 3.6, 1.5, 0, 5.0), stand(-6.4, 12.6, 1.45, 2, 1.7), stand(5.2, 12.4, 1.5, 0, 3.9), stand(-19.8, -19, 1.6, 0, 0.2), stand(20.2, -14, 1.6, 1, 1.9), stand(-20, 6, 1.5, 2, 2.7), stand(20, 9, 1.5, 0, 4.6), stand(-16, -40, 1.5, 0, 1.4), stand(16.2, -41, 1.6, 2, 3.0)];
    trees.place("plane", near.filter(clear), { detail: "hero", hit: false });
    trees.place("plane", mid.filter(clear), { detail: "mid", hit: false });
  }

  // ---- Understorey -----------------------------------------------------------------------
  // What grows where the light is thin: ferns in every joint, shrubs and fan palms along the terraces,
  // great leaves on the wall tops, creepers let down the faces (short where a sign hangs), ivy, weeds and
  // drifts of fallen leaves at the foot of the walls. None of it stands in anyone's way.
  const lowest = (side: number, z: number) => {
    // How far down a wall something hanging from its top may come at `z`.
    if (side < 0) {
      if ((z > -13.9 && z < -8.1) || (z > -19.8 && z < -14.2)) return 3.8;
      if ([3.5, -7.7, -20.5].some((lamp) => Math.abs(z - lamp) < 0.9)) return 4.15;
      if (Math.abs(z + 3) < 1.1) return 3.35;
      return 1.3;
    }
    if ((z > -25.9 && z < -20.1) || (z > -19.8 && z < -14.2)) return 3.8;
    if (z > -13.9 && z < -9.4) return 4.4;
    if (z > 3.8 && z < 6.2) return 3.5;
    return 1.3;
  };
  {
    const veg = rng(909), span = (a: number, b: number) => a + veg() * (b - a);
    const RIM = [0.216, 0.27, 0.18];
    const ferns: TreeItem[] = [], shrubs: TreeItem[] = [], fans: TreeItem[] = [], dates: TreeItem[] = [], ivy: TreeItem[] = [], grass: TreeItem[] = [], weeds: TreeItem[] = [], litter: TreeItem[] = [];
    const fern = (x: number, y: number, z: number, scale: number, lean?: [number, number]) => { const variant = Math.floor(veg() * 3); ferns.push({ at: [x, y - RIM[variant] * scale, z], scale, variant, yaw: veg() * 6.28, lean, tint: 0xdcecc4 }); };
    const leaves = leafBuilder(), across = new THREE.Vector3();
    /** A clump of great leaves on long stalks, arching out from one foot. */
    const greatLeaves = (x: number, y: number, z: number, size: number, count: number, towards?: [number, number]) => {
      const turn = veg() * 6.28;
      for (let k = 0; k < count; k += 1) {
        let heading = turn + k / count * 6.283 + (veg() - 0.5) * 0.6;
        if (towards && Math.cos(heading) * towards[0] + Math.sin(heading) * towards[1] < -0.3) heading += Math.PI * (0.6 + veg() * 0.3);
        const long = size * (0.7 + veg() * 0.55), lift = 0.75 + veg() * 0.7, dx = Math.cos(heading), dz = Math.sin(heading), spine: THREE.Vector3[] = [];
        for (let i = 0; i <= 5; i += 1) { const t = i / 5; spine.push(new THREE.Vector3(x + dx * long * 0.85 * Math.pow(t, 1.25), y + long * lift * (1.7 * t - 1.25 * t * t), z + dz * long * 0.85 * Math.pow(t, 1.25))); }
        leaves.ribbon(spine, across.set(-dz, 0, dx), long * (0.36 + veg() * 0.12), 2, leafTint(1.02), 0.05 + veg() * 0.04, veg(), false, 0.14);
      }
    };
    /** A creeper let down over the edge of a wall top: `out` points off the wall, `along` runs along it. */
    const creeper = (x: number, top: number, z: number, out: [number, number], drop: number, width: number) => {
      const spine = [new THREE.Vector3(x - out[0] * 0.45, top + 0.04, z - out[1] * 0.45), new THREE.Vector3(x + out[0] * 0.05, top + 0.1, z + out[1] * 0.05)];
      const steps = Math.max(2, Math.round(drop / 0.55)), off = 0.22 + veg() * 0.12;
      for (let i = 1; i <= steps; i += 1) { const t = i / steps; spine.push(new THREE.Vector3(x + out[0] * (off + Math.sin(t * 3 + z) * 0.04), top - drop * t, z + out[1] * (off + Math.sin(t * 3 + x) * 0.04))); }
      leaves.ribbon(spine, across.set(-out[1], 0, out[0]), width, 3, leafTint(0.95), 0.07 + veg() * 0.06, veg(), true, 0.06);
    };

    for (const side of [-1, 1]) {
      const yawOut = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      // The wall tops: ferns leaning out over the court, great leaves, shrubs, and creepers down the face.
      for (let z = -34.5; z < 9.4; z += span(0.5, 1.0)) {
        if (veg() < 0.7) fern(side * span(9.75, 10.5), TOP_A, z, span(1.3, 2.3), [-side * span(0.15, 0.5), 0]);
        if (veg() < 0.22) greatLeaves(side * span(10.1, 11.2), TOP_A, z, span(1.5, 2.5), 5 + Math.floor(veg() * 4), [-side, 0]);
        if (veg() < 0.2) shrubs.push({ at: [side * span(10.8, 12.9), TOP_A, z], scale: span(1.1, 1.9), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
        const floor = lowest(side, z);
        if (floor < 4.3 && veg() < (floor > 3 ? 0.75 : 0.5)) creeper(side * WALL, TOP_A + 0.02, z, [-side, 0], Math.min(TOP_A - floor, floor > 3 ? 1 : span(1.0, 3.1)), span(0.6, 1.05));
      }
      // Thin roots over the coping between the big cascades, ending part of the way down.
      for (const z of side < 0 ? [-28.4, -17.2, -11.2, -1.2, 5.2, 8.3] : [-28.2, -23.4, -17.4, 0.4, 7.4]) {
        const floor = lowest(side, z);
        cascade(side < 0 ? WEST : EAST, side < 0 ? -z : z, TOP_A, 0.5, floor > 3 ? 2 : 3, 300 + Math.round(z * 7) + side, Math.max(floor, 1.6), false);
      }
      // The second step up.
      for (let z = -50; z < 14; z += span(1.6, 3.2)) {
        if (veg() < 0.6) shrubs.push({ at: [side * span(14, 16.6), TOP_B, z], scale: span(1.4, 2.2), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
        if (veg() < 0.5) fern(side * span(13.7, 14.3), TOP_B, z, span(1.6, 2.5), [-side * 0.3, 0]);
        if (veg() < 0.3) greatLeaves(side * span(13.9, 14.8), TOP_B, z, span(1.8, 2.7), 6, [-side, 0]);
        if (veg() < 0.4) creeper(side * EDGE_B, TOP_B + 0.02, z, [-side, 0], span(0.8, 2.2), span(0.7, 1.1));
        if (veg() < 0.35) creeper(side * EDGE_C, TOP_C + 0.02, z, [-side, 0], span(0.8, 2.0), span(0.7, 1.1));
      }
      for (const [x, z, scale, variant] of [[12.3, -13.6, 1.05, 0], [12.6, -1.6, 1.15, 2], [12.2, 8.2, 0.95, 1], [12.5, -23.2, 1.1, 2], [12.4, -31.6, 1.0, 0], [16.2, -9.5, 1.2, 2], [16.4, -30, 1.25, 0], [15.9, 6.5, 1.1, 1], [11.2, -36.4, 1.15, 2]]) {
        const at: V3 = [side * (x + (side > 0 ? 0.3 : 0)), levelAt(side * x, z + side * 2.1), z + side * 2.1];
        if (clearOfShafts(at[0], at[1] + 4.2 * scale, at[2]) > 2 * scale) fans.push({ at, scale, variant: variant + (side > 0 ? 1 : 0), yaw: veg() * 6.28, lean: [-side * 0.08, 0] });
      }
      // The foot of the wall: ivy, ferns, grass and weeds, and leaves blown into drifts.
      const clearOfFurnace = (z: number) => side < 0 || z < -13.7 || z > -9.5;
      for (let z = -28.6; z < 9.4; z += span(0.35, 0.75)) {
        if (!clearOfFurnace(z) || (side > 0 && z > 4 && z < 6)) continue;
        const pick = veg();
        if (pick < 0.3) grass.push({ at: [side * span(8.95, 9.4), 0, z], scale: span(0.8, 1.5), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
        else if (pick < 0.52) weeds.push({ at: [side * span(8.8, 9.4), 0, z], scale: span(0.8, 1.4), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
        else if (pick < 0.66) fern(side * span(9.0, 9.3), 0, z, span(0.7, 1.15));
      }
      for (const [z, variant, tall] of (side < 0 ? [[-27.6, 0, 0.9], [-4.7, 1, 0.9]] : [[-27.9, 0, 0.9], [-8.25, 1, 0.9]])) ivy.push({ at: [side * (WALL - 0.1), 0, z], yaw: yawOut, variant, scale: [1, tall, 1] });
      for (const z of side < 0 ? [-27.2, -22.6, -1.0, 3.1, 7.7] : [-27.6, -8.4, -3.9, 0.6, 7.6]) litter.push({ at: [side * span(8.6, 9.1), 0, z], yaw: veg() * 6.28, variant: veg() < 0.5 ? 0 : 2, scale: span(1.0, 1.5) });
      for (const z of [-28.3, 8.9]) greatLeaves(side * span(8.75, 9.0), 0, z, span(1.05, 1.35), 6, [-side, z < 0 ? 1 : -1]);
    }
    // By the spout, where the wall is always wet.
    for (const [x, z, scale] of [[-9.15, -4.15, 1.2], [-9.2, -1.85, 1.3], [-8.85, -1.5, 0.9], [-8.9, -4.5, 0.85], [-9.3, -3.75, 0.8], [-9.3, -2.2, 0.8]]) fern(x, 0, z, scale);
    greatLeaves(-9.05, 0, -4.95, 1.0, 5, [1, -0.4]);
    // The back wall: its foot, its broken top and the step behind it.
    for (let x = -9.2; x < 9.3; x += span(0.4, 0.8)) {
      const pick = veg();
      if (pick < 0.3) grass.push({ at: [x, 0, span(9.15, 9.5)], scale: span(0.8, 1.4), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
      else if (pick < 0.5) weeds.push({ at: [x, 0, span(9.0, 9.5)], scale: span(0.8, 1.3), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
      else if (pick < 0.6) fern(x, 0, span(9.1, 9.4), span(0.7, 1.1));
      if (veg() < 0.5) fern(x * 1.4, 7.4, span(9.9, 10.5), span(1.4, 2.2), [0, -0.3]);
      if (Math.abs(x) > 6.5 && veg() < 0.7) creeper(x, 7.42, BACK, [0, -1], span(1.2, 3.4), span(0.7, 1.1));
      else if (veg() < 0.5) creeper(x, 7.42, BACK, [0, -1], span(0.35, 0.55), span(0.7, 1.0));
    }
    for (const x of [-11.5, -8.6, -3.4, 3.6, 10.9]) greatLeaves(x, TOP_B, span(10.3, 11.2), span(1.8, 2.6), 7, [0, -1]);
    for (const x of [-12, -9.5, -2.5, 2.2, 10.2, 12.4]) shrubs.push({ at: [x, TOP_B, span(11.4, 14)], scale: span(1.4, 2.1), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
    for (const x of [-7.4, -2.6, 2.4, 6.9]) litter.push({ at: [x, 0, span(8.7, 9.2)], yaw: veg() * 6.28, variant: veg() < 0.5 ? 0 : 2, scale: span(1.0, 1.5) });
    // Loose leaves and weeds out on the paving, thickest toward the walls.
    for (let k = 0; k < 34; k += 1) {
      const x = (veg() < 0.5 ? -1 : 1) * (9.3 - Math.pow(veg(), 1.6) * 5.5), z = span(-28, 9);
      if (x > 7.6 && z > -14.2 && z < -9) continue;
      if (k % 3) litter.push({ at: [x, 0, z], yaw: veg() * 6.28, variant: k % 2 ? 0 : 2, scale: span(0.7, 1.3) });
      else weeds.push({ at: [x, 0, z], scale: span(0.6, 1.0), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
    }
    // The stair, the ledge before the gateway and the gateway's own steps.
    for (let k = 0; k < 26; k += 1) {
      const x = span(-13, 13), onStair = k < 9;
      if (onStair) { const step = Math.floor(span(1, 11)); if (Math.abs(x) > 4.5) fern(x, step * 0.5 + 0.5, FAR - step * 0.5 - 0.3, span(0.9, 1.5)); continue; }
      if (x > -3.4 && x < 5.2) continue;
      const z = span(-37.0, -35.5);
      if (k % 3 === 0) greatLeaves(x, DECK, z, span(1.4, 2.2), 6, [0, 1]);
      else if (k % 3 === 1) shrubs.push({ at: [x, DECK, z], scale: span(1.1, 1.7), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
      else fern(x, DECK, z, span(1.3, 2.1));
    }
    for (let x = -11.5; x < 11.6; x += span(0.9, 1.9)) {
      const tier = Math.abs(x) > 8.6 ? 0 : Math.abs(x) > 4.7 || x < -1.9 ? 1 : 2, y = DECK + [9, 11.2, 12.8][tier], z = GATE - [0.5, 1.0, 1.5][tier];
      if (veg() < 0.55) fern(x, y, z - 0.25, span(1.5, 2.4), [0, 0.3]);
      else if (veg() < 0.5) shrubs.push({ at: [x, y, z - 0.6], scale: span(1.2, 1.8), variant: Math.floor(veg() * 3), yaw: veg() * 6.28 });
      if (veg() < 0.6 && (Math.abs(x) > 2.6 || tier > 0)) creeper(x, y + 0.02, z + 0.5, [0, 1], span(1.0, 3.2), span(0.8, 1.2));
    }
    for (const [x, scale] of [[-10.2, 1.2], [-6.3, 1.1], [7.6, 1.25], [10.6, 1.1]]) ivy.push({ at: [x, DECK + 9, GATE + 0.08], yaw: 0, variant: 2, scale: [1.3 * scale, 1.5, 1] });
    for (const [x, variant] of [[-9.4, 0], [-5.2, 1], [8.9, 0]]) ivy.push({ at: [x, DECK, GATE + 0.08], yaw: 0, variant, scale: 1.25 });
    // Palms in the clearing behind the gateway, standing in full sun and seen through its door.
    for (const [x, z, scale, variant] of [[-1.3, -47.5, 0.95, 0], [3.4, -51, 1.0, 2], [-4.6, -54, 0.9, 1], [8.2, -47, 0.95, 1], [0.4, -58.5, 1.0, 0], [-9, -49.5, 0.9, 2], [12, -55, 1, 0]]) dates.push({ at: [x, DECK - 0.03, z], scale, variant, yaw: veg() * 6.28 });

    // Plants of the deep shade are drawn lighter than the library grows them, or they go black under the leaves.
    const shade = (items: TreeItem[], gain: number) => (high ? items : items.filter((_, k) => k % 2 === 0)).map((item) => ({ ...item, tint: new THREE.Color(0.94, 1, 0.8).multiplyScalar(gain) }));
    trees.place("potFern", shade(ferns, 1.5), { detail: high ? "hero" : "mid", hit: false }).forEach((mesh) => { if (mesh.name.includes(":pot:")) mesh.removeFromParent(); });
    trees.place("shrub", shade(shrubs, 1.7), { detail: "mid", hit: false });
    trees.place("fanPalm", fans, { detail: "mid", hit: false });
    trees.place("datePalm", dates, { detail: "mid", hit: false });
    trees.place("ivy", ivy.map((item) => ({ ...item, tint: new THREE.Color(2.0, 2.2, 1.6) })), { detail: high ? "hero" : "mid", hit: false });
    trees.place("grass", shade(grass, 1.3), { hit: false });
    trees.place("weeds", shade(weeds, 1.3), { hit: false });
    trees.place("leafLitter", high ? litter : litter.filter((_, k) => k % 2 === 0), { hit: false });

    // Lianas: looped from tree to tree over the court, and let down from the canopy along the walls.
    const liana = (from: V3, to: V3, sag: number, thick: number, hung = 0) => {
      const points: V3[] = [];
      for (let i = 0; i <= 8; i += 1) { const t = i / 8, dip = 4 * t * (1 - t); points.push([from[0] + (to[0] - from[0]) * t + Math.sin(t * 9 + from[2]) * 0.12, from[1] + (to[1] - from[1]) * t - sag * dip, from[2] + (to[2] - from[2]) * t + Math.cos(t * 7 + from[0]) * 0.12]); }
      add(bark, limb(points, [thick, thick * 0.9, thick, thick * 0.85, thick], 5, high ? 40 : 16, 0.8), { walk: true, shadow: thick > 0.045 });
      for (let k = 0; k < hung; k += 1) {
        const p = points[2 + Math.floor(veg() * 5)], drop = span(1.2, 2.6);
        leaves.ribbon([new THREE.Vector3(p[0], p[1] + 0.03, p[2]), new THREE.Vector3(p[0], p[1] - drop * 0.5, p[2]), new THREE.Vector3(p[0], p[1] - drop, p[2])], across.set(to[0] - from[0], 0, to[2] - from[2]).normalize(), span(0.8, 1.2), 3, leafTint(0.95), 0.12, veg(), true, 0.05);
      }
    };
    liana([-10.3, 13.2, -22.6], [9.9, 15, -13.6], 4.2, 0.05, 3);
    liana([10.1, 12.6, -5.4], [-10.9, 14.4, 1.8], 3.6, 0.055, 3);
    liana([-9.6, 15.5, -24.6], [1.4, 19.5, -35.4], 3.2, 0.06, 2);
    liana([9.6, 14.5, -8], [3.6, 20, -34.6], 4.4, 0.05, 2);
    liana([7.2, 15.6, 10.6], [-11.6, 13.4, 5.8], 3.0, 0.045, 2);
    liana([-10.6, 16, -22], [-11.4, 15, -7], 3.4, 0.04, 2);
    liana([10.4, 16.4, -6.2], [11.6, 15.2, -19], 3.6, 0.04, 2);
    for (let k = 0; k < (high ? 16 : 8); k += 1) {
      const side = k % 2 ? 1 : -1, x = side * span(10.2, 15.5), z = span(-38, 8), top = span(17.5, 20), low = levelAt(x, z) + span(2.2, 6);
      liana([x, top, z], [x + span(-1.6, 1.6), low, z + span(-1.6, 1.6)], -span(0.2, 0.9), span(0.03, 0.05), k % 3 === 0 ? 1 : 0);
    }
    leaves.mesh(true, false);
  }

  // ---- Painted words ---------------------------------------------------------------------
  // Everything the expedition wrote, stencilled or screwed to a wall shares one sheet, with the few plain
  // surfaces its kit needs (planks, tarpaulin, the bands of a ranging pole, brass).
  type Rect = [number, number, number, number];
  const SHEET = 1024, rect = (x: number, y: number, w: number, h: number): Rect => [x, y, w, h];
  const R = {
    board: rect(0, 0, 512, 384), water: rect(512, 0, 256, 128), stuck: rect(768, 0, 256, 128), rush: rect(512, 128, 256, 128), eco: rect(768, 128, 256, 128), force: rect(512, 256, 256, 128), trade: rect(768, 256, 256, 128),
    cache: rect(0, 384, 256, 128), cases: rect(256, 384, 256, 128), save: rect(512, 384, 256, 128), lost: rect(768, 384, 256, 128), tapir: rect(0, 512, 256, 128), pattern: rect(256, 512, 256, 128), loose: rect(512, 512, 256, 128), datum: rect(768, 512, 256, 128),
    chalk: rect(0, 768, 256, 128), tally: rect(0, 896, 256, 128), wood: rect(256, 768, 256, 256), tarp: rect(512, 768, 256, 256), brass: rect(784, 784, 96, 96), bands: rect(960, 768, 64, 256),
  };
  const TAGS = ["B-117", "B-118", "C-204", "A-031", "661", "387", "0.4420", "KEEP", "D-009", "E-552", "0.0007", "?", "B-119", "C-205", "A-032", "MISC"];
  const tagRect = (k: number) => rect((k % 8) * 128, 640 + Math.floor(k / 8) * 64, 128, 64);
  const sheetSize = high ? SHEET : SHEET / 2;
  const signMap = track(canvasTexture(sheetSize, sheetSize, (c) => {
    c.scale(sheetSize / SHEET, sheetSize / SHEET);
    const ink = rng(5150), SANS = '"Helvetica Neue", Arial, sans-serif', MONO = '"Courier New", Courier, monospace', HAND = '"Marker Felt", "Comic Sans MS", cursive';
    c.clearRect(0, 0, SHEET, SHEET);
    const words = ([x, y, w, h]: Rect, colour: string, lines: Array<[string, number]>, face = SANS) => {
      let at = y + h / 2 - lines.reduce((sum, [, size]) => sum + size * 1.22, 0) / 2;
      c.fillStyle = colour; c.textAlign = "center"; c.textBaseline = "middle";
      for (const [text, size] of lines) { c.font = `800 ${size}px ${face}`; c.fillText(text, x + w / 2, at + size * 0.61, w - 28); at += size * 1.22; }
    };
    const worn = ([x, y, w, h]: Rect, amount: number) => {
      c.save(); c.beginPath(); c.rect(x + 3, y + 3, w - 6, h - 6); c.clip();
      for (let k = 0; k < amount; k += 1) {
        const r = 1 + ink() * ink() * 7;
        c.fillStyle = `rgba(${Math.round(60 + ink() * 50)},${Math.round(40 + ink() * 30)},${Math.round(22 + ink() * 20)},${(0.25 + ink() * 0.45).toFixed(2)})`;
        c.beginPath(); c.ellipse(x + ink() * w, y + ink() * h, r, r * (0.5 + ink() * 0.5), ink() * 3, 0, 6.3); c.fill();
      }
      for (let k = 0; k < amount / 4; k += 1) { c.fillStyle = `rgba(34,40,20,${(0.07 + ink() * 0.12).toFixed(2)})`; c.fillRect(x + ink() * w, y + ink() * h * 0.5, 1 + ink() * 4, h * (0.2 + ink() * 0.6)); }
      c.restore();
    };
    const plate = (at: Rect, ground: string, colour: string, lines: Array<[string, number]>) => {
      const [x, y, w, h] = at;
      c.fillStyle = ground; c.fillRect(x + 3, y + 3, w - 6, h - 6);
      c.strokeStyle = colour; c.lineWidth = 3; c.strokeRect(x + 10, y + 10, w - 20, h - 20);
      words(at, colour, lines);
      c.fillStyle = "rgba(20,18,14,.85)";
      for (const [sx, sy] of [[x + 19, y + 19], [x + w - 19, y + 19], [x + 19, y + h - 19], [x + w - 19, y + h - 19]]) { c.beginPath(); c.arc(sx, sy, 3.2, 0, 6.3); c.fill(); }
      worn(at, 44);
    };
    const stencil = (at: Rect, colour: string, lines: Array<[string, number]>, face = MONO) => {
      words(at, colour, lines, face);
      c.globalCompositeOperation = "destination-out";
      for (let k = 0; k < 110; k += 1) { c.beginPath(); c.arc(at[0] + ink() * at[2], at[1] + ink() * at[3], 0.6 + ink() * 2.2, 0, 6.3); c.fill(); }
      c.globalCompositeOperation = "source-over";
    };
    {
      const [x, y, w, h] = R.board;
      c.fillStyle = "#d9cfae"; c.fillRect(x + 2, y + 2, w - 4, h - 4);
      c.strokeStyle = "rgba(70,56,34,.5)"; c.lineWidth = 2;
      for (let k = 1; k < 4; k += 1) { c.beginPath(); c.moveTo(x + 2, y + k * h / 4); c.lineTo(x + w - 2, y + k * h / 4); c.stroke(); }
      c.fillStyle = "#2f4f38"; c.fillRect(x + 2, y + 2, w - 4, 72);
      words(rect(x, y + 2, w, 72), "#e9e2c8", [["GREENHOLD SURVEY CO.", 34]]);
      words(rect(x, y + 78, w, 108), "#1d2a1f", [["SITE 7 · COURT B", 52], ["CANOPY EXPEDITION, SEASON 3", 23]]);
      words(rect(x, y + 190, w, 108), "#7a2218", [["NO DIGGING WITHOUT A PERMIT.", 26], ["NO DIGGING WITH A PERMIT EITHER.", 26]]);
      words(rect(x, y + 300, w, 76), "#1d2a1f", [["FINDS TO THE TENT. THE TENT IS MISSING.", 19], ["PLEASE DO NOT FEED THE ROOTS.", 19]]);
      worn(R.board, 150);
    }
    plate(R.water, "#1f4a3a", "#eef0e2", [["NOT DRINKING", 30], ["WATER", 30], ["(PROBABLY)", 19]]);
    plate(R.stuck, "#e2b21e", "#1a1810", [["DOOR STUCK", 38], ["USE THE OTHER RUIN", 18]]);
    plate(R.rush, "#a3271c", "#f1ead6", [["RUSH B →", 44], ["PASSAGE B · MIND YOUR HEAD", 15]]);
    plate(R.eco, "#e6dfc6", "#22241c", [["ECO ROUND", 38], ["NO GENERATOR TODAY", 18]]);
    plate(R.force, "#1d3350", "#eef0e2", [["FORCE BUY", 38], ["FIREWOOD · NO REFUNDS", 17]]);
    plate(R.trade, "#d9772a", "#1a1810", [["TRADE UP ↑", 38], ["LADDER ONE METRE SHORT", 16]]);
    plate(R.loose, "#e2b21e", "#1a1810", [["LOOSE BLOCKS", 32], ["LOSS BONUS NOT GUARANTEED", 15]]);
    plate(R.datum, "#9c8640", "#221c0c", [["SURVEY DATUM", 26], ["FLOAT 0.0731", 30], ["DO NOT MOVE THE RUIN", 15]]);
    stencil(R.cache, "#16150f", [["CACHE &", 44], ["CARRY", 44]]);
    stencil(R.cases, "#16150f", [["10 000 CASES", 33], ["KEYS SOLD", 23], ["SEPARATELY", 23]]);
    stencil(R.save, "#e9e4d2", [["SAVE", 84]]);
    stencil(R.lost, "#e9e4d2", [["LOST PROPERTY", 29], ["(LOSS BONUS)", 27]]);
    stencil(R.tapir, "#16150f", [["TAPIR FREIGHT", 31], ["THIS WAY UP ↑", 25]]);
    stencil(R.pattern, "#16150f", [["PATTERN 661", 35], ["FRAGILE-ISH", 25]]);
    stencil(R.chalk, "#ecece0", [["THIS WALL:", 30], ["FLOAT 0.92", 42]], HAND);
    stencil(R.tally, "#ecece0", [["DAYS SINCE LAST", 25], ["ROCKFALL: 0", 42]], HAND);
    TAGS.forEach((label, k) => { const at = tagRect(k); c.fillStyle = "#e8e4d4"; c.fillRect(at[0] + 5, at[1] + 5, 118, 54); words(at, "#1a1a16", [[label, 27]], MONO); worn(at, 8); });
    {
      const [x, y, w, h] = R.wood;
      c.fillStyle = "#7a5c3a"; c.fillRect(x, y, w, h);
      for (let k = 0; k < 220; k += 1) { c.fillStyle = `rgba(${ink() < 0.5 ? "40,28,14" : "170,136,92"},${(0.08 + ink() * 0.16).toFixed(2)})`; c.fillRect(x, y + ink() * h, w, 1 + ink() * 2); }
      const [tx, ty, tw, th] = R.tarp;
      c.fillStyle = "#93804f"; c.fillRect(tx, ty, tw, th);
      for (let k = 0; k < 500; k += 1) { c.fillStyle = `rgba(${ink() < 0.6 ? "40,34,18" : "200,190,150"},${(0.05 + ink() * 0.12).toFixed(2)})`; c.fillRect(tx + ink() * tw, ty + ink() * th, 2 + ink() * 40, 1 + ink() * 3); }
      c.fillStyle = "#b08d3c"; c.fillRect(R.brass[0] - 8, R.brass[1] - 8, 112, 112);
      for (let k = 0; k < 5; k += 1) { c.fillStyle = k % 2 ? "#e8e4d6" : "#b3261c"; c.fillRect(R.bands[0] - 2, R.bands[1] + k * 51.2, 68, 52); }
    }
  }));
  signMap.anisotropy = anisotropy;
  const signMaterial = standard({ map: signMap, alphaTest: 0.5, roughness: 0.8, envMapIntensity: 0.3 });
  const iron = standard({ color: 0x1b1c19, roughness: 0.62, metalness: 0.5, envMapIntensity: 0.6 });
  /** Lays a geometry's 0..1 uv into a rectangle of the sheet. */
  const paint = <T extends THREE.BufferGeometry>(geometry: T, [x, y, w, h]: Rect) => {
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (x + 2 + THREE.MathUtils.clamp(uv.getX(i), 0, 1) * (w - 4)) / SHEET, 1 - (y + 2 + (1 - THREE.MathUtils.clamp(uv.getY(i), 0, 1)) * (h - 4)) / SHEET);
    return geometry;
  };
  /** A painted rectangle `width` metres wide, facing the +z of `matrix`. */
  const sign = (at: Rect, width: number, matrix: THREE.Matrix4) => add(signMaterial, paint(new THREE.PlaneGeometry(width, width * at[3] / at[2]), at).applyMatrix4(matrix), { shadow: false, walk: true });
  /** An enamel plate screwed to a wall on a block of wood. */
  const plaque = (at: Rect, width: number, face: Face, u: number, v: number) => {
    sign(at, width, onFace(face, u, v, 0.118));
    add(iron, new THREE.BoxGeometry(width + 0.02, width * at[3] / at[2] + 0.02, 0.11).applyMatrix4(onFace(face, u, v, 0.06)), { shadow: false, walk: true });
  };
  const timber = (w: number, h: number, d: number, matrix: THREE.Matrix4, opt: Opt = { hit: true, walk: true }) => add(signMaterial, paint(new THREE.BoxGeometry(w, h, d), R.wood).applyMatrix4(matrix), opt);

  // ---- The spout and its basin -----------------------------------------------------------
  // On the west wall at z = -3: a carved panel, a stone lip, a thread of water and a trough that never fills.
  const SPOUT = new THREE.Vector3(-WALL + 0.37, 1.97, -3), BASIN = 0.592;
  const stream = new THREE.MeshBasicMaterial({ color: 0xdcefe6, transparent: true, opacity: 0.7, depthWrite: false });
  {
    stone(buff, 1.18, 1.62, 0.3, onFace(WEST, 3, 2.09, -0.2), 0.02);
    stone(buff, 0.86, 0.86, 0.08, onFace(WEST, 3, 2.3, -0.02), 0.02);
    stone(buff, 0.58, 0.58, 0.08, onFace(WEST, 3, 2.3, 0.04), 0.02);
    stone(ashlar, 0.3, 0.3, 0.1, onFace(WEST, 3, 2.3, 0.1), 0.03);
    stone(ashlar, 0.22, 0.16, 0.52, onFace(WEST, 3, 1.93, 0.08), 0.03);
    stone(ashlar, 0.3, 0.1, 0.2, onFace(WEST, 3, 1.8, -0.02), 0.03);
    // The trough: four slabs round a dark floor, on the paving against the wall.
    stone(ashlar, 1.34, 0.68, 0.11, onFace(WEST, 3, 0.34, 0.63), 0.035);
    stone(ashlar, 1.34, 0.68, 0.09, onFace(WEST, 3, 0.34, 0.06), 0.03);
    for (const side of [-1, 1]) stone(ashlar, 0.11, 0.68, 0.48, onFace(WEST, 3 + side * 0.615, 0.34, 0.345), 0.035);
    add(voidDark, new THREE.PlaneGeometry(1.12, 0.48).rotateX(-Math.PI / 2).applyMatrix4(onFace(WEST, 3, 0.3, 0.345)), { shadow: false });
    const water = standard({ color: 0x1a2a20, roughness: 0.05, envMapIntensity: 1.7, transparent: true, opacity: 0.86 });
    const surface = new THREE.Mesh(track(new THREE.PlaneGeometry(0.48, 1.12).rotateX(-Math.PI / 2)), water);
    surface.position.set(-WALL + 0.345, BASIN - 0.004, -3);
    surface.receiveShadow = true;
    scene.add(surface);
    kit.mirrorHidden.push(surface);
    // The thread of water: a thin tube whose streaks run down it.
    const streaks = track(canvasTexture(32, 128, (c) => {
      const ink = rng(8);
      c.fillStyle = "rgba(255,255,255,.42)"; c.fillRect(0, 0, 32, 128);
      for (let k = 0; k < 26; k += 1) {
        const x = ink() * 32, y = ink() * 128, long = 30 + ink() * 70, fade = c.createLinearGradient(0, y, 0, y + long);
        fade.addColorStop(0, "rgba(255,255,255,0)"); fade.addColorStop(0.5, `rgba(255,255,255,${(0.2 + ink() * 0.4).toFixed(2)})`); fade.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = fade;
        for (const wrap of [0, -128]) { c.save(); c.translate(0, wrap); c.fillRect(x, y, 2 + ink() * 4, long); c.restore(); }
      }
    }, true));
    stream.map = streaks;
    const fallen = new THREE.Mesh(track(limb([[SPOUT.x - 0.03, SPOUT.y + 0.05, SPOUT.z], [SPOUT.x + 0.01, SPOUT.y + 0.02, SPOUT.z], [SPOUT.x + 0.035, SPOUT.y - 0.5, SPOUT.z], [SPOUT.x + 0.04, BASIN, SPOUT.z]], [0.016, 0.014, 0.017, 0.024], 6, 10, 0.5)), stream);
    scene.add(fallen);
    kit.mirrorHidden.push(fallen);
    kit.updates.push((now) => { streaks.offset.y = -((now * 0.0021) % 1); });
  }

  // ---- The passage in the east wall -------------------------------------------------------
  // A doorway under corbels, a few steps climbing away into the dark, a lamp left on the threshold and a
  // rope across it with a notice.
  {
    box(buff, WALL + 0.4, 13.2, 0, 0.45, 4.2, 5.8, { hit: true });
    for (const z of [3.9, 5.8]) box(deep, WALL + 1.1, 13.2, 0.45, 4.0, z, z + 0.3, { hit: true });
    box(deep, 12.9, 13.2, 0.45, 4.0, 4.2, 5.8, { hit: true });
    for (let k = 0; k < 4; k += 1) box(buff, 11.0 + k * 0.44, 12.9, 0.45 + k * 0.3, 0.75 + k * 0.3, 4.2, 5.8, { hit: true });
    for (let k = 0; k < 3; k += 1) for (const side of [-1, 1]) {
      const reach = 0.2 * (k + 1);
      stone(ashlar, reach, 0.26, 0.5, onFace(EAST, 5 + side * (0.8 - reach / 2), 2.91 + 0.273 * (k + 0.5), -0.22), 0.03);
    }
    add(iron, limb([[WALL - 0.06, 1.62, 4.24], [WALL - 0.08, 1.5, 5], [WALL - 0.06, 1.62, 5.76]], [0.011, 0.011, 0.011], 5, 10), { shadow: false, walk: true });
    sign(R.stuck, 0.64, onFace(EAST, 5, 1.31, 0.085));
    add(iron, new THREE.BoxGeometry(0.66, 0.34, 0.012).applyMatrix4(onFace(EAST, 5, 1.31, 0.077)), { shadow: false, walk: true });
    for (const side of [-1, 1]) add(iron, new THREE.BoxGeometry(0.008, 0.14, 0.008).applyMatrix4(onFace(EAST, 5 + side * 0.26, 1.5, 0.08)), { shadow: false, walk: true });
  }

  // ---- Lamps ---------------------------------------------------------------------------------
  // Three storm lanterns the expedition left burning: one in a niche on each side, one inside the passage.
  const lamps: THREE.PointLight[] = [], lampGlows: Array<{ position: THREE.Vector3; color: THREE.Color }> = [];
  {
    const glass = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 1.7, 0.55) });
    const lantern = (x: number, y: number, z: number, reach: number, power: number, lit: boolean) => {
      add(iron, new THREE.CylinderGeometry(0.07, 0.075, 0.036, 10).translate(x, y + 0.018, z), { shadow: false });
      add(glass, new THREE.CylinderGeometry(0.046, 0.054, 0.13, 10).translate(x, y + 0.1, z), { shadow: false });
      add(iron, new THREE.ConeGeometry(0.076, 0.07, 10).translate(x, y + 0.2, z), { shadow: false });
      add(iron, new THREE.TorusGeometry(0.075, 0.006, 5, 12, Math.PI).translate(x, y + 0.2, z), { shadow: false });
      for (let k = 0; k < 4; k += 1) add(iron, new THREE.BoxGeometry(0.008, 0.14, 0.008).translate(x + Math.cos(k * 1.571 + 0.78) * 0.062, y + 0.1, z + Math.sin(k * 1.571 + 0.78) * 0.062), { shadow: false, fine: true });
      lampGlows.push({ position: new THREE.Vector3(x, y + 0.1, z), color: new THREE.Color(1, 0.6, 0.24).multiplyScalar(0.34) });
      if (!lit) return;
      const light = new THREE.PointLight(0xffab58, power, reach, 2);
      light.position.set(x, y + 0.14, z);
      scene.add(light);
      lamps.push(light);
    };
    lantern(-WALL - 0.12, ROWS[2] + 0.005, 1.6, 4.5, 2.6, true);
    lantern(WALL + 0.12, ROWS[2] + 0.005, 1.9, 4.5, 2.6, true);
    lantern(WALL + 1.0, 0.45, 4.72, 5.5, 3.4, high);
  }

  // ---- What fell, and what was left ---------------------------------------------------------
  {
    const drum = (x: number, y: number, z: number, radius: number, tall: number, rot: V3 = [0, 0, 0]) => {
      const geometry = new THREE.CylinderGeometry(radius, radius, tall, high ? 18 : 10).applyMatrix4(xf([x, y, z], rot));
      add(ashlar, projectUv(geometry, 2.4), { hit: true });
      if (high) add(ashlar, projectUv(new THREE.CylinderGeometry(radius + 0.025, radius + 0.025, 0.09, 18).applyMatrix4(xf([x, y, z], rot)), 2.4), { hit: true, fine: true });
    };
    /** A standing column of drums, with or without the block that carried the lintel. */
    const column = (x: number, y: number, z: number, drums: number, cap: boolean, radius = 0.4) => {
      for (let k = 0; k < drums; k += 1) drum(x + (random() - 0.5) * 0.04, y + 0.31 + k * 0.62, z + (random() - 0.5) * 0.04, radius * (1 - k * 0.012), 0.615, [0, random() * 6, 0]);
      if (cap) stone(ashlar, radius * 2.5, 0.26, radius * 2.5, xf([x, y + drums * 0.62 + 0.13, z], [0, (random() - 0.5) * 0.2, 0]), 0.04);
    };
    // Stumps of the colonnade that stood along the first step, and the pair at the head of the stair.
    for (const [x, z, drums, cap] of [[-10.4, -30.2, 3, 0], [-10.35, -19.6, 1, 0], [-10.4, -14.2, 4, 1], [-10.35, -8.4, 2, 0], [-10.4, 0.2, 3, 0], [-10.35, 5.8, 1, 0], [10.4, -27.6, 2, 0], [10.35, -20.2, 4, 1], [10.4, -14.8, 1, 0], [10.35, -9.2, 3, 0], [10.4, 2.4, 2, 0], [10.35, 8.6, 4, 1]]) column(x, TOP_A, z, drums, cap > 0);
    column(-7.3, DECK, -35.85, 6, true, 0.46);
    column(7.6, DECK, -35.85, 3, false, 0.46);
    drum(8.5, DECK + 0.47, -36.5, 0.46, 0.62, [Math.PI / 2, 0, 0.5]);
    // Drums and blocks that came down into the court.
    drum(-8.82, 0.41, 7.2, 0.41, 0.62, [Math.PI / 2, 0, 0.12]);
    drum(8.72, 0.41, -27.5, 0.41, 0.62, [Math.PI / 2, 0, 1.2]);
    drum(8.9, 0.31, -28.5, 0.41, 0.62, [0, 0.4, 0]);
    for (const [x, y, z, w, h, d, rx, ry, rz] of [
      [-8.95, 0.17, -25.3, 0.7, 0.34, 1.5, 0, 0.12, 0], [-8.78, 0.36, -22.7, 0.7, 0.34, 1.4, 0.2, -0.3, 0.62], [-8.6, 0.13, -23.9, 0.42, 0.26, 0.5, 0, 0.8, 0], [-9.0, 0.5, -25.5, 0.6, 0.32, 0.8, 0.06, -0.5, 0.05],
      [8.95, 0.17, -7.7, 0.7, 0.34, 1.45, 0, -0.1, 0], [8.82, 0.34, -1.6, 0.7, 0.34, 1.3, -0.25, 0.4, -0.6], [8.7, 0.12, -3.2, 0.4, 0.24, 0.46, 0, 0.5, 0],
      [-8.8, 0.21, -28.3, 0.9, 0.42, 0.6, 0.1, 0.3, 0.12], [-7.6, 0.75, -29.6, 1.0, 0.5, 0.52, 0.3, 0.2, 0], [7.2, 0.3, -29.3, 0.8, 0.5, 0.5, 0, -0.3, 0.2],
    ]) stone(ashlar, w, h, d, xf([x, y, z], [rx, ry, rz]), 0.04);
    for (let k = 0; k < (high ? 26 : 12); k += 1) {
      const side = k % 2 ? 1 : -1, z = k < 14 ? (side < 0 ? -26.6 + random() * 5 : -8 + random() * 7) : -28.5 + random() * 37, size = 0.08 + random() * 0.16;
      if (side > 0 && z > -14 && z < -9.4) continue;
      stone(ashlar, size * 1.4, size, size, xf([side * (8.5 + random() * 0.85), size * 0.42, z], [random(), random() * 6, random()]), 0.02, { hit: false, walk: true });
    }

    // The expedition's things.
    const props = createProps(kit, { seed: 41 });
    const turned = (x: number, y: number, z: number, yaw: number) => ({ position: [x, y, z] as V3, rotation: [0, yaw, 0] as V3 });
    /** A stencil on the face of a crate that looks along `yaw`. */
    const marked = (at: Rect, width: number, x: number, y: number, z: number, yaw: number, half: number) => sign(at, width, xf([x + Math.sin(yaw) * (half + 0.006), y, z + Math.cos(yaw) * (half + 0.006)], [0, yaw, 0]));
    const W = -Math.PI / 2, E = Math.PI / 2;
    props.place("crateLarge", [turned(8.9, 0, 8.72, W), turned(8.93, 0, 7.48, W + 0.12), turned(8.95, 0, -0.25, W - 0.08), turned(-8.75, 0, 8.85, 0)], { seed: 3 });
    props.place("crateSmall", [turned(8.88, 0.84, 8.66, W - 0.3), turned(8.98, 0.84, -0.3, W + 0.25), turned(-9.06, 0, 5.95, E + 0.2)], { seed: 4 });
    props.place("crateAmmo", [turned(8.9, 0.84, 7.5, W + 0.45), turned(8.75, 0, 6.5, W - 0.2)], { seed: 5 });
    props.place("sack", [turned(9.08, 0, 6.35, 1), turned(-9.1, 0, 3.6, 2)], { seed: 6 });
    props.place("sackLying", [turned(8.72, 0, 1.0, 0.4)], { seed: 7 });
    marked(R.cache, 0.66, 8.9, 0.45, 8.72, W, 0.41);
    marked(R.cases, 0.66, 8.93, 0.45, 7.48, W + 0.12, 0.41);
    marked(R.tapir, 0.66, 8.95, 0.45, -0.25, W - 0.08, 0.41);
    marked(R.save, 0.36, 8.88, 1.06, 8.66, W - 0.3, 0.23);
    marked(R.pattern, 0.4, 8.98, 1.06, -0.3, W + 0.25, 0.23);
    marked(R.lost, 0.4, -9.06, 0.22, 5.95, E + 0.2, 0.23);
    // A tarpaulin over the crate in the back corner.
    {
      const tarp = new THREE.PlaneGeometry(1.75, 1.6, 14, 12).rotateX(-Math.PI / 2), at = tarp.attributes.position;
      for (let i = 0; i < at.count; i += 1) {
        const x = at.getX(i), z = at.getZ(i), out = Math.max(Math.abs(x) / 0.6, Math.abs(z) / 0.47), slack = THREE.MathUtils.smoothstep(out, 1, 1.42);
        at.setY(i, 0.88 * (1 - slack) + 0.03 + (Math.sin(x * 9 + z * 4) * 0.03 + Math.sin(z * 11 - x * 3) * 0.022) * (0.35 + slack * (1 - slack) * 3.4));
      }
      tarp.computeVertexNormals();
      add(signMaterial, paint(tarp, R.tarp).applyMatrix4(xf([-8.75, 0, 8.85])), { hit: true });
      add(iron, limb([[-9.43, 0.5, 8.23], [-8.73, 0.93, 8.33], [-8.08, 0.3, 8.28], [-7.93, 0.03, 8.23]], [0.008, 0.008, 0.008], 4, 12), { shadow: false, walk: true });
    }
    // The site board on its posts, ranging poles, a ladder and a level on its tripod.
    for (const z of [4.12, 5.38]) timber(0.07, 2.15, 0.07, xf([-9.33, 1.075, z]));
    timber(0.03, 1.09, 1.44, xf([-9.28, 1.5, 4.75]));
    sign(R.board, 1.4, xf([-9.262, 1.5, 4.75], [0, Math.PI / 2, 0]));
    [2.42, 2.6, 2.84].forEach((z, k) => add(signMaterial, paint(new THREE.CylinderGeometry(0.016, 0.016, 2.1, 6).translate(0, 1.05, 0), R.bands).applyMatrix4(xf([-9.03 + k * 0.03, 0, z], [(k - 1) * 0.06, 0, 0.19 + k * 0.012])), { walk: true }));
    {
      const lean = xf([8.78, 0, 2.95], [0, 0, -0.2]);
      for (const z of [-0.2, 0.2]) timber(0.05, 3.3, 0.06, lean.clone().multiply(xf([0, 1.65, z])));
      for (let k = 0; k < 9; k += 1) timber(0.03, 0.03, 0.4, lean.clone().multiply(xf([0, 0.3 + k * 0.33, 0])), { walk: true, shadow: false });
      const apex: V3 = [-8.72, 1.36, -7.0];
      for (let k = 0; k < 3; k += 1) add(iron, limb([apex, [apex[0] + Math.cos(k * 2.094 + 0.5) * 0.42, 0, apex[2] + Math.sin(k * 2.094 + 0.5) * 0.42]], [0.02, 0.016], 5, 2), { walk: true });
      add(signMaterial, paint(new THREE.BoxGeometry(0.16, 0.05, 0.16), R.brass).translate(apex[0], apex[1] + 0.02, apex[2]), { walk: true });
      add(signMaterial, paint(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 10).rotateZ(Math.PI / 2).rotateY(0.6), R.brass).translate(apex[0], apex[1] + 0.1, apex[2]), { walk: true });
    }
    // Notices, chalk and the surveyors' tags.
    plaque(R.water, 0.5, WEST, 2.02, 1.72);
    plaque(R.eco, 0.5, WEST, -7.62, 1.72);
    plaque(R.loose, 0.5, WEST, 21.0, 1.72);
    plaque(R.rush, 0.5, EAST, 6.4, 1.74);
    plaque(R.trade, 0.5, EAST, 3.58, 1.9);
    plaque(R.force, 0.5, EAST, -9.22, 1.72);
    plaque(R.datum, 0.46, BACKWALL, 8.95, 1.7);
    sign(R.chalk, 0.9, onFace(EAST, 7.5, 2.15, 0.1));
    sign(R.tally, 0.8, onFace(WEST, 21.05, 2.42, 0.1));
    ([[WEST, -8.9, 0.86], [WEST, -5.6, 1.68], [WEST, -0.6, 0.86], [WEST, 1.3, 2.5], [WEST, 6.6, 0.86], [WEST, 21.4, 0.86], [WEST, 27.2, 1.68], [EAST, -28.6, 1.68], [EAST, -8.0, 2.5], [EAST, -1.6, 1.68], [EAST, 0.9, 0.86], [EAST, 2.7, 2.5], [EAST, 6.7, 0.86], [EAST, 8.9, 1.68], [BACKWALL, 8.6, 0.86], [BACKWALL, -6.6, 1.68]] as Array<[Face, number, number]>)
      .forEach(([face, u, v], k) => sign(tagRect(k), 0.17, onFace(face, u, v, 0.1)));

    // The flue: a storm collar where it clears the wall top, and a cowl.
    add(metals.darkMetal, new THREE.CylinderGeometry(0.34, 0.43, 0.1, 16).translate(9.28, TOP_A + 0.12, -12.65));
    add(metals.darkMetal, new THREE.ConeGeometry(0.45, 0.24, 14).translate(9.28, 6.56, -12.65));
    for (let k = 0; k < 3; k += 1) add(metals.darkMetal, new THREE.BoxGeometry(0.03, 0.3, 0.03).translate(9.28 + Math.cos(k * 2.094) * 0.27, 6.32, -12.65 + Math.sin(k * 2.094) * 0.27), { shadow: false });
  }

  // ---- Life ------------------------------------------------------------------------------
  // Leaves coming down, fireflies in the dark corners, flies at the water, birds on the wall tops and the
  // gateway, swifts over the clearing, smoke from the flue.
  life.drift("leaves", { volume: { x: [-9.2, 9.2], y: [0, 10], z: [-27, 9] }, count: 56, colors: [0x55702a, 0x7d8a2e, 0x6a5524, 0x3d6622, 0x8a6a28], falling: 0.85 });
  life.insects([[-8.3, 1.3, 7.4], [8.2, 1.4, -27.2], [-8.3, 1.5, -27.4], [8.3, 1.3, 1.0], [-8.5, 1.2, -0.6], [8.2, 1.6, -5.6]], { kind: "fireflies", count: 6, radius: 1.5, color: 0xd9ff8a });
  life.insects([[-9.0, 1.1, -3], [8.8, 1.3, 8.3]], { kind: "flies", count: 7, radius: 0.7 });
  life.birds("pigeon", {
    perches: [{ from: [-9.85, TOP_A + 0.01, -18.5], to: [-9.85, TOP_A + 0.01, -9.5] }, { from: [9.85, TOP_A + 0.01, -25], to: [9.85, TOP_A + 0.01, -15.5] }, { from: [9.85, TOP_A + 0.01, -1.5], to: [9.85, TOP_A + 0.01, 3.5] }],
    count: 9, roam: { x: [-9, 9], y: [6.5, 14], z: [-28, 7] },
  });
  life.birds("sparrow", { perches: [{ from: [-8.91, 0.685, -3.55], to: [-8.91, 0.685, -2.45] }, [8.9, 1.29, 8.6], [-8.82, 0.83, 7.2], { from: [-9.6, 1.275, 6.2], to: [-9.6, 1.275, 6.8] }], count: 6, roam: { x: [-9, 9], y: [3, 9], z: [-24, 8] } });
  life.birds("crow", { perches: [[0.2, DECK + 14.31, GATE - 1.9], [3.9, DECK + 14.51, GATE - 1.9], [-7.3, DECK + 3.99, -35.85]], count: 2, roam: { x: [-12, 12], y: [16, 24], z: [-44, -24] } });
  life.soaring("swift", { centre: [3, DECK, -52], radius: 11, height: 15, count: 5 });
  life.plume("smoke", [9.28, 6.62, -12.65], { rise: 7, size: [0.5, 2.4], opacity: 0.32, color: 0xa8a89a, lean: 1.2 });

  // Drips: water gathers on the leaves overhead and lets go, a drop at a time, into the pools below (and
  // the thread from the spout rings the basin). Each landing spreads two rings; now and then one is heard.
  {
    const count = high ? 14 : 8, FALL = 1.5, FROM = 11;
    type Drop = { x: number; y: number; z: number; period: number; phase: number; last: number; thread: boolean };
    const drops: Drop[] = Array.from({ length: count }, (_, k) => {
      const pool = POOLS[k % POOLS.length], turn = random() * 6.28, out = Math.sqrt(random()) * pool[2] * 0.5;
      return { x: pool[0] + Math.cos(turn) * out, y: 0.012, z: pool[1] + Math.sin(turn) * out, period: 2.8 + random() * 4.6, phase: random() * 9, last: 0, thread: false };
    });
    for (const phase of [0, 0.42]) drops.push({ x: SPOUT.x + 0.04, y: BASIN, z: SPOUT.z, period: 0.84, phase, last: 0, thread: true });
    const bead = new THREE.InstancedMesh(track(new THREE.BoxGeometry(0.014, 0.15, 0.014)), new THREE.MeshBasicMaterial({ color: 0xd6e6dc, transparent: true, opacity: 0.55, depthWrite: false }), count);
    const rings = new THREE.InstancedMesh(track(new THREE.RingGeometry(0.86, 1, 28).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), drops.length * 2);
    const matrix = new THREE.Matrix4(), tint = new THREE.Color(), where = new THREE.Vector3();
    for (const mesh of [bead, rings]) { mesh.frustumCulled = false; mesh.userData.walkThrough = true; scene.add(mesh); kit.mirrorHidden.push(mesh); kit.probeHidden.push(mesh); }
    let heard = 0;
    kit.updates.push((now) => {
      const seconds = now / 1000;
      for (let k = 0; k < drops.length; k += 1) {
        const drop = drops[k], t = (seconds + drop.phase) % drop.period, landed = drop.thread ? t : t - FALL, lasts = drop.thread ? 0.84 : 1.5;
        if (k < count) {
          if (t < FALL) matrix.makeScale(1, 1 + t * 2.4, 1).setPosition(drop.x, Math.max(0.05, FROM - 4.9 * t * t), drop.z); else matrix.makeScale(0, 0, 0);
          bead.setMatrixAt(k, matrix);
        }
        for (let ring = 0; ring < 2; ring += 1) {
          const age = landed - ring * 0.24;
          if (age > 0 && age < lasts) {
            const size = drop.thread ? 0.03 + age * 0.22 : 0.05 + age * 0.3;
            matrix.makeScale(size, 1, size).setPosition(drop.x, drop.y, drop.z);
            tint.setScalar(Math.pow(1 - age / lasts, 2) * (drop.thread ? 0.2 : 0.3));
          } else { matrix.makeScale(0, 0, 0); tint.setScalar(0); }
          rings.setMatrixAt(k * 2 + ring, matrix); rings.setColorAt(k * 2 + ring, tint);
        }
        if (!drop.thread && drop.last < FALL && t >= FALL && now - heard > 2300) { heard = now; options.cue?.("drip", where.set(drop.x, 0, drop.z), { gain: 0.4, pitch: 0.9 + (k % 5) * 0.06 }); }
        drop.last = t;
      }
      bead.instanceMatrix.needsUpdate = true; rings.instanceMatrix.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    });
  }

  // Shafts: the haze shows the real ones where the renderer can afford it. These faint sheets hang in the
  // same slanting columns and drift a little as the canopy sways; where there is no haze pass they are
  // all the shafts there are.
  {
    const position: number[] = [], uv: number[] = [], seed: number[] = [], index: number[] = [];
    const across = new THREE.Vector3().crossVectors(TO_SUN, UP).normalize(), other = new THREE.Vector3().crossVectors(TO_SUN, across).normalize(), at = new THREE.Vector3();
    SHAFTS.forEach((shaft, k) => {
      for (const side of [across, other]) {
        const first = position.length / 3;
        for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          at.set(...shaft.at).addScaledVector(TO_SUN, -0.6 + v * 19).addScaledVector(side, (u - 0.5) * shaft.radius * 2.3);
          position.push(at.x, at.y, at.z); uv.push(u, v); seed.push(k * 0.37 + (side === other ? 0.5 : 0));
        }
        index.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 1));
    geometry.setIndex(index);
    const time = { value: 0 };
    const sheets = new THREE.Mesh(track(geometry), new THREE.ShaderMaterial({
      uniforms: { time, strength: { value: high ? 0.03 : 0.1 }, tint: { value: new THREE.Color(1, 0.94, 0.74) } },
      vertexShader: /* glsl */ `
        attribute float seed;
        varying vec2 vUv; varying float vSeed; varying float vDepth;
        void main() { vUv = uv; vSeed = seed; vec4 view = modelViewMatrix * vec4(position, 1.0); vDepth = -view.z; gl_Position = projectionMatrix * view; }`,
      fragmentShader: /* glsl */ `
        uniform float time; uniform float strength; uniform vec3 tint;
        varying vec2 vUv; varying float vSeed; varying float vDepth;
        void main() {
          float u = vUv.x + sin(time * 0.31 + vSeed * 6.0) * 0.07 * vUv.y;
          float edge = smoothstep(0.0, 0.42, 1.0 - abs(u * 2.0 - 1.0));
          float streaks = 0.6 + 0.4 * sin(u * 21.0 + vSeed * 40.0 + sin(time * 0.23 + vSeed * 9.0) * 1.5) * sin(u * 8.0 + vSeed * 13.0 - time * 0.11);
          float along = smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.5, 1.0, vUv.y));
          float air = smoothstep(0.6, 3.5, vDepth) * exp(-vDepth * 0.012);
          gl_FragColor = vec4(tint * (edge * streaks * along * air * strength), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    sheets.frustumCulled = false; sheets.userData.walkThrough = true;
    scene.add(sheets);
    kit.mirrorHidden.push(sheets); kit.probeHidden.push(sheets);
    // A gust that gets down through the leaves is heard in them.
    const rustles = [new THREE.Vector3(-10.4, 7, -5), new THREE.Vector3(10.4, 7.5, -17), new THREE.Vector3(0, 12, 5), new THREE.Vector3(-10, 8, -24)];
    let next = 0, turn = 0;
    kit.updates.push((now) => {
      time.value = now / 1000;
      if (!next) next = now + 7000;
      if (now < next) return;
      const spot = rustles[turn % rustles.length];
      if (wind.at(spot.x, spot.z) < 0.22 && now < next + 16000) return;
      options.cue?.("leafRustle", spot, { gain: 0.5 });
      turn += 1; next = now + 13000 + ((turn * 7919) % 9000);
    });
  }

  // ---- Furnace -------------------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 2.6);

  flush();

  // ---- Light ---------------------------------------------------------------------------
  // Under the leaves everything is lit by what the leaves let through and throw back: green from above,
  // leaf-mould brown from below. The sun itself only shows where a shaft lands.
  scene.add(new THREE.HemisphereLight(0xc6d0b6, 0x5a5644, 1.45));
  // The glow of the open sky behind the player, which gives the stone a lit side and a shaded one.
  const bounce = new THREE.DirectionalLight(0xdfe6d2, 0.8);
  bounce.position.set(0.5, 0.62, 0.6);
  scene.add(bounce);
  sun = kit.sunLight({ color: 0xfff1d2, intensity: 8, toSun: TO_SUN, extent: 37, distance: 56, near: 4, far: 110, radius: 4 });

  const lit = (point: THREE.Vector3) => {
    for (const shaft of SHAFTS) if (point.y >= shaft.at[1] - 0.5 && offAxis(point.x, point.y, point.z, shaft) < shaft.radius * 0.85) return 1;
    return 0.03;
  };

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills: lamps,
    glows: lampGlows,
    reflection,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 1.5, skyRotation: 1.79, skyClamp: 16,
      background: 0x93a38f, fog: 0x93a38f, fogDensity: high ? 0.0115 : 0.014,
      haze: new THREE.Color(0.08, 0.098, 0.07), hazeDensity: 0.0135, hazeCeiling: 25, hazeFade: 12,
      environmentIntensity: 0.7, exposure: 1.03, far: 240,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck: life.struck };
}

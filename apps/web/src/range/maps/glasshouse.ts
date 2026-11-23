import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { archedWall, canvasTexture, createKit, projectUv, softBox, worldBox, type RangeEnvironment, type RangeOptions } from "../kit";
import { createLife } from "../life";
import { createProps, type PropItem } from "../props";
import { createTrees, type TreeItem } from "../trees";
import { shrinkRgba } from "../touch";
import type { Glow } from "../volumetric";
import { applyWind, createWind } from "../wind";
import { fallMaterial, waterMaterial } from "../water";

// Glasshouse: the nave of a nineteenth-century palm house, white iron and glass, with the range laid down it.
//
// Lighting model: a clear day outside. The sun stands high over the east aisle and a little ahead of
// the firing line, and everything it reaches inside has come through the glazing: the arch ribs, the
// purlins and the glazing bars of the vault are real geometry in the sun's shadow map, so they print
// a lattice over the tiles, the west wall and the plants, and stand as shafts where the misters have
// thickened the air. The glass itself casts nothing. The east wall keeps a band of floor in shade,
// broken by the light of its round-headed windows.
//
// Section, looking down-range: brick range walls to 4.5 m with the columns of the nave standing on
// them; an open arcade to the gallery at 7.2 m, a clerestory to the springing at 8.8 m, and a
// segmental vault to 13.4 m. Beyond each wall a lower aisle under a quadrant of glass, full of planting.

const WALL = 9.54, WALL_T = 0.6, COL_X = WALL + WALL_T / 2, WALL_TOP = 4.5;
const BAY = 3, Z_BACK = 10, Z_END = -41;
/** Column lines, from the back wall to the far gable. */
const LINES = Array.from({ length: Math.round((Z_BACK - Z_END) / BAY) + 1 }, (_, index) => Z_BACK - index * BAY);
const NAVE_LEN = Z_BACK + 0.3 - Z_END, NAVE_MID = (Z_BACK + 0.3 + Z_END) / 2;
const DECK = 7.2, SPRING = 8.8, APEX = 13.4;
const VR = (COL_X * COL_X + (APEX - SPRING) ** 2) / (2 * (APEX - SPRING)), VCY = APEX - VR, VA = Math.asin(COL_X / VR);
const AISLE_X = 17.2, EAVE = 3.4, AISLE_A = AISLE_X - COL_X, AISLE_B = DECK - EAVE;
/** Round-headed glazed openings in the range walls (centre z), where no sign hangs. */
const OPENINGS: Record<number, number[]> = { [-1]: [5.5, 2.5, -0.5, -3.5, -6.5, -21.5, -24.5, -27.5], 1: [2.5, -0.5, -3.5, -6.5, -27.5] };
const OPENING = { width: 2, spring: 2.85, sill: 0.9 };
/** The wall fountain beside the firing line. */
const NICHE = { z: 5.5, width: 1.5, spring: 2.5, sill: 0.62 };
const MISTERS: V3[] = [[-8.8, 3.5, -4], [8.8, 3.5, -21]];

/** Bearing of the sun (0 is +z, a quarter turn is +x) and its height. The sky is turned to put its own sun there. */
const SUN_BEARING = Math.atan2(0.82, -0.57), SUN_ELEVATION = 0.87;
const TO_SUN = new THREE.Vector3(Math.sin(SUN_BEARING) * Math.cos(SUN_ELEVATION), Math.sin(SUN_ELEVATION), Math.cos(SUN_BEARING) * Math.cos(SUN_ELEVATION));
const SKY_TURN = SUN_BEARING - Math.atan2(0.535, 0.433);

type V3 = [number, number, number];
type P2 = [number, number];
type Rect = [number, number, number, number];

const TAU = Math.PI * 2, HALF = Math.PI / 2;

function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

const mat4 = (at: V3 = [0, 0, 0], rotation: V3 = [0, 0, 0], scale: V3 | number = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), typeof scale === "number" ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale));
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder along a chosen axis. */
function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 10, radiusEnd = radius) {
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, segments, 1);
  if (axis === "x") geometry.rotateZ(-HALF);
  if (axis === "z") geometry.rotateX(HALF);
  return geometry;
}
const lathe = (profile: number[][], segments = 12) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);
/** Points of an arc in a plane; the angle is measured from straight up, clockwise. */
const arc = (cx: number, cy: number, radius: number, from: number, to: number, steps: number): P2[] =>
  Array.from({ length: steps + 1 }, (_, i) => { const a = from + ((to - from) * i) / steps; return [cx + radius * Math.sin(a), cy + radius * Math.cos(a)] as P2; });
const vaultY = (x: number, inset = 0) => VCY + Math.sqrt((VR - inset) ** 2 - x * x);
const aisleY = (x: number) => EAVE + AISLE_B * Math.sqrt(Math.max(0, 1 - ((Math.abs(x) - COL_X) / AISLE_A) ** 2));

/** A bar of rectangular section swept along a line in the xy plane: `depth` across the line, `width` along z. */
function bar2d(points: P2[], depth: number, width: number, closed = false) {
  const n = points.length, position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [], hw = width / 2, hd = depth / 2;
  let along = 0;
  for (let i = 0; i < n; i += 1) {
    const p = points[i], a = points[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)], b = points[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const length = Math.hypot(tx, ty) || 1;
    tx /= length; ty /= length;
    const nx = -ty, ny = tx;
    if (i > 0) along += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
    const ox = p[0] + nx * hd, oy = p[1] + ny * hd, ix = p[0] - nx * hd, iy = p[1] - ny * hd, u = along / 1.2;
    position.push(ox, oy, -hw, ox, oy, hw, ix, iy, hw, ix, iy, -hw, ox, oy, hw, ix, iy, hw, ix, iy, -hw, ox, oy, -hw);
    normal.push(nx, ny, 0, nx, ny, 0, -nx, -ny, 0, -nx, -ny, 0, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1);
    uv.push(u, 0, u, 0.25, u, 0.5, u, 0.75, u, 0.25, u, 0.5, u, 0.75, u, 1);
  }
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i += 1) for (let f = 0; f < 4; f += 1) {
    const a = i * 8 + f * 2, b = ((i + 1) % n) * 8 + f * 2;
    index.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}
const ring2d = (radius: number, depth: number, width: number, steps = 14) => bar2d(arc(0, 0, radius, 0, TAU, steps).slice(0, steps), depth, width, true);

/** A sheet through a line in the xy plane, running from z0 to z1 (glass, cloth). One texture tile is `tile` metres. */
function sheet2d(points: P2[], z0: number, z1: number, tile: P2) {
  const n = points.length, position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  let along = 0;
  for (let i = 0; i < n; i += 1) {
    const p = points[i], a = points[Math.max(i - 1, 0)], b = points[Math.min(i + 1, n - 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], length = Math.hypot(tx, ty) || 1;
    if (i > 0) along += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
    position.push(p[0], p[1], z0, p[0], p[1], z1);
    normal.push(-ty / length, tx / length, 0, -ty / length, tx / length, 0);
    uv.push(z0 / tile[0], along / tile[1], z1 / tile[0], along / tile[1]);
  }
  for (let i = 0; i < n - 1; i += 1) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

/** Round tube swept along a polyline with parallel-transported frames. */
function sweep(points: THREE.Vector3[], radius: number, radial = 6) {
  const n = points.length, position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  const tangent = new THREE.Vector3(), previous = new THREE.Vector3(), axis = new THREE.Vector3(), side = new THREE.Vector3(), other = new THREE.Vector3(), v = new THREE.Vector3();
  let along = 0;
  for (let i = 0; i < n; i += 1) {
    tangent.copy(points[Math.min(i + 1, n - 1)]).sub(points[Math.max(i - 1, 0)]).normalize();
    if (i === 0) {
      side.set(0, 1, 0);
      if (Math.abs(tangent.y) > 0.9) side.set(1, 0, 0);
      side.cross(tangent).normalize();
    } else {
      axis.crossVectors(previous, tangent);
      const s = axis.length();
      if (s > 1e-5) side.applyAxisAngle(axis.divideScalar(s), Math.atan2(s, previous.dot(tangent)));
      side.addScaledVector(tangent, -side.dot(tangent)).normalize();
      along += points[i].distanceTo(points[i - 1]);
    }
    other.crossVectors(tangent, side);
    for (let j = 0; j <= radial; j += 1) {
      const angle = (j / radial) * TAU;
      v.copy(side).multiplyScalar(Math.cos(angle)).addScaledVector(other, Math.sin(angle));
      position.push(points[i].x + v.x * radius, points[i].y + v.y * radius, points[i].z + v.z * radius);
      normal.push(v.x, v.y, v.z);
      uv.push(j / radial, along);
    }
    previous.copy(tangent);
  }
  for (let i = 0; i < n - 1; i += 1) for (let j = 0; j < radial; j += 1) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    index.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}
const path = (points: V3[]) => points.map((point) => new THREE.Vector3(...point));
const scaleUv = <T extends THREE.BufferGeometry>(geometry: T, u: number, v: number): T => {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  return geometry;
};

// ---- Painted textures --------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
const speckle = (c: Ctx, w: number, h: number, count: number, random: () => number, paint: (r: number) => string, min = 1, max = 3) => {
  for (let i = 0; i < count; i += 1) { c.fillStyle = paint(random()); const s = min + random() * (max - min); c.fillRect(random() * w, random() * h, s, s); }
};

/** Old white paint on cast iron: chalky, with rust weeping from the joints and a little green. */
function ironPaintTexture() {
  const random = rng(31);
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#e9ece3"; c.fillRect(0, 0, 256, 256);
    speckle(c, 256, 256, 1400, random, (r) => `rgba(${150 + r * 60},${150 + r * 60},${140 + r * 50},.12)`, 1, 4);
    for (let i = 0; i < 26; i += 1) {
      const x = random() * 256, y = random() * 256, long = 20 + random() * 90, g = c.createLinearGradient(0, y, 0, y + long);
      const rust = random() < 0.6;
      g.addColorStop(0, rust ? "rgba(150,88,44,.34)" : "rgba(96,124,78,.26)"); g.addColorStop(1, "rgba(150,100,60,0)");
      c.fillStyle = g; c.fillRect(x, y, 1.5 + random() * 4, long);
    }
    speckle(c, 256, 256, 90, random, () => "rgba(120,66,34,.5)", 1, 2.5);
  }, true);
}

/** One pane of old glass: clear in the middle, grimed along the bars, with the lap of the next pane and a few runs. */
function glassTexture(bars: boolean) {
  const random = rng(47);
  return canvasTexture(256, 512, (c) => {
    c.clearRect(0, 0, 256, 512);
    c.fillStyle = "rgba(214,236,226,.07)"; c.fillRect(0, 0, 256, 512);
    for (const [x0, x1] of [[0, 46], [256, 210]]) {
      const g = c.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, "rgba(150,172,140,.5)"); g.addColorStop(0.4, "rgba(170,190,160,.16)"); g.addColorStop(1, "rgba(200,220,200,0)");
      c.fillStyle = g; c.fillRect(Math.min(x0, x1), 0, 46, 512);
    }
    for (const y of [170, 342, 508]) {
      const g = c.createLinearGradient(0, y - 26, 0, y);
      g.addColorStop(0, "rgba(160,180,150,0)"); g.addColorStop(0.85, "rgba(140,160,130,.3)"); g.addColorStop(1, "rgba(90,104,88,.6)");
      c.fillStyle = g; c.fillRect(0, y - 26, 256, 26);
    }
    for (let i = 0; i < 22; i += 1) {
      const x = random() * 256, y = random() * 512, long = 30 + random() * 140, g = c.createLinearGradient(0, y, 0, y + long);
      g.addColorStop(0, "rgba(236,244,236,.22)"); g.addColorStop(1, "rgba(236,244,236,0)");
      c.fillStyle = g; c.fillRect(x, y, 1 + random() * 3, long);
    }
    speckle(c, 256, 512, 500, random, () => "rgba(226,238,226,.1)", 1, 5);
    if (bars) { c.fillStyle = "rgba(232,236,226,.96)"; c.fillRect(0, 0, 14, 512); c.fillRect(242, 0, 14, 512); }
  }, true);
}

function soilTexture() {
  const random = rng(53);
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#2f231a"; c.fillRect(0, 0, 256, 256);
    speckle(c, 256, 256, 2600, random, (r) => `rgba(${26 + r * 60},${18 + r * 44},${12 + r * 28},.6)`, 1, 5);
    speckle(c, 256, 256, 260, random, (r) => (r < 0.5 ? "rgba(120,96,64,.7)" : "rgba(64,82,40,.6)"), 2, 6);
    speckle(c, 256, 256, 120, random, () => "rgba(190,180,160,.5)", 1, 2);
  }, true);
}

/** Bark of a tree fern (a mat of dark roots and old stalk bases) beside the green sheaths of a banana stem. */
function stemTexture() {
  const random = rng(59);
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#2c1f15"; c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 520; i += 1) {
      const x = random() * 128, y = random() * 256;
      c.strokeStyle = `rgba(${40 + random() * 70},${26 + random() * 44},${14 + random() * 26},.8)`; c.lineWidth = 1 + random() * 1.6;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (random() - 0.5) * 8, y + 8 + random() * 22); c.stroke();
    }
    for (let row = 0; row < 11; row += 1) for (let col = 0; col < 5; col += 1) {
      const x = col * 26 + (row % 2) * 13 + 6, y = row * 24 + 8;
      c.fillStyle = "rgba(16,10,6,.55)"; c.beginPath(); c.ellipse(x, y, 7, 4.5, 0, 0, TAU); c.fill();
      c.fillStyle = "rgba(96,70,40,.5)"; c.beginPath(); c.ellipse(x, y - 2, 5, 2, 0, 0, TAU); c.fill();
    }
    const g = c.createLinearGradient(128, 0, 256, 0);
    g.addColorStop(0, "#5d7a35"); g.addColorStop(0.3, "#8a9a4c"); g.addColorStop(0.55, "#6f8a3d"); g.addColorStop(0.8, "#93a25a"); g.addColorStop(1, "#5d7a35");
    c.fillStyle = g; c.fillRect(128, 0, 128, 256);
    for (let i = 0; i < 90; i += 1) {
      const x = 128 + random() * 128, y = random() * 256, long = 30 + random() * 120;
      c.fillStyle = random() < 0.5 ? "rgba(70,52,28,.28)" : "rgba(180,170,110,.2)"; c.fillRect(x, y, 1 + random() * 3, long);
    }
    for (let i = 0; i < 9; i += 1) { c.fillStyle = "rgba(60,44,26,.42)"; c.beginPath(); c.ellipse(128 + random() * 128, random() * 256, 5 + random() * 12, 10 + random() * 26, 0, 0, TAU); c.fill(); }
  }, true);
}

/** Cast-iron floor grille over a heating duct: rows of slots, worn bright on the bars. */
function grilleTexture() {
  const random = rng(67);
  return canvasTexture(128, 128, (c) => {
    c.fillStyle = "#8d8a80"; c.fillRect(0, 0, 128, 128);
    speckle(c, 128, 128, 520, random, (r) => `rgba(${96 + r * 60},${62 + r * 40},${36 + r * 20},.28)`, 1, 3);
    for (let row = 0; row < 8; row += 1) for (let col = 0; col < 3; col += 1) {
      const x = 13 + col * 36, y = 4.5 + row * 16;
      c.fillStyle = "rgba(222,216,200,.2)"; c.fillRect(x + 2, y - 1.5, 26, 1.5);
      c.fillStyle = "#070707";
      c.fillRect(x + 3.5, y, 23, 7);
      c.beginPath(); c.arc(x + 3.5, y + 3.5, 3.5, 0, TAU); c.arc(x + 26.5, y + 3.5, 3.5, 0, TAU); c.fill();
    }
    c.fillStyle = "rgba(0,0,0,.55)"; c.fillRect(0, 0, 3, 128); c.fillRect(125, 0, 3, 128);
    c.fillStyle = "rgba(226,220,204,.22)"; c.fillRect(3, 0, 3, 128); c.fillRect(122, 0, 3, 128);
  }, true);
}

const SIGN = 1024;
/** Plant labels: genus, species, the name the gardeners use, and a remark. */
const LABELS: Array<[string, string, string, string]> = [
  ["PHOENIX", "rushbeeana", "Rush-B Date Palm", "Does not stop."],
  ["MUSA", "ecoroundii", "Thrifty Banana", "Fruits every third round."],
  ["DICKSONIA", "forcebuyensis", "Reckless Tree Fern", "Planted against advice."],
  ["CYCAS", "savea", "Saving Sago", "Kept for the next round."],
  ["MONSTERA", "doorstuckii", "Stuck-Door Plant", "The holes are intended."],
  ["ALOCASIA", "tradeupensis", "Trade-Up Elephant Ear", "Float 0.0700 · Pattern 661"],
  ["NEPHROLEPIS", "lossbonusa", "Consolation Fern", "Thrives after a defeat."],
  ["CALADIUM", "cachecarryi", "Cache & Carry Leaf", "Pattern 387. Do not pick."],
];
const labelCell = (k: number): Rect => [(k % 3) * 336 + 8, Math.floor(k / 3) * 112 + 4, (k % 3) * 336 + 328, Math.floor(k / 3) * 112 + 108];
/** Cells of the sign sheet in pixels. */
const SIGNS = {
  founder: labelCell(8), bench: [0, 352, 448, 672], gear: [464, 352, 912, 672], scale: [928, 352, 1024, 672],
  mist: [0, 688, 400, 944], seeds: [408, 688, 808, 944], trade: [816, 688, 1024, 944],
} satisfies Record<string, Rect>;

/** Every enamel plate in the house on one sheet: the plant labels, the notices, the founder's plate, a thermometer scale. */
function signSheet() {
  const random = rng(83);
  return canvasTexture(SIGN, SIGN, (c) => {
    c.fillStyle = "#e9e6da"; c.fillRect(0, 0, SIGN, SIGN);
    c.textBaseline = "middle";
    const face = (px: number, style: string) => `${style} ${Math.round(px)}px Georgia, "Times New Roman", serif`;
    const line = (text: string, x: number, y: number, px: number, room: number, style = "bold") => {
      c.textAlign = "center"; c.font = face(px, style);
      const wide = c.measureText(text).width;
      if (wide > room) c.font = face((px * room) / wide, style);
      c.fillText(text, x, y);
    };
    /** Vitreous enamel: a field, a rule round it, chips at the screws and the rust that weeps from them. */
    const enamel = ([x0, y0, x1, y1]: Rect, field: string, ink: string, screws: P2[]) => {
      const w = x1 - x0, h = y1 - y0, edge = Math.min(w, h) * 0.05;
      c.fillStyle = field; c.fillRect(x0, y0, w, h);
      for (let i = 0; i < 40; i += 1) { c.fillStyle = `rgba(${random() < 0.5 ? "255,255,255" : "0,0,0"},.035)`; c.fillRect(x0 + random() * w, y0 + random() * h, 4 + random() * 40, 2 + random() * 10); }
      c.strokeStyle = ink; c.lineWidth = Math.max(2, edge * 0.3); c.strokeRect(x0 + edge, y0 + edge, w - edge * 2, h - edge * 2);
      c.save(); c.beginPath(); c.rect(x0, y0, w, h); c.clip();
      for (const [fx, fy] of screws) {
        const sx = x0 + fx * w, sy = y0 + fy * h, chip = edge * (0.7 + random() * 0.6);
        const run = c.createLinearGradient(0, sy, 0, sy + chip * (5 + random() * 6));
        run.addColorStop(0, "rgba(128,66,30,.5)"); run.addColorStop(1, "rgba(128,66,30,0)");
        c.fillStyle = run; c.fillRect(sx - chip * 0.5, sy, chip, chip * 11);
        c.fillStyle = "#4a2a18"; c.beginPath(); c.ellipse(sx + (random() - 0.5) * 3, sy, chip * 0.9, chip * 0.7, random() * 3, 0, TAU); c.fill();
        c.fillStyle = "#8a8a84"; c.beginPath(); c.arc(sx, sy, chip * 0.42, 0, TAU); c.fill();
        c.strokeStyle = "#2c2c2a"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(sx - chip * 0.3, sy - chip * 0.2); c.lineTo(sx + chip * 0.3, sy + chip * 0.2); c.stroke();
      }
      c.restore();
      c.fillStyle = ink;
    };
    const ends: P2[] = [[0.045, 0.5], [0.955, 0.5]], corners: P2[] = [[0.06, 0.09], [0.94, 0.09], [0.06, 0.91], [0.94, 0.91]];

    LABELS.forEach(([genus, species, common, remark], k) => {
      const cell = labelCell(k), [x0, y0, x1] = cell, cx = (x0 + x1) / 2;
      enamel(cell, "#f5f2e6", "#18261e", ends);
      c.font = face(27, "bold");
      const wide = c.measureText(genus + " ").width;
      c.font = face(26, "italic");
      const all = wide + c.measureText(species).width, scale = Math.min(1, 262 / all), from = cx - (all * scale) / 2;
      c.textAlign = "left";
      c.font = face(27 * scale, "bold"); c.fillText(genus, from, y0 + 28);
      c.font = face(26 * scale, "italic"); c.fillText(species, from + wide * scale, y0 + 28);
      line(common, cx, y0 + 58, 20, 256, "normal");
      c.fillStyle = "#5a5f58"; line(remark, cx, y0 + 83, 15, 256, "italic");
    });

    {
      const [x0, y0, x1] = SIGNS.founder, cx = (x0 + x1) / 2;
      enamel(SIGNS.founder, "#23272a", "#8f8d82", ends);
      c.fillStyle = "#d9d6c8";
      line("BRAMWELL & HOOK", cx, y0 + 30, 27, 262);
      line("IRONFOUNDERS · EST. 1871", cx, y0 + 59, 17, 262);
      c.fillStyle = "#9c998c"; line("ROOF PATTERN No. 661", cx, y0 + 83, 13, 262, "normal");
    }
    {
      const [x0, y0, x1] = SIGNS.bench, cx = (x0 + x1) / 2;
      enamel(SIGNS.bench, "#1f3d2e", "#efe9d2", corners);
      line("POTTING BENCH", cx, y0 + 62, 44, 380);
      c.fillRect(x0 + 60, y0 + 96, x1 - x0 - 120, 3);
      ["1.  FORCE BUY NOTHING.", "2.  SAVE THE SEED.", "3.  LOSS BONUS PAID IN CUTTINGS.", "4.  RETURN THE TROWEL."].forEach((text, i) => line(text, cx, y0 + 132 + i * 38, 24, 372));
      line("By order of the Head Gardener", cx, y0 + 288, 17, 360, "italic");
    }
    {
      const [x0, y0, x1] = SIGNS.gear, cx = (x0 + x1) / 2;
      enamel(SIGNS.gear, "#f5f2e6", "#7a1f18", corners);
      line("VENTILATOR GEAR", cx, y0 + 58, 32, 370);
      line("DOOR STUCK?", cx, y0 + 134, 60, 380);
      line("WIND THE OTHER WAY.", cx, y0 + 208, 29, 372);
      line("Forty turns to open, forty to shut.", cx, y0 + 268, 19, 360, "italic");
    }
    {
      const [x0, y0, x1] = SIGNS.mist, cx = (x0 + x1) / 2;
      enamel(SIGNS.mist, "#1d3557", "#f3f1e6", corners);
      line("MISTING", cx, y0 + 70, 62, 330);
      line("ON THE QUARTER HOUR", cx, y0 + 128, 26, 330);
      line("ECO ROUND: HALF PRESSURE", cx, y0 + 172, 21, 330);
      line("Powder is kept dry at the owner’s risk.", cx, y0 + 214, 16, 322, "italic");
    }
    {
      const [x0, y0, x1] = SIGNS.seeds, cx = (x0 + x1) / 2;
      enamel(SIGNS.seeds, "#f5f2e6", "#16181a", corners);
      line("SEED STORE", cx, y0 + 50, 30, 330);
      line("10 000 CASES", cx, y0 + 108, 54, 336);
      line("KEYS SOLD SEPARATELY", cx, y0 + 166, 27, 336);
      line("CACHE & CARRY · NO CREDIT", cx, y0 + 212, 18, 330, "normal");
    }
    {
      const [x0, y0, x1] = SIGNS.trade, cx = (x0 + x1) / 2;
      enamel(SIGNS.trade, "#7a1f18", "#f1ead2", corners);
      line("TRADE", cx, y0 + 62, 50, 166);
      line("UP", cx, y0 + 112, 50, 166);
      line("Ten seedlings", cx, y0 + 160, 19, 170, "normal");
      line("for one palm.", cx, y0 + 184, 19, 170, "normal");
      line("No choice of pattern.", cx, y0 + 222, 14, 170, "italic");
    }
    {
      // Thermometer scale: degrees from 0 at the bulb to 50, a long stroke at every ten.
      const [x0, y0, x1, y1] = SIGNS.scale;
      c.fillStyle = "#f7f5ec"; c.fillRect(x0, y0, x1 - x0, y1 - y0);
      c.fillStyle = "#1b1b1a"; c.textAlign = "left";
      for (let degree = 0; degree <= 50; degree += 1) {
        const y = y1 - 22 - degree * 5.5, long = degree % 10 === 0 ? 30 : degree % 5 === 0 ? 20 : 11;
        c.fillRect(x0 + 6, y - 0.8, long, 1.6);
        if (degree % 10 === 0) { c.font = face(17, "bold"); c.fillText(String(degree), x0 + 62, y + 1); }
      }
    }
  });
}

const LEAF_W = 2048, LEAF_H = 1024;
/** Cells of the leaf sheet in pixels: every leaf lies along x with its stalk at the left. */
const CELLS = {
  banana: [0, 0, 1024, 384], frond: [0, 384, 1024, 704], cycad: [0, 704, 1024, 864], vine: [0, 864, 1024, 1024],
  alocasia: [1024, 0, 1536, 512], monstera: [1024, 512, 1536, 1024],
  lily: [1536, 0, 1792, 256], flower: [1792, 0, 2048, 256], strap: [1536, 256, 2048, 384], caladium: [1536, 384, 2048, 640], curtain: [1536, 640, 2048, 1024],
} satisfies Record<string, Rect>;
const rectOf = (cell: Rect): Rect => [(cell[0] + 2) / LEAF_W, (cell[1] + 2) / LEAF_H, (cell[2] - 2) / LEAF_W, (cell[3] - 2) / LEAF_H];

/** The big leaves the tree library does not grow: banana, tree fern, cycad, aroids, climbers, lily pads. */
function leafSheet() {
  const canvas = document.createElement("canvas");
  canvas.width = LEAF_W; canvas.height = LEAF_H;
  const c = canvas.getContext("2d", { willReadFrequently: true })!, random = rng(977);
  const cell = (rect: Rect, draw: (x: number, y: number, w: number, h: number) => void) => {
    c.save(); c.beginPath(); c.rect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]); c.clip();
    draw(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    c.restore(); c.globalCompositeOperation = "source-over";
  };
  const green = (r: number, g: number, b: number, shade: number) => `rgb(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)})`;

  cell(CELLS.banana, (x, y, w, h) => {
    const cy = y + h / 2, half = (t: number) => (t < 0.07 ? 0 : h * 0.47 * Math.pow(Math.sin(Math.PI * Math.pow((t - 0.07) / 0.93, 0.6)), 0.5));
    const outline = () => {
      c.beginPath(); c.moveTo(x + w * 0.07, cy);
      for (let i = 0; i <= 64; i += 1) { const t = 0.07 + (0.925 * i) / 64; c.lineTo(x + w * t, cy - half(t)); }
      for (let i = 64; i >= 0; i -= 1) { const t = 0.07 + (0.925 * i) / 64; c.lineTo(x + w * t, cy + half(t)); }
      c.closePath();
    };
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#77a53e"); g.addColorStop(0.3, "#4f8a30"); g.addColorStop(0.5, "#3f7a2c"); g.addColorStop(0.7, "#4f8a30"); g.addColorStop(1, "#77a53e");
    outline(); c.fillStyle = g; c.fill();
    c.save(); outline(); c.clip();
    for (let k = 0; k < 190; k += 1) {
      const px = x + w * (0.07 + (0.93 * k) / 190);
      for (const s of [-1, 1]) {
        c.strokeStyle = k % 3 === 0 ? "rgba(22,62,20,.34)" : "rgba(176,208,100,.17)"; c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(px, cy); c.quadraticCurveTo(px + w * 0.012, cy + s * h * 0.25, px + w * 0.04, cy + s * h * 0.5); c.stroke();
      }
    }
    for (let i = 0; i < 18; i += 1) { c.fillStyle = `rgba(${150 + random() * 50},${130 + random() * 40},60,.2)`; c.beginPath(); c.ellipse(x + random() * w, cy + (random() - 0.5) * h, 8 + random() * 30, 4 + random() * 9, random() * 3, 0, TAU); c.fill(); }
    c.lineWidth = 7; c.strokeStyle = "rgba(150,118,52,.5)"; outline(); c.stroke();
    c.restore();
    c.fillStyle = "#bccf7c"; c.beginPath(); c.moveTo(x, cy - 8); c.lineTo(x + w * 0.985, cy - 1); c.lineTo(x + w * 0.985, cy + 1); c.lineTo(x, cy + 8); c.closePath(); c.fill();
    c.globalCompositeOperation = "destination-out";
    for (let k = 0; k < 17; k += 1) {
      const t = 0.16 + random() * 0.76, s = random() < 0.5 ? -1 : 1, px = x + w * t, depth = 0.25 + random() * 0.65, wide = 3 + random() * 9;
      const qe = Math.min(1, half(t + 0.03) / (0.5 * h)) + 0.05, qa = qe * (1 - depth);
      c.beginPath(); c.moveTo(px + w * 0.04 * qe - wide, cy + s * 0.5 * h * qe); c.lineTo(px + w * 0.04 * qe + wide, cy + s * 0.5 * h * qe); c.lineTo(px + w * 0.04 * qa, cy + s * 0.5 * h * qa); c.closePath(); c.fill();
    }
  });

  cell(CELLS.frond, (x, y, w, h) => {
    const cy = y + h / 2, count = 46, gap = (w * 0.89) / count;
    for (let k = 0; k < count; k += 1) {
      const t = 0.1 + (0.89 * (k + 0.5)) / count, long = h * 0.485 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.85), px = x + w * t, lean = 0.2 + 0.3 * t;
      for (const s of [-1, 1]) {
        const ex = px + long * lean, ey = cy + s * long, steps = Math.max(4, Math.round(long / 6)), wide = gap * 0.5;
        const lobe = (j: number) => wide * (1 - (j / steps) * 0.86) * (j % 2 ? 1 : 0.5);
        c.beginPath(); c.moveTo(px, cy);
        for (let j = 1; j <= steps; j += 1) c.lineTo(px + ((ex - px) * j) / steps - lobe(j), cy + ((ey - cy) * j) / steps);
        for (let j = steps; j >= 1; j -= 1) c.lineTo(px + ((ex - px) * j) / steps + lobe(j), cy + ((ey - cy) * j) / steps);
        c.closePath();
        c.fillStyle = green(56, 118, 42, 0.78 + random() * 0.44); c.fill();
        c.strokeStyle = "rgba(160,196,96,.45)"; c.lineWidth = 1; c.beginPath(); c.moveTo(px, cy); c.lineTo(ex, ey); c.stroke();
      }
    }
    c.fillStyle = "#6f5c2c"; c.beginPath(); c.moveTo(x, cy - 5); c.lineTo(x + w * 0.99, cy - 1); c.lineTo(x + w * 0.99, cy + 1); c.lineTo(x, cy + 5); c.closePath(); c.fill();
  });

  cell(CELLS.cycad, (x, y, w, h) => {
    const cy = y + h / 2, count = 62;
    for (let k = 0; k < count; k += 1) {
      const t = 0.08 + (0.9 * (k + 0.5)) / count, long = h * 0.56 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.6), px = x + w * t;
      for (const s of [-1, 1]) {
        const ex = px + long * 0.55, ey = cy + s * long * 0.84;
        c.beginPath(); c.moveTo(px - 3.4, cy); c.lineTo(px + 3.4, cy); c.lineTo(ex, ey); c.closePath();
        c.fillStyle = green(30, 82, 40, 0.75 + random() * 0.5); c.fill();
        c.strokeStyle = "rgba(120,170,96,.5)"; c.lineWidth = 0.9; c.beginPath(); c.moveTo(px + 2.4, cy); c.lineTo(ex, ey); c.stroke();
      }
    }
    c.fillStyle = "#7c8433"; c.beginPath(); c.moveTo(x, cy - 5); c.lineTo(x + w * 0.99, cy - 1); c.lineTo(x + w * 0.99, cy + 1); c.lineTo(x, cy + 5); c.closePath(); c.fill();
  });

  const heart = (lx: number, ly: number, size: number, turn: number, fill: string) => {
    c.save(); c.translate(lx, ly); c.rotate(turn);
    c.beginPath(); c.moveTo(0, 0); c.bezierCurveTo(-size * 0.2, -size * 0.75, size * 0.7, -size * 0.6, size, 0); c.bezierCurveTo(size * 0.7, size * 0.6, -size * 0.2, size * 0.75, 0, 0); c.closePath();
    c.fillStyle = fill; c.fill();
    c.strokeStyle = "rgba(190,214,130,.5)"; c.lineWidth = 1; c.beginPath(); c.moveTo(0, 0); c.lineTo(size * 0.9, 0); c.stroke();
    c.restore();
  };
  const strands = (x: number, y: number, w: number, h: number, count: number, leaf: number) => {
    for (let k = 0; k < count; k += 1) {
      const base = y + (h * (k + 0.5)) / count, long = w * (0.55 + random() * 0.45), swing = h / count * 0.3, phase = random() * 6;
      const at = (t: number): P2 => [x + long * t, base + Math.sin(t * 9 + phase) * swing * t];
      c.strokeStyle = "#4a5a2a"; c.lineWidth = 2.2; c.beginPath(); c.moveTo(x, base);
      for (let i = 1; i <= 40; i += 1) c.lineTo(...at(i / 40));
      c.stroke();
      const leaves = Math.round(long / (leaf * 0.85));
      for (let i = 0; i < leaves; i += 1) {
        const t = (i + 0.6) / leaves, [lx, ly] = at(t), s = i % 2 ? 1 : -1, size = leaf * (0.75 + random() * 0.5) * (1 - t * 0.3);
        heart(lx, ly, size, s * (0.9 + random() * 0.5), green(62, 124, 44, 0.7 + random() * 0.55));
      }
    }
  };
  cell(CELLS.vine, (x, y, w, h) => strands(x, y, w, h, 3, 21));
  cell(CELLS.curtain, (x, y, w, h) => strands(x, y, w, h, 8, 19));

  const veins = (ox: number, oy: number, tipX: number, spread: number, pairs: number, color: string, width: number) => {
    c.strokeStyle = color; c.lineCap = "round";
    c.lineWidth = width; c.beginPath(); c.moveTo(ox, oy); c.lineTo(tipX, oy); c.stroke();
    for (let k = 0; k < pairs; k += 1) {
      const t = k / pairs, px = ox + (tipX - ox) * t * 0.85;
      for (const s of [-1, 1]) {
        c.lineWidth = width * (0.75 - t * 0.4);
        c.beginPath(); c.moveTo(px, oy); c.quadraticCurveTo(px + (tipX - ox) * 0.1, oy + s * spread * 0.55, px + (tipX - ox) * (0.2 - t * 0.08), oy + s * spread * (1 - t * 0.6)); c.stroke();
      }
    }
  };
  cell(CELLS.alocasia, (x, y, w, h) => {
    const cy = y + h / 2, shape = () => {
      c.beginPath(); c.moveTo(x + w * 0.24, cy);
      c.quadraticCurveTo(x + w * 0.13, cy - h * 0.1, x + w * 0.03, cy - h * 0.27);
      c.bezierCurveTo(x + w * 0.12, cy - h * 0.52, x + w * 0.55, cy - h * 0.44, x + w * 0.985, cy);
      c.bezierCurveTo(x + w * 0.55, cy + h * 0.44, x + w * 0.12, cy + h * 0.52, x + w * 0.03, cy + h * 0.27);
      c.quadraticCurveTo(x + w * 0.13, cy + h * 0.1, x + w * 0.24, cy); c.closePath();
    };
    const g = c.createRadialGradient(x + w * 0.35, cy, 10, x + w * 0.45, cy, w * 0.6);
    g.addColorStop(0, "#2f6a34"); g.addColorStop(1, "#1f4c2a");
    shape(); c.fillStyle = g; c.fill();
    c.save(); shape(); c.clip();
    veins(x + w * 0.24, cy, x + w * 0.97, h * 0.42, 6, "rgba(176,206,150,.9)", 7);
    for (const s of [-1, 1]) { c.lineWidth = 5; c.beginPath(); c.moveTo(x + w * 0.24, cy); c.lineTo(x + w * 0.05, cy + s * h * 0.26); c.stroke(); }
    c.lineWidth = 6; c.strokeStyle = "rgba(120,160,90,.6)"; shape(); c.stroke();
    c.restore();
  });
  cell(CELLS.monstera, (x, y, w, h) => {
    const cy = y + h / 2, shape = () => {
      c.beginPath(); c.moveTo(x + w * 0.2, cy);
      c.bezierCurveTo(x + w * 0.02, cy - h * 0.2, x + w * 0.04, cy - h * 0.5, x + w * 0.4, cy - h * 0.48);
      c.bezierCurveTo(x + w * 0.72, cy - h * 0.46, x + w * 0.9, cy - h * 0.2, x + w * 0.985, cy);
      c.bezierCurveTo(x + w * 0.9, cy + h * 0.2, x + w * 0.72, cy + h * 0.46, x + w * 0.4, cy + h * 0.48);
      c.bezierCurveTo(x + w * 0.04, cy + h * 0.5, x + w * 0.02, cy + h * 0.2, x + w * 0.2, cy); c.closePath();
    };
    const g = c.createRadialGradient(x + w * 0.35, cy, 10, x + w * 0.45, cy, w * 0.62);
    g.addColorStop(0, "#3a7c38"); g.addColorStop(1, "#245a2c");
    shape(); c.fillStyle = g; c.fill();
    c.save(); shape(); c.clip();
    veins(x + w * 0.2, cy, x + w * 0.97, h * 0.46, 7, "rgba(170,204,120,.75)", 6);
    c.restore();
    c.globalCompositeOperation = "destination-out";
    for (let k = 0; k < 6; k += 1) for (const s of [-1, 1]) {
      const px = x + w * (0.3 + k * 0.1), tilt = s * (1.05 - k * 0.07);
      c.beginPath(); c.ellipse(px + w * 0.05, cy + s * h * (0.39 - k * 0.028), w * 0.019, h * (0.17 - k * 0.012), -tilt + (s > 0 ? Math.PI : 0) + HALF, 0, TAU); c.fill();
      if (k % 2 === 0) { c.beginPath(); c.ellipse(px + w * 0.02, cy + s * h * 0.1, w * 0.028, h * 0.03, 0.4 * s, 0, TAU); c.fill(); }
    }
  });
  cell(CELLS.caladium, (x, y, w, h) => {
    const cy = y + h / 2, shape = () => {
      c.beginPath(); c.moveTo(x + w * 0.22, cy);
      c.quadraticCurveTo(x + w * 0.12, cy - h * 0.12, x + w * 0.03, cy - h * 0.3);
      c.bezierCurveTo(x + w * 0.14, cy - h * 0.56, x + w * 0.55, cy - h * 0.46, x + w * 0.985, cy);
      c.bezierCurveTo(x + w * 0.55, cy + h * 0.46, x + w * 0.14, cy + h * 0.56, x + w * 0.03, cy + h * 0.3);
      c.quadraticCurveTo(x + w * 0.12, cy + h * 0.12, x + w * 0.22, cy); c.closePath();
    };
    shape(); c.fillStyle = "#3d7a36"; c.fill();
    c.save(); shape(); c.clip();
    const g = c.createRadialGradient(x + w * 0.4, cy, 4, x + w * 0.42, cy, w * 0.4);
    g.addColorStop(0, "rgba(226,86,128,.95)"); g.addColorStop(0.55, "rgba(206,70,110,.75)"); g.addColorStop(1, "rgba(200,70,110,0)");
    c.save(); c.translate(0, cy); c.scale(1, 0.62); c.translate(0, -cy); c.fillStyle = g; c.fillRect(x, y - h, w, h * 3); c.restore();
    veins(x + w * 0.22, cy, x + w * 0.97, h * 0.42, 6, "rgba(150,26,60,.85)", 4);
    speckle(c, w, h, 0, random, () => "#fff");
    for (let i = 0; i < 60; i += 1) { c.fillStyle = "rgba(240,220,226,.55)"; c.beginPath(); c.arc(x + w * (0.15 + random() * 0.75), cy + (random() - 0.5) * h * 0.8, 1 + random() * 3, 0, TAU); c.fill(); }
    c.restore();
  });
  cell(CELLS.strap, (x, y, w, h) => {
    const cy = y + h / 2, half = (t: number) => h * 0.4 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.42)), 0.55);
    const shape = (scale: number) => {
      c.beginPath(); c.moveTo(x, cy);
      for (let i = 0; i <= 48; i += 1) c.lineTo(x + (w * 0.99 * i) / 48, cy - half(i / 48) * scale);
      for (let i = 48; i >= 0; i -= 1) c.lineTo(x + (w * 0.99 * i) / 48, cy + half(i / 48) * scale);
      c.closePath();
    };
    shape(1); c.fillStyle = "#467f33"; c.fill();
    shape(0.42); c.fillStyle = "#c9d68e"; c.fill();
    c.save(); shape(1); c.clip();
    for (let i = 0; i < 9; i += 1) { c.strokeStyle = "rgba(30,70,26,.3)"; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y + (h * (i + 0.5)) / 9); c.lineTo(x + w, y + (h * (i + 0.5)) / 9); c.stroke(); }
    c.restore();
  });
  cell(CELLS.lily, (x, y, w, h) => {
    const cx = x + w / 2, cy = y + h / 2, r = w * 0.47;
    const g = c.createRadialGradient(cx, cy, 4, cx, cy, r);
    g.addColorStop(0, "#5f9440"); g.addColorStop(0.85, "#3f7a34"); g.addColorStop(1, "#7a6a3a");
    c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, 0.16, TAU - 0.16); c.closePath(); c.fillStyle = g; c.fill();
    c.strokeStyle = "rgba(180,210,130,.5)"; c.lineWidth = 1.6;
    for (let k = 1; k < 16; k += 1) { const a = 0.16 + ((TAU - 0.32) * k) / 16; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94); c.stroke(); }
  });
  cell(CELLS.flower, (x, y, w, h) => {
    const cx = x + w / 2, cy = y + h / 2;
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * TAU + 0.3;
      c.save(); c.translate(cx, cy); c.rotate(a);
      const g = c.createLinearGradient(0, 0, w * 0.46, 0);
      g.addColorStop(0, "#f2b23a"); g.addColorStop(0.35, "#e2502a"); g.addColorStop(1, "#c3261f");
      c.fillStyle = g; c.beginPath(); c.ellipse(w * 0.25, 0, w * 0.22, h * 0.13, 0, 0, TAU); c.fill();
      c.strokeStyle = "rgba(120,20,16,.5)"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(w * 0.06, 0); c.lineTo(w * 0.44, 0); c.stroke();
      c.restore();
    }
    c.fillStyle = "#f6d24a"; c.beginPath(); c.arc(cx, cy, w * 0.07, 0, TAU); c.fill();
  });

  // Transparent texels take a leaf green, so that no dark fringe is filtered in round a cut-out.
  const image = c.getImageData(0, 0, LEAF_W, LEAF_H), data = new Uint8Array(image.data.buffer.slice(0));
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] < 6) { data[i] = 58; data[i + 1] = 104; data[i + 2] = 44; data[i + 3] = 0; }
  canvas.width = canvas.height = 0;
  const small = shrinkRgba(data, LEAF_W, LEAF_H);
  const texture = new THREE.DataTexture(small.data, small.width, small.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// ---- Leaves grown as strips ----------------------------------------------------------------------

/** Geometry of leaves gathered for one mesh: position, normal, uv, tint and (weight, phase) for the wind. */
type Sink = { p: number[]; n: number[]; u: number[]; c: number[]; s: number[]; i: number[] };
const sink = (): Sink => ({ p: [], n: [], u: [], c: [], s: [], i: [] });
type Blade = { droop?: number; fold?: number; twist?: number; segs?: number; tint?: V3; phase?: number; stiff?: number; turn?: number };

/**
 * One leaf: a strip three vertices wide that leaves `base` at `yaw` and `pitch`, bends over by `droop`
 * radians along its length and is folded along its midrib. The cell of the leaf sheet gives it its outline.
 */
function blade(out: Sink, cell: Rect, base: V3, yaw: number, pitch: number, length: number, width: number, o: Blade = {}) {
  const [u0, v0, u1, v1] = rectOf(cell), segs = o.segs ?? 7, droop = o.droop ?? 1, fold = o.fold ?? 0.15, tint = o.tint ?? [1, 1, 1], phase = o.phase ?? 0, stiff = o.stiff ?? 0;
  const first = out.p.length / 3, step = length / segs;
  let x = base[0], y = base[1], z = base[2], heading = yaw;
  for (let i = 0; i <= segs; i += 1) {
    const s = i / segs, angle = pitch - droop * Math.pow(s, 1.4), hx = Math.cos(heading), hz = Math.sin(heading), cp = Math.cos(angle), sp = Math.sin(angle);
    const roll = (o.twist ?? 0) * s, upX = -hx * sp, upY = cp, upZ = -hz * sp;
    // Across the leaf, rolled about its length, and the face it shows.
    const sx = -hz * Math.cos(roll) + upX * Math.sin(roll), sy = upY * Math.sin(roll), sz = hx * Math.cos(roll) + upZ * Math.sin(roll);
    const nx = upX * Math.cos(roll) + hz * Math.sin(roll), ny = upY * Math.cos(roll), nz = upZ * Math.cos(roll) - hx * Math.sin(roll);
    const hw = width / 2, cf = Math.cos(fold), sf = Math.sin(fold), shade = 0.72 + 0.28 * s, weight = s * s * (1 - stiff);
    for (let k = -1; k <= 1; k += 1) {
      const lift = Math.abs(k) * hw * sf;
      out.p.push(x + sx * k * hw * cf + nx * lift, y + sy * k * hw * cf + ny * lift, z + sz * k * hw * cf + nz * lift);
      const tx = nx * cf - sx * k * sf, ty = ny * cf - sy * k * sf, tz = nz * cf - sz * k * sf;
      out.n.push(tx, ty, tz);
      out.u.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * (k + 1) / 2);
      out.c.push(tint[0] * shade, tint[1] * shade, tint[2] * shade);
      out.s.push(weight, phase);
    }
    if (i < segs) {
      const mid = pitch - droop * Math.pow((i + 0.5) / segs, 1.4);
      x += Math.cos(heading) * Math.cos(mid) * step; y += Math.sin(mid) * step; z += Math.sin(heading) * Math.cos(mid) * step;
      heading += (o.turn ?? 0) / segs;
    }
  }
  for (let i = 0; i < segs; i += 1) for (let k = 0; k < 2; k += 1) {
    const a = first + i * 3 + k, b = a + 3;
    out.i.push(a, a + 1, b, a + 1, b + 1, b);
  }
}

export function buildGlasshouse(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, track, photoSet, wall } = kit;
  const metals = kit.metals();
  const random = rng(1871);
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.5, ...parameters });
  const painted = (texture: THREE.Texture) => { track(texture).anisotropy = anisotropy; return texture; };

  // ---- Materials -----------------------------------------------------------
  const brickSet = wall("whitewashed", 1.15);
  const plasterSet = wall("limewash");
  const rustSet = photoSet("/textures/rusty_metal_02-2k", 1, 1, false);
  const brick = standard({ ...brickSet, color: 0xd6c4b2, normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.4 });
  const stone = standard({ ...plasterSet, color: 0xcbbfa6, envMapIntensity: 0.45 });
  const ironMap = painted(ironPaintTexture());
  const iron = standard({ map: ironMap, color: 0xe6e9e0, roughness: 0.55, envMapIntensity: 0.6 });
  const darkIron = standard({ ...rustSet, color: 0x4a4744, metalness: 0.55, roughness: 0.85, envMapIntensity: 0.7 });
  const soil = standard({ map: painted(soilTexture()), color: 0xb8a898, envMapIntensity: 0.25 });
  const stemMap = painted(stemTexture());
  const stem = standard({ map: stemMap, roughness: 0.8, envMapIntensity: 0.35 });
  const wood = standard({ ...photoSet("/textures/weathered_brown_planks-2k", 1, 1, false), color: 0xc9b79c, envMapIntensity: 0.3 });
  const greenIron = standard({ ...photoSet("/textures/green_metal_rust-2k", 1, 1, false), color: 0xa6b8a2, envMapIntensity: 0.6 });
  const terracotta = standard({ color: 0xb9683f, normalMap: plasterSet.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.9, envMapIntensity: 0.3 });
  const brass = standard({ color: 0xc09a4a, metalness: 0.92, roughness: 0.4, envMapIntensity: 1.1 });
  const redPaint = standard({ color: 0x9a2b1c, roughness: 0.5, envMapIntensity: 0.5 });
  const grille = standard({ map: painted(grilleTexture()), color: 0xd6d2c6, metalness: 0.15, roughness: 0.6, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const signs = standard({ map: painted(signSheet()), roughness: 0.3, envMapIntensity: 0.7 });
  const zinc = metals.brushed;

  // Glass: nearly clear, grimed along the bars, and more of a mirror the more it is seen edge on.
  // It writes no depth and casts no shadow: the light that comes through it is the whole look.
  const glassMap = painted(glassTexture(!high));
  const glass = new THREE.MeshStandardMaterial({ map: glassMap, color: 0xd6ece2, emissive: 0x9db3a4, emissiveIntensity: 0.45, transparent: true, roughness: 0.06, metalness: 0, envMapIntensity: 1.3, side: THREE.DoubleSide, depthWrite: false });
  glass.forceSinglePass = true;
  glass.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", /* glsl */`#include <emissivemap_fragment>
      float glassEdge = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 3.0);
      totalEmissiveRadiance *= diffuseColor.a * 2.0;
      diffuseColor.a = mix(diffuseColor.a, 0.5, glassEdge * 0.55);`);
  };
  glass.customProgramCacheKey = () => "glasshouse-glass";

  // ---- Batching: one mesh per material and class ---------------------------------
  // `detail` parts are left out on PERFORMANCE and out of the floor mirror; `mirror: false` only out of the mirror.
  type Opt = { shadow?: boolean; hit?: boolean; detail?: boolean; mirror?: boolean; walk?: boolean };
  type Batch = { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] };
  type Add = (material: THREE.Material, geometry: THREE.BufferGeometry, at?: V3, rot?: V3, scale?: V3 | number, opt?: Opt) => void;
  const batches = new Map<string, Batch>();
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4 | null, o: Opt) => {
    if (o.detail && !high) return;
    const opt = { shadow: o.shadow ?? false, hit: o.hit ?? false, detail: false, mirror: o.mirror ?? !o.detail, walk: o.walk ?? false };
    const key = `${material.uuid}|${+opt.shadow}${+opt.hit}${+opt.mirror}${+opt.walk}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { material, opt, parts: [] });
    const part = new THREE.BufferGeometry(), count = geometry.attributes.position.count;
    part.setAttribute("position", geometry.attributes.position.clone());
    part.setAttribute("normal", geometry.attributes.normal.clone());
    part.setAttribute("uv", geometry.attributes.uv ? geometry.attributes.uv.clone() : new THREE.Float32BufferAttribute(count * 2, 2));
    part.setIndex(geometry.index ? geometry.index.clone() : Array.from({ length: count }, (_, i) => i));
    if (matrix) part.applyMatrix4(matrix);
    batch.parts.push(part);
  };
  const maker = (base: Opt, parent?: THREE.Matrix4): Add => (material, geometry, at, rot, scale, opt) => {
    const local = at || rot || scale !== undefined ? mat4(at, rot, scale) : null;
    put(geometry, material, parent ? (local ? parent.clone().multiply(local) : parent) : local, { ...base, ...opt });
  };
  /** Masonry: casts, stops bullets. */
  const solid = maker({ shadow: true, hit: true });
  /** Ironwork and anything else that prints a shadow. */
  const cast = maker({ shadow: true });
  const plain = maker({});
  /** Small things: HIGH only, not in the mirror. */
  const fine = maker({ detail: true });
  /** Frame on a range wall: origin on its face at z, local x along the wall, local z into the nave. */
  const onWall = (side: number, z: number, base: Opt = { shadow: true }, inset = 0, y = 0) => maker(base, mat4([side * (WALL + inset), y, z], [0, -side * HALF, 0]));
  const flush = () => {
    for (const batch of batches.values()) {
      const merged = mergeGeometries(batch.parts);
      batch.parts.forEach((part) => part.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.castShadow = batch.opt.shadow && !batch.material.transparent;
      mesh.receiveShadow = !batch.material.transparent;
      if (batch.opt.walk || batch.material.transparent) mesh.userData.walkThrough = true;
      scene.add(mesh);
      if (batch.opt.hit) kit.shootable.push(mesh);
      if (!batch.opt.mirror) kit.mirrorHidden.push(mesh);
    }
    batches.clear();
  };

  // ---- Wind, trees and what lives here ----------------------------------------
  // The air of a closed house: a slow draught from the open ventilators, enough to stir a frond.
  const wind = createWind({ heading: 0.9, strength: 0.16, gustiness: 0.6 });
  const trees = createTrees(kit, { seed: 11, wind, sun: () => sun });
  // The misters are worked by a timer; the hiss of each opening tells the map when one has begun.
  const MIST_SECONDS = 8, mistOpened = MISTERS.map(() => -1e9);
  let clock = 0;
  const cue: NonNullable<RangeOptions["cue"]> = (name, at, o) => {
    options.cue?.(name, at, o);
    if (name !== "steamHiss" || !at) return;
    MISTERS.forEach(([x, , z], index) => {
      if (Math.abs(at.x - x) + Math.abs(at.z - z) > 1) return;
      mistOpened[index] = clock;
      options.cue?.("valveClunk", at, { gain: 0.5, pitch: 1.15 });
    });
  };
  const life = createLife(kit, { ...options, cue }, { wind, seed: 7 });

  // ---- Ground --------------------------------------------------------------
  const floorWidth = AISLE_X * 2 + 0.6;
  const ground = standard({ ...photoSet("/textures/tiled_floor_001-2k", floorWidth / 1.6, (NAVE_LEN + 0.6) / 1.6, false), color: new THREE.Color(1.5, 1.34, 1.16), envMapIntensity: 0.45 });
  const reflection = kit.floor(ground, { width: floorWidth, depth: NAVE_LEN + 0.6, z: NAVE_MID }, {
    lane: new THREE.Color(0.86, 0.84, 0.74),
    edge: new THREE.Color(0.8, 0.62, 0.26),
    markings: 0.55,
    wet: 0.07,
  });
  // Unglazed quarry tiles: matt where they are dry, so the mirror shows in the wet patches and nowhere else.
  const wetFloor = ground.onBeforeCompile;
  ground.onBeforeCompile = (shader, renderer) => {
    wetFloor.call(ground, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = 0.52 + 0.48 * roughnessFactor;");
  };
  ground.customProgramCacheKey = () => "glasshouse-floor";
  // The garden outside: raked sand to the hills.
  const sand = standard({ color: 0xc9a777, envMapIntensity: 0.3 });
  kit.place(new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-HALF), sand), 0, -0.04, NAVE_MID, false);

  // ---- Range walls -----------------------------------------------------------
  // Flat brick to 4.5 m (the range signs hang on it), pierced by round-headed windows where none hangs.
  for (const side of [-1, 1]) {
    const holes = OPENINGS[side].map((z) => ({ x: z - NAVE_MID, width: OPENING.width, spring: OPENING.spring, sill: OPENING.sill }));
    if (side > 0) holes.push({ x: NICHE.z - NAVE_MID, width: NICHE.width, spring: NICHE.spring, sill: NICHE.sill });
    solid(brick, archedWall(NAVE_LEN, WALL_TOP, WALL_T, holes, 1.15), [side * COL_X, 0, NAVE_MID], [0, -HALF, 0]);
    solid(stone, worldBox(0.06, 0.45, NAVE_LEN, 1.6), [side * (WALL - 0.02), 0.225, NAVE_MID]);
    solid(stone, softBox(0.1, 0.16, NAVE_LEN, 0.02, 1.6), [side * (WALL - 0.02), 4.26, NAVE_MID]);
    solid(stone, worldBox(0.84, 0.2, NAVE_LEN, 1.6), [side * COL_X, 4.52, NAVE_MID]);
    for (const z of OPENINGS[side]) {
      const face = onWall(side, z, { shadow: false }), frame = onWall(side, z, { shadow: true }, 0.4);
      // Stone arch ring and sill; the ring lies flush, so that whatever is fixed beside it sits on a flat wall.
      face(stone, projectUv(new THREE.RingGeometry(OPENING.width / 2, OPENING.width / 2 + 0.22, 24, 1, 0, Math.PI), 1.6), [0, OPENING.spring, 0.004]);
      face(stone, softBox(0.2, 0.36, 0.05, 0.012, 1.6), [0, OPENING.spring + OPENING.width / 2 + 0.11, 0.02]);
      solid(stone, softBox(0.74, 0.09, OPENING.width + 0.24, 0.015, 1.6), [side * (COL_X - 0.02), OPENING.sill - 0.035, z]);
      // The iron window: a frame, two mullions, a transom at the springing and a fan in the head.
      const r = OPENING.width / 2 - 0.035, y0 = OPENING.sill + 0.03;
      frame(iron, bar2d([[-r, y0], [-r, OPENING.spring], ...arc(0, OPENING.spring, r, -HALF, HALF, 16).slice(1, -1), [r, OPENING.spring], [r, y0]], 0.07, 0.07));
      frame(iron, box(OPENING.width, 0.07, 0.07), [0, y0 + 0.02, 0]);
      frame(iron, box(OPENING.width - 0.1, 0.05, 0.05), [0, OPENING.spring, 0]);
      for (const x of [-0.33, 0.33]) frame(iron, box(0.045, OPENING.spring - y0, 0.05), [x, (OPENING.spring + y0) / 2, 0]);
      frame(iron, box(OPENING.width - 0.1, 0.035, 0.04), [0, 1.9, 0]);
      frame(iron, bar2d(arc(0, OPENING.spring, 0.36, -HALF, HALF, 10), 0.04, 0.045));
      for (const a of [-1.05, -0.52, 0, 0.52, 1.05]) frame(iron, box(0.04, r - 0.36, 0.045), [Math.sin(a) * (r + 0.36) / 2, OPENING.spring + Math.cos(a) * (r + 0.36) / 2, 0], [0, 0, -a]);
      const pane = new THREE.Shape();
      pane.moveTo(-r, y0); pane.lineTo(-r, OPENING.spring); pane.absarc(0, OPENING.spring, r, Math.PI, 0, true); pane.lineTo(r, y0); pane.closePath();
      frame(glass, scaleUv(new THREE.ShapeGeometry(pane, 10), 1 / 0.66, 1 / 1.4), [0, 0, -0.01]);
    }
  }

  // ---- Back wall: a brick gable with the chart on it, a glazed lunette above -----------
  solid(brick, worldBox(COL_X * 2 + WALL_T, 8.6, 0.6, 1.15), [0, 4.3, Z_BACK]);
  solid(stone, worldBox(COL_X * 2 + 0.9, 0.2, 0.84, 1.6), [0, 8.7, Z_BACK - 0.04]);
  solid(stone, worldBox(COL_X * 2 + WALL_T, 0.45, 0.06, 1.6), [0, 0.225, Z_BACK - 0.32]);
  for (const x of [-9.12, -6.95, 6.95, 9.12]) {
    solid(brick, worldBox(0.72, 8.4, 0.09, 1.15), [x, 4.2, Z_BACK - 0.34]);
    solid(stone, softBox(0.86, 0.14, 0.16, 0.02, 1.6), [x, 8.43, Z_BACK - 0.36]);
    solid(stone, softBox(0.84, 0.5, 0.15, 0.015, 1.6), [x, 0.25, Z_BACK - 0.36]);
  }
  for (const side of [-1, 1]) solid(brick, worldBox(AISLE_A + 0.3, EAVE, 0.4, 1.15), [side * (COL_X + WALL_T / 2 + AISLE_A / 2 + 0.05), EAVE / 2, Z_BACK + 0.1]);

  /** The glazed segment under the end of the vault: a sunburst of bars over a chord beam. */
  const lunette = (z: number) => {
    const add = maker({ shadow: true }, mat4([0, 0, z])), drop = SPRING - VCY, reach = VR - 0.12;
    add(iron, box(COL_X * 2 - 0.1, 0.14, 0.12), [0, SPRING + 0.07, 0]);
    add(iron, bar2d(arc(0, SPRING + 0.1, 1.3, -HALF, HALF, 16), 0.07, 0.08));
    const inner = VR - 1.7, innerHalf = Math.acos(drop / inner);
    add(iron, bar2d(arc(0, VCY, inner, -innerHalf, innerHalf, 28), 0.06, 0.07));
    for (let k = -5; k <= 5; k += 1) {
      const a = (k * Math.PI) / 12.6, c = Math.cos(a), far = -drop * c + Math.sqrt(drop * drop * c * c - drop * drop + reach * reach), mid = (1.3 + far) / 2;
      add(iron, box(0.05, far - 1.3, 0.06), [Math.sin(a) * mid, SPRING + 0.1 + c * mid, 0], [0, 0, -a]);
    }
    const pane = new THREE.Shape(), edge = arc(0, VCY, VR, -VA, VA, 32);
    pane.moveTo(edge[0][0], edge[0][1]);
    edge.slice(1).forEach(([x, y]) => pane.lineTo(x, y));
    pane.closePath();
    add(glass, scaleUv(new THREE.ShapeGeometry(pane), 1 / 0.9, 1 / 1.4));
  };
  lunette(Z_BACK);
  lunette(Z_END);

  // ---- The iron frame of the nave -----------------------------------------------
  const columnShaft = lathe([[0.13, 0.34], [0.13, 0.38], [0.105, 0.42], [0.115, 0.46], [0.09, 0.5], [0.085, 1.2], [0.096, 1.22], [0.096, 1.26], [0.083, 1.28], [0.072, 2.18], [0.086, 2.2], [0.086, 2.24], [0.07, 2.26], [0.076, 2.3], [0.14, 2.44], [0.15, 2.47]], high ? 10 : 7);
  const spandrelRing = ring2d(0.15, 0.035, 0.04, 12);
  for (const side of [-1, 1]) {
    cast(iron, worldBox(0.22, 0.26, NAVE_LEN, 1.2), [side * COL_X, DECK, NAVE_MID]);
    cast(iron, worldBox(0.3, 0.3, NAVE_LEN, 1.2), [side * COL_X, SPRING, NAVE_MID]);
    plain(iron, worldBox(0.4, 0.05, NAVE_LEN, 1.2), [side * COL_X, SPRING + 0.17, NAVE_MID]);
    for (const z of LINES) {
      if (z >= Z_BACK || z <= Z_END) continue;
      const at = onWall(side, z, { shadow: true }, WALL_T / 2);
      at(iron, softBox(0.34, 0.34, 0.34, 0.02, 1.2), [0, WALL_TOP + 0.29, 0]);
      at(iron, columnShaft, [0, WALL_TOP + 0.12, 0]);
      at(iron, box(0.32, 0.06, 0.32), [0, DECK - 0.1, 0]);
      at(iron, box(0.11, SPRING - DECK - 0.28, 0.11), [0, (SPRING + DECK) / 2 - 0.01, 0]);
      // Arcade brackets under the gallery beam, each with a ring in its spandrel.
      for (const dir of [-1, 1]) {
        at(iron, bar2d(arc(dir * 0.9, DECK - 0.95, 0.82, -dir * HALF, 0, 8), 0.045, 0.05));
        at(iron, spandrelRing, [dir * 0.21, DECK - 0.27, 0]);
      }
      // The cantilever that carries the gallery, in the plane of the rib.
      const inward = maker({ shadow: true }, mat4([side * (COL_X - 0.09), 0, z], [0, side > 0 ? Math.PI : 0, 0]));
      inward(iron, bar2d(arc(0.75, DECK - 0.67, 0.75, -HALF, 0, 8), 0.045, 0.05));
      inward(iron, spandrelRing, [0.2, DECK - 0.05, 0], undefined, 0.9);
      inward(iron, box(0.86, 0.06, 0.07), [0.42, DECK + 0.11, 0]);
    }
    // Clerestory: three round-headed lights to a bay.
    const head = bar2d(arc(0, 0, 0.46, -HALF, HALF, high ? 10 : 6), 0.04, 0.05);
    for (let b = 0; b < LINES.length - 1; b += 1) {
      const at = onWall(side, LINES[b] - BAY / 2, { shadow: true }, WALL_T / 2);
      for (const x of [-0.5, 0.5]) at(iron, box(0.04, 0.95, 0.05), [x, DECK + 0.6, 0]);
      for (const x of [-1, 0, 1]) at(iron, head, [x, DECK + 0.94, 0]);
    }
    plain(glass, scaleUv(new THREE.PlaneGeometry(NAVE_LEN, SPRING - DECK).rotateY(HALF), NAVE_LEN / 0.5, 1), [side * (COL_X + 0.02), (SPRING + DECK) / 2, NAVE_MID]);

    // Gallery: five flat bars for a deck (their shadow is a ladder, not a slab), and a light rail.
    for (let k = 0; k < 5; k += 1) cast(iron, worldBox(0.07, 0.03, NAVE_LEN - 0.6, 1.2), [side * (COL_X - 0.2 - k * 0.165), DECK + 0.155, NAVE_MID]);
    const railX = side * (COL_X - 0.88);
    cast(iron, cyl(0.024, NAVE_LEN - 0.9, "z", 6), [railX, DECK + 1.18, NAVE_MID]);
    for (const y of [0.52, 0.85]) cast(iron, cyl(0.013, NAVE_LEN - 0.9, "z", 5), [railX, DECK + y, NAVE_MID]);
    for (let z = Z_BACK - 1; z > Z_END + 0.5; z -= BAY / 2) cast(iron, cyl(0.02, 1.04, "y", 6), [railX, DECK + 0.67, z]);
  }
  // The gallery crosses under both lunettes: hung from the chord beam at the back, on the gable frame at the far end.
  for (const [z, inward] of [[Z_BACK - 0.34, -1], [Z_END + 0.1, 1]] as P2[]) {
    for (let k = 0; k < 5; k += 1) cast(iron, worldBox(COL_X * 2 - 0.3, 0.03, 0.07, 1.2), [0, DECK + 0.155, z + inward * (0.06 + k * 0.165)]);
    const rail = z + inward * 0.8;
    cast(iron, cyl(0.024, COL_X * 2 - 1.7, "x", 6), [0, DECK + 1.18, rail]);
    for (const y of [0.52, 0.85]) cast(iron, cyl(0.013, COL_X * 2 - 1.7, "x", 5), [0, DECK + y, rail]);
    for (let x = -7.5; x <= 7.5; x += 1.5) {
      cast(iron, cyl(0.02, 1.04, "y", 6), [x, DECK + 0.67, rail]);
      cast(iron, cyl(0.012, SPRING - DECK - 0.1, "y", 5), [x, (SPRING + DECK) / 2 + 0.1, z + inward * 0.74]);
    }
  }

  // ---- The vault -------------------------------------------------------------
  // Arch ribs on the column lines, a lighter rib between, purlins, and glazing bars every half metre.
  // All of it is in the sun's map: this is what prints the lattice.
  const ribLine = arc(0, VCY, VR - 0.13, -VA, VA, high ? 40 : 24);
  const mainRib = bar2d(ribLine, 0.26, 0.11), lightRib = bar2d(arc(0, VCY, VR - 0.07, -VA, VA, high ? 40 : 24), 0.13, 0.07);
  const glazingBar = bar2d(arc(0, VCY, VR - 0.03, -VA, VA, 30), 0.05, 0.045);
  LINES.forEach((z, index) => {
    cast(iron, mainRib, [0, 0, z]);
    if (index === LINES.length - 1) return;
    cast(iron, lightRib, [0, 0, z - BAY / 2]);
    for (const dz of [0.5, 1, 2, 2.5]) cast(iron, glazingBar, [0, 0, z - dz], undefined, undefined, { detail: true, mirror: true });
  });
  for (let k = -7; k <= 7; k += 1) {
    const a = (k / 8) * VA, r = VR - 0.1;
    cast(iron, worldBox(k === 0 ? 0.16 : 0.09, 0.08, NAVE_LEN, 1.2), [r * Math.sin(a), VCY + r * Math.cos(a), NAVE_MID], [0, 0, -a]);
  }
  plain(glass, sheet2d(arc(0, VCY, VR + 0.01, -VA, VA, 36), Z_END, Z_BACK + 0.3, [0.5, 1.4]));
  // Cresting along the ridge, outside the glass.
  {
    const finial = new THREE.ConeGeometry(0.035, 0.3, 4);
    for (let z = Z_BACK; z >= Z_END; z -= 0.5) plain(iron, finial, [0, APEX + 0.17, z], undefined, undefined, { detail: true });
    plain(iron, box(0.05, 0.05, NAVE_LEN), [0, APEX + 0.04, NAVE_MID]);
  }
  // Tie rods across every second rib, with a hanger either side.
  LINES.forEach((z, index) => {
    if (index % 2 === 0 || z <= Z_END) return;
    cast(iron, cyl(0.016, COL_X * 2 - 0.3, "x", 5), [0, SPRING + 0.05, z]);
    plain(iron, new THREE.SphereGeometry(0.06, 8, 6), [0, SPRING + 0.05, z]);
    for (const x of [-4.2, 4.2]) cast(iron, cyl(0.011, vaultY(x, 0.2) - SPRING, "y", 4), [x, (vaultY(x, 0.2) + SPRING) / 2 + 0.02, z]);
  });

  // ---- Aisles ------------------------------------------------------------------
  // A quadrant of glass from the gallery beam down to a low glazed wall.
  for (const side of [-1, 1]) {
    const curve = (inset: number, steps: number): P2[] => Array.from({ length: steps + 1 }, (_, i) => { const t = (HALF * i) / steps; return [side * (COL_X + (AISLE_A - inset) * Math.sin(t)), EAVE + (AISLE_B - inset) * Math.cos(t)] as P2; });
    const rib = bar2d(curve(0.08, high ? 16 : 10), 0.16, 0.08), bar = bar2d(curve(0.03, 12), 0.05, 0.045);
    LINES.forEach((z, index) => {
      cast(iron, rib, [0, 0, z]);
      if (index === LINES.length - 1) return;
      for (const dz of [1, 2]) cast(iron, bar, [0, 0, z - dz], undefined, undefined, { detail: true });
    });
    for (const t of [0.32, 0.64, 0.96, 1.28]) cast(iron, cyl(0.035, NAVE_LEN, "z", 6), [side * (COL_X + (AISLE_A - 0.06) * Math.sin(t)), EAVE + (AISLE_B - 0.06) * Math.cos(t), NAVE_MID]);
    plain(glass, sheet2d(curve(-0.01, 14), Z_END, Z_BACK + 0.3, [1, 1.4]));
    // Outer wall: a brick dwarf wall, iron posts and glass to the eave.
    const x = side * AISLE_X;
    solid(brick, worldBox(0.3, 0.9, NAVE_LEN, 1.15), [x, 0.45, NAVE_MID]);
    plain(stone, worldBox(0.38, 0.07, NAVE_LEN, 1.6), [x, 0.93, NAVE_MID]);
    cast(iron, worldBox(0.14, 0.14, NAVE_LEN, 1.2), [x, EAVE, NAVE_MID]);
    cast(iron, worldBox(0.05, 0.05, NAVE_LEN, 1.2), [x, 2.55, NAVE_MID]);
    for (const z of LINES) cast(iron, box(0.1, EAVE - 0.9, 0.1), [x, (EAVE + 0.9) / 2, z]);
    for (let z = Z_BACK - 1; z > Z_END; z -= 1) if (Math.abs((Z_BACK - z) % BAY) > 0.01) cast(iron, box(0.04, EAVE - 0.9, 0.04), [x, (EAVE + 0.9) / 2, z], undefined, undefined, { detail: true });
    plain(glass, scaleUv(new THREE.PlaneGeometry(NAVE_LEN, EAVE - 0.95).rotateY(HALF), NAVE_LEN, 1), [x, (EAVE + 0.95) / 2, NAVE_MID]);
    // Glazed ends: uprights to the curve, and the pane itself.
    for (const z of [Z_BACK + 0.1, Z_END]) {
      const end = maker({ shadow: true }, mat4([0, 0, z]));
      const pane = new THREE.Shape(), edge = curve(0, 14), low = z > 0 ? EAVE : 0.95;
      pane.moveTo(side * COL_X, low);
      edge.forEach(([px, py]) => pane.lineTo(px, py));
      if (z < 0) pane.lineTo(side * AISLE_X, low);
      pane.closePath();
      end(glass, scaleUv(new THREE.ShapeGeometry(pane), 1 / 0.9, 1 / 1.4));
      for (let k = 1; k < 6; k += 1) { const px = side * (COL_X + k * 1.22); end(iron, box(0.05, aisleY(px) - low, 0.05), [px, (aisleY(px) + low) / 2, 0]); }
      if (z < 0) {
        solid(brick, worldBox(AISLE_A + 0.3, 0.9, 0.3, 1.15), [side * (COL_X + AISLE_A / 2), 0.45, z]);
        end(iron, box(AISLE_A, 0.05, 0.05), [side * (COL_X + AISLE_A / 2), EAVE, 0]);
      }
    }
  }
  // The far gable below the lunette: a dwarf wall, mullions and transoms.
  {
    const end = maker({ shadow: true }, mat4([0, 0, Z_END]));
    solid(brick, worldBox(COL_X * 2, 0.9, 0.3, 1.15), [0, 0.45, Z_END]);
    for (let k = -8; k <= 8; k += 1) end(iron, box(k % 4 === 0 ? 0.1 : 0.06, SPRING - 0.9, 0.08), [k * 1.23, (SPRING + 0.9) / 2, 0]);
    for (const y of [EAVE, 5.3, DECK]) end(iron, box(COL_X * 2, 0.06, 0.06), [0, y, 0]);
    end(glass, scaleUv(new THREE.PlaneGeometry(COL_X * 2, SPRING - 0.9), COL_X * 2 / 0.62, (SPRING - 0.9) / 1.4), [0, (SPRING + 0.9) / 2, 0]);
  }

  // ---- Leaves of our own ---------------------------------------------------------
  const leafMap = track(leafSheet());
  leafMap.anisotropy = anisotropy;
  const leafMaterial = new THREE.MeshStandardMaterial({ map: leafMap, vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.4, alphaToCoverage: high, roughness: 0.5, metalness: 0, envMapIntensity: 0.55 });
  leafMaterial.onBeforeCompile = (shader) => {
    applyWind(shader, wind);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 sway;")
      .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
        {
          // Big leaves nod on their stalks and shiver at the tip; the draught only makes them do it more.
          float gust = windAt(position.xz) * 2.2;
          float nod = sin(windTime * (0.7 + sway.y * 0.5) + sway.y * 41.0), shiver = sin(windTime * 4.7 + sway.y * 73.0 + position.y * 2.0);
          vec2 push = windVector / max(length(windVector), 0.0001);
          transformed.xz += push * sway.x * (0.03 + gust * 0.22) * (0.6 + 0.4 * nod);
          transformed.y += sway.x * (nod * (0.025 + gust * 0.07) + shiver * gust * 0.02);
        }`);
    // A leaf seen against the light is lit through: its back takes the sun as its face does, yellower.
    shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
      {
        vec3 toSun = normalize((viewMatrix * vec4(${TO_SUN.x.toFixed(4)}, ${TO_SUN.y.toFixed(4)}, ${TO_SUN.z.toFixed(4)}, 0.0)).xyz);
        float facing = dot(normal, toSun);
        if (facing < 0.0) {
          normal = normalize(normal - 1.7 * facing * toSun);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.3, 1.22, 0.5), clamp(-facing * 1.5, 0.0, 1.0) * 0.75);
        }
      }`);
  };
  leafMaterial.customProgramCacheKey = () => "glasshouse-leaf";
  /** Leaves near the player (drawn in the mirror), in the aisles, and beyond the far end. */
  const leaves = { near: sink(), aisle: sink() };
  const growing = maker({ shadow: true });
  const TRUNK: Rect = [0, 0, 0.5, 1], SHEATH: Rect = [0.5, 0, 1, 1];
  /** Upright stem lathe with its uv squeezed into one half of the stem sheet. */
  const stemOf = (r0: number, r1: number, height: number, cell: Rect, sides = 8) => {
    const geometry = new THREE.CylinderGeometry(r1, r0, height, sides, 3).translate(0, height / 2, 0), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, cell[0] + (cell[2] - cell[0]) * ((uv.getX(i) * 2) % 1), uv.getY(i) * height * 0.8);
    return geometry;
  };
  const vary = (r: () => number, tint: V3, amount = 0.16): V3 => { const k = 1 - amount / 2 + r() * amount; return [tint[0] * k * (0.96 + r() * 0.08), tint[1] * k, tint[2] * k * (0.94 + r() * 0.12)]; };

  /** Banana: a fat green stem of sheaths and a head of huge torn paddles, the oldest hanging. */
  const banana = (out: Sink, at: V3, height: number, count: number, seed: number, size = 1) => {
    const r = rng(seed), lean: P2 = [(r() - 0.5) * 0.16, (r() - 0.5) * 0.16];
    growing(stem, stemOf(0.17 * size, 0.085 * size, height, SHEATH), at, [lean[1], r() * 6, -lean[0]]);
    const top: V3 = [at[0] + lean[0] * height, at[1] + height, at[2] + lean[1] * height], turn = r() * 6;
    for (let k = 0; k < count; k += 1) {
      const age = k / Math.max(1, count - 1), yaw = turn + k * 2.4 + (r() - 0.5) * 0.5, long = size * (1.5 + r() * 0.7) * (0.62 + 0.38 * Math.sin(Math.PI * Math.pow(age, 0.5)));
      const young = k === 0;
      blade(out, CELLS.banana, [top[0], top[1] - 0.12 * age * size, top[2]], yaw, young ? 1.45 : 1.3 - age * 0.95, long, young ? long * 0.1 : long * (0.34 + r() * 0.05), {
        droop: young ? 0.15 : 0.55 + age * 1.25 + r() * 0.3, fold: young ? 0.9 : 0.22 - age * 0.5, twist: (r() - 0.5) * 0.7, segs: high ? 9 : 6, phase: r(), turn: (r() - 0.5) * 0.4,
        tint: vary(r, age > 0.8 ? [1.05, 0.92, 0.6] : [1, 1, 1]),
      });
    }
  };
  /** Tree fern: a dark fibrous trunk and a wide shuttlecock of arching fronds. */
  const treeFern = (out: Sink, at: V3, height: number, count: number, seed: number, size = 1) => {
    const r = rng(seed), lean: P2 = [(r() - 0.5) * 0.12, (r() - 0.5) * 0.12];
    growing(stem, stemOf(0.17 * size, 0.12 * size, height, TRUNK), at, [lean[1], r() * 6, -lean[0]]);
    growing(stem, scaleUv(new THREE.SphereGeometry(0.15 * size, 8, 5), 0.5, 0.6), [at[0] + lean[0] * height, at[1] + height, at[2] + lean[1] * height]);
    const top: V3 = [at[0] + lean[0] * height, at[1] + height + 0.06, at[2] + lean[1] * height], turn = r() * 6;
    for (let k = 0; k < count; k += 1) {
      const ring = k / count, yaw = turn + k * 2.4 + (r() - 0.5) * 0.3, long = size * (2.1 + r() * 0.7);
      blade(out, CELLS.frond, top, yaw, 1.15 - ring * 0.75 + (r() - 0.5) * 0.2, long, long / 3.1, { droop: 1.25 + ring * 0.6 + r() * 0.3, fold: 0.14, segs: high ? 8 : 5, phase: r(), twist: (r() - 0.5) * 0.3, tint: vary(r, [0.95, 1, 0.9]) });
    }
  };
  /** Cycad: a squat scaly trunk and a crown of stiff dark fronds. */
  const cycad = (out: Sink, at: V3, height: number, count: number, seed: number, size = 1) => {
    const r = rng(seed), turn = r() * 6;
    growing(stem, stemOf(0.2 * size, 0.17 * size, height, TRUNK), at, [0, r() * 6, 0]);
    for (let k = 0; k < count; k += 1) {
      const ring = k / count, long = size * (1.15 + r() * 0.4);
      blade(out, CELLS.cycad, [at[0], at[1] + height, at[2]], turn + k * 2.4, 1.3 - ring * 1.15, long, long / 5.4, { droop: 0.45 + ring * 0.4, fold: 0.3, segs: high ? 6 : 4, phase: r(), stiff: 0.6, tint: vary(r, [0.82, 0.95, 0.9]) });
    }
  };
  /** A fern growing from the ground, or a tuft of strap leaves. */
  const tuft = (out: Sink, cell: Rect, at: V3, size: number, count: number, seed: number, tint: V3 = [1, 1, 1], aspect = 3.1) => {
    const r = rng(seed), turn = r() * 6;
    for (let k = 0; k < count; k += 1) {
      const ring = k / count, long = size * (0.75 + r() * 0.5);
      blade(out, cell, at, turn + k * 2.4 + (r() - 0.5) * 0.4, 1.35 - ring * 0.8, long, long / aspect, { droop: 1.3 + ring * 0.7 + r() * 0.3, fold: 0.16, segs: high ? 6 : 4, phase: r(), tint: vary(r, tint) });
    }
  };
  /** Aroids: big single leaves held out on stalks from a clump. */
  const aroid = (out: Sink, cell: Rect, at: V3, size: number, count: number, seed: number, tint: V3 = [1, 1, 1]) => {
    const r = rng(seed), turn = r() * 6;
    for (let k = 0; k < count; k += 1) {
      const yaw = turn + k * 2.4 + (r() - 0.5) * 0.5, stalk = size * (0.8 + r() * 0.9), out2 = 0.25 + r() * 0.3, long = size * (0.62 + r() * 0.34);
      const tip: V3 = [at[0] + Math.cos(yaw) * stalk * out2, at[1] + stalk * Math.sqrt(1 - out2 * out2), at[2] + Math.sin(yaw) * stalk * out2];
      growing(stem, sweep(path([at, [at[0] + Math.cos(yaw) * stalk * out2 * 0.3, at[1] + stalk * 0.55, at[2] + Math.sin(yaw) * stalk * out2 * 0.3], tip]), 0.012 * size + 0.006, 5), undefined, undefined, undefined, { detail: true });
      const down = -0.35 - r() * 0.5;
      blade(out, cell, [tip[0] - Math.cos(yaw) * long * 0.22 * Math.cos(down), tip[1] - Math.sin(down) * long * 0.22, tip[2] - Math.sin(yaw) * long * 0.22 * Math.cos(down)], yaw, down, long, long * 0.95, { droop: 0.35, fold: 0.2, segs: 3, phase: r(), twist: (r() - 0.5) * 0.5, tint: vary(r, tint) });
    }
  };
  /** A climber hanging from `at`, or with `up` climbing from it: crossed cards of the vine cell. */
  const vine = (out: Sink, at: V3, long: number, seed: number, up = false, wide = 0.42) => {
    const r = rng(seed), yaw = r() * 6;
    for (const turn of [0, HALF]) blade(out, CELLS.vine, at, yaw + turn, up ? HALF - 0.02 : -HALF + 0.03, long, wide * (0.85 + r() * 0.3), { droop: up ? 0.05 : -0.05, fold: 0, segs: 4, phase: r(), stiff: up ? 0.85 : 0.2, tint: vary(r, [1, 1, 1]) });
  };

  // ---- Raised beds along the walls -------------------------------------------------
  // Brick, a stone coping and a hoop edging of cast iron; they keep within a metre of the walls.
  const BEDS: Array<{ side: number; from: number; to: number; top: number }> = [
    { side: -1, from: 0.5, to: 7.3, top: 0.5 }, { side: -1, from: -8.3, to: -0.4, top: 0.5 }, { side: -1, from: -26.6, to: -19.75, top: 0.5 },
    { side: 1, from: 0.6, to: 3.9, top: 0.5 }, { side: 1, from: -8.3, to: -0.4, top: 0.5 }, { side: 1, from: -25.6, to: -14.4, top: 0.38 },
  ];
  const hoop = new THREE.TorusGeometry(0.11, 0.011, 4, 8, Math.PI).rotateY(HALF);
  for (const bed of BEDS) {
    const { side, from, to, top } = bed, long = to - from, mid = (from + to) / 2, front = side * 8.73;
    solid(brick, worldBox(0.22, top, long, 0.9), [front, top / 2, mid]);
    for (const z of [from + 0.11, to - 0.11]) solid(brick, worldBox(0.7, top, 0.22, 0.9), [side * 9.16, top / 2, z]);
    solid(stone, softBox(0.3, 0.06, long + 0.08, 0.015, 1.6), [front, top + 0.03, mid]);
    for (const z of [from + 0.11, to - 0.11]) solid(stone, softBox(0.66, 0.06, 0.3, 0.015, 1.6), [side * 9.18, top + 0.03, z]);
    plain(soil, worldBox(0.68, 0.04, long - 0.4, 0.8), [side * 9.17, top - 0.05, mid]);
    for (let z = from + 0.2; z < to - 0.1; z += 0.24) fine(iron, hoop, [front, top + 0.06, z]);
  }

  // ---- Furnace: the boiler of the house, its flue carried out through the east aisle ----
  const FLUE = 2.5;
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, FLUE);
  {
    furnace.group.updateMatrixWorld(true);
    const at = new THREE.Vector3(9.28, 0, -12.65);
    for (const child of furnace.group.children) {
      const parameters = ((child as THREE.Mesh).geometry as THREE.CylinderGeometry | undefined)?.parameters;
      if (parameters && parameters.radiusTop === 0.3 && parameters.height === FLUE) child.getWorldPosition(at);
    }
    const top = 3.6 + FLUE, out = 11.6, duct = metals.brushed;
    cast(duct, sweep(path([[at.x, top - 0.05, at.z], [at.x, top + 0.2, at.z], [at.x + 0.25, top + 0.42, at.z], [out - 0.3, top + 0.5, at.z], [out, top + 0.72, at.z], [out, 9.3, at.z]]), 0.3, 14));
    cast(metals.structural, cyl(0.36, 0.1, "y", 16), [at.x, WALL_TOP + 0.16, at.z]);
    cast(metals.structural, cyl(0.37, 0.12, "y", 16), [out, aisleY(out) + 0.05, at.z]);
    cast(duct, new THREE.ConeGeometry(0.52, 0.34, 16), [out, 9.62, at.z]);
    for (let k = 0; k < 3; k += 1) cast(metals.structural, cyl(0.014, 0.3, "y", 4), [out + Math.cos(k * 2.1) * 0.27, 9.4, at.z + Math.sin(k * 2.1) * 0.27]);
  }

  // ---- Planting ----------------------------------------------------------------
  // In the beds along the range: what the player walks beside.
  const near = leaves.near;
  banana(near, [-9.1, 0.44, 1.5], 2.3, 10, 3, 1.15);
  treeFern(near, [-9.05, 0.44, 6.2], 1.9, high ? 22 : 12, 4);
  aroid(near, CELLS.alocasia, [-9.05, 0.46, 3.9], 1.1, 6, 5);
  cycad(near, [-9.05, 0.44, -2.0], 0.45, high ? 18 : 12, 6);
  banana(near, [-9.12, 0.44, -5.0], 1.3, 6, 7, 0.62);
  aroid(near, CELLS.monstera, [-9.1, 0.46, -7.6], 1.0, 6, 8);
  aroid(near, CELLS.alocasia, [-9.05, 0.46, -0.9], 0.9, 5, 9);
  treeFern(near, [-9.05, 0.44, -23.0], 2.3, high ? 22 : 12, 10);
  banana(near, [-9.1, 0.44, -26.0], 2.5, 10, 11, 1.1);
  aroid(near, CELLS.alocasia, [-9.05, 0.46, -20.4], 1.0, 5, 12);
  banana(near, [9.1, 0.44, 3.1], 2.4, 10, 13, 1.15);
  aroid(near, CELLS.alocasia, [9.05, 0.46, 1.3], 1.0, 6, 14);
  treeFern(near, [9.05, 0.44, -5.0], 2.1, high ? 22 : 12, 15);
  cycad(near, [9.05, 0.44, -1.6], 0.5, high ? 18 : 12, 16);
  aroid(near, CELLS.monstera, [9.1, 0.46, -7.7], 1.05, 6, 17);
  cycad(near, [9.05, 0.32, -19.95], 0.3, high ? 14 : 10, 18, 0.72);
  // Ferns, strap leaves and painted leaves fill the soil between them.
  const fillers: Array<[number, number, number]> = [];
  for (const bed of BEDS) for (let z = bed.from + 0.5; z < bed.to - 0.3; z += 0.62 + random() * 0.5) fillers.push([bed.side * (8.95 + random() * 0.4), bed.top - 0.03, z]);
  fillers.forEach(([x, y, z], index) => {
    const pick = random();
    if (pick < 0.46) tuft(near, CELLS.frond, [x, y, z], 0.55 + random() * 0.45, high ? 9 : 6, 100 + index, [0.92, 1, 0.88]);
    else if (pick < 0.68) tuft(near, CELLS.strap, [x, y, z], 0.5 + random() * 0.3, high ? 12 : 8, 100 + index, [1, 1, 0.95], 5.6);
    else if (pick < 0.86) aroid(near, CELLS.caladium, [x, y, z], 0.42 + random() * 0.14, 6, 100 + index);
    else { tuft(near, CELLS.strap, [x, y, z], 0.5, 8, 100 + index, [0.9, 1, 0.8], 5.6); for (let k = 0; k < 3; k += 1) blade(near, CELLS.flower, [x + (random() - 0.5) * 0.3, y + 0.55 + random() * 0.3, z + (random() - 0.5) * 0.3], random() * 6, 0.5, 0.16, 0.16, { droop: 0, fold: 0, segs: 1, phase: random() }); }
  });
  // Climbers up the columns from the wall top, and hanging from the gallery.
  for (const [side, z, long] of [[-1, 4, 3.4], [-1, -5, 3.9], [-1, -14, 3.2], [-1, -23, 3.8], [1, 1, 3.8], [1, -8, 3.3], [1, -20, 3.6], [-1, -29, 3.6], [1, -32, 3.6]] as V3[]) vine(near, [side * (COL_X - 0.02), WALL_TOP + 0.3, z], long, 300 + z, true, 0.5);
  for (const [side, z, long] of [[-1, 2.4, 1.9], [-1, -9.6, 1.5], [-1, -18.4, 2.1], [1, 5.6, 1.6], [1, -3.4, 2.2], [1, -15.6, 1.7], [1, -24.2, 2.0], [-1, -26.4, 1.6]] as V3[]) vine(near, [side * (COL_X - 0.52), DECK + 0.1, z], long, 340 + z, false, 0.55);

  // The aisles: a bed against the nave wall, a path, a bed against the glass.
  const aisle = leaves.aisle;
  for (const side of [-1, 1]) {
    solid(brick, worldBox(0.2, 0.36, NAVE_LEN - 0.8, 0.9), [side * 12.9, 0.18, NAVE_MID]);
    solid(brick, worldBox(0.2, 0.36, NAVE_LEN - 0.8, 0.9), [side * 14.3, 0.18, NAVE_MID]);
    plain(soil, worldBox(2.66, 0.04, NAVE_LEN - 0.8, 0.8), [side * 11.52, 0.3, NAVE_MID]);
    plain(soil, worldBox(2.66, 0.04, NAVE_LEN - 0.8, 0.8), [side * 15.68, 0.3, NAVE_MID]);
    for (let z = Z_BACK - 1.2; z > Z_END + 1; z -= 2.1 + random() * 0.9) {
      const seed = Math.round(500 + z * 7 + side * 3), inner: V3 = [side * (10.9 + random() * 1.3), 0.3, z], outer: V3 = [side * (14.9 + random() * 1.5), 0.3, z + (random() - 0.5) * 1.2];
      const pick = random();
      if (pick < 0.3) banana(aisle, inner, 1.8 + random() * 1.5, 8, seed);
      else if (pick < 0.56) treeFern(aisle, inner, 1.4 + random() * 1.6, 13, seed);
      else if (pick < 0.7) cycad(aisle, inner, 0.5 + random() * 0.4, 14, seed, 1.15);
      else if (pick < 0.86) aroid(aisle, random() < 0.5 ? CELLS.monstera : CELLS.alocasia, inner, 1.25, 7, seed);
      else tuft(aisle, CELLS.frond, inner, 1.3, 11, seed);
      tuft(aisle, CELLS.frond, [inner[0] + side * 0.7, 0.3, z + 0.9], 0.9, 8, seed + 1, [0.9, 1, 0.86]);
      const second = random();
      if (second < 0.3) banana(aisle, outer, 1.4 + random() * 0.8, 7, seed + 2, 0.85);
      else if (second < 0.6) aroid(aisle, CELLS.alocasia, outer, 1.1, 6, seed + 2);
      else if (second < 0.8) tuft(aisle, CELLS.strap, outer, 0.9, 12, seed + 2, [1, 1, 0.95], 5.6);
      else treeFern(aisle, outer, 1.0 + random() * 0.6, 11, seed + 2, 0.8);
    }
  }
  // Palms of the tree library: date palms young enough to stand under the aisle glass, fan palms beside them.
  {
    const dates: TreeItem[] = [], fans: TreeItem[] = [], shrubs: TreeItem[] = [], ferns: TreeItem[] = [];
    for (const side of [-1, 1]) {
      [7, 0.6, -5.8, -12.4, -18.8, -25.3, -31.6, -37.6].forEach((z, index) => dates.push({ at: [side * (12.3 + ((index * 7) % 3) * 0.45), 0.3, z + side * 0.8], variant: index % 2, scale: 0.6 + ((index * 5) % 4) * 0.02, yaw: index * 1.9 + side }));
      [4, -2.8, -9.3, -15.6, -22, -28.6, -35].forEach((z, index) => {
        fans.push({ at: [side * 11.2, 0.3, z - side * 0.6], variant: 2, scale: 1 + (index % 3) * 0.06, yaw: index * 2.3 });
        fans.push({ at: [side * 15.7, 0.3, z + 1.6], variant: index % 2, yaw: index * 1.3 + 1 });
      });
      for (let z = Z_BACK - 2; z > Z_END + 1; z -= 3.4) shrubs.push({ at: [side * (16.2 + (random() - 0.5) * 0.6), 0.3, z + random()], variant: Math.floor(random() * 3), yaw: random() * 6, scale: 0.9 + random() * 0.3 });
    }
    for (const [x, y, z] of fillers.filter((_, index) => index % 3 === 0)) ferns.push({ at: [x + (x > 0 ? -0.12 : 0.12), y - 0.2, z + 0.3], yaw: z, scale: 0.9 + ((z * 7) % 1 + 1) % 1 * 0.3 });
    trees.place("datePalm", dates, { detail: "mid" });
    trees.place("fanPalm", fans, { detail: "mid" });
    trees.place("shrub", shrubs, { detail: "mid" }).forEach((mesh) => kit.mirrorHidden.push(mesh));
    trees.place("potFern", ferns, { hit: false });
  }

  // Beyond the far end, above the rack: the great palm under the end of the vault, and its court.
  {
    trees.place("datePalm", [{ at: [0.4, 0.5, -34.2], variant: 2, scale: 1.02, yaw: 0.6 }]);
    trees.place("datePalm", [
      { at: [-6.2, 0, -31.4], variant: 0, scale: 0.92, yaw: 2.1 }, { at: [6.6, 0, -37.2], variant: 0, scale: 0.86, yaw: 4.4 },
      { at: [6.9, 0, -30.6], variant: 1, scale: 1.05, yaw: 3.3 }, { at: [-5.4, 0, -38.2], variant: 1, scale: 0.98, yaw: 0.4 },
    ], { detail: "mid" });
    trees.place("fanPalm", [{ at: [-3.4, 0, -30.0], variant: 2, scale: 1.32, yaw: 1 }, { at: [3.2, 0, -29.8], variant: 2, scale: 1.24, yaw: 4 }, { at: [-8.1, 0, -36], variant: 2, scale: 1.2, yaw: 2 }, { at: [8.3, 0, -34], variant: 2, scale: 1.3, yaw: 5 }], { detail: "mid" });
    banana(aisle, [-2.2, 0, -31.6], 3.9, 9, 801, 1.5);
    banana(aisle, [4.6, 0, -33.4], 3.6, 9, 802, 1.45);
    banana(aisle, [-7.6, 0, -33.6], 3.4, 8, 803, 1.4);
    treeFern(aisle, [2.3, 0, -31.2], 4.4, 16, 804, 1.25);
    treeFern(aisle, [-4.6, 0, -34.6], 4.1, 16, 805, 1.2);
    treeFern(aisle, [7.8, 0, -39], 4.6, 16, 806, 1.2);
    plain(soil, scaleUv(new THREE.CylinderGeometry(3.2, 3.2, 0.5, 24), 6, 1), [0.4, 0.25, -34.2]);
  }

  // ================================================================================
  // Near detail: what the player stands beside
  // ================================================================================
  const tube = (points: V3[], radius: number, radial = 6) => sweep(path(points), radius, radial);
  /** A plate cut from the sign sheet. */
  const plateOf = (cell: Rect, width: number, height: number) => {
    const geometry = new THREE.PlaneGeometry(width, height), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (cell[0] + (cell[2] - cell[0]) * uv.getX(i)) / SIGN, 1 - (cell[3] - (cell[3] - cell[1]) * uv.getY(i)) / SIGN);
    return geometry;
  };
  const small: Opt = { mirror: false };

  // ---- The wall fountain and its basin, beside the firing line -------------------------
  const fountainFall = new THREE.Vector2(WALL - 0.41, NICHE.z), waterTime = { value: 0 };
  {
    const at = onWall(1, NICHE.z, { shadow: true, hit: true }), face = onWall(1, NICHE.z, { shadow: false });
    at(stone, worldBox(1.7, 3.0, 0.1, 1.6), [0, 1.95, -0.47]);
    at(stone, softBox(1.6, 0.09, 0.56, 0.015, 1.6), [0, NICHE.sill + 0.02, -0.19]);
    face(stone, projectUv(new THREE.RingGeometry(NICHE.width / 2, NICHE.width / 2 + 0.2, 24, 1, 0, Math.PI), 1.6), [0, NICHE.spring, 0.004]);
    face(stone, softBox(0.2, 0.34, 0.05, 0.012, 1.6), [0, NICHE.spring + NICHE.width / 2 + 0.1, 0.02]);
    // A boss of stone behind the spout, a brass rose on it and the pipe the water leaves by.
    at(stone, new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI, 0, Math.PI), [0, 1.62, -0.425], undefined, [1, 1, 0.16]);
    at(brass, lathe([[0, 0], [0.13, 0], [0.14, 0.02], [0.1, 0.045], [0.05, 0.06], [0, 0.065]], 14).rotateX(HALF), [0, 1.62, -0.36]);
    at(brass, cyl(0.026, 0.2, "z", 8), [0, 1.6, -0.3]);
    // The basin: half a ring of stone against the wall.
    const rim = [[1.16, 0], [1.18, 0.07], [1.12, 0.11], [1.12, 0.42], [1.2, 0.47], [1.2, 0.56], [1.0, 0.56], [0.98, 0.3]].map(([x, y]) => new THREE.Vector2(x, y));
    solid(stone, scaleUv(new THREE.LatheGeometry(rim, high ? 24 : 14, Math.PI, Math.PI), 2.3, 0.7), [WALL, 0, NICHE.z]);
    // The pool: a hand deep at the rim and a forearm in the middle, clear enough to show its bed and the net of
    // light the roof glass throws on it. The jet keeps it ringing, and beads up white where it lands.
    const water = track(waterMaterial({
      time: waterTime, key: "glasshouse-pool", lean: !high,
      field: /* glsl */`
        void wField(vec2 p, float t, out float depth, out float shore, out vec2 flow, out float churn) {
          shore = max(1.0 - length(p - vec2(${WALL.toFixed(3)}, ${NICHE.z.toFixed(3)})), 0.0);
          depth = 0.1 + 0.24 * smoothstep(0.0, 0.55, shore);
          vec2 from = p - vec2(${fountainFall.x.toFixed(3)}, ${fountainFall.y.toFixed(3)});
          float r = length(from) + 0.001;
          flow = (from / r) * 0.22 * exp(-r / 0.3);
          churn = exp(-pow(r / 0.06, 2.0)) * (0.85 + 0.2 * sin(t * 11.0)) + 0.34 * exp(-r / 0.13) * (0.7 + 0.6 * wNoise(p * 14.0 - t * vec2(0.9, 0.6)));
        }
      `,
      steep: 0, ripple: 0.02, rippleSize: 0.11, lap: 0.018, flowRipple: 0.03,
      deep: 0x0c2219, bed: 0x545c44, bedGrain: 0.09, clarity: 3.2, caustics: 0.8, causticSize: 0.2,
      foam: 0xb9c4c0, foamSize: 0.035, shoreReach: 0.035, shoreFoam: 0.3,
      sources: [new THREE.Vector4(fountainFall.x, fountainFall.y, 0.6, 0.42)],
      roughness: 0.04, envMapIntensity: 1.5,
    }));
    const pool = new THREE.Mesh(track(new THREE.CircleGeometry(1.0, high ? 24 : 12, HALF, Math.PI).rotateX(-HALF)), water);
    pool.position.set(WALL, 0.43, NICHE.z);
    pool.receiveShadow = true; pool.userData.walkThrough = true;
    // The jet: a thin fall of water from the pipe to the pool.
    const jet: V3[] = Array.from({ length: 9 }, (_, i) => { const t = (0.487 * i) / 8; return [WALL + 0.2 - 1.25 * t, 1.6 - 4.9 * t * t, NICHE.z] as V3; });
    // It leaves the pipe at a walk and is falling fast by the time it lands: a clear rod that frays toward the foot.
    const falling = track(fallMaterial({ time: waterTime, round: true, width: 0.094, speed: 1.25, gain: 8.3, glass: 0.45, breakup: 1.6, strand: 0.02, sheet: 0x6f9a94, white: 0xf4fbfa, shade: 0x9fb8b6, opacity: 0.85, fog: false, lean: !high }));
    const stream = new THREE.Mesh(track(sweep(path(jet), 0.015, 8)), falling);
    stream.userData.walkThrough = true;
    scene.add(pool, stream);
    kit.mirrorHidden.push(pool, stream);
    kit.probeHidden.push(stream);
    for (const [dx, dz, size, yaw] of [[-0.78, -0.42, 0.3, 0.4], [-0.5, 0.4, 0.26, 2.2], [-0.8, 0.12, 0.2, 4.0], [-0.35, -0.6, 0.24, 5.2], [-0.3, 0.6, 0.2, 1.2]]) {
      blade(leaves.near, CELLS.lily, [WALL + dx, 0.437, NICHE.z + dz], yaw, 0, size, size, { droop: 0, fold: 0, segs: 1, stiff: 1, tint: [0.95, 1, 0.9] });
    }
  }

  // ---- Heating: a pair of four-inch pipes round the walls, fed by the boiler --------------
  const covered = (side: number, z: number) => BEDS.some((bed) => bed.side === side && z > bed.from - 0.1 && z < bed.to + 0.1) || (side > 0 && ((z > -13.7 && z < -9.5) || (z > 4.2 && z < 6.8)));
  const valve = (at: V3, along: "x" | "z") => {
    cast(greenIron, new THREE.SphereGeometry(0.095, 10, 8), at, undefined, along === "z" ? [0.85, 0.85, 1.25] : [1.25, 0.85, 0.85]);
    cast(greenIron, cyl(0.045, 0.14, "y", 8), [at[0], at[1] + 0.13, at[2]]);
    cast(brass, cyl(0.012, 0.16, "y", 6), [at[0], at[1] + 0.27, at[2]]);
    cast(redPaint, new THREE.TorusGeometry(0.085, 0.012, 6, 14).rotateX(HALF), [at[0], at[1] + 0.34, at[2]]);
    for (const turn of [0, HALF]) cast(redPaint, cyl(0.008, 0.17, "x", 4), [at[0], at[1] + 0.34, at[2]], [0, turn, 0]);
  };
  for (const side of [-1, 1]) {
    const x = side * (WALL - 0.14);
    for (const y of [0.13, 0.36]) {
      cast(greenIron, scaleUv(cyl(0.055, 37.2, "z", 10), 1, 14), [x, y, -9.1]);
      for (let z = 9.1; z > -27.5; z -= 1.85) if (!covered(side, z)) cast(greenIron, cyl(0.086, 0.05, "z", 10), [x, y, z]);
    }
    for (let z = 8.2; z > -27.5; z -= 1.85) if (!covered(side, z)) plain(darkIron, box(0.16, 0.44, 0.05), [x, 0.22, z], undefined, undefined, small);
  }
  for (const y of [0.13, 0.36]) {
    cast(greenIron, scaleUv(cyl(0.055, 18.6, "x", 10), 1, 7), [0, y, Z_BACK - 0.5]);
    for (let x = -8.3; x < 8.4; x += 1.85) cast(greenIron, cyl(0.086, 0.05, "x", 10), [x, y, Z_BACK - 0.5]);
  }
  valve([-(WALL - 0.14), 0.36, -8.8], "z"); valve([-(WALL - 0.14), 0.36, -19.3], "z");
  valve([WALL - 0.14, 0.36, -13.95], "z"); valve([WALL - 0.14, 0.36, -9.05], "z");
  valve([-4.6, 0.36, Z_BACK - 0.5], "x"); valve([5.3, 0.36, Z_BACK - 0.5], "x");

  // ---- Misters: a brass line under each gallery, and a rose hung from it over the beds ------
  for (const side of [-1, 1]) cast(brass, cyl(0.016, 36, "z", 6), [side * (COL_X - 0.92), DECK + 0.03, -9.5]);
  for (const [x, y, z] of MISTERS) {
    const side = Math.sign(x);
    cast(brass, tube([[side * (COL_X - 0.92), DECK + 0.03, z], [side * (COL_X - 0.98), DECK - 0.06, z], [x, DECK - 0.2, z], [x, y + 0.1, z]], 0.012, 6));
    cast(brass, cyl(0.055, 0.1, "y", 10, 0.014), [x, y + 0.05, z]);
    cast(brass, cyl(0.057, 0.012, "y", 10), [x, y - 0.004, z]);
    cast(brass, new THREE.SphereGeometry(0.03, 8, 6), [x, DECK - 0.5, z]);
    cast(brass, cyl(0.006, WALL - 0.08 - Math.abs(x), "x", 4), [(side * (WALL - 0.08 + Math.abs(x))) / 2, WALL_TOP + 0.06, z]);
  }

  // ---- Floor: cast-iron grilles over the heating ducts, and drain gratings in the wet -------
  {
    const strip = (width: number, long: number) => scaleUv(new THREE.PlaneGeometry(width, long).rotateX(-HALF), 1, long / width);
    for (const x of [-7.25, 7.25]) plain(grille, strip(0.5, 33), [x, 0.008, -8], undefined, undefined, small);
    plain(grille, strip(0.5, 14), [0, 0.008, 8.72], [0, HALF, 0], undefined, small);
    for (const [x, z] of [[-3.1, 2.2], [3.4, -3.8], [-2.6, -13.2], [2.9, -21.5], [-4.4, 6.9]]) plain(grille, new THREE.CircleGeometry(0.17, 18).rotateX(-HALF), [x, 0.008, z], [0, x, 0], undefined, small);
  }

  // ---- The potting bench, in the corner behind the firing line -------------------------------
  const pot = lathe([[0.07, 0], [0.098, 0.15], [0.11, 0.15], [0.11, 0.2], [0.096, 0.2], [0.072, 0.03], [0, 0.03]], high ? 12 : 8);
  const potted = (at: V3, scale = 1, rot: V3 = [0, 0, 0]) => cast(terracotta, pot, at, rot, scale);
  const wateringCan = (at: V3, yaw: number, scale = 1) => {
    const add = maker({ shadow: true }, mat4(at, [0, yaw, 0], scale));
    add(zinc, cyl(0.13, 0.3, "y", 12, 0.12), [0, 0.15, 0]);
    add(zinc, cyl(0.122, 0.012, "y", 12), [0, 0.296, 0]);
    add(zinc, tube([[0.1, 0.06, 0], [0.3, 0.26, 0], [0.42, 0.4, 0]], 0.022, 6));
    add(zinc, cyl(0.035, 0.03, "x", 10, 0.052), [0.432, 0.412, 0], [0, 0, 0.75]);
    add(zinc, tube([[-0.12, 0.26, 0], [-0.26, 0.24, 0], [-0.28, 0.12, 0], [-0.13, 0.06, 0]], 0.011, 5));
    add(zinc, tube([[-0.1, 0.3, 0], [-0.04, 0.42, 0], [0.06, 0.42, 0], [0.11, 0.3, 0]], 0.011, 5));
  };
  {
    const cx = -8.05, cz = 9.3, top = 0.88, y0 = top + 0.018;
    for (let k = 0; k < 5; k += 1) solid(wood, worldBox(2.6, 0.035, 0.118, 0.7), [cx, top, cz - 0.248 + k * 0.124]);
    cast(wood, worldBox(2.6, 0.17, 0.025, 0.7), [cx, top + 0.09, cz + 0.31]);
    for (const x of [-1.2, 0, 1.2]) for (const z of [-0.26, 0.26]) cast(iron, box(0.05, top - 0.02, 0.05), [cx + x, (top - 0.02) / 2, cz + z]);
    for (const z of [-0.26, 0.26]) cast(iron, box(2.45, 0.04, 0.03), [cx, top - 0.05, cz + z]);
    for (const x of [-1.2, 0, 1.2]) cast(iron, box(0.03, 0.04, 0.52), [cx + x, top - 0.05, cz]);
    // Pots: a row waiting to be filled, a stack, one on its side, and a tray of seedlings.
    ([[-1.08, 0.08, 1.05], [-0.84, 0.16, 0.9], [-0.62, 0.06, 1.0], [-0.4, 0.15, 0.8]] as V3[]).forEach(([x, z, scale], index) => {
      potted([cx + x, y0, cz + z - 0.06], scale, [0, index, 0]);
      plain(soil, new THREE.CircleGeometry(0.094 * scale, 10).rotateX(-HALF), [cx + x, y0 + 0.17 * scale, cz + z - 0.06], undefined, undefined, small);
      if (index !== 1) tuft(leaves.near, index === 2 ? CELLS.caladium : CELLS.strap, [cx + x, y0 + 0.17 * scale, cz + z - 0.06], 0.26, high ? 7 : 5, 880 + index, [1, 1, 0.95], index === 2 ? 1.3 : 5);
    });
    for (let k = 0; k < 5; k += 1) potted([cx + 1.0, y0 + k * 0.052, cz + 0.12], 0.95, [0, k * 0.7, 0]);
    for (let k = 0; k < 3; k += 1) potted([cx + 0.74, y0 + k * 0.04, cz + 0.16], 0.7, [0, k * 1.1, 0]);
    potted([cx + 0.62, y0 + 0.105, cz - 0.12], 1, [0, 0.5, HALF]);
    cast(wood, worldBox(0.52, 0.07, 0.32, 0.5), [cx + 0.1, y0 + 0.035, cz - 0.04]);
    plain(soil, box(0.48, 0.012, 0.28), [cx + 0.1, y0 + 0.068, cz - 0.04], undefined, undefined, small);
    for (let k = 0; k < (high ? 15 : 8); k += 1) tuft(leaves.near, CELLS.strap, [cx - 0.1 + (k % 5) * 0.1, y0 + 0.072, cz - 0.13 + Math.floor(k / 5) * 0.09], 0.085 + (k % 3) * 0.02, 4, 860 + k, [0.95, 1, 0.8], 4);
    // Big pots under the bench and along the wall.
    for (let k = 0; k < 4; k += 1) potted([cx + 0.1, k * 0.085, cz + 0.05], 1.7, [0, k, 0]);
    potted([cx - 0.3, 0, cz - 0.02], 1.5); potted([cx + 0.48, 0, cz + 0.08], 1.3, [0, 2, 0]);
    for (let k = 0; k < 3; k += 1) potted([8.42, k * 0.09, 9.34], 1.8, [0, k * 0.8, 0]);
    potted([8.05, 0.2, 8.95], 1.8, [0.3, 0.4, HALF]);
    wateringCan([-9.12, 0.46, 7.75], 0.9, 0.9);
    wateringCan([-7.0, 0, 8.6], 2.5);
  }

  // ---- Ventilator winding gear, on the back wall beside the chart ---------------------------
  const chain = new THREE.Group();
  {
    const gear = maker({ shadow: true }, mat4([8.03, 0, Z_BACK - 0.3], [0, Math.PI, 0]));
    gear(greenIron, softBox(0.34, 0.5, 0.16, 0.02, 1), [0, 1.25, 0.08]);
    gear(greenIron, cyl(0.03, 0.2, "z", 8), [0, 1.3, 0.22]);
    gear(redPaint, new THREE.TorusGeometry(0.26, 0.018, 6, 20), [0, 1.3, 0.3]);
    for (let k = 0; k < 3; k += 1) gear(redPaint, box(0.5, 0.022, 0.016), [0, 1.3, 0.3], [0, 0, (k * Math.PI) / 3 + 0.3]);
    gear(brass, cyl(0.015, 0.11, "z", 6), [0.26 * Math.cos(0.3), 1.3 + 0.26 * Math.sin(0.3), 0.36]);
    gear(iron, cyl(0.017, 7.2, "y", 6), [0.1, 5.1, 0.06]);
    for (const y of [2.6, 4.4, 6.2, 8.0]) gear(greenIron, box(0.1, 0.05, 0.12), [0.1, y, 0.06]);
    // The endless chain that works the far sashes, over its wheel under the gallery.
    gear(greenIron, new THREE.TorusGeometry(0.15, 0.02, 6, 16), [0.42, 6.45, 0.3]);
    gear(greenIron, box(0.05, 0.05, 0.32), [0.42, 6.45, 0.16]);
    const drop = 5.2, half = 0.15;
    const links = mergeGeometries([cyl(0.008, drop, "y", 4).translate(-half, -drop / 2, 0), cyl(0.008, drop, "y", 4).translate(half, -drop / 2, 0), new THREE.TorusGeometry(half, 0.008, 4, 10, Math.PI).rotateZ(Math.PI).translate(0, -drop, 0)]);
    if (links) chain.add(new THREE.Mesh(track(links), darkIron));
    chain.position.set(7.61, 6.45, Z_BACK - 0.6);
    scene.add(chain);
    kit.mirrorHidden.push(chain);
  }
  // The brass thermometer on the pier beside the chart, and the founder's plate on the other.
  {
    const at = maker(small, mat4([6.95, 1.72, Z_BACK - 0.392], [0, Math.PI, 0]));
    at(brass, softBox(0.16, 0.64, 0.014, 0.006, 1));
    at(signs, plateOf(SIGNS.scale, 0.12, 0.4), [0.015, 0, 0.009]);
    at(iron, cyl(0.006, 0.36, "y", 6), [-0.058, 0, 0.016]);
    at(redPaint, cyl(0.0068, 0.234, "y", 6), [-0.058, -0.083, 0.016]);
    at(redPaint, new THREE.SphereGeometry(0.013, 8, 6), [-0.058, -0.2, 0.016]);
    maker(small, mat4([-6.95, 1.7, Z_BACK - 0.392], [0, Math.PI, 0]))(signs, plateOf(SIGNS.founder, 0.5, 0.1625));
  }

  // ---- Enamel: notices on the walls, labels in the beds ----------------------------------------
  {
    const back = maker(small, mat4([0, 0, Z_BACK - 0.312], [0, Math.PI, 0]));
    back(signs, plateOf(SIGNS.bench, 0.84, 0.6), [8.03, 1.78, 0]);
    back(signs, plateOf(SIGNS.gear, 0.64, 0.457), [-8.4, 2.15, 0]);
    onWall(1, 7.8, small)(signs, plateOf(SIGNS.mist, 0.75, 0.48), [0, 1.8, 0.012]);
    onWall(-1, 8.45, small)(signs, plateOf(SIGNS.seeds, 0.75, 0.48), [0, 1.78, 0.012]);
    onWall(-1, -14.05, small)(signs, plateOf(SIGNS.trade, 0.42, 0.517), [0, 1.62, 0.012]);
    const labels: Array<[number, number, number]> = [[1, -1, 1.05], [2, -1, 5.7], [3, -1, -2.6], [4, -1, -7.1], [0, -1, -24.6], [5, -1, -20.9], [1, 1, 2.6], [5, 1, 1.75], [3, 1, -1.1], [6, 1, -3.3], [2, 1, -5.6], [7, 1, -6.7], [4, 1, -7.95], [3, 1, -19.4], [6, 1, -22.4]];
    for (const [k, side, z] of labels) {
      const bed = BEDS.find((entry) => entry.side === side && z > entry.from && z < entry.to);
      if (!bed) continue;
      plain(darkIron, cyl(0.006, 0.3, "y", 4), [side * 8.93, bed.top + 0.1, z], undefined, undefined, small);
      plain(signs, plateOf(labelCell(k), 0.3, 0.0975).rotateX(-0.5), [side * 8.925, bed.top + 0.27, z], [0, -side * HALF, 0], undefined, small);
    }
  }

  // ---- Ventilators: top-hung sashes either side of the ridge ------------------------------------
  const SASH = { long: 1.19, wide: 1.36, hinge: 0.014, mid: 0.06, open: 0.34 };
  const sashParts = (s: number) => ({
    iron: [
      box(0.05, 0.04, SASH.wide), box(0.05, 0.04, SASH.wide).translate(s * SASH.long, 0, 0),
      box(SASH.long, 0.04, 0.05).translate((s * SASH.long) / 2, 0, -SASH.wide / 2), box(SASH.long, 0.04, 0.05).translate((s * SASH.long) / 2, 0, SASH.wide / 2),
      box(SASH.long, 0.03, 0.03).translate((s * SASH.long) / 2, 0, 0),
    ],
    glass: scaleUv(new THREE.PlaneGeometry(SASH.long, SASH.wide).rotateX(-HALF).translate((s * SASH.long) / 2, 0, 0), 2, 1),
  });
  const sashHinge = (s: number, line: number): V3 => [s * (VR + 0.05) * Math.sin(SASH.hinge), VCY + (VR + 0.05) * Math.cos(SASH.hinge), line - 0.75];
  for (const [s, lines] of [[-1, [7, -11, -20]], [1, [1, -8, -17, -26]]] as Array<[number, number[]]>) for (const line of lines) {
    const add = maker({ shadow: true }, mat4(sashHinge(s, line), [0, 0, -s * (SASH.mid - SASH.open)])), parts = sashParts(s);
    parts.iron.forEach((part) => add(iron, part));
    add(glass, parts.glass);
    add(iron, cyl(0.008, 0.41, "y", 4), [s * (SASH.long - 0.034), -0.2, 0], [0, 0, -s * 0.17]);
  }
  // One of them is loose on its stay and works in the draught.
  const flap = new THREE.Group(), flapAt = new THREE.Vector3(...sashHinge(-1, -2));
  {
    const parts = sashParts(-1), frame = mergeGeometries(parts.iron);
    if (frame) flap.add(new THREE.Mesh(track(frame), iron));
    flap.add(new THREE.Mesh(track(parts.glass), glass));
    flap.position.copy(flapAt);
    flap.rotation.z = SASH.mid - SASH.open;
    scene.add(flap);
    kit.mirrorHidden.push(flap);
  }

  // ---- The spiral stair to the gallery, beyond the far end --------------------------------------
  {
    const cx = -7.9, cz = -29.6, radius = 0.86, treads = 32, rise = (DECK + 0.17) / treads, step = TAU / 16;
    cast(iron, cyl(0.075, 8.6, "y", 10), [cx, 4.3, cz]);
    cast(iron, new THREE.SphereGeometry(0.11, 10, 8), [cx, 8.66, cz]);
    cast(iron, cyl(0.16, 0.12, "y", 10, 0.09), [cx, 0.06, cz]);
    const rail: V3[] = [];
    for (let k = 0; k < treads; k += 1) {
      const a = Math.PI - (treads - 1 - k) * step, y = (k + 1) * rise, c = Math.cos(a), s = Math.sin(a);
      cast(iron, box(radius - 0.06, 0.028, 0.27), [cx + (c * (radius + 0.06)) / 2, y, cz + (s * (radius + 0.06)) / 2], [0, -a, 0]);
      cast(iron, cyl(0.011, 0.92, "y", 5), [cx + c * (radius - 0.03), y + 0.46, cz + s * (radius - 0.03)]);
      rail.push([cx + c * (radius - 0.03), y + 0.93, cz + s * (radius - 0.03)]);
    }
    cast(iron, tube(rail, 0.02, 6));
    cast(iron, box(0.36, 0.03, 0.8), [cx - radius - 0.1, DECK + 0.155, cz]);
  }

  // ---- Hanging baskets under the gallery, one to a bracket ---------------------------------------
  {
    const bowl = new THREE.SphereGeometry(0.25, 10, 5, 0, TAU, HALF, HALF);
    for (const [side, lines] of [[-1, [7, 1, -8, -14, -20, -26]], [1, [4, -2, -8, -14, -26]]] as Array<[number, number[]]>) lines.forEach((z, index) => {
      if (!high && index % 2) return;
      const x = side * (COL_X - 0.84), y = 5.75 + (index % 2) * 0.3, seed = 700 + z * 3 + side;
      plain(soil, bowl, [x, y, z], undefined, undefined, { shadow: true, walk: true });
      for (let k = 0; k < 3; k += 1) { const a = k * 2.094 + index; plain(darkIron, tube([[x + Math.cos(a) * 0.24, y, z + Math.sin(a) * 0.24], [x, DECK - 0.12, z]], 0.006, 4), undefined, undefined, undefined, small); }
      tuft(leaves.near, CELLS.frond, [x, y - 0.02, z], 0.8, high ? 10 : 6, seed, [0.95, 1, 0.88]);
      vine(leaves.near, [x, y - 0.05, z], 1.0 + (index % 3) * 0.3, seed + 1, false, 0.5);
    });
  }

  // ---- Sacks of compost, crates and baskets from the shared store ------------------------------
  {
    const props = createProps(kit, { seed: 5 });
    const P = (x: number, y: number, z: number, yaw = 0, scale = 1): PropItem => ({ position: [x, y, z], rotation: [0, yaw, 0], scale: [scale, scale, scale] });
    const dressing = [
      props.place("sack", [P(-8.75, 0, 8.62, 0.4), P(-9.18, 0, 8.25, 1.9, 0.92), P(8.95, 0, 8.3, 2.6)]),
      props.place("sackLying", [P(-7.5, 0, 8.72, 0.25), P(-7.46, 0.2, 8.7, 0.1), P(-7.52, 0.4, 8.74, 0.32)]),
      props.place("sackOpen", [{ ...P(-8.2, 0, 8.6, 1.1), tint2: 0x3a2a1c }]),
      props.place("crateSlat", [P(-7.3, 0, 9.28, 0.05), P(-8.7, 0, 9.3, -0.04), P(8.95, 0, 9.2, 0.1), P(8.93, 0.38, 9.22, -0.12)]),
      props.place("crateSmall", [P(-9.12, 0, 7.75, 1.5)]),
      props.place("basket", [P(-8.7, 0.38, 9.3, 0.6), P(8.93, 0.76, 9.2, 0.4)]),
      props.place("urn", [P(9.05, 0, 7.35, 0.3)]),
    ].flat();
    dressing.forEach((mesh) => kit.mirrorHidden.push(mesh));
    tuft(leaves.near, CELLS.strap, [9.05, 0.68, 7.35], 0.7, high ? 12 : 8, 911, [1, 1, 0.95], 5.6);
  }

  // ---- Leaves: one mesh for those beside the range, one for the rest -------------------
  for (const [name, out] of Object.entries(leaves)) {
    if (!out.i.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(out.p, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(out.n, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(out.u, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(out.c, 3));
    geometry.setAttribute("sway", new THREE.Float32BufferAttribute(out.s, 2));
    geometry.setIndex(out.i);
    const mesh = new THREE.Mesh(geometry, leafMaterial);
    mesh.name = `glasshouse-leaves-${name}`;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.walkThrough = true;
    scene.add(mesh);
    track(geometry);
  }

  flush();

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xd3e6f2, 0x8b9072, 1.0));
  const sun = kit.sunLight({ color: 0xfff3df, intensity: 7.5, toSun: TO_SUN, extent: 31, distance: 60, near: 8, far: 120, radius: high ? 1.6 : 2.5 });
  // The house is longer than the range: the map is centred on it, and is no taller than it needs to be.
  sun.target.position.set(0, 0, -15.4);
  sun.position.copy(sun.target.position).addScaledVector(TO_SUN, 60);
  sun.shadow.camera.top = 25; sun.shadow.camera.bottom = -25;
  sun.shadow.camera.updateProjectionMatrix();
  // The east wall stands in its own shade; what lights it is the sun thrown back off the tiles.
  const fills = ([[6.6, 2.6, 7.4, 15], [6.4, 2.8, -4.5, 17], [6.4, 2.8, -19.5, 17]] as Array<[number, number, number, number]>).slice(0, high ? 3 : 2).map(([x, y, z, power]) => {
    const fill = new THREE.PointLight(0xffe6c8, power, 15, 2);
    fill.position.set(x, y, z);
    scene.add(fill);
    return fill;
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 380, x: 18, y: [0.3, 7], z: [-28, 8], color: 0xfff2d8, opacity: 0.16 });

  // ---- Motion and life -----------------------------------------------------------
  // Misters: a timer opens each spray for some seconds. The mist falls from the rose, spreads and
  // drifts on the draught; while it hangs there the air round it takes the sun.
  life.plume("steam", MISTERS.map(([x, y, z]) => [x, y - 0.1, z] as V3), { rise: -2.7, life: 5.2, lean: 2.2, size: [0.14, 2.4], color: 0xf1f6f1, opacity: 0.3, density: 16, burst: { every: 23, length: MIST_SECONDS } });
  // The west spray stands in the sun; the east one in the shade of its wall, lit through the windows.
  const mistAir: Glow[] = MISTERS.map(([x, y, z]) => ({ position: new THREE.Vector3(x * 0.9, y - 1.5, z), color: new THREE.Color() }));
  const mistLight = [0.8, 0.3];
  kit.updates.push((now) => {
    clock = now;
    for (let index = 0; index < mistAir.length; index += 1) {
      const t = (now - mistOpened[index]) / 1000, level = THREE.MathUtils.smoothstep(t, 0, 2.5) * (1 - THREE.MathUtils.smoothstep(t, MIST_SECONDS, MIST_SECONDS + 6));
      mistAir[index].color.setRGB(1, 0.96, 0.84).multiplyScalar(mistLight[index] * level);
    }
  });

  // Sparrows in the roof: on the gallery rails and the tie rods, down to the basin to drink.
  life.birds("sparrow", {
    perches: [
      { from: [-(COL_X - 0.88), DECK + 1.205, 6], to: [-(COL_X - 0.88), DECK + 1.205, -7], thin: true },
      { from: [COL_X - 0.88, DECK + 1.205, 3], to: [COL_X - 0.88, DECK + 1.205, -13], thin: true },
      { from: [-6, SPRING + 0.067, 1], to: [6, SPRING + 0.067, 1], thin: true },
      { from: [-5, SPRING + 0.067, -5], to: [5, SPRING + 0.067, -5], thin: true },
      { from: [-6, SPRING + 0.067, -11], to: [6, SPRING + 0.067, -11], thin: true },
      [8.44, 0.56, 5.0], [8.52, 0.56, 6.1], [-7.4, 0.9, 9.2],
    ],
    count: 11,
    roam: { x: [-7.5, 7.5], y: [8.4, 12.2], z: [-22, 7] },
    from: [flapAt.x, flapAt.y - 0.4, flapAt.z],
  });
  // Old leaves let go and come down through the light.
  life.drift("leaves", { volume: { x: [-9, 9], y: [0, 8.6], z: [-25, 9] }, count: 22, colors: [0x7f8f3c, 0xa58d3e, 0x5f7c36, 0x8a6a34], falling: 0.85, scale: 1.1 });
  // The winding chain hangs free and stirs.
  life.sway(chain, { amplitude: 0.035, period: 4.4, axis: "both", creak: "chainRattle", damping: 0.05 });

  // Condensation gathers on the tie rods and the gallery and drips to the floor: a streak, a ring, a tick.
  {
    const sites = ([[-3.2, SPRING, 1], [2.4, SPRING, -5], [-8.3, DECK, 3.2], [4.2, SPRING, 1], [-5.6, SPRING, -11], [8.3, DECK, -1.4], [0.9, SPRING, 7], [5.8, SPRING, -5]] as V3[]).slice(0, high ? 8 : 4);
    const drop = new THREE.InstancedMesh(track(new THREE.CylinderGeometry(0.007, 0.012, 0.26, 5)), track(new THREE.MeshBasicMaterial({ color: 0xf2faf6, transparent: true, opacity: 0.85, depthWrite: false })), sites.length);
    const ring = new THREE.InstancedMesh(track(new THREE.RingGeometry(0.72, 1, 20).rotateX(-HALF)), track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })), sites.length);
    const period = sites.map((_, i) => 3.3 + ((i * 2.37) % 3.6)), offset = sites.map((_, i) => (i * 1.713) % 5), landed = sites.map(() => -1);
    const matrix = new THREE.Matrix4(), turn = new THREE.Quaternion(), size = new THREE.Vector3(), place = new THREE.Vector3(), tint = new THREE.Color();
    for (const mesh of [drop, ring]) { mesh.frustumCulled = false; scene.add(mesh); kit.mirrorHidden.push(mesh); kit.probeHidden.push(mesh); }
    // Where each has been falling the tiles stay dark and wet.
    const damp = track(new THREE.MeshStandardMaterial({ color: 0x241b14, roughness: 0.06, metalness: 0, envMapIntensity: 1.4, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    const pools = mergeGeometries(sites.map(([x, , z], i) => new THREE.CircleGeometry(0.3, 16).rotateX(-HALF).scale(1 + (i % 3) * 0.25, 1, 0.8 + (i % 2) * 0.3).rotateY(i * 1.3).translate(x, 0.006, z)));
    if (pools) {
      const wet = new THREE.Mesh(track(pools), damp);
      wet.receiveShadow = true;
      scene.add(wet);
      kit.mirrorHidden.push(wet);
    }
    kit.updates.push((now) => {
      const t = now / 1000;
      for (let i = 0; i < sites.length; i += 1) {
        const [x, top, z] = sites[i], cycle = (t + offset[i]) / period[i], n = Math.floor(cycle), since = (cycle - n) * period[i], fall = Math.sqrt(top / 4.9), age = since - fall;
        place.set(x, Math.max(0.1, top - 4.9 * since * since), z); size.set(1, age < 0 ? 0.6 + since * 2.6 : 0.0001, 1);
        drop.setMatrixAt(i, matrix.compose(place, turn, size));
        const spread = age > 0 && age < 1.2 ? age / 1.2 : -1, reach = spread < 0 ? 0.0001 : 0.03 + spread * 0.22;
        place.set(x, 0.014, z); size.set(reach, 1, reach);
        ring.setMatrixAt(i, matrix.compose(place, turn, size));
        ring.setColorAt(i, tint.setScalar(spread < 0 ? 0 : (1 - spread) * (1 - spread) * 1.1));
        if (age > 0 && landed[i] !== n) {
          landed[i] = n;
          if (age < 0.25) options.cue?.("drip", place, { gain: 0.5 + (i % 3) * 0.15, pitch: 0.88 + ((n * 0.37 + i * 0.21) % 1) * 0.3 });
        }
      }
      drop.instanceMatrix.needsUpdate = true; ring.instanceMatrix.needsUpdate = true;
      if (ring.instanceColor) ring.instanceColor.needsUpdate = true;
    });
  }

  // The fountain runs, the loose sash works on its stay, and now and then a gust is heard in the big leaves.
  {
    const rustles = [new THREE.Vector3(-9, 2.6, 1.5), new THREE.Vector3(9, 2.6, 3.1), new THREE.Vector3(-9, 2.2, -5), new THREE.Vector3(9, 2.4, -5), new THREE.Vector3(-9, 2.8, -23)];
    let rustleNext = 5000, rattleNext = 9000;
    kit.updates.push((now) => {
      const t = now / 1000;
      waterTime.value = t;
      const gust = wind.at(flapAt.x, flapAt.z), open = 0.34 + 0.13 * Math.sin(t * 0.83) + 0.05 * Math.sin(t * 2.1 + 1) + gust * 0.5;
      flap.rotation.z = SASH.mid - open;
      if (open > 0.5 && now > rattleNext) { rattleNext = now + 16000; options.cue?.("chainRattle", flapAt, { gain: 0.4, pitch: 1.1 }); }
      if (now > rustleNext) {
        const at = rustles[Math.floor(now / 977) % rustles.length], strength = wind.at(at.x, at.z);
        rustleNext = now + 6000 + ((now * 0.37) % 9000);
        if (strength > 0.11) options.cue?.("leafRustle", at, { gain: Math.min(1, 0.3 + strength * 1.6), pitch: 0.9 + (Math.floor(now / 977) % 3) * 0.1 });
      }
    });
  }

  // Direct sun at a point: off behind the east wall and the back wall, and dimmed where a rib stands in the way.
  const shaded = [
    new THREE.Box3(new THREE.Vector3(WALL, 0, Z_END), new THREE.Vector3(WALL + WALL_T, WALL_TOP + 0.1, Z_BACK)),
    new THREE.Box3(new THREE.Vector3(-COL_X, 0, Z_BACK - 0.3), new THREE.Vector3(COL_X, 8.8, Z_BACK + 0.3)),
  ];
  const ray = new THREE.Ray(new THREE.Vector3(), TO_SUN.clone());
  const sunlitAt = (point: THREE.Vector3) => {
    ray.origin.copy(point);
    for (const zone of shaded) if (ray.intersectsBox(zone)) return 0;
    const rise = 12 - point.y, z = point.z + (TO_SUN.z / TO_SUN.y) * rise, bay = (((Z_BACK - z) / BAY) % 1 + 1) % 1;
    return Math.min(bay, 1 - bay) < 0.035 ? 0.35 : 0.92;
  };

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: mistAir,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 2, skyRotation: SKY_TURN, skyClamp: 14,
      background: 0x9fc0d8, fog: 0xdfe8dc, fogDensity: high ? 0.0052 : 0.007,
      haze: new THREE.Color(0.045, 0.055, 0.047), hazeDensity: 0.01, hazeCeiling: 12.6, hazeFade: 3,
      environmentIntensity: 1.1, exposure: 0.82, far: 260,
    },
    sunlitAt,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck: life.struck };
}

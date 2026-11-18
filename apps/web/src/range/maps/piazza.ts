import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial } from "../pbr";
import {
  archedWall, BRAND, canvasTexture, crateGeometry, createKit, projectUv, softBox, STRIKE_ORANGE, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";

// Piazza: an old-town square at low sun, just after rain.
//
// Lighting model: one low golden sun, matched to the sky's own, comes over a
// garden wall on the right and lands on the tall plaster fronts on the left, so
// the showpiece side is fully lit and its colour bounces back into the shade.
// The cobbles are wet: puddles mirror the lit fronts, the sky and the festoon
// bulbs strung across the square. The right side stays low on purpose (a wall
// of height H shades 2.66·H metres of ground), and a gap beside the firing line
// lets a diagonal swathe of sun reach the middle of the square.

/** Direction to the sun in `tears_of_steel_bridge-2k.hdr`. */
const TO_SUN = new THREE.Vector3(0.820, 0.311, 0.480).normalize();
const LEFT = -9.54, RIGHT = 9.54;
/** Upper storeys sit a hand behind the stone ground floor. */
const UPPER = LEFT - 0.06;
const BAND = 4.5;

type V3 = [number, number, number];
type Face = { x: number; z: number; yaw: number };

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

/** A point on a wall face: `s` metres along it, `out` metres proud of it. */
function at(face: Face, s: number, y: number, out: number): V3 {
  const c = Math.cos(face.yaw), n = Math.sin(face.yaw);
  return [face.x + s * c + out * n, y, face.z - s * n + out * c];
}

function merge(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts.map((part) => part.index ? part.toNonIndexed() : part));
  parts.forEach((part) => part.dispose());
  return merged;
}

function rod(a: V3, b: V3, radius: number, segments = 6) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), segments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return geometry;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return geometry;
}

/** A colour canvas and a tangent-space normal map derived from a painted height canvas. */
function reliefTextures(size: number, colour: (context: CanvasRenderingContext2D) => void, height: (context: CanvasRenderingContext2D) => void, strength: number) {
  const map = canvasTexture(size, size, colour, true);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "#000";
  context.fillRect(0, 0, size, size);
  height(context);
  const source = context.getImageData(0, 0, size, size), target = context.createImageData(size, size);
  const h = (x: number, y: number) => source.data[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const length = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
    target.data[i] = (-dx / length * 0.5 + 0.5) * 255;
    target.data[i + 1] = (dy / length * 0.5 + 0.5) * 255;
    target.data[i + 2] = (1 / length * 0.5 + 0.5) * 255;
    target.data[i + 3] = 255;
  }
  context.putImageData(target, 0, 0);
  const normalMap = new THREE.CanvasTexture(canvas);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  return { map, normalMap };
}

/** Clay pantiles: eight half-round columns and four courses per tile of texture. */
function roofTextures() {
  const random = rng(7);
  return reliefTextures(512, (context) => {
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 8; column += 1) {
      const x = column * 64, y = row * 128, tone = 0.72 + random() * 0.5, moss = random() < 0.12;
      const r = Math.round(176 * tone), g = Math.round((moss ? 104 : 92) * tone), b = Math.round((moss ? 62 : 56) * tone);
      const across = context.createLinearGradient(x, 0, x + 64, 0);
      across.addColorStop(0, `rgb(${r * 0.42 | 0},${g * 0.4 | 0},${b * 0.4 | 0})`);
      across.addColorStop(0.22, `rgb(${r},${g},${b})`);
      across.addColorStop(0.55, `rgb(${Math.min(255, r * 1.12) | 0},${g * 1.1 | 0},${b * 1.08 | 0})`);
      across.addColorStop(1, `rgb(${r * 0.45 | 0},${g * 0.42 | 0},${b * 0.42 | 0})`);
      context.fillStyle = across;
      context.fillRect(x, y, 64, 128);
      context.fillStyle = "rgba(20,10,6,.55)";
      context.fillRect(x, y + 120, 64, 8);
    }
    for (let i = 0; i < 2600; i += 1) {
      const shade = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},.05)`;
      context.fillRect(random() * 512, random() * 512, 2, 2 + random() * 10);
    }
  }, (context) => {
    for (let column = 0; column < 8; column += 1) {
      const across = context.createLinearGradient(column * 64, 0, column * 64 + 64, 0);
      across.addColorStop(0, "#000"); across.addColorStop(0.5, "#fff"); across.addColorStop(1, "#000");
      context.fillStyle = across;
      context.fillRect(column * 64, 0, 64, 512);
    }
    context.globalCompositeOperation = "multiply";
    for (let row = 0; row < 4; row += 1) {
      const down = context.createLinearGradient(0, row * 128, 0, row * 128 + 128);
      down.addColorStop(0, "#777"); down.addColorStop(1, "#fff");
      context.fillStyle = down;
      context.fillRect(0, row * 128, 512, 128);
    }
    context.globalCompositeOperation = "source-over";
  }, 2.4);
}

/** Rusticated ashlar: joint relief and joint grime for the stone ground floor (four courses per tile). */
function ashlarTextures() {
  const joints = (context: CanvasRenderingContext2D, colour: string, width: number) => {
    context.strokeStyle = colour;
    context.lineWidth = width;
    for (let row = 0; row <= 4; row += 1) {
      context.beginPath(); context.moveTo(0, row * 64); context.lineTo(256, row * 64); context.stroke();
      const shift = row % 2 ? 64 : 0;
      for (let x = shift; x <= 256; x += 128) { context.beginPath(); context.moveTo(x, row * 64); context.lineTo(x, row * 64 + 64); context.stroke(); }
    }
  };
  const random = rng(19);
  return reliefTextures(256, (context) => {
    // Read as an occlusion map: white stone, grey joints, faint block-to-block variation.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 4; row += 1) for (let block = -1; block < 2; block += 1) {
      const tone = 215 + Math.round(random() * 40);
      context.fillStyle = `rgb(${tone},${tone},${tone})`;
      context.fillRect(block * 128 + (row % 2 ? 64 : 0), row * 64, 128, 64);
    }
    context.filter = "blur(2px)";
    joints(context, "#3a3a3a", 7);
    context.filter = "none";
  }, (context) => {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 256, 256);
    context.filter = "blur(2.5px)";
    joints(context, "#000", 9);
    context.filter = "none";
  }, 2.2);
}

/** A louvred shutter leaf, painted light so the instance colour tints it. */
function shutterTextures() {
  const slats = (context: CanvasRenderingContext2D, face: string, shadow: string, stile: string) => {
    context.fillStyle = stile;
    context.fillRect(0, 0, 128, 256);
    for (const [top, bottom] of [[14, 122], [134, 242]]) for (let y = top; y < bottom; y += 9) {
      const slat = context.createLinearGradient(0, y, 0, y + 9);
      slat.addColorStop(0, face); slat.addColorStop(0.7, face); slat.addColorStop(1, shadow);
      context.fillStyle = slat;
      context.fillRect(14, y, 100, 9);
    }
  };
  const random = rng(5);
  return reliefTextures(256, (context) => {
    context.save(); context.scale(2, 1);
    slats(context, "#e9e9e9", "#3c3c3c", "#d2d2d2");
    context.restore();
    for (let i = 0; i < 900; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.03 + random() * 0.06})`;
      context.fillRect(random() * 256, random() * 256, 1 + random() * 2, 3 + random() * 14);
    }
  }, (context) => {
    context.save(); context.scale(2, 1);
    slats(context, "#888", "#000", "#fff");
    context.restore();
  }, 1.6);
}

/** Vertical awning stripes with a woven, sun-faded finish. */
function stripeTexture(base: string, stripe: string, accent: string) {
  return canvasTexture(256, 128, (context) => {
    context.fillStyle = base;
    context.fillRect(0, 0, 256, 128);
    for (let x = 0; x < 256; x += 64) {
      context.fillStyle = stripe; context.fillRect(x + 6, 0, 26, 128);
      context.fillStyle = accent; context.fillRect(x + 44, 0, 5, 128);
    }
    const random = rng(91);
    for (let i = 0; i < 3200; i += 1) {
      const shade = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},.05)`;
      context.fillRect(random() * 256, random() * 128, 1, 2 + random() * 12);
    }
  }, true);
}

/** A card of loose leaves on a clear background. */
function leafTexture(hue: [number, number, number]) {
  const texture = canvasTexture(256, 256, (context) => {
    context.clearRect(0, 0, 256, 256);
    const random = rng(41);
    for (let i = 0; i < 120; i += 1) {
      const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * 112;
      const tone = 0.5 + random() * 0.75;
      context.fillStyle = `rgb(${Math.round(hue[0] * tone)},${Math.round(hue[1] * tone)},${Math.round(hue[2] * tone)})`;
      context.save();
      context.translate(128 + Math.cos(angle) * radius, 128 + Math.sin(angle) * radius);
      context.rotate(random() * Math.PI);
      context.beginPath(); context.ellipse(0, 0, 9 + random() * 9, 4 + random() * 4, 0, 0, Math.PI * 2); context.fill();
      context.restore();
    }
  });
  texture.anisotropy = 4;
  return texture;
}

/** A warm room seen through glass: lamp glow, a curtain and a hint of a ceiling. */
function litWindowTexture() {
  return canvasTexture(64, 128, (context) => {
    const glow = context.createRadialGradient(40, 50, 4, 32, 64, 90);
    glow.addColorStop(0, "#ffe2a6"); glow.addColorStop(0.5, "#e59a45"); glow.addColorStop(1, "#7a3c14");
    context.fillStyle = glow;
    context.fillRect(0, 0, 64, 128);
    context.fillStyle = "rgba(255,236,200,.5)";
    context.fillRect(0, 0, 17, 128);
    context.fillStyle = "rgba(70,30,10,.4)";
    for (let x = 3; x < 17; x += 5) context.fillRect(x, 0, 1.5, 128);
    context.fillRect(0, 96, 64, 3);
  });
}

/** Tower clock dial: bold hour batons, no numerals. */
function clockTexture() {
  return canvasTexture(256, 256, (context) => {
    context.fillStyle = "#efe6cf";
    context.beginPath(); context.arc(128, 128, 126, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "#2c7f79"; context.lineWidth = 7;
    context.beginPath(); context.arc(128, 128, 118, 0, Math.PI * 2); context.stroke();
    context.strokeStyle = "#221c16"; context.lineWidth = 2;
    context.beginPath(); context.arc(128, 128, 84, 0, Math.PI * 2); context.stroke();
    for (let hour = 0; hour < 12; hour += 1) {
      context.save(); context.translate(128, 128); context.rotate(hour * Math.PI / 6);
      context.fillStyle = "#221c16";
      context.fillRect(hour % 3 ? -3 : -6, -110, hour % 3 ? 6 : 12, 22);
      context.restore();
    }
    const hand = (angle: number, length: number, width: number) => {
      context.save(); context.translate(128, 128); context.rotate(angle);
      context.fillStyle = "#17120e";
      context.beginPath(); context.moveTo(-width, 14); context.lineTo(-width * 0.4, -length); context.lineTo(width * 0.4, -length); context.lineTo(width, 14); context.closePath(); context.fill();
      context.restore();
    };
    hand(5.55 * Math.PI / 6, 62, 7);
    hand(8.6 * Math.PI / 6 + Math.PI, 98, 5);
    context.fillStyle = "#b9722c";
    context.beginPath(); context.arc(128, 128, 9, 0, Math.PI * 2); context.fill();
  });
}

/** A wall slab on y = 0, centred on x, with round-headed doorways cut up from the ground as part of its outline. */
function arcadeWall(width: number, height: number, thickness: number, openings: Array<{ x: number; width: number; spring: number }>, metres: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  for (const opening of [...openings].sort((a, b) => a.x - b.x)) {
    const half = opening.width / 2;
    shape.lineTo(opening.x - half, 0);
    shape.lineTo(opening.x - half, opening.spring);
    shape.absarc(opening.x, opening.spring, half, Math.PI, 0, true);
    shape.lineTo(opening.x + half, 0);
  }
  shape.lineTo(width / 2, 0); shape.lineTo(width / 2, height); shape.lineTo(-width / 2, height); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 14 });
  geometry.translate(0, 0, -thickness / 2);
  return projectUv(geometry, metres);
}

/** Hip roof with its eave at y = 0, ridge along the longer side; UVs run up each slope. */
function hipRoof(w: number, d: number, rise: number, tile = 1.7) {
  const alongX = w >= d, L = alongX ? w : d, S = alongX ? d : w, r = (L - S) / 2, slope = Math.hypot(rise, S / 2) / tile;
  const e: V3[] = [[-L / 2, 0, -S / 2], [L / 2, 0, -S / 2], [L / 2, 0, S / 2], [-L / 2, 0, S / 2]], a: V3 = [-r, rise, 0], b: V3 = [r, rise, 0];
  const positions: number[] = [], uvs: number[] = [];
  const tri = (p: V3[], uv: Array<[number, number]>) => { p.forEach((point) => positions.push(...point)); uv.forEach((pair) => uvs.push(...pair)); };
  tri([e[3], e[2], b], [[-L / 2 / tile, 0], [L / 2 / tile, 0], [r / tile, slope]]);
  tri([e[3], b, a], [[-L / 2 / tile, 0], [r / tile, slope], [-r / tile, slope]]);
  tri([e[1], e[0], a], [[-L / 2 / tile, 0], [L / 2 / tile, 0], [r / tile, slope]]);
  tri([e[1], a, b], [[-L / 2 / tile, 0], [r / tile, slope], [-r / tile, slope]]);
  tri([e[2], e[1], b], [[-S / 2 / tile, 0], [S / 2 / tile, 0], [0, slope]]);
  tri([e[0], e[3], a], [[-S / 2 / tile, 0], [S / 2 / tile, 0], [0, slope]]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (!alongX) geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** Stone window surround: frame, sill and a moulded head. Origin at the window centre on the wall plane, +z out. */
function surroundGeometry(w: number, h: number, head: boolean) {
  const shape = new THREE.Shape();
  const ow = w / 2 + 0.17, oh = h / 2 + 0.17;
  shape.moveTo(-ow, -oh); shape.lineTo(ow, -oh); shape.lineTo(ow, oh); shape.lineTo(-ow, oh); shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-w / 2, -h / 2); hole.lineTo(-w / 2, h / 2); hole.lineTo(w / 2, h / 2); hole.lineTo(w / 2, -h / 2); hole.closePath();
  shape.holes.push(hole);
  const parts: THREE.BufferGeometry[] = [
    new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false }),
    box(w + 0.62, 0.11, 0.24, 0, -oh - 0.055, 0.12),
  ];
  if (head) parts.push(box(w + 0.5, 0.1, 0.16, 0, oh + 0.13, 0.08), box(w + 0.74, 0.09, 0.26, 0, oh + 0.225, 0.13));
  else parts.push(box(w + 0.46, 0.1, 0.16, 0, oh + 0.05, 0.08));
  return projectUv(merge(parts), 1.6);
}

/** Balcony stone: slab on two scrolled corbels. Origin at the door threshold on the wall plane. */
function balconyStone() {
  return projectUv(merge([
    box(2.14, 0.14, 0.82, 0, -0.07, 0.41),
    box(2.02, 0.06, 0.74, 0, -0.17, 0.37),
    box(0.16, 0.34, 0.5, -0.78, -0.37, 0.25), box(0.16, 0.34, 0.5, 0.78, -0.37, 0.25),
    box(0.16, 0.16, 0.24, -0.78, -0.62, 0.12), box(0.16, 0.16, 0.24, 0.78, -0.62, 0.12),
  ]), 1.6);
}

/** Balcony ironwork: rails, pickets and a row of rings under the handrail. */
function balconyIron() {
  const parts: THREE.BufferGeometry[] = [];
  for (const y of [0.06, 0.82, 1.0]) {
    parts.push(box(2.06, 0.028, 0.028, 0, y, 0.76));
    for (const side of [-1, 1]) parts.push(box(0.028, 0.028, 0.76, side * 1.03, y, 0.38));
  }
  for (let i = 0; i < 17; i += 1) parts.push(box(0.016, 0.78, 0.016, -0.96 + i * 0.12, 0.44, 0.76));
  for (let i = 0; i < 6; i += 1) for (const side of [-1, 1]) parts.push(box(0.016, 0.78, 0.016, side * 1.03, 0.44, 0.1 + i * 0.12));
  for (let i = 0; i < 8; i += 1) {
    const ring = new THREE.TorusGeometry(0.075, 0.009, 4, 12);
    ring.translate(-0.84 + i * 0.24, 0.91, 0.76);
    parts.push(ring);
  }
  for (const side of [-1, 1]) parts.push(box(0.04, 1.06, 0.04, side * 1.03, 0.53, 0.76));
  return merge(parts);
}

/** Wall lantern: scrolled bracket and a caged lamp hanging 0.42 m out from the wall plane. */
function lanternIron() {
  const parts: THREE.BufferGeometry[] = [rod([0, 0.32, 0], [0, 0.32, 0.46], 0.016), rod([0, 0.02, 0.02], [0, 0.32, 0.3], 0.012), box(0.06, 0.44, 0.03, 0, 0.18, 0.015), rod([0, 0.32, 0.42], [0, 0.2, 0.42], 0.01)];
  const cap = new THREE.ConeGeometry(0.17, 0.12, 4);
  cap.rotateY(Math.PI / 4); cap.translate(0, 0.15, 0.42);
  parts.push(cap, box(0.2, 0.025, 0.2, 0, -0.2, 0.42));
  for (const x of [-0.095, 0.095]) for (const z of [-0.095, 0.095]) parts.push(box(0.014, 0.3, 0.014, x, -0.05, 0.42 + z));
  return merge(parts);
}

/** Spoked wheel in the XY plane: [tyre, metalwork]. */
function wheelGeometry(radius: number, tyre: number, spokes: number, spoke: number) {
  const metal: THREE.BufferGeometry[] = [new THREE.TorusGeometry(radius - tyre * 1.4, tyre * 0.55, 5, 28)];
  for (let i = 0; i < spokes; i += 1) {
    const angle = i * Math.PI / spokes, x = Math.cos(angle) * (radius - tyre * 1.5), y = Math.sin(angle) * (radius - tyre * 1.5);
    metal.push(rod([-x, -y, 0], [x, y, 0], spoke, 4));
  }
  const hub = new THREE.CylinderGeometry(tyre * 1.6, tyre * 1.6, tyre * 5, 10);
  hub.rotateX(Math.PI / 2);
  metal.push(hub);
  return [new THREE.TorusGeometry(radius, tyre, 8, 30), merge(metal)] as const;
}

/** Italian-cypress silhouette, one unit tall, with a lumpy outline. */
function cypressGeometry() {
  const profile = [[0, 0], [0.07, 0.01], [0.115, 0.1], [0.13, 0.26], [0.125, 0.45], [0.1, 0.66], [0.062, 0.84], [0.024, 0.96], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y));
  const geometry = new THREE.LatheGeometry(profile, 14);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i), angle = Math.atan2(z, x);
    const lump = 1 + 0.16 * Math.sin(angle * 3 + y * 31) + 0.1 * Math.sin(angle * 5 - y * 47);
    position.setXYZ(i, x * lump, y, z * lump);
  }
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 6);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildPiazza(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, place } = kit;
  const metals = kit.metals();
  const random = rng(2026);
  /** Instancing that tolerates an empty list. */
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], hit = false, shadow = true) =>
    transforms.length ? kit.instances(geometry, material, transforms, hit, shadow) : null;

  // ---- Materials -----------------------------------------------------------
  const cobble = photoSet("/textures/cobblestone_floor_04-2k", 150 / 2.1, 130 / 2.1, false);
  const plaster = photoSet("/textures/painted_plaster_wall-1k", 1, 1, false);
  const concrete = photoSet("/textures/concrete_floor_worn_001-2k", 0.8, 0.8);
  const brick = photoSet("/textures/brick_wall_001-2k", 1, 1);
  const plasterMaterial = (color: number, normal = 1) => new THREE.MeshStandardMaterial({ ...plaster, color, normalScale: new THREE.Vector2(normal, normal), roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const stone = new THREE.MeshStandardMaterial({ ...concrete, color: new THREE.Color(1.5, 1.36, 1.12), roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xcdbd9c, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  const ashlarSet = ashlarTextures();
  track(ashlarSet.map); track(ashlarSet.normalMap);
  ashlarSet.map.colorSpace = THREE.NoColorSpace;
  ashlarSet.map.anisotropy = ashlarSet.normalMap.anisotropy = anisotropy;
  const ashlar = new THREE.MeshStandardMaterial({ map: concrete.map, roughnessMap: concrete.roughnessMap, normalMap: ashlarSet.normalMap, normalScale: new THREE.Vector2(1.1, 1.1), aoMap: ashlarSet.map, aoMapIntensity: 1.3, color: new THREE.Color(1.5, 1.33, 1.06), roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  const brickMaterial = (color: number) => new THREE.MeshStandardMaterial({ ...brick, color, roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const gardenBrick = brickMaterial(0xd9b596), towerBrick = brickMaterial(0xe0b48c);
  const roofSet = roofTextures();
  track(roofSet.map); track(roofSet.normalMap);
  roofSet.map.anisotropy = roofSet.normalMap.anisotropy = anisotropy;
  const roofs = [0xffffff, 0xe2cdbb, 0xf3d9c4].map((color) => new THREE.MeshStandardMaterial({ ...roofSet, color, roughness: 0.82, metalness: 0, envMapIntensity: 0.6, side: THREE.DoubleSide }));
  const shutterSet = shutterTextures();
  track(shutterSet.map); track(shutterSet.normalMap);
  shutterSet.map.anisotropy = anisotropy;
  const shutterMaterial = new THREE.MeshStandardMaterial({ ...shutterSet, roughness: 0.62, metalness: 0, envMapIntensity: 0.7 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x10171c, roughness: 0.06, metalness: 0, envMapIntensity: 1.6 });
  const litMap = track(litWindowTexture());
  const litGlass = new THREE.MeshBasicMaterial({ map: litMap, color: new THREE.Color(2.3, 2.0, 1.6), toneMapped: false });
  const sash = new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.6, metalness: 0 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.55, metalness: 0.85, envMapIntensity: 1 });
  const eaveWood = new THREE.MeshStandardMaterial({ color: 0x4a3423, roughness: 0.9, metalness: 0, envMapIntensity: 0.4 });
  const shade = new THREE.MeshStandardMaterial({ color: 0x0c0a08, roughness: 1, metalness: 0, envMapIntensity: 0.1 });
  const terracotta = new THREE.MeshStandardMaterial({ color: 0xb8643a, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.74, metalness: 0, envMapIntensity: 0.6 });
  const doorPaint = new THREE.MeshStandardMaterial({ color: 0x1f4a40, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.42, metalness: 0, envMapIntensity: 0.8 });
  const cafeMetal = pbrMaterial(keep(paintedSteel(anisotropy, [0.5, 0.86, 0.79], 97, 0.35, 256)), { metalness: 0.3, envMapIntensity: 1 });
  const bulb = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.7, 0.36).multiplyScalar(4.2), toneMapped: false });
  const lampGlass = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.74, 0.42).multiplyScalar(3.2), toneMapped: false });
  const copper = new THREE.MeshStandardMaterial({ color: 0x4f6a5e, roughness: 0.55, metalness: 0.7, envMapIntensity: 0.9 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.85, metalness: 0 });

  // ---- Ground --------------------------------------------------------------
  const ground = new THREE.MeshStandardMaterial({ ...cobble, color: 0xe6dccb, normalScale: new THREE.Vector2(1.5, 1.5), roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const reflection = kit.floor(ground, { width: 150, depth: 130, z: -12 }, {
    lane: new THREE.Color(0.82, 0.78, 0.68),
    edge: new THREE.Color(0.82, 0.78, 0.68),
    markings: 0,
    wet: 0.02,
  });

  // ---- Shared façade kit ---------------------------------------------------
  type WindowType = { w: number; h: number; head: boolean; surround: Transform[]; dark: Transform[]; lit: Transform[]; bars: Transform[]; leaves: Transform[]; colours: number[] };
  const windowType = (w: number, h: number, head: boolean): WindowType => ({ w, h, head, surround: [], dark: [], lit: [], bars: [], leaves: [], colours: [] });
  const tall = windowType(1.15, 2.3, true), small = windowType(1.05, 1.3, false);
  const balconies: Transform[] = [], cornices: Transform[] = [], eaves: Transform[] = [], courses: Transform[] = [], rafters: Transform[] = [], chimneys: Transform[] = [], pots: Transform[] = [];

  const addWindow = (face: Face, s: number, y0: number, type: WindowType, o: { shutter?: number; colour?: number; lit?: boolean; balcony?: boolean } = {}) => {
    const y = y0 + type.h / 2, rotation: V3 = [0, face.yaw, 0];
    type.surround.push({ position: at(face, s, y, 0), rotation });
    (o.lit ? type.lit : type.dark).push({ position: at(face, s, y, 0.02), rotation });
    type.bars.push({ position: at(face, s, y, 0.05), rotation });
    if (o.shutter !== undefined) for (const side of [-1, 1]) {
      const hinge = side * (type.w / 2 + 0.02);
      type.leaves.push({ position: at(face, hinge - side * Math.cos(o.shutter) * type.w / 4, y, 0.1 + Math.sin(o.shutter) * type.w / 4), rotation: [0, face.yaw + side * o.shutter, 0] });
      type.colours.push(o.colour ?? 0x4a6a54);
    }
    if (o.balcony) balconies.push({ position: at(face, s, y0, 0), rotation });
  };
  /** Rows of windows across a face with a believable mix of open, ajar and closed shutters. */
  const fenestrate = (face: Face, from: number, to: number, levels: Array<{ y: number; type: WindowType }>, colour: number, o: { balconies?: Array<[number, number]>; lit?: number; pitch?: number } = {}) => {
    const columns = Math.max(1, Math.round((to - from) / (o.pitch ?? 3.1)));
    levels.forEach((level, row) => {
      for (let column = 0; column < columns; column += 1) {
        const s = from + (column + 0.5) * (to - from) / columns, roll = random();
        const balcony = !!o.balconies?.some(([c, r]) => c === column && r === row);
        const shutter = roll < 0.5 ? Math.PI - 0.07 : roll < 0.68 ? 0.9 + random() * 0.8 : roll < 0.9 ? 0 : undefined;
        addWindow(face, s, level.y, level.type, { shutter: balcony && shutter === 0 ? Math.PI - 0.07 : shutter, colour, balcony, lit: shutter !== 0 && random() < (o.lit ?? 0.14) });
      }
    });
  };
  /** A plastered block with cornice, timber eaves and a tiled hip roof. */
  const building = (x0: number, x1: number, z0: number, z1: number, h: number, material: THREE.Material, rise = 2.2, chimney = true) => {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    place(new THREE.Mesh(worldBox(w, h, d, 3.2), material), cx, h / 2, cz, true);
    cornices.push({ position: [cx, h - 0.24, cz], scale: [w + 0.36, 0.3, d + 0.36] }, { position: [cx, h - 0.52, cz], scale: [w + 0.18, 0.26, d + 0.18] });
    eaves.push({ position: [cx, h - 0.03, cz], scale: [w + 1.1, 0.12, d + 1.1] });
    place(new THREE.Mesh(hipRoof(w + 1.2, d + 1.2, rise), roofs[Math.floor(random() * roofs.length)]), cx, h + 0.03, cz, true);
    if (chimney) {
      const along = w >= d, shift = (random() - 0.5) * (along ? w : d) * 0.5;
      const px = cx + (along ? shift : 0.8), pz = cz + (along ? 0.8 : shift);
      chimneys.push({ position: [px, h + rise * 0.6 + 0.5, pz], scale: [0.7, rise * 0.8 + 1.6, 0.95] });
      cornices.push({ position: [px, h + rise + 1.33, pz], scale: [0.9, 0.1, 1.15] });
      pots.push({ position: [px, h + rise + 1.56, pz - 0.22] }, { position: [px, h + rise + 1.56, pz + 0.22] });
    }
  };

  // ---- Left: the sunlit fronts ---------------------------------------------
  const FL: Face = { x: UPPER, z: 0, yaw: Math.PI / 2 };
  // Stone ground floor: dead flat from the far end to the arcade so signs and lamps sit clean on it.
  place(new THREE.Mesh(worldBox(0.5, BAND, 30.8, 2), ashlar), LEFT - 0.25, BAND / 2, -15, true, true);
  const arcade = arcadeWall(9.3, BAND, 0.5, [{ x: -3.2, width: 2.3, spring: 2.4 }, { x: 0, width: 2.3, spring: 2.4 }, { x: 3.2, width: 2.3, spring: 2.4 }], 2);
  arcade.rotateY(Math.PI / 2);
  place(new THREE.Mesh(arcade, ashlar), LEFT - 0.25, 0, 5.05, true, true);
  place(new THREE.Mesh(softBox(0.14, 0.9, 30.4, 0.03, 2), stone), LEFT + 0.03, 0.45, -15.2, false, true);
  // String course above the stone floor, running the whole street.
  place(new THREE.Mesh(worldBox(0.36, 0.26, 41, 2), stone), LEFT - 0.06, BAND + 0.13, -9.9, true);
  place(new THREE.Mesh(worldBox(0.24, 0.1, 41, 2), stone), LEFT - 0.06, BAND + 0.31, -9.9, false);

  const blocks: Array<{ z0: number; z1: number; h: number; wall: number; shutter: number; levels: Array<{ y: number; type: WindowType }>; balconies: Array<[number, number]>; columns: number }> = [
    { z0: -30.4, z1: -20.2, h: 12.7, wall: 0xe0a85a, shutter: 0x4d6f58, levels: [{ y: 5.5, type: tall }, { y: 9.0, type: tall }], balconies: [[1, 0]], columns: 3 },
    { z0: -20.2, z1: -11.2, h: 14.9, wall: 0xcf7f5c, shutter: 0x2f5a66, levels: [{ y: 5.5, type: tall }, { y: 8.9, type: tall }, { y: 12.3, type: small }], balconies: [[1, 0], [1, 1]], columns: 3 },
    { z0: -11.2, z1: -2.2, h: 11.9, wall: 0xecd9b0, shutter: 0x7a5236, levels: [{ y: 5.5, type: tall }, { y: 9.25, type: small }], balconies: [[0, 0], [2, 0]], columns: 3 },
    { z0: -2.2, z1: 10.6, h: 13.5, wall: 0xdc9f86, shutter: 0x3c5a50, levels: [{ y: 5.5, type: tall }, { y: 9.2, type: tall }], balconies: [[1, 0], [2, 0]], columns: 4 },
  ];
  const pipeRuns: Transform[] = [], hoppers: Transform[] = [];
  blocks.forEach((block, index) => {
    const length = block.z1 - block.z0, cz = (block.z0 + block.z1) / 2, wall = plasterMaterial(block.wall);
    // Body: the last block is hollowed at ground level for the arcade.
    if (index < 3) place(new THREE.Mesh(worldBox(10, block.h, length, 3.2), wall), UPPER - 5, block.h / 2, cz, true, true);
    else {
      place(new THREE.Mesh(worldBox(10, block.h - BAND, length, 3.2), wall), UPPER - 5, (block.h + BAND) / 2, cz, true, true);
      place(new THREE.Mesh(worldBox(10, BAND, 2.6, 3.2), wall), UPPER - 5, BAND / 2, -0.9, true, true);
      place(new THREE.Mesh(worldBox(6.4, BAND, 10.2, 3.2), plasterMaterial(0xd8c3a0)), -16.4, BAND / 2, 5.5, true, true);
      place(new THREE.Mesh(worldBox(3.7, BAND, 0.9, 3.2), wall), -11.45, BAND / 2, 10.15, true, true);
    }
    place(new THREE.Mesh(worldBox(0.5, 0.3, length + 0.36, 2), stone), UPPER + 0.07, block.h - 0.24, cz, true);
    place(new THREE.Mesh(worldBox(0.3, 0.26, length + 0.18, 2), stone), UPPER + 0.03, block.h - 0.52, cz, false);
    eaves.push({ position: [UPPER - 5, block.h - 0.03, cz], scale: [11.2, 0.12, length + 0.9] });
    const rise = 2.3 + (index % 2) * 0.4;
    place(new THREE.Mesh(hipRoof(11.4, length + 1.0, rise), roofs[index % roofs.length]), UPPER - 5, block.h + 0.03, cz, true);
    for (let z = block.z0 + 0.3; z < block.z1; z += 0.62) rafters.push({ position: [UPPER + 0.3, block.h - 0.15, z] });
    for (const offset of [-0.22, 0.2]) {
      const pz = cz + offset * length;
      chimneys.push({ position: [UPPER - 3.4, block.h + rise * 0.5 + 0.5, pz], scale: [0.75, rise + 1.5, 1] });
      cornices.push({ position: [UPPER - 3.4, block.h + rise + 1.3, pz], scale: [0.95, 0.1, 1.2] });
      pots.push({ position: [UPPER - 3.4, block.h + rise + 1.53, pz - 0.24] }, { position: [UPPER - 3.4, block.h + rise + 1.53, pz + 0.24] });
    }
    // A thin band under the upper windows.
    for (const level of block.levels.slice(1)) courses.push({ position: [UPPER + 0.03, level.y - 0.42, cz], scale: [0.14, 0.14, length] });
    for (let row = 0; row < block.levels.length; row += 1) for (let column = 0; column < block.columns; column += 1) {
      const z = block.z1 - (column + 0.5) * length / block.columns, roll = random();
      const balcony = block.balconies.some(([c, r]) => c === column && r === row);
      const shutter = balcony || roll < 0.52 ? Math.PI - 0.07 : roll < 0.72 ? 0.8 + random() * 0.9 : roll < 0.92 ? 0 : undefined;
      addWindow(FL, -z, block.levels[row].y, block.levels[row].type, { shutter, colour: block.shutter, balcony, lit: shutter !== 0 && random() < 0.16 });
    }
    if (index > 0) {
      const top = Math.min(block.h, blocks[index - 1].h) - 0.75;
      pipeRuns.push({ position: [UPPER + 0.1, (top + BAND + 0.4) / 2, block.z0], scale: [1, top - BAND - 0.4, 1] });
      hoppers.push({ position: [UPPER + 0.12, top + 0.1, block.z0] });
    }
  });
  instances(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), copper, pipeRuns);
  instances(softBox(0.22, 0.3, 0.26, 0.03, 1), copper, hoppers);
  instances(new THREE.BoxGeometry(0.62, 0.13, 0.09), eaveWood, rafters, false, false);

  // Arcade interior: lit shop fronts behind the arches.
  const shopMap = track(canvasTexture(256, 256, (context) => {
    const glow = context.createLinearGradient(0, 0, 0, 256);
    glow.addColorStop(0, "#ffd58f"); glow.addColorStop(0.6, "#e9a253"); glow.addColorStop(1, "#8a4a1d");
    context.fillStyle = glow;
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = "rgba(60,28,10,.75)";
    for (const y of [92, 150, 208]) context.fillRect(0, y, 256, 6);
    const shelf = rng(3);
    for (const y of [92, 150, 208]) for (let x = 8; x < 248; x += 14 + shelf() * 16) {
      const tall = 14 + shelf() * 30;
      context.fillStyle = `rgba(${90 + shelf() * 120 | 0},${40 + shelf() * 60 | 0},${10 + shelf() * 40 | 0},.8)`;
      context.fillRect(x, y - tall, 8 + shelf() * 8, tall);
    }
    context.fillStyle = "#1c120b";
    context.fillRect(124, 0, 8, 256); context.fillRect(0, 44, 256, 6);
  }));
  const shopGlass = new THREE.MeshBasicMaterial({ map: shopMap, color: new THREE.Color(1.7, 1.5, 1.25), toneMapped: false });
  for (const z of [1.85, 5.05, 8.25]) {
    place(new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.5), shopGlass), -13.18, 1.7, z, false).rotation.y = Math.PI / 2;
    place(new THREE.Mesh(softBox(0.12, 2.9, 2.7, 0.03, 1.4), eaveWood), -13.26, 1.6, z, false);
  }
  place(new THREE.Mesh(softBox(0.2, 0.5, 9.2, 0.04, 1.4), eaveWood), -13.2, 3.35, 5.05, false);

  // Striped awnings over the arches.
  const awningGeometry = (() => {
    const w = 2.56, reach = 1.5, drop = 0.75;
    const cloth = new THREE.PlaneGeometry(w, 1, 10, 1);
    const position = cloth.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const v = position.getY(i) + 0.5, x = position.getX(i);
      position.setXYZ(i, x, -drop * (1 - v) - 0.03 * Math.sin((x / w + 0.5) * Math.PI) * (1 - v), reach * (1 - v));
    }
    const valance = new THREE.PlaneGeometry(w, 0.24, 10, 1);
    valance.translate(0, -drop - 0.12, reach);
    const merged = merge([cloth, valance]);
    merged.computeVertexNormals();
    return merged;
  })();
  const awningMaps = [track(stripeTexture("#efe6d0", "#3f9d92", "#d79a45")), track(stripeTexture("#efe6d0", "#cf7f35", "#2f8f88"))];
  awningMaps.forEach((map) => { map.repeat.set(3, 1); map.anisotropy = anisotropy; });
  [1.85, 5.05, 8.25].forEach((z, index) => {
    const map = awningMaps[index % 2];
    const awning = place(new THREE.Mesh(awningGeometry, new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.22, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4 })), LEFT + 0.02, 4.02, z, true);
    awning.rotation.y = Math.PI / 2;
  });
  instances(merge([rod([0, 0, 0], [0, -0.72, 1.48], 0.012), rod([0, -0.6, 0], [0, -0.72, 1.48], 0.012)]), iron, [0.6, 3.1, 3.8, 6.3, 7.0, 9.5].map((z) => ({ position: [LEFT + 0.02, 4.0, z] as V3, rotation: [0, Math.PI / 2, 0] as V3 })), false, false);

  // A painted street door between the far sign and the corner.
  const doorZ = -23.5;
  place(new THREE.Mesh(surroundGeometry(1.3, 2.6, true), stone), LEFT, 1.3, doorZ, false).rotation.y = Math.PI / 2;
  place(new THREE.Mesh(merge([box(0.05, 2.6, 1.3, 0, 0, 0), box(0.03, 0.9, 0.42, 0.03, 0.62, -0.31), box(0.03, 0.9, 0.42, 0.03, 0.62, 0.31), box(0.03, 0.8, 0.42, 0.03, -0.5, -0.31), box(0.03, 0.8, 0.42, 0.03, -0.5, 0.31)]), doorPaint), LEFT + 0.025, 1.3, doorZ, false, true);
  place(new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), metals.brushed), LEFT + 0.1, 1.15, doorZ + 0.08, false);

  // Wall fountain between the lamp and the corner block.
  const fountainZ = -4.6;
  const pediment = new THREE.CylinderGeometry(1, 1, 0.2, 24, 1, false, 0, Math.PI);
  pediment.rotateZ(Math.PI / 2);
  place(new THREE.Mesh(merge([softBox(0.2, 2.5, 2.0, 0.03, 2), projectUv(pediment.translate(0, 1.25, 0), 2), box(0.3, 0.14, 2.3, 0.03, 1.25, 0), box(0.26, 0.2, 2.2, 0.02, -1.15, 0)]), stone), LEFT + 0.1, 1.25, fountainZ, true, true);
  const basinProfile = [[0.9, 0], [1.1, 0.04], [1.1, 0.6], [1.17, 0.65], [1.17, 0.76], [0.93, 0.76], [0.93, 0.3], [0, 0.3]].map(([x, y]) => new THREE.Vector2(x, y));
  place(new THREE.Mesh(new THREE.LatheGeometry(basinProfile, 28, 0, Math.PI), stone), LEFT, 0, fountainZ, true, true);
  const water = new THREE.CircleGeometry(0.94, 28, 0, Math.PI);
  water.rotateX(-Math.PI / 2); water.rotateY(-Math.PI / 2);
  place(new THREE.Mesh(water, new THREE.MeshStandardMaterial({ color: 0x1c3134, roughness: 0.04, metalness: 0, envMapIntensity: 1.8 })), LEFT, 0.64, fountainZ, false);
  const rosette = new THREE.CylinderGeometry(0.15, 0.2, 0.1, 20);
  rosette.rotateZ(Math.PI / 2);
  place(new THREE.Mesh(rosette, trim), LEFT + 0.24, 1.75, fountainZ, false);
  place(new THREE.Mesh(rod([0, 0, 0], [0.3, -0.06, 0], 0.028, 8), copper), LEFT + 0.28, 1.74, fountainZ, false);
  place(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.022, 1.04, 6), new THREE.MeshBasicMaterial({ color: 0xcfe6ea, transparent: true, opacity: 0.55 })), LEFT + 0.6, 1.16, fountainZ, false);

  // ---- Behind the firing line ----------------------------------------------
  const backPlaster = plasterMaterial(0xe9d6ae);
  place(new THREE.Mesh(worldBox(19.84, 7.8, 7.3, 3.2), backPlaster), 0.38, 3.9, 13.35, true, true);
  place(new THREE.Mesh(softBox(19.84, 0.5, 0.1, 0.03, 2), stone), 0.38, 0.25, 9.68, false, true);
  place(new THREE.Mesh(worldBox(20.2, 0.3, 7.66, 2), stone), 0.38, 7.56, 13.35, true);
  place(new THREE.Mesh(worldBox(20.02, 0.2, 7.48, 2), stone), 0.38, 7.32, 13.35, false);
  eaves.push({ position: [0.38, 7.77, 13.35], scale: [20.9, 0.12, 8.4] });
  place(new THREE.Mesh(hipRoof(21, 8.5, 1.9), roofs[1]), 0.38, 7.83, 13.35, true);
  for (let x = -9.2; x < 10.3; x += 0.62) rafters.push({ position: [x, 7.65, 9.42], rotation: [0, Math.PI / 2, 0] });
  place(new THREE.Mesh(softBox(0.6, 7.2, 0.6, 0.04, 2), stone), 10.16, 3.6, 9.86, true, true);

  // ---- Right: garden wall and terrace --------------------------------------
  place(new THREE.Mesh(worldBox(0.9, BAND, 30.7, 2.6), gardenBrick), RIGHT + 0.45, BAND / 2, -15.05, true, true);
  place(new THREE.Mesh(softBox(1.14, 0.14, 30.9, 0.04, 2), stone), RIGHT + 0.45, BAND + 0.07, -15.05, true);
  place(new THREE.Mesh(softBox(0.12, 0.8, 30.2, 0.03, 2), stone), RIGHT - 0.02, 0.4, -15.3, false, true);
  place(new THREE.Mesh(worldBox(14.6, 4.3, 30.7, 2.6), gardenBrick), 17.7, 2.15, -15.05, true);
  place(new THREE.Mesh(softBox(14.8, 0.12, 0.5, 0.04, 2), stone), 17.7, 4.36, 0.12, true);
  place(new THREE.Mesh(worldBox(19, 3, 1.3, 2.6), gardenBrick), 34.5, 1.5, -0.35, true);
  place(new THREE.Mesh(softBox(19.2, 0.12, 1.5, 0.04, 2), stone), 34.5, 3.06, -0.35, true);
  // Gate pier where the wall ends, crowned with a lamp.
  place(new THREE.Mesh(softBox(0.96, 5.3, 0.96, 0.04, 2), stone), RIGHT + 0.46, 2.65, 0.3, true, true);
  place(new THREE.Mesh(softBox(1.2, 0.2, 1.2, 0.05, 2), stone), RIGHT + 0.46, 5.4, 0.3, true);
  // Stone bollards and a chain close the gap toward the side square.
  const bollardZ = [2.0, 3.9, 5.8, 7.7];
  const bollardProfile = [[0, 0], [0.2, 0], [0.2, 0.1], [0.15, 0.16], [0.14, 0.72], [0.18, 0.78], [0.18, 0.84], [0.1, 0.93], [0, 0.96]].map(([x, y]) => new THREE.Vector2(x, y));
  instances(new THREE.LatheGeometry(bollardProfile, 16), stone, [...bollardZ, 9.3].map((z) => ({ position: [RIGHT + 0.36, 0, z] as V3 })), true);
  const chainPoints = [0.8, ...bollardZ, 9.3];
  const chains: THREE.BufferGeometry[] = [];
  for (let i = 0; i < chainPoints.length - 1; i += 1) {
    const a = chainPoints[i], b = chainPoints[i + 1];
    const curve = new THREE.CatmullRomCurve3(Array.from({ length: 7 }, (_, k) => new THREE.Vector3(RIGHT + 0.36, 0.76 - 0.22 * 4 * (k / 6) * (1 - k / 6), a + (b - a) * k / 6)));
    chains.push(new THREE.TubeGeometry(curve, 10, 0.018, 5));
  }
  place(new THREE.Mesh(merge(chains), iron), 0, 0, 0, true);

  // ---- Far end: civic hall and bell tower -----------------------------------
  const hallPlaster = plasterMaterial(0xf0dcb4), FH: Face = { x: 0, z: -30.6, yaw: 0 };
  const hallX = 1.48, hallW = 22.04;
  place(new THREE.Mesh(arcadeWall(hallW, 5.2, 0.6, [-8.2, -4.1, 0, 4.1, 8.2].map((x) => ({ x, width: 2.9, spring: 2.7 })), 2), ashlar), hallX, 0, -30.7, true, true);
  place(new THREE.Mesh(worldBox(hallW, 5.2, 7.4, 3.2), plasterMaterial(0xcdb48c)), hallX, 2.6, -37, true);
  place(new THREE.Mesh(worldBox(hallW, 6.6, 9.8, 3.2), hallPlaster), hallX, 8.5, -35.5, true);
  place(new THREE.Mesh(worldBox(hallW + 0.3, 0.3, 0.5, 2), stone), hallX, 5.35, -30.5, true);
  place(new THREE.Mesh(worldBox(hallW + 0.5, 0.34, 10.3, 2), stone), hallX, 11.55, -35.5, true);
  place(new THREE.Mesh(worldBox(hallW + 0.24, 0.26, 10.04, 2), stone), hallX, 11.26, -35.5, false);
  eaves.push({ position: [hallX, 11.78, -35.5], scale: [hallW + 1.3, 0.12, 11.1] });
  place(new THREE.Mesh(hipRoof(hallW + 1.4, 11.2, 2.7), roofs[0]), hallX, 11.84, -35.5, true);
  for (let x = hallX - hallW / 2; x < hallX + hallW / 2; x += 0.62) rafters.push({ position: [x, 11.66, -30.3], rotation: [0, Math.PI / 2, 0] });
  for (let column = 0; column < 7; column += 1) {
    const x = hallX + (column - 3) * 3.0, centre = column >= 2 && column <= 4;
    addWindow(FH, x, 6.3, tall, { shutter: centre ? undefined : Math.PI - 0.07, colour: 0x5a4632, balcony: centre, lit: column === 3 || column === 5 });
    addWindow(FH, x, 9.45, small, { shutter: column % 3 === 1 ? 0 : undefined, colour: 0x5a4632, lit: column === 1 });
  }
  // Stone pilasters between the bays, and a mint banner from the middle balcony.
  instances(worldBox(0.5, 5.6, 0.16, 2), stone, Array.from({ length: 8 }, (_, i) => ({ position: [hallX + (i - 3.5) * 3.0, 8.35, -30.54] as V3 })), false);
  const bannerMap = track(canvasTexture(128, 256, (context) => {
    context.fillStyle = "#8ef5e3"; context.fillRect(0, 0, 128, 256);
    context.fillStyle = "#e89a42"; context.fillRect(0, 0, 128, 20); context.fillRect(0, 222, 128, 34);
    context.fillStyle = "#0d2a2b";
    context.beginPath(); context.moveTo(64, 70); context.lineTo(98, 122); context.lineTo(64, 174); context.lineTo(30, 122); context.closePath(); context.fill();
    context.fillStyle = "#8ef5e3";
    context.beginPath(); context.moveTo(64, 98); context.lineTo(80, 122); context.lineTo(64, 146); context.lineTo(48, 122); context.closePath(); context.fill();
  }));
  const banner = new THREE.PlaneGeometry(1.5, 2.9, 8, 6);
  for (let i = 0; i < banner.attributes.position.count; i += 1) banner.attributes.position.setZ(i, Math.sin(banner.attributes.position.getX(i) * 4 + banner.attributes.position.getY(i) * 1.3) * 0.045);
  banner.computeVertexNormals();
  place(new THREE.Mesh(banner, new THREE.MeshStandardMaterial({ map: bannerMap, emissive: 0xffffff, emissiveMap: bannerMap, emissiveIntensity: 0.12, roughness: 0.9, metalness: 0, side: THREE.DoubleSide })), hallX, 5.45, -29.72, true);
  // Bell tower rising behind the hall.
  const towerX = 9.2, towerZ = -37.4, shaft = 24;
  place(new THREE.Mesh(worldBox(5, shaft, 5, 3), towerBrick), towerX, shaft / 2, towerZ, true);
  instances(softBox(0.56, 1, 0.56, 0.03, 2), stone, [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ position: [towerX + sx * 2.34, shaft / 2, towerZ + sz * 2.34] as V3, scale: [1, shaft, 1] as V3 }))), false);
  for (const y of [13.2, 17.2, 22.2]) place(new THREE.Mesh(worldBox(5.5, 0.3, 5.5, 2), stone), towerX, y, towerZ, true);
  const belfry = archedWall(5, 4.6, 0.5, [{ x: 0, width: 2.3, spring: 2.5, sill: 0.9 }], 2);
  for (let side = 0; side < 4; side += 1) {
    const wall = place(new THREE.Mesh(belfry, stone), towerX + Math.sin(side * Math.PI / 2) * 2.25, shaft, towerZ + Math.cos(side * Math.PI / 2) * 2.25, true);
    wall.rotation.y = side * Math.PI / 2;
  }
  place(new THREE.Mesh(worldBox(5.4, 0.3, 5.4, 2), stone), towerX, shaft + 0.15, towerZ, true);
  place(new THREE.Mesh(worldBox(5.9, 0.4, 5.9, 2), stone), towerX, shaft + 4.8, towerZ, true);
  place(new THREE.Mesh(hipRoof(6.3, 6.3, 3.6), roofs[0]), towerX, shaft + 5.0, towerZ, true);
  place(new THREE.Mesh(merge([new THREE.SphereGeometry(0.26, 14, 10).translate(0, 0.2, 0), rod([0, 0.3, 0], [0, 1.5, 0], 0.03)]), metals.brushed), towerX, shaft + 8.55, towerZ, true);
  const bellProfile = [[0, 1.0], [0.2, 0.98], [0.34, 0.8], [0.4, 0.4], [0.52, 0.12], [0.62, 0], [0.56, 0], [0.46, 0.14]].map(([x, y]) => new THREE.Vector2(x, y));
  place(new THREE.Mesh(new THREE.LatheGeometry(bellProfile, 20), new THREE.MeshStandardMaterial({ color: 0x6b5026, roughness: 0.4, metalness: 0.9, side: THREE.DoubleSide })), towerX, shaft + 1.9, towerZ, true);
  const dialMap = track(clockTexture());
  dialMap.anisotropy = anisotropy;
  const dialMaterial = new THREE.MeshStandardMaterial({ map: dialMap, roughness: 0.5, metalness: 0, envMapIntensity: 0.6 });
  const dialRing = new THREE.TorusGeometry(1.55, 0.13, 8, 40);
  for (const [dx, dz, turn] of [[0, 2.53, 0], [-2.53, 0, -Math.PI / 2], [2.53, 0, Math.PI / 2]]) {
    const dial = place(new THREE.Mesh(new THREE.CircleGeometry(1.5, 40), dialMaterial), towerX + dx, 19.7, towerZ + dz, false);
    dial.rotation.y = turn;
    place(new THREE.Mesh(dialRing, stone), towerX + dx, 19.7, towerZ + dz, false).rotation.y = turn;
  }
  instances(new THREE.BoxGeometry(0.5, 1.5, 0.08), shade, [15.2, 9.0].flatMap((y) => [{ position: [towerX, y, towerZ + 2.5] as V3 }, { position: [towerX - 2.5, y, towerZ] as V3, rotation: [0, Math.PI / 2, 0] as V3 }]), false, false);

  // ---- Town beyond ---------------------------------------------------------
  const townPlaster = [plasterMaterial(0xe4b878), plasterMaterial(0xd69a72), plasterMaterial(0xeedfbd), plasterMaterial(0xd8a98e)];
  // Beside the hall.
  building(14, 26, -46, -31, 7.6, townPlaster[1]);
  fenestrate({ x: 20, z: -31, yaw: 0 }, -5.4, 5.4, [{ y: 1.4, type: tall }, { y: 4.9, type: small }], 0x4d6f58);
  // Villas set back behind the garden.
  building(27, 39, -18, -5, 9, townPlaster[2]);
  fenestrate({ x: 27, z: -11.5, yaw: -Math.PI / 2 }, -5.6, 5.6, [{ y: 5.2, type: tall }], 0x2f5a66);
  building(28, 42, -42, -24, 10.2, townPlaster[0], 2.6);
  fenestrate({ x: 28, z: -33, yaw: -Math.PI / 2 }, -8, 8, [{ y: 5.4, type: tall }, { y: 8.2, type: small }], 0x7a5236);
  // Around the side square.
  building(10.3, 42, 16.4, 28, 6.9, townPlaster[3], 1.9);
  fenestrate({ x: 26, z: 16.4, yaw: Math.PI }, -14.5, 14.5, [{ y: 0.9, type: tall }, { y: 4.3, type: small }], 0x4d6f58, { lit: 0.3 });
  building(44.5, 56, -4, 16, 7.8, townPlaster[0]);
  fenestrate({ x: 44.5, z: 6, yaw: -Math.PI / 2 }, -9, 9, [{ y: 1.0, type: tall }, { y: 4.6, type: small }], 0x7a5236, { lit: 0.3 });
  building(44.5, 58, 16, 40, 6.6, townPlaster[2], 1.8);
  fenestrate({ x: 44.5, z: 28, yaw: -Math.PI / 2 }, -11, 11, [{ y: 1.0, type: tall }, { y: 3.9, type: small }], 0x2f5a66, { lit: 0.3 });
  // Rooftops behind the firing line and behind the hall, seen over the eaves.
  building(-9, 9, 21, 33, 10.5, townPlaster[1], 2.4);
  building(-16, 14, -58, -47, 15.5, townPlaster[3], 2.8);
  fenestrate({ x: -1, z: -47, yaw: 0 }, -14, 14, [{ y: 9.5, type: tall }, { y: 12.6, type: small }], 0x4d6f58);
  building(-40, -21, -44, -8, 12, townPlaster[2], 2.6, false);

  // ---- Shared façade parts, drawn once each --------------------------------
  for (const type of [tall, small]) {
    instances(surroundGeometry(type.w, type.h, type.head), stone, type.surround, false);
    instances(new THREE.BoxGeometry(type.w, type.h, 0.04), glass, type.dark, false, false);
    instances(new THREE.BoxGeometry(type.w, type.h, 0.04), litGlass, type.lit, false, false);
    instances(merge([box(0.05, type.h, 0.03, 0, 0, 0), box(type.w, 0.045, 0.03, 0, type.h * 0.18, 0), box(type.w, 0.045, 0.03, 0, -type.h * 0.22, 0)]), sash, type.bars, false, false);
    const leaves = instances(new THREE.BoxGeometry(type.w / 2, type.h, 0.045), shutterMaterial, type.leaves, false);
    if (leaves) {
      const colour = new THREE.Color();
      type.colours.forEach((value, index) => leaves.setColorAt(index, colour.setHex(value).multiplyScalar(0.9 + ((index * 37) % 10) * 0.03)));
      leaves.instanceColor!.needsUpdate = true;
    }
  }
  instances(balconyStone(), stone, balconies, false);
  instances(balconyIron(), iron, balconies, false);
  instances(new THREE.BoxGeometry(1, 1, 1), trim, cornices, false);
  instances(new THREE.BoxGeometry(1, 1, 1), trim, courses, false, false);
  instances(new THREE.BoxGeometry(1, 1, 1), eaveWood, eaves, false);
  instances(new THREE.BoxGeometry(1, 1, 1), plasterMaterial(0xc9a57c), chimneys, false);
  instances(new THREE.CylinderGeometry(0.11, 0.14, 0.4, 10), terracotta, pots, false);

  // ---- Lanterns and festoon lights -----------------------------------------
  const lanternSpots: Transform[] = [
    ...[-27, -17.2, -8.2, 1.0, 7.4].map((z) => ({ position: at(FL, -z, 5.0, 0.06), rotation: [0, Math.PI / 2, 0] as V3 })),
    ...[-6.1, -2.0, 2.0, 6.1].map((x) => ({ position: [hallX + x, 3.7, -30.4] as V3 })),
  ];
  instances(lanternIron(), iron, lanternSpots, false);
  instances(new THREE.BoxGeometry(0.16, 0.27, 0.16), lampGlass, lanternSpots.map((spot) => ({ position: at({ x: spot.position[0], z: spot.position[2], yaw: spot.rotation?.[1] ?? 0 }, 0, spot.position[1] - 0.05, 0.42) })), false, false);
  // Lamp standards on the garden wall double as festoon anchors.
  const standards: V3[] = [[RIGHT + 0.45, BAND + 0.14, -21], [RIGHT + 0.45, BAND + 0.14, -8.6], [RIGHT + 0.46, 5.5, 0.3]];
  instances(merge([new THREE.CylinderGeometry(0.035, 0.05, 2.5, 8).translate(0, 1.25, 0), new THREE.CylinderGeometry(0.09, 0.11, 0.3, 8).translate(0, 0.15, 0), new THREE.ConeGeometry(0.2, 0.14, 8).translate(0, 2.87, 0)]), iron, standards.map((position) => ({ position })), false);
  instances(new THREE.SphereGeometry(0.15, 14, 10), lampGlass, standards.map(([x, y, z]) => ({ position: [x, y + 2.66, z] as V3 })), false, false);
  const anchors: V3[] = [
    [UPPER + 0.05, 8.35, -26.6], [standards[0][0], standards[0][1] + 2.45, standards[0][2]], [UPPER + 0.05, 8.35, -16.9],
    [standards[1][0], standards[1][1] + 2.45, standards[1][2]], [UPPER + 0.05, 8.35, -7.3], [standards[2][0], standards[2][1] + 2.45, standards[2][2]],
    [UPPER + 0.05, 8.2, 3.6],
  ];
  const wires: THREE.BufferGeometry[] = [], bulbs: Transform[] = [], sockets: Transform[] = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = new THREE.Vector3(...anchors[i]), b = new THREE.Vector3(...anchors[i + 1]), span = a.distanceTo(b), sag = 1.15 + (i % 2) * 0.25;
    const point = (t: number) => a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t));
    wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 17 }, (_, k) => point(k / 16))), 40, 0.011, 4));
    const count = Math.floor(span / 0.62);
    for (let k = 1; k < count; k += 1) {
      const p = point(k / count);
      sockets.push({ position: [p.x, p.y - 0.045, p.z] });
      bulbs.push({ position: [p.x, p.y - 0.125, p.z] });
    }
  }
  place(new THREE.Mesh(merge(wires), rubber), 0, 0, 0, false);
  instances(new THREE.CylinderGeometry(0.02, 0.026, 0.07, 6), rubber, sockets, false, false);
  instances(new THREE.SphereGeometry(0.05, 10, 8), bulb, bulbs, false, false);

  // ---- Planting ------------------------------------------------------------
  const leafCard = new THREE.PlaneGeometry(1, 1);
  const treeLeaves: Transform[] = [], shrubLeaves: Transform[] = [];
  const foliage = (list: Transform[], cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, count: number, size: number) => {
    for (let i = 0; i < count; i += 1) {
      const u = random() * 2 - 1, phi = random() * Math.PI * 2, r = Math.sqrt(1 - u * u), k = 0.5 + 0.5 * random(), s = size * (0.75 + 0.6 * random());
      list.push({ position: [cx + r * Math.cos(phi) * rx * k, cy + u * ry * k, cz + r * Math.sin(phi) * rz * k], rotation: [(random() - 0.5) * 1.8, random() * Math.PI * 2, (random() - 0.5) * 1.8], scale: [s, s, s] });
    }
  };
  // Terracotta planters with clipped shrubs along both sides, clear of signs and furnace.
  const potProfile = [[0, 0], [0.2, 0], [0.22, 0.03], [0.3, 0.44], [0.34, 0.47], [0.34, 0.54], [0.29, 0.54], [0.27, 0.48], [0, 0.48]].map(([x, y]) => new THREE.Vector2(x, y));
  const planters: Array<[number, number, number]> = [
    [-8.95, -27.3, 1.1], [-8.95, -19.85, 1], [-8.95, -14.0, 1.15], [-8.95, -7.9, 1], [-8.95, -1.0, 1.1],
    [8.95, -26.6, 1.1], [8.95, -20.0, 1], [8.95, -14.1, 1.1], [8.95, -8.6, 1], [8.9, -1.0, 1.15],
    [-8.9, -24.5, 0.8], [-8.9, -22.55, 0.8],
  ];
  instances(new THREE.LatheGeometry(potProfile, 20), terracotta, planters.map(([x, z, scale]) => ({ position: [x, 0, z] as V3, scale: [scale, scale, scale] as V3 })), true);
  const cypresses: Transform[] = [];
  planters.forEach(([x, z, scale], index) => {
    if (index >= 10) cypresses.push({ position: [x, 0.45 * scale, z], scale: [1.7, 1.7, 1.7] });
    else {
      foliage(shrubLeaves, x, 0.5 * scale + 0.42, z, 0.4, 0.4, 0.4, 34, 0.42);
      foliage(shrubLeaves, x, 0.5 * scale + 0.42, z, 0.16, 0.16, 0.16, 8, 0.5);
    }
  });
  // Planting spilling over the garden wall, in three runs.
  for (const [from, to] of [[-29, -24.5], [-19.2, -14.6], [-6.4, -1.4]]) for (let z = from; z < to; z += 0.55) foliage(shrubLeaves, RIGHT + 0.36, BAND + 0.2, z, 0.3, 0.2, 0.4, 7, 0.4);
  // Flower boxes on a few balconies.
  balconies.forEach((balcony, index) => {
    if (index % 2) return;
    const face: Face = { x: balcony.position[0], z: balcony.position[2], yaw: balcony.rotation?.[1] ?? 0 };
    for (let s = -0.8; s <= 0.8; s += 0.4) { const [x, y, z] = at(face, s, balcony.position[1] + 1.0, 0.8); foliage(shrubLeaves, x, y, z, 0.2, 0.2, 0.2, 5, 0.36); }
  });
  // Cypresses on the terrace and in the side square: thin shadows raking the cobbles.
  // Only two stand near enough to throw a stripe across the square; the rest sit back so the cobbles keep their sun.
  for (const [x, z, h] of [[11.6, -27.8, 6.2], [12.2, -4.6, 6.4], [22.5, -23, 5.4], [23.5, -12, 5.8], [22, -2.4, 5], [24, -17.5, 5.6], [21.5, -8, 4.6]]) cypresses.push({ position: [x, 4.3, z], rotation: [0, x * 3, 0], scale: [h * 0.8, h, h * 0.8] });
  for (const [x, z, h] of [[31, 13.4, 8.5], [34, 13.8, 7.2], [41.5, 3, 9]]) cypresses.push({ position: [x, 0, z], rotation: [0, z, 0], scale: [h, h, h] });
  const cypressSet = reliefTextures(128, (context) => {
    const mottle = rng(13);
    context.fillStyle = "#26381f"; context.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 700; i += 1) {
      const tone = 0.5 + mottle() * 0.9;
      context.fillStyle = `rgb(${46 * tone | 0},${70 * tone | 0},${36 * tone | 0})`;
      context.fillRect(mottle() * 128, mottle() * 128, 2 + mottle() * 3, 5 + mottle() * 12);
    }
  }, (context) => {
    const mottle = rng(14);
    for (let i = 0; i < 500; i += 1) { const tone = mottle() * 255 | 0; context.fillStyle = `rgb(${tone},${tone},${tone})`; context.fillRect(mottle() * 128, mottle() * 128, 3 + mottle() * 4, 6 + mottle() * 14); }
  }, 2.5);
  track(cypressSet.map); track(cypressSet.normalMap);
  instances(cypressGeometry(), new THREE.MeshStandardMaterial({ ...cypressSet, roughness: 0.95, metalness: 0, envMapIntensity: 0.45 }), cypresses, false);
  // Broadleaf trees: one in the side square whose dappled shade reaches the firing line, two in the garden.
  const bark = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, normalMap: plaster.normalMap, roughness: 1, metalness: 0, envMapIntensity: 0.3 });
  const tree = (x: number, base: number, z: number, trunk: number, radius: number) => {
    const top = base + trunk;
    place(new THREE.Mesh(merge([
      new THREE.CylinderGeometry(0.16, 0.26, trunk, 9).translate(0, trunk / 2, 0),
      rod([0, trunk - 0.3, 0], [radius * 0.5, trunk + radius * 0.7, radius * 0.2], 0.09), rod([0, trunk - 0.5, 0], [-radius * 0.45, trunk + radius * 0.6, -radius * 0.3], 0.085), rod([0, trunk - 0.2, 0], [0.1, trunk + radius * 0.9, radius * 0.45], 0.08),
    ]), bark), x, base, z, true);
    foliage(treeLeaves, x, top + radius * 0.75, z, radius, radius * 0.72, radius, Math.round(radius * 70), radius * 0.5);
    foliage(treeLeaves, x + radius * 0.5, top + radius * 0.4, z + radius * 0.3, radius * 0.6, radius * 0.5, radius * 0.6, Math.round(radius * 26), radius * 0.46);
    foliage(treeLeaves, x - radius * 0.5, top + radius * 0.5, z - radius * 0.35, radius * 0.6, radius * 0.5, radius * 0.6, Math.round(radius * 26), radius * 0.46);
  };
  tree(17.5, 0, 12.2, 3.0, 2.7);
  tree(22.6, 4.3, -15.2, 1.3, 1.9);
  tree(19, 4.3, -28.4, 1.8, 2.4);
  const ringProfile = [[1.0, 0], [1.25, 0], [1.25, 0.42], [1.18, 0.48], [1.0, 0.48], [1.0, 0.36], [0, 0.36]].map(([x, y]) => new THREE.Vector2(x, y));
  place(new THREE.Mesh(new THREE.LatheGeometry(ringProfile, 28), stone), 17.5, 0, 12.2, true);
  const treeMap = track(leafTexture([150, 150, 62])), shrubMap = track(leafTexture([74, 118, 58]));
  const leafMaterial = (map: THREE.Texture) => new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75, metalness: 0, envMapIntensity: 0.5 });
  instances(leafCard, leafMaterial(treeMap), treeLeaves, false);
  instances(leafCard, leafMaterial(shrubMap), shrubLeaves, false);

  // ---- Café tables ---------------------------------------------------------
  const tableProfile = [[0, 0], [0.22, 0], [0.22, 0.025], [0.03, 0.05], [0.025, 0.7], [0.34, 0.71], [0.34, 0.74], [0, 0.74]].map(([x, y]) => new THREE.Vector2(x, y));
  const chairGeometry = (() => {
    const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.19, 0.19, 0.025, 16).translate(0, 0.46, 0)];
    for (const [x, z] of [[-0.14, -0.14], [0.14, -0.14], [-0.15, 0.15], [0.15, 0.15]]) parts.push(rod([x * 1.15, 0, z * 1.15], [x, 0.46, z], 0.011));
    parts.push(rod([-0.15, 0.46, 0.16], [-0.16, 0.88, 0.2], 0.011), rod([0.15, 0.46, 0.16], [0.16, 0.88, 0.2], 0.011));
    const hoop = new THREE.TorusGeometry(0.16, 0.011, 5, 12, Math.PI);
    hoop.translate(0, 0.88, 0.2);
    parts.push(hoop, rod([-0.14, 0.68, 0.18], [0.14, 0.68, 0.18], 0.009), rod([0, 0.68, 0.18], [0, 1.03, 0.2], 0.009));
    return merge(parts);
  })();
  const tables: V3[] = [[-8.5, 0, -26.0], [-8.45, 0, -11.9], [-8.4, 0, 2.0], [-8.3, 0, 5.4], [-8.4, 0, 8.4], [8.5, 0, -3.4], [8.45, 0, -5.9], [8.5, 0, -24.3]];
  const chairs: Transform[] = [];
  tables.forEach(([x, , z], index) => {
    const inward = -Math.sign(x);
    // One chair each side along the wall and, where there is room, one facing the square.
    chairs.push({ position: [x + 0.05, 0, z - 0.62], rotation: [0, Math.PI + (index % 3 - 1) * 0.3, 0] }, { position: [x - 0.04, 0, z + 0.62], rotation: [0, (index % 2 - 0.5) * 0.5, 0] });
    if (index % 2 === 0) chairs.push({ position: [x + inward * 0.6, 0, z + 0.08], rotation: [0, -inward * Math.PI / 2 + 0.25, 0] });
  });
  instances(new THREE.LatheGeometry(tableProfile, 24), cafeMetal, tables.map((position) => ({ position })), true);
  instances(chairGeometry, cafeMetal, chairs, true);
  // A candle jar on each table.
  instances(new THREE.CylinderGeometry(0.035, 0.03, 0.09, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.62, 0.25).multiplyScalar(2.6), toneMapped: false }), tables.map(([x, , z]) => ({ position: [x + 0.08, 0.79, z - 0.05] as V3 })), false, false);

  // ---- Bicycle leaning on the sunlit wall ----------------------------------
  const [tyreGeometry, wheelMetal] = wheelGeometry(0.33, 0.017, 9, 0.004);
  const bicycle = new THREE.Group(), lean = new THREE.Group();
  const bikePart = (geometry: THREE.BufferGeometry, material: THREE.Material) => { const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true; lean.add(mesh); };
  const rear: V3 = [-0.52, 0.34, 0], front: V3 = [0.54, 0.34, 0], crank: V3 = [-0.06, 0.3, 0], seat: V3 = [-0.24, 0.84, 0], head: V3 = [0.36, 0.88, 0], steer: V3 = [0.4, 0.72, 0];
  const framePaint = new THREE.MeshStandardMaterial({ color: BRAND, roughness: 0.32, metalness: 0.35, envMapIntensity: 1.2 });
  bikePart(merge([rod(crank, seat, 0.017, 8), rod(seat, head, 0.016, 8), rod(crank, steer, 0.019, 8), rod(head, steer, 0.02, 8),
    ...[-0.05, 0.05].flatMap((z) => [rod([seat[0], seat[1], 0], [rear[0], rear[1], z], 0.009), rod([crank[0], crank[1], 0], [rear[0], rear[1], z], 0.01), rod([steer[0], steer[1], z * 0.6], [front[0], front[1], z], 0.011)])]), framePaint);
  bikePart(merge([tyreGeometry.clone().translate(...rear), tyreGeometry.clone().translate(...front), softBox(0.27, 0.05, 0.15, 0.02, 1).translate(-0.27, 0.95, 0),
    new THREE.CylinderGeometry(0.017, 0.017, 0.11, 8).rotateX(Math.PI / 2).translate(0.3, 1.02, 0.25), new THREE.CylinderGeometry(0.017, 0.017, 0.11, 8).rotateX(Math.PI / 2).translate(0.3, 1.02, -0.25),
    box(0.09, 0.02, 0.07, 0.08, 0.16, 0.12), box(0.09, 0.02, 0.07, -0.2, 0.44, -0.12)]), rubber);
  bikePart(merge([wheelMetal.clone().translate(...rear), wheelMetal.clone().translate(...front), rod(seat, [-0.26, 0.93, 0], 0.012), rod(head, [0.3, 1.02, 0], 0.012), rod([0.3, 1.02, -0.3], [0.3, 1.02, 0.3], 0.011),
    new THREE.CylinderGeometry(0.09, 0.09, 0.008, 18).rotateX(Math.PI / 2).translate(crank[0], crank[1], 0.05), rod([crank[0], crank[1], 0.06], [0.08, 0.17, 0.08], 0.008), rod([crank[0], crank[1], -0.06], [-0.2, 0.43, -0.08], 0.008),
    rod([crank[0], crank[1], -0.07], [crank[0], crank[1], 0.07], 0.012)]), metals.brushed);
  // Wicker basket on the bars.
  bikePart(new THREE.CylinderGeometry(0.17, 0.13, 0.2, 12, 1, true).translate(0.56, 0.92, 0), new THREE.MeshStandardMaterial({ color: 0x9a6f3c, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
  lean.rotation.x = -0.17;
  bicycle.add(lean);
  bicycle.position.set(-9.1, 0, -21.3);
  bicycle.rotation.y = Math.PI / 2;
  scene.add(bicycle);

  // ---- Market cart in the side square --------------------------------------
  const cart = new THREE.Group();
  const cartPart = (geometry: THREE.BufferGeometry, material: THREE.Material) => { const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true; cart.add(mesh); return mesh; };
  const [cartTyre, cartSpokes] = wheelGeometry(0.56, 0.03, 6, 0.016);
  cartPart(merge([softBox(2.0, 0.08, 1.1, 0.015, 1.1).translate(0, 0.86, 0), softBox(2.0, 0.26, 0.05, 0.012, 1.1).translate(0, 1.02, 0.53), softBox(2.0, 0.26, 0.05, 0.012, 1.1).translate(0, 1.02, -0.53),
    softBox(0.05, 0.26, 1.1, 0.012, 1.1).translate(-0.98, 1.02, 0), softBox(0.05, 0.26, 1.1, 0.012, 1.1).translate(0.98, 1.02, 0),
    rod([0.9, 0.84, 0.42], [2.0, 0.98, 0.42], 0.028, 8), rod([0.9, 0.84, -0.42], [2.0, 0.98, -0.42], 0.028, 8), rod([0.8, 0, 0.4], [0.8, 0.84, 0.4], 0.03, 8), rod([0.8, 0, -0.4], [0.8, 0.84, -0.4], 0.03, 8),
    ...[[-0.95, 0.5], [-0.95, -0.5], [0.95, 0.5], [0.95, -0.5]].map(([x, z]) => rod([x, 0.86, z], [x, 2.25, z], 0.022, 6)),
    cartSpokes.clone().translate(-0.25, 0.56, 0.62), cartSpokes.clone().translate(-0.25, 0.56, -0.62), rod([-0.25, 0.56, -0.64], [-0.25, 0.56, 0.64], 0.03, 8)]), metals.crate);
  cartPart(merge([cartTyre.clone().translate(-0.25, 0.56, 0.62), cartTyre.clone().translate(-0.25, 0.56, -0.62)]), iron);
  const cartMap = track(stripeTexture("#efe6d0", "#cf7f35", "#3f9d92"));
  cartMap.repeat.set(2, 1);
  const cartCloth = new THREE.PlaneGeometry(2.3, 1.5, 10, 4);
  cartCloth.rotateX(-Math.PI / 2);
  for (let i = 0; i < cartCloth.attributes.position.count; i += 1) { const x = cartCloth.attributes.position.getX(i) / 1.15, z = cartCloth.attributes.position.getZ(i) / 0.75; cartCloth.attributes.position.setY(i, 2.27 - 0.1 * (1 - x * x) * (1 - z * z)); }
  cartCloth.computeVertexNormals();
  cartPart(cartCloth, new THREE.MeshStandardMaterial({ map: cartMap, emissive: 0xffffff, emissiveMap: cartMap, emissiveIntensity: 0.25, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
  const crate = crateGeometry(0.46);
  for (const [x, z, turn] of [[-0.62, 0.2, 0.1], [-0.08, -0.22, -0.2], [0.5, 0.18, 0.3]]) { const mesh = cartPart(crate, metals.crate); mesh.position.set(x, 1.13, z); mesh.rotation.y = turn; }
  const fruit: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 46; i += 1) fruit.push(new THREE.SphereGeometry(0.045, 8, 6).translate([-0.62, -0.08, 0.5][i % 3] + (random() - 0.5) * 0.3, 1.39 + random() * 0.05, [0.2, -0.22, 0.18][i % 3] + (random() - 0.5) * 0.3));
  cartPart(merge(fruit), new THREE.MeshStandardMaterial({ color: STRIKE_ORANGE, roughness: 0.5, metalness: 0 }));
  cart.position.set(12.4, 0, 4.2);
  cart.rotation.y = 0.5;
  scene.add(cart);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 2.3);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xb4c8ee, 0xb08a5c, 1.7));
  const sun = kit.sunLight({ color: 0xffd2a0, intensity: 8, toSun: TO_SUN, extent: 36, distance: 62, near: 4, far: 136, radius: 2.2 });
  const fills = ([[-2.4, 6.0, -22], [2.4, 6.0, -12.6], [-2.2, 6.0, -3.6], [1.5, 5.6, 4.6]] as V3[]).map((position) => {
    const light = new THREE.PointLight(0xffb062, 26, 19, 2);
    light.position.set(...position);
    scene.add(light);
    return light;
  });
  const arcadeLight = new THREE.PointLight(0xffa552, 16, 10, 2);
  arcadeLight.position.set(-11.6, 3.3, 5.05);
  scene.add(arcadeLight);

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 320, x: 18, y: [0.3, 7], z: [-28, 8], color: 0xffdcae, opacity: 0.22 });

  const lit = sunlitFromBoxes(TO_SUN, [
    new THREE.Box3(new THREE.Vector3(RIGHT, 0, -30.4), new THREE.Vector3(25, BAND + 0.14, 0.3)),
    new THREE.Box3(new THREE.Vector3(-9.54, 0, 9.7), new THREE.Vector3(10.3, 7.9, 17)),
    new THREE.Box3(new THREE.Vector3(10.3, 0, 16.4), new THREE.Vector3(42, 7.4, 28)),
    new THREE.Box3(new THREE.Vector3(15.2, 3.4, 9.9), new THREE.Vector3(19.8, 7.6, 14.5)),
  ]);

  return kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    look: {
      sky: "/environment/tears_of_steel_bridge-2k.hdr", skyIntensity: 2.4, skyRotation: 0, skyClamp: 0.65,
      background: 0x8fa7c4, fog: 0xc9b8a2, fogDensity: high ? 0.0045 : 0.007,
      haze: new THREE.Color(0.05, 0.036, 0.022), hazeDensity: 0.0011, hazeCeiling: 7, hazeFade: 3,
      environmentIntensity: 1, exposure: 0.85, far: 220,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
}

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial } from "../pbr";
import {
  archedWall, BRAND, canvasTexture, createKit, projectUv, softBox, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createProps, type PropItem, type PropKind } from "../props";
import { createTrees, type TreeItem } from "../trees";
import { createWind } from "../wind";

// Piazza: an old-town square at low sun, just after rain.
//
// Lighting model: one low golden sun, matched to the sky's own, comes over a
// garden wall on the right and lands on the tall plaster fronts on the left, so
// the showpiece side is fully lit and its colour bounces back into the shade.
// The cobbles are wet: puddles mirror the lit fronts, the sky and the festoon
// bulbs strung across the square. The right side stays low on purpose (a wall
// of height H shades 2.66·H metres of ground), and a gap beside the firing line
// lets a diagonal swathe of sun reach the middle of the square.

/** Direction to the key light: the sun's bearing in `tears_of_steel_bridge-2k.hdr` (0.820, 0.311, 0.480), stood a few degrees higher so more of the square catches it. */
const TO_KEY = new THREE.Vector3(0.820, 0.42, 0.480).normalize();
/** Depth of the window reveals in the sunlit fronts. */
const REVEAL = 0.32;
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

/** A wedge-shaped keystone, origin at the middle of its foot on the wall plane, +z out. */
function keystone(top: number, foot: number, h: number, depth: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-foot / 2, 0); shape.lineTo(foot / 2, 0); shape.lineTo(top / 2, h); shape.lineTo(-top / 2, h); shape.closePath();
  return projectUv(new THREE.ExtrudeGeometry(shape, { depth: depth - 0.012, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1 }), 1.6);
}

/** A block with one soft chamfer on every edge: dressed stone at a sixth of `softBox`'s triangles. */
function chamferBox(w: number, h: number, d: number, radius: number, metres = 1.6) {
  return projectUv(new RoundedBoxGeometry(w, h, d, 1, Math.min(radius, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), metres);
}

/** Paints every vertex of a geometry one colour (for merged pieces that carry their own tint). */
function tinted<T extends THREE.BufferGeometry>(geometry: T, r: number, g = r, b = r) {
  const colours = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < colours.length; i += 3) { colours[i] = r; colours[i + 1] = g; colours[i + 2] = b; }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
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
  return reliefTextures(1024, (context) => {
    context.scale(2, 2);
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
    context.scale(2, 2);
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
  }, 4.8);
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
  return reliefTextures(1024, (context) => {
    // Read as an occlusion map: white stone, grey joints, faint block-to-block variation.
    context.scale(4, 4);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 4; row += 1) for (let block = -1; block < 2; block += 1) {
      const tone = 215 + Math.round(random() * 40);
      context.fillStyle = `rgb(${tone},${tone},${tone})`;
      context.fillRect(block * 128 + (row % 2 ? 64 : 0), row * 64, 128, 64);
    }
    context.filter = "blur(5px)";
    joints(context, "#3a3a3a", 7);
    context.filter = "none";
    // Tooling: short chisel strokes across each face, too fine to read beyond a few metres.
    for (let i = 0; i < 2600; i += 1) {
      const x = random() * 256, y = random() * 256, tone = random() < 0.5 ? 255 : 150;
      context.strokeStyle = `rgba(${tone},${tone},${tone},${0.05 + random() * 0.07})`;
      context.lineWidth = 0.3 + random() * 0.4;
      context.beginPath(); context.moveTo(x, y); context.lineTo(x + 1.5 + random() * 3, y + 2 + random() * 4); context.stroke();
    }
  }, (context) => {
    context.scale(4, 4);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 256, 256);
    const pick = rng(23);
    for (let i = 0; i < 2600; i += 1) {
      const x = pick() * 256, y = pick() * 256;
      context.strokeStyle = `rgba(0,0,0,${0.03 + pick() * 0.05})`;
      context.lineWidth = 0.3 + pick() * 0.4;
      context.beginPath(); context.moveTo(x, y); context.lineTo(x + 1.5 + pick() * 3, y + 2 + pick() * 4); context.stroke();
    }
    context.filter = "blur(7px)";
    joints(context, "#000", 9);
    context.filter = "none";
  }, 6);
}

/**
 * A louvred shutter leaf, origin at its centre. Stiles and rails are solid; each louvre is one
 * two-sided blade crossing a dark sheet in the middle of the leaf, so from either face the blades
 * overlap the way real ones do and nothing shows through between them.
 */
function shutterGeometry(w: number, h: number) {
  const stile = 0.058, t = 0.044, top = 0.075, mid = 0.07, foot = 0.1, inner = w - stile * 2, parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) parts.push(tinted(box(stile, h, t, side * (w / 2 - stile / 2), 0, 0), 1));
  parts.push(tinted(box(inner, top, t, 0, h / 2 - top / 2, 0), 1), tinted(box(inner, mid, t, 0, 0, 0), 1), tinted(box(inner, foot, t, 0, -h / 2 + foot / 2, 0), 1));
  for (const [y0, y1] of [[-h / 2 + foot, -mid / 2], [mid / 2, h / 2 - top]]) {
    const span = y1 - y0, count = Math.max(5, Math.round(span / 0.047));
    parts.push(tinted(new THREE.PlaneGeometry(inner, span).translate(0, (y0 + y1) / 2, 0), 0.07));
    for (let i = 0; i < count; i += 1) {
      const blade = new THREE.PlaneGeometry(inner, 0.07);
      blade.rotateX(-0.6);
      blade.translate(0, y0 + (i + 0.5) * span / count, 0);
      parts.push(tinted(blade, i % 2 ? 0.94 : 1));
    }
  }
  return projectUv(merge(parts), 0.9);
}

/** The same leaf for houses too far away to show a louvre: a framed board with its slatted panels as two darker faces. */
function shutterBoard(w: number, h: number) {
  const t = 0.044, panel = (z: number) => tinted(new THREE.PlaneGeometry(w - 0.116, h - 0.175).rotateY(z < 0 ? Math.PI : 0).translate(0, -0.0125, z), 0.7);
  return projectUv(merge([tinted(box(w, h, t, 0, 0, 0), 1), panel(t / 2 + 0.002), panel(-t / 2 - 0.002)]), 0.9);
}

/** A closed profile in (out, up) swept along z, centred; the wall plane is out = 0 and +x points out. */
function moulding(profile: Array<[number, number]>, length: number) {
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y))), { depth: length, bevelEnabled: false });
  geometry.translate(0, 0, -length / 2);
  return projectUv(geometry, 2);
}
const CORNICE: Array<[number, number]> = [[0, 0], [0.05, 0], [0.05, 0.07], [0.1, 0.12], [0.1, 0.3], [0.24, 0.3], [0.24, 0.36], [0.32, 0.44], [0.32, 0.52], [0.36, 0.56], [0, 0.56]];
const STRING_COURSE: Array<[number, number]> = [[0, 0], [0.1, 0], [0.14, 0.05], [0.14, 0.2], [0.2, 0.26], [0.2, 0.34], [0.08, 0.4], [0, 0.4]];

function swapUv<T extends THREE.BufferGeometry>(geometry: T, su = 1, sv = 1) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getY(i) * su, uv.getX(i) * sv);
  return geometry;
}
function scaleUv<T extends THREE.BufferGeometry>(geometry: T, su: number, sv: number) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geometry;
}

/** Round-headed plank door with its stone surround and ironwork, in the XY plane facing +z, threshold at y = 0. */
function archDoorGeometry(w: number, spring: number) {
  const half = w / 2, outer = half + 0.2;
  const leaf = new THREE.Shape();
  leaf.moveTo(-half, 0); leaf.lineTo(-half, spring); leaf.absarc(0, spring, half, Math.PI, 0, true); leaf.lineTo(half, 0); leaf.closePath();
  const frame = new THREE.Shape();
  frame.moveTo(-outer, 0); frame.lineTo(-outer, spring); frame.absarc(0, spring, outer, Math.PI, 0, true); frame.lineTo(outer, 0);
  frame.lineTo(half, 0); frame.lineTo(half, spring); frame.absarc(0, spring, half, 0, Math.PI, false); frame.lineTo(-half, 0); frame.closePath();
  const door = swapUv(projectUv(new THREE.ExtrudeGeometry(leaf, { depth: 0.06, bevelEnabled: false, curveSegments: 12 }), 1.3));
  const surround = projectUv(new THREE.ExtrudeGeometry(frame, { depth: 0.14, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 1, curveSegments: 12 }), 1.6);
  const iron: THREE.BufferGeometry[] = [box(0.022, spring + half * 0.9, 0.02, 0, (spring + half * 0.9) / 2, 0.066)];
  for (const side of [-1, 1]) {
    for (const y of [0.35, spring - 0.25]) iron.push(box(half * 0.72, 0.05, 0.014, side * half * 0.62, y, 0.066));
    const ring = new THREE.TorusGeometry(0.06, 0.011, 5, 14);
    ring.translate(side * 0.14, spring * 0.5, 0.075);
    iron.push(ring);
    for (let i = 0; i < 5; i += 1) iron.push(new THREE.SphereGeometry(0.016, 6, 4).translate(side * half * 0.5, 0.2 + i * (spring - 0.1) / 5, 0.064));
  }
  return { door, surround, iron: merge(iron) };
}

/** Vertical awning stripes with a woven, sun-faded finish. */
function stripeTexture(base: string, stripe: string, accent: string) {
  return canvasTexture(1024, 512, (context) => {
    context.scale(4, 4);
    context.fillStyle = base;
    context.fillRect(0, 0, 256, 128);
    for (let x = 0; x < 256; x += 64) {
      context.fillStyle = stripe; context.fillRect(x + 6, 0, 26, 128);
      context.fillStyle = accent; context.fillRect(x + 44, 0, 5, 128);
    }
    const random = rng(91);
    for (let i = 0; i < 9000; i += 1) {
      const shade = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},.05)`;
      context.fillRect(random() * 256, random() * 128, 0.3, 1 + random() * 8);
    }
  }, true);
}

/** What shows behind dark glass, four ways across the sheet: lace drawn back, a full sheer, a half-lowered blind over a house plant, one heavy drape. */
function paneAtlas() {
  return canvasTexture(2048, 1024, (context) => {
    const random = rng(303);
    const folds = (x0: number, x1: number, tone: [number, number, number], alpha: number, pitch: number) => {
      for (let x = x0; x < x1; x += 2) {
        const k = 0.7 + 0.3 * Math.sin((x - x0) / pitch * Math.PI * 2 + Math.sin(x * 0.05) * 1.2);
        context.fillStyle = `rgba(${tone[0] * k | 0},${tone[1] * k | 0},${tone[2] * k | 0},${alpha})`;
        context.fillRect(x, 0, 2, 1024);
      }
    };
    for (let cell = 0; cell < 4; cell += 1) {
      context.save();
      context.translate(cell * 512, 0);
      context.beginPath(); context.rect(0, 0, 512, 1024); context.clip();
      const room = context.createLinearGradient(0, 0, 0, 1024);
      room.addColorStop(0, "#0c1114"); room.addColorStop(0.55, "#121a1e"); room.addColorStop(1, "#080b0d");
      context.fillStyle = room; context.fillRect(0, 0, 512, 1024);
      if (cell === 0) {
        for (const side of [0, 1]) {
          context.save();
          context.beginPath();
          if (side === 0) { context.moveTo(0, 0); context.lineTo(214, 0); context.quadraticCurveTo(196, 520, 66, 640); context.lineTo(98, 1024); context.lineTo(0, 1024); }
          else { context.moveTo(512, 0); context.lineTo(298, 0); context.quadraticCurveTo(316, 520, 446, 640); context.lineTo(414, 1024); context.lineTo(512, 1024); }
          context.closePath(); context.clip();
          folds(0, 512, [206, 200, 184], 0.6, 46);
          context.fillStyle = "rgba(16,20,22,.3)";
          for (let i = 0; i < 1100; i += 1) context.fillRect(random() * 512, random() * 1024, 3, 3);
          context.restore();
        }
        context.fillStyle = "rgba(150,122,72,.85)"; context.fillRect(40, 628, 66, 13); context.fillRect(406, 628, 66, 13);
      } else if (cell === 1) {
        folds(0, 512, [188, 184, 170], 0.5, 58);
        context.fillStyle = "rgba(8,12,14,.55)"; context.fillRect(251, 0, 7, 1024);
        context.fillStyle = "rgba(230,224,206,.3)"; context.fillRect(0, 984, 512, 14);
      } else if (cell === 2) {
        const blind = context.createLinearGradient(0, 0, 0, 430);
        blind.addColorStop(0, "#847b68"); blind.addColorStop(1, "#aba188");
        context.fillStyle = blind; context.fillRect(0, 0, 512, 430);
        context.fillStyle = "rgba(60,54,40,.5)"; for (let y = 36; y < 430; y += 36) context.fillRect(0, y, 512, 2);
        context.fillStyle = "#6a6252"; context.fillRect(0, 424, 512, 10);
        context.fillStyle = "#cfc7ae"; context.fillRect(252, 434, 3, 58); context.beginPath(); context.arc(253.5, 498, 8, 0, Math.PI * 2); context.fill();
        context.fillStyle = "#6b3f26"; context.beginPath(); context.moveTo(196, 1024); context.lineTo(208, 930); context.lineTo(312, 930); context.lineTo(324, 1024); context.closePath(); context.fill();
        context.lineCap = "round";
        for (let i = 0; i < 46; i += 1) {
          const angle = -Math.PI / 2 + (random() - 0.5) * 2.3, length = 90 + random() * 200, tone = 0.5 + random() * 0.7;
          context.strokeStyle = `rgb(${28 * tone | 0},${72 * tone | 0},${34 * tone | 0})`; context.lineWidth = 7 + random() * 9;
          context.beginPath(); context.moveTo(260 + (random() - 0.5) * 60, 936); context.quadraticCurveTo(260 + Math.cos(angle) * length * 0.5, 936 + Math.sin(angle) * length * 0.9, 260 + Math.cos(angle) * length, 936 + Math.sin(angle) * length * 0.7); context.stroke();
        }
      } else {
        context.fillStyle = "rgba(96,84,52,.5)"; context.fillRect(262, 250, 170, 210);
        context.fillStyle = "rgba(22,30,34,.95)"; context.fillRect(276, 264, 142, 182);
        context.fillStyle = "rgba(40,48,52,.6)"; context.fillRect(236, 720, 250, 304);
        context.save(); context.beginPath(); context.moveTo(0, 0); context.lineTo(236, 0); context.quadraticCurveTo(206, 500, 150, 1024); context.lineTo(0, 1024); context.closePath(); context.clip();
        folds(0, 260, [112, 44, 38], 0.94, 52);
        context.restore();
      }
      const fall = context.createLinearGradient(0, 0, 0, 1024);
      fall.addColorStop(0, "rgba(255,255,255,.05)"); fall.addColorStop(1, "rgba(0,0,0,.28)");
      context.fillStyle = fall; context.fillRect(0, 0, 512, 1024);
      context.restore();
    }
  });
}

/**
 * The four surfaces of a lived-in room for the lit windows: far wall (left half), side wall, then
 * ceiling over floor. The window shader builds a box out of them, so they shift with the viewer.
 */
function roomAtlas() {
  return canvasTexture(2048, 1024, (context) => {
    const random = rng(515);
    const paper = (x: number, w: number, base: string, stripe: string) => {
      context.fillStyle = base; context.fillRect(x, 0, w, 1024);
      context.fillStyle = stripe; for (let k = 0; k < w; k += 32) context.fillRect(x + k, 0, 12, 1024);
      // Dado rail and panelled wainscot.
      context.fillStyle = "#6f5238"; context.fillRect(x, 690, w, 334);
      context.fillStyle = "#3f2c1c"; context.fillRect(x, 690, w, 12); context.fillRect(x, 1000, w, 24);
      context.strokeStyle = "rgba(30,18,10,.6)"; context.lineWidth = 5;
      for (let k = 22; k < w - 60; k += 128) context.strokeRect(x + k, 730, 96, 244);
      // Cornice shadow under the ceiling.
      const cove = context.createLinearGradient(0, 0, 0, 70);
      cove.addColorStop(0, "rgba(40,24,10,.55)"); cove.addColorStop(1, "rgba(40,24,10,0)");
      context.fillStyle = cove; context.fillRect(x, 0, w, 70);
    };
    const picture = (x: number, y: number, w: number, h: number, sky: string, land: string) => {
      context.fillStyle = "#a8853f"; context.fillRect(x - 14, y - 14, w + 28, h + 28);
      context.fillStyle = "#5a431c"; context.fillRect(x - 5, y - 5, w + 10, h + 10);
      context.fillStyle = sky; context.fillRect(x, y, w, h);
      context.fillStyle = land; context.beginPath(); context.moveTo(x, y + h); context.lineTo(x, y + h * 0.62); context.quadraticCurveTo(x + w * 0.4, y + h * 0.38, x + w * 0.62, y + h * 0.6); context.quadraticCurveTo(x + w * 0.8, y + h * 0.5, x + w, y + h * 0.66); context.lineTo(x + w, y + h); context.closePath(); context.fill();
    };
    // Far wall.
    paper(0, 1024, "#d8c39a", "rgba(150,112,64,.16)");
    context.fillStyle = "#efe4cc"; context.fillRect(78, 196, 250, 828);
    context.fillStyle = "#1b120c"; context.fillRect(100, 218, 206, 806);
    context.fillStyle = "#7a5a3a"; context.fillRect(100, 218, 74, 806);
    context.fillStyle = "#c9a24a"; context.beginPath(); context.arc(160, 640, 8, 0, Math.PI * 2); context.fill();
    picture(430, 236, 210, 150, "#8fb0c2", "#5f7a4a");
    context.fillStyle = "#3a2616"; context.fillRect(404, 600, 270, 96); context.fillRect(416, 696, 16, 60); context.fillRect(646, 696, 16, 60);
    context.fillStyle = "#2f4f6a"; context.beginPath(); context.ellipse(470, 572, 22, 30, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#5a3a1c"; context.fillRect(596, 540, 8, 60);
    context.fillStyle = "#fff0c8"; context.beginPath(); context.moveTo(566, 540); context.lineTo(634, 540); context.lineTo(620, 478); context.lineTo(580, 478); context.closePath(); context.fill();
    context.fillStyle = "#2a1b10"; context.fillRect(728, 150, 256, 548);
    for (let shelf = 0; shelf < 5; shelf += 1) {
      const y = 170 + shelf * 106;
      context.fillStyle = "#0f0906"; context.fillRect(740, y, 232, 92);
      for (let x = 744; x < 964;) {
        const w = 9 + random() * 15, h = 58 + random() * 30, tone = [[122, 47, 42], [38, 64, 94], [47, 90, 80], [176, 138, 60], [216, 200, 164], [74, 52, 35], [138, 90, 122]][Math.floor(random() * 7)];
        context.fillStyle = `rgb(${tone[0]},${tone[1]},${tone[2]})`; context.fillRect(x, y + 92 - h, w, h);
        context.fillStyle = "rgba(255,240,200,.35)"; context.fillRect(x + w * 0.3, y + 100 - h, w * 0.4, 5);
        x += w + 1.5;
      }
    }
    // Side wall.
    paper(1024, 512, "#d3bd94", "rgba(150,112,64,.16)");
    picture(1100, 250, 120, 170, "#c8b890", "#7a4a3a");
    context.fillStyle = "#33220f"; context.fillRect(1290, 330, 190, 370);
    context.strokeStyle = "rgba(190,150,80,.5)"; context.lineWidth = 4; context.strokeRect(1304, 346, 76, 338); context.strokeRect(1390, 346, 76, 338);
    context.fillStyle = "#c9a24a"; context.fillRect(1380, 500, 6, 34); context.fillRect(1386, 500, 6, 34);
    // Ceiling: lime-washed boards between dark beams, a plaster rose in the middle.
    context.fillStyle = "#e6dcc4"; context.fillRect(1536, 0, 512, 512);
    context.fillStyle = "#4a3320"; for (let k = 0; k < 5; k += 1) context.fillRect(1536 + 20 + k * 110, 0, 32, 512);
    context.fillStyle = "rgba(60,40,20,.25)"; for (let k = 0; k < 512; k += 26) context.fillRect(1536, k, 512, 2);
    context.fillStyle = "#f4ecd8"; context.beginPath(); context.arc(1792, 256, 62, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "#b9a880"; context.lineWidth = 6; context.beginPath(); context.arc(1792, 256, 44, 0, Math.PI * 2); context.stroke();
    // Floor: terracotta tiles laid square, a bordered rug across them.
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
      const tone = 0.82 + random() * 0.3;
      context.fillStyle = `rgb(${170 * tone | 0},${88 * tone | 0},${56 * tone | 0})`; context.fillRect(1536 + column * 64, 512 + row * 64, 62, 62);
    }
    context.fillStyle = "#6a1f24"; context.fillRect(1626, 590, 332, 356);
    context.strokeStyle = "#d8b877"; context.lineWidth = 10; context.strokeRect(1650, 614, 284, 308);
    context.fillStyle = "#274a5c"; context.fillRect(1700, 664, 184, 208);
    context.fillStyle = "#d8b877"; context.beginPath(); context.moveTo(1792, 690); context.lineTo(1850, 768); context.lineTo(1792, 846); context.lineTo(1734, 768); context.closePath(); context.fill();
  });
}

/** Streaks and tide marks, multiplied onto walls and paving: [sill drips | cornice wash] over rising damp over kerb grime. */
function stainAtlas() {
  return canvasTexture(1024, 1024, (context) => {
    context.clearRect(0, 0, 1024, 1024);
    const random = rng(808);
    const streak = (x: number, y: number, w: number, h: number, alpha: number, tone = "70,62,52") => {
      const fade = context.createLinearGradient(0, y, 0, y + h);
      fade.addColorStop(0, `rgba(${tone},${alpha})`); fade.addColorStop(0.35, `rgba(${tone},${alpha * 0.55})`); fade.addColorStop(1, `rgba(${tone},0)`);
      context.fillStyle = fade;
      context.beginPath(); context.moveTo(x - w / 2, y); context.lineTo(x + w / 2, y); context.lineTo(x + w * 0.18, y + h); context.lineTo(x - w * 0.18, y + h); context.closePath(); context.fill();
    };
    // Sill drips: heaviest where water runs off the two ends of the sill.
    context.save(); context.beginPath(); context.rect(0, 0, 512, 512); context.clip();
    for (let i = 0; i < 70; i += 1) {
      const end = random() < 0.55, x = end ? (random() < 0.5 ? 40 + random() * 60 : 412 + random() * 60) : 60 + random() * 392;
      streak(x, 0, 5 + random() * (end ? 34 : 16), (end ? 260 : 120) + random() * 230, 0.1 + random() * (end ? 0.3 : 0.14), random() < 0.2 ? "52,62,40" : "70,62,52");
    }
    context.restore();
    // Cornice wash: an even veil of fine runs, repeating sideways.
    context.save(); context.beginPath(); context.rect(512, 0, 512, 512); context.clip();
    for (let i = 0; i < 150; i += 1) {
      const x = 512 + random() * 512, w = 4 + random() * 22, h = 60 + random() * 400, alpha = 0.05 + random() * 0.16;
      for (const shift of [-512, 0, 512]) streak(x + shift, 0, w, h, alpha);
    }
    const veil = context.createLinearGradient(0, 0, 0, 150);
    veil.addColorStop(0, "rgba(70,62,52,.3)"); veil.addColorStop(1, "rgba(70,62,52,0)");
    context.fillStyle = veil; context.fillRect(512, 0, 512, 150);
    context.restore();
    // Soft blots, wrapped so the two long strips tile.
    const blots = (y0: number, y1: number, count: number, tone: () => string, rise: (t: number) => number) => {
      context.save(); context.beginPath(); context.rect(0, y0, 1024, y1 - y0); context.clip();
      for (let i = 0; i < count; i += 1) {
        const t = random(), x = random() * 1024, y = y0 + (y1 - y0) * rise(t), r = 18 + random() * 70, colour = tone(), alpha = 0.05 + random() * 0.12;
        for (const shift of [-1024, 0, 1024]) {
          const blot = context.createRadialGradient(x + shift, y, 0, x + shift, y, r);
          blot.addColorStop(0, `rgba(${colour},${alpha})`); blot.addColorStop(1, `rgba(${colour},0)`);
          context.fillStyle = blot; context.fillRect(x + shift - r, y - r, r * 2, r * 2);
        }
      }
      context.restore();
    };
    // Rising damp: darkest at the foot, an uneven tide line, a little algae.
    const damp = context.createLinearGradient(0, 512, 0, 768);
    damp.addColorStop(0, "rgba(62,58,50,0)"); damp.addColorStop(0.55, "rgba(62,58,50,.16)"); damp.addColorStop(1, "rgba(50,48,42,.5)");
    context.fillStyle = damp; context.fillRect(0, 512, 1024, 256);
    blots(512, 768, 260, () => random() < 0.3 ? "44,60,36" : "58,52,44", (t) => 1 - t * t * 0.8);
    // Kerb grime: thick against the wall (top edge), thinning into the paving.
    const grime = context.createLinearGradient(0, 768, 0, 1024);
    grime.addColorStop(0, "rgba(40,36,30,.6)"); grime.addColorStop(0.3, "rgba(46,42,36,.24)"); grime.addColorStop(1, "rgba(46,42,36,0)");
    context.fillStyle = grime; context.fillRect(0, 768, 1024, 256);
    blots(768, 1024, 240, () => random() < 0.25 ? "40,54,32" : "44,40,34", (t) => t * t * 0.8);
  }, true);
}

/** Tower clock dial: bold hour batons, no numerals. */
/** The town's hen in profile, about `size` across and centred on (x, y): its own mark, drawn here from nothing. */
function henMark(context: CanvasRenderingContext2D, x: number, y: number, size: number, ink: string, ground: string, facing = 1) {
  context.save();
  context.translate(x, y); context.scale(size / 100 * facing, size / 100);
  context.fillStyle = ink; context.strokeStyle = ink; context.lineCap = "round"; context.lineJoin = "round";
  // Tail: three feathers fanning up behind.
  for (const [tx, ty] of [[-52, -30], [-44, -44], [-31, -50]]) { context.beginPath(); context.moveTo(-22, 6); context.quadraticCurveTo(tx - 6, ty + 22, tx, ty); context.quadraticCurveTo(tx + 18, ty + 14, -6, -4); context.closePath(); context.fill(); }
  // Body and breast.
  context.beginPath(); context.ellipse(-2, 8, 30, 22, -0.18, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.ellipse(20, -8, 13, 22, 0.35, 0, Math.PI * 2); context.fill();
  // Head, comb, beak and wattle.
  context.beginPath(); context.arc(28, -30, 10, 0, Math.PI * 2); context.fill();
  for (const [cx, cy] of [[21, -40], [27, -43], [33, -40]]) { context.beginPath(); context.arc(cx, cy, 4.2, 0, Math.PI * 2); context.fill(); }
  context.beginPath(); context.moveTo(36, -34); context.lineTo(49, -29); context.lineTo(36, -25); context.closePath(); context.fill();
  context.beginPath(); context.ellipse(34, -18, 3, 5, 0, 0, Math.PI * 2); context.fill();
  // Legs and feet.
  context.lineWidth = 3.4;
  for (const leg of [-8, 8]) { context.beginPath(); context.moveTo(leg, 27); context.lineTo(leg, 44); context.moveTo(leg - 7, 47); context.lineTo(leg, 44); context.lineTo(leg + 9, 47); context.stroke(); }
  // Eye and wing, cut out of the silhouette.
  context.fillStyle = ground; context.strokeStyle = ground;
  context.beginPath(); context.arc(30, -32, 2, 0, Math.PI * 2); context.fill();
  context.lineWidth = 3; context.beginPath(); context.moveTo(-20, 2); context.quadraticCurveTo(-3, 23, 14, 4); context.stroke();
  context.restore();
}

function clockTexture() {
  return canvasTexture(1024, 1024, (context) => {
    context.scale(4, 4);
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
    // Stopped at five to two: 1:55 on the clock.
    hand((1 + 55 / 60) * Math.PI / 6, 62, 7);
    hand(11 * Math.PI / 6, 98, 5);
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

/**
 * Stone window surround: architrave, sill on a drip course and a moulded head. Origin at the window
 * centre on the wall plane, +z out. `fine` chamfers every arris for the fronts the player stands under.
 */
function surroundGeometry(w: number, h: number, head: boolean, fine: boolean) {
  const shape = new THREE.Shape();
  const ow = w / 2 + 0.17, oh = h / 2 + 0.17;
  shape.moveTo(-ow, -oh); shape.lineTo(ow, -oh); shape.lineTo(ow, oh); shape.lineTo(-ow, oh); shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-w / 2, -h / 2); hole.lineTo(-w / 2, h / 2); hole.lineTo(w / 2, h / 2); hole.lineTo(w / 2, -h / 2); hole.closePath();
  shape.holes.push(hole);
  const block = (bw: number, bh: number, bd: number, y: number) => fine ? chamferBox(bw, bh, bd, 0.016).translate(0, y, bd / 2) : box(bw, bh, bd, 0, y, bd / 2);
  const frame = fine
    ? new THREE.ExtrudeGeometry(shape, { depth: 0.068, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1 })
    : new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
  const parts: THREE.BufferGeometry[] = [frame, block(w + 0.62, 0.11, 0.25, -oh - 0.055)];
  if (fine) parts.push(block(w + 0.46, 0.06, 0.15, -oh - 0.14));
  if (head) parts.push(block(w + 0.5, 0.1, 0.16, oh + 0.13), block(w + 0.74, 0.09, 0.26, oh + 0.225));
  else parts.push(block(w + 0.46, 0.1, 0.16, oh + 0.05));
  return projectUv(merge(parts), 1.6);
}

/** Casement joinery in front of the glass: frame, meeting stiles and thin glazing bars, none sharing a face. */
function sashGeometry(w: number, h: number) {
  const frame = 0.055, foot = 0.078, bars = h > 1.8 ? [-0.21, 0.15] : [0.1];
  return merge([
    box(frame, h, 0.05, -w / 2 + frame / 2, 0, 0), box(frame, h, 0.05, w / 2 - frame / 2, 0, 0),
    box(w - frame * 2, frame, 0.05, 0, h / 2 - frame / 2, 0), box(w - frame * 2, foot, 0.05, 0, -h / 2 + foot / 2, 0),
    box(0.078, h - frame - foot - 0.004, 0.04, 0, (foot - frame) / 2, 0.012),
    ...bars.map((y) => box(w - frame * 2 - 0.004, 0.026, 0.028, 0, y * h, -0.004)),
  ]);
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
    const ring = new THREE.TorusGeometry(0.075, 0.009, 4, 8);
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
  const scroll = new THREE.TorusGeometry(0.075, 0.009, 5, 14, Math.PI * 1.6);
  scroll.rotateY(Math.PI / 2); scroll.translate(0, 0.2, 0.13);
  parts.push(scroll, new THREE.SphereGeometry(0.028, 8, 6).translate(0, 0.235, 0.42), new THREE.ConeGeometry(0.03, 0.08, 6).translate(0, -0.25, 0.42), new THREE.CylinderGeometry(0.05, 0.05, 0.012, 8).translate(0, 0.42, 0.006).rotateX(0));
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

const ROOM_FRAGMENT = /* glsl */`
  #ifdef USE_MAP
  {
    float seedB = fract(vPaneSeed * 7.31 + 0.17), seedC = fract(vPaneSeed * 13.7 + 0.41);
    float flip = vPaneSeed < 0.5 ? -1.0 : 1.0;
    vec3 from = vec3(vPaneAt.x * flip, vPaneAt.y, 0.0);
    vec3 ray = normalize(vPaneAt - vPaneEye);
    ray.x *= flip;
    ray = mix(ray, vec3(1e-4), step(abs(ray), vec3(1e-4)));
    // The room is wider than its window, its floor a little below the sill, its ceiling above the head.
    vec3 low = vec3(-1.7 - seedB * 1.2, -roomPane.y * 0.5 - roomPane.z, -3.0 - seedC * 1.6);
    vec3 high = vec3(1.5 + seedC * 1.3, roomPane.y * 0.5 + 0.5, 0.0);
    vec3 reach = (mix(low, high, step(0.0, ray)) - from) / ray;
    float travel = min(min(reach.x, reach.y), reach.z);
    vec3 hit = from + ray * travel;
    vec3 q = clamp((hit - low) / (high - low), 0.0, 1.0) * 0.992 + 0.004;
    vec2 cell;
    if (reach.z <= reach.x && reach.z <= reach.y) cell = vec2(q.x * 0.5, q.y);
    else if (reach.x <= reach.y) cell = vec2(0.5 + q.z * 0.25, q.y);
    else if (ray.y > 0.0) cell = vec2(0.75 + q.x * 0.25, 0.5 + q.z * 0.5);
    else cell = vec2(0.75 + q.x * 0.25, q.z * 0.5);
    // Mip level from the pane's own footprint: the wall lookups jump at every corner of the room.
    float level = log2(max(length(fwidth(vPaneAt.xy)) * (1.0 + travel * 0.5) * 230.0, 1.0));
    vec3 lamp = vec3(mix(low.x, high.x, 0.42), high.y - 0.55, low.z * 0.45);
    vec3 away = hit - lamp;
    vec3 warmth = mix(vec3(1.0, 0.72, 0.4), vec3(1.0, 0.86, 0.64), seedB);
    vec3 room = textureLod(map, cell, level).rgb * warmth * (0.3 + 1.5 / (1.0 + dot(away, away) * 0.55));
    // Curtains hang just inside the glass: drawn right across in some rooms, held back in the rest.
    float across = vPaneAt.x / roomPane.x, up = vPaneAt.y / roomPane.y + 0.5;
    float drawn = seedC < 0.3 ? 1.0 : smoothstep(0.0, 0.05, abs(across) - (0.16 + 0.2 * seedB));
    float fold = 0.72 + 0.28 * sin(across * 70.0 + sin(up * 6.0 + vPaneSeed * 20.0) * 1.3);
    vec3 cloth = vec3(1.0, 0.82, 0.56) * fold * (0.55 + 0.35 * up) * mix(0.9, 1.25, seedB);
    diffuseColor.rgb *= mix(room, cloth, drawn * 0.86) * 0.95;
  }
  #endif
`;

/** A lit room behind a pane, found by walking the view ray into a box: true parallax from two triangles. */
function roomMaterial(atlas: THREE.Texture) {
  const material = new THREE.MeshBasicMaterial({ map: atlas, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPaneAt;\nvarying vec3 vPaneEye;\nvarying vec3 roomPane;\nvarying float vPaneSeed;")
      .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
        #ifdef USE_INSTANCING
          mat4 paneWorld = modelMatrix * instanceMatrix;
        #else
          mat4 paneWorld = modelMatrix;
        #endif
        // The pane is a unit square scaled to its window, so one draw serves every size: tall windows have their
        // floor just under the sill, short ones sit high in the wall of the room.
        vec3 paneSize = vec3(length(paneWorld[0].xyz), length(paneWorld[1].xyz), 1.0);
        roomPane = vec3(paneSize.xy, paneSize.y > 1.8 ? 0.06 : 0.95);
        vPaneAt = position * paneSize;
        vPaneEye = (inverse(paneWorld) * vec4(cameraPosition, 1.0)).xyz * paneSize;
        vPaneSeed = fract(sin(dot(paneWorld[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 roomPane;\nvarying vec3 vPaneAt;\nvarying vec3 vPaneEye;\nvarying float vPaneSeed;")
      .replace("#include <map_fragment>", ROOM_FRAGMENT);
  };
  material.customProgramCacheKey = () => "piazza-room-v2";
  return material;
}

/** Euler angles, as transforms take them, for a thing tipped about its own x axis, rolled about its z, then turned to a heading. */
function tipped(yaw: number, pitch: number, roll = 0): V3 {
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ")));
  return [euler.x, euler.y, euler.z];
}

/** Euler angles that stand a thing lying along x up along a direction, its top turned toward +x: how a long loaf goes in a basket. */
function along(x: number, y: number, z: number): V3 {
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(x, y, z).normalize()));
  return [euler.x, euler.y, euler.z];
}

/**
 * Crust for the bakery's bread, both loaves in one texture: a floured, cross-scored round seen from above
 * on the left half, a slashed long loaf unrolled on the right (its top at a quarter of the way down).
 */
function breadTextures() {
  const half = (context: CanvasRenderingContext2D, side: number, paint: () => void) => {
    context.save();
    context.beginPath(); context.rect(side * 256, 0, 256, 512); context.clip();
    context.transform(0.5, 0, 0, 1, side * 256, 0);
    paint();
    context.restore();
  };
  const round: Array<[number, number, number, number]> = [[158, 96, 176, 410], [334, 100, 350, 414], [92, 172, 418, 158], [96, 350, 420, 338]];
  const long = [0, 1, 2, 3, 4].map((k): [number, number, number, number] => [52 + k * 92, 196, 104 + k * 92, 62]);
  // A score opens as the loaf springs in the oven: pale crumb between two toasted lips.
  const score = (context: CanvasRenderingContext2D, [x0, y0, x1, y1]: [number, number, number, number], width: number, lips: string, crumb: string) => {
    context.lineCap = "round";
    for (const [w, colour] of [[width + 12, lips], [width, crumb]] as Array<[number, string]>) { context.strokeStyle = colour; context.lineWidth = w; context.beginPath(); context.moveTo(x0, y0); context.quadraticCurveTo((x0 + x1) / 2 + (y1 - y0) * 0.06, (y0 + y1) / 2 - (x1 - x0) * 0.06, x1, y1); context.stroke(); }
  };
  return reliefTextures(512, (context) => {
    const speck = rng(61);
    half(context, 0, () => {
      const crust = context.createRadialGradient(256, 256, 30, 256, 256, 256);
      crust.addColorStop(0, "#cf9650"); crust.addColorStop(0.5, "#b47330"); crust.addColorStop(0.82, "#8c5422"); crust.addColorStop(1, "#633716");
      context.fillStyle = crust; context.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 420; i += 1) { const a = speck() * 6.283, r = Math.sqrt(speck()) * 250; context.fillStyle = speck() < 0.5 ? `rgba(70,34,10,${0.03 + speck() * 0.07})` : `rgba(255,212,150,${0.03 + speck() * 0.06})`; context.beginPath(); context.arc(256 + Math.cos(a) * r, 256 + Math.sin(a) * r, 6 + speck() * 24, 0, 6.283); context.fill(); }
      for (const cut of round) score(context, cut, 16, "rgba(84,44,16,.9)", "#e3bf88");
      // Flour from the proving basket, thickest on the crown.
      for (let i = 0; i < 3400; i += 1) { const a = speck() * 6.283, r = speck() * speck() * 225; context.fillStyle = `rgba(250,241,224,${0.1 + speck() * 0.34})`; context.fillRect(256 + Math.cos(a) * r, 256 + Math.sin(a) * r, 1 + speck() * 4, 1 + speck() * 3); }
    });
    half(context, 1, () => {
      const crust = context.createLinearGradient(0, 0, 0, 512);
      crust.addColorStop(0, "#a96a2c"); crust.addColorStop(0.25, "#c98e48"); crust.addColorStop(0.5, "#a4642a"); crust.addColorStop(0.75, "#74431a"); crust.addColorStop(1, "#a96a2c");
      context.fillStyle = crust; context.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 420; i += 1) { context.fillStyle = speck() < 0.5 ? `rgba(70,34,10,${0.03 + speck() * 0.07})` : `rgba(255,212,150,${0.03 + speck() * 0.06})`; context.beginPath(); context.arc(speck() * 512, speck() * 512, 6 + speck() * 22, 0, 6.283); context.fill(); }
      for (const cut of long) score(context, cut, 14, "rgba(84,44,16,.9)", "#e3bf88");
      for (let i = 0; i < 1500; i += 1) { context.fillStyle = `rgba(250,241,224,${0.08 + speck() * 0.26})`; context.fillRect(speck() * 512, 128 + (speck() + speck() - 1) * 120, 1 + speck() * 4, 1 + speck() * 3); }
    });
  }, (context) => {
    const blister = rng(62);
    context.fillStyle = "#6a6a6a"; context.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 1500; i += 1) { const tone = 80 + blister() * 70 | 0; context.fillStyle = `rgba(${tone},${tone},${tone},.5)`; context.beginPath(); context.arc(blister() * 512, blister() * 512, 2 + blister() * 7, 0, 6.283); context.fill(); }
    half(context, 0, () => { for (const cut of round) score(context, cut, 14, "#d8d8d8", "#3c3c3c"); });
    half(context, 1, () => { for (const cut of long) score(context, cut, 12, "#d8d8d8", "#3c3c3c"); });
  }, 2.4);
}

/** The bakery's two loaves, mapped into `breadTextures`: a round one standing on y = 0 and a long one lying along x about its own axis. */
function breadGeometry() {
  const round = new THREE.LatheGeometry([[0, 0], [0.062, 0], [0.088, 0.012], [0.1, 0.042], [0.094, 0.074], [0.07, 0.099], [0.036, 0.113], [0, 0.117]].map(([x, y]) => new THREE.Vector2(x, y)), 14);
  { const p = round.attributes.position, uv = round.attributes.uv; for (let i = 0; i < p.count; i += 1) uv.setXY(i, 0.25 + p.getX(i) * 2.4, 0.5 + p.getZ(i) * 4.9); }
  const taper = [0, 0.035, 0.09, 0.19, 0.34, 0.5, 0.66, 0.81, 0.91, 0.965, 1];
  const long = new THREE.LatheGeometry(taper.map((t) => new THREE.Vector2(0.043 * Math.sin(Math.PI * t) ** 0.55, (t - 0.5) * 0.44)), 10);
  { const uv = long.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setXY(i, 0.51 + uv.getY(i) * 0.48, uv.getX(i)); }
  long.rotateZ(-Math.PI / 2).scale(1, 0.84, 1);
  return { round, long };
}

/** Eight cloth bindings side by side (spine art on the left of each, board on the right), then a column of page edges. */
function bookAtlas() {
  return canvasTexture(1024, 256, (context) => {
    const wear = rng(57), gilt = "#c9a24a";
    ["#7a2f2a", "#26405e", "#2f5a50", "#a9843a", "#d2c2a0", "#4a3423", "#7d506e", "#1f2a30"].forEach((cloth, k) => {
      const x = k * 112, dark = k === 4;
      context.fillStyle = cloth; context.fillRect(x, 0, 112, 256);
      for (let i = 0; i < 900; i += 1) { context.fillStyle = wear() < 0.5 ? "rgba(0,0,0,.07)" : "rgba(255,255,255,.05)"; context.fillRect(x + wear() * 112, wear() * 256, 1, 1 + wear() * 2); }
      // Spine: gilt rules head and tail, a title label or lettering between.
      context.fillStyle = dark ? "#3a2a1c" : gilt;
      for (const y of k % 2 ? [20, 26, 228, 234] : [16, 30, 150, 222, 236]) context.fillRect(x + 2, y, 36, k % 3 ? 2 : 3);
      if (k % 3 !== 1) { context.fillStyle = dark ? "#5a2620" : k % 2 ? "#141012" : "#5a1c18"; context.fillRect(x + 4, 52, 32, 54); context.fillStyle = gilt; context.fillRect(x + 6, 55, 28, 1); context.fillRect(x + 6, 102, 28, 1); }
      context.fillStyle = dark && k % 3 === 1 ? "#3a2a1c" : gilt;
      for (let line = 0; line < 4; line += 1) context.fillRect(x + 9 + (line % 2) * 3, 64 + line * 9, 22 - (line % 2) * 6, 3);
      context.beginPath(); context.arc(x + 20, 186, 6, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(0,0,0,.22)"; context.fillRect(x, 0, 3, 256); context.fillRect(x + 37, 0, 5, 256);
      // Board: a blind-stamped frame, rubbed at the corners.
      context.strokeStyle = "rgba(255,255,255,.14)"; context.lineWidth = 2; context.strokeRect(x + 50, 14, 54, 228);
      context.strokeStyle = "rgba(0,0,0,.2)"; context.lineWidth = 1; context.strokeRect(x + 54, 20, 46, 216);
      for (const [cx, cy] of [[46, 4], [108, 4], [46, 252], [108, 252]]) { context.fillStyle = "rgba(235,220,190,.3)"; context.beginPath(); context.arc(x + cx, cy, 7, 0, Math.PI * 2); context.fill(); }
    });
    context.fillStyle = "#e6d9bb"; context.fillRect(896, 0, 128, 256);
    for (let y = 0; y < 256; y += 3) { context.fillStyle = `rgba(120,98,64,${0.1 + wear() * 0.16})`; context.fillRect(896, y, 128, 1); }
    for (let i = 0; i < 60; i += 1) { context.fillStyle = "rgba(150,110,60,.12)"; context.beginPath(); context.arc(896 + wear() * 128, wear() * 256, 2 + wear() * 6, 0, Math.PI * 2); context.fill(); }
  });
}

/** A cloth-bound book standing on y = 0 with its spine toward +x and its front board toward +z, bound in one of the atlas's eight cloths. */
function bookGeometry(binding: number) {
  const W = 0.14, H = 0.2, T = 0.034, u0 = binding * 112 / 1024;
  const into = (geometry: THREE.BufferGeometry, from: number, to: number) => { const uv = geometry.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setX(i, from + uv.getX(i) * (to - from)); return geometry; };
  const spine = new THREE.CylinderGeometry(T / 2, T / 2, H, 6, 1, true, 0, Math.PI);
  spine.scale(0.36, 1, 1).translate(W / 2 - 0.0062, H / 2, 0);
  return merge([
    into(spine, u0 + 3 / 1024, u0 + 37 / 1024),
    into(box(W - 0.006, H, 0.003, -0.003, H / 2, T / 2 - 0.0015), u0 + 44 / 1024, u0 + 110 / 1024),
    into(box(W - 0.006, H, 0.003, -0.003, H / 2, -T / 2 + 0.0015), u0 + 110 / 1024, u0 + 44 / 1024),
    into(box(W - 0.009, H - 0.008, T - 0.006, -0.0025, H / 2, 0), 900 / 1024, 1020 / 1024),
  ]);
}

/**
 * The cat on the sill, drawn here from nothing: a ginger tabby with a cream bib, sitting side-on with its tail hung
 * over the edge. Origin on the sill under it, +x the way it faces, +z out from the wall. One mesh: `catRig` names
 * the joint each vertex turns about (0 body, 1 head, 2 tail) and, for the tail, how far down it the vertex lies.
 */
function catGeometry() {
  const ginger = new THREE.Color(0xa87a48), stripe = new THREE.Color(0x7a5230), cream = new THREE.Color(0xbcae92), ink = new THREE.Color(0x15110e), iris = new THREE.Color(0x8d7a22), nose = new THREE.Color(0xa86a62);
  const parts: THREE.BufferGeometry[] = [];
  const add = (source: THREE.BufferGeometry, colour: THREE.Color, part = 0, tabby = false) => {
    const geometry = source.index ? source.toNonIndexed() : source, p = geometry.attributes.position;
    const colours = new Float32Array(p.count * 3), rig = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i += 1) {
      const coat = tabby && Math.sin(p.getX(i) * 64 + p.getY(i) * 11 + Math.abs(p.getZ(i)) * 30) > 0.45 ? stripe : colour;
      colours[i * 3] = coat.r; colours[i * 3 + 1] = coat.g; colours[i * 3 + 2] = coat.b;
      rig[i * 2] = part; rig[i * 2 + 1] = part === 2 ? THREE.MathUtils.clamp((-0.02 - p.getY(i)) / 0.28, 0, 1) : 0;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute("catRig", new THREE.BufferAttribute(rig, 2));
    parts.push(geometry);
  };
  const ball = (rx: number, ry: number, rz: number, x: number, y: number, z: number, w = 12, h = 9) => new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz).translate(x, y, z);
  // Haunches, the upright chest with its bib, forelegs and paws, hind feet tucked alongside.
  add(ball(0.125, 0.105, 0.085, -0.06, 0.105, 0, 14, 10), ginger, 0, true);
  add(new THREE.SphereGeometry(1, 12, 10).scale(0.08, 0.14, 0.072).rotateZ(-0.22).translate(0.055, 0.17, 0), ginger, 0, true);
  add(ball(0.04, 0.08, 0.048, 0.108, 0.2, 0, 10, 8), cream);
  for (const z of [-0.034, 0.034]) {
    add(new THREE.CylinderGeometry(0.021, 0.018, 0.17, 6).translate(0.115, 0.088, z), ginger);
    add(ball(0.031, 0.017, 0.024, 0.128, 0.016, z, 8, 6), cream);
    add(ball(0.05, 0.02, 0.024, 0.03, 0.02, z * 2.3, 8, 6), cream);
  }
  // Head: skull, muzzle, nose, eyes with slit pupils, ears.
  add(ball(0.06, 0.055, 0.064, 0.095, 0.335, 0, 14, 10), ginger, 1, true);
  add(ball(0.03, 0.024, 0.037, 0.142, 0.318, 0, 10, 8), cream, 1);
  add(ball(0.008, 0.007, 0.01, 0.171, 0.325, 0, 6, 4), nose, 1);
  for (const side of [-1, 1]) {
    add(ball(0.009, 0.0095, 0.009, 0.143, 0.346, side * 0.027, 8, 6), iris, 1);
    add(ball(0.0035, 0.008, 0.0035, 0.1498, 0.346, side * 0.0283, 6, 4), ink, 1);
    add(new THREE.ConeGeometry(0.025, 0.052, 4).rotateY(Math.PI / 4).rotateX(side * 0.28).translate(0.086, 0.396, side * 0.037), ginger, 1);
  }
  // Tail: off the rump, over the edge of the sill and down, with a cream tip.
  const tail = new THREE.CatmullRomCurve3(([[-0.165, 0.06, 0], [-0.2, 0.035, 0.05], [-0.205, -0.02, 0.092], [-0.2, -0.12, 0.1], [-0.19, -0.22, 0.1], [-0.168, -0.3, 0.1]] as V3[]).map((point) => new THREE.Vector3(...point)));
  add(new THREE.TubeGeometry(tail, 18, 0.019, 6), ginger, 2, true);
  add(ball(0.022, 0.03, 0.022, -0.166, -0.305, 0.1, 8, 6), cream, 2);
  return mergeGeometries(parts);
}

/** Vertex code for the cat: the head turns about the neck, the tail swings from the edge of the sill and flicks at its tip. */
const CAT_PARS = /* glsl */`
attribute vec2 catRig;
uniform vec4 catPose;   // head yaw, head pitch, tail swing, flick at the tip of the tail
uniform float catMood;  // 1 as it flinches
vec3 catTurnY(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
vec3 catTurnZ(vec3 p, float a) { float s = sin(a), c = cos(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
/** Turns a point (w = 1) or a direction (w = 0) about the joint its vertex hangs from. */
vec3 catTurn(vec3 p, float w) {
  if (catRig.x > 1.5) { vec3 joint = vec3(-0.203, -0.02, 0.092) * w; return catTurnZ(p - joint, catPose.z * catRig.y + catPose.w * catRig.y * catRig.y) + joint; }
  if (catRig.x > 0.5) { vec3 joint = vec3(0.075, 0.285, 0.0) * w; return catTurnY(catTurnZ(p - joint, catPose.y), catPose.x) + joint; }
  return p;
}
`;

// Moving water in one draw: every streak of the fountain's jet, every drop, bead of spray and spreading ring is a
// quad whose shader places it from the clock, so the fall of a drop and the ring it raises never disagree.
const WATER_VERTEX = /* glsl */`
uniform float waterTime;
uniform float waterSurge;
attribute vec2 corner;
attribute vec4 clock;    // kind (0 ring, 1 drop, 2 jet, 3 spray), seconds per cycle, start within it, size
attribute vec4 motion;   // ring: life, first and last radius, strength. drop: fall height, swell time. jet: from, to, fall time, throw. spray: velocity
attribute float glint;
varying vec2 vCorner;
varying vec4 vLook;      // kind, strength, how far along, light
varying float vDepth;
void main() {
  float kind = clock.x, age = mod(waterTime - clock.z, clock.y), size = clock.w, fade = 1.0, along = 0.0;
  vec3 centre = position, offset = vec3(0.0);
  if (kind < 0.5) {
    float k = age / motion.x;
    fade = k < 1.0 ? motion.w * (1.0 - k) * smoothstep(0.0, 0.1, k) : 0.0;
    offset = vec3(corner.x, 0.0, corner.y) * mix(motion.y, motion.z, k);
    along = k;
  } else if (kind < 1.5) {
    // A bead swells where it hangs, lets go, and stretches into a streak as it gathers speed.
    float fall = sqrt(motion.x / 4.905), swell = motion.y;
    vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), cameraPosition - centre));
    if (age < fall) {
      centre.y -= 4.905 * age * age;
      offset = side * corner.x * size * 0.5 + vec3(0.0, corner.y * max(size, 9.81 * age * 0.03) * 0.5, 0.0);
    } else if (age > clock.y - swell) {
      float grow = (age - clock.y + swell) / swell;
      centre.y -= size * 0.4 * grow;
      offset = (side * corner.x + vec3(0.0, corner.y, 0.0)) * size * 0.5 * (0.3 + 0.7 * grow);
    } else fade = 0.0;
  } else if (kind < 2.5) {
    // A ribbon along the arc the water falls in, thrown further and fatter when the pressure surges.
    float s = mix(motion.x, motion.y, corner.y * 0.5 + 0.5), t = s * motion.z;
    vec3 velocity = vec3(motion.w * (0.8 + 0.9 * waterSurge), 0.0, 0.0);
    centre += velocity * t - vec3(0.0, 4.905 * t * t, 0.0);
    vec3 tangent = normalize(velocity - vec3(0.0, 9.81 * t + 0.3, 0.0));
    offset = normalize(cross(tangent, cameraPosition - centre)) * corner.x * size * (1.0 + 1.1 * s) * (0.85 + 0.6 * waterSurge);
    along = s;
  } else {
    float flight = 2.0 * motion.y / 9.81;
    if (age < flight) { centre += motion.xyz * age - vec3(0.0, 4.905 * age * age, 0.0); fade = 1.0 - 0.6 * age / flight; } else fade = 0.0;
  }
  vec4 mv = viewMatrix * vec4(centre + offset, 1.0);
  if (kind > 2.5) mv.xy += corner * size;
  vCorner = corner;
  vLook = vec4(kind, fade, along, glint);
  vDepth = -mv.z;
  gl_Position = fade > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const WATER_FRAGMENT = /* glsl */`
uniform float waterTime;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec2 vCorner;
varying vec4 vLook;
varying float vDepth;
void main() {
  float kind = vLook.x, r = length(vCorner), a;
  vec3 colour = vec3(0.8, 0.9, 0.94) * vLook.w;
  if (kind < 0.5) {
    // A ring is a crest with a trough behind it: light and dark together, so it shows on sunlit stone and on dark water alike.
    float width = mix(0.5, 0.16, vLook.z), band = (r - 1.0 + width) / width;
    if (band < 0.0 || band > 1.0) discard;
    float wave = sin(band * 6.2832);
    colour = wave > 0.0 ? vec3(0.9, 0.96, 1.0) * vLook.w : vec3(0.02, 0.035, 0.045);
    a = abs(wave) * sin(band * 3.1416) * vLook.y * (wave > 0.0 ? 1.0 : 0.55);
  } else if (kind < 1.5) {
    a = (1.0 - smoothstep(0.3, 1.0, abs(vCorner.x))) * (1.0 - smoothstep(0.5, 1.0, abs(vCorner.y))) * 0.85 * vLook.y;
  } else if (kind < 2.5) {
    // Bright down its middle and dark at its rims, the way a rope of water bends the wall behind it.
    float streak = 0.6 + 0.4 * sin(vLook.z * 34.0 - waterTime * 19.0 + vCorner.x * 2.5), core = 1.0 - vCorner.x * vCorner.x;
    colour = mix(vec3(0.2, 0.27, 0.3), colour, smoothstep(0.25, 0.8, core * streak + 0.25 * core));
    a = (1.0 - pow(abs(vCorner.x), 4.0)) * (0.5 + 0.35 * streak) * smoothstep(0.0, 0.05, vLook.z);
  } else {
    a = (1.0 - smoothstep(0.35, 1.0, r)) * 0.8 * vLook.y;
  }
  if (a < 0.004) discard;
  #ifdef USE_FOG
    colour = mix(colour, fogColor, 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth));
  #endif
  gl_FragColor = vec4(colour, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function buildPiazza(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet } = kit;
  // One wind for the whole square. It comes up the street from the low sun and crosses the lanes toward the lit fronts,
  // so a gust shows first in the side square's plane tree, then in the leaves on the cobbles, then in the washing.
  const WIND_HEADING = 1.15;
  const wind = createWind({ heading: WIND_HEADING, strength: 0.36, gustiness: 0.62 });
  const trees = createTrees(kit, { seed: 7, wind, sun: () => sun });
  const life = createLife(kit, options, { wind, seed: 5 });
  // Static one-off pieces are collected here and merged per material at the end, so the whole town costs a few dozen draws.
  const pending: Array<{ mesh: THREE.Mesh; shadow: boolean; hit: boolean }> = [];
  const place = (mesh: THREE.Mesh, x: number, y: number, z: number, shadow = true, hit = false) => {
    mesh.position.set(x, y, z);
    pending.push({ mesh, shadow, hit });
    return mesh;
  };
  /** An axis-aligned block given by its extents. */
  const span = (material: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, shadow = false, hit = false, metres = 1.6) =>
    place(new THREE.Mesh(worldBox(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), metres), material), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, shadow, hit);
  /** Tinted variants of one material that all merge into a single vertex-coloured draw. Only for pieces set with `place`. */
  const family = (base: THREE.MeshStandardMaterial) => {
    base.vertexColors = true;
    const members = new Map<string, THREE.Material>();
    return (color: THREE.ColorRepresentation) => {
      const tint = new THREE.Color(color), key = tint.getHexString();
      let member = members.get(key);
      if (!member) { member = new THREE.MeshBasicMaterial(); member.userData = { family: base, tint }; members.set(key, member); }
      return member;
    };
  };
  /** For what lies flat on the paving, or sits too small and high to show in it: left out of the puddle reflections. */
  const offMirror = <T extends THREE.Material>(material: T) => { material.userData.unmirrored = true; return material; };
  const flush = () => {
    const groups = new Map<string, { material: THREE.Material; shadow: boolean; hit: boolean; parts: THREE.BufferGeometry[] }>();
    for (const { mesh, shadow, hit } of pending) {
      mesh.updateWorldMatrix(true, false);
      const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      if (!source.attributes.normal) source.computeVertexNormals();
      const part = new THREE.BufferGeometry();
      part.setAttribute("position", source.attributes.position);
      part.setAttribute("normal", source.attributes.normal);
      part.setAttribute("uv", source.attributes.uv ?? new THREE.Float32BufferAttribute(new Float32Array(source.attributes.position.count * 2), 2));
      part.applyMatrix4(mesh.matrixWorld);
      const own = mesh.material as THREE.Material, material = (own.userData.family as THREE.Material | undefined) ?? own, key = `${material.uuid}|${hit}`;
      if (material !== own) {
        // A tinted member of a material family: the tint rides in vertex colours so the family draws once.
        const tint = own.userData.tint as THREE.Color, colours = new Float32Array(part.attributes.position.count * 3);
        for (let i = 0; i < colours.length; i += 3) { colours[i] = tint.r; colours[i + 1] = tint.g; colours[i + 2] = tint.b; }
        part.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      }
      let group = groups.get(key);
      if (!group) groups.set(key, group = { material, shadow, hit, parts: [] });
      group.shadow ||= shadow;
      group.parts.push(part);
    }
    // A material with bullet-stopping pieces and others still draws once, unless that would hand the bullet test a far larger mesh.
    for (const [key, group] of groups) {
      const solid = group.hit ? undefined : groups.get(`${group.material.uuid}|true`);
      if (!solid || group.parts.reduce((sum, part) => sum + part.attributes.position.count / 3, 0) > 9000) continue;
      solid.parts.push(...group.parts);
      solid.shadow ||= group.shadow;
      groups.delete(key);
    }
    for (const group of groups.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(group.parts), group.material);
      group.parts.forEach((part) => part.dispose());
      // Scenery beyond the square never reaches the shadow map or a puddle: it is drawn once, in the main view.
      // Things lying flat on the paving, or too small and high to show in it, skip the puddles but keep their shadows.
      const far = group.material.userData.far === true;
      mesh.castShadow = group.shadow && !far;
      mesh.receiveShadow = !far;
      scene.add(mesh);
      if (far || group.material.userData.unmirrored === true) kit.mirrorHidden.push(mesh);
      if (group.hit) kit.shootable.push(mesh);
    }
    pending.length = 0;
  };
  const metals = kit.metals();
  const random = rng(2026);
  /** Instancing that tolerates an empty list. */
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], hit = false, shadow = true, keep = false) => {
    if (!transforms.length) return null;
    const triangles = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3 * transforms.length;
    if (keep || triangles > 9000) return kit.instances(geometry, material, transforms, hit, shadow);
    // Small sets are cheaper folded into the merged batches than drawn on their own in every pass.
    for (const transform of transforms) {
      const mesh = place(new THREE.Mesh(geometry, material), ...transform.position, shadow, hit);
      mesh.rotation.set(...(transform.rotation ?? [0, 0, 0]));
      mesh.scale.set(...(transform.scale ?? [1, 1, 1]));
    }
    return null;
  };
  /** One merged piece, turned and scaled. */
  const stand = (geometry: THREE.BufferGeometry, material: THREE.Material, position: V3, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => {
    const mesh = place(new THREE.Mesh(geometry, material), ...position, false);
    mesh.rotation.set(...rotation);
    mesh.scale.set(...scale);
  };

  // Bottles, jars, produce, crates, casks, sacks, cartons and baskets come from the shared props library.
  // They are gathered here as the scene is dressed and placed at the end, one batch a kind for the whole map.
  const props = createProps(kit);
  type Dressed = PropItem & { kind: PropKind };
  const dressing = new Map<PropKind, Dressed[]>();
  const dress = (...items: Dressed[]) => {
    for (const item of items) { const list = dressing.get(item.kind); if (list) list.push(item); else dressing.set(item.kind, [item]); }
  };
  /** A container with produce settled into it, as `props.fill` does it, left unplaced so every kind stays one batch. */
  const laden = (container: PropKind, item: PropItem, kinds: PropKind | PropKind[], count: number, seed: number, size = 1): Dressed[] => {
    const room = props.get(container).inside!, s = item.scale?.[0] ?? 1, [x, y, z] = item.position;
    const footprint = room.size ? { size: [room.size[0] * s, room.size[1] * s] as [number, number] } : { radius: (room.radius ?? 0.2) * s };
    return [{ ...item, kind: container }, ...props.heap(kinds, { at: [x, y + room.floor * s, z], ...footprint, yaw: item.rotation?.[1] ?? 0, rim: room.rim * s, flare: room.flare, count, scale: size, seed, place: false }).items];
  };
  /** Carries things arranged about the origin onto a seat that is turned or leaning: the cart's bed, the bicycle's bars. */
  const carried = (items: Dressed[], seat: V3, turn: THREE.Quaternion): Dressed[] => items.map((item) => {
    const position = new THREE.Vector3(...item.position).applyQuaternion(turn);
    const euler = new THREE.Euler().setFromQuaternion(turn.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...(item.rotation ?? [0, 0, 0])))));
    return { ...item, position: [position.x + seat[0], position.y + seat[1], position.z + seat[2]], rotation: [euler.x, euler.y, euler.z] };
  });
  const heightOf = (kind: PropKind) => props.get(kind).size[1];

  // ---- Materials -----------------------------------------------------------
  const cobble = photoSet("/textures/cobblestone_floor_04-2k", 150 / 2.1, 130 / 2.1, false);
  const plaster = photoSet("/textures/painted_plaster_wall-2k", 1, 1, false);
  const concrete = photoSet("/textures/concrete_floor_worn_001-2k", 0.8, 0.8);
  const brick = photoSet("/textures/brick_wall_001-2k", 1, 1);
  const plasterMaterial = family(new THREE.MeshStandardMaterial({ ...plaster, roughness: 1, metalness: 0, envMapIntensity: 0.6 }));
  const travertine = photoSet("/textures/concrete_wall_007-2k", 1, 1, false);
  const planks = photoSet("/textures/weathered_brown_planks-2k", 1, 1, false);
  const gingham = photoSet("/textures/fabric_pattern_07-2k", 1, 1, false);
  // Carved stone: a bedded, weather-stained photo set lifted to the ivory of old travertine.
  const stone = new THREE.MeshStandardMaterial({ ...travertine, color: new THREE.Color(2.25, 2.2, 2.3), normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const trim = stone;
  // Bare boards, pale indoors and weathered under the eaves, are one draw; so are the linens, the brasses, the dark glazes, the patinas and the fired clays.
  const plankWood = family(new THREE.MeshStandardMaterial({ ...planks, roughness: 1, metalness: 0, envMapIntensity: 0.45 }));
  const timberPlanks = plankWood(new THREE.Color(1.5, 1.35, 1.2)), eaveWood = plankWood(new THREE.Color(0.75, 0.6, 0.48));
  const paintedWood = family(new THREE.MeshStandardMaterial({ normalMap: planks.normalMap, normalScale: new THREE.Vector2(0.45, 0.45), roughnessMap: planks.roughnessMap, roughness: 0.62, metalness: 0, envMapIntensity: 0.8 }));
  const ginghamCloth = new THREE.MeshStandardMaterial({ ...gingham, roughness: 1, metalness: 0, envMapIntensity: 0.4, side: THREE.DoubleSide });
  // Washing: every piece on the lines is this one cloth, dyed by vertex colour, so the whole wash moves as one draw.
  const linenBase = new THREE.MeshStandardMaterial({ normalMap: gingham.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95, metalness: 0, envMapIntensity: 0.4, side: THREE.DoubleSide });
  const linens = family(linenBase);
  const washDyes = { linen: linens(0xf1ece0), blue: linens(0x7fa3bd), rust: linens(0xb5553c), ochre: linens(0xc49a45) };
  const patina = family(new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.45, envMapIntensity: 0.85 }));
  const verdigris = patina(0x5f9484), copper = patina(0x4f6a5e);
  const brassBase = new THREE.MeshStandardMaterial({ roughness: 0.37, metalness: 0.9, envMapIntensity: 1, side: THREE.DoubleSide });
  const brasses = family(brassBase);
  const brass = brasses(0xb08a3c);
  const ashlarSet = ashlarTextures();
  track(ashlarSet.map); track(ashlarSet.normalMap);
  ashlarSet.map.colorSpace = THREE.NoColorSpace;
  ashlarSet.map.anisotropy = ashlarSet.normalMap.anisotropy = anisotropy;
  const ashlar = new THREE.MeshStandardMaterial({ map: concrete.map, roughnessMap: concrete.roughnessMap, normalMap: ashlarSet.normalMap, normalScale: new THREE.Vector2(1.1, 1.1), aoMap: ashlarSet.map, aoMapIntensity: 1.3, color: new THREE.Color(1.5, 1.33, 1.06), roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  const brickMaterial = family(new THREE.MeshStandardMaterial({ ...brick, roughness: 1, metalness: 0, envMapIntensity: 0.5 }));
  const gardenBrick = brickMaterial(0xd9b596), towerBrick = brickMaterial(0xe0b48c);
  const roofSet = roofTextures();
  track(roofSet.map); track(roofSet.normalMap);
  roofSet.map.anisotropy = roofSet.normalMap.anisotropy = anisotropy;
  const roofTiles = family(new THREE.MeshStandardMaterial({ ...roofSet, roughness: 0.82, metalness: 0, envMapIntensity: 0.6, side: THREE.DoubleSide }));
  const roofs = [0xffffff, 0xe2cdbb, 0xf3d9c4].map(roofTiles);
  const shutterMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.6, metalness: 0, envMapIntensity: 0.7 });
  const glazes = family(offMirror(new THREE.MeshStandardMaterial({ roughness: 0.05, metalness: 0, envMapIntensity: 1.7 })));
  const glass = glazes(0x10171c);
  // Window glass by day: a sheet that mirrors the square, with one of four furnishings showing dimly behind it.
  const paneMap = track(paneAtlas());
  paneMap.anisotropy = anisotropy;
  const paneDark = new THREE.MeshStandardMaterial({ map: paneMap, roughness: 0.07, metalness: 0, envMapIntensity: 1.5 });
  const roomMap = track(roomAtlas());
  roomMap.anisotropy = anisotropy;
  const sash = offMirror(new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.6, metalness: 0 }));
  const iron = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.55, metalness: 0.85, envMapIntensity: 1 });
  const shade = new THREE.MeshStandardMaterial({ color: 0x0c0a08, roughness: 1, metalness: 0, envMapIntensity: 0.1 });
  const earthen = family(new THREE.MeshStandardMaterial({ normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.78, metalness: 0, envMapIntensity: 0.5 }));
  const terracotta = earthen(0xb8643a);
  const doorPaint = paintedWood(0x1f4a40);
  const cafeMetal = pbrMaterial(keep(paintedSteel(anisotropy, [0.5, 0.86, 0.79], 97, 0.35, 256)), { metalness: 0.3, envMapIntensity: 1 });
  // Festoon bulbs and the glass of every lantern glow from one material, so all the town's lamps are a single draw.
  const bulb = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.71, 0.38).multiplyScalar(3.9), toneMapped: false });
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
  type WindowType = { w: number; h: number; head: boolean; surround: Transform[]; fine: Transform[]; dark: Transform[]; lit: Transform[]; bars: Transform[]; leaves: Array<Transform & { colour: number; near: boolean }> };
  const windowType = (w: number, h: number, head: boolean): WindowType => ({ w, h, head, surround: [], fine: [], dark: [], lit: [], bars: [], leaves: [] });
  const tall = windowType(1.15, 2.3, true), small = windowType(1.05, 1.3, false);
  const balconies: Transform[] = [], cornices: Transform[] = [], eaves: Transform[] = [], courses: Transform[] = [], rafters: Transform[] = [], chimneys: Transform[] = [], pots: Transform[] = [];

  /** Every window on the fronts the player can stand under, for the weathering pass. */
  const nearWindows: Array<{ face: Face; s: number; y0: number; type: WindowType; sill: boolean }> = [];
  const addWindow = (face: Face, s: number, y0: number, type: WindowType, o: { shutter?: number | [number | undefined, number | undefined]; colour?: number; lit?: boolean; balcony?: boolean; recess?: number; fine?: boolean } = {}) => {
    const y = y0 + type.h / 2, rotation: V3 = [0, face.yaw, 0], recess = o.recess ?? 0;
    (o.fine ? type.fine : type.surround).push({ position: at(face, s, y, 0), rotation });
    // A sill is free for a flower box where no balcony stands on it and no closed shutter would cut through the flowers.
    if (o.fine) nearWindows.push({ face, s, y0, type, sill: !o.balcony && !Array.isArray(o.shutter) && (o.shutter === undefined || o.shutter > 2) });
    (o.lit ? type.lit : type.dark).push({ position: at(face, s, y, 0.02 - recess), rotation });
    type.bars.push({ position: at(face, s, y, 0.05 - recess), rotation });
    // Each leaf swings on its own jamb: closed it covers half the opening, open it lies back against the wall.
    // One angle sets both; a pair sets the left and right leaf apart, and leaves either off its hinges.
    (Array.isArray(o.shutter) ? o.shutter : [o.shutter, o.shutter]).forEach((angle, index) => {
      if (angle === undefined) return;
      const side = index * 2 - 1, hinge = s + side * (type.w / 2 + 0.02);
      type.leaves.push({ position: at(face, hinge - side * Math.cos(angle) * type.w / 4, y, 0.105 + Math.sin(angle) * type.w / 4), rotation: [0, face.yaw + side * angle, 0], colour: o.colour ?? 0x4a6a54, near: o.fine === true });
    });
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
  /** Half-round ridge and hip tiles over a hip roof. */
  const roofTrim = (cx: number, y: number, cz: number, w: number, d: number, rise: number) => {
    const alongX = w >= d, L = alongX ? w : d, S = alongX ? d : w, r = (L - S) / 2, a: V3 = [-r, rise, 0], b: V3 = [r, rise, 0];
    const parts = [rod([-L / 2, 0, -S / 2], a, 0.13, 6), rod([-L / 2, 0, S / 2], a, 0.13, 6), rod([L / 2, 0, -S / 2], b, 0.13, 6), rod([L / 2, 0, S / 2], b, 0.13, 6)];
    if (r > 0.01) parts.push(rod(a, b, 0.14, 6));
    const mesh = place(new THREE.Mesh(merge(parts), terracotta), cx, y + 0.02, cz, false);
    if (!alongX) mesh.rotation.y = Math.PI / 2;
  };
  /** A plastered block with cornice, timber eaves and a tiled hip roof. */
  const building = (x0: number, x1: number, z0: number, z1: number, h: number, material: THREE.Material, rise = 2.2, chimney = true) => {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    place(new THREE.Mesh(worldBox(w, h, d, 3.2), material), cx, h / 2, cz, true);
    cornices.push({ position: [cx, h - 0.24, cz], scale: [w + 0.36, 0.3, d + 0.36] }, { position: [cx, h - 0.52, cz], scale: [w + 0.18, 0.26, d + 0.18] });
    eaves.push({ position: [cx, h - 0.03, cz], scale: [w + 1.1, 0.12, d + 1.1] });
    place(new THREE.Mesh(hipRoof(w + 1.2, d + 1.2, rise), roofs[Math.floor(random() * roofs.length)]), cx, h + 0.03, cz, true);
    roofTrim(cx, h + 0.03, cz, w + 1.2, d + 1.2, rise);
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
  // Stone ground floor: flat from the far end to the arcade so signs and lamps sit clean on it,
  // pierced by a street doorway and small barred windows in the bays the signs leave free.
  const doorZ = -23.5, cellarZ = [-27.3, -20.1, -14.05, -7.6, -1.5];
  const groundFloor = archedWall(30.8, BAND, 0.5, [
    { x: -(doorZ + 15), width: 1.3, spring: 2.6, flat: true },
    ...cellarZ.map((z) => ({ x: -(z + 15), width: 0.9, spring: 2.45, sill: 1.5 })),
  ], 2);
  groundFloor.rotateY(Math.PI / 2);
  place(new THREE.Mesh(groundFloor, ashlar), LEFT - 0.25, 0, -15, true, true);
  const grille: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i += 1) { const x = -0.34 + i * 0.17; grille.push(rod([x, 1.5, 0], [x, 2.45 + Math.sqrt(0.45 * 0.45 - x * x), 0], 0.011, 5)); }
  for (const y of [1.74, 2.36]) grille.push(rod([-0.45, y, 0], [0.45, y, 0], 0.012, 5));
  for (let i = 0; i < 4; i += 1) grille.push(new THREE.TorusGeometry(0.05, 0.008, 4, 10).translate(-0.255 + i * 0.17, 2.05, 0));
  instances(merge(grille), iron, cellarZ.map((z) => ({ position: [LEFT - 0.1, 0, z] as V3, rotation: [0, Math.PI / 2, 0] as V3 })), false, false);
  for (const z of cellarZ) {
    span(glass, -9.92, -9.88, 1.5, 2.92, z - 0.46, z + 0.46);
    span(stone, -9.88, LEFT + 0.07, 1.41, 1.52, z - 0.56, z + 0.56, false, true);
    place(new THREE.Mesh(keystone(0.25, 0.15, 0.32, 0.075), stone), LEFT - 0.01, 2.83, z, false).rotation.y = Math.PI / 2;
  }
  const arcade = arcadeWall(9.3, BAND, 0.5, [{ x: -3.2, width: 2.3, spring: 2.4 }, { x: 0, width: 2.3, spring: 2.4 }, { x: 3.2, width: 2.3, spring: 2.4 }], 2);
  arcade.rotateY(Math.PI / 2);
  place(new THREE.Mesh(arcade, ashlar), LEFT - 0.25, 0, 5.05, true, true);
  place(new THREE.Mesh(softBox(0.14, 0.9, 6.07, 0.03, 2), stone), LEFT + 0.03, 0.45, -27.365, false, true);
  place(new THREE.Mesh(softBox(0.14, 0.9, 22.67, 0.03, 2), stone), LEFT + 0.03, 0.45, -11.335, false, true);
  // Moulded string course above the stone floor, running the whole street.
  place(new THREE.Mesh(moulding(STRING_COURSE, 41), stone), LEFT - 0.06, BAND - 0.02, -9.9, true);
  // Imposts and keystones on the arcade arches.
  const impost = merge([chamferBox(0.46, 0.07, 0.12, 0.014).translate(0, 0.095, 0.02), chamferBox(0.4, 0.07, 0.08, 0.014).translate(0, 0.03, 0.01)]);
  for (const z of [1.85, 5.05, 8.25]) {
    place(new THREE.Mesh(keystone(0.36, 0.22, 0.46, 0.1), stone), LEFT - 0.01, 3.42, z, false).rotation.y = Math.PI / 2;
    for (const side of [-1, 1]) place(new THREE.Mesh(impost, stone), LEFT, 2.29, z + side * 1.15, false).rotation.y = Math.PI / 2;
  }

  const blocks: Array<{ z0: number; z1: number; h: number; wall: number; shutter: number; levels: Array<{ y: number; type: WindowType }>; balconies: Array<[number, number]>; columns: number }> = [
    { z0: -30.4, z1: -20.2, h: 12.7, wall: 0xe0a85a, shutter: 0x4d6f58, levels: [{ y: 5.5, type: tall }, { y: 9.0, type: tall }], balconies: [[1, 0]], columns: 3 },
    { z0: -20.2, z1: -11.2, h: 14.9, wall: 0xcf7f5c, shutter: 0x2f5a66, levels: [{ y: 5.5, type: tall }, { y: 8.9, type: tall }, { y: 12.3, type: small }], balconies: [[1, 0], [1, 1]], columns: 3 },
    { z0: -11.2, z1: -2.2, h: 11.9, wall: 0xecd9b0, shutter: 0x7a5236, levels: [{ y: 5.5, type: tall }, { y: 9.25, type: small }], balconies: [[0, 0], [2, 0]], columns: 3 },
    { z0: -2.2, z1: 10.6, h: 13.5, wall: 0xdc9f86, shutter: 0x3c5a50, levels: [{ y: 5.5, type: tall }, { y: 9.2, type: tall }], balconies: [[1, 0], [2, 0]], columns: 4 },
  ];
  const pipeRuns: Transform[] = [], hoppers: Transform[] = [], quoins: Transform[] = [], dentils: Transform[] = [];
  const bodyW = 10 - REVEAL, bodyX = UPPER - REVEAL - bodyW / 2;
  blocks.forEach((block, index) => {
    const length = block.z1 - block.z0, cz = (block.z0 + block.z1) / 2, wall = plasterMaterial(block.wall);
    // Body: the last block is hollowed at ground level for the arcade.
    if (index < 3) place(new THREE.Mesh(worldBox(bodyW, block.h, length, 3.2), wall), bodyX, block.h / 2, cz, true, true);
    else {
      place(new THREE.Mesh(worldBox(bodyW, block.h - BAND, length, 3.2), wall), bodyX, (block.h + BAND) / 2, cz, true, true);
      place(new THREE.Mesh(worldBox(bodyW, BAND, 2.6, 3.2), wall), bodyX, BAND / 2, -0.9, true, true);
      place(new THREE.Mesh(worldBox(5.3, BAND, 10.2, 3.2), plasterMaterial(0xd8c3a0)), -16.95, BAND / 2, 5.5, true, true);
      place(new THREE.Mesh(worldBox(3.7, BAND, 0.9, 3.2), wall), -11.45, BAND / 2, 10.15, true, true);
    }
    // The street front is a separate skin with the windows cut through it, so every opening has a real reveal.
    const skin = new THREE.Shape();
    skin.moveTo(-length / 2, BAND); skin.lineTo(length / 2, BAND); skin.lineTo(length / 2, block.h); skin.lineTo(-length / 2, block.h); skin.closePath();
    for (let row = 0; row < block.levels.length; row += 1) for (let column = 0; column < block.columns; column += 1) {
      const z = block.z1 - (column + 0.5) * length / block.columns, roll = random(), { y: y0, type } = block.levels[row];
      const balcony = block.balconies.some(([c, r]) => c === column && r === row);
      const shutter = balcony || roll < 0.52 ? Math.PI - 0.07 : roll < 0.72 ? 0.8 + random() * 0.9 : roll < 0.92 ? 0 : undefined;
      addWindow(FL, -z, y0, type, { shutter, colour: block.shutter, balcony, lit: shutter !== 0 && random() < 0.16, recess: REVEAL - 0.06, fine: true });
      const hole = new THREE.Path(), a = z - cz;
      hole.moveTo(a - type.w / 2, y0); hole.lineTo(a - type.w / 2, y0 + type.h); hole.lineTo(a + type.w / 2, y0 + type.h); hole.lineTo(a + type.w / 2, y0); hole.closePath();
      skin.holes.push(hole);
    }
    const front = new THREE.ExtrudeGeometry(skin, { depth: REVEAL, bevelEnabled: false });
    front.rotateY(-Math.PI / 2);
    front.translate(UPPER, 0, cz);
    place(new THREE.Mesh(projectUv(front, 3.2), wall), 0, 0, 0, true, true);
    place(new THREE.Mesh(moulding(CORNICE, length + 0.3), stone), UPPER, block.h - 0.66, cz, true);
    if (high) for (let z = block.z0 + 0.1; z < block.z1; z += 0.26) dentils.push({ position: [UPPER + 0.15, block.h - 0.42, z] });
    eaves.push({ position: [UPPER - 5, block.h - 0.03, cz], scale: [11.2, 0.12, length + 0.9] });
    const rise = 2.3 + (index % 2) * 0.4;
    place(new THREE.Mesh(hipRoof(11.4, length + 1.0, rise), roofs[index % roofs.length]), UPPER - 5, block.h + 0.03, cz, true);
    for (let z = block.z0 + 0.3; z < block.z1; z += 0.62) rafters.push({ position: [UPPER + 0.3, block.h - 0.15, z] });
    // Copper gutter under the eaves.
    place(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, length + 0.86, 10).rotateX(Math.PI / 2), copper), UPPER + 0.68, block.h - 0.13, cz, false);
    for (const offset of [-0.22, 0.2]) {
      const pz = cz + offset * length;
      chimneys.push({ position: [UPPER - 3.4, block.h + rise * 0.5 + 0.5, pz], scale: [0.75, rise + 1.5, 1] });
      cornices.push({ position: [UPPER - 3.4, block.h + rise + 1.3, pz], scale: [0.95, 0.1, 1.2] });
      pots.push({ position: [UPPER - 3.4, block.h + rise + 1.53, pz - 0.24] }, { position: [UPPER - 3.4, block.h + rise + 1.53, pz + 0.24] });
    }
    // A thin band under the upper windows.
    for (const level of block.levels.slice(1)) courses.push({ position: [UPPER + 0.03, level.y - 0.42, cz], scale: [0.14, 0.14, length] });
    if (index > 0) {
      // Where two houses meet: stone quoins, and a downpipe fed from the lower gutter by a swan neck.
      const low = Math.min(block.h, blocks[index - 1].h), top = low - 0.75, pz = block.z0 + 0.42;
      pipeRuns.push({ position: [UPPER + 0.1, (top + BAND + 0.4) / 2, pz], scale: [1, top - BAND - 0.4, 1] });
      hoppers.push({ position: [UPPER + 0.12, top + 0.1, pz] });
      place(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0.68, low - 0.16], [0.56, low - 0.36], [0.24, low - 0.5], [0.12, low - 0.64]].map(([x, y]) => new THREE.Vector3(UPPER + x, y, pz))), 12, 0.045, 8), copper), 0, 0, 0, false);
      for (let y = BAND + 1; y < top; y += 1.6) span(iron, UPPER, UPPER + 0.17, y, y + 0.03, pz - 0.08, pz + 0.08);
      for (let y = BAND + 0.62, k = 0; y < low - 0.9; y += 0.36, k += 1) quoins.push({ position: [UPPER + 0.03, y, block.z0], scale: [1, 1, k % 2 ? 0.62 : 1] });
    }
  });
  instances(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), copper, pipeRuns);
  instances(softBox(0.22, 0.3, 0.26, 0.03, 1), copper, hoppers);
  instances(new THREE.BoxGeometry(0.62, 0.13, 0.09), eaveWood, rafters, false, false);
  instances(chamferBox(0.1, 0.31, 0.62, 0.018, 1.2), stone, quoins, false, false);

  // ---- Arcade: vaulted walk with three real shop fronts ---------------------
  const PX = -13.2, BACK = -14.3;
  span(stone, PX, LEFT + 0.02, 0, 0.05, 0.4, 9.7, false, false, 1.2);
  const vault = new THREE.CylinderGeometry(1.6, 1.6, 9.3, 20, 1, true, Math.PI / 2, Math.PI);
  scaleUv(vault, 1.6, 2.9);
  vault.rotateX(Math.PI / 2);
  // Seen only from underneath: turned inside out, it shares the wall plaster.
  for (let i = 0, faces = vault.index!; i < faces.count; i += 3) { const first = faces.getX(i); faces.setX(i, faces.getX(i + 2)); faces.setX(i + 2, first); }
  for (let i = 0, normal = vault.attributes.normal; i < normal.count; i += 1) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  place(new THREE.Mesh(vault, plasterMaterial(0xe6d6b8)), -11.62, 2.9, 5.05, false);
  for (const z of [0.5, 3.45, 6.65, 9.6]) {
    place(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.1, 6, 20, Math.PI), stone), -11.62, 2.9, z, false);
    span(stone, PX, PX + 0.16, 2.72, 2.9, z - 0.16, z + 0.16); span(stone, -10.2, -10.04, 2.72, 2.9, z - 0.16, z + 0.16);
    if (z > 1 && z < 9) {
      span(stone, PX, PX + 0.1, 0.05, 2.72, z - 0.13, z + 0.13);
      // A lantern hangs from each rib.
      place(new THREE.Mesh(merge([rod([0, 0, 0], [0, -0.5, 0], 0.008, 4), new THREE.ConeGeometry(0.15, 0.1, 6).translate(0, -0.53, 0), box(0.18, 0.02, 0.18, 0, -0.86, 0)]), iron), -11.62, 4.4, z, false);
      place(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.07, 0.26, 6), bulb), -11.62, 3.69, z, false);
    }
  }
  const shopGlass = offMirror(new THREE.MeshStandardMaterial({ color: 0x24353a, roughness: 0.05, metalness: 0, envMapIntensity: 1.4, transparent: true, opacity: 0.2, depthWrite: false }));
  const shopBackMap = track(canvasTexture(512, 512, (context) => {
    const glow = context.createLinearGradient(0, 0, 0, 512);
    glow.addColorStop(0, "#f7c57c"); glow.addColorStop(0.55, "#e9a253"); glow.addColorStop(1, "#7a3f18");
    context.fillStyle = glow;
    context.fillRect(0, 0, 512, 512);
    context.fillStyle = "rgba(90,40,12,.16)";
    for (let x = 0; x < 512; x += 32) context.fillRect(x, 0, 2, 512);
    const top = context.createLinearGradient(0, 0, 0, 90);
    top.addColorStop(0, "rgba(40,16,4,.7)"); top.addColorStop(1, "rgba(40,16,4,0)");
    context.fillStyle = top;
    context.fillRect(0, 0, 512, 90);
  }));
  const shopBack = offMirror(new THREE.MeshBasicMaterial({ map: shopBackMap, color: new THREE.Color(1.5, 1.3, 1.08), toneMapped: false }));
  const shops: Array<{ paint: number; name: string; line: string; ink: string }> = [
    { paint: 0x2f5a50, name: "FORNO BANANA", line: "PANE · FOCACCE · CHI CONTROLLA BANANA CONTROLLA IL ROUND", ink: "#e9c877" },
    { paint: 0x7a2f2a, name: "CAFFÈ INFERNO", line: "ESPRESSO BOLLENTE · APERITIVI · ORARIO 1:55 – 0:40", ink: "#f1e3c2" },
    { paint: 0x26405e, name: "BIBLIOTECA", line: "LIBRI USATI · LINEUP DI SMOKE · MAPPE de_ E cs_", ink: "#e9c877" },
  ];
  // One sheet carries the three fascia signs, each in a band with a margin of its own paint, so they draw together.
  const signMap = track(canvasTexture(2048, 1024, (context) => {
    shops.forEach((shop, bay) => {
      context.save();
      context.translate(0, bay * 340);
      context.fillStyle = `#${shop.paint.toString(16).padStart(6, "0")}`;
      context.fillRect(0, 0, 2048, 340);
      context.translate(0, 42);
      context.strokeStyle = shop.ink; context.lineWidth = 5; context.strokeRect(22, 22, 2004, 212);
      context.lineWidth = 2; context.strokeRect(36, 36, 1976, 184);
      context.fillStyle = shop.ink; context.textAlign = "center"; context.textBaseline = "middle";
      context.font = "600 112px Georgia, 'Times New Roman', serif";
      context.fillText(shop.name.split("").join(" "), 1024, 108, 1800);
      context.font = "italic 42px Georgia, 'Times New Roman', serif";
      context.fillText(shop.line, 1024, 192, 1880);
      for (const x of [110, 1938]) { context.beginPath(); context.arc(x, 128, 22, 0, Math.PI * 2); context.stroke(); context.beginPath(); context.arc(x, 128, 8, 0, Math.PI * 2); context.fill(); }
      const wear = rng(31 + bay);
      for (let i = 0; i < 2600; i += 1) { context.fillStyle = `rgba(0,0,0,${0.04 + wear() * 0.07})`; context.fillRect(wear() * 2048, wear() * 256, 1 + wear() * 3, 2 + wear() * 16); }
      context.restore();
    });
  }));
  signMap.anisotropy = anisotropy;
  const signPaint = offMirror(new THREE.MeshStandardMaterial({ map: signMap, emissive: 0xffffff, emissiveMap: signMap, emissiveIntensity: 0.3, roughness: 0.5, metalness: 0 }));
  // One more sheet for the small notices about town: the arcade's wayfinding plate, the fountain's, a door card, the house
  // number, the lemon seller's board, the undertaker's plate and the scooter hire board. Pixels on the sheet: x, y, w, h.
  const NOTICES: Record<"arco" | "pit" | "card" | "number" | "lemons" | "coffins" | "hire", [number, number, number, number]> = {
    arco: [0, 0, 512, 320], pit: [512, 0, 512, 192], card: [512, 192, 256, 176], number: [768, 192, 256, 256], lemons: [0, 448, 768, 256], coffins: [0, 704, 384, 240], hire: [384, 704, 448, 320],
  };
  const noticeMap = track(canvasTexture(1024, 1024, (context) => {
    const sheet = (name: keyof typeof NOTICES, draw: (w: number, h: number) => void) => {
      const [x, y, w, h] = NOTICES[name];
      context.save();
      context.translate(x, y); context.beginPath(); context.rect(0, 0, w, h); context.clip();
      context.textAlign = "center"; context.textBaseline = "middle";
      draw(w, h);
      context.restore();
    };
    const screws = (w: number, h: number, inset: number) => { for (const [x, y] of [[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset]]) { context.fillStyle = "#8a8d8c"; context.beginPath(); context.arc(x, y, 7, 0, Math.PI * 2); context.fill(); context.fillStyle = "#3a3d3c"; context.fillRect(x - 5, y - 1, 10, 2); } };
    const arrow = (x: number, y: number, way: number) => { context.beginPath(); context.moveTo(x + way * 15, y); context.lineTo(x + way * 2, y - 10); context.lineTo(x + way * 2, y - 3.5); context.lineTo(x - way * 15, y - 3.5); context.lineTo(x - way * 15, y + 3.5); context.lineTo(x + way * 2, y + 3.5); context.lineTo(x + way * 2, y + 10); context.closePath(); context.fill(); };
    context.fillStyle = "#8a8478"; context.fillRect(0, 0, 1024, 1024);
    // Wayfinding on the arcade pier, in the blue enamel of the street plates.
    sheet("arco", (w, h) => {
      context.fillStyle = "#f3efe2"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#1d3f66"; context.fillRect(12, 12, w - 24, h - 24);
      context.strokeStyle = "#f3efe2"; context.lineWidth = 4; context.strokeRect(27, 27, w - 54, h - 54);
      context.fillStyle = "#f3efe2";
      context.font = "600 104px Georgia, 'Times New Roman', serif"; context.fillText("A R C O", w / 2, 128, w - 100);
      context.fillRect(96, 200, w - 192, 3);
      context.font = "bold 26px 'Arial Narrow', Arial, sans-serif";
      context.textAlign = "left"; arrow(72, 250, -1); context.fillText("BIBLIOTECA", 96, 251);
      context.textAlign = "right"; arrow(w - 72, 250, 1); context.fillText("CAFFÈ · FORNO", w - 96, 251);
      screws(w, h, 46);
    });
    // The fountain's plate: not for drinking, and no camping in the pit.
    sheet("pit", (w, h) => {
      // Dark bronze with pale letters: the fountain's back stands in full sun, where a white plate burns out.
      context.fillStyle = "#b9a56a"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#1f2b27"; context.fillRect(7, 7, w - 14, h - 14);
      context.strokeStyle = "#b9a56a"; context.lineWidth = 2; context.strokeRect(16, 16, w - 32, h - 32);
      context.fillStyle = "#d2c69c";
      context.font = "600 25px Georgia, 'Times New Roman', serif"; context.fillText("F O N T A N A   D E L", w / 2, 40, w - 80);
      context.font = "bold 92px Georgia, 'Times New Roman', serif"; context.fillText("P I T", w / 2, 102, w - 80);
      context.font = "italic 22px Georgia, 'Times New Roman', serif"; context.fillText("acqua non potabile · vietato campeggiare", w / 2, 163, w - 60);
      for (const x of [34, w - 34]) { context.beginPath(); context.arc(x, h / 2, 6, 0, Math.PI * 2); context.fill(); }
    });
    // A card pinned to the garden door.
    sheet("card", (w, h) => {
      context.fillStyle = "#efe6cf"; context.fillRect(0, 0, w, h);
      context.strokeStyle = "#a3261f"; context.lineWidth = 3; context.strokeRect(9, 9, w - 18, h - 18);
      context.fillStyle = "#2a2622"; context.font = "bold 26px 'Arial Narrow', Arial, sans-serif"; context.fillText("TORNO SUBITO", w / 2, 40);
      context.fillStyle = "#a3261f"; context.font = "bold 84px Georgia, 'Times New Roman', serif"; context.fillText("AFK", w / 2, 100);
      context.fillStyle = "#2a2622"; context.font = "italic 18px Georgia, 'Times New Roman', serif"; context.fillText("(cinque minuti, giuro)", w / 2, 152);
      context.fillStyle = "#5b5d5c"; context.beginPath(); context.arc(w / 2, 15, 4.5, 0, Math.PI * 2); context.fill();
    });
    // The house number: the old version, to the decimal.
    sheet("number", (w, h) => {
      context.fillStyle = "#cfc8b4"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#1d3f66"; context.fillRect(10, 10, w - 20, h - 20);
      context.strokeStyle = "#cfc8b4"; context.lineWidth = 4; context.strokeRect(26, 26, w - 52, h - 52);
      context.fillStyle = "#cfc8b4"; context.font = "bold 132px Georgia, serif"; context.fillText("1.6", w / 2, 134);
    });
    // The lemon seller's board: two lemons on a sprig and the oldest rhyme in the book.
    sheet("lemons", (w, h) => {
      context.fillStyle = "#3f6b52"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#f4ead0"; context.fillRect(11, 11, w - 22, h - 22);
      const grain = rng(19);
      for (let i = 0; i < 260; i += 1) { context.fillStyle = `rgba(120,90,50,${0.03 + grain() * 0.05})`; context.fillRect(11 + grain() * (w - 22), 11 + grain() * (h - 22), 30 + grain() * 120, 1); }
      context.strokeStyle = "#4b6a34"; context.lineWidth = 6; context.lineCap = "round";
      context.beginPath(); context.moveTo(40, 52); context.quadraticCurveTo(110, 36, 172, 70); context.stroke();
      for (const [x, y, turn] of [[70, 62, -0.5], [150, 50, 0.4]]) { context.save(); context.translate(x, y); context.rotate(turn); context.fillStyle = "#4f7a3a"; context.beginPath(); context.moveTo(-30, 0); context.quadraticCurveTo(0, -20, 30, 0); context.quadraticCurveTo(0, 16, -30, 0); context.fill(); context.restore(); }
      for (const [x, y, turn, k] of [[92, 142, -0.35, 1], [176, 168, 0.3, 0.86]]) {
        context.save(); context.translate(x, y); context.rotate(turn); context.scale(k, k);
        context.fillStyle = "#f0c22a"; context.beginPath(); context.moveTo(-62, 0); context.bezierCurveTo(-44, -46, 40, -46, 58, -6); context.lineTo(70, 0); context.lineTo(58, 6); context.bezierCurveTo(40, 46, -44, 46, -62, 0); context.fill();
        context.fillStyle = "rgba(255,246,190,.7)"; context.beginPath(); context.ellipse(-10, -16, 26, 9, -0.1, 0, Math.PI * 2); context.fill();
        context.fillStyle = "rgba(170,120,10,.35)"; context.beginPath(); context.ellipse(4, 20, 40, 10, 0.05, 0, Math.PI * 2); context.fill();
        context.restore();
      }
      context.fillStyle = "#27523f"; context.font = "bold 110px Georgia, 'Times New Roman', serif"; context.fillText("LIMONI", 494, 80, 480);
      context.fillStyle = "#b3302a"; context.font = "italic 70px Georgia, 'Times New Roman', serif"; context.fillText("easy peasy", 494, 160, 480);
      context.fillStyle = "#27523f"; context.font = "27px Georgia, 'Times New Roman', serif"; context.fillText("spremuti al momento — lemon squeezy", 494, 218, 480);
    });
    // The undertaker's plate, black glass and gold.
    sheet("coffins", (w, h) => {
      context.fillStyle = "#0f0f10"; context.fillRect(0, 0, w, h);
      context.strokeStyle = "#c9a24a"; context.lineWidth = 3; context.strokeRect(13, 13, w - 26, h - 26);
      context.lineWidth = 1; context.strokeRect(20, 20, w - 40, h - 40);
      context.fillStyle = "#d8b45a";
      context.font = "600 24px Georgia, 'Times New Roman', serif"; context.fillText("ONORANZE FUNEBRI", w / 2, 58);
      context.font = "bold 68px Georgia, 'Times New Roman', serif"; context.fillText("COFFINS", w / 2, 122, w - 56);
      context.fillRect(w / 2 - 60, 164, 120, 2);
      context.font = "italic 24px Georgia, 'Times New Roman', serif"; context.fillText("c'è sempre qualcuno dietro", w / 2, 194, w - 56);
    });
    // The scooter hire board.
    sheet("hire", (w, h) => {
      context.fillStyle = "#f4efe3"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#b3302a"; context.fillRect(0, 0, w, 78);
      context.strokeStyle = "#b3302a"; context.lineWidth = 6; context.strokeRect(3, 3, w - 6, h - 6);
      context.fillStyle = "#f4efe3"; context.font = "bold 40px 'Arial Narrow', Arial, sans-serif"; context.fillText("NOLEGGIO SCOOTER", w / 2, 42);
      context.fillStyle = "#b3302a"; context.font = "bold 124px 'Arial Narrow', Arial, sans-serif"; context.fillText("RUSH B", w / 2, 150, w - 50);
      context.fillStyle = "#2a2622"; context.font = "italic 40px Georgia, 'Times New Roman', serif"; context.fillText("sola andata", w / 2, 234);
      context.font = "26px Georgia, 'Times New Roman', serif"; context.fillText("partenze in gruppi da cinque", w / 2, 284, w - 50);
    });
    const speck = rng(23);
    for (let i = 0; i < 5200; i += 1) { context.fillStyle = `rgba(0,0,0,${0.03 + speck() * 0.05})`; context.fillRect(speck() * 1024, speck() * 1024, 1 + speck() * 2, 1 + speck() * 7); }
  }));
  noticeMap.anisotropy = anisotropy;
  const noticePaint = offMirror(new THREE.MeshStandardMaterial({ map: noticeMap, roughness: 0.78, metalness: 0, envMapIntensity: 0.35 }));
  /** A flat notice cut from the sheet, `width` metres across and as tall as its artwork makes it. */
  const notice = (name: keyof typeof NOTICES, width: number) => {
    const [x, y, w, h] = NOTICES[name], plane = new THREE.PlaneGeometry(width, width * h / w), uv = plane.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (x + 3 + uv.getX(i) * (w - 6)) / 1024, 1 - (y + 3 + (1 - uv.getY(i)) * (h - 6)) / 1024);
    return plane;
  };
  // The arcade's own plate on the pier between the café and the bookshop.
  place(new THREE.Mesh(notice("arco", 0.6), noticePaint), LEFT + 0.008, 1.94, 6.65, false).rotation.y = Math.PI / 2;
  const shelf = rng(88);
  [1.85, 5.05, 8.25].forEach((z0, bay) => {
    const shop = shops[bay], m = bay === 1 ? -1 : 1, paint = paintedWood(shop.paint);
    const part = (material: THREE.Material, x0: number, x1: number, y0: number, y1: number, t0: number, t1: number) => span(material, x0, x1, y0, y1, z0 + m * t0, z0 + m * t1);
    // Display window on a panelled stall riser.
    part(paint, PX, PX + 0.1, 0.05, 0.55, -1.35, 0.47);
    part(paint, PX + 0.1, PX + 0.125, 0.14, 0.46, -1.22, -0.5); part(paint, PX + 0.1, PX + 0.125, 0.14, 0.46, -0.38, 0.34);
    part(stone, PX, PX + 0.16, 0.55, 0.6, -1.38, 0.5);
    part(paint, PX, PX + 0.09, 0.6, 2.55, -1.35, -1.28); part(paint, PX, PX + 0.09, 0.6, 2.55, 0.4, 0.47);
    part(paint, PX, PX + 0.09, 2.5, 2.6, -1.35, 1.35);
    part(paint, PX + 0.01, PX + 0.06, 0.6, 2.5, -0.46, -0.42); part(paint, PX + 0.01, PX + 0.06, 2.04, 2.08, -1.28, 0.4);
    part(shopGlass, PX + 0.03, PX + 0.04, 0.6, 2.5, -1.28, 0.4);
    // Fascia with a moulded top and a painted name.
    part(paint, PX, PX + 0.1, 2.6, 3.0, -1.42, 1.42); part(paint, PX, PX + 0.17, 2.97, 3.03, -1.45, 1.45); part(paint, PX, PX + 0.13, 2.6, 2.64, -1.42, 1.42);
    // The painted name is this shop's band of the shared sign sheet.
    const sign = new THREE.PlaneGeometry(2.72, 0.34);
    for (let i = 0; i < 4; i += 1) sign.attributes.uv.setY(i, 1 - (bay * 340 + 298 - sign.attributes.uv.getY(i) * 256) / 1024);
    place(new THREE.Mesh(sign, signPaint), PX + 0.104, 2.81, z0, false).rotation.y = Math.PI / 2;
    // Recessed doorway: glazed door, kick panel, transom light and a stone step.
    part(paint, PX - 0.42, PX + 0.09, 0.05, 2.5, 0.47, 0.52); part(paint, PX - 0.42, PX + 0.09, 0.05, 2.5, 1.3, 1.35);
    part(stone, PX - 0.42, PX + 0.06, 0.05, 0.11, 0.52, 1.3);
    part(paint, PX - 0.42, PX - 0.37, 0.11, 1.96, 0.52, 0.62); part(paint, PX - 0.42, PX - 0.37, 0.11, 1.96, 1.2, 1.3);
    part(paint, PX - 0.42, PX - 0.37, 0.11, 0.92, 0.62, 1.2); part(paint, PX - 0.37, PX - 0.35, 0.24, 0.8, 0.7, 1.12);
    part(paint, PX - 0.42, PX - 0.37, 1.96, 2.18, 0.52, 1.3);
    part(shopGlass, PX - 0.4, PX - 0.39, 0.92, 1.96, 0.62, 1.2); part(shopGlass, PX - 0.4, PX - 0.39, 2.18, 2.5, 0.52, 1.3);
    part(brass, PX - 0.37, PX - 0.32, 1.0, 1.28, 0.655, 0.685); part(brass, PX - 0.37, PX - 0.355, 0.11, 0.24, 0.62, 1.2);
    // The room behind the glass.
    place(new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.6), shopBack), BACK + 0.02, 1.3, z0, false).rotation.y = Math.PI / 2;
    part(shade, BACK, PX, 2.5, 2.62, -1.5, 1.5); part(shade, BACK, PX - 0.42, 0, 2.6, -1.5, -1.44); part(shade, BACK, PX - 0.42, 0, 2.6, 1.44, 1.5);
    part(timberPlanks, BACK, PX, 0.48, 0.55, -1.35, 0.47);
    part(timberPlanks, BACK, PX - 0.42, 0, 0.05, 0.47, 1.35);
    for (const y of [1.12, 1.58, 2.04]) part(timberPlanks, BACK + 0.03, BACK + 0.36, y - 0.035, y, -1.3, 0.42);
    part(timberPlanks, BACK + 0.03, BACK + 0.36, 0.55, 2.3, -0.46, -0.42);
    const zAt = (t: number) => z0 + m * t, shelfX = BACK + 0.2, sillX = PX - 0.36;
    if (bay === 0) {
      // Bakery: scored rounds and slashed long loaves, floured, in five bakes.
      const { round, long } = breadGeometry(), breadSet = breadTextures();
      breadSet.map.anisotropy = anisotropy;
      track(breadSet.map); track(breadSet.normalMap);
      const crust = new THREE.MeshStandardMaterial({ ...breadSet, roughness: 0.78, metalness: 0, envMapIntensity: 0.5 });
      crust.userData.far = true;
      const crusts = [0xffffff, 0xf4dfc4, 0xe4c8a2, 0xfff2dc, 0xd6b48c].map(family(crust));
      const bake = () => crusts[Math.floor(shelf() * crusts.length)];
      const boule = (x: number, y: number, t: number, k: number) => stand(round, bake(), [x, y, zAt(t)], [0, shelf() * 6.3, 0], [k, k * (0.85 + shelf() * 0.3), k]);
      // Top shelf: big rounds, each turned its own way.
      for (let t = -1.16; t < 0.36; t += 0.2 + shelf() * 0.09) { if (Math.abs(t + 0.44) < 0.13) t = -0.3; boule(shelfX + (shelf() - 0.5) * 0.06, 2.04, t, 0.8 + shelf() * 0.3); }
      // Middle shelf: long loaves stood against the wall, then three stacked beside a round.
      for (let t = -1.2; t < -0.55; t += 0.1 + shelf() * 0.035) {
        const tilt = 0.2 + shelf() * 0.12, k = 0.8 + shelf() * 0.1, reach = 0.22 * k;
        stand(long, bake(), [BACK + 0.075 + Math.sin(tilt) * reach, 1.582 + Math.cos(tilt) * reach, zAt(t)], [0, 0, -Math.PI / 2 + tilt], [k, 1, 1]);
      }
      stand(long, bake(), [shelfX - 0.065, 1.616, zAt(0.0)], [0, Math.PI / 2 + 0.04, 0]);
      stand(long, bake(), [shelfX + 0.03, 1.616, zAt(-0.03)], [0, Math.PI / 2 - 0.07, 0]);
      stand(long, bake(), [shelfX - 0.015, 1.678, zAt(0.02)], [0, Math.PI / 2 + 0.11, 0], [0.94, 1, 1]);
      boule(shelfX, 1.58, 0.32, 0.86);
      // Low shelf: rolls two deep with a few riding on top, a dark round and a long loaf beside them.
      for (let t = -1.2, n = 0; t < -0.53; t += 0.095 + shelf() * 0.02, n += 1) {
        for (const side of [-1, 1]) boule(shelfX + side * 0.05 + (shelf() - 0.5) * 0.02, 1.12, t + (shelf() - 0.5) * 0.02, 0.44 + shelf() * 0.06);
        if (n % 3 === 1) boule(shelfX + (shelf() - 0.5) * 0.03, 1.156, t + 0.05, 0.42);
      }
      boule(shelfX, 1.12, -0.24, 0.98);
      stand(long, crusts[4], [shelfX + 0.02, 1.156, zAt(0.13)], [0, Math.PI / 2 + 0.16, 0]);
      // Window: a basket of long loaves, a tray of rolls and two big rounds.
      const basketAt: V3 = [PX - 0.46, 0.55, zAt(0.12)], trayAt: V3 = [PX - 0.42, 0.55, zAt(-0.7)];
      dress({ kind: "basket", position: basketAt, rotation: [0, 0.4, 0] }, { kind: "basketTray", position: trayAt, rotation: [0, 1.1, 0] });
      for (let k = 0; k < 6; k += 1) {
        const angle = k * Math.PI * 0.4 + 0.3, lean = k < 5 ? 0.26 + shelf() * 0.08 : 0.04, foot = k < 5 ? 0.09 : 0.01, size = 0.94 + shelf() * 0.16, reach = 0.22 * size;
        const tip: V3 = [Math.sin(lean) * Math.cos(angle), Math.cos(lean), Math.sin(lean) * Math.sin(angle)];
        stand(long, bake(), [basketAt[0] + foot * Math.cos(angle) + tip[0] * reach, 0.575 + tip[1] * reach, basketAt[2] + foot * Math.sin(angle) + tip[2] * reach], along(...tip), [size, 1, 1]);
      }
      // Rolls: one in the middle, rings of six and twelve round it, four more riding in the hollows.
      for (let k = 0; k < 23; k += 1) {
        const upper = k > 18, angle = upper ? k * Math.PI / 2 + 0.5 : k < 7 ? k * Math.PI / 3 + 0.2 : k * Math.PI / 6 + 0.33, ring = upper ? 0.07 + shelf() * 0.06 : k === 0 ? 0 : k < 7 ? 0.097 : 0.188;
        stand(round, bake(), [trayAt[0] + Math.cos(angle) * ring, upper ? 0.598 : 0.561, trayAt[2] + Math.sin(angle) * ring], [0, shelf() * 6.3, 0], [0.46, 0.44 + shelf() * 0.1, 0.46]);
      }
      boule(PX - 0.3, 0.55, -1.16, 1.2); boule(PX - 0.26, 0.55, -0.27, 1.25);
    } else if (bay === 1) {
      // Café: a bar back. Bottles stand in runs of a kind, as a barman shelves them, with a gap where one has been taken down.
      const rows: Array<[number, PropKind[]]> = [[2.04, ["bottleWine", "bottleSpirits", "bottleWine"]], [1.58, ["bottleSpirits", "bottleBeer", "bottleWine", "bottleSoda"]], [1.12, ["jar", "bottleSoda", "jar", "bottleBeer"]]];
      for (const [y, kinds] of rows) for (let t = -1.24 + shelf() * 0.05, run = 0; t < 0.36; t += 0.11 + shelf() * 0.16, run += 1) {
        const kind = kinds[run % kinds.length], pitch = props.get(kind).size[0] + 0.012;
        for (let i = 1 + Math.floor(shelf() * 3); i > 0 && t < 0.38; i -= 1, t += pitch + shelf() * 0.012) {
          if (Math.abs(t + 0.44) < 0.08) t = -0.34;
          dress({ kind, position: [shelfX + (shelf() - 0.5) * 0.05, y, zAt(t)], rotation: [0, Math.PI / 2 + (shelf() - 0.5) * 0.7, 0] });
        }
      }
      // Window: three wines behind a pair of preserves, a pyramid of jars, two bottles of the house spirit.
      const jarH = heightOf("jar");
      dress(
        { kind: "bottleWine", position: [sillX - 0.1, 0.55, zAt(-1.02)], rotation: [0, 1.4, 0] }, { kind: "bottleWine", position: [sillX - 0.07, 0.55, zAt(-0.9)], rotation: [0, 1.8, 0] }, { kind: "bottleWine", position: [sillX - 0.11, 0.55, zAt(-0.78)], rotation: [0, 1.25, 0] },
        { kind: "jar", position: [sillX + 0.08, 0.55, zAt(-0.95)], rotation: [0, 1.5, 0] }, { kind: "jar", position: [sillX + 0.1, 0.55, zAt(-0.81)], rotation: [0, 1.9, 0] },
        { kind: "jar", position: [sillX, 0.55, zAt(-0.22)], rotation: [0, 1.3, 0] }, { kind: "jar", position: [sillX + 0.01, 0.55, zAt(-0.105)], rotation: [0, 1.75, 0] }, { kind: "jar", position: [sillX + 0.005, 0.55 + jarH, zAt(-0.16)], rotation: [0, 1.6, 0] },
        { kind: "bottleSpirits", position: [sillX - 0.04, 0.55, zAt(0.16)], rotation: [0, 1.45, 0] }, { kind: "bottleSpirits", position: [sillX + 0.07, 0.55, zAt(0.29)], rotation: [0, 1.85, 0] },
      );
    } else {
      // Bookshop: cloth bindings with gilt spines and cream page blocks.
      const bookMap = track(bookAtlas());
      bookMap.anisotropy = anisotropy;
      const cloth = new THREE.MeshStandardMaterial({ map: bookMap, roughness: 0.82, metalness: 0, envMapIntensity: 0.5 });
      cloth.userData.far = true;
      const bindings = Array.from({ length: 8 }, (_, k) => bookGeometry(k));
      const book = (position: V3, rotation: V3, scale: V3) => stand(bindings[Math.floor(shelf() * 8)], cloth, position, rotation, scale);
      /** A pile of books lying flat, spines to the window, each a little askew. */
      const pile = (x: number, y: number, t: number, count: number) => {
        for (let i = 0, top = y; i < count; i += 1) {
          const thick = 0.7 + shelf() * 0.9, tall = 0.85 + shelf() * 0.3, yaw = (shelf() - 0.5) * 0.5, reach = 0.1 * tall;
          book([x - Math.sin(yaw) * reach, top + 0.017 * thick, zAt(t) - Math.cos(yaw) * reach], tipped(yaw, Math.PI / 2), [0.9 + shelf() * 0.2, tall, thick]);
          top += 0.034 * thick;
        }
      };
      // Shelves: runs of upright books, a leaner or a lying pile closing a run, a gap where one was sold.
      for (const y of [1.12, 1.58, 2.04]) for (const [from, to] of [[-1.27, -0.47], [-0.41, 0.4]]) for (let t = from; t < to - 0.05;) {
        for (let i = 4 + Math.floor(shelf() * 7); i > 0; i -= 1) {
          const thick = 0.6 + shelf() * 1.1, wide = 0.85 + shelf() * 0.25, w = 0.034 * thick;
          if (t + w > to) break;
          book([BACK + 0.34 - 0.07 * wide - shelf() * 0.02, y, zAt(t + w / 2)], [0, 0, 0], [wide, 0.82 + shelf() * 0.36, thick]);
          t += w + 0.001;
        }
        const close = shelf();
        if (close < 0.4 && t + 0.1 < to) {
          const tilt = 0.2 + shelf() * 0.14, tall = 0.85 + shelf() * 0.2;
          book([BACK + 0.26, y + 0.017 * Math.sin(tilt), zAt(t + 0.2 * tall * Math.sin(tilt) + 0.018)], [-tilt * m, 0, 0], [1, tall, 1]);
          t += 0.2 * tall * Math.sin(tilt) + 0.05;
        } else if (close < 0.62 && t + 0.25 < to) {
          pile(BACK + 0.2, y, t + 0.125, 2 + Math.floor(shelf() * 2));
          t += 0.24;
        }
        t += 0.03 + shelf() * 0.1;
      }
      // Window: three piles and two large volumes stood face out.
      pile(PX - 0.3, 0.55, -1.02, 4); pile(PX - 0.34, 0.55, -0.16, 5); pile(PX - 0.28, 0.55, 0.27, 3);
      book([PX - 0.22, 0.552, zAt(-0.66)], tipped(Math.PI / 2, -0.1), [1.35, 1.3, 0.9]);
      book([PX - 0.5, 0.552, zAt(0.06)], tipped(Math.PI / 2 - 0.3, -0.12), [1.2, 1.45, 1.1]);
    }
  });

  // Striped awnings over the arches.
  const awningGeometry = (() => {
    const w = 2.56, reach = 1.5, drop = 0.75;
    // Cut finely enough to billow. The cloth is held along the wall and along its front bar (v = 0 and 1), so the
    // slope bellies between them; the valance is given v from 1 at the bar to 0.5 at its hem, which leaves the hem free.
    const cloth = new THREE.PlaneGeometry(w, 1, 26, 12);
    const position = cloth.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const v = position.getY(i) + 0.5, x = position.getX(i);
      position.setXYZ(i, x, -drop * (1 - v) - 0.03 * Math.sin((x / w + 0.5) * Math.PI) * (1 - v), reach * (1 - v));
    }
    const valance = new THREE.PlaneGeometry(w, 0.24, 26, 3);
    valance.translate(0, -drop - 0.12, reach);
    for (let i = 0; i < valance.attributes.uv.count; i += 1) valance.attributes.uv.setY(i, 0.5 + valance.attributes.uv.getY(i) * 0.5);
    const merged = merge([cloth, valance]);
    merged.computeVertexNormals();
    return merged;
  })();
  const awningMaps = [track(stripeTexture("#efe6d0", "#3f9d92", "#d79a45")), track(stripeTexture("#efe6d0", "#cf7f35", "#2f8f88"))];
  // Two colourways, three stripes to the cloth; the market cart's canopy is cut from the second.
  const awningCloths = awningMaps.map((map) => {
    map.repeat.set(3, 1); map.anisotropy = anisotropy;
    return new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.22, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4 });
  });
  [1.85, 5.05, 8.25].forEach((z, index) => {
    place(new THREE.Mesh(awningGeometry, awningCloths[index % 2]), LEFT + 0.02, 4.02, z, true).rotation.y = Math.PI / 2;
  });
  // Both cloths breathe with the wind and crack when a gust front reaches the arcade; the cart's canopy and the
  // bunting are cut from the same two and move with them.
  life.cloth(awningCloths, { amplitude: 0.08, pin: "sides", lean: 0 }).snap([LEFT + 0.9, 3.5, 5.05]);
  instances(merge([rod([0, 0, 0], [0, -0.72, 1.48], 0.012), rod([0, -0.6, 0], [0, -0.72, 1.48], 0.012)]), iron, [0.6, 3.1, 3.8, 6.3, 7.0, 9.5].map((z) => ({ position: [LEFT + 0.02, 4.0, z] as V3, rotation: [0, Math.PI / 2, 0] as V3 })), false, false);

  // A painted street door set back in its doorway, between the far sign and the corner.
  place(new THREE.Mesh(surroundGeometry(1.3, 2.6, true, true), stone), LEFT, 1.3, doorZ, false).rotation.y = Math.PI / 2;
  place(new THREE.Mesh(merge([box(0.05, 2.6, 1.3, 0, 0, 0), box(0.03, 0.9, 0.42, 0.03, 0.62, -0.31), box(0.03, 0.9, 0.42, 0.03, 0.62, 0.31), box(0.03, 0.8, 0.42, 0.03, -0.5, -0.31), box(0.03, 0.8, 0.42, 0.03, -0.5, 0.31), box(0.035, 2.6, 0.03, 0.03, 0, 0)]), doorPaint), -9.88, 1.3, doorZ, false, true);
  place(new THREE.Mesh(merge([new THREE.SphereGeometry(0.045, 12, 8), new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6).rotateZ(Math.PI / 2).translate(-0.04, 0, 0), box(0.012, 0.05, 0.24, -0.02, 0.22, -0.36), new THREE.TorusGeometry(0.05, 0.01, 5, 12).rotateY(Math.PI / 2).translate(0, 0.45, -0.4)]), brass), -9.78, 1.15, doorZ + 0.08, false);
  span(stone, -9.92, LEFT + 0.1, 0, 0.13, doorZ - 0.65, doorZ + 0.65, false, true);
  // House number tile beside the door, and the undertaker's plate on the other jamb.
  place(new THREE.Mesh(notice("number", 0.2), noticePaint), LEFT + 0.004, 2.05, doorZ + 1.1, false).rotation.y = Math.PI / 2;
  place(new THREE.Mesh(notice("coffins", 0.42), noticePaint), LEFT + 0.006, 2.05, doorZ - 1.12, false).rotation.y = Math.PI / 2;

  // Wall fountain between the lamp and the corner block.
  const fountainZ = -4.6;
  const pediment = new THREE.CylinderGeometry(1, 1, 0.2, 24, 1, false, 0, Math.PI);
  pediment.rotateZ(Math.PI / 2);
  place(new THREE.Mesh(merge([softBox(0.2, 2.5, 2.0, 0.03, 2), projectUv(pediment.translate(0, 1.25, 0), 2), box(0.3, 0.14, 2.3, 0.03, 1.25, 0), box(0.26, 0.2, 2.2, 0.02, -1.15, 0)]), stone), LEFT + 0.1, 1.25, fountainZ, true, true);
  const basinProfile = [[0.9, 0], [1.1, 0.04], [1.1, 0.6], [1.17, 0.65], [1.17, 0.76], [0.93, 0.76], [0.93, 0.3], [0, 0.3]].map(([x, y]) => new THREE.Vector2(x, y));
  // The basin is a half oval, long against the wall and shallow into the square, so the way past the near station stays open.
  place(new THREE.Mesh(new THREE.LatheGeometry(basinProfile, 28, 0, Math.PI).scale(0.68, 1, 1), stone), LEFT, 0, fountainZ, true, true);
  const water = new THREE.CircleGeometry(0.94, 28, 0, Math.PI);
  water.rotateX(-Math.PI / 2); water.rotateY(-Math.PI / 2); water.scale(0.68, 1, 1);
  place(new THREE.Mesh(water, glazes(0x1c3134)), LEFT, 0.64, fountainZ, false);
  place(new THREE.Mesh(rod([0, 0, 0], [0.17, -0.04, 0], 0.028, 8), copper), LEFT + 0.28, 1.74, fountainZ, false);
  // Carving: a fluted shell in the pediment, a rosette around the spout and a pilaster each side.
  const carving: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i += 1) {
    const angle = (i + 0.5) * Math.PI / 9, flute = new THREE.CylinderGeometry(0.075, 0.02, 0.8, 6);
    flute.translate(0, 0.4, 0); flute.rotateX(angle - Math.PI / 2); flute.scale(0.5, 1, 1); flute.translate(0.21, 2.5, 0);
    carving.push(flute);
  }
  carving.push(new THREE.SphereGeometry(0.16, 12, 8).scale(0.5, 1, 1).translate(0.21, 2.5, 0));
  // The spout comes out of a rosette: a dished roundel with a rolled rim, eight petals and a boss.
  carving.push(new THREE.CylinderGeometry(0.25, 0.28, 0.05, 28).rotateZ(Math.PI / 2).translate(0.215, 1.745, 0), new THREE.TorusGeometry(0.255, 0.03, 6, 28).rotateY(Math.PI / 2).translate(0.236, 1.745, 0), new THREE.SphereGeometry(0.068, 12, 8).scale(0.7, 1, 1).translate(0.25, 1.745, 0));
  for (let i = 0; i < 8; i += 1) carving.push(new THREE.SphereGeometry(0.075, 8, 6).scale(0.34, 1.2, 0.74).translate(0, 0.14, 0).rotateX(i * Math.PI / 4 + Math.PI / 8).translate(0.243, 1.745, 0));
  for (const side of [-1, 1]) carving.push(softBox(0.1, 2.26, 0.24, 0.02, 2).translate(0.24, 1.2, side * 0.98), softBox(0.16, 0.12, 0.34, 0.02, 2).translate(0.25, 2.36, side * 0.98), softBox(0.16, 0.16, 0.34, 0.02, 2).translate(0.25, 0.84, side * 0.98));
  place(new THREE.Mesh(projectUv(merge(carving), 1.6), stone), LEFT, 0, fountainZ, false, true);
  // An enamel plate under the cornice names it.
  place(new THREE.Mesh(notice("pit", 0.7), noticePaint), LEFT + 0.207, 2.22, fountainZ, false).rotation.y = Math.PI / 2;
  // The jet, its spray and the rings it raises are drawn with the rest of the moving water, further down.

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
  roofTrim(0.38, 7.83, 13.35, 21, 8.5, 1.9);
  // Shuttered windows either side of the chart.
  const FB: Face = { x: 0, z: 9.7, yaw: Math.PI };
  addWindow(FB, 7.9, 1.15, tall, { shutter: 0, colour: 0x4d6f58, fine: true });
  // The window by the gate keeps one leaf latched back against the wall. The other has lost its catch: it hangs half
  // open and the gusts push it to and fro, creaking. Its mesh is stood on end with its origin on the hinge line, so
  // the life kit's pendulum (which swings about a local axis) turns it about the jamb.
  addWindow(FB, -7.9, 1.15, tall, { shutter: [Math.PI - 0.07, undefined], colour: 0x4d6f58, fine: true });
  const looseLeaf = new THREE.Mesh(shutterGeometry(tall.w / 2, tall.h).translate(-tall.w / 4, 0, 0).rotateX(Math.PI / 2), shutterMaterial);
  {
    const paint = new THREE.Color(0x4d6f58).multiplyScalar(0.93), tint = looseLeaf.geometry.attributes.color;
    for (let i = 0; i < tint.count; i += 1) tint.setXYZ(i, tint.getX(i) * paint.r, tint.getY(i) * paint.g, tint.getZ(i) * paint.b);
  }
  looseLeaf.position.set(...at(FB, -7.9 + tall.w / 2 + 0.02, 1.15 + tall.h / 2, 0.105));
  looseLeaf.quaternion.setFromEuler(new THREE.Euler(0, FB.yaw + 2.3, 0)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
  looseLeaf.receiveShadow = true;
  looseLeaf.userData.walkThrough = true;
  scene.add(looseLeaf);
  kit.shootable.push(looseLeaf);
  kit.mirrorHidden.push(looseLeaf);
  life.sway(looseLeaf, { amplitude: 0.45, period: 2.4, axis: "z", creak: "shutterCreak", damping: 0.1 });
  // On its sill sits the square's cat. It watches whoever is on the range, glances off at the pigeons, hangs its tail
  // over the edge and flicks it; a shot makes it duck. Its shader turns the head and tail (see CAT_PARS).
  const catPose = new THREE.Vector4(0, 0.1, 0, 0), catMood = { value: 0 }, catEye = new THREE.Vector3(0, 1.62, 7.2);
  const catFur = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.5 }));
  catFur.onBeforeCompile = (shader) => {
    shader.uniforms.catPose = { value: catPose };
    shader.uniforms.catMood = catMood;
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `${CAT_PARS}\nvoid main() {`)
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = catTurn(objectNormal, 0.0);")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed = catTurn(transformed, 1.0);\nif (transformed.y > 0.0) transformed.y *= 1.0 - 0.1 * catMood;");
  };
  catFur.customProgramCacheKey = () => "piazza-cat";
  const cat = new THREE.Mesh(track(catGeometry()), catFur);
  cat.position.set(7.96, 0.98, 9.7 - 0.168);
  cat.rotation.y = Math.PI;
  cat.receiveShadow = true;
  cat.userData.walkThrough = true;
  // Whatever camera draws it tells it where the player's eyes are.
  cat.onBeforeRender = (_renderer, _scene, camera) => { catEye.setFromMatrixPosition(camera.matrixWorld); };
  scene.add(cat);
  kit.shootable.push(cat);
  kit.mirrorHidden.push(cat);
  kit.probeHidden.push(cat);
  addWindow(FB, 7.9, 4.95, small, { shutter: Math.PI - 0.07, colour: 0x4d6f58, lit: true, fine: true });
  addWindow(FB, -7.9, 4.95, small, { shutter: Math.PI - 0.07, colour: 0x4d6f58, fine: true });

  // ---- Right: garden wall and terrace --------------------------------------
  place(new THREE.Mesh(worldBox(0.9, BAND, 30.7, 2.6), gardenBrick), RIGHT + 0.45, BAND / 2, -15.05, true, true);
  place(new THREE.Mesh(softBox(1.14, 0.14, 30.9, 0.04, 2), stone), RIGHT + 0.45, BAND + 0.07, -15.05, true);
  place(new THREE.Mesh(softBox(0.12, 0.8, 30.2, 0.03, 2), stone), RIGHT - 0.02, 0.4, -15.3, false, true);
  place(new THREE.Mesh(worldBox(14.6, 4.3, 30.7, 2.6), gardenBrick), 17.7, 2.15, -15.05, true);
  place(new THREE.Mesh(softBox(14.8, 0.12, 0.5, 0.04, 2), stone), 17.7, 4.36, 0.12, true);
  place(new THREE.Mesh(worldBox(19, 3, 1.3, 2.6), gardenBrick), 34.5, 1.5, -0.35, true);
  place(new THREE.Mesh(softBox(19.2, 0.12, 1.5, 0.04, 2), stone), 34.5, 3.06, -0.35, true);
  // Brick piers with stone caps break the wall into bays between the signs.
  for (const z of [-29.6, -25.9, -19.95, -14.0, -8.9, -1.7]) {
    span(gardenBrick, RIGHT - 0.14, RIGHT + 0.1, 0.8, BAND - 0.12, z - 0.28, z + 0.28, false, true, 2.6);
    span(stone, RIGHT - 0.17, RIGHT + 0.1, 0, 0.8, z - 0.32, z + 0.32, false, true);
    span(stone, RIGHT - 0.18, RIGHT + 0.1, BAND - 0.12, BAND + 0.02, z - 0.33, z + 0.33);
  }
  // A plank garden door in a stone arch.
  const gardenDoor = archDoorGeometry(1.1, 1.75), gardenDoorZ = -7.2;
  for (const [geometry, material] of [[gardenDoor.door, timberPlanks], [gardenDoor.surround, stone], [gardenDoor.iron, iron]] as Array<[THREE.BufferGeometry, THREE.Material]>)
    place(new THREE.Mesh(geometry, material), RIGHT - 0.005, 0, gardenDoorZ, false, material !== iron).rotation.y = -Math.PI / 2;
  span(stone, RIGHT - 0.3, RIGHT, 0, 0.1, gardenDoorZ - 0.72, gardenDoorZ + 0.72, false, true);
  // The gardener's card on one leaf, pinned a little askew, where the player can walk right up to it.
  place(new THREE.Mesh(notice("card", 0.3), noticePaint), RIGHT - 0.07, 1.33, gardenDoorZ + 0.2, false).rotation.set(0, -Math.PI / 2, 0.035);
  // Enamel street plate and a row of pasted bills.
  const plateMap = track(canvasTexture(1024, 512, (context) => {
    context.fillStyle = "#cfc8b4"; context.fillRect(0, 0, 1024, 512);
    context.fillStyle = "#1d3f66"; context.fillRect(26, 26, 972, 460);
    context.strokeStyle = "#cfc8b4"; context.lineWidth = 6; context.strokeRect(50, 50, 924, 412);
    context.fillStyle = "#cfc8b4"; context.textAlign = "center"; context.textBaseline = "middle";
    context.font = "600 54px Georgia, 'Times New Roman', serif"; context.fillText("P I A Z Z A", 512, 116);
    context.font = "600 204px Georgia, 'Times New Roman', serif"; context.fillText("GG WP", 512, 258, 840);
    context.fillRect(322, 366, 380, 3);
    context.font = "italic 46px Georgia, 'Times New Roman', serif"; context.fillText("già Piazza GL HF", 512, 414);
    for (const [x, y] of [[82, 82], [942, 82], [82, 430], [942, 430]]) { context.fillStyle = "#8a8d8c"; context.beginPath(); context.arc(x, y, 11, 0, Math.PI * 2); context.fill(); context.fillStyle = "#3a3d3c"; context.fillRect(x - 8, y - 1.5, 16, 3); }
    const chip = rng(61);
    for (let i = 0; i < 26; i += 1) { context.fillStyle = `rgba(${40 + chip() * 40 | 0},${24 + chip() * 20 | 0},16,${0.5 + chip() * 0.4})`; context.beginPath(); context.ellipse(chip() < 0.5 ? 30 + chip() * 40 : 954 + chip() * 40, chip() * 512, 2 + chip() * 9, 2 + chip() * 6, chip() * 3, 0, Math.PI * 2); context.fill(); }
    for (let i = 0; i < 5; i += 1) { const x = 80 + chip() * 860; const streak = context.createLinearGradient(0, 470, 0, 512); streak.addColorStop(0, "rgba(120,60,20,.5)"); streak.addColorStop(1, "rgba(120,60,20,0)"); context.fillStyle = streak; context.fillRect(x, 470, 5 + chip() * 8, 42); }
  }));
  plateMap.anisotropy = anisotropy;
  const plate = offMirror(new THREE.MeshStandardMaterial({ map: plateMap, roughness: 0.42, metalness: 0, envMapIntensity: 0.4 }));
  // One on the gate pier where the side square opens, one on the palazzo between the arcade and the fountain: both in
  // plain sight of the lanes (the far end of either wall is hidden behind the control wall).
  place(new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.42, 0.016), plate), RIGHT - 0.03, 3.2, 0.3, false).rotation.y = -Math.PI / 2;
  place(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.016), plate), LEFT + 0.012, 3.64, -1.5, false).rotation.y = Math.PI / 2;
  const billsMap = track(canvasTexture(2048, 1024, (context) => {
    const paper = rng(73);
    const bill = (x: number, w: number, ground: string, ink: string, accent: string, lines: Array<[string, string, number, string?]>, art?: (w: number) => void) => {
      context.save();
      context.translate(x + w / 2, 512); context.rotate((paper() - 0.5) * 0.03); context.translate(-w / 2, -512);
      context.fillStyle = ground; context.fillRect(8, 14 + paper() * 14, w - 16, 980 - paper() * 20);
      context.strokeStyle = ink; context.lineWidth = 6; context.strokeRect(40, 60, w - 80, 890);
      context.fillStyle = accent; context.fillRect(40, 60, w - 80, 120);
      art?.(w);
      context.textAlign = "center"; context.textBaseline = "middle";
      for (const [text, font, y, colour] of lines) { context.font = font; context.fillStyle = colour ?? ink; context.fillText(text, w / 2, y, w - 120); }
      context.restore();
    };
    context.fillStyle = "#b9ab90"; context.fillRect(0, 0, 2048, 1024);
    // A band whose name is a blinding bang, with the decoy as the opening act.
    bill(0, 690, "#efe3c4", "#1c1a17", "#b3302a", [
      ["UNA SERATA ACCECANTE", "bold 44px 'Arial Narrow', Arial, sans-serif", 120, "#f6ecd2"],
      ["I FLASH", "bold 130px Georgia, serif", 262], ["BANG", "bold 170px Georgia, serif", 404],
      ["in concerto", "italic 60px Georgia, serif", 524],
      ["apre DJ DECOY", "italic 52px Georgia, serif", 608], ["(fa solo rumore)", "italic 40px Georgia, serif", 666],
      ["SABATO · ORE 21", "bold 76px 'Arial Narrow', Arial, sans-serif", 772, "#b3302a"],
      ["Si prega di non guardare il palco.", "30px Georgia, serif", 880],
    ], (w) => {
      context.fillStyle = "#edbb45";
      context.beginPath();
      for (let k = 0; k < 28; k += 1) { const reach = k % 2 ? 160 : 262 - (k % 4) * 16, angle = k / 28 * Math.PI * 2; context.lineTo(w / 2 + Math.cos(angle) * reach * 1.08, 404 + Math.sin(angle) * reach * 0.5); }
      context.closePath(); context.fill();
    });
    // The trattoria on the side square: everyone skips the first and goes second mid.
    bill(680, 690, "#f2d9a0", "#3a2412", "#2f6b62", [
      ["DAL 1999", "bold 46px 'Arial Narrow', Arial, sans-serif", 120, "#f6ecd2"],
      ["TRATTORIA", "bold 84px Georgia, serif", 250], ["SECONDO", "bold 104px Georgia, serif", 352, "#7a1f2a"], ["MID", "bold 170px Georgia, serif", 486, "#7a1f2a"],
      ["il primo lo saltano tutti", "italic 46px Georgia, serif", 602],
      ["APERTI FINO AL 12° ROUND", "bold 50px 'Arial Narrow', Arial, sans-serif", 690], ["POI SUPPLEMENTARI", "bold 50px 'Arial Narrow', Arial, sans-serif", 750],
      ["Coperto $1000 (kevlar e casco)", "36px Georgia, serif", 880],
    ]);
    // The market notice: hens are welcome, and asking for a rifle is not a bid.
    bill(1360, 688, "#dfe6e2", "#14313a", "#d98a2b", [
      ["AVVISO", "bold 52px 'Arial Narrow', Arial, sans-serif", 120, "#14313a"],
      ["MERCATO", "bold 132px 'Arial Narrow', Arial, sans-serif", 280], ["DEL GIOVEDÌ", "bold 104px 'Arial Narrow', Arial, sans-serif", 400],
      ["Polli benvenuti.", "bold 52px Georgia, serif", 522],
      ["Vietato inseguirli col coltello.", "40px Georgia, serif", 592],
      ["«Drop AWP pls» non è un'offerta.", "italic 36px Georgia, serif", 682],
      ["Tetto massimo di spesa: $16000.", "36px Georgia, serif", 742],
      ["Comune di Castel Wallbang · Ufficio Economia", "27px Georgia, serif", 880],
    ], (w) => { henMark(context, 112, 122, 88, "#14313a", "#d98a2b"); henMark(context, w - 112, 122, 88, "#14313a", "#d98a2b", -1); });
    for (let i = 0; i < 9000; i += 1) { const tone = paper() < 0.5 ? 0 : 255; context.fillStyle = `rgba(${tone},${tone},${tone},${0.02 + paper() * 0.05})`; context.fillRect(paper() * 2048, paper() * 1024, 1 + paper() * 5, 1 + paper() * 26); }
    context.strokeStyle = "rgba(60,40,20,.25)"; context.lineWidth = 2;
    for (let i = 0; i < 14; i += 1) { context.beginPath(); const x = paper() * 2048, y = paper() * 1024; context.moveTo(x, y); context.lineTo(x + (paper() - 0.5) * 300, y + (paper() - 0.5) * 300); context.stroke(); }
  }));
  billsMap.anisotropy = anisotropy;
  place(new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.15), offMirror(new THREE.MeshStandardMaterial({ map: billsMap, roughness: 0.85, metalness: 0, normalMap: brick.normalMap, normalScale: new THREE.Vector2(0.25, 0.25) }))), RIGHT - 0.006, 1.85, -4.1, false).rotation.y = -Math.PI / 2;
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
  roofTrim(hallX, 11.84, -35.5, hallW + 1.4, 11.2, 2.7);
  // Plank doors in stone arches at the back of the hall's loggia, and benches between them.
  const hallDoor = archDoorGeometry(1.9, 2.3);
  for (const dx of [-8.2, -4.1, 0, 4.1, 8.2]) for (const [geometry, material] of [[hallDoor.door, timberPlanks], [hallDoor.surround, stone], [hallDoor.iron, iron]] as Array<[THREE.BufferGeometry, THREE.Material]>)
    place(new THREE.Mesh(geometry, material), hallX + dx, 0, -33.29, false);
  for (const dx of [-6.15, -2.05, 2.05, 6.15]) {
    span(stone, hallX + dx - 0.7, hallX + dx + 0.7, 0.4, 0.5, -33.25, -32.85);
    for (const side of [-1, 1]) span(stone, hallX + dx + side * 0.55 - 0.08, hallX + dx + side * 0.55 + 0.08, 0, 0.4, -33.25, -32.9);
  }
  span(stone, hallX - hallW / 2, hallX + hallW / 2, 0, 0.06, -33.3, -30.4, false, false, 1.2);
  // Dormers on the hall roof.
  for (const dx of [-6, 0, 6]) {
    span(hallPlaster, hallX + dx - 0.6, hallX + dx + 0.6, 12.5, 13.75, -33.6, -31.9, true, false, 3.2);
    place(new THREE.Mesh(hipRoof(1.5, 2.1, 0.5, 0.85), roofs[0]), hallX + dx, 13.75, -32.8, true);
    span(glass, hallX + dx - 0.36, hallX + dx + 0.36, 12.95, 13.6, -31.9, -31.88);
    span(sash, hallX + dx - 0.02, hallX + dx + 0.02, 12.95, 13.6, -31.88, -31.86);
  }
  // A church dome on the skyline behind the hall.
  const domeX = -7.5, domeZ = -52.5, domeY = 23.6;
  place(new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(3.7, 3.7, 8.6, 24), 7, 2.6), plasterMaterial(0xeedfbd)), domeX, 19.3, domeZ, true);
  place(new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(4.05, 3.8, 0.34, 24), 8, 0.2), stone), domeX, domeY - 0.1, domeZ, true);
  place(new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(3.85, 3.85, 0.24, 24), 8, 0.2), stone), domeX, 20.1, domeZ, false);
  place(new THREE.Mesh(new THREE.SphereGeometry(3.78, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.12, 1), verdigris), domeX, domeY, domeZ, true);
  const domeRibs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i += 1) domeRibs.push(new THREE.TorusGeometry(3.8, 0.1, 5, 12, Math.PI / 2).scale(1, 1.12, 1).rotateY(i * Math.PI / 4));
  place(new THREE.Mesh(merge(domeRibs), verdigris), domeX, domeY, domeZ, false);
  instances(worldBox(0.55, 3.2, 0.3, 2), stone, Array.from({ length: 8 }, (_, i) => ({ position: [domeX + Math.sin(i * Math.PI / 4) * 3.72, 21.8, domeZ + Math.cos(i * Math.PI / 4) * 3.72] as V3, rotation: [0, i * Math.PI / 4, 0] as V3 })), false, false);
  instances(new THREE.BoxGeometry(0.95, 2.0, 0.1), glass, Array.from({ length: 8 }, (_, i) => ({ position: [domeX + Math.sin((i + 0.5) * Math.PI / 4) * 3.66, 21.7, domeZ + Math.cos((i + 0.5) * Math.PI / 4) * 3.66] as V3, rotation: [0, (i + 0.5) * Math.PI / 4, 0] as V3 })), false, false);
  place(new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(0.8, 0.9, 1.8, 10), 3, 1), stone), domeX, domeY + 4.9, domeZ, true);
  place(new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), verdigris), domeX, domeY + 5.8, domeZ, true);
  place(new THREE.Mesh(merge([new THREE.SphereGeometry(0.22, 12, 8).translate(0, 0.25, 0), rod([0, 0.3, 0], [0, 1.5, 0], 0.03)]), metals.brushed), domeX, domeY + 6.7, domeZ, false);
  for (let x = hallX - hallW / 2; x < hallX + hallW / 2; x += 0.62) rafters.push({ position: [x, 11.66, -30.3], rotation: [0, Math.PI / 2, 0] });
  for (let column = 0; column < 7; column += 1) {
    const x = hallX + (column - 3) * 3.0, centre = column >= 2 && column <= 4;
    addWindow(FH, x, 6.3, tall, { shutter: centre ? undefined : Math.PI - 0.07, colour: 0x5a4632, balcony: centre, lit: column === 3 || column === 5, fine: true });
    addWindow(FH, x, 9.45, small, { shutter: column % 3 === 1 ? 0 : undefined, colour: 0x5a4632, lit: column === 1, fine: true });
  }
  // Stone pilasters between the bays, and the palio's mint banners either side of the middle balcony, high enough to
  // show over the control wall from anywhere on the range.
  instances(worldBox(0.5, 5.6, 0.16, 2), stone, Array.from({ length: 8 }, (_, i) => ({ position: [hallX + (i - 3.5) * 3.0, 8.35, -30.54] as V3 })), false);
  const bannerMap = track(canvasTexture(512, 1024, (context) => {
    context.scale(4, 4);
    context.fillStyle = "#8ef5e3"; context.fillRect(0, 0, 128, 256);
    context.fillStyle = "#e89a42"; context.fillRect(0, 0, 128, 20); context.fillRect(0, 222, 128, 34);
    // The town runs its hens, not its horses: the palio's own mark is a hen.
    henMark(context, 65, 140, 84, "#0d2a2b", "#8ef5e3");
    context.strokeStyle = "#0d2a2b"; context.lineWidth = 0.9; context.strokeRect(9, 28, 110, 186);
    context.textAlign = "center"; context.textBaseline = "middle"; context.fillStyle = "#0d2a2b";
    context.font = "bold 29px Georgia, 'Times New Roman', serif"; context.fillText("PALIO", 64, 51, 98);
    context.font = "bold 16px Georgia, 'Times New Roman', serif"; context.fillText("DEL POLLO", 64, 76, 98);
    context.font = "italic 9px Georgia, 'Times New Roman', serif"; context.fillText("si corre, non si spara", 64, 201, 98);
    // Weave, and a little weather.
    const thread = rng(47);
    for (let y = 0; y < 256; y += 0.5) { context.fillStyle = `rgba(${thread() < 0.5 ? "0,40,40" : "255,255,255"},${0.03 + thread() * 0.05})`; context.fillRect(0, y, 128, 0.25); }
    for (let x = 0; x < 128; x += 0.5) { context.fillStyle = `rgba(${thread() < 0.5 ? "0,40,40" : "255,255,255"},${0.02 + thread() * 0.04})`; context.fillRect(x, 0, 0.25, 256); }
    const fade = context.createLinearGradient(0, 0, 0, 256);
    fade.addColorStop(0, "rgba(40,30,20,.16)"); fade.addColorStop(0.3, "rgba(40,30,20,0)"); fade.addColorStop(1, "rgba(60,45,25,.14)");
    context.fillStyle = fade; context.fillRect(0, 0, 128, 256);
  }));
  bannerMap.anisotropy = anisotropy;
  // Cut finely and hung a hand clear of the pilasters, so they can swing from their rods without touching stone.
  const banner = new THREE.PlaneGeometry(1.5, 2.9, 14, 26);
  for (let i = 0; i < banner.attributes.position.count; i += 1) banner.attributes.position.setZ(i, Math.sin(banner.attributes.position.getX(i) * 4 + banner.attributes.position.getY(i) * 1.3) * 0.02);
  banner.computeVertexNormals();
  const bannerCloth = offMirror(new THREE.MeshStandardMaterial({ map: bannerMap, emissive: 0xffffff, emissiveMap: bannerMap, emissiveIntensity: 0.12, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
  for (const side of [-1, 1]) {
    place(new THREE.Mesh(banner, bannerCloth), hallX + side * 1.5, 8.9, -30.2, true);
    place(new THREE.Mesh(merge([rod([-0.82, 0, 0], [0.82, 0, 0], 0.022), rod([-0.7, 0, 0], [-0.7, 0, -0.27], 0.016), rod([0.7, 0, 0], [0.7, 0, -0.27], 0.016)]), iron), hallX + side * 1.5, 10.36, -30.2, false);
  }
  life.cloth(bannerCloth, { amplitude: 0.07, pin: "top", lean: 0.15 });
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
  roofTrim(towerX, shaft + 5.0, towerZ, 6.3, 6.3, 3.6);
  place(new THREE.Mesh(merge([new THREE.SphereGeometry(0.26, 14, 10).translate(0, 0.2, 0), rod([0, 0.3, 0], [0, 1.5, 0], 0.03)]), metals.brushed), towerX, shaft + 8.55, towerZ, true);
  const bellProfile = [[0, 1.0], [0.2, 0.98], [0.34, 0.8], [0.4, 0.4], [0.52, 0.12], [0.62, 0], [0.56, 0], [0.46, 0.14]].map(([x, y]) => new THREE.Vector2(x, y));
  // The bell hangs in the arch that looks down the square and swings out through it, as they do in these towers:
  // bronze on an iron headstock, one piece turning on its gudgeons, so it shows from anywhere on the range. It casts
  // no shadow (the sun map is frozen and it moves); the peal that swings it is with the life of the square, below.
  const bronze = new THREE.Color(0x6b5026), gunmetal = new THREE.Color(0x1b1c1e);
  const bell = new THREE.Mesh(track(merge([
    tinted(new THREE.LatheGeometry(bellProfile, 24).translate(0, -1.13, 0).scale(1.25, 1.25, 1.25), bronze.r, bronze.g, bronze.b),
    // Clapper, headstock, the straps that bolt the crown to it, and the axle through the jambs.
    tinted(merge([rod([0, -0.35, 0], [0, -1.42, 0], 0.035, 6), new THREE.SphereGeometry(0.11, 10, 8).translate(0, -1.42, 0),
      box(2.0, 0.3, 0.3, 0, 0.02, 0), box(0.07, 0.34, 0.34, -0.3, -0.06, 0), box(0.07, 0.34, 0.34, 0.3, -0.06, 0),
      rod([-1.2, 0, 0], [1.2, 0, 0], 0.045, 8)]), gunmetal.r, gunmetal.g, gunmetal.b),
  ])), brassBase);
  bell.position.set(towerX, shaft + 2.75, towerZ + 2.25);
  bell.receiveShadow = true;
  scene.add(bell);
  kit.shootable.push(bell);
  kit.mirrorHidden.push(bell);
  // The town's flag on the hall roof: teal and ochre halved, the hen on a shield where they meet. It flies down the
  // wind from a pole on the ridge and hangs in the lulls; the hoist is the edge at u = 0.
  const flagMap = track(canvasTexture(768, 480, (context) => {
    context.scale(3, 3);
    context.fillStyle = "#1d6a63"; context.fillRect(0, 0, 128, 160);
    context.fillStyle = "#b8842a"; context.fillRect(128, 0, 128, 160);
    context.fillStyle = "#bdb49a"; context.strokeStyle = "#13211f"; context.lineWidth = 2.5;
    context.beginPath(); context.moveTo(92, 34); context.lineTo(164, 34); context.lineTo(164, 88); context.quadraticCurveTo(162, 120, 128, 136); context.quadraticCurveTo(94, 120, 92, 88); context.closePath(); context.fill(); context.stroke();
    henMark(context, 128, 82, 58, "#13211f", "#bdb49a");
    context.fillStyle = "#857d66"; context.fillRect(0, 0, 5, 160);
    const thread = rng(53);
    for (let y = 0; y < 160; y += 0.5) { context.fillStyle = `rgba(${thread() < 0.5 ? "0,30,30" : "255,240,210"},${0.03 + thread() * 0.05})`; context.fillRect(0, y, 256, 0.25); }
    const fade = context.createLinearGradient(0, 0, 256, 0);
    fade.addColorStop(0, "rgba(40,30,20,0)"); fade.addColorStop(1, "rgba(60,45,25,.2)");
    context.fillStyle = fade; context.fillRect(0, 0, 256, 160);
  }));
  flagMap.anisotropy = anisotropy;
  const flagCloth = track(new THREE.MeshStandardMaterial({ map: flagMap, emissive: 0xffffff, emissiveMap: flagMap, emissiveIntensity: 0.1, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
  const flag = new THREE.Mesh(track(new THREE.PlaneGeometry(3.8, 2.4, 34, 18).translate(1.9, 0, 0)), flagCloth);
  flag.position.set(hallX, 20.25, -35.5);
  flag.rotation.y = WIND_HEADING + Math.PI / 2;
  scene.add(flag);
  kit.mirrorHidden.push(flag);
  life.cloth(flagCloth, { amplitude: 0.17, pin: "left" }).snap([hallX, 20.2, -35.5]);
  place(new THREE.Mesh(merge([rod([0, 0, 0], [0, 7.15, 0], 0.055, 8), new THREE.SphereGeometry(0.12, 10, 8).translate(0, 7.24, 0), new THREE.CylinderGeometry(0.1, 0.13, 0.3, 8).translate(0, 0.25, 0)]), iron), hallX, 14.45, -35.5, false);
  const dialMap = track(clockTexture());
  dialMap.anisotropy = anisotropy;
  const dialMaterial = offMirror(new THREE.MeshStandardMaterial({ map: dialMap, roughness: 0.5, metalness: 0, envMapIntensity: 0.6 }));
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
  // Two corner houses frame the street that leaves the side square.
  building(44.5, 57, -6, 8.8, 8.4, townPlaster[0]);
  fenestrate({ x: 44.5, z: 1.4, yaw: -Math.PI / 2 }, -6.6, 6.6, [{ y: 1.0, type: tall }, { y: 4.6, type: small }], 0x7a5236, { lit: 0.3 });
  building(44.5, 57, 14.9, 26, 9.6, townPlaster[2], 2.4);
  fenestrate({ x: 44.5, z: 20.45, yaw: -Math.PI / 2 }, -5, 5, [{ y: 1.0, type: tall }, { y: 4.4, type: tall }], 0x2f5a66, { lit: 0.3 });
  building(44.5, 58, 26, 42, 6.6, townPlaster[3], 1.8);
  fenestrate({ x: 44.5, z: 34, yaw: -Math.PI / 2 }, -7.5, 7.5, [{ y: 1.0, type: tall }, { y: 3.9, type: small }], 0x4d6f58, { lit: 0.3 });

  // ---- The street that climbs out of the side square toward the low sun ------
  // Real houses on a real slope, so it recedes and shifts as the player moves. All of it is drawn
  // once, in the main view only: it is too far to reach the shadow map or a puddle.
  const farOf = <T extends THREE.Material>(material: T) => { material.userData.far = true; return material; };
  const farPlaster = family(farOf(new THREE.MeshStandardMaterial({ ...plaster, roughness: 1, metalness: 0, envMapIntensity: 0.6 })));
  const farPaint = family(farOf(new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, envMapIntensity: 0.5, side: THREE.DoubleSide })));
  const farStone = farOf(stone.clone());
  const farGlow = farOf(new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.72, 0.4).multiplyScalar(1.5), toneMapped: false }));
  // The street floor lies in the shade of its right-hand row: a matt material with the sunless tone built in,
  // because a glossy one at this grazing angle would mirror the bright sky and read as pale stone.
  const farCobble = farOf(new THREE.MeshLambertMaterial({ map: cobble.map, normalMap: cobble.normalMap, normalScale: new THREE.Vector2(1.5, 1.5), color: new THREE.Color(0.3, 0.27, 0.25) }));
  // The street's own frame: x runs uphill along its centre line, z across it (left row negative).
  const BEND = 0.21, street = new THREE.Group();
  street.position.set(57, 0, 11.85);
  street.rotation.y = -BEND;
  const rise = (x: number) => Math.min(Math.max(x, 0), 62) * 0.1;
  const streetPiece = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    street.add(mesh);
    pending.push({ mesh, shadow: false, hit: false });
    return mesh;
  };
  /** Sets a piece on a wall face; with a group the face is given in that group's frame. */
  const wallPiece = (group: THREE.Group | null, geometry: THREE.BufferGeometry, material: THREE.Material, face: Face, s: number, y: number, out: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...at(face, s, y, out));
    mesh.rotation.y = face.yaw;
    group?.add(mesh);
    pending.push({ mesh, shadow: false, hit: false });
    return mesh;
  };
  // Windows for fronts no one can walk up to: frame, glass, sash and flat leaves, a hundred triangles each.
  const farKind = (w: number, h: number) => ({
    w, h,
    frame: merge([box(w + 0.34, 0.1, 0.14, 0, -h / 2 - 0.05, 0.07), box(0.14, h, 0.09, -(w / 2 + 0.07), 0, 0.045), box(0.14, h, 0.09, w / 2 + 0.07, 0, 0.045), box(w + 0.28, 0.16, 0.1, 0, h / 2 + 0.08, 0.05), box(w + 0.46, 0.07, 0.16, 0, h / 2 + 0.195, 0.08)]),
    sash: merge([box(0.05, h, 0.036, 0, 0, 0), box(w, 0.05, 0.028, 0, h * 0.16, 0), box(w, 0.06, 0.028, 0, -h / 2 + 0.03, 0), box(w, 0.05, 0.028, 0, h / 2 - 0.025, 0)]),
    pane: new THREE.PlaneGeometry(w, h),
    leaf: new THREE.BoxGeometry(w / 2, h - 0.02, 0.035),
  });
  type FarKind = ReturnType<typeof farKind>;
  const farTall = farKind(1.1, 2.1), farSmall = farKind(1.0, 1.25), farCream = farPaint(0xe4dccb);
  const farWindow = (group: THREE.Group | null, face: Face, s: number, y0: number, kind: FarKind, colour: number) => {
    const y = y0 + kind.h / 2, roll = random(), closed = roll < 0.24, bare = roll > 0.82, lit = !closed && random() < 0.14;
    wallPiece(group, kind.frame, farStone, face, s, y, 0);
    if (!closed) { wallPiece(group, kind.pane, lit ? farGlow : glass, face, s, y, 0.04); wallPiece(group, kind.sash, farCream, face, s, y, 0.062); }
    if (!bare) for (const side of [-1, 1]) wallPiece(group, kind.leaf, farPaint(colour), face, s + side * (closed ? kind.w / 4 : kind.w * 0.75 + 0.02), y, 0.13);
  };
  const farDoorFrame = merge([box(0.2, 2.5, 0.12, -0.75, 1.25, 0.06), box(0.2, 2.5, 0.12, 0.75, 1.25, 0.06), box(1.9, 0.26, 0.14, 0, 2.63, 0.07), box(2.1, 0.08, 0.2, 0, 2.8, 0.1), box(1.9, 0.16, 0.34, 0, 0.08, 0.17)]);
  const farDoorLeaf = new THREE.BoxGeometry(1.3, 2.34, 0.05);
  const farDoor = (group: THREE.Group | null, face: Face, s: number, ground: number, colour: number) => {
    wallPiece(group, farDoorFrame, farStone, face, s, ground, 0);
    wallPiece(group, farDoorLeaf, farPaint(colour), face, s, ground + 1.33, 0.045);
  };
  // The corner houses' street sides.
  for (const column of [-1, 0, 1]) {
    farWindow(null, { x: 50.75, z: 8.8, yaw: 0 }, column * 3.6, 1.3, farTall, 0x7a5236);
    farWindow(null, { x: 50.75, z: 8.8, yaw: 0 }, column * 3.6, 4.9, farSmall, 0x7a5236);
    farWindow(null, { x: 50.75, z: 14.9, yaw: Math.PI }, column * 3.6, 4.6, farTall, 0x2f5a66);
    if (column) farWindow(null, { x: 50.75, z: 14.9, yaw: Math.PI }, column * 3.6, 1.3, farTall, 0x2f5a66);
  }
  farDoor(null, { x: 50.75, z: 14.9, yaw: Math.PI }, 0, 0, 0x26453c);
  /** One house of a row: `side` −1 is the left row (its front catches the sun), +1 the right (in shade). */
  const rowHouse = (side: number, x0: number, x1: number, setback: number, h: number, wall: number, shutters: number, roofTint: number, roofRise: number, door: number) => {
    const w = x1 - x0, cx = (x0 + x1) / 2, front = side * (3 + setback), depth = 11, cz = front + side * depth / 2, top = rise(x0) + h, sill = rise(x1);
    streetPiece(worldBox(w, top + 1, depth, 3.2), farPlaster(wall), cx, (top - 1) / 2, cz);
    streetPiece(worldBox(w + 0.36, 0.3, depth + 0.36, 2), farStone, cx, top - 0.24, cz);
    streetPiece(worldBox(w + 0.18, 0.26, depth + 0.18, 2), farStone, cx, top - 0.52, cz);
    streetPiece(new THREE.BoxGeometry(w + 1.1, 0.12, depth + 1.1), farPaint(0x4a3524), cx, top - 0.03, cz);
    streetPiece(hipRoof(w + 1.2, depth + 1.2, roofRise), roofTiles(roofTint), cx, top + 0.03, cz);
    const shift = (random() - 0.5) * w * 0.5;
    streetPiece(worldBox(0.75, roofRise + 1.5, 1, 3.2), farPlaster(0xc9a57c), cx + shift, top + roofRise * 0.5 + 0.5, cz);
    streetPiece(worldBox(0.95, 0.1, 1.2, 2), farStone, cx + shift, top + roofRise + 1.3, cz);
    // A levelled stone base takes up the slope.
    streetPiece(worldBox(w, sill + 1.7, 0.1, 2), farStone, cx, (sill - 0.3) / 2, front - side * 0.05);
    const face: Face = { x: cx, z: front, yaw: side < 0 ? 0 : Math.PI }, columns = Math.max(2, Math.round(w / 3.3));
    const third = top - 6.35 - sill > 6.2, lowest = top - (third ? 9.75 : 6.35);
    for (let column = 0; column < columns; column += 1) {
      const s = (column + 0.5 - columns / 2) * w / columns;
      farWindow(street, face, s, top - 2.75, farSmall, shutters);
      farWindow(street, face, s, top - 6.35, farTall, shutters);
      if (third) farWindow(street, face, s, top - 9.75, farTall, shutters);
      if (column === door % columns) farDoor(street, face, s, rise(cx + (side < 0 ? s : -s)) - 0.06, door % 2 ? 0x26453c : 0x4a2f20);
      else if (lowest - sill > 3.5) farWindow(street, face, s, sill + 1.55, farSmall, shutters);
    }
  };
  ([
    [-1, -1, 11, 0, 10.4, 0xe0a85a, 0x4d6f58, 0xffffff, 2.2, 1], [-1, 11, 23, 0.45, 12.3, 0xd98f6c, 0x2f5a66, 0xe2cdbb, 2.5, 0], [-1, 23, 34.8, 0.1, 9.9, 0xecd9b0, 0x7a5236, 0xf3d9c4, 2.1, 2],
    [-1, 34.8, 46, 0.5, 12.6, 0xdc9f86, 0x3c5a50, 0xffffff, 2.6, 1], [-1, 46, 56, 0.15, 10.2, 0xe4b878, 0x4d6f58, 0xe2cdbb, 2.2, 0], [-1, 56, 65, 0.4, 11.8, 0xeedfbd, 0x7a5236, 0xf3d9c4, 2.4, 1],
    [1, -0.6, 9.5, 0, 11.4, 0xd8a98e, 0x3c5a50, 0xe2cdbb, 2.4, 0], [1, 9.5, 21.5, 0.4, 9.6, 0xeedfbd, 0x7a5236, 0xffffff, 2.1, 1], [1, 21.5, 34.8, 0.1, 12.9, 0xd69a72, 0x2f5a66, 0xf3d9c4, 2.6, 2],
    [1, 34.8, 45.5, 0.45, 10.4, 0xe4b878, 0x4d6f58, 0xffffff, 2.2, 0], [1, 45.5, 57, 0.05, 12.2, 0xe2c6a2, 0x7a5236, 0xe2cdbb, 2.5, 1], [1, 57, 65, 0.4, 10, 0xd8a98e, 0x2f5a66, 0xf3d9c4, 2.2, 0],
  ] as Array<[number, number, number, number, number, number, number, number, number, number]>).forEach((house) => rowHouse(...house));
  // Paving: the slope, then a level forecourt before the house that closes the view.
  const paving = (x0: number, x1: number, half: number) => {
    const sheet = new THREE.PlaneGeometry(x1 - x0, half * 2, Math.max(1, Math.round((x1 - x0) / 8)), 1);
    sheet.rotateX(-Math.PI / 2);
    sheet.translate((x0 + x1) / 2, 0, 0);
    const position = sheet.attributes.position, uv = sheet.attributes.uv;
    for (let i = 0; i < position.count; i += 1) { position.setY(i, rise(position.getX(i))); uv.setXY(i, position.getX(i) / 150, position.getZ(i) / 130); }
    sheet.computeVertexNormals();
    return sheet;
  };
  streetPiece(paving(0, 62, 3.9), farCobble, 0, 0, 0);
  streetPiece(paving(62, 71.4, 10.6), farCobble, 0, 0, 0);
  // A room bridges the street on an arch, two thirds of the way up.
  const bridgeX = 34.8, bridgeY = rise(bridgeX) - 0.4, bridge = arcadeWall(7.9, 9.2, 1.1, [{ x: 0, width: 4.7, spring: 3.7 }], 3.2);
  bridge.rotateY(Math.PI / 2);
  streetPiece(bridge, farPlaster(0xd9b08a), bridgeX, bridgeY, 0);
  streetPiece(worldBox(1.3, 0.2, 7.9, 2), farStone, bridgeX, bridgeY + 9.3, 0);
  streetPiece(hipRoof(1.9, 8.1, 0.55), roofTiles(0xe2cdbb), bridgeX, bridgeY + 9.42, 0);
  for (const turn of [-1, 1]) farWindow(street, { x: bridgeX, z: 0, yaw: turn * Math.PI / 2 }, 0, bridgeY + 7.1, farSmall, 0x4d6f58);
  // The house at the top of the street: a tall front with an arched portal, seen over every roof below it.
  const headX = 71.2, headY = rise(headX), headTop = headY + 14.2, FT: Face = { x: headX, z: 0, yaw: -Math.PI / 2 };
  streetPiece(worldBox(12, headTop + 1, 20.4, 3.2), farPlaster(0xe8cfa0), headX + 6, (headTop - 1) / 2, 0);
  streetPiece(worldBox(12.36, 0.3, 20.76, 2), farStone, headX + 6, headTop - 0.24, 0);
  streetPiece(worldBox(12.18, 0.26, 20.58, 2), farStone, headX + 6, headTop - 0.52, 0);
  streetPiece(new THREE.BoxGeometry(13.1, 0.12, 21.5), farPaint(0x4a3524), headX + 6, headTop - 0.03, 0);
  streetPiece(hipRoof(13.2, 21.6, 2.9), roofTiles(0xffffff), headX + 6, headTop + 0.03, 0);
  for (const sideZ of [-1, 1]) streetPiece(worldBox(0.12, 5.6, 8.6, 2), farStone, headX - 0.06, headY + 1.8, sideZ * 5.9);
  streetPiece(worldBox(0.2, 0.3, 20.5, 2), farStone, headX - 0.1, headY + 4.75, 0);
  const portal = archDoorGeometry(2.2, 2.9);
  for (const [geometry, material] of [[portal.door, timberPlanks], [portal.surround, farStone], [portal.iron, farPaint(0x17181a)]] as Array<[THREE.BufferGeometry, THREE.Material]>)
    wallPiece(street, geometry, material, FT, 0, headY, 0.03);
  for (const column of [-2, -1, 0, 1, 2]) {
    farWindow(street, FT, column * 3.7, headY + 6.1, farTall, 0x3c5a50);
    farWindow(street, FT, column * 3.7, headY + 10.6, farSmall, 0x3c5a50);
  }
  streetPiece(worldBox(0.9, 0.16, 2.7, 2), farStone, headX - 0.45, headY + 5.9, 0);
  streetPiece(worldBox(0.1, 0.86, 2.7, 2), farStone, headX - 0.85, headY + 6.41, 0);
  if (high) {
    // Washing strung between the rows and lanterns on brackets: small bright things in the shade.
    const cloths = [0xf1ece0, 0x9fb9cf, 0xc9544a, 0xe9d9a8, 0xf1ece0, 0x7fa3bd];
    for (const [x, lift] of [[15.5, 6.6], [27, 7.4], [43.5, 6.9]]) {
      const y = rise(x) + lift;
      streetPiece(merge([rod([0, 0, -3.5], [0, -0.22, 0], 0.012, 4), rod([0, -0.22, 0], [0, 0, 3.5], 0.012, 4)]), farPaint(0x2a2622), x, y, 0);
      for (let k = 0; k < 6; k += 1) {
        const z = -2.6 + k * 1.02 + (random() - 0.5) * 0.3, wide = random() < 0.35, drop = 0.55 + random() * 0.5;
        const cloth = new THREE.PlaneGeometry(wide ? 1.3 : 0.6, drop).rotateY(Math.PI / 2);
        // Each piece hangs a hand's width along the street from its neighbours, so overlapping cloths never share a plane.
        streetPiece(cloth, farPaint(cloths[Math.floor(random() * cloths.length)]), x + (k - 2.5) * 0.06, y - 0.2 * (1 - Math.abs(z) / 3.5) - 0.02 - drop / 2, z);
      }
    }
    for (const [x, side] of [[6, -1], [19, 1], [30, -1], [41, 1], [52, -1], [61, 1]]) {
      const y = rise(x) + 3.5, z = side * 3.02;
      streetPiece(merge([rod([0, 0.25, side * 0.5], [0, 0.25, 0], 0.016, 4), rod([0, 0.25, 0], [0, 0.12, 0], 0.012, 4), box(0.2, 0.04, 0.2, 0, 0.11, 0), box(0.16, 0.03, 0.16, 0, -0.17, 0)]), farPaint(0x17181a), x, y, z);
      streetPiece(new THREE.BoxGeometry(0.14, 0.24, 0.14), farGlow, x, y - 0.03, z);
    }
  }
  // Rooftops behind the firing line and behind the hall, seen over the eaves.
  building(-9, 9, 21, 33, 10.5, townPlaster[1], 2.4);
  building(-16, 14, -58, -47, 15.5, townPlaster[3], 2.8);
  fenestrate({ x: -1, z: -47, yaw: 0 }, -14, 14, [{ y: 9.5, type: tall }, { y: 12.6, type: small }], 0x4d6f58);
  building(-40, -21, -44, -8, 12, townPlaster[2], 2.6, false);

  // ---- Shared façade parts, drawn once each --------------------------------
  // Shutter leaves are baked with their paint into two draws: louvred ones on the fronts round the square, and plain
  // boards on the town beyond, which is too far to show a louvre or to reach a puddle.
  const louvredLeaves: THREE.BufferGeometry[] = [], boardLeaves: THREE.BufferGeometry[] = [], litPanes: Transform[] = [];
  const leafMatrix = new THREE.Matrix4(), leafTurn = new THREE.Quaternion(), leafPaint = new THREE.Color(), unit = new THREE.Vector3(1, 1, 1);
  const paintedLeaf = (geometry: THREE.BufferGeometry, leaf: Transform & { colour: number }, shade: number) => {
    const part = geometry.clone(), tint = part.attributes.color;
    leafPaint.setHex(leaf.colour).multiplyScalar(shade);
    for (let i = 0; i < tint.count; i += 1) tint.setXYZ(i, tint.getX(i) * leafPaint.r, tint.getY(i) * leafPaint.g, tint.getZ(i) * leafPaint.b);
    return part.applyMatrix4(leafMatrix.compose(new THREE.Vector3(...leaf.position), leafTurn.setFromEuler(new THREE.Euler(...(leaf.rotation ?? [0, 0, 0]))), unit));
  };
  for (const type of [tall, small]) {
    instances(surroundGeometry(type.w, type.h, type.head, false), stone, type.surround, false);
    // The chamfered surrounds of the near fronts fold into the rest of the stonework.
    const fineSurround = surroundGeometry(type.w, type.h, type.head, true);
    for (const { position, rotation } of type.fine) place(new THREE.Mesh(fineSurround, stone), ...position).rotation.set(...(rotation ?? [0, 0, 0]));
    // One sheet of glass per window. Short windows show the top of the same furnishings the tall ones show whole.
    const pane = new THREE.PlaneGeometry(type.w, type.h), share = Math.min(1, type.h / type.w / 2);
    for (let i = 0; i < pane.attributes.uv.count; i += 1) pane.attributes.uv.setY(i, 1 - (1 - pane.attributes.uv.getY(i)) * share);
    // Dark panes of both sizes merge into one draw: each shows one of the four furnishings, chosen by where it hangs.
    const sheets = [0, 1, 2, 3].map((cell) => {
      const sheet = pane.clone();
      for (let i = 0; i < sheet.attributes.uv.count; i += 1) sheet.attributes.uv.setX(i, (sheet.attributes.uv.getX(i) * 0.984 + 0.008 + cell) * 0.25);
      return sheet;
    });
    for (const { position, rotation } of type.dark) {
      const pick = Math.abs(Math.sin(position[0] * 12.9898 + position[1] * 78.233 + position[2] * 37.719) * 43758.5453) % 1;
      stand(sheets[Math.floor(pick * 4)], paneDark, position, rotation);
    }
    for (const { position, rotation } of type.lit) litPanes.push({ position, rotation, scale: [type.w, type.h, 1] });
    instances(sashGeometry(type.w, type.h), sash, type.bars, false, false);
    const louvred = shutterGeometry(type.w / 2, type.h), board = shutterBoard(type.w / 2, type.h);
    type.leaves.forEach((leaf, index) => (leaf.near ? louvredLeaves : boardLeaves).push(paintedLeaf(leaf.near ? louvred : board, leaf, 0.9 + ((index * 37) % 10) * 0.03)));
  }
  // Lit rooms of both window sizes are one instanced draw: a unit pane scaled to its window.
  kit.instances(new THREE.PlaneGeometry(1, 1), roomMaterial(roomMap), litPanes, false, false);
  const nearLeaves = new THREE.Mesh(merge(louvredLeaves), shutterMaterial), farLeaves = new THREE.Mesh(merge(boardLeaves), shutterMaterial);
  nearLeaves.castShadow = nearLeaves.receiveShadow = farLeaves.receiveShadow = true;
  scene.add(nearLeaves, farLeaves);
  kit.mirrorHidden.push(farLeaves);
  instances(balconyStone(), stone, balconies, false);
  // Balcony ironwork folds into the rest of the iron.
  const balconyRails = balconyIron();
  for (const { position, rotation } of balconies) place(new THREE.Mesh(balconyRails, iron), ...position).rotation.set(...(rotation ?? [0, 0, 0]));
  const chimneyPlaster = plasterMaterial(0xc9a57c);
  const blocksOf = (list: Transform[], material: THREE.Material, shadow: boolean, metres: number) => list.forEach((item) => place(new THREE.Mesh(worldBox(...item.scale!, metres), material), ...item.position, shadow));
  blocksOf(cornices, trim, true, 2);
  blocksOf(courses, trim, false, 2);
  blocksOf(eaves, eaveWood, true, 2.4);
  blocksOf(chimneys, chimneyPlaster, true, 3.2);
  instances(new THREE.BoxGeometry(0.1, 0.13, 0.12), stone, dentils, false, false);
  instances(new THREE.CylinderGeometry(0.11, 0.14, 0.4, 10), terracotta, pots, false);

  // ---- Weathering: what the rain leaves on walls and paving ----------------
  type Cell = [number, number, number, number];
  const DRIP_L: Cell = [0.02, 0.5, 0.12, 1], DRIP_R: Cell = [0.38, 0.5, 0.48, 1], WASH: Cell = [0.502, 0.5, 0.998, 1];
  const stainCards: THREE.BufferGeometry[] = [];
  /** A card a finger's width off a wall face, hanging down from `top`, showing one region of the stain sheet. */
  const wallStain = (face: Face, s: number, top: number, w: number, h: number, cell: Cell) => {
    const card = new THREE.PlaneGeometry(w, h), uv = card.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, cell[0] + uv.getX(i) * (cell[2] - cell[0]), cell[1] + uv.getY(i) * (cell[3] - cell[1]));
    card.rotateY(face.yaw);
    card.translate(...at(face, s, top - h / 2, 0.015));
    stainCards.push(card);
  };
  /** Wash under a cornice or coping, in cards three metres wide that tile end to end. */
  const washRun = (face: Face, from: number, to: number, top: number, drop: number, vary = 0.5) => {
    for (let s = from; s < to - 0.2; s += 3) { const w = Math.min(3, to - s); wallStain(face, s + w / 2, top, w, drop + random() * vary, [WASH[0], 0.5, WASH[0] + (WASH[2] - WASH[0]) * w / 3, 1]); }
  };
  /** Rising damp along the foot of a wall: one long card, the strip repeating every four metres. */
  const dampRun = (face: Face, from: number, to: number, top: number) => wallStain(face, (from + to) / 2, top, to - from, top - 0.02, [0, 0.252, (to - from) / 4, 0.498]);
  /** Grime where paving meets a wall; the wall lies on the card's far side before `yaw` turns it. */
  const kerbGrime = (cx: number, cz: number, length: number, width: number, yaw: number) => {
    const card = new THREE.PlaneGeometry(length, width), uv = card.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * length / 4, 0.002 + uv.getY(i) * 0.246);
    card.rotateX(-Math.PI / 2); card.rotateY(yaw); card.translate(cx, 0.007, cz);
    stainCards.push(card);
  };
  // Runs from the two ends of every sill.
  for (const { face, s, y0, type } of nearWindows) for (const side of [-1, 1])
    wallStain(face, s + side * (type.w / 2 + 0.27), y0 - 0.3, 0.36, 1.1 + random() * 0.6, side < 0 ? DRIP_L : DRIP_R);
  // Under each cornice of the sunlit fronts, only on the plaster between the window openings.
  blocks.forEach((block) => {
    const pitch = (block.z1 - block.z0) / block.columns;
    for (let k = 0; k <= block.columns; k += 1) {
      const edge = k === 0 || k === block.columns, z = block.z1 - k * pitch + (k === 0 ? -0.46 : k === block.columns ? 0.46 : 0);
      wallStain(FL, -z, block.h - 0.66, edge ? 0.9 : pitch - 1.3, 1.3 + random() * 1.1, [WASH[0], 0.5, WASH[0] + (WASH[2] - WASH[0]) * (edge ? 0.3 : 0.56), 1]);
    }
  });
  // Under the string course on the stone floor (kept clear of the arch crowns), the garden coping, and the eaves of the back house and the hall.
  const FLG: Face = { x: LEFT, z: 0, yaw: Math.PI / 2 }, FR: Face = { x: RIGHT, z: 0, yaw: -Math.PI / 2 }, FA: Face = { x: 0, z: -30.4, yaw: 0 };
  washRun(FLG, -0.4, 30.4, BAND - 0.03, 0.8, 0.45);
  washRun(FLG, -9.7, -0.4, BAND - 0.03, 0.55, 0.3);
  washRun(FR, -30.3, 0, BAND - 0.01, 1.0, 0.7);
  washRun(FB, -10.3, 9.5, 7.2, 1.3);
  washRun(FH, hallX - hallW / 2, hallX + hallW / 2, 11.1, 1.2);
  washRun(FA, hallX - hallW / 2, hallX + hallW / 2, 5.18, 0.7, 0.3);
  dampRun({ x: LEFT + 0.1, z: 0, yaw: Math.PI / 2 }, 0, 22.67, 0.66);
  dampRun({ x: LEFT + 0.1, z: 0, yaw: Math.PI / 2 }, 24.33, 30.4, 0.66);
  dampRun({ x: RIGHT - 0.08, z: 0, yaw: -Math.PI / 2 }, -30.4, -0.2, 0.62);
  dampRun({ x: 0, z: 9.63, yaw: Math.PI }, -10.3, 9.54, 0.44);
  kerbGrime(-9.14, -15.2, 30.4, 0.6, Math.PI / 2);
  kerbGrime(9.16, -15.3, 30.2, 0.6, -Math.PI / 2);
  kerbGrime(0.38, 9.33, 19.8, 0.6, Math.PI);
  kerbGrime(hallX, -30.1, hallW, 0.6, 0);
  const stainMap = track(stainAtlas());
  stainMap.anisotropy = anisotropy;
  // Multiplied onto whatever is behind: darkens sun and shade alike, and overlapping cards can never fight or pop.
  const stainMesh = new THREE.Mesh(merge(stainCards), new THREE.MeshBasicMaterial({ map: stainMap, transparent: true, blending: THREE.MultiplyBlending, premultipliedAlpha: true, depthWrite: false, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -4 }));
  scene.add(stainMesh);
  kit.mirrorHidden.push(stainMesh);

  // ---- Lanterns and festoon lights -----------------------------------------
  const lanternSpots: Transform[] = [
    ...[-27, -17.2, -8.2, 1.0, 7.4].map((z) => ({ position: at(FL, -z, 5.0, 0.06), rotation: [0, Math.PI / 2, 0] as V3 })),
    ...[-6.1, -2.0, 2.0, 6.1].map((x) => ({ position: [hallX + x, 3.7, -30.4] as V3 })),
  ];
  instances(lanternIron(), iron, lanternSpots, false);
  instances(new THREE.CylinderGeometry(0.115, 0.075, 0.27, 4).rotateY(Math.PI / 4), bulb, lanternSpots.map((spot) => ({ position: at({ x: spot.position[0], z: spot.position[2], yaw: spot.rotation?.[1] ?? 0 }, 0, spot.position[1] - 0.05, 0.42) })), false, false);
  // Lamp standards on the garden wall double as festoon anchors.
  const standards: V3[] = [[RIGHT + 0.45, BAND + 0.14, -21], [RIGHT + 0.45, BAND + 0.14, -8.6], [RIGHT + 0.46, 5.5, 0.3]];
  instances(merge([new THREE.CylinderGeometry(0.035, 0.05, 2.5, 8).translate(0, 1.25, 0), new THREE.CylinderGeometry(0.09, 0.11, 0.3, 8).translate(0, 0.15, 0), new THREE.ConeGeometry(0.2, 0.14, 8).translate(0, 2.87, 0)]), iron, standards.map((position) => ({ position })), false);
  instances(new THREE.SphereGeometry(0.15, 14, 10), bulb, standards.map(([x, y, z]) => ({ position: [x, y + 2.66, z] as V3 })), false, false);
  const anchors: V3[] = [
    [UPPER + 0.05, 8.35, -26.6], [standards[0][0], standards[0][1] + 2.45, standards[0][2]], [UPPER + 0.05, 8.35, -16.9],
    [standards[1][0], standards[1][1] + 2.45, standards[1][2]], [UPPER + 0.05, 8.35, -7.3], [standards[2][0], standards[2][1] + 2.45, standards[2][2]],
    [UPPER + 0.05, 8.2, 3.6],
  ];
  const wires: THREE.BufferGeometry[] = [], bulbs: Transform[] = [], sockets: Transform[] = [], wireDrips: V3[] = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = new THREE.Vector3(...anchors[i]), b = new THREE.Vector3(...anchors[i + 1]), span = a.distanceTo(b), sag = 1.15 + (i % 2) * 0.25;
    const point = (t: number) => a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t));
    // Where three of the wires cross a gutter the last of the rain still gathers on them and falls (see the moving water, below).
    const gutter = i === 2 ? -8.12 : i === 3 || i === 5 ? 8.12 : null;
    if (gutter !== null) { const p = point((gutter - a.x) / (b.x - a.x)); wireDrips.push([p.x, p.y - 0.012, p.z]); }
    wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 17 }, (_, k) => point(k / 16))), 40, 0.011, 4));
    const count = Math.floor(span / 0.62);
    for (let k = 1; k < count; k += 1) {
      const p = point(k / count);
      sockets.push({ position: [p.x, p.y - 0.045, p.z] });
      bulbs.push({ position: [p.x, p.y - 0.125, p.z] });
    }
  }
  place(new THREE.Mesh(merge(wires), rubber), 0, 0, 0, false);
  instances(new THREE.CylinderGeometry(0.02, 0.026, 0.07, 5, 1, true), rubber, sockets, false, false);
  instances(new THREE.SphereGeometry(0.05, 7, 4), bulb, bulbs, false, false);

  // ---- Planting: every plant is the shared library's, and moves in the square's one wind -------------
  /** Plants too high, too far or too slight to show in the wet cobbles are left out of the puddle reflections. */
  const unreflected = (meshes: THREE.Object3D[], only?: string) => { for (const mesh of meshes) if (!only || mesh.name.includes(only)) kit.mirrorHidden.push(mesh); };
  // Bay laurels in terracotta down both sides, clear of signs and furnace; a pair by the green door and two at the trattoria.
  const laurels: Array<[number, number, number]> = [
    [-9.2, -27.3, 0.9], [-9.2, -19.85, 0.85], [-9.2, -14.0, 0.92], [-9.2, -8.6, 0.85], [-9.2, -1.0, 0.9],
    [9.2, -26.6, 0.9], [9.2, -20.0, 0.85], [9.2, -14.1, 0.9], [9.2, -8.6, 0.85], [9.2, -1.0, 0.92],
    [-9.12, -24.5, 0.78], [-9.12, -22.55, 0.78], [15.3, 15.95, 1.05], [21.1, 15.95, 1],
  ];
  unreflected(trees.place("potLaurel", laurels.map(([x, z, scale], index): TreeItem => ({ at: [x, 0, z], scale, variant: 0, yaw: index * 2.3 }))), ":bark:");
  // Geraniums: two boxes hung on every balcony rail, one on each free sill of the fronts, and along the trattoria's windows.
  const boxes: TreeItem[] = [];
  balconies.forEach((balcony, index) => {
    const face: Face = { x: balcony.position[0], z: balcony.position[2], yaw: balcony.rotation?.[1] ?? 0 };
    for (const s of index % 2 ? [-0.5, 0.5] : [-0.58, 0.34]) boxes.push({ at: at(face, s, balcony.position[1] + 0.79, 0.88), yaw: face.yaw, variant: 0, bloom: 0.75 + ((index * 7) % 3) * 0.12 });
  });
  nearWindows.forEach(({ face, s, y0, sill }, index) => { if (sill && index % 2 === 0) boxes.push({ at: at(face, s, y0 - 0.17, 0.14), yaw: face.yaw, variant: 0, bloom: 0.7 + (index % 3) * 0.15 }); });
  for (const x of [13.1, 16.3, 19.6, 22.8]) boxes.push({ at: [x, 0.73, 16.26], yaw: Math.PI, variant: 0 });
  unreflected(trees.place("flowerBox", boxes, { hit: false }));
  // Bougainvillea spilling over the garden wall, cut short above the signs.
  unreflected(trees.place("bougainvillea", [[-18.05, 0.74, 0.9], [-15.75, 0.7, 1], [-5.3, 0.9, 0.85], [-2.7, 1, 1]].map(([z, hang, bloom], index): TreeItem => ({ at: [RIGHT - 0.1, BAND + 0.14, z], yaw: -Math.PI / 2, variant: 2, scale: [0.92, hang, 1], bloom, tint: index % 2 ? 0xe8e8e8 : 0xffffff }))), ":bark:");
  // Cypresses on the terrace and in the side square: thin shadows raking the cobbles.
  // Only two stand near enough to throw a stripe across the square; the rest sit back so the cobbles keep their sun.
  const cypresses: Array<[number, number, number, number]> = [
    [11.6, 4.3, -27.8, 6.2], [12.2, 4.3, -4.6, 6.4], [22.5, 4.3, -23, 5.4], [23.5, 4.3, -12, 5.8], [22, 4.3, -2.4, 5], [24, 4.3, -17.5, 5.6], [21.5, 4.3, -8, 4.6],
    [31, 0, 13.4, 8.5], [34, 0, 13.8, 7.2], [41.5, 0, 3, 9],
  ];
  unreflected(trees.place("cypress", cypresses.map(([x, y, z, h]): TreeItem => ({ at: [x, y, z], variant: 0, yaw: x * 3, scale: h / 8.7 })), { detail: "mid", hit: false }), ":bark:");
  // Plane trees, turning: one in the side square whose dappled shade reaches the firing line, two in the garden over the wall.
  const planes: TreeItem[] = [
    { at: [17.5, 0.37, 12.2], variant: 0, yaw: 0.6, scale: 0.76, dry: 0.5 },
    { at: [19, 4.3, -28.4], variant: 0, yaw: 2.4, scale: 0.6, dry: 0.3 },
    { at: [22.6, 4.3, -15.2], variant: 0, yaw: 4.1, scale: 0.5, dry: 0.62 },
  ];
  unreflected(trees.place("plane", planes, { detail: "mid", hit: false }), ":bark:");
  // The side square's tree stands in a raised stone ring of soil.
  const ringProfile = [[1.0, 0], [1.25, 0], [1.25, 0.42], [1.18, 0.48], [1.0, 0.48], [1.0, 0.3]].map(([x, y]) => new THREE.Vector2(x, y));
  place(new THREE.Mesh(new THREE.LatheGeometry(ringProfile, 28), stone), 17.5, 0, 12.2, true);
  place(new THREE.Mesh(new THREE.CircleGeometry(1.01, 24).rotateX(-Math.PI / 2), earthen(0x32241a)), 17.5, 0.37, 12.2, false);
  // Leaves the rain brought down: drifts against the foot of every wall, thin scatters in the open, a thick one under the tree.
  const drifts: TreeItem[] = [
    ...[-28.6, -25.9, -21.6, -17.9, -15.8, -12.4, -10.1, -6.9, -2.7].map((z, index): TreeItem => ({ at: [LEFT + 0.42, 0.012, z], yaw: Math.PI / 2, scale: 0.85 + (index % 3) * 0.12 })),
    ...[-28.2, -23.4, -21.6, -17.5, -15.4, -5.4, -3.2, -0.5].map((z, index): TreeItem => ({ at: [RIGHT - 0.4, 0.012, z], yaw: -Math.PI / 2, scale: 0.85 + (index % 3) * 0.12 })),
    ...[-6.6, -3.4, 2.6, 6.1].map((x, index): TreeItem => ({ at: [x, 0.012, 9.3], yaw: Math.PI, scale: 0.9 + (index % 2) * 0.2 })),
    ...[11.6, 14.8, 20.2, 24.6].map((x, index): TreeItem => ({ at: [x, 0.012, 16.05], yaw: Math.PI, scale: 1 + (index % 2) * 0.2 })),
  ];
  unreflected(trees.place("leafLitter", drifts.map((item) => ({ ...item, variant: 1, dry: 0.75 }))));
  const scatters: Array<[number, number, number]> = [[-2.6, 4.6, 0.4], [3.4, 1.2, 1.9], [6.9, 5.6, 2.6], [-6.9, -12.4, 0.9], [2.3, -13.3, 2.2], [-1.4, -22.2, 1.3], [6.7, -21.6, 0.2], [-7.4, 1.4, 1.1], [13.2, 12.6, 0.5], [20.3, 9.2, 2.1], [15.6, 14.4, 1.4], [24.2, 5.2, 0.8], [12.8, 6.4, 2.9]];
  unreflected(trees.place("leafLitter", scatters.map(([x, z, yaw]): TreeItem => ({ at: [x, 0.012, z], yaw, variant: 2, dry: 0.8 }))));
  unreflected(trees.place("leafLitter", ([[17.5, 0.385, 12.2, 0.84], [19.6, 0.012, 13.4, 1.1], [15.4, 0.012, 10.8, 1], [18.2, 0.012, 9.6, 1.15], [8.1, 0.012, -12.6, 0.6], [-8.1, 0.012, -0.5, 0.6]] as number[][]).map(([x, y, z, scale], index): TreeItem => ({ at: [x, y, z], yaw: index * 1.9, scale, variant: 0, dry: 0.7 }))));
  // Weeds where nobody sweeps: the foot of the walls, round the bollards and the pier, at the tree ring.
  const weedSpots: Array<[number, number]> = [
    [-9.36, -29.2], [-9.38, -26.4], [-9.37, -18.6], [-9.36, -16.4], [-9.38, -11.2], [-9.37, -6.2], [-9.36, -3.1], [-9.3, 0.5], [-9.32, 3.6],
    [9.38, -28.8], [9.39, -24.9], [9.38, -19.3], [9.4, -16.7], [9.38, -9.4], [9.39, -6.3], [9.38, -2.2], [9.3, 0.95],
    [-8.9, 9.5], [-5.2, 9.52], [1.6, 9.5], [4.4, 9.53], [9.6, 9.4], [9.74, 2.3], [10.1, 4.1], [9.7, 6.0], [10.05, 7.9], [10.6, 0.95],
    [16.2, 12.0], [18.3, 13.4], [17.0, 10.9], [18.9, 11.6], [12.2, 16.0], [18.4, 16.05], [23.6, 16.0], [-8.68, -3.72], [-8.66, -5.45],
  ];
  unreflected(trees.place("weeds", weedSpots.map(([x, z], index): TreeItem => ({ at: [x, 0, z], yaw: index * 2.4, variant: 0, scale: 0.8 + (index % 4) * 0.14 }))));
  unreflected(trees.place("weeds", ([[-9.3, -20.9, Math.PI / 2], [-9.3, -9.5, Math.PI / 2], [9.33, -22.4, Math.PI / 2], [9.33, -4.3, Math.PI / 2], [-1.2, 9.5, 0], [7.2, 9.5, 0], [9.9, 3.0, Math.PI / 2], [9.9, 6.9, Math.PI / 2], [14.6, 16.05, 0], [20.6, 16.08, 0]] as number[][]).map(([x, z, yaw]): TreeItem => ({ at: [x, 0, z], yaw, variant: 2 }))));

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
  const tables: V3[] = [[-8.5, 0, -26.0], [-8.45, 0, -11.9], [-8.4, 0, 2.0], [-8.3, 0, 5.4], [-8.4, 0, 8.4], [8.5, 0, -3.4], [8.5, 0, -16.8], [8.5, 0, -24.3]];
  const chairs: Transform[] = [];
  tables.forEach(([x, , z], index) => {
    const inward = -Math.sign(x);
    // One chair each side along the wall and, where there is room, one facing the square.
    chairs.push({ position: [x + 0.05, 0, z - 0.62], rotation: [0, Math.PI + (index % 3 - 1) * 0.3, 0] }, { position: [x - 0.04, 0, z + 0.62], rotation: [0, (index % 2 - 0.5) * 0.5, 0] });
    if (index % 2 === 0) chairs.push({ position: [x + inward * 0.6, 0, z + 0.08], rotation: [0, -inward * Math.PI / 2 + 0.25, 0] });
  });
  instances(new THREE.LatheGeometry(tableProfile, 24), cafeMetal, tables.map((position) => ({ position })), true);
  instances(chairGeometry, cafeMetal, chairs, true);
  /** What was left on a table: a kind, where on the top, and which label. */
  const laid = (table: V3, top: number, ...things: Array<[PropKind, number, number, number?]>) =>
    dress(...things.map(([kind, dx, dz, variant]): Dressed => ({ kind, position: [table[0] + dx, top, table[2] + dz], rotation: [0, dx * 23 + dz * 11, 0], ...(variant === undefined ? {} : { variant }) })));
  // Honey for the bread on most tables, olives where there is wine, and whatever the last guests were drinking.
  laid(tables[0], 0.741, ["jar", 0.07, -0.06, 2]);
  laid(tables[1], 0.741, ["jar", -0.1, 0.08, 2], ["bottleSoda", 0.09, -0.05], ["bottleSoda", 0.17, 0.09]);
  laid(tables[2], 0.741, ["bottleWine", 0.03, -0.11], ["jar", 0.13, 0.08, 1]);
  laid(tables[3], 0.741, ["bottleBeer", 0.11, 0.02], ["bottleBeer", -0.05, 0.14], ["jar", -0.06, -0.12, 2]);
  laid(tables[4], 0.741, ["bottleSpirits", -0.09, -0.05], ["jar", 0.1, 0.07, 2]);
  laid(tables[5], 0.741, ["jar", -0.08, 0.05, 2], ["bottleSoda", 0.06, -0.11]);
  laid(tables[6], 0.741, ["bottleWine", -0.06, 0.1], ["jar", 0.09, -0.05, 1]);
  laid(tables[7], 0.741, ["jar", 0.03, 0.08, 2]);

  // ---- Bicycle leaning on the sunlit wall ----------------------------------
  const [tyreGeometry, wheelMetal] = wheelGeometry(0.33, 0.017, 9, 0.004);
  const bicycle = new THREE.Group(), lean = new THREE.Group();
  const bikePart = (geometry: THREE.BufferGeometry, material: THREE.Material) => { const mesh = new THREE.Mesh(geometry, material); lean.add(mesh); pending.push({ mesh, shadow: true, hit: false }); };
  const rear: V3 = [-0.52, 0.34, 0], front: V3 = [0.54, 0.34, 0], crank: V3 = [-0.06, 0.3, 0], seat: V3 = [-0.24, 0.84, 0], head: V3 = [0.36, 0.88, 0], steer: V3 = [0.4, 0.72, 0];
  const enamel = family(new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.28, envMapIntensity: 1.2 }));
  const framePaint = enamel(BRAND);
  bikePart(merge([rod(crank, seat, 0.017, 8), rod(seat, head, 0.016, 8), rod(crank, steer, 0.019, 8), rod(head, steer, 0.02, 8),
    ...[-0.05, 0.05].flatMap((z) => [rod([seat[0], seat[1], 0], [rear[0], rear[1], z], 0.009), rod([crank[0], crank[1], 0], [rear[0], rear[1], z], 0.01), rod([steer[0], steer[1], z * 0.6], [front[0], front[1], z], 0.011)])]), framePaint);
  bikePart(merge([tyreGeometry.clone().translate(...rear), tyreGeometry.clone().translate(...front), softBox(0.27, 0.05, 0.15, 0.02, 1).translate(-0.27, 0.95, 0),
    new THREE.CylinderGeometry(0.017, 0.017, 0.11, 8).rotateX(Math.PI / 2).translate(0.3, 1.02, 0.25), new THREE.CylinderGeometry(0.017, 0.017, 0.11, 8).rotateX(Math.PI / 2).translate(0.3, 1.02, -0.25),
    box(0.09, 0.02, 0.07, 0.08, 0.16, 0.12), box(0.09, 0.02, 0.07, -0.2, 0.44, -0.12)]), rubber);
  bikePart(merge([wheelMetal.clone().translate(...rear), wheelMetal.clone().translate(...front), rod(seat, [-0.26, 0.93, 0], 0.012), rod(head, [0.3, 1.02, 0], 0.012), rod([0.3, 1.02, -0.3], [0.3, 1.02, 0.3], 0.011),
    rod([0.3, 1.02, 0.08], [0.43, 1.0, 0.08], 0.006), rod([0.3, 1.02, -0.08], [0.43, 1.0, -0.08], 0.006),
    new THREE.CylinderGeometry(0.09, 0.09, 0.008, 18).rotateX(Math.PI / 2).translate(crank[0], crank[1], 0.05), rod([crank[0], crank[1], 0.06], [0.08, 0.17, 0.08], 0.008), rod([crank[0], crank[1], -0.06], [-0.2, 0.43, -0.08], 0.008),
    rod([crank[0], crank[1], -0.07], [crank[0], crank[1], 0.07], 0.012)]), metals.brushed);
  lean.rotation.x = -0.17;
  bicycle.add(lean);
  bicycle.position.set(-9.1, 0, -21.3);
  bicycle.rotation.y = Math.PI / 2;
  // A wicker basket hooked on the bars, leaning with the frame, and the shopping in it.
  dress(...carried(laden("basket", { position: [0.57, 0.815, 0], rotation: [0, Math.PI / 2, 0], scale: [0.62, 0.62, 0.62] }, ["apple", "lemon"], 12, 31, 0.86),
    [bicycle.position.x, 0, bicycle.position.z], new THREE.Quaternion().setFromEuler(new THREE.Euler(lean.rotation.x, bicycle.rotation.y, 0, "YXZ"))));

  // ---- Market cart in the side square --------------------------------------
  const cart = new THREE.Group();
  const cartPart = (geometry: THREE.BufferGeometry, material: THREE.Material) => { const mesh = new THREE.Mesh(geometry, material); cart.add(mesh); pending.push({ mesh, shadow: true, hit: false }); return mesh; };
  const [cartTyre, cartSpokes] = wheelGeometry(0.56, 0.03, 6, 0.016);
  cartPart(merge([softBox(2.0, 0.08, 1.1, 0.015, 1.1).translate(0, 0.86, 0), softBox(2.0, 0.26, 0.05, 0.012, 1.1).translate(0, 1.02, 0.53), softBox(2.0, 0.26, 0.05, 0.012, 1.1).translate(0, 1.02, -0.53),
    softBox(0.05, 0.26, 1.1, 0.012, 1.1).translate(-0.98, 1.02, 0), softBox(0.05, 0.26, 1.1, 0.012, 1.1).translate(0.98, 1.02, 0),
    rod([0.9, 0.84, 0.42], [2.0, 0.98, 0.42], 0.028, 8), rod([0.9, 0.84, -0.42], [2.0, 0.98, -0.42], 0.028, 8), rod([0.8, 0, 0.4], [0.8, 0.84, 0.4], 0.03, 8), rod([0.8, 0, -0.4], [0.8, 0.84, -0.4], 0.03, 8),
    ...[[-0.95, 0.5], [-0.95, -0.5], [0.95, 0.5], [0.95, -0.5]].map(([x, z]) => rod([x, 0.86, z], [x, 2.25, z], 0.022, 6)),
    cartSpokes.clone().translate(-0.25, 0.56, 0.62), cartSpokes.clone().translate(-0.25, 0.56, -0.62), rod([-0.25, 0.56, -0.64], [-0.25, 0.56, 0.64], 0.03, 8)]), metals.crate);
  cartPart(merge([cartTyre.clone().translate(-0.25, 0.56, 0.62), cartTyre.clone().translate(-0.25, 0.56, -0.62)]), iron);
  const cartCloth = new THREE.PlaneGeometry(2.3, 1.5, 22, 14);
  cartCloth.rotateX(-Math.PI / 2);
  for (let i = 0; i < cartCloth.attributes.position.count; i += 1) { const x = cartCloth.attributes.position.getX(i) / 1.15, z = cartCloth.attributes.position.getZ(i) / 0.75; cartCloth.attributes.position.setY(i, 2.27 - 0.1 * (1 - x * x) * (1 - z * z)); }
  cartCloth.computeVertexNormals();
  // Two stripes across the canopy, on a sheet that repeats three times to the unit.
  for (let i = 0; i < cartCloth.attributes.uv.count; i += 1) cartCloth.attributes.uv.setX(i, cartCloth.attributes.uv.getX(i) * 2 / 3);
  cartPart(cartCloth, awningCloths[1]);
  // The seller's board hangs from a rail between the front posts, facing the square.
  cartPart(merge([rod([-0.95, 2.19, -0.5], [0.95, 2.19, -0.5], 0.012, 6), softBox(0.93, 0.33, 0.016, 0.004, 1).translate(0, 1.96, -0.505),
    rod([-0.36, 2.19, -0.5], [-0.36, 2.12, -0.505], 0.004, 4), rod([0.36, 2.19, -0.5], [0.36, 2.12, -0.505], 0.004, 4)]), metals.crate);
  cartPart(notice("lemons", 0.9).rotateY(Math.PI).translate(0, 1.96, -0.5145), noticePaint);
  cart.position.set(12.4, 0, 4.2);
  cart.rotation.y = 0.5;

  // The stall, dressed on the bed and carried round with the cart: lemons high on an upturned crate, grapes and bananas in a
  // flat basket on a packing case, apples in a basket between them, three trays along the front and melons by the shafts.
  const BED = 0.9, slatH = heightOf("crateSlat"), caseH = heightOf("crateSmall"), trayH = heightOf("crateProduce");
  dress(...carried([
    { kind: "crateSlat", position: [0.6, BED + slatH, 0.24], rotation: [Math.PI, -0.06, 0] },
    ...laden("crateProduce", { position: [0.59, BED + slatH, 0.235], rotation: [0, -0.1, 0] }, "lemon", 24, 11),
    { kind: "crateSmall", position: [-0.6, BED, 0.215], rotation: [0, -0.04, 0] },
    { kind: "basketTray", position: [-0.585, BED + caseH, 0.2], rotation: [0, 0.7, 0] },
    ...props.heap(["grapes", "bananas"], { at: [-0.585, BED + caseH + 0.012, 0.2], radius: 0.215, count: 7, scale: 0.9, seed: 5, place: false }).items,
    ...laden("basket", { position: [0.015, BED, 0.2], rotation: [0, 1.48, 0] }, "apple", 30, 13),
    // The front trays ride on upturned empties so they show over the side boards.
    ...[[-0.67, -0.31, 0.03], [-0.13, -0.3, -0.03], [0.4, -0.315, 0.04]].map(([x, z, turn]): Dressed => ({ kind: "crateProduce", position: [x, BED + trayH, z], rotation: [Math.PI, -turn, 0] })),
    ...laden("crateProduce", { position: [-0.665, BED + trayH, -0.305], rotation: [0, 0.07, 0] }, "orange", 24, 14),
    ...laden("crateProduce", { position: [-0.135, BED + trayH, -0.3], rotation: [0, -0.08, 0] }, "tomato", 28, 15),
    ...laden("crateProduce", { position: [0.405, BED + trayH, -0.31], rotation: [0, 0.1, 0] }, "pepper", 18, 16),
    ...props.heap("melon", { at: [0.815, BED, -0.27], size: [0.26, 0.44], rim: 0.12, count: 3, seed: 17, place: false }).items,
  ], [cart.position.x, 0, cart.position.z], cart.quaternion));
  dress(
    // Stock against the garden wall: melons in the upper crate of a pair, a tray of oranges on a packing case, empties leaning and stacked.
    { kind: "crateSlat", position: [11.32, 0, 0.74], rotation: [0, 0.07, 0] },
    ...laden("crateSlat", { position: [11.35, slatH, 0.76], rotation: [0, -0.09, 0] }, "melon", 7, 21),
    { kind: "crateSmall", position: [12.08, 0, 0.72], rotation: [0, -0.1, 0] },
    ...laden("crateProduce", { position: [12.06, caseH, 0.74], rotation: [0, 0.16, 0] }, "orange", 22, 22),
    { kind: "crateProduce", position: [12.78, 0.165, 0.366], rotation: tipped(0.04, 1.31) },
    { kind: "crateProduce", position: [13.42, 0, 0.7], rotation: [0, 0.35, 0] },
    { kind: "crateProduce", position: [13.4, trayH, 0.69], rotation: [0, 0.2, 0] },
    // Set out in front of the stall, toward the square.
    ...laden("basket", { position: [11.38, 0, 3.17], rotation: [0, 0.9, 0] }, "pepper", 24, 23),
    { kind: "crateSlat", position: [11.9, slatH, 2.75], rotation: [Math.PI, -0.3, 0] },
    ...laden("basketTray", { position: [11.89, slatH, 2.76], rotation: [0, 0.2, 0] }, ["lemon", "orange"], 18, 24),
    ...laden("crateProduce", { position: [12.5, 0, 2.42], rotation: [0, 0.62, 0] }, "apple", 24, 25),
  );

  // ---- Café terrace in the side square -------------------------------------
  const terrace: V3[] = [[12.6, 0, 8.4], [14.9, 0, 7.0], [13.6, 0, 10.9], [16.3, 0, 9.3], [19.4, 0, 6.2]];
  const terraceChairs: Transform[] = [];
  terrace.forEach(([x, , z], index) => {
    for (let k = 0; k < 3; k += 1) { const angle = index * 1.3 + k * (Math.PI * 2 / 3) + (random() - 0.5) * 0.4, reach = 0.62 + random() * 0.14; terraceChairs.push({ position: [x + Math.sin(angle) * reach, 0, z + Math.cos(angle) * reach], rotation: [0, angle + (random() - 0.5) * 0.5, 0] }); }
  });
  instances(new THREE.LatheGeometry(tableProfile, 24), cafeMetal, terrace.map((position) => ({ position })), false);
  instances(chairGeometry, cafeMetal, terraceChairs, false);
  // Gingham cloths on the tables.
  const clothProfile = [[0, 0.748], [0.36, 0.748], [0.375, 0.73], [0.39, 0.56]].map(([x, y]) => new THREE.Vector2(x, y));
  const tableCloth = new THREE.LatheGeometry(clothProfile, 20);
  { const p = tableCloth.attributes.position; for (let i = 0; i < p.count; i += 1) if (p.getY(i) < 0.6) { const a = Math.atan2(p.getZ(i), p.getX(i)), k = 1 + 0.07 * Math.sin(a * 7); p.setXYZ(i, p.getX(i) * k, p.getY(i) + 0.02 * Math.sin(a * 5), p.getZ(i) * k); } tableCloth.computeVertexNormals(); scaleUv(tableCloth, 5, 1); }
  instances(tableCloth, ginghamCloth, terrace.slice(0, 4).map((position) => ({ position })), false, false);
  laid(terrace[0], 0.749, ["bottleWine", -0.15, -0.12], ["jar", 0.16, 0.09, 1]);
  laid(terrace[1], 0.749, ["bottleSoda", 0.18, -0.05], ["bottleSoda", -0.1, 0.19], ["jar", -0.16, -0.1, 2]);
  laid(terrace[2], 0.749, ["jar", 0.05, 0.03, 2]);
  laid(terrace[3], 0.749, ["bottleBeer", 0.15, 0.11], ["bottleBeer", 0.21, -0.06], ["jar", -0.14, 0.13, 2]);
  laid(terrace[4], 0.741, ["jar", -0.04, 0.06, 2]);
  // Parasols: one open over the middle table, two furled and strapped.
  const parasolIron: THREE.BufferGeometry[] = [], parasolCloth: THREE.BufferGeometry[] = [];
  const parasol = (x: number, z: number, open: boolean) => {
    parasolIron.push(new THREE.CylinderGeometry(0.022, 0.022, 2.6, 8).translate(x, 1.3, z), new THREE.CylinderGeometry(0.26, 0.3, 0.09, 14).translate(x, 0.045, z), new THREE.SphereGeometry(0.035, 8, 6).translate(x, 2.62, z));
    if (open) {
      const canopy = new THREE.ConeGeometry(1.55, 0.55, 8, 3, true);
      const p = canopy.attributes.position;
      for (let i = 0; i < p.count; i += 1) { const y = p.getY(i), t = 0.5 - y / 0.55; p.setY(i, y - 0.12 * t * (1 - t) * 4); }
      canopy.computeVertexNormals();
      parasolCloth.push(scaleUv(canopy, 8, 1.6).translate(x, 2.32, z));
      const valance = new THREE.CylinderGeometry(1.55, 1.55, 0.16, 8, 1, true);
      parasolCloth.push(scaleUv(valance, 8, 0.16).translate(x, 1.97, z));
      for (let k = 0; k < 8; k += 1) { const a = k * Math.PI / 4; parasolIron.push(rod([x, 2.5, z], [x + Math.sin(a) * 1.53, 2.06, z + Math.cos(a) * 1.53], 0.008, 4), rod([x, 1.75, z], [x + Math.sin(a) * 0.8, 2.26, z + Math.cos(a) * 0.8], 0.007, 4)); }
    } else {
      const furled = new THREE.LatheGeometry([[0.03, 0], [0.1, 0.12], [0.085, 0.5], [0.1, 0.9], [0.06, 1.25], [0.025, 1.45]].map(([r, y]) => new THREE.Vector2(r, y)), 10);
      const p = furled.attributes.position;
      for (let i = 0; i < p.count; i += 1) { const a = Math.atan2(p.getZ(i), p.getX(i)), k = 1 + 0.16 * Math.sin(a * 4 + p.getY(i) * 3); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); }
      furled.computeVertexNormals();
      parasolCloth.push(scaleUv(furled, 2, 3).translate(x, 1.12, z));
      parasolIron.push(new THREE.TorusGeometry(0.095, 0.012, 5, 12).rotateX(Math.PI / 2).translate(x, 1.66, z));
    }
  };
  parasol(14.9, 7.0, true); parasol(12.6, 8.4, false); parasol(16.3, 9.3, false);
  place(new THREE.Mesh(merge(parasolIron), iron), 0, 0, 0, true);
  place(new THREE.Mesh(merge(parasolCloth), ginghamCloth), 0, 0, 0, true);

  // ---- Scooter parked by the bollards --------------------------------------
  const scooter = new THREE.Group();
  const scooterPart = (geometry: THREE.BufferGeometry, material: THREE.Material) => { const mesh = new THREE.Mesh(geometry, material); scooter.add(mesh); pending.push({ mesh, shadow: true, hit: false }); };
  const scooterPaint = enamel(0xe9dcc0);
  scooterPart(merge([
    softBox(0.8, 0.34, 0.36, 0.13, 1).translate(-0.4, 0.5, 0), new THREE.SphereGeometry(0.2, 14, 10).scale(1.25, 0.95, 0.9).translate(-0.74, 0.5, 0),
    softBox(0.52, 0.05, 0.32, 0.02, 1).translate(0.08, 0.26, 0), softBox(0.07, 0.62, 0.44, 0.03, 1).rotateZ(0.24).translate(0.4, 0.56, 0),
    new THREE.TorusGeometry(0.25, 0.075, 6, 14, Math.PI).scale(1, 1, 1.1).translate(0.62, 0.2, 0), softBox(0.2, 0.16, 0.22, 0.06, 1).translate(0.4, 0.98, 0),
  ]), scooterPaint);
  scooterPart(merge([
    new THREE.TorusGeometry(0.15, 0.065, 8, 20).translate(0.62, 0.215, 0), new THREE.TorusGeometry(0.15, 0.065, 8, 20).translate(-0.6, 0.215, 0),
    softBox(0.66, 0.09, 0.3, 0.04, 1).translate(-0.36, 0.71, 0), new THREE.CylinderGeometry(0.022, 0.022, 0.13, 8).rotateX(Math.PI / 2).translate(0.38, 1.02, 0.31), new THREE.CylinderGeometry(0.022, 0.022, 0.13, 8).rotateX(Math.PI / 2).translate(0.38, 1.02, -0.31),
    softBox(0.34, 0.012, 0.26, 0.004, 1).translate(0.06, 0.29, 0),
  ]), rubber);
  scooterPart(merge([
    new THREE.CylinderGeometry(0.1, 0.1, 0.1, 14).rotateX(Math.PI / 2).translate(0.62, 0.215, 0), new THREE.CylinderGeometry(0.1, 0.1, 0.12, 14).rotateX(Math.PI / 2).translate(-0.6, 0.215, 0),
    rod([0.44, 0.3, 0], [0.38, 1.0, 0], 0.022, 8), rod([0.47, 0.55, 0.075], [0.62, 0.215, 0.075], 0.014, 6), rod([0.38, 1.02, -0.26], [0.38, 1.02, 0.26], 0.012, 6),
    new THREE.SphereGeometry(0.085, 12, 8).scale(0.7, 1, 1).translate(0.5, 0.98, 0),
    rod([0.38, 1.02, 0.2], [0.34, 1.24, 0.3], 0.006, 4), rod([0.38, 1.02, -0.2], [0.34, 1.24, -0.3], 0.006, 4),
    new THREE.CylinderGeometry(0.055, 0.055, 0.012, 12).rotateZ(Math.PI / 2).translate(0.34, 1.26, 0.3), new THREE.CylinderGeometry(0.055, 0.055, 0.012, 12).rotateZ(Math.PI / 2).translate(0.34, 1.26, -0.3),
    new THREE.CylinderGeometry(0.04, 0.03, 0.46, 10).rotateZ(Math.PI / 2).translate(-0.62, 0.2, 0.2), rod([-0.1, 0.26, 0.1], [-0.16, 0, 0.2], 0.012, 5), rod([-0.1, 0.26, -0.1], [-0.16, 0, -0.2], 0.012, 5),
    softBox(0.3, 0.02, 0.26, 0.008, 1).translate(-0.86, 0.72, 0), rod([-0.74, 0.62, 0.11], [-0.86, 0.71, 0.11], 0.008, 4), rod([-0.74, 0.62, -0.11], [-0.86, 0.71, -0.11], 0.008, 4),
  ]), metals.brushed);
  scooter.position.set(11.25, 0, 7.1);
  scooter.rotation.y = 2.2;
  // The hire firm's sandwich board, stood just inside the bollards where the square can read it.
  const hireBoard = new THREE.Group(), boardLean = 0.2;
  for (const [geometry, material] of [
    [merge([softBox(0.56, 0.96, 0.02, 0.004, 1).rotateX(-boardLean).translate(0, 0.47, 0.1), softBox(0.56, 0.96, 0.02, 0.004, 1).rotateX(boardLean).translate(0, 0.47, -0.1), rod([-0.24, 0.3, 0.13], [-0.24, 0.3, -0.13], 0.006, 4), rod([0.24, 0.3, 0.13], [0.24, 0.3, -0.13], 0.006, 4)]), timberPlanks],
    [notice("hire", 0.5).rotateX(-boardLean).translate(0, 0.47 + 0.2 * Math.cos(boardLean) + 0.012 * Math.sin(boardLean), 0.1 - 0.2 * Math.sin(boardLean) + 0.012 * Math.cos(boardLean)), noticePaint],
  ] as Array<[THREE.BufferGeometry, THREE.Material]>) { const mesh = new THREE.Mesh(geometry, material); hireBoard.add(mesh); pending.push({ mesh, shadow: true, hit: false }); }
  hireBoard.position.set(10.5, 0, 5.2);
  hireBoard.rotation.y = -Math.PI / 2 - 0.12;

  // ---- Street lamps in the side square -------------------------------------
  const lampPost = merge([
    new THREE.LatheGeometry([[0.2, 0], [0.2, 0.08], [0.13, 0.14], [0.1, 0.6], [0.12, 0.66], [0.07, 0.72], [0.05, 2.9], [0.075, 2.94], [0.075, 3.0], [0.045, 3.04], [0.04, 3.5], [0, 3.5]].map(([r, y]) => new THREE.Vector2(r, y)), 12),
    rod([0, 3.42, 0], [0.62, 3.42, 0], 0.016), rod([0, 3.0, 0], [0.5, 3.4, 0], 0.012), new THREE.TorusGeometry(0.13, 0.011, 5, 14).translate(0.28, 3.28, 0),
    rod([0.62, 3.42, 0], [0.62, 3.3, 0], 0.01), new THREE.ConeGeometry(0.2, 0.14, 6).translate(0.62, 3.27, 0), box(0.2, 0.02, 0.2, 0.62, 2.88, 0), new THREE.SphereGeometry(0.03, 8, 6).translate(0.62, 3.36, 0),
    ...[-0.09, 0.09].flatMap((x) => [-0.09, 0.09].map((z) => rod([0.62 + x * 1.5, 3.2, z * 1.5], [0.62 + x, 2.88, z], 0.007, 4))),
  ]);
  const posts: Transform[] = [{ position: [11.0, 0, 12.4], rotation: [0, -0.4, 0] }, { position: [20.6, 0, 3.2], rotation: [0, 2.2, 0] }, { position: [24.5, 0, 12.8], rotation: [0, 2.9, 0] }];
  instances(lampPost, iron, posts, false);
  instances(new THREE.CylinderGeometry(0.125, 0.085, 0.3, 4).rotateY(Math.PI / 4), bulb, posts.map((post) => ({ position: [post.position[0] + Math.cos(post.rotation![1]) * 0.62, 3.04, post.position[2] - Math.sin(post.rotation![1]) * 0.62] as V3, rotation: post.rotation })), false, false);

  // ---- Bunting for the palio ------------------------------------------------
  // Pennants cut from the two awning cloths (a stripe, the ground or the accent of either), so they cost no draw of
  // their own and flutter with the awnings: from lamp to lamp along the garden wall, and out over the side square.
  const pennants: [THREE.BufferGeometry[], THREE.BufferGeometry[]] = [[], []], strings: THREE.BufferGeometry[] = [];
  // Where each colour lies on its striped sheet: cloth, u at the middle of the band, half the band's width.
  const pennantDyes: Array<[number, number, number]> = [[0, 0.0247, 0.011], [1, 0.108, 0.011], [0, 0.2442, 0.008], [1, 0.3105, 0.0018], [0, 0.4772, 0.0018]];
  let pennantCount = 0;
  const bunting = (from: V3, to: V3, sag: number) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), count = Math.floor(a.distanceTo(b) / 0.4);
    const point = (t: number) => a.clone().lerp(b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t));
    strings.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 13 }, (_, k) => point(k / 12))), 24, 0.006, 4));
    const along = new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
    for (let k = 1; k < count; k += 1, pennantCount += 1) {
      // Each hangs from the string by its top edge (v = 0, held) and tapers in three rows to a free point (v = 0.5).
      const p = point(k / count), [cloth, u, du] = pennantDyes[pennantCount % pennantDyes.length], turn = Math.sin(pennantCount * 12.9898) * 0.3;
      const hx = along.x * Math.cos(turn) - along.y * Math.sin(turn), hz = along.x * Math.sin(turn) + along.y * Math.cos(turn);
      const length = 0.3 + (pennantCount % 3) * 0.02, positions: number[] = [], uvs: number[] = [];
      const corner = (row: number, side: number) => {
        const w = 0.11 * (1 - row / 3) * side;
        positions.push(p.x + hx * w, p.y - length * row / 3, p.z + hz * w);
        uvs.push(u + du * side * (1 - row / 3), row / 6);
      };
      for (let row = 0; row < 3; row += 1) {
        corner(row, -1); corner(row + 1, -1); corner(row, 1);
        if (row < 2) { corner(row, 1); corner(row + 1, -1); corner(row + 1, 1); }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.computeVertexNormals();
      pennants[cloth].push(geometry);
    }
  };
  const standardTop = (index: number): V3 => [standards[index][0], standards[index][1] + 2.2, standards[index][2]];
  const postTop = (index: number): V3 => [posts[index].position[0], 3.3, posts[index].position[2]];
  bunting(standardTop(0), standardTop(1), 0.8);
  bunting(standardTop(1), standardTop(2), 0.6);
  bunting(standardTop(2), postTop(0), 0.5);
  bunting(standardTop(2), postTop(1), 0.55);
  bunting(postTop(1), postTop(2), 0.45);
  pennants.forEach((list, cloth) => place(new THREE.Mesh(merge(list), awningCloths[cloth]), 0, 0, 0, false));
  place(new THREE.Mesh(merge(strings), rubber), 0, 0, 0, false);

  // ---- Washing lines under the upper windows -------------------------------
  if (high) {
    type Dye = keyof typeof washDyes;
    const wash: Record<Dye, THREE.BufferGeometry[]> = { linen: [], blue: [], rust: [], ochre: [] }, rig: THREE.BufferGeometry[] = [];
    const X = UPPER + 0.52;
    /** A piece hanging from its top edge, cut into squares a hand wide so it can fold in the wind. */
    const cut = (w: number, h: number) => new THREE.PlaneGeometry(w, h, Math.max(2, Math.round(w / 0.11)), Math.max(2, Math.round(h / 0.11))).translate(0, -h / 2, 0);
    const hang = (dye: Dye, w: number, h: number, z: number, y: number, shirt = false) => {
      // A shirt is a body with a sleeve hanging off each shoulder.
      const geometry = shirt ? merge([cut(w * 0.6, h), ...[-1, 1].map((side) => cut(w * 0.24, h * 0.42).rotateZ(side * 0.5).translate(side * w * 0.36, -h * 0.02, 0))]) : cut(w, h);
      scaleUv(geometry, w * 1.6, h * 1.6);
      const p = geometry.attributes.position;
      for (let i = 0; i < p.count; i += 1) { const u = p.getX(i), v = -p.getY(i) / h; p.setZ(i, Math.sin(u * 8 + z * 3 + v * 2.2) * 0.05 * v + 0.05 * v * v); }
      geometry.computeVertexNormals();
      geometry.rotateY(Math.PI / 2);
      geometry.translate(X, y, z);
      wash[dye].push(geometry);
    };
    const line = (z0: number, z1: number, y: number, items: Array<[Dye, number, number, boolean?]>) => {
      const sagAt = (z: number) => y - 0.14 * 4 * ((z - z0) / (z1 - z0)) * (1 - (z - z0) / (z1 - z0));
      rig.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 9 }, (_, k) => { const z = z0 + (z1 - z0) * k / 8; return new THREE.Vector3(X, sagAt(z), z); })), 24, 0.006, 4));
      for (const z of [z0, z1]) rig.push(rod([UPPER, y, z], [X, y, z], 0.012, 5), rod([UPPER, y - 0.3, z], [X - 0.04, y - 0.02, z], 0.009, 5), new THREE.CylinderGeometry(0.04, 0.04, 0.02, 10).translate(X, y, z));
      let z = z0 + 0.3;
      for (const [dye, w, h, shirt] of items) { hang(dye, w, h, z + w / 2, sagAt(z + w / 2) + 0.005, shirt); z += w + 0.14 + (shirt ? 0.12 : 0); }
    };
    line(-10.6, -7.9, 8.75, [["linen", 1.3, 1.0], ["rust", 0.5, 0.75], ["blue", 0.5, 0.62, true]]);
    line(-6.7, -2.9, 8.75, [["blue", 0.52, 0.64, true], ["linen", 0.5, 0.6, true], ["ochre", 0.95, 0.7], ["linen", 0.45, 0.55], ["linen", 0.45, 0.55]]);
    line(4.4, 9.9, 8.75, [["rust", 1.2, 0.85], ["linen", 0.55, 0.66, true], ["linen", 1.5, 1.05], ["blue", 0.6, 0.5], ["ochre", 0.5, 0.7]]);
    place(new THREE.Mesh(merge(rig), iron), 0, 0, 0, false);
    for (const dye of Object.keys(wash) as Dye[]) place(new THREE.Mesh(merge(wash[dye]), washDyes[dye]), 0, 0, 0, true);
    // Pegged along the line and free below it: the sheets belly toward the wall and the shirts swing by their shoulders.
    life.cloth(linenBase, { amplitude: 0.09, pin: { height: 8.74, reach: 0.7 }, lean: 0.35 });
  }

  // ---- Roof aerials --------------------------------------------------------
  const aerial = merge([rod([0, 0, 0], [0, 2.4, 0], 0.022), rod([-0.55, 2.3, 0], [0.55, 2.3, 0], 0.012, 5), rod([0, 1.8, -0.22], [0, 1.8, 0.22], 0.008, 4),
    ...[-0.5, -0.3, -0.1, 0.1, 0.3, 0.5].map((x) => rod([x, 2.3, -0.3 + Math.abs(x) * 0.25], [x, 2.3, 0.3 - Math.abs(x) * 0.25], 0.008, 4))]);
  instances(aerial, iron, ([[5.5, 9.5, 13.4, 0.4], [-4.8, 9.5, 13.2, 1.9], [31, 10.9, -11.5, 0.2], [36, 12.5, -33, 1.2], [20, 9.5, -38.5, 2.2], [3, 14.2, -35.5, 0.7], [22, 8.5, 22, 0.3], [50, 9.6, 6, 1.1]] as number[][]).map(([x, y, z, turn]) => ({ position: [x, y, z] as V3, rotation: [0, turn, 0] as V3 })), false, false);

  // ---- Street furniture in the cobbles -------------------------------------
  // Stone gutter channels down both sides, still running with rain, with iron gullies; manhole covers in the open square.
  const wetStone = offMirror(new THREE.MeshStandardMaterial({ map: travertine.map, normalMap: travertine.normalMap, color: new THREE.Color(0.95, 0.93, 0.98), roughness: 0.2, metalness: 0, envMapIntensity: 1.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  for (const x of [-8.12, 8.12]) place(new THREE.Mesh(projectUv(new THREE.PlaneGeometry(0.46, 37.3).rotateX(-Math.PI / 2).translate(x, 0.004, -9.3), 0.92), wetStone), 0, 0, 0, false);
  const coverPaint = (context: CanvasRenderingContext2D, base: string, raised: string, groove: string) => {
    const disc = (x: number, y: number, r: number, fill: string) => { context.fillStyle = fill; context.beginPath(); context.arc(x, y, r, 0, Math.PI * 2); context.fill(); };
    context.fillStyle = base; context.fillRect(0, 0, 1024, 1024);
    disc(256, 256, 252, raised); disc(256, 256, 236, groove); disc(256, 256, 230, base); disc(256, 256, 226, raised); disc(256, 256, 214, base);
    context.strokeStyle = raised; context.lineWidth = 7;
    context.beginPath(); context.arc(256, 256, 150, 0, Math.PI * 2); context.stroke();
    context.fillStyle = raised;
    for (let gx = -6; gx <= 6; gx += 1) for (let gy = -6; gy <= 6; gy += 1) if (Math.hypot(gx, gy) * 21 < 132) { if ((gx + gy) % 2) context.fillRect(256 + gx * 21 - 8, 256 + gy * 21 - 3, 16, 6); else context.fillRect(256 + gx * 21 - 3, 256 + gy * 21 - 8, 6, 16); }
    context.font = "bold 40px 'Arial Narrow', Arial, sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
    // The legend runs right round, each letter given its own width so wide ones do not crowd their neighbours.
    const legend = [..."CASTEL WALLBANG  ·  VIETATO IL NOCLIP  ·  MCMXCIX  ·  "], widths = legend.map((glyph) => context.measureText(glyph).width);
    const tracking = (Math.PI * 2 * 182 - widths.reduce((sum, width) => sum + width, 0)) / legend.length;
    for (let i = 0, along = 0; i < legend.length; along += widths[i] + tracking, i += 1) { context.save(); context.translate(256, 256); context.rotate((along + widths[i] / 2) / 182); context.fillText(legend[i], 0, -182); context.restore(); }
    for (const x of [256 - 196, 256 + 196]) disc(x, 256, 9, groove);
    // Gully grate.
    context.fillStyle = raised; context.fillRect(512, 0, 512, 512);
    context.fillStyle = base; context.fillRect(536, 24, 464, 464);
    context.fillStyle = raised; context.fillRect(548, 36, 440, 440);
    context.fillStyle = groove;
    for (let i = 0; i < 7; i += 1) for (const y of [60, 268]) { context.beginPath(); context.roundRect(572 + i * 58, y, 30, 184, 14); context.fill(); }
  };
  const coverSet = reliefTextures(1024, (context) => {
    coverPaint(context, "#46423c", "#6c665c", "#0f0e0c");
    const rust = rng(57);
    for (let i = 0; i < 5000; i += 1) { context.fillStyle = `rgba(${90 + rust() * 60 | 0},${50 + rust() * 30 | 0},24,${0.03 + rust() * 0.08})`; context.fillRect(rust() * 1024, rust() * 512, 1 + rust() * 5, 1 + rust() * 5); }
  }, (context) => coverPaint(context, "#666", "#fff", "#000"), 3);
  track(coverSet.map); track(coverSet.normalMap);
  coverSet.map.anisotropy = coverSet.normalMap.anisotropy = anisotropy;
  const covers: THREE.BufferGeometry[] = [];
  for (const [x, z, turn] of [[1.9, -13.1, 0.4], [-2.7, 2.6, 1.9], [3.1, -25.2, 2.7]]) { const g = new THREE.CircleGeometry(0.43, 40); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 0.5, 0.5 + uv.getY(i) * 0.5); covers.push(g.rotateX(-Math.PI / 2).rotateY(turn).translate(x, 0.006, z)); }
  for (const x of [-8.12, 8.12]) for (const z of [-24.6, -12.4, -0.4, 7.6]) { const g = new THREE.PlaneGeometry(0.44, 0.44); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setXY(i, 0.5 + uv.getX(i) * 0.5, 0.5 + uv.getY(i) * 0.5); covers.push(g.rotateX(-Math.PI / 2).translate(x, 0.008, z + (x > 0 ? 1.3 : 0))); }
  place(new THREE.Mesh(merge(covers), offMirror(new THREE.MeshStandardMaterial({ ...coverSet, roughness: 0.5, metalness: 0.75, envMapIntensity: 1, normalScale: new THREE.Vector2(1.2, 1.2), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }))), 0, 0, 0, false);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 2.3);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xb4c8ee, 0xb08a5c, 1.7));
  const sun = kit.sunLight({ color: 0xffd2a0, intensity: 8, toSun: TO_KEY, extent: 36, distance: 62, near: 4, far: 136, radius: 2.2 });
  // Two warm fills stand in for the festoon; the bulbs themselves are emissive only.
  const fills = ([[-0.8, 6.2, -17.5], [0.6, 6.0, -1.5]] as V3[]).map((position) => {
    const light = new THREE.PointLight(0xffb062, 44, 26, 2);
    light.position.set(...position);
    scene.add(light);
    return light;
  });
  const arcadeLight = new THREE.PointLight(0xffa552, 16, 10, 2);
  arcadeLight.position.set(-12.2, 2.5, 5.05);
  scene.add(arcadeLight);

  // ---- Deliveries under the arcade, casks for standing at -------------------
  const FLOOR = 0.05, headOf = heightOf("cask") - 0.034, plasticH = heightOf("cratePlastic"), cartonH = heightOf("carton");
  dress(
    // Flour for the bakery: two sacks stood in the corner, a third dropped across their feet, the morning's cartons by the door.
    { kind: "sack", position: [-12.78, FLOOR, 0.84], rotation: [0, Math.PI / 2 - 0.1, 0] },
    { kind: "sack", position: [-12.2, FLOOR, 0.76], rotation: [0, 0.3, 0] },
    { kind: "sackLying", position: [-12.4, FLOOR, 1.5], rotation: [0, Math.PI / 2 + 0.2, 0] },
    { kind: "carton", position: [-12.83, FLOOR, 2.08], rotation: [0, Math.PI / 2 + 0.07, 0] },
    { kind: "carton", position: [-12.81, FLOOR + cartonH, 2.06], rotation: [0, Math.PI / 2 - 0.34, 0], scale: [0.64, 0.64, 0.64] },
    // Empties between the two doors: a crate of beer bottles on another, five of its pockets already bare.
    { kind: "cratePlastic", position: [-12.92, FLOOR, 3.45], rotation: [0, Math.PI / 2 + 0.05, 0] },
    ...carried([{ kind: "cratePlastic", position: [0, 0, 0] }, ...[0, 1, 3, 4, 6, 9, 10].map((pocket): Dressed => ({ kind: "bottleBeer", position: [-0.138 + (pocket % 4) * 0.092, 0.012, -0.092 + Math.floor(pocket / 4) * 0.092], rotation: [0, pocket * 1.7, 0] }))],
      [-12.91, FLOOR + plasticH, 3.46], new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2 - 0.12, 0))),
    // A cask by the café window and one out on the square against the pier, each with what was being drunk at it.
    { kind: "cask", position: [-12.76, FLOOR, 6.65], rotation: [0, 1.2, 0] },
    { kind: "bottleSpirits", position: [-12.8, FLOOR + headOf, 6.7], rotation: [0, 1.9, 0] }, { kind: "bottleWine", position: [-12.68, FLOOR + headOf, 6.58], rotation: [0, 0.8, 0] },
    { kind: "cask", position: [-9.21, 0, 3.45], rotation: [0, 2.5, 0], variant: 1 },
    { kind: "bottleWine", position: [-9.27, headOf, 3.5], rotation: [0, 1.1, 0] }, { kind: "bottleBeer", position: [-9.13, headOf, 3.53], rotation: [0, 2.6, 0] }, { kind: "jar", position: [-9.18, headOf, 3.36], rotation: [0, 1.9, 0], variant: 1 },
  );

  // Every kind in one batch. Only what stands out on the wet cobbles is worth a second drawing in the puddles:
  // fruit and glassware are too small to show there, the deliveries sit back under the arcade and the stall's crates behind the gate.
  const unmirrored = new Set<PropKind>(["sack", "sackLying", "carton", "cratePlastic", "crateSlat", "crateSmall", "crateProduce"]);
  for (const [kind, items] of dressing) {
    const small = props.get(kind).scale === "small";
    for (const mesh of props.place(kind, items)) {
      // Glass shells go down after the stains and puddle films they stand in front of.
      if ((mesh.material as THREE.Material).transparent) mesh.renderOrder = 1;
      if (small || unmirrored.has(kind)) kit.mirrorHidden.push(mesh);
    }
  }

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 320, x: 18, y: [0.3, 7], z: [-28, 8], color: 0xffdcae, opacity: 0.22 });

  const lit = sunlitFromBoxes(TO_KEY, [
    new THREE.Box3(new THREE.Vector3(RIGHT, 0, -30.4), new THREE.Vector3(25, BAND + 0.14, 0.3)),
    new THREE.Box3(new THREE.Vector3(-9.54, 0, 9.7), new THREE.Vector3(10.3, 7.9, 17)),
    new THREE.Box3(new THREE.Vector3(10.3, 0, 16.4), new THREE.Vector3(42, 7.4, 28)),
    new THREE.Box3(new THREE.Vector3(15.2, 3.4, 9.9), new THREE.Vector3(19.8, 7.6, 14.5)),
  ]);

  // ---- The life of the square ------------------------------------------------
  // Pigeons of the square: pecking by the café tables and out in the side square, along the garden wall, on the
  // fountain and the lowest roof. The perches are short so the flock gathers where it is seen. A shot puts them up;
  // they wheel over the lanes above the festoon and come back.
  const wallX = RIGHT + 0.45, wallTop = BAND + 0.14;
  life.birds("pigeon", {
    perches: [
      [-6.8, 0, 5.2], [-6.2, 0, 5.9], [-5.5, 0, 5.4], [-6.0, 0, 4.6],
      { from: [wallX, wallTop, -1.2], to: [wallX, wallTop, -0.5] }, { from: [wallX, wallTop, -8.25], to: [wallX, wallTop, -7.55] }, { from: [wallX, wallTop, -23.3], to: [wallX, wallTop, -22.8] },
      [LEFT + 0.1, 3.5, fountainZ], [LEFT + 0.36, 0.76, fountainZ - 0.91], [LEFT + 0.6, 0.76, fountainZ + 0.5],
      { from: [-9.1, 12.05, -9.0], to: [-9.1, 12.05, -8.3] },
      [16.6, 0, 5.2], [17.5, 0, 4.7], [18.2, 0, 5.4],
    ],
    count: 14,
    roam: { x: [-6.5, 7], y: [8.6, 12.5], z: [-22, -2] },
  });
  // The tower's own: on the hall ridge either side of the flagpole, on its eaves, on the tower's string courses and
  // the edge of its roof. The peal puts these up before any shot does.
  life.birds("pigeon", {
    perches: [
      { from: [-2.2, 14.7, -35.5], to: [-0.6, 14.7, -35.5] }, { from: [4.2, 14.7, -35.5], to: [6.2, 14.7, -35.5] },
      { from: [-5.6, 11.96, -30.1], to: [-4.4, 11.96, -30.1] },
      { from: [towerX - 1.6, 22.36, towerZ + 2.64], to: [towerX + 0.4, 22.36, towerZ + 2.64] }, { from: [towerX - 1.9, 17.36, towerZ + 2.64], to: [towerX - 0.9, 17.36, towerZ + 2.64] },
      { from: [towerX - 0.2, shaft + 5.17, towerZ + 3], to: [towerX + 1.2, shaft + 5.17, towerZ + 3] },
    ],
    count: 14,
    roam: { x: [-3, 12], y: [16, 23], z: [-33.5, -24] },
  });
  // Swifts hawking over the roofs, clear of the tower.
  life.soaring("swift", { centre: [-1.5, 0, -21], radius: 14.5, height: 21, count: 5 });
  // Leaves the gusts lift off the cobbles: across the apron behind the stations, down the middle of the range between
  // them, and all over the side square, where half of them come down out of the plane tree.
  life.drift("leaves", { volume: { x: [-8.6, 8.6], y: [0, 2.6], z: [-3.2, 8.4] }, count: 44 });
  life.drift("leaves", { volume: { x: [-8.6, 8.0], y: [0, 2.4], z: [-16.4, -9.8] }, count: 30 });
  life.drift("leaves", { volume: { x: [10.6, 24], y: [0, 5], z: [1.2, 15.8] }, count: 56, falling: 0.5 });
  // And what the bougainvillea sheds: the wind carries its bracts off the right-hand wall and in over the lanes.
  life.drift("petals", { volume: { x: [5.6, 9.3], y: [0, 4.4], z: [-19.6, -1.2] }, count: 40, falling: 0.7, colors: [0xc4306a, 0xd9588c, 0xa92458] });

  // ---- Moving water ----------------------------------------------------------
  // The fountain's jet with its spray and rings, and the last of the rain: beads that swell on the awning's hem and on
  // the festoon wires, fall into the running gutters and raise rings there. One mesh, one draw (see WATER_VERTEX).
  const RING = 0, DROP = 1, JET = 2, SPRAY = 3;
  type Quad = { at: V3; clock: [number, number, number, number]; motion: [number, number, number, number]; glint: number };
  const quads: Quad[] = [], spatter = rng(311);
  const spout: V3 = [LEFT + 0.455, 1.7, fountainZ], pool = 0.646, jetFall = Math.sqrt((spout[1] - pool) / 4.905), jetThrow = 0.13;
  const landing: V3 = [spout[0] + jetThrow * 0.8 * jetFall, pool, fountainZ];
  for (let i = 0; i < 10; i += 1) quads.push({ at: spout, clock: [JET, 1, 0, 0.014], motion: [i / 10, (i + 1) / 10, jetFall, jetThrow], glint: 1.25 });
  for (let i = 0; i < 4; i += 1) quads.push({ at: [landing[0], pool + 0.002 + i * 0.0005, landing[2]], clock: [RING, 1.9, i * 1.9 / 4, 0], motion: [1.9, 0.03, 0.3, 0.6], glint: 1.2 });
  for (let i = 0; i < 9; i += 1) {
    const angle = i * 2.4, out = 0.16 + 0.2 * spatter();
    quads.push({ at: landing, clock: [SPRAY, 0.34 + 0.2 * spatter(), spatter(), 0.011 + 0.008 * spatter()], motion: [Math.cos(angle) * out, 0.75 + 0.7 * spatter(), Math.sin(angle) * out, 0], glint: 1.3 });
  }
  // Each drip: where the bead hangs, seconds between drops, and how brightly the place is lit (the left gutter is in sun).
  const drips: Array<{ from: V3; every: number; glint: number }> = [
    { from: [LEFT + 1.52, 3.03, 3.8], every: 5.3, glint: 1.25 },
    { from: wireDrips[2], every: 7.3, glint: 0.6 },
    { from: wireDrips[1], every: 9.1, glint: 0.6 },
    { from: wireDrips[0], every: 11.3, glint: 1.25 },
  ];
  const GUTTER = 0.02;
  const dripClock = drips.map(({ from, every, glint }, index) => {
    const [x, y, z] = from, fall = Math.sqrt((y - GUTTER) / 4.905), start = 1.2 + index * 1.37;
    quads.push({ at: from, clock: [DROP, every, start, 0.028], motion: [y - GUTTER, 0.9, 0, 0], glint });
    for (let ring = 0; ring < 3; ring += 1) quads.push({ at: [x, GUTTER + ring * 0.0005, z], clock: [RING, every, start + fall + ring * 0.2, 0], motion: [1.5, 0.02, 0.2 - ring * 0.035, 0.75 - ring * 0.15], glint });
    for (let bead = 0; bead < 4; bead += 1) {
      const angle = bead * 1.7 + index, out = 0.12 + 0.2 * spatter();
      quads.push({ at: [x, GUTTER, z], clock: [SPRAY, every, start + fall, 0.011], motion: [Math.cos(angle) * out, 0.8 + 0.6 * spatter(), Math.sin(angle) * out, 0], glint });
    }
    return { x, z, every, lands: start + fall, heard: -1 };
  });
  const waterGeometry = track(new THREE.BufferGeometry());
  {
    const count = quads.length, position = new Float32Array(count * 12), corner = new Float32Array(count * 8), clock = new Float32Array(count * 16), motion = new Float32Array(count * 16), glint = new Float32Array(count * 4), index: number[] = [];
    quads.forEach((quad, q) => {
      for (let v = 0; v < 4; v += 1) {
        position.set(quad.at, (q * 4 + v) * 3);
        corner.set([v === 0 || v === 3 ? -1 : 1, v < 2 ? -1 : 1], (q * 4 + v) * 2);
        clock.set(quad.clock, (q * 4 + v) * 4);
        motion.set(quad.motion, (q * 4 + v) * 4);
        glint[q * 4 + v] = quad.glint;
      }
      index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    });
    waterGeometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    waterGeometry.setAttribute("corner", new THREE.BufferAttribute(corner, 2));
    waterGeometry.setAttribute("clock", new THREE.BufferAttribute(clock, 4));
    waterGeometry.setAttribute("motion", new THREE.BufferAttribute(motion, 4));
    waterGeometry.setAttribute("glint", new THREE.BufferAttribute(glint, 1));
    waterGeometry.setIndex(index);
  }
  const waterUniforms = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), waterTime: { value: 0 }, waterSurge: { value: 0 } };
  const waterMesh = new THREE.Mesh(waterGeometry, track(new THREE.ShaderMaterial({ vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT, uniforms: waterUniforms, transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide })));
  waterMesh.frustumCulled = false;
  waterMesh.renderOrder = 2;
  waterMesh.userData.walkThrough = true;
  scene.add(waterMesh);
  kit.mirrorHidden.push(waterMesh);
  kit.probeHidden.push(waterMesh);

  // ---- What happens, and what it sounds like ---------------------------------
  // Sounds are asked for at the place and moment something visibly happens; the positions come from a small ring of
  // vectors so nothing is allocated when one plays.
  const cuePlaces = Array.from({ length: 8 }, () => new THREE.Vector3()), cueVoice = { gain: 1, pitch: 1 };
  let cueTurn = 0;
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => {
    if (!options.cue) return;
    cueVoice.gain = gain; cueVoice.pitch = pitch;
    options.cue(name, cuePlaces[cueTurn = (cueTurn + 1) % cuePlaces.length].set(x, y, z), cueVoice);
  };
  const chance = rng(977), smooth = (x: number) => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * (3 - 2 * t); };
  // The peal is the square's event: the wheel chain is heard taking up, the bell rocks out through its arch higher
  // with every swing until the clapper finds it, tolls six to eight times and rocks back to rest. The first comes
  // a few seconds after the square is entered, the rest every minute or so.
  const PEAL = { swing: 3.3, takeUp: 1.4, rise: 4, reach: 0.95 };
  const peal = { at: 8, strokes: 7, heard: -2, rung: 0, nudged: -100 };
  // Crowns that sigh when a gust front reaches them: the side square's plane, the garden's, and a cypress by the wall.
  const crowns = [{ x: 17.5, y: 6, z: 12.2, was: 0 }, { x: 19, y: 10, z: -28.4, was: 0 }, { x: 12.2, y: 8, z: -4.6, was: 0 }];
  const fountainSurge = { at: -10, next: 4, heard: true };
  const catMind = { until: 0, watching: true, yaw: 0, pitch: 0, flinch: 0, flickAt: -10, flickNext: 3 };
  /** The cat ducks and lashes its tail. */
  const alarmCat = (strength: number) => { catMind.flinch = Math.max(catMind.flinch, strength); catMind.flickAt = clock.time; catMind.watching = true; catMind.until = clock.time + 6; };
  const clock = { origin: -1, time: 0 };
  kit.updates.push((now) => {
    if (clock.origin < 0) clock.origin = now;
    const time = (now - clock.origin) / 1000, dt = Math.min(0.1, Math.max(0, time - clock.time));
    clock.time = time;

    // Water: the clock the shader places every drop by, a surge of pressure in the fountain now and then, and each
    // drop heard as it lands.
    waterUniforms.waterTime.value = time;
    if (time > fountainSurge.next) { fountainSurge.at = time; fountainSurge.next = time + 7 + 6 * chance(); fountainSurge.heard = false; }
    const surged = time - fountainSurge.at;
    waterUniforms.waterSurge.value = surged < 2.8 ? smooth(surged / 0.35) * (1 - smooth((surged - 1) / 1.8)) : 0;
    if (!fountainSurge.heard && surged > 0.4) { fountainSurge.heard = true; say("splash", landing[0], landing[1], landing[2], 0.5, 0.9 + 0.25 * chance()); }
    for (let i = 0; i < dripClock.length; i += 1) {
      const drip = dripClock[i], landed = Math.floor((time - drip.lands) / drip.every);
      if (landed !== drip.heard) { drip.heard = landed; if (landed >= 0) say("drip", drip.x, GUTTER, drip.z, 0.75, 0.85 + 0.3 * ((landed * 0.618 + i * 0.37) % 1)); }
    }

    // The peal.
    let swing = 0;
    const since = time - peal.at;
    if (since >= 0) {
      if (peal.heard === -2) { peal.heard = -1; say("chainRattle", bell.position.x, bell.position.y - 2, bell.position.z, 1, 0.8); }
      const u = since - PEAL.takeUp;
      if (u > 0) {
        const last = PEAL.swing / 4 + peal.strokes * PEAL.swing / 2, risen = PEAL.reach * smooth(u / PEAL.rise);
        swing = -(u < last ? risen : PEAL.reach * Math.exp(-(u - last) / 2.4)) * Math.sin(Math.PI * 2 * u / PEAL.swing);
        // The clapper strikes at the top of each swing, once the bell is rocking high enough to reach it.
        const stroke = Math.floor((u - PEAL.swing / 4) / (PEAL.swing / 2));
        if (stroke !== peal.heard && stroke >= 1 && stroke <= peal.strokes) {
          peal.heard = stroke;
          say("bellToll", bell.position.x, bell.position.y - 0.8, bell.position.z, 0.55 + 0.45 * risen / PEAL.reach, stroke % 2 ? 1 : 0.965);
          if (stroke === 1) life.startle(bell.position, 0.36);
        }
        if (u > last + 9) { peal.rung += 1; peal.at = time + 30 + 30 * chance(); peal.strokes = 6 + peal.rung % 3; peal.heard = -2; }
      }
    }
    // A bullet rings it and leaves it rocking.
    const rocked = time - peal.nudged;
    if (rocked < 12) swing += 0.11 * Math.exp(-rocked / 2.5) * Math.sin(Math.PI * 2 * rocked / PEAL.swing);
    bell.rotation.x = swing;

    // Gust fronts reaching the trees.
    for (let i = 0; i < crowns.length; i += 1) {
      const crown = crowns[i], gust = wind.at(crown.x, crown.z);
      if (gust > 0.45 && crown.was <= 0.45) say("leafRustle", crown.x, crown.y, crown.z, Math.min(1, 0.35 + gust * 0.8), 0.9 + 0.25 * chance());
      crown.was = gust;
    }

    // The cat: mostly it watches the player, now and then something else takes its eye; its tail never quite stops.
    if (time > catMind.until) {
      catMind.watching = !catMind.watching || chance() < 0.35;
      catMind.until = time + (catMind.watching ? 4 + 6 * chance() : 1.2 + 1.6 * chance());
      if (!catMind.watching) { catMind.yaw = -1.1 + 2.3 * chance(); catMind.pitch = 0.45 * chance() - 0.05; }
    }
    if (catMind.watching) {
      // Its own frame is turned half round on the sill, so the way to the player is reversed in x and z.
      const dx = cat.position.x - catEye.x, dz = cat.position.z - catEye.z;
      catMind.yaw = THREE.MathUtils.clamp(Math.atan2(-dz, dx), -1.35, 1.35);
      catMind.pitch = THREE.MathUtils.clamp(Math.atan2(catEye.y - cat.position.y - 0.33, Math.hypot(dx, dz)), -0.3, 0.55);
    }
    const ease = 1 - Math.exp(-dt * (catMind.flinch > 0.2 ? 14 : 5));
    catPose.x += (catMind.yaw - catPose.x) * ease;
    catPose.y += (catMind.pitch - 0.5 * Math.min(1, catMind.flinch) - catPose.y) * ease;
    if (time > catMind.flickNext) { catMind.flickAt = time; catMind.flickNext = time + 2.5 + 5 * chance(); }
    const flicked = time - catMind.flickAt;
    catPose.z = 0.2 * Math.sin(time * 1.25) + 0.08 * Math.sin(time * 2.9 + 1.3);
    catPose.w = 0.35 * Math.sin(time * 1.25 - 0.9) + (flicked < 1.4 ? (1 + catMind.flinch) * Math.exp(-flicked * 3.5) * Math.sin(flicked * 16) : 0);
    catMind.flinch *= Math.exp(-dt * 2.2);
    catMood.value = Math.min(1, catMind.flinch);
  });

  flush();
  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    look: {
      sky: "/environment/tears_of_steel_bridge-2k.hdr", skyIntensity: 2.4, skyRotation: 0, skyClamp: 0.42,
      background: 0x8fa7c4, fog: 0xc9b8a2, fogDensity: high ? 0.0045 : 0.007,
      haze: new THREE.Color(0.05, 0.036, 0.022), hazeDensity: 0.0011, hazeCeiling: 7, hazeFade: 3,
      environmentIntensity: 1, exposure: 0.85, far: 220,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return {
    ...range,
    // A shot puts the birds up, and makes the cat duck if it is near enough to hear it as a shot.
    startle: (from, loudness) => {
      life.startle(from, loudness);
      if (loudness > 0.5 && from.distanceToSquared(cat.position) < 2500) alarmCat(1);
    },
    // A bullet rings the bell and scares the cat (it is quicker than that); birds and the loose shutter are the life kit's.
    struck: (object, point) => {
      if (object === bell) {
        if (clock.time - peal.nudged > 1.6) { peal.nudged = clock.time; say("bellToll", bell.position.x, bell.position.y - 0.8, bell.position.z, 0.7, 1.06); }
        return true;
      }
      if (object === cat) { alarmCat(1.5); return true; }
      return life.struck(object, point);
    },
  };
}

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial } from "../pbr";
import { createProps, type PlaceOptions, type PropItem, type PropKind } from "../props";
import type { Cue, CueName } from "../cues";
import { createLife } from "../life";
import { createTrees, type TreeItem } from "../trees";
import { createWind } from "../wind";
import {
  archedWall, canvasTexture, clothGeometry, createKit, projectUv, softBox, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";

// Dust Court: a walled desert courtyard under a midday sun.
//
// Lighting model: one hard sun, matched to the sky's own sun, falls through
// cloth awnings strung between the walls, so the ground is striped with shade
// and the dusty air shows the shafts between them. Bounce comes from a probe of
// the sunlit court itself, which is what turns the shade warm.

/** Direction to the sun in `goegap-2k.hdr`. */
const TO_SUN = new THREE.Vector3(0.535, 0.725, 0.433).normalize();
const WALL_X = 9.94;
const WALL_TOP = 5.2;

type V3 = [number, number, number];

/**
 * Woven stripes for the awnings, in sun-bleached brand colours. One tile is a 1.7 m run of stripes
 * (down the canvas, 1200 px per metre so the edges stay sharp from under the cloth) by 1.2 m of
 * weave (across it); everything drawn wraps, so the cloth can repeat it along the span.
 */
function stripeTexture(base: string, stripe: string, accent: string, seed = 91) {
  const W = 512, H = 2048;
  const texture = canvasTexture(W, H, (context) => {
    const random = rng(seed);
    context.fillStyle = base;
    context.fillRect(0, 0, W, H);
    const bands: Array<[number, number, string]> = [[144, 208, stripe], [464, 64, accent], [768, 352, stripe], [1264, 64, accent], [1504, 208, stripe], [1856, 80, accent]];
    for (const [y, height, colour] of bands) {
      context.fillStyle = colour; context.fillRect(0, y, W, height);
      // Selvedge threads either side of each dyed band.
      context.fillStyle = "rgba(40,28,14,.22)"; context.fillRect(0, y - 3, W, 3); context.fillRect(0, y + height, W, 3);
      context.fillStyle = "rgba(255,246,226,.2)"; context.fillRect(0, y + 5, W, 2); context.fillRect(0, y + height - 7, W, 2);
    }
    // Weave: weft picks across the canvas, warp ends down it, both a few threads wide.
    for (let y = 0; y < H; y += 4) { context.fillStyle = `rgba(0,0,0,${0.035 + random() * 0.05})`; context.fillRect(0, y, W, 2); }
    for (let x = 0; x < W; x += 4) { context.fillStyle = `rgba(255,250,236,${0.03 + random() * 0.05})`; context.fillRect(x, 0, 2, H); }
    // Slubs: short thick threads, light and dark.
    for (let i = 0; i < 2600; i += 1) {
      const light = random() < 0.5, x = random() * W, y = Math.floor(random() * H / 4) * 4, length = 6 + random() * 34;
      context.fillStyle = light ? `rgba(255,248,232,${0.05 + random() * 0.09})` : `rgba(30,20,10,${0.05 + random() * 0.08})`;
      context.fillRect(x, y, length, 2); if (x + length > W) context.fillRect(x - W, y, length, 2);
    }
    // A felled seam where two widths of cloth are joined, with its two rows of stitches.
    context.fillStyle = "rgba(30,20,10,.3)"; context.fillRect(0, 0, W, 5);
    context.fillStyle = "rgba(255,248,232,.16)"; context.fillRect(0, 5, W, 30);
    context.fillStyle = "rgba(30,20,10,.26)"; context.fillRect(0, 35, W, 3);
    context.fillStyle = "rgba(250,240,214,.75)";
    for (let x = 4; x < W; x += 16) { context.fillRect(x, 10, 9, 2); context.fillRect(x + 8, 27, 9, 2); }
  }, true);
  return texture;
}

/** Glazed tile frieze: eight-point stars on square tiles, 1.3 m by 0.65 m per repeat. */
function friezeTexture() {
  const S = 4, W = 256 * S, H = 128 * S;
  return canvasTexture(W, H, (context) => {
    const random = rng(57);
    context.fillStyle = "#e9e0cc";
    context.fillRect(0, 0, W, H);
    // Each quarter-tile is fired a slightly different shade.
    for (let x = 0; x < W; x += 64 * S) for (let y = 0; y < H; y += 64 * S) { context.fillStyle = `rgba(${random() < 0.5 ? "255,250,235" : "120,96,60"},${0.03 + random() * 0.07})`; context.fillRect(x, y, 64 * S, 64 * S); }
    context.save(); context.scale(S, S);
    for (let cell = 0; cell < 2; cell += 1) {
      const cx = 64 + cell * 128, cy = 64;
      context.fillStyle = "#1f6f6a";
      for (const turn of [0, Math.PI / 4]) {
        context.save(); context.translate(cx, cy); context.rotate(turn); context.fillRect(-36, -36, 72, 72); context.restore();
      }
      context.strokeStyle = "#17524f"; context.lineWidth = 1.6;
      for (const turn of [0, Math.PI / 4]) { context.save(); context.translate(cx, cy); context.rotate(turn); context.strokeRect(-31, -31, 62, 62); context.restore(); }
      context.fillStyle = "#e9e0cc";
      context.beginPath(); context.arc(cx, cy, 24, 0, Math.PI * 2); context.fill();
      context.strokeStyle = "#b9762a"; context.lineWidth = 1.2;
      context.beginPath(); context.arc(cx, cy, 20.5, 0, Math.PI * 2); context.stroke();
      context.fillStyle = "#d58a2e";
      context.save(); context.translate(cx, cy); context.rotate(Math.PI / 4); context.fillRect(-12, -12, 24, 24); context.restore();
      context.fillStyle = "#e9e0cc";
      context.beginPath(); context.arc(cx, cy, 4.5, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#1f6f6a";
      context.beginPath(); context.arc(cx + 64, cy - 64, 15, 0, Math.PI * 2); context.arc(cx + 64, cy + 64, 15, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#d58a2e";
      context.beginPath(); context.arc(cx + 64, cy - 64, 5, 0, Math.PI * 2); context.arc(cx + 64, cy + 64, 5, 0, Math.PI * 2); context.fill();
    }
    context.fillStyle = "#17524f";
    context.fillRect(0, 0, 256, 9); context.fillRect(0, 119, 256, 9);
    context.fillStyle = "#d58a2e";
    context.fillRect(0, 9, 256, 1.5); context.fillRect(0, 117.5, 256, 1.5);
    context.restore();
    // Glaze: pooled colour, pinholes and crazing, then the joints.
    for (let i = 0; i < 9000; i += 1) { context.fillStyle = `rgba(${random() < 0.6 ? "255,255,250" : "20,40,40"},${0.03 + random() * 0.06})`; context.fillRect(random() * W, random() * H, 1 + random() * 3, 1 + random() * 3); }
    context.strokeStyle = "rgba(70,60,44,.16)"; context.lineWidth = 1;
    for (let i = 0; i < 90; i += 1) {
      let x = random() * W, y = random() * H;
      context.beginPath(); context.moveTo(x, y);
      for (let step = 0; step < 5; step += 1) { x += (random() - 0.5) * 60; y += (random() - 0.5) * 60; context.lineTo(x, y); }
      context.stroke();
    }
    for (let x = 0; x <= W; x += 64 * S) {
      context.fillStyle = "rgba(74,60,40,.75)"; context.fillRect(x - 2.5, 0, 5, H);
      context.fillStyle = "rgba(255,250,236,.3)"; context.fillRect(x + 2.5, 0, 1.5, H);
    }
    context.fillStyle = "rgba(74,60,40,.75)"; context.fillRect(0, H / 2 - 2, W, 4);
    // Chipped corners where a tile has taken a knock.
    for (let i = 0; i < 9; i += 1) {
      const x = Math.round(random() * 4) * 64 * S + (random() - 0.5) * 20, y = Math.round(random() * 2) * 64 * S + (random() - 0.5) * 20;
      context.fillStyle = "#b9a37c"; context.beginPath(); context.moveTo(x, y);
      for (let k = 0; k < 6; k += 1) { const a = (k / 6) * Math.PI * 2; context.lineTo(x + Math.cos(a) * (6 + random() * 16), y + Math.sin(a) * (5 + random() * 12)); }
      context.closePath(); context.fill();
    }
  }, true);
}

/** A piece of washing pegged to a line: `at` is the middle of its pegged edge, which runs along local x turned by `yaw`. */
type Wash = { at: V3; yaw: number; kind: "sheet" | "tunic" | "trousers"; width: number; drop: number; colour: number; stripe?: number };

/**
 * All the washing of the map as one mesh. Each piece is a fine grid cut to its outline, with uv.y = 1 on
 * the pegged edge and 0 at the hem (the wind holds it by that) and its dye in the vertex colours.
 */
function washingGeometry(items: Wash[], seed: number) {
  const random = rng(seed);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colours: number[] = [], index: number[] = [];
  const dye = new THREE.Color(), band = new THREE.Color();
  for (const { at, yaw, kind, width, drop, colour, stripe } of items) {
    const cols = Math.max(2, Math.round(width / 0.09)), rows = Math.max(3, Math.round(drop / 0.09));
    const cos = Math.cos(yaw), sin = Math.sin(yaw), phase = random() * 6.28, fade = 0.9 + random() * 0.14, every = 3 + Math.floor(random() * 2);
    dye.set(colour).multiplyScalar(fade);
    if (stripe !== undefined) band.set(stripe).multiplyScalar(fade);
    // A tunic is pegged by its spread sleeves, trousers by the waistband.
    const inside = (u: number, v: number) => kind === "sheet" || (kind === "tunic"
      ? (v < 0.3 || Math.abs(u - 0.5) < 0.27) && !(v < 0.07 && Math.abs(u - 0.5) < 0.08)
      : v < 0.2 || Math.abs(u - 0.5) > 0.06);
    const base = positions.length / 3;
    for (let j = 0; j <= rows; j += 1) for (let i = 0; i <= cols; i += 1) {
      const u = i / cols, v = j / rows, x = (u - 0.5) * width, z = Math.sin(u * 5 + phase) * 0.035 * v;
      positions.push(at[0] + x * cos + z * sin, at[1] - v * drop, at[2] - x * sin + z * cos);
      normals.push(sin, 0, cos);
      uvs.push(u, 1 - v);
      const tone = stripe !== undefined && j % every === 1 ? band : dye, shade = 1 - 0.1 * v;
      colours.push(tone.r * shade, tone.g * shade, tone.b * shade);
    }
    for (let j = 0; j < rows; j += 1) for (let i = 0; i < cols; i += 1) {
      if (!inside((i + 0.5) / cols, (j + 0.5) / rows)) continue;
      const a = base + j * (cols + 1) + i, b = a + 1, c = a + cols + 1;
      index.push(a, c, b, b, c, c + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(index);
  return geometry;
}

// ---- Geometry helpers ------------------------------------------------------

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

function xf(at: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 | number = 1) {
  const s: V3 = typeof scale === "number" ? [scale, scale, scale] : scale;
  return new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...s));
}

/** Non-indexed copy holding only position, normal and uv, so any two pieces can be merged. */
function plain(geometry: THREE.BufferGeometry) {
  const copy = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of Object.keys(copy.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") copy.deleteAttribute(name);
  if (!copy.attributes.normal) copy.computeVertexNormals();
  if (!copy.attributes.uv) copy.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(copy.attributes.position.count * 2), 2));
  copy.clearGroups();
  return copy;
}

function merge(parts: THREE.BufferGeometry[]) {
  const flat = parts.map(plain);
  const merged = mergeGeometries(flat);
  flat.forEach((part) => part.dispose());
  return merged;
}

/** Box-projected UVs with the texture's long axis turned to run up the piece when `vertical`. */
function grain<T extends THREE.BufferGeometry>(geometry: T, metres: number, vertical = false, ou = 0, ov = 0): T {
  projectUv(geometry, metres);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) {
    const u = uv.getX(i), v = uv.getY(i);
    if (vertical) uv.setXY(i, v + ou, u + ov); else uv.setXY(i, u + ou, v + ov);
  }
  return geometry;
}

/** Scales a geometry's own UVs (lathes, cylinders, tubes). */
function uvScale<T extends THREE.BufferGeometry>(geometry: T, su: number, sv: number, swap = false): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) {
    const u = uv.getX(i) * su, v = uv.getY(i) * sv;
    if (swap) uv.setXY(i, v, u); else uv.setXY(i, u, v);
  }
  return geometry;
}

/** Round bar between two points. */
function rod(a: V3, b: V3, radius: number, sides = 6, radiusB = radius) {
  const from = new THREE.Vector3(...a), dir = new THREE.Vector3(...b).sub(from), length = dir.length();
  const geometry = new THREE.CylinderGeometry(radiusB, radius, length, sides, 1);
  uvScale(geometry, length / 1.8, sides * radius * 1.2, true);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.normalize()));
  geometry.translate(from.x + dir.x * length / 2, from.y + dir.y * length / 2, from.z + dir.z * length / 2);
  return geometry;
}

/** Smooth tube through points. */
function pipe(points: V3[], radius: number, sides = 6, segments = points.length * 5) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), segments, radius, sides, false);
}

/** Rope or wire hung between two points. */
function cable(a: V3, b: V3, sag: number, radius: number, segments = 14, sides = 5) {
  const points: V3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  return pipe(points, radius, sides, segments);
}

function lathe(profile: number[][], segments = 24, scale = 1) {
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x * scale, y * scale)), segments);
}

/** Moulded surround for a round-headed opening, standing in the XY plane and proud along +z. */
function archFrame(width: number, spring: number, band: number, depth: number, sill?: number) {
  const half = width / 2, outer = half + band;
  const shape = new THREE.Shape();
  if (sill === undefined) {
    shape.moveTo(-outer, 0); shape.lineTo(-outer, spring); shape.absarc(0, spring, outer, Math.PI, 0, true); shape.lineTo(outer, 0);
    shape.lineTo(half, 0); shape.lineTo(half, spring); shape.absarc(0, spring, half, 0, Math.PI, false); shape.lineTo(-half, 0);
    shape.closePath();
  } else {
    shape.moveTo(-outer, sill - band * 0.6); shape.lineTo(-outer, spring); shape.absarc(0, spring, outer, Math.PI, 0, true); shape.lineTo(outer, sill - band * 0.6);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-half, sill); hole.lineTo(-half, spring); hole.absarc(0, spring, half, Math.PI, 0, true); hole.lineTo(half, sill);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 2, curveSegments: 14 });
  return projectUv(geometry, 3);
}

/** Louvred timber shutter leaf centred on the origin, facing +z. */
function shutterGeometry(width: number, height: number, slats: number) {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, tilt = 0) => {
    const part = new THREE.BoxGeometry(w, h, d);
    if (tilt) part.rotateX(tilt);
    part.translate(x, y, 0);
    parts.push(grain(part, 1.8, h > w, x * 0.37, y * 0.21));
  };
  for (const side of [-1, 1]) box(0.06, height, 0.045, side * (width / 2 - 0.03), 0);
  for (const y of [-height / 2 + 0.04, 0, height / 2 - 0.04]) box(width - 0.12, 0.08, 0.045, 0, y);
  const run = (height - 0.16) / slats;
  for (let i = 0; i < slats; i += 1) {
    const y = -height / 2 + 0.08 + (i + 0.5) * run;
    if (Math.abs(y) < 0.06) continue;
    box(width - 0.12, 0.012, Math.min(0.06, run * 1.25), 0, y, 0.6);
  }
  return merge(parts);
}

/** Wrought iron window grille in the XY plane; `belly` bows the bars outward along +z. */
function grilleGeometry(width: number, height: number, belly = 0) {
  const parts: THREE.BufferGeometry[] = [];
  const bars = Math.max(3, Math.round(width / 0.13));
  for (let i = 0; i <= bars; i += 1) {
    const x = -width / 2 + (i / bars) * width;
    if (belly > 0) parts.push(pipe([[x, 0, 0], [x, 0.06, belly * 0.8], [x, height * 0.3, belly], [x, height - 0.12, belly * 0.35], [x, height, 0]], 0.009, 5, 14));
    else parts.push(rod([x, 0, 0], [x, height, 0], 0.01, 5));
  }
  for (const t of belly > 0 ? [0.08, 0.36, 0.7] : [0.14, 0.5, 0.86]) {
    const z = belly > 0 ? (t < 0.2 ? belly * 0.86 : t < 0.5 ? belly * 0.98 : belly * 0.58) : 0;
    const flat = new THREE.BoxGeometry(width + 0.03, 0.026, 0.008);
    flat.translate(0, t * height, z + 0.008);
    parts.push(flat);
    if (belly > 0) for (const side of [-1, 1]) parts.push(rod([side * width / 2, t * height, 0], [side * width / 2, t * height, z], 0.008, 5));
  }
  return merge(parts);
}

/** Cloth hung over a wall top: runs back along -z for `over`, turns the edge, then drops `hang`. */
function drapeGeometry(width: number, over: number, hang: number, wave = 0.02) {
  const length = over + hang, rows = 22;
  const geometry = new THREE.PlaneGeometry(width, length, 6, rows);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), along = length / 2 - position.getY(i);
    if (along <= over) position.setXYZ(i, x, 0, -(over - along));
    else {
      const down = along - over;
      position.setXYZ(i, x, -down, 0.012 + Math.sin(x * 5.2 + down * 2.4) * wave * Math.min(1, down * 1.6));
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A shallow thrown dish for the lamp niches: the one piece of pottery the shared props library has no kind for. */
const DISH = [[0, 0], [0.12, 0], [0.14, 0.02], [0.3, 0.16], [0.36, 0.24], [0.375, 0.262], [0.35, 0.26], [0.28, 0.17], [0.1, 0.05], [0, 0.05]];

/** Spoked cart wheel in the XY plane: timber part and iron part. */
function wheelGeometry(radius: number, spokes: number) {
  const timberParts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(radius - 0.05, 0.045, 8, 36)];
  const hub = new THREE.CylinderGeometry(0.09, 0.11, 0.24, 14);
  hub.rotateX(Math.PI / 2);
  timberParts.push(hub);
  for (let i = 0; i < spokes; i += 1) {
    const a = (i / spokes) * Math.PI * 2;
    timberParts.push(rod([Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0], [Math.cos(a) * (radius - 0.07), Math.sin(a) * (radius - 0.07), 0], 0.026, 6, 0.02));
  }
  const tyre = new THREE.TorusGeometry(radius, 0.022, 6, 36);
  tyre.scale(1, 1, 2.2);
  const cap = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 10);
  cap.rotateX(Math.PI / 2);
  return { timber: merge(timberParts), iron: merge([tyre, cap]) };
}

/**
 * Awning cloth with a scalloped, bound valance on both long edges. UVs are in metres so a weave
 * normal map tiles finely; `run` is the length of one repeat of the stripes and `binding` the
 * place in that repeat (0..1) whose colour edges the scallops. Vertex colours carry what a tiling
 * weave cannot: sun-bleach, dust in the belly and grime where the cloth is lashed to its battens.
 * `cell` is the size of one square of its mesh.
 */
function awningGeometry(width: number, depth: number, sag: number, tile: number, run: number, binding: number, seed: number, cell: number) {
  const ripple = 0.03, phase = rng(seed)() * 6.28;
  const height = (u: number, v: number) => -sag * (1 - u * u) * (1 - 0.25 * v * v) + Math.sin(u * 9 + v * 4) * ripple * (1 - u * u);
  const tone = (u: number, v: number, hang = 0) => {
    const wear = 0.9 + 0.07 * Math.sin(u * 5.3 + v * 2.1 + phase) + 0.05 * Math.sin(u * 13.1 - v * 4.7 + phase * 2);
    const lashed = 1 - 0.24 * Math.max(0, (Math.abs(u) - 0.78) / 0.22) ** 2;
    const belly = 1 - 0.1 * (1 - u * u) * (1 - v * v);
    return wear * lashed * belly * (1 - hang * 0.16);
  };
  // Fine enough for the ripples the wind sends through it.
  const top = new THREE.PlaneGeometry(width, depth, Math.round(width / cell), Math.round(depth / cell));
  top.rotateX(-Math.PI / 2);
  const position = top.attributes.position, uv = top.attributes.uv, shade = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), z = position.getZ(i), u = x / (width / 2), v = z / (depth / 2), k = tone(u, v);
    position.setY(i, height(u, v));
    uv.setXY(i, x / tile, -z / tile);
    shade.set([k, k * 0.98, k * 0.93], i * 3);
  }
  top.setAttribute("color", new THREE.BufferAttribute(shade, 3));
  top.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [top];
  const scallops = Math.round(width / 0.55), steps = scallops * 8, edge = 0.03;
  for (const end of [-1, 1]) {
    const vertices: number[] = [], uvs: number[] = [], colours: number[] = [], index: number[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = -width / 2 + (i / steps) * width, u = x / (width / 2), y = height(u, end), z = end * depth / 2;
      const drop = 0.17 + 0.16 * Math.abs(Math.sin((i / 8) * Math.PI)) ** 0.8;
      // The valance hangs plumb and billows a little along its length.
      const billow = end * 0.03 * Math.sin(x * 2.3 + phase) * (1 - u * u * 0.6);
      vertices.push(x, y, z, x, y - drop + edge, z + billow * 0.85, x, y - drop + edge, z + billow * 0.85, x, y - drop, z + billow);
      const k = tone(u, end), low = tone(u, end, 1);
      colours.push(k, k * 0.98, k * 0.93, low, low * 0.97, low * 0.9, low, low * 0.97, low * 0.9, low * 0.94, low * 0.9, low * 0.84);
      uvs.push(x / tile, -z / tile, x / tile, -(z + end * (drop - edge)) / tile, x / tile, binding * run / tile, x / tile, (binding * run + edge) / tile);
      if (i < steps) for (const row of [0, 2]) { const a = i * 4 + row, b = a + 4; index.push(a, a + 1, b, a + 1, b + 1, b); }
    }
    const strip = new THREE.BufferGeometry();
    strip.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    strip.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    strip.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    strip.setIndex(index);
    strip.computeVertexNormals();
    // The valance folds down from the cloth: its top row takes the cloth's own normal there, so that in the
    // wind (which moves each point along its normal) the fold stays closed.
    const normal = strip.attributes.normal, fold = new THREE.Vector3();
    for (let i = 0; i <= steps; i += 1) {
      const u = -1 + (i / steps) * 2, e = 0.02;
      fold.set(-(height(u + e, end) - height(u - e, end)) / (e * width), 1, -end * (height(u, end) - height(u, end * (1 - e))) / (e * depth / 2)).normalize();
      normal.setXYZ(i * 4, fold.x, fold.y, fold.z);
    }
    parts.push(strip);
  }
  const geometry = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  return { geometry, height };
}

/** Height of the setts above the sand. */
const KERB = 0.035;

/**
 * Strip of paving along a wall foot with a broken inner edge; x runs along the wall, -z is toward the court.
 * It comes about `depth` out from the wall: one sett less where a course is missing, up to three more elsewhere.
 */
function pavingStrip(from: number, to: number, seed: number, depth: number) {
  const random = rng(seed), shape = new THREE.Shape(), runs: number[][] = [];
  // The edge steps in and out by whole setts, a few courses at a time. Neighbouring runs of one depth are joined:
  // points in a row along the edge would triangulate into slivers with no normal, and those shade as NaN.
  for (let x = to; x > from; x -= 0.22 + random() * 0.3) {
    const out = depth + (Math.floor(random() * 4) - (random() < 0.12 ? 1 : 0)) * 0.1;
    if (runs[runs.length - 1]?.[1] !== out) runs.push([x, out]);
  }
  shape.moveTo(from, 0); shape.lineTo(to, 0);
  runs.forEach(([start, out], index) => {
    if (index) shape.lineTo(start, runs[index - 1][1]);
    shape.lineTo(start, out);
  });
  shape.lineTo(from, runs[runs.length - 1][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: KERB, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  /** How far out the setts come at a point along the strip; a step in the edge counts as the shallower side. */
  const reach = (at: number) => {
    if (at > to || at < from) return 0;
    let out = Infinity;
    runs.forEach(([start, run], index) => { if (at <= start + 0.01 && at >= (runs[index + 1]?.[0] ?? from) - 0.01) out = Math.min(out, run); });
    return out === Infinity ? 0 : out;
  };
  return { geometry: projectUv(geometry, 1.7), reach };
}

/** Lime plaster skirt, eaten away from the ground up in places to show the brick behind. */
function skirtShape(from: number, to: number, top: number, seed: number) {
  const random = rng(seed);
  const shape = new THREE.Shape();
  shape.moveTo(from, top); shape.lineTo(from, 0);
  let x = from + 0.25 + random() * 1.2;
  while (x < to - 1.3) {
    // One bite: a ragged arch, wider than it is tall.
    const width = 0.35 + random() * 0.9, rise = Math.min(top - 0.22, 0.14 + random() * random() * 0.6), steps = 7 + Math.floor(width * 6);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps, edge = Math.sin(Math.PI * t) ** 0.7 * rise * (0.75 + random() * 0.4);
      shape.lineTo(x + width * t + (i > 0 && i < steps ? (random() - 0.5) * 0.03 : 0), i === 0 || i === steps ? 0 : Math.max(0.03, edge));
    }
    x += width + 0.5 + random() * 2.6;
  }
  shape.lineTo(to, 0); shape.lineTo(to, top);
  shape.closePath();
  return shape;
}

/** A place where the render has blown off a wall: centre and size on the wall face. */
type Scar = { x: number; y: number; radius: number; seed: number };

/**
 * `archedWall` with ragged holes through the plaster as well. The holes are real openings, so the
 * brick set a few centimetres behind them sits in a true recess with a broken plaster edge.
 */
function scarredWall(width: number, height: number, thickness: number, openings: Array<{ x: number; width: number; spring: number; sill?: number }>, scars: Scar[], metres: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  for (const opening of [...openings].filter((o) => o.sill === undefined).sort((p, q) => p.x - q.x)) {
    const half = opening.width / 2;
    shape.lineTo(opening.x - half, 0);
    shape.lineTo(opening.x - half, opening.spring);
    shape.absarc(opening.x, opening.spring, half, Math.PI, 0, true);
    shape.lineTo(opening.x + half, 0);
  }
  shape.lineTo(width / 2, 0); shape.lineTo(width / 2, height); shape.lineTo(-width / 2, height); shape.closePath();
  for (const opening of openings) {
    if (opening.sill === undefined) continue;
    const half = opening.width / 2, hole = new THREE.Path();
    hole.moveTo(opening.x - half, opening.sill);
    hole.lineTo(opening.x - half, opening.spring);
    hole.absarc(opening.x, opening.spring, half, Math.PI, 0, true);
    hole.lineTo(opening.x + half, opening.sill);
    hole.closePath();
    shape.holes.push(hole);
  }
  for (const scar of scars) {
    const random = rng(scar.seed), hole = new THREE.Path(), points = 17;
    let reach = 0.85;
    for (let i = 0; i < points; i += 1) {
      const a = (i / points) * Math.PI * 2;
      reach = THREE.MathUtils.clamp(reach + (random() - 0.5) * 0.5, 0.55, 1.15);
      const px = scar.x + Math.cos(a) * scar.radius * reach * 1.45, py = scar.y + Math.sin(a) * scar.radius * reach;
      if (i === 0) hole.moveTo(px, py); else hole.lineTo(px, py);
    }
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 14 });
  geometry.translate(0, 0, -thickness / 2);
  return projectUv(geometry, metres);
}

/** Knotted pile rug: borders, medallions and fringe. */
function rugTexture(colours: { field: string; border: string; line: string; a: string; b: string }, medallions: number) {
  const texture = canvasTexture(1024, 2048, (context) => {
    const W = 1024, H = 2048;
    context.fillStyle = "#d8c9a4"; context.fillRect(0, 0, W, H);
    // Fringe at both ends.
    context.strokeStyle = "#cdbd95"; context.lineWidth = 3;
    for (let x = 6; x < W; x += 9) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x + ((x * 7) % 5) - 2, 58); context.stroke();
      context.beginPath(); context.moveTo(x, H); context.lineTo(x + ((x * 5) % 5) - 2, H - 58); context.stroke();
    }
    context.fillStyle = colours.border; context.fillRect(0, 56, W, H - 112);
    // Running border of hooked diamonds.
    const diamond = (cx: number, cy: number, r: number, fill: string) => { context.fillStyle = fill; context.beginPath(); context.moveTo(cx, cy - r); context.lineTo(cx + r, cy); context.lineTo(cx, cy + r); context.lineTo(cx - r, cy); context.closePath(); context.fill(); };
    for (let y = 104; y < H - 80; y += 64) for (const x of [50, W - 50]) { diamond(x, y, 26, colours.a); diamond(x, y, 13, colours.line); }
    for (let x = 114; x < W - 80; x += 64) for (const y of [106, H - 106]) { diamond(x, y, 26, colours.b); diamond(x, y, 13, colours.line); }
    context.fillStyle = colours.line; context.fillRect(92, 148, W - 184, H - 296);
    context.fillStyle = colours.field; context.fillRect(104, 160, W - 208, H - 320);
    // Small repeat in the field.
    for (let y = 196; y < H - 180; y += 56) for (let x = 140 + ((y / 56) % 2) * 28; x < W - 130; x += 56) diamond(x, y, 7, colours.border);
    // Stepped medallions down the middle.
    const span = (H - 420) / medallions;
    for (let i = 0; i < medallions; i += 1) {
      const cy = 210 + span * (i + 0.5), r = Math.min(310, span * 0.46);
      for (let step = 0; step < 6; step += 1) diamond(W / 2, cy, r * (1 - step * 0.16), [colours.line, colours.a, colours.line, colours.b, colours.border, colours.line][step]);
      for (const side of [-1, 1]) { diamond(W / 2 + side * r * 0.9, cy, 34, colours.b); diamond(W / 2 + side * r * 0.9, cy, 16, colours.line); }
    }
    // Pile: fine knots, wear and fade.
    const random = rng(medallions * 97 + 5);
    for (let i = 0; i < 52000; i += 1) {
      const shade = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},${0.03 + random() * 0.05})`;
      context.fillRect(random() * W, random() * H, 2, 3);
    }
    for (let i = 0; i < 26; i += 1) {
      const x = random() * W, y = random() * H, r = 60 + random() * 160;
      const wear = context.createRadialGradient(x, y, 0, x, y, r);
      wear.addColorStop(0, "rgba(214,196,160,.2)"); wear.addColorStop(1, "rgba(214,196,160,0)");
      context.fillStyle = wear; context.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  return texture;
}

/** Rain and rust streaks under a spout. */
function stainTexture() {
  const W = 256, H = 1024;
  const texture = canvasTexture(W, H, (context) => {
    context.clearRect(0, 0, W, H);
    const random = rng(7);
    // Each run is laid down as nested, fainter-to-stronger bands so its edges are soft.
    for (let i = 0; i < 46; i += 1) {
      const x = W / 2 + (random() - 0.5) * 150 * (0.25 + random()), length = 260 + random() * 740, width = 5 + random() * 26, strength = 0.07 + random() * 0.1;
      const rust = random() < 0.25 ? "92,52,24" : "58,40,24";
      for (const [scale, part] of [[1, 0.35], [0.66, 0.35], [0.36, 0.5]]) {
        const streak = context.createLinearGradient(0, 0, 0, length * (0.7 + scale * 0.3));
        streak.addColorStop(0, `rgba(${rust},${strength * part * 2.4})`); streak.addColorStop(0.5, `rgba(${rust},${strength * part * 1.2})`); streak.addColorStop(1, `rgba(${rust},0)`);
        context.fillStyle = streak; context.fillRect(x - width * scale / 2, 0, width * scale, length);
      }
    }
    // Pale lime bloom between the dark runs.
    for (let i = 0; i < 12; i += 1) {
      const x = W / 2 + (random() - 0.5) * 120, length = 200 + random() * 500, width = 4 + random() * 10;
      const bloom = context.createLinearGradient(0, 0, 0, length);
      bloom.addColorStop(0, "rgba(240,230,205,.16)"); bloom.addColorStop(1, "rgba(240,230,205,0)");
      context.fillStyle = bloom; context.fillRect(x - width / 2, 0, width, length);
    }
    // Fade the sides so the card has no edge.
    context.globalCompositeOperation = "destination-out";
    for (const side of [0, 1]) {
      const fade = context.createLinearGradient(side ? W : 0, 0, side ? W - 46 : 46, 0);
      fade.addColorStop(0, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = fade; context.fillRect(side ? W - 46 : 0, 0, 46, H);
    }
    context.globalCompositeOperation = "source-over";
  });
  texture.anisotropy = 8;
  return texture;
}

type Ink = CanvasRenderingContext2D;
const SERIF = "Georgia, 'Times New Roman', serif";
const STENCIL = "'Arial Black', Impact, 'Helvetica Neue', Arial, sans-serif";

/** Sets the largest font of this style, up to `size` px, at which `text` is no wider than `room`; returns its size. */
function fitFont(context: Ink, text: string, room: number, size: number, style = "bold", family = SERIF) {
  let px = size;
  for (; px > 10; px -= 2) { context.font = `${style} ${px}px ${family}`; if (context.measureText(text).width <= room) break; }
  return px;
}

/** Sign-writer's lettering: the words once as a cast shadow, then in colour. */
function lettered(context: Ink, text: string, x: number, y: number, colour: string, drop = 0, shadow = "rgba(4,18,18,.7)") {
  if (drop) { context.fillStyle = shadow; context.fillText(text, x + drop, y + drop); }
  context.fillStyle = colour; context.fillText(text, x, y);
}

// Trade marks, drawn about the origin in the current fill and stroke colour, about 150 px tall.
function wheatMark(context: Ink) {
  context.lineWidth = 6; context.lineCap = "round";
  context.beginPath(); context.moveTo(0, 80); context.quadraticCurveTo(7, 10, 0, -56); context.stroke();
  for (let i = 0; i < 5; i += 1) for (const side of [-1, 1]) {
    context.save(); context.translate(side * 15, 32 - i * 21); context.rotate(side * 0.55);
    context.beginPath(); context.ellipse(0, 0, 9, 19, 0, 0, Math.PI * 2); context.fill(); context.restore();
  }
  context.beginPath(); context.ellipse(0, -70, 9, 19, 0, 0, Math.PI * 2); context.fill();
}
function doorMark(context: Ink, ground: string) {
  context.beginPath(); context.moveTo(-48, 76); context.lineTo(-48, -18); context.arc(0, -18, 48, Math.PI, 0); context.lineTo(48, 76); context.closePath(); context.fill();
  context.save(); context.strokeStyle = ground; context.fillStyle = ground; context.lineWidth = 5;
  for (const x of [-16, 16]) { context.beginPath(); context.moveTo(x, 76); context.lineTo(x, -62); context.stroke(); }
  for (const y of [-6, 48]) context.fillRect(-48, y, 96, 5);
  context.beginPath(); context.arc(30, 24, 7, 0, Math.PI * 2); context.fill(); context.restore();
}
function teapotMark(context: Ink) {
  context.beginPath(); context.ellipse(0, 22, 62, 50, 0, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.moveTo(-36, -16); context.quadraticCurveTo(0, -66, 36, -16); context.closePath(); context.fill();
  context.beginPath(); context.arc(0, -50, 9, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.moveTo(50, 28); context.quadraticCurveTo(94, 18, 98, -36); context.lineTo(116, -32); context.quadraticCurveTo(112, 46, 54, 58); context.closePath(); context.fill();
  context.lineWidth = 12; context.beginPath(); context.arc(-66, 14, 34, Math.PI * 0.45, Math.PI * 1.55); context.stroke();
  context.fillRect(-40, 68, 80, 10);
}
function scissorsMark(context: Ink) {
  for (const side of [-1, 1]) {
    context.save(); context.rotate(side * 0.42);
    context.beginPath(); context.moveTo(-8, 20); context.lineTo(0, -92); context.lineTo(9, 20); context.closePath(); context.fill();
    context.lineWidth = 9; context.beginPath(); context.ellipse(side * 3, 54, 17, 30, 0, 0, Math.PI * 2); context.stroke();
    context.restore();
  }
}
function jarMark(context: Ink) {
  context.beginPath(); context.moveTo(-24, -80); context.lineTo(24, -80); context.lineTo(18, -62);
  context.bezierCurveTo(72, -40, 66, 40, 22, 80); context.lineTo(-22, 80); context.bezierCurveTo(-66, 40, -72, -40, -18, -62); context.closePath(); context.fill();
  context.lineWidth = 8;
  for (const side of [-1, 1]) { context.beginPath(); context.moveTo(side * 20, -70); context.quadraticCurveTo(side * 64, -68, side * 48, -28); context.stroke(); }
}
/** A brushed arrow pointing along +x. */
function arrowMark(context: Ink) {
  context.beginPath(); context.moveTo(-104, -10); context.lineTo(28, -17); context.lineTo(22, -52); context.lineTo(108, 0); context.lineTo(22, 52); context.lineTo(28, 17); context.lineTo(-104, 10); context.closePath(); context.fill();
}
function pliersMark(context: Ink, ground: string) {
  context.lineWidth = 17; context.lineCap = "round"; context.lineJoin = "round";
  for (const side of [-1, 1]) {
    context.beginPath(); context.moveTo(side * 40, 104); context.quadraticCurveTo(side * 34, 34, 0, 0); context.lineTo(side * -12, -24); context.lineTo(side * -7, -72); context.stroke();
  }
  context.save(); context.fillStyle = ground; context.beginPath(); context.arc(0, 0, 6, 0, Math.PI * 2); context.fill(); context.restore();
}
/** A goose in profile, cut as a stencil: every part is bridged to the next, as the card would need. */
function gooseStencil(context: Ink, bill: string) {
  context.beginPath(); context.ellipse(-30, 60, 250, 140, -0.12, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.moveTo(-250, 10); context.lineTo(-380, -66); context.lineTo(-296, 84); context.closePath(); context.fill();
  context.lineWidth = 62; context.lineCap = "round";
  context.beginPath(); context.moveTo(190, -30); context.bezierCurveTo(310, -110, 186, -250, 258, -348); context.stroke();
  context.beginPath(); context.ellipse(280, -374, 62, 46, -0.2, 0, Math.PI * 2); context.fill();
  for (const x of [-80, 40]) {
    context.fillRect(x - 11, 196, 22, 150);
    context.beginPath(); context.moveTo(x - 16, 346); context.lineTo(x + 84, 360); context.lineTo(x - 16, 380); context.closePath(); context.fill();
  }
  context.save(); context.fillStyle = bill;
  context.beginPath(); context.moveTo(338, -398); context.lineTo(438, -372); context.lineTo(340, -350); context.closePath(); context.fill();
  context.restore();
  context.save(); context.globalCompositeOperation = "destination-out"; context.shadowBlur = 0; context.lineCap = "butt";
  context.lineWidth = 16; context.beginPath(); context.moveTo(-200, 10); context.quadraticCurveTo(-30, 170, 176, 50); context.stroke();
  context.lineWidth = 13; context.beginPath(); context.moveTo(150, -84); context.lineTo(262, -4); context.stroke();
  context.beginPath(); context.moveTo(206, -322); context.lineTo(300, -300); context.stroke();
  context.fillRect(-120, 204, 200, 13); context.fillRect(-120, 336, 260, 11);
  context.beginPath(); context.arc(294, -384, 9, 0, Math.PI * 2); context.fill();
  context.restore();
}

/** Flaking and sun-thinning cut out of whatever has been painted so far; heaviest low down and at the edges. */
function weatherPaint(context: Ink, W: number, H: number, random: () => number, amount = 1) {
  context.save(); context.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 26 * amount; i += 1) {
    const x = random() * W, y = random() * H, r = 50 + random() * 220;
    const thin = context.createRadialGradient(x, y, 0, x, y, r);
    thin.addColorStop(0, `rgba(0,0,0,${0.1 + random() * 0.2})`); thin.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = thin; context.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < (W * H) / 2200 * amount; i += 1) {
    const edge = random() < 0.45, x = random() * W, y = edge ? (random() < 0.7 ? H - random() * random() * H * 0.5 : random() * random() * H * 0.3) : random() * H;
    context.fillStyle = `rgba(0,0,0,${0.35 + random() * 0.65})`;
    context.beginPath(); context.ellipse(x, y, 1.5 + random() * (edge ? 9 : 4), 1 + random() * (edge ? 5 : 3), random() * 3, 0, Math.PI * 2); context.fill();
  }
  // Rain has run down the face and taken a little paint with it.
  for (let i = 0; i < 14 * amount; i += 1) {
    const x = random() * W, width = 6 + random() * 26, run = context.createLinearGradient(0, 0, 0, H);
    run.addColorStop(0, `rgba(0,0,0,${0.05 + random() * 0.14})`); run.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = run; context.fillRect(x, 0, width, H);
  }
  context.restore();
}

/**
 * A sign painted on the plaster: a limewashed panel inside a coloured band, lettered by `letter` and then
 * weathered so that the wall shows through. The canvas is clear outside the panel; `scale` shrinks the
 * whole canvas for the lighter tier.
 */
function wallSignTexture(W: number, H: number, scale: number, band: string, seed: number, letter: (context: Ink) => void) {
  return canvasTexture(Math.round(W * scale), Math.round(H * scale), (context) => {
    const random = rng(seed), m = 20;
    context.scale(scale, scale);
    context.clearRect(0, 0, W, H);
    // Limewash brushed on by hand: its edge wanders.
    context.fillStyle = "#dccfb2";
    context.beginPath();
    for (let x = m; x <= W - m; x += 42) context.lineTo(x, m + (random() - 0.5) * 12);
    for (let y = m; y <= H - m; y += 42) context.lineTo(W - m + (random() - 0.5) * 12, y);
    for (let x = W - m; x >= m; x -= 42) context.lineTo(x, H - m + (random() - 0.5) * 12);
    for (let y = H - m; y >= m; y -= 42) context.lineTo(m + (random() - 0.5) * 12, y);
    context.closePath(); context.fill();
    context.globalCompositeOperation = "source-atop";
    for (let i = 0; i < (W * H) / 3000; i += 1) { context.fillStyle = `rgba(${random() < 0.5 ? "255,250,236" : "128,104,70"},${0.03 + random() * 0.06})`; context.fillRect(random() * W, random() * H, 60 + random() * 320, 2 + random() * 5); }
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = band; context.lineWidth = 18; context.strokeRect(m + 36, m + 36, W - (m + 36) * 2, H - (m + 36) * 2);
    context.lineWidth = 4; context.strokeRect(m + 62, m + 62, W - (m + 62) * 2, H - (m + 62) * 2);
    context.textAlign = "center"; context.textBaseline = "middle";
    letter(context);
    weatherPaint(context, W, H, random, 1.4);
  });
}

/** Hand-lettered board on painted planks; `letter` writes on it before the paint flakes at the edges. */
function boardTexture(W: number, H: number, ground: string, line: string, seed: number, letter: (context: Ink) => void) {
  return canvasTexture(W, H, (context) => {
    const random = rng(seed);
    context.fillStyle = ground; context.fillRect(0, 0, W, H);
    for (let board = 0; board * 128 < H; board += 1) {
      context.fillStyle = `rgba(${board % 2 ? 255 : 0},${board % 2 ? 255 : 0},${board % 2 ? 255 : 0},.035)`; context.fillRect(0, board * 128, W, 128);
      context.fillStyle = "rgba(6,20,20,.7)"; context.fillRect(0, board * 128 - 2, W, 4);
    }
    for (let i = 0; i < (W * H) / 1165; i += 1) { context.fillStyle = `rgba(${random() < 0.5 ? "255,240,210" : "0,0,0"},${0.03 + random() * 0.05})`; context.fillRect(random() * W, random() * H, 30 + random() * 220, 1 + random() * 2); }
    context.strokeStyle = line; context.lineWidth = 10; context.strokeRect(26, 26, W - 52, H - 52);
    context.lineWidth = 3; context.strokeRect(46, 46, W - 92, H - 92);
    context.textAlign = "center"; context.textBaseline = "middle";
    letter(context);
    // Flaked paint.
    for (let i = 0; i < W / 8; i += 1) { context.fillStyle = `rgba(92,70,44,${0.3 + random() * 0.5})`; const x = random() * W, y = random() < 0.5 ? random() * 60 : H - random() * 60; context.fillRect(x, y, 4 + random() * 26, 2 + random() * 9); }
  });
}

/** A printed bill pasted to the wall: foxed paper, a crease, paste lifting at the corners. */
function billTexture(paper: string, seed: number, print: (context: Ink) => void) {
  const W = 512, H = 640;
  return canvasTexture(W, H, (context) => {
    const random = rng(seed);
    context.clearRect(0, 0, W, H);
    context.fillStyle = paper;
    context.beginPath();
    for (let x = 6; x <= W - 6; x += 22) context.lineTo(x, 6 + random() * 5);
    for (let y = 6; y <= H - 6; y += 22) context.lineTo(W - 6 - random() * 5, y);
    for (let x = W - 6; x >= 6; x -= 22) context.lineTo(x, H - 6 - random() * 5);
    for (let y = H - 6; y >= 6; y -= 22) context.lineTo(6 + random() * 5, y);
    context.closePath(); context.fill();
    context.globalCompositeOperation = "source-atop";
    for (let i = 0; i < 60; i += 1) {
      const x = random() * W, y = random() * H, r = 8 + random() * 46, fox = context.createRadialGradient(x, y, 0, x, y, r);
      fox.addColorStop(0, `rgba(150,110,60,${0.05 + random() * 0.1})`); fox.addColorStop(1, "rgba(150,110,60,0)");
      context.fillStyle = fox; context.fillRect(x - r, y - r, r * 2, r * 2);
    }
    context.fillStyle = "rgba(90,70,40,.16)"; context.fillRect(0, H / 2 - 1, W, 2);
    context.fillStyle = "rgba(255,252,240,.3)"; context.fillRect(0, H / 2 + 1, W, 2);
    context.textAlign = "center"; context.textBaseline = "middle";
    print(context);
    // The wall's dust has settled along the bottom edge.
    const dust = context.createLinearGradient(0, H - 90, 0, H);
    dust.addColorStop(0, "rgba(170,130,80,0)"); dust.addColorStop(1, "rgba(170,130,80,.3)");
    context.fillStyle = dust; context.fillRect(0, H - 90, W, 90);
    context.globalCompositeOperation = "destination-out";
    // One corner has torn away with the paste.
    context.beginPath(); context.moveTo(W, 0); context.lineTo(W - 62 - random() * 20, 0); context.lineTo(W - 30, 26); context.lineTo(W, 58 + random() * 20); context.closePath(); context.fill();
    context.globalCompositeOperation = "source-over";
  });
}

/** Enamelled plate: cream on blue, chipped to the iron at its screws. */
function enamelTexture(W: number, H: number, seed: number, letter: (context: Ink) => void) {
  return canvasTexture(W, H, (context) => {
    const random = rng(seed);
    context.fillStyle = "#1c4f7a"; context.fillRect(0, 0, W, H);
    context.strokeStyle = "#f1ead8"; context.lineWidth = 10; context.strokeRect(14, 14, W - 28, H - 28);
    context.fillStyle = "#f1ead8"; context.textAlign = "center"; context.textBaseline = "middle";
    letter(context);
    for (const [x, y] of [[30, H / 2], [W - 30, H / 2]]) {
      for (let i = 0; i < 5; i += 1) { context.fillStyle = `rgba(${40 + random() * 30},${24 + random() * 14},16,${0.7 + random() * 0.3})`; context.beginPath(); context.ellipse(x + (random() - 0.5) * 14, y + (random() - 0.5) * 14, 3 + random() * 7, 2 + random() * 6, random() * 3, 0, Math.PI * 2); context.fill(); }
      context.fillStyle = "#8d8f8c"; context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#2a2623"; context.fillRect(x - 5, y - 1, 10, 2);
    }
  });
}

/** Chalked price slate for the stall. */
function slateTexture() {
  return canvasTexture(512, 640, (context) => {
    context.fillStyle = "#1b1e1d"; context.fillRect(0, 0, 512, 640);
    const random = rng(3);
    for (let i = 0; i < 500; i += 1) { context.fillStyle = `rgba(230,230,220,${random() * 0.05})`; context.fillRect(random() * 512, random() * 640, 40 + random() * 120, 2); }
    context.fillStyle = "#e8e4d6"; context.textAlign = "left"; context.textBaseline = "middle";
    context.font = `italic 64px ${SERIF}`; context.fillText("Utility", 44, 70);
    context.fillRect(40, 112, 432, 3);
    [
      ["Pomegranates", "300", "ninety-eight seeds, never the hundred"],
      ["Onions", "200", "pop one and look away"],
      ["Smoked melon", "300", "one-way, no returns"],
      ["Oranges, crate", "800", "all you can afford in round one"],
    ].forEach(([item, price, note], row) => {
      const y = 168 + row * 108;
      context.fillStyle = "#e8e4d6"; context.font = `46px ${SERIF}`;
      context.textAlign = "left"; context.fillText(item, 44, y);
      context.textAlign = "right"; context.fillText(price, 468, y);
      context.fillStyle = "rgba(232,228,214,.72)"; context.font = `italic 27px ${SERIF}`;
      context.textAlign = "left"; context.fillText(note, 60, y + 44);
    });
    context.fillStyle = "#e8e4d6"; context.textAlign = "center"; context.font = `34px ${SERIF}`;
    context.fillText("max. 4 per customer", 256, 596);
    context.fillRect(96, 620, 320, 2);
  });
}

export function buildCourtyard(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, wall, place, instances } = kit;
  const metals = kit.metals();
  const random = rng(2026);

  // ---- Materials -----------------------------------------------------------
  const sand = photoSet("/textures/sandstone_cracks-2k", 96 / 3.4, 104 / 3.4, false);
  const plaster = wall("daub");
  const plankSet = photoSet("/textures/weathered_brown_planks-2k", 1, 1, false);
  const brickSet = wall("mudBrick", 1.2);
  const cobbleSet = photoSet("/textures/cobblestone_floor_04-2k", 1, 1, false);
  const rustSet = photoSet("/textures/rusty_metal_02-2k", 1, 1, false);
  const fabricSet = photoSet("/textures/fabric_pattern_07-2k", 1, 1, false);
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.5, ...parameters });
  const plasterMaterial = (color: number, normal = 1) => standard({ ...plaster, color, normalScale: new THREE.Vector2(normal, normal), envMapIntensity: 0.55 });
  const wallPlaster = plasterMaterial(0xe2c59a);
  const capPlaster = plasterMaterial(0xf0dfc0, 0.7);
  const plinthPlaster = plasterMaterial(0xb48f63, 1.3);
  const townPlaster = [plasterMaterial(0xdcc09a), plasterMaterial(0xcfae84), plasterMaterial(0xe6d3b2)];
  const shade = standard({ color: 0x120d09, envMapIntensity: 0.1 });
  const bikePaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.1, 0.33, 0.32], 311, 0.85, 512)), { envMapIntensity: 1 });
  const terracotta = standard({ color: 0xa85c38, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.78 });
  const glazed = standard({ color: 0x2c7f7a, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.22, envMapIntensity: 1 });
  const rope = standard({ color: 0x8a744f });
  const timber = standard({ ...plankSet, color: 0xd8c0a0, envMapIntensity: 0.4 });
  const darkTimber = standard({ ...plankSet, color: 0x8f755c, envMapIntensity: 0.4 });
  const shutterWood = standard({ ...plankSet, color: 0x58b8ac, envMapIntensity: 0.4 });
  /**
   * Bleaches a photographed texture toward dusty earth: `keep` is how much of its own colour survives
   * and `flatten` how far its contrast is pulled toward the mid tone `mid`, as a coat of dust does.
   */
  const sunBleached = <T extends THREE.MeshStandardMaterial>(material: T, keep: number, tint: [number, number, number], key: string, flatten = 0, mid = 0.3) => {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
        diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, ${keep.toFixed(3)});
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${mid.toFixed(3)}), ${flatten.toFixed(3)}) * vec3(${tint.map((value) => value.toFixed(3)).join(", ")});`);
    };
    material.customProgramCacheKey = () => key;
    return material;
  };
  /**
   * Aerial perspective for scenery at a known distance: the lit colour is mixed toward the haze by a
   * fixed `amount`, after the scene fog. HAZE is the airlight in scene-linear units.
   */
  const HAZE = [0.7, 0.63, 0.53];
  const hazed = <T extends THREE.Material>(material: T, amount: number) => {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <fog_fragment>", `#include <fog_fragment>
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(${HAZE.map((value) => value.toFixed(3)).join(", ")}), ${amount.toFixed(3)});`);
    };
    material.customProgramCacheKey = () => `haze-${amount.toFixed(3)}`;
    return material;
  };
  // Sun-dried mud brick and dusty setts rather than fired red brick and mossy cobbles.
  const brick = sunBleached(standard({ ...brickSet, color: 0xffffff, normalScale: new THREE.Vector2(1.4, 1.4), envMapIntensity: 0.4 }), 0.4, [1.5, 1.16, 0.82], "dust-brick", 0.42, 0.3);
  const paving = sunBleached(standard({ ...cobbleSet, color: 0xffffff, normalScale: new THREE.Vector2(1.3, 1.3), envMapIntensity: 0.4 }), 0.3, [0.98, 0.82, 0.6], "dust-setts", 0.22, 0.36);
  const iron = standard({ ...rustSet, color: 0x3d322b, metalness: 0.55, roughness: 0.9, envMapIntensity: 0.7 });
  const tankMetal = standard({ ...rustSet, color: 0xb9b4a8, metalness: 0.45, envMapIntensity: 0.8 });
  const gingham = standard({ ...fabricSet, side: THREE.DoubleSide });
  const linen = standard({ color: 0xb9b09a, normalMap: fabricSet.normalMap, roughnessMap: fabricSet.roughnessMap, side: THREE.DoubleSide });
  const indigo = standard({ color: 0x3d5f86, normalMap: fabricSet.normalMap, roughnessMap: fabricSet.roughnessMap, side: THREE.DoubleSide });
  const lampGlass = standard({ color: 0xa8905c, emissive: 0xffb45a, emissiveIntensity: 0.12, roughness: 0.2, transparent: true, opacity: 0.8 });
  const water = standard({ color: 0x0c2022, roughness: 0.06, envMapIntensity: 1.6 });
  const frieze = track(friezeTexture());
  frieze.anisotropy = anisotropy;

  // ---- Batching: one mesh per material, zone and shadow flag ----------------
  type Add = (material: THREE.Material, geometry: THREE.BufferGeometry, at?: V3, rot?: V3, scale?: V3 | number, shadow?: boolean) => void;
  const batches = new Map<string, { material: THREE.Material; shadow: boolean; parts: THREE.BufferGeometry[] }>();
  const maker = (parent: THREE.Matrix4 | null, zone: string, castsShadow = false): Add => (material, geometry, at, rot, scale, shadow = castsShadow) => {
    const part = plain(geometry);
    const matrix = at || rot || scale !== undefined ? xf(at, rot, scale) : null;
    if (parent && matrix) part.applyMatrix4(matrix.premultiply(parent));
    else if (parent) part.applyMatrix4(parent);
    else if (matrix) part.applyMatrix4(matrix);
    const key = `${material.uuid}:${zone}:${shadow ? 1 : 0}`;
    let batch = batches.get(key);
    if (!batch) { batch = { material, shadow, parts: [] }; batches.set(key, batch); }
    batch.parts.push(part);
  };
  const flush = () => {
    for (const batch of batches.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(batch.parts), batch.material);
      batch.parts.forEach((part) => part.dispose());
      mesh.castShadow = batch.shadow;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
    batches.clear();
  };
  const west = (z: number, zone = "west", shadow = false, y = 0, inset = 0) => maker(xf([-9.54 + inset, y, z], [0, Math.PI / 2, 0]), zone, shadow);
  const east = (z: number, zone = "east", shadow = false, y = 0, inset = 0) => maker(xf([9.54 - inset, y, z], [0, -Math.PI / 2, 0]), zone, shadow);
  const gate = (x: number, shadow = false) => maker(xf([x, 0, 9.72], [0, Math.PI, 0]), "gate", shadow);
  const court = maker(null, "court", true);
  const courtFine = maker(null, "court", false);

  // ---- Wind and what lives in it --------------------------------------------
  // One hot, fitful air for the whole court, out of the north-east: it comes over the far end of the east
  // wall and leaves by the west arcade, so a gust is seen crossing the range before it reaches the player.
  const BREEZE = 0.4;
  const wind = createWind({ heading: 2.25, strength: BREEZE, gustiness: 0.7 });
  const trees = createTrees(kit, { seed: 5, wind, sun: () => sun });
  // Located sounds all go through one desk, so the court stays musical: a fitting that has spoken keeps
  // quiet for a while (seconds, below), no two of them speak together, and only what answers the player
  // (wings, a hen, a chime that has been shot) is let straight through.
  const QUIET: Partial<Record<CueName, number>> = { sparrowChirp: 6, chimeTinkle: 7, clothSnap: 6, chickenCluck: 8, leafRustle: 6, shutterCreak: 9, pigeonCoo: 10, signCreak: 13, ropeClank: 14 };
  const spoke: Partial<Record<CueName, number>> = {};
  const heard = options.cue;
  let lastSpoke = 0, answering = false;
  const cue: Cue | undefined = heard && ((name, at, how) => {
    const quiet = QUIET[name];
    if (quiet !== undefined && !answering) {
      // Sparrows chatter in runs, and a run that has begun is heard out.
      const time = performance.now() / 1000, since = time - (spoke[name] ?? -100), run = name === "sparrowChirp" ? 1.6 : 0;
      if (since > run) {
        if (time - lastSpoke < 0.8 || since < quiet * (0.7 + 0.6 * ((time * 0.618) % 1))) return;
        spoke[name] = lastSpoke = time;
      }
    }
    heard(name, at, how);
  });
  const life = createLife(kit, { ...options, cue }, { wind, seed: 9 });
  /** Fittings the wind swings, kept so that the gust of the dust devil can set them going. */
  const swinging: Record<string, { kick: (strength: number, x?: number, z?: number) => void }> = {};
  /** Everything pegged out to dry, on the roofs and on the lines; made into one mesh once it is all gathered. */
  const washing: Wash[] = [];
  const DYES = [0xa39a84, 0x4d6079, 0x7f5347, 0x978a66, 0x5d7269, 0x8c6e60, 0xa8a498, 0x4a3d33];

  // ---- Ground --------------------------------------------------------------
  const ground = standard({ ...sand, color: 0xb4b2ab, normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.35 });
  // Dry ground: chalked range lines, no standing water, no mirror pass.
  const reflection = kit.floor(ground, { width: 96, depth: 104, z: -12 }, {
    lane: new THREE.Color(0.86, 0.8, 0.68),
    edge: new THREE.Color(0.86, 0.8, 0.68),
    markings: 0.5,
    wet: -1,
  }, false);
  // Loose sand shares the ground's textures, mapped so drifts continue the floor's pattern.
  const looseSand = standard({ ...sand, color: 0xbdb9ae, normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.35 });
  const drift = (x: number, z: number, length: number, width: number, height: number, turn: number) => {
    const mound = new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const position = mound.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const px = position.getX(i), py = position.getY(i), pz = position.getZ(i);
      const lump = 1 + 0.16 * Math.sin(px * 5 + pz * 3 + x) * Math.cos(pz * 4 - z);
      position.setXYZ(i, px * lump, Math.pow(py, 1.6) * lump, pz * lump);
    }
    mound.applyMatrix4(xf([x, -0.01, z], [0, turn, 0], [length, height, width]));
    mound.computeVertexNormals();
    const uv = mound.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (position.getX(i) + 48) / 96, (40 - position.getZ(i)) / 104);
    maker(null, "ground")(looseSand, mound);
  };
  ([
    // Inside the walls the sand lies in the far corners, under the niches and against the footings, clear of where the stores stand.
    [-9.2, -28.9, 1.6, 0.9, 0.28, 0.3], [9.15, -28.8, 1.9, 1.0, 0.32, -0.4], [-9.3, -21.05, 0.55, 0.45, 0.16, 1.5], [9.32, -19.9, 0.45, 0.4, 0.14, 1.6],
    [-9.32, -17.0, 0.5, 0.38, 0.12, 1.5], [9.32, -16.95, 0.55, 0.38, 0.12, 1.6], [9.32, 0.85, 0.6, 0.42, 0.16, 1.5],
    [-5.3, 9.55, 0.8, 0.35, 0.13, 0.1], [5.6, 9.55, 0.9, 0.38, 0.14, -0.1], [-11.2, 0.4, 2.2, 1.0, 0.3, 0.9], [11.6, 9.6, 2.6, 1.2, 0.34, -0.3],
    [-12.8, 9.4, 2.4, 1.3, 0.3, 0.2], [12.0, 1.0, 2.0, 1.0, 0.26, 1.2], [-10.05, 2.95, 1.0, 1.5, 0.07, 0], [10.05, 7.75, 1.0, 1.5, 0.07, 0],
  ] as number[][]).forEach(([x, z, length, width, height, turn]) => drift(x, z, length, width, height, turn));
  // A paved apron along the wall feet, deep enough to stand the stores on and broken where the paving gave
  // out. `paved` tells the setts from the sand, so that whatever stands near the edge stands on one of them.
  let paved = (_x: number, _z: number) => false;
  // Loose setts, fallen brick and stones at the broken edge: scattered here, laid once the stores are in place.
  const strewn = { setts: [] as Transform[], bricks: [] as Transform[], stones: [] as Transform[] };
  {
    const add = maker(null, "ground");
    const westApron = pavingStrip(-29.4, 0.3, 11, 1.12), eastApron = pavingStrip(-0.3, 29.4, 23, 1.12);
    const gateWest = pavingStrip(-9.5, -6.5, 31, 1.0), gateEast = pavingStrip(6.4, 9.5, 37, 1.0);
    add(paving, westApron.geometry, [-9.47, 0, 0], [0, -Math.PI / 2, 0]);
    add(paving, eastApron.geometry, [9.47, 0, 0], [0, Math.PI / 2, 0]);
    add(paving, gateWest.geometry, [0, 0, 9.66], [0, 0, 0]);
    add(paving, gateEast.geometry, [0, 0, 9.66], [0, 0, 0]);
    paved = (x, z) => x + 9.47 < westApron.reach(z) || 9.47 - x < eastApron.reach(-z) || 9.66 - z < Math.max(gateWest.reach(x), gateEast.reach(x));
    if (high) {
      const onGround = (x: number, z: number) => (paved(x, z) ? KERB : 0);
      for (let i = 0; i < 70; i += 1) {
        const side = random() < 0.5 ? -1 : 1, z = -28.5 + random() * 28, x = side * (7.95 + random() * 0.55);
        strewn.setts.push({ position: [x, onGround(x, z) + 0.012, z], rotation: [0, random() * 3, 0], scale: [0.8 + random() * 0.5, 1, 0.8 + random() * 0.6] });
      }
      for (let i = 0; i < 46; i += 1) {
        const side = random() < 0.5 ? -1 : 1, z = -28.5 + random() * 28;
        strewn.bricks.push({ position: [side * (9.0 + random() * 0.32), 0.03 + random() * 0.02, z], rotation: [random() * 0.3, random() * 3, random() * 0.4] });
      }
      for (let i = 0; i < 90; i += 1) {
        const side = random() < 0.5 ? -1 : 1, z = -29 + random() * 38, s = 0.03 + random() * 0.07, x = side * (8.7 + random() * 0.75);
        strewn.stones.push({ position: [x, onGround(x, z) + s * 0.4, z], rotation: [random() * 3, random() * 3, random() * 3], scale: [s * 1.4, s, s * 1.1] });
      }
    }
  }

  // ---- Court walls ---------------------------------------------------------
  const sideRun = 29.7, sideZ = -14.55;
  // Where the render has blown: [z, y, radius] on each wall face, kept clear of buttresses, signs and openings.
  const westScars = [[-3.2, 3.2, 0.3], [-6.3, 1.7, 0.3], [-21.1, 3.6, 0.26], [-27.9, 2.3, 0.45], [-28.5, 4.45, 0.33]];
  const eastScars = [[-27.9, 2.7, 0.45], [-8.9, 3.3, 0.4], [-2.3, 2.5, 0.24], [-15.3, 3.62, 0.25]];
  const arcadeScars = [[5.35, 3.3, 0.3]];
  const arcade = scarredWall(10.1, WALL_TOP, 0.8, [{ x: -2.4, width: 3.2, spring: 1.9 }, { x: 2.4, width: 3.2, spring: 1.9 }], arcadeScars.map(([z, y, radius], index) => ({ x: 5.35 - z, y, radius, seed: 300 + index })), 3);
  arcade.rotateY(Math.PI / 2);
  // West wall: a door, a shuttered window and a lamp niche. East wall: two caged windows and a niche.
  const DOOR = { z: -4.5, width: 1.5, spring: 2.05 }, WINDOW = { z: -23.1, width: 1.1, sill: 1.3, spring: 2.3 }, NICHE = { z: -17, width: 0.8, sill: 1.0, spring: 1.35 };
  const CAGED = { z: [-3.3, -5.7], width: 0.9, sill: 1.25, spring: 2.2 };
  const westWall = scarredWall(sideRun, WALL_TOP, 0.8, [
    { x: sideZ - DOOR.z, width: DOOR.width, spring: DOOR.spring },
    { x: sideZ - WINDOW.z, width: WINDOW.width, spring: WINDOW.spring, sill: WINDOW.sill },
    { x: sideZ - NICHE.z, width: NICHE.width, spring: NICHE.spring, sill: NICHE.sill },
  ], westScars.map(([z, y, radius], index) => ({ x: sideZ - z, y, radius, seed: 100 + index })), 3);
  westWall.rotateY(Math.PI / 2);
  const eastWall = scarredWall(sideRun, WALL_TOP, 0.8, [
    ...CAGED.z.map((z) => ({ x: z - sideZ, width: CAGED.width, spring: CAGED.spring, sill: CAGED.sill })),
    { x: NICHE.z - sideZ, width: NICHE.width, spring: NICHE.spring, sill: NICHE.sill },
  ], eastScars.map(([z, y, radius], index) => ({ x: z - sideZ, y, radius, seed: 200 + index })), 3);
  eastWall.rotateY(-Math.PI / 2);
  const stud = new THREE.SphereGeometry(0.02, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);

  /** Boarded door hung at the back of a reveal: planks, iron straps, studs, ring pull and lock. */
  const doorSet = (add: Add, width: number, spring: number, depth: number, seed: number, wood: THREE.Material = timber) => {
    const r = rng(seed), height = spring + width / 2 + 0.04;
    const boards = Math.round(width / 0.19), bw = width / boards;
    for (let i = 0; i < boards; i += 1) add(wood, grain(softBox(bw - 0.012, height, 0.05, 0.008, 1.8), 1.8, true, r(), r()), [-width / 2 + bw * (i + 0.5), height / 2, -depth]);
    for (const y of [0.32, spring * 0.56, spring - 0.1]) {
      add(iron, grain(new THREE.BoxGeometry(width - 0.08, 0.075, 0.012), 0.8), [0, y, -depth + 0.031]);
      // Strap hinges end in a spade.
      add(iron, new THREE.CylinderGeometry(0.055, 0.055, 0.022, 4).rotateX(Math.PI / 2), [width / 2 - 0.1, y, -depth + 0.031]);
      add(iron, new THREE.CylinderGeometry(0.017, 0.017, 0.16, 6), [-width / 2 + 0.02, y, -depth + 0.05]);
      for (let i = 0; i < boards; i += 1) add(iron, stud, [-width / 2 + bw * (i + 0.5), y, -depth + 0.037]);
    }
    if (high) for (const y of [0.78, spring * 0.56 + 0.5, spring + 0.28]) for (let i = 0; i < boards; i += 1) add(iron, stud, [-width / 2 + bw * (i + 0.5), y, -depth + 0.026], undefined, 1.25);
    add(iron, new THREE.CylinderGeometry(0.058, 0.064, 0.014, 14).rotateX(Math.PI / 2), [width * 0.28, 1.06, -depth + 0.033]);
    add(iron, new THREE.TorusGeometry(0.072, 0.011, 6, 20), [width * 0.28, 0.995, -depth + 0.054], [0.22, 0, 0]);
    add(iron, new THREE.BoxGeometry(0.085, 0.17, 0.012), [width * 0.28, 1.3, -depth + 0.032]);
    add(iron, new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8).rotateX(Math.PI / 2), [width * 0.28, 1.27, -depth + 0.04]);
  };
  /** Moulded arch, keystone and worn stone step around a doorway. */
  const doorCase = (add: Add, width: number, spring: number) => {
    add(capPlaster, archFrame(width, spring, 0.2, 0.05), [0, 0, 0.012], undefined, undefined, true);
    add(capPlaster, softBox(0.24, 0.36, 0.15, 0.03, 3), [0, spring + width / 2 + 0.11, 0.07], undefined, undefined, true);
    for (const side of [-1, 1]) add(capPlaster, softBox(0.3, 0.12, 0.13, 0.025, 3), [side * (width / 2 + 0.1), spring, 0.06]);
    // Threshold: a worn stone slab on a lower, wider tread.
    add(capPlaster, softBox(width + 0.04, 0.15, 0.6, 0.03, 2.2), [0, 0.075, -0.19], undefined, undefined, true);
    add(capPlaster, softBox(width + 0.62, 0.08, 0.36, 0.03, 2.2), [0, 0.04, 0.2], undefined, undefined, true);
  };
  /** Window in a deep reveal: surround, sill, inner leaves and either open louvred shutters or a caged grille. */
  const windowSet = (add: Add, width: number, sill: number, spring: number, kind: "shutters" | "caged" | "barred", seed: number, loose = 0) => {
    const r = rng(seed), height = spring - sill + width / 2;
    add(capPlaster, archFrame(width, spring, 0.15, 0.045, sill), [0, 0, 0.012], undefined, undefined, true);
    // The sill stone stands 12 mm proud of the bottom of the reveal instead of sharing its plane.
    add(capPlaster, softBox(width + 0.5, 0.09, 0.34, 0.025, 3), [0, sill - 0.033, 0.06], undefined, undefined, true);
    for (const side of kind === "caged" && seed % 2 ? [-1] : [-1, 1]) {
      add(darkTimber, grain(new THREE.BoxGeometry(width / 2 - 0.012, height, 0.04), 1.8, true, r(), r()), [side * width / 4, sill + height / 2, -0.56]);
      for (const t of [0.2, 0.75]) add(iron, new THREE.BoxGeometry(width / 2 - 0.06, 0.04, 0.008), [side * width / 4, sill + height * t, -0.535]);
    }
    if (kind === "caged") add(iron, grilleGeometry(width + 0.14, height + 0.06, 0.24), [0, sill - 0.03, 0.03], undefined, undefined, true);
    else add(iron, grilleGeometry(width, height, 0), [0, sill, -0.16]);
    if (kind === "shutters") {
      const leaf = shutterGeometry(width / 2 + 0.03, spring - sill + 0.2, 13);
      for (const side of [-1, 1]) {
        // The leaf on the `loose` side has slipped its hook: `looseLeaf` hangs it where the wind can swing it.
        if (side !== loose) add(shutterWood, leaf, [side * (width * 0.75 + 0.06), sill + (spring - sill + 0.2) / 2, 0.06], [0, side * -0.14, 0], undefined, true);
        for (const t of [0.18, 0.82]) add(iron, new THREE.CylinderGeometry(0.014, 0.014, 0.1, 6), [side * (width / 2 + 0.03), sill + (spring - sill + 0.2) * t, 0.035]);
      }
    }
  };
  /**
   * A shutter leaf off its hook, swinging on its pins and creaking: `hinge` is the middle of its hinged edge
   * in the world, `turn` the yaw of the wall it hangs on, `side` the jamb, `rest` how far it stands open.
   */
  const looseLeaf = (hinge: V3, turn: number, side: number, width: number, height: number, rest: number) => {
    // The library swings a thing about its own z, so the pin's z is stood upright and the leaf laid back into the wall's frame.
    const pin = new THREE.Group(), upright = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    pin.position.set(...hinge);
    pin.quaternion.setFromEuler(new THREE.Euler(0, turn, 0)).multiply(upright);
    const leaf = new THREE.Mesh(track(shutterGeometry(width, height, 13).translate(side * width / 2, 0, 0)), shutterWood);
    leaf.quaternion.copy(upright).invert().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -side * rest, 0)));
    leaf.receiveShadow = true;
    leaf.userData.walkThrough = true;
    pin.add(leaf);
    scene.add(pin);
    kit.shootable.push(leaf);
    return life.sway(pin, { amplitude: 0.6, period: 3.1, axis: "z", damping: 0.28, creak: "shutterCreak" });
  };
  const tinyLamp = lathe([[0, 0], [0.05, 0], [0.08, 0.03], [0.07, 0.06], [0.03, 0.075], [0.035, 0.1], [0, 0.1]], 12);
  const nicheSet = (add: Add) => {
    add(capPlaster, archFrame(NICHE.width, NICHE.spring, 0.1, 0.03, NICHE.sill), [0, 0, 0.01]);
    const shelf = NICHE.sill + 0.012;
    add(capPlaster, softBox(NICHE.width + 0.2, 0.06, 0.6, 0.02, 3), [0, shelf - 0.03, -0.2]);
    add(terracotta, tinyLamp, [0.18, shelf, -0.16]);
    add(terracotta, lathe(DISH, 24, 0.4), [0.12, shelf, -0.33]);
  };

  for (const side of [-1, 1]) {
    const x = side * WALL_X;
    place(new THREE.Mesh(side < 0 ? westWall : eastWall, wallPlaster), x, 0, sideZ, true, true);
    place(new THREE.Mesh(arcade, wallPlaster), x, 0, 5.35, true, true);
    place(new THREE.Mesh(softBox(1.04, 0.24, 39.9, 0.06, 3), capPlaster), x, WALL_TOP + 0.1, -9.5, true);
    // Tile frieze under the coping.
    const band = frieze.clone();
    band.needsUpdate = true;
    band.repeat.set(27 / 1.3, 1);
    track(band);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.65, 27), standard({ map: band, color: 0xd6d0c4, roughness: 0.36, envMapIntensity: 0.9 })), side * 9.525, 4.45, -13.5, false);
    // Moulded string courses frame the frieze.
    for (const y of [4.1, 4.8]) place(new THREE.Mesh(softBox(0.07, 0.06, 27.1, 0.02, 3), capPlaster), side * 9.515, y, -13.5, false);
    // Arcade: moulded arch rings and impost blocks on every pier.
    const add = side < 0 ? west : east;
    for (const z of [2.95, 7.75]) add(z, side < 0 ? "west" : "east", true)(capPlaster, archFrame(3.2, 1.9, 0.2, 0.045), [0, 0, 0.012]);
    for (const [z, length] of [[0.825, 1.05], [5.35, 1.6], [9.875, 1.05]]) court(capPlaster, softBox(0.98, 0.15, length + 0.1, 0.03, 3), [x, 1.9 - 0.075, z]);
    for (const [z, length] of [[0.825, 1.05], [5.35, 1.6], [9.875, 1.05]]) courtFine(brick, grain(new THREE.BoxGeometry(0.9, 0.5, length + 0.06), 1.2), [x, 0.25, z]);
  }
  // Brick footing with the lime render broken away over it. The brick stops short of the render at each
  // end and the capping runs past it, so no two end faces share a plane.
  const footing = (add: Add, from: number, to: number, seed: number) => {
    add(brick, grain(new THREE.BoxGeometry(to - from - 0.03, 0.98, 0.11), 1.2, false, seed * 0.37), [(from + to) / 2, 0.49, 0.055]);
    const skirt = new THREE.ExtrudeGeometry(skirtShape(from, to, 1.04, seed), { depth: 0.15, bevelEnabled: false });
    add(plinthPlaster, projectUv(skirt, 2.2), undefined, undefined, undefined, true);
    add(capPlaster, softBox(to - from + 0.03, 0.07, 0.19, 0.02, 3), [(from + to) / 2, 1.06, 0.085]);
  };
  // Each run dies a centimetre into the door surround or the pilaster it meets, leaving no hairline gap.
  footing(west(0), -0.03, -DOOR.z - DOOR.width / 2 - 0.21, 5);
  footing(west(0), -DOOR.z + DOOR.width / 2 + 0.21, 29.4, 9);
  footing(east(0), -29.4, 0.03, 13);
  // Brick behind each hole in the render, set back in the thickness of the wall.
  const backing = (add: Add, x: number, y: number, radius: number, seed: number) =>
    add(brick, grain(new THREE.BoxGeometry(radius * 3.7, radius * 2.6, 0.03), 1.2, false, seed * 0.173, seed * 0.091), [x, y, -0.05], undefined, undefined, true);
  westScars.forEach(([z, y, radius], index) => backing(west(0), -z, y, radius, 100 + index));
  eastScars.forEach(([z, y, radius], index) => backing(east(0), z, y, radius, 200 + index));
  for (const [z, y, radius] of arcadeScars) { backing(west(z), 0, y, radius, 300); backing(east(z), 0, y, radius, 301); }
  // A pilaster on a brick plinth closes the joint where each arcade meets its wall.
  for (const side of [-1, 1]) {
    court(wallPlaster, softBox(0.32, WALL_TOP, 0.56, 0.035, 3), [side * 9.56, WALL_TOP / 2, 0.3]);
    courtFine(brick, grain(new THREE.BoxGeometry(0.42, 0.5, 0.66), 1.2, false, 0.4), [side * 9.56, 0.25, 0.3]);
    courtFine(capPlaster, softBox(0.4, 0.12, 0.64, 0.03, 3), [side * 9.56, 3.95, 0.3]);
  }

  // Openings in the side walls.
  {
    const door = west(DOOR.z);
    doorSet(door, DOOR.width, DOOR.spring, 0.5, 3);
    doorCase(door, DOOR.width, DOOR.spring);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.1, DOOR.width + 0.3), shade), -10.24, 1.55, DOOR.z, false, true);
    // Enamel house number beside the door.
    const plate = track(canvasTexture(256, 256, (context) => {
      context.fillStyle = "#1c4f7a"; context.fillRect(0, 0, 256, 256);
      context.strokeStyle = "#f1ead8"; context.lineWidth = 10; context.strokeRect(14, 14, 228, 228);
      context.fillStyle = "#f1ead8"; context.textAlign = "center"; context.textBaseline = "middle";
      context.font = `bold 124px ${SERIF}`; context.fillText("1.6", 128, 138);
    }));
    plate.anisotropy = anisotropy;
    const number = place(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.2, 0.2), standard({ map: plate, roughness: 0.25, envMapIntensity: 1 })), -9.53, 2.05, DOOR.z - 1.25, false);
    number.receiveShadow = true;
    windowSet(west(WINDOW.z), WINDOW.width, WINDOW.sill, WINDOW.spring, "shutters", 4, 1);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.9, WINDOW.width + 0.3), shade), -10.24, 2.2, WINDOW.z, false, true);
    swinging.shutter = looseLeaf([-9.48, WINDOW.sill + 0.6, WINDOW.z - WINDOW.width / 2 - 0.045], Math.PI / 2, 1, WINDOW.width / 2 + 0.03, WINDOW.spring - WINDOW.sill + 0.2, 0.35);
    nicheSet(west(NICHE.z));
    place(new THREE.Mesh(worldBox(0.3, 1.2, NICHE.width + 0.3, 3), plinthPlaster), -10.17, 1.5, NICHE.z, false, true);
    CAGED.z.forEach((z, index) => {
      windowSet(east(z), CAGED.width, CAGED.sill, CAGED.spring, "caged", 6 + index);
      place(new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.8, CAGED.width + 0.3), shade), 10.24, 2.1, z, false, true);
    });
    nicheSet(east(NICHE.z));
    place(new THREE.Mesh(worldBox(0.3, 1.2, NICHE.width + 0.3, 3), plinthPlaster), 10.17, 1.5, NICHE.z, false, true);
  }

  const buttressZ = [-1.5, -7.5, -14.05, -19.95, -26.2];
  const buttress = softBox(0.5, 4.3, 0.6, 0.05, 3);
  instances(buttress, wallPlaster, buttressZ.flatMap((z) => [-1, 1].map((side) => ({ position: [side * 9.36, 2.15, z] as V3, rotation: [0, 0, side * 0.045] as V3 }))));
  instances(softBox(0.62, 0.16, 0.72, 0.04, 3), capPlaster, buttressZ.flatMap((z) => [-1, 1].map((side) => ({ position: [side * 9.28, 4.36, z] as V3 }))), false);
  instances(grain(new THREE.BoxGeometry(0.6, 0.6, 0.7), 1.2), brick, buttressZ.flatMap((z) => [-1, 1].map((side) => ({ position: [side * 9.3, 0.3, z] as V3 }))), false, false);

  // Gatehouse behind the firing line and the end wall behind the control centre.
  const GATE_DOOR = { x: -7.9, width: 1.3, spring: 1.95 }, GATE_WINDOW = { x: 7.9, width: 1.0, sill: 1.4, spring: 2.35 }, LOFT = { width: 0.8, sill: 4.7, spring: 5.5 };
  const gateWall = archedWall(20.7, 7.6, 0.8, [
    { x: GATE_DOOR.x, width: GATE_DOOR.width, spring: GATE_DOOR.spring },
    { x: GATE_WINDOW.x, width: GATE_WINDOW.width, spring: GATE_WINDOW.spring, sill: GATE_WINDOW.sill },
    { x: -7.9, width: LOFT.width, spring: LOFT.spring, sill: LOFT.sill }, { x: 7.9, width: LOFT.width, spring: LOFT.spring, sill: LOFT.sill },
  ], 3);
  place(new THREE.Mesh(gateWall, wallPlaster), 0, 0, 10.12, true, true);
  place(new THREE.Mesh(softBox(21, 0.26, 1.04, 0.06, 3), capPlaster), 0, 7.72, 10.12, true);
  place(new THREE.Mesh(worldBox(20.7, 6.2, 0.8, 3), wallPlaster), 0, 3.1, -29.8, true, true);
  place(new THREE.Mesh(softBox(21, 0.26, 1.04, 0.06, 3), capPlaster), 0, 6.32, -29.8, true);
  {
    const door = gate(GATE_DOOR.x);
    doorSet(door, GATE_DOOR.width, GATE_DOOR.spring, 0.5, 8, shutterWood);
    doorCase(door, GATE_DOOR.width, GATE_DOOR.spring);
    place(new THREE.Mesh(new THREE.BoxGeometry(GATE_DOOR.width + 0.3, 3, 0.2), shade), GATE_DOOR.x, 1.5, 10.42, false, true);
    windowSet(gate(GATE_WINDOW.x), GATE_WINDOW.width, GATE_WINDOW.sill, GATE_WINDOW.spring, "barred", 10);
    place(new THREE.Mesh(new THREE.BoxGeometry(GATE_WINDOW.width + 0.3, 1.9, 0.2), shade), GATE_WINDOW.x, 2.2, 10.42, false, true);
    for (const x of [-7.9, 7.9]) {
      windowSet(gate(x), LOFT.width, LOFT.sill, LOFT.spring, "shutters", 12 + x, x > 0 ? -1 : 0);
      place(new THREE.Mesh(new THREE.BoxGeometry(LOFT.width + 0.3, 1.5, 0.2), shade), x, 5.3, 10.42, false, true);
      if (x > 0) swinging.loft = looseLeaf([x + LOFT.width / 2 + 0.045, LOFT.sill + 0.5, 9.66], Math.PI, -1, LOFT.width / 2 + 0.03, LOFT.spring - LOFT.sill + 0.2, 0.4);
    }
    footing(gate(-7.95), -1.45, -GATE_DOOR.width / 2 - 0.2 - 0.05, 17);
    footing(gate(-7.95), GATE_DOOR.width / 2 + 0.16, 1.6, 19);
    footing(gate(7.95), -1.6, 1.5, 21);
    // The trader's board over his door.
    const boardMap = track(boardTexture(2048, 512, "#1d5a57", "#e7cf9a", 41, (context) => {
      const W = 2048;
      fitFont(context, "CT SPAWN BAKERY", W - 500, 218);
      lettered(context, "CT SPAWN BAKERY", W / 2, 200, "#ecd7a4", 8);
      fitFont(context, "FRESH EVERY ROUND  \u00b7  ROTATE EARLY FOR THE WARM ONES", W - 260, 64, "600");
      lettered(context, "FRESH EVERY ROUND  \u00b7  ROTATE EARLY FOR THE WARM ONES", W / 2, 362, "#e39a4a");
      context.font = `italic 40px ${SERIF}`;
      lettered(context, "Court Gate No. 2   \u2014   first out of spawn since 1999", W / 2, 432, "#cfe3da");
      context.fillStyle = context.strokeStyle = "#e39a4a";
      for (const x of [140, W - 140]) { context.save(); context.translate(x, 200); wheatMark(context); context.restore(); }
    }));
    boardMap.anisotropy = anisotropy;
    // It hangs from its two hooks, tipped forward, and rocks on them when the wind gets behind it.
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.575, 0.05), [timber, timber, timber, timber, timber, standard({ map: boardMap, roughness: 0.7 })]);
    board.position.y = -0.2875;
    board.receiveShadow = true;
    board.userData.walkThrough = true;
    const hanger = new THREE.Group();
    hanger.position.set(GATE_DOOR.x, 4.006, 9.591);
    hanger.rotation.x = -0.1;
    hanger.add(board);
    scene.add(hanger);
    swinging.sign = life.sway(hanger, { amplitude: 0.06, period: 1.15, axis: "x", damping: 0.1, creak: "signCreak" });
    for (const side of [-1, 1]) door(iron, pipe([[side * 0.95, 4.1, 0], [side * 0.95, 4.08, 0.1], [side * 0.95, 3.98, 0.12]], 0.012, 5, 8));
  }
  // Merlons along the end wall and gatehouse, each under its own little coping.
  const merlons = [
    ...Array.from({ length: 10 }, (_, i) => [-9 + i * 2, 6.74, -29.8] as V3),
    ...Array.from({ length: 10 }, (_, i) => [-9 + i * 2, 8.14, 10.12] as V3),
  ];
  instances(softBox(0.9, 0.6, 0.8, 0.05, 3), wallPlaster, merlons.map((position) => ({ position })), false);
  instances(softBox(1.02, 0.09, 0.92, 0.03, 3), capPlaster, merlons.map(([x, y, z]) => ({ position: [x, y + 0.34, z] as V3 })), false);
  // Roof beams poke through the gatehouse and end wall, as on every building in town.
  const beamEnd = uvScale(new THREE.CylinderGeometry(0.075, 0.075, 1.5, 12), 1, 0.5, true);
  beamEnd.rotateX(Math.PI / 2);
  instances(beamEnd, darkTimber, [
    ...Array.from({ length: 13 }, (_, i) => ({ position: [-9 + i * 1.5, 6.9, 9.9] as V3 })),
    ...Array.from({ length: 13 }, (_, i) => ({ position: [-9 + i * 1.5, 5.55, -29.6] as V3 })),
  ], false);
  // Clay water spouts drain the roofs and wall walks; each has streaked the wall under it.
  const spoutGeometry = (() => {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, 0.075, Math.PI, 0, false); shape.lineTo(0.05, 0); shape.absarc(0, 0, 0.05, 0, Math.PI, true); shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.55, bevelEnabled: false, curveSegments: 8 });
    geometry.rotateX(0.16);
    geometry.translate(0, 0, -0.1);
    return geometry;
  })();
  const stainMap = track(stainTexture());
  const stain = standard({ map: stainMap, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const spout = (add: Add, streak: number) => {
    add(terracotta, spoutGeometry, [0, 0, 0], undefined, undefined, true);
    add(capPlaster, softBox(0.3, 0.2, 0.06, 0.02, 3), [0, 0.02, 0.02]);
    add(stain, new THREE.PlaneGeometry(0.5, streak), [0, -0.08 - streak / 2, 0.012]);
  };
  for (const z of [-4.5, -10.9, -17, -23.1]) spout(west(z, "west", false, 3.92), z === -4.5 ? 0.7 : 1.8);
  for (const z of [-9.35, -17, -23]) spout(east(z, "east", false, 3.92), 1.8);
  for (const x of [-8, -4, 4, 8]) spout(maker(xf([x, 5.9, -29.4]), "end"), 1.2);
  for (const x of [-8.9, 8.9]) spout(maker(xf([x, 6.95, 9.72], [0, Math.PI, 0]), "gate"), 1.6);

  // ---- Town beyond the walls -----------------------------------------------
  // [x, z, width, depth, height]
  const town: Array<[number, number, number, number, number]> = [
    [-19, 6, 10, 12, 8.5], [-21, -9, 12, 14, 11.5], [-18.5, -25, 9, 12, 7.8], [-27, -40, 16, 12, 13],
    [19.5, 8, 11, 12, 9.8], [20, -7, 10, 11, 7.2], [22, -22, 13, 13, 12.4], [27, -41, 14, 12, 9.5],
    [-8, -43, 14, 12, 10.5], [9, -45, 12, 12, 14.5], [0, 24, 22, 12, 11], [-24, 24, 16, 12, 9], [24, 25, 16, 12, 13],
    [-36, -12, 12, 30, 15], [37, -10, 12, 30, 16],
  ];
  const far = maker(null, "town");
  // The second row of roofs stands a street further off, so it is drawn a shade into the haze.
  const mid = [hazed(plasterMaterial(0xdcc09a), 0.13), hazed(plasterMaterial(0xcfae84), 0.13)];
  const midShade = hazed(standard({ color: 0x120d09, envMapIntensity: 0.1 }), 0.13);
  const streaks: Transform[] = [];
  const openings: Transform[] = [], surrounds: Transform[] = [], shutters: Transform[] = [], grilles: Transform[] = [], lintels: Transform[] = [], vigas: Transform[] = [], parapets: Transform[] = [], crenels: Transform[] = [], gargoyles: Transform[] = [];
  type Face = { along: "x" | "z"; at: number; normal: number; from: number; span: number };
  const townFaces: Face[][] = [];
  town.forEach(([x, z, w, d, h], index) => {
    // Hand-plastered corners are never sharp: the bodies are rounded off.
    place(new THREE.Mesh(softBox(w, h, d, 0.16, 3.4), index < 13 ? townPlaster[index % 3] : mid[index % 2]), x, h / 2, z, true);
    parapets.push({ position: [x, h + 0.22, z], scale: [w + 0.3, 1, d + 0.3] });
    // Windows on the faces that look into the court.
    const faces: Face[] = [];
    if (Math.abs(x) > 12) faces.push({ along: "z", at: x - Math.sign(x) * w / 2, normal: -Math.sign(x), from: z - d / 2, span: d });
    if (z < -32) faces.push({ along: "x", at: z + d / 2, normal: 1, from: x - w / 2, span: w });
    if (z > 14) faces.push({ along: "x", at: z - d / 2, normal: -1, from: x - w / 2, span: w });
    townFaces.push(faces);
    for (const face of faces) {
      const columns = Math.max(2, Math.floor(face.span / 3.1)), floors = Math.max(1, Math.floor((h - 2.2) / 3));
      const yaw = face.along === "z" ? face.normal * Math.PI / 2 : face.normal > 0 ? 0 : Math.PI;
      const at = (along: number, y: number, out = 0): V3 => face.along === "z" ? [face.at + face.normal * out, y, along] : [along, y, face.at + face.normal * out];
      for (let floor = 0; floor < floors; floor += 1) for (let column = 0; column < columns; column += 1) {
        if ((index * 7 + floor * 3 + column * 5) % 6 === 0) continue;
        const along = face.from + (column + 0.5) * (face.span / columns), y = 3.1 + floor * 3;
        openings.push({ position: at(along, y, 0.02), rotation: [0, yaw, 0] });
        // Dust washed off the sill has streaked the wall under some windows.
        if ((index * 5 + floor * 3 + column) % 3 === 0) streaks.push({ position: at(along + 0.1, y - 1.75, 0.04), rotation: [0, yaw, 0], scale: [1.7, 0.5, 1] });
        surrounds.push({ position: at(along, y), rotation: [0, yaw, 0] });
        if ((index + floor + column) % 4 === 1) lintels.push({ position: at(along, y + 1.02, 0.09), rotation: [0, yaw, 0] });
        const style = (index + floor + column) % 3;
        if (style !== 0) {
          for (const side of style === 1 ? [-1, 1] : [column % 2 ? 1 : -1]) shutters.push({ position: at(along + side * 0.8, y, 0.17), rotation: [0, yaw + side * 0.1 * (face.along === "z" ? -face.normal : face.normal), 0] });
        } else grilles.push({ position: at(along, y, 0.13), rotation: [0, yaw, 0] });
      }
      const rows = Math.floor(face.span / 1.1);
      for (let i = 0; i < rows; i += 1) {
        const along = face.from + (i + 0.5) * (face.span / rows);
        vigas.push({ position: at(along, h - 0.7, 0.3), rotation: [0, face.along === "z" ? Math.PI / 2 : 0, 0] });
      }
      // Stepped crenels on some roof edges and spouts through the parapet.
      if (index % 2 === 0) {
        const count = Math.floor(face.span / 1.5);
        for (let i = 0; i < count; i += 1) crenels.push({ position: at(face.from + (i + 0.5) * (face.span / count), h + 0.47, -0.2), rotation: [0, yaw, 0] });
      }
      for (let i = 0; i < 2; i += 1) {
        gargoyles.push({ position: at(face.from + face.span * (0.22 + i * 0.5), h - 0.25, 0), rotation: [0, yaw, 0] });
        streaks.push({ position: at(face.from + face.span * (0.22 + i * 0.5), h - 0.4 - 1.7, 0.04), rotation: [0, yaw, 0], scale: [1.2, 1, 1] });
      }
    }
  });
  instances(softBox(1, 0.5, 1, 0.08, 3.4), capPlaster, parapets, false);
  instances(new THREE.PlaneGeometry(0.6, 3.4), stain, streaks, false, false);
  instances(new THREE.BoxGeometry(1, 1.5, 0.12), shade, openings, false, false);
  {
    // Raised plaster architrave and a stone sill around each town window.
    const ring = new THREE.Shape();
    ring.moveTo(-0.66, -0.82); ring.lineTo(0.66, -0.82); ring.lineTo(0.66, 0.9); ring.lineTo(-0.66, 0.9); ring.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.5, -0.75); hole.lineTo(-0.5, 0.75); hole.lineTo(0.5, 0.75); hole.lineTo(0.5, -0.75); hole.closePath();
    ring.holes.push(hole);
    const architrave = projectUv(new THREE.ExtrudeGeometry(ring, { depth: 0.1, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 }), 3);
    const sill = new THREE.BoxGeometry(1.5, 0.1, 0.3).translate(0, -0.86, 0.14);
    const hood = new THREE.BoxGeometry(1.46, 0.08, 0.22).translate(0, 0.94, 0.1);
    instances(merge([architrave, projectUv(sill, 3), projectUv(hood, 3)]), capPlaster, surrounds, false, false);
    instances(shutterGeometry(0.56, 1.5, 9), shutterWood, shutters, false, false);
    const bars: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i += 1) bars.push(new THREE.BoxGeometry(0.022, 1.5, 0.022).translate(-0.42 + i * 0.168, 0, 0));
    for (const y of [-0.45, 0, 0.45]) bars.push(new THREE.BoxGeometry(1, 0.03, 0.012).translate(0, y, 0.012));
    instances(merge(bars), iron, grilles, false, false);
    const step = merge([softBox(0.8, 0.5, 0.36, 0.04, 3).translate(0, 0.25, 0), softBox(0.42, 0.3, 0.36, 0.04, 3).translate(0, 0.65, 0)]);
    instances(step, capPlaster, crenels, false, false);
    instances(spoutGeometry, terracotta, gargoyles, false, false);
  }
  instances(softBox(1.3, 0.16, 0.2, 0.03, 1.2), darkTimber, lintels, false, false);
  const viga = uvScale(new THREE.CylinderGeometry(0.09, 0.09, 0.9, 10), 1, 0.4, true);
  viga.rotateX(Math.PI / 2);
  instances(viga, darkTimber, vigas, false);

  // Street doors and an outside stair on the two houses seen through the arcade.
  {
    const westHouse = maker(xf([-14, 0, 4.0], [0, Math.PI / 2, 0]), "town", true);
    doorSet(westHouse, 1.2, 1.9, -0.05, 21, shutterWood);
    doorCase(westHouse, 1.2, 1.9);
    westHouse(brick, grain(new THREE.BoxGeometry(11.6, 0.9, 0.08), 1.2), [-2, 0.45, 0.03]);
    const eastHouse = maker(xf([14, 0, 5.9], [0, -Math.PI / 2, 0]), "town", true);
    doorSet(eastHouse, 1.2, 1.9, -0.05, 23);
    doorCase(eastHouse, 1.2, 1.9);
    eastHouse(brick, grain(new THREE.BoxGeometry(11.6, 0.9, 0.08), 1.2), [2.1, 0.45, 0.03]);
    // Stair climbing the house wall to an upper door.
    const steps = 11, rise = 0.2, run = 0.3;
    const profile = new THREE.Shape();
    profile.moveTo(0, 0);
    for (let i = 0; i < steps; i += 1) { profile.lineTo(i * run, (i + 1) * rise); profile.lineTo((i + 1) * run, (i + 1) * rise); }
    profile.lineTo(steps * run + 1.3, steps * rise); profile.lineTo(steps * run + 1.3, 0); profile.closePath();
    const stair = new THREE.ExtrudeGeometry(profile, { depth: 0.95, bevelEnabled: false });
    // Local x runs toward -z along the house wall; the flight starts near z = 13.6.
    const flight = maker(xf([14, 0, 13.6], [0, Math.PI / 2, 0]), "town", true);
    flight(townPlaster[1], projectUv(stair, 3), [0, 0, -0.95]);
    const railShape = new THREE.Shape();
    railShape.moveTo(0, 0.2); railShape.lineTo(steps * run, steps * rise + 0.2); railShape.lineTo(steps * run + 1.3, steps * rise + 0.2);
    railShape.lineTo(steps * run + 1.3, steps * rise + 0.95); railShape.lineTo(steps * run, steps * rise + 0.95); railShape.lineTo(0, 0.95); railShape.closePath();
    flight(townPlaster[1], projectUv(new THREE.ExtrudeGeometry(railShape, { depth: 0.16, bevelEnabled: false }), 3), [0, 0, -1.02]);
    const upper = maker(xf([14, steps * rise, 13.6 - steps * run - 0.65], [0, -Math.PI / 2, 0]), "town", true);
    doorSet(upper, 0.9, 1.75, -0.05, 27, shutterWood);
    doorCase(upper, 0.9, 1.75);
  }

  // Box balconies with turned-post screens on the taller houses.
  {
    const post = lathe([[0.012, 0], [0.03, 0.02], [0.03, 0.08], [0.016, 0.12], [0.034, 0.3], [0.016, 0.48], [0.03, 0.52], [0.03, 0.6], [0.016, 0.64], [0.034, 0.8], [0.016, 0.98], [0.03, 1.02], [0.03, 1.1], [0.012, 1.1]], 6);
    const balcony = (parent: THREE.Matrix4, width: number) => {
      const add = maker(parent, "town", true);
      add(darkTimber, grain(new THREE.BoxGeometry(width, 0.1, 0.95), 1.8), [0, 0, 0.475]);
      for (const x of [-width / 2 + 0.2, 0, width / 2 - 0.2]) add(darkTimber, grain(new THREE.BoxGeometry(0.1, 0.5, 0.1), 1.8, true), [x, -0.22, 0.4], [-0.75, 0, 0]);
      add(darkTimber, grain(new THREE.BoxGeometry(width, 0.07, 0.07), 1.8), [0, 1.2, 0.91]);
      add(darkTimber, grain(new THREE.BoxGeometry(width, 0.07, 0.07), 1.8), [0, 0.09, 0.91]);
      for (const side of [-1, 1]) {
        add(darkTimber, grain(new THREE.BoxGeometry(0.07, 2.3, 0.07), 1.8, true), [side * (width / 2 - 0.035), 1.15, 0.91]);
        add(darkTimber, grain(new THREE.BoxGeometry(0.07, 0.07, 0.9), 1.8), [side * (width / 2 - 0.035), 1.2, 0.46]);
        for (let i = 0; i < 6; i += 1) add(darkTimber, post, [side * (width / 2 - 0.035), 0.08, 0.1 + i * 0.14]);
      }
      const count = Math.floor((width - 0.14) / 0.12);
      for (let i = 0; i < count; i += 1) add(darkTimber, post, [-width / 2 + 0.1 + i * ((width - 0.2) / (count - 1)), 0.08, 0.91]);
      // Lean-to roof of boards on the corner posts.
      add(timber, grain(new THREE.BoxGeometry(width + 0.3, 0.04, 1.2), 1.8), [0, 2.36, 0.5], [0.2, 0, 0]);
      add(shade, new THREE.BoxGeometry(0.9, 1.9, 0.06), [0, 1.0, 0.03], undefined, undefined, false);
    };
    balcony(xf([-15, 7.3, -6.6], [0, Math.PI / 2, 0]), 2.4);
    balcony(xf([15.5, 7.4, -24.2], [0, -Math.PI / 2, 0]), 2.6);
    balcony(xf([14, 6.3, 9.9], [0, -Math.PI / 2, 0]), 2.2);
    balcony(xf([-8, 6.6, -37], [0, 0, 0]), 2.4);
  }

  // A dome and a slim tower close the far end of the court.
  place(new THREE.Mesh(new THREE.SphereGeometry(4.2, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), capPlaster), 9, 15.6, -45, true);
  place(new THREE.Mesh(uvScale(new THREE.CylinderGeometry(4.35, 4.35, 1.1, 48), 8, 0.4), townPlaster[0]), 9, 15.05, -45, true);
  {
    // Cornice rings, drum windows and a stacked finial on the dome.
    far(capPlaster, new THREE.TorusGeometry(4.36, 0.1, 6, 48).rotateX(Math.PI / 2), [9, 15.6, -45]);
    far(capPlaster, new THREE.TorusGeometry(4.4, 0.08, 6, 48).rotateX(Math.PI / 2), [9, 14.52, -45]);
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      far(shade, new THREE.BoxGeometry(0.42, 0.62, 0.1), [9 + Math.sin(a) * 4.33, 15.05, -45 + Math.cos(a) * 4.33], [0, a, 0]);
    }
    far(metals.brushed, lathe([[0, 0], [0.3, 0], [0.34, 0.1], [0.12, 0.3], [0.1, 0.5], [0.26, 0.72], [0.1, 0.95], [0.07, 1.1], [0.17, 1.26], [0.06, 1.42], [0.03, 1.9], [0, 2.0]], 14), [9, 19.75, -45]);
    // Tower: belfry stage, balcony ring on corbels, slit windows, ribbed cap.
    far(capPlaster, softBox(3.5, 0.3, 3.5, 0.06, 3.4), [-8.5, 12.2, -39.2]);
    const corbel = softBox(0.24, 0.5, 0.5, 0.04, 3.4);
    for (let i = 0; i < 4; i += 1) for (const offset of [-1.1, 0, 1.1]) {
      const a = i * Math.PI / 2;
      far(capPlaster, corbel, [-8.5 + Math.sin(a) * 1.72 + Math.cos(a) * offset, 16.95, -39.2 + Math.cos(a) * 1.72 - Math.sin(a) * offset], [0, a, 0]);
      far(shade, new THREE.BoxGeometry(0.3, 1.2, 0.08), [-8.5 + Math.sin(a) * 1.5 + Math.cos(a) * offset * 0.5, 6 + (offset + 1.1) * 3.4, -39.2 + Math.cos(a) * 1.5 - Math.sin(a) * offset * 0.5], [0, a, 0]);
    }
    for (let i = 0; i < 4; i += 1) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      far(capPlaster, rod([-8.5 + Math.sin(a) * 2.5, 17.6, -39.2 + Math.cos(a) * 2.5], [-8.5 + Math.sin(a) * 2.5, 18.6, -39.2 + Math.cos(a) * 2.5], 0.09, 8));
      far(capPlaster, new THREE.SphereGeometry(0.15, 10, 8), [-8.5 + Math.sin(a) * 2.5, 18.7, -39.2 + Math.cos(a) * 2.5]);
    }
    for (let i = 0; i < 4; i += 1) {
      const a = i * Math.PI / 2;
      far(darkTimber, new THREE.BoxGeometry(3.6, 0.07, 0.07), [-8.5 + Math.sin(a) * 1.8, 18.5, -39.2 + Math.cos(a) * 1.8], [0, a, 0]);
    }
    far(metals.brushed, lathe([[0, 0], [0.14, 0], [0.16, 0.06], [0.06, 0.2], [0.14, 0.4], [0.04, 0.6], [0.02, 1.1], [0, 1.15]], 12), [-8.5, 25.9, -39.2]);
  }
  place(new THREE.Mesh(softBox(3, 21, 3, 0.09, 3.4), townPlaster[2]), -8.5, 10.5, -39.2, true);
  for (const y of [5.2, 8.7]) far(capPlaster, softBox(3.22, 0.2, 3.22, 0.05, 3.4), [-8.5, y, -39.2]);
  place(new THREE.Mesh(softBox(3.7, 0.4, 3.7, 0.08, 3.4), capPlaster), -8.5, 17.4, -39.2, true);
  place(new THREE.Mesh(archedWall(3, 3.2, 3, [{ x: 0, width: 1.5, spring: 1.4, sill: 0.5 }], 3.4), townPlaster[2]), -8.5, 21, -39.2, true);
  place(new THREE.Mesh(new THREE.SphereGeometry(1.75, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2), capPlaster), -8.5, 24.2, -39.2, true);

  // Far skyline. Each layer is a little further into the air: its lit colour is mixed toward the
  // haze by a fixed amount on top of the scene fog, so near roofs, the rows behind them and the
  // upper town separate by tone the way they do in desert light.
  {
    // Roofs flanking the court and behind the gatehouse.
    const skyline: Array<[number, number, number, number, number, number]> = [
      [-52, -34, 16, 14, 12, 0], [-58, -6, 14, 20, 17, 1], [-54, 22, 18, 16, 11, 0], [52, -36, 18, 14, 14, 1], [58, -8, 14, 22, 12, 0], [54, 22, 16, 18, 16, 1],
      [-30, 46, 20, 14, 12, 1], [0, 50, 22, 14, 15, 0], [30, 46, 18, 14, 11, 0],
    ];
    const near = maker(null, "skyline");
    skyline.forEach(([x, z, w, d, h, tone], index) => {
      near(mid[tone], worldBox(w, h, d, 3.4), [x, h / 2, z]);
      near(mid[1 - tone], worldBox(w + 0.5, 0.6, d + 0.5, 3.4), [x, h + 0.2, z]);
      const facing = Math.abs(x) > Math.abs(z + 10) ? [-Math.sign(x), 0] : [0, z < -10 ? 1 : -1];
      for (let floor = 0; floor < Math.floor((h - 3) / 3.2); floor += 1) {
        const span = facing[0] ? d : w, columns = Math.floor(span / 3.4);
        for (let column = 0; column < columns; column += 1) {
          if ((index + floor * 2 + column) % 4 === 0) continue;
          const along = (column + 0.5 - columns / 2) * (span / columns);
          near(midShade, new THREE.BoxGeometry(facing[0] ? 0.16 : 1, 1.5, facing[0] ? 1 : 0.16), [x + facing[0] * w / 2 + (facing[0] ? 0 : along), 4 + floor * 3.2, z + facing[1] * d / 2 + (facing[1] ? 0 : along)]);
        }
      }
      if (index % 3 === 1) {
        near(mid[1 - tone], new THREE.SphereGeometry(Math.min(w, d) * 0.3, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), [x, h + 1.0, z]);
        near(mid[tone], uvScale(new THREE.CylinderGeometry(Math.min(w, d) * 0.31, Math.min(w, d) * 0.31, 0.9, 24), 6, 0.3), [x, h + 0.55, z]);
      }
    });

    // The upper town: houses stepping up a rise beyond the far end toward the rocks on the horizon,
    // each row higher and paler than the one in front, with a citadel, two minarets and a few domes.
    const rise = (z: number) => Math.max(0, (-z - 52) * 0.55);
    const tiers = [
      { tones: [hazed(plasterMaterial(0xd9bd96, 0.8), 0.24), hazed(plasterMaterial(0xcbab82, 0.8), 0.24)], dark: hazed(standard({ color: 0x1a130d, envMapIntensity: 0.1 }), 0.24) },
      { tones: [hazed(plasterMaterial(0xdcc29e, 0.6), 0.38), hazed(plasterMaterial(0xd0b28c, 0.6), 0.38)], dark: hazed(standard({ color: 0x1a130d, envMapIntensity: 0.1 }), 0.38) },
    ];
    const r = rng(77);
    const house = (add: Add, tier: typeof tiers[number], x: number, z: number, w: number, d: number, h: number, index: number) => {
      const base = rise(z), top = base + h, tone = tier.tones[index % 2], other = tier.tones[(index + 1) % 2];
      add(tone, worldBox(w, top, d, 3.4), [x, top / 2, z]);
      // Parapet: a low wall round the roof, sometimes stepped at the corners.
      add(other, worldBox(w + 0.36, 0.7, d + 0.36, 3.4), [x, top + 0.2, z]);
      if (index % 3 === 0) for (const sx of [-1, 1]) add(other, worldBox(0.9, 0.7, 0.9, 3.4), [x + sx * (w / 2 - 0.3), top + 0.85, z + d / 2 - 0.3]);
      // An upper room set back on the roof.
      if (index % 5 < 2) add(other, worldBox(w * 0.46, 3.1, d * 0.6, 3.4), [x + (index % 2 ? 1 : -1) * w * 0.22, top + 1.75, z - d * 0.12]);
      // Windows on the face toward the court and the sunlit flank.
      const floors = Math.max(1, Math.floor(h / 3.1)), columns = Math.max(2, Math.floor(w / 2.7));
      for (let floor = 0; floor < floors; floor += 1) for (let column = 0; column < columns; column += 1) {
        if ((index * 3 + floor * 5 + column * 7) % 5 < 2) continue;
        const tall = (index + column) % 4 === 0;
        add(tier.dark, new THREE.BoxGeometry(tall ? 0.7 : 0.95, tall ? 1.9 : 1.3, 0.3), [x + (column + 0.5 - columns / 2) * (w / columns), top - 1.9 - floor * 3.1, z + d / 2]);
      }
      for (let floor = 0; floor < floors; floor += 1) if ((index + floor) % 2 === 0) add(tier.dark, new THREE.BoxGeometry(0.3, 1.3, 0.95), [x + w / 2, top - 1.9 - floor * 3.1, z + (r() - 0.5) * d * 0.5]);
      // Roof beams poking through under the parapet.
      for (let i = 0; i < Math.floor(w / 1.6); i += 1) add(tier.dark, new THREE.BoxGeometry(0.16, 0.16, 0.7), [x - w / 2 + 0.8 + i * 1.6, top - 0.55, z + d / 2 + 0.2]);
    };
    for (let row = 0; row < 5; row += 1) {
      const tier = tiers[row < 2 ? 0 : 1], add = maker(null, row < 2 ? "upper-a" : "upper-b"), reach = 56 + row * 7;
      let x = -reach + r() * 4, index = row * 11;
      while (x < reach) {
        const w = 7 + r() * 7, d = 8 + r() * 4, h = 6.5 + r() * 4.5 + (r() < 0.14 ? 5 : 0), z = -62 - row * 10 + (r() - 0.5) * 3;
        house(add, tier, x + w / 2, z, w, d, h, index);
        x += w + (r() < 0.3 ? 1 + r() * 2.5 : 0.04);
        index += 1;
      }
    }
    const landmark = maker(null, "upper-b"), crown = tiers[1];
    // Citadel on the crest: a keep between four corner towers.
    {
      const x = -24, z = -112, base = rise(z);
      landmark(crown.tones[0], worldBox(24, base + 13, 14, 3.4), [x, (base + 13) / 2, z]);
      landmark(crown.tones[1], worldBox(24.5, 0.8, 14.5, 3.4), [x, base + 13.2, z]);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        landmark(crown.tones[1], worldBox(4.4, base + 18, 4.4, 3.4), [x + sx * 11.5, (base + 18) / 2, z + sz * 6.5]);
        landmark(crown.tones[0], worldBox(5, 0.9, 5, 3.4), [x + sx * 11.5, base + 18.2, z + sz * 6.5]);
        for (const mx of [-1, 1]) for (const mz of [-1, 1]) landmark(crown.tones[0], worldBox(1.1, 1.1, 1.1, 3.4), [x + sx * 11.5 + mx * 1.95, base + 19.1, z + sz * 6.5 + mz * 1.95]);
      }
      for (let i = 0; i < 9; i += 1) landmark(crown.tones[1], worldBox(1.3, 1.1, 0.8, 3.4), [x - 8 + i * 2, base + 14.1, z + 6.9]);
      for (let i = 0; i < 6; i += 1) landmark(crown.dark, new THREE.BoxGeometry(0.6, 2.2, 0.3), [x - 7.5 + i * 3, base + 8.5, z + 7]);
      landmark(crown.dark, new THREE.BoxGeometry(3, 5.5, 0.3), [x, base + 2.75, z + 7]);
    }
    // Minarets and domes among the roofs.
    const minaret = (x: number, z: number, height: number, tier: typeof tiers[number], add: Add) => {
      const base = rise(z), top = base + height;
      add(tier.tones[0], worldBox(2.8, top, 2.8, 3.4), [x, top / 2, z]);
      add(tier.tones[1], worldBox(4, 0.5, 4, 3.4), [x, top - 5, z]);
      add(tier.tones[1], worldBox(3.2, 0.4, 3.2, 3.4), [x, top + 0.2, z]);
      add(tier.dark, new THREE.BoxGeometry(0.8, 2.2, 0.3), [x, top - 2.4, z + 1.4]);
      for (const side of [-1, 1]) add(tier.dark, new THREE.BoxGeometry(0.3, 2.2, 0.8), [x + side * 1.4, top - 2.4, z]);
      for (let i = 0; i < 3; i += 1) add(tier.dark, new THREE.BoxGeometry(0.4, 1.4, 0.3), [x, base + 6 + i * 5, z + 1.4]);
      add(tier.tones[1], new THREE.SphereGeometry(1.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), [x, top + 0.4, z], undefined, [1, 1.25, 1]);
      add(tier.dark, rod([x, top + 2.1, z], [x, top + 3.4, z], 0.07, 5));
    };
    minaret(31, -76, 30, tiers[0], maker(null, "upper-a"));
    minaret(-47, -92, 27, crown, landmark);
    for (const [x, z, radius, tier] of [[12, -66, 3.4, 0], [-37, -74, 2.8, 0], [26, -96, 3.6, 1], [-6, -88, 3, 1], [50, -84, 2.6, 1]] as number[][]) {
      const add = maker(null, tier ? "upper-b" : "upper-a"), set = tiers[tier], y = rise(z) + 12.5;
      add(set.tones[1], worldBox(radius * 2.3, y, radius * 2.3, 3.4), [x, y / 2, z]);
      add(set.tones[0], uvScale(new THREE.CylinderGeometry(radius * 1.02, radius * 1.02, 1.2, 20), 6, 0.4), [x, y + 0.6, z]);
      add(set.tones[1], new THREE.SphereGeometry(radius, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2), [x, y + 1.2, z]);
      for (let i = 0; i < 8; i += 1) { const a = (i / 8) * Math.PI * 2; add(set.dark, new THREE.BoxGeometry(0.4, 0.7, 0.2), [x + Math.sin(a) * radius, y + 0.6, z + Math.cos(a) * radius], [0, a, 0]); }
    }
  }

  // Roofscape: water tanks, dishes, aerials, stair huts and washing lines.
  {
    const roof = maker(null, "town", false);
    const tank = uvScale(lathe([[0, 0], [0.55, 0], [0.56, 0.02], [0.56, 0.4], [0.578, 0.42], [0.578, 0.45], [0.56, 0.47], [0.56, 0.85], [0.578, 0.87], [0.578, 0.9], [0.56, 0.92], [0.56, 1.2], [0.4, 1.32], [0.14, 1.36], [0.14, 1.41], [0, 1.41]], 22), 2, 1);
    const dish = lathe([[0, 0], [0.15, 0.012], [0.3, 0.05], [0.45, 0.115], [0.5, 0.145], [0.5, 0.155], [0.44, 0.125], [0.3, 0.065], [0.15, 0.027], [0, 0.015]], 22);
    town.slice(0, 13).forEach(([x, z, w, d, h], index) => {
      const top = h + 0.47;
      // Point on the roof nearest the court, and a scatter around it.
      const cx = THREE.MathUtils.clamp(0, x - w / 2 + 1.2, x + w / 2 - 1.2), cz = THREE.MathUtils.clamp(-9.5, z - d / 2 + 1.2, z + d / 2 - 1.2);
      const spot = (pull: number): [number, number] => [THREE.MathUtils.lerp(x + (random() - 0.5) * (w - 2.4), cx, pull), THREE.MathUtils.lerp(z + (random() - 0.5) * (d - 2.4), cz, pull * 0.4)];
      const alongZ = Math.abs(x) > 12;
      {
        const [tx, tz] = spot(0.75);
        for (const [lx, lz] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) roof(iron, rod([tx + lx, top, tz + lz], [tx + lx * 0.9, top + 0.9, tz + lz * 0.9], 0.03, 5));
        for (const turn of [0, Math.PI / 2]) roof(iron, new THREE.BoxGeometry(1.0, 0.05, 0.05), [tx, top + 0.45, tz], [0, turn + Math.PI / 4, 0]);
        roof(iron, new THREE.BoxGeometry(1.1, 0.05, 1.1), [tx, top + 0.92, tz]);
        roof(tankMetal, tank, [tx, top + 0.95, tz], [0, index, 0]);
        roof(iron, pipe([[tx + 0.5, top + 1.1, tz], [tx + 0.72, top + 1.05, tz], [tx + 0.74, top + 0.3, tz], [tx + 0.74, top, tz]], 0.03, 6, 10));
      }
      if (index % 2 === 0) {
        const [dx, dz] = spot(0.9), yaw = index * 1.7;
        roof(iron, rod([dx, top, dz], [dx, top + 1.1, dz], 0.03, 6));
        roof(tankMetal, dish, [dx, top + 1.15, dz], [1.0, yaw, 0], 1.3);
        roof(iron, rod([dx, top + 1.1, dz], [dx - Math.sin(yaw) * 0.5, top + 1.75, dz - Math.cos(yaw) * 0.5], 0.012, 4));
      }
      if (index % 3 !== 1) {
        const [ax, az] = spot(0.6), mast = 2.6 + random() * 1.6;
        roof(iron, rod([ax, top, az], [ax, top + mast, az], 0.022, 5));
        roof(iron, new THREE.BoxGeometry(1.5, 0.025, 0.025), [ax, top + mast - 0.2, az], [0, index, 0]);
        for (let i = 0; i < 6; i += 1) roof(iron, new THREE.BoxGeometry(0.014, 0.014, 0.7 - i * 0.06), [ax + Math.cos(index) * (-0.7 + i * 0.27), top + mast - 0.2, az - Math.sin(index) * (-0.7 + i * 0.27)], [0, index, 0]);
      }
      if (index % 4 !== 3 && high) {
        // Washing line near the court-side edge.
        const [wx, wz] = spot(0.95), length = 3.4;
        const ends: V3[] = alongZ ? [[wx, top + 1.9, wz - length / 2], [wx, top + 1.9, wz + length / 2]] : [[wx - length / 2, top + 1.9, wz], [wx + length / 2, top + 1.9, wz]];
        for (const end of ends) {
          roof(darkTimber, rod([end[0], top, end[2]], [end[0], end[1] + 0.08, end[2]], 0.04, 6));
          roof(darkTimber, new THREE.BoxGeometry(alongZ ? 0.6 : 0.05, 0.05, alongZ ? 0.05 : 0.6), [end[0], end[1], end[2]]);
        }
        roof(rope, cable(ends[0], ends[1], 0.12, 0.008, 10, 4));
        for (let i = 0; i < 4; i += 1) {
          const t = 0.14 + i * 0.24, sagAt = 0.12 * 4 * t * (1 - t), dye = DYES[(index * 3 + i * 5) % DYES.length];
          washing.push({
            at: [THREE.MathUtils.lerp(ends[0][0], ends[1][0], t), ends[0][1] - sagAt, THREE.MathUtils.lerp(ends[0][2], ends[1][2], t)], yaw: alongZ ? Math.PI / 2 : 0,
            kind: (index + i) % 3 === 0 ? "tunic" : "sheet", width: 0.62 + random() * 0.2, drop: 0.7 + random() * 0.5, colour: dye, stripe: (index + i) % 4 === 1 ? DYES[(index + i) % 3] : undefined,
          });
        }
      }
      if (index % 3 === 0) {
        // Stair hut with a boarded door.
        const hx = x + (x > 0 ? 1 : -1) * (w / 2 - 2.2) * (Math.abs(x) > 12 ? 1 : 0.3), hz = z + d * 0.2;
        roof(townPlaster[(index + 1) % 3], worldBox(2.2, 2.3, 2.4, 3.4), [hx, top + 1.15, hz]);
        roof(capPlaster, new THREE.BoxGeometry(2.5, 0.14, 2.7), [hx, top + 2.35, hz]);
        roof(darkTimber, grain(new THREE.BoxGeometry(0.06, 1.8, 0.85), 1.8, true), [hx - Math.sign(x || 1) * 1.11, top + 0.9, hz]);
      }
    });
    // Shapes for the roofline nearest the court: reed-roofed pergolas on the two low houses, a
    // wind tower on the tall east house and a cupola on the tall west one.
    const pergola = (x: number, y: number, z: number, w: number, d: number) => {
      for (const sx of [-1, 1]) for (const sz of [-1, 0, 1]) roof(darkTimber, rod([x + sx * w / 2, y, z + sz * d / 2], [x + sx * w / 2, y + 2.3, z + sz * d / 2], 0.06, 6));
      for (const sx of [-1, 1]) roof(darkTimber, grain(new THREE.BoxGeometry(0.1, 0.14, d + 0.5), 1.8), [x + sx * w / 2, y + 2.36, z]);
      const poles = Math.round(d / 0.3);
      for (let i = 0; i <= poles; i += 1) {
        const at = z - d / 2 + (i / poles) * d;
        roof(timber, rod([x - w / 2 - 0.35, y + 2.47 + (i % 2) * 0.014, at], [x + w / 2 + 0.3 + random() * 0.2, y + 2.47 + (i % 3) * 0.012, at + (random() - 0.5) * 0.07], 0.028, 5));
      }
      // A cloth slung under one bay and a bench below it.
      roof(indigo, uvScale(clothGeometry(w - 0.3, d * 0.42, 0.22, 0.02), w / 0.6, d * 0.42 / 0.6), [x, y + 2.3, z - d * 0.24]);
      roof(darkTimber, grain(new THREE.BoxGeometry(0.4, 0.06, 1.5), 1.8), [x + w / 2 - 0.3, y + 0.45, z + d * 0.2]);
      for (const sz of [-0.6, 0.6]) roof(darkTimber, new THREE.BoxGeometry(0.36, 0.45, 0.06), [x + w / 2 - 0.3, y + 0.225, z + d * 0.2 + sz]);
    };
    pergola(-15.7, 8.97, 9, 2.6, 4.6);
    pergola(16.7, 7.67, -3.9, 2.6, 4);
    {
      const x = 17.3, z = -26, y = 12.87;
      roof(townPlaster[0], softBox(2.3, 5.6, 2.3, 0.08, 3.4), [x, y + 2.8, z], undefined, undefined, true);
      roof(capPlaster, softBox(2.7, 0.22, 2.7, 0.05, 3.4), [x, y + 5.7, z]);
      roof(capPlaster, softBox(2.5, 0.16, 2.5, 0.05, 3.4), [x, y + 2.9, z]);
      for (let i = 0; i < 4; i += 1) {
        const a = i * Math.PI / 2;
        for (const offset of [-0.62, 0, 0.62]) roof(shade, new THREE.BoxGeometry(0.36, 2.1, 0.1), [x + Math.sin(a) * 1.13 + Math.cos(a) * offset, y + 4.3, z + Math.cos(a) * 1.13 - Math.sin(a) * offset], [0, a, 0]);
        roof(capPlaster, softBox(0.3, 0.5, 0.3, 0.04, 3.4), [x + Math.sin(a + Math.PI / 4) * 1.7, y + 6.0, z + Math.cos(a + Math.PI / 4) * 1.7]);
      }
    }
    {
      const x = -18.6, z = -4.6, y = 11.97;
      roof(townPlaster[2], softBox(3.3, 1.3, 3.3, 0.08, 3.4), [x, y + 0.65, z], undefined, undefined, true);
      roof(capPlaster, softBox(3.6, 0.16, 3.6, 0.05, 3.4), [x, y + 1.36, z]);
      roof(capPlaster, new THREE.SphereGeometry(1.5, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), [x, y + 1.42, z], undefined, [1, 1.12, 1], true);
      roof(metals.brushed, lathe([[0, 0], [0.12, 0], [0.14, 0.05], [0.05, 0.16], [0.11, 0.32], [0.03, 0.48], [0.015, 0.85], [0, 0.9]], 10), [x, y + 3.08, z]);
      for (let i = 0; i < 4; i += 1) { const a = i * Math.PI / 2; roof(shade, new THREE.BoxGeometry(0.5, 0.6, 0.1), [x + Math.sin(a) * 1.62, y + 0.7, z + Math.cos(a) * 1.62], [0, a, 0]); }
    }
  }

  // Timber poles carry power and telephone lines along the lanes outside the walls.
  {
    const lines = maker(null, "wires", false);
    const poles: V3[] = [[-11.7, 8.6, -9.6], [-11.9, 8.2, -27.4], [-11.5, 8.4, 11.6], [11.6, 8.5, -14.6], [11.9, 8.2, -30.2], [11.5, 8.4, 11.2]];
    poles.forEach(([x, height, z], index) => {
      lines(darkTimber, rod([x, 0, z], [x + (index % 2 ? 0.12 : -0.1), height, z], 0.11, 8, 0.075), undefined, undefined, undefined, true);
      for (const [y, half] of [[height - 0.35, 0.75], [height - 0.95, 0.55]]) {
        lines(darkTimber, grain(new THREE.BoxGeometry(half * 2, 0.09, 0.09), 1.8), [x, y, z]);
        for (const side of [-1, 0, 1]) if (side !== 0 || half > 0.6) lines(glazed, lathe([[0, 0], [0.03, 0], [0.045, 0.03], [0.03, 0.06], [0.045, 0.09], [0.02, 0.13], [0, 0.13]], 8), [x + side * (half - 0.08), y + 0.045, z]);
        lines(iron, rod([x, y - 0.45, z], [x + half * 0.7, y - 0.04, z], 0.012, 4));
      }
      if (index % 3 === 0) lines(tankMetal, uvScale(new THREE.CylinderGeometry(0.2, 0.2, 0.55, 12), 2, 1), [x + 0.3, height - 1.7, z]);
    });
    const wire = standard({ color: 0x15130f, roughness: 0.6 });
    const string = (a: number, b: number, sag: number) => {
      for (const [offset, drop] of [[-0.67, 0.3], [0, 0.3], [0.67, 0.3], [-0.47, 0.9], [0.47, 0.9]]) {
        lines(wire, cable([poles[a][0] + offset, poles[a][1] - drop, poles[a][2]], [poles[b][0] + offset, poles[b][1] - drop, poles[b][2]], sag, 0.011, 16, 4));
      }
    };
    string(0, 1, 0.5); string(2, 0, 0.6); string(3, 4, 0.5); string(5, 3, 0.7);
    // Service drops to the houses and one long span over the court.
    const drops: Array<[V3, V3, number]> = [
      [[-11.7, 7.7, -9.6], [-15, 9.6, -6], 0.3], [[-11.7, 7.7, -9.6], [-14, 7.2, -21], 0.5], [[-11.5, 7.5, 11.6], [-14, 7.6, 8], 0.2],
      [[11.6, 7.6, -14.6], [15.5, 9.8, -18], 0.3], [[11.6, 7.6, -14.6], [15, 6.7, -8], 0.25], [[11.5, 7.5, 11.2], [14, 8.6, 9], 0.2],
      [[-11.7, 8.25, -9.6], [11.6, 8.15, -14.6], 0.9], [[-11.5, 8.0, 11.6], [-9.9, 7.5, 10.1], 0.1], [[11.5, 8.0, 11.2], [9.9, 7.5, 10.1], 0.1],
    ];
    for (const [a, b, sag] of drops) lines(wire, cable(a, b, sag, 0.011, 18, 4));
  }

  // ---- Awnings -------------------------------------------------------------
  const cloths: Array<{ z: number; depth: number; sag: number; map: THREE.Texture }> = [
    { z: 3.4, depth: 3.4, sag: 1.0, map: track(stripeTexture("#e3d6ba", "#2f8f88", "#d79a45", 91)) },
    { z: -5.6, depth: 2.6, sag: 0.8, map: track(stripeTexture("#d8a25a", "#eadfc6", "#8a4a22", 92)) },
    { z: -12.6, depth: 3.6, sag: 1.15, map: track(stripeTexture("#e9dfc9", "#c9772d", "#2f8f88", 93)) },
    { z: -20.2, depth: 2.8, sag: 0.9, map: track(stripeTexture("#2f8f88", "#eadfc6", "#d79a45", 94)) },
  ];
  const clothBoxes: THREE.Box3[] = [];
  const rig = maker(null, "rig", false);
  const WEAVE = 0.6, STRIPE_WEAVE = 1.2, STRIPE_RUN = 1.7;
  const poleTops: Record<number, V3[]> = { [-1]: [], 1: [] };
  cloths.forEach(({ z, depth, sag, map }, clothIndex) => {
    // The cloth's UVs are in metres so the weave tiles finely; one tile of the stripe map is 1.2 m of weave by a 1.7 m run of stripes.
    map.repeat.set(WEAVE / STRIPE_WEAVE, WEAVE / STRIPE_RUN);
    map.anisotropy = anisotropy;
    // The underside glows with the light that soaks through the weave.
    const material = standard({ map, vertexColors: true, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.24, normalMap: fabricSet.normalMap, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.4 });
    const awning = awningGeometry(18.9, depth, sag, WEAVE, STRIPE_RUN, 0.75, 40 + clothIndex, high ? 0.16 : 0.3);
    const mesh = place(new THREE.Mesh(awning.geometry, material), 0, 6.5, z, true);
    mesh.receiveShadow = false;
    clothBoxes.push(new THREE.Box3(new THREE.Vector3(-8.6, 5.3, z - depth / 2), new THREE.Vector3(8.6, 6.5, z + depth / 2)));
    // Lashed along its battens, free in the belly: the wind works it by how far each part hangs below them.
    // Its shadow on the ground is the cloth at rest. The first and third crack when a gust fills them.
    const billow = life.cloth(material, { amplitude: 0.1, frequency: 0.5, flutter: 0.7, lean: 0, pin: { height: 6.5, reach: sag * 0.85 } });
    if (clothIndex % 2 === 0) billow.snap([clothIndex ? 5 : -4, 5.7, z]);
    // The rope sewn into each long hem comes out of it at the corners and runs up to the poles.
    for (const end of [-1, 1]) for (const side of [-1, 1]) {
      const tail: V3[] = [[side * 9.8, 6.8, z + end * (depth / 2 + 0.12)]];
      for (const u of [1, 0.95, 0.9, 0.85]) tail.push([side * u * 9.45, 6.5 + awning.height(side * u, end) + 0.004, z + end * depth / 2]);
      rig(rope, pipe(tail, 0.015, 5, 14));
    }
    for (const side of [-1, 1]) {
      // Spreader batten laced into the short edge.
      rig(timber, rod([side * 9.45, 6.5, z - depth / 2 - 0.16], [side * 9.45, 6.5, z + depth / 2 + 0.16], 0.028, 8), undefined, undefined, undefined, true);
      const ties = Math.round(depth / 0.42);
      for (let i = 0; i <= ties; i += 1) rig(rope, new THREE.TorusGeometry(0.04, 0.008, 4, 10), [side * 9.45, 6.5, z - depth / 2 + (i / ties) * depth]);
      for (const end of [-1, 1]) {
        const px = side * 9.8, pz = z + end * (depth / 2 + 0.12);
        rig(timber, rod([px, 5.42, pz], [px, 6.95, pz], 0.055, 10, 0.042), undefined, undefined, undefined, true);
        rig(timber, new THREE.SphereGeometry(0.058, 10, 8), [px, 6.98, pz]);
        rig(iron, new THREE.CylinderGeometry(0.075, 0.085, 0.14, 10), [px, 5.49, pz]);
        rig(iron, new THREE.CylinderGeometry(0.052, 0.052, 0.04, 10), [px, 6.8, pz]);
        for (const turn of [0, Math.PI / 2]) rig(iron, new THREE.BoxGeometry(0.34, 0.02, 0.05), [px, 5.432, pz], [0, turn, 0]);
        // Guy line to a ring let into the coping.
        const anchor: V3 = [side * 10.36, 5.45, pz + end * 1.15];
        rig(rope, cable([px, 6.86, pz], anchor, 0.05, 0.011, 8, 4));
        rig(iron, new THREE.TorusGeometry(0.04, 0.009, 5, 12), [anchor[0], anchor[1], anchor[2]], [0, Math.PI / 2, 0]);
        poleTops[side].push([px, 6.9, pz]);
      }
    }
  });
  // A ridge line ties the poles together along each wall.
  for (const side of [-1, 1]) {
    const tops = poleTops[side].sort((a, b) => a[2] - b[2]);
    for (let i = 0; i < tops.length - 1; i += 1) rig(rope, cable(tops[i], tops[i + 1], Math.abs(tops[i + 1][2] - tops[i][2]) * 0.05, 0.01, 10, 4));
  }
  // Hauling falls: block at the pole, rope down the wall to a cleat, the spare coiled on it.
  const fall = (side: number, z: number) => {
    rig(iron, new THREE.BoxGeometry(0.03, 0.16, 0.1), [side * 9.66, 6.56, z]);
    rig(timber, new THREE.CylinderGeometry(0.055, 0.055, 0.045, 12).rotateZ(Math.PI / 2), [side * 9.66, 6.55, z]);
    rig(iron, rod([side * 9.8, 6.78, z], [side * 9.66, 6.62, z], 0.008, 4));
    rig(rope, pipe([[side * 9.45, 6.5, z], [side * 9.62, 6.5, z], [side * 9.67, 6.5, z + 0.02], [side * 9.6, 6.2, z + 0.03], [side * 9.37, 5.52, z + 0.03], [side * 9.375, 5.2, z + 0.03], [side * 9.45, 4.95, z + 0.03], [side * 9.455, 3, z + 0.03], [side * 9.46, 1.56, z + 0.03]], 0.012, 5, 40));
    rig(iron, new THREE.BoxGeometry(0.07, 0.05, 0.3), [side * 9.5, 1.55, z + 0.03]);
    rig(iron, new THREE.BoxGeometry(0.1, 0.1, 0.04), [side * 9.52, 1.55, z + 0.03]);
    for (let i = 0; i < 4; i += 1) rig(rope, new THREE.TorusGeometry(0.13 + i * 0.006, 0.013, 5, 20).rotateY(Math.PI / 2), [side * (9.46 - i * 0.012), 1.4 - i * 0.012, z + 0.03], [0.08 * i, 0, 0]);
  };
  fall(-1, -6.9 - 0.12); fall(-1, -21.6 - 0.12); fall(1, -6.9 - 0.12);

  // Rugs and a blanket aired over the wall tops.
  {
    const rugA = track(rugTexture({ field: "#7c2f22", border: "#1f4f55", line: "#e3c58f", a: "#d58a2e", b: "#b5452c" }, 3));
    const rugB = track(rugTexture({ field: "#1f4f55", border: "#7c2f22", line: "#ead9ae", a: "#c9772d", b: "#2f8f88" }, 2));
    [rugA, rugB].forEach((map) => { map.anisotropy = anisotropy; });
    const rugMaterial = (map: THREE.Texture) => standard({ map, normalMap: fabricSet.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), side: THREE.DoubleSide });
    const first = rugMaterial(rugA), second = rugMaterial(rugB);
    maker(xf([-9.395, 5.445, -2.65], [0, Math.PI / 2, 0]), "west", true)(first, drapeGeometry(1.35, 1.0, 1.75));
    maker(xf([9.395, 5.445, -4.5], [0, -Math.PI / 2, 0]), "east", true)(second, drapeGeometry(1.45, 1.0, 1.55));
    maker(xf([-9.395, 5.445, -25.0], [0, Math.PI / 2, 0]), "west", true)(gingham, uvScale(drapeGeometry(1.5, 1.0, 1.2), 1.5 / WEAVE, 2.2 / WEAVE));
    // Rolled rugs stood in the corner by the east windows.
    for (const [z, lean, material] of [[-2.05, 0.1, first], [-2.3, 0.16, second], [-1.98, 0.2, second]] as Array<[number, number, THREE.Material]>) {
      const roll = uvScale(new THREE.CylinderGeometry(0.11, 0.11, 1.7, 14), 1.2, 1);
      court(material, roll, [9.16, KERB + 0.85, z], [lean * 0.5, 0, -lean]);
    }
  }

  // ---- Trees and plants ---------------------------------------------------
  // All from the shared library and all in the one wind. Date palms stand in the lanes and beyond the
  // walls; two old olives lean their crowns over the side walls (the eastern one dapples the floor past
  // the wall's own shade); bougainvillea spills over the far corner. Pots stand on the setts, and dry
  // grass and weeds have come up wherever the paving has given out.
  {
    // [x, z, stem variant, scale, turn]
    const palms: number[][] = [
      [-12.7, 0.2, 0, 1.12, 0.4], [-13.2, -17.3, 2, 1.04, 2.1], [12.6, -1.0, 1, 1.15, 3.6], [13.4, -20.6, 2, 1.0, 5.0],
      [-4.5, -33.2, 2, 1.1, 1.2], [4.2, -33.6, 0, 1.15, 4.1], [-12.8, 13.5, 2, 1.14, 0.9], [12.2, 14.2, 0, 1.2, 2.8],
      [-16, -34, 0, 1.18, 1.9], [18, -34.5, 2, 1.12, 4.4],
    ];
    const streets: number[][] = [[-30, -20, 1.4, 0.5], [-33, 8, 1.25, 2], [31, -24, 1.35, 3.3], [30, 4, 1.45, 5.2]];
    const skyline: number[][] = [[-44, -30, 1.25, 0.2], [45, -22, 1.15, 2.6], [-2, 38, 1.15, 1], [40, 30, 1.05, 3], [-20, -52, 1.3, 4.0], [24, -53, 1.2, 0.7], [0.5, -54, 1.35, 2.2]];
    trees.place("datePalm", palms.map(([x, z, variant, scale, yaw]): TreeItem => ({ at: [x, 0, z], variant, scale, yaw, lean: 0.03 })));
    trees.place("datePalm", streets.map(([x, z, scale, yaw]): TreeItem => ({ at: [x, 0, z], variant: 0, scale, yaw })), { detail: "mid", shadow: false });
    trees.place("datePalm", skyline.filter((_, index) => high || index % 2 === 0).map(([x, z, scale, yaw]): TreeItem => ({ at: [x, 0, z], variant: 2, scale, yaw })), { detail: "far", shadow: false });
    // The olives grow in raised gardens built against the outside of the walls, which is what lifts their crowns clear of the copings.
    const BED = 2.6;
    const olives: TreeItem[] = [{ at: [-12.8, BED, -8.2], variant: 0, scale: 1.3, yaw: 0.6, lean: [0.09, 0] }, { at: [12.8, BED, -16.4], variant: 0, scale: 1.34, yaw: 3.4, lean: [-0.09, 0] }];
    trees.place("olive", olives);
    {
      const beds = maker(null, "town", true);
      for (const [x, z, width, depth] of [[-12.75, -8.35, 4.5, 5.9], [12.85, -16.35, 4.7, 6.3]]) {
        beds(townPlaster[1], softBox(width, BED - 0.1, depth, 0.04, 3), [x, (BED - 0.1) / 2, z]);
        beds(capPlaster, softBox(width + 0.16, 0.12, depth + 0.16, 0.03, 3), [x, BED - 0.06, z]);
      }
    }
    // Fan palms in the lanes, where the arcades look out on them.
    const fans: TreeItem[] = [{ at: [-12.9, 0, 9.9], variant: 0, yaw: 1.1 }, { at: [13.3, 0, 9.7], variant: 0, yaw: 4.0, scale: 0.86 }];
    trees.place("fanPalm", fans);
    trees.place("soilRing", [...palms.slice(0, 4).map(([x, z]): TreeItem => ({ at: [x, 0, z], variant: 0, tint: 0xd8c3a0 })), ...olives.map(({ at }): TreeItem => ({ at, variant: 2, tint: 0xb9a480 })), ...fans.map(({ at }): TreeItem => ({ at, variant: 1, tint: 0xd8c3a0 }))], { shadow: false });
    // Bougainvillea over the wall heads at the sunlit far corner and at either end of the end wall.
    trees.place("bougainvillea", [
      { at: [-9.4, 5.42, -27.9], variant: 2, yaw: Math.PI / 2, scale: 1.25 },
      { at: [-6.1, 6.45, -29.27], variant: 2, yaw: 0, scale: 1.2 },
      { at: [6.2, 6.45, -29.27], variant: 2, yaw: 0, scale: 1.1, bloom: 0.8 },
    ]);
    // Pots: agaves in the sun along the west wall, ferns in the shade of the east wall and the gatehouse.
    trees.place("potAgave", [{ at: [-9.0, KERB, -16.85], yaw: 0.7, variant: 0 }, { at: [-8.95, KERB, -21.35], yaw: 2.9, variant: 0, scale: 0.85 }, { at: [-8.9, KERB, -28.65], yaw: 4.4, variant: 0, scale: 1.1 }]);
    trees.place("potFern", [{ at: [9.0, KERB, -16.7], yaw: 1.3, variant: 1 }, { at: [6.75, KERB, 9.3], yaw: 0.2, variant: 1 }]);
    // Geraniums on the sills: the shuttered west window, the gatehouse window and its two lofts.
    trees.place("flowerBox", [
      { at: [-9.43, WINDOW.sill + 0.012, WINDOW.z], yaw: Math.PI / 2, variant: 0 },
      { at: [GATE_WINDOW.x, GATE_WINDOW.sill + 0.012, 9.61], yaw: Math.PI, variant: 0, bloom: 0.7 },
      { at: [-7.9, LOFT.sill + 0.012, 9.61], yaw: Math.PI, variant: 0 }, { at: [7.9, LOFT.sill + 0.012, 9.61], yaw: Math.PI, variant: 0, bloom: 0.85 },
    ]);
    // Dry grass and weeds: along the broken edge of the setts, at the wall feet in the lanes, round the well.
    const grass: TreeItem[][] = [[], [], []], weeds: TreeItem[][] = [[], []];
    const sow = (x: number, y: number, z: number) => {
      const pick = random(), yaw = random() * 6.28, scale = 0.8 + random() * 0.6;
      if (pick < 0.62) grass[pick < 0.4 ? 0 : 1].push({ at: [x, y, z], yaw, scale, dry: 0.55 + random() * 0.45 });
      else weeds[pick < 0.84 ? 0 : 1].push({ at: [x, y, z], yaw, scale, dry: 0.3 + random() * 0.5 });
    };
    for (let i = 0; i < (high ? 54 : 18); i += 1) {
      // The edge of the paving at this place, found from the court side.
      const side = i % 2 ? 1 : -1, z = -28.6 + random() * 28.4;
      let x = 7.7;
      while (x < 9.3 && !paved(side * x, z)) x += 0.03;
      sow(side * (x - 0.02 - random() * 0.1), 0, z);
    }
    for (const side of [-1, 1]) for (const z of buttressZ) if (random() < 0.8) sow(side * (8.98 - random() * 0.06), KERB, z + (random() < 0.5 ? -1 : 1) * (0.42 + random() * 0.08));
    if (high) {
      for (let i = 0; i < 26; i += 1) { const side = i % 2 ? 1 : -1; sow(side * (13.82 - random() * 0.25), 0, 0.6 + random() * 11); }
      for (let i = 0; i < 12; i += 1) { const a = random() * 6.28, r = 1.62 + random() * 0.5; sow(12.3 + Math.sin(a) * r, 0, 7.6 + Math.cos(a) * r); }
      for (const [x, z] of [[-8.9, -28.9], [8.8, -28.6], [-11.4, 0.6], [-11.9, 1.2], [11.4, 9.9], [12.2, 1.2], [-12.6, 9.2], [-10.9, 5.3], [10.8, 5.4]]) sow(x, 0.05, z);
    }
    grass.forEach((items, variant) => { if (items.length) trees.place("grass", items.map((item) => ({ ...item, variant }))); });
    weeds.forEach((items, variant) => { if (items.length) trees.place("weeds", items.map((item) => ({ ...item, variant }))); });
    // Strips of grass along the foot of the house walls outside the arcades.
    trees.place("grass", [[-13.9, 2.2], [-13.9, 7.4], [-13.9, 10.3], [13.9, 2.9], [13.9, 8.6]].map(([x, z], index): TreeItem => ({ at: [x, 0, z], yaw: Math.PI / 2, variant: 2, dry: 0.7 + (index % 3) * 0.15, scale: 1.2 })));
    // Olive leaves the wind has brought over the walls.
    if (high) trees.place("leafLitter", [{ at: [-7.3, 0.012, -9.7], variant: 2, yaw: 0.4, dry: 0.6 }, { at: [6.0, 0.012, -17.4], variant: 2, yaw: 2.2, dry: 0.5 }]);
  }

  // ---- Props ---------------------------------------------------------------
  // The household's stores and the trader's goods are kinds from the shared props library, gathered here
  // and placed one batch per kind. Along the side walls and the gatehouse everything stands on the setts,
  // KERB above the sand; under the arcades and outside it stands on the sand.
  const props = createProps(kit);
  const stallX = -7.7, stallZ = 5.2;
  {
    const QUARTER = Math.PI / 2;
    // Glazes for the big jars, from the library's own range: they sit with the teal shutters and the clay.
    const TEAL = 0x3a5752, OCHRE = 0x8c703c, CREAM = 0xd8d2c2, OXBLOOD = 0x5c2620, CELADON = 0xa2b0a0;
    const stock = new Map<PropKind, PropItem[]>(), footprints: number[][] = [];
    const put = (kind: PropKind, item: PropItem) => {
      const list = stock.get(kind);
      if (list) list.push(item); else stock.set(kind, [item]);
      return item.position;
    };
    const upright = (kind: PropKind, position: V3, yaw = 0, scale = 1, more: Partial<PropItem> = {}) =>
      put(kind, { position, rotation: [0, yaw, 0], scale: [scale, scale, scale], ...more });
    /**
     * Where a foot stands: on the setts or on the sand, never across the kerb. A foot that would straddle
     * the broken edge is drawn out into the court (back from the gatehouse) until it is clear of it.
     */
    const ground = (x: number, z: number, rx: number, rz = rx, gate = false): V3 => {
      const probes = [[0, 0], [rx, 0], [-rx, 0], [0, rz], [0, -rz], [rx, rz], [rx, -rz], [-rx, rz], [-rx, -rz]];
      for (let step = 0; step < 60; step += 1) {
        const px = gate ? x : x - Math.sign(x) * step * 0.02, pz = gate ? z - step * 0.02 : z;
        const on = probes.filter(([dx, dz]) => paved(px + dx, pz + dz)).length;
        if (on === probes.length || on === 0) return [px, on ? KERB : 0, pz];
      }
      return [x, 0, z];
    };
    /** Radius of the part a thrown or sewn thing actually stands on. */
    const FOOT: Partial<Record<PropKind, number>> = { amphora: 0.085, urn: 0.16, jarCeramic: 0.08, crock: 0.12, cask: 0.26, sack: 0.2, sackOpen: 0.21, basket: 0.175, basketTray: 0.265 };
    /** Stands a prop on the ground: round feet by their radius, boxes by their turned footprint. */
    const stand = (kind: PropKind, x: number, z: number, yaw = 0, scale = 1, more: Partial<PropItem> = {}, gate = false) => {
      const round = FOOT[kind], [w, , d] = props.get(kind).size, c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
      const spot = ground(x, z, (round ?? (w * c + d * s) / 2) * scale, (round ?? (w * s + d * c) / 2) * scale, gate);
      footprints.push([spot[0], spot[2], ((round ? Math.max(w, d) : Math.hypot(w, d)) / 2) * scale]);
      return upright(kind, spot, yaw, scale, more);
    };
    const spun = new THREE.Matrix4(), axis = new THREE.Vector3(), euler = new THREE.Euler(), point = new THREE.Vector3();
    /**
     * A prop spun about its own axis, then tipped over by `tilt` toward a compass bearing (0 is +z, a quarter
     * turn is +x), with the box it then fills: `box.min.y` is how far its lowest point hangs below its origin.
     */
    const tipped = (kind: PropKind, spin: number, tilt: number, toward: number, scale = 1) => {
      const turn = new THREE.Matrix4().makeRotationAxis(axis.set(Math.cos(toward), 0, -Math.sin(toward)), tilt).multiply(spun.makeRotationY(spin));
      const box = new THREE.Box3(), position = props.get(kind).parts[0].geometry.attributes.position;
      for (let i = 0; i < position.count; i += 1) box.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(turn).multiplyScalar(scale));
      euler.setFromRotationMatrix(turn, "XYZ");
      return { turn, box, rotation: [euler.x, euler.y, euler.z] as V3, scale: [scale, scale, scale] as V3 };
    };
    /** An amphora propped against a side wall: its foot on the setts, its belly against the footing. */
    const propped = (side: number, z: number, lean: number, twist: number, scale = 1) => {
      const toward = side * QUARTER, pose = tipped("amphora", toward + twist, lean, toward, scale);
      const x = side * 9.388 - (side > 0 ? pose.box.max.x : pose.box.min.x);
      put("amphora", { position: [x, KERB - pose.box.min.y, z], rotation: pose.rotation, scale: pose.scale });
      footprints.push([x + side * 0.1, z, 0.3 * scale]);
    };
    /** A round fruit lying any way up with its middle at a point. */
    const roll = (kind: PropKind, x: number, y: number, z: number, a: number, b: number) => {
      euler.set(a, b, a * 1.7 - b);
      point.set(0, -props.get(kind).size[1] / 2, 0).applyEuler(euler);
      put(kind, { position: [x + point.x, y + point.y, z + point.z], rotation: [euler.x, euler.y, euler.z] });
    };
    const fewer = (count: number) => (high ? count : Math.round(count * 0.6));
    /** Produce settled into a container that already stands at `spot`: the library works out how it comes to rest. */
    const load = (container: PropKind, spot: V3, yaw: number, kinds: PropKind | PropKind[], count: number, size: number, seed: number) => {
      const room = props.get(container).inside;
      if (!room) return;
      const footprint = room.size ? { size: room.size } : { radius: room.radius ?? 0.2 };
      const heap = props.heap(kinds, { at: [spot[0], spot[1] + room.floor, spot[2]], ...footprint, yaw, rim: room.rim, flare: room.flare, count: fewer(count), scale: size, seed, place: false });
      for (const item of heap.items) put(item.kind, item);
    };
    /** An open pile on a flat top. */
    const pile = (kinds: PropKind | PropKind[], at: V3, size: [number, number], yaw: number, count: number, seed: number, scale = 1) => {
      for (const item of props.heap(kinds, { at, size, yaw, count: fewer(count), scale, seed, place: false }).items) put(item.kind, item);
    };
    const CRATE = props.get("crateLarge").size[1], SLAT = props.get("crateSlat").size[1], BENCH = KERB + 0.4975;

    // West wall, from the arcade to the far corner. A big jar at the pier; sacks and a crate of melons
    // before the first buttress; the stack by the door.
    stand("urn", -9.0, 0.98, 0.6, 1, { tint: OCHRE });
    stand("sackOpen", -8.93, -0.1, 0.4, 1.12, { variant: 1 });
    stand("sack", -9.07, -0.7, 0.4);
    const melons = stand("crateSlat", -8.72, -1.52, QUARTER + 0.1);
    load("crateSlat", melons, QUARTER + 0.1, "melon", 12, 1, 3);
    const doorCrate = stand("crateLarge", -8.92, -2.5, QUARTER + 0.04, 1, { variant: 1 });
    upright("crateSmall", [-8.93, doorCrate[1] + CRATE, -2.62], 0.38);
    // On the bench: a crock, a jar on the folded cloth and two bottles.
    upright("crock", [-9.0, BENCH, -6.56], 0.7);
    upright("jarCeramic", [-8.98, BENCH + 0.0525, -5.95], 2.2, 1, { tint: TEAL });
    if (high) { upright("bottleWine", [-9.07, BENCH, -6.2], 0.5); upright("bottleWine", [-8.93, BENCH, -6.3], 2.4); }
    // Water jars past the tool corner: three, an amphora propped beside them, and three more.
    stand("urn", -9.04, -9.15, 1.9, 1, { tint: TEAL });
    stand("amphora", -9.1, -9.82, 0.8);
    stand("crock", -8.7, -9.55, 2.6);
    propped(-1, -11.1, 0.25, 0.15);
    stand("urn", -9.0, -11.92, 0.3, 0.86, { tint: CREAM });
    stand("jarCeramic", -8.7, -11.4, 1.1);
    stand("jarCeramic", -8.66, -12.32, 4.0, 0.9);
    const pomegranates = stand("basket", -8.86, -13.2, 0.7);
    load("basket", pomegranates, 0.7, "pomegranate", 34, 1, 5);
    // Two casks with a crock stood on one, and a sack slumped against them.
    const cask = stand("cask", -9.02, -14.96, 0.5);
    stand("cask", -8.98, -15.62, 2.1, 1, { variant: 1 });
    upright("crock", [cask[0] + 0.03, cask[1] + props.get("cask").size[1] - 0.034, cask[2] - 0.02], 1.2);
    stand("sack", -9.06, -16.22, 2.6, 1.05);
    // Amphorae propped along the wall past the niche, and one that went over.
    propped(-1, -17.9, 0.22, -0.2);
    propped(-1, -18.42, 0.27, 0.1, 0.94);
    propped(-1, -19.02, 0.2, 0.25, 1.05);
    {
      const pose = tipped("amphora", 0.08, QUARTER + 0.35, 0.08);
      put("amphora", { position: [-8.78, KERB - pose.box.min.y, -20.52], rotation: pose.rotation, scale: pose.scale });
      footprints.push([-8.76, -20.3, 0.3], [-8.72, -19.85, 0.3]);
    }
    // Under the shuttered window: a crate with a sack thrown on it and two empty slat crates.
    const farCrate = stand("crateLarge", -8.92, -22.32, QUARTER - 0.05, 1, { variant: 3 });
    upright("sackLying", [-8.9, farCrate[1] + CRATE, -22.3], QUARTER + 0.3);
    const slats = stand("crateSlat", -8.76, -23.25, QUARTER + 0.08);
    upright("crateSlat", [slats[0] - 0.02, slats[1] + SLAT, slats[2] + 0.03], QUARTER - 0.1);
    stand("urn", -9.0, -27.1, 2.2, 1.08, { tint: OXBLOOD });
    stand("amphora", -9.1, -27.68, 1.3);
    stand("jarCeramic", -8.66, -27.45, 0.4);

    // East wall. A basket has gone over by the arcade and its oranges have run out across the setts.
    {
      const toward = -QUARTER + 0.4, pose = tipped("basket", toward, Math.atan(0.25 / 0.09), toward), radius = props.get("orange").size[1] / 2;
      const at: V3 = [9.0, KERB - pose.box.min.y, -0.52];
      put("basket", { position: at, rotation: pose.rotation, scale: pose.scale, tint: 0xffffff });
      footprints.push([8.95, -0.5, 0.3], [8.75, -0.42, 0.3]);
      // Those still inside lie along the low side of the wall, against the bottom.
      [[0, 0.052, 0.1364], [0, 0.1215, 0.1552], [0, 0.191, 0.174], [0.069, 0.052, 0.1177], [-0.069, 0.052, 0.1177]].forEach(([x, y, z], index) => {
        point.set(x, y, z).applyMatrix4(pose.turn);
        roll("orange", at[0] + point.x, at[1] + point.y, at[2] + point.z, index * 1.3, index * 2.1);
      });
      // The rest, by how far they rolled from the basket and how far to one side.
      ([[0.42, 0.03], [0.5, -0.09], [0.55, 0.1], [0.68, -0.02], [0.6, -0.3], [0.74, 0.21], [0.9, -0.2], [1.0, 0.08], [1.3, 0.3], [1.55, -0.12]] as number[][]).slice(0, fewer(10)).forEach(([far, across], index) => {
        const [x, y, z] = ground(9.0 + Math.sin(toward) * far + Math.cos(toward) * across, -0.52 + Math.cos(toward) * far - Math.sin(toward) * across, radius);
        roll("orange", x, y + radius, z, index * 0.9, index * 1.7);
        footprints.push([x, z, radius]);
      });
    }
    // Under the caged windows: a crate with a tray of onions on it, watermelons heaped beside it, casks and a sack.
    const windowCrate = stand("crateLarge", 8.92, -3.42, -QUARTER - 0.05, 1, { variant: 0 });
    const onions = upright("crateProduce", [8.9, windowCrate[1] + CRATE, -3.2], -QUARTER + 0.2);
    load("crateProduce", onions, -QUARTER + 0.2, "onion", 30, 1.1, 7);
    pile("watermelon", [8.8, KERB, -4.58], [0.46, 0.8], 0.06, 6, 9, 1.1);
    footprints.push([8.8, -4.32, 0.42], [8.8, -4.84, 0.42]);
    stand("cask", 9.0, -5.45, 1.2, 1, { variant: 1 });
    stand("cask", 8.98, -6.11, 3.3);
    stand("sack", 9.03, -6.74, 0.9, 0.96);
    // By the ladder, and three jars past the woodpile.
    stand("crock", 9.02, -9.2, 0.3);
    stand("jarCeramic", 8.74, -9.42, 1.7, 1, { tint: OCHRE });
    // Crates two high between the niche and the buttress, where they hide neither a sign nor a window.
    const lower = stand("crateLarge", 8.92, -18.95, -QUARTER + 0.04, 1, { variant: 2 });
    upright("crateLarge", [8.85, lower[1] + CRATE, -18.98], -QUARTER - 0.13, 1, { variant: 1 });
    stand("crateSmall", 8.8, -17.92, -QUARTER + 0.2);
    // The far stores: three jars, amphorae against the wall, sacks, a cask.
    stand("urn", 9.03, -20.72, 0.9, 1, { tint: CELADON });
    stand("amphora", 9.1, -21.4, 2.2, 0.96);
    stand("crock", 8.68, -21.05, 1.4);
    propped(1, -22.25, 0.24, 0.2);
    propped(1, -22.8, 0.21, -0.15, 0.95);
    stand("sack", 9.05, -23.6, 4.2);
    const lyingSack = stand("sackLying", 9.08, -24.72, QUARTER + 0.06);
    upright("sackLying", [9.02, lyingSack[1] + 0.2, -24.66], QUARTER - 0.2);
    stand("sackOpen", 8.72, -25.42, 2.0, 1.12, { variant: 0 });
    stand("cask", 9.0, -27.0, 0.2);
    propped(1, -27.62, 0.23, 0.1);

    // Under the east arcade: sacks, garlic and onions at the pier, the big jars in the gatehouse corner.
    stand("sack", 9.02, 5.75, 1.0);
    stand("sackOpen", 8.86, 5.1, 3.0, 1.12, { variant: 7 });
    const garlic = stand("basketTray", 8.42, 5.62, 0.5, 1, { tint: 0xffffff });
    load("basketTray", garlic, 0.5, "garlic", 30, 1.4, 11);
    const bayOnions = stand("basket", 8.5, 6.38, 2.1);
    load("basket", bayOnions, 2.1, "onion", 28, 1.1, 13);
    stand("urn", 8.98, 9.3, 0.4, 1, { tint: TEAL }, true);
    stand("amphora", 8.44, 9.36, 1.9, 1, {}, true);
    stand("crock", 8.6, 8.98, 0.6, 1, {}, true);
    // West gatehouse corner and beside the gatehouse door.
    stand("urn", -9.08, 9.28, 1.2, 1, { tint: CELADON }, true);
    stand("jarCeramic", -6.76, 9.42, 0.3, 1, {}, true);
    stand("jarCeramic", -6.66, 9.12, 2.0, 0.85, {}, true);

    // The stall: sacks at either end, produce on the counter, crocks on the shelf, sacks under it.
    const counter = (x: number, z: number, y = 0.9): V3 => [stallX + x, y, stallZ + z];
    stand("sack", stallX - 0.1, stallZ - 1.95, 0.7);
    stand("sackOpen", stallX + 0.52, stallZ - 1.9, 1.0, 1.12, { variant: 4 });
    stand("sack", stallX - 0.15, stallZ + 2.0, 2.9, 0.95);
    stand("sackOpen", stallX + 0.48, stallZ + 1.94, 5.0, 1.12, { variant: 5 });
    load("crateProduce", upright("crateProduce", counter(0.45, -0.42), QUARTER - 0.08), QUARTER - 0.08, "orange", 30, 1.1, 17);
    load("basket", upright("basket", counter(0.4, -1.08), 0.9), 0.9, "lemon", 36, 1.25, 19);
    load("basketTray", upright("basketTray", counter(0.42, 0.55), 2.0, 1, { tint: 0xe4d2b8 }), 2.0, ["garlic", "onion"], 26, 1.3, 23);
    load("basket", upright("basket", counter(-0.38, 0.68), 4.0), 4.0, "pomegranate", 26, 1, 29);
    pile("melon", counter(-0.32, -0.2), [0.42, 0.42], 0.3, 5, 43);
    upright("jarCeramic", counter(0.3, 1.2), 0.5, 1, { tint: CREAM });
    upright("jarCeramic", counter(0.02, 1.3), 2.6, 0.88, { tint: OXBLOOD });
    upright("crock", counter(-0.28, -0.75, 0.375), 0.8);
    upright("crock", counter(-0.3, 0.12, 0.375), 3.2);
    upright("jarCeramic", counter(-0.25, 0.85, 0.375), 1.4);
    stand("sackLying", stallX - 0.05, stallZ + 0.6, QUARTER + 0.1);
    stand("sackLying", stallX + 0.08, stallZ - 0.62, QUARTER - 0.12);
    if (high) {
      // Preserves, spice tins and two bottles of sauce at the back of the counter.
      for (const [x, z, yaw] of [[-0.62, -1.3, 0.4], [-0.5, -1.22, 2.2], [-0.64, -1.14, 3.9], [-0.38, -1.32, 5.1]]) upright("jar", counter(x, z), yaw);
      for (const [x, z, yaw, y] of [[-0.52, -1.02, 0.7, 0], [-0.4, -1.1, 2.9, 0], [-0.515, -1.025, 1.6, props.get("tin").size[1]]]) upright("tin", counter(x, z, 0.9 + y), yaw);
      upright("bottleSauce", counter(-0.24, -1.18), 1.1);
      upright("bottleSauce", counter(-0.66, -0.95), 3.3);
    }

    // The cart's load: sacks forward, two baskets amidships, melons at the tail.
    const CART = 0.12, BED = 0.9975;
    const cart = (x: number, z: number, y = BED): V3 => [-12.5 + x * Math.cos(CART) + z * Math.sin(CART), y, 3.3 - x * Math.sin(CART) + z * Math.cos(CART)];
    upright("sackLying", cart(-0.36, 0.62), QUARTER + 0.05 + CART);
    upright("sackLying", cart(0.3, 0.7), QUARTER - 0.1 + CART);
    upright("sackLying", cart(-0.02, 0.58, BED + 0.2), QUARTER + 0.3 + CART);
    load("basket", upright("basket", cart(-0.33, -0.25), 0.4), 0.4, "orange", 30, 1.2, 31);
    load("basket", upright("basket", cart(0.3, -0.12), 2.5), 2.5, "onion", 28, 1.1, 37);
    pile(["watermelon", "melon"], cart(0, -0.8), [0.9, 0.4], CART, 8, 41);

    // Outside the arcades.
    stand("urn", -13.4, 6.3, 0.2, 1.05, { tint: OCHRE });
    upright("urn", [10.92, 0.08, 6.87], 1.0, 1, { tint: CREAM });
    stand("amphora", 12.95, 3.3, 0.6);
    stand("sackLying", 13.38, 3.02, 0.6);
    // A jar in each lamp niche.
    upright("jarCeramic", [-9.78, NICHE.sill + 0.012, NICHE.z + 0.16], 0.6, 0.78, { tint: TEAL });
    upright("jarCeramic", [9.78, NICHE.sill + 0.012, NICHE.z - 0.16], 2.4, 0.78, { tint: OCHRE });

    // Fruit that lies out in the open, and the bottles on the bench, throw shadows like everything else.
    const cast: PlaceOptions = { shadow: true };
    const finish: Partial<Record<PropKind, PlaceOptions>> = { orange: cast, melon: cast, watermelon: cast, bottleWine: cast };
    stock.forEach((items, kind) => props.place(kind, items, finish[kind]));

    // Loose setts, fallen brick and stones at the broken edge of the paving, clear of whatever stands there.
    if (high) {
      const clear = (pad: number) => ({ position: [x, , z] }: Transform) => footprints.every(([px, pz, radius]) => Math.hypot(x - px, z - pz) > radius + pad);
      // Single stones and bricks are plain dressed pieces: a slice of a wall photograph would paint joints on them.
      instances(softBox(0.13, 0.05, 0.11, 0.015, 1.4), capPlaster, strewn.setts.filter(clear(0.1)), false, false);
      instances(softBox(0.21, 0.065, 0.1, 0.01, 1.4), plinthPlaster, strewn.bricks.filter(clear(0.13)), false, false);
      instances(new THREE.DodecahedronGeometry(1, 0), plinthPlaster, strewn.stones.filter(clear(0.14)), false, false);
    }
  }

  // Firewood for the furnace, split and stacked against the east wall.
  {
    const log = new THREE.CylinderGeometry(0.085, 0.085, 0.62, 7).rotateZ(Math.PI / 2);
    uvScale(log, 1, 0.4);
    const logs: Transform[] = [];
    for (let row = 0; row < 5; row += 1) for (let i = 0; i < 8 - (row > 3 ? 3 : 0); i += 1) {
      logs.push({ position: [9.04 + (random() - 0.5) * 0.06, KERB + 0.085 + row * 0.15, -15.9 + i * 0.17 + (row % 2) * 0.085], rotation: [random() * 3, 0, (random() - 0.5) * 0.08], scale: [1, 0.85 + random() * 0.3, 0.85 + random() * 0.3] });
    }
    instances(log, darkTimber, logs, false, true);
    // Chopping block and an axe left in it.
    court(darkTimber, uvScale(new THREE.CylinderGeometry(0.24, 0.26, 0.42, 12), 1, 0.3), [8.9, KERB + 0.21, -14.72]);
    court(timber, rod([8.9, KERB + 0.42, -14.72], [8.62, KERB + 1.02, -14.6], 0.018, 6));
    court(iron, new THREE.BoxGeometry(0.16, 0.1, 0.03), [8.92, KERB + 0.45, -14.722], [0, 0.4, 1.1]);
  }

  // Ladder against the east wall beside the furnace.
  {
    const ladder = maker(xf([8.82, 0, -8.45], [0, 0, -0.125]), "court", true);
    for (const side of [-1, 1]) ladder(timber, grain(new THREE.BoxGeometry(0.035, 5.1, 0.055), 1.8, true, side * 0.3), [0, 2.55, side * 0.23]);
    for (let i = 0; i < 16; i += 1) ladder(timber, rod([0, 0.3 + i * 0.3, -0.24], [0, 0.3 + i * 0.3, 0.24], 0.016, 6));
  }
  // Bench by the west door.
  {
    const bench = maker(xf([-9.0, KERB, -6.2]), "court", true);
    for (const x of [-0.11, 0.11]) bench(timber, grain(softBox(0.2, 0.045, 1.35, 0.01, 1.8), 1.8, true), [x, 0.475, 0]);
    for (const z of [-0.55, 0.55]) { bench(timber, grain(new THREE.BoxGeometry(0.36, 0.45, 0.05), 1.8, true), [0, 0.225, z]); }
    bench(timber, grain(new THREE.BoxGeometry(0.04, 0.09, 1.1), 1.8), [0, 0.3, 0]);
    bench(gingham, uvScale(softBox(0.26, 0.05, 0.3, 0.02, 0.6), 1, 1), [0.02, 0.525, 0.25], [0, 0.2, 0]);
  }
  // Shovel, hoe and besom propped in the corner of the buttress.
  {
    const tools = maker(xf([-9.3, KERB, -8.2]), "court", true);
    tools(timber, rod([0.28, 0.22, 0.05], [0.02, 1.5, 0.0], 0.017, 6));
    tools(iron, grain(new THREE.BoxGeometry(0.2, 0.28, 0.012), 1), [0.31, 0.1, 0.05], [0, 0, 0.2]);
    tools(timber, rod([0.34, 0, -0.22], [0.03, 1.62, -0.16], 0.016, 6));
    tools(iron, grain(new THREE.BoxGeometry(0.03, 0.012, 0.2), 1), [0.35, 0.03, -0.22]);
    tools(timber, rod([0.3, 0.3, 0.28], [0.03, 1.4, 0.2], 0.015, 6));
    tools(rope, new THREE.ConeGeometry(0.11, 0.42, 9, 1, true), [0.35, 0.14, 0.295], [0, 0, 0.22]);
  }
  // A bicycle leant under the west window.
  {
    const bike = maker(xf([-8.86, KERB, -24.75], [0, Math.PI / 2, 0]).multiply(xf([0, 0, 0], [-0.2, 0, 0])), "court", true);
    const rubber = shade;
    for (const x of [-0.53, 0.53]) {
      bike(rubber, new THREE.TorusGeometry(0.33, 0.02, 8, 32), [x, 0.35, 0]);
      bike(metals.brushed, new THREE.TorusGeometry(0.305, 0.008, 5, 32), [x, 0.35, 0]);
      bike(metals.brushed, new THREE.CylinderGeometry(0.022, 0.022, 0.1, 8).rotateX(Math.PI / 2), [x, 0.35, 0]);
      for (let i = 0; i < 12; i += 1) { const a = (i / 12) * Math.PI * 2; bike(metals.brushed, rod([x, 0.35, (i % 2 ? 0.03 : -0.03)], [x + Math.cos(a) * 0.3, 0.35 + Math.sin(a) * 0.3, 0], 0.0035, 3)); }
      bike(bikePaint, new THREE.TorusGeometry(0.36, 0.012, 4, 16, Math.PI * 0.8).rotateZ(x < 0 ? Math.PI * 0.25 : Math.PI * -0.05), [x, 0.35, 0], undefined, [1, 1, 3]);
    }
    const seat: V3 = [-0.2, 0.86, 0], head: V3 = [0.36, 0.9, 0], crank: V3 = [-0.06, 0.33, 0], back: V3 = [-0.53, 0.35, 0], front: V3 = [0.53, 0.35, 0];
    bike(bikePaint, rod(crank, seat, 0.016, 8)); bike(bikePaint, rod(seat, head, 0.015, 8)); bike(bikePaint, rod(crank, [0.37, 0.8, 0], 0.017, 8));
    for (const z of [-0.035, 0.035]) { bike(bikePaint, rod([crank[0], crank[1], z], [back[0], back[1], z], 0.01, 6)); bike(bikePaint, rod([seat[0], seat[1] - 0.08, z], [back[0], back[1], z], 0.009, 6)); bike(bikePaint, rod([0.39, 0.74, z], [front[0], front[1], z], 0.011, 6)); }
    bike(metals.brushed, rod([0.4, 0.72, 0], [0.33, 1.04, 0], 0.013, 8));
    bike(metals.brushed, pipe([[0.2, 0.98, -0.27], [0.3, 1.04, -0.22], [0.33, 1.05, 0], [0.3, 1.04, 0.22], [0.2, 0.98, 0.27]], 0.011, 6, 16));
    for (const z of [-0.27, 0.27]) bike(rubber, rod([0.24, 1.0, z * 0.96], [0.16, 0.965, z * 1.03], 0.016, 8));
    bike(metals.brushed, rod([seat[0], seat[1], 0], [seat[0] - 0.03, seat[1] + 0.1, 0], 0.011, 6));
    bike(darkTimber, softBox(0.26, 0.05, 0.15, 0.022, 1), [seat[0] - 0.04, seat[1] + 0.12, 0]);
    bike(metals.brushed, new THREE.CylinderGeometry(0.085, 0.085, 0.008, 18).rotateX(Math.PI / 2), [crank[0], crank[1], 0.05]);
    bike(metals.brushed, rod([crank[0], crank[1], 0.06], [crank[0] + 0.1, crank[1] - 0.13, 0.06], 0.008, 5));
    bike(metals.brushed, rod([crank[0], crank[1], -0.06], [crank[0] - 0.1, crank[1] + 0.13, -0.06], 0.008, 5));
    bike(rubber, new THREE.BoxGeometry(0.09, 0.02, 0.07), [crank[0] + 0.1, crank[1] - 0.13, 0.1]);
    bike(rubber, new THREE.BoxGeometry(0.09, 0.02, 0.07), [crank[0] - 0.1, crank[1] + 0.13, -0.1]);
    // Carrier with a crate strapped on.
    bike(metals.brushed, new THREE.BoxGeometry(0.4, 0.012, 0.14), [-0.58, 0.72, 0]);
    for (const z of [-0.06, 0.06]) bike(metals.brushed, rod([-0.53, 0.35, z], [-0.72, 0.72, z], 0.006, 4));
    bike(timber, grain(new THREE.BoxGeometry(0.34, 0.2, 0.26), 1.2), [-0.58, 0.83, 0]);
  }

  // Wrought-iron lamps on the buttresses, wired along the wall head.
  {
    const cap = lathe([[0, 0.34], [0.016, 0.34], [0.02, 0.3], [0.05, 0.27], [0.12, 0.215], [0.125, 0.2], [0.1, 0.2]], 6);
    const base = lathe([[0.1, 0.02], [0.105, 0], [0.07, -0.02], [0.03, -0.035], [0.02, -0.07], [0, -0.075]], 6);
    const lamp = (add: Add) => {
      add(iron, new THREE.BoxGeometry(0.06, 0.34, 0.012), [0, 0, 0.006]);
      add(iron, pipe([[0, 0.12, 0.01], [0, 0.17, 0.22], [0, 0.14, 0.44], [0, 0.06, 0.5]], 0.012, 6, 14));
      add(iron, pipe([[0, -0.14, 0.01], [0, -0.1, 0.16], [0, 0.02, 0.27], [0, 0.1, 0.24], [0, 0.1, 0.17], [0, 0.05, 0.16]], 0.009, 5, 18));
      add(iron, rod([0, 0.06, 0.5], [0, -0.04, 0.5], 0.005, 4));
      add(iron, cap, [0, -0.38, 0.5]);
      add(iron, base, [0, -0.38, 0.5]);
      for (let i = 0; i < 6; i += 1) { const a = (i / 6) * Math.PI * 2; add(iron, rod([Math.sin(a) * 0.1, -0.38, 0.5 + Math.cos(a) * 0.1], [Math.sin(a) * 0.1, -0.18, 0.5 + Math.cos(a) * 0.1], 0.006, 4)); }
      add(lampGlass, new THREE.CylinderGeometry(0.09, 0.09, 0.19, 6), [0, -0.275, 0.5]);
    };
    const wireMaterial = standard({ color: 0x1a1612, roughness: 0.7 });
    for (const side of [-1, 1]) {
      const add = maker(null, side < 0 ? "west" : "east");
      for (const z of [-1.5, -7.5, -19.95]) {
        lamp((side < 0 ? west : east)(z, side < 0 ? "west" : "east", false, 3.45, 0.5));
        add(wireMaterial, pipe([[side * 9.46, 4.97, z + 0.36], [side * 9.46, 4.3, z + 0.36], [side * 9.42, 3.9, z + 0.34], [side * 9.2, 3.66, z + 0.1], [side * 9.05, 3.6, z + 0.0]], 0.009, 4, 20));
      }
      const clips = [0.2, -2.6, -5.4, -8.6, -11.4, -14.6, -17.2, -20.4, -23.4, -26.4, -29.3];
      for (let i = 0; i < clips.length - 1; i += 1) add(wireMaterial, cable([side * 9.46, 4.98, clips[i]], [side * 9.46, 4.98, clips[i + 1]], 0.035, 0.009, 6, 4));
      for (const z of clips) add(iron, new THREE.BoxGeometry(0.03, 0.05, 0.03), [side * 9.475, 4.985, z]);
      // Junction box where the supply comes over the wall.
      add(tankMetal, new THREE.BoxGeometry(0.07, 0.2, 0.16), [side * 9.46, 4.94, 0.2]);
    }
  }

  // Trader's stall under the first awning.
  {
    const stall = maker(xf([stallX, 0, stallZ]), "stall", true);
    const postSpots: V3[] = [[-0.95, 0, -1.5], [-0.95, 0, 1.5], [0.95, 0, -1.5], [0.95, 0, 1.5]];
    for (const [x, , z] of postSpots) {
      stall(timber, rod([x, 0, z], [x, x < 0 ? 2.72 : 2.5, z], 0.05, 8, 0.042));
      stall(paving, softBox(0.2, 0.1, 0.2, 0.02, 1.7), [x, 0.05, z]);
    }
    for (const x of [-0.95, 0.95]) stall(timber, rod([x, x < 0 ? 2.66 : 2.44, -1.62], [x, x < 0 ? 2.66 : 2.44, 1.62], 0.032, 6));
    for (const z of [-1.5, 1.5]) stall(timber, rod([-1.02, 2.68, z], [1.02, 2.44, z], 0.03, 6));
    for (const x of [-0.95, 0.95]) for (const z of [-1.5, 1.5]) stall(rope, new THREE.TorusGeometry(0.06, 0.012, 5, 12).rotateX(Math.PI / 2), [x, x < 0 ? 2.64 : 2.42, z]);
    // Counter of three boards on trestles, with a shelf under.
    for (const x of [-0.56, 0, 0.56]) stall(timber, grain(softBox(0.55, 0.05, 2.9, 0.01, 1.8), 1.8, true, x), [x, 0.875, 0]);
    for (const z of [-1.2, 0, 1.2]) {
      stall(timber, grain(new THREE.BoxGeometry(1.5, 0.08, 0.06), 1.8), [0, 0.81, z]);
      for (const x of [-0.68, 0.68]) stall(timber, rod([x * 1.08, 0, z], [x * 0.9, 0.8, z], 0.035, 6));
      stall(timber, grain(new THREE.BoxGeometry(1.3, 0.05, 0.05), 1.8), [0, 0.32, z]);
    }
    for (const x of [-0.3, 0.3]) stall(timber, grain(new THREE.BoxGeometry(0.5, 0.03, 2.5), 1.8, true), [x, 0.36, 0]);
    // Balance scale hung from the front rail.
    stall(metals.brushed, rod([0.95, 2.44, 0.5], [0.95, 1.9, 0.5], 0.004, 4));
    stall(metals.brushed, rod([0.95, 1.9, 0.22], [0.95, 1.9, 0.78], 0.009, 6));
    const pan = lathe([[0, 0], [0.09, 0.005], [0.12, 0.03], [0.125, 0.032], [0.09, 0.012], [0, 0.008]], 16);
    for (const z of [0.24, 0.76]) {
      stall(metals.brushed, pan, [0.95, 1.52 - (z < 0.5 ? 0 : 0.05), z]);
      for (let i = 0; i < 3; i += 1) { const a = i * 2.094; stall(metals.brushed, rod([0.95, 1.9, z], [0.95 + Math.cos(a) * 0.11, 1.545 - (z < 0.5 ? 0 : 0.05), z + Math.sin(a) * 0.11], 0.0025, 3)); }
    }
    // Stool behind the counter.
    stall(timber, uvScale(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 14), 1, 1), [-1.25, 0.46, 0.4]);
    for (let i = 0; i < 3; i += 1) { const a = i * 2.094; stall(timber, rod([-1.25 + Math.cos(a) * 0.2, 0, 0.4 + Math.sin(a) * 0.2], [-1.25 + Math.cos(a) * 0.1, 0.45, 0.4 + Math.sin(a) * 0.1], 0.02, 6)); }
    // Folded cloths on the shelf.
    stall(gingham, softBox(0.4, 0.1, 0.5, 0.03, WEAVE), [0.2, 0.425, -0.7], [0, 0.1, 0]);
    stall(indigo, softBox(0.4, 0.08, 0.5, 0.03, WEAVE), [0.2, 0.42, 0.5], [0, -0.15, 0]);
    stall(linen, softBox(0.36, 0.06, 0.46, 0.03, WEAVE), [0.2, 0.49, 0.5], [0, 0.2, 0]);
  }
  const canopyMap = track(stripeTexture("#c9772d", "#eadfc6", "#2f8f88", 95));
  canopyMap.repeat.set(2.2 / 1.2, 3.3 / 1.1);
  canopyMap.anisotropy = anisotropy;
  const canopyCloth = standard({ map: canopyMap, emissive: 0xffffff, emissiveMap: canopyMap, emissiveIntensity: 0.25, roughness: 0.95, side: THREE.DoubleSide });
  // The kit's sagging sheet, cut finer along its length so the breathing has points to move.
  const canopyShape = new THREE.PlaneGeometry(2.2, 3.3, 22, 30).rotateX(-Math.PI / 2);
  for (let i = 0, at = canopyShape.attributes.position; i < at.count; i += 1) {
    const u = at.getX(i) / 1.1, v = at.getZ(i) / 1.65;
    at.setY(i, -0.22 * (1 - u * u) * (1 - 0.25 * v * v) + Math.sin(u * 9 + v * 4) * 0.015 * (1 - u * u));
  }
  canopyShape.computeVertexNormals();
  const canopy = place(new THREE.Mesh(track(canopyShape), canopyCloth), stallX, 2.62, stallZ, true);
  canopy.rotation.z = -0.1;
  // Laced to its frame all round, so only the middle of it breathes.
  life.cloth(canopyCloth, { amplitude: 0.05, frequency: 1.2, lean: 0, pin: "edges" });
  {
    const slateMap = track(slateTexture());
    slateMap.anisotropy = anisotropy;
    const slate = place(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.58, 0.03), [timber, timber, timber, timber, standard({ map: slateMap, roughness: 0.85 }), timber]), stallX + 1.12, 0.3, stallZ - 0.75, true);
    slate.rotation.order = "YXZ";
    slate.rotation.set(-0.3, Math.PI / 2 - 0.25, 0);
  }
  // A rug spread in front of the stall.
  const rugMap = track(rugTexture({ field: "#7c2f22", border: "#23585a", line: "#e3c58f", a: "#d58a2e", b: "#1f6f6a" }, 4));
  rugMap.anisotropy = anisotropy;
  const rug = place(new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.8), standard({ map: rugMap, normalMap: fabricSet.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), -5.9, 0.012, 5.3, false);
  rug.rotation.set(-Math.PI / 2, 0, 0.08);

  // Market cart drawn up outside the west arcade.
  {
    const cart = maker(xf([-12.5, 0, 3.3], [0, 0.12, 0]), "outside", true);
    const wheel = wheelGeometry(0.62, 12);
    for (const side of [-1, 1]) {
      cart(darkTimber, wheel.timber, [side * 0.8, 0.62, 0], [0, Math.PI / 2, side * 0.3]);
      cart(iron, wheel.iron, [side * 0.8, 0.62, 0], [0, Math.PI / 2, 0]);
      cart(timber, grain(new THREE.BoxGeometry(0.07, 0.1, 2.4), 1.8), [side * 0.6, 0.9, 0]);
      cart(timber, grain(new THREE.BoxGeometry(0.05, 0.05, 2.3), 1.8), [side * 0.66, 1.34, 0]);
      for (const z of [-1.1, -0.55, 0, 0.55, 1.1]) cart(timber, grain(new THREE.BoxGeometry(0.045, 0.4, 0.045), 1.8, true), [side * 0.66, 1.15, z]);
      // Shafts run forward and rest on the ground.
      cart(timber, rod([side * 0.52, 0.92, 1.1], [side * 0.42, 0.06, 3.3], 0.04, 7, 0.03));
      cart(timber, rod([side * 0.5, 0, -1.0], [side * 0.5, 0.9, -1.0], 0.035, 6));
    }
    cart(iron, rod([-0.92, 0.62, 0], [0.92, 0.62, 0], 0.03, 8));
    for (let i = 0; i < 6; i += 1) cart(timber, grain(softBox(0.215, 0.045, 2.4, 0.008, 1.8), 1.8, true, i * 0.3), [-0.55 + i * 0.22, 0.975, 0]);
    for (const z of [-1.15, 1.15]) cart(timber, grain(new THREE.BoxGeometry(1.36, 0.36, 0.04), 1.8), [0, 1.17, z]);
    // The carter's name board stands on the court-side rail.
    const name = track(boardTexture(1536, 384, "#d9c9a2", "#7c2f22", 47, (context) => {
      context.font = `bold 250px ${SERIF}`;
      [..."CAR"].forEach((letter, index) => lettered(context, letter, 768 + (index - 1) * 330, 156, "#7c2f22", 7, "rgba(31,79,85,.8)"));
      fitFont(context, "WORTH LESS THAN A KNIFE", 1100, 44, "600");
      lettered(context, "WORTH LESS THAN A KNIFE", 768, 312, "#1f4f55");
    }));
    name.anisotropy = anisotropy;
    cart(timber, grain(new THREE.BoxGeometry(0.03, 0.425, 1.7), 1.8), [0.66, 1.58, 0]);
    for (const z of [-0.78, 0.78]) cart(timber, grain(new THREE.BoxGeometry(0.045, 0.62, 0.045), 1.8, true), [0.625, 1.42, z]);
    cart(standard({ map: name, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), new THREE.PlaneGeometry(1.7, 0.425), [0.677, 1.58, 0], [0, Math.PI / 2, 0]);
  }

  // Well outside the east arcade.
  {
    const well = maker(xf([12.3, 0, 7.6]), "outside", true);
    well(brick, uvScale(lathe([[0.98, 0], [0.98, 0.78], [0.7, 0.78], [0.7, 0.2]], 28), 5, 1.2));
    well(capPlaster, uvScale(lathe([[1.06, 0.78], [1.06, 0.88], [1.03, 0.92], [0.66, 0.92], [0.63, 0.88], [0.63, 0.78]], 28), 4, 0.3));
    well(water, new THREE.CircleGeometry(0.7, 24).rotateX(-Math.PI / 2), [0, 0.42, 0], undefined, undefined, false);
    well(paving, softBox(2.9, 0.1, 2.9, 0.03, 1.7), [0, 0.03, 0], [0, 0.3, 0]);
    for (const side of [-1, 1]) {
      well(timber, grain(softBox(0.15, 2.5, 0.15, 0.015, 1.8), 1.8, true), [side * 1.14, 1.25, 0]);
      well(timber, grain(new THREE.BoxGeometry(0.1, 0.1, 0.9), 1.8), [side * 1.14, 0.45, 0], [0.9, 0, 0]);
      well(iron, new THREE.BoxGeometry(0.17, 0.06, 0.17), [side * 1.14, 1.6, 0]);
      // Pitched roof: lapped weatherboards on three rafters a side.
      const pitch = 0.6, down = [-Math.sin(pitch), Math.cos(pitch) * side], out = [Math.cos(pitch), Math.sin(pitch) * side];
      for (let k = 0; k < 5; k += 1) {
        const run = 0.09 + k * 0.17, lift = 0.014;
        well(darkTimber, grain(softBox(2.86 + random() * 0.1, 0.022, 0.2, 0.004, 1.8), 1.8, false, random(), random()),
          [(random() - 0.5) * 0.04, 2.95 + down[0] * run + out[0] * lift, down[1] * run + out[1] * lift], [side * (pitch - 0.07), 0, 0]);
      }
      for (const x of [-1.14, 0, 1.14]) well(timber, grain(new THREE.BoxGeometry(0.06, 0.08, 0.92), 1.8, true), [x, 2.95 + down[0] * 0.44 - out[0] * 0.05, down[1] * 0.44 - out[1] * 0.05], [side * pitch, 0, 0]);
    }
    well(timber, rod([-1.47, 2.975, 0], [1.47, 2.975, 0], 0.04, 8));
    well(timber, grain(softBox(2.6, 0.13, 0.13, 0.015, 1.8), 1.8), [0, 2.48, 0]);
    // Windlass with its rope and crank.
    well(darkTimber, uvScale(new THREE.CylinderGeometry(0.085, 0.085, 2.1, 12).rotateZ(Math.PI / 2), 1, 0.3, true), [0, 1.6, 0]);
    for (let i = 0; i < 9; i += 1) well(rope, new THREE.TorusGeometry(0.097, 0.014, 5, 14).rotateY(Math.PI / 2), [-0.12 + i * 0.03, 1.6, 0]);
    well(iron, pipe([[1.2, 1.6, 0], [1.38, 1.6, 0], [1.4, 1.6, 0.02], [1.4, 1.36, 0.02], [1.42, 1.34, 0.02], [1.62, 1.34, 0.02]], 0.014, 6, 20));
    const bucket = uvScale(lathe([[0, 0.02], [0.13, 0.02], [0.14, 0], [0.18, 0.32], [0.165, 0.32], [0.13, 0.04], [0, 0.04]], 16), 3, 1);
    const hoops = (y: number) => [...[0.08, 0.24].map((h) => new THREE.TorusGeometry(0.15 + h * 0.11, 0.007, 4, 18).rotateX(Math.PI / 2).translate(0, y + h, 0)), new THREE.TorusGeometry(0.17, 0.006, 4, 14, Math.PI).translate(0, y + 0.31, 0)];
    for (const [x, y, z, tilt] of [[-1.5, 0, 0.9, 0], [-1.2, 0.17, 1.4, 1.45]]) {
      well(timber, bucket, [x, y, z], [tilt, 0, 0]);
      if (!tilt) for (const hoop of hoops(y)) well(iron, hoop, [x, 0, z]);
    }
    // The bucket on the windlass hangs free on its rope and knocks about in the wind (it stands in the house's shade).
    {
      const hung = new THREE.Group(), pail = new THREE.Mesh(track(bucket.clone().translate(0, -0.74, 0)), timber);
      const rigging = new THREE.Mesh(track(merge([rod([0, 0, 0], [0, -0.42, 0], 0.012, 5), ...hoops(-0.74)])), iron);
      hung.add(pail, rigging);
      hung.position.set(12.45, 1.52, 7.65);
      hung.traverse((node) => { node.receiveShadow = true; node.userData.walkThrough = true; });
      scene.add(hung);
      kit.shootable.push(pail);
      swinging.bucket = life.sway(hung, { amplitude: 0.12, period: 1.7, damping: 0.05, creak: "ropeClank" });
    }
    // Stone trough beside it.
    const trough = new THREE.Shape();
    trough.moveTo(-0.3, 0); trough.lineTo(0.3, 0); trough.lineTo(0.34, 0.42); trough.lineTo(0.24, 0.42); trough.lineTo(0.2, 0.12); trough.lineTo(-0.2, 0.12); trough.lineTo(-0.24, 0.42); trough.lineTo(-0.34, 0.42); trough.closePath();
    well(capPlaster, projectUv(new THREE.ExtrudeGeometry(trough, { depth: 1.5, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 1 }), 3), [0.9, 0, -2.6], [0, 0.5, 0]);
    well(water, new THREE.PlaneGeometry(0.44, 1.46).rotateX(-Math.PI / 2), [1.26, 0.34, -1.94], [0, 0.5, 0], undefined, false);
    // A board nailed to the post that faces the court.
    const played = track(boardTexture(1024, 736, "#1d5a57", "#e7cf9a", 53, (context) => {
      fitFont(context, "WELL", 800, 290);
      lettered(context, "WELL", 512, 200, "#ecd7a4", 8);
      fitFont(context, "PLAYED", 820, 220);
      lettered(context, "PLAYED", 512, 436, "#e39a4a", 6);
      context.font = `italic 44px ${SERIF}`;
      lettered(context, "gg  —  hauled by hand since 1999", 512, 604, "#cfe3da");
    }));
    played.anisotropy = anisotropy;
    well(timber, grain(new THREE.BoxGeometry(0.03, 0.72, 1.0), 1.8), [-1.232, 1.92, 0]);
    well(standard({ map: played, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), new THREE.PlaneGeometry(1.0, 0.72), [-1.249, 1.92, 0], [0, -Math.PI / 2, 0]);
  }

  // ---- Signs ---------------------------------------------------------------
  // Every business round the court is named for a callout; the small print is for whoever walks up.
  {
    const TEAL = "#1f6f6a", OXBLOOD = "#7c2f22", INDIGO = "#1f4f55", OCHRE = "#d58a2e", CLAY = "#8a4426", INK = "#2a2420", RED = "#9c2b1e";
    const detail = high ? 1 : 0.5;
    const onWall = (side: number, z: number) => (side < 0 ? west : east)(z, "signs");
    /** Paint on the plaster of a side wall (-1 west, 1 east): `width` metres wide, centred at `z` and `y`. */
    const painted = (side: number, z: number, y: number, width: number, map: THREE.Texture) => {
      const image = map.image as HTMLCanvasElement;
      map.anisotropy = anisotropy;
      onWall(side, z)(standard({ map: track(map), normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        new THREE.PlaneGeometry(width, width * image.height / image.width), [0, y, 0.01]);
    };

    // Over the west arcade, where the sun finds it first.
    painted(-1, 5.35, 4.2, 5.6, wallSignTexture(4096, 600, detail, TEAL, 61, (context) => {
      const W = 4096, small = "MINT TEA  ·  A VIEW OF THE DOORS  ·  LOSS BONUS: THE FIFTH POT IS ON THE HOUSE";
      fitFont(context, "LONG A TEAROOM", W - 1010, 330);
      lettered(context, "LONG A TEAROOM", W / 2, 232, OXBLOOD, 9, OCHRE);
      fitFont(context, small, W - 520, 62, "600");
      lettered(context, small, W / 2, 468, TEAL);
      context.fillStyle = context.strokeStyle = TEAL;
      for (const side of [-1, 1]) { context.save(); context.translate(W / 2 + side * (W / 2 - 290), 236); context.scale(-side * 1.5, 1.5); teapotMark(context); context.restore(); }
    }));
    // Over the east arcade: the two arches below are the way through.
    painted(1, 5.35, 4.2, 4.2, wallSignTexture(3072, 600, detail, OXBLOOD, 67, (context) => {
      const W = 3072, small = "UPPER & LOWER  ·  CHECK YOUR CORNERS";
      fitFont(context, "B TUNNELS", W - 900, 330);
      lettered(context, "B TUNNELS", W / 2, 232, INDIGO, 9, OCHRE);
      fitFont(context, small, W - 900, 62, "600");
      lettered(context, small, W / 2, 468, OXBLOOD);
      context.fillStyle = OXBLOOD;
      for (const side of [-1, 1]) { context.save(); context.translate(W / 2 + side * (W / 2 - 270), 262); context.rotate(side < 0 ? Math.PI - 0.7 : 0.7); context.scale(1.45, 1.45); arrowMark(context); context.restore(); }
    }));
    // The tailors' fascia over their two caged windows.
    painted(1, -4.5, 3.34, 3.4, wallSignTexture(3072, 722, detail, INDIGO, 71, (context) => {
      const W = 3072, small = "SHORT ALTERATIONS  ·  STRETCHED TO 4:3 WHILE YOU WAIT";
      fitFont(context, "CATWALK TAILORS", W - 840, 300);
      lettered(context, "CATWALK TAILORS", W / 2, 292, INDIGO, 8, OCHRE);
      fitFont(context, small, W - 520, 64, "600");
      lettered(context, small, W / 2, 566, OXBLOOD);
      context.fillStyle = context.strokeStyle = OXBLOOD;
      for (const side of [-1, 1]) { context.save(); context.translate(W / 2 + side * (W / 2 - 236), 296); context.rotate(-side * Math.PI / 2); context.scale(1.5, 1.5); scissorsMark(context); context.restore(); }
    }));
    // The crate dealer, beside the door he gets his boxes through: the arrows point at it.
    painted(-1, -2.75, 2.16, 1.4, wallSignTexture(1280, 900, detail, OCHRE, 73, (context) => {
      const W = 1280;
      fitFont(context, "THE BOX", W - 270, 230);
      lettered(context, "THE BOX", W / 2, 196, INDIGO, 8, OCHRE);
      fitFont(context, "AT MID", 520, 150);
      lettered(context, "AT MID", W / 2, 362, INDIGO, 6, OCHRE);
      context.fillStyle = context.strokeStyle = OCHRE;
      for (const side of [-1, 1]) { context.save(); context.translate(W / 2 + side * 400, 366); context.scale(0.8, 0.8); arrowMark(context); context.restore(); }
      context.fillRect(W / 2 - 380, 462, 760, 5); context.fillRect(W / 2 - 380, 586, 760, 5);
      fitFont(context, "CRATES BOUGHT & SOLD", W - 250, 84, "600");
      lettered(context, "CRATES BOUGHT & SOLD", W / 2, 527, OXBLOOD);
      context.font = `italic 46px ${SERIF}`;
      lettered(context, "A leg up to Catwalk since 1999.", W / 2, 668, INDIGO);
      lettered(context, "You know the one.", W / 2, 730, INDIGO);
    }));
    // The potter, over his amphorae.
    painted(-1, -20.975, 2.68, 1.15, wallSignTexture(1056, 920, detail, CLAY, 79, (context) => {
      const W = 1056;
      fitFont(context, "PIT", 540, 300);
      lettered(context, "PIT", W / 2, 236, CLAY, 8, TEAL);
      fitFont(context, "POTTERY", W - 236, 176);
      lettered(context, "POTTERY", W / 2, 468, CLAY, 6, TEAL);
      context.fillStyle = context.strokeStyle = TEAL;
      for (const side of [-1, 1]) { context.save(); context.translate(W / 2 + side * (W / 2 - 170), 240); context.scale(1.05, 1.05); jarMark(context); context.restore(); }
      context.fillRect(W / 2 - 300, 580, 600, 5);
      fitFont(context, "THROWN DAILY  ·  NEVER DROPPED", W - 250, 52, "600");
      lettered(context, "THROWN DAILY  ·  NEVER DROPPED", W / 2, 652, OXBLOOD);
      fitFont(context, "Drop in any time. It is a long walk out.", W - 250, 42, "italic");
      lettered(context, "Drop in any time. It is a long walk out.", W / 2, 748, INDIGO);
    }));
    // Somebody has stencilled the corner by the far window.
    painted(-1, -25.1, 2.48, 1.15, canvasTexture(1024 * detail, 1280 * detail, (context) => {
      const W = 1024, H = 1280, random = rng(83), paint = "#1c4a4d";
      context.scale(detail, detail);
      context.clearRect(0, 0, W, H);
      context.fillStyle = context.strokeStyle = context.shadowColor = paint;
      context.shadowBlur = 9;
      context.save(); context.translate(483, 482); gooseStencil(context, "#c9772d"); context.restore();
      context.textAlign = "center"; context.textBaseline = "middle";
      context.font = `900 190px ${STENCIL}`;
      const letters = [..."GOOSE"], widths = letters.map((letter) => context.measureText(letter).width), gap = 24;
      let x = (W - widths.reduce((sum, width) => sum + width + gap, -gap)) / 2;
      letters.forEach((letter, index) => {
        context.fillText(letter, x + widths[index] / 2, 1010);
        // Bridges, as a cut card needs them.
        if (letter !== "E") { context.save(); context.globalCompositeOperation = "destination-out"; context.shadowBlur = 0; context.fillRect(x + widths[index] / 2 - 6, 920, 12, 180); context.restore(); }
        x += widths[index] + gap;
      });
      fitFont(context, "T H I S   C O R N E R   I S   T A K E N", W - 150, 50, "900", STENCIL);
      context.fillText("T H I S   C O R N E R   I S   T A K E N", W / 2, 1182);
      context.shadowBlur = 0;
      weatherPaint(context, W, H, random, 0.7);
    }));

    // Bills pasted between the tailors' windows.
    const bill = (z: number, y: number, tilt: number, map: THREE.Texture) => {
      map.anisotropy = anisotropy;
      onWall(1, z)(standard({ map: track(map), alphaTest: 0.5, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), new THREE.PlaneGeometry(0.42, 0.525), [0, y, 0.008], [0, 0, tilt]);
    };
    bill(-4.8, 1.8, 0.03, billTexture("#e9e1c8", 5, (context) => {
      context.strokeStyle = INK; context.lineWidth = 5; context.strokeRect(26, 26, 460, 588);
      context.font = `bold 150px ${SERIF}`; lettered(context, "LOST", 256, 118, RED);
      context.font = `bold 50px ${SERIF}`; lettered(context, "ONE DEFUSE KIT", 256, 222, INK);
      context.fillStyle = context.strokeStyle = INK;
      context.save(); context.translate(250, 318); context.rotate(0.5); context.scale(0.6, 0.6); pliersMark(context, "#e9e1c8"); context.restore();
      context.font = `italic 34px ${SERIF}`; lettered(context, "Last seen at B,", 256, 418, INK); lettered(context, "five seconds too late.", 256, 460, INK);
      fitFont(context, "REWARD $400", 410, 72); lettered(context, "REWARD $400", 256, 536, RED);
      context.font = `24px ${SERIF}`; lettered(context, "Ask at the bakery. No questions.", 256, 590, INK);
    }));
    bill(-4.24, 1.74, -0.025, billTexture("#e2c9a2", 9, (context) => {
      context.strokeStyle = INK; context.lineWidth = 8; context.strokeRect(24, 24, 464, 592); context.lineWidth = 2; context.strokeRect(38, 38, 436, 564);
      fitFont(context, "WALLBANG", 400, 96); lettered(context, "WALLBANG", 256, 104, INK);
      context.font = `bold 56px ${SERIF}`; lettered(context, "& SONS", 256, 178, INK);
      context.fillStyle = RED; context.fillRect(70, 226, 372, 62);
      context.font = `bold 44px ${SERIF}`; lettered(context, "PLASTERERS", 256, 259, "#e2c9a2");
      context.font = `italic 40px ${SERIF}`; lettered(context, "Holes filled,", 256, 344, INK); lettered(context, "no questions asked.", 256, 392, INK);
      context.font = `30px ${SERIF}`; lettered(context, "Free estimates:", 256, 466, INK);
      context.font = `italic 30px ${SERIF}`; lettered(context, "always lower through a wall.", 256, 506, INK);
      context.font = `bold 24px ${SERIF}`; lettered(context, "ENQUIRE AT MID DOORS", 256, 570, RED);
    }));

    // The carpenter's board over his door, and the notice screwed to the door itself.
    const carpenter = track(boardTexture(2048, 704, "#6b2a20", "#ecd7a4", 43, (context) => {
      const W = 2048, small = "EST. 1999  ·  GAP BETWEEN THE DOORS LEFT ON REQUEST";
      fitFont(context, "MID DOORS", W - 610, 250);
      lettered(context, "MID DOORS", W / 2, 190, "#ecd7a4", 8, "rgba(20,6,4,.7)");
      fitFont(context, "CARPENTRY & JOINERY", 1500, 120);
      lettered(context, "CARPENTRY & JOINERY", W / 2, 392, "#e39a4a");
      context.font = `italic 58px ${SERIF}`;
      lettered(context, "Our doors never get stuck.", W / 2, 520, "#ecd7a4");
      fitFont(context, small, W - 300, 32, "600");
      lettered(context, small, W / 2, 610, "#d8b98a");
      context.fillStyle = "#e39a4a";
      for (const x of [170, W - 170]) { context.save(); context.translate(x, 230); context.scale(1.5, 1.5); doorMark(context, "#6b2a20"); context.restore(); }
    }));
    carpenter.anisotropy = anisotropy;
    const board = place(new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9 * 704 / 2048, 0.05), [timber, timber, timber, timber, standard({ map: carpenter, roughness: 0.7 }), timber]), -9.46, 3.45, DOOR.z, true);
    board.rotation.order = "YXZ";
    board.rotation.set(0.1, Math.PI / 2, 0);
    for (const side of [-1, 1]) west(DOOR.z)(iron, pipe([[side * 0.8, 3.88, 0], [side * 0.8, 3.86, 0.1], [side * 0.8, 3.76, 0.125]], 0.012, 5, 8));
    const enamel = (add: Add, map: THREE.Texture, width: number, at: V3) => {
      const image = map.image as HTMLCanvasElement;
      map.anisotropy = anisotropy;
      add(standard({ map: track(map), roughness: 0.25, envMapIntensity: 1 }), new THREE.BoxGeometry(width, width * image.height / image.width, 0.006), at);
    };
    enamel(west(DOOR.z, "signs"), enamelTexture(512, 192, 21, (context) => {
      fitFont(context, "BEFORE CROSSING", 388, 52); context.fillText("PLEASE SMOKE", 256, 68); context.fillText("BEFORE CROSSING", 256, 128);
    }), 0.44, [-0.12, 1.42, -0.471]);
    enamel(gate(GATE_DOOR.x), enamelTexture(384, 160, 23, (context) => {
      fitFont(context, "PRIVATE", 250, 60); context.fillText("PRIVATE", 192, 60);
      context.font = "bold 27px 'Courier New', Courier, monospace"; context.fillText("noclip required", 192, 114);
    }), 0.33, [-0.1, 1.42, -0.471]);
  }

  // ---- Life and motion -----------------------------------------------------
  {
    // Washing lines: one across the court between the third and fourth awnings, high over the lanes of
    // fire, and one over the west lane where the arcade looks out. [along the line 0..1, kind, width, drop, dye, stripe]
    type Peg = [number, Wash["kind"], number, number, number, number?];
    const line = (a: V3, b: V3, sag: number, pegs: Peg[]) => {
      rig(rope, cable(a, b, sag, 0.008, 24, 4));
      for (const end of [a, b]) rig(iron, new THREE.TorusGeometry(0.032, 0.008, 4, 10), end);
      const yaw = Math.atan2(a[2] - b[2], b[0] - a[0]);
      for (const [t, kind, width, drop, colour, stripe] of pegs) {
        washing.push({ at: [THREE.MathUtils.lerp(a[0], b[0], t), THREE.MathUtils.lerp(a[1], b[1], t) - sag * 4 * t * (1 - t) - 0.008, THREE.MathUtils.lerp(a[2], b[2], t)], yaw, kind, width, drop, colour, stripe });
      }
    };
    line([-9.5, 4.92, -16.6], [9.5, 4.92, -16.6], 0.6, [
      [0.09, "sheet", 0.9, 1.1, DYES[0]], [0.15, "tunic", 1.0, 0.85, DYES[1]], [0.21, "sheet", 0.45, 0.7, DYES[6], DYES[2]], [0.27, "trousers", 0.5, 0.9, DYES[7]],
      [0.36, "sheet", 1.5, 1.2, DYES[6]], [0.45, "tunic", 0.95, 0.9, DYES[2]], [0.51, "sheet", 0.45, 0.75, DYES[0], DYES[4]], [0.57, "sheet", 1.2, 1.0, DYES[3], DYES[6]],
      [0.66, "trousers", 0.5, 0.95, DYES[1]], [0.72, "tunic", 1.0, 0.9, DYES[4]], [0.8, "sheet", 1.4, 1.15, DYES[5]], [0.88, "sheet", 0.45, 0.7, DYES[6], DYES[1]], [0.93, "tunic", 0.8, 0.7, DYES[0]],
    ]);
    line([-10.36, 3.78, 7.75], [-14.0, 3.78, 7.6], 0.14, [[0.2, "tunic", 0.85, 0.8, DYES[6]], [0.45, "sheet", 0.4, 0.6, DYES[0], DYES[2]], [0.66, "sheet", 0.8, 0.9, DYES[1]], [0.87, "trousers", 0.45, 0.8, DYES[3]]]);
    const laundry = standard({ vertexColors: true, normalMap: fabricSet.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.95, side: THREE.DoubleSide });
    const hung = new THREE.Mesh(track(washingGeometry(washing, 61)), laundry);
    hung.receiveShadow = true;
    hung.userData.walkThrough = true;
    scene.add(hung);
    life.cloth(laundry, { amplitude: 0.09, lean: 0.5, pin: "top" }).snap([1.5, 4.2, -16.6]);

    // A chime of five tubes on the stall's front rail, where the trader can hear a customer coming.
    {
      const parts: THREE.BufferGeometry[] = [rod([0, 0, 0], [0, -0.09, 0], 0.003, 4), new THREE.CylinderGeometry(0.058, 0.058, 0.008, 14).translate(0, -0.09, 0), rod([0, -0.09, 0], [0, -0.5, 0], 0.002, 3), new THREE.CylinderGeometry(0.024, 0.024, 0.012, 10).translate(0, -0.29, 0)];
      for (let i = 0; i < 5; i += 1) {
        const a = (i / 5) * Math.PI * 2, length = 0.2 + i * 0.035;
        parts.push(new THREE.CylinderGeometry(0.0065, 0.0065, length, 6).translate(Math.sin(a) * 0.045, -0.12 - length / 2, Math.cos(a) * 0.045));
      }
      parts.push(new THREE.CylinderGeometry(0.035, 0.035, 0.003, 4).rotateX(Math.PI / 2).translate(0, -0.53, 0));
      const chime = new THREE.Mesh(track(merge(parts)), metals.brushed);
      chime.position.set(stallX + 0.95, 2.43, stallZ - 1.05);
      chime.userData.walkThrough = true;
      scene.add(chime);
      kit.shootable.push(chime);
      swinging.chime = life.sway(chime, { amplitude: 0.3, period: 1.4, damping: 0.05, creak: "chimeTinkle" });
    }

    // Doves on the wall heads, the merlons and two roof edges; sparrows on the power line over the court
    // and on the west coping. Their perches are in the gaps between the awnings, with open sky above.
    life.birds("pigeon", {
      perches: [
        { from: [-9.94, 5.42, -17.3], to: [-9.94, 5.42, -15.9] }, { from: [9.94, 5.42, -9.4], to: [9.94, 5.42, -8.3] },
        [-5, 7.125, -29.8], [-3, 7.125, -29.8], [1, 7.125, -29.8], [3, 7.125, -29.8], [7, 7.125, -29.8],
        [-3, 8.525, 10.12], [-1, 8.525, 10.12], [5, 8.525, 10.12],
        { from: [-14.9, 11.97, -3.4], to: [-14.9, 11.97, -2.2] }, { from: [14.9, 7.67, -9.5], to: [14.9, 7.67, -8.2] },
      ],
      count: 14, roam: { x: [-12, 12], y: [8.5, 13.5], z: [-27, 5] },
    });
    const span = (t: number): V3 => [-11.7 + 23.3 * t, 8.25 - 0.1 * t - 3.6 * t * (1 - t) + 0.011, -9.6 - 5 * t];
    life.birds("sparrow", {
      perches: [{ from: span(0.3), to: span(0.37), thin: true }, { from: span(0.37), to: span(0.44), thin: true }, { from: span(0.6), to: span(0.67), thin: true }, { from: [-9.94, 5.42, -1.7], to: [-9.94, 5.42, 0.1] }],
      count: 12, roam: { x: [-10, 10], y: [7.2, 10.5], z: [-20, 0] },
    });
    life.soaring("swift", { centre: [0, 0, -14], radius: 20, height: 17, count: 5 });
    // Hens and a cock on the open sand either side of the firing point; flies over the fruit.
    life.chickens({ areas: [[-6.4, -3.3, -2.2, 7.6], [2.2, -3.3, 7.4, 8.2]], count: 5 });
    life.insects([[stallX + 0.45, 1.2, stallZ - 0.42], [stallX - 0.38, 1.25, stallZ + 0.68], [-8.72, 0.5, -1.52], [8.9, 0.35, -0.5], [8.8, 0.6, -4.58], [-12.5, 1.35, 3.0]], { kind: "flies" });
    // What the gusts pick up off the floor: sand, the olives' dead leaves, a few torn bills.
    const floor = { x: [-8.5, 8.5] as [number, number], z: [-24.6, 9.2] as [number, number] };
    life.drift("dust", { volume: { ...floor, y: [0, 1.2] }, count: 22, colors: [0xb9a27c] });
    life.drift("leaves", { volume: { ...floor, y: [0, 3.2] }, count: 46, colors: [0x7d7a4a, 0x8a7a3e, 0x9a8450, 0x6f6a3c, 0xa08a5a], falling: 0.12 });
    life.drift("paper", { volume: { ...floor, y: [0, 2.2] }, count: 6 });

    // Smoke: the potter's kiln, built against the outside of the west wall, and the bakery's oven behind the gatehouse.
    {
      const stacks = maker(null, "town", true);
      stacks(brick, grain(softBox(0.74, 7.7, 0.74, 0.03, 1.2), 1.2), [-10.86, 3.85, -22.0]);
      stacks(capPlaster, softBox(0.9, 0.14, 0.9, 0.03, 3), [-10.86, 7.77, -22.0]);
      stacks(terracotta, uvScale(new THREE.CylinderGeometry(0.16, 0.2, 0.42, 12, 1, true), 2, 1), [-10.86, 8.05, -22.0]);
      stacks(wallPlaster, softBox(0.7, 9.3, 0.7, 0.04, 3), [-6.0, 4.65, 10.95]);
      stacks(capPlaster, softBox(0.86, 0.14, 0.86, 0.03, 3), [-6.0, 9.37, 10.95]);
      stacks(terracotta, uvScale(new THREE.CylinderGeometry(0.16, 0.2, 0.42, 12, 1, true), 2, 1), [-6.0, 9.65, 10.95]);
      life.plume("smoke", [[-10.86, 8.3, -22.0], [-6.0, 9.9, 10.95]], { rise: 6.5, size: [0.45, 2.6], color: 0x8f877c, opacity: 0.55, lean: 3 });
    }

    // Heat coming off the end wall: a faint rising ripple in the air over its coping.
    const shimmer = track(new THREE.ShaderMaterial({
      uniforms: { shimmerTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vPlace;
        varying vec2 vAcross;
        void main() { vPlace = position.xy; vAcross = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float shimmerTime;
        varying vec2 vPlace;
        varying vec2 vAcross;
        void main() {
          float t = shimmerTime;
          float a = sin(vPlace.x * 3.1 + sin(vPlace.y * 2.3 - t * 2.2) * 2.0 + t * 0.7) * sin(vPlace.y * 5.2 - t * 3.4 + sin(vPlace.x * 1.7 + t) * 1.5);
          float b = sin(vPlace.x * 7.3 - t * 1.3 + sin(vPlace.y * 6.1 - t * 4.1) * 1.3);
          float ripple = a * 0.65 + b * 0.35;
          float fade = smoothstep(0.0, 0.06, vAcross.y) * (1.0 - smoothstep(0.15, 1.0, vAcross.y)) * smoothstep(0.0, 0.08, vAcross.x) * (1.0 - smoothstep(0.92, 1.0, vAcross.x));
          gl_FragColor = vec4(ripple > 0.0 ? vec3(1.0, 0.95, 0.85) : vec3(0.32, 0.27, 0.2), pow(abs(ripple), 1.4) * 0.11 * fade);
        }`,
      transparent: true, depthWrite: false,
    }));
    const haze = new THREE.Mesh(track(new THREE.PlaneGeometry(21, 3.4)), shimmer);
    haze.position.set(0, 8.1, -29.3);
    haze.renderOrder = 2;
    haze.userData.walkThrough = true;
    scene.add(haze);
    kit.probeHidden.push(haze);
    kit.mirrorHidden.push(haze);

    // The dust devil. Every minute or so a harder gust comes down the court and winds the sand up into a
    // column that crosses from the east wall to the west, in the open strip before the firing point or
    // under the washing line beyond the first targets. It is heard first; the awnings, the washing and the trees rise with it, the chime
    // and the shutters go, and the birds and the hens get out of its way.
    const DEVIL_VERTEX = /* glsl */ `
      uniform float devilTime;
      uniform float devilStrength;
      uniform vec3 devilFoot;
      uniform vec2 devilLean;
      uniform vec4 devilShape;
      uniform vec3 devilSun;
      varying vec2 vDevil;
      varying vec3 vOut;
      varying vec3 vToEye;
      varying float vLit;
      #ifdef DEVIL_FLAKES
        attribute vec4 flake;
        varying vec3 vFlake;
      #endif
      #include <fog_pars_vertex>
      vec2 devilAxis(float h, float phase) {
        // The column snakes as it goes and its head trails behind its foot.
        return vec2(sin(h * 3.3 + devilTime * 1.25 + phase), cos(h * 2.6 + devilTime * 0.95 + phase)) * (0.42 * h * h) - devilLean * (h * h);
      }
      void main() {
        float tall = devilShape.x * (0.55 + 0.45 * devilStrength);
        #ifdef DEVIL_FLAKES
          float h = fract(devilTime * (0.1 + flake.w * 0.12) + flake.y);
          float angle = flake.x * 6.2832 + devilTime * (5.0 - 2.6 * h) * (0.7 + 0.6 * flake.w);
          float radius = mix(devilShape.y, devilShape.z, pow(h, 1.7)) * (0.75 + 0.6 * flake.z);
          vec2 axis = devilAxis(h, 0.0);
          vec4 mvPosition = viewMatrix * vec4(devilFoot + vec3(cos(angle) * radius + axis.x, h * tall * 0.92, sin(angle) * radius + axis.y), 1.0);
          float roll = devilTime * (5.0 + flake.x * 7.0), size = 0.035 + 0.045 * flake.z;
          vec2 corner = (uv - 0.5) * size;
          mvPosition.xy += vec2(corner.x * cos(roll) - corner.y * sin(roll), (corner.x * sin(roll) + corner.y * cos(roll)) * (0.3 + 0.7 * abs(sin(roll * 0.7 + flake.y * 9.0))));
          vDevil = vec2(0.0, h);
          vFlake = mix(vec3(0.2, 0.13, 0.06), vec3(0.4, 0.36, 0.2), flake.z) * (0.5 + 0.5 * flake.x);
          vOut = vec3(uv - 0.5, 0.0); vToEye = vec3(0.0, 0.0, 1.0); vLit = 1.0;
        #else
          float h = position.y;
          vec2 ring = position.xz;
          float radius = mix(devilShape.y, devilShape.z, pow(h, 1.7)) * (1.0 + 0.16 * sin(h * 8.0 - devilTime * 2.6 + devilShape.w));
          vec2 axis = devilAxis(h, devilShape.w * 0.2);
          vec4 mvPosition = viewMatrix * vec4(devilFoot + vec3(ring.x * radius + axis.x, h * tall, ring.y * radius + axis.y), 1.0);
          vDevil = vec2(uv.x, h);
          vOut = normalize((viewMatrix * vec4(ring.x, 0.2, ring.y, 0.0)).xyz);
          vToEye = -mvPosition.xyz;
          vLit = 0.5 + 0.5 * dot(normalize(vec3(ring.x, 0.3, ring.y)), devilSun);
        #endif
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`;
    const DEVIL_FRAGMENT = /* glsl */ `
      uniform float devilTime;
      uniform float devilStrength;
      uniform float devilOpacity;
      uniform vec4 devilShape;
      uniform vec3 devilTint;
      uniform sampler2D devilNoise;
      varying vec2 vDevil;
      varying vec3 vOut;
      varying vec3 vToEye;
      varying float vLit;
      #ifdef DEVIL_FLAKES
        varying vec3 vFlake;
      #endif
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        float ends = smoothstep(0.0, 0.06, vDevil.y) * (1.0 - smoothstep(0.3, 0.95, vDevil.y));
        #ifdef DEVIL_FLAKES
          // A leaf, not a square: the quad is cut to a slim pointed oval.
          float alpha = step(length(vOut.xy * vec2(1.0, 2.3)) + abs(vOut.x) * 0.35, 0.5) * smoothstep(0.0, 0.25, ends) * devilStrength;
          vec3 colour = vFlake;
        #else
          // Streaks of sand wound round the column and climbing it, two layers at different speeds.
          float spin = devilTime * (0.5 + devilShape.w * 0.06);
          float a = texture2D(devilNoise, vec2(vDevil.x * 2.0 + vDevil.y * 1.3 - spin, vDevil.y * 1.1 - devilTime * 0.22)).r;
          float b = texture2D(devilNoise, vec2(vDevil.x * 3.0 - vDevil.y * 0.7 - spin * 1.7 + 0.37, vDevil.y * 2.3 - devilTime * 0.41)).r;
          float body = smoothstep(0.08, 0.56, a * 0.75 + b * 0.55);
          // Thin where the shell is seen edge on, so the column has no outline.
          float rim = smoothstep(0.04, 0.62, abs(dot(normalize(vOut), normalize(vToEye))));
          float alpha = body * rim * ends * devilOpacity * devilStrength;
          vec3 colour = devilTint * (0.4 + 0.75 * vLit);
        #endif
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(colour, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`;
    const devilNoise = track(canvasTexture(256, 256, (context) => {
      const r = rng(733);
      context.fillStyle = "#000"; context.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 150; i += 1) {
        const x = r() * 256, y = r() * 256, long = 26 + r() * 60, wide = 5 + r() * 12, strength = 0.1 + r() * 0.2;
        // Each wisp is drawn nine times over, so the sheet wraps both ways.
        for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
          context.save(); context.translate(x + ox, y + oy); context.rotate(-0.5 + r() * 0.2); context.scale(long / wide, 1);
          const glow = context.createRadialGradient(0, 0, 0, 0, 0, wide);
          glow.addColorStop(0, `rgba(255,255,255,${strength})`); glow.addColorStop(1, "rgba(255,255,255,0)");
          context.fillStyle = glow; context.beginPath(); context.arc(0, 0, wide, 0, Math.PI * 2); context.fill();
          context.restore();
        }
      }
    }, true));
    devilNoise.colorSpace = THREE.NoColorSpace;
    const devil = { devilTime: { value: 0 }, devilStrength: { value: 0 }, devilFoot: { value: new THREE.Vector3() }, devilLean: { value: new THREE.Vector2() }, devilSun: { value: TO_SUN }, devilNoise: { value: devilNoise } };
    const column = track(new THREE.CylinderGeometry(1, 1, 1, 28, 18, true).translate(0, 0.5, 0));
    const devilParts: THREE.Mesh[] = [];
    /** One shell of the column: [height, radius at the foot, radius at the head, phase]. */
    const shell = (geometry: THREE.BufferGeometry, shape: [number, number, number, number], opacity: number, flakes = false) => {
      const material = track(new THREE.ShaderMaterial({
        uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...devil, devilShape: { value: new THREE.Vector4(...shape) }, devilOpacity: { value: opacity }, devilTint: { value: new THREE.Color(0.72, 0.56, 0.38) } },
        defines: flakes ? { DEVIL_FLAKES: 1 } : {},
        vertexShader: DEVIL_VERTEX, fragmentShader: DEVIL_FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
      }));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.userData.walkThrough = true;
      scene.add(mesh);
      kit.probeHidden.push(mesh);
      kit.mirrorHidden.push(mesh);
      devilParts.push(mesh);
    };
    shell(column, [6.2, 0.26, 1.0, 0], 0.95);
    shell(column, [5.0, 0.55, 1.6, 2.4], 0.55);
    shell(column, [1.2, 0.55, 2.0, 4.1], 0.75);
    if (high) {
      // Leaves and scraps caught up in it.
      const scraps = new THREE.BufferGeometry(), count = 36, r = rng(91);
      const corners = new Float32Array(count * 8), seeds = new Float32Array(count * 16), index: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const seed = [r(), r(), r(), r()];
        [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((corner, k) => { corners.set(corner, i * 8 + k * 2); seeds.set(seed, i * 16 + k * 4); });
        index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      }
      scraps.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 12), 3));
      scraps.setAttribute("uv", new THREE.BufferAttribute(corners, 2));
      scraps.setAttribute("flake", new THREE.BufferAttribute(seeds, 4));
      scraps.setIndex(index);
      shell(track(scraps), [5.4, 0.3, 1.3, 0], 1, true);
    }

    const lanes = [[[7.6, -2.6], [3.2, -1.3], [-2.4, -0.5], [-7.0, -1.8]], [[7.8, -16.4], [2.8, -15.2], [-2.6, -16.0], [-7.6, -15.0]]]
      .map((points) => new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z))));
    const voice = { gain: 1, pitch: 1 }, places = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let placeIndex = 0;
    const say = (name: CueName, x: number, y: number, z: number, gain: number, pitch: number) => {
      if (!cue) return;
      voice.gain = gain; voice.pitch = pitch;
      cue(name, places[placeIndex = (placeIndex + 1) % places.length].set(x, y, z), voice);
    };
    // Crowns that are heard when a gust reaches them: the two olives and the palms by the arcades. [x, y, z, wind last frame, quiet until]
    const crowns = [[-11.4, 7.6, -8.2, 0, 0], [11.4, 7.6, -16.4, 0, 0], [-12.7, 9.5, 0.2, 0, 0], [12.6, 8, -1.0, 0, 0]];
    const foot = devil.devilFoot.value, ahead = new THREE.Vector3(), SPIN_UP = 1.8, CROSSING = 12.5;
    let began = -1, eventAt = -1, lane = 0, gustAt = 0, flushed = false, rang = 0, rustleAt = 0, swiftAt = -1, entered = false, soon = false;
    kit.updates.push((now) => {
      const time = now / 1000;
      shimmer.uniforms.shimmerTime.value = time;
      if (began < 0) { began = time; eventAt = time + 4.5; swiftAt = time + 9; }
      // The map is already alive behind the menu. When the player walks in (the pointer locks to the view),
      // a devil is due within a few seconds unless one is still well under way.
      if (!entered && document.pointerLockElement === kit.renderer.domElement) {
        entered = true;
        if (time < eventAt) eventAt = Math.min(eventAt, time + 5);
        else if (time - eventAt > 9) soon = true;
      }
      // Leaves answering the gusts, never two crowns at once.
      for (const crown of crowns) {
        const gust = wind.at(crown[0], crown[2]);
        if (gust > 0.5 && crown[3] <= 0.5 && time > crown[4] && time > rustleAt) {
          crown[4] = time + 7; rustleAt = time + 2.5;
          say("leafRustle", crown[0], crown[1], crown[2], Math.min(1, 0.4 + gust * 0.6), 0.9 + ((time * 3.7) % 1) * 0.25);
        }
        crown[3] = gust;
      }
      if (time > swiftAt) { swiftAt = time + 16 + ((time * 7.3) % 1) * 22; say("swiftScream", Math.sin(time) * 9, 15, -14 + Math.cos(time * 1.7) * 10, 0.5, 0.92 + ((time * 1.9) % 1) * 0.2); }
      const since = time - eventAt;
      if (since < 0) return;
      const end = SPIN_UP + CROSSING + 2.6;
      if (since > end + 3) {
        // Over: the air settles and the next one is a minute or so off.
        wind.set({ strength: BREEZE });
        for (const part of devilParts) part.visible = false;
        eventAt = time + (soon ? 3 : 25 + random() * 40);
        lane = random() < 0.5 ? 1 - lane : lane;
        flushed = false; gustAt = 0; rang = 0; soon = false;
        return;
      }
      // The gust that carries it: the whole court's wind rises, holds and falls away.
      const swell = THREE.MathUtils.smoothstep(since, 0, 3.2) * (1 - THREE.MathUtils.smoothstep(since, end - 4, end + 3));
      wind.set({ strength: BREEZE * (1 + 0.5 * swell) });
      const along = THREE.MathUtils.clamp((since - SPIN_UP) / CROSSING, 0, 1), eased = along * along * (3 - 2 * along);
      lanes[lane].getPoint(eased, foot);
      lanes[lane].getPoint(Math.min(1, eased + 0.02), ahead);
      devil.devilLean.value.set(ahead.x - foot.x, ahead.z - foot.z).multiplyScalar(2.2 * Math.sin(along * Math.PI));
      devil.devilTime.value = time;
      devil.devilStrength.value = THREE.MathUtils.smoothstep(since, SPIN_UP - 0.4, SPIN_UP + 2.4) * (1 - THREE.MathUtils.smoothstep(since, end - 2.8, end));
      const showing = devil.devilStrength.value > 0.002;
      for (const part of devilParts) part.visible = showing;
      // Heard before it is seen: the first gust sounds where it will rise, then it roars as it goes.
      if (time > gustAt) {
        gustAt = time + 2.3 + random() * 0.9;
        const first = since < 0.5;
        if (since < end - 1.5) say("windGust", foot.x, 2.5, foot.z, first ? 1 : 0.55 + 0.3 * devil.devilStrength.value, first ? 0.78 : 0.9 + random() * 0.3);
      }
      if (since > 2.2 && rang < 1) { rang = 1; swinging.chime?.kick(1.6); swinging.shutter?.kick(0.5); swinging.loft?.kick(0.5); swinging.bucket?.kick(0.5); swinging.sign?.kick(0.25); }
      if (since > 6 && rang < 2) { rang = 2; swinging.chime?.kick(1.2); say("clothSnap", lane ? 1.5 : -3, lane ? 4.3 : 5.6, lane ? -16.6 : 3.4, 0.8, 0.9 + random() * 0.2); }
      if (!flushed && along > 0.3) { flushed = true; life.startle(foot, 0.3); }
    });
  }

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 2.4);

  flush();

  // ---- Light ---------------------------------------------------------------
  // Open shade under a desert sky is lit blue from above and warm from the sunlit ground.
  scene.add(new THREE.HemisphereLight(0x9ec3f2, 0xd2a570, 1.15));
  const sun = kit.sunLight({ color: 0xfff2dd, intensity: 8.5, toSun: TO_SUN, extent: 30, distance: 52, near: 6, far: 100, radius: 2 });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 420, x: 18, y: [0.2, 6], z: [-28, 8], color: 0xffe6bd, opacity: 0.14 });

  const lit = sunlitFromBoxes(TO_SUN, [
    ...clothBoxes,
    new THREE.Box3(new THREE.Vector3(9.54, 0, -29.4), new THREE.Vector3(10.4, WALL_TOP, 10.4)),
    new THREE.Box3(new THREE.Vector3(-10.4, 0, 9.7), new THREE.Vector3(10.4, 7.6, 10.5)),
  ]);

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills: [],
    reflection,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 2.2, skyRotation: 0, skyClamp: 24,
      background: 0x86a9d6, fog: 0xd9c4a2, fogDensity: high ? 0.0042 : 0.006,
      haze: new THREE.Color(0.05, 0.04, 0.028), hazeDensity: 0.0022, hazeCeiling: 9, hazeFade: 3,
      environmentIntensity: 1.2, exposure: 0.78, far: 220,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  // A shot puts the birds up and scatters the hens; a hit on one of them, or on anything that hangs, is theirs to answer.
  return {
    ...range,
    startle: life.startle,
    struck: (object, point) => { answering = true; const dealt = life.struck(object, point); answering = false; return dealt; },
  };
}

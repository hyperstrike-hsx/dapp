import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { canvasTexture, createKit, projectUv, sunlitFromBoxes, type RangeEnvironment, type RangeOptions } from "../kit";
import { createLife } from "../life";
import { createProps, type PropItem, type PropKind } from "../props";
import { createTrees, type TreeItem } from "../trees";
import { createWind } from "../wind";
import type { Cue, CueName } from "../cues";
import type { Glow } from "../volumetric";

// Backwater: a quay in a canal quarter just after sunrise.
//
// The range is the quay. Its west side is the canal: for eighteen metres beside the firing line the edge is
// open (coping, mooring rings, a post-and-chain rail, steps down to the water), and from there on a bonded
// warehouse stands in the water with its wall on the quay edge. A stepped stone footbridge springs from the
// quay and crosses to the far bank, where a row of gabled houses is broken by a small square: the low sun
// comes through that gap, across the water and the firing line, and stands in the mist as shafts. The east
// side is a terrace of house and shop fronts in the sun; the far end is closed by a counting house with tall
// stores, a gangway between them and a bell tower going back into the mist behind it.
//
// Everything static is merged into one mesh per material. The far bank is a single vertex-coloured mesh,
// and the same triangles are drawn a second time, laid flat on the water, as its reflection.

const TO_SUN = new THREE.Vector3(-0.7, 0.34, -0.45).normalize();
const WATER_Y = -1.6;
/** Face of the quay wall, of the far quay wall, and of the houses on the far bank. */
const QUAY_X = -10.12, FAR_QUAY = -24, FAR_FRONT = -27;
const WALL_X = 9.54, BACK_Z = 9.7, END_Z = -28.6;
/** The bonded warehouse on the west side: it stands in the canal. */
const WARE = { z0: -29.2, z1: -8.6, x0: -17.14, eaves: 9.6, rise: 3.05 };
const BRIDGE_Z = -5.4;
const WALL_T = 0.3;
const FOG = 0xd8d1c4;
const TAU = Math.PI * 2;
/** The air comes up the canal from the south-west. */
const WIND_HEADING = -0.5;

type V3 = [number, number, number];
type Rect = [number, number, number, number];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scaling = new THREE.Vector3(), euler = new THREE.Euler();
const mat4 = (x = 0, y = 0, z = 0, rotation?: V3, scale?: V3 | number) => {
  euler.set(rotation?.[0] ?? 0, rotation?.[1] ?? 0, rotation?.[2] ?? 0);
  if (typeof scale === "number") scaling.setScalar(scale); else if (scale) scaling.set(scale[0], scale[1], scale[2]); else scaling.set(1, 1, 1);
  return new THREE.Matrix4().compose(position.set(x, y, z), quaternion.setFromEuler(euler), scaling);
};

// ---- Geometry ----------------------------------------------------------------

const box = (w: number, h: number, d: number, metres = 1.8) => projectUv(new THREE.BoxGeometry(w, h, d), metres);
const bar = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const rbox = (w: number, h: number, d: number, radius = 0.02, metres = 1.8) => projectUv(new RoundedBoxGeometry(w, h, d, 2, radius), metres);
const lathe = (profile: number[][], segments = 14) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);

function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 10, radiusTop = radius, open = false) {
  const geometry = new THREE.CylinderGeometry(radiusTop, radius, length, segments, 1, open);
  if (axis === "x") geometry.rotateZ(-Math.PI / 2); else if (axis === "z") geometry.rotateX(Math.PI / 2);
  return geometry;
}

const UP = new THREE.Vector3(0, 1, 0);
/** A round bar from `a` to `b`. */
function rod(a: V3, b: V3, radius: number, segments = 6, radiusEnd = radius) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), length = from.distanceTo(to);
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, segments, 1, false);
  geometry.translate(0, length / 2, 0);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, to.sub(from).normalize()));
  geometry.translate(a[0], a[1], a[2]);
  return geometry;
}

/** A rope or chain hung between two points. */
function hang(a: V3, b: V3, sag: number, radius: number, segments = 12, radial = 5) {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    points.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, radius, radial, false);
}

/** A box without its underside. */
function openBox(w: number, h: number, d: number, metres = 2) {
  const geometry = box(w, h, d, metres), index = Array.from(geometry.index!.array);
  index.splice(18, 6);
  geometry.setIndex(index);
  return geometry;
}

/** A pitched roof standing on y = 0: two slopes and two gable ends, tiles coursed up the slope. */
function ridgePrism(span: number, height: number, length: number, axis: "x" | "z", metres = 1.6) {
  const a = span / 2, l = length / 2, slope = Math.hypot(a, height), u = length / metres, v = slope / metres;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], index: number[] = [];
  const face = (points: V3[], normal: V3, uv: number[][]) => {
    const start = positions.length / 3;
    points.forEach((point, i) => { positions.push(...point); normals.push(...normal); uvs.push(uv[i][0], uv[i][1]); });
    for (let i = 2; i < points.length; i += 1) index.push(start, start + i - 1, start + i);
  };
  face([[a, 0, l], [a, 0, -l], [0, height, -l], [0, height, l]], [height / slope, a / slope, 0], [[u, 0], [0, 0], [0, v], [u, v]]);
  face([[-a, 0, -l], [-a, 0, l], [0, height, l], [0, height, -l]], [-height / slope, a / slope, 0], [[u, 0], [0, 0], [0, v], [u, v]]);
  face([[-a, 0, l], [a, 0, l], [0, height, l]], [0, 0, 1], [[0, 0], [span / metres, 0], [a / metres, height / metres]]);
  face([[a, 0, -l], [-a, 0, -l], [0, height, -l]], [0, 0, -1], [[0, 0], [span / metres, 0], [a / metres, height / metres]]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  if (axis === "x") geometry.rotateY(Math.PI / 2);
  return geometry;
}

/** Repeats a geometry's texture `u` by `v` times. */
function tiled<T extends THREE.BufferGeometry>(geometry: T, u: number, v: number): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  return geometry;
}

/** Writes a colour on every vertex from its uv. */
function shadeUv<T extends THREE.BufferGeometry>(geometry: T, shade: (u: number, v: number) => V3): T {
  const uv = geometry.attributes.uv, data = new Float32Array(uv.count * 3);
  for (let i = 0; i < uv.count; i += 1) data.set(shade(uv.getX(i), uv.getY(i)), i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(data, 3));
  return geometry;
}

/** Writes a colour on every vertex from its height: used for weed and damp lines on stone standing in water. */
function shadeY<T extends THREE.BufferGeometry>(geometry: T, shade: (y: number) => V3): T {
  const at = geometry.attributes.position, data = new Float32Array(at.count * 3);
  for (let i = 0; i < at.count; i += 1) data.set(shade(at.getY(i)), i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(data, 3));
  return geometry;
}

type Fill = "window" | "door" | "shop" | "hatch" | "none";
type Hole = { x: number; y: number; w: number; h: number; arch?: number; fill: Fill; floor: number };

/**
 * A wall with its face on z = 0 and its thickness behind it. `outline` is the elevation (x across, y up);
 * every hole is a true opening with reveals, square-headed or under a segmental arch of the given rise.
 */
function facade(outline: Array<[number, number]>, holes: Hole[], thickness: number, metres: number) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hole of holes) {
    const path = new THREE.Path(), x0 = hole.x - hole.w / 2, x1 = hole.x + hole.w / 2, rise = Math.min(hole.arch ?? 0, hole.w / 2), top = hole.y + hole.h;
    path.moveTo(x0, hole.y);
    path.lineTo(x0, top - rise);
    if (rise > 0.01) {
      const radius = (hole.w * hole.w / 4 + rise * rise) / (2 * rise), angle = Math.atan2(radius - rise, hole.w / 2);
      path.absarc(hole.x, top - radius, radius, Math.PI - angle, angle, true);
    }
    path.lineTo(x1, top - rise);
    path.lineTo(x1, hole.y);
    path.closePath();
    shape.holes.push(path);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 10 });
  geometry.translate(0, 0, -thickness);
  return projectUv(geometry, metres);
}

type Gable = "point" | "step" | "bell" | "neck" | "eaves";

/** Elevation of a house front: a rectangle from `base` to `eaves` with a gable of the given kind over it. */
function gableOutline(kind: Gable, w: number, base: number, eaves: number, rise: number): Array<[number, number]> {
  const h = w / 2, right: Array<[number, number]> = [[h, eaves]];
  if (kind === "point") right.push([0, eaves + rise]);
  else if (kind === "step") {
    const n = Math.max(3, Math.round(rise / 0.62)), top = Math.min(0.9, w * 0.16), run = (h - top / 2) / n, up = rise / n;
    for (let i = 0; i < n; i += 1) right.push([h - i * run, eaves + (i + 1) * up], [h - (i + 1) * run, eaves + (i + 1) * up]);
  } else if (kind === "bell") {
    const top = w * 0.19, body = rise - 0.6, foot = eaves + 0.16;
    right.push([h, foot], [h - 0.1, foot]);
    for (let i = 1; i <= 10; i += 1) {
      const t = i / 10;
      right.push([top + (h - 0.1 - top) * Math.pow(0.5 + 0.5 * Math.cos(Math.PI * t), 1.3), foot + (body - 0.16) * t]);
    }
    right.push([top + 0.12, eaves + body], [top + 0.12, eaves + body + 0.12]);
    for (let i = 1; i <= 6; i += 1) {
      const a = (i / 6) * Math.PI / 2;
      right.push([(top + 0.12) * Math.cos(a), eaves + body + 0.12 + (rise - body - 0.12) * Math.sin(a)]);
    }
  } else if (kind === "neck") {
    const neck = w * 0.27, foot = eaves + 0.2;
    right.push([h, foot], [neck + 0.75, foot]);
    for (let i = 1; i <= 6; i += 1) {
      const a = (i / 6) * Math.PI / 2;
      right.push([neck + 0.75 - 0.75 * Math.sin(a), foot + 0.95 - 0.95 * Math.cos(a)]);
    }
    right.push([neck, eaves + rise - 0.75], [neck + 0.14, eaves + rise - 0.75], [neck + 0.14, eaves + rise - 0.6], [0, eaves + rise]);
  }
  const outline: Array<[number, number]> = [[-h, base], [h, base], ...right];
  for (let i = right.length - 1; i >= 0; i -= 1) if (right[i][0] > 1e-4) outline.push([-right[i][0], right[i][1]]);
  return outline;
}

/** One leaf of a window shutter, louvred or boarded, centred on the origin and facing +z. */
function shutterLeaf(w: number, h: number, louvred: boolean) {
  const parts: THREE.BufferGeometry[] = [], stile = 0.05, t = 0.034;
  if (!louvred) {
    parts.push(bar(w, h, t * 0.7));
    for (const y of [-h * 0.32, h * 0.32]) parts.push(bar(w, 0.07, t).translate(0, y, 0.008));
  } else {
    for (const x of [-w / 2 + stile / 2, w / 2 - stile / 2]) parts.push(bar(stile, h, t).translate(x, 0, 0));
    for (const y of [-h / 2 + 0.035, 0, h / 2 - 0.035]) parts.push(bar(w - stile * 2, 0.07, t).translate(0, y, 0));
    const n = Math.max(3, Math.round((h / 2 - 0.1) / 0.052));
    for (const side of [-1, 1]) for (let i = 0; i < n; i += 1) parts.push(bar(w - stile * 2, 0.008, 0.046).rotateX(0.72).translate(0, side * (0.07 + (i + 0.5) * (h / 2 - 0.105) / n), 0));
    parts.push(bar(w - stile * 2, h - 0.1, 0.004).translate(0, 0, -0.013));
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((part) => part.dispose());
  return merged;
}

/**
 * An open boat: stern at -x, bow at +x, the gunwale amidships on y = 0. Returns the planking outside and
 * inside, the gunwales, the transom, a sole laid `floor` below the gunwale, and the boat's lines.
 */
function boatHull(length: number, beam: number, depth: number, sheer: number, floor: number) {
  const N = 16, M = 10;
  const half = (t: number) => (t < 0.4 ? 0.74 + 0.26 * Math.sin((t / 0.4) * Math.PI / 2) : Math.pow(Math.max(0, Math.cos(((t - 0.4) / 0.6) * Math.PI / 2)), 0.72)) * beam / 2;
  const rise = (t: number) => sheer * Math.pow(Math.abs(t - 0.42) / 0.58, 2);
  const deep = (t: number) => depth * (t > 0.78 ? 1 - 0.5 * Math.pow((t - 0.78) / 0.22, 2) : 0.86 + 0.14 * Math.sin(Math.min(1, t / 0.4) * Math.PI / 2));
  const at = (t: number, a: number, inset: number): V3 => {
    const s = Math.sin(a), c = Math.cos(a);
    return [(t - 0.5) * length, rise(t) - Math.pow(s, 0.8) * deep(t) + inset * s, -c * Math.max(half(t), 0.012) * (0.9 + 0.1 * (1 - s)) * (1 - inset * 1.6)];
  };
  const build = (positions: number[], uvs: number[], index: number[]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return geometry;
  };
  const skin = (inset: number, flip: boolean) => {
    const positions: number[] = [], uvs: number[] = [], index: number[] = [];
    for (let i = 0; i <= N; i += 1) for (let j = 0; j <= M; j += 1) { positions.push(...at(i / N, (j / M) * Math.PI, inset)); uvs.push((j / M) * 1.5, (i / N) * length / 1.4); }
    for (let i = 0; i < N; i += 1) for (let j = 0; j < M; j += 1) {
      const a = i * (M + 1) + j, b = a + M + 1;
      if (flip) index.push(a, a + 1, b, b, a + 1, b + 1); else index.push(a, b, a + 1, b, b + 1, a + 1);
    }
    return build(positions, uvs, index);
  };
  const stern = (flip: boolean) => {
    const positions: number[] = [-length / 2, rise(0) - deep(0) * 0.45, 0], uvs: number[] = [0.5, 0.5], index: number[] = [];
    for (let j = 0; j <= M; j += 1) { const p = at(0, (j / M) * Math.PI, 0); positions.push(...p); uvs.push(p[2] / 1.4 + 0.5, p[1] / 1.4 + 0.5); }
    for (let j = 0; j <= M; j += 1) { const a = 1 + j, b = 1 + ((j + 1) % (M + 1)); if (flip) index.push(0, b, a); else index.push(0, a, b); }
    return build(positions, uvs, index);
  };
  // The sole: boards across the bottom, as wide as the hull is at that height.
  const positions: number[] = [], uvs: number[] = [], index: number[] = [], rows = 14;
  for (let i = 0; i <= rows; i += 1) {
    const t = 0.012 + (i / rows) * 0.86, reach = Math.min(0.985, (rise(t) + floor) / deep(t)), a = Math.asin(Math.pow(reach, 1 / 0.8));
    const z = Math.cos(a) * Math.max(half(t), 0.012) * (0.9 + 0.1 * (1 - Math.sin(a))) * 0.95, x = (t - 0.5) * length;
    positions.push(x, -floor, -z, x, -floor, z); uvs.push(-z / 1.4, x / 1.4, z / 1.4, x / 1.4);
    if (i < rows) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const edge = (side: number) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: N + 1 }, (_, i) => new THREE.Vector3(...at(i / N, side > 0 ? Math.PI : 0, 0)))), 28, 0.028, 5, false);
  const rail = mergeGeometries([edge(-1), edge(1)])!;
  return { outer: mergeGeometries([skin(0, false), stern(false)])!, inner: mergeGeometries([skin(0.03, true), stern(true).translate(0.02, 0, 0)])!, sole: build(positions, uvs, index), rail, half, rise };
}

// ---- Painted textures ------------------------------------------------------------

/** A colour sheet and the normal map of a height sheet painted with it, both tileable. */
function reliefSet(size: number, paintIt: (colour: CanvasRenderingContext2D, height: CanvasRenderingContext2D, size: number) => void, strength: number) {
  const sheet = () => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = size; return canvas; };
  const colour = sheet(), height = sheet(), heightContext = height.getContext("2d", { willReadFrequently: true })!;
  paintIt(colour.getContext("2d")!, heightContext, size);
  const source = heightContext.getImageData(0, 0, size, size).data, normal = new ImageData(size, size), out = normal.data;
  const at = (x: number, y: number) => source[(((y + size) % size) * size + ((x + size) % size)) * 4];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (at(x - 1, y) - at(x + 1, y)) / 255 * strength, ny = (at(x, y + 1) - at(x, y - 1)) / 255 * strength, inverse = 1 / Math.hypot(nx, ny, 1), i = (y * size + x) * 4;
      out[i] = (nx * inverse * 0.5 + 0.5) * 255; out[i + 1] = (ny * inverse * 0.5 + 0.5) * 255; out[i + 2] = (inverse * 0.5 + 0.5) * 255; out[i + 3] = 255;
    }
  }
  const map = canvasTexture(size, size, (context) => context.drawImage(colour, 0, 0), true);
  const normalMap = canvasTexture(size, size, (context) => context.putImageData(normal, 0, 0), true);
  normalMap.colorSpace = THREE.NoColorSpace;
  colour.width = colour.height = height.width = height.height = 0;
  return { map, normalMap };
}

/** Coursed ashlar, eight courses to the tile: quay walls, the bridge, copings, sills and plinths. */
function paintStone(c: CanvasRenderingContext2D, r: CanvasRenderingContext2D, size: number) {
  const next = rng(41), rows = 8, rowH = size / rows;
  c.fillStyle = "#4b4740"; c.fillRect(0, 0, size, size);
  r.fillStyle = "#0c0c0c"; r.fillRect(0, 0, size, size);
  for (let row = 0; row < rows; row += 1) {
    const widths: number[] = [];
    let total = 0;
    while (total < 1) { const w = 0.13 + next() * 0.2; widths.push(w); total += w; }
    const offset = next() * size, top = row * rowH;
    let x = 0;
    for (const w of widths) {
      const px = (w / total) * size, shade = 150 + next() * 44, warm = next() * 16, level = Math.floor(185 + next() * 65);
      for (const shift of [0, -size]) {
        const left = ((offset + x) % size) + shift;
        c.fillStyle = `rgb(${Math.floor(shade + warm)},${Math.floor(shade + warm * 0.6)},${Math.floor(shade)})`;
        c.fillRect(left + 2.5, top + 2.5, px - 5, rowH - 5);
        r.fillStyle = `rgb(${level},${level},${level})`;
        r.fillRect(left + 2.5, top + 2.5, px - 5, rowH - 5);
        r.strokeStyle = "rgba(0,0,0,0.35)"; r.lineWidth = 5;
        r.strokeRect(left + 4.5, top + 4.5, px - 9, rowH - 9);
      }
      x += px;
    }
  }
  for (let i = 0; i < (size * size) / 80; i += 1) {
    const x = next() * size, y = next() * size, s = 1 + next() * 2.5, dark = next() < 0.6;
    c.fillStyle = dark ? `rgba(40,36,30,${0.05 + next() * 0.16})` : `rgba(236,230,214,${0.04 + next() * 0.12})`;
    c.fillRect(x, y, s * (1 + next() * 2), s);
    r.fillStyle = dark ? `rgba(0,0,0,${0.1 + next() * 0.25})` : `rgba(255,255,255,${0.06 + next() * 0.12})`;
    r.fillRect(x, y, s, s);
  }
  for (let i = 0; i < 26; i += 1) {
    const x = next() * size, y = next() * size, h = size * (0.06 + next() * 0.2), run = c.createLinearGradient(0, y, 0, y + h);
    run.addColorStop(0, "rgba(52,54,42,0.24)"); run.addColorStop(1, "rgba(52,54,42,0)");
    c.fillStyle = run; c.fillRect(x, y, 4 + next() * 22, h);
  }
}

/** Pantiles: light and neutral, so a vertex tint makes them red clay or slate. */
function paintTiles(c: CanvasRenderingContext2D, r: CanvasRenderingContext2D, size: number) {
  const next = rng(77), rows = 5, cols = 8, th = size / rows, tw = size / cols;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = col * tw, y = row * th, shade = Math.floor(172 + next() * 34);
      c.fillStyle = `rgb(${shade + 10},${shade},${shade - 8})`; c.fillRect(x, y, tw, th);
      const across = r.createLinearGradient(x, 0, x + tw, 0);
      across.addColorStop(0, "#2c2c2c"); across.addColorStop(0.36, "#f2f2f2"); across.addColorStop(0.72, "#8c8c8c"); across.addColorStop(1, "#2c2c2c");
      r.fillStyle = across; r.fillRect(x, y, tw, th);
      const down = r.createLinearGradient(0, y, 0, y + th);
      down.addColorStop(0, "rgba(0,0,0,0.6)"); down.addColorStop(0.22, "rgba(0,0,0,0.1)"); down.addColorStop(1, "rgba(255,255,255,0.14)");
      r.fillStyle = down; r.fillRect(x, y, tw, th);
      const lap = c.createLinearGradient(0, y, 0, y + th * 0.34);
      lap.addColorStop(0, "rgba(22,17,13,0.55)"); lap.addColorStop(1, "rgba(22,17,13,0)");
      c.fillStyle = lap; c.fillRect(x, y, tw, th * 0.34);
      c.fillStyle = "rgba(28,22,18,0.3)"; c.fillRect(x, y, 2, th);
    }
  }
  for (let i = 0; i < 260; i += 1) {
    const moss = next() < 0.4;
    c.fillStyle = moss ? `rgba(86,96,58,${0.12 + next() * 0.3})` : `rgba(40,34,30,${0.08 + next() * 0.22})`;
    c.fillRect(next() * size, next() * size, 2 + next() * 8, 2 + next() * 5);
  }
}

const SERIF = "Georgia, 'Times New Roman', serif", SANS = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", SLAB = "Rockwell, 'Courier New', Georgia, serif";
type Line = [text: string, size: number, y: number, font?: string, colour?: string];
type Art = { key: string; w: number; h: number; draw: (c: CanvasRenderingContext2D, w: number, h: number) => void };

function lettering(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, colour: string, font = SERIF, fit?: number) {
  c.font = `bold ${size}px ${font}`;
  c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = colour;
  if (fit) c.fillText(text, x, y, fit); else c.fillText(text, x, y);
}

/** Weather on paint: specks of dirt on a board, or paint gone from lettering on a wall. */
function wear(c: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number, erase = false) {
  const next = rng(seed);
  c.save();
  if (erase) c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < (w * h * amount) / 50; i += 1) {
    const s = 1 + next() * 3;
    c.fillStyle = erase ? `rgba(0,0,0,${0.3 + next() * 0.6})` : `rgba(${Math.floor(24 + next() * 30)},${Math.floor(20 + next() * 24)},${Math.floor(14 + next() * 20)},${0.1 + next() * 0.3})`;
    c.fillRect(next() * w, next() * h, s * (1 + next() * 4), s);
  }
  c.restore();
}

const board = (key: string, w: number, h: number, ground: string, ink: string, lines: Line[], look: { border?: string; wear?: number } = {}): Art => ({
  key, w, h,
  draw(c) {
    c.fillStyle = ground; c.fillRect(0, 0, w, h);
    const shade = c.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, "rgba(255,255,255,0.07)"); shade.addColorStop(1, "rgba(0,0,0,0.16)");
    c.fillStyle = shade; c.fillRect(0, 0, w, h);
    if (look.border) { const inset = Math.max(5, Math.min(w, h) * 0.05); c.strokeStyle = look.border; c.lineWidth = Math.max(2.5, Math.min(w, h) * 0.022); c.strokeRect(inset, inset, w - inset * 2, h - inset * 2); }
    for (const [text, size, y, font, colour] of lines) lettering(c, text, w / 2, h * y, h * size, colour ?? ink, font, w * 0.9);
    wear(c, w, h, look.wear ?? 0.22, key.length * 131 + w);
  },
});

/** Lettering painted straight on a wall: only the letters are opaque, and much of them has weathered off. */
const walled = (key: string, w: number, h: number, ink: string, lines: Line[], lost = 0.9): Art => ({
  key, w, h,
  draw(c) {
    for (const [text, size, y, font, colour] of lines) lettering(c, text, w / 2, h * y, h * size, colour ?? ink, font, w * 0.97);
    wear(c, w, h, lost, key.length * 57 + h, true);
  },
});

function signArts(): Art[] {
  const enamel = (key: string, w: number, h: number, lines: Line[], ground = "#f1ede2", ink = "#16191c") => board(key, w, h, ground, ink, lines, { border: ink, wear: 0.3 });
  const bill = (key: string, w: number, h: number, ground: string, lines: Line[]) => board(key, w, h, ground, "#1d1a16", lines, { wear: 0.5 });
  return [
    walled("wharf", 2032, 132, "#e9e2d2", [["KEYSTONE WHARF  ·  BONDED STORES  ·  EST. MDCCCXII", 0.66, 0.52]]),
    walled("cases", 1480, 110, "#e6dfcf", [["10 000 CASES  ·  KEYS SOLD SEPARATELY", 0.7, 0.52, SLAB]]),
    walled("bitters", 900, 270, "#e9dfc6", [["DRINK", 0.2, 0.14, SLAB], ["HEADSHOT BITTERS", 0.34, 0.47], ["ONE TAP IS ENOUGH", 0.2, 0.84, SLAB]], 1.4),
    walled("bank", 1300, 112, "#2b2620", [["SAVE ROUND SAVINGS & LOAN", 0.74, 0.52]], 0.3),
    board("smith", 1000, 140, "#1c2420", "#d9c89a", [["SMITH & STRIKER  ·  IRONWORK  ·  KEYS CUT", 0.5, 0.52]], { border: "#d9c89a" }),
    board("shop", 1000, 132, "#243a33", "#ead9a8", [["FORCE BUY PROVISIONS", 0.6, 0.52]], { border: "#ead9a8" }),
    board("chandler", 760, 120, "#3a1f1b", "#e8d6a6", [["CACHE & CARRY  ·  SHIP CHANDLER", 0.5, 0.52]], { border: "#e8d6a6" }),
    {
      key: "bakery", w: 340, h: 340,
      draw(c, w, h) {
        c.fillStyle = "#274436"; c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 4, 0, TAU); c.fill();
        c.strokeStyle = "#e6c77a"; c.lineWidth = 9; c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 22, 0, TAU); c.stroke();
        // A pretzel, as a bakery sign should have.
        c.lineWidth = 15; c.lineCap = "round"; c.strokeStyle = "#c98a3c";
        c.beginPath(); c.ellipse(w * 0.4, h * 0.47, w * 0.1, h * 0.085, 0, 0, TAU); c.stroke();
        c.beginPath(); c.ellipse(w * 0.6, h * 0.47, w * 0.1, h * 0.085, 0, 0, TAU); c.stroke();
        c.beginPath(); c.moveTo(w * 0.34, h * 0.6); c.quadraticCurveTo(w * 0.5, h * 0.3, w * 0.66, h * 0.6); c.stroke();
        lettering(c, "RUSH B", w / 2, h * 0.25, h * 0.14, "#f0dfae", SERIF, w * 0.6);
        lettering(c, "BAKERY", w / 2, h * 0.76, h * 0.13, "#f0dfae", SERIF, w * 0.6);
        wear(c, w, h, 0.25, 91);
      },
    },
    {
      key: "inn", w: 320, h: 400,
      draw(c, w, h) {
        c.fillStyle = "#5a1f1c"; c.fillRect(0, 0, w, h);
        c.strokeStyle = "#e2c98a"; c.lineWidth = 8; c.strokeRect(14, 14, w - 28, h - 28);
        // A key laid across a case.
        c.fillStyle = "#c9a44c"; c.fillRect(w * 0.28, h * 0.4, w * 0.44, h * 0.22);
        c.fillStyle = "#3a2a14"; c.fillRect(w * 0.28, h * 0.49, w * 0.44, h * 0.03); c.fillRect(w * 0.47, h * 0.47, w * 0.06, h * 0.07);
        c.strokeStyle = "#f0e2b4"; c.lineWidth = 9; c.beginPath(); c.arc(w * 0.33, h * 0.33, w * 0.07, 0, TAU); c.stroke();
        c.beginPath(); c.moveTo(w * 0.39, h * 0.36); c.lineTo(w * 0.7, h * 0.56); c.moveTo(w * 0.62, h * 0.51); c.lineTo(w * 0.58, h * 0.56); c.stroke();
        lettering(c, "THE", w / 2, h * 0.13, h * 0.07, "#f0e2b4", SERIF);
        lettering(c, "FULL BUY", w / 2, h * 0.23, h * 0.11, "#f0e2b4", SERIF, w * 0.8);
        lettering(c, "ROOMS · ALE", w / 2, h * 0.8, h * 0.075, "#f0e2b4", SERIF, w * 0.8);
        wear(c, w, h, 0.3, 17);
      },
    },
    board("lock", 300, 190, "#1d2a3a", "#e9e2cf", [["DOOR STUCK?", 0.24, 0.3], ["LOCKSMITH", 0.22, 0.62], ["KEYS · CASES · HINGES", 0.1, 0.86, SANS]], { border: "#c9b27a" }),
    enamel("quayName", 420, 104, [["BACKWATER QUAY", 0.44, 0.54, SANS]], "#1f3f6b", "#f1ede2"),
    enamel("laneName", 420, 104, [["RUSH B LANE", 0.44, 0.54, SANS]], "#1f3f6b", "#f1ede2"),
    enamel("stepsName", 420, 104, [["TRADE-UP STEPS", 0.44, 0.54, SANS]], "#1f3f6b", "#f1ede2"),
    enamel("noMooring", 300, 210, [["NO MOORING", 0.24, 0.26, SANS], ["LOADING ONLY", 0.2, 0.55, SANS], ["BY ORDER · QUAY WARDEN", 0.1, 0.84, SANS]]),
    enamel("edge", 300, 150, [["MIND THE EDGE", 0.3, 0.38, SANS], ["DEPTH 1.6 m · NO RESPAWN", 0.14, 0.76, SANS]], "#e8c23a"),
    enamel("dues", 300, 210, [["QUAY DUES", 0.24, 0.24, SANS], ["PAID AT No. 13", 0.18, 0.52, SANS], ["ECO ROUNDS HALF RATE", 0.11, 0.82, SANS]]),
    enamel("carts", 300, 190, [["BRIDGE", 0.26, 0.26, SANS], ["NO HANDCARTS", 0.2, 0.58, SANS], ["ONE AT A TIME · NO PEEKING", 0.1, 0.85, SANS]]),
    bill("tradeUp", 260, 360, "#e3d7b6", [["TRADE UP!", 0.13, 0.1, SLAB], ["TEN", 0.2, 0.3, SLAB, "#8a2a1e"], ["FOR ONE", 0.13, 0.47, SLAB], ["CONTRACTS SIGNED", 0.055, 0.63, SANS], ["WHILE YOU WAIT", 0.055, 0.7, SANS], ["NO REFUNDS", 0.08, 0.88, SLAB, "#8a2a1e"]]),
    bill("lost", 260, 340, "#ddd6c4", [["LOST", 0.2, 0.14, SLAB], ["ONE KNIFE", 0.12, 0.36, SLAB], ["PATTERN 661", 0.075, 0.52, SANS], ["FLOAT 0.0069", 0.075, 0.62, SANS], ["REWARD", 0.14, 0.84, SLAB, "#8a2a1e"]]),
    bill("auction", 260, 360, "#d9cba0", [["CASE", 0.17, 0.12, SLAB], ["AUCTION", 0.15, 0.3, SLAB], ["EVERY MARKET DAY", 0.06, 0.46, SANS], ["FACTORY NEW TO", 0.06, 0.58, SANS], ["BATTLE-SCARRED", 0.06, 0.65, SANS], ["KEYS SOLD", 0.09, 0.8, SLAB, "#8a2a1e"], ["SEPARATELY", 0.09, 0.9, SLAB, "#8a2a1e"]]),
    bill("eco", 260, 300, "#e6dcc2", [["ECO ROUND", 0.15, 0.14, SLAB], ["SPECIAL", 0.15, 0.33, SLAB], ["BREAD & SOUP", 0.085, 0.55, SANS], ["2d", 0.22, 0.79, SLAB, "#8a2a1e"]]),
    board("bargeName", 520, 86, "#15171a", "#ece6d6", [["BATTLE-SCARRED", 0.6, 0.54]], { wear: 0.35 }),
    board("skiffName", 360, 68, "#e9e3d2", "#1c2a3a", [["WELL WORN", 0.62, 0.55]], { wear: 0.4 }),
    board("reg", 200, 68, "#e9e3d2", "#15171a", [["BW 661", 0.62, 0.55, SANS]], { wear: 0.4 }),
    walled("fragile", 256, 120, "#1a1612", [["FRAGILE", 0.36, 0.3, SANS], ["FN 0.07", 0.3, 0.74, SANS]], 0.7),
    walled("pattern", 256, 120, "#1a1612", [["PATTERN", 0.3, 0.3, SANS], ["No. 387", 0.34, 0.74, SANS]], 0.7),
    walled("thisWay", 256, 120, "#1a1612", [["THIS WAY UP", 0.3, 0.3, SANS], ["LONG  ↑  SHORT", 0.24, 0.74, SANS]], 0.7),
    ...["11", "13", "15", "17", "19"].map((number) => enamel(`no${number}`, 96, 110, [[number, 0.6, 0.55, SANS]])),
    {
      key: "clock", w: 440, h: 440,
      draw(c, w, h) {
        const r = w / 2;
        c.fillStyle = "#1b1d1f"; c.beginPath(); c.arc(r, r, r - 2, 0, TAU); c.fill();
        c.fillStyle = "#e9e1c8"; c.beginPath(); c.arc(r, r, r - 20, 0, TAU); c.fill();
        c.strokeStyle = "#1b1d1f";
        for (let i = 0; i < 60; i += 1) {
          const a = (i / 60) * TAU, hour = i % 5 === 0;
          c.lineWidth = hour ? 9 : 3;
          c.beginPath(); c.moveTo(r + Math.sin(a) * (r - (hour ? 78 : 50)), r - Math.cos(a) * (r - (hour ? 78 : 50))); c.lineTo(r + Math.sin(a) * (r - 32), r - Math.cos(a) * (r - 32)); c.stroke();
        }
        // Twenty to six.
        const hand = (turn: number, length: number, width: number) => { c.lineWidth = width; c.lineCap = "round"; c.beginPath(); c.moveTo(r - Math.sin(turn) * 24, r + Math.cos(turn) * 24); c.lineTo(r + Math.sin(turn) * length, r - Math.cos(turn) * length); c.stroke(); };
        hand((5.67 / 12) * TAU, r * 0.5, 16); hand((40 / 60) * TAU, r * 0.76, 10);
        c.fillStyle = "#1b1d1f"; c.beginPath(); c.arc(r, r, 14, 0, TAU); c.fill();
        wear(c, w, h, 0.25, 5);
      },
    },
    {
      // A lamp-lit room behind a net curtain.
      key: "window", w: 160, h: 220,
      draw(c, w, h) {
        const glow = c.createRadialGradient(w * 0.55, h * 0.62, 4, w * 0.5, h * 0.55, h * 0.75);
        glow.addColorStop(0, "#fff0c2"); glow.addColorStop(0.35, "#f2b869"); glow.addColorStop(1, "#8a4a1c");
        c.fillStyle = glow; c.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 9) { c.fillStyle = `rgba(90,50,20,${0.08 + 0.1 * Math.abs(Math.sin(x * 0.7))})`; c.fillRect(x, 0, 4, h); }
        c.fillStyle = "rgba(60,30,12,0.5)"; c.fillRect(0, 0, w, h * 0.16);
      },
    },
  ];
}

/** All painted words and pictures on one sheet, packed on shelves. */
function signAtlas() {
  const SIZE = 2048, PAD = 8, arts = signArts().sort((a, b) => b.h - a.h);
  const rects: Record<string, Rect> = {}, aspect: Record<string, number> = {};
  const texture = canvasTexture(SIZE, SIZE, (c) => {
    let x = PAD, y = PAD, shelf = 0;
    for (const art of arts) {
      if (x + art.w + PAD > SIZE) { x = PAD; y += shelf + PAD; shelf = 0; }
      c.save(); c.translate(x, y); c.beginPath(); c.rect(0, 0, art.w, art.h); c.clip();
      art.draw(c, art.w, art.h);
      c.restore();
      rects[art.key] = [x / SIZE, 1 - (y + art.h) / SIZE, (x + art.w) / SIZE, 1 - y / SIZE];
      aspect[art.key] = art.w / art.h;
      x += art.w + PAD; shelf = Math.max(shelf, art.h);
    }
    if (y + shelf > SIZE) console.warn("canal: the sign sheet is full");
  });
  return { texture, rects, aspect };
}

/** Diamond netting, cut out by alpha: lobster pots and the nets hung up to dry. */
function netTexture() {
  const texture = canvasTexture(128, 128, (c) => {
    c.strokeStyle = "#ffffff"; c.lineWidth = 5.5;
    for (let i = -128; i <= 256; i += 32) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 128, 128); c.stroke();
      c.beginPath(); c.moveTo(i + 128, 0); c.lineTo(i, 128); c.stroke();
    }
  }, true);
  return texture;
}

// ---- Shaders ----------------------------------------------------------------------

const glsl = (value: number) => value.toFixed(4);
const NOISE_GLSL = /* glsl */`
  float cHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float cNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), f.x), mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

/** Canal water, added to a standard material so it takes the sun, its shadows and the fog like everything else. */
const WATER_PARS = /* glsl */`
  varying vec3 vWaterWorld;
  uniform float waterTime;
  uniform vec4 waterRings[3];
  ${NOISE_GLSL}
  void cWave(vec2 p, vec2 heading, float span, float steep, float rate, float footprint, inout vec2 slope, inout float lost) {
    // A train too fine for the pixel it lands in stops rippling and roughens the mirror instead.
    float seen = 1.0 - smoothstep(0.22 * span, 0.7 * span, footprint);
    slope += heading * steep * seen * cos(dot(heading, p) * 6.2832 / span - rate * waterTime);
    lost += (1.0 - seen * seen) * steep * steep * 0.5;
  }
`;
const WATER_NORMAL = /* glsl */`
  {
    vec2 p = vWaterWorld.xz;
    float footprint = max(length(dFdx(p)), length(dFdy(p)));
    vec2 q = p + (vec2(cNoise(p * 0.21 + waterTime * 0.03), cNoise(p * 0.21 + 31.7 - waterTime * 0.026)) - 0.5) * 2.6;
    vec2 slope = vec2(0.0);
    float lost = 0.0;
    cWave(q, vec2(0.342, -0.94), 2.7, 0.03, 0.9, footprint, slope, lost);
    cWave(q, vec2(-0.5, -0.866), 1.45, 0.036, 1.3, footprint, slope, lost);
    cWave(q, vec2(0.866, -0.5), 0.83, 0.038, 1.9, footprint, slope, lost);
    cWave(p, vec2(-0.199, 0.98), 0.47, 0.036, 2.6, footprint, slope, lost);
    cWave(p, vec2(0.94, 0.342), 0.27, 0.03, 3.4, footprint, slope, lost);
    cWave(p, vec2(-0.766, -0.643), 0.15, 0.024, 4.6, footprint, slope, lost);
    // Rings spreading from a drip, a fish or a hull.
    for (int i = 0; i < 3; i++) {
      vec4 ring = waterRings[i];
      float age = waterTime - ring.z;
      if (age > 0.0 && age < 8.0) {
        vec2 d = p - ring.xy;
        float r = length(d) + 0.001, front = age * 0.55, band = (r - front) / 0.4;
        slope += (d / r) * cos((r - front) * 15.0) * exp(-band * band) * ring.w * (1.0 - age / 8.0) / (1.0 + front * 1.4);
      }
    }
    normal = normalize((viewMatrix * vec4(normalize(vec3(-slope.x, 1.0, -slope.y)), 0.0)).xyz);
    roughnessFactor = clamp(roughnessFactor + sqrt(lost) * 1.5, 0.0, 1.0);
  }
`;
/** Mist lying on the water, in banks that drift up the canal: it thickens with distance faster than the air does. */
const WATER_MIST = /* glsl */`
  #ifdef USE_FOG
  {
    vec2 p = vWaterWorld.xz;
    float away = length(cameraPosition - vWaterWorld);
    float bank = cNoise(p * 0.1 + vec2(waterTime * 0.04, -waterTime * 0.07)) * 0.62 + cNoise(p * 0.31 - vec2(waterTime * 0.08, waterTime * 0.05)) * 0.38;
    float mist = smoothstep(0.3, 0.72, bank) * smoothstep(8.0, 34.0, away) * 0.3;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, mist);
  }
  #endif
`;

/**
 * The far bank mirrored in the canal. Each vertex is slid along the line from the eye to its mirror image
 * until it lies on the water, so the reflection is right from wherever the player stands and nearer things
 * hide it by ordinary depth testing; ripples break it into dashes.
 */
const MIRROR_SHADER = {
  vertexShader: /* glsl */`
    uniform vec3 mirrorSun;
    uniform vec3 mirrorLight;
    uniform vec3 mirrorShade;
    varying vec3 vColour;
    varying vec2 vPlane;
    varying float vLift;
    #include <fog_pars_vertex>
    void main() {
      float lift = max(position.y - ${glsl(WATER_Y)}, 0.0);
      float eye = max(cameraPosition.y - ${glsl(WATER_Y)}, 0.4);
      vec2 p = mix(cameraPosition.xz, position.xz, eye / (eye + lift));
      vColour = color * (mirrorShade + mirrorLight * max(dot(normal, mirrorSun), 0.0));
      vPlane = p;
      vLift = lift;
      gl_Position = projectionMatrix * viewMatrix * vec4(p.x, ${glsl(WATER_Y + 0.012)}, p.y, 1.0);
      #ifdef USE_FOG
        vFogDepth = length(vec3(position.x, ${glsl(2 * WATER_Y)} - position.y, position.z) - cameraPosition);
      #endif
    }
  `,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec3 vColour;
    varying vec2 vPlane;
    varying float vLift;
    #include <fog_pars_fragment>
    ${NOISE_GLSL}
    void main() {
      float footprint = max(length(dFdx(vPlane)), length(dFdy(vPlane)));
      vec2 drift = vec2(time * 0.22, time * 0.13);
      // Ripples lie across the line of sight, so the image shivers along it.
      vec2 q = vec2(vPlane.x * 6.5, vPlane.y * 0.9);
      float ripple = cNoise(q + drift) * 0.6 + cNoise(q * 2.3 - drift * 1.6) * 0.4;
      float kept = mix(smoothstep(0.24, 0.5, ripple), 0.86, smoothstep(0.12, 0.9, footprint));
      float away = length(vPlane - cameraPosition.xz), eye = max(cameraPosition.y - ${glsl(WATER_Y)}, 0.4);
      float cosine = eye / sqrt(eye * eye + away * away);
      float fresnel = 0.02 + 0.98 * pow(1.0 - cosine, 5.0);
      gl_FragColor = vec4(vColour, clamp(fresnel * 3.6 + 0.12, 0.0, 0.94) * kept / (1.0 + vLift * 0.015));
      #include <fog_fragment>
    }
  `,
};

/** Sheets of mist a little above the water: thin seen from above, thick seen edge-on. */
const MIST_SHADER = {
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */`
    uniform float time;
    uniform vec3 mistColour;
    varying vec3 vWorld;
    ${NOISE_GLSL}
    void main() {
      vec2 p = vWorld.xz, drift = vec2(time * 0.1, -time * 0.19);
      float sheet = vWorld.y * 5.3;
      float n = cNoise(p * 0.1 + drift * 0.3 + sheet) * 0.62 + cNoise(p * 0.29 + drift + sheet * 2.1) * 0.38;
      vec3 toEye = cameraPosition - vWorld;
      float away = length(toEye);
      float thick = clamp(0.04 / max(abs(toEye.y) / away, 0.03), 0.0, 0.4);
      float banks = smoothstep(${glsl(QUAY_X - 0.2)}, ${glsl(QUAY_X - 2.6)}, vWorld.x) * smoothstep(${glsl(FAR_QUAY - 2.5)}, ${glsl(FAR_QUAY + 1.5)}, vWorld.x);
      gl_FragColor = vec4(mistColour, smoothstep(0.4, 0.82, n) * thick * smoothstep(4.0, 12.0, away) * banks);
    }
  `,
};

/**
 * The sky as the mist leaves it: the fog's own colour round the horizon, so that whatever is far off dissolves
 * into it, a pale blue overhead, and the low sun as a disc in a wide glow where the mist scatters it forward.
 */
const DOME_SHADER = {
  vertexShader: /* glsl */`
    varying vec3 vDirection;
    void main() {
      vDirection = position;
      vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
      gl_Position = clip.xyww;
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 domeFog;
    uniform vec3 domeZenith;
    uniform vec3 domeSun;
    uniform vec3 domeSunTint;
    uniform float domeGain;
    varying vec3 vDirection;
    void main() {
      vec3 d = normalize(vDirection);
      float up = max(d.y, 0.0), toward = max(dot(d, domeSun), 0.0);
      float clear = smoothstep(0.1, 0.7, up);
      vec3 colour = mix(domeFog, domeZenith, clear);
      colour += domeSunTint * (pow(toward, 5.0) * 0.4 + pow(toward, 40.0) * 0.6 + pow(toward, 400.0) * 1.2) * (1.0 - 0.45 * clear);
      colour += domeSunTint * smoothstep(0.99962, 0.99988, toward) * 5.0;
      gl_FragColor = vec4(colour * domeGain, mix(1.0, 0.8, smoothstep(0.35, 0.9, up)));
    }
  `,
};

type Paint = { material: THREE.Material; colour: THREE.Color };
type Opt = { shadow?: boolean; hit?: boolean; mirror?: boolean; fine?: boolean };
type Add = (geometry: THREE.BufferGeometry, paint: Paint | THREE.Material, x?: number, y?: number, z?: number, rotation?: V3, scale?: V3 | number, opt?: Opt) => void;

type HouseSpec = {
  w: number; d: number; floors: number[]; gable: Gable; rise?: number; roofRise?: number; base?: number; foot?: number;
  wall: Paint; trim: Paint; door: Paint; roof: Paint; shutter?: Paint; band?: Paint;
  bays: number; cols?: number[]; ground: "door" | "shop" | "blank"; doorBay?: number; hatchBay?: number;
  winW?: number; arch?: number; attic?: "window" | "hatch" | "none"; hoist?: boolean; chimneys?: number; lit?: number;
  /** Rectangles of the front (x0, x1, y0, y1) that must stay flat: no openings, nothing standing proud. */
  keep?: Rect[];
  holes?: Hole[];
  /** False for a wall alone, with no roof or body behind it. */
  shell?: boolean;
  /** How far the roof and body stop short of the left and right ends: room for a gable wall across the end. */
  clip?: [number, number];
  /** How far the body stands back behind the front wall: an open room behind an archway. */
  recess?: number;
  seed: number;
};

export function buildCanal(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, track, photoSet } = kit;
  const metals = kit.metals();
  const random = rng(1307);
  /** Chance for what happens while the range runs; the build keeps its own stream, so the map is the same every time. */
  const chance = rng(7129);

  // ---- Air, and the sounds that are placed in it -----------------------------------------
  // A light air up the canal from the south-west. Every fitting that can speak goes through one desk, so the
  // quay stays quiet: a thing that has spoken keeps still for a while, and no two speak at once.
  const wind = createWind({ heading: WIND_HEADING, strength: 0.24, gustiness: 0.6 });
  const QUIET: Partial<Record<CueName, number>> = { ropeClank: 7, waveSlap: 5, chainRattle: 12, signCreak: 12, shutterCreak: 14, clothSnap: 7, drip: 2.5, splash: 20, sparrowChirp: 5, pigeonCoo: 9, gullCry: 7, swiftScream: 12 };
  const spoke: Partial<Record<CueName, number>> = {};
  const heard = options.cue;
  let lastSpoke = 0, answering = false;
  const cue: Cue | undefined = heard && ((name, at, how) => {
    const quiet = QUIET[name];
    if (quiet !== undefined && !answering) {
      const time = performance.now() / 1000, since = time - (spoke[name] ?? -100), run = name === "sparrowChirp" ? 1.5 : 0;
      if (since > run) {
        if (time - lastSpoke < 0.7 || since < quiet * (0.7 + 0.6 * ((time * 0.618) % 1))) return;
        spoke[name] = lastSpoke = time;
      }
    }
    heard(name, at, how);
  });
  const life = createLife(kit, { ...options, cue }, { wind, seed: 13 });
  const trees = createTrees(kit, { seed: 13, wind, sun: () => sun });
  const props = createProps(kit);

  // ---- Materials ------------------------------------------------------------------------
  // Walls, timber, stone and tiles are tinted per part through vertex colours, so one material serves every
  // house in the terrace.
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.6, vertexColors: true, ...parameters });
  const stoneSet = reliefSet(1024, paintStone, 2.2), tileSet = reliefSet(512, paintTiles, 2.6);
  for (const texture of [stoneSet.map, stoneSet.normalMap, tileSet.map, tileSet.normalMap]) track(texture).anisotropy = anisotropy;
  const atlas = signAtlas();
  track(atlas.texture).anisotropy = anisotropy;
  const netMap = track(netTexture());
  netMap.anisotropy = anisotropy;
  const M = {
    brick: standard({ ...photoSet("/textures/brick_wall_001-2k", 1, 1, true), normalScale: new THREE.Vector2(1.2, 1.2) }),
    plaster: standard({ ...photoSet("/textures/painted_plaster_wall-2k", 1, 1, false) }),
    wood: standard({ ...photoSet("/textures/weathered_brown_planks-2k", 1, 1, false), envMapIntensity: 0.4 }),
    stone: standard({ map: stoneSet.map, normalMap: stoneSet.normalMap, roughness: 0.92 }),
    tile: standard({ map: tileSet.map, normalMap: tileSet.normalMap, roughness: 0.82 }),
    /** Gloss paint on joinery. */
    trim: standard({ roughness: 0.58 }),
    /** Anything dull and plain: rope, canvas, tar. */
    matte: standard({ roughness: 0.96, envMapIntensity: 0.35 }),
    iron: standard({ roughness: 0.52, metalness: 0.75, envMapIntensity: 0.9 }),
    glass: standard({ roughness: 0.06, envMapIntensity: 1.5 }),
    sign: standard({ map: atlas.texture, roughness: 0.7, alphaTest: 0.5 }),
    /** Lettering painted on a wall: it lies on the brick and takes its light. */
    paintwork: standard({ map: atlas.texture, transparent: true, opacity: 0.82, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    net: standard({ map: netMap, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }),
    /** Cloth the wind moves: hung by its top edge, stretched between two edges, or flown from a staff. */
    clothTop: standard({ side: THREE.DoubleSide, roughness: 0.95, envMapIntensity: 0.3 }),
    clothSides: standard({ side: THREE.DoubleSide, roughness: 0.95, envMapIntensity: 0.3 }),
    netCloth: standard({ map: netMap, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 1 }),
    clothFlag: new THREE.MeshStandardMaterial({ color: 0x9a2f26, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }),
    /** A lit room seen through its window, and a lamp's own light. */
    lit: new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, toneMapped: false }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    /** The panes of every lit lantern: one material, so that they flicker together like lamps on one main. */
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.3, 1.45, 0.6), toneMapped: false }),
    /** The far bank and the skyline: colour from the vertices alone. */
    far: standard({ roughness: 0.95, envMapIntensity: 0.4 }),
  };
  life.cloth(M.clothTop, { pin: "top", amplitude: 0.05, lean: 0.35, frequency: 1.3 }).snap([-11.7, 1.7, 5.5]);
  life.cloth(M.clothSides, { pin: "sides", amplitude: 0.035, lean: 0 }).snap([8.5, 2.5, 0.3]);
  life.cloth(M.clothFlag, { pin: "left", amplitude: 0.05, frequency: 1.5 });
  life.cloth(M.netCloth, { pin: { height: 1.78, reach: 1.5 }, amplitude: 0.035, lean: 0.25 });
  const paint = (material: THREE.Material, colour: THREE.ColorRepresentation = 0xffffff, gain = 1): Paint => ({ material, colour: new THREE.Color(colour).multiplyScalar(gain) });
  const WHITE = new THREE.Color(1, 1, 1);
  /** What a textured material looks like from across the canal, where only the vertex colour is drawn. */
  const FAR_TONE = new Map<THREE.Material, THREE.Color>([
    [M.brick, new THREE.Color(0x8a5846)], [M.plaster, new THREE.Color(0xc9c1b0)], [M.wood, new THREE.Color(0x7c6852)],
    [M.stone, new THREE.Color(0xa29c90)], [M.tile, new THREE.Color(0xa89e94)], [M.lit, new THREE.Color(2.4, 1.3, 0.55)],
  ]);

  const STONE = paint(M.stone, 0xcfc8ba), STONE_PALE = paint(M.stone, 0xf2ecde), STONE_DARK = paint(M.stone, 0x9a958a);
  const IRON = paint(M.iron, 0x23262a), IRON_GREEN = paint(M.iron, 0x1d2b27), BRASS = paint(M.iron, 0xb89246);
  const TAR = paint(M.wood, 0x4a4038), OAK = paint(M.wood, 0xc9b79c), TIMBER = paint(M.wood, 0x8f7a64);
  const ROPE = paint(M.matte, 0x9a8460), CURTAIN = paint(M.matte, 0xd9d4c6);
  const POT = paint(M.tile, 0xd6875a), BRICK_STACK = paint(M.brick, 0xd9c6ba);
  const GLASS = [0x0f1518, 0x151c21, 0x0b1013, 0x1a2126, 0x121a1c].map((colour) => paint(M.glass, colour));
  const LIT = paint(M.lit, 0xffffff, 1.5);

  // ---- Batching ------------------------------------------------------------------------
  // Every static part is baked into one mesh per material (and per shadow / hit / mirror class). A rig is a
  // group that moves (a boat on its ropes): parts put through its adder are merged into meshes of that group.
  type Batch = { material: THREE.Material; shadow: boolean; hit: boolean; mirror: boolean; parts: THREE.BufferGeometry[] };
  type Sink = Map<string, Batch>;
  const world: Sink = new Map();
  const rigs = new Map<THREE.Object3D, Sink>();
  /** A part ready to merge: position, normal, uv, colour and an index, already in place. */
  const bake = (geometry: THREE.BufferGeometry, colour: THREE.Color, matrix: THREE.Matrix4) => {
    const part = new THREE.BufferGeometry(), count = geometry.attributes.position.count, own = geometry.attributes.color;
    part.setAttribute("position", geometry.attributes.position.clone());
    part.setAttribute("normal", geometry.attributes.normal.clone());
    part.setAttribute("uv", geometry.attributes.uv ? geometry.attributes.uv.clone() : new THREE.Float32BufferAttribute(count * 2, 2));
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colours[i * 3] = colour.r * (own ? own.getX(i) : 1);
      colours[i * 3 + 1] = colour.g * (own ? own.getY(i) : 1);
      colours[i * 3 + 2] = colour.b * (own ? own.getZ(i) : 1);
    }
    part.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    part.setIndex(geometry.index ? geometry.index.clone() : Array.from({ length: count }, (_, i) => i));
    part.applyMatrix4(matrix);
    return part;
  };
  const split = (given: Paint | THREE.Material): Paint => ("colour" in given ? given : { material: given, colour: WHITE });
  const putInto = (sink: Sink, geometry: THREE.BufferGeometry, given: Paint | THREE.Material, matrix: THREE.Matrix4, opt: Opt) => {
    if (opt.fine && !high) return;
    const { material, colour } = split(given), shadow = opt.shadow ?? false, hit = opt.hit ?? false, mirror = opt.mirror ?? false;
    const key = `${material.uuid}|${+shadow}${+hit}${+mirror}`;
    let batch = sink.get(key);
    if (!batch) sink.set(key, batch = { material, shadow, hit, mirror, parts: [] });
    batch.parts.push(bake(geometry, colour, matrix));
  };
  /** Adds parts in the local space of `matrix`. */
  const frame = (matrix: THREE.Matrix4, base: Opt = {}, sink: Sink = world): Add =>
    (geometry, given, x = 0, y = 0, z = 0, rotation, scale, opt) => putInto(sink, geometry, given, matrix.clone().multiply(mat4(x, y, z, rotation, scale)), { ...base, ...opt });
  const put = frame(new THREE.Matrix4());
  const rig = (group: THREE.Object3D, base: Opt = {}): Add => {
    const sink: Sink = new Map();
    rigs.set(group, sink);
    return frame(new THREE.Matrix4(), base, sink);
  };
  // The far bank, the skyline and whatever else the canal mirrors. Parts are kept in the order they are added,
  // farthest first: the reflection is drawn flat, with nothing but that order to say what hides what.
  const far = { direct: [] as THREE.BufferGeometry[], mirrored: [] as THREE.BufferGeometry[], near: [] as THREE.BufferGeometry[], lamps: [] as THREE.BufferGeometry[] };
  const farFrame = (matrix: THREE.Matrix4, mirrored: boolean): Add => (geometry, given, x = 0, y = 0, z = 0, rotation, scale) => {
    const { material, colour } = split(given), tone = FAR_TONE.get(material), placed = matrix.clone().multiply(mat4(x, y, z, rotation, scale));
    const part = bake(geometry, tone ? colour.clone().multiply(tone) : colour, placed);
    far.direct.push(part);
    if (mirrored) far.mirrored.push(part);
    // A lit window is drawn again, unlit, a finger in front of itself: the wall's own light would grey it.
    if (material === M.lit) far.lamps.push(bake(geometry, new THREE.Color(1.5, 0.82, 0.36), placed.multiply(mat4(0, 0, 0.012))));
  };
  /** A copy for the canal to mirror of something that is drawn with its own textures. */
  const reflectFrame = (matrix: THREE.Matrix4): Add => (geometry, given, x = 0, y = 0, z = 0, rotation, scale) => {
    const { material, colour } = split(given), tone = FAR_TONE.get(material);
    far.near.push(bake(geometry, tone ? colour.clone().multiply(tone) : colour, matrix.clone().multiply(mat4(x, y, z, rotation, scale))));
  };
  const both = (...adders: Add[]): Add => (...args) => adders.forEach((add) => add(...args));
  const flush = () => {
    const emit = (sink: Sink, parent: THREE.Object3D, moving: boolean) => {
      for (const batch of sink.values()) {
        const merged = mergeGeometries(batch.parts);
        batch.parts.forEach((part) => part.dispose());
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, batch.material);
        // Nothing that moves casts a sun shadow that moves with it: the sun's map is drawn once.
        mesh.castShadow = batch.shadow;
        mesh.receiveShadow = true;
        if (moving) mesh.userData.walkThrough = true;
        parent.add(mesh);
        if (batch.hit) kit.shootable.push(mesh);
        if (!batch.mirror) kit.mirrorHidden.push(mesh);
      }
      sink.clear();
    };
    emit(world, scene, false);
    for (const [group, sink] of rigs) emit(sink, group, true);
  };
  const remap = <T extends THREE.BufferGeometry>(geometry: T, key: string): T => {
    const [u0, v0, u1, v1] = atlas.rects[key], uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return geometry;
  };
  /** A flat plate carrying one entry of the sign sheet, facing +z. */
  const sign = (key: string, width: number) => remap(new THREE.PlaneGeometry(width, width / atlas.aspect[key]), key);

  // ---- Houses ----------------------------------------------------------------------------
  // One generator builds every front in the map: the terrace along the quay in full, the row across the canal
  // with less on it, the skyline as little more than walls, windows and roofs.
  const leaves = new Map<string, THREE.BufferGeometry>();
  const leaf = (w: number, h: number, louvred: boolean) => {
    const key = `${w.toFixed(2)}|${h.toFixed(2)}|${+louvred}`;
    let geometry = leaves.get(key);
    if (!geometry) leaves.set(key, geometry = shutterLeaf(w, h, louvred));
    return geometry;
  };
  /** How much is put on the houses a player can walk up to: all of it, or on a phone what reads from across the range. */
  const NEAR: 1 | 2 = high ? 2 : 1;
  const house = (add: Add, s: HouseSpec, detail: 0 | 1 | 2) => {
    const next = rng(s.seed), half = s.w / 2, base = s.base ?? 0, brick = s.wall.material === M.brick, band = s.band ?? STONE;
    const eaves = s.floors.reduce((sum, height) => sum + height, 0);
    const rise = s.gable === "eaves" ? 0 : s.rise ?? s.w * (s.gable === "point" ? 0.66 : s.gable === "step" ? 0.6 : 0.5);
    const kept = (x0: number, x1: number, y0: number, y1: number) => (s.keep ?? []).some(([a, b, c, d]) => x0 < b && x1 > a && y0 < d && y1 > c);
    const margin = 0.4, bay = (s.w - margin * 2) / s.bays, winW = s.winW ?? Math.min(1.12, bay * 0.56);
    const cols = s.cols ?? Array.from({ length: s.bays }, (_, i) => -half + margin + (i + 0.5) * bay);
    const holes: Hole[] = [];
    let level = 0;
    s.floors.forEach((height, floor) => {
      const doorBay = s.doorBay ?? cols.length - 1;
      if (floor === 0 && s.ground === "shop") {
        const others = cols.filter((_, i) => i !== doorBay), x0 = Math.min(...others) - bay / 2 + 0.3, x1 = Math.max(...others) + bay / 2 - 0.3;
        holes.push({ fill: "shop", x: (x0 + x1) / 2, y: 0.62, w: x1 - x0, h: Math.min(2.15, height - 1.5), floor });
        holes.push({ fill: "door", x: cols[doorBay], y: 0.16, w: 1, h: Math.min(2.6, height - 0.95), floor });
      } else if (floor > 0 || s.ground !== "blank") {
        cols.forEach((x, i) => {
          if (floor === 0 && i === doorBay) holes.push({ fill: "door", x, y: 0.16, w: 1.05, h: Math.min(2.7, height - 0.7), floor });
          else if (floor > 0 && i === s.hatchBay) holes.push({ fill: "hatch", x, y: level + 0.28, w: Math.min(1.6, bay * 0.62), h: height - 0.8, floor });
          else {
            const sill = floor === 0 ? 0.95 : 0.72;
            holes.push({ fill: "window", x, y: level + sill, w: winW, h: Math.min(2.1, height - sill - 0.5), arch: s.arch, floor });
          }
        });
      }
      level += height;
    });
    if (s.attic && s.attic !== "none" && rise > 2.3) {
      const hatch = s.attic === "hatch";
      holes.push({ fill: hatch ? "hatch" : "window", x: 0, y: eaves + 0.5, w: hatch ? 0.95 : 0.72, h: Math.min(1.5, rise * 0.4), arch: hatch ? 0 : 0.3, floor: s.floors.length });
    }
    holes.push(...(s.holes ?? []));
    const open = holes.filter((hole) => !kept(hole.x - hole.w / 2 - 0.12, hole.x + hole.w / 2 + 0.12, hole.y - 0.12, hole.y + hole.h + 0.12));
    const outline = gableOutline(s.gable, s.w, base, eaves, rise);
    add(facade(outline, open, WALL_T, brick ? 1.7 : 2.6), s.wall, 0, 0, 0, undefined, undefined, { shadow: true, hit: true, mirror: true });

    for (const hole of open) {
      const { x, y, w, h } = hole;
      if (hole.fill === "window") {
        const curve = Math.min(hole.arch ?? 0, w / 2), square = h - curve, f = 0.055, lit = next() < (s.lit ?? 0);
        add(lit ? remap(new THREE.PlaneGeometry(w, h), "window") : new THREE.PlaneGeometry(w, h), lit ? LIT : GLASS[Math.floor(next() * GLASS.length)], x, y + h / 2, -0.15);
        for (const side of [-1, 1]) add(bar(f, h, 0.07), s.trim, x + side * (w / 2 - f / 2), y + h / 2, -0.115);
        add(bar(w, f, 0.07), s.trim, x, y + f / 2, -0.115);
        add(bar(w, f, 0.07), s.trim, x, y + square - f / 2, -0.115);
        add(bar(w, 0.045, 0.06), s.trim, x, y + square * 0.5, -0.11);
        if (detail > 0) add(bar(0.03, square, 0.05), s.trim, x, y + square / 2, -0.105);
        if (detail > 1) for (const v of [0.25, 0.75]) add(bar(w - f * 2, 0.024, 0.045), s.trim, x, y + square * v, -0.105);
        if (detail > 1 && !lit && next() < 0.55) add(new THREE.PlaneGeometry(w - 0.12, square * 0.42), CURTAIN, x, y + square * 0.76, -0.146);
        if (kept(x - w - 0.1, x + w + 0.1, y - 0.14, y + h + 0.32)) continue;
        add(box(w + 0.18, 0.075, 0.2, 1.2), STONE_PALE, x, y - 0.037, -0.03);
        if (brick) add(curve > 0.01 ? box(0.16, 0.24, 0.05, 1.2) : box(w + 0.3, 0.2, 0.05, 1.2), STONE_PALE, x, y + h + 0.1, 0);
        else {
          for (const side of [-1, 1]) add(bar(0.1, h + 0.08, 0.05), band, x + side * (w / 2 + 0.05), y + h / 2 + 0.04, 0);
          add(bar(w + 0.32, 0.13, 0.07), band, x, y + h + 0.065, 0);
        }
        if (s.shutter && detail > 0 && hole.floor < 3 && next() < 0.85) {
          const shut = next() < 0.1;
          for (const side of [-1, 1]) add(leaf(w / 2 - 0.008, h, detail > 1), s.shutter, shut ? x + side * w / 4 : x + side * (w * 0.75 + 0.02), y + h / 2, shut ? -0.06 : 0.03);
        }
      } else if (hole.fill === "door") {
        const tall = Math.min(h, 2.12), fan = h - tall;
        add(box(w, tall, 0.05, 1.4), s.door, x, y + tall / 2, -0.19);
        if (detail > 0) for (const [px, py, pw, ph] of [[-0.23, 0.78, 0.34, 0.3], [0.23, 0.78, 0.34, 0.3], [-0.23, 0.43, 0.34, 0.3], [0.23, 0.43, 0.34, 0.3], [0, 0.13, 0.8, 0.14]]) add(bar(w * pw, tall * ph, 0.022), s.door, x + px * w, y + tall * py, -0.16);
        for (const side of [-1, 1]) add(bar(0.07, h, 0.1), s.trim, x + side * (w / 2 - 0.035), y + h / 2, -0.14);
        add(bar(w, 0.07, 0.1), s.trim, x, y + h - 0.035, -0.14);
        if (fan > 0.25) {
          add(bar(w, 0.06, 0.1), s.trim, x, y + tall + 0.03, -0.14);
          add(new THREE.PlaneGeometry(w, fan), next() < (s.lit ?? 0) * 2 ? paint(M.glow, 0xffb060, 1.2) : GLASS[1], x, y + tall + fan / 2, -0.17);
          for (const side of [-1, 1]) add(bar(0.025, fan, 0.04), s.trim, x + side * w * 0.17, y + tall + fan / 2, -0.15);
        }
        add(new THREE.SphereGeometry(0.034, 8, 6), BRASS, x + w * 0.34, y + 1.02, -0.15);
        add(box(w + 0.36, y, 0.42, 1.2), STONE, x, y / 2, 0.19);
      } else if (hole.fill === "shop") {
        const n = Math.max(2, Math.round(w / 1.05));
        add(new THREE.PlaneGeometry(w, h), GLASS[3], x, y + h / 2, -0.16);
        for (const at of [0.035, h - 0.035]) add(bar(w, 0.07, 0.12), s.trim, x, y + at, -0.1);
        add(bar(w, 0.05, 0.1), s.trim, x, y + h - 0.46, -0.1);
        for (let i = 0; i <= n; i += 1) add(bar(i === 0 || i === n ? 0.07 : 0.045, h, 0.11), s.trim, x - w / 2 + (i / n) * w + (i === 0 ? 0.035 : i === n ? -0.035 : 0), y + h / 2, -0.1);
        add(box(w + 0.14, y - 0.04, 0.06, 1.3), s.door, x, (y - 0.04) / 2 + 0.02, 0.03);
        for (let i = 0; i < n; i += 1) add(bar(w / n - 0.16, y - 0.24, 0.02), s.door, x - w / 2 + (i + 0.5) * (w / n), y / 2, 0.065);
        for (const side of [-1, 1]) add(box(0.17, y + h + 0.2, 0.08, 1.3), s.door, x + side * (w / 2 + 0.11), (y + h + 0.2) / 2, 0.04);
        add(box(w + 0.56, 0.44, 0.1, 1.3), s.door, x, y + h + 0.38, 0.05);
        add(bar(w + 0.66, 0.06, 0.18), s.trim, x, y + h + 0.63, 0.09);
      } else if (hole.fill === "hatch") {
        add(box(w, h, 0.05, 1.3), s.door, x, y + h / 2, -0.1);
        add(bar(0.024, h, 0.02), IRON, x, y + h / 2, -0.068);
        if (detail > 0) for (const v of [0.18, 0.82]) for (const side of [-1, 1]) add(bar(w * 0.38, 0.05, 0.016), IRON, x + side * w * 0.28, y + h * v, -0.068);
        add(box(w + 0.2, 0.09, 0.26, 1.2), STONE_PALE, x, y - 0.045, -0.03);
      }
    }

    // Plinth in runs between the doorways, string courses at the floors, and whatever tops the wall.
    if (detail > 0 && base > -0.01) {
      const gaps = open.filter((hole) => hole.y < 0.7).map((hole) => [hole.x - hole.w / 2 - 0.2, hole.x + hole.w / 2 + 0.2]).sort((a, b) => a[0] - b[0]);
      let from = -half;
      for (const [a, b] of [...gaps, [half, half]]) {
        if (a - from > 0.08) add(box(a - from, 0.52, 0.06, 1.6), STONE_DARK, (a + from) / 2, 0.26, 0.03);
        from = Math.max(from, b);
      }
    }
    let y = 0;
    s.floors.forEach((height, floor) => {
      y += height;
      const last = floor === s.floors.length - 1;
      if ((detail === 0 && !last) || kept(-half, half, y - 0.14, y + 0.14)) return;
      if (last && s.gable === "eaves") {
        add(box(s.w + 0.08, 0.2, 0.36, 1.6), band, 0, y - 0.1, 0.16, undefined, undefined, { shadow: true });
        add(box(s.w, 0.12, 0.2, 1.6), band, 0, y - 0.26, 0.08);
      } else add(box(s.w, last ? 0.14 : 0.09, 0.07, 1.6), band, 0, y, 0.02);
    });
    if (s.gable !== "eaves") {
      for (let i = 2; i < outline.length - 1; i += 1) {
        const [x0, y0] = outline[i], [x1, y1] = outline[i + 1], dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
        if (Math.abs(dx) < 0.03 || length < 0.05) continue;
        add(box(length + 0.08, 0.07, WALL_T + 0.1, 1.2), STONE_PALE, (x0 + x1) / 2, (y0 + y1) / 2 + 0.03, -WALL_T / 2, [0, 0, Math.atan2(dy, dx)]);
      }
      if (detail > 0 && s.gable !== "point") add(lathe([[0, 0], [0.11, 0], [0.13, 0.06], [0.06, 0.12], [0.1, 0.24], [0.13, 0.36], [0.08, 0.48], [0, 0.52]], 10), STONE_PALE, 0, eaves + rise + 0.03, -WALL_T / 2);
      if (detail > 0 && s.gable === "point") add(cyl(0.02, 0.7, "y", 6, 0.006), IRON, 0, eaves + rise + 0.3, -WALL_T / 2);
    }
    if (s.hoist) {
      const at = eaves + rise * 0.66;
      add(box(0.15, 0.19, 1.5, 1.2), TAR, 0, at, 0.55, undefined, undefined, { shadow: true });
      add(cyl(0.1, 0.05, "x", 12), IRON, 0, at - 0.19, 1.15);
      add(bar(0.03, 0.2, 0.03), IRON, 0, at - 0.1, 1.15);
    }

    // The house behind its front: a roof, a body to carry it and throw its shadow, and chimneys.
    let ridge = eaves + rise;
    const stacks: V3[] = [];
    if (s.shell !== false) {
      const side: Paint = { material: s.wall.material, colour: s.wall.colour.clone().multiplyScalar(0.84) };
      const roofH = s.gable === "eaves" ? s.roofRise ?? s.d * 0.4 : Math.min(rise - 0.25, half * 1.3);
      ridge = eaves + roofH;
      const [trimL, trimR] = s.clip ?? [0, 0], long = s.w - trimL - trimR, mid = (trimL - trimR) / 2;
      if (s.gable === "eaves") add(ridgePrism(s.d + 0.36, roofH, long, "x"), s.roof, mid, eaves, -s.d / 2 + 0.18, undefined, undefined, { shadow: true });
      else add(ridgePrism(s.w - 0.1, roofH, s.d - WALL_T - 0.02, "z"), s.roof, 0, eaves, -(s.d + WALL_T + 0.02) / 2, undefined, undefined, { shadow: true });
      const foot = Math.min(base, s.foot ?? base);
      const recess = s.recess ?? 0;
      add(openBox(long - 0.06, eaves - foot, s.d - 0.4 - recess), side, mid, (eaves + foot) / 2, -WALL_T - recess - (s.d - 0.4 - recess) / 2, undefined, undefined, { shadow: true });
      for (let i = 0; i < (s.chimneys ?? 0); i += 1) {
        const hand = i % 2 ? -1 : 1, tall = 1.2 + next() * 0.9;
        const cx = s.gable === "eaves" ? hand * (half - 0.5 - next() * 0.3) - (i > 1 ? hand * s.w * 0.3 : 0) : hand * (half - 0.36);
        const cz = s.gable === "eaves" ? -s.d / 2 + 0.18 : -s.d * (0.22 + 0.56 * next());
        const top = (s.gable === "eaves" ? ridge : eaves + roofH * 0.5) + tall;
        add(box(0.52, top - eaves + 0.3, 0.78, 1.5), brick ? side : BRICK_STACK, cx, (top + eaves - 0.3) / 2, cz, undefined, undefined, { shadow: true });
        add(box(0.64, 0.09, 0.9, 1.2), STONE, cx, top + 0.045, cz);
        for (const pz of [-0.2, 0.2]) add(cyl(0.085, 0.36, "y", 8, 0.07), POT, cx, top + 0.27, cz + pz);
        stacks.push([cx, top + 0.5, cz]);
      }
    }
    return { eaves, peak: eaves + rise, ridge, holes: open, stacks };
  };

  // ---- Ground ------------------------------------------------------------------------
  // The slab is the quay and nothing else: it stops at the coping, so that the canal lies below and beyond it
  // and the mirror pass never sees anything under the paving.
  const FLOOR = { x0: -10.06, x1: 10.5, z0: -34, z1: 11 };
  const ground = new THREE.MeshStandardMaterial({
    ...photoSet("/textures/cobblestone_floor_04-2k", (FLOOR.x1 - FLOOR.x0) / 3.2, (FLOOR.z1 - FLOOR.z0) / 3.2, false),
    color: 0xaaa69c, normalScale: new THREE.Vector2(1.25, 1.25), roughness: 1, metalness: 0, envMapIntensity: 0.5,
  });
  const reflection = kit.floor(ground, { width: FLOOR.x1 - FLOOR.x0, depth: FLOOR.z1 - FLOOR.z0, z: (FLOOR.z0 + FLOOR.z1) / 2 }, {
    lane: new THREE.Color(0.8, 0.78, 0.7),
    edge: new THREE.Color(0.78, 0.6, 0.24),
    markings: 0.55,
    wet: 0.1,
  });
  kit.mirrorHidden[kit.mirrorHidden.length - 1].position.x = (FLOOR.x0 + FLOOR.x1) / 2;

  /** Stone and timber standing in the canal: darker toward the water, green at the waterline. Shaded by height, so place the geometry first. */
  const damp = <T extends THREE.BufferGeometry>(geometry: T) => shadeY(geometry, (y) => {
    const dry = THREE.MathUtils.smoothstep(y, -0.5, 0.6), weed = 1 - THREE.MathUtils.smoothstep(y, -1.05, -0.5);
    return [0.92 - 0.34 * (1 - dry) - 0.28 * weed, 0.92 - 0.28 * (1 - dry) - 0.18 * weed, 0.9 - 0.34 * (1 - dry) - 0.34 * weed];
  });

  // ---- The quay edge ------------------------------------------------------------------
  {
    // Coping stones, each a little off its neighbours, and the wall below them greening toward the water.
    for (let z = WARE.z1 + 0.56; z < BACK_Z; z += 1.12) {
      const tone = 0.9 + random() * 0.16;
      put(rbox(0.56, 0.24, 1.1, 0.035, 1.4), paint(M.stone, 0xd2ccbf, tone), -9.86, -0.045 + random() * 0.008, z, [0, (random() - 0.5) * 0.012, 0], undefined, { shadow: true, hit: true });
    }
    const wall = damp(projectUv(new THREE.BoxGeometry(0.5, 2.5, BACK_Z + 0.4 - WARE.z1, 1, 8, 1), 2.4).translate(QUAY_X + 0.25, -1.15, (BACK_Z + 0.4 + WARE.z1) / 2));
    put(wall, STONE, 0, 0, 0, undefined, undefined, { shadow: true });
  }

  // Bollards, mooring rings, a post-and-chain rail and two lamps, still lit, along the open edge.
  const RAIL_X = -9.7, COPING = 0.075;
  const LAMPS: V3[] = [[RAIL_X, COPING + 4.25, 3.5], [RAIL_X, COPING + 4.25, -7.7]];
  /** A four-sided lantern standing on y = 0: lit panes in an iron frame under a cap. */
  const lantern = (add: Add, x: number, y: number, z: number, size = 1) => {
    const low = 0.11 * size, wide = 0.18 * size, tall = 0.46 * size;
    add(new THREE.CylinderGeometry(wide * Math.SQRT2, low * Math.SQRT2, tall, 4, 1, true).rotateY(Math.PI / 4), M.lamp, x, y + tall / 2, z);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) add(rod([sx * low, 0, sz * low], [sx * wide, tall, sz * wide], 0.012 * size, 4), IRON, x, y, z);
    add(bar(low * 2 + 0.03, 0.025, low * 2 + 0.03), IRON, x, y, z);
    add(bar(wide * 2 + 0.03, 0.025, wide * 2 + 0.03), IRON, x, y + tall, z);
    add(new THREE.ConeGeometry((wide + 0.06) * Math.SQRT2, 0.2 * size, 4).rotateY(Math.PI / 4), IRON, x, y + tall + 0.11 * size, z);
    add(lathe([[0, 0], [0.035, 0.02], [0.02, 0.06], [0.03, 0.1], [0, 0.16]], 6), IRON, x, y + tall + 0.2 * size, z, undefined, size);
  };
  {
    const edge = frame(new THREE.Matrix4(), { shadow: true });
    const bollard = lathe([[0, 0], [0.17, 0], [0.17, 0.05], [0.115, 0.1], [0.1, 0.36], [0.15, 0.43], [0.165, 0.5], [0.13, 0.57], [0.05, 0.61], [0, 0.61]], 14);
    for (const z of [8.5, 5.4, -2.6]) edge(bollard, IRON, -9.93, COPING, z, undefined, undefined, { hit: true });
    const ring = new THREE.TorusGeometry(0.1, 0.016, 6, 14).rotateY(Math.PI / 2), eye = cyl(0.02, 0.09, "x", 6);
    for (let z = -7.4; z < 9.4; z += 2.8) { put(ring, IRON, QUAY_X - 0.03, -0.66, z, [0.12 * Math.sin(z * 3), 0, 0]); put(eye, IRON, QUAY_X - 0.02, -0.56, z); }

    // The rail: iron posts with a chain slung between them, open at the bridge foot and at the head of the steps.
    const post = lathe([[0, 0], [0.07, 0], [0.07, 0.035], [0.043, 0.07], [0.032, 0.13], [0.028, 0.8], [0.048, 0.83], [0.03, 0.86], [0.052, 0.9], [0.058, 0.94], [0.04, 0.985], [0, 1]], 8);
    const runs: Array<[number, number, boolean, boolean]> = [[-7.7, BRIDGE_Z - 1.4, false, true], [BRIDGE_Z + 1.4, 0.2, true, true], [1.6, 3.5, true, false], [3.5, BACK_Z - 0.3, false, true]];
    for (const [from, to, first, last] of runs) {
      const spans = Math.max(1, Math.round((to - from) / 2.2)), step = (to - from) / spans;
      for (let i = 0; i <= spans; i += 1) {
        const z = from + i * step;
        if ((i > 0 || first) && (i < spans || last)) edge(post, IRON, RAIL_X, COPING, z);
        if (i < spans) put(hang([RAIL_X, COPING + 0.9, z], [RAIL_X, COPING + 0.9, z + step], 0.13, 0.013, 10, 4), IRON);
      }
    }

    // Two cast-iron street lamps. Each carries a board for the range's alarm lamp, which hangs at 3.62 m.
    const column = lathe([[0, 0], [0.17, 0], [0.17, 0.06], [0.13, 0.1], [0.12, 0.42], [0.14, 0.46], [0.09, 0.52], [0.07, 0.6], [0.06, 1.1], [0.075, 1.14], [0.06, 1.18], [0.05, 3], [0.045, 3.86], [0.07, 3.9], [0.07, 3.96], [0, 3.96]], 10);
    for (const [x, , z] of LAMPS) {
      edge(column, IRON_GREEN, x, COPING, z, undefined, undefined, { hit: true });
      edge(rod([x, COPING + 3.3, z - 0.3], [x, COPING + 3.3, z + 0.3], 0.016, 5), IRON_GREEN);
      lantern(put, x, COPING + 4, z);
      edge(box(0.07, 0.34, 0.62, 1), TAR, -9.615, 3.62, z);
      for (const side of [-1, 1]) put(bar(0.14, 0.03, 0.02), IRON, -9.68, 3.62 + side * 0.11, z);
    }

    // Steps down to the water, built against the wall, and a landing a hand above it.
    const STEP = 0.28, wet = frame(new THREE.Matrix4(), { shadow: true });
    for (let i = 0; i < 8; i += 1) {
      const top = COPING - 0.2 * (i + 1);
      wet(damp(box(1, top + 2.4, STEP, 1.6).translate(QUAY_X - 0.5, (top - 2.4) / 2, 1.5 - (i + 0.5) * STEP)), STONE);
    }
    wet(damp(box(1, 0.875, 2.2, 1.6).translate(QUAY_X - 0.5, -1.9625, -1.84)), STONE);
    put(rod([QUAY_X - 0.07, COPING + 0.72, 1.45], [QUAY_X - 0.07, -0.78, -0.8], 0.018, 5), IRON);
    for (const t of [0.04, 0.5, 0.96]) put(cyl(0.012, 0.07, "x", 5), IRON, QUAY_X - 0.035, COPING + 0.72 - 1.575 * t, 1.45 - 2.25 * t);
    put(sign("stepsName", 0.62), M.sign, RAIL_X + 0.03, COPING + 0.52, 2.02, [0, Math.PI / 2, 0]);
    for (const z of [1.78, 2.26]) put(bar(0.02, 0.6, 0.02), IRON, RAIL_X + 0.015, COPING + 0.3, z);
  }
  // Timber piles: what the boats lie to, and where the gulls sit.
  const PILES: V3[] = [[-13.35, 0.42, 9.05], [-13.5, 0.3, 1.75], [-11.3, -0.5, -3.1], [-13.1, 0.36, -3.4]];
  for (const [x, top, z] of PILES) {
    put(damp(cyl(0.13, top + 2.4, "y", 9, 0.11).translate(x, (top - 2.4) / 2, z)), TIMBER, 0, 0, 0, [0, 0, 0], undefined, { shadow: true });
    put(cyl(0.118, 0.05, "y", 9), IRON, x, top - 0.12, z);
  }

  // ---- The footbridge ---------------------------------------------------------------------
  // Stone, stepped, one arch: it springs from the quay and lands on the far bank. Built in its own frame,
  // x running from the quay across the water.
  const SPAN = QUAY_X - FAR_QUAY, BRIDGE = { half: 1.15, top: 2.4, run: 5.12, parapet: 0.95, wall: 0.26 };
  const BRIDGE_LAMP = new THREE.Vector3(QUAY_X - SPAN / 2, BRIDGE.top + BRIDGE.parapet + 2.18, BRIDGE_Z);
  {
    const { half, top, run, parapet, wall } = BRIDGE, STEPS = 16, RISE = top / STEPS, GOING = run / STEPS;
    const A = SPAN / 2 - 0.98, B = 3.6, SPRING = -1.7, FOOT = -2.4;
    const at = mat4(QUAY_X, 0, BRIDGE_Z, [0, Math.PI, 0]);
    const stone = both(frame(at, { shadow: true, hit: true }), reflectFrame(at)), dress = frame(at), iron = frame(at);
    const elevation = (over: Array<[number, number]>) => {
      const shape = new THREE.Shape();
      shape.moveTo(0, FOOT); shape.lineTo(SPAN / 2 - A, FOOT); shape.lineTo(SPAN / 2 - A, SPRING);
      shape.absellipse(SPAN / 2, SPRING, A, B, Math.PI, 0, true);
      shape.lineTo(SPAN / 2 + A, FOOT); shape.lineTo(SPAN, FOOT);
      for (const [x, y] of over) shape.lineTo(x, y);
      shape.closePath();
      return shape;
    };
    const stepped: Array<[number, number]> = [];
    for (let i = 1; i <= STEPS; i += 1) stepped.push([SPAN - (i - 1) * GOING, i * RISE], [SPAN - i * GOING, i * RISE]);
    for (let i = STEPS; i >= 1; i -= 1) stepped.push([i * GOING, i * RISE], [(i - 1) * GOING, i * RISE]);
    const inner = half - wall;
    stone(damp(projectUv(new THREE.ExtrudeGeometry(elevation(stepped), { depth: inner * 2, bevelEnabled: false, curveSegments: 18 }), 2.2)), STONE, 0, 0, -inner);
    const side = damp(projectUv(new THREE.ExtrudeGeometry(elevation([[SPAN, parapet], [SPAN - run, top + parapet], [run, top + parapet], [0, parapet]]), { depth: wall, bevelEnabled: false, curveSegments: 18 }), 2.2));
    stone(side, STONE, 0, 0, inner);
    stone(side, STONE, 0, 0, -half);
    const slope = Math.hypot(run, top), pitch = Math.atan2(top, run);
    for (const hand of [-1, 1]) {
      const z = hand * (half - wall / 2), out = hand * (half + 0.02);
      // Coping on the parapet, piers at the ends and where the stairs meet the landing.
      dress(rbox(slope + 0.04, 0.09, wall + 0.1, 0.02, 1.4), STONE_PALE, run / 2, parapet + top / 2 + 0.04, z, [0, 0, pitch], undefined, { shadow: true });
      dress(rbox(slope + 0.04, 0.09, wall + 0.1, 0.02, 1.4), STONE_PALE, SPAN - run / 2, parapet + top / 2 + 0.04, z, [0, 0, -pitch], undefined, { shadow: true });
      dress(rbox(SPAN - run * 2 + 0.1, 0.09, wall + 0.1, 0.02, 1.4), STONE_PALE, SPAN / 2, top + parapet + 0.045, z, undefined, undefined, { shadow: true });
      for (const [x, from, to] of [[0.21, 0, parapet + 0.32], [SPAN - 0.21, 0, parapet + 0.32], [run, top - 0.4, top + parapet + 0.24], [SPAN - run, top - 0.4, top + parapet + 0.24]]) {
        dress(box(0.42, to - from, 0.42, 1.4), STONE, x, (from + to) / 2, z, undefined, undefined, { shadow: true });
        dress(rbox(0.5, 0.1, 0.5, 0.03, 1.2), STONE_PALE, x, to + 0.05, z);
        dress(new THREE.SphereGeometry(0.13, 10, 8), STONE_PALE, x, to + 0.2, z);
      }
      // The ring of the arch, a keystone, and a band under the parapet.
      const N = 25;
      for (let i = 0; i < N; i += 1) {
        const t = Math.PI * (i + 0.5) / N, cx = SPAN / 2 + A * Math.cos(t), cy = SPRING + B * Math.sin(t);
        const tx = -A * Math.sin(t), ty = B * Math.cos(t), length = Math.hypot(tx, ty), nx = ty / length, ny = -tx / length;
        const key = i === (N - 1) / 2, deep = key ? 0.62 : 0.44, arc = (Math.PI / N) * length;
        dress(box(arc * 0.97, deep, key ? 0.1 : 0.06, 0.9), key ? STONE_PALE : paint(M.stone, 0xd9d2c4, 0.9 + ((i * 7) % 5) * 0.035), cx + nx * deep * 0.5, cy + ny * deep * 0.5, out, [0, 0, Math.atan2(ty, tx)]);
      }
      dress(box(slope, 0.11, 0.05, 1.4), STONE_PALE, run / 2, top / 2 + 0.05, out, [0, 0, pitch]);
      dress(box(slope, 0.11, 0.05, 1.4), STONE_PALE, SPAN - run / 2, top / 2 + 0.05, out, [0, 0, -pitch]);
      dress(box(SPAN - run * 2, 0.11, 0.05, 1.4), STONE_PALE, SPAN / 2, top + 0.05, out);
    }
    // An iron overthrow at the crown, and its lantern.
    const rail = top + parapet + 0.09, reach = half - wall / 2;
    for (const hand of [-1, 1]) {
      iron(cyl(0.022, 1.3, "y", 6), IRON, SPAN / 2, rail + 0.65, hand * reach);
      iron(new THREE.TorusGeometry(0.16, 0.012, 5, 12, Math.PI * 1.5).rotateY(Math.PI / 2), IRON, SPAN / 2, rail + 1.1, hand * (reach - 0.17), [hand > 0 ? 0 : Math.PI, 0, 0]);
    }
    iron(new THREE.TorusGeometry(reach, 0.022, 6, 22, Math.PI).rotateY(Math.PI / 2), IRON, SPAN / 2, rail + 1.3, 0);
    iron(cyl(0.01, 0.18, "y", 4), IRON, SPAN / 2, rail + 1.3 + reach - 0.1, 0);
    lantern(iron, SPAN / 2, rail + 1.3 + reach - 0.86, 0, 0.95);
    iron(sign("carts", 0.36), M.sign, -0.012, parapet * 0.72, -(half - wall / 2), [0, -Math.PI / 2, 0], undefined, { fine: true });
  }

  // A flagged pavement under the house fronts, broken where the furnace stands, and weeds where nobody walks.
  {
    const flags = (z0: number, z1: number) => put(rbox(0.94, 0.06, z1 - z0, 0.012, 3.6), paint(M.stone, 0xb9b3a6), WALL_X - 0.45, 0.028, (z0 + z1) / 2, undefined, undefined, { hit: true });
    flags(-9.75, BACK_Z); flags(-26.2, -13.45);
    const tufts: TreeItem[] = [];
    for (const [x, z, variant] of [[-9.36, -10.6, 2], [-9.38, -15.1, 0], [-9.35, -17.6, 2], [-9.4, -22.2, 1], [-9.36, -25.2, 2], [-9.3, -8.2, 0], [-9.32, 9.5, 2], [-6.6, 9.52, 1], [6.5, 9.5, 2], [-9.45, 4.6, 1], [-9.42, -1.2, 0], [-9.5, 7.2, 2]]) tufts.push({ at: [x, 0, z], variant, yaw: z * 1.7, scale: 0.8 + ((z * 7.3) % 1 + 1) % 1 * 0.5 });
    trees.place("weeds", high ? tufts : tufts.filter((_, i) => i % 2 === 0), { shadow: false, hit: false });
  }

  // ---- The terrace along the east side ---------------------------------------------------
  const eastAt = (zc: number) => mat4(WALL_X, 0, zc, [0, -Math.PI / 2, 0]);
  const terrace: Array<{ zc: number; spec: HouseSpec; built?: ReturnType<typeof house> }> = [
    { zc: 7, spec: { w: 5.4, d: 10, floors: [3.3, 2.9, 2.7], gable: "bell", rise: 3, wall: paint(M.plaster, 0xe6c88c), trim: paint(M.trim, 0xe9e4d8), door: paint(M.wood, 0x5d2a24), roof: paint(M.tile, 0xcf8358), shutter: paint(M.trim, 0x2c4a3a), bays: 2, ground: "door", doorBay: 0, attic: "window", chimneys: 1, lit: 0.2, seed: 11 } },
    { zc: 1.2, spec: { w: 6.2, d: 10, floors: [3.75, 3, 2.8], gable: "step", rise: 3.8, wall: paint(M.brick, 0xf2ddd0), trim: paint(M.trim, 0xe9e4d8), door: paint(M.trim, 0x243a33), roof: paint(M.tile, 0xb9704c), bays: 3, ground: "shop", doorBay: 2, attic: "hatch", hoist: true, chimneys: 1, lit: 0.12, seed: 12 } },
    { zc: -5.25, spec: { w: 6.7, d: 10, floors: [3.4, 3, 2.8, 2.6], gable: "neck", rise: 3.2, wall: paint(M.plaster, 0xd9dcd2), trim: paint(M.trim, 0xf0ece2), door: paint(M.wood, 0x2c4a57), roof: paint(M.tile, 0xc57a52), shutter: paint(M.trim, 0x6b2f28), bays: 3, ground: "door", doorBay: 1, attic: "window", chimneys: 2, lit: 0.12, seed: 13 } },
    {
      zc: -11.5,
      spec: {
        w: 5.8, d: 10, floors: [5.1, 2.9, 2.6], gable: "point", wall: paint(M.brick, 0xc9b4a8), trim: paint(M.trim, 0xd9d4c8), door: paint(M.wood, 0x3a332c), roof: paint(M.tile, 0x9a5c40),
        bays: 2, cols: [0.3, 1.85], winW: 0.95, arch: 0.25, ground: "blank", attic: "window", seed: 14, recess: 2.9,
        // The furnace stands in the smithy's archway.
        holes: [{ fill: "none", x: -0.1, y: 0.02, w: 4.3, h: 4.73, arch: 2.15, floor: 0 }],
      },
    },
    {
      zc: -20.2,
      spec: {
        w: 11.6, d: 10, floors: [4.2, 3.4], gable: "eaves", roofRise: 2.9, wall: paint(M.plaster, 0xe9dfc8), trim: paint(M.trim, 0xe9e4d8), door: paint(M.wood, 0x2c3a2f), roof: paint(M.tile, 0x6f7780),
        band: STONE_PALE, bays: 6, winW: 1.05, arch: 0.3, ground: "blank", chimneys: 2, lit: 0.1, seed: 15,
        keep: [[0.7, 5.7, 1.8, 3.4], [-5.4, -0.2, 1.2, 3.72]],
      },
    },
    { zc: -27.6, spec: { w: 3.2, d: 10, floors: [3.2, 2.8, 2.6], gable: "point", wall: paint(M.brick, 0xe6d0c0), trim: paint(M.trim, 0xe9e4d8), door: paint(M.wood, 0x1d2a3a), roof: paint(M.tile, 0xb9704c), bays: 2, ground: "door", doorBay: 0, attic: "window", chimneys: 1, seed: 16 } },
  ];
  for (const plot of terrace) plot.built = house(frame(eastAt(plot.zc)), plot.spec, NEAR);

  // ---- What the terrace wears ---------------------------------------------------------------
  /** World position of a point given in a house's own frame on the east side. */
  const east = (zc: number, x: number, y: number, z: number): V3 => [WALL_X - z, y, zc + x];
  /** A piece of washing or bunting: a rectangle hanging from its top edge in soft folds. */
  const washing = (w: number, h: number, seed: number) => {
    const geometry = new THREE.PlaneGeometry(w, h, 8, 6), at = geometry.attributes.position;
    for (let i = 0; i < at.count; i += 1) {
      const u = at.getX(i) / w + 0.5, v = 0.5 - at.getY(i) / h;
      at.setZ(i, (Math.sin(u * 9 + seed) * 0.04 + Math.sin(u * 19 + seed * 2.3) * 0.014) * (0.25 + v));
      at.setX(i, at.getX(i) * (1 - 0.07 * v));
    }
    geometry.computeVertexNormals();
    // Folds hold a little shade of their own, and the hem is damp.
    return shadeUv(geometry, (u, v) => { const tone = 0.84 + 0.16 * Math.cos(u * 9 + seed) * (0.3 + 0.7 * (1 - v)) - 0.1 * (1 - v) * (1 - v); return [tone, tone, tone]; });
  };
  /**
   * A board hung out from a wall on an iron bracket, where it swings and creaks. `at` is where the arm leaves
   * the wall, `yaw` turns the arm (0 points it along +x); the board hangs in the plane of the arm.
   */
  const hungSign = (key: string, at: V3, yaw: number, width: number, round = false) => {
    const tall = width / atlas.aspect[key], reach = width + 0.22, arm = frame(mat4(at[0], at[1], at[2], [0, yaw, 0]));
    arm(rod([0, 0, 0], [reach, 0, 0], 0.016, 5), IRON);
    arm(rod([0.02, -0.5, 0], [reach * 0.72, 0, 0], 0.012, 5), IRON);
    arm(new THREE.TorusGeometry(0.11, 0.01, 4, 12, Math.PI * 1.5), IRON, reach * 0.3, -0.13, 0, [0, 0, 2.2]);
    arm(lathe([[0, 0], [0.03, 0.02], [0.012, 0.06], [0, 0.1]], 6).rotateZ(-Math.PI / 2), IRON, reach, 0, 0);
    const board = new THREE.Group();
    board.position.set(at[0] + Math.cos(yaw) * (0.2 + width / 2), at[1] - 0.02, at[2] - Math.sin(yaw) * (0.2 + width / 2));
    board.rotation.y = yaw;
    scene.add(board);
    const add = rig(board);
    for (const side of [-1, 1]) add(new THREE.TorusGeometry(0.022, 0.005, 4, 8), IRON, side * width * 0.32, -0.03, 0);
    add(round ? new THREE.CylinderGeometry(width / 2 + 0.02, width / 2 + 0.02, 0.03, 20).rotateX(Math.PI / 2) : box(width + 0.05, tall + 0.05, 0.03, 0.9), IRON, 0, -0.06 - tall / 2, 0);
    for (const side of [-1, 1]) add(sign(key, width), M.sign, 0, -0.06 - tall / 2, side * 0.017, [0, side > 0 ? 0 : Math.PI, 0]);
    life.sway(board, { amplitude: 0.07, period: 2.3 + width, axis: "x", creak: "signCreak", damping: 0.06 });
    return board;
  };
  {
    const A = frame(eastAt(7)), B = frame(eastAt(1.2)), C = frame(eastAt(-5.25)), D = frame(eastAt(-11.5)), E = frame(eastAt(-20.2)), G = frame(eastAt(-27.6));

    // No. 11: a lamp on a bracket by the door, the name of the quay, and a handcart waiting outside.
    A(rod([0, 2.5, 0], [0, 2.9, 0.5], 0.014, 5), IRON);
    A(rod([0, 2.9, 0], [0, 2.9, 0.56], 0.016, 5), IRON);
    A(new THREE.TorusGeometry(0.1, 0.01, 4, 12, Math.PI * 1.4), IRON, 0, 2.78, 0.2, [0, Math.PI / 2, 0.4]);
    lantern(A, 0, 2.3, 0.5, 0.62);
    A(cyl(0.008, 0.12, "y", 4), IRON, 0, 2.84, 0.5);
    A(sign("quayName", 0.95), M.sign, 2.08, 2.85, 0.012);
    A(sign("no11", 0.15), M.sign, -0.45, 1.75, 0.012);
    A(sign("dues", 0.34), M.sign, 0.1, 1.5, 0.012);
    {
      // The cart: a flat bed on two spoked wheels, its shafts on the ground.
      const cart = frame(mat4(8.72, 0, 8.3, [0, 0.12, 0]), { shadow: true, hit: true }), wood = paint(M.wood, 0xb9a583), R = 0.44;
      cart(box(0.84, 0.045, 1.5, 0.9), wood, 0, R + 0.1, 0);
      for (const side of [-1, 1]) {
        cart(box(0.045, 0.2, 1.5, 0.9), wood, side * 0.42, R + 0.22, 0);
        cart(rod([side * 0.36, R + 0.08, 0.7], [side * 0.3, R + 0.1, 1.72], 0.026, 6), wood);
        cart(new THREE.TorusGeometry(R, 0.028, 6, 24).rotateY(Math.PI / 2), IRON, side * 0.5, R, -0.1);
        cart(cyl(0.06, 0.1, "x", 8), wood, side * 0.5, R, -0.1);
        for (let i = 0; i < 5; i += 1) cart(rod([0, -R, 0], [0, R, 0], 0.016, 4), wood, side * 0.5, R, -0.1, [(i / 5) * Math.PI, 0, 0]);
        cart(bar(0.04, R + 0.1, 0.04), wood, side * 0.34, (R + 0.1) / 2 - 0.02, 0.62, [0.12, 0, 0]);
      }
      cart(cyl(0.02, 1.0, "x", 6), IRON, 0, R, -0.1);
      cart(box(0.84, 0.3, 0.04, 0.9), wood, 0, R + 0.27, -0.75);
    }

    // No. 13, the provision shop: its name over the window and a striped awning out over the pavement.
    const AWNING = { x0: -2.7, x1: 0.9, top: 2.87, drop: 0.6, out: 1.5 }, STRIPES = 12;
    for (let i = 0; i < STRIPES; i += 1) {
      const strip = new THREE.PlaneGeometry(1, 1, 1, 8), at = strip.attributes.position, uv = strip.attributes.uv;
      for (let k = 0; k < at.count; k += 1) {
        const v = uv.getY(k), u = (i + uv.getX(k)) / STRIPES;
        at.setXYZ(k, AWNING.x0 + u * (AWNING.x1 - AWNING.x0), AWNING.top - (1 - v) * AWNING.drop - 0.05 * Math.sin(v * Math.PI), 0.02 + (1 - v) * AWNING.out);
        uv.setX(k, u);
      }
      strip.computeVertexNormals();
      const stripe = i % 2 ? 0xe9e0cc : 0x9a3a30, w = (AWNING.x1 - AWNING.x0) / STRIPES;
      B(strip, paint(M.clothSides, stripe), 0, 0, 0, undefined, undefined, { shadow: true });
      B(new THREE.PlaneGeometry(w, 0.2, 2, 2), paint(M.clothTop, stripe), AWNING.x0 + (i + 0.5) * w, AWNING.top - AWNING.drop - 0.1, AWNING.out + 0.02);
    }
    B(rod([AWNING.x0, AWNING.top - AWNING.drop, AWNING.out + 0.02], [AWNING.x1, AWNING.top - AWNING.drop, AWNING.out + 0.02], 0.016, 5), IRON);
    for (const x of [AWNING.x0 + 0.02, AWNING.x1 - 0.02]) B(rod([x, 2.02, 0.06], [x, AWNING.top - AWNING.drop, AWNING.out + 0.02], 0.014, 5), IRON);
    B(sign("shop", 2.95), M.sign, -0.9, 3.15, 0.105);
    B(sign("no13", 0.15), M.sign, 1.8, 2.98, 0.012);
    B(sign("eco", 0.27), M.sign, 0.96, 1.62, 0.012, [0, 0, 0.03]);
    B(sign("auction", 0.27), M.sign, 2.72, 1.5, 0.012, [0, 0, -0.04]);

    // No. 15, the bakery: its sign hung out over the door, bedding airing at a window.
    hungSign("bakery", east(-5.25, 1.02, 3.3, 0), Math.PI, 0.62, true);
    C(sign("no15", 0.15), M.sign, 0.78, 1.75, 0.012);
    C(washing(0.95, 1.15, 3), paint(M.clothTop, 0xcfc4b0), -1.97, 6.4 + 0.72 - 0.56, 0.1);
    C(box(1.0, 0.05, 0.16, 1), paint(M.clothTop, 0xcfc4b0), -1.97, 6.4 + 0.74, 0.02);

    // No. 17, the smith: the furnace stands in his archway and its flue goes up an outside stack.
    {
      const iron = frame(eastAt(-11.5)), built = frame(eastAt(-11.5), { shadow: true }), stack = paint(M.brick, 0xb9a59a), soot = paint(M.brick, 0x6a625c);
      const FX = -1.15, TOP = 14.35;
      built(projectUv(new THREE.CylinderGeometry(0.7 / Math.SQRT2, 1 / Math.SQRT2, 1, 4, 1).rotateY(Math.PI / 4), 1.7), stack, FX, 5.12, 0.27, undefined, [1.3, 1, 0.78]);
      built(box(1.36, 0.09, 0.84, 1), IRON, FX, 4.64, 0.27);
      built(box(0.92, TOP - 5.6, 0.56, 1.7), stack, FX, (TOP + 5.6) / 2, 0.275);
      built(box(1.04, 0.14, 0.68, 1.7), stack, FX, TOP - 0.3, 0.275);
      built(box(1.12, 0.1, 0.76, 1.2), STONE, FX, TOP + 0.05, 0.275);
      for (const dx of [-0.22, 0.22]) built(cyl(0.11, 0.5, "y", 8, 0.085), POT, FX + dx, TOP + 0.35, 0.275);
      for (const y of [8, 10.6]) iron(box(1.0, 0.05, 0.6, 1), IRON, FX, y, 0.275);
      // The smithy behind the arch: sooty walls, a bench, an anvil on its block.
      D(new THREE.PlaneGeometry(5.5, 5), soot, -0.1, 2.5, -3.2);
      D(new THREE.PlaneGeometry(2.95, 5), soot, -2.85, 2.5, -1.75, [0, Math.PI / 2, 0]);
      D(new THREE.PlaneGeometry(2.95, 5), soot, 2.65, 2.5, -1.75, [0, -Math.PI / 2, 0]);
      D(new THREE.PlaneGeometry(5.5, 2.95), TAR, -0.1, 4.95, -1.75, [Math.PI / 2, 0, 0]);
      D(projectUv(new THREE.PlaneGeometry(5.5, 2.3).rotateX(-Math.PI / 2), 1.8), paint(M.stone, 0x77726a), -0.1, 0.012, -2.07);
      D(box(2.3, 0.07, 0.62, 1), TIMBER, -1.3, 0.86, -2.86);
      for (const x of [-2.35, -0.25]) D(box(0.09, 0.84, 0.5, 1), TIMBER, x, 0.42, -2.86);
      D(cyl(0.23, 0.56, "y", 10), TIMBER, 1.25, 0.28, -1.7);
      D(box(0.5, 0.1, 0.17, 1), IRON, 1.25, 0.83, -1.7);
      D(box(0.24, 0.17, 0.13, 1), IRON, 1.25, 0.65, -1.7);
      D(new THREE.ConeGeometry(0.075, 0.3, 8).rotateZ(-Math.PI / 2), IRON, 1.63, 0.83, -1.7);
      for (let i = 0; i < 5; i += 1) D(rod([2.5 - i * 0.02, 0, -2.6 + i * 0.13], [2.6, 2.5 + (i % 2) * 0.4, -2.75 + i * 0.13], 0.014, 4), IRON);
      for (let i = 0; i < 4; i += 1) D(rod([-1.9 + i * 0.35, 1.5, -3.17], [-1.9 + i * 0.35, 2.0 + (i % 2) * 0.12, -3.17], 0.012, 4), IRON);
      D(sign("smith", 3.0), M.sign, 1.0, 5.43, 0.03);
      D(box(3.1, 0.5, 0.03, 1), IRON, 1.0, 5.43, 0.012);
      D(sign("no17", 0.15), M.sign, 2.5, 1.75, 0.012);
    }
    hungSign("lock", east(-11.5, 2.5, 4.2, 0), Math.PI, 0.5);

    // The savings bank: its name across the front, and what the town has pasted up between the range's boards.
    E(sign("bank", 5.6), M.paintwork, 0.2, 3.9, 0.008);
    E(sign("tradeUp", 0.3), M.sign, 0.08, 2.2, 0.012, [0, 0, -0.03]);
    E(sign("lost", 0.27), M.sign, 0.42, 1.55, 0.012, [0, 0, 0.05]);
    E(sign("laneName", 0.9), M.sign, -5.2, 4.02, 0.012);
    G(sign("no19", 0.15), M.sign, -0.18, 1.75, 0.012);
  }
  // Window boxes, ivy up the party walls and a bay tree either side of the baker's door.
  {
    const boxes: TreeItem[] = [];
    const sill = (zc: number, x: number, y: number, variant: number) => boxes.push({ at: east(zc, x, y, 0.1), yaw: -Math.PI / 2, variant });
    sill(7, 1.15, 0.95, 0); sill(7, -1.15, 4.02, 0); sill(7, 1.15, 4.02, 0); sill(7, 1.15, 6.92, 1);
    sill(1.2, -1.8, 4.47, 1); sill(1.2, 1.8, 4.47, 1);
    sill(-5.25, -1.967, 4.12, 2); sill(-5.25, 0, 4.12, 2); sill(-5.25, 1.967, 4.12, 2); sill(-5.25, 1.967, 0.95, 2);
    trees.place("flowerBox", high ? boxes : boxes.filter((_, i) => i % 2 === 0), { shadow: false, hit: false });
    trees.place("ivy", [
      { at: east(-5.25, 3.3, 0, 0.02), yaw: -Math.PI / 2, variant: 1 },
      { at: [8.3, 0, BACK_Z - 0.02], yaw: Math.PI, variant: 0 },
      { at: [-8.1, 0, BACK_Z - 0.02], yaw: Math.PI, variant: 0, scale: 1.1 },
      { at: [-7.2, 0, BACK_Z - 0.02], yaw: Math.PI, variant: 1, scale: 1.15 },
    ], { shadow: false, hit: false });
    trees.place("potLaurel", [{ at: east(-5.25, -0.92, 0, 0.4), variant: 0 }, { at: east(-5.25, 0.92, 0, 0.4), variant: 0, yaw: 2 }], { hit: true });
  }

  // ---- The bonded warehouse on the west side ---------------------------------------------
  const wareZ = (WARE.z0 + WARE.z1) / 2, wareBrick = paint(M.brick, 0xd9c8bc), wareDoor = paint(M.wood, 0x33473c);
  house(frame(mat4(-WALL_X, 0, wareZ, [0, Math.PI / 2, 0])), {
    w: WARE.z1 - WARE.z0, d: -WALL_X - WARE.x0, floors: [4.65, 2.6, 2.35], gable: "eaves", roofRise: WARE.rise, foot: -2.4,
    wall: wareBrick, trim: paint(M.trim, 0x2a3530), door: wareDoor, roof: paint(M.tile, 0xa8684a), shutter: paint(M.trim, 0x26332e),
    bays: 7, hatchBay: 2, winW: 0.95, arch: 0.28, ground: "blank", seed: 21, clip: [0.31, 0],
    // A barred culvert at the foot of the wall: the warehouse stands over a wet dock.
    holes: [{ fill: "none", x: wareZ + 16, y: 0.14, w: 1.5, h: 0.82, arch: 0.36, floor: 0 }],
  }, NEAR);
  // Its other long side, which only the far bank and the gulls see.
  house(frame(mat4(WARE.x0 - WALL_T, 0, wareZ, [0, -Math.PI / 2, 0])), {
    w: WARE.z1 - WARE.z0, d: 1, floors: [4.65, 2.6, 2.35], gable: "eaves", base: -2.4, shell: false, wall: wareBrick, trim: paint(M.trim, 0x2a3530), door: wareDoor, roof: paint(M.tile, 0xa8684a),
    bays: 7, hatchBay: 4, winW: 0.95, arch: 0.28, ground: "blank", seed: 23,
  }, 0);
  {
    // The end of it that looks down the open quay: it rises out of the water, with a boat arch at its foot.
    const add = both(frame(mat4((WARE.x0 - WALL_X) / 2, 0, WARE.z1)), reflectFrame(mat4((WARE.x0 - WALL_X) / 2, 0, WARE.z1)));
    house(add, {
      w: -WALL_X - WARE.x0, d: 1, floors: [4.65, 2.6, 2.35], gable: "point", rise: WARE.rise, base: -2.4, shell: false,
      wall: wareBrick, trim: paint(M.trim, 0x2a3530), door: wareDoor, roof: paint(M.tile, 0xa8684a), shutter: paint(M.trim, 0x26332e),
      bays: 3, hatchBay: 1, winW: 0.9, arch: 0.28, ground: "blank", attic: "none", hoist: true, seed: 22,
      holes: [{ fill: "none", x: 1.2, y: -2.2, w: 2.6, h: 2.9, arch: 1.3, floor: 0 }],
    }, NEAR);
  }

  // ---- The gable behind the firing line -----------------------------------------------------
  house(frame(mat4(0, 0, BACK_Z, [0, Math.PI, 0])), {
    w: 20.3, d: 14, floors: [7.45], gable: "step", rise: 6.6, foot: -2.4, wall: paint(M.brick, 0xd6c2b6), trim: paint(M.trim, 0xd9d4c8), door: paint(M.wood, 0x33473c), roof: paint(M.tile, 0xb06a48),
    bays: 1, ground: "blank", attic: "none", chimneys: 0, seed: 31, keep: [[-6.5, 6.5, 0.3, 7.3]],
    holes: [
      { fill: "hatch", x: 0, y: 7.75, w: 1.7, h: 2.2, floor: 1 },
      ...[-3.7, 3.7].map((x): Hole => ({ fill: "window", x, y: 7.8, w: 1, h: 1.5, arch: 0.3, floor: 1 })),
      ...[-6.9, 6.9].map((x): Hole => ({ fill: "window", x, y: 7.75, w: 0.85, h: 1.1, arch: 0.25, floor: 1 })),
      { fill: "window", x: 0, y: 12, w: 0.8, h: 0.85, arch: 0.4, floor: 2 },
    ],
  }, NEAR);

  // ---- The counting house across the far end ---------------------------------------------------
  /** Chimneys with a fire under them. */
  const townSmoke: V3[] = [];
  for (const [x, y, z] of house(frame(mat4(0, 0, END_Z)), {
    w: WALL_X * 2, d: 7, floors: [5, 2.6], gable: "eaves", roofRise: 1.5, wall: paint(M.brick, 0xcdb8ac), trim: paint(M.trim, 0xe9e4d8), door: paint(M.wood, 0x33473c), roof: paint(M.tile, 0x6f7780),
    // The range's own mark hangs in the middle of this wall: nothing behind it but brick.
    bays: 8, winW: 1, arch: 0.3, ground: "blank", chimneys: 2, lit: 0.2, seed: 41, keep: [[-1, 1, 4.2, 6.3]],
  }, NEAR).stacks) townSmoke.push([x, y, END_Z + z]);

  // ---- Across the canal ------------------------------------------------------------------------
  const WALLS: Array<[THREE.Material, number]> = [
    [M.brick, 0xf2ddd0], [M.brick, 0xc9b4a8], [M.brick, 0xfff0d0], [M.plaster, 0xe6c88c], [M.plaster, 0xd9dcd2], [M.plaster, 0xe9dfc8], [M.plaster, 0xd4b49a], [M.plaster, 0xb9c4cc], [M.brick, 0xa89488],
  ];
  const SHUTTERS = [0x2c4a3a, 0x6b2f28, 0x33475a, 0x4a4a44], DOORS = [0x26402f, 0x5a2a22, 0x1f2c3a, 0x3a2f24], ROOFS = [0xcf8358, 0xb9704c, 0xc57a52, 0x6f7780, 0x9a5c40];
  const GABLES: Gable[] = ["point", "step", "bell", "neck", "step", "point", "bell"];
  const anyHouse = (seed: number, w: number, d: number, lit: number): HouseSpec => {
    const next = rng(seed), pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)], [material, tone] = pick(WALLS), storeys = next() < 0.45 ? 4 : 3;
    return {
      w, d, floors: [3.1 + next() * 0.5, ...Array.from({ length: storeys - 1 }, (_, i) => 2.95 - i * 0.15 - next() * 0.2)], gable: pick(GABLES),
      wall: paint(material, tone), trim: paint(M.trim, 0xe9e4d8), door: paint(M.wood, pick(DOORS)), roof: paint(M.tile, pick(ROOFS)),
      shutter: next() < 0.6 ? paint(M.trim, pick(SHUTTERS)) : undefined, bays: w > 6.1 ? 3 : 2, ground: "door", doorBay: Math.floor(next() * 2),
      attic: next() < 0.7 ? "window" : "hatch", hoist: next() < 0.4, chimneys: 1 + Math.floor(next() * 2), lit, seed: seed * 7 + 3,
    };
  };
  const bankAt = (x: number, zc: number) => mat4(x, 0, zc, [0, Math.PI / 2, 0]);
  {
    // Behind the square, the row that closes it; then the two rows on the water, north and south of it.
    let z = -34;
    for (let i = 0; z < 4; i += 1) { const w = 5.6 + random() * 1.8; house(farFrame(bankAt(-40, z + w / 2), true), anyHouse(300 + i, w, 9, 0.1), 0); z += w; }
    z = -44;
    for (let i = 0; z < -26.2; i += 1) { const w = Math.min(5.4 + random() * 1.6, -26 - z); house(farFrame(bankAt(FAR_FRONT, z + w / 2), true), anyHouse(200 + i, w, 9, 0.08), 1); z += w; }
    z = -3.5;
    for (let i = 0; z < 122; i += 1) {
      const w = 5 + random() * 2.2, built = house(farFrame(bankAt(FAR_FRONT, z + w / 2), true), anyHouse(100 + i, w, 9, 0.12), z < 50 && high ? 1 : 0);
      if (i % 3 === 1 && z < 60 && built.stacks[0]) townSmoke.push([FAR_FRONT + built.stacks[0][2], built.stacks[0][1], z + w / 2 - built.stacks[0][0]]);
      z += w;
    }
    // The near bank goes on south of the range: houses standing in the water, and a second bridge far down the canal.
    z = BACK_Z + 14;
    for (let i = 0; z < 112; i += 1) { const w = 5.2 + random() * 2; house(farFrame(mat4(QUAY_X - 0.05, 0, z + w / 2, [0, -Math.PI / 2, 0]), true), anyHouse(400 + i, w, 9, 0.1), 0); z += w; }
    const hump = new THREE.Shape(), reach = QUAY_X - 0.05 - FAR_QUAY;
    hump.moveTo(0, -2.4); hump.lineTo(1, -2.4); hump.lineTo(1, -1.7); hump.absellipse(reach / 2, -1.7, reach / 2 - 1, 3, Math.PI, 0, true); hump.lineTo(reach - 1, -2.4); hump.lineTo(reach, -2.4);
    hump.lineTo(reach, 1.1); hump.quadraticCurveTo(reach / 2, 3.9, 0, 1.1); hump.closePath();
    farFrame(mat4(QUAY_X - 0.05, 0, 50, [0, Math.PI, 0]), true)(new THREE.ExtrudeGeometry(hump, { depth: 3.2, bevelEnabled: false, curveSegments: 12 }), paint(M.far, 0x7f7a70));
  }
  {
    // The ground the far bank stands on, its quay wall, and the land that closes the town behind the range.
    const landed = farFrame(new THREE.Matrix4(), false), wet = farFrame(new THREE.Matrix4(), true);
    const paving = paint(M.far, 0x6f6a61), slab = (x0: number, x1: number, z0: number, z1: number, y = -0.02) => landed(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), paving, (x0 + x1) / 2, y, (z0 + z1) / 2);
    slab(-110, FAR_QUAY + 0.3, -110, 126);
    slab(FLOOR.x1 - 0.1, 110, -110, 126);
    slab(WARE.x0 - 0.06, FLOOR.x1, -110, FLOOR.z0 + 0.1);
    slab(QUAY_X - 0.05, FLOOR.x1, FLOOR.z1 - 0.1, 126);
    const face = shadeY(new THREE.BoxGeometry(0.6, 2.5, 172, 1, 6, 1), (y) => { const weed = 1 - THREE.MathUtils.smoothstep(y, -0.85, -0.3); return [0.33 - 0.15 * weed, 0.32 - 0.11 * weed, 0.29 - 0.17 * weed]; });
    wet(face, M.far, FAR_QUAY - 0.3, -1.25, 40);
    wet(face, M.far, QUAY_X - 0.05 + 0.3, -1.25, 23.5 + 86);
    wet(bar(0.7, 0.16, 172), paint(M.far, 0x8d887c), FAR_QUAY - 0.25, 0.02, 40);
    landed(bar(0.5, 2.5, 82), paint(M.far, 0x77736a), WARE.x0 - 0.3, -1.25, -70.2);
    // Lamps along the far quay, still burning: each is a point of light and a streak in the water.
    for (let z = -40; z < 70; z += 13) {
      wet(bar(0.11, 3.5, 0.11), paint(M.far, 0x1c2022), FAR_QUAY - 0.75, 1.75, z + 3);
      wet(bar(0.3, 0.36, 0.3), paint(M.far, new THREE.Color(1, 0.62, 0.26), 4.2), FAR_QUAY - 0.75, 3.68, z + 3);
    }
  }
  unreflected(trees.place("plane", [{ at: [-31.5, 0, -21.5], yaw: 0.4, tint: 0x8d9684 }, { at: [-32.2, 0, -13.6], variant: 1, yaw: 2.1, scale: 0.92, tint: 0x8d9684 }, { at: [-31, 0, -7.4], variant: 2, yaw: 4, tint: 0x969a82 }], { detail: high ? "mid" : "far", hit: false }));

  // ---- Beyond the far end: tall stores, the gangway between them, the bell tower --------------
  {
    const stores = (x: number, w: number, d: number, floors: number[], gable: Gable, rise: number, tone: number, seed: number, keep?: Rect[]) => house(farFrame(mat4(x, 0, -36.5), false), {
      w, d, floors, gable, rise, wall: paint(M.brick, tone), trim: paint(M.trim, 0x3a403c), door: paint(M.wood, 0x33473c), roof: paint(M.tile, 0x8a5a44),
      bays: Math.round(w / 2.8), winW: 0.9, arch: 0.25, ground: "blank", attic: "hatch", hoist: true, chimneys: 0, lit: 0.05, seed, keep,
    }, 0);
    stores(-10.8, 12.6, 24, [4.2, 3.3, 3.3, 3.3], "step", 5.2, 0xb9a59a, 51, [[-6.3, 6.3, 11.2, 13.8]]);
    put(sign("cases", 11.2), M.paintwork, -10.8, 12.5, -36.47);
    stores(14.2, 19.4, 22, [4, 3.2, 3.2, 3], "point", 6, 0xcdb8ac, 52);
    const add = farFrame(new THREE.Matrix4(), false), timber = paint(M.far, 0x4a4038), slate = paint(M.far, 0x4d545c);
    // The gangway: a boarded bridge from store to store, four floors up.
    add(bar(9.2, 2.3, 2.1), timber, 0, 13.7, -45);
    add(ridgePrism(2.5, 0.8, 9.2, "x"), slate, 0, 14.85, -45);
    for (const x of [-3, -1, 1, 3]) add(bar(0.7, 0.8, 0.06), paint(M.far, 0x15191b), x, 13.9, -43.93);
    for (const side of [-1, 1]) add(rod([side * 4.5, 10.6, -45], [side * 2.2, 12.55, -45], 0.11, 5), timber);
    // The bell tower, at the end of everything.
    const tx = 10, tz = -70, brick = paint(M.far, 0x9a7260), pale = paint(M.far, 0xc9c1b0);
    add(bar(6.4, 27, 6.4), brick, tx, 13.5, tz);
    for (const y of [9, 18, 26.6]) add(bar(6.8, 0.4, 6.8), pale, tx, y, tz);
    add(bar(5.8, 6.4, 5.8), brick, tx, 30.2, tz);
    add(bar(6.6, 0.5, 6.6), pale, tx, 33.6, tz);
    for (const [dx, dz, turn] of [[0, 2.92, 0], [-2.92, 0, -Math.PI / 2], [2.92, 0, Math.PI / 2], [0, -2.92, Math.PI]] as number[][]) {
      for (const offset of [-1.15, 1.15]) add(facadeLouvre(), paint(M.far, 0x1a1d1f), tx + dx + Math.cos(turn) * offset, 30, tz + dz - Math.sin(turn) * offset, [0, turn, 0]);
      add(remap(new THREE.CircleGeometry(1.5, 24), "clock"), paint(M.far, 0xd9d2bc), tx + dx * 1.105, 22.4, tz + dz * 1.105, [0, turn, 0]);
    }
    add(new THREE.ConeGeometry(4.4, 11.5, 4, 1).rotateY(Math.PI / 4), slate, tx, 39.6, tz);
    add(cyl(0.05, 2.4, "y", 5), paint(M.far, 0x2a2c2e), tx, 46.4, tz);
    add(new THREE.SphereGeometry(0.28, 8, 6), paint(M.far, 0xb89246), tx, 45.7, tz);
  }

  /** A wicker pot for crabs and lobsters: a board, three hoops and netting over them. Its length lies along x. */
  const pot = (add: Add, x: number, y: number, z: number, yaw = 0, tilt = 0) => {
    const place = mat4(x, y, z, [tilt, yaw, 0]), part: Add = (geometry, given, px = 0, py = 0, pz = 0, rotation, scale, opt) => add(geometry.clone().applyMatrix4(mat4(px, py, pz, rotation, scale)).applyMatrix4(place), given, 0, 0, 0, undefined, undefined, opt);
    part(box(0.66, 0.025, 0.44, 0.8), TIMBER, 0, 0.0125, 0);
    for (const px of [-0.31, 0, 0.31]) part(new THREE.TorusGeometry(0.2, 0.012, 5, 12, Math.PI).rotateY(Math.PI / 2), paint(M.wood, 0xd6c29a), px, 0.025, 0);
    for (const pz of [-0.2, 0, 0.2]) part(cyl(0.008, 0.64, "x", 4), paint(M.wood, 0xd6c29a), 0, pz === 0 ? 0.225 : 0.03, pz);
    part(tiled(new THREE.CylinderGeometry(0.2, 0.2, 0.62, 12, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), 2.5, 2.5), paint(M.net, 0x5d5646), 0, 0.025, 0);
    for (const px of [-0.31, 0.31]) part(tiled(new THREE.CircleGeometry(0.2, 10, 0, Math.PI).rotateY(Math.PI / 2), 1.6, 1.6), paint(M.net, 0x5d5646), px, 0.025, 0);
  };
  /** A coil of rope lying flat. */
  const coil = (add: Add, x: number, y: number, z: number, size = 1) => {
    for (let i = 0; i < 3; i += 1) add(new THREE.TorusGeometry(0.2 - i * 0.045, 0.022, 5, 16).rotateX(Math.PI / 2), ROPE, x + i * 0.004, y + 0.022 + i * 0.03, z, [0, i * 1.3, 0], size);
  };


  // ---- What the warehouse and the two end walls wear -----------------------------------------
  /** A hook on a chain under a hoist beam, with something slung from it; it swings. `at` is the sheave. */
  const hoist = (at: V3, drop: number, load: "bale" | "cask") => {
    const group = new THREE.Group();
    group.position.set(...at);
    scene.add(group);
    const add = rig(group);
    add(cyl(0.011, drop, "y", 5), IRON, 0, -drop / 2, 0);
    add(new THREE.TorusGeometry(0.05, 0.012, 5, 10, Math.PI * 1.5), IRON, 0, -drop - 0.05, 0, [0, 0, -Math.PI / 4]);
    for (const side of [-1, 1]) add(rod([0, -drop - 0.1, 0], [side * 0.26, -drop - 0.5, 0], 0.01, 4), ROPE);
    if (load === "bale") {
      add(rbox(0.72, 0.5, 0.5, 0.12, 0.7), paint(M.matte, 0x85724f), 0, -drop - 0.74, 0);
      for (const x of [-0.2, 0.2]) add(new THREE.TorusGeometry(0.262, 0.012, 4, 14).rotateY(Math.PI / 2), ROPE, x, -drop - 0.74, 0, undefined, [1, 0.98, 1]);
    } else {
      add(lathe([[0, 0], [0.2, 0], [0.25, 0.2], [0.26, 0.36], [0.25, 0.52], [0.2, 0.72], [0, 0.72]], 12).rotateZ(Math.PI / 2), OAK, 0.36, -drop - 0.72, 0);
      for (const x of [-0.22, 0.22]) add(new THREE.TorusGeometry(0.245, 0.012, 4, 14).rotateY(Math.PI / 2), IRON, x, -drop - 0.72, 0);
    }
    life.sway(group, { amplitude: 0.045, period: 2 * Math.sqrt(drop + 0.5), axis: "both", creak: "chainRattle", damping: 0.05 });
  };
  {
    const W = frame(mat4(-WALL_X, 0, wareZ, [0, Math.PI / 2, 0])), built = frame(mat4(-WALL_X, 0, wareZ, [0, Math.PI / 2, 0]), { shadow: true });
    W(sign("wharf", 9.6), M.paintwork, -1, 4.14, 0.008);
    // The culvert: iron bars over the dark, a stone head.
    const CX = wareZ + 16;
    W(new THREE.PlaneGeometry(1.6, 0.9), paint(M.matte, 0x040506), CX, 0.55, -0.27);
    for (let i = 0; i < 6; i += 1) W(cyl(0.016, 0.84, "y", 5), IRON, CX - 0.625 + i * 0.25, 0.55, -0.12);
    W(bar(1.5, 0.03, 0.03), IRON, CX, 0.42, -0.12);
    W(new THREE.TorusGeometry(1.03, 0.07, 4, 12, 1.79), STONE_PALE, CX, 0, 0, [0, 0, Math.PI / 2 - 0.895], [1, 1, 0.45]);
    for (const side of [-1, 1]) W(box(0.14, 0.62, 0.05, 1), STONE_PALE, CX + side * 0.82, 0.33, 0.012);
    // A lucarne at the eaves with the hoist beam out over the loading doors.
    const HX = -10.3 + 0.4 + 2.5 * ((20.6 - 0.8) / 7);
    built(box(2, 2.1, 0.7, 1.7), wareBrick, HX, WARE.eaves + 1.05, -0.36);
    built(ridgePrism(2.3, 0.8, 1.5, "z"), paint(M.tile, 0xa8684a), HX, WARE.eaves + 2.1, -0.55);
    W(box(1.3, 1.5, 0.05, 1.3), wareDoor, HX, WARE.eaves + 0.9, 0);
    built(box(0.17, 0.22, 1.9, 1.2), TAR, HX, WARE.eaves + 1.92, 0.7);
    W(cyl(0.11, 0.05, "x", 12), IRON, HX, WARE.eaves + 1.74, 1.5);
    hoist([-WALL_X + 1.5, WARE.eaves + 1.66, wareZ - HX], 4.6, "bale");
    W(sign("noMooring", 0.42), M.sign, -9.9, 1.75, 0.012);
  }
  {
    // The gable end that looks down the open quay: an advertisement on the brick, a grille in the boat arch.
    const S = frame(mat4((WARE.x0 - WALL_X) / 2, 0, WARE.z1));
    S(sign("bitters", 3), M.paintwork, -2.05, 2.95, 0.008);
    S(sign("chandler", 2.3), M.sign, 1.2, 1.32, 0.03);
    S(box(2.4, 0.38, 0.03, 1), IRON, 1.2, 1.32, 0.012);
    S(new THREE.PlaneGeometry(2.7, 3), paint(M.matte, 0x040506), 1.2, -0.75, -0.28);
    for (let i = 0; i < 9; i += 1) S(cyl(0.02, 2.9, "y", 5), IRON, 1.2 - 1.2 + i * 0.3, -0.75, -0.14);
    for (const y of [-1.2, 0.05]) S(bar(2.6, 0.05, 0.03), IRON, 1.2, y, -0.14);
    S(sign("edge", 0.4), M.sign, 3.5, 1.5, 0.012);
  }
  {
    // Behind the firing line: the hoist over the chart, and nets hung up to dry in the corner.
    const back = frame(mat4(0, 0, BACK_Z, [0, Math.PI, 0]), { shadow: true });
    back(box(0.18, 0.22, 2, 1.2), TAR, 0, 10.4, 0.7);
    back(cyl(0.11, 0.05, "x", 12), IRON, 0, 10.22, 1.55);
    hoist([0, 10.14, BACK_Z - 1.55], 1.7, "cask");
    const NET = { x0: -9.15, x1: -6.9, z: 9.22, top: 1.78 };
    for (const x of [NET.x0, NET.x1]) put(cyl(0.04, NET.top + 0.1, "y", 6), TIMBER, x, (NET.top + 0.1) / 2, NET.z, undefined, undefined, { shadow: true });
    put(rod([NET.x0 - 0.1, NET.top, NET.z], [NET.x1 + 0.1, NET.top, NET.z], 0.03, 6), TIMBER);
    const net = tiled(washing(NET.x1 - NET.x0 - 0.1, 1.5, 2), 9, 6);
    put(net, paint(M.netCloth, 0x6a6452), (NET.x0 + NET.x1) / 2, NET.top - 0.75, NET.z + 0.035);
    put(tiled(washing(1.3, 0.8, 5), 5, 3.2), paint(M.netCloth, 0x7a6f58), NET.x0 + 0.8, NET.top - 0.4, NET.z - 0.04);
    for (let i = 0; i < 7; i += 1) put(new THREE.SphereGeometry(0.045, 6, 5), paint(M.matte, i % 2 ? 0xb5532f : 0xc9b98a), NET.x0 + 0.25 + i * 0.3, NET.top - 1.5 + 0.03 * Math.sin(i * 2.1), NET.z + 0.05);
  }
  {
    // Lobster pots, rope and what came off the barge, kept to the edges of the quay.
    pot(put, -8.72, 0, 8.72, 0.08); pot(put, -7.96, 0, 8.8, -0.12); pot(put, -8.36, 0.232, 8.76, 0.03); pot(put, -9.12, 0, 6.3, 1.45); pot(put, -9.1, 0.232, 6.38, 1.7, 0.02);
    coil(put, -9.62, COPING, 5.95); coil(put, -9.6, COPING, -3.15, 0.9); coil(put, -8.95, 0, 7.5, 1.1); coil(put, 8.9, 0, -9.7, 0.9);
    const stock = (kind: PropKind, items: PropItem[], seed: number, mirrored = false) => {
      const meshes = props.place(kind, items, { seed });
      if (!mirrored) for (const mesh of meshes) kit.mirrorHidden.push(mesh);
    };
    const quarter = Math.PI / 2;
    stock("cask", [
      { position: [-8.98, 0, -9.25] }, { position: [-8.72, 0, -9.94], rotation: [0, 1.2, 0] }, { position: [-8.95, 0, -22.9], rotation: [0, 0.5, 0] }, { position: [-8.9, 0, -23.62], rotation: [0, 2.2, 0] },
      { position: [9.02, 0, -8.98], rotation: [0, 0.8, 0] }, { position: [9.05, 0, -15.2], rotation: [0, 1.9, 0] }, { position: [8.95, 0, -15.92], rotation: [0, 0.3, 0] }, { position: [6.8, 0, 9.12], rotation: [0, 2.6, 0] },
      { position: [10.6, 0, -10.6], rotation: [0, 1, 0] },
    ], 21, true);
    stock("crateLarge", [
      { position: [-8.92, 0, -14.05], rotation: [0, quarter, 0] }, { position: [-8.92, 0, -20], rotation: [0, quarter + 0.04, 0] }, { position: [-8.9, 0, -21.16], rotation: [0, quarter - 0.03, 0] }, { position: [-8.94, 0.84, -20.52], rotation: [0, quarter + 0.12, 0] },
      { position: [8.98, 0, -20], rotation: [0, quarter, 0] }, { position: [7.78, 0, 9.15], rotation: [0, 0.03, 0] },
    ], 22, true);
    stock("crateSmall", [{ position: [-8.9, 0.84, -14], rotation: [0, 0.3, 0] }, { position: [7.7, 0.84, 9.14], rotation: [0, -0.2, 0] }, { position: [-8.85, 0, -24.5], rotation: [0, 1.1, 0] }, { position: [8.76, 0.5625, 8.62], rotation: [0, 0.12, 0] }], 23);
    stock("sackLying", [
      { position: [-8.9, 0, -12.3], rotation: [0, quarter, 0] }, { position: [-8.92, 0.2, -12.36], rotation: [0, quarter + 0.2, 0] }, { position: [-8.86, 0.4, -12.28], rotation: [0, quarter - 0.15, 0] }, { position: [-8.84, 0, -11.42], rotation: [0, 0.2, 0] },
      { position: [8.68, 0.5625, 7.95], rotation: [0, 0.12 + quarter, 0] }, { position: [8.7, 0.76, 8.0], rotation: [0, 0.3 + quarter, 0] }, { position: [8.95, 0, -16.75], rotation: [0, quarter, 0] }, { position: [8.97, 0.2, -16.8], rotation: [0, quarter + 0.25, 0] },
    ], 24);
    stock("sackOpen", [{ position: [9.08, 0, 3.98] }, { position: [-8.8, 0, -24.95], rotation: [0, 1, 0] }], 25);
    // The shop's display under its awning.
    const display = [-0.85, -0.2, 0.45, 1.1];
    stock("crateSlat", display.map((z, i) => ({ position: [9.2, 0, z], rotation: [0, quarter + (i - 1.5) * 0.03, 0] as V3 })), 26);
    for (const mesh of props.fill("crateProduce", display.map((z) => ({ position: [9.2, 0.385, z], rotation: [0, quarter, 0] as V3 })), ["apple", "orange", "lemon", "tomato", "pepper"], { count: high ? 16 : 9, seed: 27 }).meshes) kit.mirrorHidden.push(mesh);
    for (const mesh of props.fill("basket", [{ position: [8.95, 0, -1.45] }, { position: [-9, 0, 2.95] }], ["onion", "garlic"], { count: high ? 22 : 12, seed: 28 }).meshes) kit.mirrorHidden.push(mesh);
    stock("basketTray", [{ position: [-9.05, 0, 2.3] }, { position: [-9.03, 0.062, 2.32], rotation: [0, 0.8, 0] }], 29);
  }

  // ---- The canal ------------------------------------------------------------------------------
  const clock = { value: 0 };
  const rings = { value: [new THREE.Vector4(0, 0, -100, 0), new THREE.Vector4(0, 0, -100, 0), new THREE.Vector4(0, 0, -100, 0)] };
  const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x141e19, roughness: 0.1, metalness: 0, envMapIntensity: 1.15 });
  waterMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = clock;
    shader.uniforms.waterRings = rings;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${WATER_PARS}`)
      .replace("#include <normal_fragment_maps>", WATER_NORMAL)
      .replace("#include <fog_fragment>", `#include <fog_fragment>\n${WATER_MIST}`);
  };
  waterMaterial.customProgramCacheKey = () => "canal-water";
  const water = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.x0 - FAR_QUAY + 1.4, 236).rotateX(-Math.PI / 2), waterMaterial);
  water.position.set((FLOOR.x0 + FAR_QUAY) / 2 + 0.3, WATER_Y, 8);
  water.receiveShadow = true;
  scene.add(water);
  kit.mirrorHidden.push(water);
  /** Starts a ring spreading on the water. */
  let ringAt = 0;
  const ripple = (x: number, z: number, strength: number) => { rings.value[ringAt].set(x, z, clock.value, strength); ringAt = (ringAt + 1) % rings.value.length; };

  // Mist in sheets over the water.
  const mistUniforms = { time: clock, mistColour: { value: new THREE.Color(FOG) } };
  {
    const sheets = [-1.32, -0.95, -0.45, 0.2].slice(0, high ? 4 : 2).map((y) => new THREE.PlaneGeometry(FLOOR.x0 - FAR_QUAY + 10, 150).rotateX(-Math.PI / 2).translate((FLOOR.x0 + FAR_QUAY) / 2 - 2, y, 20));
    const mist = new THREE.Mesh(mergeGeometries(sheets)!, new THREE.ShaderMaterial({ ...MIST_SHADER, uniforms: mistUniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    mist.renderOrder = 3;
    scene.add(mist);
    unreflected([mist]);
  }

  // ---- Boats ----------------------------------------------------------------------------------
  // A work barge and a skiff lie along the quay. Each is a group that rides the water: it heaves and rolls,
  // ranges on its ropes until they snub it, and comes back against the wall.
  type Boat = { group: THREE.Group; x: number; z: number; yaw: number; slack: number; roll: number; heave: number; phase: number; lines: Array<{ rope: THREE.Mesh; cleat: THREE.Vector3; ring: THREE.Vector3 }>; turn: number };
  const boats: Boat[] = [];
  const ropeMaterial = new THREE.MeshStandardMaterial({ color: 0x8f7a58, roughness: 1, metalness: 0 });
  const ropeGeometry = new THREE.CylinderGeometry(0.016, 0.016, 1, 5).translate(0, 0.5, 0);
  const moor = (x: number, z: number, yaw: number, slack: number, roll: number, heave: number, lines: Array<[cleat: V3, ring: V3]>) => {
    const group = new THREE.Group();
    group.position.set(x, WATER_Y, z);
    group.rotation.y = yaw;
    scene.add(group);
    const boat: Boat = {
      group, x, z, yaw, slack, roll, heave, phase: boats.length * 2.4 + 0.7, turn: 0,
      lines: lines.map(([cleat, ring]) => {
        const rope = new THREE.Mesh(ropeGeometry, ropeMaterial);
        rope.userData.walkThrough = true;
        scene.add(rope);
        unreflected([rope]);
        return { rope, cleat: new THREE.Vector3(...cleat), ring: new THREE.Vector3(...ring) };
      }),
    };
    boats.push(boat);
    return { group, add: rig(group) };
  };
  // The skiff, at the foot of the water stairs.
  {
    const FREE = 0.42;
    const { add } = moor(-11.95, -1.75, Math.PI / 2, 0.09, 0.055, 0.02, [[[1.75, FREE + 0.1, 0.1], [-11.3, -0.62, -3.1]], [[-1.95, FREE + 0.04, 0.4], [QUAY_X - 0.03, -0.72, -0.2]]]);
    const hull = boatHull(4.1, 1.38, 0.58, 0.17, 0.37), oak = paint(M.wood, 0xd2bd9b);
    add(hull.outer, paint(M.wood, 0x6f9a86), 0, FREE, 0);
    add(hull.inner, oak, 0, FREE, 0);
    add(hull.sole, paint(M.wood, 0xa8946f), 0, FREE, 0);
    add(hull.rail, paint(M.wood, 0xf0e6d0), 0, FREE, 0);
    for (const t of [0.2, 0.47, 0.7]) add(box(0.2, 0.034, hull.half(t) * 1.84, 0.9), oak, (t - 0.5) * 4.1, FREE + hull.rise(t) - 0.15, 0);
    add(box(0.07, 0.34, 0.05, 0.8), oak, 2.03, FREE + hull.rise(1) - 0.02, 0);
    for (const side of [-1, 1]) {
      add(rod([-1.5, FREE - 0.1, side * 0.2], [1.25, FREE - 0.1, side * 0.3], 0.022, 6), paint(M.wood, 0xe2d2b0));
      add(box(0.56, 0.018, 0.13, 0.8), paint(M.wood, 0xe2d2b0), 1.5, FREE - 0.1, side * 0.31, [0.3 * side, 0.036 * side, 0]);
      add(new THREE.TorusGeometry(0.035, 0.008, 4, 8, Math.PI).rotateY(Math.PI / 2), BRASS, 0.3, FREE + 0.03, side * 0.66, [Math.PI, 0, 0]);
    }
    pot(add, -1.25, FREE - 0.37, 0.05, 0.25);
    coil(add, 1.15, FREE - 0.37, 0, 0.8);
    add(sign("skiffName", 0.62), M.sign, -2.062, FREE - 0.16, 0, [0, -Math.PI / 2, 0]);
    // A bailer and a painter led forward.
    add(lathe([[0, 0], [0.09, 0], [0.11, 0.2], [0.1, 0.2], [0.082, 0.015], [0, 0.015]], 10), paint(M.iron, 0x6a7074), -0.35, FREE - 0.37, -0.22);
  }

  // The barge: a hold amidships with a morning's cargo in it, a cabin aft with the stove lit, a mast and a furled sail.
  const BARGE = { x: -11.74, z: 5.55, deck: 0.55 };
  let pennant: THREE.Mesh | null = null;
  {
    const DECK = BARGE.deck, tarred = paint(M.wood, 0x3d3832), paintwork = paint(M.wood, 0x6d2f29), cream = paint(M.wood, 0xe9dfc6);
    const { group, add } = moor(BARGE.x, BARGE.z, Math.PI / 2, 0.06, 0.018, 0.011, [[[3.05, DECK + 0.12, 0.5], [-9.93, COPING + 0.36, 5.4]], [[-3.1, DECK + 0.12, 0.9], [-9.93, COPING + 0.36, 8.5]]]);
    const plan = new THREE.Shape();
    plan.moveTo(-3.3, -1.1); plan.quadraticCurveTo(-3.3, -1.25, -3.1, -1.25); plan.lineTo(2, -1.25); plan.quadraticCurveTo(3.3, -1.2, 3.3, 0);
    plan.quadraticCurveTo(3.3, 1.2, 2, 1.25); plan.lineTo(-3.1, 1.25); plan.quadraticCurveTo(-3.3, 1.25, -3.3, 1.1); plan.closePath();
    const outline = plan.getPoints(10).map((point) => new THREE.Vector3(point.x, 0, -point.y));
    const hold = new THREE.Path();
    hold.moveTo(-0.75, -0.85); hold.lineTo(2, -0.85); hold.lineTo(2, 0.85); hold.lineTo(-0.75, 0.85); hold.closePath();
    plan.holes.push(hold);
    add(projectUv(new THREE.ExtrudeGeometry(plan, { depth: DECK + 0.4, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2), 1.3), tarred, 0, -0.4, 0);
    add(projectUv(new THREE.ShapeGeometry(plan, 10).rotateX(-Math.PI / 2), 1.1), paint(M.wood, 0xb9aa8f), 0, DECK + 0.004, 0);
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(outline, true), 60, 0.05, 5, true), cream, 0, DECK - 0.06, 0);
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(outline, true), 60, 0.035, 5, true), paintwork, 0, DECK - 0.26, 0);
    add(box(2.75, 0.02, 1.7, 1.1), paint(M.wood, 0x6f6252), 0.625, 0.06, 0);
    for (const [x, z, w, d] of [[0.625, -0.9, 2.95, 0.1], [0.625, 0.9, 2.95, 0.1], [-0.8, 0, 0.1, 1.7], [2.05, 0, 0.1, 1.7]]) add(box(w, 0.16, d, 1), cream, x, DECK + 0.08, z);
    for (let i = 0; i < 2; i += 1) add(box(0.26, 0.035, 1.84, 1), paint(M.wood, 0xa8987c, 0.85 + i * 0.1), -0.58 + i * 0.275, DECK + 0.178, 0, [0, (i % 2 ? 1 : -1) * 0.012, 0]);
    for (let i = 0; i < 3; i += 1) add(box(1.84, 0.035, 0.26, 1), paint(M.wood, 0xa8987c, 0.82 + i * 0.07), 0.7 + i * 0.05, DECK + 0.02 + i * 0.036, -1.06, [0, (i - 1) * 0.03, 0]);
    // Cabin, with one window lit.
    add(box(1.85, 1.1, 1.8, 1.2), paintwork, -2.08, DECK + 0.55, 0);
    add(new THREE.CylinderGeometry(1, 1, 2.02, 16, 1, false).rotateZ(Math.PI / 2), paint(M.matte, 0x4a4b48), -2.08, DECK + 1.1, 0, undefined, [1, 0.2, 0.98]);
    for (const side of [-1, 1]) for (const x of [-2.55, -1.65]) {
      const lit = side > 0 && x < -2;
      add(lit ? remap(new THREE.PlaneGeometry(0.34, 0.26), "window") : new THREE.PlaneGeometry(0.34, 0.26), lit ? LIT : GLASS[0], x, DECK + 0.78, side * 0.905, [0, side > 0 ? 0 : Math.PI, 0]);
      add(box(0.42, 0.04, 0.03, 1), cream, x, DECK + 0.63, side * 0.91);
      add(box(0.42, 0.04, 0.03, 1), cream, x, DECK + 0.93, side * 0.91);
    }
    add(box(0.03, 0.92, 0.56, 1), cream, -1.15, DECK + 0.5, 0.2);
    add(new THREE.SphereGeometry(0.026, 6, 5), BRASS, -1.125, DECK + 0.52, 0.4);
    add(cyl(0.05, 0.7, "y", 8), IRON, -2.6, DECK + 1.55, -0.45);
    add(new THREE.ConeGeometry(0.11, 0.08, 8), IRON, -2.6, DECK + 1.97, -0.45);
    add(sign("reg", 0.44), M.sign, -2.1, DECK + 0.3, 0.906);
    add(sign("bargeName", 1.25), M.sign, -2.2, DECK - 0.16, 1.262);
    // Rudder and tiller.
    add(box(0.5, 1.1, 0.06, 1), tarred, -3.52, 0.12, 0);
    add(rod([-3.34, DECK + 0.2, 0], [-2.35, DECK + 1.42, 0], 0.03, 6, 0.02), paint(M.wood, 0xcbb593));
    // Mast, shrouds, the boom on its crutch and the sail stowed along it.
    const MAST_X = 2.5, MAST_TOP = DECK + 5.7, spar = paint(M.wood, 0xc9b28c), sail = paint(M.matte, 0x6e4233);
    add(box(0.26, 0.5, 0.26, 1), tarred, MAST_X, DECK + 0.25, 0);
    add(cyl(0.075, MAST_TOP - DECK, "y", 8, 0.04), spar, MAST_X, (MAST_TOP + DECK) / 2, 0);
    add(new THREE.SphereGeometry(0.06, 8, 6), BRASS, MAST_X, MAST_TOP + 0.03, 0);
    add(rod([MAST_X, MAST_TOP - 0.2, 0], [3.26, DECK + 0.05, 0], 0.01, 4), IRON);
    for (const side of [-1, 1]) add(rod([MAST_X, MAST_TOP - 0.5, 0], [MAST_X - 0.45, DECK, side * 1.2], 0.01, 4), IRON);
    add(rod([MAST_X - 0.1, DECK + 1.05, 0], [-1.05, DECK + 1.38, 0], 0.05, 7), spar);
    for (const side of [-1, 1]) add(rod([-1.0, DECK, side * 0.42], [-1.0, DECK + 1.52, -side * 0.2], 0.035, 5), spar);
    const bundle = new THREE.CylinderGeometry(0.15, 0.13, 3.1, 9, 12).rotateZ(Math.PI / 2), lumps = bundle.attributes.position;
    for (let i = 0; i < lumps.count; i += 1) { const x = lumps.getX(i), k = 1 + 0.16 * Math.sin(x * 7.1) + 0.1 * Math.sin(x * 17.3 + 1); lumps.setY(i, lumps.getY(i) * k); lumps.setZ(i, lumps.getZ(i) * k * 0.92); }
    bundle.computeVertexNormals();
    add(bundle, sail, 0.72, DECK + 1.36, 0, [0, 0, -0.094]);
    for (let i = 0; i < 6; i += 1) add(new THREE.TorusGeometry(0.165, 0.012, 4, 10).rotateY(Math.PI / 2), ROPE, 2.05 - i * 0.54, DECK + 1.235 + i * 0.051, 0);
    add(rod([MAST_X - 0.2, DECK + 1.52, 0.06], [-0.6, DECK + 1.8, 0.06], 0.03, 5), spar);
    // Washing on a line from the mast to a pole on the cabin, and a pennant at the masthead.
    const lineFrom: V3 = [MAST_X - 0.06, DECK + 3.05, 0], lineTo: V3 = [-2.95, DECK + 2.62, 0.5], SAG = 0.14;
    add(cyl(0.02, 1.6, "y", 5), spar, lineTo[0], DECK + 1.9, lineTo[2]);
    add(hang(lineFrom, lineTo, SAG, 0.007, 12, 4), ROPE);
    const wash: Array<[number, number, number, number]> = [[0.13, 0.5, 0.66, 0xbdb7a8], [0.27, 0.36, 0.42, 0x6f8296], [0.4, 0.56, 0.5, 0xc9c2b2], [0.53, 0.24, 0.6, 0x5d6a78], [0.6, 0.24, 0.6, 0x5d6a78], [0.73, 0.4, 0.46, 0x9a4a40], [0.86, 0.44, 0.58, 0xb5ae9c]];
    for (const [t, w, h, tone] of wash) {
      const x = lineFrom[0] + (lineTo[0] - lineFrom[0]) * t, y = lineFrom[1] + (lineTo[1] - lineFrom[1]) * t - SAG * 4 * t * (1 - t), z = lineFrom[2] + (lineTo[2] - lineFrom[2]) * t;
      add(washing(w, h, t * 40), paint(M.clothTop, tone), x, y - h / 2 - 0.005, z, [0, Math.atan2(-(lineTo[2] - lineFrom[2]), lineTo[0] - lineFrom[0]) + Math.PI, 0]);
    }
    const fly = new THREE.PlaneGeometry(0.8, 0.26, 10, 3).translate(0.4, 0, 0), flyAt = fly.attributes.position;
    for (let i = 0; i < flyAt.count; i += 1) flyAt.setY(i, flyAt.getY(i) * (1 - 0.86 * flyAt.getX(i) / 0.8));
    pennant = new THREE.Mesh(fly, M.clothFlag);
    pennant.position.set(MAST_X, MAST_TOP - 0.2, 0);
    pennant.rotation.y = WIND_HEADING;
    pennant.userData.walkThrough = true;
    group.add(pennant);
    unreflected([pennant]);
    // Rope fenders, a riding light on the crutch, and the morning's cargo in the hold.
    for (const x of [-2.2, 0.2, 2.2]) { add(cyl(0.085, 0.38, "y", 8), ROPE, x, DECK - 0.32, 1.33); add(cyl(0.008, 0.3, "y", 4), ROPE, x, DECK - 0.02, 1.31); }
    lantern(add, -1.0, DECK + 1.56, 0.02, 0.5);
    coil(add, 2.75, DECK, -0.6);
    pot(add, -0.3, DECK + 0.2, -0.5, 0.2);
    const stow = (kind: PropKind, items: PropItem[], seed: number) => { for (const mesh of props.place(kind, items, { seed, shadow: false, hit: false })) { group.add(mesh); mesh.userData.walkThrough = true; unreflected([mesh]); } };
    stow("cask", [{ position: [1.62, 0.07, -0.45], rotation: [0, 0.4, 0] }, { position: [1.6, 0.07, 0.36], rotation: [0, 2.1, 0] }, { position: [0.98, 0.07, -0.42], rotation: [0, 1.1, 0] }], 3);
    stow("crateSlat", [{ position: [0.42, 0.07, 0.5], rotation: [0, 0.08, 0] }, { position: [0.44, 0.45, 0.5], rotation: [0, -0.1, 0] }, { position: [0.95, 0.07, 0.42], rotation: [0, Math.PI / 2, 0] }], 4);
    stow("sackLying", [{ position: [0.28, 0.07, -0.35], rotation: [0, 0.3, 0] }, { position: [0.3, 0.26, -0.3], rotation: [0, -0.2, 0] }, { position: [0.34, 0.45, -0.38], rotation: [0, 0.5, 0] }], 5);
  }

  // The water moves them. Nothing here casts a shadow that moves: the sun's map is drawn once.
  {
    const from = new THREE.Vector3(), reach = new THREE.Vector3(), turn = new THREE.Quaternion(), at = new THREE.Vector3();
    kit.updates.push((now) => {
      const t = now / 1000;
      for (const boat of boats) {
        const p = boat.phase, gust = wind.at(boat.x, boat.z);
        // Ranging: away from the wall until the ropes take up, then back onto it.
        const swing = Math.sin(t * 0.21 + p) + 0.35 * Math.sin(t * 0.53 + p * 2.1), out = boat.slack * (0.5 - 0.5 * swing) - gust * 0.02;
        boat.group.position.set(boat.x - out, WATER_Y + boat.heave * (Math.sin(t * 1.15 + p) + 0.5 * Math.sin(t * 1.9 + p * 1.7)), boat.z + boat.slack * 0.7 * Math.sin(t * 0.16 + p * 0.6));
        boat.group.rotation.set(boat.roll * (Math.sin(t * 0.95 + p) + 0.4 * Math.sin(t * 1.63 + p * 3)) + gust * boat.roll * 0.6, boat.yaw + boat.slack * 0.18 * Math.sin(t * 0.13 + p), boat.roll * 0.35 * Math.sin(t * 0.8 + p * 1.3), "YXZ");
        boat.group.updateMatrixWorld();
        for (const line of boat.lines) {
          from.copy(line.cleat).applyMatrix4(boat.group.matrixWorld);
          reach.copy(line.ring).sub(from);
          const length = reach.length();
          line.rope.position.copy(from);
          line.rope.quaternion.copy(turn.setFromUnitVectors(UP, reach.divideScalar(length)));
          line.rope.scale.set(1, length, 1);
        }
        // It says so at each end of its range: a rope snubbing, or the hull coming onto the wall.
        const half = Math.floor((t * 0.21 + p) / Math.PI - 0.5);
        if (half !== boat.turn) {
          const first = boat.turn === 0;
          boat.turn = half;
          if (first || chance() < 0.35) continue;
          if (half % 2 !== 0) cue?.("ropeClank", at.copy(boat.lines[0].ring), { gain: 0.3 + chance() * 0.25, pitch: 0.85 + chance() * 0.3 });
          else { cue?.("waveSlap", at.set(QUAY_X - 0.2, WATER_Y + 0.2, boat.z), { gain: 0.3 + chance() * 0.3, pitch: 0.9 + chance() * 0.25 }); ripple(QUAY_X - 0.25, boat.z + (chance() - 0.5) * 2, 0.05); }
        }
      }
    });
  }

  // ---- Life -------------------------------------------------------------------------------------
  const fills: THREE.PointLight[] = [];
  {
    const coping = BRIDGE.top + BRIDGE.parapet + 0.1, ridgeX = -WALL_X - (-WALL_X - WARE.x0) / 2 + 0.18;
    // Gulls on the bridge, the piles and the warehouse ridge, and a few on the wing over the water.
    life.birds("gull", {
      perches: [
        { from: [QUAY_X - BRIDGE.run - 0.4, coping, BRIDGE_Z + 1.02], to: [FAR_QUAY + BRIDGE.run + 0.4, coping, BRIDGE_Z + 1.02] },
        ...PILES.map(([x, top, z]): V3 => [x, top + 0.005, z]),
        [-9.93, COPING + 0.615, 8.5], [-9.93, COPING + 0.615, -2.6],
        { from: [ridgeX, WARE.eaves + WARE.rise, WARE.z1 - 1.2], to: [ridgeX, WARE.eaves + WARE.rise, WARE.z1 - 9] },
      ],
      count: 6, roam: { x: [-24, -9], y: [3, 15], z: [-12, 14] },
    });
    life.soaring("gull", { centre: [-17, 0, 4], radius: 15, height: 16, count: 3 });
    // Pigeons along the cornices and ridges; sparrows about the shop and the baker's door; swifts high up.
    life.birds("pigeon", {
      perches: [
        { from: [WALL_X - 0.24, 7.62, -25.4], to: [WALL_X - 0.24, 7.62, -15] },
        { from: [-7.5, 9.12, END_Z - 3.32], to: [7.5, 9.12, END_Z - 3.32] },
        { from: [-WALL_X + 0.24, WARE.eaves + 0.02, -27], to: [-WALL_X + 0.24, WARE.eaves + 0.02, -19] },
        { from: [-0.08, 10.52, BACK_Z - 0.4], to: [-0.08, 10.52, BACK_Z - 1.6], thin: true },
        [8.4, 0.01, -3.4], [7.9, 0.01, -2.6],
      ],
      count: 9, roam: { x: [-9, 9], y: [6, 17], z: [-30, 9] },
    });
    life.birds("sparrow", {
      perches: [
        { from: [WALL_X - 1.52, 2.29, -1.3], to: [WALL_X - 1.52, 2.29, 1.9], thin: true },
        { from: [RAIL_X, COPING + 0.8, 4.3], to: [RAIL_X, COPING + 0.8, 5.2], thin: true },
        east(7, 1.15, 1.14, 0.12), east(-5.25, 1.967, 1.14, 0.12), [8.72, 0.86, 7.55], [8.5, 0.01, -4.1], [8.2, 0.01, -4.7], [-8.6, 0.01, 7.9], [-8.3, 0.47, 8.76],
      ],
      count: 7,
    });
    life.soaring("swift", { centre: [2, 0, -12], radius: 22, height: 21, count: 5 });
    life.insects(LAMPS.map(([x, y, z]): V3 => [x, y, z]), { kind: "moths", count: 4, radius: 0.5 });

    // Chimney smoke: the baker's oven, the counting house, a few hearths across the water, and the smith's stack.
    const smokes: V3[] = [...townSmoke];
    for (const [x, y, z] of terrace[2].built?.stacks ?? []) smokes.push(east(terrace[2].zc, x, y, z));
    life.plume("smoke", smokes, { rise: 6.5, size: [0.4, 2.4], life: 9, opacity: 0.34, color: 0x9a958c, lean: 3.2, density: 7 });
    life.plume("smoke", [WALL_X - 0.275, 14.95, -12.65], { rise: 9, size: [0.6, 3.4], life: 10, opacity: 0.5, color: 0x5d5853, lean: 4, density: 10 });
    life.plume("smoke", [BARGE.x - 0.45, WATER_Y + BARGE.deck + 2.02, BARGE.z + 2.6], { rise: 3.2, size: [0.12, 0.9], life: 5, opacity: 0.32, color: 0xb5b0a6, lean: 1.6, density: 6 });

    // The lamps are still lit: a little real light under the two on the quay, and all of them breathe together.
    for (const [x, y, z] of LAMPS) {
      const light = new THREE.PointLight(0xffb468, 9, 11, 2);
      light.position.set(x + 0.25, y - 0.5, z);
      scene.add(light);
      fills.push(light);
    }
    const lampColour = M.lamp.color.clone();
    life.flicker([(level: number) => { M.lamp.color.copy(lampColour).multiplyScalar(0.72 + 0.28 * level); }, ...fills], "lantern", { cue: false });

    // One shutter on the provision shop has slipped its catch.
    {
      const loose = new THREE.Group(), w = 0.5, h = 1.58;
      loose.position.set(...east(1.2, 1.8 + 0.512, 3.75 + 3 + 0.72 + h / 2, 0.035));
      loose.rotation.set(-0.45, 0, Math.PI / 2, "ZYX");
      scene.add(loose);
      const leafAt = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
      rig(loose)(shutterLeaf(w, h, true).applyMatrix4(leafAt).translate(0, 0, w / 2), paint(M.trim, 0x2c4a3a));
      life.sway(loose, { amplitude: 0.16, period: 3.4, axis: "x", creak: "shutterCreak", damping: 0.05 });
    }

    // Water dripping under the bridge and in the culvert, and now and then a fish.
    let nextDrip = -1, nextFish = -1;
    const where = new THREE.Vector3();
    kit.updates.push((now) => {
      const t = now / 1000;
      if (nextDrip < 0) { nextDrip = t + 3; nextFish = t + 16; }
      if (t > nextDrip) {
        nextDrip = t + 2.5 + chance() * 6.5;
        if (chance() < 0.3) where.set(-WALL_X - 0.3, 0.25, -16);
        else { where.set(QUAY_X - 1.6 - chance() * 9, WATER_Y, BRIDGE_Z + (chance() - 0.5) * 1.5); ripple(where.x, where.z, 0.05); }
        cue?.("drip", where, { gain: 0.22 + chance() * 0.3, pitch: 0.85 + chance() * 0.4 });
      }
      if (t > nextFish) {
        nextFish = t + 24 + chance() * 40;
        where.set(-13.2 - chance() * 8, WATER_Y, -3 + chance() * 13);
        ripple(where.x, where.z, 0.15);
        cue?.("splash", where, { gain: 0.3 + chance() * 0.15, pitch: 1.1 + chance() * 0.3 });
      }
    });
  }

  // ---- Furnace -----------------------------------------------------------------------------
  // Its flue goes up into the foot of the smithy's outside stack.
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 1.3);

  flush();

  // The far bank as one mesh, and the same triangles again as its picture in the water.
  {
    const direct = mergeGeometries(far.direct)!;
    const bank = new THREE.Mesh(direct, M.far);
    bank.castShadow = true;
    bank.receiveShadow = true;
    scene.add(bank);
    kit.mirrorHidden.push(bank);
    const lamps = mergeGeometries(far.lamps);
    if (lamps) unreflected([scene.add(new THREE.Mesh(lamps, M.glow)).children[scene.children.length - 1]]);
    const mirrorMaterial = new THREE.ShaderMaterial({
      ...MIRROR_SHADER,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        mirrorSun: { value: TO_SUN.clone() }, mirrorLight: { value: new THREE.Color(0xffcf9a).multiplyScalar(1.6) }, mirrorShade: { value: new THREE.Color(0.62, 0.66, 0.7) },
      }]),
      vertexColors: true, fog: true, transparent: true, depthWrite: false, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    mirrorMaterial.uniforms.time = clock;
    const mirrored = new THREE.Mesh(mergeGeometries([...far.mirrored, ...far.near])!, mirrorMaterial);
    mirrored.frustumCulled = false;
    mirrored.renderOrder = 2;
    scene.add(mirrored);
    unreflected([mirrored]);
    far.direct.forEach((part) => part.dispose());
    far.lamps.forEach((part) => part.dispose());
    far.near.forEach((part) => part.dispose());
  }

  // ---- Sky -------------------------------------------------------------------------------------
  const domeUniforms = {
    domeFog: { value: new THREE.Color(FOG) }, domeZenith: { value: new THREE.Color(0xa9bccb) }, domeSun: { value: TO_SUN.clone() },
    domeSunTint: { value: new THREE.Color(1, 0.8, 0.56) }, domeGain: { value: 1 },
  };
  const SKY_INTENSITY = 1.1;
  {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ ...DOME_SHADER, uniforms: domeUniforms, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false }));
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    scene.add(dome);
    // The air follows the game's mood: when the range is restaged its fog darkens, and the sky and the mist with it.
    kit.updates.push(() => {
      const fog = scene.fog as THREE.FogExp2 | null;
      if (fog) { domeUniforms.domeFog.value.copy(fog.color); mistUniforms.mistColour.value.copy(fog.color); }
      domeUniforms.domeGain.value = scene.backgroundIntensity / SKY_INTENSITY;
    });
  }

  // ---- Light -------------------------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xd4dbe4, 0x8f877a, 1.35));
  const sun = kit.sunLight({ color: 0xffcf9a, intensity: 4.8, toSun: TO_SUN, extent: 34, distance: 60, near: 4, far: 130, radius: 3 });
  kit.updates.push((now) => { clock.value = now / 1000; wind.update(now); });

  const lampGlow = new THREE.Color(1, 0.62, 0.27).multiplyScalar(0.5);
  const glows: Glow[] = [...LAMPS.map(([x, y, z]) => ({ position: new THREE.Vector3(x, y, z), color: lampGlow })), { position: BRIDGE_LAMP, color: lampGlow }];
  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows,
    look: {
      sky: "/environment/tears_of_steel_bridge-2k.hdr", skyIntensity: SKY_INTENSITY, skyRotation: Math.PI, skyClamp: 0.6,
      background: FOG, fog: FOG, fogDensity: high ? 0.016 : 0.018,
      haze: new THREE.Color(0.05, 0.047, 0.042), hazeDensity: 0.0075, hazeCeiling: 15, hazeFade: 7,
      environmentIntensity: 0.95, exposure: 0.86, far: 260,
    },
    sunlitAt: sunlitFromBoxes(TO_SUN, [
      new THREE.Box3(new THREE.Vector3(WARE.x0, -2, WARE.z0), new THREE.Vector3(-WALL_X, WARE.eaves + 1.2, WARE.z1)),
      new THREE.Box3(new THREE.Vector3(-36, 0, -3.5), new THREE.Vector3(FAR_FRONT, 11.5, 120)),
      new THREE.Box3(new THREE.Vector3(-36, 0, -44), new THREE.Vector3(FAR_FRONT, 11.5, -26)),
      new THREE.Box3(new THREE.Vector3(-49, 0, -34), new THREE.Vector3(-40, 11, 4)),
      new THREE.Box3(new THREE.Vector3(-WALL_X, 0, END_Z - 7), new THREE.Vector3(WALL_X, 7.6, END_Z)),
    ]),
    probeAt: new THREE.Vector3(0, 2.4, -6),
  });
  return {
    ...range,
    startle: life.startle,
    struck: (object, point) => { answering = true; const dealt = life.struck(object, point); answering = false; return dealt; },
  };

  /** Keeps meshes out of the floor's mirror and out of the light probe. */
  function unreflected(objects: THREE.Object3D[]) {
    for (const object of objects) { kit.mirrorHidden.push(object); kit.probeHidden.push(object); }
    return objects;
  }
  /** A belfry opening: a dark, round-headed slot. */
  function facadeLouvre() {
    const shape = new THREE.Shape();
    shape.moveTo(-0.6, -2); shape.lineTo(0.6, -2); shape.lineTo(0.6, 1.6); shape.absarc(0, 1.6, 0.6, 0, Math.PI, false); shape.lineTo(-0.6, -2);
    return new THREE.ShapeGeometry(shape, 8);
  }
}

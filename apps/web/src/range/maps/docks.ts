import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial } from "../pbr";
import { createLife } from "../life";
import { createProps, type PropItem, type PropKind } from "../props";
import { createTrees, type TreeItem } from "../trees";
import { createWind } from "../wind";
import {
  BRAND, STRIKE_ORANGE, canvasTexture, createKit, hazardTexture, jerseyBarrier, projectUv, softBox, softDiscTexture, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";

// Quayside: a lane between container stacks on a working quay, at dusk.
//
// Lighting model: the last of the sun comes in low over the yard on the left,
// clears the two-high stack on that side and lands on the upper tiers of the
// right-hand stack, on the ship moored behind it and on the quay cranes. The
// lane itself is already in shade and is carried by cold floodlight masts and
// sodium lamps, which the damp apron mirrors. Where the left stack stops at the
// firing point, a wedge of that last light still reaches the ground.

/** Direction to the afterglow: low in the north-west of the map, over the yard. */
const TO_SUN = new THREE.Vector3(-0.92, 0.2, -0.39).normalize();
/** Turn of the sky photograph that puts its clean, pink-clouded half over the lane and its trees to the south. */
const SKY_TURN = 0.754;
/** ISO box: width, height, and the vertical pitch of a stack (a hair of air between corner castings). */
const CW = 2.44, CH = 2.59, TIER = CH + 0.012;
const LONG = 12.19, SHORT = 6.06;
/** One tile of the corrugation texture spans eight ribs. */
const RIB_TILE = 2.24;
/** A clean spot of the corrugation texture on the flat of a rib, used by frames and doors. */
const FLAT_U = 0.0625, FLAT_V = 0.5;
const QUAY_EDGE = 25;
const WATER_Y = -2.2;
const DECK_Y = 11.6;

type V3 = [number, number, number];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Merges parts of any provenance: unindexed, and all carrying a vertex colour. */
function merge(parts: THREE.BufferGeometry[]) {
  const ready = parts.map((part) => {
    const flat = part.index ? part.toNonIndexed() : part;
    if (!flat.attributes.color) shade(flat, 1);
    return flat;
  });
  const merged = mergeGeometries(ready);
  ready.forEach((part) => part.dispose());
  parts.forEach((part) => part.dispose());
  return merged;
}

function shade<T extends THREE.BufferGeometry>(geometry: T, r: number, g = r, b = r): T {
  const count = geometry.attributes.position.count, colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) { colours[i * 3] = r; colours[i * 3 + 1] = g; colours[i * 3 + 2] = b; }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return geometry;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return geometry;
}

function rod(a: V3, b: V3, radius: number, segments = 6) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), segments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return geometry;
}

/** A square-section member between two points; `w` lies in the plane of the member and the vertical where it can. */
function beam(a: V3, b: V3, w: number, d = w) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const geometry = new THREE.BoxGeometry(w, from.distanceTo(to), d);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return geometry;
}

/** Wall-style UVs: `u` runs along the face in `across` metres per tile, `v` is height above `base` over `rise`; lids take one texel. */
function wallUv<T extends THREE.BufferGeometry>(geometry: T, across: number, base: number, rise: number, lid: [number, number], offset = 0): T {
  const position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) {
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
    if (ny > nx && ny > nz) uv.setXY(i, lid[0], lid[1]);
    else uv.setXY(i, (nx > nz ? position.getZ(i) : position.getX(i)) / across + offset, (position.getY(i) - base) / rise);
  }
  return geometry;
}

/** A colour canvas and a tangent-space normal map derived from a painted height canvas. */
function reliefTextures(width: number, height: number, colour: (context: CanvasRenderingContext2D) => void, relief: (context: CanvasRenderingContext2D) => void, strength: number) {
  const map = canvasTexture(width, height, colour, true);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  relief(context);
  const source = context.getImageData(0, 0, width, height), target = context.createImageData(width, height);
  const h = (x: number, y: number) => source.data[(((y + height) % height) * width + ((x + width) % width)) * 4] / 255;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const length = Math.hypot(dx, dy, 1), i = (y * width + x) * 4;
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

/** Corrugated container side, eight ribs wide and one box tall. Near-white, so the instance colour is the paint. */
function containerTextures() {
  const random = rng(311), W = 2048, H = 1024, RIB = W / 8;
  return reliefTextures(W, H, (context) => {
    for (let rib = 0; rib < 8; rib += 1) {
      const across = context.createLinearGradient(rib * RIB, 0, rib * RIB + RIB, 0);
      across.addColorStop(0, "#a9a9a9"); across.addColorStop(0.14, "#b9b9b9"); across.addColorStop(0.3, "#ededed");
      across.addColorStop(0.7, "#e6e6e6"); across.addColorStop(0.86, "#b2b2b2"); across.addColorStop(1, "#a9a9a9");
      context.fillStyle = across;
      context.fillRect(rib * RIB, 0, RIB, H);
    }
    // Sun-fade and patchiness.
    for (let i = 0; i < 90; i += 1) {
      const x = random() * W, y = random() * H, r = 80 + random() * 260, light = random() < 0.5;
      const blot = context.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, light ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.1)"); blot.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = blot;
      context.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Rust weeps from the top rail and from knocks: a ragged scab, then a run that wanders and thins.
    for (let i = 0; i < 110; i += 1) {
      const x = random() * W, top = random() < 0.6 ? random() * 50 : random() * 840, length = 80 + random() * 480, width = 3 + random() * 12, strength = 0.22 + random() * 0.36;
      for (let step = 0; step < 4; step += 1) {
        const run = context.createLinearGradient(0, top, 0, top + length * (1 - step * 0.2));
        run.addColorStop(0, `rgba(96,44,18,${strength * 0.5})`); run.addColorStop(1, "rgba(96,44,18,0)");
        context.fillStyle = run;
        context.fillRect(x + (random() - 0.5) * width * 0.8, top, width * (0.3 + random() * 0.5), length * (1 - step * 0.2));
      }
      for (let fleck = 0; fleck < 9; fleck += 1) {
        const r = 2 + random() * width * 0.9, fx = x + width / 2 + (random() - 0.5) * width * 2.2, fy = top + (random() - 0.6) * 14;
        const scab = context.createRadialGradient(fx, fy, 0, fx, fy, r);
        scab.addColorStop(0, `rgba(48,22,11,${strength})`); scab.addColorStop(1, "rgba(60,26,12,0)");
        context.fillStyle = scab; context.fillRect(fx - r, fy - r, r * 2, r * 2);
      }
    }
    // Scuffs from handling gear: long faint drags built from short broken dashes.
    for (let i = 0; i < 70; i += 1) {
      const light = random() < 0.6, y = 120 + random() * 800, x = random() * W, length = 60 + random() * 420, drift = (random() - 0.5) * 0.06;
      for (let at = 0; at < length; at += 3 + random() * 9) {
        context.fillStyle = light ? `rgba(255,255,255,${0.05 + random() * 0.14})` : `rgba(20,16,14,${0.05 + random() * 0.16})`;
        context.fillRect((x + at) % W, y + at * drift + (random() - 0.5) * 2, 2 + random() * 8, 1 + random() * 1.6);
      }
    }
    for (let i = 0; i < 26000; i += 1) {
      const tone = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${tone},${tone},${tone},.045)`;
      context.fillRect(random() * W, random() * H, 1 + random() * 2, 1 + random() * 5);
    }
    // Road grime wicks up from the bottom rail; soot settles under the top one.
    const grime = context.createLinearGradient(0, H * 0.74, 0, H);
    grime.addColorStop(0, "rgba(34,27,22,0)"); grime.addColorStop(1, "rgba(34,27,22,.6)");
    context.fillStyle = grime; context.fillRect(0, H * 0.74, W, H * 0.26);
    const soot = context.createLinearGradient(0, 0, 0, 92);
    soot.addColorStop(0, "rgba(24,20,18,.4)"); soot.addColorStop(1, "rgba(24,20,18,0)");
    context.fillStyle = soot; context.fillRect(0, 0, W, 92);
    // The clean flat that frames and doors sample.
    context.fillStyle = "#d2d2d2";
    context.fillRect(88, 472, 80, 80);
  }, (context) => {
    for (let rib = 0; rib < 8; rib += 1) {
      const across = context.createLinearGradient(rib * RIB, 0, rib * RIB + RIB, 0);
      across.addColorStop(0.1, "#000"); across.addColorStop(0.3, "#fff"); across.addColorStop(0.7, "#fff"); across.addColorStop(0.9, "#000");
      context.fillStyle = across;
      context.fillRect(rib * RIB, 0, RIB, H);
    }
  }, 6.4);
}

function cyl(radius: number, height: number, x: number, y: number, z: number, axis: "x" | "y" | "z" = "y", segments = 12, top = radius) {
  const geometry = new THREE.CylinderGeometry(top, radius, height, segments);
  if (axis === "x") geometry.rotateZ(Math.PI / 2); else if (axis === "z") geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, z);
  return geometry;
}

/** A pipe, hose or cable through the given points. */
function tube(points: V3[], radius: number, segments = 20, radial = 6) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))), segments, radius, radial, false);
}

/** A line hanging between two points, sagging by `sag` at mid span. */
function hang(a: V3, b: V3, sag: number, radius: number, segments = 16) {
  const points: V3[] = [];
  for (let i = 0; i <= 6; i += 1) {
    const t = i / 6;
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  return tube(points, radius, segments, 5);
}

type Facing = "x+" | "x-" | "z+" | "z-" | "y+";
/** A flat panel centred on a point and facing along an axis. */
function quad(w: number, h: number, x: number, y: number, z: number, facing: Facing, turn = 0) {
  const geometry = new THREE.PlaneGeometry(w, h);
  if (facing === "x+") geometry.rotateY(Math.PI / 2);
  else if (facing === "x-") geometry.rotateY(-Math.PI / 2);
  else if (facing === "z-") geometry.rotateY(Math.PI);
  else if (facing === "y+") { geometry.rotateX(-Math.PI / 2); if (turn) geometry.rotateY(turn); }
  geometry.translate(x, y, z);
  return geometry;
}

/** Points a quad's UVs at one cell of an atlas `size` pixels square (or `size` × `high`). */
function cellUv<T extends THREE.BufferGeometry>(geometry: T, cell: [number, number, number, number], size: number, high = size): T {
  const [px, py, pw, ph] = cell, uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (px + uv.getX(i) * pw) / size, 1 - (py + (1 - uv.getY(i)) * ph) / high);
  return geometry;
}

/**
 * A pressed-steel corrugated panel: trapezoid ribs at the pitch of the corrugation texture, with a few
 * handling dents. `at` maps (distance along, height, depth pressed in) to a position.
 */
function corrugated(from: number, to: number, low: number, top: number, rows: number, phase: number, offsetU: number, at: (along: number, y: number, inset: number) => V3, out: V3, seed: number) {
  const pitch = RIB_TILE / 8, depth = 0.038, stops: number[] = [from];
  for (let cell = Math.floor(from / pitch + phase) - 1; ; cell += 1) {
    let done = false;
    for (const t of [0.1, 0.3, 0.7, 0.9]) {
      const x = (cell + t - phase) * pitch;
      if (x >= to - 0.004) { done = true; break; }
      if (x > from + 0.004) stops.push(x);
    }
    if (done) break;
  }
  stops.push(to);
  const random = rng(seed);
  const dents = Array.from({ length: Math.max(2, Math.round((to - from) / 2.6)) }, () => ({ x: from + random() * (to - from), y: low + (0.15 + random() * 0.7) * (top - low), r: 0.25 + random() * 0.45, d: 0.012 + random() * 0.03 }));
  const inset = (x: number, y: number) => {
    const t = x / pitch + phase, f = t - Math.floor(t);
    const rib = depth * (1 - Math.min(1, Math.max(0, Math.min((f - 0.1) / 0.2, (0.9 - f) / 0.2))));
    let dent = 0;
    for (const hit of dents) dent += hit.d * Math.exp(-((x - hit.x) ** 2 + (y - hit.y) ** 2) / (hit.r * hit.r));
    return rib + dent;
  };
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  stops.forEach((x) => {
    for (let row = 0; row <= rows; row += 1) {
      const y = low + (top - low) * row / rows;
      positions.push(...at(x, y, inset(x, y)));
      uvs.push(x / RIB_TILE + offsetU, y / CH);
    }
  });
  const a = new THREE.Vector3(...at(from, low, 0)), b = new THREE.Vector3(...at(to, low, 0)), c = new THREE.Vector3(...at(from, top, 0));
  const flip = b.sub(a).cross(c.sub(a)).dot(new THREE.Vector3(...out)) < 0;
  for (let i = 0; i < stops.length - 1; i += 1) for (let row = 0; row < rows; row += 1) {
    const p = i * (rows + 1) + row, q = p + rows + 1;
    if (flip) index.push(p, p + 1, q, q, p + 1, q + 1); else index.push(p, q, p + 1, q, q + 1, p + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * One outward face of a corner casting, facing +z about the origin: a steel lid `proud` thick with the
 * elongated aperture twist-locks and lashing hooks go into, cut through to a dark floor.
 */
function castingFace(w: number, h: number, slotW: number, slotH: number, proud: number, tone: number) {
  const outline = new THREE.Shape();
  outline.moveTo(-w / 2, -h / 2); outline.lineTo(w / 2, -h / 2); outline.lineTo(w / 2, h / 2); outline.lineTo(-w / 2, h / 2); outline.closePath();
  const a = slotW / 2, b = slotH / 2, c = Math.min(a, b) * 0.6;
  const slot = new THREE.Path();
  slot.moveTo(-a + c, -b); slot.lineTo(a - c, -b); slot.lineTo(a, -b + c); slot.lineTo(a, b - c); slot.lineTo(a - c, b); slot.lineTo(-a + c, b); slot.lineTo(-a, b - c); slot.lineTo(-a, -b + c); slot.closePath();
  outline.holes.push(slot);
  const lid = new THREE.ExtrudeGeometry(outline, { depth: proud, bevelEnabled: false });
  const position = lid.attributes.position, normal = lid.attributes.normal, colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 3) {
    // The walls of the aperture are in shadow; everything else is the casting's own steel.
    let inside = Math.abs(normal.getZ(i)) < 0.5;
    for (let v = 0; v < 3 && inside; v += 1) inside = Math.abs(position.getX(i + v)) <= a + 1e-4 && Math.abs(position.getY(i + v)) <= b + 1e-4;
    colours.fill(inside ? 0.09 : tone, i * 3, i * 3 + 9);
  }
  lid.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  const floor = shade(new THREE.PlaneGeometry(slotW, slotH).translate(0, 0, proud * 0.08), 0.02).toNonIndexed();
  const merged = mergeGeometries([lid, floor]);
  lid.dispose(); floor.dispose();
  return merged;
}

/**
 * A 20 or 40 ft box, doors at +x. `level` 0 is a far box: frame, rails and the outline of its doors.
 * Level 1 adds corner castings and door gear. Level 2 is a box the range looks at closely: pressed
 * corrugations, castings with real apertures, lock rods in their guides with cams, keepers, handles
 * and hinges, gaskets and fittings. An `open` one has its doors swung back and a visible inside.
 */
function containerGeometry(length: number, level: 0 | 1 | 2, open = false) {
  const L = length, parts: THREE.BufferGeometry[] = [];
  const hx = L / 2, hz = CW / 2, detail = level === 2, far = level === 0;
  const flat = (geometry: THREE.BufferGeometry, r = 1, g = r, b = r) => {
    const flatUv = geometry.attributes.uv;
    for (let i = 0; i < flatUv.count; i += 1) flatUv.setXY(i, FLAT_U, FLAT_V);
    parts.push(shade(geometry, r, g, b));
  };
  /** The same for a part that brings its own vertex colours. */
  const tinted = (geometry: THREE.BufferGeometry) => {
    const flatUv = geometry.attributes.uv;
    for (let i = 0; i < flatUv.count; i += 1) flatUv.setXY(i, FLAT_U, FLAT_V);
    parts.push(geometry);
  };
  if (open) {
    // Roof skin, a plywood floor a finger below the sill, and an inside-out liner so the inside has walls.
    flat(box(L - 0.1, 0.03, CW - 0.07, 0, CH - 0.035, 0), 0.9);
    flat(box(L - 0.16, 0.14, CW - 0.12, 0, 0.08, 0), 0.34, 0.25, 0.17);
    const liner = box(L - 0.16, CH - 0.26, CW - 0.13, 0, CH / 2 - 0.01, 0).toNonIndexed();
    const position = liner.attributes.position, normal = liner.attributes.normal;
    for (let i = 0; i < position.count; i += 3) {
      const bx = position.getX(i + 1), by = position.getY(i + 1), bz = position.getZ(i + 1);
      position.setXYZ(i + 1, position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2));
      position.setXYZ(i + 2, bx, by, bz);
    }
    for (let i = 0; i < normal.count; i += 1) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
    flat(liner, 0.62);
  } else {
    const core = detail ? box(L - 0.14, CH - 0.04, CW - 0.11, 0, CH / 2, 0) : box(L - 0.1, CH - 0.04, CW - 0.016, 0, CH / 2, 0);
    const position = core.attributes.position, normal = core.attributes.normal, uv = core.attributes.uv;
    for (let i = 0; i < position.count; i += 1) {
      const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
      if (nz > 0.5) uv.setXY(i, position.getX(i) / RIB_TILE + 0.37, position.getY(i) / CH);
      else if (nx > 0.5) uv.setXY(i, position.getZ(i) / RIB_TILE + 0.21, position.getY(i) / CH);
      else if (ny > 0.5) uv.setXY(i, position.getX(i) / RIB_TILE, 0.62);
    }
    parts.push(shade(core, 1));
  }
  if (detail) {
    for (const sz of [-1, 1]) parts.push(shade(corrugated(-hx + 0.15, hx - 0.15, 0.15, CH - 0.09, 3, 2.96, 0.37, (x, y, inset) => [x, y, sz * (hz - 0.008 - inset)], [0, 0, sz], sz > 0 ? 17 + L : 91 + L), 1));
    parts.push(shade(corrugated(-hz + 0.15, hz - 0.15, 0.15, CH - 0.11, 3, 1.68, 0.21, (z, y, inset) => [-(hx - 0.02 - inset), y, z], [-1, 0, 0], 5), 1));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // On a close box the post stops at its castings, so their apertures open on darkness and not on the post.
    flat(box(0.15, detail ? CH - 0.248 : CH, 0.15, sx * (hx - 0.075), CH / 2, sz * (hz - 0.075)), 0.94);
    if (far) continue;
    for (const top of [0, 1]) {
      const cy = top ? CH - 0.06 : 0.06;
      if (!detail) { flat(box(0.186, 0.124, 0.166, sx * (hx - 0.089), cy, sz * (hz - 0.079)), 0.5); continue; }
      // The casting stands a few millimetres proud of the post, a lid with its aperture on each outward face.
      const lid = 0.012, cx = sx * (hx - 0.089 - lid / 2), cz = sz * (hz - 0.079 - lid / 2);
      flat(box(0.186 - lid, 0.124, 0.166 - lid, cx, cy, cz), 0.5);
      tinted(castingFace(0.186 - lid, 0.124, 0.082, 0.052, lid, 0.5).rotateY(sz > 0 ? 0 : Math.PI).translate(cx, cy, sz * (hz + 0.004 - lid)));
      tinted(castingFace(0.166 - lid, 0.124, 0.062, 0.074, lid, 0.5).rotateY(sx * Math.PI / 2).translate(sx * (hx + 0.004 - lid), cy, cz));
    }
  }
  for (const sz of [-1, 1]) {
    flat(box(L - 0.3, 0.16, 0.06, 0, 0.08, sz * (hz - 0.03)), 0.8);
    flat(box(L - 0.3, 0.1, 0.06, 0, CH - 0.05, sz * (hz - 0.03)), 0.9);
    if (detail) {
      // Forklift pockets on a 20 ft box, and the little labyrinth vents under the top rail.
      if (L < 8) for (const x of [-1.03, 1.03]) { flat(box(0.37, 0.105, 0.012, x, 0.075, sz * (hz + 0.002)), 0.05); flat(box(0.45, 0.02, 0.024, x, 0.14, sz * (hz + 0.004)), 0.62); }
      for (const x of [-hx + 0.5, hx - 0.5]) { flat(box(0.24, 0.085, 0.022, x, CH - 0.27, sz * (hz - 0.004)), 0.74); flat(box(0.2, 0.012, 0.03, x, CH - 0.25, sz * (hz - 0.002)), 0.4); flat(box(0.2, 0.012, 0.03, x, CH - 0.285, sz * (hz - 0.002)), 0.4); }
    }
  }
  // Blind end.
  if (!far) {
    flat(box(0.06, 0.16, CW - 0.3, -hx + 0.03, 0.08, 0), 0.8);
    flat(box(0.06, 0.12, CW - 0.3, -hx + 0.03, CH - 0.06, 0), 0.9);
  }
  // Door end: sill, header, two leaves with lock rods, cams, keepers, handles and hinge blades.
  flat(box(0.08, 0.16, CW - 0.3, hx - 0.04, 0.08, 0), 0.78);
  flat(box(0.08, 0.14, CW - 0.3, hx - 0.04, CH - 0.07, 0), 0.9);
  const leaf = (CW - 0.3) / 2 - 0.008, tall = CH - 0.31, mid = 0.165 + tall / 2;
  for (const sz of [-1, 1]) {
    const swing = open ? (sz > 0 ? 1.82 : 4.58) : 0;
    const hinge = new THREE.Matrix4().makeTranslation(hx - 0.04, 0, sz * (hz - 0.15)).multiply(new THREE.Matrix4().makeRotationY(-sz * swing));
    // `q` runs along the leaf from its hinge, `x` is out of the door.
    const on = (geometry: THREE.BufferGeometry, r = 1, g = r, b = r) => flat(geometry.applyMatrix4(hinge), r, g, b);
    on(box(0.05, tall, leaf, 0, mid, -sz * leaf / 2), 0.97);
    if (far) {
      for (const q of [0.25, 0.77]) on(box(0.03, CH - 0.26, 0.034, 0.03, CH / 2, -sz * q), 0.72);
      continue;
    }
    if (!detail) {
      for (const q of [0.25, 0.77]) {
        on(rod([0.036, 0.14, -sz * q], [0.036, CH - 0.12, -sz * q], 0.017), 0.72);
        for (const y of [0.2, CH - 0.19]) on(box(0.035, 0.07, 0.11, 0.032, y, -sz * q), 0.6);
        on(box(0.03, 0.035, 0.34, 0.044, 1.12, -sz * (q + 0.15)), 0.66);
      }
      for (const y of [0.42, 0.96, 1.5, 2.04]) on(box(0.03, 0.1, 0.11, 0.03, y, -sz * 0.01), 0.7);
      continue;
    }
    // Stiles and rails round the leaf, five pressed flutes across it, and the rubber gasket outside them all.
    for (const q of [0.062, leaf - 0.062]) on(box(0.012, tall - 0.05, 0.075, 0.031, mid, -sz * q), 1.0);
    for (const y of [0.165 + 0.062, 0.165 + tall - 0.062]) on(box(0.012, 0.075, leaf - 0.2, 0.031, y, -sz * leaf / 2), 1.0);
    for (let flute = 0; flute < 5; flute += 1) {
      const y = 0.165 + 0.32 + flute * (tall - 0.64) / 4;
      on(box(0.007, 0.15, leaf - 0.24, 0.0285, y, -sz * leaf / 2), 1.04);
      for (const edge of [-1, 1]) on(box(0.004, 0.03, leaf - 0.22, 0.027, y + edge * 0.09, -sz * leaf / 2), 0.9);
    }
    for (const q of [0.009, leaf - 0.009]) on(box(0.058, tall + 0.004, 0.022, 0, mid, -sz * q), 0.12);
    for (const y of [0.174, 0.165 + tall - 0.009]) on(box(0.058, 0.022, leaf - 0.04, 0, y, -sz * leaf / 2), 0.12);
    for (const q of [0.2, 0.68]) {
      // Lock rod standing off the door in four guides, a cam on each end turned into its keeper.
      on(rod([0.058, 0.078, -sz * q], [0.058, CH - 0.068, -sz * q], 0.017, 8), 0.74);
      for (const y of [0.25, 0.82, 1.84, CH - 0.25]) {
        on(box(0.052, 0.06, 0.03, 0.05, y, -sz * (q - 0.034)), 0.62); on(box(0.052, 0.06, 0.03, 0.05, y, -sz * (q + 0.034)), 0.62);
        on(box(0.012, 0.06, 0.098, 0.081, y, -sz * q), 0.62);
        on(cyl(0.011, 0.012, 0.09, y, -sz * (q - 0.034), "x", 6), 0.42); on(cyl(0.011, 0.012, 0.09, y, -sz * (q + 0.034), "x", 6), 0.42);
      }
      for (const [y, lobe] of [[0.11, -1], [CH - 0.095, 1]]) {
        on(box(0.07, 0.034, 0.05, 0.062, y, -sz * q), 0.5);
        on(box(0.03, 0.03, 0.1, 0.062, y + lobe * 0.004, -sz * (q + 0.02)), 0.5);
      }
      // Handle on its hub, lying in the retainer with the catch flap down over it.
      on(box(0.05, 0.085, 0.07, 0.062, 1.12, -sz * q), 0.56);
      on(box(0.012, 0.042, 0.4, 0.09, 1.12, -sz * (q + 0.18)), 0.68);
      on(box(0.02, 0.05, 0.1, 0.09, 1.12, -sz * (q + 0.325)), 0.16);
      on(box(0.05, 0.13, 0.08, 0.05, 1.125, -sz * (q + 0.22)), 0.52);
      on(box(0.012, 0.06, 0.05, 0.1, 1.165, -sz * (q + 0.22)), 0.6);
      on(cyl(0.009, 0.03, 0.09, 1.2, -sz * (q + 0.22), "x", 6), 0.4);
    }
    for (const y of [0.4, 0.94, 1.5, 2.06]) {
      // Hinge: blade welded across the stile, knuckle and pin on the post, and the lug the pin drops through.
      on(box(0.012, 0.075, 0.19, 0.043, y, -sz * 0.085), 0.72);
      on(cyl(0.02, 0.11, 0.052, y, sz * 0.012, "y", 8), 0.6);
      on(cyl(0.011, 0.15, 0.052, y, sz * 0.012, "y", 6), 0.36);
      for (const lug of [-0.07, 0.07]) on(box(0.032, 0.026, 0.056, 0.052, y + lug, sz * 0.032), 0.8);
    }
    if (sz < 0) {
      // Customs seal through the inner handle, and the backing strip the weight panel is painted on.
      on(box(0.022, 0.05, 0.03, 0.112, 1.07, -sz * 0.9), 2.2, 1.7, 0.2);
      on(cyl(0.004, 0.1, 0.11, 1.13, -sz * 0.9, "y", 5), 0.75);
    } else {
      // Data plate riveted low on the left leaf, and a placard holder above the handles.
      on(box(0.006, 0.36, 0.27, 0.036, 0.72, -sz * 0.44), 1.5, 1.5, 1.46);
      for (const dq of [-0.12, 0.12]) for (const dy of [-0.165, 0.165]) on(cyl(0.007, 0.004, 0.041, 0.72 + dy, -sz * (0.44 + dq), "x", 6), 0.6);
      const placard = new THREE.BoxGeometry(0.006, 0.27, 0.27);
      placard.rotateX(Math.PI / 4);
      placard.translate(0.036, 1.62, -sz * 0.44);
      on(placard, 1.25);
      for (const edge of [-1, 1]) on(box(0.012, 0.012, 0.3, 0.039, 1.62 + edge * 0.2, -sz * 0.44), 0.55);
    }
  }
  if (detail) {
    // Cam keepers welded to the sill and the header: two lugs either side of every cam.
    for (const sz of [-1, 1]) for (const q of [0.2, 0.68]) for (const y of [0.112, CH - 0.097]) for (const side of [-0.052, 0.052]) {
      flat(box(0.05, 0.062, 0.018, hx + 0.02, y, sz * (hz - 0.15 - q) + side), 0.55);
    }
  }
  return merge(parts);
}

/** Height of the lettering sheet: 2048 of white stencil work above a 512 band of plates and stickers in their own colours. */
const LIVERY_HIGH = 2560;
/** Cells of that band: data plate, weight warning strip, hazard diamond, approval sticker, electrical warning. */
const PLATES = {
  csc: [0, 2048, 384, 512], heavy: [400, 2048, 1024, 128], diamond: [400, 2192, 320, 320], approval: [736, 2192, 384, 192], overhead: [1136, 2192, 384, 256],
} satisfies Record<string, [number, number, number, number]>;

/**
 * Lettering for the boxes: six shipping lines, owner codes and weight panels in white, then the plates and stickers.
 * The quay's signwriters know one game by heart: every name, number and notice here is a nod to it, in their own hand.
 */
function liveryAtlas() {
  const names = ["ECO FREIGHT", "RUSH B LINES", "FULL BUY", "CACHE & CARRY", "OVERPASS", "GOLD NOVA LINE"];
  const strap = ["SAVING FOR NEXT ROUND", "GO GO GO", "LOGISTICS", "", "SHIPPING", ""];
  const codes = ["ECOU 000800 0", "RSBU 133764 1", "FBLU 016000 5", "CCHU 199916 8", "OVPU 004750 2", "GNLU 000661 3", "SMRU 000001 6", "GGWU 001999 9"];
  const random = rng(97);
  return canvasTexture(2048, LIVERY_HIGH, (context) => {
    context.clearRect(0, 0, 2048, LIVERY_HIGH);
    context.fillStyle = "#fff"; context.strokeStyle = "#fff";
    context.textBaseline = "middle"; context.lineJoin = "round";
    const sans = (weight: number | string, size: number) => { context.font = `${weight} ${size}px 'Helvetica Neue', Arial, sans-serif`; };
    names.forEach((name, row) => {
      const y = row * 256, cx = 132, cy = y + 128;
      context.lineWidth = 22;
      if (row === 0) {
        // A leaf: nothing bought, nothing wasted.
        context.beginPath(); context.moveTo(cx - 84, cy + 84); context.quadraticCurveTo(cx - 100, cy - 80, cx + 86, cy - 86); context.quadraticCurveTo(cx + 92, cy + 100, cx - 84, cy + 84); context.closePath(); context.stroke();
        context.beginPath(); context.moveTo(cx - 84, cy + 84); context.lineTo(cx + 26, cy - 26); context.stroke();
      } else if (row === 1) {
        // Three chevrons, all one way.
        for (let i = 0; i < 3; i += 1) { context.beginPath(); context.moveTo(cx - 96 + i * 62, cy - 86); context.lineTo(cx - 30 + i * 62, cy); context.lineTo(cx - 96 + i * 62, cy + 86); context.stroke(); }
      } else if (row === 2) {
        // Every bar full.
        for (let i = 0; i < 4; i += 1) context.fillRect(cx - 98 + i * 54, cy + 92 - (54 + i * 42), 34, 54 + i * 42);
      } else if (row === 3) {
        // A crate.
        context.strokeRect(cx - 86, cy - 86, 172, 172);
        context.beginPath(); context.moveTo(cx, cy - 60); context.lineTo(cx + 60, cy); context.lineTo(cx, cy + 60); context.lineTo(cx - 60, cy); context.closePath(); context.fill();
      } else if (row === 4) {
        // A viaduct.
        context.fillRect(cx - 104, cy - 44, 208, 22);
        for (const side of [-1, 1]) { context.beginPath(); context.arc(cx + side * 52, cy + 88, 42, Math.PI, 0); context.stroke(); }
        for (const x of [-104, -11, 82]) context.fillRect(cx + x, cy - 44, 22, 136);
      } else {
        // A four-pointed star.
        context.beginPath();
        for (let i = 0; i < 8; i += 1) { const r = i % 2 ? 28 : 104, a = i * Math.PI / 4 - Math.PI / 2; context.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
        context.closePath(); context.fill();
      }
      const style = row === 1 || row === 5 ? "italic 800" : row === 4 ? "300" : "700";
      sans(style, strap[row] ? 150 : 178);
      context.textAlign = "left";
      context.fillText(name, 290, cy + (strap[row] ? -26 : 6), 1700);
      if (strap[row]) {
        sans(500, 62);
        context.fillText(strap[row].split("").join("  "), 296, cy + 84, 1700);
      }
    });
    codes.forEach((code, index) => {
      const x = (index % 4) * 512, y = 1536 + Math.floor(index / 4) * 128;
      // Set out round a door's lock rods: the owner inboard of the first rod, serial and boxed check digit between the two.
      const [owner, serial, check] = code.split(" ");
      sans(700, 56);
      context.textAlign = "right"; context.fillText(owner, x + 156, y + 42, 146);
      context.textAlign = "left"; context.fillText(serial, x + 204, y + 42, 196);
      context.textAlign = "center"; context.fillText(check, x + 432, y + 42, 34);
      context.lineWidth = 5; context.strokeStyle = "#fff"; context.strokeRect(x + 409, y + 11, 46, 60);
      sans(600, 42);
      context.textAlign = "left"; context.fillText(index % 2 ? "22G1" : "45G1", x + 204, y + 102, 196);
    });
    for (let cell = 0; cell < 4; cell += 1) {
      const x = cell * 512, y = 1792;
      context.textAlign = "left";
      sans(600, 34);
      // The weight panel reads like a round's accounts: the cap, the start, and what a buy leaves.
      const lines = [
        [["MAX. GROSS", "$16000"], ["TARE", "$800"], ["NET", "$15200"], ["LOSS BONUS", "$3400"]],
        [["AWP", "$4750"], ["VEST + HELMET", "$1000"], ["KIT", "$400"], ["CHANGE", "$9850"]],
        [["MAX. GROSS", "$16000"], ["TARE", "$800"], ["NET", "$15200"], ["CU. CAP.", "10 000 CASES"]],
        [["AK", "$2700"], ["VEST + HELMET", "$1000"], ["FLASH", "$200"], ["MOLOTOV", "$400"]],
      ][cell];
      lines.forEach(([label, value], line) => {
        // Labels inboard of the first lock rod, figures between the two.
        sans(600, 24); context.textAlign = "left"; context.fillText(label, x + 8, y + 42 + line * 56, 150);
        sans(700, 34); context.textAlign = "right"; context.fillText(value, x + 452, y + 42 + line * 56, 250);
      });
    }
    // Paint thins on the rib flanks of the big names and chips everywhere; the small stencils only lose flecks.
    context.globalCompositeOperation = "destination-out";
    for (let x = 0; x < 2048; x += 73.1) { context.fillStyle = "rgba(0,0,0,.3)"; context.fillRect(x, 0, 9, 1536); context.fillRect(x + 36, 0, 9, 1536); }
    for (let i = 0; i < 4200; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.3 + random() * 0.7})`;
      context.fillRect(random() * 2048, random() * 1536, 1 + random() * 5, 1 + random() * (random() < 0.2 ? 22 : 4));
    }
    for (let i = 0; i < 1500; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.2 + random() * 0.5})`;
      context.fillRect(random() * 2048, 1536 + random() * 512, 1 + random() * 2.2, 1 + random() * 3);
    }
    context.globalCompositeOperation = "source-over";

    // ---- Plates and stickers -------------------------------------------------
    {
      // Consolidated data plate: stamped aluminium, approval references, test loads.
      const [x, y, w, h] = PLATES.csc;
      const metal = context.createLinearGradient(x, y, x + w, y + h);
      metal.addColorStop(0, "#c9c8c0"); metal.addColorStop(0.45, "#b3b2aa"); metal.addColorStop(1, "#c2c1b8");
      context.fillStyle = metal; context.fillRect(x, y, w, h);
      context.strokeStyle = "#23221f"; context.lineWidth = 3; context.strokeRect(x + 12, y + 12, w - 24, h - 24);
      context.fillStyle = "#1c1b19"; context.textAlign = "center";
      sans(800, 25); context.fillText("CASE SAFETY APPROVAL", x + w / 2, y + 40, w - 44);
      sans(600, 17); context.fillText("PM / B-2 / 1337 / 99", x + w / 2, y + 68, w - 44);
      context.fillRect(x + 22, y + 84, w - 44, 2);
      const rows = [
        ["DATE MANUFACTURED", "06 / 1999"], ["IDENTIFICATION NO.", "RSBU 133764"], ["MAXIMUM GROSS", "16 000 KG   $16000"],
        ["CONTENTS: BLUE", "79.92 %"], ["PURPLE · PINK · RED", "15.98 · 3.20 · 0.64 %"], ["GOLD (A KNIFE)", "0.26 %"], ["NEXT EXAMINATION", "AFTER THE ROUND"],
      ];
      rows.forEach(([label, value], row) => {
        const ry = y + 104 + row * 31;
        sans(500, 13); context.textAlign = "left"; context.fillText(label, x + 24, ry, 170);
        sans(700, 15); context.textAlign = "right"; context.fillText(value, x + w - 24, ry, 170);
        context.fillRect(x + 22, ry + 14, w - 44, 1);
      });
      context.fillRect(x + 22, y + 330, w - 44, 2);
      context.textAlign = "center";
      sans(700, 15); context.fillText("KEY NOT INCLUDED  ·  SOLD SEPARATELY", x + w / 2, y + 352, w - 48);
      sans(500, 14); context.fillText("ONE KEY OPENS ONE CASE   ·   TYPE 1AA-B-64", x + w / 2, y + 374, w - 48);
      context.fillRect(x + 22, y + 392, w - 44, 2);
      sans(700, 15); context.fillText("7-DAY TRADE HOLD AFTER DISCHARGE", x + w / 2, y + 414, w - 48);
      sans(500, 14); context.fillText("HELD AT PORT MIRAGE CUSTOMS", x + w / 2, y + 436, w - 48);
      sans(600, 13); context.fillText("RUSH B CONTAINER WORKS  ·  PORT MIRAGE", x + w / 2, y + 476, w - 48);
      // Stamped figures catch the light on one edge; the plate has been knocked about.
      for (let i = 0; i < 260; i += 1) { context.fillStyle = `rgba(${random() < 0.5 ? "255,255,255" : "40,36,30"},${random() * 0.18})`; context.fillRect(x + random() * w, y + random() * h, 1 + random() * 26, 1 + random() * 2); }
    }
    {
      // Weight warning strip.
      const [x, y, w, h] = PLATES.heavy;
      context.fillStyle = "#d9a51f"; context.fillRect(x, y, w, h);
      context.fillStyle = "#15120e";
      // Hazard stripes run under both lock rods; the two legends sit in the clear panels between and inboard of them.
      for (const [side, wide] of [[x, 212], [x + 656, 118]]) {
        context.save(); context.beginPath(); context.rect(side, y, wide, h); context.clip();
        for (let stripe = -3; stripe < 6; stripe += 1) { context.beginPath(); context.moveTo(side + stripe * 56, y + h); context.lineTo(side + stripe * 56 + 28, y + h); context.lineTo(side + stripe * 56 + 28 + h, y); context.lineTo(side + stripe * 56 + h, y); context.closePath(); context.fill(); }
        context.restore();
      }
      context.textAlign = "center"; sans(800, 76); context.fillText("SUPER HEAVY", x + 434, y + h / 2 + 4, 410);
      sans(800, 46); context.fillText("10 000", x + 896, y + 38, 216); context.fillText("CASES", x + 896, y + 92, 216);
    }
    {
      // Explosives diamond, and of every division there is the signwriter chose 1.6.
      const [x, y, w, h] = PLATES.diamond, cx = x + w / 2, cy = y + h / 2, r = w / 2 - 4;
      context.beginPath(); context.moveTo(cx, cy - r); context.lineTo(cx + r, cy); context.lineTo(cx, cy + r); context.lineTo(cx - r, cy); context.closePath();
      context.fillStyle = "#e07a1f"; context.fill();
      context.strokeStyle = "#15120e"; context.lineWidth = 7;
      context.beginPath(); context.moveTo(cx, cy - r + 10); context.lineTo(cx + r - 10, cy); context.lineTo(cx, cy + r - 10); context.lineTo(cx - r + 10, cy); context.closePath(); context.stroke();
      context.fillStyle = "#15120e"; context.textAlign = "center";
      sans(800, 112); context.fillText("1.6", cx, cy - 14);
      sans(700, 44); context.fillText("N", cx, cy + 62);
      sans(700, 34); context.fillText("1", cx, cy + r * 0.74);
    }
    {
      const [x, y, w, h] = PLATES.approval;
      context.fillStyle = "#1d6b3c"; context.fillRect(x, y, w, h);
      context.strokeStyle = "#e9e6dc"; context.lineWidth = 5; context.strokeRect(x + 10, y + 10, w - 20, h - 20);
      context.fillStyle = "#e9e6dc"; context.textAlign = "center";
      sans(800, 54); context.fillText("APPROVED", x + w / 2, y + 60, w - 40);
      context.font = "700 38px 'Menlo', 'Consolas', monospace"; context.fillText("sv_cheats 0", x + w / 2, y + 116, w - 40);
      sans(500, 22); context.fillText("CONTINUOUS EXAMINATION PROGRAMME", x + w / 2, y + 158, w - 40);
    }
    {
      const [x, y, w, h] = PLATES.overhead;
      context.fillStyle = "#d9a51f"; context.fillRect(x, y, w, h);
      context.strokeStyle = "#15120e"; context.lineWidth = 6; context.strokeRect(x + 8, y + 8, w - 16, h - 16);
      context.fillStyle = "#15120e";
      context.beginPath(); context.moveTo(x + 92, y + 34); context.lineTo(x + 50, y + 122); context.lineTo(x + 86, y + 122); context.lineTo(x + 58, y + 206); context.lineTo(x + 138, y + 96); context.lineTo(x + 100, y + 96); context.lineTo(x + 126, y + 34); context.closePath(); context.fill();
      context.textAlign = "center";
      sans(800, 50); context.fillText("WARNING", x + 258, y + 70, 220);
      sans(700, 30); context.fillText("FLASH INSIDE", x + 258, y + 124, 220); context.fillText("LOOK AWAY", x + 258, y + 160, 220); context.fillText("WHEN OPENING", x + 258, y + 196, 220);
    }
    // Stickers scuff and peel at the corners.
    context.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 420; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.15 + random() * 0.5})`;
      context.fillRect(400 + random() * 1140, 2048 + random() * 512, 1 + random() * 3, 1 + random() * 3);
    }
    context.globalCompositeOperation = "source-over";
  });
}

/** Ship's side, 28 m of it: welded strakes dished between frames, dark topsides over red boot-topping, scupper stains and fender scuffs. */
function hullTextures() {
  const random = rng(53);
  return reliefTextures(2048, 1024, (context) => {
    context.fillStyle = "#18212e"; context.fillRect(0, 0, 2048, 1024);
    // Deck paint on the top strip, boot-topping below the white cut line.
    context.fillStyle = "#3a1c1a"; context.fillRect(0, 0, 2048, 42);
    context.fillStyle = "#5a1e19"; context.fillRect(0, 776, 2048, 248);
    context.fillStyle = "#b9b4a6"; context.fillRect(0, 768, 2048, 9);
    // Every plate took the paint a little differently.
    for (let row = 0; row < 6; row += 1) for (let x = (row % 2) * 256; x < 2048 + 512; x += 512) {
      const tone = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${tone},${tone},${tone},${0.015 + random() * 0.045})`;
      context.fillRect(x - 512, 42 + row * 164, 512, 164);
    }
    context.strokeStyle = "rgba(0,0,0,.42)"; context.lineWidth = 2;
    for (let row = 0; row <= 6; row += 1) { const y = 42 + row * 164; context.beginPath(); context.moveTo(0, y); context.lineTo(2048, y); context.stroke(); }
    for (let row = 0; row < 6; row += 1) for (let x = (row % 2) * 256; x < 2048; x += 512) { context.beginPath(); context.moveTo(x, 42 + row * 164); context.lineTo(x, 206 + row * 164); context.stroke(); }
    context.strokeStyle = "rgba(255,255,255,.07)"; context.lineWidth = 1;
    for (let row = 0; row <= 6; row += 1) { const y = 45 + row * 164; context.beginPath(); context.moveTo(0, y); context.lineTo(2048, y); context.stroke(); }
    // Scuppers every 7 m weep rust down the topsides; lesser runs start at the sheer.
    for (let scupper = 0; scupper < 4; scupper += 1) for (let i = 0; i < 9; i += 1) {
      const x = scupper * 512 + (random() - 0.5) * 34, length = 180 + random() * 520, width = 2 + random() * 9;
      const run = context.createLinearGradient(0, 60, 0, 60 + length);
      run.addColorStop(0, `rgba(134,66,26,${0.3 + random() * 0.4})`); run.addColorStop(1, "rgba(134,66,26,0)");
      context.fillStyle = run; context.fillRect(x - width / 2, 60, width, length);
    }
    for (let i = 0; i < 90; i += 1) {
      const x = random() * 2048, top = 44 + random() * 500, length = 50 + random() * 330, width = 1 + random() * 4;
      const run = context.createLinearGradient(0, top, 0, top + length);
      run.addColorStop(0, `rgba(120,58,24,${0.12 + random() * 0.24})`); run.addColorStop(1, "rgba(120,58,24,0)");
      context.fillStyle = run; context.fillRect(x, top, width, length);
    }
    // Where fenders and tugs have rubbed the paint to primer.
    for (let i = 0; i < 150; i += 1) {
      const y = 600 + random() * 250;
      context.fillStyle = random() < 0.6 ? `rgba(150,146,136,${0.05 + random() * 0.14})` : `rgba(8,8,10,${0.1 + random() * 0.2})`;
      context.fillRect(random() * 2048, y, 30 + random() * 260, 1 + random() * 4);
    }
    // Salt bloom above the boot-topping, weed along the waterline.
    for (let i = 0; i < 70; i += 1) {
      const x = random() * 2048, r = 30 + random() * 100;
      const blot = context.createRadialGradient(x, 790, 0, x, 790, r);
      blot.addColorStop(0, "rgba(160,160,140,.2)"); blot.addColorStop(1, "rgba(160,160,140,0)");
      context.fillStyle = blot; context.fillRect(x - r, 790 - r, r * 2, r * 2);
    }
    const weed = context.createLinearGradient(0, 950, 0, 1024);
    weed.addColorStop(0, "rgba(36,48,28,0)"); weed.addColorStop(1, "rgba(36,48,28,.85)");
    context.fillStyle = weed; context.fillRect(0, 950, 2048, 74);
    for (let i = 0; i < 16000; i += 1) {
      const tone = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${tone},${tone},${tone},.035)`;
      context.fillRect(random() * 2048, random() * 1024, 2, 1 + random() * 7);
    }
  }, (context) => {
    // Plating pulled in between frames 0.875 m apart, weld beads standing proud.
    for (let frame = 0; frame < 32; frame += 1) {
      const across = context.createLinearGradient(frame * 64, 0, frame * 64 + 64, 0);
      across.addColorStop(0, "#777"); across.addColorStop(0.5, "#3c3c3c"); across.addColorStop(1, "#777");
      context.fillStyle = across; context.fillRect(frame * 64, 42, 64, 982);
    }
    context.fillStyle = "#777"; context.fillRect(0, 0, 2048, 42);
    context.strokeStyle = "#fff"; context.lineWidth = 5;
    for (let row = 0; row <= 6; row += 1) { const y = 42 + row * 164; context.beginPath(); context.moveTo(0, y); context.lineTo(2048, y); context.stroke(); }
    for (let row = 0; row < 6; row += 1) for (let x = (row % 2) * 256; x < 2048; x += 512) { context.beginPath(); context.moveTo(x, 42 + row * 164); context.lineTo(x, 206 + row * 164); context.stroke(); }
  }, 2.6);
}

/** White paint for the ship: her name and port, draught marks, load line and the notices on the house. */
function shipMarks() {
  const random = rng(1451);
  return canvasTexture(2048, 1024, (context) => {
    context.clearRect(0, 0, 2048, 1024);
    context.fillStyle = "#fff"; context.strokeStyle = "#fff"; context.textBaseline = "middle"; context.textAlign = "center";
    context.font = "700 230px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("DOOR STUCK", 1024, 150, 2000);
    context.font = "600 150px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("PORT MIRAGE", 600, 400, 1150);
    context.font = "600 96px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("IMO 1337128", 480, 570, 900);
    context.font = "700 170px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("SMOKE MID", 660, 760, 1280);
    context.font = "700 120px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("CHECK CORNERS", 520, 940, 1000);
    // Draught marks in decimetres, 10 cm figures 10 cm apart.
    context.font = "700 62px 'Helvetica Neue', Arial, sans-serif";
    for (let i = 0; i < 9; i += 1) {
      context.fillText(i % 5 === 0 ? `${12 - i / 5}M` : `${(10 - (i % 5) * 2)}`, 1500, 345 + i * 80, 150);
      context.fillRect(1580, 340 + i * 80, 34, 8);
    }
    // Load line disc and its ladder of marks.
    context.lineWidth = 14;
    context.beginPath(); context.arc(1830, 440, 92, 0, Math.PI * 2); context.stroke();
    context.fillRect(1700, 433, 260, 14);
    context.fillRect(1960, 330, 12, 260);
    for (const [y, w] of [[330, 70], [390, 50], [440, 70], [500, 50], [578, 70]]) context.fillRect(1972, y, w, 12);
    context.font = "700 46px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("G", 1724, 374); context.fillText("G", 1936, 374);
    // Tug push point and a bulbous bow / thruster warning.
    context.strokeRect(1700, 660, 250, 250);
    context.font = "700 96px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("PUSH", 1825, 790, 220);
    context.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 4200; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.25 + random() * 0.6})`;
      context.fillRect(random() * 2048, random() * 1024, 1 + random() * 6, 1 + random() * (random() < 0.25 ? 26 : 5));
    }
    context.globalCompositeOperation = "source-over";
  });
}

/** Plain painted house plating: deck seams and rust runs; the windows are modelled. */
function houseTexture() {
  const random = rng(1907);
  return canvasTexture(1024, 1024, (context) => {
    context.fillStyle = "#cfcabb"; context.fillRect(0, 0, 1024, 1024);
    for (let deck = 0; deck < 5; deck += 1) {
      context.fillStyle = "rgba(40,36,30,.5)"; context.fillRect(0, deck * 204 + 196, 1024, 8);
      context.fillStyle = "rgba(255,255,255,.12)"; context.fillRect(0, deck * 204, 1024, 6);
    }
    context.strokeStyle = "rgba(60,54,44,.22)"; context.lineWidth = 1.5;
    for (let x = 0; x < 1024; x += 128) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 1024); context.stroke(); }
    for (let i = 0; i < 110; i += 1) {
      const x = random() * 1024, top = Math.floor(random() * 5) * 204 + 8, length = 40 + random() * 170;
      const run = context.createLinearGradient(0, top, 0, top + length);
      run.addColorStop(0, `rgba(120,66,30,${0.2 + random() * 0.3})`); run.addColorStop(1, "rgba(120,66,30,0)");
      context.fillStyle = run; context.fillRect(x, top, 2 + random() * 6, length);
    }
    for (let i = 0; i < 6000; i += 1) {
      const tone = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${tone},${tone},${tone},.03)`;
      context.fillRect(random() * 1024, random() * 1024, 2, 1 + random() * 6);
    }
  }, true);
}

/** Ground paint for the apron: a hatched keep-clear box, bay numbers and a direction arrow. */
function apronPaint() {
  const random = rng(641);
  return canvasTexture(1024, 1024, (context) => {
    context.clearRect(0, 0, 1024, 1024);
    context.strokeStyle = "#d9a51f"; context.fillStyle = "#d9a51f";
    // Hatched box, 512 square.
    context.lineWidth = 16; context.strokeRect(12, 12, 488, 488);
    context.save(); context.beginPath(); context.rect(20, 20, 472, 472); context.clip();
    context.lineWidth = 13;
    for (let offset = -512; offset < 512; offset += 62) { context.beginPath(); context.moveTo(offset, 512); context.lineTo(offset + 512, 0); context.stroke(); }
    context.restore();
    // Bay numbers.
    context.fillStyle = "#dedbd0";
    context.font = "700 190px 'Helvetica Neue', Arial, sans-serif"; context.textBaseline = "middle"; context.textAlign = "center";
    context.fillText("MR·12", 768, 128, 480);
    context.fillText("OT·01", 768, 384, 480);
    // Two half cells, so the words can be laid as two lines where the apron is clear.
    context.font = "700 172px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("PLANT", 256, 640, 470); context.fillText("HERE", 768, 640, 400);
    // Arrow.
    context.beginPath(); context.moveTo(60, 900); context.lineTo(360, 900); context.lineTo(360, 850); context.lineTo(480, 920); context.lineTo(360, 990); context.lineTo(360, 940); context.lineTo(60, 940); context.closePath(); context.fill();
    context.fillStyle = "#d9a51f";
    context.font = "700 110px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("NO CAMPING", 768, 920, 480);
    // Tyres and weather take the paint off.
    context.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 9000; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.25 + random() * 0.75})`;
      context.fillRect(random() * 1024, random() * 1024, 1 + random() * 7, 1 + random() * 7);
    }
    for (let i = 0; i < 26; i += 1) { context.fillStyle = "rgba(0,0,0,.4)"; context.fillRect(0, random() * 1024, 1024, 4 + random() * 14); }
    context.globalCompositeOperation = "source-over";
  });
}

/** Every sign and notice on the quay, on one sheet, lettered by people who never quite left the server. */
function signAtlas() {
  const random = rng(2203);
  return canvasTexture(2048, 2048, (context) => {
    context.clearRect(0, 0, 2048, 2048);
    context.textAlign = "center"; context.textBaseline = "middle";
    const font = (weight: number, size: number) => { context.font = `${weight} ${size}px 'Helvetica Neue', Arial, sans-serif`; };
    const board = (x: number, y: number, w: number, h: number, fill: string, edge: string) => {
      context.fillStyle = fill; context.fillRect(x, y, w, h);
      context.strokeStyle = edge; context.lineWidth = 10; context.strokeRect(x + 14, y + 14, w - 28, h - 28);
      context.fillStyle = edge;
      for (const [bx, by] of [[x + 34, y + 34], [x + w - 34, y + 34], [x + 34, y + h - 34], [x + w - 34, y + h - 34]]) { context.beginPath(); context.arc(bx, by, 7, 0, Math.PI * 2); context.fill(); }
    };
    /** A block arrow with its point at (x + way * size, y). */
    const arrow = (x: number, y: number, size: number, way: number) => {
      context.beginPath(); context.moveTo(x - way * size, y - size * 0.24); context.lineTo(x, y - size * 0.24); context.lineTo(x, y - size * 0.62); context.lineTo(x + way * size, y);
      context.lineTo(x, y + size * 0.62); context.lineTo(x, y + size * 0.24); context.lineTo(x - way * size, y + size * 0.24); context.closePath(); context.fill();
    };
    // 0: the customs gate.
    board(0, 0, 1024, 256, "#10243a", "#d8d4c4");
    font(700, 104); context.fillText("CUSTOMS", 300, 104, 440);
    font(500, 44); context.fillText("GATE B · PORT MIRAGE", 300, 190, 440);
    context.fillRect(540, 50, 6, 156);
    font(500, 38); context.fillText("DECLARE ALL GRENADES", 780, 92, 420); context.fillText("LIMIT 4 · TWO MAY BE FLASH", 780, 148, 420);
    font(400, 30); context.fillText("DROPPED RIFLES ARE PORT PROPERTY", 780, 200, 420);
    // 1: reefer point.
    board(1024, 0, 1024, 256, "#d9a51f", "#15120e");
    font(800, 96); context.fillText("FREEZE TIME", 1536, 100, 920);
    font(600, 46); context.fillText("REEFERS ONLY · 15 SECONDS · NOBODY MOVES", 1536, 190, 920);
    // 2: speed limit: as fast as anyone runs, and only with the knife out.
    context.fillStyle = "#e6e2d6"; context.beginPath(); context.arc(256, 512, 240, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "#b3241c"; context.lineWidth = 46; context.beginPath(); context.arc(256, 512, 208, 0, Math.PI * 2); context.stroke();
    context.fillStyle = "#15120e"; font(800, 180); context.fillText("250", 256, 500);
    font(700, 44); context.fillText("KNIFE OUT", 256, 626, 250);
    // 3: armour mandatory: helmet over vest, and what the pair costs.
    context.fillStyle = "#1b4f9c"; context.beginPath(); context.arc(768, 512, 240, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#e6e2d6";
    context.beginPath(); context.arc(768, 388, 64, Math.PI, 0); context.fill(); context.fillRect(690, 388, 156, 14);
    context.beginPath(); context.moveTo(672, 446); context.lineTo(730, 420); context.lineTo(768, 462); context.lineTo(806, 420); context.lineTo(864, 446); context.lineTo(846, 640); context.lineTo(690, 640); context.closePath(); context.fill();
    context.fillStyle = "#1b4f9c"; context.fillRect(692, 520, 152, 20); context.fillRect(692, 574, 152, 20);
    context.fillStyle = "#e6e2d6"; font(800, 60); context.fillText("$1000", 768, 694, 240);
    // 4: fire point.
    board(1024, 256, 1024, 512, "#a8201a", "#eee9dc");
    font(800, 150); context.fillText("FIRE POINT", 1640, 396, 700);
    font(700, 64); context.fillText("IT BURNS FOR 7 SECONDS", 1640, 520, 700); context.fillText("DO NOT RUN THROUGH IT", 1640, 596, 700);
    font(500, 40); context.fillText("HOSE REEL · FOAM · PATIENCE", 1640, 684, 700);
    context.fillRect(1130, 380, 110, 280); context.fillRect(1160, 330, 50, 60); context.fillRect(1205, 345, 70, 18);
    // 5: berth board.
    board(0, 768, 1024, 384, "#10243a", "#d8d4c4");
    font(700, 160); context.fillText("QUAY B", 512, 884, 920);
    font(500, 54); context.fillText("MV DOOR STUCK · ETD 01:55 · DELAYED", 512, 1010, 920);
    font(400, 38); context.fillText("REASON: DOOR · GANGWAY WATCH ON DECK · NO BOARDING", 512, 1084, 920);
    // 6: livestock on the quay: a hen in silhouette, mid-stride.
    board(1024, 768, 1024, 384, "#d9a51f", "#15120e");
    font(800, 112); context.fillText("CAUTION", 1660, 862, 680);
    font(800, 78); context.fillText("CHICKENS CROSSING", 1660, 968, 680);
    font(600, 38); context.fillText("THEY HAVE RIGHT OF WAY · DO NOT ADOPT", 1660, 1066, 680);
    {
      const hx = 1182, hy = 950;
      context.beginPath(); context.ellipse(hx, hy, 78, 56, -0.15, 0, Math.PI * 2); context.fill();
      context.beginPath(); context.moveTo(hx + 36, hy - 16); context.lineTo(hx + 54, hy - 84); context.lineTo(hx + 98, hy - 44); context.closePath(); context.fill();
      context.beginPath(); context.arc(hx + 74, hy - 68, 30, 0, Math.PI * 2); context.fill();
      context.beginPath(); context.moveTo(hx + 98, hy - 78); context.lineTo(hx + 134, hy - 64); context.lineTo(hx + 98, hy - 52); context.closePath(); context.fill();
      for (let i = 0; i < 3; i += 1) { context.beginPath(); context.arc(hx + 58 + i * 15, hy - 98, 11, 0, Math.PI * 2); context.fill(); }
      context.beginPath(); context.moveTo(hx - 52, hy - 34); context.lineTo(hx - 120, hy - 86); context.lineTo(hx - 100, hy - 6); context.closePath(); context.fill();
      context.lineWidth = 9; context.lineJoin = "round";
      for (const [foot, stride] of [[-16, -28], [22, 30]]) { context.beginPath(); context.moveTo(hx + foot, hy + 44); context.lineTo(hx + foot + stride, hy + 110); context.lineTo(hx + foot + stride + 24, hy + 110); context.stroke(); }
    }
    // 7: notice board.
    context.fillStyle = "#6b5234"; context.fillRect(0, 1152, 1024, 512);
    context.fillStyle = "#8a6f48"; context.fillRect(22, 1174, 980, 468);
    const notices = [
      ["FOUND: 1 LURKER", "behind the reefers", "since Tuesday"], ["WANTED: A FIFTH", "night shift stack", "mic required"], ["TIDES", "HW 01:55", "LW 00:40"], ["FOR SALE: SCOUT", "one owner, jumps well", "$1700, no offers"],
      ["OVERTIME ROTA", "MR3, first to 4", "no draws on Quay B"], ["NOTICE 13/37", "smurfing on the", "silver shift is rude"], ["CANTEEN", "no chicken served:", "they are colleagues"], ["TOOLBOX TALK", "crosshair placement:", "head height, always"],
    ];
    notices.forEach(([heading, ...lines], i) => {
      const w = 204 + random() * 18, h = 176 + random() * 26, x = 34 + (i % 4) * 240 + random() * 14, y = 1186 + Math.floor(i / 4) * 226 + random() * 14;
      context.save(); context.translate(x + w / 2, y + h / 2); context.rotate((random() - 0.5) * 0.07);
      context.fillStyle = ["#e9e5d8", "#f0e6a8", "#d8e4ea", "#f1d2c0"][(i * 3) % 4]; context.fillRect(-w / 2, -h / 2, w, h);
      context.fillStyle = "#2a2a2a"; font(700, 25); context.fillText(heading, 0, -h / 2 + 32, w - 20);
      font(500, 19); lines.forEach((line, row) => context.fillText(line, 0, -h / 2 + 64 + row * 24, w - 20));
      context.fillStyle = "rgba(40,40,40,.5)";
      for (let line = 0; line < (h - 128) / 14; line += 1) context.fillRect(-w / 2 + 14, -h / 2 + 112 + line * 14, (w - 28) * (0.5 + random() * 0.5), 4);
      context.fillStyle = "#b3241c"; context.beginPath(); context.arc(0, -h / 2 + 9, 6, 0, Math.PI * 2); context.fill();
      context.restore();
    });
    // 8: the way to the rail sidings and back to the quay.
    board(1024, 1152, 1024, 512, "#1b3f6e", "#e6e2d6");
    arrow(1172, 1290, 72, -1);
    font(800, 124); context.fillText("TRAIN YARD", 1620, 1296, 700);
    font(600, 50); context.fillText("IVY GATE · OLD BOMB SIDING · SHOWERS", 1536, 1420, 900);
    context.fillRect(1096, 1474, 880, 5);
    font(700, 96); context.fillText("QUAY B · PLANT", 1470, 1566, 700);
    arrow(1890, 1562, 58, 1);
    // 9: muster point.
    board(0, 1664, 1024, 384, "#1d6b3c", "#eee9dc");
    font(800, 130); context.fillText("MUSTER POINT B", 600, 1800, 780);
    font(500, 56); context.fillText("STICK TOGETHER, TEAM", 600, 1930, 780);
    arrow(150, 1856, 88, -1);
    // 10: electrical hazard. 11: no smoking.
    context.fillStyle = "#d9a51f"; context.beginPath(); context.moveTo(1280, 1690); context.lineTo(1500, 2020); context.lineTo(1060, 2020); context.closePath(); context.fill();
    context.strokeStyle = "#15120e"; context.lineWidth = 22; context.lineJoin = "round"; context.stroke();
    context.fillStyle = "#15120e"; context.beginPath(); context.moveTo(1300, 1800); context.lineTo(1240, 1900); context.lineTo(1290, 1900); context.lineTo(1250, 1990); context.lineTo(1340, 1870); context.lineTo(1290, 1870); context.closePath(); context.fill();
    context.fillStyle = "#e6e2d6"; context.beginPath(); context.arc(1792, 1856, 170, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#15120e"; context.fillRect(1700, 1838, 170, 34); context.fillRect(1878, 1838, 12, 34);
    context.strokeStyle = "#b3241c"; context.lineWidth = 34; context.beginPath(); context.arc(1792, 1856, 150, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(1686, 1750); context.lineTo(1898, 1962); context.stroke();
    // Weather.
    context.globalCompositeOperation = "source-atop";
    for (let i = 0; i < 2600; i += 1) {
      context.fillStyle = random() < 0.5 ? `rgba(30,24,18,${random() * 0.2})` : `rgba(255,255,255,${random() * 0.08})`;
      context.fillRect(random() * 2048, random() * 2048, 2 + random() * 10, 2 + random() * (random() < 0.3 ? 60 : 8));
    }
    context.globalCompositeOperation = "source-over";
  });
}

/** Ground decals: four puddles across the top, tyre tracks and an oil stain below. Colour is what shows through the alpha. */
function groundDecals() {
  const random = rng(977);
  return canvasTexture(1024, 1024, (context) => {
    context.clearRect(0, 0, 1024, 1024);
    for (let cell = 0; cell < 4; cell += 1) {
      const cx = (cell % 2) * 512 + 256, cy = Math.floor(cell / 2) * 256 + 128;
      context.fillStyle = "#fff";
      context.beginPath();
      for (let i = 0; i <= 40; i += 1) {
        const a = i / 40 * Math.PI * 2, r = 0.62 + 0.2 * Math.sin(a * 2 + cell) + 0.12 * Math.sin(a * 5 + cell * 2.1) + 0.06 * Math.sin(a * 9 + cell);
        const x = cx + Math.cos(a) * r * 235, y = cy + Math.sin(a) * r * 112;
        if (i) context.lineTo(x, y); else context.moveTo(x, y);
      }
      context.closePath();
      context.filter = "blur(7px)"; context.fill(); context.filter = "none";
    }
    // Tyre tracks: two tread bands, 512 px long.
    for (let track = 0; track < 2; track += 1) {
      const x0 = track * 512, y0 = 560;
      for (const band of [20, 190]) for (let i = 0; i < 1600; i += 1) {
        const x = x0 + 10 + random() * 492, y = y0 + band + random() * 90;
        context.fillStyle = `rgba(255,255,255,${0.1 + random() * 0.4 * Math.sin((x - x0) / 512 * Math.PI)})`;
        context.fillRect(x, y, 6 + random() * 22, 3 + random() * 5);
      }
    }
    // Oil stain.
    for (let i = 0; i < 26; i += 1) {
      const x = 256 + (random() - 0.5) * 260, y = 900 + (random() - 0.5) * 120, r = 20 + random() * 80;
      const blot = context.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, "rgba(255,255,255,.5)"); blot.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = blot; context.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

/** Traffic cone, orange with a reflective collar, coloured through its vertices. */
function coneGeometry() {
  const profile = [[0.19, 0], [0.19, 0.035], [0.13, 0.05], [0.1, 0.2], [0.075, 0.36], [0.055, 0.5], [0.03, 0.68], [0.02, 0.7], [0, 0.7]].map(([x, y]) => new THREE.Vector2(x, y));
  const geometry = new THREE.LatheGeometry(profile, 14).toNonIndexed();
  const position = geometry.attributes.position, colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 3) {
    const y = (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3;
    const band = y > 0.26 && y < 0.44, foot = y < 0.045;
    const tone = band ? [0.82, 0.82, 0.8] : foot ? [0.03, 0.03, 0.03] : [0.86, 0.17, 0.02];
    for (let v = 0; v < 3; v += 1) colours.set(tone, (i + v) * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return geometry;
}

/** Cable reel, axis on Y, standing on one flange. */
function reelGeometry() {
  const profile = [[0.1, 0], [0.62, 0], [0.62, 0.06], [0.3, 0.06], [0.3, 0.74], [0.62, 0.74], [0.62, 0.8], [0.1, 0.8]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 28);
}

/** Cast mooring bollard with a mushroom head. */
function bollardGeometry() {
  const profile = [[0, 0], [0.4, 0], [0.4, 0.05], [0.25, 0.09], [0.21, 0.2], [0.2, 0.5], [0.25, 0.58], [0.36, 0.62], [0.38, 0.7], [0.33, 0.77], [0.16, 0.8], [0, 0.8]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 24);
}

/** Twin-horn deck cleat, horns along X. */
function cleatGeometry() {
  const horn = new THREE.CapsuleGeometry(0.05, 0.62, 4, 10);
  horn.rotateZ(Math.PI / 2);
  horn.translate(0, 0.24, 0);
  return merge([box(0.56, 0.04, 0.2, 0, 0.02, 0), box(0.07, 0.2, 0.09, -0.15, 0.13, 0), box(0.07, 0.2, 0.09, 0.15, 0.13, 0), horn]);
}

// ---- Air, water and the far side of the harbour ---------------------------------------------------
// Everything beyond the quay is drawn without a single picture: the bank of haze on the horizon and the
// water are analytic shaders, the far shore is geometry with its dusk light and aerial perspective baked
// into vertex colours, and its lamps are points. One model of the air (below, once in GLSL and once in
// script) colours all of them, so the far shore fades into exactly the haze that stands behind it.

const FOG: V3 = [0.26, 0.2, 0.27];
/** Fog over the water and the far shore: the scene's own out to the breakwater, thinner beyond so the far bank still reads. */
const FAR_FOG = 0.0052;
const SUN_FLAT = new THREE.Vector2(TO_SUN.x, TO_SUN.z).normalize();
const AIR = { bank: [0.38, 0.28, 0.4] as V3, warm: [1.3, 0.56, 0.3] as V3 };
const glsl = (value: number) => value.toFixed(5);
const vec = (value: number[]) => `vec${value.length}(${value.map(glsl).join(", ")})`;

const AIR_GLSL = /* glsl */`
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // x: toward the afterglow, y: the fog bank over the harbour mouth, z: where it stands tallest, w: the low western sky.
  vec4 airTerms(vec2 d) {
    float bearing = degrees(atan(d.x, -d.y));
    bearing += bearing < 0.0 ? 360.0 : 0.0;
    float toward = pow(max(dot(d, ${vec([SUN_FLAT.x, SUN_FLAT.y])}), 0.0), 3.0);
    float bank = smoothstep(84.0, 104.0, bearing) * (1.0 - smoothstep(214.0, 250.0, bearing));
    float tall = smoothstep(119.0, 128.0, bearing) * (1.0 - smoothstep(214.0, 230.0, bearing));
    float west = smoothstep(250.0, 268.0, bearing) * (1.0 - smoothstep(340.0, 358.0, bearing));
    return vec4(toward, bank, tall, west);
  }
  // Degrees above the horizon to which the haze is solid, and where it has thinned to nothing.
  float airSolid(vec4 terms) { return 9.0 + terms.w * 3.5 + terms.y * 6.5 + terms.z * 8.0; }
  float airTop(float solid) { return solid * 1.35 + 4.0; }
  vec3 airColour(vec4 terms, float elevation) {
    vec3 tint = mix(mix(${vec(FOG)}, ${vec(AIR.bank)}, terms.y), ${vec(AIR.warm)}, terms.x * 0.8);
    float rise = smoothstep(0.0, airTop(airSolid(terms)), elevation);
    // The glow is brightest on the horizon and thins upward; elsewhere the top of the bank catches a little sky.
    return min(tint * (1.0 + terms.x * 0.5 * (1.0 - rise)) * (1.0 + 0.2 * rise * (1.0 - terms.x)), vec3(1.2));
  }
  float airAmount(float away) {
    float reach = away < 120.0 ? away : 120.0 + (away - 120.0) * 0.6;
    float k = ${glsl(FAR_FOG)} * reach;
    return 1.0 - exp(-k * k);
  }
`;

const ease = (from: number, to: number, value: number) => { const t = Math.min(1, Math.max(0, (value - from) / (to - from))); return t * t * (3 - 2 * t); };
/** The colour of the haze on the horizon in a direction on the ground: the script twin of `airColour(terms, 0)`. */
function airAt(dx: number, dz: number): V3 {
  const length = Math.hypot(dx, dz) || 1, bearing = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
  const toward = Math.pow(Math.max(0, (dx * SUN_FLAT.x + dz * SUN_FLAT.y) / length), 3);
  const bank = ease(84, 104, bearing) * (1 - ease(214, 250, bearing));
  const lift = 1 + toward * 0.5;
  return [0, 1, 2].map((i) => Math.min(1.2, ((FOG[i] + (AIR.bank[i] - FOG[i]) * bank) * (1 - toward * 0.8) + AIR.warm[i] * toward * 0.8) * lift)) as V3;
}
function airAmount(distance: number) {
  const reach = distance < 120 ? distance : 120 + (distance - 120) * 0.6;
  return 1 - Math.exp(-((FAR_FOG * reach) ** 2));
}

const PLAIN_VERTEX = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** The bank of haze round the horizon: it hides where the sky photograph meets the ground and gives the far shore something to fade into. */
const HAZE_SHADER = {
  vertexShader: PLAIN_VERTEX,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec3 vWorld;
    ${AIR_GLSL}
    float hash31(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
    float noise3(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }
    void main() {
      vec3 ray = normalize(vWorld - cameraPosition);
      vec4 terms = airTerms(normalize(ray.xz));
      float elevation = degrees(asin(ray.y));
      // The top of the bank lies in long ragged layers that drift.
      vec3 drift = vec3(time * 0.004, 0.0, time * 0.003);
      float wisp = noise3(ray * vec3(6.0, 15.0, 6.0) + drift) * 0.6 + noise3(ray * vec3(15.0, 44.0, 15.0) - drift * 2.0) * 0.4 - 0.5;
      float solid = airSolid(terms);
      float cover = 1.0 - smoothstep(solid, airTop(solid), elevation + wisp * 3.0);
      gl_FragColor = vec4(airColour(terms, max(elevation, 0.0)), cover);
    }
  `,
};

/** Harbour water: travelling ripples, the sky and the haze mirrored at a grazing angle, dark where a ripple faces the eye. */
const WATER_SHADER = {
  vertexShader: PLAIN_VERTEX,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec3 vWorld;
    ${AIR_GLSL}
    void wave(vec2 p, vec2 heading, float span, float steep, float rate, float footprint, inout vec2 slope, inout float lost) {
      // A train too fine for the pixel it lands in stops rippling and roughens the mirror instead.
      float seen = 1.0 - smoothstep(0.22 * span, 0.7 * span, footprint);
      slope += heading * steep * seen * cos(dot(heading, p) * 6.2832 / span - rate * time);
      lost += (1.0 - seen * seen) * steep * steep * 0.5;
    }
    vec3 skyAt(vec3 ray) {
      vec4 terms = airTerms(normalize(ray.xz + 1e-5));
      float elevation = degrees(asin(clamp(ray.y, 0.0, 1.0)));
      float solid = airSolid(terms);
      float cover = 1.0 - smoothstep(solid, airTop(solid), elevation);
      vec3 clear = mix(vec3(0.5, 0.33, 0.36), vec3(0.2, 0.17, 0.33), smoothstep(6.0, 60.0, elevation));
      clear += vec3(1.5, 0.62, 0.3) * terms.x * (1.0 - smoothstep(0.0, 45.0, elevation)) * 0.5;
      return mix(clear, airColour(terms, elevation), cover);
    }
    void main() {
      vec3 toEye = cameraPosition - vWorld;
      float away = length(toEye);
      vec3 view = toEye / away;
      vec2 p = vWorld.xz;
      float footprint = max(length(dFdx(p)), length(dFdy(p)));
      // Long trains bend a little so no two crests run parallel for long.
      vec2 q = p + (vec2(noise2(p * 0.06 + time * 0.02), noise2(p * 0.06 + 31.7 - time * 0.017)) - 0.5) * 6.0;
      vec2 slope = vec2(0.0);
      float lost = 0.0;
      wave(q, vec2(-0.94, -0.342), 9.0, 0.022, 1.5, footprint, slope, lost);
      wave(q, vec2(-0.77, 0.638), 5.3, 0.03, 2.0, footprint, slope, lost);
      wave(q, vec2(-0.985, 0.174), 3.1, 0.04, 2.7, footprint, slope, lost);
      wave(q, vec2(-0.6, -0.8), 1.9, 0.045, 3.4, footprint, slope, lost);
      wave(p, vec2(-0.866, 0.5), 1.13, 0.045, 4.4, footprint, slope, lost);
      wave(p, vec2(-0.199, -0.98), 0.71, 0.04, 5.5, footprint, slope, lost);
      wave(p, vec2(-0.995, -0.1), 0.43, 0.035, 7.0, footprint, slope, lost);
      vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
      float rough = sqrt(lost);
      vec3 bounce = reflect(-view, normal);
      bounce.y = abs(bounce.y) + rough * 1.5;
      bounce = normalize(bounce);
      float facing = clamp(dot(view, normal) + rough * 0.7, 0.0, 1.0);
      float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
      vec3 colour = mix(vec3(0.012, 0.02, 0.028), skyAt(bounce), fresnel);
      vec3 air = airColour(airTerms(normalize(-view.xz)), 0.0);
      gl_FragColor = vec4(mix(colour, air, airAmount(away)), 1.0);
    }
  `,
};

/**
 * The far shore mirrored in the water. Each vertex is slid along the line from the eye to its mirror image
 * until it lies on the water, so the reflection is exact from wherever the player stands and nearer hulls
 * hide it by ordinary depth testing; ripples then break it into dashes close in.
 */
const MIRROR_SHADER = {
  vertexShader: /* glsl */`
    varying vec3 vColour;
    varying vec2 vPlane;
    varying float vLift;
    void main() {
      float lift = max(position.y - ${glsl(WATER_Y)}, 0.0);
      float eye = max(cameraPosition.y - ${glsl(WATER_Y)}, 0.5);
      // Ripples draw the image out toward the eye.
      vec2 p = mix(cameraPosition.xz, position.xz, eye / (eye + lift * 1.45));
      vColour = color;
      vPlane = p;
      vLift = lift;
      gl_Position = projectionMatrix * viewMatrix * vec4(p.x, ${glsl(WATER_Y + 0.015)}, p.y, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec3 vColour;
    varying vec2 vPlane;
    varying float vLift;
    ${AIR_GLSL}
    void main() {
      float footprint = max(length(dFdx(vPlane)), length(dFdy(vPlane)));
      vec2 drift = vec2(time * 0.45, time * 0.2);
      float ripple = noise2(vPlane * 0.5 + drift) * 0.6 + noise2(vPlane * 1.6 - drift * 1.5) * 0.4;
      float kept = mix(smoothstep(0.36, 0.56, ripple), 0.62, smoothstep(0.4, 2.4, footprint));
      // Tall things come off steeper ripples, and fainter.
      gl_FragColor = vec4(vColour * 0.84, 0.9 * kept / (1.0 + vLift * 0.014));
    }
  `,
};

/** Half the angle (radians) a lamp's reflection is smeared through by the ripples. */
const GLITTER = 0.052;
/**
 * A lamp's path of light on the water: a strip from the far waterline toward the eye, laid out per frame
 * along the line of sight, bright where a flat mirror would show the lamp and sparkling where ripples resolve.
 */
const GLITTER_SHADER = {
  vertexShader: /* glsl */`
    uniform float viewHeight;
    uniform float time;
    attribute vec3 corner;
    varying vec3 vColour;
    varying vec2 vPlane;
    varying vec3 vPath;
    ${AIR_GLSL}
    void main() {
      vec2 eyeAt = cameraPosition.xz;
      float eye = max(cameraPosition.y - ${glsl(WATER_Y)}, 0.5);
      vec2 toLamp = position.xz - eyeAt;
      float span = max(length(toLamp), 1.0);
      vec2 heading = toLamp / span, side = vec2(-heading.y, heading.x);
      float lift = max(position.y - ${glsl(WATER_Y)}, 0.3);
      float mirrored = atan(eye + lift, span);
      float d = mix(eye / tan(min(mirrored + 3.0 * ${glsl(GLITTER)}, 1.3)), span * 0.99, corner.y);
      // Never thinner than a pixel and a half, and dimmer by as much as it was widened.
      float honest = ${glsl(GLITTER)} * eye * 1.3 + 0.25;
      float least = d * 3.0 / (projectionMatrix[1][1] * viewHeight);
      float wide = max(honest, least);
      vec2 p = eyeAt + heading * d + side * corner.x * wide * 2.2;
      // corner.z: seconds between flashes of a beacon, in step with its point of light.
      float flash = corner.z > 0.0 ? smoothstep(0.55, 0.9, sin(time * 6.2832 / corner.z + fract(dot(position.xz, vec2(0.137, 0.071))) * 6.2832)) : 1.0;
      vColour = color * (honest / wide) * flash * (1.0 - 0.8 * airAmount(span));
      vPlane = p;
      vPath = vec3(corner.x, mirrored, eye);
      gl_Position = projectionMatrix * viewMatrix * vec4(p.x, ${glsl(WATER_Y + 0.03)}, p.y, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec3 vColour;
    varying vec2 vPlane;
    varying vec3 vPath;
    ${AIR_GLSL}
    void main() {
      float d = length(vPlane - cameraPosition.xz);
      float along = (atan(vPath.z, d) - vPath.y) / ${glsl(GLITTER)};
      float across = vPath.x * 2.2;
      float lobe = exp(-0.5 * along * along) * exp(-0.5 * across * across);
      float footprint = max(length(dFdx(vPlane)), length(dFdy(vPlane)));
      vec2 drift = vec2(time * 0.7, time * 0.33);
      float ripple = noise2(vPlane * 0.9 + drift) * 0.55 + noise2(vPlane * 2.7 - drift * 1.7) * 0.45;
      float sparkle = mix(smoothstep(0.46, 0.74, ripple) * 3.6, 1.0, smoothstep(0.3, 1.8, footprint));
      gl_FragColor = vec4(vColour * lobe * sparkle * 0.34, 1.0);
    }
  `,
};

/** Lamps too far off to be more than a point: a hard core that never shrinks below a pixel or two, a faint halo, haze between. */
const LAMP_SHADER = {
  vertexShader: /* glsl */`
    uniform float viewHeight;
    uniform float time;
    attribute vec3 aux;
    varying vec3 vColour;
    ${AIR_GLSL}
    void main() {
      vec4 eye = viewMatrix * vec4(position, 1.0);
      float away = length(eye.xyz);
      float size = aux.x * projectionMatrix[1][1] * viewHeight * 0.5 / max(-eye.z, 1.0);
      float least = viewHeight / 1080.0 * 2.3;
      gl_PointSize = max(size, least) * 5.0;
      // aux.y: seconds between flashes of a beacon (0 burns steadily); aux.z: a phase of its own.
      float steady = 0.9 + 0.1 * sin(time * (2.0 + aux.z * 3.0) + aux.z * 40.0);
      float flash = aux.y > 0.0 ? smoothstep(0.55, 0.9, sin(time * 6.2832 / aux.y + fract(dot(position.xz, vec2(0.137, 0.071))) * 6.2832)) : steady;
      vColour = color * flash * (1.0 - 0.72 * airAmount(away));
      gl_Position = projectionMatrix * eye;
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vColour;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      float glow = exp(-r * r * 26.0) * 2.4 + exp(-r * 4.2) * 0.16 * (1.0 - smoothstep(0.7, 1.0, r));
      gl_FragColor = vec4(vColour * glow, 1.0);
    }
  `,
};

export function buildDocks(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const props = createProps(kit);
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  const metals = kit.metals();
  const random = rng(2077);
  // One sea breeze for the whole quay: in through the harbour mouth astern of the ship and away down the lane.
  // Flags, tarps, smoke, weeds, litter and the gusts in the rigging all read it.
  const BREEZE = 0.35;
  const wind = createWind({ heading: BREEZE, strength: 0.45, gustiness: 0.62 });
  const life = createLife(kit, options, { wind, seed: 2077 });
  const trees = createTrees(kit, { seed: 9, wind, sun: () => sun });
  const cue = options.cue;
  /** Chance for things that happen while the range runs (the build keeps its own stream, so the map is the same every time). */
  const chance = rng(404);
  const fogColour = new THREE.Color(...FOG);
  const fogDensity = high ? 0.0052 : 0.0068;

  // ---- Materials -----------------------------------------------------------
  const asphalt = photoSet("/textures/asphalt_02-2k", 150 / 3.2, 250 / 3.2, false);
  const cast = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1);
  const concrete = new THREE.MeshStandardMaterial({ ...cast, color: 0xa3a19c, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const skin = containerTextures();
  track(skin.map); track(skin.normalMap);
  skin.map.anisotropy = skin.normalMap.anisotropy = anisotropy;
  const boxPaint = new THREE.MeshStandardMaterial({ map: skin.map, normalMap: skin.normalMap, normalScale: new THREE.Vector2(1, 1), vertexColors: true, roughness: 0.6, metalness: 0.12, envMapIntensity: 0.85 });
  const livery = track(liveryAtlas());
  livery.anisotropy = anisotropy;
  const lettering = new THREE.MeshStandardMaterial({ map: livery, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.62, metalness: 0.05, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.62, metalness: 0.55, envMapIntensity: 0.9 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.9, metalness: 0 });
  const rope = new THREE.MeshStandardMaterial({ color: 0x9c8f72, roughness: 0.95, metalness: 0 });
  const emissive = (colour: number, gain: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(gain), toneMapped: false });
  const COLD = 0xdcecff, SODIUM = 0xffa758;
  const haloMap = track(softDiscTexture());
  // Pools of lamplight painted on walls and ground: they cost nothing per pixel and outlast a power cut.
  const poolMaterial = new THREE.MeshBasicMaterial({ map: haloMap, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const coldLamp = emissive(COLD, 4.2), sodiumLamp = emissive(SODIUM, 3.4), mintTube = emissive(BRAND, 2.4), amberTube = emissive(STRIKE_ORANGE, 2.8);

  // Photographed finishes. Rust from one set weathers every box through the paint shader below.
  const rustSet = photoSet("/textures/rusty_metal_02-2k", 1, 1, false);
  const rustMask = track(canvasTexture(1024, 256, (context) => {
    // Where rust is allowed: `v` is height on the box (top of the canvas is the top rail), `u` runs along it.
    const next = rng(733);
    context.fillStyle = "#000"; context.fillRect(0, 0, 1024, 256);
    for (let i = 0; i < 15; i += 1) {
      const x = next() * 1024, y = next() * 256, r = 18 + next() * 70, level = 90 + next() * 165;
      const blot = context.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, `rgba(${level},${level},${level},.9)`); blot.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = blot; context.fillRect(x - r, y - r, r * 2, r * 2);
      if (x < r) { context.save(); context.translate(1024, 0); context.fillRect(x - r, y - r, r * 2, r * 2); context.restore(); }
    }
    // Runs from the top rail, and the rot that creeps up from the bottom one.
    for (let i = 0; i < 24; i += 1) {
      const x = next() * 1024, length = 30 + next() * 150, level = 120 + next() * 135;
      const run = context.createLinearGradient(0, 0, 0, length);
      run.addColorStop(0, `rgba(${level},${level},${level},.95)`); run.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = run; context.fillRect(x, 0, 3 + next() * 16, length);
    }
    const foot = context.createLinearGradient(0, 214, 0, 256);
    foot.addColorStop(0, "rgba(200,200,200,0)"); foot.addColorStop(1, "rgba(200,200,200,.6)");
    context.fillStyle = foot; context.fillRect(0, 214, 1024, 42);
    const head = context.createLinearGradient(0, 0, 0, 16);
    head.addColorStop(0, "rgba(190,190,190,.5)"); head.addColorStop(1, "rgba(190,190,190,0)");
    context.fillStyle = head; context.fillRect(0, 0, 1024, 16);
  }, true));
  rustMask.colorSpace = THREE.NoColorSpace;
  rustMask.wrapT = THREE.ClampToEdgeWrapping;
  /** Lets photographed rust eat through a box's paint, differently on every instance. */
  const weather = <T extends THREE.MeshStandardMaterial>(material: T, amount: number): T => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.rustMap = { value: rustSet.map };
      shader.uniforms.rustMask = { value: rustMask };
      shader.uniforms.rustAmount = { value: amount };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRust;\nvarying vec2 vRustShift;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vRust = position;
          #ifdef USE_INSTANCING
            vRustShift = fract(vec2(instanceMatrix[3].x * 0.173 + instanceMatrix[3].y * 0.31, instanceMatrix[3].z * 0.117 + instanceMatrix[3].y * 0.23));
          #else
            vRustShift = vec2(0.37, 0.61);
          #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D rustMap;\nuniform sampler2D rustMask;\nuniform float rustAmount;\nvarying vec3 vRust;\nvarying vec2 vRustShift;")
        .replace("#include <color_fragment>", `#include <color_fragment>
          float rustAlong = vRust.x + vRust.z;
          vec3 rustPhoto = texture2D(rustMap, vec2(rustAlong, vRust.y) / 2.3 + vRustShift).rgb;
          float rustAllowed = texture2D(rustMask, vec2(rustAlong / 9.5 + vRustShift.x + vRustShift.y, 1.0 - vRust.y / ${CH.toFixed(2)})).r;
          float rusted = smoothstep(0.03, 0.2, rustPhoto.r - rustPhoto.b);
          rusted = clamp((rusted * smoothstep(0.12, 0.7, rustAllowed) + smoothstep(0.8, 1.0, rustAllowed) * (0.25 + 0.5 * rusted)) * rustAmount, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, rustPhoto * vec3(0.42, 0.27, 0.2), rusted);`)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.96, rusted);")
        .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - rusted;");
    };
    return material;
  };
  weather(boxPaint, 0.8);
  // Boxes near the range have modelled ribs, so their normal map is the pitting of the photographed plate instead.
  const boxPaintNear = weather(new THREE.MeshStandardMaterial({ map: skin.map, normalMap: rustSet.normalMap, normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: rustSet.roughnessMap, vertexColors: true, roughness: 0.82, metalness: 0.12, envMapIntensity: 0.85 }), 1);
  const ribbed = photoSet("/textures/corrugated_iron_02-2k", 1, 1, false);
  const sheeting = new THREE.MeshStandardMaterial({ ...ribbed, color: 0xc9d2d6, roughness: 1, metalness: 0.35, envMapIntensity: 0.7 });
  const hallSkin = new THREE.MeshStandardMaterial({ ...ribbed, color: 0xa4b0b8, roughness: 1, metalness: 0.3, envMapIntensity: 0.6 });
  const plate = new THREE.MeshStandardMaterial({ ...photoSet("/textures/metal_plate-2k", 1, 1, false), color: 0xc8c4bc, roughness: 1, metalness: 0.55, envMapIntensity: 0.9 });
  const greenPaint = new THREE.MeshStandardMaterial({ ...photoSet("/textures/green_metal_rust-2k", 1, 1, false), color: 0xd8e0d8, roughness: 1, metalness: 0.2, envMapIntensity: 0.7 });
  const wallSet = photoSet("/textures/concrete_wall_007-2k", 1, 1, false);
  const quayWall = new THREE.MeshStandardMaterial({ ...wallSet, color: 0x9d9a92, roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  // One painted-steel, one matt and one smooth finish carry every colour through vertex colours. The plate is drawn
  // at full size: its rivets are a fixed number of texels across, so a smaller sheet would turn them into door knobs.
  const paintAny = pbrMaterial(keep(paintedSteel(anisotropy, [0.78, 0.78, 0.78], 1203, 0.45, 1024)), { vertexColors: true, envMapIntensity: 0.9 });
  const CRANE_GREY = 0x8b959b, HOUSE_WHITE = 0xc5c5bb, GEAR_YELLOW = 0xcb8516;
  const matte = new THREE.MeshStandardMaterial({ ...photoSet("/textures/painted_plaster_wall-2k", 1, 1, false), vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.45 });
  const smooth = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, envMapIntensity: 0.7 });
  const glowAny = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const glazing = new THREE.MeshStandardMaterial({ color: 0x0a1116, roughness: 0.07, metalness: 0.7, envMapIntensity: 1.5 });
  const clearGlass = new THREE.MeshStandardMaterial({ color: 0x9fb4b8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, envMapIntensity: 1.6 });
  // Parts sorted by finish; each list becomes one mesh at the end. "Far" lists neither cast shadows nor stop bullets.
  const B = {
    paint: [] as THREE.BufferGeometry[], paintFar: [] as THREE.BufferGeometry[], matte: [] as THREE.BufferGeometry[], matteFar: [] as THREE.BufferGeometry[],
    iron: [] as THREE.BufferGeometry[], ironFar: [] as THREE.BufferGeometry[], plate: [] as THREE.BufferGeometry[], green: [] as THREE.BufferGeometry[],
    glow: [] as THREE.BufferGeometry[], glazing: [] as THREE.BufferGeometry[], glass: [] as THREE.BufferGeometry[], rubber: [] as THREE.BufferGeometry[],
    concrete: [] as THREE.BufferGeometry[], timber: [] as THREE.BufferGeometry[], rope: [] as THREE.BufferGeometry[], brushed: [] as THREE.BufferGeometry[],
    pools: [] as THREE.BufferGeometry[], floorPools: [] as THREE.BufferGeometry[], floorPlate: [] as THREE.BufferGeometry[], floorIron: [] as THREE.BufferGeometry[], concreteFar: [] as THREE.BufferGeometry[],
    smooth: [] as THREE.BufferGeometry[],
  };
  const swatch = new THREE.Color();
  /** Paints a whole part one colour (sRGB hex) for the finishes that take their colour from the vertices. */
  const tinted = <T extends THREE.BufferGeometry>(geometry: T, colour: number): T => { swatch.set(colour); return shade(geometry, swatch.r, swatch.g, swatch.b); };
  /** Files a part under a finish, tinted (sRGB hex, optional gain above 1 for lamps). */
  const put = (into: THREE.BufferGeometry[], geometry: THREE.BufferGeometry, colour = 0xffffff, gain = 1) => {
    swatch.set(colour).multiplyScalar(gain);
    into.push(shade(geometry, swatch.r, swatch.g, swatch.b));
    return geometry;
  };
  /** The same, for a prop modelled about its own origin and then set down at a spot and heading. */
  const stage = (x: number, y: number, z: number, yaw = 0, pitch = 0) => {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
    const set = (into: THREE.BufferGeometry[], geometry: THREE.BufferGeometry, colour = 0xffffff, gain = 1) => put(into, geometry.applyMatrix4(matrix), colour, gain);
    set.point = (px: number, py: number, pz: number): V3 => new THREE.Vector3(px, py, pz).applyMatrix4(matrix).toArray() as V3;
    return set;
  };
  /** One painted-steel mesh out of parts that each have a colour of their own: for the few things that move. */
  const steel = (parts: Array<[THREE.BufferGeometry, number]>, grain = 2.4) => new THREE.Mesh(projectUv(merge(parts.map(([geometry, colour]) => tinted(geometry, colour))), grain), paintAny);
  /** The haze lit up round a set of lamps, as points that ride on `parent`. The material's colour dims or flashes the lot. */
  const lampHalo = (parent: THREE.Object3D, lamps: Array<{ position: V3; colour: number; gain: number }>, size = 3.4) => {
    const positions = new Float32Array(lamps.length * 3), colours = new Float32Array(lamps.length * 3);
    lamps.forEach((lamp, index) => {
      positions.set(lamp.position, index * 3);
      swatch.setHex(lamp.colour).multiplyScalar(lamp.gain > 1 ? 0.55 : lamp.gain);
      colours.set([swatch.r, swatch.g, swatch.b], index * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    const material = new THREE.PointsMaterial({ map: haloMap, size, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const points = new THREE.Points(geometry, material);
    parent.add(points);
    kit.probeHidden.push(points);
    return material;
  };

  // ---- Apron ---------------------------------------------------------------
  const apron = new THREE.MeshStandardMaterial({ ...asphalt, color: 0x9a9da6, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.92, metalness: 0, envMapIntensity: 0.55 });
  const reflection = kit.floor(apron, { width: 150, depth: 250, z: -30 }, {
    lane: new THREE.Color(0.78, 0.77, 0.7),
    edge: new THREE.Color(0.86, 0.6, 0.1),
    markings: 0.88,
    wet: 0.035,
  });
  // The slab stops at the quay edge on the right and runs far into the yard on the left.
  kit.mirrorHidden[kit.mirrorHidden.length - 1].position.x = QUAY_EDGE - 75;
  const far = <T extends THREE.Object3D>(object: T, position?: V3) => {
    if (position) object.position.set(...position);
    object.traverse((child) => { child.castShadow = false; });
    object.matrixAutoUpdate = false;
    object.updateMatrix();
    scene.add(object);
    return object;
  };
  // Land beyond the slab, left to the haze.
  const hinterland = new THREE.MeshStandardMaterial({ color: 0x35363a, roughness: 1, metalness: 0, envMapIntensity: 0.4 });
  for (const [w, d, x, z] of [[176, 480, -213, -30], [150, 76, -50, -193], [150, 116, -50, 153]]) {
    const land = new THREE.Mesh(new THREE.PlaneGeometry(w, d), hinterland);
    land.rotation.x = -Math.PI / 2;
    land.receiveShadow = false;
    far(land, [x, -0.02, z]);
  }

  // ---- Containers ----------------------------------------------------------
  // Each line paints its boxes its own colour; the last two are leased boxes with codes only.
  const LINES: Array<{ paint: number; ink: V3; brand: number }> = [
    { paint: 0x1f6f60, ink: [0.9, 0.9, 0.86], brand: 0 },
    { paint: 0xb8551c, ink: [0.92, 0.9, 0.85], brand: 1 },
    { paint: 0x1f426c, ink: [0.9, 0.9, 0.88], brand: 2 },
    { paint: 0x7e2d22, ink: [0.9, 0.88, 0.82], brand: 3 },
    { paint: 0x8f9499, ink: [0.05, 0.09, 0.2], brand: 4 },
    { paint: 0xb58c22, ink: [0.05, 0.05, 0.05], brand: 5 },
    { paint: 0x5a2229, ink: [0.88, 0.86, 0.8], brand: -1 },
    { paint: 0x4a7d96, ink: [0.9, 0.9, 0.88], brand: -1 },
  ];
  type Stowed = { length: number; x: number; y: number; z: number; yaw: number; line: number; near: boolean; open?: boolean; paint?: number };
  const stowed: Stowed[] = [];
  const marks: THREE.BufferGeometry[] = [];
  const stow = (length: number, x: number, y: number, z: number, yaw: number, line: number, near = false) => {
    const item: Stowed = { length, x, y, z, yaw, line, near };
    stowed.push(item);
    return item;
  };
  const anyLine = () => Math.floor(random() * LINES.length);
  /** A lettering quad at a point given in the box's own frame, facing along its local `normal` axis. */
  const mark = (item: Stowed, cell: [number, number, number, number], w: number, h: number, local: V3, facing: number, ink: V3 = LINES[item.line].ink) => {
    const quad = new THREE.PlaneGeometry(w, h);
    const [px, py, pw, ph] = cell, uv = quad.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (px + uv.getX(i) * pw) / 2048, 1 - (py + (1 - uv.getY(i)) * ph) / LIVERY_HIGH);
    quad.rotateY(item.yaw + facing);
    const c = Math.cos(item.yaw), s = Math.sin(item.yaw);
    quad.translate(item.x + local[0] * c + local[2] * s, item.y + local[1], item.z - local[0] * s + local[2] * c);
    marks.push(shade(quad, ...ink));
  };
  /** Livery on one long side (`side` = ±1 along the box's local z): the line's name and the owner code. */
  const letterSide = (item: Stowed, side: number, name = true) => {
    const line = LINES[item.line], out = side * (CW / 2 - 0.002), facing = side > 0 ? 0 : Math.PI;
    if (name && line.brand >= 0) {
      const w = item.length > 8 ? 7.4 : 4.3;
      mark(item, [0, line.brand * 256, 2048, 256], w, w / 8, [0, CH * 0.54, out], facing);
    }
    const code = (line.brand >= 0 ? line.brand : item.line) % 8;
    mark(item, [(code % 4) * 512, 1536 + Math.floor(code / 4) * 128, 512, 128], 1.5, 0.375, [side * (item.length / 2 - 1.15), CH - 0.42, out], facing);
  };
  const PLAIN: V3 = [0.92, 0.92, 0.92];
  const letterDoors = (item: Stowed) => {
    // Stencils sit a few millimetres off the flutes of the right-hand leaf; the plates ride on the left one.
    const code = (item.line + 3) % 8, out = item.length / 2 + 0.002;
    mark(item, [(code % 4) * 512, 1536 + Math.floor(code / 4) * 128, 512, 128], 0.84, 0.21, [out, 2.2, -0.52], Math.PI / 2);
    mark(item, [(item.line % 4) * 512, 1792, 512, 256], 0.84, 0.42, [out, 1.62, -0.52], Math.PI / 2);
    mark(item, PLATES.csc, 0.262, 0.35, [out + 0.002, 0.72, 0.63], Math.PI / 2, PLAIN);
    mark(item, PLATES.approval, 0.24, 0.12, [out, 1.02, 0.62], Math.PI / 2, PLAIN);
    if (item.length > 8) mark(item, PLATES.heavy, 0.86, 0.1075, [out, 2.3, 0.56], Math.PI / 2, PLAIN);
    if (item.line % 2 === 0) mark(item, PLATES.diamond, 0.36, 0.36, [out + 0.002, 1.62, 0.63], Math.PI / 2, PLAIN);
    else mark(item, PLATES.overhead, 0.27, 0.18, [out, 2.02, 0.56], Math.PI / 2, PLAIN);
  };
  const ALONG_Z = Math.PI / 2;

  // The lane's own walls: two boxes high on both sides, three across the far end.
  const wallX = 9.53 + CW / 2;
  const leftRun: Array<[number, number]> = [[LONG, 0.3], [SHORT, -11.99], [LONG, -18.15]];
  const rightRun: Array<[number, number]> = [[LONG, 0.3], [LONG, -11.99], [SHORT, -24.28]];
  const leftLines = [[2, 6, 0], [3, 4, 1]], rightLines = [[1, 0, 7], [4, 3, 2]];
  for (const [side, run, lines] of [[-1, leftRun, leftLines], [1, rightRun, rightLines]] as const) {
    run.forEach(([length, from], index) => {
      for (let tier = 0; tier < 2; tier += 1) {
        // The first box of each run shows its doors to the firing point.
        const item = stow(length, side * wallX, tier * TIER, from - length / 2, index === 0 ? -ALONG_Z : ALONG_Z, lines[tier][index], true);
        // The long face that looks into the lane; names go on the upper tier, clear of the range signs.
        letterSide(item, (index === 0 ? -1 : 1) * side, tier === 1);
        if (index === 0) letterDoors(item);
      }
    });
  }
  const leftTop = stow(SHORT, -wallX, 2 * TIER, -11.99 - SHORT / 2, ALONG_Z, 5, true);
  letterSide(leftTop, -1);
  const rightTop = stow(SHORT, wallX, 2 * TIER, -5.83 - SHORT / 2, ALONG_Z, 6, true);
  letterSide(rightTop, 1);
  const endZ = -28.42 - CW / 2;
  for (let tier = 0; tier < 3; tier += 1) {
    const flip = tier === 2;
    const long = stow(LONG, flip ? 3.165 : -3.165, tier * TIER, endZ, flip ? Math.PI : 0, [7, 3, 0][tier], true);
    const short = stow(SHORT, flip ? -6.23 : 6.23, tier * TIER, endZ, 0, [5, 2, 1][tier], true);
    letterSide(long, flip ? -1 : 1, tier === 2);
    letterSide(short, 1, tier === 2);
  }

  // Yard stack on the left, tall enough to put the firing-point end of the right wall in shade.
  const yardZ = -8.25 - LONG / 2;
  for (const [x, tiers] of [[-14.62, 4], [-17.16, 3]] as const) for (let tier = 0; tier < tiers; tier += 1) {
    const item = stow(LONG, x, tier * TIER, yardZ, tier % 2 ? ALONG_Z : -ALONG_Z, anyLine(), true);
    if (tier >= 2) letterSide(item, tier % 2 ? 1 : -1);
    letterSide(item, tier % 2 ? -1 : 1, tier > 0);
  }
  // One box set down on the left apron, doors toward the firing point.
  const stray = stow(SHORT, -15.9, 0, 6.3, -0.42, 1, true);
  stray.open = true;
  letterSide(stray, -1); letterSide(stray, 1);
  // Stacks beside the quay shed and across the quay from it.
  [[3, 12.4], [4, 14.94], [2, 17.48]].forEach(([tiers, z]) => {
    for (let tier = 0; tier < tiers; tier += 1) { const item = stow(LONG, -20.2, tier * TIER, z, 0, anyLine()); if (z < 13) letterSide(item, -1, tier > 0); }
  });
  // Behind the far wall: taller rows that step the skyline up.
  [[-33.7, [5, 4]], [-36.3, [3, 5]], [-38.9, [4, 2]]].forEach(([z, heights], row) => {
    (heights as number[]).forEach((tiers, slot) => {
      for (let tier = 0; tier < tiers; tier += 1) {
        const item = stow(LONG, slot ? 6.16 : -6.16, tier * TIER, z as number, 0, anyLine());
        if (row === 0 && tier >= 3) letterSide(item, 1);
      }
    });
  });
  // Yard blocks further out. The diagonal the last light travels down is kept low.
  const block = (xs: number[], zs: number[], low: number, highest: number, letter: number) => {
    for (const x of xs) for (const z of zs) {
      // The diagonal the last light travels down to the firing point stays a tier lower.
      const corridor = x < -40 && z > -24 && z < 0;
      const tiers = Math.min(corridor ? 3 : 9, low + Math.floor(random() * (highest - low + 1)));
      for (let tier = 0; tier < tiers; tier += 1) {
        const item = stow(LONG, x, tier * TIER, z, random() < 0.5 ? ALONG_Z : -ALONG_Z, anyLine());
        if (tier >= 1 && random() < letter) letterSide(item, item.yaw > 0 ? 1 : -1);
      }
    }
  };
  block([-15.2, -17.74, -22.4, -24.94], [-47.5, -60, -72.5], 3, 5, 0.5);
  block([-46.2, -48.74, -53.6, -56.14], [-66, -53.5, -41, -28.5, -16, -3.5, 9, 21.5, 34], 3, 4, 0.6);
  block([-31, -33.54], [26, 38.5], 2, 4, 0.5);
  block([-74, -76.54, -81.5], [-80, -67.5, -55, -30, -17.5, 5, 17.5, 42], 3, 5, 0);
  // Singles left in the low corridor.
  stow(LONG, -21.5, 0, -27.5, ALONG_Z + 0.06, 4);
  stow(SHORT, -27.2, 0, -34.2, 0.3, 2);

  // ---- The ship ------------------------------------------------------------
  const halos: Array<{ position: V3; colour: number; gain: number }> = [];
  const shipX = 37.5, hullTop = DECK_Y, hullLow = -2.6, portX = 26.5;
  const outline = new THREE.Shape();
  outline.moveTo(27.4, 4); outline.lineTo(47.6, 4); outline.quadraticCurveTo(48.5, 4, 48.5, 5.2); outline.lineTo(48.5, 98);
  outline.quadraticCurveTo(48.2, 114, shipX, 126); outline.quadraticCurveTo(26.8, 114, 26.5, 98); outline.lineTo(26.5, 5.2); outline.quadraticCurveTo(26.5, 4, 27.4, 4);
  const hullGeometry = new THREE.ExtrudeGeometry(outline, { depth: hullTop - hullLow, bevelEnabled: false, curveSegments: 12 });
  hullGeometry.rotateX(-Math.PI / 2);
  hullGeometry.translate(0, hullLow, 0);
  wallUv(hullGeometry, 28, hullLow, (hullTop - hullLow) / 0.955, [0.5, 0.985]);
  const hullSkin = hullTextures();
  [hullSkin.map, hullSkin.normalMap].forEach((texture) => { track(texture); texture.anisotropy = anisotropy; });
  const hull = far(new THREE.Mesh(hullGeometry, new THREE.MeshStandardMaterial({ map: hullSkin.map, normalMap: hullSkin.normalMap, normalScale: new THREE.Vector2(1, 1), roughness: 0.56, metalness: 0.25, envMapIntensity: 0.9 })));
  hull.receiveShadow = true; hull.castShadow = true;
  // Deck cargo, bay by bay; the bay under the working crane is half discharged.
  const bays = [-34, -47.1, -60.2, -73.3, -86.4, -99.5];
  bays.forEach((z, bay) => {
    for (let across = 0; across < 8; across += 1) {
      const tiers = bay === 0 ? [3, 2, 1, 2, 4, 4, 4, 3][across] : Math.max(2, Math.min(5, 3 + Math.floor(random() * 3) - (across === 0 || across === 7 ? 1 : 0)));
      for (let tier = 0; tier < tiers; tier += 1) {
        const item = stow(LONG, 28.72 + across * 2.51, DECK_Y + 0.02 + tier * TIER, z, ALONG_Z, anyLine());
        // Outboard faces toward the quay, and the cut face of the working bay.
        if (across === 0 || (bay === 0 && across < 4 && tier === tiers - 1)) letterSide(item, 1, random() < 0.7);
      }
    }
  });
  // The line's name along the topsides.
  const hullName = new THREE.PlaneGeometry(19, 19 / 8);
  { const uv = hullName.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i), 1 - (256 + (1 - uv.getY(i)) * 256) / LIVERY_HIGH); }
  hullName.rotateY(-Math.PI / 2);
  hullName.translate(26.47, 9.3, -60);
  marks.push(shade(hullName, 0.8, 0.8, 0.76));
  // Her own paint: name and port across the stern, draught marks and load line on the quarter, notices on the house.
  const shipPaint: THREE.BufferGeometry[] = [];
  /** Lettering on the ship: white on the hull, and `ink` for anything painted on the white house. */
  const shipMark = (cell: [number, number, number, number], w: number, x: number, y: number, z: number, facing: Facing, ink: V3 = [1, 1, 1]) => shipPaint.push(shade(cellUv(quad(w, w * cell[3] / cell[2], x, y, z, facing), cell, 2048, 1024), ...ink));
  shipMark([0, 0, 2048, 300], 13.5, shipX, 8.9, -3.97, "z+");
  shipMark([0, 310, 1250, 190], 6.4, shipX, 7.0, -3.97, "z+");
  shipMark([0, 505, 1000, 130], 3.6, shipX, 5.7, -3.97, "z+");
  shipMark([1400, 300, 260, 724], 1.3, portX - 0.03, 1.55, -8.2, "x-");
  shipMark([1680, 310, 368, 300], 1.9, portX - 0.03, 2.3, -52, "x-");
  shipMark([1680, 640, 290, 290], 1.5, portX - 0.03, 3.2, -24, "x-");
  // Accommodation block, wheelhouse, funnel, mast.
  const houseMap = track(houseTexture());
  houseMap.anisotropy = anisotropy;
  const housePlate = new THREE.MeshStandardMaterial({ map: houseMap, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.8 });
  const houseZ = -15.2, housePort = shipX - 8.8, houseAft = houseZ + 6.3, houseFore = houseZ - 6.3, DECK_RISE = 3.06;
  const houseMesh = far(new THREE.Mesh(wallUv(box(17.6, 15.3, 12.6, shipX, DECK_Y + 7.65, houseZ), 14.4, DECK_Y, 15.3, [0.5, 0.999], 0.3), housePlate));
  houseMesh.castShadow = true; houseMesh.receiveShadow = true;
  // The house wears its standing orders in navy, in the clear strake between the top row of windows and the boat deck.
  const HOUSE_INK: V3 = [0.04, 0.08, 0.17];
  shipMark([0, 660, 1330, 210], 5.8, shipX, DECK_Y + 4 * DECK_RISE + 2.675, houseFore - 0.03, "z-", HOUSE_INK);
  shipMark([0, 880, 1040, 130], 6.4, housePort - 0.03, DECK_Y + 4 * DECK_RISE + 2.675, houseZ - 0.6, "x-", HOUSE_INK);
  shipMark([0, 660, 1330, 210], 5.8, housePort - 0.03, DECK_Y + 3 * DECK_RISE + 2.675, houseZ - 0.6, "x-", HOUSE_INK);
  const shipWhite: THREE.BufferGeometry[] = [], shipDark: THREE.BufferGeometry[] = [];
  // Deck edges read as thin slabs proud of the plating, each with its rail.
  for (let deck = 1; deck <= 5; deck += 1) {
    const y = DECK_Y + deck * DECK_RISE;
    shipWhite.push(box(18.3, 0.14, 13.3, shipX, y, houseZ));
    if (deck === 5) continue;
    for (const rail of [0.52, 1.02]) shipWhite.push(box(0.05, 0.05, 13.3, housePort - 0.32, y + rail, houseZ), box(18.3, 0.05, 0.05, shipX, y + rail, houseFore - 0.32), box(18.3, 0.05, 0.05, shipX, y + rail, houseAft + 0.32));
    for (let i = 0; i <= 7; i += 1) shipWhite.push(box(0.05, 1.02, 0.05, housePort - 0.32, y + 0.51, houseFore - 0.32 + i * 1.9));
    for (let i = 1; i <= 9; i += 1) shipWhite.push(box(0.05, 1.02, 0.05, housePort - 0.32 + i * 1.83, y + 0.51, houseFore - 0.32), box(0.05, 1.02, 0.05, housePort - 0.32 + i * 1.83, y + 0.51, houseAft + 0.32));
  }
  /** A cabin window: proud frame, glass set back, and a lamp behind it if someone is in. */
  const cabinWindow = (x: number, y: number, z: number, facing: Facing, w: number, h: number) => {
    const alongZ = facing === "x-" || facing === "x+", out = facing === "x-" || facing === "z-" ? -1 : 1;
    const bar = (bw: number, bh: number, du: number, dv: number) => shipWhite.push(alongZ ? box(0.07, bh, bw, x + out * 0.03, y + dv, z + du) : box(bw, bh, 0.07, x + du, y + dv, z + out * 0.03));
    bar(w + 0.16, 0.08, 0, h / 2 + 0.04); bar(w + 0.16, 0.08, 0, -h / 2 - 0.04); bar(0.08, h, -w / 2 - 0.04, 0); bar(0.08, h, w / 2 + 0.04, 0);
    const pane = (pw: number, ph: number, dv: number, lift: number) => alongZ ? quad(pw, ph, x + out * lift, y + dv, z, facing) : quad(pw, ph, x, y + dv, z + out * lift, facing);
    const roll = random();
    if (roll < 0.42) {
      // Lit: warm or cold, sometimes with the blind half down.
      const blind = random() < 0.45 ? 0.25 + random() * 0.4 : 0, level = 0.9 + random() * 1.3;
      put(B.glow, pane(w, h * (1 - blind), -h * blind / 2, 0.012), random() < 0.75 ? 0xffc27a : 0xcfe4ff, level);
      if (blind) put(B.matteFar, pane(w, h * blind, h * (1 - blind) / 2, 0.012), 0xb9ad94);
    } else B.glazing.push(pane(w, h, 0, 0.012));
  };
  for (let deck = 0; deck < 5; deck += 1) {
    const y = DECK_Y + deck * DECK_RISE + 1.75;
    for (let i = 0; i < 6; i += 1) cabinWindow(housePort, y, houseFore + 1.1 + i * 1.7, "x-", 0.85, 1.05);
    for (let i = 0; i < 9; i += 1) cabinWindow(housePort + 1.3 + i * 1.875, y, houseFore, "z-", 0.85, 1.05);
    for (const x of [housePort + 1.2, housePort + 2.9, housePort + 14.7, housePort + 16.4]) cabinWindow(x, y, houseAft, "z+", 0.85, 1.05);
    // Weather door at the after end of each side deck, with its bulkhead lamp.
    put(B.paintFar, box(0.08, 2.0, 0.85, housePort - 0.03, y - 0.7, houseAft - 1.0), 0x9aa39c);
    put(B.paintFar, box(0.1, 2.14, 0.07, housePort - 0.03, y - 0.66, houseAft - 0.54), 0x6f766f);
    put(B.paintFar, box(0.1, 2.14, 0.07, housePort - 0.03, y - 0.66, houseAft - 1.46), 0x6f766f);
    put(B.ironFar, new THREE.TorusGeometry(0.15, 0.03, 6, 12).rotateY(Math.PI / 2).translate(housePort - 0.08, y - 0.2, houseAft - 1.0));
    put(B.glow, box(0.1, 0.12, 0.26, housePort - 0.07, y + 0.62, houseAft - 1.0), 0xffd9a8, 3.2);
    halos.push({ position: [housePort - 0.3, y + 0.55, houseAft - 1.0], colour: SODIUM, gain: 0.32 });
    put(B.pools, quad(3.6, 2.6, housePort - 0.045, y - 0.5, houseAft - 1.0, "x-"), SODIUM, 0.2);
  }
  // Wheelhouse across the full beam: a band of windows, a few with instrument light behind, under a brow.
  const bridgeY = DECK_Y + 16.75, bridgeZ = houseZ - 2.9;
  shipWhite.push(box(22.6, 2.9, 6.4, shipX, bridgeY, bridgeZ), box(23.2, 0.16, 7, shipX, DECK_Y + 18.28, bridgeZ), box(23, 0.1, 0.9, shipX, bridgeY + 1.2, bridgeZ - 3.5));
  shipWhite.push(box(7.4, 1.5, 4.2, shipX, DECK_Y + 19.1, houseZ - 2.4), box(7.4, 8.6, 4.6, shipX, DECK_Y + 4.3, -6.6));
  const bridgePane = (x: number, z: number, facing: Facing, w: number) => {
    const alongZ = facing === "x-", out = facing === "z+" ? 1 : -1;
    const lit = random() < 0.3;
    const pane = alongZ ? quad(w, 1.25, x - 0.012, bridgeY + 0.25, z, facing) : quad(w, 1.25, x, bridgeY + 0.25, z + out * 0.012, facing);
    if (lit) put(B.glow, pane, random() < 0.5 ? 0x3c8a76 : 0xb8823c, 0.5 + random() * 0.4); else B.glazing.push(pane);
    shipDark.push(alongZ ? box(0.06, 1.37, 0.07, x - 0.03, bridgeY + 0.25, z + w / 2 + 0.06) : box(0.07, 1.37, 0.06, x + w / 2 + 0.06, bridgeY + 0.25, z + out * 0.03));
  };
  for (let i = 0; i < 16; i += 1) bridgePane(shipX - 10.5 + i * 1.4, bridgeZ - 3.2, "z-", 1.28);
  for (let i = 0; i < 4; i += 1) bridgePane(shipX - 11.3, bridgeZ - 2.25 + i * 1.5, "x-", 1.38);
  for (const x of [shipX - 10.4, shipX - 9, shipX + 9, shipX + 10.4]) bridgePane(x, bridgeZ + 3.2, "z+", 1.28);
  shipDark.push(box(22.7, 0.07, 0.06, shipX, bridgeY - 0.44, bridgeZ - 3.23), box(22.7, 0.07, 0.06, shipX, bridgeY + 0.94, bridgeZ - 3.23), box(0.06, 0.07, 6.5, shipX - 11.33, bridgeY - 0.44, bridgeZ), box(0.06, 0.07, 6.5, shipX - 11.33, bridgeY + 0.94, bridgeZ));
  // Monkey island: rail, satcom domes, whips and a searchlight.
  const islandY = DECK_Y + 18.36;
  for (const rail of [0.5, 1.0]) shipWhite.push(box(23.2, 0.045, 0.045, shipX, islandY + rail, bridgeZ - 3.45), box(23.2, 0.045, 0.045, shipX, islandY + rail, bridgeZ + 3.45), box(0.045, 0.045, 6.9, shipX - 11.55, islandY + rail, bridgeZ));
  for (let i = 0; i <= 12; i += 1) shipWhite.push(box(0.045, 1.0, 0.045, shipX - 11.55 + i * 1.925, islandY + 0.5, bridgeZ - 3.45), box(0.045, 1.0, 0.045, shipX - 11.55 + i * 1.925, islandY + 0.5, bridgeZ + 3.45));
  for (const [x, r] of [[shipX - 6.2, 0.75], [shipX + 6.6, 0.55], [shipX - 8.6, 0.38]]) {
    put(B.paintFar, new THREE.SphereGeometry(r, 14, 10).translate(x, islandY + 1.1 + r, bridgeZ + 1.2), 0xdcd8cc);
    shipDark.push(cyl(r * 0.3, 1.2, x, islandY + 0.6, bridgeZ + 1.2, "y", 8));
  }
  for (const x of [shipX - 3.2, shipX + 3.1, shipX + 9.4]) shipDark.push(rod([x, islandY, bridgeZ - 1.8], [x + 0.1, islandY + 5.2, bridgeZ - 1.9], 0.025, 5));
  shipDark.push(cyl(0.22, 0.34, shipX - 9.8, islandY + 1.2, bridgeZ - 2.9, "x", 12), cyl(0.04, 1.0, shipX - 9.8, islandY + 0.5, bridgeZ - 2.9, "y", 6));
  put(B.glow, cyl(0.19, 0.02, shipX - 9.98, islandY + 1.2, bridgeZ - 2.9, "x", 12), COLD, 2.6);
  // Mast with crosstrees, a radar platform and its lights; the radar bar turns.
  const mastZ = houseZ - 2.4;
  shipDark.push(rod([shipX, DECK_Y + 19.8, mastZ], [shipX, DECK_Y + 28.5, mastZ], 0.16, 8), box(5.2, 0.14, 0.14, shipX, DECK_Y + 25.4, mastZ), box(3.4, 0.1, 0.1, shipX, DECK_Y + 27.1, mastZ), box(1.6, 0.5, 1.6, shipX, DECK_Y + 23.2, mastZ));
  shipDark.push(box(2.6, 0.08, 2.2, shipX, DECK_Y + 22.9, mastZ), rod([shipX - 0.5, DECK_Y + 19.8, mastZ + 0.9], [shipX - 0.1, DECK_Y + 25.2, mastZ + 0.1], 0.07, 6), rod([shipX + 0.5, DECK_Y + 19.8, mastZ + 0.9], [shipX + 0.1, DECK_Y + 25.2, mastZ + 0.1], 0.07, 6));
  for (let i = 0; i < 14; i += 1) shipDark.push(box(0.5, 0.03, 0.03, shipX, DECK_Y + 20 + i * 0.36, mastZ + 0.86 - i * 0.052));
  for (const x of [-2.5, 2.5]) shipDark.push(rod([shipX + x, DECK_Y + 25.4, mastZ], [shipX + x * 4.4, DECK_Y + 18.4, mastZ + 2.6], 0.018, 4));
  // Stern rail, ensign staff, winches with rope on their drums, bitts and fairleads on the mooring deck.
  shipDark.push(box(20, 0.08, 0.08, shipX, DECK_Y + 1.1, -4.3), box(20, 0.05, 0.05, shipX, DECK_Y + 0.6, -4.3), rod([shipX + 2.4, DECK_Y, -4.3], [shipX + 2.4, DECK_Y + 4.2, -4.0], 0.04, 6));
  for (let i = 0; i <= 10; i += 1) shipDark.push(box(0.06, 1.1, 0.06, shipX - 10 + i * 2, DECK_Y + 0.55, -4.3));
  for (const x of [30.6, 44.4]) {
    shipDark.push(box(2.4, 0.5, 1.4, x, DECK_Y + 0.25, -5.6), box(0.25, 1.3, 1.2, x - 1.05, DECK_Y + 0.65, -5.6), box(0.25, 1.3, 1.2, x + 1.05, DECK_Y + 0.65, -5.6), cyl(0.62, 0.08, x - 0.9, DECK_Y + 0.95, -5.6, "x", 16), cyl(0.62, 0.08, x + 0.9, DECK_Y + 0.95, -5.6, "x", 16));
    put(B.rope, cyl(0.46, 1.7, x, DECK_Y + 0.95, -5.6, "x", 16), 0xffffff);
  }
  for (const [x, z] of [[28.0, -4.9], [28.9, -4.9], [27.1, -7.4], [27.1, -8.3], [27.1, -11.2], [27.1, -12.1]]) shipDark.push(cyl(0.2, 0.75, x, DECK_Y + 0.37, z, "y", 10), cyl(0.26, 0.06, x, DECK_Y + 0.74, z, "y", 10));
  // Sheer rail and coaming down the port side, a rubbing strake, scuppers, and portholes in the quarters.
  for (const rail of [0.45, 0.8, 1.15]) shipDark.push(box(0.05, 0.05, 91, portX + 0.12, DECK_Y + rail, -52.5));
  for (let z = -7; z > -98; z -= 2.6) shipDark.push(box(0.05, 1.15, 0.05, portX + 0.12, DECK_Y + 0.57, z));
  shipDark.push(box(0.3, 1.3, 78, portX + 0.75, DECK_Y + 0.65, -66.5), box(0.24, 0.3, 93, portX - 0.1, 4.3, -52), box(0.2, 0.24, 93, portX - 0.08, 7.9, -52));
  for (let z = -7; z > -98; z -= 7) shipDark.push(box(0.1, 0.2, 0.55, portX - 0.03, DECK_Y - 0.42, z), box(0.14, 0.05, 0.65, portX - 0.05, DECK_Y - 0.54, z));
  for (let i = 0; i < 9; i += 1) {
    const z = -6.4 - i * 2.1, y = 9.6;
    shipDark.push(new THREE.TorusGeometry(0.21, 0.045, 6, 14).rotateY(Math.PI / 2).translate(portX - 0.03, y, z));
    const pane = cyl(0.2, 0.02, portX - 0.03, y, z, "x", 14);
    if (random() < 0.45) put(B.glow, pane, 0xffc27a, 1.1 + random()); else B.glazing.push(pane);
  }
  // Funnel casing vents and ladder.
  for (const y of [2.2, 5.0]) put(B.ironFar, box(2.6, 1.1, 0.06, shipX - 1.6, DECK_Y + y, -4.28));
  for (let i = 0; i < 20; i += 1) shipDark.push(box(0.42, 0.03, 0.03, shipX + 2.6, DECK_Y + 0.4 + i * 0.4, -4.26));
  shipDark.push(box(0.04, 8.2, 0.04, shipX + 2.38, DECK_Y + 4.1, -4.26), box(0.04, 8.2, 0.04, shipX + 2.82, DECK_Y + 4.1, -4.26));
  // Enclosed lifeboat in gravity davits on the port side of the boat deck.
  {
    const y = DECK_Y + 2 * DECK_RISE, boatX = housePort - 1.25, boatZ = houseZ + 0.6;
    const boat = new THREE.CapsuleGeometry(0.95, 4.2, 6, 14);
    boat.rotateX(Math.PI / 2); boat.scale(1, 1.05, 1); boat.translate(boatX, y + 1.75, boatZ);
    put(B.paintFar, boat, 0xd4551c);
    put(B.paintFar, box(1.3, 0.5, 2.2, boatX, y + 2.75, boatZ - 0.6), 0xd4551c);
    for (let i = 0; i < 4; i += 1) B.glazing.push(quad(0.42, 0.26, boatX - 0.66, y + 2.78, boatZ - 1.35 + i * 0.5, "x-"));
    put(B.paintFar, box(0.5, 0.06, 5.4, boatX, y + 1.2, boatZ), 0xe9e4d6);
    for (const z of [boatZ - 2.3, boatZ + 2.3]) {
      shipWhite.push(box(0.28, 3.3, 0.34, housePort - 0.5, y + 1.65, z));
      shipWhite.push(rod([housePort - 0.5, y + 3.2, z], [boatX - 0.2, y + 4.3, z], 0.13, 6), rod([boatX - 0.2, y + 4.3, z], [boatX, y + 3.85, z], 0.11, 6));
      shipDark.push(rod([boatX, y + 3.85, z + 0.0], [boatX, y + 2.75, z > boatZ ? z - 0.4 : z + 0.4], 0.02, 4), box(0.5, 0.5, 0.4, housePort - 0.5, y + 0.25, z));
    }
  }
  // Free-fall lifeboat on its ramp at the stern.
  const lifeboat = new THREE.CapsuleGeometry(1.15, 4.6, 6, 14);
  lifeboat.rotateZ(Math.PI / 2 - 0.3);
  lifeboat.translate(shipX + 6.4, DECK_Y + 2.7, -5.3);
  put(B.paintFar, lifeboat, 0xc9541a);
  for (const z of [-5.9, -4.7]) shipDark.push(rod([shipX + 3.4, DECK_Y + 0.6, z], [shipX + 9.6, DECK_Y + 2.5, z], 0.09, 6), box(0.14, 2.1, 0.14, shipX + 8.8, DECK_Y + 1.05, z), box(0.14, 0.8, 0.14, shipX + 4.4, DECK_Y + 0.4, z));
  // The ship's own crane abaft the first bay: pedestal, slewing cab, jib topped up over the cargo.
  {
    const px = 30.4, pz = -24.6, top = DECK_Y + 10.4, lift = 0.36, jib = 23;
    shipWhite.push(cyl(1.0, 9.6, px, DECK_Y + 4.8, pz, "y", 18, 0.8), cyl(1.25, 0.3, px, DECK_Y + 9.7, pz, "y", 18), box(3, 3, 3.4, px, top + 1.2, pz + 0.3), box(0.4, 3.6, 0.4, px - 0.9, top + 4.2, pz + 1.5), box(0.4, 3.6, 0.4, px + 0.9, top + 4.2, pz + 1.5), box(2.2, 0.3, 0.3, px, top + 6, pz + 1.5));
    B.glazing.push(quad(2.2, 1.2, px, top + 1.7, pz - 1.41, "z-"), quad(1.8, 1.2, px - 1.51, top + 1.7, pz - 0.4, "x-"));
    const tip: V3 = [px, top + 0.4 + Math.sin(lift) * jib, pz - 1.4 - Math.cos(lift) * jib];
    for (const x of [-0.55, 0.55]) {
      shipWhite.push(rod([px + x, top + 0.4, pz - 1.4], [tip[0] + x * 0.5, tip[1], tip[2]], 0.17, 6), rod([px + x, top + 1.5, pz - 1.4], [tip[0] + x * 0.5, tip[1], tip[2]], 0.1, 6));
      shipDark.push(rod([px + x * 1.6, top + 6, pz + 1.5], [tip[0] + x * 0.5, tip[1] + 0.2, tip[2] + 0.6], 0.03, 4));
    }
    for (let i = 1; i < 9; i += 1) {
      const t = i / 9, y0 = top + 0.4 + (tip[1] - top - 0.4) * t, z0 = pz - 1.4 + (tip[2] - pz + 1.4) * t, spread = 0.55 - 0.275 * t;
      shipWhite.push(rod([px - spread, y0, z0], [px + spread, y0, z0], 0.06, 5), rod([px + (i % 2 ? spread : -spread), y0, z0], [px + (i % 2 ? -spread : spread) * 0.95, y0 + (tip[1] - top - 0.4) / 9, z0 + (tip[2] - pz + 1.4) / 9], 0.045, 5));
    }
    shipDark.push(rod(tip, [tip[0], tip[1] - 5.2, tip[2]], 0.03, 4), box(0.5, 0.9, 0.3, tip[0], tip[1] - 5.6, tip[2]));
    put(B.paintFar, box(0.52, 0.3, 0.32, tip[0], tip[1] - 5.5, tip[2]), 0xd9a51f);
    put(B.glow, new THREE.SphereGeometry(0.13, 8, 6).translate(tip[0], tip[1] + 0.3, tip[2]), 0xff2a1c, 3);
  }
  // Lashing bridges between the bays, and crossed lashing rods on the face of the working bay.
  for (const z of [-27.45, ...bays.slice(0, 5).map((bay) => bay - 6.55)]) {
    for (let i = 0; i <= 8; i += 1) shipDark.push(box(0.22, 5.5, 0.34, 27.47 + i * 2.51, DECK_Y + 2.75, z));
    for (const y of [2.7, 5.4]) shipDark.push(box(20.4, 0.1, 0.62, shipX, DECK_Y + y, z), box(20.4, 0.04, 0.04, shipX, DECK_Y + y + 1.0, z - 0.3), box(20.4, 0.04, 0.04, shipX, DECK_Y + y + 0.5, z - 0.3));
  }
  for (let across = 0; across < 8; across += 1) {
    const x = 28.72 + across * 2.51, z = bays[0] + LONG / 2 + 0.05;
    for (const side of [-1, 1]) put(B.ironFar, rod([x + side * 1.12, DECK_Y + 0.05, z + 0.22], [x - side * 1.12, DECK_Y + TIER + 0.1, z], 0.022, 4));
  }
  const shipWhiteMesh = far(new THREE.Mesh(tinted(projectUv(merge(shipWhite), 3), HOUSE_WHITE), paintAny));
  shipWhiteMesh.castShadow = true; shipWhiteMesh.receiveShadow = true;
  far(new THREE.Mesh(projectUv(merge(shipDark), 3), metals.darkMetal)).receiveShadow = true;
  const shipMarkMap = track(shipMarks());
  shipMarkMap.anisotropy = anisotropy;
  far(new THREE.Mesh(merge(shipPaint), new THREE.MeshStandardMaterial({ map: shipMarkMap, color: 0xd9d5c8, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.6, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))).receiveShadow = true;
  const funnelAt: V3 = [shipX, DECK_Y + 8.6, -6.6];
  const funnelPart = (bottom: number, top: number, r0: number, r1: number, material: THREE.Material) => {
    const geometry = new THREE.CylinderGeometry(r1, r0, top - bottom, 24);
    geometry.scale(1, 1, 0.78);
    if (material === paintAny) tinted(projectUv(geometry, 3), HOUSE_WHITE);
    far(new THREE.Mesh(geometry, material), [funnelAt[0], funnelAt[1] + (bottom + top) / 2, funnelAt[2]]);
  };
  funnelPart(0, 3.4, 2.5, 2.4, paintAny);
  funnelPart(3.4, 5.6, 2.4, 2.34, new THREE.MeshStandardMaterial({ color: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.8), roughness: 0.55, metalness: 0.1 }));
  funnelPart(5.6, 7.2, 2.34, 2.3, iron);
  for (const [x, z, h] of [[-0.8, 0.3, 1.5], [0.2, -0.5, 1.9], [0.9, 0.5, 1.2]]) put(B.ironFar, cyl(0.3, h, shipX + x, funnelAt[1] + 7.2 + h / 2, funnelAt[2] + z, "y", 10));
  const radar = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 0.22), metals.brushed);
  radar.position.set(shipX, DECK_Y + 23.56, mastZ);
  scene.add(radar);
  kit.updates.push((now) => { radar.rotation.y = now * 0.0021; });
  // Navigation and deck lights: masthead, port sidelight, stern light, crosstree floods.
  const navLights: Array<[V3, number]> = [
    [[shipX, DECK_Y + 28.7, mastZ], 0xfff2d8], [[26.1, DECK_Y + 17.4, bridgeZ - 2.6], 0xff3526], [[shipX, DECK_Y + 1.6, -4.2], 0xfff2d8],
    [[shipX - 2.5, DECK_Y + 25.2, mastZ], 0xfff2d8], [[shipX + 2.5, DECK_Y + 25.2, mastZ], 0xfff2d8], [[shipX - 1.6, DECK_Y + 27, mastZ], 0xff3526],
  ];
  for (const [position, colour] of navLights) put(B.glow, new THREE.SphereGeometry(0.16, 10, 8).translate(...position), colour, 4);
  halos.push({ position: [shipX, DECK_Y + 1.6, -4.1], colour: 0xfff2d8, gain: 0.5 }, { position: [26, DECK_Y + 17.4, bridgeZ - 2.6], colour: 0xff3526, gain: 0.5 }, { position: [shipX - 2.5, DECK_Y + 25.1, mastZ], colour: COLD, gain: 0.8 });
  // Floods under the bridge wing wash the side deck and the quarter of the hull.
  put(B.glow, box(0.5, 0.1, 0.3, portX + 0.6, bridgeY - 1.52, bridgeZ), COLD, 4);
  halos.push({ position: [portX + 0.6, bridgeY - 1.7, bridgeZ], colour: COLD, gain: 0.8 });
  put(B.pools, quad(12, 16, portX - 0.05, 6.5, -13, "x-"), 0xffe2c0, 0.13);

  // ---- Quay cranes ---------------------------------------------------------
  const craneX = 18.5, BOOM_Y = 33.95;
  const frames: THREE.BufferGeometry[] = [], gear: THREE.BufferGeometry[] = [], cabins: THREE.BufferGeometry[] = [], spreaders: THREE.BufferGeometry[] = [];
  const whiteLamps: THREE.BufferGeometry[] = [], warmLamps: THREE.BufferGeometry[] = [], beacons: THREE.BufferGeometry[] = [], flashers: THREE.BufferGeometry[] = [];
  const crane = (zc: number, raised: boolean, trolley: number, load: number | null, live = false) => {
    const at = (x: number, y: number, z: number): V3 => [craneX + x, y, zc + z];
    const b = (into: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number) => into.push(box(w, h, d, craneX + x, y, zc + z));
    for (const sx of [-4.9, 4.9]) {
      for (const sz of [-7, 7]) {
        // Bogie: equaliser beam on two trucks, flanged wheels on the rail, buffers, and a travel beacon.
        b(gear, 0.9, 0.5, 3.5, sx, 1.08, sz);
        b(spreaders, 0.94, 1.3, 0.94, sx, 2.0, sz);
        for (const truck of [-0.9, 0.9]) {
          b(gear, 0.66, 0.42, 1.5, sx, 0.62, sz + truck);
          for (const wheel of [-0.42, 0.42]) gear.push(cyl(0.3, 0.14, craneX + sx, 0.3, zc + sz + truck + wheel, "x", 14), cyl(0.34, 0.03, craneX + sx - 0.06, 0.3, zc + sz + truck + wheel, "x", 14));
        }
        for (const end of [-1, 1]) gear.push(cyl(0.13, 0.3, craneX + sx, 0.95, zc + sz + end * 1.9, "z", 10), cyl(0.2, 0.06, craneX + sx, 0.95, zc + sz + end * 2.06, "z", 10));
        flashers.push(new THREE.SphereGeometry(0.11, 8, 6).translate(craneX + sx - 0.3, 1.5, zc + sz + Math.sign(sz) * 1.5));
        halos.push({ position: at(sx - 0.3, 1.5, sz + Math.sign(sz) * 1.5), colour: STRIKE_ORANGE, gain: 0.3 });
        // A flood on each leg keeps the quay under the portal lit.
        warmLamps.push(box(0.5, 0.1, 0.34, craneX + sx - Math.sign(sx) * 0.62, 9.4, zc + sz));
        gear.push(box(0.6, 0.2, 0.44, craneX + sx - Math.sign(sx) * 0.62, 9.52, zc + sz));
        halos.push({ position: at(sx - Math.sign(sx) * 0.62, 9.2, sz), colour: SODIUM, gain: 0.55 });
        put(B.floorPools, quad(13, 13, craneX + sx - Math.sign(sx) * 1.5, 0.03, zc + sz, "y+"), SODIUM, 0.085);
        b(frames, 0.9, 13.5, 0.9, sx, 7.85, sz);
        b(frames, 0.8, 18.6, 0.8, sx, 23.9, sz);
      }
      b(frames, 0.8, 1.0, 14, sx, 1.6, 0);
      b(frames, 0.9, 1.2, 14.9, sx, 14, 0);
      if (sx < 0) {
        b(frames, 0.9, 1.2, 14.9, sx, 32.6, 0);
        frames.push(rod(at(sx, 14.6, -7), at(sx, 32, 7), 0.24, 8));
      } else {
        // The waterside frame stands open above the portal beam, since every box passes through it: its top tie rides
        // over the girders instead of under them, on knees that keep clear of the load.
        b(frames, 0.9, 1.0, 14.9, sx, BOOM_Y + 1.3, 0);
        for (const sz of [-7, 7]) { b(frames, 0.8, 2.6, 0.8, sx, 34.5, sz); frames.push(rod(at(sx, 30, sz), at(sx, BOOM_Y + 0.9, sz * 0.66), 0.2, 8)); }
      }
    }
    for (const sz of [-7, 7]) {
      b(frames, 10.7, 1.2, 0.9, 0, 14, sz);
      b(frames, 10.7, 1.0, 0.8, 0, 32.6, sz);
      frames.push(rod(at(-4.9, 14.6, sz), at(4.9, 32, sz), 0.24, 8));
      warmLamps.push(box(0.7, 0.12, 0.3, craneX - 2.4, 13.34, zc + sz), box(0.7, 0.12, 0.3, craneX + 2.4, 13.34, zc + sz));
      halos.push({ position: at(0, 13.2, sz), colour: SODIUM, gain: 0.5 });
    }
    // Stair tower up the landside leg nearest the range, then a caged ladder to the boom.
    {
      const sx = -4.9 - 1.0, legZ = 7;
      for (let flight = 0; flight < 4; flight += 1) {
        const y0 = 1.2 + flight * 3.2, y1 = y0 + 3.2, z0 = legZ - (flight % 2 ? 4.4 : 0.8), z1 = legZ - (flight % 2 ? 0.8 : 4.4);
        for (const side of [-0.36, 0.36]) {
          frames.push(rod(at(sx + side, y0, z0), at(sx + side, y1, z1), 0.05, 5), rod(at(sx + side, y0 + 1, z0), at(sx + side, y1 + 1, z1), 0.028, 5));
          frames.push(rod(at(sx + side, y1, z1), at(sx + side, y1 + 1, z1), 0.028, 5));
        }
        for (let tread = 1; tread <= 9; tread += 1) { const t = tread / 10; b(gear, 0.7, 0.03, 0.26, sx, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t); }
        b(gear, 1.9, 0.06, 1.0, sx + 0.5, y1, z1 + (flight % 2 ? 0.55 : -0.55));
        frames.push(rod(at(sx - 0.4, y1 + 1, z1 + (flight % 2 ? 1.0 : -1.0)), at(sx + 0.4, y1 + 1, z1 + (flight % 2 ? 1.0 : -1.0)), 0.028, 5));
      }
      for (const side of [-0.22, 0.22]) frames.push(rod(at(-4.9 - 0.52, 14.6, legZ + side), at(-4.9 - 0.52, 32.2, legZ + side), 0.03, 5));
      for (let rung = 0; rung < 36; rung += 1) b(gear, 0.03, 0.03, 0.44, -4.9 - 0.52, 14.9 + rung * 0.48, legZ);
      for (let hoop = 0; hoop < 12; hoop += 1) frames.push(new THREE.TorusGeometry(0.36, 0.018, 4, 10).rotateX(Math.PI / 2).translate(craneX - 4.9 - 0.82, 17 + hoop * 1.3, zc + legZ));
      // Portal walkway rails, and the cable reel that pays the feeder out along the quay.
      for (const side of [-1, 1]) {
        frames.push(rod(at(-4.9 + side * 0.4, 15.7, -7), at(-4.9 + side * 0.4, 15.7, 7), 0.03, 5));
        for (let post = 0; post <= 7; post += 1) frames.push(rod(at(-4.9 + side * 0.4, 14.6, -7 + post * 2), at(-4.9 + side * 0.4, 15.7, -7 + post * 2), 0.025, 4));
      }
      gear.push(cyl(1.25, 0.08, craneX - 5.75, 3.6, zc - 2.5, "x", 22), cyl(1.25, 0.08, craneX - 6.2, 3.6, zc - 2.5, "x", 22), cyl(0.5, 0.5, craneX - 5.97, 3.6, zc - 2.5, "x", 14));
      b(frames, 0.5, 2.2, 0.3, -5.6, 2.5, -2.5);
      put(B.rubber, cyl(1.05, 0.34, craneX - 5.97, 3.6, zc - 2.5, "x", 22));
      put(B.rubber, rod(at(-5.97, 2.55, -2.5), at(-5.97, 0.02, -2.9), 0.04, 5));
    }
    // Back reach and the machinery house riding on it.
    const hinge = 5.9, boomY = BOOM_Y, reach = 28, tilt = raised ? 1.36 : 0;
    for (const sz of [-2.6, 2.6]) b(frames, 20.4, 1.5, 0.7, hinge - 10.2, boomY, sz);
    for (const x of [-14, -9, -4, 1]) b(frames, 0.3, 0.3, 5.2, x, boomY - 0.5, 0);
    b(cabins, 9, 4.2, 6.6, -8.6, boomY + 2.85, 0);
    b(gear, 9.4, 0.18, 7, -8.6, boomY + 5.04, 0);
    b(spreaders, 9.03, 0.45, 6.63, -8.6, boomY + 1.05, 0);
    for (const sz of [-1, 1]) {
      for (const x of [-11.4, -8.6, -5.8]) { b(gear, 1.9, 1.3, 0.08, x, boomY + 3.3, sz * 3.31); for (let slat = 0; slat < 5; slat += 1) b(frames, 1.8, 0.05, 0.12, x, boomY + 2.8 + slat * 0.25, sz * 3.34); }
      frames.push(rod(at(-13.1, boomY + 6.1, sz * 3.4), at(-4.1, boomY + 6.1, sz * 3.4), 0.03, 5));
      for (let post = 0; post <= 4; post += 1) frames.push(rod(at(-13.1 + post * 2.25, boomY + 5.1, sz * 3.4), at(-13.1 + post * 2.25, boomY + 6.1, sz * 3.4), 0.025, 4));
    }
    b(gear, 0.08, 2.0, 0.9, -13.11, boomY + 1.9, 1.6);
    gear.push(cyl(0.22, 1.6, craneX - 11.5, boomY + 5.9, zc - 1.6, "y", 10), cyl(0.22, 1.6, craneX - 10.7, boomY + 5.9, zc - 1.6, "y", 10));
    for (const x of [-14, -9, -4]) frames.push(rod(at(x, boomY - 0.5, x === -9 ? 2.6 : -2.6), at(x + 5, boomY - 0.5, x === -9 ? -2.6 : 2.6), 0.1, 5));
    // The boom proper, built from its hinge so it can be raised.
    const boom: THREE.BufferGeometry[] = [], boomLamps: THREE.BufferGeometry[] = [];
    for (const sz of [-2.6, 2.6]) {
      boom.push(box(reach, 1.5, 0.7, reach / 2, 0, sz), box(reach, 0.06, 0.06, reach / 2, 1.9, sz * 1.1));
      for (let i = 0; i <= 14; i += 1) boom.push(box(0.06, 1.15, 0.06, i * 2, 1.33, sz * 1.1));
    }
    for (let x = 2; x < reach; x += 4) boom.push(box(0.3, 0.3, 5.2, x, 0.5, 0), box(0.3, 0.3, 5.2, x, -0.5, 0));
    for (let x = 2; x < reach - 4; x += 4) boom.push(rod([x, 0.5, (x / 4) % 2 < 1 ? -2.6 : 2.6], [x + 4, 0.5, (x / 4) % 2 < 1 ? 2.6 : -2.6], 0.09, 5));
    for (const sz of [-2.1, 2.1]) boom.push(box(reach, 0.14, 0.16, reach / 2, -0.82, sz));
    for (let x = 1; x < reach; x += 2) boom.push(rod([x, 0.75, 2.86], [x + 1, 1.9, 2.86], 0.025, 4), rod([x + 1, 1.9, 2.86], [x + 2, 0.75, 2.86], 0.025, 4));
    if (!raised && !live) for (let x = 1.2; x < trolley - hinge - 1.5; x += 1.6) boom.push(hang([x, -0.95, -2.95], [x + 1.6, -0.95, -2.95], 0.75, 0.035, 8));
    for (const x of [5, 13, 21]) boomLamps.push(box(0.6, 0.12, 0.34, x, -0.84, -2.6), box(0.6, 0.12, 0.34, x, -0.84, 2.6));
    const swing = new THREE.Matrix4().makeTranslation(craneX + hinge, boomY, zc).multiply(new THREE.Matrix4().makeRotationZ(tilt));
    boom.forEach((part) => frames.push(part.applyMatrix4(swing)));
    boomLamps.forEach((part) => whiteLamps.push(part.applyMatrix4(swing)));
    const onBoom = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z).applyMatrix4(swing).toArray() as V3;
    for (const x of [5, 13, 21]) halos.push({ position: onBoom(x, -1, 0), colour: COLD, gain: raised ? 0.3 : 0.75 });
    // A-frame, stays and beacons.
    const apex = (sz: number) => at(3.4, 51, sz * 1.5);
    for (const sz of [-1, 1]) {
      frames.push(rod(at(4.9, 33.2, sz * 7), apex(sz), 0.3, 8), rod(at(-4.9, 33.2, sz * 7), apex(sz), 0.24, 8));
      frames.push(rod(apex(sz), at(-13.6, boomY + 0.75, sz * 2.6), 0.09), rod(apex(sz), onBoom(raised ? 9 : 13, 0.75, sz * 2.6), 0.09));
      if (!raised) frames.push(rod(apex(sz), onBoom(26, 0.75, sz * 2.6), 0.09));
      beacons.push(new THREE.SphereGeometry(0.22, 10, 8).translate(...apex(sz)).translate(0, 0.6, 0));
    }
    b(frames, 0.7, 0.7, 3.8, 3.4, 51, 0);
    beacons.push(new THREE.SphereGeometry(0.22, 10, 8).translate(...onBoom(reach - 0.4, 1.2, 0)));
    // Trolley, driver's cab, and the spreader on its falls. The working crane's are built apart, so they can move.
    if (live) return;
    b(gear, 3.2, 0.8, 5.6, trolley, boomY - 1.15, 0);
    b(gear, 2.1, 2.1, 1.9, trolley + 0.2, boomY - 2.6, 2.0);
    for (const sx of [-1.3, 1.3]) for (const sz of [-2.1, 2.1]) gear.push(cyl(0.26, 0.2, craneX + trolley + sx, boomY - 0.72, zc + sz, "z", 12));
    b(spreaders, 3.3, 0.16, 5.7, trolley, boomY - 1.6, 0);
    B.glazing.push(quad(1.5, 1.2, craneX + trolley + 0.2, boomY - 2.75, zc + 2.96, "z+"), quad(1.7, 1.5, craneX + trolley + 1.26, boomY - 2.65, zc + 2.0, "x+"), quad(1.6, 1.5, craneX + trolley + 0.2, boomY - 3.66, zc + 2.0, "y+").rotateX(Math.PI).translate(0, 2 * (boomY - 3.66), 2 * (zc + 2.0)));
    b(whiteLamps, 0.05, 0.75, 1.5, trolley - 0.87, boomY - 2.45, 2.0);
    if (load !== null) {
      const spreaderY = load + CH + 0.2;
      b(spreaders, 1.2, 0.3, 11.9, trolley, spreaderY, 0);
      b(spreaders, 1.8, 0.7, 2.6, trolley, spreaderY + 0.5, 0);
      for (const sz of [-1.6, 1.6]) gear.push(cyl(0.4, 0.14, craneX + trolley, spreaderY + 1.05, zc + sz, "z", 14));
      for (const sx of [-1.2, 1.2]) for (const sz of [-5.95, 5.95]) { b(gear, 0.14, 0.5, 0.2, trolley + sx, spreaderY - 0.3, sz + Math.sign(sz) * 0.2); b(spreaders, 0.3, 0.4, 0.06, trolley + sx, spreaderY - 0.2, sz + Math.sign(sz) * 0.33); }
      for (const sz of [-1, 1]) {
        b(spreaders, 2.5, 0.3, 0.36, trolley, spreaderY, sz * 5.95);
        for (const sx of [-1, 1]) gear.push(rod(at(trolley + sx, spreaderY + 0.15, sz * 2.3), at(trolley + sx, boomY - 1.5, sz * 2.3), 0.035));
      }
      letterSide(stow(LONG, craneX + trolley, load, zc, ALONG_Z, 1), 1);
    }
  };
  crane(bays[0], false, 15.24, null, true);
  crane(-66, true, -1.5, null);
  crane(bays[5], false, 10.2, null);
  // The near crane is working the half-discharged bay: one box, out of the ship and down to the quay, then back aboard,
  // for as long as anybody watches. Trolley, falls, spreader and box are the only parts of the cranes that move; none of
  // them throws a shadow, because the sun's was drawn once.
  {
    const zc = bays[0], DARK = 0x24272a;
    const X_SHIP = 15.24, X_QUAY = 0, H_SHIP = DECK_Y + 0.02 + TIER, H_QUAY = 0.03, H_HIGH = 25.6, H_PARK = 21.5, H_START = DECK_Y + 9.4;
    const trolley = new THREE.Group();
    trolley.position.set(craneX + X_SHIP, BOOM_Y, zc);
    const body: Array<[THREE.BufferGeometry, number]> = [[box(3.2, 0.8, 5.6, 0, -1.15, 0), DARK], [box(2.1, 2.1, 1.9, 0.2, -2.6, 2.0), DARK], [box(3.3, 0.16, 5.7, 0, -1.6, 0), GEAR_YELLOW]];
    for (const sx of [-1.3, 1.3]) for (const sz of [-2.1, 2.1]) body.push([cyl(0.24, 0.2, sx, -0.76, sz, "z", 12), DARK]);
    trolley.add(steel(body));
    trolley.add(new THREE.Mesh(merge([quad(1.5, 1.2, 0.2, -2.75, 2.96, "z+"), quad(1.7, 1.5, 1.26, -2.65, 2.0, "x+"), quad(1.6, 1.5, 0.2, -3.66, 2.0, "y+").rotateX(Math.PI).translate(0, -7.32, 4)]), glazing));
    trolley.add(new THREE.Mesh(merge([box(0.05, 0.75, 1.5, -0.87, -2.45, 2.0), box(0.5, 0.06, 0.3, -1.1, -1.71, -1.3), box(0.5, 0.06, 0.3, 1.1, -1.71, -1.3)]), coldLamp));
    // Everything below the trolley hangs from this point and swings about it.
    const hung = new THREE.Group();
    hung.position.set(0, -1.5, 0);
    trolley.add(hung);
    const falls = steel([-1, 1].flatMap((sx) => [-2.3, 2.3].map((sz): [THREE.BufferGeometry, number] => [cyl(0.035, 1, sx, -0.5, sz, "y", 6), DARK])));
    hung.add(falls);
    const spreader = new THREE.Group();
    const frame: Array<[THREE.BufferGeometry, number]> = [[box(1.2, 0.3, 11.9, 0, 0, 0), GEAR_YELLOW], [box(1.8, 0.7, 2.6, 0, 0.5, 0), GEAR_YELLOW]];
    for (const sz of [-1.6, 1.6]) frame.push([cyl(0.4, 0.14, 0, 1.05, sz, "z", 14), DARK]);
    for (const sz of [-1, 1]) {
      frame.push([box(2.5, 0.3, 0.36, 0, 0, sz * 5.95), GEAR_YELLOW]);
      for (const sx of [-1.2, 1.2]) frame.push([box(0.14, 0.5, 0.2, sx, -0.3, sz * 6.15), DARK], [box(0.3, 0.4, 0.06, sx, -0.2, sz * 6.28), GEAR_YELLOW]);
    }
    spreader.add(steel(frame));
    hung.add(spreader);
    // The box itself, lettered on both sides.
    const held = new THREE.Group();
    const carried = new THREE.InstancedMesh(containerGeometry(LONG, 1), boxPaint, 1);
    carried.setMatrixAt(0, new THREE.Matrix4());
    carried.setColorAt(0, swatch.setHex(LINES[1].paint));
    carried.rotation.y = ALONG_Z;
    const from = marks.length, lone: Stowed = { length: LONG, x: 0, y: 0, z: 0, yaw: ALONG_Z, line: 1, near: false };
    letterSide(lone, 1); letterSide(lone, -1);
    held.add(carried, new THREE.Mesh(merge(marks.splice(from)), lettering));
    held.position.set(0, -CH - 0.2, 0);
    spreader.add(held);
    // The festoon that feeds the trolley: its loops close up as the trolley comes in and pay out as it goes.
    const LOOPS = 10, ANCHOR = -3, LOOP = 2.3;
    const festoon = new THREE.Mesh(merge(Array.from({ length: LOOPS }, (_, i) => hang([i, 0, 0], [i + 1, 0, 0], 1, 0.045, 8))), rubber);
    festoon.position.set(craneX + ANCHOR, BOOM_Y - 0.95, zc - 2.95);
    scene.add(trolley, festoon);
    // Floods under the trolley, and the amber lamp that turns whenever it travels or hoists.
    lampHalo(trolley, [[-1.1, -1.8, -1.3], [1.1, -1.8, -1.3]].map((position) => ({ position: position as V3, colour: COLD, gain: 0.75 })));
    const amber = lampHalo(trolley, [[-1.7, -1.4, -2.9], [1.7, -1.4, 2.9]].map((position) => ({ position: position as V3, colour: STRIKE_ORANGE, gain: 1 })));

    // The work, as moves of the trolley (track 0, metres out along the boom) and of the hoist (track 1, height of the
    // box's foot), with the moments the twistlocks take hold and the box lands.
    type Move = { track: 0 | 1; from: number; to: number; t0: number; t1: number };
    type Mark = { t: number; what: "motor" | "lock" | "land" };
    const across = (from: number, to: number, t0: number, t1: number): Move => ({ track: 0, from, to, t0, t1 });
    const hoist = (from: number, to: number, t0: number, t1: number): Move => ({ track: 1, from, to, t0, t1 });
    const job = (moves: Move[], marks: Mark[]) => {
      // The motors are heard a breath before anything moves, and again while a long move lasts.
      let last = -9;
      for (const move of moves) for (let t = Math.max(0, move.t0 - 1.2); t < move.t1 - 2.5; t += 6.4) if (t - last >= 4.4) { marks.push({ t, what: "motor" }); last = t; }
      marks.sort((a, b) => a.t - b.t);
      return { moves, marks, length: moves[moves.length - 1].t1 + 0.4 };
    };
    const FIRST = job([hoist(H_START, H_HIGH, 1.2, 4.6), across(X_SHIP, X_QUAY, 3.4, 12.6), hoist(H_HIGH, H_QUAY, 10.6, 23.8), hoist(H_QUAY, H_PARK, 25.8, 31.6)], [{ t: 23.8, what: "land" }]);
    const LOAD = job([hoist(H_PARK, H_QUAY, 1.2, 7.4), hoist(H_QUAY, H_HIGH, 9, 21.6), across(X_QUAY, X_SHIP, 19.4, 28.6), hoist(H_HIGH, H_SHIP, 26.6, 34.4), hoist(H_SHIP, H_PARK, 36.4, 39.6)], [{ t: 7.6, what: "lock" }, { t: 34.4, what: "land" }]);
    const DISCHARGE = job([hoist(H_PARK, H_SHIP, 1.2, 4.2), hoist(H_SHIP, H_HIGH, 5.8, 12.6), across(X_SHIP, X_QUAY, 10.6, 19.8), hoist(H_HIGH, H_QUAY, 17.8, 31), hoist(H_QUAY, H_PARK, 33, 39)], [{ t: 4.4, what: "lock" }, { t: 31, what: "land" }]);
    let playing = FIRST, start = -1, mark = 0, last = -1;
    let x0 = X_SHIP, h0 = H_START, x = X_SHIP, speed = 0, swing = 0, swung = 0, holding = true, entered = false;
    const heard = new THREE.Vector3();
    kit.updates.push((now) => {
      const t = now / 1000;
      // The first box is on its way within a few seconds of the range loading, and if the crane is standing idle when
      // somebody walks in (the pointer locks to the canvas at that moment) the next lift starts there and then.
      if (last < 0) { last = t; start = t + 4.5; }
      if (!entered && document.pointerLockElement === kit.renderer.domElement) { entered = true; start = Math.min(start, t + 3.5); }
      const dt = Math.min(0.05, Math.max(0, t - last)), at = t - start;
      last = t;
      let nx = x0, nh = h0, moving = false;
      if (at >= 0) {
        for (let i = 0; i < playing.moves.length; i += 1) {
          const move = playing.moves[i];
          if (at < move.t0) continue;
          const u = Math.min(1, (at - move.t0) / (move.t1 - move.t0)), value = move.from + (move.to - move.from) * u * u * u * (u * (u * 6 - 15) + 10);
          if (move.track) nh = value; else nx = value;
          if (u < 1) moving = true;
        }
        while (mark < playing.marks.length && at >= playing.marks[mark].t) {
          const what = playing.marks[mark].what;
          mark += 1;
          if (what === "motor") { cue?.("craneMotor", heard.set(craneX + nx, BOOM_Y - 2, zc), { gain: 1, pitch: 0.92 + chance() * 0.16 }); continue; }
          // Twistlocks home on a box that is standing, or a box set down and let go: either way steel meets steel.
          holding = what === "lock";
          swing = 0; swung = 0;
          if (holding) { spreader.add(held); held.position.set(0, -CH - 0.2, 0); } else { scene.add(held); held.position.set(craneX + nx, nh, zc); }
          cue?.("containerClang", heard.set(craneX + nx, nh + 1.3, zc), holding ? { gain: 0.5, pitch: 1.25 + chance() * 0.15 } : { gain: 1, pitch: 0.9 + chance() * 0.15 });
        }
        if (at >= playing.length) { x0 = nx; h0 = nh; playing = playing === LOAD ? DISCHARGE : LOAD; start = t + 24 + chance() * 22; mark = 0; }
      }
      // The load swings on its falls: it lags the trolley as that gets away, overruns as it brakes, and leans to the wind.
      const drop = BOOM_Y - 1.5 - (nh + CH + 0.35), reach = Math.max(3, drop) + (holding ? 1.6 : 0.3);
      if (dt > 0) {
        const rate = (nx - x) / dt, push = THREE.MathUtils.clamp((rate - speed) / dt, -2, 2);
        speed = rate;
        swung += (-9.81 * swing - 0.45 * push + wind.direction.x * wind.at(craneX + nx, zc) * 0.14) / reach * dt - swung * 0.3 * dt;
        swing = THREE.MathUtils.clamp(swing + swung * dt, -0.07, 0.07);
      }
      x = nx;
      trolley.position.x = craneX + x;
      hung.rotation.z = swing;
      falls.scale.y = Math.max(0.2, drop);
      spreader.position.y = -Math.max(0.2, drop) - 0.15;
      const loop = (x - 1.6 - ANCHOR) / LOOPS;
      festoon.scale.set(loop, Math.sqrt(Math.max(0.05, LOOP * LOOP / 4 - loop * loop / 4)), 1);
      amber.color.setScalar(moving && Math.sin(t * 9) > 0 ? 1.2 : 0.04);
    });
  }
  const craneMeshes = [
    new THREE.Mesh(tinted(projectUv(merge(frames), 3), CRANE_GREY), paintAny), new THREE.Mesh(projectUv(merge(gear), 3), metals.darkMetal),
    new THREE.Mesh(tinted(projectUv(merge(cabins), 3), HOUSE_WHITE), paintAny), new THREE.Mesh(tinted(projectUv(merge(spreaders), 2), GEAR_YELLOW), paintAny),
    new THREE.Mesh(merge(whiteLamps), coldLamp), new THREE.Mesh(merge(warmLamps), sodiumLamp),
  ];
  craneMeshes.forEach((mesh) => { far(mesh); mesh.receiveShadow = false; });
  // The cranes stand in the last light and throw their shadow across the ship.
  craneMeshes[0].castShadow = true; craneMeshes[0].receiveShadow = true;
  const flasherGlow = emissive(STRIKE_ORANGE, 4);
  far(new THREE.Mesh(merge(flashers), flasherGlow));
  kit.updates.push((now) => { const on = Math.sin(now * 0.0074) > 0.2 ? 1 : 0.12; flasherGlow.color.set(STRIKE_ORANGE).multiplyScalar(4.5 * on); });
  const beaconGlow = emissive(0xff2a1c, 4);
  far(new THREE.Mesh(merge(beacons), beaconGlow));
  kit.updates.push((now) => {
    const pulse = 0.2 + 0.8 * Math.pow(Math.max(0, Math.sin(now * 0.0028)), 5);
    beaconGlow.color.setRGB(5.5 * pulse, 0.5 * pulse, 0.3 * pulse);
  });
  // Crane rails let into the quay, and the paint that keeps people off them.
  const linePaint = new THREE.MeshStandardMaterial({ color: 0xb8891c, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const x of [13.6, 23.4]) {
    far(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 173), metals.brushed), [x, 0.012, -68.5]);
    for (const side of [-0.75, 0.75]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 173), linePaint);
      stripe.rotation.x = -Math.PI / 2;
      stripe.receiveShadow = true;
      far(stripe, [x + side, 0.004, -68.5]);
      kit.mirrorHidden.push(stripe);
    }
  }

  // ---- Quay edge and water ---------------------------------------------------
  const hazardMap = track(canvasTexture(128, 32, (context) => {
    context.fillStyle = "#c9951c"; context.fillRect(0, 0, 128, 32);
    context.fillStyle = "#15120e";
    for (let x = -32; x < 128; x += 32) { context.beginPath(); context.moveTo(x, 32); context.lineTo(x + 16, 32); context.lineTo(x + 48, 0); context.lineTo(x + 32, 0); context.closePath(); context.fill(); }
  }, true));
  hazardMap.repeat.set(160, 1);
  hazardMap.anisotropy = anisotropy;
  far(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 250), new THREE.MeshStandardMaterial({ map: hazardMap, roughness: 0.8, metalness: 0 })), [QUAY_EDGE - 0.21, 0.12, -30]);
  const quayFace = far(new THREE.Mesh(worldBox(0.5, 3.4, 250, 3), quayWall), [QUAY_EDGE - 0.25, -1.75, -30]);
  kit.mirrorHidden.push(quayFace);
  const bollardSpots: V3[] = [];
  for (let z = 30; z > -124; z -= 11.5) bollardSpots.push([QUAY_EDGE - 1.15, 0, z]);
  instances(bollardGeometry(), iron, bollardSpots.map((position) => ({ position })), false);
  instances(cleatGeometry(), iron, [[QUAY_EDGE - 1.2, 0, 7.4], [QUAY_EDGE - 1.2, 0, 2.2], [QUAY_EDGE - 1.2, 0, -9.6]].map((position, index) => ({ position: position as V3, rotation: [0, Math.PI / 2 + index * 0.05, 0] as V3 })), false);
  // Fenders between ship and quay.
  const fender = new THREE.CapsuleGeometry(0.72, 2.6, 6, 14);
  fender.rotateX(Math.PI / 2);
  const fenders = instances(fender, rubber, [-12, -38, -64, -90].map((z) => ({ position: [QUAY_EDGE + 0.76, -1.5, z] as V3 })), false, false);
  kit.mirrorHidden.push(fenders);
  // Mooring lines sag to the bollards, each with a rat guard, an eye dropped over every bollard in use.
  const moor = (bollardZ: number, from: V3) => {
    const to: V3 = [QUAY_EDGE - 1.15, 0.5, bollardZ], sag = Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]) * 0.05;
    const at = (t: number): V3 => [to[0] + (from[0] - to[0]) * t, to[1] + (from[1] - to[1]) * t - sag * 4 * t * (1 - t), to[2] + (from[2] - to[2]) * t];
    put(B.rope, hang(to, from, sag, 0.05, 22));
    put(B.rope, new THREE.TorusGeometry(0.27, 0.05, 6, 16).rotateX(Math.PI / 2).translate(to[0], 0.46, to[2]));
    put(B.ironFar, rod(at(0.8), at(0.805), 0.42, 14));
  };
  moor(7, [28.0, DECK_Y + 0.4, -4.75]); moor(18.5, [28.9, DECK_Y + 0.4, -4.75]); moor(7, [26.62, DECK_Y + 0.2, -7.85]); moor(-4.5, [26.62, DECK_Y + 0.2, -8.3]); moor(-16, [26.62, DECK_Y + 0.2, -11.65]);
  const clock = { value: 0 };
  kit.updates.push((now) => { clock.value = now / 1000; });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(540, 940), new THREE.ShaderMaterial({ ...WATER_SHADER, uniforms: { time: clock } }));
  water.rotation.x = -Math.PI / 2;
  far(water, [QUAY_EDGE + 269.5, WATER_Y, 40]);
  kit.mirrorHidden.push(water);

  // ---- Quay shed behind the firing line ---------------------------------------
  const shedTop = 7.6, shedZ = 9.7 + 3.4;
  place(new THREE.Mesh(worldBox(26, shedTop, 6.8, 2.6), sheeting), 0, shedTop / 2, shedZ, true, true);
  place(new THREE.Mesh(softBox(26.12, 0.5, 6.92, 0.02, 2.4), concrete), 0, 0.25, shedZ, false, true);
  place(new THREE.Mesh(softBox(26.6, 0.2, 7.5, 0.03, 3), metals.darkMetal), 0, shedTop + 0.1, shedZ, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(25.6, 0.04, 0.03), amberTube), 0, shedTop - 0.08, 9.68, false);
  place(new THREE.Mesh(softBox(1.3, 2.3, 0.09, 0.02, 1.4), metals.darkMetal), 8.4, 1.15, 9.69, false, true);
  put(B.green, softBox(1.04, 2.12, 0.06, 0.015, 1.6).translate(8.4, 1.08, 9.665));
  place(new THREE.Mesh(softBox(0.16, 0.05, 0.05, 0.012, 1), metals.brushed), 8.02, 1.05, 9.62, false);
  place(new THREE.Mesh(softBox(0.42, 0.14, 0.1, 0.03, 1), metals.darkMetal), 8.4, 2.52, 9.66, false);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.03), sodiumLamp), 8.4, 2.5, 9.605, false);
  instances(new THREE.CylinderGeometry(0.055, 0.055, shedTop - 0.5, 10), metals.brushed, [-7.3, 7.3, -12.4, 12.4].map((x) => ({ position: [x, 0.5 + (shedTop - 0.5) / 2, 9.63] as V3 })), false, false);
  const berthSign = track(canvasTexture(512, 192, (context) => {
    context.fillStyle = "#10243a"; context.fillRect(0, 0, 512, 192);
    context.strokeStyle = "#d8d4c4"; context.lineWidth = 6; context.strokeRect(10, 10, 492, 172);
    context.fillStyle = "#d8d4c4"; context.textAlign = "center"; context.textBaseline = "middle";
    context.font = "700 96px 'Helvetica Neue', Arial, sans-serif"; context.fillText("QUAY B", 256, 78);
    context.font = "500 27px 'Helvetica Neue', Arial, sans-serif"; context.fillText("PLANT HERE  ·  HEAVY PLANT ONLY", 256, 146, 400);
  }));
  berthSign.anisotropy = anisotropy;
  place(new THREE.Mesh(softBox(2.3, 0.9, 0.05, 0.012, 1.4), metals.darkMetal), -8.3, 2.7, 9.68, false, true);
  const berthFace = place(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.82), new THREE.MeshStandardMaterial({ map: berthSign, roughness: 0.5, metalness: 0.1 })), -8.3, 2.7, 9.65, false);
  berthFace.rotation.y = Math.PI;

  // ---- Transit warehouse behind the shed -------------------------------------
  const hallTop = 20, hallZ = 19.6, hallX = -4.8, hallWide = 58.4;
  far(new THREE.Mesh(worldBox(hallWide, hallTop, 26, 3.2), hallSkin), [hallX, hallTop / 2, hallZ + 13]).receiveShadow = true;
  far(new THREE.Mesh(softBox(hallWide + 0.6, 0.5, 26.6, 0.05, 4), metals.darkMetal), [hallX, hallTop + 0.25, hallZ + 13]);
  far(new THREE.Mesh(worldBox(hallWide + 0.2, 1.1, 26.2, 3), concrete), [hallX, 0.55, hallZ + 13]);
  const hallSign = track(canvasTexture(2048, 256, (context) => {
    context.clearRect(0, 0, 2048, 256);
    context.fillStyle = "#e4e0d2"; context.textAlign = "center"; context.textBaseline = "middle";
    context.font = "700 158px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("10 000 CASES", 1024, 92, 2000);
    context.font = "600 60px 'Helvetica Neue', Arial, sans-serif";
    context.fillText("K E Y S   S O L D   S E P A R A T E L Y", 1024, 212, 2000);
    context.globalCompositeOperation = "destination-out";
    const next = rng(404);
    for (let x = 0; x < 2048; x += 26) { context.fillStyle = "rgba(0,0,0,.35)"; context.fillRect(x, 0, 5, 256); }
    for (let i = 0; i < 2400; i += 1) { context.fillStyle = `rgba(0,0,0,${0.3 + next() * 0.7})`; context.fillRect(next() * 2048, next() * 256, 2 + next() * 8, 2 + next() * 14); }
  }));
  hallSign.anisotropy = anisotropy;
  const hallLetters = new THREE.Mesh(new THREE.PlaneGeometry(30, 3.75), new THREE.MeshStandardMaterial({ map: hallSign, transparent: true, depthWrite: false, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  hallLetters.rotation.y = Math.PI;
  far(hallLetters, [0, 12.2, hallZ - 0.02]);
  // A clerestory strip under the eaves, some bays lit, and loading doors either side of the shed.
  const bayLit: Transform[] = [], bayDark: Transform[] = [];
  for (let i = 0; i < 12; i += 1) (random() < 0.45 ? bayLit : bayDark).push({ position: [hallX - 25.6 + i * 4.66, 16.9, hallZ - 0.03] });
  instances(new THREE.BoxGeometry(3.9, 1.3, 0.1), emissive(0xffc27a, 1.5), bayLit, false, false);
  instances(new THREE.BoxGeometry(3.9, 1.3, 0.1), new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 0.25, metalness: 0.4 }), bayDark, false, false);
  for (const x of [-27.4, -19.4, 19.6]) put(B.paintFar, box(6.4, 6.6, 0.16, x, 3.3, hallZ - 0.02), 0x1a242e);

  // ---- Floodlight masts and barriers at the firing point ----------------------
  const mastTop = 15;
  instances(softBox(0.6, 4.7, 0.6, 0.04, 2.2), concrete, [-1, 1].map((side) => ({ position: [side * 9.84, 2.35, 3.5] as V3 })));
  // Hazard collar, base flange and a switch box on each pedestal.
  const collarMap = track(hazardTexture());
  collarMap.repeat.set(2, 1);
  collarMap.anisotropy = anisotropy;
  instances(new THREE.BoxGeometry(0.63, 0.34, 0.63), new THREE.MeshStandardMaterial({ map: collarMap, roughness: 0.7, metalness: 0 }), [-1, 1].map((side) => ({ position: [side * 9.84, 1.25, 3.5] as V3 })), false, false);
  instances(softBox(0.78, 0.12, 0.78, 0.02, 1.4), metals.darkMetal, [-1, 1].flatMap((side) => [0.06, 4.74].map((y) => ({ position: [side * 9.84, y, 3.5] as V3 }))), false);
  for (const side of [-1, 1]) {
    // Isolator: enclosure with a lipped door, a red handle on its yellow plate, glands into the conduit above.
    const x = side * 9.5, out = -side;
    put(B.smooth, softBox(0.1, 0.44, 0.3, 0.012, 1).translate(x, 1.9, 3.5), 0x8d9296);
    put(B.smooth, softBox(0.02, 0.4, 0.26, 0.008, 1).translate(x + out * 0.056, 1.9, 3.5), 0x979ca0);
    put(B.smooth, box(0.006, 0.12, 0.12, x + out * 0.068, 1.93, 3.5), 0xd9a51f);
    put(B.smooth, box(0.03, 0.022, 0.085, x + out * 0.082, 1.93, 3.5), 0xb3241c);
    put(B.brushed, cyl(0.014, 0.028, x + out * 0.07, 1.93, 3.5, "x", 8));
    for (const z of [3.385, 3.615]) put(B.iron, cyl(0.008, 0.07, x + out * 0.052, 2.0, z, "y", 6));
    put(B.brushed, cyl(0.026, 0.05, side * 9.52, 2.14, 3.42, "y", 8));
  }
  instances(new THREE.CylinderGeometry(0.02, 0.02, 2.5, 8), metals.brushed, [-1, 1].map((side) => ({ position: [side * 9.52, 3.4, 3.42] as V3 })), false, false);
  instances(new THREE.CylinderGeometry(0.09, 0.15, mastTop - 4.7, 12), metals.structural, [-1, 1].map((side) => ({ position: [side * 9.84, (mastTop + 4.7) / 2, 3.5] as V3 })), false);
  instances(softBox(2.4, 0.1, 0.12, 0.02, 1), metals.structural, [-1, 1].map((side) => ({ position: [side * 9.5, mastTop, 3.5] as V3 })), false);
  const heads: Transform[] = [], lenses: Transform[] = [];
  for (const side of [-1, 1]) for (const offset of [-0.85, 0, 0.85]) {
    const x = side * 9.5 + offset, turn: V3 = [0.5, 0, -side * 0.45];
    heads.push({ position: [x, mastTop - 0.2, 3.5], rotation: turn });
    lenses.push({ position: [x - side * 0.045, mastTop - 0.305, 3.5 - 0.05], rotation: turn });
  }
  instances(softBox(0.6, 0.2, 0.46, 0.04, 1), metals.darkMetal, heads, false);
  instances(new THREE.BoxGeometry(0.5, 0.03, 0.38), coldLamp, lenses, false, false);
  for (const side of [-1, 1]) halos.push({ position: [side * 9.5, mastTop - 0.4, 3.5], colour: COLD, gain: 1 });
  const barrier = jerseyBarrier(2.8);
  instances(barrier, concrete, [-1, 1].flatMap((side) => [1.8, 5.25, 8.15].map((z) => ({ position: [side * 9.86, 0, z] as V3, rotation: [0, Math.PI / 2, 0] as V3 }))));
  // Lamps on the stacks: sodium bulkheads on the sides, a white flood over the far end.
  const bracket = (x: number, y: number, z: number, lamp: THREE.Material, along: "x" | "z", colour: number, gain: number) => {
    const turn = along === "z" ? 0 : Math.PI / 2, out = along === "z" ? [Math.sign(-x) * 0.22, 0] : [0, 0.22];
    const body = place(new THREE.Mesh(softBox(0.2, 0.2, 0.62, 0.04, 1), metals.darkMetal), x + out[0], y, z + out[1], false);
    body.rotation.y = turn;
    const lens = place(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.54), lamp), x + out[0], y - 0.115, z + out[1], false);
    lens.rotation.y = turn;
    const arm = place(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.05), metals.structural), x + out[0] / 2, y + 0.06, z + out[1] / 2, false);
    arm.rotation.y = along === "z" ? 0 : Math.PI / 2;
    halos.push({ position: [x + out[0], y - 0.16, z + out[1]], colour, gain });
    if (along === "z") { put(B.pools, quad(2.9, 2.9, Math.sign(x) * 9.522, y - 0.85, z, x < 0 ? "x+" : "x-"), colour, 0.3); put(B.floorPools, quad(9, 9, x * 0.8, 0.03, z, "y+"), colour, 0.15); }
    else { put(B.pools, quad(7, 7, x, y - 2.7, -28.41, "z+"), colour, 0.15); put(B.floorPools, quad(9, 9, x, 0.03, -25.4, "y+"), colour, 0.09); }
  };
  bracket(-9.5, 3 * TIER - 0.3, -15, sodiumLamp, "z", SODIUM, 0.7);
  bracket(9.5, 2 * TIER - 0.3, -21.4, sodiumLamp, "z", SODIUM, 0.6);
  bracket(-9.5, 2 * TIER - 0.3, -25.6, sodiumLamp, "z", SODIUM, 0.5);
  bracket(-4.2, 3 * TIER - 0.3, -28.4, coldLamp, "x", COLD, 0.8);
  bracket(4.2, 3 * TIER - 0.3, -28.4, coldLamp, "x", COLD, 0.8);
  // Brand light: a mint strip under the top rail on the left, amber on the right.
  place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 11.6), mintTube), -9.5, 0.2, -5.8, false);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 11.6), amberTube), 9.5, 0.2, -5.8, false);

  // ---- High masts and far lights ------------------------------------------------
  const highMasts: Array<[number, number, number]> = [[-34, -22, 30], [-30, 16, 28], [-38, -62, 32], [3, -44, 30], [-66, -8, 34], [-64, 44, 32], [16.5, 34, 26], [-10, -86, 32]];
  instances(new THREE.CylinderGeometry(0.16, 0.34, 1, 10), metals.structural, highMasts.map(([x, z, h]) => ({ position: [x, h / 2, z] as V3, scale: [1, h, 1] as V3 })), false, false);
  instances(new THREE.CylinderGeometry(1.5, 1.5, 0.3, 12), metals.darkMetal, highMasts.map(([x, z, h]) => ({ position: [x, h, z] as V3 })), false, false);
  instances(new THREE.CylinderGeometry(1.42, 1.42, 0.06, 12), coldLamp, highMasts.map(([x, z, h]) => ({ position: [x, h - 0.19, z] as V3 })), false, false);
  highMasts.forEach(([x, z, h], index) => halos.push({ position: [x, h - 0.4, z], colour: index % 3 === 2 ? SODIUM : COLD, gain: 1.5 }));
  // ---- Apron paint outside the lane -----------------------------------------
  const paintMap = track(apronPaint());
  paintMap.anisotropy = anisotropy;
  const painted: THREE.BufferGeometry[] = [];
  const stencil = (cell: [number, number, number, number], w: number, d: number, x: number, z: number, turn: number) => {
    const quad = new THREE.PlaneGeometry(w, d);
    const [px, py, pw, ph] = cell, uv = quad.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (px + uv.getX(i) * pw) / 1024, 1 - (py + (1 - uv.getY(i)) * ph) / 1024);
    quad.rotateX(-Math.PI / 2);
    quad.rotateY(turn);
    quad.translate(x, 0.005, z);
    painted.push(quad);
  };
  stencil([0, 0, 512, 512], 5.4, 5.4, -14.4, 1.2, 0);
  stencil([512, 0, 512, 256], 3.6, 1.8, -24.6, -3.4, Math.PI / 2);
  stencil([512, 256, 512, 256], 3.6, 1.8, -21.2, 8.3, Math.PI / 2);
  // Where the heavy plant parks: two lines off the tractor's nose, drawn long as road markings are so they read from the
  // lane; the yellow one lies in the mouth of the alley beside the box row, where somebody would otherwise wait.
  stencil([0, 512, 512, 256], 2.7, 1.6, 19.4, 8.15, -Math.PI / 2);
  stencil([512, 512, 512, 256], 2.7, 1.6, 17.8, 8.15, -Math.PI / 2);
  stencil([0, 768, 512, 256], 4.2, 2.1, 15.6, -3, -Math.PI / 2);
  stencil([512, 768, 512, 256], 2.3, 2.4, 15.8, 0.55, -Math.PI / 2);
  const paintedMesh = new THREE.Mesh(merge(painted), new THREE.MeshStandardMaterial({ map: paintMap, transparent: true, depthWrite: false, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  paintedMesh.receiveShadow = true;
  far(paintedMesh);
  kit.mirrorHidden.push(paintedMesh);

  // ---- Props ---------------------------------------------------------------
  // Loose cargo comes from the shared props library, filed here by kind and drawn as one batch each. Nothing stands
  // where the player can walk (|x| < 8.9, z from -24.95 to 8.3): lane props keep to the strip under each wall and the
  // corners past the end boards, the rest lies on the aprons behind the barriers.
  const dressed = new Map<PropKind, PropItem[]>();
  const prop = (kind: PropKind, x: number, y: number, z: number, yaw = 0, more: Partial<PropItem> = {}) => {
    const item: PropItem = { position: [x, y, z], rotation: [0, yaw, 0], ...more };
    const list = dressed.get(kind);
    if (list) list.push(item); else dressed.set(kind, [item]);
  };
  /** The same, in the frame of something set down at a spot and heading (as `stage` does for built parts). */
  const propsAt = (x0: number, z0: number, heading: number, y0 = 0) => {
    const c = Math.cos(heading), s = Math.sin(heading);
    return (kind: PropKind, x: number, y: number, z: number, yaw = 0, more: Partial<PropItem> = {}) => prop(kind, x0 + x * c + z * s, y0 + y, z0 - x * s + z * c, heading + yaw, more);
  };
  const tall = (kind: PropKind) => props.get(kind).size[1];
  const PALLET = tall("pallet"), CRATE = tall("crateLarge"), SLAT = tall("crateSlat"), FISH_BOX = tall("cratePlastic"), CARTON = tall("carton"), CARTON_L = tall("cartonLarge"), SACK = tall("sackLying");
  const QUARTER = Math.PI / 2, scatter = rng(4051), loose = (range: number) => (scatter() - 0.5) * range;
  // Drums wear the colours of the lines whose boxes stand around them.
  const TEAL = 0x1c6a5c, OXIDE = 0x7e2d22, NAVY = 0x1f426c, MUSTARD = 0xb58c22, BLUE = 0x1b4f9c, ORANGE = 0xd4551c, BONE = 0xd9d5c8;
  /** A pallet stood on its long edge against a lane wall (`side` = ±1), `lean` radians up from the ground. */
  const leant = (side: number, z: number, lean: number, yaw = 0, variant = 0) =>
    prop("pallet", side * (9.5 - Math.cos(lean) * 0.6), Math.sin(lean) * 0.6, z, 0, { rotation: [0, yaw, side * lean], variant });

  // East wall, walking away from the firing point: two pallets on edge with crates at their foot, drums short of the
  // furnace, sacks off a coaster under the far sign, and what got pushed into the corner past the end boards.
  leant(1, -4.56, 1.4, 0.02);
  leant(1, -3.63, 1.3, -0.03, 1);
  prop("crateSlat", 9.23, 0, -5.52, QUARTER + 0.1);
  prop("cratePlastic", 9.24, SLAT, -5.49, -QUARTER + 0.28, { tint: ORANGE });
  prop("drum", 9.18, 0, -7.3, -1.2, { tint: TEAL, variant: 0 });
  prop("drum", 9.17, 0, -7.98, -2.4, { tint: OXIDE, variant: 2 });
  prop("drumPlastic", 9.17, 0, -8.72, -QUARTER + 0.3, { tint: 0x173f7a });
  prop("sack", 9.24, 0, -14.55, -QUARTER + 0.08);
  prop("sack", 9.22, 0, -15.13, -QUARTER - 0.1, { variant: 2 });
  prop("sack", 9.25, 0, -15.74, 0, { rotation: [0.1, -QUARTER + 0.05, 0] });
  prop("sackLying", 9.2, 0, -16.52, QUARTER + 0.07);
  leant(1, -25.9, 1.385, 0.02, 1);
  prop("keg", 9.2, 0, -26.75, 0.6);
  // West wall: drums and bottle crates opposite the first station, range stores under the lamp, a pallet at the far sign.
  prop("drum", -9.17, 0, -6.08, 1.9, { tint: MUSTARD, variant: 1 });
  prop("drum", -9.18, 0, -5.4, 0.7, { tint: NAVY, variant: 3 });
  [BLUE, BLUE, ORANGE].forEach((tint, tier) => prop("cratePlastic", -9.27 + loose(0.02), tier * FISH_BOX, -4.66 + loose(0.03), QUARTER + loose(0.16), { tint }));
  prop("crateAmmo", -9.3, 0, -14.4, QUARTER + 0.04);
  prop("crateAmmo", -9.29, tall("crateAmmo"), -14.45, QUARTER - 0.05, { variant: 2 });
  prop("crateSmall", -9.22, 0, -15.5, QUARTER + 0.06);
  prop("carton", -9.22, tall("crateSmall"), -15.46, QUARTER - 0.3);
  prop("keg", -9.26, 0, -16.2, 2.2);
  leant(-1, -20.6, 1.396, 0.02);
  prop("drumPlastic", -9.18, 0, -21.5, QUARTER + 0.5);

  // Left apron: a stack of empties, crates off the last box, the drum store, a pallet of sacks half built.
  ([[-12.3, 1.45, 0.3], [-12.33, 1.47, 0.22], [-12.27, 1.43, 0.37], [-12.2, 1.39, 0.57]] as const).forEach(([x, z, yaw], tier) => prop("pallet", x, tier * PALLET, z, yaw, { variant: tier % 2 }));
  prop("crateLarge", -11.55, 0, 3.35, 0.08, { variant: 1 });
  prop("crateLarge", -12.82, 0, 3.02, -0.13, { variant: 3 });
  prop("crateSmall", -12.76, CRATE, 3.05, 0.5);
  prop("crateSlat", -11.5, CRATE, 3.3, -0.35);
  prop("drum", -12.15, 0, 5.3, 0.4, { tint: TEAL, variant: 1 });
  prop("drum", -12.85, 0, 5.05, 2.1, { tint: OXIDE, variant: 3 });
  prop("drum", -12.45, 0, 4.42, 4.0, { tint: NAVY, variant: 0 });
  prop("drum", -10.85, props.get("drum").size[0] / 2, 5.75, 0, { rotation: [0, 0.35, QUARTER], tint: MUSTARD, variant: 2 });
  {
    const at = propsAt(-14.3, 2.3, 0.2);
    at("pallet", 0, 0, 0, 0, { variant: 1 });
    // Three to a layer, the odd one turned and its end swapped each time so the stack ties itself together.
    for (let layer = 0; layer < 4; layer += 1) {
      const y = PALLET + layer * SACK, flip = layer % 2 ? -1 : 1;
      at("sackLying", 0.4 * flip + loose(0.03), y, loose(0.03), QUARTER + loose(0.1));
      for (const z of layer < 3 ? [-0.225, 0.225] : [-0.2]) at("sackLying", -0.2 * flip + loose(0.03), y, z + loose(0.02), loose(0.1) + (layer % 2 ? Math.PI : 0));
    }
    at("sack", 0.97, 0, -0.14, QUARTER + 0.2, { variant: 1 });
    at("sack", 1.0, 0, 0.5, -0.3);
    at("sackLying", 0.2, 0, 0.98, 0.35);
  }

  // Right apron: ship's stores on pallets short of the crane rail, a stack of empties.
  {
    // Local +z looks at the lane, so prints and stencils face the firing point.
    const stores = propsAt(12.7, 7.6, -QUARTER + 0.04), deck = PALLET;
    stores("pallet", 0, 0, 0);
    for (let tier = 0; tier < 3; tier += 1) for (const x of [-0.245, 0.245]) for (const z of [-0.18, 0.18]) {
      if (tier < 2 || x < 0) stores("carton", x + loose(0.02), deck + tier * CARTON, z + loose(0.02), loose(0.07));
    }
    stores("cartonFlat", 0.26, deck + 2 * CARTON, 0.02, 0.5);
    const chemicals = propsAt(15.3, 4.35, 0.1);
    chemicals("pallet", 0, 0, 0, 0, { variant: 1 });
    chemicals("drumPlastic", -0.31, deck, 0, -QUARTER - 0.3, { tint: BLUE, variant: 0 });
    chemicals("drumPlastic", 0.31, deck, 0.02, -QUARTER + 0.5, { tint: BLUE, variant: 1 });
    const spares = propsAt(15.55, 5.9, -QUARTER + 0.15);
    spares("pallet", 0, 0, 0);
    spares("crateLarge", 0.02, deck, 0, 0.03, { variant: 0 });
    spares("crateSlat", 0.12, deck + CRATE, -0.04, 0.5);
  }
  ([[16.2, 2.2, -0.2], [16.23, 2.17, -0.12], [16.18, 2.22, -0.3]] as const).forEach(([x, z, yaw], tier) => prop("pallet", x, tier * PALLET, z, yaw, { variant: (tier + 1) % 2 }));
  // The end of the quay the inshore boats use: fish boxes stacked wet, casks, kegs, slatted crates.
  ([[21.25, 8.72, 5, 0.1, BLUE], [21.7, 8.66, 3, -0.06, ORANGE], [21.42, 8.28, 1, 0.5, BONE]] as const).forEach(([x, z, count, yaw, tint]) => {
    for (let tier = 0; tier < count; tier += 1) prop("cratePlastic", x + loose(0.016), tier * FISH_BOX, z + loose(0.016), yaw + loose(0.08), { tint: count === 5 && tier === 3 ? ORANGE : tint });
  });
  prop("cratePlastic", 20.75, FISH_BOX, 8.12, 0, { rotation: [Math.PI, 0.8, 0], tint: BLUE });
  prop("cask", 22.55, 0, 7.6, 0.4);
  prop("cask", 22.62, 0, 6.9, 2.6, { variant: 1 });
  prop("cask", 21.2, props.get("cask").size[0] / 2, 6.6, 0, { rotation: [0, 2.6, QUARTER] });
  prop("keg", 22.6, 0, 4.6, 0.3); prop("keg", 22.15, 0, 4.42, 1.7); prop("keg", 22.42, 0, 4.08, 3.1);
  ([[20.9, 3.5, 0.2], [20.92, 3.48, 0.1], [20.87, 3.53, 0.33]] as const).forEach(([x, z, yaw], tier) => prop("crateSlat", x, tier * SLAT, z, yaw));
  prop("crateSlat", 21.6, 0, 3.25, 0.7);

  // Cable reels are the yard's own: one on its flange with the cable still on, two rolled against things.
  instances(reelGeometry(), metals.crate, [
    { position: [-18.2, 0.62, -4.4], rotation: [0, 1.2, Math.PI / 2] },
    { position: [21.6, 0, 0.6], rotation: [0, 0.2, 0] }, { position: [22.0, 0.62, -1.7], rotation: [0, 0.7, Math.PI / 2] },
  ]);
  instances(new THREE.CylinderGeometry(0.31, 0.31, 0.6, 24, 1, true), rubber, [{ position: [21.6, 0.4, 0.6] }], false, false);

  // ---- Signs ------------------------------------------------------------------
  const signParts: THREE.BufferGeometry[] = [];
  const SIGNS = {
    gate: [0, 0, 1024, 256], reefer: [1024, 0, 1024, 256], speed: [0, 256, 512, 512], armour: [512, 256, 512, 512], fire: [1024, 256, 1024, 512], berth: [0, 768, 1024, 384],
    chickens: [1024, 768, 1024, 384], notices: [0, 1152, 1024, 512], ways: [1024, 1152, 1024, 512], muster: [0, 1664, 1024, 384], volts: [1024, 1664, 512, 384], noSmoking: [1536, 1664, 512, 384],
  } satisfies Record<string, [number, number, number, number]>;
  /** A sign from the sheet on a steel backing plate. */
  const sign = (name: keyof typeof SIGNS, w: number, x: number, y: number, z: number, facing: Exclude<Facing, "y+">, backed = true) => {
    const cell = SIGNS[name] as [number, number, number, number], h = w * cell[3] / cell[2];
    signParts.push(shade(cellUv(quad(w, h, x, y, z, facing), cell, 2048), 1));
    if (!backed) return;
    const back = facing === "z-" ? 0.02 : facing === "z+" ? -0.02 : 0, side = facing === "x-" ? 0.02 : facing === "x+" ? -0.02 : 0;
    put(B.iron, back ? box(w + 0.06, h + 0.06, 0.03, x, y, z + back) : box(0.03, h + 0.06, w + 0.06, x + side, y, z));
  };
  // A board strapped to each floodlight pedestal, high enough to walk under: livestock on the left, the way out on the right.
  sign("chickens", 2.0, -9.46, 3.1, 3.5, "x+");
  sign("ways", 2.0, 9.46, 3.25, 3.5, "x-");
  for (const side of [-1, 1]) for (const y of [2.95, 3.3]) put(B.iron, box(0.05, 0.04, 0.66, side * 9.515, y, 3.5));
  /** A lamp head: housing, glowing lens, halo, and the pool it throws, all without a real light. */
  const lantern = (x: number, y: number, z: number, colour: number, halo: number, pool: number, reach: number, w = 0.62, d = 0.3) => {
    put(B.iron, box(w + 0.08, 0.14, d + 0.08, x, y + 0.05, z));
    put(B.glow, box(w, 0.04, d, x, y - 0.035, z), colour, 3.6);
    halos.push({ position: [x, y - 0.12, z], colour, gain: halo });
    if (pool) put(B.floorPools, quad(reach, reach, x, 0.03, z, "y+"), colour, pool);
  };

  // ---- Quay edge: coping, ladders, fender chains, life-ring, lamp standards ------
  put(B.ironFar, box(0.1, 0.3, 250, QUAY_EDGE + 0.03, 0.1, -30));
  for (const z of [-12, -38, -64, -90]) for (const end of [-1.1, 1.1]) put(B.ironFar, rod([QUAY_EDGE + 0.06, 0.2, z + end], [QUAY_EDGE + 0.62, -0.86, z + end], 0.03, 5));
  for (const z of [3.6, -21.5]) {
    for (const side of [-0.23, 0.23]) put(B.smooth, tube([[24.7, 0.2, z + side], [24.7, 0.98, z + side], [24.86, 1.12, z + side], [25.1, 1.02, z + side], [25.16, 0.2, z + side], [25.16, -1.4, z + side]], 0.028, 18, 6), 0xd9a51f);
    put(B.floorPlate, quad(0.8, 0.9, 24.5, 0.012, z, "y+"));
  }
  {
    // Life-ring station facing the range.
    const set = stage(24.25, 0, 5.5, -Math.PI / 2);
    set(B.paint, box(0.08, 1.9, 0.08, 0, 0.95, 0), 0x8d9296);
    set(B.paint, box(0.82, 0.82, 0.05, 0, 1.45, 0.06), 0xa8201a);
    set(B.smooth, new THREE.TorusGeometry(0.27, 0.07, 8, 20).translate(0, 1.45, 0.14), 0xd4551c);
    for (let i = 0; i < 4; i += 1) set(B.smooth, new THREE.TorusGeometry(0.27, 0.074, 8, 4, 0.36).rotateZ(i * Math.PI / 2 + 0.6).translate(0, 1.45, 0.14), 0xe6e2d6);
    set(B.rope, hang([-0.2, 1.3, 0.16], [0.2, 1.3, 0.16], 0.28, 0.012, 10), 0xffffff);
  }
  for (const z of [2.7, -21, -52, -84]) {
    const x = 24.5;
    put(B.ironFar, cyl(0.1, 9.2, x, 4.6, z, "y", 10, 0.065));
    put(B.ironFar, cyl(0.2, 0.5, x, 0.25, z, "y", 10, 0.13));
    put(B.ironFar, tube([[x, 9.1, z], [x - 0.3, 9.5, z], [x - 1.0, 9.62, z], [x - 1.7, 9.55, z]], 0.045, 10, 6));
    lantern(x - 1.8, 9.46, z, SODIUM, 0.9, 0.13, 15, 0.3, 0.7);
    if (z < -5) put(B.pools, quad(14, 11, portX - 0.05, 4.4, z, "x-"), SODIUM, 0.16);
  }
  // Flangeways either side of each crane rail.
  for (const x of [13.6, 23.4]) for (const side of [-0.1, 0.1]) put(B.ironFar, box(0.07, 0.02, 173, x + side, 0.004, -68.5));
  // Accommodation ladder from the main deck down to the quay.
  {
    const top: V3 = [25.72, DECK_Y - 0.2, -9.2], foot: V3 = [24.25, 0.42, 0.6], steps = 32;
    const along = (t: number, dx: number, dy: number): V3 => [top[0] + (foot[0] - top[0]) * t + dx, top[1] + (foot[1] - top[1]) * t + dy, top[2] + (foot[2] - top[2]) * t];
    for (const side of [-0.38, 0.38]) {
      put(B.paint, rod(along(0, side, 0), along(1, side, 0), 0.06, 6), 0xb9bdbd);
      put(B.paint, rod(along(0, side, 1.05), along(1, side, 1.05), 0.025, 5), 0xb9bdbd);
      put(B.paint, rod(along(0, side, 0.55), along(1, side, 0.55), 0.016, 4), 0xb9bdbd);
      for (let i = 0; i <= 8; i += 1) put(B.paint, rod(along(i / 8, side, 0), along(i / 8, side, 1.05), 0.02, 4), 0xb9bdbd);
    }
    for (let i = 1; i < steps; i += 1) put(B.paint, box(0.72, 0.03, 0.24, ...along(i / steps, 0, 0.02)), 0x9fa3a3);
    put(B.paint, box(1.5, 0.08, 1.7, 25.75, DECK_Y - 0.2, -10.0), 0xb9bdbd);
    for (const z of [-10.8, -9.2]) put(B.paint, rod([25.05, DECK_Y - 0.2, z], [25.05, DECK_Y + 0.9, z], 0.022, 4), 0xb9bdbd);
    put(B.paint, rod([25.05, DECK_Y + 0.9, -10.8], [25.05, DECK_Y + 0.9, -9.2], 0.022, 4), 0xb9bdbd);
    put(B.ironFar, rod([25.6, DECK_Y - 0.2, -10], [26.6, DECK_Y + 2.6, -10.4], 0.03, 4));
    put(B.rubber, cyl(0.12, 0.8, foot[0], 0.14, foot[2] + 0.1, "x", 12));
    put(B.paint, box(1.0, 0.05, 0.9, foot[0], 0.33, foot[2] + 0.3), 0x9fa3a3);
    sign("berth", 1.3, 23.55, 1.15, 1.6, "x-");
    put(B.iron, box(0.05, 1.5, 0.05, 23.58, 0.75, 1.1)); put(B.iron, box(0.05, 1.5, 0.05, 23.58, 0.75, 2.1));
    put(B.glow, box(0.06, 0.06, 0.5, 25.0, DECK_Y + 1.2, -10), 0xffe2c0, 3);
    halos.push({ position: [24.9, DECK_Y + 1.2, -10], colour: 0xffe2c0, gain: 0.4 });
  }

  // ---- Floodlight masts at the firing point: pegs, platform, conduit, and an area lamp over each apron ----
  for (const side of [-1, 1]) {
    const x = side * 9.84, z = 3.5;
    for (let y = 5.4; y < 13.2; y += 0.42) put(B.iron, box(0.3, 0.024, 0.024, x, y, z + (Math.round(y / 0.42) % 2 ? 0.02 : -0.02)));
    put(B.iron, cyl(0.02, 8.8, x + side * 0.13, 9.1, z + 0.1, "y", 6));
    put(B.plate, cyl(0.78, 0.05, x, 13.5, z, "y", 16));
    put(B.iron, new THREE.TorusGeometry(0.78, 0.022, 5, 18).rotateX(Math.PI / 2).translate(x, 14.5, z));
    put(B.iron, new THREE.TorusGeometry(0.78, 0.018, 5, 18).rotateX(Math.PI / 2).translate(x, 14.0, z));
    for (let i = 0; i < 6; i += 1) put(B.iron, cyl(0.018, 1.0, x + Math.cos(i * Math.PI / 3) * 0.78, 14, z + Math.sin(i * Math.PI / 3) * 0.78, "y", 5));
    for (const offset of [-0.85, 0, 0.85]) put(B.iron, box(0.05, 0.22, 0.05, side * 9.5 + offset, mastTop - 0.08, z));
    put(B.iron, tube([[x, 8.0, z], [x + side * 0.5, 8.5, z], [x + side * 1.5, 8.62, z]], 0.04, 8, 6));
    lantern(x + side * 1.6, 8.52, z, SODIUM, 0.75, 0.14, 15, 0.3, 0.66);
  }
  put(B.floorPools, quad(24, 17, 0, 0.03, 3.2, "y+"), COLD, 0.045);

  // ---- Quay shed wall: gutter, cable tray, lamps, fire point, boards, cabinet ----------------
  {
    const wall = 9.7;
    put(B.iron, box(26.3, 0.16, 0.2, 0, shedTop - 0.02, wall - 0.11));
    put(B.iron, box(25.2, 0.05, 0.22, 0, 7.2, wall - 0.12));
    for (let x = -12; x <= 12; x += 2) put(B.iron, box(0.04, 0.14, 0.24, x, 7.14, wall - 0.12));
    for (const [dz, r] of [[-0.06, 0.03], [0.01, 0.022], [0.07, 0.016]]) put(B.rubber, cyl(r, 24.8, 0, 7.235 + r, wall - 0.12 + dz, "x", 6));
    for (const x of [-7.3, 7.3, -12.4, 12.4]) for (const y of [1.2, 3.4, 5.6]) put(B.iron, box(0.2, 0.04, 0.1, x, y, wall - 0.05));
    // Two floods over the chart wash the firing point; they are the lamps you stand under.
    for (const x of [-9.6, 9.6]) {
      put(B.iron, box(0.08, 0.08, 0.5, x, 6.6, wall - 0.25));
      const head = box(0.6, 0.34, 0.2, 0, 0, 0).rotateX(-0.7).translate(x, 6.5, wall - 0.52);
      put(B.iron, head);
      put(B.glow, box(0.52, 0.26, 0.02, 0, 0, -0.11).rotateX(-0.7).translate(x, 6.5, wall - 0.52), COLD, 4);
      halos.push({ position: [x, 6.4, wall - 0.7], colour: COLD, gain: 0.7 });
      put(B.pools, quad(5.6, 5.6, x, 4.4, wall - 0.012, "z-"), COLD, 0.1);
    }
    // Fire point with hose reel.
    sign("fire", 1.5, -10.7, 2.75, wall - 0.03, "z-");
    put(B.smooth, softBox(0.62, 0.95, 0.2, 0.02, 1), 0xa8201a).translate(-11.15, 1.45, wall - 0.1);
    B.glazing.push(quad(0.4, 0.5, -11.15, 1.55, wall - 0.202, "z-"));
    {
      // A swinging hose reel on its bracket: the hose wound between a solid cheek and a spoked one, the nozzle clipped below, the feed and its valve above.
      const x = -10.2, y = 1.45, back = wall - 0.07, front = wall - 0.2;
      put(B.smooth, box(0.1, 0.5, 0.05, x, y, wall - 0.025), 0x7a1712);
      put(B.smooth, cyl(0.035, 0.2, x, y, wall - 0.13, "z", 10), 0x7a1712);
      put(B.smooth, cyl(0.36, 0.012, x, y, back, "z", 28), 0xa8201a);
      for (const z of [back, front]) put(B.smooth, new THREE.TorusGeometry(0.36, 0.014, 6, 32).translate(x, y, z), 0xa8201a);
      for (let spoke = 0; spoke < 6; spoke += 1) put(B.smooth, box(0.3, 0.035, 0.01, 0.2, 0, 0).rotateZ(spoke * Math.PI / 3).translate(x, y, front), 0xa8201a);
      put(B.smooth, cyl(0.075, 0.03, x, y, front - 0.005, "z", 14), 0xa8201a);
      put(B.brushed, cyl(0.03, 0.02, x, y, front - 0.03, "z", 8));
      put(B.matte, cyl(0.26, 0.11, x, y, wall - 0.132, "z", 20), 0x7a1712);
      for (let row = 0; row < 5; row += 1) put(B.matte, new THREE.TorusGeometry(0.3 - (row % 2) * 0.012, 0.0125, 6, 28).translate(x, y, back - 0.019 - row * 0.024), 0x9a2018);
      put(B.matte, tube([[x + 0.3, y - 0.02, wall - 0.13], [x + 0.33, y - 0.3, wall - 0.12], [x + 0.2, y - 0.62, wall - 0.1], [x + 0.05, y - 0.7, wall - 0.09]], 0.0125, 14, 6), 0x9a2018);
      put(B.brushed, cyl(0.016, 0.16, x - 0.03, y - 0.7, wall - 0.09, "x", 8));
      put(B.smooth, box(0.05, 0.05, 0.08, x, y - 0.7, wall - 0.04), 0x7a1712);
      put(B.smooth, cyl(0.02, 0.75, x - 0.02, y + 0.62, wall - 0.04, "y", 8), 0xa8201a);
      put(B.brushed, cyl(0.035, 0.05, x - 0.02, y + 0.3, wall - 0.04, "y", 8));
      put(B.smooth, cyl(0.05, 0.012, x - 0.02, y + 0.3, wall - 0.085, "z", 10), 0xa8201a);
    }
    sign("muster", 2.0, -10.7, 4.0, wall - 0.03, "z-");
    sign("notices", 1.5, -8.3, 1.45, wall - 0.03, "z-");
    put(B.timber, box(1.6, 0.05, 0.06, -8.3, 1.85, wall - 0.04)); put(B.timber, box(1.6, 0.05, 0.06, -8.3, 1.05, wall - 0.04));
    // Switchgear cabinet, conduits up to the tray, hazard label, horn and camera.
    put(B.smooth, softBox(0.95, 1.5, 0.2, 0.015, 1), 0x8d9296).translate(10.7, 1.3, wall - 0.1);
    put(B.smooth, box(1.03, 0.03, 0.26, 0, 0, 0).rotateX(-0.12).translate(10.7, 2.07, wall - 0.12), 0x7f8488);
    put(B.iron, box(0.012, 1.4, 0.012, 10.7, 1.3, wall - 0.203));
    for (const leaf of [-1, 1]) {
      const x = 10.7 + leaf * 0.235;
      put(B.smooth, softBox(0.44, 1.42, 0.016, 0.006, 1).translate(x, 1.3, wall - 0.206), 0x959a9e);
      put(B.brushed, box(0.03, 0.12, 0.03, 10.7 + leaf * 0.2, 1.3, wall - 0.225));
      for (const y of [0.8, 1.3, 1.8]) put(B.brushed, cyl(0.011, 0.07, 10.7 + leaf * 0.462, y, wall - 0.208, "y", 6));
      for (let slot = 0; slot < 6; slot += 1) put(B.iron, box(0.26, 0.012, 0.004, x, 0.72 + slot * 0.034, wall - 0.2155));
    }
    sign("volts", 0.26, 10.36, 1.72, wall - 0.203, "z-", false);
    for (const x of [10.4, 10.56, 10.72, 10.98]) put(B.brushed, cyl(0.02, 5.12, x, 4.62, wall - 0.04, "y", 6));
    for (const y of [3.2, 5.4]) put(B.iron, box(0.75, 0.04, 0.05, 10.7, y, wall - 0.03));
    sign("armour", 0.42, 9.45, 2.3, wall - 0.012, "z-", false);
    sign("noSmoking", 0.42, 9.45, 1.82, wall - 0.012, "z-", false);
    sign("speed", 0.6, 11.9, 2.6, wall - 0.012, "z-", false);
    put(B.smooth, cyl(0.2, 0.34, 11.9, 5.6, wall - 0.2, "z", 14, 0.06), 0x8d9296);
    put(B.iron, box(0.06, 0.3, 0.14, 11.9, 5.75, wall - 0.07));
    put(B.smooth, new THREE.SphereGeometry(0.11, 12, 8).translate(-12.1, 6.25, wall - 0.2), 0x1a1c1e);
    put(B.smooth, box(0.14, 0.1, 0.24, -12.1, 6.36, wall - 0.12), 0xdcd8cc);
    // Louvred vent with a real set of blades.
    put(B.iron, box(1.5, 1.0, 0.04, -11.2, 5.5, wall - 0.01));
    for (let blade = 0; blade < 8; blade += 1) put(B.paint, box(1.4, 0.02, 0.1, 0, 0, 0).rotateX(0.6).translate(-11.2, 5.1 + blade * 0.115, wall - 0.05), 0x9aa39c);
    for (const [bx, by, bw, bh] of [[-11.2, 6.02, 1.56, 0.05], [-11.2, 4.98, 1.56, 0.05], [-11.96, 5.5, 0.05, 1.04], [-10.44, 5.5, 0.05, 1.04]]) put(B.paint, box(bw, bh, 0.12, bx, by, wall - 0.06), 0x9aa39c);
    // The door: frame hinges, closer, vision panel with light behind, kick plate, threshold.
    put(B.glow, quad(0.22, 0.6, 8.62, 1.55, wall - 0.068, "z-"), 0xffc27a, 1.5);
    for (const [bx, by, bw, bh] of [[8.62, 1.87, 0.3, 0.04], [8.62, 1.23, 0.3, 0.04], [8.49, 1.55, 0.04, 0.68], [8.75, 1.55, 0.04, 0.68]]) put(B.iron, box(bw, bh, 0.03, bx, by, wall - 0.068));
    put(B.brushed, box(0.9, 0.24, 0.012, 8.4, 0.2, wall - 0.068));
    for (const y of [0.3, 1.1, 1.9]) put(B.brushed, cyl(0.016, 0.13, 8.93, y, wall - 0.075, "y", 6));
    put(B.iron, box(0.34, 0.05, 0.07, 8.6, 2.1, wall - 0.09));
    put(B.plate, box(1.3, 0.03, 0.2, 8.4, 0.015, wall - 0.1));
    put(B.pools, quad(3.4, 3.2, 8.4, 1.5, wall - 0.014, "z-"), SODIUM, 0.2);
    halos.push({ position: [8.4, 2.45, wall - 0.14], colour: SODIUM, gain: 0.35 });
  }
  // Loading doors of the transit shed: slats, guides, a number lamp over each.
  for (const x of [-27.4, -19.4, 19.6]) {
    for (let slat = 0; slat < 16; slat += 1) put(B.ironFar, box(6.3, 0.05, 0.05, x, 0.4 + slat * 0.4, hallZ - 0.12));
    for (const side of [-3.25, 3.25]) put(B.ironFar, box(0.16, 6.8, 0.2, x + side, 3.4, hallZ - 0.1));
    put(B.glow, box(1.4, 0.14, 0.1, x, 7.2, hallZ - 0.1), 0xffd9a8, 2.6);
    halos.push({ position: [x, 7.1, hallZ - 0.3], colour: SODIUM, gain: 0.6 });
    put(B.pools, quad(9, 9, x, 4.4, hallZ - 0.14, "z-"), SODIUM, 0.17);
  }

  // ---- Rails the range signs hang on, so they sit on the boxes and not in front of them ------
  for (const [side, y, z, w, h] of [[-1, 2.45, -11, 4.8, 2.1], [1, 2.45, -23, 4.8, 2.1], [-1, 2.6, -17, 4.6, 1.15], [1, 2.6, -17, 4.6, 1.15]]) {
    for (const along of [-0.32, 0.32]) {
      put(B.iron, box(0.05, h + 0.6, 0.07, side * 9.512, y + 0.1, z + along * w));
      for (const dy of [-0.3, 0.3]) put(B.brushed, cyl(0.022, 0.03, side * 9.498, y + dy * h, z + along * w, "x", 6));
    }
    put(B.rubber, tube([[side * 9.5, y + h / 2 + 0.05, z + w * 0.4], [side * 9.5, y + h / 2 + 0.5, z + w * 0.42], [side * 9.52, 2 * TIER - 0.2, z + w * 0.45]], 0.014, 8, 4));
  }

  // ---- Gatehouse cabin on the left apron, lights on and somebody's tea going cold ---------
  {
    const W = 6, D = 2.5, base = 0.2, top = 2.8;
    const set = stage(-20.6, 0, 1.2, Math.PI / 2);
    const wall = (x0: number, x1: number, y0: number, y1: number) => set(B.green, box(x1 - x0, y1 - y0, 0.06, (x0 + x1) / 2, (y0 + y1) / 2, D / 2 - 0.03));
    wall(-3, -2.4, base, top); wall(-2.4, -0.6, base, 1.0); wall(-2.4, -0.6, 2.1, top); wall(-0.6, 0.3, base, top); wall(0.3, 1.2, 2.25, top);
    wall(1.2, 1.6, base, top); wall(1.6, 2.6, base, 1.0); wall(1.6, 2.6, 2.1, top); wall(2.6, 3, base, top);
    set(B.green, box(W, top - base, 0.06, 0, (top + base) / 2, -D / 2 + 0.03));
    for (const end of [-1, 1]) set(B.green, box(0.06, top - base, D - 0.12, end * (W / 2 - 0.03), (top + base) / 2, 0));
    // Pressed ribs, corner posts, roof with a drip edge, skids and a step.
    for (let x = -2.5; x <= 2.5; x += 0.5) set(B.green, box(0.05, top - base - 0.2, 0.025, x, (top + base) / 2, -D / 2 - 0.01));
    for (const end of [-1, 1]) for (let z = -0.75; z <= 0.75; z += 0.5) set(B.green, box(0.025, top - base - 0.2, 0.05, end * (W / 2 + 0.01), (top + base) / 2, z));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) set(B.paint, box(0.1, top - base, 0.1, sx * (W / 2 - 0.02), (top + base) / 2, sz * (D / 2 - 0.02)), 0x39473c);
    set(B.paint, box(W + 0.24, 0.1, D + 0.24, 0, top + 0.05, 0), 0x6f766f);
    set(B.paint, box(W + 0.3, 0.05, D + 0.3, 0, top - 0.02, 0), 0x39473c);
    for (const z of [-0.9, 0.9]) set(B.iron, box(W - 0.3, base, 0.16, 0, base / 2, z));
    set(B.plate, box(1.1, 0.04, 0.5, 0.75, 0.18, D / 2 + 0.27));
    set(B.iron, box(1.1, 0.18, 0.04, 0.75, 0.09, D / 2 + 0.5));
    // Windows: frames, sills, glass; the door with its own light.
    for (const [x0, x1] of [[-2.4, -0.6], [1.6, 2.6]]) {
      const cx = (x0 + x1) / 2, w = x1 - x0;
      for (const y of [1.0, 2.1]) set(B.paint, box(w + 0.1, 0.06, 0.1, cx, y, D / 2 - 0.03), 0xdcd8cc);
      for (const x of [x0, x1, ...(w > 1.2 ? [cx] : [])]) set(B.paint, box(0.05, 1.1, 0.1, x, 1.55, D / 2 - 0.03), 0xdcd8cc);
      set(B.paint, box(w + 0.16, 0.03, 0.14, cx, 0.97, D / 2 + 0.03), 0xdcd8cc);
      set(B.glass, quad(w, 1.1, cx, 1.55, D / 2 - 0.03, "z+"));
    }
    set(B.paint, box(0.86, 2.0, 0.05, 0.75, 1.22, D / 2 - 0.03), 0x2c4a3c);
    set(B.glow, quad(0.5, 0.6, 0.75, 1.75, D / 2 - 0.002, "z+"), 0xffd9a8, 1.1);
    set(B.brushed, box(0.14, 0.03, 0.05, 0.45, 1.2, D / 2 + 0.02));
    for (const y of [0.5, 1.9]) set(B.iron, box(0.04, 0.14, 0.03, 1.17, y, D / 2 + 0.005));
    // Inside, painted already lit: lining, floor, strip light, desk, screen, chair, shelves, kettle, a hi-vis on its hook.
    const inside = (geometry: THREE.BufferGeometry, colour: number, gain = 1) => set(B.glow, geometry, colour, gain);
    inside(quad(W - 0.12, top - base - 0.1, 0, (top + base) / 2, -D / 2 + 0.07, "z+"), 0xb9ae8e, 0.62);
    for (const end of [-1, 1]) inside(quad(D - 0.12, top - base - 0.1, end * (W / 2 - 0.07), (top + base) / 2, 0, end > 0 ? "x-" : "x+"), 0xb9ae8e, 0.5);
    inside(quad(W - 0.12, D - 0.12, 0, base + 0.02, 0, "y+"), 0x6f6658, 0.42);
    inside(box(W - 0.12, 0.02, D - 0.12, 0, top - 0.06, 0), 0xd8d2bc, 0.6);
    inside(box(1.3, 0.05, 0.14, -1.2, top - 0.1, 0), 0xfff0d2, 3.4); inside(box(1.3, 0.05, 0.14, 1.6, top - 0.1, 0), 0xfff0d2, 3.4);
    inside(box(1.9, 0.05, 0.7, -1.5, 0.95, 0.75), 0x8b6a40, 0.7); inside(box(0.05, 0.75, 0.66, -2.4, 0.57, 0.75), 0x5a4630, 0.6); inside(box(0.05, 0.75, 0.66, -0.6, 0.57, 0.75), 0x5a4630, 0.6);
    inside(box(0.52, 0.34, 0.04, -1.7, 1.3, 0.62), 0x15181a, 0.4); inside(quad(0.48, 0.3, -1.7, 1.3, 0.598, "z-"), 0x58d8c4, 1.4); inside(box(0.06, 0.16, 0.06, -1.7, 1.05, 0.64), 0x15181a, 0.4);
    inside(box(0.34, 0.02, 0.26, -1.05, 0.985, 0.7), 0xe6e2d6, 0.8); inside(cyl(0.04, 0.09, -0.85, 1.02, 0.95, "y", 8), 0xc8401c, 0.8);
    inside(box(0.5, 0.08, 0.5, -1.6, 0.62, 0.05), 0x1c2a3a, 0.5); inside(box(0.5, 0.6, 0.07, -1.6, 0.96, -0.2), 0x1c2a3a, 0.5); inside(cyl(0.03, 0.4, -1.6, 0.4, 0.05, "y", 6), 0x15181a, 0.5);
    for (const y of [1.4, 1.8]) inside(box(1.8, 0.03, 0.26, 1.7, y, -D / 2 + 0.2), 0x8b6a40, 0.6);
    for (let i = 0; i < 11; i += 1) inside(box(0.07 + (i % 3) * 0.015, 0.3, 0.22, 0.95 + i * 0.13, i < 6 ? 1.57 : 1.97, -D / 2 + 0.2), [0x1b4f9c, 0xa8201a, 0x1d6b3c, 0xd9a51f, 0x2a2a2a][i % 5], 0.65);
    inside(box(0.5, 0.9, 0.5, 2.5, base + 0.45, -D / 2 + 0.35), 0x8d9296, 0.5); inside(cyl(0.08, 0.2, 2.5, base + 1.0, -D / 2 + 0.35, "y", 10), 0xdcd8cc, 0.8);
    inside(quad(1.2, 0.8, -1.4, 1.75, -D / 2 + 0.075, "z+"), 0xe9e5d8, 0.75);
    for (let i = 0; i < 5; i += 1) inside(quad(1.0, 0.012, -1.4, 1.5 + i * 0.12, -D / 2 + 0.08, "z+"), 0x2a2a2a, 0.6);
    inside(box(0.42, 0.6, 0.1, -2.7, 1.7, -D / 2 + 0.14), 0xe8a01c, 0.95); inside(box(0.43, 0.06, 0.11, -2.7, 1.62, -D / 2 + 0.14), 0xdcdcdc, 1.1);
    // Outside: sign, air conditioner, floodlight on the corner, aerial, downpipe, and the glow through the glass.
    const signAt = set.point(-1.5, 2.48, D / 2 + 0.03);
    sign("gate", 2.6, signAt[0], signAt[1], signAt[2], "x+");
    set(B.paint, softBox(0.9, 0.6, 0.34, 0.03, 1).translate(W / 2 + 0.2, 2.1, -0.3), 0xdcd8cc);
    set(B.iron, cyl(0.2, 0.02, W / 2 + 0.375, 2.1, -0.3, "x", 14));
    set(B.iron, box(0.05, 0.05, 0.4, W / 2 + 0.05, 1.78, -0.3));
    set(B.iron, rod([-2.6, top, -1], [-2.6, top + 2.2, -1], 0.014, 4));
    set(B.paint, cyl(0.035, top - 0.2, W / 2 - 0.1, top / 2 + 0.1, D / 2 + 0.06, "y", 8), 0x39473c);
    const lampAt = set.point(-2.7, top + 0.35, D / 2 + 0.5);
    set(B.iron, rod([-2.85, top, D / 2 - 0.1], [-2.7, top + 0.45, D / 2 + 0.5], 0.03, 5));
    lantern(lampAt[0], lampAt[1], lampAt[2], COLD, 0.8, 0.13, 13, 0.34, 0.5);
    const spill = set.point(0, 0.03, D / 2 + 2.2);
    put(B.floorPools, quad(8, 9, spill[0], spill[1], spill[2], "y+"), 0xffd9a8, 0.11);
    halos.push({ position: set.point(-1.5, 1.6, D / 2 + 0.1), colour: 0xffd9a8, gain: 0.45 }, { position: set.point(2.1, 1.6, D / 2 + 0.1), colour: 0xffd9a8, gain: 0.35 });
  }

  // ---- Terminal tractor and skeletal trailer under the cranes, a box on its back ----------
  {
    const tx = 18.6, tz = 2.6, yaw = 0.035, YELLOW = 0xd9a31c;
    const set = stage(tx, 0, tz, yaw);
    const wheel = (x: number, z: number, r: number, w: number) => {
      set(B.rubber, cyl(r, w, x, r, z, "x", 20));
      set(B.paint, cyl(r * 0.55, w + 0.02, x, r, z, "x", 14), 0xbdb9ad);
      set(B.iron, cyl(r * 0.2, w + 0.06, x, r, z, "x", 8));
    };
    // Tractor: frame, axles, offset cab, engine cover, fifth wheel on a lifting boom.
    set(B.iron, box(1.0, 0.32, 5.3, 0, 0.78, 1.2));
    wheel(-1.08, 3.0, 0.52, 0.34); wheel(1.08, 3.0, 0.52, 0.34); wheel(-0.98, -0.5, 0.52, 0.62); wheel(0.98, -0.5, 0.52, 0.62);
    set(B.iron, cyl(0.09, 2.2, 0, 0.52, 3.0, "x", 8)); set(B.iron, cyl(0.12, 2.0, 0, 0.52, -0.5, "x", 8));
    set(B.paint, softBox(1.34, 1.85, 1.7, 0.08, 1.6).translate(-0.5, 2.05, 2.75), YELLOW);
    set(B.paint, softBox(1.05, 0.95, 1.9, 0.06, 1.6).translate(0.72, 1.5, 2.75), YELLOW);
    set(B.paint, softBox(2.5, 0.42, 0.26, 0.04, 1.6).translate(0, 0.72, 3.95), 0x2a2c2e);
    for (const x of [-1.08, 1.08]) { set(B.paint, softBox(0.42, 0.08, 1.4, 0.03, 1).translate(x, 1.12, 3.0), YELLOW); set(B.paint, softBox(0.7, 0.08, 1.5, 0.03, 1).translate(Math.sign(x) * 0.98, 1.12, -0.5), 0x2a2c2e); }
    for (const pane of [quad(1.1, 0.85, -0.5, 2.4, 3.607, "z+"), quad(1.3, 0.8, -1.177, 2.4, 2.75, "x-"), quad(1.3, 0.8, 0.177, 2.42, 2.75, "x+"), quad(1.0, 0.7, -0.5, 2.45, 1.893, "z-")]) set(B.glazing, pane);
    set(B.iron, box(1.4, 0.06, 1.76, -0.5, 3.0, 2.75));
    set(B.glow, cyl(0.07, 0.12, -0.5, 3.1, 2.3, "y", 10), STRIKE_ORANGE, 3.2);
    halos.push({ position: set.point(-0.5, 3.15, 2.3), colour: STRIKE_ORANGE, gain: 0.4 });
    for (const x of [-0.95, 0.95]) { set(B.glow, box(0.26, 0.14, 0.03, x, 0.98, 4.09), 0xfff2d8, 3.6); halos.push({ position: set.point(x, 0.98, 4.2), colour: 0xfff2d8, gain: 0.5 }); }
    const beam = set.point(0, 0.03, 8.4);
    put(B.floorPools, quad(7, 10, beam[0], beam[1], beam[2], "y+"), 0xfff2d8, 0.16);
    set(B.iron, cyl(0.065, 1.9, 0.35, 2.35, 1.7, "y", 10)); set(B.iron, cyl(0.09, 0.5, 0.35, 2.0, 1.7, "y", 10));
    set(B.iron, cyl(0.26, 1.1, 0.95, 0.75, 1.1, "z", 14)); set(B.brushed, cyl(0.16, 0.8, -0.9, 0.7, 1.0, "z", 12));
    for (const y of [0.5, 0.95]) set(B.plate, box(0.4, 0.03, 0.3, -1.3, y, 2.4));
    for (const x of [-1.25, 0.3]) { set(B.iron, rod([x, 2.5, 3.55], [x - 0.3 * Math.sign(x + 0.5), 2.7, 3.9], 0.015, 4)); set(B.iron, box(0.16, 0.3, 0.03, x - 0.3 * Math.sign(x + 0.5), 2.6, 3.92)); }
    set(B.iron, box(0.5, 0.1, 2.2, 0, 1.0, 0.1).rotateX(0.07)); set(B.plate, cyl(0.48, 0.07, 0, 1.2, -0.5, "y", 18));
    set(B.brushed, rod([0, 0.95, 1.0], [0, 1.1, -0.2], 0.06, 8));
    for (const x of [-0.2, 0.2]) set(B.rubber, tube([[x, 2.4, 1.9], [x * 1.4, 1.9, 1.2], [x, 1.5, 0.3], [x * 0.5, 1.35, -1.2]], 0.02, 14, 5));
    for (const x of [-1.0, 1.0]) set(B.glow, box(0.2, 0.1, 0.03, x, 0.95, -1.42), 0xff2a1c, 1.6);
    // Trailer: two rails, cross-members, bolsters with twist-locks, landing legs, tandem bogie, underrun bar.
    for (const x of [-0.5, 0.5]) set(B.iron, box(0.16, 0.36, 12.6, x, 1.24, -6.6));
    for (let z = -1.2; z > -12.8; z -= 1.45) set(B.iron, box(1.16, 0.2, 0.1, 0, 1.2, z));
    for (const z of [-0.72, -12.83]) {
      set(B.iron, box(2.5, 0.18, 0.3, 0, 1.36, z));
      for (const x of [-1.16, 1.16]) { set(B.brushed, cyl(0.05, 0.1, x, 1.5, z, "y", 8)); set(B.iron, box(0.2, 0.06, 0.2, x, 1.46, z)); }
    }
    for (const z of [-10.2, -11.55]) { wheel(-0.98, z, 0.5, 0.62); wheel(0.98, z, 0.5, 0.62); set(B.iron, cyl(0.1, 2.0, 0, 0.5, z, "x", 8)); }
    for (const x of [-0.98, 0.98]) set(B.paint, softBox(0.7, 0.06, 2.7, 0.02, 1).translate(x, 1.08, -10.87), 0x2a2c2e);
    for (const x of [-0.62, 0.62]) { set(B.iron, box(0.12, 1.0, 0.12, x, 0.62, -2.9)); set(B.iron, box(0.26, 0.04, 0.26, x, 0.1, -2.9)); }
    set(B.iron, box(1.4, 0.06, 0.06, 0, 0.7, -2.9));
    set(B.paint, box(2.4, 0.14, 0.1, 0, 0.62, -13.0), 0xd8d4c8);
    for (const x of [-0.45, 0.45]) set(B.iron, box(0.08, 0.6, 0.08, x, 0.9, -12.95));
    for (const x of [-1.0, 1.0]) set(B.glow, box(0.24, 0.1, 0.03, x, 0.78, -13.06), 0xff2a1c, 1.8);
    for (const x of [-0.6, 0.6]) set(B.paint, box(0.4, 0.1, 0.02, x, 0.62, -13.06), 0xb3241c);
    // Chocks under the bogie, and the box itself.
    for (const z of [-9.55, -12.2]) set(B.paint, box(0.3, 0.16, 0.24, -0.98, 0.08, z), YELLOW);
    const boxAt = set.point(0, 1.5, -6.78);
    letterSide(stow(LONG, boxAt[0], boxAt[1], boxAt[2], ALONG_Z + yaw, 2, true), -1);
  }

  // ---- Reefers on the plug point beside the shed -------------------------------------------
  {
    const rx = 16.6, rz = 13.4, face = rz - LONG / 2 + (LONG - SHORT) / 2;
    for (let tier = 0; tier < 2; tier += 1) {
      const item = stow(SHORT, rx, tier * TIER, rz, -ALONG_Z, 4, true);
      item.paint = 0xcfd2cf;
      letterSide(item, 1, tier === 1);
      // Machinery end: condenser fans behind grilles above, compressor bay and controller below.
      const set = stage(rx, tier * TIER, face - 0.01, Math.PI);
      set(B.paint, box(2.14, 2.3, 0.05, 0, 1.3, 0.02), 0xd6d8d4);
      set(B.paint, box(2.0, 1.0, 0.02, 0, 1.92, 0.05), 0x1c1e20);
      for (const x of [-0.5, 0.5]) {
        for (const r of [0.14, 0.27, 0.4]) set(B.brushed, new THREE.TorusGeometry(r, 0.011, 4, 22).translate(x, 1.92, 0.085));
        for (let spoke = 0; spoke < 8; spoke += 1) set(B.brushed, rod([x + Math.cos(spoke * Math.PI / 4) * 0.08, 1.92 + Math.sin(spoke * Math.PI / 4) * 0.08, 0.085], [x + Math.cos(spoke * Math.PI / 4) * 0.42, 1.92 + Math.sin(spoke * Math.PI / 4) * 0.42, 0.085], 0.008, 4));
        for (let blade = 0; blade < 5; blade += 1) set(B.iron, box(0.34, 0.1, 0.01, 0.2, 0, 0).rotateX(0.5).rotateZ(blade * Math.PI * 0.4).translate(x, 1.92, 0.065));
        set(B.iron, cyl(0.07, 0.05, x, 1.92, 0.08, "z", 10));
      }
      set(B.paint, softBox(0.95, 0.85, 0.07, 0.02, 1).translate(-0.52, 0.72, 0.07), 0xb9bdbd);
      for (let slot = 0; slot < 7; slot += 1) set(B.iron, box(0.8, 0.025, 0.012, -0.52, 0.42 + slot * 0.1, 0.108));
      set(B.paint, softBox(0.7, 0.6, 0.1, 0.02, 1).translate(0.56, 0.92, 0.08), 0x8d9296);
      set(B.glow, quad(0.3, 0.12, 0.5, 1.06, 0.132, "z+"), tier ? 0x7dffb0 : 0xffb04a, 1.8);
      for (let key = 0; key < 4; key += 1) set(B.iron, box(0.06, 0.05, 0.012, 0.38 + key * 0.09, 0.86, 0.134));
      set(B.glow, cyl(0.016, 0.012, 0.8, 1.06, 0.134, "z", 6), 0x7dffb0, 3);
      set(B.paint, box(0.42, 0.26, 0.03, 0.56, 0.42, 0.06), 0xe9e5d8);
      for (const x of [-1.0, 1.0]) set(B.brushed, box(0.03, 0.4, 0.04, x, 1.2, 0.07));
      // Power lead to the pedestal.
      put(B.rubber, tube([set.point(0.9, 0.3, 0.1), set.point(1.1, 0.1 - tier * 1.2, 0.5), [rx - 1.6, 0.04, face - 0.8], [rx - 2.2, 0.5, face - 0.35], [rx - 2.2, 0.9 + tier * 0.12, face - 0.3]], 0.022, 24, 5));
    }
    const set = stage(rx - 2.2, 0, face - 0.2, Math.PI);
    set(B.paint, softBox(0.6, 1.35, 0.34, 0.03, 1).translate(0, 0.68, 0), 0x8d9296);
    set(B.paint, box(0.7, 0.05, 0.46, 0, 1.38, 0.04), 0x6f766f);
    for (const x of [-0.16, 0.16]) for (const y of [0.9, 1.1]) set(B.paint, cyl(0.06, 0.1, x, y, 0.2, "z", 10), 0x1b4f9c);
    set(B.glow, cyl(0.02, 0.02, 0, 1.25, 0.18, "z", 6), 0x7dffb0, 3);
    sign("reefer", 1.5, rx - 2.2, 2.0, face - 0.25, "z-");
    put(B.iron, box(0.05, 0.7, 0.05, rx - 2.2, 1.65, face - 0.2));
  }

  // ---- Reach stacker parked on the left apron ----------------------------------------------
  {
    const set = stage(-28.2, 0, 3.4, 1.0), RED = 0xb8401c;
    const wheel = (x: number, z: number, r: number, w: number) => { set(B.rubber, cyl(r, w, x, r, z, "x", 22)); set(B.paint, cyl(r * 0.5, w + 0.03, x, r, z, "x", 14), 0xd8d4c8); };
    set(B.paint, softBox(3.0, 1.1, 7.6, 0.08, 2).translate(0, 1.45, 0), RED);
    set(B.paint, softBox(3.3, 1.5, 1.5, 0.1, 2).translate(0, 1.75, -3.6), 0x2a2c2e);
    wheel(-1.75, 2.3, 0.86, 0.5); wheel(-1.2, 2.3, 0.86, 0.5); wheel(1.75, 2.3, 0.86, 0.5); wheel(1.2, 2.3, 0.86, 0.5); wheel(-1.5, -2.5, 0.78, 0.6); wheel(1.5, -2.5, 0.78, 0.6);
    for (const x of [-1.5, 1.5]) { set(B.paint, softBox(1.25, 0.1, 2.3, 0.04, 2).translate(x, 2.05, 2.3), RED); set(B.paint, box(0.6, 0.2, 0.06, x, 1.9, -4.37), 0xd9a51f); }
    set(B.paint, softBox(1.6, 1.75, 1.9, 0.08, 2).translate(0, 3.1, -0.6), 0xdcd8cc);
    for (const pane of [quad(1.3, 1.1, 0, 3.2, 0.36, "z+"), quad(1.3, 1.0, 0, 3.25, -1.56, "z-"), quad(1.5, 1.1, -0.81, 3.2, -0.6, "x-"), quad(1.5, 1.1, 0.81, 3.2, -0.6, "x+")]) set(B.glazing, pane);
    for (const x of [-0.6, 0.6]) set(B.glow, box(0.2, 0.12, 0.05, x, 4.05, 0.3), COLD, 3.2);
    set(B.glow, cyl(0.07, 0.12, 0.5, 4.1, -1.2, "y", 10), STRIKE_ORANGE, 3.2);
    halos.push({ position: set.point(0, 4.05, 0.5), colour: COLD, gain: 0.55 }, { position: set.point(0.5, 4.15, -1.2), colour: STRIKE_ORANGE, gain: 0.35 });
    const beam = set.point(0, 0.03, 7.5);
    put(B.floorPools, quad(10, 10, beam[0], beam[1], beam[2], "y+"), COLD, 0.1);
    for (let i = 0; i < 4; i += 1) set(B.plate, box(0.5, 0.03, 0.3, -1.75, 0.5 + i * 0.4, 0.1 - i * 0.12));
    set(B.iron, rod([-2.0, 0.5, 0.3], [-2.0, 3.0, -0.3], 0.02, 5));
    // Boom on its trunnion, lifted on two rams, with the top-lift spreader hanging level.
    const lift = new THREE.Matrix4().makeTranslation(0, 4.3, -3.2).multiply(new THREE.Matrix4().makeRotationX(-0.42));
    const onBoom = (into: THREE.BufferGeometry[], geometry: THREE.BufferGeometry, colour?: number) => set(into, geometry.applyMatrix4(lift), colour);
    onBoom(B.paint, softBox(0.95, 1.0, 7.2, 0.05, 2).translate(0, 0, 3.6), RED);
    onBoom(B.paint, softBox(0.72, 0.76, 3.6, 0.04, 2).translate(0, 0, 8.6), 0x2a2c2e);
    onBoom(B.iron, box(1.1, 0.5, 0.6, 0, 0, 10.3));
    for (const x of [-1.25, 1.25]) { set(B.paint, softBox(0.3, 2.4, 0.9, 0.04, 2).translate(x * 0.56, 3.2, -3.2), RED); }
    const ramTop = new THREE.Vector3(0, -0.5, 4.2).applyMatrix4(lift);
    for (const x of [-0.72, 0.72]) { set(B.brushed, rod([x, 2.1, 1.6], [x, ramTop.y, ramTop.z], 0.07, 8)); set(B.iron, rod([x, 2.1, 1.6], [x, (2.1 + ramTop.y) / 2, (1.6 + ramTop.z) / 2], 0.12, 8)); }
    const tip = new THREE.Vector3(0, 0, 10.3).applyMatrix4(lift);
    set(B.iron, cyl(0.3, 1.1, 0, tip.y - 0.7, tip.z, "y", 12));
    set(B.paint, softBox(6.1, 0.42, 0.9, 0.04, 2).translate(0, tip.y - 1.4, tip.z), 0xd9a51f);
    for (const x of [-3.0, 3.0]) { set(B.paint, softBox(0.3, 0.5, 2.5, 0.04, 2).translate(x, tip.y - 1.4, tip.z), 0xd9a51f); for (const z of [-1.18, 1.18]) set(B.iron, cyl(0.05, 0.3, x, tip.y - 1.75, tip.z + z, "y", 8)); }
    for (const x of [-0.3, 0.3]) set(B.rubber, tube([[x, 4.6, -1.6], [x, 5.4, 1.0], [x, tip.y - 0.2, tip.z - 2.2], [x, tip.y - 0.9, tip.z - 0.3]], 0.025, 14, 5));
  }

  // ---- The box standing open on the left apron, half stripped ---------------------------------
  {
    const floor = 0.15, set = stage(stray.x, floor, stray.z, stray.yaw), cargo = propsAt(stray.x, stray.z, stray.yaw, floor);
    // What is still stowed: a dark mass at the back and, in front of it, a face of cartons on two pallets.
    set(B.matte, box(2.9, 2.2, 2.24, -1.78, 1.1, 0), 0x2e2620);
    for (const z of [-0.585, 0.585]) cargo("pallet", -0.06, 0, z, QUARTER, { scale: [0.96, 1, 1] });
    for (let column = 0; column < 3; column += 1) for (let tier = 0; tier < (column === 1 ? 3 : 4); tier += 1) {
      cargo("cartonLarge", -0.08 + loose(0.03), PALLET + tier * CARTON_L, (column - 1) * 0.63 + loose(0.02), QUARTER + loose(0.05));
    }
    cargo("cartonFlat", -0.05, PALLET + 3 * CARTON_L, 0.03, QUARTER + 0.2);
    // Two pallets pulled forward and part stripped; one carton has come down and burst.
    cargo("pallet", 1.02, 0, -0.52, QUARTER + 0.04, { variant: 1 });
    for (const [x, z, tiers] of [[0.86, -0.77, 3], [0.86, -0.29, 3], [1.21, -0.78, 2], [1.2, -0.28, 1]]) {
      for (let tier = 0; tier < tiers; tier += 1) cargo("carton", x + loose(0.02), PALLET + tier * CARTON, z + loose(0.016), QUARTER + loose(0.07));
    }
    cargo("cartonOpen", 1.2, PALLET + CARTON, -0.29, QUARTER - 0.25);
    cargo("pallet", 1.08, 0, 0.7, 0.04);
    cargo("cartonLarge", 0.74, PALLET, 0.7, QUARTER + 0.04);
    cargo("cartonLarge", 0.75, PALLET + CARTON_L, 0.68, QUARTER - 0.06);
    cargo("cartonTall", 1.2, PALLET, 0.47, QUARTER + 0.3);
    cargo("cartonFlat", 1.37, PALLET, 0.9, 0.12);
    cargo("cartonFlat", 1.35, PALLET + tall("cartonFlat"), 0.88, 0.4);
    cargo("cartonCrushed", 2.28, 0, -0.42, 0.7);
    if (high) cargo("cartonSmall", 2.5, 0, 0.42, -0.4);
    // A ratchet strap hangs across the opening and a strip light is clipped to the roof.
    set(B.matte, hang([2.7, 1.35, -1.1], [2.7, 1.3, 1.1], 0.2, 0.018, 12), 0xd4551c);
    set(B.brushed, box(0.05, 0.1, 0.12, 2.7, 1.26, 0.3));
    set(B.glow, box(0.9, 0.04, 0.06, 2.3, 2.36, 0), COLD, 3.4);
    halos.push({ position: set.point(2.3, 2.3, 0), colour: COLD, gain: 0.4 });
    set(B.pools, quad(2.0, 2.2, 2.1, 1.2, 0, "x+").rotateY(0), COLD, 0.1);
    // Pallet truck outside the doors with the next pallet on its forks.
    const out = stage(stray.x, 0, stray.z, stray.yaw);
    out(B.smooth, box(0.16, 0.06, 1.15, 0, 0.09, 0).rotateY(Math.PI / 2 + 0.3).translate(3.6, 0, -0.75), 0xb3241c);
    out(B.smooth, box(0.16, 0.06, 1.15, 0, 0.09, 0).rotateY(Math.PI / 2 + 0.3).translate(3.72, 0, -1.12), 0xb3241c);
    out(B.smooth, box(0.3, 0.4, 0.5, 4.25, 0.25, -1.12), 0xb3241c);
    out(B.iron, rod([4.3, 0.4, -1.12], [4.75, 1.15, -1.18], 0.02, 5)); out(B.iron, box(0.04, 0.04, 0.36, 4.77, 1.17, -1.18));
    out(B.rubber, cyl(0.09, 0.12, 4.3, 0.09, -1.12, "z", 10));
    const forks = out.point(3.5, 0, -0.89), lifted = propsAt(forks[0], forks[2], stray.yaw + 0.3, 0.012);
    lifted("pallet", 0, 0, 0);
    lifted("cartonLarge", -0.3, PALLET, -0.15, 0.03); lifted("cartonLarge", 0.31, PALLET, -0.16, -0.05); lifted("cartonLarge", -0.27, PALLET + CARTON_L, -0.14, 0.09);
    lifted("carton", -0.33, PALLET, 0.22, 0.04); lifted("carton", 0.17, PALLET, 0.2, -0.1);
    if (high) lifted("cartonSmall", 0.3, PALLET + CARTON_L, -0.12, 0.6);
  }

  // ---- Clutter along the edges of the range ------------------------------------------------
  const cones: Transform[] = [
    { position: [-10.7, 0, 0.8] }, { position: [-10.6, 0, 5.1] }, { position: [10.6, 0, 0.7] }, { position: [10.9, 0, 9.1] }, { position: [12.1, 0, 4.6] },
    { position: [-17.3, 0, -1.7] }, { position: [-11.5, 0, -1.7] }, { position: [-17.3, 0, 4.1] }, { position: [-11.9, 0.19, 4.3], rotation: [Math.PI / 2 - 0.1, 0.7, 0] },
    { position: [16.9, 0, 7.6] }, { position: [19.9, 0, 9.0] }, { position: [22.6, 0, -0.6] },
  ];
  instances(coneGeometry(), matte, cones, false, false);
  if (high) {
    // Wheeled bins by the shed: tapered body under a rolled rim, lid on the hinge bar, wheels on an axle.
    const bin = (x: number, z: number, yaw: number, colour: number, open: boolean) => {
      const set = stage(x, 0, z, yaw), body = softBox(0.58, 0.94, 0.72, 0.045, 1).translate(0, 0.54, 0), at = body.attributes.position;
      for (let i = 0; i < at.count; i += 1) { const narrow = 0.8 + 0.2 * Math.min(1, Math.max(0, (at.getY(i) - 0.07) / 0.94)); at.setX(i, at.getX(i) * narrow); at.setZ(i, at.getZ(i) * narrow + (1 - narrow) * 0.05); }
      set(B.smooth, body, colour);
      set(B.smooth, softBox(0.63, 0.05, 0.77, 0.02, 1).translate(0, 0.992, 0), colour);
      for (const side of [-0.17, 0.17]) set(B.smooth, box(0.1, 0.07, 0.08, side, 0.035, 0.24), colour);
      for (const side of [-0.25, 0.25]) set(B.smooth, box(0.05, 0.09, 0.09, side, 0.99, -0.4), colour);
      set(B.smooth, cyl(0.016, 0.56, 0, 1.0, -0.44, "x", 8), colour);
      if (open) {
        // Thrown back, the lid hangs behind; the sacks inside are up to the rim.
        set(B.smooth, softBox(0.63, 0.77, 0.035, 0.015, 1).rotateX(0.07).translate(0, 0.62, -0.49), colour);
        set(B.rubber, quad(0.54, 0.68, 0, 0.9, 0, "y+"));
        for (const [sx, sz, r] of [[-0.08, 0.1, 0.2], [0.1, -0.14, 0.17]]) set(B.rubber, new THREE.SphereGeometry(r, 10, 7).scale(1, 0.62, 1.1).translate(sx, 0.95, sz));
      } else {
        set(B.smooth, softBox(0.64, 0.035, 0.79, 0.015, 1).rotateX(0.025).translate(0, 1.035, 0.005), colour);
        set(B.smooth, softBox(0.5, 0.03, 0.58, 0.014, 1).rotateX(0.025).translate(0, 1.06, 0), colour);
        set(B.smooth, box(0.44, 0.045, 0.03, 0, 1.02, 0.405), colour);
      }
      for (const side of [-0.27, 0.27]) { set(B.rubber, cyl(0.1, 0.045, side, 0.1, -0.31, "x", 14)); set(B.smooth, cyl(0.05, 0.05, side, 0.1, -0.31, "x", 10), 0x2a2c2e); }
      set(B.iron, cyl(0.012, 0.6, 0, 0.1, -0.31, "x", 6));
      set(B.matte, quad(0.2, 0.13, 0, 0.72, 0.346, "z+").rotateX(-0.03), 0xe9e5d8);
    };
    bin(11.6, 9.12, Math.PI + 0.1, 0x1d6b3c, false);
    bin(12.3, 9.08, Math.PI - 0.08, 0x1b4f9c, false);
    bin(13.0, 8.72, Math.PI + 0.3, 0x34373a, true);
    // Spill kit: a yellow chest on castors, clasps down, set where the bunkering hose comes ashore.
    {
      const set = stage(11.2, 0, 4.2, QUARTER + 0.12);
      set(B.smooth, softBox(0.9, 0.62, 0.6, 0.04, 1).translate(0, 0.41, 0), 0xd9a51f);
      set(B.smooth, softBox(0.94, 0.14, 0.64, 0.04, 1).translate(0, 0.79, 0), 0xd9a51f);
      for (const x of [-0.28, 0.28]) { set(B.iron, box(0.06, 0.12, 0.02, x, 0.7, 0.325)); set(B.iron, box(0.1, 0.03, 0.03, x, 0.86, -0.32)); }
      for (const x of [-0.36, 0.36]) for (const z of [-0.22, 0.22]) set(B.rubber, cyl(0.05, 0.04, x, 0.05, z, "x", 10));
      set(B.matte, quad(0.5, 0.2, 0, 0.44, 0.306, "z+"), 0xe9e5d8);
      set(B.matte, quad(0.44, 0.05, 0, 0.39, 0.309, "z+"), 0x1a1c1e);
    }
    // Bulk bags: a woven tonne sack, square in plan with the corners drawn in, fullest a third of the way up and
    // slack across the top; four lifting loops, a tied filling spout, a document pouch.
    const bulkBag = (x: number, y: number, z: number, yaw: number, colour: number, seed: number) => {
      const set = stage(x, y, z, yaw), next = rng(seed), slab = new THREE.BoxGeometry(0.9, 0.98, 0.9, 8, 8, 8);
      slab.deleteAttribute("normal"); slab.deleteAttribute("uv");
      const sack = mergeVertices(slab, 1e-4), at = sack.attributes.position;
      slab.dispose();
      for (let i = 0; i < at.count; i += 1) {
        const u = at.getX(i) / 0.45, v = at.getY(i) / 0.49, w = at.getZ(i) / 0.45, m = Math.max(Math.abs(u), Math.abs(w));
        const round = m > 1e-6 ? 1 / (Math.abs(u / m) ** 5 + Math.abs(w / m) ** 5) ** 0.2 : 1;
        const belly = 1 + 0.13 * (1 - v * v) * (1 - 0.35 * v) - 0.1 * v ** 8;
        const crease = 1 + 0.012 * Math.sin(u * 4.1 + v * 6.3 + seed) * Math.cos(w * 5.3 - v * 3.7 + seed * 1.7);
        at.setXYZ(i, at.getX(i) * round * belly * crease, at.getY(i) - 0.06 * Math.max(0, v) * (1 - m * m) + 0.49, at.getZ(i) * round * belly * crease);
      }
      sack.computeVertexNormals();
      sack.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(at.count * 2), 2));
      set(B.matte, sack, colour);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        // Webbing loops stand, lean or have flopped in onto the top.
        const flop = next() < 0.4 ? 1.25 + next() * 0.2 : 0.1 + next() * 0.5;
        set(B.matte, new THREE.TorusGeometry(0.1, 0.014, 4, 10, Math.PI).scale(1, 1, 2.2).rotateX(-flop).rotateY(Math.atan2(sx, sz)).translate(sx * 0.31, 0.955, sz * 0.31), BLUE);
      }
      set(B.matte, cyl(0.17, 0.13, 0, 0.975, 0, "y", 10, 0.045), colour);
      set(B.matte, cyl(0.05, 0.06, 0, 1.065, 0, "y", 8, 0.085), colour);
      set(B.rope, new THREE.TorusGeometry(0.05, 0.008, 4, 10).rotateX(QUARTER).translate(0, 1.04, 0));
      set(B.matte, quad(0.28, 0.2, 0.08, 0.63, 0.512, "z+"), 0xeeeae0);
      for (const [wide, across, up] of [[0.34, -0.03, 0.42], [0.22, -0.09, 0.35]]) set(B.matte, quad(wide, 0.035, across, up, 0.522, "z+"), 0x1f3a66);
    };
    bulkBag(-14.0, 0, 4.3, 0.2 + QUARTER, 0xdedbd0, 3);
    bulkBag(-15.0, 0, 4.0, -0.1 + QUARTER, 0xd6d2c4, 8);
    bulkBag(-14.5, 0.94, 4.15, 0.3 + QUARTER, 0xe2ded0, 14);
    // Lashing-gear bin: bars standing in it, twist-locks heaped at the bottom, a chain trailing off.
    {
      const set = stage(12.5, 0, 2.2, 0.08);
      for (const [w, d, x, z] of [[1.3, 0.05, 0, 0.5], [1.3, 0.05, 0, -0.5], [0.05, 1.0, 0.63, 0], [0.05, 1.0, -0.63, 0]]) set(B.paint, box(w, 0.85, d, x, 0.5, z), 0x1b4f9c);
      set(B.paint, box(1.3, 0.06, 1.0, 0, 0.1, 0), 0x1b4f9c);
      for (const x of [-0.5, 0.5]) set(B.iron, box(0.1, 0.1, 1.0, x, 0.05, 0));
      for (let bar = 0; bar < 9; bar += 1) set(B.brushed, rod([-0.5 + bar * 0.12, 0.14, -0.3 + (bar % 3) * 0.1], [-0.45 + bar * 0.13 + (bar % 2) * 0.1, 2.3 + (bar % 4) * 0.12, 0.38], 0.014, 5));
      for (let lock = 0; lock < 16; lock += 1) set(B.iron, box(0.16, 0.1, 0.1, 0, 0, 0).rotateY(random() * 3).rotateZ(random()).translate(-0.4 + random() * 0.85, 0.2 + random() * 0.14, -0.3 + random() * 0.5));
      for (let link = 0; link < 24; link += 1) {
        const t = link / 23, x = 0.9 + t * 2.4, z = 0.4 + Math.sin(t * 5) * 0.35;
        set(B.iron, new THREE.TorusGeometry(0.045, 0.013, 4, 8).scale(1.5, 1, 1).rotateX(link % 2 ? Math.PI / 2 : 0.2).rotateY(Math.cos(t * 5) * 0.6).translate(x, 0.03, z));
      }
    }
    // A hose left run out from the standpipe by the shed.
    put(B.brushed, cyl(0.04, 0.9, 14.5, 0.45, 9.3, "y", 8));
    put(B.smooth, cyl(0.09, 0.03, 14.5, 0.86, 9.24, "z", 10), 0xa8201a);
    put(B.rubber, tube([[14.5, 0.7, 9.22], [14.6, 0.2, 8.95], [14.9, 0.03, 8.7], [15.6, 0.03, 8.75], [16.3, 0.03, 8.2], [15.9, 0.03, 7.4], [14.9, 0.03, 7.3], [14.5, 0.03, 7.9], [15.1, 0.03, 8.3]], 0.026, 60, 5));
    // Wheel chocks, gas bottles chained to their trolley, and a broom against the barriers.
    for (const [x, z, yaw] of [[-11.3, 6.9, 0.3], [-11.0, 7.3, 1.9], [11.2, 5.6, -0.4]]) {
      const chock = new THREE.BoxGeometry(0.2, 0.16, 0.3), at = chock.attributes.position;
      for (let i = 0; i < at.count; i += 1) if (at.getY(i) > 0) at.setZ(i, at.getZ(i) * 0.25 - 0.11);
      chock.computeVertexNormals();
      stage(x, 0.08, z, yaw)(B.smooth, chock, 0xd9a51f);
    }
    for (const [x, z, colour, cap] of [[11.0, 6.9, 0x7a2a22, 0x7a2a22], [11.26, 6.95, 0x23262a, 0xd9d5c8]]) {
      put(B.smooth, cyl(0.115, 1.14, x, 0.63, z, "y", 16), colour);
      put(B.smooth, new THREE.SphereGeometry(0.115, 16, 5, 0, Math.PI * 2, 0, QUARTER).scale(1, 0.8, 1).translate(x, 1.2, z), cap);
      put(B.smooth, cyl(0.06, 0.13, x, 1.34, z, "y", 10, 0.05), cap);
      put(B.brushed, cyl(0.022, 0.07, x, 1.3, z, "y", 6));
    }
    put(B.iron, box(0.62, 0.04, 0.32, 11.13, 0.04, 6.94)); put(B.iron, rod([11.13, 0.06, 7.1], [11.13, 1.5, 7.2], 0.016, 5));
    put(B.iron, box(0.5, 0.03, 0.02, 11.13, 0.95, 7.08));
    for (const x of [10.84, 11.42]) put(B.rubber, cyl(0.09, 0.04, x, 0.09, 7.1, "x", 12));
    put(B.iron, new THREE.TorusGeometry(0.19, 0.007, 4, 20).scale(1.36, 1, 0.72).rotateX(QUARTER).translate(11.13, 0.98, 6.945));
    put(B.timber, rod([-10.45, 0.02, 2.4], [-10.25, 1.45, 2.1], 0.016, 5)); put(B.matte, box(0.34, 0.08, 0.07, -10.45, 0.05, 2.4), 0x6b5234);
  }
  // Every kind of loose cargo in one batch. Only drums and pallets are big enough to matter in the wet floor's mirror.
  for (const [kind, items] of dressed) {
    const meshes = props.place(kind, items);
    if (kind !== "drum" && kind !== "drumPlastic" && kind !== "pallet") kit.mirrorHidden.push(...meshes);
  }

  // ---- Ground: checker-plate trench covers, manholes, puddles, tyre tracks, oil -------------------
  for (let z = 0.9; z < 9.5; z += 1.2) put(B.floorPlate, quad(0.9, 1.17, 12.55, 0.012, z, "y+"));
  for (let x = -12.6; x > -25; x -= 1.2) put(B.floorPlate, quad(1.17, 0.7, x, 0.012, -2.6, "y+"));
  for (const side of [-1, 1]) for (let z = -27.4; z < 0; z += 1.0) put(B.floorPlate, quad(0.32, 0.97, side * 9.28, 0.012, z, "y+"));
  for (const [x, z] of [[-11.5, 8.3], [21.6, 6.2], [-22.5, 6.6], [14.9, -4]]) put(B.floorPlate, cyl(0.42, 0.016, x, 0.008, z, "y", 20));
  for (const [x0, x1, z0, z1] of [[12.08, 12.1, 0.3, 9.5], [13.0, 13.02, 0.3, 9.5], [-25, -12.0, -2.96, -2.94], [-25, -12.0, -2.25, -2.23], [-9.46, -9.44, -27.9, 0.3], [9.44, 9.46, -27.9, 0.3], [-9.12, -9.1, -27.9, 0.3], [9.1, 9.12, -27.9, 0.3]]) put(B.floorIron, box(Math.max(0.03, x1 - x0), 0.02, Math.max(0.03, z1 - z0), (x0 + x1) / 2, 0.006, (z0 + z1) / 2));
  const decalMap = track(groundDecals());
  decalMap.anisotropy = anisotropy;
  const puddles: THREE.BufferGeometry[] = [], tracks: THREE.BufferGeometry[] = [];
  const decal = (into: THREE.BufferGeometry[], cell: [number, number, number, number], w: number, d: number, x: number, z: number, turn: number) => into.push(shade(cellUv(quad(w, d, x, into === puddles ? 0.007 : 0.006, z, "y+", turn), cell, 1024), 1));
  const POOLS: Array<[number, number, number, number]> = [[0, 0, 512, 256], [512, 0, 512, 256], [0, 256, 512, 256], [512, 256, 512, 256]];
  ([[-3.4, -12.6, 2.6, 0.3], [5.2, -21.5, 3.2, 1.2], [-6.6, -25.2, 2.2, 2.1], [2.4, -1.6, 2.0, 0.7], [6.3, 3.9, 3.0, 2.6], [-5.2, 6.4, 2.4, 0.2], [-1.2, -19.5, 1.5, 1.9], [7.4, -9.9, 1.7, 0.4],
    [14.6, 1.6, 3.6, 1.0], [-16.2, 4.9, 4.2, 0.4], [20.8, -2.4, 4.6, 1.7], [-22.4, -4.6, 5.2, 2.4], [16, -12, 5, 0.6], [22.2, 5.6, 2.8, 0.9]] as Array<[number, number, number, number]>)
    .forEach(([x, z, size, turn], index) => decal(puddles, POOLS[index % 4], size, size * 0.5, x, z, turn));
  // The quay edge never dries: spray and hosing-down stand in a broken line of pools behind the coping.
  ([[22.9, -15.5, 5.2, 1.5], [23.3, -9.2, 3.4, 1.72], [22.6, -3.4, 4.6, 1.45], [23.4, 1.8, 3.8, 1.62], [22.8, 6.9, 5.4, 1.52], [23.5, 12.4, 3.2, 1.7], [22.7, 16.8, 4.4, 1.48], [20.9, -6.5, 2.6, 0.4], [21.2, 9.6, 2.9, 2.8]] as Array<[number, number, number, number]>)
    .forEach(([x, z, size, turn], index) => decal(puddles, POOLS[(index + 1) % 4], size, size * 0.42, x, z, turn));
  ([[-15, 2, 0.5, 9], [-19, -3, 1.2, 12], [16.5, -1, 0.05, 14], [19.6, 8, -0.3, 8], [-23, 6, 1.9, 10], [-2.5, 5.2, 1.45, 9], [1.8, -14, 0.03, 13], [14.8, 6.3, 1.2, 7], [20.5, -14, 0.02, 16]] as Array<[number, number, number, number]>)
    .forEach(([x, z, turn, length], index) => decal(tracks, [(index % 2) * 512, 512, 512, 320], 2.1, length, x, z, turn + Math.PI / 2));
  for (const [x, z, size] of [[18.4, 1.2, 1.8], [-27, 4.5, 2.4], [-13.4, 5.2, 1.3], [8.6, -7.6, 1.0]]) decal(tracks, [0, 832, 512, 192], size, size * 0.6, x, z, x);

  // ---- On the water: a harbour tug standing by off the quarter, channel buoys ----------------------------
  /** Lamps whose light lies in a path on the water. */
  const paths: Array<{ at: V3; colour: number; gain: number; flash: number }> = [];
  /** Lamps too far off to be modelled: drawn as points. `flash` is the seconds between flashes of a beacon. */
  const stars: Array<{ at: V3; colour: number; gain: number; size: number; flash: number }> = [];
  const RED = 0xff3526, GREEN = 0x35ff7a, WARM = 0xffc27a, MASTHEAD = 0xfff2d8;
  /** Lamps aboard things that move, by their places in the two lists above: each is redrawn where its lamp has got to. */
  const afloat: Array<{ path: number; star: number; aboard: THREE.Object3D; at: THREE.Vector3 }> = [];
  const lampAt = new THREE.Vector3();
  {
    // She is under way, so her parts stay out of the meshes everything else is merged into: hull and fittings go to one
    // list whatever their finish, her lamps to a second and the light on her deck to a third.
    const hullParts: THREE.BufferGeometry[] = [], lampParts: THREE.BufferGeometry[] = [], poolParts: THREE.BufferGeometry[] = [], aboard: Array<{ position: V3; colour: number; gain: number }> = [];
    const local = stage(0, 0, 0);
    const set = (into: THREE.BufferGeometry[], geometry: THREE.BufferGeometry, colour = 0xffffff, gain = 1) =>
      into === B.glow ? local(lampParts, geometry, colour, gain) : into === B.pools ? local(poolParts, geometry, colour, gain) : local(hullParts, geometry, into === B.ironFar ? 0x17181a : into === B.rubber ? 0x0b0b0c : colour);
    const plan = new THREE.Shape();
    plan.moveTo(-3.4, -9); plan.lineTo(3.4, -9); plan.quadraticCurveTo(3.9, -2, 3.6, 4); plan.quadraticCurveTo(2.6, 10, 0, 12.5); plan.quadraticCurveTo(-2.6, 10, -3.6, 4); plan.quadraticCurveTo(-3.9, -2, -3.4, -9);
    const tugHull = new THREE.ExtrudeGeometry(plan, { depth: 2.6, bevelEnabled: false, curveSegments: 8 });
    tugHull.rotateX(Math.PI / 2); tugHull.translate(0, 2.1, 0);
    set(B.paintFar, tugHull, 0x14171b);
    // Bulwark round the foredeck, rubbing strake, towing winch and bitts aft, a mast with her lights.
    const rail = new THREE.Shape();
    rail.moveTo(-3.62, 3); rail.quadraticCurveTo(-2.62, 10, 0, 12.52); rail.quadraticCurveTo(2.62, 10, 3.62, 3); rail.lineTo(3.42, 3); rail.quadraticCurveTo(2.46, 9.8, 0, 12.2); rail.quadraticCurveTo(-2.46, 9.8, -3.42, 3);
    const bulwark = new THREE.ExtrudeGeometry(rail, { depth: 0.9, bevelEnabled: false, curveSegments: 8 });
    bulwark.rotateX(Math.PI / 2); bulwark.translate(0, 3.0, 0);
    set(B.paintFar, bulwark, 0x14171b);
    set(B.paintFar, box(6.4, 0.1, 17, 0, 2.12, -0.4), 0x5a2a22);
    for (const side of [-1, 1]) set(B.rubber, box(0.22, 0.34, 15.5, side * 3.72, 1.86, -1.2));
    set(B.paintFar, softBox(4.4, 2.5, 6.4, 0.2, 3).translate(0, 3.4, 2.2), 0xd8d4c6);
    set(B.paintFar, softBox(3.6, 2.2, 3.6, 0.2, 3).translate(0, 5.7, 3.2), 0xd8d4c6);
    set(B.paintFar, box(4.5, 0.12, 4.5, 0, 6.86, 3.2), 0x8d9296);
    set(B.paintFar, box(5.0, 0.1, 7.0, 0, 4.7, 2.2), 0x8d9296);
    for (const side of [-1, 1]) for (let i = 0; i < 6; i += 1) set(B.ironFar, box(0.05, 0.95, 0.05, side * 2.42, 5.2, -1.1 + i * 1.3));
    for (const side of [-1, 1]) set(B.ironFar, box(0.05, 0.05, 6.6, side * 2.42, 5.68, 2.2));
    for (let i = 0; i < 5; i += 1) set(B.glow, quad(0.52, 0.7, -1.4 + i * 0.7, 5.95, 5.01, "z+"), 0x3c8a76, 0.55);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i += 1) set(B.glow, quad(0.6, 0.7, side * 1.81, 5.95, 2.0 + i * 0.75, side > 0 ? "x+" : "x-"), i === 1 ? 0xffc27a : 0x2a4a44, i === 1 ? 1.6 : 0.5);
      for (let i = 0; i < 4; i += 1) set(B.glow, cyl(0.2, 0.03, side * 2.21, 3.7, 0.2 + i * 1.3, "x", 10), 0xffc27a, i % 2 ? 1.6 : 0.25);
      for (let i = 0; i < 8; i += 1) set(B.rubber, new THREE.TorusGeometry(0.42, 0.16, 6, 12).rotateY(Math.PI / 2).translate(side * 3.84, 1.5, -7.6 + i * 1.9));
      set(B.paintFar, cyl(0.5, 3.4, side * 1.3, 7.2, -0.9, "y", 12, 0.42), 0x1d5d6e);
      set(B.paintFar, cyl(0.43, 0.5, side * 1.3, 8.4, -0.9, "y", 12), 0xd8d4c6);
      set(B.ironFar, cyl(0.44, 0.5, side * 1.3, 9.1, -0.9, "y", 12));
      set(B.ironFar, cyl(0.16, 0.7, side * 2.6, 2.5, -7.4, "y", 8));
    }
    set(B.rubber, new THREE.CapsuleGeometry(0.7, 3.4, 5, 12).rotateZ(Math.PI / 2).translate(0, 1.6, 12.2));
    set(B.ironFar, rod([0, 6.9, 3.2], [0, 12.4, 2.9], 0.09, 6)); set(B.ironFar, box(2.4, 0.08, 0.08, 0, 10.6, 3.0)); set(B.ironFar, box(1.4, 0.08, 0.08, 0, 11.7, 2.95));
    set(B.ironFar, cyl(0.9, 1.5, 0, 2.9, -4.4, "x", 14)); set(B.ironFar, box(2.6, 1.1, 0.5, 0, 2.7, -3.4)); set(B.ironFar, box(2.4, 0.9, 0.3, 0, 2.6, -7.2));
    set(B.ironFar, cyl(0.5, 0.5, 0, 7.2, 3.2, "y", 10)); set(B.ironFar, box(1.8, 0.14, 0.2, 0, 7.6, 3.2));
    for (const [x, y, z, colour] of [[0, 12.5, 2.9, MASTHEAD], [0, 11.6, 2.95, MASTHEAD], [-2.0, 7.1, 4.6, RED], [2.0, 7.1, 4.6, GREEN], [0, 4.2, -8.9, MASTHEAD]]) {
      set(B.glow, new THREE.SphereGeometry(0.12, 8, 6).translate(x, y, z), colour, 4);
      aboard.push({ position: [x, y, z], colour, gain: 0.5 });
    }
    set(B.glow, box(0.4, 0.1, 0.3, 0, 6.7, -0.2), COLD, 3.4);
    set(B.pools, quad(6, 8, 0, 2.19, -4.5, "y+"), COLD, 0.22);
    aboard.push({ position: [0, 6.6, -0.3], colour: COLD, gain: 0.9 });
    // Hull, lamps and the light on her after deck ride the swell together; the wash lies flat on the water round her.
    const tug = new THREE.Group(), hull = new THREE.Group();
    const deckLight = new THREE.Mesh(merge(poolParts), poolMaterial);
    const wash = new THREE.Mesh(merge([shade(quad(4.6, 26, 0, 0.06, -21, "y+"), 0.13, 0.15, 0.17), shade(quad(8.5, 4, 0, 0.06, 11.6, "y+"), 0.16, 0.18, 0.2)]), poolMaterial);
    deckLight.renderOrder = wash.renderOrder = 2;
    hull.add(new THREE.Mesh(projectUv(merge(hullParts), 3), paintAny), new THREE.Mesh(merge(lampParts), glowAny), deckLight);
    lampHalo(hull, aboard);
    tug.add(hull, wash);
    tug.traverse((child) => { child.castShadow = false; });
    scene.add(tug);
    for (const [x, y, z, colour, gain] of [[0, 6.7, -0.2, COLD, 1.4], [0, 12.5, 2.9, MASTHEAD, 0.8], [-2.2, 3.7, 2, WARM, 0.8]]) {
      afloat.push({ path: paths.length, star: -1, aboard: hull, at: new THREE.Vector3(x, y, z) });
      paths.push({ at: [67, WATER_Y + y, -30], colour, gain, flash: 0 });
    }
    // Her beat: up past the stern of the ship close in, round off the end of the shed, back down outside the buoys and
    // round again under the ship's quarter, a lap in a little over a minute. She sounds her whistle before she shows,
    // and a few seconds after she has gone by her wash arrives at the quay wall.
    const NEAR = 67, FAR = 78, FROM = -44, TO = 50, TURN = (FAR - NEAR) / 2, RUN = TO - FROM, BEND = Math.PI * TURN, WAY = 3.3;
    const heard = new THREE.Vector3();
    let begun = -1, showing = false, passed = false, slaps = 0, slapAt = 0;
    kit.updates.push((now) => {
      const t = now / 1000;
      if (begun < 0) begun = t - 14 / WAY;
      const along = ((t - begun) * WAY) % (2 * RUN + 2 * BEND);
      if (along < RUN) { tug.position.set(NEAR, WATER_Y, FROM + along); tug.rotation.y = 0; }
      else if (along < RUN + BEND) { const a = (along - RUN) / TURN; tug.position.set(NEAR + TURN - TURN * Math.cos(a), WATER_Y, TO + TURN * Math.sin(a)); tug.rotation.y = a; }
      else if (along < 2 * RUN + BEND) { tug.position.set(FAR, WATER_Y, TO - (along - RUN - BEND)); tug.rotation.y = Math.PI; }
      else { const a = (along - 2 * RUN - BEND) / TURN; tug.position.set(NEAR + TURN + TURN * Math.cos(a), WATER_Y, FROM - TURN * Math.sin(a)); tug.rotation.y = Math.PI + a; }
      hull.position.y = 0.07 * Math.sin(t * 1.3);
      hull.rotation.set(0.014 * Math.sin(t * 1.7), 0, 0.035 * Math.sin(t * 0.9 + 1));
      tug.updateMatrixWorld(true);
      const coming = along > 26 && along < RUN;
      if (coming && !showing) cue?.("shipHorn", heard.copy(tug.position).setY(6), { gain: 0.45, pitch: 1.5 + chance() * 0.15 });
      showing = coming;
      const abeam = along > 49 && along < RUN;
      if (abeam && !passed) { slaps = 3; slapAt = t + 5; }
      passed = abeam;
      if (slaps > 0 && t >= slapAt) {
        slaps -= 1;
        slapAt = t + 1.1 + chance() * 0.9;
        cue?.("waveSlap", heard.set(QUAY_EDGE + 0.3, -1.4, 8 - slaps * 4.5), { gain: 0.6 + slaps * 0.15, pitch: 0.88 + chance() * 0.25 });
      }
    });
  }
  for (const [x, z, colour, can, flash] of [[60, -1, RED, true, 2.5], [84, 34, GREEN, false, 4], [152, 50, RED, true, 3]] as const) {
    // The near one is close enough to be seen working in the swell, so it is a thing of its own; the others are scenery.
    const live = x === 60, own: THREE.BufferGeometry[] = [];
    const set = live ? stage(0, 0, 0, x) : stage(x, WATER_Y, z, x), paint = live ? own : B.paintFar;
    set(paint, cyl(1.1, 1.2, 0, 0.3, 0, "y", 14), can ? 0xa8201a : 0x1d6b3c);
    set(live ? own : B.rubber, cyl(1.16, 0.22, 0, 0.5, 0, "y", 14), live ? 0x0b0b0c : 0xffffff);
    for (let leg = 0; leg < 3; leg += 1) set(paint, rod([Math.cos(leg * 2.1) * 0.8, 0.9, Math.sin(leg * 2.1) * 0.8], [Math.cos(leg * 2.1) * 0.25, 3.6, Math.sin(leg * 2.1) * 0.25], 0.05, 5), can ? 0xa8201a : 0x1d6b3c);
    set(paint, can ? cyl(0.42, 0.7, 0, 3.2, 0, "y", 10) : cyl(0.5, 0.8, 0, 3.2, 0, "y", 10, 0.02), can ? 0xa8201a : 0x1d6b3c);
    set(paint, box(0.5, 0.36, 0.3, 0.3, 2.2, 0), 0x2a2d30);
    if (!live) {
      stars.push({ at: [x, WATER_Y + 3.95, z], colour, gain: 1.5, size: 0.3, flash });
      paths.push({ at: [x, WATER_Y + 3.95, z], colour, gain: 1.2, flash });
      continue;
    }
    const buoy = new THREE.Mesh(projectUv(merge(own), 3), paintAny);
    buoy.position.set(x, WATER_Y, z);
    scene.add(buoy);
    afloat.push({ path: paths.length, star: stars.length, aboard: buoy, at: new THREE.Vector3(0, 3.95, 0) });
    stars.push({ at: [x, WATER_Y + 3.95, z], colour, gain: 1.5, size: 0.3, flash });
    paths.push({ at: [x, WATER_Y + 3.95, z], colour, gain: 1.2, flash });
    // It rocks to two swells that drift in and out of step and leans to the gusts; the bell speaks when it rocks hard.
    const heard = new THREE.Vector3(x, 1, z);
    let rang = 0, over = false;
    kit.updates.push((now) => {
      const t = now / 1000, roll = 0.085 * Math.sin(t * 1.9) + 0.05 * Math.sin(t * 2.6 + 1) + wind.at(x, z) * 0.05;
      buoy.rotation.set(0.06 * Math.sin(t * 1.5 + 2) + 0.035 * Math.sin(t * 2.3), 0, roll);
      buoy.position.y = WATER_Y + 0.07 * Math.sin(t * 1.4 + 0.5);
      buoy.updateMatrixWorld();
      const hard = Math.abs(roll) > 0.125;
      if (hard && !over && t - rang > 2.2) { rang = t; cue?.("buoyBell", heard, { gain: 0.5 + chance() * 0.3, pitch: 0.96 + chance() * 0.08 }); }
      over = hard;
    });
  }

  // ---- The far side of the harbour ---------------------------------------------------------------
  // Geometry only. Its dusk light and the haze between are worked out once per vertex and stored as colour;
  // parts over the water go into `farWet`, which is also drawn mirrored in it, the rest into `farDry`.
  type Far = { geometry: THREE.BufferGeometry; away: number };
  const farWet: Far[] = [], farDry: Far[] = [], farNames: Far[] = [];
  /** Where the far side is judged from: the firing point. */
  const VIEW = [2, 3];
  const tone = new THREE.Color();
  /** `colour` paints the whole part, unless it carries a `paint` attribute: then that does, vertex by vertex. */
  const bake = (into: Far[], geometry: THREE.BufferGeometry, colour: number, glow = 0) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    const position = flat.attributes.position, normal = flat.attributes.normal, paint = flat.attributes.paint, colours = new Float32Array(position.count * 3);
    tone.set(colour);
    let sum = 0;
    for (let i = 0; i < position.count; i += 1) {
      const dx = position.getX(i) - VIEW[0], dz = position.getZ(i) - VIEW[1], away = Math.hypot(dx, dz);
      sum += away;
      const pr = paint ? paint.getX(i) : tone.r, pg = paint ? paint.getY(i) : tone.g, pb = paint ? paint.getZ(i) : tone.b;
      let r = pr * glow, g = pg * glow, b = pb * glow;
      if (!glow) {
        // Sky from above, the ground's bounce from below, and the afterglow on whatever faces it.
        const up = normal.getY(i) * 0.5 + 0.5, sun = Math.max(0, normal.getX(i) * TO_SUN.x + normal.getY(i) * TO_SUN.y + normal.getZ(i) * TO_SUN.z);
        r = pr * (0.14 + 0.16 * up + 0.85 * sun); g = pg * (0.12 + 0.17 * up + 0.48 * sun); b = pb * (0.14 + 0.3 * up + 0.34 * sun);
      }
      // Haze lies thickest on the water and thins with height, so jibs and mastheads stand clear of it.
      const haze = airAmount(away) * (0.72 + 0.28 * Math.exp(-Math.max(0, position.getY(i)) / 70)), air = airAt(dx, dz);
      colours[i * 3] = r + (air[0] - r) * haze; colours[i * 3 + 1] = g + (air[1] - g) * haze; colours[i * 3 + 2] = b + (air[2] - b) * haze;
    }
    // The normals stay: the occlusion pass draws this with them, and without them it blackens the far side.
    if (into !== farNames) flat.deleteAttribute("uv");
    if (paint) flat.deleteAttribute("paint");
    flat.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    // Lit panes are drawn after the wall they sit on when the far side is painted into the water back to front.
    into.push({ geometry: flat, away: sum / position.count - (glow ? 4 : 0) });
  };
  /** Sets parts of the far side down at a spot and heading; heights are measured from `y`. */
  const yonder = (into: Far[], x: number, z: number, yaw = 0, y = WATER_Y) => {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1));
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const set = (geometry: THREE.BufferGeometry, colour: number, glow = 0) => bake(into, geometry.applyMatrix4(matrix), colour, glow);
    set.point = (px: number, py: number, pz: number): V3 => new THREE.Vector3(px, py, pz).applyMatrix4(matrix).toArray() as V3;
    /** Whether a wall at a spot of its own, facing along (nx, nz) there, is turned toward the range. */
    set.seen = (nx: number, nz: number, px: number, pz: number) => { const at = set.point(px, 0, pz); return (nx * cos + nz * sin) * (VIEW[0] - at[0]) + (nz * cos - nx * sin) * (VIEW[1] - at[2]) > 0; };
    /** Where the range bears from here, off the bow (−z): positive to starboard. */
    set.bearing = () => Math.atan2((VIEW[0] - x) * cos - (VIEW[1] - z) * sin, -((VIEW[0] - x) * sin + (VIEW[1] - z) * cos));
    /** Painted lettering, which keeps its place on the name sheet and is drawn over the rest. */
    set.letters = (geometry: THREE.BufferGeometry) => bake(farNames, geometry.applyMatrix4(matrix), 0xe8e6de);
    /** A lamp: a point of light, and a path on the water if there is water between it and the range. */
    set.lamp = (px: number, py: number, pz: number, colour: number, gain: number, size = 0.5, flash = 0, onWater = into === farWet) => {
      const at = set.point(px, py, pz);
      stars.push({ at, colour, gain, size, flash });
      if (onWater) paths.push({ at, colour, gain: gain * 0.8, flash });
    };
    return set;
  };
  type Yonder = ReturnType<typeof yonder>;
  /** Rows of cabin windows on a wall facing `facing`, some lit; set a hand's breadth proud so they never fight the wall at this range. */
  const panes = (set: Yonder, next: () => number, facing: Facing, fixed: number, from: number, to: number, low: number, floors: number, pitch: number, lit: number) => {
    for (let floor = 0; floor < floors; floor += 1) for (let at = from + 1.2; at < to - 0.6; at += 2.3) {
      const on = next() < lit, y = low + floor * pitch + pitch * 0.55;
      const pane = facing === "x-" || facing === "x+" ? quad(1.1, 1.0, fixed, y, at, facing) : quad(1.1, 1.0, at, y, fixed, facing);
      set(pane, on ? (next() < 0.25 ? COLD : WARM) : 0x0a0d10, on ? 0.9 + next() * 1.3 : 0);
    }
  };

  /** A ship-to-shore gantry crane seen from across the water: rails along z, boom out over −x, heights from the quay. */
  const farCrane = (set: Yonder, paint: number, raised: boolean, trolley: number) => {
    const dark = 0x202428, pale = 0xc4c8ca;
    for (const z of [-9, 9]) {
      for (const x of [0, 30]) {
        set(box(1.7, 44, 1.7, x, 22, z), paint);
        set(box(2.6, 2.4, 5.4, x, 1.2, z), dark);
        set.lamp(x + (x ? -1.2 : 1.2), 15, z, SODIUM, 1.0, 0.45);
      }
      set(box(28.3, 2.2, 1.5, 15, 16, z), paint);
      set(box(28.3, 2.4, 1.6, 15, 43, z), paint);
      set(beam([0.6, 17.4, z], [29.4, 41.6, z], 1.0), paint);
    }
    for (const x of [0, 30]) {
      set(box(1.5, 2.2, 16.3, x, 4.2, 0), paint); set(box(1.5, 2.0, 16.3, x, 16, 0), paint); set(box(1.5, 2.2, 16.3, x, 43, 0), paint);
      set(beam([x, 17.4, -8.4], [x, 41.6, 8.4], 0.9), paint); set(beam([x, 17.4, 8.4], [x, 41.6, -8.4], 0.9), paint);
    }
    // Stair tower up the landside leg, a landing every flight.
    for (let flight = 0; flight < 7; flight += 1) { set(beam([31.4, 2 + flight * 6, flight % 2 ? 7.4 : 10.6], [31.4, 8 + flight * 6, flight % 2 ? 10.6 : 7.4], 0.5, 1.0), dark); set(box(1.4, 0.24, 4.2, 31.4, 8 + flight * 6, 9), dark); }
    // A-frame, stays, backreach and machinery house.
    const apex: V3 = [6, 74, 0];
    for (const z of [-1, 1]) {
      set(beam([0, 44.2, z * 8.6], [apex[0], apex[1], z * 1.2], 1.3), paint);
      set(beam([17, 46, z * 4], [apex[0], apex[1], z * 1.2], 1.1), paint);
      set(box(52, 2.6, 1.3, 24, 46, z * 4), paint);
      set(beam([apex[0], apex[1], z * 1.2], [48, 47.4, z * 4], 0.5), paint);
    }
    set(box(2.2, 1.6, 4.2, apex[0], apex[1], 0), paint);
    for (let x = 4; x < 50; x += 9) set(box(0.8, 1.6, 8, x, 46, 0), paint);
    set(box(17, 6.6, 10.4, 30, 50.6, 0), pale); set(box(17.6, 0.5, 11, 30, 54.1, 0), dark); set(box(3, 2.4, 3, 36, 55.5, 2), dark);
    set(quad(2.2, 1.2, 21.3, 51, 2, "x-"), WARM, 1.4);
    set.lamp(21.2, 52.6, -3, COLD, 0.9, 0.4);
    // Boom: two girders and their ties, level over the ship or topped up clear of it.
    const reach = 66, lean = 1.4;
    const along = (d: number, z: number, drop = 0): V3 => raised ? [-1 - d * Math.cos(lean) + drop * Math.sin(lean), 46 + d * Math.sin(lean) + drop * Math.cos(lean), z] : [-1 - d, 46 + drop, z];
    for (const z of [-4, 4]) {
      set(beam(along(0, z), along(reach, z), 2.6, 1.3), paint);
      set(beam([apex[0], apex[1], z * 0.3], along(reach * 0.46, z, 1.2), 0.5), paint);
      set(beam([apex[0], apex[1], z * 0.3], along(reach * 0.94, z, 1.2), 0.5), paint);
    }
    for (let d = 5; d < reach; d += 10) set(beam(along(d, -4), along(d, 4), 0.8, 1.6), paint);
    set(beam(along(reach - 0.6, -4.4), along(reach - 0.6, 4.4), 1.2, 2.8), paint);
    set.lamp(...along(reach, 0, 1.6), RED, 1.3, 0.4, 0, false);
    set.lamp(apex[0], apex[1] + 1.4, 0, RED, 1.6, 0.5, 2.2, false);
    for (const d of raised ? [22, 50] : [10, 26, 42, 58]) for (const z of [-3, 3]) set.lamp(...along(d, z, raised ? 1.8 : -1.8), COLD, raised ? 0.8 : 1.5, 0.5);
    if (!raised) {
      // Trolley, driver's cab and the spreader on its falls.
      set(box(6, 2.2, 9.4, -trolley, 44, 0), dark);
      set(box(3.2, 3.2, 3.6, -trolley + 4.4, 41.4, 2.4), pale);
      set(quad(2.6, 1.4, -trolley + 2.5, 41.2, 2.4, "x-"), 0x9fd8c8, 1.0);
      const hook = 22 + ((trolley * 7) % 13);
      for (const [x, z] of [[-1.2, -5.6], [1.2, -5.6], [-1.2, 5.6], [1.2, 5.6]]) set(beam([-trolley + x, 43, z], [-trolley + x, hook + 0.5, z], 0.22), dark);
      set(box(2.7, 0.8, 12.6, -trolley, hook, 0), 0xc9a02a);
      if (trolley % 4 === 2) set(box(2.44, 2.6, 12.2, -trolley, hook - 1.7, 0), LINES[(trolley / 2) % LINES.length].paint);
    }
  };

  /** A level-luffing harbour crane: portal, slewing house, lattice jib. */
  const farLuffer = (set: Yonder, paint: number, slew: number, luff: number) => {
    for (const [x, z] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) set(beam([x, 0, z], [x * 0.5, 12, z * 0.5], 1.0), paint);
    set(box(8, 1.2, 8, 0, 12.6, 0), paint);
    set(cyl(2.2, 9, 0, 17.6, 0, "y", 8), paint);
    const turn = new THREE.Matrix4().makeRotationY(slew).setPosition(0, 22, 0);
    const up = (geometry: THREE.BufferGeometry, colour: number, glow = 0) => set(geometry.applyMatrix4(turn), colour, glow);
    up(box(7, 5.4, 9.6, 0, 2.7, -1.6), 0xc9c6b8); up(box(7.4, 0.4, 10, 0, 5.6, -1.6), 0x202428); up(box(5, 3, 3, 0, 1.5, -8), 0x202428);
    up(quad(1.6, 1.3, -3.52, 3.3, 1.8, "x-"), WARM, 1.5); up(box(2.4, 2.6, 2.6, 2.6, 2.9, 4.2), 0xc9c6b8); up(quad(2.0, 1.2, 2.6, 3.2, 5.55, "z+"), 0x9fd8c8, 0.9);
    const span = 46, tip: V3 = [0, 4 + span * Math.sin(luff), 3 + span * Math.cos(luff)];
    for (const x of [-1.5, 1.5]) { up(beam([x, 4, 3], [x * 0.3, tip[1], tip[2]], 0.6), paint); up(beam([x, 6, -2], [x * 0.4, 21, -4], 0.6), paint); up(beam([x, 6, 2], [x * 0.4, 21, -4], 0.5), paint); }
    for (let i = 1; i < 8; i += 1) { const t = i / 8, w = 1.5 - 1.2 * t; up(beam([-w, 4 + (tip[1] - 4) * t, 3 + (tip[2] - 3) * t], [w, 4 + (tip[1] - 4) * (t + 0.09), 3 + (tip[2] - 3) * (t + 0.09)], 0.3), paint); }
    up(beam([0, 21, -4], [0, tip[1] * 0.98, tip[2] * 0.96], 0.3), 0x202428);
    up(beam([0, tip[1], tip[2]], [0, 9, tip[2]], 0.2), 0x202428);
    up(box(2.2, 2.6, 2.2, 0, 7.8, tip[2]), 0x3a3f42);
    const head = new THREE.Vector3(0, tip[1], tip[2]).applyMatrix4(turn), cab = new THREE.Vector3(0, 6.2, 4).applyMatrix4(turn);
    set.lamp(head.x, head.y + 0.8, head.z, RED, 1.3, 0.4, 0, false);
    set.lamp(cab.x, cab.y, cab.z, COLD, 1.4, 0.5);
  };

  // Names for the ships across the water: one sheet, a name to a row.
  const NAMES = ["NINJA DEFUSE", "FAKE A", "HOLD THIS POSITION", "PEEKER'S ADVANTAGE", "SKILL ISSUE", "PORT MIRAGE", "RUSH B", "OVERPASS", "ECO"];
  const nameWide: number[] = [];
  const nameSheet = track(canvasTexture(1024, 1024, (context) => {
    context.fillStyle = "#ffffff"; context.textBaseline = "middle"; context.font = "700 76px 'Helvetica Neue', Arial, sans-serif";
    NAMES.forEach((name, row) => { nameWide.push(Math.min(1000, context.measureText(name).width)); context.fillText(name, 8, row * 100 + 54, 1000); });
  }));
  nameSheet.anisotropy = anisotropy;

  type FarShip = {
    length: number; wide: number; deck: number; hull: number; boot: number; line: number; funnel: number; band: number;
    house: [fore: number, aft: number, floors: number];
    /** Tiers of boxes on deck; none, and she has hatches and `gear` cranes of her own instead. */
    tiers: number; gear?: number; lit: number;
    /** How she lies, which decides the lights she shows. */
    state: "under way" | "at anchor" | "alongside";
    /** Rows of the name sheet: her own name, and the line's where it is painted along her side. */
    name: number; side?: number;
    /** Near enough for stanchions, rigging and draught marks to be worth their triangles. */
    fine?: boolean;
  };
  /**
   * A ship across the water: bow toward −z, starboard toward +x, heights from her waterline. The hull is lofted through
   * stations (raked stem, flare, sheer, a counter under the transom) and plated in strakes over a boot-topping; the house
   * is decks of cabins under a wheelhouse with wings, a mast, a raked funnel and a free-fall boat on its ramp. Boxes on
   * deck if she carries them, hatches and her own cranes if not. Her decks are above the eye from anywhere on the range,
   * so they are left out, and only the sides that can be seen get their detail.
   */
  const farShip = (set: Yonder, ship: FarShip, seed: number) => {
    const next = rng(seed), L = ship.length, half = ship.wide / 2, fine = !!ship.fine, boxes = ship.tiers > 0;
    const white = 0xd9d6cb, grey = 0x9a9c98, dark = 0x1c2024, glass = 0x0b1016, proud = fine ? 0.13 : 0.3;
    const [fore, aft, floors] = ship.house, F = 2.8;
    const speck = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7 + seed * 1.3) * 43758.5453; return s - Math.floor(s); };
    const seenFore = set.seen(0, -1, 0, fore), seenAft = set.seen(0, 1, 0, aft), seenPort = set.seen(-1, 0, -half, 0), seenStar = set.seen(1, 0, half, 0);

    // Hull form. `t` runs from the stem (0) to the transom (1), `h` from the waterline (0) to the deck edge (1).
    const rake = 0.04 * L, counter = 0.028 * L, castle = 0.125, poop = boxes ? 2 : (fore - 2.5 + L / 2) / L;
    const sheer = (t: number) => ship.deck + Math.min(2.4, 0.028 * L) * Math.max(0, 1 - t / 0.2) ** 2 + 0.3 * Math.max(0, (t - 0.86) / 0.14) ** 2;
    const rail = (t: number) => sheer(t) + (t < castle || t > poop ? 2.5 : 1.1);
    const breadth = (t: number, h: number) => {
      const entrance = 0.16 + 0.1 * (1 - h), run = 0.8 + 0.1 * h;
      const forward = t < entrance ? 1 - (1 - t / entrance) ** 2.2 : 1, after = t > run ? 1 - (0.1 + 0.42 * Math.max(0, 1 - h) ** 1.5) * ((t - run) / (1 - run)) ** 1.8 : 1;
      return half * forward * after;
    };
    const along = (t: number, h: number) => -L / 2 + (1 - h) * rake + t * (L - (1 - h) * (rake + counter));
    /** A point on her plating, or `out` metres off it. */
    const skin = (t: number, y: number, side: number, out = 0): V3 => { const h = Math.max(0, y / sheer(t)); return [side * (breadth(t, h) + out), y, along(t, h)]; };

    // Plating from the keel up: antifouling, boot-topping, strakes with their seams, a painted sheer line, the bulwark.
    const bootTop = 0.6 + ship.deck * 0.11, lineTop = bootTop + 0.5, strakes = Math.max(2, Math.round((ship.deck - lineTop) / (fine ? 1.3 : 2.4)));
    const levels = (t: number) => {
      const top = sheer(t) - 0.1, list = [-1.2, bootTop, bootTop + 0.09, lineTop];
      for (let k = 1; k <= strakes; k += 1) { const y = lineTop + (top - lineTop) * k / strakes; if (k < strakes) list.push(y - 0.07); list.push(y); }
      list.push(sheer(t) + 0.08, rail(t));
      return list;
    };
    const bands: Array<[colour: number, gain: number, plated: boolean]> = [[ship.boot, 1, false], [0x0c0d0e, 1, false], [ship.line, 1, false]];
    for (let k = 1; k <= strakes; k += 1) { bands.push([ship.hull, 1, true]); if (k < strakes) bands.push([ship.hull, 0.55, false]); }
    bands.push([ship.line, 1, false], [ship.hull, 1.05, true]);
    // Stations close together where she curves, a plate apart along the parallel body.
    const stations = [0, 0.008, 0.02, 0.04, 0.065, 0.095, castle - 0.0004, castle + 0.0004, 0.16, 0.2, 0.76, 0.81, 0.85, 0.885, 0.915, 0.94, 0.96, 0.98, 1];
    for (let plates = Math.round(0.56 * L / 10), plate = 1; plate < plates; plate += 1) stations.push(0.2 + 0.56 * plate / plates);
    if (!boxes) stations.push(poop - 0.0004, poop + 0.0004);
    stations.sort((a, b) => a - b);
    {
      const rows = stations.map((t) => levels(t).map((y) => skin(t, y, 1))), J = rows[0].length, grid = new THREE.BufferGeometry(), index: number[] = [];
      grid.setAttribute("position", new THREE.Float32BufferAttribute(rows.flat(2), 3));
      for (let i = 0; i < rows.length - 1; i += 1) for (let j = 0; j < J - 1; j += 1) { const a = i * J + j, b = a + J; index.push(a, a + 1, b, b, a + 1, b + 1); }
      grid.setIndex(index);
      grid.computeVertexNormals();
      const at = grid.attributes.position, normal = grid.attributes.normal, points: number[] = [], normals: number[] = [], paints: number[] = [], paint = new THREE.Color();
      const emit = (corners: number[], side: number, face: number) => {
        for (const v of corners) { points.push(side * at.getX(v), at.getY(v), at.getZ(v)); normals.push(face * side * normal.getX(v), face * normal.getY(v), face * normal.getZ(v)); paints.push(paint.r, paint.g, paint.b); }
      };
      for (const side of [1, -1]) for (let i = 0; i < rows.length - 1; i += 1) for (let j = 0; j < J - 1; j += 1) {
        const a = i * J + j, b = a + J, outward = [a, a + 1, b, b, a + 1, b + 1], inward = [a, b, a + 1, b, b + 1, a + 1], [colour, gain, plated] = bands[j];
        paint.set(colour).multiplyScalar(gain * (plated ? 0.86 + 0.24 * speck(i, j + side) : 1));
        emit(side > 0 ? outward : inward, side, 1);
        // The inside of the bulwark shows over the nearer rail where she rises to the forecastle.
        if (j === J - 2) { paint.set(grey); emit(side > 0 ? inward : outward, side, -1); }
      }
      // The transom closes her, banded like the sides.
      const last = rows[rows.length - 1];
      for (let j = 0; j < J - 1; j += 1) {
        const [x0, y0, z0] = last[j], [x1, y1, z1] = last[j + 1];
        paint.set(bands[j][0]).multiplyScalar(bands[j][1]);
        for (const corner of [[-x0, y0, z0], [x0, y0, z0], [x1, y1, z1], [-x0, y0, z0], [x1, y1, z1], [-x1, y1, z1]]) { points.push(...corner); normals.push(0, 0.2, 0.98); paints.push(paint.r, paint.g, paint.b); }
      }
      grid.dispose();
      const hull = new THREE.BufferGeometry();
      hull.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      hull.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      hull.setAttribute("paint", new THREE.Float32BufferAttribute(paints, 3));
      set(hull, 0xffffff);
    }
    // The breaks of the forecastle and the poop.
    for (const [t, face] of boxes ? [[castle, 1]] : [[castle, 1], [poop, -1]]) {
      const low = sheer(t), top = sheer(t) + 2.5;
      set(box(breadth(t, 1) * 2 - 0.2, top - low, 0.3, 0, (low + top) / 2, along(t, 1) - face * 0.15), white);
    }
    /** A patch on the plating, a little off it: between two stations and two heights on one side. */
    const patch = (side: number, t0: number, t1: number, y0: number, y1: number, colour: number, out = proud) => {
      const a = skin(t0, y0, side, out), b = skin(t1, y0, side, out), c = skin(t1, y1, side, out), d = skin(t0, y1, side, out), geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(side > 0 ? [...a, ...d, ...b, ...b, ...d, ...c] : [...a, ...b, ...d, ...b, ...c, ...d], 3));
      geometry.computeVertexNormals();
      set(geometry, colour);
    };
    /** Lettering from the name sheet, `tall` metres high, laid over `at(across, up)`: metres from its middle as it is read. */
    const lettering = (row: number, tall: number, at: (across: number, up: number) => V3, pieces = 1) => {
      const high = tall / 0.6, wide = high * (nameWide[row] + 16) / 92, share = (nameWide[row] + 16) / 1024, low = 1 - (row * 100 + 98) / 1024, top = 1 - (row * 100 + 6) / 1024;
      const points: number[] = [], uvs: number[] = [], geometry = new THREE.BufferGeometry();
      for (let piece = 0; piece < pieces; piece += 1) {
        const u0 = piece / pieces, u1 = (piece + 1) / pieces, x0 = (u0 - 0.5) * wide, x1 = (u1 - 0.5) * wide;
        points.push(...at(x0, -high / 2), ...at(x1, -high / 2), ...at(x1, high / 2), ...at(x0, -high / 2), ...at(x1, high / 2), ...at(x0, high / 2));
        uvs.push(u0 * share, low, u1 * share, low, u1 * share, top, u0 * share, low, u1 * share, top, u0 * share, top);
      }
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.computeVertexNormals();
      set.letters(geometry);
    };
    const streak = new THREE.Color(ship.hull).lerp(new THREE.Color(0x6a3a22), 0.55).getHex();
    for (const side of [-1, 1]) if (side < 0 ? seenPort : seenStar) {
      // Anchor in its pocket and the rust it weeps, draught marks at the stem, freeing ports, the stains under the scuppers.
      patch(side, 0.04, 0.04 + 1.3 / L, sheer(0.045) + 0.5, sheer(0.045) + 1.9, 0x101112, proud * 2);
      patch(side, 0.043, 0.043 + 0.5 / L, bootTop + 0.5, sheer(0.045) + 0.5, streak);
      if (fine) for (let mark = 0; mark < 6; mark += 1) patch(side, 0.014, 0.014 + 0.5 / L, lineTop + 0.2 + mark * 0.45, lineTop + 0.42 + mark * 0.45, 0xe8e6de);
      for (let t = castle + 0.03; t < Math.min(poop, 0.87) - 0.02; t += 7.5 / L) patch(side, t, t + 1.2 / L, sheer(t) + 0.22, sheer(t) + 0.5, 0x0c0d0e);
      for (let i = 0; i < L / 14; i += 1) { const t = castle + 0.04 + next() * 0.7; patch(side, t, t + 0.24 / L, sheer(t) - 1.4 - next() * 2.4, sheer(t) - 0.2, streak); }
      // Her name on the bow; the line's name along the side where it is painted there.
      lettering(ship.name, Math.min(1.0, ship.deck * 0.085), (across, up) => skin(0.085 - side * across / L, sheer(0.085) + 1.25 + up, side, 0.32), 6);
      if (ship.side !== undefined) lettering(ship.side, ship.deck * 0.42, (across, up) => skin(0.47 - side * across / L, lineTop + (ship.deck - lineTop) * 0.52 + up, side, 0.32));
      // Riding to her anchor on this side.
      if (ship.state === "at anchor" && side > 0 === seenStar) { const hawse = skin(0.045, sheer(0.045) + 0.6, side, 0.3); set(beam(hawse, [hawse[0] + side * 3, -0.6, hawse[2] - 16], 0.22), dark); }
    }
    if (seenAft) {
      // Name and port of registry across the transom.
      [ship.name, 5].forEach((row, line) => {
        const y = sheer(1) - 0.9 - line * Math.min(1.9, ship.deck * 0.24);
        lettering(row, Math.min(0.9, ship.deck * 0.11) * (line ? 0.7 : 1), (across, up) => [across, y + up, along(1, (y + up) / sheer(1)) + 0.34]);
      });
    }

    // Forecastle: mast with its crosstree, forestay and jackstaff.
    const bowZ = along(0.07, 1), bowY = sheer(0.07) + 1.5, mastHead: V3 = [0, bowY + 10.3, bowZ];
    set(beam([0, bowY, bowZ], [0, bowY + 10, bowZ], 0.42), white); set(box(3.2, 0.14, 0.14, 0, bowY + 7.4, bowZ), white);
    if (fine) {
      const stem = skin(0, rail(0), 1);
      set(beam([0, bowY + 9.8, bowZ], [0, stem[1] + 0.2, stem[2] + 0.3], 0.06), dark); set(beam([0, stem[1] - 0.2, stem[2] + 0.4], [0, stem[1] + 2.4, stem[2] + 0.4], 0.09), white);
    }

    // The house. Each deck is a wall of cabins under a slab that oversails it as a railed walkway; the decks step in aft.
    const foot = sheer((fore + L / 2) / L) + (boxes ? 0.25 : 2.6), wide = ship.wide - (boxes ? 1 : 3.2), terrace = boxes ? 0.6 : 1.3;
    /** A row of cabin lights on one wall. */
    const lights = (facing: Facing, fixed: number, from: number, to: number, y: number, lit: number, w = 0.8, h = 0.7, pitch = 1.9) => {
      const count = Math.floor((to - from) / pitch);
      for (let i = 0; i < count; i += 1) {
        const at = from + (to - from - (count - 1) * pitch) / 2 + i * pitch, on = next() < lit;
        set(facing === "x-" || facing === "x+" ? quad(w, h, fixed, y, at, facing) : quad(w, h, at, y, fixed, facing), on ? (next() < 0.2 ? COLD : WARM) : glass, on ? 0.8 + next() * 1.2 : 0);
      }
    };
    /** Two rails round the edge of a slab, with stanchions where they can be made out. */
    const railing = (w: number, l: number, y: number, z: number) => {
      for (const up of [0.52, 1.0]) {
        for (const side of [-1, 1]) set(box(0.07, 0.07, l, side * w / 2, y + up, z), white);
        for (const end of [-1, 1]) set(box(w, 0.07, 0.07, 0, y + up, z + end * l / 2), white);
      }
      if (!fine) return;
      const sides = Math.round(l / 2.2), ends = Math.round(w / 2.2);
      for (let i = 0; i <= sides; i += 1) for (const side of [-1, 1]) if (side < 0 ? seenPort : seenStar) set(box(0.06, 1.0, 0.06, side * w / 2, y + 0.5, z - l / 2 + l * i / sides), white);
      for (let i = 1; i < ends; i += 1) for (const end of [-1, 1]) if (end < 0 ? seenFore : seenAft) set(box(0.06, 1.0, 0.06, -w / 2 + w * i / ends, y + 0.5, z + end * l / 2), white);
    };
    let longTop = aft - fore;
    for (let floor = 0; floor < floors; floor += 1) {
      const bridge = floor === floors - 1, y = foot + floor * F, back = aft - Math.min(floor, 3) * terrace, w = wide - (floor ? 1.2 : 0), long = back - fore, z = (fore + back) / 2;
      longTop = long;
      set(box(w, F, long, 0, y + F / 2, z), white);
      const over = bridge ? 0.5 : 1.0;
      set(box(w + over * 2, 0.16, long + over + 1.5, 0, y + F + 0.08, z + (1.5 - over) / 2), grey);
      railing(w + over * 2, long + over + 1.5, y + F + 0.16, z + (1.5 - over) / 2);
      if (bridge) {
        // Wheelhouse: glass right round the front and down both sides, wings out past the ship's side behind their dodgers.
        const wingZ = fore + 1.7, reach = half + 0.5, level = y + 1.75;
        set(box(reach * 2, 0.2, 3.4, 0, y + 0.1, wingZ), grey);
        for (const side of [-1, 1]) {
          set(box(reach - w / 2, 1.1, 0.1, side * (w / 2 + reach) / 2, y + 0.75, wingZ - 1.7), white); set(box(0.1, 1.1, 3.4, side * reach, y + 0.75, wingZ), white);
          set(box(0.3, 0.5, 0.9, side * (reach - 0.2), y + 1.55, wingZ), dark);
          if (side < 0 ? seenPort : seenStar) {
            set(quad(long * 0.55, 1.2, side * (w / 2 + 0.3), level, fore + long * 0.275 + 0.1, side < 0 ? "x-" : "x+"), glass);
            for (let at = fore + 0.2; at < fore + long * 0.55 + 0.2; at += 1.45) set(box(0.2, 1.2, 0.14, side * (w / 2 + 0.42), level, at), white);
            lights(side < 0 ? "x-" : "x+", side * (w / 2 + 0.3), fore + long * 0.6, back - 0.4, y + 1.65, ship.lit * 0.7);
          }
        }
        if (seenFore) { set(quad(w - 0.5, 1.2, 0, level, fore - 0.3, "z-"), glass); for (let x = -w / 2 + 0.25; x < w / 2; x += 1.45) set(box(0.14, 1.2, 0.2, x, level, fore - 0.42), white); }
        if (seenAft) lights("z+", back + 0.3, -w / 2 + 0.6, w / 2 - 0.6, y + 1.65, ship.lit * 0.6);
      } else {
        const lit = ship.lit * (floor ? 1 : 0.6), level = y + 1.65, size = floor ? 0.8 : 0.5;
        if (seenFore) lights("z-", fore - 0.3, -w / 2 + 0.6, w / 2 - 0.6, level, lit * 0.5, size, size * 0.9);
        if (seenAft) { lights("z+", back + 0.3, -w / 2 + 0.6, w / 2 - 0.6, level, lit, size, size * 0.9); if (fine) set(quad(0.75, 1.95, w / 2 - 1.5 - floor * 0.4, y + 1.0, back + 0.26, "z+"), 0x3c4246); }
        if (seenPort) lights("x-", -w / 2 - 0.3, fore + 0.6, back - 0.6, level, lit, size, size * 0.9);
        if (seenStar) lights("x+", w / 2 + 0.3, fore + 0.6, back - 0.6, level, lit, size, size * 0.9);
        // A companion ladder up the after end of each deck, and a lamp under the deck above.
        const side = seenPort ? -1 : 1;
        if (fine) set(beam([side * (w / 2 - 1.2), y + 0.1, back + 2.9], [side * (w / 2 - 1.2), y + F + 0.1, back + 0.5], 0.7, 0.12), grey);
        if (floor % 2) set.lamp(side * (w / 2 + 0.9), y + F - 0.4, back - 1.5, SODIUM, 0.7, 0.35);
      }
    }
    const top = foot + floors * F + 0.16, mastZ = fore + 2.4, mastTop = top + 10.5;
    // Monkey island: mast with yard and scanners, domes, whips and halyards.
    set(beam([0, top, mastZ], [0, top + 5.2, mastZ], 0.55), white); set(beam([0, top + 5.2, mastZ], [0, mastTop, mastZ], 0.3), white);
    set(box(5.4, 0.16, 0.16, 0, top + 6.6, mastZ), white); set(box(2.4, 0.14, 1.9, 0, top + 3.4, mastZ - 0.9), grey); set(box(1.5, 0.14, 0.5, 0.6, top + 5.3, mastZ), grey);
    const sweep = next() * Math.PI;
    set(cyl(0.22, 0.5, 0, top + 3.72, mastZ - 1.2, "y", 6), dark); set(box(3.4, 0.24, 0.34, 0, 0, 0).rotateY(sweep).translate(0, top + 4.1, mastZ - 1.2), white);
    set(box(2.0, 0.2, 0.28, 0, 0, 0).rotateY(sweep + 1.3).translate(1.1, top + 5.5, mastZ), white);
    for (const [x, r] of [[-wide * 0.28, 0.85], [wide * 0.3, 0.55]]) { set(cyl(0.26, 1.0, x, top + 0.5, mastZ + 2.6, "y", 6), white); set(new THREE.SphereGeometry(r, 9, 6).translate(x, top + 1.0 + r * 0.8, mastZ + 2.6), 0xe6e3da); }
    if (fine) {
      for (const x of [-wide * 0.4, wide * 0.38]) set(beam([x, top, fore + 0.8], [x * 1.03, top + 5.5, fore + 0.6], 0.07), white);
      for (const side of [-1, 1]) set(beam([side * 2.6, top + 6.6, mastZ], [side * (wide / 2 - 1), top + 1.1, mastZ + 0.6], 0.05), 0x8a8880);
      for (const side of [-1, 1]) set(cyl(0.3, 1.1, side * (wide / 2 - 0.9), top - F + 0.32, fore + longTop + 0.9, "z", 8), 0xe6e3da);
    }
    // Funnel: raked, in the line's colours under a black top, the uptakes standing out of it.
    const stackZ = fore + longTop * 0.7, rx = wide * 0.13, rz = longTop * 0.19, tall = 3 + ship.wide * 0.21;
    const funnel = (from: number, to: number, colour: number, swell = 1) => {
      const geometry = new THREE.CylinderGeometry(swell, swell, (to - from) * tall, 14).scale(rx, 1, rz).translate(0, top + (from + to) / 2 * tall, stackZ), at = geometry.attributes.position;
      for (let i = 0; i < at.count; i += 1) at.setZ(i, at.getZ(i) + (at.getY(i) - top) * 0.13);
      geometry.computeVertexNormals();
      set(geometry, colour);
    };
    funnel(0, 0.56, ship.funnel); funnel(0.56, 0.76, ship.band); funnel(0.76, 1, 0x141516); funnel(0.97, 1.02, dark, 1.07);
    for (const x of [-rx * 0.35, rx * 0.35]) set(cyl(rx * 0.22, 1.5, x, top + tall + 0.5, stackZ + tall * 0.13 + rz * 0.2, "y", 7), dark);
    // Free-fall boat on its ramp over the stern.
    {
      const y = foot + F * 1.15, z = aft + Math.min(4.4, (L / 2 - aft) * 0.5);
      set(new THREE.CapsuleGeometry(1.1, 4.6, 3, 9).rotateX(Math.PI / 2 + 0.5).translate(0, y + 1.3, z), 0xe0561a);
      for (const side of [-1, 1]) { set(beam([side * 0.9, y + 1.9, z - 3.4], [side * 0.9, y - 1.9, z + 3.4], 0.3), white); set(beam([side * 0.9, foot, z - 2.2], [side * 0.9, y + 1.2, z - 2.2], 0.26), white); set(beam([side * 0.9, foot, z + 1.6], [side * 0.9, y - 0.9, z + 1.6], 0.26), white); }
    }

    const first = along(castle, 1) + 2.5, last = fore - 4.5, near = seenPort ? -1 : 1;
    if (boxes) {
      // Deck cargo, bay by bay: the row along the side that shows box by box, the rest as the blocks they read as from here.
      const level = ship.deck + 1.4;
      for (let z = first + 6.5; z + 6.5 < last; z += 13.4) {
        const high = 2 + Math.floor(next() * (ship.tiers - 1));
        for (let tier = 0; tier < high; tier += 1) {
          if (next() < 0.3) for (const end of [-1, 1]) set(box(2.5, 2.6, 6.0, near * (half - 1.6), level + 1.3 + tier * 2.62, z + end * 3.1), LINES[Math.floor(next() * LINES.length)].paint);
          else set(box(2.5, 2.6, 12.3, near * (half - 1.6), level + 1.3 + tier * 2.62, z), LINES[Math.floor(next() * LINES.length)].paint);
        }
        for (let strip = 0; strip < 3; strip += 1) {
          const w = (ship.wide - 6.4) / 3, stack = Math.max(1, high + Math.floor(next() * 3) - 1) * 2.62;
          set(box(w - 0.2, stack, 12.3, near * (half - 3.1 - w * (strip + 0.5)), level + stack / 2, z), LINES[Math.floor(next() * LINES.length)].paint);
        }
        set(box(ship.wide - 1, 5.4, 0.5, 0, level + 2.4, z + 6.7), dark);
        if (next() < 0.5) set.lamp(near * (half - 0.8), level + 5.3, z + 6.7, COLD, 0.9, 0.4, 0, false);
      }
    } else {
      // Hatches between their coamings, and her own cranes with the jibs down in their rests.
      const cranes = ship.gear ?? 0, pitch = (last - first) / (cranes + 1), level = ship.deck + 0.2;
      for (let hold = 0; hold <= cranes; hold += 1) {
        const z = first + pitch * (hold + 0.5);
        set(box(ship.wide * 0.68, 1.5, pitch - 7, 0, level + 0.75, z), 0x4f3128); set(box(ship.wide * 0.7, 0.5, pitch - 6.6, 0, level + 1.75, z), 0x76473a);
      }
      for (let crane = 1; crane <= cranes; crane += 1) {
        const z = first + pitch * crane, y = level + 7, reach = pitch - 4, tip: V3 = [0, y + 1.2 + Math.sin(0.1) * reach, z + 1.4 + Math.cos(0.1) * reach];
        set(cyl(1.0, 7, 0, level + 3.5, z, "y", 10, 0.85), white);
        set(box(3.0, 3.2, 3.8, 0, y + 1.6, z - 0.3), white); set(box(3.2, 0.2, 4.0, 0, y + 3.3, z - 0.3), grey);
        if (seenAft) set(quad(1.6, 1.0, 0.5, y + 2.1, z + 1.92, "z+"), glass);
        for (const x of [-1.1, 1.1]) set(beam([x, y + 3.3, z - 1.5], [0, y + 6.4, z - 1.1], 0.22), white);
        for (const x of [-0.55, 0.55]) set(beam([x, y + 1.2, z + 1.4], [x * 0.45, tip[1], tip[2]], 0.5, 0.34), white);
        if (fine) for (let tie = 1; tie < 7; tie += 1) { const t = tie / 7; set(box(1.1 - 0.6 * t, 0.2, 0.2, 0, y + 1.2 + (tip[1] - y - 1.2) * t, z + 1.4 + (tip[2] - z - 1.4) * t), white); }
        set(beam([0, y + 6.4, z - 1.1], [0, tip[1] + 0.3, tip[2] - 0.5], 0.11), dark);
        set(box(0.5, 0.9, 0.5, 0, tip[1] - 1.0, tip[2] - 0.3), 0xc9a02a);
        set(beam([0, level + 0.4, tip[2] - 0.5], [0, tip[1] - 0.25, tip[2] - 0.5], 0.3), white);
        set.lamp(0, y + 3.6, z + 1.6, COLD, 1.1, 0.42, 0, false);
      }
    }

    // Lights, by the rules: what a ship shows depends on what she is doing and where she is seen from.
    const bearing = set.bearing(), wingY = foot + (floors - 1) * F + 1.5;
    if (ship.state === "under way") {
      // Masthead and side lights from ahead to two points abaft the beam; from further aft, only the stern light.
      if (Math.abs(bearing) <= 1.9635) { set.lamp(...mastHead, MASTHEAD, 1.2, 0.4); set.lamp(0, mastTop + 0.3, mastZ, MASTHEAD, 1.3, 0.42); set.lamp(Math.sign(bearing || 1) * (half + 0.4), wingY, fore + 1.7, bearing < 0 ? RED : GREEN, 1.0, 0.36); }
      else set.lamp(0, sheer(1) + 1.6, along(1, 1 + 1.6 / sheer(1)) + 0.4, MASTHEAD, 1.3, 0.42);
    } else if (ship.state === "at anchor") {
      set.lamp(...mastHead, MASTHEAD, 1.4, 0.45); set.lamp(0, sheer(1) + 3.6, L / 2 - 1, MASTHEAD, 1.1, 0.4);
      for (const z of [first + 8, (first + last) / 2, last - 6]) set.lamp(near * (half - 1), ship.deck + 7, z, COLD, 0.8, 0.4, 0, false);
    } else {
      for (const x of [-wide / 2 + 1, wide / 2 - 1]) set.lamp(x, top - 0.6, fore - 0.6, COLD, 1.5, 0.5);
      set.lamp(0, bowY + 7.6, bowZ, COLD, 1.2, 0.45);
    }
    set.lamp(0, mastTop - 2.6, mastZ, RED, 0.9, 0.34, 0, false);
  };

  {
    // The terminal on the far bank: quay wall with its fenders, apron, boxes in the stack, light masts.
    const quay = yonder(farWet, 300, 0);
    quay(box(110, 3.6, 262, 55, 1.4, -68), 0x8f8c84);
    for (let z = -196; z < 62; z += 13) quay(box(0.9, 2.5, 1.7, -0.45, 1.6, z), 0x101112);
    quay(box(0.8, 0.5, 262, 0.4, 3.45, -68), 0xb8922a);
    const next = rng(4410);
    for (let row = 0; row < 3; row += 1) for (let z = -190; z < 12; z += 13.6) {
      const tall = 2 + Math.floor(next() * 4);
      for (let tier = 0; tier < tall; tier += 1) quay(box(7.6 + (tier ? 0 : 0.2), 2.6, 12.3, 46 + row * 11, 4.5 + tier * 2.62, z), LINES[Math.floor(next() * LINES.length)].paint);
    }
    for (const z of [-170, -118, -66, -14, 34]) {
      quay(cyl(0.5, 34, 40, 20.2, z, "y", 6, 0.3), 0x6a6e70); quay(box(3.4, 0.6, 3.4, 40, 37.4, z), 0x202428);
      for (const [x, dz] of [[-1.2, -1.2], [1.2, 1.2], [-1.2, 1.2], [1.2, -1.2]]) quay.lamp(40 + x, 36.9, z + dz, COLD, 1.5, 0.55, 0, x < 0 && dz < 0);
    }
    // Her cranes, two working the ship and one topped up; a fourth beyond.
    const orange = 0x94503c;
    farCrane(yonder(farWet, 303, -136, 0, WATER_Y + 3.2), orange, true, 0);
    farCrane(yonder(farWet, 303, -96, 0, WATER_Y + 3.2), orange, false, 14);
    farCrane(yonder(farWet, 303, -66, 0, WATER_Y + 3.2), orange, false, 30);
    farCrane(yonder(farWet, 303, -38, 0, WATER_Y + 3.2), orange, false, 22);
    farCrane(yonder(farWet, 303, -6, 0, WATER_Y + 3.2), orange, true, 0);
    // The ship alongside, stern toward the harbour mouth.
    farShip(yonder(farWet, 282.5, -86), { length: 196, wide: 31, deck: 11.5, hull: 0x1d3147, boot: 0x6a2018, line: 0xd9d6cb, funnel: 0x1d3147, band: 0xd9a52a, house: [70, 86, 7], tiers: 6, lit: 0.45, state: "alongside", name: 1, side: 6 }, 9102);
    // South of her a berth for bulk: shed, heaps, a luffing crane at work and another at rest, silos behind.
    quay(box(34, 9, 30, 44, 7.7, 38), 0x7d8a8e);
    const roof = new THREE.CylinderGeometry(19.6, 19.6, 31, 3, 1).rotateX(-Math.PI / 2).scale(1, 0.24, 1).translate(44, 14.55, 38);
    quay(roof, 0x59666a);
    quay(quad(6, 6.5, 26.7, 6.5, 38, "x-"), 0x15191c); quay(quad(1.4, 1.0, 26.7, 9.6, 30, "x-"), WARM, 1.6); quay.lamp(26.4, 11, 38, SODIUM, 1.3, 0.5);
    for (const [x, z, r] of [[14, 22, 9], [17, 50, 7], [9, 37, 5]]) quay(new THREE.ConeGeometry(r, r * 0.62, 9).translate(x, 3.2 + r * 0.31, z), x === 17 ? 0x5a4a38 : 0x3c3836);
    farLuffer(yonder(farWet, 307, 24, 0, WATER_Y + 3.2), 0x3d6a52, -1.1, 0.95);
    farLuffer(yonder(farWet, 307, 46, 0, WATER_Y + 3.2), 0x3d6a52, 0.5, 1.25);
    for (let i = 0; i < 6; i += 1) quay(cyl(6.2, 40, 82 + (i % 2) * 12.6, 23.2, 8 + Math.floor(i / 2) * 12.6, "y", 10), 0xa9a69c);
    quay(box(12, 12, 40, 88.3, 49.2, 20.6), 0x9a978e); quay(box(4, 4, 4, 88.3, 57, 6), 0x9a978e);
    quay(beam([82, 43, 20], [24, 13, 28], 2.4, 2.8), 0x6a6e70);
    quay.lamp(88.3, 59.6, 6, RED, 1.5, 0.5, 3.1, false); quay.lamp(81.8, 44, 14, COLD, 1.0, 0.4); quay.lamp(81.8, 30, 30, SODIUM, 0.9, 0.4);
    // The knuckle of the quay and its light.
    quay(cyl(1.6, 9, 3.2, 7.7, 59, "y", 8, 1.1), 0x1d6b3c); quay(cyl(1.5, 1.4, 3.2, 12.9, 59, "y", 8), 0xd9d6cb); quay.lamp(3.2, 13.9, 59, GREEN, 2.0, 0.5, 4);
    // Works behind the terminal: two chimneys, a tank farm, the town on the hill.
    const works = yonder(farWet, 430, -40);
    for (const [x, z, tall, wide] of [[0, 0, 124, 4.6], [26, 34, 96, 3.8]]) {
      works(cyl(wide, tall, x, tall / 2, z, "y", 10, wide * 0.55), 0x8d8f8c);
      for (let band = 0; band < 3; band += 1) works(cyl(wide * 0.62 + 0.25 - band * 0.05, tall * 0.045, x, tall * (0.975 - band * 0.09), z, "y", 10, wide * 0.6 + 0.25 - band * 0.05), 0xa8201a);
      works.lamp(x, tall + 1, z, RED, 1.8, 0.6, 2.6, false); works.lamp(x + wide * 0.8, tall * 0.62, z, RED, 1.2, 0.5, 0, false); works.lamp(x - wide * 0.8, tall * 0.62, z, RED, 1.2, 0.5, 0, false);
    }
    works(box(60, 26, 34, 10, 13, 70), 0x5a5f62); works(box(22, 38, 22, -6, 19, 64), 0x62676a);
    // The ridge behind, little more than a tone, and the lights of the town on it.
    const ridge: number[] = [], crest = (z: number) => (34 + 22 * Math.sin(z * 0.011 + 1) + 9 * Math.sin(z * 0.037) + 5 * Math.sin(z * 0.09 + 2)) * (1 - ease(-10, 70, z)) + 0.5;
    for (let z = -330; z < 90; z += 30) ridge.push(480, 0, z, 480, 0, z + 30, 500, crest(z + 30), z + 30, 480, 0, z, 500, crest(z + 30), z + 30, 500, crest(z), z);
    const hill = new THREE.BufferGeometry();
    hill.setAttribute("position", new THREE.Float32BufferAttribute(ridge, 3));
    hill.computeVertexNormals();
    bake(farWet, hill.translate(0, WATER_Y, 0), 0x20262a);
    for (let i = 0; i < 70; i += 1) {
      const z = -300 + next() * 330, y = 4 + next() * Math.max(2, crest(z) - 8), pick = next();
      stars.push({ at: [470 + next() * 22, WATER_Y + y, z], colour: pick < 0.7 ? SODIUM : pick < 0.93 ? COLD : RED, gain: 0.45 + next() * 0.6, size: 0.4, flash: 0 });
    }
  }
  {
    // The breakwater that closes the basin to the south, a banded light tower on its head.
    const head: [number, number] = [119, 56], heading = Math.atan2(-48, 134);
    const set = yonder(farWet, head[0], head[1], heading);
    set(cyl(3.6, 150, 0, 0.5, 75, "z", 7).scale(1.7, 0.8, 1), 0x77756f);
    set(new THREE.SphereGeometry(7, 9, 5).scale(1, 0.42, 1).translate(0, 0.4, 0), 0x77756f);
    const next = rng(77);
    for (let i = 0; i < 34; i += 1) set(new THREE.DodecahedronGeometry(1.3 + next() * 1.3, 0).rotateY(i).translate(-4.6 + next() * 9.2, 1.3 + next() * 1.0, -3 + i * 4.4 + next() * 2), next() < 0.5 ? 0x8a8780 : 0x6c6a64);
    set(cyl(2.6, 1.6, 0, 3.6, 0, "y", 10), 0x9a978e);
    for (let band = 0; band < 5; band += 1) set(cyl(1.5 - band * 0.12, 2.4, 0, 5.6 + band * 2.4, 0, "y", 12, 1.38 - band * 0.12), band % 2 ? 0xa8201a : 0xdcd8cc);
    set(cyl(1.7, 0.25, 0, 16.9, 0, "y", 12), 0x202428); set(cyl(0.8, 1.6, 0, 17.8, 0, "y", 8), MASTHEAD, 1.6); set(cyl(1.0, 0.7, 0, 19, 0, "y", 8, 0.1), 0x202428);
    for (let i = 0; i < 8; i += 1) set(box(0.07, 1.0, 0.07, Math.cos(i * 0.785) * 1.6, 17.5, Math.sin(i * 0.785) * 1.6), 0x202428);
    set.lamp(0, 17.8, 0, MASTHEAD, 2.6, 0.7, 5);
    set(quad(0.7, 1.5, 0, 5.4, -1.56, "z-"), 0x15191c);
    for (const z of [38, 84, 128]) { set(beam([0, 2.6, z], [0, 8.6, z], 0.3), 0x6a6e70); set.lamp(0, 8.9, z, SODIUM, 0.9, 0.4); }
  }
  // A coaster outward bound through the harbour mouth, seen on her quarter, and two ships lying to their anchors in the
  // roads beyond, heads to the same wind and half lost in the bank.
  farShip(yonder(farWet, 188, 44, -2.4), { length: 92, wide: 15, deck: 5.4, hull: 0x7a2a20, boot: 0x16181a, line: 0xd9d6cb, funnel: 0xd9a52a, band: 0x16181a, house: [26, 38, 4], tiers: 0, gear: 2, lit: 0.6, state: "under way", name: 0, fine: true }, 51);
  farShip(yonder(farWet, 335, 232, 1.9), { length: 178, wide: 28, deck: 9.5, hull: 0x23272b, boot: 0x6a2018, line: 0xb8b6ae, funnel: 0x8a2a1e, band: 0xd9d6cb, house: [62, 78, 6], tiers: 0, gear: 3, lit: 0.35, state: "at anchor", name: 2 }, 52);
  farShip(yonder(farWet, 440, 112, 1.9), { length: 210, wide: 32, deck: 12, hull: 0x2a3a2a, boot: 0x6a2018, line: 0xd9d6cb, funnel: 0x2a3a2a, band: 0xd9d6cb, house: [74, 90, 7], tiers: 5, lit: 0.3, state: "at anchor", name: 3, side: 7 }, 53);

  {
    // This bank again, downstream of the range: the quay runs on to more cranes and another ship under them.
    const grey = 0x6b7378;
    farCrane(yonder(farDry, craneX + 4, -168, Math.PI, 0), grey, false, 30);
    farCrane(yonder(farDry, craneX + 4, -214, Math.PI, 0), grey, true, 0);
    farCrane(yonder(farDry, craneX + 4, -276, Math.PI, 0), grey, false, 12);
    farShip(yonder(farDry, shipX + 1, -236), { length: 190, wide: 30, deck: 12, hull: 0x7a2a20, boot: 0x16181a, line: 0xd9d6cb, funnel: 0xd9d6cb, band: 0x1d3147, house: [66, 82, 7], tiers: 6, lit: 0.4, state: "alongside", name: 4, side: 8 }, 54);
    // Inland, over the yard: stacking gantries, a grain terminal, the stacks of the power station.
    const yard = yonder(farDry, 0, 0, 0, 0);
    for (const [x, z, long] of [[-104, -66, 46], [-112, 18, 46], [-142, -150, 52], [-64, -196, 46], [-150, 96, 52]]) {
      for (const end of [-1, 1]) {
        for (const side of [-1, 1]) yard(box(1.1, 24, 1.1, x + side * 5, 12, z + end * long / 2), 0xc9a02a);
        yard(box(11.1, 1.4, 1.2, x, 3.2, z + end * long / 2), 0xc9a02a); yard(beam([x - 5, 4, z + end * long / 2], [x + 5, 23, z + end * long / 2], 0.6), 0xc9a02a);
        yard(box(12, 1.6, 4.4, x, 0.8, z + end * long / 2), 0x202428);
      }
      for (const side of [-1, 1]) yard(box(1.6, 2.6, long + 3, x + side * 5, 25, z), 0xc9a02a);
      yard(box(9, 2.4, 5, x, 23.6, z + long * 0.2), 0x202428); yard(box(2.6, 2.8, 2.8, x + 3, 21, z + long * 0.2 + 3.4), 0xc9cdd0);
      for (const at of [-0.32, 0.05, 0.36]) yard.lamp(x - 5.4, 24, z + long * at, COLD, 1.4, 0.5);
      yard.lamp(x, 27.4, z + long * 0.2, STRIKE_ORANGE, 1.0, 0.4, 1.4);
    }
    const grain = yonder(farDry, -262, -74, 0.35, 0);
    for (let i = 0; i < 10; i += 1) grain(cyl(7.4, 50, (i % 5) * 15.2 - 30.4, 25, Math.floor(i / 5) * 15.2 - 7.6, "y", 10), 0xa9a69c);
    grain(box(78, 9, 30, 0, 54.5, 0), 0x9a978e); grain(box(14, 26, 16, -44, 63, 0), 0x9a978e); grain(box(10, 5, 10, -44, 78.5, 0), 0x8a877e);
    grain(beam([-38, 62, 12], [40, 18, 70], 3, 3.4), 0x6a6e70);
    panes(grain, rng(5), "x+", 39.4, -12, 12, 50, 3, 3, 0.4); panes(grain, rng(6), "z+", 15.4, -36, 36, 50, 3, 3, 0.35);
    grain.lamp(-44, 82, 0, RED, 1.8, 0.6, 2.9); grain.lamp(-37, 70, 8.4, COLD, 1.2, 0.5); grain.lamp(20, 59.6, 15.4, SODIUM, 1.0, 0.5);
    const power = yonder(farDry, -356, 70, -0.2, 0);
    power(box(70, 44, 46, 0, 22, 0), 0x565b5e); power(box(40, 60, 30, 46, 30, 4), 0x4e5356); power(box(74, 6, 50, 0, 47, 0), 0x3c4144);
    for (const [x, z, tall] of [[-52, 26, 150], [-26, 34, 150], [84, -10, 118]]) {
      power(cyl(5.4, tall, x, tall / 2, z, "y", 10, 3.0), 0x8d8f8c);
      for (let band = 0; band < 3; band += 1) power(cyl(3.4 - band * 0.12, tall * 0.04, x, tall * (0.975 - band * 0.085), z, "y", 10, 3.3 - band * 0.12), 0xa8201a);
      power.lamp(x, tall + 1, z, RED, 1.9, 0.6, 2.4); power.lamp(x + 4.6, tall * 0.6, z, RED, 1.2, 0.5); power.lamp(x - 4.6, tall * 0.6, z, RED, 1.2, 0.5);
    }
    panes(power, rng(7), "x+", 66.4, -8, 18, 6, 14, 3.6, 0.3); panes(power, rng(8), "z+", 23.4, -34, 34, 8, 9, 3.8, 0.22);
    // The road bridge up river: two towers and their fans of stays, the deck strung with lamps.
    const bridge = yonder(farDry, -270, -340, 0.52, 0);
    for (const x of [-95, 95]) {
      for (const side of [-1, 1]) { bridge(beam([x, 0, side * 16], [x, 70, side * 9], 5), 0x9a9c98); bridge(beam([x, 70, side * 9], [x, 150, side * 1.6], 4), 0x9a9c98); }
      bridge(box(4, 5, 20, x, 68, 0), 0x9a9c98); bridge(box(3.4, 4, 5, x, 148, 0), 0x9a9c98);
      for (let stay = 1; stay <= 9; stay += 1) for (const way of [-1, 1]) for (const side of [-1, 1]) bridge(beam([x, 146 - stay * 5.5, side * 2], [x + way * stay * 10, 57, side * 11], 0.7), 0xc8cac6);
      bridge.lamp(x, 152.6, 0, RED, 1.9, 0.6, 2); bridge.lamp(x, 110, 6.4, RED, 1.2, 0.5); bridge.lamp(x, 110, -6.4, RED, 1.2, 0.5);
    }
    bridge(box(400, 3.4, 24, 0, 55, 0), 0x6a6e70);
    for (let x = -198; x <= 198; x += 22) { if (Math.abs(Math.abs(x) - 95) > 12) bridge(box(3, 54, 16, x, 27, 0), 0x7c7f7c); bridge.lamp(x + 11, 61.5, 11.6, SODIUM, 0.8, 0.45); }
  }
  // Lights of the port and the town beyond it on this bank, low on every horizon the water does not own.
  {
    const next = rng(8080);
    for (let i = 0; i < 260; i += 1) {
      const bearing = (130 + next() * 290) * Math.PI / 180, away = 250 + next() * 220, pick = next(), lift = 3 + Math.pow(next(), 2.4) * 46, level = 0.4 + next() * 0.7;
      // Only where there is land to stand a lamp on.
      if (Math.sin(bearing) * away < 16) stars.push({ at: [Math.sin(bearing) * away, lift, -9 - Math.cos(bearing) * away], colour: pick < 0.62 ? SODIUM : pick < 0.9 ? COLD : pick < 0.96 ? RED : 0x78ffc8, gain: level, size: 0.4, flash: 0 });
    }
  }

  // ---- Horizon, far side and their light, drawn ------------------------------------------------------
  // A band of sphere well beyond everything: only the direction it is seen in matters to the shader.
  const hazeRing = far(new THREE.Mesh(
    new THREE.SphereGeometry(540, 96, 12, 0, Math.PI * 2, THREE.MathUtils.degToRad(50), THREE.MathUtils.degToRad(50)),
    new THREE.ShaderMaterial({ ...HAZE_SHADER, uniforms: { time: clock }, transparent: true, depthWrite: false, side: THREE.BackSide }),
  ), [0, 1.6, -9]);
  hazeRing.renderOrder = -10;
  const farPaint = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const drawFar = (parts: Far[]) => {
    // Farthest first, so that painting them into the water in order hides what should be hidden.
    parts.sort((a, b) => b.away - a.away);
    const geometry = mergeGeometries(parts.map((part) => part.geometry));
    parts.forEach((part) => part.geometry.dispose());
    const mesh = far(new THREE.Mesh(geometry, farPaint));
    kit.mirrorHidden.push(mesh);
    return mesh;
  };
  const farSide = drawFar(farWet);
  drawFar(farDry);
  // Ships' names, lettered over their plating.
  const lettered = far(new THREE.Mesh(mergeGeometries(farNames.map((part) => part.geometry)), new THREE.MeshBasicMaterial({ map: nameSheet, vertexColors: true, transparent: true, depthWrite: false, fog: false })));
  farNames.forEach((part) => part.geometry.dispose());
  kit.mirrorHidden.push(lettered);
  kit.probeHidden.push(lettered);
  const sized = (object: THREE.Object3D, material: THREE.ShaderMaterial) => {
    // These size themselves in pixels, and the frame they are drawn into is not always the screen.
    const frame = new THREE.Vector2();
    object.onBeforeRender = (renderer) => {
      const target = renderer.getRenderTarget();
      material.uniforms.viewHeight.value = target ? target.height : renderer.getDrawingBufferSize(frame).y;
      material.uniformsNeedUpdate = true;
    };
    object.frustumCulled = false;
    object.matrixAutoUpdate = false;
    scene.add(object);
    kit.mirrorHidden.push(object);
    kit.probeHidden.push(object);
  };
  if (high) {
    const mirrored = new THREE.Mesh(farSide.geometry, new THREE.ShaderMaterial({ ...MIRROR_SHADER, uniforms: { time: clock }, vertexColors: true, transparent: true, depthWrite: false, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    mirrored.renderOrder = -8;
    mirrored.frustumCulled = false;
    mirrored.matrixAutoUpdate = false;
    scene.add(mirrored);
    kit.mirrorHidden.push(mirrored);
    kit.probeHidden.push(mirrored);
  }
  {
    const count = paths.length, positions = new Float32Array(count * 12), colours = new Float32Array(count * 12), corners = new Float32Array(count * 12), index: number[] = [];
    paths.forEach((path, i) => {
      tone.set(path.colour).multiplyScalar(path.gain);
      [[-1, 0], [1, 0], [1, 1], [-1, 1]].forEach(([u, v], corner) => {
        positions.set(path.at, (i * 4 + corner) * 3);
        colours.set([tone.r, tone.g, tone.b], (i * 4 + corner) * 3);
        corners.set([u, v, path.flash], (i * 4 + corner) * 3);
      });
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute("corner", new THREE.BufferAttribute(corners, 3));
    geometry.setIndex(index);
    const lit = geometry.attributes.position as THREE.BufferAttribute;
    kit.updates.push(() => {
      for (const lamp of afloat) {
        if (lamp.path < 0) continue;
        lampAt.copy(lamp.at).applyMatrix4(lamp.aboard.matrixWorld);
        for (let corner = 0; corner < 4; corner += 1) lit.setXYZ(lamp.path * 4 + corner, lampAt.x, lampAt.y, lampAt.z);
      }
      lit.needsUpdate = true;
    });
    const material = new THREE.ShaderMaterial({ ...GLITTER_SHADER, uniforms: { time: clock, viewHeight: { value: 1080 } }, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const glitter = new THREE.Mesh(geometry, material);
    glitter.renderOrder = -7;
    sized(glitter, material);
  }
  {
    const count = stars.length, positions = new Float32Array(count * 3), colours = new Float32Array(count * 3), aux = new Float32Array(count * 3);
    const next = rng(31);
    stars.forEach((star, i) => {
      tone.set(star.colour).multiplyScalar(star.gain);
      positions.set(star.at, i * 3);
      colours.set([tone.r, tone.g, tone.b], i * 3);
      aux.set([star.size, star.flash, next()], i * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute("aux", new THREE.BufferAttribute(aux, 3));
    const lit = geometry.attributes.position as THREE.BufferAttribute;
    kit.updates.push(() => {
      lit.clearUpdateRanges();
      for (const lamp of afloat) {
        if (lamp.star < 0) continue;
        lampAt.copy(lamp.at).applyMatrix4(lamp.aboard.matrixWorld);
        lit.setXYZ(lamp.star, lampAt.x, lampAt.y, lampAt.z);
        lit.addUpdateRange(lamp.star * 3, 3);
      }
      lit.needsUpdate = true;
    });
    const material = new THREE.ShaderMaterial({ ...LAMP_SHADER, uniforms: { time: clock, viewHeight: { value: 1080 } }, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const lamps = new THREE.Points(geometry, material);
    lamps.renderOrder = -6;
    sized(lamps, material);
  }

  // ---- Weeds, wildlife and whatever the breeze moves ---------------------------------------------------
  {
    // Dry grass and weeds wherever the sweeper cannot reach: the feet of the stacks and barriers, the flangeways of
    // the crane rails, round bollards and lamp standards, the joints across the lane.
    const grow = rng(5150);
    const beds = { tuft: [] as TreeItem[], clump: [] as TreeItem[], strip: [] as TreeItem[], head: [] as TreeItem[], rosette: [] as TreeItem[], verge: [] as TreeItem[] };
    type Bed = keyof typeof beds;
    const VARIANT: Record<Bed, number> = { tuft: 0, clump: 1, strip: 2, head: 0, rosette: 1, verge: 2 };
    const sow = (bed: Bed, x: number, z: number, yaw = grow() * 6.283, scale = 0.7 + grow() * 0.6) => {
      const grass = bed === "tuft" || bed === "clump" || bed === "strip";
      beds[bed].push({ at: [x, 0, z], yaw, scale, variant: VARIANT[bed], dry: grass ? 0.55 + grow() * 0.45 : 0.15 + grow() * 0.5 });
    };
    /** A ragged line of growth: about `thick` plants a metre, drawn from `mix` by weight. */
    const line = (x0: number, z0: number, x1: number, z1: number, thick: number, mix: Array<[Bed, number]>, wander = 0.04) => {
      const length = Math.hypot(x1 - x0, z1 - z0), along = Math.atan2(-(z1 - z0), x1 - x0), total = mix.reduce((sum, [, weight]) => sum + weight, 0);
      for (let d = grow() / thick; d < length; d += (0.35 + grow() * 1.3) / thick) {
        let pick = grow() * total, bed = mix[0][0];
        for (const [name, weight] of mix) { if (pick < weight) { bed = name; break; } pick -= weight; }
        const t = d / length, lengthwise = bed === "strip" || bed === "verge";
        sow(bed, x0 + (x1 - x0) * t + (grow() - 0.5) * 2 * wander, z0 + (z1 - z0) * t + (grow() - 0.5) * 2 * wander, lengthwise ? along + (grow() < 0.5 ? Math.PI : 0) : undefined);
      }
    };
    const ring = (x: number, z: number, radius: number, count: number) => {
      for (let i = 0; i < count; i += 1) { const turn = grow() * 6.283; sow(grow() < 0.6 ? "tuft" : grow() < 0.5 ? "head" : "clump", x + Math.cos(turn) * radius, z + Math.sin(turn) * radius); }
    };
    const FOOT: Array<[Bed, number]> = [["tuft", 5], ["clump", 2], ["head", 2.5], ["rosette", 1], ["strip", 1.5]];
    const JOINT: Array<[Bed, number]> = [["rosette", 3], ["tuft", 2], ["head", 1.5], ["verge", 1.5]];
    for (const side of [-1, 1]) {
      line(side * 9.44, 0.1, side * 9.44, -28.2, 0.8, FOOT);
      line(side * 9.52, 0.5, side * 9.52, 9.5, 0.9, FOOT);
      line(side * 10.2, 0.5, side * 10.2, 9.5, 0.6, FOOT, 0.08);
      line(side * 9.6, 0.42, side * 11.9, 0.42, 0.9, FOOT);
      ring(side * 9.84, 3.5, 0.5, 5);
    }
    line(-9.2, -28.34, 9.2, -28.34, 0.7, FOOT);
    line(-13, 9.57, 7.6, 9.57, 1.0, [["verge", 2], ["strip", 2], ["tuft", 3], ["head", 2], ["clump", 1.5]]);
    line(9.2, 9.57, 13, 9.57, 1.0, FOOT);
    // The quay: grass stands in the flangeways until a crane next travels, and along the coping where nothing drives.
    for (const x of [13.5, 13.7, 23.3, 23.5]) line(x, 9.6, x, x < 20 ? -7 : -3.5, 0.4, [["strip", 3], ["tuft", 2], ["clump", 1]], 0.015);
    line(24.62, 9.5, 24.62, -3.4, 0.6, [["tuft", 3], ["head", 2], ["verge", 1.5]]);
    for (const x of [12.2, 13.17]) line(x, 0.6, x, 8.5, 0.6, JOINT);
    for (const z of [18.5, 7, -4.5]) ring(QUAY_EDGE - 1.15, z, 0.46, 4);
    ring(24.5, 2.7, 0.26, 4);
    // The left apron: the gatehouse, the box nobody has collected, the flag pole.
    line(-19.02, -2, -19.02, 5, 0.6, FOOT);
    line(-18.1, 3.86, -12.7, 6.32, 0.7, FOOT);
    ring(-12.6, 1.1, 0.3, 4);
    // Joints across the lane, where the slabs meet and the seal has gone.
    for (const z of [-2.55, -13.3, -22.9]) line(-8.4, z, 8.4, z + 0.08, 0.3, JOINT, 0.1);
    trees.place("grass", [...beds.tuft, ...beds.clump, ...beds.strip], { shadow: false });
    trees.place("weeds", [...beds.head, ...beds.rosette, ...beds.verge], { shadow: false });
  }
  // Gulls: a row of them along the tops of the stacks and the eaves of the shed, more on the bollards and whatever
  // stands on the quay, and a few that never come down. A shot puts the lot in the air.
  const boxTop = 2 * TIER - 0.01, highTop = 3 * TIER - 0.01;
  life.birds("gull", {
    perches: [
      { from: [9.82, boxTop, -12.6], to: [9.82, boxTop, -23.6] }, { from: [-9.82, boxTop, -1.2], to: [-9.82, boxTop, -11.2] },
      { from: [-9.82, highTop, -12.8], to: [-9.82, highTop, -17.4] }, { from: [-7.4, highTop, -28.62], to: [7.4, highTop, -28.62] },
      { from: [-7, shedTop + 0.2, 9.5], to: [7, shedTop + 0.2, 9.5] }, { from: [9.82, highTop, -6.4], to: [9.82, highTop, -11.3] },
    ],
    count: 10,
    roam: { x: [-7.5, 7.5], y: [10.5, 15.5], z: [-24, 5] },
  });
  life.birds("gull", {
    perches: [[QUAY_EDGE - 1.15, 0.8, 7], [QUAY_EDGE - 1.15, 0.8, 18.5], [QUAY_EDGE - 1.15, 0.8, -4.5], [24.25, 1.9, 5.5]],
    count: 3,
    roam: { x: [14.5, 23], y: [11, 15], z: [-3, 9] },
  });
  life.birds("gull", {
    perches: [
      { from: [22.9, 9.66, 2.7], to: [24.3, 9.66, 2.7], thin: true }, { from: [17.5, 4.12, 1.2], to: [17.5, 4.12, -5.6] },
      { from: [25.05, DECK_Y + 0.92, -10.7], to: [25.05, DECK_Y + 0.92, -9.3], thin: true },
    ],
    count: 4,
    roam: { x: [14.5, 23], y: [11, 15], z: [-3, 9] },
  });
  life.soaring("gull", { centre: [1, 0, -8], radius: 17, height: 22, count: 4 });
  // Litter and grit travel down the lane with every gust; moths have found the low lamps.
  const laneAir = { x: [-8.9, 8.9] as [number, number], y: [0, 2.4] as [number, number], z: [-27.6, 8.6] as [number, number] };
  life.drift("paper", { volume: laneAir, count: 9, colors: [0xa8a294, 0x9a8f78, 0x8a8f96, 0xa89a6a] });
  life.drift("dust", { volume: laneAir, count: 16, colors: [0x7d776f] });
  life.insects([[8.4, 2.42, 9.5], [-9.6, 6.3, 9.0], [9.6, 6.3, 9.0], [9.28, 2 * TIER - 0.5, -21.4], [-9.28, 2 * TIER - 0.5, -25.6], [-11.44, 8.3, 3.5], [11.44, 8.3, 3.5]], { kind: "moths", count: 6, radius: 0.5 });
  // The ship's generators are running: a thread of exhaust from the tallest uptake, laid over by the breeze.
  life.plume("smoke", [shipX + 0.2, funnelAt[1] + 9.2, funnelAt[2] - 0.5], { rise: 11, size: [0.8, 5.5], color: 0x4d4844, opacity: 0.5, density: 24, lean: 9 });

  // Flags: the port's on a pole at the corner of the left stack, the ship's house flag on her staff aft.
  const flag = (w: number, h: number, x: number, y: number, z: number, glow: number, draw: (context: CanvasRenderingContext2D) => void) => {
    const map = track(canvasTexture(256, 160, draw));
    map.anisotropy = anisotropy;
    // Thin bunting lets the afterglow through from behind.
    const material = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color(0xff9a6a).multiplyScalar(glow), side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    const geometry = new THREE.PlaneGeometry(w, h, Math.round(w * 13), Math.round(h * 10));
    geometry.translate(w / 2, 0, 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = BREEZE + Math.PI / 2;
    mesh.userData.walkThrough = true;
    scene.add(mesh);
    life.cloth(material, { amplitude: 0.16, pin: "left" }).snap([x, y, z]);
  };
  const poleX = -12.6, poleZ = 1.1, poleTop = 9.8;
  put(B.paint, cyl(0.07, poleTop, poleX, poleTop / 2, poleZ, "y", 10, 0.045), 0xb9bdbd);
  put(B.concrete, box(0.5, 0.24, 0.5, poleX, 0.12, poleZ));
  put(B.smooth, new THREE.SphereGeometry(0.085, 10, 8).translate(poleX, poleTop + 0.06, poleZ), 0xb58c22);
  put(B.rope, rod([poleX + 0.075, poleTop - 0.1, poleZ + 0.03], [poleX + 0.1, 1.3, poleZ + 0.03], 0.006, 4));
  put(B.iron, box(0.05, 0.16, 0.04, poleX + 0.09, 1.3, poleZ + 0.03));
  flag(2.4, 1.5, poleX - 0.03, poleTop - 0.95, poleZ - 0.07, 0.3, (context) => {
    // Port Mirage: a navy field, a pale band along the foot, a box in the hoist.
    context.fillStyle = "#14263c"; context.fillRect(0, 0, 256, 160);
    context.fillStyle = "#a9a698"; context.fillRect(0, 112, 256, 20);
    context.fillStyle = "#b8551c"; context.fillRect(22, 26, 62, 62);
    context.strokeStyle = "#14263c"; context.lineWidth = 5;
    for (const x of [37.5, 53, 68.5]) { context.beginPath(); context.moveTo(x, 30); context.lineTo(x, 84); context.stroke(); }
  });
  // Her staff stands on the port quarter, clear of the casing, so the flag has the whole mooring deck to stream over.
  const staffX = shipX - 4.8, staffZ = -4.5, staffTop = DECK_Y + 7.2;
  put(B.paintFar, cyl(0.065, 7.2, staffX, DECK_Y + 3.6, staffZ, "y", 8, 0.04), 0xc5c5bb);
  put(B.paintFar, new THREE.SphereGeometry(0.09, 8, 6).translate(staffX, staffTop + 0.06, staffZ), 0xb58c22);
  flag(3.4, 2.1, staffX - 0.03, staffTop - 1.2, staffZ - 0.07, 0.14, (context) => {
    // The line's house flag: a door that will not open, on orange.
    context.fillStyle = "#a94a18"; context.fillRect(0, 0, 256, 160);
    context.fillStyle = "#a9a698"; context.beginPath(); context.moveTo(128, 14); context.lineTo(214, 80); context.lineTo(128, 146); context.lineTo(42, 80); context.closePath(); context.fill();
    context.fillStyle = "#14263c"; context.fillRect(108, 46, 40, 68);
    context.fillStyle = "#a9a698"; context.beginPath(); context.arc(139, 82, 4, 0, Math.PI * 2); context.fill();
  });
  // The halyard slaps the pole whenever a gust comes through.
  {
    const at = new THREE.Vector3(poleX, 5, poleZ);
    let next = 0;
    kit.updates.push((now) => {
      if (now < next) return;
      const gust = wind.at(poleX, poleZ);
      next = now + (gust > 0.5 ? 700 + chance() * 2400 : 250);
      if (gust > 0.5) cue?.("ropeClank", at, { gain: 0.35 + gust * 0.4, pitch: 0.9 + chance() * 0.35 });
    });
  }
  // A tarpaulin thrown over the top of the right stack, its skirt loose down the face; another hung in the mouth of the
  // box that stands open on the left apron.
  {
    const tarpMap = track(canvasTexture(256, 256, (context) => {
      const stain = rng(77);
      context.fillStyle = "#d2d2d2"; context.fillRect(0, 0, 256, 256);
      // Folded in sixteen when it was new: creases that never came out, light on one side and dark on the other.
      for (let i = 1; i < 4; i += 1) {
        context.fillStyle = "rgba(255,255,255,0.45)"; context.fillRect(i * 64 - 1, 0, 2, 256); context.fillRect(0, i * 64 - 1, 256, 2);
        context.fillStyle = "rgba(0,0,0,0.32)"; context.fillRect(i * 64 + 1, 0, 2, 256); context.fillRect(0, i * 64 + 1, 256, 2);
      }
      // Rain and rust have run down it.
      for (let i = 0; i < 30; i += 1) { context.fillStyle = `rgba(20,16,12,${0.05 + stain() * 0.13})`; context.fillRect(stain() * 256, stain() * 120, 2 + stain() * 9, 60 + stain() * 190); }
      // A doubled hem with brass eyelets, bites out of the foot where the wind has had it, and one corner gone.
      context.fillStyle = "rgba(0,0,0,0.25)"; context.fillRect(0, 234, 256, 22); context.fillRect(0, 0, 9, 256); context.fillRect(247, 0, 9, 256);
      for (let x = 16; x < 256; x += 32) {
        context.fillStyle = "#c9b06a"; context.beginPath(); context.arc(x, 243, 4.5, 0, Math.PI * 2); context.fill();
        context.fillStyle = "#1a1a1a"; context.beginPath(); context.arc(x, 243, 2, 0, Math.PI * 2); context.fill();
      }
      context.globalCompositeOperation = "destination-out";
      for (let x = 32; x < 256; x += 32) { context.beginPath(); context.ellipse(x, 262, 11, 9 + stain() * 9, 0, 0, Math.PI * 2); context.fill(); }
      context.beginPath(); context.moveTo(256, 172); context.lineTo(256, 256); context.lineTo(206, 256); context.closePath(); context.fill();
    }));
    tarpMap.anisotropy = anisotropy;
    const sheet = (w: number, h: number, colour: number, x: number, y: number, z: number, turn: number, lean: number, amplitude: number) => {
      const material = new THREE.MeshStandardMaterial({ map: tarpMap, color: colour, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.62, metalness: 0 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, Math.round(w * 11), Math.round(h * 11)), material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = turn;
      mesh.receiveShadow = true;
      mesh.userData.walkThrough = true;
      scene.add(mesh);
      life.cloth(material, { amplitude, pin: "top", lean, flutter: 1.3 }).snap([x, y, z]);
    };
    // The skirt hangs a hand's breadth off the face, over the edge of the dunnage it covers, so it has room to belly.
    const TARP = 0x3f6688;
    sheet(2.3, 1.75, TARP, 9.42, boxTop - 0.86, -1.3, -Math.PI / 2, 0.8, 0.1);
    put(B.smooth, quad(1.9, 2.3, 10.4, boxTop + 0.1, -1.3, "y+"), TARP);
    put(B.smooth, box(0.06, 0.12, 2.3, 9.45, boxTop + 0.045, -1.3), TARP);
    put(B.timber, box(1.7, 0.09, 2.1, 10.4, boxTop + 0.05, -1.3));
    for (const z of [-2.3, -0.3]) put(B.rope, rod([9.5, boxTop + 0.11, z], [11.6, boxTop + 0.02, z + (z < -1 ? -0.25 : 0.25)], 0.008, 4));
    sheet(1.12, 2.0, 0x6b7048, -13.185 + 0.408 * 0.6, 1.3, 7.515 - 0.913 * 0.6, 1.151, 0.5, 0.05);
  }
  // Lashing straps left hanging where the last load came off: one down the left stack, one off the box on the trailer.
  {
    const webbing = new THREE.MeshStandardMaterial({ color: 0xc9a216, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    const strap = (x: number, y: number, z: number, length: number) => {
      const group = new THREE.Group();
      const web = new THREE.Mesh(new THREE.BoxGeometry(0.01, length, 0.07).translate(0, -length / 2, 0), webbing);
      const hook = new THREE.Mesh(merge([new THREE.TorusGeometry(0.06, 0.014, 6, 12, 4.4).rotateY(Math.PI / 2).translate(0, -length - 0.13, 0), box(0.03, 0.12, 0.08, 0, -length - 0.03, 0)]), metals.darkMetal);
      group.add(web, hook);
      group.position.set(x, y, z);
      group.traverse((child) => { child.userData.walkThrough = true; });
      scene.add(group);
      kit.shootable.push(web, hook);
      life.sway(group, { amplitude: 0.2, period: 2 * Math.sqrt(length), axis: "x", creak: "ropeClank", damping: 0.05 });
    };
    strap(-9.49, boxTop - 0.04, -1.85, 2.6);
    strap(17.36, 4.06, 0.9, 1.9);
  }
  // A straddle carrier works the back road of the yard with a box slung under it, its reversing horn going whenever it is
  // near enough to be heard. It is the tall kind that lifts one box over three, so its top beams, cab and lamps cross the
  // sky above the stacks behind. It has no fixed place to throw a shadow from, so it throws none.
  {
    const ROAD = -40, NORTH = -78, SOUTH = 58, PACE = 4.2, YELLOW = 0xd29a1a, DARK = 0x1c1e20, GLASS = 0x0a1116, TOP = 13.3, SLUNG = 8.1;
    const parts: Array<[THREE.BufferGeometry, number]> = [
      [box(2.5, 0.3, 12.3, 0, SLUNG, 0), DARK], [box(1.7, 1.9, 2.1, 1.75, TOP - 1.3, 5.9), HOUSE_WHITE],
      [box(1.5, 0.9, 0.05, 1.75, TOP - 1.0, 6.96), GLASS], [box(1.5, 0.9, 0.05, 1.75, TOP - 1.0, 4.84), GLASS], [box(0.05, 0.9, 1.8, 0.89, TOP - 1.0, 5.9), GLASS],
    ];
    for (const sx of [-1, 1]) {
      parts.push([box(0.55, 0.62, 11.8, sx * 2.25, 1.3, 0), YELLOW], [box(0.5, 0.7, 10.6, sx * 2.25, TOP, 0), YELLOW]);
      for (const sz of [-4.7, 4.7]) parts.push([box(0.42, TOP - 1.7, 0.5, sx * 2.25, (TOP + 1.5) / 2, sz), YELLOW], [cyl(0.03, TOP - SLUNG - 0.3, sx * 0.95, (TOP + SLUNG) / 2 - 0.1, sz * 0.77, "y", 5), DARK]);
      for (const sz of [-4.5, -1.6, 1.6, 4.5]) parts.push([cyl(0.74, 0.46, sx * 2.25, 0.74, sz, "x", 14), 0x0b0b0c]);
    }
    for (const sz of [-4.7, 0, 4.7]) parts.push([box(4.9, sz ? 0.6 : 0.4, 0.5, 0, TOP, sz), YELLOW]);
    const load = new THREE.InstancedMesh(containerGeometry(LONG, 1), boxPaint, 1);
    load.setMatrixAt(0, new THREE.Matrix4());
    load.setColorAt(0, swatch.setHex(LINES[7].paint));
    load.rotation.y = ALONG_Z;
    load.position.y = SLUNG - 0.15 - CH;
    // Work lamps under the top beams, a lamp at each corner, and two amber ones that never stop turning.
    const lamps: THREE.BufferGeometry[] = [], steady: Array<{ position: V3; colour: number; gain: number }> = [], turning: V3[] = [[1.75, TOP - 0.22, 5.9], [-2.25, TOP + 0.48, -4.7]];
    for (const sx of [-1.9, 1.9]) for (const sz of [-3.2, 3.2]) { put(lamps, box(0.5, 0.1, 0.36, sx, TOP - 0.38, sz), COLD, 3.4); steady.push({ position: [sx, TOP - 0.5, sz], colour: COLD, gain: 0.9 }); }
    for (const sx of [-2.25, 2.25]) for (const sz of [-5.93, 5.93]) { put(lamps, box(0.3, 0.18, 0.06, sx, 2.1, sz), MASTHEAD, 3); steady.push({ position: [sx, 2.1, sz * 1.01], colour: MASTHEAD, gain: 0.5 }); }
    const beacon = emissive(STRIKE_ORANGE, 4.5);
    const pool = new THREE.Mesh(shade(quad(10, 17, 0, 0.05, 0, "y+"), 0.19, 0.21, 0.24), poolMaterial);
    pool.renderOrder = 2;
    const carrier = new THREE.Group();
    carrier.add(steel(parts, 3), load, new THREE.Mesh(merge(lamps), glowAny), new THREE.Mesh(merge(turning.map((at) => cyl(0.14, 0.24, at[0], at[1], at[2], "y", 8))), beacon), pool);
    lampHalo(carrier, steady);
    const amber = lampHalo(carrier, turning.map((position) => ({ position, colour: STRIKE_ORANGE, gain: 1 })));
    carrier.traverse((child) => { child.castShadow = false; });
    carrier.position.set(ROAD, 0, 34);
    scene.add(carrier);
    const heard = new THREE.Vector3();
    let z = 34, heading = -1, go = -1, last = -1, beep = 0;
    kit.updates.push((now) => {
      const t = now / 1000;
      if (last < 0) { last = t; go = t + 3; }
      const dt = Math.min(0.05, Math.max(0, t - last)), flash = Math.sin(t * 10.5) > 0.3 ? 1 : 0.06;
      last = t;
      beacon.color.set(STRIKE_ORANGE).multiplyScalar(4.5 * flash);
      amber.color.setScalar(flash);
      if (t < go) return;
      // It gathers way and loses it over the last few metres at either end, and waits there out of sight.
      const ahead = heading < 0 ? z - NORTH : SOUTH - z, astern = heading < 0 ? SOUTH - z : z - NORTH;
      z += heading * PACE * Math.min(1, 0.12 + Math.min(ahead, astern) / 8) * dt;
      carrier.position.z = z;
      if (ahead < 0.05) { heading = -heading; go = t + 12 + chance() * 26; }
      if (z > -38 && z < 34 && t >= beep) { beep = t + 3.3 + chance() * 0.6; cue?.("forkliftBeep", heard.set(ROAD, 3, z), { gain: 0.9, pitch: 0.96 + chance() * 0.08 }); }
    });
  }

  // ---- Boxes and their lettering, drawn -------------------------------------
  const paintColour = new THREE.Color();
  /** How closely a box is looked at: 2 beside the range, 1 across the apron, 0 out in the yard and on the ship. */
  const levelOf = (item: Stowed): 0 | 1 | 2 => {
    if (item.near) return 2;
    const away = Math.hypot(Math.max(0, Math.abs(item.x) - 9.5), Math.max(0, item.z - 9, -27 - item.z), Math.max(0, item.y - 3));
    return away < 18 ? 1 : 0;
  };
  for (const level of [2, 1, 0] as const) for (const length of [SHORT, LONG]) {
    const group = stowed.filter((item) => levelOf(item) === level && item.length === length && !item.open);
    if (!group.length) continue;
    const near = level === 2;
    const mesh = instances(containerGeometry(length, level), near ? boxPaintNear : boxPaint, group.map((item) => ({ position: [item.x, item.y, item.z] as V3, rotation: [0, item.yaw, 0] as V3 })), near, near);
    group.forEach((item, index) => {
      // No two boxes of a line have weathered alike.
      const fade = 0.82 + random() * 0.3;
      mesh.setColorAt(index, paintColour.setHex(item.paint ?? LINES[item.line].paint).multiplyScalar(fade));
    });
    mesh.instanceColor!.needsUpdate = true;
  }
  for (const item of stowed.filter((entry) => entry.open)) {
    // The box standing open is a mesh of its own, its paint baked into the vertex colours.
    const geometry = containerGeometry(item.length, 2, true), colour = geometry.attributes.color;
    paintColour.setHex(LINES[item.line].paint);
    for (let i = 0; i < colour.count; i += 1) colour.setXYZ(i, colour.getX(i) * paintColour.r, colour.getY(i) * paintColour.g, colour.getZ(i) * paintColour.b);
    const mesh = place(new THREE.Mesh(geometry, boxPaintNear), item.x, item.y, item.z, true, true);
    mesh.rotation.y = item.yaw;
  }
  const liveryMesh = new THREE.Mesh(merge(marks), lettering);
  liveryMesh.receiveShadow = true;
  far(liveryMesh);

  // Soft halo round every lamp: the sea haze made visible.
  lampHalo(scene, halos.filter((halo) => halo.gain <= 1));
  lampHalo(scene, halos.filter((halo) => halo.gain > 1), 11);


  // ---- Everything filed above, drawn: one mesh per finish ----------------------------------------
  const build = (parts: THREE.BufferGeometry[], material: THREE.Material, options: { shadow?: boolean; hit?: boolean; uv?: number; floor?: boolean; order?: number } = {}) => {
    if (!parts.length) return null;
    const geometry = merge(parts);
    if (options.uv) projectUv(geometry, options.uv);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = !!options.shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (options.order) mesh.renderOrder = options.order;
    scene.add(mesh);
    if (options.hit) kit.shootable.push(mesh);
    if (options.floor) kit.mirrorHidden.push(mesh);
    return mesh;
  };
  const onFloor = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const plateFloor = plate.clone(); plateFloor.setValues(onFloor);
  const ironFloor = iron.clone(); ironFloor.setValues(onFloor);
  build(B.paint, paintAny, { shadow: true, hit: true, uv: 1.6 });
  build(B.paintFar, paintAny, { uv: 3 });
  build(B.smooth, smooth, { shadow: true, hit: true });
  build(B.matte, matte, { shadow: true, hit: true, uv: 2.4 });
  build(B.matteFar, matte, { uv: 3 });
  build(B.iron, iron, { shadow: true, hit: true });
  build(B.ironFar, iron);
  build(B.plate, plate, { shadow: true, hit: true, uv: 1.3 });
  build(B.floorPlate, plateFloor, { uv: 1.3, floor: true });
  build(B.floorIron, ironFloor, { floor: true });
  build(B.green, greenPaint, { shadow: true, hit: true, uv: 2.6 });
  build(B.rubber, rubber, { shadow: true });
  build(B.concreteFar, quayWall, { uv: 6 });
  build(B.timber, metals.crate, { shadow: true, uv: 1.1 });
  build(B.rope, rope);
  build(B.brushed, metals.brushed, { uv: 1 });
  build(B.glazing, glazing);
  build(B.glow, glowAny);
  build(B.glass, clearGlass, { order: 3 });
  const signMap = track(signAtlas());
  signMap.anisotropy = anisotropy;
  // Signs carry a little light of their own so they still read when the lamps fail.
  build(signParts, new THREE.MeshStandardMaterial({ map: signMap, emissiveMap: signMap, emissive: 0xffffff, emissiveIntensity: 0.32, alphaTest: 0.5, roughness: 0.6, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  build(puddles, new THREE.MeshStandardMaterial({ map: decalMap, color: 0x04060a, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.9, depthWrite: false, envMapIntensity: 2.4, ...onFloor }), { floor: true });
  build(tracks, new THREE.MeshStandardMaterial({ map: decalMap, color: 0x050505, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.5, depthWrite: false, ...onFloor }), { floor: true });
  build(B.pools, poolMaterial, { order: 2 });
  build(B.floorPools, poolMaterial, { floor: true, order: 2 });

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 4.6);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x9a86d8, 0x4a3a44, 1.0));
  const sun = kit.sunLight({ color: 0xff9060, intensity: 4.2, toSun: TO_SUN, extent: 34, distance: 64, near: 4, far: 140, radius: 2.4 });
  const lamp = (colour: number, intensity: number, reach: number, x: number, y: number, z: number) => {
    const light = new THREE.PointLight(colour, intensity, reach, 2);
    light.position.set(x, y, z);
    scene.add(light);
    return light;
  };
  // Four real lamps; every other lamp on the quay is a glowing lens, a halo and a painted pool.
  const fills = [
    lamp(COLD, 620, 40, -8.6, mastTop - 0.6, 3.2),
    lamp(COLD, 620, 40, 8.6, mastTop - 0.6, 3.2),
    lamp(SODIUM, 150, 26, -8.4, 3 * TIER - 0.6, -16.5),
    lamp(COLD, 230, 32, 0, 3 * TIER - 0.5, -27.2),
  ];

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 240, x: 18, y: [0.3, 7], z: [-28, 8], color: 0xffd9c0, opacity: 0.16 });

  const lit = sunlitFromBoxes(TO_SUN, [
    new THREE.Box3(new THREE.Vector3(-11.97, 0, -30.34), new THREE.Vector3(-9.53, 2 * TIER, 0.3)),
    new THREE.Box3(new THREE.Vector3(-11.97, 0, -18.05), new THREE.Vector3(-9.53, 3 * TIER, -11.99)),
    new THREE.Box3(new THREE.Vector3(-18.4, 0, -20.45), new THREE.Vector3(-13.4, 3.5 * TIER, -8.25)),
    new THREE.Box3(new THREE.Vector3(-9.3, 0, -30.9), new THREE.Vector3(9.3, 3 * TIER, -28.42)),
    new THREE.Box3(new THREE.Vector3(9.53, 0, -30.34), new THREE.Vector3(11.97, 2 * TIER, 0.3)),
    new THREE.Box3(new THREE.Vector3(-10.14, 0, 3.2), new THREE.Vector3(-9.54, 4.7, 3.8)),
  ]);

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: [
      { position: new THREE.Vector3(-9.3, mastTop - 0.4, 3.4), color: new THREE.Color(COLD).multiplyScalar(0.8) },
      { position: new THREE.Vector3(9.3, mastTop - 0.4, 3.4), color: new THREE.Color(COLD).multiplyScalar(0.8) },
      { position: new THREE.Vector3(-9.2, 3 * TIER - 0.5, -15), color: new THREE.Color(SODIUM).multiplyScalar(0.8) },
    ],
    look: {
      sky: "/environment/rooftop_night-2k.hdr", skyIntensity: 2.0, skyRotation: SKY_TURN, skyClamp: 1.4,
      background: 0x3a2f44, fog: fogColour.getHex(), fogDensity,
      haze: new THREE.Color(0.04, 0.026, 0.03), hazeDensity: 0.0016, hazeCeiling: 9, hazeFade: 4,
      environmentIntensity: 1.05, exposure: 0.95, far: 620,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.3, -9),
  });
  // Birds flush on a shot; a bullet that finds a gull, a strap or a tarp is theirs to answer.
  return { ...range, startle: life.startle, struck: (object, point) => life.struck(object, point) };
}

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { brushedMetal, pbrMaterial } from "../pbr";
import { canvasTexture, createKit, projectUv, worldBox, type RangeEnvironment, type RangeOptions, type Transform } from "../kit";
import type { CueName } from "../cues";
import type { Glow } from "../volumetric";
import { createLife } from "../life";
import { createProps, type PropKind } from "../props";
import { createWind } from "../wind";

// Matinee: the auditorium of an old picture palace with nobody in it, and the projector running.
//
// The stalls have been cleared and the range laid down the middle of the carpet. The house is dark: the
// key light is what comes back off the lit screen beyond the far end (the range's `sun`, which breathes
// with the picture), and everything else is fittings: amber sconces on the pilasters, brass aisle lamps
// in the skirting, green EXIT boxes, a glow in the ceiling coves. The beam crosses the whole hall overhead
// from a port in the back wall to the screen, carrying the picture in its rays.
//
// Plan, west side (the east side mirrors it except where noted). Bays are 5.9 m between pilasters:
//   A  z  3.65 ..  9.55   exit doors                      (beside the firing line)
//   B  z -2.25 ..  3.65   a side box
//   C  z -8.15 .. -2.25   the NOW SHOWING board           (east: poster cases)
//   D  z -14.05 .. -8.15  range sign                      (east: the furnace)
//   E  z -19.95 .. -14.05 range sign
//   F  z -25.85 .. -19.95 the stage box                   (east: range sign)

type V3 = [number, number, number];
type Rect = [number, number, number, number];

const WALL_X = 9.54;
const BACK_Z = 9.7;
/** The balcony front runs this far in from the centre line, half a metre proud of the walls. */
const FASCIA_X = 9.1;
const CORNER = 3.3;
const OUTER_X = 14.6;
const REAR_Z = 15;
const CEILING = 13.6;
/** Audience face of the proscenium wall. */
const PROS_Z = -30;
const STAGE_Y = 1.1;
const ARCH = { half: 8.7, spring: 9.4, rise: 3 };
const SCREEN = { z: -36, half: 7.8, y0: 5.6, y1: 11.8 };
const SCREEN_MID = (SCREEN.y0 + SCREEN.y1) / 2;
/** The projector's lens, just inside the port in the booth wall. */
const PORT = new THREE.Vector3(0, 8.6, BACK_Z - 0.1);
const BOOTH_HALF = 3.4;
/** Underside of the balcony along the sides, and across the back where it clears the chart. */
const LOW = 4.6, HIGH = 7.3;
const BAY = 5.9;
const PILASTERS = [3.65, -2.25, -8.15, -14.05, -19.95, -25.85];
const TO_SUN = new THREE.Vector3(0.16, 0.5, -0.85).normalize();
const SUN_BASE = 1.25;
/** Sconce on each pilaster, west then east: 1 lit, 0 dead. The failing one flickers. */
const SCONCE_LIT = [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1];
const FAILING_SCONCE = 1;
const FAN = { x: -6, z: -14 };
/** The exit doors beside the firing line, and the pole their curtains hang from. */
const DOOR = { z: 6.6, half: 1.0, head: 2.32 };
const POLE = 3.12;

const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Height of the balcony's underside: level along the sides, sweeping up to the back between the firing line and the back wall. */
const balconyY = (z: number) => LOW + (HIGH - LOW) * smooth(z, -0.6, 6);
const chance = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const mat4 = (x = 0, y = 0, z = 0, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale));
const MIRROR = mat4(0, 0, 0, [0, 0, 0], [-1, 1, 1]);

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Rounded box with a single bevel segment: the cheap version for small parts. */
const rbox = (w: number, h: number, d: number, radius = 0.012, metres = 1.2) => projectUv(new RoundedBoxGeometry(w, h, d, 1, radius), metres);
function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 12, open = false, radiusEnd = radius) {
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, segments, 1, open);
  if (axis === "x") geometry.rotateZ(-Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  return geometry;
}
const lathe = (profile: number[][], segments = 20) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);
/** Flat sheet facing +z whose texture repeats every `metres`. */
function sheet(w: number, h: number, metres: number) {
  const geometry = new THREE.PlaneGeometry(w, h), uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * w / metres, uv.getY(i) * h / metres);
  return geometry;
}
/** Turns a closed shape inside out, for rooms seen from within. */
function inside<T extends THREE.BufferGeometry>(geometry: T): T {
  const index = geometry.index!.array, normal = geometry.attributes.normal;
  for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
  for (let i = 0; i < normal.count; i += 1) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return geometry;
}
function remapUv<T extends THREE.BufferGeometry>(geometry: T, [u0, v0, u1, v1]: Rect): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return geometry;
}

/** Round tube swept along a polyline with parallel-transported frames. */
function tube(points: V3[], radius: number, radial = 6) {
  const path = points.map((point) => new THREE.Vector3(...point));
  const n = path.length, position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  const tangent = new THREE.Vector3(), previous = new THREE.Vector3(), axis = new THREE.Vector3(), side = new THREE.Vector3(), other = new THREE.Vector3(), v = new THREE.Vector3();
  let along = 0;
  for (let i = 0; i < n; i += 1) {
    tangent.copy(path[Math.min(i + 1, n - 1)]).sub(path[Math.max(i - 1, 0)]).normalize();
    if (i === 0) {
      side.set(0, 1, 0);
      if (Math.abs(tangent.y) > 0.9) side.set(1, 0, 0);
      side.cross(tangent).normalize();
    } else {
      axis.crossVectors(previous, tangent);
      const s = axis.length();
      if (s > 1e-5) side.applyAxisAngle(axis.divideScalar(s), Math.atan2(s, previous.dot(tangent)));
      side.addScaledVector(tangent, -side.dot(tangent)).normalize();
      along += path[i].distanceTo(path[i - 1]);
    }
    other.crossVectors(tangent, side);
    for (let j = 0; j <= radial; j += 1) {
      const angle = (j / radial) * Math.PI * 2;
      v.copy(side).multiplyScalar(Math.cos(angle)).addScaledVector(other, Math.sin(angle));
      position.push(path[i].x + v.x * radius, path[i].y + v.y * radius, path[i].z + v.z * radius);
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

/** A place on a path with the frame a moulding's section is drawn in: `a` across, `b` up out of the surface. */
type Station = { p: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 };
type LoftOptions = { tile?: number; shift?: number; v?: [number, number]; round?: boolean };

/**
 * Runs a section along a path: balcony fronts, cornices, the proscenium frame. The section is a polyline in
 * (a, b); each of its faces looks to the right of the way it is drawn (drawn upward it faces +a, drawn toward
 * +a it faces -b), so a solid is listed anticlockwise. `v` spreads a texture band across the section.
 */
function loft(stations: Station[], profile: Array<[number, number]>, options: LoftOptions = {}) {
  const tile = options.tile ?? 2.4, shift = options.shift ?? 0;
  const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
  const along = [0];
  for (let i = 1; i < stations.length; i += 1) along.push(along[i - 1] + stations[i].p.distanceTo(stations[i - 1].p));
  const run = [0];
  for (let j = 1; j < profile.length; j += 1) run.push(run[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const total = run[run.length - 1] || 1;
  const vAt = (j: number) => options.v ? options.v[0] + (options.v[1] - options.v[0]) * (run[j] / total) : run[j] / tile;
  const flat = profile.slice(1).map((q, j) => { const da = q[0] - profile[j][0], db = q[1] - profile[j][1], l = Math.hypot(da, db) || 1; return [db / l, -da / l]; });
  const soft = profile.map((_, j) => { const p = flat[Math.max(0, j - 1)], q = flat[Math.min(flat.length - 1, j)], x = p[0] + q[0], y = p[1] + q[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; });
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  for (let j = 0; j < profile.length - 1; j += 1) {
    const base = position.length / 3;
    for (let i = 0; i < stations.length; i += 1) {
      const s = stations[i];
      for (let e = 0; e < 2; e += 1) {
        const [oa, ob] = profile[j + e], [na, nb] = options.round ? soft[j + e] : flat[j];
        position.push(s.p.x + s.a.x * oa + s.b.x * ob, s.p.y + s.a.y * oa + s.b.y * ob, s.p.z + s.a.z * oa + s.b.z * ob);
        normal.push(s.a.x * na + s.b.x * nb, s.a.y * na + s.b.y * nb, s.a.z * na + s.b.z * nb);
        uv.push((along[i] + shift) / tile, vAt(j + e));
      }
    }
    // Wind the strip so its faces look along the section's own normal, whichever way the path runs.
    const at = (k: number, v: THREE.Vector3) => v.set(position[(base + k) * 3], position[(base + k) * 3 + 1], position[(base + k) * 3 + 2]);
    at(0, A); at(1, B); at(2, C);
    N.set(normal[base * 3], normal[base * 3 + 1], normal[base * 3 + 2]);
    const forward = B.sub(A).cross(C.sub(A)).dot(N) > 0;
    for (let i = 0; i < stations.length - 1; i += 1) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (forward) index.push(a, b, c, b, d, c); else index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

/** The west balcony front, from the proscenium up the side, round the corner and across the back to the booth. */
function balconyStations() {
  const up = new THREE.Vector3(0, 1, 0), out: Station[] = [];
  const add = (x: number, z: number, ax: number, az: number) => out.push({ p: new THREE.Vector3(x, balconyY(z), z), a: new THREE.Vector3(ax, 0, az), b: up });
  for (const z of [PROS_Z, -25, -20, -15, -10, -5, -2, -1]) add(-FASCIA_X, z, 1, 0);
  for (let k = 0; k <= 12; k += 1) add(-FASCIA_X, -0.6 + k * 0.55, 1, 0);
  const cx = -FASCIA_X + CORNER, cz = 6.2;
  for (let k = 0; k <= 12; k += 1) {
    const angle = Math.PI - (k / 12) * Math.PI / 2;
    add(cx + Math.cos(angle) * CORNER, cz + Math.sin(angle) * CORNER, -Math.cos(angle), -Math.sin(angle));
  }
  add(-BOOTH_HALF, cz + CORNER, 0, -1);
  return out;
}

/** The inner edge of the proscenium opening, up one jamb, over the arch and down the other. */
function archStations(steps = 36) {
  const toward = new THREE.Vector3(0, 0, 1), out: Station[] = [];
  out.push({ p: new THREE.Vector3(-ARCH.half, STAGE_Y, PROS_Z), a: new THREE.Vector3(-1, 0, 0), b: toward });
  for (let k = 0; k <= steps; k += 1) {
    const angle = Math.PI - (k / steps) * Math.PI, x = Math.cos(angle) * ARCH.half, y = Math.sin(angle) * ARCH.rise;
    out.push({ p: new THREE.Vector3(x, ARCH.spring + y, PROS_Z), a: new THREE.Vector3(x / (ARCH.half * ARCH.half), y / (ARCH.rise * ARCH.rise), 0).normalize(), b: toward });
  }
  out.push({ p: new THREE.Vector3(ARCH.half, STAGE_Y, PROS_Z), a: new THREE.Vector3(1, 0, 0), b: toward });
  return out;
}

/** Hanging cloth facing +z, standing on y = 0: `left` and `right` give its edges at height t (0 hem .. 1 head). */
function drape(height: number, left: (t: number) => number, right: (t: number) => number, folds: number, depth: number, seed = 1, across = 30, down = 14) {
  const geometry = new THREE.PlaneGeometry(1, 1, across, down), position = geometry.attributes.position, uv = geometry.attributes.uv;
  const full = Math.abs(right(1) - left(1)) || 1;
  for (let i = 0; i < position.count; i += 1) {
    const s = uv.getX(i), t = uv.getY(i), x0 = left(t), x1 = right(t), width = x1 - x0;
    // The pleats keep their number where the cloth is gathered in, so they stand deeper there.
    const gather = Math.min(2.2, Math.sqrt(full / Math.max(Math.abs(width), 0.05)));
    const fold = Math.sin(s * folds * Math.PI * 2 + seed) + 0.35 * Math.sin(s * folds * Math.PI * 4.6 + seed * 2.3);
    position.setXYZ(i, x0 + width * s, t * height, depth * gather * fold * (0.75 + 0.25 * Math.sin(t * 5 + s * 9 + seed)));
    uv.setXY(i, s * full, t * height);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** One scallop of a valance facing +z: hangs from y = 0, deepest in the middle. */
function swag(width: number, head: number, drop: number, depth: number) {
  const geometry = new THREE.PlaneGeometry(1, 1, 16, 8), position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) {
    const s = uv.getX(i), t = 1 - uv.getY(i), u = s * 2 - 1, hang = 1 - u * u;
    position.setXYZ(i, u * width / 2, -t * (head + drop * hang), depth * Math.sin(Math.PI * t) * (0.3 + hang) + 0.035 * Math.sin(t * 5 * Math.PI) * hang);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A tip-up seat with its seat up, facing +z, as the two finishes it is made of. */
function seatParts(fine: boolean) {
  const pad = (w: number, h: number, d: number) => fine ? new RoundedBoxGeometry(w, h, d, 1, 0.022) : new THREE.BoxGeometry(w, h, d);
  const set = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, tilt = 0) => geometry.applyMatrix4(mat4(x, y, z, [tilt, 0, 0]));
  const velvet = [set(pad(0.43, 0.48, 0.07), 0, 0.75, -0.2, -0.17), set(pad(0.42, 0.4, 0.07), 0, 0.47, -0.105, 0.12)];
  const shell = [set(pad(0.5, 0.58, 0.045), 0, 0.73, -0.25, -0.17), set(box(0.46, 0.43, 0.03), 0, 0.47, -0.055, 0.12)];
  for (const side of [-1, 1]) {
    shell.push(set(box(0.035, 0.62, 0.07), side * 0.262, 0.31, -0.14, -0.08));
    shell.push(set(box(0.04, 0.045, 0.42), side * 0.262, 0.022, -0.1));
    shell.push(set(pad(0.055, 0.04, 0.34), side * 0.262, 0.63, -0.08));
  }
  const merge = (parts: THREE.BufferGeometry[]) => { const merged = mergeGeometries(parts.map((part) => part.index ? part.toNonIndexed() : part))!; parts.forEach((part) => part.dispose()); return merged; };
  return { velvet: merge(velvet), shell: merge(shell) };
}

// ---- Painted sheets ------------------------------------------------------------------------------

/** Axminster in the house colours: a gold lattice on crimson, with a medallion at every crossing. One tile is 2.4 m. */
function carpetTexture() {
  const size = 1024;
  return canvasTexture(size, size, (c) => {
    const next = rng(4117);
    c.fillStyle = "#4a0c13"; c.fillRect(0, 0, size, size);
    for (let i = 0; i < 26000; i += 1) {
      const shade = next();
      c.fillStyle = shade > 0.5 ? `rgba(120,26,34,${0.1 + next() * 0.16})` : `rgba(20,2,5,${0.1 + next() * 0.2})`;
      c.fillRect(next() * size, next() * size, 2 + next() * 3, 1.5);
    }
    const period = 256;
    c.lineCap = "round";
    for (const [colour, width] of [["#27060b", 34], ["#8a6628", 7], ["#3a0a10", 2.4]] as Array<[string, number]>) {
      c.strokeStyle = colour; c.lineWidth = width;
      for (let k = -size; k <= size * 2; k += period) {
        c.beginPath(); c.moveTo(k, 0); c.lineTo(k + size, size); c.stroke();
        c.beginPath(); c.moveTo(k, 0); c.lineTo(k - size, size); c.stroke();
      }
    }
    const medallion = (x: number, y: number) => {
      c.fillStyle = "#2a070c"; c.beginPath(); c.arc(x, y, 46, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#a07a34"; c.lineWidth = 5; c.beginPath(); c.arc(x, y, 38, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 8; i += 1) {
        c.save(); c.translate(x, y); c.rotate(i * Math.PI / 4);
        c.fillStyle = i % 2 ? "#a07a34" : "#7a1a22"; c.beginPath(); c.ellipse(0, -19, 7, 15, 0, 0, Math.PI * 2); c.fill(); c.restore();
      }
      c.fillStyle = "#b8923e"; c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill();
    };
    const sprig = (x: number, y: number) => {
      for (let i = 0; i < 4; i += 1) {
        c.save(); c.translate(x, y); c.rotate(i * Math.PI / 2 + Math.PI / 4);
        c.fillStyle = "#6e1820"; c.beginPath(); c.ellipse(0, -26, 9, 22, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = "#8a6628"; c.beginPath(); c.ellipse(0, -30, 3, 10, 0, 0, Math.PI * 2); c.fill(); c.restore();
      }
      c.fillStyle = "#8a6628"; c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill();
    };
    for (let y = 0; y <= size; y += period / 2) for (let x = 0; x <= size; x += period / 2) {
      const row = Math.round(y / (period / 2)), column = Math.round(x / (period / 2));
      if ((row + column) % 2) continue;
      if (row % 2 === 0) medallion(x, y); else sprig(x, y);
    }
    // Thirty years of feet: the pile is flattened and greyed in drifts.
    for (let i = 0; i < 60; i += 1) {
      const x = next() * size, y = next() * size, r = 60 + next() * 160, wear = c.createRadialGradient(x, y, 0, x, y, r);
      wear.addColorStop(0, `rgba(96,70,62,${0.05 + next() * 0.08})`); wear.addColorStop(1, "rgba(96,70,62,0)");
      c.fillStyle = wear; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }, true);
}

/** Flock paper for the wall fields: a tone-on-tone damask on deep red. One tile is 1.3 m. */
function wallpaperTexture() {
  const size = 512;
  return canvasTexture(size, size, (c) => {
    const next = rng(733);
    c.fillStyle = "#6b1620"; c.fillRect(0, 0, size, size);
    for (let x = 0; x < size; x += 8) { c.fillStyle = `rgba(0,0,0,${0.03 + next() * 0.05})`; c.fillRect(x, 0, 3, size); }
    const motif = (x: number, y: number) => {
      c.save(); c.translate(x, y);
      c.fillStyle = "rgba(150,48,56,.85)";
      c.beginPath(); c.moveTo(0, -112); c.bezierCurveTo(70, -60, 78, 30, 0, 112); c.bezierCurveTo(-78, 30, -70, -60, 0, -112); c.fill();
      c.fillStyle = "#6b1620";
      c.beginPath(); c.moveTo(0, -78); c.bezierCurveTo(40, -40, 46, 16, 0, 74); c.bezierCurveTo(-46, 16, -40, -40, 0, -78); c.fill();
      c.fillStyle = "rgba(150,48,56,.85)";
      for (const turn of [-0.5, 0, 0.5]) { c.save(); c.rotate(turn); c.beginPath(); c.ellipse(0, -18, 9, 34, 0, 0, Math.PI * 2); c.fill(); c.restore(); }
      c.beginPath(); c.arc(0, 30, 13, 0, Math.PI * 2); c.fill();
      for (const side of [-1, 1]) { c.beginPath(); c.ellipse(side * 92, 0, 14, 30, side * 0.5, 0, Math.PI * 2); c.fill(); }
      c.restore();
    };
    for (const [x, y] of [[128, 128], [384, 384], [384, -128], [-128, 384], [128, 640], [640, 128]]) motif(x, y);
    for (let i = 0; i < 5000; i += 1) { c.fillStyle = `rgba(${next() > 0.5 ? "0,0,0" : "150,60,60"},${0.04 + next() * 0.07})`; c.fillRect(next() * size, next() * size, 1.5, 1 + next() * 4); }
  }, true);
}

/**
 * Every piece of gilt plaster in the house on one sheet, painted twice: once in colour and once as relief
 * for the bump map. Bands run the full width (the sheet repeats along u); cells are cut out by their alpha.
 */
function ornamentAtlas() {
  const size = 2048, rects: Record<string, Rect> = {};
  const paint = (c: CanvasRenderingContext2D, relief: boolean) => {
    const GOLD = "#c29a42", GOLD_D = "#7a5c22", GOLD_L = "#e6c984", CREAM = "#c6b48b", CREAM_D = "#a8966f", RED = "#4c1115", DARK = "#190c0a";
    const tone = (colour: string, height: number) => { const g = Math.round(Math.min(1, Math.max(0, height)) * 255); return relief ? `rgb(${g},${g},${g})` : colour; };
    const bar = (x: number, y: number, w: number, h: number, colour: string, height: number) => { c.fillStyle = tone(colour, height); c.fillRect(x, y, w, h); };
    const disc = (x: number, y: number, r: number, colour: string, height: number) => { c.fillStyle = tone(colour, height); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); };
    const oval = (x: number, y: number, rx: number, ry: number, turn: number, colour: string, height: number) => { c.fillStyle = tone(colour, height); c.beginPath(); c.ellipse(x, y, rx, ry, turn, 0, Math.PI * 2); c.fill(); };
    const rosette = (x: number, y: number, r: number, petals: number) => {
      disc(x, y, r, GOLD_D, 0.62);
      for (let i = 0; i < petals; i += 1) { const a = (i / petals) * Math.PI * 2; oval(x + Math.sin(a) * r * 0.55, y - Math.cos(a) * r * 0.55, r * 0.2, r * 0.42, a, i % 2 ? GOLD : GOLD_L, 0.82); }
      disc(x, y, r * 0.26, GOLD_L, 0.96); disc(x, y, r * 0.11, GOLD_D, 0.7);
    };
    const eggs = (x: number, y: number, w: number, h: number, n: number) => {
      bar(x, y, w, h, GOLD_D, 0.58);
      for (let i = 0; i < n; i += 1) { oval(x + (i + 0.5) * w / n, y + h / 2, w / n * 0.3, h * 0.38, 0, GOLD_L, 0.9); bar(x + (i + 1) * w / n - 2, y + h * 0.2, 4, h * 0.6, GOLD, 0.75); }
    };
    const dentils = (x: number, y: number, w: number, h: number, n: number) => {
      bar(x, y, w, h, GOLD_D, 0.5);
      for (let i = 0; i < n; i += 1) bar(x + (i + 0.2) * w / n, y + h * 0.16, w / n * 0.6, h * 0.68, GOLD, 0.84);
    };
    const beads = (x: number, y: number, w: number, r: number, n: number) => { for (let i = 0; i < n; i += 1) disc(x + (i + 0.5) * w / n, y, r, i % 2 ? GOLD : GOLD_L, 0.86); };
    const garland = (x0: number, x1: number, y: number, drop: number, r: number) => {
      for (let i = 0; i <= 44; i += 1) {
        const t = i / 44, x = x0 + (x1 - x0) * t, hang = y + drop * (1 - (2 * t - 1) ** 2);
        oval(x, hang, r * (0.7 + 0.55 * Math.sin(t * Math.PI)), r * (0.55 + 0.4 * Math.sin(t * Math.PI)), t * 3, i % 2 ? GOLD : GOLD_L, 0.76 + 0.12 * (i % 2));
      }
    };
    const scroll = (x: number, y: number, r: number, turn: number) => {
      c.strokeStyle = tone(GOLD, 0.84); c.lineWidth = r * 0.22; c.lineCap = "round"; c.beginPath();
      for (let i = 0; i <= 40; i += 1) { const a = turn + (i / 40) * Math.PI * 3.4, rr = r * (1 - i / 46); c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      c.stroke();
    };
    const age = (w: number, h: number, seed: number, amount: number) => {
      if (relief) return;
      const next = rng(seed);
      for (let i = 0; i < w * h * amount * 0.002; i += 1) {
        c.fillStyle = next() > 0.6 ? `rgba(255,236,190,${0.03 + next() * 0.06})` : `rgba(30,18,10,${0.05 + next() * 0.12})`;
        c.fillRect(next() * w, next() * h, 1 + next() * 6, 1 + next() * 3);
      }
    };
    let cursor = 0, column = 0, rowHeight = 0;
    const band = (key: string, h: number, draw: (w: number, h: number) => void) => {
      c.save(); c.translate(0, cursor); c.beginPath(); c.rect(0, 0, size, h); c.clip(); draw(size, h); c.restore();
      rects[key] = [0, 1 - (cursor + h - 1.5) / size, 1, 1 - (cursor + 1.5) / size];
      cursor += h;
    };
    const cell = (key: string, w: number, h: number, draw: (w: number, h: number) => void) => {
      if (column + w > size) { column = 0; cursor += rowHeight; rowHeight = 0; }
      c.save(); c.translate(column, cursor); c.beginPath(); c.rect(0, 0, w, h); c.clip(); draw(w, h); c.restore();
      rects[key] = [(column + 2) / size, 1 - (cursor + h - 2) / size, (column + w - 2) / size, 1 - (cursor + 2) / size];
      column += w; rowHeight = Math.max(rowHeight, h);
    };
    if (!relief) c.clearRect(0, 0, size, size);

    // Balcony front, one bay (5.9 m) wide: mouldings head and foot, a rosette over every pilaster and at
    // every half bay, and between them a sunk red panel with a garland across it.
    band("fascia", 400, (w, h) => {
      bar(0, 0, w, h, CREAM, 0.5);
      eggs(0, 0, w, 44, 48); bar(0, 44, w, 10, GOLD_L, 0.72); bar(0, 54, w, 6, GOLD_D, 0.4);
      bar(0, h - 78, w, 8, GOLD_D, 0.4); bar(0, h - 70, w, 12, GOLD_L, 0.75); dentils(0, h - 58, w, 34, 64); bar(0, h - 24, w, 24, GOLD, 0.66);
      for (let k = 0; k < 2; k += 1) {
        const x0 = k * 1024;
        bar(x0 + 118, 84, 788, 216, GOLD, 0.7); bar(x0 + 128, 94, 768, 196, GOLD_D, 0.3); bar(x0 + 134, 100, 756, 184, RED, 0.24);
        garland(x0 + 190, x0 + 834, 132, 104, 15);
        for (const x of [x0 + 190, x0 + 834]) { disc(x, 128, 17, GOLD_L, 0.92); oval(x, 176, 9, 30, 0, GOLD, 0.8); }
        oval(x0 + 512, 150, 34, 14, 0, GOLD_L, 0.9); disc(x0 + 512, 150, 9, GOLD_D, 0.6);
      }
      for (const x of [0, 1024, 2048]) rosette(x, 192, 84, 10);
      age(w, h, 31, 1);
    });
    // Proscenium frame, 5.2 m of it: a rope at the outer edge, a running vine, beads at the inner edge.
    band("arch", 300, (w, h) => {
      bar(0, 0, w, h, CREAM, 0.5);
      bar(0, 0, w, 52, GOLD, 0.8);
      c.strokeStyle = tone(GOLD_D, 0.55); c.lineWidth = 9;
      for (let x = -60; x < w + 60; x += 32) { c.beginPath(); c.moveTo(x, 52); c.lineTo(x + 40, 0); c.stroke(); }
      bar(0, 52, w, 8, GOLD_D, 0.35);
      bar(0, 68, w, 164, RED, 0.3);
      c.strokeStyle = tone(GOLD, 0.8); c.lineWidth = 12; c.beginPath();
      for (let x = 0; x <= w; x += 8) c.lineTo(x, 150 + Math.sin(x / 2048 * Math.PI * 16) * 44);
      c.stroke();
      for (let k = 0; k < 16; k += 1) {
        const x = (k + 0.5) * 128, upward = k % 2 === 0;
        scroll(x, 150 + (upward ? 22 : -22), 34, upward ? 0.4 : 3.5);
        oval(x + 46, 150 + (upward ? -40 : 40), 12, 26, upward ? 0.7 : -0.7, GOLD_L, 0.86);
      }
      bar(0, 232, w, 8, GOLD_D, 0.35); bar(0, 240, w, 60, GOLD, 0.72); beads(0, 270, w, 17, 56);
      age(w, h, 37, 1);
    });
    // Cornice: eggs over modillions over a plain fascia.
    band("cornice", 200, (w, h) => {
      bar(0, 0, w, h, CREAM, 0.5);
      eggs(0, 0, w, 50, 56); bar(0, 50, w, 10, GOLD_D, 0.3);
      bar(0, 60, w, 70, CREAM_D, 0.42);
      for (let i = 0; i < 28; i += 1) { const x = (i + 0.5) * w / 28; bar(x - 20, 62, 40, 62, GOLD, 0.88); bar(x - 13, 70, 26, 46, GOLD_L, 0.96); }
      bar(0, 130, w, 10, GOLD_L, 0.7); bar(0, 140, w, 44, CREAM, 0.5); beads(0, 192, w, 8, 110);
      age(w, h, 41, 1);
    });
    // Frieze under the balcony: a key pattern in gold on red.
    band("frieze", 160, (w, h) => {
      bar(0, 0, w, h, RED, 0.4);
      bar(0, 0, w, 16, GOLD, 0.8); bar(0, h - 16, w, 16, GOLD, 0.8); bar(0, 16, w, 5, GOLD_D, 0.3); bar(0, h - 21, w, 5, GOLD_D, 0.3);
      c.strokeStyle = tone(GOLD, 0.78); c.lineWidth = 9; c.lineJoin = "miter";
      for (let x = 0; x < w; x += 128) {
        c.beginPath(); c.moveTo(x, 118); c.lineTo(x, 42); c.lineTo(x + 96, 42); c.lineTo(x + 96, 96); c.lineTo(x + 36, 96); c.lineTo(x + 36, 70); c.lineTo(x + 66, 70); c.stroke();
        c.beginPath(); c.moveTo(x, 118); c.lineTo(x + 128, 118); c.stroke();
      }
      age(w, h, 43, 1);
    });
    // Ceiling coffer: a gilt frame, a red ground and a rosette.
    cell("coffer", 512, 512, (w, h) => {
      bar(0, 0, w, h, CREAM, 0.72);
      bar(26, 26, w - 52, h - 52, GOLD, 0.6); bar(44, 44, w - 88, h - 88, GOLD_D, 0.34); bar(54, 54, w - 108, h - 108, RED, 0.22);
      c.strokeStyle = tone(GOLD_D, 0.4); c.lineWidth = 4; c.strokeRect(86, 86, w - 172, h - 172);
      rosette(w / 2, h / 2, 118, 12);
      for (const x of [112, w - 112]) for (const y of [112, h - 112]) { rosette(x, y, 30, 6); }
      for (const [x, y, turn] of [[w / 2, 104, 0], [w / 2, h - 104, 0], [104, h / 2, Math.PI / 2], [w - 104, h / 2, Math.PI / 2]]) oval(x, y, 44, 10, turn, GOLD, 0.6);
      age(w, h, 47, 0.8);
    });
    // Cartouche for the keystone and the box fronts: a shield in scrolls, with the house's initials.
    cell("cartouche", 512, 400, (w, h) => {
      for (const side of [-1, 1]) {
        scroll(w / 2 + side * 168, 150, 62, side > 0 ? 0 : Math.PI); scroll(w / 2 + side * 150, 284, 44, side > 0 ? 1.4 : 1.7);
        oval(w / 2 + side * 96, 64, 62, 20, side * -0.5, GOLD, 0.8); oval(w / 2 + side * 112, 338, 56, 18, side * 0.6, GOLD, 0.8);
      }
      oval(w / 2, 200, 150, 172, 0, GOLD, 0.84); oval(w / 2, 200, 126, 148, 0, GOLD_D, 0.5); oval(w / 2, 200, 114, 136, 0, RED, 0.4);
      if (!relief) { c.fillStyle = GOLD_L; c.font = `italic 700 150px Georgia, "Times New Roman", serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("E", w / 2 - 34, 196); c.fillText("P", w / 2 + 40, 214); }
      disc(w / 2, 26, 22, GOLD_L, 0.95); oval(w / 2, 384, 44, 14, 0, GOLD_L, 0.9);
    });
    // Organ grille for the walls beside the proscenium.
    cell("grille", 512, 700, (w, h) => {
      bar(0, 0, w, h, GOLD, 0.8); bar(26, 26, w - 52, h - 52, GOLD_D, 0.5); bar(40, 40, w - 80, h - 80, DARK, 0.12);
      c.save(); c.beginPath(); c.rect(40, 40, w - 80, h - 80); c.clip();
      c.strokeStyle = tone(GOLD, 0.7); c.lineWidth = 9;
      for (let k = -h; k < w + h; k += 62) { c.beginPath(); c.moveTo(k, 0); c.lineTo(k + h, h); c.stroke(); c.beginPath(); c.moveTo(k, 0); c.lineTo(k - h, h); c.stroke(); }
      c.restore();
      for (let y = 102; y < h - 60; y += 62) for (let x = 70; x < w - 40; x += 62) disc(x + ((Math.round(y / 62) % 2) ? 31 : 0), y, 7, GOLD_L, 0.9);
      rosette(w / 2, h / 2, 78, 10);
      age(w, h, 53, 1);
    });
    // The dome: a sunburst on a night sky.
    cell("dome", 512, 512, (w, h) => {
      disc(w / 2, h / 2, 256, CREAM, 0.5); disc(w / 2, h / 2, 236, "#142033", 0.4);
      for (let i = 0; i < 32; i += 1) {
        const a = (i / 32) * Math.PI * 2, r0 = 70, r1 = i % 2 ? 160 : 226;
        c.strokeStyle = tone(i % 2 ? GOLD_D : GOLD, 0.7); c.lineWidth = i % 2 ? 5 : 9; c.beginPath(); c.moveTo(w / 2 + Math.cos(a) * r0, h / 2 + Math.sin(a) * r0); c.lineTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1); c.stroke();
      }
      const next = rng(59);
      for (let i = 0; i < 70; i += 1) { const a = next() * Math.PI * 2, r = 96 + next() * 126; disc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 2 + next() * 3, GOLD_L, 0.8); }
      c.strokeStyle = tone(GOLD, 0.85); c.lineWidth = 12; c.beginPath(); c.arc(w / 2, h / 2, 240, 0, Math.PI * 2); c.stroke();
      rosette(w / 2, h / 2, 64, 12);
    });
    // Pilaster capital.
    cell("capital", 256, 220, (w, h) => {
      bar(6, 0, w - 12, 30, GOLD, 0.9); bar(20, 30, w - 40, 14, GOLD_D, 0.55);
      for (const side of [-1, 1]) { scroll(w / 2 + side * 78, 84, 40, side > 0 ? 0 : Math.PI); }
      for (let i = -2; i <= 2; i += 1) { oval(w / 2 + i * 38, 150, 20, 56, i * 0.16, i % 2 ? GOLD : GOLD_L, 0.82); oval(w / 2 + i * 38, 128, 9, 26, i * 0.16, GOLD_D, 0.6); }
      bar(24, 196, w - 48, 22, GOLD, 0.8); beads(24, 207, w - 48, 6, 18);
    });
    // Fluted shaft.
    cell("shaft", 128, 512, (w, h) => {
      bar(0, 0, w, h, CREAM, 0.6);
      for (let i = 0; i < 5; i += 1) {
        const x = 10 + i * 22.5;
        if (relief) { const flute = c.createLinearGradient(x, 0, x + 18, 0); flute.addColorStop(0, "rgb(140,140,140)"); flute.addColorStop(0.5, "rgb(50,50,50)"); flute.addColorStop(1, "rgb(140,140,140)"); c.fillStyle = flute; }
        else { const flute = c.createLinearGradient(x, 0, x + 18, 0); flute.addColorStop(0, CREAM); flute.addColorStop(0.35, "#8b7a58"); flute.addColorStop(0.7, CREAM_D); flute.addColorStop(1, "#d6c8a2"); c.fillStyle = flute; }
        c.fillRect(x, 14, 18, h - 28);
      }
      age(w, h, 61, 1);
    });
    // Wall panel moulding, laid over the paper round each field.
    cell("panel", 512, 512, (w, h) => {
      c.strokeStyle = tone(GOLD, 0.86); c.lineWidth = 16; c.strokeRect(14, 14, w - 28, h - 28);
      c.strokeStyle = tone(GOLD_D, 0.5); c.lineWidth = 5; c.strokeRect(27, 27, w - 54, h - 54);
      c.strokeStyle = tone(GOLD_L, 0.95); c.lineWidth = 3; c.strokeRect(8, 8, w - 16, h - 16);
      for (const x of [14, w - 14]) for (const y of [14, h - 14]) rosette(x, y, 13, 6);
    });
    // Round ventilator for the ceiling.
    cell("vent", 256, 256, (w, h) => {
      disc(w / 2, h / 2, 126, GOLD, 0.84); disc(w / 2, h / 2, 108, GOLD_D, 0.5);
      if (!relief) { c.globalCompositeOperation = "destination-out"; disc(w / 2, h / 2, 100, "#000", 0); c.globalCompositeOperation = "source-over"; }
      c.strokeStyle = tone(GOLD, 0.8); c.lineWidth = 7;
      for (let i = 0; i < 12; i += 1) { const a = (i / 12) * Math.PI * 2; c.beginPath(); c.moveTo(w / 2 + Math.cos(a) * 22, h / 2 + Math.sin(a) * 22); c.lineTo(w / 2 + Math.cos(a) * 104, h / 2 + Math.sin(a) * 104); c.stroke(); }
      for (const r of [40, 70]) { c.beginPath(); c.arc(w / 2, h / 2, r, 0, Math.PI * 2); c.stroke(); }
      rosette(w / 2, h / 2, 26, 8);
    });
  };
  const colour = canvasTexture(size, size, (c) => paint(c, false));
  const bump = canvasTexture(size / 2, size / 2, (c) => { c.fillStyle = "rgb(128,128,128)"; c.fillRect(0, 0, size / 2, size / 2); c.scale(0.5, 0.5); paint(c, true); });
  bump.colorSpace = THREE.NoColorSpace;
  colour.wrapS = bump.wrapS = THREE.RepeatWrapping;
  return { colour, bump, rects };
}

/**
 * Every printed thing in the house on one sheet: the one-sheets, the letter board, the notices and the EXIT
 * faces. Hung unlit as paper, or lit from behind in the cases and in the boxes over the doors.
 */
function signAtlas() {
  const size = 2048, rects: Record<string, Rect> = {};
  const texture = canvasTexture(size, size, (c) => {
    c.fillStyle = "#1a1412"; c.fillRect(0, 0, size, size);
    let cursor = 0, column = 0, rowHeight = 0;
    const cell = (key: string, w: number, h: number, draw: (w: number, h: number) => void) => {
      if (column + w > size) { column = 0; cursor += rowHeight; rowHeight = 0; }
      c.save(); c.translate(column, cursor); c.beginPath(); c.rect(0, 0, w, h); c.clip(); draw(w, h); c.restore();
      rects[key] = [(column + 2) / size, 1 - (cursor + h - 2) / size, (column + w - 2) / size, 1 - (cursor + 2) / size];
      column += w; rowHeight = Math.max(rowHeight, h);
    };
    const DISPLAY = `"Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`, SERIF = `Georgia, "Times New Roman", serif`;
    const text = (value: string, x: number, y: number, px: number, colour: string, font = DISPLAY, weight = "900", fit = 0, align: CanvasTextAlign = "center") => {
      let s = px;
      c.font = `${weight} ${s}px ${font}`;
      if (fit > 0) while (s > 8 && c.measureText(value).width > fit) { s -= 1; c.font = `${weight} ${s}px ${font}`; }
      c.fillStyle = colour; c.textAlign = align; c.textBaseline = "middle"; c.fillText(value, x, y);
    };
    const grain = (w: number, h: number, seed: number, amount = 1) => {
      const next = rng(seed);
      for (let i = 0; i < w * h * 0.004 * amount; i += 1) {
        c.fillStyle = next() > 0.5 ? `rgba(255,240,210,${0.02 + next() * 0.05})` : `rgba(20,10,5,${0.03 + next() * 0.08})`;
        c.fillRect(next() * w, next() * h, 1 + next() * 5, 1 + next() * 2);
      }
      // They came to the house folded in four.
      c.fillStyle = "rgba(255,245,220,.07)"; c.fillRect(0, h / 2 - 1, w, 2); c.fillRect(w / 2 - 1, 0, 2, h);
    };
    const star = (x: number, y: number, r: number) => {
      c.beginPath();
      for (let i = 0; i < 10; i += 1) { const a = -Math.PI / 2 + i * Math.PI / 5, d = i % 2 ? r * 0.42 : r; c.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d); }
      c.closePath(); c.fill();
    };

    type Motif = (w: number, h: number, ink: string, accent: string) => void;
    const poster = (key: string, seed: number, ground: [string, string], ink: string, accent: string, title: string[], tag: string, foot: string, motif: Motif) => cell(key, 384, 576, (w, h) => {
      const wash = c.createLinearGradient(0, 0, 0, h);
      wash.addColorStop(0, ground[0]); wash.addColorStop(1, ground[1]);
      c.fillStyle = wash; c.fillRect(0, 0, w, h);
      c.save(); c.beginPath(); c.rect(18, 18, w - 36, h - 36); c.clip(); motif(w, h, ink, accent); c.restore();
      c.strokeStyle = ink; c.lineWidth = 5; c.strokeRect(14, 14, w - 28, h - 28);
      const tall = title.length > 1 ? 70 : 92;
      title.forEach((value, i) => text(value, w / 2, 74 + i * tall * 0.95, tall, ink, DISPLAY, "900", w - 64));
      text(tag, w / 2, h - 88, 21, ink, SERIF, "italic 700", w - 64);
      c.fillStyle = ink; c.fillRect(48, h - 68, w - 96, 2);
      text(foot, w / 2, h - 46, 13, ink, DISPLAY, "700", w - 64);
      grain(w, h, seed);
    });
    const speed: Motif = (w, _h, ink, accent) => {
      c.fillStyle = accent; c.font = `900 320px ${DISPLAY}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("B", w / 2 + 36, 322);
      c.strokeStyle = ink; c.lineWidth = 7; c.lineCap = "round";
      for (let i = 0; i < 9; i += 1) { const y = 214 + i * 27; c.beginPath(); c.moveTo(30, y); c.lineTo(76 + ((i * 53) % 90), y); c.stroke(); }
      // Five of them, in a line, as always.
      for (let i = 0; i < 5; i += 1) {
        const x = 50 + i * 34, y = 474 - i * 3;
        c.fillStyle = ink; c.beginPath(); c.arc(x + 12, y - 36, 8, 0, Math.PI * 2); c.fill();
        c.lineWidth = 6; c.beginPath(); c.moveTo(x + 10, y - 28); c.lineTo(x + 2, y - 12); c.lineTo(x - 6, y); c.moveTo(x + 2, y - 12); c.lineTo(x + 16, y); c.moveTo(x + 9, y - 24); c.lineTo(x + 24, y - 18); c.stroke();
      }
    };
    const door: Motif = (w, _h, ink, accent) => {
      c.fillStyle = accent; c.beginPath(); c.moveTo(w / 2 - 20, 196); c.lineTo(w / 2 + 12, 196); c.lineTo(w - 34, 470); c.lineTo(w / 2 - 20, 470); c.closePath(); c.fill();
      c.fillStyle = ink; c.fillRect(w / 2 - 112, 196, 92, 274);
      c.fillStyle = accent; c.beginPath(); c.arc(w / 2 - 36, 340, 7, 0, Math.PI * 2); c.fill();
      c.strokeStyle = ink; c.lineWidth = 8; c.strokeRect(w / 2 - 120, 188, 196, 290);
      c.fillStyle = ink; c.fillRect(34, 470, w - 68, 8);
    };
    const coin: Motif = (w, _h, ink, accent) => {
      c.globalAlpha = 0.22; c.fillStyle = accent; c.beginPath(); c.moveTo(w / 2 - 14, 150); c.lineTo(w / 2 + 14, 150); c.lineTo(w / 2 + 130, 410); c.lineTo(w / 2 - 130, 410); c.closePath(); c.fill(); c.globalAlpha = 1;
      c.fillStyle = ink; c.fillRect(34, 408, w - 68, 6);
      c.fillStyle = accent; c.beginPath(); c.ellipse(w / 2, 392, 48, 17, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = ink; c.lineWidth = 4; c.beginPath(); c.ellipse(w / 2, 392, 48, 17, 0, 0, Math.PI * 2); c.stroke();
      text("$ 800", w / 2, 292, 58, ink, SERIF, "italic 700");
    };
    const sunset: Motif = (w, _h, ink, accent) => {
      c.fillStyle = accent; c.beginPath(); c.arc(w / 2, 404, 132, Math.PI, 0); c.fill();
      c.fillStyle = ink;
      for (let i = 0; i < 4; i += 1) c.fillRect(34, 318 + i * 24, w - 68, 4 + i * 2);
      c.fillRect(34, 404, w - 68, 70);
      c.fillRect(w / 2 - 7, 334, 14, 72); c.beginPath(); c.arc(w / 2, 324, 11, 0, Math.PI * 2); c.fill(); c.fillRect(w / 2 - 24, 314, 48, 5);
    };
    const gem: Motif = (w, _h, ink, accent) => {
      const x = w / 2, y = 312;
      c.fillStyle = accent; c.beginPath(); c.moveTo(x - 92, y - 30); c.lineTo(x - 52, y - 82); c.lineTo(x + 52, y - 82); c.lineTo(x + 92, y - 30); c.lineTo(x, y + 100); c.closePath(); c.fill();
      c.strokeStyle = ink; c.lineWidth = 4; c.lineJoin = "round"; c.stroke();
      c.beginPath(); c.moveTo(x - 92, y - 30); c.lineTo(x + 92, y - 30); c.moveTo(x - 52, y - 82); c.lineTo(x - 30, y - 30); c.lineTo(x, y + 100); c.lineTo(x + 30, y - 30); c.lineTo(x + 52, y - 82); c.stroke();
      c.fillStyle = ink; c.fillRect(50, 456, w - 100, 4);
      for (let i = 0; i <= 10; i += 1) c.fillRect(50 + i * (w - 100) / 10 - 1, 448, 2, 20);
      const mark = 50 + 0.07 * (w - 100);
      c.fillStyle = accent; c.beginPath(); c.moveTo(mark, 444); c.lineTo(mark - 9, 426); c.lineTo(mark + 9, 426); c.closePath(); c.fill();
    };
    const stairs: Motif = (w, _h, ink, accent) => {
      c.fillStyle = ink;
      for (let i = 0; i < 6; i += 1) c.fillRect(40 + i * 50, 440 - i * 38, w - 80 - i * 50, 40);
      c.fillStyle = accent;
      for (let i = 0; i < 10; i += 1) c.fillRect(44 + (i % 2) * 22, 420 - Math.floor(i / 2) * 22, 17, 17);
      star(w - 78, 206, 50);
    };
    const coins: Motif = (w, _h, ink, accent) => {
      for (let k = 0; k < 4; k += 1) for (let i = 0; i <= k + 1; i += 1) {
        c.fillStyle = accent; c.beginPath(); c.ellipse(78 + k * 76, 456 - i * 18, 30, 10, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = ink; c.lineWidth = 3; c.stroke();
      }
      c.strokeStyle = ink; c.lineWidth = 9; c.lineCap = "round"; c.lineJoin = "round";
      c.beginPath(); c.moveTo(60, 200); c.lineTo(140, 262); c.lineTo(200, 232); c.lineTo(300, 322); c.stroke();
      c.beginPath(); c.moveTo(262, 314); c.lineTo(300, 322); c.lineTo(294, 284); c.stroke();
    };
    const crates: Motif = (w, _h, ink, accent) => {
      for (let row = 0; row < 6; row += 1) for (let i = 0; i <= row; i += 1) {
        const s = 44, x = w / 2 - (row + 1) * s / 2 + i * s, y = 198 + row * s;
        c.fillStyle = (row + i) % 3 ? accent : ink; c.fillRect(x + 2, y + 2, s - 4, s - 4);
        c.strokeStyle = ink; c.lineWidth = 3; c.strokeRect(x + 2, y + 2, s - 4, s - 4);
        c.beginPath(); c.moveTo(x + 2, y + 2); c.lineTo(x + s - 2, y + s - 2); c.stroke();
      }
    };
    poster("rushB", 11, ["#b3261e", "#7d1712"], "#f3e6c4", "#e9b23a", ["RUSH B"], "A romance in five rounds", "ECO ROUND PICTURES  ·  ALL TALKING, NO LISTENING", speed);
    poster("doorStuck", 12, ["#10363a", "#081e22"], "#efe4c6", "#e8c65a", ["THE DOOR", "IS STUCK"], "A thriller in one doorway", "“PLEASE. I BEG YOU.”  ·  CERTIFICATE: TILTED", door);
    poster("ecoRound", 13, ["#d8b24a", "#b98a2a"], "#1b1510", "#f6ecd0", ["ECO ROUND"], "They had nothing. They bought nothing.", "A PICTURE MADE FOR UNDER $2,000", coin);
    poster("forceBuy", 14, ["#e0792b", "#8c2f1b"], "#21130f", "#f5d06a", ["THE LAST", "FORCE BUY"], "One round. No savings. Some regrets.", "FILMED ENTIRELY ON LOCATION AT THE B SITE", sunset);
    poster("float", 15, ["#27334a", "#111827"], "#dfe6ee", "#7fc6d8", ["FLOAT 0.07"], "Minimal wear. Maximal regret.", "INSPECT BEFORE YOU WEEP  ·  PATTERN 661", gem);
    poster("tradeUp", 16, ["#2f6b4f", "#173a2b"], "#f4ead0", "#f0b83c", ["TRADE UP"], "Ten go in. One comes out. All singing.", "THE MUSICAL  ·  ODDS NOT SHOWN", stairs);
    poster("lossBonus", 17, ["#e7dcc0", "#cdbf9a"], "#7a1a1a", "#d9a43a", ["LOSS BONUS"], "It pays to lose. Briefly.", "A COMEDY OF ECONOMIES  ·  FIVE REELS", coins);
    poster("cases", 18, ["#3a2a52", "#1b1230"], "#f1e3c2", "#d8a23c", ["10 000", "CASES"], "Keys sold separately.", "AN EPIC IN STORAGE  ·  CAST OF THOUSANDS, UNOPENED", crates);

    // The letter board: white letters pressed into grooved black felt.
    cell("board", 896, 576, (w, h) => {
      c.fillStyle = "#0b0b0c"; c.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 12) { c.fillStyle = "rgba(255,255,255,.04)"; c.fillRect(0, y, w, 1); c.fillStyle = "rgba(0,0,0,.5)"; c.fillRect(0, y + 1, w, 2); }
      const rows: Array<[string, string]> = [["RUSH B", "2.15  6.30  9.00"], ["THE DOOR IS STUCK", "4.10"], ["ECO ROUND (SHORT)", "8.45"], ["THE LAST FORCE BUY", "LATE"]];
      rows.forEach(([name, times], i) => {
        text(name, 44, 62 + i * 84, 50, "#ece8dc", DISPLAY, "900", 500, "left");
        text(times, w - 44, 62 + i * 84, 42, "#ece8dc", DISPLAY, "900", 290, "right");
      });
      text("STALLS 30   CIRCLE 50   BOX: ONE KNIFE", w / 2, 410, 34, "#e3c24a", DISPLAY, "900", w - 90);
      text("NO REFUNDS AFTER PISTOL ROUND", w / 2, 472, 34, "#ece8dc", DISPLAY, "900", w - 90);
      c.save(); c.translate(w / 2, 530); c.rotate(-0.012); text("PLEASE DO NOT PEEK MID", 0, 0, 30, "#ece8dc", DISPLAY, "900", w - 90); c.restore();
    });
    const header = (key: string, value: string) => cell(key, 1024, 150, (w, h) => {
      c.fillStyle = "#3a0b10"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#d9b45a"; c.lineWidth = 6; c.strokeRect(10, 10, w - 20, h - 20); c.lineWidth = 2; c.strokeRect(22, 22, w - 44, h - 44);
      text(value, w / 2, h / 2 + 4, 90, "#f1d27a", SERIF, "700", w - 230);
      c.fillStyle = "#f1d27a"; star(66, h / 2, 24); star(w - 66, h / 2, 24);
    });
    header("nowShowing", "NOW  SHOWING");
    header("comingSoon", "COMING  SOON");
    cell("exit", 320, 128, (w, h) => {
      c.fillStyle = "#04260f"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#0b5a2c"; c.fillRect(8, 8, w - 16, h - 16);
      text("EXIT", w / 2, h / 2 + 5, 96, "#e4ffec", DISPLAY, "900", w - 50);
    });
    const notice = (key: string, seed: number, head: string, lines: string[], foot: string) => cell(key, 256, 340, (w, h) => {
      c.fillStyle = "#d9cfae"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#2a2018"; c.lineWidth = 3; c.strokeRect(10, 10, w - 20, h - 20);
      text(head, w / 2, 48, 32, "#7a1a1a", DISPLAY, "900", w - 44);
      c.fillStyle = "#2a2018"; c.fillRect(30, 76, w - 60, 2);
      lines.forEach((value, i) => text(value, w / 2, 108 + i * 31, 21, "#221a12", SERIF, "700", w - 40));
      text(foot, w / 2, h - 36, 15, "#221a12", SERIF, "italic", w - 40);
      grain(w, h, seed, 1.4);
    });
    notice("noticeRush", 21, "NOTICE", ["Patrons are requested", "not to rush B", "during the performance.", "", "It is never B."], "By order: the management");
    notice("noticeSmoke", 22, "NO SMOKES", ["are to be thrown", "in the auditorium.", "", "Flashes: likewise.", "We can all see you."], "This means you");
    notice("noticeStaff", 23, "WANTED", ["Projectionist.", "Must hold an angle", "and not peek.", "", "Eco wages. Apply within."], "No rushers");
    cell("caution", 256, 384, (w, h) => {
      c.fillStyle = "#e3b21c"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#16130d"; c.fillRect(0, 0, w, 20); c.fillRect(0, h - 20, w, 20);
      c.beginPath(); c.moveTo(w / 2, 44); c.lineTo(w / 2 + 72, 168); c.lineTo(w / 2 - 72, 168); c.closePath(); c.fill();
      c.fillStyle = "#e3b21c"; c.beginPath(); c.moveTo(w / 2, 82); c.bezierCurveTo(w / 2 + 34, 128, w / 2 + 20, 156, w / 2, 156); c.bezierCurveTo(w / 2 - 20, 156, w / 2 - 34, 128, w / 2, 82); c.fill();
      text("CAUTION", w / 2, 212, 44, "#16130d", DISPLAY, "900", w - 30);
      text("WET FLOOR", w / 2, 258, 34, "#16130d", DISPLAY, "900", w - 30);
      text("ROOF: WELL-WORN", w / 2, 304, 20, "#16130d", DISPLAY, "900", w - 30);
      text("(listed as factory new)", w / 2, 334, 16, "#16130d", SERIF, "italic 700", w - 30);
      grain(w, h, 27, 1.2);
    });
    cell("plaque", 512, 256, (w, h) => {
      c.fillStyle = "#8a6a2c"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#e2c377"; c.lineWidth = 5; c.strokeRect(12, 12, w - 24, h - 24);
      text("THE ECO PICTURE PALACE", w / 2, 78, 36, "#f3dc9a", SERIF, "700", w - 60);
      text("EST. 1927  ·  SEATS 1,337", w / 2, 132, 26, "#f3dc9a", SERIF, "700", w - 60);
      text("“Every round a matinee.”", w / 2, 190, 24, "#f3dc9a", SERIF, "italic", w - 60);
    });
    const canLabel = (key: string, a: string, b: string) => cell(key, 128, 128, (w, h) => {
      c.fillStyle = "#8d9296"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#d8cfb0"; c.beginPath(); c.arc(w / 2, h / 2, 46, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#7a1a1a"; c.lineWidth = 3; c.beginPath(); c.arc(w / 2, h / 2, 41, 0, Math.PI * 2); c.stroke();
      text(a, w / 2, h / 2 - 9, 20, "#221a12", DISPLAY, "900", 70);
      text(b, w / 2, h / 2 + 14, 12, "#221a12", DISPLAY, "700", 64);
    });
    canLabel("canA", "RUSH B", "REEL 3 OF 5");
    canLabel("canB", "ECO RD", "REEL 1 · HEADS");
    cell("popcorn", 256, 256, (w, h) => {
      for (let i = 0; i < 8; i += 1) { c.fillStyle = i % 2 ? "#e9e1cc" : "#b3241d"; c.fillRect(i * w / 8, 0, w / 8, h); }
      c.fillStyle = "#e9e1cc"; c.beginPath(); c.ellipse(w / 2, h / 2, 100, 46, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#b3241d"; c.lineWidth = 4; c.stroke();
      text("POPCORN", w / 2, h / 2 - 7, 30, "#b3241d", DISPLAY, "900", 164);
      text("ECO SIZE", w / 2, h / 2 + 21, 15, "#221a12", DISPLAY, "900", 120);
    });
    cell("cache", 512, 170, (w, h) => {
      c.fillStyle = "#2a1512"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#d9b45a"; c.lineWidth = 4; c.strokeRect(8, 8, w - 16, h - 16);
      text("CACHE & CARRY", w / 2, 62, 50, "#f1d27a", SERIF, "700", w - 50);
      text("ices · popcorn · keys sold separately", w / 2, 122, 22, "#eadfbe", SERIF, "italic", w - 50);
    });
  });
  return { texture, rects };
}

/** A water stain: brown blots with tide marks, for the plaster under the leaks and the carpet below them. */
function stainTexture() {
  const size = 256;
  return canvasTexture(size, size, (c) => {
    c.clearRect(0, 0, size, size);
    const next = rng(907);
    for (let i = 0; i < 24; i += 1) {
      const a = next() * Math.PI * 2, d = next() * 44, r = 28 + next() * 50, x = size / 2 + Math.cos(a) * d, y = size / 2 + Math.sin(a) * d;
      const blot = c.createRadialGradient(x, y, r * 0.2, x, y, r);
      blot.addColorStop(0, "rgba(34,20,10,.16)"); blot.addColorStop(0.8, "rgba(34,20,10,.2)"); blot.addColorStop(0.9, "rgba(24,13,6,.42)"); blot.addColorStop(1, "rgba(24,13,6,0)");
      c.fillStyle = blot; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}
/** A reel of title cards: each cell is one frame of the film, drawn at the screen's own proportions. */
function cardAtlas() {
  const size = 2048, columns = 3, cw = 682, ch = 270, pitch = 292;
  const cells: Rect[] = [], levels: number[] = [];
  const texture = canvasTexture(size, size, (c) => {
    c.fillStyle = "#000"; c.fillRect(0, 0, size, size);
    const serif = (px: number, style: string) => { c.font = `${style} ${px}px Georgia, "Times New Roman", serif`; };
    const line = (value: string, x: number, y: number, px: number, colour: string, style = "", fit = cw - 110, align: CanvasTextAlign = "center") => {
      serif(px, style);
      for (let s = px; s > 10 && c.measureText(value).width > fit; s -= 1) serif(s - 1, style);
      c.fillStyle = colour; c.textAlign = align; c.textBaseline = "middle"; c.fillText(value, x, y);
    };
    const card = (draw: (w: number, h: number) => void) => {
      const n = cells.length, x = (n % columns) * cw, y = Math.floor(n / columns) * pitch + (pitch - ch) / 2;
      c.save(); c.translate(x, y); c.beginPath(); c.rect(0, 0, cw, ch); c.clip(); draw(cw, ch); c.restore();
      cells.push([(x + 1.5) / size, 1 - (y + ch - 1.5) / size, (x + cw - 1.5) / size, 1 - (y + 1.5) / size]);
      // How much light the frame throws: the hall is lit by it.
      const data = c.getImageData(x, y, cw, ch).data;
      let sum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4 * 11) { sum += 0.2126 * (data[i] / 255) ** 2.2 + 0.7152 * (data[i + 1] / 255) ** 2.2 + 0.0722 * (data[i + 2] / 255) ** 2.2; count += 1; }
      levels.push(sum / count);
    };
    const border = (w: number, h: number, ink: string) => {
      c.strokeStyle = ink; c.lineWidth = 3; c.strokeRect(20, 16, w - 40, h - 32);
      c.lineWidth = 1.2; c.strokeRect(28, 24, w - 56, h - 48);
      for (const x of [20, w - 20]) for (const y of [16, h - 16]) {
        c.fillStyle = ink; c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill();
        c.lineWidth = 1.5; c.beginPath(); c.arc(x + (x < w / 2 ? 22 : -22), y + (y < h / 2 ? 22 : -22), 12, 0, Math.PI * 2); c.stroke();
      }
    };
    const title = (lines: Array<[string, number, string?]>, foot = "", bright = false) => card((w, h) => {
      c.fillStyle = bright ? "#cfc5a8" : "#080808"; c.fillRect(0, 0, w, h);
      const ink = bright ? "#15120e" : "#ebe5d4";
      border(w, h, ink);
      const tall = lines.reduce((sum, [, px]) => sum + px * 1.28, 0);
      let y = (h - tall) / 2 - (foot ? 8 : 0);
      for (const [value, px, style] of lines) { line(value, w / 2, y + px * 0.64, px, ink, style ?? ""); y += px * 1.28; }
      if (foot) line(foot, w / 2, h - 44, 14, ink, "italic");
    });
    const leader = (digit: string) => card((w, h) => {
      c.fillStyle = "#909090"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#1b1b1b"; c.lineWidth = 3;
      c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
      for (const r of [122, 104]) { c.beginPath(); c.arc(w / 2, h / 2, r, 0, Math.PI * 2); c.stroke(); }
      c.fillStyle = "#101010"; c.font = `700 168px Georgia, "Times New Roman", serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(digit, w / 2, h / 2 + 8);
      line("ECO ROUND PICTURES  ·  REEL 1  ·  HEAD", 16, 16, 12, "#1b1b1b", "700", 400, "left");
      line("35 MM  ·  SOUND: NONE  ·  PATTERN 661", w - 16, h - 16, 12, "#1b1b1b", "700", 400, "right");
    });
    const caption = (head: string, foot: string) => card((w, h) => {
      c.fillStyle = "#c9c0a6"; c.fillRect(0, 0, w, h);
      line(head, 60, 24, 19, "#14110d", "700", 460, "left");
      line(foot, w - 40, h - 20, 14, "#2a251d", "italic", 420, "right");
    });
    for (const digit of ["8", "7", "6", "5", "4", "3"]) leader(digit);                               // 0 - 5
    title([["OUR FEATURE", 34], ["PRESENTATION", 54, "700"]], "", true);                           // 6
    title([["ECO ROUND PICTURES", 44, "700"], ["presents", 26, "italic"]]);                        // 7
    title([["RUSH B", 104, "700"], ["a romance in five rounds", 24, "italic"]]);                   // 8
    title([["Ladies will kindly remove their hats.", 27], ["Gentlemen will kindly stop rushing B.", 27]], "THE MANAGEMENT", true); // 9
    title([["Meanwhile, on the B site . . .", 42, "italic"]]);                                     // 10
    title([["“The door is stuck!”", 54, "italic"]]);                                               // 11
    caption("THE INDEX, THAT SUMMER", "fig. 1: number go up");                                     // 12
    title([["He had saved for three rounds.", 38]]);                                               // 13
    title([["She bought a scout anyway.", 38, "italic"]]);                                         // 14
    title([["INTERMISSION", 78, "700"], ["Trade-ups in the foyer. Keys sold separately.", 21, "italic"]], "", true); // 15
    caption("HIS FLOAT VALUE, OVER TIME", "fig. 2: minimal wear, maximal regret");                 // 16
    title([["Pattern 661.", 46], ["He wept.", 46, "italic"]]);                                     // 17
    title([["THE END", 98, "700"], ["(loss bonus applies)", 23, "italic"]]);                       // 18
  });
  return { texture, cells, levels };
}

/** The programme: [mode, card, seconds, seed]. Modes: 0 leader, 1 title card, 2 chart, 3 dark, 4 clear film, 5 footage. */
const PROGRAMME: Array<[number, number, number, number]> = [
  [0, 0, 1, 0], [0, 1, 1, 0], [0, 2, 1, 0], [0, 3, 1, 0], [0, 4, 1, 0], [0, 5, 1, 0], [3, 0, 1.2, 0],
  [1, 6, 3.6, 0], [1, 7, 4, 0], [1, 8, 5.5, 0], [5, 0, 11, 1], [1, 9, 6.5, 0], [1, 10, 4.5, 0], [5, 0, 9, 2], [1, 11, 4.5, 0],
  [2, 12, 18, 1], [1, 13, 4.5, 0], [1, 14, 4.5, 0], [1, 15, 7, 0], [2, 16, 16, 2], [1, 17, 4.5, 0], [5, 0, 8, 3], [1, 18, 6.5, 0],
  [3, 0, 0.8, 0], [4, 0, 2.2, 0], [3, 0, 1.6, 0],
];
/** Light the frame throws when it is not a card: clear film, and the footage. */
const CLEAR_LEVEL = 0.7, FOOTAGE_LEVEL = 0.42;

const FILM_GLSL = /* glsl */`
  uniform sampler2D cards;
  uniform vec4 show;      // mode, progress through the shot, seed, unused
  uniform vec4 cell;      // the card on the screen: u0, v0, width, height
  uniform vec4 gate;      // weave x, weave y, lamp, seconds
  float filmHash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  float filmHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec3 filmCard(vec2 uv) { return texture2D(cards, cell.xy + clamp(uv, 0.004, 0.996) * cell.zw).rgb; }
  float filmSeries(float x, float seed) {
    float trend = seed < 1.5 ? 0.2 + 0.52 * x : 0.74 - 0.5 * x * x;
    return trend + 0.07 * sin(x * 9.0 + seed * 2.1) + 0.04 * sin(x * 23.0 + seed * 5.0) + 0.025 * sin(x * 57.0 + seed) + 0.012 * sin(x * 131.0);
  }
  /** A chart drawn in ink on the paper of its caption card, the line growing as the shot runs. */
  vec3 filmChart(vec2 uv, float progress, float seed) {
    vec2 q = (uv - vec2(0.07, 0.14)) / vec2(0.86, 0.66);
    float ink = 0.0;
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
      float gridX = 1.0 - smoothstep(0.0, 0.0022, abs(fract(q.x * 10.0 + 0.5) - 0.5) / 10.0);
      float gridY = 1.0 - smoothstep(0.0, 0.005, abs(fract(q.y * 5.0 + 0.5) - 0.5) / 5.0);
      ink = 0.24 * max(gridX, gridY);
      float head = min(1.0, progress * 1.12);
      float y = filmSeries(q.x, seed), slope = (filmSeries(q.x + 0.004, seed) - y) / 0.004 * 0.3;
      float line = 1.0 - smoothstep(0.008, 0.02, abs(q.y - y) / sqrt(1.0 + slope * slope));
      float shown = step(q.x, head);
      ink = max(ink, 0.2 * shown * step(q.y, y) * (0.35 + 0.65 * q.y / max(y, 0.05)));
      ink = max(ink, line * shown);
      vec2 tip = (q - vec2(head, filmSeries(head, seed))) * vec2(3.3, 1.0);
      ink = max(ink, (1.0 - smoothstep(0.02, 0.045, length(tip))) * (0.6 + 0.4 * sin(gate.w * 9.0)));
    }
    float axis = max((1.0 - smoothstep(0.0, 0.0025, abs(uv.x - 0.07))) * step(0.14, uv.y) * step(uv.y, 0.8), (1.0 - smoothstep(0.0, 0.006, abs(uv.y - 0.14))) * step(0.07, uv.x) * step(uv.x, 0.93));
    return filmCard(uv) * (1.0 - 0.95 * max(ink, 0.9 * axis));
  }
  /** A slow pan over the roofs of a town, in three planes under a bright sky. */
  vec3 filmFootage(vec2 uv, float progress, float seed) {
    float pan = progress * 0.5 + seed * 7.3;
    float tone = mix(0.94, 0.5, smoothstep(0.3, 1.0, uv.y));
    float cloud = sin(uv.x * 4.2 + pan * 0.9 + sin(uv.y * 8.0 + seed) * 0.9) * sin(uv.y * 13.0 + seed * 2.0 + uv.x * 1.7);
    tone = mix(tone, 0.98, 0.4 * smoothstep(0.35, 0.85, cloud) * smoothstep(0.42, 0.7, uv.y));
    vec2 sunAt = vec2(0.74 - progress * 0.06, 0.72);
    tone = mix(tone, 1.0, 1.0 - smoothstep(0.045, 0.06, length((uv - sunAt) * vec2(2.52, 1.0))));
    for (int i = 0; i < 3; i++) {
      float layer = float(i);
      float x = uv.x * (15.0 - layer * 4.5) + pan * (1.5 + layer * 2.5) + layer * 31.0;
      float id = floor(x), f = fract(x);
      float roof = (0.4 - layer * 0.13) + (0.14 + layer * 0.05) * filmHash(id + layer * 17.0 + seed * 3.0);
      roof += 0.03 * step(0.6, filmHash(id * 3.1 + layer)) * step(f, 0.45);
      float wall = step(0.05, f) * step(uv.y, roof);
      float shade = 0.66 - layer * 0.25;
      vec2 pane = vec2(f * (4.0 + layer), uv.y * (20.0 - layer * 3.0));
      float lit = step(0.45, filmHash2(floor(pane) + id * 7.0));
      float window = step(0.25, fract(pane.x)) * step(fract(pane.x), 0.75) * step(0.25, fract(pane.y)) * step(fract(pane.y), 0.7) * step(uv.y, roof - 0.02) * step(0.5, layer);
      tone = mix(tone, shade + window * mix(-0.08, 0.22, lit), wall);
    }
    return vec3(tone);
  }
  vec3 filmPicture(vec2 uv) {
    float mode = show.x;
    if (mode < 0.5) {
      // Leader: the hand sweeps the second away.
      vec2 c = (uv - 0.5) * vec2(2.52, 1.0);
      float swept = step(fract(atan(c.x, c.y) / 6.2831853 + 1.0), show.y);
      return filmCard(uv) * (1.0 - 0.42 * swept);
    }
    if (mode < 1.5) return filmCard(0.5 + (uv - 0.5) * (1.0 - 0.012 * show.y));
    if (mode < 2.5) return filmChart(uv, show.y, show.z);
    if (mode < 3.5) return vec3(0.0);
    if (mode < 4.5) return vec3(0.82 + 0.1 * filmHash(floor(gate.w * 24.0)));
    return filmFootage(uv, show.y, show.z);
  }
  /** What reaches the screen: the frame through a worn gate, a scratched print and an old lamp. */
  vec3 film(vec2 uv) {
    float frame = floor(gate.w * 24.0);
    vec3 colour = filmPicture(uv + gate.xy);
    for (int i = 0; i < 3; i++) {
      float life = floor(gate.w * (1.3 + float(i) * 0.9)) + float(i) * 17.0;
      float x = filmHash(life), on = step(0.5, filmHash(life + 3.7));
      float wander = sin(uv.y * 23.0 + life) * 0.0016;
      colour += vec3(0.42) * on * (1.0 - smoothstep(0.0, 0.0014, abs(uv.x - x - wander)));
    }
    for (int i = 0; i < 4; i++) {
      vec2 at = vec2(filmHash(frame + float(i) * 7.1), filmHash(frame * 1.3 + float(i) * 3.3));
      float on = step(0.72, filmHash(frame + float(i) * 11.0));
      float d = length((uv - at) * vec2(2.52, 1.0));
      colour *= 1.0 - on * 0.9 * (1.0 - smoothstep(0.004, 0.014, d));
    }
    colour *= 0.9 + 0.2 * filmHash2(floor(uv * vec2(900.0, 360.0)) + frame);
    vec2 v = (uv - 0.5) * vec2(1.0, 0.8);
    colour *= 1.1 - 0.8 * dot(v, v);
    return (colour * gate.z + vec3(0.008)) * vec3(1.0, 0.93, 0.8);
  }
`;
export function buildCinema(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, renderer, high, anisotropy, keep, track, photoSet, wall } = kit;
  const metals = kit.metals();
  const cueAt = new THREE.Vector3();
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => options.cue?.(name, cueAt.set(x, y, z), { gain, pitch });

  // Everything static is baked into one mesh per material (and per shadow / hit / fine class), so the
  // detail costs triangles, not draw calls. "fine" parts are skipped on PERFORMANCE. A part put through a
  // mirroring matrix has its faces turned back the right way, so the east side is the west side reflected.
  type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean };
  type Batch = { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] };
  const batches = new Map<string, Batch>();
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4, opt: Opt = {}) => {
    const fine = opt.fine ?? false;
    if (fine && !high) return;
    const full = { shadow: opt.shadow ?? false, hit: opt.hit ?? false, fine };
    const key = `${material.uuid}|${+full.shadow}${+full.hit}${+full.fine}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { material, opt: full, parts: [] });
    const part = new THREE.BufferGeometry();
    const count = geometry.attributes.position.count;
    part.setAttribute("position", geometry.attributes.position.clone());
    part.setAttribute("normal", geometry.attributes.normal.clone());
    part.setAttribute("uv", geometry.attributes.uv ? geometry.attributes.uv.clone() : new THREE.Float32BufferAttribute(count * 2, 2));
    const index = geometry.index ? Array.from(geometry.index.array) : Array.from({ length: count }, (_, i) => i);
    if (matrix.determinant() < 0) for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
    part.setIndex(index);
    part.applyMatrix4(matrix);
    batch.parts.push(part);
  };
  /** Adds parts in the local space of `matrix`. */
  const frame = (matrix: THREE.Matrix4, base: Opt = {}) =>
    (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, rotation?: V3, scale?: V3, opt?: Opt) =>
      put(geometry, material, matrix.clone().multiply(mat4(x, y, z, rotation, scale)), { ...base, ...opt });
  type Add = ReturnType<typeof frame>;
  const world = frame(new THREE.Matrix4());
  /** The west side as built, or its reflection for the east. */
  const sideFrame = (side: number, base: Opt = {}) => frame(side < 0 ? new THREE.Matrix4() : MIRROR, base);
  const flush = () => {
    for (const batch of batches.values()) {
      const merged = mergeGeometries(batch.parts);
      batch.parts.forEach((part) => part.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.castShadow = batch.opt.shadow;
      mesh.receiveShadow = true;
      scene.add(mesh);
      if (batch.opt.hit) kit.shootable.push(mesh);
    }
    batches.clear();
  };
  const sides = [-1, 1];
  const at = (x: number, y: number, z: number, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): Transform => ({ position: [x, y, z], rotation, scale });
  const CAST = { shadow: true }, SOLID = { shadow: true, hit: true }, FINE = { fine: true };

  // ---- House light -----------------------------------------------------------------------------
  // The fittings are far too many to be light objects, and the screen is a light sixteen metres wide. Their
  // light is added analytically in the shaders of the surfaces around them: the screen as three points across
  // its width, scaled by how bright the frame on it is; a sconce on every pilaster and along the back of the
  // balcony; a louvred lamp in the skirting every half bay; the EXIT boxes; and the coves under the ceiling.
  const glsl = (value: number) => value.toFixed(3);
  /** x: light coming off the screen (1 for an ordinary frame). */
  const houseLive = { value: new THREE.Vector4(1, 0, 0, 0) };
  const sconceLive = { value: new Float32Array(SCONCE_LIT) };
  const houseGlsl = /* glsl */`
    uniform vec4 houseLive;
    uniform float sconceLive[12];
    const vec3 HOUSE_AMBER = vec3(1.0, 0.55, 0.2);
    const vec3 HOUSE_WARM = vec3(1.0, 0.7, 0.36);
    const vec3 HOUSE_FILM = vec3(1.0, 0.92, 0.78);
    const vec3 HOUSE_EXIT = vec3(0.14, 1.0, 0.42);
    const vec3 HOUSE_EXITS[2] = vec3[2](vec3(${glsl(-WALL_X + 0.3)}, 2.74, ${glsl(DOOR.z)}), vec3(${glsl(WALL_X - 0.3)}, 2.74, ${glsl(DOOR.z)}));
    const vec3 HOUSE_BOXES[3] = vec3[3](vec3(${glsl(-WALL_X - 2.5)}, 3.4, 0.7), vec3(${glsl(-WALL_X - 2.5)}, 3.4, -22.9), vec3(${glsl(WALL_X + 2.5)}, 3.4, 0.7));
    float houseFace(vec3 n, vec3 to, float d2, float wrap) { return max(dot(n, to) * inversesqrt(d2 + 0.0001) + wrap, 0.0) / (1.0 + wrap); }
    vec3 houseLight(vec3 p, vec3 n) {
      vec3 sum = vec3(0.0);
      float side = p.x < 0.0 ? -1.0 : 1.0;
      for (int i = 0; i < 3; i++) {
        vec3 to = vec3(float(i - 1) * 5.2, ${glsl(SCREEN_MID)}, ${glsl(SCREEN.z + 0.3)}) - p;
        float d2 = dot(to, to);
        sum += HOUSE_FILM * (houseLive.x * 46.0 * houseFace(n, to, d2, 0.15) / (d2 + 40.0));
      }
      // Sconces on the pilasters.
      float bay = clamp(floor((${glsl(PILASTERS[0])} - p.z) / ${glsl(BAY)} + 0.5), 0.0, 5.0);
      vec3 toSconce = vec3(side * ${glsl(WALL_X - 0.34)}, 3.3, ${glsl(PILASTERS[0])} - ${glsl(BAY)} * bay) - p;
      float s2 = dot(toSconce, toSconce);
      float lit = sconceLive[int(bay) + (side < 0.0 ? 0 : 6)];
      sum += HOUSE_AMBER * (lit * 1.25 * houseFace(n, toSconce, s2, 0.35) / (s2 + 0.3)) * (1.0 - smoothstep(3.4, 8.0, sqrt(s2)));
      // Their fellows along the back of the balcony.
      float upper = clamp(floor((${glsl(PILASTERS[0] + BAY)} - p.z) / ${glsl(BAY)} + 0.5), 0.0, 6.0);
      vec3 toUpper = vec3(side * ${glsl(OUTER_X - 0.25)}, 10.1, ${glsl(PILASTERS[0] + BAY)} - ${glsl(BAY)} * upper) - p;
      float u2 = dot(toUpper, toUpper);
      sum += HOUSE_AMBER * (0.9 * houseFace(n, toUpper, u2, 0.35) / (u2 + 0.4)) * (1.0 - smoothstep(4.0, 9.0, sqrt(u2)));
      // Aisle lamps in the skirting (none behind the door curtains, nor behind the furnace).
      float lamp = clamp(floor((8.075 - p.z) / 2.95 + 0.5), 0.0, 11.0);
      vec3 toLamp = vec3(side * ${glsl(WALL_X - 0.42)}, 0.32, 8.075 - 2.95 * lamp) - p;
      float l2 = dot(toLamp, toLamp);
      float there = lamp < 1.5 || (side > 0.0 && abs(lamp - 7.0) < 0.5) ? 0.0 : 1.0;
      sum += HOUSE_WARM * (there * 0.2 * houseFace(n, toLamp, l2, 0.3) / (l2 + 0.12)) * (1.0 - smoothstep(1.2, 3.4, sqrt(l2)));
      // EXIT boxes.
      for (int i = 0; i < 2; i++) {
        vec3 toExit = HOUSE_EXITS[i] - p;
        float e2 = dot(toExit, toExit);
        sum += HOUSE_EXIT * (0.22 * houseFace(n, toExit, e2, 0.3) / (e2 + 0.2)) * (1.0 - smoothstep(1.5, 5.0, sqrt(e2)));
      }
      // The soffit lamps over the back corners throw their light down.
      vec3 toSoffit = vec3(side * 7.5, ${glsl(HIGH - 0.1)}, 8.4) - p;
      float f2 = dot(toSoffit, toSoffit), down = clamp(toSoffit.y * inversesqrt(f2 + 0.0001), 0.0, 1.0);
      sum += HOUSE_WARM * (12.0 * down * down * houseFace(n, toSoffit, f2, 0.35) / (f2 + 6.0)) * (1.0 - smoothstep(5.0, 11.0, sqrt(f2)));
      // A lamp turned low at the back of each box.
      for (int i = 0; i < 3; i++) {
        vec3 toBox = HOUSE_BOXES[i] - p;
        float b2 = dot(toBox, toBox);
        sum += HOUSE_AMBER * (0.95 * houseFace(n, toBox, b2, 0.4) / (b2 + 0.3)) * (1.0 - smoothstep(2.0, 5.0, sqrt(b2)));
      }
      // Lamps hidden in the coves wash the edges of the ceiling.
      vec2 toCove = vec2(side * ${glsl(OUTER_X - 0.5)} - p.x, ${glsl(CEILING - 1.1)} - p.y);
      float cove = length(toCove) + 0.35;
      sum += HOUSE_AMBER * (0.34 * max(dot(n.xy, toCove) / cove + 0.45, 0.0) / 1.45 / cove) * (1.0 - smoothstep(2.0, 10.0, cove));
      // Footlights in their trough along the stage front, and a border behind the head of the arch, wash the proscenium.
      vec2 toFoot = vec2(${glsl(STAGE_Y + 0.25)} - p.y, ${glsl(PROS_Z + 1.75)} - p.z);
      float foot = length(toFoot) + 0.5;
      sum += HOUSE_WARM * (1.0 * max(dot(n.yz, toFoot) / foot + 0.3, 0.0) / 1.3 / foot) * (1.0 - smoothstep(4.0, 15.0, foot));
      vec2 toBorder = vec2(${glsl(CEILING - 0.7)} - p.y, ${glsl(PROS_Z + 2.4)} - p.z);
      float border = length(toBorder) + 0.5;
      sum += HOUSE_AMBER * (0.8 * max(dot(n.yz, toBorder) / border + 0.3, 0.0) / 1.3 / border) * (1.0 - smoothstep(3.0, 12.0, border));
      return sum;
    }`;
  const practical = <T extends THREE.MeshStandardMaterial>(material: T): T => {
    const before = material.onBeforeCompile, key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before.call(material, shader, renderer);
      shader.uniforms.houseLive = houseLive;
      shader.uniforms.sconceLive = sconceLive;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vHouseWorld;")
        .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
          vec4 housePosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            housePosition = instanceMatrix * housePosition;
          #endif
          vHouseWorld = (modelMatrix * housePosition).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vHouseWorld;\n${houseGlsl}`)
        .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directDiffuse += houseLight(vHouseWorld, inverseTransformDirection(normal, viewMatrix)) * material.diffuseContribution;");
    };
    material.customProgramCacheKey = () => `${key}|cinema-house`;
    return material;
  };
  (["structural", "darkMetal", "brushed", "machine"] as const).forEach((name) => practical(metals[name]));

  // ---- Materials -------------------------------------------------------------------------------
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => practical(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.6, ...parameters }));
  const plasterSet = wall("skim");
  const plaster = standard({ ...plasterSet, color: 0xbfae8a });
  const plasterOchre = standard({ ...plasterSet, color: 0x9c7c56 });
  const paper = track(wallpaperTexture());
  paper.anisotropy = anisotropy;
  const wallpaper = standard({ map: paper, normalMap: plasterSet.normalMap, roughnessMap: plasterSet.roughnessMap });
  const timberSet = photoSet("/textures/lacquered_cherry_wood-2k", 1, 1, false);
  const timber = standard({ ...timberSet, color: new THREE.Color(2.2, 1.5, 1.2), roughness: 0.62, envMapIntensity: 0.9 });
  // The seats upstairs are only ever seen from far below: a dull finish, so the screen does not glint off four hundred of them.
  const seatWood = standard({ ...timberSet, roughnessMap: null, color: new THREE.Color(1.9, 1.3, 1.05), roughness: 0.92, envMapIntensity: 0.3 });
  const plankSet = photoSet("/textures/weathered_brown_planks-2k", 1, 1, false);
  const boards = standard({ ...plankSet, color: 0x4a3a30 });
  const pine = standard({ ...plankSet, color: new THREE.Color(2.7, 2.15, 1.5) });
  const orn = ornamentAtlas();
  track(orn.colour).anisotropy = anisotropy;
  track(orn.bump).anisotropy = anisotropy;
  const ornament = standard({ map: orn.colour, bumpMap: orn.bump, bumpScale: 2.2, roughness: 0.62, metalness: 0.12, alphaTest: 0.5, envMapIntensity: 0.8 });
  const gilt = standard({ color: 0xb48d3c, roughness: 0.42, metalness: 0.5, envMapIntensity: 1.1 });
  const brass = practical(pbrMaterial(keep(brushedMetal(anisotropy, [0.74, 0.54, 0.2], 97, 256)), { envMapIntensity: 1.2 }));
  const velvet = standard({ color: 0x6b1019, roughness: 0.94 });
  const cloth: THREE.MeshStandardMaterialParameters = { color: 0x7c141f, roughness: 0.9, side: THREE.DoubleSide };
  const drapery = standard(cloth);
  /** The same cloth where a draught gets at it: the tabs on the prompt side, and the curtains over the exits. */
  const stageCloth = standard(cloth), doorCloth = standard(cloth);
  const aisleCarpet = standard({ color: 0x3a0a10, roughness: 1 });
  const sheetCloth = standard({ color: 0x8f8776, roughness: 1 });
  const popped = standard({ color: 0xe6d8a6, roughness: 1 });
  const yellow = standard({ color: 0xb98c14, roughness: 0.55 });
  const black = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, metalness: 0, envMapIntensity: 0.1 });
  const darkGlass = new THREE.MeshStandardMaterial({ color: 0x0b0f13, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.5 });
  const crystal = standard({ color: 0xd6dadf, roughness: 0.18, metalness: 0.35, envMapIntensity: 1.7 });
  const ropeCloth = standard({ color: 0x9a1a26, roughness: 0.9 });
  const tin = metals.brushed;
  const hot = (r: number, g: number, b: number, gain: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b).multiplyScalar(gain), toneMapped: false });
  const amberGlass = hot(1, 0.52, 0.18, 2.6);
  const failGlass = hot(1, 0.52, 0.18, 2.6);
  const boxGlass = hot(1, 0.5, 0.18, 1.1);
  const deadGlass = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.3, metalness: 0, envMapIntensity: 0.9 });
  const lampGlow = hot(1, 0.7, 0.36, 2.2);
  const boothGlow = hot(1, 0.62, 0.3, 1.5);
  const lensGlow = hot(1, 0.95, 0.85, 14);
  const daylight = hot(0.55, 0.68, 0.85, 0.55);
  const signs = signAtlas();
  track(signs.texture).anisotropy = anisotropy;
  /** Paper in the half dark: it is given a little light of its own so the jokes can be read. */
  const printed = standard({ map: signs.texture, roughness: 0.8, envMapIntensity: 0.4, emissive: 0xffe2b4, emissiveMap: signs.texture, emissiveIntensity: 0.1 });
  const backlit = new THREE.MeshBasicMaterial({ map: signs.texture, color: new THREE.Color(1, 0.94, 0.82).multiplyScalar(0.9), toneMapped: false });
  const exitLit = new THREE.MeshBasicMaterial({ map: signs.texture, color: new THREE.Color(0.75, 1, 0.82).multiplyScalar(1.9), toneMapped: false });
  const stain = new THREE.MeshBasicMaterial({ map: track(stainTexture()), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  /** A flat piece of the ornament sheet facing +z. */
  const ornamentQuad = (key: string, w: number, h: number) => remapUv(new THREE.PlaneGeometry(w, h), orn.rects[key]);
  const band = (key: string): [number, number] => [orn.rects[key][1], orn.rects[key][3]];
  /** A printed sheet on a side wall (-1 west, 1 east) facing the hall. Never put through the mirror, so it reads. */
  const onWall = (side: number, key: string, w: number, h: number, y: number, z: number, material: THREE.Material, proud = 0.02) =>
    world(remapUv(new THREE.PlaneGeometry(w, h), signs.rects[key]).rotateY(-side * Math.PI / 2), material, side * (WALL_X - proud), y, z);
  const onBack = (key: string, w: number, h: number, x: number, y: number, material: THREE.Material, proud = 0.02) =>
    world(remapUv(new THREE.PlaneGeometry(w, h), signs.rects[key]).rotateY(Math.PI), material, x, y, BACK_Z - proud);
  /** A moulded frame round a sheet of that size. */
  const wallFrame = (side: number, w: number, h: number, y: number, z: number, material: THREE.Material = gilt, bar = 0.05, proud = 0.05) => {
    const add = sideFrame(side);
    for (const sy of [-1, 1]) add(rbox(proud, bar, w + bar * 2, 0.012), material, -WALL_X + proud / 2, y + sy * (h + bar) / 2, z);
    for (const sz of [-1, 1]) add(rbox(proud, h, bar, 0.012), material, -WALL_X + proud / 2, y, z + sz * (w + bar) / 2);
  };
  const backFrame = (w: number, h: number, x: number, y: number, material: THREE.Material = gilt, bar = 0.05, proud = 0.05) => {
    for (const sy of [-1, 1]) world(rbox(w + bar * 2, bar, proud, 0.012), material, x, y + sy * (h + bar) / 2, BACK_Z - proud / 2);
    for (const sx of [-1, 1]) world(rbox(bar, h, proud, 0.012), material, x + sx * (w + bar) / 2, y, BACK_Z - proud / 2);
  };
  // ---- Floor -----------------------------------------------------------------------------------
  const carpet = track(carpetTexture());
  carpet.anisotropy = anisotropy;
  carpet.repeat.set(31 / 2.4, 54 / 2.4);
  const weave = photoSet("/textures/fabric_pattern_07-2k", 31 / 0.42, 54 / 0.42, false);
  const ground = new THREE.MeshStandardMaterial({ map: carpet, normalMap: weave.normalMap, roughnessMap: weave.roughnessMap, normalScale: new THREE.Vector2(0.5, 0.5), color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.35 });
  // A carpet does not mirror the hall: the planar reflection is left off altogether.
  const reflection = kit.floor(ground, { width: 31, depth: 54, z: -11 }, {
    lane: new THREE.Color(0.4, 0.31, 0.15),
    edge: new THREE.Color(0.55, 0.4, 0.14),
    markings: 0.6,
    wet: -1,
  }, false);
  practical(ground);

  // ---- Shell: the lower walls -------------------------------------------------------------------
  // The side walls stand to the underside of the balcony, with the side boxes cut through them.
  type Hole = [number, number, number, number];
  const BOX_HOLE = { sill: 1.5, head: 3.92, half: 1.9 };
  const boxHole = (z: number): Hole => [z - BOX_HOLE.half, z + BOX_HOLE.half, BOX_HOLE.sill, BOX_HOLE.head];
  const sideWall = (holes: Hole[]) => {
    const shape = new THREE.Shape();
    shape.moveTo(PROS_Z - 1, 0); shape.lineTo(BACK_Z + 0.6, 0); shape.lineTo(BACK_Z + 0.6, HIGH);
    for (let k = 12; k >= 0; k -= 1) shape.lineTo(-0.6 + k * 0.55, balconyY(-0.6 + k * 0.55));
    shape.lineTo(PROS_Z - 1, LOW); shape.closePath();
    for (const [z0, z1, y0, y1] of holes) {
      const hole = new THREE.Path();
      hole.moveTo(z0, y0); hole.lineTo(z0, y1); hole.lineTo(z1, y1); hole.lineTo(z1, y0); hole.closePath();
      shape.holes.push(hole);
    }
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
    geometry.rotateY(-Math.PI / 2);
    geometry.translate(-WALL_X, 0, 0);
    return projectUv(geometry, 1.3);
  };
  const BOXES: Record<number, number[]> = { [-1]: [0.7, -22.9], [1]: [0.7] };
  for (const side of sides) {
    const add = sideFrame(side);
    add(sideWall(BOXES[side].map(boxHole)), wallpaper, 0, 0, 0, undefined, undefined, { hit: true });
    // The room behind each box: dark paper, a floor at the sill.
    for (const z of BOXES[side]) {
      add(inside(worldBox(2.2, BOX_HOLE.head - BOX_HOLE.sill + 0.5, BOX_HOLE.half * 2 + 0.5, 1.3)), wallpaper, -WALL_X - 0.6 - 1.1, (BOX_HOLE.head + BOX_HOLE.sill) / 2 + 0.05, z);
    }
  }
  world(worldBox(20.3, HIGH, 0.6, 1.3), wallpaper, 0, HIGH / 2, BACK_Z + 0.3, undefined, undefined, { hit: true });

  // ---- The balcony ------------------------------------------------------------------------------
  // One section run from the proscenium up each side, round the corner and across the back to the
  // projection booth: a plaster front under a brass rail, then five steps of seating up to the outer wall.
  const stations = balconyStations();
  const FASCIA: Array<[number, number]> = [[-0.02, 0], [0, 0.05], [0, 0.12], [0.05, 0.17], [0.05, 0.22], [0.01, 0.26], [0.03, 0.34], [0.09, 0.48], [0.09, 0.6], [0.03, 0.72], [0.03, 0.76], [0.08, 0.8], [0.08, 0.88], [0.04, 0.9]];
  const TREAD = 0.88, RISE = 0.5, ROWS = high ? 5 : 3, FLOOR0 = 0.38;
  const steps: Array<[number, number]> = [[0.04, 0.9], [-0.14, 0.9], [-0.14, FLOOR0]];
  for (let k = 0; k < 5; k += 1) { steps.push([-0.14 - TREAD * (k + 1), FLOOR0 + RISE * k]); steps.push([-0.14 - TREAD * (k + 1), FLOOR0 + RISE * (k + 1)]); }
  steps.push([-(OUTER_X - FASCIA_X), FLOOR0 + RISE * 5]);
  for (const side of sides) {
    const add = sideFrame(side);
    add(loft(stations, FASCIA, { tile: BAY, shift: -(PILASTERS[5] - PROS_Z), v: band("fascia") }), ornament, 0, 0, 0, undefined, undefined, SOLID);
    add(loft(stations, [[-(WALL_X - FASCIA_X) - 0.02, 0], [-0.02, 0]]), plaster, 0, 0, 0, undefined, undefined, CAST);
    add(loft(stations, steps), aisleCarpet, 0, 0, 0, undefined, undefined, CAST);
    // The corner of the soffit, between the curve of the front and the walls.
    const corner = new THREE.Shape();
    corner.moveTo(-WALL_X, 6.2); corner.absarc(-FASCIA_X + CORNER, 6.2, CORNER + 0.02, Math.PI, Math.PI / 2, true); corner.lineTo(-FASCIA_X + CORNER, BACK_Z); corner.lineTo(-WALL_X, BACK_Z); corner.closePath();
    add(projectUv(new THREE.ShapeGeometry(corner, 12).rotateX(Math.PI / 2), 2.4), plaster, 0, HIGH - 0.002, 0);
    // Brass rail on the front, on short standards.
    add(tube(stations.map((s) => [s.p.x + s.a.x * -0.05, s.p.y + 1.06, s.p.z + s.a.z * -0.05] as V3), 0.028, 6), brass);
  }

  // Seats: every row follows the front, broken by a gangway each bay.
  const seat = seatParts(false), fineSeat = high ? seatParts(true) : seat;
  const seats: Transform[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    const offset = -0.14 - TREAD * row - 0.5, lift = FLOOR0 + RISE * row;
    let carry = 0.3, base = 0;
    for (let i = 0; i < stations.length - 1; i += 1) {
      const A = stations[i], B = stations[i + 1];
      const ax0 = A.p.x + A.a.x * offset, az0 = A.p.z + A.a.z * offset, ax1 = B.p.x + B.a.x * offset, az1 = B.p.z + B.a.z * offset;
      const length = Math.hypot(ax1 - ax0, az1 - az0), baseLength = Math.hypot(B.p.x - A.p.x, B.p.z - A.p.z);
      let d = carry;
      for (; d < length; d += 0.56) {
        const t = d / length, along = base + t * baseLength;
        if ((along + 1.6) % BAY < 1.15) continue;
        const nx = lerp(A.a.x, B.a.x, t), nz = lerp(A.a.z, B.a.z, t);
        // Side rows are angled toward the screen, as the slips of a real house are.
        const yaw = Math.atan2(nx, nz) + 0.42 * Math.max(0, nx);
        const x = lerp(ax0, ax1, t), y = lerp(A.p.y, B.p.y, t) + lift, z = lerp(az0, az1, t);
        seats.push(at(x, y, z, [0, yaw, 0]), at(-x, y, z, [0, -yaw, 0]));
      }
      carry = d - length;
      base += baseLength;
    }
  }

  // ---- Upper walls and ceiling ---------------------------------------------------------------------
  // Drawn from inside only, so the roof and the outer walls are not in the way of a view from above.
  const upperBase = LOW + FLOOR0 + RISE * 5 - 0.3, upperHeight = CEILING - upperBase;
  for (const side of sides) {
    const add = sideFrame(side);
    add(sheet(REAR_Z - PROS_Z, upperHeight, 1.3).rotateY(Math.PI / 2), wallpaper, -OUTER_X, upperBase + upperHeight / 2, (REAR_Z + PROS_Z) / 2);
  }
  world(sheet(OUTER_X * 2, upperHeight, 1.3).rotateY(Math.PI), wallpaper, 0, upperBase + upperHeight / 2, REAR_Z);

  // The ceiling is a field of coffers between plaster beams, 4 m along the hall by four across the stalls.
  const linesX = [-OUTER_X, -11.3, -8, -4, 0, 4, 8, 11.3, OUTER_X];
  const linesZ = [PROS_Z, -28, -24, -20, -16, -12, -8, -4, 0, 4, 8, 12, REAR_Z];
  const DOME = { x: 0, z: -8, radius: 3.5, rise: 1.5 };
  for (let i = 0; i < linesX.length - 1; i += 1) for (let j = 0; j < linesZ.length - 1; j += 1) {
    const x0 = linesX[i], x1 = linesX[i + 1], z0 = linesZ[j], z1 = linesZ[j + 1];
    if (Math.abs((x0 + x1) / 2 - DOME.x) < 4 && Math.abs((z0 + z1) / 2 - DOME.z) < 4) continue;
    if (Math.abs((x0 + x1) / 2 - FAN.x) < 0.1 && Math.abs((z0 + z1) / 2 - FAN.z) < 0.1) continue;
    world(ornamentQuad("coffer", x1 - x0, z1 - z0).rotateX(Math.PI / 2), ornament, (x0 + x1) / 2, CEILING, (z0 + z1) / 2);
  }
  // Cross beams are deeper than the long ones, so their soffits never share a plane where they meet.
  for (const z of linesZ.slice(1, -1)) world(worldBox(OUTER_X * 2, 0.5, 0.46, 2.4), plaster, 0, CEILING - 0.25, z);
  for (const x of linesX.slice(1, -1)) world(worldBox(0.42, 0.38, REAR_Z - PROS_Z, 2.4), plaster, x, CEILING - 0.19, (REAR_Z + PROS_Z) / 2);
  {
    // The dome over the middle of the stalls: a ring, a shallow painted cap, and the plaster round them.
    const surround = new THREE.Shape();
    surround.moveTo(-4, -4); surround.lineTo(4, -4); surround.lineTo(4, 4); surround.lineTo(-4, 4); surround.closePath();
    surround.holes.push(new THREE.Path().absarc(0, 0, DOME.radius, 0, Math.PI * 2, false));
    world(projectUv(new THREE.ShapeGeometry(surround, 40).rotateX(Math.PI / 2), 2.4), plaster, DOME.x, CEILING, DOME.z);
    const sphere = (DOME.radius * DOME.radius + DOME.rise * DOME.rise) / (2 * DOME.rise);
    const cap = new THREE.SphereGeometry(sphere, 40, 8, 0, Math.PI * 2, 0, Math.asin(DOME.radius / sphere));
    const [u0, v0, u1, v1] = orn.rects.dome, capUv = cap.attributes.uv, capAt = cap.attributes.position;
    for (let i = 0; i < capUv.count; i += 1) capUv.setXY(i, lerp(u0, u1, 0.5 + capAt.getX(i) / (DOME.radius * 2.08)), lerp(v0, v1, 0.5 + capAt.getZ(i) / (DOME.radius * 2.08)));
    world(inside(cap), ornament, DOME.x, CEILING + DOME.rise - sphere, DOME.z);
    world(new THREE.TorusGeometry(DOME.radius, 0.14, 8, 56).rotateX(Math.PI / 2), gilt, DOME.x, CEILING - 0.02, DOME.z);
    world(new THREE.TorusGeometry(DOME.radius + 0.34, 0.07, 6, 56).rotateX(Math.PI / 2), gilt, DOME.x, CEILING - 0.01, DOME.z);
  }

  {
    // The ventilator: a gilt grille let into one coffer, the shaft behind it open to a grey afternoon, and
    // the fan turning in the shaft.
    const R = 1.22;
    const surround = new THREE.Shape();
    surround.moveTo(-2, -2); surround.lineTo(2, -2); surround.lineTo(2, 2); surround.lineTo(-2, 2); surround.closePath();
    surround.holes.push(new THREE.Path().absarc(0, 0, R, 0, Math.PI * 2, false));
    world(projectUv(new THREE.ShapeGeometry(surround, 32).rotateX(Math.PI / 2), 2.4), plaster, FAN.x, CEILING, FAN.z);
    world(ornamentQuad("vent", R * 2.12, R * 2.12).rotateX(Math.PI / 2), ornament, FAN.x, CEILING - 0.03, FAN.z);
    world(inside(new THREE.CylinderGeometry(R, R, 1.7, 28, 1, true)), black, FAN.x, CEILING + 0.85, FAN.z);
    world(new THREE.CircleGeometry(R, 28).rotateX(Math.PI / 2), daylight, FAN.x, CEILING + 1.7, FAN.z);
    for (const turn of [0, Math.PI / 2]) world(box(R * 2, 0.05, 0.05), black, FAN.x, CEILING + 0.5, FAN.z, [0, turn, 0]);
  }
  const rotor = new THREE.Mesh(mergeGeometries([cyl(0.17, 0.22, "y", 12), ...[0, 1, 2, 3, 4].map((i) => box(1.02, 0.02, 0.34).applyMatrix4(mat4(0.6, 0, 0, [0.5, 0, 0])).applyMatrix4(mat4(0, 0, 0, [0, i * Math.PI * 2 / 5, 0])))])!, black);
  rotor.position.set(FAN.x, CEILING + 0.8, FAN.z);
  scene.add(rotor);
  {
    // A coved cornice where the walls meet the ceiling: the house lamps are hidden behind it.
    const CORNICE: Array<[number, number]> = [[0, -1.0], [0.07, -0.94], [0.13, -0.66], [0.44, -0.22], [0.74, -0.09], [0.8, 0]];
    const up = new THREE.Vector3(0, 1, 0);
    const run = (from: V3, to: V3, a: V3): Station[] => [from, to].map((p) => ({ p: new THREE.Vector3(...p), a: new THREE.Vector3(...a), b: up }));
    for (const side of sides) sideFrame(side)(loft(run([-OUTER_X, CEILING, PROS_Z], [-OUTER_X, CEILING, REAR_Z], [1, 0, 0]), CORNICE, { tile: BAY, v: band("cornice") }), ornament);
    world(loft(run([-OUTER_X, CEILING, REAR_Z], [OUTER_X, CEILING, REAR_Z], [0, 0, -1]), CORNICE, { tile: BAY, v: band("cornice") }), ornament);
    world(loft(run([-OUTER_X, CEILING, PROS_Z], [OUTER_X, CEILING, PROS_Z], [0, 0, 1]), CORNICE, { tile: BAY, v: band("cornice") }), ornament);
  }
  // Where the roof lets the rain in: a stain on the plaster over each drip, and one on the carpet.
  for (const [x, z, s] of [[-8.8, -22, 2.7], [7.5, -26, 2.2]]) world(new THREE.PlaneGeometry(s, s).rotateX(Math.PI / 2), stain, x, CEILING - 0.015, z, [0, x * 0.7, 0]);
  world(new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2), stain, -8.8, 0.007, -22, [0, 0.6, 0]);
  // ---- The proscenium ---------------------------------------------------------------------------
  {
    const wall = new THREE.Shape();
    wall.moveTo(-OUTER_X, 0); wall.lineTo(-ARCH.half, 0); wall.lineTo(-ARCH.half, ARCH.spring);
    wall.absellipse(0, ARCH.spring, ARCH.half, ARCH.rise, Math.PI, 0, true);
    wall.lineTo(ARCH.half, 0); wall.lineTo(OUTER_X, 0); wall.lineTo(OUTER_X, CEILING); wall.lineTo(-OUTER_X, CEILING); wall.closePath();
    const geometry = new THREE.ExtrudeGeometry(wall, { depth: 1, bevelEnabled: false, curveSegments: 40 });
    world(projectUv(geometry.translate(0, 0, PROS_Z - 1), 2.4), plasterOchre, 0, 0, 0, undefined, undefined, { hit: true });
    // Its frame: a wide gilt moulding round the opening, drawn from the outer edge in to the reveal.
    const arch = archStations();
    world(loft(arch, [[0.98, 0], [0.98, 0.2], [0.92, 0.28], [0.8, 0.28], [0.75, 0.22], [0.2, 0.22], [0.14, 0.16], [0.06, 0.16], [0, 0.1]], { tile: 5.2, v: band("arch") }), ornament);
    world(loft(arch, [[0, 0.1], [0, -1]], { tile: 2.4 }), gilt);
    world(ornamentQuad("cartouche", 2.5, 1.95), ornament, 0, ARCH.spring + ARCH.rise + 0.55, PROS_Z + 0.34);
    // Organ grilles in the splays either side.
    for (const side of sides) world(ornamentQuad("grille", 3.1, 4.24), ornament, side * 11.85, 10.2, PROS_Z + 0.02);
    // The stage: boards behind a panelled apron, in a black box.
    world(worldBox(OUTER_X * 2, STAGE_Y, 8.6, 2.2), boards, 0, STAGE_Y / 2, PROS_Z + 1.5 - 4.3, undefined, undefined, { hit: true });
    world(worldBox(19.1, STAGE_Y - 0.12, 0.08, 1.2), timber, 0, (STAGE_Y - 0.12) / 2, PROS_Z + 1.54);
    world(rbox(19.3, 0.12, 0.3, 0.03), gilt, 0, STAGE_Y - 0.06, PROS_Z + 1.56);
    world(inside(box(23, CEILING - STAGE_Y, 5.8)), black, 0, (CEILING + STAGE_Y) / 2, PROS_Z - 1 - 2.9);
  }
  // House tabs drawn back to either side, pinched in by their ties, and a swagged valance across the head.
  const TIE = 0.42;
  for (const side of sides) {
    const add = sideFrame(side);
    const height = CEILING - 0.9 - STAGE_Y;
    const inner = (t: number) => -ARCH.half + 0.75 + (t < TIE ? 1.1 * (1 - smooth(t, 0, TIE)) * (1 - smooth(t, 0, TIE)) + 0.25 : 0.25 + 1.75 * smooth(t, TIE, 1) ** 1.6);
    add(drape(height, () => -ARCH.half - 0.5, inner, 9, 0.11, 3), side < 0 ? stageCloth : drapery, 0, STAGE_Y, PROS_Z - 1.45);
    add(new THREE.TorusGeometry(0.42, 0.045, 6, 20).rotateY(Math.PI / 2).scale(1, 0.5, 1), gilt, -ARCH.half + 0.72, STAGE_Y + height * TIE, PROS_Z - 1.45, [0, 0, 0.3]);
  }
  {
    const count = 5, width = (ARCH.half * 2 + 0.4) / count;
    for (let k = 0; k < count; k += 1) {
      const x = -ARCH.half - 0.2 + (k + 0.5) * width, edge = Math.abs(k - 2) / 2;
      world(swag(width + 0.2, 0.55 + 0.5 * edge, 0.8 + 0.35 * edge, 0.3), drapery, x, CEILING - 0.95, PROS_Z - 1.2);
    }
    for (let k = 0; k <= count; k += 1) {
      const x = -ARCH.half - 0.2 + k * width;
      world(drape(1.9 + 0.5 * Math.abs(k - 2.5) / 2.5, (t) => -0.42 * (0.45 + 0.55 * t), (t) => 0.42 * (0.45 + 0.55 * t), 3, 0.07, k, 10, 6), drapery, x, CEILING - 0.95 - (1.9 + 0.5 * Math.abs(k - 2.5) / 2.5), PROS_Z - 1.12);
    }
  }

  // ---- The screen and what is on it -----------------------------------------------------------------
  const cards = cardAtlas();
  track(cards.texture).anisotropy = anisotropy;
  const show = { value: new THREE.Vector4(0, 0, 0, 0) }, cell = { value: new THREE.Vector4(...cards.cells[0]) }, gate = { value: new THREE.Vector4(0, 0, 1, 0) };
  const filmUniforms = () => ({ cards: { value: cards.texture }, show, cell, gate });
  const screenMaterial = new THREE.ShaderMaterial({
    uniforms: { ...filmUniforms(), gain: { value: 2.3 } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform float gain; varying vec2 vUv; ${FILM_GLSL} void main() { gl_FragColor = vec4(film(vUv) * gain, 1.0); }`,
    toneMapped: false,
  });
  kit.place(new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.half * 2, SCREEN.y1 - SCREEN.y0), screenMaterial), 0, SCREEN_MID, SCREEN.z, false);
  world(new THREE.PlaneGeometry(SCREEN.half * 2 + 1.6, SCREEN.y1 - SCREEN.y0 + 1.2), black, 0, SCREEN_MID, SCREEN.z - 0.04);
  // The same frame at a few dozen pixels, for the beam to carry: bright parts of the picture are bright rays.
  const pictureTarget = track(new THREE.WebGLRenderTarget(256, 104, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }));
  const pictureQuad = track(new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: filmUniforms(),
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`varying vec2 vUv; ${FILM_GLSL} void main() { gl_FragColor = vec4(film(vUv), 1.0); }`,
    depthTest: false, depthWrite: false,
  })));

  // ---- The beam ---------------------------------------------------------------------------------
  // A pyramid of lit dust from the lens to the screen. Its skin is only where the shader starts: every pixel
  // marches the sight line through the pyramid and adds up the light passing each point, which is the picture
  // itself (read from the small copy above) thinning as it spreads, times the dust drifting through it.
  const REACH = PORT.z - SCREEN.z, APERTURE = { x: 0.1, y: 0.04 };
  const beamUniforms = {
    picture: { value: pictureTarget.texture },
    apex: { value: PORT.clone() },
    spread: { value: new THREE.Vector4((SCREEN.half - APERTURE.x) / REACH, ((SCREEN.y1 - SCREEN.y0) / 2 - APERTURE.y) / REACH, APERTURE.x, APERTURE.y) },
    reach: { value: REACH },
    slope: { value: (SCREEN_MID - PORT.y) / REACH },
    beamTime: { value: 0 },
    beamGain: { value: 1.5 },
    beamLamp: { value: 1 },
  };
  const beamCommon = /* glsl */`
    uniform sampler2D picture;
    uniform vec3 apex;
    uniform vec4 spread;
    uniform float reach;
    uniform float slope;
    uniform float beamTime;
    uniform float beamGain;
    uniform float beamLamp;`;
  {
    const corners: THREE.Vector3[] = [];
    for (const w of [0.02, REACH - 0.05]) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      corners.push(new THREE.Vector3(sx * (beamUniforms.spread.value.x * w + APERTURE.x), PORT.y + beamUniforms.slope.value * w + sy * (beamUniforms.spread.value.y * w + APERTURE.y), PORT.z - w));
    }
    const index: number[] = [];
    for (const [a, b, c, d] of [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [0, 3, 2, 1]]) {
      // Each face is wound to look away from the axis.
      const normal = corners[b].clone().sub(corners[a]).cross(corners[c].clone().sub(corners[a]));
      const centre = corners[a].clone().add(corners[c]).multiplyScalar(0.5).sub(new THREE.Vector3(0, PORT.y, (PORT.z + SCREEN.z) / 2));
      if (normal.dot(centre) > 0) index.push(a, b, c, a, c, d); else index.push(a, c, b, a, d, c);
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(corners);
    geometry.setIndex(index);
    const material = new THREE.ShaderMaterial({
      uniforms: beamUniforms,
      defines: { STEPS: high ? 14 : 7 },
      vertexShader: /* glsl */`varying vec3 vWorld; void main() { vec4 world = modelMatrix * vec4(position, 1.0); vWorld = world.xyz; gl_Position = projectionMatrix * viewMatrix * world; }`,
      fragmentShader: /* glsl */`
        ${beamCommon}
        varying vec3 vWorld;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float noise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }
        void beamClip(float f0, float fd, inout float t0, inout float t1) {
          if (fd > 0.0) t1 = min(t1, -f0 / fd); else if (fd < 0.0) t0 = max(t0, -f0 / fd); else if (f0 > 0.0) t1 = -1.0;
        }
        void main() {
          // Beam space: the lens at the origin, the axis along -z (the slight climb to the screen sheared out).
          vec3 ro = cameraPosition - apex, rd = normalize(vWorld - cameraPosition);
          ro.y += slope * ro.z; rd.y += slope * rd.z;
          float t0 = 0.0, t1 = 1000.0;
          beamClip(ro.x + spread.x * ro.z - spread.z, rd.x + spread.x * rd.z, t0, t1);
          beamClip(-ro.x + spread.x * ro.z - spread.z, -rd.x + spread.x * rd.z, t0, t1);
          beamClip(ro.y + spread.y * ro.z - spread.w, rd.y + spread.y * rd.z, t0, t1);
          beamClip(-ro.y + spread.y * ro.z - spread.w, -rd.y + spread.y * rd.z, t0, t1);
          beamClip(ro.z, rd.z, t0, t1);
          beamClip(-ro.z - reach, -rd.z, t0, t1);
          if (t1 <= t0) discard;
          float stride = (t1 - t0) / float(STEPS);
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec3 sum = vec3(0.0);
          vec3 drift = vec3(beamTime * 0.06, -beamTime * 0.035, beamTime * 0.025);
          for (int i = 0; i < STEPS; i++) {
            vec3 q = ro + rd * (t0 + (float(i) + jitter) * stride);
            float w = -q.z;
            vec2 uv = q.xy / (spread.xy * w + spread.zw);
            float edge = (1.0 - smoothstep(0.84, 1.0, abs(uv.x))) * (1.0 - smoothstep(0.78, 1.0, abs(uv.y)));
            // What the lamp sends through even the darkest frame keeps the cone standing between titles.
            vec3 light = textureLod(picture, uv * 0.5 + 0.5, 2.5).rgb + vec3(0.085, 0.08, 0.068) * beamLamp;
            float dust = 0.5 + noise((q + apex) * 0.75 + drift) + 0.35 * noise((q + apex) * 2.6 - drift * 2.0);
            // The same light through a growing section: thinner air-glow the further it has spread.
            sum += light * (edge * dust / (1.0 + 0.015 * w * w));
          }
          // Dust throws light on rather than back: the beam is brightest looked up toward the lens.
          float cosine = rd.z;
          float phase = 0.6 + 0.4 * (1.0 + cosine) + 1.3 * pow(max(cosine, 0.0), 4.0);
          gl_FragColor = vec4(sum * (stride * beamGain * phase), 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
    });
    const beam = new THREE.Mesh(geometry, material);
    beam.frustumCulled = false;
    beam.renderOrder = 3;
    scene.add(beam);
    kit.probeHidden.push(beam);
    kit.mirrorHidden.push(beam);

    // Motes: specks that only show while they are inside the beam, lit by the part of the picture passing them.
    const count = high ? 1400 : 500, seeds = new Float32Array(count * 3), next = rng(881);
    for (let i = 0; i < count * 3; i += 1) seeds[i] = next();
    const dust = new THREE.BufferGeometry();
    dust.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    dust.setAttribute("seed", new THREE.BufferAttribute(seeds, 3));
    const motes = new THREE.Points(dust, new THREE.ShaderMaterial({
      uniforms: { ...beamUniforms, scale: { value: 1 } },
      vertexShader: /* glsl */`
        ${beamCommon}
        uniform float scale;
        attribute vec3 seed;
        varying vec3 vLight;
        void main() {
          float w = 0.6 + seed.z * seed.z * (reach - 1.2);
          vec2 uv = vec2(fract(seed.x + 0.03 * sin(beamTime * 0.09 + seed.z * 40.0) + beamTime * 0.002 * (seed.y - 0.5)), fract(seed.y - beamTime * (0.003 + 0.004 * seed.x))) * 2.5 - 1.25;
          vec2 across = uv * (spread.xy * w + spread.zw);
          vec3 world = apex + vec3(across.x, slope * w + across.y, -w);
          float within = (1.0 - smoothstep(0.86, 1.0, abs(uv.x))) * (1.0 - smoothstep(0.8, 1.0, abs(uv.y)));
          vLight = textureLod(picture, uv * 0.5 + 0.5, 3.0).rgb * within * (0.35 + 0.65 * fract(seed.x * 37.0 + seed.y * 91.0));
          vec4 view = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = clamp(scale * (0.012 + 0.02 * seed.y) / -view.z, 1.0, 5.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vLight;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vLight * (1.0 - smoothstep(0.15, 0.5, d)) * 1.6, 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
    }));
    motes.frustumCulled = false;
    motes.renderOrder = 4;
    scene.add(motes);
    kit.probeHidden.push(motes);
    kit.mirrorHidden.push(motes);
    const drawing = new THREE.Vector2();
    kit.updates.push(() => { motes.material.uniforms.scale.value = renderer.getDrawingBufferSize(drawing).y * 0.9; });
  }

  // ---- The projection booth -----------------------------------------------------------------------
  // A plaster box in the middle of the back balcony: the working port, a second one shuttered, and two
  // little windows the projectionist watches the screen through.
  const BOOTH = { y0: HIGH + 0.88, y1: 11.3, z: BACK_Z - 0.2 };
  const PORTS: Array<{ x: number; y: number; w: number; h: number }> = [
    { x: 0, y: PORT.y, w: 0.46, h: 0.34 }, { x: -1.55, y: PORT.y, w: 0.46, h: 0.34 }, { x: 1.2, y: PORT.y + 0.03, w: 0.74, h: 0.46 }, { x: -2.6, y: PORT.y + 0.03, w: 0.36, h: 0.36 },
  ];
  {
    const face = new THREE.Shape();
    face.moveTo(-BOOTH_HALF, BOOTH.y0); face.lineTo(BOOTH_HALF, BOOTH.y0); face.lineTo(BOOTH_HALF, BOOTH.y1); face.lineTo(-BOOTH_HALF, BOOTH.y1); face.closePath();
    for (const port of PORTS) {
      const hole = new THREE.Path();
      hole.moveTo(port.x - port.w / 2, port.y - port.h / 2); hole.lineTo(port.x - port.w / 2, port.y + port.h / 2); hole.lineTo(port.x + port.w / 2, port.y + port.h / 2); hole.lineTo(port.x + port.w / 2, port.y - port.h / 2); hole.closePath();
      face.holes.push(hole);
    }
    world(projectUv(new THREE.ExtrudeGeometry(face, { depth: 0.3, bevelEnabled: false }).translate(0, 0, BOOTH.z), 2.4), plaster, 0, 0, 0, undefined, undefined, CAST);
    for (const side of sides) world(worldBox(0.2, BOOTH.y1 - BOOTH.y0, REAR_Z - BOOTH.z - 0.3, 2.4), plaster, side * (BOOTH_HALF - 0.1), (BOOTH.y0 + BOOTH.y1) / 2, (REAR_Z + BOOTH.z + 0.3) / 2);
    world(worldBox(BOOTH_HALF * 2 + 0.3, 0.22, REAR_Z - BOOTH.z + 0.15, 2.4), plaster, 0, BOOTH.y1 + 0.11, (REAR_Z + BOOTH.z) / 2 - 0.08);
    world(rbox(BOOTH_HALF * 2 + 0.36, 0.1, 0.14, 0.03), gilt, 0, BOOTH.y1 + 0.02, BOOTH.z - 0.06);
    // Inside: a lit back wall for the windows to show, and the dark between.
    world(new THREE.PlaneGeometry(BOOTH_HALF * 2 - 0.4, 2.6).rotateY(Math.PI), boothGlow, 0, PORT.y + 0.5, BOOTH.z + 2.1);
    world(box(BOOTH_HALF * 2 - 0.4, 0.05, 2.1), black, 0, PORT.y - 0.5, BOOTH.z + 1.2);
    // Steel frames round the ports, and the fire shutter down over the idle one.
    for (const port of PORTS) {
      for (const sy of [-1, 1]) world(rbox(port.w + 0.14, 0.05, 0.06), metals.darkMetal, port.x, port.y + sy * (port.h / 2 + 0.025), BOOTH.z - 0.02);
      for (const sx of [-1, 1]) world(rbox(0.05, port.h + 0.04, 0.06), metals.darkMetal, port.x + sx * (port.w / 2 + 0.045), port.y, BOOTH.z - 0.02);
    }
    world(rbox(0.5, 0.38, 0.03), metals.structural, PORTS[1].x, PORTS[1].y, BOOTH.z + 0.05);
    world(rbox(0.52, 0.4, 0.03), metals.structural, 0, PORT.y + 0.46, BOOTH.z - 0.03);
    // The lens.
    world(cyl(0.085, 0.16, "z", 16), metals.darkMetal, 0, PORT.y, PORT.z + 0.16);
    world(new THREE.CircleGeometry(0.06, 16).rotateY(Math.PI), lensGlow, 0, PORT.y, PORT.z + 0.075);
  }

  // Reels turning on the rewinder, seen against the booth's light through its windows.
  const reels: THREE.Mesh[] = [];
  for (const [x, y, r] of [[PORTS[2].x + 0.05, PORTS[2].y + 0.33, 0.3], [PORTS[3].x, PORTS[3].y + 0.3, 0.19]]) {
    const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(r, r * 0.1, 6, 28), cyl(r * 0.3, 0.05, "z", 12), cyl(r * 0.52, 0.02, "z", 16)];
    for (const turn of [0.3, 0.3 + Math.PI / 2]) parts.push(box(r * 2, r * 0.24, 0.02).rotateZ(turn));
    const reel = new THREE.Mesh(mergeGeometries(parts)!, black);
    reel.position.set(x, y, BOOTH.z + 0.9);
    scene.add(reel);
    reels.push(reel);
  }
  // ---- Pilasters, dado and fittings along the lower walls -----------------------------------------------
  for (const side of sides) {
    const add = sideFrame(side), cast = sideFrame(side, CAST), fine = sideFrame(side, FINE);
    const face = -WALL_X;
    PILASTERS.forEach((z, index) => {
      const top = balconyY(z) - 0.02;
      cast(worldBox(0.14, top - 0.5, 0.62, 2.4), plaster, face + 0.07, 0.5 + (top - 0.5) / 2, z);
      cast(rbox(0.2, 0.5, 0.72, 0.02), timber, face + 0.1, 0.25, z);
      add(ornamentQuad("shaft", 0.46, top - 1.16).rotateY(Math.PI / 2), ornament, face + 0.145, 0.62 + (top - 1.16) / 2, z);
      add(ornamentQuad("capital", 0.74, 0.62).rotateY(Math.PI / 2), ornament, face + 0.16, top - 0.36, z);
      cast(rbox(0.24, 0.1, 0.78, 0.02), gilt, face + 0.1, top - 0.04, z);
      // Sconce: a brass back plate, two arms, two glass shades.
      const glass = SCONCE_LIT[index + (side < 0 ? 0 : 6)] === 0 ? deadGlass : side < 0 && index === FAILING_SCONCE ? failGlass : amberGlass;
      add(rbox(0.03, 0.4, 0.15, 0.012), brass, face + 0.16, 3.22, z);
      add(lathe([[0, 0], [0.05, 0.01], [0.03, 0.04], [0, 0.05]], 10).rotateZ(-Math.PI / 2), brass, face + 0.17, 3.22, z);
      for (const arm of [-1, 1]) {
        fine(tube([[0.17, 3.16, 0], [0.26, 3.1, arm * 0.07], [0.33, 3.14, arm * 0.14], [0.34, 3.24, arm * 0.15]], 0.012, 5), brass, face, 0, z);
        add(lathe([[0.012, 0], [0.04, 0.015], [0.05, 0.05], [0.012, 0.06]], 10), brass, face + 0.34, 3.22, z + arm * 0.15);
        add(lathe([[0.03, 0], [0.062, 0.05], [0.07, 0.11], [0.052, 0.16], [0.04, 0.165]], 12), glass, face + 0.34, 3.27, z + arm * 0.15);
      }
    });
    // Dado: a skirting, raised panels and a rail, in dark timber, between the pilasters.
    const runs: Array<[number, number]> = [[PROS_Z, PILASTERS[5] - 0.31], [PILASTERS[0] + 0.31, DOOR.z - DOOR.half - 0.14], [DOOR.z + DOOR.half + 0.14, BACK_Z], ...PILASTERS.slice(1).map((z, i) => [z + 0.31, PILASTERS[i] - 0.31] as [number, number])];
    for (const [z0, z1] of runs) {
      const length = z1 - z0, mid = (z0 + z1) / 2;
      add(worldBox(0.035, 1.02, length, 1.4), timber, face + 0.018, 0.51, mid);
      add(rbox(0.07, 0.2, length, 0.012, 1.4), timber, face + 0.035, 0.1, mid);
      add(rbox(0.075, 0.07, length, 0.02, 1.4), timber, face + 0.038, 1.05, mid);
      const panels = Math.max(1, Math.round(length / 1.15)), pitch = length / panels;
      for (let k = 0; k < panels; k += 1) fine(rbox(0.03, 0.58, pitch - 0.2, 0.012, 1.4), timber, face + 0.045, 0.6, z0 + (k + 0.5) * pitch);
    }
    // Gilt panel mouldings on the wall fields the range's signs hang in.
    for (const k of side < 0 ? [3, 4] : [4, 5]) {
      const z0 = PILASTERS[k] + 0.37, z1 = PILASTERS[k - 1] - 0.37;
      for (const y of [1.25, 4.02]) add(box(0.024, 0.045, z1 - z0 + 0.045), gilt, face + 0.012, y, (z0 + z1) / 2);
      for (const z of [z0, z1]) add(box(0.024, 2.725, 0.045), gilt, face + 0.012, 2.635, z);
    }
    // The exit: a pair of padded doors under a lit box, and door curtains on a brass pole held back to either side.
    for (const sz of [-1, 1]) cast(rbox(0.11, DOOR.head + 0.14, 0.14, 0.015), timber, face + 0.055, (DOOR.head + 0.14) / 2, DOOR.z + sz * (DOOR.half + 0.07));
    cast(rbox(0.13, 0.16, DOOR.half * 2 + 0.4, 0.015), timber, face + 0.065, DOOR.head + 0.08, DOOR.z);
    for (const leaf of [-1, 1]) {
      const z = DOOR.z + leaf * DOOR.half / 2;
      add(worldBox(0.05, DOOR.head, DOOR.half - 0.008, 1.4), timber, face + 0.03, DOOR.head / 2, z, undefined, undefined, { hit: true });
      add(rbox(0.024, 1.04, DOOR.half - 0.24, 0.012), velvet, face + 0.06, 1.44, z);
      add(box(0.012, 0.24, DOOR.half - 0.06), brass, face + 0.061, 0.15, z);
      add(box(0.014, 0.3, 0.08), brass, face + 0.064, 1.1, DOOR.z + leaf * 0.09);
      add(new THREE.TorusGeometry(0.15, 0.022, 6, 20).rotateY(Math.PI / 2), brass, face + 0.076, 1.62, z);
      add(new THREE.CircleGeometry(0.15, 20).rotateY(Math.PI / 2), darkGlass, face + 0.078, 1.62, z);
    }
    add(rbox(0.12, 0.3, 0.74, 0.015), metals.darkMetal, face + 0.08, 2.74, DOOR.z);
    world(remapUv(new THREE.PlaneGeometry(0.66, 0.24), signs.rects.exit).rotateY(-side * Math.PI / 2), exitLit, side * (WALL_X - 0.146), 2.74, DOOR.z);
    add(cyl(0.022, 3.7, "z", 8), brass, face + 0.2, POLE, DOOR.z);
    for (const sz of [-1, 1]) {
      add(new THREE.SphereGeometry(0.05, 10, 8), brass, face + 0.2, POLE, DOOR.z + sz * 1.87);
      add(box(0.2, 0.03, 0.03), brass, face + 0.1, POLE, DOOR.z + sz * 1.62);
      // Drawn facing +z with x running from the door's middle toward the screen, then turned to the wall.
      const inner = (t: number) => t < 0.4 ? lerp(1.2, 1.32, smooth(t, 0, 0.4)) : lerp(1.32, 0.5, smooth(t, 0.4, 1) ** 1.5);
      add(drape(POLE - 0.06, sz < 0 ? inner : () => -1.72, sz < 0 ? () => 1.72 : (t) => -inner(t), 6, 0.05, 5 + sz).rotateY(Math.PI / 2), doorCloth, face + 0.2, 0.04, DOOR.z);
      add(new THREE.TorusGeometry(0.21, 0.018, 6, 16).rotateX(Math.PI / 2).scale(0.55, 1, 1), gilt, face + 0.2, 0.04 + (POLE - 0.06) * 0.4, DOOR.z + sz * 1.52);
    }
    // Over the door, a panel with the house's cartouche in it.
    for (const y of [3.6, 6.5]) add(box(0.024, 0.045, 4.745), gilt, face + 0.012, y, 6.65);
    for (const z of [4.3, 9.0]) add(box(0.024, 2.855, 0.045), gilt, face + 0.012, 5.05, z);
    world(ornamentQuad("cartouche", 1.9, 1.48).rotateY(-side * Math.PI / 2), ornament, side * (WALL_X - 0.02), 5.05, 6.65);
    // A brass strip in the carpet marks the side aisle.
    add(box(0.045, 0.008, 33.6), brass, -8.32, 0.004, -7.9);
    // Aisle lamps: a brass hood in the skirting with the light under it.
    for (let k = 2; k < 12; k += 1) {
      const z = 8.075 - 2.95 * k;
      if (side > 0 && k === 7) continue;
      add(rbox(0.07, 0.07, 0.2, 0.015), brass, face + 0.09, 0.335, z);
      add(box(0.02, 0.05, 0.16), lampGlow, face + 0.085, 0.28, z);
    }
    // Frieze and cornice under the balcony, along the level run of the wall.
    add(remapUv(new THREE.PlaneGeometry(-0.6 - PROS_Z, 0.5), [0, orn.rects.frieze[1], (-0.6 - PROS_Z) / BAY, orn.rects.frieze[3]]).rotateY(Math.PI / 2), ornament, face + 0.004, LOW - 0.27, (-0.6 + PROS_Z) / 2);
    // Upper sconces along the back of the balcony.
    for (let k = 0; k < 7; k += 1) {
      const z = PILASTERS[0] + BAY - BAY * k;
      if (z > REAR_Z - 1) continue;
      add(rbox(0.04, 0.5, 0.2, 0.012), brass, -OUTER_X + 0.03, 10.05, z);
      add(lathe([[0.04, 0], [0.09, 0.07], [0.1, 0.16], [0.07, 0.23], [0.05, 0.24]], 12), amberGlass, -OUTER_X + 0.2, 10.02, z);
      add(worldBox(0.1, upperHeight, 0.6, 2.4), plaster, -OUTER_X + 0.05, upperBase + upperHeight / 2, z);
    }
  }

  // ---- Side boxes ---------------------------------------------------------------------------------
  // A bow-fronted plaster parapet under each opening, drapes held back to the jambs under a swagged pelmet,
  // a brass rail, and two chairs nobody has sat in since the talkies came.
  const BOMBE: Array<[number, number]> = [[0, 0], [0.06, 0.03], [0.06, 0.1], [0.16, 0.2], [0.27, 0.38], [0.3, 0.56], [0.26, 0.7], [0.26, 0.74], [0.31, 0.78], [0.31, 0.86], [0.25, 0.9]];
  const boxSeats: Transform[] = [];
  for (const side of sides) for (const zc of BOXES[side]) {
    const add = sideFrame(side), cast = sideFrame(side, CAST), face = -WALL_X, base = 1.1, top = base + 0.9;
    const z0 = zc - BOX_HOLE.half - 0.12, z1 = zc + BOX_HOLE.half + 0.12;
    const run: Station[] = [z0, z1].map((z) => ({ p: new THREE.Vector3(face, base, z), a: new THREE.Vector3(1, 0, 0), b: new THREE.Vector3(0, 1, 0) }));
    cast(loft(run, BOMBE, { tile: (z1 - z0) * 2, v: band("fascia") }), ornament, 0, 0, 0, undefined, undefined, { hit: true });
    add(loft(run, [[0.25, 0.9], [-0.04, 0.9]]), plaster);
    for (const z of [z0 - 0.09, z1 + 0.09]) {
      cast(rbox(0.36, 0.96, 0.2, 0.02), plaster, face + 0.17, base + 0.46, z);
      add(rbox(0.4, 0.06, 0.24, 0.02), gilt, face + 0.18, base + 0.95, z);
      add(new THREE.SphereGeometry(0.07, 12, 8), gilt, face + 0.2, base + 1.04, z);
    }
    add(tube([[face + 0.27, top + 0.09, z0], [face + 0.27, top + 0.09, z1]], 0.02, 6), brass);
    for (let k = 0; k <= 4; k += 1) add(cyl(0.009, 0.09, "y", 6), brass, face + 0.27, top + 0.045, lerp(z0 + 0.2, z1 - 0.2, k / 4));
    // The opening: a gilt architrave, the drapes, and a pelmet of three swags.
    for (const sz of [-1, 1]) add(box(0.05, BOX_HOLE.head - top + 0.1, 0.1), gilt, face + 0.025, (BOX_HOLE.head + top + 0.1) / 2, zc + sz * (BOX_HOLE.half + 0.05));
    add(box(0.06, 0.1, BOX_HOLE.half * 2 + 0.3), gilt, face + 0.03, BOX_HOLE.head + 0.05, zc);
    const height = BOX_HOLE.head - BOX_HOLE.sill - 0.04;
    const inner = (t: number) => t < 0.36 ? lerp(1.5, 1.6, smooth(t, 0, 0.36)) : lerp(1.6, 0.9, smooth(t, 0.36, 1) ** 1.5);
    add(drape(height, inner, () => BOX_HOLE.half, 5, 0.04, zc).rotateY(Math.PI / 2), drapery, face - 0.16, BOX_HOLE.sill + 0.02, zc);
    add(drape(height, () => -BOX_HOLE.half, (t) => -inner(t), 5, 0.04, zc + 2).rotateY(Math.PI / 2), drapery, face - 0.16, BOX_HOLE.sill + 0.02, zc);
    for (let k = -1; k <= 1; k += 1) add(swag(1.36, 0.14, 0.3, 0.09).rotateY(Math.PI / 2), drapery, face - 0.08, BOX_HOLE.head, zc + k * 1.27);
    // A wall lamp at the back, turned low.
    add(rbox(0.03, 0.26, 0.12, 0.012), brass, face - 2.77, 3.3, zc);
    add(lathe([[0.03, 0], [0.07, 0.06], [0.08, 0.14], [0.055, 0.2]], 12), boxGlass, face - 2.68, 3.26, zc);
    for (const sz of [-1, 1]) boxSeats.push(at(side * (WALL_X + 1.3), 1.3, zc + sz * 0.55, [0, -side * (Math.PI / 2 + 0.3), 0]));
  }

  // ---- What is showing ------------------------------------------------------------------------------
  {
    // West, between the box and the range's signs: the letter board under its lit header, two picture lights
    // over it, and a one-sheet either side.
    const z = -5.2, add = sideFrame(-1);
    onWall(-1, "nowShowing", 2.7, 0.4, 3.64, z, backlit, 0.05);
    wallFrame(-1, 2.7, 0.4, 3.64, z, gilt, 0.05, 0.07);
    onWall(-1, "board", 2.7, 1.74, 2.46, z, printed, 0.03);
    wallFrame(-1, 2.7, 1.74, 2.46, z, timber, 0.08, 0.07);
    for (const sz of [-1, 1]) {
      add(tube([[0, 4.0, 0], [0.2, 4.06, 0], [0.34, 4.0, 0], [0.36, 3.95, 0]], 0.012, 5), brass, -WALL_X, 0, z + sz * 0.7);
      add(cyl(0.04, 0.8, "z", 10), brass, -WALL_X + 0.36, 3.92, z + sz * 0.7);
      add(box(0.03, 0.012, 0.7), lampGlow, -WALL_X + 0.36, 3.884, z + sz * 0.7);
    }
    for (const [key, sz] of [["rushB", -1], ["doorStuck", 1]] as Array<[string, number]>) {
      onWall(-1, key, 0.84, 1.26, 2.4, z + sz * 2.06, printed);
      wallFrame(-1, 0.84, 1.26, 2.4, z + sz * 2.06);
    }
    // East: three lit cases under COMING SOON.
    onWall(1, "comingSoon", 2.7, 0.4, 3.64, z, backlit, 0.05);
    wallFrame(1, 2.7, 0.4, 3.64, z, gilt, 0.05, 0.07);
    ["forceBuy", "float", "tradeUp"].forEach((key, i) => {
      onWall(1, key, 1.0, 1.5, 2.36, z + (i - 1) * 1.62, backlit, 0.06);
      wallFrame(1, 1.0, 1.5, 2.36, z + (i - 1) * 1.62, brass, 0.07, 0.1);
    });
    // Beside the exits.
    onWall(-1, "ecoRound", 0.7, 1.05, 2.25, 4.43, printed);
    wallFrame(-1, 0.7, 1.05, 2.25, 4.43);
    onWall(1, "noticeRush", 0.5, 0.664, 2.2, 4.43, printed);
    wallFrame(1, 0.5, 0.664, 2.2, 4.43, timber, 0.03, 0.03);
  }

  // ---- The back wall ---------------------------------------------------------------------------------
  {
    world(rbox(19.0, 0.2, 0.07, 0.012, 1.4), timber, 0, 0.1, BACK_Z - 0.035);
    for (const side of sides) {
      const x0 = side * 6.25, x1 = side * (WALL_X - 0.02), mid = (x0 + x1) / 2, length = Math.abs(x1 - x0);
      world(worldBox(length, 1.02, 0.035, 1.4), timber, mid, 0.51, BACK_Z - 0.018);
      world(rbox(length, 0.07, 0.075, 0.02, 1.4), timber, mid, 1.05, BACK_Z - 0.038);
      for (let k = 0; k < 3; k += 1) world(rbox(length / 3 - 0.2, 0.58, 0.03, 0.012, 1.4), timber, x0 + side * (k + 0.5) * length / 3, 0.6, BACK_Z - 0.045, undefined, undefined, FINE);
      // The soffit lamp over each corner.
      world(lathe([[0, -0.07], [0.12, -0.06], [0.2, -0.02], [0.22, 0]], 16), brass, side * 7.5, HIGH - 0.005, 8.4);
      world(new THREE.CircleGeometry(0.11, 16).rotateX(Math.PI / 2), lampGlow, side * 7.5, HIGH - 0.072, 8.4);
    }
    world(remapUv(new THREE.PlaneGeometry(WALL_X * 2, 0.5), [0, orn.rects.frieze[1], WALL_X * 2 / BAY, orn.rects.frieze[3]]).rotateY(Math.PI), ornament, 0, HIGH - 0.27, BACK_Z - 0.004);
    onBack("lossBonus", 0.92, 1.38, -7.9, 2.55, printed);
    backFrame(0.92, 1.38, -7.9, 2.55);
    onBack("cases", 0.92, 1.38, 7.9, 2.55, printed);
    backFrame(0.92, 1.38, 7.9, 2.55);
    onBack("noticeStaff", 0.42, 0.558, -6.68, 1.85, printed);
    onBack("noticeSmoke", 0.42, 0.558, 6.68, 1.85, printed);
    onBack("cache", 1.5, 0.5, -7.75, 3.82, printed);
    backFrame(1.5, 0.5, -7.75, 3.82, timber, 0.04, 0.04);
    onBack("plaque", 1.1, 0.55, 7.75, 3.82, printed);
    backFrame(1.1, 0.55, 7.75, 3.82, brass, 0.03, 0.03);
  }

  // ---- The chandelier -------------------------------------------------------------------------------
  // Unlit for years. It hangs from the crown of the dome on its chain, just clear of the beam, and turns what
  // comes off the screen into a few hundred sparks.
  const chandelier = new THREE.Group();
  {
    const metalwork: THREE.BufferGeometry[] = [], drops: THREE.BufferGeometry[] = [], next = rng(2027);
    const set = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, rotation?: V3, scale?: V3) => geometry.applyMatrix4(mat4(x, y, z, rotation, scale));
    const drop = (x: number, y: number, z: number, size = 0.05) => drops.push(set(new THREE.OctahedronGeometry(size, 0), x, y, z, [0, next() * 3, 0], [1, 1.9, 1]));
    metalwork.push(lathe([[0.05, -0.2], [0.1, -0.12], [0.26, -0.05], [0.22, 0], [0, 0.02]], 16));
    for (let k = 0; k < 21; k += 1) metalwork.push(set(new THREE.TorusGeometry(0.04, 0.012, 5, 8), 0, -0.26 - k * 0.1, 0, [0, k % 2 ? Math.PI / 2 : 0, 0], [1, 1.5, 1]));
    metalwork.push(lathe([[0.03, -2.62], [0.42, -2.56], [0.5, -2.5], [0.44, -2.46], [0.18, -2.4], [0.05, -2.3]], 20));
    metalwork.push(lathe([[0, -4.62], [0.05, -4.6], [0.09, -4.5], [0.05, -4.4], [0.035, -4.28], [0.12, -4.14], [0.14, -4.04], [0.06, -3.9], [0.04, -3.6], [0.1, -3.46], [0.1, -3.4], [0.04, -3.26], [0.03, -2.62]], 14));
    const tier = (count: number, reach: number, y: number, turn: number) => {
      metalwork.push(set(new THREE.TorusGeometry(reach, 0.028, 6, 48).rotateX(Math.PI / 2), 0, y + 0.02, 0));
      for (let i = 0; i < count; i += 1) {
        const angle = turn + (i / count) * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
        metalwork.push(tube([[0.1, y - 0.3], [reach * 0.38, y - 0.5], [reach * 0.72, y - 0.4], [reach * 0.95, y - 0.18], [reach, y]].map(([r, h]) => [c * r, h, s * r] as V3), 0.03, 6));
        metalwork.push(set(lathe([[0.02, 0], [0.11, 0.016], [0.12, 0.045], [0.035, 0.055], [0.03, 0.2], [0, 0.205]], 10), c * reach, y, s * reach));
        drops.push(set(new THREE.SphereGeometry(0.045, 8, 6), c * reach, y + 0.25, s * reach, undefined, [1, 1.5, 1]));
        drop(c * reach, y - 0.1, s * reach, 0.055);
        // A string of crystal from the crown out to the arm.
        for (let k = 1; k < 9; k += 1) { const t = k / 9, r = lerp(0.5, reach, t); drop(c * r, lerp(-2.5, y, t) - 0.42 * Math.sin(Math.PI * t), s * r, 0.04); }
      }
    };
    tier(14, 1.75, -3.8, 0);
    tier(8, 1.1, -3.15, Math.PI / 8);
    for (const [count, r, y] of [[18, 0.5, -4.2], [14, 0.36, -4.42], [10, 0.2, -4.6]]) for (let i = 0; i < count; i += 1) { const a = (i / count) * Math.PI * 2; drop(Math.cos(a) * r, y, Math.sin(a) * r, 0.045); }
    drop(0, -4.7, 0, 0.075);
    const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map((part) => part.index ? part.toNonIndexed() : part))!;
    for (const [parts, material] of [[metalwork, gilt], [drops, crystal]] as Array<[THREE.BufferGeometry[], THREE.Material]>) {
      const mesh = new THREE.Mesh(merge(parts), material);
      chandelier.add(mesh);
      kit.shootable.push(mesh);
    }
    chandelier.position.set(DOME.x, CEILING + DOME.rise - 0.03, DOME.z);
    scene.add(chandelier);
  }

  // ---- The projectionist's corner -----------------------------------------------------------------------
  // Film cans stacked by the west end of the back wall, a rewind bench at the east end, and a ladder left
  // leaning by the exit.
  const can = (x: number, y: number, z: number, rotation: V3 = [0, 0, 0], label?: string) => {
    world(mergeGeometries([cyl(0.19, 0.036, "y", 20).translate(0, 0.018, 0), cyl(0.194, 0.016, "y", 20).translate(0, 0.044, 0)])!, tin, x, y, z, rotation, undefined, CAST);
    if (label) world(remapUv(new THREE.CircleGeometry(0.15, 20), signs.rects[label]).rotateX(-Math.PI / 2), printed, x, y + 0.0535, z, [0, rotation[1], 0]);
  };
  /** A striped popcorn tub, full unless it has been knocked over. */
  const tub = (x: number, y: number, z: number, yaw: number, tipped = false) => {
    const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
    const [u0, v0, u1, v1] = signs.rects.popcorn, low = 0.052, wide = 0.074, tall = 0.17;
    for (let i = 0; i < 4; i += 1) {
      const c = Math.cos(i * Math.PI / 2), s = Math.sin(i * Math.PI / 2), first = position.length / 3;
      for (const [h, e, r] of [[0, -1, low], [0, 1, low], [tall, 1, wide], [tall, -1, wide]]) {
        position.push(s * r + c * e * r, h, c * r - s * e * r);
        normal.push(s, 0.12, c);
        uv.push(e < 0 ? u0 : u1, h > 0 ? v1 : v0);
      }
      index.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    const card = new THREE.BufferGeometry();
    card.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    card.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    card.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    card.setIndex(index);
    const fill = new THREE.IcosahedronGeometry(0.078, 1).scale(1, 0.5, 1).translate(0, tall - 0.012, 0);
    const foot = box(low * 2, 0.004, low * 2).translate(0, 0.002, 0);
    if (tipped) { for (const part of [card, foot]) part.rotateX(Math.PI / 2 - 0.13).translate(0, 0.052, 0); }
    world(card, printed, x, y, z, [0, yaw, 0]);
    world(foot, popped, x, y, z, [0, yaw, 0]);
    if (!tipped) world(fill, popped, x, y, z, [0, yaw, 0]);
  };
  {
    const next = rng(5150);
    for (const [x, z, count, label] of [[-7.55, 9.27, 7, "canA"], [-7.08, 9.3, 4, "canB"], [-8.05, 9.22, 2, "canB"]] as Array<[number, number, number, string]>) {
      for (let k = 0; k < count; k += 1) can(x + (next() - 0.5) * 0.03, k * 0.052, z + (next() - 0.5) * 0.03, [0, next() * 6.28, 0], k === count - 1 ? label : undefined);
    }
    can(-6.62, 0.186, 9.5, [Math.PI / 2 - 0.22, 0, 0]);
    // The rewind bench: two geared heads, a full reel and a nearly empty one, the film run between them.
    const bx = 7.95, bz = 9.17, top = 0.9;
    world(worldBox(1.9, 0.05, 0.62, 1.2), pine, bx, top - 0.025, bz, undefined, undefined, SOLID);
    world(worldBox(1.78, 0.03, 0.5, 1.2), pine, bx, 0.3, bz, undefined, undefined, CAST);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) world(box(0.07, top - 0.05, 0.07), pine, bx + sx * 0.88, (top - 0.05) / 2, bz + sz * 0.25, undefined, undefined, CAST);
    world(box(1.76, 0.1, 0.03), pine, bx, top - 0.1, bz - 0.27);
    for (const [sx, pack] of [[-1, 0.15], [1, 0.07]]) {
      const x = bx + sx * 0.6, y = top + 0.37, z = bz - 0.02;
      world(box(0.06, 0.37, 0.07), metals.darkMetal, x, top + 0.185, z + 0.1);
      world(box(0.16, 0.02, 0.2), metals.darkMetal, x, top + 0.01, z + 0.06);
      world(cyl(0.012, 0.16, "z", 8), metals.brushed, x, y, z + 0.03);
      world(new THREE.TorusGeometry(0.19, 0.008, 5, 24), metals.brushed, x, y, z - 0.03);
      for (const turn of [0.4, 0.4 + Math.PI / 3, 0.4 + 2 * Math.PI / 3]) world(box(0.38, 0.024, 0.004), metals.brushed, x, y, z - 0.03, [0, 0, turn]);
      world(cyl(pack, 0.03, "z", 20), black, x, y, z - 0.012);
      world(cyl(0.035, 0.05, "z", 10), metals.darkMetal, x, y, z - 0.03);
    }
    world(box(1.2, 0.003, 0.035), black, bx, top + 0.48, bz - 0.032, [0, 0, -0.066]);
    world(rbox(0.14, 0.035, 0.1, 0.008), metals.darkMetal, bx - 0.02, top + 0.018, bz - 0.15);
    world(box(0.1, 0.006, 0.03), brass, bx - 0.02, top + 0.038, bz - 0.15);
    can(bx + 0.14, top, bz + 0.08, [0, 0.6, 0]);
    can(bx + 0.15, top + 0.052, bz + 0.09, [0, 2.1, 0], "canA");
    for (let k = 0; k < 3; k += 1) can(bx - 0.45 + (next() - 0.5) * 0.03, 0.315 + k * 0.052, bz + (next() - 0.5) * 0.03, [0, next() * 6.28, 0]);
    tub(bx - 0.3, top, bz - 0.16, 0.5);
    // The ladder, against the west wall north of the exit.
    const ladder = frame(mat4(-8.55, 0, 8.72, [0, 0, 0.281]), CAST);
    for (const sz of [-1, 1]) ladder(box(0.032, 3.5, 0.07), pine, 0, 1.75, sz * 0.2);
    for (let k = 0; k < 11; k += 1) ladder(cyl(0.015, 0.4, "z", 6), pine, 0, 0.32 + k * 0.29, 0);
  }

  // ---- The leaks --------------------------------------------------------------------------------------
  // A galvanised bucket under each: the west one on the carpet with the mop standing in it and a board put
  // out beside it; the east one, where the drip comes down on the end of the control desk, on a dust sheet.
  const BUCKET: number[][] = [[0, 0], [0.115, 0], [0.15, 0.28], [0.157, 0.285], [0.14, 0.28], [0.108, 0.014], [0, 0.014]];
  const bucket = (x: number, y: number, z: number, level: number) => {
    world(lathe(BUCKET, 18), tin, x, y, z, undefined, undefined, CAST);
    world(new THREE.CircleGeometry(0.108 + 0.032 * level / 0.28, 18).rotateX(-Math.PI / 2), darkGlass, x, y + level, z);
    world(new THREE.TorusGeometry(0.157, 0.005, 4, 16, Math.PI), tin, x, y + 0.27, z, [1.32, 0, 0]);
  };
  bucket(-8.8, 0, -22, 0.17);
  world(tube([[-8.78, 0.05, -22.02], [-9.3, 1.44, -22.3]], 0.013, 6), pine);
  {
    const board = frame(mat4(-8.5, 0, -20.95, [0, 0.14, 0]), CAST);
    for (const sz of [-1, 1]) {
      const tilt = -sz * 0.22, y = 0.54 - 0.28 * Math.cos(0.22), z = sz * 0.28 * Math.sin(0.22);
      board(box(0.37, 0.56, 0.014), yellow, 0, y, z, [tilt, 0, 0]);
      const sheetOn = remapUv(new THREE.PlaneGeometry(0.35, 0.525), signs.rects.caution);
      if (sz < 0) sheetOn.rotateY(Math.PI);
      board(sheetOn, printed, 0, y + 0.0085 * Math.sin(0.22), z + sz * 0.0085 * Math.cos(0.22), [tilt, 0, 0]);
    }
  }
  world(rbox(0.46, 0.014, 0.4, 0.006), sheetCloth, 7.5, 1.132, -25.86, [0, 0.12, 0]);
  bucket(7.5, 1.139, -25.9, 0.21);

  // ---- Rope barriers in front of the boards ------------------------------------------------------------
  const POST: number[][] = [[0, 0], [0.16, 0], [0.165, 0.02], [0.07, 0.05], [0.028, 0.085], [0.028, 0.9], [0.046, 0.915], [0.052, 0.95], [0.03, 0.99], [0, 1.0]];
  const ropes: THREE.BufferGeometry[] = [];
  for (const side of sides) {
    const zs = [-7.25, -5.2, -3.15], x = side * 8.56;
    for (const z of zs) world(lathe(POST, 14), brass, x, 0, z, undefined, undefined, CAST);
    for (let k = 0; k < zs.length - 1; k += 1) {
      const points: V3[] = [];
      for (let i = 0; i <= 10; i += 1) { const t = i / 10; points.push([x, 0.9 - 0.8 * t * (1 - t), lerp(zs[k] + 0.04, zs[k + 1] - 0.04, t)]); }
      ropes.push(tube(points, 0.019, 6));
    }
  }

  // ---- What is left of the stalls, and of the last house ---------------------------------------------------
  const strays: Transform[] = [];
  for (const [side, zc, skew] of [[-1, -0.15, 0.03], [1, -0.15, -0.025], [-1, -17, -0.02], [1, -17, 0.035]]) {
    const yaw = -side * Math.PI / 2 + skew;
    for (let k = 0; k < 6; k += 1) { const along = (k - 2.5) * 0.56; strays.push(at(side * 9.05 + Math.cos(yaw) * along, 0, zc - Math.sin(yaw) * along, [0, yaw, 0])); }
  }
  tub(8.98, 0, -5.6, 0.4);
  tub(9.12, 0.6, -6.92, -1.3);
  tub(9.0, 0, -4.3, 2.9, true);
  tub(-9.12, 0, 1.78, 1.9);
  tub(-9.05, 0, -6.9, 0.7);
  {
    const next = rng(77), kernel = new THREE.IcosahedronGeometry(0.013, 0);
    for (let i = 0; i < 46; i += 1) { const a = next() * 6.28, d = 0.08 + next() * next() * 0.42; world(kernel, popped, 9.0 + Math.cos(a) * d * 0.6, 0.011, -4.56 + Math.sin(a) * d, [next() * 3, next() * 3, 0]); }
  }
  // ---- Furnace -------------------------------------------------------------------------------------
  // The flue goes up into the underside of the balcony, through a collar plate.
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, LOW - 3.6 + 0.05);

  flush();
  kit.instances(seat.velvet, velvet, [...seats, ...boxSeats], false, true);
  kit.instances(seat.shell, seatWood, [...seats, ...boxSeats], false, true);
  kit.instances(fineSeat.velvet, velvet, strays, true, true);
  kit.instances(fineSeat.shell, timber, strays, true, true);
  {
    // The ropes are a mesh of their own so that they can be walked through.
    const rope = new THREE.Mesh(mergeGeometries(ropes)!, ropeCloth);
    rope.userData.walkThrough = true;
    rope.receiveShadow = true;
    scene.add(rope);
  }

  // ---- Left behind by the last house --------------------------------------------------------------------
  // Cartons, bottles and crates from the shared props, lit by the house like everything else.
  const props = createProps(kit, { seed: 1927 });
  const housed = new Set<THREE.Material>();
  const use = (kind: PropKind) => {
    for (const part of props.get(kind).parts) {
      const material = part.material as THREE.MeshStandardMaterial;
      if (material.isMeshStandardMaterial && !housed.has(material)) { housed.add(material); practical(material); }
    }
    return kind;
  };
  const sodaRadius = props.get(use("bottleSoda")).size[0] / 2, beerRadius = props.get(use("bottleBeer")).size[0] / 2;
  props.place(use("cartonTall"), [{ position: [9.14, 0, -7.3], rotation: [0, -Math.PI / 2 + 0.08, 0] }, { position: [9.12, 0, -6.92], rotation: [0, -Math.PI / 2 - 0.12, 0] }], { seed: 3 });
  props.place(use("cartonSmall"), [{ position: [9.13, 0.6, -7.28], rotation: [0, -1.2, 0] }, { position: [9.1, 0, -3.35], rotation: [0, -1.9, 0] }, { position: [-9.14, 0, -7.38], rotation: [0, 1.4, 0] }], { seed: 4 });
  props.place(use("cartonCrushed"), [{ position: [9.05, 0, -2.9], rotation: [0, 2.2, 0] }], { seed: 5 });
  props.fill(use("cartonOpen"), [{ position: [9.08, 0, -6.32], rotation: [0, -Math.PI / 2 + 0.05, 0] }], ["bottleSoda"], { count: 9, seed: 6 });
  props.place("bottleSoda", [
    { position: [8.86, sodaRadius, -4.95], rotation: [0, 0.7, Math.PI / 2] },
    { position: [-9.2, 0, -3.02] }, { position: [-9.1, 0, -3.15], rotation: [0, 2, 0] },
    { position: [-9.22, 0, 1.52] },
  ], { seed: 7 });
  props.place("bottleBeer", [
    { position: [8.9, 0, -3.78] },
    { position: [-8.92, beerRadius, -1.98], rotation: [0, -0.5, Math.PI / 2] },
    { position: [7.14, 0.9, 9.34] },
  ], { seed: 8 });

  // ---- Life ----------------------------------------------------------------------------------------
  // The only air that moves comes in under the exit doors and goes out through the roof.
  const wind = createWind({ heading: 0.4, strength: 0.16, gustiness: 0.85 });
  const life = createLife(kit, options, { wind, seed: 1927 });
  life.cloth(doorCloth, { pin: { height: POLE - 0.04, reach: 2.6 }, amplitude: 0.035, frequency: 1.4, lean: 0.2, flutter: 0.5 });
  life.cloth(stageCloth, { pin: { height: CEILING - 0.9, reach: 7 }, amplitude: 0.06, frequency: 0.6, lean: 0.15, flutter: 0.3 });
  const swing = life.sway(chandelier, { amplitude: 0.012, period: 4.2, axis: "both", damping: 0.03 });
  const amber = amberGlass.color.clone();
  life.flicker((level) => { failGlass.color.copy(amber).multiplyScalar(0.06 + 0.94 * level); sconceLive.value[FAILING_SCONCE] = level; }, "tube", { at: [-WALL_X + 0.34, 3.3, PILASTERS[FAILING_SCONCE]] });
  life.insects([[-WALL_X + 0.4, 3.45, PILASTERS[FAILING_SCONCE]]], { kind: "moths", count: 5, radius: 0.45 });
  life.birds("pigeon", {
    perches: [
      { from: [-FASCIA_X - 0.05, LOW + 1.09, -21], to: [-FASCIA_X - 0.05, LOW + 1.09, -9], thin: true },
      { from: [-2.8, BOOTH.y1 + 0.225, BOOTH.z + 0.05], to: [2.8, BOOTH.y1 + 0.225, BOOTH.z + 0.05] },
      { from: [FASCIA_X + 0.05, LOW + 1.09, -16], to: [FASCIA_X + 0.05, LOW + 1.09, -4], thin: true },
    ],
    count: 5, roam: { x: [-6.5, 6.5], y: [10.2, 12.8], z: [-24, 3] }, from: [FAN.x, CEILING - 0.6, FAN.z],
  });
  let rattled = -10;
  const struck = (object: THREE.Object3D, point: THREE.Vector3) => {
    if (object.parent !== chandelier) return life.struck(object, point);
    // A bullet in the chandelier sets it swinging away from the firing line.
    swing.kick(0.09, point.x - DOME.x, -1.5);
    const seconds = performance.now() / 1000;
    if (seconds - rattled > 0.7) { rattled = seconds; say("chainRattle", DOME.x, 12.4, DOME.z, 0.9, 1.1); }
    return true;
  };

  // ---- Light ------------------------------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x5a3a2c, 0x24130f, 0.55));
  const sun = kit.sunLight({ color: 0xffe6c4, intensity: SUN_BASE, toSun: TO_SUN, extent: 27, distance: 46, near: 2, far: 96, radius: 4 });
  // The only real lamps are the two in the soffit over the back corners. They sit beside the plane of the
  // chart, where nothing of them can show in its glass.
  const fills: THREE.PointLight[] = [];
  for (const side of sides) {
    const light = new THREE.PointLight(0xffa860, 11, 24, 1.7);
    light.position.set(side * 7.5, HIGH - 0.45, 8.4);
    scene.add(light);
    fills.push(light);
  }
  const lensAir: Glow = { position: PORT.clone().add(new THREE.Vector3(0, 0, -0.3)), color: new THREE.Color() };
  const screenAir: Glow = { position: new THREE.Vector3(0, SCREEN_MID, SCREEN.z + 1.5), color: new THREE.Color() };

  // ---- The show ---------------------------------------------------------------------------------
  const total = PROGRAMME.reduce((sum, shot) => sum + shot[2], 0);
  let began = -1, last = 0, shotAt = -1, level = 0.2, sunSet = SUN_BASE;
  kit.updates.push((now) => {
    if (began < 0) began = now;
    const seconds = (now - began) / 1000, step = THREE.MathUtils.clamp(seconds - last, 0, 0.1);
    last = seconds;
    // Which frame is in the gate.
    let t = seconds % total, index = 0;
    while (index < PROGRAMME.length - 1 && t >= PROGRAMME[index][2]) { t -= PROGRAMME[index][2]; index += 1; }
    const [mode, card, length, seed] = PROGRAMME[index], progress = t / length;
    if (index !== shotAt) {
      // The reel runs out and the next one is struck: a relay in the booth.
      if (shotAt >= 0 && index === 0) say("relayClack", PORT.x, PORT.y, BACK_Z + 0.8, 0.8, 0.9);
      shotAt = index;
    }
    show.value.set(mode, progress, seed, 0);
    cell.value.set(cards.cells[card][0], cards.cells[card][1], cards.cells[card][2] - cards.cells[card][0], cards.cells[card][3] - cards.cells[card][1]);
    const filmFrame = Math.floor(seconds * 24);
    const lamp = 0.94 + 0.04 * Math.sin(seconds * 13.1) + 0.03 * Math.sin(seconds * 5.3 + 1.7) + (chance(filmFrame) > 0.93 ? -0.1 : 0);
    const jump = chance(filmFrame * 0.37) > 0.985 ? 0.012 : 0;
    gate.value.set((chance(filmFrame + 0.5) - 0.5) * 0.0022, (chance(filmFrame + 9.5) - 0.5) * 0.0036 + jump, lamp, seconds);
    const cardLevel = cards.levels[card];
    const frameLevel = (mode === 0 ? cardLevel * (1 - 0.4 * progress) : mode === 1 ? cardLevel : mode === 2 ? cardLevel * 0.86 : mode === 3 ? 0 : mode === 4 ? CLEAR_LEVEL : FOOTAGE_LEVEL) * lamp;
    level += (frameLevel - level) * Math.min(1, step * 10 + (seconds === 0 ? 1 : 0));
    // The hall breathes with the picture: the key is the screen's own light, over a floor from the fittings.
    const hall = 0.55 + 1.5 * Math.pow(Math.max(level, 0), 0.6);
    houseLive.value.x = level / 0.22;
    if (sun.intensity === sunSet || sun.intensity === SUN_BASE) sunSet = sun.intensity = SUN_BASE * hall / 1.15;
    screenAir.color.setRGB(1, 0.92, 0.78).multiplyScalar(9 * level);
    lensAir.color.setRGB(1, 0.92, 0.8).multiplyScalar(1.5 + 3 * level);
    beamUniforms.beamTime.value = seconds;
    beamUniforms.beamLamp.value = lamp;
    rotor.rotation.y = seconds * 1.1;
    reels[0].rotation.z = -seconds * 2.1;
    reels[1].rotation.z = seconds * 2.6;
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(pictureTarget);
    pictureQuad.render(renderer);
    renderer.setRenderTarget(target);
  });

  // ---- Air -----------------------------------------------------------------------------------------
  kit.motes({ count: 520, x: 18, y: [0.3, 12], z: [-28, 9], color: 0xffdcae, opacity: 0.18 });

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: [lensAir, screenAir],
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: 0x040203, fog: 0x120a0a, fogDensity: high ? 0.005 : 0.008,
      haze: new THREE.Color(0.03, 0.022, 0.018), hazeDensity: 0.006, hazeCeiling: 13.4, hazeFade: 1.5,
      environmentIntensity: 1, exposure: 1.12, far: 130,
    },
    // The key comes over the control centre from the screen: its rack shades the far end of the floor.
    sunlitAt(point) {
      const reachTop = point.y + (point.z + 26.1) * (TO_SUN.y / -TO_SUN.z);
      return point.z < -26.1 || reachTop > 5.2 ? 1 : 0;
    },
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck };
}

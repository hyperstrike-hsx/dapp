import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { brushedMetal, paintedSteel, pbrMaterial, steel, tile } from "../pbr";
import {
  BRAND, STRIKE_ORANGE, canvasTexture, createKit, iBeam, jerseyBarrier, projectUv, softBox, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import { createProps, type PlaceOptions, type PropItem, type PropKind } from "../props";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createTrees } from "../trees";
import { createWind } from "../wind";
import type { Glow } from "../volumetric";

// Core Hall: a sealed containment hall with the range laid out on its floor.
//
// Lighting model: the roof is a concrete slab cut by four luminous slots that
// span the hall. The key light is the cold flood falling through those slots,
// so the slot mullions, the crane rails, the catwalks and the pipe runs print
// crisp shadows and stand as shafts in the haze. Beyond the control centre the
// hall runs on to the vessel, whose core seam breathes cyan into the air and
// across the sealed floor. Everything else is bounce from a probe of the room.
//
// Motion: the sun's shadow map is rendered once, so nothing that moves casts a
// shadow in it. The bridge crane travels, the extract fans turn, the beacons
// sweep and the reliefs blow on clocks of their own (see "Motion"); the light
// they throw or chop is drawn, not shadowed.

const WALL_X = 9.54;
const CONCRETE_X = 9.62;
const WAINSCOT = 4.6;
const CEILING = 13.6;
const BACK_Z = 9.7;
const END_Z = -47;
/** Luminous roof slots: centre z of each, and their half extents. */
const SLOTS = [5, -7, -19, -32];
const SLOT_HALF = { x: 9, z: 2 };
/** Direction from the floor up to the flood lamps. */
const TO_LAMP = new THREE.Vector3(0.06, 1, 0.2).normalize();
const CORE = { x: 0, z: -39, radius: 4.6, base: 2.6, top: 10.2 };
const CORE_CYAN = new THREE.Color(0.1, 0.78, 1);
const CRANE_Z = -9.5;
const DECK_Y = 5.3;
/** Wall-wash tubes under the catwalks, and the bulkhead lamps on the upper walls (one per bay and side). */
const WASH = { x: 9.0, y: DECK_Y - 0.33 };
const LAMP = { y: 7.3, z0: 1, pitch: 12, count: 4 };
const SHIELD_LAMPS = [-1.15, -0.4, 0.4, 1.15];
/** The wash tube on the west wall that is failing, and the pulse that runs down the kerb strips. */
const FAIL_TUBE_Z = 0.5;
const CHASE = { speed: 9, span: 67.5 };
/** Extract fans in the roof between the slots; `speed` is relative to the first. */
const FANS = [{ x: -1.75, z: -1, speed: 1 }, { x: 1.75, z: -13, speed: -0.8 }];
/** Where the bridge crane parks and where it runs to, and how hard it pulls away. */
const CRANE_STOPS = [CRANE_Z, -24.4];
const CRANE_ACCEL = 0.55, CRANE_CRUISE = 1.3;
/** The notice board on the west wall. */
const NOTICE_Z = 5.6;
/** Relief valves on the mains: where the jet leaves the nozzle, the way it blows, and its timer in seconds. */
const RELIEFS: Array<{ at: V3; dir: V3; every: number; phase: number }> = [
  { at: [-8.36, 8.12, -15.76], dir: [0.93, -0.33, 0.16], every: 27, phase: 6 },
  { at: [8.2, 8.66, -4.12], dir: [-0.94, -0.3, -0.14], every: 34, phase: 26 },
];
const JET_SECONDS = 2.4;

type V3 = [number, number, number];

function scaleUv<T extends THREE.BufferGeometry>(geometry: T, u: number, v: number): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
  return geometry;
}


const mat4 = (x = 0, y = 0, z = 0, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale));

/** Rounded box with a single bevel segment: the cheap version for small parts. */
const rbox = (w: number, h: number, d: number, radius = 0.012, metres = 1.2) => projectUv(new RoundedBoxGeometry(w, h, d, 1, radius), metres);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder along a chosen axis. */
function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 12, open = false, radiusEnd = radius) {
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, segments, 1, open);
  if (axis === "x") geometry.rotateZ(-Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  return geometry;
}
const lathe = (profile: number[][], segments = 20) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);

/** Polyline with its corners eased into short bends. */
function roundPath(points: V3[], bend: number, steps = 4) {
  const P = points.map((point) => new THREE.Vector3(...point));
  const out = [P[0].clone()];
  for (let i = 1; i < P.length - 1; i += 1) {
    const a = P[i].clone().sub(P[i - 1]), b = P[i + 1].clone().sub(P[i]);
    const r = Math.min(bend, a.length() * 0.45, b.length() * 0.45);
    const start = P[i].clone().addScaledVector(a.normalize(), -r), end = P[i].clone().addScaledVector(b.normalize(), r);
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      out.push(start.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(P[i], 2 * t * (1 - t)).addScaledVector(end, t * t));
    }
  }
  out.push(P[P.length - 1].clone());
  return out;
}

/** Round tube swept along a polyline with parallel-transported frames. */
function sweep(points: THREE.Vector3[], radius: number, radial = 8) {
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
      const angle = (j / radial) * Math.PI * 2;
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
const pipeRun = (points: V3[], radius: number, bend = radius * 3, radial = 8) => sweep(roundPath(points, bend), radius, radial);

type Rect = [number, number, number, number];

/** One sheet holding every placard, nameplate, dial face and floor stencil in the hall. */
function signAtlas() {
  // Laid out on a 2048 x 1536 sheet and drawn at twice that, so a placard read from a metre away stays sharp.
  const size = 2048, sheetHeight = 1536, density = 2;
  const rects: Record<string, Rect> = {}, aspect: Record<string, number> = {};
  const texture = canvasTexture(size * density, sheetHeight * density, (c) => {
    c.clearRect(0, 0, size * density, sheetHeight * density);
    c.scale(density, density);
    let x = 0, y = 0, rowH = 0, seed = 9131;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const font = (px: number, weight = 900) => { c.font = `${weight} ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; };
    /** Lettering. Given a width to stay inside, a long string is set smaller rather than cut off by its frame. */
    const text = (value: string, tx: number, ty: number, px: number, colour: string, align: CanvasTextAlign = "center", weight = 900, fit = 0) => {
      font(px, weight);
      for (let size = px; fit > 0 && size > 9 && c.measureText(value).width > fit; size -= 1) font(size - 1, weight);
      c.fillStyle = colour; c.textAlign = align; c.textBaseline = "middle"; c.fillText(value, tx, ty);
    };
    /** Block arrow, drawn rather than typed so it does not depend on the fount having one. */
    const arrow = (ax: number, ay: number, size: number, up: boolean, colour: string) => {
      c.save(); c.translate(ax, ay); if (!up) c.rotate(Math.PI);
      c.fillStyle = colour; c.beginPath();
      c.moveTo(0, -size / 2); c.lineTo(size * 0.4, -size * 0.04); c.lineTo(size * 0.15, -size * 0.04); c.lineTo(size * 0.15, size / 2);
      c.lineTo(-size * 0.15, size / 2); c.lineTo(-size * 0.15, -size * 0.04); c.lineTo(-size * 0.4, -size * 0.04);
      c.closePath(); c.fill(); c.restore();
    };
    const wear = (w: number, h: number, amount: number, erase = false) => {
      c.globalCompositeOperation = erase ? "destination-out" : "source-over";
      for (let i = 0; i < w * h * amount * 0.004; i += 1) {
        const shade = next() > 0.5 ? 20 : 235;
        c.fillStyle = erase ? `rgba(0,0,0,${0.3 + next() * 0.6})` : `rgba(${shade},${shade},${shade},${0.05 + next() * 0.12})`;
        c.fillRect(next() * w, next() * h, 1 + next() * 5, 1 + next() * 2);
      }
      c.globalCompositeOperation = "source-over";
    };
    const screws = (w: number, h: number, inset = 16) => {
      for (const sx of [inset, w - inset]) for (const sy of [inset, h - inset]) {
        c.fillStyle = "#6f7a7d"; c.beginPath(); c.arc(sx, sy, 6, 0, Math.PI * 2); c.fill();
        c.strokeStyle = "#2a3032"; c.lineWidth = 2; c.beginPath(); c.moveTo(sx - 4, sy - 2); c.lineTo(sx + 4, sy + 2); c.stroke();
      }
    };
    const cellAt = (key: string, cx: number, cy: number, w: number, h: number, draw: (w: number, h: number) => void) => {
      c.save(); c.translate(cx, cy); c.beginPath(); c.rect(0, 0, w, h); c.clip(); draw(w, h); c.restore();
      const g = 2;
      rects[key] = [(cx + g) / size, 1 - (cy + h - g) / sheetHeight, (cx + w - g) / size, 1 - (cy + g) / sheetHeight];
      aspect[key] = w / h;
    };
    const cell = (key: string, w: number, h: number, draw: (w: number, h: number) => void) => {
      if (x + w > size) { x = 0; y += rowH; rowH = 0; }
      cellAt(key, x, y, w, h, draw);
      x += w; rowH = Math.max(rowH, h);
    };
    const placard = (key: string, ground: string, headGround: string, head: string, headInk: string, big: string | ((w: number) => void), small: string, ink: string) => cell(key, 512, 256, (w, h) => {
      c.fillStyle = ground; c.fillRect(0, 0, w, h);
      c.fillStyle = headGround; c.fillRect(10, 10, w - 20, 78);
      text(head, w / 2, 52, 62, headInk, "center", 900, w - 70);
      if (typeof big === "string") text(big, w / 2, 142, 48, ink, "center", 900, w - 60); else big(w);
      text(small, w / 2, 206, 22, ink, "center", 700, w - 64);
      c.strokeStyle = ink; c.lineWidth = 3; c.strokeRect(10, 10, w - 20, h - 20);
      screws(w, h, 22); wear(w, h, 0.5);
    });

    // Row 1: zone board, floor box, panel mimic.
    cell("zone", 512, 512, (w, h) => {
      c.fillStyle = "#e6eae8"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#15171a"; c.fillRect(12, 12, w - 24, 92);
      text("A SITE", w / 2, 60, 76, "#e9b520");
      const hex = (r: number) => { c.beginPath(); for (let i = 0; i < 6; i += 1) { const a = Math.PI / 6 + i * Math.PI / 3; c[i ? "lineTo" : "moveTo"](w / 2 + Math.cos(a) * r, 236 + Math.sin(a) * r); } c.closePath(); };
      c.fillStyle = "#e9b520"; hex(122); c.fill();
      c.strokeStyle = "#15171a"; c.lineWidth = 10; hex(122); c.stroke();
      // The pictogram takes "planting" at its word: a seedling in a mound of earth.
      c.fillStyle = "#15171a"; c.beginPath(); c.ellipse(w / 2, 308, 76, 30, 0, Math.PI, 0); c.fill();
      c.lineWidth = 12; c.lineCap = "round"; c.beginPath(); c.moveTo(w / 2, 286); c.quadraticCurveTo(w / 2 - 7, 246, w / 2, 208); c.stroke();
      c.beginPath(); c.moveTo(w / 2, 218); c.bezierCurveTo(w / 2 - 20, 172, w / 2 - 52, 164, w / 2 - 68, 172); c.bezierCurveTo(w / 2 - 60, 206, w / 2 - 30, 224, w / 2, 218); c.fill();
      c.beginPath(); c.moveTo(w / 2, 208); c.bezierCurveTo(w / 2 + 10, 166, w / 2 + 42, 154, w / 2 + 64, 164); c.bezierCurveTo(w / 2 + 56, 198, w / 2 + 28, 214, w / 2, 208); c.fill();
      text("AUTHORISED PLANTING ONLY", w / 2, 398, 50, "#15171a", "center", 900, w - 60);
      text("40 SECONDS IS PLENTY  ·  DO NOT RUN", w / 2, 452, 23, "#15171a", "center", 700, w - 64);
      c.strokeStyle = "#15171a"; c.lineWidth = 4; c.strokeRect(12, 12, w - 24, h - 24);
      screws(w, h, 26); wear(w, h, 0.5);
    });
    cell("keepclear", 512, 256, (w, h) => {
      c.strokeStyle = "#e3b21c"; c.lineWidth = 12;
      for (let i = -h; i < w; i += 44) { c.beginPath(); c.moveTo(i, h); c.lineTo(i + h, 0); c.stroke(); }
      c.clearRect(70, 78, w - 140, 100);
      c.lineWidth = 18; c.strokeRect(9, 9, w - 18, h - 18);
      text("NO CAMPING", w / 2, 116, 62, "#e3b21c", "center", 900, w - 170);
      text("KEEP CLEAR  ·  HOLD YOUR ANGLE ELSEWHERE", w / 2, 160, 17, "#e3b21c", "center", 700, w - 164);
      wear(w, h, 5, true);
    });
    cell("mimic", 1024, 512, (w, h) => {
      c.fillStyle = "#0e181a"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#5d6c70"; c.lineWidth = 4; c.strokeRect(8, 8, w - 16, h - 16);
      text("LP-07  ·  A SITE LOOP  ·  LOCAL MIMIC", 30, 40, 26, "#c8d4d4", "left", 700);
      text("U-1.6 CORE HALL", w - 30, 40, 22, "#7f9195", "right", 700);
      const feed = "#35c4b8", back = "#e59b3a", ink = "#c8d4d4";
      const line = (colour: string, points: number[][]) => { c.strokeStyle = colour; c.lineWidth = 8; c.lineJoin = "round"; c.beginPath(); points.forEach(([px, py], i) => c[i ? "lineTo" : "moveTo"](px, py)); c.stroke(); };
      const valve = (vx: number, vy: number, tag: string) => { c.fillStyle = ink; c.beginPath(); c.moveTo(vx - 16, vy - 12); c.lineTo(vx + 16, vy + 12); c.lineTo(vx + 16, vy - 12); c.lineTo(vx - 16, vy + 12); c.closePath(); c.fill(); text(tag, vx, vy - 28, 16, ink, "center", 700); };
      line(feed, [[420, 190], [250, 190], [250, 300]]); line(feed, [[250, 380], [250, 440], [130, 440]]); line(feed, [[604, 190], [800, 190], [800, 300]]); line(feed, [[800, 380], [800, 440], [900, 440]]);
      line(back, [[130, 300], [130, 120], [512, 120], [512, 150]]); line(back, [[900, 300], [900, 120], [512, 120]]);
      c.strokeStyle = ink; c.lineWidth = 5;
      c.beginPath(); c.roundRect(420, 150, 184, 270, 60); c.stroke(); text("A SITE", 512, 270, 44, ink, "center", 900, 150); text("0:40", 512, 320, 20, "#7f9195", "center", 700);
      for (const [px, tag] of [[250, "P-250"], [800, "P-2000"]] as Array<[number, string]>) { c.beginPath(); c.arc(px, 340, 40, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.moveTo(px - 20, 322); c.lineTo(px + 26, 340); c.lineTo(px - 20, 358); c.closePath(); c.stroke(); text(tag, px < 512 ? px + 56 : px - 56, 340, 20, ink, px < 512 ? "left" : "right", 700); }
      for (const [px, tag] of [[130, "SILO 1"], [900, "SILO 2"]] as Array<[number, string]>) { c.beginPath(); c.roundRect(px - 34, 300, 68, 140, 30); c.stroke(); text(tag, px, 470, 20, ink, "center", 700); }
      valve(330, 190, "SQUEAKY"); valve(700, 190, "HUT"); valve(300, 120, "RAMP"); valve(720, 120, "VENTS");
      c.fillStyle = feed; c.fillRect(366, 474, 30, 8); text("KILL FEED", 406, 479, 16, ink, "left", 700);
      c.fillStyle = back; c.fillRect(516, 474, 30, 8); text("TRADE RETURN", 556, 479, 16, ink, "left", 700);
      wear(w, h, 0.25);
    });
    // Row 2: placards.
    placard("hot", "#e3b21c", "#16130e", "CAUTION", "#e3b21c", "THIS LINE IS LIT, 90", "LOOP 2  ·  290 °C  ·  TAG IT BEFORE YOU TOUCH IT", "#16130e");
    placard("crane", "#e3b21c", "#16130e", "WARNING", "#e3b21c", (w) => {
      font(48);
      const first = c.measureText("HEAVEN").width, second = c.measureText("HELL").width, gap = 14, shaft = 38, between = 46;
      let px = (w - (first + gap + shaft + between + second + gap + shaft)) / 2;
      text("HEAVEN", px, 142, 48, "#16130e", "left"); px += first + gap; arrow(px + shaft / 2, 141, 48, true, "#16130e"); px += shaft + between;
      text("HELL", px, 142, 48, "#16130e", "left"); px += second + gap; arrow(px + shaft / 2, 143, 48, false, "#16130e");
    }, "CHECK BOTH  ·  STAND CLEAR OF SUSPENDED LOADS", "#16130e");
    placard("hatch", "#e9ecea", "#b3261a", "DANGER", "#f2f2ee", "VENTS: NO ENTRY", "YOU WILL ANYWAY  ·  ISOLATE AND VENT FIRST", "#16130e");
    placard("noentry", "#e9ecea", "#b3261a", "NO ENTRY", "#f2f2ee", "NOCLIP IS OFF", "sv_cheats 0 IN THIS HALL  ·  CALL 1337", "#16130e");
    // Row 3: maker's plate, dials, small boards.
    cell("vessel", 512, 256, (w, h) => {
      const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#a9b1b3"); g.addColorStop(0.5, "#8b9496"); g.addColorStop(1, "#a2aaac");
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#2c3234"; c.lineWidth = 3; c.strokeRect(12, 12, w - 24, h - 24);
      text("COBBLESTONE HEAVY WORKS", w / 2, 48, 36, "#1d2224", "center", 900, w - 70);
      c.fillStyle = "#2c3234"; c.fillRect(40, 72, w - 80, 3);
      [["PRESSURE VESSEL", "U-1.6"], ["SERIAL", "1337-K"], ["BUILT", "1999"], ["RATED", "MR12  ·  OVERTIME EXTRA"], ["SHELL", "KEVLAR + HELMET  ·  $1000"]].forEach(([label, value], i) => {
        text(label, 44, 100 + i * 30, 21, "#2c3234", "left", 700); text(value, w - 44, 100 + i * 30, 23, "#1d2224", "right");
      });
      screws(w, h, 24); wear(w, h, 0.4);
    });
    const dial = (key: string, max: number, step: number, unit: string, times = "") => cell(key, 256, 256, (w, h) => {
      c.fillStyle = "#16191a"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#e9e6da"; c.beginPath(); c.arc(128, 128, 124, 0, Math.PI * 2); c.fill();
      const angle = (t: number) => Math.PI * 0.75 + t * Math.PI * 1.5;
      c.strokeStyle = "#b3261a"; c.lineWidth = 12; c.beginPath(); c.arc(128, 128, 98, angle(0.8), angle(1)); c.stroke();
      const majors = max / step;
      for (let i = 0; i <= majors * 5; i += 1) {
        const a = angle(i / (majors * 5)), major = i % 5 === 0;
        c.strokeStyle = "#16191a"; c.lineWidth = major ? 5 : 2;
        c.beginPath(); c.moveTo(128 + Math.cos(a) * (major ? 88 : 96), 128 + Math.sin(a) * (major ? 88 : 96)); c.lineTo(128 + Math.cos(a) * 110, 128 + Math.sin(a) * 110); c.stroke();
        if (major) text(String(i / 5 * step), 128 + Math.cos(a) * 68, 128 + Math.sin(a) * 68, 22, "#16191a");
      }
      text(unit, 128, 176, 26, "#16191a"); text("CHW", 128, 204, 13, "#59605f", "center", 700);
      if (times) text(times, 128, 150, 15, "#16191a", "center", 700);
    });
    // One gauge reads the bank in thousands, which stops at sixteen; the other reads health.
    dial("dial", 16, 2, "$", "× 1000"); dial("dialT", 100, 10, "HP");
    cell("eyewash", 256, 256, (w, h) => {
      c.fillStyle = "#1c8448"; c.fillRect(0, 0, w, h); c.strokeStyle = "#f2f2ee"; c.lineWidth = 8; c.strokeRect(12, 12, w - 24, h - 24);
      c.fillStyle = "#f2f2ee"; c.beginPath(); c.moveTo(128, 30); c.bezierCurveTo(165, 80, 170, 101, 128, 127); c.bezierCurveTo(86, 101, 91, 80, 128, 30); c.fill();
      c.lineWidth = 7; c.beginPath(); c.ellipse(128, 148, 54, 14, 0, 0, Math.PI); c.stroke();
      text("FLASHED?", 128, 194, 38, "#f2f2ee", "center", 900, w - 48);
      text("EYEWASH  ·  TEAM FLASHES INCLUDED", 128, 224, 13, "#f2f2ee", "center", 700, w - 48); wear(w, h, 0.4);
    });
    cell("fire", 256, 256, (w, h) => {
      c.fillStyle = "#b3261a"; c.fillRect(0, 0, w, h); c.strokeStyle = "#f2f2ee"; c.lineWidth = 8; c.strokeRect(12, 12, w - 24, h - 24);
      text("TAKING FIRE?", 128, 56, 40, "#f2f2ee", "center", 900, w - 60); text("07", 128, 146, 124, "#f2f2ee"); text("NEED ASSISTANCE  ·  PULL THE PIN", 128, 224, 20, "#f2f2ee", "center", 700, w - 48); wear(w, h, 0.4);
    });
    cell("ear", 256, 256, (w, h) => {
      c.fillStyle = "#e9ecea"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#1d5fa8"; c.beginPath(); c.arc(128, 98, 86, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#f2f2ee"; c.lineWidth = 12; c.beginPath(); c.arc(128, 100, 46, Math.PI, 0); c.stroke();
      c.fillStyle = "#f2f2ee"; c.beginPath(); c.roundRect(66, 92, 30, 52, 10); c.fill(); c.beginPath(); c.roundRect(160, 92, 30, 52, 10); c.fill();
      // A boom microphone makes the ear defenders a headset.
      c.lineWidth = 6; c.lineCap = "round"; c.beginPath(); c.moveTo(81, 144); c.quadraticCurveTo(84, 166, 116, 164); c.stroke();
      c.beginPath(); c.roundRect(112, 157, 24, 14, 7); c.fill();
      text("HEADSET REQUIRED", 128, 204, 25, "#16191a", "center", 900, w - 30);
      text("FOOTSTEPS ARE INFORMATION", 128, 232, 14, "#16191a", "center", 700, w - 30); wear(w, h, 0.4);
    });
    cell("tag", 128, 256, (w, h) => {
      c.fillStyle = "#e3b21c"; c.fillRect(0, 0, w, h); c.fillStyle = "#16130e"; c.beginPath(); c.arc(64, 26, 10, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#b3261a"; c.fillRect(8, 50, w - 16, 84); text("DO NOT", 64, 76, 28, "#f2f2ee"); text("DEFUSE", 64, 110, 28, "#f2f2ee");
      text("NO KIT  0:10", 64, 164, 17, "#16130e", "center", 700); text("KIT  0:05", 64, 192, 17, "#16130e", "center", 700);
      c.fillStyle = "#16130e"; c.fillRect(14, 214, w - 28, 2); c.fillRect(14, 234, w - 28, 2);
    });
    // Row 4: pipe markers, then the floor stencil.
    for (const [key, ground, label] of [["feed", "#0f6f6c", "KILL FEED"], ["return", "#c06812", "TRADE RETURN"], ["air", "#59626a", "CLEAR COMMS · 7 bar"]]) cell(key, 512, 96, (w, h) => {
      c.fillStyle = ground; c.fillRect(0, 0, w, h);
      text(label, 24, h / 2 + 2, 44, "#f2f2ee", "left", 900, w - 136);
      c.fillStyle = "#f2f2ee"; c.beginPath(); c.moveTo(w - 96, 22); c.lineTo(w - 30, h / 2); c.lineTo(w - 96, h - 22); c.closePath(); c.fill();
      wear(w, h, 0.5);
    });
    cell("laydown", 512, 256, (w, h) => {
      c.strokeStyle = "#dfe8e7"; c.lineWidth = 10; c.setLineDash([46, 22]); c.strokeRect(8, 8, w - 16, h - 16); c.setLineDash([]);
      text("SECRET", w / 2, 104, 84, "#dfe8e7");
      text("CLEARLY SIGNPOSTED  ·  MAX 5 t/m²", w / 2, 186, 25, "#dfe8e7", "center", 700, w - 60);
      wear(w, h, 5, true);
    });
    // Row 5: the engraved nameplates, six to a row and three deep, with the bands for the gas cylinders beside them.
    x = 0; y += rowH; rowH = 0;
    ["BUY MENU", "ROUND LOGIC", "CONSOLE", "KEVLAR", "HELMET", "KIT  $400", "BANK $", "TEAM HP", "LOSS BONUS", "FORCE BUY", "NET_GRAPH 1", "FPS_MAX 0", "UTILITY", "SILO 1", "SILO 2", "P-250", "P-2000"].forEach((name, i) => cellAt(name, (i % 6) * 256, y + Math.floor(i / 6) * 64, 256, 64, (w, h) => {
      c.fillStyle = "#0f1213"; c.fillRect(0, 0, w, h); c.strokeStyle = "#c9d1d2"; c.lineWidth = 3; c.strokeRect(6, 6, w - 12, h - 12);
      text(name, w / 2, h / 2 + 2, 32, "#e6ecec", "center", 900, w - 30);
    }));
    x = 6 * 256; rowH = 3 * 64;
    for (const [key, gas, code, colour] of [["gasAr", "SMOKE", "ONE-WAY VALVE FITTED  ·  18 s", "#14695f"], ["gasHe", "HE", "HELIUM. NOT THE GRENADE.", "#8a4a12"]]) cell(key, 256, 96, (w, h) => {
      c.fillStyle = "#e4e6e0"; c.fillRect(0, 0, w, h);
      c.fillStyle = colour; c.fillRect(0, 0, w, 16);
      text("UTILITY GAS  ·  COMPRESSED  ·  200 bar", 12, 9, 10, "#f2f2ee", "left", 700);
      text(gas, 12, 48, 46, "#15171a", "left");
      text(code, 12, 80, 13, "#15171a", "left", 700, w - 76);
      c.save(); c.translate(w - 38, 56); c.rotate(Math.PI / 4); c.fillStyle = "#1f7a3a"; c.fillRect(-21, -21, 42, 42); c.strokeStyle = "#f2f2ee"; c.lineWidth = 2; c.strokeRect(-18, -18, 36, 36); c.restore();
      text("2", w - 38, 68, 15, "#f2f2ee");
      wear(w, h, 0.6);
    });
    // Last row: paint for the storage bays on the floor.
    cell("bayline", 256, 32, (w, h) => { c.fillStyle = "#e0ac1a"; c.fillRect(0, 0, w, h); wear(w, h, 7, true); });
    for (const [key, name, rule] of [["bayD", "UTILITY STORE", "MAX 4  ·  ONE OF EACH KIND  ·  LABELS OUT"], ["bayP", "TRIPLE STACK", "MAX 1.0 t  ·  NO BOOSTING ON THE CRATES"]]) cell(key, 384, 64, (w, h) => {
      text(name, 8, 25, 42, "#e0ac1a", "left", 900, w - 16);
      text(rule, 10, 53, 15, "#e0ac1a", "left", 700, w - 18);
      wear(w, h, 5, true);
    });
  });
  return { texture, rects, aspect };
}

/** Board-marked concrete, 4.8 m square: 2.4 x 1.2 m shutter panels, tie holes, pour lines and run-off. */
function formworkTexture() {
  return canvasTexture(2048, 2048, (context) => {
    context.scale(2, 2);
    let seed = 4177;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const panelW = 512, panelH = 256;
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 2; column += 1) {
      const tone = 150 + Math.round(next() * 26);
      context.fillStyle = `rgb(${tone - 5},${tone + 1},${tone + 2})`;
      context.fillRect(column * panelW, row * panelH, panelW, panelH);
    }
    // Mottle and pour lines.
    for (let i = 0; i < 2600; i += 1) {
      const shade = next() > 0.5 ? 255 : 0, size = 6 + next() * 46;
      context.fillStyle = `rgba(${shade},${shade},${shade},${0.012 + next() * 0.022})`;
      context.beginPath(); context.ellipse(next() * 1024, next() * 1024, size * 1.8, size * 0.6, 0, 0, Math.PI * 2); context.fill();
    }
    for (let i = 0; i < 9000; i += 1) {
      const shade = next() > 0.6 ? 235 : 30;
      context.fillStyle = `rgba(${shade},${shade},${shade},.07)`;
      context.fillRect(next() * 1024, next() * 1024, 1 + next() * 2, 1 + next() * 2);
    }
    // Run-off stains falling from the panel joints.
    for (let i = 0; i < 46; i += 1) {
      const x = next() * 1024, y = Math.floor(next() * 4) * panelH, length = 40 + next() * 170, width = 2 + next() * 9;
      const gradient = context.createLinearGradient(0, y, 0, y + length);
      gradient.addColorStop(0, `rgba(30,36,36,${0.1 + next() * 0.14})`);
      gradient.addColorStop(1, "rgba(30,36,36,0)");
      context.fillStyle = gradient;
      context.fillRect(x, y, width, length);
    }
    // Shutter joints: a dark arris with a light fin beside it.
    for (let row = 0; row < 4; row += 1) {
      context.fillStyle = "rgba(24,28,28,.62)"; context.fillRect(0, row * panelH, 1024, 3);
      context.fillStyle = "rgba(235,240,240,.2)"; context.fillRect(0, row * panelH + 3, 1024, 2);
    }
    for (let column = 0; column < 2; column += 1) {
      context.fillStyle = "rgba(24,28,28,.62)"; context.fillRect(column * panelW, 0, 3, 1024);
      context.fillStyle = "rgba(235,240,240,.2)"; context.fillRect(column * panelW + 3, 0, 2, 1024);
    }
    // Tie holes, two per panel, each with a faint weep below.
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const x = 128 + column * 256, y = row * panelH + 128;
      const weep = context.createLinearGradient(0, y, 0, y + 90);
      weep.addColorStop(0, "rgba(40,44,44,.22)"); weep.addColorStop(1, "rgba(40,44,44,0)");
      context.fillStyle = weep; context.fillRect(x - 4, y, 8, 90);
      context.fillStyle = "rgba(225,230,230,.25)"; context.beginPath(); context.arc(x, y + 1.5, 9.5, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#1b1f1f"; context.beginPath(); context.arc(x, y, 7.5, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#34393a"; context.beginPath(); context.arc(x, y + 2, 4.5, 0, Math.PI * 2); context.fill();
    }
  }, true);
}

/** Bar grating with see-through cells: 25 mm bearing bars at 50 mm, cross rods at 100 mm. One tile is 0.2 m. */
function gratingTexture() {
  return canvasTexture(256, 256, (context) => {
    context.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 4; i += 1) {
      const x = i * 64;
      context.fillStyle = "#2f3739"; context.fillRect(x, 0, 27, 256);
      context.fillStyle = "#566367"; context.fillRect(x + 3, 0, 9, 256);
      context.fillStyle = "#7d8c90"; context.fillRect(x + 5, 0, 3, 256);
    }
    for (let i = 0; i < 2; i += 1) {
      const y = i * 128;
      context.fillStyle = "#293032"; context.fillRect(0, y, 256, 20);
      context.fillStyle = "#4a5659"; context.fillRect(0, y + 3, 256, 6);
    }
  }, true);
}

/** Black and amber chevron band with scuffs, four stripes to a tile. */
function hazardStripes() {
  const texture = canvasTexture(1024, 256, (context) => {
    context.fillStyle = "#d98a2b";
    context.fillRect(0, 0, 1024, 256);
    context.fillStyle = "#14110d";
    for (let x = -256; x < 1024; x += 256) {
      context.beginPath(); context.moveTo(x, 256); context.lineTo(x + 128, 256); context.lineTo(x + 384, 0); context.lineTo(x + 256, 0); context.closePath(); context.fill();
    }
    let seed = 77;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 2400; i += 1) {
      const shade = 30 + Math.round(next() * 90);
      context.fillStyle = `rgba(${shade},${shade},${shade},${0.12 + next() * 0.3})`;
      context.fillRect(next() * 1024, next() * 256, 2 + next() * 12, 1 + next() * 2);
    }
    for (let i = 0; i < 26; i += 1) {
      context.fillStyle = `rgba(20,18,14,${0.1 + next() * 0.16})`;
      context.beginPath(); context.ellipse(next() * 1024, next() * 256, 10 + next() * 46, 4 + next() * 14, next() * 3, 0, Math.PI * 2); context.fill();
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

/** Worn stencil paint on a clear ground. */
function stencilTexture(width: number, height: number, colour: string, lines: Array<{ text: string; size: number; y: number; x?: number; align?: CanvasTextAlign }>, wear = 0.3) {
  const texture = canvasTexture(width, height, (context) => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = colour;
    context.textBaseline = "middle";
    for (const line of lines) {
      // A line too long for the sheet is set smaller rather than cut off at the edge.
      const align = line.align ?? "center", room = align === "left" ? width - (line.x ?? 0) - 16 : align === "right" ? (line.x ?? width) - 16 : width - 24;
      let size = line.size;
      context.font = `900 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
      while (size > 12 && context.measureText(line.text).width > room) { size -= 2; context.font = `900 ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; }
      context.textAlign = align;
      context.fillText(line.text, line.x ?? width / 2, line.y);
    }
    // Stencil bridges, then scuffing.
    context.globalCompositeOperation = "destination-out";
    let seed = width * 31 + height;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < width * height * wear * 0.012; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.25 + next() * 0.6})`;
      context.fillRect(next() * width, next() * height, 1 + next() * 5, 1 + next() * 2);
    }
    for (let i = 0; i < 60 * wear; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.15 + next() * 0.3})`;
      context.beginPath(); context.ellipse(next() * width, next() * height, 6 + next() * 30, 3 + next() * 12, next() * 3, 0, Math.PI * 2); context.fill();
    }
    context.globalCompositeOperation = "source-over";
  });
  return texture;
}

/** Three sheets of paper for the notice board, side by side. */
function noticeTexture() {
  const sheetW = 256, sheetH = 362;
  return canvasTexture(sheetW * 3, sheetH, (c) => {
    const font = (px: number, weight: number) => { c.font = `${weight} ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; };
    const line = (value: string, x: number, y: number, px: number, weight = 700, colour = "#1b1d1e") => {
      font(px, weight);
      for (let size = px; size > 9 && c.measureText(value).width > sheetW - 36; size -= 1) font(size - 1, weight);
      c.fillStyle = colour; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(value, x, y);
    };
    const sheets: Array<[ground: string, draw: (x: number) => void]> = [
      ["#cfccc0", (x) => {
        c.fillStyle = "#1b1d1e"; c.fillRect(x - 110, 32, 220, 44); line("TOOLBOX TALK", x, 55, 30, 900, "#cfccc0");
        line("STICK TOGETHER,", x, 130, 34, 900); line("TEAM", x, 172, 34, 900);
        line("Thursday, in the Hut.", x, 238, 19); line("Bring a mug. Knock first.", x, 264, 19);
        line("Shift supervisor", x, 326, 13, 400);
      }],
      ["#d3c27a", (x) => {
        line("LOST", x, 76, 84, 900);
        line("One knife. Very colourful.", x, 152, 21);
        line("The owner says it is worth", x, 202, 18); line("more than the crane.", x, 226, 18);
        line("We have checked. It is.", x, 278, 18, 900);
        line("Hand in at the desk", x, 328, 13, 400);
      }],
      ["#cfccc0", (x) => {
        line("PA TEST", x, 66, 54, 900); line("FRIDAY, NOON", x, 110, 22);
        line("If you hear", x, 168, 20); line("“GO GO GO”", x, 208, 44, 900); line("do not go.", x, 252, 22);
        line("It is only a test.", x, 324, 14, 400);
      }],
    ];
    sheets.forEach(([ground, draw], i) => {
      c.fillStyle = ground; c.fillRect(i * sheetW, 0, sheetW, sheetH);
      draw(i * sheetW + sheetW / 2);
      // A pin at the head of each sheet.
      c.fillStyle = "#b3261a"; c.beginPath(); c.arc(i * sheetW + sheetW / 2, 14, 6, 0, Math.PI * 2); c.fill();
    });
  });
}

/** Prismatic diffuser cells for the roof slots. */
function diffuserTexture() {
  return canvasTexture(2048, 512, (context) => {
    let seed = 913;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let column = 0; column < 16; column += 1) for (let row = 0; row < 4; row += 1) {
      const tone = 214 + Math.round(next() * 41);
      context.fillStyle = `rgb(${tone - 22},${tone - 6},${tone})`;
      context.fillRect(column * 128, row * 128, 128, 128);
      // The lamp battens behind each panel show through as two brighter bands; dust gathers in the corners.
      const bands = context.createLinearGradient(0, row * 128, 0, row * 128 + 128);
      bands.addColorStop(0.12, "rgba(255,255,255,0)"); bands.addColorStop(0.3, "rgba(255,255,255,.2)"); bands.addColorStop(0.5, "rgba(255,255,255,0)");
      bands.addColorStop(0.7, "rgba(255,255,255,.2)"); bands.addColorStop(0.88, "rgba(255,255,255,0)");
      context.fillStyle = bands; context.fillRect(column * 128, row * 128, 128, 128);
      const dust = context.createRadialGradient(column * 128 + 64, row * 128 + 64, 40, column * 128 + 64, row * 128 + 64, 96);
      dust.addColorStop(0, "rgba(40,60,70,0)"); dust.addColorStop(1, `rgba(40,60,70,${0.1 + next() * 0.14})`);
      context.fillStyle = dust; context.fillRect(column * 128, row * 128, 128, 128);
    }
    context.fillStyle = "rgba(48,66,76,.7)";
    for (let column = 0; column <= 16; column += 1) context.fillRect(column * 128 - 3, 0, 6, 512);
    for (let row = 0; row <= 4; row += 1) context.fillRect(0, row * 128 - 3, 2048, 6);
  });
}

/** Handwheel on a stem: wheel in the YZ plane at the origin, stem running back along -x. */
function valveWheelGeometry(radius: number) {
  const rim = new THREE.TorusGeometry(radius, radius * 0.11, 8, 28);
  rim.rotateY(Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [rim];
  for (let i = 0; i < 3; i += 1) {
    const spoke = new THREE.BoxGeometry(radius * 0.12, radius * 2, radius * 0.12);
    spoke.rotateX(i * Math.PI / 3);
    parts.push(spoke);
  }
  const stem = new THREE.CylinderGeometry(radius * 0.14, radius * 0.14, radius * 1.7, 10);
  stem.rotateZ(Math.PI / 2);
  stem.translate(-radius * 0.85, 0, 0);
  parts.push(stem);
  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  return merged;
}

/** Shielded transfer cask standing on y = 0. */
function caskGeometry() {
  const profile = [
    [0, 0], [0.6, 0], [0.64, 0.04], [0.64, 0.2], [0.58, 0.24], [0.58, 0.5], [0.62, 0.53], [0.62, 0.6], [0.58, 0.63],
    [0.58, 1.1], [0.62, 1.13], [0.62, 1.2], [0.58, 1.23], [0.58, 1.44], [0.66, 1.48], [0.66, 1.62], [0.6, 1.66], [0.24, 1.68], [0.22, 1.74], [0, 1.74],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  // The shell is hollow; a disc inside it (never seen) lets the floor plan read the cask as a solid thing.
  const shell = scaleUv(new THREE.LatheGeometry(profile, 36), 3, 2), core = new THREE.CircleGeometry(0.56, 18).rotateX(-Math.PI / 2).translate(0, 0.8, 0);
  const merged = mergeGeometries([shell, core]);
  shell.dispose(); core.dispose();
  return merged;
}

export function buildReactor(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet } = kit;
  const metals = kit.metals();

  // Everything static is baked into one mesh per material (and per shadow / hit / fine class),
  // so the detail costs triangles, not draw calls. "fine" parts are skipped on PERFORMANCE
  // and left out of the floor mirror.
  type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean };
  type Batch = { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] };
  const batches = new Map<string, Batch>();
  // A rig is a group that moves (the bridge crane, its hook block, its pendant): parts put while one is
  // open are merged per material into meshes of that group instead of the hall's.
  const rigs = new Map<THREE.Group, Map<string, Batch>>();
  let into = batches;
  const openRig = (group: THREE.Group | null) => {
    if (group && !rigs.has(group)) rigs.set(group, new Map());
    into = (group && rigs.get(group)) || batches;
  };
  const pending: Array<() => void> = [];
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4, opt: Opt = {}) => {
    const fine = opt.fine ?? false;
    if (fine && !high) return;
    const full = { shadow: !fine && (opt.shadow ?? false), hit: !fine && (opt.hit ?? false), fine };
    const key = `${material.uuid}|${+full.shadow}${+full.hit}${+full.fine}`;
    let batch = into.get(key);
    if (!batch) into.set(key, batch = { material, opt: full, parts: [] });
    const part = new THREE.BufferGeometry();
    const count = geometry.attributes.position.count;
    part.setAttribute("position", geometry.attributes.position.clone());
    part.setAttribute("normal", geometry.attributes.normal.clone());
    part.setAttribute("uv", geometry.attributes.uv ? geometry.attributes.uv.clone() : new THREE.Float32BufferAttribute(count * 2, 2));
    part.setIndex(geometry.index ? geometry.index.clone() : Array.from({ length: count }, (_, i) => i));
    part.applyMatrix4(matrix);
    batch.parts.push(part);
  };
  /** Adds parts in the local space of `matrix`. */
  const frame = (matrix: THREE.Matrix4, base: Opt = {}) =>
    (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, rotation?: V3, scale?: V3, opt?: Opt) =>
      put(geometry, material, matrix.clone().multiply(mat4(x, y, z, rotation, scale)), { ...base, ...opt });
  const world = frame(new THREE.Matrix4());
  const fineWorld = frame(new THREE.Matrix4(), { fine: true });
  const flush = () => {
    pending.forEach((run) => run());
    for (const batch of batches.values()) {
      const merged = mergeGeometries(batch.parts);
      batch.parts.forEach((part) => part.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.castShadow = batch.opt.shadow;
      mesh.receiveShadow = true;
      scene.add(mesh);
      if (batch.opt.hit) kit.shootable.push(mesh);
      if (batch.opt.fine) kit.mirrorHidden.push(mesh);
    }
    for (const [group, own] of rigs) {
      group.updateWorldMatrix(true, false);
      const toGroup = group.matrixWorld.clone().invert();
      for (const batch of own.values()) {
        const merged = mergeGeometries(batch.parts);
        batch.parts.forEach((part) => part.dispose());
        if (!merged) continue;
        // Nothing that moves casts a sun shadow: the sun's map is rendered once. Only the painted steel
        // is big enough to be worth drawing again in the floor mirror.
        const mesh = new THREE.Mesh(merged.applyMatrix4(toGroup), batch.material);
        mesh.receiveShadow = true;
        mesh.userData.walkThrough = true;
        group.add(mesh);
        if (batch.material !== cranePaint) kit.mirrorHidden.push(mesh);
      }
    }
  };
  const place = (mesh: THREE.Mesh, x: number, y: number, z: number, shadow = true, hit = false) => {
    const material = mesh.material as THREE.Material;
    if (material.transparent) return kit.place(mesh, x, y, z, shadow, hit);
    mesh.position.set(x, y, z);
    const target = into;
    pending.push(() => { const open = into; into = target; mesh.updateMatrix(); put(mesh.geometry, material, mesh.matrix, { shadow, hit }); into = open; });
    return mesh;
  };
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], hit = true, shadow = true) => {
    for (const transform of transforms) put(geometry, material, mat4(...transform.position, transform.rotation, transform.scale), { shadow, hit });
  };
  /** Frame on a side wall: local x runs along the wall, local z points into the hall. */
  const wallFrame = (side: number, z: number, opt: Opt = {}) => frame(mat4(side * WALL_X, 0, z, [0, -side * Math.PI / 2, 0]), opt);
  const at = (x: number, y: number, z: number, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): Transform => ({ position: [x, y, z], rotation, scale });
  const sides = [-1, 1];

  // ---- Fixture light -------------------------------------------------------
  // The hall's practicals (wash tubes under the catwalks, the kerb status strips, the bulkhead lamps on
  // the upper walls and round the shield) are far too many to be light objects. Their light is added
  // analytically in the shaders of the surfaces around them, so walls, floor and pipework are lit by
  // the fittings you can see, with distance falloff and facing, at no cost in lights.
  const glsl = (value: number) => value.toFixed(3);
  /** x: metres the kerb pulse has run this cycle. y: level of the failing wash tube. */
  const practicalLive = { value: new THREE.Vector3(0, 1, 0) };
  const chaseGlsl = /* glsl */`
    // A pulse runs down each kerb strip from the back wall to the vessel end, the two walls half a beat apart.
    float kerbChase(float z, float side, float run) {
      float behind = z - (${glsl(BACK_Z)} - mod(run + (side < 0.0 ? 0.0 : ${glsl(CHASE.span / 2)}), ${glsl(CHASE.span)}));
      return smoothstep(-0.3, 0.0, behind) * exp(-max(behind, 0.0) * 0.5);
    }`;
  const practicalGlsl = /* glsl */`
    uniform vec3 practicalLive;
    ${chaseGlsl}
    const vec3 PRACTICAL_SHIELD[4] = vec3[4](${SHIELD_LAMPS.map((a) => `vec3(${glsl(CORE.x + Math.sin(a) * 6.34)}, 1.75, ${glsl(CORE.z + Math.cos(a) * 6.34)})`).join(", ")});
    vec3 practicalLight(vec3 p, vec3 n) {
      vec3 sum = vec3(0.0);
      float side = p.x < 0.0 ? -1.0 : 1.0;
      // Wash tubes: 2.3 m long every 3 m, shielded from above by their housings.
      vec2 toTube = vec2(side * ${glsl(WASH.x)} - p.x, ${glsl(WASH.y)} - p.y);
      float tube = length(toTube) + 0.08;
      float nearest = 6.5 - 3.0 * clamp(floor((6.5 - p.z) / 3.0 + 0.5), 0.0, 11.0);
      float reach = 1.0 - smoothstep(1.05, 1.3 + tube * 0.9, abs(p.z - nearest));
      float under = smoothstep(-0.15, 0.3, toTube.y / tube);
      float washFacing = max(dot(n.xy, toTube) / tube + 0.25, 0.0) / 1.25;
      float failing = side < 0.0 && abs(nearest - ${glsl(FAIL_TUBE_Z)}) < 0.2 ? practicalLive.y : 1.0;
      sum += vec3(0.76, 0.9, 1.0) * (1.25 * failing * washFacing * reach * under / tube) * (1.0 - smoothstep(3.5, 9.0, tube));
      // Kerb status strips: amber along the west wall, mint along the east.
      vec2 toStrip = vec2(side * 9.44 - p.x, 0.44 - p.y);
      float strip = length(toStrip) + 0.06;
      float stripFacing = max(dot(n.xy, toStrip) / strip + 0.3, 0.0) / 1.3;
      sum += (side < 0.0 ? vec3(1.0, 0.5, 0.14) : vec3(0.3, 1.0, 0.82)) * (0.22 * (1.0 + 2.4 * kerbChase(p.z, side, practicalLive.x)) * stripFacing / strip) * (1.0 - smoothstep(1.0, 3.4, strip));
      // Bulkhead lamps on the upper walls.
      float bay = clamp(floor((${glsl(LAMP.z0)} - p.z) / ${glsl(LAMP.pitch)} + 0.5), 0.0, ${glsl(LAMP.count - 1)});
      vec3 toLamp = vec3(side * 9.46, ${glsl(LAMP.y)}, ${glsl(LAMP.z0)} - ${glsl(LAMP.pitch)} * bay) - p;
      float lamp = dot(toLamp, toLamp);
      float lampFacing = max(dot(n, toLamp) * inversesqrt(lamp + 0.0001) + 0.3, 0.0) / 1.3;
      sum += vec3(1.0, 0.55, 0.2) * (1.5 * lampFacing / (lamp + 0.12)) * (1.0 - smoothstep(2.5, 6.0, sqrt(lamp)));
      // Lamps round the shield.
      if (p.z < -27.0) for (int i = 0; i < 4; i++) {
        vec3 toShield = PRACTICAL_SHIELD[i] - p;
        float shield = dot(toShield, toShield);
        float shieldFacing = max(dot(n, toShield) * inversesqrt(shield + 0.0001) + 0.3, 0.0) / 1.3;
        sum += vec3(1.0, 0.55, 0.2) * (1.5 * shieldFacing / (shield + 0.12)) * (1.0 - smoothstep(2.5, 6.0, sqrt(shield)));
      }
      return sum;
    }`;
  const practical = <T extends THREE.MeshStandardMaterial>(material: T): T => {
    const before = material.onBeforeCompile, key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before.call(material, shader, renderer);
      shader.uniforms.practicalLive = practicalLive;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vPracticalWorld;")
        .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
          vec4 practicalPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            practicalPosition = instanceMatrix * practicalPosition;
          #endif
          vPracticalWorld = (modelMatrix * practicalPosition).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vPracticalWorld;\n${practicalGlsl}`)
        .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directDiffuse += practicalLight(vPracticalWorld, inverseTransformDirection(normal, viewMatrix)) * material.diffuseContribution;");
    };
    material.customProgramCacheKey = () => `${key}|reactor-practical`;
    return material;
  };
  (["structural", "darkMetal", "brushed", "machine"] as const).forEach((name) => practical(metals[name]));

  // ---- Materials -----------------------------------------------------------
  const slab = photoSet("/textures/concrete_floor_worn_001-2k", 40 / 4.2, 66 / 4.2);
  // Photographed board-marked concrete at 2.4 m a tile, with the 4.8 m shutter-panel sheet
  // (joints, tie holes, run-off) multiplied over it.
  const cast = photoSet("/textures/concrete_wall_007-2k", 2, 2, false);
  const formwork = track(formworkTexture());
  formwork.anisotropy = anisotropy;
  formwork.colorSpace = THREE.NoColorSpace;
  const jointMap = { value: formwork };
  const concreteMaterial = (color: number, envMapIntensity = 0.5) => {
    const material = new THREE.MeshStandardMaterial({ ...cast, normalScale: new THREE.Vector2(0.9, 0.9), color, roughness: 1, metalness: 0, envMapIntensity });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.jointMap = jointMap;
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <map_pars_fragment>", "#include <map_pars_fragment>\nuniform sampler2D jointMap;")
        .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb *= texture2D(jointMap, vMapUv * 0.5).rgb * 1.75;");
    };
    material.customProgramCacheKey = () => "reactor-formwork";
    return practical(material);
  };
  const concrete = concreteMaterial(0xc4cbca);
  const roofConcrete = concreteMaterial(0x9aa3a3, 0.4);
  const shieldConcrete = concreteMaterial(0xb3bcbb, 0.55);

  const wainscot = practical(pbrMaterial(keep(paintedSteel(anisotropy, [0.075, 0.105, 0.12], 611, 0.35)), { envMapIntensity: 0.9 }));
  const cranePaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.52, 0.31, 0.03], 621, 0.42)), { envMapIntensity: 0.85 });
  const vesselPaint = pbrMaterial(keep(tile(paintedSteel(anisotropy, [0.36, 0.44, 0.45], 631, 0.3), 10, 3)), { envMapIntensity: 1 });
  const tealPaint = practical(pbrMaterial(keep(paintedSteel(anisotropy, [0.035, 0.3, 0.3], 641, 0.4, 512)), { envMapIntensity: 1 }));
  const amberPaint = practical(pbrMaterial(keep(paintedSteel(anisotropy, [0.66, 0.3, 0.04], 651, 0.4, 512)), { envMapIntensity: 1 }));
  const greyPaint = practical(pbrMaterial(keep(paintedSteel(anisotropy, [0.33, 0.37, 0.38], 661, 0.45, 512)), { envMapIntensity: 1 }));
  const lead = practical(pbrMaterial(keep(steel(anisotropy, [0.2, 0.215, 0.24], 0.52, 83, 256)), { envMapIntensity: 0.9 }));
  const insulation = practical(pbrMaterial(keep(tile(brushedMetal(anisotropy, [0.56, 0.6, 0.62], 91), 6, 3)), { envMapIntensity: 1.1 }));
  const yellowPaint = practical(pbrMaterial(keep(paintedSteel(anisotropy, [0.74, 0.5, 0.03], 681, 0.4, 512)), { envMapIntensity: 1 }));
  const redPaint = practical(new THREE.MeshStandardMaterial({ color: 0xb8301c, roughness: 0.45, metalness: 0.2, envMapIntensity: 0.9 }));
  const whitePaint = practical(new THREE.MeshStandardMaterial({ color: 0xd9e0e0, roughness: 0.5, metalness: 0.1, envMapIntensity: 0.8 }));
  const copper = practical(pbrMaterial(keep(brushedMetal(anisotropy, [0.8, 0.4, 0.2], 97, 256)), { envMapIntensity: 1.2 }));
  // Photographed plant finishes: chequer plate underfoot, old green enamel on cabinets and pump
  // casings, rust-bloomed galvanised sheet on ducts and trays.
  const chequer = practical(new THREE.MeshStandardMaterial({ ...photoSet("/textures/metal_plate-2k", 1, 1, false), color: new THREE.Color(1.5, 1.65, 1.7), metalness: 0.7, roughness: 1, envMapIntensity: 0.9 }));
  const oldGreen = practical(new THREE.MeshStandardMaterial({ ...photoSet("/textures/green_metal_rust-2k", 1, 1, false), color: new THREE.Color(2.1, 2.2, 2.1), metalness: 0.12, roughness: 1, envMapIntensity: 0.9 }));
  const galvanised = practical(new THREE.MeshStandardMaterial({ ...photoSet("/textures/rusty_metal_02-2k", 1, 1, false), color: 0xb4c0c4, metalness: 0.55, roughness: 1, envMapIntensity: 0.9 }));
  const cable = new THREE.MeshStandardMaterial({ color: 0x0b0d0f, roughness: 0.55, metalness: 0 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.8, metalness: 0 });

  const hazard = track(hazardStripes());
  hazard.anisotropy = anisotropy;
  const hazardCopy = (x: number, y: number, wrapT = false) => {
    const copy = track(hazard.clone());
    copy.needsUpdate = true;
    if (wrapT) copy.wrapT = THREE.RepeatWrapping;
    copy.repeat.set(x, y);
    return copy;
  };
  const hazardMaterial = (x: number, y: number, wrapT = false) => practical(new THREE.MeshStandardMaterial({ map: hazardCopy(x, y, wrapT), roughness: 0.45, metalness: 0, envMapIntensity: 0.8 }));

  const glowWhite = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xdcefff).multiplyScalar(3), toneMapped: false });
  const ledAmber = new THREE.MeshBasicMaterial({ color: new THREE.Color(STRIKE_ORANGE).multiplyScalar(2.4), toneMapped: false });
  const ledMint = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(2.2), toneMapped: false });
  const coreGlow = new THREE.MeshBasicMaterial({ color: CORE_CYAN.clone().multiplyScalar(3), toneMapped: false });
  const portGlow = new THREE.MeshBasicMaterial({ color: CORE_CYAN.clone().multiplyScalar(3), toneMapped: false });
  const ledRed = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.12, 0.08).multiplyScalar(2.2), toneMapped: false });
  const lampWarm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.6, 0.24).multiplyScalar(3), toneMapped: false });
  const levelGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(0.9), toneMapped: false });
  const atlas = signAtlas();
  track(atlas.texture).anisotropy = anisotropy;
  const signMaterial = practical(new THREE.MeshStandardMaterial({ map: atlas.texture, emissive: 0xffffff, emissiveMap: atlas.texture, emissiveIntensity: 0.07, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const remap = <T extends THREE.BufferGeometry>(geometry: T, key: string): T => {
    const [u0, v0, u1, v1] = atlas.rects[key], uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return geometry;
  };
  /** Flat plate carrying one atlas entry, facing +z. */
  const sign = (key: string, width: number) => remap(new THREE.PlaneGeometry(width, width / atlas.aspect[key]), key);
  /** Marker wrapped part-way round a pipe whose axis is z; text runs along the pipe. */
  const pipeLabel = (key: string, radius: number, length: number, phi0: number, arc: number, flipU: boolean, flipV: boolean, vertical = false) => {
    const [u0, v0, u1, v1] = atlas.rects[key], n = 8, position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
    for (let i = 0; i <= n; i += 1) for (const end of [0, 1]) {
      const phi = phi0 + (i / n - 0.5) * arc;
      position.push(Math.cos(phi) * radius, Math.sin(phi) * radius, (end - 0.5) * length);
      normal.push(Math.cos(phi), Math.sin(phi), 0);
      uv.push(u0 + (flipU ? 1 - end : end) * (u1 - u0), v0 + (flipV ? 1 - i / n : i / n) * (v1 - v0));
    }
    for (let i = 0; i < n; i += 1) { const a = i * 2; index.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    if (vertical) geometry.rotateX(-Math.PI / 2);
    return geometry;
  };
  /** Label wrapped round an upright cylinder, centred on the direction `phi` (0 faces +z, a quarter turn faces +x). */
  const wrapLabel = (key: string, radius: number, height: number, phi: number, arc: number) => {
    const [u0, v0, u1, v1] = atlas.rects[key], n = 10, position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [];
    for (let i = 0; i <= n; i += 1) for (const top of [0, 1]) {
      const a = phi + (i / n - 0.5) * arc;
      position.push(Math.sin(a) * radius, (top - 0.5) * height, Math.cos(a) * radius);
      normal.push(Math.sin(a), 0, Math.cos(a));
      uv.push(u0 + (i / n) * (u1 - u0), v0 + top * (v1 - v0));
    }
    for (let i = 0; i < n; i += 1) { const a = i * 2; index.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    return geometry;
  };
  /** Dial gauge facing +z in the given frame. */
  const gauge = (add: ReturnType<typeof frame>, x: number, y: number, z: number, radius: number, key: string, needle: number) => {
    add(cyl(radius * 1.04, 0.04, "z", 20, false, radius), metals.brushed, x, y, z + 0.02);
    add(remap(new THREE.CircleGeometry(radius * 0.88, 20), key), signMaterial, x, y, z + 0.042);
    add(box(radius * 0.07, radius * 0.72, 0.004).translate(0, radius * 0.26, 0), redPaint, x, y, z + 0.047, [0, 0, needle]);
    add(cyl(radius * 0.1, 0.012, "z", 8), metals.darkMetal, x, y, z + 0.048);
  };
  const decal = (map: THREE.Texture, color = 0xffffff, opacity = 0.8) => {
    map.anisotropy = anisotropy;
    return new THREE.MeshStandardMaterial({ map, color, transparent: true, opacity, roughness: 0.8, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 0.6 });
  };

  // ---- Floor ---------------------------------------------------------------
  const floorMaterial = new THREE.MeshStandardMaterial({
    ...slab, normalScale: new THREE.Vector2(0.9, 0.9), color: 0x8c9ea3, roughness: 0.74, metalness: 0, aoMapIntensity: 0.8, envMapIntensity: 0.5,
  });
  const reflection = kit.floor(floorMaterial, { width: 40, depth: 66, z: -18.5 }, {
    lane: new THREE.Color(BRAND).multiplyScalar(0.62),
    edge: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.8),
    markings: 1,
    wet: 0.05,
  });
  practical(floorMaterial);

  // ---- Shell ---------------------------------------------------------------
  const hallLength = BACK_Z - END_Z, hallMid = (BACK_Z + END_Z) / 2;
  for (const side of sides) {
    place(new THREE.Mesh(worldBox(0.6, CEILING, hallLength + 1.2, 4.8), concrete), side * (CONCRETE_X + 0.3), CEILING / 2, hallMid, false, true);
    // Painted steel wainscot: the flat face the range signs hang on.
    place(new THREE.Mesh(worldBox(0.08, WAINSCOT, hallLength, 2.4), wainscot), side * (WALL_X + 0.04), WAINSCOT / 2, hallMid, false, true);
    place(new THREE.Mesh(softBox(0.16, 0.1, hallLength, 0.02, 1.4), metals.structural), side * (WALL_X + 0.02), WAINSCOT + 0.03, hallMid, false);
    place(new THREE.Mesh(softBox(0.3, 0.32, hallLength, 0.03, 2.2), shieldConcrete), side * 9.48, 0.16, hallMid, false, true);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.13, 37), hazardMaterial(37 / 0.52, 1)), side * (WALL_X - 0.003), 4.42, -9.5, false);
    place(new THREE.Mesh(worldBox(0.06, 0.08, hallLength, 1.4), metals.darkMetal), side * 9.5, 0.44, hallMid, false);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, hallLength), side < 0 ? ledAmber : ledMint), side * 9.47, 0.44, hallMid, false);
  }
  // Cover strips over the wainscot sheet joints.
  instances(worldBox(0.01, 4.0, 0.05, 1.4), metals.structural, sides.flatMap((side) => Array.from({ length: 24 }, (_, i) => at(side * (WALL_X - 0.004), 2.34, 8.5 - i * 2.4))), false, false);
  place(new THREE.Mesh(worldBox(20.4, CEILING, 0.6, 4.8), concrete), 0, CEILING / 2, BACK_Z + 0.3, false, true);
  place(new THREE.Mesh(worldBox(20.4, CEILING, 0.6, 4.8), concrete), 0, CEILING / 2, END_Z - 0.3, false, true);
  place(new THREE.Mesh(worldBox(19.1, WAINSCOT, 0.08, 2.4), wainscot), 0, WAINSCOT / 2, END_Z + 0.04, false, true);

  // Pilasters carry the crane rails; they start above the wainscot so the sign wall stays flat.
  const pilasterZ = [9, -3, -15, -27, -39];
  instances(softBox(0.4, CEILING - WAINSCOT - 0.08, 0.9, 0.04, 4.8), concrete, pilasterZ.flatMap((z) => sides.map((side) => at(side * 9.46, (CEILING + WAINSCOT + 0.08) / 2, z))), false, false);
  instances(softBox(0.86, 0.5, 0.9, 0.04, 4.8), concrete, pilasterZ.flatMap((z) => sides.map((side) => at(side * 9.22, 9.55, z))), false);
  // A haunch under each pilaster carries it back to the wall above the wainscot.
  {
    const profile = new THREE.Shape();
    profile.moveTo(0, 0); profile.lineTo(-0.3, 0); profile.lineTo(0, -0.34); profile.closePath();
    const haunch = new THREE.ExtrudeGeometry(profile, { depth: 0.82, bevelEnabled: false }).translate(0, 0, -0.41);
    for (const z of pilasterZ) {
      world(projectUv(haunch.clone(), 4.8), concrete, WALL_X + 0.03, WAINSCOT + 0.09, z);
      world(projectUv(haunch.clone().rotateY(Math.PI), 4.8), concrete, -WALL_X - 0.03, WAINSCOT + 0.09, z);
    }
  }

  // ---- Roof ----------------------------------------------------------------
  // One slab pierced by the four slots, so no two pieces share a face.
  const roofZ0 = END_Z - 0.6, roofZ1 = BACK_Z + 0.6;
  {
    const outline = new THREE.Shape();
    outline.moveTo(-10.4, roofZ0); outline.lineTo(10.4, roofZ0); outline.lineTo(10.4, roofZ1); outline.lineTo(-10.4, roofZ1); outline.closePath();
    for (const z of SLOTS) {
      const hole = new THREE.Path();
      hole.moveTo(-SLOT_HALF.x, z - SLOT_HALF.z); hole.lineTo(-SLOT_HALF.x, z + SLOT_HALF.z); hole.lineTo(SLOT_HALF.x, z + SLOT_HALF.z); hole.lineTo(SLOT_HALF.x, z - SLOT_HALF.z); hole.closePath();
      outline.holes.push(hole);
    }
    // Drawn in plan (shape y is world z) and extruded downward from the top of the slab.
    const slabGeometry = new THREE.ExtrudeGeometry(outline, { depth: 0.4, bevelEnabled: false });
    slabGeometry.rotateX(Math.PI / 2);
    slabGeometry.translate(0, CEILING + 0.4, 0);
    world(projectUv(slabGeometry, 4.8), roofConcrete, 0, 0, 0, undefined, undefined, { shadow: true });
  }
  // Downstand beams frame every slot; lighter ones tie them together across each bay.
  instances(softBox(19.3, 0.9, 0.5, 0.03, 4.8), roofConcrete, [...SLOTS.flatMap((z) => [z - 2.3, z + 2.3]), -38.4, -43.2].map((z) => at(0, CEILING - 0.45, z)), false);
  for (const [from, to] of [[2.7, -4.7], [-9.3, -16.7], [-21.3, -29.7]]) {
    instances(softBox(0.36, 0.5, from - to, 0.03, 4.8), roofConcrete, [-6, 0, 6].map((x) => at(x, CEILING - 0.25, (from + to) / 2)), false, false);
  }
  // Slots: a luminous diffuser at the head of an upstand set back from the opening, so the cut edge
  // of the slab reads as a reveal, with glazing bars across the opening that print the light.
  const diffuser = track(diffuserTexture());
  diffuser.anisotropy = anisotropy;
  const diffuserMaterial = new THREE.MeshBasicMaterial({ map: diffuser, color: new THREE.Color(0xdcefff).multiplyScalar(2), toneMapped: false });
  const wellShade = track(canvasTexture(4, 64, (context) => {
    const gradient = context.createLinearGradient(0, 0, 0, 64);
    gradient.addColorStop(0, "#ffffff"); gradient.addColorStop(0.5, "#b9c9d2"); gradient.addColorStop(1, "#6d8591");
    context.fillStyle = gradient; context.fillRect(0, 0, 4, 64);
  }));
  const wellMaterial = new THREE.MeshBasicMaterial({ map: wellShade, color: new THREE.Color(0xc4dcea).multiplyScalar(1.05), toneMapped: false });
  const wellX = SLOT_HALF.x + 0.14, wellZ = SLOT_HALF.z + 0.14, wellRise = 0.62, wellY = CEILING + 0.4 + wellRise / 2;
  SLOTS.forEach((z) => {
    world(new THREE.PlaneGeometry(wellX * 2, wellZ * 2).rotateX(Math.PI / 2), diffuserMaterial, 0, CEILING + 0.4 + wellRise, z);
    world(new THREE.PlaneGeometry(wellX * 2, wellRise), wellMaterial, 0, wellY, z - wellZ);
    world(new THREE.PlaneGeometry(wellX * 2, wellRise).rotateY(Math.PI), wellMaterial, 0, wellY, z + wellZ);
    world(new THREE.PlaneGeometry(wellZ * 2, wellRise).rotateY(Math.PI / 2), wellMaterial, -wellX, wellY, z);
    world(new THREE.PlaneGeometry(wellZ * 2, wellRise).rotateY(-Math.PI / 2), wellMaterial, wellX, wellY, z);
  });
  // The long bar is deeper than the cross bars, so their faces never share a plane where they cross.
  instances(worldBox(0.11, 0.16, SLOT_HALF.z * 2, 1.4), metals.structural, SLOTS.flatMap((z) => [-6.75, -4.5, -2.25, 0, 2.25, 4.5, 6.75].map((x) => at(x, CEILING + 0.06, z))), false);
  instances(worldBox(SLOT_HALF.x * 2, 0.22, 0.13, 1.4), metals.structural, SLOTS.map((z) => at(0, CEILING + 0.06, z)), false);

  // Extract fans between the slots: a short duct through the slab with the motor carried under it on a
  // cross of flat bar. The rotors and the daylight behind them are drawn with the rest of the motion.
  for (const fan of FANS) {
    world(lathe([[1.14, 0], [1.22, 0], [1.22, 0.38], [1.36, 0.38], [1.36, 0.44], [1.14, 0.44], [1.14, 0]], 40), metals.structural, fan.x, CEILING - 0.44, fan.z);
    for (const turn of [0.4, 0.4 + Math.PI / 2]) world(box(2.36, 0.035, 0.07), metals.darkMetal, fan.x, CEILING - 0.46, fan.z, [0, turn, 0]);
    world(cyl(0.21, 0.26, "y", 16), metals.darkMetal, fan.x, CEILING - 0.6, fan.z);
  }

  // ---- Bridge crane --------------------------------------------------------
  const railRun = hallLength - 0.6;
  instances(iBeam(0.34, 0.55, railRun, 0.05, 0.03), metals.structural, sides.map((side) => at(side * 9.02, 10.075, END_Z + 0.3, [Math.PI / 2, 0, 0])), false);
  instances(worldBox(0.07, 0.08, railRun, 1.4), metals.darkMetal, sides.map((side) => at(side * 9.02, 10.39, hallMid)), false, false);
  // Everything that rides the rails is a rig, built where the crane parks, so the bridge can travel:
  // the hook block hangs from a pivot of its own at the drum, the pendant from one at the girder.
  const hookX = -2.6, blockY = 8.0, pendantX = -7.9;
  const bridge = new THREE.Group(), hookRig = new THREE.Group(), pendantRig = new THREE.Group();
  bridge.position.set(0, 0, CRANE_Z);
  hookRig.position.set(hookX, 11.2, 0);
  pendantRig.position.set(pendantX, 11.6, 1.36);
  bridge.add(hookRig, pendantRig);
  scene.add(bridge);
  openRig(bridge);
  // End carriages and wheels are narrow enough to pass the pilasters.
  instances(softBox(0.44, 0.5, 3.8, 0.04, 1.6), cranePaint, sides.map((side) => at(side * 9.02, 10.72, CRANE_Z)), false);
  const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 20);
  wheel.rotateZ(Math.PI / 2);
  instances(wheel, metals.darkMetal, sides.flatMap((side) => [-1.5, 1.5].map((o) => at(side * 9.02, 10.62, CRANE_Z + o, [0, 0, 0], [3.4, 1, 1]))), false, false);
  instances(softBox(17.7, 1.0, 0.48, 0.03, 1.8), cranePaint, [-1, 1].map((o) => at(0, 11.0, CRANE_Z + o)), false);
  // Hazard ends on the girders, facing down the range.
  const chevrons = hazardMaterial(2, 1);
  instances(new THREE.BoxGeometry(1.3, 0.96, 0.012), chevrons, sides.flatMap((side) => [1.245, -1.245].map((o) => at(side * 8.1, 11.0, CRANE_Z + o))), false, false);
  const plate = track(stencilTexture(512, 128, "#101214", [{ text: "SWL $16000", size: 80, y: 45 }, { text: "NOBODY CARRIES MORE", size: 34, y: 106 }], 0.18));
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), decal(plate, 0xffffff, 0.9));
  plateMesh.position.set(-5.4, 11.0, 1.246);
  bridge.add(plateMesh);
  kit.mirrorHidden.push(plateMesh);
  // Trolley, hoist drum, falls and hook block.
  place(new THREE.Mesh(softBox(2.3, 0.4, 2.7, 0.04, 1.6), metals.machine), hookX, 11.72, CRANE_Z, true);
  place(new THREE.Mesh(softBox(0.9, 0.62, 0.8, 0.04, 1.6), metals.machine), hookX + 0.5, 12.2, CRANE_Z - 0.6, true);
  const hoistDrum = new THREE.CylinderGeometry(0.34, 0.34, 1.5, 24);
  hoistDrum.rotateZ(Math.PI / 2);
  place(new THREE.Mesh(scaleUv(hoistDrum, 3, 2), metals.machine), hookX, 11.3, CRANE_Z, true);
  openRig(hookRig);
  instances(new THREE.CylinderGeometry(0.014, 0.014, 11.2 - blockY - 0.3, 6), cable, [[-0.2, -0.1], [0.2, -0.1], [-0.2, 0.1], [0.2, 0.1]].map(([x, z]) => at(hookX + x, (11.2 + blockY + 0.3) / 2, CRANE_Z + z)), false);
  place(new THREE.Mesh(softBox(0.66, 0.74, 0.3, 0.05, 1), cranePaint), hookX, blockY, CRANE_Z, true);
  const sheave = new THREE.CylinderGeometry(0.27, 0.27, 0.38, 24);
  sheave.rotateX(Math.PI / 2);
  place(new THREE.Mesh(sheave, metals.darkMetal), hookX, blockY + 0.06, CRANE_Z, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.34, 10), metals.darkMetal), hookX, blockY - 0.5, CRANE_Z, true);
  const hook = place(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.055, 10, 24, Math.PI * 1.45), metals.darkMetal), hookX, blockY - 0.84, CRANE_Z, true);
  hook.rotation.z = Math.PI * 0.82;
  openRig(bridge);
  // Festoon track with its loops of flat cable.
  place(new THREE.Mesh(worldBox(17.4, 0.05, 0.05, 1.4), metals.darkMetal), 0, 11.66, CRANE_Z + 1.36, false);
  instances(new THREE.TorusGeometry(0.3, 0.02, 6, 14, Math.PI), cable, Array.from({ length: 17 }, (_, i) => at(hookX + 0.9 + i * 0.6, 11.62, CRANE_Z + 1.36, [Math.PI, 0, 0], [1, 1 + (i % 3) * 0.25, 1])), false);
  openRig(null);

  // ---- Catwalks ------------------------------------------------------------
  const walkFrom = -28.6, walkTo = 9.6, walkRun = walkTo - walkFrom, walkMid = (walkFrom + walkTo) / 2, deckY = DECK_Y;
  const grating = track(gratingTexture());
  grating.anisotropy = anisotropy;
  const gratingMaterial = practical(new THREE.MeshStandardMaterial({ map: grating, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.9 }));
  /** Flat grating panel, 0.2 m to the texture tile, bearing bars spanning the short way. */
  const gratingPanel = (width: number, length: number) => {
    const geometry = new THREE.PlaneGeometry(width, length).rotateX(-Math.PI / 2);
    const uv = geometry.attributes.uv, position = geometry.attributes.position, alongZ = length > width;
    for (let i = 0; i < uv.count; i += 1) {
      const x = position.getX(i) / 0.2, z = position.getZ(i) / 0.2;
      uv.setXY(i, alongZ ? z : x, alongZ ? x : z);
    }
    return geometry;
  };
  instances(gratingPanel(1.4, walkRun), gratingMaterial, sides.map((side) => at(side * 8.85, deckY, walkMid)), false);
  // Stringers carry the grating on their top flange, three centimetres under the walking surface.
  instances(worldBox(0.07, 0.2, walkRun, 1.4), metals.structural, sides.flatMap((side) => [8.17, 9.5].map((x) => at(side * x, deckY - 0.13, walkMid))), false);
  const bracketZ = Array.from({ length: 13 }, (_, i) => 8 - i * 3);
  instances(worldBox(1.46, 0.1, 0.08, 1.4), metals.structural, bracketZ.flatMap((z) => sides.map((side) => at(side * 8.89, deckY - 0.28, z))), false);
  const strut = Math.atan2(0.36, 1.25);
  instances(worldBox(Math.hypot(1.25, 0.36), 0.07, 0.07, 1.4), metals.structural, bracketZ.flatMap((z) => sides.map((side) => at(side * 8.9, deckY - 0.5, z, [0, 0, -side * strut]))), false);
  const postZ = Array.from({ length: 26 }, (_, i) => walkTo - 0.35 - i * 1.5);
  instances(new THREE.CylinderGeometry(0.022, 0.022, 1.13, 8), yellowPaint, postZ.flatMap((z) => sides.map((side) => at(side * 8.17, deckY + 0.535, z))), false);
  const handrail = new THREE.CylinderGeometry(0.024, 0.024, walkRun, 8);
  handrail.rotateX(Math.PI / 2);
  instances(scaleUv(handrail, 1, 30), yellowPaint, sides.flatMap((side) => [1.1, 0.6].map((y) => at(side * 8.17, deckY + y, walkMid))), false);
  instances(worldBox(0.012, 0.12, walkRun, 1.4), metals.structural, sides.map((side) => at(side * 8.15, deckY + 0.07, walkMid)), false, false);
  // Wall-wash tubes hang under the decks, clear of the risers, and light the wainscot.
  const washZ = bracketZ.slice(0, -1).map((z) => z - 1.5);
  const washTube = new THREE.CylinderGeometry(0.024, 0.024, 2.3, 8);
  washTube.rotateX(Math.PI / 2);
  instances(washTube, glowWhite, washZ.flatMap((z) => sides.filter((side) => side > 0 || z !== FAIL_TUBE_Z).map((side) => at(side * WASH.x, WASH.y, z))), false, false);
  // One tube on the west wall is on its way out: a mesh and a material of its own, so it can flicker.
  const failingTube = new THREE.MeshBasicMaterial({ color: glowWhite.color.clone(), toneMapped: false });
  kit.mirrorHidden.push(kit.place(new THREE.Mesh(washTube, failingTube), -WASH.x, WASH.y, FAIL_TUBE_Z, false));
  instances(softBox(0.16, 0.06, 2.44, 0.015, 1.4), metals.darkMetal, washZ.flatMap((z) => sides.map((side) => at(side * WASH.x, WASH.y + 0.07, z))), false, false);
  for (const side of sides) for (const z of washZ) for (const o of [-1, 1]) {
    fineWorld(cyl(0.008, deckY - WASH.y - 0.1, "y", 5), metals.brushed, side * WASH.x, (deckY + WASH.y + 0.1) / 2, z + o);
  }

  // ---- Services ------------------------------------------------------------
  // Cable trays on cantilever arms every three metres (the arms at the pilasters die into them).
  const trayY = 7.5, trayX = 8.7, trayRun = hallLength - 0.4;
  instances(worldBox(0.03, 0.1, trayRun, 1.4), metals.brushed, sides.flatMap((side) => [-0.2, 0.2].map((o) => at(side * trayX + o, trayY, hallMid))), false);
  instances(worldBox(0.4, 0.02, 0.04, 1.4), metals.brushed, sides.flatMap((side) => Array.from({ length: 94 }, (_, i) => at(side * trayX, trayY - 0.03, BACK_Z - 0.5 - i * 0.6))), false, false);
  const trayCable = new THREE.CylinderGeometry(0.03, 0.03, trayRun, 8);
  trayCable.rotateX(Math.PI / 2);
  instances(trayCable, cable, sides.flatMap((side) => [-0.12, -0.04, 0.05, 0.13].map((o, i) => at(side * trayX + o, trayY + 0.012, hallMid, [0, 0, 0], [1 - (i % 2) * 0.3, 1 - (i % 2) * 0.3, 1]))), false, false);
  const trayArmZ = Array.from({ length: 19 }, (_, i) => 9 - i * 3);
  instances(worldBox(1.22, 0.07, 0.07, 1.4), metals.structural, trayArmZ.flatMap((z) => sides.map((side) => at(side * 9.05, trayY - 0.09, z))), false, false);
  instances(worldBox(0.05, 0.3, 0.05, 1.4), metals.structural, trayArmZ.filter((z) => !pilasterZ.includes(z)).flatMap((z) => sides.map((side) => at(side * 9.6, trayY - 0.22, z))), false, false);
  // Process mains above the trays, colour-coded: teal feed, amber return, grey service.
  const mainFrom = -39.8, mainTo = 9.5, mainRun = mainTo - mainFrom, mainMid = (mainFrom + mainTo) / 2;
  const mains: Array<{ x: number; y: number; radius: number; material: THREE.Material }> = [
    { x: -8.85, y: 8.2, radius: 0.26, material: tealPaint }, { x: -8.85, y: 8.86, radius: 0.22, material: amberPaint },
    { x: 8.52, y: 8.2, radius: 0.2, material: amberPaint }, { x: 8.52, y: 8.74, radius: 0.16, material: greyPaint },
  ];
  const flangeZ = Array.from({ length: 13 }, (_, i) => 7.6 - i * 3.9);
  mains.forEach(({ x, y, radius, material }) => {
    const pipe = new THREE.CylinderGeometry(radius, radius, mainRun, 20);
    pipe.rotateX(Math.PI / 2);
    place(new THREE.Mesh(scaleUv(pipe, 1, 28), material), x, y, mainMid, true);
    const flange = new THREE.CylinderGeometry(radius + 0.06, radius + 0.06, 0.09, 20);
    flange.rotateX(Math.PI / 2);
    instances(flange, metals.structural, [...flangeZ, mainFrom + 0.05].map((z) => at(x, y, z)), false);
    for (const z of flangeZ) for (let k = 0; k < 10; k += 1) {
      fineWorld(cyl(0.016, 0.15, "z", 6), metals.brushed, x + Math.cos(k * Math.PI / 5) * (radius + 0.035), y + Math.sin(k * Math.PI / 5) * (radius + 0.035), z);
    }
  });
  // Pipe supports every six metres: an arm under each main from the wall, a post tying the arm tips,
  // a knee brace under the lower arm and a U-bolt over each pipe.
  for (const side of sides) {
    const pair = mains.filter((entry) => Math.sign(entry.x) === side);
    const tip = Math.min(...pair.map((entry) => Math.abs(entry.x) - entry.radius)) - 0.1, reach = CONCRETE_X + 0.03 - tip, mid = (CONCRETE_X + 0.03 + tip) / 2;
    for (let z = 9.3; z > mainFrom; z -= 6) {
      pair.forEach(({ x, y, radius }) => {
        world(worldBox(reach, 0.08, 0.1, 1.4), metals.structural, side * mid, y - radius - 0.04, z);
        world(new THREE.TorusGeometry(radius + 0.014, 0.013, 5, 16, Math.PI), metals.brushed, x, y, z);
        for (const o of [-1, 1]) world(cyl(0.013, radius, "y", 5), metals.brushed, x + o * (radius + 0.014), y - radius / 2, z);
      });
      const low = pair[0].y - pair[0].radius - 0.08, high = pair[1].y - pair[1].radius;
      world(worldBox(0.06, high - low, 0.1, 1.4), metals.structural, side * (tip + 0.03), (low + high) / 2, z);
      world(worldBox(Math.hypot(0.62, 0.62), 0.06, 0.06, 1.4), metals.structural, side * (CONCRETE_X - 0.3), low - 0.3, z, [0, 0, -side * Math.PI / 4]);
    }
  }
  // Relief valves on the feed and service mains: a stub off the pipe and a nozzle aimed across the hall.
  for (const { at: [x, y, z], dir } of RELIEFS) {
    const aim: V3 = [0, Math.atan2(-dir[2], dir[0]), Math.asin(dir[1])];
    world(cyl(0.052, 0.36, "x", 12, false, 0.036), metals.brushed, x - dir[0] * 0.18, y - dir[1] * 0.18, z - dir[2] * 0.18, aim);
    world(cyl(0.08, 0.05, "x", 12), metals.structural, x - dir[0] * 0.27, y - dir[1] * 0.27, z - dir[2] * 0.27, aim);
    world(cyl(0.03, 0.2, "y", 8), redPaint, x - dir[0] * 0.2, y - dir[1] * 0.2 + 0.12, z - dir[2] * 0.2);
  }
  // Risers against the walls: each climbs from the kerb to tee into its main, with a gate valve at hand height.
  const risers: Array<{ side: number; z: number; main: number }> = [
    { side: -1, z: -2.3, main: 0 }, { side: -1, z: -1.6, main: 1 }, { side: -1, z: 7.0, main: 0 },
    { side: 1, z: -4.95, main: 2 }, { side: 1, z: -4.3, main: 3 }, { side: 1, z: 5.4, main: 3 },
  ];
  const riserX = 9.3;
  risers.forEach(({ side, z, main }) => {
    const target = mains[main];
    world(scaleUv(pipeRun([[side * riserX, 0, z], [side * riserX, target.y, z], [target.x, target.y, z]], 0.13, 0.3, 16), 1, 0.6), target.material, 0, 0, 0, undefined, undefined, { shadow: true });
    for (const y of [0.035, 0.95, 1.55, 4.75, target.y - 0.62]) world(new THREE.CylinderGeometry(0.19, 0.19, 0.07, 16), metals.structural, side * riserX, y, z);
    world(cyl(0.165, 0.1, "x", 16), metals.structural, target.x + Math.sign(side * riserX - target.x) * (target.radius + 0.03), target.y, z);
    // Toe ring where the riser passes through the catwalk deck.
    world(new THREE.CylinderGeometry(0.21, 0.21, 0.09, 16), metals.structural, side * riserX, deckY + 0.03, z);
  });
  instances(valveWheelGeometry(0.17), redPaint, risers.map(({ side, z }) => at(side * 8.86, 1.25, z, [0, side > 0 ? 0 : Math.PI, 0])), false);

  // ---- Reactor vessel ------------------------------------------------------
  const core = (x: number, y: number, z: number, rotation?: V3, scale?: V3) => at(CORE.x + x, y, CORE.z + z, rotation, scale);
  const ring = (count: number, radius: number, y: number, phase = 0, scale?: V3) => Array.from({ length: count }, (_, i) => {
    const angle = phase + (i / count) * Math.PI * 2;
    return core(Math.sin(angle) * radius, y, Math.cos(angle) * radius, [0, angle, 0], scale);
  });
  place(new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(6.1, 6.4, CORE.base, 72), 8, CORE.base / 4.8), shieldConcrete), CORE.x, CORE.base / 2, CORE.z, true, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(6.16, 6.16, 0.12, 72), metals.structural), CORE.x, CORE.base + 0.02, CORE.z, false);
  /** Radius of the tapered shield at a height. */
  const shieldAt = (y: number) => 6.4 - 0.3 * y / CORE.base;
  const bandMaterial = hazardMaterial(60, 1);
  bandMaterial.polygonOffset = true; bandMaterial.polygonOffsetFactor = -2; bandMaterial.polygonOffsetUnits = -2;
  place(new THREE.Mesh(new THREE.CylinderGeometry(shieldAt(CORE.base - 0.27) + 0.008, shieldAt(CORE.base - 0.57) + 0.008, 0.3, 72, 1, true), bandMaterial), CORE.x, CORE.base - 0.42, CORE.z, false);
  const shellHeight = CORE.top - CORE.base;
  place(new THREE.Mesh(new THREE.CylinderGeometry(CORE.radius, CORE.radius, shellHeight, 72, 1, true), vesselPaint), CORE.x, CORE.base + shellHeight / 2, CORE.z, true, true);
  const dome = new THREE.SphereGeometry(CORE.radius, 64, 20, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.5, 1);
  place(new THREE.Mesh(dome, vesselPaint), CORE.x, CORE.top, CORE.z, true);
  // Girth flanges, with the core seam held open between the upper pair.
  const seamY = 8.6;
  instances(new THREE.CylinderGeometry(CORE.radius + 0.2, CORE.radius + 0.2, 0.22, 72), metals.structural, [3.0, 5.7, seamY - 0.3, seamY + 0.3, CORE.top - 0.06].map((y) => core(0, y, 0)), false);
  place(new THREE.Mesh(new THREE.CylinderGeometry(CORE.radius + 0.05, CORE.radius + 0.05, 0.4, 72, 1, true), coreGlow), CORE.x, seamY, CORE.z, false).receiveShadow = false;
  instances(softBox(0.16, 0.42, 0.26, 0.02, 1), metals.darkMetal, ring(36, CORE.radius + 0.13, seamY), false, false);
  const stud = new THREE.CylinderGeometry(0.04, 0.04, 0.95, 6);
  instances(stud, metals.brushed, ring(72, CORE.radius + 0.14, seamY, 0.04), false, false);
  // Stiffening ribs in two tiers, with the view ports between the upper ones.
  instances(softBox(0.16, 2.36, 0.36, 0.03, 1.6), vesselPaint, ring(28, CORE.radius + 0.14, 4.35), false);
  instances(softBox(0.16, 2.26, 0.36, 0.03, 1.6), vesselPaint, ring(14, CORE.radius + 0.14, 7.0, Math.PI / 14), false);
  const portRim = new THREE.CylinderGeometry(0.6, 0.66, 0.34, 28);
  portRim.rotateX(Math.PI / 2);
  instances(portRim, metals.darkMetal, ring(14, CORE.radius + 0.08, 6.95), false);
  const portLens = new THREE.CylinderGeometry(0.44, 0.44, 0.06, 28);
  portLens.rotateX(Math.PI / 2);
  instances(portLens, portGlow, ring(14, CORE.radius + 0.24, 6.95), false, false);
  const portBolt = new THREE.CylinderGeometry(0.035, 0.035, 0.06, 6);
  portBolt.rotateX(Math.PI / 2);
  instances(portBolt, metals.brushed, ring(14, CORE.radius + 0.27, 6.95).flatMap((port) => Array.from({ length: 10 }, (_, i) => {
    const turn = (i / 10) * Math.PI * 2, yaw = port.rotation![1];
    return at(port.position[0] + Math.cos(yaw) * Math.cos(turn) * 0.54, 6.95 + Math.sin(turn) * 0.54, port.position[2] - Math.sin(yaw) * Math.cos(turn) * 0.54, [0, yaw, 0]);
  })), false, false);
  // Head: drive housings around a central stack that passes through the roof.
  place(new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.15, CEILING - 12.1, 32), metals.machine), CORE.x, (CEILING + 12.1) / 2, CORE.z, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(1.32, 1.32, 0.16, 32), metals.structural), CORE.x, 12.62, CORE.z, false);
  instances(new THREE.CylinderGeometry(0.12, 0.14, 1.1, 12), metals.brushed, ring(12, 2.7, 12.5), false);
  instances(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), metals.darkMetal, ring(12, 2.7, 12.02), false, false);
  // Unit number stencilled across the upper shell.
  const unitMap = track(stencilTexture(1024, 256, "#13262b", [{ text: "U-1.6", size: 230, y: 136 }], 0.34));
  unitMap.anisotropy = anisotropy;
  const unitArc = 1.0;
  const unit = place(new THREE.Mesh(new THREE.CylinderGeometry(CORE.radius + 0.012, CORE.radius + 0.012, unitArc * CORE.radius / 4, 32, 1, true, -unitArc / 2, unitArc), decal(unitMap, 0xffffff, 0.85)), CORE.x, 9.5, CORE.z, false);
  unit.renderOrder = 1;
  // Service gallery rail around the top of the shield.
  const galleryRail = new THREE.TorusGeometry(5.86, 0.026, 8, 96);
  galleryRail.rotateX(Math.PI / 2);
  instances(galleryRail, yellowPaint, [3.15, 3.7].map((y) => core(0, y, 0)), false);
  instances(new THREE.CylinderGeometry(0.024, 0.024, 1.1, 8), yellowPaint, ring(40, 5.86, 3.15), false);
  // Exchanger towers either side, tied to the vessel by the loop pipes.
  const pipeBetween = (from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material, joints = true) => {
    const length = from.distanceTo(to);
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    const one = new THREE.Vector3(1, 1, 1);
    put(scaleUv(new THREE.CylinderGeometry(radius, radius, length, 24), 2, Math.max(1, length / 2)), material, new THREE.Matrix4().compose(from.clone().add(to).multiplyScalar(0.5), turn, one), { shadow: true });
    if (joints) for (const t of [0.22, 0.78]) {
      const centre = from.clone().lerp(to, t);
      put(new THREE.CylinderGeometry(radius + 0.08, radius + 0.08, 0.1, 24), metals.structural, new THREE.Matrix4().compose(centre, turn, one), { shadow: true });
      const bolts = new THREE.Matrix4().compose(centre, turn, one);
      for (let k = 0; k < 12; k += 1) put(cyl(0.022, 0.16, "y", 6), metals.brushed, bolts.clone().multiply(mat4(Math.cos(k * Math.PI / 6) * (radius + 0.045), 0, Math.sin(k * Math.PI / 6) * (radius + 0.045))), { fine: true });
    }
  };
  const towerX = 7.55, towerZ = CORE.z - 2.6;
  instances(scaleUv(new THREE.CapsuleGeometry(1.25, 7.1, 10, 36), 1, 1), insulation, sides.map((side) => at(side * towerX, 5.3, towerZ)), true);
  instances(new THREE.CylinderGeometry(1.12, 1.2, 1.1, 32), metals.darkMetal, sides.map((side) => at(side * towerX, 0.55, towerZ)), false);
  instances(new THREE.CylinderGeometry(1.29, 1.29, 0.09, 36), metals.structural, sides.flatMap((side) => [2.1, 4.4, 6.7, 8.6].map((y) => at(side * towerX, y, towerZ))), false, false);
  for (const side of sides) {
    const hot = side < 0 ? amberPaint : tealPaint, cold = side < 0 ? tealPaint : amberPaint;
    pipeBetween(new THREE.Vector3(side * 4.2, 9.45, CORE.z - 1.5), new THREE.Vector3(side * 6.6, 9.45, towerZ + 0.1), 0.42, hot);
    pipeBetween(new THREE.Vector3(side * 4.2, 4.3, CORE.z - 1.5), new THREE.Vector3(side * 6.6, 4.3, towerZ + 0.1), 0.42, cold);
    // Mains leave the towers for the hall walls.
    const main = mains.filter((entry) => Math.sign(entry.x) === side);
    main.forEach((entry, index) => pipeBetween(new THREE.Vector3(entry.x, entry.y, mainFrom + 0.02), new THREE.Vector3(side * (towerX + 0.5), entry.y - 0.25 - index * 0.3, towerZ + 0.5 + index * 0.3), entry.radius, entry.material, false));
  }
  // Rail and floor band closing the range off from the vessel floor.
  const fenceZ = -29.6;
  instances(new THREE.CylinderGeometry(0.028, 0.028, 1.1, 8), yellowPaint, Array.from({ length: 11 }, (_, i) => at(-9.2 + i * 1.84, 0.55, fenceZ)), false);
  const crossRail = new THREE.CylinderGeometry(0.026, 0.026, 18.5, 8);
  crossRail.rotateZ(Math.PI / 2);
  instances(scaleUv(crossRail, 1, 14), yellowPaint, [1.08, 0.58].map((y) => at(0, y, fenceZ)), false);
  const floorBand = new THREE.PlaneGeometry(18.6, 0.5);
  floorBand.rotateX(-Math.PI / 2);
  const band = place(new THREE.Mesh(floorBand, new THREE.MeshStandardMaterial({ map: hazardCopy(18.6 / 2, 1), roughness: 0.6, metalness: 0, transparent: true, opacity: 0.82, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), 0, 0.006, fenceZ - 0.5, false);
  band.renderOrder = 1;
  kit.mirrorHidden.push(band);

  // ---- Stencils ------------------------------------------------------------
  // Bay 2's stencil sits south of its centre, clear of the crane parked across that bay.
  const bayZ = [3, -5.5, -21, -33];
  // Each bay of the hall carries its number, the name the shift knows it by, and a word of advice.
  const bayNames = [["LOBBY", "NO LOITERING PAST 1:55"], ["RAMP ROOM", "IT IS A ROOM WITH A RAMP"], ["HUT", "KNOCK FIRST"], ["SQUEAKY", "YOU WILL BE HEARD"]];
  bayZ.forEach((z, index) => {
    const map = track(stencilTexture(512, 512, "#dfe8e7", [{ text: `0${index + 1}`, size: 250, y: 150 }, { text: bayNames[index][0], size: 104, y: 348 }, { text: `BAY ${"ABCD"[index]}  ·  ${bayNames[index][1]}`, size: 32, y: 458 }], 0.45));
    const material = decal(map, 0xffffff, 0.62);
    for (const side of sides) {
      const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), material), side * (CONCRETE_X - 0.004), 11.9, z, false);
      mesh.rotation.y = -side * Math.PI / 2;
    }
  });
  const hallMap = track(stencilTexture(2048, 256, "#dfe8e7", [{ text: "CORE HALL", size: 210, y: 132, x: 60, align: "left" }, { text: "A SITE", size: 120, y: 96, x: 1990, align: "right" }, { text: "NO FAKES  ·  DEFUSE KITS AT THE DESK, $400", size: 44, y: 206, x: 1990, align: "right" }], 0.4));
  const hallSign = place(new THREE.Mesh(new THREE.PlaneGeometry(13.6, 1.7), decal(hallMap, 0xffffff, 0.66)), 0, 9.6, BACK_Z - 0.004, false);
  hallSign.rotation.y = Math.PI;

  // ---- Beacons -------------------------------------------------------------
  // Six round the hall and two that ride the crane (in the bridge's own coordinates). Their bases are
  // steel; the lamps, their turning beams and the light they sweep over the walls come with the motion.
  const beaconSpots: V3[] = [
    [-9.2, 1.2, fenceZ], [9.2, 1.2, fenceZ],
    [-8.17, deckY + 1.2, walkFrom + 0.4], [8.17, deckY + 1.2, walkFrom + 0.4], [-8.17, deckY + 1.2, walkTo - 0.35], [8.17, deckY + 1.2, walkTo - 0.35],
  ];
  const craneBeacons: V3[] = [[-7.4, 10.32, 1], [7.4, 10.32, -1]];
  instances(new THREE.CylinderGeometry(0.075, 0.085, 0.07, 14), metals.darkMetal, beaconSpots.map(([x, y, z]) => at(x, y - 0.075, z)), false, false);

  // ---- Props ---------------------------------------------------------------
  // Hazard bollards mark the service strips along both walls.
  const bollardZ = Array.from({ length: 11 }, (_, i) => 8 - i * 3);
  // None beside the two outer stations (z -4, -7), where a post would narrow the lane round them, none in front of
  // the full bays and the cask (z 2, -22, and -19 on the east), where it would leave a slot too tight to pass, nor
  // in front of the furnace.
  const bollards = bollardZ.filter((z) => ![2, -4, -7, -22].includes(z)).flatMap((z) => sides.filter((side) => !(side > 0 && (z === -19 || (z < -8.5 && z > -14.5)))).map((side) => ({ x: side * 7.56, z })));
  instances(scaleUv(new THREE.CylinderGeometry(0.075, 0.075, 0.98, 16), 1, 1), hazardMaterial(1, 2.6, true), bollards.map(({ x, z }) => at(x, 0.49, z)));
  instances(new THREE.SphereGeometry(0.082, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), metals.darkMetal, bollards.map(({ x, z }) => at(x, 0.975, z)), false, false);
  instances(new THREE.CylinderGeometry(0.13, 0.14, 0.03, 16), metals.darkMetal, bollards.map(({ x, z }) => at(x, 0.015, z)), false, false);
  // The two barriers in the hall stand near enough to the kerb that nobody can edge in behind them.
  instances(jerseyBarrier(2.4), shieldConcrete, [at(-8.3, 0, 5.0, [0, Math.PI / 2 + 0.03, 0]), at(8.3, 0, -0.6, [0, Math.PI / 2 - 0.03, 0]), at(-8.05, 0, -25.4, [0, Math.PI / 2 - 0.06, 0])]);
  // Stores along the service strips, from the shared props library: every group stands in a bay painted on
  // the floor, labels to the lane. The library's materials take the hall's fixture light like everything else.
  const props = createProps(kit, { seed: 4 });
  const lit = new Set<THREE.Material>();
  const stock = (kind: PropKind, items: PropItem[], options?: PlaceOptions) => {
    for (const mesh of props.place(kind, items, options)) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (!lit.has(material)) { lit.add(material); practical(material); }
    }
  };
  /** Yaw that turns a prop's front to the lane from the given wall, plus a little carelessness. */
  const facing = (side: number, twist = 0): V3 => [0, -side * Math.PI / 2 + twist, 0];
  /** Something resting on a base (a pallet, a crate), placed in the base's own frame. */
  const seat = (base: Transform, x: number, y: number, z: number, twist = 0): Transform => {
    const yaw = base.rotation?.[1] ?? 0, c = Math.cos(yaw), sn = Math.sin(yaw);
    return { position: [base.position[0] + x * c + z * sn, base.position[1] + y, base.position[2] - x * sn + z * c], rotation: [0, yaw + twist, 0] };
  };
  const deck = props.get("pallet").size[1], crateTop = props.get("crateLarge").size[1], ammoTop = props.get("crateAmmo").size[1], toteTop = props.get("cratePlastic").size[1];
  const pallets = {
    drums: at(-8.84, 0, 8.62, facing(-1, 0.02)),
    spares: at(-8.72, 0, 2.88, facing(-1, 0.03)),
    lead: at(8.62, 0, 2.05, facing(1, -0.02)),
    crate: at(8.7, 0, -20.22, facing(1, 0.03)),
    totes: at(8.7, 0, -21.72, facing(1, -0.025)),
  };
  stock("pallet", Object.values(pallets));

  // Spares: a crate on its pallet, a second on the floor carrying range ammunition, sample-bottle totes on top.
  const crateA = seat(pallets.spares, 0, deck, 0, -0.05), crateB = at(-8.76, 0, 1.6, facing(-1, 0.06)), crateC = seat(pallets.crate, 0.01, deck, 0, 0.04);
  stock("crateLarge", [{ ...crateA, variant: 2 }, { ...crateB, variant: 3 }, { ...crateC, variant: 1 }]);
  stock("crateAmmo", [
    { ...seat(crateB, 0.03, crateTop, -0.2, 0.02), variant: 0 },
    { ...seat(crateB, -0.04, crateTop, 0.2, -0.03), variant: 1 },
    { ...seat(crateB, 0.05, crateTop + ammoTop, 0.02, 0.21), variant: 2 },
    { ...at(8.99, 0, -19.05, facing(1, 0.03)), variant: 3 },
    { ...at(8.97, ammoTop, -19.09, facing(1, -0.07)), variant: 0 },
  ]);
  const toteSpots: Array<[number, number, number, number]> = [
    [-0.4, 0, -0.16, 0.01], [0, 0, -0.16, -0.02], [0.4, 0, -0.16, 0.015], [-0.4, 0, 0.16, -0.01], [0.005, 0, 0.165, 0.03], [0.4, 0, 0.16, 0],
    [-0.39, 1, -0.155, 0.04], [0.01, 1, -0.16, -0.03], [0.4, 1, -0.15, 0.02], [-0.4, 1, 0.16, -0.05], [0.02, 2, -0.15, 0.09],
  ];
  stock("cratePlastic", [
    ...toteSpots.map(([x, level, z, twist]) => seat(pallets.totes, x, deck + level * toteTop, z, twist)),
    seat(crateA, -0.3, crateTop, 0.12, 0.2), seat(crateA, 0.24, crateTop, -0.1, -0.12),
  ], { variant: 0, tint: [0x2a2c2e, 0x1c4fa0, 0x2a2c2e, 0x24507e, 0x2a2c2e, 0x1c4fa0, 0x9a9788] });

  // Drums: a strapped pair of solvent on a pallet by the door, a bunded waste drum and two more west, a pair
  // east (both stores kept 1.6 m clear of the outer stations), one left on the fire point's keep-clear
  // hatching, and what stands beyond the control wall.
  const strapped = [seat(pallets.drums, -0.305, deck, 0, 0.12), seat(pallets.drums, 0.305, deck, 0, -0.2)];
  const bund = at(-8.9, 0, -3.2, facing(-1, 0.02)), bundTop = 0.172;
  stock("drum", [
    { ...strapped[0], variant: 1, tint: 0x1c4c8c }, { ...strapped[1], variant: 1, tint: 0x1d5486 },
    { ...seat(bund, 0, bundTop, 0, 0.25), variant: 3, tint: 0x22262a },
    { ...at(-8.98, 0, -3.97, facing(-1, -0.1)), variant: 0, tint: 0xc4961c },
    { ...at(-9.01, 0, -4.6, facing(-1, 0.3)), variant: 0, tint: 0xbf8f1a },
    { ...at(8.2, 0, 3.72, [0, 2.3, 0]), variant: 0, tint: 0xc4961c },
    { ...at(-8.75, 0, -27.6, [0, 1.9, 0]), tint: 0xc4961c }, { ...at(8.78, 0, -28.3, [0, -1.1, 0]), tint: 0x1c6a64 },
  ]);
  stock("drumPlastic", [
    { ...at(8.99, 0, -7.52, facing(1, -0.2)), variant: 2, tint: 0x1d4f9e },
    { ...at(8.97, 0, -8.16, facing(1, 0.1)), variant: 2, tint: 0x1a3f7c },
    // Ion-exchange resin on its tray on the vessel floor.
    ...([[7.8, -30.95], [8.5, -30.9], [7.85, -31.65], [8.52, -31.6]] as Array<[number, number]>).map(([x, z], i) => ({ ...at(x, 0.05, z, [0, 3 + i * 1.1, 0]), variant: i === 2 ? 3 : 1, tint: i === 2 ? 0xd9a514 : 0x24507e })),
  ]);
  {
    // Ratchet strap round the pair, between the upper hoop and the label.
    const r = 0.2965, d = 0.305, outline: Array<[number, number]> = [];
    for (let i = 0; i <= 12; i += 1) { const a = -Math.PI / 2 + (i / 12) * Math.PI; outline.push([d + Math.cos(a) * r, Math.sin(a) * r]); }
    for (let i = 0; i <= 12; i += 1) { const a = Math.PI / 2 + (i / 12) * Math.PI; outline.push([-d + Math.cos(a) * r, Math.sin(a) * r]); }
    const position: number[] = [], normal: number[] = [], uv: number[] = [], index: number[] = [], n = outline.length, tall = 0.036;
    for (let i = 0; i <= n; i += 1) {
      const [x, z] = outline[i % n], [px, pz] = outline[(i + n - 1) % n], [nx, nz] = outline[(i + 1) % n];
      let ox = nz - pz, oz = px - nx;
      if (ox * (x - Math.sign(x) * d) + oz * z < 0) { ox = -ox; oz = -oz; }
      const length = Math.hypot(ox, oz);
      for (const top of [0, 1]) { position.push(x, (top - 0.5) * tall, z); normal.push(ox / length, 0, oz / length); uv.push(i / 6, top * 0.1); }
    }
    for (let i = 0; i < n; i += 1) { const a = i * 2; index.push(a, a + 2, a + 3, a, a + 3, a + 1, a, a + 3, a + 2, a, a + 1, a + 3); }
    const strap = new THREE.BufferGeometry();
    strap.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    strap.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    strap.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    strap.setIndex(index);
    const pair = seat(pallets.drums, 0, deck + 0.632, 0), add = frame(mat4(...pair.position, pair.rotation));
    add(strap, amberPaint);
    add(rbox(0.1, 0.05, 0.02, 0.004), metals.brushed, 0.04, 0, r + 0.011);
    add(box(0.075, 0.03, 0.012), metals.darkMetal, 0.05, 0.012, r + 0.026, [0.35, 0, 0]);
    add(cyl(0.012, 0.06, "y", 8), metals.darkMetal, -0.012, 0, r + 0.012);
    // Spill pallet under the waste drum: a moulded sump on three runners, a grating let into the top.
    const sump = frame(mat4(...bund.position, bund.rotation));
    sump(rbox(0.86, 0.065, 0.86, 0.015), yellowPaint, 0, 0.1225, 0, undefined, undefined, { shadow: true, hit: true });
    for (const x of [-0.365, 0, 0.365]) sump(rbox(0.13, 0.1, 0.86, 0.012), yellowPaint, x, 0.05, 0);
    for (const o of sides) {
      sump(rbox(0.86, 0.03, 0.035, 0.008), yellowPaint, 0, 0.165, o * 0.4125);
      sump(rbox(0.035, 0.03, 0.79, 0.008), yellowPaint, o * 0.4125, 0.165, 0);
    }
    sump(box(0.79, 0.006, 0.79), rubber, 0, 0.158, 0);
    for (let i = 0; i < 9; i += 1) sump(box(0.78, 0.011, 0.022), metals.darkMetal, 0, 0.1665, -0.32 + i * 0.08);
  }

  // Consumables delivered to the tool chest: cartons stacked beside it.
  const cartonBase = at(-9.03, 0, 0.6, facing(-1, 0.04)), cartonMid = seat(cartonBase, 0.02, props.get("cartonLarge").size[1], -0.01, -0.2);
  stock("cartonLarge", [{ ...cartonBase, variant: 2 }]);
  stock("carton", [{ ...cartonMid, variant: 1 }]);
  stock("cartonSmall", [{ ...seat(cartonMid, -0.03, props.get("carton").size[1], 0.02, 0.5), variant: 0 }]);
  stock("cartonTall", [{ ...at(-8.57, 0, 0.74, facing(-1, 0.14)), variant: 2 }]);

  // Pallet of lead bricks, the top course part used.
  const bricks: Transform[] = [];
  for (let layer = 0; layer < 4; layer += 1) for (let i = 0; i < 5; i += 1) for (let j = 0; j < 7; j += 1) {
    if (layer === 3 && (i > 2 || (i === 2 && j > 4))) continue;
    const shift = layer % 2 ? 0.012 : -0.012;
    bricks.push(at(pallets.lead.position[0] - 0.318 + j * 0.106 - shift, deck + 0.052 + layer * 0.102, pallets.lead.position[2] - 0.42 + i * 0.21 + shift, [0, Math.PI / 2 + ((i * 7 + j * 3 + layer) % 5 - 2) * 0.006, 0]));
  }
  instances(rbox(0.2, 0.1, 0.1, 0.012, 0.6), lead, bricks, true);
  // Transfer cask on its cradle.
  place(new THREE.Mesh(caskGeometry(), insulation), -8.3, 0.12, -22.6, true, true);
  instances(softBox(1.5, 0.12, 0.2, 0.02, 1.2), cranePaint, [-0.45, 0.45].map((o) => at(-8.3, 0.06, -22.6 + o)), false);
  const trunnion = new THREE.CylinderGeometry(0.09, 0.09, 1.46, 14);
  trunnion.rotateX(Math.PI / 2);
  place(new THREE.Mesh(trunnion, metals.darkMetal), -8.3, 1.42, -22.6, true);
  // ---- Shared small parts --------------------------------------------------
  type Add = ReturnType<typeof frame>;
  const TAU = Math.PI * 2;
  const lamp = (add: Add, x: number, y: number, z: number, material: THREE.Material, radius = 0.02) => {
    add(cyl(radius * 1.4, 0.02, "z", 10), metals.brushed, x, y, z + 0.01);
    add(new THREE.SphereGeometry(radius, 8, 5), material, x, y, z + 0.02, undefined, [1, 1, 0.6]);
  };
  const stopButton = (add: Add, x: number, y: number, z: number) => {
    add(cyl(0.05, 0.02, "z", 12), yellowPaint, x, y, z + 0.01);
    add(cyl(0.022, 0.04, "z", 10), metals.darkMetal, x, y, z + 0.035);
    add(cyl(0.04, 0.025, "z", 12, false, 0.03), redPaint, x, y, z + 0.065);
  };
  const board = (side: number, z: number, y: number, key: string, width: number) => {
    const add = wallFrame(side, z);
    add(box(width + 0.04, width / atlas.aspect[key] + 0.04, 0.006), metals.darkMetal, 0, y, 0.004);
    add(sign(key, width), signMaterial, 0, y, 0.009);
  };
  const anchor = (add: Add, x: number, y: number, z: number, w: number, h: number) => {
    add(box(w, h, 0.02), metals.structural, x, y, z);
    for (const sx of sides) for (const sy of sides) add(cyl(0.02, 0.03, "z", 6), metals.brushed, x + sx * (w / 2 - 0.05), y + sy * (h / 2 - 0.05), z + 0.015);
  };
  /** Fixed ladder climbing +y from the frame origin; the climber stands on +z. */
  const ladder = (add: Add, height: number, cageFrom = 2.3, standoff = 0.4) => {
    for (const x of [-0.22, 0.22]) add(box(0.012, height, 0.055), yellowPaint, x, height / 2, 0);
    for (let y = 0.3; y < height - 0.05; y += 0.3) add(cyl(0.012, 0.44, "x", 6, true), yellowPaint, 0, y, 0);
    for (let y = 0.6; y < height; y += 1.8) for (const x of [-0.22, 0.22]) add(box(0.03, 0.03, standoff), yellowPaint, x, y, -standoff / 2);
    if (cageFrom >= height) return;
    const hoop = new THREE.TorusGeometry(0.34, 0.012, 4, 12, Math.PI).rotateX(Math.PI / 2);
    for (let y = cageFrom; y <= height + 0.01; y += 0.85) add(hoop, yellowPaint, 0, y, 0.02, undefined, [1, 1, 1.9]);
    for (const t of [0.17, 0.5, 0.83]) add(box(0.03, height - cageFrom, 0.005), yellowPaint, 0.34 * Math.cos(t * Math.PI), (height + cageFrom) / 2, 0.02 + 0.646 * Math.sin(t * Math.PI), [0, Math.PI / 2 - t * Math.PI, 0]);
  };
  /** Bolted manway on a short neck; origin on the shell, +z outwards. */
  const manway = (add: Add, fine: Add, s: number, paint: THREE.Material) => {
    add(cyl(0.36 * s, 0.34, "z", 20), paint, 0, 0, 0.1);
    add(cyl(0.47 * s, 0.07, "z", 24), metals.structural, 0, 0, 0.27);
    add(cyl(0.47 * s, 0.05, "z", 24), paint, 0, 0, 0.33);
    add(new THREE.SphereGeometry(0.26 * s, 16, 5, 0, TAU, 0, Math.PI / 2).rotateX(Math.PI / 2), paint, 0, 0, 0.355, undefined, [1, 1, 0.3]);
    for (let k = 0; k < 16; k += 1) fine(cyl(0.022, 0.05, "z", 6), metals.brushed, Math.cos(k * TAU / 16) * 0.415 * s, Math.sin(k * TAU / 16) * 0.415 * s, 0.36);
    add(pipeRun([[0.56 * s, -0.3, 0.05], [0.56 * s, 0.42 * s, 0.05], [0.56 * s, 0.56 * s, 0.36], [0.06, 0.56 * s, 0.42]], 0.022, 0.1, 6), metals.structural);
    fine(cyl(0.012, 0.2 * s, "y", 6), metals.brushed, 0.06, 0.46 * s, 0.42);
    fine(pipeRun([[-0.12, -0.06, 0.35], [-0.12, -0.06, 0.44], [0.12, -0.06, 0.44], [0.12, -0.06, 0.35]], 0.012, 0.03, 6), metals.brushed);
  };
  const valveBody = lathe([[0.13, -0.3], [0.16, -0.26], [0.2, -0.13], [0.22, 0], [0.2, 0.13], [0.16, 0.26], [0.13, 0.3]], 14);

  // ---- Switchgear and local panels -----------------------------------------
  const cabinetNames = ["BUY MENU", "ROUND LOGIC", "CONSOLE"];
  [6.5, 7.42, 8.34].forEach((z, index) => {
    const add = wallFrame(1, z), fine = wallFrame(1, z, { fine: true });
    add(box(0.86, 0.1, 0.56), metals.darkMetal, 0, 0.05, 0.3);
    add(rbox(0.88, 1.95, 0.6, 0.015, 1.5), oldGreen, 0, 1.075, 0.3, undefined, undefined, { shadow: true, hit: true });
    add(box(0.8, 1.76, 0.008), rubber, 0, 1.1, 0.602);
    add(rbox(0.76, 1.72, 0.03, 0.01, 1.5), oldGreen, 0, 1.1, 0.615);
    for (const y of [0.45, 1.1, 1.75]) fine(cyl(0.014, 0.09, "y", 8), metals.brushed, -0.392, y, 0.625);
    add(cyl(0.03, 0.012, "z", 10), metals.brushed, 0.31, 1.0, 0.636);
    add(rbox(0.03, 0.17, 0.03, 0.008), metals.darkMetal, 0.31, 0.95, 0.655);
    add(box(0.56, 0.24, 0.012), metals.darkMetal, 0, 0.42, 0.632);
    for (let i = 0; i < 6; i += 1) fine(box(0.5, 0.01, 0.034), metals.structural, 0, 0.335 + i * 0.034, 0.645, [0.7, 0, 0]);
    add(sign(cabinetNames[index], 0.34), signMaterial, 0, 1.87, 0.632);
    [ledMint, ledMint, ledAmber, ledRed].forEach((material, i) => lamp(add, -0.24 + i * 0.16, 1.7, 0.63, material));
    if (index === 0) {
      for (const [x, name, turn] of [[-0.16, "KEVLAR", 0.5], [0.16, "HELMET", -0.6]] as Array<[number, string, number]>) {
        add(cyl(0.04, 0.02, "z", 14), metals.darkMetal, x, 1.47, 0.64);
        add(rbox(0.016, 0.075, 0.03, 0.005), metals.brushed, x, 1.47, 0.66, [0, 0, turn]);
        add(sign(name, 0.16), signMaterial, x, 1.385, 0.632);
      }
      for (let i = 0; i < 5; i += 1) {
        fine(cyl(0.013, 0.012, "z", 8), metals.brushed, -0.2 + i * 0.1, 1.24, 0.636);
        fine(cyl(0.006, 0.045, "z", 6), metals.brushed, -0.2 + i * 0.1, 1.24 + (i % 2 ? 0.01 : -0.01), 0.66, [i % 2 ? -0.5 : 0.5, 0, 0]);
      }
      add(sign("KIT  $400", 0.2), signMaterial, 0, 1.17, 0.632);
    } else if (index === 1) {
      gauge(add, -0.17, 1.44, 0.63, 0.105, "dial", 0.9);
      gauge(add, 0.17, 1.44, 0.63, 0.105, "dialT", -0.4);
      add(sign("BANK $", 0.18), signMaterial, -0.17, 1.29, 0.632);
      add(sign("TEAM HP", 0.18), signMaterial, 0.17, 1.29, 0.632);
      stopButton(add, 0, 1.14, 0.63);
      add(sign("FORCE BUY", 0.18), signMaterial, 0, 1.05, 0.632);
    } else {
      for (let r = 0; r < 3; r += 1) for (let c = 0; c < 4; c += 1) lamp(fine, -0.18 + c * 0.12, 1.52 - r * 0.09, 0.63, (r * 4 + c) % 5 === 0 ? ledAmber : (r + c) % 4 === 3 ? ledRed : ledMint, 0.014);
      add(sign("NET_GRAPH 1", 0.18), signMaterial, -0.13, 1.2, 0.632);
      add(sign("FPS_MAX 0", 0.18), signMaterial, 0.13, 1.2, 0.632);
      fine(sign("tag", 0.07), signMaterial, 0.31, 0.8, 0.68, [0.1, 0, 0.12]);
    }
    // Glands on top, and the cables rising to the tray.
    for (const i of [0, 1]) {
      const gx = i ? 0.12 : -0.12, tx = -0.15 + (index * 2 + i) * 0.06 - (z - 7.42);
      add(cyl(0.03, 0.06, "y", 8), metals.brushed, gx, 2.07, 0.3);
      add(pipeRun([[gx, 2.05, 0.3], [gx, 2.32, 0.3], [tx, 2.8, 0.1], [tx, 7.4, 0.1], [tx, 7.57, 0.4], [tx, 7.57, 0.84]], 0.02, 0.14, 6), cable);
    }
  });
  {
    const add = wallFrame(1, 7.42), fine = wallFrame(1, 7.42, { fine: true });
    for (const x of [-0.21, 0.21]) add(box(0.03, 4.9, 0.07), metals.brushed, x, 5.1, 0.07);
    for (let y = 2.8; y < 7.5; y += 0.3) fine(box(0.42, 0.02, 0.03), metals.brushed, 0, y, 0.06);
    // Sleeve where the ladder and its cables pass through the catwalk deck.
    add(rbox(0.6, 0.34, 0.24, 0.015), galvanised, 0, DECK_Y + 0.05, 0.11);
  }
  {
    // Local panel LP-07 with the loop mimic.
    const add = wallFrame(-1, -20.6), fine = wallFrame(-1, -20.6, { fine: true });
    for (const x of [-0.7, 0.7]) add(box(0.06, 1.0, 0.06), metals.structural, x, 0.5, 0.14);
    add(rbox(1.7, 1.25, 0.24, 0.015, 1.5), greyPaint, 0, 1.6, 0.14, undefined, undefined, { shadow: true, hit: true });
    add(box(1.78, 0.03, 0.36), metals.darkMetal, 0, 2.24, 0.18);
    add(sign("mimic", 1.4), signMaterial, 0, 1.8, 0.262);
    gauge(add, -0.62, 1.2, 0.26, 0.09, "dial", 0.7);
    gauge(add, -0.38, 1.2, 0.26, 0.09, "dial", -0.2);
    gauge(add, -0.14, 1.2, 0.26, 0.09, "dialT", 1.1);
    ["BANK $", "LOSS BONUS", "TEAM HP"].forEach((name, i) => add(sign(name, 0.17), signMaterial, -0.62 + i * 0.24, 1.065, 0.262));
    [ledMint, ledMint, ledAmber, ledRed].forEach((material, i) => lamp(add, 0.1 + i * 0.1, 1.25, 0.26, material));
    for (let i = 0; i < 4; i += 1) fine(cyl(0.018, 0.02, "z", 8), i < 2 ? metals.darkMetal : metals.brushed, 0.1 + i * 0.1, 1.13, 0.27);
    stopButton(add, 0.66, 1.18, 0.26);
    add(pipeRun([[0.5, 2.25, 0.1], [0.5, 4.75, 0.1], [0.5, 5.0, -0.05], [0.5, 5.25, -0.05]], 0.02, 0.1, 6), metals.brushed);
  }

  // ---- Wall-side equipment ------------------------------------------------
  {
    // Tool chest on castors with what the last shift left on it.
    const add = wallFrame(-1, -0.2), fine = wallFrame(-1, -0.2, { fine: true });
    add(rbox(0.9, 0.72, 0.48, 0.02), redPaint, 0, 0.5, 0.5, undefined, undefined, { shadow: true, hit: true });
    for (let i = 0; i < 5; i += 1) {
      add(box(0.84, 0.115, 0.012), redPaint, 0, 0.22 + i * 0.135, 0.745);
      fine(box(0.6, 0.016, 0.02), metals.brushed, 0, 0.255 + i * 0.135, 0.76);
    }
    add(box(0.94, 0.02, 0.52), metals.darkMetal, 0, 0.87, 0.5);
    for (const x of [-0.4, 0.4]) for (const z of [0.31, 0.69]) {
      add(cyl(0.05, 0.035, "x", 10), rubber, x, 0.05, z);
      fine(box(0.03, 0.06, 0.03), metals.structural, x, 0.11, z);
    }
    add(pipeRun([[-0.45, 0.7, 0.32], [-0.58, 0.7, 0.32], [-0.58, 0.7, 0.68], [-0.45, 0.7, 0.68]], 0.012, 0.04, 6), metals.brushed);
    fine(box(0.32, 0.012, 0.035), metals.brushed, -0.02, 0.888, 0.42, [0, 0.5, 0]);
    fine(cyl(0.016, 0.3, "x", 8), metals.structural, 0.18, 0.896, 0.62, [0, -0.3, 0]);
    fine(box(0.05, 0.03, 0.09), metals.darkMetal, 0.32, 0.895, 0.57);
    add(new THREE.SphereGeometry(0.115, 12, 6, 0, TAU, 0, Math.PI / 2), yellowPaint, -0.28, 0.88, 0.6, undefined, [1, 0.9, 1.2]);
    add(cyl(0.13, 0.01, "y", 12), yellowPaint, -0.28, 0.885, 0.63, undefined, [1, 1, 1.25]);
  }
  const extinguisher = lathe([[0, 0], [0.08, 0], [0.085, 0.02], [0.085, 0.42], [0.06, 0.5], [0.03, 0.53], [0.03, 0.57], [0, 0.57]], 12);
  {
    // Fire point 07.
    const add = wallFrame(1, 4.5);
    add(box(0.56, 0.9, 0.02), metals.darkMetal, 0, 1.1, 0.012);
    add(sign("fire", 0.4), signMaterial, 0, 2.05, 0.008);
    add(sign("ear", 0.34), signMaterial, -0.72, 1.95, 0.008);
    for (const x of [-0.14, 0.14]) {
      add(extinguisher, redPaint, x, 0.75, 0.13, undefined, undefined, { hit: true });
      add(box(0.2, 0.03, 0.16), metals.darkMetal, x, 0.74, 0.1);
      add(box(0.19, 0.03, 0.012), metals.brushed, x, 1.08, 0.215);
      add(box(0.035, 0.03, 0.13), metals.darkMetal, x, 1.335, 0.15);
      add(pipeRun([[x, 1.3, 0.13], [x + 0.1, 1.3, 0.13], [x + 0.1, 0.95, 0.15]], 0.012, 0.04, 6), rubber);
    }
  }
  {
    // Hose reel behind the barrier.
    const add = wallFrame(-1, 4.3);
    // Wall arm and spindle, a solid back flange, the hose wound on the drum and a spoked front flange it shows through.
    add(cyl(0.05, 0.22, "z", 10), metals.structural, 0, 1.5, 0.11);
    add(box(0.16, 0.5, 0.012), metals.structural, 0, 1.5, 0.006);
    add(cyl(0.36, 0.015, "z", 28), redPaint, 0, 1.5, 0.07);
    add(cyl(0.255, 0.155, "z", 24, true), rubber, 0, 1.5, 0.155);
    for (let i = 0; i < 4; i += 1) add(new THREE.TorusGeometry(0.262, 0.021, 6, 28), rubber, 0, 1.5, 0.095 + i * 0.038);
    const flange = lathe([[0.3, -0.008], [0.357, -0.008], [0.364, 0], [0.357, 0.008], [0.3, 0.008], [0.3, -0.008]], 28).rotateX(Math.PI / 2);
    add(flange, redPaint, 0, 1.5, 0.24);
    for (let i = 0; i < 4; i += 1) add(box(0.075, 0.24, 0.012).translate(0, 0.19, 0), redPaint, 0, 1.5, 0.24, [0, 0, 0.5 + i * Math.PI / 2]);
    add(cyl(0.09, 0.03, "z", 16), redPaint, 0, 1.5, 0.245);
    add(cyl(0.04, 0.02, "z", 12), metals.brushed, 0, 1.5, 0.265);
    for (let i = 0; i < 6; i += 1) add(cyl(0.008, 0.008, "z", 6), metals.brushed, Math.cos(i * Math.PI / 3) * 0.066, 1.5 + Math.sin(i * Math.PI / 3) * 0.066, 0.262, undefined, undefined, { fine: true });
    add(pipeRun([[0.3, 1.5, 0.155], [0.36, 1.1, 0.155], [0.36, 0.88, 0.17]], 0.02, 0.08, 6), rubber);
    add(cyl(0.024, 0.14, "y", 8, false, 0.012), metals.brushed, 0.36, 0.82, 0.17, [Math.PI, 0, 0]);
    add(sign("fire", 0.3), signMaterial, 0, 2.2, 0.008);
  }
  {
    // Eyewash station.
    const add = wallFrame(1, -8.8);
    add(cyl(0.03, 1.0, "y", 8), yellowPaint, 0, 0.5, 0.28);
    add(cyl(0.09, 0.02, "y", 12), yellowPaint, 0, 0.01, 0.28);
    add(lathe([[0.03, 0], [0.2, 0.07], [0.22, 0.1], [0.19, 0.1], [0.03, 0.04]], 16), oldGreen, 0, 1.0, 0.28);
    for (const x of [-0.07, 0.07]) add(cyl(0.012, 0.09, "y", 6), metals.brushed, x, 1.09, 0.28);
    add(cyl(0.02, 0.28, "z", 8), yellowPaint, 0, 0.9, 0.14);
    add(box(0.16, 0.1, 0.01), yellowPaint, 0.2, 1.02, 0.36, [0.5, 0, 0]);
    add(sign("eyewash", 0.36), signMaterial, 0, 1.95, 0.008);
  }
  {
    // Notice board by the hose reel; the sheets pinned to it are loose paper and hang with the motion.
    const add = wallFrame(-1, NOTICE_Z);
    add(rbox(0.9, 0.5, 0.014, 0.005), rubber, 0, 1.6, 0.009);
    for (const y of [1.345, 1.855]) add(box(0.92, 0.02, 0.022), metals.brushed, 0, y, 0.011);
    for (const x of [-0.455, 0.455]) add(box(0.02, 0.53, 0.022), metals.brushed, x, 1.6, 0.011);
  }
  board(1, -5.85, 2.15, "hot", 0.9);
  board(-1, -3.3, 2.15, "hot", 0.9);
  board(-1, -7.9, 2.3, "crane", 0.78);
  board(1, -7.75, 2.3, "crane", 0.78);
  board(-1, -26.7, 2.1, "zone", 0.8);
  board(-1, -6.56, 1.95, "UTILITY", 0.4);
  // The notices that used to hang only beyond the control wall, where nobody on the range could read them,
  // repeated on the hall's own walls: the site board behind the east barrier, the no-entry board over the
  // spares, the unit's data plate by the lead store, and the vent notice over a low extract grille.
  board(1, 0.1, 1.95, "zone", 0.9);
  board(-1, 2.5, 2.2, "noentry", 0.95);
  board(-1, -16.7, 1.64, "hatch", 0.9);
  {
    const add = wallFrame(-1, -16.7), fine = wallFrame(-1, -16.7, { fine: true });
    add(rbox(0.98, 0.68, 0.03, 0.008), metals.darkMetal, 0, 0.9, 0.017);
    add(box(0.86, 0.56, 0.006), rubber, 0, 0.9, 0.035);
    for (let i = 0; i < 8; i += 1) fine(box(0.86, 0.012, 0.06), metals.brushed, 0, 0.67 + i * 0.066, 0.05, [-0.6, 0, 0]);
    for (const x of [-0.45, 0.45]) for (const y of [0.6, 1.2]) fine(cyl(0.012, 0.008, "z", 6), metals.brushed, x, y, 0.034);
    const plate = wallFrame(1, 2.5);
    plate(box(0.68, 0.37, 0.012), metals.brushed, 0, 1.65, 0.008);
    plate(sign("vessel", 0.64), signMaterial, 0, 1.65, 0.016);
  }

  // Riser valves: cast bodies, bolted flanges, a gauge on a copper stub, wrapped markers, drip trays.
  risers.forEach(({ side, z, main }, index) => {
    const add = wallFrame(side, z), fine = wallFrame(side, z, { fine: true }), out = 0.24, material = mains[main].material;
    add(valveBody, metals.darkMetal, 0, 1.25, out, undefined, undefined, { hit: true });
    add(cyl(0.09, 0.2, "z", 10), metals.darkMetal, 0, 1.25, out + 0.2);
    add(cyl(0.13, 0.04, "z", 12), metals.structural, 0, 1.25, out + 0.26);
    for (const y of [0.95, 1.55]) for (let k = 0; k < 8; k += 1) fine(cyl(0.016, 0.11, "y", 6), metals.brushed, Math.cos(k * TAU / 8) * 0.165, y, out + Math.sin(k * TAU / 8) * 0.165);
    fine(cyl(0.014, 0.18, "z", 6), copper, 0, 1.95, out + 0.14);
    gauge(fine, 0, 1.95, out + 0.2, 0.075, index % 2 ? "dialT" : "dial", (index * 0.7) % 2 - 1);
    const key = material === tealPaint ? "feed" : material === amberPaint ? "return" : "air";
    world(pipeLabel(key, 0.136, 0.9, side > 0 ? Math.PI : 0, 2.2, false, true, true), signMaterial, side * 9.3, 2.9, z);
    for (const o of [-0.52, 0.52]) world(cyl(0.136, 0.07, "y", 16, true), whitePaint, side * 9.3, 2.9 + o, z);
    if (index % 3 === 0) fine(sign("tag", 0.07), signMaterial, 0.07, 1.02, 0.7, [0, 0, 0.1]);
  });
  for (const [side, z, w] of [[-1, -1.95, 1.5], [-1, 7.0, 0.8], [1, -4.625, 1.5], [1, 5.4, 0.8]]) {
    const add = wallFrame(side, z);
    add(worldBox(w, 0.012, 0.7, 1.5), galvanised, 0, 0.014, 0.42);
    for (const o of [0.07, 0.77]) add(box(w, 0.05, 0.015), galvanised, 0, 0.035, o);
    for (const x of [-w / 2, w / 2]) add(box(0.015, 0.05, 0.7), galvanised, x, 0.035, 0.42);
  }
  // Gas rack: five 50 L cylinders on a chequer plate in front of the kerb, held to a wall rail by a chain.
  {
    const gx = -9.19, mid = -6.56, gasZ = (i: number) => -7.1 + i * 0.27;
    const shell = lathe([[0, 0.012], [0.088, 0.012], [0.1, 0], [0.111, 0.004], [0.115, 0.03], [0.115, 1.14]], 20);
    const shoulder = lathe([[0.115, 1.14], [0.113, 1.19], [0.104, 1.24], [0.086, 1.283], [0.062, 1.31], [0.046, 1.322]], 20);
    const collar = lathe([[0.046, 1.322], [0.052, 1.327], [0.052, 1.358], [0.047, 1.364], [0.026, 1.364]], 14);
    const guardRing = new THREE.TorusGeometry(0.056, 0.0065, 6, 18).rotateX(Math.PI / 2);
    const turns = [0.15, -0.3, 0.05, 0.4, -0.12];
    for (let i = 0; i < 5; i += 1) {
      const z = gasZ(i), helium = i === 1 || i === 4, add = frame(mat4(gx, 0.012, z, [0, turns[i], 0]));
      add(shell, greyPaint, 0, 0, 0, undefined, undefined, { shadow: true, hit: true });
      add(shoulder, helium ? amberPaint : tealPaint);
      add(collar, metals.darkMetal);
      add(wrapLabel(helium ? "gasHe" : "gasAr", 0.117, 0.078, Math.PI / 2, 1.78), signMaterial, 0, 0.8, 0);
      // Valve: brass body with its outlet to the side and a handwheel, inside an open guard clamped to the collar.
      add(cyl(0.024, 0.05, "y", 10), copper, 0, 1.389, 0);
      add(rbox(0.044, 0.05, 0.044, 0.006), copper, 0, 1.432, 0);
      add(cyl(0.013, 0.036, "z", 8), copper, 0, 1.432, 0.038);
      add(cyl(0.007, 0.04, "y", 6), metals.brushed, 0, 1.47, 0);
      add(cyl(0.031, 0.012, "y", 12), metals.darkMetal, 0, 1.488, 0);
      add(cyl(0.059, 0.022, "y", 14, true), metals.structural, 0, 1.343, 0);
      for (let k = 0; k < 3; k += 1) { const a = k * TAU / 3 + 1; add(box(0.016, 0.172, 0.005), metals.structural, Math.sin(a) * 0.0575, 1.43, Math.cos(a) * 0.0575, [0, a, 0]); }
      add(guardRing, metals.structural, 0, 1.512, 0);
    }
    world(worldBox(0.29, 0.012, 1.5, 0.6), chequer, -9.18, 0.006, mid);
    for (const y of [0.55, 1.08]) {
      world(box(0.04, 0.04, 1.5), metals.structural, -9.33, y, mid);
      for (const z of [-7.26, mid, -5.86]) {
        world(box(0.19, 0.03, 0.04), metals.structural, -9.445, y, z);
        world(box(0.008, 0.11, 0.11), metals.darkMetal, WALL_X * -1 + 0.004, y, z);
      }
    }
    // The chain runs from one end arm to the other across the front of the cylinders.
    const chainX = -9.05, chainY = 1.08, ends = [-7.275, -5.845];
    for (const z of ends) {
      world(box(0.32, 0.035, 0.035), metals.structural, -9.19, chainY, z);
      world(new THREE.TorusGeometry(0.016, 0.004, 5, 10), metals.brushed, chainX, chainY - 0.03, z);
    }
    const links = 40, run = ends[1] - ends[0], sag = (t: number) => chainY - 0.045 - 0.04 * Math.sin(t * Math.PI);
    if (high) {
      const link = new THREE.TorusGeometry(0.011, 0.0032, 5, 10).rotateY(Math.PI / 2).scale(1, 1, 1.7);
      for (let k = 0; k < links; k += 1) { const t = (k + 0.5) / links; fineWorld(link, metals.brushed, chainX, sag(t), ends[0] + t * run, [0, 0, k % 2 ? Math.PI / 2 : 0]); }
    } else world(sweep(Array.from({ length: 9 }, (_, i) => new THREE.Vector3(chainX, sag(i / 8), ends[0] + (i / 8) * run)), 0.006, 5), metals.brushed);
  }

  // ---- Floor plates, fixings and wall lamps --------------------------------
  for (const side of sides) for (let i = 0; i < 31; i += 1) {
    const z = 8.9 - i * 1.2;
    if (side > 0 && z < -9.4 && z > -13.8) continue;
    world(worldBox(0.5, 0.01, 1.185, 0.6), chequer, side * 9.05, 0.004, z);
  }
  for (const side of sides) for (let i = 0; i < 24; i += 1) for (let j = 0; j < 8; j += 1) fineWorld(cyl(0.013, 0.014, "x", 6), metals.brushed, side * (WALL_X - 0.012), 0.5 + j * 0.55, 8.5 - i * 2.4);
  for (const side of sides) {
    for (const z of bracketZ) anchor(wallFrame(side, z, { fine: true }), 0, 4.92, -0.07, 0.3, 0.5);
    for (const z of pilasterZ) {
      anchor(wallFrame(side, z, { fine: true }), 0, trayY - 0.09, 0.29, 0.3, 0.3);
      world(box(0.5, 0.03, 0.7), metals.structural, side * 9.02, 9.815, z);
    }
  }
  // Caged bulkhead lamps on the upper walls, one per bay: warm against the cold flood. Their pools on
  // the concrete come from the fixture-light term in the shaders, not from cards.
  const bulkhead = (add: Add, fine: Add, y: number, out: number) => {
    add(rbox(0.2, 0.3, 0.05, 0.012), metals.darkMetal, 0, y, out + 0.025);
    add(new THREE.CapsuleGeometry(0.055, 0.12, 3, 10), lampWarm, 0, y, out + 0.085);
    const hoop = new THREE.TorusGeometry(0.075, 0.006, 4, 12).rotateX(Math.PI / 2);
    for (const o of [-0.07, 0, 0.07]) fine(hoop, metals.brushed, 0, y + o, out + 0.085);
    for (const x of [-0.075, 0.075]) fine(box(0.008, 0.24, 0.008), metals.brushed, x, y, out + 0.085);
  };
  const wallOut = WALL_X - CONCRETE_X;
  for (const side of sides) for (let bay = 0; bay < LAMP.count; bay += 1) {
    const z = LAMP.z0 - bay * LAMP.pitch, add = wallFrame(side, z), fine = wallFrame(side, z, { fine: true });
    bulkhead(add, fine, LAMP.y, wallOut);
    // Surface conduit up to a junction box under the tray arm.
    add(cyl(0.014, 0.42, "y", 6), metals.brushed, 0, LAMP.y + 0.36, wallOut + 0.03);
    add(rbox(0.14, 0.14, 0.07, 0.01), metals.darkMetal, 0, LAMP.y + 0.62, wallOut + 0.035);
  }

  // ---- Services: markers, copper line, sprinklers, back-wall duct ----------
  mains.forEach(({ x, y, radius, material }) => {
    const left = x < 0, key = material === tealPaint ? "feed" : material === amberPaint ? "return" : "air";
    for (const z of [1.75, -9.95, -21.9]) {
      world(pipeLabel(key, radius + 0.004, 1.9, left ? -0.5 : Math.PI + 0.5, 2.0, left, !left), signMaterial, x, y, z);
      for (const o of [-1.1, 1.1]) world(cyl(radius + 0.005, 0.1, "z", 16, true), whitePaint, x, y, z + o);
    }
  });
  {
    // Small-bore copper line on stand-offs with an expansion loop in every other bay.
    const cx = -9.08, cy = 6.5, points: V3[] = [[cx, cy, 9.5]];
    for (const z of [3, -9, -21]) points.push([cx, cy, z + 0.5], [cx, cy + 0.7, z + 0.5], [cx, cy + 0.7, z - 0.5], [cx, cy, z - 0.5]);
    points.push([cx, cy, -39.6]);
    world(pipeRun(points, 0.045, 0.16, 8), copper, 0, 0, 0, undefined, undefined, { shadow: true });
    for (let z = 8; z > -39; z -= 3) world(box(0.58, 0.03, 0.03), metals.structural, cx - 0.27, cy - 0.06, z);
  }
  {
    // Sprinkler main: riser with its stop valve by the back wall, two ranges under the beams.
    world(pipeRun([[-7.9, 0, 9.35], [-7.9, 12.56, 9.35], [-7.9, 12.56, 8.6], [3.2, 12.56, 8.6]], 0.045, 0.2, 8), redPaint);
    world(valveBody, redPaint, -7.9, 1.3, 9.35, undefined, [0.6, 0.6, 0.6]);
    world(valveWheelGeometry(0.13), redPaint, -7.9, 1.3, 9.05, [0, Math.PI / 2, 0]);
    for (const x of [-3.2, 3.2]) {
      world(cyl(0.04, 38.6, "z", 8, true), redPaint, x, 12.56, -10.7);
      for (let z = 8; z > -30; z -= 3) {
        fineWorld(cyl(0.014, 0.14, "y", 6), redPaint, x, 12.47, z);
        fineWorld(cyl(0.035, 0.02, "y", 8), metals.brushed, x, 12.39, z);
      }
    }
  }
  {
    // Extract duct along the back wall with louvred grilles and two risers through the roof.
    const dz = 9.29;
    world(worldBox(14.8, 0.8, 0.8, 1.5), galvanised, 0, 7.9, dz, undefined, undefined, { shadow: true });
    for (let x = -7.4; x <= 7.41; x += 1.85) {
      world(box(0.04, 0.88, 0.88), metals.structural, x, 7.9, dz);
      world(box(0.05, 0.05, 0.86), metals.structural, x, 7.46, dz);
    }
    for (const side of sides) {
      world(worldBox(0.8, 5.3, 0.8, 1.5), galvanised, side * 7.0, 10.95, dz, undefined, undefined, { shadow: true });
      for (const y of [9.2, 11.0, 12.8]) world(box(0.88, 0.04, 0.88), metals.structural, side * 7.0, y, dz);
      world(rbox(0.24, 0.32, 0.16, 0.02), greyPaint, side * 6.8, 9.75, dz - 0.48);
      world(cyl(0.016, 0.5, "x", 6), metals.brushed, side * 7.0, 9.5, dz - 0.44);
    }
    for (const x of [-5.4, -2.7, 0, 2.7, 5.4]) {
      world(box(1.2, 0.5, 0.03), metals.darkMetal, x, 7.9, 8.875);
      world(box(1.1, 0.42, 0.006), rubber, x, 7.9, 8.858);
      for (let i = 0; i < 7; i += 1) fineWorld(box(1.1, 0.012, 0.06), metals.brushed, x, 7.72 + i * 0.06, 8.845, [-0.6, 0, 0]);
    }
  }

  // ---- Crane detail --------------------------------------------------------
  openRig(bridge);
  for (const o of [-1, 1]) {
    for (const y of [10.48, 11.52]) world(box(17.7, 0.05, 0.62), cranePaint, 0, y, CRANE_Z + o);
    world(box(17.4, 0.05, 0.06), metals.darkMetal, 0, 11.57, CRANE_Z + o);
    for (let x = -8; x <= 8.01; x += 1.6) {
      // No stiffeners behind the load plate.
      if (Math.abs(x) > 7.3 || (o > 0 && x > -7.1 && x < -3.7)) continue;
      world(box(0.025, 0.96, 0.05), cranePaint, x, 11.0, CRANE_Z + o * 1.265);
    }
    for (const x of [-6.2, 1.2, 6.2]) {
      world(rbox(0.5, 0.12, 0.3, 0.02), metals.darkMetal, x, 10.4, CRANE_Z + o);
      world(box(0.42, 0.012, 0.22), glowWhite, x, 10.335, CRANE_Z + o);
    }
  }
  {
    // Maintenance walkway along the far girder, its rail low enough to pass under the sprinkler heads.
    world(gratingPanel(17.4, 0.6), gratingMaterial, 0, 11.5, CRANE_Z - 1.6);
    for (let i = 0; i < 9; i += 1) {
      world(cyl(0.02, 0.8, "y", 6), cranePaint, -8.4 + i * 2.1, 11.9, CRANE_Z - 1.9);
      world(box(0.05, 0.05, 0.7), metals.darkMetal, -8.4 + i * 2.1, 11.46, CRANE_Z - 1.6);
    }
    for (const y of [12.3, 11.9]) world(cyl(0.02, 17.4, "x", 6, true), cranePaint, 0, y, CRANE_Z - 1.9);
    for (const side of sides) {
      world(cyl(0.17, 0.5, "z", 14), metals.machine, side * 8.5, 10.72, CRANE_Z + 1.5);
      world(rbox(0.3, 0.34, 0.3, 0.02), metals.darkMetal, side * 8.62, 10.72, CRANE_Z + 1.12);
    }
    for (const [x, y, z] of craneBeacons) world(new THREE.CylinderGeometry(0.075, 0.085, 0.07, 14), metals.darkMetal, x, y - 0.075, CRANE_Z + z);
    // Pendant control hanging by the west wall, its buttons facing the range.
    openRig(pendantRig);
    world(cyl(0.012, 8.86, "y", 6, true), cable, pendantX, 7.17, CRANE_Z + 1.36);
    world(rbox(0.1, 0.36, 0.08, 0.02), cranePaint, pendantX, 2.56, CRANE_Z + 1.36);
    for (let i = 0; i < 6; i += 1) world(cyl(0.017, 0.014, "x", 8), cable, pendantX + 0.055, 2.69 - i * 0.052, CRANE_Z + 1.36);
    openRig(hookRig);
    for (const o of [-0.158, 0.158]) world(box(0.5, 0.16, 0.012), chevrons, hookX, blockY - 0.22, CRANE_Z + o);
    openRig(null);
  }
  // Ladder to the east catwalk.
  ladder(frame(mat4(8.1, 0, -26.4, [0, -Math.PI / 2, 0])), deckY + 1.1, 2.4, 0.07);

  // ---- Vessel detail -------------------------------------------------------
  const R = CORE.radius, ribStep = TAU / 28;
  const coreFrame = (angle: number, y: number, radius: number, opt: Opt = {}) => frame(mat4(CORE.x + Math.sin(angle) * radius, y, CORE.z + Math.cos(angle) * radius, [0, angle, 0]), opt);
  for (const y of [3.0, 5.7, CORE.top - 0.06]) for (let k = 0; k < 96; k += 1) {
    const a = k * TAU / 96;
    if (Math.cos(a) < -0.35) continue;
    fineWorld(cyl(0.034, 0.34, "y", 6), metals.brushed, CORE.x + Math.sin(a) * (R + 0.13), y, CORE.z + Math.cos(a) * (R + 0.13));
  }
  for (const k of [-4, -1, 2]) manway(coreFrame((k + 0.5) * ribStep, 4.3, R - 0.02), coreFrame((k + 0.5) * ribStep, 4.3, R - 0.02, { fine: true }), 0.9, vesselPaint);
  [-6, -3, 1, 4, 7].forEach((k, i) => {
    const a = (k + 0.5) * ribStep, add = coreFrame(a, 3.65, R - 0.02), fine = coreFrame(a, 3.65, R - 0.02, { fine: true });
    add(cyl(0.06, 0.34, "z", 10), vesselPaint, 0, 0, 0.15);
    add(cyl(0.11, 0.06, "z", 12), metals.structural, 0, 0, 0.3);
    if (i % 2 === 0) gauge(add, 0, 0, 0.33, 0.15, i % 4 ? "dialT" : "dial", i - 1.2);
    else {
      add(rbox(0.16, 0.2, 0.13, 0.02), greyPaint, 0, 0, 0.4);
      add(cyl(0.075, 0.2, "x", 12), greyPaint, 0, 0.02, 0.4);
      fine(pipeRun([[0.05, -0.1, 0.4], [0.05, -0.6, 0.4], [0.05, -0.75, 0.25], [0.05, -0.95, 0.25]], 0.012, 0.05, 6), copper);
    }
  });
  {
    const add = coreFrame(-1.5 * ribStep, 5.0, R + 0.02);
    add(box(0.84, 0.44, 0.012), metals.brushed, 0, 0, -0.004);
    add(sign("vessel", 0.8), signMaterial, 0, 0, 0.004);
    for (const [angle, key, width] of [[-0.5 * ribStep, "hatch", 1.1], [0.52, "zone", 0.95]] as Array<[number, string, number]>) {
      const height = width / atlas.aspect[key], mount = coreFrame(angle, 1.5, shieldAt(1.5 - height / 2) + 0.06);
      mount(box(width + 0.05, height + 0.05, 0.016), metals.darkMetal);
      mount(sign(key, width), signMaterial, 0, 0, 0.014);
      for (const x of [-width / 2 + 0.1, width / 2 - 0.1]) mount(box(0.04, height * 0.7, 0.12), metals.structural, x, 0, -0.06);
    }
  }
  ladder(coreFrame(5 * ribStep, 2.7, R + 0.62), 7.5, 2.3, 0.45);
  // Chequer-plate gallery deck with a kick plate, and the stair up to it.
  {
    const deck = new THREE.RingGeometry(R + 0.22, 6.1, 72, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < deck.attributes.uv.count; i += 1) deck.attributes.uv.setXY(i, deck.attributes.position.getX(i) / 0.6, deck.attributes.position.getZ(i) / 0.6);
    world(deck, chequer, CORE.x, CORE.base + 0.09, CORE.z);
    world(cyl(5.9, 0.12, "y", 72, true), metals.structural, CORE.x, CORE.base + 0.16, CORE.z);
    const SX = 2.65, n = 13, rise = (CORE.base + 0.09) / n, go = 0.215, z0 = -30.75, slope = Math.atan2(rise, go), run = Math.hypot(n * go, n * rise), mid = z0 - (n - 1) * go / 2;
    for (let i = 0; i < n; i += 1) world(worldBox(0.9, 0.03, 0.25, 0.6), chequer, SX, (i + 1) * rise - 0.015, z0 - i * go, undefined, undefined, { shadow: true });
    world(worldBox(0.94, 0.03, 0.6, 0.6), chequer, SX, n * rise - 0.015, z0 - n * go - 0.15);
    for (const x of [SX - 0.47, SX + 0.47]) {
      world(box(0.03, 0.24, run), metals.structural, x, n * rise / 2 - 0.1, mid, [slope, 0, 0], undefined, { shadow: true });
      for (const h of [1.05, 0.55]) world(cyl(0.022, run, "y", 8, true), yellowPaint, x, n * rise / 2 + h, mid, [slope - Math.PI / 2, 0, 0]);
      for (const i of [0, 4, 8, 12]) world(cyl(0.022, 1.05, "y", 8), yellowPaint, x, (i + 0.5) * rise + 0.5, z0 - i * go + go / 2);
    }
  }
  // Warm lamps round the shield.
  for (const a of SHIELD_LAMPS) bulkhead(coreFrame(a, 1.75, shieldAt(1.6) - 0.004), coreFrame(a, 1.75, shieldAt(1.6) - 0.004, { fine: true }), 0, 0);
  // Exchanger towers: manway, caged ladder, level glass, head platform.
  for (const side of sides) {
    const tower = (a: number, y: number, radius: number, opt: Opt = {}) => frame(mat4(side * towerX + Math.sin(a) * radius, y, towerZ + Math.cos(a) * radius, [0, a, 0]), opt);
    manway(tower(0, 2.7, 1.23), tower(0, 2.7, 1.23, { fine: true }), 0.8, insulation);
    ladder(tower(-side * 0.75, 0.2, 1.7), 8.8, 2.4, 0.45);
    const glass = tower(side * 0.6, 0, 1.25);
    for (const y of [4.0, 6.4]) { glass(cyl(0.035, 0.3, "z", 8), metals.structural, 0, y, 0.12); glass(cyl(0.045, 0.07, "y", 8), metals.brushed, 0, y, 0.27); }
    glass(cyl(0.028, 2.4, "y", 8, true), levelGlow, 0, 5.2, 0.27);
    tower(0, 6.2, 1.262)(sign(side < 0 ? "SILO 1" : "SILO 2", 1.1), signMaterial);
    const head = new THREE.RingGeometry(1.26, 2.05, 32, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < head.attributes.uv.count; i += 1) head.attributes.uv.setXY(i, head.attributes.position.getX(i) / 0.6, head.attributes.position.getZ(i) / 0.6);
    world(head, chequer, side * towerX, 9.0, towerZ, undefined, undefined, { shadow: true });
    world(cyl(2.03, 0.1, "y", 32, true), metals.structural, side * towerX, 9.06, towerZ);
    for (const y of [9.55, 10.05]) world(new THREE.TorusGeometry(2.0, 0.022, 6, 40).rotateX(Math.PI / 2), yellowPaint, side * towerX, y, towerZ);
    for (let k = 0; k < 10; k += 1) world(cyl(0.022, 1.05, "y", 6), yellowPaint, side * towerX + Math.sin(k * TAU / 10) * 2.0, 9.53, towerZ + Math.cos(k * TAU / 10) * 2.0);
    // Relief stub on the head: the steam plume leaves from here.
    world(cyl(0.07, 0.6, "y", 10), metals.brushed, side * towerX, 10.32, towerZ);
    world(cyl(0.12, 0.05, "y", 12), metals.structural, side * towerX, 10.2, towerZ);
    world(cyl(0.1, 0.04, "y", 12, false, 0.07), metals.darkMetal, side * towerX, 10.62, towerZ);
  }
  // Main coolant pumps on the vessel floor.
  for (const side of sides) {
    const px = side * 7.9, pz = -33.8, hot = side < 0 ? amberPaint : tealPaint, cold = side < 0 ? tealPaint : amberPaint;
    const add = frame(mat4(px, 0, pz), { shadow: true }), fine = frame(mat4(px, 0, pz), { fine: true });
    add(worldBox(1.7, 0.14, 1.7, 0.6), chequer, 0, 0.07, 0);
    add(lathe([[0, 0.14], [0.5, 0.14], [0.72, 0.3], [0.78, 0.55], [0.72, 0.8], [0.5, 0.95], [0.42, 1.0], [0.42, 1.08]], 24), oldGreen);
    add(cyl(0.34, 0.5, "y", 16), metals.darkMetal, 0, 1.33, 0);
    add(cyl(0.385, 0.3, "y", 16, true), yellowPaint, 0, 1.3, 0);
    add(cyl(0.52, 0.06, "y", 20), metals.structural, 0, 1.6, 0);
    add(lathe([[0.44, 1.63], [0.5, 1.68], [0.5, 3.0], [0.44, 3.06], [0.38, 3.1], [0.38, 3.3], [0.3, 3.36], [0, 3.36]], 24), greyPaint);
    for (let k = 0; k < 24; k += 1) {
      const a = k * TAU / 24;
      add(box(0.025, 1.2, 0.07), greyPaint, Math.cos(a) * 0.53, 2.35, Math.sin(a) * 0.53, [0, Math.PI / 2 - a, 0], undefined, { shadow: false });
      if (k % 2 === 0) fine(cyl(0.025, 0.1, "y", 6), metals.brushed, Math.cos(a) * 0.47, 1.6, Math.sin(a) * 0.47);
    }
    add(rbox(0.3, 0.36, 0.22, 0.02), greyPaint, 0, 2.5, 0.6);
    add(sign(side < 0 ? "P-250" : "P-2000", 0.28), signMaterial, 0, 2.5, 0.714, undefined, undefined, { shadow: false });
    const toCore = new THREE.Vector3(CORE.x - px, 0, CORE.z - pz).normalize(), from = new THREE.Vector3(px, 0.55, pz);
    pipeBetween(from.clone().addScaledVector(toCore, 0.6), from.clone().addScaledVector(toCore, 3.5), 0.26, cold);
    world(pipeRun([[px + side * 0.6, 0.55, pz], [side * 9.05, 0.55, pz], [side * 9.05, 4.3, pz], [side * 9.05, 4.3, -40.4], [side * 8.5, 4.3, -41.3]], 0.2, 0.5, 12), hot, 0, 0, 0, undefined, undefined, { shadow: true });
    world(valveBody, metals.darkMetal, side * 9.05, 1.7, pz, undefined, [1.5, 1.5, 1.5]);
    world(valveWheelGeometry(0.24), redPaint, side * 9.05, 1.7, pz + 0.62, [0, -Math.PI / 2, 0]);
  }
  // Shield blocks with lifting eyes, and the tray the resin drums stand on, on the vessel floor.
  const shieldBlock = rbox(1.4, 0.7, 0.7, 0.03, 2.4), eye = new THREE.TorusGeometry(0.07, 0.014, 5, 10, Math.PI);
  for (const [x, y, z, turn] of [[-8.35, 0.35, -30.95, 0.03], [-8.3, 0.35, -31.75, -0.02], [-8.32, 1.05, -31.35, 0.05]]) {
    world(shieldBlock, shieldConcrete, x, y, z, [0, turn, 0], undefined, { shadow: true, hit: true });
    for (const o of [-0.42, 0.42]) world(eye, metals.structural, x + o, y + 0.35, z);
  }
  world(worldBox(1.7, 0.05, 1.7, 1.5), galvanised, 8.15, 0.025, -31.3);
  // Boards on the fence, a kick plate under it.
  world(box(18.5, 0.12, 0.012), yellowPaint, 0, 0.07, fenceZ);
  for (const [x, key, width, y] of [[-4.6, "noentry", 0.95, 0.83], [4.6, "zone", 0.9, 1.0]] as Array<[number, string, number, number]>) {
    world(box(width + 0.06, width / atlas.aspect[key] + 0.06, 0.02), metals.darkMetal, x, y, fenceZ + 0.035);
    world(sign(key, width), signMaterial, x, y, fenceZ + 0.048);
  }

  // ---- Floor stencils (one transparent mesh) --------------------------------
  {
    const stencil = (key: string, width: number, x: number, z: number, turn: number) => sign(key, width).rotateX(-Math.PI / 2).rotateY(turn).translate(x, 0.016, z);
    // Storage bays: three painted sides running out from the kerb and what the bay is for, read from the lane.
    const stripe = (x0: number, z0: number, x1: number, z1: number) =>
      remap(new THREE.PlaneGeometry(Math.hypot(x1 - x0, z1 - z0), 0.07), "bayline").rotateX(-Math.PI / 2).rotateY(Math.atan2(z0 - z1, x1 - x0)).translate((x0 + x1) / 2, 0.016, (z0 + z1) / 2);
    const bays: Array<[side: number, from: number, to: number, front: number, key: string, inside: boolean]> = [
      [-1, 9.46, 7.74, 7.95, "bayD", true], [-1, 3.56, 0.98, 7.95, "bayP", true], [-1, -2.74, -4.98, 8.36, "bayD", false],
      [1, 2.82, 1.28, 8.08, "bayP", false], [1, -7.14, -8.52, 8.52, "bayD", false], [1, -18.45, -22.45, 7.96, "bayP", true],
    ];
    const bayMarks = bays.flatMap(([side, from, to, front, key, inside]) => [
      stripe(side * 9.33, from, side * (front + 0.035), from), stripe(side * 9.33, to, side * (front + 0.035), to), stripe(side * front, from + 0.035, side * front, to - 0.035),
      stencil(key, 1.25, side * (front + (inside ? 0.19 : -0.19)), (from + to) / 2, -side * Math.PI / 2),
    ]);
    const floorMarks = new THREE.Mesh(mergeGeometries([
      stencil("keepclear", 2.4, 8.25, 7.42, -Math.PI / 2), stencil("keepclear", 2.0, -8.4, -20.6, Math.PI / 2), stencil("keepclear", 1.6, 8.3, 4.5, -Math.PI / 2),
      stencil("laydown", 4.4, -3.4, -31.7, 0), stencil("laydown", 2.1, 8.22, -14.72, -Math.PI / 2), ...bayMarks,
    ]), decal(atlas.texture, 0xffffff, 0.78));
    floorMarks.receiveShadow = true;
    floorMarks.renderOrder = 2;
    scene.add(floorMarks);
    kit.mirrorHidden.push(floorMarks);
  }

  // ---- Furnace -------------------------------------------------------------
  // Its flue is short and turns into a plenum on the wall, under the catwalk, instead of climbing
  // through the deck and the crane rail.
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 0.6);
  {
    const add = wallFrame(1, -12.65);
    add(rbox(0.94, 0.5, 0.72, 0.02, 1.4), metals.machine, 0, 4.3, 0.34, undefined, undefined, { shadow: true });
    add(box(1.0, 0.05, 0.76), metals.structural, 0, 4.07, 0.35);
    add(box(0.7, 0.3, 0.012), metals.darkMetal, 0, 4.3, 0.706);
    for (let i = 0; i < 5; i += 1) add(box(0.66, 0.012, 0.05), metals.brushed, 0, 4.2 + i * 0.05, 0.722, [0.6, 0, 0], undefined, { fine: true });
    for (const x of [-0.42, 0.42]) for (const y of [4.12, 4.48]) add(cyl(0.02, 0.03, "z", 6), metals.brushed, x, y, 0.71, undefined, undefined, { fine: true });
  }

  flush();

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xb9d6e6, 0x1c2426, 0.28));
  const sun = kit.sunLight({ color: 0xe2f0ff, intensity: 9, toSun: TO_LAMP, extent: 32, distance: 46, near: 6, far: 84, radius: 2.2 });
  sun.target.position.set(0, 0, -18);
  sun.position.copy(sun.target.position).addScaledVector(TO_LAMP, 46);
  const fills = [SLOTS[0], SLOTS[1], SLOTS[2]].map((z, index) => {
    const fill = new THREE.PointLight(0xd3e8ff, 210, 34, 2);
    fill.position.set(index === 1 ? 3.6 : -3.6, 12.3, z);
    scene.add(fill);
    return fill;
  });
  const coreLight = new THREE.PointLight(0x2fd0ff, 240, 40, 2);
  coreLight.position.set(CORE.x, 8.2, CORE.z + CORE.radius + 2.4);
  scene.add(coreLight);
  const coreAir: Glow = { position: new THREE.Vector3(CORE.x, 8.2, CORE.z + CORE.radius + 0.6), color: new THREE.Color() };
  kit.updates.push((now) => {
    const seconds = now / 1000;
    // The core breathes over about nine seconds, with a faint faster shimmer.
    const breath = 0.8 + 0.2 * Math.sin(seconds * 0.7) + 0.03 * Math.sin(seconds * 3.1);
    coreGlow.color.copy(CORE_CYAN).multiplyScalar(3.2 * breath);
    portGlow.color.copy(CORE_CYAN).multiplyScalar(1.1 + 1.1 * breath);
    coreLight.intensity = 240 * breath;
    coreAir.color.copy(CORE_CYAN).multiplyScalar(1.3 * breath);
  });

  // ---- Motion --------------------------------------------------------------
  // A sealed plant has no weather. What moves here is the plant: one faint draught down the hall towards
  // the vessel (the map's one wind, shared with the life kit and the plants), and everything else on
  // clocks of its own, counted in seconds from the first frame.
  const wind = createWind({ heading: 0, strength: 0.16, gustiness: 0.5 });
  const life = createLife(kit, options, { wind, seed: 3 });
  const trees = createTrees(kit, { seed: 3, wind, sun });
  /** Adds something that is only light, vapour or water: no collision, not in the floor mirror or the probe. */
  const show = <T extends THREE.Object3D>(object: T, parent: THREE.Object3D = scene) => {
    object.userData.walkThrough = true;
    parent.add(object);
    kit.mirrorHidden.push(object);
    kit.probeHidden.push(object);
    return object;
  };
  const cuePlaces = Array.from({ length: 8 }, () => new THREE.Vector3()), voice = { gain: 1, pitch: 1 };
  let cuePlace = 0;
  /** A located sound, when the game has given the map a voice. */
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => {
    if (!options.cue) return;
    voice.gain = gain; voice.pitch = pitch;
    options.cue(name, cuePlaces[cuePlace = (cuePlace + 1) % cuePlaces.length].set(x, y, z), voice);
  };
  /** Repeatable 0..1 from any number: timers and pitches that do not sound stamped. */
  const chance = (n: number) => { const value = Math.sin(n * 127.1 + 31.7) * 43758.5453; return value - Math.floor(value); };
  const beats = new Float64Array(16).fill(NaN);
  /** True on the frame a counter that runs with the clock passes a whole number. */
  const beat = (slot: number, value: number) => {
    const count = Math.floor(value), was = beats[slot];
    beats[slot] = count;
    return was === was && count !== was;
  };
  const quadIndex = (quads: number) => Array.from({ length: quads }, (_, i) => [i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3]).flat();

  // ---- Steam ---------------------------------------------------------------
  // Hot plant weeps: a slow plume stands over each riser valve gland and over the relief valves on the
  // mains. The reliefs also blow on timers of their own: a clunk, then a hard jet across the hall that
  // takes a couple of seconds to thin out. One mesh; every card turns about its own run to face the eye.
  const steamTime = { value: 0 };
  {
    type Vent = { at: V3; half: number; height: number; strength: number; dir?: V3; every?: number; phase?: number };
    const vents: Vent[] = [
      { at: [-9.1, 1.4, -1.95], half: 0.55, height: 2.6, strength: 0.95 },
      { at: [9.1, 1.4, -4.62], half: 0.55, height: 2.6, strength: 0.95 },
      { at: [-8.85, 8.4, -15.8], half: 0.6, height: 2.6, strength: 1.0 },
      { at: [8.52, 8.9, -4.1], half: 0.45, height: 2.0, strength: 0.8 },
      ...RELIEFS.map((relief, i) => ({ ...relief, half: 0.85 - i * 0.05, height: 6.2 - i * 0.4, strength: 2.8 })),
    ];
    const position: number[] = [], uv: number[] = [], anchor: number[] = [], shape: number[] = [], run: number[] = [], burst: number[] = [];
    vents.forEach((vent, i) => {
      const dir = new THREE.Vector3(...(vent.dir ?? [0, 1, 0])).normalize();
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        position.push(vent.at[0] + (u - 0.5) * 2 * vent.half, vent.at[1] + v * vent.height, vent.at[2]);
        uv.push(u, v);
        anchor.push(...vent.at);
        shape.push(vent.half, vent.height, i * 1.37 + 0.2, vent.strength);
        run.push(dir.x, dir.y, dir.z);
        burst.push(vent.every ?? 0, vent.phase ?? 0, JET_SECONDS);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute("anchor", new THREE.Float32BufferAttribute(anchor, 3));
    geometry.setAttribute("shape", new THREE.Float32BufferAttribute(shape, 4));
    geometry.setAttribute("run", new THREE.Float32BufferAttribute(run, 3));
    geometry.setAttribute("burst", new THREE.Float32BufferAttribute(burst, 3));
    geometry.setIndex(quadIndex(vents.length));
    const steam = new THREE.ShaderMaterial({
      uniforms: { time: steamTime, tint: { value: new THREE.Color(0.72, 0.86, 0.94) } },
      vertexShader: /* glsl */`
        attribute vec3 anchor;
        attribute vec4 shape;
        attribute vec3 run;
        attribute vec3 burst;
        uniform float time;
        varying vec2 vUv;
        varying vec2 vSeed;
        varying vec2 vJet;
        void main() {
          vUv = uv;
          vSeed = shape.zw;
          float open = 1.0, reach = 1.0;
          if (burst.x > 0.0) {
            // A relief valve: shut, then it snaps open, blows for its time and the cloud it left thins out.
            float since = mod(time + burst.y, burst.x);
            open = smoothstep(0.0, 0.12, since) * (1.0 - smoothstep(burst.z, burst.z + 1.8, since));
            reach = mix(0.2, 1.0, smoothstep(0.0, 0.45, since));
          }
          vJet = vec2(burst.x > 0.0 ? 1.0 : 0.0, open);
          vec3 right = normalize(cross(run, cameraPosition - anchor) + vec3(0.0001));
          vec3 at = anchor + right * ((uv.x - 0.5) * 2.0 * shape.x) + run * (uv.y * shape.y * reach);
          gl_Position = projectionMatrix * viewMatrix * vec4(at, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float time;
        uniform vec3 tint;
        varying vec2 vUv;
        varying vec2 vSeed;
        varying vec2 vJet;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) { float sum = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { sum += noise(p) * a; p = p * 2.03 + 7.1; a *= 0.5; } return sum / 0.9375; }
        void main() {
          if (vJet.y < 0.004) discard;
          // A weep climbs at a walk; a jet tears along its card.
          float rise = time * mix(0.2, 1.9, vJet.x);
          vec2 q = vec2(vUv.x * 2.4 + vSeed.x * 13.0, vUv.y * mix(2.6, 3.4, vJet.x) - rise + vSeed.x * 7.0);
          float billow = fbm(q + vec2(fbm(q * 0.7 + vec2(0.0, rise * 0.4)) * 0.9, 0.0));
          // The plume leans and widens as it goes, and thins out before the end of its card.
          float sway = (fbm(vec2(vUv.y * 1.5 - rise * 0.6, vSeed.x * 3.0)) - 0.5) * mix(0.5, 0.22, vJet.x) * vUv.y;
          float body = 1.0 - smoothstep(0.0, mix(mix(0.1, 0.05, vJet.x), 0.5, sqrt(vUv.y)), abs(vUv.x - 0.5 - sway));
          float fade = smoothstep(0.0, mix(0.07, 0.02, vJet.x), vUv.y) * pow(clamp(1.0 - vUv.y, 0.0, 1.0), mix(1.3, 0.55, vJet.x));
          float cloud = mix(smoothstep(0.2, 0.7, billow), 0.5 + 0.5 * smoothstep(0.15, 0.6, billow), vJet.x);
          float alpha = clamp(body * fade * cloud * vSeed.y * vJet.y, 0.0, mix(0.85, 0.94, vJet.x));
          gl_FragColor = vec4(mix(tint, vec3(0.9, 0.96, 1.0), vJet.x) * (0.75 + billow * 0.5), alpha);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = show(new THREE.Mesh(geometry, steam));
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
  }
  // The exchanger heads beside the vessel vent all the time: the library's puffs, bending with the draught.
  life.plume("steam", [[-7.55, 10.6, CORE.z - 2.6], [7.55, 10.6, CORE.z - 2.6]], { rise: 2.8, size: [0.5, 2.4], opacity: 0.42 });

  // ---- Extract fans ---------------------------------------------------------
  // Daylight stands behind each rotor, so the blades are dark shapes turning on a bright disc, and the
  // light they chop lands on the floor as a pool with their shadows going round in it. Neither is a real
  // shadow (the sun's map is rendered once): the rotor turns in its vertex shader and the pool is drawn.
  const fanTurn = { value: 0 };
  {
    const dark = new THREE.Color(0.012, 0.016, 0.02), sky = new THREE.Color(0.78, 0.93, 1).multiplyScalar(2.4), shade = new THREE.Color();
    const dress = (geometry: THREE.BufferGeometry, fan: (typeof FANS)[number], speed: number, lit: boolean) => {
      const at = geometry.attributes.position, colour = new Float32Array(at.count * 3), spin = new Float32Array(at.count * 3);
      for (let i = 0; i < at.count; i += 1) {
        const out = Math.hypot(at.getX(i), at.getZ(i)) / 1.14;
        if (lit) shade.copy(sky).multiplyScalar(1 - 0.4 * out * out); else shade.copy(dark);
        colour.set([shade.r, shade.g, shade.b], i * 3);
        spin.set([fan.x, fan.z, speed], i * 3);
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
      geometry.setAttribute("spin", new THREE.BufferAttribute(spin, 3));
      return geometry.translate(fan.x, 0, fan.z);
    };
    const parts: THREE.BufferGeometry[] = [];
    for (const fan of FANS) {
      parts.push(dress(new THREE.CircleGeometry(1.14, 40).rotateX(Math.PI / 2).translate(0, CEILING - 0.03, 0), fan, 0, true));
      parts.push(dress(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 16).translate(0, CEILING - 0.3, 0), fan, fan.speed, false));
      for (let k = 0; k < 6; k += 1) {
        // A pitched plate, narrow at the boss and broad at the tip.
        const blade = new THREE.BoxGeometry(0.94, 0.012, 0.44), at = blade.attributes.position;
        for (let i = 0; i < at.count; i += 1) at.setZ(i, at.getZ(i) * (0.55 + 0.6 * (at.getX(i) + 0.47) / 0.94));
        blade.rotateX(Math.sign(fan.speed) * 0.42).translate(0.65, CEILING - 0.3, 0).rotateY(k * TAU / 6);
        parts.push(dress(blade, fan, fan.speed, false));
      }
    }
    const rotor = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide, alphaTest: 0.01 });
    rotor.onBeforeCompile = (shader) => {
      shader.uniforms.fanTurn = fanTurn;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec3 spin;\nuniform float fanTurn;")
        .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
          {
            float turned = fanTurn * spin.z;
            vec2 arm = transformed.xz - spin.xy, way = vec2(cos(turned), sin(turned));
            transformed.xz = spin.xy + vec2(way.x * arm.x - way.y * arm.y, way.y * arm.x + way.x * arm.y);
          }`);
    };
    rotor.customProgramCacheKey = () => "reactor-fan";
    const rotors = new THREE.Mesh(mergeGeometries(parts)!, rotor);
    parts.forEach((part) => part.dispose());
    rotors.userData.walkThrough = true;
    scene.add(rotors);

    const half = 1.9, position: number[] = [], uv: number[] = [], turns: number[] = [];
    for (const fan of FANS) {
      // Where the lamp's light through the duct meets the floor.
      const x = fan.x - TO_LAMP.x * (CEILING / TO_LAMP.y), z = fan.z - TO_LAMP.z * (CEILING / TO_LAMP.y);
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { position.push(x + (u * 2 - 1) * half, 0.02, z + (v * 2 - 1) * half); uv.push(u, v); turns.push(fan.speed); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute("turns", new THREE.Float32BufferAttribute(turns, 1));
    geometry.setIndex(quadIndex(FANS.length).map((i, k) => (k % 3 === 1 ? i + 1 : k % 3 === 2 ? i - 1 : i)));
    const pool = new THREE.ShaderMaterial({
      uniforms: { fanTurn, tint: { value: new THREE.Color(0.6, 0.8, 1).multiplyScalar(0.85) } },
      vertexShader: /* glsl */`
        attribute float turns;
        varying vec2 vPool;
        varying float vTurns;
        void main() {
          vPool = uv * 2.0 - 1.0;
          vTurns = turns;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float fanTurn;
        uniform vec3 tint;
        varying vec2 vPool;
        varying float vTurns;
        void main() {
          float away = length(vPool);
          // Six blades and the boss, as soft as a shadow thrown thirteen metres is.
          float blades = smoothstep(-0.35, 0.45, sin((atan(vPool.y, vPool.x) - fanTurn * vTurns) * 6.0 + away * 1.5));
          float light = (1.0 - smoothstep(0.45, 1.0, away)) * smoothstep(0.06, 0.24, away) * mix(0.22, 1.0, blades);
          gl_FragColor = vec4(tint * light, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    show(new THREE.Mesh(geometry, pool)).renderOrder = 2;
  }

  // ---- Beacons and the kerb chase ---------------------------------------------
  // Each beacon is a dome that flares as its beam crosses the eye, two crossed blades of lit air that
  // turn with the beam, and the patch the beam sweeps over the wall beside it. All additive, one mesh for
  // the hall's six and one that rides the crane and only runs while it is about to move or moving.
  const hallTurn = { value: 0 }, craneTurn = { value: 0 }, cranePower = { value: 0 };
  {
    const BEAM = 3;
    const tint = { value: new THREE.Color(1, 0.5, 0.08) };
    const beacons = (lamps: V3[], phases: number[], walls: Array<[lamp: number, corners: V3[]]>, turn: { value: number }, power: { value: number }) => {
      const position: number[] = [], centre: number[] = [], mode: number[] = [], index: number[] = [];
      const vertex = (lamp: V3, x: number, y: number, z: number, kind: number, phase: number, u: number, v: number) => {
        position.push(x, y, z); centre.push(...lamp); mode.push(kind, phase, u, v);
        return position.length / 3 - 1;
      };
      const dome = new THREE.SphereGeometry(0.068, 12, 5, 0, TAU, 0, Math.PI / 2), domeAt = dome.attributes.position, domeIndex = dome.index!;
      lamps.forEach((lamp, i) => {
        const first = position.length / 3;
        for (let k = 0; k < domeAt.count; k += 1) vertex(lamp, domeAt.getX(k), domeAt.getY(k) * 1.9 - 0.045, domeAt.getZ(k), 0, phases[i], 0, 0);
        for (let k = 0; k < domeIndex.count; k += 1) index.push(first + domeIndex.getX(k));
        for (const [dy, dz] of [[0, 1], [1, 0]]) {
          index.push(
            vertex(lamp, 0.05, 0, 0, 1, phases[i], 0.5, 0),
            vertex(lamp, BEAM, -dy * 0.46, -dz * 0.46, 1, phases[i], 0, 1),
            vertex(lamp, BEAM, dy * 0.46, dz * 0.46, 1, phases[i], 1, 1),
          );
        }
      });
      dome.dispose();
      for (const [i, corners] of walls) {
        const lamp = lamps[i], first = position.length / 3;
        corners.forEach(([x, y, z], k) => vertex(lamp, x - lamp[0], y - lamp[1], z - lamp[2], 2, phases[i], k === 0 || k === 3 ? -1 : 1, k < 2 ? -1 : 1));
        index.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute("centre", new THREE.Float32BufferAttribute(centre, 3));
      geometry.setAttribute("mode", new THREE.Float32BufferAttribute(mode, 4));
      geometry.setIndex(index);
      const material = new THREE.ShaderMaterial({
        uniforms: { beaconTurn: turn, beaconPower: power, beaconTint: tint },
        vertexShader: /* glsl */`
          attribute vec3 centre;
          attribute vec4 mode;
          uniform float beaconTurn;
          varying vec4 vMode;
          varying vec3 vOffset;
          varying float vFlare;
          void main() {
            vMode = mode;
            float angle = beaconTurn + mode.y;
            vec2 beam = vec2(cos(angle), sin(angle));
            // The blades of lit air are modelled along +x and turn with the beam; the rest stays put.
            vec3 offset = mode.x > 0.5 && mode.x < 1.5 ? vec3(beam.x * position.x - beam.y * position.z, position.y, beam.y * position.x + beam.x * position.z) : position;
            vOffset = offset;
            vec3 lamp = (modelMatrix * vec4(centre, 1.0)).xyz;
            vFlare = pow(max(dot(beam, normalize(cameraPosition.xz - lamp.xz + vec2(0.0001))), 0.0), 24.0);
            gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(centre + offset, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 beaconTint;
          uniform float beaconPower;
          uniform float beaconTurn;
          varying vec4 vMode;
          varying vec3 vOffset;
          varying float vFlare;
          void main() {
            float light;
            if (vMode.x < 0.5) {
              light = 0.3 + beaconPower * 8.0 * vFlare;
            } else if (vMode.x < 1.5) {
              float across = abs(vMode.z - 0.5) / max(vMode.w, 0.02);
              light = beaconPower * 0.8 * (1.0 - smoothstep(0.08, 0.5, across)) * pow(clamp(1.0 - vMode.w, 0.0, 1.0), 1.6) * smoothstep(0.0, 0.06, vMode.w);
            } else {
              float angle = beaconTurn + vMode.y, away = length(vOffset.xz);
              float aim = max(dot(vOffset.xz / max(away, 0.001), vec2(cos(angle), sin(angle))), 0.0);
              float lift = vOffset.y / (0.3 + 0.4 * away), spread = exp(-lift * lift);
              float edge = (1.0 - smoothstep(0.55, 1.0, abs(vMode.z))) * (1.0 - smoothstep(0.55, 1.0, abs(vMode.w)));
              light = beaconPower * 2.6 * pow(aim, 22.0) * spread * edge / (1.0 + away * away * 1.2);
            }
            gl_FragColor = vec4(beaconTint * light, 1.0);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      return mesh;
    };
    /** A patch of side wall (x fixed) or back wall (z fixed) for a beam to cross. */
    const sideWall = (x: number, z0: number, z1: number, y0: number, y1: number): V3[] => [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]];
    const backWall = (z: number, x0: number, x1: number, y0: number, y1: number): V3[] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
    const upper = CONCRETE_X - 0.012, lower = WALL_X - 0.012;
    show(beacons(beaconSpots, [0, 2.1, 4.0, 0.9, 3.0, 5.2], [
      ...sides.map((side, i): [number, V3[]] => [i, sideWall(side * lower, fenceZ - 2.4, fenceZ + 2.4, 0.5, 2.7)]),
      ...sides.map((side, i): [number, V3[]] => [2 + i, sideWall(side * upper, walkFrom - 3, walkFrom + 3.8, DECK_Y - 0.4, DECK_Y + 3)]),
      ...sides.map((side, i): [number, V3[]] => [4 + i, sideWall(side * upper, 5.4, 8.54, DECK_Y - 0.4, DECK_Y + 3)]),
      ...sides.map((side, i): [number, V3[]] => [4 + i, backWall(BACK_Z - 0.012, side * 9.6, side * 4.8, DECK_Y - 0.4, DECK_Y + 3)]),
    ], hallTurn, { value: 1 }));
    show(beacons(craneBeacons, [0, Math.PI], sides.map((side, i): [number, V3[]] => [i, sideWall(side * upper, craneBeacons[i][2] - 3.2, craneBeacons[i][2] + 3.2, 8.6, 12)]), craneTurn, cranePower), bridge);
  }
  // The kerb status strips run a chase: a pulse leaves the back wall on each side in turn and runs the
  // length of the hall. The strips' light on the floor and the kerb follows it (see the fixture light);
  // this is the pulse itself, drawn over the strips.
  let entered = 0;
  {
    const parts = sides.map((side) => {
      const part = new THREE.BoxGeometry(0.034, 0.042, hallLength).translate(side * 9.466, 0.44, hallMid);
      part.setAttribute("wall", new THREE.BufferAttribute(new Float32Array(part.attributes.position.count).fill(side), 1));
      return part;
    });
    const chase = new THREE.ShaderMaterial({
      uniforms: { practicalLive },
      vertexShader: /* glsl */`
        attribute float wall;
        varying float vWall;
        varying float vAlong;
        void main() {
          vWall = wall;
          vAlong = position.z;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 practicalLive;
        varying float vWall;
        varying float vAlong;
        ${chaseGlsl}
        void main() {
          gl_FragColor = vec4((vWall < 0.0 ? vec3(1.0, 0.5, 0.14) : vec3(0.3, 1.0, 0.82)) * (5.0 * kerbChase(vAlong, vWall, practicalLive.x)), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = show(new THREE.Mesh(mergeGeometries(parts)!, chase));
    parts.forEach((part) => part.dispose());
    mesh.frustumCulled = false;
    // Whatever camera draws this strip is the player's: the first time it moves, somebody has come in.
    const seen = [0, 0, 0, 0];
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      if (entered > 0) return;
      const e = camera.matrixWorld.elements;
      if (entered < 0 && Math.abs(e[12] - seen[0]) + Math.abs(e[14] - seen[1]) + Math.abs(e[8] - seen[2]) + Math.abs(e[9] - seen[3]) > 0.002) { entered = 1; return; }
      seen[0] = e[12]; seen[1] = e[14]; seen[2] = e[8]; seen[3] = e[9];
      entered = -1;
    };
  }

  // ---- Drips ------------------------------------------------------------------
  // Condensation lets go of two glazing bars under the first roof slot and falls the height of the hall;
  // the west riser valve drips into its tray. Each has a drop that falls under gravity and rings that run
  // out from where it lands. One mesh; the clock in the shader is the clock the sound is cued from.
  const dripTime = { value: 0 };
  const drips = [
    { x: -6.75, top: CEILING - 0.25, z: 3.3, floor: 0.02, every: 7.3, phase: 2, size: 0.42, gain: 0.7 },
    { x: 6.75, top: CEILING - 0.25, z: 6.3, floor: 0.02, every: 10.9, phase: 6.5, size: 0.42, gain: 0.7 },
    { x: -9.1, top: 1.14, z: -2.3, floor: 0.03, every: 5.2, phase: 1, size: 0.26, gain: 0.5 },
  ].map((drip) => ({ ...drip, fall: Math.sqrt(2 * (drip.top - drip.floor) / 9.81) }));
  {
    const uv: number[] = [], site: number[] = [], timing: number[] = [];
    for (const drip of drips) for (const kind of [0, 1]) for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      uv.push(u, v);
      site.push(drip.x, drip.top, drip.z, drip.floor);
      timing.push(drip.every, drip.phase, kind, kind ? drip.size : 0.024);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(drips.length * 24), 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute("site", new THREE.Float32BufferAttribute(site, 4));
    geometry.setAttribute("timing", new THREE.Float32BufferAttribute(timing, 4));
    geometry.setIndex(quadIndex(drips.length * 2));
    const water = new THREE.ShaderMaterial({
      uniforms: { dripTime },
      vertexShader: /* glsl */`
        attribute vec4 site;     // x, height it falls from, z, height it lands at
        attribute vec4 timing;   // seconds between drops, phase, 0 drop | 1 rings, size
        uniform float dripTime;
        varying vec2 vUv;
        varying vec2 vDrip;
        void main() {
          vUv = uv;
          float fall = sqrt(2.0 * (site.y - site.w) / 9.81), since = mod(dripTime + timing.y, timing.x);
          vec3 at;
          if (timing.z < 0.5) {
            // The drop: a streak as long as the distance it covers in a blink.
            float t = min(since, fall), stretch = 0.018 + 9.81 * t * 0.011;
            vec2 toEye = normalize(cameraPosition.xz - site.xz + vec2(0.0001));
            at = vec3(site.x, site.y - 4.905 * t * t, site.z) + vec3(toEye.y, 0.0, -toEye.x) * ((uv.x - 0.5) * timing.w) + vec3(0.0, (uv.y - 0.5) * 2.0 * stretch, 0.0);
            vDrip = vec2(0.0, since < fall ? 1.0 : 0.0);
          } else {
            at = vec3(site.x + (uv.x - 0.5) * 2.0 * timing.w, site.w, site.z + (uv.y - 0.5) * 2.0 * timing.w);
            vDrip = vec2(1.0, since - fall);
          }
          gl_Position = projectionMatrix * viewMatrix * vec4(at, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        varying vec2 vDrip;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          if (vDrip.x < 0.5) {
            float core = (1.0 - smoothstep(0.0, 1.0, abs(p.x))) * (1.0 - smoothstep(0.3, 1.0, abs(p.y)));
            gl_FragColor = vec4(vec3(0.8, 0.95, 1.0) * 1.4, core * 0.8 * vDrip.y);
          } else {
            // A dark wet patch, and two rings running out from where the last drop landed.
            float away = length(p), age = vDrip.y, rings = 0.0;
            if (age > 0.0) {
              float live = max(1.0 - age / 1.7, 0.0), first = (away - age * 0.5) / 0.045, second = (away - age * 0.3) / 0.04;
              rings = live * (exp(-first * first) + 0.5 * exp(-second * second));
            }
            float wet = (1.0 - smoothstep(0.2, 0.75, away)) * 0.24;
            gl_FragColor = vec4(mix(vec3(0.004, 0.006, 0.008), vec3(0.55, 0.78, 0.9), clamp(rings, 0.0, 1.0)), max(wet, rings * 0.55) * (1.0 - smoothstep(0.8, 1.0, away)));
          }
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = show(new THREE.Mesh(geometry, water));
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
  }

  // ---- Small life ---------------------------------------------------------------
  // The failing wash tube: its own glow and the light it throws on the wall go out together.
  const tubeBase = failingTube.color.clone();
  life.flicker((level) => { failingTube.color.copy(tubeBase).multiplyScalar(level); practicalLive.value.y = level; }, "tube", { at: [-WASH.x, WASH.y, FAIL_TUBE_Z] });
  // Moths that came in through a roof vent and found it.
  life.insects([[-8.9, WASH.y - 0.26, FAIL_TUBE_Z - 0.7], [-8.9, WASH.y - 0.28, FAIL_TUBE_Z + 0.6]], { kind: "moths", count: 7, color: new THREE.Color(1.7, 1.55, 1.25) });
  // Sparrows that did the same, on the catwalk handrails of the first bay (clear of the crane's run): they go
  // up at a shot and when the crane's alarm goes, and flit about under the first roof slot until it is quiet.
  // Sparrows and a small roam because the library's birds overshoot what they chase by metres and know
  // nothing of walls: a pigeon's turning circle does not fit in this hall.
  const perches = [{ z: [-5, 0.8], x: -8.17 }, { z: [-2.6, 2.2], x: 8.17 }];
  life.birds("sparrow", {
    perches: perches.map(({ x, z }) => ({ from: [x, DECK_Y + 1.124, z[0]], to: [x, DECK_Y + 1.124, z[1]], thin: true })),
    count: 8,
    roam: { x: [-1.5, 1.5], y: [8, 8.8], z: [-2.5, 0.5] },
    // The hall has no way in: a newcomer comes up the length of it out of the haze, not through a wall.
    from: [0, 8.4, -30],
  });
  // The library's birds leave a perch straight away from what frightened them and do not avoid walls, and
  // on these rails "away" from anybody in the hall is into the concrete. So each rail is told the fright
  // came from behind its own wall, with a reach that covers that rail alone: they break out over the hall.
  const frightAt = new THREE.Vector3();
  const scatter = (_at: THREE.Vector3, loudness: number) => {
    if (loudness < 0.3) return;
    for (const { x, z } of perches) life.startle(frightAt.set(Math.sign(x) * 13, DECK_Y + 1.1, (z[0] + z[1]) / 2), 0.22);
  };
  {
    // Three sheets pinned by their heads to the notice board, lifting in the draught.
    const notices = track(noticeTexture());
    notices.anisotropy = anisotropy;
    const paper = practical(new THREE.MeshStandardMaterial({ map: notices, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.01 }));
    const sheets = [-0.27, 0.005, 0.275].map((x, k) => {
      const sheet = new THREE.PlaneGeometry(0.21, 0.297, 6, 10), uv = sheet.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) uv.setX(i, (k + uv.getX(i)) / 3);
      // The pin is the origin; the foot stands a few centimetres off the board so the sheet has room to move.
      return sheet.translate(0, -0.1485, 0).rotateZ([0.025, -0.02, 0.03][k]).rotateX(-0.1).translate(x, 1.775, 0.02);
    });
    const mesh = show(new THREE.Mesh(mergeGeometries(sheets)!.applyMatrix4(mat4(-WALL_X, 0, NOTICE_Z, [0, Math.PI / 2, 0])), paper));
    sheets.forEach((sheet) => sheet.dispose());
    mesh.receiveShadow = true;
    life.cloth(paper, { amplitude: 0.05, pin: "top", lean: 0.2, flutter: 0.6 });
  }
  // The only planting on the unit: somebody's bay tree behind the east barrier, and what has seeded itself
  // in the damp round the west drip tray. They take the fixture light like everything else.
  for (const mesh of [
    ...trees.place("potLaurel", [{ at: [9.08, 0, -1.02], variant: 0, scale: 1.08, yaw: 0.6 }]),
    ...trees.place("weeds", [{ at: [-8.7, 0, -2.62], variant: 0, yaw: 0.4 }, { at: [-8.72, 0, -1.26], variant: 1, yaw: 2.1 }, { at: [-8.69, 0, -1.9], variant: 0, yaw: 3.3, scale: 0.8 }]),
    ...trees.place("grass", [{ at: [-8.71, 0, -2.3], variant: 0, yaw: 1.2 }, { at: [-8.7, 0, -1.55], variant: 0, yaw: 4 }]),
  ]) {
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (!lit.has(material)) { lit.add(material); practical(material); }
  }

  // ---- The crane travels, and the clock ------------------------------------------
  // The headline: every minute or so the bridge crane sounds its alarm, spins up its beacons and travels
  // between its two stops, the hook block and the pendant swinging behind it as it pulls away and running
  // on as it brakes. Heard before it moves; the first run comes a few seconds after somebody arrives.
  const HOOK_FALL = 3.2, PENDANT_FALL = 9;
  const crane = { at: CRANE_STOPS[0], speed: 0, phase: 0, legs: 0, next: 12, until: 0, blip: 0, motor: 0, rattle: -1, spin: 0, hook: 0, hookRate: 0, pendant: 0, pendantRate: 0 };
  const cranePlace = new THREE.Vector3();
  let began = -1, last = 0;
  kit.updates.push((now) => {
    if (began < 0) began = now;
    const seconds = (now - began) / 1000, step = THREE.MathUtils.clamp(seconds - last, 0, 0.05);
    last = seconds;
    steamTime.value = seconds;
    dripTime.value = seconds;
    fanTurn.value = seconds * 2.2;
    hallTurn.value = seconds * 2.4;
    practicalLive.value.x = (seconds * CHASE.speed) % CHASE.span;

    // A relay closes as each kerb's pulse leaves the back wall.
    const lap = seconds * CHASE.speed / CHASE.span;
    if (beat(0, lap)) say("relayClack", -9.2, 0.6, 9, 0.5, 0.94 + chance(lap) * 0.12);
    if (beat(1, lap + 0.5)) say("relayClack", 9.2, 0.6, 9, 0.5, 0.94 + chance(lap + 0.5) * 0.12);
    // The reliefs: the valve clunks, then the jet.
    for (let i = 0; i < RELIEFS.length; i += 1) {
      const relief = RELIEFS[i], turn = (seconds + relief.phase) / relief.every;
      if (beat(2 + i * 2, turn + 0.4 / relief.every)) say("valveClunk", relief.at[0], relief.at[1], relief.at[2], 0.8, 0.9 + chance(turn) * 0.2);
      if (beat(3 + i * 2, turn)) say("steamHiss", relief.at[0], relief.at[1], relief.at[2], 1, 0.92 + chance(turn + 0.3) * 0.16);
    }
    // Each drop is heard as it lands.
    for (let i = 0; i < drips.length; i += 1) {
      const drip = drips[i];
      if (beat(6 + i, (seconds + drip.phase - drip.fall) / drip.every)) say("drip", drip.x, drip.floor, drip.z, drip.gain, 0.85 + chance(seconds + i) * 0.3);
    }

    if (entered === 1) { entered = 2; crane.next = Math.min(crane.next, seconds + 5); }
    if (crane.phase === 0 && seconds >= crane.next) {
      // Warning: alarm and beacons for a moment before anything moves; the sparrows know what it means.
      crane.phase = 1;
      crane.legs += 1;
      crane.until = seconds + 2.5;
      crane.blip = seconds;
      crane.motor = seconds + 1.5;
      scatter(cranePlace.set(0, 10.5, crane.at), 1);
    }
    if (crane.phase > 0) {
      if (seconds >= crane.blip) { crane.blip = seconds + (crane.phase === 1 ? 1.1 : 2.3); say("alarmBlip", -7.4, 10.3, crane.at + 1, 0.85, 1); }
      if (seconds >= crane.motor) { crane.motor = seconds + 3.7; say("craneMotor", 0, 11, crane.at, 1, 0.96 + chance(seconds) * 0.08); }
    }
    let push = 0;
    if (crane.phase === 1 && seconds >= crane.until) { crane.phase = 2; crane.rattle = seconds + 0.7; }
    if (crane.phase === 2 && step > 0) {
      // Pull away, cruise, and brake in time to stop on the mark.
      const target = CRANE_STOPS[crane.legs % 2], room = target - crane.at;
      const want = Math.sign(room) * Math.min(CRANE_CRUISE, Math.sqrt(2 * CRANE_ACCEL * Math.abs(room)));
      const change = THREE.MathUtils.clamp(want - crane.speed, -CRANE_ACCEL * step, CRANE_ACCEL * step);
      crane.speed += change;
      crane.at += crane.speed * step;
      push = change / step;
      if (Math.abs(target - crane.at) < 0.012) {
        // On the mark: the brake bites, the structure creaks and the hook runs on.
        crane.hookRate -= crane.speed / HOOK_FALL;
        crane.at = target; crane.speed = 0; crane.phase = 0;
        crane.next = seconds + 38 + 34 * chance(crane.legs);
        crane.rattle = seconds + 0.9;
        say("metalCreak", 0, 11, crane.at, 0.8, 0.9 + chance(crane.legs * 7) * 0.2);
      }
    }
    if (crane.rattle > 0 && seconds >= crane.rattle) { crane.rattle = -1; say("chainRattle", hookX, 8.6, crane.at, 0.6, 0.94 + chance(seconds) * 0.12); }
    crane.spin = THREE.MathUtils.clamp(crane.spin + (crane.phase > 0 ? 1.4 : -0.5) * step, 0, 1);
    craneTurn.value += step * 2.4 * crane.spin;
    cranePower.value = crane.spin;
    // The block on its falls and the pendant on its cable are pendulums hung from a support that speeds
    // up and slows down; the pendant, light and long, also stirs in the draught.
    crane.hookRate += (push / HOOK_FALL - (9.81 / HOOK_FALL) * Math.sin(crane.hook) - 0.09 * crane.hookRate) * step;
    crane.hook += crane.hookRate * step;
    crane.pendantRate += (0.5 * push / PENDANT_FALL + (wind.at(pendantX, crane.at) - 0.16) * 0.1 - (9.81 / PENDANT_FALL) * Math.sin(crane.pendant) - 0.5 * crane.pendantRate) * step;
    crane.pendant += crane.pendantRate * step;
    bridge.position.z = crane.at;
    hookRig.rotation.x = crane.hook;
    pendantRig.rotation.x = crane.pendant;
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 620, x: 18, y: [0.2, 11], z: [-34, 8], color: 0xdff1ff, opacity: 0.24 });

  const probe = new THREE.Vector3();
  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: [coreAir],
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: 0x05090b, fog: 0x0b1416, fogDensity: high ? 0.006 : 0.012,
      haze: new THREE.Color(0.016, 0.03, 0.036), hazeDensity: 0.022, hazeCeiling: 13, hazeFade: 1.5,
      environmentIntensity: 1.2, exposure: 1, far: 130,
    },
    sunlitAt(point) {
      const t = (CEILING - point.y) / TO_LAMP.y;
      if (t <= 0) return 0;
      probe.copy(point).addScaledVector(TO_LAMP, t);
      const acrossX = 1 - THREE.MathUtils.smoothstep(Math.abs(probe.x), SLOT_HALF.x - 0.4, SLOT_HALF.x);
      let lit = 0;
      for (const z of SLOTS) lit = Math.max(lit, 1 - THREE.MathUtils.smoothstep(Math.abs(probe.z - z), SLOT_HALF.z - 0.4, SLOT_HALF.z));
      return lit * acrossX;
    },
    probeAt: new THREE.Vector3(0, 2.6, -9),
  });
  // Gunfire sends the sparrows up, and a hit on one of them is the life kit's to deal with.
  return { ...range, startle: scatter, struck: life.struck };
}

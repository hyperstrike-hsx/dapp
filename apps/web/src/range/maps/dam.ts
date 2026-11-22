import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { canvasTexture, createKit, hazardTexture, jerseyBarrier, softBox, sunlitFromBoxes, worldBox, type RangeEnvironment, type RangeOptions } from "../kit";
import { createProps } from "../props";
import { createLife } from "../life";
import { createTrees, type TreeItem } from "../trees";
import { createWind } from "../wind";
import type { Glow } from "../volumetric";

// Spillway: the apron at the foot of a dam in a rock gorge.
//
// The range lies on the concrete apron between the tailrace (west, behind a training wall that drops
// to a railed kerb beside the firing line) and the powerhouse (east). Beyond the far end the apron
// ends at the stilling basin, and over everything stands the dam: fifty-five metres of mass concrete
// leaning back between the gorge walls, five radial gates under its crest bridge, the middle one open
// and running white down the chute into the basin, whose spray the wind carries east across the range.
//
// Light: a clear day with the sun behind the player's left shoulder, so the dam face and the
// powerhouse wall are lit, the control building throws its shadow over the firing line and the west
// rock stands dark behind the spray. Only the range itself is inside the sun's shadow map; what the
// piers and the crest bridge shade on the dam is baked into its vertex colours.
//
// Motion: the chute, the basin and the tailrace are scrolling shaders; the spray is plumes from the
// life library leaning with the shared wind; swifts hawk over the water and crows sit on the hand
// rails; a beacon turns on the end pier of the training wall, the open gate's lamp flashes, the
// windsock on the control building follows the gusts and the davit's hook swings over the tailrace.

type V3 = [number, number, number];

/** The sun of the sky photograph, and the turn that puts it behind the player's left shoulder. */
const HDR_SUN = new THREE.Vector3(0.535, 0.725, 0.433);
const SKY_TURN = -1.676;
const TO_SUN = HDR_SUN.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), SKY_TURN).normalize();

const WALL_X = 9.54;
/** Top of the tailrace training wall, and where it drops to the kerb beside the firing line. */
const WEST_TOP = 4.5;
const OPEN_Z = -8.6;
/** The end pier of the wall: flush with its face, and long enough to carry the alarm bulkhead the game hangs at z = -7.7. */
const PIER = { z0: -8.6, z1: -7.2, x: -9.99, top: 5 };
const KERB = 0.42;
const APRON_END = -42;
const POWER = { top: 10.2, x1: 26, z0: -44, z1: 12 };
const DOOR = { z0: -8.4, z1: -1.6, top: 5.4 };
const BACK = { z: 9.7, top: 7.6, depth: 8 };
const WATER_Y = -2;
const CHANNEL = { x0: -26, x1: -10.14 };
const BASIN = { x0: -50, x1: 10, z0: -70 };
/** The dam: its downstream face passes through z = toe at ground level and leans back by `batter` per metre. */
const DAM = { toe: -70, batter: 0.32, crest: 55, half: 80, sill: 44, deck: 58.2 };
const GATES = [-44, -32, -20, -8, 4];
const OPEN_GATE = 2;
const TOWER = { x: 16, z0: -70.5, z1: -66, top: 55 };
const faceZ = (y: number) => DAM.toe - DAM.batter * y;
const SLANT = Math.atan(DAM.batter);
/** The spillway crest falls away from the gate sill as a parabola that meets the face at a tangent. */
const OGEE = { k: 0.1129, reach: 13.84 };
/** Where the rotating beacon stands, and the lamp of the running gate. */
const BEACON: V3 = [PIER.x, PIER.top + 0.5, (PIER.z0 + PIER.z1) / 2];
const GATE_LAMP: V3 = [GATES[OPEN_GATE], DAM.deck + 0.9, -80.2];

const YELLOW = 0xd9a21c, ORANGE = 0xe2571c, RED = 0xb02c1a, WHITE = 0xd9dcd8, GREY = 0x7f8a8c, BLUE = 0x3d6b78, BLACK = 0x111315;
const STEEL = 0x8d9698, DARK = 0x33393c, PIPE = 0xb8c0b4, TANK = 0x65766e, GLAZE = 0x5a2f1c;

const TAU = Math.PI * 2;
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const smooth = (a: number, b: number, value: number) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function rng(seed: number) {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash1 = (n: number, seed: number) => { const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return s - Math.floor(s); };
/** Smooth value noise along a line, 0..1. */
const vnoise = (x: number, seed: number) => { const i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f); return hash1(i, seed) * (1 - t) + hash1(i + 1, seed) * t; };

const mat4 = (x = 0, y = 0, z = 0, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale));
const box = (w: number, h: number, d: number, metres = 2.4) => worldBox(w, h, d, metres);
/** Cylinder along an axis; `top` is the radius at its +axis end. */
function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 10, top = radius) {
  const geometry = new THREE.CylinderGeometry(top, radius, length, segments);
  if (axis === "x") geometry.rotateZ(-Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  return geometry;
}
const UP = new THREE.Vector3(0, 1, 0);
/** A straight bar between two points: round, or square when `radial` is 4. */
function rod(a: V3, b: V3, radius: number, radial = 6) {
  const from = new THREE.Vector3(...a), dir = new THREE.Vector3(...b).sub(from), length = dir.length();
  const geometry: THREE.BufferGeometry = radial === 4 ? new THREE.BoxGeometry(radius * 2, length, radius * 2) : new THREE.CylinderGeometry(radius, radius, length, radial, 1, true);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return geometry;
}
/** A pipe or cable through points. */
function pipe(points: V3[], radius: number, radial = 8, steps = points.length * 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, "centripetal");
  return new THREE.TubeGeometry(curve, steps, radius, radial, false);
}
/** A level rectangle whose texture runs in world metres. */
function flat(x0: number, x1: number, z0: number, z1: number, y: number, metres = 3.2) {
  const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) uv.setXY(i, position.getX(i) / metres, -position.getZ(i) / metres);
  return geometry;
}
/** A rectangle on the dam's leaning face, `proud` metres in front of it. */
function faceQuad(x0: number, x1: number, y0: number, y1: number, proud = 0, metres = 6) {
  const geometry = new THREE.PlaneGeometry(x1 - x0, (y1 - y0) / Math.cos(SLANT));
  geometry.rotateX(-SLANT);
  geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, faceZ((y0 + y1) / 2) + proud);
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) uv.setXY(i, position.getX(i) / metres, position.getY(i) / metres);
  return geometry;
}
/** A band between x0 and x1 that follows a side profile of [z, y] points given from the top down; it faces downstream and up. */
function ribbon(profile: Array<[number, number]>, x0: number, x1: number, metres = 6, widen = 0) {
  const position: number[] = [], uv: number[] = [], index: number[] = [];
  let run = 0;
  profile.forEach(([z, y], j) => {
    if (j > 0) run += Math.hypot(z - profile[j - 1][0], y - profile[j - 1][1]);
    const grow = widen * (j / (profile.length - 1));
    position.push(x0 - grow, y, z, x1 + grow, y, z);
    uv.push(0, run / metres, (x1 - x0) / metres, run / metres);
    if (j > 0) { const a = (j - 1) * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
/** A slab `width` thick in x whose side view is the closed outline of [z, y] points. */
function slab(outline: Array<[number, number]>, x0: number, width: number, metres = 6) {
  const shape = new THREE.Shape();
  outline.forEach(([z, y], i) => { if (i === 0) shape.moveTo(-z, y); else shape.lineTo(-z, y); });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(x0, 0, 0);
  const position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) {
    if (Math.abs(normal.getX(i)) > 0.7) uv.setXY(i, position.getZ(i) / metres, position.getY(i) / metres);
    else uv.setXY(i, position.getX(i) / metres, (position.getY(i) - position.getZ(i) * 0.5) / metres);
  }
  return geometry;
}
/** A porcelain insulator standing on y = 0: a core with `sheds` skirts. */
function insulator(height: number, radius: number, sheds: number) {
  const points: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(radius * 0.42, 0)];
  for (let i = 0; i < sheds; i += 1) {
    const y = (i / sheds) * height, step = height / sheds;
    points.push(new THREE.Vector2(radius * 0.42, y + step * 0.2), new THREE.Vector2(radius, y + step * 0.38), new THREE.Vector2(radius * 0.42, y + step * 0.8));
  }
  points.push(new THREE.Vector2(radius * 0.42, height), new THREE.Vector2(0, height));
  return new THREE.LatheGeometry(points, 10);
}
/** A cast mooring bollard. */
function bollard() {
  const profile = [[0, 0], [0.21, 0], [0.21, 0.04], [0.14, 0.09], [0.125, 0.36], [0.2, 0.43], [0.215, 0.5], [0.17, 0.56], [0, 0.575]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 16);
}

const NOISE_GLSL = /* glsl */`
  float damHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float damNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(damHash(i), damHash(i + vec2(1.0, 0.0)), f.x), mix(damHash(i + vec2(0.0, 1.0)), damHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float damFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += damNoise(p) * a; p = p * 2.03 + 17.3; a *= 0.5; } return s / 0.9375; }
`;

/**
 * Mass concrete seen from far off, drawn in world space over the photographed surface: every pour a
 * tone of its own, lift joints every 2.4 m, block joints every 16 m, lime weeping from the joints,
 * run-off streaks from the crest and damp, green concrete near the water.
 */
const DAM_FACE_GLSL = /* glsl */`
  {
    vec3 p = vDamWorld;
    float tone = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = mix(vec3(tone), diffuseColor.rgb, 0.4);
    float lift = p.y / 2.4, block = (p.x + 80.0) / 16.0;
    float pour = damHash(vec2(floor(lift), floor(block)));
    diffuseColor.rgb *= 0.93 + 0.11 * pour + 0.1 * (damFbm(vec2(p.x * 0.07, p.y * 0.11)) - 0.5);
    float wide = max(fwidth(p.y), fwidth(p.x));
    float liftGap = abs(fract(lift + 0.5) - 0.5) * 2.4, liftWide = max(0.035, wide * 0.9);
    diffuseColor.rgb *= 1.0 - 0.45 * (1.0 - smoothstep(liftWide * 0.4, liftWide, liftGap)) * clamp(0.07 / liftWide, 0.3, 1.0);
    float blockGap = abs(fract(block + 0.5) - 0.5) * 16.0, blockWide = max(0.06, wide * 0.9);
    diffuseColor.rgb *= 1.0 - 0.6 * (1.0 - smoothstep(blockWide * 0.4, blockWide, blockGap)) * clamp(0.12 / blockWide, 0.3, 1.0);
    // Lime hanging in curtains under a lift joint, where the joint leaks.
    float weep = smoothstep(0.7, 0.9, damNoise(vec2(p.x * 0.33, floor(lift) * 7.3 + 2.0))) * smoothstep(0.25, 1.0, fract(lift)) * (0.6 + 0.4 * damNoise(vec2(p.x * 3.0, p.y * 0.4)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.8, 0.76), weep * 0.28);
    // Run-off: long dark streaks, heaviest under the crest.
    float streak = damFbm(vec2(p.x * 0.85, p.y * 0.03 + 3.0));
    float fine = damNoise(vec2(p.x * 3.4, p.y * 0.08));
    diffuseColor.rgb *= 1.0 - (0.36 * smoothstep(0.5, 0.78, streak) + 0.14 * smoothstep(0.55, 0.9, fine)) * (0.45 + 0.55 * smoothstep(10.0, 55.0, p.y));
    // Damp and algae near the water, and where the spray of the running gate reaches.
    float spray = (1.0 - smoothstep(6.0, 17.0, abs(p.x + 20.0))) * (1.0 - smoothstep(14.0, 44.0, p.y));
    float damp = max(1.0 - smoothstep(1.0, 15.0, p.y + damNoise(vec2(p.x * 0.2, 0.0)) * 6.0), spray * 0.8);
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.5, 0.58, 0.5), damp);
  }
`;

/** Shutter-panel sheet multiplied over the photographed concrete of the near walls: 4.8 m a tile, panels 1.2 by 2.4 m. */
function formworkTexture() {
  const texture = canvasTexture(1024, 1024, (c) => {
    const random = rng(41);
    c.fillStyle = "#929292"; c.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 2; j += 1) {
      const tone = Math.round(146 + (random() - 0.5) * 12);
      c.fillStyle = `rgb(${tone},${tone},${tone})`; c.fillRect(i * 256, j * 512, 256, 512);
    }
    // Board marks.
    for (let y = 0; y < 1024; y += 32) {
      c.fillStyle = `rgba(0,0,0,${0.03 + random() * 0.06})`; c.fillRect(0, y, 1024, 2);
      if (random() < 0.4) { c.fillStyle = `rgba(255,255,255,${0.02 + random() * 0.035})`; c.fillRect(0, y + 2, 1024, 30); }
    }
    // Run-off under the lift joints.
    for (let i = 0; i < 54; i += 1) {
      const x = random() * 1024, y0 = random() < 0.5 ? 0 : 512, length = 80 + random() * 400, wide = 3 + random() * 16;
      const gradient = c.createLinearGradient(0, y0, 0, y0 + length);
      gradient.addColorStop(0, `rgba(30,28,24,${0.1 + random() * 0.18})`); gradient.addColorStop(1, "rgba(30,28,24,0)");
      c.fillStyle = gradient; c.fillRect(x, y0, wide, length);
    }
    c.fillStyle = "rgba(20,20,20,.55)"; c.fillRect(0, 0, 1024, 3); c.fillRect(0, 510, 1024, 5); c.fillRect(0, 1021, 1024, 3);
    c.fillStyle = "rgba(20,20,20,.3)";
    for (let i = 0; i < 4; i += 1) c.fillRect(i * 256 - 1, 0, 3, 1024);
    // Tie holes, each with its tear of rust.
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 2; j += 1) for (const [dx, dy] of [[64, 128], [192, 128], [64, 384], [192, 384]]) {
      const x = i * 256 + dx, y = j * 512 + dy;
      const gradient = c.createLinearGradient(0, y, 0, y + 90);
      gradient.addColorStop(0, "rgba(70,42,20,.24)"); gradient.addColorStop(1, "rgba(70,42,20,0)");
      c.fillStyle = gradient; c.fillRect(x - 2, y, 5, 90);
      c.fillStyle = "rgba(15,15,15,.8)"; c.beginPath(); c.arc(x, y, 5, 0, TAU); c.fill();
      c.strokeStyle = "rgba(255,255,255,.2)"; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 8, 0, TAU); c.stroke();
    }
  }, true);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

const FONT = `"Arial Narrow", "Helvetica Neue", Arial, sans-serif`;

/** Every notice, stencil, dial and plate of the map on one sheet. */
function signAtlas() {
  const SIZE = 2048;
  type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;
  const entries: Array<[string, number, number, Draw]> = [];
  const rects: Record<string, [number, number, number, number]> = {}, aspect: Record<string, number> = {};
  const random = rng(77);
  const add = (key: string, w: number, h: number, draw: Draw) => { entries.push([key, w, h, draw]); };
  const write = (c: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, colour: string, room = 0, align: CanvasTextAlign = "center", weight = 900) => {
    let size = px;
    c.font = `${weight} ${size}px ${FONT}`;
    while (room > 0 && size > 10 && c.measureText(text).width > room) { size -= 2; c.font = `${weight} ${size}px ${FONT}`; }
    c.fillStyle = colour; c.textAlign = align; c.textBaseline = "middle";
    c.fillText(text, x, y);
  };
  /** A sheet-metal board: field, border, four fixings and what the weather has done to it. */
  const plate = (c: CanvasRenderingContext2D, w: number, h: number, fill: string, edge = "rgba(0,0,0,.6)") => {
    c.fillStyle = fill; c.fillRect(0, 0, w, h);
    c.strokeStyle = edge; c.lineWidth = 5; c.strokeRect(8, 8, w - 16, h - 16);
  };
  const weather = (c: CanvasRenderingContext2D, w: number, h: number, amount = 1) => {
    for (let i = 0; i < 46 * amount; i += 1) { c.fillStyle = `rgba(60,50,40,${0.03 + random() * 0.07})`; c.fillRect(random() * w, random() * h, 2 + random() * 34, 1 + random() * 3); }
    const grime = c.createLinearGradient(0, 0, 0, h);
    grime.addColorStop(0, "rgba(40,30,20,0)"); grime.addColorStop(1, `rgba(40,30,20,${0.14 * amount})`);
    c.fillStyle = grime; c.fillRect(0, 0, w, h);
    for (const [x, y] of [[20, 20], [w - 20, 20], [20, h - 20], [w - 20, h - 20]]) {
      if (y < h / 2) { const tear = c.createLinearGradient(0, y, 0, y + h * 0.45); tear.addColorStop(0, "rgba(120,62,24,.4)"); tear.addColorStop(1, "rgba(120,62,24,0)"); c.fillStyle = tear; c.fillRect(x - 3, y, 6, h * 0.45); }
      c.fillStyle = "rgba(35,35,35,.85)"; c.beginPath(); c.arc(x, y, 5, 0, TAU); c.fill();
    }
  };
  /** Paint put on through a stencil and worn since. */
  const stencil = (key: string, text: string, w: number, h: number, colour = "rgba(236,234,224,.92)") => add(key, w, h, (c) => {
    write(c, text, w / 2, h / 2 + h * 0.04, h * 0.86, colour, w - 12);
    c.globalCompositeOperation = "destination-out";
    for (let i = 0; i < (w * h) / 300; i += 1) { c.fillStyle = `rgba(0,0,0,${0.2 + random() * 0.6})`; c.fillRect(random() * w, random() * h, 1 + random() * 6, 1 + random() * 3); }
    c.globalCompositeOperation = "source-over";
  });

  add("danger", 560, 380, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    c.fillStyle = "#b3261a"; c.fillRect(16, 16, w - 32, 104);
    write(c, "DANGER", w / 2, 70, 92, "#f3efe4");
    write(c, "WATER RISES", w / 2, 172, 62, "#16181a", w - 60);
    write(c, "WITHOUT WARNING", w / 2, 236, 62, "#16181a", w - 60);
    write(c, "Gates operate on their own. So should you.", w / 2, 316, 26, "#3a3d40", w - 60, "center", 700);
    weather(c, w, h);
  });
  add("gateOpen", 560, 300, (c, w, h) => {
    plate(c, w, h, "#d9a21c");
    write(c, "SPILLWAY GATE 3", w / 2, 62, 58, "#14110d", w - 50);
    write(c, "OPEN", w / 2, 160, 120, "#14110d");
    write(c, "stuck since March  ·  we call it a feature", w / 2, 252, 25, "#2b2414", w - 50, "center", 700);
    weather(c, w, h);
  });
  add("doorStuck", 560, 280, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    write(c, "DOOR STUCK", w / 2, 100, 112, "#b3261a", w - 50);
    write(c, "roller door T-2  ·  use door A", w / 2, 190, 40, "#16181a", w - 60, "center", 700);
    write(c, "do not rush B", w / 2, 238, 30, "#3a3d40", w - 60, "center", 700);
    weather(c, w, h, 0.7);
  });
  add("rushB", 560, 220, (c, w, h) => {
    plate(c, w, h, "#1f4e79", "rgba(240,240,235,.8)");
    c.fillStyle = "#f0efe8"; c.beginPath(); c.moveTo(34, 78); c.lineTo(96, 34); c.lineTo(96, 62); c.lineTo(150, 62); c.lineTo(150, 94); c.lineTo(96, 94); c.lineTo(96, 122); c.closePath(); c.fill();
    write(c, "BLOCK B GALLERY", 172, 78, 56, "#f0efe8", w - 200, "left");
    write(c, "rush B: 214 steps. Take the lift.", w / 2, 168, 30, "#cfd9e2", w - 60, "center", 700);
    weather(c, w, h, 0.8);
  });
  add("eco", 440, 300, (c, w, h) => {
    plate(c, w, h, "#2f6b4a", "rgba(240,240,235,.8)");
    write(c, "ECO ROUND", w / 2, 74, 82, "#f0efe8", w - 50);
    write(c, "Units 3 to 6 on standby.", w / 2, 164, 34, "#e2ece4", w - 50, "center", 700);
    write(c, "Lights off behind you.", w / 2, 208, 34, "#e2ece4", w - 50, "center", 700);
    write(c, "full buy resumes at high water", w / 2, 258, 23, "#b9d0c0", w - 50, "center", 700);
    weather(c, w, h, 0.8);
  });
  add("lossBonus", 480, 300, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    write(c, "SEEPAGE LOG", w / 2, 56, 56, "#16181a", w - 50);
    c.fillStyle = "#16181a"; c.fillRect(30, 92, w - 60, 4);
    write(c, "this month", 44, 136, 32, "#3a3d40", 0, "left", 700); write(c, "3.2 l/s", w - 44, 136, 40, "#16181a", 0, "right");
    write(c, "within limits", 44, 186, 32, "#3a3d40", 0, "left", 700); write(c, "YES", w - 44, 186, 40, "#2f6b4a", 0, "right");
    write(c, "LOSS BONUS", 44, 246, 38, "#b3261a", 0, "left"); write(c, "none payable", w - 44, 246, 30, "#3a3d40", 0, "right", 700);
    weather(c, w, h);
  });
  add("tradeUp", 480, 240, (c, w, h) => {
    plate(c, w, h, "#d9a21c");
    write(c, "TRADE UP", w / 2, 74, 92, "#14110d", w - 50);
    write(c, "10 stop logs = 1 gate", w / 2, 150, 40, "#14110d", w - 50, "center", 700);
    write(c, "no refunds  ·  no re-rolls", w / 2, 198, 28, "#2b2414", w - 50, "center", 700);
    weather(c, w, h);
  });
  add("cases", 640, 220, (c, w, h) => {
    plate(c, w, h, "#3b4245", "rgba(230,230,224,.7)");
    write(c, "10 000 CASES", w / 2, 74, 92, "#e8e6dc", w - 50);
    write(c, "KEYS SOLD SEPARATELY", w / 2, 146, 44, "#d9a21c", w - 50);
    write(c, "stores, bay 2", w / 2, 190, 24, "#aab2b4", w - 50, "center", 700);
    weather(c, w, h, 0.8);
  });
  add("cache", 560, 190, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    write(c, "CACHE & CARRY", w / 2, 68, 80, "#16181a", w - 50);
    write(c, "stop-log store  ·  sign out what you lift", w / 2, 140, 28, "#3a3d40", w - 50, "center", 700);
    weather(c, w, h);
  });
  add("float", 300, 360, (c, w, h) => {
    plate(c, w, h, "#d8dcd9");
    write(c, "LEVEL FLOAT", w / 2, 52, 44, "#16181a", w - 40);
    c.fillStyle = "#101214"; c.fillRect(36, 92, w - 72, 120);
    write(c, "0.07", w / 2, 154, 96, "#8ef5e3", w - 90);
    write(c, "FACTORY NEW", w / 2, 256, 40, "#2f6b4a", w - 40);
    write(c, "minimal wear · do not adjust", w / 2, 312, 21, "#3a3d40", w - 40, "center", 700);
    weather(c, w, h, 0.6);
  });
  add("forceBuy", 440, 220, (c, w, h) => {
    plate(c, w, h, "#b3261a", "rgba(240,240,235,.8)");
    write(c, "FORCE MAIN V-4", w / 2, 62, 62, "#f3efe4", w - 44);
    write(c, "FORCE BUY", w / 2, 132, 50, "#f3efe4", w - 44);
    write(c, "open slowly · close slower", w / 2, 184, 26, "#f0d9d4", w - 44, "center", 700);
    weather(c, w, h, 0.8);
  });
  add("save", 360, 360, (c, w, h) => {
    plate(c, w, h, "#e2571c", "rgba(250,245,235,.85)");
    c.strokeStyle = "#f6f1e6"; c.lineWidth = 34; c.beginPath(); c.arc(w / 2, 150, 78, 0, TAU); c.stroke();
    c.strokeStyle = "#b3261a"; c.lineWidth = 34;
    for (let i = 0; i < 4; i += 1) { c.beginPath(); c.arc(w / 2, 150, 78, i * Math.PI / 2 + 0.55, i * Math.PI / 2 + 1.02); c.stroke(); }
    write(c, "SAVE", w / 2, 290, 78, "#f6f1e6");
    weather(c, w, h, 0.8);
  });
  add("ear", 300, 400, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    c.fillStyle = "#1f4e79"; c.beginPath(); c.arc(w / 2, 150, 112, 0, TAU); c.fill();
    c.strokeStyle = "#f0efe8"; c.lineWidth = 16; c.beginPath(); c.arc(w / 2, 158, 62, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
    c.fillStyle = "#f0efe8";
    for (const side of [-1, 1]) { c.beginPath(); c.ellipse(w / 2 + side * 62, 176, 22, 36, 0, 0, TAU); c.fill(); }
    write(c, "EAR DEFENDERS", w / 2, 304, 40, "#16181a", w - 40);
    write(c, "turbine hall and range", w / 2, 350, 24, "#3a3d40", w - 40, "center", 700);
    weather(c, w, h, 0.8);
  });
  add("company", 940, 270, (c, w, h) => {
    plate(c, w, h, "#17344a", "rgba(230,236,240,.75)");
    // The board's mark: three falling bars.
    for (let i = 0; i < 3; i += 1) { c.fillStyle = ["#8ef5e3", "#cfe6ee", "#8ef5e3"][i]; c.fillRect(44 + i * 30, 52 + i * 18, 18, 150 - i * 36); }
    write(c, "HOLLOWBECK HYDRO BOARD", 150, 84, 68, "#eef2f3", w - 190, "left");
    write(c, "SPILLWAY APRON  ·  TRAINING WALL TW-1", 150, 152, 38, "#cfe6ee", w - 190, "left", 700);
    write(c, "range users: mind the tailrace, mind the gate, mind the crows", 150, 208, 25, "#9fb6c2", w - 190, "left", 700);
    weather(c, w, h, 0.7);
  });
  add("noSwim", 420, 420, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    c.strokeStyle = "#b3261a"; c.lineWidth = 26; c.beginPath(); c.arc(w / 2, 150, 104, 0, TAU); c.stroke();
    c.strokeStyle = "#1f4e79"; c.lineWidth = 9;
    for (let i = 0; i < 3; i += 1) { c.beginPath(); for (let x = -70; x <= 70; x += 5) { const y = 136 + i * 24 + Math.sin(x * 0.13 + i) * 7; if (x === -70) c.moveTo(w / 2 + x, y); else c.lineTo(w / 2 + x, y); } c.stroke(); }
    c.strokeStyle = "#b3261a"; c.lineWidth = 26; c.beginPath(); c.moveTo(w / 2 - 74, 76); c.lineTo(w / 2 + 74, 224); c.stroke();
    write(c, "NO SWIMMING · NO FISHING", w / 2, 306, 36, "#16181a", w - 44);
    write(c, "no peeking over the wall", w / 2, 360, 26, "#3a3d40", w - 44, "center", 700);
    weather(c, w, h);
  });
  add("crows", 480, 230, (c, w, h) => {
    plate(c, w, h, "#e8e6dc");
    write(c, "DO NOT FEED THE CROWS", w / 2, 82, 52, "#16181a", w - 44);
    write(c, "they have had enough brass", w / 2, 156, 32, "#3a3d40", w - 44, "center", 700);
    weather(c, w, h);
  });
  add("plantB", 400, 170, (c, w, h) => {
    plate(c, w, h, "#d8dcd9");
    write(c, "PLANT ROOM B", w / 2, 62, 62, "#16181a", w - 40);
    write(c, "do not plant anything", w / 2, 124, 26, "#3a3d40", w - 40, "center", 700);
    weather(c, w, h, 0.5);
  });
  add("days", 520, 320, (c, w, h) => {
    plate(c, w, h, "#2f6b4a", "rgba(240,240,235,.8)");
    write(c, "DAYS SINCE THE DOOR", 40, 62, 44, "#f0efe8", w - 80, "left");
    write(c, "LAST STUCK", 40, 116, 44, "#f0efe8", w - 80, "left");
    c.fillStyle = "#101214"; c.fillRect(40, 160, 190, 128);
    write(c, "0", 135, 228, 124, "#f3efe4");
    write(c, "previous best: 1", 256, 226, 30, "#cfe0d4", 230, "left", 700);
    weather(c, w, h, 0.8);
  });
  add("pattern", 340, 150, (c, w, h) => {
    plate(c, w, h, "#d8dcd9");
    write(c, "PUMP P-2", w / 2, 50, 46, "#16181a", w - 40);
    write(c, "PATTERN 661  ·  float 0.07", w / 2, 106, 25, "#3a3d40", w - 40, "center", 700);
    weather(c, w, h, 0.5);
  });
  add("hv", 300, 320, (c, w, h) => {
    plate(c, w, h, "#d9a21c");
    c.fillStyle = "#14110d"; c.beginPath(); c.moveTo(w / 2, 26); c.lineTo(w - 44, 196); c.lineTo(44, 196); c.closePath(); c.fill();
    c.fillStyle = "#d9a21c"; c.beginPath(); c.moveTo(w / 2, 62); c.lineTo(w - 82, 178); c.lineTo(82, 178); c.closePath(); c.fill();
    c.fillStyle = "#14110d"; c.beginPath(); c.moveTo(158, 84); c.lineTo(128, 136); c.lineTo(150, 136); c.lineTo(136, 172); c.lineTo(176, 122); c.lineTo(154, 122); c.lineTo(172, 84); c.closePath(); c.fill();
    write(c, "66 000 VOLTS", w / 2, 240, 40, "#14110d", w - 36);
    write(c, "one tap is enough", w / 2, 284, 23, "#2b2414", w - 36, "center", 700);
    weather(c, w, h, 0.8);
  });
  add("cabinet", 360, 700, (c, w, h) => {
    c.fillStyle = "#74827f"; c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(20,24,24,.7)"; c.lineWidth = 4; c.strokeRect(10, 10, w - 20, h - 20);
    c.fillStyle = "#d8dcd9"; c.fillRect(40, 40, 280, 62);
    write(c, "MCC-2  GATE HOISTS", w / 2, 72, 30, "#16181a", 260);
    ["#3ddc7a", "#e8a23a", "#c5352a"].forEach((colour, i) => { c.fillStyle = "#1d2122"; c.beginPath(); c.arc(86 + i * 94, 156, 24, 0, TAU); c.fill(); c.fillStyle = i === 0 ? colour : "#3a3330"; c.beginPath(); c.arc(86 + i * 94, 156, 16, 0, TAU); c.fill(); });
    for (let i = 0; i < 2; i += 1) {
      const x = 48 + i * 146;
      c.fillStyle = "#e8e6dc"; c.fillRect(x, 208, 118, 96); c.strokeStyle = "#1d2122"; c.lineWidth = 3; c.strokeRect(x, 208, 118, 96);
      c.beginPath(); c.arc(x + 59, 296, 62, Math.PI * 1.2, Math.PI * 1.8); c.stroke();
      c.beginPath(); c.moveTo(x + 59, 296); c.lineTo(x + 59 + (i ? 34 : -22), 244); c.stroke();
    }
    c.fillStyle = "#1d2122"; c.fillRect(306, 300, 16, 120);
    c.fillStyle = "#d9a21c"; c.fillRect(48, 344, 150, 60);
    write(c, "ECO ROUND", 123, 364, 22, "#14110d", 140); write(c, "do not reset", 123, 388, 18, "#14110d", 140, "center", 700);
    for (let y = 470; y < 640; y += 22) { c.fillStyle = "rgba(15,18,18,.8)"; c.fillRect(48, y, 264, 9); }
    weather(c, w, h, 0.7);
  });
  add("dial", 200, 200, (c, w, h) => {
    c.fillStyle = "#e8e6dc"; c.beginPath(); c.arc(w / 2, h / 2, 98, 0, TAU); c.fill();
    c.strokeStyle = "#16181a"; c.lineWidth = 4;
    for (let i = 0; i <= 10; i += 1) { const a = Math.PI * 0.75 + (i / 10) * Math.PI * 1.5; c.beginPath(); c.moveTo(w / 2 + Math.cos(a) * 70, h / 2 + Math.sin(a) * 70); c.lineTo(w / 2 + Math.cos(a) * 88, h / 2 + Math.sin(a) * 88); c.stroke(); }
    c.strokeStyle = "#b3261a"; c.lineWidth = 10; c.beginPath(); c.arc(w / 2, h / 2, 80, Math.PI * 1.95, Math.PI * 2.25); c.stroke();
    c.strokeStyle = "#16181a"; c.lineWidth = 6; c.beginPath(); c.moveTo(w / 2, h / 2); c.lineTo(w / 2 + 52, h / 2 - 40); c.stroke();
    c.fillStyle = "#16181a"; c.beginPath(); c.arc(w / 2, h / 2, 10, 0, TAU); c.fill();
    write(c, "bar", w / 2, h / 2 + 48, 24, "#16181a", 0, "center", 700);
  });
  add("grate", 256, 64, (c, w, h) => {
    c.fillStyle = "#0b0c0d"; c.fillRect(0, 0, w, h);
    for (let x = 4; x < w; x += 16) { c.fillStyle = "#4a4d4e"; c.fillRect(x, 4, 9, h - 8); c.fillStyle = "rgba(255,255,255,.12)"; c.fillRect(x, 4, 2, h - 8); }
    c.fillStyle = "#3a3d3e"; c.fillRect(0, 0, w, 5); c.fillRect(0, h - 5, w, 5);
  });
  add("gauge", 96, 840, (c, w, h) => {
    c.fillStyle = "#e6e4da"; c.fillRect(0, 0, w, h);
    // A staff gauge: four metres in decimetre blocks, a figure at every metre.
    const metre = h / 4.2;
    for (let d = 0; d < 42; d += 1) { const y = h - (d + 1) * metre / 10; c.fillStyle = "#16181a"; if (d % 2 === 0) c.fillRect(d % 10 < 5 ? 6 : 34, y, 28, metre / 10); if (d % 10 === 0) c.fillRect(0, y + metre / 10 - 4, w, 4); }
    for (let m = 1; m <= 4; m += 1) write(c, String(m), 78, h - m * metre + 30, 44, "#b3261a", 30);
    for (let i = 0; i < 30; i += 1) { c.fillStyle = `rgba(60,70,50,${0.05 + random() * 0.1})`; c.fillRect(0, h - random() * h * 0.45, w, 3 + random() * 12); }
  });
  stencil("stTailrace", "TAILRACE", 900, 170);
  stencil("stKeep", "KEEP CLEAR OF EDGE", 900, 110, "rgba(217,162,28,.92)");
  stencil("stTW1", "TW-1", 400, 170);
  stencil("stT2", "T-2", 400, 210, "rgba(232,230,220,.85)");
  stencil("stUnit", "UNIT 2", 520, 170);
  stencil("stEL", "EL 412.0", 520, 120);
  stencil("stSL", "SL 1-4  9 t", 520, 110, "rgba(232,230,220,.85)");
  for (let i = 1; i <= 5; i += 1) stencil(`n${i}`, String(i), 150, 200);

  // Shelf-packed, tallest first, at the largest scale that fits the sheet.
  const order = [...entries].sort((a, b) => b[2] - a[2]);
  const pack = (scale: number) => {
    const spots: Array<[number, number]> = [];
    let x = 0, y = 0, row = 0;
    for (const [, w, h] of order) {
      const wide = Math.ceil(w * scale), tall = Math.ceil(h * scale);
      if (x + wide > SIZE) { x = 0; y += row + 4; row = 0; }
      spots.push([x, y]);
      x += wide + 4; row = Math.max(row, tall);
    }
    return y + row <= SIZE ? spots : null;
  };
  let scale = 1, spots = pack(scale);
  while (!spots && scale > 0.3) { scale -= 0.03; spots = pack(scale); }
  const placed = spots ?? [];
  const texture = canvasTexture(SIZE, SIZE, (c) => {
    order.forEach(([key, w, h, draw], i) => {
      const [x, y] = placed[i] ?? [0, 0], wide = w * scale, tall = h * scale;
      c.save(); c.translate(x, y); c.scale(scale, scale); c.beginPath(); c.rect(0, 0, w, h); c.clip(); draw(c, w, h); c.restore();
      rects[key] = [(x + 1) / SIZE, 1 - (y + tall - 1) / SIZE, (x + wide - 1) / SIZE, 1 - (y + 1) / SIZE];
      aspect[key] = w / h;
    });
  });
  return { texture, rects, aspect };
}

/** Running water seen from above: milky green where it is whole, white where it is torn, streaming toward +z. */
const RIVER_SHADER = {
  vertexShader: /* glsl */`
    #include <common>
    #include <fog_pars_vertex>
    varying vec3 vWorld;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vec4 mvPosition = viewMatrix * world;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    uniform float time;
    uniform vec3 toSun;
    varying vec3 vWorld;
    ${NOISE_GLSL}
    void main() {
      vec2 p = vWorld.xz;
      // How torn the water is: the hydraulic jump under the running gate, then the race easing off downstream.
      float jump = exp(-pow((p.x + 20.0) / 9.0, 2.0)) * (1.0 - smoothstep(-52.0, -44.0, p.y)) + 0.35 * (1.0 - smoothstep(-66.0, -42.0, p.y)) * exp(-pow((p.x + 20.0) / 20.0, 2.0));
      float race = step(-44.0, p.y) * (0.2 + 0.42 * exp(-(p.y + 44.0) / 40.0));
      float churn = clamp(max(jump, race), 0.0, 1.0);
      float speed = mix(2.2, 6.5, clamp(churn * 1.6, 0.0, 1.0));
      float flow = p.y - time * speed;
      float a = damFbm(vec2(p.x * 0.5, flow * 0.15));
      float b = damFbm(vec2(p.x * 1.6 + 7.0, (p.y - time * speed * 1.3) * 0.4));
      float c = damNoise(vec2(p.x * 4.5, (p.y - time * speed * 1.6) * 1.2));
      // Boils that well up and spread where the jump is.
      float boil = damNoise(vec2(p.x * 0.35 + sin(time * 0.6) * 0.4, p.y * 0.35 - time * 0.9)) * jump;
      float foam = smoothstep(0.66 - churn * 0.5, 0.86 - churn * 0.38, a * 0.5 + b * 0.34 + c * 0.16 + boil * 0.3);
      vec3 view = normalize(cameraPosition - vWorld);
      vec3 normal = normalize(vec3((b - 0.5) * 0.7 + (c - 0.5) * 0.25, 1.0, (a - 0.5) * 0.7));
      float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(view, normal), 0.0), 5.0);
      vec3 water = mix(vec3(0.04, 0.072, 0.066), vec3(0.14, 0.21, 0.185), b * 0.7 + churn * 0.4);
      vec3 sky = mix(vec3(0.42, 0.48, 0.52), vec3(0.24, 0.38, 0.7), max(reflect(-view, normal).y, 0.0));
      vec3 colour = mix(water, sky, fresnel * 0.7);
      vec3 halfway = normalize(view + toSun);
      colour += vec3(1.0, 0.95, 0.85) * pow(max(dot(normal, halfway), 0.0), 180.0) * 5.0 * (1.0 - foam);
      vec3 white = vec3(0.86, 0.9, 0.92) * (0.72 + 0.4 * c) * (0.8 + 0.2 * b);
      colour = mix(colour, white, foam);
      gl_FragColor = vec4(colour, 1.0);
      #include <fog_fragment>
    }
  `,
};

/** The sheet of water on the chute: glassy over the sill, then white, torn into streaks that run down the face. */
const CHUTE_SHADER = {
  vertexShader: /* glsl */`
    #include <common>
    #include <fog_pars_vertex>
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    uniform float time;
    varying vec2 vUv;
    ${NOISE_GLSL}
    void main() {
      float across = vUv.x, along = vUv.y;
      // The water speeds up as it falls.
      float run = along - time * (9.0 + along * 0.12);
      float streaks = damFbm(vec2(across * 9.0, run * 0.055));
      float rolls = damNoise(vec2(across * 3.0 + damNoise(vec2(across * 6.0, run * 0.1)) * 0.8, run * 0.22));
      float grain = damNoise(vec2(across * 34.0, run * 0.6));
      float aerated = smoothstep(1.0, 12.0, along + (streaks - 0.5) * 8.0);
      float body = 0.5 * streaks + 0.3 * rolls + 0.2 * grain;
      vec3 glass = mix(vec3(0.05, 0.17, 0.17), vec3(0.3, 0.48, 0.48), streaks);
      vec3 white = mix(vec3(0.5, 0.6, 0.68), vec3(1.0, 1.0, 0.98), smoothstep(0.3, 0.72, body)) * 1.12;
      vec3 colour = mix(glass, white, aerated);
      // Ragged edges, thin enough near them for the concrete to show.
      float edge = min(across, 1.0 - across);
      float alpha = smoothstep(0.0, 0.07 + 0.06 * rolls, edge + (streaks - 0.5) * 0.05) * mix(0.9, 1.0, aerated);
      alpha *= 1.0 - 0.4 * aerated * smoothstep(0.5, 0.25, body);
      gl_FragColor = vec4(colour, alpha);
      #include <fog_fragment>
    }
  `,
};

type Ledge = { x: number; y: number; z: number; width: number };

/**
 * One wall of the gorge: bedded rock built stratum by stratum along a line on the ground. Each bed
 * has its own thickness, set-back and colour and is pushed in and out along its length, so the wall
 * steps back in ledges and stands forward in buttresses; the widest ledges are returned for trees.
 * `side` is 1 for a wall whose rock lies to the left of the line's direction of travel in plan (the
 * west wall walked up the gorge), -1 for the other.
 */
function gorgeWall(line: Array<[number, number]>, side: 1 | -1, seed: number, lean: number, rimAt: (z: number) => number) {
  const random = rng(seed);
  const curve = new THREE.CatmullRomCurve3(line.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
  const length = curve.getLength(), columns = Math.ceil(length / 1.7), base = -5;
  const palette = [0x77746e, 0x68655f, 0x858078, 0x5c5a57, 0x8d877a, 0x716c64, 0x7e786d, 0x8c8270, 0x535150].map((hex) => new THREE.Color(hex));
  const moss = new THREE.Color(0x4d5a3a), dust = new THREE.Color(0x7f7a70), forest = new THREE.Color(0x3d4a30);
  type Bed = { from: number; to: number; step: number; batter: number; tone: THREE.Color; bench: boolean; block: number; depth: number; shift: number };
  const beds: Bed[] = [];
  for (let at = 0; at < 1;) {
    const thick = Math.min(1 - at + 0.0001, 0.04 + random() * 0.08), bench = beds.length > 1 && !beds[beds.length - 1].bench && random() < 0.34;
    beds.push({ from: at, to: Math.min(1, at + thick), step: beds.length === 0 ? 0 : (bench ? 1.7 + random() * 2.3 : 0.1 + random() * random() * 0.8) * lean, batter: 0.02 + random() * 0.1, tone: palette[Math.floor(random() * palette.length)], bench, block: 2.6 + random() * 4.6, depth: 0.5 + random() * 1.5, shift: random() * 20 });
    at += thick;
  }
  const setBack: number[] = [];
  beds.reduce((sum, bed, k) => (setBack[k] = sum + bed.step), 0);
  // Per column: where it stands, which way the rock lies, and the three rows of every bed.
  const at: THREE.Vector3[] = [], out: THREE.Vector3[] = [], rows: number[][][] = [], heights: number[][][] = [];
  for (let i = 0; i <= columns; i += 1) {
    const t = i / columns, u = t * length, point = curve.getPointAt(t), tangent = curve.getTangentAt(t);
    at.push(point); out.push(new THREE.Vector3(tangent.z, 0, -tangent.x).normalize().multiplyScalar(side));
    const rim = rimAt(point.z) + (vnoise(u / 23, seed + 1) - 0.5) * 7, column: number[][] = [], high: number[][] = [];
    // Gullies: now and then the whole wall is cut back in a cleft.
    const cleft = 3.2 * smooth(0.72, 0.9, vnoise(u / 13, seed + 41));
    let top = -1;
    beds.forEach((bed, k) => {
      const y0 = base + bed.from * (rim - base), y1 = base + bed.to * (rim - base);
      const shared = (vnoise(u / 36, seed) - 0.5) * 8 * (0.25 + 0.75 * bed.from) + (vnoise(u / 11, seed + 3) - 0.5) * 2.4 + cleft * (0.3 + bed.from);
      const own = (vnoise(u / 8 + k * 17.3, seed + 5) - 0.5) * 2.6 + (vnoise(u / 2.4 + k * 7.1, seed + 9) - 0.5) * 1.1;
      // Jointed rock breaks off in blocks: each bed stands in and out in steps of its own length.
      const jointed = (hash1(Math.floor(u / bed.block + bed.shift), seed + 51 + k) - 0.5) * bed.depth;
      const bottom = Math.max(0, top - 0.8, setBack[k] + shared + own + jointed);
      top = bottom + bed.batter * (y1 - y0);
      column.push([bottom, (bottom + top) / 2 + (vnoise(u / 3.1 + k * 3.3, seed + 11) - 0.5) * 0.9, top]);
      high.push([y0, (y0 + y1) / 2, y1]);
    });
    rows.push(column); heights.push(high);
  }
  const parts: THREE.BufferGeometry[] = [], ledges: Ledge[] = [];
  /** A strip of `count` rows along the whole wall: `row(i, r)` gives set-back, height, colour and shade. */
  const strip = (count: number, row: (i: number, r: number) => [number, number, THREE.Color, number], ledge: boolean) => {
    const position: number[] = [], colour: number[] = [], uv: number[] = [], index: number[] = [];
    for (let i = 0; i <= columns; i += 1) for (let r = 0; r < count; r += 1) {
      const [back, y, tone, shade] = row(i, r), u = (i / columns) * length;
      position.push(at[i].x + out[i].x * back, y, at[i].z + out[i].z * back);
      colour.push(tone.r * shade, tone.g * shade, tone.b * shade);
      uv.push(u / 4.2, (ledge ? back : y) / 4.2);
    }
    for (let i = 0; i < columns; i += 1) for (let r = 0; r < count - 1; r += 1) {
      const a = i * count + r, b = a + count, c = a + 1, d = b + 1;
      if (side > 0) index.push(a, b, c, b, d, c); else index.push(a, c, b, b, c, d);
    }
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    indexed.setAttribute("color", new THREE.Float32BufferAttribute(colour, 3));
    indexed.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    indexed.setIndex(index);
    // Faces are left faceted, as jointed rock breaks; ledges and the rim are smooth ground.
    if (ledge) indexed.computeVertexNormals();
    const geometry = indexed.toNonIndexed();
    if (!ledge) geometry.computeVertexNormals();
    indexed.dispose();
    parts.push(geometry);
  };
  const mixed = new THREE.Color();
  beds.forEach((bed, k) => {
    // The face of the bed: darker toward its foot, stained in streaks.
    strip(3, (i, r) => {
      const u = (i / columns) * length, stain = 1 - 0.34 * smooth(0.55, 0.85, vnoise(u / 1.9 + k * 0.7, seed + 21));
      return [rows[i][k][r], heights[i][k][r], bed.tone, [0.6, 0.94, 1.1][r] * (0.78 + 0.44 * vnoise(u / 5 + k * 9.1, seed + 15)) * stain];
    }, false);
    if (k === beds.length - 1) return;
    // The ledge up to the next bed: dust on the narrow ones, moss and grass on the benches.
    const next = beds[k + 1], cover = next.bench ? moss : dust;
    strip(2, (i, r) => {
      const u = (i / columns) * length, width = rows[i][k + 1][0] - rows[i][k][2], green = next.bench ? smooth(0.6, 2.2, width) * (0.55 + 0.45 * vnoise(u / 4 + k, seed + 17)) : 0.4;
      mixed.copy(bed.tone).lerp(cover, green);
      return [rows[i][k + (r === 0 ? 0 : 1)][r === 0 ? 2 : 0], heights[i][k][2], mixed.clone(), r === 0 ? 0.74 : 0.5];
    }, true);
    if (next.bench) for (let i = 2; i < columns - 2; i += 1) {
      const width = rows[i][k + 1][0] - rows[i][k][2];
      if (width > 1.5 && random() < 0.4) ledges.push({ x: at[i].x + out[i].x * (rows[i][k][2] + width * 0.55), y: heights[i][k][2], z: at[i].z + out[i].z * (rows[i][k][2] + width * 0.55), width });
    }
  });
  // The rim rolls back into wooded ground.
  const last = beds.length - 1;
  strip(4, (i, r) => {
    const u = (i / columns) * length, back = rows[i][last][2], y = heights[i][last][2];
    mixed.copy(r === 0 ? beds[last].tone : forest).lerp(moss, r === 1 ? 0.5 : 0);
    return [back + [0, 5, 22, 70][r], y + [0, 1.4, 5, 15][r] + (r > 0 ? (vnoise(u / 9 + r * 5, seed + 31) - 0.5) * 2.5 : 0), mixed.clone(), r === 0 ? 1.1 : 0.9];
  }, true);
  for (let i = 3; i < columns - 3; i += 1) if (random() < 0.6) {
    const back = rows[i][last][2] + 1.5 + random() * 12, lift = back - rows[i][last][2];
    ledges.push({ x: at[i].x + out[i].x * back, y: heights[i][last][2] + (lift < 5 ? lift * 0.28 : 1.4 + (lift - 5) * 0.21) - 0.3, z: at[i].z + out[i].z * back, width: 9 });
  }
  const geometry = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  return { geometry, ledges };
}

export function buildDam(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, track, photoSet } = kit;
  const metals = kit.metals();
  const random = rng(1958);
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.5, ...parameters });
  const clock = { value: 0 };
  kit.updates.push((now) => { clock.value = now / 1000; });

  // ---- Materials -----------------------------------------------------------
  const castSet = photoSet("/textures/concrete_wall_007-2k", 1, 1, false);
  const formwork = track(formworkTexture());
  formwork.anisotropy = anisotropy;
  const jointMap = { value: formwork };
  /** Near concrete: photographed board marks, greyed, under the shutter-panel sheet. */
  const concreteMaterial = (color: number, envMapIntensity = 0.45) => {
    const material = standard({ ...castSet, color, normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.jointMap = jointMap;
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <map_pars_fragment>", "#include <map_pars_fragment>\nuniform sampler2D jointMap;")
        .replace("#include <map_fragment>", /* glsl */`#include <map_fragment>
          diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, 0.45) * texture2D(jointMap, vMapUv * 0.5).rgb * 1.75;`);
    };
    material.customProgramCacheKey = () => "dam-formwork";
    return material;
  };
  const concrete = concreteMaterial(0xd4d3cc);
  const paleConcrete = concreteMaterial(0xe6e5de);
  const darkConcrete = concreteMaterial(0xa9aaa4);
  /** The dam and everything cast with it: vertex colour carries the shade the sun's map cannot reach. */
  const damConcrete = standard({ ...photoSet("/textures/concrete_wall_007-2k", 1, 1, false), color: 0xdcdad0, vertexColors: true, envMapIntensity: 0.4 });
  const worldVarying = (shader: { vertexShader: string; fragmentShader: string }) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDamWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvDamWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nvarying vec3 vDamWorld;\n${NOISE_GLSL}`);
  };
  damConcrete.onBeforeCompile = (shader) => {
    worldVarying(shader);
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>\n${DAM_FACE_GLSL}`);
  };
  damConcrete.customProgramCacheKey = () => "dam-face";
  /** Bedded rock: the photographed stone drained of its colour, the beds' own colours over it, fine bedding lines drawn in. */
  const rock = standard({ ...photoSet("/textures/sandstone_cracks-2k", 1, 1, false), vertexColors: true, normalScale: new THREE.Vector2(2, 2), envMapIntensity: 0.3 });
  rock.onBeforeCompile = (shader) => {
    worldVarying(shader);
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", /* glsl */`#include <map_fragment>
      {
        float grey = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = mix(vec3(grey), diffuseColor.rgb, 0.16) * 2.3;
        float tilt = vDamWorld.y + vDamWorld.z * 0.06 + damNoise(vDamWorld.xz * 0.12) * 1.6;
        float bedding = damNoise(vec2(tilt * 2.6, 0.5)) * 0.6 + damNoise(vec2(tilt * 9.0, 3.5)) * 0.4;
        diffuseColor.rgb *= 0.7 + 0.56 * bedding;
        diffuseColor.rgb *= 0.84 + 0.32 * damFbm(vDamWorld.xz * 0.22 + vDamWorld.y * 0.13);
        // Joints: on the steep faces the beds are cut into blocks, each a tone of its own, with dark open joints between.
        vec3 facet = normalize(cross(dFdx(vDamWorld), dFdy(vDamWorld)));
        float steep = 1.0 - smoothstep(0.5, 0.8, abs(facet.y));
        vec2 m = vMapUv * 4.2;
        float course = m.y / 1.5 + damNoise(vec2(m.x * 0.06, 3.0)) * 1.4 + damNoise(vec2(m.y * 0.3, 9.0)) * 1.1;
        float row = floor(course);
        float wide = 1.3 + 3.4 * damHash(vec2(row, 7.0));
        float cell = m.x / wide + damHash(vec2(row, 13.0)) * 9.0 + (damNoise(vec2(m.y * 0.9, row)) - 0.5) * 0.25;
        float block = damHash(vec2(floor(cell), row + 3.0));
        float shut = 1.0 - step(0.42, damHash(vec2(floor(cell + 0.5), row + 31.0)));
        float upright = (0.5 - abs(fract(cell) - 0.5)) * wide + shut * 9.0;
        float level = (0.5 - abs(fract(course) - 0.5)) * 1.3;
        float jointWide = max(0.06, max(fwidth(m.x), fwidth(m.y)) * 1.3);
        float crack = (1.0 - smoothstep(jointWide * 0.3, jointWide, min(upright, level))) * clamp(0.12 / jointWide, 0.25, 1.0);
        diffuseColor.rgb *= mix(1.0, (0.78 + 0.44 * block) * (1.0 - 0.6 * crack), steep);
      }`);
  };
  rock.customProgramCacheKey = () => "dam-rock";
  const floorSet = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1, false);
  const yard = standard({ ...floorSet, color: 0xb4b6b2, envMapIntensity: 0.4 });
  const gravel = standard({ ...photoSet("/textures/asphalt_02-2k", 1, 1, false), color: 0xa39c8e, envMapIntensity: 0.3 });
  const roofing = standard({ map: gravel.map, normalMap: gravel.normalMap, roughnessMap: gravel.roughnessMap, color: 0x6f7273, envMapIntensity: 0.3 });
  const galv = standard({ color: 0xa4abad, metalness: 0.8, roughness: 0.5, envMapIntensity: 0.75 });
  /** One painted-steel material for the whole map: the colour of each part rides in its vertices. */
  const paint = standard({ vertexColors: true, roughness: 0.7, metalness: 0.1, envMapIntensity: 0.6 });
  const rusty = standard({ ...photoSet("/textures/rusty_metal_02-2k", 1, 1, false), color: 0xb9a79a, metalness: 0.4, envMapIntensity: 0.6 });
  const timber = standard({ ...photoSet("/textures/weathered_brown_planks-2k", 1, 1, false), color: 0xc9b8a0, envMapIntensity: 0.35 });
  const shutter = standard({ ...photoSet("/textures/corrugated_iron_02-2k", 1, 1, false), color: 0x8fa4ab, metalness: 0.45, envMapIntensity: 0.7 });
  const lampGlass = standard({ color: 0xd9d4c4, emissive: 0xfff0d0, emissiveIntensity: 0.25, roughness: 0.3 });
  const hazardMap = track(hazardTexture());
  hazardMap.anisotropy = anisotropy;
  const hazardPaint = standard({ map: hazardMap, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const atlas = signAtlas();
  track(atlas.texture).anisotropy = anisotropy;
  const signPaint = standard({ map: atlas.texture, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.5 });
  const stencilPaint = standard({ map: atlas.texture, transparent: true, depthWrite: false, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  // ---- Batching: one mesh per material, zone and class -----------------------
  // "fine" parts are left out on phones and of the floor mirror; "walk" parts never stand in the player's way.
  type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean; walk?: boolean; zone?: string };
  type Batch = { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] };
  const batches = new Map<string, Batch>();
  /** Gives every vertex of a part one colour, for the painted-steel material. */
  const P = <T extends THREE.BufferGeometry>(geometry: T, hex: number): T => {
    const colour = new THREE.Color(hex), count = geometry.attributes.position.count, data = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) { data[i * 3] = colour.r; data[i * 3 + 1] = colour.g; data[i * 3 + 2] = colour.b; }
    geometry.setAttribute("color", new THREE.BufferAttribute(data, 3));
    return geometry;
  };
  const plain = (geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, coloured = false) => {
    const part = new THREE.BufferGeometry(), count = geometry.attributes.position.count;
    part.setAttribute("position", geometry.attributes.position.clone());
    part.setAttribute("normal", geometry.attributes.normal.clone());
    part.setAttribute("uv", geometry.attributes.uv ? geometry.attributes.uv.clone() : new THREE.Float32BufferAttribute(count * 2, 2));
    if (coloured) part.setAttribute("color", (geometry.attributes.color ?? P(geometry, GREY).attributes.color).clone());
    part.setIndex(geometry.index ? geometry.index.clone() : Array.from({ length: count }, (_, i) => i));
    if (matrix) part.applyMatrix4(matrix);
    return part;
  };
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix?: THREE.Matrix4, opt: Opt = {}) => {
    const fine = opt.fine ?? false;
    if (fine && !high) return;
    const full = { shadow: opt.shadow ?? false, hit: opt.hit ?? false, fine, walk: opt.walk ?? false, zone: opt.zone ?? "near" };
    const key = `${material.uuid}|${full.zone}|${+full.shadow}${+full.hit}${+full.fine}${+full.walk}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { material, opt: full, parts: [] });
    batch.parts.push(plain(geometry, matrix, material === paint));
  };
  /** Adds parts in the local space of `matrix`. */
  const frame = (matrix: THREE.Matrix4, base: Opt = {}) =>
    (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, rotation?: V3, scale?: V3, opt?: Opt) =>
      put(geometry, material, matrix.clone().multiply(mat4(x, y, z, rotation, scale)), { ...base, ...opt });
  const world = frame(new THREE.Matrix4());
  const solid = frame(new THREE.Matrix4(), { shadow: true, hit: true });
  const cast = frame(new THREE.Matrix4(), { shadow: true });
  const fine = frame(new THREE.Matrix4(), { fine: true });
  const far = frame(new THREE.Matrix4(), { zone: "far" });
  const roof = frame(new THREE.Matrix4(), { zone: "roof" });
  const flush = () => {
    for (const batch of batches.values()) {
      const merged = mergeGeometries(batch.parts);
      batch.parts.forEach((part) => part.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.castShadow = batch.opt.shadow;
      mesh.receiveShadow = batch.opt.zone !== "far";
      if (batch.opt.walk) mesh.userData.walkThrough = true;
      scene.add(mesh);
      if (batch.opt.hit) kit.shootable.push(mesh);
      if (batch.opt.fine) kit.mirrorHidden.push(mesh);
    }
    batches.clear();
  };
  /** A flat plate cut from the sign sheet, facing +z. */
  const remap = <T extends THREE.BufferGeometry>(geometry: T, key: string): T => {
    const [u0, v0, u1, v1] = atlas.rects[key], uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return geometry;
  };
  const sign = (key: string, width: number) => remap(new THREE.PlaneGeometry(width, width / atlas.aspect[key]), key);
  /** A notice board on its backing plate, turned to face `yaw` (0 faces +z). */
  const board = (key: string, width: number, x: number, y: number, z: number, yaw: number, opt: Opt = {}) => {
    const matrix = mat4(x, y, z, [0, yaw, 0]);
    put(P(box(width + 0.05, width / atlas.aspect[key] + 0.05, 0.02), DARK), paint, matrix.clone().multiply(mat4(0, 0, -0.012)), opt);
    put(sign(key, width), signPaint, matrix, opt);
  };
  const painted = (key: string, width: number, x: number, y: number, z: number, yaw: number, opt: Opt = {}) => put(sign(key, width), stencilPaint, mat4(x, y, z, [0, yaw, 0]), opt);
  /** A length of hazard striping, facing +z before it is turned. */
  const stripes = (length: number, height: number) => {
    const geometry = new THREE.PlaneGeometry(length, height), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * length / (height * 4));
    return geometry;
  };
  /** Posts and rails between two points. */
  const railing = (a: V3, b: V3, height: number, rails: number[], opt: Opt = {}, pitch = 1.5, thick = 0.027) => {
    const count = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / pitch));
    for (let i = 0; i <= count; i += 1) { const t = i / count, x = lerp(a[0], b[0], t), y = lerp(a[1], b[1], t), z = lerp(a[2], b[2], t); put(rod([x, y, z], [x, y + height, z], thick), galv, undefined, opt); }
    for (const rail of rails) put(rod([a[0], a[1] + rail, a[2]], [b[0], b[1] + rail, b[2]], thick * 0.9), galv, undefined, opt);
  };
  const FACE_WEST = Math.PI / 2, FACE_EAST = -Math.PI / 2, FACE_BACK = Math.PI;

  // ---- Wind, and what lives in it -------------------------------------------
  // Down the gorge and across it: the wind comes off the falling water and leaves over the powerhouse.
  const wind = createWind({ heading: -1.9, strength: 0.42, gustiness: 0.65 });
  const trees = createTrees(kit, { seed: 7, wind, sun: () => sun });
  const cue = options.cue;
  const life = createLife(kit, options, { wind, seed: 31 });
  const props = createProps(kit);
  const say = (name: Parameters<NonNullable<typeof cue>>[0], at: V3, gain = 1, pitch = 1) => cue?.(name, new THREE.Vector3(...at), { gain, pitch });

  // ---- Ground --------------------------------------------------------------
  // The wet apron is the mirror floor; everything round it is plain slab and gravel.
  const apronDepth = BACK.z + 0.5 - APRON_END;
  const ground = standard({ ...photoSet("/textures/concrete_floor_worn_001-2k", 20.2 / 3.2, apronDepth / 3.2), color: 0xb9bcbc, normalScale: new THREE.Vector2(1.1, 1.1), envMapIntensity: 0.45 });
  const reflection = kit.floor(ground, { width: 20.2, depth: apronDepth, z: (BACK.z + 0.5 + APRON_END) / 2 }, {
    lane: new THREE.Color(0.8, 0.78, 0.7),
    edge: new THREE.Color(0.85, 0.6, 0.2),
    markings: 0.62,
    wet: 0.0,
  });
  {
    // Wetter toward the tailrace, where the spray comes over the wall; sawn joints every six metres.
    const base = ground.onBeforeCompile;
    ground.onBeforeCompile = (shader, renderer) => {
      base.call(ground, shader, renderer);
      shader.fragmentShader = shader.fragmentShader
        .replace("+ floorWetBias;", "+ floorWetBias + 0.13 * smoothstep(5.0, -9.5, slab.x) - 0.045;")
        .replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
          {
            vec2 bay = vec2(abs(fract(vFloorWorld.z / 6.0 + 0.25) - 0.5) * 6.0, abs(abs(vFloorWorld.x) - 4.75));
            float gap = min(bay.x, bay.y);
            diffuseColor.rgb *= 1.0 - 0.72 * (1.0 - smoothstep(0.012, 0.022, gap)) - 0.1 * (1.0 - smoothstep(0.0, 0.3, gap));
          }`);
    };
    ground.customProgramCacheKey = () => "hyperstrike-floor-v1|dam";
  }
  far(flat(10.1, 80, -72, BACK.z + 0.5, -0.02), yard);
  far(flat(CHANNEL.x1, 80, BACK.z + 0.5, 230, -0.02, 4), gravel);
  far(flat(-90, CHANNEL.x0, APRON_END, 230, -0.02, 4), gravel);
  far(flat(-90, BASIN.x0, -72, APRON_END, -0.02, 4), gravel);

  // ---- The tailrace side -----------------------------------------------------
  {
    // Slot drains: one the length of the west side, where the spray comes over, one across the roller door's threshold.
    const grate = (x: number, z: number) => put(remap(new THREE.PlaneGeometry(1, 0.22), "grate"), stencilPaint, mat4(x, 0.006, z, [-Math.PI / 2, 0, Math.PI / 2]), { fine: true });
    for (let z = -26; z < 9; z += 1) grate(-8.28, z + 0.5);
    for (let z = -8; z < -2; z += 1) grate(8.5, z + 0.5);
  }
  {
    // Training wall: 4.5 m of concrete from the basin to the end pier, flat where the signs hang.
    const z0 = APRON_END - 2, mid = (OPEN_Z + z0) / 2, wallLength = OPEN_Z - z0, x = -WALL_X - 0.3;
    solid(box(0.6, WEST_TOP + 4.5, wallLength), concrete, x, (WEST_TOP - 4.5) / 2, mid);
    cast(softBox(0.78, 0.14, wallLength, 0.03, 2.4), paleConcrete, x, WEST_TOP + 0.07, mid);
    railing([x, WEST_TOP + 0.14, z0 + 0.3], [x, WEST_TOP + 0.14, OPEN_Z - 0.2], 1.0, [0.5, 0.98], { shadow: true }, 1.6);
    // End pier, and the kerb the wall drops to beside the firing line; both stand in the channel.
    const pierMid = (PIER.z0 + PIER.z1) / 2, pierLong = PIER.z1 - PIER.z0;
    solid(box(0.9, PIER.top + 4.5, pierLong), concrete, PIER.x, (PIER.top - 4.5) / 2, pierMid);
    cast(softBox(1.06, 0.16, pierLong + 0.16, 0.03, 2.4), paleConcrete, PIER.x, PIER.top + 0.08, pierMid);
    solid(box(0.6, 4.5, 230 - PIER.z1), darkConcrete, x, -2.25, (230 + PIER.z1) / 2, undefined, undefined, { shadow: false });
    solid(softBox(0.6, KERB, BACK.z - PIER.z1, 0.03, 2.4), concrete, x, KERB / 2, (BACK.z + PIER.z1) / 2);
    railing([x, KERB, PIER.z1 + 0.3], [x, KERB, BACK.z - 0.2], 0.74, [0.37, 0.72], { shadow: true }, 1.4, 0.029);
    // A standard on the kerb carries the alarm bulkhead that would otherwise hang in the air at z = 3.5, and a floodlight for the water.
    cast(P(box(0.12, 3.9, 0.12), GREY), paint, -9.635, KERB + 1.95, 3.5);
    world(P(box(0.26, 0.03, 0.26), DARK), paint, -9.635, KERB + 0.015, 3.5);
    world(P(box(0.03, 0.32, 0.6), DARK), paint, -9.59, 3.62, 3.5);
    cast(P(box(0.5, 0.05, 0.05), GREY), paint, -9.83, KERB + 3.86, 3.5);
    cast(P(box(0.16, 0.24, 0.34), DARK), paint, -10.05, KERB + 3.8, 3.5, [0, 0, 0.5]);
    world(box(0.02, 0.2, 0.3), lampGlass, -10.125, KERB + 3.755, 3.5, [0, 0, 0.5]);
    // Hazard bands: under the coping the length of the range, and round the pier.
    world(stripes(18.4, 0.22), hazardPaint, -WALL_X + 0.004, WEST_TOP - 0.13, -17.8, [0, FACE_WEST, 0]);
    for (const y of [0.3, 1.05]) {
      world(stripes(PIER.z1 - PIER.z0, 0.3), hazardPaint, -WALL_X + 0.004, y, (PIER.z0 + PIER.z1) / 2, [0, FACE_WEST, 0]);
      world(stripes(0.9, 0.3), hazardPaint, PIER.x, y, PIER.z1 + 0.004);
    }
    // The staff gauge the wall was built with, and what it is called.
    painted("gauge", 0.36, -WALL_X + 0.004, 2.2, -19.8, FACE_WEST);
    painted("stTW1", 1.5, -WALL_X + 0.004, 3.75, -24, FACE_WEST);
    painted("stEL", 1.3, -WALL_X + 0.004, 0.55, -20.9, FACE_WEST);
    for (const z of [-3.0, 6.1]) painted("stKeep", 2.7, -WALL_X + 0.004, KERB / 2, z, FACE_WEST);
    // A conduit along the wall with two bulkhead lamps on it.
    fine(rod([-WALL_X + 0.05, 3.95, -27], [-WALL_X + 0.05, 3.95, OPEN_Z - 0.1], 0.028), galv);
    for (const z of [-26.6, -14.05]) {
      world(P(box(0.12, 0.2, 0.34), GREY), paint, -WALL_X + 0.06, 3.78, z);
      world(box(0.07, 0.12, 0.26), lampGlass, -WALL_X + 0.14, 3.76, z);
    }
    // Lifebuoy box at the far end.
    cast(P(box(0.22, 0.75, 0.75), ORANGE), paint, -WALL_X + 0.11, 1.5, -26.25);
    world(sign("save", 0.7), signPaint, -WALL_X + 0.224, 1.5, -26.25, [0, FACE_WEST, 0]);
    board("cache", 1.5, -WALL_X + 0.03, 2.75, -22.6, FACE_WEST);
    board("tradeUp", 1.1, -WALL_X + 0.03, 2.75, -25.65, FACE_WEST);

    // Stop logs stacked on bearers against the wall, their ends painted.
    for (let i = 0; i < 4; i += 1) {
      const y = 0.31 + i * 0.5, shift = (i % 2) * 0.12 - 0.06;
      solid(box(0.5, 0.42, 4.2, 1.4), rusty, -9.16, y, -22.6 + shift);
      for (const end of [-1, 1]) cast(P(box(0.52, 0.44, 0.22), YELLOW), paint, -9.16, y, -22.6 + shift + end * 2.0);
      for (const z of [-24.1, -22.6, -21.1]) cast(box(0.62, 0.08, 0.12, 0.8), timber, -9.14, y - 0.25, z);
      for (const end of [-1, 1]) fine(P(box(0.05, 0.1, 0.16), DARK), paint, -9.16, y + 0.24, -22.6 + shift + end * 1.5);
    }
    painted("stSL", 1.5, -8.905, 1.31, -22.66, FACE_WEST);
    // Line pipe on bearers under the second sign.
    for (const z of [-18.3, -15.7]) cast(box(0.7, 0.1, 0.12, 0.8), timber, -9.1, 0.05, z);
    [[-9.35, 0.19], [-9.14, 0.19], [-8.93, 0.19], [-9.245, 0.37], [-9.035, 0.37]].forEach(([px, py], i) => cast(P(cyl(0.1, 4.1 - (i % 2) * 0.3, "z", 12), i === 3 ? BLUE : PIPE), paint, px, py, -17 + (i % 3) * 0.08));
    // Hydrant and hose reel between the signs.
    cast(P(cyl(0.07, 0.95, "y", 10), RED), paint, -9.3, 0.475, -14.05);
    cast(P(cyl(0.1, 0.1, "y", 10), RED), paint, -9.3, 0.98, -14.05);
    for (const side of [-1, 1]) world(P(cyl(0.045, 0.12, "z", 8), GREY), paint, -9.3, 0.72, -14.05 + side * 0.11);
    cast(P(cyl(0.3, 0.13, "x", 18), RED), paint, -9.42, 1.72, -14.05);
    world(P(cyl(0.11, 0.16, "x", 12), DARK), paint, -9.4, 1.72, -14.05);
    // A reel of hose line chocked at the far end.
    cableDrum(-8.96, -26.35, 0.62, 0.66, "x");
  }
  /** A timber cable drum standing on its flanges, axle along `axis`. */
  function cableDrum(x: number, z: number, radius: number, wide: number, axis: "x" | "z") {
    const turn: V3 = axis === "x" ? [0, 0, 0] : [0, Math.PI / 2, 0], add = frame(mat4(x, radius, z, turn), { shadow: true });
    for (const side of [-1, 1]) {
      add(cyl(radius, 0.06, "x", 22), timber, side * (wide / 2 - 0.03), 0, 0, undefined, undefined, { hit: true });
      for (let i = 0; i < 6; i += 1) add(P(cyl(0.022, 0.02, "x", 6), DARK), paint, side * (wide / 2 + 0.005), Math.cos(i * TAU / 6) * radius * 0.5, Math.sin(i * TAU / 6) * radius * 0.5, undefined, undefined, { fine: true, shadow: false });
    }
    add(P(cyl(radius * 0.74, wide - 0.14, "x", 20), BLACK), paint, 0, 0, 0);
    add(P(cyl(0.06, wide + 0.08, "x", 8), DARK), paint, 0, 0, 0);
    for (const side of [-1, 1]) add(box(0.3, 0.1, 0.16, 0.8), timber, 0, -radius + 0.05, side * radius * 0.52, [side * 0.5, 0, 0]);
  }
  {
    // Beside the firing line: bollards along the kerb, a davit over the water, a lifebuoy on the rail.
    const x = -WALL_X - 0.3;
    for (const z of [-5.3, -0.7, 4.1, 8.1]) solid(bollard(), metals.darkMetal, -9.0, 0, z);
    // The davit: post, jib and brace, a hand winch and its rope.
    const tip: V3 = [-12.0, 3.25, 1.6];
    cast(P(cyl(0.2, 0.06, "y", 14), YELLOW), paint, x, KERB + 0.03, 1.6);
    cast(P(cyl(0.075, 2.7, "y", 12), YELLOW), paint, x, KERB + 1.35, 1.6);
    cast(P(rod([x, KERB + 2.6, 1.6], tip, 0.06, 8), YELLOW), paint);
    cast(P(rod([x, KERB + 1.5, 1.6], [x - 1.25, 3.2, 1.6], 0.035, 6), YELLOW), paint);
    cast(P(box(0.26, 0.3, 0.3), DARK), paint, x + 0.14, 1.5, 1.6);
    world(P(cyl(0.11, 0.24, "z", 12), STEEL), paint, x + 0.14, 1.5, 1.6);
    fine(P(rod([x + 0.14, 1.5, 1.76], [x + 0.14, 1.66, 1.9], 0.012), STEEL), paint);
    fine(P(rod([x + 0.14, 1.66, 1.9], [x + 0.3, 1.66, 1.9], 0.016), BLACK), paint);
    fine(P(rod([x + 0.1, 1.62, 1.6], [x, KERB + 2.66, 1.6], 0.008), STEEL), paint);
    fine(P(rod([x, KERB + 2.7, 1.6], [tip[0], tip[1] + 0.08, tip[2]], 0.008), STEEL), paint);
    world(P(cyl(0.07, 0.05, "z", 12), DARK), paint, tip[0], tip[1], tip[2]);
    // Its chain and hook hang free and swing with the wind.
    const hook = new THREE.Group();
    hook.position.set(...tip);
    const hung = mergeGeometries([
      plain(P(rod([0, 0, 0], [0, -2.5, 0], 0.012), STEEL), undefined, true),
      plain(P(box(0.12, 0.22, 0.09), YELLOW), mat4(0, -2.6, 0), true),
      plain(P(new THREE.TorusGeometry(0.07, 0.018, 6, 12, Math.PI * 1.4), DARK), mat4(0, -2.8, 0, [0, 0, -2.6]), true),
    ]);
    const hookMesh = new THREE.Mesh(hung, paint);
    hookMesh.userData.walkThrough = true;
    hook.add(hookMesh);
    scene.add(hook);
    kit.mirrorHidden.push(hook);
    life.sway(hook, { amplitude: 0.1, period: 3.1, creak: "chainRattle", damping: 0.05 });
    // Lifebuoy on its board.
    cast(P(box(0.03, 0.9, 0.9), WHITE), paint, x - 0.06, 0.98, 6.4);
    cast(P(new THREE.TorusGeometry(0.31, 0.065, 8, 22).rotateY(Math.PI / 2), ORANGE), paint, x + 0.02, 0.98, 6.4);
    for (let i = 0; i < 4; i += 1) fine(P(new THREE.TorusGeometry(0.31, 0.069, 8, 5, 0.4).rotateY(Math.PI / 2), WHITE), paint, x + 0.02, 0.98, 6.4, [i * Math.PI / 2 + 0.6, 0, 0]);
    // The far bank of the channel: its wall, the name of the water, a gauge board and an outfall.
    far(box(0.8, 5.2, 230 - APRON_END), darkConcrete, CHANNEL.x0 - 0.4, -2.0, (230 + APRON_END) / 2);
    far(softBox(1.0, 0.16, 230 - APRON_END, 0.03, 2.4), paleConcrete, CHANNEL.x0 - 0.4, 0.68, (230 + APRON_END) / 2);
    painted("stTailrace", 8.4, CHANNEL.x0 + 0.01, -0.5, -0.5, FACE_WEST, { zone: "far" });
    far(P(box(0.05, 2.75, 0.62), WHITE), paint, CHANNEL.x0 + 0.03, -0.72, 7.5);
    painted("gauge", 0.3, CHANNEL.x0 + 0.062, -0.5, 7.5, FACE_WEST, { zone: "far" });
    far(P(cyl(0.34, 0.9, "x", 14), DARK), paint, CHANNEL.x0 + 0.2, -0.75, -15);
    for (let y = -1.9; y < 0.5; y += 0.3) far(P(box(0.14, 0.035, 0.42), DARK), paint, CHANNEL.x0 + 0.07, y, 13);
    for (const rail of [0.5, 1.0]) far(rod([CHANNEL.x0 - 0.4, 0.76 + rail, APRON_END], [CHANNEL.x0 - 0.4, 0.76 + rail, 70], 0.03, 5), galv);
    for (let z = APRON_END; z <= 70; z += 2.8) far(rod([CHANNEL.x0 - 0.4, 0.76, z], [CHANNEL.x0 - 0.4, 1.76, z], 0.03, 5), galv);
  }

  // ---- The powerhouse --------------------------------------------------------
  {
    // The wall the furnace stands against is a skin with the roller door set back in it.
    const x = WALL_X + 0.3;
    solid(box(0.6, POWER.top, DOOR.z0 - POWER.z0), concrete, x, POWER.top / 2, (DOOR.z0 + POWER.z0) / 2);
    solid(box(0.6, POWER.top, POWER.z1 - DOOR.z1), concrete, x, POWER.top / 2, (POWER.z1 + DOOR.z1) / 2);
    solid(box(0.6, POWER.top - DOOR.top, DOOR.z1 - DOOR.z0), concrete, x, (POWER.top + DOOR.top) / 2, (DOOR.z0 + DOOR.z1) / 2);
    solid(box(POWER.x1 - WALL_X - 0.6, POWER.top, POWER.z1 - POWER.z0), concrete, (POWER.x1 + WALL_X + 0.6) / 2, POWER.top / 2, (POWER.z0 + POWER.z1) / 2);
    cast(softBox(0.86, 0.18, POWER.z1 - POWER.z0, 0.03, 2.4), paleConcrete, x, POWER.top + 0.09, (POWER.z0 + POWER.z1) / 2);
    for (const [z0, z1] of [[-27.6, DOOR.z0 - 0.02], [DOOR.z1 + 0.02, BACK.z]]) world(softBox(0.07, 0.34, z1 - z0, 0.02, 2.4), darkConcrete, WALL_X - 0.02, 0.17, (z0 + z1) / 2);
    roof(flat(WALL_X + 0.6, POWER.x1, POWER.z0, POWER.z1, POWER.top + 0.01, 4), roofing);
    railing([x, POWER.top + 0.18, POWER.z0 + 0.3], [x, POWER.top + 0.18, POWER.z1 - 0.3], 1.05, [0.52, 1.03], { zone: "roof" }, 2.0, 0.032);

    // The roller door: slats, guides, a hood, and the notice everybody has stopped reading.
    const doorMid = (DOOR.z0 + DOOR.z1) / 2, doorWide = DOOR.z1 - DOOR.z0;
    const slats = new THREE.PlaneGeometry(doorWide, DOOR.top), uv = slats.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getY(i) * DOOR.top / 1.5, uv.getX(i) * doorWide / 1.5);
    solid(slats, shutter, WALL_X + 0.36, DOOR.top / 2, doorMid, [0, FACE_EAST, 0], undefined, { shadow: false });
    for (const z of [DOOR.z0 + 0.07, DOOR.z1 - 0.07]) cast(P(box(0.2, DOOR.top, 0.14), DARK), paint, WALL_X + 0.26, DOOR.top / 2, z);
    cast(P(box(0.5, 0.56, doorWide + 0.5), GREY), paint, WALL_X - 0.2, DOOR.top + 0.3, doorMid);
    world(stripes(doorWide - 0.3, 0.14), hazardPaint, WALL_X + 0.35, 0.09, doorMid, [0, FACE_EAST, 0]);
    world(P(box(0.08, 0.16, doorWide - 0.28), DARK), paint, WALL_X + 0.33, 0.09, doorMid);
    board("doorStuck", 1.7, WALL_X + 0.33, 1.95, doorMid + 0.4, FACE_EAST);
    board("cases", 1.0, WALL_X - 0.03, 2.9, -9.22, FACE_EAST);
    painted("stT2", 2.3, WALL_X + 0.352, 4.2, doorMid, FACE_EAST);
    for (const z of [DOOR.z0 - 0.42, DOOR.z1 + 0.42]) {
      solid(P(cyl(0.085, 1.1, "y", 12), YELLOW), paint, 9.12, 0.55, z);
      for (const y of [0.42, 0.78]) fine(P(cyl(0.088, 0.12, "y", 12), BLACK), paint, 9.12, y, z);
      world(P(new THREE.SphereGeometry(0.085, 12, 6, 0, TAU, 0, Math.PI / 2), YELLOW), paint, 9.12, 1.1, z);
    }
    // Its push-button station and the chain of the hand hoist.
    cast(P(box(0.12, 0.34, 0.22), YELLOW), paint, WALL_X - 0.06, 1.45, DOOR.z1 + 0.36);
    for (const [dy, hex] of [[0.08, 0x2f8f4a], [-0.02, RED], [-0.1, BLACK]]) fine(P(cyl(0.025, 0.03, "x", 8), hex), paint, WALL_X - 0.13, 1.45 + dy, DOOR.z1 + 0.36);
    fine(P(rod([WALL_X - 0.18, DOOR.top + 0.05, DOOR.z0 - 0.2], [WALL_X - 0.18, 1.1, DOOR.z0 - 0.2], 0.012), STEEL), paint);
    fine(P(rod([WALL_X - 0.1, DOOR.top + 0.05, DOOR.z0 - 0.2], [WALL_X - 0.1, 1.3, DOOR.z0 - 0.2], 0.012), STEEL), paint);

    // Plant room B: a steel door with a lamp over it.
    cast(P(box(0.05, 2.1, 1.0), 0x4d6066), paint, WALL_X - 0.015, 1.05, 0.8);
    for (const z of [0.26, 1.34]) world(P(box(0.09, 2.2, 0.08), DARK), paint, WALL_X - 0.03, 1.1, z);
    world(P(box(0.09, 0.08, 1.16), DARK), paint, WALL_X - 0.03, 2.16, 0.8);
    fine(P(box(0.05, 0.03, 0.14), STEEL), paint, WALL_X - 0.07, 1.02, 1.18);
    world(sign("plantB", 0.46), signPaint, WALL_X - 0.045, 1.6, 0.8, [0, FACE_EAST, 0]);
    world(P(box(0.12, 0.16, 0.3), GREY), paint, WALL_X - 0.06, 2.45, 0.8);
    world(box(0.07, 0.1, 0.22), lampGlass, WALL_X - 0.14, 2.43, 0.8);

    // The valve manifold: a header on saddles, four risers through gate valves into the wall, a gauge.
    const mx = 9.14;
    cast(P(cyl(0.16, 5.4, "z", 14), BLUE), paint, mx, 0.55, 5.0);
    cast(P(pipe([[mx, 0.55, 2.3], [mx, 0.5, 2.12], [mx, 0.3, 2.02], [mx, 0, 2.0]], 0.16, 12, 14), BLUE), paint);
    for (const z of [2.34, 3.7, 5.1, 6.5, 7.7]) world(P(cyl(0.22, 0.06, "z", 14), 0x30535d), paint, mx, 0.55, z);
    for (const z of [3.35, 6.85]) cast(box(0.5, 0.39, 0.3), darkConcrete, mx, 0.195, z);
    [3.0, 4.4, 5.8, 7.2].forEach((z, i) => {
      cast(P(cyl(0.09, 1.1, "y", 12), BLUE), paint, mx, 1.24, z);
      cast(P(cyl(0.09, 0.44, "x", 12), BLUE), paint, mx + 0.2, 1.76, z);
      world(P(new THREE.SphereGeometry(0.092, 10, 8), BLUE), paint, mx, 1.76, z);
      cast(P(cyl(0.15, 0.28, "y", 12), 0x30535d), paint, mx, 1.15, z);
      for (const y of [0.99, 1.31]) world(P(cyl(0.18, 0.04, "y", 12), 0x30535d), paint, mx, y, z);
      world(P(cyl(0.024, 0.34, "x", 6), STEEL), paint, mx - 0.24, 1.15, z);
      cast(P(new THREE.TorusGeometry(0.17, 0.022, 6, 18).rotateY(Math.PI / 2), RED), paint, mx - 0.4, 1.15, z, [i * 0.7, 0, 0]);
      for (const turn of [0, Math.PI / 2]) world(P(box(0.02, 0.33, 0.028), RED), paint, mx - 0.4, 1.15, z, [i * 0.7 + turn, 0, 0]);
    });
    world(P(cyl(0.02, 0.26, "y", 6), STEEL), paint, mx, 0.83, 2.7);
    world(P(cyl(0.09, 0.05, "x", 16), DARK), paint, mx - 0.02, 1.03, 2.7);
    world(remap(new THREE.CircleGeometry(0.08, 18), "dial"), signPaint, mx - 0.05, 1.03, 2.7, [0, FACE_EAST, 0]);
    world(P(cyl(0.035, 0.32, "y", 8), STEEL), paint, mx, 1.95, 7.2);
    board("forceBuy", 0.7, WALL_X - 0.03, 2.5, 5.1, FACE_EAST);
    board("pattern", 0.36, WALL_X - 0.03, 2.25, 3.4, FACE_EAST);
    board("float", 0.42, WALL_X - 0.03, 1.5, 8.55, FACE_EAST);

    // Motor control cabinet between the sign and the furnace, fed from the tray overhead.
    cast(P(box(0.42, 2.0, 0.86), GREY), paint, WALL_X - 0.21, 1.06, -14.1, undefined, undefined, { hit: true });
    world(box(0.46, 0.06, 0.9), darkConcrete, WALL_X - 0.23, 0.03, -14.1);
    world(sign("cabinet", 0.84), signPaint, WALL_X - 0.425, 1.07, -14.1, [0, FACE_EAST, 0]);

    // Cable tray under the louvres: it breaks where the furnace flue goes up the wall.
    const trayY = 6.3;
    for (const [z0, z1] of [[-27.4, -13.3], [-12.0, BACK.z - 0.1]]) {
      const mid = (z0 + z1) / 2, run = z1 - z0;
      for (const dx of [0.06, 0.36]) cast(P(box(0.025, 0.075, run), 0x7b8284), paint, WALL_X - dx, trayY, mid);
      for (let z = z0 + 0.25; z < z1; z += 0.5) fine(P(box(0.3, 0.02, 0.04), 0x7b8284), paint, WALL_X - 0.21, trayY - 0.025, z);
      for (let z = z0 + 0.5; z < z1; z += 1.9) { cast(box(0.42, 0.045, 0.05), galv, WALL_X - 0.21, trayY - 0.06, z); fine(rod([WALL_X - 0.4, trayY - 0.06, z], [WALL_X - 0.02, trayY - 0.34, z], 0.016, 4), galv); }
      [0.1, 0.15, 0.21, 0.27, 0.32].forEach((dx, i) => cast(P(rod([WALL_X - dx, trayY + 0.01, z0], [WALL_X - dx, trayY + 0.01, z1], i === 2 ? 0.03 : 0.02, 5), i === 1 ? 0x3a2d22 : BLACK), paint));
      for (const z of [z0, z1]) world(P(box(0.3, 0.3, 0.12), GREY), paint, WALL_X - 0.15, trayY + 0.02, z);
    }
    for (const [z, to] of [[-14.1, 2.06], [DOOR.z1 + 0.36, 1.62], [0.8, 2.53], [-26.0, 4.2]]) cast(rod([WALL_X - 0.04, trayY - 0.04, z], [WALL_X - 0.04, to, z], 0.022), galv);
    // Swan-neck lamps.
    for (const z of [-26.3, -20.0, -9.3, -0.9, 5.2]) {
      world(P(box(0.03, 0.2, 0.2), GREY), paint, WALL_X - 0.015, 5.52, z);
      cast(pipe([[WALL_X - 0.02, 5.52, z], [9.2, 5.68, z], [8.92, 5.6, z], [8.86, 5.4, z]], 0.022, 6, 14), galv);
      cast(P(cyl(0.2, 0.17, "y", 14, 0.05), TANK), paint, 8.86, 5.32, z);
      world(cyl(0.12, 0.02, "y", 12), lampGlass, 8.86, 5.228, z);
    }
    // Louvres of the turbine hall.
    for (const z of [-40, -34, -28, -22, -16, -10, -4, 2, 8]) {
      for (const y of [7.1, 9.3]) cast(P(box(0.16, 0.12, 3.0), GREY), paint, WALL_X - 0.04, y, z);
      for (const side of [-1, 1]) cast(P(box(0.16, 2.2, 0.12), GREY), paint, WALL_X - 0.04, 8.2, z + side * 1.44);
      world(P(box(0.02, 2.1, 2.8), 0x0b0d0e), paint, WALL_X - 0.008, 8.2, z);
      for (let i = 0; i < 11; i += 1) cast(P(box(0.2, 0.025, 2.78), GREY), paint, WALL_X - 0.06, 7.26 + i * 0.19, z, [0, 0, 0.62], undefined, { fine: i % 2 === 1 });
    }
    painted("stUnit", 2.6, WALL_X - 0.004, 4.05, -20.5, FACE_EAST);
    // Gas bottles chained at the far end.
    [[9.3, -26.25, 0x6a2a22], [9.3, -26.52, 0x6a2a22], [9.28, -26.8, 0x2f4d6a]].forEach(([bx, bz, hex]) => {
      cast(P(cyl(0.115, 1.35, "y", 12), hex), paint, bx, 0.675, bz);
      world(P(new THREE.SphereGeometry(0.115, 12, 6, 0, TAU, 0, Math.PI / 2), hex), paint, bx, 1.35, bz);
      fine(P(cyl(0.04, 0.12, "y", 8), STEEL), paint, bx, 1.5, bz);
    });
    fine(P(rod([9.16, 1.0, -26.1], [9.16, 1.0, -26.95], 0.008), STEEL), paint);
  }

  // ---- The transformer yard on the powerhouse roof ---------------------------
  {
    const y = POWER.top, tx = 13.4, gx = 11.3;
    const lattice = (x: number, z: number, tall: number, foot: number, head: number, levels: number) => {
      const corner = (level: number, i: number): V3 => { const half = lerp(foot, head, level / levels) / 2; return [x + (i === 0 || i === 3 ? -half : half), y + (level / levels) * tall, z + (i < 2 ? -half : half)]; };
      for (let i = 0; i < 4; i += 1) roof(P(rod(corner(0, i), corner(levels, i), 0.05, 4), STEEL), paint);
      for (let level = 0; level < levels; level += 1) for (let i = 0; i < 4; i += 1) {
        roof(P(rod(corner(level, i), corner(level + 1, (i + 1) % 4), 0.028, 4), STEEL), paint);
        if (level > 0) roof(P(rod(corner(level, i), corner(level, (i + 1) % 4), 0.028, 4), STEEL), paint);
      }
    };
    // Gantry: two lattice towers and the beam the line is strung from.
    const beamY = y + 9, z0 = -25.5, z1 = -2.5;
    for (const z of [z0, z1]) { lattice(gx, z, 9.4, 1.4, 0.7, 6); roof(P(rod([gx, y + 9.4, z], [gx, y + 12.2, z], 0.03, 4), STEEL), paint); }
    for (const dx of [-0.35, 0.35]) for (const dy of [-0.35, 0.35]) roof(P(rod([gx + dx, beamY + dy, z0], [gx + dx, beamY + dy, z1], 0.045, 4), STEEL), paint);
    for (let i = 0; i < 10; i += 1) {
      const a = lerp(z0, z1, i / 10), b = lerp(z0, z1, (i + 1) / 10), flip = i % 2 ? 0.35 : -0.35;
      for (const dx of [-0.35, 0.35]) roof(P(rod([gx + dx, beamY + flip, a], [gx + dx, beamY - flip, b], 0.025, 4), STEEL), paint);
      roof(P(rod([gx - 0.35, beamY + 0.35, a], [gx + 0.35, beamY + 0.35, b], 0.02, 4), STEEL), paint);
    }
    [-21, -14, -7].forEach((z, unit) => {
      // The transformer: tank, radiators, conservator, and three bushings leaning toward the gantry.
      roof(box(3.4, 0.3, 5.4), darkConcrete, tx, y + 0.15, z);
      roof(P(box(2.4, 2.6, 3.2), TANK), paint, tx, y + 1.6, z);
      roof(P(box(2.6, 0.1, 3.4), 0x56665f), paint, tx, y + 2.95, z);
      for (const side of [-1, 1]) for (let i = 0; i < 6; i += 1) roof(P(box(1.9, 2.0, 0.045), 0x56665f), paint, tx, y + 1.55, z + side * (1.72 + i * 0.12));
      roof(P(cyl(0.38, 2.4, "z", 14), TANK), paint, tx + 0.9, y + 3.8, z);
      for (const side of [-1, 1]) roof(P(box(0.08, 0.5, 0.08), TANK), paint, tx + 0.9, y + 3.2, z + side * 0.8);
      roof(sign("hv", 0.7), signPaint, tx - 1.21, y + 1.7, z, [0, FACE_EAST, 0]);
      [-0.95, 0, 0.95].forEach((dz, phase) => {
        const foot: V3 = [tx - 0.7, y + 3.0, z + dz], top: V3 = [foot[0] - 0.36, foot[1] + 1.75, foot[2]], hang: V3 = [gx, beamY - 0.35, z + dz * 1.5];
        roof(P(insulator(1.6, 0.17, 9), GLAZE), paint, foot[0], foot[1], foot[2], [0, 0, 0.2]);
        roof(P(cyl(0.05, 0.22, "y", 8), STEEL), paint, top[0], top[1], top[2]);
        // A string of discs from the beam, and the jumper down to the bushing.
        roof(P(insulator(1.3, 0.13, 8), GLAZE), paint, hang[0], hang[1] - 1.3, hang[2]);
        roof(P(pipe([top, [(top[0] + hang[0]) / 2 - 0.25, (top[1] + hang[1] - 1.3) / 2 - 0.5, (top[2] + hang[2]) / 2], [hang[0], hang[1] - 1.3, hang[2]]], 0.022, 5, 12), BLACK), paint);
        // The line itself, climbing to the tower on the east rim.
        if (unit === 1) roof(P(pipe([[gx, beamY - 0.3, z + dz * 1.5], [30, beamY + 12, z + dz * 2.2 - 4], [52, 54 + (phase === 1 ? 3 : 0), -22 + dz * 3]], 0.03, 5, 26), BLACK), paint);
      });
    });
    // Blast walls between the units.
    for (const z of [-17.5, -10.5]) roof(box(4.6, 4.4, 0.3), darkConcrete, tx + 0.2, y + 2.2, z);
    // The line's first tower, on the rim.
    {
      const x = 52, base = 41, z = -22;
      const corner = (t: number, i: number): V3 => { const half = lerp(2.6, 0.5, t); return [x + (i === 0 || i === 3 ? -half : half), base + t * 18, z + (i < 2 ? -half : half)]; };
      for (let i = 0; i < 4; i += 1) far(P(rod(corner(0, i), corner(1, i), 0.09, 4), STEEL), paint);
      for (let level = 0; level < 6; level += 1) for (let i = 0; i < 4; i += 1) far(P(rod(corner(level / 6, i), corner((level + 1) / 6, (i + 1) % 4), 0.05, 4), STEEL), paint);
      for (const h of [13, 16]) far(P(rod([x, base + h, z - 4.2], [x, base + h, z + 4.2], 0.08, 4), STEEL), paint);
    }
  }

  // ---- The control building behind the firing line ---------------------------
  {
    const mid = (WALL_X - 10.14) / 2, wide = WALL_X + 10.14, face = BACK.z - 0.03;
    solid(box(wide, BACK.top, BACK.depth), concrete, mid, BACK.top / 2, BACK.z + BACK.depth / 2);
    cast(softBox(wide + 0.3, 0.16, BACK.depth + 0.3, 0.03, 2.4), paleConcrete, mid, BACK.top + 0.08, BACK.z + BACK.depth / 2);
    world(softBox(wide - 0.7, 0.34, 0.07, 0.02, 2.4), darkConcrete, mid - 0.3, 0.17, BACK.z - 0.02);
    roof(flat(-10.14, WALL_X, BACK.z, BACK.z + BACK.depth, BACK.top + 0.165, 4), roofing);
    railing([-9.95, BACK.top + 0.16, BACK.z + 0.12], [WALL_X - 0.2, BACK.top + 0.16, BACK.z + 0.12], 1.0, [0.5, 0.98], { shadow: true }, 1.63, 0.03);
    // Warning boards either side of the chart.
    board("danger", 1.5, -7.85, 2.9, face, FACE_BACK);
    board("noSwim", 0.74, -8.72, 1.55, face, FACE_BACK);
    board("crows", 1.02, -7.55, 1.72, face, FACE_BACK);
    board("eco", 0.8, -8.5, 4.25, face, FACE_BACK);
    board("company", 2.8, 7.82, 4.0, face, FACE_BACK);
    board("gateOpen", 1.4, 7.2, 2.9, face, FACE_BACK);
    board("ear", 0.52, 8.72, 2.9, face, FACE_BACK);
    board("days", 1.12, 7.1, 1.75, face, FACE_BACK);
    board("lossBonus", 0.92, 8.5, 1.85, face, FACE_BACK);
    board("rushB", 1.3, -7.3, 4.3, face, FACE_BACK);
    // The siren: two horns on a bracket, above the boards.
    const sx = -8.1, sy = 6.6;
    cast(P(box(0.1, 0.1, 0.62), GREY), paint, sx, sy, BACK.z - 0.3);
    cast(P(box(0.34, 0.3, 0.3), YELLOW), paint, sx, sy + 0.04, BACK.z - 0.62);
    for (const side of [-1, 1]) cast(P(cyl(0.34, 0.8, "z", 18, 0.06).rotateY(Math.PI), 0xb7bdbd), paint, sx + side * 0.3, sy + 0.05, BACK.z - 0.98, [0, side * -0.42, 0]);
    world(P(box(0.3, 0.2, 0.03), WHITE), paint, sx, sy - 0.42, BACK.z - 0.02);
    // Conduit across the wall head, and its boxes.
    fine(rod([-9.5, 7.26, BACK.z - 0.04], [WALL_X - 0.05, 7.26, BACK.z - 0.04], 0.028), galv);
    for (const x of [-8.1, -6.4, 6.4, 8.6]) fine(P(box(0.18, 0.18, 0.09), GREY), paint, x, 7.26, BACK.z - 0.05);
    fine(rod([sx, 7.26, BACK.z - 0.04], [sx, sy + 0.1, BACK.z - 0.04], 0.02), galv);

    // On the roof: a radio mast, two condensers and the windsock's pole. Their shadows lie on the firing line.
    const top = BACK.top + 0.16;
    cast(P(rod([4.6, top, 11.0], [4.6, top + 7.4, 11.0], 0.06, 8), STEEL), paint);
    for (const [h, reach] of [[4.2, 0.9], [5.4, 0.7], [6.6, 0.5]]) cast(P(rod([4.6 - reach, top + h, 11.0], [4.6 + reach, top + h, 11.0], 0.022, 4), STEEL), paint);
    cast(P(cyl(0.42, 0.1, "z", 18, 0.3), WHITE), paint, 4.6, top + 3.1, 10.85);
    for (const stay of [[-1.6, 9.95], [1.7, 12.4], [1.4, 9.95]]) fine(P(rod([4.6, top + 5.2, 11.0], [4.6 + stay[0], top, stay[1]], 0.008), STEEL), paint, 0, 0, 0, undefined, undefined, { shadow: true });
    for (const x of [-3.2, -1.2]) {
      cast(P(box(1.6, 1.1, 0.9), 0xa9b0b0), paint, x, top + 0.65, 10.75);
      world(P(cyl(0.36, 0.03, "z", 16), DARK), paint, x, top + 0.68, 10.29);
      for (const dx of [-0.6, 0.6]) world(P(box(0.08, 0.12, 0.8), DARK), paint, x + dx, top + 0.06, 10.75);
    }
    cast(P(rod([-7.6, top, 10.5], [-7.6, top + 3.3, 10.5], 0.04, 8), WHITE), paint);
    cast(P(rod([-7.6, top + 1.2, 10.5], [-7.6, top + 2.2, 10.5], 0.042, 8), RED), paint);
  }
  // The windsock turns to the wind and fills with it.
  const sock = new THREE.Group(), sockAt = new THREE.Vector3(-7.6, BACK.top + 3.46, 10.5);
  {
    const cone = new THREE.CylinderGeometry(0.11, 0.27, 1.7, 14, 5, true);
    cone.rotateZ(Math.PI / 2); cone.translate(0.85, 0, 0);
    const position = cone.attributes.position, data = new Float32Array(position.count * 3), orange = new THREE.Color(ORANGE), white = new THREE.Color(WHITE);
    for (let i = 0; i < position.count; i += 1) { const band = Math.floor(position.getX(i) / 0.34 + 0.001) % 2 === 0 ? orange : white; data.set([band.r, band.g, band.b], i * 3); }
    cone.setAttribute("color", new THREE.BufferAttribute(data, 3));
    const mesh = new THREE.Mesh(cone, standard({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }));
    sock.add(mesh);
    sock.position.copy(sockAt);
    scene.add(sock);
    kit.mirrorHidden.push(sock);
    let fill = 0.5, creaked = 0;
    kit.updates.push((now) => {
      const time = now / 1000, gust = clamp(wind.at(sockAt.x, sockAt.z) * 1.5);
      fill += (gust - fill) * 0.04;
      sock.rotation.y = Math.atan2(-wind.direction.y, wind.direction.x) + Math.sin(time * 0.7) * 0.12 * (1.2 - fill) + Math.sin(time * 2.3) * 0.04;
      mesh.rotation.z = -(1 - fill) * 1.15 + Math.sin(time * 5.1) * 0.03 * fill;
      // The swivel complains when a gust takes it.
      if (gust > 0.78 && fill < 0.6 && time > creaked) { creaked = time + 14; say("metalCreak", [sockAt.x, sockAt.y, sockAt.z], 0.5, 1.2 + (time % 1) * 0.3); }
    });
  }

  // ---- The far end of the apron ------------------------------------------------
  {
    // A kerb and a rail over the basin, barriers behind the control centre, and the stop logs the crest crane lifts.
    solid(box(20.28, 4.9, 0.6), darkConcrete, 0, -2.05, APRON_END - 0.3, undefined, undefined, { shadow: false });
    world(softBox(20.28, 0.3, 0.6, 0.03, 2.4), concrete, 0, 0.15, APRON_END - 0.3);
    railing([-9.6, 0.3, APRON_END - 0.3], [9.6, 0.3, APRON_END - 0.3], 1.1, [0.55, 1.08], {}, 1.92, 0.03);
    for (const x of [-7.05, -2.35, 2.35, 7.05]) cast(jerseyBarrier(4.5), concrete, x, 0, -29.3);
    for (let i = 0; i < 5; i += 1) {
      const row = i < 3 ? 0 : 1, x = -4.2 + (row ? 0.35 : 0), z = -36.2 + (row ? (i - 3) * 1.1 + 0.55 : i * 1.1);
      cast(box(8.8, 0.8, 0.9, 1.4), rusty, x, 0.52 + row * 0.92, z);
      for (const end of [-1, 1]) world(P(box(0.4, 0.82, 0.92), YELLOW), paint, x + end * 4.25, 0.52 + row * 0.92, z);
    }
    for (const x of [-7.6, -0.8]) world(box(0.2, 0.12, 4.2, 0.8), timber, x, 0.06, -35.1);
    cast(P(box(7.6, 0.4, 0.4), YELLOW), paint, 4.4, 0.5, -33.2);
    for (const x of [1.4, 7.4]) world(box(0.3, 0.3, 0.9, 0.8), timber, x, 0.15, -33.2);
    painted("n3", 2.2, 5.5, 0.006, -38.2, 0, { fine: true });
  }

  // ---- The dam ---------------------------------------------------------------
  const damParts: THREE.BufferGeometry[] = [];
  /** Adds a part to the dam's one mesh; `shade` is the daylight it gets and `tint` paints it. */
  const dam = (geometry: THREE.BufferGeometry, shade = 1, tint: V3 = [1, 1, 1], matrix?: THREE.Matrix4) => {
    const part = plain(geometry, matrix), count = part.attributes.position.count, colour = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) { colour[i * 3] = shade * tint[0]; colour[i * 3 + 1] = shade * tint[1]; colour[i * 3 + 2] = shade * tint[2]; }
    part.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    damParts.push(part);
  };
  const damBox = (w: number, h: number, d: number, x: number, y: number, z: number, shade = 1, tint?: V3) => dam(box(w, h, d, 6), shade, tint, mat4(x, y, z));
  const STEEL_BLUE: V3 = [0.42, 0.56, 0.62], GLASS: V3 = [0.5, 0.62, 0.7];
  const spillX0 = GATES[0] - 6.5, spillX1 = GATES[GATES.length - 1] + 6.5;
  {
    // Non-overflow blocks either side of the spillway, every other one standing a hand proud of its neighbour.
    const blocks = [[-DAM.half, -64], [-64, spillX0 - 1.6], [spillX1 + 1.6, 16], [16, 32], [32, 48], [48, 64], [64, DAM.half]];
    blocks.forEach(([x0, x1], i) => dam(faceQuad(x0, x1, -6, DAM.crest, i % 2 ? 0.16 : 0), 0.96 + 0.06 * hash1(i, 3)));
    // The crest road oversails the face; under it the face is in its shade.
    for (const [x0, x1] of [[-DAM.half, spillX0 - 1.6], [spillX1 + 1.6, DAM.half]]) {
      const mid = (x0 + x1) / 2, wide = x1 - x0, edge = faceZ(DAM.crest) + 0.7;
      damBox(wide, 1.5, 8, mid, DAM.crest - 0.75, edge - 4);
      damBox(wide, 1.2, 0.36, mid, DAM.crest + 0.6, edge - 0.18);
      dam(faceQuad(x0, x1, DAM.crest - 3.4, DAM.crest - 1.5, 0.2), 0.5);
    }
    // The spillway: crest, chute and toe. Under the bridge the crest is in shade.
    const ogee = (from: number, to: number, steps: number) => Array.from({ length: steps + 1 }, (_, i): [number, number] => { const d = lerp(from, to, i / steps); return [-91 + d, DAM.sill - OGEE.k * d * d]; });
    const meet = DAM.sill - OGEE.k * OGEE.reach * OGEE.reach;
    dam(ribbon([[-95.5, DAM.sill], [-91, DAM.sill], ...ogee(0.8, 7, 5)], spillX0, spillX1), 0.42);
    dam(ribbon(ogee(7, OGEE.reach, 7), spillX0, spillX1), 0.9);
    dam(faceQuad(spillX0, spillX1, 5, meet), 0.9);
    const toe: Array<[number, number]> = [[faceZ(5), 5], [-70.9, 3], [-69.9, 1.2], [-68.4, -0.4], [-66.5, -1.6], [-64, -2.6], [-60, -3.6], [-56, -4.6]];
    dam(ribbon(toe, spillX0, spillX1), 0.85);
    // Piers: the noses stand in the sun, the flanks inside the bays do not.
    for (let i = 0; i <= GATES.length; i += 1) {
      const x = GATES[0] - 6 + i * 12 - 1.5;
      dam(slab([[-84, DAM.deck], [-80.5, DAM.deck], [-80.5, 50], [-79.5, 29], [-84, 31]], x, 3));
      dam(slab([[-95.5, DAM.deck - 1.6], [-84, DAM.deck - 1.6], [-84, 31], [-95.5, 42]], x + 0.02, 2.96), 0.5);
    }
    // The bridge over the piers, its parapets, and a hoist house over every gate.
    damBox(spillX1 - spillX0 + 3, 1.6, 15, (spillX0 + spillX1) / 2, DAM.deck - 0.8, -88);
    for (const z of [-80.7, -95.3]) damBox(spillX1 - spillX0 + 3, 1.1, 0.34, (spillX0 + spillX1) / 2, DAM.deck + 0.55, z);
    GATES.forEach((x, i) => {
      damBox(5, 3.4, 5, x, DAM.deck + 1.7, -88, 1);
      damBox(5.7, 0.3, 5.7, x, DAM.deck + 3.55, -88, 1.05);
      damBox(3.6, 1.1, 0.1, x, DAM.deck + 2.1, -85.46, 0.3, GLASS);
      far(sign(`n${i + 1}`, 1.5), stencilPaint, x, DAM.deck - 0.82, -80.48);
      // Behind every gate, the reservoir.
      damBox(9.2, 14, 0.2, x, 51, -93.2, 0.16, [0.4, 0.6, 0.55]);
      // The gate: a curved skin on arms that swing about trunnions in the piers; the middle one is raised.
      const open = i === OPEN_GATE, from = (open ? 100 : 142) * Math.PI / 180, to = (open ? 155 : 197) * Math.PI / 180, pivot: [number, number] = [-82.3, 46.6];
      const arc = Array.from({ length: 9 }, (_, j): [number, number] => { const a = lerp(from, to, j / 8); return [pivot[0] + 9 * Math.cos(a), pivot[1] + 9 * Math.sin(a)]; });
      dam(ribbon(arc, x - 4.5, x + 4.5), open ? 0.6 : 0.44, STEEL_BLUE);
      for (const j of [1, 4, 7]) dam(rod([x - 4.5, arc[j][1], arc[j][0] + 0.25], [x + 4.5, arc[j][1], arc[j][0] + 0.25], 0.22, 4), open ? 0.7 : 0.5, STEEL_BLUE);
      for (const side of [-1, 1]) for (const j of [1, 7]) dam(rod([x + side * 4.2, pivot[1], pivot[0]], [x + side * 4.2, arc[j][1], arc[j][0]], 0.2, 4), open ? 0.7 : 0.5, STEEL_BLUE);
    });
    // Training walls close the spillway at both ends and run on as the sides of the basin.
    const training: Array<[number, number]> = [[faceZ(31) + 0.5, 31], [faceZ(4) + 2.8, 4], [-62, 1.2], [APRON_END, 1.2], [APRON_END, -6], [faceZ(-6) - 1, -6], [faceZ(31) - 3, 31]];
    dam(slab(training, spillX0 - 1.6, 1.6));
    dam(slab(training, spillX1, 1.6));
    // The end sill of the basin, west of the tailrace.
    damBox(CHANNEL.x0 - BASIN.x0, 5.7, 0.8, (CHANNEL.x0 + BASIN.x0) / 2, -1.65, APRON_END - 0.4);

    // The stair tower stands plumb at the toe, so the face leans away from it; bridges tie it to the galleries and the crest.
    const towerZ = (TOWER.z0 + TOWER.z1) / 2, towerDeep = TOWER.z1 - TOWER.z0;
    damBox(5, TOWER.top + 6, towerDeep, TOWER.x, (TOWER.top - 6) / 2, towerZ);
    damBox(6.2, 4.6, towerDeep + 1.2, TOWER.x, TOWER.top + 2.3, towerZ, 1.02);
    damBox(6.8, 0.35, towerDeep + 1.8, TOWER.x, TOWER.top + 4.75, towerZ, 1.06);
    damBox(4.4, 1.5, 0.1, TOWER.x, TOWER.top + 2.6, TOWER.z1 + 0.62, 0.26, GLASS);
    for (let y = 5.5; y < TOWER.top - 3; y += 3.6) damBox(0.9, 1.5, 0.1, TOWER.x, y, TOWER.z1 + 0.03, 0.2, GLASS);
    // Galleries: walkways bracketed off the face, with the shade they throw and the doors they serve.
    for (const y of [20, 36]) {
      for (const [x0, x1] of [[TOWER.x + 2.5, 70], [-66, spillX0 - 1.6]]) {
        const mid = (x0 + x1) / 2, wide = x1 - x0, z = faceZ(y);
        damBox(wide, 0.34, 1.9, mid, y - 0.17, z + 0.9);
        dam(faceQuad(x0, x1, y - 2.5, y - 0.34, 0.04), 0.58);
        for (let x = x0 + 5; x < x1 - 2; x += 13) damBox(1.2, 2.1, 0.1, x, y + 1.05, faceZ(y + 1.05) + 0.03, 0.18, [0.6, 0.6, 0.6]);
        for (const rail of [0.55, 1.1]) far(P(rod([x0, y + rail, z + 1.8], [x1, y + rail, z + 1.8], 0.05, 4), DARK), paint);
        for (let x = x0; x <= x1; x += 2.4) far(P(rod([x, y, z + 1.8], [x, y + 1.1, z + 1.8], 0.045, 4), DARK), paint);
        for (let x = x0 + 1.2; x < x1; x += 4.8) dam(slab([[z, y - 0.34], [z + 1.7, y - 0.34], [z + 0.25, y - 1.6]], x - 0.15, 0.3));
      }
    }
    // Caged ladders between the galleries and up to the crest.
    for (const [x, y0, y1] of [[44, 20, 36], [34, 36, DAM.crest - 1.5]]) {
      for (const dx of [-0.3, 0.3]) far(P(rod([x + dx, y0, faceZ(y0) + 0.3], [x + dx, y1, faceZ(y1) + 0.3], 0.05, 4), DARK), paint);
      for (const dx of [-0.42, 0.42]) far(P(rod([x + dx, y0 + 2.2, faceZ(y0 + 2.2) + 1.05], [x + dx, y1, faceZ(y1) + 1.05], 0.035, 4), DARK), paint, 0, 0, 0, undefined, undefined, { fine: true });
      for (let y = y0 + 0.4; y < y1; y += 0.8) far(P(rod([x - 0.3, y, faceZ(y) + 0.3], [x + 0.3, y, faceZ(y) + 0.3], 0.03, 4), DARK), paint, 0, 0, 0, undefined, undefined, { fine: true });
      for (let y = y0 + 2.2; y < y1; y += 1.6) for (const [ax, az, bx, bz] of [[-0.42, 0.3, -0.42, 1.05], [-0.42, 1.05, 0.42, 1.05], [0.42, 1.05, 0.42, 0.3]]) far(P(rod([x + ax, y, faceZ(y) + az], [x + bx, y, faceZ(y) + bz], 0.03, 4), DARK), paint, 0, 0, 0, undefined, undefined, { fine: true });
    }
    // Penstocks down the face to the powerhouse, in ring girders.
    for (const x of [30, 37]) {
      damBox(4.6, 4.6, 4, x, 41, faceZ(41) + 0.4);
      const run: V3[] = [[x, 41.5, faceZ(41.5) - 0.5], [x, 40, faceZ(40) + 1.5], [x, 37, faceZ(37) + 1.9], [x, 20, faceZ(20) + 1.9], [x, 6, faceZ(6) + 1.9], [x, 3.2, faceZ(3) + 2.5], [x, 1.9, -65.5], [x, 1.9, -60], [x, 1.9, POWER.z0 + 0.5]];
      far(P(pipe(run, 1.25, 14, 56), PIPE), paint);
      for (let y = 8; y < 38; y += 5) far(P(new THREE.TorusGeometry(1.4, 0.11, 6, 18).rotateX(Math.PI / 2 - SLANT), DARK), paint, x, y, faceZ(y) + 1.9);
      for (let y = 10.5; y < 38; y += 10) dam(slab([[faceZ(y), y + 0.9], [faceZ(y) + 1.2, y + 0.5], [faceZ(y) + 1.2, y - 0.6], [faceZ(y - 1.5), y - 1.5]], x - 1.1, 2.2));
    }
    // Lamp posts along the crest road.
    for (let x = -DAM.half + 6; x < DAM.half; x += 14) {
      if (x > spillX0 - 3 && x < spillX1 + 3) continue;
      const z = faceZ(DAM.crest) + 0.3;
      far(P(rod([x, DAM.crest + 1.2, z], [x, DAM.crest + 8, z], 0.1, 6), DARK), paint);
      far(P(rod([x, DAM.crest + 8, z], [x, DAM.crest + 8.3, z - 1.9], 0.07, 6), DARK), paint);
      far(P(box(0.34, 0.14, 0.8), DARK), paint, x, DAM.crest + 8.25, z - 2.1);
    }
    // The gantry crane that lifts the stop logs, parked over the second gate.
    {
      const x = GATES[1], y = DAM.deck;
      for (const dx of [-4, 4]) for (const z of [-82, -94]) far(P(box(0.5, 9, 0.5), YELLOW), paint, x + dx, y + 4.5, z);
      for (const dx of [-4, 4]) far(P(box(0.6, 0.9, 16), YELLOW), paint, x + dx, y + 9.4, -88);
      for (const z of [-82, -94]) far(P(box(8.6, 0.5, 0.4), YELLOW), paint, x, y + 6.2, z);
      far(P(box(3.2, 1.6, 2.6), YELLOW), paint, x, y + 10.6, -89);
      far(P(box(2.2, 2, 2), DARK), paint, x + 4.9, y + 7.4, -84);
      far(P(rod([x, y + 9.8, -86], [x, y + 3.2, -86], 0.05, 4), DARK), paint);
      far(P(box(1.4, 0.5, 0.4), DARK), paint, x, y + 3, -86);
    }
    // Footbridges from the tower to the galleries and the crest: light steel trusses.
    for (const [y, tall] of [[20, 1.2], [36, 1.2], [DAM.crest, 2.2]]) {
      const z0 = TOWER.z0, z1 = faceZ(y) + (y === DAM.crest ? 0.6 : 1.8), bays = Math.max(2, Math.round((z0 - z1) / 2.6));
      far(P(box(1.5, 0.12, z0 - z1), DARK), paint, TOWER.x, y - 0.06, (z0 + z1) / 2);
      for (const dx of [-0.75, 0.75]) {
        far(P(rod([TOWER.x + dx, y, z0], [TOWER.x + dx, y, z1], 0.07, 4), DARK), paint);
        far(P(rod([TOWER.x + dx, y + tall, z0], [TOWER.x + dx, y + tall, z1], 0.07, 4), DARK), paint);
        for (let b = 0; b <= bays; b += 1) {
          const z = lerp(z0, z1, b / bays);
          far(P(rod([TOWER.x + dx, y, z], [TOWER.x + dx, y + tall, z], 0.05, 4), DARK), paint);
          if (b < bays && tall > 2) far(P(rod([TOWER.x + dx, y + (b % 2 ? tall : 0), z], [TOWER.x + dx, y + (b % 2 ? 0 : tall), lerp(z0, z1, (b + 1) / bays)], 0.045, 4), DARK), paint);
        }
      }
    }
  }
  {
    const merged = mergeGeometries(damParts);
    damParts.forEach((part) => part.dispose());
    const mesh = new THREE.Mesh(merged, damConcrete);
    scene.add(mesh);
  }

  // ---- The gorge -------------------------------------------------------------
  const rimAt = (z: number) => 41 + 3.5 * Math.sin(z * 0.07) + 22 * smooth(-40, -74, z) - 5 * smooth(40, 130, z);
  const westWall = gorgeWall([[34, 236], [4, 228], [-22, 204], [-29, 150], [-28.5, 60], [-28.5, 10], [-30, -24], [-43, -50], [-56, -69], [-60, -86], [-62, -118]], 1, 11, 1.1, rimAt);
  const eastWall = gorgeWall([[40, 240], [37, 200], [35, 110], [34.5, 20], [35, -24], [47, -50], [58, -70], [62, -86], [64, -118]], -1, 23, 1, rimAt);
  for (const wall of [westWall, eastWall]) scene.add(new THREE.Mesh(wall.geometry, rock));
  {
    // Fallen blocks along the foot of the west wall, where they are seen across the tailrace.
    const parts: THREE.BufferGeometry[] = [], tone = new THREE.Color();
    for (let i = 0; i < (high ? 46 : 20); i += 1) {
      const size = 0.35 + random() * random() * 1.5, lump = new THREE.IcosahedronGeometry(size, 1), position = lump.attributes.position;
      for (let v = 0; v < position.count; v += 1) {
        const px = position.getX(v), py = position.getY(v), pz = position.getZ(v), push = 0.72 + 0.5 * hash1(Math.round(px * 31) + Math.round(py * 17) * 7 + Math.round(pz * 13) * 13, i);
        position.setXYZ(v, px * push, py * push * 0.7, pz * push);
      }
      lump.computeVertexNormals();
      tone.setHex([0x77746e, 0x68655f, 0x858078, 0x8d877a][i % 4]).multiplyScalar(0.8 + random() * 0.4);
      const data = new Float32Array(position.count * 3);
      for (let v = 0; v < position.count; v += 1) data.set([tone.r, tone.g, tone.b], v * 3);
      lump.setAttribute("color", new THREE.BufferAttribute(data, 3));
      lump.applyMatrix4(mat4(-27.3 - random() * 1.6, size * 0.22, -34 + random() * 62, [random() * 3, random() * 3, 0]));
      parts.push(lump);
    }
    scene.add(new THREE.Mesh(mergeGeometries(parts), rock));
    parts.forEach((part) => part.dispose());
  }
  {
    // Spruce on the benches and along the rim, shrubs between them.
    const spruce: TreeItem[] = [], farSpruce: TreeItem[] = [], shrubs: TreeItem[] = [];
    for (const ledge of [...westWall.ledges, ...eastWall.ledges]) {
      const away = Math.hypot(ledge.x, ledge.z + 10), roll = random();
      if (ledge.z > 150 && roll > 0.4) continue;
      if (ledge.width > 2.6 && roll < 0.62) {
        const item: TreeItem = { at: [ledge.x, ledge.y - 0.25, ledge.z], yaw: random() * TAU, scale: (ledge.width > 8 ? 0.95 : 0.55) + random() * 0.45, variant: Math.floor(random() * 3), tint: new THREE.Color().setHSL(0.3, 0.05, 0.42 + random() * 0.14) };
        (away < 60 ? spruce : farSpruce).push(item);
      } else if (away < 75 && roll < 0.9) shrubs.push({ at: [ledge.x, ledge.y - 0.1, ledge.z], yaw: random() * TAU, scale: 0.9 + random() * 0.9, variant: Math.floor(random() * 3), tint: new THREE.Color().setHSL(0.24, 0.2, 0.34 + random() * 0.12) });
    }
    const thin = high ? 1 : 2;
    trees.place("spruce", spruce.filter((_, i) => i % thin === 0), { detail: "mid", hit: false, shadow: false });
    trees.place("spruce", farSpruce.filter((_, i) => i % thin === 0), { detail: "far", hit: false, shadow: false });
    trees.place("shrub", shrubs.filter((_, i) => i % thin === 0), { detail: "far", hit: false, shadow: false }).forEach((mesh) => kit.mirrorHidden.push(mesh));
  }

  // ---- Water -----------------------------------------------------------------
  const fogUniforms = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
  {
    const river = track(new THREE.ShaderMaterial({ ...RIVER_SHADER, uniforms: { ...fogUniforms(), time: clock, toSun: { value: TO_SUN } }, fog: true }));
    const surface = mergeGeometries([flat(CHANNEL.x0, CHANNEL.x1, APRON_END, 230, WATER_Y), flat(BASIN.x0 - 0.6, BASIN.x1 + 0.6, BASIN.z0, APRON_END, WATER_Y)]);
    scene.add(new THREE.Mesh(surface, river));
    // The sheet on the chute under the raised gate: over the sill, down the parabola, down the face and out into the basin.
    const x = GATES[OPEN_GATE], path: Array<[number, number]> = [[-92.6, DAM.sill + 2.6], [-91, DAM.sill + 2.2]];
    for (let i = 1; i <= 9; i += 1) { const d = OGEE.reach * i / 9; path.push([-91 + d + 0.25, DAM.sill - OGEE.k * d * d + lerp(1.7, 0.5, i / 9)]); }
    for (let y = 20; y >= 6; y -= 2) path.push([faceZ(y) + 0.4, y + 0.15]);
    path.push([-70.6, 3.4], [-69.5, 1.5], [-67.8, -0.1], [-65.6, -1.3], [-63, -1.9]);
    const sheet = ribbon(path, x - 4.4, x + 4.4, 1, 1.1);
    const uv = sheet.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setX(i, i % 2);
    const chute = new THREE.Mesh(sheet, track(new THREE.ShaderMaterial({ ...CHUTE_SHADER, uniforms: { ...fogUniforms(), time: clock }, fog: true, transparent: true, depthWrite: false })));
    chute.renderOrder = 1;
    scene.add(chute);
  }
  // Spray: a standing cloud where the chute meets the basin, a low bank of mist over the jump, and thin
  // veils that the wind lifts off the tailrace and carries over the training wall and across the range.
  life.plume("steam", [[-24, -1, -57], [-20, -1, -56], [-16, -1, -57], [-20, 0, -63], [-22, -1.5, -50], [-17, -1.5, -50]], { rise: 26, size: [6, 21], life: 10, opacity: 0.4, density: 14, lean: 24, color: 0x9aa3a8, cue: null });
  life.plume("steam", [[-27, -1.5, -52], [-13, -1.5, -52], [-20, -1.5, -46]], { rise: 8, size: [8, 16], life: 7, opacity: 0.28, density: 7, lean: 12, color: 0x99a2a7, cue: null });
  life.plume("steam", [[-19, -1.8, -40], [-18, -1.8, -30], [-19, -1.8, -20]], { rise: 9, size: [6, 15], life: 9, opacity: 0.1, density: 5, lean: 30, color: 0x9ea6aa, cue: null });
  life.plume("steam", [[-18, -1.8, -9], [-19, -1.8, 1]], { rise: 7, size: [7, 14], life: 9, opacity: 0.06, density: 3, lean: 22, color: 0x9ea6aa, cue: null });
  // The relief on the last riser of the manifold lets go now and then.
  life.plume("steam", [[9.14, 2.12, 7.2]], { rise: 1.5, size: [0.1, 0.7], opacity: 0.3, color: 0x9aa0a4, burst: { every: 31, length: 1.6 } });
  // Droplets hanging in the sun over the range, a few spruce needles and leaves on the wind.
  kit.motes({ count: high ? 520 : 200, x: 19, y: [0.3, 8], z: [-28, 8], color: 0xffffff, size: 0.03, opacity: 0.22 });
  life.drift("leaves", { volume: { x: [-9, 9], y: [0, 4], z: [-26, 8] }, count: 16, colors: [0x4f5a35, 0x6a5a30, 0x3f4a2c, 0x7a6a3a], scale: 0.8, falling: 0.5 });

  // ---- Animals ----------------------------------------------------------------
  const swifts = life.soaring("swift", { centre: [-8, 0, -30], radius: 24, height: 24, count: 9 });
  if (swifts instanceof THREE.InstancedMesh) {
    // Now and then one of them screams as it comes round: the cry is placed on the bird itself.
    const where = new THREE.Matrix4();
    let screamAt = 11;
    kit.updates.push((now) => {
      const time = now / 1000;
      if (time < screamAt || swifts.count === 0) return;
      screamAt = time + 14 + ((time * 3.7) % 1) * 26;
      swifts.getMatrixAt(Math.floor(((time * 9.1) % 1) * swifts.count), where);
      say("swiftScream", [where.elements[12], where.elements[13], where.elements[14]], 0.75, 0.95 + ((time * 1.3) % 1) * 0.15);
    });
  }
  life.birds("crow", {
    perches: [{ from: [-WALL_X - 0.3, WEST_TOP + 1.15, -26], to: [-WALL_X - 0.3, WEST_TOP + 1.15, -11], thin: true }, { from: [-6, BACK.top + 1.17, BACK.z + 0.12], to: [8, BACK.top + 1.17, BACK.z + 0.12], thin: true }, [PIER.x, PIER.top + 0.17, PIER.z0 + 0.25]],
    count: 5,
    roam: { x: [-14, 10], y: [8, 15], z: [-30, 10] },
  });

  // ---- Stores --------------------------------------------------------------
  props.place("pallet", [{ position: [-8.86, 0, -6.6], rotation: [0, 0.06, 0] }, { position: [8.82, 0, -23.1], rotation: [0, Math.PI / 2 + 0.05, 0] }, { position: [7.1, 0, 9.05], rotation: [0, 0.04, 0] }], { seed: 3 });
  props.place("crateLarge", [{ position: [-8.86, 0.145, -6.6], rotation: [0, 0.1, 0] }, { position: [8.84, 0.145, -23.1], rotation: [0, Math.PI / 2, 0] }], { seed: 4 });
  props.place("crateSmall", [{ position: [-8.8, 0.985, -6.66], rotation: [0, -0.3, 0] }, { position: [8.92, 0, -24.35], rotation: [0, 1.3, 0] }, { position: [8.9, 0, -21.6], rotation: [0, 0.2, 0] }, { position: [7.05, 0.145, 9.08], rotation: [0, 0.1, 0] }, { position: [7.12, 0.585, 9.1], rotation: [0, -0.2, 0] }], { seed: 5 });
  props.place("drum", [{ position: [-9.08, 0, -12.9] }, { position: [-9.06, 0, -12.25], rotation: [0, 1.1, 0] }, { position: [-8.5, 0, -12.6], rotation: [0, 2.2, 0] }, { position: [8.98, 0, -18.7], rotation: [0, 0.6, 0] }, { position: [8.94, 0, -18.02], rotation: [0, 2.9, 0] }, { position: [-8.95, 0, 9.12], rotation: [0, 0.4, 0] }, { position: [-8.28, 0, 9.2], rotation: [0, 1.9, 0] }], { seed: 6, tint: [0x2f5d6b, 0x7a2a22, 0x2f5d6b, 0x6f7273] });
  props.place("drumPlastic", [{ position: [8.9, 0, -15.6] }, { position: [8.92, 0, -16.3], rotation: [0, 1, 0] }, { position: [-9.0, 0, -10.4], rotation: [0, 0.7, 0] }], { seed: 7 });
  cableDrum(8.5, 9.1, 0.6, 0.62, "z");

  // ---- Furnace ---------------------------------------------------------------
  // The flue stands in full sun: a weathered zinc that does not flare like polished duct.
  const flueMetal = standard({ color: 0x8b9294, metalness: 0.55, roughness: 0.66, envMapIntensity: 0.55 });
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: flueMetal }, POWER.top + 1.5 - 3.6);
  {
    // The flue is strapped to the wall on its way up past the parapet and wears a rain cap.
    furnace.group.updateMatrixWorld(true);
    const at = new THREE.Vector3(-1.05, 0, -0.1).applyMatrix4(furnace.group.matrixWorld);
    for (const y of [5.4, 8.0, POWER.top + 0.5]) {
      cast(P(cyl(0.325, 0.07, "y", 20), DARK), paint, at.x, y, at.z);
      for (const side of [-1, 1]) cast(P(box(0.4, 0.06, 0.05), DARK), paint, at.x + 0.3, y, at.z + side * 0.3);
    }
    cast(P(cyl(0.48, 0.2, "y", 20, 0.08), DARK), paint, at.x, POWER.top + 1.86, at.z);
    for (let i = 0; i < 3; i += 1) fine(P(rod([at.x + Math.cos(i * 2.1) * 0.28, POWER.top + 1.5, at.z + Math.sin(i * 2.1) * 0.28], [at.x + Math.cos(i * 2.1) * 0.34, POWER.top + 1.78, at.z + Math.sin(i * 2.1) * 0.34], 0.012), DARK), paint);
  }

  flush();

  // ---- Lamps that turn and flash ------------------------------------------------
  const glows: Glow[] = [];
  {
    // The beacon on the end pier: two reflectors turning inside an amber dome.
    const amber = new THREE.Color(1, 0.55, 0.08);
    const base = new THREE.Mesh(mergeGeometries([plain(P(cyl(0.17, 0.34, "y", 16), DARK), mat4(0, -0.17, 0), true), plain(P(cyl(0.15, 0.03, "y", 16), DARK), mat4(0, 0.315, 0), true)]), paint);
    base.position.set(...BEACON);
    const turning = new THREE.Group();
    turning.position.set(BEACON[0], BEACON[1] + 0.15, BEACON[2]);
    const reflector = new THREE.MeshBasicMaterial({ color: amber.clone().multiplyScalar(7), toneMapped: false });
    for (const side of [-1, 1]) { const mirror = new THREE.Mesh(new THREE.CircleGeometry(0.11, 14), reflector); mirror.position.x = side * 0.03; mirror.rotation.y = side * Math.PI / 2; turning.add(mirror); }
    const dome = new THREE.Mesh(cyl(0.16, 0.3, "y", 16, 0.135), new THREE.MeshStandardMaterial({ color: 0xff9a1c, emissive: 0xff7a10, emissiveIntensity: 0.6, transparent: true, opacity: 0.5, roughness: 0.2, depthWrite: false }));
    dome.position.copy(turning.position);
    scene.add(base, turning, dome);
    kit.mirrorHidden.push(turning, dome);
    const glow: Glow = { position: new THREE.Vector3(BEACON[0], BEACON[1] + 0.15, BEACON[2]), color: new THREE.Color() };
    glows.push(glow);
    // The lamp of the running gate and the tower's obstruction light: points of light with a halo.
    const disc = track(canvasTexture(64, 64, (c) => {
      const gradient = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, "rgba(255,255,255,1)"); gradient.addColorStop(0.25, "rgba(255,255,255,.55)"); gradient.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = gradient; c.fillRect(0, 0, 64, 64);
    }));
    const halo = (at: V3, colour: THREE.Color, size: number) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc, color: colour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      sprite.position.set(...at);
      sprite.scale.setScalar(size);
      scene.add(sprite);
      kit.mirrorHidden.push(sprite);
      kit.probeHidden.push(sprite);
      return sprite;
    };
    const red = new THREE.Color(1, 0.12, 0.05);
    const beaconHalo = halo([BEACON[0], BEACON[1] + 0.15, BEACON[2]], amber.clone(), 1.5);
    const gateLamp = halo(GATE_LAMP, red.clone(), 3.2), towerLamp = halo([TOWER.x, TOWER.top + 5.4, (TOWER.z0 + TOWER.z1) / 2], red.clone(), 2.2);
    let testAt = 38, blips = 0;
    kit.updates.push((now) => {
      const time = now / 1000;
      turning.rotation.y = time * 3.4;
      // Twice a turn a reflector sweeps past: the halo and the glow in the spray swell with it.
      const sweep = Math.pow(Math.abs(Math.sin(time * 3.4)), 6);
      glow.color.copy(amber).multiplyScalar(0.35 + 0.6 * sweep);
      beaconHalo.material.color.copy(amber).multiplyScalar(0.5 + 2.6 * sweep);
      // The gate lamp gives a double flash every second and a half; now and then the gate's alarm is tested.
      const beat = (time % 1.5) / 1.5, flash = Math.max(smooth(0.0, 0.03, beat) * (1 - smooth(0.08, 0.14, beat)), smooth(0.2, 0.23, beat) * (1 - smooth(0.28, 0.34, beat)));
      const testing = time > testAt && time < testAt + 2.4;
      gateLamp.material.color.copy(red).multiplyScalar(0.25 + (testing ? 6 * (Math.sin(time * 12) > 0 ? 1 : 0) : 4.5 * flash));
      if (testing && time > testAt + blips * 0.8) { blips += 1; say("alarmBlip", GATE_LAMP, 0.9, 0.8); }
      if (time > testAt + 3) { testAt = time + 55 + ((time * 7.3) % 1) * 40; blips = 0; }
      towerLamp.material.color.copy(red).multiplyScalar(1.2 + 1.3 * (0.5 + 0.5 * Math.sin(time * 1.6)));
    });
  }
  {
    // A flange on the manifold weeps: a drop grows, falls and is heard.
    const drop = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshStandardMaterial({ color: 0xcfe0e6, roughness: 0.1, metalness: 0, envMapIntensity: 1.5 }));
    drop.userData.walkThrough = true;
    scene.add(drop);
    kit.mirrorHidden.push(drop);
    let born = 2, period = 3.1, landed = false;
    kit.updates.push((now) => {
      const time = now / 1000, age = time - born, swell = period - 0.34;
      if (age < 0) { drop.visible = false; return; }
      drop.visible = true;
      if (age < swell) { drop.position.set(9.14, 0.385, 3.7); drop.scale.setScalar(0.4 + 0.9 * age / swell); }
      else { const fall = age - swell; drop.position.set(9.14, Math.max(0.01, 0.385 - 4.9 * fall * fall), 3.7); drop.scale.set(0.8, 1.5, 0.8); if (!landed && drop.position.y <= 0.011) { landed = true; say("drip", [9.14, 0.02, 3.7], 0.7, 0.9 + ((time * 3.3) % 1) * 0.3); } }
      if (age > period) { born = time + 0.3 + ((time * 5.7) % 1) * 2.5; period = 2.2 + ((time * 1.9) % 1) * 2.6; landed = false; }
    });
    // A contactor in the cabinet pulls in now and then, and its lamp changes.
    const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: 0x3ddc7a, toneMapped: false }));
    pilot.position.set(WALL_X - 0.44, 2.02, -14.38);
    pilot.userData.walkThrough = true;
    scene.add(pilot);
    kit.mirrorHidden.push(pilot);
    const lit = new THREE.Color(0.24, 1.6, 0.6), tripped = new THREE.Color(2.2, 1.1, 0.1);
    let clackAt = 9, until = 0;
    kit.updates.push((now) => {
      const time = now / 1000;
      if (time > clackAt) { clackAt = time + 18 + ((time * 4.1) % 1) * 30; until = time + 0.5; say("relayClack", [WALL_X - 0.3, 1.4, -14.1], 0.8, 0.9 + ((time * 2.7) % 1) * 0.25); }
      (pilot.material as THREE.MeshBasicMaterial).color.copy(time < until ? tripped : lit);
    });
  }

  // ---- Light -----------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xa9c8ea, 0x7d7a70, 1));
  const sun = kit.sunLight({ color: 0xfff2dd, intensity: 8, toSun: TO_SUN, extent: 30, distance: 56, near: 6, far: 110, radius: 2 });

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills: [],
    reflection,
    glows,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 2.2, skyRotation: SKY_TURN, skyClamp: 20,
      background: 0x86a9d6, fog: 0xcfd8df, fogDensity: high ? 0.0046 : 0.006,
      haze: new THREE.Color(0.05, 0.055, 0.06), hazeDensity: 0.0045, hazeCeiling: 16, hazeFade: 6,
      environmentIntensity: 1.1, exposure: 0.8, far: 460,
    },
    sunlitAt: sunlitFromBoxes(TO_SUN, [
      new THREE.Box3(new THREE.Vector3(WALL_X, 0, POWER.z0), new THREE.Vector3(POWER.x1, POWER.top, POWER.z1)),
      new THREE.Box3(new THREE.Vector3(-WALL_X - 0.6, 0, APRON_END), new THREE.Vector3(-WALL_X, WEST_TOP, PIER.z1)),
      new THREE.Box3(new THREE.Vector3(-10.2, 0, BACK.z), new THREE.Vector3(WALL_X, BACK.top, BACK.z + BACK.depth)),
    ]),
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck: life.struck };
}

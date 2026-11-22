import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { brushedMetal, pbrMaterial, steel } from "../pbr";
import { archedWall, canvasTexture, createKit, projectUv, type RangeEnvironment, type RangeOptions } from "../kit";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createTrees } from "../trees";
import { createWind } from "../wind";
import type { Glow } from "../volumetric";

// Vault: a banking hall after the doors have shut.
//
// The hall is seven bays long under a coffered plaster ceiling. Over the range the middle of the
// ceiling is a glass lay light, lit from the roof void: that is the key light, cool and nearly
// straight down, and its glazing bars and the cross beams between its bays print on the marble
// and stand in the dusty air. Everything else is warm and small: opal globes on rods along both
// aisles, green-shaded lamps on the counters and the writing desks, the strongroom burning
// behind its round door. The walls are book-matched marble to a string course, plaster above,
// with a giant order of pilasters wherever the range leaves the wall free.
//
// Light model: one shadow-casting light (the lay light). The lamps are emissive glass, and
// their light is added in the shaders of the surfaces round them (see "Fixture light").

const WALL_X = 9.54;
const BACK_Z = 9.7;
const END_Z = -32.3;
/** The hall is set out on cross lines 5.95 m apart: a pilaster pair and a ceiling beam on each. */
const BAY = 5.95;
const GRID0 = 9.75;
const GRID = Array.from({ length: 8 }, (_, k) => GRID0 - k * BAY);
const BAYS = Array.from({ length: 7 }, (_, k) => GRID0 - (k + 0.5) * BAY);
const CEILING = 11;
const SOFFIT = 10.4;
const CORNICE = 9.4;
const STRING = 4.6;
const DADO = 1.2;
/** The lay light: half its width, and how many bays from the back wall it runs. */
const LAY = { half: 4.5, bays: 6, beam: 0.4 };
/** Direction from the floor up to the lay light's lamps. */
const TO_SUN = new THREE.Vector3(0.05, 1, 0.13).normalize();
/** Opal globes on rods, one a bay along each aisle. */
const PENDANT = { x: 7.1, y: 7.2, failSide: 1, failBay: 4 };
/** The strongroom's round opening in the west wall, and its door swung flat against the wall beside it. */
const VAULT = { z: -1.05, y: 1.75, r: 1.3, doorZ: -4.3, doorR: 1.6, floor: 0.62 };
/** The teller line in the east wall. */
const TELLER = { z0: -9.7, z1: -0.1, top: 3.9, back: 12.9 };

type V3 = [number, number, number];
type Rect = [number, number, number, number];

function rng(seed: number) {
  let state = (seed | 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mat4 = (x = 0, y = 0, z = 0, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale));

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Box whose texture runs at `metres` a tile whatever its size. */
const wbox = (w: number, h: number, d: number, metres = 2.4) => projectUv(new THREE.BoxGeometry(w, h, d), metres);
const rbox = (w: number, h: number, d: number, radius = 0.012, metres = 1.2) => projectUv(new RoundedBoxGeometry(w, h, d, 1, radius), metres);
function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 12, open = false, radiusEnd = radius) {
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, segments, 1, open);
  if (axis === "x") geometry.rotateZ(-Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  return geometry;
}
const lathe = (profile: number[][], segments = 20) => new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);

/** A moulding bent round a round-headed opening: stands on y = 0, centred on x, faces +z. */
function archBand(width: number, spring: number, band: number, depth: number, sill = 0) {
  const half = width / 2, shape = new THREE.Shape();
  shape.moveTo(-half - band, sill); shape.lineTo(-half - band, spring);
  shape.absarc(0, spring, half + band, Math.PI, 0, true);
  shape.lineTo(half + band, sill); shape.lineTo(half, sill); shape.lineTo(half, spring);
  shape.absarc(0, spring, half, 0, Math.PI, false);
  shape.lineTo(-half, sill); shape.closePath();
  return projectUv(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 10 }), 2.4);
}

/** A flat pane filling a round-headed opening, with uv 0..1 over its bounding box. */
function archPane(width: number, spring: number, sill = 0) {
  const half = width / 2, shape = new THREE.Shape();
  shape.moveTo(-half, sill); shape.lineTo(half, sill); shape.lineTo(half, spring);
  shape.absarc(0, spring, half, 0, Math.PI, false);
  shape.lineTo(-half, sill); shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape, 10), position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) uv.setXY(i, (position.getX(i) + half) / width, (position.getY(i) - sill) / (spring + half - sill));
  return geometry;
}

// ---- Drawn surfaces -------------------------------------------------------------------------------

/** One wandering vein, drawn again one sheet away on every side when `wrap` is set so the sheet tiles. */
function vein(c: CanvasRenderingContext2D, next: () => number, size: number, colour: string, width: number, length: number, wrap: boolean) {
  const points: Array<[number, number]> = [];
  let x = next() * size, y = next() * size, angle = next() * Math.PI * 2;
  const step = size / 60;
  for (let travelled = 0; travelled < length; travelled += step) {
    points.push([x, y]);
    angle += (next() - 0.5) * 0.95;
    x += Math.cos(angle) * step; y += Math.sin(angle) * step;
  }
  c.strokeStyle = colour; c.lineWidth = width; c.lineJoin = "round"; c.lineCap = "round";
  for (const dx of wrap ? [-size, 0, size] : [0]) for (const dy of wrap ? [-size, 0, size] : [0]) {
    c.beginPath();
    points.forEach(([px, py], i) => (i ? c.lineTo(px + dx, py + dy) : c.moveTo(px + dx, py + dy)));
    c.stroke();
  }
}

/** Clouded, veined stone over whatever clip is set. */
function stone(c: CanvasRenderingContext2D, next: () => number, size: number, base: string, clouds: string[], veins: string[], amount: number, wrap: boolean) {
  c.fillStyle = base; c.fillRect(0, 0, size, size);
  for (let i = 0; i < 16 * amount; i += 1) {
    const x = next() * size, y = next() * size, r = size * (0.18 + next() * 0.3), colour = clouds[Math.floor(next() * clouds.length)];
    for (const dx of wrap ? [-size, 0, size] : [0]) for (const dy of wrap ? [-size, 0, size] : [0]) {
      const cloud = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      cloud.addColorStop(0, colour); cloud.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = cloud; c.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 34 * amount; i += 1) vein(c, next, size, veins[Math.floor(next() * veins.length)], size / 1024 * (0.6 + next() * next() * 5), size * (0.2 + next() * 0.9), wrap);
}

/** The floor: cream and green-black marble laid as a diagonal chequer of 0.85 m tiles; one sheet is 4.8 m. */
function floorTextures() {
  const cells = 4;
  const colour = canvasTexture(2048, 2048, (c) => {
    const size = 2048, unit = size / cells, next = rng(4107);
    stone(c, next, size, "#15231d", ["rgba(40,70,56,.5)", "rgba(8,14,12,.6)", "rgba(58,84,66,.35)"], ["rgba(150,186,160,.5)", "rgba(210,226,208,.42)", "rgba(96,140,112,.5)", "rgba(6,10,9,.6)"], 2.4, true);
    for (let i = 0; i < cells; i += 1) for (let j = 0; j < cells; j += 1) {
      const cx = (i + 0.5) * unit, cy = (j + 0.5) * unit, h = unit / 2 - 1.5;
      c.save();
      c.beginPath(); c.moveTo(cx - h, cy); c.lineTo(cx, cy - h); c.lineTo(cx + h, cy); c.lineTo(cx, cy + h); c.closePath(); c.clip();
      c.translate(cx - unit / 2, cy - unit / 2);
      const warm = 172 + Math.floor(next() * 22);
      stone(c, next, unit, `rgb(${warm + 16},${warm + 2},${warm - 30})`, ["rgba(226,214,186,.4)", "rgba(168,150,118,.25)", "rgba(150,140,124,.2)"], ["rgba(120,104,84,.4)", "rgba(96,88,80,.3)", "rgba(255,250,236,.45)", "rgba(150,118,74,.3)"], 0.5, false);
      c.restore();
    }
  }, true);
  const rough = canvasTexture(1024, 1024, (c) => {
    const size = 1024, unit = size / cells, next = rng(4211);
    c.fillStyle = "rgb(30,30,30)"; c.fillRect(0, 0, size, size);
    for (let i = 0; i < cells; i += 1) for (let j = 0; j < cells; j += 1) {
      const cx = (i + 0.5) * unit, cy = (j + 0.5) * unit, h = unit / 2 - 1;
      const value = 40 + Math.floor(next() * 16);
      c.fillStyle = `rgb(${value},${value},${value})`;
      c.beginPath(); c.moveTo(cx - h, cy); c.lineTo(cx, cy - h); c.lineTo(cx + h, cy); c.lineTo(cx, cy + h); c.closePath(); c.fill();
      c.strokeStyle = "rgb(120,120,120)"; c.lineWidth = 1.2; c.stroke();
    }
    // Traffic: dull scuffs where feet have taken the polish off.
    for (let i = 0; i < 90; i += 1) {
      const x = next() * size, y = next() * size, r = 30 + next() * 120;
      for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
        const scuff = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        scuff.addColorStop(0, `rgba(110,110,110,${0.06 + next() * 0.12})`); scuff.addColorStop(1, "rgba(110,110,110,0)");
        c.fillStyle = scuff; c.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
  }, true);
  rough.colorSpace = THREE.NoColorSpace;
  return { colour, rough };
}

/** Wall marble: two slabs 1.2 m wide and 2.4 m tall, cut from one block and opened like a book. */
function slabTexture(seed: number, base: string, clouds: string[], veins: string[], joint: string) {
  return canvasTexture(1024, 1024, (c) => {
    const next = rng(seed), half = document.createElement("canvas");
    half.width = 512; half.height = 1024;
    const h = half.getContext("2d")!;
    h.save(); h.scale(0.5, 1);
    stone(h, next, 1024, base, clouds, veins, 1, false);
    h.restore();
    c.drawImage(half, 0, 0);
    c.save(); c.translate(1024, 0); c.scale(-1, 1); c.drawImage(half, 0, 0); c.restore();
    c.fillStyle = joint;
    c.fillRect(0, 0, 2, 1024); c.fillRect(511, 0, 2, 1024); c.fillRect(1022, 0, 2, 1024); c.fillRect(0, 0, 1024, 2); c.fillRect(0, 1022, 1024, 2);
  }, true);
}

/** One bay of the lay light: six panes by four of obscured glass, lit from the roof void. */
function layGlassTexture() {
  return canvasTexture(768, 512, (c) => {
    const next = rng(881);
    for (let i = 0; i < 6; i += 1) for (let j = 0; j < 4; j += 1) {
      const x = i * 128, y = j * 128, tone = 205 + Math.floor(next() * 40), tired = next() < 0.12 ? 0.72 : 1;
      const pane = c.createRadialGradient(x + 64, y + 64, 8, x + 64, y + 64, 96);
      pane.addColorStop(0, `rgb(${Math.round(tone * tired)},${Math.round((tone + 6) * tired)},${Math.round((tone + 12) * tired)})`);
      pane.addColorStop(1, `rgb(${Math.round(tone * tired * 0.74)},${Math.round(tone * tired * 0.79)},${Math.round(tone * tired * 0.86)})`);
      c.fillStyle = pane; c.fillRect(x, y, 128, 128);
      // Dust lying in the corners of each pane, and the odd dead leaf on the glass.
      for (let k = 0; k < 14; k += 1) { c.fillStyle = `rgba(70,66,52,${0.03 + next() * 0.05})`; c.fillRect(x + next() * 128, y + next() * 128, 6 + next() * 30, 2 + next() * 6); }
      if (next() < 0.2) { c.fillStyle = "rgba(60,48,30,.5)"; c.beginPath(); c.ellipse(x + 20 + next() * 88, y + 20 + next() * 88, 5, 2.4, next() * 3, 0, Math.PI * 2); c.fill(); }
    }
  });
}

type Atlas = { texture: THREE.CanvasTexture; rects: Record<string, Rect>; aspect: Record<string, number> };
type Pen = {
  c: CanvasRenderingContext2D;
  next: () => number;
  cell: (key: string, w: number, h: number, draw: (w: number, h: number) => void) => void;
  text: (value: string, x: number, y: number, px: number, colour: string, align?: CanvasTextAlign, fit?: number, face?: string) => void;
};

/** A sheet of drawn panels packed in rows; `rects` gives each one's uv box. */
function atlas(width: number, height: number, seed: number, draw: (pen: Pen) => void): Atlas {
  const rects: Record<string, Rect> = {}, aspect: Record<string, number> = {};
  const texture = canvasTexture(width, height, (c) => {
    c.clearRect(0, 0, width, height);
    let x = 0, y = 0, rowH = 0;
    const next = rng(seed);
    const cell: Pen["cell"] = (key, w, h, paint) => {
      if (x + w > width) { x = 0; y += rowH; rowH = 0; }
      c.save(); c.translate(x, y); c.beginPath(); c.rect(0, 0, w, h); c.clip(); paint(w, h); c.restore();
      const g = 1.5;
      rects[key] = [(x + g) / width, 1 - (y + h - g) / height, (x + w - g) / width, 1 - (y + g) / height];
      aspect[key] = w / h;
      x += w; rowH = Math.max(rowH, h);
    };
    const text: Pen["text"] = (value, tx, ty, px, colour, align = "center", fit = 0, face = "Georgia, 'Times New Roman', serif") => {
      let size = px;
      c.font = `700 ${size}px ${face}`;
      while (fit > 0 && size > 8 && c.measureText(value).width > fit) { size -= 1; c.font = `700 ${size}px ${face}`; }
      c.fillStyle = colour; c.textAlign = align; c.textBaseline = "middle"; c.fillText(value, tx, ty);
    };
    draw({ c, next, cell, text });
  });
  return { texture, rects, aspect };
}

/** What shows through the glass: the night over the roofs, and the street behind the hall. */
function nightAtlas() {
  return atlas(1024, 1024, 733, ({ c, next, cell }) => {
    // A clerestory window, twice: a deep blue sky going a little green over the roofs, bronze bars across it.
    const roofs: Array<Array<[number, number]>> = [
      [[0, 40], [60, 40], [60, 86], [130, 86], [130, 30], [200, 30], [200, 64], [256, 64]],
      [[0, 58], [44, 58], [44, 34], [96, 34], [96, 46], [150, 46], [150, 98], [176, 98], [176, 52], [256, 52]],
    ];
    roofs.forEach((roof, variant) => cell(variant ? "clerestoryB" : "clerestoryA", 256, 384, (w, h) => {
      const sky = c.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#07102a"); sky.addColorStop(0.6, "#12305c"); sky.addColorStop(1, "#2a5a78");
      c.fillStyle = sky; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 26; i += 1) { c.fillStyle = `rgba(220,230,255,${0.2 + next() * 0.5})`; c.fillRect(next() * w, next() * h * 0.6, 1.4, 1.4); }
      c.fillStyle = "#070a0e";
      c.beginPath(); c.moveTo(0, h);
      for (const [x, up] of roof) c.lineTo(x, h - up);
      c.lineTo(w, h); c.fill();
      c.fillStyle = "rgba(255,196,110,.8)";
      for (let i = 0; i < 2 + variant; i += 1) c.fillRect(20 + next() * 210, h - 12 - next() * 16, 6, 9);
      c.fillStyle = "#0b0907";
      for (const x of [w / 3, (2 * w) / 3]) c.fillRect(x - 4, 0, 8, h);
      for (let y = h; y > 0; y -= 64) c.fillRect(0, y - 4, w, 8);
      c.fillRect(0, 0, 7, h); c.fillRect(w - 7, 0, 7, h); c.fillRect(0, h - 8, w, 8);
    }));
    // The street behind the hall: the house opposite, most of it asleep.
    cell("street", 512, 384, (w, h) => {
      const sky = c.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#081230"); sky.addColorStop(1, "#1c3c62");
      c.fillStyle = sky; c.fillRect(0, 0, w, h);
      c.fillStyle = "#0a1220"; c.fillRect(0, 70, w, h - 70);
      c.fillStyle = "#070c16"; c.fillRect(0, 62, w, 10);
      for (let row = 0; row < 4; row += 1) for (let col = 0; col < 8; col += 1) {
        const x = 22 + col * 62, y = 92 + row * 70, lit = next() < 0.16;
        c.fillStyle = lit ? `rgba(255,${180 + Math.floor(next() * 40)},110,.9)` : "#101c30"; c.fillRect(x, y, 30, 46);
        c.fillStyle = "#070c16"; c.fillRect(x + 14, y, 2, 46); c.fillRect(x, y + 20, 30, 2);
      }
      const wet = c.createLinearGradient(0, h - 26, 0, h);
      wet.addColorStop(0, "#0c1626"); wet.addColorStop(1, "#1a2c44");
      c.fillStyle = wet; c.fillRect(0, h - 26, w, 26);
    });
    // The founder's picture: the first case the bank ever held, and its key, in oils.
    cell("painting", 512, 384, (w, h) => {
      const ground = c.createRadialGradient(w * 0.42, h * 0.4, 20, w / 2, h / 2, w * 0.7);
      ground.addColorStop(0, "#7a5c34"); ground.addColorStop(1, "#22180e");
      c.fillStyle = ground; c.fillRect(0, 0, w, h);
      c.fillStyle = "#2a1a0e"; c.fillRect(0, h * 0.7, w, h * 0.3);
      c.fillStyle = "#4a3016"; c.fillRect(0, h * 0.7, w, 6);
      // The case: an iron-bound chest, lid a hand open, light spilling from it.
      c.fillStyle = "#4e6450"; c.fillRect(150, 150, 220, 130);
      c.fillStyle = "#3a4e3e"; c.beginPath(); c.moveTo(150, 150); c.lineTo(370, 150); c.lineTo(384, 112); c.lineTo(164, 112); c.closePath(); c.fill();
      c.fillStyle = "rgba(255,206,110,.9)"; c.fillRect(152, 144, 216, 8);
      const spill = c.createRadialGradient(260, 146, 4, 260, 146, 150);
      spill.addColorStop(0, "rgba(255,206,110,.5)"); spill.addColorStop(1, "rgba(255,206,110,0)");
      c.fillStyle = spill; c.fillRect(100, 0, 320, 300);
      c.fillStyle = "#1a2018";
      for (const x of [176, 256, 336]) c.fillRect(x, 150, 10, 130);
      c.fillStyle = "#c9a14a"; c.fillRect(246, 196, 30, 36); c.fillStyle = "#1a1408"; c.beginPath(); c.arc(261, 210, 5, 0, Math.PI * 2); c.fill(); c.fillRect(259, 210, 4, 14);
      // The key, lying in front.
      c.strokeStyle = "#d8b25c"; c.lineWidth = 6; c.beginPath(); c.arc(98, 318, 14, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(112, 318); c.lineTo(176, 318); c.moveTo(160, 318); c.lineTo(160, 332); c.moveTo(172, 318); c.lineTo(172, 330); c.stroke();
      for (let i = 0; i < 500; i += 1) { c.fillStyle = `rgba(${next() < 0.5 ? "255,230,170" : "10,6,2"},${0.03 + next() * 0.05})`; c.fillRect(next() * w, next() * h, 2 + next() * 10, 1.5); }
    });
    // Rules of the strongroom, framed by its door.
    cell("rules", 256, 384, (w, h) => {
      c.fillStyle = "#e4dcc4"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#22201a"; c.lineWidth = 3; c.strokeRect(10, 10, w - 20, h - 20);
      const line = (words: string, y: number, px: number, colour = "#22201a") => { c.font = `700 ${px}px Georgia, 'Times New Roman', serif`; c.fillStyle = colour; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(words, w / 2, y, w - 34); };
      line("STRONGROOM", 44, 30); line("RULES", 78, 30);
      c.fillStyle = "#22201a"; c.fillRect(40, 100, w - 80, 2);
      ["1. NO RUSHING.", "2. ONE KEY, ONE CASE.", "3. THE CUSTODIAN HOLDS", "THE SECOND KEY.", "4. DEFUSE BEFORE LEAVING.", "5. FLOATS ARE FINAL."].forEach((words, i) => line(words, 132 + i * 34, 17));
      line("BY ORDER OF THE BOARD", 352, 13, "#7a1f18");
    });
    // A savings poster.
    cell("poster", 256, 384, (w, h) => {
      c.fillStyle = "#1d3a2c"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#d8b25c"; c.lineWidth = 5; c.strokeRect(10, 10, w - 20, h - 20);
      const line = (words: string, y: number, px: number, colour = "#e9dfc0") => { c.font = `700 ${px}px Georgia, 'Times New Roman', serif`; c.fillStyle = colour; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(words, w / 2, y, w - 36); };
      line("SAVE ROUND", 56, 34, "#d8b25c"); line("CERTIFICATES", 92, 28, "#d8b25c");
      // A stack of coins growing round by round.
      for (let stack = 0; stack < 4; stack += 1) for (let coin = 0; coin < 2 + stack * 2; coin += 1) {
        c.fillStyle = "#d8b25c"; c.beginPath(); c.ellipse(52 + stack * 50, 260 - coin * 11, 20, 7, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = "#5a4218"; c.lineWidth = 1.5; c.stroke();
      }
      line("BUY NOTHING NOW", 304, 22); line("WIN THE NEXT ONE", 332, 22);
      line("ASK AT WINDOW B", 362, 14, "#d8b25c");
    });
  });
}

/** Every plate, plaque, dial and notice in the hall, on one sheet. Clear ground is cut away by the sign material. */
function signAtlas() {
  return atlas(2048, 2048, 9127, ({ c, next, cell, text }) => {
    const brassGround = (w: number, h: number, dark = false) => {
      const ground = c.createLinearGradient(0, 0, 0, h);
      ground.addColorStop(0, dark ? "#5a4a2c" : "#c9a45a"); ground.addColorStop(0.5, dark ? "#4a3b22" : "#b08a42"); ground.addColorStop(1, dark ? "#3a2e1a" : "#8f6e33");
      c.fillStyle = ground; c.fillRect(0, 0, w, h);
      for (let i = 0; i < w * h * 0.0016; i += 1) { c.fillStyle = `rgba(${next() < 0.5 ? "255,236,190" : "40,28,10"},${0.04 + next() * 0.08})`; c.fillRect(next() * w, next() * h, 8 + next() * 60, 1); }
    };
    const screws = (w: number, h: number, inset = 14) => {
      for (const sx of [inset, w - inset]) for (const sy of [inset, h - inset]) {
        c.fillStyle = "#6e5626"; c.beginPath(); c.arc(sx, sy, 5, 0, Math.PI * 2); c.fill();
        c.strokeStyle = "#2c2008"; c.lineWidth = 1.6; c.beginPath(); c.moveTo(sx - 3.4, sy - 1.6); c.lineTo(sx + 3.4, sy + 1.6); c.stroke();
      }
    };
    /** Engraved brass plate over a wicket. */
    const plate = (key: string, words: string) => cell(key, 640, 128, (w, h) => {
      brassGround(w, h);
      c.strokeStyle = "#3a2a0c"; c.lineWidth = 3; c.strokeRect(9, 9, w - 18, h - 18);
      text(words, w / 2, h / 2 + 3, 62, "#1c1408", "center", w - 90);
      screws(w, h, 22);
    });
    plate("deposits", "DEPOSITS"); plate("withdrawals", "WITHDRAWALS"); plate("eco", "ECO ROUND SAVINGS");
    plate("loans", "FORCE BUY LOANS"); plate("bonus", "LOSS BONUS PAID HERE"); plate("enquiries", "TRADE-UPS · ENQUIRIES");
    /** Gilt letters cut into the stone: only the letters are kept. */
    const letters = (key: string, w: number, words: string, px = 84) => cell(key, w, 128, (cw, h) => {
      c.shadowColor = "rgba(30,20,4,.9)"; c.shadowOffsetY = 3; c.shadowBlur = 0;
      text(words, cw / 2, h / 2, px, "#d8b25c", "center", cw - 30);
      c.shadowColor = "transparent"; c.shadowOffsetY = 0;
    });
    letters("bank", 2048, "CACHE  &  CARRY  SAVINGS  BANK", 100);
    letters("vault", 1024, "SAFE  DEPOSIT  VAULT"); letters("gallery", 1024, "TRUSTS · SAFE DEPOSIT · TRADE-UPS", 70);
    /** Cast bronze tablet with raised letters. */
    const tablet = (key: string, lines: string[], small: string) => cell(key, 512, 256, (w, h) => {
      brassGround(w, h, true);
      c.strokeStyle = "#b99a56"; c.lineWidth = 4; c.strokeRect(12, 12, w - 24, h - 24);
      c.strokeStyle = "rgba(20,14,4,.7)"; c.lineWidth = 2; c.strokeRect(18, 18, w - 36, h - 36);
      const top = lines.length > 2 ? 62 : 78, pitch = lines.length > 2 ? 50 : 58;
      lines.forEach((line, i) => text(line, w / 2, top + i * pitch, lines.length > 2 ? 40 : 46, "#d9bc74", "center", w - 70));
      text(small, w / 2, h - 40, 20, "#b99a56", "center", w - 80);
      screws(w, h, 26);
    });
    tablet("cases", ["10 000 CASES", "HELD IN TRUST"], "KEYS SOLD SEPARATELY");
    tablet("save", ["THIS BANK OBSERVES", "THE SAVE ROUND"], "NO BUYING AFTER CLOSING");
    tablet("porter", ["RUSH B BRANCH", "DOOR STUCK?"], "RING FOR THE PORTER");
    tablet("maker", ["BOLTWORTH", "SAFE & LOCK Co."], "PATTERN No. 661 · TIME LOCK 72 HR");
    // The rate board: white letters pressed into black felt behind glass.
    cell("rates", 768, 384, (w, h) => {
      c.fillStyle = "#5a3d22"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#b08a42"; c.fillRect(10, 10, w - 20, h - 20);
      c.fillStyle = "#0d0d0c"; c.fillRect(20, 20, w - 40, h - 40);
      for (let y = 28; y < h - 24; y += 6) { c.fillStyle = "rgba(255,255,255,.035)"; c.fillRect(22, y, w - 44, 1); }
      text("TODAY'S RATES", w / 2, 56, 40, "#e9e4d4", "center", w - 80, "Arial, Helvetica, sans-serif");
      const rows: Array<[string, string]> = [["ECO ROUND SAVINGS", "1.4 %"], ["FORCE BUY LOANS", "16 000 MAX"], ["LOSS BONUS", "+500 A ROUND"], ["TRADE UP", "10 FOR 1"], ["FLOAT ASSAYED", "0.0001 – 0.9999"], ["KEYS", "SOLD SEPARATELY"]];
      rows.forEach(([name, rate], i) => {
        const y = 112 + i * 44;
        text(name, 48, y, 28, "#e9e4d4", "left", 360, "Arial, Helvetica, sans-serif");
        text(rate, w - 48, y, 28, i === 2 ? "#e9b24a" : "#e9e4d4", "right", 280, "Arial, Helvetica, sans-serif");
        c.fillStyle = "rgba(233,228,212,.35)";
        for (let x = 420; x < w - 330; x += 14) c.fillRect(x, y + 8, 3, 3);
      });
    });
    // The card hung on the rope after closing.
    cell("closed", 384, 384, (w, h) => {
      c.fillStyle = "#e9e2cc"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#7a1f18"; c.lineWidth = 10; c.strokeRect(14, 14, w - 28, h - 28);
      text("CLOSED", w / 2, 104, 84, "#7a1f18", "center", w - 60);
      text("THIS BANK OPENS AT 09:00", w / 2, 190, 26, "#22201a", "center", w - 60);
      text("NO OVERTIME", w / 2, 236, 40, "#22201a", "center", w - 60);
      text("PLEASE HAVE YOUR KEYS READY", w / 2, 300, 20, "#22201a", "center", w - 60);
      text("ECO ROUNDS BANKED AT WINDOW B", w / 2, 334, 18, "#55504a", "center", w - 60);
    });
    /** A clock dial: Roman hours on opal or enamel. */
    const dial = (key: string, size: number, ground: string, ink: string, roman: boolean, legend: string) => cell(key, size, size, (w) => {
      const r = w / 2;
      c.clearRect(0, 0, w, w);
      c.fillStyle = ground; c.beginPath(); c.arc(r, r, r - 2, 0, Math.PI * 2); c.fill();
      const shade = c.createRadialGradient(r, r, r * 0.3, r, r, r);
      shade.addColorStop(0, "rgba(255,255,255,0)"); shade.addColorStop(1, "rgba(120,90,40,.3)");
      c.fillStyle = shade; c.beginPath(); c.arc(r, r, r - 2, 0, Math.PI * 2); c.fill();
      c.strokeStyle = ink; c.lineWidth = w * 0.012; c.beginPath(); c.arc(r, r, r * 0.9, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.arc(r, r, r * 0.6, 0, Math.PI * 2); c.stroke();
      const numerals = roman ? ["XII", "I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI"] : ["72", "6", "12", "18", "24", "30", "36", "42", "48", "54", "60", "66"];
      for (let i = 0; i < 60; i += 1) {
        const a = (i / 60) * Math.PI * 2, long = i % 5 === 0;
        c.save(); c.translate(r, r); c.rotate(a); c.fillStyle = ink; c.fillRect(-w * (long ? 0.008 : 0.003), -r * 0.9, w * (long ? 0.016 : 0.006), r * (long ? 0.1 : 0.05)); c.restore();
      }
      numerals.forEach((numeral, i) => {
        const a = (i / 12) * Math.PI * 2;
        c.save(); c.translate(r + Math.sin(a) * r * 0.74, r - Math.cos(a) * r * 0.74); c.rotate(a);
        text(numeral, 0, 0, w * (roman ? 0.12 : 0.085), ink, "center");
        c.restore();
      });
      text(legend, r, r + r * 0.3, w * 0.045, ink, "center", r * 0.9);
    });
    dial("greatDial", 512, "#f3e6c4", "#1a1408", true, "CACHE & CARRY");
    dial("wallDial", 256, "#ece4d0", "#16120a", true, "");
    dial("timeDial", 256, "#e9e6dc", "#121210", false, "HOURS");
    // Bronze lattice of a radiator case, and the bars of the ventilation grille.
    cell("radiator", 256, 256, (w, h) => {
      c.fillStyle = "#070605"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#6a4c26"; c.lineWidth = 7;
      for (let i = -8; i < 16; i += 1) { c.beginPath(); c.moveTo(i * 32, 0); c.lineTo(i * 32 + h, h); c.stroke(); c.beginPath(); c.moveTo(i * 32, h); c.lineTo(i * 32 + h, 0); c.stroke(); }
      c.strokeStyle = "#8a6a3a"; c.lineWidth = 12; c.strokeRect(6, 6, w - 12, h - 12);
    });
    cell("vent", 256, 256, (w, h) => {
      c.clearRect(0, 0, w, h);
      c.fillStyle = "#a8854a";
      for (let y = 0; y < h; y += 20) c.fillRect(0, y, w, 9);
      for (const x of [0, w / 2 - 5, w - 10]) c.fillRect(x, 0, 10, h);
    });
    // A deposit slip, a ledger page, the evening paper and the calendar.
    cell("slip", 256, 128, (w, h) => {
      c.fillStyle = "#e6dfc6"; c.fillRect(0, 0, w, h);
      text("DEPOSIT SLIP", w / 2, 20, 18, "#27324a", "center", w - 20, "Arial, Helvetica, sans-serif");
      c.strokeStyle = "#5a6a8a"; c.lineWidth = 1;
      for (let y = 44; y < h - 8; y += 18) { c.beginPath(); c.moveTo(12, y); c.lineTo(w - 12, y); c.stroke(); }
      text("CASES", 16, 54, 11, "#27324a", "left", 0, "Arial, Helvetica, sans-serif"); text("KEYS", 16, 72, 11, "#27324a", "left", 0, "Arial, Helvetica, sans-serif"); text("FLOAT", 16, 90, 11, "#27324a", "left", 0, "Arial, Helvetica, sans-serif");
      c.beginPath(); c.moveTo(w - 80, 36); c.lineTo(w - 80, h - 10); c.stroke();
    });
    cell("ledger", 256, 128, (w, h) => {
      c.fillStyle = "#ddd5ba"; c.fillRect(0, 0, w, h);
      c.fillStyle = "rgba(0,0,0,.12)"; c.fillRect(w / 2 - 3, 0, 6, h);
      c.strokeStyle = "rgba(60,80,130,.5)"; c.lineWidth = 1;
      for (let y = 14; y < h - 6; y += 9) { c.beginPath(); c.moveTo(8, y); c.lineTo(w - 8, y); c.stroke(); }
      c.strokeStyle = "rgba(150,40,30,.6)";
      for (const x of [40, 96, 168, 224]) { c.beginPath(); c.moveTo(x, 6); c.lineTo(x, h - 6); c.stroke(); }
      for (let i = 0; i < 46; i += 1) { c.fillStyle = "rgba(26,30,60,.7)"; c.fillRect(12 + next() * 220, 10 + Math.floor(next() * 12) * 9, 8 + next() * 22, 2); }
    });
    cell("paper", 256, 256, (w, h) => {
      c.fillStyle = "#d8d2c0"; c.fillRect(0, 0, w, h);
      text("THE EVENING ECO", w / 2, 26, 24, "#14130f", "center", w - 20);
      c.fillStyle = "#14130f"; c.fillRect(10, 44, w - 20, 2);
      text("FORCE BUY FAILS AGAIN", w / 2, 66, 20, "#14130f", "center", w - 20);
      text("Loss bonus at record high", w / 2, 90, 13, "#33302a", "center", w - 20);
      c.fillStyle = "#8f8a7c"; c.fillRect(14, 104, 100, 70);
      for (let col = 0; col < 2; col += 1) for (let y = 104 + (col ? 0 : 78); y < h - 10; y += 6) { c.fillStyle = "rgba(30,28,24,.55)"; c.fillRect(col ? 126 : 14, y, 90 + next() * 26, 2); }
    });
    cell("calendar", 256, 256, (w, h) => {
      c.fillStyle = "#e7e0cb"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#7a1f18"; c.fillRect(0, 0, w, 62);
      text("PAYDAY", w / 2, 32, 36, "#f0e8d2", "center", w - 20);
      text("31", w / 2, 150, 128, "#1a1814", "center");
      text("SAVE TODAY · BUY TOMORROW", w / 2, 232, 14, "#3a362e", "center", w - 16);
    });
    // Round brass tickets on the grilles, naming the windows.
    for (const name of ["A", "B", "MID", "LONG"]) cell(`window${name}`, 128, 128, (w) => {
      c.clearRect(0, 0, w, w);
      c.fillStyle = "#b99242"; c.beginPath(); c.arc(w / 2, w / 2, w / 2 - 2, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#3a2a0c"; c.lineWidth = 4; c.beginPath(); c.arc(w / 2, w / 2, w / 2 - 10, 0, Math.PI * 2); c.stroke();
      text(name, w / 2, w / 2 + 3, name.length > 1 ? 40 : 68, "#1c1408", "center", w - 34);
    });
    // The tellers' back wall: ledgers on shelves, pigeonholes, a key board.
    cell("tellerBack", 1024, 384, (w, h) => {
      c.fillStyle = "#3a2416"; c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 128) { c.fillStyle = "#24160c"; c.fillRect(x, 0, 6, h); }
      for (let shelf = 0; shelf < 4; shelf += 1) {
        const y = 30 + shelf * 90;
        c.fillStyle = "#1a100a"; c.fillRect(0, y, w, 78);
        c.fillStyle = "#4a2e1a"; c.fillRect(0, y + 78, w, 10);
        let x = 8;
        while (x < w - 20) {
          if (Math.floor(x / 128) !== Math.floor((x + 26) / 128)) { x = Math.ceil(x / 128) * 128 + 8; continue; }
          if (next() < 0.14) { x += 20 + next() * 30; continue; }
          const bw = 12 + next() * 14, bh = 54 + next() * 20, hue = next();
          c.fillStyle = hue < 0.4 ? "#5a1f1a" : hue < 0.7 ? "#1f3a2a" : hue < 0.9 ? "#2a2a3a" : "#7a6a4a";
          c.fillRect(x, y + 78 - bh, bw, bh);
          c.fillStyle = "rgba(216,178,92,.75)"; c.fillRect(x + 2, y + 78 - bh + 8, bw - 4, 3); c.fillRect(x + 2, y + 78 - bh + 16, bw - 4, 2);
          x += bw + 1;
        }
      }
      // Key board.
      c.fillStyle = "#1c2a22"; c.fillRect(420, 24, 190, 150);
      c.strokeStyle = "#b08a42"; c.lineWidth = 4; c.strokeRect(420, 24, 190, 150);
      for (let row = 0; row < 4; row += 1) for (let col = 0; col < 7; col += 1) {
        const kx = 440 + col * 25, ky = 48 + row * 34;
        c.fillStyle = "#b08a42"; c.beginPath(); c.arc(kx, ky, 3, 0, Math.PI * 2); c.fill();
        if (next() < 0.7) { c.fillRect(kx - 1.5, ky, 3, 16); c.beginPath(); c.arc(kx, ky + 19, 5, 0, Math.PI * 2); c.fill(); }
      }
    });
    // The bronze doors under the gallery.
    cell("doors", 512, 384, (w, h) => {
      c.fillStyle = "#2a1c10"; c.fillRect(0, 0, w, h);
      for (const x of [16, w / 2 + 6]) {
        c.fillStyle = "#3a2a18"; c.fillRect(x, 14, w / 2 - 22, h - 14);
        c.strokeStyle = "#6a4c26"; c.lineWidth = 4;
        for (const [py, ph] of [[30, 120], [166, 190]]) c.strokeRect(x + 22, py, w / 2 - 66, ph);
      }
      c.fillStyle = "#b08a42"; c.fillRect(w / 2 - 22, 200, 8, 46); c.fillRect(w / 2 + 14, 200, 8, 46);
    });
  });
}

/** A wall of safe-deposit boxes: brass doors four to the 1.2 m, eight rows high, each with two locks and a number. */
function depositTexture() {
  return canvasTexture(1024, 1024, (c) => {
    const next = rng(6641);
    c.fillStyle = "#2a2212"; c.fillRect(0, 0, 1024, 1024);
    let number = 101;
    for (let row = 0; row < 8; row += 1) for (let col = 0; col < 4; col += 1) {
      const x = col * 256 + 5, y = row * 128 + 5, w = 246, h = 118, tone = 0.86 + next() * 0.24;
      const face = c.createLinearGradient(0, y, 0, y + h);
      face.addColorStop(0, `rgb(${Math.round(206 * tone)},${Math.round(166 * tone)},${Math.round(88 * tone)})`);
      face.addColorStop(1, `rgb(${Math.round(150 * tone)},${Math.round(114 * tone)},${Math.round(54 * tone)})`);
      c.fillStyle = face; c.fillRect(x, y, w, h);
      c.fillStyle = "rgba(255,240,200,.35)"; c.fillRect(x, y, w, 3); c.fillRect(x, y, 3, h);
      c.fillStyle = "rgba(30,20,6,.5)"; c.fillRect(x, y + h - 3, w, 3); c.fillRect(x + w - 3, y, 3, h);
      for (let i = 0; i < 10; i += 1) { c.fillStyle = `rgba(${next() < 0.5 ? "255,240,200" : "50,34,10"},${0.05 + next() * 0.07})`; c.fillRect(x + next() * (w - 60), y + 6 + next() * (h - 12), 20 + next() * 60, 1); }
      // Hinge, number plate, the renter's lock and the custodian's.
      c.fillStyle = "#7a5c2a"; c.fillRect(x + 6, y + 18, 9, 26); c.fillRect(x + 6, y + h - 44, 9, 26);
      c.fillStyle = "#1a140a"; c.fillRect(x + 84, y + 16, 78, 30);
      c.font = "700 24px Arial, Helvetica, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#d8b25c";
      c.fillText(String(number), x + 123, y + 32);
      number += 1 + Math.floor(next() * 3);
      for (const lx of [x + 92, x + 190]) {
        c.fillStyle = "#e0c078"; c.beginPath(); c.arc(lx, y + 82, 15, 0, Math.PI * 2); c.fill();
        c.strokeStyle = "#5a4218"; c.lineWidth = 2; c.stroke();
        c.fillStyle = "#0c0904"; c.beginPath(); c.arc(lx, y + 79, 4, 0, Math.PI * 2); c.fill(); c.fillRect(lx - 1.6, y + 80, 3.2, 10);
      }
    }
  }, true);
}

export function buildVault(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet } = kit;
  const metals = kit.metals();
  const random = rng(1207);

  // Everything static is baked into one mesh per material (and per shadow / hit / fine class), so the
  // detail costs triangles, not draw calls. "fine" parts are skipped on PERFORMANCE and left out of
  // the floor mirror.
  type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean; walk?: boolean };
  type Batch = { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] };
  const batches = new Map<string, Batch>();
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4, opt: Opt = {}) => {
    const fine = opt.fine ?? false;
    if (fine && !high) return;
    const full = { shadow: !fine && (opt.shadow ?? false), hit: !fine && (opt.hit ?? false), fine, walk: opt.walk ?? false };
    const key = `${material.uuid}|${+full.shadow}${+full.hit}${+full.fine}${+full.walk}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { material, opt: full, parts: [] });
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
      if (batch.opt.fine) kit.mirrorHidden.push(mesh);
      if (batch.opt.walk) mesh.userData.walkThrough = true;
    }
    batches.clear();
  };
  /** Frame on a side wall: local x runs along the wall, local z points into the hall. */
  const wallFrame = (side: number, z: number, opt: Opt = {}) => frame(mat4(side * WALL_X, 0, z, [0, -side * Math.PI / 2, 0]), opt);
  const backFrame = (x: number, opt: Opt = {}) => frame(mat4(x, 0, BACK_Z, [0, Math.PI, 0]), opt);
  const endFrame = (x: number, opt: Opt = {}) => frame(mat4(x, 0, END_Z), opt);
  const sides = [-1, 1];
  /** Which way the hall lies from a plane at `z`: +1 toward +z. */
  const hallMidOf = (z: number) => (BACK_Z + END_Z) / 2 - z;

  // ---- Fixture light -----------------------------------------------------------------------------
  // The globes and the shaded lamps are far too many to be light objects. Their light is added in the
  // shaders of the surfaces round them, with distance falloff and facing, at no cost in lights.
  const LAMPS = 14;
  const lampPlace = Array.from({ length: LAMPS }, () => new THREE.Vector4(0, -50, 0, 1));
  const lampColour = Array.from({ length: LAMPS }, () => new THREE.Color(0, 0, 0));
  const lampUniforms = { vaultLampPlace: { value: lampPlace }, vaultLampColour: { value: lampColour }, vaultLive: { value: new THREE.Vector2(1, 1) } };
  let lampCount = 0;
  /** A shaded lamp: light falls from `at` downward and sideways over `reach` metres. Returns its slot. */
  const lamp = (at: V3, colour: THREE.Color, reach: number) => {
    if (lampCount >= LAMPS) return -1;
    lampPlace[lampCount].set(at[0], at[1], at[2], reach);
    lampColour[lampCount].copy(colour);
    return lampCount++;
  };
  const glsl = (value: number) => value.toFixed(3);
  const practicalGlsl = /* glsl */`
    uniform vec4 vaultLampPlace[${LAMPS}];
    uniform vec3 vaultLampColour[${LAMPS}];
    uniform vec2 vaultLive;
    vec3 practicalLight(vec3 p, vec3 n) {
      vec3 sum = vec3(0.0);
      // Opal globes: one a bay down each aisle, the two nearest on this side of the hall.
      float side = p.x < 0.0 ? -1.0 : 1.0;
      float bay = clamp(floor((${glsl(GRID0)} - p.z) / ${glsl(BAY)} - 0.5), 0.0, ${glsl(BAYS.length - 2)});
      for (int i = 0; i < 2; i++) {
        float k = bay + float(i);
        vec3 toGlobe = vec3(side * ${glsl(PENDANT.x)}, ${glsl(PENDANT.y)}, ${glsl(GRID0)} - ${glsl(BAY)} * (k + 0.5)) - p;
        float d2 = dot(toGlobe, toGlobe), d = sqrt(d2);
        float facing = max(dot(n, toGlobe) / d + 0.35, 0.0) / 1.35;
        float level = side * ${glsl(PENDANT.failSide)} > 0.0 && abs(k - ${glsl(PENDANT.failBay)}) < 0.5 ? vaultLive.x : 1.0;
        sum += vec3(1.0, 0.72, 0.4) * (7.5 * level * facing / (d2 + 0.6)) * (1.0 - smoothstep(5.0, 11.5, d));
      }
      // Shaded lamps: nothing above the rim of the shade.
      for (int i = 0; i < ${LAMPS}; i++) {
        vec3 toLamp = vaultLampPlace[i].xyz - p;
        float d2 = dot(toLamp, toLamp), d = sqrt(d2);
        float facing = max(dot(n, toLamp) / d + 0.3, 0.0) / 1.3;
        float under = smoothstep(-0.12, 0.2, toLamp.y / (d + 0.001) + 0.1);
        sum += vaultLampColour[i] * (vaultLive.y * facing * under / (d2 + 0.1)) * (1.0 - smoothstep(vaultLampPlace[i].w * 0.4, vaultLampPlace[i].w, d));
      }
      return sum;
    }`;
  const practical = <T extends THREE.MeshStandardMaterial>(material: T): T => {
    const before = material.onBeforeCompile, key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before.call(material, shader, renderer);
      Object.assign(shader.uniforms, lampUniforms);
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
    material.customProgramCacheKey = () => `${key}|vault-practical`;
    return material;
  };
  (["structural", "darkMetal", "brushed", "machine"] as const).forEach((name) => practical(metals[name]));

  // ---- Materials ---------------------------------------------------------------------------------
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => practical(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.6, ...parameters }));
  const drawn = <T extends THREE.Texture>(texture: T) => { track(texture).anisotropy = anisotropy; return texture; };
  const creamMap = drawn(slabTexture(311, "#ddd2ba", ["rgba(240,232,212,.3)", "rgba(190,172,140,.14)", "rgba(170,160,146,.1)"], ["rgba(124,106,84,.42)", "rgba(98,90,82,.3)", "rgba(255,250,238,.5)", "rgba(160,124,76,.3)"], "rgba(70,60,44,.55)"));
  const greenMap = drawn(slabTexture(457, "#1d3a2c", ["rgba(44,78,60,.5)", "rgba(6,12,10,.6)", "rgba(64,92,72,.3)"], ["rgba(156,192,166,.5)", "rgba(214,228,210,.4)", "rgba(96,140,112,.5)", "rgba(4,8,7,.6)"], "rgba(0,0,0,.7)"));
  const cream = standard({ map: creamMap, roughness: 0.34, envMapIntensity: 0.9 });
  const green = standard({ map: greenMap, roughness: 0.2, envMapIntensity: 1.1 });
  const plasterSet = photoSet("/textures/painted_plaster_wall-2k", 1, 1, false);
  const plaster = standard({ ...plasterSet, color: 0xd6c8a8, envMapIntensity: 0.45 });
  const ceilingPlaster = standard({ ...plasterSet, color: 0xe9e0c8, envMapIntensity: 0.4 });
  const timber = standard({ ...photoSet("/textures/lacquered_cherry_wood-2k", 1, 1, false), color: new THREE.Color(3.2, 2.0, 1.45), roughness: 0.6, envMapIntensity: 0.9 });
  const brass = practical(pbrMaterial(keep(brushedMetal(anisotropy, [0.86, 0.62, 0.26], 71)), { envMapIntensity: 1.5, metalness: 0.9, emissive: 0x2a1a06, emissiveIntensity: 0.5 }));
  const bronze = practical(pbrMaterial(keep(steel(anisotropy, [0.3, 0.2, 0.11], 0.44, 77, 256)), { envMapIntensity: 1.2 }));
  const gilt = standard({ color: 0xc9a14a, roughness: 0.42, metalness: 0.7, envMapIntensity: 1.3, emissive: 0x3a2808, emissiveIntensity: 0.5 });
  const opal = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.8, 0.52).multiplyScalar(2.4), toneMapped: false });
  const opalFailing = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.8, 0.52).multiplyScalar(2.4), toneMapped: false });
  const layGlass = new THREE.MeshBasicMaterial({ map: drawn(layGlassTexture()), color: new THREE.Color(0.86, 0.93, 1).multiplyScalar(1.25), toneMapped: false });
  const night = nightAtlas();
  const nightGlass = new THREE.MeshBasicMaterial({ map: drawn(night.texture), color: new THREE.Color(1, 1, 1).multiplyScalar(0.6), toneMapped: false });
  const remap = <T extends THREE.BufferGeometry>(geometry: T, sheet: Atlas, key: string): T => {
    const [u0, v0, u1, v1] = sheet.rects[key], uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return geometry;
  };
  /** Pictures on the walls share the night sheet but take the room's light. */
  const pictures = standard({ map: night.texture, roughness: 0.6, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const picture = (key: string, width: number) => remap(new THREE.PlaneGeometry(width, width / night.aspect[key]), night, key);
  const tiled = <T extends THREE.BufferGeometry>(geometry: T, u: number, v: number): T => {
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
    return geometry;
  };
  const signs = signAtlas();
  const signMaterial = practical(new THREE.MeshStandardMaterial({ map: drawn(signs.texture), alphaTest: 0.5, emissive: 0xffffff, emissiveMap: signs.texture, emissiveIntensity: 0.05, roughness: 0.5, metalness: 0.15, envMapIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const dialGlow = new THREE.MeshBasicMaterial({ map: signs.texture, alphaTest: 0.5, color: new THREE.Color(1, 0.88, 0.66).multiplyScalar(1.5), toneMapped: false });
  /** Flat plate carrying one entry of the sign sheet, facing +z. */
  const sign = (key: string, width: number) => remap(new THREE.PlaneGeometry(width, width / signs.aspect[key]), signs, key);
  const deposit = standard({ map: drawn(depositTexture()), metalness: 0.7, roughness: 0.42, envMapIntensity: 1.3 });
  const steelSet = keep(brushedMetal(anisotropy, [0.62, 0.64, 0.66], 83));
  const doorSteel = practical(pbrMaterial(steelSet, { envMapIntensity: 1.5 }));
  const tunnelSteel = practical(pbrMaterial(steelSet, { envMapIntensity: 1.2, side: THREE.DoubleSide }));
  const gold = standard({ color: 0xe2b040, metalness: 0.85, roughness: 0.28, envMapIntensity: 1.6, emissive: 0x4a3000, emissiveIntensity: 0.6 });
  const greenGlass = new THREE.MeshStandardMaterial({ color: 0x0f5a36, emissive: 0x1f9c5c, emissiveIntensity: 1.2, roughness: 0.25, metalness: 0, side: THREE.DoubleSide });
  const lampGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.78, 0.45).multiplyScalar(3), toneMapped: false });
  const vaultGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.92, 0.78).multiplyScalar(2.8), toneMapped: false });
  const velvet = standard({ color: 0x6a0f16, roughness: 0.95 });
  const leather = standard({ color: 0x1c3a2a, roughness: 0.55 });
  const paintGreen = standard({ color: 0x16301f, roughness: 0.45, metalness: 0.3, envMapIntensity: 1 });
  const darkGlass = new THREE.MeshStandardMaterial({ color: 0x14160f, roughness: 0.12, metalness: 0, envMapIntensity: 1.4, emissive: 0x2a1c0a, emissiveIntensity: 0.6 });
  const windowGlass = new THREE.MeshStandardMaterial({ color: 0x5a7a9a, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.2, envMapIntensity: 1.5, depthWrite: false });
  const street = standard({ color: 0x0c0f14, roughness: 0.6 });
  const paper = standard({ color: 0xe2dac0, roughness: 0.9 });
  const voidDark = new THREE.MeshBasicMaterial({ color: 0x0b1016 });
  const WARM = new THREE.Color(1, 0.74, 0.42);

  // A banker's lamp: brass foot and stem, a trough of green glass over the bulb. It faces its own +z.
  const shadeGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.32, 12, 1, true, 0, Math.PI).rotateZ(Math.PI / 2);
  const bankerLamp = (x: number, y: number, z: number, yaw: number, reach = 3.2, power = 1) => {
    const matrix = mat4(x, y, z, [0, yaw, 0]), add = frame(matrix);
    add(lathe([[0, 0], [0.085, 0], [0.085, 0.012], [0.05, 0.03], [0.016, 0.045], [0.012, 0.3], [0, 0.3]], 14), brass);
    add(box(0.014, 0.014, 0.1), brass, 0, 0.3, 0.045);
    add(shadeGeometry, greenGlass, 0, 0.3, 0.1);
    add(box(0.3, 0.004, 0.1), lampGlow, 0, 0.3, 0.1);
    const at = new THREE.Vector3(0, 0.27, 0.1).applyMatrix4(matrix);
    return lamp([at.x, at.y, at.z], WARM.clone().multiplyScalar(power), reach);
  };

  // ---- Floor -------------------------------------------------------------------------------------
  const floorMaps = floorTextures();
  drawn(floorMaps.colour).repeat.set(10, 13);
  drawn(floorMaps.rough).repeat.set(10, 13);
  const floorMaterial = new THREE.MeshStandardMaterial({ map: floorMaps.colour, roughnessMap: floorMaps.rough, roughness: 1, metalness: 0, envMapIntensity: 0.7 });
  const reflection = kit.floor(floorMaterial, { width: 48, depth: 62.4, z: -11.5 }, {
    lane: new THREE.Color(0.78, 0.6, 0.3),
    edge: new THREE.Color(0.5, 0.37, 0.17),
    markings: 0.85,
    wet: -1,
  });
  practical(floorMaterial);

  // ---- Shell -------------------------------------------------------------------------------------
  // Each side wall is two slabs, marble below the string course and plaster above it, cut in the plane
  // of the wall: the west one by the strongroom's round opening, the east one by the teller line.
  const sideWall = (side: number, y0: number, y1: number, cut: (shape: THREE.Shape, along: (z: number) => number) => void, material: THREE.Material) => {
    // Shape x runs along the wall so that the slab's outer cap ends up facing the hall.
    const along = (z: number) => -side * z, shape = new THREE.Shape();
    const a = along(side < 0 ? BACK_Z + 0.7 : END_Z - 0.7), b = along(side < 0 ? END_Z - 0.7 : BACK_Z + 0.7);
    shape.moveTo(a, y0);
    cut(shape, along);
    shape.lineTo(b, y0); shape.lineTo(b, y1); shape.lineTo(a, y1); shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.7, bevelEnabled: false, curveSegments: 24 });
    geometry.rotateY(side * Math.PI / 2);
    geometry.translate(side * WALL_X, 0, 0);
    world(projectUv(geometry, 2.4), material, 0, 0, 0, undefined, undefined, { hit: true });
  };
  sideWall(-1, 0, STRING, (shape, along) => {
    const hole = new THREE.Path();
    hole.absarc(along(VAULT.z), VAULT.y, VAULT.r + 0.02, 0, Math.PI * 2, false);
    shape.holes.push(hole);
  }, cream);
  sideWall(1, 0, STRING, (shape, along) => {
    shape.lineTo(along(TELLER.z0), 0); shape.lineTo(along(TELLER.z0), TELLER.top); shape.lineTo(along(TELLER.z1), TELLER.top); shape.lineTo(along(TELLER.z1), 0);
  }, cream);
  for (const side of sides) sideWall(side, STRING, CEILING + 0.5, () => {}, plaster);

  // Back wall: marble to above the chart, with a tall round-headed window either side of it.
  const BACK_WINDOW = { x: 7.85, width: 2.1, sill: 1.5, spring: 5.3 };
  world(archedWall(20.5, 7.2, 0.7, sides.map((side) => ({ x: side * BACK_WINDOW.x, width: BACK_WINDOW.width, spring: BACK_WINDOW.spring, sill: BACK_WINDOW.sill }))), cream, 0, 0, BACK_Z + 0.35, undefined, undefined, { hit: true });
  world(wbox(20.5, CEILING + 0.5 - 7.2, 0.7), plaster, 0, (CEILING + 0.5 + 7.2) / 2, BACK_Z + 0.35, undefined, undefined, { hit: true });
  world(wbox(20.5, CEILING + 0.5, 0.7), plaster, 0, (CEILING + 0.5) / 2, END_Z - 0.35, undefined, undefined, { hit: true });

  // Dado, its cap and the skirting, wherever the wall is plain.
  const plainRuns: Record<number, Array<[number, number]>> = { [-1]: [[END_Z, -3.0], [0.9, BACK_Z]], 1: [[END_Z, TELLER.z0 - 0.02], [TELLER.z1 + 0.02, BACK_Z]] };
  for (const side of sides) for (const [from, to] of plainRuns[side]) {
    const length = to - from, mid = (from + to) / 2;
    world(wbox(0.05, DADO - 0.2, length), green, side * (WALL_X - 0.025), (DADO + 0.2) / 2, mid, undefined, undefined, { hit: true });
    world(wbox(0.08, 0.2, length), green, side * (WALL_X - 0.04), 0.1, mid);
    world(wbox(0.09, 0.1, length), cream, side * (WALL_X - 0.045), DADO + 0.05, mid);
    world(wbox(0.05, 0.03, length), brass, side * (WALL_X - 0.025), DADO + 0.115, mid, undefined, undefined, { fine: true });
  }
  for (const z of [BACK_Z - 0.025, END_Z + 0.025]) {
    const into = Math.sign(hallMidOf(z));
    world(wbox(WALL_X * 2, DADO - 0.2, 0.05), green, 0, (DADO + 0.2) / 2, z);
    world(wbox(WALL_X * 2, 0.2, 0.08), green, 0, 0.1, z + into * 0.015);
    world(wbox(WALL_X * 2, 0.1, 0.09), cream, 0, DADO + 0.05, z + into * 0.02);
  }
  // String course along both sides, and one above the chart.
  const hallLength = BACK_Z - END_Z, hallMid = (BACK_Z + END_Z) / 2;
  for (const side of sides) {
    world(wbox(0.14, 0.2, hallLength), cream, side * (WALL_X - 0.07), STRING + 0.1, hallMid);
    world(wbox(0.2, 0.07, hallLength), cream, side * (WALL_X - 0.1), STRING + 0.235, hallMid);
  }
  world(wbox(WALL_X * 2, 0.2, 0.14), cream, 0, 7.3, BACK_Z - 0.07);
  world(wbox(WALL_X * 2, 0.07, 0.2), cream, 0, 7.435, BACK_Z - 0.1);

  // Entablature: frieze, dentils and a cornice of three steps, right round the hall.
  {
    const steps: Array<[number, number, number]> = [[CORNICE + 0.25, 0.5, 0.1], [CORNICE + 0.575, 0.15, 0.2], [CORNICE + 0.74, 0.18, 0.36], [CORNICE + 0.915, 0.17, 0.5]];
    for (const [y, height, proud] of steps) {
      for (const side of sides) world(wbox(proud, height, hallLength), ceilingPlaster, side * (WALL_X - proud / 2), y, hallMid);
      world(wbox(WALL_X * 2, height, proud), ceilingPlaster, 0, y, BACK_Z - proud / 2);
      world(wbox(WALL_X * 2, height, proud), ceilingPlaster, 0, y, END_Z + proud / 2);
    }
    const dentil = box(0.1, 0.1, 0.13);
    for (let z = END_Z + 0.2; z < BACK_Z; z += 0.26) for (const side of sides) world(dentil, gilt, side * (WALL_X - 0.15), CORNICE + 0.56, z, undefined, undefined, { fine: true });
    const dentilAcross = box(0.13, 0.1, 0.1);
    for (let x = -WALL_X + 0.3; x < WALL_X - 0.2; x += 0.26) for (const z of [BACK_Z - 0.15, END_Z + 0.15]) world(dentilAcross, gilt, x, CORNICE + 0.56, z, undefined, undefined, { fine: true });
    for (const side of sides) world(wbox(0.03, 0.05, hallLength), gilt, side * (WALL_X - 0.115), CORNICE + 0.03, hallMid);
  }

  // Pilasters on the grid. Where the range needs the wall (the strongroom, the teller line) they start
  // from the string course instead of the floor.
  const pilaster = (add: ReturnType<typeof frame>, from: number) => {
    if (from < 1) {
      add(wbox(0.96, DADO + 0.1, 0.24), green, 0, (DADO + 0.1) / 2, 0.12, undefined, undefined, { hit: true });
      add(wbox(1.02, 0.2, 0.28), green, 0, 0.1, 0.14);
      add(wbox(1.02, 0.1, 0.28), cream, 0, DADO + 0.15, 0.14);
    }
    const foot = from < 1 ? DADO + 0.2 : from;
    add(wbox(0.9, 0.14, 0.24), cream, 0, foot + 0.07, 0.12);
    add(wbox(0.82, 0.1, 0.2), cream, 0, foot + 0.19, 0.1);
    const shaft = 8.66 - (foot + 0.24);
    add(wbox(0.72, shaft, 0.15), cream, 0, foot + 0.24 + shaft / 2, 0.075, undefined, undefined, { hit: true });
    for (let i = -2; i <= 2; i += 1) add(wbox(0.07, shaft - 0.5, 0.03), cream, i * 0.13, foot + 0.24 + shaft / 2, 0.16, undefined, undefined, { fine: true });
    // Capital: a gilt necking, a block with three upright leaves, an abacus.
    add(box(0.78, 0.06, 0.19), gilt, 0, 8.69, 0.095);
    add(wbox(0.76, 0.5, 0.18), cream, 0, 8.97, 0.09);
    for (const x of [-0.25, 0, 0.25]) add(box(0.16, 0.4, 0.03), gilt, x, 8.96, 0.195, undefined, undefined, { fine: true });
    add(wbox(0.96, 0.12, 0.26), cream, 0, 9.28, 0.13);
    add(box(0.98, 0.04, 0.27), gilt, 0, 9.36, 0.135);
  };
  const upperOnly: Record<number, number[]> = { [-1]: [2], 1: [2, 3] };
  GRID.forEach((z, k) => {
    if (k === 0 || k === GRID.length - 1) return;
    for (const side of sides) pilaster(wallFrame(side, z), upperOnly[side].includes(k) ? STRING + 0.27 : 0);
  });
  // Quarter pilasters fill the four corners, and a pair stands on the back wall outside the windows' reach.
  for (const side of sides) {
    pilaster(wallFrame(side, BACK_Z - 0.36), 0);
    pilaster(wallFrame(side, END_Z + 0.36), 0);
    pilaster(backFrame(side * 6.42), 7.47);
    pilaster(endFrame(side * 3.1), 0);
    pilaster(endFrame(side * 7.4), 0);
  }

  // Clerestory: a round-headed window in every bay, high on both walls, the night behind its bars.
  const CLERESTORY = { width: 2.5, sill: 5.75, spring: 7.75 };
  for (const side of sides) BAYS.forEach((z, k) => {
    const add = wallFrame(side, z);
    add(archBand(CLERESTORY.width, CLERESTORY.spring, 0.2, 0.09, CLERESTORY.sill), ceilingPlaster, 0, 0, 0);
    add(archBand(CLERESTORY.width - 0.02, CLERESTORY.spring, 0.07, 0.13, CLERESTORY.sill), bronze, 0, 0, 0);
    add(wbox(CLERESTORY.width + 0.7, 0.14, 0.2), cream, 0, CLERESTORY.sill - 0.07, 0.1);
    add(wbox(CLERESTORY.width + 0.4, 0.3, 0.1), ceilingPlaster, 0, CLERESTORY.sill - 0.29, 0.05);
    const pane = archPane(CLERESTORY.width, CLERESTORY.spring, CLERESTORY.sill);
    if (k % 3 === 1) for (let i = 0; i < pane.attributes.uv.count; i += 1) pane.attributes.uv.setX(i, 1 - pane.attributes.uv.getX(i));
    add(remap(pane, night, (k + (side > 0 ? 1 : 0)) % 2 ? "clerestoryB" : "clerestoryA"), nightGlass, 0, 0, 0.02);
    // Keystone.
    add(wbox(0.3, 0.42, 0.16), cream, 0, CLERESTORY.spring + CLERESTORY.width / 2 + 0.12, 0.08);
  });

  // ---- Ceiling -----------------------------------------------------------------------------------
  // One slab over the hall and everything beside it, so that the only light from above is what comes
  // through the lay light. Drawn in plan and extruded upward from the ceiling plane.
  const layBays = Array.from({ length: LAY.bays }, (_, k) => ({ z0: GRID[k + 1] + LAY.beam, z1: GRID[k] - LAY.beam }));
  {
    const outline = new THREE.Shape();
    outline.moveTo(-26, -42); outline.lineTo(26, -42); outline.lineTo(26, 19); outline.lineTo(-26, 19); outline.closePath();
    for (const { z0, z1 } of layBays) {
      const hole = new THREE.Path();
      hole.moveTo(-LAY.half, z0); hole.lineTo(-LAY.half, z1); hole.lineTo(LAY.half, z1); hole.lineTo(LAY.half, z0); hole.closePath();
      outline.holes.push(hole);
    }
    const slab = new THREE.ExtrudeGeometry(outline, { depth: 0.5, bevelEnabled: false });
    slab.rotateX(Math.PI / 2);
    slab.translate(0, CEILING + 0.5, 0);
    world(projectUv(slab, 3), ceilingPlaster, 0, 0, 0, undefined, undefined, { shadow: true });
  }
  // Cross beams on the grid and two long ones framing the lay light; lighter ribs cut each aisle bay into four coffers.
  const beamDepth = CEILING - SOFFIT;
  GRID.forEach((z) => world(wbox(WALL_X * 2, beamDepth, LAY.beam * 2, 3), ceilingPlaster, 0, SOFFIT + beamDepth / 2, z, undefined, undefined, { shadow: true }));
  for (const side of sides) {
    world(wbox(0.6, beamDepth, hallLength, 3), ceilingPlaster, side * (LAY.half + 0.3), SOFFIT + beamDepth / 2, hallMid, undefined, undefined, { shadow: true });
    world(wbox(0.26, beamDepth - 0.2, hallLength, 3), ceilingPlaster, side * PENDANT.x, SOFFIT + 0.2 + (beamDepth - 0.2) / 2, hallMid);
    world(box(0.05, 0.03, hallLength), gilt, side * (LAY.half + 0.02), SOFFIT + 0.06, hallMid);
    for (const z of BAYS) {
      world(wbox(WALL_X - LAY.half - 0.6, beamDepth - 0.2, 0.26, 3), ceilingPlaster, side * (WALL_X + LAY.half + 0.6) / 2, SOFFIT + 0.2 + (beamDepth - 0.2) / 2, z);
      // Each coffer: a stepped frame and a gilt rosette.
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
        const cx = side * (PENDANT.x + dx * 1.12), cz = z + dz * 1.4, w = 1.5, d = 2.0;
        world(wbox(w + 0.24, 0.1, 0.12, 3), ceilingPlaster, cx, CEILING - 0.05, cz - d / 2 - 0.06);
        world(wbox(w + 0.24, 0.1, 0.12, 3), ceilingPlaster, cx, CEILING - 0.05, cz + d / 2 + 0.06);
        world(wbox(0.12, 0.1, d, 3), ceilingPlaster, cx - w / 2 - 0.06, CEILING - 0.05, cz);
        world(wbox(0.12, 0.1, d, 3), ceilingPlaster, cx + w / 2 + 0.06, CEILING - 0.05, cz);
        world(lathe([[0, -0.12], [0.07, -0.11], [0.1, -0.06], [0.24, -0.04], [0.3, 0]], 12), gilt, cx, CEILING, cz, undefined, undefined, { fine: true });
      }
    }
  }
  // The last bay, over the gallery, is coffered right across.
  {
    const z = BAYS[6];
    for (const x of [-3, 0, 3]) for (const dz of [-1, 1]) {
      const cz = z + dz * 1.4, w = 2.3, d = 2.0;
      world(wbox(w + 0.24, 0.1, 0.12, 3), ceilingPlaster, x, CEILING - 0.05, cz - d / 2 - 0.06);
      world(wbox(w + 0.24, 0.1, 0.12, 3), ceilingPlaster, x, CEILING - 0.05, cz + d / 2 + 0.06);
      world(wbox(0.12, 0.1, d, 3), ceilingPlaster, x - w / 2 - 0.06, CEILING - 0.05, cz);
      world(wbox(0.12, 0.1, d, 3), ceilingPlaster, x + w / 2 + 0.06, CEILING - 0.05, cz);
      world(lathe([[0, -0.14], [0.08, -0.13], [0.12, -0.07], [0.3, -0.05], [0.38, 0]], 12), gilt, x, CEILING, cz, undefined, undefined, { fine: true });
    }
    world(wbox(LAY.half * 2, beamDepth - 0.2, 0.26, 3), ceilingPlaster, 0, SOFFIT + 0.2 + (beamDepth - 0.2) / 2, z);
    for (const x of [-1.5, 1.5]) world(wbox(0.26, beamDepth - 0.2, BAY - LAY.beam * 2, 3), ceilingPlaster, x, SOFFIT + 0.2 + (beamDepth - 0.2) / 2, z);
  }
  // Lay light: bronze bars in the ceiling plane, the glass above them.
  for (const { z0, z1 } of layBays) {
    const mid = (z0 + z1) / 2, length = z1 - z0;
    world(new THREE.PlaneGeometry(LAY.half * 2, length).rotateX(Math.PI / 2), layGlass, 0, CEILING + 0.3, mid);
    for (const x of [-3, -1.5, 0, 1.5, 3]) world(box(x === 0 ? 0.16 : 0.11, 0.2, length), bronze, x, CEILING + 0.05, mid, undefined, undefined, { shadow: true });
    for (let i = 1; i < 4; i += 1) world(box(LAY.half * 2, 0.14, 0.09), bronze, 0, CEILING + 0.07, z0 + (length * i) / 4, undefined, undefined, { shadow: true });
    // The reveal of the opening, catching the light of the glass.
    for (const side of sides) world(new THREE.PlaneGeometry(length, 0.3).rotateY(-side * Math.PI / 2), ceilingPlaster, side * LAY.half, CEILING + 0.15, mid);
    world(new THREE.PlaneGeometry(LAY.half * 2, 0.3), ceilingPlaster, 0, CEILING + 0.15, z0);
    world(new THREE.PlaneGeometry(LAY.half * 2, 0.3).rotateY(Math.PI), ceilingPlaster, 0, CEILING + 0.15, z1);
  }


  // ---- The strongroom ------------------------------------------------------------------------------
  // A portal of green marble round a steel collar; the tunnel through the wall; the room of boxes beyond.
  {
    const V = wallFrame(-1, VAULT.z);
    const portal = new THREE.Shape();
    portal.moveTo(-1.9, 0); portal.lineTo(1.9, 0); portal.lineTo(1.9, 3.95); portal.lineTo(-1.9, 3.95); portal.closePath();
    const eye = new THREE.Path();
    eye.absarc(0, VAULT.y, 1.52, 0, Math.PI * 2, false);
    portal.holes.push(eye);
    V(projectUv(new THREE.ExtrudeGeometry(portal, { depth: 0.12, bevelEnabled: false, curveSegments: 28 }), 2.4), green, 0, 0, 0, undefined, undefined, { hit: true });
    V(wbox(4.04, 0.12, 0.2), cream, 0, 4.01, 0.1);
    V(box(4.0, 0.03, 0.21), gilt, 0, 3.935, 0.105);
    V(sign("vault", 3.1), signMaterial, 0, 3.6, 0.125);
    // Collar and tunnel: the two seats the door's steps close on, then the bore through the wall.
    V(lathe([[1.66, 0.12], [1.66, 0.2], [1.5, 0.2], [1.5, 0.02], [1.38, 0.02], [1.38, -0.16], [VAULT.r, -0.16], [VAULT.r, -1.25]], 56).rotateX(Math.PI / 2), tunnelSteel, 0, VAULT.y, 0, undefined, undefined, { hit: true });
    for (let i = 0; i < 24; i += 1) { const a = (i + 0.5) * Math.PI / 12; V(cyl(0.028, 0.03, "z", 8), brass, Math.cos(a) * 1.58, VAULT.y + Math.sin(a) * 1.58, 0.21, undefined, undefined, { fine: true }); }
    V(wbox(1.28, 0.04, 1.5, 1.2), metals.structural, 0, VAULT.floor - 0.02, -0.5);
    V(wbox(1.7, 0.2, 0.62), green, 0, 0.1, 0.51);
    V(wbox(1.7, 0.21, 0.32), green, 0, 0.305, 0.36);
    for (const [y, z] of [[0.205, 0.81], [0.415, 0.51]]) V(box(1.7, 0.012, 0.03), brass, 0, y, z);

    const R = { x0: -16.79, x1: -10.79, z0: VAULT.z - 3.3, z1: VAULT.z + 3.3, top: 3.7 };
    const midX = (R.x0 + R.x1) / 2, deep = R.x1 - R.x0, wide = R.z1 - R.z0;
    world(wbox(deep, 0.1, wide, 1.2), metals.structural, midX, VAULT.floor - 0.05, VAULT.z);
    world(wbox(deep, 0.1, wide, 1.2), metals.structural, midX, R.top + 0.05, VAULT.z);
    // Boxes from knee height to above the head on three walls.
    world(tiled(new THREE.PlaneGeometry(wide, 2.4).rotateY(Math.PI / 2), wide / 1.2, 2), deposit, R.x0, 2.1, VAULT.z, undefined, undefined, { hit: true });
    world(tiled(new THREE.PlaneGeometry(deep, 2.4).rotateY(Math.PI), deep / 1.2, 2), deposit, midX, 2.1, R.z1, undefined, undefined, { hit: true });
    world(tiled(new THREE.PlaneGeometry(deep, 2.4), deep / 1.2, 2), deposit, midX, 2.1, R.z0, undefined, undefined, { hit: true });
    for (const [y, h] of [[(VAULT.floor + 0.9) / 2, 0.9 - VAULT.floor], [3.5, 0.4]]) {
      world(wbox(0.06, h, wide, 1.2), doorSteel, R.x0 + 0.03, y, VAULT.z);
      for (const z of [R.z0 + 0.03, R.z1 - 0.03]) world(wbox(deep, h, 0.06, 1.2), doorSteel, midX, y, z);
    }
    for (const x of [-12.5, -15.1]) {
      world(box(1.5, 0.06, 0.26), vaultGlow, x, R.top - 0.03, VAULT.z);
      world(box(1.6, 0.05, 0.36), bronze, x, R.top - 0.005, VAULT.z);
    }
    // The bullion trolley, left where the last count ended.
    {
      const T = frame(mat4(-13.2, VAULT.floor, VAULT.z - 0.55, [0, 0.42, 0]));
      for (const x of [-0.52, 0.52]) for (const z of [-0.27, 0.27]) {
        T(cyl(0.018, 0.84, "y", 8), metals.darkMetal, x, 0.5, z);
        T(cyl(0.05, 0.04, "x", 10), metals.darkMetal, x, 0.05, z);
      }
      for (const y of [0.22, 0.78]) T(box(1.12, 0.03, 0.62), metals.structural, 0, y, 0);
      T(cyl(0.016, 0.62, "z", 8), brass, 0.6, 0.98, 0);
      for (const z of [-0.27, 0.27]) T(cyl(0.016, 0.3, "y", 8), brass, 0.6, 0.86, z, [0, 0, -0.5]);
      const bar = new THREE.BoxGeometry(0.2, 0.046, 0.086), at = bar.attributes.position;
      for (let i = 0; i < at.count; i += 1) if (at.getY(i) > 0) at.setXYZ(i, at.getX(i) * 0.84, at.getY(i), at.getZ(i) * 0.72);
      bar.computeVertexNormals();
      for (let layer = 0; layer < 3; layer += 1) for (let row = 0; row < 2; row += 1) for (let i = 0; i < 4 - layer; i += 1) {
        T(bar, gold, -0.2 + row * 0.215, 0.82 + layer * 0.047, (i - (3 - layer) / 2) * 0.096, [0, (random() - 0.5) * 0.06, 0]);
      }
      T(bar, gold, 0.3, 0.82, 0.12, [0, 0.7, 0]);
      for (const [x, yaw] of [[-0.32, 0.1], [0.04, -0.06], [0.38, 0.2]]) {
        T(rbox(0.3, 0.15, 0.22, 0.012), paintGreen, x, 0.31, 0, [0, yaw, 0]);
        T(box(0.1, 0.012, 0.02), brass, x, 0.392, 0, [0, yaw, 0]);
      }
    }
    // The custodian's table against the far wall, two renters' tins on it.
    {
      const C = frame(mat4(R.x0 + 0.42, VAULT.floor, VAULT.z + 0.9));
      C(box(0.62, 0.04, 1.3), metals.structural, 0, 0.8, 0);
      for (const x of [-0.26, 0.26]) for (const z of [-0.6, 0.6]) C(box(0.04, 0.78, 0.04), metals.darkMetal, x, 0.39, z);
      C(rbox(0.16, 0.1, 0.52, 0.008), doorSteel, 0.05, 0.87, -0.2, [0, 0.2, 0]);
      C(rbox(0.16, 0.1, 0.52, 0.008), doorSteel, -0.05, 0.87, 0.34, [0, -0.5, 0]);
      C(sign("ledger", 0.34), signMaterial, 0.12, 0.823, 0.05, [-Math.PI / 2, 0, 1.2]);
      bankerLamp(R.x0 + 0.3, VAULT.floor + 0.82, VAULT.z + 0.35, Math.PI / 2, 2.6, 0.8);
    }
  }

  // The door: a stepped plug of steel 3.2 m across, lying open against the wall with its works to the room.
  {
    const D = frame(mat4(-9.4, VAULT.y, VAULT.doorZ));
    D(lathe([[0, 0], [1.6, 0], [1.6, 0.2], [1.5, 0.22], [1.5, 0.38], [1.38, 0.4], [1.38, 0.56], [VAULT.r, 0.58], [0, 0.58]], 64).rotateZ(-Math.PI / 2), doorSteel, 0, 0, 0, undefined, undefined, { hit: true });
    const F = frame(mat4(-8.82, VAULT.y, VAULT.doorZ, [0, Math.PI / 2, 0]));
    const facing = (geometry: THREE.BufferGeometry) => geometry.rotateX(Math.PI / 2);
    F(facing(lathe([[0.86, 0], [1.14, 0], [1.14, 0.03], [0.86, 0.03], [0.86, 0]], 48)), brass);
    for (let i = 0; i < 16; i += 1) {
      const a = (i + 0.5) * Math.PI / 8, cos = Math.cos(a), sin = Math.sin(a);
      F(box(0.3, 0.11, 0.07), bronze, cos * 1.1, sin * 1.1, 0.035, [0, 0, a]);
      F(cyl(0.045, 0.2, "x", 10), brass, cos * 1.4, sin * 1.4, -0.1, [0, 0, a]);
      F(cyl(0.026, 0.02, "z", 8), brass, cos * 1.22, sin * 1.22, 0.072, undefined, undefined, { fine: true });
    }
    for (let i = 0; i < 8; i += 1) { const a = i * Math.PI / 4; F(cyl(0.02, 0.58, "x", 6), doorSteel, Math.cos(a) * 0.58, Math.sin(a) * 0.58, 0.045, [0, 0, a]); }
    F(facing(lathe([[0, 0], [0.3, 0], [0.3, 0.05], [0.2, 0.1], [0, 0.1]], 28)), brass);
    // Hand wheel.
    F(new THREE.TorusGeometry(0.4, 0.028, 8, 36), brass, 0, 0, 0.24);
    for (let i = 0; i < 3; i += 1) F(cyl(0.018, 0.8, "x", 6), brass, 0, 0, 0.24, [0, 0, i * Math.PI / 3]);
    F(cyl(0.065, 0.18, "z", 14), brass, 0, 0, 0.18);
    F(new THREE.SphereGeometry(0.07, 12, 8), brass, 0, 0, 0.28);
    for (let i = 0; i < 6; i += 1) { const a = i * Math.PI / 3; F(cyl(0.022, 0.1, "z", 8), brass, Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0.29); }
    // Time lock: three movements behind glass, above the hub.
    F(rbox(0.7, 0.32, 0.08, 0.02), bronze, 0, 0.6, 0.04);
    for (const [w, h, x, y] of [[0.74, 0.03, 0, 0.775], [0.74, 0.03, 0, 0.425], [0.03, 0.38, -0.37, 0.6], [0.03, 0.38, 0.37, 0.6]]) F(box(w, h, 0.1), brass, x, y, 0.05);
    for (const x of [-0.22, 0, 0.22]) F(remap(new THREE.CircleGeometry(0.1, 28), signs, "timeDial"), signMaterial, x, 0.6, 0.084);
    F(sign("maker", 0.5), signMaterial, 0, -0.6, 0.004);
    for (const side of sides) {
      F(box(0.03, 0.36, 0.03), brass, side * 0.66, 0, 0.1);
      for (const y of [-0.15, 0.15]) F(box(0.03, 0.03, 0.1), brass, side * 0.66, y, 0.05);
    }
    // Hinge: a post beside the opening, two straps to the door.
    const hingeZ = (VAULT.z + VAULT.doorZ) / 2;
    world(cyl(0.1, 2.7, "y", 16), metals.structural, -8.98, VAULT.y, hingeZ, undefined, undefined, { hit: true });
    for (const [y, turn] of [[VAULT.y + 1.35, 0], [VAULT.y - 1.35, Math.PI]]) world(lathe([[0, 0.16], [0.05, 0.14], [0.13, 0.04], [0.13, 0], [0, 0]], 14), brass, -8.98, y, hingeZ, [turn, 0, 0]);
    for (const y of [VAULT.y + 1.22, VAULT.y - 1.22]) world(wbox(0.5, 0.14, 0.3, 1.2), metals.darkMetal, -9.17, y, hingeZ);
    for (const y of [VAULT.y + 0.8, VAULT.y - 0.8]) {
      world(wbox(0.07, 0.14, 0.78, 1.2), metals.darkMetal, -8.775, y, hingeZ - 0.39);
      world(cyl(0.135, 0.2, "y", 16), metals.darkMetal, -8.98, y, hingeZ);
      world(wbox(0.2, 0.14, 0.1, 1.2), metals.darkMetal, -8.88, y, hingeZ - 0.05);
    }
  }

  // ---- The teller line -----------------------------------------------------------------------------
  {
    const piers = [-9.5, -7.2, -4.9, -2.6, -0.3], windows = [-8.35, -6.05, -3.75, -1.45];
    const plates = ["deposits", "withdrawals", "eco", "loans"], tickets = ["windowA", "windowB", "windowMID", "windowLONG"];
    for (const z of piers) {
      world(wbox(0.5, TELLER.top, 0.4), cream, 9.35, TELLER.top / 2, z, undefined, undefined, { hit: true });
      world(wbox(0.56, 0.2, 0.46), green, 9.35, 0.1, z);
      world(box(0.52, 0.05, 0.42), brass, 9.35, 2.53, z);
      world(wbox(0.6, 0.12, 0.5), cream, 9.35, TELLER.top - 0.06, z);
    }
    const bay = 1.9;
    windows.forEach((z, k) => {
      // Counter: marble plinth, panelled front, marble top.
      world(wbox(0.14, 0.2, bay), green, 9.13, 0.1, z);
      world(wbox(0.06, 0.86, bay, 1.4), timber, 9.15, 0.63, z, undefined, undefined, { hit: true });
      for (const dz of [-0.47, 0.47]) {
        world(rbox(0.03, 0.62, 0.8, 0.012, 1.4), timber, 9.115, 0.62, z + dz);
        world(rbox(0.02, 0.44, 0.6, 0.01, 1.4), timber, 9.097, 0.62, z + dz, undefined, undefined, { fine: true });
      }
      world(cyl(0.018, bay, "z", 8), brass, 9.04, 0.34, z);
      for (const dz of [-0.9, 0, 0.9]) world(box(0.09, 0.03, 0.03), brass, 9.08, 0.34, z + dz, undefined, undefined, { fine: true });
      world(wbox(0.9, 0.06, bay, 1.2), green, 9.4, 1.07, z, undefined, undefined, { hit: true });
      // Grille: square bars set on the diagonal, stopped over the arched wicket.
      const gx = 9.25, sill = 1.1, head = 2.46, wicket = 0.25, springing = 1.4;
      for (const dz of [-0.6, 0.6]) world(box(0.03, 0.03, bay / 2 - wicket), brass, gx, sill + 0.015, z + dz);
      for (const y of [2.0, 2.14, head]) world(box(0.03, 0.03, bay), brass, gx, y, z);
      for (let i = -12; i <= 12; i += 1) {
        const dz = i * 0.076, foot = Math.abs(dz) < wicket ? springing + Math.sqrt(wicket * wicket - dz * dz) : sill + 0.03;
        world(box(0.014, head - foot, 0.014), brass, gx, (head + foot) / 2, z + dz, [0, Math.PI / 4, 0]);
        if (i < 12) world(box(0.012, 0.07, 0.07), brass, gx, 2.07, z + dz + 0.038, [Math.PI / 4, 0, 0], undefined, { fine: true });
      }
      world(new THREE.TorusGeometry(wicket, 0.016, 6, 18, Math.PI).rotateY(Math.PI / 2), brass, gx, springing, z);
      for (const dz of [-wicket, wicket]) world(box(0.03, springing - sill, 0.03), brass, gx, (springing + sill) / 2, z + dz);
      world(lathe([[0, 0], [0.11, 0], [0.13, 0.012], [0.11, 0.016], [0.05, 0.006], [0, 0.006]], 16), brass, 9.2, 1.1, z);
      const W = wallFrame(1, z);
      W(remap(new THREE.CircleGeometry(0.11, 24), signs, tickets[k]), signMaterial, 0, 2.07, WALL_X - gx + 0.02);
      // Fascia with the name of the window, and the dark glass of the screen above it.
      world(wbox(0.1, 0.5, bay, 1.4), timber, 9.25, 2.75, z);
      W(sign(plates[k], 1.5), signMaterial, 0, 2.75, WALL_X - 9.195);
      world(new THREE.PlaneGeometry(bay, 0.76).rotateY(-Math.PI / 2), darkGlass, 9.3, 3.5, z);
      world(wbox(0.06, 0.8, 0.06, 1.4), timber, 9.29, 3.5, z);
      bankerLamp(9.56, 1.1, z + 0.62, -Math.PI / 2, 3.4, 1.1);
      // The teller's side: a stool, a ledger, the till.
      world(lathe([[0, 0], [0.17, 0], [0.17, 0.02], [0.03, 0.04], [0.03, 0.62], [0.16, 0.66], [0.17, 0.72], [0, 0.74]], 14), leather, 10.35, 0.02, z - 0.1, undefined, undefined, { fine: true });
      world(rbox(0.34, 0.07, 0.44, 0.01), k % 2 ? leather : velvet, 9.62, 1.135, z - 0.5, [0, 0.2 - k * 0.15, 0], undefined, { fine: true });
      world(rbox(0.3, 0.1, 0.36, 0.01), paintGreen, 9.66, 1.15, z + 0.1, [0, 0.05, 0], undefined, { fine: true });
    });
    world(wbox(0.24, 0.1, TELLER.z1 - TELLER.z0, 1.4), timber, 9.24, 3.05, (TELLER.z0 + TELLER.z1) / 2);
    world(box(0.25, 0.02, TELLER.z1 - TELLER.z0), gilt, 9.24, 3.0, (TELLER.z0 + TELLER.z1) / 2);
    // The bank's name in gilt letters on a frieze of green marble over the screens.
    const F = wallFrame(1, (TELLER.z0 + TELLER.z1) / 2);
    F(wbox(7.3, 0.5, 0.03), green, 0, 4.25, 0.015);
    for (const y of [3.985, 4.515]) F(box(7.36, 0.03, 0.045), gilt, 0, y, 0.0225);
    F(sign("bank", 6.6), signMaterial, 0, 4.25, 0.036);
    // The room behind: boards underfoot, shelves of ledgers on the back wall, a long desk under them.
    const midZ = (TELLER.z0 + TELLER.z1) / 2, wide = TELLER.z1 - TELLER.z0, deep = TELLER.back - WALL_X, midX = (TELLER.back + WALL_X) / 2;
    world(wbox(deep + 0.7, 0.04, wide, 1.6), timber, midX + 0.35, 0.0, midZ);
    world(wbox(deep + 0.7, 0.1, wide, 3), ceilingPlaster, midX + 0.35, TELLER.top + 0.05, midZ);
    world(remap(new THREE.PlaneGeometry(wide, wide * 0.375).rotateY(-Math.PI / 2), signs, "tellerBack"), signMaterial, TELLER.back, 0.9 + wide * 0.1875, midZ);
    world(wbox(0.1, TELLER.top, wide, 1.6), timber, TELLER.back + 0.05, TELLER.top / 2, midZ);
    for (const z of [TELLER.z0, TELLER.z1]) world(wbox(deep + 0.7, TELLER.top, 0.1, 3), plaster, midX + 0.35, TELLER.top / 2, z + Math.sign(z - midZ) * 0.05);
    world(wbox(0.6, 0.9, wide - 0.4, 1.6), timber, TELLER.back - 0.3, 0.45, midZ);
    world(wbox(0.66, 0.04, wide - 0.3, 1.6), timber, TELLER.back - 0.3, 0.92, midZ);
    world(sign("calendar", 0.4).rotateY(-Math.PI / 2), signMaterial, TELLER.back - 0.01, 2.75, -9.1);
    // A safe at the far end of the desk, and the things left out on it.
    world(rbox(0.7, 1.2, 0.8, 0.03), paintGreen, TELLER.back - 0.4, 0.6, TELLER.z1 - 0.6);
    world(cyl(0.07, 0.03, "x", 16), brass, TELLER.back - 0.76, 0.8, TELLER.z1 - 0.6);
    world(box(0.03, 0.03, 0.16), brass, TELLER.back - 0.77, 0.55, TELLER.z1 - 0.6);
    for (const [z, yaw] of [[-8.2, 0.1], [-5.6, -0.2], [-3.0, 0.15]]) {
      world(rbox(0.3, 0.06, 0.42, 0.01), velvet, TELLER.back - 0.34, 0.97, z, [0, yaw, 0], undefined, { fine: true });
      world(sign("ledger", 0.5).rotateX(-Math.PI / 2), signMaterial, TELLER.back - 0.3, 0.945, z + 0.6, [0, Math.PI / 2 + yaw, 0], undefined, { fine: true });
    }
    bankerLamp(TELLER.back - 0.28, 0.94, -6.9, -Math.PI / 2, 3.0, 0.9);
  }

  // ---- Back wall: the windows on the street -----------------------------------------------------------
  for (const side of sides) {
    const B = backFrame(side * BACK_WINDOW.x), w = BACK_WINDOW.width, half = w / 2, { sill, spring } = BACK_WINDOW;
    B(archBand(w, spring, 0.18, 0.07, sill), cream);
    B(wbox(w + 0.6, 0.12, 0.26), cream, 0, sill - 0.06, 0.06);
    B(wbox(w + 0.36, 0.2, 0.1), cream, 0, sill - 0.22, 0.05);
    B(wbox(0.3, 0.4, 0.14), cream, 0, spring + half + 0.1, 0.07);
    for (let i = -3; i <= 3; i += 1) {
      const x = i * 0.3, top = spring + Math.sqrt(Math.max(0, half * half - x * x));
      B(box(0.036, top - sill, 0.036), bronze, x, (top + sill) / 2, -0.22);
    }
    for (let y = sill + 0.5; y < spring + half - 0.15; y += 0.5) {
      const reach = y <= spring ? half : Math.sqrt(half * half - (y - spring) * (y - spring));
      B(box(reach * 2, 0.036, 0.03), bronze, 0, y, -0.22);
    }
    B(archPane(w, spring, sill), windowGlass, 0, 0, -0.45);
    B(sign("radiator", 1.5).scale(1, 0.5, 1), signMaterial, 0, 0.66, 0.055);
    // The street: a lamp on its post, the house opposite, wet paving.
    world(cyl(0.06, 4.3, "y", 8, false, 0.04), metals.darkMetal, side * 7.25, 2.15, 12.9);
    world(lathe([[0, 0.3], [0.1, 0.26], [0.2, 0.2], [0.21, 0.17], [0.05, 0.17]], 10), metals.darkMetal, side * 7.25, 4.36, 12.9);
    world(new THREE.SphereGeometry(0.17, 12, 8), lampGlow, side * 7.25, 4.42, 12.9);
    for (const x of [7, 17]) {
      world(remap(new THREE.PlaneGeometry(10, 7).rotateY(Math.PI), night, "street"), nightGlass, side * x, 3.5, 15.6);
      world(new THREE.PlaneGeometry(10, 4.5).rotateY(Math.PI), street, side * x, 9.2, 15.6);
    }
  }
  world(wbox(46, 0.06, 6), street, 0, 0.03, 13.4);


  // ---- Beside the firing line ------------------------------------------------------------------------
  const wind = createWind({ heading: 0.4, strength: 0.05, gustiness: 0.5 });
  let sunLight: THREE.DirectionalLight | null = null;
  const trees = createTrees(kit, { seed: 1207, wind, sun: () => sunLight ?? TO_SUN });
  const life = createLife(kit, options, { wind, seed: 1207 });

  /** A standing writing desk against a side wall: sloped top, a ledge for the lamp and the ink, a chained pen. */
  const writingDesk = (side: number, z: number) => {
    const W = wallFrame(side, z);
    W(wbox(1.76, 0.035, 0.5, 1.4), timber, 0, 1.105, 0.4, [0.13, 0, 0], undefined, { hit: true });
    W(wbox(1.76, 0.03, 0.18, 1.4), timber, 0, 1.2, 0.09);
    W(wbox(1.7, 0.2, 0.03, 1.4), timber, 0, 1.11, 0.19);
    W(wbox(1.66, 0.16, 0.56, 1.4), timber, 0, 0.99, 0.34, undefined, undefined, { hit: true });
    for (const x of [-0.78, 0.78]) for (const lz of [0.1, 0.58]) W(lathe([[0, 0], [0.05, 0], [0.05, 0.04], [0.03, 0.08], [0.042, 0.4], [0.03, 0.7], [0.045, 0.82], [0.045, 0.92], [0, 0.92]], 10), timber, x, 0, lz);
    W(cyl(0.016, 1.56, "x", 8), brass, 0, 0.17, 0.58);
    W(cyl(0.008, 1.7, "x", 6), brass, 0, 1.3, 0.02);
    for (const x of [-0.84, 0, 0.84]) W(cyl(0.008, 0.1, "y", 6), brass, x, 1.26, 0.02);
    // Blotter, slips, inkwell, and the pen on its chain.
    W(rbox(0.56, 0.01, 0.36, 0.004), leather, -0.34, 1.133, 0.4, [0.13, 0, 0]);
    W(sign("slip", 0.24).rotateX(-Math.PI / 2), signMaterial, -0.36, 1.143, 0.39, [0.13, 0.2, 0]);
    W(sign("slip", 0.24).rotateX(-Math.PI / 2), signMaterial, 0.3, 1.128, 0.44, [0.13, -0.5, 0]);
    W(sign("slip", 0.24).rotateX(-Math.PI / 2), signMaterial, 0.5, 1.13, 0.36, [0.13, 0.9, 0], undefined, { fine: true });
    W(lathe([[0, 0], [0.04, 0], [0.045, 0.03], [0.03, 0.05], [0.018, 0.055], [0, 0.055]], 10), brass, 0.2, 1.215, 0.09);
    const chain = new THREE.CatmullRomCurve3([[0.34, 1.3, 0.02], [0.3, 1.2, 0.2], [0.2, 1.135, 0.36], [0.08, 1.132, 0.42]].map(([x, y, lz]) => new THREE.Vector3(x, y, lz)));
    W(new THREE.TubeGeometry(chain, 14, 0.0035, 5), brass, 0, 0, 0, undefined, undefined, { fine: true });
    W(cyl(0.006, 0.16, "x", 6), metals.darkMetal, 0, 1.138, 0.43, [0.13, 0.5, 0], undefined, { fine: true });
    bankerLamp(side * (WALL_X - 0.09), 1.215, z + side * 0.6, -side * Math.PI / 2, 3.2, 1.05);
  };
  writingDesk(-1, 6.6);
  writingDesk(1, 6.6);
  // West: the rate board over the desk, the slip rack and a tablet between the desk and the strongroom.
  {
    const W = wallFrame(-1, 6.6);
    W(sign("rates", 1.9), signMaterial, 0, 2.5, 0.03);
    W(wbox(2.0, 1.05, 0.03, 1.4), timber, 0, 2.5, 0.012);
    const R = wallFrame(-1, 2.15);
    R(wbox(1.1, 0.74, 0.05, 1.4), timber, 0, 1.75, 0.025);
    for (let row = 0; row < 3; row += 1) {
      R(wbox(1.1, 0.025, 0.16, 1.4), timber, 0, 1.46 + row * 0.24, 0.1, [0.5, 0, 0]);
      for (let col = 0; col < 4; col += 1) R(rbox(0.2, 0.17, 0.02 + ((row * 4 + col) % 3) * 0.012, 0.003), paper, -0.39 + col * 0.26, 1.55 + row * 0.24, 0.085, [-0.3, 0, 0], undefined, { fine: true });
    }
    for (const x of [-0.56, 0.56]) R(wbox(0.03, 0.78, 0.18, 1.4), timber, x, 1.75, 0.09);
    R(sign("cases", 0.9), signMaterial, 0, 2.75, 0.012);
    R(sign("radiator", 1.3).scale(1, 0.5, 1), signMaterial, 0, 0.66, 0.055);
    // The rules of the strongroom, framed between its door and the next pilaster.
    const N = wallFrame(-1, -6.85);
    N(picture("rules", 0.62), pictures, 0, 2.15, 0.03);
    N(wbox(0.7, 1.01, 0.025, 1.4), timber, 0, 2.15, 0.0125);
  }
  // East: a tablet over the desk; the porter's chair, his table and the bell between the desk and the tellers.
  {
    const G = wallFrame(1, 6.6);
    G(picture("painting", 1.7), pictures, 0, 2.62, 0.05);
    for (const [w, h, x, y] of [[1.94, 0.12, 0, 0.7], [1.94, 0.12, 0, -0.7], [0.12, 1.52, 0.91, 0], [0.12, 1.52, -0.91, 0]]) G(rbox(w, h, 0.07, 0.02), gilt, x, 2.62 + y, 0.035);
    G(sign("save", 0.8), signMaterial, 0, 1.62, 0.012);
    // A brass picture light on two arms over the frame.
    G(cyl(0.035, 1.1, "x", 10), brass, 0, 3.52, 0.3);
    G(box(1.0, 0.004, 0.05), lampGlow, 0, 3.487, 0.3);
    for (const x of [-0.4, 0.4]) G(cyl(0.01, 0.3, "z", 6), brass, x, 3.5, 0.15);
    lamp([WALL_X - 0.34, 3.46, 6.6], WARM.clone().multiplyScalar(0.55), 2.3);
    const P = wallFrame(1, 1.75);
    P(sign("porter", 0.9), signMaterial, 0, 2.5, 0.012);
    P(sign("bonus", 1.25), signMaterial, 0, 2.02, 0.012);
    P(picture("poster", 0.72), pictures, -1.25, 2.3, 0.03);
    P(wbox(0.8, 1.16, 0.025, 1.4), timber, -1.25, 2.3, 0.0125);
    bankerLamp(9.12, 0.69, 2.3, -Math.PI / 2 - 0.5, 2.8, 0.8);
    P(lathe([[0, 0.06], [0.03, 0.055], [0.055, 0.03], [0.07, 0], [0, 0]], 14).rotateX(Math.PI / 2), brass, 0.62, 1.5, 0);
    P(cyl(0.012, 0.03, "z", 8), metals.darkMetal, 0.62, 1.5, 0.07);
    P(sign("radiator", 1.3).scale(1, 0.5, 1), signMaterial, -0.9, 0.66, 0.055);
    // Chair.
    const C = frame(mat4(8.98, 0, 1.2, [0, -Math.PI / 2 + 0.25, 0]));
    for (const x of [-0.22, 0.22]) {
      C(wbox(0.045, 0.46, 0.045, 1.4), timber, x, 0.23, 0.2);
      C(wbox(0.045, 1.02, 0.045, 1.4), timber, x, 0.51, -0.22, [-0.06, 0, 0]);
      C(wbox(0.05, 0.03, 0.46, 1.4), timber, x * 1.14, 0.68, 0);
      C(wbox(0.035, 0.22, 0.035, 1.4), timber, x * 1.14, 0.57, 0.2);
    }
    C(rbox(0.5, 0.07, 0.48, 0.02), leather, 0, 0.47, 0, undefined, undefined, { hit: true });
    C(rbox(0.44, 0.4, 0.05, 0.02), leather, 0, 0.8, -0.235, [-0.06, 0, 0]);
    C(wbox(0.5, 0.06, 0.04, 1.4), timber, 0, 1.03, -0.25, [-0.06, 0, 0]);
    // His cap on the seat.
    C(lathe([[0, 0.085], [0.1, 0.08], [0.125, 0.05], [0.11, 0.01], [0.105, 0], [0, 0]], 14), paintGreen, 0.04, 0.505, 0.02, undefined, undefined, { fine: true });
    C(cyl(0.11, 0.008, "y", 12), metals.darkMetal, 0.04, 0.508, 0.1, undefined, [1, 1, 0.6], { fine: true });
    // Table: the evening paper, a flask, a mug, a torch.
    const T = frame(mat4(9.02, 0, 2.15));
    T(lathe([[0, 0], [0.2, 0], [0.2, 0.02], [0.03, 0.05], [0.03, 0.62], [0.3, 0.66], [0.3, 0.69], [0, 0.69]], 16), timber, 0, 0, 0, undefined, undefined, { hit: true });
    T(sign("paper", 0.32).rotateX(-Math.PI / 2), signMaterial, -0.04, 0.695, 0.04, [0, 0.5, 0]);
    T(lathe([[0, 0], [0.04, 0], [0.04, 0.17], [0.03, 0.2], [0.03, 0.24], [0, 0.24]], 10), paintGreen, 0.12, 0.69, -0.14, undefined, undefined, { fine: true });
    T(lathe([[0, 0], [0.035, 0], [0.04, 0.08], [0.036, 0.08], [0.03, 0.01], [0, 0.01]], 10), cream, -0.14, 0.69, -0.12, undefined, undefined, { fine: true });
    T(cyl(0.02, 0.18, "x", 8), metals.brushed, 0.1, 0.71, 0.16, [0, 0.6, 0], undefined, { fine: true });
  }

  // Queue posts with velvet rope: a line drawn across the tellers after closing, and one across the strongroom door.
  const ropeVelvet = standard({ color: 0x7a1018, roughness: 0.95 });
  const post = (x: number, z: number, height = 0.96) => {
    world(lathe([[0, 0], [0.16, 0], [0.16, 0.015], [0.1, 0.04], [0.03, 0.06], [0.024, 0.1], [0.024, height - 0.08], [0.04, height - 0.06], [0.045, height - 0.02], [0.03, height], [0, height + 0.01]], 14), brass, x, 0, z, undefined, undefined, { hit: true });
    world(new THREE.SphereGeometry(0.036, 10, 8), brass, x, height + 0.03, z);
  };
  const rope = (a: V3, b: V3, sag = 0.2) => {
    const points = Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      return new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t);
    });
    world(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.017, 6), ropeVelvet, 0, 0, 0, undefined, undefined, { walk: true });
    for (const end of [a, b]) world(cyl(0.022, 0.05, "y", 8), brass, end[0], end[1] - 0.01, end[2], undefined, undefined, { walk: true });
  };
  const tellerPosts = [-0.55, -2.65, -4.75, -6.85, -8.95];
  tellerPosts.forEach((z, i) => {
    post(8.42, z);
    if (i) rope([8.42, 0.9, tellerPosts[i - 1] - 0.04], [8.42, 0.9, z + 0.04]);
  });
  for (const z of [VAULT.z + 1.2, VAULT.z - 1.15]) post(-8.42, z);
  rope([-8.42, 0.9, VAULT.z + 1.16], [-8.42, 0.9, VAULT.z - 1.11], 0.24);
  // The stand at the head of the tellers' rope; the card on it hangs on two chains (see "Motion").
  const CARD = { x: 8.36, y: 1.52, z: 0.42, yaw: -0.5 };
  {
    const S = frame(mat4(CARD.x, 0, CARD.z, [0, CARD.yaw, 0]));
    S(lathe([[0, 0], [0.19, 0], [0.19, 0.02], [0.1, 0.05], [0.03, 0.07], [0.022, 0.12], [0.022, 1.56], [0, 1.57]], 14), brass, 0, 0, 0, undefined, undefined, { hit: true });
    S(cyl(0.012, 0.5, "x", 8), brass, 0, 1.54, 0);
    for (const x of [-0.25, 0.25]) S(new THREE.SphereGeometry(0.02, 8, 6), brass, x, 1.54, 0);
  }

  // Palms in brass-bound tubs in the back corners, against the windows.
  const tubs: V3[] = [[-8.75, 0, 8.8], [8.75, 0, 8.8]];
  for (const [x, , z] of tubs) {
    world(lathe([[0, 0], [0.27, 0], [0.29, 0.04], [0.34, 0.46], [0.36, 0.5], [0.3, 0.5], [0.29, 0.44], [0, 0.44]], 18), timber, x, 0, z, undefined, undefined, { hit: true });
    for (const y of [0.1, 0.4]) world(new THREE.TorusGeometry(0.3 + y * 0.11, 0.012, 6, 20).rotateX(Math.PI / 2), brass, x, y, z);
  }
  const palms = trees.place("fanPalm", tubs.map(([x, , z], index) => ({ at: [x, 0.42, z] as V3, scale: [0.6, 0.62, 0.6] as V3, variant: 1, yaw: 0.7 + index * 2.1 })), { shadow: false });
  palms.forEach((mesh) => { mesh.userData.walkThrough = true; });

  // ---- The far end: gallery, the great clock ----------------------------------------------------------
  const GALLERY = { z: -28.9, y: 5.6 };
  const CLOCK = { y: 8.12, r: 1.14 };
  {
    const depth = GALLERY.z - END_Z, mid = (GALLERY.z + END_Z) / 2;
    world(wbox(WALL_X * 2, 0.26, depth, 3), ceilingPlaster, 0, GALLERY.y - 0.13, mid, undefined, undefined, { hit: true });
    world(wbox(WALL_X * 2, 0.62, 0.18), cream, 0, GALLERY.y - 0.31, GALLERY.z + 0.02, undefined, undefined, { hit: true });
    world(wbox(WALL_X * 2, 0.08, 0.26), cream, 0, GALLERY.y - 0.02, GALLERY.z + 0.05);
    world(box(WALL_X * 2, 0.03, 0.2), gilt, 0, GALLERY.y - 0.6, GALLERY.z + 0.03);
    frame(mat4(0, 0, GALLERY.z + 0.115))(sign("gallery", 6.4), signMaterial, 0, GALLERY.y - 0.3, 0);
    // Piers under the front edge.
    for (const x of [-7.4, -3.1, 3.1, 7.4]) {
      world(wbox(0.5, GALLERY.y - 0.6, 0.5), cream, x, (GALLERY.y - 0.6) / 2, GALLERY.z - 0.2, undefined, undefined, { hit: true });
      world(wbox(0.58, 0.3, 0.58), green, x, 0.15, GALLERY.z - 0.2);
    }
    // Balustrade: turned balusters between pedestals; a globe on a brass standard on four of them.
    const pedestals = [-9.3, -6.2, -3.1, 0, 3.1, 6.2, 9.3], baluster = lathe([[0, 0], [0.085, 0], [0.085, 0.06], [0.05, 0.1], [0.095, 0.3], [0.08, 0.42], [0.045, 0.62], [0.07, 0.7], [0.07, 0.78], [0, 0.78]], 8);
    world(wbox(WALL_X * 2, 0.1, 0.24), cream, 0, GALLERY.y + 0.05, GALLERY.z - 0.1);
    world(wbox(WALL_X * 2, 0.12, 0.26), cream, 0, GALLERY.y + 0.94, GALLERY.z - 0.1, undefined, undefined, { hit: true });
    pedestals.forEach((x, i) => {
      world(wbox(0.34, 1.06, 0.34), cream, x, GALLERY.y + 0.53, GALLERY.z - 0.1);
      if (i < pedestals.length - 1) for (let k = 1; k <= 10; k += 1) world(baluster, cream, x + 0.17 + (k * (3.1 - 0.34)) / 11, GALLERY.y + 0.1, GALLERY.z - 0.1);
      if (Math.abs(x) === 3.1 || Math.abs(x) === 6.2) {
        world(lathe([[0, 0], [0.1, 0], [0.1, 0.03], [0.03, 0.08], [0.02, 0.5], [0.04, 0.56], [0.02, 0.62], [0.02, 0.9], [0.1, 0.98], [0.12, 1.04], [0, 1.04]], 12), brass, x, GALLERY.y + 1.06, GALLERY.z - 0.1);
        world(new THREE.SphereGeometry(0.2, 16, 12), opal, x, GALLERY.y + 2.26, GALLERY.z - 0.1);
        lamp([x, GALLERY.y + 2.26, GALLERY.z - 0.1], WARM.clone().multiplyScalar(2.2), 6);
      }
    });
    // End wall: windows onto the night either side of the clock, bronze doors under the gallery.
    for (const side of sides) {
      const E = endFrame(side * 5.25);
      E(archBand(CLERESTORY.width, CLERESTORY.spring, 0.2, 0.09, CLERESTORY.sill), ceilingPlaster);
      E(archBand(CLERESTORY.width - 0.02, CLERESTORY.spring, 0.07, 0.13, CLERESTORY.sill), bronze);
      E(wbox(CLERESTORY.width + 0.7, 0.14, 0.2), cream, 0, CLERESTORY.sill - 0.07, 0.1);
      E(remap(archPane(CLERESTORY.width, CLERESTORY.spring, CLERESTORY.sill), night, side > 0 ? "clerestoryB" : "clerestoryA"), nightGlass, 0, 0, 0.02);
      E(wbox(0.3, 0.42, 0.16), cream, 0, CLERESTORY.spring + CLERESTORY.width / 2 + 0.12, 0.08);
      E(remap(new THREE.PlaneGeometry(2.6, 3.3), signs, "doors"), signMaterial, 0, 1.65, 0.06);
      E(wbox(2.9, 0.2, 0.14), cream, 0, 3.4, 0.07);
    }
    // The great clock: a lit opal dial in a bronze case, in a frame of its own.
    const E = endFrame(0);
    E(wbox(3.0, 3.0, 0.08), cream, 0, CLOCK.y, 0.04);
    for (const [w, h, x, y] of [[3.1, 0.07, 0, 1.52], [3.1, 0.07, 0, -1.52], [0.07, 3.1, 1.52, 0], [0.07, 3.1, -1.52, 0]]) E(box(w, h, 0.1), gilt, x, CLOCK.y + y, 0.06);
    E(lathe([[CLOCK.r, 0], [CLOCK.r + 0.16, 0], [CLOCK.r + 0.16, 0.12], [CLOCK.r + 0.06, 0.2], [CLOCK.r, 0.14], [CLOCK.r, 0]], 48).rotateX(Math.PI / 2), bronze, 0, CLOCK.y, 0.08);
    E(remap(new THREE.CircleGeometry(CLOCK.r, 48), signs, "greatDial"), dialGlow, 0, CLOCK.y, 0.2);
    E(cyl(0.09, 0.06, "z", 14), bronze, 0, CLOCK.y, 0.27);
  }

  // The wall clock in the west aisle, over a bench.
  const WALL_CLOCK = { z: BAYS[5], y: 3.25, r: 0.42 };
  {
    const W = wallFrame(-1, WALL_CLOCK.z);
    W(lathe([[0, 0], [WALL_CLOCK.r + 0.1, 0], [WALL_CLOCK.r + 0.1, 0.07], [WALL_CLOCK.r + 0.04, 0.13], [WALL_CLOCK.r, 0.09], [WALL_CLOCK.r, 0.04], [0, 0.04]], 36).rotateX(Math.PI / 2), bronze, 0, WALL_CLOCK.y, 0);
    W(remap(new THREE.CircleGeometry(WALL_CLOCK.r, 36), signs, "wallDial"), dialGlow, 0, WALL_CLOCK.y, 0.045);
    W(sign("enquiries", 1.3), signMaterial, 0, 2.3, 0.012);
    W(sign("radiator", 1.5).scale(1, 0.5, 1), signMaterial, 0, 0.66, 0.055);
    // Bench: a marble slab on bronze feet.
    W(wbox(2.0, 0.07, 0.42), cream, 1.9, 0.44, 0.24, undefined, undefined, { hit: true });
    for (const x of [1.1, 2.7]) W(wbox(0.08, 0.41, 0.36, 1.2), bronze, x, 0.205, 0.24);
  }

  // Extract grilles in two coffers of the east aisle, a fan turning behind each (see "Motion").
  const VENTS: V3[] = [[5.98, CEILING, BAYS[4] - 1.4], [5.98, CEILING, BAYS[5] + 1.4]];
  for (const [x, y, z] of VENTS) {
    world(remap(new THREE.PlaneGeometry(1.3, 1.8).rotateX(Math.PI / 2), signs, "vent"), signMaterial, x, y - 0.04, z);
    world(new THREE.PlaneGeometry(1.3, 1.8).rotateX(Math.PI / 2), voidDark, x, y - 0.005, z);
    for (const [w, d, dx, dz] of [[1.42, 0.07, 0, 0.93], [1.42, 0.07, 0, -0.93], [0.07, 1.8, 0.68, 0], [0.07, 1.8, -0.68, 0]]) world(box(w, 0.05, d), bronze, x + dx, y - 0.03, z + dz);
  }

  // Ceiling fans on long rods under two of the cross beams.
  const FANS = [{ z: GRID[3], y: 7.9, speed: 1.5 }, { z: GRID[5], y: 7.9, speed: -1.25 }];
  for (const fan of FANS) {
    world(cyl(0.025, SOFFIT - fan.y - 0.1, "y", 8), brass, 0, (SOFFIT + fan.y + 0.1) / 2, fan.z);
    world(lathe([[0.025, 0], [0.12, -0.02], [0.1, -0.1], [0.03, -0.14]], 12), brass, 0, SOFFIT, fan.z);
  }

  world(rbox(0.56, 0.5, 0.9, 0.03), bronze, 9.3, 5.4, -12.65, undefined, undefined, { hit: true });
  world(cyl(0.34, 0.08, "y", 20), bronze, 9.28, 5.14, -12.65);
  for (const z of [-13.0, -12.3]) world(box(0.04, 0.5, 0.04), brass, 9.02, 5.4, z, undefined, undefined, { fine: true });

  // Globes: an opal ball under a brass cap on a long rod, one a bay down each aisle.
  const globe = new THREE.SphereGeometry(0.3, 20, 14);
  const failing = { place: new THREE.Vector3(PENDANT.failSide * PENDANT.x, PENDANT.y, BAYS[PENDANT.failBay]) };
  for (const side of sides) BAYS.forEach((z, k) => {
    const x = side * PENDANT.x, rodTop = SOFFIT + 0.2, rodFoot = PENDANT.y + 0.42;
    world(cyl(0.022, rodTop - rodFoot, "y", 8), brass, x, (rodTop + rodFoot) / 2, z, undefined, undefined, { shadow: true });
    world(lathe([[0.02, 0], [0.16, -0.02], [0.13, -0.08], [0.04, -0.14], [0.02, -0.14]], 12), brass, x, rodTop, z);
    world(lathe([[0.03, 0.44], [0.07, 0.4], [0.09, 0.3], [0.2, 0.26], [0.22, 0.2], [0.2, 0.19]], 14), brass, x, PENDANT.y, z);
    world(lathe([[0.001, -0.42], [0.03, -0.38], [0.05, -0.32], [0.1, -0.28]], 10), brass, x, PENDANT.y, z);
    if (side === PENDANT.failSide && k === PENDANT.failBay) return;
    world(globe, opal, x, PENDANT.y, z, undefined, undefined, { shadow: true });
  });
  const failingGlobe = new THREE.Mesh(globe, opalFailing);
  failingGlobe.position.copy(failing.place);
  scene.add(failingGlobe);

  flush();

  // ---- Furnace, light ------------------------------------------------------------------------------
  // The furnace's flue turns into the wall through a bronze breeching under the clerestory.
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 1.8);
  scene.add(new THREE.HemisphereLight(0xd8dce6, 0x4a3c28, 0.2));
  const sun = kit.sunLight({ color: 0xe4edf6, intensity: 3.4, toSun: TO_SUN, extent: 31, distance: 50, near: 6, far: 96, radius: 2.4 });
  // Real lamps, a handful: the strongroom's own light and the beam it throws out through its door, and
  // one behind the tellers' grilles.
  const vaultLight = new THREE.PointLight(0xffe2b8, 44, 11, 2);
  vaultLight.position.set(-13.7, 3.1, VAULT.z);
  const tellerLight = new THREE.PointLight(0xffc98a, 12, 8, 2);
  tellerLight.position.set(11.3, 3.1, (TELLER.z0 + TELLER.z1) / 2);
  const vaultBeam = new THREE.SpotLight(0xffdcae, 300, 15, 0.2, 0.6, 2);
  vaultBeam.position.set(-15.2, 3.4, VAULT.z);
  vaultBeam.target.position.set(-7.0, 0, VAULT.z);
  scene.add(vaultLight, tellerLight, vaultBeam, vaultBeam.target);
  const fills: THREE.PointLight[] = [vaultLight, tellerLight];
  const glows: Glow[] = [
    { position: new THREE.Vector3(-9.9, 2.0, VAULT.z), color: new THREE.Color(1, 0.8, 0.52).multiplyScalar(0.55) },
    { position: new THREE.Vector3(9.3, 1.7, (TELLER.z0 + TELLER.z1) / 2), color: new THREE.Color(1, 0.7, 0.4).multiplyScalar(0.8) },
  ];

  sunLight = sun;

  // ---- Motion --------------------------------------------------------------------------------------
  const cuePlace = new THREE.Vector3(), voice = { gain: 1, pitch: 1 };
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => {
    if (!options.cue) return;
    voice.gain = gain; voice.pitch = pitch;
    options.cue(name, cuePlace.set(x, y, z), voice);
  };

  // Hands: the three movements of the time lock, the wall clock and the great clock, drawn as one instanced mesh.
  type Hand = { pivot: THREE.Matrix4; length: number; width: number; angle: (seconds: number) => number };
  /** A second hand that jumps once a second and quivers as it lands. */
  const stepped = (per: number, offset: number) => (seconds: number) => {
    const whole = Math.floor(seconds), part = seconds - whole;
    return ((whole + offset + 1 - Math.exp(-part * 26) * Math.cos(part * 70)) / per) * Math.PI * 2;
  };
  const START = 23 * 3600 + 41 * 60;
  const doorFace = (x: number, y: number, proud: number) => mat4(-8.82 + proud, VAULT.y + y, VAULT.doorZ - x, [0, Math.PI / 2, 0]);
  const handList: Hand[] = [];
  [-0.22, 0, 0.22].forEach((x, i) => {
    handList.push({ pivot: doorFace(x, 0.6, 0.088), length: 0.07, width: 0.008, angle: () => (0.86 - i * 0.013) * Math.PI * 2 });
    handList.push({ pivot: doorFace(x, 0.6, 0.091), length: 0.088, width: 0.004, angle: stepped(60, i * 17) });
  });
  const wallClockFace = mat4(-WALL_X + 0.052, WALL_CLOCK.y, WALL_CLOCK.z, [0, Math.PI / 2, 0]);
  handList.push({ pivot: wallClockFace, length: 0.24, width: 0.03, angle: (seconds) => ((START + seconds) / 43200) * Math.PI * 2 });
  handList.push({ pivot: wallClockFace.clone().multiply(mat4(0, 0, 0.004)), length: 0.36, width: 0.02, angle: (seconds) => ((START + seconds) / 3600) * Math.PI * 2 });
  // The great clock is a slave dial: its minute hand is thrown forward every half minute.
  const halfMinutes = (seconds: number) => Math.floor((START + seconds) / 30);
  const greatFace = mat4(0, CLOCK.y, END_Z + 0.23);
  handList.push({ pivot: greatFace, length: 0.62, width: 0.085, angle: (seconds) => ((halfMinutes(seconds) * 30) / 43200) * Math.PI * 2 });
  handList.push({ pivot: greatFace.clone().multiply(mat4(0, 0, 0.012)), length: 0.98, width: 0.055, angle: (seconds) => {
    const since = (START + seconds) / 30 - halfMinutes(seconds), settle = 1 - Math.exp(-since * 30 * 9) * Math.cos(since * 30 * 22);
    return ((halfMinutes(seconds) - 1 + settle) * 30 / 3600) * Math.PI * 2;
  } });
  const hands = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.38, 0), new THREE.MeshBasicMaterial({ color: 0x0d0a06 }), handList.length);
  hands.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hands.frustumCulled = false;
  scene.add(hands);
  kit.mirrorHidden.push(hands);
  const handMatrix = new THREE.Matrix4(), handTurn = new THREE.Matrix4(), handScale = new THREE.Matrix4();

  // Fans: four timber blades on a brass hub.
  const fanRotors = FANS.map((fan) => {
    const parts: THREE.BufferGeometry[] = [lathe([[0, 0.1], [0.07, 0.1], [0.15, 0.04], [0.16, -0.04], [0.09, -0.1], [0.03, -0.14], [0, -0.14]], 14)];
    for (let i = 0; i < 4; i += 1) {
      const blade = new THREE.BoxGeometry(1.05, 0.012, 0.17).translate(0.72, 0, 0).applyMatrix4(mat4(0, 0, 0, [0.22, 0, 0])).applyMatrix4(mat4(0, 0, 0, [0, (i * Math.PI) / 2, 0]));
      const arm = new THREE.BoxGeometry(0.2, 0.02, 0.05).translate(0.22, 0, 0).applyMatrix4(mat4(0, 0, 0, [0, (i * Math.PI) / 2, 0]));
      parts.push(blade, arm);
    }
    const rotor = new THREE.Mesh(mergeGeometries(parts.map((part) => { const flat = part.index ? part.toNonIndexed() : part; flat.deleteAttribute("uv"); return flat; }))!, bronze);
    rotor.position.set(0, fan.y, fan.z);
    rotor.userData.walkThrough = true;
    scene.add(rotor);
    return rotor;
  });
  // Extract fans: three dark blades crossing the faint light of the roof void.
  const ventRotors = VENTS.map(([x, y, z]) => {
    const parts = [0, 1, 2].map((i) => new THREE.CircleGeometry(0.62, 5, i * 2.094, 0.8).rotateX(Math.PI / 2));
    const rotor = new THREE.Mesh(mergeGeometries(parts)!, new THREE.MeshBasicMaterial({ color: 0x05070a }));
    rotor.position.set(x, y - 0.02, z);
    scene.add(rotor);
    kit.mirrorHidden.push(rotor);
    return rotor;
  });

  // The card on the stand hangs on two chains and stirs when a shot goes off near it.
  const card = new THREE.Group();
  card.position.set(CARD.x, CARD.y, CARD.z);
  card.rotation.y = CARD.yaw;
  {
    const front = sign("closed", 0.42).translate(0, -0.31, 0.004), back = sign("closed", 0.42).rotateY(Math.PI).translate(0, -0.31, -0.004);
    const face = new THREE.Mesh(mergeGeometries([front, back])!, signMaterial);
    const links = mergeGeometries([-0.17, 0.17].map((x) => new THREE.BoxGeometry(0.006, 0.1, 0.006).translate(x, -0.05, 0)))!;
    card.add(face, new THREE.Mesh(links, brass));
    card.children.forEach((child) => { child.userData.walkThrough = true; });
  }
  scene.add(card);
  const cardSwing = life.sway(card, { amplitude: 0.05, period: 1.25, axis: "x", creak: "chainRattle", damping: 0.06 });

  // The failing globe, and everything else on the same tired mains.
  life.flicker((level: number) => { lampUniforms.vaultLive.value.x = level; }, "tube", { at: [failing.place.x, failing.place.y, failing.place.z], rate: 0.8 });

  // Pigeons that came in by a broken pane roost on the string course and a window sill of the west wall.
  const sills = [BAYS[1], BAYS[2], BAYS[3]];
  life.birds("pigeon", {
    perches: [
      // The string course, where they show against the plaster, and one window sill.
      { from: [-WALL_X + 0.14, STRING + 0.275, 3.1], to: [-WALL_X + 0.14, STRING + 0.275, -1.4] },
      { from: [-WALL_X + 0.14, STRING + 0.275, -8.8], to: [-WALL_X + 0.14, STRING + 0.275, -13.3] },
      { from: [-WALL_X + 0.165, CLERESTORY.sill + 0.005, sills[1] - 1.3], to: [-WALL_X + 0.165, CLERESTORY.sill + 0.005, sills[1] + 1.3] },
    ],
    count: 4,
    roam: { x: [-4.5, 4.5], y: [7.4, 9.4], z: [-22, 3] },
    from: [0, 9, -27],
    wary: 2.4,
  });
  // The library's birds leave straight away from what frightened them and know nothing of walls, so a shot
  // anywhere in the hall is told to them as coming from behind their wall: they break out over the floor.
  const frightAt = new THREE.Vector3();
  const startle = (at: THREE.Vector3, loudness: number) => {
    if (loudness < 0.3) return;
    life.startle(frightAt.set(-14, CLERESTORY.sill, sills[1]), 0.3);
    if (at.distanceTo(card.position) < 14) cardSwing.kick(0.5 * loudness, at.x - card.position.x, at.z - card.position.z);
  };
  // Dust standing in the light under the glass.
  life.drift("motes", { volume: { x: [-LAY.half, LAY.half], y: [0.4, 9.5], z: [-24, 8] }, count: 150, colors: [0xdfe8f6] });

  let lastHalf = -1;
  kit.updates.push((now) => {
    const seconds = now / 1000;
    // The lamps breathe a little with the mains.
    lampUniforms.vaultLive.value.y = 0.965 + 0.035 * Math.sin(seconds * 5.3) * Math.sin(seconds * 0.7);
    opalFailing.color.setRGB(1, 0.8, 0.52).multiplyScalar(2.4 * lampUniforms.vaultLive.value.x);
    handList.forEach((hand, i) => {
      handMatrix.copy(hand.pivot).multiply(handTurn.makeRotationZ(-hand.angle(seconds))).multiply(handScale.makeScale(hand.width, hand.length, 0.004));
      hands.setMatrixAt(i, handMatrix);
    });
    hands.instanceMatrix.needsUpdate = true;
    const half = halfMinutes(seconds);
    if (lastHalf >= 0 && half !== lastHalf) say("relayClack", 0, CLOCK.y, END_Z + 0.4, 0.9, 0.82);
    lastHalf = half;
    fanRotors.forEach((rotor, i) => { rotor.rotation.y = seconds * FANS[i].speed; });
    ventRotors.forEach((rotor, i) => { rotor.rotation.y = seconds * (i ? -2.1 : 2.6); });
  });

  // ---- Air -----------------------------------------------------------------------------------------
  kit.motes({ count: 520, x: 9, y: [0.3, 10.5], z: [-25, 8], color: 0xe6eefc, opacity: 0.26 });

  const probe = new THREE.Vector3();
  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows,
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: 0x050506, fog: 0x14110c, fogDensity: high ? 0.006 : 0.011,
      haze: new THREE.Color(0.03, 0.03, 0.03), hazeDensity: 0.03, hazeCeiling: 10.8, hazeFade: 1.4,
      environmentIntensity: 1.05, exposure: 1, far: 120,
    },
    // Lit where a ray up to the lamps passes through the glass of the lay light and misses its beams.
    sunlitAt(point) {
      const t = (CEILING - point.y) / TO_SUN.y;
      if (t <= 0) return 0;
      probe.copy(point).addScaledVector(TO_SUN, t);
      if (Math.abs(probe.x) > LAY.half) return 0;
      for (const { z0, z1 } of layBays) if (probe.z > z0 && probe.z < z1) return 1;
      return 0;
    },
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle, struck: life.struck };
}

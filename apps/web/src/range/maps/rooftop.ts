import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial } from "../pbr";
import {
  BRAND, STRIKE_ORANGE, canvasTexture, createKit, iBeam, softBox, softDiscTexture, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import { createProps, type PropItem, type PropKind } from "../props";
import { createWind } from "../wind";
import { createTrees, type TreeItem, type TreeKind } from "../trees";
import { createLife } from "../life";

// Nightline: the roof of a tower after rain, forty storeys above a city that
// does not exist anywhere else.
//
// Lighting model: a cool moon, matched to the one in the sky photograph, is the
// only shadow-casting light. Sodium lamps, neon and wall bulkheads carry the
// range itself; the wet deck mirrors them, and a probe of the lit roof stands in
// for the sky as image-based light. The city beyond the parapet is one family of
// meshes drawn by one shader that puts a room behind every window.

/** Direction to the moon in `rooftop_night-2k.hdr`. */
const TO_MOON = new THREE.Vector3(0.08, 0.76, -0.64).normalize();
const ROOF = { x0: -16, x1: 16, z0: -33, z1: 15.2 };
const PLANT_TOP = 6.4;
const SCREEN_TOP = 5.2;

type V3 = [number, number, number];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Neon tube strokes on a 0.62 × 1 cell; bent glass, so every letter is a few polylines. */
const GLYPHS: Record<string, number[][][]> = {
  N: [[[0, 0], [0, 1], [0.62, 0], [0.62, 1]]],
  I: [[[0.31, 0], [0.31, 1]]],
  G: [[[0.6, 0.8], [0.46, 0.97], [0.2, 0.97], [0.04, 0.8], [0, 0.5], [0.04, 0.2], [0.2, 0.03], [0.46, 0.03], [0.62, 0.2], [0.62, 0.48], [0.36, 0.48]]],
  H: [[[0, 0], [0, 1]], [[0.62, 0], [0.62, 1]], [[0, 0.5], [0.62, 0.5]]],
  T: [[[0, 1], [0.62, 1]], [[0.31, 1], [0.31, 0]]],
  L: [[[0, 1], [0, 0], [0.62, 0]]],
  E: [[[0.62, 1], [0, 1], [0, 0], [0.62, 0]], [[0, 0.5], [0.5, 0.5]]],
  B: [[[0, 0], [0, 1], [0.38, 1], [0.54, 0.92], [0.58, 0.76], [0.54, 0.6], [0.38, 0.52], [0, 0.52]], [[0.38, 0.52], [0.56, 0.44], [0.62, 0.27], [0.56, 0.09], [0.4, 0], [0, 0]]],
  U: [[[0, 1], [0, 0.28], [0.06, 0.1], [0.2, 0], [0.42, 0], [0.56, 0.1], [0.62, 0.28], [0.62, 1]]],
  Y: [[[0, 1], [0.31, 0.48], [0.62, 1]], [[0.31, 0.48], [0.31, 0]]],
  Z: [[[0, 1], [0.62, 1], [0, 0], [0.62, 0]]],
  O: [[[0.31, 0], [0.12, 0.08], [0.02, 0.28], [0, 0.5], [0.02, 0.72], [0.12, 0.92], [0.31, 1], [0.5, 0.92], [0.6, 0.72], [0.62, 0.5], [0.6, 0.28], [0.5, 0.08], [0.31, 0]]],
};

/** A word as tube centre lines in metres, centred on the origin. */
function wordStrokes(word: string, height: number, pitch: number) {
  const strokes: number[][][] = [];
  [...word].forEach((letter, index) => {
    const x0 = (index - (word.length - 1) / 2) * pitch - 0.31 * height;
    for (const stroke of GLYPHS[letter] ?? []) strokes.push(stroke.map(([x, y]) => [x0 + x * height, (y - 0.5) * height]));
  });
  return strokes;
}

/** The spill of a tube sign on its backing board, drawn from the same strokes as the tubes. */
function haloTexture(strokes: number[][][], width: number, height: number, colour: string) {
  const px = 1024 / width;
  return canvasTexture(1024, Math.max(64, Math.round(height * px)), (context) => {
    context.fillStyle = "#000"; context.fillRect(0, 0, 1024, height * px);
    context.lineJoin = "round"; context.lineCap = "round"; context.strokeStyle = colour;
    for (const [line, blur, alpha] of [[0.2, 0.22, 0.5], [0.08, 0.08, 0.6]]) {
      context.lineWidth = line * px; context.shadowColor = colour; context.shadowBlur = blur * px; context.globalAlpha = alpha;
      for (const stroke of strokes) {
        context.beginPath();
        stroke.forEach(([x, y], i) => { const cx = (x + width / 2) * px, cy = (height / 2 - y) * px; if (i) context.lineTo(cx, cy); else context.moveTo(cx, cy); });
        context.stroke();
      }
    }
  });
}

/** Round falloff used as the alpha of painted light pools. */
function poolMask() {
  const texture = canvasTexture(128, 128, (context) => {
    context.fillStyle = "#000"; context.fillRect(0, 0, 128, 128);
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "#fff"); gradient.addColorStop(0.18, "#bdbdbd"); gradient.addColorStop(0.5, "#4a4a4a"); gradient.addColorStop(0.8, "#101010"); gradient.addColorStop(1, "#000");
    context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
  });
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/** Plates, notices and a chalk board: one sheet, cut up by `LABELS`. */
const LABELS = {
  plant: [0, 0, 512, 512], stair: [512, 0, 768, 384], volts: [1280, 0, 384, 512], hose: [0, 512, 512, 256], menu: [1664, 0, 384, 768],
  maker: [0, 768, 512, 192], harness: [512, 384, 768, 384], gas: [512, 768, 512, 256], edge: [1024, 768, 512, 256],
} as const;
function labelSheet() {
  return canvasTexture(2048, 1024, (context) => {
    context.fillStyle = "#111"; context.fillRect(0, 0, 2048, 1024);
    const sans = "'Helvetica Neue', Arial, sans-serif";
    const plate = (key: keyof typeof LABELS, fill: string, edge: string) => {
      const [x, y, w, h] = LABELS[key];
      context.fillStyle = fill; context.fillRect(x, y, w, h);
      context.strokeStyle = edge; context.lineWidth = 10; context.strokeRect(x + 14, y + 14, w - 28, h - 28);
      context.fillStyle = "rgba(0,0,0,.35)";
      for (const [cx, cy] of [[x + 34, y + 34], [x + w - 34, y + 34], [x + 34, y + h - 34], [x + w - 34, y + h - 34]]) { context.beginPath(); context.arc(cx, cy, 7, 0, Math.PI * 2); context.fill(); }
      return [x, y, w, h] as number[];
    };
    const text = (value: string, x: number, y: number, size: number, fill: string, weight = 700, align: CanvasTextAlign = "center", width?: number) => {
      context.font = `${weight} ${size}px ${sans}`; context.textAlign = align; context.textBaseline = "middle"; context.fillStyle = fill; context.fillText(value, x, y, width);
    };
    let [x, y, w, h] = plate("plant", "#d9a21c", "#15130f");
    text("PLANT ROOM", x + w / 2, y + 120, 64, "#15130f", 800); text("1.6", x + w / 2, y + 250, 170, "#15130f", 800);
    text("AUTHORISED PERSONNEL ONLY", x + w / 2, y + 368, 26, "#15130f", 700, "center", 440);
    text("sv_cheats 0 BEYOND THIS DOOR", x + w / 2, y + 414, 22, "#3a300f", 600, "center", 440); text("NOCLIP IS NOT A KEY", x + w / 2, y + 446, 22, "#3a300f", 600, "center", 440);
    [x, y, w, h] = plate("stair", "#0d6b46", "#e9f5ee");
    text("STAIR B", x + 250, y + 122, 104, "#f1fbf5", 800); text("DO NOT RUSH", x + 250, y + 228, 58, "#f1fbf5", 800, "center", 440);
    text("ROOF · LEVEL 64 · HOLD SHIFT", x + 250, y + 306, 26, "#c9ecd9", 600, "center", 440);
    context.strokeStyle = "#f1fbf5"; context.lineWidth = 16; context.lineCap = "round"; context.lineJoin = "round";
    context.beginPath(); context.moveTo(x + 560, y + 280); context.lineTo(x + 610, y + 230); context.lineTo(x + 650, y + 230); context.lineTo(x + 650, y + 180); context.lineTo(x + 690, y + 180); context.lineTo(x + 690, y + 130); context.stroke();
    context.beginPath(); context.arc(x + 585, y + 120, 22, 0, Math.PI * 2); context.fillStyle = "#f1fbf5"; context.fill();
    [x, y, w, h] = plate("volts", "#e8e4d8", "#b8231a");
    context.fillStyle = "#e0b21a"; context.beginPath(); context.moveTo(x + w / 2, y + 60); context.lineTo(x + w - 70, y + 290); context.lineTo(x + 70, y + 290); context.closePath(); context.fill();
    context.fillStyle = "#15130f"; context.beginPath(); context.moveTo(x + w / 2 + 14, y + 120); context.lineTo(x + w / 2 - 34, y + 205); context.lineTo(x + w / 2, y + 205); context.lineTo(x + w / 2 - 16, y + 268); context.lineTo(x + w / 2 + 36, y + 180); context.lineTo(x + w / 2 + 2, y + 180); context.closePath(); context.fill();
    text("DANGER", x + w / 2, y + 350, 72, "#b8231a", 800); text("100 IN 1 HIT", x + w / 2, y + 418, 52, "#15130f", 800, "center", 330); text("DAMAGE TAKEN FROM \"BUSBAR\"", x + w / 2, y + 460, 17, "#15130f", 600, "center", 300);
    [x, y, w, h] = plate("hose", "#b3211a", "#f6ece6");
    text("IN CASE OF FIRE", x + w / 2, y + 62, 36, "#fff6f0", 800, "center", 440); text("HOLD W", x + w / 2, y + 132, 84, "#fff6f0", 800, "center", 440);
    text("NO CHECKING CORNERS · REGROUP AT SPAWN", x + w / 2, y + 202, 18, "#ffd9cf", 600, "center", 440);
    [x, y, w, h] = LABELS.menu as unknown as number[];
    context.fillStyle = "#16201c"; context.fillRect(x, y, w, h); context.strokeStyle = "#6b4a2a"; context.lineWidth = 22; context.strokeRect(x + 11, y + 11, w - 22, h - 22);
    const chalk = "'Marker Felt', 'Chalkduster', 'Comic Sans MS', cursive";
    const scrawl = (value: string, cy: number, size: number, fill: string) => { context.font = `${size}px ${chalk}`; context.textAlign = "center"; context.fillStyle = fill; context.fillText(value, x + w / 2, y + cy, w - 70); };
    scrawl("BUY MENU", 90, 66, "#f3efe2"); scrawl("~ freeze time only ~", 150, 30, "#e7b96a");
    // Drinks at prices a regular knows by heart; the asides are in the other chalk.
    let line = 240;
    for (const [drink, aside] of [["the AWP  ·  $4750", "in this economy?"], ["negev  ·  $1700", "nobody ever orders it"], ["flash, a shot  ·  $200", ""], ["smoke, on ice  ·  $300", ""], ["decoy cola  ·  $50", "sounds like the real thing"]]) {
      scrawl(drink, line, 36, aside ? "#f3efe2" : "#bfe6dc");
      if (aside) scrawl(aside, line + 40, 26, "#e7b96a");
      line += aside ? 110 : 70;
    }
    scrawl("last call 0:40", 706, 30, "#e7b96a");
    [x, y, w, h] = plate("maker", "#b9bdc0", "#30353a");
    text("FPS MAX AIR", x + 40, y + 62, 54, "#1d2226", 800, "left"); text("AHU-2  ·  COOLING  ·  SN 1337-64", x + 40, y + 112, 20, "#30353a", 600, "left"); text("300 fps  ·  5 ping  ·  0% loss  ·  0% choke", x + 40, y + 144, 20, "#30353a", 600, "left");
    [x, y, w, h] = plate("harness", "#1e4f8c", "#eef4fb");
    text("NO BOOSTING", x + w / 2, y + 120, 84, "#f4f8fd", 800); text("USE THE LADDER, NOT A TEAMMATE", x + w / 2, y + 220, 32, "#cfe0f3", 600); text("2 PERSONS MAX · FALL DAMAGE IS ON", x + w / 2, y + 290, 24, "#cfe0f3", 600);
    [x, y, w, h] = plate("gas", "#e8e4d8", "#1e7a4c");
    text("COMPRESSED SMOKE", x + w / 2, y + 95, 40, "#1e7a4c", 800); text("$300 · ONE PER PERSON · NO NAKED FLAME", x + w / 2, y + 165, 20, "#15130f", 600);
    [x, y, w, h] = plate("edge", "#e8e4d8", "#15130f");
    text("PEEKER'S ADVANTAGE", x + w / 2, y + 88, 40, "#15130f", 800); text("DOES NOT APPLY TO GRAVITY", x + w / 2, y + 148, 22, "#15130f", 600); text("KEEP BACK FROM THE PARAPET", x + w / 2, y + 186, 22, "#15130f", 600);
  });
}

/** Service windows of the plant room and the stair, four 512 px cells: frosted wired glass lit from inside. */
function serviceGlass() {
  return canvasTexture(1024, 1024, (context) => {
    const next = rng(909);
    for (let cell = 0; cell < 4; cell += 1) {
      const x = (cell % 2) * 512, y = Math.floor(cell / 2) * 512;
      context.save(); context.beginPath(); context.rect(x, y, 512, 512); context.clip(); context.translate(x, y);
      const warm = cell < 2;
      const glow = context.createRadialGradient(256, 150, 20, 256, 220, 420);
      glow.addColorStop(0, warm ? "#ffe2ae" : "#e2f2ff"); glow.addColorStop(0.5, warm ? "#e09a4c" : "#8fb6de"); glow.addColorStop(1, warm ? "#6e3a16" : "#2c4668");
      context.fillStyle = glow; context.fillRect(0, 0, 512, 512);
      context.filter = "blur(7px)"; context.fillStyle = "rgba(18,14,12,.6)";
      if (cell === 0) { for (const py of [150, 205, 330]) context.fillRect(0, py, 512, 22); context.fillRect(120, 150, 26, 362); context.beginPath(); context.arc(340, 216, 44, 0, Math.PI * 2); context.fill(); }
      if (cell === 1) { context.lineWidth = 20; context.strokeStyle = "rgba(18,14,12,.6)"; context.beginPath(); context.moveTo(-20, 470); context.lineTo(532, 150); context.stroke(); context.beginPath(); context.moveTo(-20, 360); context.lineTo(532, 40); context.stroke(); for (let b = 0; b < 9; b += 1) context.fillRect(20 + b * 60, 330 - b * 35, 9, 120); }
      if (cell === 2) { for (const cx of [40, 190, 350]) context.fillRect(cx, 170, 124, 342); context.fillStyle = "rgba(120,255,190,.8)"; for (let d = 0; d < 9; d += 1) context.fillRect(60 + (d % 3) * 150 + next() * 60, 210 + next() * 80, 9, 9); }
      if (cell === 3) { context.fillRect(60, 260, 400, 30); context.fillRect(90, 290, 20, 222); context.fillRect(410, 290, 20, 222); context.beginPath(); context.ellipse(256, 180, 90, 60, 0, 0, Math.PI * 2); context.fill(); }
      context.filter = "none";
      // Wire mesh in the glass and grime at the edges.
      context.strokeStyle = "rgba(20,18,16,.22)"; context.lineWidth = 1.5;
      for (let d = -512; d < 512; d += 22) { context.beginPath(); context.moveTo(d, 0); context.lineTo(d + 512, 512); context.stroke(); context.beginPath(); context.moveTo(d + 512, 0); context.lineTo(d, 512); context.stroke(); }
      const grime = context.createLinearGradient(0, 0, 0, 512);
      grime.addColorStop(0, "rgba(20,14,10,.1)"); grime.addColorStop(0.7, "rgba(20,14,10,.2)"); grime.addColorStop(1, "rgba(20,14,10,.75)");
      context.fillStyle = grime; context.fillRect(0, 0, 512, 512);
      context.restore();
    }
  });
}

/** A lit poster for a lemon soda: the can, a slice where the sun would be, and the oldest boast there is. */
function posterTexture() {
  return canvasTexture(2048, 1024, (context) => {
    const sans = "'Helvetica Neue', Arial, sans-serif";
    const sky = context.createLinearGradient(0, 0, 2048, 1024);
    sky.addColorStop(0, "#0b2e33"); sky.addColorStop(0.55, "#12565a"); sky.addColorStop(1, "#d9a51e");
    context.fillStyle = sky; context.fillRect(0, 0, 2048, 1024);
    // Rays, then the slice: rind, pith, flesh and the walls between its segments.
    context.save(); context.translate(1560, 520);
    for (let ray = 0; ray < 24; ray += 1) { context.rotate(Math.PI / 12); context.fillStyle = ray % 2 ? "rgba(255,236,150,.16)" : "rgba(255,236,150,.05)"; context.beginPath(); context.moveTo(0, 0); context.lineTo(2400, -327); context.lineTo(2400, 327); context.closePath(); context.fill(); }
    for (const [radius, fill] of [[330, "#f2c230"], [302, "#fff6c8"], [282, "#ffe45c"]] as Array<[number, string]>) { context.fillStyle = fill; context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); }
    context.strokeStyle = "#fff6c8"; context.lineWidth = 12; context.lineCap = "round";
    for (let segment = 0; segment < 10; segment += 1) { const a = segment * Math.PI / 5 + 0.2; context.beginPath(); context.moveTo(Math.cos(a) * 30, Math.sin(a) * 30); context.lineTo(Math.cos(a) * 282, Math.sin(a) * 282); context.stroke(); }
    // The can, its yellow label, and a lemon with its leaf above it.
    context.rotate(-0.16);
    const can = context.createLinearGradient(-170, 0, 170, 0);
    can.addColorStop(0, "#0c3b3d"); can.addColorStop(0.3, "#1f8c84"); can.addColorStop(0.55, "#8ef5e3"); can.addColorStop(0.75, "#1f8c84"); can.addColorStop(1, "#0a2c2e");
    context.fillStyle = can; context.beginPath(); context.roundRect(-170, -380, 340, 760, 46); context.fill();
    context.fillStyle = "#c9d2d4"; context.beginPath(); context.roundRect(-150, -410, 300, 50, 18); context.fill(); context.beginPath(); context.roundRect(-150, 360, 300, 44, 18); context.fill();
    context.fillStyle = "#ffe45c"; context.fillRect(-170, -120, 340, 250);
    context.textAlign = "center"; context.textBaseline = "middle";
    context.font = `800 100px ${sans}`; context.fillStyle = "#0b2e33"; context.fillText("EZ PZ", 0, -40, 300);
    context.font = `600 46px ${sans}`; context.fillStyle = "#0e5a5c"; context.fillText("LEMON · 330", 0, 60, 290);
    context.strokeStyle = "#ffe45c"; context.lineWidth = 14; context.lineJoin = "round";
    context.beginPath(); context.ellipse(-14, -246, 76, 52, -0.3, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(56, -290); context.quadraticCurveTo(100, -344, 126, -300); context.quadraticCurveTo(96, -270, 56, -290); context.stroke();
    context.restore();
    context.textAlign = "left"; context.textBaseline = "alphabetic";
    context.fillStyle = "#fff4dc"; context.font = `800 330px ${sans}`; context.fillText("EZ PZ", 104, 440, 1040);
    context.fillStyle = "#ffe45c"; context.font = `300 126px ${sans}`; context.fillText("LEMON SQUEEZY", 112, 600, 1040);
    context.fillStyle = "#fff4dc"; context.font = `600 62px ${sans}`; context.fillText("EASY PEASY LEMON SODA", 118, 760, 1000);
    context.fillStyle = "rgba(255,244,220,.75)"; context.font = `500 40px ${sans}`; context.fillText("Squeezed fresh every round.  Zero recoil.  gg wp.", 118, 850, 1000);
    context.strokeStyle = "rgba(255,244,220,.9)"; context.lineWidth = 8; context.strokeRect(40, 40, 1968, 944);
  });
}

/** Cable drum, axis on Y, standing on one flange: boarded flanges and a barrel in timber, hub plates and tie-rod ends in steel. */
function spoolGeometry() {
  const TILE = 1.1;
  // Cylinder UVs run 0..1 round the wall and across each cap: rescale both to metres so the boards keep their width.
  const part = (radius: number, height: number, sides: number, y: number, open = false) => {
    const geometry = new THREE.CylinderGeometry(radius, radius, height, sides, 1, open), uv = geometry.attributes.uv, wall = (sides + 1) * 2;
    for (let i = 0; i < uv.count; i += 1) {
      if (i < wall) uv.setXY(i, uv.getX(i) * Math.PI * 2 * radius / TILE, uv.getY(i) * height / TILE);
      else uv.setXY(i, uv.getX(i) * radius * 2 / TILE, uv.getY(i) * radius * 2 / TILE);
    }
    geometry.translate(0, y, 0);
    return geometry;
  };
  const merge = (parts: THREE.BufferGeometry[]) => { const merged = mergeGeometries(parts); parts.forEach((piece) => piece.dispose()); return merged; };
  const steel: THREE.BufferGeometry[] = [];
  for (const [y, out] of [[0, -1], [0.8, 1]]) {
    steel.push(part(0.13, 0.012, 20, y + out * 0.006), part(0.05, 0.05, 12, y + out * 0.025));
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      for (const [radius, height, sides] of [[0.045, 0.006, 12], [0.024, 0.022, 6]]) steel.push(part(radius, height, sides, y + out * height / 2).translate(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45));
    }
  }
  return { timber: merge([part(0.62, 0.06, 40, 0.03), part(0.62, 0.06, 40, 0.77), part(0.3, 0.68, 24, 0.4, true)]), steel: merge(steel) };
}

// ---- The city beyond the parapet ---------------------------------------------
//
// Everything past the roof edge is one family of meshes drawn by one shader. A building is a
// handful of boxes. Each wall is a single quad that knows its bay and storey size; the fragment
// shader cuts the windows into it, shades the reveal, traces a room behind every pane (floor,
// ceiling with its fittings, back wall, furniture on a plane half way in), hangs blinds and
// curtains, reflects the dusk sky in the glass, and lets the whole thing sink into haze that
// warms toward the streets. Ledges, piers, fins, parapets and roof plant are real boxes in the
// same mesh, so a block costs one draw call however much is on it.

/** Street level, in metres below the deck. */
const STREET = -46;
const BRICK = 0, CONCRETE = 1, PLASTER = 2, METAL = 3;
/**
 * How a quad is drawn. `kind`: 0 wall, 1 punched windows, 2 curtain wall, 3 ribbon windows,
 * 4 open floors of a building site, 5 wet roof, 6 emitter, 8 carriageway, 9 the ground far below.
 */
type Face = { kind: number; cell: [number, number]; win: [number, number, number, number]; look: [number, number, number, number]; tint: V3; seed: number };
type Lay = { wash?: V3 | [V3, V3]; mirror?: boolean; base?: number; skip?: string };

const CITY_VERTEX = /* glsl */`
  attribute vec4 aCell;
  attribute vec4 aWin;
  attribute vec4 aLook;
  attribute vec3 aTint;
  attribute vec3 aWash;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vFaceNormal;
  varying vec4 vCell;
  varying vec4 vWin;
  varying vec4 vLook;
  varying vec3 vTint;
  varying vec3 vWash;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = uv; vCell = aCell; vWin = aWin; vLook = aLook; vTint = aTint; vWash = aWash;
    vWorld = position;
    vFaceNormal = normal;
    vec4 mvPosition = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

/** Haze shared by every material of the city: the scene's fog, warmer and brighter toward the streets. */
const CITY_HAZE = /* glsl */`
  #ifdef USE_FOG
    float hazeDepth = fogDensity * vFogDepth;
    float hazeAmount = 1.0 - exp(-hazeDepth * hazeDepth);
    vec3 hazeColour = fogColor * (1.0 + vec3(1.7, 0.8, 0.25) * exp(-(vWorld.y - (${STREET.toFixed(1)})) / 24.0));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColour, hazeAmount);
  #endif
`;

const CITY_FRAGMENT = /* glsl */`
  uniform sampler2D wallMap;
  #ifndef CITY_LITE
  uniform sampler2D wallNormalMap;
  #endif
  uniform float time;
  uniform float skyGain;
  uniform vec3 moonDir;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vFaceNormal;
  varying vec4 vCell;
  varying vec4 vWin;
  varying vec4 vLook;
  varying vec3 vTint;
  varying vec3 vWash;
  #include <common>
  #include <fog_pars_fragment>

  const float STREET = ${STREET.toFixed(1)};

  float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  vec3 h23(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yzz) * q.zyx); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  // The dusk in the sky photograph, measured: rose at the horizon, violet overhead, the afterglow behind the firing line.
  vec3 skyColor(vec3 d) {
    float e = d.y;
    vec3 c = mix(vec3(0.200, 0.105, 0.125), vec3(0.235, 0.140, 0.215), smoothstep(0.02, 0.40, e));
    c = mix(c, vec3(0.200, 0.160, 0.320), smoothstep(0.35, 0.95, e));
    float glow = max(0.0, dot(normalize(d.xz + vec2(1e-4)), vec2(-0.55, 0.83)));
    c += vec3(0.17, 0.055, 0.03) * glow * glow * (1.0 - smoothstep(0.0, 0.5, e));
    c = mix(vec3(0.085, 0.052, 0.05), c, smoothstep(-0.10, 0.03, e));
    return c * skyGain;
  }

  // What reaches a surface out there: sky from above, the streets' sodium from below, the moon.
  vec3 ambientLight(vec3 n, vec3 p, float cityGain) {
    float up = n.y * 0.5 + 0.5;
    float clear = smoothstep(STREET, 40.0, p.y);
    vec3 sky = vec3(0.21, 0.16, 0.30) * skyGain * (0.3 + 0.7 * up) * (0.4 + 0.6 * clear);
    vec3 street = vec3(1.0, 0.55, 0.23) * 0.6 * cityGain * (1.0 - 0.8 * up) * exp(-(p.y - STREET) / 40.0);
    vec3 moon = vec3(0.22, 0.29, 0.58) * max(dot(n, moonDir), 0.0) * skyGain;
    return sky + street + moon;
  }

  void main() {
    vec3 N = normalize(vFaceNormal);
    vec3 toEye = cameraPosition - vWorld;
    float range = length(toEye);
    vec3 V = -toEye / range;
    int kind = int(vCell.z + 0.5);
    float seed = vCell.w;
    float cityGain = mix(0.3, 1.0, skyGain);
    float pxm = max(max(length(vec2(dFdx(vUv.x), dFdy(vUv.x))), length(vec2(dFdx(vUv.y), dFdy(vUv.y)))), 1e-4);
    vec2 tuv = vUv * vLook.w;
    vec3 tex = mix(vec3(0.5), texture2D(wallMap, tuv).rgb, step(1e-4, vLook.w));
    vec3 T = abs(N.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), N));
    vec3 B = cross(N, T);
    #ifndef CITY_LITE
      vec3 bump = texture2D(wallNormalMap, tuv).xyz * 2.0 - 1.0;
      float bumpK = step(1e-4, vLook.w) * (1.0 - smoothstep(45.0, 130.0, range));
      vec3 Np = normalize(N + (T * bump.x + B * bump.y) * 0.9 * bumpK);
    #else
      vec3 Np = N;
    #endif
    vec3 amb = ambientLight(N, vWorld, cityGain) + vWash * cityGain;
    vec3 col;

    if (kind == 6) {
      // Emitters: tubes, lamps, beacons that blink.
      float gain = vLook.x;
      if (vLook.y > 0.0) gain *= 0.06 + 0.94 * pow(max(0.0, sin(time * vLook.y + vLook.z)), 8.0);
      col = vTint * gain * cityGain;
    } else if (kind == 5) {
      // Roofs: dark felt, wet, puddled; they mirror the sky at a shallow angle.
      vec2 w = vWorld.xz;
      float puddle = smoothstep(0.5, 0.68, vnoise(w * 0.21 + seed));
      float lap = 1.0 - 0.3 * smoothstep(0.46, 0.5, abs(fract(w.x / 1.1 + seed) - 0.5));
      vec3 alb = vTint * (0.7 + 0.6 * vnoise(w * 1.9 + 7.0)) * (1.0 - 0.35 * puddle) * lap;
      float c = max(dot(-V, N), 0.0);
      float F = mix(0.025, 0.07, puddle) + pow(1.0 - c, 5.0) * mix(0.3, 0.95, puddle);
      col = alb * amb + skyColor(reflect(V, N)) * F;
    } else if (kind == 8) {
      // A carriageway under sodium lamps: uv is (across, along) in metres.
      float lane = vCell.x;
      float lx = abs(fract(vUv.x / lane + 0.5) - 0.5) * lane;
      float mark = (1.0 - smoothstep(0.07, 0.09 + pxm * 1.5, lx)) * step(0.45, fract(vUv.y / 12.0));
      float pa = (fract(vUv.y / vCell.y) - 0.5) * vCell.y / 9.0;
      float pool = exp(-pa * pa);
      vec3 lampC = vec3(1.0, 0.62, 0.3) * (0.3 + 2.2 * pool) * cityGain;
      vec3 alb = vec3(0.075, 0.075, 0.082) * (0.75 + 0.5 * vnoise(vWorld.xz * 3.0)) + vec3(0.32) * mark;
      float c = max(dot(-V, N), 0.0);
      float wet = smoothstep(0.35, 0.7, vnoise(vWorld.xz * vec2(0.6, 0.16)));
      float F = 0.03 + pow(1.0 - c, 5.0) * mix(0.3, 0.9, wet);
      col = alb * (amb + lampC) + (skyColor(reflect(V, N)) + vec3(1.0, 0.62, 0.3) * (0.25 + 1.6 * pool) * wet * cityGain) * F;
    } else if (kind == 9) {
      // The district floor, only ever seen far off and edge on: lit streets between dark blocks.
      vec2 w = vWorld.xz;
      vec2 sx = abs(mod(w + vec2(17.0, 31.0), 86.0) - 43.0);
      float road = max(smoothstep(31.0, 33.5, sx.x), smoothstep(31.0, 33.5, sx.y));
      vec2 cellId = floor(w / 6.0);
      float flow = step(0.72, h21(vec2(floor((w.x + w.y) / 9.0 - time * 1.3), cellId.x - cellId.y)));
      vec3 lot = vec3(0.016, 0.014, 0.018) + vec3(1.0, 0.72, 0.42) * 0.9 * step(0.975, h21(cellId));
      vec3 lane = vec3(0.34, 0.19, 0.075) + vec3(1.0, 0.85, 0.7) * 1.4 * flow;
      col = mix(lot, lane, road) * cityGain;
    } else {
      // Walls.
      float big = vnoise(vUv * 0.11 + seed * 3.7);
      float streak = vnoise(vec2(vUv.x * 1.3 + seed, vUv.y * 0.07));
      vec3 albedo = tex * vTint * (0.72 + 0.4 * big) * (0.8 + 0.3 * streak);
      vec3 ambW = ambientLight(Np, vWorld, cityGain) + vWash * cityGain;
      float cosV = max(dot(-V, Np), 0.0);
      vec3 sheen = skyColor(reflect(V, Np)) * (0.015 + 0.3 * pow(1.0 - cosV, 5.0));
      col = albedo * ambW + sheen * (kind == 0 ? 0.4 + 2.2 * vLook.x : 0.6);

      if (kind >= 1 && kind <= 4) {
        vec2 cell = vCell.xy;
        vec2 gcell = vUv / cell;
        vec2 id = floor(gcell);
        vec2 p = (gcell - id) * cell;
        float detail = 1.0 - smoothstep(0.08, 0.4, pxm);
        vec3 d = vec3(dot(V, T), V.y, min(dot(V, N), -0.04));
        vec2 lo = vec2(vWin.x, vWin.y), hi = vec2(cell.x - vWin.x, vWin.z);
        vec2 cover = smoothstep(lo - pxm, lo + pxm, p) * (1.0 - smoothstep(hi - pxm, hi + pxm, p));
        float opening = cover.x * cover.y;
        // The ray crosses the reveal before it meets the glass: step in, and see whether it lands on the pane.
        vec2 entry = clamp(p, lo, hi);
        vec2 p2 = entry + d.xy * (vWin.w / -d.z);
        vec2 landed = step(lo, p2) * step(p2, hi);
        float onGlass = landed.x * landed.y;
        p2 = clamp(p2, lo, hi);

        // Who is in: rooms keep one state across a group of bays, floors have moods, towers have zones.
        float group = kind == 2 ? 3.0 : kind == 3 ? 2.0 : kind == 4 ? 4.0 : 1.0;
        float gx = floor(id.x / group);
        float roomW = group * cell.x;
        vec2 rid = vec2(gx, id.y) + seed * vec2(13.7, 5.3);
        vec3 r1 = h23(rid), r2 = h23(rid + 19.19);
        float mood = h21(vec2(id.y, seed * 7.1));
        float zone = h21(vec2(floor(id.y / 3.0) + 0.5, seed * 3.3));
        float litP = vLook.x * (0.5 + zone);
        litP = mood > 0.93 ? 0.97 : mood < 0.13 ? litP * 0.1 : litP;
        float lit = step(r1.x + 0.035 * sin(time * 0.045 + r2.y * 6.283), litP);
        float tsel = clamp(r1.y + (vLook.y - 0.5), 0.0, 1.0);
        vec3 C = mix(vec3(0.60, 0.80, 1.0), vec3(1.0, 0.88, 0.70), smoothstep(0.15, 0.45, tsel));
        C = mix(C, vec3(1.0, 0.60, 0.27), smoothstep(0.5, 0.9, tsel));
        if (r2.x > 0.975) C = r2.z > 0.5 ? vec3(0.3, 1.0, 0.82) : vec3(1.0, 0.28, 0.62);
        float L = lit * mix(0.4, 1.7, r1.z * r1.z);
        // Somebody is watching television in the dark.
        if (lit < 0.5 && r2.x < 0.07 && kind == 1) {
          C = vec3(0.45, 0.62, 1.0);
          L = 0.16 * (0.55 + 0.45 * vnoise(vec2(time * 2.3 + r2.y * 40.0, r2.z * 9.0)));
        }
        L *= cityGain;

        // The room: a box behind the pane.
        float yf = 0.05, yc = max(hi.y + 0.03, cell.y - 0.45);
        float deep = kind == 4 ? 11.0 : mix(4.2, 7.5, r2.y);
        vec3 ro = vec3((id.x - gx * group) * cell.x + p2.x, p2.y, 0.0);
        vec3 rd = d;
        rd.x = abs(rd.x) < 1e-3 ? 1e-3 : rd.x;
        rd.y = abs(rd.y) < 1e-3 ? 1e-3 : rd.y;
        float tx = ((rd.x > 0.0 ? roomW : 0.0) - ro.x) / rd.x;
        float ty = ((rd.y > 0.0 ? yc : yf) - ro.y) / rd.y;
        float tz = deep / -rd.z;
        float t = min(tz, min(tx, ty));
        vec3 hit = ro + rd * t;
        vec3 paint = kind == 4 ? vec3(0.4, 0.39, 0.37) : mix(vec3(0.80, 0.76, 0.69), vec3(0.52, 0.60, 0.63), step(0.7, r2.z));
        vec3 sa = paint * 0.9;
        float fitting = 0.0;
        if (t == tz) {
          sa = paint;
          float doorX = (0.18 + 0.64 * r2.x) * roomW;
          sa = mix(sa, paint * 0.3, step(abs(hit.x - doorX), 0.46) * step(hit.y, 2.12));
          float artX = fract(doorX / roomW + 0.45) * roomW;
          float art = step(abs(hit.x - artX), 0.55) * step(abs(hit.y - 1.55), 0.4) * step(0.4, r2.y);
          sa = mix(sa, mix(vec3(0.12, 0.2, 0.28), vec3(0.5, 0.2, 0.12), r1.z), art);
          if (kind >= 2) sa *= 0.78 + 0.22 * step(0.5, fract(hit.x / 1.2));
        } else if (t == ty) {
          if (rd.y > 0.0) {
            sa = vec3(0.8);
            if (kind == 2 || kind == 3) {
              vec2 grid = fract(vec2(hit.x / 1.5, -hit.z / 2.4)) - 0.5;
              fitting = step(abs(grid.x), 0.11) * step(abs(grid.y), 0.27);
            } else if (kind == 1) {
              fitting = step(length(vec2(hit.x - roomW * 0.5, hit.z + deep * 0.5)), 0.24);
            } else {
              fitting = step(length(vec2(hit.x - roomW * (0.2 + 0.6 * r2.x), hit.z + 1.6)), 0.2);
            }
          } else {
            sa = mix(vec3(0.2, 0.15, 0.11), vec3(0.2, 0.21, 0.23), step(0.5, r1.y));
          }
        }
        float dl = distance(hit, vec3(roomW * 0.5, yc - 0.1, -deep * 0.5));
        float irr = 0.2 + 1.1 / (1.0 + 0.28 * dl * dl);
        vec3 leak = amb * (kind == 4 ? 0.7 : 0.22) * exp(hit.z / 3.0);
        vec3 room = sa * (C * L * irr + leak) + C * fitting * lit * 5.5 * cityGain;
        #ifndef CITY_LITE
          // Furniture and people, on a plane part way in, so they slide against the back wall as you move.
          float tm = (0.42 * deep) / -rd.z;
          if (tm < t && detail > 0.01) {
            vec3 m = ro + rd * tm;
            float shade = 0.0;
            for (int i = 0; i < 3; i++) {
              vec3 r = h23(rid + float(i) * 7.7 + 3.3);
              float cx = (float(i) + 0.25 + 0.5 * r.x) * roomW / 3.0;
              shade = max(shade, step(0.3, r.z) * step(abs(m.x - cx), mix(0.35, 0.8, r.y)) * step(m.y - yf, mix(0.7, 1.15, r.z)));
              float px = cx + (r.z - 0.5) * 0.9, tall = step(0.72, r.y);
              shade = max(shade, tall * step(length(vec2(m.x - px, m.y - yf - 1.58)), 0.12));
              shade = max(shade, tall * step(abs(m.x - px), 0.2 - 0.06 * step(1.0, m.y - yf)) * step(m.y - yf, 1.44));
            }
            room = mix(room, vec3(0.07, 0.06, 0.055) * (C * L * 0.6 + leak), shade);
          }
        #endif

        // Blinds and curtains hang at the glass.
        float oh = hi.y - lo.y;
        float blind = kind == 4 ? 0.0 : r2.x < 0.1 ? 1.0 : r2.x < 0.5 ? r2.y * r2.y * 0.9 : 0.0;
        float slat = mix(0.5, 0.5 + 0.5 * sin(p2.y * 125.0), detail * clamp(0.03 / pxm, 0.0, 1.0));
        vec3 blindC = vec3(0.72, 0.68, 0.6) * (C * L * 0.4 + amb * 0.5) * (0.7 + 0.5 * slat);
        vec3 inside = mix(room, blindC, step(hi.y - blind * oh, p2.y));
        if (kind == 1) {
          float cw = step(0.45, r2.z) * (0.12 + 0.2 * r1.y) * (hi.x - lo.x);
          float onCurtain = max(step(p2.x, lo.x + cw), step(hi.x - cw, p2.x)) * step(0.001, cw);
          vec3 cloth = mix(vec3(0.55, 0.2, 0.16), vec3(0.2, 0.3, 0.42), r1.x) * (0.75 + 0.25 * sin(p2.x * 60.0) * detail);
          inside = mix(inside, cloth * (C * L * 0.3 + amb * 0.35), onCurtain);
        }
        inside = mix(paint * (C * L * 0.45 + amb * 0.05), inside, detail);

        // Glass: every pane sits a little out of true, so each takes its own piece of the sky.
        float cosG = max(dot(-V, N), 0.0);
        vec3 pr = h23(id + seed * 3.1);
        vec3 Ng = normalize(N + (T * (pr.x - 0.5) + B * (pr.y - 0.5)) * 0.03);
        vec3 refl = skyColor(reflect(V, Ng));
        float F0 = kind == 2 ? 0.2 : 0.07;
        float F = F0 + (1.0 - F0) * pow(1.0 - cosG, 5.0);
        vec3 glass = kind == 4 ? inside : inside * (kind == 2 ? vTint : vec3(0.92)) * (1.0 - F) + refl * F;

        // Frames, a meeting rail and a glazing bar on sashes.
        float fw = kind == 1 ? 0.06 : kind == 3 ? 0.045 : 0.035;
        float edge = min(min(p2.x - lo.x, hi.x - p2.x), min(p2.y - lo.y, hi.y - p2.y));
        float bars = 1.0 - smoothstep(fw - pxm, fw + pxm, edge);
        if (kind == 1) {
          bars = max(bars, 1.0 - smoothstep(0.025 - pxm, 0.025 + pxm, abs(p2.y - (lo.y + oh * 0.52))));
          bars = max(bars, (1.0 - smoothstep(0.02 - pxm, 0.02 + pxm, abs(p2.x - cell.x * 0.5))) * step(1.6, hi.x - lo.x));
        }
        if (kind == 4) bars = 0.0;
        vec3 solid = kind == 2 ? vec3(0.09, 0.095, 0.1) : albedo;
        vec3 barC = (kind == 1 ? vec3(0.42, 0.40, 0.36) : vec3(0.05, 0.055, 0.06)) * (amb + C * L * 0.06) + refl * 0.04;
        vec3 pane = mix(glass, barC, bars);
        pane = mix(solid * (amb * 0.4 + C * L * 0.12), pane, onGlass);

        // What the wall around the opening is made of.
        vec3 wallC = col;
        if (kind == 1) {
          float inX = step(lo.x - 0.09, p.x) * step(p.x, hi.x + 0.09);
          float sill = inX * step(lo.y - 0.12, p.y) * step(p.y, lo.y) * detail;
          float lintel = inX * step(hi.y, p.y) * step(p.y, hi.y + 0.22) * detail;
          float drip = inX * step(p.y, lo.y - 0.12) * smoothstep(lo.y - 1.3, lo.y - 0.12, p.y) * vnoise(vec2(vUv.x * 7.0, vUv.y * 0.5)) * detail;
          vec3 a1 = mix(albedo, vec3(0.34, 0.33, 0.31) * (0.6 + 0.8 * tex.g), sill) * (1.0 - 0.22 * lintel) * (1.0 - 0.5 * drip);
          wallC = a1 * ambW + sheen * 0.6;
        } else if (kind == 2) {
          // Spandrels: back-painted glass in the same grid, capped with aluminium.
          wallC = vTint * 0.03 * amb + refl * (0.09 + 0.91 * pow(1.0 - cosG, 5.0)) * 0.85;
          float cap = 1.0 - smoothstep(0.03 - pxm, 0.03 + pxm, min(p.x, cell.x - p.x));
          cap = max(cap, 1.0 - smoothstep(0.025 - pxm, 0.025 + pxm, min(abs(p.y - lo.y), abs(p.y - hi.y))));
          wallC = mix(wallC, vec3(0.09, 0.095, 0.1) * amb + refl * 0.08, cap);
        } else if (kind == 3) {
          float stain = step(p.y, lo.y) * vnoise(vec2(vUv.x * 5.0, vUv.y * 0.4)) * smoothstep(lo.y - 1.0, lo.y, p.y);
          wallC = albedo * (1.0 - 0.4 * stain) * ambW + sheen * 0.6;
        }
        vec2 away = max(max(lo - p, p - hi), 0.0);
        wallC += solid * C * L * 0.1 * exp(-length(away) * 3.5);
        col = mix(wallC, pane, opening);

        if (kind == 4) {
          // Edge protection: debris netting on some bays, orange mesh and rails on some floors.
          float net = step(0.78, h21(id + seed * 9.1));
          vec3 netC = vec3(0.02, 0.085, 0.06) * (amb * 1.5 + C * L * 0.3) * (0.8 + 0.2 * sin(p.x * 40.0) * sin(p.y * 40.0) * detail);
          col = mix(col, netC, net * opening * 0.86);
          float rails = max(1.0 - smoothstep(0.02, 0.03 + pxm, abs(p.y - 1.1)), 1.0 - smoothstep(0.02, 0.03 + pxm, abs(p.y - 0.6)));
          col = mix(col, vec3(0.75, 0.26, 0.04) * amb * 1.4, step(0.5, mood) * (1.0 - net) * opening * max(rails, step(p.y, 0.18)));
        }

        // Past the point where a pane is a pixel, show the facade's average instead of its sparkle.
        float farK = smoothstep(0.8, 2.0, pxm);
        vec2 share = (hi - lo) / cell;
        vec3 mean = mix(wallC, mix(vec3(0.7, 0.84, 1.0), vec3(1.0, 0.72, 0.42), vLook.y) * vLook.x * 0.3 * cityGain + refl * F0, share.x * share.y);
        col = mix(col, mean, farK);
      }
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    ${CITY_HAZE}
  }
`;

/** The sign and the video wall share the city's haze but draw a picture. */
const SCREEN_VERTEX = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mvPosition = viewMatrix * vec4(vWorld, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const SCREEN_FRAGMENT = /* glsl */`
  uniform sampler2D map;
  uniform float time;
  uniform float skyGain;
  uniform float gain;
  uniform vec2 pitch;
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    // Six spots in rotation, two columns of three on the sheet; each one wipes in from the left over the last.
    float turn = time / 7.0, spot = mod(floor(turn), 6.0), phase = fract(turn);
    float wipe = smoothstep(0.93, 1.0, phase);
    float shown = vUv.x < wipe ? mod(spot + 1.0, 6.0) : spot;
    float column = floor(shown / 3.0);
    vec2 uv = vec2((column + clamp(vUv.x, 0.001, 0.999)) / 2.0, (2.0 - (shown - column * 3.0) + vUv.y) / 3.0);
    vec3 c = texture2D(map, uv, -0.5).rgb;
    c *= 1.0 + 0.5 * smoothstep(0.012, 0.0, abs(vUv.x - wipe)) * step(0.001, wipe);
    // The diodes resolve when you are near enough, and merge when you are not.
    vec2 cellUv = vUv * pitch;
    vec2 led = abs(fract(cellUv) - 0.5);
    float merged = clamp(max(fwidth(cellUv.x), fwidth(cellUv.y)) * 1.6, 0.0, 1.0);
    c *= mix(smoothstep(0.5, 0.28, max(led.x, led.y)) * 1.3, 1.0, merged);
    gl_FragColor = vec4(c * gain * mix(0.3, 1.0, skyGain), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    ${CITY_HAZE}
  }
`;

/** The haze that closes the horizon: opaque over the sky photograph's own foreground, gone a hand above it. */
const HORIZON_FRAGMENT = /* glsl */`
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    float rise = (vWorld.y - 1.6) / 600.0;
    float cover = 1.0 - smoothstep(0.03, 0.2, rise);
    gl_FragColor = vec4(vec3(0.0), cover * cover * (3.0 - 2.0 * cover));
    #ifdef USE_FOG
      gl_FragColor.rgb = fogColor * (1.0 + vec3(1.7, 0.8, 0.25) * exp(-(vWorld.y - (${STREET.toFixed(1)})) / 24.0));
    #endif
  }
`;

/** Collects the quads of the city and bakes them into one mesh per wall texture. */
function createCity(sheets: Array<{ map: THREE.Texture; normalMap: THREE.Texture }>, lite: boolean) {
  const uniforms = { time: { value: 0 }, skyGain: { value: 1 }, moonDir: { value: TO_MOON.clone() } };
  const fogUniforms = () => ({ fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogNear: { value: 1 }, fogFar: { value: 2000 } });
  const materials = sheets.map((sheet, index) => new THREE.ShaderMaterial({
    name: `city-${["brick", "concrete", "plaster", "metal"][index]}`,
    uniforms: { ...fogUniforms(), ...uniforms, wallMap: { value: sheet.map }, wallNormalMap: { value: sheet.normalMap } },
    defines: lite ? { CITY_LITE: 1 } : {},
    vertexShader: CITY_VERTEX,
    fragmentShader: CITY_FRAGMENT,
    fog: true,
  }));
  const STRIDE = 26, ZERO: V3 = [0, 0, 0];
  const quads: Array<{ sheet: number; mirror: boolean; at: number; data: Float32Array }> = [];
  // The frame buildings are described in: a turn about the vertical, then an offset.
  let fc = 1, fs = 0, fx = 0, fz = 0;
  const world = (x: number, y: number, z: number): V3 => [fc * x + fs * z + fx, y, -fs * x + fc * z + fz];
  const at = (x: number, z: number, turn: number, build: () => void) => {
    const keep = [fc, fs, fx, fz];
    const origin = world(x, 0, z), c = Math.cos(turn), s = Math.sin(turn);
    [fc, fs] = [fc * c - fs * s, fc * s + fs * c];
    fx = origin[0]; fz = origin[2];
    build();
    [fc, fs, fx, fz] = keep;
  };
  /** One quad from world-space corners given bottom-left, bottom-right, top-right, top-left as seen from outside. */
  const emit = (sheet: number, face: Face, corners: V3[], uvs: number[][], bay: number, lay: Lay, normals?: V3[], washes?: V3[]) => {
    const [a, b, c] = corners;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz) || 1;
    const normal: V3 = [nx / length, ny / length, nz / length];
    const data = new Float32Array(STRIDE * 4), wash = lay.wash;
    for (let i = 0; i < 4; i += 1) {
      const k = i * STRIDE;
      data.set(corners[i], k); data.set(normals ? normals[i] : normal, k + 3); data.set(uvs[i], k + 6);
      data[k + 8] = bay; data[k + 9] = face.cell[1]; data[k + 10] = face.kind; data[k + 11] = face.seed;
      data.set(face.win, k + 12); data.set(face.look, k + 16); data.set(face.tint, k + 20);
      data.set(washes ? washes[i] : !wash ? ZERO : typeof wash[0] === "number" ? wash as V3 : (wash as [V3, V3])[i < 2 ? 0 : 1], k + 23);
    }
    const cx = (corners[0][0] + corners[2][0]) / 2, cy = (corners[0][1] + corners[2][1]) / 2, cz = (corners[0][2] + corners[2][2]) / 2;
    quads.push({ sheet, mirror: lay.mirror ?? true, at: Math.hypot(cx, cy - 1.6, cz + 9), data });
  };
  /** A wall from (ax, az) to (bx, bz), left to right as seen from outside, with whole bays and floors that line up at `y1`. */
  const wall = (sheet: number, face: Face, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, lay: Lay = {}) => {
    const run = Math.hypot(bx - ax, bz - az), bays = Math.max(1, Math.round(run / face.cell[0]));
    const base = lay.base ?? y1 - Math.ceil((y1 - y0) / face.cell[1] - 1e-6) * face.cell[1];
    const a0 = world(ax, y0, az), b0 = world(bx, y0, bz);
    const u0 = face.kind === 0 ? (a0[0] + a0[2]) * 0.731 : 0;
    emit(sheet, face, [a0, b0, world(bx, y1, bz), world(ax, y1, az)], [[u0, y0 - base], [u0 + run, y0 - base], [u0 + run, y1 - base], [u0, y1 - base]], run / bays, lay);
  };
  /** A horizontal surface, facing up or down. A pair of washes runs from the +z edge to the -z edge of one facing up. */
  const plate = (sheet: number, face: Face, x0: number, z0: number, x1: number, z1: number, y: number, up = true, lay: Lay = {}) => {
    const corners = up ? [world(x0, y, z1), world(x1, y, z1), world(x1, y, z0), world(x0, y, z0)] : [world(x0, y, z0), world(x1, y, z0), world(x1, y, z1), world(x0, y, z1)];
    emit(sheet, face, corners, corners.map((corner) => [corner[0], corner[2]]), face.cell[0], lay);
  };
  /** Light fallen on a roof: a fan of the roof's own surface, brightest in the middle. */
  const pool = (sheet: number, face: Face, x: number, z: number, y: number, radius: number, colour: V3, lay: Lay = {}) => {
    const sides = 12, centre = world(x, y, z);
    for (let i = 0; i < sides; i += 2) {
      const rim = [0, 1, 2].map((k) => { const angle = (i + k) / sides * Math.PI * 2; return world(x + Math.sin(angle) * radius, y, z + Math.cos(angle) * radius); });
      const corners = [centre, rim[0], rim[1], rim[2]];
      emit(sheet, face, corners, corners.map((corner) => [corner[0], corner[2]]), face.cell[0], { mirror: false, ...lay }, undefined, [colour, ZERO, ZERO, ZERO]);
    }
  };
  const one = (wash: Lay["wash"], end: number) => wash && typeof wash[0] !== "number" ? (wash as [V3, V3])[end] : wash;
  /** A box of one material. `skip` drops faces: n s e w for -z +z +x -x, t and b for top and bottom. */
  const slab = (sheet: number, face: Face, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, lay: Lay = {}) => {
    const skip = lay.skip ?? "";
    if (!skip.includes("s")) wall(sheet, face, x0, z1, x1, z1, y0, y1, lay);
    if (!skip.includes("n")) wall(sheet, face, x1, z0, x0, z0, y0, y1, lay);
    if (!skip.includes("e")) wall(sheet, face, x1, z1, x1, z0, y0, y1, lay);
    if (!skip.includes("w")) wall(sheet, face, x0, z0, x0, z1, y0, y1, lay);
    if (!skip.includes("t")) plate(sheet, face, x0, z0, x1, z1, y1, true, { ...lay, wash: one(lay.wash, 1) });
    if (!skip.includes("b")) plate(sheet, face, x0, z0, x1, z1, y0, false, { ...lay, wash: one(lay.wash, 0) });
  };
  /** A building volume: windowed walls on four sides and a roof. */
  const mass = (sheet: number, face: Face, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, lay: Lay & { roof?: Face | null } = {}) => {
    slab(sheet, face, x0, x1, y0, y1, z0, z1, { ...lay, skip: `${lay.skip ?? ""}tb` });
    if (lay.roof) plate(sheet, lay.roof, x0, z0, x1, z1, y1, true, { mirror: lay.mirror });
  };
  /** A round or tapered drum of `sides` flat-shaded or smooth panels, optionally capped. */
  const tube = (sheet: number, face: Face, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, lay: Lay & { cap?: Face | null; smooth?: boolean } = {}) => {
    const lean = (r0 - r1) / (y1 - y0), seg = 2 * Math.PI * Math.max(r0, r1) / sides;
    const bays = Math.max(1, Math.round(seg / face.cell[0]));
    const base = lay.base ?? y1 - Math.ceil((y1 - y0) / face.cell[1] - 1e-6) * face.cell[1];
    const spot = (angle: number, r: number, y: number) => world(cx + Math.sin(angle) * r, y, cz + Math.cos(angle) * r);
    const out = (angle: number): V3 => { const n = world(Math.sin(angle), 0, Math.cos(angle)), l = Math.hypot(1, lean); return [(n[0] - fx) / l, lean / l, (n[2] - fz) / l]; };
    for (let i = 0; i < sides; i += 1) {
      const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
      emit(sheet, face, [spot(a0, r0, y0), spot(a1, r0, y0), spot(a1, r1, y1), spot(a0, r1, y1)],
        [[i * seg, y0 - base], [(i + 1) * seg, y0 - base], [(i + 1) * seg, y1 - base], [i * seg, y1 - base]], seg / bays, lay,
        lay.smooth === false ? undefined : [out(a0), out(a1), out(a1), out(a0)]);
      if (lay.cap) {
        const centre = world(cx, y1, cz), p0 = spot(a0, r1, y1), p1 = spot(a1, r1, y1);
        emit(sheet, lay.cap, [centre, p0, p1, centre], [centre, p0, p1, centre].map((corner) => [corner[0], corner[2]]), 1, { mirror: lay.mirror });
      }
    }
  };
  /** A square bar between two points: lattice members, rails, masts. */
  const bar = (sheet: number, face: Face, from: V3, to: V3, half: number, lay: Lay = {}) => {
    const a = new THREE.Vector3(...world(...from)), b = new THREE.Vector3(...world(...to));
    const along = b.clone().sub(a), run = along.length();
    along.divideScalar(run);
    const side = new THREE.Vector3().crossVectors(along, Math.abs(along.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const other = new THREE.Vector3().crossVectors(along, side);
    const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, o]) => side.clone().multiplyScalar(s * half).addScaledVector(other, o * half));
    for (let i = 0; i < 4; i += 1) {
      const p = ring[(i + 1) % 4], q = ring[i];
      const corners = [a.clone().add(p), a.clone().add(q), b.clone().add(q), b.clone().add(p)].map((v) => [v.x, v.y, v.z] as V3);
      emit(sheet, face, corners, [[0, 0], [half * 2, 0], [half * 2, run], [0, run]], 1, { mirror: false, ...lay });
    }
  };
  /**
   * Relief on one side of a box. `put(u0, u1, y0, y1, out)` stands a block `out` proud of that side,
   * with u running left to right as seen from outside.
   */
  const relief = (x0: number, x1: number, z0: number, z1: number, side: "n" | "s" | "e" | "w", build: (put: (sheet: number, face: Face, u0: number, u1: number, y0: number, y1: number, out: number, lay?: Lay) => void, run: number) => void) => {
    build((sheet, face, u0, u1, y0, y1, out, lay = {}) => {
      const o: Lay = { mirror: false, ...lay };
      if (side === "s") slab(sheet, face, x0 + u0, x0 + u1, y0, y1, z1, z1 + out, { ...o, skip: "n" });
      else if (side === "n") slab(sheet, face, x1 - u1, x1 - u0, y0, y1, z0 - out, z0, { ...o, skip: "s" });
      else if (side === "e") slab(sheet, face, x1, x1 + out, y0, y1, z1 - u1, z1 - u0, { ...o, skip: "w" });
      else slab(sheet, face, x0 - out, x0, y0, y1, z0 + u0, z0 + u1, { ...o, skip: "e" });
    }, side === "n" || side === "s" ? x1 - x0 : z1 - z0);
  };
  /** Bakes what has been described so far, nearest first so the far city is rejected by depth. */
  const bake = (scene: THREE.Scene, mirrorHidden: THREE.Object3D[], track: <T extends { dispose: () => void }>(item: T) => T) => {
    for (let sheet = 0; sheet < materials.length; sheet += 1) for (const mirror of [true, false]) {
      const list = quads.filter((quad) => quad.sheet === sheet && quad.mirror === mirror).sort((p, q) => p.at - q.at);
      if (!list.length) continue;
      const data = new Float32Array(list.length * STRIDE * 4), index = new Uint32Array(list.length * 6);
      list.forEach((quad, i) => {
        data.set(quad.data, i * STRIDE * 4);
        index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      });
      const buffer = new THREE.InterleavedBuffer(data, STRIDE), geometry = track(new THREE.BufferGeometry());
      const attribute = (name: string, size: number, offset: number) => geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, size, offset));
      attribute("position", 3, 0); attribute("normal", 3, 3); attribute("uv", 2, 6); attribute("aCell", 4, 8);
      attribute("aWin", 4, 12); attribute("aLook", 4, 16); attribute("aTint", 3, 20); attribute("aWash", 3, 23);
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -9), 900);
      const mesh = new THREE.Mesh(geometry, materials[sheet]);
      mesh.name = `city ${materials[sheet].name}${mirror ? "" : " detail"}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      if (!mirror) mirrorHidden.push(mesh);
    }
    quads.length = 0;
    materials.forEach(track);
  };
  return { uniforms, fogUniforms, at, wall, plate, pool, slab, mass, tube, bar, relief, bake, count: () => quads.length };
}

const SKY_INTENSITY = 1.1;

export function buildRooftop(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet } = kit;
  const metals = kit.metals();
  const props = createProps(kit);
  // One wind for the whole roof. It comes in over the billboard and the screen wall and crosses the range towards the plant
  // room, a little down range: the planters, the banner, everything that hangs, the steam and the litter all read it.
  const wind = createWind({ heading: 1.25, strength: 0.46, gustiness: 0.62 });
  const trees = createTrees(kit, { seed: 5, wind, sun: () => sun });
  const life = createLife(kit, options, { wind, seed: 5 });

  // ---- Materials -----------------------------------------------------------
  const asphalt = photoSet("/textures/asphalt_02-2k", 32 / 3.2, 48.2 / 3.2, false);
  const cast = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1);
  const brick = kit.wall("clinker", 2.6);
  const board = kit.wall("aggregate");
  const iron = photoSet("/textures/corrugated_iron_02-2k", 1, 1, false);
  const chequer = photoSet("/textures/metal_plate-2k", 1, 1, false);
  const concrete = new THREE.MeshStandardMaterial({ ...cast, color: 0x9a9ca2, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const formwork = new THREE.MeshStandardMaterial({ ...board, color: 0xa9abb2, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const brickwork = new THREE.MeshStandardMaterial({ ...brick, color: new THREE.Color(0.98, 0.88, 0.82), normalScale: new THREE.Vector2(1.3, 1.3), roughness: 1, metalness: 0, envMapIntensity: 0.7 });
  const cladding = new THREE.MeshStandardMaterial({ ...iron, color: 0x5d7890, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.85, metalness: 0.55, envMapIntensity: 1 });
  const sheeting = new THREE.MeshStandardMaterial({ ...iron, color: 0x9aa0a6, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.9, metalness: 0.5, envMapIntensity: 0.8 });
  const treadPlate = new THREE.MeshStandardMaterial({ ...chequer, color: 0x9aa3ac, normalScale: new THREE.Vector2(1.5, 1.5), roughness: 0.8, metalness: 0.6, envMapIntensity: 0.9 });
  const screenPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.075, 0.1, 0.125], 511, 0.55)), { envMapIntensity: 1 });
  const plantPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.3, 0.32, 0.33], 613, 0.45, 512)), { envMapIntensity: 1 });
  const tankPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.17, 0.085, 0.05], 717, 0.8, 512)), { envMapIntensity: 0.9 });
  const gasPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.06, 0.2, 0.2], 311, 0.8, 512)), { envMapIntensity: 1 });
  const amberPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.5, 0.24, 0.05], 811, 0.6, 512)), { envMapIntensity: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xa8cfe0, transparent: true, opacity: 0.17, roughness: 0.04, metalness: 0, envMapIntensity: 1.8, depthWrite: false });
  const flat = (colour: number, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color: colour, roughness, metalness, envMapIntensity: 0.8 });
  const redPaint = flat(0x9a1c14, 0.45, 0.2), rubber = flat(0x0d0e10, 0.7), soil = flat(0x17120e, 1), feather = flat(0x6c7078, 0.9), voidDark = flat(0x050608, 0.9);
  const emissive = (colour: number, gain: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(gain), toneMapped: false });
  const mintTube = emissive(BRAND, 2.6), amberTube = emissive(STRIKE_ORANGE, 3), sodium = emissive(0xffa758, 3), markerGlow = emissive(0xffb45a, 2.4);
  const coolLamp = emissive(0xcfe2ff, 2.6), bulb = emissive(0xffc98a, 2.8), ledGreen = emissive(0x4dff9a, 2.2), ledRed = emissive(0xff3b2a, 2.4), warmPanel = emissive(0xffb878, 0.55);
  const sheetMaterial = (texture: THREE.Texture, gain: number) => {
    texture.anisotropy = anisotropy;
    return new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(gain, gain, gain), toneMapped: false });
  };
  const labelMap = track(labelSheet());
  labelMap.anisotropy = anisotropy;
  const labels = new THREE.MeshStandardMaterial({ map: labelMap, emissiveMap: labelMap, emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.6 });
  const serviceGlow = sheetMaterial(track(serviceGlass()), 1.5);

  // ---- Batching ------------------------------------------------------------
  // Everything static is baked into one mesh per material (and per shadow / hit /
  // mirror flag), so the amount of dressing barely moves the draw-call count.
  type Opt = { r?: V3; s?: V3; shadow?: boolean; hit?: boolean; mirror?: boolean; uv?: number };
  type Batch = { material: THREE.Material; shadow: boolean; hit: boolean; mirror: boolean; items: Array<{ g: THREE.BufferGeometry; m: THREE.Matrix4; uv?: number }> };
  const batches = new Map<string, Batch>();
  const dummy = new THREE.Object3D(), UP = new THREE.Vector3(0, 1, 0);
  let parent: THREE.Matrix4 | null = null;
  const push = (material: THREE.Material, g: THREE.BufferGeometry, m: THREE.Matrix4, o: Opt = {}) => {
    const shadow = o.shadow ?? false, hit = o.hit ?? false, mirror = o.mirror ?? true;
    const key = `${material.uuid}|${shadow ? 1 : 0}${hit ? 1 : 0}${mirror ? 1 : 0}`;
    let batch = batches.get(key);
    if (!batch) { batch = { material, shadow, hit, mirror, items: [] }; batches.set(key, batch); }
    batch.items.push({ g, m: parent ? parent.clone().multiply(m) : m, uv: o.uv });
  };
  const add = (material: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, o: Opt = {}) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(...(o.r ?? [0, 0, 0]));
    dummy.scale.set(...(o.s ?? [1, 1, 1]));
    dummy.updateMatrix();
    push(material, g, dummy.matrix.clone(), o);
  };
  /** Builds in a local frame: origin at (x, y, z), turned about the vertical. */
  const frame = (x: number, y: number, z: number, turn: number, build: () => void) => {
    const previous = parent, m = new THREE.Matrix4().makeRotationY(turn).setPosition(x, y, z);
    parent = previous ? previous.clone().multiply(m) : m;
    build();
    parent = previous;
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1), unitBall = new THREE.SphereGeometry(1, 10, 8);
  const unitRods = new Map<number, THREE.CylinderGeometry>();
  const unitRod = (sides: number) => { let g = unitRods.get(sides); if (!g) { g = new THREE.CylinderGeometry(1, 1, 1, sides); unitRods.set(sides, g); } return g; };
  const AX: V3 = [0, 0, Math.PI / 2], AZ: V3 = [Math.PI / 2, 0, 0];
  const box = (material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, o: Opt = {}) => add(material, unitBox, x, y, z, { ...o, s: [w, h, d] });
  const cyl = (material: THREE.Material, radius: number, length: number, x: number, y: number, z: number, o: Opt = {}, sides = 12) => add(material, unitRod(sides), x, y, z, { ...o, s: [radius, length, radius] });
  const ball = (material: THREE.Material, radius: number, x: number, y: number, z: number, o: Opt = {}) => add(material, unitBall, x, y, z, { ...o, s: o.s ? [o.s[0] * radius, o.s[1] * radius, o.s[2] * radius] : [radius, radius, radius] });
  const rodA = new THREE.Vector3(), rodB = new THREE.Vector3(), rodQ = new THREE.Quaternion();
  /** A round bar between two points. */
  const rod = (material: THREE.Material, a: V3, b: V3, radius: number, o: Opt = {}, sides = 6) => {
    rodA.set(...a); rodB.set(...b);
    const length = rodA.distanceTo(rodB);
    rodQ.setFromUnitVectors(UP, rodB.clone().sub(rodA).divideScalar(length));
    push(material, unitRod(sides), new THREE.Matrix4().compose(rodA.clone().add(rodB).multiplyScalar(0.5), rodQ, new THREE.Vector3(radius, length, radius)), o);
  };
  /** A bent pipe or a slack cable through the given points. */
  const pipe = (material: THREE.Material, points: V3[], radius: number, o: Opt = {}, sides = 8, tension = 0.5) => {
    const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, "catmullrom", tension);
    push(material, new THREE.TubeGeometry(curve, points.length * 7, radius, sides), new THREE.Matrix4(), o);
  };
  const slack = (material: THREE.Material, a: V3, b: V3, sag: number, radius: number, o: Opt = {}) => {
    const points: V3[] = [];
    for (let i = 0; i <= 6; i += 1) { const t = i / 6; points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]); }
    pipe(material, points, radius, o, 5);
    return points;
  };
  /** A flat card showing one rectangle (in pixels) of a sheet. */
  const card = (material: THREE.Material, w: number, h: number, x: number, y: number, z: number, rect: readonly number[], sheet: [number, number], o: Opt = {}) => {
    const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv;
    const u0 = rect[0] / sheet[0], u1 = (rect[0] + rect[2]) / sheet[0], v1 = 1 - rect[1] / sheet[1], v0 = 1 - (rect[1] + rect[3]) / sheet[1];
    uv.setXY(0, u0, v1); uv.setXY(1, u1, v1); uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
    add(material, g, x, y, z, o);
  };
  const label = (key: keyof typeof LABELS, h: number, x: number, y: number, z: number, o: Opt = {}) => {
    const rect = LABELS[key];
    box(metals.darkMetal, h * rect[2] / rect[3] + 0.03, h + 0.03, 0.012, x, y, z - 0.008, o);
    card(labels, h * rect[2] / rect[3], h, x, y, z, rect, [2048, 1024], o);
  };
  // The kit's `place` and `instances`, baked: only see-through materials stay separate meshes.
  const place = (mesh: THREE.Mesh, x: number, y: number, z: number, shadow = true, hit = false) => {
    const material = mesh.material as THREE.Material;
    if (material.transparent) return kit.place(mesh, x, y, z, shadow, hit);
    add(material, mesh.geometry, x, y, z, { shadow, hit });
    return mesh;
  };
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], hit = true, shadow = true) => {
    if (material.transparent) { kit.instances(geometry, material, transforms, hit, shadow); return; }
    for (const transform of transforms) add(material, geometry, ...transform.position, { r: transform.rotation, s: transform.scale, hit, shadow });
  };
  const flush = () => {
    const p = new THREE.Vector3(), n = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
    for (const batch of batches.values()) {
      let vertices = 0, indices = 0;
      for (const { g } of batch.items) { vertices += g.attributes.position.count; indices += g.index ? g.index.count : g.attributes.position.count; }
      const position = new Float32Array(vertices * 3), normal = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2), index = new Uint32Array(indices);
      let v0 = 0, i0 = 0;
      for (const { g, m, uv: metres } of batch.items) {
        const gp = g.attributes.position, gn = g.attributes.normal, gu = g.attributes.uv;
        normalMatrix.getNormalMatrix(m);
        for (let i = 0; i < gp.count; i += 1) {
          p.fromBufferAttribute(gp, i).applyMatrix4(m);
          n.fromBufferAttribute(gn, i).applyMatrix3(normalMatrix).normalize();
          const at = v0 + i;
          position[at * 3] = p.x; position[at * 3 + 1] = p.y; position[at * 3 + 2] = p.z;
          normal[at * 3] = n.x; normal[at * 3 + 1] = n.y; normal[at * 3 + 2] = n.z;
          if (metres) {
            const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
            if (ax >= ay && ax >= az) { uv[at * 2] = p.z / metres; uv[at * 2 + 1] = p.y / metres; }
            else if (ay >= az) { uv[at * 2] = p.x / metres; uv[at * 2 + 1] = p.z / metres; }
            else { uv[at * 2] = p.x / metres; uv[at * 2 + 1] = p.y / metres; }
          } else if (gu) { uv[at * 2] = gu.getX(i); uv[at * 2 + 1] = gu.getY(i); }
        }
        if (g.index) for (let i = 0; i < g.index.count; i += 1) index[i0 + i] = v0 + g.index.getX(i);
        else for (let i = 0; i < gp.count; i += 1) index[i0 + i] = v0 + i;
        v0 += gp.count; i0 += g.index ? g.index.count : gp.count;
      }
      const geometry = track(new THREE.BufferGeometry());
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      const mesh = new THREE.Mesh(geometry, batch.material);
      mesh.castShadow = batch.shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      if (batch.hit) kit.shootable.push(mesh);
      if (!batch.mirror) kit.mirrorHidden.push(mesh);
    }
    batches.clear();
  };

  // Lamp halos and painted light pools stand in for lights the map does not spend.
  const halos: Array<{ at: V3; colour: THREE.Color; big: boolean }> = [];
  const halo = (at: V3, colour: number, gain = 1, big = false) => {
    const m = parent;
    const point = new THREE.Vector3(...at);
    if (m) point.applyMatrix4(m);
    halos.push({ at: [point.x, point.y, point.z], colour: new THREE.Color(colour).multiplyScalar(gain), big });
  };
  type Pool = { corners: [V3, V3, V3, V3]; colour: THREE.Color; uv: (p: V3) => [number, number] };
  const pools: { brick: Pool[]; plain: Pool[] } = { brick: [], plain: [] };
  const plainUv = (): [number, number] => [0, 0];

  // ---- Roof deck -----------------------------------------------------------
  const deck = new THREE.MeshStandardMaterial({ ...asphalt, color: 0x9498a2, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  const roofWidth = ROOF.x1 - ROOF.x0, roofDepth = ROOF.z1 - ROOF.z0, roofZ = (ROOF.z0 + ROOF.z1) / 2;
  const reflection = kit.floor(deck, { width: roofWidth, depth: roofDepth, z: roofZ }, {
    lane: new THREE.Color(BRAND).multiplyScalar(0.62),
    edge: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.7),
    markings: 0.85,
    wet: 0.06,
  });

  // ---- Fittings ------------------------------------------------------------
  // Each is built in a local frame: the wall face is z = 0 and +z points out of it.
  const sheetCell = (cell: number) => [(cell % 2) * 512 + 16, Math.floor(cell / 2) * 512 + 16, 480, 480];
  const wallPool = (kind: "brick" | "plain", x: number, y: number, w: number, h: number, colour: number, gain: number, uv: Pool["uv"] = plainUv) => {
    const m = parent ?? new THREE.Matrix4();
    const corners = [[x - w / 2, y + h / 2], [x + w / 2, y + h / 2], [x - w / 2, y - h / 2], [x + w / 2, y - h / 2]].map(([cx, cy]) => {
      const v = new THREE.Vector3(cx, cy, 0.014).applyMatrix4(m);
      return [v.x, v.y, v.z] as V3;
    }) as Pool["corners"];
    pools[kind].push({ corners, colour: new THREE.Color(colour).multiplyScalar(gain), uv });
  };
  const floorPool = (x: number, z: number, radius: number, colour: number, gain: number) => {
    pools.plain.push({ corners: [[x - radius, 0.016, z - radius], [x + radius, 0.016, z - radius], [x - radius, 0.016, z + radius], [x + radius, 0.016, z + radius]], colour: new THREE.Color(colour).multiplyScalar(gain), uv: plainUv });
  };
  /** Steel door in its frame: pressed panels, a wired vision panel, ironmongery, a kick plate. */
  const door = (sign: keyof typeof LABELS, signSide: number) => {
    for (const side of [-1, 1]) box(metals.darkMetal, 0.12, 2.3, 0.12, side * 0.6, 1.15, 0.05, { hit: true });
    box(metals.darkMetal, 1.32, 0.12, 0.12, 0, 2.3, 0.05, { hit: true });
    add(screenPaint, softBox(1.08, 2.24, 0.05, 0.012, 1.6), 0, 1.12, 0.05, { hit: true });
    for (const [y, h] of [[0.72, 0.8], [1.72, 0.7]]) for (const side of [-1, 1]) {
      box(metals.darkMetal, 0.02, h, 0.012, side * 0.41, y, 0.08);
      box(metals.darkMetal, 0.84, 0.02, 0.012, 0, y + side * h / 2, 0.08);
    }
    box(metals.darkMetal, 0.3, 0.5, 0.02, 0.2, 1.72, 0.082);
    card(serviceGlow, 0.24, 0.44, 0.2, 1.72, 0.094, [650, 60, 200, 360], [1024, 1024]);
    box(treadPlate, 1.0, 0.24, 0.008, 0, 0.17, 0.08, { uv: 0.6 });
    for (const y of [0.3, 1.12, 1.95]) cyl(metals.brushed, 0.016, 0.13, 0.53, y, 0.088, {}, 8);
    box(metals.brushed, 0.07, 0.2, 0.012, -0.42, 1.05, 0.082);
    rod(metals.brushed, [-0.42, 1.08, 0.08], [-0.42, 1.08, 0.135], 0.011);
    rod(metals.brushed, [-0.42, 1.08, 0.135], [-0.28, 1.08, 0.135], 0.011);
    cyl(metals.brushed, 0.016, 0.014, -0.42, 0.985, 0.09, { r: AZ }, 8);
    box(metals.darkMetal, 0.26, 0.06, 0.05, 0.3, 2.14, 0.1);
    rod(metals.brushed, [0.2, 2.13, 0.12], [-0.12, 2.2, 0.1], 0.007, {}, 4);
    box(metals.brushed, 1.1, 0.02, 0.16, 0, 0.01, 0.08);
    label(sign, 0.34, signSide * (0.86 + 0.17 * LABELS[sign][2] / LABELS[sign][3]), 1.62, 0.014);
  };
  /** Caged bulkhead lamp on a short conduit. */
  const bulkhead = (lens: THREE.Material, colour: number) => {
    add(metals.darkMetal, softBox(0.46, 0.2, 0.1, 0.03, 1), 0, 0, 0.05);
    box(lens, 0.36, 0.11, 0.05, 0, -0.01, 0.105);
    for (const y of [-0.05, 0.03]) box(metals.brushed, 0.42, 0.008, 0.008, 0, y, 0.14);
    for (const x of [-0.2, -0.067, 0.067, 0.2]) { box(metals.brushed, 0.008, 0.14, 0.008, x, -0.01, 0.14); box(metals.brushed, 0.008, 0.008, 0.05, x, -0.08, 0.118); }
    cyl(metals.brushed, 0.016, 0.5, 0.17, 0.34, 0.02, {}, 6);
    halo([0, -0.02, 0.22], colour, 0.7);
  };
  /** A bank of real louvre blades in a frame, centred on the origin. */
  const louvreBank = (w: number, h: number, hit = false) => {
    box(voidDark, w - 0.06, h - 0.06, 0.01, 0, 0, 0.012);
    for (const side of [-1, 1]) {
      box(metals.darkMetal, 0.07, h, 0.13, side * (w / 2 - 0.035), 0, 0.065, { hit });
      box(metals.darkMetal, w, 0.07, 0.13, 0, side * (h / 2 - 0.035), 0.065, { hit });
    }
    const count = Math.round((h - 0.14) / (high ? 0.1 : 0.16));
    for (let i = 0; i < count; i += 1) box(metals.structural, w - 0.14, 0.012, 0.13, 0, -h / 2 + 0.07 + (i + 0.5) * (h - 0.14) / count, 0.062, { r: [0.65, 0, 0] });
    if (w > 1.7) box(metals.darkMetal, 0.05, h - 0.14, 0.11, 0, 0, 0.075);
  };
  /** Steel-framed service window, lit from inside. */
  const serviceWindow = (w: number, h: number, cell: number, columns: number, rows: number) => {
    box(formwork, w + 0.3, 0.1, 0.17, 0, -h / 2 - 0.05, 0.085, { uv: 1.5 });
    box(formwork, w + 0.24, 0.16, 0.1, 0, h / 2 + 0.08, 0.05, { uv: 1.5 });
    for (const side of [-1, 1]) {
      box(metals.darkMetal, 0.05, h, 0.07, side * (w / 2 - 0.025), 0, 0.035);
      box(metals.darkMetal, w, 0.05, 0.07, 0, side * (h / 2 - 0.025), 0.035);
    }
    const rect = sheetCell(cell);
    card(serviceGlow, w - 0.08, h - 0.08, 0, 0, 0.022, [rect[0], rect[1], 480, Math.min(480, 480 * h / w)], [1024, 1024]);
    for (let i = 1; i < columns; i += 1) box(metals.darkMetal, 0.028, h - 0.1, 0.035, -w / 2 + i * w / columns, 0, 0.042);
    for (let i = 1; i < rows; i += 1) box(metals.darkMetal, w - 0.1, 0.028, 0.035, 0, -h / 2 + i * h / rows, 0.042);
  };
  const hoop = new THREE.TorusGeometry(0.36, 0.012, 4, 14, Math.PI * 1.36);
  hoop.rotateZ(Math.PI / 2 - Math.PI * 0.68);
  hoop.rotateX(Math.PI / 2);
  /** Cat ladder standing off a wall, with a safety cage from `cageFrom` up. */
  const ladder = (height: number, cageFrom: number, off = 0.18) => {
    for (const side of [-1, 1]) rod(metals.structural, [side * 0.22, 0, off], [side * 0.22, height, off], 0.02, { shadow: true });
    for (let y = 0.3; y < height - 0.05; y += 0.3) rod(metals.structural, [-0.22, y, off], [0.22, y, off], 0.012, {}, 5);
    for (let y = 0.7; y < height; y += 2.2) for (const side of [-1, 1]) rod(metals.structural, [side * 0.22, y, 0], [side * 0.22, y, off], 0.012, {}, 4);
    if (cageFrom >= height) return;
    for (let y = cageFrom; y <= height + 0.01; y += 0.75) add(metals.structural, hoop, 0, y, off + 0.27);
    for (const angle of [-0.9, 0, 0.9]) rod(metals.structural, [Math.sin(angle) * 0.36, cageFrom, off + 0.27 + Math.cos(angle) * 0.36], [Math.sin(angle) * 0.36, height, off + 0.27 + Math.cos(angle) * 0.36], 0.009, {}, 4);
  };
  // Axial fans: a dark throat, a wire guard, and a rotor that really turns.
  const rotors: Array<{ base: THREE.Matrix4; speed: number }> = [];
  const disc = new THREE.CircleGeometry(1, 24);
  const fan = (radius: number, x: number, y: number, z: number, speed = 7) => {
    add(voidDark, disc, x, y, z + 0.004, { s: [radius, radius, 1] });
    add(metals.darkMetal, new THREE.TorusGeometry(radius, 0.035, 6, 28), x, y, z + 0.05);
    for (const k of [0.32, 0.55, 0.78]) add(metals.brushed, new THREE.TorusGeometry(radius * k, 0.006, 4, 24), x, y, z + 0.1);
    for (let i = 0; i < 8; i += 1) { const a = i * Math.PI / 4; rod(metals.brushed, [x + Math.cos(a) * radius * 0.1, y + Math.sin(a) * radius * 0.1, z + 0.1], [x + Math.cos(a) * radius, y + Math.sin(a) * radius, z + 0.07], 0.006, {}, 4); }
    cyl(metals.darkMetal, radius * 0.12, 0.02, x, y, z + 0.1, { r: AZ }, 10);
    const base = new THREE.Matrix4().makeTranslation(x, y, z + 0.05).scale(new THREE.Vector3(radius * 0.93, radius * 0.93, radius * 0.93));
    rotors.push({ base: parent ? parent.clone().multiply(base) : base, speed });
  };
  /** Neon: glass tube along every stroke, on stand-offs. */
  const tubes = (strokes: number[][][], material: THREE.Material, radius: number, off: number) => {
    for (const stroke of strokes) {
      for (let i = 0; i < stroke.length - 1; i += 1) rod(material, [stroke[i][0], stroke[i][1], off], [stroke[i + 1][0], stroke[i + 1][1], off], radius, {}, 6);
      for (const [x, y] of stroke) ball(material, radius, x, y, off);
      for (const [x, y] of [stroke[0], stroke[stroke.length - 1]]) { cyl(metals.brushed, radius * 0.4, off, x, y, off / 2, { r: AZ }, 4); cyl(metals.darkMetal, radius * 1.5, radius * 2, x, y, off, { r: AZ }, 6); }
    }
  };
  const glowPlane = (map: THREE.Texture, w: number, h: number, x: number, y: number, z: number, turn: number, gain: number) => {
    const mesh = kit.place(new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map, color: new THREE.Color(gain, gain, gain), toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })), x, y, z, false);
    mesh.rotation.y = turn;
    return mesh;
  };
  const neonMint = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.9, 3.4, 3.1), toneMapped: false });
  const neonAmber = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 2.0, 0.75), toneMapped: false });
  /** Folding chair, facing +z. */
  const chair = (x: number, z: number, turn: number) => frame(x, 0, z, turn, () => {
    for (const side of [-1, 1]) {
      rod(metals.brushed, [side * 0.2, 0, 0.22], [side * 0.2, 0.84, -0.2], 0.011, {}, 5);
      rod(metals.brushed, [side * 0.2, 0, -0.22], [side * 0.2, 0.46, 0.2], 0.011, {}, 5);
    }
    rod(metals.brushed, [-0.2, 0.05, 0.2], [0.2, 0.05, 0.2], 0.009, {}, 4);
    rod(metals.brushed, [-0.2, 0.05, -0.2], [0.2, 0.05, -0.2], 0.009, {}, 4);
    add(screenPaint, softBox(0.4, 0.022, 0.38, 0.01, 1), 0, 0.455, 0.01, { shadow: true });
    add(screenPaint, softBox(0.4, 0.2, 0.018, 0.008, 1), 0, 0.74, -0.165, { r: [-0.12, 0, 0] });
  });

  // ---- Plant room (-x) -----------------------------------------------------
  const sideFrom = -28.4, sideTo = 0.3, sideRun = sideTo - sideFrom, sideZ = (sideFrom + sideTo) / 2;
  place(new THREE.Mesh(worldBox(5.66, PLANT_TOP, sideRun, 2.6), brickwork), -12.37, PLANT_TOP / 2, sideZ, true, true);
  place(new THREE.Mesh(softBox(5.96, 0.22, sideRun + 0.3, 0.04, 3), concrete), -12.37, PLANT_TOP + 0.11, sideZ, true);
  // Plinth and its light strip break at the service door.
  for (const [from, to] of [[sideFrom, -4.72], [-3.28, sideTo]]) {
    place(new THREE.Mesh(softBox(0.1, 0.6, to - from, 0.02, 2.2), concrete), -9.5, 0.3, (from + to) / 2, false, true);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, to - from - 0.1), mintTube), -9.47, 0.62, (from + to) / 2, false);
  }
  place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, sideRun - 0.2), amberTube), -9.52, PLANT_TOP - 0.05, sideZ, false);
  const brickSide: Pool["uv"] = (p) => [(p[2] - sideZ) / 2.6, (p[1] - PLANT_TOP / 2) / 2.6];
  const onPlant = (z: number, y: number, build: () => void) => frame(-9.54, y, z, Math.PI / 2, build);
  // Service door with a caged bulkhead lamp over it.
  onPlant(-4, 0, () => door("plant", 1));
  onPlant(-4, 2.56, () => { bulkhead(sodium, 0xffa758); wallPool("brick", 0, -0.55, 3.6, 3.6, 0xffa050, 0.55, brickSide); });
  floorPool(-8.5, -4, 2.2, 0xffa050, 0.1);
  // Brick piers break the long wall into bays between the signs.
  for (const z of [-26.9, -20.0, -14.05, -7.9, -1.9]) {
    box(brickwork, 0.14, 4.2, 0.45, -9.48, 2.1, z, { uv: 2.6, shadow: true, hit: true });
    box(formwork, 0.2, 0.1, 0.55, -9.47, 4.25, z, { uv: 1.5 });
  }
  // Plant room windows: warm by the door, cold fluorescent at the far end.
  for (const [z, cell, colour] of [[-5.45, 0, 0xffa050], [-2.95, 1, 0xffa050], [-23.6, 2, 0xa8c8ff], [-25.65, 3, 0xa8c8ff]]) {
    onPlant(z, 4.75, () => { serviceWindow(1.6, 1.3, cell, 4, 2); wallPool("brick", 0, -0.9, 3.2, 3.6, colour, colour === 0xa8c8ff ? 0.5 : 0.34, brickSide); });
  }
  floorPool(-8.2, -24.6, 3.4, 0xa8c8ff, 0.15);
  // Intake louvre and switchgear at the far end.
  onPlant(-24.3, 2.35, () => louvreBank(2.5, 1.7, true));
  // Switchgear and a junction box: doors, handles, status lamps, warning plates.
  onPlant(-21.9, 1.45, () => {
    box(metals.darkMetal, 0.62, 0.82, 0.008, 0, 0, 0.243);
    box(metals.brushed, 0.03, 0.16, 0.025, 0.25, 0, 0.26);
    box(ledGreen, 0.025, 0.025, 0.012, -0.22, 0.32, 0.25); box(ledRed, 0.025, 0.025, 0.012, -0.16, 0.32, 0.25); box(markerGlow, 0.025, 0.025, 0.012, -0.1, 0.32, 0.25);
    label("volts", 0.3, -0.08, -0.08, 0.252);
    for (const y of [-0.3, 0.3]) cyl(metals.brushed, 0.014, 0.1, -0.33, y, 0.2, {}, 6);
  });
  onPlant(-6.9, 1.4, () => {
    box(metals.darkMetal, 0.42, 0.52, 0.008, 0, 0, 0.243);
    box(metals.brushed, 0.025, 0.1, 0.02, 0.17, 0, 0.255);
    box(ledGreen, 0.02, 0.02, 0.012, -0.15, 0.2, 0.25);
    label("edge", 0.2, 1.0, 0.25, 0.144);
  });
  place(new THREE.Mesh(softBox(0.24, 0.9, 0.7, 0.02, 1.2), screenPaint), -9.42, 1.45, -21.9, true, true);
  place(new THREE.Mesh(softBox(0.24, 0.6, 0.5, 0.02, 1.2), plantPaint), -9.42, 1.4, -6.9, true, true);
  const conduit = new THREE.CylinderGeometry(0.035, 0.035, 1, 8);
  instances(conduit, metals.brushed, [
    { position: [-9.49, 3.6, -6.9], scale: [1, 4.6, 1] }, { position: [-9.49, 3.6, -7.02], scale: [1, 4.6, 1] }, { position: [-9.49, 3.2, -1.2], scale: [1, 6.4, 1] },
    { position: [-9.49, 4.15, -21.9], scale: [1, 4.5, 1] }, { position: [-9.49, 4.15, -22.03], scale: [1, 4.5, 1] }, { position: [-9.49, 3.2, -27.2], scale: [1, 6.4, 1] },
  ], false, false);
  // Twin service mains along the foot of the wall.
  const main = new THREE.CylinderGeometry(0.07, 0.07, 22.2, 12);
  main.rotateX(Math.PI / 2);
  place(new THREE.Mesh(main, amberPaint), -9.32, 0.82, -16.9, true);
  place(new THREE.Mesh(main, metals.brushed), -9.32, 1.02, -16.9, true);
  instances(softBox(0.16, 0.42, 0.06, 0.012, 1), metals.darkMetal, Array.from({ length: 8 }, (_, i) => ({ position: [-9.36, 0.92, -27.4 + i * 3] as V3 })), false, false);
  // Flanged joints, hand-wheel valves, a gauge, and the bends where the mains enter the wall.
  for (let i = 0; i < 7; i += 1) for (const y of [0.82, 1.02]) for (const gap of [-0.03, 0.03]) cyl(metals.structural, 0.105, 0.035, -9.32, y, -25.9 + i * 3 + gap, { r: AZ }, 12);
  for (const [y, material] of [[0.82, amberPaint], [1.02, metals.brushed]] as Array<[number, THREE.Material]>) {
    pipe(material, [[-9.32, y, -5.9], [-9.32, y, -5.62], [-9.4, y, -5.46], [-9.56, y, -5.42]], 0.07, { shadow: true }, 10);
    cyl(metals.structural, 0.12, 0.03, -9.53, y, -5.42, { r: AX }, 12);
    ball(material, 0.07, -9.32, y, -28);
  }
  for (const [z, y] of [[-9.4, 0.82], [-15.6, 1.02], [-22.9, 0.82]]) onPlant(z, y, () => {
    ball(metals.structural, 0.1, 0, 0, 0.22, { s: [1.3, 1, 1] });
    cyl(metals.brushed, 0.014, 0.2, 0, 0, 0.33, { r: AZ }, 6);
    add(redPaint, new THREE.TorusGeometry(0.09, 0.012, 6, 18), 0, 0, 0.43);
    for (const a of [0, Math.PI / 3, -Math.PI / 3]) rod(redPaint, [-Math.cos(a) * 0.09, -Math.sin(a) * 0.09, 0.43], [Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0.43], 0.008, {}, 4);
  });
  onPlant(-18.4, 1.02, () => { cyl(metals.brushed, 0.012, 0.16, 0, 0.14, 0.22, {}, 6); cyl(metals.darkMetal, 0.06, 0.035, 0, 0.27, 0.22, { r: AZ }, 14); cyl(markerGlow, 0.05, 0.004, 0, 0.27, 0.24, { r: AZ }, 14); });
  // The two tall pipes are rainwater downpipes: hopper heads, brackets, a shoe at the foot.
  for (const z of [-1.2, -27.2]) {
    box(metals.darkMetal, 0.2, 0.22, 0.24, -9.45, 6.25, z);
    for (const y of [1.2, 3.2, 5.2]) box(metals.darkMetal, 0.1, 0.03, 0.12, -9.5, y, z);
    rod(metals.brushed, [-9.49, 0.12, z], [-9.36, 0.03, z], 0.035, {}, 8);
  }

  // The roof's sign: tube lettering between amber chevrons that point down range.
  place(new THREE.Mesh(softBox(0.08, 1.5, 12.6, 0.02, 1.6), metals.darkMetal), -9.5, 5.2, -14, false, true);
  const nightline = wordStrokes("NIGHTLINE", 0.84, 0.98);
  frame(-9.46, 5.2, -14, Math.PI / 2, () => {
    tubes(nightline, neonMint, 0.021, 0.075);
    // Transformer, feed cable and the board's fixing rails.
    add(metals.darkMetal, softBox(0.5, 0.16, 0.1, 0.02, 1), 5.4, -0.56, 0.05);
    slack(rubber, [5.15, -0.5, 0.06], [3.95, -0.42, 0.06], 0.08, 0.008);
    for (const y of [-0.68, 0.68]) box(metals.structural, 12.4, 0.04, 0.025, 0, y, 0.012);
    for (let i = 0; i < 9; i += 1) for (const y of [-0.68, 0.68]) cyl(metals.brushed, 0.014, 0.012, -5.6 + i * 1.4, y, 0.03, { r: AZ }, 6);
  });
  const nightlineSpill = glowPlane(track(haloTexture(nightline, 9.6, 1.45, "#8ef5e3")), 9.6, 1.45, -9.455, 5.2, -14, Math.PI / 2, 1.5);
  // The transformer is tired: the tubes shimmer, and every so often the whole word browns out with a buzz.
  life.flicker([neonMint, nightlineSpill.material as THREE.Material], "neon", { at: [-9.4, 5.2, -14] });
  const chevrons: Transform[] = [];
  for (const start of [-19.05, -8.0]) for (let i = 0; i < 3; i += 1) for (const arm of [-1, 1]) {
    chevrons.push({ position: [-9.44, 5.2 + arm * 0.19, start - i * 0.42 + 0.17], rotation: [-arm * 0.84, 0, 0] });
  }
  instances(new THREE.BoxGeometry(0.045, 0.045, 0.56), amberTube, chevrons, false, false);

  // Plant on the roof of the plant room: chillers, a duct main, vents.
  const plantY = PLANT_TOP + 0.22;
  const chillers = [-5.2, -12.6, -20];
  instances(softBox(2.8, 2.1, 4.6, 0.06, 1.6), plantPaint, chillers.map((z) => ({ position: [-12.6, plantY + 1.2, z] as V3 })), false);
  instances(softBox(0.14, 0.15, 4.8, 0.02, 1.6), metals.darkMetal, chillers.flatMap((z) => [-1.1, 1.1].map((x) => ({ position: [-12.6 + x, plantY + 0.075, z] as V3 }))), false);
  for (const z of chillers) {
    for (const offset of [-1.14, 1.14]) frame(-11.2, plantY + 1.2, z + offset, Math.PI / 2, () => louvreBank(1.9, 1.7));
    // Corner posts, a control door, and wire guards over the top fans.
    for (const end of [-2.3, 0, 2.3]) box(metals.darkMetal, 0.05, 2.1, 0.09, -11.19, plantY + 1.2, z + end);
    box(ledGreen, 0.02, 0.03, 0.03, -11.17, plantY + 2.1, z);
    for (const offset of [-1.08, 1.08]) {
      const top = plantY + 2.55;
      for (const [radius, lift] of [[0.8, 0], [0.5, 0.07], [0.2, 0.1]]) add(metals.brushed, new THREE.TorusGeometry(radius, 0.012, 4, 20), -12.6, top + lift, z + offset, { r: AZ });
      for (let i = 0; i < 6; i += 1) { const a = i * Math.PI / 3; pipe(metals.brushed, [[-12.6 + Math.cos(a) * 0.8, top, z + offset + Math.sin(a) * 0.8], [-12.6 + Math.cos(a) * 0.5, top + 0.07, z + offset + Math.sin(a) * 0.5], [-12.6, top + 0.11, z + offset]], 0.008, {}, 4); }
    }
  }
  // Refrigerant lines along the front of the chillers and a guard rail at the roof edge.
  rod(amberPaint, [-11.05, plantY + 0.3, -22.4], [-11.05, plantY + 0.3, -2.8], 0.04, {}, 8);
  rod(metals.brushed, [-11.05, plantY + 0.42, -22.4], [-11.05, plantY + 0.42, -2.8], 0.028, {}, 8);
  for (let i = 0; i <= 14; i += 1) {
    const z = sideFrom + 0.3 + i * (sideRun - 0.6) / 14;
    rod(metals.structural, [-9.72, plantY, z], [-9.72, plantY + 1.1, z], 0.022, {}, 6);
    box(metals.darkMetal, 0.12, 0.02, 0.12, -9.72, plantY + 0.01, z);
  }
  for (const y of [0.56, 1.1]) rod(metals.structural, [-9.72, plantY + y, sideFrom + 0.3], [-9.72, plantY + y, sideTo - 0.3], 0.02, { shadow: y > 1 }, 6);
  box(metals.structural, 0.012, 0.1, sideRun - 0.6, -9.72, plantY + 0.06, sideZ);
  instances(new THREE.CylinderGeometry(0.82, 0.86, 0.3, 24), metals.darkMetal, chillers.flatMap((z) => [-1.08, 1.08].map((offset) => ({ position: [-12.6, plantY + 2.38, z + offset] as V3 }))), false);
  const ductMain = new THREE.CylinderGeometry(0.34, 0.34, 23.5, 20);
  ductMain.rotateX(Math.PI / 2);
  place(new THREE.Mesh(ductMain, metals.brushed), -10.35, plantY + 0.62, -13.6, true);
  const flange = new THREE.TorusGeometry(0.355, 0.035, 8, 24);
  instances(flange, metals.structural, Array.from({ length: 9 }, (_, i) => ({ position: [-10.35, plantY + 0.62, -24.6 + i * 2.75] as V3 })), false, false);
  instances(softBox(0.9, 0.28, 0.12, 0.02, 1), metals.darkMetal, Array.from({ length: 8 }, (_, i) => ({ position: [-10.35, plantY + 0.14, -23.2 + i * 2.75] as V3 })), false, false);
  // Flexible connectors, end caps and a damper actuator on the duct main.
  const bellows = new THREE.LatheGeometry(Array.from({ length: 21 }, (_, i) => new THREE.Vector2(0.365 + (i % 2 ? 0.035 : 0), -0.3 + i * 0.03)), 20);
  for (const z of [-17.7, -9.5]) add(rubber, bellows, -10.35, plantY + 0.62, z, { r: AZ });
  for (const z of [-25.35, -1.85]) ball(metals.brushed, 0.34, -10.35, plantY + 0.62, z, { s: [1, 1, 0.4] });
  add(plantPaint, softBox(0.3, 0.3, 0.42, 0.03, 1), -10.35, plantY + 1.1, -13.0);
  box(ledGreen, 0.02, 0.02, 0.02, -10.19, plantY + 1.18, -12.9);
  const ventSpots: Array<[number, number]> = [[-14, -8.9], [-13.9, -16.3]];
  instances(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 16), metals.brushed, ventSpots.map(([x, z]) => ({ position: [x, plantY + 0.65, z] as V3 })), false);
  instances(new THREE.ConeGeometry(0.52, 0.3, 16), metals.brushed, ventSpots.map(([x, z]) => ({ position: [x, plantY + 1.52, z] as V3 })), false);

  // Lattice mast with dishes at the far corner of the plant room.
  const mastX = -13.2, mastZ = -26, mastBase = plantY, mastTop = 18.6, mastHalf = 0.35;
  const mastHeight = mastTop - mastBase;
  instances(new THREE.CylinderGeometry(0.04, 0.05, mastHeight, 8), metals.structural, [-1, 1].flatMap((a) => [-1, 1].map((b) => ({ position: [mastX + a * mastHalf, mastBase + mastHeight / 2, mastZ + b * mastHalf] as V3 }))), false);
  const levels = 8, level = mastHeight / levels, lean = Math.atan(mastHalf * 2 / level);
  const braces: Transform[] = [], rings: Transform[] = [];
  for (let i = 0; i < levels; i += 1) {
    const y = mastBase + (i + 0.5) * level, way = i % 2 ? 1 : -1;
    for (const side of [-1, 1]) {
      braces.push({ position: [mastX + side * mastHalf, y, mastZ], rotation: [way * side * lean, 0, 0] });
      braces.push({ position: [mastX, y, mastZ + side * mastHalf], rotation: [0, 0, way * side * lean] });
      rings.push({ position: [mastX + side * mastHalf, y + level / 2, mastZ], rotation: [Math.PI / 2, 0, 0] });
      rings.push({ position: [mastX, y + level / 2, mastZ + side * mastHalf], rotation: [0, 0, Math.PI / 2] });
    }
  }
  instances(new THREE.BoxGeometry(0.03, Math.hypot(mastHalf * 2, level), 0.03), metals.structural, braces, false);
  instances(new THREE.BoxGeometry(0.03, mastHalf * 2, 0.03), metals.structural, rings, false, false);
  const dish = new THREE.SphereGeometry(0.95, 24, 10, 0, Math.PI * 2, 0, 0.62);
  dish.rotateX(Math.PI / 2);
  dish.translate(0, 0, -0.78);
  const dishPaint = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide, envMapIntensity: 0.9 });
  instances(dish, dishPaint, [
    { position: [mastX + 0.55, 12.4, mastZ + 0.2], rotation: [0.05, Math.PI / 2 - 0.5, 0] },
    { position: [mastX - 0.1, 15.1, mastZ + 0.6], rotation: [0, 0.35, 0] },
    { position: [mastX + 0.5, 16.6, mastZ - 0.3], rotation: [0.1, 2.2, 0], scale: [0.6, 0.6, 0.6] },
  ], false);
  instances(softBox(0.28, 1.5, 0.12, 0.03, 1), plantPaint, [0, 1, 2].map((i) => ({ position: [mastX + Math.sin(i * 2.094 + 0.4) * 0.6, 17.5, mastZ + Math.cos(i * 2.094 + 0.4) * 0.6] as V3, rotation: [0, i * 2.094 + 0.4, 0] as V3 })), false);
  place(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 3.4, 6), metals.structural), mastX, mastTop + 1.7, mastZ, false);
  // Guy wires with turnbuckles, a work platform, a yagi and whips.
  const anchors: V3[] = [[-10.1, plantY, -21.6], [-14.9, plantY, -21.9], [-10.3, plantY, -28.1], [-15, plantY, -28.1]];
  for (const anchor of anchors) for (const height of [10.6, 15.2]) {
    const from: V3 = [mastX + Math.sign(anchor[0] - mastX) * mastHalf, height, mastZ + Math.sign(anchor[2] - mastZ) * mastHalf];
    rod(metals.structural, from, anchor, 0.011, {}, 4);
    const t = 0.9;
    cyl(metals.brushed, 0.03, 0.2, from[0] + (anchor[0] - from[0]) * t, from[1] + (anchor[1] - from[1]) * t, from[2] + (anchor[2] - from[2]) * t, {}, 6);
  }
  for (const anchor of anchors) box(metals.darkMetal, 0.2, 0.1, 0.2, anchor[0], anchor[1] + 0.05, anchor[2]);
  box(treadPlate, 1.6, 0.04, 1.6, mastX, 11.4, mastZ, { uv: 1, shadow: true });
  add(metals.structural, new THREE.TorusGeometry(0.95, 0.018, 4, 20), mastX, 12.45, mastZ, { r: AZ });
  for (let i = 0; i < 6; i += 1) { const a = i * Math.PI / 3 + 0.3; rod(metals.structural, [mastX + Math.cos(a) * 0.95, 11.4, mastZ + Math.sin(a) * 0.95], [mastX + Math.cos(a) * 0.95, 12.45, mastZ + Math.sin(a) * 0.95], 0.014, {}, 4); }
  rod(metals.brushed, [mastX + 0.3, 13.8, mastZ], [mastX + 2.1, 13.8, mastZ + 0.5], 0.018, {}, 5);
  for (let i = 0; i < 6; i += 1) { const t = 0.2 + i * 0.15, half = 0.42 - i * 0.04; const x = mastX + 0.3 + 1.8 * t, z = mastZ + 0.5 * t; rod(metals.brushed, [x + 0.12 * half, 13.8 - half, z - half * 0.3], [x - 0.12 * half, 13.8 + half, z + half * 0.3], 0.008, {}, 4); }
  for (const [dx, dz] of [[-0.35, 0.35], [0.35, -0.35]]) rod(metals.structural, [mastX + dx, mastTop, mastZ + dz], [mastX + dx * 1.3, mastTop + 2.3, mastZ + dz * 1.3], 0.01, {}, 4);
  box(rubber, 0.1, mastHeight - 1, 0.03, mastX - mastHalf, mastBase + mastHeight / 2, mastZ + 0.1);
  for (const [x, y, z, turn] of [[mastX + 0.55, 12.4, mastZ + 0.2, Math.PI / 2 - 0.5], [mastX - 0.1, 15.1, mastZ + 0.6, 0.35]]) {
    // Feed horns on struts in front of the two big dishes.
    const fx = -Math.sin(turn), fz = -Math.cos(turn);
    for (const side of [-0.5, 0.5]) rod(metals.structural, [x + fz * side, y - 0.3, z - fx * side], [x + fx * 0.62, y, z + fz * 0.62], 0.01, {}, 4);
    cyl(metals.darkMetal, 0.06, 0.16, x + fx * 0.62, y, z + fz * 0.62, { r: [Math.PI / 2, 0, -turn] }, 8);
  }
  const mastBeacon = emissive(0xff2a1c, 4);
  place(new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), mastBeacon), mastX + 0.3, mastTop + 0.16, mastZ + 0.3, false);
  kit.updates.push((now) => {
    const pulse = 0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(now * 0.0031)), 6);
    mastBeacon.color.setRGB(5 * pulse, 0.5 * pulse, 0.3 * pulse);
  });

  // ---- Mechanical yard screen (+x) -----------------------------------------
  place(new THREE.Mesh(worldBox(0.16, SCREEN_TOP, sideRun, 2.2), cladding), 9.62, SCREEN_TOP / 2, sideZ, true, true);
  place(new THREE.Mesh(softBox(0.3, 0.12, sideRun + 0.1, 0.03, 2), metals.darkMetal), 9.66, SCREEN_TOP + 0.06, sideZ, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, sideRun - 0.2), mintTube), 9.52, SCREEN_TOP - 0.04, sideZ, false);
  instances(iBeam(0.24, 0.24, 5.9, 0.03, 0.02), metals.structural, Array.from({ length: 8 }, (_, i) => ({ position: [9.86, 0, sideFrom + 0.3 + i * 4.02] as V3 })), false);
  for (const [from, to] of [[sideFrom, -13.7], [-9.5, sideTo]]) {
    place(new THREE.Mesh(softBox(0.12, 0.4, to - from, 0.02, 2.2), concrete), 9.5, 0.2, (from + to) / 2, false, true);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, to - from - 0.1), amberTube), 9.46, 0.42, (from + to) / 2, false);
    // Cable tray above the signs.
    place(new THREE.Mesh(softBox(0.3, 0.05, to - from - 0.4, 0.01, 1.4), metals.structural), 9.37, 4.5, (from + to) / 2, true);
    const cable = new THREE.CylinderGeometry(0.03, 0.03, to - from - 0.5, 6);
    cable.rotateX(Math.PI / 2);
    instances(cable, new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.6, metalness: 0 }), [-0.08, 0, 0.08].map((x) => ({ position: [9.37 + x, 4.555, (from + to) / 2] as V3 })), false, false);
  }
  const onScreen = (z: number, y: number, build: () => void) => frame(9.54, y, z, -Math.PI / 2, build);
  // Cover strips over the sheet laps, tray lips and brackets.
  for (let i = 0; i < 8; i += 1) {
    const z = sideFrom + 0.3 + i * 4.02;
    box(screenPaint, 0.02, SCREEN_TOP - 0.1, 0.1, 9.53, SCREEN_TOP / 2, z);
    if (high) for (let y = 0.6; y < SCREEN_TOP; y += 0.9) cyl(metals.brushed, 0.012, 0.012, 9.515, y, z, { r: AX }, 6);
  }
  for (const [from, to] of [[sideFrom, -13.7], [-9.5, sideTo]]) {
    for (const x of [9.225, 9.515]) box(metals.structural, 0.012, 0.07, to - from - 0.4, x, 4.54, (from + to) / 2);
    for (let z = from + 0.6; z < to - 0.3; z += 1.9) { box(metals.darkMetal, 0.34, 0.04, 0.04, 9.37, 4.455, z); rod(metals.darkMetal, [9.22, 4.44, z], [9.53, 4.2, z], 0.012, {}, 4); }
  }
  // Caged bulkhead lamps on the screen, fed from the tray.
  for (const z of [-3.6, -20.1]) onScreen(z, 4.08, () => { bulkhead(sodium, 0xffa758); wallPool("plain", 0, -1.2, 4.6, 5, 0xffa050, 0.2); });
  floorPool(8.1, -3.6, 3.6, 0xffa050, 0.13);
  // Fire point: hose reel and an extinguisher.
  const reel = new THREE.LatheGeometry([[0.05, 0], [0.33, 0], [0.33, 0.025], [0.14, 0.03], [0.14, 0.13], [0.33, 0.135], [0.33, 0.16], [0.05, 0.16]].map(([x, y]) => new THREE.Vector2(x, y)), 24);
  onScreen(-1.7, 1.5, () => {
    box(redPaint, 0.56, 0.56, 0.03, 0, 0, 0.015);
    add(redPaint, reel, 0, 0, 0.04, { r: AZ, shadow: true });
    for (const radius of [0.19, 0.24, 0.29]) add(rubber, new THREE.TorusGeometry(radius, 0.027, 6, 24), 0, 0, 0.12);
    pipe(rubber, [[0.29, 0, 0.12], [0.33, -0.2, 0.13], [0.3, -0.42, 0.1], [0.26, -0.56, 0.08]], 0.022, {}, 6);
    cyl(metals.brushed, 0.022, 0.16, 0.25, -0.62, 0.08, { r: [0, 0, 0.2] }, 8);
    cyl(metals.brushed, 0.03, 0.05, 0, 0, 0.21, { r: AZ }, 8);
    label("hose", 0.2, 0, 0.5, 0.014);
  });
  onScreen(-0.72, 0, () => {
    cyl(redPaint, 0.075, 0.46, 0, 1.0, 0.11, { shadow: true }, 14);
    ball(redPaint, 0.075, 0, 1.23, 0.11, { s: [1, 0.6, 1] });
    cyl(metals.brushed, 0.02, 0.09, 0, 1.3, 0.11, {}, 8);
    box(metals.darkMetal, 0.13, 0.02, 0.03, 0.03, 1.36, 0.11); box(metals.darkMetal, 0.11, 0.02, 0.03, 0.03, 1.32, 0.11);
    pipe(rubber, [[-0.02, 1.3, 0.11], [-0.09, 1.2, 0.13], [-0.1, 1.0, 0.14], [-0.09, 0.9, 0.13]], 0.011, {}, 5);
    box(metals.brushed, 0.17, 0.03, 0.1, 0, 1.12, 0.05); box(metals.brushed, 0.1, 0.02, 0.1, 0, 0.76, 0.05);
    box(labels, 0.1, 0.14, 0.002, 0, 1.0, 0.186);
  });
  // Distribution board with conduits up to the tray.
  onScreen(-6.6, 1.55, () => {
    add(plantPaint, softBox(0.8, 1.1, 0.22, 0.02, 1.2), 0, 0, 0.11, { hit: true, shadow: true });
    box(metals.darkMetal, 0.7, 1.0, 0.006, 0, 0, 0.223);
    box(metals.brushed, 0.03, 0.18, 0.025, 0.28, 0, 0.24);
    for (const [i, lamp] of [ledGreen, ledGreen, ledRed].entries()) box(lamp, 0.025, 0.025, 0.012, -0.26 + i * 0.07, 0.4, 0.23);
    label("volts", 0.34, -0.08, -0.05, 0.23);
    for (const x of [-0.26, -0.16, -0.06]) { cyl(metals.brushed, 0.018, 2.42, x, 1.76, 0.05, {}, 6); box(metals.darkMetal, 0.06, 0.02, 0.03, x, 1.4, 0.05); box(metals.darkMetal, 0.06, 0.02, 0.03, x, 2.5, 0.05); }
  });
  // Gas bottles chained in a rack at the far end.
  const bottle = new THREE.LatheGeometry([[0, 0], [0.105, 0], [0.115, 0.02], [0.115, 1.22], [0.09, 1.34], [0.04, 1.42], [0.04, 1.5], [0.06, 1.5], [0.06, 1.62], [0, 1.62]].map(([x, y]) => new THREE.Vector2(x, y)), 16);
  onScreen(-27.45, 0, () => {
    [gasPaint, amberPaint, gasPaint].forEach((paint, i) => add(paint, bottle, -0.3 + i * 0.3, 0, 0.15, { shadow: true }));
    for (const y of [0.45, 1.15]) box(metals.darkMetal, 1.05, 0.04, 0.04, 0, y, 0.02);
    pipe(metals.brushed, [[-0.5, 1.15, 0.04], [-0.42, 1.1, 0.27], [0, 1.02, 0.29], [0.42, 1.1, 0.27], [0.5, 1.15, 0.04]], 0.008, {}, 4);
  });
  // The store's notice stands off the screen on two arms, facing the end of the walkway: flat on the wall behind the rack nobody could read it.
  frame(9.24, 1.62, -25.8, 0, () => {
    label("gas", 0.24, 0, 0, 0.014);
    for (const y of [-0.15, 0.15]) box(metals.darkMetal, 0.58, 0.025, 0.025, 0.02, y, -0.013);
  });
  // A lamp over the rack, so the far corner behind the target wall is a place and not a hole.
  onScreen(-27.3, 2.72, () => { bulkhead(sodium, 0xffa758); wallPool("plain", 0, -1.0, 3.4, 3.6, 0xffa050, 0.3); });
  floorPool(8.5, -27.2, 2.2, 0xffa050, 0.11);

  // Billboard seen from behind: columns, walers, bracing, a catwalk.
  const boardZ = -20.7, boardRun = 12.4, boardLow = 6.2, boardHigh = 12.8;
  const boardColumns = [-26.4, -22.6, -18.8, -15];
  instances(iBeam(0.3, 0.3, boardHigh + 0.1, 0.035, 0.025), metals.structural, boardColumns.map((z) => ({ position: [10.5, 0, z] as V3 })), false);
  place(new THREE.Mesh(worldBox(0.1, boardHigh - boardLow, boardRun, 2.4), sheeting), 11.0, (boardLow + boardHigh) / 2, boardZ, true);
  instances(softBox(0.1, 0.12, boardRun, 0.02, 1.4), metals.structural, [6.3, 7.9, 9.5, 11.1, 12.7].map((y) => ({ position: [10.78, y, boardZ] as V3 })), false);
  const bay = 3.8, rise = 3.2, tilt = Math.atan(bay / rise);
  const boardBraces: Transform[] = [];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 2; j += 1) {
    boardBraces.push({ position: [10.62, 6.3 + rise * (j + 0.5), boardColumns[i] + bay / 2], rotation: [((i + j) % 2 ? 1 : -1) * tilt, 0, 0] });
  }
  instances(new THREE.BoxGeometry(0.05, Math.hypot(bay, rise), 0.05), metals.structural, boardBraces, false);
  place(new THREE.Mesh(worldBox(0.95, 0.06, boardRun + 0.4, 1), treadPlate), 10.2, 5.72, boardZ, true);
  box(metals.structural, 0.012, 0.14, boardRun + 0.4, 9.74, 5.82, boardZ);
  for (const z of boardColumns) rod(metals.structural, [10.5, 5.1, z], [9.8, 5.7, z], 0.025, {}, 5);
  // Access ladder up the back of the board, and its junction box.
  frame(10.72, 5.75, -16.9, -Math.PI / 2, () => ladder(7.3, 2.25));
  add(plantPaint, softBox(0.2, 0.5, 0.4, 0.02, 1), 10.6, 7.2, -20.7);
  rod(metals.brushed, [10.62, 7.45, -20.7], [10.62, boardHigh, -20.7], 0.016, {}, 5);
  const railPosts = Array.from({ length: 8 }, (_, i) => ({ position: [9.78, 6.3, boardZ - 6.3 + i * 1.8] as V3 }));
  instances(new THREE.BoxGeometry(0.04, 1.1, 0.04), metals.structural, railPosts, false);
  instances(new THREE.BoxGeometry(0.04, 0.04, boardRun + 0.4), metals.structural, [6.85, 6.35].map((y) => ({ position: [9.78, y, boardZ] as V3 })), false);
  // Floodlights reach over the top to light the face we never see; their spill edges the board.
  instances(new THREE.BoxGeometry(1.5, 0.05, 0.05), metals.structural, boardColumns.map((z) => ({ position: [11.2, boardHigh + 0.32, z] as V3, rotation: [0, 0, 0.16] as V3 })), false);
  instances(softBox(0.34, 0.14, 0.5, 0.03, 1), metals.darkMetal, boardColumns.map((z) => ({ position: [11.98, boardHigh + 0.46, z] as V3 })), false);
  instances(new THREE.BoxGeometry(0.26, 0.03, 0.42), emissive(0xdff4ff, 3.4), boardColumns.map((z) => ({ position: [11.98, boardHigh + 0.375, z] as V3 })), false, false);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, boardRun), mintTube), 11.07, boardHigh + 0.03, boardZ, false);
  instances(new THREE.BoxGeometry(0.05, boardHigh - boardLow, 0.05), mintTube, [-1, 1].map((end) => ({ position: [11.07, (boardLow + boardHigh) / 2, boardZ + end * (boardRun / 2 + 0.03)] as V3 })), false, false);

  // Water tank on a steel tower behind the screen.
  const tankX = 13.2, tankZ = -5.6, tankFloor = 7.4;
  instances(iBeam(0.22, 0.22, tankFloor, 0.03, 0.02), metals.structural, [-1, 1].flatMap((a) => [-1, 1].map((b) => ({ position: [tankX + a * 1.55, 0, tankZ + b * 1.55] as V3 }))), false);
  const tankBraces: Transform[] = [];
  const braceLean = Math.atan(3.1 / 3.4);
  for (let tier = 0; tier < 2; tier += 1) for (const side of [-1, 1]) {
    const y = 0.4 + 3.4 * (tier + 0.5), way = (tier % 2 ? 1 : -1) * side;
    tankBraces.push({ position: [tankX + side * 1.55, y, tankZ], rotation: [way * braceLean, 0, 0] });
    tankBraces.push({ position: [tankX, y, tankZ + side * 1.55], rotation: [0, 0, way * braceLean] });
  }
  instances(new THREE.BoxGeometry(0.05, Math.hypot(3.1, 3.4), 0.05), metals.structural, tankBraces, false);
  place(new THREE.Mesh(softBox(4.3, 0.2, 4.3, 0.03, 1.6), metals.darkMetal), tankX, tankFloor + 0.1, tankZ, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 3.5, 36), tankPaint), tankX, tankFloor + 1.95, tankZ, true);
  add(tankPaint, new THREE.LatheGeometry([[0, 1.02], [0.2, 1.0], [2.2, 0.1], [2.26, 0], [2.02, 0]].map(([x, y]) => new THREE.Vector2(x, y)), 36), tankX, tankFloor + 3.7, tankZ, { shadow: true });
  ball(metals.structural, 0.12, tankX, tankFloor + 4.78, tankZ);
  for (let i = 0; i < 16; i += 1) { const a = i * Math.PI / 8; box(tankPaint, 0.05, 3.5, 0.025, tankX + Math.cos(a) * 2.005, tankFloor + 1.95, tankZ + Math.sin(a) * 2.005, { r: [0, -a + Math.PI / 2, 0] }); }
  // Platform rail, the outlet main and a cat ladder with a cage.
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) rod(metals.structural, [tankX + a * 2.1, tankFloor + 0.2, tankZ + b * 2.1], [tankX + a * 2.1, tankFloor + 1.25, tankZ + b * 2.1], 0.02, {}, 5);
  for (const y of [0.72, 1.25]) for (const [a, b, c, d] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) rod(metals.structural, [tankX + a * 2.1, tankFloor + y, tankZ + b * 2.1], [tankX + c * 2.1, tankFloor + y, tankZ + d * 2.1], 0.018, {}, 5);
  pipe(metals.brushed, [[13.2, 7.4, -5.6], [13.2, 6.7, -5.6], [13.2, 6.3, -5.2], [13.2, 6.2, -4.3], [13.2, 5.7, -3.95], [13.2, 0.3, -3.9]], 0.11, { shadow: true }, 10);
  frame(tankX - 2.14, 0, tankZ, -Math.PI / 2, () => ladder(tankFloor + 3.6, 2.6, 0.12));
  const tankHoop = new THREE.TorusGeometry(2.02, 0.035, 8, 48);
  tankHoop.rotateX(Math.PI / 2);
  instances(tankHoop, metals.structural, [0.5, 1.4, 2.4, 3.3].map((y) => ({ position: [tankX, tankFloor + 0.2 + y, tankZ] as V3 })), false, false);

  // ---- Stair and lift core behind the firing line ---------------------------
  const coreTop = 8.4;
  place(new THREE.Mesh(worldBox(20.8, coreTop, 5.3, 2.6), brickwork), 0, coreTop / 2, 12.35, true, true);
  place(new THREE.Mesh(softBox(21.1, 0.24, 5.6, 0.04, 3), concrete), 0, coreTop + 0.12, 12.35, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(20.4, 0.04, 0.03), amberTube), 0, coreTop - 0.06, 9.68, false);
  place(new THREE.Mesh(softBox(6.2, 2.7, 3.8, 0.05, 2.6), concrete), 3.6, coreTop + 1.55, 12.6, true);
  const brickBack: Pool["uv"] = (p) => [p[0] / 2.6, (p[1] - coreTop / 2) / 2.6];
  const onCore = (x: number, y: number, build: () => void) => frame(x, y, 9.7, Math.PI, build);
  onCore(8.4, 0, () => door("stair", -1));
  onCore(8.4, 2.56, () => { bulkhead(sodium, 0xffa758); wallPool("brick", 0, -0.55, 3.6, 3.6, 0xffa050, 0.55, brickBack); });
  onCore(-8.3, 2.6, () => louvreBank(2.3, 1.7, true));
  // Stairwell windows, lit.
  onCore(8.5, 5.3, () => { serviceWindow(1.4, 1.9, 1, 2, 3); wallPool("brick", 0, -1.1, 3.4, 4.2, 0xffa050, 0.32, brickBack); });
  onCore(-8.4, 6.7, () => { serviceWindow(1.5, 1.2, 0, 3, 2); wallPool("brick", 0, -0.9, 3.2, 3.4, 0xffa050, 0.3, brickBack); });
  // Split condensers on brackets over the louvre, fans turning.
  for (const x of [-9.0, -7.6]) onCore(x, 4.55, () => {
    for (const side of [-0.3, 0.3]) { box(metals.darkMetal, 0.04, 0.04, 0.44, side, -0.36, 0.22); rod(metals.darkMetal, [side, -0.7, 0.02], [side, -0.38, 0.4], 0.014, {}, 4); }
    add(plantPaint, softBox(0.9, 0.66, 0.34, 0.03, 1), 0, 0, 0.23, { shadow: true });
    fan(0.25, -0.12, 0, 0.4, 9);
    for (let i = 0; i < 6; i += 1) box(metals.darkMetal, 0.012, 0.5, 0.008, 0.25 + i * 0.03, 0, 0.402);
    pipe(metals.brushed, [[0.42, -0.1, 0.3], [0.52, -0.12, 0.28], [0.54, -0.5, 0.1], [0.54, -0.9, 0.03]], 0.012, {}, 5);
    card(labels, 0.2, 0.075, 0.25, 0.27, 0.402, LABELS.maker, [2048, 1024]);
  });
  // Cat ladder to the core roof, with its notice.
  onCore(7.0, 0.25, () => { ladder(9.5, 2.5); label("harness", 0.22, -0.49, 1.35, 0.014); });
  // Guard rail along the core roof, the lift overrun's louvre and coping, dishes.
  const railY = coreTop + 0.24;
  for (let i = 0; i <= 10; i += 1) rod(metals.structural, [-10.3 + i * 2.06, railY, 9.78], [-10.3 + i * 2.06, railY + 1.1, 9.78], 0.022, {}, 6);
  for (const y of [0.56, 1.1]) rod(metals.structural, [-10.3, railY + y, 9.78], [10.3, railY + y, 9.78], 0.02, {}, 6);
  frame(3.6, 10.05, 10.7, Math.PI, () => louvreBank(2.0, 1.1));
  add(metals.darkMetal, softBox(6.4, 0.08, 4.0, 0.02, 2), 3.6, coreTop + 2.94, 12.6, { shadow: true });
  rod(metals.structural, [1.2, coreTop + 2.9, 11.2], [1.2, coreTop + 4.6, 11.2], 0.02, {}, 5);

  // ---- Lamp piers and the glazed edge of the firing point -------------------
  const piers = [-1, 1].map((side) => ({ position: [side * 9.84, 2.35, 3.5] as V3 }));
  instances(softBox(0.6, 4.7, 0.6, 0.04, 2.2), formwork, piers);
  for (const side of [-1, 1]) {
    // Cap stone, base plate and bolts, a feed conduit, a hood over the lamp.
    add(formwork, softBox(0.72, 0.1, 0.72, 0.02, 1.5), side * 9.84, 4.75, 3.5, { shadow: true });
    box(metals.darkMetal, 0.3, 0.03, 0.3, side * 9.84, 4.815, 3.5);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) cyl(metals.brushed, 0.014, 0.03, side * 9.84 + a * 0.11, 4.84, 3.5 + b * 0.11, {}, 6);
    rod(metals.brushed, [side * 9.52, 0.3, 3.62], [side * 9.52, 4.7, 3.62], 0.016, {}, 5);
    rod(metals.structural, [side * 9.84, 5.9, 3.5], [side * 9.2, 6.5, 3.5], 0.014, {}, 4);
  }
  instances(new THREE.CylinderGeometry(0.07, 0.09, 1.9, 10), metals.structural, [-1, 1].map((side) => ({ position: [side * 9.84, 5.65, 3.5] as V3 })), false);
  instances(new THREE.BoxGeometry(1.7, 0.07, 0.07), metals.structural, [-1, 1].map((side) => ({ position: [side * 9.05, 6.52, 3.5] as V3, rotation: [0, 0, side * 0.08] as V3 })), false);
  instances(softBox(0.62, 0.13, 0.3, 0.04, 1), metals.darkMetal, [-1, 1].map((side) => ({ position: [side * 8.3, 6.43, 3.5] as V3 })), false);
  instances(new THREE.BoxGeometry(0.5, 0.03, 0.2), sodium, [-1, 1].map((side) => ({ position: [side * 8.3, 6.35, 3.5] as V3 })), false, false);

  // Balustrades: steel posts, glass infill, a handrail; `base` lifts them onto an upstand.
  const posts: Transform[] = [], panes: Transform[] = [], rails: Transform[] = [], markers: Transform[] = [];
  const balustrade = (axis: "x" | "z", at: number, from: number, to: number, base: number, markerSide = 0) => {
    const run = to - from, count = Math.max(1, Math.round(run / 2)), step = run / count, height = 1.22 - base;
    const turn: V3 = axis === "x" ? [0, Math.PI / 2, 0] : [0, 0, 0];
    const spot = (along: number, y: number, offset = 0): V3 => axis === "x" ? [along, y, at + offset] : [at + offset, y, along];
    for (let i = 0; i <= count; i += 1) posts.push({ position: spot(from + i * step, base + height / 2), scale: [1, height, 1] });
    for (let i = 0; i < count; i += 1) {
      panes.push({ position: spot(from + (i + 0.5) * step, base + height / 2), rotation: turn, scale: [1, height - 0.16, step - 0.1] });
      if (markerSide && i % 2 === 0) markers.push({ position: spot(from + (i + 0.5) * step, base - 0.16, markerSide * 0.24), rotation: turn });
    }
    rails.push({ position: spot((from + to) / 2, base + height + 0.02), rotation: turn, scale: [1, 1, run + 0.06] });
  };
  const upstand = 0.5;
  // Perimeter parapet.
  place(new THREE.Mesh(softBox(roofWidth, upstand, 0.4, 0.03, 2.4), formwork), 0, upstand / 2, ROOF.z0 + 0.2, true);
  place(new THREE.Mesh(softBox(roofWidth, upstand, 0.4, 0.03, 2.4), formwork), 0, upstand / 2, ROOF.z1 - 0.2, true);
  for (const side of [-1, 1]) place(new THREE.Mesh(softBox(0.4, upstand, roofDepth, 0.03, 2.4), formwork), side * (ROOF.x1 - 0.2), upstand / 2, roofZ, true);
  // Pressed metal coping with a drip, flashing at the foot, scuppers and roof drains.
  for (const z of [ROOF.z0 + 0.2, ROOF.z1 - 0.2]) { box(metals.darkMetal, roofWidth + 0.06, 0.03, 0.48, 0, upstand + 0.015, z); box(metals.brushed, roofWidth - 0.8, 0.1, 0.012, 0, 0.05, z + (z < 0 ? 0.21 : -0.21)); }
  for (const side of [-1, 1]) {
    box(metals.darkMetal, 0.48, 0.03, roofDepth + 0.06, side * (ROOF.x1 - 0.2), upstand + 0.015, roofZ);
    box(metals.brushed, 0.012, 0.1, roofDepth - 0.8, side * (ROOF.x1 - 0.41), 0.05, roofZ);
    for (const z of [6.2, -30.6]) { box(metals.brushed, 0.03, 0.22, 0.4, side * (ROOF.x1 - 0.405), 0.14, z); box(voidDark, 0.035, 0.14, 0.3, side * (ROOF.x1 - 0.41), 0.12, z); }
  }
  for (const [x, z] of [[-10.6, 4.0], [10.9, 2.0], [-5.8, -29.6], [7.4, -29.3]]) {
    cyl(metals.darkMetal, 0.16, 0.016, x, 0.008, z, {}, 16);
    ball(metals.structural, 0.1, x, 0.01, z, { s: [1, 0.7, 1] });
    for (let i = 0; i < 4; i += 1) rod(metals.darkMetal, [x + Math.cos(i * 0.785) * 0.11, 0.02, z + Math.sin(i * 0.785) * 0.11], [x - Math.cos(i * 0.785) * 0.11, 0.02, z - Math.sin(i * 0.785) * 0.11], 0.006, {}, 4);
  }
  balustrade("x", ROOF.z0 + 0.2, ROOF.x0 + 0.2, ROOF.x1 - 0.2, upstand, 1);
  balustrade("z", ROOF.x0 + 0.2, ROOF.z0 + 0.2, ROOF.z1 - 0.2, upstand, 1);
  balustrade("z", ROOF.x1 - 0.2, ROOF.z0 + 0.2, ROOF.z1 - 0.2, upstand, -1);
  // The firing point's own glass edges, either side of the lamp piers.
  for (const side of [-1, 1]) {
    balustrade("z", side * 9.78, 0.34, 3.18, 0);
    balustrade("z", side * 9.78, 3.82, 9.66, 0);
  }
  instances(new THREE.BoxGeometry(0.05, 1, 0.05), metals.structural, posts, false);
  instances(new THREE.BoxGeometry(0.016, 1, 1), glass, panes, false, false);
  instances(new THREE.BoxGeometry(0.07, 0.045, 1), metals.brushed, rails, false);
  instances(new THREE.BoxGeometry(0.03, 0.08, 0.3), markerGlow, markers, false, false);

  // ---- Open decks either side of the firing point ---------------------------
  // A packaged air handler on the +x deck, fans toward the range.
  place(new THREE.Mesh(softBox(2.7, 2.3, 4.4, 0.06, 1.6), plantPaint), 13.2, 1.3, 5.2, true, true);
  instances(softBox(0.14, 0.15, 4.6, 0.02, 1.6), metals.darkMetal, [-1.05, 1.05].map((x) => ({ position: [13.2 + x, 0.075, 5.2] as V3 })), false);
  frame(11.85, 1.3, 5.2, -Math.PI / 2, () => {
    fan(0.8, -1.1, 0, 0, 6); fan(0.8, 1.1, 0, 0, 6.6);
    // Control panel between the fans, panel seams, lifting eyes, the maker's plate.
    add(screenPaint, softBox(0.3, 0.6, 0.1, 0.02, 1), 0, 0.5, 0.05);
    box(ledGreen, 0.03, 0.03, 0.012, -0.07, 0.7, 0.105); box(markerGlow, 0.03, 0.03, 0.012, 0, 0.7, 0.105); box(metals.brushed, 0.03, 0.12, 0.02, 0.1, 0.45, 0.11);
    card(labels, 0.42, 0.16, 0, -0.2, 0.012, LABELS.maker, [2048, 1024]);
    for (const x of [-2.16, 2.16]) box(metals.darkMetal, 0.05, 2.3, 0.02, x, 0, 0.01);
    box(metals.darkMetal, 4.4, 0.05, 0.02, 0, 1.12, 0.01);
    for (const x of [-1.9, 1.9]) add(metals.brushed, new THREE.TorusGeometry(0.06, 0.014, 5, 12), x, 1.22, -0.3, { r: [0, Math.PI / 2, 0] });
  });
  // Duct flanges and a flexible connector.
  for (const z of [3.62, 0.82, 3.98]) box(metals.structural, 0.92, 0.92, 0.04, 13.2, 2.86, z);
  box(metals.structural, 0.92, 0.04, 0.92, 13.2, 2.44, 1.2);
  box(rubber, 0.84, 0.84, 0.3, 13.2, 2.86, 3.8);
  // A step ladder left open beside it.
  frame(11.6, 0, 2.6, 0.5, () => {
    for (const side of [-1, 1]) {
      rod(amberPaint, [side * 0.24, 0, 0.36], [side * 0.19, 1.5, 0], 0.016, { shadow: true }, 5);
      rod(amberPaint, [side * 0.24, 0, -0.42], [side * 0.19, 1.5, 0], 0.014, {}, 5);
      rod(metals.brushed, [side * 0.22, 0.62, 0.21], [side * 0.22, 0.62, -0.25], 0.007, {}, 4);
    }
    for (let i = 1; i <= 4; i += 1) box(metals.brushed, 0.42, 0.02, 0.1, 0, i * 0.3, 0.36 * (1 - i * 0.2));
    box(redPaint, 0.44, 0.04, 0.17, 0, 1.5, 0);
    rod(amberPaint, [-0.23, 0.5, -0.28], [0.23, 0.5, -0.28], 0.01, {}, 4);
  });
  place(new THREE.Mesh(softBox(0.8, 0.8, 3.2, 0.03, 1.6), metals.brushed), 13.2, 2.86, 5.2, true);
  place(new THREE.Mesh(softBox(0.8, 2.5, 0.8, 0.03, 1.6), metals.brushed), 13.2, 1.25, 1.2, true);
  place(new THREE.Mesh(softBox(0.8, 0.8, 3.2, 0.03, 1.6), metals.brushed), 13.2, 2.86, 2.4, true);
  // A floor vent on the -x deck breathing steam.
  place(new THREE.Mesh(softBox(1.5, 0.7, 1.5, 0.04, 1.6), plantPaint), -11.1, 0.35, 2.5, true, true);
  box(voidDark, 1.3, 0.01, 1.3, -11.1, 0.69, 2.5);
  for (let i = 0; i < 12; i += 1) box(metals.structural, 1.34, 0.035, 0.016, -11.1, 0.712, 1.9 + i * 0.109);
  for (const x of [-0.45, 0, 0.45]) box(metals.structural, 0.016, 0.02, 1.34, -11.1 + x, 0.7, 2.5);
  // A ridge skylight over the plant room stair, lit from below.
  {
    const cx = -13.5, cz = 1.9, kerb = 0.42, half = 0.85, rise = 0.56, length = 2.6;
    add(formwork, softBox(half * 2 + 0.2, kerb, length + 0.2, 0.03, 1.6), cx, kerb / 2, cz, { shadow: true });
    const slope = Math.hypot(half, rise), pitch = Math.atan2(rise, half);
    const rect = sheetCell(0);
    for (const side of [-1, 1]) {
      const pane = new THREE.PlaneGeometry(length - 0.08, slope - 0.04);
      const uv = pane.attributes.uv;
      for (let i = 0; i < 4; i += 1) uv.setXY(i, (rect[0] + uv.getX(i) * 480) / 1024, 1 - (rect[1] + (1 - uv.getY(i)) * 220) / 1024);
      pane.rotateY(side * Math.PI / 2);
      pane.rotateZ(side * (Math.PI / 2 - pitch));
      add(serviceGlow, pane, cx + side * half / 2, kerb + rise / 2 + 0.03, cz);
      for (let i = 0; i <= 5; i += 1) rod(metals.darkMetal, [cx + side * half, kerb + 0.05, cz - length / 2 + i * length / 5], [cx, kerb + rise + 0.05, cz - length / 2 + i * length / 5], 0.02, {}, 5);
      rod(metals.darkMetal, [cx + side * half, kerb + 0.05, cz - length / 2], [cx + side * half, kerb + 0.05, cz + length / 2], 0.028, {}, 5);
      const gable = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]));
      if (side < 0) gable.rotateY(Math.PI);
      add(metals.darkMetal, gable, cx, kerb + 0.05, cz + side * length / 2);
    }
    rod(metals.brushed, [cx, kerb + rise + 0.06, cz - length / 2 - 0.04], [cx, kerb + rise + 0.06, cz + length / 2 + 0.04], 0.035, {}, 6);
    halo([cx, kerb + 0.5, cz], 0xffb060, 0.45, true);
    floorPool(cx, cz, 3.4, 0xffa050, 0.12);
  }
  // Somebody's break spot: a crate for a table (placed with the props below), a lantern and a radio on it.
  const tableTop = props.get("crateLarge").size[1];
  cyl(metals.darkMetal, 0.06, 0.03, -11.75, tableTop + 0.015, 8.1, {}, 10); cyl(bulb, 0.045, 0.11, -11.75, tableTop + 0.085, 8.1, {}, 10); cyl(metals.darkMetal, 0.065, 0.03, -11.75, tableTop + 0.155, 8.1, {}, 10);
  add(metals.brushed, new THREE.TorusGeometry(0.05, 0.006, 4, 12), -11.75, tableTop + 0.2, 8.1);
  halo([-11.75, tableTop + 0.09, 8.1], 0xffc98a, 0.6);
  floorPool(-11.6, 7.6, 1.8, 0xffa050, 0.1);
  if (high) {
    add(screenPaint, softBox(0.24, 0.14, 0.08, 0.015, 1), -11.4, tableTop + 0.07, 8.35, { r: [0, 0.4, 0] });
    rod(metals.brushed, [-11.32, tableTop + 0.14, 8.33], [-11.2, tableTop + 0.44, 8.3], 0.004, {}, 4);
    box(ledGreen, 0.012, 0.012, 0.006, -11.44, tableTop + 0.1, 8.39, { r: [0, 0.4, 0] });
    cyl(redPaint, 0.04, 0.09, -11.85, tableTop + 0.045, 8.4, {}, 10);
  }

  // ---- Props ---------------------------------------------------------------
  // Loose things come from the shared library, queued group by group and placed as one batch per
  // kind. The edges of the lane hold what a serviced roof collects: a delivery by the plant door,
  // drums by the mains, the electricians' crate and cable drum, empties waiting at the stair head.
  const lots = new Map<string, { kind: PropKind; items: PropItem[] }>();
  /** Queues one prop. `lot` keeps bottles that stand far apart in separate batches, so their glass sorts locally. */
  const put = (kind: PropKind, x: number, y: number, z: number, yaw = 0, more: Partial<PropItem> = {}, lot = "") => {
    let entry = lots.get(kind + lot);
    if (!entry) { entry = { kind, items: [] }; lots.set(kind + lot, entry); }
    entry.items.push({ position: [x, y, z], rotation: [0, yaw, 0], ...more });
  };
  /** A group in its own frame: `u` runs along its front, `v` out toward whoever the front faces. */
  const group = (ox: number, oz: number, turn: number) => {
    const c = Math.cos(turn), s = Math.sin(turn);
    return (kind: PropKind, u: number, y: number, v: number, yaw = 0, more: Partial<PropItem> = {}, lot = "") => put(kind, ox + u * c + v * s, y, oz - u * s + v * c, turn + yaw, more, lot);
  };
  const tall = (kind: PropKind) => props.get(kind).size[1];
  const tipEuler = new THREE.Euler(), tipMatrix = new THREE.Matrix4();
  /** Rotation of a thing tipped about its own axes first and turned about the vertical after. */
  const tipped = (pitch: number, yaw: number, roll = 0): V3 => {
    tipEuler.setFromRotationMatrix(tipMatrix.makeRotationFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ")), "XYZ");
    return [tipEuler.x, tipEuler.y, tipEuler.z];
  };
  // Yaw that turns a front (label, stencil, print) toward the lane from each wall.
  const WEST = Math.PI / 2, EAST = -Math.PI / 2, BACK = Math.PI;
  const P = tall("pallet"), CRATE = tall("crateLarge"), TRAY = tall("cratePlastic");
  const drumTeal = 0x1d6a63, drumRust = 0x8a4a16, trayRed = 0x8c2218, trayYellow = 0xb48a1c;

  // By the plant door: a delivery half unpacked on its pallet, the flattened boxes waiting to go down.
  {
    const load = group(-8.72, -1.72, WEST + 0.06), big = tall("cartonLarge"), mid = tall("carton");
    load("pallet", 0, 0, 0);
    load("cartonLarge", -0.315, P, -0.16, 0.02); load("cartonLarge", 0.325, P, -0.165, -0.03); load("carton", 0.29, P, 0.29, -0.06);
    load("cartonLarge", -0.26, P + big, -0.12, 0.09); load("carton", 0.36, P + big, -0.16, -0.14);
    if (high) { load("cartonSmall", -0.34, P + big * 2, -0.1, 0.5); load("cartonSmall", 0.33, P + big + mid, -0.17, -0.3); }
    put("cartonCrushed", -8.38, 0, -2.84, 0.9);
    put("cartonFlat", -8.98, 0, -2.84, 1.75); put("cartonFlat", -8.95, tall("cartonFlat"), -2.8, 1.48);
    put("cartonOpen", -8.42, 0, -0.66, 2.6);
  }
  // Drums by the service mains, under the range sign.
  put("drum", -8.88, 0, -13.0, WEST + 0.5, { tint: drumTeal });
  put("drumPlastic", -8.86, 0, -12.3, WEST - 0.3);
  put("drum", -8.28, 0, -12.68, WEST + 1.9, { tint: drumRust });
  // The electricians' corner by the switchgear: a crate still on its pallet, a smaller one, a cable drum.
  put("pallet", -8.48, 0, -20.8, WEST + 0.04);
  put("crateLarge", -8.5, P, -20.78, WEST + 0.09);
  put("crateSmall", -8.3, 0, -19.6, WEST - 0.42);
  // Screen boxes left beside the control desk.
  put("cartonTall", -8.93, 0, -25.55, WEST + 0.25);
  put("cartonLarge", -8.9, 0, -26.3, WEST - 0.08);
  if (high) put("cartonSmall", -8.92, tall("cartonLarge"), -26.24, WEST + 0.6);

  // Crates under the yard lamp, clear of the fire point.
  put("crateLarge", 8.52, 0, -3.05, EAST + 0.07);
  put("crateSmall", 8.56, CRATE, -3.2, EAST - 0.22);
  put("crateSmall", 8.55, 0, -4.12, EAST + 0.38);
  // Empty pallets: two flat, one stood against the screen.
  put("pallet", 8.3, 0, -5.45, EAST + 0.05); put("pallet", 8.33, P, -5.4, EAST - 0.07);
  put("pallet", 9.37, 0.371, -5.5, 0, { rotation: tipped(-1.187, Math.PI / 2) });
  // Drums tucked against the screen before the furnace, one behind the control desk.
  put("drum", 9.04, 0, -7.6, EAST + 0.3, { tint: drumRust });
  put("drum", 8.98, 0, -8.3, EAST - 0.8, { tint: drumTeal });
  put("drum", 8.97, 0, -26.05, EAST + 0.9, { tint: drumRust });
  // Under the far yard lamp, between the two signs.
  put("crateLarge", 8.5, 0, -19.85, EAST - 0.06);
  put("crateSmall", 8.53, CRATE, -19.7, EAST + 0.3);

  // Empties waiting at the stair head: bottle crates against the glass, a keg.
  put("cratePlastic", 9.44, 0, 9.44, BACK + 0.05, { tint: trayRed }); put("cratePlastic", 9.43, TRAY, 9.45, BACK - 0.09, { tint: trayRed }); put("cratePlastic", 9.45, TRAY * 2, 9.43, BACK + 0.14, { tint: trayYellow });
  put("cratePlastic", 9.4, 0, 9.03, BACK - 0.07, { tint: trayYellow });
  {
    const tray = group(9.41, 9.02, BACK + 0.18);
    tray("cratePlastic", 0, TRAY, 0, 0, { tint: trayRed });
    [0, 1, 2, 4, 5, 7, 9, 10, 11].forEach((pocket, i) => tray(i % 3 === 1 ? "bottleSoda" : "bottleBeer", -0.138 + (pocket % 4) * 0.092, TRAY + 0.012, -0.092 + Math.floor(pocket / 4) * 0.092, pocket * 1.7, {}, "stair"));
  }
  put("keg", 9.42, 0, 8.56, 0.7);
  // Supplies for the bar staged under the louvre at the other end of the wall.
  const SLAT = tall("crateSlat");
  put("crateSlat", -8.55, 0, 9.3, BACK + 0.06); put("crateSlat", -8.52, SLAT, 9.28, BACK - 0.15); put("crateSlat", -7.8, 0, 9.2, BACK + 0.55);
  put("keg", -9.25, 0, 9.3, 0.3); put("keg", -9.22, 0, 8.82, 2);
  if (high) {
    const room = props.get("crateSlat").inside;
    if (room) kit.mirrorHidden.push(...props.heap("lemon", { at: [-8.52, SLAT + room.floor, 9.28], ...(room.size ? { size: room.size } : { radius: room.radius }), yaw: BACK - 0.15, rim: room.rim, flare: room.flare, count: 30, seed: 5 }).meshes);
  }

  // The break spot's table, the bar's kegs and crates on the -x deck.
  put("crateLarge", -11.6, 0, 8.2, WEST + 0.08);
  if (high) { put("tin", -11.47, tableTop, 7.93, 0.6); put("tin", -11.36, tableTop, 8.02, 2.2); }
  put("keg", -15.1, 0, 3.75, 0.2); put("keg", -14.68, 0, 3.98, 1.9); put("keg", -14.9, tall("keg"), 3.86, 3.1);
  put("cratePlastic", -14.12, 0, 3.8, 0.5, { tint: trayYellow });
  put("cratePlastic", -12.36, 0.05, 4.62, WEST + 0.1, { tint: trayYellow }); put("cratePlastic", -12.38, 0.05 + TRAY, 4.63, WEST - 0.12, { tint: trayRed });
  // The +x deck beside the air handler: its water treatment, a crate, spare pallets.
  put("crateLarge", 11.45, 0, 8.68, EAST + 0.15);
  put("crateSlat", 11.42, CRATE, 8.72, EAST - 0.3);
  put("pallet", 12.75, 0, 8.84, 0.25); put("pallet", 12.72, P, 8.82, 0.12);
  put("drumPlastic", 14.62, 0, 8.52, 2.2); put("drumPlastic", 15.06, 0, 7.96, 0.6);
  put("drum", 14.22, 0, 7.98, -1.2, { tint: drumTeal });

  // Cable drums are the map's own: one on its side by the switchgear, one standing under the yard lamp, one on the +x deck.
  const spool = spoolGeometry(), spoolSpots: Transform[] = [
    { position: [-7.75, 0.62, -23.2], rotation: [0, 0.12, Math.PI / 2] },
    { position: [8.72, 0, -18], rotation: [0, 0.5, 0] },
    { position: [14.7, 0.62, 1.9], rotation: [0, 1.2, Math.PI / 2] },
  ];
  instances(spool.timber, metals.crate, spoolSpots);
  instances(spool.steel, metals.brushed, spoolSpots, false, false);
  const coil = new THREE.CylinderGeometry(0.31, 0.31, 0.6, 24, 1, true);
  instances(coil, new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.55, metalness: 0 }), [
    { position: [-8.15, 0.62, -23.2], rotation: [0, 0.12, Math.PI / 2] }, { position: [8.72, 0.4, -18] },
  ], false, false);

  // ---- The -x deck: a bar under a canopy, planters; a pigeon loft on the core roof ----
  const scatter = rng(808);
  // Pigeon loft.
  frame(-1.8, 8.64, 11.3, Math.PI, () => {
    for (const x of [-1.26, 1.26]) { box(metals.crate, 0.08, 2.0, 0.08, x, 1.0, 0.71, { shadow: true }); box(metals.crate, 0.08, 1.75, 0.08, x, 0.875, -0.71); }
    box(metals.crate, 2.6, 1.45, 0.03, 0, 1.03, -0.73, { uv: 1.1, shadow: true });
    for (const x of [-1.28, 1.28]) box(metals.crate, 0.03, 1.45, 1.42, x, 1.03, 0, { uv: 1.1, shadow: true });
    box(metals.crate, 2.6, 0.05, 1.5, 0, 0.3, 0, { uv: 1.1, shadow: true });
    for (const y of [0.33, 1.96]) box(metals.crate, 2.6, 0.07, 0.06, 0, y, 0.71);
    for (const x of [-0.42, 0.42]) box(metals.crate, 0.05, 1.6, 0.05, x, 1.14, 0.71);
    box(metals.crate, 2.44, 0.03, 0.42, 0, 1.2, -0.5);
    for (let i = 0; i < 5; i += 1) box(metals.crate, 0.03, 0.3, 0.42, -1.2 + i * 0.6, 1.36, -0.5);
    rod(metals.crate, [-1.25, 0.85, 0.15], [1.25, 0.85, 0.15], 0.015, {}, 5);
    rod(metals.crate, [-1.25, 1.55, -0.05], [1.25, 1.55, -0.05], 0.015, {}, 5);
    box(sheeting, 3.0, 0.03, 1.95, 0, 1.99, 0, { r: [-0.165, 0, 0], uv: 1.3, shadow: true });
    box(metals.crate, 0.6, 0.02, 0.24, -0.8, 1.02, 0.86);
    box(metals.brushed, 0.03, 0.08, 0.015, 0.39, 1.1, 0.745);
    if (high) {
      // Wire front.
      for (let i = 1; i < 31; i += 1) box(metals.brushed, 0.005, 1.6, 0.005, -1.24 + i * 0.08, 1.14, 0.735);
      for (let i = 0; i < 16; i += 1) box(metals.brushed, 2.48, 0.005, 0.005, 0, 0.4 + i * 0.1, 0.735);
      const pigeon = (x: number, y: number, z: number, turn: number) => {
        ball(feather, 0.075, x, y + 0.07, z, { s: [0.8, 0.85, 1.5], r: [0, turn, 0] });
        ball(feather, 0.036, x + Math.sin(turn) * 0.1, y + 0.16, z + Math.cos(turn) * 0.1);
        box(feather, 0.05, 0.012, 0.1, x - Math.sin(turn) * 0.13, y + 0.06, z - Math.cos(turn) * 0.13, { r: [0.25, turn, 0] });
        box(amberPaint, 0.012, 0.012, 0.03, x + Math.sin(turn) * 0.14, y + 0.155, z + Math.cos(turn) * 0.14, { r: [0, turn, 0] });
      };
      // These roost behind the wire. The ones that come and go on the loft roof and along the rails are alive (see Life).
      pigeon(0.3, 0.865, 0.15, 1.4); pigeon(0.8, 1.565, -0.05, -1.3); pigeon(-0.4, 1.565, -0.05, 1.7);
    }
  });
  // Planters of feather grass, a small olive in a concrete tub, and what has sown itself where the deck meets the walls.
  const planters: Array<[number, number]> = [[-11.2, 0.74], [11.0, 0.74]];
  for (const [x, z] of planters) frame(x, 0, z, 0, () => {
    box(metals.crate, 1.8, 0.55, 0.6, 0, 0.275, 0, { uv: 1.1, shadow: true });
    box(metals.crate, 1.88, 0.05, 0.68, 0, 0.57, 0, { uv: 1.1 });
    for (const end of [-0.86, 0.86]) box(metals.darkMetal, 0.04, 0.5, 0.64, end, 0.27, 0);
    box(soil, 1.7, 0.02, 0.5, 0, 0.6, 0);
  });
  const tubX = -11.05, tubZ = 8.55;
  cyl(formwork, 0.36, 0.62, tubX, 0.31, tubZ, { shadow: true }, 18);
  add(metals.darkMetal, new THREE.TorusGeometry(0.36, 0.025, 5, 18), tubX, 0.62, tubZ, { r: AZ });
  {
    const sow = rng(909), turn = () => sow() * Math.PI * 2;
    // Small plants stay out of the floor's mirror: they are too fine to show in a wet deck and would be drawn twice for nothing.
    const plant = (kind: TreeKind, items: TreeItem[], shadow = false) => kit.mirrorHidden.push(...trees.place(kind, items, { shadow }));
    const tall: TreeItem[] = [], tufts: TreeItem[] = [], strips: TreeItem[] = [], weeds: TreeItem[] = [], runs: TreeItem[] = [];
    for (const [x, z] of planters) {
      for (const along of [-0.64, -0.24, 0.2, 0.62]) tall.push({ at: [x + along + (sow() - 0.5) * 0.1, 0.6, z + (sow() - 0.5) * 0.16], yaw: turn(), scale: 1.7 + sow() * 0.7, variant: 1, dry: 0.15 + sow() * 0.3 });
      for (const along of [-0.8, -0.42, 0, 0.42, 0.8]) tufts.push({ at: [x + along + (sow() - 0.5) * 0.08, 0.6, z + (sow() < 0.5 ? -0.19 : 0.19)], yaw: turn(), scale: 1.2 + sow() * 0.5, variant: 0, dry: sow() * 0.35 });
    }
    // Along the foot of the plant room, under the mains, and along the screen: dry grass in the joint, a weed every few metres.
    for (const z of [-27.5, -24.6, -19.3, -15.2, -8.7, -2.5]) weeds.push({ at: [-9.39, 0, z + (sow() - 0.5) * 0.6], yaw: turn(), scale: 0.9 + sow() * 0.6, variant: 0 });
    for (const z of [-26.6, -22.4, -14.7, -9.2, -0.7]) weeds.push({ at: [9.44, 0, z + (sow() - 0.5) * 0.6], yaw: turn(), scale: 0.9 + sow() * 0.6, variant: 0 });
    for (const z of [-25.8, -21.2, -17.0, -6.2]) strips.push({ at: [-9.4, 0, z], yaw: Math.PI / 2 + (sow() - 0.5) * 0.1, scale: 0.9 + sow() * 0.3, variant: 2, dry: 0.5 + sow() * 0.4 });
    for (const z of [-24.4, -16.3, -7.4, -2.2]) strips.push({ at: [9.45, 0, z], yaw: Math.PI / 2 + (sow() - 0.5) * 0.1, scale: 0.9 + sow() * 0.3, variant: 2, dry: 0.5 + sow() * 0.4 });
    // On the side decks: round the planters and the tub, in the corners by the core.
    for (const [x, z] of [[-10.2, 0.4], [-12.25, 0.42], [-9.95, 9.5], [-11.7, 9.55], [-11.55, 8.2], [10.0, 0.42], [12.1, 0.4], [10.4, 9.55], [14.7, 3.4]]) weeds.push({ at: [x, 0, z], yaw: turn(), scale: 0.85 + sow() * 0.6, variant: 0 });
    for (const [x, z, yaw] of [[-13.2, 0.38, 0], [12.9, 9.56, 0], [-13.4, 9.58, 0], [13.6, 0.4, 0]]) runs.push({ at: [x, 0, z], yaw, scale: 1, variant: 2 });
    for (const [x, z] of [[-11.5, 1.2], [-10.6, 8.0], [-11.6, 9.0], [10.3, 1.15], [11.9, 1.2]]) tufts.push({ at: [x, 0, z], yaw: turn(), scale: 1 + sow() * 0.5, variant: 0, dry: 0.3 + sow() * 0.4 });
    plant("grass", [...tall, ...tufts, ...strips]);
    plant("weeds", [...weeds, ...runs]);
    // The olive: its trunk comes out of a mound of soil in the tub, its litter lies downwind of it.
    plant("olive", [{ at: [tubX, 0.6, tubZ], yaw: 2.2, scale: 0.38, variant: 0, lean: [-0.05, 0.02] }], true);
    plant("soilRing", [{ at: [tubX, 0.59, tubZ], scale: 0.86, variant: 1 }]);
    plant("leafLitter", [{ at: [tubX - 0.25, 0.012, tubZ - 0.5], yaw: 0.6, scale: 0.8, variant: 0 }]);
    // A fern on the end of the bar.
    plant("potFern", [{ at: [-13.3, 1.125, 8.32], yaw: 0.8, scale: 0.55, variant: 0 }]);
  }
  // The bar: counter, back bar with its bottles, stools, a canopy and a tube sign.
  const buyZone = wordStrokes("BUY ZONE", 0.27, 0.36);
  // The Z is failing: a tube and a spill of its own, so it can stutter by itself while the rest of the sign holds.
  const isZ = (stroke: number[][]) => stroke.every(([x]) => x > 0.05 && x < 0.3);
  const buySteady = buyZone.filter((stroke) => !isZ(stroke)), buyFailing = buyZone.filter(isZ);
  const neonFailing = neonAmber.clone();
  frame(-13.6, 0, 6.6, Math.PI / 2, () => {
    box(metals.crate, 4.7, 0.05, 3.3, 0, 0.025, -0.15, { uv: 1.1 });
    box(metals.crate, 4.2, 1.05, 0.5, 0, 0.55, 0.25, { uv: 1.1, shadow: true });
    add(metals.brushed, softBox(4.4, 0.05, 0.72, 0.015, 1), 0, 1.1, 0.27, { shadow: true });
    rod(metals.brushed, [-2.0, 0.22, 0.64], [2.0, 0.22, 0.64], 0.02, {}, 6);
    for (const x of [-1.9, -0.63, 0.63, 1.9]) rod(metals.brushed, [x, 0.22, 0.5], [x, 0.22, 0.64], 0.012, {}, 4);
    box(amberTube, 4.0, 0.02, 0.02, 0, 1.05, 0.515);
    // Beer font and glasses.
    cyl(metals.brushed, 0.035, 0.34, -1.2, 1.3, 0.2, {}, 10); rod(metals.brushed, [-1.42, 1.47, 0.2], [-0.98, 1.47, 0.2], 0.03, {}, 8);
    for (const x of [-1.36, -1.2, -1.04]) { box(metals.darkMetal, 0.025, 0.12, 0.025, x, 1.56, 0.24); cyl(metals.brushed, 0.01, 0.06, x, 1.44, 0.26, {}, 5); }
    if (high) for (let i = 0; i < 7; i += 1) cyl(metals.brushed, 0.03, 0.11, 0.2 + i * 0.22 + scatter() * 0.05, 1.18, 0.1 + scatter() * 0.3, {}, 8);
    // Back bar.
    add(screenPaint, softBox(4.2, 2.1, 0.3, 0.02, 1.6), 0, 1.05, -1.32, { shadow: true });
    box(warmPanel, 3.9, 1.3, 0.01, 0, 1.5, -1.16);
    for (const y of [1.0, 1.45, 1.9]) { box(metals.crate, 3.96, 0.03, 0.24, 0, y, -1.06); box(bulb, 3.8, 0.012, 0.012, 0, y - 0.022, -0.96); }
    // Bottles shelved in runs of a kind, labels out; the top shelf holds the few nobody asks for.
    for (const [row, y] of [1.015, 1.465, 1.915].entries()) {
      if (row === 2 && !high) break;
      for (let at = -1.84 + scatter() * 0.08; at < 1.84;) {
        const kind: PropKind = scatter() < 0.56 ? "bottleSpirits" : "bottleWine", variant = Math.floor(scatter() * 3);
        const run = row === 2 ? 2 : 2 + Math.floor(scatter() * 4), step = (kind === "bottleSpirits" ? 0.128 : 0.112) * (high ? 1 : 1.8);
        for (let k = 0; k < run && at < 1.84; k += 1, at += step) put(kind, -14.66 + (scatter() - 0.5) * 0.04, y, 6.6 - at, WEST + (scatter() - 0.5) * 0.5, { variant }, "bar");
        at += row === 2 ? 0.5 + scatter() * 0.9 : 0.06 + scatter() * 0.2;
      }
    }
    // On the counter: two beers left standing, a bottle by the till end, snack tins.
    if (high) {
      put("bottleBeer", -13.4, 1.125, 6.8, 1.1, {}, "bar"); put("bottleBeer", -13.27, 1.125, 6.94, 3.9, {}, "bar");
      put("bottleSpirits", -13.4, 1.125, 4.74, WEST + 0.4, {}, "bar");
      put("tin", -13.48, 1.125, 7.32, 0.3); put("tin", -13.4, 1.125, 7.41, 1.7);
    }
    // Canopy.
    for (const x of [-2.2, 2.2]) { rod(metals.structural, [x, 0, 1.0], [x, 2.78, 1.0], 0.035, { shadow: true }, 8); rod(metals.structural, [x, 0, -1.5], [x, 2.52, -1.5], 0.035, {}, 8); rod(metals.structural, [x, 2.75, 1.0], [x, 2.5, -1.5], 0.03, {}, 6); }
    for (const z of [1.0, -0.25, -1.5]) rod(metals.structural, [-2.35, 2.625 + z * 0.1 + 0.02, z], [2.35, 2.625 + z * 0.1 + 0.02, z], 0.025, {}, 6);
    box(sheeting, 4.9, 0.03, 3.1, 0, 2.7, -0.25, { r: [-0.1, 0, 0], uv: 1.3, shadow: true });
    box(metals.darkMetal, 4.5, 0.44, 0.04, 0, 2.46, 1.04);
    frame(0, 2.46, 1.06, 0, () => { tubes(buySteady, neonAmber, 0.012, 0.04); tubes(buyFailing, neonFailing, 0.012, 0.04); });
    // Stools.
    for (const x of [-1.5, -0.5, 0.5, 1.5]) {
      cyl(metals.darkMetal, 0.17, 0.02, x, 0.01, 0.98, {}, 14);
      cyl(metals.brushed, 0.025, 0.72, x, 0.37, 0.98, {}, 8);
      add(metals.brushed, new THREE.TorusGeometry(0.13, 0.01, 4, 14), x, 0.3, 0.98, { r: AZ });
      cyl(rubber, 0.17, 0.06, x, 0.76, 0.98, { shadow: true }, 14);
    }
  });
  glowPlane(track(haloTexture(buySteady, 3.2, 0.6, "#ffa040")), 3.2, 0.6, -12.515, 2.46, 6.6, Math.PI / 2, 1.3);
  const failingSpill = glowPlane(track(haloTexture(buyFailing, 3.2, 0.6, "#ffa040")), 3.2, 0.6, -12.515, 2.46, 6.6, Math.PI / 2, 1.3);
  life.flicker([neonFailing, failingSpill.material as THREE.Material], "dead", { at: [-12.5, 2.46, 6.42], rate: 0.6 });
  floorPool(-11.5, 6.6, 3.0, 0xe89a42, 0.15);
  halo([-14.4, 1.5, 6.6], 0xffb878, 0.3, true);
  // Chalk board on an easel, high enough to be read over the balustrade's handrail from the range; a bistro table with folding chairs.
  frame(-11.75, 0, 3.95, Math.PI / 2 - 0.35, () => {
    card(labels, 0.5, 1.0, 0, 1.26, 0.02, LABELS.menu, [2048, 1024], { r: [-0.22, 0, 0] });
    box(metals.crate, 0.54, 1.04, 0.02, 0, 1.26, 0.006, { r: [-0.22, 0, 0], shadow: true });
    box(metals.crate, 0.62, 0.03, 0.07, 0, 0.74, 0.13, { r: [-0.22, 0, 0] });
    for (const side of [-1, 1]) rod(metals.crate, [side * 0.36, 0, 0.27], [side * 0.05, 1.92, -0.16], 0.016, { shadow: true }, 4);
    rod(metals.crate, [0, 1.86, -0.15], [0, 0, -0.62], 0.016, {}, 4);
  });
  {
    const x = -10.85, z = 6.2;
    cyl(metals.darkMetal, 0.22, 0.02, x, 0.01, z, {}, 16);
    cyl(metals.brushed, 0.03, 0.72, x, 0.37, z, {}, 8);
    cyl(metals.brushed, 0.36, 0.025, x, 0.735, z, { shadow: true }, 20);
    // A candle stuck in a wine bottle, and what the last table left.
    const top = 0.7475, flame = top + tall("bottleWine");
    put("bottleWine", x + 0.05, top, z, 0.8, {}, "bar");
    put("bottleBeer", x - 0.14, top, z - 0.12, 2.1, {}, "bar"); put("bottleBeer", x + 0.12, top, z + 0.19, 4, {}, "bar");
    cyl(bulb, 0.009, 0.05, x + 0.05, flame + 0.02, z, {}, 6);
    halo([x + 0.05, flame + 0.05, z], 0xffb060, 0.5);
    chair(x + 0.1, z - 0.75, 0.15); chair(x - 0.05, z + 0.78, Math.PI - 0.3);
  }
  // Everything queued above goes in, one batch per kind. Bottles and tins are too small to matter in the wet floor.
  for (const { kind, items } of lots.values()) {
    const meshes = props.place(kind, items);
    if (props.get(kind).scale === "small") kit.mirrorHidden.push(...meshes);
  }
  // Festoon lights from the plant room wall to the canopy, and along the glass to the stair core.
  const pole: V3 = [-10.08, 3.7, 5.0];
  rod(metals.structural, [pole[0], 0, pole[2]], [pole[0], pole[1] + 0.1, pole[2]], 0.03, { shadow: true }, 6);
  cyl(metals.darkMetal, 0.12, 0.02, pole[0], 0.01, pole[2], {}, 10);
  const spans: Array<[V3, V3]> = [[[-10.15, 4.5, 0.34], pole], [pole, [-10.3, 4.4, 9.66]], [[-13.2, 4.6, 0.34], [-12.6, 2.85, 4.4]], [[-12.6, 2.85, 8.8], [-12.2, 4.3, 9.66]], [[-12.6, 2.85, 4.4], pole]];
  let bulbs = 0;
  for (const [a, b] of spans) {
    const sag = 0.3;
    slack(rubber, a, b, sag, 0.008);
    const run = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), count = Math.max(2, Math.round(run / (high ? 0.5 : 1)));
    for (let i = 1; i < count; i += 1) {
      const t = i / count, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t) - 0.07, z = a[2] + (b[2] - a[2]) * t;
      cyl(rubber, 0.014, 0.04, x, y + 0.045, z, {}, 5);
      ball(bulb, 0.034, x, y, z);
      if ((bulbs += 1) % 2 === 0) halo([x, y, z], 0xffb878, 0.38);
    }
  }
  for (const [a] of spans.slice(0, 1).concat(spans.slice(2, 3))) box(metals.darkMetal, 0.08, 0.08, 0.04, a[0], a[1], a[2] - 0.02);
  // Cat ladder up the end of the plant room.
  frame(-14.85, 0.3, 0.3, 0, () => ladder(PLANT_TOP + 0.9, 2.6));

  // ---- Core roof: dishes ----------------------------------------------------
  for (const [x, z, tilt, turn, size] of [[-4.6, 10.6, 0.65, 0.5, 0.7], [-6.8, 11.2, 0.5, -0.4, 0.5]]) {
    const y = coreTop + 0.24;
    cyl(metals.structural, 0.04, 1.1, x, y + 0.55, z, { shadow: true }, 8);
    box(metals.darkMetal, 0.4, 0.04, 0.4, x, y + 0.02, z);
    add(dishPaint, dish, x, y + 1.15, z, { r: [tilt, turn, 0], s: [size, size, size], shadow: true });
    rod(metals.structural, [x, y + 1.15, z], [x - Math.sin(turn) * Math.cos(tilt) * size * 0.75, y + 1.15 + Math.sin(tilt) * size * 0.75, z - Math.cos(turn) * Math.cos(tilt) * size * 0.75], 0.012, {}, 4);
  }

  // ---- The city --------------------------------------------------------------
  // Laid out around the roof like a real district: a lane and two close neighbours down range with
  // a canyon between them that ends on a tall tower, towers looming over both side walls, an
  // elevated expressway along the +x avenue, a hotel and an office tower behind the stair core,
  // then rings of towers out to where the haze takes them.
  const cityTexture = (url: string, colour: boolean) => {
    const texture = track(new THREE.TextureLoader(options.loadingManager).load(url));
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = anisotropy;
    if (colour) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  const plaster = { map: cityTexture("/textures/painted_plaster_wall-2k/diffuse.jpg", true), normalMap: cityTexture("/textures/painted_plaster_wall-2k/normal-gl.jpg", false) };
  const city = createCity([brick, board, plaster, iron], !high);
  const { at, wall, plate, pool, slab, mass, tube, bar, relief } = city;
  const windows = (kind: number, bay: number, storey: number, margin: number, sill: number, head: number, reveal: number, lit: number, warmth: number, tint: V3, seed: number, scale = 0.38): Face =>
    ({ kind, cell: [bay, storey], win: [margin, sill, head, reveal], look: [lit, warmth, 0, scale], tint, seed });
  const plain = (tint: V3, scale = 0.38, gloss = 0.2): Face => ({ kind: 0, cell: [1, 1], win: [0, 0, 0, 0], look: [gloss, 0, 0, scale], tint, seed: 0 });
  const glowing = (tint: V3, gain: number, blink = 0, phase = 0): Face => ({ kind: 6, cell: [1, 1], win: [0, 0, 0, 0], look: [gain, blink, phase, 0], tint, seed: 0 });
  const roofing = (seed: number, tint: V3 = [0.055, 0.055, 0.062]): Face => ({ kind: 5, cell: [1, 1], win: [0, 0, 0, 0], look: [0, 0, 0, 0], tint, seed });
  const WARM: V3 = [1, 0.62, 0.3], COOL: V3 = [0.75, 0.87, 1], TEAL: V3 = [0.27, 0.91, 0.77], AMBER: V3 = [0.9, 0.42, 0.1], PINK: V3 = [1, 0.25, 0.55], RED: V3 = [1, 0.07, 0.04];
  const scaled = (colour: V3, k: number): V3 => [colour[0] * k, colour[1] * k, colour[2] * k];
  const steel = plain([0.2, 0.2, 0.22], 0, 0.5), darkSteel = plain([0.09, 0.09, 0.1], 0, 0.5), aluminium = plain([0.5, 0.52, 0.55], 0, 0.8);
  const stoneTrim = plain([1.1, 1.08, 1.02], 0.3, 0.15), concretePlain = plain([1.25, 1.25, 1.3], 0.3, 0.15), brickPlain = plain([1.55, 1.3, 1.2]);
  const ribbed = plain([0.55, 0.6, 0.66], 0.5, 0.5), louvre = plain([0.3, 0.33, 0.37], 1.1, 0.5), timberTank = plain([0.8, 0.5, 0.3], 0.45, 0.1);
  const far: Lay = { mirror: false };
  const footprints: Array<[number, number, number, number]> = [[43, 61, -600, 600], [-16, 14, -175, -100], [-20, 20, -40, 20]];
  /** Thin walls around a roof, with a coping stone. */
  const parapet = (sheet: number, face: Face, x0: number, x1: number, z0: number, z1: number, y: number, height = 1.1, thick = 0.35, coping: Face | null = stoneTrim) => {
    slab(sheet, face, x0, x1, y, y + height, z1 - thick, z1, { ...far, skip: "b" });
    slab(sheet, face, x0, x1, y, y + height, z0, z0 + thick, { ...far, skip: "b" });
    slab(sheet, face, x0, x0 + thick, y, y + height, z0 + thick, z1 - thick, { ...far, skip: "bns" });
    slab(sheet, face, x1 - thick, x1, y, y + height, z0 + thick, z1 - thick, { ...far, skip: "bns" });
    if (!coping) return;
    const lip = 0.07, c0 = y + height, c1 = c0 + 0.1;
    slab(PLASTER, coping, x0 - lip, x1 + lip, c0, c1, z1 - thick - lip, z1 + lip, far);
    slab(PLASTER, coping, x0 - lip, x1 + lip, c0, c1, z0 - lip, z0 + thick + lip, far);
    slab(PLASTER, coping, x0 - lip, x0 + thick + lip, c0, c1, z0 + thick + lip, z1 - thick - lip, { ...far, skip: "ns" });
    slab(PLASTER, coping, x1 - thick - lip, x1 + lip, c0, c1, z0 + thick + lip, z1 - thick - lip, { ...far, skip: "ns" });
  };
  /** A cooling tower: a ribbed drum on a skid, a dark throat, a lit service lamp. */
  const coolingTower = (x: number, z: number, y: number, radius: number, height: number) => {
    slab(METAL, darkSteel, x - radius * 0.9, x + radius * 0.9, y, y + 0.3, z - radius * 0.9, z + radius * 0.9, { ...far, skip: "b" });
    tube(METAL, ribbed, x, z, radius, radius * 0.92, y + 0.3, y + 0.3 + height, 14, far);
    tube(METAL, aluminium, x, z, radius * 0.8, radius * 0.74, y + 0.3 + height, y + 0.75 + height, 14, { ...far, cap: plain([0.02, 0.02, 0.025], 0) });
  };
  /** A stair bulkhead with a lit doorway on its +z side and the light it throws on the roof. */
  const stairHead = (sheet: number, face: Face, roof: Face, x: number, z: number, y: number, w = 3.4, d = 4.2, h = 2.9) => {
    slab(sheet, face, x, x + w, y, y + h, z, z + d, { ...far, skip: "b" });
    slab(PLASTER, stoneTrim, x - 0.12, x + w + 0.12, y + h, y + h + 0.14, z - 0.12, z + d + 0.12, far);
    slab(METAL, darkSteel, x + w / 2 - 0.5, x + w / 2 + 0.5, y + 0.03, y + 2.1, z + d, z + d + 0.06, { ...far, skip: "nb" });
    slab(METAL, glowing(WARM, 4.5), x + w / 2 - 0.22, x + w / 2 + 0.22, y + 2.28, y + 2.4, z + d, z + d + 0.14, { ...far, skip: "n" });
    pool(sheet, roof, x + w / 2, z + d + 1.1, y + 0.05, 4.2, scaled(WARM, 7));
    halo([x + w / 2, y + 2.3, z + d + 0.3], 0xffb060, 0.7, true);
  };
  /** A row of condensing units. */
  const condensers = (x: number, z: number, y: number, count: number, alongX: boolean) => {
    for (let i = 0; i < count; i += 1) {
      const px = alongX ? x + i * 1.5 : x, pz = alongX ? z : z + i * 1.5;
      slab(METAL, ribbed, px, px + 1.1, y + 0.12, y + 1.05, pz, pz + 1.0, { ...far, skip: "b" });
      tube(METAL, darkSteel, px + 0.55, pz + 0.5, 0.36, 0.36, y + 1.05, y + 1.12, 8, { ...far, cap: plain([0.02, 0.02, 0.025], 0) });
    }
  };
  /** A lattice mast with a blinking beacon. */
  const mast = (x: number, z: number, y: number, height: number, phase: number) => {
    bar(METAL, steel, [x, y, z], [x, y + height, z], height > 14 ? 0.16 : 0.09);
    for (const k of [0.45, 0.7, 0.88]) bar(METAL, steel, [x - 1.1 * (1 - k), y + height * k, z], [x + 1.1 * (1 - k), y + height * k, z], 0.05);
    slab(METAL, glowing(RED, 7, 1.7, phase), x - 0.28, x + 0.28, y + height, y + height + 0.56, z - 0.28, z + 0.28, far);
  };
  /** A cylindrical tank on legs. */
  const tank = (x: number, z: number, y: number, radius: number, height: number, face: Face = ribbed) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) bar(METAL, steel, [x + a * radius * 0.7, y, z + b * radius * 0.7], [x + a * radius * 0.62, y + 1.2, z + b * radius * 0.62], 0.07);
    tube(METAL, face, x, z, radius, radius, y + 1.2, y + 1.2 + height, 16, far);
    tube(METAL, steel, x, z, radius * 1.04, 0.15, y + 1.2 + height, y + 1.2 + height + radius * 0.5, 16, far);
  };
  /** A light on a roof: a short post, a lamp head and the pool under it. */
  const roofLamp = (sheet: number, roof: Face, x: number, z: number, y: number, colour: V3, hex: number) => {
    bar(METAL, steel, [x, y, z], [x, y + 3.2, z], 0.05);
    slab(METAL, glowing(colour, 5), x - 0.2, x + 0.2, y + 3.2, y + 3.3, z - 0.12, z + 0.12, far);
    pool(sheet, roof, x, z, y + 0.05, 5.5, scaled(colour, 8));
    halo([x, y + 3.15, z], hex, 0.7, true);
  };

  // A: the brick loft building across the lane, left of the gap. Six storeys show above our deck.
  {
    const x0 = -32, x1 = -8, z0 = -60, z1 = -44, top = 21;
    footprints.push([x0, x1, z0, z1]);
    const loft = windows(1, 3.0, 3.5, 0.74, 0.95, 2.82, 0.26, 0.44, 0.82, [1.55, 1.3, 1.2], 11);
    const partyWall = windows(1, 4.0, 3.5, 1.35, 1.1, 2.6, 0.26, 0.22, 0.8, [1.3, 1.12, 1.05], 12);
    wall(BRICK, loft, x0, z1, x1, z1, STREET, top);
    wall(BRICK, partyWall, x1, z1, x1, z0, STREET, top);
    wall(BRICK, partyWall, x0, z0, x0, z1, STREET, top);
    wall(BRICK, loft, x1, z0, x0, z0, STREET, top);
    const loftRoof = roofing(3);
    plate(BRICK, loftRoof, x0, z0, x1, z1, top);
    for (const side of ["s", "e"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      const bays = side === "s" ? 8 : 4, bay = run / bays;
      for (let i = 0; i <= bays; i += 1) put(BRICK, brickPlain, i * bay - 0.31, i * bay + 0.31, -10, top - 0.55, 0.24);
      for (const y of [3.36, 10.36]) put(PLASTER, stoneTrim, -0.36, run + 0.36, y, y + 0.28, 0.33);
      // Cornice over the top windows: a frieze, a row of dentils, the projecting shelf.
      put(PLASTER, stoneTrim, -0.38, run + 0.38, top - 0.55, top - 0.25, 0.32);
      put(PLASTER, stoneTrim, -0.68, run + 0.68, top + 0.05, top + 0.33, 0.7);
      if (high) for (let i = 0; i < Math.round((run + 0.6) / 0.62); i += 1) put(PLASTER, stoneTrim, -0.3 + i * 0.62, -0.3 + i * 0.62 + 0.3, top - 0.25, top + 0.05, 0.5);
      else put(PLASTER, stoneTrim, -0.4, run + 0.4, top - 0.25, top + 0.05, 0.46);
    });
    parapet(BRICK, brickPlain, x0, x1, z0, z1, top, 1.5, 0.4);
    // Fire escape on the sixth and seventh bays: landings, stairs, rails.
    {
      const u0 = x0 + 15.35, u1 = x0 + 20.65, z = z1 + 0.26, out = 1.2;
      for (let j = 0; j <= 5; j += 1) {
        const y = j * 3.5 + 0.6;
        slab(METAL, darkSteel, u0, u1, y - 0.07, y, z, z + out, far);
        for (const end of [u0, u1]) bar(METAL, darkSteel, [end, y - 1.0, z - 0.02], [end, y - 0.04, z + out - 0.05], 0.035);
        for (const h of [0.55, 1.05]) {
          bar(METAL, darkSteel, [u0, y + h, z + out], [u1, y + h, z + out], 0.03);
          for (const end of [u0, u1]) bar(METAL, darkSteel, [end, y + h, z + 0.04], [end, y + h, z + out], 0.03);
        }
        for (let i = 0; i <= 8; i += 1) if (high || i % 2 === 0) bar(METAL, darkSteel, [u0 + i * (u1 - u0) / 8, y, z + out], [u0 + i * (u1 - u0) / 8, y + 1.05, z + out], 0.018);
        if (j === 5) continue;
        const from = j % 2 ? u0 + 0.6 : u1 - 0.6, to = j % 2 ? u1 - 1.0 : u0 + 1.0;
        for (const s of [0.42, 0.98]) bar(METAL, darkSteel, [from, y, z + s], [to, y + 3.5, z + s], 0.04);
        bar(METAL, darkSteel, [from, y + 1.0, z + 0.98], [to, y + 4.5, z + 0.98], 0.025);
        if (high) for (let i = 1; i < 12; i += 1) slab(METAL, darkSteel, from + (to - from) * i / 12 - 0.13, from + (to - from) * i / 12 + 0.13, y + 3.5 * i / 12 - 0.02, y + 3.5 * i / 12 + 0.02, z + 0.44, z + 0.96, { ...far, skip: "ns" });
      }
      // The drop ladder and its counterweight.
      bar(METAL, darkSteel, [u0 + 0.4, -3, z + out + 0.05], [u0 + 0.4, 0.6, z + out + 0.05], 0.03);
      bar(METAL, darkSteel, [u0 + 0.85, -3, z + out + 0.05], [u0 + 0.85, 0.6, z + out + 0.05], 0.03);
    }
    const roof = top;
    // Water tower: staves, hoops, a conical cap, a ladder.
    {
      const tx = -27, tz = -55.5, legs = 5.2, radius = 2.25;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        bar(METAL, steel, [tx + a * 1.7, roof, tz + b * 1.7], [tx + a * 1.5, roof + legs, tz + b * 1.5], 0.1);
      }
      for (const [a, b, c, d] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
        bar(METAL, steel, [tx + a * 1.6, roof + 2.6, tz + b * 1.6], [tx + c * 1.6, roof + 2.6, tz + d * 1.6], 0.06);
        bar(METAL, steel, [tx + a * 1.6, roof + 2.6, tz + b * 1.6], [tx + c * 1.5, roof + legs, tz + d * 1.5], 0.045);
      }
      slab(METAL, steel, tx - 2.1, tx + 2.1, roof + legs, roof + legs + 0.22, tz - 2.1, tz + 2.1, far);
      tube(METAL, timberTank, tx, tz, radius, radius * 0.95, roof + legs + 0.22, roof + legs + 4.4, 20, far);
      for (const h of [0.5, 1.4, 2.4, 3.4, 4.1]) tube(METAL, darkSteel, tx, tz, radius * (1 - 0.012 * h) + 0.04, radius * (1 - 0.012 * h) + 0.04, roof + legs + 0.16 + h, roof + legs + 0.26 + h, 20, far);
      tube(METAL, plain([0.35, 0.3, 0.26], 0.45, 0.3), tx, tz, radius * 1.08, 0.12, roof + legs + 4.4, roof + legs + 5.9, 20, far);
      for (const off of [-0.2, 0.2]) bar(METAL, steel, [tx + radius + 0.12, roof, tz + off], [tx + radius + 0.12, roof + legs + 4.3, tz + off], 0.03);
    }
    // Chimney stacks, the stair head, a lit lantern over the stair, vents.
    for (const [cx, cz] of [[-30.4, -46.5], [-12.4, -57.6], [-18.5, -58.2]]) {
      slab(BRICK, brickPlain, cx - 0.55, cx + 0.55, roof, roof + 3.4, cz - 0.45, cz + 0.45, { ...far, skip: "b" });
      slab(PLASTER, stoneTrim, cx - 0.66, cx + 0.66, roof + 3.4, roof + 3.56, cz - 0.56, cz + 0.56, far);
      for (const o of [-0.26, 0.26]) tube(BRICK, plain([1.1, 0.75, 0.6]), cx + o, cz, 0.16, 0.14, roof + 3.56, roof + 4.2, 8, far);
    }
    stairHead(BRICK, brickPlain, loftRoof, -14.5, -54.5, roof);
    slab(METAL, glowing([1, 0.74, 0.42], 1.5), -21.6, -19.2, roof + 0.5, roof + 1.0, -52.6, -50.2, { ...far, skip: "b" });
    slab(BRICK, brickPlain, -21.8, -19.0, roof, roof + 0.5, -52.8, -50.0, { ...far, skip: "b" });
    for (const k of [1, 2]) bar(METAL, darkSteel, [-21.6 + k * 0.8, roof + 1.02, -52.7], [-21.6 + k * 0.8, roof + 1.02, -50.1], 0.03);
    condensers(-12.8, -49.8, roof, 3, false);
    roofLamp(BRICK, loftRoof, -23.2, -48.4, roof, WARM, 0xffa860);
  }

  // B: a glass office tower right of the gap, close enough to read the ceilings.
  {
    const x0 = 5, x1 = 29, z0 = -67, z1 = -47, top = 52, band0 = 24.7, band1 = 28.6;
    footprints.push([x0, x1, z0, z1]);
    const office = windows(2, 1.5, 3.9, 0.04, 0.95, 3.4, 0.07, 0.52, 0.3, [0.5, 0.72, 0.8], 23);
    mass(METAL, office, x0, x1, z0, z1, STREET, band0, { base: band0 - 20 * 3.9 });
    mass(METAL, office, x0, x1, z0, z1, band1, top, { base: band1, roof: roofing(5) });
    // A recessed plant floor splits the shaft: louvres, a soffit, and the tenant's name in lights.
    const inset = 0.7, signGlow = scaled(AMBER, 0.55);
    slab(METAL, louvre, x0 + inset, x1 - inset, band0, band1, z0 + inset, z1 - inset, { skip: "tb", wash: [signGlow, scaled(AMBER, 0.2)] });
    plate(METAL, aluminium, x0, z0, x1, z1, band1, false, { wash: scaled(AMBER, 0.35) });
    plate(METAL, roofing(6), x0, z0, x1, z1, band0, true);
    for (let i = 0; i <= 8; i += 1) slab(METAL, aluminium, x0 + inset + 0.4 + i * (x1 - x0 - 2 * inset - 0.8) / 8 - 0.09, x0 + inset + 0.4 + i * (x1 - x0 - 2 * inset - 0.8) / 8 + 0.09, band0, band1, z1 - inset, z1 - 0.12, { ...far, skip: "tbn" });
    // Aluminium fins every second bay, on the two sides that face the range.
    for (const side of ["s", "w"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      const count = Math.round(run / 3);
      for (let i = 0; i <= count; i += 1) {
        const u = Math.min(run - 0.07, Math.max(0.07, i * run / count));
        put(METAL, aluminium, u - 0.07, u + 0.07, -12, band0, 0.42);
        put(METAL, aluminium, u - 0.07, u + 0.07, band1, top + 1.3, 0.42);
      }
    });
    // A tube of light up the corner that faces the firing line, on its post.
    slab(METAL, darkSteel, x0 - 0.36, x0, -12, top + 1.3, z1, z1 + 0.36, { ...far, skip: "enb" });
    slab(METAL, glowing(TEAL, 2.4), x0 - 0.5, x0 - 0.36, -12, band0, z1 + 0.36, z1 + 0.5, far);
    slab(METAL, glowing(TEAL, 2.4), x0 - 0.5, x0 - 0.36, band1, top + 1.3, z1 + 0.36, z1 + 0.5, far);
    // Crown: a glass screen, a plant enclosure, cooling towers, a mast.
    parapet(METAL, plain([0.16, 0.2, 0.23], 0, 0.9), x0, x1, z0, z1, top, 1.3, 0.2, null);
    slab(METAL, glowing(COOL, 1.6), x0 - 0.05, x1 + 0.05, top + 1.3, top + 1.42, z1 - 0.2, z1 + 0.05, far);
    slab(METAL, glowing(COOL, 1.6), x0 - 0.05, x0 + 0.2, top + 1.3, top + 1.42, z0, z1 - 0.2, { ...far, skip: "ns" });
    slab(METAL, louvre, x0 + 4, x1 - 4, top, top + 5.2, z0 + 4, z1 - 4, { skip: "b", wash: [scaled(COOL, 0.25), [0, 0, 0]] });
    for (const cx of [x0 + 8, x0 + 12.4, x0 + 16.8]) coolingTower(cx, z0 + 10, top + 5.2, 1.7, 2.3);
    mast(x1 - 6.5, z0 + 7, top + 5.2, 16, 0.4);
  }

  // C: a concrete slab block behind the loft building: ribbon windows, sun shades, a video wall.
  const screenRect = { x0: -27, x1: -11, y0: 39.6, y1: 50.4, z: -69.36 };
  {
    const x0 = -41, x1 = -9, z0 = -100, z1 = -70, top = 64;
    footprints.push([x0, x1, z0, z1]);
    const block = windows(3, 3.2, 3.3, 0.06, 1.05, 2.8, 0.16, 0.46, 0.62, [1.25, 1.25, 1.3], 37, 0.3);
    const stair = windows(1, 1.6, 3.3, 0.35, 0.4, 2.9, 0.2, 2.2, 0.12, [1.25, 1.25, 1.3], 38, 0.3);
    wall(CONCRETE, block, x0, z1, x1, z1, STREET, top);
    wall(CONCRETE, stair, x1, z1, x1, z1 - 3.2, STREET, top);
    wall(CONCRETE, block, x1, z1 - 3.2, x1, z0, STREET, top);
    wall(CONCRETE, block, x0, z0, x0, z1, STREET, top);
    wall(CONCRETE, block, x1, z0, x0, z0, STREET, top);
    plate(CONCRETE, roofing(8), x0, z0, x1, z1, top);
    relief(x0, x1, z0, z1, "s", (put, run) => {
      const su0 = screenRect.x0 - x0 - 0.9, su1 = screenRect.x1 - x0 + 0.9;
      for (let floor = 0; floor < 17; floor += 1) {
        const y = top - (floor + 1) * 3.3 + 2.86;
        if (y + 0.2 > screenRect.y0 - 0.6 && y < screenRect.y1 + 0.6) { put(CONCRETE, concretePlain, -0.25, su0, y, y + 0.16, 0.8); put(CONCRETE, concretePlain, su1, run + 0.25, y, y + 0.16, 0.8); }
        else put(CONCRETE, concretePlain, -0.25, run + 0.25, y, y + 0.16, 0.8);
      }
      for (const u of [0, run / 2 - 9.6, run]) put(CONCRETE, concretePlain, u - 0.22, u + 0.22, -10, top + 1.2, 1.05);
      // The video wall's cabinet and the brackets it hangs from.
      put(METAL, darkSteel, su0 + 0.5, su1 - 0.5, screenRect.y0 - 0.4, screenRect.y1 + 0.4, 0.52);
      for (const u of [su0 + 2, (su0 + su1) / 2, su1 - 2]) put(METAL, steel, u - 0.15, u + 0.15, screenRect.y1 + 0.4, screenRect.y1 + 1.5, 0.3);
    });
    relief(x0, x1, z0, z1, "e", (put, run) => {
      for (let floor = 0; floor < 17; floor += 1) put(CONCRETE, concretePlain, 3.4, run + 0.25, top - (floor + 1) * 3.3 + 2.86, top - (floor + 1) * 3.3 + 3.02, 0.8);
      for (const u of [0, 3.3, run]) put(CONCRETE, concretePlain, u - 0.22, u + 0.22, -10, top + 1.2, 1.05);
    });
    parapet(CONCRETE, concretePlain, x0, x1, z0, z1, top, 1.2, 0.3);
    slab(CONCRETE, concretePlain, x0 + 4, x0 + 13, top, top + 4.2, z0 + 5, z0 + 13, { skip: "b" });
    slab(CONCRETE, concretePlain, x1 - 9, x1 - 2.5, top, top + 3.2, z0 + 16, z0 + 23, { skip: "b" });
    tank(x0 + 17.5, z0 + 9, top, 1.9, 3.2);
    tank(x0 + 22.5, z0 + 9.4, top, 1.9, 3.2);
    mast(x0 + 8, z0 + 9, top + 4.2, 11, 2.1);
    // The lattice the roof sign stands on, at the roof edge so that both its lines clear the parapet from the firing line.
    for (let i = 0; i <= 6; i += 1) {
      const x = -34 + i * 3.1;
      bar(METAL, steel, [x, top, z1 - 0.45], [x, top + 7.6, z1 - 0.45], 0.09);
      bar(METAL, steel, [x, top + 6.8, z1 - 0.45], [x, top, z1 - 4.05], 0.06);
    }
    for (const y of [2.6, 7.3]) bar(METAL, steel, [-34.3, top + y, z1 - 0.45], [-15.1, top + y, z1 - 0.45], 0.07);
  }

  // D: a stone tower behind the glass one, stepped back twice, its crown floodlit.
  {
    const x0 = 6, x1 = 32, z0 = -104, z1 = -78, top = 86;
    footprints.push([x0, x1, z0, z1]);
    const stone = windows(1, 1.7, 3.6, 0.44, 0.7, 3.0, 0.3, 0.36, 0.72, [1.45, 1.36, 1.2], 41, 0.3);
    const stonePlain = plain([1.45, 1.36, 1.2], 0.3, 0.15);
    const flood: [V3, V3] = [scaled(WARM, 1.5), scaled(WARM, 0.12)];
    mass(PLASTER, stone, x0, x1, z0, z1, STREET, top, { roof: roofing(9) });
    mass(PLASTER, stone, x0 + 3, x1 - 3, z0 + 3, z1 - 3, top, top + 14.4, { roof: roofing(10), base: top, wash: flood });
    mass(PLASTER, stone, x0 + 7, x1 - 7, z0 + 7, z1 - 7, top + 14.4, top + 25.2, { roof: roofing(12), base: top + 14.4, wash: flood });
    slab(PLASTER, stonePlain, x0 + 10.4, x1 - 10.4, top + 25.2, top + 30, z0 + 10.4, z1 - 10.4, { skip: "b", wash: flood });
    tube(METAL, plain([0.4, 0.5, 0.46], 0.6, 0.6), (x0 + x1) / 2, (z0 + z1) / 2, 2.4, 0.2, top + 30, top + 41, 8, { wash: [scaled(WARM, 0.8), [0, 0, 0]] });
    mast((x0 + x1) / 2, (z0 + z1) / 2, top + 41, 9, 1.3);
    for (const side of ["s", "w", "e"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      const count = Math.round(run / 3.4);
      for (let i = 0; i <= count; i += 1) put(PLASTER, stonePlain, i * run / count - 0.42, i * run / count + 0.42, 20, top + 1.6, 0.55, i % 2 ? {} : { wash: [[0, 0, 0], scaled(WARM, 0.25)] });
      put(PLASTER, stonePlain, -0.5, run + 0.5, top - 0.3, top + 0.5, 0.8);
    });
    for (const [inset, y] of [[3, top + 14.4], [7, top + 25.2]]) for (const side of ["s", "w"] as const) relief(x0 + inset, x1 - inset, z0 + inset, z1 - inset, side, (put, run) => {
      const count = Math.max(2, Math.round(run / 3.4));
      for (let i = 0; i <= count; i += 1) put(PLASTER, stonePlain, i * run / count - 0.36, i * run / count + 0.36, y - (inset === 3 ? 14.4 : 10.8), y + 1.4, 0.45, { wash: flood });
    });
  }

  // E: a tower going up beyond the expressway: bare frame, open floors, a hoist, two cranes.
  const site = { x0: 64, x1: 88, z0: -72, z1: -48, top: 72 };
  {
    const { x0, x1, z0, z1, top } = site;
    footprints.push([x0, x1, z0, z1]);
    const frameFace = windows(4, 6.0, 3.6, 0.38, 0.02, 3.12, 0, 0.16, 0.2, [1.5, 1.5, 1.52], 53, 0.3);
    mass(CONCRETE, frameFace, x0, x1, z0, z1, STREET, top, { roof: roofing(13, [0.2, 0.2, 0.2]) });
    // Columns and starter bars stand above the last slab; the core is two floors ahead.
    for (let i = 0; i <= 4; i += 1) for (let j = 0; j <= 4; j += 1) {
      if (i > 0 && i < 4 && j > 0 && j < 4) continue;
      const x = x0 + 0.4 + i * (x1 - x0 - 0.8) / 4, z = z0 + 0.4 + j * (z1 - z0 - 0.8) / 4;
      slab(CONCRETE, concretePlain, x - 0.38, x + 0.38, top, top + 3.2, z - 0.38, z + 0.38, { ...far, skip: "b" });
      for (const [a, b] of [[-0.25, -0.25], [0.25, 0.25]]) bar(METAL, plain([0.5, 0.22, 0.1], 0), [x + a, top + 3.2, z + b], [x + a, top + 4.3, z + b], 0.025);
    }
    slab(CONCRETE, concretePlain, x0 + 8, x1 - 8, top, top + 8.6, z0 + 7, z1 - 9, { skip: "b", wash: [scaled(COOL, 0.6), [0, 0, 0]] });
    slab(PLASTER, plain([1.3, 0.95, 0.5], 0.2), x0 + 7.9, x1 - 7.9, top + 7.4, top + 8.7, z1 - 9, z1 - 8.86, { ...far, skip: "n" });
    // Site lights on poles at the slab edge, and the pools they throw.
    for (const [lx, lz] of [[x0 + 1.5, z1 - 1.5], [x1 - 1.5, z1 - 1.5], [x0 + 1.5, z0 + 6]]) {
      bar(METAL, steel, [lx, top, lz], [lx, top + 4.4, lz], 0.06);
      slab(METAL, glowing(COOL, 9), lx - 0.3, lx + 0.3, top + 4.2, top + 4.5, lz - 0.1, lz + 0.1, far);
      halo([lx, top + 4.35, lz], 0xe6f0ff, 0.9, true);
    }
    // The hoist up the face toward us: a lattice mast, ties, a lit cage.
    const hx = x0 - 1.3, hz = z1 - 6;
    for (const [a, b] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) bar(METAL, plain([0.75, 0.5, 0.1], 0), [hx + a, -14, hz + b], [hx + a, top + 6, hz + b], 0.06);
    for (let y = -12; y < top + 5; y += 2.4) {
      bar(METAL, plain([0.75, 0.5, 0.1], 0), [hx - 0.6, y, hz + 0.6], [hx + 0.6, y + 2.4, hz + 0.6], 0.035);
      bar(METAL, plain([0.75, 0.5, 0.1], 0), [hx - 0.6, y, hz - 0.6], [hx - 0.6, y + 2.4, hz + 0.6], 0.035);
      if (Math.round(y / 2.4) % 3 === 0) bar(METAL, steel, [hx + 0.6, y, hz], [x0, y, hz], 0.05);
    }
    slab(METAL, plain([0.6, 0.6, 0.62], 0, 0.6), hx - 2.1, hx - 0.7, 38.2, 40.9, hz - 0.9, hz + 0.9, far);
    slab(METAL, glowing(COOL, 3.5), hx - 2.14, hx - 2.1, 39.5, 40.5, hz - 0.6, hz + 0.6, { ...far, skip: "e" });
    // A scaffold with debris netting on the lower floors facing the avenue.
    relief(x0, x1, z0, z1, "w", (put, run) => {
      const reach = run * 0.6;
      for (let i = 0; i <= 6; i += 1) put(METAL, steel, i * reach / 6 - 0.04, i * reach / 6 + 0.04, -14, 22, 1.25);
      for (let y = -12.4; y < 22; y += 2.0) put(METAL, plain([0.5, 0.38, 0.22], 0.4), 0, reach, y, y + 0.06, 1.25);
      put(METAL, plain([0.05, 0.3, 0.2], 0.9, 0.05), 0.3, reach * 0.6, -8, 20, 1.34, { wash: [scaled(WARM, 0.25), [0, 0, 0]] });
      put(METAL, plain([0.08, 0.2, 0.42], 0.9, 0.05), reach * 0.6, reach - 0.3, 2, 20, 1.34);
    });
  }

  // G: dark glass with light running up its fins, down range to the left.
  {
    const x0 = -63, x1 = -37, z0 = -76, z1 = -50, top = 92;
    footprints.push([x0, x1, z0, z1]);
    const dark = windows(2, 1.6, 4.0, 0.04, 0.7, 3.5, 0.06, 0.34, 0.15, [0.34, 0.4, 0.56], 61);
    mass(METAL, dark, x0, x1, z0, z1, STREET, top, { roof: roofing(14) });
    for (const side of ["s", "e"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      const count = Math.round(run / 6.5);
      for (let i = 0; i <= count; i += 1) {
        const u = Math.min(run - 0.2, Math.max(0.2, i * run / count));
        put(METAL, darkSteel, u - 0.2, u + 0.2, 0, top + 3.5, 0.7);
        put(METAL, glowing(i % 2 ? PINK : TEAL, 2.2), u - 0.09, u + 0.09, 22, top + 3.5, 0.78);
      }
    });
    parapet(METAL, plain([0.1, 0.12, 0.16], 0, 0.9), x0, x1, z0, z1, top, 3.5, 0.3, null);
    slab(METAL, louvre, x0 + 5, x1 - 5, top, top + 6, z0 + 5, z1 - 5, { skip: "b" });
    mast(x0 + 8, z1 - 8, top + 6, 20, 3.3);
  }

  // K: the tower that stands over the plant room: stone piers, three setbacks, a lit lantern.
  {
    const x0 = -66, x1 = -40, z0 = -40, z1 = -14, top = 84;
    footprints.push([x0, x1, z0, z1]);
    const stone = windows(1, 2.1, 3.7, 0.5, 0.75, 3.05, 0.3, 0.4, 0.86, [1.3, 1.16, 1.02], 67, 0.3);
    const stonePlain = plain([1.3, 1.16, 1.02], 0.3, 0.15);
    const flood: [V3, V3] = [scaled([1, 0.72, 0.42], 1.4), scaled(WARM, 0.1)];
    mass(PLASTER, stone, x0, x1, z0, z1, STREET, top, { roof: roofing(15) });
    mass(PLASTER, stone, x0 + 3.5, x1 - 3.5, z0 + 3.5, z1 - 3.5, top, top + 14.8, { roof: roofing(16), base: top, wash: flood });
    mass(PLASTER, stone, x0 + 7.5, x1 - 7.5, z0 + 7.5, z1 - 7.5, top + 14.8, top + 25.9, { roof: roofing(17), base: top + 14.8, wash: flood });
    // The lantern: a glazed room at the top, always lit.
    const lantern = windows(2, 1.1, 5.5, 0.05, 0.3, 5.2, 0.05, 3, 0.95, [1, 0.85, 0.6], 68);
    mass(METAL, lantern, x0 + 10, x1 - 10, z0 + 10, z1 - 10, top + 25.9, top + 31.4, { roof: roofing(18), base: top + 25.9 });
    tube(METAL, plain([0.3, 0.42, 0.38], 0.6, 0.6), (x0 + x1) / 2, (z0 + z1) / 2, 3.6, 0.15, top + 31.4, top + 44, 8, { wash: [scaled(WARM, 0.7), [0, 0, 0]] });
    mast((x0 + x1) / 2, (z0 + z1) / 2, top + 44, 8, 4.4);
    for (const side of ["e", "s", "n"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      const count = Math.round(run / 4.2);
      for (let i = 0; i <= count; i += 1) put(PLASTER, stonePlain, i * run / count - 0.5, i * run / count + 0.5, 12, top + 2, 0.7);
      for (const y of [top - 22.4, top - 0.4]) put(PLASTER, stonePlain, -0.75, run + 0.75, y, y + 0.7, 0.95);
    });
    for (const [inset, y0, y1] of [[3.5, top, top + 14.8], [7.5, top + 14.8, top + 25.9]]) for (const side of ["e", "s", "n"] as const) relief(x0 + inset, x1 - inset, z0 + inset, z1 - inset, side, (put, run) => {
      const count = Math.max(2, Math.round(run / 4.2));
      for (let i = 0; i <= count; i += 1) put(PLASTER, stonePlain, i * run / count - 0.42, i * run / count + 0.42, y0, y1 + 1.6, 0.5, { wash: flood });
    });
  }

  // M: a ribbon-window office slab beyond the expressway, sun shades at every floor.
  {
    const x0 = 64, x1 = 90, z0 = -36, z1 = -8, top = 86;
    footprints.push([x0, x1, z0, z1]);
    const ribbon = windows(3, 3.0, 3.8, 0.05, 1.0, 3.0, 0.14, 0.5, 0.4, [1.1, 1.12, 1.2], 71, 0.3);
    mass(CONCRETE, ribbon, x0, x1, z0, z1, STREET, top, { roof: roofing(19) });
    for (const side of ["w", "s"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      for (let floor = 0; floor < 19; floor += 1) put(CONCRETE, concretePlain, -0.3, run + 0.3, top - floor * 3.8 - 0.74, top - floor * 3.8 - 0.56, 0.9);
      for (const u of [0, run]) put(CONCRETE, concretePlain, u - 0.3, u + 0.3, 6, top + 1.4, 1.1);
    });
    parapet(CONCRETE, concretePlain, x0, x1, z0, z1, top, 1.4, 0.3);
    slab(METAL, louvre, x0 + 6, x1 - 6, top, top + 5, z0 + 6, z1 - 6, { skip: "b" });
    for (const cz of [z0 + 9, z0 + 14, z0 + 19]) coolingTower(x0 + 4, cz, top, 1.5, 2.2);
    mast(x1 - 8, z0 + 9, top + 5, 14, 5.2);
    // Rails for the sign on the face toward the range.
    relief(x0, x1, z0, z1, "w", (put) => put(METAL, plain([0.03, 0.03, 0.035], 0, 0.3), 5.6, 22.4, 41.4, 46.6, 0.94, { wash: scaled([1, 0.42, 0.24], 0.5) }));
    for (const y of [42.5, 45.5]) bar(METAL, steel, [63.0, y, -29.8], [63.0, y, -14.2], 0.05);
  }

  // The -x side: a hotel's podium roof with a lit pool, the apartment tower behind it.
  {
    const x0 = -72, x1 = -40, z0 = -6, z1 = 26, top = -7;
    footprints.push([x0, x1, z0, z1], [-106, -76, -12, 20]);
    const podium = windows(3, 3.4, 4.2, 0.06, 0.6, 3.5, 0.14, 0.7, 0.7, [1.2, 1.12, 1.0], 73, 0.3);
    const terrace = roofing(20, [0.11, 0.1, 0.09]);
    mass(PLASTER, podium, x0, x1, z0, z1, STREET, top, { roof: terrace });
    parapet(PLASTER, plain([1.2, 1.12, 1.0], 0.3), x0, x1, z0, z1, top, 1.1, 0.35);
    // The pool, its lit water, the deck round it, loungers and umbrellas.
    slab(PLASTER, stoneTrim, -66, -49, top, top + 0.42, 3, 12, { ...far, skip: "b" });
    slab(METAL, glowing([0.1, 0.85, 0.9], 1.5), -65.2, -49.8, top + 0.3, top + 0.47, 3.8, 11.2, { ...far, skip: "bnsew" });
    for (let i = 0; i < 6; i += 1) slab(PLASTER, plain([1.4, 1.36, 1.3], 0), -64 + i * 2.6, -63.2 + i * 2.6, top + 0.25, top + 0.4, 13.2, 15.2, { ...far, skip: "b" });
    for (const ux of [-61.5, -53.5]) { bar(METAL, steel, [ux, top, 16.5], [ux, top + 2.6, 16.5], 0.04); tube(PLASTER, plain([1.2, 0.5, 0.3], 0), ux, 16.5, 1.7, 0.1, top + 2.3, top + 2.9, 8, far); }
    stairHead(PLASTER, plain([1.2, 1.12, 1.0], 0.3), terrace, -47.5, 14.5, top);
    for (const lx of [-68.5, -46.5]) roofLamp(PLASTER, terrace, lx, 7.5, top, [0.4, 0.95, 0.9], 0x8ef5e3);
    for (const cx of [-66, -61.5]) coolingTower(cx, 21.5, top, 1.6, 2.3);
    condensers(-56, 22, top, 5, true);
    // The apartment tower.
    const flats = windows(1, 3.4, 3.1, 0.7, 0.5, 2.55, 0.2, 0.5, 0.88, [1.36, 1.2, 1.05], 79, 0.3);
    mass(PLASTER, flats, -106, -76, -12, 20, STREET, 78, { roof: roofing(21) });
    relief(-106, -76, -12, 20, "e", (put, run) => {
      for (let floor = 0; floor < 22; floor += 1) for (const u of [3.4, 13.6, 23.8]) {
        const y = 78 - floor * 3.1 - 2.7;
        put(CONCRETE, concretePlain, u, u + 4.8, y, y + 0.16, 1.5);
        put(METAL, plain([0.14, 0.2, 0.24], 0, 0.9), u + 0.05, u + 4.75, y + 0.16, y + 1.15, 1.45, { skip: "tb" });
      }
    });
    parapet(PLASTER, plain([1.36, 1.2, 1.05], 0.3), -106, -76, -12, 20, 78, 1.2, 0.3);
    slab(PLASTER, plain([1.36, 1.2, 1.05], 0.3), -98, -88, 78, 82.5, -4, 8, { skip: "b" });
    mast(-93, 2, 82.5, 12, 0.9);
  }

  // The +x side beyond the expressway: a low roof to look down on.
  {
    const x0 = 64, x1 = 100, z0 = -2, z1 = 30, top = -9;
    footprints.push([x0, x1, z0, z1]);
    const shed = windows(3, 4.0, 4.4, 0.08, 1.2, 3.4, 0.14, 0.3, 0.3, [1.1, 1.1, 1.15], 83, 0.3);
    const shedRoof = roofing(22);
    mass(CONCRETE, shed, x0, x1, z0, z1, STREET, top, { roof: shedRoof });
    parapet(CONCRETE, concretePlain, x0, x1, z0, z1, top, 0.9, 0.3);
    for (const [cx, cz] of [[72, 6], [77, 6], [82, 6]]) coolingTower(cx, cz, top, 1.9, 2.6);
    slab(METAL, ribbed, 70, 96, top + 0.6, top + 1.5, 12.5, 13.6, { ...far, skip: "b" });
    for (let i = 0; i < 6; i += 1) slab(METAL, darkSteel, 71 + i * 4.8, 71.2 + i * 4.8, top, top + 0.6, 12.6, 13.5, { ...far, skip: "tb" });
    // North lights: a saw-tooth of glazed strips glowing from the hall below.
    for (let i = 0; i < 5; i += 1) {
      slab(CONCRETE, concretePlain, 70, 94, top, top + 1.3, 17 + i * 2.5, 17.3 + i * 2.5, { ...far, skip: "b" });
      slab(METAL, glowing([1, 0.8, 0.55], 1.3), 70.3, 93.7, top + 0.2, top + 1.2, 17.3 + i * 2.5, 17.36 + i * 2.5, { ...far, skip: "bn" });
    }
    stairHead(CONCRETE, concretePlain, shedRoof, 92, 3, top);
    roofLamp(CONCRETE, shedRoof, 88, 9, top, WARM, 0xffa860);
  }

  // Behind the stair core: a hotel with balconies, and a bronze glass tower.
  {
    const x0 = -30, x1 = -2, z0 = 44, z1 = 70, top = 60;
    footprints.push([x0, x1, z0, z1]);
    const rooms = windows(1, 3.5, 3.2, 0.45, 0.12, 2.5, 0.12, 0.56, 0.9, [1.3, 1.2, 1.08], 89, 0.3);
    mass(PLASTER, rooms, x0, x1, z0, z1, STREET, top, { roof: roofing(23) });
    relief(x0, x1, z0, z1, "n", (put, run) => {
      for (let floor = 0; floor < 15; floor += 1) {
        const y = top - (floor + 1) * 3.2 - 0.12;
        put(CONCRETE, concretePlain, -0.2, run + 0.2, y, y + 0.18, 1.5);
        put(METAL, plain([0.15, 0.2, 0.22], 0, 0.9), -0.15, run + 0.15, y + 0.18, y + 1.2, 1.44, { skip: "tb" });
      }
      for (let i = 0; i <= 8; i += 1) put(PLASTER, plain([1.3, 1.2, 1.08], 0.3), i * run / 8 - 0.12, i * run / 8 + 0.12, 8, top + 1.2, 1.56);
    });
    parapet(PLASTER, plain([1.3, 1.2, 1.08], 0.3), x0, x1, z0, z1, top, 1.2, 0.3);
    slab(PLASTER, plain([1.3, 1.2, 1.08], 0.3), x0 + 9, x1 - 9, top, top + 4, z0 + 9, z1 - 8, { skip: "b" });
    // The sign's lattice stands at the roof edge, or the balconies below would hide the name from the range.
    for (let i = 0; i <= 5; i += 1) { bar(METAL, steel, [-27 + i * 4.4, top, z0 + 0.45], [-27 + i * 4.4, top + 8.5, z0 + 0.45], 0.09); bar(METAL, steel, [-27 + i * 4.4, top + 7.6, z0 + 0.45], [-27 + i * 4.4, top, z0 + 4.6], 0.06); }
    for (const y of [4.0, 8.2]) bar(METAL, steel, [-27.3, top + y, z0 + 0.45], [-4.7, top + y, z0 + 0.45], 0.07);
  }
  {
    const x0 = 6, x1 = 34, z0 = 44, z1 = 72, top = 90;
    footprints.push([x0, x1, z0, z1]);
    const bronze = windows(2, 1.4, 3.9, 0.04, 0.9, 3.4, 0.06, 0.42, 0.55, [0.8, 0.62, 0.42], 97);
    mass(METAL, bronze, x0, x1, z0, z1, STREET, top, { roof: roofing(24) });
    mass(METAL, bronze, x0 + 4, x1 - 4, z0 + 4, z1 - 4, top, top + 15.6, { roof: roofing(25), base: top, wash: [scaled(TEAL, 0.5), [0, 0, 0]] });
    for (const side of ["n", "w"] as const) relief(x0, x1, z0, z1, side, (put, run) => {
      for (let i = 0; i <= 7; i += 1) put(METAL, plain([0.4, 0.3, 0.2], 0, 0.8), i * run / 7 - 0.1, i * run / 7 + 0.1, 6, top + 1, 0.5);
    });
    slab(METAL, glowing(TEAL, 2), x0 + 3.9, x1 - 3.9, top + 15.6, top + 16.1, z0 + 3.9, z1 - 3.9, { skip: "b" });
    mast((x0 + x1) / 2, (z0 + z1) / 2, top + 16.1, 16, 2.8);
  }

  // The tower the canyon ends on: a slender shaft, a stepped glass crown lit from inside.
  {
    const cx = -1, cz = -180, half = 16, top = 138;
    footprints.push([cx - half, cx + half, cz - half, cz + half]);
    const shaft = windows(2, 1.6, 4.0, 0.2, 0.8, 3.4, 0.08, 0.46, 0.4, [0.5, 0.6, 0.78], 101);
    const crown = windows(2, 1.6, 4.0, 0.05, 0.3, 3.8, 0.05, 2.5, 0.2, [0.75, 0.9, 1.0], 102);
    mass(METAL, shaft, cx - half, cx + half, cz - half, cz + half, STREET, top, { roof: roofing(26) });
    mass(METAL, shaft, cx - 12, cx + 12, cz - 12, cz + 12, top, top + 16, { roof: roofing(27), base: top });
    mass(METAL, crown, cx - 8, cx + 8, cz - 8, cz + 8, top + 16, top + 32, { roof: roofing(28), base: top + 16 });
    mass(METAL, crown, cx - 4.5, cx + 4.5, cz - 4.5, cz + 4.5, top + 32, top + 44, { roof: roofing(29), base: top + 32 });
    tube(METAL, glowing(COOL, 1.6), cx, cz, 1.2, 0.3, top + 44, top + 70, 6, {});
    slab(METAL, glowing(RED, 8, 1.5, 0), cx - 0.6, cx + 0.6, top + 70, top + 71.2, cz - 0.6, cz + 0.6, {});
    relief(cx - half, cx + half, cz - half, cz + half, "s", (put, run) => {
      for (let i = 0; i <= 4; i += 1) put(METAL, aluminium, i * run / 4 - 0.6, i * run / 4 + 0.6, 20, top + 2, 1.2, { mirror: true });
      for (const u of [run / 8, run * 3 / 8, run * 5 / 8, run * 7 / 8]) put(METAL, glowing(TEAL, 1.6), u - 0.25, u + 0.25, 60, top, 0.3, { mirror: true });
    });
  }
  // Two more to wall the canyon on the way there.
  {
    footprints.push([-50, -16, -152, -118], [12, 44, -152, -120]);
    mass(BRICK, windows(1, 3.2, 3.4, 0.7, 0.8, 2.7, 0.24, 0.4, 0.8, [1.4, 1.2, 1.1], 107), -50, -16, -152, -118, STREET, 88, { roof: roofing(30) });
    mass(BRICK, windows(1, 3.2, 3.4, 0.7, 0.8, 2.7, 0.24, 0.4, 0.8, [1.4, 1.2, 1.1], 108), -44, -22, -146, -124, 88, 101.6, { roof: roofing(31), base: 88, wash: [scaled(WARM, 0.8), [0, 0, 0]] });
    mast(-33, -135, 101.6, 18, 3.9);
    mass(CONCRETE, windows(3, 3.0, 3.6, 0.05, 1.0, 2.9, 0.14, 0.5, 0.35, [1.15, 1.15, 1.22], 109, 0.3), 12, 44, -152, -120, STREET, 122, { roof: roofing(32) });
    slab(METAL, glowing(PINK, 2), 11.7, 44.3, 122, 122.7, -152.3, -119.7, { skip: "b" });
    mast(28, -136, 122.7, 14, 5.9);
  }
  // The corners behind: brick over the bar, stone over the pallets.
  {
    footprints.push([-76, -46, 42, 70], [64, 94, 44, 74]);
    const brickTower = windows(1, 2.8, 3.4, 0.62, 0.85, 2.75, 0.26, 0.46, 0.85, [1.5, 1.22, 1.1], 113);
    mass(BRICK, brickTower, -76, -46, 42, 70, STREET, 102, { roof: roofing(33) });
    mass(BRICK, brickTower, -71, -51, 47, 65, 102, 115.6, { roof: roofing(34), base: 102, wash: [scaled(WARM, 0.9), [0, 0, 0]] });
    for (const side of ["n", "e"] as const) relief(-76, -46, 42, 70, side, (put, run) => {
      for (let i = 0; i <= 5; i += 1) put(BRICK, brickPlain, i * run / 5 - 0.5, i * run / 5 + 0.5, 0, 103.5, 0.6);
      put(PLASTER, stoneTrim, -0.7, run + 0.7, 101.4, 102.3, 0.9);
    });
    tank(-61, 56, 115.6, 2.4, 4, timberTank);
    const greyTower = windows(1, 1.9, 3.7, 0.45, 0.7, 3.0, 0.28, 0.38, 0.6, [1.2, 1.2, 1.24], 127, 0.3);
    mass(PLASTER, greyTower, 64, 94, 44, 74, STREET, 96, { roof: roofing(35) });
    mass(PLASTER, greyTower, 69, 89, 49, 69, 96, 110.8, { roof: roofing(36), base: 96, wash: [scaled(COOL, 0.8), [0, 0, 0]] });
    mast(79, 59, 110.8, 20, 1.9);
  }

  // The rings beyond, out to where the haze takes them. Every tower draws its style, massing and crown from its index.
  const ringFaces = (style: number, seed: number): [number, Face] => {
    switch (style) {
      case 0: return [METAL, windows(2, 1.5, 3.9, 0.04, 0.9, 3.4, 0.06, 0.3 + (seed % 5) * 0.07, 0.25, [0.45, 0.66, 0.8], seed)];
      case 1: return [BRICK, windows(1, 3.0, 3.4, 0.7, 0.9, 2.75, 0.25, 0.3 + (seed % 4) * 0.06, 0.85, [1.45, 1.22, 1.1], seed)];
      case 2: return [CONCRETE, windows(3, 3.1, 3.6, 0.05, 1.0, 2.9, 0.14, 0.34 + (seed % 5) * 0.06, 0.45, [1.15, 1.15, 1.22], seed, 0.3)];
      case 3: return [PLASTER, windows(1, 1.9, 3.7, 0.46, 0.7, 3.0, 0.3, 0.3 + (seed % 4) * 0.06, 0.75, [1.4, 1.3, 1.14], seed, 0.3)];
      case 4: return [METAL, windows(2, 1.7, 4.0, 0.04, 0.7, 3.5, 0.06, 0.26 + (seed % 4) * 0.06, 0.12, [0.32, 0.38, 0.55], seed)];
      default: return [METAL, windows(2, 1.4, 3.9, 0.04, 0.9, 3.4, 0.06, 0.34 + (seed % 4) * 0.06, 0.6, [0.82, 0.62, 0.42], seed)];
    }
  };
  const crownColours: V3[] = [WARM, TEAL, [1, 0.8, 0.6], PINK, COOL, AMBER];
  const tower = (x: number, z: number, w: number, d: number, top: number, turn: number, n: number, distant: boolean) => at(x, z, turn, () => {
    const pick = rng(9000 + n * 131);
    const [sheet, face] = ringFaces(Math.floor(pick() * 6), 200 + n);
    const shape = pick(), colour = crownColours[Math.floor(pick() * crownColours.length)], lay: Lay = distant ? far : {};
    const hw = w / 2, hd = d / 2;
    let cw = hw, cd = hd, y = top;
    if (shape < 0.14) {
      tube(sheet, face, 0, 0, hw, hw, STREET, top, 18, { ...lay, cap: roofing(n) });
      cw = cd = hw * 0.6;
    } else {
      mass(sheet, face, -hw, hw, -hd, hd, STREET, top, { ...lay, roof: roofing(n) });
      const tiers = shape < 0.42 ? 0 : shape < 0.8 ? 1 : 2, washed = pick() < 0.55;
      for (let k = 0; k < tiers; k += 1) {
        cw *= 0.72; cd *= 0.72;
        const rise = (2 + Math.floor(pick() * 4)) * face.cell[1];
        mass(sheet, face, -cw, cw, -cd, cd, y, y + rise, { ...lay, roof: roofing(n + k + 1), base: y, wash: washed ? [scaled(colour, 0.9), [0, 0, 0]] : undefined });
        y += rise;
      }
      if (shape > 0.3 && shape < 0.42) {
        // A second slab alongside, a few floors shorter.
        const drop = (3 + Math.floor(pick() * 5)) * face.cell[1];
        mass(sheet, face, hw, hw + w * 0.45, -hd * 0.7, hd * 0.7, STREET, top - drop, { ...lay, roof: roofing(n + 5) });
      }
    }
    const finish = pick();
    if (finish < 0.3) {
      // A band of light round the crown.
      slab(METAL, glowing(colour, 2.1), -cw - 0.3, cw + 0.3, y - 1.4, y - 0.5, -cd - 0.3, cd + 0.3, { ...lay, skip: "tb" });
    } else if (finish < 0.5) {
      // A lantern: a lit glass storey on top.
      mass(METAL, windows(2, 1.4, 5, 0.05, 0.3, 4.7, 0.05, 3, 0.5 + pick() * 0.5, [0.9, 0.9, 0.85], n), -cw * 0.7, cw * 0.7, -cd * 0.7, cd * 0.7, y, y + 5, { ...lay, roof: roofing(n + 9), base: y });
      y += 5;
    } else if (finish < 0.75) {
      slab(METAL, louvre, -cw * 0.6, cw * 0.6, y, y + 4, -cd * 0.6, cd * 0.6, { ...lay, skip: "b" });
      y += 4;
    }
    if (pick() < (top > 95 ? 0.6 : 0.3)) {
      // A mast in two stages with its beacon; drawn stouter far off so it does not break up into dots.
      const spire = 8 + pick() * 22, stout = distant ? 0.34 : 0.22, lamp = distant ? 0.7 : 0.42;
      slab(METAL, darkSteel, -stout, stout, y, y + spire * 0.55, -stout, stout, { ...lay, skip: "tb" });
      slab(METAL, darkSteel, -stout * 0.5, stout * 0.5, y + spire * 0.55, y + spire, -stout * 0.5, stout * 0.5, { ...lay, skip: "tb" });
      slab(METAL, darkSteel, -stout * 2.2, stout * 2.2, y + spire * 0.55 - 0.15, y + spire * 0.55, -stout * 2.2, stout * 2.2, lay);
      slab(METAL, glowing(RED, 8, 1.2 + pick() * 0.9, pick() * 6.28), -lamp, lamp, y + spire, y + spire + lamp * 2, -lamp, lamp, lay);
    } else {
      slab(METAL, glowing(RED, 5), cw - 1.2, cw - 0.2, y, y + 1, cd - 1.2, cd - 0.2, { ...lay, skip: "b" });
    }
  });
  {
    const place = rng(6161);
    // [radius, count, lowest top, highest top, footprint]
    const rings: Array<[number, number, number, number, number]> = [[132, 15, 52, 120, 28], [196, 20, 70, 160, 30], [262, 26, 86, 190, 32], [340, 34, 100, 210, 36], [430, 40, 120, 240, 40], [515, 46, 140, 250, 44]];
    let index = 0;
    rings.forEach(([radius, count, low, high, size], ring) => {
      for (let i = 0; i < count; i += 1) {
        index += 1;
        const angle = (i + ring * 0.37 + (place() - 0.5) * 0.5) / count * Math.PI * 2, r = radius + (place() - 0.5) * (ring < 3 ? 34 : 50);
        const x = Math.sin(angle) * r, z = -9 + Math.cos(angle) * r;
        const w = size * (0.8 + place() * 0.45), d = size * (0.8 + place() * 0.45);
        // The tallest cluster stands in the afterglow, behind the bar.
        const downtown = THREE.MathUtils.smoothstep(Math.cos(angle + 0.66), 0.1, 0.75);
        let top = low + (high - low) * Math.pow(place(), 1.6);
        top = Math.max(top, r * (0.27 + 0.26 * downtown));
        const turn = ring < 2 ? (place() - 0.5) * 0.3 : (place() - 0.5) * 1.2;
        const reach = Math.max(w, d) * 0.75;
        if (footprints.some(([x0, x1, z0, z1]) => x + reach > x0 - 5 && x - reach < x1 + 5 && z + reach > z0 - 5 && z - reach < z1 + 5)) continue;
        tower(x, z, w, d, top, turn, index, ring > 1);
      }
    });
  }

  // The expressway on its viaduct along the +x avenue, a little below the deck.
  const roadY = -2.4, roadX0 = 45.5, roadX1 = 58.5, roadRun = 520;
  {
    plate(CONCRETE, { kind: 8, cell: [3.25, 28], win: [0, 0, 0, 0], look: [0, 0, 0, 0], tint: [1, 1, 1], seed: 0 }, roadX0 - 1, -roadRun, roadX1 + 1, roadRun, roadY, true, far);
    slab(CONCRETE, concretePlain, roadX0 - 1, roadX1 + 1, roadY - 0.6, roadY, -roadRun, roadRun, { ...far, skip: "tns" });
    slab(CONCRETE, concretePlain, roadX0 + 2, roadX1 - 2, roadY - 2.6, roadY - 0.6, -roadRun, roadRun, { ...far, skip: "tns" });
    // A kerb and an open steel rail on the side toward the range, so the carriageway shows; a wall on the far side.
    slab(CONCRETE, concretePlain, roadX0 - 1, roadX0 - 0.62, roadY, roadY + 0.2, -roadRun, roadRun, { ...far, skip: "bns" });
    slab(CONCRETE, concretePlain, roadX1 + 0.62, roadX1 + 1, roadY, roadY + 0.7, -roadRun, roadRun, { ...far, skip: "bns" });
    slab(CONCRETE, concretePlain, 51.82, 52.18, roadY, roadY + 0.8, -roadRun, roadRun, { ...far, skip: "bns" });
    for (const h of [0.62, 1.0]) bar(METAL, steel, [roadX0 - 0.8, roadY + h, -300], [roadX0 - 0.8, roadY + h, 300], 0.04);
    for (let z = -300; z <= 300; z += Math.abs(z) < 140 ? 4 : 12) bar(METAL, steel, [roadX0 - 0.8, roadY + 0.2, z], [roadX0 - 0.8, roadY + 1.0, z], 0.045);
    for (let z = -500; z <= 500; z += 40) {
      slab(CONCRETE, concretePlain, 50.4, 53.6, STREET, roadY - 2.6, z - 1.1, z + 1.1, { ...far, skip: "tb" });
      slab(CONCRETE, concretePlain, roadX0 + 0.6, roadX1 - 0.6, roadY - 3.5, roadY - 2.6, z - 1.3, z + 1.3, { ...far, skip: "t" });
    }
    // Lamp standards in pairs, where the carriageway's pools of light fall.
    for (let z = -294; z <= 294; z += 28) for (const side of [-1, 1]) {
      const x = side < 0 ? roadX0 - 0.8 : roadX1 + 0.8;
      if (Math.abs(z) < 150 || Math.round(z / 28) % 2 === 0) {
        bar(METAL, steel, [x, roadY, z], [x, roadY + 8.6, z], 0.09);
        bar(METAL, steel, [x, roadY + 8.6, z], [x - side * 2.4, roadY + 9, z], 0.06);
      }
      slab(METAL, glowing([1, 0.62, 0.28], 6), x - side * 2.4 - 0.45, x - side * 2.4 + 0.45, roadY + 8.84, roadY + 8.96, z - 0.18, z + 0.18, far);
      halo([x - side * 2.4, roadY + 8.8, z], 0xffa758, 0.75, true);
    }
    // A gantry with its sign lit from the walkway.
    for (const gz of [-88, 96]) {
      for (const x of [roadX0 - 1.2, roadX1 + 1.2]) bar(METAL, steel, [x, roadY, gz], [x, roadY + 7.4, gz], 0.14);
      for (const y of [6.2, 7.4]) bar(METAL, steel, [roadX0 - 1.2, roadY + y, gz], [roadX1 + 1.2, roadY + y, gz], 0.1);
      const facing = gz < 0 ? 1 : -1;
      slab(METAL, plain([0.02, 0.3, 0.16], 0, 0.3), roadX0 + 0.6, roadX0 + 5.8, roadY + 5.4, roadY + 8.2, gz + facing * 0.16, gz + facing * 0.26, { ...far, wash: scaled(COOL, 0.9) });
      slab(METAL, plain([0.02, 0.16, 0.34], 0, 0.3), roadX1 - 5.8, roadX1 - 0.6, roadY + 5.4, roadY + 8.2, gz - facing * 0.26, gz - facing * 0.16, { ...far, wash: scaled(COOL, 0.9) });
    }
  }

  // The ground far below, and the haze that closes the horizon over the sky photograph's own foreground.
  plate(CONCRETE, { kind: 9, cell: [1, 1], win: [0, 0, 0, 0], look: [0, 0, 0, 0], tint: [1, 1, 1], seed: 0 }, -640, -649, 640, 631, STREET, true, far);
  city.bake(scene, kit.mirrorHidden, track);
  kit.updates.push((now) => {
    city.uniforms.time.value = now / 1000;
    city.uniforms.skyGain.value = Math.min(1, scene.backgroundIntensity / SKY_INTENSITY);
  });
  const horizon = new THREE.Mesh(track(new THREE.CylinderGeometry(600, 600, 300, 64, 1, true)), track(new THREE.ShaderMaterial({
    name: "city horizon", uniforms: city.fogUniforms(), vertexShader: SCREEN_VERTEX, fragmentShader: HORIZON_FRAGMENT,
    fog: true, transparent: true, depthWrite: false, side: THREE.BackSide,
  })));
  horizon.position.set(0, 50, -9);
  horizon.renderOrder = -1;
  horizon.matrixAutoUpdate = false;
  horizon.updateMatrix();
  horizon.frustumCulled = false;
  scene.add(horizon);
  kit.mirrorHidden.push(horizon);

  // Traffic: cars as lit boxes carried along the lanes, and the light they throw on the wet road.
  {
    const count = high ? 104 : 60, loop = 720;
    const parts: THREE.BufferGeometry[] = [];
    const piece = (w: number, h: number, d: number, x: number, y: number, z: number, colour: V3, roofColour: V3 = colour) => {
      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
      g.translate(x, y, z);
      const colours = new Float32Array(g.attributes.position.count * 3), normal = g.attributes.normal;
      for (let i = 0; i < normal.count; i += 1) colours.set(normal.getY(i) > 0.5 ? roofColour : colour, i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      parts.push(g);
    };
    // Facing +z: body, cabin, head lamps, tail lamps.
    piece(1.8, 0.62, 4.4, 0, 0.56, 0, [0.03, 0.032, 0.04], [0.09, 0.08, 0.12]);
    piece(1.6, 0.5, 2.3, 0, 1.1, -0.25, [0.012, 0.014, 0.02], [0.08, 0.07, 0.11]);
    for (const side of [-0.62, 0.62]) { piece(0.34, 0.16, 0.06, side, 0.68, 2.21, [11, 10, 8]); piece(0.36, 0.14, 0.06, side, 0.74, -2.21, [7, 0.22, 0.1]); }
    const carGeometry = track(mergeGeometries(parts));
    parts.forEach((part) => part.dispose());
    const cars = new THREE.InstancedMesh(carGeometry, track(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })), count);
    // Light on the road: a long warm throw ahead, a short red smear behind.
    const throwGeometry = track(new THREE.BufferGeometry());
    throwGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1.5, 0.05, 2.2, 1.5, 0.05, 2.2, 2.6, 0.05, 15, -2.6, 0.05, 15, -1.3, 0.05, -2.2, 1.3, 0.05, -2.2, 1.7, 0.05, -6.5, -1.7, 0.05, -6.5]), 3));
    throwGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array([0.5, 0.45, 0.34, 0.5, 0.45, 0.34, 0, 0, 0, 0, 0, 0, 0.42, 0.02, 0.01, 0.42, 0.02, 0.01, 0, 0, 0, 0, 0, 0]), 3));
    throwGeometry.setIndex([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
    const throws = new THREE.InstancedMesh(throwGeometry, track(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })), count);
    throws.instanceMatrix = cars.instanceMatrix;
    const lanes = [47.12, 50.38, 53.62, 56.88], pick = rng(515);
    const fleet = Array.from({ length: count }, (_, i) => {
      const lane = i % 4, long = pick() < 0.14;
      return { x: lanes[lane], way: lane < 2 ? 1 : -1, start: (Math.floor(i / 4) + pick() * 0.7) * loop / (count / 4), speed: (lane % 3 === 0 ? 17 : 22) + pick() * 3, scale: [long ? 1.25 : 1, long ? 1.9 : 0.9 + pick() * 0.25, long ? 2.4 : 0.9 + pick() * 0.3] as V3 };
    });
    const shade = new THREE.Color();
    fleet.forEach((_, i) => cars.setColorAt(i, shade.setScalar(0.75 + pick() * 0.5)));
    for (const mesh of [cars, throws]) {
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;
      scene.add(mesh);
      kit.mirrorHidden.push(mesh);
      kit.probeHidden.push(mesh);
    }
    const carMatrix = new THREE.Matrix4(), carTurn = new THREE.Quaternion(), carAt = new THREE.Vector3(), carScale = new THREE.Vector3(), about = new THREE.Vector3(0, 1, 0);
    const half = new THREE.Quaternion().setFromAxisAngle(about, Math.PI), none = new THREE.Quaternion();
    kit.updates.push((now) => {
      const seconds = now / 1000;
      fleet.forEach((car, i) => {
        const along = ((car.start + seconds * car.speed) % loop) - loop / 2;
        carAt.set(car.x, roadY, car.way * along);
        carTurn.copy(car.way > 0 ? none : half);
        cars.setMatrixAt(i, carMatrix.compose(carAt, carTurn, carScale.set(...car.scale)));
      });
      cars.instanceMatrix.needsUpdate = true;
    });
  }

  // Signs: lit letters cut out of one sheet, standing on the lattices built above. A small line under or over
  // a big one says what the business is.
  {
    const grotesque = "'Helvetica Neue', Arial, sans-serif", heavy = "'Arial Black', 'Helvetica Neue', Arial, sans-serif", didone = "Didot, 'Bodoni 72', Georgia, serif";
    const names = {
      rush: { text: "RUSH B", font: `800 250px ${grotesque}`, colour: "#ffb45e", core: "#fff0cf" },
      silver: { text: "SILVER I", font: `300 260px ${grotesque}`, colour: "#7ff2df", core: "#eafffb" },
      bank: { text: "SAVINGS BANK", font: `500 110px ${grotesque}`, colour: "#7ff2df", core: "#eafffb" },
      elite: { text: "GLOBAL ELITE", font: "700 230px 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", colour: "#8ef5e3", core: "#f0fffc" },
      tap: { text: "ONE TAP", font: `900 250px ${heavy}`, colour: "#ff6a3c", core: "#ffe1d0" },
      kebab: { text: "KEBAB", font: `900 110px ${heavy}`, colour: "#ffd98a", core: "#fff6e0" },
      hotel: { text: "HOTEL", font: `600 110px ${didone}`, colour: "#ff9cc0", core: "#fff0f6" },
      sneaky: { text: "SNEAKY BEAKY", font: `600 200px ${didone}`, colour: "#ff9cc0", core: "#fff0f6" },
      tick: { text: "64 TICK FM", font: `800 240px ${grotesque}`, colour: "#ff5fa8", core: "#ffe6f2" },
    };
    type Name = keyof typeof names;
    const rects = {} as Record<Name, [number, number, number, number]>;
    const sheet = track(canvasTexture(2048, 2048, (context) => {
      context.clearRect(0, 0, 2048, 2048);
      context.textBaseline = "middle"; context.textAlign = "left"; context.lineJoin = "round";
      // Shelves: each name goes beside the last while the row has room, else starts the next row.
      let x = 0, y = 0, shelf = 0;
      (Object.keys(names) as Name[]).forEach((key) => {
        const name = names[key];
        context.font = name.font;
        const size = Number(/(\d+)px/.exec(name.font)![1]), inked = Math.min(2020, context.measureText(name.text).width), width = Math.ceil(inked + 28), height = Math.round(size * 1.16);
        if (x + width > 2048) { x = 0; y += shelf + 8; shelf = 0; }
        context.strokeStyle = name.colour; context.lineWidth = size * 0.05;
        context.strokeText(name.text, x + 14, y + height / 2, inked);
        context.fillStyle = name.colour;
        context.fillText(name.text, x + 14, y + height / 2, inked);
        context.strokeStyle = name.core; context.lineWidth = size * 0.012;
        context.strokeText(name.text, x + 14, y + height / 2, inked);
        rects[key] = [x, y, width, height];
        x += width + 8; shelf = Math.max(shelf, height);
      });
    }));
    sheet.anisotropy = anisotropy;
    const position: number[] = [], uv: number[] = [], colour: number[] = [], index: number[] = [];
    /** A sign fitted inside `room` metres (length, letter cell), centred at (x, y, z), turned about the vertical; `upright` stands it on end. */
    const sign = (key: Name, room: [number, number], x: number, y: number, z: number, turn: number, gain: number, upright = false) => {
      const [rx, ry, rw, rh] = rects[key], fit = Math.min(room[0] / rw, room[1] / rh), width = rw * fit, height = rh * fit, base = position.length / 3;
      const c = Math.cos(turn), s = Math.sin(turn);
      const corners = upright ? [[-height / 2, -width / 2], [height / 2, -width / 2], [height / 2, width / 2], [-height / 2, width / 2]] : [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
      const u0 = rx / 2048, u1 = (rx + rw) / 2048, v0 = 1 - (ry + rh) / 2048, v1 = 1 - ry / 2048;
      const uvs = upright ? [[u1, v0], [u1, v1], [u0, v1], [u0, v0]] : [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      corners.forEach(([a, b], i) => { position.push(x + a * c, y + b, z - a * s); uv.push(...uvs[i]); colour.push(gain, gain, gain); });
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    // The couriers in the glass tower's plant band; the bank on the slab block, over its own video wall.
    sign("rush", [13.5, 3.7], 17, 26.65, -47.06, 0, 2.3);
    sign("silver", [12.6, 3.9], -24.7, 70.2, -70.23, 0, 2.2);
    sign("bank", [9.5, 1.45], -24.7, 67.72, -70.23, 0, 2.2);
    // Behind the firing line: the hotel, and the tallest tower in sight, which is of course the top rank.
    sign("hotel", [5.3, 1.5], -16, 67.5, 44.23, Math.PI, 2.2);
    sign("sneaky", [21.5, 3.0], -16, 65.02, 44.23, Math.PI, 2.2);
    sign("elite", [20, 3.8], -61, 98.3, 41.25, Math.PI, 1.9);
    sign("tap", [14.2, 3.3], 62.9, 44.6, -22, -Math.PI / 2, 2.4);
    sign("kebab", [6.2, 1.7], 62.9, 42.53, -22, -Math.PI / 2, 1.5);
    sign("tick", [30, 7.3], -36.02, 52, -63, Math.PI / 2, 2.1, true);
    const geometry = track(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colour, 3));
    geometry.setIndex(index);
    const signPaint = track(new THREE.MeshBasicMaterial({ map: sheet, alphaTest: 0.5, vertexColors: true, toneMapped: false }));
    kit.updates.push(() => signPaint.color.setScalar(0.3 + 0.7 * city.uniforms.skyGain.value));
    const signs = new THREE.Mesh(geometry, signPaint);
    signs.name = "city signs";
    signs.frustumCulled = false;
    signs.matrixAutoUpdate = false;
    scene.add(signs);
    kit.mirrorHidden.push(signs);
  }

  // The video wall on the slab block: six spots, two columns of three on one sheet.
  {
    const ads = track(canvasTexture(2048, 2046, (context) => {
      const sans = "'Helvetica Neue', Arial, sans-serif", serif = "Didot, 'Bodoni 72', Georgia, serif";
      const spot = (index: number, draw: () => void) => {
        const x = Math.floor(index / 3) * 1024, y = (index % 3) * 682;
        context.save(); context.beginPath(); context.rect(x, y, 1024, 682); context.clip(); context.translate(x, y);
        context.textAlign = "left"; context.textBaseline = "alphabetic"; context.lineCap = "round"; context.lineJoin = "round";
        draw();
        context.restore();
      };
      const say = (value: string, x: number, y: number, font: string, fill: string, width: number) => { context.font = font; context.fillStyle = fill; context.fillText(value, x, y, width); };
      const wash = (stops: string[], x1 = 1024, y1 = 682) => {
        const gradient = context.createLinearGradient(0, 0, x1, y1);
        stops.forEach((stop, i) => gradient.addColorStop(i / (stops.length - 1), stop));
        context.fillStyle = gradient; context.fillRect(0, 0, 1024, 682);
      };
      // An energy drink for the last one standing: one dot against five on the can.
      spot(0, () => {
        wash(["#14061f", "#4a0f3c", "#ff5a36"]);
        context.fillStyle = "#ffe27a"; context.beginPath(); context.arc(780, 350, 210, 0, Math.PI * 2); context.fill();
        context.save(); context.translate(780, 350); context.rotate(-0.16);
        const can = context.createLinearGradient(-105, 0, 105, 0);
        can.addColorStop(0, "#08080c"); can.addColorStop(0.35, "#2c2c38"); can.addColorStop(0.58, "#8a8a9c"); can.addColorStop(1, "#0c0c12");
        context.fillStyle = can; context.beginPath(); context.roundRect(-105, -240, 210, 480, 30); context.fill();
        context.fillStyle = "#ff3d6e"; context.fillRect(-105, -70, 210, 150);
        context.textAlign = "center"; context.textBaseline = "middle";
        say("CLUTCH", 0, -20, `800 44px ${sans}`, "#14061f", 190); say("OR KICK", 0, 36, `600 34px ${sans}`, "#fff4dc", 180);
        context.fillStyle = "#ffe27a"; context.beginPath(); context.arc(-50, -150, 22, 0, Math.PI * 2); context.fill();
        for (let i = 0; i < 5; i += 1) { context.beginPath(); context.arc(30 + (i % 2) * 30, -194 + i * 22, 8, 0, Math.PI * 2); context.fill(); }
        context.restore();
        say("CLUTCH", 56, 270, `800 122px ${sans}`, "#fff4dc", 510); say("OR KICK", 56, 400, `300 122px ${sans}`, "#ffe27a", 510);
        say("ENERGY FOR THE 1 v 5", 60, 500, `600 40px ${sans}`, "#fff4dc", 500); say("no pressure. your team is watching.", 60, 560, `500 30px ${sans}`, "rgba(255,244,220,.8)", 500);
      });
      // The radio station, its waves broken into ticks.
      spot(1, () => {
        context.fillStyle = "#12060f"; context.fillRect(0, 0, 1024, 682);
        context.setLineDash([16, 12]);
        for (let i = 0; i < 6; i += 1) { context.strokeStyle = `rgba(255,95,168,${0.95 - i * 0.12})`; context.lineWidth = 16 - i; context.beginPath(); context.arc(130, 341, 62 + i * 36, -1.0, 1.0); context.stroke(); }
        context.fillStyle = "#ff5fa8"; context.beginPath(); context.arc(130, 341, 34, 0, Math.PI * 2); context.fill();
        say("64 TICK FM", 400, 300, `800 104px ${sans}`, "#ffe6f2", 590);
        say("ALL THE HITS.", 404, 390, `700 58px ${sans}`, "#ff5fa8", 580); say("SOME OF THEM REGISTER.", 404, 450, `500 42px ${sans}`, "#ffe6f2", 580);
        say("128 TICK FM plays the same songs", 404, 540, `500 30px ${sans}`, "rgba(255,230,242,.7)", 580);
      });
      // The couriers: a parcel that left in a hurry.
      spot(2, () => {
        wash(["#0d1a2c", "#1d3350"], 0);
        context.strokeStyle = "#f0b25a"; context.lineWidth = 18;
        for (const [x0, x1, y] of [[40, 150, 250], [70, 170, 320], [30, 140, 390], [90, 180, 460]]) { context.globalAlpha = 0.3 + (x1 - x0) / 250; context.beginPath(); context.moveTo(x0, y); context.lineTo(x1, y); context.stroke(); }
        context.globalAlpha = 1;
        context.save(); context.translate(300, 350); context.rotate(-0.1);
        context.fillStyle = "#f0b25a"; context.beginPath(); context.roundRect(-110, -110, 220, 220, 16); context.fill();
        context.fillStyle = "#c98a34"; context.fillRect(-110, -84, 220, 14);
        context.textAlign = "center"; context.textBaseline = "middle";
        say("B", 0, 22, `800 170px ${sans}`, "#0d1a2c", 200);
        context.restore();
        say("RUSH B", 450, 330, `800 136px ${sans}`, "#f4ead6", 530);
        say("COURIERS · DON'T STOP", 454, 410, `600 42px ${sans}`, "#f0b25a", 530);
        say("all five of us, every delivery", 454, 500, `500 36px ${sans}`, "#9db4cf", 530);
      });
      // A luxury good, on a price tag.
      spot(3, () => {
        const felt = context.createRadialGradient(512, 341, 60, 512, 341, 640);
        felt.addColorStop(0, "#12402a"); felt.addColorStop(1, "#04100a");
        context.fillStyle = felt; context.fillRect(0, 0, 1024, 682);
        context.strokeStyle = "#e7c66a"; context.lineWidth = 4; context.strokeRect(30, 30, 964, 622);
        context.lineWidth = 6; context.beginPath(); context.moveTo(292, 150); context.lineTo(336, 102); context.lineTo(732, 102); context.lineTo(732, 198); context.lineTo(336, 198); context.closePath(); context.stroke();
        context.beginPath(); context.arc(326, 150, 9, 0, Math.PI * 2); context.stroke();
        context.lineWidth = 3; context.beginPath(); context.moveTo(318, 148); context.quadraticCurveTo(210, 130, 150, 32); context.stroke();
        context.textAlign = "center";
        say("T H E   A W P", 540, 170, `600 54px ${sans}`, "#e7c66a", 360);
        say("$4750", 512, 440, `700 260px ${serif}`, "#fff4dc", 900);
        say("in this economy?", 512, 580, `italic 500 76px ${serif}`, "#e7c66a", 800);
      });
      // One hundred and fifty rounds: wild at first, a ruled line by the end of the belt.
      spot(4, () => {
        wash(["#2a0a06", "#8c1f10", "#d9481f"]);
        const stray = rng(1700);
        context.fillStyle = "rgba(255,244,220,.9)";
        for (let i = 0; i < 150; i += 1) { context.beginPath(); context.arc(60 + i * 6.06, 590 + (stray() - 0.5) * 172 * Math.exp(-i / 34), 4.5, 0, Math.PI * 2); context.fill(); }
        say("NEGEV", 56, 250, `800 210px ${sans}`, "#fff4dc", 900);
        say("because money is not real", 60, 340, `600 60px ${sans}`, "#ffd98a", 900);
        say("$1700 · 150 rounds · nobody buys it", 60, 420, `500 40px ${sans}`, "rgba(255,244,220,.85)", 900);
      });
      // The cola: the can is only an outline, but it makes all the right noises.
      spot(5, () => {
        wash(["#1a0806", "#5a140e", "#b3261c"]);
        context.save(); context.translate(812, 341);
        context.strokeStyle = "#fff4dc"; context.lineWidth = 8; context.setLineDash([26, 18]);
        context.beginPath(); context.roundRect(-88, -200, 176, 400, 26); context.stroke();
        context.setLineDash([]); context.lineWidth = 10;
        for (let i = 0; i < 3; i += 1) for (const side of [0, Math.PI]) { context.globalAlpha = 0.8 - i * 0.22; context.beginPath(); context.arc(0, 0, 140 + i * 32, side - 0.5, side + 0.5); context.stroke(); }
        context.restore();
        say("DECOY", 56, 260, `800 150px ${sans}`, "#fff4dc", 540); say("COLA", 56, 400, `300 150px ${sans}`, "#ffb3a0", 540);
        say("sounds like the real thing", 60, 500, `600 44px ${sans}`, "#fff4dc", 530); say("$50 · contains no cola", 60, 560, `500 34px ${sans}`, "rgba(255,244,220,.8)", 530);
      });
    }));
    ads.anisotropy = anisotropy;
    const wide = screenRect.x1 - screenRect.x0, tall = screenRect.y1 - screenRect.y0;
    const screen = new THREE.Mesh(track(new THREE.PlaneGeometry(wide, tall)), track(new THREE.ShaderMaterial({
      name: "city video wall",
      uniforms: { ...city.fogUniforms(), time: city.uniforms.time, skyGain: city.uniforms.skyGain, map: { value: ads }, gain: { value: 1.7 }, pitch: { value: new THREE.Vector2(wide / 0.05, tall / 0.05) } },
      vertexShader: SCREEN_VERTEX, fragmentShader: SCREEN_FRAGMENT, fog: true,
    })));
    screen.name = "city video wall";
    screen.position.set((screenRect.x0 + screenRect.x1) / 2, (screenRect.y0 + screenRect.y1) / 2, screenRect.z);
    screen.matrixAutoUpdate = false;
    screen.updateMatrix();
    scene.add(screen);
    kit.mirrorHidden.push(screen);
  }

  // The poster hoarding on the loft building's roof, lit from above by lamps on arms.
  const away: Opt = { mirror: false };
  const inner = flat(0x07080c, 1), farSteel = flat(0x3a3f47, 0.6, 0.6);
  {
    const poster = sheetMaterial(track(posterTexture()), 1.2);
    const bx = -24.5, by = 26.6, bz = -45.0, bw = 10.4, bh = 5.2;
    add(poster, new THREE.PlaneGeometry(bw, bh), bx, by, bz, away);
    box(inner, bw + 0.3, bh + 0.3, 0.14, bx, by, bz - 0.1, away);
    for (const side of [-1, 1]) { box(farSteel, 0.12, bh + 0.3, 0.2, bx + side * (bw / 2 + 0.1), by, bz - 0.06, away); box(farSteel, bw + 0.3, 0.12, 0.2, bx, by + side * (bh / 2 + 0.1), bz - 0.06, away); }
    for (let i = 0; i < 5; i += 1) {
      const x = bx - bw / 2 + 0.4 + i * (bw - 0.8) / 4;
      box(farSteel, 0.18, by + bh / 2 - 21, 0.18, x, 21 + (by + bh / 2 - 21) / 2, bz - 0.3, away);
      rod(farSteel, [x, by + bh / 2 - 0.2, bz - 0.3], [x, 21, bz - 3.6], 0.06, away, 4);
      rod(farSteel, [x, by + bh / 2 + 0.1, bz - 0.1], [x, by + bh / 2 + 0.5, bz + 1.3], 0.035, away, 4);
      box(inner, 0.5, 0.12, 0.3, x, by + bh / 2 + 0.5, bz + 1.35, away);
      box(coolLamp, 0.42, 0.03, 0.22, x, by + bh / 2 + 0.43, bz + 1.34, away);
      halo([x, by + bh / 2 + 0.42, bz + 1.34], 0xdff0ff, 0.5);
    }
    for (let i = 0; i < 4; i += 1) rod(farSteel, [bx - bw / 2 + 0.4 + i * (bw - 0.8) / 4, 21.3, bz - 0.3], [bx - bw / 2 + 0.4 + (i + 1) * (bw - 0.8) / 4, 23.6, bz - 0.3], 0.04, away, 4);
    box(farSteel, bw + 0.6, 0.06, 0.9, bx, by - bh / 2 - 0.3, bz + 0.5, away);
    for (const y of [0.55, 1.05]) rod(farSteel, [bx - bw / 2 - 0.3, by - bh / 2 - 0.3 + y, bz + 0.92], [bx + bw / 2 + 0.3, by - bh / 2 - 0.3 + y, bz + 0.92], 0.025, away, 4);
    for (let i = 0; i <= 8; i += 1) rod(farSteel, [bx - bw / 2 - 0.3 + i * (bw + 0.6) / 8, by - bh / 2 - 0.3, bz + 0.92], [bx - bw / 2 - 0.3 + i * (bw + 0.6) / 8, by - bh / 2 + 0.75, bz + 0.92], 0.02, away, 4);
  }

  // A late flight crossing behind the skyline.
  {
    const aircraft = new THREE.Mesh(track(new THREE.SphereGeometry(0.7, 8, 6)), track(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false })));
    aircraft.castShadow = aircraft.receiveShadow = false;
    scene.add(aircraft);
    kit.updates.push((now) => {
      const t = (now / 1000 % 90) / 90, strobe = (now % 1300) < 70;
      aircraft.position.set(-320 + t * 640, 150 + t * 40, -260 + t * 90);
      (aircraft.material as THREE.MeshBasicMaterial).color.setRGB(strobe ? 7 : 1.6, strobe ? 7 : 0.25, strobe ? 7 : 0.2);
    });
  }

  // ---- Tower cranes on the site across the expressway ---------------------------
  const craneSteel = flat(0x8a6a16, 0.6, 0.3), work = emissive(0xe6f0ff, 2.6);
  const crane = (x: number, z: number, base: number, top: number, turn: number, reach: number) => frame(x, 0, z, 0, () => {
    const half = 0.85, height = top - base, panel = 2.6, count = Math.round(height / panel);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(craneSteel, 0.18, height, 0.18, a * half, base + height / 2, b * half, away);
    for (let i = 0; i < count; i += 1) {
      const y0 = base + i * height / count, y1 = y0 + height / count, way = i % 2 ? 1 : -1;
      for (const side of [-1, 1]) {
        rod(craneSteel, [side * half, y0, -way * half], [side * half, y1, way * half], 0.05, away, 4);
        rod(craneSteel, [-way * half, y0, side * half], [way * half, y1, side * half], 0.05, away, 4);
      }
    }
    frame(0, top, 0, turn, () => {
      box(craneSteel, 2.3, 1.2, 2.3, 0, 0.6, 0, away);
      box(inner, 1.3, 1.5, 1.5, 1.5, 0.3, 1.0, away);
      box(work, 1.32, 0.6, 1.0, 1.5, 0.6, 1.3, away);
      const apex: V3 = [0, 8.5, -0.6];
      for (const side of [-0.8, 0.8]) { rod(craneSteel, [side, 1.2, 0.8], apex, 0.07, away, 4); rod(craneSteel, [side, 1.2, -0.8], apex, 0.07, away, 4); }
      // Jib: a triangular truss.
      const jy = 1.6, jt = 3.0;
      for (const side of [-0.6, 0.6]) rod(craneSteel, [side, jy, 1], [side, jy, reach], 0.07, away, 4);
      rod(craneSteel, [0, jt, 1], [0, jt, reach - 1.5], 0.07, away, 4);
      rod(craneSteel, [0, jt, reach - 1.5], [0, jy, reach], 0.06, away, 4);
      const bays = Math.round((reach - 2.5) / 2.4);
      for (let i = 0; i < bays; i += 1) {
        const z0 = 1 + i * (reach - 2.5) / bays, z1 = z0 + (reach - 2.5) / bays, mid = (z0 + z1) / 2;
        for (const side of [-0.6, 0.6]) { rod(craneSteel, [side, jy, z0], [0, jt, mid], 0.035, away, 4); rod(craneSteel, [0, jt, mid], [side, jy, z1], 0.035, away, 4); }
        rod(craneSteel, [-0.6, jy, z0], [0.6, jy, z1], 0.03, away, 4);
      }
      // Counter jib and ballast.
      for (const side of [-0.7, 0.7]) rod(craneSteel, [side, jy, -1], [side, jy, -11], 0.08, away, 4);
      box(craneSteel, 1.6, 0.08, 10, 0, jy, -6, away);
      for (const zz of [-8.2, -9.4, -10.6]) box(formwork, 1.5, 2.0, 1.0, 0, jy - 1.0, zz, { ...away, uv: 2 });
      rod(craneSteel, apex, [0, jt, reach * 0.62], 0.035, away, 4);
      rod(craneSteel, apex, [0, jt, reach * 0.28], 0.035, away, 4);
      rod(craneSteel, apex, [0, jy, -10.5], 0.04, away, 4);
      // Trolley, fall and hook block.
      box(craneSteel, 1.3, 0.3, 1.4, 0, jy - 0.2, reach * 0.55, away);
      for (const side of [-0.15, 0.15]) rod(inner, [side, jy - 0.3, reach * 0.55], [side, jy - 19, reach * 0.55], 0.02, away, 4);
      box(craneSteel, 0.6, 0.8, 0.3, 0, jy - 19.4, reach * 0.55, away);
      for (const point of [[apex[0], apex[1] + 0.3, apex[2]], [0, jy + 0.3, reach], [0, jy + 0.4, -11]] as V3[]) { ball(mastBeacon, 0.28, ...point, away); }
      box(work, 0.6, 0.08, 0.4, 0, jy - 0.1, 4, away);
      halo([0, jy - 0.2, 4], 0xe6f0ff, 0.5, true);
    });
  });
  crane(61.9, -45.5, STREET, 94, -2.5, 38);
  crane(site.x0 + 12, site.z0 + 12, site.top + 8.6, site.top + 34, 0.9, 30);
  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 1.6);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x7468cc, 0x221a2e, 0.6));
  const sun = kit.sunLight({ color: 0x9fb4ff, intensity: 2.2, toSun: TO_MOON, extent: 30, distance: 60, near: 6, far: 120, radius: 1.6 });
  const lamp = (colour: number, intensity: number, reach: number, x: number, y: number, z: number) => {
    const light = new THREE.PointLight(colour, intensity, reach, 2);
    light.position.set(x, y, z);
    scene.add(light);
    return light;
  };
  // Four lamps carry the range; every other fitting is emissive geometry with a
  // painted pool of light under it.
  const fills = [
    lamp(0xffab62, 74, 21, -8.2, 6.0, 3.5),
    lamp(0xffab62, 74, 21, 8.2, 6.0, 3.5),
    lamp(BRAND, 66, 23, -7.4, 4.6, -14.6),
    lamp(0xffa55c, 50, 19, 8.2, 3.9, -20.1),
  ];

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 260, x: 18, y: [0.2, 6], z: [-28, 8], color: 0xc8d0ff, opacity: 0.2 });

  // ---- Life: what flies, drifts, rises and flickers ----------------------------
  // Steam. The two flues on the plant roof climb high and bend over with the wind; the kitchen vent by the bar coughs every
  // few seconds; and the street breathes up past the far parapet, lit from below.
  life.plume("steam", [[-14, plantY + 1.7, -8.9], [-13.9, plantY + 1.7, -16.3]], { rise: 8, size: [0.7, 4.4], density: 18, color: 0xc4c2ee, opacity: 0.62, lean: 5, glow: new THREE.Color(0.34, 0.4, 0.55) });
  life.plume("steam", [-11.1, 0.8, 2.5], { rise: 2.6, size: [0.18, 1.3], burst: { every: 11, length: 2.4 }, glow: new THREE.Color(0.36, 0.26, 0.14) });
  life.plume("steam", [[-6.5, 0, -35.2], [5.5, 0, -35.6]], { rise: 20, size: [2.4, 8], life: 13, density: 20, color: 0xcfc4e6, opacity: 0.6, lean: 8, glow: new THREE.Color(0.46, 0.33, 0.36) });
  // The air handler on the +x deck breathes out through a stub on its roof.
  cyl(metals.darkMetal, 0.3, 0.26, 13.2, 2.58, 6.3, {}, 14);
  life.plume("steam", [13.2, 2.75, 6.3], { rise: 6, size: [0.5, 3.4], density: 12, color: 0xd0c6dc, opacity: 0.5, lean: 4, glow: new THREE.Color(0.4, 0.3, 0.22) });
  // Pigeons from the loft: on the plant roof's guard rail, the capping of the screen, the catwalk rail and the loft's own roof.
  // They go up at a shot from any lane, wheel over the range and come back.
  life.birds("pigeon", {
    perches: [
      { from: [-9.72, plantY + 1.12, -13.5], to: [-9.72, plantY + 1.12, -3.6], thin: true },
      { from: [9.57, 5.33, -13.5], to: [9.57, 5.33, -3.4] },
      { from: [9.78, 6.87, -26.4], to: [9.78, 6.87, -17.2], thin: true },
      { from: [-3.0, 10.79, 10.45], to: [-0.6, 10.79, 10.45] },
    ],
    count: 20,
    roam: { x: [-7.5, 7.5], y: [9, 13.5], z: [-22, 2] },
  });
  // Moths at the bulkhead lamps.
  life.insects([[-9.26, 2.5, -4], [8.4, 2.5, 9.42], [9.26, 4.02, -3.6], [9.26, 4.02, -20.1]], { kind: "moths", radius: 0.36 });
  // Litter that only a real gust moves: sheets on the two open strips of deck, olive leaves on the bar's side.
  life.drift("paper", { volume: { x: [-8.4, 8.4], y: [0, 2.4], z: [-3.3, 7.6] }, count: 7 });
  life.drift("paper", { volume: { x: [-8.4, 7.4], y: [0, 2.4], z: [-15.4, -10.6] }, count: 5 });
  life.drift("leaves", { volume: { x: [-12.2, -9.95], y: [0.02, 2.2], z: [0.5, 9.5] }, count: 22, falling: 0.3, colors: [0x4c5434, 0x5e5c36, 0x6e5a2e, 0x3f4a2e, 0x7a6a3a] });
  // A banner somebody tied to the back of the billboard and never came back for: held along its top batten, the rest loose.
  {
    const print = track(canvasTexture(256, 384, (context) => {
      context.fillStyle = "#123336"; context.fillRect(0, 0, 256, 384);
      context.fillStyle = "#a9a393"; context.fillRect(0, 0, 256, 26); context.fillRect(0, 352, 256, 32);
      // Three chevrons pointing down, the range's own mark turned on its end.
      context.strokeStyle = "#c9742f"; context.lineWidth = 30; context.lineJoin = "miter";
      for (let i = 0; i < 3; i += 1) { const y = 78 + i * 86; context.beginPath(); context.moveTo(38, y); context.lineTo(128, y + 62); context.lineTo(218, y); context.stroke(); }
      // Weather: runs from the eyelets, fold lines from the months it spent rolled up, a darker hem.
      const worn = rng(64);
      for (let i = 0; i < 60; i += 1) { context.fillStyle = `rgba(0,0,0,${0.05 + worn() * 0.12})`; context.fillRect(worn() * 256, worn() * 120, 1 + worn() * 3, 60 + worn() * 300); }
      for (let y = 64; y < 384; y += 64) { context.fillStyle = "rgba(255,255,255,0.07)"; context.fillRect(0, y, 256, 2); context.fillStyle = "rgba(0,0,0,0.2)"; context.fillRect(0, y + 2, 256, 2); }
      const hem = context.createLinearGradient(0, 300, 0, 384); hem.addColorStop(0, "rgba(0,0,0,0)"); hem.addColorStop(1, "rgba(0,0,0,0.45)");
      context.fillStyle = hem; context.fillRect(0, 300, 256, 84);
      for (let x = 16; x < 256; x += 32) { context.fillStyle = "#1a1c1e"; context.beginPath(); context.arc(x, 12, 5, 0, Math.PI * 2); context.fill(); context.strokeStyle = "#8d8f92"; context.lineWidth = 2; context.stroke(); }
    }));
    print.anisotropy = anisotropy;
    const vinyl = track(new THREE.MeshStandardMaterial({ map: print, emissiveMap: print, emissive: 0xffffff, emissiveIntensity: 0.1, side: THREE.DoubleSide, roughness: 0.74, metalness: 0, envMapIntensity: 0.5 }));
    const bannerZ = boardColumns[1] + 1.9, bannerTop = 12.62, bannerDrop = 5.0;
    const banner = new THREE.Mesh(track(new THREE.PlaneGeometry(3.3, bannerDrop, 30, 44)), vinyl);
    banner.position.set(10.26, bannerTop - bannerDrop / 2, bannerZ);
    banner.rotation.y = -Math.PI / 2;
    banner.receiveShadow = true;
    banner.userData.walkThrough = true;
    scene.add(banner);
    kit.mirrorHidden.push(banner);
    kit.probeHidden.push(banner);
    life.cloth(vinyl, { amplitude: 0.13, frequency: 0.8, pin: "top", lean: 0.75 }).snap([10.2, 9, bannerZ]);
    // Its batten, and the cords that hold the batten to the columns.
    rod(metals.crate, [10.27, bannerTop, bannerZ - 1.68], [10.27, bannerTop, bannerZ + 1.68], 0.022, {}, 6);
    for (const end of [-1, 1]) rod(rubber, [10.27, bannerTop, bannerZ + end * 1.66], [10.42, bannerTop + 0.12, bannerZ + end * 1.82], 0.007, {}, 4);
  }
  // A davit on the plant roof for lifting gear up from the deck: its chain and hook hang over the range and swing in the gusts.
  {
    const davitZ = -2.5, jib = plantY + 2.4;
    box(metals.darkMetal, 0.3, 0.03, 0.3, -9.98, plantY + 0.015, davitZ);
    rod(metals.structural, [-9.98, plantY, davitZ], [-9.98, jib - 0.1, davitZ], 0.05, { shadow: true }, 8);
    rod(metals.structural, [-9.98, jib - 0.1, davitZ], [-8.82, jib, davitZ], 0.04, { shadow: true }, 8);
    rod(metals.structural, [-9.98, plantY + 1.5, davitZ], [-9.3, jib - 0.04, davitZ], 0.022, {}, 6);
    cyl(metals.darkMetal, 0.075, 0.05, -8.86, jib - 0.07, davitZ, { r: AZ }, 10);
    // The chain is real links, alternately turned; somebody has left the slops bucket on the hook.
    const drop = 4.3, pitch = 0.062, links: THREE.BufferGeometry[] = [];
    for (let k = 0; k * pitch < drop; k += 1) links.push(new THREE.TorusGeometry(0.03, 0.009, 5, 8).scale(0.72, 1.3, 1).rotateY(k % 2 ? Math.PI / 2 : 0).translate(0, -0.03 - k * pitch, 0));
    const tackle = track(mergeGeometries([
      ...links,
      new THREE.TorusGeometry(0.07, 0.018, 6, 12, Math.PI * 1.5).rotateZ(Math.PI * 0.75).translate(0, -drop - 0.34, 0),
      new THREE.TorusGeometry(0.15, 0.007, 4, 14, Math.PI).translate(0, -drop - 0.56, 0),
      new THREE.CylinderGeometry(0.155, 0.12, 0.27, 16, 1, true).translate(0, -drop - 0.69, 0),
      new THREE.CircleGeometry(0.12, 16).rotateX(Math.PI / 2).translate(0, -drop - 0.825, 0),
    ]));
    links.forEach((link) => link.dispose());
    const hoist = new THREE.Group();
    hoist.add(new THREE.Mesh(tackle, metals.brushed), new THREE.Mesh(track(new THREE.BoxGeometry(0.14, 0.24, 0.09).translate(0, -drop - 0.14, 0)), amberPaint));
    hoist.position.set(-8.86, jib - 0.14, davitZ);
    hoist.traverse((child) => { child.userData.walkThrough = true; });
    scene.add(hoist);
    kit.mirrorHidden.push(hoist);
    kit.shootable.push(...hoist.children);
    life.sway(hoist, { amplitude: 0.07, period: 4.2, creak: "chainRattle", damping: 0.05 });
  }
  // Pendant lamps over the bar, on their cords from the canopy.
  {
    const fitting = track(mergeGeometries([
      new THREE.CylinderGeometry(0.006, 0.006, 0.72, 5).translate(0, -0.36, 0),
      new THREE.CylinderGeometry(0.03, 0.03, 0.06, 10).translate(0, -0.71, 0),
      new THREE.CylinderGeometry(0.035, 0.17, 0.15, 16, 1, true).translate(0, -0.8, 0),
    ]));
    const globe = track(new THREE.SphereGeometry(0.045, 10, 8).translate(0, -0.83, 0));
    const shade = flat(0x1c2a2a, 0.5, 0.4);
    shade.side = THREE.DoubleSide;
    for (const z of [7.55, 5.65]) {
      const pendant = new THREE.Group();
      pendant.add(new THREE.Mesh(fitting, shade), new THREE.Mesh(globe, bulb));
      pendant.position.set(-13.3, 2.725, z);
      pendant.traverse((child) => { child.userData.walkThrough = true; });
      scene.add(pendant);
      kit.mirrorHidden.push(pendant);
      kit.shootable.push(...pendant.children);
      life.sway(pendant, { amplitude: 0.16, period: 1.8, damping: 0.06 });
    }
  }
  // The gust you see cross the roof is the gust you hear: it arrives over the screen wall.
  {
    const gustAt = new THREE.Vector3(9, 4, -8), gustVoice = { gain: 1, pitch: 1 };
    let gustWas = 0, gustNext = 0;
    kit.updates.push((now) => {
      const gust = wind.at(6, -8);
      if (gust > 0.6 && gustWas <= 0.6 && now > gustNext) {
        gustNext = now + 9000;
        gustVoice.gain = Math.min(1, gust * 1.2); gustVoice.pitch = 0.9 + ((now * 0.00037) % 1) * 0.2;
        options.cue?.("windGust", gustAt, gustVoice);
      }
      gustWas = gust;
    });
  }

  // ---- Bake -----------------------------------------------------------------
  flush();
  // Rotors.
  if (rotors.length) {
    const blades: THREE.BufferGeometry[] = [];
    const hub = new THREE.CylinderGeometry(0.17, 0.17, 0.09, 12);
    hub.rotateX(Math.PI / 2);
    blades.push(hub);
    for (let i = 0; i < 5; i += 1) {
      const blade = new THREE.BoxGeometry(0.8, 0.3, 0.012);
      blade.rotateX(0.5);
      blade.translate(0.56, 0, 0);
      blade.rotateZ(i * Math.PI * 2 / 5);
      blades.push(blade);
    }
    const rotor = kit.instances(mergeGeometries(blades), plantPaint, rotors.map(() => ({ position: [0, 0, 0] as V3 })), false, false);
    rotor.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    rotor.frustumCulled = false;
    kit.mirrorHidden.push(rotor);
    const spin = new THREE.Matrix4(), turned = new THREE.Matrix4();
    kit.updates.push((now) => {
      rotors.forEach(({ base, speed }, index) => { rotor.setMatrixAt(index, turned.copy(base).multiply(spin.makeRotationZ(now * 0.001 * speed + index))); });
      rotor.instanceMatrix.needsUpdate = true;
    });
  }
  // Painted pools of light: on brick they carry the brick's own texture, so they read as lit wall.
  const mask = track(poolMask());
  mask.channel = 1;
  for (const kind of ["brick", "plain"] as const) {
    const list = pools[kind];
    if (!list.length) continue;
    const position = new Float32Array(list.length * 12), uv = new Float32Array(list.length * 8), uv1 = new Float32Array(list.length * 8), colour = new Float32Array(list.length * 12), index: number[] = [];
    list.forEach((pool, q) => {
      pool.corners.forEach((corner, c) => {
        position.set(corner, q * 12 + c * 3);
        uv.set(pool.uv(corner), q * 8 + c * 2);
        uv1.set([c % 2, c < 2 ? 1 : 0], q * 8 + c * 2);
        colour.set([pool.colour.r, pool.colour.g, pool.colour.b], q * 12 + c * 3);
      });
      index.push(q * 4, q * 4 + 2, q * 4 + 1, q * 4 + 2, q * 4 + 3, q * 4 + 1);
    });
    const geometry = track(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
    geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: kind === "brick" ? brick.map : null, alphaMap: mask, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    mesh.renderOrder = 1;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  }
  // Lamp halos.
  for (const big of [false, true]) {
    const list = halos.filter((item) => item.big === big);
    if (!list.length) continue;
    const geometry = track(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(list.flatMap((item) => item.at)), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(list.flatMap((item) => [item.colour.r, item.colour.g, item.colour.b])), 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ map: track(softDiscTexture()), size: big ? 2.6 : 0.7, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: big ? 0.5 : 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    points.frustumCulled = false;
    scene.add(points);
    kit.mirrorHidden.push(points);
    kit.probeHidden.push(points);
  }

  // ---- The headline: a helicopter works the block ----------------------------
  // It comes down the expressway behind the towers (heard before it shows), turns in between them, crosses the roof low
  // with its searchlight raking the range from the screen across to the bar, and leaves along the street beyond the plant
  // room. All four lamps of the map are spoken for, so the light is drawn: a cone in the haze and a pool on the deck.
  {
    const pick = rng(4242);
    const heli = new THREE.Group();
    heli.name = "nightline-helicopter";
    heli.visible = false;
    // The machine, nose to +z: pod, cowl, boom, fin, stabiliser, mast, skids, and the lamp under the chin.
    const hull: THREE.BufferGeometry[] = [];
    const part = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]) => {
      dummy.position.set(x, y, z); dummy.rotation.set(...r); dummy.scale.set(...s); dummy.updateMatrix();
      hull.push(geometry.applyMatrix4(dummy.matrix));
    };
    part(new THREE.SphereGeometry(1, 18, 12), 0, 0, 0.7, [0, 0, 0], [1.02, 1, 2.2]);
    part(new THREE.SphereGeometry(1, 14, 10), 0, 0.72, -0.5, [0, 0, 0], [0.72, 0.55, 1.7]);
    part(new THREE.CylinderGeometry(0.14, 0.4, 5.4, 10), 0, 0.42, -3.9, [-Math.PI / 2 - 0.03, 0, 0]);
    part(new THREE.BoxGeometry(0.07, 1.7, 0.85), 0, 1.15, -6.55, [-0.45, 0, 0]);
    part(new THREE.BoxGeometry(2.1, 0.05, 0.5), 0, 0.5, -5.5);
    part(new THREE.CylinderGeometry(0.09, 0.09, 0.75, 8), 0, 1.5, 0);
    for (const side of [-1, 1]) {
      part(new THREE.CylinderGeometry(0.045, 0.045, 4, 6), side, -1.42, 0.55, [Math.PI / 2, 0, 0]);
      for (const z of [-0.5, 1.5]) part(new THREE.CylinderGeometry(0.035, 0.035, 0.85, 6), side * 0.8, -1.05, z, [0, 0, side * 0.5]);
    }
    part(new THREE.SphereGeometry(0.2, 10, 8), 0.45, -0.95, 2);
    const body = new THREE.Mesh(track(mergeGeometries(hull)), track(new THREE.MeshStandardMaterial({ color: 0x1a222e, roughness: 0.42, metalness: 0.55, envMapIntensity: 1.2 })));
    hull.forEach((geometry) => geometry.dispose());
    const blades = new THREE.Mesh(track(mergeGeometries([0, 1, 2, 3].map((k) => new THREE.BoxGeometry(0.3, 0.035, 5.2).translate(0, 0, 2.85).rotateY(k * Math.PI / 2)))), rubber);
    blades.position.y = 1.9;
    // The blur of the two rotors.
    const discs = new THREE.Mesh(
      track(mergeGeometries([new THREE.CircleGeometry(5.5, 40).rotateX(-Math.PI / 2).translate(0, 1.9, 0), new THREE.CircleGeometry(0.9, 20).rotateY(Math.PI / 2).translate(0.16, 1.2, -6.75)])),
      track(new THREE.MeshBasicMaterial({ color: 0x9aa6c8, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide })),
    );
    // Navigation lights: red to port, green to starboard, white on the tail, a red beacon on the fin, a white strobe
    // under the belly, and the searchlight's own glare.
    const lightGeometry = track(new THREE.BufferGeometry());
    lightGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([1.05, 0.1, 0.9, -1.05, 0.1, 0.9, 0, 0.6, -6.9, 0, 2.05, -6.85, 0, -1.08, -0.6, 0.45, -1, 2.18]), 3));
    const lightColours = new THREE.BufferAttribute(new Float32Array(18), 3);
    lightColours.setUsage(THREE.DynamicDrawUsage);
    lightGeometry.setAttribute("color", lightColours);
    const lights = new THREE.Points(lightGeometry, track(new THREE.PointsMaterial({ map: track(softDiscTexture()), size: 1.7, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    lights.frustumCulled = false;
    heli.add(body, blades, discs, lights);
    heli.traverse((child) => { child.userData.walkThrough = true; });
    // The beam: a unit cone from the lamp, scaled to its reach, brightest through its middle and thinning with distance.
    const SPREAD = 0.085;
    const beamMaterial = track(new THREE.ShaderMaterial({
      name: "searchlight",
      uniforms: { tint: { value: new THREE.Color(0.72, 0.84, 1) }, gain: { value: 0 }, span: { value: 1 } },
      vertexShader: /* glsl */`
        varying vec3 vNormalView;
        varying vec3 vToEye;
        varying float vAlong;
        void main() {
          vAlong = -position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormalView = normalMatrix * normal;
          vToEye = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 tint;
        uniform float gain;
        uniform float span;
        varying vec3 vNormalView;
        varying vec3 vToEye;
        varying float vAlong;
        void main() {
          float facing = abs(dot(normalize(vNormalView), normalize(vToEye)));
          float reach = (1.0 - smoothstep(0.85, 1.0, vAlong)) * smoothstep(0.0, 0.012, vAlong) / (1.0 + vAlong * span * 0.085);
          // Standing in it you see the lamp, not a white wall: the haze right in front of the eye is left out.
          reach *= smoothstep(1.5, 9.0, length(vToEye));
          gl_FragColor = vec4(tint * (gain * facing * facing * reach), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    const beam = new THREE.Mesh(track(new THREE.CylinderGeometry(0.004, SPREAD, 1, 28, 1, true).translate(0, -0.5, 0)), beamMaterial);
    const spot = track(canvasTexture(128, 128, (context) => {
      const fall = context.createRadialGradient(64, 64, 0, 64, 64, 64);
      fall.addColorStop(0, "rgba(255,255,255,1)"); fall.addColorStop(0.42, "rgba(255,255,255,0.7)"); fall.addColorStop(0.72, "rgba(255,255,255,0.22)"); fall.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = fall; context.fillRect(0, 0, 128, 128);
    }));
    const poolMaterial = track(new THREE.MeshBasicMaterial({ map: spot, color: 0x000000, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const pool = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), poolMaterial);
    pool.renderOrder = 2;
    for (const piece of [heli, beam, pool]) {
      piece.visible = false;
      piece.frustumCulled = false;
      piece.userData.walkThrough = true;
      scene.add(piece);
      kit.mirrorHidden.push(piece);
      kit.probeHidden.push(piece);
    }

    // The route and its timetable: seconds into the pass at each point. Fast down the expressway, slow over the roof, away fast.
    const WAY: V3[] = [[52, 80, -330], [52, 56, -200], [51, 38, -110], [46, 30, -66], [35, 25, -38], [14, 20, -24], [-4, 19.5, -15], [-20, 22, -4], [-38, 27, 12], [-62, 34, 26], [-100, 46, 30], [-160, 64, 30], [-250, 88, 31]];
    const WHEN = [0, 2.3, 4.2, 5.6, 7.3, 9.2, 11, 12.8, 14.6, 16.2, 17.6, 19.2, 21.2];
    const route = new THREE.CatmullRomCurve3(WAY.map((point) => new THREE.Vector3(...point)));
    const stops = WAY.length - 1, DONE = WHEN[stops] - 0.4, HEARD = 3, SWEEP = [9.6, 13];
    const pace = WHEN.map((_, i) => {
      if (i === 0 || i === stops) return 1 / (i ? WHEN[i] - WHEN[i - 1] : WHEN[1] - WHEN[0]);
      const before = 1 / (WHEN[i] - WHEN[i - 1]), after = 1 / (WHEN[i + 1] - WHEN[i]);
      return 2 * before * after / (before + after);
    });
    /** Where on the route (the curve's own 0..1) the machine is `seconds` into a pass: the timetable, eased through its stops. */
    const along = (seconds: number) => {
      const s = Math.min(Math.max(seconds, 0), WHEN[stops]);
      let i = 0;
      while (i < stops - 1 && s >= WHEN[i + 1]) i += 1;
      const h = WHEN[i + 1] - WHEN[i], w = (s - WHEN[i]) / h, w2 = w * w, w3 = w2 * w;
      return (i * (2 * w3 - 3 * w2 + 1) + h * pace[i] * (w3 - 2 * w2 + w) + (i + 1) * (3 * w2 - 2 * w3) + h * pace[i + 1] * (w3 - w2)) / stops;
    };
    // The line the light walks across the deck: in over the screen, between the stations, past the firing line, out by the bar.
    const rake = new THREE.CatmullRomCurve3([[6.5, -15], [3.6, -9.5], [-0.6, -1.2], [-1.7, 5.3], [-7.6, 6.6], [-9.2, 6.6]].map(([x, z]) => new THREE.Vector3(x, 0, z)));

    // The camera that draws the horizon tells us where the player's head is; the floor's mirror (below the deck) and the
    // square right-angle views of a light probe are not the player.
    const eye = { x: 0, y: 1.62, z: 7.2, fx: 0, fz: -1, frames: 0 };
    horizon.onBeforeRender = (_renderer, _scene, camera) => {
      const e = camera.matrixWorld.elements, lens = camera as THREE.PerspectiveCamera;
      if (!lens.isPerspectiveCamera || e[13] < 0 || (lens.fov === 90 && lens.aspect === 1)) return;
      eye.x = e[12]; eye.y = e[13]; eye.z = e[14]; eye.fx = -e[8]; eye.fz = -e[10]; eye.frames += 1;
    };

    const at = new THREE.Vector3(), ahead = new THREE.Vector3(), later = new THREE.Vector3(), nose = new THREE.Vector3(), idle = new THREE.Vector3(), swept = new THREE.Vector3(), ray = new THREE.Vector3(), toEye = new THREE.Vector3();
    const DOWN = new THREE.Vector3(0, -1, 0), cueAt = new THREE.Vector3(), voice = { gain: 1, pitch: 1 };
    const { smoothstep, clamp } = THREE.MathUtils;
    const within = (v: number, low: number, high: number) => smoothstep(v, low, low + 0.8) * (1 - smoothstep(v, high - 0.8, high));
    /** Whether the beam, from the lamp down to the deck at (fx, fz), passes a wall standing on x = plane between z from..to. */
    const clears = (fx: number, fz: number, plane: number, from: number, to: number, top: number) => {
      if ((nose.x - plane) * (fx - plane) >= 0) return true;
      const t = (plane - nose.x) / (fx - nose.x), z = nose.z + (fz - nose.z) * t;
      return z < from || z > to || nose.y * (1 - t) > top;
    };
    let born = -1, next = -1, began = -1, before = -1, said = false, took = false, again = false, rested = false, restX = 0, restZ = 0, restFx = 0, restFz = 0, forced = -1, onDeck = 0;
    /** For captures and tuning: starts a pass now, `lead` seconds in. */
    heli.userData.launch = (lead = 0) => { forced = Math.max(0, lead); };
    kit.updates.push((now) => {
      const dt = before < 0 ? 0 : Math.min(0.1, (now - before) / 1000);
      before = now;
      if (born < 0) { born = now; next = now + 4200; }
      // The map is not told when the player comes in, and the first pass may be over before they do. So the first time
      // the camera is moved a pass is brought forward, or, if one is already half gone, it comes round again.
      if (!took && eye.frames > 30) {
        if (!rested) { rested = true; restX = eye.x; restZ = eye.z; restFx = eye.fx; restFz = eye.fz; }
        else if (Math.abs(eye.x - restX) + Math.abs(eye.z - restZ) > 0.05 || Math.abs(eye.fx - restFx) + Math.abs(eye.fz - restFz) > 0.02) {
          took = true;
          if (began < 0) { if (next - now > 5000) next = now + 3500; }
          else again = now - began > 5000;
        }
      }
      if (forced >= 0) { began = now - forced * 1000; said = forced > HEARD; forced = -1; }
      else if (began < 0 && now >= next) { began = now; said = false; }
      if (began < 0) return;
      const tau = (now - began) / 1000;
      if (tau >= DONE) {
        began = -1; next = now + (again ? 9000 : 22000 + pick() * 40000); again = false; onDeck = 0;
        heli.visible = beam.visible = pool.visible = false;
        return;
      }
      // Heard first: the sound starts while the machine is still behind the towers. It is placed straight overhead,
      // because a passing voice is sent along a line of the engine's choosing and that line could run against the flight.
      if (!said && tau >= HEARD) {
        said = true;
        voice.pitch = 0.94 + pick() * 0.12;
        options.cue?.("heliPass", cueAt.set(eye.x, eye.y + 22, eye.z), voice);
      }
      route.getPoint(along(tau), at); route.getPoint(along(tau + 0.15), ahead); route.getPoint(along(tau + 0.8), later);
      const dx = ahead.x - at.x, dz = ahead.z - at.z, yaw = Math.atan2(dx, dz), run = Math.hypot(dx, dz);
      let turn = Math.atan2(later.x - ahead.x, later.z - ahead.z) - yaw;
      turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
      // Nose down with speed, banked into the turn.
      heli.position.copy(at);
      heli.rotation.set(0.04 + at.distanceTo(ahead) * 0.0147 - Math.atan2(ahead.y - at.y, run) * 0.5, yaw, clamp(-turn * 1.1, -0.5, 0.5), "YXZ");
      heli.visible = true;
      blades.rotation.y = now * 0.016;
      // Lights fade into the haze with distance; the beacon and the strobe keep their own time.
      const haze = Math.exp(-((Math.hypot(at.x - eye.x, at.y - eye.y, at.z - eye.z) * 0.0042) ** 2)), seconds = now / 1000;
      const live = smoothstep(tau, 0.3, 1.8) * (1 - smoothstep(tau, DONE - 1.5, DONE));
      const beacon = (seconds * 1.1) % 1 < 0.12 ? haze : haze * 0.04, strobe = (seconds * 0.9) % 1 < 0.05 || (seconds * 0.9 + 0.86) % 1 < 0.05 ? haze : 0;
      lightColours.setXYZ(0, 2.6 * haze, 0.12 * haze, 0.08 * haze);
      lightColours.setXYZ(1, 0.1 * haze, 2.3 * haze, 0.6 * haze);
      lightColours.setXYZ(2, 0.7 * haze, 0.7 * haze, 0.78 * haze);
      lightColours.setXYZ(3, 6 * beacon, 0.3 * beacon, 0.2 * beacon);
      lightColours.setXYZ(4, 9 * strobe, 9 * strobe, 10 * strobe);
      // The searchlight: pointed ahead and down into the streets while it travels, walked along the rake while it is over us.
      nose.set(0.45, -1, 2.18).applyQuaternion(heli.quaternion).add(at);
      idle.set(at.x + Math.sin(yaw) * 15, at.y - 30, at.z + Math.cos(yaw) * 15);
      rake.getPoint(smoothstep(tau, SWEEP[0], SWEEP[1]) * 0.999, swept);
      ray.copy(idle).lerp(swept, smoothstep(tau, SWEEP[0] - 0.7, SWEEP[0]) * (1 - smoothstep(tau, SWEEP[1], SWEEP[1] + 0.9))).sub(nose).normalize();
      // Where the middle of the beam meets the deck, and whether the billboard, the screen or the plant room is in its way.
      const falls = ray.y < -0.05, reach = falls ? nose.y / -ray.y : 0, fx = nose.x + ray.x * reach, fz = nose.z + ray.z * reach;
      const lands = falls && clears(fx, fz, 11, boardZ - boardRun / 2 - 0.4, boardZ + boardRun / 2 + 0.4, boardHigh + 0.3) && clears(fx, fz, 9.6, sideFrom, sideTo, SCREEN_TOP + 0.3) && clears(fx, fz, -9.6, sideFrom, sideTo, plantY + 1.3)
        ? within(fx, -9.3, 9.3) * within(fz, -25.4, 9.4) : 0;
      onDeck += (lands - onDeck) * Math.min(1, dt * 12);
      const overRoof = falls && fx > ROOF.x0 && fx < ROOF.x1 && fz > ROOF.z0 && fz < ROOF.z1;
      const span = Math.min(95, falls ? (overRoof ? reach * 1.3 : (nose.y - STREET) / -ray.y) : 95);
      beam.position.copy(nose);
      beam.quaternion.setFromUnitVectors(DOWN, ray);
      beam.scale.setScalar(span);
      beamMaterial.uniforms.span.value = span;
      beamMaterial.uniforms.gain.value = 0.5 * live * (0.35 + 0.65 * haze);
      beam.visible = true;
      const width = 2.5 * reach * SPREAD;
      pool.position.set(fx, 0.03, fz);
      pool.rotation.y = Math.atan2(ray.x, ray.z);
      pool.scale.set(width, 1, width / Math.max(0.4, -ray.y));
      poolMaterial.color.setRGB(0.6, 0.7, 0.88).multiplyScalar(0.3 * onDeck * live);
      pool.visible = onDeck > 0.01;
      // Caught in the beam, the lamp is a white hole in the sky.
      const dazzle = Math.max(0, ray.dot(toEye.set(eye.x - nose.x, eye.y - nose.y, eye.z - nose.z).normalize())) ** 40;
      const lampGain = (5 + 70 * dazzle) * live * haze;
      lightColours.setXYZ(5, lampGain * 0.8, lampGain * 0.9, lampGain);
      lightColours.needsUpdate = true;
    });
  }

  const lit = sunlitFromBoxes(TO_MOON, [
    new THREE.Box3(new THREE.Vector3(-15.2, 0, sideFrom), new THREE.Vector3(-9.54, PLANT_TOP + 2.5, sideTo)),
    new THREE.Box3(new THREE.Vector3(9.54, 0, sideFrom), new THREE.Vector3(9.8, SCREEN_TOP, sideTo)),
    new THREE.Box3(new THREE.Vector3(10.9, boardLow, boardZ - boardRun / 2), new THREE.Vector3(11.1, boardHigh, boardZ + boardRun / 2)),
    new THREE.Box3(new THREE.Vector3(-8.5, 0, -26.6), new THREE.Vector3(8.5, 5.2, -25.4)),
  ]);

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: [
      { position: new THREE.Vector3(-9.1, 5.2, -14), color: new THREE.Color(BRAND).multiplyScalar(0.9) },
      { position: new THREE.Vector3(-8.3, 6.2, 3.5), color: new THREE.Color(0xffa758).multiplyScalar(0.9) },
      { position: new THREE.Vector3(8.3, 6.2, 3.5), color: new THREE.Color(0xffa758).multiplyScalar(0.9) },
    ],
    look: {
      sky: "/environment/rooftop_night-2k.hdr", skyIntensity: SKY_INTENSITY, skyRotation: 0, skyClamp: 12,
      // The fog is the colour of the sky photograph's horizon, so the city sinks into the dusk it stands against.
      background: 0x1a1430, fog: 0x775965, fogDensity: 0.0042,
      haze: new THREE.Color(0.02, 0.016, 0.034), hazeDensity: 0.004, hazeCeiling: 12, hazeFade: 4,
      environmentIntensity: 1.15, exposure: 1.05, far: 700,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.3, -9),
  });
  // Birds go up at a shot; a bullet that finds a bird or something hanging is the life kit's to answer.
  return { ...range, startle: life.startle, struck: (object, point) => life.struck(object, point) };
}

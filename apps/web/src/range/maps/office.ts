import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { brushedMetal, paintedSteel, pbrMaterial, steel } from "../pbr";
import { STRIKE_ORANGE, canvasTexture, createKit, projectUv, softDiscTexture, type RangeEnvironment, type RangeOptions } from "../kit";
import { createLife } from "../life";
import { createProps } from "../props";
import { createWind } from "../wind";
import type { Glow } from "../volumetric";

// After Hours: a double-height trading floor high in a tower, at dusk, after everyone has gone home.
//
// The range runs down the cleared central aisle. Two lights fight over it: the last orange of the sun,
// raking in low from the west through venetian blinds, and the cold blue-green of screens, tickers and
// the server room. The west side is glass from floor to ceiling except where the two signs hang; the
// east side is the server room behind glass, the furnace, a panelled wall and, above everything, the
// gallery of a second level. At the far end the ceiling steps up into an atrium whose end wall is the
// ticker wall: a scrolling LED band, a row of clocks and a board of market tiles over a mezzanine.

type V3 = [number, number, number];

const WALL_X = 9.54;
const BACK_Z = 9.7;
/** The suspended ceiling over the range, and the atrium it gives way to at the far end. */
const CEIL = 7.8;
const ATRIUM_Z = -19.3, ATRIUM_CEIL = 12.5;
/** Inner face of the wall the ticker hangs on, and the front edge of the mezzanine before it. */
const END_Z = -34.28, FAR_Z = -28.3;
/** Deck of the second level: the gallery along the east side and the mezzanine across the far end. */
const DECK = 5.3;
/** The east outer wall, behind the server room, the meeting rooms and the gallery. */
const EAST_X = 14;
/** Glazing module of the west front; bay k runs from bayZ(k) to bayZ(k + 1), k = -7 .. 12. */
const BAY = 2.14;
const bayZ = (k: number) => ATRIUM_Z + BAY * k;
const GLASS_X = -9.9;
const SILL = 0.52, TRANSOM = 4.5, TRANSOM_TOP = 4.75;
/** Venetian slats: pitch, width and tilt (outer edge low), so the low sun gets about half way through. */
const SLAT = { pitch: 0.14, width: 0.1, tilt: 0.52 };
const TO_SUN = new THREE.Vector3(-1, 0.23, -0.25).normalize();
const SUN_COLOUR = 0xff9a52;
/** How far each blind is let down (1 = to the sill), by bay. Lower windows, then the band above the transom. */
const LOWER_DROP: Record<number, number> = { [-7]: 1, [-6]: 1, [-5]: 0.62, [-4]: 1, [-3]: 1, [-2]: 0.8, [-1]: 1, 5: 1, 6: 1, 7: 0.86, 8: 1, 9: 0.5, 10: 1, 11: 1, 12: 0.72 };
const UPPER_DROP: Record<number, number> = { 0: 1, 1: 0, 2: 1, 3: 0.55, 4: 0, 5: 1, 6: 1, 7: 0, 8: 0.4, 9: 1, 10: 0, 11: 1, 12: 0.65 };

function rng(seed: number) {
  let state = (seed | 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDENTITY = new THREE.Matrix4();
const mat4 = (x = 0, y = 0, z = 0, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale));
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const rbox = (w: number, h: number, d: number, radius = 0.012, metres = 1.2) => projectUv(new RoundedBoxGeometry(w, h, d, 1, radius), metres);
function cyl(radius: number, length: number, axis: "x" | "y" | "z" = "y", segments = 12, open = false, radiusEnd = radius) {
  const geometry = new THREE.CylinderGeometry(radiusEnd, radius, length, segments, 1, open);
  if (axis === "x") geometry.rotateZ(-Math.PI / 2);
  if (axis === "z") geometry.rotateX(Math.PI / 2);
  return geometry;
}
/** Rotations that turn a plate made facing +z toward another direction. */
const FACE = { south: [0, 0, 0] as V3, north: [0, Math.PI, 0] as V3, east: [0, Math.PI / 2, 0] as V3, west: [0, -Math.PI / 2, 0] as V3, up: [-Math.PI / 2, 0, 0] as V3, down: [Math.PI / 2, 0, 0] as V3 };

/** One 0.6 m tile of a lay-in grid: used light for the ceiling and dark for the raised floor. */
function tileTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#c9c9c6"; c.fillRect(0, 0, 256, 256);
    const next = rng(77);
    for (let i = 0; i < 2600; i += 1) {
      const shade = 150 + Math.floor(next() * 80);
      c.fillStyle = `rgba(${shade},${shade},${shade - 4},${0.12 + next() * 0.2})`;
      c.fillRect(next() * 256, next() * 256, 1 + next() * 2, 1 + next() * 2);
    }
    // The exposed tee of the grid and the shadow line beside it.
    c.fillStyle = "#8d8e8c"; c.fillRect(0, 0, 256, 7); c.fillRect(0, 0, 7, 256);
    c.fillStyle = "rgba(20,20,22,.5)"; c.fillRect(0, 7, 256, 2); c.fillRect(7, 0, 2, 256);
    c.fillStyle = "#e4e4e0"; c.fillRect(0, 0, 256, 2); c.fillRect(0, 0, 2, 256);
  }, true);
}

/** Street lights, lit crossings and traffic seen from far above: one city block of 240 m. */
function streetTexture() {
  return canvasTexture(512, 512, (c) => {
    c.fillStyle = "#04050a"; c.fillRect(0, 0, 512, 512);
    const next = rng(4242);
    for (let i = 0; i < 260; i += 1) {
      const warm = next() > 0.3;
      c.fillStyle = warm ? `rgba(255,${150 + Math.floor(next() * 60)},70,${0.25 + next() * 0.5})` : `rgba(190,215,255,${0.2 + next() * 0.4})`;
      c.fillRect(Math.floor(next() * 512), Math.floor(next() * 512), 2 + Math.floor(next() * 3), 2 + Math.floor(next() * 3));
    }
    for (const at of [0, 256]) {
      c.fillStyle = "#0d0d14"; c.fillRect(at, 0, 26, 512); c.fillRect(0, at, 512, 26);
      for (let p = 6; p < 512; p += 22) {
        c.fillStyle = "rgba(255,170,80,.9)"; c.fillRect(at + 1, p, 3, 3); c.fillRect(p, at + 22, 3, 3);
        if (next() > 0.45) { c.fillStyle = next() > 0.5 ? "rgba(255,245,225,.95)" : "rgba(255,40,30,.95)"; c.fillRect(at + 8 + Math.floor(next() * 10), p + 5, 3, 5); }
        if (next() > 0.45) { c.fillStyle = next() > 0.5 ? "rgba(255,245,225,.95)" : "rgba(255,40,30,.95)"; c.fillRect(p + 5, at + 6 + Math.floor(next() * 10), 5, 3); }
      }
    }
  }, true);
}

const SANS = `"Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
const MONO = `"SF Mono", Menlo, Consolas, "Courier New", monospace`;
const HAND = `"Marker Felt", "Bradley Hand", "Comic Sans MS", cursive`;
const SERIF = `Georgia, "Times New Roman", serif`;

/**
 * What runs on the tapes: the house indexes, then the ones the night desk made up. [symbol, last, change, direction]
 * The house indexes are real markets, so they carry no number here: a made-up quote would read as data.
 * It is after hours, and they say so.
 */
const QUOTES: Array<[string, string, string, number]> = [
  ["HS-CS50", "CLOSED", "NEXT 09:30", 0], ["HS-KNIFE20", "CLOSED", "NEXT 09:30", 0], ["HS-GLOVE10", "CLOSED", "NEXT 09:30", 0],
  ["HS-CASE20", "CLOSED", "NEXT 09:30", 0], ["HS-BLUE20", "CLOSED", "NEXT 09:30", 0],
  ["RUSH.B", "420.69", "13.37%", 1], ["DOOR.STK", "HALTED", "0.00%", 0], ["ECO.RND", "0.50", "99.00%", -1],
  ["FORCE.BUY", "3,100.00", "41.80%", -1], ["SAVE", "4,750.00", "0.00%", 0], ["LOSS.BNS", "3,400.00", "17.24%", 1],
  ["FLOAT", "0.0007", "0.01%", 1], ["PTRN#661", "9,999.99", "6.61%", 1], ["TRADE.UP", "10:1", "10.00%", 1],
  ["KEYS", "2.49", "SOLD SEPARATELY", 0], ["CACHE&CARRY", "16.00", "3.00%", -1], ["CLUTCH.1V5", "1.05", "400.00%", 1],
  ["WHIFF", "0.00", "100.00%", -1], ["COFFEE", "EMPTY", "100.00%", -1], ["INTERN.OT", "0.00", "8 HRS", 1],
  ["LAG", "999 MS", "0.00%", 0], ["GG.WP", "1,337.00", "0.42%", 1], ["NICE.TRY", "12.00", "16.00%", -1],
  ["PEEK", "87.30", "5.50%", -1], ["BUY.ZONE", "0:15", "CLOSING", -1], ["10K.CASES", "0.03", "0.00%", 0],
  ["LAST.ALIVE", "1.00", "80.00%", -1], ["OVERTIME", "15.15", "1.00%", 1], ["FULL.SAVE", "150.00", "2.00%", 1],
];
const UP = "#3dffa2", DOWN = "#ff5140", FLAT = "#9fb6c2", AMBER = "#ffb23e";

/** The tape: one long line of quotes, folded into TAPE_FOLDS rows of a 2048 px sheet that the shader unfolds. */
const TAPE_FOLDS = 9, TAPE_LINE = 2048 * TAPE_FOLDS;
function tickerTexture() {
  const texture = canvasTexture(2048, 64 * TAPE_FOLDS, (c) => {
    c.fillStyle = "#000"; c.fillRect(0, 0, 2048, 64 * TAPE_FOLDS);
    c.textBaseline = "middle";
    const font = (weight: number, px: number) => { c.font = `${weight} ${px}px ${SANS}`; };
    // Lay the line out once to find its length, then stretch the gaps so it closes on itself exactly.
    const pieces: Array<{ text: string; colour: string; width: number; arrow: number }> = [];
    for (const [symbol, last, change, way] of QUOTES) {
      font(900, 50);
      pieces.push({ text: symbol, colour: AMBER, width: c.measureText(symbol).width + 16, arrow: 0 });
      pieces.push({ text: last, colour: "#f2f6f4", width: c.measureText(last).width + 14, arrow: 0 });
      pieces.push({ text: change, colour: way > 0 ? UP : way < 0 ? DOWN : FLAT, width: c.measureText(change).width + 34, arrow: way || 2 });
    }
    // (Where the narrow face is missing the line comes out longer: it is then squeezed to fit rather than cut.)
    const natural = pieces.reduce((sum, piece) => sum + piece.width, 0), gap = Math.max(70, (TAPE_LINE - natural) / QUOTES.length);
    const squeeze = TAPE_LINE / (natural + gap * QUOTES.length);
    for (let row = 0; row < TAPE_FOLDS; row += 1) {
      c.save();
      c.beginPath(); c.rect(0, row * 64, 2048, 64); c.clip();
      c.translate(-row * 2048, 0); c.scale(squeeze, 1);
      let x = gap / 2;
      pieces.forEach((piece, index) => {
        font(900, 50);
        const y = row * 64 + 34;
        if (piece.arrow) {
          c.fillStyle = piece.colour; c.beginPath();
          if (piece.arrow === 1) { c.moveTo(x + 2, y + 13); c.lineTo(x + 13, y - 15); c.lineTo(x + 24, y + 13); }
          else if (piece.arrow === -1) { c.moveTo(x + 2, y - 15); c.lineTo(x + 13, y + 13); c.lineTo(x + 24, y - 15); }
          else c.rect(x + 2, y - 5, 22, 8);
          c.closePath(); c.fill();
          c.textAlign = "left"; c.fillText(piece.text, x + 30, y);
        } else { c.fillStyle = piece.colour; c.textAlign = "left"; c.fillText(piece.text, x, y); }
        x += piece.width + (index % 3 === 2 ? gap : 0);
      });
      c.restore();
    }
  }, true);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

/** The board over the tape: sixteen by four tiles, each a symbol, its last price, its day and a little history. */
function boardTexture() {
  return canvasTexture(2048, 512, (c) => {
    c.fillStyle = "#020405"; c.fillRect(0, 0, 2048, 512);
    const next = rng(6100);
    for (let i = 0; i < 64; i += 1) {
      const [symbol, last, change, way] = QUOTES[(i * 7 + 3) % QUOTES.length];
      const x = (i % 16) * 128, y = Math.floor(i / 16) * 128, colour = way > 0 ? UP : way < 0 ? DOWN : FLAT;
      c.save(); c.translate(x, y); c.beginPath(); c.rect(3, 3, 122, 122); c.clip();
      c.fillStyle = way > 0 ? "#04180f" : way < 0 ? "#1c0705" : "#0a1114"; c.fillRect(0, 0, 128, 128);
      c.fillStyle = colour; c.fillRect(3, 3, 122, 9);
      // The tile is 1.0 x 0.6 m on the wall: lettering is drawn tall so it comes out square.
      c.scale(1, 1.6);
      c.textBaseline = "middle"; c.textAlign = "left";
      c.fillStyle = AMBER; c.font = `900 21px ${SANS}`; c.fillText(symbol, 9, 19, 110);
      c.fillStyle = "#f2f6f4"; c.font = `900 25px ${SANS}`; c.fillText(last, 9, 41, 110);
      c.fillStyle = colour; c.font = `800 15px ${SANS}`; c.fillText((way > 0 ? "+" : way < 0 ? "-" : "") + change, 9, 59, 110);
      c.scale(1, 1 / 1.6);
      // History: a row of bars.
      let level = 0.5;
      for (let bar = 0; bar < 18; bar += 1) {
        level = Math.min(1, Math.max(0.1, level + (next() - 0.5 + way * 0.07) * 0.3));
        c.fillStyle = colour; c.globalAlpha = 0.45 + 0.03 * bar; c.fillRect(9 + bar * 6.2, 122 - level * 18, 4.4, level * 18); c.globalAlpha = 1;
      }
      c.restore();
    }
  });
}

type Rect = [number, number, number, number];

/** One sheet for everything lettered or drawn: boards, notices, plaques, dials, key tops, and what is on the screens. */
function signAtlas() {
  const size = 2048;
  const rects: Record<string, Rect> = {}, aspect: Record<string, number> = {};
  const texture = canvasTexture(size, size, (c) => {
    c.fillStyle = "#000"; c.fillRect(0, 0, size, size);
    let x = 0, y = 0, rowH = 0;
    const next = rng(2025);
    const text = (value: string, tx: number, ty: number, px: number, colour: string, align: CanvasTextAlign = "center", face = SANS, weight = 800, fit = 0) => {
      c.font = `${weight} ${px}px ${face}`;
      c.fillStyle = colour; c.textAlign = align; c.textBaseline = "middle";
      if (fit > 0) c.fillText(value, tx, ty, fit); else c.fillText(value, tx, ty);
    };
    const cell = (key: string, w: number, h: number, draw: (w: number, h: number) => void) => {
      if (x + w > size) { x = 0; y += rowH; rowH = 0; }
      c.save(); c.translate(x, y); c.beginPath(); c.rect(0, 0, w, h); c.clip(); draw(w, h); c.restore();
      const g = 1.5;
      rects[key] = [(x + g) / size, 1 - (y + h - g) / size, (x + w - g) / size, 1 - (y + g) / size];
      aspect[key] = w / h;
      x += w; rowH = Math.max(rowH, h);
    };
    const smudge = (w: number, h: number, count: number, colour = "120,130,135") => {
      for (let i = 0; i < count; i += 1) {
        c.fillStyle = `rgba(${colour},${0.02 + next() * 0.05})`;
        c.beginPath(); c.ellipse(next() * w, next() * h, 20 + next() * 90, 8 + next() * 30, next() * 3, 0, Math.PI * 2); c.fill();
      }
    };
    /** A wobbly marker stroke through the given points. */
    const stroke = (points: number[][], colour: string, width = 4) => {
      c.strokeStyle = colour; c.lineWidth = width; c.lineCap = "round"; c.lineJoin = "round";
      c.beginPath();
      points.forEach(([px, py], i) => { const jx = px + (next() - 0.5) * 3, jy = py + (next() - 0.5) * 3; if (i) c.lineTo(jx, jy); else c.moveTo(jx, jy); });
      c.stroke();
    };
    const candles = (w: number, h: number, x0: number, y0: number, trend: number, count: number) => {
      let level = 0.5;
      for (let i = 0; i < count; i += 1) {
        const open = level, close = Math.min(0.95, Math.max(0.05, level + (next() - 0.5 + trend * 0.12) * 0.22));
        const hi = Math.max(open, close) + next() * 0.06, lo = Math.min(open, close) - next() * 0.06, px = x0 + (i + 0.5) * (w / count);
        c.fillStyle = c.strokeStyle = close >= open ? UP : DOWN; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(px, y0 + h * (1 - hi)); c.lineTo(px, y0 + h * (1 - lo)); c.stroke();
        c.fillRect(px - w / count * 0.3, y0 + h * (1 - Math.max(open, close)), w / count * 0.6, Math.max(2, h * Math.abs(close - open)));
        level = close;
      }
    };

    // -- Row: the two whiteboards, a poster, the desk league ------------------------------------
    cell("whiteA", 768, 416, (w, h) => {
      c.fillStyle = "#eceeea"; c.fillRect(0, 0, w, h); smudge(w, h, 26);
      text("MON A.M. — WHAT WE KNOW", 22, 34, 34, "#1d3f8f", "left", HAND, 700);
      stroke([[20, 58], [392, 60]], "#1d3f8f", 3);
      // A chart that goes up, and then does what charts do.
      stroke([[30, 330], [30, 100]], "#222", 3); stroke([[30, 330], [330, 330]], "#222", 3);
      stroke([[40, 300], [80, 280], [110, 290], [150, 230], [185, 245], [220, 170], [250, 130], [262, 120], [272, 300], [300, 316], [326, 322]], "#c0281f", 5);
      stroke([[262, 96], [262, 112]], "#1c7a3c", 3); stroke([[254, 104], [262, 114], [270, 104]], "#1c7a3c", 3);
      text("we bought here", 262, 80, 22, "#1c7a3c", "center", HAND, 700);
      text("price", 16, 86, 18, "#222", "left", HAND, 400); text("time", 330, 348, 18, "#222", "right", HAND, 400);
      const notes = ["1. RUSH B  →  liquidity is on B", "2. ECO ROUND until Friday", "3. LOSS BONUS is not a strategy", "4. SAVE.  Do NOT force buy.", "5. who took the good stapler"];
      notes.forEach((line, i) => text(line, 372, 106 + i * 46, 27, i === 3 ? "#c0281f" : "#17191c", "left", HAND, 700, 380));
      stroke([[372, 262], [640, 264]], "#c0281f", 3);
      text("DO NOT ERASE !!", 560, 352, 34, "#c0281f", "center", HAND, 700);
      c.save(); c.translate(600, 388); c.rotate(-0.05); text("(erased it. sorry.)", 0, 0, 20, "#1c7a3c", "center", HAND, 400); c.restore();
      text("float 0.0007 ?", 150, 384, 22, "#1d3f8f", "center", HAND, 400);
    });
    cell("whiteB", 640, 416, (w, h) => {
      c.fillStyle = "#eef0ec"; c.fillRect(0, 0, w, h); smudge(w, h, 22);
      text("RISK MATRIX (final v7)", 24, 34, 30, "#17191c", "left", HAND, 700);
      stroke([[60, 80], [60, 330]], "#17191c", 3); stroke([[60, 330], [330, 330]], "#17191c", 3);
      stroke([[195, 80], [195, 330]], "#8a8f93", 2); stroke([[60, 205], [330, 205]], "#8a8f93", 2);
      text("LUCK", 36, 205, 20, "#17191c", "center", HAND, 700); text("SKILL", 195, 352, 20, "#17191c", "center", HAND, 700);
      text("WHIFF", 128, 268, 24, "#c0281f", "center", HAND, 700); text("CLUTCH", 262, 142, 24, "#1c7a3c", "center", HAND, 700);
      text("eco frag", 128, 142, 22, "#1d3f8f", "center", HAND, 400); text("team flash", 262, 268, 22, "#1d3f8f", "center", HAND, 400);
      c.strokeStyle = "#c0281f"; c.lineWidth = 3; c.beginPath(); c.ellipse(128, 268, 58, 24, -0.1, 0, Math.PI * 2); c.stroke();
      text("← we are here", 232, 300, 18, "#c0281f", "left", HAND, 400);
      const notes = ["10 000 cases opened", "knives: 0", "keys: sold separately", "PATTERN #661 —", "  if you know, you know", "TRADE UP = 10 in, 1 out"];
      notes.forEach((line, i) => text(line, 368, 92 + i * 44, 24, i === 1 ? "#c0281f" : "#17191c", "left", HAND, 700, 250));
      text("next: PLAN B (rush it)", 368, 372, 24, "#1c7a3c", "left", HAND, 700, 250);
    });
    cell("posterForce", 320, 416, (w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#0c3a3d"); g.addColorStop(1, "#061a1e");
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#8ef5e3"; c.lineWidth = 3; c.strokeRect(14, 14, w - 28, h - 28);
      for (let i = 0; i < 7; i += 1) { c.fillStyle = `rgba(142,245,227,${0.12 + i * 0.1})`; c.fillRect(60 + i * 30, 250 - i * 22, 20, 60 + i * 22); }
      text("FORCE", w / 2, 86, 84, "#f4f7f5", "center", SANS, 900, 270); text("BUY", w / 2, 160, 84, "#8ef5e3", "center", SANS, 900);
      text("Because patience is for", w / 2, 342, 21, "#d6e2e0", "center", SERIF, 400); text("people with money.", w / 2, 368, 21, "#d6e2e0", "center", SERIF, 400);
      text("HS MARKETS · MOTIVATION DESK", w / 2, 394, 12, "#6fa9a2", "center", SANS, 700);
    });
    cell("leader", 320, 416, (w, h) => {
      c.fillStyle = "#f1efe8"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#14181b"; c.fillRect(0, 0, w, 62);
      text("DESK LEAGUE", 16, 24, 30, "#f1efe8", "left", SANS, 900); text("WEEK 47 · P&L, THOUSANDS", 16, 48, 13, "#8ef5e3", "left", SANS, 700);
      const rows: Array<[string, string, number]> = [["THE ALGO", "+41.2", 1], ["DESK 9", "+12.0", 1], ["NIGHT SHIFT", "+3.4", 1], ["INTERN (COFFEE)", "+0.5", 1], ["RISK", "0.0", 0], ["DESK 4", "-18.8", -1], ["WHOEVER RUSHED B", "-66.6", -1]];
      rows.forEach(([name, value, way], i) => {
        const ry = 92 + i * 42;
        if (i % 2 === 0) { c.fillStyle = "#e3e0d6"; c.fillRect(8, ry - 19, w - 16, 38); }
        text(String(i + 1), 24, ry, 22, "#14181b", "center", SANS, 900); text(name, 46, ry, 20, "#14181b", "left", SANS, 800, 180);
        text(value, w - 16, ry, 22, way > 0 ? "#12733a" : way < 0 ? "#b3261c" : "#555", "right", SANS, 900);
      });
      text("Loser buys the coffee. Again.", w / 2, 396, 15, "#555", "center", SERIF, 400);
    });
    // -- Row: posters, notices, the deal certificates, a rack door --------------------------------
    cell("posterSave", 256, 320, (w, h) => {
      c.fillStyle = "#d97f24"; c.fillRect(0, 0, w, h); c.fillStyle = "#14110d"; c.fillRect(0, h - 74, w, 74);
      text("SAVE", w / 2, 84, 96, "#14110d", "center", SANS, 900, 220); text("ROUND", w / 2, 168, 74, "#14110d", "center", SANS, 900, 220);
      text("is also risk management", w / 2, 222, 19, "#14110d", "center", SERIF, 400);
      text("RISK DESK · FLOOR 41", w / 2, h - 46, 17, "#d97f24", "center", SANS, 800); text("keep your kit, keep your job", w / 2, h - 22, 13, "#c9c2b6", "center", SANS, 600);
    });
    cell("notice", 256, 320, (w, h) => {
      c.fillStyle = "#f3f2ee"; c.fillRect(0, 0, w, h);
      text("LAST ONE OUT", w / 2, 36, 32, "#14181b", "center", SANS, 900);
      c.fillStyle = "#14181b"; c.fillRect(20, 58, w - 40, 3);
      const rows: Array<[string, boolean]> = [["BLINDS", true], ["SCREENS", true], ["LIGHTS", false], ["POSITIONS", true], ["SERVER ROOM DOOR", false]];
      rows.forEach(([name, done], i) => {
        const ry = 92 + i * 36;
        c.strokeStyle = "#14181b"; c.lineWidth = 2.5; c.strokeRect(24, ry - 11, 22, 22);
        if (done) stroke([[27, ry], [34, ry + 8], [48, ry - 14]], "#1d3f8f", 4);
        text(name, 58, ry, 20, "#14181b", "left", SANS, 800, 180);
      });
      text("The floor closes at 18:00.", w / 2, 278, 15, "#444", "center", SERIF, 400); text("The market does not care.", w / 2, 298, 15, "#444", "center", SERIF, 400);
    });
    cell("kitchen", 256, 320, (w, h) => {
      c.fillStyle = "#f6f3e6"; c.fillRect(0, 0, w, h); c.fillStyle = "#1c7a6d"; c.fillRect(0, 0, w, 52);
      text("KITCHEN RULES", w / 2, 27, 27, "#f6f3e6", "center", SANS, 900);
      const rules = ["1  Your mug is not a long-term hold.", "2  Label it or lose it.", "3  The fridge is liquidated on Fridays.", "4  Decaf is a short position.", "5  COFFEE: buy the dip."];
      rules.forEach((line, i) => text(line, 16, 86 + i * 44, 16, "#1d2326", "left", SANS, 700, 226));
      text("— Facilities, floor 41", w - 16, 302, 13, "#666", "right", SERIF, 400);
    });
    const deals: Array<[string, string, string]> = [
      ["10 000 CASES LTD", "Initial Public Offering", "KEYS SOLD SEPARATELY"], ["CACHE & CARRY HOLDINGS", "Senior Notes 4.20%", "due whenever"],
      ["TRADE UP CAPITAL", "Exchange Offer", "ten for one"], ["PATTERN 661 PARTNERS", "Blue Chip Fund I", "if you know, you know"], ["FACTORY NEW SECURITIES", "Placement of Units", "float 0.0007"],
    ];
    deals.forEach(([name, kind, line], i) => cell(`deal${i}`, 224, 320, (w, h) => {
      c.fillStyle = "#f4efdf"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#8a7a52"; c.lineWidth = 2; c.strokeRect(12, 12, w - 24, h - 24); c.strokeRect(17, 17, w - 34, h - 34);
      text("This announcement appears", w / 2, 44, 11, "#555", "center", SERIF, 400); text("as a matter of record only.", w / 2, 58, 11, "#555", "center", SERIF, 400);
      text(["$420,000,000", "$1,337,000,000", "$66,100,000", "$10,000", "$7"][i], w / 2, 104, 25, "#1a1a1a", "center", SERIF, 700, 190);
      name.split(" ").reduce<string[]>((lines, word) => { const last = lines[lines.length - 1]; if (last !== undefined && (last + " " + word).length <= 14) lines[lines.length - 1] = last + " " + word; else lines.push(word); return lines; }, [])
        .forEach((part, n) => text(part, w / 2, 150 + n * 28, 23, "#1a1a1a", "center", SERIF, 700, 190));
      text(kind, w / 2, 236, 15, "#333", "center", SERIF, 400); text(line, w / 2, 256, 13, "#7a2b22", "center", SERIF, 700);
      text("HS MARKETS", w / 2, 292, 13, "#1a1a1a", "center", SANS, 900);
    }));
    cell("rackDoor", 128, 320, (w, h) => {
      c.fillStyle = "#0b0c0e"; c.fillRect(0, 0, w, h);
      for (let py = 6; py < h - 4; py += 5) for (let px = 8 + ((py / 5) % 2) * 2.5; px < w - 6; px += 5) { c.fillStyle = "#030304"; c.fillRect(px, py, 2.4, 2.4); }
      for (let unit = 0; unit < 21; unit += 1) { c.fillStyle = "rgba(60,66,72,.35)"; c.fillRect(6, 10 + unit * 14.6, w - 12, 1.2); }
      c.fillStyle = "#1b1e22"; c.fillRect(0, 0, 5, h); c.fillRect(w - 5, 0, 5, h); c.fillRect(0, 0, w, 5); c.fillRect(0, h - 5, w, 5);
      c.fillStyle = "#2a2e33"; c.fillRect(w - 20, h / 2 - 22, 8, 44);
    });
    // -- Row: the dial, the house name, the closed sign, a lit office, small fittings ---------------
    cell("dial", 256, 256, (w) => {
      c.fillStyle = "#04080a"; c.fillRect(0, 0, w, w);
      c.fillStyle = "#081215"; c.beginPath(); c.arc(128, 128, 124, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#35585c"; c.lineWidth = 4; c.beginPath(); c.arc(128, 128, 122, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 60; i += 1) {
        const a = (i / 60) * Math.PI * 2, big = i % 5 === 0, r0 = big ? 94 : 106, r1 = 114;
        c.strokeStyle = big ? "#e9fbf6" : "#5f8f8c"; c.lineWidth = big ? 6 : 2;
        c.beginPath(); c.moveTo(128 + Math.sin(a) * r0, 128 - Math.cos(a) * r0); c.lineTo(128 + Math.sin(a) * r1, 128 - Math.cos(a) * r1); c.stroke();
      }
      text("HS", 128, 176, 20, "#4f8a84", "center", SANS, 900);
    });
    cell("logo", 640, 224, (w, h) => {
      c.fillStyle = "#03080a"; c.fillRect(0, 0, w, h);
      text("HS MARKETS", w / 2, 92, 118, "#8ef5e3", "center", SANS, 900, 590);
      c.fillStyle = "#e89a42"; c.fillRect(34, 150, w - 68, 5);
      text("GLOBAL INDEX DESK  ·  FLOOR 41", w / 2, 186, 30, "#d7f3ee", "center", SANS, 800, 560);
    });
    cell("closed", 640, 224, (w, h) => {
      c.fillStyle = "#0a0303"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#ff4a3a"; c.lineWidth = 5; c.strokeRect(12, 12, w - 24, h - 24);
      text("MARKET CLOSED", w / 2, 86, 86, "#ff4a3a", "center", SANS, 900, 580);
      text("NEXT OPEN 09:30  ·  GO HOME", w / 2, 172, 36, "#ffb23e", "center", SANS, 800, 560);
    });
    cell("officeLit", 384, 224, (w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#ffd9a0"); g.addColorStop(1, "#c98a48");
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      // Shelves, a lamp and a plant, seen as shapes against the lit wall; nobody is in.
      c.fillStyle = "rgba(60,36,18,.75)"; c.fillRect(30, 60, 110, 8); c.fillRect(30, 110, 110, 8);
      for (let i = 0; i < 9; i += 1) c.fillRect(34 + i * 11, 60 - 22 - (i % 3) * 5, 8, 22 + (i % 3) * 5);
      c.fillRect(250, 150, 90, 74); c.fillRect(288, 96, 10, 56); c.beginPath(); c.moveTo(262, 98); c.lineTo(324, 98); c.lineTo(310, 66); c.lineTo(276, 66); c.closePath(); c.fill();
      c.beginPath(); c.ellipse(190, 150, 26, 44, 0, 0, Math.PI * 2); c.fill(); c.fillRect(176, 186, 28, 38);
      for (let py = 0; py < h; py += 9) { c.fillStyle = "rgba(40,24,10,.5)"; c.fillRect(0, py, w, 3); }
      c.fillStyle = "#1a1c1f"; c.fillRect(w / 2 - 4, 0, 8, h);
    });
    cell("reader", 64, 128, (w, h) => {
      c.fillStyle = "#17191c"; c.fillRect(0, 0, w, h); c.fillStyle = "#0b0c0e"; c.fillRect(8, 40, w - 16, h - 52);
      for (let r = 0; r < 4; r += 1) for (let q = 0; q < 3; q += 1) { c.fillStyle = "#2c3136"; c.fillRect(13 + q * 14, 48 + r * 17, 10, 12); }
      c.fillStyle = "#2a3f44"; c.fillRect(8, 8, w - 16, 24);
    });
    // -- Row: ceiling and desk fittings ----------------------------------------------------------
    cell("diffuser", 192, 192, (w) => {
      c.fillStyle = "#a9adaf"; c.fillRect(0, 0, w, w);
      for (let i = 0; i < 5; i += 1) { const inset = 10 + i * 17; c.fillStyle = "#3b3f42"; c.fillRect(inset, inset, w - inset * 2, w - inset * 2); c.fillStyle = "#b4b8ba"; c.fillRect(inset + 7, inset + 7, w - inset * 2 - 14, w - inset * 2 - 14); }
      c.fillStyle = "#2a2d30"; c.fillRect(86, 86, 20, 20);
    });
    cell("troffer", 384, 192, (w, h) => {
      c.fillStyle = "#9da1a3"; c.fillRect(0, 0, w, h); c.fillStyle = "#16191c"; c.fillRect(10, 10, w - 20, h - 20);
      for (let px = 10; px < w - 10; px += 8) { c.fillStyle = "rgba(90,100,108,.3)"; c.fillRect(px, 10, 1.5, h - 20); }
      for (let py = 10; py < h - 10; py += 8) { c.fillStyle = "rgba(90,100,108,.3)"; c.fillRect(10, py, w - 20, 1.5); }
      c.fillStyle = "#2d3236"; c.fillRect(w / 2 - 3, 10, 6, h - 20);
    });
    cell("keys", 384, 128, (w, h) => {
      c.fillStyle = "#101214"; c.fillRect(0, 0, w, h);
      for (let r = 0; r < 5; r += 1) for (let q = 0; q < 18; q += 1) {
        if (r === 4 && q > 3 && q < 11) continue;
        const special = (r * 18 + q) % 23 === 5;
        c.fillStyle = special ? "#c2571f" : (q > 14 ? "#2c3034" : "#24272b"); c.fillRect(8 + q * 20.6, 9 + r * 22.6, 17.5, 18.5);
        c.fillStyle = "rgba(210,220,220,.5)"; c.fillRect(12 + q * 20.6, 13 + r * 22.6, 5, 2);
      }
      c.fillStyle = "#24272b"; c.fillRect(8 + 4 * 20.6, 9 + 4 * 22.6, 7 * 20.6 - 3, 18.5);
    });
    cell("turret", 160, 160, (w) => {
      c.fillStyle = "#15171a"; c.fillRect(0, 0, w, w);
      c.fillStyle = "#06222a"; c.fillRect(48, 12, 100, 36); text("LINE 2  MISSED 14", 98, 30, 11, "#52d7c4", "center", MONO, 700, 92);
      for (let r = 0; r < 5; r += 1) for (let q = 0; q < 5; q += 1) { c.fillStyle = (r + q * 3) % 7 === 0 ? "#b0471d" : (r + q) % 5 === 0 ? "#1f6a54" : "#2b2f33"; c.fillRect(50 + q * 20, 58 + r * 19, 16, 14); }
      c.fillStyle = "#0a0b0d"; c.fillRect(8, 10, 32, 140);
      for (let py = 20; py < 60; py += 5) { c.fillStyle = "#24272b"; c.fillRect(13, py, 22, 2); }
    });
    for (let i = 0; i < 3; i += 1) cell(`paper${i}`, 128, 176, (w, h) => {
      c.fillStyle = i === 2 ? "#f0ecd9" : "#f2f3f1"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#1c2024"; c.fillRect(10, 10, 60 + i * 12, 7);
      if (i === 1) { candles(100, 54, 14, 28, 1, 14); for (let line = 0; line < 9; line += 1) { c.fillStyle = "#70767b"; c.fillRect(10, 96 + line * 8, 40 + next() * 66, 2.5); } }
      else for (let line = 0; line < 17; line += 1) { c.fillStyle = line % 6 === 5 ? "#b3261c" : "#70767b"; c.fillRect(10, 28 + line * 8.2, 30 + next() * 78, 2.5); }
      if (i === 2) { c.strokeStyle = "rgba(110,70,30,.45)"; c.lineWidth = 5; c.beginPath(); c.arc(84, 120, 26, 0, Math.PI * 2); c.stroke(); }
    });
    cell("exit", 256, 112, (w, h) => {
      c.fillStyle = "#0b3a1f"; c.fillRect(0, 0, w, h);
      text("EXIT", 100, h / 2 + 2, 84, "#b9ffd0", "center", SANS, 900);
      c.fillStyle = "#b9ffd0"; c.beginPath(); c.moveTo(186, 36); c.lineTo(236, h / 2); c.lineTo(186, h - 36); c.lineTo(186, h - 50); c.lineTo(214, h / 2); c.lineTo(186, 50); c.closePath(); c.fill();
    });
    cell("floorBox", 96, 96, (w) => {
      c.fillStyle = "#6f757a"; c.fillRect(0, 0, w, w); c.fillStyle = "#2a2d30"; c.fillRect(8, 8, w - 16, w - 16); c.fillStyle = "#555b60"; c.fillRect(12, 12, w - 24, w - 24);
      c.fillStyle = "#1a1c1e"; c.fillRect(30, 70, 36, 10); c.fillRect(20, 20, 8, 8);
    });
    const stickers: Array<[string, string, string]> = [["#f2dc5d", "call B back", "(rush)"], ["#f29bb4", "BUY ??", "no."], ["#9fe08a", "pw: ******", "nice try"]];
    stickers.forEach(([colour, first, second], i) => cell(`sticky${i}`, 96, 96, (w) => {
      c.fillStyle = colour; c.fillRect(0, 0, w, w); c.fillStyle = "rgba(0,0,0,.08)"; c.fillRect(0, 0, w, 14);
      text(first, w / 2, 42, 17, "#1c1d22", "center", HAND, 700, 86); text(second, w / 2, 68, 15, "#1c1d22", "center", HAND, 400, 86);
    }));
    // -- Rows: what is on the screens that were left on ----------------------------------------------
    const screen = (key: string, draw: (w: number, h: number) => void) => cell(key, 256, 160, (w, h) => {
      c.fillStyle = "#03070a"; c.fillRect(0, 0, w, h);
      draw(w, h);
      c.fillStyle = "#0c1a20"; c.fillRect(0, 0, w, 12); text("HS TERMINAL", 6, 6.5, 8, "#5fb3a8", "left", SANS, 800);
    });
    screen("s0", (w, h) => { candles(w - 20, h - 50, 10, 20, 1, 34); text("HS-CS50  CLOSED", 10, h - 14, 13, UP, "left", MONO, 700); });
    screen("s1", (w, h) => { candles(w - 20, h - 50, 10, 20, -1, 34); text("HS-KNIFE20  CLOSED", 10, h - 14, 13, DOWN, "left", MONO, 700); });
    screen("s2", (w, h) => {
      for (let r = 0; r < 14; r += 1) {
        const bid = 20 + next() * 90, ask = 20 + next() * 90, ry = 18 + r * 10;
        c.fillStyle = "rgba(61,255,162,.35)"; c.fillRect(w / 2 - 4 - bid, ry, bid, 8); c.fillStyle = "rgba(255,81,64,.35)"; c.fillRect(w / 2 + 4, ry, ask, 8);
        text((1284 + r * 0.05).toFixed(2), w / 2 - 6, ry + 4, 7, "#d8f6ee", "right", MONO, 700); text((1284.9 + r * 0.05).toFixed(2), w / 2 + 6, ry + 4, 7, "#ffd9d4", "left", MONO, 700);
      }
    });
    screen("s3", (w, h) => {
      for (let r = 0; r < 5; r += 1) for (let q = 0; q < 8; q += 1) {
        const v = next(); c.fillStyle = v > 0.55 ? `rgba(61,255,162,${0.15 + v * 0.5})` : `rgba(255,81,64,${0.2 + (1 - v) * 0.5})`;
        c.fillRect(8 + q * 30.4, 18 + r * 27.5, 28, 25);
      }
      void h;
    });
    screen("s4", (w, h) => {
      for (const [colour, phase] of [[UP, 0], [AMBER, 2], ["#59b8ff", 4]] as const) {
        c.strokeStyle = colour; c.lineWidth = 1.6; c.beginPath();
        for (let px = 0; px <= w - 20; px += 6) { const v = 0.5 + 0.28 * Math.sin(px * 0.035 + phase) + 0.12 * Math.sin(px * 0.13 + phase * 3) + (next() - 0.5) * 0.06; if (px) c.lineTo(10 + px, 20 + (h - 40) * v); else c.moveTo(10, 20 + (h - 40) * v); }
        c.stroke();
      }
    });
    screen("s5", (w, h) => {
      for (let r = 0; r < 13; r += 1) {
        const [symbol, last, change, way] = QUOTES[(r * 5 + 1) % QUOTES.length], ry = 22 + r * 10.6;
        text(symbol, 8, ry, 8.5, AMBER, "left", MONO, 700); text(last, 150, ry, 8.5, "#e6efec", "right", MONO, 700); text(change, w - 8, ry, 8.5, way > 0 ? UP : way < 0 ? DOWN : FLAT, "right", MONO, 700, 84);
      }
      void h;
    });
    screen("s6", (w, h) => {
      const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#0a2a3a"); g.addColorStop(1, "#06121c"); c.fillStyle = g; c.fillRect(0, 0, w, h);
      text("18:42", w / 2, 62, 52, "#e8f4f6", "center", SANS, 300); text("LOCKED  ·  press any key (it won't help)", w / 2, 112, 10, "#9cc3cc", "center", SANS, 600);
    });
    screen("s7", (w, h) => {
      c.fillStyle = "#07324a"; c.fillRect(0, 0, w, h);
      text("Working on updates  37%", w / 2, 64, 15, "#e8f4f6", "center", SANS, 600); text("Do not turn off your terminal.", w / 2, 86, 10, "#bcd8e2", "center", SANS, 400);
      text("This will take the whole night.", w / 2, 102, 10, "#bcd8e2", "center", SANS, 400);
      c.fillStyle = "#0d4a6c"; c.fillRect(48, 122, 160, 5); c.fillStyle = "#e8f4f6"; c.fillRect(48, 122, 59, 5);
    });
    screen("s8", (w, h) => {
      const lines = ["> status door", "DOOR STUCK", "> retry", "DOOR STUCK", "> retry --force-buy", "insufficient funds", "> plan b", "rushing...", "> _"];
      lines.forEach((line, i) => text(line, 8, 24 + i * 14, 10, i % 2 ? "#3dffa2" : "#b8ffd9", "left", MONO, 700));
      void w; void h;
    });
    screen("s9", (w, h) => {
      c.fillStyle = "#10409a"; c.fillRect(0, 0, w, h);
      text(":(", 22, 46, 46, "#fff", "left", SANS, 400); text("Your position ran into a problem", 22, 86, 11, "#fff", "left", SANS, 600);
      text("and needs to close. We're just", 22, 100, 11, "#fff", "left", SANS, 400); text("collecting some loss info.", 22, 114, 11, "#fff", "left", SANS, 400);
      text("Stop code: DOOR_STUCK", 22, 138, 9, "#cfe0ff", "left", MONO, 700);
    });
    screen("s10", (w, h) => {
      for (let r = 0; r < 13; r += 1) for (let q = 0; q < 6; q += 1) {
        c.strokeStyle = "rgba(120,150,160,.35)"; c.lineWidth = 0.8; c.strokeRect(6 + q * 41, 16 + r * 11, 41, 11);
        if (next() > 0.35) text((next() * 900).toFixed(1), 44 + q * 41, 21.5 + r * 11, 7, r === 12 ? AMBER : next() > 0.8 ? DOWN : "#cfe3e0", "right", MONO, 600);
      }
      void w; void h;
    });
    screen("s11", (w, h) => {
      c.fillStyle = "#050607"; c.fillRect(0, 0, w, h);
      text("NO SIGNAL", w / 2, h / 2 - 6, 26, "#8fb7ff", "center", SANS, 800); text("INPUT 2 · check the cable (it is the cable)", w / 2, h / 2 + 22, 8.5, "#6a84b8", "center", SANS, 600);
    });
    // -- Rows: plaques and labels -----------------------------------------------------------------
    const plaque = (key: string, first: string, second: string) => cell(key, 256, 96, (w, h) => {
      c.fillStyle = "#b9bdbf"; c.fillRect(0, 0, w, h); c.fillStyle = "#1a1d20"; c.fillRect(4, 4, w - 8, h - 8);
      text(first, 16, 36, 34, "#f0f3f2", "left", SANS, 900, 226); text(second, 16, 72, 16, "#8ef5e3", "left", SANS, 700, 226);
    });
    plaque("room1", "4101  RUSH B", "MEETING ROOM · SEATS 6 · NO PLANTING");
    plaque("room2", "4102  ECO ROUND", "MEETING ROOM · SEATS 8 · BYO COFFEE");
    plaque("cold", "COLD AISLE", "KEEP DOORS SHUT · 18°C · MIND THE CABLES");
    plaque("kitchenette", "4100  TEA POINT", "NO VENDING · NO REFUNDS");
    cell("hall", 512, 96, (w, h) => {
      c.fillStyle = "#07090b"; c.fillRect(0, 0, w, h);
      text("DATA HALL B", 14, 34, 44, "#9fe9ff", "left", SANS, 900); text("AUTHORISED PERSONS ONLY  ·  MATCHING ENGINE  ·  DO NOT UNPLUG", 14, 74, 15, "#5c93a6", "left", SANS, 700, 480);
    });
    cell("stuck", 256, 160, (w, h) => {
      c.fillStyle = "#e9c42b"; c.fillRect(0, 0, w, h); c.fillStyle = "#14110d"; c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
      text("DOOR STUCK?", w / 2, 46, 40, "#14110d", "center", SANS, 900, 236); text("BADGE AGAIN.", w / 2, 86, 30, "#14110d", "center", SANS, 900);
      text("Do not prop open. Do not kick.", w / 2, 120, 15, "#14110d", "center", SANS, 700); text("It knows.", w / 2, 139, 13, "#14110d", "center", SERIF, 400);
    });
    ["OPEN", "CLOSE", "SETTLE", "EXPIRY"].forEach((name, i) => cell(`label${i}`, 256, 80, (w, h) => {
      c.fillStyle = "#03080a"; c.fillRect(0, 0, w, h);
      text(name, w / 2, h / 2 + 2, 58, i === 3 ? "#ff8a5c" : "#d9fbf4", "center", SANS, 900, 236);
    }));
  });
  return { texture, rects, aspect };
}

export function buildOffice(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track } = kit;
  const metals = kit.metals();
  const wind = createWind({ heading: 0, strength: 0.06, gustiness: 0.25 });
  const life = createLife(kit, options, { wind, seed: 18 });
  const seconds = { value: 0 };

  // ---- Batching --------------------------------------------------------------
  // Everything static is baked into one mesh per material (and per shadow / hit / fine class), so the
  // detail costs triangles, not draw calls. "fine" parts are skipped on PERFORMANCE.
  type Opt = { shadow?: boolean; hit?: boolean; fine?: boolean };
  type Batch = { material: THREE.Material; opt: Required<Opt>; parts: THREE.BufferGeometry[] };
  const batches = new Map<string, Batch>();
  const put = (geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4 = IDENTITY, opt: Opt = {}) => {
    const fine = opt.fine ?? false;
    if (fine && !high) return;
    const full = { shadow: opt.shadow ?? false, hit: opt.hit ?? false, fine };
    const key = `${material.uuid}|${+full.shadow}${+full.hit}`;
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
  /** A part at a place: geometry made about its own origin. */
  const at = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, rotation?: V3, opt?: Opt, scale?: V3) =>
    put(geometry, material, mat4(x, y, z, rotation, scale), opt);
  /** An axis-aligned block between two corners, textured in world metres. */
  const slab = (material: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, opt: Opt = {}, metres = 2.4) => {
    const geometry = box(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    put(metres > 0 ? projectUv(geometry, metres) : geometry, material, IDENTITY, opt);
  };
  /** A flat plate between two corners of an axis-aligned rectangle, facing `facing`. */
  const plate = (material: THREE.Material, facing: keyof typeof FACE, a0: number, a1: number, b0: number, b1: number, level: number, opt: Opt = {}, metres = 0) => {
    const geometry = new THREE.PlaneGeometry(Math.abs(a1 - a0), Math.abs(b1 - b0));
    const a = (a0 + a1) / 2, b = (b0 + b1) / 2;
    if (metres > 0) {
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * Math.abs(a1 - a0) / metres, uv.getY(i) * Math.abs(b1 - b0) / metres);
    }
    // a runs along the wall (x for north/south/up/down plates, z for east/west ones), b is height (or z for up/down).
    if (facing === "east" || facing === "west") put(geometry, material, mat4(level, b, a, FACE[facing]), opt);
    else if (facing === "up" || facing === "down") put(geometry, material, mat4(a, level, b, FACE[facing]), opt);
    else put(geometry, material, mat4(a, b, level, FACE[facing]), opt);
  };
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

  // ---- Materials -------------------------------------------------------------
  const standard = (parameters: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.6, ...parameters });
  const weave = kit.photoSet("/textures/fabric_pattern_07-2k", 20.08 / 1.5, 38.5 / 1.5, false);
  const plasterSet = kit.wall("painted");
  const woodSet = kit.photoSet("/textures/lacquered_cherry_wood-2k", 1, 1, false);
  const plaster = standard({ ...plasterSet, color: 0x8f969b });
  const darkPlaster = standard({ ...plasterSet, color: 0x3d4247 });
  const charcoal = standard({ ...plasterSet, color: 0x1b1e22, envMapIntensity: 0.4 });
  // The photographed veneer is very dark and very red: lifted here to a mid walnut that still shows in the shade.
  const panel = standard({ ...woodSet, color: new THREE.Color(6.5, 10, 13), roughness: 0.82, envMapIntensity: 0.7 });
  const frame = pbrMaterial(keep(steel(anisotropy, [0.075, 0.08, 0.088], 0.42, 181, 256)), { envMapIntensity: 1 });
  const blackSteel = pbrMaterial(keep(paintedSteel(anisotropy, [0.022, 0.024, 0.028], 191, 0.18, 512)), { envMapIntensity: 0.9 });
  const aluminium = pbrMaterial(keep(brushedMetal(anisotropy, [0.62, 0.64, 0.66], 197, 256)), { envMapIntensity: 1.1 });
  const tiles = track(tileTexture());
  tiles.anisotropy = anisotropy;
  const ceilingTile = standard({ map: tiles, color: 0x8b8f94, roughness: 0.95, envMapIntensity: 0.35 });
  const glass = standard({ color: 0x8fa6b8, transparent: true, opacity: 0.14, roughness: 0.03, metalness: 0, envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide });
  const blindLive = seconds, blindGust = { value: 0 };
  const blind = standard({ color: 0xcfc6b4, roughness: 0.5, metalness: 0.25, emissive: new THREE.Color(1, 0.48, 0.2), emissiveIntensity: 0.3, envMapIntensity: 0.6, side: THREE.DoubleSide });
  // The slats tremble in the air handling: each carries its bay's phase in uv.x and how far it hangs
  // below the head rail in uv.y. (The sun's shadow map is drawn once, so the stripes they cast stay put.)
  blind.onBeforeCompile = (shader) => {
    shader.uniforms.blindTime = blindLive;
    shader.uniforms.blindGust = blindGust;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float blindTime;\nuniform float blindGust;")
      .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
        transformed.x += (sin(blindTime * 2.3 + uv.x * 40.0 + position.y * 1.7) * 0.6 + sin(blindTime * 5.3 + uv.x * 17.0 + position.y * 9.0) * 0.4) * (0.007 + 0.02 * blindGust) * uv.y;`);
  };
  blind.customProgramCacheKey = () => "office-blind";
  const glassIn = standard({ color: 0x9db8c6, transparent: true, opacity: 0.2, roughness: 0.03, metalness: 0, envMapIntensity: 2.6, depthWrite: false, side: THREE.DoubleSide });
  const frosted = standard({ color: 0x9fb0ba, transparent: true, opacity: 0.62, roughness: 0.55, metalness: 0, envMapIntensity: 0.9, side: THREE.DoubleSide });
  const laminate = standard({ color: 0xb4b9bc, roughness: 0.42, envMapIntensity: 0.8 });
  const plastic = standard({ color: 0x0e1012, roughness: 0.55, envMapIntensity: 0.7 });
  const cloth = standard({ color: 0x1a2026, roughness: 0.95, envMapIntensity: 0.3 });
  const paper = standard({ color: 0xe9e7df, roughness: 0.9, envMapIntensity: 0.3 });
  const screenOff = standard({ color: 0x030405, roughness: 0.1, metalness: 0, envMapIntensity: 1.7 });
  const raisedFloor = standard({ map: tiles, color: 0x6b7279, roughness: 0.38, metalness: 0.1, envMapIntensity: 0.9 });
  const serverWall = standard({ ...plasterSet, color: 0x9aa6ae });
  const cableBlue = standard({ color: 0x1b6fb8, roughness: 0.6 }), cableYellow = standard({ color: 0xc9a21c, roughness: 0.6 }), cableOrange = standard({ color: 0xc8581c, roughness: 0.6 });
  const lampWarm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.86, 0.66).multiplyScalar(2.1), toneMapped: false });
  const lampCold = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.62, 0.86, 1).multiplyScalar(1.7), toneMapped: false });
  const ringGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.8, 0.55).multiplyScalar(1.25), toneMapped: false });

  // Lettering: one sheet, drawn lit by the room (boards, notices, key tops) or lit from within (signs, dials, screens).
  const atlas = signAtlas();
  track(atlas.texture).anisotropy = anisotropy;
  const signMat = standard({ map: atlas.texture, emissive: 0xffffff, emissiveMap: atlas.texture, emissiveIntensity: 0.08, roughness: 0.6, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const glowMat = new THREE.MeshBasicMaterial({ map: atlas.texture, color: new THREE.Color(1.5, 1.5, 1.5), toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const screenOn = new THREE.MeshBasicMaterial({ map: atlas.texture, color: new THREE.Color(0.85, 0.85, 0.85), toneMapped: false });
  const remap = <T extends THREE.BufferGeometry>(geometry: T, key: string): T => {
    const [u0, v0, u1, v1] = atlas.rects[key], uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return geometry;
  };
  /** A plate carrying one entry of the sheet, `width` metres wide, facing +z until turned. */
  const sign = (key: string, width: number, height = width / atlas.aspect[key]) => remap(new THREE.PlaneGeometry(width, height), key);

  // Small lamps: status LEDs, message lamps, standby lights. One mesh, each lamp keeping its own time in the shader.
  const lamps = { position: [] as number[], colour: [] as number[], beat: [] as number[], index: [] as number[] };
  const LED = { green: [0.25, 2.6, 0.6] as V3, amber: [2.6, 1.3, 0.15] as V3, blue: [0.3, 0.9, 3.2] as V3, red: [3.2, 0.25, 0.15] as V3, white: [2, 2.2, 2.4] as V3, teal: [0.4, 2.4, 2.0] as V3 };
  const corner = new THREE.Vector3();
  /** A lamp: a `w` x `h` plate. rate 0 is steady; `chatter` makes it flick at random like a busy disc rather than blink. */
  const led = (x: number, y: number, z: number, facing: keyof typeof FACE, w: number, h: number, colour: V3, rate = 0, phase = 0, duty = 1, chatter = false) =>
    ledAt(mat4(x, y, z, FACE[facing]), w, h, colour, rate, phase, duty, chatter);
  const ledAt = (matrix: THREE.Matrix4, w: number, h: number, colour: V3, rate = 0, phase = 0, duty = 1, chatter = false) => {
    const base = lamps.position.length / 3;
    for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      corner.set(cx * w, cy * h, 0).applyMatrix4(matrix);
      lamps.position.push(corner.x, corner.y, corner.z);
      lamps.colour.push(...colour);
      lamps.beat.push(rate, phase, duty, chatter ? 1 : 0);
    }
    lamps.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const flushLamps = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(lamps.position, 3));
    geometry.setAttribute("lampColour", new THREE.Float32BufferAttribute(lamps.colour, 3));
    geometry.setAttribute("lampBeat", new THREE.Float32BufferAttribute(lamps.beat, 4));
    geometry.setIndex(lamps.index);
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: { lampTime: seconds },
      vertexShader: /* glsl */`
        attribute vec3 lampColour;
        attribute vec4 lampBeat;
        uniform float lampTime;
        varying vec3 vLamp;
        void main() {
          float on = 1.0;
          if (lampBeat.x > 0.0) {
            float t = lampTime * lampBeat.x + lampBeat.y;
            float dice = fract(sin(floor(t) * 12.9898 + lampBeat.y * 78.233) * 43758.5453);
            on = lampBeat.w > 0.5 ? step(dice, lampBeat.z) : step(fract(t), lampBeat.z);
          }
          vLamp = lampColour * mix(0.05, 1.0, on);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vLamp;
        void main() {
          gl_FragColor = vec4(vLamp, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    mesh.userData.walkThrough = true;
    scene.add(mesh);
  };

  // ---- Floor -----------------------------------------------------------------
  // Carpet tiles: the weave is photographed, the colour is laid half a metre at a time with every other
  // tile turned a quarter and the odd one in the house teal.
  const carpet = standard({ normalMap: weave.normalMap, roughnessMap: weave.roughnessMap, normalScale: new THREE.Vector2(0.7, 0.7), color: 0x4b5866, envMapIntensity: 0.3 });
  const reflection = kit.floor(carpet, { width: 20.08, depth: 38.5, z: -9.05 }, {
    lane: new THREE.Color(0.78, 0.8, 0.78),
    edge: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.75),
    markings: 0.7,
    wet: -1,
  }, false);
  {
    const laid = carpet.onBeforeCompile;
    carpet.onBeforeCompile = (shader, renderer) => {
      laid.call(carpet, shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", /* glsl */`#include <map_fragment>
        {
          vec2 carpetTile = floor(vFloorWorld.xz * 2.0), inTile = fract(vFloorWorld.xz * 2.0);
          float quarter = mod(carpetTile.x + carpetTile.y, 2.0);
          float shade = 0.9 + 0.1 * quarter + 0.14 * (floorHash(carpetTile) - 0.5);
          float accent = step(0.972, floorHash(carpetTile + 7.3));
          float seam = smoothstep(0.0, 0.014, min(min(inTile.x, 1.0 - inTile.x), min(inTile.y, 1.0 - inTile.y)));
          diffuseColor.rgb *= shade * mix(vec3(1.0), vec3(0.5, 1.3, 1.22), accent) * mix(0.7, 1.0, seam);
        }`);
    };
    carpet.customProgramCacheKey = () => "office-carpet";
    carpet.needsUpdate = true;
  }
  const carpetPlain = standard({ color: 0x232a31, roughness: 0.96, envMapIntensity: 0.25 });

  // ---- West front: panelled wall, window bays, blinds ---------------------------
  const solidBay = (k: number) => k >= 0 && k <= 4;
  const topOf = (k: number) => (k < 0 ? ATRIUM_CEIL : CEIL);
  // The panelled stretch the two west signs hang on.
  slab(panel, -10.04, -WALL_X, 0, TRANSOM, bayZ(0), bayZ(5), { shadow: true, hit: true }, 2.14);
  // The corner pier at the back wall.
  slab(plaster, -10.04, -WALL_X, 0, CEIL, bayZ(13), BACK_Z + 0.5, { shadow: true, hit: true });
  // Sill casing under every window bay, and the transom all the way along.
  slab(frame, -10.04, -9.44, 0, SILL, END_Z, bayZ(0), { shadow: true, hit: true }, 1.2);
  slab(frame, -10.04, -9.44, 0, SILL, bayZ(5), bayZ(13), { shadow: true, hit: true }, 1.2);
  slab(frame, -10.1, -9.5, TRANSOM, TRANSOM_TOP, END_Z, bayZ(13), { shadow: true, hit: true }, 1.2);
  slab(frame, -10.04, -9.74, CEIL, CEIL + 0.2, END_Z, ATRIUM_Z, { shadow: true }, 1.2);
  for (let k = -7; k <= 13; k += 1) {
    const z = bayZ(k), lowerWindow = !(k >= 1 && k <= 4), top = k <= 0 ? ATRIUM_CEIL : CEIL;
    if (lowerWindow) slab(frame, -10.0, -WALL_X, SILL, TRANSOM, z - 0.04, z + 0.04, { shadow: true }, 1.2);
    slab(frame, -10.0, -WALL_X - 0.04, TRANSOM_TOP, top, z - 0.04, z + 0.04, { shadow: true }, 1.2);
  }
  // Glass: the lower lights of the two window stretches, and the band above the transom.
  plate(glass, "east", END_Z, bayZ(0), SILL, TRANSOM, GLASS_X, { hit: true });
  plate(glass, "east", bayZ(5), bayZ(13), SILL, TRANSOM, GLASS_X, { hit: true });
  plate(glass, "east", ATRIUM_Z, bayZ(13), TRANSOM_TOP, CEIL, GLASS_X, { hit: true });
  plate(glass, "east", END_Z, ATRIUM_Z, TRANSOM_TOP, ATRIUM_CEIL, GLASS_X, { hit: true });

  /** A venetian blind in a bay: head rail, slats down to where it has been let, the rest stacked on the bottom rail. */
  const venetian = (zc: number, width: number, top: number, sill: number, drop: number, crooked = 0, seed = 1) => {
    if (drop <= 0) return;
    const random = rng(seed * 733 + 5), phase = random();
    const x = -9.72, bottom = top - 0.06 - (top - 0.06 - sill) * drop;
    slab(frame, x - 0.035, x + 0.035, top - 0.05, top, zc - width / 2, zc + width / 2, {}, 1.2);
    const count = Math.max(1, Math.floor((top - 0.09 - bottom) / SLAT.pitch));
    for (let i = 0; i < count; i += 1) {
      const y = top - 0.09 - i * SLAT.pitch, hang = (top - y) / 4;
      const geometry = box(SLAT.width, 0.004, width);
      const uv = geometry.attributes.uv;
      for (let n = 0; n < uv.count; n += 1) uv.setXY(n, phase, hang);
      // Outer edge low; a crooked blind has slipped a cord, so its slats also run downhill along the bay.
      put(geometry, blind, mat4(x, y - crooked * (i / count) * 0.5, zc, [crooked * (i / count) * 0.09, 0, -SLAT.tilt]), { shadow: true });
    }
    // The wand that tilts the slats, hanging at one end of the lower blinds.
    if (top < TRANSOM) at(cyl(0.005, 1.5, "y", 5), aluminium, x + 0.07, top - 0.8, zc + width / 2 - 0.09, [0, 0, 0.03], { fine: true });
    // Bottom rail, with the slats that are not let down stacked on it.
    const stack = Math.min(0.22, (1 - drop) * 0.3) + 0.03;
    const rail = box(0.06, stack, width);
    const railUv = rail.attributes.uv;
    for (let n = 0; n < railUv.count; n += 1) railUv.setXY(n, phase, (top - bottom) / 4);
    put(rail, blind, mat4(x, bottom - stack / 2 - crooked * 0.5, zc, [crooked * 0.09, 0, 0]), { shadow: true });
  };
  for (let k = -7; k <= 12; k += 1) {
    const zc = bayZ(k) + BAY / 2;
    if (!solidBay(k)) venetian(zc, BAY - 0.12, TRANSOM - 0.02, SILL + 0.03, LOWER_DROP[k] ?? 1, k === 7 ? 0.3 : 0, k + 20);
    if (k >= 0) venetian(zc, BAY - 0.12, CEIL - 0.02, TRANSOM_TOP + 0.03, UPPER_DROP[k] ?? 0, 0, k + 60);
  }

  // ---- Ceiling, roof and the atrium shell -------------------------------------
  {
    const geometry = new THREE.PlaneGeometry(EAST_X - GLASS_X, BACK_Z - ATRIUM_Z);
    const uv = geometry.attributes.uv, wide = (EAST_X - GLASS_X) / 0.6, deep = (BACK_Z - ATRIUM_Z) / 0.6;
    // The grid is set out from the centre line of the range and from the atrium edge.
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * wide + GLASS_X / 0.6, uv.getY(i) * deep);
    put(geometry, ceilingTile, mat4((EAST_X + GLASS_X) / 2, CEIL, (BACK_Z + ATRIUM_Z) / 2, FACE.down));
  }
  // The floors above: what keeps the sun to the windows. Its north face is the bulkhead over the atrium.
  slab(darkPlaster, -10.04, EAST_X + 0.5, CEIL + 0.06, ATRIUM_CEIL + 0.6, ATRIUM_Z, BACK_Z + 0.5, { shadow: true });
  slab(charcoal, -10.04, EAST_X + 0.5, ATRIUM_CEIL, ATRIUM_CEIL + 0.6, END_Z - 0.5, ATRIUM_Z, { shadow: true });
  // The atrium's own ceiling: coffers between deep beams, a few downlights left on in them.
  plate(darkPlaster, "down", GLASS_X, EAST_X, END_Z, ATRIUM_Z, ATRIUM_CEIL - 0.004, {}, 2.4);
  for (let k = -6; k <= -1; k += 1) slab(frame, GLASS_X, EAST_X, ATRIUM_CEIL - 0.42, ATRIUM_CEIL, bayZ(k) - 0.1, bayZ(k) + 0.1, {}, 1.6);
  for (const x of [-3.9, 2, 7.9]) slab(frame, x - 0.1, x + 0.1, ATRIUM_CEIL - 0.42, ATRIUM_CEIL, END_Z, ATRIUM_Z, {}, 1.6);
  // The gallery's back wall and the wall of the atrium above it.
  plate(plaster, "west", END_Z, BACK_Z, DECK, ATRIUM_CEIL, EAST_X - 0.004, {}, 2.4);
  // Bulkhead trim where the ceiling stops.
  slab(frame, GLASS_X, EAST_X, CEIL - 0.02, CEIL + 0.3, ATRIUM_Z - 0.06, ATRIUM_Z + 0.02, {}, 1.2);

  // ---- East side ---------------------------------------------------------------
  // Panelled wall from the far end to the furnace; a steel heat shield behind the furnace.
  slab(panel, WALL_X, 10.04, 0, TRANSOM, FAR_Z, -13.5, { shadow: true, hit: true }, 2.14);
  slab(darkPlaster, WALL_X + 0.02, 10.04, 0, TRANSOM, -13.5, -9.8, { shadow: true, hit: true });
  slab(aluminium, WALL_X, WALL_X + 0.02, 0, 4.2, -13.5, -9.8, { hit: true }, 1.6);
  // East outer wall and the back of the gallery.
  slab(darkPlaster, EAST_X, EAST_X + 0.5, 0, ATRIUM_CEIL, END_Z - 0.5, BACK_Z + 0.5, { shadow: true, hit: true });
  // Fascia of the second level, its deck and its ceilings below.
  slab(blackSteel, 9.6, 10.04, TRANSOM, DECK, FAR_Z, BACK_Z, { shadow: true, hit: true }, 1.6);
  slab(carpetPlain, 9.6, EAST_X, DECK - 0.2, DECK, FAR_Z, BACK_Z, { shadow: true }, 0);
  // The mezzanine across the far end: a wall under it, fascia, deck, and the wall the ticker hangs on.
  slab(charcoal, -10.04, EAST_X, 0, TRANSOM, FAR_Z - 0.3, FAR_Z, { shadow: true, hit: true });
  slab(blackSteel, -10.04, EAST_X, TRANSOM, DECK, FAR_Z - 0.4, FAR_Z + 0.04, { shadow: true, hit: true }, 1.6);
  slab(carpetPlain, -10.04, EAST_X, DECK - 0.2, DECK, END_Z, FAR_Z - 0.4, { shadow: true }, 0);
  slab(charcoal, -10.04, EAST_X + 0.5, 0, ATRIUM_CEIL, END_Z - 0.5, END_Z, { shadow: true, hit: true });

  // ---- Back wall ---------------------------------------------------------------
  slab(plaster, -10.04, EAST_X + 0.5, 0, CEIL, BACK_Z, BACK_Z + 0.5, { shadow: true, hit: true });

  // ---- The city ------------------------------------------------------------------
  const STREET = -170;
  const cityTime = seconds;
  {
    // Towers: boxes whose faces are drawn as floors of windows, some lit, each tower from its own seed.
    const towers: Array<{ x: number; z: number; w: number; d: number; top: number; turn: number; look: [number, number, number, number]; base?: number }> = [];
    const beaconAt: number[] = [];
    const random = rng(1811);
    const sunAzimuth = Math.atan2(TO_SUN.x, TO_SUN.z);
    const rings: Array<[number, number, number, number]> = [[78, 9, -30, 60], [128, 13, -50, 95], [190, 17, -40, 120], [270, 22, -30, 140], [370, 28, -20, 150], [480, 34, 0, 170]];
    rings.forEach(([radius, count, low, high2], ring) => {
      for (let i = 0; i < count; i += 1) {
        const angle = ((i + ring * 0.41 + (random() - 0.5) * 0.6) / count) * Math.PI * 2, r = radius + (random() - 0.5) * (ring < 2 ? 22 : 44);
        const x = Math.sin(angle) * r, z = -12 + Math.cos(angle) * r;
        const w = (20 + random() * 22) * (1 + ring * 0.12), d = (20 + random() * 22) * (1 + ring * 0.12);
        let top = low + (high2 - low) * Math.pow(random(), 1.4);
        // Keep the sun's own street clear, so it sets between the towers rather than behind one.
        let off = Math.abs(angle - (sunAzimuth < 0 ? sunAzimuth + Math.PI * 2 : sunAzimuth));
        if (off > Math.PI) off = Math.PI * 2 - off;
        if (off < 0.16) top = Math.min(top, r * 0.2 - 14);
        // Nothing may stand in our own footprint.
        if (Math.abs(x - 2) < 30 + w / 2 && Math.abs(z + 12) < 42 + d / 2) continue;
        const turn = (random() - 0.5) * 0.5, look: [number, number, number, number] = [random() * 97, 2.8 + random() * 1.6, random(), 0.12 + random() * 0.34];
        towers.push({ x, z, w, d, top, turn, look });
        // What stands on the roof: a set-back upper stage, a plant room, a mast with its lamp.
        const crown = rng(ring * 1000 + i * 17 + 5);
        let roof = top, rw = w, rd = d, mast = false;
        if (off >= 0.16 && crown() < 0.45) {
          const rise = 14 + crown() * 40;
          rw *= 0.66; rd *= 0.66;
          towers.push({ x, z, w: rw, d: rd, base: roof, top: roof + rise, turn, look: [look[0] + 11, look[1], look[2], look[3]] });
          roof += rise;
        }
        if (crown() < 0.6) {
          const rise = 4 + crown() * 6;
          towers.push({ x, z, w: rw * 0.45, d: rd * 0.45, base: roof, top: roof + rise, turn, look: [look[0] + 23, 1000, look[2], 0] });
          roof += rise;
        }
        if (off >= 0.16 && roof > 20 && crown() < 0.5) {
          const rise = 16 + crown() * 30;
          towers.push({ x, z, w: 1.1, d: 1.1, base: roof, top: roof + rise, turn, look: [0, 1000, 0, 0] });
          beaconAt.push(x, roof + rise + 1, z);
          mast = true;
        }
        if (!mast && roof > 55) beaconAt.push(x - rw * 0.3, roof + 3, z - rd * 0.3, x + rw * 0.3, roof + 3, z + rd * 0.3);
      }
    });
    // Our own tower below the floor.
    towers.push({ x: 1.98, z: -12.14, w: 24.5, d: 45.3, top: -0.4, turn: 0, look: [3.3, 2.14, 0.1, 0.3] });
    // ... and the floor over the trading floor, a hand's breadth outside the block that keeps the sun out.
    towers.push({ x: 2.23, z: -4.515, w: 24.58, d: 29.47, base: 7.9, top: ATRIUM_CEIL + 0.59, turn: 0, look: [3.3, 2.14, 0.1, 0.3] });
    // The same curtain wall over the blind sides of the trading floor itself: east, south, north.
    towers.push({ x: EAST_X + 0.52, z: -12.29, w: 0.04, d: 45.02, base: -0.4, top: 7.9, turn: 0, look: [3.3, 2.14, 0.1, 0.3] });
    towers.push({ x: EAST_X + 0.52, z: -27.03, w: 0.04, d: 15.54, base: 7.9, top: ATRIUM_CEIL + 0.59, turn: 0, look: [3.3, 2.14, 0.1, 0.3] });
    towers.push({ x: 2.23, z: BACK_Z + 0.52, w: 24.58, d: 0.04, base: -0.4, top: 7.9, turn: 0, look: [3.3, 2.14, 0.1, 0.3] });
    towers.push({ x: 2.23, z: END_Z - 0.52, w: 24.58, d: 0.04, base: -0.4, top: ATRIUM_CEIL + 0.59, turn: 0, look: [3.3, 2.14, 0.1, 0.3] });
    const geometry = box(1, 1, 1);
    const look = new Float32Array(towers.length * 4);
    towers.forEach((tower, i) => look.set(tower.look, i * 4));
    geometry.setAttribute("towerLook", new THREE.InstancedBufferAttribute(look, 4));
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.cityTime = cityTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec4 towerLook;\nvarying vec3 vTowerAt;\nvarying vec3 vTowerNormal;\nvarying vec4 vTowerLook;")
        .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
          vec3 towerSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vTowerAt = (position + 0.5) * towerSize;
          vTowerNormal = normal;
          vTowerLook = towerLook;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", /* glsl */`#include <common>
          uniform float cityTime;
          varying vec3 vTowerAt;
          varying vec3 vTowerNormal;
          varying vec4 vTowerLook;
          float towerHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace("#include <map_fragment>", /* glsl */`
          {
            vec3 n = abs(vTowerNormal);
            float seed = vTowerLook.x;
            vec3 wall = mix(vec3(0.010, 0.011, 0.017), vec3(0.022, 0.018, 0.024), vTowerLook.z);
            if (n.y > 0.5) diffuseColor.rgb = wall * 0.8;
            else {
              vec2 pitch = vec2(vTowerLook.y, 3.7);
              vec2 g = (n.x > 0.5 ? vTowerAt.zy : vTowerAt.xy) / pitch;
              vec2 cell = floor(g), f = fract(g);
              float curtain = step(0.5, vTowerLook.z);
              vec2 lo = mix(vec2(0.24, 0.3), vec2(0.05, 0.16), curtain), hi = mix(vec2(0.76, 0.78), vec2(0.95, 0.86), curtain);
              vec2 soft = fwidth(g) * 1.2;
              float pane = smoothstep(lo.x - soft.x, lo.x + soft.x, f.x) * (1.0 - smoothstep(hi.x - soft.x, hi.x + soft.x, f.x))
                         * smoothstep(lo.y - soft.y, lo.y + soft.y, f.y) * (1.0 - smoothstep(hi.y - soft.y, hi.y + soft.y, f.y));
              // Who is in: floors have moods, a few rooms change their mind while you watch.
              float mood = towerHash(vec2(cell.y, seed));
              float share = vTowerLook.w * (0.25 + 1.6 * mood * mood);
              float turn = step(0.93, towerHash(cell.yx + seed)) * floor(cityTime * 0.07 + towerHash(cell + 3.1) * 9.0);
              float on = step(1.0 - share, towerHash(cell + seed + turn));
              float pick = towerHash(cell * 1.7 + seed);
              vec3 lamp = pick < 0.62 ? vec3(1.0, 0.7, 0.4) : pick < 0.9 ? vec3(0.78, 0.9, 1.0) : vec3(0.35, 0.6, 1.0);
              // The glass takes the last of the sky; the west faces take the sun.
              vec3 sheen = mix(vec3(0.03, 0.022, 0.04), vec3(0.075, 0.045, 0.07), clamp(vTowerAt.y / 220.0, 0.0, 1.0));
              sheen += step(0.5, -vTowerNormal.x) * vec3(0.55, 0.2, 0.06);
              vec3 shown = wall + pane * (sheen + on * lamp * (1.1 + 0.9 * towerHash(cell + 9.0)));
              // Too far to tell one window from the next: the face goes to its average.
              float coverage = (hi.x - lo.x) * (hi.y - lo.y);
              vec3 average = wall + coverage * (sheen + share * vec3(0.9, 0.72, 0.55) * 1.5);
              diffuseColor.rgb = mix(shown, average, smoothstep(0.35, 0.9, max(soft.x, soft.y)));
            }
          }`);
    };
    material.customProgramCacheKey = () => "office-towers";
    const mesh = new THREE.InstancedMesh(geometry, material, towers.length);
    const dummy = new THREE.Object3D();
    towers.forEach((tower, i) => {
      const base = tower.base ?? STREET;
      dummy.position.set(tower.x, (tower.top + base) / 2, tower.z);
      dummy.rotation.set(0, tower.turn, 0);
      dummy.scale.set(tower.w, tower.top - base, tower.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.computeBoundingSphere();
    mesh.userData.walkThrough = true;
    scene.add(mesh);

    // Beacons on the tallest roofs.
    const points = new THREE.BufferGeometry();
    points.setAttribute("position", new THREE.Float32BufferAttribute(beaconAt, 3));
    points.setAttribute("beat", new THREE.Float32BufferAttribute(Array.from({ length: beaconAt.length / 3 }, (_, i) => [0.55 + ((i * 37) % 11) * 0.05, ((i * 61) % 17) / 17]).flat(), 2));
    const beacons = new THREE.Points(points, new THREE.ShaderMaterial({
      uniforms: { cityTime },
      vertexShader: /* glsl */`
        attribute vec2 beat;
        uniform float cityTime;
        varying float vOn;
        void main() {
          float turn = fract(cityTime * beat.x + beat.y);
          vOn = smoothstep(0.0, 0.08, turn) * (1.0 - smoothstep(0.3, 0.55, turn));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(2600.0 / -mv.z, 2.0, 9.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vOn;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(3.2, 0.22, 0.12) * vOn * (1.0 - smoothstep(0.1, 0.5, d)), 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    beacons.frustumCulled = false;
    scene.add(beacons);

    // The streets far below.
    const streets = track(streetTexture());
    streets.repeat.set(14, 14);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3360, 3360), new THREE.MeshBasicMaterial({ map: streets, color: new THREE.Color(1.5, 1.5, 1.5) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, STREET, -12);
    ground.userData.walkThrough = true;
    scene.add(ground);

    // Haze on the horizon: hides where the photographed sky meets its own ground, warm toward the sun.
    const ring = new THREE.CylinderGeometry(1500, 1500, 420, 48, 6, true);
    const colours = new Float32Array(ring.attributes.position.count * 4);
    for (let i = 0; i < ring.attributes.position.count; i += 1) {
      const x = ring.attributes.position.getX(i), y = ring.attributes.position.getY(i), z = ring.attributes.position.getZ(i);
      const toward = Math.max(0, (x * TO_SUN.x + z * TO_SUN.z) / (1500 * Math.hypot(TO_SUN.x, TO_SUN.z)));
      const glow = Math.pow(toward, 3);
      const height = (y + 210) / 420;
      colours[i * 4] = 0.2 + 1.5 * glow; colours[i * 4 + 1] = 0.13 + 0.5 * glow; colours[i * 4 + 2] = 0.2 + 0.05 * glow;
      colours[i * 4 + 3] = 1 - THREE.MathUtils.smoothstep(height, 0.52, 1);
    }
    ring.setAttribute("color", new THREE.Float32BufferAttribute(colours, 4));
    const horizon = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.BackSide, depthWrite: false, fog: false }));
    horizon.position.set(0, -60, -12);
    horizon.renderOrder = -2;
    scene.add(horizon);

    // The sun going down in the west.
    const disc = track(softDiscTexture());
    for (const [size, strength] of [[620, 1.1], [170, 5]] as const) {
      const sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: disc, color: new THREE.Color(SUN_COLOUR).multiplyScalar(strength), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      sunDisc.position.copy(TO_SUN).multiplyScalar(1300).add(new THREE.Vector3(0, 0, -12));
      sunDisc.lookAt(0, 0, -12);
      sunDisc.renderOrder = -1;
      scene.add(sunDisc);
    }

    // The air outside is as hazy as the air inside. A screen across the street, drawn only into the sun's
    // shadow map, keeps the light out of the air below the window sills, so the view west is not a wall of glare.
    const screen = new THREE.Mesh(box(1, 60, 260), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    screen.position.set(-52, 9.8 - 30, -12);
    screen.castShadow = true;
    screen.userData.walkThrough = true;
    scene.add(screen);
    kit.probeHidden.push(screen);
  }

  // ---- The ticker wall ------------------------------------------------------------------
  const WALL_FACE = END_Z + 0.08;
  const fills: THREE.PointLight[] = [];
  const glows: Glow[] = [];
  const tape = track(tickerTexture());
  /** An LED tape: the quote line run through a matrix of `cols` x `rows` lamps, moving a whole lamp at a time. */
  const tapeMaterial = (cols: number, rows: number, speed: number, gain: number) => new THREE.ShaderMaterial({
    uniforms: { map: { value: tape }, tapeTime: seconds, grid: { value: new THREE.Vector2(cols, rows) }, perLamp: { value: 64 / rows }, speed: { value: speed }, gain: { value: gain } },
    defines: { FOLDS: TAPE_FOLDS.toFixed(1) },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform float tapeTime;
      uniform vec2 grid;
      uniform float perLamp;
      uniform float speed;
      uniform float gain;
      varying vec2 vUv;
      void main() {
        vec2 at = vUv * grid;
        vec2 cell = floor(at), inCell = fract(at);
        float loop = 2048.0 * FOLDS / perLamp;
        float column = mod(cell.x + floor(mod(tapeTime * speed, loop)), loop);
        float px = (column + 0.5) * perLamp;
        float row = floor(px / 2048.0);
        vec3 lit = texture2D(map, vec2(fract(px / 2048.0), (FOLDS - 1.0 - row + (cell.y + 0.5) / grid.y) / FOLDS)).rgb;
        float spot = 1.0 - smoothstep(0.26, 0.48, length(inCell - 0.5));
        // Too far to see the lamps: they run together.
        float lamp = mix(spot, 0.42, clamp(max(fwidth(at.x), fwidth(at.y)) * 0.8, 0.0, 1.0));
        gl_FragColor = vec4((lit * gain + vec3(0.006, 0.007, 0.008)) * lamp, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  {
    // The tape itself, cased in black steel.
    // Lamps 9 cm apart make letters most of a metre tall, to be read from the far end of the floor; it hangs
    // just clear of what the control centre hides from there.
    const band = new THREE.Mesh(new THREE.PlaneGeometry(EAST_X - GLASS_X - 0.2, 1.4), tapeMaterial(Math.round((EAST_X - GLASS_X - 0.2) / 0.0875), 16, 19, 3.4));
    band.position.set((EAST_X + GLASS_X) / 2, 7.92, WALL_FACE + 0.06);
    scene.add(band);
    slab(blackSteel, GLASS_X, EAST_X, 7.1, 7.22, END_Z, WALL_FACE + 0.1, {}, 1.2);
    slab(blackSteel, GLASS_X, EAST_X, 8.62, 8.74, END_Z, WALL_FACE + 0.1, {}, 1.2);

    // Four clocks: when it opens, when it closes, when it settles, when it all expires.
    const hands = { position: [] as number[], pivot: [] as number[], spin: [] as number[], tone: [] as number[], index: [] as number[] };
    const hand = (pivot: V3, width: number, tail: number, length: number, lift: number, period: number, start: number, tick: boolean, tone: V3) => {
      const base = hands.position.length / 3;
      for (const [hx, hy] of [[-width / 2, -tail], [width / 2, -tail], [width * 0.3, length], [-width * 0.3, length]]) {
        hands.position.push(hx, hy, lift); hands.pivot.push(...pivot); hands.spin.push(period, start, tick ? 1 : 0); hands.tone.push(...tone);
      }
      hands.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    // [hours, minutes, seconds] each clock stood at when the floor emptied.
    const stood: V3[] = [[9, 30, 0], [16, 0, 12], [17, 15, 40], [23, 58, 20]];
    [-4.8, -1.6, 1.6, 4.8].forEach((x, i) => {
      // Each dial with its name beside it.
      at(sign("dial", 0.84), glowMat, x - 0.7, 9.25, WALL_FACE + 0.03);
      at(new THREE.TorusGeometry(0.42, 0.03, 8, 40), aluminium, x - 0.7, 9.25, WALL_FACE + 0.03);
      at(sign(`label${i}`, 1.15), glowMat, x + 0.44, 9.25, WALL_FACE + 0.03);
      const [h, m, s] = stood[i], pivot: V3 = [x - 0.7, 9.25, WALL_FACE + 0.04];
      hand(pivot, 0.042, 0.042, 0.22, 0.01, 43200, ((h % 12) + m / 60) / 12, false, [1.9, 2.1, 2.0]);
      hand(pivot, 0.03, 0.05, 0.335, 0.016, 3600, (m + s / 60) / 60, false, [1.9, 2.1, 2.0]);
      hand(pivot, 0.012, 0.085, 0.36, 0.022, 60, s / 60, true, [3, 0.9, 0.3]);
    });
    const handGeometry = new THREE.BufferGeometry();
    handGeometry.setAttribute("position", new THREE.Float32BufferAttribute(hands.position, 3));
    handGeometry.setAttribute("pivot", new THREE.Float32BufferAttribute(hands.pivot, 3));
    handGeometry.setAttribute("spin", new THREE.Float32BufferAttribute(hands.spin, 3));
    handGeometry.setAttribute("tone", new THREE.Float32BufferAttribute(hands.tone, 3));
    handGeometry.setIndex(hands.index);
    const clockHands = new THREE.Mesh(handGeometry, new THREE.ShaderMaterial({
      uniforms: { clockTime: seconds },
      vertexShader: /* glsl */`
        attribute vec3 pivot;
        attribute vec3 spin;
        attribute vec3 tone;
        uniform float clockTime;
        varying vec3 vTone;
        void main() {
          float turn = clockTime / spin.x + spin.y;
          if (spin.z > 0.5) turn = floor(turn * 60.0) / 60.0;
          float a = -turn * 6.2831853, s = sin(a), c = cos(a);
          vTone = tone;
          gl_Position = projectionMatrix * viewMatrix * vec4(pivot + vec3(position.x * c - position.y * s, position.x * s + position.y * c, position.z), 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vTone;
        void main() {
          gl_FragColor = vec4(vTone, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
    }));
    clockHands.frustumCulled = false;
    scene.add(clockHands);

    // The house name to one side of the clocks, the state of the market to the other.
    at(sign("logo", 2.6), glowMat, -8.05, 9.25, WALL_FACE + 0.03);
    at(sign("closed", 2.6), glowMat, 8.05, 9.25, WALL_FACE + 0.03);
    for (const x of [-8.05, 8.05]) slab(blackSteel, x - 1.36, x + 1.36, 8.76, 9.74, END_Z, WALL_FACE + 0.02, {}, 1.2);

    // The board: tiles that flash when their price changes.
    const board = new THREE.Mesh(new THREE.PlaneGeometry(16, 2.4), new THREE.ShaderMaterial({
      uniforms: { map: { value: track(boardTexture()) }, boardTime: seconds },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        uniform float boardTime;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          vec2 tile = floor(vUv * vec2(16.0, 4.0));
          float beat = boardTime * 0.7 + hash(tile) * 9.0;
          float flash = step(0.84, hash(tile + floor(beat))) * (1.0 - fract(beat)) * (1.0 - fract(beat));
          vec3 shown = texture2D(map, vUv).rgb;
          gl_FragColor = vec4(shown * (1.5 + 2.6 * flash) + vec3(0.02, 0.05, 0.045) * flash, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    board.position.set(0, 11.05, WALL_FACE + 0.05);
    scene.add(board);
    slab(blackSteel, -8.12, 8.12, 9.75, 12.35, END_Z, WALL_FACE + 0.03, {}, 1.2);
    // Ribs dividing the rest of the wall.
    for (let x = -9; x <= 13.6; x += 2.14) if (Math.abs(x) > 9.5) slab(frame, x - 0.03, x + 0.03, 8.74, ATRIUM_CEIL, END_Z, END_Z + 0.05, { fine: true }, 1.2);

    const wash = new THREE.PointLight(0x86ffe0, 70, 36, 2);
    wash.position.set(0, 8.4, -30.5);
    scene.add(wash);
    glows.push({ position: new THREE.Vector3(0, 8.6, -32.6), color: new THREE.Color(0.25, 0.9, 0.72).multiplyScalar(0.55) });
  }

  // ---- Desks ----------------------------------------------------------------------------
  // What a lamp throws on the surface under it: drawn, not lit.
  const pool = new THREE.MeshBasicMaterial({ map: track(softDiscTexture()), color: new THREE.Color(1, 0.84, 0.62).multiplyScalar(0.16), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const merged = (parts: THREE.BufferGeometry[]) => {
    const all = mergeGeometries(parts.map((part) => (part.index ? part.toNonIndexed() : part)))!;
    parts.forEach((part) => part.dispose());
    return all;
  };
  const moved = <T extends THREE.BufferGeometry>(geometry: T, x: number, y: number, z: number, rotation?: V3): T => { geometry.applyMatrix4(mat4(x, y, z, rotation)); return geometry; };
  // A task chair: the hard parts (base, column, arms) and the upholstery. It faces -z, toward its desk.
  const chairHard = merged([
    ...[0, 1, 2, 3, 4].map((i) => moved(box(0.05, 0.03, 0.3), 0, 0.05, 0.15, undefined).applyMatrix4(mat4(0, 0, 0, [0, (i / 5) * Math.PI * 2, 0]))),
    moved(cyl(0.028, 0.36, "y", 8), 0, 0.25, 0),
    moved(box(0.3, 0.03, 0.3), 0, 0.425, 0),
    ...[-0.27, 0.27].flatMap((x) => [moved(box(0.05, 0.03, 0.26), x, 0.67, 0.03), moved(box(0.03, 0.22, 0.04), x, 0.56, 0.08)]),
    moved(box(0.06, 0.34, 0.03), 0, 0.6, 0.27, [-0.14, 0, 0]),
  ]);
  const chairSoft = merged([moved(rbox(0.48, 0.08, 0.46, 0.03), 0, 0.48, 0), moved(rbox(0.44, 0.54, 0.07, 0.03), 0, 0.9, 0.3, [-0.14, 0, 0])]);
  // A jacket left over the back of a chair.
  const jacket = merged([moved(rbox(0.5, 0.42, 0.13, 0.05), 0, 0.98, 0.31, [-0.14, 0, 0]), moved(rbox(0.1, 0.5, 0.09, 0.04), -0.27, 0.8, 0.33, [-0.1, 0, 0.08]), moved(rbox(0.1, 0.46, 0.09, 0.04), 0.27, 0.82, 0.33, [-0.1, 0, -0.08])]);
  const jacketCloth = standard({ color: 0x1c2a44, roughness: 0.9, envMapIntensity: 0.3 });
  const monitorShell = merged([moved(box(0.56, 0.34, 0.026), 0, 0, -0.014), moved(box(0.05, 0.05, 0.1), 0, 0, -0.07)]);
  const PW = 1.34;
  const DESK = { shadow: true, hit: true };

  /** One trader's place. `P` puts its origin on the floor under the bench spine, +z toward where the trader sat. */
  const seat = (P: THREE.Matrix4, random: () => number, detail: boolean, anchor: [number, number] | null, extras: { jacket?: boolean }) => {
    const local = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotation?: V3, opt: Opt = DESK) => put(geometry, material, P.clone().multiply(mat4(x, y, z, rotation)), opt);
    // Screens: two or three on a bar, now and then a fourth above; most asleep.
    const triple = random() > 0.28, stacked = random() < 0.2, awake = random() < 0.34 ? 0.3 + random() * 0.5 : 0;
    const spots: Array<[number, number, number, number, number]> = triple ? [[-0.57, 1.05, 0.2, 0.42, 0], [0, 1.05, 0.12, 0, 0], [0.57, 1.05, 0.2, -0.42, 0]] : [[-0.29, 1.05, 0.13, 0.16, 0], [0.29, 1.05, 0.13, -0.16, 0]];
    if (stacked) spots.push([0, 1.43, 0.11, 0, 0.14]);
    local(box(triple ? 1.3 : 0.7, 0.03, 0.03), frame, 0, 1.05, 0.05);
    local(box(0.045, stacked ? 0.72 : 0.34, 0.045), frame, 0, stacked ? 1.2 : 1.01, 0.04);
    for (const [x, y, z, yaw, tilt] of spots) {
      const M = P.clone().multiply(mat4(x, y, z, [tilt, yaw, 0]));
      put(monitorShell, plastic, M, DESK);
      const on = random() < awake;
      put(on ? sign(`s${Math.floor(random() * 11)}`, 0.53, 0.31) : new THREE.PlaneGeometry(0.53, 0.31), on ? screenOn : screenOff, M.clone().multiply(mat4(0, 0, 0.002)));
      if (!on && detail && high) ledAt(M.clone().multiply(mat4(0.24, -0.163, 0.002)), 0.012, 0.005, LED.amber);
      if (detail && random() < 0.16) put(sign(`sticky${Math.floor(random() * 3)}`, 0.075), signMat, M.clone().multiply(mat4(-0.2 + random() * 0.1, -0.2, 0.004, [0, 0, (random() - 0.5) * 0.3])));
    }
    // Keyboard, mouse, the turret (dealer board) with its handset.
    const shift = anchor ? (anchor[0] > 0 ? -0.2 : 0.2) : 0, keyYaw = (random() - 0.5) * 0.3;
    local(box(0.44, 0.02, 0.15), plastic, shift, 0.751, 0.52, [0, keyYaw, 0]);
    local(sign("keys", 0.43, 0.14), signMat, shift, 0.7625, 0.52, [-Math.PI / 2, 0, keyYaw], {});
    local(rbox(0.06, 0.03, 0.1, 0.012), plastic, shift + 0.34 * (shift < 0 ? -1 : 1), 0.755, 0.5 + random() * 0.08, [0, (random() - 0.5) * 0.6, 0]);
    let phoneSide = 0;
    if (anchor || random() < 0.72) {
      const [px, pz] = anchor ?? [0.5 * (random() < 0.5 ? -1 : 1), 0.36 + random() * 0.08];
      phoneSide = Math.sign(px) || 1;
      local(box(0.2, 0.045, 0.2), plastic, px, 0.766, pz, [0.15, 0, 0]);
      local(sign("turret", 0.19, 0.19), signMat, px, 0.7905, pz, [-Math.PI / 2 + 0.15, 0, 0], {});
      local(rbox(0.05, 0.04, 0.2, 0.014), plastic, px - 0.072, 0.806, pz, [0.15, 0, 0]);
      // The message lamp: blinking where the phones ring out, and on a few others someone never cleared.
      if (anchor) ledAt(P.clone().multiply(mat4(px + 0.07, 0.803, pz - 0.07, [-Math.PI / 2 + 0.15, 0, 0])), 0.03, 0.016, LED.red, 1.15, random(), 0.45);
      else if (random() < 0.18) ledAt(P.clone().multiply(mat4(px + 0.07, 0.803, pz - 0.07, [-Math.PI / 2 + 0.15, 0, 0])), 0.022, 0.012, LED.amber, 0.5, random(), 0.5);
    }
    if (detail) {
      // A paper cup, on the side the turret is not.
      if (random() < 0.4) local(new THREE.CylinderGeometry(0.04, 0.03, 0.1, 10), paper, -(phoneSide || 1) * (0.3 + random() * 0.16), 0.79, 0.25 + random() * 0.1);
      if (random() < 0.55) local(sign(`paper${Math.floor(random() * 3)}`, 0.21), signMat, 0.3 + random() * 0.25, 0.7425, 0.56 + random() * 0.12, [-Math.PI / 2, 0, (random() - 0.5) * 1.2], {});
      if (random() < 0.3) local(sign(`paper${Math.floor(random() * 3)}`, 0.21), signMat, -0.42 + random() * 0.2, 0.7435, 0.5 + random() * 0.15, [-Math.PI / 2, 0, (random() - 0.5) * 1.6], {});
      // Under the desk: a workstation or a drawer pedestal.
      if (random() < 0.6) {
        local(box(0.19, 0.42, 0.44), plastic, -0.5, 0.23, 0.36);
        if (high) ledAt(P.clone().multiply(mat4(-0.5, 0.4, 0.582)), 0.012, 0.012, LED.green, 3 + random() * 6, random() * 9, 0.6, true);
      } else local(box(0.4, 0.56, 0.5), frame, 0.44, 0.28, 0.4);
    }
    // The chair, pushed back wherever it stopped.
    const C = P.clone().multiply(mat4((random() - 0.5) * 0.4, 0, 1.0 + random() * 0.24, [0, (random() - 0.5) * (random() < 0.25 ? 2.6 : 0.8), 0]));
    put(chairHard, plastic, C, DESK);
    put(chairSoft, cloth, C, DESK);
    if (extras.jacket) put(jacket, jacketCloth, C, DESK);
    // Now and then a desk lamp nobody turned off.
    if (detail && random() < 0.14) {
      const side = -(phoneSide || (random() < 0.5 ? -1 : 1));
      local(cyl(0.07, 0.016, "y", 12), plastic, side * 0.6, 0.748, 0.52);
      local(cyl(0.008, 0.3, "y", 6), aluminium, side * 0.6, 0.9, 0.52);
      local(box(0.34, 0.022, 0.06), plastic, side * 0.45, 1.055, 0.52);
      local(new THREE.PlaneGeometry(0.3, 0.036), lampWarm, side * 0.45, 1.043, 0.52, [Math.PI / 2, 0, 0], {});
      local(new THREE.PlaneGeometry(1.1, 0.74), pool, side * 0.36, 0.7415, 0.44, [-Math.PI / 2, 0, 0], {});
    }
  };

  /** A bench of places side by side, on one or both sides of a cable spine. Local x runs along it. */
  const bench = (B: THREE.Matrix4, count: number, o: { north?: boolean; seed: number; detail?: boolean; anchors?: Array<[number, number]>; pole?: boolean; jacket?: number }) => {
    const random = rng(o.seed), length = count * PW, detail = o.detail ?? true;
    const local = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, opt: Opt = DESK) => put(geometry, material, B.clone().multiply(mat4(x, y, z)), opt);
    local(box(length, 0.1, 0.09), frame, 0, 0.79, 0);
    local(box(length - 0.1, 0.28, 0.24), blackSteel, 0, 0.56, 0);
    if (o.pole) local(box(0.07, CEIL - 0.84, 0.07), aluminium, PW / 2, (CEIL + 0.84) / 2, 0, { shadow: true });
    let places = 0;
    for (const side of o.north ? [1, -1] : [1]) {
      local(rbox(length, 0.03, 0.76, 0.008, 2), laminate, 0, 0.725, side * 0.42);
      for (let i = 0; i <= count; i += 1) local(box(0.04, 0.71, 0.62), frame, THREE.MathUtils.clamp(i * PW - length / 2, -length / 2 + 0.02, length / 2 - 0.02), 0.355, side * 0.45);
      for (let i = 0; i < count; i += 1) {
        const P = B.clone().multiply(mat4((i + 0.5) * PW - length / 2, 0, 0, [0, side > 0 ? 0 : Math.PI, 0])), inverse = P.clone().invert();
        let anchor: [number, number] | null = null;
        for (const [ax, az] of o.anchors ?? []) {
          corner.set(ax, 0, az).applyMatrix4(inverse);
          if (Math.abs(corner.x) < PW / 2 && corner.z > 0.1 && corner.z < 0.8) anchor = [corner.x, corner.z];
        }
        seat(P, random, detail, anchor, { jacket: o.jacket === places });
        places += 1;
      }
    }
  };
  // Beside and behind the firing line. The three telephones that ring out stand where the soundscape has them.
  const PHONES: Array<[number, number]> = [[-8.2, 4.5], [8.3, 6], [-8.4, 1.5]];
  [0.9, 4.1, 7.3].forEach((z, i) => bench(mat4(-7.24, 0, z), 3, { north: true, seed: 300 + i, anchors: PHONES, pole: true, jacket: i === 1 ? 4 : -1 }));
  [2.4, 5.6].forEach((z, i) => bench(mat4(7.24, 0, z), 3, { north: true, seed: 340 + i, anchors: PHONES, pole: true, jacket: i === 0 ? 1 : -1 }));
  // On the gallery, looking down on the floor, and on the mezzanine under the tape.
  [6.4, 0.6, -5.2, -11, -16.8, -22.6].forEach((z, i) => bench(mat4(11.35, DECK, z, [0, -Math.PI / 2, 0]), 4, { seed: 380 + i, detail: false }));
  bench(mat4(1.6, DECK, -30.25), 15, { seed: 420, detail: false });

  // ---- Second level: balustrades, the back of the gallery ------------------------------------
  plate(glassIn, "west", FAR_Z, BACK_Z, DECK + 0.05, DECK + 1.08, 9.66, { hit: true });
  slab(aluminium, 9.63, 9.69, DECK + 1.08, DECK + 1.12, FAR_Z, BACK_Z, {}, 1.2);
  slab(frame, 9.62, 9.7, DECK, DECK + 0.05, FAR_Z, BACK_Z, {}, 1.2);
  plate(glassIn, "south", GLASS_X, 9.66, DECK + 0.05, DECK + 1.08, FAR_Z + 0.1, { hit: true });
  slab(aluminium, GLASS_X, 9.69, DECK + 1.08, DECK + 1.12, FAR_Z + 0.07, FAR_Z + 0.13, {}, 1.2);
  slab(frame, GLASS_X, 9.7, DECK, DECK + 0.05, FAR_Z + 0.06, FAR_Z + 0.14, {}, 1.2);
  for (let k = -3; k <= 13; k += 1) slab(aluminium, 9.64, 9.68, DECK, DECK + 1.08, bayZ(k) - 0.012, bayZ(k) + 0.012, { fine: true }, 1.2);
  for (let x = -8.56; x < 9.6; x += 2.14) slab(aluminium, x - 0.012, x + 0.012, DECK, DECK + 1.08, FAR_Z + 0.08, FAR_Z + 0.12, { fine: true }, 1.2);
  // Offices off the gallery: two with the lights left on, the rest dark glass.
  [[-23, 0], [-17.4, 1], [-8.4, 0], [-2.6, 0], [3.2, 1], [8, 0]].forEach(([z, lit]) => {
    slab(frame, EAST_X - 0.05, EAST_X, DECK + 0.45, DECK + 2.1, z - 1.4, z + 1.4, {}, 1.2);
    at(lit ? sign("officeLit", 2.66, 1.52) : new THREE.PlaneGeometry(2.66, 1.52), lit ? glowMat : screenOff, EAST_X - 0.06, DECK + 1.28, z, FACE.west);
  });
  at(sign("exit", 0.62), glowMat, EAST_X - 0.06, DECK + 2.2, -13, FACE.west);
  // The tape that runs along the gallery's edge.
  {
    const length = BACK_Z - FAR_Z - 0.3;
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.5), tapeMaterial(Math.round(length / 0.03125), 16, 30, 2.6));
    strip.position.set(9.59, 4.9, (BACK_Z + FAR_Z) / 2);
    strip.rotation.y = -Math.PI / 2;
    scene.add(strip);
    slab(frame, 9.57, 9.6, 5.15, 5.18, FAR_Z, BACK_Z, {}, 1.2);
    slab(frame, 9.57, 9.6, 4.62, 4.65, FAR_Z, BACK_Z, {}, 1.2);
  }

  // ---- The atrium ----------------------------------------------------------------------------
  // Ring pendants hung low over the far end, and the offices of the floor above looking down from the bulkhead.
  for (const [x, z, r] of [[-4.6, -24.6, 1.5], [1.6, -23.2, 1.9], [7.4, -25.4, 1.4]]) {
    at(new THREE.TorusGeometry(r, 0.045, 6, 48).rotateX(Math.PI / 2), ringGlow, x, 9.9, z);
    for (let i = 0; i < 3; i += 1) at(cyl(0.006, ATRIUM_CEIL - 9.9, "y", 4), frame, x + Math.sin(i * 2.1) * r, (ATRIUM_CEIL + 9.9) / 2, z + Math.cos(i * 2.1) * r);
  }
  [[-6.4, 1], [-1.2, 0], [4, 0], [9.2, 1]].forEach(([x, lit]) => {
    at(lit ? sign("officeLit", 3.6, 1.9) : new THREE.PlaneGeometry(3.6, 1.9), lit ? glowMat : screenOff, x, 10.3, ATRIUM_Z - 0.07, FACE.north);
  });

  // ---- Server room -----------------------------------------------------------------------------
  {
    const Z0 = -9.8, Z1 = 0, FLOOR = 0.12, HEAD = 4.1, random = rng(909);
    // The glass front, its door and the reader beside it.
    slab(frame, WALL_X, 9.62, 0, FLOOR, Z0, Z1, { hit: true }, 1.2);
    slab(blackSteel, WALL_X, 9.62, HEAD, TRANSOM, Z0, Z1, { hit: true }, 1.2);
    plate(glassIn, "west", Z0, Z1, FLOOR, HEAD, 9.58, { hit: true });
    // Two frosted lines across the glass, so that nobody walks into it.
    for (const y of [1.02, 1.5]) plate(frosted, "west", Z0, Z1, y, y + 0.05, 9.577, {});
    for (const z of [Z0 + 0.03, -8.17, -6.53, -4.9, -3.27, -1.63, Z1 - 0.03]) slab(frame, WALL_X, 9.62, FLOOR, HEAD, z - 0.03, z + 0.03, { shadow: true }, 1.2);
    for (const z of [-1.5, -0.5]) slab(aluminium, 9.53, 9.63, FLOOR, 2.33, z - 0.025, z + 0.025, {}, 1.2);
    slab(aluminium, 9.53, 9.63, 2.3, 2.36, -1.525, -0.475, {}, 1.2);
    at(cyl(0.016, 0.9, "y", 8), aluminium, 9.5, 1.25, -0.66);
    for (const y of [0.9, 1.6]) at(cyl(0.01, 0.06, "x", 6), aluminium, 9.53, y, -0.66);
    slab(plastic, 9.5, WALL_X, 1.07, 1.25, -1.84, -1.73, {}, 0);
    at(sign("reader", 0.085, 0.16), signMat, 9.498, 1.16, -1.785, FACE.west);
    led(9.496, 1.222, -1.785, "west", 0.03, 0.01, LED.red, 0.45, 0.2, 0.5);
    at(sign("stuck", 0.44), signMat, 9.56, 1.62, -1.0, FACE.west);
    at(sign("hall", 2.0), glowMat, WALL_X - 0.004, 4.3, -5.4, FACE.west);
    at(sign("cold", 0.5), signMat, 9.56, 1.75, -7.35, FACE.west);
    // Shell: raised floor, walls that take the cold light, a low black ceiling with two strips of it.
    plate(raisedFloor, "up", 9.62, EAST_X, Z0, Z1, FLOOR, {}, 0.6);
    slab(serverWall, 10.04, EAST_X, 0, TRANSOM, Z0 - 0.1, Z0, { shadow: true });
    slab(serverWall, 9.62, EAST_X, 0, TRANSOM, Z1, Z1 + 0.12, { shadow: true });
    plate(serverWall, "west", Z0, Z1, FLOOR, 4.2, EAST_X - 0.01, {}, 2.4);
    plate(charcoal, "down", 9.6, EAST_X, Z0, Z1, 4.2);
    for (const x of [10.25, 12.4]) slab(lampCold, x - 0.04, x + 0.04, 4.16, 4.19, Z0 + 0.5, Z1 - 0.5, {}, 0);
    // Racks: a row facing the glass with a gap in it, and a row along the back wall seen through the gap.
    const rack = (x: number, z: number, busy: number) => {
      slab(blackSteel, x, x + 1, FLOOR, FLOOR + 2.1, z - 0.295, z + 0.295, { shadow: true, hit: true }, 1.2);
      at(sign("rackDoor", 0.56, 2.02), signMat, x - 0.004, FLOOR + 1.05, z, FACE.west);
      for (let unit = 0; unit < 21; unit += 1) {
        if (random() > busy) continue;
        const y = FLOOR + 0.13 + unit * 0.092, count = 1 + Math.floor(random() * 3);
        for (let i = 0; i < count; i += 1) {
          const kind = random();
          if (kind < 0.55) led(x - 0.01, y, z - 0.22 + i * 0.034, "west", 0.017, 0.017, LED.green, 3 + random() * 9, random() * 20, 0.45 + random() * 0.4, true);
          else if (kind < 0.7) led(x - 0.01, y, z - 0.22 + i * 0.034, "west", 0.017, 0.017, LED.green);
          else if (kind < 0.86) led(x - 0.01, y, z - 0.22 + i * 0.034, "west", 0.017, 0.017, LED.amber, 0.6 + random(), random(), 0.5);
          else led(x - 0.01, y, z - 0.22 + i * 0.034, "west", 0.017, 0.017, LED.blue, 2 + random() * 5, random() * 20, 0.7, true);
        }
        if (random() < 0.3) led(x - 0.01, y, z + 0.2, "west", 0.03, 0.012, LED.teal, 1 + random() * 2, random() * 20, 0.8, true);
      }
      led(x - 0.01, FLOOR + 2.06, z, "west", 0.44, 0.014, LED.blue);
    };
    for (const z of [-9.0, -8.4, -7.8, -7.2, -6.6, -5.0, -4.4, -3.8, -3.2]) rack(10.9, z, 0.62);
    if (high) for (let z = -9.0; z < -1; z += 0.6) rack(12.9, z, 0.45); else slab(blackSteel, 12.9, 13.9, FLOOR, FLOOR + 2.1, -9.3, -0.9, {}, 1.2);
    // Cable trays over both rows, with a bridge between them through the gap, and patch leads coming down.
    for (const [x, z0, z1] of [[11.4, -9.6, -2.8], [13.4, -9.6, -0.8]]) {
      for (const side of [-0.17, 0.17]) slab(aluminium, x + side - 0.012, x + side + 0.012, 2.52, 2.58, z0, z1, {}, 1.2);
      for (let z = z0 + 0.15; z < z1; z += 0.3) slab(aluminium, x - 0.17, x + 0.17, 2.52, 2.535, z - 0.012, z + 0.012, { fine: true }, 1.2);
      slab(cableBlue, x - 0.13, x - 0.03, 2.54, 2.6, z0 + 0.1, z1 - 0.1, {}, 0);
      slab(cableYellow, x - 0.02, x + 0.05, 2.54, 2.59, z0 + 0.2, z1 - 0.3, {}, 0);
      slab(cableOrange, x + 0.06, x + 0.13, 2.54, 2.58, z0 + 0.4, z1 - 0.2, {}, 0);
      for (let z = z0 + 0.6; z < z1 - 0.2; z += 0.6) {
        const lead = [cableBlue, cableYellow, cableOrange][Math.floor(random() * 3)];
        slab(lead, x - 0.2 + random() * 0.05, x - 0.18 + random() * 0.05, 2.24, 2.54, z - 0.012, z + 0.012, { fine: true }, 0);
      }
      for (const z of [z0 + 0.4, (z0 + z1) / 2, z1 - 0.4]) for (const side of [-0.17, 0.17]) at(cyl(0.006, 4.2 - 2.58, "y", 4), frame, x + side, (4.2 + 2.58) / 2, z);
    }
    slab(aluminium, 11.2, 13.6, 2.52, 2.58, -5.85, -5.83, {}, 1.2); slab(aluminium, 11.2, 13.6, 2.52, 2.58, -5.57, -5.55, {}, 1.2);
    slab(cableBlue, 11.3, 13.5, 2.54, 2.6, -5.8, -5.7, {}, 0);
    // The air handler by the door, its louvres and its little display; a gas bottle for the fire system.
    slab(aluminium, 11.1, 12.7, FLOOR, FLOOR + 2.0, -0.8, -0.14, { shadow: true, hit: true }, 1.2);
    for (let y = FLOOR + 0.2; y < FLOOR + 1.3; y += 0.09) slab(frame, 11.2, 12.6, y, y + 0.03, -0.83, -0.8, { fine: true }, 1.2);
    slab(plastic, 11.5, 12.3, FLOOR + 1.5, FLOOR + 1.8, -0.82, -0.8, {}, 0);
    led(11.9, FLOOR + 1.65, -0.825, "north", 0.5, 0.12, [0.2, 1.6, 1.3]);
    at(cyl(0.11, 1.3, "y", 12), standard({ color: 0x9c1f18, roughness: 0.4, metalness: 0.3, envMapIntensity: 0.9 }), 13.7, FLOOR + 0.65, -0.45);
    at(cyl(0.035, 0.12, "y", 8), aluminium, 13.7, FLOOR + 1.36, -0.45);

    const cold = new THREE.PointLight(0x7fd2ff, 30, 15, 2);
    cold.position.set(11.9, 3.3, -5);
    scene.add(cold);
    glows.push({ position: new THREE.Vector3(11.2, 2.3, -5), color: new THREE.Color(0.2, 0.55, 1).multiplyScalar(0.5) });
  }

  // ---- Meeting rooms -----------------------------------------------------------------------------
  {
    const Z0 = 0.12, FLOOR = 0.1, HEAD = 4.1;
    slab(frame, WALL_X, 9.62, 0, FLOOR, Z0, BACK_Z, { hit: true }, 1.2);
    slab(blackSteel, WALL_X, 9.62, HEAD, TRANSOM, Z0, BACK_Z, { hit: true }, 1.2);
    // A frosted band at sitting and standing height, clear glass below and above it.
    plate(glassIn, "west", Z0, BACK_Z, FLOOR, 0.5, 9.58, { hit: true });
    plate(frosted, "west", Z0, BACK_Z, 0.5, 2.2, 9.58, { hit: true });
    plate(glassIn, "west", Z0, BACK_Z, 2.2, HEAD, 9.58, { hit: true });
    for (const z of [0.4, 1.5, 2.85, 4.2, 5.55, 6.9, 8.0, 9.4]) slab(frame, WALL_X, 9.62, FLOOR, HEAD, z - 0.03, z + 0.03, { shadow: true }, 1.2);
    for (const z of [0.95, 7.45]) {
      slab(aluminium, 9.53, 9.63, 2.3, 2.36, z - 0.55, z + 0.55, {}, 1.2);
      at(cyl(0.016, 0.9, "y", 8), aluminium, 9.5, 1.25, z + 0.38);
      for (const y of [0.9, 1.6]) at(cyl(0.01, 0.06, "x", 6), aluminium, 9.53, y, z + 0.38);
    }
    at(sign("room1", 0.42), signMat, 9.56, 1.55, 1.9, FACE.west);
    at(sign("room2", 0.42), signMat, 9.56, 1.55, 6.5, FACE.west);
    at(sign("notice", 0.3), signMat, 9.56, 1.5, 3.4, FACE.west);
    // Shell.
    plate(carpetPlain, "up", 9.62, EAST_X, Z0, BACK_Z, 0.004);
    slab(plaster, 9.62, EAST_X, 0, TRANSOM, 4.14, 4.26, { shadow: true });
    plate(plaster, "west", Z0, BACK_Z, 0, 4.2, EAST_X - 0.01, {}, 2.4);
    plate(charcoal, "down", 9.6, EAST_X, Z0, BACK_Z, 4.2);
    // Tables and chairs; a screen nobody switched off in the first room, a whiteboard in the second.
    for (const [zc, long] of [[2.15, 2.2], [6.9, 3.2]]) {
      slab(laminate, 11.2, 12.4, 0.7, 0.74, zc - long / 2, zc + long / 2, { shadow: true }, 0);
      slab(frame, 11.7, 11.9, 0, 0.7, zc - long / 2 + 0.3, zc + long / 2 - 0.3, {}, 1.2);
      for (let i = 0; i < Math.round(long / 0.75); i += 1) for (const side of [-1, 1]) {
        const C = mat4(11.8 + side * (1.05 + ((i * 7) % 3) * 0.06), 0, zc - long / 2 + 0.4 + i * 0.72, [0, side * Math.PI / 2 + Math.sin(i * 9.1 + side) * 0.5, 0]);
        put(chairHard, plastic, C); put(chairSoft, cloth, C);
      }
    }
    slab(plastic, EAST_X - 0.08, EAST_X - 0.02, 1.5, 2.72, 1.1, 3.2, {}, 0);
    at(sign("whiteB", 2.3), signMat, EAST_X - 0.03, 1.95, 6.9, FACE.west);
    slab(aluminium, EAST_X - 0.05, EAST_X - 0.01, 1.18, 2.72, 5.72, 8.08, {}, 1.2);
    // The screensaver: the house name wandering about the screen, changing colour each time it meets an edge.
    const [u0, v0, u1, v1] = atlas.rects.logo;
    const saver = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.12), new THREE.ShaderMaterial({
      uniforms: { map: { value: atlas.texture }, cell: { value: new THREE.Vector4(u0, v0, u1, v1) }, saverTime: seconds },
      vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        uniform vec4 cell;
        uniform float saverTime;
        varying vec2 vUv;
        void main() {
          vec2 size = vec2(0.34, 0.21), run = vec2(saverTime * 0.047, saverTime * 0.071);
          vec2 q = (vUv - abs(fract(run) * 2.0 - 1.0) * (1.0 - size)) / size;
          float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
          float hits = floor(run.x * 2.0) + floor(run.y * 2.0);
          vec3 tone = 0.55 + 0.45 * cos(hits * 2.4 + vec3(0.0, 2.1, 4.2));
          float mark = dot(texture2D(map, mix(cell.xy, cell.zw, clamp(q, 0.0, 1.0))).rgb, vec3(0.4));
          gl_FragColor = vec4(vec3(0.012, 0.016, 0.03) + tone * mark * inside * 1.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    saver.position.set(EAST_X - 0.085, 2.11, 2.15);
    saver.rotation.y = -Math.PI / 2;
    scene.add(saver);
  }

  // ---- Ceiling fittings --------------------------------------------------------------------------
  const flickerLamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 0.74).multiplyScalar(2.1), toneMapped: false });
  const flickerPool = pool.clone();
  const FLICKER: V3 = [-3.6, CEIL, -5.8];
  {
    const rowZ = (j: number) => ATRIUM_Z + 0.3 + 0.6 * (2 + 5 * j);
    const lit = new Set(["3.6|1", "-7.2|6", "7.2|8", "0|2", "-3.6|9"]);
    for (let j = 0; j < 10; j += 1) for (const x of [-7.2, -3.6, 0, 3.6, 7.2]) {
      const z = rowZ(j);
      at(sign("troffer", 1.2, 0.6), signMat, x, CEIL - 0.004, z, FACE.down);
      if (lit.has(`${x}|${j}`)) {
        at(new THREE.PlaneGeometry(1.08, 0.48), lampWarm, x, CEIL - 0.008, z, FACE.down);
        at(new THREE.PlaneGeometry(8, 8), pool, x, 0.02, z, FACE.up);
      }
    }
    for (let j = 0; j < 10; j += 1) for (const x of [-5.1, -1.5, 1.5, 5.1]) if ((j + Math.round(x)) % 2 === 0) at(sign("diffuser", 0.6), signMat, x, CEIL - 0.004, rowZ(j) + 1.2, FACE.down);
    // Sprinkler heads and smoke detectors.
    for (let z = ATRIUM_Z + 1.8; z < BACK_Z; z += 3) for (const x of [-6, -2.4, 1.2, 4.8, 8.4]) at(cyl(0.025, 0.07, "y", 6), aluminium, x, CEIL - 0.035, z, undefined, { fine: true });
    for (const [x, z] of [[-1.8, -13.6], [1.8, -1.6], [-5.4, 4.4], [5.4, 7.4]]) {
      at(cyl(0.07, 0.04, "y", 12), paper, x, CEIL - 0.02, z);
      led(x, CEIL - 0.042, z + 0.04, "down", 0.012, 0.012, LED.red, 0.22, x, 0.05);
    }
    // The failing tube: its own lamp, its own pool on the carpet, a light and a glow in the haze, all on one flicker.
    const tube = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 0.48), flickerLamp);
    tube.rotation.x = Math.PI / 2; tube.position.set(FLICKER[0], CEIL - 0.008, FLICKER[2]);
    const spill = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), flickerPool);
    spill.rotation.x = -Math.PI / 2; spill.position.set(FLICKER[0], 0.022, FLICKER[2]);
    spill.userData.walkThrough = true;
    scene.add(tube, spill);
    kit.probeHidden.push(spill);
    // The projector on its pole, pointed at the chart.
    at(cyl(0.025, 0.62, "y", 8), aluminium, 0, CEIL - 0.31, 3.9);
    at(rbox(0.44, 0.15, 0.36, 0.03), paper, 0, CEIL - 0.7, 3.9, undefined, { shadow: true });
    at(cyl(0.05, 0.06, "z", 12), plastic, 0.1, CEIL - 0.7, 4.1);
    led(0.1, CEIL - 0.7, 4.132, "south", 0.06, 0.06, [1.2, 1.6, 2.6]);
    // A tile is out by the server room and the leads hang down through it; the steps are still under it.
    plate(charcoal, "down", 8.4, 9.0, -3.5, -2.9, CEIL - 0.003);
    for (const [dx, dz, drop, lead] of [[0.1, 0.1, 3.4, cableBlue], [0.3, 0.2, 2.6, cableYellow], [0.22, 0.42, 3.9, cableBlue], [0.45, 0.3, 1.9, cableOrange]] as const) {
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(8.4 + dx, CEIL + 0.1, -3.5 + dz), new THREE.Vector3(8.4 + dx + 0.04, CEIL - drop * 0.5, -3.5 + dz + 0.03), new THREE.Vector3(8.4 + dx - 0.05, CEIL - drop, -3.5 + dz - 0.04), new THREE.Vector3(8.4 + dx + 0.06, CEIL - drop - 0.12, -3.5 + dz + 0.08)]);
      put(new THREE.TubeGeometry(curve, 14, 0.012, 5), lead);
    }
    for (const side of [-0.24, 0.24]) {
      at(box(0.05, 1.95, 0.025), aluminium, 8.7 + side, 0.93, -2.92, [0.26, 0, 0], { shadow: true });
      at(box(0.04, 1.9, 0.025), aluminium, 8.7 + side, 0.9, -3.62, [-0.3, 0, 0], { shadow: true });
    }
    for (let i = 0; i < 5; i += 1) at(box(0.46, 0.025, 0.11), aluminium, 8.7, 0.3 + i * 0.33, -2.75 - i * 0.088, undefined, { shadow: true });
    at(box(0.56, 0.05, 0.3), aluminium, 8.7, 1.86, -3.27, undefined, { shadow: true });
  }

  // ---- Back wall ---------------------------------------------------------------------------------
  {
    // West of the chart: the whiteboard nobody may erase, the deals framed over it, a poster on the pier.
    slab(aluminium, -9.26, -6.54, 0.86, 2.34, BACK_Z - 0.03, BACK_Z, {}, 1.2);
    at(sign("whiteA", 2.6), signMat, -7.9, 1.6, BACK_Z - 0.032, FACE.north);
    slab(aluminium, -9.1, -6.7, 0.84, 0.87, BACK_Z - 0.1, BACK_Z, {}, 1.2);
    for (let i = 0; i < 5; i += 1) {
      slab(blackSteel, -9.24 + i * 0.56, -8.76 + i * 0.56, 2.7, 3.38, BACK_Z - 0.025, BACK_Z, {}, 1.2);
      at(sign(`deal${i}`, 0.42), signMat, -9 + i * 0.56, 3.04, BACK_Z - 0.027, FACE.north);
    }
    at(sign("posterForce", 0.72), signMat, -WALL_X + 0.004, 1.85, 9.12, FACE.east);
    // East of it: the tea point. Worktop, wall cupboards with a light under them, a tall fridge.
    slab(frame, 6.3, 8.68, 0, 0.9, 9.12, BACK_Z, { shadow: true, hit: true }, 1.2);
    slab(laminate, 6.28, 8.7, 0.9, 0.94, 9.08, BACK_Z, { shadow: true }, 0);
    for (let x = 6.3; x < 8.6; x += 0.595) slab(laminate, x + 0.01, x + 0.585, 0.08, 0.86, 9.1, 9.12, {}, 0);
    slab(laminate, 6.3, 8.68, 1.56, 2.3, 9.36, BACK_Z, { shadow: true }, 0);
    slab(lampWarm, 6.4, 8.58, 1.545, 1.56, 9.44, 9.48, {}, 0);
    at(new THREE.PlaneGeometry(2.6, 0.8), pool, 7.49, 0.946, 9.4, FACE.up);
    slab(aluminium, 8.74, 9.42, 0, 1.96, 9.04, BACK_Z, { shadow: true, hit: true }, 1.6);
    at(cyl(0.012, 0.7, "y", 6), frame, 8.82, 1.3, 9.02);
    at(sign("kitchen", 0.3), signMat, 9.12, 1.42, 9.036, FACE.north);
    at(sign("sticky0", 0.076), signMat, 8.98, 1.1, 9.036, [0, Math.PI, 0.1]);
    // Sink and tap, a coffee machine with a lamp nobody turned off, a kettle, cups.
    slab(aluminium, 6.45, 6.95, 0.941, 0.945, 9.2, 9.56, {}, 1.2);
    at(cyl(0.012, 0.26, "y", 6), aluminium, 6.7, 1.07, 9.6); at(cyl(0.012, 0.14, "z", 6), aluminium, 6.7, 1.2, 9.54);
    at(rbox(0.3, 0.4, 0.34, 0.03), plastic, 7.5, 1.14, 9.46, undefined, { shadow: true });
    at(new THREE.CylinderGeometry(0.07, 0.06, 0.14, 12), glassIn, 7.5, 1.03, 9.3);
    led(7.6, 1.26, 9.288, "north", 0.02, 0.012, LED.red, 0.8, 0, 0.5);
    led(7.42, 1.26, 9.288, "north", 0.05, 0.02, LED.teal);
    at(cyl(0.07, 0.2, "y", 12), aluminium, 8.05, 1.04, 9.42);
    for (const [x, tall] of [[8.32, 0.3], [8.42, 0.22]]) at(new THREE.CylinderGeometry(0.04, 0.032, tall, 10), paper, x, 0.94 + tall / 2, 9.36);
    at(sign("kitchenette", 0.5), signMat, 7.49, 2.52, BACK_Z - 0.004, FACE.north);
    at(sign("leader", 0.72), signMat, 6.75, 3.3, BACK_Z - 0.004, FACE.north);
    at(sign("posterSave", 0.68), signMat, 8.3, 3.3, BACK_Z - 0.004, FACE.north);
    // Under the big screen: a long low run of filing units, with what gets left on such things.
    for (const [x0, x1] of [[-6.3, -2.25], [-1.8, 1.8], [2.25, 6.2]]) {
      slab(frame, x0, x1, 0, 0.6, 9.28, BACK_Z, { shadow: true, hit: true }, 1.2);
      slab(laminate, x0 - 0.01, x1 + 0.01, 0.6, 0.63, 9.25, BACK_Z, { shadow: true }, 0);
      const doors = Math.round((x1 - x0) / 0.9), wide = (x1 - x0) / doors;
      for (let i = 0; i < doors; i += 1) {
        slab(laminate, x0 + i * wide + 0.012, x0 + (i + 1) * wide - 0.012, 0.07, 0.585, 9.262, 9.28, {}, 0);
        slab(frame, x0 + (i + 0.5) * wide - 0.06, x0 + (i + 0.5) * wide + 0.06, 0.5, 0.515, 9.25, 9.262, { fine: true }, 0);
      }
    }
    {
      const random = rng(515);
      for (let i = 0; i < 9; i += 1) {
        const x = [-5.8, -4.9, -3.1, -1.2, 0.3, 1.3, 3.0, 4.4, 5.6][i] + (random() - 0.5) * 0.2, kind = i % 3;
        if (kind === 0) for (let n = 0; n < 2 + Math.floor(random() * 3); n += 1) at(box(0.22, 0.022, 0.31), paper, x + (random() - 0.5) * 0.03, 0.642 + n * 0.022, 9.47, [0, (random() - 0.5) * 0.3, 0], { fine: n > 1 });
        else if (kind === 1) at(rbox(0.3, 0.07, 0.25, 0.012), plastic, x, 0.665, 9.48, [0, (random() - 0.5) * 0.5, 0]);
        else for (let n = 0; n < 3; n += 1) at(box(0.07, 0.11 + random() * 0.04, 0.035), glassIn, x + n * 0.13, 0.69, 9.5 + (random() - 0.5) * 0.06, [0, (random() - 0.5) * 0.7, 0]);
      }
    }
    // A waste bin at the aisle end of every bench.
    for (const [x, z] of [[-5.5, 0.35], [-5.48, 1.5], [-5.52, 3.5], [-5.5, 4.72], [-5.47, 6.74], [-5.5, 7.9], [5.5, 1.8], [5.48, 3.02], [5.52, 5.0], [5.5, 6.2]]) {
      at(cyl(0.105, 0.3, "y", 10, false, 0.13), plastic, x, 0.15, z);
    }
    // The way out, hung from the ceiling over the door to the lifts that nobody can see.
    at(box(0.66, 0.26, 0.05), plastic, 8.9, CEIL - 0.42, 8.7);
    at(sign("exit", 0.62), glowMat, 8.9, CEIL - 0.42, 8.672, FACE.north);
    for (const dx of [-0.24, 0.24]) at(cyl(0.006, 0.3, "y", 5), aluminium, 8.9 + dx, CEIL - 0.15, 8.7);
    // Skirting along the solid walls.
    slab(frame, -WALL_X, -WALL_X + 0.015, 0, 0.1, bayZ(0), bayZ(5), {}, 1.2);
    slab(frame, WALL_X - 0.015, WALL_X, 0, 0.1, FAR_Z, -13.5, {}, 1.2);
    slab(frame, -6.5, -6.3, 0, 0.1, BACK_Z - 0.015, BACK_Z, {}, 1.2);
  }

  // ---- Loose ends: downlights over the panelled wall, floor boxes, cartons, dust -------------------
  {
    // A row of small downlights washes the panelling the west signs hang on.
    for (let z = bayZ(0) + 0.535; z < bayZ(5); z += 1.07) {
      at(new THREE.CircleGeometry(0.05, 12), lampWarm, -8.9, CEIL - 0.006, z, FACE.down);
      at(new THREE.RingGeometry(0.05, 0.075, 12), aluminium, -8.9, CEIL - 0.005, z, FACE.down, { fine: true });
    }
    // Floor boxes: power and data under a brass lid, at the end of each bench and down the aisle.
    for (const [x, z] of [[-4.95, 0.9], [-4.95, 4.1], [-4.95, 7.3], [4.95, 2.4], [4.95, 5.6], [-3, -3.1], [3, -3.1], [-3, -12.4], [3, -12.4], [-6.4, -21.4], [0, -21.9], [6.4, -21.4]]) {
      at(sign("floorBox", 0.2), signMat, x, 0.006, z, [-Math.PI / 2, 0, ((x * 7 + z * 3) % 2) * 0.02]);
    }
    // The roof, for whoever flies past: paving, a parapet, the plant that shudders the blinds, a tank, the head of
    // the stairs, and the stack the furnace flue comes up through.
    {
      const ROOF = ATRIUM_CEIL + 0.6, x0 = -10.04, x1 = EAST_X + 0.5, z0 = END_Z - 0.5, z1 = BACK_Z + 0.5;
      const paving = standard({ map: tiles, color: 0x5c6064, roughness: 0.92, envMapIntensity: 0.3 });
      plate(paving, "up", x0, x1, z0, z1, ROOF + 0.01, {}, 0.6);
      for (const [a0, a1, b0, b1] of [[x0, x1, z0, z0 + 0.3], [x0, x1, z1 - 0.3, z1], [x0, x0 + 0.3, z0, z1], [x1 - 0.3, x1, z0, z1]]) slab(darkPlaster, a0, a1, ROOF, ROOF + 1.1, b0, b1, {});
      for (const [x, z] of [[-4.2, -3], [-4.2, 1.6], [0.8, -3], [0.8, 1.6]]) {
        slab(frame, x - 1.7, x + 1.7, ROOF, ROOF + 0.3, z - 1.1, z + 1.1, {}, 1.2);
        slab(aluminium, x - 1.6, x + 1.6, ROOF + 0.3, ROOF + 2.2, z - 1, z + 1, {}, 1.6);
        for (const dx of [-0.8, 0.8]) at(cyl(0.62, 0.14, "y", 18), frame, x + dx, ROOF + 2.27, z);
      }
      slab(aluminium, -7.4, 8.6, ROOF + 0.5, ROOF + 1.1, -6.3, -5.5, {}, 1.6);
      slab(aluminium, 7.8, 8.6, ROOF + 0.5, ROOF + 1.1, -16, -5.5, {}, 1.6);
      slab(aluminium, -7.4, -6.6, ROOF + 0.5, ROOF + 1.1, -5.5, 5.5, {}, 1.6);
      for (const z of [-26, -22.8]) at(cyl(1.35, 2.8, "y", 22), aluminium, -5.5, ROOF + 1.7, z);
      for (const z of [-26, -22.8]) slab(frame, -6.7, -4.3, ROOF, ROOF + 0.3, z - 1.2, z + 1.2, {}, 1.2);
      slab(plaster, 8.6, 12.8, ROOF, ROOF + 2.9, 4.2, 8.2, {});
      slab(frame, 8.5, 12.9, ROOF + 2.9, ROOF + 3.05, 4.1, 8.3, {}, 1.2);
      slab(frame, 8.56, 8.6, ROOF + 0.05, ROOF + 2.15, 5.6, 6.6, {}, 1.2);
      led(8.55, ROOF + 2.45, 6.1, "west", 0.4, 0.12, [2.4, 1.9, 1.2]);
      at(cyl(0.3, 4.2, "y", 16), metals.brushed, 9.28, ROOF + 2.1, -12.65);
      at(cyl(0.44, 0.34, "y", 16), frame, 9.28, ROOF + 4.3, -12.65);
      for (const [x, z] of [[x0 + 0.15, z0 + 0.15], [x1 - 0.15, z0 + 0.15], [x0 + 0.15, z1 - 0.15], [x1 - 0.15, z1 - 0.15]]) {
        at(cyl(0.03, 0.9, "y", 6), frame, x, ROOF + 1.55, z);
        led(x, ROOF + 2.02, z, "up", 0.16, 0.16, LED.red, 0.5, (x + z) * 0.1, 0.5);
      }
    }
    // Plants somebody waters: sword leaves in a tub, along the west glass and by the doors.
    const leaf = standard({ color: 0x2c5a35, roughness: 0.55, envMapIntensity: 0.5, side: THREE.DoubleSide });
    const tub = standard({ color: 0x8d9196, roughness: 0.7, envMapIntensity: 0.5 });
    const plant = (x: number, z: number, seed: number, tall = 1) => {
      const random = rng(seed);
      at(cyl(0.19, 0.5, "y", 14, false, 0.24), tub, x, 0.25, z, undefined, { shadow: true, hit: true });
      at(new THREE.CircleGeometry(0.225, 14), plastic, x, 0.502, z, FACE.up);
      const blades = high ? 13 : 7;
      for (let i = 0; i < blades; i += 1) {
        const turn = (i / blades) * Math.PI * 2 + random(), lean = 0.04 + random() * 0.26, long = (0.7 + random() * 0.85) * tall, wide = 0.085 + random() * 0.06;
        const blade = new THREE.PlaneGeometry(wide, long, 1, 4);
        const points = blade.attributes.position;
        for (let n = 0; n < points.count; n += 1) {
          const t = points.getY(n) / long + 0.5;
          points.setXYZ(n, points.getX(n) * (1 - 0.9 * t * t) * (0.6 + 0.8 * Math.sin(Math.min(1, t * 2.2) * Math.PI / 2)), t * long, lean * long * t * t + 0.02 * Math.sin(t * 5 + i));
        }
        blade.computeVertexNormals();
        put(blade, leaf, mat4(x + Math.sin(turn) * 0.09 * random(), 0.5, z + Math.cos(turn) * 0.09 * random(), [0, turn, 0]), { shadow: true });
      }
    };
    [[-9.05, -7.55, 1], [-9.05, -5.4, 1.15], [-9.03, -1.15, 0.9], [-9.0, -20.3, 1.1], [9.18, 0.02, 1.05]].forEach(([x, z, tall], i) => plant(x, z, 800 + i * 13, tall));
    // Cartons: archive boxes nobody collected under the far windows, kit for the data hall by its door,
    // and the box of somebody who cleared their desk today.
    const props = createProps(kit, { seed: 18 });
    props.place("carton", [
      { position: [-9.12, 0, -21.5], rotation: [0, 1.52, 0] }, { position: [-9.1, 0.32, -21.55], rotation: [0, 1.66, 0] },
      { position: [-9.14, 0, -22.02], rotation: [0, 1.6, 0] }, { position: [-9.1, 0.32, -22.1], rotation: [0, 1.45, 0] }, { position: [-9.08, 0.64, -21.8], rotation: [0, 1.74, 0] },
      { position: [-9.1, 0, -24.3], rotation: [0, 1.5, 0] },
      { position: [9.02, 0, -4.7], rotation: [0, -1.52, 0] }, { position: [9.0, 0.32, -4.74], rotation: [0, -1.4, 0] },
    ]);
    props.place("cartonLarge", [{ position: [-9.02, 0, -23.1], rotation: [0, 1.57, 0] }, { position: [-9.04, 0.42, -23.14], rotation: [0, 1.5, 0] }, { position: [8.98, 0, -5.42], rotation: [0, -1.63, 0] }]);
    props.place("cartonOpen", [{ position: [-4.86, 0, 3.52], rotation: [0, 0.4, 0] }, { position: [8.9, 0, -6.2], rotation: [0, -1.2, 0] }]);
    if (high) {
      props.place("cartonSmall", [{ position: [-9.06, 0.84, -23.1], rotation: [0, 1.2, 0] }, { position: [4.9, 0, 6.3], rotation: [0, -0.5, 0] }]);
      props.place("cartonCrushed", [{ position: [-8.9, 0, -24.9], rotation: [0, 0.9, 0] }]);
      // Dust hanging in the shafts of sun.
      life.drift("motes", { volume: { x: [-9.2, -1.6], y: [0.3, 4.3], z: [-8, 9] }, count: 180, colors: [0xffc48a] });
      life.drift("motes", { volume: { x: [-9.2, 7], y: [0.5, 9.5], z: [-27, -19.6] }, count: 110, colors: [0xffc48a] });
    }
  }

  flush();
  flushLamps();

  // The failing tube, and one that was left on over the far stations.
  const tubeLight = new THREE.PointLight(0xffe2b8, 34, 13, 2);
  tubeLight.position.set(FLICKER[0], CEIL - 0.5, FLICKER[2]);
  const nightLight = new THREE.PointLight(0xffdcb0, 26, 13, 2);
  nightLight.position.set(1.8, CEIL - 0.5, -13.3);
  // The downlights over the panelled wall.
  const wallWash = new THREE.PointLight(0xffd6ac, 30, 16, 2);
  wallWash.position.set(-7.3, 5.7, -14);
  scene.add(tubeLight, nightLight, wallWash);
  fills.push(nightLight, wallWash);
  const tubeGlow: Glow = { position: new THREE.Vector3(FLICKER[0], CEIL - 1.2, FLICKER[2]), color: new THREE.Color(1, 0.85, 0.62).multiplyScalar(0.22) };
  glows.push(tubeGlow);
  life.flicker([tubeLight, flickerLamp, flickerPool, tubeGlow], "tube", { at: [FLICKER[0], CEIL - 0.1, FLICKER[2]] });

  // ---- Furnace, light ------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, CEIL + 0.1 - 3.6);
  // Sky through the glass from above, the sunlit carpet and desks from below.
  scene.add(new THREE.HemisphereLight(0x7c86a8, 0x9a6a44, 2.4));
  const sun = kit.sunLight({ color: SUN_COLOUR, intensity: 4.4, toSun: TO_SUN, extent: 26, distance: 76, near: 12, far: 112, radius: 2 });
  {
    // Aimed at the middle of the building rather than of the range, with a shadow frustum as flat as the
    // light is low: the map's texels are then finest across the slats.
    const aim = new THREE.Vector3(2, 5.5, -12);
    sun.target.position.copy(aim);
    sun.position.copy(aim).addScaledVector(TO_SUN, 76);
    sun.shadow.camera.top = 12.5; sun.shadow.camera.bottom = -12.5;
    sun.shadow.camera.updateProjectionMatrix();
  }

  // Now and then the air handling shudders and every blind on the floor shivers with it.
  const gusts = rng(77), blindAt = new THREE.Vector3(GLASS_X + 0.2, 2.6, bayZ(7.5));
  let nextGust = -1, gustUntil = 0;
  kit.updates.push((now) => {
    const time = now / 1000;
    seconds.value = time;
    wind.update(now);
    if (nextGust < 0) nextGust = time + 12 + gusts() * 14;
    if (time > nextGust) {
      gustUntil = time + 1.6 + gusts() * 1.2;
      nextGust = time + 24 + gusts() * 30;
      options.cue?.("shutterCreak", blindAt, { gain: 0.3, pitch: 1.05 + gusts() * 0.25 });
    }
    blindGust.value += ((time < gustUntil ? 1 : 0) - blindGust.value) * 0.07;
  });

  // Direct sun at a point: back along the ray to the west front, and through whatever is there.
  const sunlitAt = (point: THREE.Vector3) => {
    const t = (GLASS_X - point.x) / TO_SUN.x;
    if (t <= 0) return 0;
    const y = point.y + TO_SUN.y * t, z = point.z + TO_SUN.z * t;
    if (y < SILL || z < END_Z || z > bayZ(13)) return 0;
    const k = Math.floor((z - ATRIUM_Z) / BAY), inBay = (z - ATRIUM_Z) / BAY - k;
    if (inBay < 0.03 || inBay > 0.97 || (y > TRANSOM && y < TRANSOM_TOP) || y > topOf(k)) return 0;
    const lower = y < TRANSOM;
    if (lower && solidBay(k)) return 0;
    const drop = lower ? LOWER_DROP[k] ?? 1 : k >= 0 ? UPPER_DROP[k] ?? 0 : 0;
    const head = lower ? TRANSOM : CEIL, foot = lower ? SILL : TRANSOM_TOP;
    if (y < head - (head - foot) * drop) return 1;
    const stripe = (((head - y) / SLAT.pitch) % 1 + 1) % 1;
    return THREE.MathUtils.clamp((0.25 - Math.abs(stripe - 0.5)) * 10 + 0.5, 0, 1);
  };

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows,
    look: {
      sky: "/environment/rooftop_night-2k.hdr", skyIntensity: 1.5, skyRotation: 0, skyClamp: 6,
      background: 0x2a2438, fog: 0x4a3a4e, fogDensity: 0.0032,
      haze: new THREE.Color(0.016, 0.014, 0.018), hazeDensity: high ? 0.014 : 0.01, hazeCeiling: 9, hazeFade: 1.5,
      environmentIntensity: 1, exposure: 1, far: 2200,
    },
    sunlitAt,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck: life.struck };
}

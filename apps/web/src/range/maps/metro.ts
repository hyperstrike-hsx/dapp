import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { brushedMetal, paintedSteel, pbrMaterial, tile } from "../pbr";
import {
  archedWall, canvasTexture, createKit, hazardTexture, projectUv, softBox, softDiscTexture, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import { createProps, type PropItem } from "../props";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createWind } from "../wind";
import type { Glow } from "../volumetric";

// Underline: T Spawn station, an island platform under one tiled vault.
//
// Everything written on the station is a nod to the game its signwriters grew up on:
// callouts are stops, the departure board reads like a round and the notices are its memes.
// Words and our own drawings only, never the game's name, marks or artwork.
//
// Lighting model: sodium high-bay pendants hang in two rows from the vault and
// carry the room; together they are the warm, near-vertical key that casts the
// shadows. Along both platform edges a trunking of fluorescent tubes runs cold,
// so the train, the track walls and the edge of the floor sit in blue-white
// against the orange middle. A stopped train fills the right-hand track with
// its saloon lights on; the left track is empty and shows the posters beyond.
// Past the platform end the two running tunnels close in and the hall becomes
// a walled concourse with the range's signs, the kiosk and the furnace.

const EDGE = 9.54;
/** Vault: half span, springing height and rise. */
const HALF = 13.3, SPRING = 3.9, RISE = 5.2;
const BACK_Z = 9.7, END_Z = -28.5;
/** Where the platform ends and the running tunnels begin. */
const HEAD_Z = -8;
const PIT = -1.15;
const TRACK_X = 11.24;
const DADO = 4.5;
const TO_LAMP = new THREE.Vector3(0.1, 1, 0.12).normalize();
const SODIUM = new THREE.Color(1, 0.56, 0.17);
const TUBE = new THREE.Color(0.78, 0.92, 1);
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

type V3 = [number, number, number];
type Context = CanvasRenderingContext2D;

const vaultY = (x: number) => SPRING + RISE * Math.sqrt(Math.max(0, 1 - (x / HALF) ** 2));

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function scaleUv<T extends THREE.BufferGeometry>(geometry: T, u: number, v: number): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
  return geometry;
}

/** Glazed wall tiles, 150 mm square in stack bond over 2.4 m: colour, roughness and relief from one layout. */
function glazedTiles(seed: number) {
  const COLS = 16, ROWS = 16, W = 64, H = 64;
  // Colour and relief are read from under a metre on the concourse walls: 2048 px over 2.4 m.
  const paint = (kind: "colour" | "rough" | "relief") => canvasTexture(kind === "rough" ? 1024 : 2048, kind === "rough" ? 1024 : 2048, (context) => {
    const next = rng(seed);
    if (kind !== "rough") context.scale(2, 2);
    context.fillStyle = kind === "colour" ? "#8f8778" : kind === "rough" ? "#e8e8e8" : "#000";
    context.fillRect(0, 0, 1024, 1024);
    for (let row = 0; row < ROWS; row += 1) for (let column = 0; column <= COLS; column += 1) {
      const x = column * W, y = row * H;
      const tone = next(), odd = next();
      if (kind === "colour") {
        let level = 226 + Math.round(tone * 22);
        if (odd > 0.985) level += 12; else if (odd < 0.02) level -= 46;
        context.fillStyle = `rgb(${level},${level - 2},${level - 9})`;
        context.fillRect(x + 1.5, y + 1.5, W - 3, H - 3);
        // Glaze pools thin at the arris and a little darker toward the lower edge.
        const pillow = context.createLinearGradient(0, y + 1.5, 0, y + H - 1.5);
        pillow.addColorStop(0, "rgba(255,255,255,.2)"); pillow.addColorStop(0.12, "rgba(255,255,255,0)"); pillow.addColorStop(0.86, "rgba(60,48,30,0)"); pillow.addColorStop(1, "rgba(60,48,30,.16)");
        context.fillStyle = pillow; context.fillRect(x + 1.5, y + 1.5, W - 3, H - 3);
        if (odd > 0.6 && odd < 0.68) { context.fillStyle = `rgba(90,70,40,${0.04 + tone * 0.05})`; context.beginPath(); context.ellipse(x + 12 + tone * 40, y + 14 + odd * 40, 9 + tone * 12, 5 + tone * 7, tone * 3, 0, Math.PI * 2); context.fill(); }
        if (odd > 0.93 && odd < 0.96) {
          // Crazed glaze.
          context.strokeStyle = "rgba(70,60,48,.3)"; context.lineWidth = 0.7;
          context.beginPath(); context.moveTo(x + 6 + tone * 30, y + 3); context.lineTo(x + 20 + tone * 20, y + 30); context.lineTo(x + 12 + tone * 40, y + 60); context.stroke();
        }
      } else if (kind === "rough") {
        const level = 34 + Math.round(tone * 34) + (odd < 0.02 ? 90 : 0);
        context.fillStyle = `rgb(${level},${level},${level})`;
        context.fillRect(x + 1.5, y + 1.5, W - 3, H - 3);
      } else {
        context.fillStyle = "#8c8c8c"; context.fillRect(x + 1.5, y + 1.5, W - 3, H - 3);
        context.fillStyle = "#e0e0e0"; context.fillRect(x + 3, y + 3, W - 6, H - 6);
        const level = 236 + Math.round(tone * 19);
        context.fillStyle = `rgb(${level},${level},${level})`; context.fillRect(x + 5, y + 5, W - 10, H - 10);
      }
    }
  }, true);
  const map = paint("colour"), roughnessMap = paint("rough"), bumpMap = paint("relief");
  roughnessMap.colorSpace = THREE.NoColorSpace;
  bumpMap.colorSpace = THREE.NoColorSpace;
  return { map, roughnessMap, bumpMap };
}

/** Terrazzo paving, 2.4 m square of 0.6 m slabs with brass-dark joints. */
function terrazzoTexture() {
  return canvasTexture(2048, 2048, (context) => {
    const next = rng(9041);
    context.scale(2, 2);
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const tone = 126 + Math.round(next() * 16) - ((row + column) % 2 ? 9 : 0);
      context.fillStyle = `rgb(${tone + 4},${tone},${tone - 6})`;
      context.fillRect(column * 256, row * 256, 256, 256);
    }
    const chips = ["rgba(52,46,40,", "rgba(214,206,190,", "rgba(150,112,70,", "rgba(96,104,104,", "rgba(190,170,140,"];
    for (let i = 0; i < 52000; i += 1) {
      context.fillStyle = `${chips[Math.floor(next() * chips.length)]}${0.35 + next() * 0.5})`;
      const fine = i > 26000 ? 0.45 : 1;
      context.beginPath(); context.ellipse(next() * 1024, next() * 1024, (0.8 + next() * 2.6) * fine, (0.6 + next() * 1.6) * fine, next() * 3, 0, Math.PI * 2); context.fill();
    }
    for (let i = 0; i < 380; i += 1) {
      const shade = next() > 0.5 ? 255 : 0, size = 20 + next() * 90;
      context.fillStyle = `rgba(${shade},${shade},${shade},${0.012 + next() * 0.03})`;
      context.beginPath(); context.ellipse(next() * 1024, next() * 1024, size, size * 0.6, next() * 3, 0, Math.PI * 2); context.fill();
    }
    for (let i = 0; i < 4; i += 1) {
      context.fillStyle = "rgba(30,25,18,.85)"; context.fillRect(i * 256 - 1.5, 0, 3, 1024); context.fillRect(0, i * 256 - 1.5, 1024, 3);
      context.fillStyle = "rgba(196,160,96,.35)"; context.fillRect(i * 256 - 0.5, 0, 1, 1024); context.fillRect(0, i * 256 - 0.5, 1024, 1);
    }
  }, true);
}

/** Blister paving for the platform edge: 0.4 m of studs, tiling along the edge. */
function tactileTexture(relief: boolean, studs = true) {
  const texture = canvasTexture(128, 128, (context) => {
    context.fillStyle = relief ? "#555" : "#c99a1c";
    context.fillRect(0, 0, 128, 128);
    if (!relief) { context.fillStyle = "rgba(40,28,6,.5)"; context.fillRect(0, 0, 128, 2); context.fillRect(0, 0, 2, 128); }
    if (studs) for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const x = 16 + column * 32, y = 16 + row * 32;
      const gradient = context.createRadialGradient(x - (relief ? 0 : 2), y - (relief ? 0 : 2), 1, x, y, 10);
      gradient.addColorStop(0, relief ? "#fff" : "#f3cb4a"); gradient.addColorStop(0.7, relief ? "#ddd" : "#d7a622"); gradient.addColorStop(1, relief ? "#555" : "#8f6c12");
      context.fillStyle = gradient;
      context.beginPath(); context.arc(x, y, 10, 0, Math.PI * 2); context.fill();
    }
  }, true);
  if (relief) texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

function grain(context: Context, width: number, height: number, seed: number, amount = 1) {
  const next = rng(seed);
  for (let i = 0; i < width * height * 0.012 * amount; i += 1) {
    const shade = next() > 0.5 ? 255 : 0;
    context.fillStyle = `rgba(${shade},${shade},${shade},${0.03 + next() * 0.05})`;
    context.fillRect(next() * width, next() * height, 1 + next() * 3, 1 + next() * 2);
  }
  for (let i = 0; i < 26 * amount; i += 1) {
    context.fillStyle = `rgba(30,22,12,${0.03 + next() * 0.06})`;
    context.beginPath(); context.ellipse(next() * width, next() * height, 10 + next() * 60, 6 + next() * 30, next() * 3, 0, Math.PI * 2); context.fill();
  }
}

/** A hen in flat silhouette, standing on (x, y), `size` tall and facing +x. */
function chicken(context: Context, x: number, y: number, size: number, body: string, trim: string) {
  context.save(); context.translate(x, y); context.scale(size / 47, size / 47);
  context.strokeStyle = trim; context.lineWidth = 2.4; context.lineCap = "round";
  context.beginPath(); context.moveTo(-3, -7); context.lineTo(-4, 0); context.lineTo(0, 0); context.moveTo(4, -7); context.lineTo(5, 0); context.lineTo(9, 0); context.stroke();
  context.fillStyle = body;
  context.beginPath(); context.ellipse(0, -17, 15, 11, -0.15, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.moveTo(-9, -22); context.lineTo(-25, -36); context.lineTo(-15, -14); context.closePath(); context.fill();
  context.beginPath(); context.moveTo(3, -24); context.lineTo(9, -38); context.lineTo(19, -34); context.lineTo(13, -16); context.closePath(); context.fill();
  context.beginPath(); context.arc(14, -37, 6.5, 0, Math.PI * 2); context.fill();
  context.fillStyle = trim;
  context.beginPath(); context.moveTo(20, -39); context.lineTo(28, -36); context.lineTo(20, -34); context.closePath(); context.fill();
  context.beginPath(); context.arc(11, -44, 3, 0, Math.PI * 2); context.arc(15.5, -45, 3, 0, Math.PI * 2); context.fill();
  context.restore();
}

/** Trackside advertising and notices: every one is a nod to the game the network's signwriters grew up on. */
function posterTexture(style: number, scale = 1.5) {
  const W = 512, H = 768;
  return canvasTexture(W * scale, H * scale, (context) => {
    context.scale(scale, scale);
    // `max` shrinks a line that would otherwise run past its frame.
    const text = (value: string, x: number, y: number, size: number, colour: string, weight = 800, align: CanvasTextAlign = "center", spacing = 0, max = 0) => {
      (context as Context & { letterSpacing: string }).letterSpacing = `${spacing}px`;
      context.font = `${weight} ${size}px ${FONT}`;
      const wide = max > 0 ? context.measureText(value).width : 0;
      if (wide > max) context.font = `${weight} ${(size * max) / wide}px ${FONT}`;
      context.fillStyle = colour; context.textAlign = align; context.textBaseline = "middle";
      context.fillText(value, x, y);
    };
    if (style === 0) {
      // FORCE BUY, the energy drink for the round nobody can afford.
      const sky = context.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#2a1650"); sky.addColorStop(0.6, "#b23a6a"); sky.addColorStop(1, "#f2a23a");
      context.fillStyle = sky; context.fillRect(0, 0, W, H);
      const sun = context.createRadialGradient(256, 330, 10, 256, 330, 170);
      sun.addColorStop(0, "#fff6c8"); sun.addColorStop(0.55, "#ffc93f"); sun.addColorStop(1, "#ff8a2a");
      context.fillStyle = sun; context.beginPath(); context.arc(256, 330, 168, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#2a1650";
      for (let i = 0; i < 6; i += 1) context.fillRect(60, 372 + i * 26, 392, 5 + i * 2.5);
      // The can stands against the sun.
      context.fillStyle = "#2a1650"; context.beginPath(); context.roundRect(196, 150, 120, 266, 14); context.fill();
      context.fillStyle = "#4b3190"; context.fillRect(208, 166, 10, 236);
      context.fillStyle = "#fff6dc"; context.fillRect(196, 236, 120, 92);
      text("FB", 256, 285, 66, "#b23a6a", 900, "center");
      context.fillStyle = "#ff8a2a"; context.fillRect(196, 334, 120, 7);
      context.fillStyle = "#6b56a6"; context.beginPath(); context.ellipse(256, 152, 54, 9, 0, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#2a1650"; context.beginPath(); context.ellipse(248, 152, 15, 4, 0, 0, Math.PI * 2); context.fill();
      text("FORCE BUY", 256, 596, 96, "#fff6dc", 900, "center", 2, 446);
      text("CAN'T AFFORD IT  ·  BUY IT ANYWAY", 256, 690, 21, "#fff6dc", 700, "center", 2, 446);
      text("ENERGY DRINK  ·  CONTAINS EVERYTHING YOU HAVE LEFT", 256, 728, 12.5, "#fff6dc", 700, "center", 1.5, 446);
    } else if (style === 1) {
      // FAKE A, GO B: a farce at the Palace. A is hollow, B is where the arrow really goes.
      context.fillStyle = "#efe6d2"; context.fillRect(0, 0, W, H);
      text("PALACE THEATRE", 256, 56, 22, "#1d2a36", 800, "center", 8);
      context.fillStyle = "#b3261e"; context.fillRect(196, 78, 120, 4);
      context.font = `900 300px ${FONT}`; context.textAlign = "center"; context.textBaseline = "middle";
      context.setLineDash([16, 11]); context.lineWidth = 7; context.strokeStyle = "#1d2a36"; context.strokeText("A", 142, 262);
      context.setLineDash([]);
      text("B", 372, 262, 300, "#b3261e", 900, "center");
      context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "#1d2a36";
      context.setLineDash([2, 22]); context.lineWidth = 11;
      context.beginPath(); context.moveTo(256, 500); context.quadraticCurveTo(250, 432, 168, 408); context.stroke();
      context.setLineDash([]); context.lineWidth = 15;
      context.beginPath(); context.moveTo(256, 500); context.quadraticCurveTo(262, 432, 338, 410); context.stroke();
      context.fillStyle = "#1d2a36"; context.beginPath(); context.moveTo(372, 400); context.lineTo(330, 386); context.lineTo(340, 436); context.closePath(); context.fill();
      text("FAKE A,", 256, 566, 80, "#1d2a36", 900, "center", 2, 446);
      text("GO B", 256, 644, 96, "#b3261e", 900, "center", 2, 446);
      text("A FARCE IN TWO SITES  ·  RUNS 1:55", 256, 720, 20, "#1d2a36", 700, "center", 2, 446);
    } else if (style === 2) {
      // LOSS BONUS MUTUAL: the bank that pays more the longer you lose.
      context.fillStyle = "#0f4f52"; context.fillRect(0, 0, W, H);
      context.fillStyle = "#e9f1ea"; context.beginPath(); context.moveTo(0, 520); context.lineTo(W, 300); context.lineTo(W, H); context.lineTo(0, H); context.closePath(); context.fill();
      ["$1400", "$1900", "$2400", "$2900", "$3400"].forEach((sum, i) => {
        const x = 82 + i * 68, tall = 44 + i * 36;
        context.fillStyle = "#e9f1ea"; context.fillRect(x, 292 - tall, 48, tall);
        text(sum, x + 24, 292 - tall - 16, 17, "#e9f1ea", 800, "center");
        text("L", x + 24, 314, 17, "#7fc4bd", 900, "center");
      });
      text("LOSS BONUS", 40, 560, 66, "#0f4f52", 900, "left", 1, 440);
      text("MUTUAL", 40, 628, 66, "#0f4f52", 900, "left", 1);
      text("Lose again. We pay more.", 40, 692, 27, "#0f4f52", 600, "left");
      text("Up to $3400 after five straight losses. Bonus resets the moment you win.", 40, 734, 12.5, "#0f4f52", 600, "left", 0, 440);
    } else if (style === 3) {
      // The works notice: Line B's signals go from 64 ticks a second to 128.
      context.fillStyle = "#f3f1ea"; context.fillRect(0, 0, W, H);
      context.fillStyle = "#d9861f"; context.fillRect(0, 0, W, 150);
      text("64 → 128", 36, 60, 74, "#16130e", 900, "left", 1);
      text("LINE B SIGNAL UPGRADE", 36, 120, 29, "#16130e", 800, "left", 1, 440);
      context.fillStyle = "#16130e"; context.beginPath(); context.arc(446, 60, 36, 0, Math.PI * 2); context.fill();
      text("B", 446, 63, 48, "#d9861f", 900, "center");
      text("T Spawn — B Site", 36, 204, 36, "#16130e", 800, "left");
      text("Twice the ticks. The same trains.", 36, 250, 21, "#3a362e", 600, "left");
      const body = [
        "From Monday the signals on Line B tick 128 times a",
        "second instead of 64. Journey times do not change.",
        "Regular passengers will insist they can feel the",
        "difference. Please let them.",
        "",
        "Line A stays on 64 until further notice. Line M is",
        "trialling sub-tick: your train arrives when you",
        "think it did, not when the board says it did.",
        "",
        "Mind the gap between tick and sub-tick. If you",
        "missed your train, it was not the tick rate.",
      ];
      body.forEach((line, i) => text(line, 36, 300 + i * 25, 17.5, "#3a362e", 500, "left", 0, 440));
      text("128 TICK", 36, 606, 15, "#b3261e", 800, "left", 2); text("64 TICK", 372, 606, 15, "#16130e", 800, "left", 2);
      context.strokeStyle = "#d9861f"; context.lineWidth = 10; context.beginPath(); context.moveTo(60, 650); context.lineTo(452, 650); context.stroke();
      // Twice as many ticks over the upgraded stretch.
      context.fillStyle = "#16130e";
      for (let x = 66; x < 446; x += x < 295 ? 6.5 : 13) context.fillRect(x, 625, 2, 9);
      ["B Site", "Window", "Upper Tunnels", "Lower Tunnels", "T Spawn", "Lobby"].forEach((stop, i) => {
        context.fillStyle = i < 4 ? "#f3f1ea" : "#16130e"; context.strokeStyle = "#16130e"; context.lineWidth = 5;
        context.beginPath(); context.arc(60 + i * 78.4, 650, 13, 0, Math.PI * 2); context.fill(); context.stroke();
        text(stop, 60 + i * 78.4, 680 + (i % 2) * 14, 11.5, "#16130e", 700, "center");
      });
      text("No replacement buses. It is the same train.", 36, 724, 18, "#3a362e", 700, "left");
      text("Notice 64/128 · Underline Passenger Board · gl hf", 36, 749, 11, "#6a655a", 600, "left", 1);
    } else if (style === 4) {
      // POOL DAY: the resort at the end of the S Line, with a hen on the springboard.
      const bands = ["#f6d9a0", "#f3b56a", "#e98452", "#c85a54", "#7a4a6e", "#2f3f6a"];
      bands.forEach((colour, i) => { context.fillStyle = colour; context.fillRect(0, i * 80, W, 82); });
      context.fillStyle = "#16233f"; context.fillRect(0, 480, W, H - 480);
      context.fillStyle = "#fbe9c0"; context.beginPath(); context.arc(350, 236, 66, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#35b3c2"; context.beginPath(); context.moveTo(34, 482); context.lineTo(150, 384); context.lineTo(476, 384); context.lineTo(512, 414); context.lineTo(512, 482); context.closePath(); context.fill();
      context.fillStyle = "#fbe9c0"; context.fillRect(150, 378, 330, 7);
      context.strokeStyle = "#fbe9c0"; context.lineWidth = 3; context.setLineDash([9, 7]);
      for (const [top, foot] of [[232, 150], [314, 268], [396, 386]]) { context.beginPath(); context.moveTo(top, 386); context.lineTo(foot, 480); context.stroke(); }
      context.setLineDash([]);
      context.strokeStyle = "#9be3e6"; context.lineWidth = 4; context.lineCap = "round";
      for (const [x, y, w] of [[196, 408, 34], [352, 428, 46], [250, 452, 40], [432, 456, 30], [120, 462, 28]]) { context.beginPath(); context.moveTo(x, y); context.lineTo(x + w, y); context.stroke(); }
      // Springboard, with a passenger.
      context.fillStyle = "#16233f"; context.fillRect(64, 300, 12, 184); context.fillRect(96, 300, 12, 184);
      for (let y = 330; y < 480; y += 30) context.fillRect(64, y, 44, 6);
      context.fillRect(52, 292, 176, 11);
      chicken(context, 196, 292, 62, "#fbe9c0", "#e98452");
      text("POOL DAY", 256, 566, 84, "#fbe9c0", 900, "center", 4, 446);
      text("RESORT", 256, 640, 60, "#f3b56a", 900, "center", 14);
      text("DAY RETURNS FROM T SPAWN  ·  S LINE", 256, 706, 20, "#fbe9c0", 700, "center", 2, 446);
      text("STRICTLY NO CAMPING", 256, 738, 13, "#f3b56a", 800, "center", 4);
    } else {
      // The network map: every stop is a callout.
      context.fillStyle = "#f1efe8"; context.fillRect(0, 0, W, H);
      context.fillStyle = "#12302e"; context.fillRect(0, 0, W, 118);
      text("UNDERLINE", 30, 50, 46, "#f2efe6", 900, "left", 3);
      text("NETWORK MAP", 30, 92, 21, "#9fd2c8", 800, "left", 6);
      text("Zones 1 – 1.6", 482, 92, 15, "#f2efe6", 700, "right", 1);
      // Fare zones behind the lines.
      context.fillStyle = "rgba(18,48,46,.07)"; context.beginPath(); context.ellipse(262, 356, 150, 172, 0, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(18,48,46,.06)"; context.beginPath(); context.ellipse(262, 356, 78, 92, 0, 0, Math.PI * 2); context.fill();
      context.strokeStyle = "#7fb6c8"; context.lineWidth = 14; context.lineCap = "round"; context.beginPath(); context.moveTo(0, 470); context.bezierCurveTo(140, 430, 250, 520, 512, 452); context.stroke();
      text("R i v e r   A z t e c", 272, 477.5, 9, "#f1efe8", 700, "left", 1);
      type Stop = [number, number, string, CanvasTextAlign?, number?, number?];
      const lines: Array<[string, string, Stop[]]> = [
        ["#d9861f", "B", [[40, 196, "B Site", "left", 0, -15], [112, 196, "Window", "center", 0, 15], [176, 196, "Upper Tunnels", "center", 0, -15], [224, 260, "Lower Tunnels", "right", -14, 0], [262, 330, "", "left"], [332, 386, "Lobby", "left", 14, 2], [392, 430, "Popdog", "left", 14, 4], [440, 512, "Showers", "left", 14, 0], [470, 590, "Silo", "right", -14, 0]]],
        ["#1f8f8a", "A", [[98, 600, "A Site", "left", 14, 0], [98, 520, "Long A", "left", 14, 0], [128, 420, "Short", "right", -14, 0], [190, 368, "Catwalk", "right", -12, -10], [262, 330, "", "left"], [318, 262, "Connector", "left", 14, 0], [362, 196, "Apartments", "center", 0, -15], [470, 196, "Palace", "right", 0, -15]]],
        ["#b3261e", "M", [[40, 560, "Kitchen", "left", 0, 15], [150, 560, "Market", "center", 0, 15], [222, 500, "Tetris", "left", 13, 6], [262, 430, "Jungle", "left", 14, 0], [262, 330, "", "left"], [262, 214, "Mid Doors", "left", 14, 0], [262, 152, "CT Spawn", "left", 14, 0]]],
        ["#4a4a8a", "S", [[156, 640, "Pool Day", "center", 0, 15], [300, 640, "Quad", "center", 0, 15], [392, 560, "Logs", "left", 14, 2], [392, 430, "", "left"], [420, 330, "Ivy", "left", 14, 0], [420, 262, "Boiler", "left", 14, 0]]],
      ];
      context.lineJoin = "round"; context.lineCap = "round";
      for (const [colour, , stops] of lines) {
        context.strokeStyle = colour; context.lineWidth = 9; context.beginPath();
        stops.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y))); context.stroke();
      }
      for (const [colour, letter, stops] of lines) {
        stops.forEach(([x, y, name, align, dx, dy], i) => {
          const change = name === "" || (x === 392 && y === 430), end = i === 0 || i === stops.length - 1;
          context.fillStyle = "#f1efe8"; context.strokeStyle = change ? "#16130e" : colour; context.lineWidth = change ? 3.5 : 3;
          context.beginPath(); context.arc(x, y, change ? 9 : end ? 7 : 5, 0, Math.PI * 2); context.fill(); context.stroke();
          if (name) text(name, x + (dx ?? 0), y + (dy ?? 0), end ? 12.5 : 11, "#16130e", end ? 800 : 600, align ?? "left");
          if (i === 0) bullet(context, x, y + ((dy ?? 0) > 0 ? -22 : 22), 9, colour, letter);
        });
      }
      context.strokeStyle = "#16130e"; context.lineWidth = 3; context.beginPath(); context.arc(262, 330, 15, 0, Math.PI * 2); context.stroke();
      context.fillStyle = "#16130e"; context.beginPath(); context.roundRect(282, 318, 128, 24, 4); context.fill();
      text("You are here · T Spawn", 346, 331, 10, "#f1efe8", 800, "center");
      // Key.
      context.fillStyle = "#e4e0d4"; context.fillRect(0, 676, W, 92);
      ([["#d9861f", "B", "Silo – B Site"], ["#1f8f8a", "A", "A Site – Palace"], ["#b3261e", "M", "Kitchen – CT Spawn"], ["#4a4a8a", "S", "Pool Day – Boiler"]] as Array<[string, string, string]>).forEach(([colour, letter, ends], i) => {
        const x = 30 + (i % 2) * 236, y = 698 + Math.floor(i / 2) * 26;
        bullet(context, x + 9, y, 9, colour, letter); text(ends, x + 26, y, 12.5, "#16130e", 700, "left");
      });
      text("Interchange  ◯     Map 1.6  ·  not to scale  ·  callouts may vary by team  ·  Underline Passenger Board", 30, 753, 9.5, "#5a564c", 600, "left", 0, 452);
    }
    grain(context, W, H, 300 + style * 17);
    context.strokeStyle = "rgba(20,16,10,.5)"; context.lineWidth = 6; context.strokeRect(3, 3, W - 6, H - 6);
  });
}

/** Enamel or back-lit sign: a dark field, a line bullet and white lettering. */
function signTexture(width: number, height: number, draw: (context: Context, text: (value: string, x: number, y: number, size: number, colour?: string, align?: CanvasTextAlign, weight?: number, max?: number) => void) => void, ground = "#101a1c", wear = 1, scale = 1) {
  return canvasTexture(width * scale, height * scale, (context) => {
    context.scale(scale, scale);
    context.fillStyle = ground; context.fillRect(0, 0, width, height);
    // `max` shrinks a line that would otherwise run past its frame.
    const text = (value: string, x: number, y: number, size: number, colour = "#f2efe6", align: CanvasTextAlign = "left", weight = 700, max = 0) => {
      context.font = `${weight} ${size}px ${FONT}`;
      const wide = max > 0 ? context.measureText(value).width : 0;
      if (wide > max) context.font = `${weight} ${(size * max) / wide}px ${FONT}`;
      context.fillStyle = colour; context.textAlign = align; context.textBaseline = "middle";
      context.fillText(value, x, y);
    };
    draw(context, text);
    if (wear > 0) grain(context, width, height, width + height, wear * 0.5);
  });
}

const bullet = (context: Context, x: number, y: number, radius: number, colour: string, label: string) => {
  context.fillStyle = colour; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  context.font = `900 ${radius * 1.3}px ${FONT}`; context.fillStyle = "#14110c"; context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText(label, x, y + radius * 0.06);
};

/** Dot-matrix departure board. */
function ledTexture(rows: string[][], scale = 1) {
  return canvasTexture(1024 * scale, 256 * scale, (context) => {
    context.scale(scale, scale);
    context.fillStyle = "#070605"; context.fillRect(0, 0, 1024, 256);
    context.font = `700 54px "Courier New", Menlo, monospace`; context.textBaseline = "middle";
    rows.forEach(([left, right], i) => {
      context.fillStyle = i === 0 ? "#ffb23a" : "#ff9a24";
      context.textAlign = "left"; context.fillText(left, 34, 50 + i * 78);
      context.textAlign = "right"; context.fillText(right, 990, 50 + i * 78);
    });
    // Break the glyphs into dots.
    context.fillStyle = "#070605";
    for (let x = 0; x < 1024; x += 6) context.fillRect(x, 0, 2, 256);
    for (let y = 0; y < 256; y += 6) context.fillRect(0, y, 1024, 2);
  });
}

function clockTexture() {
  return canvasTexture(512, 512, (context) => {
    context.scale(2, 2);
    context.fillStyle = "#f1ead6"; context.beginPath(); context.arc(128, 128, 126, 0, Math.PI * 2); context.fill();
    context.font = `800 13px ${FONT}`; context.fillStyle = "#3a362e"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText("ROUND TIME", 128, 176);
    context.fillStyle = "#16130e";
    for (let i = 0; i < 60; i += 1) {
      context.save(); context.translate(128, 128); context.rotate((i / 60) * Math.PI * 2);
      if (i % 5 === 0) context.fillRect(-4.5, -118, 9, 28); else context.fillRect(-1.2, -118, 2.4, 10);
      context.restore();
    }
  });
}

/** Soft round stain or pool, alpha only. */
function blotTexture(seed: number) {
  return canvasTexture(256, 256, (context) => {
    const next = rng(seed);
    context.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 26; i += 1) {
      const x = 128 + (next() - 0.5) * 120, y = 128 + (next() - 0.5) * 150, r = 22 + next() * 44;
      const blot = context.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, "rgba(255,255,255,.55)"); blot.addColorStop(0.7, "rgba(255,255,255,.4)"); blot.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = blot; context.fillRect(0, 0, 256, 256);
    }
  });
}

/** Light thrown on a wall by a batten above it. */
function washTexture() {
  return canvasTexture(128, 128, (context) => {
    context.clearRect(0, 0, 128, 128);
    const wash = context.createRadialGradient(64, 0, 0, 64, 0, 128);
    wash.addColorStop(0, "rgba(255,255,255,.9)"); wash.addColorStop(0.3, "rgba(255,255,255,.4)"); wash.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = wash;
    context.save(); context.translate(64, 0); context.scale(1, 1); context.translate(-64, 0); context.fillRect(0, 0, 128, 128); context.restore();
  });
}

/** Advert cards for the saloon cove: five campaigns and three notices side by side. */
function advertTexture() {
  return canvasTexture(2048, 256, (context) => {
    const text = (value: string, x: number, y: number, size: number, colour: string, weight = 800, align: CanvasTextAlign = "left", max = 212) => {
      context.font = `${weight} ${size}px ${FONT}`;
      const wide = context.measureText(value).width;
      if (wide > max) context.font = `${weight} ${(size * max) / wide}px ${FONT}`;
      context.fillStyle = colour; context.textAlign = align; context.textBaseline = "middle";
      context.fillText(value, x, y);
    };
    context.fillStyle = "#cfc9ba"; context.fillRect(0, 0, 2048, 256);
    const cards: Array<(x: number) => void> = [
      (x) => { const g = context.createLinearGradient(x, 0, x + 244, 256); g.addColorStop(0, "#2a1650"); g.addColorStop(1, "#f2a23a"); context.fillStyle = g; context.fillRect(x, 8, 244, 240); context.fillStyle = "#ffc93f"; context.beginPath(); context.arc(x + 186, 76, 44, 0, Math.PI * 2); context.fill(); text("FORCE", x + 16, 116, 58, "#fff6dc", 900); text("BUY", x + 16, 170, 58, "#fff6dc", 900); text("Can't afford it. Buy it anyway.", x + 18, 218, 22, "#fff6dc", 600); },
      (x) => { context.fillStyle = "#0f4f52"; context.fillRect(x, 8, 244, 240); text("LOSS BONUS", x + 16, 70, 34, "#e9f1ea", 900); text("MUTUAL", x + 16, 108, 34, "#e9f1ea", 900); context.fillStyle = "#e9f1ea"; context.fillRect(x + 16, 136, 212, 3); text("Lose again.", x + 16, 172, 26, "#9fd2c8", 600); text("We pay more.", x + 16, 206, 26, "#9fd2c8", 600); },
      (x) => { context.fillStyle = "#f3f1ea"; context.fillRect(x, 8, 244, 240); context.fillStyle = "#d9861f"; context.fillRect(x, 8, 244, 62); text("64 → 128", x + 14, 40, 36, "#16130e", 900); text("Signal upgrade", x + 14, 100, 25, "#16130e", 800); text("Line B  ·  T Spawn — B Site", x + 14, 136, 18, "#3a362e", 600); text("If you missed your train,", x + 14, 176, 17, "#3a362e", 600); text("it was not the tick rate.", x + 14, 200, 17, "#3a362e", 600); },
      (x) => { context.fillStyle = "#16233f"; context.fillRect(x, 8, 244, 240); context.fillStyle = "#e98452"; context.fillRect(x, 8, 244, 90); context.fillStyle = "#fbe9c0"; context.beginPath(); context.arc(x + 60, 60, 30, 0, Math.PI * 2); context.fill(); context.fillStyle = "#35b3c2"; context.fillRect(x, 84, 244, 14); chicken(context, x + 176, 84, 44, "#fbe9c0", "#16233f"); text("POOL DAY", x + 122, 140, 38, "#fbe9c0", 900, "center"); text("RESORT", x + 122, 182, 30, "#f3b56a", 900, "center"); text("S Line  ·  strictly no camping", x + 122, 220, 18, "#fbe9c0", 600, "center"); },
      (x) => { context.fillStyle = "#f0b83a"; context.fillRect(x, 8, 244, 240); text("ECO", x + 16, 72, 50, "#14110c", 900); text("ROUND", x + 16, 122, 50, "#14110c", 900); text("nothing over $2000", x + 16, 176, 24, "#3a2a0c", 700); text("on the concourse", x + 16, 208, 20, "#3a2a0c", 600); },
      (x) => { context.fillStyle = "#efe6d2"; context.fillRect(x, 8, 244, 240); context.font = `900 112px ${FONT}`; context.textAlign = "center"; context.textBaseline = "middle"; context.setLineDash([8, 6]); context.lineWidth = 4; context.strokeStyle = "#1d2a36"; context.strokeText("A", x + 70, 78); context.setLineDash([]); context.fillStyle = "#b3261e"; context.fillText("B", x + 170, 78); text("FAKE A,", x + 16, 158, 34, "#1d2a36", 900); text("GO B", x + 16, 196, 38, "#b3261e", 900); text("Palace Theatre  ·  runs 1:55", x + 16, 230, 17, "#1d2a36", 600); },
      (x) => { context.fillStyle = "#24402c"; context.fillRect(x, 8, 244, 240); context.strokeStyle = "#e8dfc4"; context.lineWidth = 6; context.strokeRect(x + 80, 30, 40, 100); context.strokeRect(x + 124, 30, 40, 100); context.fillStyle = "#e0902a"; context.fillRect(x + 108, 74, 8, 16); context.fillRect(x + 128, 74, 8, 16); text("DOOR STUCK?", x + 122, 166, 28, "#e8dfc4", 900, "center"); text("Pull the handle. Do not shout.", x + 122, 206, 20, "#b9c9a8", 600, "center"); },
      (x) => { context.fillStyle = "#12302e"; context.fillRect(x, 8, 244, 240); context.strokeStyle = "#e0902a"; context.lineWidth = 4; context.beginPath(); context.roundRect(x + 16, 30, 112, 52, 8); context.stroke(); text("shift", x + 72, 57, 28, "#e0902a", 800, "center"); text("Quiet carriage", x + 16, 128, 33, "#f2efe6", 800); text("sneaky-beaky like", x + 16, 170, 26, "#f2efe6", 600); text("UNDERLINE", x + 16, 222, 20, "#b9c4c0", 800); },
    ];
    cards.forEach((draw, i) => { draw(i * 256 + 6); context.strokeStyle = "rgba(60,60,60,.7)"; context.lineWidth = 3; context.strokeRect(i * 256 + 6, 8, 244, 240); });
    grain(context, 2048, 256, 911, 0.4);
  }, true);
}

/** Strip map of Line B for the door headers. */
function lineDiagramTexture() {
  return canvasTexture(2048, 256, (context) => {
    context.fillStyle = "#f1efe8"; context.fillRect(0, 0, 2048, 256);
    context.fillStyle = "#12302e"; context.fillRect(0, 0, 2048, 54);
    context.font = `800 30px ${FONT}`; context.fillStyle = "#f2efe6"; context.textBaseline = "middle"; context.textAlign = "left";
    context.fillText("LINE B   ·   Silo  —  B Site", 40, 28);
    context.textAlign = "right"; context.fillText("UNDERLINE", 2008, 28);
    const stops = ["Silo", "Showers", "Popdog", "Lobby", "T Spawn", "Lower Tunnels", "Upper Tunnels", "Window", "B Site"];
    context.strokeStyle = "#e0902a"; context.lineWidth = 16; context.lineCap = "round";
    context.beginPath(); context.moveTo(120, 132); context.lineTo(1928, 132); context.stroke();
    stops.forEach((stop, i) => {
      const x = 120 + i * 226, here = i === 4, change = i === 4 || i === 2;
      context.fillStyle = "#f1efe8"; context.strokeStyle = "#16130e"; context.lineWidth = here ? 9 : 6;
      context.beginPath(); context.arc(x, 132, change ? 19 : 13, 0, Math.PI * 2); context.fill(); context.stroke();
      context.font = `${here ? 900 : 700} ${here ? 32 : 27}px ${FONT}`; context.fillStyle = "#16130e"; context.textAlign = "center";
      context.fillText(stop, x, 192);
      if (change) {
        context.fillStyle = here ? "#2aa39c" : "#4a4a8a"; context.beginPath(); context.arc(x - 34, 232, 13, 0, Math.PI * 2); context.fill();
        context.font = `700 19px ${FONT}`; context.fillStyle = "#3a362e"; context.textAlign = "left"; context.fillText(here ? "Lines A, M" : "Line S", x - 14, 233);
      }
    });
  });
}

/** The driver's desk: two dials, a strip of annunciators and rows of buttons. */
function consoleTexture() {
  return canvasTexture(1024, 384, (context) => {
    const next = rng(8812);
    context.fillStyle = "#15191b"; context.fillRect(0, 0, 1024, 384);
    context.strokeStyle = "#2e3538"; context.lineWidth = 3;
    for (const x of [300, 724]) { context.beginPath(); context.moveTo(x, 10); context.lineTo(x, 374); context.stroke(); }
    for (const [x, label, sweep] of [[400, "u/s", 0.3], [624, "hp", 0.62]] as Array<[number, string, number]>) {
      context.fillStyle = "#050607"; context.beginPath(); context.arc(x, 150, 96, 0, Math.PI * 2); context.fill();
      context.strokeStyle = "#8a9296"; context.lineWidth = 5; context.beginPath(); context.arc(x, 150, 96, 0, Math.PI * 2); context.stroke();
      context.fillStyle = "#e9efe9";
      for (let i = 0; i <= 24; i += 1) { context.save(); context.translate(x, 150); context.rotate(Math.PI * 0.75 + (i / 24) * Math.PI * 1.5); context.fillRect(70, -1.5, i % 4 === 0 ? 20 : 10, 3); context.restore(); }
      context.save(); context.translate(x, 150); context.rotate(Math.PI * 0.75 + sweep * Math.PI * 1.5); context.fillStyle = "#ff8a2a"; context.fillRect(-10, -3, 84, 6); context.restore();
      context.fillStyle = "#c9d2d2"; context.beginPath(); context.arc(x, 150, 9, 0, Math.PI * 2); context.fill();
      context.font = `700 20px ${FONT}`; context.textAlign = "center"; context.fillStyle = "#9aa6a8"; context.fillText(label, x, 204);
    }
    const lamps = ["#ffb23a", "#3ad17a", "#ff4a3a", "#3aa0ff", "#f2efe6", "#3ad17a", "#ffb23a", "#ff4a3a"];
    lamps.forEach((colour, i) => { context.fillStyle = i % 3 === 1 ? colour : "#22282a"; context.beginPath(); context.roundRect(322 + i * 48, 286, 38, 26, 4); context.fill(); context.strokeStyle = "#596366"; context.lineWidth = 2; context.stroke(); });
    for (const x0 of [30, 754]) for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const x = x0 + 14 + column * 60, y = 40 + row * 78, pick = next();
      context.fillStyle = "#0a0c0d"; context.beginPath(); context.arc(x + 20, y + 20, 24, 0, Math.PI * 2); context.fill();
      context.fillStyle = pick > 0.8 ? "#d8362a" : pick > 0.6 ? "#e0a41a" : pick > 0.45 ? "#2aa36a" : "#4a5254"; context.beginPath(); context.arc(x + 20, y + 20, 16, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(255,255,255,.25)"; context.beginPath(); context.arc(x + 15, y + 14, 6, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#8a9498"; context.fillRect(x + 4, y + 50, 32, 4);
    }
    context.fillStyle = "#061416"; context.fillRect(322, 326, 380, 44);
    context.font = `700 26px "Courier New", Menlo, monospace`; context.textAlign = "left"; context.fillStyle = "#58e0c4"; context.fillText("SIG MR12 HOLD · AWP MID", 334, 349);
  });
}

/** Window glass: a green tint that is clearest in the middle, with wiped grime and a sill of dust. */
function glassTexture() {
  return canvasTexture(512, 256, (context) => {
    const next = rng(2207);
    context.clearRect(0, 0, 512, 256);
    context.fillStyle = "rgba(118,150,140,.2)"; context.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 60; i += 1) {
      const x = next() * 512, y = next() * 256, r = 30 + next() * 90;
      const smear = context.createRadialGradient(x, y, 0, x, y, r);
      smear.addColorStop(0, `rgba(190,196,180,${0.02 + next() * 0.05})`); smear.addColorStop(1, "rgba(190,196,180,0)");
      context.fillStyle = smear; context.fillRect(0, 0, 512, 256);
    }
    const sill = context.createLinearGradient(0, 150, 0, 256);
    sill.addColorStop(0, "rgba(120,104,80,0)"); sill.addColorStop(1, "rgba(120,104,80,.42)");
    context.fillStyle = sill; context.fillRect(0, 0, 512, 256);
    const top = context.createLinearGradient(0, 0, 0, 40);
    top.addColorStop(0, "rgba(90,84,70,.3)"); top.addColorStop(1, "rgba(90,84,70,0)");
    context.fillStyle = top; context.fillRect(0, 0, 512, 40);
    context.save(); context.transform(1, 0, -0.6, 1, 0, 0);
    for (const [x, w] of [[180, 46], [246, 12], [520, 70]]) { context.fillStyle = "rgba(235,245,255,.07)"; context.fillRect(x, 0, w, 256); }
    context.restore();
  });
}

/** A run of dirty water down a wall, alpha only. */
function streakTexture() {
  return canvasTexture(128, 512, (context) => {
    const next = rng(407);
    context.fillStyle = "#000"; context.fillRect(0, 0, 128, 512);
    for (let i = 0; i < 22; i += 1) {
      const x = 20 + next() * 88, w = 3 + next() * 16, length = 140 + next() * 360;
      const run = context.createLinearGradient(0, 0, 0, length);
      run.addColorStop(0, `rgba(255,255,255,${0.25 + next() * 0.4})`); run.addColorStop(0.5, "rgba(255,255,255,.16)"); run.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = run; context.beginPath(); context.ellipse(x, 0, w, length, 0, 0, Math.PI * 2); context.fill();
    }
  });
}

/** Light falling across a floor from a line of tubes along one long edge. */
function spillTexture() {
  return canvasTexture(128, 8, (context) => {
    const spill = context.createLinearGradient(0, 0, 128, 0);
    spill.addColorStop(0, "#000"); spill.addColorStop(0.45, "#3a3a3a"); spill.addColorStop(0.82, "#fff"); spill.addColorStop(1, "#9a9a9a");
    context.fillStyle = spill; context.fillRect(0, 0, 128, 8);
  });
}

function magazineTexture() {
  return canvasTexture(128, 192, (context) => {
    context.fillStyle = "#fff"; context.fillRect(0, 0, 128, 192);
    context.fillStyle = "#1c1c1c"; context.fillRect(0, 0, 128, 40);
    context.font = `900 26px ${FONT}`; context.fillStyle = "#fff"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText("PEEK", 64, 22);
    context.fillStyle = "rgba(0,0,0,.35)"; context.beginPath(); context.arc(64, 104, 36, 0, Math.PI * 2); context.fill(); context.fillRect(30, 130, 68, 40);
    context.fillStyle = "#1c1c1c"; context.fillRect(10, 176, 70, 5);
  });
}

function roundRect(path: THREE.Path, x0: number, y0: number, x1: number, y1: number, radius: number) {
  const r = Math.max(0.004, radius);
  path.moveTo(x0 + r, y0); path.lineTo(x1 - r, y0); path.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x1, y1 - r); path.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  path.lineTo(x0 + r, y1); path.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x0, y0 + r); path.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
}

/** A rectangular frame in the XY plane, extruded from z = 0 to `depth`. */
function frameGeometry(width: number, height: number, border: number, depth: number, radius = 0.01, bevel = 0) {
  const shape = new THREE.Shape();
  roundRect(shape, -width / 2, -height / 2, width / 2, height / 2, radius + border * 0.4);
  const hole = new THREE.Path();
  roundRect(hole, -width / 2 + border, -height / 2 + border, width / 2 - border, height / 2 - border, radius);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 4 });
}

/** A door leaf standing on y = 0 in the XY plane with one glazed opening. */
function leafGeometry(width: number, height: number, depth: number, glazing: [number, number, number, number] | null) {
  const shape = new THREE.Shape();
  roundRect(shape, -width / 2, 0, width / 2, height, 0.012);
  if (glazing) { const hole = new THREE.Path(); roundRect(hole, glazing[0], glazing[1], glazing[2], glazing[3], 0.06); shape.holes.push(hole); }
  return projectUv(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 }), 1.2);
}

/** One moulded seat shell, facing +z with its back at z = 0, standing on y = 0. */
function seatShellGeometry(width: number) {
  const spine = new THREE.SplineCurve([[0.03, 1.1], [0.05, 0.85], [0.085, 0.55], [0.11, 0.47], [0.17, 0.435], [0.42, 0.445], [0.47, 0.415]].map(([z, y]) => new THREE.Vector2(z, y)));
  const front: THREE.Vector2[] = [], back: THREE.Vector2[] = [];
  for (let i = 0; i <= 18; i += 1) {
    const point = spine.getPoint(i / 18), tangent = spine.getTangent(i / 18);
    front.push(new THREE.Vector2(point.x - tangent.y * 0.014, point.y + tangent.x * 0.014));
    back.push(new THREE.Vector2(point.x + tangent.y * 0.014, point.y - tangent.x * 0.014));
  }
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape([...front, ...back.reverse()]), { depth: width - 0.016, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1, curveSegments: 1 });
  geometry.translate(0, 0, -(width - 0.016) / 2);
  geometry.rotateY(-Math.PI / 2);
  return projectUv(geometry, 1);
}

function coilGeometry(radius: number, height: number, turns: number, wire: number) {
  const points = Array.from({ length: turns * 8 + 1 }, (_, i) => new THREE.Vector3(Math.cos(i / 8 * Math.PI * 2) * radius, (i / (turns * 8)) * height, Math.sin(i / 8 * Math.PI * 2) * radius));
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), turns * 10, wire, 5);
}

function uvRange<T extends THREE.BufferGeometry>(geometry: T, u0: number, u1: number): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
  return geometry;
}

/** A copy holding only position, normal and uv, un-indexed, so unlike primitives can be merged. */
function mergeable(geometry: THREE.BufferGeometry) {
  const copy = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of Object.keys(copy.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") copy.deleteAttribute(name);
  return copy;
}

/**
 * Age that does not tile: soot, run-off and a dirty skirting, laid over a surface in world
 * space. `base` is the floor the dirt gathers at, `sootFrom`/`sootTo` where smoke has settled.
 */
function weather<T extends THREE.MeshStandardMaterial>(material: T, amount: number, base = 0, sootFrom = 99, sootTo = 100): T {
  const f = (value: number) => value.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMetroWorld;")
      .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
        {
          vec4 metroWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            metroWorld = instanceMatrix * metroWorld;
          #endif
          vMetroWorld = (modelMatrix * metroWorld).xyz;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */`#include <common>
        varying vec3 vMetroWorld;
        float metroHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float metroNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(metroHash(i), metroHash(i + vec2(1.0, 0.0)), f.x), mix(metroHash(i + vec2(0.0, 1.0)), metroHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float metroFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += metroNoise(p) * a; p = p * 2.03 + 17.3; a *= 0.5; } return s / 0.9375; }
        float metroDirt = 0.0;`)
      .replace("#include <map_fragment>", /* glsl */`#include <map_fragment>
        {
          vec2 q = vec2(vMetroWorld.x * 0.8 + vMetroWorld.z, vMetroWorld.y);
          float broad = smoothstep(0.42, 0.78, metroFbm(q * 0.42 + 7.0));
          float runs = smoothstep(0.5, 0.82, metroFbm(vec2(q.x * 3.3, q.y * 0.2) + 31.0));
          float low = 1.0 - smoothstep(0.0, 1.0, vMetroWorld.y - ${f(base)} + metroNoise(q * 1.7) * 0.5);
          float soot = smoothstep(${f(sootFrom)}, ${f(sootTo)}, vMetroWorld.y + metroNoise(q * 0.6) * 1.2);
          metroDirt = clamp((broad * 0.5 + runs * 0.4 + low * 0.55 + soot * 0.6) * ${f(amount)}, 0.0, 0.92);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.3, 0.25, 0.2), metroDirt);
        }`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.94, metroDirt * 0.85);");
  };
  material.customProgramCacheKey = () => `metro-weather-${f(amount)}-${f(base)}-${f(sootFrom)}-${f(sootTo)}`;
  return material;
}

/** The vault skin between two stations along z, seen from below. */
function vaultGeometry(z0: number, z1: number, metres: number, segments = 72) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  let s = 0, px = HALF, py = SPRING;
  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * Math.PI, x = HALF * Math.cos(t), y = SPRING + RISE * Math.sin(t);
    s += Math.hypot(x - px, y - py); px = x; py = y;
    positions.push(x, y, z0, x, y, z1);
    uvs.push(s / metres, z0 / metres, s / metres, z1 / metres);
    if (i < segments) { const a = i * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A transverse rib following the vault, hanging `depth` below the skin; origin at the springing line. */
function ribGeometry(depth: number, width: number) {
  const shape = new THREE.Shape();
  shape.moveTo(HALF + 0.06, 0);
  shape.absellipse(0, 0, HALF + 0.06, RISE + 0.06, 0, Math.PI, false);
  shape.lineTo(-(HALF - depth), 0);
  shape.absellipse(0, 0, HALF - depth, RISE - depth, Math.PI, 0, true);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 56 });
  geometry.translate(0, 0, -width / 2);
  return projectUv(geometry, 3);
}

export function buildMetro(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  const metals = kit.metals();
  const props = createProps(kit);
  // One wind for the station: the piston draught. It lies almost still until a train pushes the
  // tunnel's air through the hall (see the A Site train, which drives it).
  const DRAUGHT = { strength: 0.06, gustiness: 1 };
  const wind = createWind({ heading: Math.PI, ...DRAUGHT });
  const life = createLife(kit, options, { wind, seed: 23 });
  // Everything the station is heard to do is said through here, at the place it happens.
  const heard = new THREE.Vector3(), vary = rng(4750);
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => options.cue?.(name, heard.set(x, y, z), { gain, pitch: pitch * (0.96 + vary() * 0.08) });
  const at = (x: number, y: number, z: number, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): Transform => ({ position: [x, y, z], rotation, scale });
  const sides = [-1, 1];
  const sharp = <T extends THREE.Texture>(texture: T) => { texture.anisotropy = anisotropy; return track(texture); };

  // ---- Materials -----------------------------------------------------------
  const tiles = glazedTiles(733);
  [tiles.map, tiles.roughnessMap, tiles.bumpMap].forEach(sharp);
  const tileMaterial = (color: number, amount: number, base = 0, sootFrom = 99, sootTo = 100) => weather(new THREE.MeshStandardMaterial({
    ...tiles, bumpScale: 1.4, color, roughness: 1, metalness: 0, envMapIntensity: 0.9,
  }), amount, base, sootFrom, sootTo);
  const tileCream = tileMaterial(0xf1ebdc, 0.42);
  const tileTrack = tileMaterial(0xcdc6b6, 0.62, PIT + 0.9);
  const tileAmber = tileMaterial(0xcf7a16, 0.4);
  const tileDark = tileMaterial(0x2b2a26, 0.3);

  const plasterMaps = photoSet("/textures/painted_plaster_wall-2k", 1, 1, false);
  const plasterMaterial = (color: number, amount: number, sootFrom: number, sootTo: number) => weather(new THREE.MeshStandardMaterial({
    ...plasterMaps, color, roughness: 0.95, metalness: 0, envMapIntensity: 0.55, side: THREE.DoubleSide,
  }), amount, 0, sootFrom, sootTo);
  const vaultPlaster = plasterMaterial(0xcbbfa4, 0.7, 6.4, 9.6);
  const wallPlaster = plasterMaterial(0xc4b89e, 0.75, 5.2, 8.6);

  const cast = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1);
  const concreteMaterial = (color: number, amount: number, base = 0, sootFrom = 99, sootTo = 100) => weather(new THREE.MeshStandardMaterial({
    ...cast, color, roughness: 0.95, metalness: 0, aoMapIntensity: 0.7, envMapIntensity: 0.5,
  }), amount, base, sootFrom, sootTo);
  const ribConcrete = concreteMaterial(0xd9cfb8, 0.55, 0, 7.2, 9.8);
  const coping = concreteMaterial(0xc9c4b8, 0.25, -3);
  const pitConcrete = concreteMaterial(0x6a645a, 0.8, PIT + 0.6);
  const tunnelConcrete = new THREE.MeshStandardMaterial({ ...cast, color: 0x3a3632, roughness: 0.95, metalness: 0, envMapIntensity: 0.25, side: THREE.BackSide });
  const ballastMaps = photoSet("/textures/asphalt_02-2k", 1, 1, false);
  const ballast = new THREE.MeshStandardMaterial({ ...ballastMaps, color: 0x4c4640, roughness: 1, metalness: 0, envMapIntensity: 0.3 });
  const woodMaps = photoSet("/textures/lacquered_cherry_wood-2k", 1, 1, false);
  const wood = new THREE.MeshStandardMaterial({ ...woodMaps, color: 0xb98a5c, roughness: 0.75, metalness: 0, envMapIntensity: 0.7 });

  const trainSteel = pbrMaterial(keep(tile(brushedMetal(anisotropy, [0.5, 0.52, 0.53], 131), 2, 3)), { envMapIntensity: 1.2 });
  const trainPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.6, 0.62, 0.62], 181, 0.22)), { envMapIntensity: 1 });
  const amberPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.6, 0.27, 0.035], 141, 0.3, 512)), { envMapIntensity: 1 });
  const greenPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.035, 0.12, 0.1], 151, 0.45, 512)), { envMapIntensity: 1 });
  const creamPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.55, 0.5, 0.38], 161, 0.4, 512)), { envMapIntensity: 0.9 });
  const galvanised = pbrMaterial(keep(tile(brushedMetal(anisotropy, [0.46, 0.48, 0.48], 171), 4, 2)), { envMapIntensity: 1 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.7, metalness: 0 });
  const gasket = new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.5, metalness: 0 });

  const glow = (color: THREE.Color, strength: number) => new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(strength), toneMapped: false });
  // Faces laid on a backing (signs, paper, screens) are decals: a real stand-off plus a depth
  // offset, so they can never tie with the surface behind them at any distance or angle.
  const DECAL = { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 } as const;
  const lit = (map: THREE.Texture, strength: number) => new THREE.MeshBasicMaterial({ map: sharp(map), color: new THREE.Color().setScalar(strength), toneMapped: false, ...DECAL });
  const enamel = (map: THREE.Texture) => new THREE.MeshStandardMaterial({ map: sharp(map), roughness: 0.32, metalness: 0, envMapIntensity: 0.9, ...DECAL });
  const paper = (map: THREE.Texture) => new THREE.MeshStandardMaterial({ map: sharp(map), roughness: 0.7, metalness: 0, envMapIntensity: 0.5, ...DECAL });
  const tubeGlow = glow(TUBE, 2.2);
  const tubeFailing = [glow(TUBE, 3.4), glow(TUBE, 3.4)];
  const sodiumGlow = glow(SODIUM, 6);
  const sodiumFailing = glow(SODIUM, 6);

  /** A flat panel standing in the world, turned about the vertical. */
  const panel = (width: number, height: number, material: THREE.Material, x: number, y: number, z: number, turn: number) => {
    const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(width, height), material), x, y, z, false);
    mesh.rotation.y = turn;
    mesh.receiveShadow = false;
    return mesh;
  };
  /** Rods from a hanging thing up to the vault. */
  const hangers = (spots: Array<[number, number, number]>, radius = 0.014) => {
    instances(new THREE.CylinderGeometry(radius, radius, 1, 6), metals.darkMetal, spots.map(([x, y, z]) => {
      const top = vaultY(x) + 0.05;
      return at(x, (y + top) / 2, z, [0, 0, 0], [1, top - y, 1]);
    }), false, false);
  };

  // Train interior finishes carry a little of their own light: the saloon is roofed against the
  // key and lit by its ceiling strips, which are emissive geometry rather than real lamps.
  const fabricMaps = photoSet("/textures/fabric_pattern_07-2k", 1, 1, false);
  const moquette = new THREE.MeshStandardMaterial({ ...fabricMaps, color: 0xffc76b, roughness: 1, metalness: 0, emissive: 0xffc76b, emissiveMap: fabricMaps.map, emissiveIntensity: 0.3, envMapIntensity: 0.4 });
  const tiledMaps = photoSet("/textures/tiled_floor_001-2k", 1, 1, false);
  const trainFloor = new THREE.MeshStandardMaterial({ ...tiledMaps, color: 0x8ea0aa, roughness: 0.9, metalness: 0, emissive: 0x8ea0aa, emissiveMap: tiledMaps.map, emissiveIntensity: 0.26, envMapIntensity: 0.6 });
  const kioskFloor = new THREE.MeshStandardMaterial({ ...tiledMaps, color: 0xd8c8b0, roughness: 0.9, metalness: 0, emissive: 0xd8c8b0, emissiveMap: tiledMaps.map, emissiveIntensity: 0.2, envMapIntensity: 0.5 });
  const plateMaps = photoSet("/textures/metal_plate-2k", 1, 1, false);
  const plate = new THREE.MeshStandardMaterial({ ...plateMaps, color: 0x777b7c, roughness: 1, metalness: 0.7, envMapIntensity: 0.8 });
  const rustMaps = photoSet("/textures/rusty_metal_02-2k", 1, 1, false);
  const rust = new THREE.MeshStandardMaterial({ ...rustMaps, color: 0x8d7c6e, roughness: 1, metalness: 0.45, envMapIntensity: 0.6 });
  const springSteel = metals.structural;
  const selfLit = (color: number, roughness: number, amount: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive: color, emissiveIntensity: amount, envMapIntensity: 0.8 });
  const lining = selfLit(0xdcd6c6, 0.5, 0.32);
  const seatShell = selfLit(0x1d6a66, 0.42, 0.32);
  const poleYellow = selfLit(0xe2a61c, 0.3, 0.32, 0.1);
  const inMetal = new THREE.MeshStandardMaterial({ color: 0x8f9698, roughness: 0.35, metalness: 0.85, emissive: 0x40464a, emissiveIntensity: 0.5, envMapIntensity: 1 });
  const redPaint = selfLit(0xa3201a, 0.4, 0.12);
  const whiteGlaze = new THREE.MeshStandardMaterial({ color: 0xe9e5d8, roughness: 0.32, metalness: 0, envMapIntensity: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ map: sharp(glassTexture()), transparent: true, roughness: 0.05, metalness: 0, envMapIntensity: 3, side: THREE.DoubleSide, depthWrite: false });
  const posterGlass = new THREE.MeshStandardMaterial({ color: 0xcfe0dc, transparent: true, opacity: 0.1, roughness: 0.06, metalness: 0, envMapIntensity: 3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const selfLitPaper = (map: THREE.Texture, amount: number) => new THREE.MeshStandardMaterial({ map: sharp(map), roughness: 0.6, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: amount, envMapIntensity: 0.5, ...DECAL });
  const adverts = selfLitPaper(advertTexture(), 0.34);
  const diagram = selfLitPaper(lineDiagramTexture(), 0.4);
  const saloonGlow = glow(new THREE.Color(0.92, 0.97, 1), 1.35);
  const doorLamp = glow(SODIUM, 2.4), doorButton = glow(new THREE.Color(0.2, 1, 0.5), 1.5);
  const headGlow = glow(new THREE.Color(1, 0.95, 0.82), 7);
  const tailLens = new THREE.MeshStandardMaterial({ color: 0x5a0806, roughness: 0.15, metalness: 0, envMapIntensity: 1.4 });
  const blind = lit(ledTexture([["B SITE EXPRESS", ""], ["", ""], ["", ""]]), 1.5);
  blind.map!.repeat.set(0.56, 0.36); blind.map!.offset.set(0, 0.64);
  const carPlate = enamel(signTexture(512, 192, (context, text) => {
    bullet(context, 86, 96, 58, "#e0902a", "B");
    text("1337", 176, 80, 92, "#f2efe6", "left", 800);
    text("UNDERLINE  ·  CAR 1.6", 180, 150, 26, "#b9c4c0", "left", 700);
  }, "#12302e"));
  // The unit on the other road works the A line.
  const blindA = lit(ledTexture([["A SITE VIA LONG", ""], ["", ""], ["", ""]]), 1.5);
  blindA.map!.repeat.set(0.56, 0.36); blindA.map!.offset.set(0, 0.64);
  const carPlateA = enamel(signTexture(512, 192, (context, text) => {
    bullet(context, 86, 96, 58, "#2aa39c", "A");
    text("4750", 176, 80, 92, "#f2efe6", "left", 800);
    text("UNDERLINE  ·  CAR 64", 180, 150, 26, "#b9c4c0", "left", 700);
  }, "#12302e"));
  // Notices on the door glass: one leaf explains the door, the other the carriage.
  const stuckNotice = enamel(signTexture(512, 192, (context, text) => {
    context.strokeStyle = "#14110c"; context.lineWidth = 8; context.strokeRect(9, 9, 494, 174);
    text("DOOR STUCK?", 256, 74, 66, "#14110c", "center", 900, 440);
    text("Pull the handle. Do not shout.", 256, 140, 30, "#14110c", "center", 700, 440);
  }, "#e9c21f", 0.5, 2));
  const quietNotice = enamel(signTexture(512, 192, (context, text) => {
    context.strokeStyle = "#9fd2c8"; context.lineWidth = 6; context.strokeRect(9, 9, 494, 174);
    text("QUIET CARRIAGE", 256, 74, 56, "#f2efe6", "center", 900, 440);
    text("sneaky-beaky like  ·  hold shift to walk", 256, 140, 26, "#9fd2c8", "center", 700, 440);
  }, "#12302e", 0.5, 2));
  const consoleFace = lit(consoleTexture(), 0.85);
  const cabScreen = glow(new THREE.Color(0.2, 0.9, 0.75), 0.7);

  /** Collects static pieces by material and merges each material's pieces into one (instanced) mesh. */
  const batch = () => {
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const matrix = new THREE.Matrix4(), turn = new THREE.Quaternion(), euler = new THREE.Euler();
    const add = (material: THREE.Material, geometry: THREE.BufferGeometry, x = 0, y = 0, z = 0, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => {
      const part = mergeable(geometry);
      part.applyMatrix4(matrix.compose(new THREE.Vector3(x, y, z), turn.setFromEuler(euler.set(...rotation)), new THREE.Vector3(...scale)));
      const list = groups.get(material);
      if (list) list.push(part); else groups.set(material, [part]);
    };
    const build = (transforms: Transform[], hit = false, shadow = false, unmirrored = false) => [...groups].map(([material, parts]) => {
      const merged = mergeGeometries(parts);
      parts.forEach((part) => part.dispose());
      const mesh = instances(merged, material, transforms, hit, shadow);
      if (unmirrored) kit.mirrorHidden.push(mesh);
      return mesh;
    });
    return { add, build };
  };
  const HERE = [at(0, 0, 0)];

  // ---- Floor ---------------------------------------------------------------
  const floorDepth = BACK_Z - END_Z, floorMid = (BACK_Z + END_Z) / 2;
  const paving = photoSet("/textures/concrete_floor_worn_001-2k", 19.12 / 4.2, floorDepth / 4.2);
  const terrazzo = sharp(terrazzoTexture());
  terrazzo.repeat.set(19.12 / 2.4, floorDepth / 2.4);
  const floorMaterial = new THREE.MeshStandardMaterial({
    ...paving, map: terrazzo, normalScale: new THREE.Vector2(0.45, 0.45), color: 0xb9b3a8, roughness: 0.62, metalness: 0, aoMapIntensity: 0.7, envMapIntensity: 0.6,
  });
  const reflection = kit.floor(floorMaterial, { width: 19.12, depth: floorDepth, z: floorMid }, {
    lane: new THREE.Color(0xe9e2cf).multiplyScalar(0.7),
    edge: new THREE.Color(0xe0a41a).multiplyScalar(0.85),
    markings: 1,
    wet: -0.015,
  });

  // ---- Vault ---------------------------------------------------------------
  place(new THREE.Mesh(vaultGeometry(END_Z - 0.3, BACK_Z + 0.3, 3), vaultPlaster), 0, 0, 0, false, true);
  const ribZ = [9.5, 5.28, 0.85, -3.58, HEAD_Z, -12.1, -16.2, -20.3, -24.4, -28.3];
  instances(ribGeometry(0.46, 0.5), ribConcrete, ribZ.map((z) => at(0, SPRING, z)), false, false);
  // Longitudinal ribs complete the coffers.
  const purlin = (degrees: number, from: number, to: number): Transform => {
    const t = degrees * Math.PI / 180, x = HALF * Math.cos(t), y = SPRING + RISE * Math.sin(t);
    const normal = new THREE.Vector2(-Math.cos(t) / HALF, -Math.sin(t) / RISE).normalize();
    return at(x + normal.x * 0.1, y + normal.y * 0.1, (from + to) / 2, [0, 0, Math.atan2(normal.y, normal.x) - Math.PI / 2], [1, 1, to - from]);
  };
  instances(worldBox(0.32, 0.3, 1, 3), ribConcrete, [
    ...[90, 68, 112, 50, 130].map((degrees) => purlin(degrees, END_Z, BACK_Z)),
    ...[28, 152].map((degrees) => purlin(degrees, HEAD_Z, BACK_Z)),
  ], false, false);

  // ---- Shell ---------------------------------------------------------------
  const platformLength = BACK_Z - HEAD_Z, platformMid = (BACK_Z + HEAD_Z) / 2;
  const hallLength = HEAD_Z - END_Z, hallMid = (HEAD_Z + END_Z) / 2;
  const hazard = sharp(hazardTexture());
  const hazardMaterial = (x: number, y: number) => {
    const copy = track(hazard.clone());
    copy.needsUpdate = true;
    copy.repeat.set(x, y);
    return new THREE.MeshStandardMaterial({ map: copy, roughness: 0.5, metalness: 0, envMapIntensity: 0.8 });
  };
  // Back wall behind the firing line and the wall the running tunnels leave through. The portals
  // are round-headed and sit flush with the bore lining on the platform side.
  const portal = { x: 11.35, width: 3.3, spring: 1.9 - PIT };
  const portalHoles = (offset: number) => sides.map((side) => ({ x: side * portal.x - offset, width: portal.width, spring: portal.spring }));
  // Left of the chart a third arch is the way out: the escalator shaft opens behind it (see Way out).
  const ESC_X = -7.85;
  place(new THREE.Mesh(archedWall(27.4, DADO - PIT, 0.4, [...portalHoles(0), { x: ESC_X, width: 2, spring: 2.05 - PIT }]), tileCream), 0, PIT, BACK_Z + 0.2, false, true);
  place(new THREE.Mesh(worldBox(27.4, 5.2, 0.4, 3), wallPlaster), 0, DADO + 2.6, BACK_Z + 0.2, false, true);
  for (const side of sides) {
    place(new THREE.Mesh(archedWall(HALF - EDGE, DADO - PIT, 0.4, [{ x: side * (portal.x - (HALF + EDGE) / 2), width: portal.width, spring: portal.spring }]), tileCream), side * (HALF + EDGE) / 2, PIT, HEAD_Z - 0.2, false, true);
    place(new THREE.Mesh(worldBox(HALF - EDGE, 3.6, 0.4, 3), wallPlaster), side * (HALF + EDGE) / 2, DADO + 1.8, HEAD_Z - 0.2, false, true);
  }
  // A cast ring stands proud around each mouth, with hazard plates on its legs at track level.
  const portalEnds = sides.flatMap((side) => [HEAD_Z, BACK_Z].map((z) => ({ x: side * portal.x, z })));
  const ringShape = new THREE.Shape();
  const ringIn = portal.width / 2, ringOut = ringIn + 0.24;
  ringShape.moveTo(-ringOut, 0); ringShape.lineTo(-ringOut, portal.spring); ringShape.absarc(0, portal.spring, ringOut, Math.PI, 0, true);
  ringShape.lineTo(ringOut, 0); ringShape.lineTo(ringIn, 0); ringShape.lineTo(ringIn, portal.spring); ringShape.absarc(0, portal.spring, ringIn, 0, Math.PI, false);
  ringShape.lineTo(-ringIn, 0); ringShape.closePath();
  const ringGeometry = projectUv(new THREE.ExtrudeGeometry(ringShape, { depth: 0.13, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1, curveSegments: 20 }), 2.4);
  instances(ringGeometry, tileDark, portalEnds.map(({ x, z }) => at(x, PIT, z, [0, z < 0 ? 0 : Math.PI, 0])), false, false);
  instances(new THREE.BoxGeometry(1.3, 0.2, 0.03).rotateZ(Math.PI / 2), hazardMaterial(2.6, 1), portalEnds.flatMap(({ x, z }) => [-1, 1].map((o) => at(x + o * (ringIn + 0.12), 0.75, z + (z < 0 ? 0.15 : -0.15)))), false, false);
  // Far walls of the two tracks.
  for (const side of sides) {
    place(new THREE.Mesh(worldBox(0.4, 5.7, platformLength, 2.4), tileTrack), side * (HALF + 0.2), PIT + 2.85, platformMid, false, true);
    place(new THREE.Mesh(softBox(0.34, 0.26, platformLength, 0.03, 3), ribConcrete), side * (HALF - 0.1), SPRING - 0.06, platformMid, false);
    place(new THREE.Mesh(worldBox(0.02, 0.3, platformLength, 2.4), tileAmber), side * (HALF - 0.008), 3.3, platformMid, false);
    place(new THREE.Mesh(worldBox(0.03, 0.075, platformLength, 2.4), tileDark), side * (HALF - 0.012), 3.49, platformMid, false);
    place(new THREE.Mesh(worldBox(0.03, 0.075, platformLength, 2.4), tileDark), side * (HALF - 0.012), 3.11, platformMid, false);
  }
  // Concourse walls: tiled dado the range signs hang on, plaster above. The left one is cut for the kiosk.
  const kiosk = { from: -24, to: -20.8, top: 2.5, depth: 1.3 };
  // They stop at the back of the head wall: its piers carry the same face on to the corner.
  const hallTo = HEAD_Z - 0.4;
  const dadoRuns: Array<[number, number, number, number, number]> = [
    [1, END_Z, hallTo, 0, DADO], [-1, END_Z, kiosk.from, 0, DADO], [-1, kiosk.to, hallTo, 0, DADO], [-1, kiosk.from, kiosk.to, kiosk.top, DADO],
  ];
  for (const [side, from, to, low, top] of dadoRuns) place(new THREE.Mesh(worldBox(0.1, top - low, to - from, 2.4), tileCream), side * (EDGE + 0.05), (top + low) / 2, (from + to) / 2, false, true);
  for (const side of sides) {
    place(new THREE.Mesh(worldBox(0.1, 3.6, hallTo - END_Z, 3), wallPlaster), side * (EDGE + 0.05), DADO + 1.8, (hallTo + END_Z) / 2, false, true);
    place(new THREE.Mesh(worldBox(0.024, 0.3, hallLength, 2.4), tileAmber), side * (EDGE - 0.01), DADO - 0.2, hallMid, false);
    place(new THREE.Mesh(softBox(0.09, 0.08, hallLength, 0.02, 2.4), tileDark), side * (EDGE - 0.02), DADO, hallMid, false);
    place(new THREE.Mesh(worldBox(0.034, 0.05, hallLength, 2.4), tileDark), side * (EDGE - 0.012), DADO - 0.375, hallMid, false);
  }
  const skirtRuns: Array<[number, number, number]> = [[1, END_Z, HEAD_Z], [-1, END_Z, kiosk.from], [-1, kiosk.to, HEAD_Z]];
  for (const [side, from, to] of skirtRuns) place(new THREE.Mesh(softBox(0.07, 0.3, to - from, 0.015, 2.4), tileDark), side * (EDGE - 0.02), 0.15, (from + to) / 2, false);
  // End wall behind the control centre.
  place(new THREE.Mesh(worldBox(19.4, DADO, 0.4, 2.4), tileCream), 0, DADO / 2, END_Z - 0.2, false, true);
  place(new THREE.Mesh(worldBox(19.4, 5.2, 0.4, 3), wallPlaster), 0, DADO + 2.6, END_Z - 0.2, false, true);
  place(new THREE.Mesh(worldBox(19.1, 0.3, 0.024, 2.4), tileAmber), 0, DADO - 0.2, END_Z + 0.01, false);
  place(new THREE.Mesh(softBox(19.1, 0.08, 0.09, 0.02, 2.4), tileDark), 0, DADO, END_Z + 0.02, false);
  // Back wall trim either side of the chart.
  for (const side of sides) place(new THREE.Mesh(worldBox(3.1, 0.3, 0.024, 2.4), tileAmber), side * 7.95, DADO - 0.2, BACK_Z - 0.01, false);
  for (const [from, to] of [[-9.5, ESC_X - 1], [ESC_X + 1, -6.4], [6.4, 9.5]]) place(new THREE.Mesh(softBox(to - from, 0.3, 0.07, 0.015, 2.4), tileDark), (from + to) / 2, 0.15, BACK_Z - 0.02, false);
  place(new THREE.Mesh(softBox(19.1, 0.08, 0.09, 0.02, 2.4), tileDark), 0, 7.3, BACK_Z - 0.02, false);

  // ---- Platform edge and track ---------------------------------------------
  const tactile = sharp(tactileTexture(false, !high)), tactileRelief = sharp(tactileTexture(true));
  for (const map of [tactile, tactileRelief]) map.repeat.set(1, platformLength / 0.4);
  const tactileMaterial = new THREE.MeshStandardMaterial({ map: tactile, ...(high ? {} : { bumpMap: tactileRelief, bumpScale: 3 }), roughness: 0.6, metalness: 0, envMapIntensity: 0.7 });
  const tactileStud = new THREE.MeshStandardMaterial({ color: 0xe0b02c, roughness: 0.5, metalness: 0, envMapIntensity: 0.7 });
  const tactileGeometry = new THREE.BoxGeometry(0.4, 0.012, platformLength - 0.04);
  for (const side of sides) {
    const strip = place(new THREE.Mesh(tactileGeometry, tactileMaterial), side * 9.2, 0.006, platformMid, false);
    kit.mirrorHidden.push(strip);
    place(new THREE.Mesh(softBox(0.34, 0.22, platformLength, 0.018, 1.6), coping), side * (EDGE + 0.06), -0.1, platformMid, false, true);
    place(new THREE.Mesh(worldBox(0.22, 0.95, platformLength, 2.4), pitConcrete), side * (EDGE + 0.13), PIT + 0.475, platformMid, false, true);
  }
  const trackFrom = HEAD_Z - 0.4, trackTo = BACK_Z + 0.4, trackRun = trackTo - trackFrom, trackMid = (trackFrom + trackTo) / 2;
  instances(worldBox(3.9, 0.3, trackRun, 1.8), ballast, sides.map((side) => at(side * 11.45, PIT - 0.15, trackMid)), true, false);
  instances(softBox(2.5, 0.16, 0.26, 0.02, 1.2), pitConcrete, sides.flatMap((side) => Array.from({ length: Math.floor(trackRun / 0.7) }, (_, i) => at(side * TRACK_X, PIT + 0.05, trackFrom + 0.4 + i * 0.7))), false, false);
  const railX = sides.flatMap((side) => [-0.7175, 0.7175].map((o) => side * TRACK_X + o));
  instances(softBox(0.07, 0.15, trackRun, 0.012, 1), metals.brushed, railX.map((x) => at(x, PIT + 0.2, trackMid)), false, false);
  instances(softBox(0.15, 0.03, trackRun, 0.008, 1), metals.darkMetal, railX.map((x) => at(x, PIT + 0.135, trackMid)), false, false);
  // Conductor rail under its cover board, on the wall side.
  instances(softBox(0.08, 0.1, trackRun, 0.01, 1), metals.structural, sides.map((side) => at(side * 12.78, PIT + 0.32, trackMid)), false, false);
  instances(softBox(0.2, 0.03, trackRun, 0.008, 1), amberPaint, sides.map((side) => at(side * 12.76, PIT + 0.42, trackMid)), false, false);
  instances(softBox(0.1, 0.26, 0.1, 0.01, 1), creamPaint, sides.flatMap((side) => Array.from({ length: 7 }, (_, i) => at(side * 12.82, PIT + 0.13, trackFrom + 0.9 + i * 2.8))), false, false);
  // Cable runs on the track walls.
  const cableRun = new THREE.CylinderGeometry(0.028, 0.028, platformLength, 8);
  cableRun.rotateX(Math.PI / 2);
  instances(cableRun, rubber, sides.flatMap((side) => [0, 1, 2, 3, 4].map((i) => at(side * (HALF - 0.09), -0.62 + i * 0.085, platformMid, [0, 0, 0], [1 - (i % 2) * 0.25, 1 - (i % 2) * 0.25, 1]))), false, false);
  instances(softBox(0.14, 0.5, 0.05, 0.01, 1), metals.structural, sides.flatMap((side) => Array.from({ length: 12 }, (_, i) => at(side * (HALF - 0.06), -0.45, HEAD_Z + 0.9 + i * 1.5))), false, false);
  // Standing water between the rails of the empty track.
  const pool = sharp(blotTexture(61));
  const poolMaterial = new THREE.MeshStandardMaterial({ alphaMap: pool, color: 0x0c0b0a, transparent: true, roughness: 0.04, metalness: 0, envMapIntensity: 1.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const poolGeometry = new THREE.PlaneGeometry(1.3, 3.6);
  poolGeometry.rotateX(-Math.PI / 2);
  for (const [z, turn] of [[5.4, 0.1], [-3.1, -0.16]]) {
    const mesh = place(new THREE.Mesh(poolGeometry, poolMaterial), -TRACK_X, PIT + 0.014, z, false);
    mesh.rotation.y = turn;
    mesh.renderOrder = 2;
  }
  // Signals at the leaving end of each track: the held train faces a red, the empty road shows green.
  const signalSpots: V3[] = [[HALF - 0.14, 1.5, HEAD_Z + 0.5], [-(HALF - 0.14), 1.5, BACK_Z - 0.5]];
  instances(softBox(0.2, 0.6, 0.2, 0.03, 1), metals.darkMetal, signalSpots.map(([x, y, z]) => at(x, y, z)), false, false);
  const signalLens = new THREE.SphereGeometry(0.055, 14, 10);
  const lensDark = new THREE.MeshStandardMaterial({ color: 0x140606, roughness: 0.2 });
  const aspect = (spot: V3, o: number) => at(spot[0] - Math.sign(spot[0]) * 0.09, spot[1] + o, spot[2]);
  instances(signalLens, glow(new THREE.Color(1, 0.06, 0.03), 4), [aspect(signalSpots[0], 0.16)], false, false);
  // The empty road's starter is worked by the train that runs through it, so both its aspects are lamps of their own.
  const starterGreen = glow(new THREE.Color(0.1, 1, 0.35), 3), starterRed = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.03, 0.006, 0.006), toneMapped: false });
  instances(signalLens, starterGreen, [aspect(signalSpots[1], -0.14)], false, false);
  instances(signalLens, starterRed, [aspect(signalSpots[1], 0.16)], false, false);
  instances(signalLens, lensDark, [aspect(signalSpots[0], -0.14)], false, false);

  // An enamel warning over every mouth.
  const dangerPlate = enamel(signTexture(1024, 160, (context, text) => {
    context.strokeStyle = "#f2efe6"; context.lineWidth = 6; context.strokeRect(10, 10, 1004, 140);
    context.fillStyle = "#f2efe6"; context.beginPath(); context.moveTo(92, 34); context.lineTo(150, 126); context.lineTo(34, 126); context.closePath(); context.fill();
    context.fillStyle = "#a3201a"; context.beginPath(); context.moveTo(98, 58); context.lineTo(82, 86); context.lineTo(94, 86); context.lineTo(84, 114); context.lineTo(108, 80); context.lineTo(95, 80); context.closePath(); context.fill();
    text("DANGER  ·  NO RESPAWNS", 190, 58, 58, "#f2efe6", "left", 900, 800);
    text("one life per round  ·  do not pass this point", 190, 114, 36, "#f6d9d2", "left", 600, 800);
  }, "#a3201a"));
  instances(softBox(2.06, 0.36, 0.03, 0.008, 1), metals.brushed, portalEnds.map(({ x, z }) => at(x, 4.1, z + (z < 0 ? 0.012 : -0.012))), false, false);
  for (const { x, z } of portalEnds) panel(2.0, 0.3125, dangerPlate, x, 4.1, z + (z < 0 ? 0.04 : -0.04), z < 0 ? 0 : Math.PI);

  // ---- Running tunnels -------------------------------------------------------
  // Past each portal the bore is real: a ribbed horseshoe lining that bends out of sight, sleepers
  // and rails, cables on brackets and bulkhead lamps receding into haze. Nothing in there is lit
  // by the scene: every face carries its light baked per vertex, so the four bores cost a handful
  // of draws and no lamps.
  type BoreLight = { at: V3; colour: V3; reach: number };
  type Bore = { side: number; dir: number; z0: number; straight: number; radius: number; length: number; lamps: number[]; beacons?: Array<{ s: number; colour: V3 }>; extra?: BoreLight[] };
  const BORE_X = 11.5, BORE_HW = 1.8, BORE_SPRING = 2.0, BORE_RISE = 1.7;
  const BORE_HAZE: V3 = [0.016, 0.022, 0.031];
  /** Leading end of the held train (CAR_Z - HL in the train section). */
  const noseAt = -6.6;
  const boreList: Bore[] = [
    // Empty road, north: bends away at once to clear the kiosk behind the concourse wall.
    { side: -1, dir: -1, z0: HEAD_Z - 0.4, straight: 1, radius: 36, length: 33, lamps: [2, 8, 14, 20, 26], beacons: [{ s: 11, colour: [0.25, 0.5, 1] }] },
    // The held train looks into this one: its headlamps reach the first ribs, a red repeater waits on the bend.
    {
      side: 1, dir: -1, z0: HEAD_Z - 0.4, straight: 16, radius: 60, length: 58, lamps: [6, 12, 18, 24, 30, 36, 42, 48, 54], beacons: [{ s: 27, colour: [1, 0.07, 0.03] }],
      extra: sides.map((o): BoreLight => ({ at: [TRACK_X + o * 1.02, 0.5, noseAt - 0.4], colour: [3.4, 2.9, 2.1], reach: 3.4 })),
    },
    { side: -1, dir: 1, z0: BACK_Z + 0.4, straight: 10, radius: 55, length: 54, lamps: [2, 8, 14, 20, 26, 32, 38, 44, 50], beacons: [{ s: 23, colour: [0.1, 1, 0.35] }, { s: 41, colour: [1, 0.6, 0.05] }] },
    // The rear car stands in this one; only the gap over its roof is ever seen.
    { side: 1, dir: 1, z0: BACK_Z + 0.4, straight: 99, radius: 99, length: 10.6, lamps: [2, 8] },
  ];
  const boreFrame = (bore: Bore, s: number) => {
    const phi = Math.max(0, s - bore.straight) / bore.radius, sin = Math.sin(phi), cos = Math.cos(phi);
    return {
      x: bore.side * (BORE_X + bore.radius * (1 - cos)), z: bore.z0 + bore.dir * (Math.min(s, bore.straight) + bore.radius * sin),
      ax: cos, az: -bore.side * bore.dir * sin, tx: bore.side * sin, tz: bore.dir * cos, turn: bore.side * bore.dir * phi,
    };
  };
  /** World position of a point `u` across, `y` up and `ds` further along from the station at `s`. */
  const borePoint = (bore: Bore, s: number, u: number, y: number, ds = 0): V3 => {
    const f = boreFrame(bore, s);
    return [f.x + f.ax * u + f.tx * ds, y, f.z + f.az * u + f.tz * ds];
  };
  type Sink = { position: number[]; color: number[]; uv: number[] };
  const sink = (): Sink => ({ position: [], color: [], uv: [] });
  const boreShell = sink(), boreBed = sink(), boreFittings = sink();
  const fade = (s: number) => Math.exp(-Math.max(0, s) / 24);
  /** One flat-shaded quad: light from every source is gathered at each corner against the face normal. */
  const bakeQuad = (target: Sink, lights: BoreLight[], corners: [V3, V3, V3, V3], depth: [number, number, number, number], facing: V3, tint: V3, uv: [number, number, number, number, number, number, number, number]) => {
    const [a, b, , d] = corners;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const reversed = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0, flip = (reversed ? -1 : 1) / (Math.hypot(nx, ny, nz) || 1);
    nx *= flip; ny *= flip; nz *= flip;
    const shade = corners.map((point, i): V3 => {
      let r = 0.02, g = 0.02, bl = 0.024;
      for (const light of lights) {
        const dx = light.at[0] - point[0], dy = light.at[1] - point[1], dz = light.at[2] - point[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        const k = Math.max(0, (dx * nx + dy * ny + dz * nz) / (Math.sqrt(d2) + 1e-4) * 0.84 + 0.16) / (1 + d2 / (light.reach * light.reach));
        r += light.colour[0] * k; g += light.colour[1] * k; bl += light.colour[2] * k;
      }
      const air = fade(depth[i]);
      return [r * tint[0] * air + BORE_HAZE[0] * (1 - air), g * tint[1] * air + BORE_HAZE[1] * (1 - air), bl * tint[2] * air + BORE_HAZE[2] * (1 - air)];
    });
    // Wound to face the way it was lit, so bullet marks land the right way round.
    for (const i of reversed ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) { target.position.push(...corners[i]); target.color.push(...shade[i]); target.uv.push(uv[i * 2], uv[i * 2 + 1]); }
  };
  const boreProfile = (inset: number): Array<[number, number]> => {
    const hw = BORE_HW - inset, points: Array<[number, number]> = [[-hw, PIT], [-hw, 0.3], [-hw, BORE_SPRING]];
    for (let i = 1; i < 14; i += 1) { const a = Math.PI - (i / 14) * Math.PI; points.push([Math.cos(a) * hw, BORE_SPRING + Math.sin(a) * (BORE_RISE - inset)]); }
    points.push([hw, BORE_SPRING], [hw, 0.3], [hw, PIT]);
    return points;
  };
  const flush = boreProfile(0), proud = boreProfile(0.09);
  const girth = flush.reduce<number[]>((sum, point, i) => [...sum, i ? sum[i - 1] + Math.hypot(point[0] - flush[i - 1][0], point[1] - flush[i - 1][1]) : 0], []);
  const NO_UV: [number, number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0, 0];
  const lensSpots: Transform[] = [], lensTint: V3[] = [], cardSpots: Transform[] = [], cardTint: V3[] = [];
  for (const bore of boreList) {
    const { side, length } = bore, outer = side * BORE_HW;
    const point = (s: number, u: number, y: number, ds = 0) => borePoint(bore, s, u, y, ds);
    const lights: BoreLight[] = [
      // The station, seen from inside as one soft source just outside the mouth.
      { at: point(-1.2, -side * 0.4, 1.6), colour: [1.5, 1.2, 0.86], reach: 2.7 },
      ...bore.lamps.map((s): BoreLight => ({ at: point(s, outer - side * 0.3, 1.82), colour: [1.9, 2.2, 2.5], reach: 1.7 })),
      ...(bore.beacons ?? []).map(({ s, colour }): BoreLight => ({ at: point(s, outer - side * 0.3, 1.45), colour: [colour[0] * 2.2, colour[1] * 2.2, colour[2] * 2.2], reach: 1.2 })),
      ...(bore.extra ?? []),
    ];
    const toward = (from: V3, to: V3): V3 => [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const UP: V3 = [0, 1, 0];
    // Lining, with a cast rib every two metres.
    const stations: Array<[number, number]> = [[0, 0]];
    for (let s = 0.9; s < length - 0.3; s += 2) stations.push([s - 0.17, 0], [s - 0.13, 1], [s + 0.13, 1], [s + 0.17, 0]);
    stations.push([length, 0]);
    const soot = rng(Math.round(911 + side * 7 + bore.dir * 3));
    for (let i = 0; i < stations.length - 1; i += 1) {
      const [s0, raised0] = stations[i], [s1, raised1] = stations[i + 1];
      const ring0 = raised0 ? proud : flush, ring1 = raised1 ? proud : flush, axis = point((s0 + s1) / 2, 0, 1.2);
      // Each pour is a slightly different grey; brake dust and damp darken the foot of the walls.
      const pour = (raised0 && raised1 ? 0.92 : 0.72) + soot() * 0.2;
      for (let j = 0; j < flush.length - 1; j += 1) {
        const corners: [V3, V3, V3, V3] = [point(s0, ring0[j][0], ring0[j][1]), point(s0, ring0[j + 1][0], ring0[j + 1][1]), point(s1, ring1[j + 1][0], ring1[j + 1][1]), point(s1, ring1[j][0], ring1[j][1])];
        const low = j === 0 || j === flush.length - 2 ? 0.55 : 1, leak = soot() > 0.93 ? 0.6 : 1;
        bakeQuad(boreShell, lights, corners, [s0, s0, s1, s1], toward(corners[0], axis), [pour * low * leak, pour * low * leak * 0.95, pour * low * leak * 0.86], [girth[j] / 3, s0 / 3, girth[j + 1] / 3, s0 / 3, girth[j + 1] / 3, s1 / 3, girth[j] / 3, s1 / 3]);
      }
    }
    // The last thing down the bore is air.
    bakeQuad(boreShell, [], [point(length, -BORE_HW, PIT), point(length, BORE_HW, PIT), point(length, BORE_HW, 3.8), point(length, -BORE_HW, 3.8)], [999, 999, 999, 999], UP, [1, 1, 1], NO_UV);
    // Track bed, sleepers, running rails and the conductor rail under its board.
    const strips = [-BORE_HW, -0.9, 0, 0.9, BORE_HW];
    for (let s = 0; s < length; s += 1.6) {
      const e = Math.min(length, s + 1.6);
      for (let k = 0; k < 4; k += 1) bakeQuad(boreBed, lights, [point(s, strips[k], PIT), point(s, strips[k + 1], PIT), point(e, strips[k + 1], PIT), point(e, strips[k], PIT)], [s, s, e, e], UP, [0.62, 0.57, 0.52], [strips[k] / 1.8, s / 1.8, strips[k + 1] / 1.8, s / 1.8, strips[k + 1] / 1.8, e / 1.8, strips[k] / 1.8, e / 1.8]);
    }
    const track = -side * (BORE_X - TRACK_X), grime: V3 = [0.5, 0.46, 0.4];
    for (let s = 0.35; s < Math.min(length, 38); s += 0.7) {
      const y = PIT + 0.13, f = boreFrame(bore, s), along: V3 = [f.tx, 0, f.tz];
      bakeQuad(boreShell, lights, [point(s, track - 1.25, y, -0.13), point(s, track + 1.25, y, -0.13), point(s, track + 1.25, y, 0.13), point(s, track - 1.25, y, 0.13)], [s, s, s, s], UP, grime, [0, 0, 0.8, 0, 0.8, 0.09, 0, 0.09]);
      bakeQuad(boreShell, lights, [point(s, track - 1.25, PIT, -0.13), point(s, track + 1.25, PIT, -0.13), point(s, track + 1.25, y, -0.13), point(s, track - 1.25, y, -0.13)], [s, s, s, s], [-along[0], 0, -along[2]], grime, [0, 0.1, 0.8, 0.1, 0.8, 0.14, 0, 0.14]);
    }
    for (let s = 0; s < length; s += 2) {
      const e = Math.min(length, s + 2), depth: [number, number, number, number] = [s, s, e, e], f = boreFrame(bore, s), across: V3 = [f.ax, 0, f.az];
      const run = (u0: number, y0: number, u1: number, y1: number, facing: V3, tint: V3) => bakeQuad(boreFittings, lights, [point(s, u0, y0), point(s, u1, y1), point(e, u1, y1), point(e, u0, y0)], depth, facing, tint, NO_UV);
      for (const rail of [track - 0.7175, track + 0.7175]) {
        const top = PIT + 0.275;
        run(rail - 0.035, top, rail + 0.035, top, UP, [0.95, 0.98, 1.05]);
        run(rail - 0.035, PIT + 0.13, rail - 0.035, top, [-across[0], 0, -across[2]], [0.17, 0.12, 0.09]);
        run(rail + 0.035, PIT + 0.13, rail + 0.035, top, across, [0.17, 0.12, 0.09]);
      }
      const board = side * 1.26, inward: V3 = [-side * across[0], 0, -side * across[2]];
      run(board - 0.1, PIT + 0.435, board + 0.1, PIT + 0.435, UP, [0.55, 0.25, 0.04]);
      run(board - side * 0.1, PIT + 0.26, board - side * 0.1, PIT + 0.435, inward, [0.2, 0.2, 0.2]);
      // Cables hang off the outer wall on brackets; a conduit above them feeds the lamps.
      const cables: Array<[number, number, number]> = [...[0, 1, 2, 3, 4].map((i): [number, number, number] => [-0.62 + i * 0.085, 0.028 * (1 - (i % 2) * 0.25), 0.12]), [1.99, 0.016, 0.03], [2.62, 0.022, 0.2], [2.7, 0.018, 0.2]];
      for (const [y, radius, off] of cables) {
        const wall = outer - side * off;
        run(wall, y + radius, wall - side * radius, y, [inward[0], 0.8, inward[2]], [0.16, 0.16, 0.17]);
        run(wall - side * radius, y, wall, y - radius, [inward[0], -0.8, inward[2]], [0.1, 0.1, 0.11]);
      }
    }
    for (let s = 0.9; s < length - 0.3; s += 2) {
      const f = boreFrame(bore, s), inward: V3 = [-side * f.ax, 0, -side * f.az], wall = outer - side * 0.11;
      bakeQuad(boreFittings, lights, [point(s, wall, -0.76, -0.035), point(s, wall, -0.76, 0.035), point(s, wall, -0.16, 0.035), point(s, wall, -0.16, -0.035)], [s, s, s, s], inward, [0.34, 0.35, 0.36], NO_UV);
    }
    // Bulkhead lamps on the outer wall: a cast body, a lit lens, a pool on the lining and a bloom in the haze.
    const fitting = (s: number, y: number, deep: number, tall: number, long: number, tint: V3) => {
      const f = boreFrame(bore, s), inward: V3 = [-side * f.ax, 0, -side * f.az], face = outer - side * deep, along: V3 = [f.tx, 0, f.tz], depth: [number, number, number, number] = [s, s, s, s];
      bakeQuad(boreFittings, lights, [point(s, face, y - tall, -long), point(s, face, y - tall, long), point(s, face, y + tall, long), point(s, face, y + tall, -long)], depth, inward, tint, NO_UV);
      bakeQuad(boreFittings, lights, [point(s, outer, y + tall, -long), point(s, outer, y + tall, long), point(s, face, y + tall, long), point(s, face, y + tall, -long)], depth, UP, tint, NO_UV);
      bakeQuad(boreFittings, lights, [point(s, outer, y - tall, -long), point(s, outer, y - tall, long), point(s, face, y - tall, long), point(s, face, y - tall, -long)], depth, [0, -1, 0], tint, NO_UV);
      for (const end of [-1, 1]) bakeQuad(boreFittings, lights, [point(s, outer, y - tall, end * long), point(s, face, y - tall, end * long), point(s, face, y + tall, end * long), point(s, outer, y + tall, end * long)], depth, [end * along[0], 0, end * along[2]], tint, NO_UV);
    };
    const lampAt = (s: number, y: number, colour: V3, lens: V3, pool: number, bloom: number) => {
      const f = boreFrame(bore, s), air = fade(s);
      lensSpots.push({ position: point(s, outer - side * 0.13, y), rotation: [0, f.turn, 0], scale: lens });
      lensTint.push([colour[0] * (0.25 + 0.75 * air), colour[1] * (0.25 + 0.75 * air), colour[2] * (0.25 + 0.75 * air)]);
      cardSpots.push({ position: point(s, outer - side * 0.035, y - 0.15), rotation: [0, Math.atan2(-side * f.ax, -side * f.az), 0], scale: [pool * 1.25, pool, 1] });
      cardTint.push([colour[0] * 0.2 * air, colour[1] * 0.2 * air, colour[2] * 0.2 * air]);
      cardSpots.push({ position: point(s, outer - side * 0.2, y), rotation: [0, Math.atan2(-f.tx, -f.tz), 0], scale: [bloom, bloom, 1] });
      cardTint.push([colour[0] * 0.5 * (0.3 + 0.7 * air), colour[1] * 0.5 * (0.3 + 0.7 * air), colour[2] * 0.5 * (0.3 + 0.7 * air)]);
    };
    for (const s of bore.lamps) {
      fitting(s, 1.82, 0.1, 0.11, 0.2, [0.42, 0.4, 0.34]);
      lampAt(s, 1.82, [TUBE.r, TUBE.g, TUBE.b], [1, 1, 1], 2.6, 0.95);
    }
    for (const { s, colour } of bore.beacons ?? []) {
      fitting(s, 1.4, 0.12, 0.3, 0.1, [0.05, 0.05, 0.055]);
      lampAt(s, 1.5, colour, [1.2, 0.6, 0.25], 1.5, 0.8);
    }
  }
  // Relay cabinets on the platform side of the held train's bore (they also box in the back of the furnace).
  {
    const bore = boreList[1], wall = -BORE_HW, lights: BoreLight[] = [{ at: borePoint(bore, -1.2, -0.4, 1.6), colour: [1.5, 1.2, 0.86], reach: 2.7 }, ...(bore.extra ?? []), { at: borePoint(bore, 6, BORE_HW - 0.3, 1.82), colour: [1.9, 2.2, 2.5], reach: 1.7 }];
    const box = (s0: number, s1: number, y0: number, y1: number, deep: number, tint: V3) => {
      const face = wall + deep, depth: [number, number, number, number] = [s0, s1, s1, s0];
      bakeQuad(boreFittings, lights, [borePoint(bore, s0, face, y0), borePoint(bore, s1, face, y0), borePoint(bore, s1, face, y1), borePoint(bore, s0, face, y1)], depth, [1, 0, 0], tint, NO_UV);
      bakeQuad(boreFittings, lights, [borePoint(bore, s0, wall, y1), borePoint(bore, s1, wall, y1), borePoint(bore, s1, face, y1), borePoint(bore, s0, face, y1)], depth, [0, 1, 0], tint, NO_UV);
      for (const [s, facing] of [[s0, 1], [s1, -1]]) bakeQuad(boreFittings, lights, [borePoint(bore, s, wall, y0), borePoint(bore, s, face, y0), borePoint(bore, s, face, y1), borePoint(bore, s, wall, y1)], [s, s, s, s], [0, 0, facing], tint, NO_UV);
    };
    box(1.1, 5.4, PIT, 0.26, 0.2, [0.34, 0.33, 0.3]);
    [[1.2, 2.5, 0.36], [2.5, 3.9, 0.42], [3.9, 5.3, 0.36]].forEach(([s0, s1, tone]) => box(s0, s1, 0.26, 2.3, 0.15, [tone * 0.8, tone * 1.08, tone]));
  }
  const bakedMesh = (data: Sink, material: THREE.Material, hit = false) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.position, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(data.color, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uv, 2));
    // Unlit, but the occlusion pass reads normals: without them it blacks the whole bore out.
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    if (hit) kit.shootable.push(mesh);
    return mesh;
  };
  // The train that runs on the empty road throws its headlamps down the bore ahead of it. The lining
  // is unlit, so the lamp is added in its shader: one cone with a squared fall-off, taken against the
  // face each fragment lies on, over the surface colour as it was before the baked light.
  const headlamp = { trainLamp: { value: new THREE.Vector4(0, -200, 0, 0) }, trainAim: { value: new THREE.Vector3(0, 0, 1) } };
  const lamplit = <T extends THREE.Material>(material: T, surface: number) => {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, headlamp, { trainSurface: { value: surface } });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vTrainWorld;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvTrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform vec4 trainLamp;\nuniform vec3 trainAim;\nuniform float trainSurface;\nvarying vec3 vTrainWorld;")
        .replace("#include <color_fragment>", /* glsl */ `
          vec3 trainUnlit = diffuseColor.rgb * trainSurface;
          #include <color_fragment>
          if (trainLamp.w > 0.001) {
            vec3 toLamp = trainLamp.xyz - vTrainWorld;
            float span = dot(toLamp, toLamp) + 0.0001;
            vec3 ray = toLamp * inversesqrt(span);
            vec3 face = normalize(cross(dFdx(vTrainWorld), dFdy(vTrainWorld)));
            float cone = smoothstep(0.45, 0.96, dot(-ray, trainAim));
            diffuseColor.rgb += trainUnlit * vec3(1.0, 0.93, 0.78) * (trainLamp.w * cone * (0.25 + 0.75 * abs(dot(face, ray))) / (1.0 + span * 0.012));
          }`);
    };
    return material;
  };
  // The photographs are dark in linear light; the gain brings the baked light back to what was authored.
  bakedMesh(boreShell, lamplit(new THREE.MeshBasicMaterial({ map: cast.map, color: new THREE.Color().setScalar(1.4), vertexColors: true, side: THREE.DoubleSide }), 1), true);
  bakedMesh(boreBed, lamplit(new THREE.MeshBasicMaterial({ map: ballastMaps.map, color: new THREE.Color().setScalar(1.3), vertexColors: true, side: THREE.DoubleSide }), 1));
  bakedMesh(boreFittings, lamplit(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }), 0.28));
  const tintEach = (mesh: THREE.InstancedMesh, tints: V3[]) => {
    const colour = new THREE.Color();
    tints.forEach((tint, i) => mesh.setColorAt(i, colour.setRGB(tint[0], tint[1], tint[2])));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = false;
    kit.mirrorHidden.push(mesh);
    return mesh;
  };
  tintEach(instances(new THREE.BoxGeometry(0.05, 0.13, 0.32), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(2.4), toneMapped: false }), lensSpots, false, false), lensTint);
  const boreGlow = tintEach(instances(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: sharp(softDiscTexture()), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), cardSpots, false, false), cardTint);
  boreGlow.renderOrder = 5;
  kit.probeHidden.push(boreGlow);
  // The rear car's bore is roofed against the key so the car stays dark in there.
  const boreRoof = place(new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.1, 11.4), metals.darkMetal), BORE_X, 3.92, BACK_Z + 0.4 + 5.6, true);
  boreRoof.receiveShadow = false;
  // The empty road's bores are roofed the same way, for the train that runs through them.
  const farRoofs = instances(new THREE.BoxGeometry(3.7, 0.1, 6.7), metals.darkMetal, [boreList[0], boreList[2]].flatMap((bore) => Array.from({ length: 7 }, (_, i) => {
    const f = boreFrame(bore, 3.35 + i * 6);
    return at(f.x - 0.04, 3.92, f.z, [0, Math.atan2(f.tx, f.tz), 0]);
  })), false, true);
  farRoofs.receiveShadow = false;

  // ---- Posters and name boards on the empty track's wall --------------------
  // Every poster is a stack with real depth: a steel tray on the tiles, paper 15 mm proud of it,
  // glass 25 mm in front of the paper and a bevelled frame that laps the glass, on four fixings.
  const wallX = HALF - 0.015;
  const posterZ = [-6.4, -4.75, -1.65, 0, 1.65, 4.75, 6.4];
  const posterStyle = [3, 0, 1, 5, 2, 4, 0];
  const posters = [0, 1, 2, 3, 4, 5].map((style) => paper(posterTexture(style, style === 3 || style === 5 ? 2 : 1.5)));
  posterZ.forEach((z, i) => panel(1.4, 2.1, posters[posterStyle[i]], -(HALF - 0.055), 1.5, z, Math.PI / 2));
  instances(softBox(0.05, 2.22, 1.52, 0.012, 1.2), metals.darkMetal, posterZ.map((z) => at(-wallX, 1.5, z)), false, false);
  const nameBoard = enamel(signTexture(1024, 192, (context, text) => {
    context.fillStyle = "#d9861f"; context.fillRect(0, 0, 1024, 26); context.fillRect(0, 166, 1024, 26);
    text("T SPAWN", 512, 98, 104, "#f2efe6", "center", 800);
  }, "#12302e"));
  for (const side of sides) for (const z of [-5.6, 0, 5.6]) panel(2.5, 0.47, nameBoard, side * (HALF - 0.052), 2.78, z, -side * Math.PI / 2);
  instances(softBox(0.04, 0.53, 2.56, 0.012, 1.2), metals.brushed, sides.flatMap((side) => [-5.6, 0, 5.6].map((z) => at(side * wallX, 2.78, z))), false, false);
  // Battens under the cornice wash both track walls.
  const battenZ = [-6.6, -3.9, -1.2, 1.5, 4.2, 6.9];
  const batten = new THREE.CylinderGeometry(0.02, 0.02, 1.2, 8);
  batten.rotateX(Math.PI / 2);
  instances(batten, tubeGlow, sides.flatMap((side) => battenZ.filter((z) => !(side < 0 && z === 1.5)).map((z) => at(side * (HALF - 0.12), 3.64, z))), false, false);
  instances(batten, tubeFailing[0], [at(-(HALF - 0.12), 3.64, 1.5)], false, false);
  instances(softBox(0.1, 0.05, 1.3, 0.012, 1), creamPaint, sides.flatMap((side) => battenZ.map((z) => at(side * (HALF - 0.1), 3.69, z))), false, false);
  // Painted light lies on the tiles themselves, behind everything that hangs on them.
  const wash = sharp(washTexture());
  const washMaterial = new THREE.MeshBasicMaterial({ map: wash, color: TUBE.clone().multiplyScalar(0.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const washed = (width: number, height: number, x: number, y: number, z: number, turn: number) => {
    const mesh = panel(width, height, washMaterial, x, y, z, turn);
    mesh.renderOrder = 2;
    kit.mirrorHidden.push(mesh);
    return mesh;
  };
  for (const z of battenZ) if (z !== 1.5) washed(3.4, 3.2, -(HALF - 0.014), 2.0, z, Math.PI / 2);

  // ---- Edge trunking: the cold line along both platform edges ----------------
  const trunkX = EDGE + 0.2, trunkY = 3.62;
  // It runs into the walls at both ends: the range mounts an alarm bulkhead on its face hard by the head wall.
  instances(softBox(0.36, 0.42, platformLength + 0.1, 0.03, 1.6), greenPaint, sides.map((side) => at(side * trunkX, trunkY, platformMid)), false);
  instances(softBox(0.42, 0.05, platformLength + 0.1, 0.012, 1.6), metals.darkMetal, sides.map((side) => at(side * trunkX, trunkY - 0.22, platformMid)), false, false);
  const tubeZ = Array.from({ length: 10 }, (_, i) => HEAD_Z + 1.15 + i * 1.7);
  const tube = new THREE.CylinderGeometry(0.019, 0.019, 1.2, 8);
  tube.rotateX(Math.PI / 2);
  const tubeSpots = sides.flatMap((side) => tubeZ.flatMap((z) => [-0.07, 0.07].map((o) => ({ side, z, x: side * trunkX + o }))));
  const failing = (spot: { side: number; z: number }) => spot.side > 0 && spot.z === tubeZ[6];
  instances(tube, tubeGlow, tubeSpots.filter((spot) => !failing(spot)).map(({ x, z }) => at(x, trunkY - 0.27, z)), false, false);
  instances(tube, tubeFailing[1], tubeSpots.filter(failing).map(({ x, z }) => at(x, trunkY - 0.27, z)), false, false);
  instances(new THREE.BoxGeometry(0.2, 0.05, 0.05), creamPaint, sides.flatMap((side) => tubeZ.flatMap((z) => [-0.62, 0.62].map((o) => at(side * trunkX, trunkY - 0.265, z + o)))), false, false);
  hangers(sides.flatMap((side) => [-7.2, -3.58, 0.85, 5.28, 9.0].map((z): V3 => [side * trunkX, trunkY + 0.2, z])), 0.018);
  // Enamel way-finding plates on the platform face of the trunking.
  const wayPlate = (number: string, colour: string, towards: string, via: string, arrowLeft: boolean) => enamel(signTexture(1024, 128, (context, text) => {
    context.strokeStyle = "#5d6a68"; context.lineWidth = 3; context.strokeRect(5, 5, 1014, 118);
    bullet(context, arrowLeft ? 190 : 70, 64, 44, colour, number);
    text(towards, arrowLeft ? 256 : 136, 48, 54, "#f2efe6", "left", 800, 740);
    text(via, arrowLeft ? 256 : 136, 100, 26, "#b9c4c0", "left", 600, 740);
    context.strokeStyle = "#f2efe6"; context.lineWidth = 12; context.lineCap = "round"; context.lineJoin = "round";
    const x = arrowLeft ? 70 : 950, d = arrowLeft ? 1 : -1;
    context.beginPath(); context.moveTo(x + d * 44, 64); context.lineTo(x - d * 34, 64); context.moveTo(x - d * 4, 34); context.lineTo(x - d * 34, 64); context.lineTo(x - d * 4, 94); context.stroke();
  }, "#101a1c", 1, 2));
  const plateRight = wayPlate("B", "#e0902a", "B Site", "Platform 1  ·  via Upper Tunnels", false);
  const plateLeft = wayPlate("A", "#2aa39c", "A Site", "Platform 2  ·  via Catwalk and Long A", true);
  for (const z of [-4.9, 0.6, 6.6]) {
    panel(2.6, 0.325, plateRight, trunkX - 0.204, trunkY, z, -Math.PI / 2);
    panel(2.6, 0.325, plateLeft, -trunkX + 0.204, trunkY, z, Math.PI / 2);
  }
  instances(softBox(0.014, 0.355, 2.64, 0.005, 1), metals.darkMetal, sides.flatMap((side) => [-4.9, 0.6, 6.6].map((z) => at(side * (trunkX - 0.187), trunkY, z))), false, false);

  // ---- The stopped train ----------------------------------------------------
  // A two-car unit held at the signal: the leading cab stands just short of the tunnel mouth and
  // the rear car is still in the tunnel behind the back wall. Everything is authored in car
  // space (x across with -x toward the platform, z along with the cab at -z) and merged per
  // material, so the whole train is a few dozen draws.
  const HW = 1.4, FL = 0.06, SILL = -0.08, CANT = 2.42, HL = 8.4, CAB = -6.9, CAR_Z = 1.8;
  const car1 = [at(TRACK_X, 0, CAR_Z)], bothCars = [...car1, at(TRACK_X, 0, CAR_Z + HL * 2 + 0.6, [0, Math.PI, 0])];
  const inCar = (x: number, y: number, z: number, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => at(TRACK_X + x, y, CAR_Z + z, rotation, scale);
  const shell = batch(), panes = batch(), ext = batch(), inner = batch(), under = batch();
  const quarter = Math.PI / 2;
  const pipeX = (radius: number, length: number, segments = 8) => new THREE.CylinderGeometry(radius, radius, length, segments).rotateZ(quarter);
  const pipeZ = (radius: number, length: number, segments = 8) => new THREE.CylinderGeometry(radius, radius, length, segments).rotateX(quarter);

  type Hole = { z0: number; z1: number; y0: number; y1: number; r: number };
  const doorsZ = [-4.6, 0.6, 5.8];
  const windowsZ: Array<[number, number]> = [[-6.55, -5.65], [-3.55, -0.45], [1.65, 4.75], [6.85, 8.0]];
  const cabDoor = { z0: -8.0, z1: -7.35 };
  const sideHoles: Hole[] = [
    { ...cabDoor, y0: FL, y1: 2.0, r: 0.03 },
    ...doorsZ.map((d) => ({ z0: d - 0.7, z1: d + 0.7, y0: FL, y1: 2.06, r: 0.03 })),
    ...windowsZ.map(([z0, z1]) => ({ z0, z1, y0: 0.92, y1: 1.94, r: 0.1 })),
  ];
  /** A body-side panel on the plane |x| = face, pierced by the openings that fall inside it. */
  const sideWall = (z0: number, z1: number, y0: number, y1: number, thickness: number, side: number, face: number, metres: number) => {
    const s = (z: number) => (side < 0 ? -z : z);
    const shape = new THREE.Shape();
    const a = Math.min(s(z0), s(z1)), b = Math.max(s(z0), s(z1));
    shape.moveTo(a, y0); shape.lineTo(b, y0); shape.lineTo(b, y1); shape.lineTo(a, y1); shape.closePath();
    for (const hole of sideHoles) {
      if (hole.z1 <= z0 || hole.z0 >= z1) continue;
      const path = new THREE.Path();
      roundRect(path, Math.min(s(hole.z0), s(hole.z1)), hole.y0, Math.max(s(hole.z0), s(hole.z1)), hole.y1, hole.r);
      shape.holes.push(path);
    }
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 5 });
    geometry.rotateY(side < 0 ? quarter : -quarter);
    geometry.translate(side * face, 0, 0);
    return projectUv(geometry, metres);
  };
  /** Turn for something built in the XY plane (growing along +z) so it grows inward from a body side. */
  const inward = (side: number): V3 => [0, -side * quarter, 0];
  const outwardTurn = (side: number): V3 => [0, side * quarter, 0];

  // Body: sides, roof skin and both ends.
  const roofPoint = (t: number, inset: number) => new THREE.Vector2((HW - inset) * Math.cos(t), CANT + (0.36 - inset) * Math.pow(Math.max(0, Math.sin(t)), 0.75));
  const arc = (inset: number) => Array.from({ length: 29 }, (_, i) => roofPoint((i / 28) * Math.PI, inset));
  const roofSkin = new THREE.ExtrudeGeometry(new THREE.Shape([...arc(0), ...arc(0.05).reverse()]), { depth: HL * 2, bevelEnabled: false });
  roofSkin.translate(0, 0, -HL);
  shell.add(trainPaint, projectUv(roofSkin, 2.8));
  const section = () => new THREE.Shape([new THREE.Vector2(-HW, SILL), new THREE.Vector2(HW, SILL), ...arc(0)]);
  const nose = section();
  const screen = new THREE.Path(); roundRect(screen, -1.12, 1.08, 1.12, 2.1, 0.12); nose.holes.push(screen);
  shell.add(trainPaint, projectUv(new THREE.ExtrudeGeometry(nose, { depth: 0.08, bevelEnabled: false, curveSegments: 6 }), 2.8), 0, 0, -HL);
  const tail = section();
  const gangway = new THREE.Path(); roundRect(gangway, -0.42, FL, 0.42, 2.0, 0.03); tail.holes.push(gangway);
  shell.add(trainPaint, projectUv(new THREE.ExtrudeGeometry(tail, { depth: 0.08, bevelEnabled: false, curveSegments: 6 }), 2.8), 0, 0, HL - 0.08);
  const bandRuns: Array<[number, number]> = [[-HL, cabDoor.z0], [cabDoor.z1, -5.3], [-3.9, -0.1], [1.3, 5.1], [6.5, HL]];
  const windowRing = (width: number, height: number) => frameGeometry(width + 0.07, height + 0.07, 0.04, 0.026, 0.1);
  const leafWindow: [number, number, number, number] = [-0.2, 0.85, 0.2, 1.75];
  const doorLeaf = leafGeometry(0.69, 1.99, 0.035, leafWindow), cabLeaf = leafGeometry(0.64, 1.93, 0.035, [-0.2, 0.95, 0.2, 1.7]);
  for (const side of sides) {
    shell.add(trainPaint, sideWall(-HL, HL, SILL, CANT, 0.07, side, HW, 2.8));
    inner.add(lining, sideWall(CAB, HL - 0.08, 0, 2.2, 0.014, side, HW - 0.07, 2));
    // Saloon windows: rubber surround, glass, pillars and a hopper bar on the long ones.
    for (const [z0, z1] of windowsZ) {
      const mid = (z0 + z1) / 2, width = z1 - z0;
      ext.add(gasket, windowRing(width, 1.02), side * (HW + 0.008), 1.43, mid, inward(side));
      panes.add(glass, new THREE.PlaneGeometry(width, 1.02), side * (HW - 0.03), 1.43, mid, inward(side));
      if (width > 2) {
        for (const o of [-width / 6, width / 6]) ext.add(gasket, new THREE.BoxGeometry(0.03, 1.02, 0.045), side * (HW - 0.03), 1.43, mid + o);
        ext.add(gasket, new THREE.BoxGeometry(0.03, 0.03, width), side * (HW - 0.03), 1.7, mid);
      }
    }
    // Passenger doors: two leaves in a recess, glazed, with rubber edges, a header gutter and a tread plate.
    // (The leaves themselves are instanced one by one further down: the unit that runs slides its own open.)
    for (const d of doorsZ) {
      for (const edge of [-0.7, 0.7]) ext.add(gasket, new THREE.BoxGeometry(0.06, 2.0, 0.022), side * (HW - 0.035), FL + 1.0, d + edge);
      ext.add(trainSteel, new THREE.BoxGeometry(0.035, 0.025, 1.6), side * (HW + 0.014), 2.11, d);
      ext.add(metals.brushed, new THREE.BoxGeometry(0.16, 0.014, 1.4), side * (HW - 0.07), FL + 0.003, d);
      inner.add(poleYellow, new THREE.BoxGeometry(0.07, 0.008, 1.4), side * (HW - 0.2), FL + 0.004, d);
      ext.add(doorLamp, new THREE.SphereGeometry(0.03, 10, 8), side * (HW + 0.004), 2.2, d);
      ext.add(metals.brushed, pipeX(0.04, 0.02, 14), side * (HW + 0.006), 1.15, d + 0.84);
      ext.add(doorButton, pipeX(0.022, 0.03, 12), side * (HW + 0.008), 1.15, d + 0.84);
    }
    // Cab door with its handrails.
    const cabMid = (cabDoor.z0 + cabDoor.z1) / 2;
    ext.add(amberPaint, cabLeaf, side * (HW - 0.04), FL + 0.005, cabMid, inward(side));
    ext.add(gasket, frameGeometry(0.45, 0.8, 0.04, 0.012, 0.05), side * (HW - 0.036), FL + 1.33, cabMid, inward(side));
    panes.add(glass, new THREE.PlaneGeometry(0.42, 0.77), side * (HW - 0.058), FL + 1.33, cabMid, inward(side));
    for (const z of [cabDoor.z0 - 0.11, cabDoor.z1 + 0.11]) {
      ext.add(metals.brushed, new THREE.CylinderGeometry(0.013, 0.013, 1.0, 8), side * (HW + 0.04), 1.2, z);
      for (const y of [0.76, 1.64]) ext.add(metals.brushed, new THREE.BoxGeometry(0.04, 0.018, 0.018), side * (HW + 0.02), y, z);
    }
    ext.add(metals.brushed, new THREE.BoxGeometry(0.03, 0.1, 0.02), side * (HW - 0.02), 1.05, cabDoor.z1 - 0.07);
    // Livery, beads, gutter and solebar.
    for (const [z0, z1] of bandRuns) {
      ext.add(amberPaint, new THREE.BoxGeometry(0.008, 0.13, z1 - z0), side * (HW + 0.003), 0.78, (z0 + z1) / 2);
      for (const y of [0.3, 0.42, 0.54]) ext.add(trainSteel, new THREE.BoxGeometry(0.02, 0.028, z1 - z0 - 0.04), side * (HW + 0.004), y, (z0 + z1) / 2);
    }
    ext.add(trainSteel, new THREE.BoxGeometry(0.04, 0.03, HL * 2 - 0.1), side * (HW + 0.01), CANT - 0.03, 0);
    ext.add(metals.structural, softBox(0.09, 0.26, HL * 2 - 0.2, 0.02, 1.4), side * (HW - 0.05), SILL - 0.13, 0);
    // Destination blind and the car number.
    ext.add(gasket, new THREE.BoxGeometry(0.02, 0.2, 1.3), side * (HW + 0.004), 2.2, 3.2);
    ext.add(gasket, new THREE.BoxGeometry(0.012, 0.19, 0.45), side * (HW + 0.004), 1.3, -6.95);
    // Inside: cove with advert cards and the line diagram over each door, kick panels, draught screens.
    const tilt: V3 = [0, 0, side * 0.993];
    const cove = (geometry: THREE.PlaneGeometry) => geometry.rotateY(-side * quarter);
    inner.add(lining, cove(new THREE.PlaneGeometry(HL - 0.1 - CAB, 0.513)), side * 1.115, 2.1, (HL - 0.1 + CAB) / 2, tilt);
    windowsZ.forEach(([z0, z1], i) => {
      const cards = Math.max(1, Math.round((z1 - z0) / 0.75));
      inner.add(adverts, uvRange(cove(new THREE.PlaneGeometry(z1 - z0, 0.3)), (i * 3 + (side > 0 ? 1 : 0)) / 8, (i * 3 + (side > 0 ? 1 : 0) + cards) / 8), side * 1.104, 2.09, (z0 + z1) / 2, tilt);
    });
    for (const d of doorsZ) inner.add(diagram, cove(new THREE.PlaneGeometry(1.36, 0.17)), side * 1.104, 2.09, d, tilt);
    for (const [z0, z1] of [[CAB, -5.3], [-3.9, -0.1], [1.3, 5.1], [6.5, HL - 0.1]]) inner.add(seatShell, new THREE.BoxGeometry(0.012, 0.46, z1 - z0), side * (HW - 0.09), FL + 0.23, (z0 + z1) / 2);
    for (const d of doorsZ) for (const edge of [-0.75, 0.75]) {
      inner.add(seatShell, softBox(0.55, 0.7, 0.03, 0.01, 1), side * 1.04, FL + 0.37, d + edge);
      panes.add(glass, new THREE.PlaneGeometry(0.55, 1.0), side * 1.04, FL + 1.24, d + edge);
      inner.add(poleYellow, new THREE.CylinderGeometry(0.017, 0.017, 2.19, 10), side * 0.765, FL + 1.095, d + edge);
      inner.add(poleYellow, pipeX(0.014, 0.55), side * 1.04, FL + 1.75, d + edge);
    }
    // Ceiling light strip, the overhead rail and its droppers.
    inner.add(saloonGlow, new THREE.BoxGeometry(0.13, 0.016, 15.0), side * 0.5, 2.236, 0.7);
    inner.add(poleYellow, pipeZ(0.016, 14.8), side * 0.52, 2.0, 0.7);
    for (let i = 0; i < 9; i += 1) inner.add(poleYellow, new THREE.CylinderGeometry(0.012, 0.012, 0.25, 6), side * 0.52, 2.125, -6.5 + i * 1.8);
  }
  // Floor, ceiling and the vestibule poles.
  inner.add(trainFloor, worldBox(HW * 2 - 0.14, 0.04, HL * 2 - 0.16, 1.5), 0, FL - 0.02, 0);
  inner.add(lining, worldBox(1.84, 0.02, HL * 2 - 0.16, 2), 0, 2.25, 0);
  inner.add(gasket, new THREE.BoxGeometry(0.26, 0.01, 15.0), 0, 2.238, 0.7);
  for (const d of doorsZ) inner.add(poleYellow, new THREE.CylinderGeometry(0.019, 0.019, 2.19, 10), 0, FL + 1.095, d);
  // Cab bulkhead with its door and window; gangway door at the other end.
  const bulkhead = new THREE.Shape();
  bulkhead.moveTo(-1.33, 0); bulkhead.lineTo(1.33, 0); bulkhead.lineTo(1.33, 2.26); bulkhead.lineTo(-1.33, 2.26); bulkhead.closePath();
  const cabDoorway = new THREE.Path(); roundRect(cabDoorway, 0.3, FL, 1.0, 1.98, 0.03); bulkhead.holes.push(cabDoorway);
  const cabWindow = new THREE.Path(); roundRect(cabWindow, -1.0, 1.05, -0.2, 1.8, 0.06); bulkhead.holes.push(cabWindow);
  inner.add(lining, projectUv(new THREE.ExtrudeGeometry(bulkhead, { depth: 0.04, bevelEnabled: false, curveSegments: 4 }), 2), 0, 0, CAB - 0.02);
  inner.add(seatShell, softBox(0.68, 1.9, 0.026, 0.01, 1), 0.65, FL + 0.96, CAB);
  inner.add(inMetal, new THREE.BoxGeometry(0.03, 0.12, 0.05), 0.4, 1.05, CAB + 0.03);
  panes.add(glass, new THREE.PlaneGeometry(0.8, 0.75), -0.6, 1.425, CAB);
  inner.add(redPaint, new THREE.CylinderGeometry(0.055, 0.055, 0.36, 12), -1.15, FL + 0.3, CAB + 0.12);
  inner.add(gasket, new THREE.CylinderGeometry(0.02, 0.03, 0.08, 8), -1.15, FL + 0.52, CAB + 0.12);
  ext.add(amberPaint, leafGeometry(0.82, 1.93, 0.03, [-0.2, 0.9, 0.2, 1.75]), 0, FL + 0.005, HL - 0.07);
  panes.add(glass, new THREE.PlaneGeometry(0.42, 0.87), 0, FL + 1.33, HL - 0.05);
  for (const o of [-0.24, -0.12, 0, 0.12, 0.24]) ext.add(rubber, softBox(2.36, 2.36, 0.085, 0.05, 1), 0, 1.3, HL + 0.3 + o);
  ext.add(gasket, softBox(2.2, 2.2, 0.62, 0.05, 1), 0, 1.3, HL + 0.3);

  // Seats: transverse pairs in facing bays, each a moulded shell on a pedestal with moquette pads.
  const seat = batch();
  const shellGeometry = seatShellGeometry(0.44);
  for (const x of [-0.235, 0.235]) {
    seat.add(seatShell, shellGeometry, x, 0, 0);
    seat.add(moquette, softBox(0.39, 0.045, 0.31, 0.02, 0.22), x, 0.478, 0.3, [-0.03, 0, 0]);
    seat.add(moquette, softBox(0.39, 0.42, 0.04, 0.018, 0.22), x, 0.8, 0.092, [-0.085, 0, 0]);
  }
  seat.add(inMetal, softBox(0.9, 0.05, 0.07, 0.012, 1), 0, 0.39, 0.3);
  seat.add(inMetal, softBox(0.07, 0.36, 0.26, 0.015, 1), 0, 0.19, 0.3);
  seat.add(inMetal, new THREE.BoxGeometry(0.3, 0.012, 0.36), 0, 0.006, 0.3);
  seat.add(inMetal, new THREE.BoxGeometry(0.9, 0.03, 0.012), 0, 1.08, 0.022);
  const bayBacks: Array<[number, number]> = [[-1.45, 0], [-0.05, Math.PI], [0.05, 0], [1.45, Math.PI]];
  const seatSpots: Array<{ side: number; z: number; turn: number }> = sides.flatMap((side) => [
    ...[-2.0, 3.2].flatMap((bay) => bayBacks.map(([o, turn]) => ({ side, z: bay + o, turn }))),
    { side, z: -6.82, turn: 0 }, { side, z: 6.62, turn: 0 }, { side, z: 8.24, turn: Math.PI },
  ]);
  seat.build(seatSpots.map(({ side, z, turn }) => inCar(side * 0.85, FL, z, [0, turn, 0])), false, false, true);
  const grab = new THREE.TorusGeometry(0.06, 0.011, 6, 14, Math.PI);
  kit.mirrorHidden.push(instances(grab, poleYellow, seatSpots.map(({ side, z, turn }) => inCar(side * 0.46, FL + 1.085, z + (turn ? -0.022 : 0.022))), false, false));
  if (high) {
    // Hanging straps along both rails, each swung a little differently.
    const sway = rng(733);
    const strapZ = [...doorsZ.flatMap((d) => [-0.5, -0.17, 0.17, 0.5].map((o) => d + o)), -2.9, -2.0, -1.1, 2.3, 3.2, 4.1, 7.1, 7.7];
    const straps = sides.flatMap((side) => strapZ.map((z) => inCar(side * 0.52, 1.984, z, [(sway() - 0.5) * 0.3, 0, (sway() - 0.5) * 0.16])));
    const strap = new THREE.BoxGeometry(0.024, 0.15, 0.005).translate(0, -0.075, 0);
    const loop = new THREE.TorusGeometry(0.043, 0.009, 6, 14).rotateY(quarter).translate(0, -0.19, 0);
    kit.mirrorHidden.push(instances(strap, gasket, straps, false, false), instances(loop, lining, straps, false, false));
  }

  // Cab: desk under the windscreen, the driver's seat, and the front end.
  const desk = new THREE.Shape([[-8.3, FL], [-7.95, FL], [-7.95, 0.7], [-7.7, 0.82], [-7.7, 0.9], [-8.3, 1.04]].map(([z, y]) => new THREE.Vector2(z, y)));
  inner.add(metals.machine, projectUv(new THREE.ExtrudeGeometry(desk, { depth: 1.7, bevelEnabled: false }).rotateY(-quarter), 1.4), 0.4, 0, 0);
  inner.add(consoleFace, new THREE.PlaneGeometry(1.6, 0.58).rotateX(-quarter), -0.45, 0.984, -8.0, [0.229, 0, 0]);
  for (const [x, lean] of [[-1.02, -0.5], [0.02, 0.35]]) {
    inner.add(inMetal, new THREE.CylinderGeometry(0.05, 0.06, 0.04, 14), x, 0.94, -7.82);
    inner.add(inMetal, new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8).translate(0, 0.08, 0), x, 0.95, -7.82, [lean, 0, 0]);
    inner.add(gasket, new THREE.SphereGeometry(0.03, 10, 8).translate(0, 0.17, 0), x, 0.95, -7.82, [lean, 0, 0]);
  }
  inner.add(gasket, softBox(0.34, 0.24, 0.04, 0.012, 1), 0.1, 1.2, -8.2, [0.2, -0.3, 0]);
  inner.add(cabScreen, new THREE.PlaneGeometry(0.3, 0.2), 0.106, 1.2, -8.179, [0.2, -0.3, 0]);
  const driver = { x: -0.45, z: -7.32 };
  inner.add(inMetal, new THREE.CylinderGeometry(0.2, 0.22, 0.03, 16), driver.x, FL + 0.015, driver.z);
  inner.add(inMetal, new THREE.CylinderGeometry(0.045, 0.045, 0.4, 10), driver.x, FL + 0.22, driver.z);
  inner.add(moquette, softBox(0.48, 0.1, 0.46, 0.035, 0.22), driver.x, FL + 0.47, driver.z);
  inner.add(moquette, softBox(0.46, 0.62, 0.09, 0.035, 0.22), driver.x, FL + 0.86, driver.z + 0.24, [0.14, 0, 0]);
  inner.add(gasket, softBox(0.26, 0.17, 0.08, 0.03, 1), driver.x, FL + 1.26, driver.z + 0.3, [0.14, 0, 0]);
  for (const o of [-0.27, 0.27]) inner.add(gasket, softBox(0.05, 0.04, 0.3, 0.012, 1), driver.x + o, FL + 0.68, driver.z + 0.06);
  // Front end: warning panel, glazing, lamps, blind, anti-climber, coupler and hoses.
  ext.add(amberPaint, new THREE.BoxGeometry(2.76, 0.86, 0.012), 0, 0.5, -HL - 0.006);
  ext.add(gasket, frameGeometry(2.3, 1.08, 0.04, 0.026, 0.13), 0, 1.59, -HL - 0.01);
  panes.add(glass, new THREE.PlaneGeometry(2.24, 1.02), 0, 1.59, -HL + 0.03);
  ext.add(gasket, new THREE.BoxGeometry(0.06, 1.02, 0.06), 0, 1.59, -HL + 0.03);
  for (const side of sides) {
    ext.add(gasket, softBox(0.46, 0.2, 0.05, 0.02, 1), side * 0.93, 0.62, -HL - 0.02);
    ext.add(headGlow, pipeZ(0.07, 0.03, 16), side * 1.02, 0.62, -HL - 0.04);
    ext.add(tailLens, pipeZ(0.05, 0.03, 14), side * 0.83, 0.62, -HL - 0.04);
    ext.add(metals.brushed, new THREE.TorusGeometry(0.075, 0.01, 6, 18), side * 1.02, 0.62, -HL - 0.05);
    ext.add(metals.brushed, new THREE.CylinderGeometry(0.013, 0.013, 0.9, 8), side * 1.27, 1.5, -HL - 0.045);
    for (const y of [1.1, 1.9]) ext.add(metals.brushed, new THREE.BoxGeometry(0.018, 0.018, 0.045), side * 1.27, y, -HL - 0.022);
    ext.add(gasket, new THREE.BoxGeometry(0.02, 0.62, 0.012).translate(0, 0.31, 0), side * 0.55, 1.1, -HL - 0.03, [0, 0, side * 0.5]);
    ext.add(metals.structural, new THREE.BoxGeometry(0.06, 0.5, 0.3), side * 0.72, -0.62, -HL + 0.35, [0.3, 0, 0]);
  }
  ext.add(gasket, new THREE.BoxGeometry(1.1, 0.2, 0.02), 0, 2.27, -HL - 0.004);
  ext.add(metals.darkMetal, softBox(2.6, 0.2, 0.16, 0.03, 1.2), 0, -0.2, -HL - 0.04);
  for (const y of [-0.26, -0.2, -0.14]) ext.add(metals.structural, new THREE.BoxGeometry(2.3, 0.022, 0.07), 0, y, -HL - 0.14);
  ext.add(metals.structural, pipeZ(0.07, 0.6, 12), 0, -0.47, -HL - 0.2);
  ext.add(metals.darkMetal, softBox(0.34, 0.28, 0.2, 0.04, 1), 0, -0.47, -HL - 0.56);
  ext.add(metals.brushed, new THREE.CylinderGeometry(0.11, 0.06, 0.1, 14).rotateX(-quarter), 0.07, -0.47, -HL - 0.7);
  ext.add(gasket, new THREE.CylinderGeometry(0.05, 0.05, 0.06, 12).rotateX(quarter), -0.09, -0.47, -HL - 0.68);
  for (const side of sides) {
    const hose = new THREE.CatmullRomCurve3([[side * 0.55, -0.3, -HL - 0.1], [side * 0.5, -0.62, -HL - 0.24], [side * 0.3, -0.66, -HL - 0.46], [side * 0.17, -0.5, -HL - 0.56]].map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    ext.add(rubber, new THREE.TubeGeometry(hose, 14, 0.022, 6));
    ext.add(redPaint, pipeZ(0.03, 0.08, 8), side * 0.55, -0.3, -HL - 0.1);
  }
  // Roof: ventilator pods with louvred sides.
  for (const z of [-5.1, -1.6, 2.4, 5.9]) {
    ext.add(metals.structural, softBox(1.3, 0.14, 1.9, 0.05, 1.6), 0, CANT + 0.4, z);
    for (const side of sides) for (let i = 0; i < 3; i += 1) ext.add(gasket, new THREE.BoxGeometry(0.02, 0.016, 1.6), side * 0.655, CANT + 0.36 + i * 0.035, z);
  }

  // Underframe: centre sill, equipment cases, air reservoirs and the two bogies.
  under.add(metals.darkMetal, worldBox(2.5, 0.12, HL * 2 - 0.4, 1.4), 0, SILL - 0.06, 0);
  const cases: Array<[number, number, number, number, number]> = [
    [-0.92, 0.72, 0.5, 1.6, -2.7], [-0.92, 0.72, 0.42, 1.1, -1.1], [-0.92, 0.72, 0.5, 1.9, 0.75], [-0.95, 0.62, 0.36, 0.9, 2.5],
    [0.92, 0.72, 0.5, 2.2, -2.3], [0.92, 0.72, 0.4, 1.3, 0], [0.95, 0.62, 0.5, 1.5, 1.9],
  ];
  for (const [x, w, h, l, z] of cases) {
    under.add(plate, softBox(w, h, l, 0.03, 1.2), x, SILL - 0.12 - h / 2, z);
    for (let i = 0; i < 4; i += 1) under.add(gasket, new THREE.BoxGeometry(0.02, 0.02, l * 0.6), x + Math.sign(x) * (w / 2 + 0.004), SILL - 0.2 - i * 0.06, z);
    under.add(metals.brushed, new THREE.BoxGeometry(0.02, 0.06, 0.03), x + Math.sign(x) * (w / 2 + 0.006), SILL - 0.12 - h + 0.08, z + l * 0.4);
  }
  for (const z of [-1.5, 1.5]) under.add(metals.structural, pipeZ(0.16, 1.5, 16), 0.05, SILL - 0.32, z);
  for (const x of [-0.3, 0.38]) under.add(rubber, pipeZ(0.03, 7.4), x, SILL - 0.16, 0);
  const axleY = PIT + 0.275 + 0.42;
  const wheel = new THREE.LatheGeometry([[0.06, -0.08], [0.13, -0.08], [0.14, -0.03], [0.34, -0.02], [0.36, -0.065], [0.42, -0.065], [0.42, 0.04], [0.45, 0.045], [0.45, 0.065], [0.36, 0.065], [0.34, 0.02], [0.14, 0.03], [0.13, 0.08], [0.06, 0.08]].map(([x, y]) => new THREE.Vector2(x, y)), 32);
  const sideFrame = new THREE.Shape([[-1.3, 0.3], [-1.3, 0.16], [-0.6, 0.16], [-0.45, -0.12], [0.45, -0.12], [0.6, 0.16], [1.3, 0.16], [1.3, 0.3], [0.7, 0.3], [0.52, 0.06], [-0.52, 0.06], [-0.7, 0.3]].map(([z, y]) => new THREE.Vector2(z, y)));
  const sideFrameGeometry = projectUv(new THREE.ExtrudeGeometry(sideFrame, { depth: 0.1, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1 }).translate(0, 0, -0.05).rotateY(-quarter), 1.2);
  const spring = high ? coilGeometry(0.065, 0.18, 4, 0.014) : new THREE.CylinderGeometry(0.07, 0.07, 0.18, 8).translate(0, 0.09, 0);
  for (const bogie of [-5.6, 5.6]) {
    for (const w of [-0.95, 0.95]) {
      under.add(metals.structural, pipeX(0.075, 2.2, 12), 0, axleY, bogie + w);
      under.add(rust, pipeX(0.24, 0.7, 16), 0.1, axleY + 0.02, bogie + w - Math.sign(w) * 0.42);
      for (const side of sides) {
        under.add(metals.structural, wheel, side * 0.7175, axleY, bogie + w, [0, 0, side * quarter]);
        under.add(rust, softBox(0.2, 0.2, 0.22, 0.03, 1), side * 1.02, axleY, bogie + w);
        under.add(metals.structural, pipeX(0.085, 0.05, 14), side * 1.13, axleY, bogie + w);
        under.add(rust, new THREE.BoxGeometry(0.16, 0.03, 0.6), side * 1.02, axleY - 0.035, bogie + w);
        for (const o of [-0.2, 0.2]) under.add(springSteel, spring, side * 1.02, axleY - 0.02, bogie + w + o);
        under.add(rust, softBox(0.14, 0.2, 0.18, 0.02, 1), side * 0.7175, axleY + 0.02, bogie + w - Math.sign(w) * 0.52);
      }
    }
    for (const side of sides) {
      under.add(rust, sideFrameGeometry, side * 1.02, axleY, bogie);
      under.add(rubber, new THREE.CylinderGeometry(0.2, 0.23, 0.16, 16), side * 0.82, axleY + 0.24, bogie);
      under.add(metals.darkMetal, new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), side * 1.12, axleY + 0.1, bogie + 0.3, [0.9, 0, 0]);
    }
    for (const o of [-0.3, 0.3]) under.add(rust, softBox(2.0, 0.14, 0.16, 0.02, 1.2), 0, axleY - 0.03, bogie + o);
    under.add(rust, softBox(2.3, 0.1, 0.5, 0.02, 1.2), 0, axleY + 0.13, bogie);
    // Shoe gear reaching for the conductor rail.
    under.add(wood, softBox(0.07, 0.1, 1.5, 0.012, 0.9), 1.24, axleY - 0.2, bogie);
    under.add(metals.structural, new THREE.BoxGeometry(0.3, 0.04, 0.34), 1.43, axleY + 0.14 - 0.375, bogie);
  }
  // Blinds and number plates are the only things that tell the two units apart.
  const marked = (target: ReturnType<typeof batch>, blindFace: THREE.Material, plate: THREE.Material) => {
    for (const side of sides) {
      target.add(blindFace, new THREE.PlaneGeometry(1.22, 0.14), side * (HW + 0.026), 2.2, 3.2, outwardTurn(side));
      target.add(plate, new THREE.PlaneGeometry(0.42, 0.158), side * (HW + 0.02), 1.3, -6.95, outwardTurn(side));
    }
    target.add(blindFace, new THREE.PlaneGeometry(1.0, 0.13).rotateY(Math.PI), 0, 2.27, -HL - 0.026);
  };
  const marks = batch(), marksA = batch();
  marked(marks, blind, carPlate);
  marked(marksA, blindA, carPlateA);
  // A door leaf, authored about its own foot with the outer face at z = 0: paint, rubber, kick plate, glass and notice.
  const leaf = batch(), leafGlass = batch();
  leaf.add(amberPaint, doorLeaf);
  leaf.add(gasket, frameGeometry(0.45, 0.95, 0.04, 0.012, 0.05), 0, 1.3, -0.004);
  for (const edge of [-0.3415, 0.3415]) leaf.add(gasket, new THREE.BoxGeometry(0.017, 1.99, 0.03), edge, 0.995, 0.006);
  leaf.add(trainSteel, new THREE.BoxGeometry(0.6, 0.3, 0.012), 0, 0.185, -0.006);
  leafGlass.add(glass, new THREE.PlaneGeometry(0.42, 0.92), 0, 1.3, 0.018);
  const noticeGeometry = new THREE.PlaneGeometry(0.36, 0.135).rotateY(Math.PI).translate(0, 0.995, 0.012);
  /** Leaves of one car in a fixed order: per side, per doorway, the leaf that opens toward -z and then its partner. */
  const leafSlots = sides.flatMap((side) => doorsZ.flatMap((d) => [-1, 1].map((way) => ({ side, way, z: d + way * 0.35 }))));
  const leafLocal = leafSlots.map(({ side, z }) => new THREE.Matrix4().makeRotationY(-side * quarter).setPosition(side * (HW - 0.04), FL + 0.005, z));

  // The same stock works the other road as a second unit (see the A Site train): its two cars are two
  // more instances of every batch, parked out of the world and left undrawn until it is due.
  type Rolling = { mesh: THREE.InstancedMesh; held: number; per: number; centre: THREE.Vector3; radius: number };
  const rolling: Rolling[] = [];
  const PARKED = at(0, -200, 0);
  const withUnit = (held: Transform[], per = 1) => [...held, ...Array.from({ length: per * 2 }, () => PARKED)];
  const roll = (meshes: THREE.InstancedMesh[], held: number, per = 1) => {
    for (const mesh of meshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = held;
      mesh.computeBoundingSphere();
      rolling.push({ mesh, held, per, centre: mesh.boundingSphere!.center.clone(), radius: mesh.boundingSphere!.radius });
    }
    return meshes;
  };
  roll(shell.build(withUnit(bothCars), true, true), 2);
  for (const mesh of roll(panes.build(withUnit(bothCars), true, false), 2)) mesh.renderOrder = 4;
  const bodywork = roll(ext.build(withUnit(car1), false, false), 1);
  roll(inner.build(withUnit(car1), false, false, true), 1);
  under.build(car1, false, false, true);
  // Under the unit that runs, the same underframe in outline: it is only ever seen moving, or down in the dark of the far road.
  const underLite = batch();
  underLite.add(metals.darkMetal, new THREE.BoxGeometry(2.5, 0.12, HL * 2 - 0.4), 0, SILL - 0.06, 0);
  for (const [x, w, h, l, z] of cases) underLite.add(plate, new THREE.BoxGeometry(w, h, l), x, SILL - 0.12 - h / 2, z);
  for (const bogie of [-5.6, 5.6]) {
    for (const w of [-0.95, 0.95]) {
      underLite.add(metals.structural, pipeX(0.075, 2.2, 8), 0, axleY, bogie + w);
      for (const side of sides) {
        underLite.add(metals.structural, pipeX(0.45, 0.13, 18), side * 0.7175, axleY, bogie + w);
        underLite.add(rust, new THREE.BoxGeometry(0.2, 0.2, 0.22), side * 1.02, axleY, bogie + w);
      }
    }
    for (const side of sides) underLite.add(rust, new THREE.BoxGeometry(0.1, 0.2, 2.6), side * 1.02, axleY + 0.14, bogie);
    underLite.add(rust, new THREE.BoxGeometry(2.3, 0.14, 0.5), 0, axleY + 0.11, bogie);
  }
  roll(underLite.build(withUnit([]), false, false, true), 0);
  marks.build(car1, false, false);
  roll(marksA.build(withUnit([]), false, false), 0);
  const leafSpots = withUnit(leafSlots.map(({ side, z }) => inCar(side * (HW - 0.04), FL + 0.005, z, inward(side))), leafSlots.length);
  const leafMeshes = roll(leaf.build(leafSpots, false, false), leafSlots.length, leafSlots.length);
  for (const mesh of roll(leafGlass.build(leafSpots, false, false), leafSlots.length, leafSlots.length)) { mesh.renderOrder = 4; leafMeshes.push(mesh); }
  const noteMeshes = roll([stuckNotice, quietNotice].map((notice, i) => instances(noticeGeometry, notice, withUnit(leafSlots.filter((_, slot) => slot % 2 === i).map(({ side, z }) => inCar(side * (HW - 0.04), FL + 0.005, z, inward(side))), leafSlots.length / 2), false, false)), leafSlots.length / 2, leafSlots.length / 2);
  // The unit's rear cab shows tail lamps where the leading one shows headlamps.
  const cabLamps = bodywork.find((mesh) => mesh.material === headGlow)!;
  [[1, 1, 1], [1, 1, 1], [1, 0.05, 0.03]].forEach(([r, g, b], i) => cabLamps.setColorAt(i, new THREE.Color(r, g, b)));
  // Headlamp bloom and the pool they throw toward the tunnel mouth.
  const flare = sharp(softDiscTexture());
  const flareMaterial = new THREE.MeshBasicMaterial({ map: flare, color: new THREE.Color(1, 0.94, 0.8).multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const noseZ = CAR_Z - HL;
  for (const side of sides) panel(0.55, 0.55, flareMaterial, TRACK_X + side * 1.02, 0.62, noseZ - 0.07, Math.PI).renderOrder = 5;
  const beam = place(new THREE.Mesh(new THREE.PlaneGeometry(3.2, 6).rotateX(-quarter), new THREE.MeshBasicMaterial({ map: flare, color: new THREE.Color(1, 0.9, 0.7).multiplyScalar(0.16), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })), TRACK_X, PIT + 0.22, noseZ - 2.6, false);
  beam.receiveShadow = false;
  beam.renderOrder = 1;
  kit.mirrorHidden.push(beam);

  // ---- Pendants ------------------------------------------------------------
  const lampY = 6.1, lampX = 3.4;
  const lampZ = [7, 1, -5, -11, -17, -23];
  const lamps = lampZ.flatMap((z) => sides.map((side) => ({ x: side * lampX, z })));
  const dead = (lamp: { x: number; z: number }) => lamp.x < 0 && lamp.z === -17;
  const shade = new THREE.LatheGeometry([[0.06, 0.5], [0.07, 0.4], [0.16, 0.33], [0.3, 0.16], [0.4, 0.02], [0.41, 0]].map(([x, y]) => new THREE.Vector2(x, y)), 24);
  instances(shade, new THREE.MeshStandardMaterial({ color: 0x23211e, roughness: 0.45, metalness: 0.8, side: THREE.DoubleSide, envMapIntensity: 0.9 }), lamps.map(({ x, z }) => at(x, lampY, z)), false);
  const lens = new THREE.CircleGeometry(0.36, 24);
  lens.rotateX(Math.PI / 2);
  instances(lens, sodiumGlow, lamps.filter((lamp) => !dead(lamp)).map(({ x, z }) => at(x, lampY + 0.05, z)), false, false);
  instances(lens, sodiumFailing, lamps.filter(dead).map(({ x, z }) => at(x, lampY + 0.05, z)), false, false);
  instances(softBox(0.16, 0.22, 0.16, 0.03, 1), metals.darkMetal, lamps.map(({ x, z }) => at(x, lampY + 0.6, z)), false, false);
  hangers(lamps.map(({ x, z }): V3 => [x, lampY + 0.7, z]), 0.016);
  // Conduit feeding each row.
  const conduit = new THREE.CylinderGeometry(0.022, 0.022, 31.4, 8);
  conduit.rotateX(Math.PI / 2);
  instances(conduit, galvanised, sides.map((side) => at(side * (lampX + 0.06), vaultY(lampX) - 0.06, -8)), false, false);

  // ---- Hanging signs --------------------------------------------------------
  const lightbox = lit(signTexture(1024, 192, (context, text) => {
    bullet(context, 86, 96, 58, "#e0902a", "B");
    text("B Site", 168, 70, 62, "#f2efe6", "left", 800);
    text("Platform 1  →", 168, 138, 36, "#b9c4c0", "left", 600);
    context.fillStyle = "#3a4a4a"; context.fillRect(540, 30, 3, 132);
    bullet(context, 628, 96, 58, "#2aa39c", "A");
    text("A Site", 710, 70, 62, "#f2efe6", "left", 800);
    text("←  Platform 2", 710, 138, 36, "#b9c4c0", "left", 600);
  }, "#0d1a1c", 0, 2), 1.15);
  const exitBox = lit(signTexture(1024, 192, (context, text) => {
    context.fillStyle = "#e9c21f"; context.fillRect(0, 0, 250, 192);
    text("EXIT", 125, 100, 78, "#14110c", "center", 900);
    text("Buy Zone", 290, 66, 60, "#f2efe6", "left", 800);
    text("Tickets  ·  Kits  ·  Lifts  ↑", 290, 136, 34, "#b9c4c0", "left", 600);
  }, "#0d1a1c", 0, 2), 1.15);
  const hung: Array<{ x: number; y: number; z: number; material: THREE.Material }> = [
    { x: -3.6, y: 4.75, z: 2.4, material: lightbox }, { x: 0, y: 5.35, z: -14.4, material: exitBox },
  ];
  instances(softBox(3.5, 0.72, 0.16, 0.03, 1.4), metals.darkMetal, hung.map(({ x, y, z }) => at(x, y, z)), false);
  for (const { x, y, z, material } of hung) {
    panel(3.36, 0.63, material, x, y, z + 0.092, 0);
    panel(3.36, 0.63, material, x, y, z - 0.092, Math.PI);
  }
  // Departure board: amber dot matrix. The first two rows are held on a fault; the third counts the A Site train in.
  const board = { x: 3.6, y: 4.75, z: 2.4 };
  const boardFace = lit(ledTexture([["B Tunnels", "RUSHING"], ["Mid Doors", "HELD (AWP)"], ["A Site", ""]], 2), 1.6);
  instances(softBox(3.3, 0.92, 0.2, 0.03, 1.4), metals.darkMetal, [at(board.x, board.y, board.z)], false);
  panel(3.12, 0.78, boardFace, board.x, board.y, board.z + 0.112, 0);
  panel(3.12, 0.78, boardFace, board.x, board.y, board.z - 0.112, Math.PI);
  // Its live cell is a canvas of its own laid over both faces, cut on the board's dot grid so the two never part.
  const CELL = { x: 516, y: 168, width: 504, height: 78 };
  const cellTexture = canvasTexture(CELL.width * 2, CELL.height * 2, () => undefined);
  const cellContext = (cellTexture.image as HTMLCanvasElement).getContext("2d")!;
  const showOnBoard = (value: string) => {
    cellContext.setTransform(2, 0, 0, 2, 0, 0);
    cellContext.fillStyle = "#070605"; cellContext.fillRect(0, 0, CELL.width, CELL.height);
    cellContext.font = `700 54px "Courier New", Menlo, monospace`; cellContext.textBaseline = "middle"; cellContext.textAlign = "right";
    cellContext.fillStyle = "#ff9a24"; cellContext.fillText(value, 990 - CELL.x, 206 - CELL.y);
    cellContext.fillStyle = "#070605";
    for (let x = 0; x < CELL.width; x += 6) cellContext.fillRect(x, 0, 2, CELL.height);
    for (let y = 0; y < CELL.height; y += 6) cellContext.fillRect(0, y, CELL.width, 2);
    cellTexture.needsUpdate = true;
  };
  showOnBoard("");
  {
    const metre = 3.12 / 1024, wide = CELL.width * metre, tall = CELL.height * metre;
    const x = (CELL.x + CELL.width / 2 - 512) * metre, y = (128 - CELL.y - CELL.height / 2) * metre;
    const cell = place(new THREE.Mesh(mergeGeometries([
      new THREE.PlaneGeometry(wide, tall).translate(x, y, 0.115), new THREE.PlaneGeometry(wide, tall).rotateY(Math.PI).translate(-x, y, -0.115),
    ]), lit(cellTexture, 1.6)), board.x, board.y, board.z, false);
    cell.receiveShadow = false;
  }
  // Bezels lap every lit face so no edge of a face is ever seen floating.
  const bezels = batch();
  for (const face of [1, -1]) {
    for (const { x, y, z } of hung) bezels.add(metals.brushed, frameGeometry(3.44, 0.69, 0.045, 0.03, 0.004), x, y, z + face * 0.078, [0, face > 0 ? 0 : Math.PI, 0]);
    bezels.add(metals.brushed, frameGeometry(3.2, 0.86, 0.045, 0.03, 0.004), board.x, board.y, board.z + face * 0.098, [0, face > 0 ? 0 : Math.PI, 0]);
  }
  bezels.build(HERE);
  hangers([...hung, board].flatMap(({ x, y, z }) => [-1.4, 1.4].map((o): V3 => [x + o, y + 0.36, z])), 0.018);

  // ---- End wall: station name and clock --------------------------------------
  const nameFrieze = enamel(signTexture(2048, 192, (context, text) => {
    context.fillStyle = "#d9861f"; context.fillRect(0, 0, 2048, 20); context.fillRect(0, 172, 2048, 20);
    (context as Context & { letterSpacing: string }).letterSpacing = "26px";
    text("T SPAWN", 1024, 100, 118, "#f2efe6", "center", 800);
  }, "#12302e"));
  panel(7.2, 0.675, nameFrieze, 0, 7.05, END_Z + 0.052, 0);
  place(new THREE.Mesh(softBox(7.36, 0.82, 0.06, 0.02, 1.4), metals.brushed), 0, 7.05, END_Z + 0.005, false);
  const clock = { x: 0, y: 8.02, z: END_Z + 0.09 };
  const clockRim = new THREE.CylinderGeometry(0.5, 0.5, 0.14, 40);
  clockRim.rotateX(Math.PI / 2);
  place(new THREE.Mesh(clockRim, metals.darkMetal), clock.x, clock.y, END_Z + 0.06, false);
  const clockFace = place(new THREE.Mesh(new THREE.CircleGeometry(0.45, 40), lit(clockTexture(), 1.1)), clock.x, clock.y, END_Z + 0.145, false);
  clockFace.receiveShadow = false;
  place(new THREE.Mesh(new THREE.TorusGeometry(0.462, 0.028, 10, 48), metals.brushed), clock.x, clock.y, END_Z + 0.14, false);
  place(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 12).rotateX(Math.PI / 2), metals.darkMetal), clock.x, clock.y, END_Z + 0.175, false);
  const handMaterial = new THREE.MeshBasicMaterial({ color: 0x14110c });
  const hand = (length: number, width: number, depth: number) => {
    const geometry = new THREE.BoxGeometry(width, length, 0.006);
    geometry.translate(0, length / 2 - 0.05, 0);
    const mesh = new THREE.Mesh(geometry, handMaterial);
    mesh.position.set(clock.x, clock.y, END_Z + depth);
    scene.add(mesh);
    return mesh;
  };
  const hourHand = hand(0.27, 0.036, 0.165), minuteHand = hand(0.38, 0.024, 0.185);
  // Louvred vents either side of the name.
  const ventX = [-6.2, 6.2];
  instances(softBox(1.5, 0.9, 0.08, 0.02, 1.2), metals.structural, ventX.map((x) => at(x, 6.2, END_Z + 0.03)), false, false);
  instances(softBox(1.36, 0.06, 0.07, 0.008, 1), galvanised, ventX.flatMap((x) => Array.from({ length: 7 }, (_, i) => at(x, 5.87 + i * 0.11, END_Z + 0.075, [0.5, 0, 0]))), false, false);

  // ---- Concourse services ---------------------------------------------------
  // Ventilation trunk along each wall, turning into it at the platform end.
  const ductY = 6.25, ductX = EDGE - 0.42, ductFrom = END_Z + 0.02, ductTo = HEAD_Z - 0.9;
  const duct = new THREE.CylinderGeometry(0.3, 0.3, ductTo - ductFrom, 24);
  duct.rotateX(Math.PI / 2);
  instances(scaleUv(duct, 1, 3), galvanised, sides.map((side) => at(side * ductX, ductY, (ductFrom + ductTo) / 2)), false);
  const collar = new THREE.CylinderGeometry(0.33, 0.33, 0.07, 24);
  collar.rotateX(Math.PI / 2);
  instances(collar, metals.structural, sides.flatMap((side) => Array.from({ length: 10 }, (_, i) => at(side * ductX, ductY, ductFrom + 1 + i * 2.05))), false, false);
  const elbow = new THREE.TorusGeometry(0.42, 0.3, 16, 16, Math.PI / 2);
  elbow.rotateX(Math.PI / 2);
  instances(elbow, galvanised, [at(ductX - 0.42, ductY, ductTo, [0, 0, 0]), at(-(ductX - 0.42), ductY, ductTo, [0, Math.PI / 2, 0])], false);
  instances(softBox(0.5, 0.05, 0.06, 0.01, 1), metals.structural, sides.flatMap((side) => Array.from({ length: 5 }, (_, i) => at(side * (EDGE - 0.24), ductY - 0.33, ductFrom + 2 + i * 4.1))), false, false);
  // Cable tray under the duct.
  const trayY = 5.25, trayX = EDGE - 0.22;
  instances(worldBox(0.03, 0.08, hallLength - 0.1, 1.4), galvanised, sides.flatMap((side) => [-0.17, 0.17].map((o) => at(side * trayX + o, trayY, hallMid))), false, false);
  instances(worldBox(0.34, 0.02, 0.04, 1.4), galvanised, sides.flatMap((side) => Array.from({ length: 34 }, (_, i) => at(side * trayX, trayY - 0.03, END_Z + 0.4 + i * 0.6))), false, false);
  const trayCable = new THREE.CylinderGeometry(0.026, 0.026, hallLength - 0.1, 8);
  trayCable.rotateX(Math.PI / 2);
  instances(trayCable, rubber, sides.flatMap((side) => [-0.1, -0.03, 0.05, 0.11].map((o, i) => at(side * trayX + o, trayY + 0.012, hallMid, [0, 0, 0], [1 - (i % 2) * 0.3, 1 - (i % 2) * 0.3, 1]))), false, false);
  instances(softBox(0.4, 0.05, 0.05, 0.01, 1), metals.structural, sides.flatMap((side) => Array.from({ length: 10 }, (_, i) => at(side * (EDGE - 0.2), trayY - 0.07, END_Z + 1.2 + i * 2.05))), false, false);
  // Battens above the dado wash the plaster cold.
  const hallBattenZ = [-10.05, -14.15, -18.25, -22.35, -26.35];
  const flickering = (side: number, z: number) => side > 0 && z === -18.25;
  instances(batten, tubeGlow, sides.flatMap((side) => hallBattenZ.filter((z) => !flickering(side, z)).map((z) => at(side * (EDGE - 0.1), DADO + 0.2, z))), false, false);
  instances(batten, tubeFailing[0], [at(EDGE - 0.1, DADO + 0.2, -18.25)], false, false);
  instances(softBox(0.1, 0.05, 1.3, 0.012, 1), creamPaint, sides.flatMap((side) => hallBattenZ.map((z) => at(side * (EDGE - 0.07), DADO + 0.15, z))), false, false);
  for (const side of sides) for (const z of hallBattenZ) {
    if (flickering(side, z)) continue;
    const up = washed(3.2, 1.7, side * (EDGE - 0.014), DADO + 1.1, z, -side * Math.PI / 2);
    up.rotation.z = Math.PI;
    // Over the kiosk the wash stops at the head of the opening instead of hanging across it.
    const over = side < 0 && z + 1.6 > kiosk.from && z - 1.6 < kiosk.to;
    const foot = over ? kiosk.top + 0.02 : DADO - 2.25;
    washed(3.2, DADO + 0.15 - foot, side * (EDGE - 0.014), (DADO + 0.15 + foot) / 2, z, -side * Math.PI / 2);
  }

  // ---- Kiosk ---------------------------------------------------------------
  const kioskMid = (kiosk.from + kiosk.to) / 2, kioskRun = kiosk.to - kiosk.from;
  const kioskLining = new THREE.MeshStandardMaterial({ ...plasterMaps, color: 0xd8d2c2, roughness: 0.9, metalness: 0, side: THREE.BackSide, envMapIntensity: 0.4, emissive: 0xd8e2ea, emissiveMap: plasterMaps.map, emissiveIntensity: 0.3 });
  // The lining sits just inside the cut in the wall, so its ends and soffit never share a plane with the wall's own.
  place(new THREE.Mesh(scaleUv(new THREE.BoxGeometry(kiosk.depth, kiosk.top - 0.016, kioskRun - 0.03), 1, 1), kioskLining), -(EDGE + 0.1 + kiosk.depth / 2) + 0.1, (kiosk.top - 0.016) / 2 + 0.001, kioskMid, false);
  // The roof only keeps the vault's light out of the recess: it stays behind the wall, clear of the fascia.
  const kioskRoof = place(new THREE.Mesh(new THREE.BoxGeometry(kiosk.depth + 0.1, 0.1, kioskRun + 0.4), metals.darkMetal), -(EDGE + 0.12 + (kiosk.depth + 0.1) / 2), kiosk.top + 0.2, kioskMid, true);
  kioskRoof.receiveShadow = false;
  // Counter in timber with a steel top; a shutter drawn over the closed half.
  place(new THREE.Mesh(softBox(0.5, 0.98, kioskRun - 0.04, 0.02, 1.4), wood), -(EDGE + 0.2), 0.49, kioskMid, true, true);
  place(new THREE.Mesh(softBox(0.66, 0.045, kioskRun - 0.02, 0.012, 1.4), metals.brushed), -(EDGE + 0.16), 1.0, kioskMid, false);
  const shutterRun = 1.5;
  instances(softBox(0.035, 0.075, shutterRun, 0.016, 1), galvanised, Array.from({ length: 20 }, (_, i) => at(-(EDGE + 0.04), 1.06 + i * 0.074, kiosk.from + shutterRun / 2 + 0.03)), false, false);
  instances(softBox(0.09, kiosk.top, 0.07, 0.012, 1.2), metals.darkMetal, [kiosk.from + 0.035, kiosk.from + shutterRun + 0.06, kiosk.to - 0.035].map((z) => at(-(EDGE + 0.02), kiosk.top / 2, z)), false, false);
  // A till on the counter, a tube and a paper rack inside; the stock is set out with the rest of the dressing.
  place(new THREE.Mesh(softBox(0.34, 0.26, 0.36, 0.03, 1), metals.machine), -(EDGE + 0.2), 1.155, kioskMid + 0.35, false);
  instances(batten, tubeGlow, [at(-(EDGE + 0.5), kiosk.top - 0.06, kioskMid + 0.6), at(-(EDGE + 0.5), kiosk.top - 0.06, kioskMid - 0.8)], false, false);
  const kioskSign = lit(signTexture(1024, 128, (context, text) => {
    text("ECO ROUND", 40, 66, 78, "#14110c", "left", 900);
    text("nothing over $2000", 990, 48, 36, "#3a2a0c", "right", 800);
    text("papers  ·  coffee  ·  glhf", 990, 94, 23, "#3a2a0c", "right", 700);
  }, "#f0b83a", 0, 2), 1.1);
  place(new THREE.Mesh(softBox(0.12, 0.5, kioskRun + 0.16, 0.02, 1.2), metals.darkMetal), -(EDGE - 0.05), kiosk.top + 0.27, kioskMid, false);
  panel(kioskRun, 0.4, kioskSign, -(EDGE - 0.124), kiosk.top + 0.27, kioskMid, Math.PI / 2);
  // Front of the counter carries the day's bills.
  [1, 4, 3].forEach((style, i) => panel(0.5, 0.75, posters[style], -(EDGE - 0.064), 0.5, kiosk.to - 0.5 - i * 0.62, Math.PI / 2));
  // ---- Furniture -----------------------------------------------------------
  // Slatted benches under the signs and against the back wall.
  const benches: Array<{ x: number; z: number; turn: number }> = [
    { x: -9.17, z: -11, turn: Math.PI / 2 }, { x: -9.17, z: -17, turn: Math.PI / 2 },
    { x: 9.17, z: -17, turn: -Math.PI / 2 }, { x: 9.17, z: -23, turn: -Math.PI / 2 },
  ];
  const seated = (parts: Array<[number, number, number]>) => benches.flatMap(({ x, z, turn }) => parts.map(([lx, y, lz]) => at(x + lx * Math.cos(turn) + lz * Math.sin(turn), y, z - lx * Math.sin(turn) + lz * Math.cos(turn), [0, turn, 0])));
  instances(softBox(1.7, 0.035, 0.085, 0.012, 0.9), wood, seated([-0.15, -0.05, 0.05, 0.15].map((lz): V3 => [0, 0.455, lz])), true);
  instances(softBox(1.7, 0.085, 0.03, 0.012, 0.9), wood, seated([0.62, 0.73, 0.84].map((y): V3 => [0, y, -0.215])), false);
  instances(softBox(0.05, 0.44, 0.42, 0.015, 1), metals.darkMetal, seated([-0.72, 0.72].map((lx): V3 => [lx, 0.22, 0])), false);
  instances(softBox(0.05, 0.5, 0.05, 0.015, 1), metals.darkMetal, seated([-0.72, 0.72].map((lx): V3 => [lx, 0.66, -0.235])), false, false);
  instances(softBox(0.05, 0.035, 0.4, 0.012, 1), metals.darkMetal, seated([-0.8, 0.8].map((lx): V3 => [lx, 0.66, -0.03])), false, false);
  instances(softBox(0.04, 0.2, 0.04, 0.01, 1), metals.darkMetal, seated([-0.8, 0.8].map((lx): V3 => [lx, 0.55, 0.15])), false, false);
  // Litter bins.
  const bins: Array<[number, number]> = [[-9.2, -13.7], [-9.2, -19.6], [9.2, -19.9], [9.2, -8.9], [-6.55, 9.26], [6.66, 9.26]];
  instances(scaleUv(new THREE.CylinderGeometry(0.23, 0.21, 0.78, 20), 2, 1), greenPaint, bins.map(([x, z]) => at(x, 0.39, z)));
  instances(new THREE.CylinderGeometry(0.236, 0.236, 0.07, 20), amberPaint, bins.map(([x, z]) => at(x, 0.6, z)), false, false);
  instances(new THREE.TorusGeometry(0.225, 0.022, 8, 20), metals.brushed, bins.map(([x, z]) => at(x, 0.78, z, [Math.PI / 2, 0, 0])), false, false);
  instances(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 20), rubber, bins.map(([x, z]) => at(x, 0.72, z)), false, false);
  // Ticket machines against the back wall.
  const machines = [7.55, 8.7];
  instances(softBox(0.95, 1.9, 0.6, 0.04, 1.4), metals.machine, machines.map((x) => at(x, 0.95, 9.36)));
  instances(softBox(0.97, 0.16, 0.62, 0.02, 1), amberPaint, machines.map((x) => at(x, 1.76, 9.36)), false, false);
  instances(softBox(0.6, 0.08, 0.2, 0.02, 1), metals.brushed, machines.map((x) => at(x, 0.72, 9.02)), false, false);
  instances(softBox(0.3, 0.14, 0.03, 0.01, 1), gasket, machines.map((x) => at(x + 0.22, 0.98, 9.05)), false, false);
  const ticketScreen = lit(signTexture(512, 384, (context, text) => {
    text("BUY MENU", 30, 44, 44, "#f2efe6", "left", 900);
    text("$800", 482, 44, 40, "#e0902a", "right", 900);
    // The balance covers the first two; the other two stay dark.
    ([["Single", "$200"], ["Return", "$400"], ["Day pass", "$1000"], ["Season", "$4750"]] as Array<[string, string]>).forEach(([label, price], i) => {
      const x = 30 + (i % 2) * 232, y = 96 + Math.floor(i / 2) * 124, funded = i < 2;
      context.fillStyle = funded ? "#1f6f6a" : "#16393d"; context.beginPath(); context.roundRect(x, y, 216, 104, 12); context.fill();
      text(label, x + 108, y + 38, 32, funded ? "#f2efe6" : "#7d8f90", "center", 700);
      text(price, x + 108, y + 76, 26, funded ? "#9fe0c8" : "#7d8f90", "center", 800);
    });
    text("Press B to begin  ·  buy time 0:20", 256, 354, 24, "#b9c4c0", "center", 600);
  }, "#0d2a30", 0, 2), 1.2);
  for (const x of machines) panel(0.56, 0.42, ticketScreen, x - 0.1, 1.36, 9.038, Math.PI);
  instances(softBox(0.64, 0.5, 0.03, 0.012, 1), gasket, machines.map((x) => at(x - 0.1, 1.36, 9.066)), false, false);
  // The network map hangs beside the chart, over the ticket machines; the way out takes the other side.
  panel(1.2, 1.8, posters[5], 8.12, 2.95, BACK_Z - 0.046, Math.PI);
  place(new THREE.Mesh(softBox(1.3, 1.9, 0.04, 0.012, 1.2), metals.darkMetal), 8.12, 2.95, BACK_Z - 0.012, false);

  // ---- Set dressing ---------------------------------------------------------
  // One-off props are merged per material; repeated ones are instanced.
  const dress = batch();
  const quarterTurn = Math.PI / 2;
  const rodX = (radius: number, length: number, segments = 8) => new THREE.CylinderGeometry(radius, radius, length, segments).rotateZ(quarterTurn);
  const rodZ = (radius: number, length: number, segments = 8) => new THREE.CylinderGeometry(radius, radius, length, segments).rotateX(quarterTurn);

  // Stencilled inside the yellow line, opposite each door of the leading car and its twin across the platform.
  const gapStencil = sharp(canvasTexture(2048, 384, (context) => {
    const next = rng(6128);
    context.scale(2, 2);
    context.fillStyle = "#000"; context.fillRect(0, 0, 1024, 192);
    context.fillStyle = "#fff"; context.textAlign = "center"; context.textBaseline = "middle";
    context.font = `900 112px ${FONT}`; context.fillText("MIND THE GAP", 512, 66);
    context.font = `700 43px ${FONT}`; context.fillText("between tick and sub-tick", 512, 156);
    // Years of feet have taken some of the paint.
    for (let i = 0; i < 900; i += 1) { context.fillStyle = `rgba(0,0,0,${0.5 + next() * 0.5})`; context.beginPath(); context.arc(next() * 1024, next() * 192, 0.5 + next() * 1.6, 0, Math.PI * 2); context.fill(); }
    for (let i = 0; i < 46; i += 1) { context.fillStyle = `rgba(0,0,0,${0.12 + next() * 0.22})`; context.beginPath(); context.ellipse(next() * 1024, next() * 192, 14 + next() * 44, 3 + next() * 9, (next() - 0.5) * 0.5, 0, Math.PI * 2); context.fill(); }
  }));
  gapStencil.colorSpace = THREE.NoColorSpace;
  const gapPaint = new THREE.MeshStandardMaterial({ color: 0xd9a514, alphaMap: gapStencil, transparent: true, depthWrite: false, roughness: 0.62, metalness: 0, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const gapLettering = instances(new THREE.PlaneGeometry(2.3, 0.43).rotateX(-quarterTurn), gapPaint, sides.flatMap((side) => [-2.8, 2.4, 7.6].map((z) => at(side * 8.27, 0.004, z, [0, -side * quarterTurn, 0]))), false, false);
  gapLettering.renderOrder = 1;
  kit.mirrorHidden.push(gapLettering);
  // Platform edge: glazed nosing tiles on the coping and raised blisters on the warning strip.
  instances(new THREE.BoxGeometry(0.17, 0.014, 0.288), whiteGlaze, sides.flatMap((side) => Array.from({ length: 59 }, (_, i) => at(side * (EDGE + 0.145), 0.012, HEAD_Z + 0.15 + i * 0.3))), false, false);
  if (high) {
    const blister = new THREE.CylinderGeometry(0.02, 0.029, 0.006, 10);
    const rows = Math.floor((platformLength - 0.1) / 0.1);
    const blisters = instances(blister, tactileStud, sides.flatMap((side) => Array.from({ length: rows * 4 }, (_, i) => at(side * 9.2 - 0.15 + (i % 4) * 0.1, 0.015, HEAD_Z + 0.1 + Math.floor(i / 4) * 0.1))), false, false);
    kit.mirrorHidden.push(blisters);
    // Rail chairs: a base plate, two clips and two screws at every sleeper.
    const chair = batch();
    chair.add(rust, new THREE.BoxGeometry(0.32, 0.024, 0.18));
    for (const x of [-0.075, 0.075]) chair.add(rust, new THREE.BoxGeometry(0.05, 0.04, 0.11), x, 0.02, 0);
    for (const x of [-0.125, 0.125]) chair.add(rust, new THREE.CylinderGeometry(0.016, 0.016, 0.04, 6), x, 0.022, 0);
    chair.build(railX.flatMap((x) => Array.from({ length: Math.floor(trackRun / 0.7) }, (_, i) => at(x, PIT + 0.136, trackFrom + 0.4 + i * 0.7))), false, false, true);
  }
  // Cold spill of the edge trunking across the floor, painted rather than lit.
  const spill = sharp(spillTexture());
  const spillMaterial = new THREE.MeshBasicMaterial({ map: spill, color: TUBE.clone().multiplyScalar(0.085), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  for (const side of sides) {
    const pool = place(new THREE.Mesh(new THREE.PlaneGeometry(4.6, platformLength).rotateX(-quarterTurn), spillMaterial), side * 7.5, 0.016, platformMid, false);
    pool.rotation.y = side > 0 ? 0 : Math.PI;
    pool.receiveShadow = false;
    pool.renderOrder = 1;
    kit.mirrorHidden.push(pool);
    kit.probeHidden.push(pool);
  }
  // Warm pools under the pendants, and the saloon's cold light falling out of every door and window
  // across the platform edge: both painted, so the floor reads as lit by what hangs over it.
  const floorLight = (map: THREE.Texture, colour: THREE.Color, strength: number) => new THREE.MeshBasicMaterial({ map, color: colour.clone().multiplyScalar(strength), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const pendantPools = instances(new THREE.PlaneGeometry(1, 1).rotateX(-quarterTurn), floorLight(flare, SODIUM, 0.13), lamps.filter((lamp) => !dead(lamp)).map(({ x, z }) => at(x, 0.02, z, [0, 0, 0], [6.6, 1, 6.6])), false, false);
  const saloonSpill = batch(), saloonLight = floorLight(wash, new THREE.Color(0.9, 0.97, 1), 0.3);
  const spillFrom = (z: number, width: number, reach: number) => saloonSpill.add(saloonLight, new THREE.PlaneGeometry(width, reach).rotateX(-quarterTurn).rotateY(-quarterTurn), EDGE + 0.18 - reach / 2, 0.022, CAR_Z + z);
  for (const [z0, z1] of windowsZ) if (CAR_Z + z1 < BACK_Z) spillFrom((z0 + z1) / 2, (z1 - z0) * 1.7, 2.7);
  for (const d of doorsZ) spillFrom(d, 2.6, 3.3);
  for (const mesh of [pendantPools, ...saloonSpill.build(HERE, false, false, true)]) {
    mesh.receiveShadow = false;
    mesh.renderOrder = 1;
    kit.probeHidden.push(mesh);
    if (mesh === pendantPools) kit.mirrorHidden.push(mesh);
  }

  // Signals: back plate, hoods over both aspects, a bracket and a number plate.
  const signalPlate = enamel(signTexture(128, 256, (context, text) => { text("MR", 64, 70, 96, "#14110c", "center", 900, 108); text("12", 64, 180, 96, "#14110c", "center", 900, 108); }, "#e9e4d2"));
  for (const [x, y, z] of signalSpots) {
    const s = -Math.sign(x);
    dress.add(metals.darkMetal, new THREE.BoxGeometry(0.02, 0.86, 0.34), x - s * 0.02, y, z);
    for (const o of [0.16, -0.14]) dress.add(metals.darkMetal, new THREE.CylinderGeometry(0.075, 0.075, 0.16, 14, 1, true, 0, Math.PI).rotateZ(quarterTurn).rotateX(-quarterTurn), x + s * 0.17, y + o, z);
    dress.add(metals.structural, new THREE.BoxGeometry(0.14, 0.05, 0.05), x - s * 0.06, y - 0.36, z);
    dress.add(signalPlate, new THREE.PlaneGeometry(0.16, 0.3).rotateY(s * quarterTurn), x + s * 0.016, y - 0.7, z);
    dress.add(metals.darkMetal, new THREE.BoxGeometry(0.015, 0.34, 0.2), x - s * 0.005, y - 0.7, z);
  }

  // Poster frames, glazing and fixings; hooded bins.
  const posterFrame = projectUv(frameGeometry(1.58, 2.28, 0.09, 0.07, 0.012, 0.008), 1.2);
  instances(posterFrame, metals.brushed, posterZ.map((z) => at(-wallX, 1.5, z, [0, quarterTurn, 0])), false, false);
  const glazing = instances(new THREE.PlaneGeometry(1.4, 2.1), posterGlass, [
    ...posterZ.map((z) => at(-(HALF - 0.08), 1.5, z, [0, quarterTurn, 0])),
    at(8.12, 2.95, BACK_Z - 0.062, [0, Math.PI, 0], [1.2 / 1.4, 1.8 / 2.1, 1]),
  ], false, false);
  glazing.renderOrder = 3;
  glazing.receiveShadow = false;
  const fixing = new THREE.CylinderGeometry(0.014, 0.014, 0.012, 10);
  const corners = (w: number, h: number) => [-1, 1].flatMap((a) => [-1, 1].map((b): [number, number] => [a * (w / 2 - 0.045), b * (h / 2 - 0.045)]));
  instances(fixing, metals.darkMetal, [
    ...posterZ.flatMap((z) => corners(1.58, 2.28).map(([o, y]) => at(-(HALF - 0.1), 1.5 + y, z + o, [0, 0, quarterTurn]))),
    ...corners(1.34, 1.94).map(([o, y]) => at(8.12 + o, 2.95 + y, BACK_Z - 0.082, [quarterTurn, 0, 0])),
  ], false, false);
  dress.add(metals.brushed, frameGeometry(1.34, 1.94, 0.07, 0.06, 0.012, 0.006), 8.12, 2.95, BACK_Z - 0.01, [0, Math.PI, 0]);
  const hood = new THREE.SphereGeometry(0.25, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5, 1);
  instances(hood, greenPaint, bins.map(([x, z]) => at(x, 0.97, z)), false, false);
  instances(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6), metals.brushed, bins.flatMap(([x, z]) => [0.4, 2.5, 4.6].map((a) => at(x + Math.cos(a) * 0.21, 0.88, z + Math.sin(a) * 0.21))), false, false);

  // Ticket machines: plinth, lit header, keypad, card reader, coin and note slots, ticket tray.
  const ticketHeader = lit(signTexture(512, 96, (context, text) => { text("BUY MENU", 256, 50, 62, "#14110c", "center", 900); }, "#f0b83a", 0), 1.1);
  const keys = sharp(canvasTexture(256, 320, (context) => {
    context.fillStyle = "#9aa0a0"; context.fillRect(0, 0, 256, 320);
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "✕", "0", "✓"].forEach((label, i) => {
      const x = 14 + (i % 3) * 80, y = 12 + Math.floor(i / 3) * 76;
      context.fillStyle = "#0c0d0e"; context.beginPath(); context.roundRect(x, y, 68, 64, 8); context.fill();
      context.fillStyle = i === 9 ? "#b3261e" : i === 11 ? "#1f8f5a" : "#2a2e30"; context.beginPath(); context.roundRect(x + 4, y + 3, 60, 54, 6); context.fill();
      context.font = `800 34px ${FONT}`; context.fillStyle = "#f2efe6"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(label, x + 34, y + 31);
    });
  }));
  const keypad = new THREE.MeshStandardMaterial({ map: keys, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.8, ...DECAL });
  for (const x of machines) {
    dress.add(metals.darkMetal, softBox(0.99, 0.08, 0.64, 0.015, 1), x, 0.04, 9.36);
    dress.add(metals.darkMetal, softBox(0.95, 0.22, 0.3, 0.03, 1), x, 2.02, 9.5);
    dress.add(ticketHeader, new THREE.PlaneGeometry(0.85, 0.16).rotateY(Math.PI), x, 2.02, 9.338);
    dress.add(metals.brushed, softBox(0.22, 0.27, 0.03, 0.008, 1), x - 0.3, 0.98, 9.05, [0.35, 0, 0]);
    dress.add(keypad, new THREE.PlaneGeometry(0.19, 0.24).rotateY(Math.PI), x - 0.3, 0.989, 9.022, [0.35, 0, 0]);
    dress.add(metals.darkMetal, softBox(0.15, 0.2, 0.07, 0.015, 1), x + 0.32, 1.42, 9.04);
    dress.add(gasket, new THREE.BoxGeometry(0.1, 0.008, 0.02), x + 0.32, 1.38, 9.004);
    dress.add(doorButton, new THREE.BoxGeometry(0.02, 0.008, 0.01), x + 0.36, 1.49, 9.004);
    dress.add(metals.brushed, new THREE.BoxGeometry(0.1, 0.12, 0.016), x + 0.32, 1.2, 9.056);
    dress.add(gasket, new THREE.BoxGeometry(0.006, 0.05, 0.02), x + 0.32, 1.2, 9.05);
    dress.add(gasket, softBox(0.52, 0.17, 0.03, 0.01, 1), x - 0.02, 0.5, 9.056);
    dress.add(posterGlass, new THREE.PlaneGeometry(0.46, 0.13).rotateY(Math.PI), x - 0.02, 0.5, 9.03, [-0.25, 0, 0]);
    for (let i = 0; i < 5; i += 1) dress.add(gasket, new THREE.BoxGeometry(0.3, 0.008, 0.012), x - 0.2, 0.2 + i * 0.03, 9.056);
  }

  // Kiosk: tiled floor, stocked shelves, magazines face-out, papers and a till on the counter.
  const kioskBack = -(EDGE + kiosk.depth);
  dress.add(kioskFloor, worldBox(kiosk.depth, 0.02, kioskRun, 1.5), -(EDGE + kiosk.depth / 2), 0.012, kioskMid);
  const shelfY = [1.18, 1.52, 1.86, 2.2];
  for (const y of shelfY) dress.add(wood, softBox(0.3, 0.026, kioskRun - 0.06, 0.006, 1.2), kioskBack + 0.16, y, kioskMid);
  for (const z of [kiosk.from + 0.05, kioskMid, kiosk.to - 0.05]) dress.add(metals.brushed, new THREE.BoxGeometry(0.03, 1.5, 0.03), kioskBack + 0.03, 1.7, z);
  // Stock comes from the shared prop library, whose fronts look along +z: a quarter turn faces them out of
  // the kiosk. A kind is one batch, so each list below gathers every one of its kind around the kiosk.
  const stock = rng(5521);
  const jitter = (amount: number) => (stock() - 0.5) * 2 * amount;
  const counterTop = 1.0225, kioskGround = 0.022;
  const shelfTop = (shelf: number) => shelfY[shelf] + 0.013;
  /** A thing on a shelf; `back` is how far behind the front row it stands. */
  const shelved = (shelf: number, z: number, back = 0, turn = 0, lift = 0): PropItem => at(kioskBack + 0.235 - back + jitter(0.008), shelfTop(shelf) + lift, z, [0, quarterTurn + turn, 0]);
  const row = (shelf: number, from: number, count: number, pitch: number, back = 0) => Array.from({ length: count }, (_, i) => shelved(shelf, from - i * pitch + jitter(pitch * 0.08), back, jitter(0.5)));
  const tinted = (items: PropItem[], tint: number): PropItem[] => items.map((item) => ({ ...item, tint }));
  // Bottle crates: two stacks of empties behind the counter, and a delivery left against the shuttered half.
  const crateH = props.get("cratePlastic").size[1];
  const stack = (x: number, z: number, ground: number, count: number, turn: number): PropItem[] => Array.from({ length: count }, (_, i) => at(x + jitter(0.012), ground + i * crateH, z + jitter(0.012), [0, quarterTurn + turn + jitter(0.05), 0]));
  /** Bottles standing in the pockets (four by three, 92 mm apart) of the top crate of a stack. */
  const pocketed = (crates: PropItem[], pockets: number[]): PropItem[] => {
    const top = crates[crates.length - 1], turn = top.rotation?.[1] ?? 0, c = Math.cos(turn), d = Math.sin(turn);
    return pockets.map((k) => {
      const lx = -0.138 + (k % 4) * 0.092, lz = -0.092 + Math.floor(k / 4) * 0.092;
      return at(top.position[0] + lx * c + lz * d, top.position[1] + 0.012, top.position[2] - lx * d + lz * c, [0, stock() * 6, 0]);
    });
  };
  const empties = stack(kioskBack + 0.55, -21.04, kioskGround, 5, 0.03), returns = stack(kioskBack + 0.56, -21.5, kioskGround, 4, -0.06);
  const delivery = stack(-(EDGE - 0.23), -23.07, 0, 3, 0.05), second = stack(-(EDGE - 0.25), -23.54, 0, 2, -0.09);
  props.place("cratePlastic", [...tinted(empties, 0x1f6a4a), ...tinted(returns.slice(0, 1), 0x2a2c2e), ...tinted(returns.slice(1), 0xb5321c), ...tinted(delivery, 0xb5321c), ...tinted(second, 0x1f6a4a)]);
  // An opened carton of tins stands past the end of the counter; its tins join the shelf tins in one batch.
  const opened = at(-(EDGE - 0.31), 0, -24.06, [0, quarterTurn + 0.25, 0]), openRoom = props.get("cartonOpen").inside;
  props.place("cartonOpen", [opened]);
  const loose = openRoom ? props.heap("tin", { at: [opened.position[0], openRoom.floor, opened.position[2]], size: openRoom.size, yaw: quarterTurn + 0.25, rim: openRoom.rim, flare: openRoom.flare, count: 14, seed: 3, place: false }).items : [];
  const tinH = props.get("tin").size[1], flatH = props.get("cartonFlat").size[1];
  const small: THREE.InstancedMesh[] = [
    ...props.place("bottleSoda", [
      ...row(2, -20.93, 6, 0.072), ...row(2, -20.966, 5, 0.072, 0.115), ...row(3, -21.66, 5, 0.081), ...row(2, -22.72, 4, 0.085, 0.03),
      at(-(EDGE + 0.29), counterTop, -21.37, [0, 1.9, 0]), at(-(EDGE + 0.235), counterTop, -21.455, [0, 0.4, 0]),
      ...pocketed(delivery, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    ]),
    ...props.place("bottleBeer", [
      ...row(2, -22.05, 4, 0.074), ...row(2, -22.09, 2, 0.148, 0.11), ...row(3, -22.62, 3, 0.09, 0.02),
      ...pocketed(returns, [0, 1, 2, 4, 5, 7, 8, 10, 11]).map((item) => ({ ...item, tint2: 0x0d140a })),
    ]),
    ...props.place("bottleSauce", [...row(2, -21.42, 4, 0.052), ...row(2, -21.446, 4, 0.052, 0.07)]),
    ...props.place("jar", [
      shelved(1, -22.02), shelved(1, -22.15, 0, 0.3), shelved(1, -22.085, 0.12), shelved(1, -22.28, 0, -0.4), shelved(1, -22.345, 0.12),
      shelved(3, -22.14), shelved(3, -22.2, 0.12, 0.5), shelved(3, -22.31, 0.01, -0.3),
      at(-(EDGE + 0.06), counterTop, -21.03, [0, quarterTurn + 0.3, 0]), at(-(EDGE + 0.125), counterTop, -21.165, [0, quarterTurn - 0.5, 0]), at(-(EDGE + 0.03), counterTop, -21.275, [0, quarterTurn + 0.1, 0]),
    ]),
    ...props.place("tin", [
      ...row(1, -21.52, 5, 0.09), ...[-21.565, -21.655, -21.835].map((z) => shelved(1, z, 0, jitter(0.6), tinH)),
      ...row(2, -21.72, 3, 0.09, 0.02), shelved(2, -21.765, 0.02, 0.4, tinH), ...row(1, -23.5, 3, 0.1), ...loose,
    ]),
  ];
  // Nobody sees the floor's reflection of a jar: the small glass stays out of the mirror pass.
  for (const mesh of small) kit.mirrorHidden.push(mesh);
  // The store behind the control rack keeps two cartons on its crate (see the service corners below).
  const storeTop = props.get("pallet").size[1] + props.get("crateLarge").size[1];
  props.place("cartonSmall", [
    shelved(1, -22.78, 0.02, 0.1), shelved(1, -23.2, 0.02, -0.07), shelved(2, -23.3, 0.02), shelved(2, -23.66, 0.02, 0.2),
    shelved(3, -21.03, 0.02, 0.12), shelved(3, -21.38, 0.02, -0.06), shelved(3, -23.45, 0.02, 0.05),
    at(second[1].position[0] + 0.01, 2 * crateH, second[1].position[2] + 0.02, [0, quarterTurn + 0.4, 0]),
    at(-9.14, storeTop + flatH, -27.76, [0, -0.5, 0]),
  ]);
  props.place("cartonFlat", [
    at(kioskBack + 0.225, shelfTop(1), -21.12, [0, quarterTurn + 0.04, 0]), at(kioskBack + 0.235, shelfTop(1) + flatH, -21.15, [0, quarterTurn - 0.07, 0]),
    at(kioskBack + 0.225, shelfTop(3), -22.95, [0, quarterTurn + 0.05, 0]), at(-9.1, storeTop, -27.8, [0, 0.3, 0]),
  ]);
  // Magazines face-out along the lowest shelf.
  const magazines = instances(new THREE.BoxGeometry(0.008, 0.28, 0.2), new THREE.MeshBasicMaterial({ map: sharp(magazineTexture()), color: 0xc4c4c4 }), Array.from({ length: 13 }, (_, i) => at(kioskBack + 0.2, shelfY[0] + 0.15, kiosk.from + 0.2 + i * 0.228, [0, 0, 0.22])), false, false);
  const covers = [0xb3261e, 0xd9861f, 0x1f8f8a, 0xefe6d2, 0x4a3a8a, 0x3f6a2f, 0xf2c23a, 0x26386a, 0xc85a54, 0xe8e8e8], cover = new THREE.Color();
  for (let i = 0; i < magazines.count; i += 1) magazines.setColorAt(i, cover.setHex(covers[Math.floor(stock() * covers.length)]));
  if (magazines.instanceColor) magazines.instanceColor.needsUpdate = true;
  magazines.receiveShadow = false;
  kit.mirrorHidden.push(magazines);

  // Service corners beside the control rack. West: a permanent-way store, a crate on its pallet, a drum of
  // rail grease and a sack slumped against it. East: the winter grit, clear of the hose reel.
  props.place("pallet", [at(-9.07, 0, -27.85, [0, quarterTurn, 0])]);
  props.place("crateLarge", [at(-9.075, props.get("pallet").size[1], -27.86, [0, quarterTurn + 0.02, 0])]);
  props.place("drum", [at(-9.2, 0, -26.9, [0, 0.7, 0])], { tint: 0x1c6a64 });
  props.place("sack", [at(-8.96, 0, -26.3, [0, -1.1, 0])]);
  props.place("cartonCrushed", [at(-9.12, 0, -25.55, [0, 0.6, 0])]);
  props.place("drumPlastic", [at(9.17, 0, -25.45, [0, -1.9, 0])], { tint: 0xd9a514 });
  props.place("sackLying", [at(9.21, 0, -26.2, [0, quarterTurn + 0.08, 0]), at(9.17, props.get("sackLying").size[1] * 0.88, -26.16, [0, quarterTurn - 0.3, 0])]);
  props.place("sackOpen", [{ ...at(9.05, 0, -24.88, [0, -0.5, 0]), variant: 3, tint2: 0x8f8a80 }]);
  const news = sharp(canvasTexture(256, 384, (context) => {
    context.fillStyle = "#e6e1d2"; context.fillRect(0, 0, 256, 384);
    context.font = `900 35px Georgia, serif`; context.fillStyle = "#14110c"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText("The Daily Dink", 128, 34, 228);
    context.fillRect(12, 60, 232, 3);
    context.font = `900 28px Georgia, serif`; context.fillText("CHICKEN TOPS", 128, 92, 228); context.fillText("SCOREBOARD", 128, 126, 228);
    context.fillStyle = "#6a655a"; context.fillRect(12, 150, 110, 90);
    chicken(context, 62, 228, 62, "#e6e1d2", "#14110c");
    context.fillStyle = "#3a362e"; for (let i = 0; i < 26; i += 1) context.fillRect(i < 11 ? 134 : 12, i < 11 ? 152 + i * 8 : 254 + (i - 11) * 8, i < 11 ? 110 : 232 - ((i * 37) % 40), 3);
  }));
  const newsprint = new THREE.MeshStandardMaterial({ map: news, roughness: 0.9, metalness: 0, emissive: 0xffffff, emissiveMap: news, emissiveIntensity: 0.2, ...DECAL });
  for (const [z, turn] of [[-21.78, 0.06], [-22.3, -0.1]]) {
    dress.add(lining, softBox(0.3, 0.07, 0.22, 0.008, 1), -(EDGE + 0.12), 1.058, z, [0, turn, 0]);
    dress.add(newsprint, new THREE.PlaneGeometry(0.2, 0.29).rotateX(-quarterTurn).rotateY(quarterTurn), -(EDGE + 0.12), 1.1, z, [0, turn, 0]);
  }
  const tillZ = kioskMid + 0.35;
  dress.add(keypad, new THREE.PlaneGeometry(0.2, 0.2).rotateX(-quarterTurn).rotateY(quarterTurn), -(EDGE + 0.2), 1.294, tillZ - 0.04, [0, 0, 0]);
  dress.add(metals.darkMetal, new THREE.CylinderGeometry(0.015, 0.015, 0.16, 8), -(EDGE + 0.3), 1.36, tillZ + 0.1);
  dress.add(gasket, softBox(0.05, 0.09, 0.2, 0.012, 1), -(EDGE + 0.3), 1.46, tillZ + 0.1);
  dress.add(cabScreen, new THREE.PlaneGeometry(0.16, 0.05).rotateY(quarterTurn), -(EDGE + 0.272), 1.46, tillZ + 0.1);
  dress.add(metals.brushed, new THREE.BoxGeometry(0.02, 0.03, 0.3), -(EDGE + 0.025), 1.09, tillZ);
  for (let i = 0; i < 4; i += 1) dress.add(lining, new THREE.CylinderGeometry(0.04, 0.03, 0.1, 12), -(EDGE + 0.34), 1.075 + i * 0.012, kiosk.to - 0.3);
  // The kiosk's own tubes are geometry; this is the light they would throw on the back wall and counter.
  for (const z of [kioskMid + 0.6, kioskMid - 0.8]) {
    washed(1.9, 2.3, kioskBack + 0.014, 1.3, z, quarterTurn);
  }

  // Public address horns, cameras, the help point and the fire hose cabinet.
  const horn = batch();
  horn.add(creamPaint, new THREE.LatheGeometry([[0.03, 0], [0.036, 0.1], [0.07, 0.2], [0.15, 0.3], [0.165, 0.31], [0.16, 0.315], [0.065, 0.21], [0.03, 0.11]].map(([x, y]) => new THREE.Vector2(x, y)), 20).rotateX(quarterTurn), 0, 0, 0, [0.35, 0, 0]);
  horn.add(creamPaint, rodZ(0.06, 0.1, 14), 0, 0, -0.05);
  horn.add(metals.darkMetal, new THREE.BoxGeometry(0.03, 0.2, 0.03), 0, 0.1, -0.03);
  horn.add(metals.darkMetal, new THREE.BoxGeometry(0.12, 0.02, 0.1), 0, 0.2, -0.06);
  horn.build([
    ...sides.flatMap((side) => [-12.1, -20.3].map((z) => at(side * (EDGE - 0.16), 4.95, z, [0, -side * quarterTurn, 0]))),
    ...sides.map((side) => at(side * 8.6, 5.4, BACK_Z - 0.16, [0, Math.PI, 0])),
    ...sides.flatMap((side) => [-4.4, 4.4].map((z) => at(side * (trunkX - 0.32), trunkY + 0.02, z, [0, -side * quarterTurn, 0]))),
  ], false, false, true);
  const tailLensDark = new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.08, metalness: 0, envMapIntensity: 1.6 });
  const camera = batch();
  camera.add(creamPaint, softBox(0.14, 0.05, 0.14, 0.01, 1), 0, 0.2, 0);
  camera.add(creamPaint, new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), 0, 0.12, 0);
  camera.add(creamPaint, new THREE.CylinderGeometry(0.085, 0.085, 0.05, 18), 0, 0.03, 0);
  camera.add(tailLensDark, new THREE.SphereGeometry(0.075, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0, 0.01, 0);
  camera.build([
    ...sides.flatMap((side) => [-9.0, -27.6].map((z) => at(side * (EDGE - 0.14), 4.62, z))),
    ...sides.flatMap((side) => [-6.4, 7.6].map((z) => at(side * (trunkX - 0.3), trunkY - 0.42, z))),
  ], false, false, true);
  const helpFace = lit(signTexture(256, 640, (context, text) => {
    context.fillStyle = "#e9c21f"; context.fillRect(0, 0, 256, 120);
    text("HELP", 128, 44, 58, "#14110c", "center", 900); text("POINT", 128, 94, 40, "#14110c", "center", 900);
    context.fillStyle = "#061416"; for (let row = 0; row < 7; row += 1) for (let column = 0; column < 9; column += 1) { context.beginPath(); context.arc(48 + column * 20, 160 + row * 14, 4, 0, Math.PI * 2); context.fill(); }
    text("CALLOUTS", 128, 300, 26, "#f2efe6", "center", 800);
    context.fillStyle = "#1f8f5a"; context.beginPath(); context.arc(128, 366, 40, 0, Math.PI * 2); context.fill();
    text("TIMEOUT", 128, 470, 28, "#f2efe6", "center", 800);
    context.fillStyle = "#b3261e"; context.beginPath(); context.arc(128, 540, 44, 0, Math.PI * 2); context.fill();
    text("Staff will answer: nt", 128, 610, 20, "#b9c4c0", "center", 600, 232);
  }, "#0f3a44", 0, 2), 0.9);
  dress.add(greenPaint, softBox(0.4, 0.92, 0.12, 0.03, 1), -9.18, 1.4, BACK_Z - 0.06);
  dress.add(helpFace, new THREE.PlaneGeometry(0.32, 0.8).rotateY(Math.PI), -9.18, 1.4, BACK_Z - 0.132);
  dress.add(doorButton, rodZ(0.045, 0.03, 16), -9.18, 1.342, BACK_Z - 0.136);
  dress.add(glow(new THREE.Color(1, 0.12, 0.08), 1.6), rodZ(0.05, 0.03, 16), -9.18, 1.125, BACK_Z - 0.136);
  dress.add(glow(new THREE.Color(0.25, 0.5, 1), 2.2), softBox(0.4, 0.06, 0.12, 0.02, 1), -9.18, 1.9, BACK_Z - 0.06);
  const hoseZ = -27.1, hoseX = EDGE - 0.005;
  dress.add(redPaint, projectUv(frameGeometry(0.86, 1.0, 0.05, 0.2, 0.012), 1), hoseX, 1.5, hoseZ, [0, -quarterTurn, 0]);
  dress.add(redPaint, new THREE.BoxGeometry(0.02, 1.0, 0.86), hoseX - 0.012, 1.5, hoseZ);
  dress.add(creamPaint, new THREE.TorusGeometry(0.27, 0.055, 10, 28).rotateY(quarterTurn), hoseX - 0.1, 1.5, hoseZ);
  dress.add(creamPaint, new THREE.TorusGeometry(0.19, 0.05, 10, 24).rotateY(quarterTurn), hoseX - 0.1, 1.5, hoseZ);
  dress.add(redPaint, rodX(0.13, 0.13, 20), hoseX - 0.1, 1.5, hoseZ);
  dress.add(metals.brushed, rodX(0.03, 0.2, 10), hoseX - 0.1, 1.14, hoseZ + 0.2, [0, 0, 0.4]);
  dress.add(posterGlass, new THREE.PlaneGeometry(0.78, 0.92).rotateY(-quarterTurn), hoseX - 0.196, 1.5, hoseZ);
  dress.add(metals.brushed, new THREE.BoxGeometry(0.03, 0.12, 0.03), hoseX - 0.2, 1.5, hoseZ - 0.36);
  const hoseSign = enamel(signTexture(512, 96, (context, text) => { text("CONTROL YOUR SPRAY", 256, 50, 46, "#f2efe6", "center", 900, 476); }, "#a3201a"));
  dress.add(hoseSign, new THREE.PlaneGeometry(0.86, 0.16).rotateY(-quarterTurn), hoseX - 0.012, 2.14, hoseZ);

  // Conduit above the dado feeding each batten through a junction box, and saddles holding it.
  instances(rodZ(0.014, hallLength - 0.2), galvanised, sides.map((side) => at(side * (EDGE - 0.02), DADO + 0.46, hallMid)), false, false);
  for (const side of sides) for (const z of hallBattenZ) {
    dress.add(galvanised, softBox(0.06, 0.13, 0.13, 0.012, 1), side * (EDGE - 0.035), DADO + 0.46, z);
    dress.add(galvanised, new THREE.CylinderGeometry(0.011, 0.011, 0.2, 6), side * (EDGE - 0.03), DADO + 0.33, z);
  }
  instances(new THREE.BoxGeometry(0.012, 0.05, 0.03), metals.structural, sides.flatMap((side) => Array.from({ length: 16 }, (_, i) => at(side * (EDGE - 0.016), DADO + 0.46, END_Z + 0.9 + i * 1.28))), false, false);
  // Water has been getting in: runs down the plaster, the end wall and the far track wall.
  const stain = new THREE.MeshBasicMaterial({ alphaMap: sharp(streakTexture()), color: 0x1c130a, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const runs = [
    ...sides.flatMap((side) => [-9.5, -15.2, -19.7, -25.3].map((z, i) => at(side * (EDGE - 0.008), 6.6 - (i % 2) * 0.3, z + side * 0.4, [0, -side * quarterTurn, 0], [0.7 + (i % 3) * 0.35, 2.8, 1]))),
    ...[-6.2, 6.2, -2.4].map((x, i) => at(x, 5.4 - i * 0.2, END_Z + 0.008, [0, 0, 0], [1.3, 2.2 + i * 0.5, 1])),
    ...[-5.8, -2.6, 0.9, 4.3, 8.1].map((z, i) => at(HALF - 0.008, 2.6, z, [0, -quarterTurn, 0], [0.8 + (i % 2) * 0.5, 2.4, 1])),
    ...[-3.2, 3.2].map((z) => at(-(HALF - 0.008), 2.75, z, [0, quarterTurn, 0], [0.5, 1.8, 1])),
  ];
  const stains = instances(new THREE.PlaneGeometry(1, 1), stain, runs, false, false);
  stains.receiveShadow = false;
  stains.renderOrder = 1;
  kit.mirrorHidden.push(stains);
  dress.build(HERE, false, false, true);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: galvanised }, vaultY(9.28) - 3.5);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xffc999, 0x7a5a3a, 0.34));
  const sun = kit.sunLight({ color: 0xffb877, intensity: 1.25, toSun: TO_LAMP, extent: 28, distance: 40, near: 6, far: 80, radius: 3 });
  sun.target.position.set(0, 0, -7);
  sun.position.copy(sun.target.position).addScaledVector(TO_LAMP, 40);
  const lamp = (colour: number, intensity: number, reach: number, x: number, y: number, z: number) => {
    const light = new THREE.PointLight(colour, intensity, reach, 2);
    light.position.set(x, y, z);
    scene.add(light);
    return light;
  };
  // Four real lamps only: two sodium fills down the middle and one cold fill over each platform edge.
  // The trunking spill, the wall washes, the saloon and the kiosk are emissive geometry and painted light.
  const fills = [
    lamp(0xffad60, 150, 32, 0, lampY - 0.4, -0.5),
    lamp(0xffad60, 150, 32, 0, lampY - 0.4, -18),
    ...sides.map((side) => lamp(0xd2e8ff, 44, 18, side * 6.4, 3.4, 0.9)),
  ];
  const sodiumAir: Glow[] = [
    { position: new THREE.Vector3(-lampX, lampY - 0.2, 1), color: SODIUM.clone().multiplyScalar(0.8) },
    { position: new THREE.Vector3(lampX, lampY - 0.2, -11), color: SODIUM.clone().multiplyScalar(0.8) },
  ];
  let struckUp = false, strobing = false, buzzed = 0, buzzes = 0, goes = 0;
  kit.updates.push((now) => {
    const seconds = now / 1000;
    // Two tubes on their way out: one stutters, one strobes at the ends of its life.
    const stutter = Math.sin(seconds * 31) + Math.sin(seconds * 47.3 + 1.2) + Math.sin(seconds * 3.1) > 0.4 ? 1 : 0.06;
    const strobe = (seconds * 0.37) % 1 < 0.72 ? 0.85 + 0.15 * Math.sin(seconds * 120) : (Math.sin(seconds * 53) > 0.2 ? 0.5 : 0.03);
    tubeFailing[0].color.copy(TUBE).multiplyScalar(3.4 * stutter);
    tubeFailing[1].color.copy(TUBE).multiplyScalar(3.4 * strobe);
    // They are heard as they strike: the stuttering pair by turns (one over the far track, one in the concourse), the strober one time in three as it starts to go.
    if (stutter > 0.5 && !struckUp && seconds - buzzed > 7) {
      buzzed = seconds; buzzes += 1;
      if (buzzes % 2) say("tubeFlicker", -(HALF - 0.12), 3.64, 1.5, 0.55); else say("tubeFlicker", EDGE - 0.1, DADO + 0.2, -18.25, 0.55);
    }
    struckUp = stutter > 0.5;
    const going = (seconds * 0.37) % 1 >= 0.72;
    if (going && !strobing && (goes += 1) % 3 === 0 && seconds - buzzed > 1.2) { buzzed = seconds; say("tubeFlicker", EDGE + 0.2, 3.35, HEAD_Z + 11.35, 0.5, 1.12); }
    strobing = going;
    // The dying sodium lamp cycles: strikes pink, warms, drops out.
    const cycle = (seconds * 0.11) % 1;
    const strike = cycle < 0.12 ? 0.04 : cycle < 0.3 ? (cycle - 0.12) / 0.18 : cycle < 0.9 ? 1 : 0.5 + 0.5 * Math.sin(seconds * 40);
    sodiumFailing.color.setRGB(1, 0.42 + 0.14 * strike, 0.3 - 0.13 * strike).multiplyScalar(0.4 + 5.2 * strike);
    const time = new Date();
    minuteHand.rotation.z = -(time.getMinutes() + time.getSeconds() / 60) / 60 * Math.PI * 2;
    hourHand.rotation.z = -((time.getHours() % 12) + time.getMinutes() / 60) / 12 * Math.PI * 2;
  });

  // ---- The A Site train ------------------------------------------------------
  // The empty road does not stay empty: about once a minute a unit of the same stock works through
  // it. The tunnel's air arrives first and lifts the litter along the platform, then its lamps wash
  // the bend of the bore, then the train: it brakes into the platform, stands with its doors open
  // and goes, and the board over the platform counts the next one in.
  const northBore = boreList[0], southBore = boreList[2], ROAD = southBore.z0 - northBore.z0;
  /** The road as one line: negative inside the north bore, 0..ROAD beside the platform, beyond that the south bore. */
  const roadPoint = (q: number, out: THREE.Vector3) => {
    if (q >= 0 && q <= ROAD) return out.set(-TRACK_X, 0, northBore.z0 + q);
    const bore = q < 0 ? northBore : southBore, s = q < 0 ? -q : q - ROAD;
    const phi = Math.max(0, s - bore.straight) / bore.radius, sin = Math.sin(phi), cos = Math.cos(phi);
    // On the bends a car is carried toward the middle of the bore, so its ends clear the lining.
    const u = -bore.side * (BORE_X - TRACK_X) * (1 - 0.6 * THREE.MathUtils.smoothstep(s, bore.straight, bore.straight + 8));
    return out.set(bore.side * (BORE_X + bore.radius * (1 - cos)) + cos * u, 0, bore.z0 + bore.dir * (Math.min(s, bore.straight) + bore.radius * sin) - bore.side * bore.dir * sin * u);
  };
  // One working, in seconds from the moment the air starts to move: it runs in at speed, brakes to a
  // stand with its doors opposite the stencils on the platform, waits, and pulls away.
  const RUN = 4.5, CRUISE = 3, SPEED = 11, BRAKING = 8.5, STOP = RUN + CRUISE + BRAKING;
  const OPENS = STOP + 1.3, SHUTS = STOP + 10.3, SLIDE = 0.85, GO = STOP + 12.6, PULL = 1.1, GONE = GO + 11.3, END = GONE + 5;
  const HALT = ROAD + 1.3;
  const noseOf = (e: number) => {
    if (e < RUN + CRUISE) return HALT - (SPEED * BRAKING) / 2 - SPEED * (RUN + CRUISE - e);
    if (e < STOP) return HALT - ((SPEED * BRAKING) / 2) * ((STOP - e) / BRAKING) ** 2;
    return e < GO ? HALT : HALT + 0.5 * PULL * (e - GO) ** 2;
  };
  const leadM = new THREE.Matrix4(), rearM = new THREE.Matrix4(), partM = new THREE.Matrix4();
  const fore = new THREE.Vector3(), aft = new THREE.Vector3(), MIRROR = new THREE.Vector3(-1, 1, 1), YARD = new THREE.Vector3(-TRACK_X, 1, 0);
  /** Stands a car on the road with its leading end at `q`: the cab leads, or trails on the rear car. */
  const stand = (matrix: THREE.Matrix4, q: number, cabTrails: boolean) => {
    roadPoint(q - HL + 6.5, fore); roadPoint(q - HL - 6.5, aft);
    return matrix.makeRotationY(Math.atan2(aft.x - fore.x, aft.z - fore.z) + (cabTrails ? Math.PI : 0)).setPosition((fore.x + aft.x) / 2, 0, (fore.z + aft.z) / 2);
  };
  // What its lamps and saloon throw: flares on the lenses, beams in the dust, a pool on the four-foot ahead of
  // the cab, and the saloon's light sliding along the platform edge with the windows it falls from.
  const shaded = <T extends THREE.BufferGeometry>(geometry: T, r: number, g: number, b: number) => {
    const count = geometry.attributes.position.count, colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) { colours[i * 3] = r; colours[i * 3 + 1] = g; colours[i * 3 + 2] = b; }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    return geometry;
  };
  const beamCard = (upright: boolean) => {
    const card = new THREE.PlaneGeometry(1, 1, 2, 12), spot = card.attributes.position, uv = card.attributes.uv;
    for (let i = 0; i < spot.count; i += 1) {
      const across = spot.getX(i), along = spot.getY(i) + 0.5, wide = across * (0.5 + 2.6 * along);
      spot.setXYZ(i, upright ? 0 : wide, 0.62 + (upright ? wide * 0.6 : 0) - along * 0.3, -HL - 0.1 - along * 15);
      uv.setXY(i, across + 0.5, 0.5 + along * 0.5);
    }
    return shaded(card, 0.2, 0.185, 0.15);
  };
  const adrift = <T extends THREE.Object3D>(object: T, order: number) => {
    object.matrixAutoUpdate = false; object.frustumCulled = false; object.visible = false; object.renderOrder = order;
    scene.add(object);
    kit.mirrorHidden.push(object); kit.probeHidden.push(object);
    return object;
  };
  const lampRig = adrift(new THREE.Mesh(mergeGeometries([
    ...sides.map((side) => shaded(new THREE.PlaneGeometry(0.6, 0.6).rotateY(Math.PI).translate(side * 1.02, 0.62, -HL - 0.07), 0.6, 0.56, 0.48)),
    shaded(new THREE.PlaneGeometry(3.2, 10).rotateX(-quarter).translate(0, PIT + 0.22, -HL - 5), 0.2, 0.18, 0.14),
    beamCard(false), beamCard(true),
  ]), new THREE.MeshBasicMaterial({ map: flare, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })), 5);
  lampRig.name = "metro-unit";
  const unitLight = floorLight(wash, new THREE.Color(0.9, 0.97, 1), 0.3);
  unitLight.side = THREE.DoubleSide;
  // Painted light only falls on the platform: it fades out where the car is behind either end wall.
  unitLight.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying float vAlong;").replace("#include <project_vertex>", "#include <project_vertex>\nvAlong = (modelMatrix * vec4(transformed, 1.0)).z;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vAlong;")
      .replace("#include <color_fragment>", `#include <color_fragment>\ndiffuseColor.rgb *= smoothstep(${(HEAD_Z + 0.1).toFixed(2)}, ${(HEAD_Z + 0.9).toFixed(2)}, vAlong) * (1.0 - smoothstep(${(BACK_Z - 0.9).toFixed(2)}, ${(BACK_Z - 0.1).toFixed(2)}, vAlong));`);
  };
  const spillCard = (z: number, width: number, reach: number) => new THREE.PlaneGeometry(width, reach).rotateX(-quarter).rotateY(-quarter).translate(-(HW + 0.12) - reach / 2, 0.022, z);
  const unitSpillGeometry = mergeGeometries([...windowsZ.map(([z0, z1]) => spillCard((z0 + z1) / 2, (z1 - z0) * 1.7, 2.7)), ...doorsZ.map((d) => spillCard(d, 2.6, 3.3))]);
  const unitSpill = [0, 1].map(() => adrift(new THREE.Mesh(unitSpillGeometry, unitLight), 1));
  const unitSet = new Set<THREE.Object3D>(rolling.map(({ mesh }) => mesh));
  let out = false;
  const dispatch = (next: boolean) => {
    out = next;
    for (const { mesh, held, per, centre, radius } of rolling) {
      mesh.count = held + (next ? per * 2 : 0);
      mesh.boundingSphere!.center.copy(next ? YARD : centre);
      mesh.boundingSphere!.radius = next ? 90 : radius;
    }
    lampRig.visible = unitSpill[0].visible = unitSpill[1].visible = next;
    if (!next) headlamp.trainLamp.value.set(0, -200, 0, 0);
  };
  const starter = (clear: boolean) => {
    starterGreen.color.setRGB(0.1, 1, 0.35).multiplyScalar(clear ? 3 : 0.03);
    starterRed.color.setRGB(1, 0.06, 0.03).multiplyScalar(clear ? 0.03 : 4);
    say("relayClack", signalSpots[1][0], signalSpots[1][1], signalSpots[1][2], 0.8);
  };
  const steps: Array<{ at: number; run: () => void }> = [
    { at: 0.3, run: () => say("windGust", -TRACK_X, 1.4, HEAD_Z, 1) },
    { at: 1.4, run: () => bolt(rats[1], due + END + 3) },
    { at: RUN - 0.5, run: () => say("trainPass", -TRACK_X, 1, -5, 1) },
    { at: RUN, run: () => dispatch(true) },
    { at: STOP - 3.3, run: () => say("trainBrake", -TRACK_X, 0.4, 2, 0.9) },
    { at: OPENS - 0.8, run: () => say("trainDoors", -(EDGE + 0.3), 1.2, 2.4, 1) },
    { at: STOP + 2.8, run: () => say("paChime", 0, 5, 1, 0.9) },
    { at: SHUTS - 0.8, run: () => say("trainDoors", -(EDGE + 0.3), 1.2, 2.4, 1, 0.94) },
    { at: GO - 0.4, run: () => say("trainPass", -TRACK_X, 1, 7, 0.9, 0.9) },
    { at: GO + 2.5, run: () => starter(false) },
    { at: GO + 3.4, run: () => say("windGust", -TRACK_X, 1.4, BACK_Z, 0.7) },
    { at: GONE, run: () => dispatch(false) },
    { at: GONE + 4, run: () => starter(true) },
  ];
  const FACES = ["PUSHING", "", "STACKED", "ROTATED"];
  const lampAt = new THREE.Vector3(), ease = THREE.MathUtils.smootherstep, step = THREE.MathUtils.smoothstep;
  const pause = rng(128);
  let due = -1, stage = 0, shown = -99, met = false;
  kit.updates.push((now) => {
    const seconds = now / 1000;
    // The first working is felt within seconds of the range opening; after that one follows every 60 to 76 s.
    if (due < 0) due = seconds + 3;
    if (seconds - due > END) { due = Math.max(due + END + 15 + pause() * 16, seconds + 12); stage = 0; }
    let e = seconds - due;
    while (stage < steps.length && e >= steps[stage].at) { steps[stage].run(); stage += 1; }
    // Whoever has just walked in (the pointer locks on entering) is owed a train: unless one is standing at
    // the platform, the next working is brought forward to a few seconds from now.
    if (!met && document.pointerLockElement === options.renderer.domElement && (e < GO || e > GONE + 4)) {
      met = true;
      if (e < -2 || e > GO) { due = seconds + 2; stage = 0; e = -2; }
    }
    // The draught: it builds ahead of the train, drops as it stands, follows it out and dies away.
    const push = e < 0 ? 0 : (1 - step(e, GONE - 2, END)) * (step(e, 0, 5) * (1 - 0.75 * step(e, STOP - 3, STOP + 2)) + 0.6 * step(e, GO + 1, GO + 5));
    DRAUGHT.strength = 0.06 + 0.89 * push; DRAUGHT.gustiness = 1 - 0.8 * push;
    wind.set(DRAUGHT);
    // The board: minutes and seconds to the stand, then the call as it comes in, stands and leaves.
    const face = e < STOP - 9 ? Math.ceil(STOP - e) : e < STOP ? ((seconds * 1.6) % 1 < 0.62 ? -1 : -2) : e < GO ? -3 : -4;
    if (face !== shown) { shown = face; showOnBoard(face >= 0 ? `${Math.floor(face / 60)}:${String(face % 60).padStart(2, "0")}` : FACES[-face - 1]); }
    if (!out) return;
    const nose = noseOf(e), slide = 0.6 * (ease(e, OPENS, OPENS + SLIDE) - ease(e, SHUTS, SHUTS + SLIDE));
    stand(leadM, nose, false); stand(rearM, nose - HL * 2 - 0.6, true);
    for (let i = 0; i < rolling.length; i += 1) {
      const { mesh, held, per } = rolling[i];
      if (per === 1) { mesh.setMatrixAt(held, leadM); mesh.setMatrixAt(held + 1, rearM); }
      mesh.instanceMatrix.needsUpdate = true;
    }
    // Only the leading car stands at the platform, so only its platform side opens.
    for (let i = 0; i < leafSlots.length; i += 1) {
      const slot = leafSlots[i], note = noteMeshes[i % 2], pair = i >> 1;
      partM.copy(leafLocal[i]);
      if (slot.side < 0) partM.elements[14] += slot.way * slide;
      partM.premultiply(leadM);
      for (let k = 0; k < leafMeshes.length; k += 1) leafMeshes[k].setMatrixAt(leafSlots.length + i, partM);
      note.setMatrixAt(leafSlots.length / 2 + pair, partM);
      partM.copy(leafLocal[i]).premultiply(rearM);
      for (let k = 0; k < leafMeshes.length; k += 1) leafMeshes[k].setMatrixAt(leafSlots.length * 2 + i, partM);
      note.setMatrixAt(leafSlots.length + pair, partM);
    }
    lampRig.matrix.copy(leadM); unitSpill[0].matrix.copy(leadM); unitSpill[1].matrix.copy(rearM).scale(MIRROR);
    lampRig.matrixWorldNeedsUpdate = unitSpill[0].matrixWorldNeedsUpdate = unitSpill[1].matrixWorldNeedsUpdate = true;
    lampAt.set(0, 0.7, -HL - 0.2).applyMatrix4(leadM);
    headlamp.trainLamp.value.set(lampAt.x, lampAt.y, lampAt.z, 1.7 * step(e, RUN, RUN + 2) * (1 - step(e, GONE - 3, GONE)));
    headlamp.trainAim.value.set(0, -0.04, -1).transformDirection(leadM);
  });
  /** A bullet that meets the unit on the other road leaves no mark hanging in the air once it has gone. */
  const struckUnit = (object: THREE.Object3D, point: THREE.Vector3) => out && point.x < -(EDGE + 0.2) && unitSet.has(object);

  // What the draught carries: sheets of the paper along both platform edges, grit at the far edge, and
  // ticket stubs and wrappers down in the four-foot of the empty road.
  life.drift("paper", { volume: { x: [-9.2, -5.4], y: [0, 1.6], z: [-7.6, 9.2] }, count: 9 });
  life.drift("paper", { volume: { x: [5.4, 9.2], y: [0, 1.2], z: [-7.6, 9.2] }, count: 5 });
  life.drift("dust", { volume: { x: [-9.3, -6.5], y: [0, 1], z: [-7.8, 9.4] }, count: 12, colors: [0x8d8474] });
  life.drift("petals", { volume: { x: [-12.9, -9.8], y: [PIT + 0.02, 0.6], z: [-8.2, 9.8] }, count: 46, scale: 2.4, colors: [0xa9a492, 0x8e8672, 0xb08a3a, 0x7d8a8a], falling: 0 });

  // ---- Small things ----------------------------------------------------------
  // Pigeons got in years ago. They keep to the top of the far trunking and the hanging sign, and take to the
  // vault when a shot goes off.
  life.birds("pigeon", {
    perches: [{ from: [-(EDGE + 0.2), trunkY + 0.21, -6.4], to: [-(EDGE + 0.2), trunkY + 0.21, 8.4] }, { from: [-5, 5.11, 2.4], to: [-2.2, 5.11, 2.4], thin: true }],
    count: 6, roam: { x: [-8, 8], y: [5.3, 7.3], z: [-6, 8.5] },
    // A newcomer comes in the way the first ones did: out of the far-road tunnel behind the firing line.
    from: [-TRACK_X, 2.6, BACK_Z - 0.5],
  });
  // Water finds its way through the vault: at each leak a drop falls, rings the puddle under it and is heard there
  // (down in the far road only every other drop carries across the platform).
  const leaks = [
    { x: -2.7, z: 4.9, floor: 0.012, every: 5.3, phase: 1.1 }, { x: 3.9, z: -2.9, floor: 0.012, every: 7.9, phase: 4.2 },
    { x: -TRACK_X, z: 5.4, floor: PIT + 0.03, every: 5.9, phase: 0.4 }, { x: -TRACK_X + 0.1, z: -3.1, floor: PIT + 0.03, every: 8.3, phase: 6.5 },
  ].map((leak) => ({ ...leak, top: vaultY(leak.x) - 0.06, fall: Math.sqrt((2 * (vaultY(leak.x) - 0.06 - leak.floor)) / 9.81), rang: true, drops: 0 }));
  // On the platform a puddle is a film on polished terrazzo: it only darkens the floor, whose own reflection shows through.
  const puddleMaterial = new THREE.MeshBasicMaterial({ alphaMap: pool, color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const puddles = instances(new THREE.PlaneGeometry(0.74, 0.58).rotateX(-quarterTurn), puddleMaterial, leaks.filter((leak) => leak.floor > 0).map((leak, i) => at(leak.x + 0.06, 0.007, leak.z - 0.04, [0, 0.7 + i * 1.9, 0])), false, false);
  puddles.renderOrder = 2;
  const drops = instances(new THREE.OctahedronGeometry(0.008, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 0.9, 1).multiplyScalar(1.3), transparent: true, opacity: 0.8, toneMapped: false }), leaks.map(() => PARKED), false, false);
  const ringTexture = sharp(canvasTexture(128, 128, (context) => {
    const ring = context.createRadialGradient(64, 64, 40, 64, 64, 63);
    ring.addColorStop(0, "rgba(255,255,255,0)"); ring.addColorStop(0.55, "rgba(255,255,255,.75)"); ring.addColorStop(0.8, "rgba(255,255,255,.2)"); ring.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = ring; context.fillRect(0, 0, 128, 128);
  }));
  const rings = instances(new THREE.PlaneGeometry(1, 1).rotateX(-quarterTurn), new THREE.MeshBasicMaterial({ map: ringTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), leaks.flatMap(() => [PARKED, PARKED]), false, false);
  rings.renderOrder = 3;
  rings.name = "metro-rings";
  for (const mesh of [puddles, drops, rings]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.receiveShadow = false;
    kit.mirrorHidden.push(mesh); kit.probeHidden.push(mesh);
  }
  puddles.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const wetM = new THREE.Matrix4(), wetTint = new THREE.Color();
  kit.updates.push((now) => {
    const seconds = now / 1000;
    for (let i = 0; i < leaks.length; i += 1) {
      const leak = leaks[i], since = (seconds + leak.phase) % leak.every, falling = since < leak.fall;
      const speed = 9.81 * since;
      drops.setMatrixAt(i, falling ? wetM.makeScale(1, 1 + speed * 1.6, 1).setPosition(leak.x, leak.top - 0.5 * speed * since, leak.z) : wetM.makeScale(0, 0, 0));
      if (falling) leak.rang = false;
      else if (!leak.rang) {
        leak.rang = true; leak.drops += 1;
        if (leak.floor > 0) say("drip", leak.x, leak.floor, leak.z, 0.8);
        else if (leak.drops % 2) say("drip", leak.x, leak.floor, leak.z, 0.6, 0.8);
      }
      for (let k = 0; k < 2; k += 1) {
        const age = (since - leak.fall - k * 0.32) / 1.5, live = !falling && age > 0 && age < 1, wide = 0.08 + 0.5 * Math.sqrt(Math.max(age, 0));
        rings.setMatrixAt(i * 2 + k, live ? wetM.makeScale(wide, 1, wide).setPosition(leak.x, leak.floor + 0.004, leak.z) : wetM.makeScale(0, 0, 0));
        rings.setColorAt(i * 2 + k, wetTint.setScalar(live ? 0.5 * (1 - age) * (1 - age) : 0));
      }
    }
    drops.instanceMatrix.needsUpdate = rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  });

  // Rats work the foot of the concourse wall, from the kiosk to the platform end, and the four-foot of the empty
  // road. They keep to cover, sit up to look about, and bolt for the nearest hole at a shot or an approaching train.
  const ratParts: THREE.BufferGeometry[] = [];
  const ratPart = (geometry: THREE.BufferGeometry, r: number, g: number, b: number) => ratParts.push(shaded(mergeable(geometry), r, g, b));
  ratPart(new THREE.SphereGeometry(1, 10, 8).scale(0.04, 0.038, 0.08).translate(0, 0.048, 0.005), 0.2, 0.17, 0.145);
  ratPart(new THREE.SphereGeometry(1, 10, 8).scale(0.046, 0.046, 0.058).translate(0, 0.05, -0.04), 0.18, 0.155, 0.13);
  ratPart(new THREE.ConeGeometry(0.03, 0.085, 8).rotateX(quarterTurn).translate(0, 0.042, 0.105), 0.23, 0.195, 0.165);
  for (const side of sides) ratPart(new THREE.SphereGeometry(1, 6, 5).scale(0.014, 0.015, 0.006).translate(side * 0.021, 0.074, 0.078), 0.42, 0.27, 0.24);
  ratPart(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0.04, -0.09], [0.012, 0.016, -0.16], [-0.012, 0.01, -0.24], [0.006, 0.009, -0.32]].map(([x, y, z]) => new THREE.Vector3(x, y, z))), 10, 0.0055, 5), 0.4, 0.26, 0.22);
  type Rat = { path: Array<[number, number]>; reach: number[]; floor: number; rests: number[]; at: number; way: number; pace: number; till: number; mode: number; yaw: number };
  const HIDDEN = 0, SITTING = 1, RUNNING = 2, BOLTING = 3;
  const ratRun = (path: Array<[number, number]>, floor: number, rests: number[], first: number): Rat => ({
    path, floor, rests, at: 0, way: 1, pace: 0, till: first, mode: HIDDEN, yaw: 0,
    reach: path.reduce<number[]>((sum, point, i) => [...sum, i ? sum[i - 1] + Math.hypot(point[0] - path[i - 1][0], point[1] - path[i - 1][1]) : 0], []),
  });
  const rats = [
    ratRun([[-9.8, -20.7], [-9.25, -20.45], [-8.8, -19.95], [-8.8, -19.25], [-9.02, -18.4], [-9.02, -17], [-9.02, -15.6], [-9.02, -14.6], [-8.8, -14.05], [-8.8, -13.35], [-9.02, -12.7], [-9.02, -11], [-9.02, -9.3], [-9.4, -8.5], [-9.8, -8.42]], 0, [3.5, 5.6, 9.2, 11.6], 5),
    ratRun([[-9.84, -8.3], [-9.92, -7.4], [-9.95, -1], [-9.92, 4.5], [-9.95, 9.2], [-9.84, 9.9]], PIT, [3.2, 7.5, 11, 15.4], 9),
  ];
  const ratMesh = instances(mergeGeometries(ratParts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.6 }), rats.map(() => PARKED), true, false);
  const ratShade = instances(new THREE.PlaneGeometry(0.2, 0.34).rotateX(-quarterTurn), new THREE.MeshBasicMaterial({ map: flare, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), rats.map(() => PARKED), false, false);
  for (const mesh of [ratMesh, ratShade]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.userData.walkThrough = true;
    mesh.boundingSphere!.center.set(-9.5, 0, -5); mesh.boundingSphere!.radius = 24;
    kit.probeHidden.push(mesh);
  }
  ratMesh.name = "metro-rats";
  ratShade.receiveShadow = false; ratShade.renderOrder = 2;
  kit.mirrorHidden.push(ratShade);
  const ratLuck = rng(64), ratTurn = new THREE.Euler(), ratSize = new THREE.Vector3(1.35, 1.35, 1.35), ratSpot = new THREE.Vector3(), ratTwist = new THREE.Quaternion();
  /** Sends a rat that is out for the nearer end of its run, and keeps it in its hole for a while. */
  const bolt = (rat: Rat, away: number) => {
    if (rat.mode === HIDDEN) { rat.till = Math.max(rat.till, away); return; }
    rat.mode = BOLTING; rat.way = rat.at < rat.reach[rat.reach.length - 1] / 2 ? -1 : 1; rat.till = away;
  };
  let ratClock = 0, ratThen = 0;
  kit.updates.push((now) => {
    const seconds = now / 1000, dt = Math.min(0.05, Math.max(0, seconds - ratThen));
    ratThen = ratClock = seconds;
    for (let i = 0; i < rats.length; i += 1) {
      const rat = rats[i], end = rat.reach[rat.reach.length - 1];
      if (rat.mode === HIDDEN) {
        if (seconds > rat.till) { rat.mode = RUNNING; rat.way = ratLuck() < 0.5 ? 1 : -1; rat.at = rat.way > 0 ? 0 : end; rat.till = seconds + 0.8 + ratLuck() * 2.6; }
      } else if (rat.mode === SITTING) {
        rat.pace = 0;
        if (seconds > rat.till) { rat.mode = RUNNING; if (ratLuck() < 0.22) rat.way = -rat.way; rat.till = seconds + 0.7 + ratLuck() * 2.4; }
      } else {
        const hurry = rat.mode === BOLTING ? 4.6 : 2.1;
        rat.pace += (hurry - rat.pace) * Math.min(1, dt * 9);
        rat.at += rat.way * rat.pace * dt;
        if (rat.at <= 0 || rat.at >= end) { if (rat.mode !== BOLTING) rat.till = seconds + 5 + ratLuck() * 8; rat.mode = HIDDEN; }
        else if (rat.mode === RUNNING && seconds > rat.till) { rat.mode = SITTING; rat.till = seconds + 1.2 + ratLuck() * 3.6; }
      }
      if (rat.mode === HIDDEN) { ratMesh.setMatrixAt(i, wetM.makeScale(0, 0, 0)); ratShade.setMatrixAt(i, wetM); continue; }
      let leg = 1;
      while (leg < rat.reach.length - 1 && rat.reach[leg] < rat.at) leg += 1;
      const a = rat.path[leg - 1], b = rat.path[leg], along = (rat.at - rat.reach[leg - 1]) / (rat.reach[leg] - rat.reach[leg - 1]);
      const heading = Math.atan2((b[0] - a[0]) * rat.way, (b[1] - a[1]) * rat.way);
      rat.yaw += Math.atan2(Math.sin(heading - rat.yaw), Math.cos(heading - rat.yaw)) * Math.min(1, dt * 12);
      // Running it bounds; sitting it noses the air and now and then sits up on its haunches.
      const sat = rat.mode === SITTING, rear = sat ? Math.max(0, Math.sin(seconds * 0.9 + i * 2.1)) ** 6 : 0;
      const hop = sat ? 0 : Math.abs(Math.sin(rat.at * 16)) * 0.014;
      ratSpot.set(a[0] + (b[0] - a[0]) * along, rat.floor + hop + rear * 0.02, a[1] + (b[1] - a[1]) * along);
      ratMesh.setMatrixAt(i, wetM.compose(ratSpot, ratTwist.setFromEuler(ratTurn.set(-rear * 0.7 - (sat ? Math.sin(seconds * 7 + i) * 0.04 : Math.sin(rat.at * 16) * 0.08), rat.yaw, 0, "YXZ")), ratSize));
      ratSpot.y = rat.floor + 0.005;
      ratShade.setMatrixAt(i, wetM.compose(ratSpot, ratTwist.setFromEuler(ratTurn.set(0, rat.yaw, 0)), ratSize));
    }
    ratMesh.instanceMatrix.needsUpdate = ratShade.instanceMatrix.needsUpdate = true;
  });
  const startleRats = (shot: THREE.Vector3) => { for (const rat of rats) if (Math.abs(shot.z - rat.path[0][1]) < 40) bolt(rat, ratClock + 9 + ratLuck() * 8); };
  /** A rat that is hit is simply gone; another finds the run after a while. */
  const struckRat = (object: THREE.Object3D, point: THREE.Vector3) => {
    if (object !== ratMesh) return false;
    for (const rat of rats) {
      if (rat.mode === HIDDEN) continue;
      let leg = 1;
      while (leg < rat.reach.length - 1 && rat.reach[leg] < rat.at) leg += 1;
      const a = rat.path[leg - 1], b = rat.path[leg], along = (rat.at - rat.reach[leg - 1]) / (rat.reach[leg] - rat.reach[leg - 1]);
      if (Math.hypot(point.x - a[0] - (b[0] - a[0]) * along, point.z - a[1] - (b[1] - a[1]) * along) < 0.45) { rat.mode = HIDDEN; rat.till = ratClock + 24 + ratLuck() * 18; }
    }
    return true;
  };

  // ---- Way out ---------------------------------------------------------------
  // Through the arch left of the chart one escalator climbs to the buy zone and never stops: a tiled shaft
  // in the old manner, timber decks with uplighters either side of the machine, and the hall's light at the top.
  // Nothing in the shaft is lit by the scene, so its finishes carry a little light of their own.
  const RAKE = Math.PI / 6, FOOT = 9.6, HEAD = 20.4;
  const liftTo = (z: number) => Math.max(0, z - FOOT) * Math.tan(RAKE);
  const shaftTile = new THREE.MeshStandardMaterial({ ...tiles, bumpScale: 1.4, color: 0xe9e3d3, roughness: 1, metalness: 0, envMapIntensity: 0.6, emissive: 0xffecc8, emissiveMap: tiles.map, emissiveIntensity: 0.2 });
  const shaftPlaster = new THREE.MeshStandardMaterial({ ...plasterMaps, color: 0xcbbfa4, roughness: 0.95, metalness: 0, envMapIntensity: 0.4, emissive: 0xffdfa8, emissiveMap: plasterMaps.map, emissiveIntensity: 0.16 });
  const deckWood = new THREE.MeshStandardMaterial({ ...woodMaps, color: 0xb98a5c, roughness: 0.6, metalness: 0, envMapIntensity: 0.7, emissive: 0xffd2a0, emissiveMap: woodMaps.map, emissiveIntensity: 3.4 });
  const treadTexture = sharp(canvasTexture(128, 128, (context) => {
    context.fillStyle = "#2c2d2e"; context.fillRect(0, 0, 128, 128);
    context.fillStyle = "#74777a"; for (let x = 2; x < 128; x += 6) context.fillRect(x, 0, 2, 128);
    context.fillStyle = "#d8a51c"; context.fillRect(0, 0, 128, 10);
  }));
  const tread = new THREE.MeshStandardMaterial({ map: treadTexture, roughness: 0.5, metalness: 0.5, envMapIntensity: 0.9, emissive: 0xffffff, emissiveMap: treadTexture, emissiveIntensity: 0.16 });
  const shaft = [
    instances(worldBox(0.1, 10, HEAD - BACK_Z, 2.4), shaftTile, sides.map((side) => at(ESC_X + side * 1.05, 4.6, (BACK_Z + 0.4 + HEAD + 0.4) / 2)), false, false),
    place(new THREE.Mesh(worldBox(2.3, 4.4, 0.1, 2.4), shaftTile), ESC_X, liftTo(HEAD) + 1.6, HEAD + 0.4, false),
    place(new THREE.Mesh(worldBox(2.2, 0.5, 0.06, 3), shaftPlaster), ESC_X, 3.27, BACK_Z + 0.43, false),
  ];
  // The soffit follows the rake three metres over the treads, and keeps the key out of the shaft.
  const soffit = place(new THREE.Mesh(worldBox(2.2, 0.12, (HEAD + 0.4 - BACK_Z - 0.4) / Math.cos(RAKE), 3), shaftPlaster), ESC_X, 3.0 + liftTo((HEAD + BACK_Z + 0.8) / 2), (HEAD + BACK_Z + 0.8) / 2, true);
  soffit.rotation.x = -RAKE;
  // Decks: one profile from the newel on the platform to the head of the shaft, with a rubber handrail on its inner edge.
  const rakeTop = HEAD + 0.3, deckLine = (lift: number): Array<[number, number]> => [[8.55, 0.25], [8.55, 0.8 + lift], [8.7, 0.95 + lift], [FOOT, 0.95 + lift], [rakeTop, liftTo(rakeTop) + 0.95 + lift]];
  const profile = (points: Array<[number, number]>, depth: number) => projectUv(new THREE.ExtrudeGeometry(new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y))), { depth, bevelEnabled: false }).rotateY(-quarterTurn), 1.2);
  const deck = profile([[8.55, 0], ...deckLine(0), [rakeTop, liftTo(rakeTop) - 0.3], [FOOT + 0.3 / Math.tan(RAKE), 0]], 0.5);
  const handrail = profile([...deckLine(0), ...deckLine(0.05).reverse().map(([z, y], i, all): [number, number] => [i === all.length - 1 || i === all.length - 2 ? z - 0.05 : z, y])], 0.1);
  shaft.push(
    instances(deck, deckWood, sides.map((side) => at(ESC_X + (side > 0 ? 1 : -0.5), 0, 0)), false, false),
    instances(handrail, rubber, sides.map((side) => at(ESC_X + (side > 0 ? 0.62 : -0.52), 0, 0)), false, false),
  );
  const uplights = Array.from({ length: 5 }, (_, i) => FOOT + 0.9 + i * 2.2).flatMap((z) => sides.map((side) => ({ x: ESC_X + side * 0.8, y: liftTo(z) + 0.95, z })));
  shaft.push(
    instances(new THREE.CylinderGeometry(0.018, 0.03, 0.4, 8), metals.brushed, uplights.map(({ x, y, z }) => at(x, y + 0.2, z)), false, false),
    instances(new THREE.SphereGeometry(0.12, 14, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), glow(new THREE.Color(1, 0.74, 0.42), 2.2), uplights.map(({ x, y, z }) => at(x, y + 0.5, z)), false, false),
    // The top of the climb is only ever a glow: the hall up there is lit, and stays out of sight.
    place(new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4).rotateY(Math.PI), new THREE.MeshBasicMaterial({ map: flare, color: new THREE.Color(1, 0.84, 0.58).multiplyScalar(1.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })), ESC_X, liftTo(HEAD) + 1.5, HEAD + 0.3, false),
  );
  // Comb plate on the platform, and the lit sign over the arch.
  place(new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 0.52), plate), ESC_X, 0.025, 8.74, false);
  place(new THREE.Mesh(new THREE.BoxGeometry(1, 0.054, 0.05), amberPaint), ESC_X, 0.027, 8.99, false);
  place(new THREE.Mesh(softBox(2.0, 0.46, 0.07, 0.012, 1.2), metals.darkMetal), ESC_X, 3.52, BACK_Z - 0.035, false);
  panel(1.9, 0.356, exitBox, ESC_X, 3.52, BACK_Z - 0.075, Math.PI);
  // The treads: one box each, carried flat out from under the comb and then up the rake.
  const TREADS = 30, GOING = 0.405, treadAt = (z: number) => wetM.makeTranslation(ESC_X, liftTo(z) - 0.085, z);
  const treads = instances(new THREE.BoxGeometry(1, 0.24, GOING), tread, Array.from({ length: TREADS }, (_, i) => at(ESC_X, liftTo(8.8 + i * GOING) - 0.085, 8.8 + i * GOING)), false, false);
  treads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  treads.boundingSphere!.radius += 0.5;
  shaft.push(treads);
  for (const mesh of shaft) { mesh.receiveShadow = false; kit.mirrorHidden.push(mesh); kit.probeHidden.push(mesh); }
  kit.updates.push((now) => {
    const travel = (now / 1000) * 0.62;
    for (let i = 0; i < TREADS; i += 1) treads.setMatrixAt(i, treadAt(8.8 + ((i * GOING + travel) % (TREADS * GOING))));
    treads.instanceMatrix.needsUpdate = true;
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 420, x: 18, y: [0.2, 7], z: [-27, 9], color: 0xffd9a8, opacity: 0.22 });
  // Brake dust hanging over the tracks in the cold light.
  const dust = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: track(softDiscTexture()), color: 0xcfe6ff, size: 0.03, sizeAttenuation: true, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }));
  const dustCount = high ? 160 : 80, dustPositions = new Float32Array(dustCount * 3), dustRandom = rng(19);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions[i * 3] = (dustRandom() > 0.5 ? 1 : -1) * (EDGE - 0.4 + dustRandom() * 3);
    dustPositions[i * 3 + 1] = 0.3 + dustRandom() * 3;
    dustPositions[i * 3 + 2] = HEAD_Z + dustRandom() * platformLength;
  }
  dust.geometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  scene.add(dust);
  kit.mirrorHidden.push(dust);
  kit.probeHidden.push(dust);

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: sodiumAir,
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: 0x060504, fog: 0x1c140c, fogDensity: high ? 0.007 : 0.012,
      haze: new THREE.Color(0.034, 0.024, 0.013), hazeDensity: 0.012, hazeCeiling: 8.6, hazeFade: 1.6,
      environmentIntensity: 1.15, exposure: 1.05, far: 110,
    },
    // The pendants light the whole floor evenly; the edges under the trunking fall off into the cold.
    sunlitAt(point) {
      return 0.6 * (1 - THREE.MathUtils.smoothstep(Math.abs(point.x), 7.2, 9.4) * 0.6);
    },
    probeAt: new THREE.Vector3(0, 2.6, -9),
  });
  return {
    ...range,
    startle: (shot, loudness) => { life.startle(shot, loudness); startleRats(shot); },
    struck: (object, point) => life.struck(object, point) || struckRat(object, point) || struckUnit(object, point),
  };
}

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  archedWall, canvasTexture, clothGeometry, createKit, projectUv, softDiscTexture, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createProps, type PropItem, type PropKind } from "../props";
import { createTrees, type TreeItem } from "../trees";
import { createWind } from "../wind";

// Bazaar: a covered market hall late in the afternoon.
//
// Lighting model: the hall is roofed, so the sun only gets in where the roof
// lets it — slatted bays, lattice panels, a few missing boards and the open
// lattice gable at the far end. Each opening prints its own pattern on the
// flagstones and stands in the dusty air as a shaft. Dyed cloth stretched in
// some bays takes the sun on its back and glows from below. Everything between
// is shade, warmed by lanterns and by a probe of the lit hall itself.

/** Direction to the sun in `goegap-2k.hdr`, and the turn that puts it ahead of the firing line. */
const HDR_SUN = new THREE.Vector3(0.535, 0.725, 0.433);
const SKY_TURN = 1.956;
const TO_SUN = HDR_SUN.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), SKY_TURN).normalize();

const WALL = 9.54;
const WALL_MID = 9.94;
const STOREY = 4.5;
const WALL_TOP = 7.6;
/** The hall runs from the lattice gable to the wall behind the firing line. */
const HALL = { from: -30.3, to: 10.6 };
const HALL_LENGTH = HALL.to - HALL.from, HALL_MID = (HALL.to + HALL.from) / 2;

// Roof: two shallow slopes meeting at the ridge. `t` runs down a slope from the ridge, `h` stands off it.
const RIDGE = 9.2;
const PITCH = Math.atan2(1.8, 10.3), COS = Math.cos(PITCH), SIN = Math.sin(PITCH), TAN = Math.tan(PITCH);
const onSlope = (side: number, t: number, h: number): [number, number] => [side * (t * COS + h * SIN), RIDGE - t * SIN + h * COS];
const PURLINS = [0.5, 2.9, 5.3, 7.7, 9.85];
const TRUSS_Z = Array.from({ length: 14 }, (_, index) => 10 - index * 3);
const POST_Z = [-26, -20, -14, -8, -2];
/**
 * One row per bay from the firing line to the far gable, eight cells from the left eave to the right:
 * B boards, S slats, L lattice, C dyed cloth, O missing boards.
 */
const ROOF = [
  "BBBCBBBB", "BBCBBCBB", "BSBBBBCB", "BBLBCBBS", "CBBSBBOB", "BBCBSBBC", "BSBBBLBB",
  "BBBCBBSB", "SBBBCBBL", "BBLBBSBB", "BCBBOBBS", "BBSBBBCB", "LBBBBLBB",
];
const cellAt = (bay: number, side: number, cell: number) => ROOF[bay]?.[side < 0 ? 3 - cell : 4 + cell] ?? "B";

type V3 = [number, number, number];

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

function merge(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts.map((part) => part.index ? part.toNonIndexed() : part));
  parts.forEach((part) => part.dispose());
  return merged;
}

/**
 * Box-projects UVs with the grain (the texture's u) running along `axis` (0 x, 1 y, 2 z).
 * `shift` slides the texture so neighbouring pieces do not repeat each other.
 */
function grain<T extends THREE.BufferGeometry>(geometry: T, axis: number, metres = 1.3, shift = 0): T {
  const position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  const p = [0, 0, 0];
  for (let i = 0; i < position.count; i += 1) {
    p[0] = position.getX(i); p[1] = position.getY(i); p[2] = position.getZ(i);
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
    const facing = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    if (facing === axis) uv.setXY(i, p[(axis + 1) % 3] / metres + shift, p[(axis + 2) % 3] / metres + shift * 1.7);
    else uv.setXY(i, p[axis] / metres + shift, p[3 - axis - facing] / metres + shift * 1.7);
  }
  return geometry;
}

const longest = (w: number, h: number, d: number) => (w >= h && w >= d ? 0 : h >= d ? 1 : 2);

/** A squared piece with the grain along its longest side. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, metres = 1.3) {
  return grain(new THREE.BoxGeometry(w, h, d), longest(w, h, d), metres, Math.abs(x * 0.37 + y * 0.71 + z * 0.53) % 1).translate(x, y, z);
}

/** A box with eased arrises. Corner segments follow the radius: on a small edge one chamfer already reads as round. */
function softBox(w: number, h: number, d: number, radius: number, metres: number) {
  return grain(new RoundedBoxGeometry(w, h, d, radius >= 0.08 ? 3 : radius >= 0.035 ? 2 : 1, radius), longest(w, h, d), metres);
}

/** An eased timber placed at a point, grain along its length, each one cut from a different part of the board. */
function stick(w: number, h: number, d: number, x: number, y: number, z: number, ease = 0.006) {
  const geometry = ease > 0 ? new RoundedBoxGeometry(w, h, d, 1, Math.min(ease, w / 3, h / 3, d / 3)) : new THREE.BoxGeometry(w, h, d);
  return grain(geometry, longest(w, h, d), 1.3, Math.abs(x * 0.61 + y * 0.29 + z * 0.83) % 1).translate(x, y, z);
}

function rod(a: V3, b: V3, radius: number, segments = 6) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const geometry = new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), segments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return geometry;
}

/** A squared timber between two points of the XY plane. */
function beam(a: [number, number], b: [number, number], depth: number, thick: number, z = 0) {
  const geometry = worldBox(Math.hypot(b[0] - a[0], b[1] - a[1]), depth, thick, 1.3);
  geometry.rotateZ(Math.atan2(b[1] - a[1], b[0] - a[0]));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z);
  return geometry;
}

/** A colour canvas and a tangent-space normal map derived from a painted height canvas. */
function reliefTextures(logical: number, colour: (context: CanvasRenderingContext2D) => void, height: (context: CanvasRenderingContext2D) => void, relief: number, scale = 1) {
  // Painted in `logical` pixels and rasterised `scale` times finer.
  const size = logical * scale, strength = relief * scale;
  const map = canvasTexture(size, size, (context) => { context.scale(scale, scale); colour(context); }, true);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "#000";
  context.fillRect(0, 0, size, size);
  context.save(); context.scale(scale, scale);
  height(context);
  context.restore();
  const source = context.getImageData(0, 0, size, size), target = context.createImageData(size, size);
  const h = (x: number, y: number) => source.data[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const length = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
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

/** Worn flagstones: coursed slabs of uneven width, dished by feet, with dark joints. One tile is 2.4 m. */
function flagTextures(scale: number) {
  const size = 1024, course = size / 3;
  const random = rng(311);
  const slabs: Array<[number, number, number, number]> = [];
  for (let row = 0; row < 3; row += 1) {
    let x = Math.round(random() * 120);
    const start = x;
    while (x < start + size) {
      const width = Math.min(start + size - x, Math.round(300 + random() * 300));
      slabs.push([x, row * course, width < 140 ? start + size - x : width, random()]);
      x += slabs[slabs.length - 1][2];
    }
  }
  const each = (draw: (x: number, y: number, w: number, tone: number) => void) => {
    for (const [x, y, w, tone] of slabs) for (const shift of [0, -size]) draw(x + shift, y, w, tone);
  };
  return reliefTextures(size, (context) => {
    context.fillStyle = "#4a3d30";
    context.fillRect(0, 0, size, size);
    each((x, y, w, tone) => {
      const value = 0.86 + tone * 0.2, warm = 0.96 + ((tone * 7) % 1) * 0.08;
      const glow = context.createRadialGradient(x + w / 2, y + course / 2, 10, x + w / 2, y + course / 2, w * 0.75);
      const rgb = (k: number) => `rgb(${Math.round(150 * value * k * warm)},${Math.round(142 * value * k)},${Math.round(130 * value * k / warm)})`;
      glow.addColorStop(0, rgb(1.06)); glow.addColorStop(1, rgb(0.84));
      context.fillStyle = glow;
      context.fillRect(x + 3, y + 3, w - 6, course - 6);
    });
    // Grain, pits and old stains.
    for (let i = 0; i < 26000 * scale; i += 1) {
      const light = random() < 0.5, grain = (1 + random() * 3) / scale;
      context.fillStyle = `rgba(${light ? "255,240,214" : "20,12,6"},${0.03 + random() * 0.07})`;
      context.fillRect(random() * size, random() * size, grain * (1 + random()), grain);
    }
    // Chipped arrises and hairline cracks.
    each((x, y, w) => {
      context.strokeStyle = "rgba(24,14,6,.5)"; context.lineWidth = 0.7;
      for (let i = 0; i < 3; i += 1) {
        let cx = x + random() * w, cy = y + random() * course;
        context.beginPath(); context.moveTo(cx, cy);
        for (let step = 0; step < 6; step += 1) { cx += (random() - 0.5) * 40; cy += (random() - 0.5) * 40; context.lineTo(cx, cy); }
        context.stroke();
      }
      context.fillStyle = "rgba(30,20,10,.55)";
      for (let i = 0; i < 9; i += 1) { const along = random() * w; context.beginPath(); context.arc(x + along, y + (random() < 0.5 ? 3 : course - 3), 2 + random() * 5, 0, Math.PI * 2); context.fill(); }
    });
    for (let i = 0; i < 46; i += 1) {
      const x = random() * size, y = random() * size, r = 24 + random() * 80;
      const stain = context.createRadialGradient(x, y, 0, x, y, r);
      stain.addColorStop(0, `rgba(30,18,8,${0.1 + random() * 0.14})`); stain.addColorStop(1, "rgba(30,18,8,0)");
      context.fillStyle = stain;
      context.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }, (context) => {
    each((x, y, w, tone) => {
      const dish = context.createRadialGradient(x + w / 2, y + course / 2, 6, x + w / 2, y + course / 2, w * 0.7);
      const top = 200 + Math.round(tone * 50);
      dish.addColorStop(0, `rgb(${top - 26},${top - 26},${top - 26})`); dish.addColorStop(1, `rgb(${top},${top},${top})`);
      context.fillStyle = dish;
      context.filter = "blur(3px)";
      context.fillRect(x + 5, y + 5, w - 10, course - 10);
      context.filter = "none";
    });
    for (let i = 0; i < 5000; i += 1) {
      const tone = Math.round(random() * 255);
      context.fillStyle = `rgba(${tone},${tone},${tone},.07)`;
      context.fillRect(random() * size, random() * size, 2 + random() * 4, 2 + random() * 4);
    }
  }, 2.2, scale);
}

/** Dyed cloth: 0 broad stripes, 1 block-printed diamonds, 2 plain dye with banded ends. */
function dyeTexture(kind: number, base: string, second: string, accent: string, seed: number) {
  return canvasTexture(1024, 1024, (context) => {
    const random = rng(seed);
    context.scale(4, 4);
    context.fillStyle = base;
    context.fillRect(0, 0, 256, 256);
    if (kind === 0) {
      for (const [x, w, colour] of [[14, 40, second], [70, 7, accent], [112, 56, second], [186, 7, accent], [212, 22, second]] as Array<[number, number, string]>) { context.fillStyle = colour; context.fillRect(x, 0, w, 256); }
    } else if (kind === 1) {
      for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
        const cx = column * 32 + (row % 2 ? 16 : 0), cy = row * 32 + 16;
        for (const shift of [0, 256]) {
          context.fillStyle = (row + column) % 3 ? second : accent;
          context.beginPath(); context.moveTo(cx - shift, cy - 11); context.lineTo(cx - shift + 9, cy); context.lineTo(cx - shift, cy + 11); context.lineTo(cx - shift - 9, cy); context.closePath(); context.fill();
          context.beginPath(); context.arc(cx - shift + 16, cy, 2.2, 0, Math.PI * 2); context.fill();
        }
      }
    } else {
      context.fillStyle = second; context.fillRect(0, 0, 256, 26); context.fillRect(0, 230, 256, 26);
      context.fillStyle = accent; context.fillRect(0, 32, 256, 5); context.fillRect(0, 219, 256, 5);
      for (let i = 0; i < 26; i += 1) {
        const x = random() * 256, y = random() * 256, r = 30 + random() * 60;
        const blot = context.createRadialGradient(x, y, 0, x, y, r);
        blot.addColorStop(0, `rgba(${random() < 0.5 ? "255,255,255" : "0,0,0"},.09)`); blot.addColorStop(1, "rgba(0,0,0,0)");
        context.fillStyle = blot;
        context.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    // A darned patch of another length.
    for (let i = 0; i < 2; i += 1) {
      const x = 30 + random() * 170, y = 40 + random() * 170, w = 16 + random() * 16, h = 14 + random() * 14;
      context.save(); context.translate(x, y); context.rotate((random() - 0.5) * 0.3);
      context.fillStyle = i ? second : accent; context.globalAlpha = 0.8; context.fillRect(-w / 2, -h / 2, w, h); context.globalAlpha = 1;
      context.strokeStyle = "rgba(40,24,12,.55)"; context.lineWidth = 0.5; context.setLineDash([1.6, 1.2]); context.strokeRect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2); context.setLineDash([]);
      context.restore();
    }
    // Loom widths sewn edge to edge, and the hems: cloth doubled over and stitched down, darker where two layers stop the light.
    for (const x of [85.5, 170.5]) {
      context.fillStyle = "rgba(0,0,0,.2)"; context.fillRect(x - 1.3, 0, 2.6, 256);
      context.fillStyle = "rgba(255,244,220,.55)";
      for (let y = 1; y < 256; y += 5) context.fillRect(x - 0.3, y, 0.6, 2.8);
    }
    context.fillStyle = "rgba(0,0,0,.24)";
    context.fillRect(0, 0, 256, 8); context.fillRect(0, 248, 256, 8); context.fillRect(0, 8, 5.5, 240); context.fillRect(250.5, 8, 5.5, 240);
    context.fillStyle = "rgba(255,244,220,.7)";
    for (let i = 1; i < 256; i += 4) { context.fillRect(i, 6.6, 2.4, 0.6); context.fillRect(i, 248.8, 2.4, 0.6); context.fillRect(4.3, i, 0.6, 2.4); context.fillRect(251.1, i, 0.6, 2.4); }
    // Brass eyelets through the hem for the lashings.
    for (let i = 0; i < 9; i += 1) for (const y of [3.8, 252.2]) {
      const x = 4 + i * 31;
      context.fillStyle = "#b08a3c"; context.beginPath(); context.arc(x, y, 2.5, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#e8cc82"; context.beginPath(); context.arc(x - 0.5, y - 0.5, 1.9, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#140c06"; context.beginPath(); context.arc(x, y, 1.2, 0, Math.PI * 2); context.fill();
    }
    // Weave and sun-fade.
    for (let i = 0; i < 5200; i += 1) {
      const shade = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},.05)`;
      if (random() < 0.5) context.fillRect(random() * 256, random() * 256, 2 + random() * 14, 1);
      else context.fillRect(random() * 256, random() * 256, 1, 2 + random() * 14);
    }
    // Individual threads.
    context.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < 1024; i += 3) {
      context.fillStyle = `rgba(0,0,0,${0.05 + random() * 0.07})`; context.fillRect(0, i, 1024, 1);
      context.fillStyle = `rgba(255,255,255,${0.02 + random() * 0.05})`; context.fillRect(i + 1, 0, 1, 1024);
    }
  }, true);
}

/** A knotted rug: borders, a field of medallions and fringed ends. */
function rugTexture(seed: number, ground: string, border: string, light: string, accent: string) {
  const texture = canvasTexture(1024, 2048, (context) => {
    const random = rng(seed);
    context.scale(4, 4);
    context.fillStyle = light; context.fillRect(0, 0, 256, 512);
    context.fillStyle = "rgba(60,40,20,.45)";
    for (let x = 2; x < 256; x += 5) { context.fillRect(x, 0, 1.5, 12); context.fillRect(x, 500, 1.5, 12); }
    context.fillStyle = border; context.fillRect(0, 12, 256, 488);
    context.fillStyle = light; context.fillRect(12, 24, 232, 464);
    context.fillStyle = ground; context.fillRect(20, 32, 216, 448);
    // Running border of small lozenges.
    for (let i = 0; i < 30; i += 1) {
      context.fillStyle = i % 2 ? accent : border;
      for (const [x, y] of [[16, 30 + i * 15.4], [240, 30 + i * 15.4]]) { context.beginPath(); context.moveTo(x, y - 5); context.lineTo(x + 4, y); context.lineTo(x, y + 5); context.lineTo(x - 4, y); context.fill(); }
    }
    const medallions = 3 + (seed % 2);
    for (let i = 0; i < medallions; i += 1) {
      const cy = 32 + (i + 0.5) * 448 / medallions, reach = 448 / medallions * 0.44;
      for (const [scale, colour] of [[1, border], [0.78, light], [0.6, accent], [0.34, ground], [0.16, light]] as Array<[number, string]>) {
        context.fillStyle = colour;
        context.beginPath(); context.moveTo(128, cy - reach * scale); context.lineTo(128 + 88 * scale, cy); context.lineTo(128, cy + reach * scale); context.lineTo(128 - 88 * scale, cy); context.closePath(); context.fill();
      }
      for (const side of [-1, 1]) for (const end of [-1, 1]) {
        context.fillStyle = accent;
        context.fillRect(128 + side * 78 - 7, cy + end * reach * 0.82 - 7, 14, 14);
        context.fillStyle = light;
        context.fillRect(128 + side * 78 - 3, cy + end * reach * 0.82 - 3, 6, 6);
      }
    }
    for (let i = 0; i < 4200; i += 1) {
      const shade = random() < 0.5 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},.06)`;
      context.fillRect(random() * 256, random() * 512, 2, 1);
    }
    // Small guard motifs along the field and the knots themselves.
    for (let i = 0; i < 56; i += 1) {
      context.fillStyle = i % 2 ? light : accent;
      for (const x of [27, 229]) { context.save(); context.translate(x, 38 + i * 7.9); context.rotate(Math.PI / 4); context.fillRect(-1.6, -1.6, 3.2, 3.2); context.restore(); }
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < 2048; i += 4) { context.fillStyle = `rgba(0,0,0,${0.06 + random() * 0.08})`; context.fillRect(0, i, 1024, 1); }
    for (let i = 0; i < 1024; i += 4) { context.fillStyle = "rgba(0,0,0,.07)"; context.fillRect(i, 0, 1, 2048); }
  });
  texture.anisotropy = 8;
  return texture;
}

/** Coarse woven surface (sacking, flat-weave): pale so colour comes from the material. */
function weaveTexture(step: number, contrast: number) {
  return canvasTexture(128, 128, (context) => {
    const random = rng(step * 13);
    context.fillStyle = "#d8d8d8";
    context.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += step) for (let x = 0; x < 128; x += step) {
      const over = ((x / step) + (y / step)) % 2 === 0, tone = Math.round(205 + (over ? 1 : -1) * contrast * 50 + random() * 22);
      context.fillStyle = `rgb(${tone},${tone},${tone})`;
      context.fillRect(x, y, step, step);
      context.fillStyle = "rgba(0,0,0,.28)";
      if (over) context.fillRect(x, y + step - 1, step, 1); else context.fillRect(x + step - 1, y, 1, step);
    }
  }, true);
}

/** A shop board lettered by hand: uneven baseline, a drop shadow and a painted rule. */
function signTexture(title: string, line: string, board: string, ink: string, trim: string, seed: number) {
  const texture = canvasTexture(2048, 384, (context) => {
    const random = rng(seed);
    context.scale(2, 2);
    context.fillStyle = board;
    context.fillRect(0, 0, 1024, 192);
    for (let i = 0; i < 1500; i += 1) {
      context.fillStyle = `rgba(${random() < 0.5 ? "255,240,210" : "0,0,0"},${0.02 + random() * 0.06})`;
      context.fillRect(random() * 1024, random() * 192, 20 + random() * 90, 1 + random() * 2);
    }
    context.strokeStyle = trim; context.lineWidth = 6; context.strokeRect(12, 12, 1000, 168);
    context.lineWidth = 2; context.strokeRect(24, 24, 976, 144);
    for (const x of [58, 966]) {
      context.fillStyle = trim;
      for (const turn of [0, Math.PI / 4]) { context.save(); context.translate(x, 96); context.rotate(turn); context.fillRect(-17, -17, 34, 34); context.restore(); }
      context.fillStyle = board;
      context.beginPath(); context.arc(x, 96, 9, 0, Math.PI * 2); context.fill();
    }
    context.textBaseline = "middle";
    let size = 84;
    context.font = `bold ${size}px Georgia, 'Times New Roman', serif`;
    const natural = [...title].reduce((sum, letter) => sum + context.measureText(letter).width + 5, 0);
    if (natural > 800) size = Math.floor(size * 800 / natural);
    context.font = `bold ${size}px Georgia, 'Times New Roman', serif`;
    const widths = [...title].map((letter) => context.measureText(letter).width + 5);
    let x = 512 - widths.reduce((sum, w) => sum + w, 0) / 2;
    [...title].forEach((letter, index) => {
      const lift = (random() - 0.5) * 6, tilt = (random() - 0.5) * 0.05;
      context.save(); context.translate(x, 80 + lift); context.rotate(tilt);
      context.fillStyle = "rgba(0,0,0,.4)"; context.fillText(letter, 4, 4);
      context.fillStyle = ink; context.fillText(letter, 0, 0);
      context.restore();
      x += widths[index];
    });
    context.font = "italic 34px Georgia, 'Times New Roman', serif";
    const room = 860 / context.measureText(line).width;
    if (room < 1) context.font = `italic ${Math.floor(34 * room)}px Georgia, 'Times New Roman', serif`;
    context.textAlign = "center";
    context.fillStyle = trim;
    context.fillText(line, 512, 146);
    // Weather: flaked paint and a faded lower edge.
    for (let i = 0; i < 520; i += 1) {
      context.fillStyle = `rgba(52,36,22,${0.15 + random() * 0.35})`;
      context.fillRect(random() * 1024, random() * 192, 1 + random() * 5, 1 + random() * 4);
    }
  });
  return texture;
}

/** Sets the largest font up to `size` at which `text` fits in `room` pixels, and returns that size. */
function fitFont(context: CanvasRenderingContext2D, text: string, font: (size: number) => string, size: number, room: number) {
  context.font = font(size);
  const wide = context.measureText(text).width;
  if (wide > room) context.font = font(size = Math.floor(size * room / wide));
  return size;
}

/** A painted board that hangs from a post: a drawing over two lines of lettering and the small print. */
function swingTexture(title: string[], lines: string[], board: string, ink: string, trim: string, seed: number, emblem: (context: CanvasRenderingContext2D) => void) {
  return canvasTexture(1024, 704, (context) => {
    const random = rng(seed);
    context.fillStyle = board;
    context.fillRect(0, 0, 1024, 704);
    for (let i = 0; i < 900; i += 1) {
      context.fillStyle = `rgba(${random() < 0.5 ? "255,240,210" : "0,0,0"},${0.02 + random() * 0.06})`;
      context.fillRect(random() * 1024, random() * 704, 30 + random() * 120, 1 + random() * 3);
    }
    context.strokeStyle = trim; context.lineWidth = 10; context.strokeRect(24, 24, 976, 656);
    context.lineWidth = 3; context.strokeRect(44, 44, 936, 616);
    context.save(); context.translate(512, 128); context.scale(0.74, 0.74); context.lineJoin = context.lineCap = "round"; emblem(context); context.restore();
    context.textAlign = "center"; context.textBaseline = "middle";
    let y = 214;
    for (const text of title) {
      const size = fitFont(context, text, (px) => `bold ${px}px Georgia, 'Times New Roman', serif`, 124, 850);
      y += size * 0.55;
      context.fillStyle = "rgba(0,0,0,.4)"; context.fillText(text, 516, y + 4);
      context.fillStyle = ink; context.fillText(text, 512, y);
      y += size * 0.55;
    }
    y += 10;
    for (const text of lines) {
      const size = fitFont(context, text, (px) => `italic ${px}px Georgia, 'Times New Roman', serif`, 40, 850);
      y += size * 0.62;
      context.fillStyle = trim; context.fillText(text, 512, y);
      y += size * 0.62;
    }
    for (let i = 0; i < 700; i += 1) {
      context.fillStyle = `rgba(52,36,22,${0.12 + random() * 0.3})`;
      context.fillRect(random() * 1024, random() * 704, 1 + random() * 5, 1 + random() * 4);
    }
  });
}

/** Chalked price slates in deal frames with one paper notice after them, on a sheet of 4 x 3 cells. */
function slateSheet(slates: string[][], notice: string[], seed: number) {
  return canvasTexture(2048, 1024, (context) => {
    const random = rng(seed), W = 512, H = 1024 / 3;
    const chalk = (px: number) => `bold ${px}px 'Chalkboard SE', 'Comic Sans MS', 'Segoe Print', 'Bradley Hand', cursive`;
    context.textAlign = "center"; context.textBaseline = "middle";
    [...slates, notice].forEach((lines, index) => {
      context.save();
      context.translate((index % 4) * W, Math.floor(index / 4) * H);
      context.beginPath(); context.rect(0, 0, W, H); context.clip();
      if (index === slates.length) {
        // The notice: cheap paper, a hen in brush and ink, and a plea.
        context.fillStyle = "#e6d9b8"; context.fillRect(0, 0, W, H);
        for (let i = 0; i < 60; i += 1) { context.fillStyle = `rgba(120,90,50,${0.02 + random() * 0.05})`; context.beginPath(); context.arc(random() * W, random() * H, 6 + random() * 40, 0, Math.PI * 2); context.fill(); }
        context.strokeStyle = "#2a2018"; context.lineWidth = 3; context.strokeRect(12, 12, W - 24, H - 24);
        context.save(); context.translate(112, 196); context.lineJoin = context.lineCap = "round";
        context.fillStyle = "#f4efe2"; context.strokeStyle = "#2a2018"; context.lineWidth = 5;
        context.beginPath(); context.ellipse(0, 10, 62, 46, -0.15, 0, Math.PI * 2); context.fill(); context.stroke();
        context.beginPath(); context.moveTo(-52, -10); context.quadraticCurveTo(-98, -58, -70, -74); context.quadraticCurveTo(-60, -40, -30, -30); context.closePath(); context.fill(); context.stroke();
        context.beginPath(); context.arc(52, -44, 25, 0, Math.PI * 2); context.fill(); context.stroke();
        context.fillStyle = "#b02216"; for (const [x, r] of [[42, 9], [54, 11], [66, 8]]) { context.beginPath(); context.arc(x, -70 - r * 0.3, r, 0, Math.PI * 2); context.fill(); }
        context.beginPath(); context.ellipse(72, -22, 6, 10, 0, 0, Math.PI * 2); context.fill();
        context.fillStyle = "#d9952b"; context.beginPath(); context.moveTo(75, -50); context.lineTo(100, -42); context.lineTo(75, -34); context.closePath(); context.fill();
        context.fillStyle = "#2a2018"; context.beginPath(); context.arc(58, -50, 4, 0, Math.PI * 2); context.fill();
        context.strokeStyle = "#d9952b"; context.lineWidth = 5;
        for (const x of [-12, 16]) { context.beginPath(); context.moveTo(x, 54); context.lineTo(x, 88); context.moveTo(x - 12, 96); context.lineTo(x, 88); context.lineTo(x + 14, 96); context.stroke(); }
        context.restore();
        context.fillStyle = "#2a2018";
        fitFont(context, lines[0], (px) => `bold ${px}px Georgia, 'Times New Roman', serif`, 92, 270);
        context.fillText(lines[0], 352, 74);
        lines.slice(1).forEach((text, row) => {
          fitFont(context, text, (px) => `${row === lines.length - 2 ? "italic " : ""}${px}px Georgia, 'Times New Roman', serif`, 31, 284);
          context.fillText(text, 352, 146 + row * 43);
        });
      } else {
        context.fillStyle = "#8a6a44"; context.fillRect(0, 0, W, H);
        for (let i = 0; i < 90; i += 1) { context.fillStyle = `rgba(${random() < 0.5 ? "40,24,10" : "230,200,150"},${0.05 + random() * 0.1})`; context.fillRect(random() * W, random() * H, 40 + random() * 160, 1 + random() * 2); }
        context.fillStyle = "#22262a"; context.fillRect(22, 22, W - 44, H - 44);
        // Old chalk wiped across the slate with a cloth.
        for (let i = 0; i < 46; i += 1) { context.fillStyle = `rgba(226,226,214,${0.015 + random() * 0.04})`; context.fillRect(22 + random() * (W - 180), 22 + random() * (H - 60), 60 + random() * 140, 6 + random() * 22); }
        lines.forEach((text, row) => {
          const size = fitFont(context, text, chalk, row ? 46 : 70, W - 84);
          context.save();
          context.translate(W / 2 + (random() - 0.5) * 10, row ? 116 + row * 70 + (size - 46) * 0.2 : 84);
          context.rotate((random() - 0.5) * 0.05);
          context.fillStyle = row === lines.length - 1 && row > 0 ? "#f0cf66" : row ? "#eadfc6" : "#f4f1e6";
          context.fillText(text, 0, 0);
          if (!row) context.fillRect(-context.measureText(text).width / 2, size * 0.56, context.measureText(text).width, 4);
          context.restore();
        });
        // The slate's tooth shows through the strokes.
        context.fillStyle = "rgba(34,38,42,.55)";
        for (let i = 0; i < 2600; i += 1) context.fillRect(22 + random() * (W - 44), 22 + random() * (H - 44), 1 + random() * 1.6, 1 + random() * 1.6);
      }
      context.restore();
    });
  });
}

/** A board whose two faces carry the whole texture and whose edges take the paint at its margin. */
function boardGeometry(width: number, height: number, thick: number) {
  const geometry = new THREE.BoxGeometry(width, height, thick), uv = geometry.attributes.uv;
  for (let i = 0; i < 16; i += 1) uv.setXY(i, 0.5 + uv.getX(i) * 0.01, 0.012);
  return geometry;
}

/** A lamp-lit room seen through a window: plastered wall, a hanging lamp, a shelf of jars, a niche and a wall hanging. */
function roomTexture(wide: boolean, seed: number) {
  const w = wide ? 1024 : 512;
  return canvasTexture(w, 512, (context) => {
    const random = rng(seed);
    const wall = context.createLinearGradient(0, 0, 0, 512);
    wall.addColorStop(0, "#f0bd72"); wall.addColorStop(0.6, "#c98440"); wall.addColorStop(1, "#8a4a1c");
    context.fillStyle = wall;
    context.fillRect(0, 0, w, 512);
    for (let i = 0; i < 1400; i += 1) {
      context.fillStyle = `rgba(${random() < 0.5 ? "255,236,190" : "70,30,8"},${0.02 + random() * 0.05})`;
      context.fillRect(random() * w, random() * 512, 2 + random() * 10, 2 + random() * 6);
    }
    // Ceiling joists.
    context.fillStyle = "#4a2610";
    context.fillRect(0, 0, w, 26);
    for (let x = 20; x < w; x += 92) context.fillRect(x, 0, 26, 44);
    // A niche with a round head, and a striped hanging.
    const niche = wide ? w * 0.5 : w * 0.2;
    context.fillStyle = "rgba(96,44,14,.75)";
    context.beginPath(); context.moveTo(niche - 46, 330); context.lineTo(niche - 46, 200); context.arc(niche, 200, 46, Math.PI, 0); context.lineTo(niche + 46, 330); context.closePath(); context.fill();
    context.fillStyle = "#2f6a66"; context.beginPath(); context.ellipse(niche, 300, 20, 30, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#1f4a48"; context.fillRect(niche - 9, 256, 18, 18);
    const hang = wide ? w * 0.86 : w * 0.82;
    ["#8c2f25", "#e3c58f", "#24506a", "#d58a2e", "#8c2f25", "#e3c58f", "#6a2438"].forEach((colour, index) => { context.fillStyle = colour; context.fillRect(hang - 50, 90 + index * 34, 100, 34); });
    context.fillStyle = "#3a1c08"; context.fillRect(hang - 58, 84, 116, 7);
    // Shelf of jars and bottles.
    const from = wide ? w * 0.08 : w * 0.34, span = wide ? w * 0.26 : w * 0.3;
    context.fillStyle = "#4a2610"; context.fillRect(from - 8, 262, span + 16, 9);
    for (let x = from; x < from + span - 16; x += 26 + random() * 14) {
      const tall = 26 + random() * 46, wide2 = 16 + random() * 12;
      context.fillStyle = ["#6a3013", "#2f5a5a", "#7c2a22", "#b8742a", "#3a3f6e"][Math.floor(random() * 5)];
      context.beginPath(); context.ellipse(x + wide2 / 2, 262 - tall * 0.45, wide2 / 2, tall * 0.45, 0, 0, Math.PI * 2); context.fill();
      context.fillRect(x + wide2 / 2 - 4, 262 - tall, 8, tall * 0.4);
    }
    // Dado and a low divan.
    context.fillStyle = "rgba(84,36,12,.6)"; context.fillRect(0, 352, w, 160);
    context.fillStyle = "#4a2410"; context.fillRect(0, 348, w, 8);
    context.fillStyle = "#7c2a22"; context.fillRect(0, 430, w, 82);
    for (let x = 0; x < w; x += 36) { context.fillStyle = x % 72 ? "#d58a2e" : "#e3c58f"; context.fillRect(x + 8, 444, 18, 8); }
    // Hanging lamps and their light on the wall.
    for (const x of wide ? [w * 0.27, w * 0.7] : [w * 0.56]) {
      const glow = context.createRadialGradient(x, 150, 6, x, 150, 330);
      glow.addColorStop(0, "rgba(255,246,214,1)"); glow.addColorStop(0.22, "rgba(255,214,136,.8)"); glow.addColorStop(1, "rgba(255,180,90,0)");
      context.fillStyle = glow; context.fillRect(0, 0, w, 512);
      context.fillStyle = "#2a1406"; context.fillRect(x - 2, 26, 4, 88);
      context.fillRect(x - 24, 110, 48, 8); context.fillRect(x - 15, 172, 30, 8); context.fillRect(x - 5, 180, 10, 10);
      context.fillStyle = "#fff6dc"; context.beginPath(); context.ellipse(x, 145, 21, 28, 0, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(60,26,8,.8)";
      for (const dx of [-12, 0, 12]) context.fillRect(x + dx - 1.5, 118, 3, 54);
    }
  });
}

/** Turned-spindle window screen with a clear background: square bays with a bead at each crossing. */
function screenTexture() {
  const texture = canvasTexture(512, 512, (context) => {
    const random = rng(171);
    context.fillStyle = "#7a5230";
    context.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i += 1) {
      context.fillStyle = `rgba(${random() < 0.5 ? "255,220,170" : "20,10,0"},.1)`;
      context.fillRect(random() * 512, random() * 512, 1, 3 + random() * 10);
    }
    context.globalCompositeOperation = "destination-out";
    context.fillStyle = "#000";
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
      const x = column * 64 + 32, y = row * 64 + 32, r = 25, c = 9;
      context.beginPath();
      context.moveTo(x - r + c, y - r); context.lineTo(x + r - c, y - r); context.lineTo(x + r, y - r + c); context.lineTo(x + r, y + r - c);
      context.lineTo(x + r - c, y + r); context.lineTo(x - r + c, y + r); context.lineTo(x - r, y + r - c); context.lineTo(x - r, y - r + c);
      context.closePath(); context.fill();
    }
    context.globalCompositeOperation = "source-over";
    for (let row = 0; row <= 8; row += 1) for (let column = 0; column <= 8; column += 1) {
      context.fillStyle = "#8a6038"; context.beginPath(); context.arc(column * 64, row * 64, 11, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(40,20,6,.55)"; context.beginPath(); context.arc(column * 64 + 1.5, row * 64 + 2, 5, 0, Math.PI * 2); context.fill();
    }
  }, true);
  texture.anisotropy = 8;
  return texture;
}

/** A stone gutter with kerbs, a dished channel and an iron grating in every length. One tile is 0.42 m by 1.68 m. */
function drainTextures() {
  return reliefTextures(256, (context) => {
    const random = rng(53);
    context.fillStyle = "#8a7b68"; context.fillRect(0, 0, 256, 256);
    const dish = context.createLinearGradient(56, 0, 200, 0);
    dish.addColorStop(0, "#5a4c3c"); dish.addColorStop(0.5, "#2c241b"); dish.addColorStop(1, "#5a4c3c");
    context.fillStyle = dish; context.fillRect(56, 0, 144, 256);
    context.fillStyle = "rgba(20,12,6,.7)";
    for (const y of [0, 84, 170]) context.fillRect(0, y, 256, 1.5);
    context.fillRect(55, 0, 2, 256); context.fillRect(199, 0, 2, 256);
    // Grating: a frame and crossbars.
    context.fillStyle = "#17130f"; context.fillRect(60, 186, 136, 56);
    context.fillStyle = "#4a3f33";
    context.fillRect(60, 186, 136, 3); context.fillRect(60, 239, 136, 3); context.fillRect(60, 186, 3, 56); context.fillRect(193, 186, 3, 56);
    for (let x = 72; x < 190; x += 12) context.fillRect(x, 189, 4, 50);
    for (let i = 0; i < 2200; i += 1) {
      context.fillStyle = `rgba(${random() < 0.5 ? "255,236,200" : "16,10,4"},${0.04 + random() * 0.08})`;
      context.fillRect(random() * 256, random() * 256, 1 + random() * 2, 1 + random() * 1.5);
    }
    // Damp in the bottom of the channel.
    const damp = context.createLinearGradient(100, 0, 156, 0);
    damp.addColorStop(0, "rgba(10,8,6,0)"); damp.addColorStop(0.5, "rgba(10,8,6,.55)"); damp.addColorStop(1, "rgba(10,8,6,0)");
    context.fillStyle = damp; context.fillRect(100, 0, 56, 256);
  }, (context) => {
    context.fillStyle = "#e0e0e0"; context.fillRect(0, 0, 256, 256);
    const dish = context.createLinearGradient(56, 0, 200, 0);
    dish.addColorStop(0, "#b0b0b0"); dish.addColorStop(0.5, "#303030"); dish.addColorStop(1, "#b0b0b0");
    context.fillStyle = dish; context.fillRect(56, 0, 144, 256);
    context.fillStyle = "#606060";
    for (const y of [0, 84, 170]) context.fillRect(0, y, 256, 2);
    context.fillStyle = "#181818"; context.fillRect(60, 186, 136, 56);
    context.fillStyle = "#c8c8c8";
    context.fillRect(60, 186, 136, 3); context.fillRect(60, 239, 136, 3); context.fillRect(60, 186, 3, 56); context.fillRect(193, 186, 3, 56);
    for (let x = 72; x < 190; x += 12) context.fillRect(x, 189, 4, 50);
  }, 3, 2);
}

/** A panel of glazed star tiles inside a border, a few of them chipped or lost. */
function tilePanelTexture(seed: number, ground: string, star: string, eye: string, border: string) {
  const texture = canvasTexture(512, 1024, (context) => {
    const random = rng(seed);
    context.fillStyle = border; context.fillRect(0, 0, 512, 1024);
    context.fillStyle = ground; context.fillRect(10, 10, 492, 1004);
    context.fillStyle = border; context.fillRect(20, 20, 472, 984);
    const cell = 118, left = 20, top = 30;
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 4; column += 1) {
      const x = left + column * cell, y = top + row * cell + 10, cx = x + cell / 2, cy = y + cell / 2;
      if (random() < 0.05) { context.fillStyle = "#b9a887"; context.fillRect(x + 1, y + 1, cell - 2, cell - 2); continue; }
      const tone = 0.9 + random() * 0.2;
      context.globalAlpha = 1;
      context.fillStyle = ground; context.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      context.fillStyle = star;
      for (const turn of [0, Math.PI / 4]) { context.save(); context.translate(cx, cy); context.rotate(turn); context.fillRect(-36, -36, 72, 72); context.restore(); }
      context.fillStyle = ground; context.beginPath(); context.arc(cx, cy, 24, 0, Math.PI * 2); context.fill();
      context.fillStyle = eye; context.beginPath(); context.arc(cx, cy, 14, 0, Math.PI * 2); context.fill();
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { context.beginPath(); context.arc(x + dx * cell, y + dy * cell, 20, 0, Math.PI * 2); context.fill(); }
      context.fillStyle = `rgba(${tone > 1 ? "255,255,255" : "0,0,0"},${Math.abs(tone - 1) * 0.8})`; context.fillRect(x, y, cell, cell);
      // Glaze highlight and a chip now and then.
      const shine = context.createLinearGradient(x, y, x + cell, y + cell);
      shine.addColorStop(0, "rgba(255,255,255,.16)"); shine.addColorStop(0.5, "rgba(255,255,255,0)");
      context.fillStyle = shine; context.fillRect(x, y, cell, cell);
      if (random() < 0.3) { context.fillStyle = "#c9b894"; context.beginPath(); context.arc(x + (random() < 0.5 ? 4 : cell - 4), y + random() * cell, 4 + random() * 9, 0, Math.PI * 2); context.fill(); }
    }
    context.strokeStyle = "rgba(40,30,20,.7)"; context.lineWidth = 2;
    for (let column = 0; column <= 4; column += 1) { context.beginPath(); context.moveTo(left + column * cell, top + 10); context.lineTo(left + column * cell, top + 10 + cell * 8); context.stroke(); }
    for (let row = 0; row <= 8; row += 1) { context.beginPath(); context.moveTo(left, top + 10 + row * cell); context.lineTo(left + cell * 4, top + 10 + row * cell); context.stroke(); }
    for (let i = 0; i < 900; i += 1) { context.fillStyle = `rgba(30,20,10,${0.04 + random() * 0.1})`; context.fillRect(random() * 512, random() * 1024, 1 + random() * 3, 1 + random() * 3); }
  });
  texture.anisotropy = 8;
  return texture;
}

/** Tangent-space normals of hand-planished sheet metal: overlapping shallow hammer marks. Tiles. */
function hammeredNormal() {
  const { map, normalMap } = reliefTextures(256, () => {}, (context) => {
    const random = rng(733);
    context.fillStyle = "#808080"; context.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 520; i += 1) {
      const x = random() * 256, y = random() * 256, r = 7 + random() * 9;
      for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) {
        const dent = context.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        dent.addColorStop(0, "rgba(40,40,40,.55)"); dent.addColorStop(0.7, "rgba(110,110,110,.25)"); dent.addColorStop(1, "rgba(160,160,160,0)");
        context.fillStyle = dent; context.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
  }, 2.2);
  map.dispose();
  normalMap.repeat.set(3, 3);
  return normalMap;
}

function lathe(points: number[][], segments = 14) {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}

/** Turned profiles, radius then height. */
const TURNED = {
  jar: [[0, 0], [0.09, 0], [0.1, 0.012], [0.14, 0.1], [0.15, 0.2], [0.11, 0.3], [0.075, 0.34], [0.085, 0.37], [0.07, 0.372], [0.06, 0.34], [0, 0.33]],
  bowl: [[0, 0], [0.06, 0], [0.065, 0.015], [0.13, 0.07], [0.16, 0.12], [0.15, 0.125], [0.12, 0.08], [0, 0.04]],
  lid: [[0, 0], [0.15, 0], [0.16, 0.015], [0.08, 0.05], [0.03, 0.06], [0.04, 0.09], [0, 0.1]],
  glass: [[0, 0], [0.022, 0], [0.024, 0.004], [0.016, 0.03], [0.026, 0.06], [0.028, 0.085], [0.025, 0.085], [0.014, 0.034], [0, 0.03]],
  flatTray: [[0, 0], [0.3, 0], [0.33, 0.012], [0.34, 0.03], [0.325, 0.03], [0.3, 0.014], [0.12, 0.014], [0.1, 0.02], [0, 0.02]],
  pan: [[0, 0], [0.06, 0], [0.11, 0.025], [0.115, 0.04], [0.105, 0.04], [0.06, 0.012], [0, 0.012]],
  samovar: [[0, 0], [0.14, 0], [0.15, 0.03], [0.1, 0.06], [0.1, 0.1], [0.17, 0.16], [0.19, 0.36], [0.17, 0.5], [0.1, 0.56], [0.08, 0.62], [0.12, 0.66], [0.12, 0.68], [0.05, 0.72], [0.05, 0.8], [0.09, 0.83], [0.02, 0.9], [0, 0.9]],
  brazier: [[0, 0.04], [0.12, 0], [0.24, 0.1], [0.27, 0.16], [0.25, 0.165], [0.22, 0.11], [0, 0.06]],
  flowerpot: [[0, 0], [0.05, 0], [0.075, 0.1], [0.085, 0.1], [0.085, 0.12], [0.065, 0.12], [0, 0.11]],
};

/** Carved bracket: a scrolled knee standing out from a wall along +z, hanging below its top edge. */
function bracketGeometry(reach = 0.24, drop = 0.26, thick = 0.035) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(reach, 0); shape.lineTo(reach, -0.03);
  shape.bezierCurveTo(reach * 0.55, -0.04, reach * 0.5, -drop * 0.45, reach * 0.3, -drop * 0.55);
  shape.bezierCurveTo(reach * 0.2, -drop * 0.62, 0.05, -drop * 0.7, 0.03, -drop);
  shape.lineTo(0, -drop); shape.closePath();
  const eye = new THREE.Path();
  eye.absarc(reach * 0.2, -drop * 0.24, Math.min(reach, drop) * 0.1, 0, Math.PI * 2, true);
  shape.holes.push(eye);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 6 });
  geometry.translate(0, 0, -thick / 2);
  geometry.rotateY(-Math.PI / 2);
  return projectUv(geometry, 1.3);
}

/** Fretwork valance hanging from y = 0: a scalloped lower edge, pierced with rounds and lozenges. */
function fretGeometry(width: number, height: number) {
  const count = Math.max(2, Math.round(width / 0.21)), step = width / count, base = -height + step / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0); shape.lineTo(width / 2, 0); shape.lineTo(width / 2, base);
  for (let i = count - 1; i >= 0; i -= 1) shape.absarc(-width / 2 + (i + 0.5) * step, base, step / 2, 0, Math.PI, true);
  shape.closePath();
  for (let i = 0; i < count; i += 1) {
    const x = -width / 2 + (i + 0.5) * step;
    const round = new THREE.Path(); round.absarc(x, base, step * 0.22, 0, Math.PI * 2, true); shape.holes.push(round);
    if (i > 0) {
      const lozenge = new THREE.Path(), lx = x - step / 2, ly = base * 0.42;
      lozenge.moveTo(lx, ly + 0.028); lozenge.lineTo(lx + 0.018, ly); lozenge.lineTo(lx, ly - 0.028); lozenge.lineTo(lx - 0.018, ly); lozenge.closePath();
      shape.holes.push(lozenge);
    }
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: false, curveSegments: 5 });
  return projectUv(geometry, 1.3);
}

/** One louvred shutter leaf, 0.52 m by 1.5 m, centred. */
function shutterGeometry() {
  const parts: THREE.BufferGeometry[] = [
    box(0.055, 1.5, 0.04, -0.2325, 0, 0), box(0.055, 1.5, 0.04, 0.2325, 0, 0),
    box(0.41, 0.075, 0.04, 0, 0.7125, 0), box(0.41, 0.075, 0.04, 0, -0.7125, 0), box(0.41, 0.06, 0.04, 0, 0, 0),
    box(0.02, 1.36, 0.012, 0, 0, 0.026),
  ];
  for (const half of [-1, 1]) for (let i = 0; i < 8; i += 1) {
    parts.push(worldBox(0.41, 0.012, 0.055, 1.3).rotateX(0.62).translate(0, half * (0.07 + i * 0.082), 0));
  }
  return merge(parts);
}

/** A flat panel of crossed diagonal laths in the XZ plane, cut to a rectangle. */
function latticePanelGeometry(width: number, depth: number, spacing: number, lath: number, thick: number) {
  const parts: THREE.BufferGeometry[] = [], reach = (width + depth) / 2;
  for (const sign of [-1, 1]) for (let c = -reach; c <= reach; c += spacing * Math.SQRT2) {
    const from = Math.max(-depth / 2, sign > 0 ? -width / 2 - c : c - width / 2), to = Math.min(depth / 2, sign > 0 ? width / 2 - c : c + width / 2);
    if (to - from < 0.1) continue;
    const z = (from + to) / 2;
    parts.push(new THREE.BoxGeometry((to - from) * Math.SQRT2, thick, lath).rotateY(-sign * Math.PI / 4).translate(c + sign * z, sign * thick * 0.5, z));
  }
  return merge(parts);
}

/**
 * A tunic on a hanger: stand collar, sloped shoulders, a body that opens into folds toward the hem,
 * sleeves hanging at its sides, and a placket, cuffs and hem band in a second colour.
 * Origin on the rail it hangs from; `length` is collar to hem.
 */
function garmentGeometry(length: number, seed: number, colour: THREE.Color, trim: THREE.Color) {
  const positions: number[] = [], uvs: number[] = [], colours: number[] = [], indices: number[] = [];
  type Ring = { centre: V3; across: V3; up: V3; a: number; b: number; fold: number; tint: THREE.Color; v: number };
  const swell = (fold: number, angle: number) => 1 + fold * Math.sin(angle * 5 + seed) + fold * 0.5 * Math.sin(angle * 9 + seed * 2.3);
  const tube = (rings: Ring[], segments: number) => {
    const base = positions.length / 3;
    rings.forEach(({ centre, across, up, a, b, fold, tint, v }) => {
      for (let i = 0; i <= segments; i += 1) {
        const angle = i / segments * Math.PI * 2, wave = swell(fold, angle);
        const p = Math.cos(angle) * a * wave, q = Math.sin(angle) * b * wave;
        positions.push(centre[0] + across[0] * p + up[0] * q, centre[1] + across[1] * p + up[1] * q, centre[2] + across[2] * p + up[2] * q);
        uvs.push(i / segments * 3, v * 3);
        colours.push(tint.r, tint.g, tint.b);
      }
    });
    for (let r = 0; r < rings.length - 1; r += 1) for (let i = 0; i < segments; i += 1) {
      const p = base + r * (segments + 1) + i, q = p + segments + 1;
      indices.push(p, p + 1, q, p + 1, q + 1, q);
    }
  };
  const X: V3 = [1, 0, 0], Z: V3 = [0, 0, 1], top = -0.07, shade = colour.clone().multiplyScalar(0.82);
  const ring = (y: number, a: number, b: number, fold: number, tint: THREE.Color, sway = 0): Ring => ({
    centre: [Math.sin(seed + sway * 2) * 0.014 * sway, top - y, Math.sin(seed * 1.7 + sway * 3) * 0.024 * sway], across: X, up: Z, a, b, fold, tint, v: y,
  });
  const body: Ring[] = [
    ring(0, 0.062, 0.05, 0, trim), ring(0.032, 0.066, 0.056, 0, trim), ring(0.032, 0.066, 0.056, 0, colour),
    ring(0.058, 0.19, 0.05, 0, colour), ring(0.095, 0.236, 0.064, 0, colour), ring(0.25, 0.242, 0.088, 0.012, colour),
  ];
  const skirt = length - 0.25, band = 0.07 / skirt;
  for (const t of [0.2, 0.4, 0.6, 0.8, 1 - band, 1 - band, 1]) {
    const hem = body.length >= 11;
    body.push(ring(0.25 + t * skirt, 0.242 + t * 0.07, 0.088 + t * 0.035, 0.012 + t * 0.1, hem ? trim : t > 0.7 ? shade : colour, t));
  }
  tube(body, 20);
  // Sleeves hang from the shoulder seam, a little away from the body.
  for (const side of [-1, 1]) {
    const slant = 0.3, along: V3 = [side * Math.sin(slant), -Math.cos(slant), 0], across: V3 = [side * Math.cos(slant), Math.sin(slant), 0];
    tube([0, 0.16, 0.33, 0.47, 0.47, 0.53].map((d, index) => ({
      centre: [side * 0.2 + along[0] * d, top - 0.085 + along[1] * d, Math.sin(seed * 2.1 + side + d * 4) * 0.012] as V3, across, up: Z,
      a: 0.07 - d * 0.02, b: 0.056 - d * 0.014, fold: 0.02 + d * 0.12, tint: index >= 4 ? trim : colour, v: d,
    })), 10);
  }
  // Placket down the chest, standing a stitch proud of the cloth.
  const placket = positions.length / 3, steps = 7;
  for (let i = 0; i <= steps; i += 1) {
    const y = 0.032 + (0.46 - 0.032) * i / steps;
    // The body's own front at this height, read off the rings either side of it.
    let k = 2;
    while (k < body.length - 2 && body[k + 1].v < y) k += 1;
    const lower = body[k], upper = body[k + 1], f = Math.min(1, Math.max(0, (y - lower.v) / Math.max(1e-4, upper.v - lower.v)));
    const front = (r: Ring) => r.centre[2] + r.b * swell(r.fold, Math.PI / 2);
    const z = front(lower) * (1 - f) + front(upper) * f + 0.004, x = lower.centre[0] * (1 - f) + upper.centre[0] * f;
    for (const dx of [-0.02, 0.02]) { positions.push(x + dx, top - y, z); uvs.push(dx * 3, y * 3); colours.push(trim.r, trim.g, trim.b); }
    if (i < steps) indices.push(placket + i * 2, placket + i * 2 + 2, placket + i * 2 + 1, placket + i * 2 + 1, placket + i * 2 + 2, placket + i * 2 + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The town beyond the far gable, seen through its lattice against the sky: three ranks of flat-roofed
 * houses with parapets, oriels and roof huts, two towers and domes, stepping back into the dust.
 * It is never lit: the sun (which stands behind it), the sky and the air between are baked into vertex
 * colours, so the whole town is one unlit draw call that neither casts nor takes a shadow. The palms
 * that stand among the houses are real trees, planted by the map so they move in its wind.
 */
function townGeometry(toSun: THREE.Vector3, fine: boolean) {
  const random = rng(977), parts: THREE.BufferGeometry[] = [];
  const HAZE = new THREE.Color(0.2, 0.235, 0.33), SUN = new THREE.Color(0.75, 0.62, 0.45), SKY = new THREE.Color(0.07, 0.085, 0.125), BOUNCE = new THREE.Color(0.1, 0.075, 0.05);
  const from = new THREE.Vector3(0, 1.6, -10), normal = new THREE.Vector3(), point = new THREE.Vector3(), light = new THREE.Color(), tint = new THREE.Color();
  /** Files a piece with sun, sky and the dust between here and there baked into its colours. */
  const add = (source: THREE.BufferGeometry, albedo: THREE.ColorRepresentation) => {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const position = geometry.attributes.position, normals = geometry.attributes.normal, colours = new Float32Array(position.count * 3);
    tint.set(albedo);
    for (let i = 0; i < position.count; i += 1) {
      normal.fromBufferAttribute(normals, i); point.fromBufferAttribute(position, i);
      const up = 0.5 + 0.5 * normal.y, away = Math.max(0, point.distanceTo(from) - 18);
      const sky = 0.35 + 0.65 * up, bounce = 1 - up, sun = Math.max(0, normal.dot(toSun));
      light.setRGB(SKY.r * sky + BOUNCE.r * bounce + SUN.r * sun, SKY.g * sky + BOUNCE.g * bounce + SUN.g * sun, SKY.b * sky + BOUNCE.b * bounce + SUN.b * sun);
      light.multiply(tint).lerp(HAZE, Math.min(0.9, 1 - Math.exp(-away / 105) + 0.08 * Math.max(0, 1 - point.y / 16)));
      colours[i * 3] = light.r; colours[i * 3 + 1] = light.g; colours[i * 3 + 2] = light.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.deleteAttribute("uv");
    parts.push(geometry);
  };
  const block = (w: number, h: number, d: number, x: number, y: number, z: number, colour: THREE.ColorRepresentation, yaw = 0) => add(new THREE.BoxGeometry(w, h, d).rotateY(yaw).translate(x, y, z), colour);
  const WASHES = [0xd9c3a0, 0xc9a97c, 0xe2d2b4, 0xb98a5e, 0xd0b48a, 0xc79a78, 0xe6dcc6, 0xb7926a], TIMBER = 0x4a3526, DARK = 0x1c1410;
  const PAINTS = [0x2f6f6a, 0x8a3a2a, 0x3c5a80, 0xb9862f, 0x556b3a];
  /** Nothing below the gable masonry can be seen from the hall, so the town starts in mid-air. */
  const FLOOR = 4.5;
  const dome = (x: number, y: number, z: number, radius: number, colour: THREE.ColorRepresentation) => {
    add(new THREE.CylinderGeometry(radius * 1.04, radius * 1.08, radius * 0.5, 14).translate(x, y + radius * 0.25, z), colour);
    add(new THREE.SphereGeometry(radius, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.12, 1).translate(x, y + radius * 0.5, z), colour);
    add(new THREE.CylinderGeometry(0.03, 0.05, radius * 0.9, 5).translate(x, y + radius * 2.02, z), DARK);
    add(new THREE.SphereGeometry(radius * 0.11, 6, 5).translate(x, y + radius * 1.78, z), 0xb9862f);
  };
  /** A flat-roofed house: `rank` 0 is the row standing against the hall, 2 the far one, which gets a silhouette only. */
  const house = (x: number, z: number, w: number, d: number, h: number, rank: number) => {
    const wash = WASHES[Math.floor(random() * WASHES.length)], front = z + d / 2;
    block(w, h - FLOOR, d, x, (h + FLOOR) / 2, z, wash);
    block(w + 0.26, 0.2, d + 0.26, x, h - 0.02, z, wash);
    block(w + 0.1, 0.5, d + 0.1, x, h + 0.33, z, wash);
    // What stands up off the roof: corner piers, a stair hut, a wind tower, a dome.
    for (const side of [-1, 1]) block(0.5, 0.55, 0.5, x + side * (w / 2 - 0.2), h + 0.82, front - 0.2, wash);
    const crown = random();
    if (crown < 0.42) {
      const hw = w * (0.3 + random() * 0.2), hx = x + (random() - 0.5) * (w - hw), hh = 2.1 + random() * 1.2;
      block(hw, hh, d * 0.5, hx, h + hh / 2, z - d * 0.1, wash);
      block(hw + 0.2, 0.16, d * 0.5 + 0.2, hx, h + hh, z - d * 0.1, wash);
      if (rank < 2) block(0.55, 1.0, 0.06, hx, h + hh - 0.85, z - d * 0.1 + d * 0.25 + 0.04, DARK);
    } else if (crown < 0.62) {
      const tx = x + (random() - 0.5) * (w - 1.6), th = 2.6 + random() * 1.4;
      block(1.25, th, 1.25, tx, h + th / 2, z, wash);
      block(1.45, 0.14, 1.45, tx, h + th, z, wash);
      for (const slot of [-0.3, 0, 0.3]) block(0.16, th * 0.42, 0.06, tx + slot, h + th * 0.68, z + 0.66, DARK);
    } else if (crown < 0.8) dome(x + (random() - 0.5) * (w - 3.4), h + 0.1, z, 1.1 + random() * 0.7, random() < 0.5 ? wash : 0x4f8f8a);
    if (rank === 2) return;
    // The side turned to the hall: windows with lintels and shutters, a boxed timber oriel, beam ends under the coping.
    const columns = Math.max(1, Math.floor(w / 2.3));
    for (let row = 0; row < 2; row += 1) {
      const y = h - 2 - row * 3.1;
      if (y < FLOOR + 1.6) continue;
      for (let c = 0; c < columns; c += 1) {
        const wx = x + (c - (columns - 1) / 2) * (w / columns) + (random() - 0.5) * 0.3, kind = random();
        if (kind < 0.16) continue;
        if (kind < 0.36 && rank === 0) {
          // Oriel: a timber box on brackets with a screen front and its own little roof.
          block(1.5, 1.7, 0.62, wx, y, front + 0.31, TIMBER);
          block(1.7, 0.1, 0.8, wx, y + 0.9, front + 0.36, TIMBER);
          block(1.2, 1.0, 0.05, wx, y + 0.1, front + 0.645, DARK);
          for (const side of [-1, 1]) block(0.09, 0.5, 0.5, wx + side * 0.6, y - 1.05, front + 0.22, TIMBER);
          continue;
        }
        block(0.78, 1.3, 0.08, wx, y, front + 0.04, DARK);
        block(1.06, 0.14, 0.16, wx, y + 0.74, front + 0.08, wash);
        block(1.0, 0.1, 0.2, wx, y - 0.7, front + 0.1, wash);
        if (fine && kind > 0.6) {
          const paint = PAINTS[Math.floor(random() * PAINTS.length)];
          for (const side of [-1, 1]) block(0.4, 1.26, 0.05, wx + side * 0.58, y, front + 0.12, paint, side * (0.25 + random() * 0.9));
        }
      }
    }
    if (fine && rank === 0) for (let bx = -w / 2 + 0.5; bx < w / 2 - 0.3; bx += 0.85) block(0.11, 0.11, 0.34, x + bx, h - 0.42, front + 0.17, TIMBER);
    // Washing strung between two poles on the roof.
    if (fine && rank === 0 && random() < 0.6) {
      const y = h + 2.1, x0 = x - w * 0.32, x1 = x + w * 0.32, lz = front - 0.6;
      for (const px of [x0, x1]) add(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 5).translate(px, h + 1.2, lz), TIMBER);
      add(new THREE.CylinderGeometry(0.012, 0.012, x1 - x0, 4).rotateZ(Math.PI / 2).translate((x0 + x1) / 2, y, lz), DARK);
      for (let lx = x0 + 0.4; lx < x1 - 0.6; lx += 0.75 + random() * 0.5) {
        const cw = 0.5 + random() * 0.35, ch = 0.7 + random() * 0.5;
        add(new THREE.PlaneGeometry(cw, ch, 2, 1).translate(lx, y - ch / 2, lz).rotateY(0), [0xe8dcc0, 0xa8322a, 0x27508a, 0xd9952b, 0xe8dcc0, 0x2f8f88][Math.floor(random() * 6)]);
      }
    }
  };
  /** A square tower with string courses, a gallery, an open lantern and a pointed cap. */
  const tower = (x: number, z: number, height: number, girth: number, wash: number) => {
    const shaft = height - FLOOR;
    add(new THREE.CylinderGeometry(girth * 0.62, girth * 0.74, shaft, 4, 1).rotateY(Math.PI / 4).translate(x, FLOOR + shaft / 2, z), wash);
    for (const t of [0.45, 0.7, 0.9]) { const g = girth * (0.74 - 0.12 * t) * Math.SQRT2 + 0.14; block(g, 0.16, g, x, FLOOR + shaft * t, z, wash); }
    for (const t of [0.56, 0.8]) block(0.3, 1.1, 0.06, x, FLOOR + shaft * t, z + girth * (0.74 - 0.12 * t) * Math.SQRT1_2 + 0.02, DARK);
    const gallery = girth * 1.25;
    block(gallery, 0.22, gallery, x, height + 0.11, z, wash);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) block(0.08, 0.85, 0.08, x + sx * (gallery / 2 - 0.06), height + 0.64, z + sz * (gallery / 2 - 0.06), TIMBER);
    for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) block(sx ? 0.06 : gallery, 0.07, sz ? 0.06 : gallery, x + sx * (gallery / 2 - 0.06), height + 1.05, z + sz * (gallery / 2 - 0.06), TIMBER);
    const stage = girth * 0.72;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) block(0.2, 2.3, 0.2, x + sx * stage / 2, height + 1.37, z + sz * stage / 2, wash);
    block(stage + 0.5, 0.2, stage + 0.5, x, height + 2.6, z, wash);
    add(new THREE.ConeGeometry(stage * 0.82, girth * 1.1, 4, 1).rotateY(Math.PI / 4).translate(x, height + 2.7 + girth * 0.55, z), 0x4f8f8a);
    add(new THREE.SphereGeometry(0.16, 7, 5).translate(x, height + 2.75 + girth * 1.1, z), 0xb9862f);
    add(new THREE.CylinderGeometry(0.02, 0.03, 0.9, 4).translate(x, height + 3.2 + girth * 1.1, z), DARK);
  };

  // First rank: houses hard up against the hall, shoulder to shoulder with an alley here and there.
  for (let x = -34; x < 34;) {
    const w = 5 + random() * 4.5, h = 7.6 + random() * 2.6;
    house(x + w / 2, -37.5 - random() * 2.5, w, 6 + random() * 2, h, 0);
    x += w + (random() < 0.3 ? 1.6 + random() * 1.4 : 0.05);
  }
  // Second rank, taller, across a street.
  for (let x = -50; x < 50;) {
    const w = 6 + random() * 6, h = 11 + random() * 5;
    house(x + w / 2, -54 - random() * 5, w, 7 + random() * 3, h, 1);
    x += w + (random() < 0.35 ? 2 + random() * 2 : 0.05);
  }
  // Behind them the ground rises: two more ranks stepping up a hill, thinning into the haze, and a walled keep on its crown.
  const hill = (x: number) => Math.max(0, 1 - Math.abs(x - 6) / 70);
  for (let x = -66; x < 66;) {
    const w = 7 + random() * 7;
    house(x + w / 2, -74 - random() * 9, w, 8 + random() * 4, 15 + hill(x + w / 2) * 6 + random() * 5, 1);
    x += w + (random() < 0.3 ? 2.5 : 0.05);
  }
  for (let x = -80; x < 80;) {
    const w = 8 + random() * 9;
    house(x + w / 2, -98 - random() * 10, w, 9 + random() * 4, 16 + hill(x + w / 2) * 15 + random() * 5, 2);
    x += w + (random() < 0.3 ? 3 : 0.05);
  }
  block(34, 7, 3, 6, 36.5, -114, 0xc9a97c);
  for (let x = -10.2; x <= 22.3; x += 1.8) block(0.9, 0.9, 3.1, x, 40.4, -114, 0xc9a97c);
  for (const x of [-11, 6, 23]) { block(5, 12, 5, x, 37, -114, 0xd0b48a); block(5.6, 0.5, 5.6, x, 43.2, -114, 0xd0b48a); for (const dx of [-2.2, 0, 2.2]) block(0.9, 1, 5.7, x + dx, 43.9, -114, 0xd0b48a); }
  tower(-5.8, -45.5, 21, 2.6, 0xd9c3a0);
  tower(9.5, -64, 28, 3.2, 0xc9a97c);
  tower(-33, -84, 30, 3, 0xe2d2b4);
  tower(31, -70, 24, 2.6, 0xd0b48a);
  dome(-15, 16.4, -62, 3.6, 0x4f8f8a);
  dome(17.5, 20.5, -78, 4.2, 0xd9c3a0);
  const town = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  return town;
}

/**
 * A sand tabby curled up asleep, about 0.33 m across: origin under its belly, its back to -z and
 * its face, tucked between shoulder and haunch with the tail drawn round under the chin, to +z.
 * `catMove` says how each vertex takes part when it stirs: x how much it swells with a breath, y how
 * far up an ear it is (positive on one ear, negative on the other), z how far along the loose end
 * of the tail.
 */
function catGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const FUR = new THREE.Color(0xb09a7a), STRIPE = new THREE.Color(0x6e5a40), CREAM = new THREE.Color(0xe2d8c4), DARK = new THREE.Color(0x1c130c), NOSE = new THREE.Color(0x9a5a52);
  /** Files a piece: `coat` picks the fur at a point (`u` runs along a limb), `move` its share in each movement. */
  const add = (source: THREE.BufferGeometry, coat: (x: number, y: number, z: number, u: number) => THREE.Color, move: (x: number, y: number, z: number, u: number) => V3) => {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const position = geometry.attributes.position, uv = geometry.attributes.uv, colours = new Float32Array(position.count * 3), moves = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i), u = uv.getX(i), fur = coat(x, y, z, u);
      colours.set([fur.r, fur.g, fur.b], i * 3);
      moves.set(move(x, y, z, u), i * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute("catMove", new THREE.BufferAttribute(moves, 3));
    geometry.deleteAttribute("uv");
    parts.push(geometry);
  };
  const blob = (rx: number, ry: number, rz: number, x: number, y: number, z: number, fine = 16) => new THREE.SphereGeometry(1, fine, Math.round(fine * 0.6)).scale(rx, ry, rz).translate(x, y, z);
  /** A point on the oval the cat lies along: degrees from +x round toward +z. */
  const ring = (degrees: number, radius: number, y: number) => new THREE.Vector3(Math.cos(degrees * Math.PI / 180) * radius * 1.14, y, Math.sin(degrees * Math.PI / 180) * radius);
  /** A tube along `spine` as thick as `girth(u)` says, pressed to `flat` of its height. */
  const limb = (spine: THREE.Curve<THREE.Vector3>, steps: number, sides: number, girth: (u: number) => number, flat = 1) => {
    const tube = new THREE.TubeGeometry(spine, steps, 1, sides, false), around = tube.attributes.position, centre = new THREE.Vector3(), point = new THREE.Vector3();
    for (let i = 0; i < around.count; i += 1) {
      const u = tube.attributes.uv.getX(i);
      spine.getPointAt(u, centre);
      point.fromBufferAttribute(around, i).sub(centre).multiplyScalar(girth(u));
      around.setXYZ(i, centre.x + point.x, centre.y + point.y * flat, centre.z + point.z);
    }
    tube.computeVertexNormals();
    return tube;
  };
  const still = (): V3 => [0, 0, 0];
  const flank = (_x: number, y: number): V3 => [Math.min(1, Math.max(0, y / 0.13)), 0, 0];
  // The body: one thick curl from the shoulders round the back to the haunch, barred across the
  // spine and pale underneath, with the tucked legs filling its middle.
  const FLAT = 0.84, girth = (u: number) => 0.058 + 0.024 * u * u;
  const back = new THREE.CatmullRomCurve3(Array.from({ length: 11 }, (_, i) => ring(128 + 26 * i, 0.08, girth(i / 10) * FLAT)));
  const barred = (y: number, along: number) => (y < 0.028 ? CREAM : y > 0.048 && Math.sin(along + Math.sin(y * 95) * 1.1) > 0.5 ? STRIPE : FUR);
  add(limb(back, 46, 12, girth, FLAT), (_x, y, _z, u) => barred(y, u * 47), flank);
  const shoulder = back.getPointAt(0), haunch = back.getPointAt(1);
  add(blob(0.058, 0.058 * FLAT, 0.058, shoulder.x, shoulder.y, shoulder.z, 14), (x, y) => barred(y, x * 80), flank);
  add(blob(0.084, 0.082 * FLAT, 0.084, haunch.x, haunch.y, haunch.z, 16), (_x, y, z) => barred(y, z * 75 + 1), flank);
  add(blob(0.07, 0.056, 0.06, 0, 0.056, 0.012, 12), (_x, y) => (y > 0.09 ? FUR : CREAM), flank);
  // The head, chin down on the hind feet: brow bars, a pale muzzle, eyes shut.
  const HEAD = ring(80, 0.108, 0.058);
  add(blob(0.05, 0.043, 0.048, HEAD.x, HEAD.y, HEAD.z, 18), (x, y, z) => (z > HEAD.z + 0.026 && y < HEAD.y ? CREAM : y > HEAD.y + 0.016 && Math.abs(Math.sin((x - HEAD.x) * 130)) > 0.72 ? STRIPE : FUR), () => [0.2, 0, 0]);
  add(blob(0.024, 0.017, 0.02, HEAD.x, HEAD.y - 0.014, HEAD.z + 0.038, 10), () => CREAM, still);
  add(blob(0.006, 0.0045, 0.0045, HEAD.x, HEAD.y - 0.005, HEAD.z + 0.056, 6), () => NOSE, still);
  const paw = ring(106, 0.14, 0.013);
  add(blob(0.028, 0.013, 0.02, paw.x, paw.y, paw.z, 8), () => CREAM, still);
  for (const side of [-1, 1]) {
    const base = HEAD.y + 0.03;
    add(new THREE.BoxGeometry(0.018, 0.003, 0.004).rotateZ(-side * 0.25).rotateY(side * 0.45).translate(HEAD.x + side * 0.022, HEAD.y + 0.009, HEAD.z + 0.041), () => DARK, still);
    add(new THREE.ConeGeometry(0.021, 0.04, 4).rotateY(Math.PI / 4).scale(1, 1, 0.55).translate(HEAD.x + side * 0.03, base + 0.019, HEAD.z - 0.004),
      (_x, y) => (y > base + 0.028 ? STRIPE : FUR), (_x, y) => [0.2, side * Math.min(1, Math.max(0, (y - base) / 0.04)), 0]);
  }
  // The tail, drawn round the front from the haunch to past the chin: ringed, tapering, loose toward the end.
  const spine = new THREE.CatmullRomCurve3([[8, 0.14, 0.035], [30, 0.158, 0.026], [55, 0.168, 0.023], [80, 0.172, 0.022], [105, 0.168, 0.022], [130, 0.16, 0.022], [150, 0.15, 0.024]].map(([degrees, radius, y]) => ring(degrees, radius, y)));
  const taper = (u: number) => 0.021 * (1 - 0.45 * u * Math.sqrt(u));
  add(limb(spine, 30, 7, taper), (_x, _y, _z, u) => (Math.sin(u * 34) > 0.25 || u > 0.9 ? STRIPE : FUR), (_x, _y, _z, u) => [0, 0, Math.min(1, Math.max(0, (u - 0.4) / 0.6))]);
  const tip = spine.getPointAt(1);
  add(blob(0.0115, 0.0115, 0.0115, tip.x, tip.y, tip.z, 6), () => STRIPE, () => [0, 0, 1]);
  return merge(parts);
}

/** Turned metal vessels: 0 broad cooking pot, 1 tall ewer, 2 footed bowl. */
function vesselGeometry(kind: number) {
  const profiles = [
    [[0, 0], [0.2, 0], [0.27, 0.05], [0.3, 0.2], [0.27, 0.33], [0.24, 0.36], [0.27, 0.39], [0.25, 0.4], [0.22, 0.37], [0.24, 0.2], [0, 0.06]],
    [[0, 0], [0.11, 0], [0.12, 0.03], [0.07, 0.07], [0.16, 0.22], [0.17, 0.32], [0.09, 0.46], [0.05, 0.6], [0.06, 0.68], [0.09, 0.72], [0.07, 0.73], [0.04, 0.68], [0, 0.66]],
    [[0, 0], [0.12, 0], [0.13, 0.02], [0.05, 0.06], [0.05, 0.1], [0.2, 0.16], [0.27, 0.26], [0.28, 0.29], [0.26, 0.29], [0.19, 0.19], [0, 0.14]],
  ];
  return new THREE.LatheGeometry(profiles[kind].map(([x, y]) => new THREE.Vector2(x, y)), 22);
}

/** Round tray with a raised, beaded rim, standing on edge in the XY plane. */
function trayGeometry() {
  const profile = [[0, 0], [0.3, 0], [0.33, 0.012], [0.34, 0.03], [0.325, 0.03], [0.3, 0.014], [0.12, 0.014], [0.1, 0.02], [0, 0.02]].map(([x, y]) => new THREE.Vector2(x, y));
  const geometry = new THREE.LatheGeometry(profile, 30);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/**
 * Six-sided hanging lantern, origin at the middle of its glass: [metalwork, glass].
 * Cornice, ogee roof and finial above; tray, bowl and drop below; a post at each corner and two
 * rails round the glass. It hangs from a ring whose top is 0.42 above the origin.
 */
function lanternGeometry() {
  const facet = (geometry: THREE.BufferGeometry) => { const flat = geometry.toNonIndexed(); geometry.dispose(); flat.computeVertexNormals(); return flat; };
  const hex = (points: number[][]) => facet(lathe(points, 6));
  const metal: THREE.BufferGeometry[] = [
    hex([[0.11, 0.15], [0.128, 0.154], [0.141, 0.172], [0.141, 0.186], [0.122, 0.196], [0.116, 0.222], [0.092, 0.258], [0.056, 0.284], [0.034, 0.31], [0.022, 0.336], [0.03, 0.35], [0.018, 0.364], [0, 0.37]]),
    hex([[0, -0.292], [0.012, -0.286], [0.016, -0.272], [0.008, -0.262], [0.03, -0.25], [0.036, -0.236], [0.06, -0.222], [0.1, -0.198], [0.131, -0.176], [0.131, -0.164], [0.122, -0.154], [0.11, -0.15]]),
    new THREE.TorusGeometry(0.024, 0.005, 4, 10).translate(0, 0.392, 0),
  ];
  for (const y of [-0.052, 0.052]) metal.push(hex([[0.112, y - 0.007], [0.123, y - 0.005], [0.123, y + 0.005], [0.112, y + 0.007]]));
  for (let i = 0; i < 6; i += 1) {
    const angle = i * Math.PI / 3, sin = Math.sin(angle), cos = Math.cos(angle);
    metal.push(new THREE.BoxGeometry(0.017, 0.31, 0.017).rotateY(angle).translate(sin * 0.115, 0, cos * 0.115));
    metal.push(new THREE.ConeGeometry(0.011, 0.046, 4).translate(sin * 0.136, 0.208, cos * 0.136));
    metal.push(new THREE.SphereGeometry(0.011, 5, 3).translate(sin * 0.124, -0.186, cos * 0.124));
  }
  return [merge(metal), new THREE.CylinderGeometry(0.109, 0.109, 0.3, 6, 1, true)] as const;
}

/**
 * One pane of lantern glass, repeated round the six sides: seeded glass dim with soot at the edges,
 * a flame's hot spot behind it, leaded cames and a few tinted quarries. Grey, so each lantern's own
 * colour comes from its instance.
 */
function lanternGlassTexture() {
  const texture = canvasTexture(256, 512, (context) => {
    const random = rng(97);
    const body = context.createLinearGradient(0, 0, 0, 512);
    body.addColorStop(0, "#6e6e6e"); body.addColorStop(0.55, "#a8a8a8"); body.addColorStop(1, "#5c5c5c");
    context.fillStyle = body; context.fillRect(0, 0, 256, 512);
    // Tinted quarries: the spandrels over the arch, a roundel in its head and the corners of the base.
    const arch = () => { context.beginPath(); context.moveTo(14, 196); context.quadraticCurveTo(22, 70, 128, 26); context.quadraticCurveTo(234, 70, 242, 196); context.closePath(); };
    context.fillStyle = "rgba(210,60,40,.6)"; context.fillRect(0, 0, 256, 196);
    arch(); context.fillStyle = "#969696"; context.fill();
    context.fillStyle = "rgba(60,150,220,.55)"; context.beginPath(); context.arc(128, 118, 30, 0, Math.PI * 2); context.fill();
    context.fillStyle = "rgba(70,170,120,.5)";
    for (const [x, y] of [[0, 400], [128, 400]]) { context.beginPath(); context.moveTo(x, y); context.lineTo(x + 128, y); context.lineTo(x + 64, y + 56); context.closePath(); context.fill(); }
    // Seeds, reams and the grime that gathers along the leads.
    for (let i = 0; i < 1400; i += 1) {
      const light = random() < 0.5;
      context.fillStyle = `rgba(${light ? "255,255,255" : "0,0,0"},${0.03 + random() * 0.08})`;
      if (random() < 0.6) context.fillRect(random() * 256, random() * 512, 1 + random() * 2, 6 + random() * 26);
      else { context.beginPath(); context.arc(random() * 256, random() * 512, 0.8 + random() * 2.2, 0, Math.PI * 2); context.fill(); }
    }
    // The flame behind the glass.
    const flame = context.createRadialGradient(128, 290, 3, 128, 290, 250);
    flame.addColorStop(0, "rgba(255,255,255,1)"); flame.addColorStop(0.16, "rgba(255,255,255,.95)"); flame.addColorStop(0.36, "rgba(255,255,255,.55)"); flame.addColorStop(0.66, "rgba(255,255,255,.18)"); flame.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = flame; context.fillRect(0, 0, 256, 512);
    // Cames.
    const lead = (width: number, shadow: boolean) => {
      context.lineWidth = width; context.lineJoin = "round";
      context.strokeStyle = shadow ? "rgba(0,0,0,.3)" : "#0b0906";
      context.strokeRect(0, 0, 256, 512);
      arch(); context.stroke();
      context.beginPath(); context.arc(128, 118, 30, 0, Math.PI * 2); context.stroke();
      context.beginPath();
      context.moveTo(0, 196); context.lineTo(256, 196); context.moveTo(0, 400); context.lineTo(256, 400);
      context.moveTo(128, 196); context.lineTo(236, 298); context.lineTo(128, 400); context.lineTo(20, 298); context.closePath();
      context.moveTo(0, 400); context.lineTo(64, 456); context.lineTo(128, 400); context.lineTo(192, 456); context.lineTo(256, 400);
      context.moveTo(64, 456); context.lineTo(64, 512); context.moveTo(192, 456); context.lineTo(192, 512);
      context.stroke();
      context.beginPath(); context.arc(128, 298, 34, 0, Math.PI * 2); context.stroke();
    };
    lead(15, true); lead(6, false);
  }, true);
  return texture;
}

/** Wrought bracket standing out from a wall along +z: plate, arm, two scrolls, a stay and a hook at the end. */
function bracketIronGeometry() {
  const scroll = (radius: number, y: number, z: number, start: number, sweep: number) => new THREE.TorusGeometry(radius, 0.007, 4, 12, sweep).rotateZ(start).rotateY(-Math.PI / 2).translate(0, y, z);
  return merge([
    new THREE.BoxGeometry(0.055, 0.34, 0.012).translate(0, -0.09, 0.006),
    new THREE.BoxGeometry(0.016, 0.018, 0.34).translate(0, 0, 0.17),
    scroll(0.085, -0.095, 0.1, -Math.PI / 2, Math.PI * 1.5),
    scroll(0.042, -0.052, 0.236, Math.PI / 2, Math.PI * 1.5),
    rod([0, -0.24, 0.012], [0, -0.165, 0.062], 0.007, 5),
    new THREE.TorusGeometry(0.016, 0.005, 4, 8, Math.PI * 1.4).rotateZ(Math.PI * 0.8).rotateY(-Math.PI / 2).translate(0, -0.024, 0.3),
    new THREE.ConeGeometry(0.012, 0.03, 4).rotateX(Math.PI / 2).translate(0, 0, 0.352),
    ...[-0.2, 0.03].map((y) => new THREE.SphereGeometry(0.009, 5, 3).translate(0, y, 0.014)),
  ]);
}

/** A length of cloth hanging from a pole along its top edge, facing -z: gathered folds that open toward an uneven hem. */
function bannerGeometry(width: number, drop: number, folds: number, seed = 0) {
  const geometry = new THREE.PlaneGeometry(width, drop, 22, 12);
  geometry.translate(0, -drop / 2, 0);
  geometry.rotateY(Math.PI);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const u = position.getX(i) / width, v = -position.getY(i) / drop;
    const fold = Math.sin(u * Math.PI * 2 * folds + seed) * 0.075 * (0.35 + v * 0.8) + Math.sin(u * Math.PI * 2 * (folds * 2 + 1) + seed * 2.1) * 0.022 * v;
    position.setZ(i, fold + Math.sin(v * 3 + u * 5 + seed) * 0.045 * v);
    // Folds take up width, and the hem hangs lower where a fold comes forward.
    position.setX(i, position.getX(i) * (1 - 0.06 * v) + Math.sin(v * 5 + seed) * 0.012 * v);
    position.setY(i, position.getY(i) - v * v * (0.03 * Math.sin(u * Math.PI * 2 * folds + seed) + 0.04 * u));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Cloth slung between two poles `span` apart along z and `width` wide: a belly that hangs lowest off
 * centre, edges that curl up, tension folds running pole to pole and the width gathered where it is tied.
 * Origin midway between the poles, at their height.
 */
function slungCloth(span: number, width: number, sag: number, seed: number) {
  const geometry = new THREE.PlaneGeometry(span, width, 28, 12);
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.PI / 2);
  const position = geometry.attributes.position, random = rng(seed), phase = random() * 6, lop = (random() - 0.5) * 0.5;
  for (let i = 0; i < position.count; i += 1) {
    const u = position.getX(i) / (width / 2), v = position.getZ(i) / (span / 2), hang = Math.max(0, 1 - v * v);
    const belly = sag * Math.pow(hang, 0.85) * (1 - 0.2 * u * u + lop * u * 0.35) * (1 + lop * v * 0.2);
    const folds = (Math.sin(u * 7 + phase + v * 1.4) * 0.04 + Math.sin(u * 16 + phase * 2.1 - v) * 0.013) * hang;
    position.setY(i, -belly + folds + 0.07 * u * u * u * u * hang);
    position.setX(i, position.getX(i) * (0.9 + 0.1 * Math.pow(hang, 0.4)));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** The pale band of warp ends painted at each end of a rug texture: geometry stops short of it and grows a real fringe. */
const RUG_FRINGE = 12 / 512, RUG_PILE = 0.012;

/**
 * Closes a sheet built on a plane grid into a slab: a second face `thickness` behind the first (unless
 * it lies on something) and a bound edge all round, so a rug shows its edge instead of vanishing side-on.
 */
function slab(sheet: THREE.BufferGeometry, columns: number, rows: number, thickness: number, back = true) {
  sheet.computeVertexNormals();
  const p = sheet.attributes.position, n = sheet.attributes.normal, uv = sheet.attributes.uv, count = p.count, stride = columns + 1;
  const positions: number[] = [], uvs: number[] = [], front = Array.from(sheet.index!.array), indices = front.slice();
  const push = (i: number, depth: number) => {
    positions.push(p.getX(i) - n.getX(i) * depth, p.getY(i) - n.getY(i) * depth, p.getZ(i) - n.getZ(i) * depth);
    uvs.push(uv.getX(i), uv.getY(i));
    return positions.length / 3 - 1;
  };
  for (let i = 0; i < count; i += 1) push(i, 0);
  if (back) {
    for (let i = 0; i < count; i += 1) push(i, thickness);
    for (let i = 0; i < front.length; i += 3) indices.push(front[i] + count, front[i + 2] + count, front[i + 1] + count);
  }
  const ring: number[] = [];
  for (let c = 0; c < columns; c += 1) ring.push(c);
  for (let r = 0; r < rows; r += 1) ring.push(r * stride + columns);
  for (let c = columns; c > 0; c -= 1) ring.push(rows * stride + c);
  for (let r = rows; r > 0; r -= 1) ring.push(r * stride);
  ring.forEach((a, k) => {
    const b = ring[(k + 1) % ring.length], a0 = push(a, 0), b0 = push(b, 0), a1 = push(a, thickness), b1 = push(b, thickness);
    indices.push(a0, b0, a1, b0, b1, a1);
  });
  sheet.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Warp ends left as a fringe: flat strands from `hem(x)` running `reach` along `out`, facing `face`.
 * They take their colour from the pale band at the end of the rug texture.
 */
function rugFringe(width: number, reach: number, seed: number, hem: (x: number) => THREE.Vector3, out: THREE.Vector3, face: THREE.Vector3) {
  const random = rng(seed * 13 + 77), count = Math.round(width / 0.03), positions: number[] = [], uvs: number[] = [], normals: number[] = [];
  const side = new THREE.Vector3().crossVectors(out, face).normalize();
  for (let i = 0; i < count; i += 1) {
    const x = -width / 2 + (i + 0.5) * width / count, root = hem(x), long = reach * (0.7 + random() * 0.4), sway = (random() - 0.5) * 0.45;
    const tip = root.clone().addScaledVector(out, long).addScaledVector(side, sway * long);
    const a = root.clone().addScaledVector(side, -0.007), b = root.clone().addScaledVector(side, 0.007), c = tip.clone().addScaledVector(side, 0.003), d = tip.clone().addScaledVector(side, -0.003);
    for (const corner of [a, b, c, a, c, d]) { positions.push(corner.x, corner.y, corner.z); uvs.push(0.508, 0.012); normals.push(face.x, face.y, face.z); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * A rug thrown over a rail of radius `rail`: it hangs `drop` down the front and laps a short way over
 * the back, with its own thickness, bound edges and a fringe on both ends. Origin on the rail's axis.
 */
function drapeGeometry(width: number, drop: number, seed = 0, rail = 0.03) {
  const columns = 6, rows = 20, lapRows = 2, bendRows = 7;
  const sheet = new THREE.PlaneGeometry(width, 1, columns, rows);
  const position = sheet.attributes.position, uv = sheet.attributes.uv, back = 0.28, radius = rail + RUG_PILE + 0.003, around = Math.PI * radius, total = back + around + drop;
  /** How far the hanging length stands off the rail at `d` below it: a slow sway down the drop and folds across that open toward the hem. */
  const off = (x: number, d: number) => radius + Math.sin(d * 5 + seed) * 0.012 * Math.min(1, d / 0.3) + Math.sin(x / width * 9 + seed * 1.7) * 0.016 * Math.min(1, d / 0.6);
  for (let i = 0; i < position.count; i += 1) {
    const row = (0.5 - position.getY(i)) * rows, x = position.getX(i);
    const s = row <= lapRows ? back * row / lapRows : row <= lapRows + bendRows ? back + around * (row - lapRows) / bendRows : back + around + drop * (row - lapRows - bendRows) / (rows - lapRows - bendRows);
    let y = 0, z = 0;
    if (s < back) { y = -(back - s); z = -radius; }
    else if (s < back + around) { const angle = (s - back) / radius; y = Math.sin(angle) * radius; z = -Math.cos(angle) * radius; }
    else { y = -(s - back - around); z = off(x, -y); }
    position.setY(i, y); position.setZ(i, z);
    uv.setY(i, RUG_FRINGE + (1 - s / total) * (1 - 2 * RUG_FRINGE));
  }
  const down = new THREE.Vector3(0, -1, 0);
  return merge([
    slab(sheet, columns, rows, RUG_PILE),
    rugFringe(width, 0.08, seed, (x) => new THREE.Vector3(x, -drop, off(x, drop) - RUG_PILE / 2), down, new THREE.Vector3(0, 0, 1)),
    rugFringe(width, 0.08, seed + 5, (x) => new THREE.Vector3(x, -back, -radius + RUG_PILE / 2), down, new THREE.Vector3(0, 0, -1)),
  ]);
}

/**
 * A rug spread on the floor, long side on z: pile standing off the flags, a ruck where a foot caught it,
 * bound edges and a fringe at both ends. Origin on the floor under its middle.
 */
function floorRug(width: number, length: number, seed: number) {
  const columns = 8, rows = 28, sheet = new THREE.PlaneGeometry(width, length, columns, rows);
  sheet.rotateX(-Math.PI / 2);
  const position = sheet.attributes.position, uv = sheet.attributes.uv, random = rng(seed * 31 + 5), where = (random() - 0.5) * 1.1, skew = (random() - 0.5) * 0.5, phase = random() * 6;
  for (let i = 0; i < position.count; i += 1) {
    const u = position.getX(i) / (width / 2), v = position.getZ(i) / (length / 2);
    const from = (v - where - u * skew) * length / 2;
    const ruck = 0.017 * Math.exp(-from * from / 0.009) * (0.35 + 0.65 * Math.max(0, Math.sin(u * 1.3 + phase)));
    position.setY(i, RUG_PILE + 0.001 + ruck + 0.002 * Math.sin(u * 5 + phase) * Math.sin(v * 7 + phase * 1.3));
    uv.setY(i, RUG_FRINGE + uv.getY(i) * (1 - 2 * RUG_FRINGE));
  }
  const up = new THREE.Vector3(0, 1, 0);
  return merge([
    slab(sheet, columns, rows, RUG_PILE, false),
    ...[-1, 1].map((end) => rugFringe(width, 0.085, seed + end, (x) => new THREE.Vector3(end * x, RUG_PILE, end * length / 2), new THREE.Vector3(0, -0.07, end).normalize(), up)),
  ]);
}

/**
 * Sun standing in the dusty air. Each sheet lies along the sun's direction and asks the sun's own
 * shadow map where it is lit, so beams take the shape of the roof openings and stop at whatever
 * hangs in their way. The sheets come in two crossed families so a beam holds up from any side.
 */
function beamMaterial() {
  return new THREE.ShaderMaterial({
    lights: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, { time: { value: 0 }, strength: { value: 1 } }]),
    vertexShader: /* glsl */`
      attribute vec3 plane;
      attribute vec3 spread;
      attribute float gain;
      #if NUM_DIR_LIGHT_SHADOWS > 0
        uniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];
        varying vec4 vCoord;
        varying vec4 vSpread;
      #endif
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vPlane;
      varying float vGain;
      void main() {
        vUv = uv; vWorld = position; vPlane = plane; vGain = gain;
        #if NUM_DIR_LIGHT_SHADOWS > 0
          vCoord = directionalShadowMatrix[0] * vec4(position, 1.0);
          vSpread = directionalShadowMatrix[0] * vec4(spread, 0.0);
        #endif
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      struct DirectionalLight { vec3 direction; vec3 color; };
      #if NUM_DIR_LIGHTS > 0
        uniform DirectionalLight directionalLights[NUM_DIR_LIGHTS];
      #endif
      #if NUM_DIR_LIGHT_SHADOWS > 0
        uniform sampler2DShadow directionalShadowMap[NUM_DIR_LIGHT_SHADOWS];
        varying vec4 vCoord;
        varying vec4 vSpread;
      #endif
      uniform float time;
      uniform float strength;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vPlane;
      varying float vGain;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float noise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
      void main() {
        float lit = 0.0;
        vec3 sunColor = vec3(0.0);
        #if NUM_DIR_LIGHT_SHADOWS > 0 && NUM_DIR_LIGHTS > 0
          for (int i = 0; i < 4; i++) {
            vec4 coordinate = vCoord + vSpread * (float(i) - 1.5);
            vec3 p = coordinate.xyz / coordinate.w;
            lit += texture(directionalShadowMap[0], vec3(p.xy, p.z - 0.0008));
          }
          lit *= 0.25;
          sunColor = directionalLights[0].color;
        #endif
        vec3 toEye = cameraPosition - vWorld;
        float range = length(toEye);
        float facing = abs(dot(toEye / range, normalize(vPlane)));
        float edge = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
        float fall = smoothstep(0.0, 0.03, vUv.y) * mix(1.0, 0.5, vUv.y);
        // Dust drifting through the beam.
        float dust = 0.72 + 0.4 * noise(vUv.x * 9.0 + vWorld.z * 0.7 + time * 0.05) * noise(vUv.y * 6.0 - time * 0.09 + vWorld.x);
        float near = smoothstep(0.5, 3.0, range);
        gl_FragColor = vec4(sunColor * lit * edge * fall * dust * near * smoothstep(0.1, 0.62, facing) * vGain * strength, 1.0);
      }
    `,
  });
}

/** Collects beam sheets into one geometry. Each sheet starts on a `top` edge and runs down the sun to the floor. */
function beamBuilder(toSun: THREE.Vector3) {
  const positions: number[] = [], uvs: number[] = [], planes: number[] = [], spreads: number[] = [], gains: number[] = [], indices: number[] = [];
  const down = (point: THREE.Vector3) => point.clone().addScaledVector(toSun, -point.y / toSun.y);
  return {
    sheet(a: THREE.Vector3, b: THREE.Vector3, spread: THREE.Vector3, gain: number) {
      const plane = b.clone().sub(a).cross(toSun).normalize(), base = positions.length / 3;
      [a, b, down(a), down(b)].forEach((point, index) => {
        positions.push(point.x, point.y, point.z);
        uvs.push(index % 2, index < 2 ? 0 : 1);
        planes.push(plane.x, plane.y, plane.z);
        spreads.push(spread.x, spread.y, spread.z);
        gains.push(gain);
      });
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    },
    build() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute("plane", new THREE.Float32BufferAttribute(planes, 3));
      geometry.setAttribute("spread", new THREE.Float32BufferAttribute(spreads, 3));
      geometry.setAttribute("gain", new THREE.Float32BufferAttribute(gains, 1));
      geometry.setIndex(indices);
      return geometry;
    },
  };
}

export function buildBazaar(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, track, photoSet, wall, place } = kit;
  const metals = kit.metals();
  const random = rng(909);
  /** Instancing that tolerates an empty list and takes an optional colour per instance. */
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], hit = false, shadow = true, colours?: THREE.ColorRepresentation[]) => {
    if (!transforms.length) return null;
    const mesh = kit.instances(geometry, material, transforms, hit, shadow);
    if (colours) {
      const colour = new THREE.Color();
      transforms.forEach((_, index) => mesh.setColorAt(index, colour.set(colours[index % colours.length])));
      mesh.instanceColor!.needsUpdate = true;
    }
    return mesh;
  };

  // ---- Air and life ----------------------------------------------------------
  // One wind for the street: a draught that comes over the wall behind the firing line and runs
  // down the hall to the lattice gable, most of it in gusts. The cloth overhead, the lanterns, the
  // palms beyond the gable, the dust and everything that lives here read this one field.
  const BREEZE = 0.3;
  const wind = createWind({ heading: 0.2, strength: BREEZE, gustiness: 0.7 });
  const life = createLife(kit, options, { wind, seed: 9 });
  const trees = createTrees(kit, { seed: 9, wind, sun: () => sun });
  const cueAt = new THREE.Vector3();
  /** Asks for a sound at a place. */
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => options.cue?.(name, cueAt.set(x, y, z), { gain, pitch });

  // Lanterns and other hung wares stay instanced: each rides a pivot that the life kit swings as a
  // pendulum in that wind, and one pass a frame copies the pivots into the instance matrices.
  type Hanger = { pivot: THREE.Object3D; meshes: THREE.InstancedMesh[]; slots: number[]; locals: THREE.Matrix4[]; kick: (strength: number, x?: number, z?: number) => void };
  const hangers: Hanger[] = [], ridden: THREE.InstancedMesh[] = [];
  /** A pivot at `at` for something hanging `length` below it. */
  const hang = (at: V3, length: number, amplitude: number): Hanger => {
    const pivot = new THREE.Object3D();
    pivot.position.set(...at);
    const hanger = { pivot, meshes: [], slots: [], locals: [], kick: life.sway(pivot, { amplitude, period: 2 * Math.sqrt(length) }).kick };
    hangers.push(hanger);
    return hanger;
  };
  /** Lets one instance of a mesh hang from a pivot: `local` places it relative to the hook. */
  const ride = (hanger: Hanger, mesh: THREE.InstancedMesh | null, slot: number, local: THREE.Matrix4) => {
    if (!mesh) return;
    if (!ridden.includes(mesh)) { mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); ridden.push(mesh); }
    hanger.meshes.push(mesh); hanger.slots.push(slot); hanger.locals.push(local);
  };
  const carried = new THREE.Matrix4();
  kit.updates.push(() => {
    for (let i = 0; i < hangers.length; i += 1) {
      const { pivot, meshes, slots, locals } = hangers[i];
      pivot.updateMatrix();
      for (let k = 0; k < meshes.length; k += 1) meshes[k].setMatrixAt(slots[k], carried.multiplyMatrices(pivot.matrix, locals[k]));
    }
    for (let i = 0; i < ridden.length; i += 1) ridden[i].instanceMatrix.needsUpdate = true;
  });

  // ---- Materials -----------------------------------------------------------
  const wood = photoSet("/textures/lacquered_cherry_wood-2k", 1, 1, false);
  const brick = wall("buffBrick", 2.2);
  const plaster = wall("adobeWash");
  const concrete = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1);
  const flagRough = photoSet("/textures/concrete_floor_worn_001-2k", 96 / 3.6, 104 / 3.6);
  const planks = photoSet("/textures/weathered_brown_planks-2k", 1, 1, false);
  const fabricSet = photoSet("/textures/fabric_pattern_07-2k", 3, 3, false);
  const paving = photoSet("/textures/tiled_floor_001-2k", 1, 1, false);

  const timberMaterial = (color: THREE.Color, roughness = 0.85) => new THREE.MeshStandardMaterial({ map: wood.map, normalMap: wood.normalMap, color, normalScale: new THREE.Vector2(0.8, 0.8), roughness, metalness: 0, envMapIntensity: 0.5 });
  // The photographed timber is near black, so the tints are gains above one.
  const oak = timberMaterial(new THREE.Color(4.2, 3.3, 2.5)), darkOak = timberMaterial(new THREE.Color(2.7, 2.1, 1.6));
  // Sawn, weathered boards for the roof, the stalls and all the joinery; `tinted` ones take paint from vertex colours.
  const plankMaterial = (color: THREE.Color, tinted = false) => new THREE.MeshStandardMaterial({ ...planks, color, roughness: 1, metalness: 0, envMapIntensity: 0.45, vertexColors: tinted });
  const boards = plankMaterial(new THREE.Color(1.5, 1.3, 1.08)), paintedWood = plankMaterial(new THREE.Color(1, 1, 1));
  const tiled = new THREE.MeshStandardMaterial({ ...paving, color: new THREE.Color(1.5, 1.3, 1.1), roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const brickwork = new THREE.MeshStandardMaterial({ ...brick, color: new THREE.Color(0.86, 0.9, 0.86), normalScale: new THREE.Vector2(1.2, 1.2), roughness: 1, metalness: 0, aoMapIntensity: 0.9, envMapIntensity: 0.45 });
  const stone = new THREE.MeshStandardMaterial({ ...concrete, color: new THREE.Color(1.3, 1.14, 0.92), roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const plasterMaterial = (color: number, normal = 1) => new THREE.MeshStandardMaterial({ ...plaster, color, normalScale: new THREE.Vector2(normal, normal), roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const limewash = plasterMaterial(0xd9c7a4), umber = plasterMaterial(0x8a6248, 1.2);
  const washes = [plasterMaterial(0xc98a3c), plasterMaterial(0xa9523d), plasterMaterial(0x4d7f80), plasterMaterial(0xd6bf94), plasterMaterial(0xb96f45), plasterMaterial(0x7d8a55)];
  const iron = new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 0.6, metalness: 0.8, envMapIntensity: 0.9 });
  // Beaten metal: a planished surface catches the lanterns as a scatter of small highlights instead of one clean streak.
  const planished = track(hammeredNormal());
  planished.anisotropy = anisotropy;
  const brass = new THREE.MeshStandardMaterial({ color: 0xd3a04a, normalMap: planished, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.3, metalness: 1, envMapIntensity: 1.5 });
  const agedBrass = new THREE.MeshStandardMaterial({ color: 0xa87a38, roughness: 0.42, metalness: 1, envMapIntensity: 1.3 });
  const shade = new THREE.MeshStandardMaterial({ color: 0x0d0906, roughness: 1, metalness: 0, envMapIntensity: 0.1 });
  const sacking = track(weaveTexture(4, 1)), flatWeave = track(weaveTexture(2, 0.6));
  const woven = new THREE.MeshStandardMaterial({ map: flatWeave, roughness: 1, metalness: 0, envMapIntensity: 0.3 });
  const screenMap = track(screenTexture());
  screenMap.repeat.set(3.2, 2);
  // No mip chain: averaged down, the piercing would close up and the screen would read as solid from across the hall.
  screenMap.generateMipmaps = false;
  screenMap.minFilter = THREE.LinearFilter;
  const screenMaterial = new THREE.MeshStandardMaterial({ map: screenMap, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, envMapIntensity: 0.4 });
  const litRoom = (map: THREE.Texture) => { map.anisotropy = anisotropy; return new THREE.MeshBasicMaterial({ map, color: new THREE.Color(1.3, 1.12, 0.95), toneMapped: false }); };
  const bulb = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.68, 0.34).multiplyScalar(4), toneMapped: false });
  /** Lamp glass colours, bright enough to bloom. */
  const glow = (r: number, g: number, b: number, gain: number) => new THREE.Color(r, g, b).multiplyScalar(gain);
  const AMBER = glow(1, 0.62, 0.26, 3.4), RUBY = glow(1, 0.2, 0.14, 2.6), TEAL = glow(0.2, 0.85, 0.75, 2.2), GREEN = glow(0.5, 0.9, 0.3, 2), HONEY = glow(1, 0.78, 0.4, 3.2);

  /**
   * Thin cloth takes the sun on either face, so its underside shows the light and the shadows
   * that fall on its back. `through` is how much of that light the weave lets pass.
   */
  const clothMaterial = (map: THREE.Texture, through = 0.6) => {
    map.anisotropy = anisotropy;
    const material = new THREE.MeshStandardMaterial({ map, color: new THREE.Color(through, through, through), emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.05, roughness: 1, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.6 });
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
        #if NUM_DIR_LIGHTS > 0
          if (dot(normal, directionalLights[0].direction) < 0.0) normal = -normal;
        #endif`);
    };
    material.customProgramCacheKey = () => "bazaar-cloth";
    return material;
  };
  const dyes = [
    track(dyeTexture(0, "#d9952b", "#f0e2c0", "#8a2f22", 3)), track(dyeTexture(1, "#a8322a", "#f0d9a8", "#e0a23a", 5)),
    track(dyeTexture(2, "#27508a", "#e9dcc0", "#d9952b", 7)), track(dyeTexture(0, "#2f8f88", "#efe4cc", "#d79a45", 11)),
    track(dyeTexture(1, "#e8dcc0", "#b8452e", "#27508a", 13)), track(dyeTexture(2, "#b84a6a", "#f0dcc0", "#e0a23a", 17)),
    track(dyeTexture(2, "#e0a52e", "#a8322a", "#f4ead0", 19)), track(dyeTexture(0, "#7a2d3c", "#e0a23a", "#efe4cc", 23)),
  ];
  // Two of each dye, because they are held differently: what is laced over the roof is tied along
  // both purlins and only its belly breathes; what hangs under the tie beams is free below its poles.
  const cloths = dyes.map((map) => clothMaterial(map)), drapes = dyes.map((map) => clothMaterial(map));
  life.cloth(cloths, { amplitude: 0.05, frequency: 0.5, pin: "ends", lean: 0, flutter: 0 });
  const drapery = life.cloth(drapes, { amplitude: 0.11, frequency: 0.8, pin: { height: 7.03, reach: 1.1 }, lean: 1, flutter: 0.6 });
  const rugMaps = [
    track(rugTexture(4, "#7c2a22", "#22344f", "#e3c58f", "#d58a2e")), track(rugTexture(7, "#1f4e5a", "#7c2a22", "#ead7ad", "#c9772d")),
    track(rugTexture(10, "#b8742a", "#5a2130", "#f0e0bd", "#1f6f6a")), track(rugTexture(13, "#5a2130", "#b8742a", "#e6cfa0", "#2f5f86")),
  ];
  rugMaps.forEach((map) => { map.anisotropy = anisotropy; });
  const rugs = rugMaps.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0, envMapIntensity: 0.3, side: THREE.DoubleSide }));
  /** Every rug that shows its pattern, baked into the world and gathered per pattern: one mesh each at the end. */
  const rugParts: THREE.BufferGeometry[][] = rugs.map(() => []);
  const RUG_DYES = [0x8c2f25, 0x24506a, 0xc98a2e, 0x6a2438, 0xd9c49a, 0x2f7f78, 0xb5532f, 0x3a3f6e];
  const CLOTH_DYES = [0xd9952b, 0xa8322a, 0x27508a, 0x2f8f88, 0xe8dcc0, 0xb84a6a, 0x7b8440, 0xe0a52e, 0x6a2d6a, 0xc9552b];

  // ---- Detail collectors ---------------------------------------------------
  // One-off joinery, wares and clutter are baked into world space and merged into one mesh per
  // material; colour rides on the vertices.
  type BagKey = "joinery" | "iron" | "brass" | "pottery" | "fabric" | "gingham" | "matte" | "glow" | "rope" | "tiles" | "awning" | "tunic" | "check" | "hung";
  const tilePanels = track(tilePanelTexture(61, "#e9dfc4", "#1f5f8c", "#c9772d", "#17456a"));
  const plainCloth = () => new THREE.MeshStandardMaterial({ normalMap: fabricSet.normalMap, roughnessMap: fabricSet.roughnessMap, roughness: 1, metalness: 0, envMapIntensity: 0.35, vertexColors: true, side: THREE.DoubleSide });
  const checkedCloth = () => new THREE.MeshStandardMaterial({ ...fabricSet, roughness: 1, metalness: 0, envMapIntensity: 0.35, vertexColors: true, side: THREE.DoubleSide });
  const bagMaterial: Record<BagKey, THREE.Material> = {
    joinery: plankMaterial(new THREE.Color(1.45, 1.25, 1.05), true),
    iron: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.8, envMapIntensity: 0.9, vertexColors: true }),
    brass: new THREE.MeshStandardMaterial({ color: 0xd3a04a, normalMap: planished, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 0.3, metalness: 1, envMapIntensity: 1.5, vertexColors: true, side: THREE.DoubleSide }),
    pottery: new THREE.MeshStandardMaterial({ normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.36, metalness: 0, envMapIntensity: 0.8, vertexColors: true }),
    fabric: plainCloth(),
    gingham: checkedCloth(),
    matte: new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, envMapIntensity: 0.4, vertexColors: true }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    rope: new THREE.MeshStandardMaterial({ map: sacking, side: THREE.DoubleSide, roughness: 1, metalness: 0, envMapIntensity: 0.3, vertexColors: true }),
    tiles: new THREE.MeshStandardMaterial({ map: tilePanels, roughness: 0.22, metalness: 0, envMapIntensity: 0.9, vertexColors: true }),
    // The same stuffs again for what the wind moves, each with the way it is held.
    awning: plainCloth(),
    tunic: plainCloth(),
    check: checkedCloth(),
    hung: new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, envMapIntensity: 0.5, vertexColors: true }),
  };
  // Awnings are stretched between the wall and their pole; tunics hang from the rails in the cloth
  // arcade; strings of dried goods and beads hang from a nail and lean with the gusts. For those
  // the texture coordinate is not a pattern but how far below the nail a piece hangs (see `string`).
  life.cloth(bagMaterial.awning, { amplitude: 0.05, frequency: 0.7, pin: "sides", lean: 0, flutter: 0.6 });
  life.cloth([bagMaterial.tunic, bagMaterial.check], { amplitude: 0.06, frequency: 1.2, pin: { height: 2.62, reach: 0.9 }, lean: 1.6, flutter: 0.5 });
  life.cloth(bagMaterial.hung, { amplitude: 0.003, frequency: 1, pin: "top", lean: 40, flutter: 0 });
  const bag: Record<BagKey, THREE.BufferGeometry[]> = { joinery: [], iron: [], brass: [], pottery: [], fabric: [], gingham: [], matte: [], glow: [], rope: [], tiles: [], awning: [], tunic: [], check: [], hung: [] };
  const IRON = 0x1b1a19, HEMP = 0xb89a6c;
  /** Bakes a locally built piece into the world and files it under a material. A piece that brings its own colours keeps them. */
  const emit = (key: BagKey, source: THREE.BufferGeometry, matrix: THREE.Matrix4, colour: THREE.ColorRepresentation = 0xffffff, gain = 1) => {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    geometry.applyMatrix4(matrix);
    if (!geometry.attributes.color) {
      const tint = new THREE.Color(colour).multiplyScalar(gain), count = geometry.attributes.position.count, colours = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) { colours[i * 3] = tint.r; colours[i * 3 + 1] = tint.g; colours[i * 3 + 2] = tint.b; }
      geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    }
    for (const name of Object.keys(geometry.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) geometry.deleteAttribute(name);
    bag[key].push(geometry);
  };
  /** Files a piece of something that hangs from the origin of `m`: how far below the nail it is goes into its texture coordinate, and the wind leans it by that. */
  const dangle = (source: THREE.BufferGeometry, m: THREE.Matrix4, colour: THREE.ColorRepresentation, gain = 1) => {
    const position = source.attributes.position, held = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i += 1) held[i * 2 + 1] = 1 - Math.min(1, Math.max(0, -position.getY(i)) / 0.9);
    source.setAttribute("uv", new THREE.BufferAttribute(held, 2));
    emit("hung", source, m, colour, gain);
  };
  const UP = new THREE.Vector3(0, 1, 0);
  const M = (x: number, y: number, z: number, yaw = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(s, s, s));
  /** A frame standing on a side wall's face: x runs along the wall, z points into the hall. */
  const W = (side: number, z: number, s = 0, y = 0, out = 0) => M(...onWall(side, z, s, y, out), faceYaw(side));
  const L = (m: THREE.Matrix4, x: number, y: number, z: number, yaw = 0, s = 1) => m.clone().multiply(M(x, y, z, yaw, s));
  const HERE = M(0, 0, 0);
  const pick = rng(4242);
  const spin = () => pick() * Math.PI * 2;
  const GLAZES = [0x2c5a60, 0xa89c7c, 0x6e3a2c, 0x2c406c, 0x86502f, 0x4f5c3a, 0xa07f38, 0xb0aa98];
  const paintOf = (hex: number, gain = 3.4) => new THREE.Color(hex).multiplyScalar(gain);

  // ---- Goods from the shared props library ---------------------------------
  // Sacks, baskets, crates, pots, bottles and produce are gathered per kind and placed once at the
  // end, so each kind is one batch however many stalls use it. Pots on shelves and in the oriels
  // are filed apart: they stand in shade and cast no shadow.
  const props = createProps(kit, { seed: 9 });
  const goods = new Map<string, { kind: PropKind; cast: boolean; items: PropItem[] }>();
  const pose = { position: new THREE.Vector3(), turn: new THREE.Quaternion(), scale: new THREE.Vector3(), euler: new THREE.Euler() };
  /** Files a library prop standing in the frame `m`. */
  const put = (kind: PropKind, m: THREE.Matrix4, extra: Partial<PropItem> = {}, cast = true) => {
    m.decompose(pose.position, pose.turn, pose.scale);
    pose.euler.setFromQuaternion(pose.turn, "XYZ");
    const key = `${kind}${cast ? "" : " shaded"}`, batch = goods.get(key) ?? { kind, cast, items: [] };
    batch.items.push({ position: pose.position.toArray() as V3, rotation: [pose.euler.x, pose.euler.y, pose.euler.z], scale: pose.scale.toArray() as V3, ...extra });
    goods.set(key, batch);
  };
  const frameOf = (item: PropItem) => new THREE.Matrix4().compose(new THREE.Vector3(...item.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(item.rotation ?? [0, 0, 0]))), new THREE.Vector3(...(item.scale ?? [1, 1, 1])));
  let settled = 0;
  /** Produce settled loose on a surface: `m` is the middle of the patch, `size` its extent along x and z, `each` the scale of a piece. */
  const pile = (m: THREE.Matrix4, kinds: PropKind | PropKind[], count: number, size: [number, number], each = 1, extra: Partial<PropItem> = {}) => {
    for (const item of props.heap(kinds, { at: [0, 0, 0], size, count, scale: each, seed: 60 + (settled += 1), place: false }).items) put(item.kind, m.clone().multiply(frameOf(item)), extra);
  };
  /** A basket, tray or crate standing in the frame `m` with `count` pieces settled into it; if the frame is tilted the load tips with it. */
  const load = (container: PropKind, m: THREE.Matrix4, kinds: PropKind | PropKind[], count: number, each = 1, extra: Partial<PropItem> = {}) => {
    const room = props.get(container).inside!, size = new THREE.Vector3().setFromMatrixScale(m).x;
    put(container, m);
    const heap = props.heap(kinds, { at: [0, room.floor, 0], ...(room.size ? { size: room.size } : { radius: room.radius }), rim: room.rim, flare: room.flare, count, scale: each / size, seed: 60 + (settled += 1), place: false });
    for (const item of heap.items) put(item.kind, m.clone().multiply(frameOf(item)), extra);
  };

  /** Wall-hung shelves on carved brackets, loaded with pottery or metalware. Origin on the floor line at the wall. */
  const rack = (m: THREE.Matrix4, width: number, wares: "pots" | "brass") => {
    emit("joinery", box(width, 1.62, 0.025, 0, 2.0, 0.0125), m, 0xb8a48c);
    emit("joinery", softBox(width + 0.12, 0.07, 0.1, 0.01, 1.3).translate(0, 2.84, 0.05), m);
    for (const y of [1.3, 1.85, 2.4]) {
      emit("joinery", softBox(width + 0.08, 0.035, 0.3, 0.008, 1.3).translate(0, y, 0.15), m);
      emit("joinery", box(width, 0.03, 0.012, 0, y + 0.03, 0.29), m, 0xa89078);
      for (const x of [-width / 2 + 0.06, width / 2 - 0.06]) emit("joinery", bracketGeometry(0.27, 0.24).translate(x, y - 0.017, 0.02), m, 0x9a8068);
      const top = y + 0.0175;
      if (wares === "pots") {
        // Lidded jars, crocks and small amphorae and urns of mixed sizes, each turned its own way.
        for (let x = -width / 2 + 0.06; ;) {
          const draw = pick(), kind: PropKind = draw < 0.42 ? "jarCeramic" : draw < 0.64 ? "crock" : draw < 0.83 ? "amphora" : "urn";
          const scale = kind === "jarCeramic" ? 0.55 + pick() * 0.37 : kind === "crock" ? 0.68 + pick() * 0.17 : kind === "amphora" ? 0.34 + pick() * 0.06 : 0.36 + pick() * 0.08;
          const half = props.get(kind).size[0] * scale / 2;
          if (x + half * 2 > width / 2 - 0.04) break;
          put(kind, L(m, x + half, top, 0.16, kind === "crock" || kind === "urn" ? (pick() - 0.5) * 0.5 : spin(), scale), {}, false);
          x += half * 2 + 0.035 + pick() * 0.08;
        }
      } else for (let x = -width / 2 + 0.17; x < width / 2 - 0.13;) {
        const scale = 0.62 + pick() * 0.3, kind = Math.floor(pick() * 4), copper = pick() < 0.4 ? 0xffb38a : 0xffffff;
        if (kind === 3) emit("brass", trayGeometry().scale(0.5, 0.5, 0.5).rotateX(-0.2).translate(x, top + 0.17, 0.07), m, copper);
        else emit("brass", vesselGeometry(kind), L(m, x, top, 0.15, spin(), 0.4 + pick() * 0.08), copper);
        x += 0.2 + scale * 0.16 + pick() * 0.06;
      }
    }
    if (!high) return;
    // Hooks under the bottom shelf: pans under the copper, small baskets hung by one handle under the pots.
    const hung = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    for (let x = -width / 2 + 0.25, index = 0; x < width / 2 - 0.2; x += 0.32, index += 1) {
      emit("iron", rod([x, 1.28, 0.22], [x, 1.14, 0.22], 0.004, 4), m, IRON);
      if (wares === "brass") emit("brass", lathe(TURNED.pan, 12).rotateX(Math.PI / 2).translate(x, 1.03, 0.2), m, pick() < 0.5 ? 0xffb38a : 0xffffff);
      else if (index % 2 === 0) {
        const size = 0.36 + pick() * 0.1;
        put("basket", L(m, x, 1.143 - 0.27 * size, 0.22 - 0.3 * size, 0, size).multiply(hung).multiply(new THREE.Matrix4().makeRotationY((pick() - 0.5) * 0.3)), {}, false);
      }
    }
  };

  const stool = (m: THREE.Matrix4) => {
    emit("joinery", new THREE.CylinderGeometry(0.17, 0.16, 0.04, 14).translate(0, 0.46, 0), m);
    for (let i = 0; i < 3; i += 1) {
      const a = i * 2.094 + 0.4;
      emit("joinery", rod([Math.cos(a) * 0.09, 0.45, Math.sin(a) * 0.09], [Math.cos(a) * 0.18, 0, Math.sin(a) * 0.18], 0.02, 6), m, 0xd0c0a8);
    }
    emit("joinery", new THREE.TorusGeometry(0.13, 0.011, 5, 14).rotateX(Math.PI / 2).translate(0, 0.18, 0), m, 0xd0c0a8);
  };

  const teaTray = (m: THREE.Matrix4) => {
    emit("brass", lathe(TURNED.flatTray, 24), m);
    for (let i = 0; i < 5; i += 1) {
      const a = i * 1.257 + 0.3, x = Math.cos(a) * 0.19, z = Math.sin(a) * 0.19;
      emit("brass", lathe(TURNED.pan, 10).scale(0.42, 0.42, 0.42).translate(x, 0.02, z), m);
      emit("pottery", lathe(TURNED.glass, 10).translate(x, 0.032, z), m, 0xc8641a, 1.5);
    }
    emit("pottery", lathe(TURNED.bowl, 12).scale(0.42, 0.42, 0.42).translate(0, 0.02, 0), m, 0xf0ead8);
  };

  const samovar = (m: THREE.Matrix4) => {
    emit("brass", lathe(TURNED.samovar, 20), m);
    for (const side of [-1, 1]) emit("brass", new THREE.TorusGeometry(0.06, 0.012, 5, 10, Math.PI).rotateZ(-side * Math.PI / 2).translate(side * 0.18, 0.34, 0), m);
    emit("brass", rod([0, 0.2, 0.16], [0, 0.18, 0.27], 0.012), m);
    emit("brass", box(0.012, 0.05, 0.03, 0, 0.215, 0.25, 1), m);
    emit("pottery", lathe(TURNED.jar, 12).scale(0.45, 0.4, 0.45).translate(0, 0.88, 0), m, 0xf0ead8);
  };

  /** Charcoal brazier on three legs with a kettle on its trivet. */
  const brazier = (m: THREE.Matrix4) => {
    emit("iron", lathe(TURNED.brazier, 16).translate(0, 0.3, 0), m, IRON);
    emit("iron", new THREE.TorusGeometry(0.2, 0.01, 4, 16).rotateX(Math.PI / 2).translate(0, 0.14, 0), m, IRON);
    for (let i = 0; i < 3; i += 1) {
      const a = i * 2.094, c = Math.cos(a), s = Math.sin(a);
      emit("iron", rod([c * 0.14, 0.34, s * 0.14], [c * 0.25, 0, s * 0.25], 0.014), m, IRON);
      emit("iron", rod([c * 0.25, 0.47, s * 0.25], [-c * 0.12, 0.53, -s * 0.12], 0.008, 4), m, IRON);
    }
    emit("glow", new THREE.CircleGeometry(0.215, 14).rotateX(-Math.PI / 2).translate(0, 0.425, 0), m, new THREE.Color(1.5, 0.26, 0.03));
    for (let i = 0; i < 12; i += 1) {
      const a = spin(), r = Math.sqrt(pick()) * 0.18, hot = pick() < 0.6;
      emit(hot ? "glow" : "matte", new THREE.DodecahedronGeometry(0.03 + pick() * 0.02, 0).translate(Math.cos(a) * r, 0.44 + pick() * 0.02, Math.sin(a) * r), m, hot ? new THREE.Color(5, 1.5 + pick(), 0.25) : new THREE.Color(0x140d08));
    }
    emit("brass", vesselGeometry(1).scale(0.66, 0.52, 0.66).translate(0, 0.53, 0), m, 0xffb38a);
    emit("brass", new THREE.TorusGeometry(0.07, 0.008, 4, 10, Math.PI).translate(0, 0.9, 0), m, 0xffb38a);
  };

  const TIMBER_TONES = [0xffffff, 0xe8d8c2, 0xd4c4ac, 0xf4e6cc, 0xc4b49c];
  const timberTone = () => TIMBER_TONES[Math.floor(pick() * TIMBER_TONES.length)];
  /** Boards laid edge to edge with open joints: each runs `length` along x, together they cover `depth` outward from `z0`, top face at `y`. */
  const planking = (m: THREE.Matrix4, length: number, depth: number, y: number, z0: number, thick = 0.032, count = Math.max(2, Math.round(depth / 0.14))) => {
    const each = depth / count;
    for (let i = 0; i < count; i += 1) {
      const over = (pick() - 0.5) * 0.04;
      emit("joinery", stick(length + Math.abs(over), thick, each - 0.007, over / 2, y - thick / 2 - pick() * 0.003, z0 + (i + 0.5) * each), m, timberTone());
    }
  };
  /** A wooden peg driven through a joint along z (or x), its head left a little proud on both faces. */
  const peg = (m: THREE.Matrix4, x: number, y: number, z: number, through: number, alongX = false) => {
    const pin = new THREE.CylinderGeometry(0.008, 0.008, through + 0.01, 6);
    emit("joinery", (alongX ? pin.rotateZ(Math.PI / 2) : pin.rotateX(Math.PI / 2)).translate(x, y, z), m, 0x7a6248);
  };

  /**
   * Stepped display stand against a wall: two plank treads on sawn frames, a painted riser between them,
   * rails, braces and pegs. Origin on the floor at the wall face, x along the wall, z out into the hall.
   * The upper tread is 0.92 m high and 0.45 m deep, the lower 0.5 m high and reaches 0.88 m out.
   */
  const stand = (m: THREE.Matrix4, width: number, paint: number) => {
    const half = width / 2 - 0.09, frames = width > 1.9 ? [-half, 0, half] : [-half, half];
    planking(m, width, 0.4, 0.5, 0.47, 0.032, 3);
    planking(m, width, 0.42, 0.92, 0.03, 0.032, 3);
    for (const [y, z] of [[0.512, 0.874], [0.932, 0.456]]) emit("joinery", stick(width + 0.02, 0.06, 0.02, 0, y, z), m, 0xb8a890);
    emit("joinery", stick(width - 0.16, 0.3, 0.016, 0, 0.7, 0.462, 0), m, paintOf(paint, 3));
    for (const x of frames) {
      emit("joinery", stick(0.05, 0.888, 0.05, x, 0.444, 0.16), m, 0xd0c0a8);
      emit("joinery", stick(0.05, 0.888, 0.05, x, 0.444, 0.425), m, 0xd0c0a8);
      emit("joinery", stick(0.05, 0.468, 0.05, x, 0.234, 0.835), m, 0xd0c0a8);
      emit("joinery", stick(0.036, 0.06, 0.4, x + 0.043, 0.858, 0.26), m);
      emit("joinery", stick(0.036, 0.06, 0.48, x + 0.043, 0.438, 0.635), m);
      emit("joinery", stick(0.032, 0.05, 0.72, x - 0.041, 0.12, 0.5), m);
      // Raking brace from the foot of the front leg up to the tall middle leg.
      emit("joinery", stick(0.03, 0.045, 0.62, 0, 0, 0).rotateX(0.86).translate(x - 0.041, 0.4, 0.63), m, 0xb8a890);
      for (const [y, z] of [[0.858, 0.16], [0.858, 0.425], [0.438, 0.835], [0.438, 0.425]]) peg(m, x + 0.018, y, z, 0.086, true);
    }
    emit("joinery", stick(half * 2, 0.045, 0.028, 0, 0.3, 0.874), m);
    emit("joinery", stick(half * 2, 0.05, 0.028, 0, 0.78, 0.121), m);
  };

  /**
   * A joiner's table: plank top on four pegged legs, aprons, low stretchers and, if asked, a slatted
   * shelf and drawers on the side `face` looks along z. Origin on the floor under its middle, long side on x.
   */
  const bench = (m: THREE.Matrix4, width: number, depth: number, height: number, options: { shelf?: boolean; drawers?: number; face?: number } = {}) => {
    const lx = width / 2 - 0.08, lz = depth / 2 - 0.055, under = height - 0.045, face = options.face ?? 1;
    planking(m, width, depth, height, -depth / 2, 0.045);
    for (const x of [-lx, lx]) for (const z of [-lz, lz]) {
      emit("joinery", stick(0.065, under, 0.065, x, under / 2, z, 0.009), m, 0xd8c8b0);
      for (const dy of [0.03, 0.075]) peg(m, x, under - dy, z, 0.065);
    }
    for (const z of [-lz, lz]) if (!(options.drawers && z * face > 0)) emit("joinery", stick(lx * 2 - 0.065, 0.11, 0.026, 0, under - 0.055, z, 0), m, 0xc8b8a0);
    for (const x of [-lx, lx]) {
      emit("joinery", stick(0.026, 0.11, lz * 2 - 0.065, x, under - 0.055, 0, 0), m, 0xc8b8a0);
      emit("joinery", stick(0.034, 0.05, lz * 2 - 0.065, x, 0.15, 0), m);
    }
    emit("joinery", stick(lx * 2, 0.05, 0.034, 0, 0.15, 0), m);
    if (options.shelf) planking(m, lx * 2 + 0.03, lz * 2 - 0.04, 0.2, -(lz - 0.02), 0.022, 3);
    if (options.drawers) {
      const each = (lx * 2 - 0.065) / options.drawers, z = face * lz;
      emit("joinery", stick(lx * 2 - 0.065, 0.022, 0.026, 0, under - 0.011, z, 0), m, 0xc8b8a0);
      emit("joinery", stick(lx * 2 - 0.065, 0.02, 0.026, 0, under - 0.105, z, 0), m, 0xc8b8a0);
      for (let i = 0; i < options.drawers; i += 1) {
        const x = (i - (options.drawers - 1) / 2) * each, out = i === 1 ? 0.03 : 0;
        emit("joinery", stick(each - 0.014, 0.068, 0.022, x, under - 0.058, z + face * (0.006 + out), 0.005), m, timberTone());
        emit("brass", new THREE.SphereGeometry(0.014, 8, 6).scale(1, 1, 0.8).translate(x, under - 0.058, z + face * (0.024 + out)), m);
        emit("brass", new THREE.CylinderGeometry(0.02, 0.02, 0.003, 10).rotateX(Math.PI / 2).translate(x, under - 0.058, z + face * (0.0185 + out)), m);
      }
    }
  };

  /** Slatted duckboard keeping sacks off the stone. Origin on the floor at its middle, slats along x. */
  const duckboard = (m: THREE.Matrix4, width: number, depth: number) => {
    for (const x of [-width / 2 + 0.12, 0, width / 2 - 0.12]) emit("joinery", stick(0.07, 0.055, depth, x, 0.0275, 0, 0), m, 0xb8a890);
    planking(m, width, depth - 0.02, 0.085, -depth / 2 + 0.01, 0.03, Math.round(depth / 0.125));
  };

  /** Beam balance on a drawer box: turned column, knife-edge beam out of level, pans on three chains, a run of weights. */
  const scales = (m: THREE.Matrix4, heap: number) => {
    emit("joinery", stick(0.34, 0.075, 0.17, 0, 0.0375, 0, 0.008), m, 0x9a8068);
    emit("joinery", stick(0.2, 0.04, 0.012, 0, 0.036, 0.087, 0.004), m, 0xc8b8a0);
    emit("brass", new THREE.SphereGeometry(0.009, 8, 6).translate(0, 0.036, 0.097), m);
    emit("brass", lathe([[0, 0], [0.04, 0], [0.043, 0.008], [0.02, 0.022], [0.011, 0.05], [0.014, 0.2], [0.022, 0.215], [0.012, 0.23], [0.009, 0.4], [0.017, 0.415], [0.007, 0.435], [0.011, 0.455], [0, 0.47]], 12).translate(0, 0.075, 0), m);
    const tilt = 0.1, pivot = 0.5, arm = 0.27;
    const along = (x: number, y = 0): V3 => [x * Math.cos(tilt) - y * Math.sin(tilt), pivot + x * Math.sin(tilt) + y * Math.cos(tilt), 0];
    emit("brass", worldBox(arm * 2 + 0.03, 0.016, 0.007, 1).rotateZ(tilt).translate(0, pivot, 0), m);
    emit("brass", rod(along(0, 0), along(0, -0.16), 0.003, 4), m);
    emit("iron", new THREE.ConeGeometry(0.008, 0.02, 4).translate(0, pivot - 0.012, 0), m, IRON);
    for (const side of [-1, 1]) {
      const end = along(side * arm), drop = side < 0 ? 0.25 : 0.27, pan: V3 = [end[0], end[1] - drop, 0];
      emit("brass", new THREE.TorusGeometry(0.012, 0.003, 4, 8).translate(end[0], end[1] - 0.012, 0), m);
      for (let i = 0; i < 3; i += 1) {
        const a = i * 2.094 + 0.5;
        emit("iron", rod([end[0], end[1] - 0.022, 0], [pan[0] + Math.cos(a) * 0.104, pan[1] + 0.036, Math.sin(a) * 0.104], 0.0022, 4), m, 0x6a5a40);
      }
      emit("brass", lathe(TURNED.pan, 16).translate(...pan), m);
    }
    const low = along(-arm);
    emit("matte", new THREE.SphereGeometry(0.075, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1).translate(low[0], low[1] - 0.25 + 0.012, 0), m, heap);
    for (let i = 0; i < 5; i += 1) {
      const r = 0.011 + i * 0.0035;
      emit("brass", lathe([[0, 0], [r, 0], [r, r * 1.5], [r * 0.5, r * 1.7], [r * 0.35, r * 2.1], [r * 0.55, r * 2.4], [0, r * 2.5]], 8).translate(-0.12 + i * 0.055 + i * i * 0.004, 0.075, -0.045), m);
    }
  };

  /** A pole hung on two cords with long tunics on it. Origin at the middle of the pole; the tunics face +z. */
  const garmentRail = (m: THREE.Matrix4, width: number, count: number) => {
    emit("joinery", rod([-width / 2, 0, 0], [width / 2, 0, 0], 0.022, 8), m, 0xc8b8a0);
    for (const x of [-width / 2 + 0.08, width / 2 - 0.08]) {
      emit("rope", rod([x, 0, 0], [x, 0.5, 0], 0.007, 4), m, HEMP);
      emit("rope", new THREE.TorusGeometry(0.03, 0.007, 4, 8).rotateY(Math.PI / 2).translate(x, 0, 0), m, HEMP);
    }
    const TRIMS = [0xe8dcc0, 0xd9a441, 0x1f2f4f, 0x6a1f1c];
    for (let i = 0; i < count; i += 1) {
      const x = -width / 2 + 0.36 + i * (width - 0.72) / Math.max(1, count - 1), checked = i % 3 === 1, gain = checked ? 1.1 : 0.62;
      const dye = new THREE.Color(checked ? 0xffffff : CLOTH_DYES[Math.floor(pick() * CLOTH_DYES.length)]).multiplyScalar(gain);
      const trim = new THREE.Color(TRIMS[Math.floor(pick() * TRIMS.length)]).multiplyScalar(checked ? 0.5 : gain);
      const hung = L(m, x, 0, (pick() - 0.5) * 0.03, (pick() - 0.5) * 0.5);
      emit(checked ? "check" : "tunic", garmentGeometry(0.78 + pick() * 0.18, pick() * 6, dye, trim), hung);
      // Wire hanger: a hook over the rail and its shank into the collar.
      emit("iron", merge([new THREE.TorusGeometry(0.03, 0.004, 4, 10, Math.PI * 1.3).rotateY(Math.PI / 2).rotateX(-0.5), rod([0, -0.028, 0.012], [0, -0.1, 0], 0.004, 4)]), hung, 0x8a8478);
    }
  };

  const BEADS = [0x2f8f88, 0xd9952b, 0xa8322a, 0x27508a, 0xd8ccb0, 0x6a2d6a];
  /** Striped awning on a pole and two stays. Origin at the middle of its fixed edge on the wall. */
  const awning = (m: THREE.Matrix4, width: number, first: number, second: number, reach = 1.1, drop = 0.45) => {
    const stripes = Math.round(width / 0.3) | 1, tones = [new THREE.Color(first), new THREE.Color(second)];
    const stripe = (source: THREE.BufferGeometry, per: number) => {
      source.computeVertexNormals();
      const geometry = source.toNonIndexed(), position = geometry.attributes.position, colours = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i += 3) {
        const column = Math.min(stripes * per - 1, Math.floor(((position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3 / width + 0.5) * stripes * per));
        const tone = tones[Math.floor(column / per) % 2];
        for (let k = 0; k < 3; k += 1) { colours[(i + k) * 3] = tone.r; colours[(i + k) * 3 + 1] = tone.g; colours[(i + k) * 3 + 2] = tone.b; }
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      source.dispose();
      return geometry;
    };
    // Finely divided so it can ripple; its texture coordinate runs from the wall to the pole, which is where it is held.
    const sheet = new THREE.PlaneGeometry(width, 1, stripes * 3, 10), position = sheet.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const u = position.getX(i) / width, v = 0.5 - position.getY(i);
      position.setY(i, -drop * v - 0.07 * Math.sin(Math.PI * v) * (1 - 2.4 * u * u));
      position.setZ(i, reach * v);
    }
    emit("awning", stripe(sheet, 3), m);
    const skirt = new THREE.PlaneGeometry(width, 0.18, stripes * 2, 1), hem = skirt.attributes.position;
    for (let i = 0; i < hem.count; i += 1) {
      const column = Math.round((hem.getX(i) / width + 0.5) * stripes * 2), low = hem.getY(i) < 0;
      hem.setY(i, -drop - (low ? (column % 2 ? 0.2 : 0.12) : 0));
      hem.setZ(i, reach + (low ? 0.012 : 0));
      // The scalloped valance is sewn along the pole and free at its hem.
      skirt.attributes.uv.setY(i, low ? 0.5 : 0);
    }
    emit("awning", stripe(skirt, 2), m);
    emit("joinery", rod([-width / 2 - 0.06, -drop, reach], [width / 2 + 0.06, -drop, reach], 0.022, 8), m, 0xc8b8a0);
    // A fringe of glass beads threaded under the pole, behind the valance.
    for (let x = -width / 2 + 0.05, strand = 0; x < width / 2 - 0.03; x += 0.075, strand += 1) {
      const long = 0.24 + 0.2 * Math.abs(Math.sin(strand * 0.52)), nail = L(m, x, -drop - 0.02, reach - 0.012);
      dangle(new THREE.BoxGeometry(0.0025, long, 0.0025).translate(0, -long / 2, 0), nail, 0x3a3026);
      for (let y = 0.035, bead = 0; y < long; y += 0.036, bead += 1) {
        dangle(new THREE.OctahedronGeometry(bead % 4 === 3 ? 0.015 : 0.011).translate(0, -y, 0), nail, BEADS[(strand + bead * 2) % BEADS.length], 1.7);
      }
    }
    for (const x of [-width / 2, width / 2]) {
      emit("joinery", rod([x, 0, 0], [x, -drop, reach], 0.018, 6), m, 0xc8b8a0);
      emit("iron", rod([x, -drop, reach], [x, -1.05, 0.01], 0.011, 5), m, IRON);
      emit("iron", box(0.05, 0.1, 0.03, x, -1.05, 0.015, 1), m, IRON);
    }
  };

  /** A cord of dried goods hanging from the origin: 0 chillies, 1 garlic, 2 dried fruit. */
  const driedString = (m: THREE.Matrix4, kind: number, length: number) => {
    dangle(rod([0, 0, 0], [0, -length, 0], 0.006, 4), m, HEMP);
    const step = kind === 0 ? 0.035 : 0.062;
    for (let y = 0.1; y < length; y += step) {
      const a = spin(), x = Math.cos(a) * 0.022, z = Math.sin(a) * 0.022;
      if (kind === 0) dangle(new THREE.ConeGeometry(0.015, 0.1, 5).rotateZ(Math.PI + (pick() - 0.5) * 0.9).rotateY(a).translate(x, -y - 0.04, z), m, pick() < 0.7 ? 0xb02216 : 0x7a1410);
      else if (kind === 1) {
        // A head of garlic: a flattened bulb with its dry neck plaited into the cord.
        const bulb = merge([new THREE.SphereGeometry(0.033, 8, 6).scale(1, 0.82, 1), new THREE.ConeGeometry(0.011, 0.05, 5).translate(0, 0.045, 0)]);
        dangle(bulb.rotateZ((pick() - 0.5) * 1.2).rotateY(a).translate(x * 1.3, -y - 0.04, z * 1.3), m, 0xcfc3a6);
      } else dangle(new THREE.SphereGeometry(0.03, 7, 5).scale(1, 0.45, 1).rotateX(pick() * 3).translate(x, -y, z), m, pick() < 0.5 ? 0xd9801c : 0x8a3a12);
    }
  };

  /** Tall water jar; some keep a wooden lid on. */
  const waterJar = (x: number, z: number, scale: number, lid: boolean) => {
    put("amphora", M(x, 0, z, spin(), scale));
    if (lid) emit("joinery", lathe(TURNED.lid, 14), M(x, 0.925 * scale, z, 0, 0.66 * scale));
  };

  /** Spoked cart wheel on the x axis. */
  const wheel = (m: THREE.Matrix4, x: number, radius: number) => {
    emit("joinery", new THREE.TorusGeometry(radius, 0.034, 6, 26).rotateY(Math.PI / 2).translate(x, radius + 0.04, 0), m, 0xb8a080);
    emit("iron", new THREE.TorusGeometry(radius + 0.03, 0.012, 4, 26).rotateY(Math.PI / 2).translate(x, radius + 0.04, 0), m, IRON);
    for (let i = 0; i < 4; i += 1) emit("joinery", worldBox(0.03, radius * 2 - 0.05, 0.036, 1.3).rotateX(i * Math.PI / 4).translate(x, radius + 0.04, 0), m, 0xb8a080);
    emit("joinery", new THREE.CylinderGeometry(0.06, 0.06, 0.15, 10).rotateZ(Math.PI / 2).translate(x, radius + 0.04, 0), m);
    emit("iron", new THREE.CylinderGeometry(0.025, 0.025, 0.2, 8).rotateZ(Math.PI / 2).translate(x, radius + 0.04, 0), m, IRON);
  };

  /** Two-wheeled handcart loaded with rolled rugs; its shafts run out along +z. */
  const handcart = (m: THREE.Matrix4) => {
    for (const x of [-0.56, 0.56]) wheel(m, x, 0.42);
    emit("iron", rod([-0.56, 0.46, 0], [0.56, 0.46, 0], 0.02), m, IRON);
    emit("joinery", box(0.9, 0.04, 1.5, 0, 0.64, 0), m);
    for (const x of [-0.36, 0.36]) {
      emit("joinery", box(0.06, 0.07, 2.5, x, 0.585, 0.5), m, 0xc8b8a0);
      emit("joinery", box(0.08, 0.12, 0.12, x, 0.5, 0), m);
      emit("joinery", box(0.05, 0.56, 0.05, x, 0.28, 0.7), m);
    }
    for (const x of [-0.43, 0.43]) {
      for (const z of [-0.72, 0, 0.72]) emit("joinery", box(0.04, 0.34, 0.04, x, 0.83, z), m);
      for (const y of [0.8, 0.96]) emit("joinery", box(0.028, 0.05, 1.5, x, y, 0), m, 0xc8b8a0);
    }
    emit("joinery", box(0.86, 0.3, 0.025, 0, 0.81, -0.735), m);
    const lay: Array<[number, number, number]> = [[-0.27, 0.79, 0], [0, 0.79, 1], [0.27, 0.79, 2], [-0.13, 1.0, 3], [0.14, 1.0, 5]];
    for (const [x, y, dye] of lay) {
      emit("fabric", new THREE.CylinderGeometry(0.125, 0.125, 1.5 + pick() * 0.2, 12).rotateX(Math.PI / 2).translate(x, y, 0.06), m, RUG_DYES[dye]);
      emit("fabric", new THREE.TorusGeometry(0.128, 0.012, 4, 12).translate(x, y, 0.5), m, HEMP);
    }
  };

  /** Sack truck standing with its back to -z. */
  const barrow = (m: THREE.Matrix4) => {
    for (const x of [-0.2, 0.2]) {
      emit("iron", rod([x, 0.1, 0], [x, 1.22, -0.26], 0.016), m, 0x3f5a50);
      emit("iron", rod([x, 1.22, -0.26], [x * 1.3, 1.36, -0.4], 0.016), m, 0x3f5a50);
      emit("matte", new THREE.CylinderGeometry(0.115, 0.115, 0.05, 14).rotateZ(Math.PI / 2).translate(x * 1.45, 0.115, -0.04), m, 0x0e0e0e);
    }
    for (const t of [0.2, 0.5, 0.8]) emit("iron", rod([-0.2, 0.1 + 1.12 * t, -0.26 * t], [0.2, 0.1 + 1.12 * t, -0.26 * t], 0.012), m, 0x3f5a50);
    emit("iron", rod([-0.3, 0.115, -0.04], [0.3, 0.115, -0.04], 0.012), m, IRON);
    emit("iron", box(0.46, 0.012, 0.28, 0, 0.07, 0.13, 1), m, 0x3f5a50);
  };

  /** A bicycle standing along x, front wheel at +x. */
  const bicycle = (m: THREE.Matrix4, frame: number) => {
    const tube = (a: V3, b: V3, radius = 0.014, colour = frame) => emit("iron", rod(a, b, radius, 6), m, colour, colour === frame ? 2 : 1);
    for (const x of [-0.52, 0.52]) {
      emit("matte", new THREE.TorusGeometry(0.33, 0.018, 6, 26).translate(x, 0.35, 0), m, 0x0c0c0c);
      emit("iron", new THREE.TorusGeometry(0.31, 0.008, 4, 26).translate(x, 0.35, 0), m, 0x8a8a8a);
      for (let i = 0; i < 9; i += 1) { const a = i * Math.PI / 9; tube([x - Math.cos(a) * 0.31, 0.35 - Math.sin(a) * 0.31, 0], [x + Math.cos(a) * 0.31, 0.35 + Math.sin(a) * 0.31, 0], 0.0025, 0x9a9a9a); }
      emit("iron", new THREE.CylinderGeometry(0.02, 0.02, 0.09, 8).rotateX(Math.PI / 2).translate(x, 0.35, 0), m, 0x8a8a8a);
      emit("iron", new THREE.TorusGeometry(0.36, 0.014, 4, 14, Math.PI * 0.75).rotateZ(x < 0 ? Math.PI * 0.3 : Math.PI * 0.1).scale(1, 1, 2.6).translate(x, 0.35, 0), m, frame, 2);
    }
    const B: V3 = [-0.08, 0.32, 0], S: V3 = [-0.2, 0.86, 0], H: V3 = [0.36, 0.9, 0], HB: V3 = [0.4, 0.72, 0];
    tube(B, S, 0.016); tube(S, H); tube(B, HB, 0.016); tube(H, HB, 0.018); tube(B, [-0.52, 0.35, 0.04]); tube(B, [-0.52, 0.35, -0.04]);
    tube(S, [-0.52, 0.35, 0.04], 0.01); tube(S, [-0.52, 0.35, -0.04], 0.01);
    for (const z of [-0.04, 0.04]) tube([0.4, 0.72, z], [0.52, 0.35, z], 0.011);
    tube(S, [-0.22, 0.95, 0], 0.011, 0x8a8a8a); tube(H, [0.34, 1.0, 0], 0.011, 0x8a8a8a);
    tube([0.34, 1.0, -0.24], [0.34, 1.0, 0.24], 0.011, 0x8a8a8a);
    for (const z of [-0.24, 0.24]) emit("matte", new THREE.CylinderGeometry(0.016, 0.016, 0.1, 8).rotateX(Math.PI / 2).translate(0.34, 1.0, z * 0.82), m, 0x1a1410);
    emit("matte", softBox(0.25, 0.05, 0.14, 0.02, 1).translate(-0.23, 0.975, 0), m, 0x4a2c18);
    emit("iron", new THREE.CylinderGeometry(0.09, 0.09, 0.006, 16).rotateX(Math.PI / 2).translate(-0.08, 0.32, 0.05), m, 0x8a8a8a);
    tube([-0.08, 0.32, 0.06], [0.02, 0.2, 0.06], 0.008, 0x8a8a8a); tube([-0.08, 0.32, -0.06], [-0.18, 0.44, -0.06], 0.008, 0x8a8a8a);
    emit("matte", box(0.08, 0.02, 0.06, 0.02, 0.2, 0.1, 1), m, 0x1a1410); emit("matte", box(0.08, 0.02, 0.06, -0.18, 0.44, -0.1, 1), m, 0x1a1410);
    // Carrier with a bundle strapped on, and a basket on the bars.
    emit("iron", box(0.34, 0.012, 0.14, -0.56, 0.72, 0, 1), m, IRON);
    for (const z of [-0.06, 0.06]) tube([-0.7, 0.72, z], [-0.52, 0.35, z], 0.006, IRON);
    emit("fabric", new THREE.CylinderGeometry(0.085, 0.085, 0.36, 10).rotateX(Math.PI / 2).translate(-0.56, 0.81, 0), m, CLOTH_DYES[3]);
    put("basket", L(m, 0.55, 0.8, 0, Math.PI / 2, 0.7));
  };

  // ---- Ground --------------------------------------------------------------
  const flags = flagTextures(high ? 2 : 1);
  track(flags.map); track(flags.normalMap);
  for (const texture of [flags.map, flags.normalMap]) { texture.repeat.set(96 / 3.3, 104 / 3.3); texture.anisotropy = anisotropy; }
  const ground = new THREE.MeshStandardMaterial({ map: flags.map, normalMap: flags.normalMap, normalScale: new THREE.Vector2(1.3, 1.3), roughnessMap: flagRough.roughnessMap, roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  // Dry, foot-polished stone with a chalked firing line; no standing water, no mirror pass.
  const reflection = kit.floor(ground, { width: 96, depth: 104, z: -12 }, {
    lane: new THREE.Color(0.78, 0.66, 0.46),
    edge: new THREE.Color(0.78, 0.66, 0.46),
    markings: 0.4,
    wet: -1,
  }, false);

  // ---- Walls ---------------------------------------------------------------
  const faceYaw = (side: number) => -side * Math.PI / 2;
  /** A point on a side wall's face: `s` metres along it (left to right as you face it), `out` metres proud. */
  const onWall = (side: number, z: number, s: number, y: number, out: number): V3 => [side * (WALL - out), y, z + side * s];
  const groundRun = 30.5, groundZ = -14.95;
  const arcade = archedWall(10.1, STOREY, 0.8, [{ x: -2.4, width: 3.2, spring: 1.9 }, { x: 2.4, width: 3.2, spring: 1.9 }], 2.2);
  arcade.rotateY(Math.PI / 2);
  const upperBays: Array<[number, number]> = [[-30.2, -26], [-26, -20], [-20, -14], [-14, -8], [-8, -2], [-2, 10.5]];
  // Upper storey openings, [z, kind] per side: O oriel, W pair of windows, w one window where a pair would run into the furnace flue or an end wall.
  const upper: Record<string, Array<[number, string]>> = {
    "-1": [[-28, "w"], [-23, "O"], [-17, "W"], [-11, "O"], [-5, "W"], [2.95, "O"], [7.75, "w"]],
    "1": [[-28, "w"], [-23, "W"], [-17, "O"], [-9.7, "w"], [-5, "O"], [2.95, "W"], [7.75, "O"]],
  };
  for (const side of [-1, 1]) {
    const x = side * WALL_MID;
    place(new THREE.Mesh(worldBox(0.8, STOREY, groundRun, 2.2), brickwork), x, STOREY / 2, groundZ, true, true);
    place(new THREE.Mesh(arcade, brickwork), x, 0, 5.35, true, true);
    place(new THREE.Mesh(softBox(0.14, 0.7, 30.2, 0.03, 2), stone), side * 9.5, 0.35, -14.9, false, true);
    // Upper storey: a different wash on each bay.
    upperBays.forEach(([from, to], index) => {
      const middle = (from + to) / 2;
      const openings = upper[String(side)].filter(([z]) => z > from && z <= to).flatMap(([z, kind]) => kind === "O"
        ? [{ x: middle - z, width: 2.5, sill: 0.57, spring: 2.13, flat: true }]
        : (kind === "W" ? [-1.45, 1.45] : [0]).map((s) => ({ x: middle - z + s, width: 1.04, sill: 0.59, spring: 2.11, flat: true })));
      const wall = archedWall(to - from, WALL_TOP - STOREY, 0.8, openings, 3);
      wall.rotateY(Math.PI / 2);
      place(new THREE.Mesh(wall, washes[(index * 2 + (side > 0 ? 3 : 0)) % washes.length]), x, STOREY, middle, true, true);
    });
    // The rooms behind are closed boxes: nothing of the sky or the sun comes through the openings.
    place(new THREE.Mesh(new THREE.BoxGeometry(0.06, WALL_TOP - STOREY, 40.7), shade), side * (WALL_MID + 0.44), (WALL_TOP + STOREY) / 2, -9.85, true);
    // Bressummer between the storeys and a wall plate under the roof.
    place(new THREE.Mesh(softBox(0.2, 0.24, 40.7, 0.02, 1.3), darkOak), side * (WALL - 0.08), STOREY + 0.12, -9.85, false);
    place(new THREE.Mesh(worldBox(0.16, 0.2, 40.7, 1.3), darkOak), side * (WALL - 0.06), 7.02, -9.85, false);
  }
  // The wall behind the firing line (the chart hangs on it) and its boarded gable.
  place(new THREE.Mesh(worldBox(20.7, STOREY, 0.8, 2.2), brickwork), 0, STOREY / 2, 10.12, true, true);
  place(new THREE.Mesh(worldBox(20.7, 7.3 - STOREY, 0.8, 3), limewash), 0, (7.3 + STOREY) / 2, 10.12, true, true);
  place(new THREE.Mesh(softBox(19.1, 0.24, 0.2, 0.02, 1.3), darkOak), 0, STOREY + 0.12, 9.8, false);
  place(new THREE.Mesh(softBox(20.7, 0.3, 0.5, 0.03, 1.3), darkOak), 0, 7.3, 9.95, true);
  const gableShape = (from: number) => {
    const shape = new THREE.Shape();
    const eave = RIDGE + 0.29 - 10.34 * TAN;
    shape.moveTo(-10.34, from); shape.lineTo(10.34, from); shape.lineTo(10.34, eave); shape.lineTo(0, RIDGE + 0.29); shape.lineTo(-10.34, eave); shape.closePath();
    return shape;
  };
  const backGable = new THREE.ExtrudeGeometry(gableShape(7.3), { depth: 0.3, bevelEnabled: false });
  place(new THREE.Mesh(projectUv(backGable, 1.6), boards), 0, 0, 10.0, true);
  // The far wall behind the control centre, with the open lattice gable above it.
  place(new THREE.Mesh(worldBox(20.7, 6.2, 0.8, 2.2), brickwork), 0, 3.1, -29.8, true, true);
  place(new THREE.Mesh(softBox(20.7, 0.26, 0.92, 0.03, 1.3), darkOak), 0, 6.3, -29.8, true);
  // Real laths, so the screen stays crisp against the sky and prints its own shadow down the hall.
  const gableLaths: THREE.BufferGeometry[] = [];
  for (const sign of [-1, 1]) for (let c = -14; c <= 14; c += 0.36) {
    let from = -1, to = -1;
    for (let d = 0; d <= 3.3; d += 0.02) {
      const x = c + sign * d, inside = Math.abs(x) < 10.3 && 6.4 + d < RIDGE + 0.2 - Math.abs(x) * TAN;
      if (inside && from < 0) from = d;
      if (inside) to = d;
    }
    if (from < 0 || to - from < 0.12) continue;
    const middle = (from + to) / 2;
    gableLaths.push(new THREE.BoxGeometry((to - from) * Math.SQRT2, 0.055, 0.026).rotateZ(sign * Math.PI / 4).translate(c + sign * middle, 6.4 + middle, sign * 0.013));
  }
  place(new THREE.Mesh(merge(gableLaths), oak), 0, 0, -29.78, true);
  const mullions: THREE.BufferGeometry[] = [box(20.6, 0.16, 0.2, 0, 7.42, 0)];
  for (let i = -4; i <= 4; i += 1) {
    const x = i * 2.06, top = RIDGE + 0.2 - Math.abs(x) * TAN;
    mullions.push(box(0.16, top - 6.4, 0.2, x, (top + 6.4) / 2, 0));
  }
  place(new THREE.Mesh(merge(mullions), darkOak), 0, 0, -29.78, true);
  // Beyond the lattice the town climbs away into the dust: unlit, with the sun and the haze baked in.
  const town = new THREE.Mesh(townGeometry(TO_SUN, high), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  scene.add(town);
  kit.mirrorHidden.push(town);

  // ---- Frame: posts, trusses, purlins --------------------------------------
  const truss = (() => {
    const parts: THREE.BufferGeometry[] = [box(20.9, 0.26, 0.2, 0, 7.23, 0), box(0.2, 1.74, 0.18, 0, 8.24, 0)];
    for (const side of [-1, 1]) {
      const rafter = worldBox(10.8, 0.22, 0.18, 1.3);
      rafter.rotateZ(-side * PITCH);
      rafter.translate(...onSlope(side, 5.4, 0), 0);
      parts.push(rafter,
        box(0.16, 0.84, 0.16, side * 5.15, 7.78, 0),
        beam([side * 0.1, 7.5], [side * 5.0, 8.16], 0.14, 0.14),
        beam([side * 9.5, 5.72], [side * 8.05, 7.12], 0.15, 0.15),
        beam([side * 5.3, 7.4], [side * 8.6, 7.62], 0.12, 0.12));
    }
    return merge(parts);
  })();
  const trussIron = (() => {
    const parts: THREE.BufferGeometry[] = [box(0.3, 0.07, 0.24, 0, 7.42, 0), box(0.3, 0.07, 0.24, 0, 7.62, 0), box(0.26, 0.07, 0.22, 0, 8.86, 0)];
    for (const side of [-1, 1]) {
      parts.push(box(0.22, 0.06, 0.2, side * 5.15, 7.42, 0), box(0.07, 0.34, 0.24, side * 9.2, 7.26, 0), box(0.07, 0.34, 0.24, side * 8.05, 7.2, 0));
      // Wrought tie from the rafter down to the tie beam.
      parts.push(rod([side * 2.6, 7.36, 0], [side * 2.6, RIDGE - 2.6 * TAN - 0.1, 0], 0.014), rod([side * 7.4, 7.36, 0], [side * 7.4, RIDGE - 7.4 * TAN - 0.1, 0], 0.014));
    }
    // Coach bolts through every strap.
    const bolt = (x: number, y: number) => { for (const z of [-0.125, 0.125]) parts.push(new THREE.CylinderGeometry(0.022, 0.022, 0.02, 6).rotateX(Math.PI / 2).translate(x, y, z)); };
    for (const x of [-0.1, 0.1]) { bolt(x, 7.42); bolt(x, 7.62); bolt(x * 0.8, 8.86); }
    for (const side of [-1, 1]) { bolt(side * 5.08, 7.42); bolt(side * 5.22, 7.42); bolt(side * 9.2, 7.16); bolt(side * 9.2, 7.36); bolt(side * 8.05, 7.1); bolt(side * 8.05, 7.3); }
    return merge(parts);
  })();
  instances(truss, oak, TRUSS_Z.map((z) => ({ position: [0, 0, z] as V3 })));
  instances(trussIron, iron, TRUSS_Z.map((z) => ({ position: [0, 0, z] as V3 })), false, false);
  // Stone corbels carry the braces; every other truss also stands on a post.
  instances(softBox(0.3, 0.3, 0.36, 0.03, 1.2), stone, TRUSS_Z.flatMap((z) => [-1, 1].map((side) => ({ position: [side * 9.4, 5.6, z] as V3 }))), false);
  const postSpots = [...POST_Z, 10].flatMap((z) => [-1, 1].map((side) => ({ side, z })));
  instances(softBox(0.3, 7.1, 0.3, 0.025, 1.3), oak, postSpots.map(({ side, z }) => ({ position: [side * 9.36, 3.55, z] as V3 })), true);
  instances(softBox(0.44, 0.42, 0.44, 0.04, 1.2), stone, postSpots.map(({ side, z }) => ({ position: [side * 9.36, 0.21, z] as V3 })), true);
  instances(worldBox(0.33, 0.06, 0.33, 1), iron, postSpots.flatMap(({ side, z }) => [0.5, 4.3, 5.45].map((y) => ({ position: [side * 9.36, y, z] as V3 }))), false, false);

  for (const side of [-1, 1]) {
    const rotation: V3 = [0, 0, -side * PITCH];
    instances(worldBox(0.14, 0.16, HALL_LENGTH, 1.3), darkOak, PURLINS.map((t) => ({ position: [...onSlope(side, t, 0.19), HALL_MID] as V3, rotation })), false);
    // Ridge capping, eave boards and a cover batten over every truss.
    instances(worldBox(0.56, 0.04, HALL_LENGTH, 1.6), boards, [{ position: [...onSlope(side, 0.25, 0.29), HALL_MID] as V3, rotation }], false);
    instances(worldBox(0.95, 0.04, HALL_LENGTH, 1.6), boards, [{ position: [...onSlope(side, 10.325, 0.29), HALL_MID] as V3, rotation }], false);
    instances(worldBox(10.75, 0.05, 0.22, 1.6), boards, TRUSS_Z.map((z) => ({ position: [...onSlope(side, 5.4, 0.335), z] as V3, rotation })), false);
    // Boarding over the two ends of the hall, outside the truss bays.
    instances(worldBox(10.75, 0.04, 0.72, 1.6), boards, [{ position: [...onSlope(side, 5.4, 0.29), 10.36] as V3, rotation }, { position: [...onSlope(side, 5.4, 0.29), -29.655] as V3, rotation: [0, 0, -side * PITCH] as V3, scale: [1, 1, 1.82] as V3 }], false);
  }
  place(new THREE.Mesh(worldBox(0.16, 0.26, HALL_LENGTH, 1.3), darkOak), 0, RIDGE - 0.02, HALL_MID, false);

  // ---- Roof covering -------------------------------------------------------
  const boardCells: Transform[] = [], slats: Transform[] = [], latticeCells: Transform[] = [];
  // Cloth is gathered per dye: one mesh for what lies on the roof, one for what hangs under it.
  const roofCloth: THREE.BufferGeometry[][] = cloths.map(() => []), hungCloth: THREE.BufferGeometry[][] = cloths.map(() => []);
  const beams = beamBuilder(TO_SUN);
  const BEAM_GAIN: Record<string, number> = { S: 0.8, L: 0.75, O: 1 };
  ROOF.forEach((_, bay) => {
    const z = 8.5 - bay * 3;
    for (const side of [-1, 1]) for (let cell = 0; cell < 4; cell += 1) {
      const from = PURLINS[cell], to = PURLINS[cell + 1], length = to - from, middle = (from + to) / 2;
      const rotation: V3 = [0, 0, -side * PITCH], kind = cellAt(bay, side, cell);
      const at = (h: number, dz = 0): V3 => [...onSlope(side, middle, h), z + dz];
      if (BEAM_GAIN[kind]) {
        const corner = (t: number, dz: number) => new THREE.Vector3(...onSlope(side, t, 0.2), z + dz);
        // The four shadow taps of a sheet step across exactly one slat or lath pitch, so the pattern
        // averages out in the air instead of ruling the beam with fine streaks.
        const pitch = kind === "S" ? 0.0625 : kind === "L" ? 0.0707 : 0;
        for (let i = 0; i < 6; i += 1) beams.sheet(corner(from + 0.05, -1.25 + i * 0.5), corner(to - 0.05, -1.25 + i * 0.5), new THREE.Vector3(0, 0, pitch || 0.125), BEAM_GAIN[kind] * 0.8);
        for (let i = 0; i < 3; i += 1) beams.sheet(corner(from + (i + 0.5) * length / 3, -1.42), corner(from + (i + 0.5) * length / 3, 1.42), new THREE.Vector3(side * (pitch ? 0.06 : 0.2), 0, pitch), BEAM_GAIN[kind]);
      }
      if (kind === "B") boardCells.push({ position: at(0.29), rotation, scale: [length / 2.4, 1, 1] });
      else if (kind === "S") for (let i = 0; i < 12; i += 1) slats.push({ position: at(0.29, -1.375 + i * 0.25), rotation, scale: [length / 2.4, 1, 1] });
      else if (kind === "L") latticeCells.push({ position: at(0.3), rotation, scale: [length / 2.4, 1, 1] });
      else if (kind === "O") {
        // A few boards are left, slipped out of line.
        for (const [dz, skew, wide] of [[-1.28, 0.02, 3.2], [-0.2, -0.07, 1.6], [1.22, 0.03, 4]]) slats.push({ position: at(0.29, dz), rotation: [0, skew, -side * PITCH], scale: [length / 2.4, 1, wide] });
      } else {
        // Dyed cloth laced over the purlins in place of boards.
        roofCloth[(bay * 3 + cell + (side > 0 ? 4 : 0)) % cloths.length].push(clothGeometry(length - 0.06, 2.84, 0.2 + random() * 0.12, 0.025).rotateZ(-side * PITCH).translate(...at(0.3)));
      }
    }
  });
  instances(worldBox(2.4, 0.04, 3, 1.6), boards, boardCells, false, true, [0xffffff, 0xe6d9cc, 0xf3e6d2, 0xd9cdbd, 0xfff4e0]);
  instances(worldBox(2.4, 0.035, 0.11, 1.6), boards, slats, false);
  instances(latticePanelGeometry(2.4, 2.84, 0.2, 0.045, 0.022), oak, latticeCells, false);

  // Beams through the far gable.
  for (let i = 0; i < 6; i += 1) {
    const y = 6.6 + i * 0.46, reach = Math.min(9.4, (RIDGE + 0.1 - y) / TAN);
    beams.sheet(new THREE.Vector3(-reach, y, -29.7), new THREE.Vector3(reach, y, -29.7), new THREE.Vector3(0, 0.11, 0), 0.7);
  }
  for (let x = -8.5; x <= 8.5; x += 1.7) beams.sheet(new THREE.Vector3(x, 6.5, -29.7), new THREE.Vector3(x, RIDGE + 0.1 - Math.abs(x) * TAN, -29.7), new THREE.Vector3(0.4, 0, 0), 0.7);
  const beamLight = beamMaterial();
  beamLight.uniforms.strength.value = 0.014;
  const beamMesh = new THREE.Mesh(beams.build(), beamLight);
  beamMesh.frustumCulled = false;
  beamMesh.renderOrder = 5;
  scene.add(beamMesh);
  kit.mirrorHidden.push(beamMesh);
  kit.probeHidden.push(beamMesh);
  kit.updates.push((now) => { beamLight.uniforms.time.value = now / 1000; });

  // ---- Cloth strung under the roof -----------------------------------------
  /** A cord lashed twice round a tie beam at (x, z) and down to whatever hangs at `y` below it. */
  const lashing = (x: number, z: number, y: number) => {
    for (const dx of [-0.012, 0.012]) for (const [w, h, d, py, pz] of [[0.012, 0.012, 0.226, 7.366, 0], [0.012, 0.012, 0.226, 7.094, 0], [0.012, 0.284, 0.012, 7.23, -0.107], [0.012, 0.284, 0.012, 7.23, 0.107]]) {
      emit("rope", new THREE.BoxGeometry(w, h, d).translate(x + dx, py, z + pz), HERE, HEMP);
    }
    if (y < 7.07) emit("rope", rod([x, 7.09, z], [x, y, z], 0.007, 4), HERE, HEMP);
  };
  // Swags slung between tie beams on a pole at each end: [bay, x, width, sag, dye].
  const swags: Array<[number, number, number, number, number]> = [
    [1, -4.6, 3.6, 0.7, 2], [2, 3.4, 4.4, 0.85, 1], [3, -1.4, 3.2, 0.6, 5], [5, -5.2, 4.2, 0.9, 0], [6, 4.8, 3.4, 0.7, 3],
    [7, -0.6, 4.6, 0.8, 7], [8, -6, 3, 0.6, 4], [9, 5.4, 3.8, 0.85, 6], [10, -6.2, 3.0, 0.6, 1],
  ];
  for (const [bay, x, width, sag, dye] of swags) {
    const z = 8.5 - bay * 3;
    hungCloth[dye].push(slungCloth(2.74, width, sag, bay * 7 + dye).translate(x, 7.03, z));
    for (const end of [-1, 1]) {
      emit("joinery", rod([x - width * 0.45 - 0.14, 7.03, z + end * 1.37], [x + width * 0.45 + 0.14, 7.03, z + end * 1.37], 0.024, 7), HERE, 0xc8b8a0);
      for (const dx of [-width * 0.45 - 0.07, 0, width * 0.45 + 0.07]) {
        lashing(x + dx, z + end * 1.5, 7.2);
        emit("rope", new THREE.TorusGeometry(0.034, 0.008, 4, 8).rotateY(Math.PI / 2).translate(x + dx, 7.045, z + end * 1.385), HERE, HEMP);
      }
    }
  }
  // Lengths of dyed cloth hung to dry on poles under the tie beams: [truss, x, width, drop, dye].
  const banners: Array<[number, number, number, number, number]> = [
    [3, -7.3, 1.5, 2.3, 6], [3, 7.1, 1.3, 1.9, 3], [5, 6.9, 1.6, 2.4, 1], [6, -7.0, 1.4, 2.0, 0], [8, 7.2, 1.5, 2.2, 5], [9, -7.2, 1.6, 2.5, 2], [11, 6.8, 1.4, 2.0, 7],
  ];
  for (const [index, x, width, drop, dye] of banners) {
    const z = TRUSS_Z[index];
    hungCloth[dye].push(bannerGeometry(width, drop, 2, index * 1.9).translate(x, 6.9, z));
    emit("joinery", rod([x - width / 2 - 0.12, 6.9, z], [x + width / 2 + 0.12, 6.9, z], 0.022, 7), HERE, 0xc8b8a0);
    for (const dx of [-width / 2 - 0.06, width / 2 + 0.06]) {
      lashing(x + dx, z, 6.92);
      emit("rope", new THREE.TorusGeometry(0.03, 0.007, 4, 8).rotateY(Math.PI / 2).translate(x + dx, 6.9, z), HERE, HEMP);
    }
  }
  cloths.forEach((material, dye) => {
    for (const [parts, cloth, shadowed] of [[roofCloth[dye], material, false], [hungCloth[dye], drapes[dye], true]] as Array<[THREE.BufferGeometry[], THREE.Material, boolean]>) {
      if (!parts.length) continue;
      const mesh = new THREE.Mesh(merge(parts), cloth);
      // The shadow is the cloth at rest: it breathes in place, so the frozen sun map stays true to it.
      mesh.castShadow = true;
      mesh.receiveShadow = shadowed;
      scene.add(mesh);
    }
  });
  // The big swags crack when a gust front reaches them.
  drapery.snap([3.4, 6.5, 2.5]);

  // ---- Upper storey: oriels, windows and rugs out to air --------------------
  const orielTimber = merge([
    box(2.8, 0.1, 0.52, 0, -0.85, 0.26), box(2.9, 0.1, 0.6, 0, 0.87, 0.3), box(2.7, 0.07, 0.5, 0, 0.95, 0.25),
    ...[-1.31, -0.44, 0.44, 1.31].map((x) => box(0.08, 1.64, 0.08, x, 0, 0.44)),
    box(2.7, 0.07, 0.08, 0, -0.3, 0.44), box(2.7, 0.07, 0.08, 0, 0.5, 0.44),
    // Moulded sill and head, a dentil course and turned drops under the corners.
    softBox(2.96, 0.05, 0.64, 0.02, 1.3).translate(0, -0.78, 0.31), softBox(3.0, 0.05, 0.66, 0.02, 1.3).translate(0, 1.0, 0.32),
    ...Array.from({ length: 13 }, (_, index) => box(0.09, 0.06, 0.05, -1.26 + index * 0.21, 0.79, 0.5)),
    ...[-1.31, 1.31].map((x) => lathe([[0, 0], [0.03, 0.02], [0.05, 0.07], [0.03, 0.12], [0.045, 0.16], [0.045, 0.2], [0, 0.2]], 8).translate(x, -1.1, 0.44)),
    ...[-1, 1].flatMap((side) => [box(0.07, 0.07, 0.44, side * 1.31, -0.3, 0.22), box(0.07, 0.07, 0.44, side * 1.31, 0.5, 0.22), bracketGeometry(0.5, 0.56, 0.08).translate(side * 1.1, -0.9, 0), bracketGeometry(0.5, 0.56, 0.08).translate(side * 0.3, -0.9, 0)]),
    // Reveal lining of the opening behind the screen.
    box(2.5, 0.05, 0.3, 0, -0.755, -0.1), box(0.05, 1.56, 0.3, -1.225, 0, -0.1), box(0.05, 1.56, 0.3, 1.225, 0, -0.1),
  ]);
  const orielSides = [new THREE.PlaneGeometry(0.44, 1.6).rotateY(Math.PI / 2).translate(1.31, 0, 0.22), new THREE.PlaneGeometry(0.44, 1.6).rotateY(-Math.PI / 2).translate(-1.31, 0, 0.22)];
  for (const sidePanel of orielSides) { const uv = sidePanel.attributes.uv; for (let i = 0; i < uv.count; i += 1) uv.setX(i, uv.getX(i) * 0.17); }
  const orielLattice = merge([new THREE.PlaneGeometry(2.62, 1.6).translate(0, 0, 0.44), ...orielSides]);
  const windowTimber = merge([
    box(1.2, 0.09, 0.14, 0, 0.8, 0.07), softBox(1.36, 0.09, 0.24, 0.02, 1.3).translate(0, -0.8, 0.12), box(0.09, 1.6, 0.12, -0.56, 0, 0.06), box(0.09, 1.6, 0.12, 0.56, 0, 0.06),
    box(1.1, 0.06, 0.6, 0, 0.98, 0.3), bracketGeometry(0.5, 0.36, 0.05).translate(-0.5, 0.95, 0), bracketGeometry(0.5, 0.36, 0.05).translate(0.5, 0.95, 0),
    // Casement set back in the reveal: frame, a mullion and two transoms.
    box(1.04, 0.05, 0.05, 0, 0.735, -0.16), box(1.04, 0.05, 0.05, 0, -0.735, -0.16), box(0.05, 1.52, 0.05, -0.495, 0, -0.16), box(0.05, 1.52, 0.05, 0.495, 0, -0.16),
    box(0.045, 1.52, 0.04, 0, 0, -0.16), box(1.04, 0.035, 0.04, 0, 0.28, -0.16), box(1.04, 0.035, 0.04, 0, -0.24, -0.16),
    box(1.2, 0.05, 0.1, 0, -0.9, 0.05),
  ]);
  const orielSpots: Transform[] = [], orielGlow: Transform[] = [], windowSpots: Transform[] = [], litPanes: Transform[] = [], darkPanes: Transform[] = [], leaves: Transform[] = [], leafColours: THREE.Color[] = [], rails: Transform[] = [];
  const SHUTTERS = [0x2f6f6a, 0x8a3a2a, 0x3c5a80, 0xb9862f, 0x556b3a];
  const draped: Array<{ position: V3; yaw: number; rug: number }> = [], sills: TreeItem[] = [];
  /** The leaves left standing open, a batch of their own: the wall, where the hinge is along it, the hand each hangs on, how far out it stands and how fast it is turning. */
  const loose: Array<{ side: number; z: number; hand: number; open: number; speed: number }> = [], ajar: Transform[] = [], ajarColours: THREE.Color[] = [];
  for (const side of [-1, 1]) upper[String(side)].forEach(([z, kind], index) => {
    const rotation: V3 = [0, faceYaw(side), 0];
    if (kind === "O") {
      orielSpots.push({ position: onWall(side, z, 0, 5.85, 0), rotation });
      orielGlow.push({ position: onWall(side, z, 0, 5.85, -0.62), rotation });
      // A lamp burning inside the bay, and a jar or two on its floor.
      const lamp = W(side, z, 0, 6.3, 0.2);
      emit("glow", new THREE.SphereGeometry(0.075, 10, 8).scale(1, 1.3, 1), lamp, new THREE.Color(1, 0.72, 0.36).multiplyScalar(4.5));
      emit("iron", merge([new THREE.CylinderGeometry(0.02, 0.085, 0.07, 8).translate(0, 0.13, 0), new THREE.CylinderGeometry(0.07, 0.03, 0.05, 8).translate(0, -0.12, 0), rod([0, 0.16, 0], [0, 0.42, 0], 0.006, 4)]), lamp, IRON);
      put("amphora", L(W(side, z, 0.7, 5.05, 0.18), 0, 0, 0, spin(), 0.55), {}, false);
      put("jarCeramic", L(W(side, z, -0.55, 5.05, 0.2), 0, 0, 0, spin(), 0.95), {}, false);
      return;
    }
    for (const s of kind === "W" ? [-1.45, 1.45] : [0]) {
      windowSpots.push({ position: onWall(side, z, s, 5.85, 0), rotation });
      // Two in three have a lamp burning, and always the one over the firing line.
      const lit = (index + (s > 0 ? 1 : 0) + (side > 0 ? 1 : 0)) % 3 !== 0 || z > 6;
      (lit ? litPanes : darkPanes).push({ position: onWall(side, z, s, 5.85, -0.62), rotation });
      for (const hand of [-1, 1]) {
        const swing = (index + hand) % 3 === 0 ? 0.5 : 0.08;
        if (swing > 0.1) loose.push({ side, z: z + side * (s + hand * 0.6), hand, open: swing, speed: 0 });
        (swing > 0.1 ? ajar : leaves).push({ position: onWall(side, z, s + hand * (0.6 + Math.cos(swing) * 0.26), 5.85, 0.06 + Math.sin(swing) * 0.26), rotation: [0, faceYaw(side) - hand * swing, 0] });
        (swing > 0.1 ? ajarColours : leafColours).push(paintOf(SHUTTERS[(index + (side > 0 ? 2 : 0)) % SHUTTERS.length], 2.6));
      }
      // A box of geraniums on the sill where a lamp burns, except where the bougainvillea hangs.
      if (lit && !(side > 0 && z > 0 && z < 5)) sills.push({ at: onWall(side, z, s, 5.095, 0.12), yaw: faceYaw(side), variant: 0, bloom: 0.55 + ((index * 7 + (s > 0 ? 3 : 0)) % 5) * 0.11 });
      // The pots that stood here drew from the layout stream; draw as much, so that everything dressed after this stays where it was set.
      if (high && lit) for (let i = 0; i < 72; i += 1) pick();
    }
    // A pole on two brackets below the sill with a rug thrown over it.
    if (z > 0 && Math.abs(z - 5.35) < 3) return;
    rails.push({ position: onWall(side, z, 0, 4.98, 0.3), rotation });
    draped.push({ position: onWall(side, z, kind === "W" ? (index % 2 ? 0.5 : -0.4) : 0.1, 4.98, 0.3), yaw: faceYaw(side), rug: (index + (side > 0 ? 1 : 0)) % rugs.length });
  });
  instances(orielTimber, darkOak, orielSpots, false);
  instances(orielLattice, screenMaterial, orielSpots, false);
  instances(new THREE.PlaneGeometry(3.3, 2.1), litRoom(track(roomTexture(true, 37))), orielGlow, false, false);
  instances(windowTimber, darkOak, windowSpots, false);
  instances(new THREE.PlaneGeometry(1.7, 2.1), litRoom(track(roomTexture(false, 31))), litPanes, false, false);
  instances(new THREE.PlaneGeometry(1.7, 2.1), shade, darkPanes, false, false);
  const shutterLeaf = shutterGeometry();
  instances(shutterLeaf, paintedWood, leaves, false, true, leafColours);
  // The loose leaves work on their hinges: the draught down the street swings out the ones that
  // face it and presses the others back against the wall, and a gust does both hard. They cast
  // no shadow, the sun map being frozen.
  const shutters = instances(shutterLeaf, paintedWood, ajar, false, false, ajarColours);
  if (shutters) {
    shutters.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const leafAt = new THREE.Vector3(), leafTurn = new THREE.Quaternion(), leafSize = new THREE.Vector3(1, 1, 1), leafMatrix = new THREE.Matrix4();
    let last = -1;
    kit.updates.push((now) => {
      const time = now / 1000, dt = last < 0 ? 0 : Math.min(0.05, time - last);
      last = time;
      for (let i = 0; i < loose.length; i += 1) {
        const leaf = loose[i], target = THREE.MathUtils.clamp(0.5 + leaf.hand * leaf.side * 0.9 * (wind.at(leaf.side * WALL, leaf.z) - 0.2), 0.1, 1.2);
        leaf.speed += (-12 * (leaf.open - target) - 2.1 * leaf.speed) * dt;
        leaf.open += leaf.speed * dt;
        if (leaf.open < 0.08) { leaf.open = 0.08; leaf.speed *= -0.3; }
        leafMatrix.compose(leafAt.set(leaf.side * (WALL - 0.06 - Math.sin(leaf.open) * 0.26), 5.85, leaf.z + leaf.side * leaf.hand * Math.cos(leaf.open) * 0.26), leafTurn.setFromAxisAngle(UP, faceYaw(leaf.side) - leaf.hand * leaf.open), leafSize);
        shutters.setMatrixAt(i, leafMatrix);
      }
      shutters.instanceMatrix.needsUpdate = true;
    });
  }
  instances(merge([rod([-1.5, 0, 0], [1.5, 0, 0], 0.03, 8), rod([-1.3, 0, 0], [-1.3, 0, -0.3], 0.018), rod([1.3, 0, 0], [1.3, 0, -0.3], 0.018)]), darkOak, rails, false);
  draped.forEach(({ position, yaw, rug }, index) => {
    rugParts[rug].push(drapeGeometry(1.25 + (index % 3) * 0.15, 0.85 + (index % 2) * 0.2, index * 1.3).applyMatrix4(M(position[0], position[1], position[2], yaw)));
  });

  // ---- Shuttered shopfronts with their boards -------------------------------
  const shopTimber = merge([
    box(0.16, 3.06, 0.13, -1.72, 1.53, 0.065), box(0.16, 3.06, 0.13, 1.72, 1.53, 0.065), box(3.6, 0.2, 0.15, 0, 3.07, 0.075), box(3.5, 0.74, 0.06, 0, 3.6, 0.03),
    box(3.62, 0.07, 0.2, 0, 4.0, 0.1), box(3.62, 0.05, 0.12, 0, 3.2, 0.06),
  ]);
  const shopIron: THREE.BufferGeometry[] = [];
  for (const x of [-1.2, -0.4, 0.4, 1.2]) for (const y of [0.5, 1.5, 2.5]) shopIron.push(box(0.5, 0.045, 0.012, x, y, 0.078));
  shopIron.push(box(0.2, 0.07, 0.03, 0, 1.25, 0.085), new THREE.TorusGeometry(0.045, 0.01, 5, 12).translate(-0.8, 1.3, 0.09), new THREE.TorusGeometry(0.045, 0.01, 5, 12).translate(0.8, 1.3, 0.09));
  const shops: Array<{ side: number; z: number; paint: number; sign: THREE.Texture }> = [
    { side: -1, z: -5, paint: 0x2f6f6a, sign: track(signTexture("RUSH B SPICES", "no stopping  ·  ground while you run", "#1f4a48", "#f0deb0", "#d9a441", 5)) },
    { side: -1, z: -23, paint: 0xa85a2a, sign: track(signTexture("MIRAGE CARPETS", "palace quality  ·  apartments fitted  ·  ask at the window", "#c79a3e", "#1f2f4f", "#6a1f1c", 9)) },
    { side: 1, z: -5, paint: 0x7a2a26, sign: track(signTexture("MOLLY’S LANTERNS", "“fire in the hole!”  ·  lamp oil $400 the flask", "#6a1f1c", "#f0c462", "#f0deb0", 13)) },
  ];
  const shopSpots = shops.map(({ side, z }) => ({ position: onWall(side, z, 0, 0, 0), rotation: [0, faceYaw(side), 0] as V3 }));
  instances(shopTimber, darkOak, shopSpots, true);
  instances(merge(shopIron), iron, shopSpots, false, false);
  instances(softBox(3.7, 0.14, 0.34, 0.03, 1.2), stone, shops.map(({ side, z }) => ({ position: onWall(side, z, 0, 0.07, 0.17), rotation: [0, faceYaw(side), 0] as V3 })), true);
  /** Panelled leaves, fretwork, carved brackets, ironmongery and tiled panels for one shopfront. */
  const shopDress = (m: THREE.Matrix4, paint: number, shaded: [number, number] | null) => {
    const coat = paintOf(paint), field = paintOf(paint, 4.4), sunk = paintOf(paint, 2.4), trim = paintOf(0xe8d9b0, 1.5);
    for (const s of [-1.2, -0.4, 0.4, 1.2]) {
      for (const x of [-0.345, 0.345]) emit("joinery", box(0.1, 2.9, 0.05, s + x, 1.52, 0.045), m, coat);
      for (const [y, h] of [[0.17, 0.2], [1.1, 0.14], [2.0, 0.14], [2.9, 0.14]]) emit("joinery", box(0.59, h, 0.05, s, y, 0.045), m, coat);
      for (const [from, to] of [[0.27, 1.03], [1.17, 1.93], [2.07, 2.83]]) {
        emit("joinery", box(0.59, to - from, 0.02, s, (from + to) / 2, 0.028), m, sunk);
        emit("joinery", softBox(0.45, to - from - 0.14, 0.024, 0.008, 1.3).translate(s, (from + to) / 2, 0.046), m, field);
      }
      for (const y of [1.1, 2.0]) for (const dx of [-0.22, 0, 0.22]) emit("iron", new THREE.SphereGeometry(0.014, 6, 4).translate(s + dx, y, 0.072), m, IRON);
    }
    emit("joinery", fretGeometry(3.28, 0.24).translate(0, 2.97, 0.085), m, trim);
    for (const x of [-1.74, 1.74]) emit("joinery", bracketGeometry(0.36, 0.52, 0.07).translate(x, 3.96, 0.1), m, 0x8a6c50);
    for (const x of [-1.6, 1.6]) for (const y of [0.5, 1.5, 2.5]) emit("iron", new THREE.CylinderGeometry(0.018, 0.018, 0.13, 8).translate(x, y, 0.085), m, IRON);
    emit("iron", new THREE.TorusGeometry(0.03, 0.008, 5, 10, Math.PI).translate(0, 1.2, 0.112), m, IRON);
    emit("brass", softBox(0.075, 0.085, 0.035, 0.01, 1).translate(0, 1.14, 0.115), m);
    for (const x of [-2.2, 2.2]) {
      // Tiles bedded on the wall inside a frame whose stiles stand between its rails: no two faces share a plane.
      emit("tiles", new THREE.BoxGeometry(0.56, 1.11, 0.028).translate(x, 1.75, 0.02), m);
      for (const y of [1.175, 2.325]) emit("joinery", box(0.66, 0.055, 0.06, x, y, 0.03), m, coat);
      for (const dx of [-0.3025, 0.3025]) emit("joinery", box(0.055, 1.095, 0.06, x + dx, 1.75, 0.03), m, coat);
    }
    if (shaded) awning(L(m, 0, 3.0, 0.17), 3.3, shaded[0], shaded[1]);
    if (!high) return;
    driedString(L(m, -1.95, 3.42, 0.34), 0, 0.85); driedString(L(m, 1.95, 3.42, 0.34), 1, 0.8);
  };
  shops.forEach(({ side, z, paint }, index) => shopDress(W(side, z), paint, index === 1 ? null : index === 0 ? [0xe8dcc0, 0x2f6f6a] : [0xd9952b, 0x7a2a26]));
  const fascias: Array<{ side: number; z: number; width: number; y: number; sign: THREE.Texture }> = [
    ...shops.map(({ side, z, sign }) => ({ side, z, width: 3.36, y: 3.6, sign })),
    { side: -1, z: 5.35, width: 3.2, y: 4.06, sign: track(signTexture("TRADE-UP RUGS", "ten rugs in  ·  one better rug out  ·  all contracts final", "#22344f", "#f0deb0", "#d9a441", 21)) },
    { side: 1, z: 5.35, width: 3.2, y: 4.06, sign: track(signTexture("SAVE ROUND DISCOUNTS", "keep your copper  ·  loss bonus honoured  ·  buy next round", "#b8742a", "#3a1410", "#f4e6c0", 27)) },
  ];
  fascias.forEach(({ side, z, width, y, sign }) => {
    sign.anisotropy = anisotropy;
    const face = place(new THREE.Mesh(new THREE.PlaneGeometry(width, width * 192 / 1024), new THREE.MeshStandardMaterial({ map: sign, roughness: 0.7, metalness: 0, envMapIntensity: 0.5 })), ...onWall(side, z, 0, y, y > 4 ? 0.035 : 0.065), false);
    face.rotation.y = faceYaw(side);
  });
  // The two long boards over the arcades get a plain timber back.
  instances(softBox(3.34, 0.72, 0.05, 0.015, 1.3), darkOak, [-1, 1].map((side) => ({ position: onWall(side, 5.35, 0, 4.06, 0.005), rotation: [0, faceYaw(side), 0] as V3 })), false, false);
  const boardPaint = (map: THREE.Texture) => new THREE.MeshStandardMaterial({ map, roughness: 0.75, metalness: 0, envMapIntensity: 0.5 });
  // Each stall's name on a painted board spiked to the wall over its stand, below the range's own signs.
  const stallBoards: Array<[number, number, number, THREE.Texture]> = [
    [-1, -15.95, 1.9, signTexture("BANANA & SONS", "holding banana since 1999  ·  first pick at 1:55", "#d9a441", "#3a2410", "#6a1f1c", 31)],
    [-1, -18.65, 1.5, signTexture("DROP ME A MELON", "no AWPs dropped here  ·  melons, yes", "#2f6f4a", "#f0deb0", "#e0a23a", 37)],
    [1, -15.75, 1.5, signTexture("GG WP GREENGROCERS", "good greens  ·  well priced  ·  glhf", "#7a2a26", "#f0deb0", "#d9a441", 41)],
    [1, -18.5, 1.5, signTexture("PEEKER’S ADVANTAGE", "first round the corner gets the ripe ones", "#3c5a80", "#f4e6c0", "#e0a23a", 43)],
  ];
  for (const [side, z, width, sign] of stallBoards) {
    const height = width * 192 / 1024, m = W(side, z);
    track(sign).anisotropy = anisotropy;
    place(new THREE.Mesh(boardGeometry(width, height, 0.036).translate(0, 1.61, 0.02).applyMatrix4(m), boardPaint(sign)), 0, 0, 0, false);
    for (const x of [-1, 1]) emit("iron", box(0.036, 0.075, 0.012, x * (width / 2 - 0.22), 1.61 + height / 2 + 0.022, 0.04, 1), m, IRON);
  }
  /** A board hung by two links from an iron arm on a post, lettered on both faces so it reads up and down the hall. */
  /** The boards that swing: each with how it hangs at rest and a way to shove it. */
  const signs: Array<{ board: THREE.Mesh; rest: THREE.Quaternion; kick: (strength: number, x?: number, z?: number) => void }> = [];
  const swing = (side: number, z: number, sign: THREE.Texture) => {
    const m = W(side, z);
    track(sign).anisotropy = anisotropy;
    emit("iron", rod([0, 3.05, 0.33], [0, 3.05, 1.42], 0.012, 6), m, IRON);
    emit("iron", rod([0, 3.38, 0.33], [0, 3.05, 1.04], 0.008, 5), m, IRON);
    emit("iron", box(0.05, 0.48, 0.012, 0, 3.2, 0.336, 1), m, IRON);
    emit("iron", new THREE.SphereGeometry(0.022, 8, 6).translate(0, 3.05, 1.42), m, IRON);
    for (const out of [0.62, 1.2]) emit("iron", rod([0, 3.05, out], [0, 2.975, out], 0.005, 4), m, IRON);
    // The board turns on the arm: its origin is the hinge line, it casts no shadow (the sun map is
    // frozen) and a gust, or a bullet, sets it swinging along the hall.
    const board = new THREE.Mesh(boardGeometry(0.96, 0.66, 0.03).rotateY(Math.PI / 2).translate(0, -0.405, 0), boardPaint(sign));
    place(board, 0, 0, 0, false, true);
    L(m, 0, 3.05, 0.91).decompose(board.position, board.quaternion, board.scale);
    signs.push({ board, rest: board.quaternion.clone(), kick: life.sway(board, { axis: "z", amplitude: 0.2, period: 1.5 }).kick });
    return [board.position.x, 3.062, z] as V3;
  };
  const knifeArm = swing(1, -8, swingTexture(["KNIFE", "GRINDER"], ["karambit  ·  butterfly  ·  bayonet", "sharpened while you wait", "shadow daggers free with purchase"], "#2a2622", "#e8dcc0", "#e6b25a", 51, (c) => {
    c.fillStyle = "#8f8a80"; c.beginPath(); c.arc(-120, 4, 94, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "#5c574e"; c.lineWidth = 6; c.beginPath(); c.arc(-120, 4, 64, 0, Math.PI * 2); c.stroke();
    c.fillStyle = "#3a2c1c"; c.beginPath(); c.arc(-120, 4, 17, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#e8e4d8"; c.beginPath(); c.moveTo(150, -46); c.quadraticCurveTo(50, -104, -28, -14); c.quadraticCurveTo(66, -52, 150, -10); c.closePath(); c.fill();
    c.fillStyle = "#b8742a"; c.fillRect(148, -50, 70, 44);
    c.strokeStyle = "#b8742a"; c.lineWidth = 9; c.beginPath(); c.arc(236, -28, 15, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "#f0c462"; c.lineWidth = 4;
    for (let i = 0; i < 7; i += 1) { const a = 0.2 + i * 0.21, r = 34 + (i * 37 % 44); c.beginPath(); c.moveTo(-26 + Math.cos(a) * 12, -10 + Math.sin(a) * 12); c.lineTo(-26 + Math.cos(a) * r, -10 + Math.sin(a) * r); c.stroke(); }
  }));
  const dyeArm = swing(-1, -2, swingTexture(["BLUE GEM", "DYE WORKS"], ["pattern 661  ·  indigo only", "one vat in a thousand comes out like this"], "#e9dcc0", "#1f3f7a", "#27508a", 53, (c) => {
    c.fillStyle = "#2d5fb8"; c.beginPath(); c.moveTo(-72, -92); c.lineTo(72, -92); c.lineTo(128, -38); c.lineTo(0, 100); c.lineTo(-128, -38); c.closePath(); c.fill();
    c.fillStyle = "#6fa6f0"; c.beginPath(); c.moveTo(-72, -92); c.lineTo(-30, -38); c.lineTo(-128, -38); c.closePath(); c.fill();
    c.fillStyle = "#bfe0ff"; c.beginPath(); c.moveTo(-30, -38); c.lineTo(36, -38); c.lineTo(0, -92); c.closePath(); c.fill();
    c.fillStyle = "#1f3f7a"; c.beginPath(); c.moveTo(36, -38); c.lineTo(128, -38); c.lineTo(0, 100); c.closePath(); c.fill();
    c.strokeStyle = "#e9f3ff"; c.lineWidth = 4;
    c.beginPath(); c.moveTo(-128, -38); c.lineTo(128, -38); c.moveTo(-30, -38); c.lineTo(0, 100); c.lineTo(36, -38); c.moveTo(72, -92); c.lineTo(36, -38); c.stroke();
    c.beginPath(); c.moveTo(-72, -92); c.lineTo(72, -92); c.lineTo(128, -38); c.lineTo(0, 100); c.lineTo(-128, -38); c.closePath(); c.stroke();
    c.strokeStyle = "#d9a441"; c.lineWidth = 6;
    for (const [x, y, r] of [[176, -78, 26], [-190, 20, 18]]) { c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke(); }
  }));
  swing(-1, -20, swingTexture(["FLYING", "CARPETS"], ["noclip models in stock", "sv_cheats 1 required"], "#6a1f1c", "#f0c462", "#f0deb0", 57, (c) => {
    const edge = (lift: number) => { for (let x = -180; x <= 180; x += 12) c.lineTo(x + lift * 0.5, -22 + Math.sin(x / 46) * 20 + lift); };
    c.fillStyle = "#1f6f6a"; c.beginPath(); c.moveTo(-180, -22 + Math.sin(-180 / 46) * 20); edge(0);
    for (let x = 180; x >= -180; x -= 12) c.lineTo(x + 28, 34 + Math.sin(x / 46) * 20);
    c.closePath(); c.fill();
    c.strokeStyle = "#f0c462"; c.lineWidth = 6; c.beginPath(); c.moveTo(-170, -8 + Math.sin(-170 / 46) * 20);
    for (let x = -170; x <= 174; x += 12) c.lineTo(x + 8, -8 + Math.sin(x / 46) * 20);
    c.stroke();
    c.beginPath(); c.moveTo(-158, 22 + Math.sin(-158 / 46) * 20);
    for (let x = -158; x <= 186; x += 12) c.lineTo(x + 20, 22 + Math.sin(x / 46) * 20);
    c.stroke();
    c.lineWidth = 4;
    for (let i = 0; i < 6; i += 1) { const t = i / 5; for (const x of [-180, 180]) { const bx = x + t * 28, by = -22 + Math.sin(x / 46) * 20 + t * 56; c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + Math.sign(x) * 26, by + 8); c.stroke(); } }
    c.strokeStyle = "#f0deb0"; c.lineWidth = 5;
    for (const [x, y, w] of [[-330, -40, 90], [-350, 6, 110], [-316, 50, 70]]) { c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y); c.stroke(); }
  }));
  const teaArm = swing(1, -2, swingTexture(["THE SILVER", "SAMOVAR"], ["tea by the glass", "silver forever"], "#1f4a48", "#e6e2d6", "#c9c4b4", 59, (c) => {
    c.fillStyle = "#cfcac0"; c.strokeStyle = "#5e5b54"; c.lineWidth = 5;
    c.beginPath(); c.moveTo(-44, 78); c.bezierCurveTo(-92, 30, -84, -34, -40, -52); c.lineTo(40, -52); c.bezierCurveTo(84, -34, 92, 30, 44, 78); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.rect(-58, 78, 116, 20); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(-34, -52); c.quadraticCurveTo(0, -92, 34, -52); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.arc(0, -84, 11, 0, Math.PI * 2); c.fill(); c.stroke();
    c.beginPath(); c.rect(78, 26, 44, 13); c.fill(); c.stroke();
    c.lineWidth = 8; for (const x of [-1, 1]) { c.beginPath(); c.arc(x * 92, -6, 22, x > 0 ? -1.5 : Math.PI - 1.2, x > 0 ? 1.2 : Math.PI + 1.5); c.stroke(); }
    c.strokeStyle = "#f4f1e6"; c.lineWidth = 6; c.beginPath(); c.moveTo(-50, 20); c.quadraticCurveTo(-56, -14, -28, -34); c.stroke();
    c.strokeStyle = "#e6e2d6"; c.lineWidth = 5;
    for (const x of [-150, 150]) { c.beginPath(); c.moveTo(x, 60); c.bezierCurveTo(x - 30, 20, x + 30, -10, x, -50); c.stroke(); }
  }));

  // ---- Lanterns and strung bulbs --------------------------------------------
  const [lanternMetal, lanternGlass] = lanternGeometry();
  const lamps: Array<{ position: V3; scale: number; colour: THREE.Color; hangFrom?: number; chain?: number }> = [];
  for (const z of [-2, -8, -14, -20]) lamps.push({ position: [0, 4.95, z], scale: 2.3, colour: AMBER, hangFrom: 7.1, chain: 2.1 });
  [-23, -17, -11, -5, 1, 7].forEach((z, index) => {
    lamps.push({ position: [-4.8, 5.5 - (index % 2) * 0.3, z], scale: 1.25, colour: [HONEY, TEAL, AMBER][index % 3], hangFrom: 7.1, chain: 1.5 });
    lamps.push({ position: [4.8, 5.3 + (index % 2) * 0.3, z], scale: 1.25, colour: [RUBY, AMBER, HONEY][index % 3], hangFrom: 7.1, chain: 1.5 });
  });
  // One on a wrought bracket at every post and on each arcade pier; each throws a pool of light on the wall behind it.
  const brackets: Transform[] = [], pools: THREE.BufferGeometry[] = [];
  const bracketLamp = (side: number, x: number, y: number, z: number, colour: THREE.Color) => {
    brackets.push({ position: [side * x, y, z], rotation: [0, faceYaw(side), 0] });
    lamps.push({ position: [side * (x - 0.3), y - 0.405, z], scale: 0.9, colour });
    pools.push(new THREE.PlaneGeometry(3, 3).rotateY(faceYaw(side)).translate(side * (WALL - 0.012), y - 0.5, z));
  };
  for (const { side, z } of postSpots) if (z < 9) bracketLamp(side, 9.21, 4.2, z, AMBER);
  for (const side of [-1, 1]) bracketLamp(side, WALL, 3.34, 5.35, HONEY);
  instances(bracketIronGeometry(), iron, brackets, false, false);
  const poolMap = track(softDiscTexture());
  const poolLight = new THREE.Mesh(merge(pools), new THREE.MeshBasicMaterial({ map: poolMap, color: new THREE.Color(1, 0.5, 0.2).multiplyScalar(0.42), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  poolLight.renderOrder = 2;
  scene.add(poolLight);
  kit.mirrorHidden.push(poolLight);

  // The two stalls in the arcades are hung with lamps for sale.
  const stallLamps = rng(77);
  for (let i = 0; i < 22; i += 1) {
    const z = i % 2 ? 1.7 + stallLamps() * 2.5 : 6.5 + stallLamps() * 2.5;
    lamps.push({ position: [10.75 + stallLamps() * 2.3, 2.35 + stallLamps() * 1.3, z], scale: 0.7 + stallLamps() * 0.5, colour: [AMBER, HONEY, RUBY, TEAL, GREEN, AMBER, HONEY][i % 7], hangFrom: 4.3 });
  }
  for (const z of [2.95, 7.75]) lamps.push({ position: [-11.2, 3.25, z], scale: 1.3, colour: HONEY, hangFrom: 4.3 });
  const lampSpots = lamps.map(({ position, scale }, index) => ({ position, rotation: [0, index * 0.7, 0] as V3, scale: [scale, scale, scale] as V3 }));
  const lampMetal = instances(lanternMetal, agedBrass, lampSpots, false, false);
  const glassMap = track(lanternGlassTexture());
  glassMap.repeat.set(6, 1);
  glassMap.anisotropy = anisotropy;
  const glassMesh = instances(lanternGlass, new THREE.MeshBasicMaterial({ map: glassMap, color: new THREE.Color(1.9, 1.9, 1.9), toneMapped: false }), lampSpots, false, false);
  // Every one of them hangs and swings: the hall's from a staple in the tie beam, the ones for sale
  // from the stall's joists, the rest from the hook of their bracket.
  const hooks = lamps.map(({ position, scale, hangFrom, chain }, index) => {
    const top = hangFrom ?? position[1] + 0.41 * scale, drop = top - position[1];
    const hanger = hang([position[0], top, position[2]], Math.max(0.45, drop), chain ? (scale > 2 ? 0.11 : 0.15) : hangFrom ? 0.14 : 0.1);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(0, -drop, 0), new THREE.Quaternion().setFromAxisAngle(UP, index * 0.7), new THREE.Vector3(scale, scale, scale));
    ride(hanger, lampMetal, index, local); ride(hanger, glassMesh, index, local);
    return hanger;
  });
  // A bullet sets a lantern or a sign swinging away from whoever fired it. One that is already well
  // over is left to swing and one knock is heard at a time, or automatic fire would wind it right round.
  for (const mesh of [lampMetal, glassMesh]) if (mesh) kit.shootable.push(mesh);
  const shooter = new THREE.Vector3(0, 1.62, 7.2), along = new THREE.Vector3();
  let knockedAt = -9;
  const knock = (cue: CueName, point: THREE.Vector3, pitch: number) => {
    if (clock - knockedAt < 0.3) return;
    knockedAt = clock;
    say(cue, point.x, point.y, point.z, 0.8, pitch);
  };
  const lanternStruck = (object: THREE.Object3D, point: THREE.Vector3) => {
    if (object !== lampMetal && object !== glassMesh) return false;
    let nearest = 0, best = Infinity;
    for (let i = 0; i < lamps.length; i += 1) {
      const [x, y, z] = lamps[i].position, apart = (x - point.x) ** 2 + (y - point.y) ** 2 + (z - point.z) ** 2;
      if (apart < best) { best = apart; nearest = i; }
    }
    if (2 * Math.acos(Math.min(1, Math.abs(hooks[nearest].pivot.quaternion.w))) < 0.25) hooks[nearest].kick(1.1, point.x - shooter.x, point.z - shooter.z);
    knock("chainRattle", point, 1.05 + (nearest % 5) * 0.06);
    return true;
  };
  const signStruck = (object: THREE.Object3D, point: THREE.Vector3) => {
    for (let i = 0; i < signs.length; i += 1) {
      const { board, rest, kick } = signs[i];
      if (board !== object) continue;
      // Only round its hinge: along the board's own swing, to whichever side is away from the gun.
      along.set(1, 0, 0).applyQuaternion(rest);
      const away = (point.x - shooter.x) * along.x + (point.z - shooter.z) * along.z < 0 ? -1 : 1;
      if (rest.angleTo(board.quaternion) < 0.25) kick(1.8 * away, along.x, along.z);
      knock("signCreak", point, 1.1 + i * 0.05);
      return true;
    }
    return false;
  };
  // Flames: a handful of independent flickers dealt round the lanterns, so no two neighbours burn
  // alike. The small lamps for sale gutter like candles; the hall's burn steadier behind their glass.
  const flames = Array.from({ length: 6 }, (_, index) => life.flicker(() => {}, index < 4 ? "lantern" : "candle", { cue: false, rate: 0.8 + index * 0.11 }));
  if (glassMesh) {
    lamps.forEach(({ colour }, index) => glassMesh.setColorAt(index, colour));
    const glow = glassMesh.instanceColor!, steady = Float32Array.from(glow.array);
    glow.setUsage(THREE.DynamicDrawUsage);
    const flameOf = lamps.map(({ hangFrom, chain }, index) => (hangFrom && !chain ? 4 + index % 2 : index % 4));
    kit.updates.push(() => {
      for (let i = 0; i < flameOf.length; i += 1) {
        const level = flames[flameOf[i]].level();
        glow.array[i * 3] = steady[i * 3] * level; glow.array[i * 3 + 1] = steady[i * 3 + 1] * level; glow.array[i * 3 + 2] = steady[i * 3 + 2] * level;
      }
      glow.needsUpdate = true;
    });
  }
  // Hall lanterns hang on chains; the ones for sale hang on plain wire. Both ride the lantern's hook.
  const hung = lamps.map((lamp, index) => ({ ...lamp, index })).filter(({ hangFrom }) => hangFrom);
  const wired = hung.filter(({ chain }) => !(chain && high)), chained = hung.filter(({ chain }) => chain && high);
  const lampWires = instances(new THREE.CylinderGeometry(0.006, 0.006, 1, 5).translate(0, -0.5, 0), iron, wired.map(({ position, scale, hangFrom }) => ({ position: [position[0], hangFrom!, position[2]] as V3, scale: [1, hangFrom! - position[1] - 0.41 * scale, 1] as V3 })), false, false);
  wired.forEach(({ position, scale, hangFrom, index }, slot) => ride(hooks[index], lampWires, slot, new THREE.Matrix4().makeScale(1, hangFrom! - position[1] - 0.41 * scale, 1)));
  // One metre of chain hanging from its top link, drawn out to each lantern's length.
  const metre = merge(Array.from({ length: 20 }, (_, link) => new THREE.TorusGeometry(0.014, 0.0036, 3, 6).scale(1, 1.5, 1).rotateY(link % 2 ? Math.PI / 2 : 0).translate(0, -(link + 0.5) / 20, 0)));
  const drawn = chained.map(({ position, scale, hangFrom, chain }) => [chain! / 1.5, hangFrom! - 0.035 - position[1] - 0.4 * scale, chain! / 1.5] as V3);
  const chains = instances(metre, agedBrass, chained.map(({ position, hangFrom }, slot) => ({ position: [position[0], hangFrom! - 0.035, position[2]] as V3, scale: drawn[slot] })), false, false);
  chained.forEach(({ position, hangFrom, index }, slot) => {
    ride(hooks[index], chains, slot, new THREE.Matrix4().compose(new THREE.Vector3(0, -0.035, 0), new THREE.Quaternion(), new THREE.Vector3(...drawn[slot])));
    emit("iron", new THREE.BoxGeometry(0.09, 0.012, 0.09).translate(position[0], hangFrom! - 0.006, position[2]), HERE, IRON);
    emit("iron", new THREE.TorusGeometry(0.02, 0.006, 4, 8, Math.PI).rotateZ(Math.PI).translate(position[0], hangFrom! - 0.012, position[2]), HERE, IRON);
  });

  // Bulbs strung across the hall from post to post.
  const bulbs: Transform[] = [], wires: THREE.BufferGeometry[] = [];
  for (const start of [-1, 1]) for (let run = 0; run < 4; run += 1) {
    const from = start * (run % 2 ? -1 : 1), a = new THREE.Vector3(from * 9.2, 5.5, -2 - run * 6), b = new THREE.Vector3(-from * 9.2, 5.5, -8 - run * 6);
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 26; i += 1) {
      const u = i / 26, point = a.clone().lerp(b, u);
      point.y -= 0.8 * 4 * u * (1 - u);
      points.push(point);
      if (i > 0 && i < 26) bulbs.push({ position: [point.x, point.y - 0.07, point.z] });
    }
    wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 52, 0.008, 4, false));
  }
  const wire = new THREE.Mesh(merge(wires), new THREE.MeshStandardMaterial({ color: 0x15110d, roughness: 0.7, metalness: 0 }));
  scene.add(wire);
  instances(new THREE.SphereGeometry(0.034, 6, 4), bulb, bulbs, false, false);
  instances(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 6), iron, bulbs.map(({ position }) => ({ position: [position[0], position[1] + 0.045, position[2]] as V3 })), false, false);

  // ---- The arcade stalls ----------------------------------------------------
  const SHELF_TOPS = [0.6425, 1.3425, 2.0425, 2.7425], STALL_FLOOR = 0.16;
  /** World z of the shelving uprights: nothing is set down where one stands. */
  const UPRIGHTS = [0.55, 2.95, 5.35, 7.75, 10.15];
  const clearOfUprights = (z: number, room: number) => UPRIGHTS.every((upright) => Math.abs(z - upright) > room);
  const joists: Transform[] = [];
  for (const side of [-1, 1]) {
    place(new THREE.Mesh(worldBox(0.6, STOREY, 10.7, 3), umber), side * 14.2, STOREY / 2, 5.35, true);
    for (const z of [0.15, 10.55]) place(new THREE.Mesh(worldBox(3.6, STOREY, 0.3, 3), umber), side * 12.1, STOREY / 2, z, true);
    place(new THREE.Mesh(worldBox(4.4, 0.2, 10.7, 1.6), boards), side * 12.3, STOREY - 0.1, 5.35, true);
    place(new THREE.Mesh(softBox(3.5, STALL_FLOOR, 10.0, 0.03, 1.6), tiled), side * 12.14, STALL_FLOOR / 2, 5.35, true);
    for (let z = 0.9; z < 10; z += 1.1) joists.push({ position: [side * 12.1, STOREY - 0.28, z] });
    // Shelving along the back wall: uprights front and back, four lipped boards on bearers, a cornice and raking braces.
    const m = M(side * 13.9, STALL_FLOOR, 5.35, -side * Math.PI / 2);
    for (const top of SHELF_TOPS) {
      const y = top - STALL_FLOOR;
      emit("joinery", stick(9.76, 0.04, 0.56, 0, y - 0.02, 0.325, 0), m, timberTone());
      emit("joinery", stick(9.76, 0.07, 0.024, 0, y - 0.03, 0.612), m, 0xc8b8a0);
    }
    for (const x of [-4.8, -2.4, 0, 2.4, 4.8]) {
      emit("joinery", stick(0.07, 3.2, 0.07, x, 1.6, 0.6, 0.008), m, 0xb8a890);
      emit("joinery", stick(0.06, 3.2, 0.04, x, 1.6, 0.03, 0), m, 0xb8a890);
      for (const top of SHELF_TOPS) {
        emit("joinery", stick(0.04, 0.06, 0.54, x + 0.055, top - STALL_FLOOR - 0.07, 0.31, 0), m);
        peg(m, x + 0.02, top - STALL_FLOOR - 0.07, 0.6, 0.11, true);
      }
    }
    emit("joinery", stick(9.9, 0.15, 0.03, 0, 3.26, 0.63), m, 0xa89078);
    emit("joinery", stick(9.96, 0.035, 0.09, 0, 3.35, 0.61), m, 0xb8a890);
    for (const [x, lean] of [[-3.6, 1], [3.6, -1]]) emit("joinery", stick(0.05, 2.5, 0.022, 0, 0, 0, 0).rotateZ(lean * 1.0).translate(x, 1.6, 0.028), m, 0xa89078);
  }
  instances(worldBox(3.5, 0.16, 0.12, 1.3), darkOak, joists, false, false);

  // Prop lists filled by every stall and wall display, instanced once at the end.
  const bolts: Transform[] = [], boltColours: number[] = [], folded: Transform[] = [], foldedColours: number[] = [], rolls: Transform[] = [], rollColours: number[] = [];
  const pots: Transform[] = [], ewers: Transform[] = [], bowls: Transform[] = [], trays: Transform[] = [], brassOf: number[][] = [[], [], [], []];
  const turn = () => random() * Math.PI * 2;
  const TURMERIC = 0xd69a1c, PAPRIKA = 0xa8321a, CUMIN = 0x8a6a36, SUMAC = 0x6b1f2a;
  /** Where the open sacks stand, for the scoops left in them: x, y, z, scale. */
  const openSacks: Array<[number, number, number, number]> = [];
  /** An open sack of dry goods: `variant` picks what it holds (0 rice, 1 lentils, 2 coffee, 4 chickpeas, 5 chillies, 6 beans, 7 almonds; 3 is ground spice, coloured by `powder`). */
  const openSack = (x: number, y: number, z: number, scale: number, variant: number, powder?: number) => {
    put("sackOpen", M(x, y, z, spin(), scale), powder === undefined ? { variant } : { variant, tint2: powder });
    openSacks.push([x, y, z, scale]);
  };
  /** A frame turned about the vertical and then leant over: `leanX` tips its top toward +z, `leanZ` toward -x. */
  const leant = (x: number, y: number, z: number, yaw: number, leanX: number, leanZ = 0, s = 1) =>
    new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(leanX, yaw, leanZ, "ZXY"))).scale(new THREE.Vector3(s, s, s));
  const rugPile = (x: number, z: number, layers: number, yaw: number, base = 0, long = 1, wide = 1) => {
    for (let i = 0; i < layers; i += 1) {
      folded.push({ position: [x + (random() - 0.5) * 0.06, base + 0.04 + i * 0.075, z + (random() - 0.5) * 0.06], rotation: [0, yaw + (random() - 0.5) * 0.16, 0], scale: [long * (1 - random() * 0.08), 1, wide * (1 - random() * 0.1)] });
      foldedColours.push(RUG_DYES[Math.floor(random() * RUG_DYES.length)]);
    }
  };
  /**
   * A rolled rug standing on `base` with its top rim resting on a wall: `wall` is the world x or z of
   * the wall's face, `along` where it stands along the wall and `sign` the side of the face it stands on.
   */
  const roll = (along: number, wall: number, lean: number, toward: "x" | "z", sign: number, base = 0) => {
    const length = 1.7 + random() * 0.5, radius = 0.13, reach = Math.sin(lean) * length;
    const middle = wall + sign * (reach / 2 + Math.cos(lean) * radius + 0.03), y = base + Math.cos(lean) * length / 2 + Math.sin(lean) * radius;
    rolls.push({ position: toward === "x" ? [middle, y, along] : [along, y, middle], rotation: toward === "x" ? [0, 0, sign * lean] : [-sign * lean, 0, 0], scale: [1, length / 2, 1] });
    rollColours.push(RUG_DYES[Math.floor(random() * RUG_DYES.length)]);
  };
  const metalware = (list: Transform[], kind: number, x: number, y: number, z: number, scale: number) => {
    list.push({ position: [x, y, z], rotation: [0, turn(), 0], scale: [scale, scale, scale] });
    brassOf[kind].push(random() < 0.45 ? 0xffb38a : 0xffffff);
  };

  // Left arcade: cloth and carpets.
  for (const top of SHELF_TOPS) for (let z = 0.75; z < 10; z += 0.2 + random() * 0.04) {
    if (!clearOfUprights(z, 0.13) || !clearOfUprights(z + 0.09, 0.13) || random() < 0.07) continue;
    const layers = 1 + Math.floor(random() * 3);
    for (let layer = 0; layer < layers; layer += 1) {
      bolts.push({ position: [-13.5 + random() * 0.12, top + 0.0775 + layer * 0.135, z + (layer % 2) * 0.09], rotation: [0, (random() - 0.5) * 0.1, Math.PI / 2], scale: [0.75, 1, 1] });
      boltColours.push(CLOTH_DYES[Math.floor(random() * CLOTH_DYES.length)]);
    }
  }
  rugPile(-11.9, 2.6, 11, 0.1, STALL_FLOOR); rugPile(-11.6, 7.5, 8, -0.2, STALL_FLOOR); rugPile(-12.6, 8.6, 5, 1.5, STALL_FLOOR); rugPile(-12.7, 4.4, 6, 1.6, STALL_FLOOR);
  // On each end wall: rolled rugs leaning in the corner and one of the best thrown over a pole to show its pattern.
  for (const [wall, sign, rug] of [[0.3, 1, 2], [10.4, -1, 1]]) {
    for (const x of [-11.2, -11.55, -11.88]) roll(x, wall, 0.12 + random() * 0.08, "z", sign, STALL_FLOOR);
    const pole = M(-12.68, 3.5, wall + sign * 0.062, sign > 0 ? 0 : Math.PI);
    rugParts[rug].push(drapeGeometry(1.26, 2.5, rug * 2.7, 0.022).applyMatrix4(pole));
    emit("joinery", rod([-0.74, 0, 0], [0.74, 0, 0], 0.022, 8), pole, 0xc8b8a0);
    for (const x of [-0.7, 0.7]) {
      emit("iron", new THREE.BoxGeometry(0.014, 0.014, 0.1).translate(x, -0.03, -0.012), pole, IRON);
      emit("iron", new THREE.BoxGeometry(0.014, 0.05, 0.014).translate(x, -0.012, 0.036), pole, IRON);
      emit("iron", new THREE.BoxGeometry(0.05, 0.09, 0.006).translate(x, -0.03, -0.059), pole, IRON);
    }
  }
  // A cutting table inside each arch with folded lengths on it.
  for (const z of [2.95, 7.75]) {
    bench(M(-10.95, STALL_FLOOR, z, Math.PI / 2), 2.3, 0.8, 1.015 - STALL_FLOOR, { drawers: 3, face: 1, shelf: true });
    for (let i = 0; i < 9; i += 1) {
      folded.push({ position: [-10.95 + (random() - 0.5) * 0.1, 1.056 + (i % 3) * 0.075, z - 0.75 + Math.floor(i / 3) * 0.75], rotation: [0, Math.PI / 2 + (random() - 0.5) * 0.2, 0], scale: [0.42, 1, 0.6] });
      foldedColours.push(CLOTH_DYES[Math.floor(random() * CLOTH_DYES.length)]);
    }
  }

  // Right arcade: copper, brass, lamps and spice.
  for (const top of SHELF_TOPS) for (let z = 0.85; z < 9.9; z += 0.5 + random() * 0.25) {
    if (!clearOfUprights(z, 0.3)) continue;
    const kind = random(), y = top + 0.0025;
    if (kind < 0.3) metalware(pots, 0, 13.56, y, z, 0.62 + random() * 0.25);
    else if (kind < 0.55) metalware(ewers, 1, 13.56, y, z, 0.7 + random() * 0.25);
    else if (kind < 0.75) metalware(bowls, 2, 13.56, y, z, 0.75 + random() * 0.3);
    else { const scale = 0.7 + random() * 0.25; trays.push({ position: [13.78, y + 0.33 * scale, z], rotation: [0.16, -Math.PI / 2, 0], scale: [scale, scale, scale] }); brassOf[3].push(random() < 0.4 ? 0xffb38a : 0xffffff); }
  }
  for (const z of [2.95, 7.75]) bench(M(11.95, STALL_FLOOR, z, Math.PI / 2), 2.3, 0.9, 0.975 - STALL_FLOOR, { drawers: 3, face: -1, shelf: true });
  // Copper on the first table.
  for (let i = 0; i < 5; i += 1) {
    const z = 2.0 + i * 0.32, x = 11.95 + (random() - 0.5) * 0.4;
    if (i % 3 === 0) metalware(pots, 0, x, 0.976, z, 0.5 + random() * 0.2);
    else if (i % 3 === 1) metalware(ewers, 1, x, 0.976, z, 0.6 + random() * 0.25);
    else metalware(bowls, 2, x, 0.976, z, 0.6 + random() * 0.3);
  }
  // Oil, vinegar and preserves on the second: bottles along the back, jars two deep with two more
  // standing on their lids, spice tins in stacks, sauces in a huddle and pickling crocks at the near end.
  const TABLE = 0.976, facing = () => -Math.PI / 2 + (pick() - 0.5) * 0.9;
  [6.74, 6.86, 6.97, 7.1, 7.21].forEach((z, index) => put("bottleWine", M(12.25 - (index % 2) * 0.04, TABLE, z, facing()), { variant: index % 3, tint2: 0xc9a02e }));
  [7.36, 7.49, 7.63].forEach((z) => put("bottleSpirits", M(12.25, TABLE, z, facing())));
  [6.76, 6.88, 7.0, 7.12].forEach((z, index) => put("jar", M(12.07, TABLE, z, facing()), { variant: index }));
  [6.82, 6.94, 7.06].forEach((z, index) => put("jar", M(11.94, TABLE, z, facing()), { variant: index + 1 }));
  [6.82, 7.06].forEach((z, index) => put("jar", M(12.07, TABLE + 0.14, z, facing()), { variant: index * 2 + 1 }));
  for (const [x, z, tall] of [[12.0, 7.3, 3], [12.02, 7.41, 2], [11.9, 7.36, 1], [11.87, 7.48, 1], [12.04, 7.53, 1]]) for (let i = 0; i < tall; i += 1) put("tin", M(x + (pick() - 0.5) * 0.008, TABLE + i * 0.095, z, facing()));
  for (const [x, z] of [[11.72, 6.8], [11.78, 6.87], [11.71, 6.94], [11.79, 7.01], [11.73, 7.08], [11.8, 7.15], [11.72, 7.22]]) put("bottleSauce", M(x, TABLE, z, facing()));
  put("crock", M(11.72, TABLE, 7.56, 0.3, 0.8)); put("crock", M(11.76, TABLE, 7.88, -0.4, 0.9)); put("jarCeramic", M(12.02, TABLE, 7.84, 0, 0.75));
  // Spice and dry goods stepped down to the arches: open sacks in front, full ones tied, stacked and slumped behind.
  for (const [z, scale, variant, powder] of [[1.78, 1, 3, TURMERIC], [2.38, 1.04, 3, PAPRIKA], [2.98, 1, 5], [3.58, 1, 3, CUMIN], [4.18, 0.96, 0], [6.62, 1, 6], [7.22, 1.03, 3, TURMERIC], [7.82, 1, 1], [9.0, 0.95, 4]]) openSack(10.73, STALL_FLOOR, z, scale, variant, powder);
  openSack(11.19, STALL_FLOOR, 3.3, 1.05, 7); openSack(11.19, STALL_FLOOR, 3.92, 1, 2); openSack(11.19, STALL_FLOOR, 8.14, 1, 3, PAPRIKA);
  put("sack", M(11.21, STALL_FLOOR, 2.08, -Math.PI / 2 + 0.2)); put("sack", leant(11.2, STALL_FLOOR, 2.64, -Math.PI / 2 - 0.3, -0.13, 0, 0.95));
  put("sack", M(11.21, STALL_FLOOR, 7.52, -Math.PI / 2 + 0.3)); put("sack", M(11.22, STALL_FLOOR, 8.78, -Math.PI / 2 - 0.2, 0.95));
  put("sackLying", M(11.26, STALL_FLOOR, 6.78, Math.PI / 2 + 0.05)); put("sackLying", M(11.24, STALL_FLOOR + 0.19, 6.81, Math.PI / 2 - 0.12));
  load("basket", M(10.7, STALL_FLOOR, 8.42, 0.3, 0.95), "onion", 18, 1.2, { variant: 1 });

  // ---- Goods set out along the hall ----------------------------------------
  // Everything stands hard against the walls, below the range signs and clear of the lanes, and nothing
  // within reach of where a player can stand rises to eye height.
  // Stepped stands under the smaller signs: fruit down the left wall, vegetables down the right.
  for (const [side, z, width, paint] of [[-1, -15.95, 2.3, 0x2f6f6a], [-1, -18.65, 1.7, 0xb9862f], [1, -15.75, 1.7, 0x7a2a26], [1, -18.5, 1.7, 0x3c5a80]]) stand(W(side, z), width, paint);
  /**
   * A frame on a tread of a stand: `s` metres along the wall from the stand's middle, `step` 0 for the low
   * tread and 1 for the high one. `tilt` props the back of a produce tray up on a batten so it shows its load.
   */
  const onTread = (side: number, z: number, s: number, step: number, yaw = 0, size = 1, tilt = 0) => {
    const turned = L(W(side, z, s, step ? 0.92 : 0.5, step ? 0.238 : 0.667), 0, 0, 0, yaw);
    if (tilt) {
      const rise = ((0.1705 * Math.cos(tilt) + 0.125) * size - 0.015) * Math.tan(tilt);
      emit("joinery", stick(0.42 * size, rise, 0.03, 0, rise / 2, -0.125 * size, 0), turned, 0xb8a890);
    }
    return L(turned, 0, 0.1705 * size * Math.sin(tilt), 0).multiply(new THREE.Matrix4().makeRotationX(tilt)).scale(new THREE.Vector3(size, size, size));
  };
  // Citrus, apples and grapes on the long stand, one tray of oranges half sold.
  load("basket", onTread(-1, -15.95, -0.82, 0, 0.3, 0.76), "orange", 22, 1.2);
  load("crateProduce", onTread(-1, -15.95, -0.27, 0, 0.04, 1, 0.2), "lemon", 28, 1.2);
  load("basket", onTread(-1, -15.95, 0.29, 0, -0.5, 0.76), "pomegranate", 14, 1.05);
  load("crateProduce", onTread(-1, -15.95, 0.83, 0, -0.07), "orange", 9, 1.2);
  load("crateProduce", onTread(-1, -15.95, -0.8, 1, 0.03, 1, 0.24), "grapes", 14, 0.85, { tint: 0xb8cc5a });
  load("basketTray", onTread(-1, -15.95, -0.22, 1, 0.7, 0.64), "apple", 14, 1.1, { variant: 1 });
  load("basket", onTread(-1, -15.95, 0.3, 1, 0.2, 0.78), "lemon", 24, 1.25);
  load("crateProduce", onTread(-1, -15.95, 0.84, 1, -0.05), "bananas", 5);
  // Melons beside it: watermelons loose on the low tread, a slatted crate of melons, pomegranates and oranges above.
  for (const [s, yaw, size] of [[-0.66, 0.15, 1], [-0.36, 1.42, 0.92], [-0.04, -0.22, 1.05]]) put("watermelon", L(W(-1, -18.65, s, 0.5, 0.667), 0, 0, 0, yaw, size));
  load("crateSlat", onTread(-1, -18.65, 0.47, 0, 0.04, 0.95), "melon", 9);
  load("basket", onTread(-1, -18.65, -0.53, 1, -0.3, 0.8), "melon", 8, 0.8);
  load("crateProduce", onTread(-1, -18.65, 0.02, 1, 0.02, 1, 0.22), "pomegranate", 14, 1.05);
  load("crateProduce", onTread(-1, -18.65, 0.56, 1, 0.1), "orange", 24, 1.2);
  // Tomatoes, peppers, onions and garlic across the hall.
  load("basket", onTread(1, -15.75, -0.56, 0, 0.4, 0.76), "tomato", 22, 1.2);
  load("crateProduce", onTread(1, -15.75, 0, 0, -0.03, 1, 0.2), "pepper", 16, 1.1);
  load("basket", onTread(1, -15.75, 0.56, 0, -0.2, 0.76), "onion", 18, 1.15, { variant: 0 });
  load("crateProduce", onTread(1, -15.75, -0.55, 1, 0.04, 1, 0.24), "tomato", 26, 1.15);
  load("basketTray", onTread(1, -15.75, 0, 1, 0, 0.64), "garlic", 20, 1.35);
  load("basket", onTread(1, -15.75, 0.56, 1, 0.5, 0.78), "pepper", 12, 1.1, { tint: 0x2e7d1e });
  load("crateProduce", onTread(1, -18.5, -0.55, 0, 0.08), "tomato", 10, 1.2);
  load("basket", onTread(1, -18.5, 0, 0, -0.35, 0.76), "onion", 18, 1.15, { variant: 1 });
  load("basket", onTread(1, -18.5, 0.56, 0, 0.25, 0.76), "lemon", 24, 1.25);
  load("basketTray", onTread(1, -18.5, -0.56, 1, 0, 0.64), "apple", 14, 1.1, { variant: 0 });
  load("crateProduce", onTread(1, -18.5, 0, 1, -0.04, 1, 0.22), "onion", 20, 1.15, { variant: 0 });
  load("crateProduce", onTread(1, -18.5, 0.55, 1, 0.03, 1, 0.2), "grapes", 14, 0.85, { tint: 0x9a4a7c });
  // Between each pair of stands a packing crate with more on it; on the right a full sack slumped against the crate.
  const crateTop = props.get("crateSmall").size[1];
  put("crateSmall", M(-9.19, 0, -17.45, 0.05));
  load("crateProduce", M(-9.16, crateTop, -17.46, Math.PI / 2 - 0.12), "orange", 26, 1.2);
  put("crateSmall", M(9.19, 0, -17.36, -0.07));
  load("basket", M(9.17, crateTop, -17.36, 0.6, 0.85), "pepper", 14, 1.1, { tint: 0xc81e14 });
  put("sack", leant(9.2, 0, -16.865, -Math.PI / 2 + 0.2, -0.12, 0, 0.9));

  // Left wall: a grain merchant's sacks on a duckboard, three stacked flat with a full one slumped against them.
  duckboard(L(W(-1, -10.6), 0, 0, 0.53), 3.7, 0.76);
  put("sackLying", M(-9.12, 0.085, -9.18, Math.PI / 2 + 0.05)); put("sackLying", M(-9.1, 0.275, -9.22, Math.PI / 2 - 0.08)); put("sackLying", M(-9.13, 0.46, -9.15, Math.PI / 2 + 0.22));
  put("sack", leant(-9.14, 0.085, -9.88, Math.PI / 2 + 0.3, 0.13));
  openSack(-9.02, 0.085, -10.46, 1, 1); openSack(-9.07, 0.085, -11.05, 1.08, 0); openSack(-8.99, 0.085, -11.64, 0.96, 6); openSack(-9.04, 0.085, -12.18, 0.95, 4);
  // Pots of every size for sale on the flags under the pottery rack, baskets nested beside them and a crate of jars still packed.
  put("urn", M(-9.1, 0, -1.38, Math.PI / 2 + 0.2, 0.92)); put("amphora", M(-9.15, 0, -0.72, spin(), 0.88));
  put("crock", M(-8.93, 0, -0.98, 0.5)); put("jarCeramic", M(-8.92, 0, -0.36, spin())); put("jarCeramic", M(-8.94, 0, -1.82, spin(), 0.8));
  put("basket", M(-9.08, 0, 0.12, 0.4)); put("basket", M(-9.07, 0.075, 0.13, 1.9));
  const packed = M(-9.18, 0, 0.78, Math.PI / 2 + 0.08);
  put("crateSlat", packed);
  for (const x of [-0.14, 0.14]) put("jarCeramic", L(packed, x, 0.013, 0.01, spin(), 0.9));
  // Rolled rugs lean only where the wall is bare: clear of the posts, the tiled panels and the range signs.
  roll(-13.6, -WALL, 0.13 + random() * 0.05, "x", 1);
  put("amphora", M(-9.04, 0, -7.36, spin())); put("urn", M(-8.98, 0, -6.74, Math.PI / 2 + 0.3, 0.84));
  rugPile(-9.02, -25.3, 9, Math.PI / 2, 0, 0.9, 0.82);
  // Right wall: copper on the flags, sacks stacked by the furnace, the spice merchant's row further down.
  metalware(pots, 0, 8.97, 0, -0.7, 1.15); metalware(pots, 0, 9.05, 0, -1.4, 0.9); metalware(ewers, 1, 8.82, 0, -1.1, 1.1);
  for (const [z, kind] of [[-2.75, 1], [-3.1, 0], [-7.0, 2], [-7.4, 1]]) metalware(kind === 0 ? pots : kind === 1 ? ewers : bowls, kind, 9.02, 0, z, 1 + random() * 0.3);
  for (const z of [-2.6, -7.25]) { trays.push({ position: [9.44, 0.34, z], rotation: [0.2, -Math.PI / 2, 0] }); brassOf[3].push(0xffffff); }
  put("sackLying", M(9.1, 0, -9.25, Math.PI / 2 + 0.06)); put("sackLying", M(9.07, 0.19, -9.21, Math.PI / 2 - 0.1)); put("sackLying", M(9.11, 0.375, -9.27, Math.PI / 2 + 0.18));
  put("sack", leant(9.13, 0, -8.6, -Math.PI / 2 + 0.4, -0.13));
  roll(-19.56, WALL, 0.13 + random() * 0.05, "x", -1);
  duckboard(L(W(1, -22.64), 0, 0, 0.53), 3.7, 0.76);
  put("sack", M(9.12, 0.085, -24.19, -Math.PI / 2 - 0.25));
  openSack(9.02, 0.085, -23.59, 1, 3, TURMERIC); openSack(9.06, 0.085, -23.0, 1.06, 3, PAPRIKA); openSack(8.99, 0.085, -22.4, 0.95, 5); openSack(9.04, 0.085, -21.84, 1, 3, CUMIN); openSack(9.03, 0.085, -21.26, 1.05, 3, SUMAC);
  // Empty crates stacked past the spice row, one still holding watermelons.
  put("crateSmall", M(9.14, 0, -25.25, -Math.PI / 2 + 0.08));
  load("crateSlat", M(9.12, crateTop, -25.22, -Math.PI / 2 - 0.25), "watermelon", 3);
  put("crateSlat", M(9.1, 0, -25.98, -Math.PI / 2 + 0.3));
  // A few that rolled off the stands.
  pile(M(-8.74, 0, -16.75), "orange", 3, [0.24, 0.5], 1.2); pile(M(8.74, 0, -18.4), "onion", 3, [0.24, 0.6], 1.15, { variant: 0 });
  // Big jars in the far corners and by the arcade.
  put("urn", M(9.0, 0, -26.6, Math.PI / 2 - 0.3, 1.15)); put("amphora", M(9.06, 0, -27.3, spin(), 0.95));
  put("amphora", M(-9.0, 0, -26.75, spin(), 1.05)); put("crock", M(-8.92, 0, -27.22, 0.4, 1.1));
  put("urn", M(8.98, 0, 0.82, Math.PI / 2, 1.05));
  // Low tables against the arcade piers, and the back corners.
  bench(L(W(-1, 5.35), 0, 0, 0.27), 1.2, 0.44, 0.46);
  for (let i = 0; i < 3; i += 1) { folded.push({ position: [-9.27, 0.5 + i * 0.075, 5.02 + (random() - 0.5) * 0.04], rotation: [0, (random() - 0.5) * 0.12, 0], scale: [0.27, 1, 0.5] }); foldedColours.push(RUG_DYES[(i * 3 + 1) % RUG_DYES.length]); }
  load("basket", M(-9.25, 0.46, 5.68, 0.5, 0.72), "pomegranate", 9);
  put("sack", M(8.98, 0, 9.12, -2.2)); openSack(8.9, 0, 8.44, 0.95, 0); put("sackLying", M(8.36, 0, 9.28, Math.PI / 2 + 0.15));

  // ---- Dressing: wares, vehicles and clutter --------------------------------
  // All of it stands hard against a wall, hangs overhead or sits inside the arcades.
  // Shelves of pottery and metalware in the bays the range signs leave free, and either side of the chart.
  rack(W(-1, -1.0), 1.5, "pots"); rack(W(1, -1.0), 1.5, "brass"); rack(W(1, -9.05), 1.3, "brass");
  rack(W(-1, -26.4), 1.3, "pots"); rack(W(1, -26.2), 1.4, "brass");
  rack(M(-7.9, 0, 9.72, Math.PI), 2.3, "pots"); rack(M(7.9, 0, 9.72, Math.PI), 2.3, "brass");

  // A loaded handcart under the pottery by the back wall, water jars in the other corner.
  handcart(M(-7.6, 0, 9.0, -Math.PI / 2));
  waterJar(7.2, 9.25, 1, true); waterJar(7.86, 9.3, 1.08, false); waterJar(7.5, 8.72, 0.82, true);
  waterJar(-8.97, -8.48, 0.95, true);
  stool(M(6.75, 0, 9.15)); stool(M(8.8, 0, 6.55)); stool(M(8.75, 0, 3.45)); stool(M(-8.8, 0, 4.3));

  // Tea by the copper stall: a kettle on the brazier, the samovar and glasses on the table against the pier.
  bench(L(W(1, 5.35), 0, 0, 0.27), 1.3, 0.44, 0.82, { shelf: true });
  brazier(M(8.97, 0, 4.2, 0.4));
  samovar(M(9.27, 0.82, 5.03, -Math.PI / 2, 0.74));
  teaTray(M(9.25, 0.82, 5.68, 0, 0.62));
  metalware(bowls, 2, 9.27, 0.2, 5.1, 0.62); metalware(pots, 0, 9.27, 0.2, 5.62, 0.55);
  // Tea tins and the sugar jar between the samovar and the tray.
  for (const [x, y, z] of [[9.34, 0.82, 5.3], [9.335, 0.915, 5.305], [9.2, 0.82, 5.36], [9.36, 0.82, 5.96]]) put("tin", M(x, y, z, -Math.PI / 2 + (pick() - 0.5) * 0.8));
  put("jarCeramic", M(9.3, 0.82, 4.8, spin(), 0.55));
  const emberMap = track(softDiscTexture());
  const emberLight = new THREE.Mesh(merge([
    new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2).translate(8.97, 0.02, 4.2),
  ]), new THREE.MeshBasicMaterial({ map: emberMap, color: new THREE.Color(1, 0.3, 0.06).multiplyScalar(0.55), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  scene.add(emberLight);
  kit.mirrorHidden.push(emberLight);

  // A bicycle leant on the wall and a sack truck with its load.
  bicycle(new THREE.Matrix4().compose(new THREE.Vector3(-9.02, 0.02, -13.3), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, Math.PI / 2, 0, "YXZ")), new THREE.Vector3(1, 1, 1)), 0x2f5f4a);
  barrow(M(9.24, 0, -14.25, -Math.PI / 2));
  for (let layer = 0; layer < 3; layer += 1) put("sackLying", M(9.0 + layer * 0.03, 0.078 + layer * 0.19, -14.25 + (layer % 2) * 0.04, Math.PI / 2 + (pick() - 0.5) * 0.2));

  // Scoops left standing in the open sacks.
  if (high) openSacks.forEach(([x, y, z, scale], index) => {
    if (index % 2) return;
    const scoop = merge([new THREE.CylinderGeometry(0.036, 0.03, 0.12, 8, 1, false, 0, Math.PI).rotateX(Math.PI / 2), new THREE.CircleGeometry(0.036, 6, 0, Math.PI).translate(0, 0, -0.06), rod([0, 0.01, -0.06], [0, 0.03, -0.17], 0.009, 6)]);
    emit("brass", scoop.rotateX(1.2), M(x + 0.05 * scale, y + 0.4 * scale, z + 0.04, spin()));
  });

  // The cloth stall: shirts on poles in the arches.
  for (const z of [2.95, 7.75]) {
    garmentRail(W(-1, z, 0, 2.72, -1.0), 2.5, 3);
    // Strings of chillies, garlic and dried fruit in the spice stall's arches.
    [-0.95, -0.35, 0.4, 1.0].forEach((dz, index) => driedString(M(9.98, 1.88 + Math.sqrt(1.6 * 1.6 - dz * dz), z + dz), (index + (z > 5 ? 1 : 0)) % 3, 0.55 + pick() * 0.3));
  }
  scales(M(11.95, 0.975, 3.82, 0.3), TURMERIC);
  // Bowls of spice with a mound in each on the second table.
  [0xd9a21b, 0xb5391c, 0x5d7340].forEach((spice, index) => {
    const m = M(11.95 + (index - 1) * 0.04, 0.975, 8.2 + index * 0.27, 0, 0.85);
    emit("pottery", lathe(TURNED.bowl, 14), m, GLAZES[(index * 3 + 1) % GLAZES.length]);
    emit("matte", new THREE.SphereGeometry(0.125, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.085, 0), m, spice);
  });

  // Blocks and falls for hauling the cloths up, made off on cleats at the posts.
  if (high) for (const [index, side] of [[4, -1], [4, 1], [6, 1], [8, -1], [10, 1], [10, -1]]) {
    const z = TRUSS_Z[index] + 0.17, x = side * 7.2;
    emit("iron", rod([x, 7.1, z], [x, 6.98, z], 0.008, 4), HERE, IRON);
    emit("joinery", softBox(0.06, 0.17, 0.11, 0.015, 1).translate(x, 6.9, z), HERE);
    emit("iron", new THREE.CylinderGeometry(0.045, 0.045, 0.07, 10).rotateZ(Math.PI / 2).translate(x, 6.89, z), HERE, IRON);
    emit("rope", rod([x, 6.88, z], [side * 9.2, 5.15, z], 0.008, 5), HERE, HEMP);
    emit("rope", rod([x, 6.9, z], [side * 4.7, 7.07, z], 0.008, 5), HERE, HEMP);
    emit("iron", box(0.05, 0.03, 0.16, side * 9.19, 5.15, z, 1), HERE, IRON);
    emit("rope", new THREE.TorusGeometry(0.1, 0.018, 5, 14).rotateY(Math.PI / 2).translate(side * 9.17, 5.02, z), HERE, HEMP);
  }

  // A stone gutter down each side of the hall.
  const drain = drainTextures();
  track(drain.map); track(drain.normalMap);
  for (const texture of [drain.map, drain.normalMap]) { texture.repeat.set(1, 36 / 1.68); texture.anisotropy = anisotropy; }
  const gutter = new THREE.Mesh(merge([-1, 1].map((side) => new THREE.PlaneGeometry(0.42, 36).rotateX(-Math.PI / 2).translate(side * 8.28, 0.008, -9.4))),
    new THREE.MeshStandardMaterial({ map: drain.map, normalMap: drain.normalMap, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.8, metalness: 0, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  gutter.receiveShadow = true;
  scene.add(gutter);
  kit.mirrorHidden.push(gutter);

  // Straw off the crates, petals and peel trodden about.
  if (high) {
    const scatter = rng(606), litter: Transform[] = [], litterColours: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const side = scatter() < 0.5 ? -1 : 1, edge = scatter() * scatter();
      litter.push({ position: [side * (8.9 - edge * 3.4), 0.006 + scatter() * 0.002, -26 + scatter() * 35], rotation: [0, scatter() * Math.PI, 0], scale: [0.07 + scatter() * 0.12, 1, 0.006] });
      litterColours.push([0xc9a85a, 0xb8944a, 0xdcc07a][i % 3]);
    }
    const drifts: Array<[number, number, number[]]> = [[-7.4, -5, [0xd9486a, 0xe8a23a, 0xf0dcc0]], [7.2, -5, [0xd9801c, 0xe8a23a]], [-7.6, 3, [0xb84a6a, 0xf0dcc0]], [7.6, 5.6, [0xd9a21b, 0xb5391c]], [-7.8, -16.6, [0xd9801c, 0xc9442a, 0x6a8a2f]], [7.9, -17.6, [0xd9b52a, 0xd9801c]], [-7.6, -23, [0xd9486a, 0xf0dcc0]], [0.4, 8.2, [0xd9486a, 0xe8a23a]]];
    for (const [x, z, colours] of drifts) for (let i = 0; i < 26; i += 1) {
      const a = scatter() * Math.PI * 2, r = scatter() * scatter() * 2.2;
      litter.push({ position: [x + Math.cos(a) * r, 0.007, z + Math.sin(a) * r], rotation: [0, scatter() * Math.PI, 0], scale: [0.025 + scatter() * 0.03, 1, 0.018 + scatter() * 0.02] });
      litterColours.push(colours[i % colours.length]);
    }
    instances(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), litter, false, false, litterColours);
  }

  // ---- Planting --------------------------------------------------------------
  // Date palms among the houses beyond the gable, seen through the lattice against the sky. Their
  // feet are below the masonry, where the town has no ground; their crowns toss in the street's wind.
  const palms = (spots: number[][], stems: number[]) => spots.map(([x, z, crown], index): TreeItem => {
    const variant = stems.length > 1 ? (index % 2) * 2 : 0, scale = 1.02 + (index % 3) * 0.09;
    return { at: [x, crown - stems[index % stems.length] * scale, z], yaw: index * 2.4, scale, variant };
  });
  trees.place("datePalm", palms([[-12.5, -34.2, 13.4], [3.2, -35, 15.2], [5.1, -36.2, 12.2], [14.8, -34.6, 14.1], [-22, -35.5, 12.6], [24.5, -36, 13.8], [-8, -34.4, 11.8], [9.6, -34.3, 16.2]], [8.2, 10.2]), { detail: "mid", shadow: false, hit: false });
  trees.place("datePalm", palms([[-2.5, -49, 17.5], [17, -51, 18.5], [-17.5, -50, 17]], [8.2]), { detail: "far", shadow: false, hit: false });
  trees.place("flowerBox", sills, { detail: "mid", shadow: false, hit: false });
  // A fan palm in a glazed tub at each arcade, hard against the wall: the fans open above head height.
  const tubs: V3[] = [[-9.02, 0, 0.92], [9.02, 0, 7.62]];
  tubs.forEach(([x, , z], index) => {
    emit("pottery", lathe(TURNED.flowerpot, 20).scale(4, 4.2, 4), M(x, 0, z), index ? 0x2c5a60 : 0xb5673a);
    emit("matte", new THREE.CircleGeometry(0.3, 16).rotateX(-Math.PI / 2).translate(0, 0.475, 0), M(x, 0, z), 0x2a1f16);
  });
  trees.place("fanPalm", tubs.map(([x, , z], index) => ({ at: [x, 0.46, z] as V3, scale: [0.56, 0.74, 0.56] as V3, variant: 0, yaw: 0.7 + index * 2.1 })));
  // Bougainvillea: one trained up a trellis beside the spice shop from a pot at the wall foot,
  // one spilling from under a sill over the copper arcade.
  const trellis = W(-1, -2.62);
  for (const x of [-0.3, -0.1, 0.1, 0.3]) emit("joinery", stick(0.022, 3.4, 0.012, x, 2.05, 0.03), trellis, 0xb8a890);
  for (let y = 0.5; y < 3.7; y += 0.32) emit("joinery", stick(0.72, 0.022, 0.012, 0, y, 0.042), trellis, 0xb8a890);
  emit("pottery", lathe(TURNED.flowerpot, 18).scale(3.2, 3.4, 3.2), L(trellis, 0, 0, 0.29), 0xb5673a);
  emit("matte", new THREE.CircleGeometry(0.235, 14).rotateX(-Math.PI / 2).translate(0, 0.385, 0), L(trellis, 0, 0, 0.29), 0x2a1f16);
  trees.place("bougainvillea", [
    { at: onWall(-1, -2.62, 0, 0.37, 0.07), yaw: faceYaw(-1), variant: 1, scale: [0.7, 0.9, 0.85] },
    { at: onWall(1, 1.5, 0, 5.0, 0.02), yaw: faceYaw(1), variant: 2, scale: 0.9 },
  ], { shadow: false, hit: false });

  // ---- Small things that move ------------------------------------------------
  // Incense on the stool by the cloth stall and on the carpet shop's step: a brass bowl of ash with one live coal.
  const incense: V3[] = [[-8.8, 0.48, 4.3], onWall(-1, -23, 1.45, 0.14, 0.2)];
  for (const [x, y, z] of incense) {
    emit("brass", vesselGeometry(2).scale(0.38, 0.38, 0.38), M(x, y, z));
    emit("matte", new THREE.CircleGeometry(0.085, 12).rotateX(-Math.PI / 2).translate(0, 0.098, 0), M(x, y, z), 0x8a8478);
    emit("glow", new THREE.CircleGeometry(0.012, 6).rotateX(-Math.PI / 2).translate(0.01, 0.1, 0.008), M(x, y, z), new THREE.Color(3, 0.7, 0.12));
  }
  // The kettle on the brazier has a loose lid, and it is on the boil.
  const lid = new THREE.Mesh(lathe([[0, 0], [0.05, 0], [0.053, 0.008], [0.032, 0.02], [0.012, 0.026], [0.01, 0.036], [0.019, 0.046], [0, 0.054]], 14), brass);
  place(lid, 8.97, 0.905, 4.2, false);
  // A wind chime of brass tubes in the crown of the copper stall's first arch. Its origin is its hook.
  const chime = new THREE.Mesh(merge([
    new THREE.CylinderGeometry(0.058, 0.058, 0.008, 14).translate(0, -0.1, 0), rod([0, 0, 0], [0, -0.1, 0], 0.0025, 4),
    ...[0.3, 0.24, 0.34, 0.21, 0.27].flatMap((long, index) => {
      const a = index * Math.PI * 0.4, x = Math.cos(a) * 0.044, z = Math.sin(a) * 0.044;
      return [new THREE.CylinderGeometry(0.0065, 0.0065, long, 7, 1, true).translate(x, -0.14 - long / 2, z), rod([x, -0.1, z], [x, -0.14, z], 0.0015, 3)];
    }),
    new THREE.CylinderGeometry(0.022, 0.022, 0.006, 10).translate(0, -0.27, 0), rod([0, -0.1, 0], [0, -0.5, 0], 0.0015, 3),
    new THREE.BoxGeometry(0.05, 0.075, 0.002).rotateZ(Math.PI / 4).translate(0, -0.54, 0),
  ]), brass);
  place(chime, 9.94, 3.48, 2.95, false);
  chime.userData.walkThrough = true;
  life.sway(chime, { amplitude: 0.22, period: 1.35, damping: 0.07 });
  // The stall's cat, asleep on a cushion on the stool by the brazier.
  emit("fabric", new THREE.SphereGeometry(0.225, 16, 8).scale(1, 0.19, 1).translate(0, 0.515, 0), M(8.8, 0, 6.55), 0x2e4763, 0.8);
  const catPose = new THREE.Vector4(), catAt = new THREE.Vector3(8.8, 0.545, 6.55);
  const fur = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.3 });
  fur.onBeforeCompile = (shader) => {
    shader.uniforms.catPose = { value: catPose };
    // x swells the flanks with each breath, y and z flick an ear, w lifts the tip of the tail.
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute vec3 catMove;\nuniform vec4 catPose;")
      .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
        transformed += normal * (catMove.x * 0.0045 * catPose.x);
        transformed += vec3(0.0, -0.45, -0.9) * (abs(catMove.y) * 0.017 * (catMove.y > 0.0 ? catPose.y : catPose.z));
        transformed += vec3(0.25, 0.9, 0.35) * (catMove.z * catMove.z * 0.05 * catPose.w);`);
  };
  fur.customProgramCacheKey = () => "bazaar-cat";
  const cat = new THREE.Mesh(catGeometry(), fur);
  place(cat, catAt.x, catAt.y, catAt.z);
  cat.rotation.y = -Math.PI / 2 + 0.35;
  cat.scale.setScalar(1.1);
  cat.userData.walkThrough = true;

  // The library's goods: one batch per kind.
  for (const { kind, cast, items } of goods.values()) props.place(kind, items, cast ? {} : { shadow: false });

  // ---- Chalked prices and a notice ------------------------------------------
  // One sheet, one mesh: slates on stakes pushed in behind the goods, and a paper nailed to a post.
  const SLATES = [
    ["POMEGRANATES", "the original grenade", "$300 each"], ["GRAPES", "by the bunch", "5-stack discount"],
    ["TOMATOES", "lit for 90", "(the kilo)"], ["PEPPERS", "mild  ·  hot  ·", "INFERNO"], ["ONIONS", "crying?", "skill issue"],
    ["GARLIC", "keeps smurfs", "away"], ["SMOKED PAPRIKA", "one pinch covers", "mid for 18 s"], ["RICE", "$16000 max", "per customer"],
    ["CHICK PEAS", "no chickens harmed", "this round"], ["LENTILS", "pistol-round supper", "$800 feeds five"],
  ];
  const sheet = track(slateSheet(SLATES, ["LOST", "one chicken", "last seen crossing mid", "do NOT shoot", "answers to nothing"], 71));
  sheet.anisotropy = anisotropy;
  const chalked: THREE.BufferGeometry[] = [], hand = rng(77);
  const cellUv = (geometry: THREE.BufferGeometry, cell: number, from: number, to: number, edge: boolean) => {
    const uv = geometry.attributes.uv, u0 = (cell % 4) / 4, v0 = 1 - (Math.floor(cell / 4) + 1) / 3;
    for (let i = from; i < to; i += 1) uv.setXY(i, u0 + (edge ? 0.004 : uv.getX(i) / 4), v0 + (edge ? 0.008 : uv.getY(i) / 3));
  };
  /** A slate on a stake pushed into the goods at the origin of `m`, facing its +z and leaning back; `rise` is the height of its middle. */
  const slate = (cell: number, m: THREE.Matrix4, rise: number) => {
    const leaning = m.clone().multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.08 - hand() * 0.1, (hand() - 0.5) * 0.5, (hand() - 0.5) * 0.14, "YXZ")));
    emit("joinery", stick(0.018, rise, 0.008, 0, rise / 2, -0.009, 0), leaning, 0xb8a890);
    const board = new THREE.BoxGeometry(0.27, 0.18, 0.008);
    cellUv(board, cell, 0, 16, true); cellUv(board, cell, 16, 20, false); cellUv(board, cell, 20, 24, true);
    chalked.push(board.translate(0, rise, 0).applyMatrix4(leaning));
  };
  slate(0, W(-1, -15.95, 0.31, 0.55, 0.56), 0.45); slate(1, W(-1, -15.95, -0.83, 0.96, 0.09), 0.34);
  slate(2, W(1, -15.75, -0.58, 0.55, 0.56), 0.45); slate(3, W(1, -15.75, 0.03, 0.56, 0.52), 0.41); slate(5, W(1, -15.75, -0.02, 0.94, 0.07), 0.32);
  slate(4, W(1, -18.5, 0.02, 0.55, 0.56), 0.44);
  slate(6, W(1, -23.0, 0.03, 0.385, 0.38), 0.44);
  slate(9, W(-1, -10.46, -0.02, 0.38, 0.42), 0.42); slate(7, W(-1, -11.05, 0, 0.385, 0.37), 0.46); slate(8, W(-1, -12.18, 0.02, 0.37, 0.4), 0.42);
  const paper = new THREE.PlaneGeometry(0.27, 0.18);
  cellUv(paper, SLATES.length, 0, 4, false);
  chalked.push(paper.applyMatrix4(L(W(1, -14, 0.01, 1.5, 0.336), 0, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(-0.035))));
  place(new THREE.Mesh(merge(chalked), new THREE.MeshStandardMaterial({ map: sheet, roughness: 0.9, metalness: 0, envMapIntensity: 0.4 })), 0, 0, 0, false);
  const bolt = new THREE.CylinderGeometry(0.075, 0.075, 0.95, 10);
  instances(bolt, woven, bolts, false, false, boltColours);
  instances(softBox(1.5, 0.075, 1.0, 0.03, 0.5), woven, folded, false, true, foldedColours);
  instances(new THREE.CylinderGeometry(0.13, 0.13, 2, 12), woven, rolls, true, true, rollColours);
  instances(vesselGeometry(0), brass, pots, true, true, brassOf[0]);
  instances(vesselGeometry(1), brass, ewers, true, true, brassOf[1]);
  instances(vesselGeometry(2), brass, bowls, true, true, brassOf[2]);
  instances(trayGeometry(), brass, trays, false, true, brassOf[3]);

  // Rugs spread on the flags in front of the shops and stalls: [x, z, pattern, yaw].
  const spread: Array<[number, number, number, number]> = [[-7.9, -5, 0, 0.04], [-7.95, -23, 1, -0.05], [7.9, -5, 2, 0.03], [-7.9, 2.95, 3, 0.06], [-7.95, 7.75, 0, -0.04]];
  spread.forEach(([x, z, rug, yaw], index) => rugParts[rug].push(floorRug(1.25, 2.5, index + 1).applyMatrix4(M(x, 0, z, yaw))));
  rugs.forEach((material, rug) => {
    if (!rugParts[rug].length) return;
    const mesh = new THREE.Mesh(merge(rugParts[rug]), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });

  // One mesh per material for everything gathered above.
  const SHADOWED: BagKey[] = ["joinery", "brass", "pottery", "fabric", "gingham", "awning", "tunic", "check"], SOLID: BagKey[] = ["joinery", "brass", "pottery"];
  (Object.keys(bag) as BagKey[]).forEach((key) => {
    if (!bag[key].length) return;
    const mesh = new THREE.Mesh(mergeGeometries(bag[key]), bagMaterial[key]);
    bag[key].forEach((part) => part.dispose());
    mesh.castShadow = SHADOWED.includes(key);
    mesh.receiveShadow = key !== "glow";
    scene.add(mesh);
    if (SOLID.includes(key)) kit.shootable.push(mesh);
  });

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 4.2);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xffe6c8, 0xb89468, 1.5));
  const sun = kit.sunLight({ color: 0xffcf98, intensity: 9, toSun: TO_SUN, extent: 27, distance: 54, near: 6, far: 104, radius: 2 });
  // Four lamps in all: two over the hall and one in each arcade. Every other lantern, bulb and window is emissive only.
  const fills = ([[0, 4.7, -17], [0, 4.7, -5]] as V3[]).map((position) => {
    const light = new THREE.PointLight(0xffcfa0, 46, 25, 2);
    light.position.set(...position);
    scene.add(light);
    return light;
  });
  for (const side of [-1, 1]) {
    const stall = new THREE.PointLight(side < 0 ? 0xffb872 : 0xffa050, 20, 11, 2);
    stall.position.set(side * 11.7, 3.2, 5.35);
    scene.add(stall);
    fills.push(stall);
  }

  // The flames are what light the hall: the four lamps breathe with them, and so do the pools on the walls and the coals.
  fills.forEach((light, index) => life.flicker(light, "lantern", { cue: false, rate: 0.7 + index * 0.17 }));
  life.flicker(poolLight.material, "lantern", { cue: false, rate: 1.3 });
  life.flicker(emberLight.material, "candle", { cue: false, rate: 0.45 });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 420, x: 18, y: [0.3, 7], z: [-28, 8], color: 0xffd9a6, opacity: 0.3 });
  const air = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => ({ x: [x0, x1] as [number, number], y: [y0, y1] as [number, number], z: [z0, z1] as [number, number] });
  // Spice dust hangs where the two open bays let the sun down to head height.
  for (const [bay, side, cell] of [[4, 1, 2], [10, 1, 0]]) {
    const through = new THREE.Vector3(...onSlope(side, (PURLINS[cell] + PURLINS[cell + 1]) / 2, 0.2), 8.5 - bay * 3);
    through.addScaledVector(TO_SUN, -(through.y - 1.8) / TO_SUN.y);
    life.drift("motes", { volume: air(through.x - 1.6, through.x + 1.6, 0.2, 3.6, through.z - 2.4, through.z + 2.4), count: 80, colors: [bay === 4 ? 0xd9a21b : 0xc9602a] });
  }
  // Petals off the bougainvillea and the garland sellers, and the dust of the flags, lie still until a gust lifts them and runs them down the street.
  const PETALS = [0xb8306a, 0x9a2858, 0xb8801c, 0xa8322a];
  life.drift("petals", { volume: air(-8.2, 8.2, 0, 2.4, -3.3, 7.8), count: 46, colors: PETALS, falling: 0.3 });
  life.drift("petals", { volume: air(-8, 7.6, 0, 2.2, -15.5, -10.5), count: 30, colors: PETALS, falling: 0.2 });
  life.drift("dust", { volume: air(-8.2, 8.2, 0, 1.2, -3.3, 7.8), colors: [0xa88a5c] });
  // Charcoal smoke off the brazier, a thread from each bowl of incense, steam from the kettle and the samovar.
  life.plume("smoke", [8.97, 0.5, 4.2], { rise: 3.4, size: [0.14, 0.9], opacity: 0.4, color: 0x8f867a, lean: 0.9 });
  life.plume("smoke", incense.map(([x, y, z]) => [x, y + 0.11, z] as V3), { rise: 1.9, size: [0.025, 0.3], life: 6, density: 16, opacity: 0.55, color: 0xb8b2a8, lean: 0.5 });
  life.plume("steam", [[8.97, 0.95, 4.2], [9.27, 1.5, 5.03]], { rise: 0.9, size: [0.04, 0.32], opacity: 0.6 });

  // ---- Life ----------------------------------------------------------------
  // Sparrows where there is air to fly in, clear of the cloth: on the sign arms, a bulb wire and
  // the spilt grain at this end, and on the wire over the far stations at the other. A flushed
  // flock wheels some metres wider and higher than the box it is given, so the boxes are slim
  // and keep to the middle of the hall. Swifts hunt over the roofs beyond the gable.
  const arm = ([x, y, z]: V3) => ({ from: [x - 0.38, y, z] as V3, to: [x + 0.38, y, z] as V3, thin: true });
  life.birds("sparrow", {
    perches: [arm(dyeArm), arm(teaArm), arm(knifeArm), { from: [-1.472, 4.729, -4.52], to: [0, 4.708, -5], thin: true }, { from: [0, 4.708, -5], to: [1.472, 4.729, -5.48], thin: true }, [7.9, 0, 2.3], [7.5, 0, 1.9], [8.1, 0, 1.6]],
    count: 8, roam: air(-3, 3, 4.5, 4.7, -6.5, 2.5),
  });
  life.birds("sparrow", {
    perches: [{ from: [3.68, 4.836, -15.8], to: [1.472, 4.729, -16.52], thin: true }, { from: [1.472, 4.729, -16.52], to: [0, 4.708, -17], thin: true }, { from: [0, 4.708, -17], to: [-1.472, 4.729, -17.48], thin: true }, { from: [-1.472, 4.729, -17.48], to: [-3.68, 4.836, -18.2], thin: true }],
    count: 7, roam: air(-3, 3, 4.5, 4.7, -21.5, -12.5),
  });
  life.soaring("swift", { centre: [0, 0, -42], radius: 15, height: 10.5, count: 4 });
  // Hens and a cock loose on the flags: across the middle of the hall and in front of the firing line.
  life.chickens({ areas: [[-7.4, -15.4, 7, -10.6], [-7.6, -3.2, 7.4, 4.6]], count: 6 });
  // Flies over the fruit on all four stands, and wasps at the grapes.
  life.insects([[-8.95, 1, -15.9], [-8.95, 0.95, -18.7], [8.95, 1, -15.75], [8.95, 1, -18.5]], { kind: "flies" });
  life.insects([[-8.95, 0.9, -16.75], [8.95, 0.9, -16.55]], { kind: "flies", count: 3, radius: 0.26, color: 0xb8922a });

  // ---- The gust, and the small sounds of the place ------------------------------
  // The headline: every minute or so the draught gathers into one long gust. It is heard coming
  // over the back wall; then a front runs down the street, shoving each lantern, working each sign
  // and shutter and cracking each swag as it passes, while the whole field blows hard for a few
  // seconds, so that the cloth, the palms beyond the gable, the petals and the dust all answer it.
  const GUST = { peak: 0.66, lead: 1.1, speed: 9, rise: 1.5, hold: 3.4, fall: 4.6 };
  const chance = rng(5150), downWind = hangers.slice().sort((a, b) => b.pivot.position.z - a.pivot.position.z);
  /** What the front sets off as it passes each place: [z, cue, x, y]. */
  const passing: Array<[number, CueName, number, number]> = [
    [2.95, "chimeTinkle", 9.94, 3.3], [2.5, "clothSnap", 3.4, 6.5], [-2, "signCreak", dyeArm[0], 3.06], [-3.4, "chainRattle", 0, 7.1],
    [-5.85, "shutterCreak", -9.4, 5.85], [-6.5, "clothSnap", -5.2, 6.5], [-8, "signCreak", knifeArm[0], 3.06], [-18.5, "clothSnap", 5.4, 6.5],
  ];
  /** What speaks up between gusts when the air stirs where it hangs: [cue, x, y, z]. */
  const stirred: Array<[CueName, number, number, number]> = [
    ["chimeTinkle", 9.94, 3.3, 2.95], ["signCreak", dyeArm[0], 3.06, -2], ["chimeTinkle", 9.94, 3.3, 2.95], ["chainRattle", 0, 7.1, -2],
    ["signCreak", knifeArm[0], 3.06, -8], ["chimeTinkle", 9.94, 3.3, 2.95], ["shutterCreak", -9.4, 5.85, -5.85], ["signCreak", teaArm[0], 3.06, -2],
  ];
  let clock = 0, gustAt = -1, heard = false, shoved = 0, passed = 0;
  // A gust is owed to whoever has just walked in. Whatever camera draws the lanterns says where the
  // player stands and looks (the floor mirror and the probes are skipped): the first turn of the
  // head or step off the mark is the arrival, and if no gust is about to blow or in full blow one is called.
  const stood = new THREE.Vector4();
  let arrival = 0, encore = false;
  if (lampMetal) lampMetal.onBeforeRender = (_renderer, _scene, camera) => {
    const e = camera.matrixWorld.elements;
    if (arrival > 1 || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera || camera.parent?.type === "CubeCamera" || e[13] < 0) return;
    if (arrival === 0) { arrival = 1; stood.set(e[12], e[14], e[8], e[10]); return; }
    if (Math.hypot(e[12] - stood.x, e[14] - stood.y) < 0.2 && Math.hypot(e[8] - stood.z, e[10] - stood.w) < 0.06) return;
    arrival = 2;
    const since = clock - gustAt;
    if (since < -4) gustAt = clock + 4;
    else if (since > GUST.lead + GUST.rise + GUST.hold) encore = true;
  };
  let startledAt = -9, stirAt = 0, stirs = 0, clinkAt = 0, hopAt = -9, tapAt = 0, taps = 0, cupAt = 0, twitchAt = 0, earAt = -9, otherEarAt = -9, tailAt = -9, alarmAt = -9;
  const pulse = (age: number, length: number) => (age <= 0 || age >= length ? 0 : Math.sin(Math.PI * age / length));
  kit.updates.push((now) => {
    const time = now / 1000;
    if (gustAt < 0) { gustAt = time + 7; stirAt = time + 3; clinkAt = time + 2.5; tapAt = time + 5; cupAt = time + 19; twitchAt = time + 3; }
    clock = time;

    const since = time - gustAt;
    if (since >= 0) {
      if (!heard) { heard = true; say("windGust", 0.5, 6, 15, 1, 0.9 + chance() * 0.2); }
      const front = 12 - (since - GUST.lead) * GUST.speed;
      if (since > GUST.lead) {
        while (shoved < downWind.length && downWind[shoved].pivot.position.z > front) { downWind[shoved].kick(0.2 + chance() * 0.25); shoved += 1; }
        while (passed < passing.length && passing[passed][0] > front) {
          const [z, cue, x, y] = passing[passed];
          say(cue, x, y, z, 0.75 + chance() * 0.25, 0.88 + chance() * 0.3);
          passed += 1;
        }
        // The sparrows sit it out (it is a shot that puts them up); the cat's ear turns.
        if (earAt < gustAt && front < catAt.z) earAt = time;
        const blow = since - GUST.lead, falling = blow - GUST.rise - GUST.hold;
        const swell = falling > 0 ? Math.max(0, 1 - falling / GUST.fall) : Math.min(1, blow / GUST.rise);
        wind.set({ strength: BREEZE + (GUST.peak - BREEZE) * swell * swell * (3 - 2 * swell) });
        if (falling >= GUST.fall) {
          wind.set({ strength: BREEZE });
          heard = false; shoved = 0; passed = 0;
          gustAt = time + (encore ? 5 : 42 + chance() * 36);
          encore = false;
        }
      }
    }

    // Between gusts a sign, a chain, a shutter or the chime answers the draught, but only while it is blowing there.
    if (time > stirAt) {
      const [cue, x, y, z] = stirred[stirs % stirred.length], blowing = wind.at(x, z);
      stirs += 1;
      stirAt = time + (blowing > 0.26 ? 4 + chance() * 6 : 1.3);
      if (blowing > 0.26 && (since < 0 || since > GUST.lead + GUST.rise)) say(cue, x, y, z, Math.min(1, 0.25 + blowing * 0.7), 0.88 + chance() * 0.26);
    }
    // The kettle lid rattles when the boil lifts it.
    if (time > clinkAt) { clinkAt = time + 5 + chance() * 8; hopAt = time; say("potClink", 8.97, 0.92, 4.2, 0.45 + chance() * 0.2, 0.9 + chance() * 0.35); }
    const hop = pulse(time - hopAt, 0.42);
    lid.position.y = 0.905 + 0.007 * hop * Math.abs(Math.sin((time - hopAt) * 34));
    lid.rotation.z = 0.09 * hop * Math.sin((time - hopAt) * 41);
    // A coppersmith at work somewhere behind the copper stall: a few taps, then a long look at the job.
    if (time > tapAt) {
      if (taps === 0) taps = 3 + Math.floor(chance() * 4);
      taps -= 1;
      say("copperTap", 12.1, 1.1, 7.9, 0.55 + chance() * 0.25, 0.94 + chance() * 0.14);
      tapAt = time + (taps > 0 ? 0.3 + chance() * 0.12 : 15 + chance() * 20);
    }
    // Tea glasses at the bench.
    if (time > cupAt) { cupAt = time + 26 + chance() * 30; say("cupClatter", 9.25, 0.95, 5.68, 0.5, 0.92 + chance() * 0.2); }

    // The cat: slow breath, an ear that turns or a tail tip that lifts now and then, both ears back and a lashing tail after a shot.
    if (time > twitchAt) {
      twitchAt = time + 3 + chance() * 8;
      const which = chance();
      if (which < 0.4) earAt = time; else if (which < 0.65) otherEarAt = time; else tailAt = time;
      if (which > 0.9) earAt = time + 0.2;
    }
    const fright = time - alarmAt, alarm = fright < 1.8 ? Math.min(1, fright / 0.07) * Math.min(1, (1.8 - fright) / 0.6) : 0;
    catPose.set(
      Math.sin(time * 1.9),
      Math.max(pulse(time - earAt, 0.26), alarm),
      Math.max(pulse(time - otherEarAt, 0.3), alarm),
      pulse(time - tailAt, 1.1) * (0.55 + 0.45 * Math.sin((time - tailAt) * 13)) + alarm * Math.abs(Math.sin(fright * 8)),
    );
  });

  // Direct sun at a point: follow the ray up to the roof and ask the bay it leaves through.
  const OPEN: Record<string, number> = { B: 0, C: 0, S: 0.5, L: 0.4, O: 0.85 };
  const sunlitAt = (point: THREE.Vector3) => {
    let x = point.x, z = point.z, y = 8.4;
    for (let i = 0; i < 2; i += 1) {
      const t = (y - point.y) / TO_SUN.y;
      x = point.x + TO_SUN.x * t; z = point.z + TO_SUN.z * t;
      y = RIDGE + 0.29 - Math.abs(x) * TAN;
    }
    if (z < -29.78) {
      // Out through the far gable instead: lit if the ray clears the masonry below the lattice.
      const t = (-29.78 - point.z) / TO_SUN.z, height = point.y + TO_SUN.y * t;
      return height > 6.4 ? 0.4 : 0;
    }
    const down = Math.abs(x) / COS;
    const cell = PURLINS.findIndex((from, index) => down >= from && down < (PURLINS[index + 1] ?? -1));
    if (cell < 0) return 0;
    return OPEN[cellAt(Math.floor((10 - z) / 3), x < 0 ? -1 : 1, cell)] ?? 0;
  };

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 1.6, skyRotation: SKY_TURN, skyClamp: 16,
      background: 0x9fb4cc, fog: 0x6a5238, fogDensity: high ? 0.004 : 0.006,
      haze: new THREE.Color(0.03, 0.021, 0.012), hazeDensity: 0.012, hazeCeiling: 9.2, hazeFade: 1.2,
      environmentIntensity: 1.5, exposure: 1.05, far: 160,
    },
    sunlitAt,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return {
    ...range,
    // A shot: the birds go up, the hens bolt, the cat's ears go back; remember where it came from for the lanterns.
    // One alarm per burst: every further round of automatic fire would shove the birds already in the air again.
    startle: (at, loudness) => {
      shooter.copy(at);
      if (clock - startledAt > 0.7) { startledAt = clock; life.startle(at, loudness); }
      if (at.distanceTo(catAt) < 26) alarmAt = clock;
    },
    struck: (object, point) => signStruck(object, point) || lanternStruck(object, point) || life.struck(object, point),
  };
}

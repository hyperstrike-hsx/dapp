import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial, polymer } from "../pbr";
import {
  archedWall, canvasTexture, createKit, hazardTexture, projectUv, softBox, softDiscTexture, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import { createProps, type PropItem, type PropKind } from "../props";
import type { CueName } from "../cues";
import { createLife } from "../life";
import { createTrees, type TreeItem } from "../trees";
import { applyWind, createWind, WIND_GLSL, type Wind } from "../wind";

// Whiteout: the yard of a relay outpost high in the mountains, under a sky the
// same colour as the ground.
//
// Lighting model: there is no visible sun. A weak, slightly warm key stands in
// for the bright patch of the overcast and gives the snow just enough form;
// everything else is cool skylight bounced off the snow, so shadows stay soft
// and blue. Thick fog swallows the horizon: the sky is a fogged dome, and the
// peaks are real geometry that the fog turns into silhouettes. Warm windows and
// lamps are the only saturated colour in the picture.

/** Direction to the bright patch of the overcast. */
const TO_SUN = new THREE.Vector3(0.46, 0.74, -0.34).normalize();
const FOG = 0xb9c6d6;
const HAB_TOP = 5.7, SHED_TOP = 5.0, MAIN_TOP = 7.8;
/** Where the wind blows to, on the ground plane. Smoke, flags, falling snow, streamers and sastrugi all follow it. */
const WIND = { x: -0.947, z: 0.321 };
/** One tile of the snow textures spans this many metres, on the slab, the land and every drift alike. */
const SNOW_TILE = 2.5;
const snowUv = (x: number, z: number): [number, number] => [(x + 20) / SNOW_TILE, (16 - z) / SNOW_TILE];
const SIDE_FROM = -28.4, SIDE_TO = 0.3;

type V3 = [number, number, number];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
function hash2(x: number, y: number, seed: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function noise2(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm2(x: number, y: number, seed: number, octaves = 4) {
  let sum = 0, amplitude = 0.5, total = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += noise2(x, y, seed + i * 13) * amplitude;
    total += amplitude;
    x = x * 2.03 + 17.3; y = y * 2.03 + 9.1; amplitude *= 0.5;
  }
  return sum / total;
}

/** Height of the land around the yard: a hollow under the slab, drifts beyond it, peaks further out. */
function terrainHeight(x: number, z: number) {
  const dx = Math.max(0, Math.abs(x) - 17.5), dz = Math.max(0, -32 - z, z - 14);
  const d = Math.hypot(dx, dz);
  // The land ducks under the slab and comes back through it at a shallow angle, so the join reads as one snowfield.
  let h = -0.35 + smooth(0, 2.4, d) * 0.37 + smooth(1.8, 6.5, d) * 0.43;
  h += (fbm2(x * 0.045, z * 0.045, 3) - 0.5) * 3.4 * smooth(2, 26, d);
  const r = Math.hypot(x, z + 9);
  const ridge = 1 - Math.abs(fbm2(x * 0.0125 + 5, z * 0.0125 + 9, 11) * 2 - 1);
  // A saddle straight down range keeps the view open into the fog.
  const saddle = 0.4 + 0.6 * smooth(0.05, 0.6, Math.abs(Math.atan2(x, -(z + 9))));
  // Secondary arêtes and gullies break the big ridges into a skyline.
  const spur = 1 - Math.abs(fbm2(x * 0.043 + 31, z * 0.043 + 7, 71, 3) * 2 - 1);
  h += smooth(40, 118, r) * (5 + ridge * ridge * 66 + fbm2(x * 0.05, z * 0.05, 23) * 9 + spur * spur * 15 * (0.3 + ridge)) * saddle;
  return h;
}

/** The land as one grid, finer near the yard; steep faces show rock through the snow. */
function terrainGeometry(n: number) {
  const reach = 250;
  const positions = new Float32Array((n + 1) * (n + 1) * 3), uvs = new Float32Array((n + 1) * (n + 1) * 2);
  const warp = (t: number) => Math.sign(t) * Math.pow(Math.abs(t), 1.75) * reach;
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) {
    const index = j * (n + 1) + i, x = warp(i / n * 2 - 1), z = warp(j / n * 2 - 1) - 9;
    positions[index * 3] = x; positions[index * 3 + 1] = terrainHeight(x, z); positions[index * 3 + 2] = z;
    [uvs[index * 2], uvs[index * 2 + 1]] = snowUv(x, z);
  }
  const indices: number[] = [];
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normal = geometry.attributes.normal, colours = new Float32Array((n + 1) * (n + 1) * 3);
  for (let i = 0; i < normal.count; i += 1) {
    const x = positions[i * 3], z = positions[i * 3 + 2];
    const rock = smooth(0.3, 0.52, 1 - normal.getY(i) + (fbm2(x * 0.09, z * 0.09, 41) - 0.5) * 0.22);
    const tone = 0.9 + fbm2(x * 0.02, z * 0.02, 57) * 0.1;
    colours[i * 3] = THREE.MathUtils.lerp(tone, 0.2, rock);
    colours[i * 3 + 1] = THREE.MathUtils.lerp(tone, 0.215, rock);
    colours[i * 3 + 2] = THREE.MathUtils.lerp(tone, 0.25, rock);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return geometry;
}

/**
 * A wind-packed drift along x, `width` deep on z. `crest` places the ridge across the width (1 piles it against
 * whatever stands on the +z side). The foot leaves the ground at no angle at all and ends a hair under it, so the
 * drift has no edge.
 */
function driftGeometry(length: number, width: number, height: number, seed: number, crest = 0.5) {
  const geometry = new THREE.PlaneGeometry(length, width, Math.max(10, Math.round(length / 0.36)), 14);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), z = position.getZ(i);
    const u = x / length + 0.5, v = z / width + 0.5;
    // The ridge wanders along the drift instead of running dead straight.
    const wander = (fbm2(u * length * 0.42 + seed, seed * 0.37, seed, 2) - 0.5) * (crest > 0.85 ? 0.05 : 0.24);
    const ridge = Math.min(0.97, Math.max(0.1, crest + wander));
    const t = v <= ridge ? v / ridge : (1 - v) / (1 - ridge);
    const across = Math.pow(smooth(0, 1, t), 1.4) * (1 + 0.12 * Math.pow(t, 6));
    const ends = Math.pow(smooth(0, 0.22, u) * smooth(0, 0.22, 1 - u), 1.25);
    const lump = 0.62 + 0.6 * fbm2(x * 0.5 + seed, z * 0.8 + seed * 1.7, seed, 3);
    position.setY(i, height * across * ends * lump - 0.012);
  }
  return geometry;
}

/**
 * Settled snow over a w x d footprint, h deep: a lumpy top that rolls over the edge, bulges past it here and
 * there and tucks back underneath. Closed below and centred like a box of the same size.
 */
function snowCapGeometry(w: number, h: number, d: number, seed: number) {
  const roll = Math.min(h * 0.95, w * 0.32, d * 0.32), lip = Math.min(h * 0.55, roll * 1.4, 0.11);
  const cell = Math.min(0.42, Math.max(0.14, Math.max(w, d) / 28));
  type Stop = { c: number; k: number; s: number };
  const stops = (size: number) => {
    const inner = size / 2 - roll, count = Math.max(1, Math.ceil(inner * 2 / cell)), list: Stop[] = [];
    for (let k = 5; k >= 1; k -= 1) list.push({ c: -inner, k, s: -1 });
    for (let i = 0; i <= count; i += 1) list.push({ c: -inner + inner * 2 * i / count, k: 0, s: 0 });
    for (let k = 1; k <= 5; k += 1) list.push({ c: inner, k, s: 1 });
    return list;
  };
  const xs = stops(w), zs = stops(d), nx = xs.length, nz = zs.length;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1) {
    const a = xs[i], b = zs[j], ring = Math.max(a.k, b.k);
    let x = a.c, y = h, z = b.c;
    if (ring > 0) {
      // Rings wrap the corner: the angle around it runs evenly along each ring.
      const turn = a.k >= b.k ? Math.PI / 4 * (b.k / a.k) : Math.PI / 2 - Math.PI / 4 * (a.k / b.k);
      const dx = a.s * Math.cos(turn), dz = b.s * Math.sin(turn);
      const rimX = a.c + dx * roll, rimZ = b.c + dz * roll;
      const reach = lip * smooth(0.3, 0.72, noise2(rimX * 1.9 + seed, rimZ * 1.9 - seed, seed)) + 0.004;
      const waist = h * (0.3 + 0.2 * noise2(rimX * 1.3 + seed * 3.7, rimZ * 1.3, seed + 3));
      const out = [0, 0.5 * roll + 0.4 * reach, 0.87 * roll + 0.75 * reach, roll + reach, roll + 0.75 * reach, roll + 0.1 * reach][ring];
      y = [h, waist + (h - waist) * 0.87, waist + (h - waist) * 0.5, waist, waist * 0.3, 0][ring];
      x += dx * out; z += dz * out;
    }
    if (ring <= 2) y += h * 0.44 * (fbm2(x * 2.3 + seed, z * 2.3 - seed, seed, 3) - 0.5) * [1, 0.7, 0.3][ring];
    positions.push(x, y - h / 2, z);
    uvs.push((x + y * 0.5) / SNOW_TILE + seed * 0.37, (z + y * 0.5) / SNOW_TILE);
  }
  for (let j = 0; j < nz - 1; j += 1) for (let i = 0; i < nx - 1; i += 1) {
    const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
    indices.push(a, c, b, b, c, e);
  }
  // Underside: a fan over the foot of the outermost ring, on vertices of its own so the lip keeps a crisp edge.
  const foot: number[] = [];
  for (let i = 0; i < nx; i += 1) foot.push(i);
  for (let j = 1; j < nz; j += 1) foot.push(j * nx + nx - 1);
  for (let i = nx - 2; i >= 0; i -= 1) foot.push((nz - 1) * nx + i);
  for (let j = nz - 2; j >= 1; j -= 1) foot.push(j * nx);
  const first = positions.length / 3;
  positions.push(0, -h / 2, 0); uvs.push(seed * 0.37, 0);
  for (const index of foot) { positions.push(positions[index * 3], -h / 2, positions[index * 3 + 2]); uvs.push(uvs[index * 2], uvs[index * 2 + 1]); }
  for (let k = 0; k < foot.length; k += 1) indices.push(first, first + 1 + k, first + 1 + (k + 1) % foot.length);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Where people and machines actually go in the yard. Shared by the soft wear map and the modelled tracks. */
const ROUTES = {
  ride: [[9.4, -4.5], [7.6, -4.3], [5.4, -2.3], [2.4, 0.6], [-2.5, 2.6], [-6.6, 4.6], [-9.5, 5.5]] as Array<[number, number]>,
  drags: [
    [[-8.3, -15.2], [-7.4, -12.2], [-7.9, -8.2], [-8.3, -4.6], [-7.6, -1.2], [-6.2, 2.2], [-7.8, 4.4]],
    [[8.45, -20.3], [7.75, -19], [7.5, -17.4], [7.9, -15.2], [7.6, -9.2], [7.9, -6.6]],
  ] as Array<Array<[number, number]>>,
  walks: [
    [[[-9.1, -3.9], [-7.6, -3.3], [-5.9, -2.4], [-3.2, 1.4], [-0.8, 4.4], [0, 6.6]], 3],
    [[[0, 6.4], [0.3, 2], [0.2, -3], [0.1, -5.2]], 4],
    [[[0.6, 6.2], [3.2, 1.4], [4.6, -2.6], [5.2, -3.4]], 3],
    [[[-0.6, 6], [-3.6, 0.6], [-5, -2.8]], 2],
    [[[-2.8, -6], [-1.9, -11], [-3.2, -15.2]], 2],
    [[[2.8, -6.2], [2, -11.4], [3.2, -15.2]], 2],
    [[[-1.6, -18.4], [-0.6, -20.6], [0, -22.4]], 3],
    [[[1.7, -18.4], [0.7, -20.4], [0.2, -22.6]], 2],
    [[[0, -10.8], [0.2, -15], [0, -22]], 3],
    [[[8.9, -7.8], [7.4, -7.2], [6.9, -4.4], [7.6, -2.1]], 2],
    [[[-9, -3.6], [-8.1, -8], [-7.4, -13.4], [-6.6, -17]], 2],
    [[[8.7, 8.6], [6.2, 7.6], [2.4, 7]], 2],
  ] as Array<[Array<[number, number]>, number]>,
};
const routeCurve = (points: Array<[number, number]>) => new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));

/** Packed, greyed snow where the yard is walked and driven: the soft layer under the modelled prints and tracks. */
function wearTexture(width: number, depth: number, zTop: number) {
  const W = 1024, H = 2048;
  return canvasTexture(W, H, (context) => {
    const px = (x: number) => (x + width / 2) / width * W, py = (z: number) => (z - zTop) / depth * H;
    const metre = W / width;
    const patch = (x: number, z: number, radius: number, alpha: number) => {
      const gradient = context.createRadialGradient(px(x), py(z), 0, px(x), py(z), radius * metre);
      gradient.addColorStop(0, `rgba(150,168,196,${alpha})`);
      gradient.addColorStop(0.7, `rgba(150,168,196,${alpha * 0.6})`);
      gradient.addColorStop(1, "rgba(150,168,196,0)");
      context.fillStyle = gradient;
      context.fillRect(px(x - radius), py(z - radius), radius * 2 * metre, radius * 2 * metre);
    };
    for (const [x, z] of [[-5.5, -6], [0, -8], [5.5, -6], [-4, -18], [4, -18]]) patch(x, z, 3.7, 0.2);
    patch(0, 6.4, 4.2, 0.2); patch(-3.2, 5.2, 3, 0.12); patch(3.4, 5.6, 3, 0.12); patch(0, -22.6, 4.4, 0.16);
    // A broad, soft stain along every route: many passes blur into a path.
    const stain = (points: Array<[number, number]>, lineWidth: number, alpha: number) => {
      const line = routeCurve(points).getSpacedPoints(60);
      context.lineCap = "round"; context.lineJoin = "round";
      for (const [scale, share] of [[1, 0.35], [0.62, 0.35], [0.3, 0.3]]) {
        context.beginPath();
        line.forEach((point, index) => { if (index) context.lineTo(px(point.x), py(point.z)); else context.moveTo(px(point.x), py(point.z)); });
        context.lineWidth = lineWidth * scale * metre; context.strokeStyle = `rgba(138,156,188,${alpha * share})`;
        context.stroke();
      }
    };
    stain(ROUTES.ride, 2.0, 0.3);
    for (const drag of ROUTES.drags) stain(drag, 1.1, 0.22);
    for (const [walk, passes] of ROUTES.walks) stain(walk, 1.0, 0.07 * passes);
  });
}

/** Blurs a height field in place; `wrapY` keeps a tile seamless along y. */
function blurHeights(heights: Float32Array, width: number, height: number, radius: number, wrapY: boolean) {
  const pass = new Float32Array(heights.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += heights[y * width + Math.min(width - 1, Math.max(0, x + k))];
    pass[y * width + x] = sum / (radius * 2 + 1);
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += pass[(wrapY ? (y + k + height) % height : Math.min(height - 1, Math.max(0, y + k))) * width + x];
    heights[y * width + x] = sum / (radius * 2 + 1);
  }
}

/**
 * Colour and normal maps for something pressed into snow. `draw` paints height into a canvas (mid grey is the
 * untouched surface, darker is deeper, lighter is thrown up); the hollows come out blue with shadow, the rims pale.
 */
function pressedSnow(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void, relief: number, wrapY = false) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "rgb(128,128,128)"; context.fillRect(0, 0, width, height);
  draw(context);
  const source = context.getImageData(0, 0, width, height).data, heights = new Float32Array(width * height);
  for (let i = 0; i < heights.length; i += 1) heights[i] = source[i * 4] / 255 - 128 / 255;
  blurHeights(heights, width, height, 1, wrapY);
  const colour = context.createImageData(width, height), bump = context.createImageData(width, height);
  const at = (x: number, y: number) => heights[(wrapY ? (y + height) % height : Math.min(height - 1, Math.max(0, y))) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4, h = heights[y * width + x];
    // Texture v runs up the canvas, so the y slope flips.
    const nx = -(at(x + 1, y) - at(x - 1, y)) * relief, ny = (at(x, y + 1) - at(x, y - 1)) * relief, scale = 1 / Math.hypot(nx, ny, 1);
    bump.data[i] = (nx * scale * 0.5 + 0.5) * 255; bump.data[i + 1] = (ny * scale * 0.5 + 0.5) * 255; bump.data[i + 2] = (scale * 0.5 + 0.5) * 255; bump.data[i + 3] = 255;
    const deep = Math.min(1, Math.max(0, -h / 0.3)), proud = Math.min(1, Math.max(0, h / 0.16));
    colour.data[i] = 238 - deep * 64; colour.data[i + 1] = 243 - deep * 50; colour.data[i + 2] = 251 - deep * 30;
    colour.data[i + 3] = Math.min(1, Math.max(deep * 1.5, proud * 0.9, Math.hypot(nx, ny) * 0.8)) * 255;
  }
  const texture = (image: ImageData, srgb: boolean) => {
    const target = document.createElement("canvas");
    target.width = width; target.height = height;
    target.getContext("2d")!.putImageData(image, 0, 0);
    const result = new THREE.CanvasTexture(target);
    if (srgb) result.colorSpace = THREE.SRGBColorSpace;
    if (wrapY) result.wrapT = THREE.RepeatWrapping;
    return result;
  };
  return { map: texture(colour, true), normalMap: texture(bump, false) };
}

const grey = (level: number) => `rgb(${level},${level},${level})`;

/** One boot print, toe toward the top: lugged sole and heel, snow squeezed up around the edge. */
function bootPrint() {
  return pressedSnow(128, 256, (c) => {
    const sole = (grow: number, level: number) => {
      c.fillStyle = grey(level);
      c.beginPath(); c.ellipse(64, 92, 31 + grow, 62 + grow, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(64, 196, 25 + grow, 36 + grow, 0, 0, Math.PI * 2); c.fill();
      c.fillRect(64 - 22 - grow, 120, 44 + grow * 2, 60);
    };
    // Rim thrown up around the boot, highest at the toe.
    sole(14, 150); sole(7, 168);
    c.fillStyle = grey(186); c.beginPath(); c.ellipse(64, 34, 26, 12, 0, Math.PI, Math.PI * 2); c.fill();
    sole(0, 84); sole(-5, 60);
    // The arch bridges the gap between sole and heel.
    c.fillStyle = grey(96); c.fillRect(40, 150, 48, 14);
    // Lugs bite deeper than the sole between them.
    c.fillStyle = grey(30);
    for (let row = 0; row < 7; row += 1) {
      const y = 44 + row * 15, half = 24 - Math.abs(row - 3) * 1.5;
      for (const side of [-1, 1]) { c.save(); c.translate(64 + side * half * 0.5, y); c.rotate(side * 0.35); c.fillRect(-half * 0.42, -3.5, half * 0.84, 7); c.restore(); }
    }
    for (let row = 0; row < 3; row += 1) c.fillRect(46, 178 + row * 15, 36, 7);
    // Heel digs in at the back.
    c.fillStyle = grey(44); c.beginPath(); c.ellipse(64, 214, 20, 12, 0, 0, Math.PI); c.fill();
  }, 2.6);
}

/**
 * Three strips that tile along their length, side by side: a snowmobile's lugged track, the groove of a ski,
 * and the narrow cut of a sledge runner.
 */
function treadAtlas() {
  return pressedSnow(512, 256, (c) => {
    // Track, u 0..0.5: packed belt, ridges squeezed up either side, a row of bar lugs with a paddle every third.
    c.fillStyle = grey(156); c.fillRect(10, 0, 236, 256);
    c.fillStyle = grey(176); c.fillRect(22, 0, 16, 256); c.fillRect(218, 0, 16, 256);
    c.fillStyle = grey(86); c.fillRect(40, 0, 176, 256);
    for (let lug = 0; lug < 8; lug += 1) {
      const y = lug * 32 + 6;
      c.fillStyle = grey(lug % 3 === 0 ? 30 : 52);
      c.fillRect(48, y, 68, 12); c.fillRect(140, y, 68, 12);
      c.fillRect(110, y + 16, 36, 10);
      c.fillStyle = grey(110); c.fillRect(48, y - 4, 160, 3);
    }
    // Ski, u 0.5..0.75: a smooth trough with a keel line down the middle.
    c.fillStyle = grey(150); c.fillRect(268, 0, 104, 256);
    c.fillStyle = grey(170); c.fillRect(280, 0, 10, 256); c.fillRect(350, 0, 10, 256);
    c.fillStyle = grey(78); c.fillRect(292, 0, 56, 256);
    c.fillStyle = grey(50); c.fillRect(316, 0, 8, 256);
    // Runner, u 0.75..1: a narrow, deep cut.
    c.fillStyle = grey(148); c.fillRect(404, 0, 88, 256);
    c.fillStyle = grey(172); c.fillRect(424, 0, 10, 256); c.fillRect(462, 0, 10, 256);
    c.fillStyle = grey(40); c.fillRect(436, 0, 24, 256);
  }, 2.2, true);
}

/** Two caterpillar ruts leading out of the gate. */
function rutsTexture() {
  return canvasTexture(512, 1024, (context) => {
    for (const x of [112, 400]) {
      const gradient = context.createLinearGradient(x - 70, 0, x + 70, 0);
      gradient.addColorStop(0, "rgba(120,140,174,0)"); gradient.addColorStop(0.15, "rgba(255,255,255,.4)");
      gradient.addColorStop(0.28, "rgba(120,140,174,.42)"); gradient.addColorStop(0.72, "rgba(120,140,174,.42)");
      gradient.addColorStop(0.85, "rgba(255,255,255,.4)"); gradient.addColorStop(1, "rgba(120,140,174,0)");
      context.fillStyle = gradient;
      context.fillRect(x - 70, 0, 140, 1024);
      context.fillStyle = "rgba(84,104,142,.34)";
      for (let y = 0; y < 1024; y += 22) context.fillRect(x - 40, y, 80, 9);
    }
    // Fade both ends so the decal has no edge.
    context.globalCompositeOperation = "destination-in";
    const fade = context.createLinearGradient(0, 0, 0, 1024);
    fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(0.2, "rgba(0,0,0,1)"); fade.addColorStop(0.85, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = fade;
    context.fillRect(0, 0, 512, 1024);
  });
}

/** A lit room seen through double glazing: lamp glow, blinds or shelving, frost creeping in from the corners. */
function windowTexture(variant: number) {
  return canvasTexture(512, 512, (context) => {
    context.scale(2, 2);
    const next = rng(71 + variant * 37);
    const cool = variant === 2;
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, cool ? "#fff0cf" : "#ffd79a"); gradient.addColorStop(1, cool ? "#e9c58c" : "#f0974a");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    // The lamp itself.
    const lampX = 60 + next() * 136, lamp = context.createRadialGradient(lampX, 70, 0, lampX, 70, 120);
    lamp.addColorStop(0, "rgba(255,250,226,.95)"); lamp.addColorStop(1, "rgba(255,250,226,0)");
    context.fillStyle = lamp;
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = "rgba(60,30,14,.6)";
    if (variant === 0) {
      // A blind drawn part of the way.
      const drop = 70 + next() * 70;
      context.fillStyle = "rgba(120,62,24,.42)";
      context.fillRect(0, 0, 256, drop);
      context.fillStyle = "rgba(60,30,14,.3)";
      for (let y = 6; y < drop; y += 12) context.fillRect(0, y, 256, 3);
    } else if (variant === 1) {
      // Shelving and whatever is stacked on it.
      for (const y of [112, 176]) context.fillRect(0, y, 256, 7);
      for (let i = 0; i < 9; i += 1) { const w = 12 + next() * 24, h = 18 + next() * 36, x = next() * 230, shelf = next() < 0.5 ? 112 : 176; context.fillRect(x, shelf - h, w, h); }
    } else {
      // A desk, a chair back and a screen.
      context.fillRect(0, 200, 256, 56);
      context.fillRect(150, 150, 46, 60);
      context.fillStyle = "rgba(150,236,224,.85)";
      context.fillRect(44, 150, 62, 40);
    }
    // Mullions.
    context.fillStyle = "#1a1d21";
    context.fillRect(124, 0, 8, 256); context.fillRect(0, 0, 256, 6); context.fillRect(0, 250, 256, 6); context.fillRect(0, 0, 6, 256); context.fillRect(250, 0, 6, 256);
    // Frost.
    for (const [x, y, radius] of [[0, 256, 120], [256, 256, 105], [0, 0, 60], [256, 0, 70], [128, 256, 50]]) {
      const frost = context.createRadialGradient(x, y, 0, x, y, radius);
      frost.addColorStop(0, "rgba(236,244,255,.85)"); frost.addColorStop(0.55, "rgba(236,244,255,.3)"); frost.addColorStop(1, "rgba(236,244,255,0)");
      context.fillStyle = frost;
      context.fillRect(0, 0, 256, 256);
    }
  });
}

/** An unlit window: dark glass holding a pale reflection of the sky. */
function darkWindowTexture() {
  return canvasTexture(512, 512, (context) => {
    context.scale(4, 4);
    const gradient = context.createLinearGradient(0, 0, 128, 128);
    gradient.addColorStop(0, "#56677a"); gradient.addColorStop(0.45, "#27323f"); gradient.addColorStop(1, "#141b24");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = "#15181c";
    context.fillRect(61, 0, 6, 128); context.fillRect(0, 0, 128, 4); context.fillRect(0, 124, 128, 4); context.fillRect(0, 0, 4, 128); context.fillRect(124, 0, 4, 128);
    for (const [x, y, radius] of [[0, 128, 70], [128, 128, 60]]) {
      const frost = context.createRadialGradient(x, y, 0, x, y, radius);
      frost.addColorStop(0, "rgba(226,236,250,.8)"); frost.addColorStop(1, "rgba(226,236,250,0)");
      context.fillStyle = frost;
      context.fillRect(0, 0, 128, 128);
    }
  });
}

/** The overcast: a bright patch, slow cloud structure, darker toward the far side. */

/** Dish reflector, concave toward -z, rim at z = 0. */
function dishGeometry(radius: number) {
  const sphere = radius / Math.sin(0.62);
  const geometry = new THREE.SphereGeometry(sphere, 32, 10, 0, Math.PI * 2, 0, 0.62);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, -sphere * Math.cos(0.62));
  return geometry;
}

/** Snow curled over an eave by the wind: runs along z, overhangs toward +x, sits on y = 0. */
function corniceGeometry(length: number, seed: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.75, 0); shape.lineTo(-0.75, 0.3);
  shape.splineThru([[-0.3, 0.4], [0.08, 0.4], [0.3, 0.27], [0.37, 0.08], [0.3, -0.07], [0.2, -0.1]].map(([x, y]) => new THREE.Vector2(x, y)));
  shape.lineTo(0.1, -0.02); shape.lineTo(0, 0); shape.closePath();
  const extruded = new THREE.ExtrudeGeometry(shape, { depth: length, steps: Math.max(4, Math.round(length / 0.45)), bevelEnabled: false, curveSegments: 8 });
  extruded.translate(0, 0, -length / 2);
  extruded.deleteAttribute("normal"); extruded.deleteAttribute("uv");
  const geometry = mergeVertices(extruded, 1e-4);
  const position = geometry.attributes.position, uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i += 1) {
    let x = position.getX(i), y = position.getY(i);
    const z = position.getZ(i);
    const reach = fbm2(z * 0.7 + seed, seed * 3.1, seed, 3), lump = fbm2(z * 1.9 + seed * 2, 1.7, seed + 5, 2);
    if (x > 0) x *= 0.35 + 1.3 * reach;
    if (y < 0) y *= 0.3 + 1.7 * lump; else if (y > 0.2) y += (lump - 0.5) * 0.16;
    position.setXY(i, x, y);
    uvs[i * 2] = z / 2.5; uvs[i * 2 + 1] = (x + y) / 2.5;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** A lump of ploughed snow, unit size. */
function clodGeometry(seed: number) {
  const base = new THREE.IcosahedronGeometry(1, 1);
  base.deleteAttribute("normal"); base.deleteAttribute("uv");
  const geometry = mergeVertices(base, 1e-4);
  const position = geometry.attributes.position, uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const k = 0.72 + 0.5 * fbm2(x * 1.7 + seed, z * 1.7 + y * 2.3, seed, 2);
    position.setXYZ(i, x * k, Math.max(-0.3, y * k * 0.8), z * k);
    uvs[i * 2] = x * 0.4; uvs[i * 2 + 1] = z * 0.4;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** A ski or sledge runner lying along z with an upturned tip at +z; its sole on y = 0. */
function skiGeometry(length: number, width: number, thickness: number, rise = 0.15) {
  const half = length / 2, t = thickness;
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0); shape.lineTo(half - 0.28, 0);
  shape.quadraticCurveTo(half - 0.08, 0.01, half, rise);
  shape.lineTo(half - 0.02, rise + t * 0.6);
  shape.quadraticCurveTo(half - 0.1, t + 0.02, half - 0.28, t);
  shape.lineTo(-half, t); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 6 });
  geometry.translate(0, 0, -width / 2);
  geometry.rotateY(-Math.PI / 2);
  return geometry;
}

/**
 * Plates, placards, papers and boards drawn into one sheet; `LABELS` names the regions in pixels.
 * The last three are sprayed straight onto a wall: clear around the letters, and kept 16 px away from any painted
 * region so that nothing bleeds into their edges in the smaller mip levels.
 */
const SHEET = 2048;
const LABELS = {
  plate: [0, 0, 1024, 512], diesel: [1024, 0, 1024, 512], generator: [0, 512, 512, 512],
  hab: [512, 512, 256, 256], workshop: [768, 512, 256, 256], livery: [512, 768, 256, 256], fire: [768, 768, 256, 256],
  map: [1024, 512, 512, 512], bulletin: [1536, 512, 512, 512],
  rifle: [0, 1024, 1024, 464], office: [0, 1760, 1008, 288], snowball: [1024, 1024, 640, 448], coop: [1024, 1472, 1024, 272],
  flag: [1696, 1040, 336, 208],
  iceworld: [0, 1504, 1008, 112], depot: [0, 1632, 1008, 112], rescue: [1024, 1760, 1008, 288],
} as const;
function labelTexture() {
  return canvasTexture(SHEET, SHEET, (c) => {
    const next = rng(4401);
    const FACE = "'Barlow Condensed', 'Arial Narrow', sans-serif";
    const INK = "#1b2126", RED = "#b3261a", ENAMEL = "#d9ddd8";
    const speckle = (x: number, y: number, w: number, h: number, count: number, tone: string) => {
      for (let i = 0; i < count; i += 1) { c.fillStyle = `rgba(${tone},${0.04 + next() * 0.1})`; c.fillRect(x + next() * w, y + next() * h, 1 + next() * 5, 1 + next() * 2); }
    };
    /** One line in the current fill, shrunk until it fits `width`. */
    const fit = (text: string, x: number, y: number, width: number, weight: number, size: number) => {
      let s = size + 1;
      do { s -= 1; c.font = `${weight} ${s}px ${FACE}`; } while (s > 8 && c.measureText(text).width > width);
      c.fillText(text, x, y);
    };
    /**
     * Stencil lettering in the current fill: spaced capitals with the bridges a cut stencil needs to hold its
     * counters. On a painted board the bridges take its `ground`; on bare wall they are cut clear.
     */
    const stencil = (text: string, x: number, y: number, width: number, size: number, ground: string | null) => {
      const ink = c.fillStyle, align = c.textAlign;
      let s = size + 1, run = 0;
      do { s -= 1; c.font = `700 ${s}px ${FACE}`; run = [...text].reduce((sum, glyph) => sum + c.measureText(glyph).width + s * 0.05, -s * 0.05); } while (s > 8 && run > width);
      let at = align === "center" ? x - run / 2 : x;
      c.textAlign = "left";
      for (const glyph of text) {
        const w = c.measureText(glyph).width;
        c.fillStyle = ink; c.fillText(glyph, at, y);
        if ("ABCDEGHOPQRSU0235689".includes(glyph)) {
          if (ground) c.fillStyle = ground; else c.globalCompositeOperation = "destination-out";
          c.fillRect(at + w / 2 - s * 0.028, y - s * 0.42, s * 0.056, s * 0.84);
          c.globalCompositeOperation = "source-over";
        }
        at += w + s * 0.05;
      }
      c.fillStyle = ink; c.textAlign = align;
    };
    /**
     * Paint from a can has one colour. Chip it, then give each sprayed region that colour throughout, so the cut-out
     * edges do not fringe dark. The regions share the strip below `top`, which is read back once.
     */
    const sprayed = (regions: ReadonlyArray<readonly number[]>, top: number, ink: [number, number, number]) => {
      c.globalCompositeOperation = "destination-out";
      for (const [x, y, w, h] of regions) for (let i = 0; i < w * h / 700; i += 1) { c.fillStyle = `rgba(0,0,0,${0.6 + next() * 0.4})`; c.fillRect(x + next() * w, y + next() * h, 1 + next() * 6, 1 + next() * 3); }
      c.globalCompositeOperation = "source-over";
      const image = c.getImageData(0, top, SHEET, SHEET - top), data = image.data;
      for (const [x, y, w, h] of regions) {
        for (let row = y - top; row < y - top + h; row += 1) for (let i = (row * SHEET + x) * 4; i < (row * SHEET + x + w) * 4; i += 4) { data[i] = ink[0]; data[i + 1] = ink[1]; data[i + 2] = ink[2]; data[i + 3] = Math.max(24, data[i + 3]); }
        c.putImageData(image, 0, top, x, y - top, w, h);
      }
    };
    /** The depot's mark: a six-armed snow crystal, in the current stroke. */
    const crystal = (x: number, y: number, radius: number) => {
      c.save(); c.translate(x, y); c.lineCap = "round"; c.lineWidth = radius * 0.12;
      for (let arm = 0; arm < 6; arm += 1) {
        c.rotate(Math.PI / 3);
        c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -radius);
        for (const [at, reach] of [[0.42, 0.26], [0.7, 0.18]]) for (const side of [-1, 1]) { c.moveTo(0, -radius * at); c.lineTo(side * radius * reach, -radius * (at + reach)); }
        c.stroke();
      }
      c.restore();
    };
    /** A board of pale enamel with a ruled edge and a fixing in each corner. */
    const board = ([x, y, w, h]: readonly number[], ground = ENAMEL) => {
      c.fillStyle = ground; c.fillRect(x, y, w, h);
      c.strokeStyle = INK; c.lineWidth = 6; c.strokeRect(x + 14, y + 14, w - 28, h - 28);
      for (const [px, py] of [[x + 34, y + 34], [x + w - 34, y + 34], [x + 34, y + h - 34], [x + w - 34, y + h - 34]]) { c.fillStyle = "#8d948f"; c.beginPath(); c.arc(px, py, 7, 0, 7); c.fill(); c.fillStyle = "#3b423e"; c.fillRect(px - 5, py - 1, 10, 2); }
      speckle(x, y, w, h, w * h / 900, "60,70,80");
    };
    c.textBaseline = "middle"; c.textAlign = "center";
    // Station plate: enamel, white on deep green.
    c.fillStyle = "#12382f"; c.fillRect(0, 0, 1024, 512);
    c.strokeStyle = "#e9efe9"; c.lineWidth = 10; c.strokeRect(26, 26, 972, 460);
    c.lineWidth = 3; c.strokeRect(46, 46, 932, 420);
    c.fillStyle = "#eef3ee"; fit("ICEWORLD SUPPLY DEPOT", 512, 164, 860, 700, 132);
    c.fillRect(120, 252, 784, 5);
    fit("FY SECTOR  ·  ALT 1 337 M", 512, 312, 600, 600, 54);
    for (const x of [150, 874]) crystal(x, 312, 26);
    fit("ALL ARRIVALS REPORT TO THE BUY ZONE  ·  $800 ISSUED AT THE DOOR", 512, 392, 860, 500, 34);
    fit("NEXT SHELTER 16 KM  ·  KNIFE OUT, YOU RUN FASTER", 512, 436, 860, 500, 34);
    for (const [x, y] of [[66, 66], [958, 66], [66, 446], [958, 446]]) { c.fillStyle = "#9aa39c"; c.beginPath(); c.arc(x, y, 9, 0, 7); c.fill(); c.fillStyle = "#39413c"; c.fillRect(x - 6, y - 1, 12, 2); }
    speckle(0, 0, 1024, 512, 500, "255,255,255");
    // Fuel placard.
    c.fillStyle = "#e8e4d6"; c.fillRect(1024, 0, 1024, 512);
    c.fillStyle = "#c9321c"; c.fillRect(1024, 0, 1024, 96); c.fillRect(1024, 452, 1024, 60);
    c.fillStyle = "#f4efe2"; fit("FLAMMABLE LIQUID  ·  DO NOT WALLBANG", 1536, 50, 960, 700, 64);
    c.fillStyle = "#16181a"; c.textAlign = "left";
    fit("DIESEL", 1290, 186, 720, 700, 120);
    fit("ARCTIC GRADE  ·  COLD AS AN ECO ROUND", 1290, 280, 720, 600, 58);
    fit("TANK T-1  ·  MAX 16 000 L  ·  IT CAPS THERE, SO SPEND IT", 1290, 350, 720, 500, 38);
    fit("REFUEL IN FREEZE TIME ONLY  ·  DIP DAILY", 1290, 402, 720, 500, 38);
    c.save(); c.translate(1160, 276); c.rotate(Math.PI / 4);
    c.fillStyle = "#c9321c"; c.fillRect(-84, -84, 168, 168); c.strokeStyle = "#16181a"; c.lineWidth = 6; c.strokeRect(-84, -84, 168, 168); c.restore();
    c.fillStyle = "#16181a"; c.beginPath(); c.moveTo(1160, 216); c.bezierCurveTo(1206, 262, 1196, 318, 1160, 326); c.bezierCurveTo(1124, 318, 1128, 286, 1146, 268); c.bezierCurveTo(1150, 252, 1150, 236, 1160, 216); c.fill();
    c.textAlign = "center"; c.fillStyle = "#f4efe2"; fit("LOSS BONUS DOES NOT COVER SPILLS", 1536, 482, 960, 600, 34);
    speckle(1024, 0, 1024, 512, 600, "60,40,20");
    // Generator warning.
    c.fillStyle = "#e3b21c"; c.fillRect(0, 512, 512, 512);
    c.strokeStyle = "#16181a"; c.lineWidth = 12; c.strokeRect(16, 528, 480, 480);
    c.fillStyle = "#16181a"; c.beginPath(); c.moveTo(256, 566); c.lineTo(392, 800); c.lineTo(120, 800); c.closePath(); c.fill();
    c.fillStyle = "#e3b21c"; c.beginPath(); c.moveTo(270, 628); c.lineTo(226, 716); c.lineTo(258, 716); c.lineTo(240, 782); c.lineTo(296, 692); c.lineTo(262, 692); c.closePath(); c.fill();
    c.fillStyle = "#16181a"; fit("64 TICK GENERATOR", 256, 860, 430, 700, 76);
    fit("DO NOT UPGRADE", 256, 924, 430, 600, 52);
    fit("IT WAS NEVER THE TICKRATE", 256, 974, 430, 500, 32);
    speckle(0, 512, 512, 512, 400, "40,30,10");
    // Small tiles.
    const tile = (x: number, y: number, ground: string, ink: string, big: string, small: string) => {
      c.fillStyle = ground; c.fillRect(x, y, 256, 256);
      c.strokeStyle = ink; c.lineWidth = 6; c.strokeRect(x + 14, y + 14, 228, 228);
      c.fillStyle = ink; fit(big, x + 128, y + 112, 200, 700, 104); fit(small, x + 128, y + 196, 200, 600, 26);
      speckle(x, y, 256, 256, 120, "255,255,255");
    };
    tile(512, 512, "#1c2530", "#e8edf2", "HAB 1.6", "NO UPDATES SINCE 2003");
    tile(768, 512, "#1c2530", "#e8edf2", "WORKSHOP", "SUBMISSIONS WELCOME");
    tile(512, 768, "#d8dde2", "#16181a", "CAR", "LONG A MOTOR POOL");
    tile(768, 768, "#b3261a", "#f6efe6", "FIRE", "HE'S LIT, 90 · USE THIS");
    // Survey map.
    c.save(); c.beginPath(); c.rect(1024, 512, 512, 512); c.clip();
    c.fillStyle = "#e9e4d2"; c.fillRect(1024, 512, 512, 512);
    c.strokeStyle = "rgba(120,96,60,.55)"; c.lineWidth = 1.5;
    for (let ring = 0; ring < 22; ring += 1) {
      c.beginPath();
      for (let a = 0; a <= 64; a += 1) {
        const t = a / 64 * Math.PI * 2, r = 20 + ring * 13 + Math.sin(t * 3 + ring * 0.4) * (10 + ring) + Math.cos(t * 5 - ring * 0.2) * 7;
        const x = 1250 + Math.cos(t) * r * 1.2, y = 760 + Math.sin(t) * r;
        if (a) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke();
    }
    c.strokeStyle = "rgba(60,110,170,.35)"; c.lineWidth = 1;
    for (let g = 0; g <= 8; g += 1) { c.beginPath(); c.moveTo(1024 + g * 64, 512); c.lineTo(1024 + g * 64, 1024); c.moveTo(1024, 512 + g * 64); c.lineTo(1536, 512 + g * 64); c.stroke(); }
    c.fillStyle = "rgba(96,150,200,.5)"; c.beginPath(); c.ellipse(1436, 846, 44, 22, -0.3, 0, 7); c.fill();
    c.strokeStyle = "#c9321c"; c.lineWidth = 4; c.setLineDash([12, 8]);
    c.beginPath(); c.moveTo(1080, 980); c.bezierCurveTo(1076, 850, 1180, 760, 1290, 770); c.bezierCurveTo(1340, 690, 1420, 660, 1490, 560); c.stroke();
    c.strokeStyle = "#1c1c1c"; c.lineWidth = 3; c.setLineDash([4, 7]);
    c.beginPath(); c.moveTo(1080, 980); c.lineTo(1290, 770); c.stroke(); c.setLineDash([]);
    c.fillStyle = "#c9321c"; c.beginPath(); c.arc(1290, 770, 9, 0, 7); c.fill();
    c.fillStyle = "#1c1c1c"; c.font = `700 22px ${FACE}`; c.textAlign = "left";
    c.fillText("ICEWORLD DEPOT", 1304, 756); c.fillText("MT. ANUBIS  3 112", 1150, 622); c.fillText("SHEET FY-07  ·  1:25 000  ·  NO RADAR COVERAGE", 1040, 540);
    c.fillText("LONG", 1068, 846); c.fillText("SHORT", 1196, 902); c.fillText("POOL DAY (FROZEN)", 1362, 886);
    c.fillStyle = "rgba(40,84,130,.9)"; c.font = `italic 600 22px ${FACE}`;
    c.fillText("ANCIENT GLACIER", 1050, 690); c.fillText("AZTEC ICEFALL", 1390, 706); c.fillText("COBBLE MORAINE", 1316, 972);
    c.restore(); c.textAlign = "center";
    // Bulletin sheet.
    c.fillStyle = "#f1eee6"; c.fillRect(1536, 512, 512, 512);
    c.fillStyle = "#c9321c"; c.fillRect(1536, 512, 512, 70);
    c.fillStyle = "#f6efe6"; fit("FROSTBITE BULLETIN", 1792, 548, 460, 700, 42);
    c.fillStyle = "#1c1c1c"; c.textAlign = "left";
    fit("EXPOSED SKIN AT −44 °C, BY TIME OUTSIDE", 1560, 599, 460, 600, 21);
    const rows: Array<[string, number, string]> = [["2 MIN  ·  MINIMAL WEAR", 2, "#e3b21c"], ["10 MIN  ·  FIELD-TESTED", 3, "#e07a1c"], ["30 MIN  ·  BATTLE-SCARRED", 5, "#c9321c"]];
    rows.forEach(([name, level, tone], row) => {
      const y = 634 + row * 60;
      c.fillStyle = "#1c1c1c"; fit(name, 1560, y, 226, 600, 26);
      for (let step = 0; step < 5; step += 1) { c.fillStyle = step < level ? tone : "#d4d0c6"; c.fillRect(1800 + step * 44, y - 18, 38, 36); }
    });
    c.fillStyle = "#1c1c1c";
    [
      "VISIBILITY: ONE SMOKE. IT DOES NOT FADE AFTER 18 S.", "WHITE CROSSHAIRS: CHANGE COLOUR BEFORE GOING OUT.", "SHIFT-WALK UNDER THE CORNICE. RUNNING IS HEARD.", "",
      "DUTY ROTA  ·  MR12, SIDES SWAP AT THE HALF", "MON  SNOW CLEARING .... ENTRY FRAGGER", "TUE  RADIO ................. IGL", "WED  MET OBS ............. LURKER (IF FOUND)",
      "THU  FUEL DIP ............. SUPPORT, AS ALWAYS", "FRI  COOKING .............. BOTTOM FRAG",
    ].forEach((line, index) => fit(line, 1560, 808 + index * 22, 464, 500, 21));
    c.textAlign = "center";
    speckle(1536, 512, 512, 512, 240, "90,80,60");
    // Armoury notice.
    board(LABELS.rifle);
    c.fillStyle = INK; stencil("AWP", 222, 1172, 360, 250, ENAMEL);
    c.fillRect(430, 1076, 8, 190);
    stencil("ARCTIC", 716, 1118, 520, 118, ENAMEL); stencil("WARFARE", 716, 1226, 520, 118, ENAMEL);
    c.fillStyle = RED; c.fillRect(60, 1294, 904, 6);
    stencil("IT WAS IN THE NAME.", 512, 1350, 880, 80, ENAMEL);
    c.fillStyle = INK; fit("FINALLY IN ITS NATURAL HABITAT  ·  ONE PER SQUAD  ·  BOLT MAY FREEZE", 512, 1410, 880, 500, 28);
    fit("ICEWORLD SUPPLY DEPOT  ·  ARMOURY NOTICE No 4750", 512, 1446, 880, 500, 19);
    // Office block.
    board(LABELS.office);
    c.fillStyle = INK; stencil("CS_OFFICE", 504, 1854, 920, 180, ENAMEL);
    c.fillStyle = RED; stencil("SNOWED IN SINCE 1999", 504, 1956, 900, 72, ENAMEL);
    c.fillStyle = INK; fit("PLEASE STOP SHOOTING THE VENDING MACHINE", 504, 2010, 900, 500, 26);
    // Morale notice.
    board(LABELS.snowball, "#e4e1d6");
    c.fillStyle = "#c8641c"; c.fillRect(1038, 1038, 612, 112);
    c.fillStyle = "#f6f1e6"; stencil("SNOWBALL FIGHTS", 1344, 1096, 570, 96, "#c8641c");
    c.fillStyle = INK; stencil("12:00 – 14:00", 1344, 1222, 560, 150, "#e4e1d6");
    fit("DAILY  ·  WARMUP FROM 11:55", 1344, 1304, 560, 600, 36);
    c.fillStyle = RED; c.fillRect(1074, 1336, 540, 4);
    c.fillStyle = INK; fit("FULL BUY: $0  ·  NO HEADSHOT MULTIPLIER", 1344, 1370, 560, 500, 30);
    fit("FRIENDLY FIRE IS ON. IT ALWAYS WAS.", 1344, 1410, 560, 500, 30);
    fit("ICEWORLD SUPPLY DEPOT  ·  MORALE OFFICE", 1344, 1446, 560, 500, 18);
    // Coop board, with a hen in her jumper.
    board(LABELS.coop, "#e4e1d6");
    c.save(); c.translate(1168, 1618); c.scale(0.86, 0.86);
    c.fillStyle = INK;
    c.beginPath(); c.moveTo(-56, -10); c.lineTo(-104, -66); c.lineTo(-78, -6); c.lineTo(-110, -22); c.lineTo(-70, 16); c.closePath(); c.fill();
    c.beginPath(); c.ellipse(0, 0, 70, 52, 0, 0, 7); c.fill();
    c.beginPath(); c.moveTo(34, -30); c.lineTo(48, -84); c.lineTo(86, -84); c.lineTo(72, -14); c.closePath(); c.fill();
    c.beginPath(); c.arc(68, -86, 25, 0, 7); c.fill();
    c.fillRect(-22, 44, 8, 50); c.fillRect(14, 44, 8, 50); c.fillRect(-22, 88, 26, 7); c.fillRect(14, 88, 26, 7);
    c.fillStyle = RED;
    for (const [x, y] of [[54, -112], [68, -116], [82, -110]]) { c.beginPath(); c.arc(x, y, 9, 0, 7); c.fill(); }
    c.beginPath(); c.ellipse(86, -62, 7, 11, 0, 0, 7); c.fill();
    c.fillStyle = "#d98a1c"; c.beginPath(); c.moveTo(90, -94); c.lineTo(116, -84); c.lineTo(90, -76); c.closePath(); c.fill();
    c.fillStyle = "#e4e1d6"; c.beginPath(); c.arc(74, -92, 4, 0, 7); c.fill();
    // The jumper: a red body band with a pale zigzag, clipped to her.
    c.beginPath(); c.ellipse(0, 0, 70, 52, 0, 0, 7); c.clip();
    c.fillStyle = RED; c.fillRect(-50, -60, 92, 120);
    c.strokeStyle = "#e4e1d6"; c.lineWidth = 5; c.lineJoin = "miter";
    for (const y of [-22, 14]) { c.beginPath(); for (let i = 0; i <= 8; i += 1) { const x = -50 + i * 11.5, zig = y + (i % 2 ? -9 : 9); if (i) c.lineTo(x, zig); else c.moveTo(x, zig); } c.stroke(); }
    c.fillStyle = "#e4e1d6"; c.fillRect(-50, -60, 7, 120); c.fillRect(35, -60, 7, 120);
    c.restore();
    c.fillStyle = INK; stencil("CHICKEN COOP", 1660, 1556, 700, 150, "#e4e1d6");
    c.fillStyle = RED; stencil("JUMPERS PROVIDED", 1660, 1644, 700, 72, "#e4e1d6");
    c.fillStyle = INK; fit("PRESS E AND THEY FOLLOW YOU  ·  COUNT THEM BACK IN", 1660, 1704, 700, 500, 24);
    // Sprayed on the walls: the depot's name across the signal band, and the way out for the rescued.
    c.fillStyle = "#eef1ee";
    stencil("ICEWORLD", 504, 1562, 980, 132, null); stencil("SUPPLY DEPOT", 504, 1690, 980, 132, null);
    stencil("HOSTAGE RESCUE ZONE", 1528, 1846, 960, 120, null);
    c.beginPath(); c.moveTo(1060, 1966); c.lineTo(1136, 1916); c.lineTo(1136, 1950); c.lineTo(1400, 1950); c.lineTo(1400, 1982); c.lineTo(1136, 1982); c.lineTo(1136, 2016); c.closePath(); c.fill();
    stencil("HOSTAGES ARE NOT COVER", 1722, 1968, 560, 58, null);
    sprayed([LABELS.iceworld, LABELS.depot, LABELS.rescue], 1504, [238, 241, 238]);
    // The depot's flag: signal orange with a pine hoist, the crystal in white. Painted a little past its edges so
    // nothing dark bleeds in when it is seen small.
    {
      const [x, y, w, h] = LABELS.flag;
      c.fillStyle = "#c2501b"; c.fillRect(x - 12, y - 12, w + 24, h + 24);
      c.fillStyle = "#12382f"; c.fillRect(x - 12, y - 12, w * 0.22 + 12, h + 24);
      c.strokeStyle = "#dfe4df"; crystal(x + w * 0.6, y + h / 2, h * 0.34);
    }
  });
}

/** Photovoltaic cells behind glass. */
function solarTexture() {
  return canvasTexture(256, 256, (c) => {
    c.fillStyle = "#0a1220"; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6; i += 1) for (let j = 0; j < 4; j += 1) {
      const gradient = c.createLinearGradient(i * 42.6, j * 64, i * 42.6 + 42, j * 64 + 64);
      gradient.addColorStop(0, "#14284a"); gradient.addColorStop(1, "#0c1830");
      c.fillStyle = gradient; c.fillRect(i * 42.6 + 2, j * 64 + 2, 39, 60);
      c.fillStyle = "rgba(190,205,225,.5)"; c.fillRect(i * 42.6 + 14, j * 64 + 2, 1, 60); c.fillRect(i * 42.6 + 28, j * 64 + 2, 1, 60);
    }
  });
}

/** Double glazing: nearly clear, with fern frost grown in from the sill and the corners. */
function frostTexture() {
  const S = 1024;
  return canvasTexture(S, S, (c) => {
    c.clearRect(0, 0, S, S);
    c.fillStyle = "rgba(196,214,236,.08)"; c.fillRect(0, 0, S, S);
    const streak = c.createLinearGradient(0, 0, S, S);
    streak.addColorStop(0.3, "rgba(255,255,255,0)"); streak.addColorStop(0.42, "rgba(235,242,252,.14)"); streak.addColorStop(0.5, "rgba(255,255,255,0)");
    c.fillStyle = streak; c.fillRect(0, 0, S, S);
    for (const [x, y, radius, a] of [[0, S, 470, 0.9], [S, S, 420, 0.9], [0, 0, 220, 0.7], [S, 0, 260, 0.7], [S / 2, S, 250, 0.75]]) {
      const frost = c.createRadialGradient(x, y, 0, x, y, radius);
      frost.addColorStop(0, `rgba(238,245,255,${a})`); frost.addColorStop(0.5, `rgba(238,245,255,${a * 0.4})`); frost.addColorStop(1, "rgba(238,245,255,0)");
      c.fillStyle = frost; c.fillRect(0, 0, S, S);
    }
    // Fern frost: a stem, barbs off it, barbules off those.
    const next = rng(881);
    c.lineCap = "round";
    const fern = (x: number, y: number, angle: number, length: number, width: number, depth: number) => {
      const ex = x + Math.cos(angle) * length, ey = y + Math.sin(angle) * length;
      c.strokeStyle = `rgba(246,250,255,${0.2 + depth * 0.12})`; c.lineWidth = width;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo((x + ex) / 2 + Math.sin(angle) * length * 0.06, (y + ey) / 2 - Math.cos(angle) * length * 0.06, ex, ey); c.stroke();
      if (depth <= 0 || length < 9) return;
      const barbs = Math.floor(length / 8);
      for (let i = 1; i < barbs; i += 1) {
        const t = i / barbs, side = i % 2 ? 1 : -1;
        fern(x + (ex - x) * t, y + (ey - y) * t, angle + side * (0.95 + next() * 0.25), length * (0.44 - t * 0.27) * (0.7 + next() * 0.5), Math.max(0.8, width * 0.62), depth - 1);
      }
    };
    for (let i = 0; i < 54; i += 1) {
      const pick = next();
      if (pick < 0.55) fern(next() * S, S + 4, -Math.PI / 2 + (next() - 0.5) * 1.1, 110 + next() * 230, 2.6, 2);
      else if (pick < 0.8) { const left = next() < 0.5; fern(left ? -4 : S + 4, S * (0.45 + next() * 0.55), (left ? 0 : Math.PI) + (next() - 0.5) * 0.9, 90 + next() * 190, 2.4, 2); }
      else { const left = next() < 0.5; fern(left ? -4 : S + 4, next() * S * 0.3, (left ? 0.5 : Math.PI - 0.5) + (next() - 0.5) * 0.6, 70 + next() * 110, 2, 2); }
    }
    // Rime grain, thickest along the sill.
    for (let i = 0; i < 5200; i += 1) { c.fillStyle = `rgba(246,250,255,${next() * 0.4})`; const y = S - Math.pow(next(), 2.2) * S * 0.62; c.fillRect(next() * S, y, 1 + next() * 2.5, 1 + next() * 5); }
  });
}

/** Snow lying over a barrel roof or a tank (axis along z): deepest on the crown, feathered to nothing at its edge. */
function snowSaddle(radius: number, length: number, arc: number, thick: number, seed: number) {
  const geometry = new THREE.PlaneGeometry(1, 1, 14, Math.max(6, Math.round(length / 0.5))), position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) {
    const s = position.getX(i) * 2, t = position.getY(i) * 2, angle = s * arc, z = t * length / 2;
    const feather = Math.pow(Math.max(0, Math.cos(s * Math.PI / 2)), 0.7) * Math.pow(Math.max(0, Math.cos(t * Math.PI / 2)), 0.35);
    const r = radius - 0.02 + thick * feather * (0.7 + 0.6 * fbm2(angle * radius * 0.9 + seed, z * 0.6, seed, 3));
    position.setXYZ(i, Math.sin(angle) * r, Math.cos(angle) * r, -z);
    uv.setXY(i, angle * radius / SNOW_TILE, z / SNOW_TILE);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// ---- Snow shading ----------------------------------------------------------
// Everything white shares one description of what the wind has done to it, evaluated in world space so
// the slab, the land, the drifts and the caps on every ledge line up without a seam.
let snowOctaves = 4;
const snowGlsl = () => /* glsl */`
  float snowHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float snowNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(snowHash(i), snowHash(i + vec2(1.0, 0.0)), f.x), mix(snowHash(i + vec2(0.0, 1.0)), snowHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float snowFbm(vec2 p) { float sum = 0.0, amplitude = 0.5; for (int i = 0; i < ${snowOctaves}; i++) { sum += snowNoise(p) * amplitude; p = p * 2.03 + 17.3; amplitude *= 0.5; } return sum / ${(1 - Math.pow(0.5, snowOctaves)).toFixed(4)}; }
  // Ground coordinates turned so x runs up the wind.
  vec2 snowWind(vec2 xz) { return vec2(xz.x * ${(-WIND.x).toFixed(3)} + xz.y * ${(-WIND.z).toFixed(3)}, xz.x * ${WIND.z.toFixed(3)} + xz.y * ${(-WIND.x).toFixed(3)}); }
  // Sastrugi: x is the height of the wind-carved surface (0..1), yz its slope along world x and z.
  vec3 snowScour(vec2 xz) {
    vec2 q = snowWind(xz), p = vec2(q.x * 0.5, q.y * 2.1);
    float h0 = snowFbm(p), hx = snowFbm(p + vec2(0.03, 0.0)), hy = snowFbm(p + vec2(0.0, 0.12));
    vec2 slope = vec2(hx - h0, hy - h0) / 0.06;
    return vec3(h0, slope.x * ${(-WIND.x).toFixed(3)} + slope.y * ${WIND.z.toFixed(3)}, slope.x * ${(-WIND.z).toFixed(3)} + slope.y * ${(-WIND.x).toFixed(3)});
  }
  // The height alone, for where the carving would not show.
  float snowLie(vec2 xz) { vec2 q = snowWind(xz); return snowFbm(vec2(q.x * 0.5, q.y * 2.1)); }
  // Ice crystals that catch the light as the eye moves.
  float snowGlint(vec3 world, vec3 eye) {
    vec3 toEye = eye - world;
    float range = length(toEye);
    toEye /= range;
    float seed = snowHash(floor((world.xz + world.y * 0.37) * 170.0));
    float phase = fract(seed * 61.7 + dot(toEye, vec3(7.3, 11.1, 5.9)));
    return step(0.986, seed) * smoothstep(0.3, 0.0, abs(phase - 0.5)) * smoothstep(13.0, 2.5, range);
  }
  // Loose snow streaming over the surface: 0 where the air is clear, 1 in the thick of a streamer. \`gust\` is the
  // wind at that place (0 in a lull, 1 in a gust), so the streamers arrive with the front that lifts them.
  float snowStream(vec2 xz, float time, float gust) {
    if (gust <= 0.0) return 0.0;
    vec2 q = snowWind(xz);
    float fine = snowFbm(vec2((q.x + time * 5.2) * 0.34, q.y * 2.4 + snowNoise(vec2(q.x * 0.2 + time * 0.6, q.y * 0.3)) * 1.6));
    float broad = snowNoise(vec2((q.x + time * 3.4) * 0.1, q.y * 0.55 + 3.1));
    return smoothstep(0.44, 0.74, fine * 0.62 + broad * 0.5) * gust;
  }
`;
/** How much of a gust the wind at a place is, for the snow it lifts: GLSL, given \`windAt\`. */
const GUST_AT = (place: string) => `smoothstep(0.27, 0.58, windAt(${place}))`;
const snowClock = { value: 0 };
const WORLD_VARYING = (name: string) => /* glsl */`#include <project_vertex>
  {
    vec4 placed = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      placed = instanceMatrix * placed;
    #endif
    ${name} = (modelMatrix * placed).xyz;
  }`;

/** Snow as a surface: sastrugi in the normal, blue in the hollows and on faces turned from the sky, glints, streamers. */
function snowSurface(material: THREE.MeshStandardMaterial, key: string, scour: number, stream: number, wind: Wind | null = null) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.snowClock = snowClock;
    if (wind) Object.assign(shader.uniforms, wind.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSnowWorld;")
      .replace("#include <project_vertex>", WORLD_VARYING("vSnowWorld"));
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vSnowWorld;\nuniform float snowClock;\n${wind ? WIND_GLSL : ""}\n${snowGlsl()}`)
      .replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
        float snowRange = length(cameraPosition - vSnowWorld);
        vec3 snowFacing = inverseTransformDirection(nonPerturbedNormal, viewMatrix);
        float snowFlat = smoothstep(0.25, 0.8, snowFacing.y);
        {
          float amount = ${scour.toFixed(2)} * snowFlat * smoothstep(75.0, 20.0, snowRange);
          // The carved normal takes three readings of the surface. Far slopes only need the one that tints the
          // hollows, and steep faces none at all.
          vec3 scour = amount > 0.004 ? snowScour(vSnowWorld.xz) : vec3(snowFlat > 0.0 ? snowLie(vSnowWorld.xz) : 1.0, 0.0, 0.0);
          normal = normalize(normal + (viewMatrix * vec4(-scour.y, 0.0, -scour.z, 0.0)).xyz * amount);
          float hollow = smoothstep(0.62, 0.3, scour.x) * snowFlat;
          // Light that has travelled through snow comes back blue: hollows and faces turned from the sky show it.
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.86, 0.96), min(1.0, hollow * (0.4 + amount * 1.6)));
          diffuseColor.rgb *= mix(vec3(0.74, 0.83, 0.98), vec3(1.0), smoothstep(-0.5, 0.55, snowFacing.y));
        }`)
      .replace("#include <opaque_fragment>", /* glsl */`
        outgoingLight += vec3(0.95, 1.0, 1.1) * snowGlint(vSnowWorld, cameraPosition) * 2.2 * snowFlat;
        ${stream > 0 && wind ? /* glsl */`{
          float streamer = snowStream(vSnowWorld.xz, snowClock, ${GUST_AT("vSnowWorld.xz")} * snowFlat * smoothstep(110.0, 30.0, snowRange)) * ${stream.toFixed(2)};
          outgoingLight = mix(outgoingLight, vec3(dot(outgoingLight, vec3(0.3333))) * vec3(1.04, 1.06, 1.1), streamer);
        }` : ""}
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${key}-${snowOctaves}`;
}

/**
 * What the weather leaves on everything that is not snow: a dusting on whatever faces the sky, spindrift
 * packed against the foot of walls, rime plastered on faces that look into the wind. `dry` is skipped
 * indoors (the workshop and the rooms behind the glazing).
 */
function weathered<T extends THREE.MeshStandardMaterial>(material: T, key: string, splash: number, plaster: number, dust = 1, crust = 0): T {
  const inner = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    inner.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRimeWorld;")
      .replace("#include <project_vertex>", WORLD_VARYING("vRimeWorld"));
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vRimeWorld;\n${snowGlsl()}`)
      .replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
        {
          vec3 facing = inverseTransformDirection(nonPerturbedNormal, viewMatrix);
          vec3 at = vRimeWorld;
          float indoors = step(${(9.83).toFixed(2)}, abs(at.x)) * step(abs(at.x), 15.7) * step(at.z, ${SIDE_TO.toFixed(2)}) * step(${SIDE_FROM.toFixed(2)}, at.z) * step(at.y, at.x > 0.0 ? ${(SHED_TOP - 0.25).toFixed(2)} : ${(HAB_TOP - 0.25).toFixed(2)})
                        + step(9.99, at.z) * step(at.z, 15.0) * step(abs(at.x), 10.4) * step(at.y, ${(MAIN_TOP - 0.25).toFixed(2)});
          vec2 wall = vec2(at.x + at.z, at.y);
          float grain = snowFbm(wall * 1.7), patches = snowNoise(wall * 0.7 + 9.0) * 0.6 + snowNoise(wall * 1.5 + 4.0) * 0.4;
          float fine = snowNoise(wall * vec2(11.0, 5.0) + 3.0) * 0.62 + snowNoise(wall * vec2(23.0, 11.0)) * 0.38;
          // Dusting on whatever looks at the sky, thinner on the steeper faces.
          float rime = smoothstep(0.45, 0.82, facing.y + (grain - 0.5) * 0.3) * ${dust.toFixed(2)};
          // Spindrift packed against the foot of the wall, in tongues.
          float upright = 1.0 - smoothstep(0.2, 0.6, abs(facing.y));
          rime = max(rime, upright * ${splash.toFixed(2)} * smoothstep(0.95, 0.05, at.y * (0.75 + patches) + grain * 0.5 - 0.1 + (fine - 0.5) * 0.3));
          // Rime on faces that look into the wind: a thin veil everywhere, crust where it has built up.
          float windward = max(0.0, facing.x * ${(-WIND.x).toFixed(3)} + facing.z * ${(-WIND.z).toFixed(3)});
          float crust = smoothstep(0.6, 0.68, patches * 0.72 + fine * 0.38) * ${crust.toFixed(2)};
          rime = max(rime, upright * windward * max(${plaster.toFixed(2)} * 0.3 * (0.3 + fine), crust));
          rime = clamp(rime, 0.0, 1.0) * (1.0 - min(1.0, indoors));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.96), rime);
          roughnessFactor = mix(roughnessFactor, 1.0, rime);
          metalnessFactor *= 1.0 - rime;
          normal = normalize(mix(normal, nonPerturbedNormal, rime * 0.7));
        }`);
  };
  material.customProgramCacheKey = () => `${key}-${snowOctaves}`;
  return material;
}

export function buildOutpost(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const props = createProps(kit);
  // One wind for the whole place, hard and gusty: the trees, the cloth, the smoke, the snow in the air and on the
  // ground, and the gusts that are heard all read this field, so a front is seen to cross the yard.
  const wind = createWind({ heading: Math.atan2(-WIND.x, -WIND.z), strength: 0.5, gustiness: 0.65 });
  const life = createLife(kit, options, { wind, seed: 5 });
  const trees = createTrees(kit, { seed: 5, wind, sun: () => sun });
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  // The lower tier spends half the noise on its snow.
  snowOctaves = high ? 4 : 2;
  const metals = kit.metals();
  const random = rng(20261);
  /** Rolls for what was added after the yard was laid out, so none of it reshuffles what stands there. */
  const chance = rng(977);
  const PI = Math.PI;
  /** Where the player stands, as the sky last saw it. */
  const eye = { x: 0, y: 1.62, z: 7.2, look: 0 };
  // Sounds are asked for at a place; a small ring of vectors serves them without allocating one each time.
  const cuePlaces = Array.from({ length: 8 }, () => new THREE.Vector3());
  let cuePlace = 0;
  const say = (name: CueName, x: number, y: number, z: number, gain = 1, pitch = 1) => {
    options.cue?.(name, cuePlaces[cuePlace = (cuePlace + 1) % cuePlaces.length].set(x, y, z), { gain, pitch });
  };

  // ---- Materials -----------------------------------------------------------
  const snowSet = photoSet("/textures/snow_02-2k", 1, 1, false);
  const ironSet = photoSet("/textures/corrugated_iron_02-2k", 1, 1, false);
  const plateSet = photoSet("/textures/metal_plate-2k", 1, 1, false);
  const plankSet = photoSet("/textures/weathered_brown_planks-2k", 1, 1, false);
  const concreteSet = photoSet("/textures/concrete_wall_007-2k", 1, 1, false);
  const fabricSet = photoSet("/textures/fabric_pattern_07-2k", 1, 1, false);
  // The set's colour map carries dark scuffs that repeat badly on open snow, so snow takes only its relief and roughness.
  const SNOW_TINT = new THREE.Color(0xe6ecf4);
  const snowRelief = { normalMap: snowSet.normalMap, roughnessMap: snowSet.roughnessMap };
  const snow = new THREE.MeshStandardMaterial({ ...snowRelief, normalScale: new THREE.Vector2(1.4, 1.4), color: SNOW_TINT, roughness: 1, metalness: 0, envMapIntensity: 0.85 });
  const land = new THREE.MeshStandardMaterial({ ...snowRelief, normalScale: new THREE.Vector2(1.5, 1.5), color: SNOW_TINT, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.85 });
  snowSurface(snow, "outpost-snow", 0.44, 0);
  snowSurface(land, "outpost-land", 0.6, high ? 0.7 : 0, wind);
  kit.updates.push((now) => { snowClock.value = now / 1000; });
  const panelOrange = pbrMaterial(keep(paintedSteel(anisotropy, [0.4, 0.115, 0.04], 1511, 0.32)), { envMapIntensity: 0.8 });
  const panelPine = pbrMaterial(keep(paintedSteel(anisotropy, [0.05, 0.12, 0.125], 1717, 0.36)), { envMapIntensity: 0.8 });
  const paintOrange = pbrMaterial(keep(paintedSteel(anisotropy, [0.62, 0.17, 0.03], 1811, 0.45, 512)), { envMapIntensity: 0.9 });
  const paintRed = pbrMaterial(keep(paintedSteel(anisotropy, [0.42, 0.045, 0.035], 1913, 0.6, 512)), { envMapIntensity: 0.9 });
  const paintPale = pbrMaterial(keep(paintedSteel(anisotropy, [0.5, 0.53, 0.55], 2017, 0.4, 512)), { envMapIntensity: 0.9 });
  const rubber = pbrMaterial(keep(polymer(anisotropy, [0.035, 0.037, 0.04], 2111)), { metalness: 0, envMapIntensity: 0.4 });
  const iron = new THREE.MeshStandardMaterial({ ...ironSet, color: new THREE.Color(1.7, 2.05, 2.5), roughness: 1, metalness: 0.4, envMapIntensity: 0.9 });
  const deck = new THREE.MeshStandardMaterial({ ...plateSet, color: new THREE.Color(1.05, 1.15, 1.3), roughness: 1, metalness: 0.6, envMapIntensity: 0.9 });
  const planks = new THREE.MeshStandardMaterial({ ...plankSet, color: new THREE.Color(1.15, 1.1, 1.05), roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const concrete = new THREE.MeshStandardMaterial({ ...concreteSet, color: 0xc9cdd2, roughness: 1, metalness: 0, envMapIntensity: 0.5 });
  const cableMaterial = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.6, metalness: 0 });
  const rope = new THREE.MeshStandardMaterial({ color: 0xb59a62, roughness: 0.9, metalness: 0 });
  const bamboo = new THREE.MeshStandardMaterial({ color: 0x9a7f4c, roughness: 0.7, metalness: 0 });
  const tarp = new THREE.MeshStandardMaterial({ color: 0x33506a, normalMap: fabricSet.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.8, metalness: 0, envMapIntensity: 0.5 });
  const tarpGreen = new THREE.MeshStandardMaterial({ color: 0x3c4a30, normalMap: fabricSet.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.82, metalness: 0, envMapIntensity: 0.5 });
  const darkGlass = new THREE.MeshStandardMaterial({ color: 0x10161d, roughness: 0.08, metalness: 0.2, envMapIntensity: 1.6 });
  const smoke = new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, envMapIntensity: 1.6 });
  const ice = new THREE.MeshStandardMaterial({ color: 0xdcecfa, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.72, envMapIntensity: 1.5 });
  const hazardMap = track(hazardTexture());
  hazardMap.wrapT = THREE.RepeatWrapping;
  const hazard = new THREE.MeshStandardMaterial({ map: hazardMap, roughness: 0.6, metalness: 0.1 });
  const labelMap = track(labelTexture());
  labelMap.anisotropy = anisotropy;
  // The sheet is cut out by its alpha: boards are solid, sprayed stencils leave the wall showing between the letters.
  const labels = new THREE.MeshStandardMaterial({ map: labelMap, alphaTest: 0.5, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const solarMap = track(solarTexture());
  solarMap.anisotropy = anisotropy;
  const solar = new THREE.MeshStandardMaterial({ map: solarMap, roughness: 0.12, metalness: 0.3, envMapIntensity: 1.5 });
  const emissive = (colour: number, gain: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(gain), toneMapped: false });
  const sodium = emissive(0xffa758, 3.2), bulb = emissive(0xffc27a, 3.4), tubeLight = emissive(0xfff0d0, 2.2), headlamp = emissive(0xfff1d6, 1.6), amber = emissive(0xffb040, 1.8);
  const tail = emissive(0xff2a1c, 1.6), screen = emissive(0x8ef5e3, 1.5), ember = emissive(0xff6a1c, 3);
  const windowMap = track(windowTexture(0));
  windowMap.anisotropy = anisotropy;
  const litGlass = new THREE.MeshBasicMaterial({ map: windowMap, color: new THREE.Color(2.1, 2.1, 2.1), toneMapped: false });
  const unlitGlass = new THREE.MeshStandardMaterial({ map: track(darkWindowTexture()), roughness: 0.15, metalness: 0, envMapIntensity: 1.2 });
  const frostMap = track(frostTexture());
  const glazing = new THREE.MeshStandardMaterial({ map: frostMap, transparent: true, depthWrite: false, roughness: 0.12, metalness: 0, envMapIntensity: 1.4 });
  // Rooms seen through the glazing light themselves: there are no lamps to spare for them.
  const lit = (colour: number, glow: number, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: colour, emissive: glow, roughness: 0.9, metalness: 0, envMapIntensity: 0.3, ...extra });
  const roomWall = lit(0xd9b98c, 0xffffff), roomCeil = lit(0xe8dcc4, 0xffffff), roomWood = lit(0x6b4526, 0x5a3418), roomDark = lit(0x23262b, 0x16181c);
  roomWall.emissive.setRGB(1.25, 0.6, 0.2); roomCeil.emissive.setRGB(1.5, 0.95, 0.45);
  const roomFloor = lit(0xffffff, 0x70482a, { map: plankSet.map, emissiveMap: plankSet.map });
  const linen = lit(0xe8e2d4, 0xa89878), gingham = lit(0xffffff, 0xa08070, { map: fabricSet.map, emissiveMap: fabricSet.map });
  const shopWall = lit(0xffffff, 0x2e2418, { map: ironSet.map, normalMap: ironSet.normalMap, color: new THREE.Color(1.5, 1.4, 1.2) });
  const shopFloor = lit(0xb9b4aa, 0x1a1612, { map: concreteSet.map });
  // Names show up in the renderer's diagnostics.
  Object.entries({
    snow, land, panelOrange, panelPine, paintOrange, paintRed, paintPale, rubber, iron, deck, planks, concrete, cableMaterial, rope, bamboo, tarp, tarpGreen,
    darkGlass, smoke, ice, hazard, labels, solar, sodium, bulb, tubeLight, headlamp, amber, tail, screen, ember, litGlass, unlitGlass, glazing,
    roomWall, roomCeil, roomWood, roomDark, roomFloor, linen, gingham, shopWall, shopFloor,
    machine: metals.machine, structural: metals.structural, darkMetal: metals.darkMetal, brushed: metals.brushed,
  }).forEach(([name, material]) => { material.name = name; });
  // Weather on everything that stands outside. Arguments: snow packed at the foot, rime on windward faces, dusting on top.
  const weather = (materials: THREE.MeshStandardMaterial[], splash: number, plaster: number, dust = 1, crust = 0) => {
    for (const material of materials) weathered(material, `outpost-weather-${splash}-${plaster}-${dust}-${crust}`, splash, plaster, dust, crust);
  };
  weather([panelOrange, panelPine, iron, hazard], 0.95, 0.5);
  weather([concrete, planks], 0.95, 0.5, 1, 0.6);
  weather([metals.darkMetal], 0.9, 0.35);
  weather([paintOrange, paintRed, paintPale, metals.structural, metals.brushed], 0.75, 0.3);
  weather([deck, rubber, tarp, tarpGreen, rope, bamboo, solar], 0.5, 0.2, 0.85);
  weather([cableMaterial], 0, 0.15, 0.8);

  // ---- Batching ------------------------------------------------------------
  // Static pieces are baked into one mesh per material. "Fine" pieces skip the mirror pass and cast no shadow.
  type Flags = { shadow?: boolean; hit?: boolean; fine?: boolean };
  const buckets = new Map<string, { material: THREE.Material; shadow: boolean; hit: boolean; fine: boolean; parts: THREE.BufferGeometry[] }>();
  const baked = { matrix: new THREE.Matrix4(), turn: new THREE.Quaternion(), euler: new THREE.Euler(), at: new THREE.Vector3(), size: new THREE.Vector3() };
  type Put = (material: THREE.Material, geometry: THREE.BufferGeometry, x: number, y: number, z: number, r?: V3 | null, s?: V3 | number | null, flags?: Flags) => void;
  const mk = (parent: THREE.Matrix4 | null = null, base: Flags = {}): Put => (material, geometry, x, y, z, r, s, flags) => {
    const part = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(part.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") part.deleteAttribute(name);
    baked.euler.set(r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0, "YXZ");
    if (typeof s === "number") baked.size.setScalar(s); else baked.size.set(s?.[0] ?? 1, s?.[1] ?? 1, s?.[2] ?? 1);
    baked.matrix.compose(baked.at.set(x, y, z), baked.turn.setFromEuler(baked.euler), baked.size);
    if (parent) baked.matrix.premultiply(parent);
    part.applyMatrix4(baked.matrix);
    const shadow = flags?.shadow ?? base.shadow ?? false, hit = flags?.hit ?? base.hit ?? false, fine = flags?.fine ?? base.fine ?? !shadow;
    const key = `${material.uuid}|${shadow}|${hit}|${fine}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = { material, shadow, hit, fine, parts: [] });
    bucket.parts.push(part);
  };
  const flush = () => {
    for (const bucket of buckets.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(bucket.parts), bucket.material);
      bucket.parts.forEach((part) => part.dispose());
      mesh.castShadow = bucket.shadow; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
      mesh.name = `${bucket.material.name}${bucket.shadow ? "/shadow" : ""}${bucket.hit ? "/hit" : ""}`;
      scene.add(mesh);
      if (bucket.hit) kit.shootable.push(mesh);
      if (bucket.fine) kit.mirrorHidden.push(mesh);
    }
    buckets.clear();
  };
  const frame = (x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")), new THREE.Vector3(1, 1, 1));
  const toWorld = (matrix: THREE.Matrix4, x: number, y: number, z: number): V3 => { const v = new THREE.Vector3(x, y, z).applyMatrix4(matrix); return [v.x, v.y, v.z]; };
  /** World-space: `W` for small things, `WS` for things big enough to throw a shadow, `WH` also stops bullets. */
  const W = mk(), WS = mk(null, { shadow: true, fine: false }), WH = mk(null, { shadow: true, fine: false, hit: true });
  /** Instanced detail that stays out of the mirror pass. */
  const inst = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], shadow = false, hit = false) => {
    const mesh = instances(geometry, material, transforms, hit, shadow);
    if (!shadow) kit.mirrorHidden.push(mesh);
    return mesh;
  };

  // Geometry shorthands.
  const bx = (w: number, h: number, d: number, metres = 1.6) => worldBox(w, h, d, metres);
  const rb = (w: number, h: number, d: number, radius = 0.02, metres = 1.6, segments = 1) => projectUv(new RoundedBoxGeometry(w, h, d, segments, radius), metres);
  /** A soft slab of settled snow. */
  let capSeed = 0;
  const pad = (w: number, h: number, d: number) => snowCapGeometry(w, h, d, (capSeed += 1));
  const cyl = (top: number, bottom: number, h: number, sides = 10, open = false) => new THREE.CylinderGeometry(top, bottom, h, sides, 1, open);
  const cylX = (top: number, bottom: number, h: number, sides = 10) => cyl(top, bottom, h, sides).rotateZ(PI / 2);
  const cylZ = (top: number, bottom: number, h: number, sides = 10) => cyl(top, bottom, h, sides).rotateX(PI / 2);
  const ball = (radius: number, around = 10, up = 6) => new THREE.SphereGeometry(radius, around, up);
  const cap = (radius: number, around = 12, up = 4) => new THREE.SphereGeometry(radius, around, up, 0, PI * 2, 0, PI / 2);
  const UP = new THREE.Vector3(0, 1, 0);
  const rod = (from: V3, to: V3, radius: number, sides = 6) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), axis = b.clone().sub(a), length = axis.length();
    const geometry = new THREE.CylinderGeometry(radius, radius, length, sides, 1, true);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, axis.normalize()));
    geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return geometry;
  };
  const tube = (points: V3[], radius: number, sides = 6, steps = points.length * 5) =>
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", 0.35), steps, radius, sides);
  const plane = (w: number, h: number) => new THREE.PlaneGeometry(w, h);
  const label = (name: keyof typeof LABELS, w: number, h: number) => {
    const [px, py, pw, ph] = LABELS[name], geometry = new THREE.PlaneGeometry(w, h), uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (px + uv.getX(i) * pw) / SHEET, 1 - (py + (1 - uv.getY(i)) * ph) / SHEET);
    return geometry;
  };
  const wheelGeometry = (radius: number, width: number) => {
    const w = width / 2, r = radius;
    const profile = [[0, -w * 0.8], [r * 0.34, -w], [r * 0.42, -w * 0.6], [r * 0.74, -w * 0.6], [r * 0.82, -w], [r, -w], [r, w], [r * 0.82, w], [r * 0.74, w * 0.6], [r * 0.42, w * 0.6], [r * 0.34, w], [0, w * 0.8]];
    return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 16).rotateZ(PI / 2);
  };

  // ---- Stores ---------------------------------------------------------------
  // Crates, drums, pallets, sacks, cartons and tins come from the shared props library. Whatever needs one hands
  // it to `stock`; each kind is then placed once, as a single batch, with everything else gathered at the end.
  const stock = new Map<PropKind, PropItem[]>();
  type Look = Omit<PropItem, "position" | "rotation">;
  const put = (kind: PropKind, x: number, y: number, z: number, rotation: number | V3 = 0, look: Look = {}) => {
    let list = stock.get(kind);
    if (!list) stock.set(kind, list = []);
    list.push({ position: [x, y, z], rotation: typeof rotation === "number" ? [0, rotation, 0] : rotation, ...look });
  };
  /** The same inside a frame that is only turned about y: a sledge, a room, the workshop. */
  const putIn = (F: THREE.Matrix4) => {
    const yaw = Math.atan2(F.elements[8], F.elements[10]);
    return (kind: PropKind, x: number, y: number, z: number, turn = 0, look: Look = {}) => put(kind, ...toWorld(F, x, y, z), yaw + turn, look);
  };
  /** A prop that is not standing up: tipped about its own x and z, spun about its own axis, then turned about y. */
  const tipped = (yaw: number, tipX: number, tipZ = 0, spin = 0): V3 => {
    const pose = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(tipX, yaw, tipZ, "YXZ")).multiply(new THREE.Quaternion().setFromAxisAngle(UP, spin)), "XYZ");
    return [pose.x, pose.y, pose.z];
  };
  const heightOf = (kind: PropKind) => props.get(kind).size[1];

  // ---- Ground --------------------------------------------------------------
  const ground = new THREE.MeshStandardMaterial({ ...snowRelief, normalScale: new THREE.Vector2(1.5, 1.5), color: SNOW_TINT, roughness: 1, metalness: 0, envMapIntensity: 0.85 });
  // Course dye sprayed on the snow, the blue that still shows when the light goes flat; a few wind-polished patches
  // of ice take the place of puddles.
  const reflection = kit.floor(ground, { width: 40, depth: 50, z: -9 }, {
    lane: new THREE.Color(0.3, 0.5, 0.74),
    edge: new THREE.Color(0.08, 0.24, 0.5),
    markings: 0.36,
    wet: -0.045,
  });
  // One snow tile spans 2.5 m of the slab.
  const slab = kit.mirrorHidden[kit.mirrorHidden.length - 1] as THREE.Mesh;
  const slabUv = slab.geometry.attributes.uv;
  for (let i = 0; i < slabUv.count; i += 1) slabUv.setXY(i, slabUv.getX(i) * 16, slabUv.getY(i) * 20);
  // Wind-carved relief the texture cannot give at range, ice crystals that glint as the eye moves, and loose
  // snow streaming across on the wind: the same functions the drifts and the land use, so they join without a seam.
  // Packed, greyed snow where the yard is walked and driven is part of the same surface, not a layer blended over it.
  const wearMap = track(wearTexture(19, 38, -28.5));
  wearMap.anisotropy = anisotropy;
  const wetFloor = ground.onBeforeCompile;
  ground.onBeforeCompile = (shader, renderer) => {
    wetFloor.call(ground, shader, renderer);
    shader.uniforms.snowClock = snowClock;
    shader.uniforms.wearMap = { value: wearMap };
    Object.assign(shader.uniforms, wind.uniforms);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nuniform float snowClock;\nuniform sampler2D wearMap;\n${WIND_GLSL}\n${snowGlsl()}`).replace("#include <emissivemap_fragment>", /* glsl */`
      {
        vec2 wearAt = vec2(vFloorWorld.x + 9.5, 9.5 - vFloorWorld.z) / vec2(19.0, 38.0);
        vec4 wear = texture2D(wearMap, wearAt);
        float worn = wear.a * step(abs(wearAt.x - 0.5), 0.5) * step(abs(wearAt.y - 0.5), 0.5);
        diffuseColor.rgb = mix(diffuseColor.rgb, wear.rgb, worn);
        roughnessFactor = mix(roughnessFactor, 0.7, worn);
      }
      {
        vec3 scour = snowScour(vFloorWorld.xz);
        float scourRange = length(cameraPosition - vFloorWorld);
        // Traffic packs the middle of the yard flat; the edges keep their sastrugi.
        float scourAmount = (0.24 + 0.2 * smoothstep(4.5, 9.0, abs(vFloorWorld.x)) + 0.2 * smoothstep(-24.0, -29.0, vFloorWorld.z)) * smoothstep(75.0, 20.0, scourRange) * (1.0 - floorWet);
        normal = normalize(normal + (viewMatrix * vec4(-scour.y, 0.0, -scour.z, 0.0)).xyz * scourAmount);
        float hollow = smoothstep(0.62, 0.3, scour.x);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.86, 0.96), min(1.0, hollow * (0.4 + scourAmount * 1.6)));
      }
      #include <emissivemap_fragment>`).replace("#include <opaque_fragment>", /* glsl */`
      {
        outgoingLight += vec3(0.95, 1.0, 1.1) * snowGlint(vFloorWorld, cameraPosition) * 2.2 * (1.0 - floorWet);
        // The buildings shelter the middle of the yard; streamers run strongest past its open ends.
        float shelter = 0.35 + 0.35 * smoothstep(-20.0, -29.0, vFloorWorld.z) + 0.3 * smoothstep(-2.0, 5.0, vFloorWorld.z);
        ${high ? `float streamer = snowStream(vFloorWorld.xz, snowClock, ${GUST_AT("vFloorWorld.xz")} * smoothstep(110.0, 30.0, length(cameraPosition - vFloorWorld)) * shelter) * 0.7;` : "float streamer = 0.0 * shelter;"}
        outgoingLight = mix(outgoingLight, vec3(dot(outgoingLight, vec3(0.3333))) * vec3(1.04, 1.06, 1.1), streamer);
      }
      #include <opaque_fragment>`);
  };
  ground.customProgramCacheKey = () => `hyperstrike-floor-outpost-snow-4-${high}`;
  ground.needsUpdate = true;

  const landCells = high ? 172 : 120;
  const terrain = new THREE.Mesh(terrainGeometry(landCells), land);
  terrain.receiveShadow = true;
  terrain.matrixAutoUpdate = false;
  scene.add(terrain);
  kit.mirrorHidden.push(terrain);
  /** Height of the land as drawn (the mesh, not the formula behind it), so things stand on what the eye sees. */
  const landPosition = terrain.geometry.attributes.position;
  const landCell = (value: number) => Math.min(landCells - 1e-6, Math.max(0, (Math.sign(value) * Math.pow(Math.abs(value) / 250, 1 / 1.75) + 1) / 2 * landCells));
  const landHeight = (x: number, z: number) => {
    const a = Math.floor(landCell(z + 9)) * (landCells + 1) + Math.floor(landCell(x)), b = a + 1, c = a + landCells + 1, e = c + 1;
    const s = (x - landPosition.getX(a)) / (landPosition.getX(b) - landPosition.getX(a)), t = (z - landPosition.getZ(a)) / (landPosition.getZ(c) - landPosition.getZ(a));
    const ha = landPosition.getY(a), hb = landPosition.getY(b), hc = landPosition.getY(c), he = landPosition.getY(e);
    return s + t <= 1 ? ha + s * (hb - ha) + t * (hc - ha) : he + (1 - s) * (hc - he) + (1 - t) * (hb - he);
  };
  /** Height of whatever the eye sees as ground at a point: the slab in the yard, the land beyond it. */
  const groundAt = (x: number, z: number) => (Math.abs(x) < 20 && z > -34 && z < 16 ? Math.max(0, landHeight(x, z)) : landHeight(x, z));

  // Marks on the snow are decals: they lie a few millimetres up, never write depth, and draw in a fixed order
  // before anything else that blends (ruts, tracks, prints, then the painted light pools).
  const decalMaterial = (maps: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({
    transparent: true, depthWrite: false, roughness: 0.7, metalness: 0, envMapIntensity: 0.9, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, ...maps,
  });
  const decal = (map: THREE.Texture, width: number, depth: number, x: number, z: number, turn: number, order: number) => {
    map.anisotropy = anisotropy;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), decalMaterial({ map }));
    mesh.rotation.set(-PI / 2, 0, turn);
    mesh.position.set(x, 0.006, z);
    mesh.receiveShadow = true;
    mesh.renderOrder = order;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    return mesh;
  };
  decal(track(rutsTexture()), 2.6, 7.4, 4.3, -30.3, -0.08, -5);
  {
    // Tracks: strips laid along each route, their tread tiling down the length and fading out at both ends.
    const treads = treadAtlas();
    for (const map of [track(treads.map), track(treads.normalMap)]) map.anisotropy = anisotropy;
    const positions: number[] = [], uvs: number[] = [], colours: number[] = [], indices: number[] = [];
    const strip = (points: THREE.Vector3[], offset: number, half: number, u0: number, u1: number, strength = 1) => {
      const base = positions.length / 3;
      let total = 0, travelled = 0;
      for (let i = 1; i < points.length; i += 1) total += points[i].distanceTo(points[i - 1]);
      points.forEach((point, index) => {
        const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
        const tx = after.x - before.x, tz = after.z - before.z, length = Math.hypot(tx, tz) || 1;
        if (index) travelled += point.distanceTo(points[index - 1]);
        const fade = strength * smooth(0, 0.9, travelled) * smooth(0, 0.9, total - travelled);
        for (const [side, u] of [[-1, u0], [1, u1]]) {
          positions.push(point.x - tz / length * (offset + side * half), 0, point.z + tx / length * (offset + side * half));
          uvs.push(u, travelled / 0.5); colours.push(1, 1, 1, fade);
        }
        if (index) { const a = base + (index - 1) * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      });
    };
    const ride = routeCurve(ROUTES.ride).getSpacedPoints(110);
    // The snowmobile went out and came back a little to one side.
    for (const shift of [0, 0.36]) {
      strip(ride, shift, 0.25, 0.02, 0.48, shift ? 0.8 : 1);
      for (const side of [-1, 1]) strip(ride, shift + side * 0.46, 0.1, 0.525, 0.725, shift ? 0.8 : 1);
    }
    for (const drag of ROUTES.drags) for (const side of [-1, 1]) strip(routeCurve(drag).getSpacedPoints(70), side * 0.31, 0.08, 0.79, 0.96);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(positions.map((_, index) => (index % 3 === 1 ? 1 : 0)), 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 4));
    geometry.setIndex(indices);
    const tracks = new THREE.Mesh(geometry, decalMaterial({ map: treads.map, normalMap: treads.normalMap, normalScale: new THREE.Vector2(1.6, 1.6), vertexColors: true }));
    tracks.position.y = 0.009;
    tracks.receiveShadow = true;
    tracks.renderOrder = -4;
    scene.add(tracks);
    kit.mirrorHidden.push(tracks);
    // Boot prints: one modelled print, stamped along every path people take, each pass a little to one side of the last.
    const boots = bootPrint();
    for (const map of [track(boots.map), track(boots.normalMap)]) map.anisotropy = anisotropy;
    const next = rng(907), prints: Transform[] = [];
    for (const [walk, passes] of ROUTES.walks) for (let pass = 0; pass < passes; pass += 1) {
      const curve = routeCurve(walk), line = curve.getSpacedPoints(Math.round(curve.getLength() / (0.34 + next() * 0.08)));
      const wander = (next() - 0.5) * 0.55, back = pass % 2 === 1;
      line.forEach((point, index) => {
        if (index === line.length - 1) return;
        const after = line[index + 1], way = back ? -1 : 1, hx = (after.x - point.x) * way, hz = (after.z - point.z) * way, length = Math.hypot(hx, hz) || 1;
        const foot = index % 2 ? 1 : -1, side = foot * 0.11 * way + wander + (next() - 0.5) * 0.07;
        prints.push({
          position: [point.x - (after.z - point.z) / length * side, 0.012, point.z + (after.x - point.x) / length * side],
          rotation: [0, Math.atan2(-hx, -hz) - foot * 0.14 + (next() - 0.5) * 0.24, 0],
          scale: [0.92 + next() * 0.16, 1, 0.92 + next() * 0.16],
        });
      });
    }
    const stamp = inst(new THREE.PlaneGeometry(0.15, 0.33).rotateX(-PI / 2), decalMaterial({ map: boots.map, normalMap: boots.normalMap, normalScale: new THREE.Vector2(1.5, 1.5) }), high ? prints : prints.filter((_, index) => index % 2 === 0));
    stamp.castShadow = false;
    stamp.renderOrder = -3;
  }

  // Drifts. Arguments: length, width, height, x, z, turn about y, crest, y, stretch along the length.
  // At y = 0 a drift lies on whatever is drawn under it: the slab in the yard, the land beyond.
  let driftSeed = 3;
  const drift = (length: number, width: number, height: number, x: number, z: number, turn = 0, crest = 0.5, y = 0, stretch = 1) => {
    driftSeed += 7;
    const geometry = driftGeometry(length, width, height, driftSeed, crest);
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, turn, 0)), new THREE.Vector3(stretch, 1, 1)));
    const position = geometry.attributes.position, uv = geometry.attributes.uv;
    for (let i = 0; i < position.count; i += 1) {
      const px = position.getX(i), pz = position.getZ(i);
      if (y === 0) position.setY(i, position.getY(i) + groundAt(px, pz));
      uv.setXY(i, ...snowUv(px, pz));
    }
    geometry.computeVertexNormals();
    W(snow, geometry, 0, 0, 0);
  };

  // Icicles gather here from every eave, sill and canopy.
  const icicles: Transform[] = [];
  const hang = (x: number, y: number, z: number, length: number, girth = 1) => { icicles.push({ position: [x, y, z], scale: [girth, length, girth] }); };
  const eave = (axis: "x" | "z", at: number, from: number, to: number, y: number, density: number, longest = 0.62) => {
    for (let along = from; along < to; along += 0.06 + random() * density) {
      const big = random() < 0.06;
      hang(axis === "z" ? at : along, y, axis === "z" ? along : at, big ? longest * (1 + random() * 0.8) : 0.08 + Math.pow(random(), 2.2) * longest, big ? 1.8 : 0.6 + random() * 0.9);
      if (random() < 0.12) along += 0.5 + random() * 1.4;
    }
  };

  // Steam and smoke sources: position, and how big an outlet it is (stove pipes and stacks, vents, a flue).
  const plumes: Array<{ at: V3; size: number }> = [];
  // Every lamp that shows in the weather gets a halo; they are drawn in one batch at the end.
  const halos: Array<{ at: V3; size: number; colour: number; gain: number; blink: number }> = [];
  const halo = (at: V3, size: number, colour = 0xffa758, gain = 1, blink = 0) => { halos.push({ at, size, colour, gain, blink }); };

  // ---- Rooms behind the glazing --------------------------------------------
  const glassPanes: Transform[] = [], darkPanes: Transform[] = [], pools: Transform[] = [];
  let roomSeed = 0;
  const room = (F: THREE.Matrix4, w: number, h: number, kind: number) => {
    const R = mk(F), next = rng(700 + (roomSeed += 17));
    const D = 2.1, wide = w + 1.3, top = h / 2 + 0.45, bottom = -h / 2 - 0.95, tall = top - bottom, mid = (top + bottom) / 2, back = -0.3 - D, zc = -0.3 - D / 2;
    R(roomWall, plane(wide, tall), 0, mid, back);
    R(roomWall, plane(D, tall), -wide / 2, mid, zc, [0, PI / 2, 0]);
    R(roomWall, plane(D, tall), wide / 2, mid, zc, [0, -PI / 2, 0]);
    R(roomCeil, plane(wide, D), 0, top, zc, [PI / 2, 0, 0]);
    R(roomFloor, plane(wide, D), 0, bottom, zc, [-PI / 2, 0, 0]);
    // Ceiling lamp, skirting, a door in the back wall.
    R(roomDark, cyl(0.2, 0.26, 0.05, 12), 0.1, top - 0.03, zc);
    R(bulb, cyl(0.15, 0.15, 0.03, 12), 0.1, top - 0.065, zc);
    R(roomWood, bx(wide, 0.09, 0.02), 0, bottom + 0.045, back + 0.012);
    const doorSide = next() < 0.5 ? -1 : 1;
    R(roomWood, bx(0.82, 1.98, 0.035), doorSide * (wide / 2 - 0.6), bottom + 0.99, back + 0.02);
    R(roomDark, bx(0.9, 2.04, 0.02), doorSide * (wide / 2 - 0.6), bottom + 1.02, back + 0.011);
    if (!high) return;
    R(metals.brushed, bx(0.03, 0.12, 0.05), doorSide * (wide / 2 - 0.6) - doorSide * 0.32, bottom + 1.0, back + 0.05);
    // Conduit and a pipe under the ceiling: what a visitor on the ground actually sees through an upstairs window.
    R(roomDark, cylX(0.025, 0.025, wide, 6), 0, top - 0.12, back + 0.3);
    R(metals.brushed, cylX(0.04, 0.04, wide, 8), 0, top - 0.18, back + 0.12);
    const side = next() < 0.5 ? -1 : 1;
    if (kind === 0) {
      // Bunks along the back wall, a drawn curtain, coats on hooks.
      const bunkX = side * (wide / 2 - 1.02), bunkZ = back + 0.47;
      for (const px of [-0.94, 0.94]) for (const pz of [-0.38, 0.38]) R(roomDark, bx(0.05, 1.86, 0.05), bunkX + px, bottom + 0.93, bunkZ + pz);
      for (const level of [0.42, 1.42]) {
        R(roomDark, bx(1.9, 0.07, 0.8), bunkX, bottom + level - 0.08, bunkZ);
        R(linen, rb(1.84, 0.13, 0.76, 0.05), bunkX, bottom + level + 0.02, bunkZ);
        R(gingham, rb(1.3, 0.1, 0.8, 0.045, 0.45), bunkX - side * 0.26, bottom + level + 0.07, bunkZ);
        R(linen, rb(0.42, 0.11, 0.3, 0.05), bunkX + side * 0.68, bottom + level + 0.12, bunkZ - 0.14);
        R(roomDark, bx(1.9, 0.05, 0.04), bunkX, bottom + level + 0.3, bunkZ + 0.39);
      }
      for (let rung = 0; rung < 4; rung += 1) R(roomDark, bx(0.34, 0.03, 0.03), bunkX - side * 0.72, bottom + 0.35 + rung * 0.33, bunkZ + 0.42);
      R(bulb, ball(0.045, 8, 6), bunkX + side * 0.8, bottom + 1.95, back + 0.1);
      R(gingham, rb(0.3, h + 0.16, 0.05, 0.02, 0.4), -side * (w / 2 - 0.1), 0, -0.36);
      R(roomDark, cylX(0.012, 0.012, w + 0.3, 6), 0, h / 2 + 0.1, -0.36);
      for (let hook = 0; hook < 3; hook += 1) R(hook === 1 ? paintOrange : roomDark, rb(0.12, 0.8, 0.32, 0.05), -side * (wide / 2 - 0.075 - hook * 0.004), bottom + 1.45 - hook * 0.03, zc + 0.42 - hook * 0.4, null, [1, 1 - hook * 0.1, 1]);
      R(roomWood, rb(0.5, 0.5, 0.42, 0.02), -side * (wide / 2 - 0.3), bottom + 0.25, zc + 0.3);
    } else if (kind === 1) {
      // Stores: racking stacked the way a storekeeper leaves it, and the stove that heats the corridor.
      const S = putIn(F), shelfZ = back + 0.21, eyeLevel = F.elements[13] < 2.5, can: Look["scale"] = [1.3, 1.3, 1.3], canTall = 0.1 * 1.3;
      for (const px of [-wide / 2 + 0.2, 0, wide / 2 - 0.2]) R(roomDark, bx(0.04, tall - 0.3, 0.36), px, mid - 0.15, back + 0.2);
      [0.42, 0.95, 1.48, 1.98].forEach((level, row) => {
        R(roomWood, bx(wide - 0.3, 0.035, 0.38), 0, bottom + level, shelfZ);
        // From the yard an upstairs room shows only the front of its upper shelves: cartons do there. The top
        // shelf is tight under the pipes.
        if (!eyeLevel && row < 2) return;
        const y = bottom + level + 0.018, low = row === 3;
        for (const [from, to] of [[-wide / 2 + 0.25, -0.05], [0.05, wide / 2 - 0.25]]) {
          const pick = next();
          let x = from + next() * 0.05;
          if (eyeLevel && (low || pick < 0.36)) {
            // Tins two deep, one product to a run, a second tier begun on the back row.
            const until = low ? to : to - 0.36 - next() * 0.2, run = Math.floor(next() * 4);
            for (let column = 0; x + 0.11 < until; x += 0.115, column += 1) {
              const variant = column < 4 ? run : run + 1;
              S("tin", x + 0.055, y, shelfZ, next() * 6, { scale: can, variant });
              if (next() < 0.8) S("tin", x + 0.055 + (next() - 0.5) * 0.012, y, shelfZ + 0.115, next() * 6, { scale: can, variant });
              if (!low && next() < 0.42) S("tin", x + 0.055 + (next() - 0.5) * 0.02, y + canTall, shelfZ + (next() - 0.5) * 0.02, next() * 6, { scale: can, variant });
            }
            if (!low && x + 0.33 < to) S("cartonSmall", x + 0.19, y, shelfZ + 0.03, (next() - 0.5) * 0.6);
          } else if (eyeLevel && pick < 0.52) {
            // Preserving jars, the full ones to the front.
            for (; x + 0.12 < to - 0.5; x += 0.122) {
              S("jar", x + 0.06, y, shelfZ + 0.1, next() * 6);
              if (next() < 0.6) S("jar", x + 0.12, y, shelfZ - 0.03, next() * 6);
            }
            S("carton", to - 0.26, y, shelfZ + 0.01, (next() - 0.5) * 0.3);
          } else {
            // Cartons: nothing stacked higher than the shelf above allows, nothing quite square to its neighbour.
            while (x + 0.31 < to) {
              const choice = next(), skew = () => (next() - 0.5) * 0.18;
              if (low) {
                if (x + 0.57 > to) break;
                S("cartonFlat", x + 0.285, y, shelfZ - 0.01, skew());
                x += 0.62 + next() * 0.3;
              } else if (choice < 0.4 && x + 0.47 < to) {
                S("carton", x + 0.235, y, shelfZ + 0.01, skew());
                if (next() < 0.55) S("cartonFlat", x + 0.24 + (next() - 0.5) * 0.05, y + 0.32, shelfZ + 0.01, (next() - 0.5) * 0.5, { scale: [0.8, 1, 0.8] });
                x += 0.5 + next() * 0.08;
              } else if (choice < 0.72 && x + 0.57 < to) {
                const tiers = 2 + Math.floor(next() * 2);
                for (let tier = 0; tier < tiers; tier += 1) S("cartonFlat", x + 0.285 + (next() - 0.5) * 0.04, y + tier * 0.12, shelfZ - 0.01 + (next() - 0.5) * 0.03, skew());
                x += 0.6 + next() * 0.08;
              } else {
                S("cartonSmall", x + 0.155, y, shelfZ + 0.04, skew());
                if (next() < 0.6) S("cartonSmall", x + 0.155 + (next() - 0.5) * 0.05, y + 0.2, shelfZ + 0.03, (next() - 0.5) * 0.8);
                x += 0.34 + next() * 0.1;
              }
            }
          }
        }
      });
      const stoveX = side * (wide / 2 - 0.42), stoveZ = -0.95;
      R(roomDark, cyl(0.2, 0.22, 0.72, 14), stoveX, bottom + 0.44, stoveZ);
      R(roomDark, cyl(0.24, 0.24, 0.04, 14), stoveX, bottom + 0.82, stoveZ);
      for (const [lx, lz] of [[-0.14, -0.14], [0.14, -0.14], [0, 0.18]]) R(roomDark, cyl(0.015, 0.015, 0.1, 5), stoveX + lx, bottom + 0.05, stoveZ + lz);
      R(ember, plane(0.16, 0.12), stoveX - side * 0.02, bottom + 0.42, stoveZ + 0.222);
      R(roomDark, bx(0.2, 0.16, 0.012), stoveX - side * 0.02, bottom + 0.42, stoveZ + 0.214);
      R(metals.brushed, cyl(0.06, 0.06, top - bottom - 0.84, 8), stoveX, (top + bottom + 0.84) / 2, stoveZ - 0.05);
      R(roomDark, bx(0.6, 0.02, 0.6), stoveX, bottom + 0.012, stoveZ);
    } else {
      // Radio desk: sets, a screen, a chart on the wall, an anglepoise.
      const deskX = side * (wide / 2 - 0.85), deskZ = back + 0.38;
      R(roomWood, rb(1.5, 0.045, 0.7, 0.012), deskX, bottom + 0.76, deskZ);
      for (const px of [-0.7, 0.7]) R(roomDark, bx(0.04, 0.74, 0.62), deskX + px, bottom + 0.37, deskZ);
      R(roomDark, rb(0.5, 0.34, 0.05, 0.012), deskX - 0.32, bottom + 1.08, deskZ - 0.14);
      R(screen, plane(0.44, 0.27), deskX - 0.32, bottom + 1.08, deskZ - 0.112);
      R(roomDark, bx(0.08, 0.16, 0.08), deskX - 0.32, bottom + 0.86, deskZ - 0.16);
      R(roomDark, rb(0.46, 0.2, 0.3, 0.015), deskX + 0.36, bottom + 0.89, deskZ - 0.12);
      R(amber, plane(0.16, 0.05), deskX + 0.3, bottom + 0.92, deskZ + 0.032);
      for (let knob = 0; knob < 3; knob += 1) R(metals.brushed, cylZ(0.018, 0.018, 0.02, 8), deskX + 0.46 + knob * 0.05, bottom + 0.86, deskZ + 0.04);
      R(roomDark, rod([deskX + 0.66, bottom + 0.78, deskZ - 0.2], [deskX + 0.6, bottom + 1.2, deskZ - 0.1], 0.01), 0, 0, 0);
      R(roomDark, rod([deskX + 0.6, bottom + 1.2, deskZ - 0.1], [deskX + 0.36, bottom + 1.32, deskZ + 0.1], 0.01), 0, 0, 0);
      R(roomDark, cyl(0.03, 0.08, 0.09, 10), deskX + 0.34, bottom + 1.3, deskZ + 0.12);
      R(bulb, ball(0.03, 8, 6), deskX + 0.34, bottom + 1.27, deskZ + 0.12);
      R(roomDark, rb(0.44, 0.06, 0.44, 0.02), deskX - 0.2, bottom + 0.47, deskZ + 0.62);
      R(roomDark, rb(0.42, 0.5, 0.05, 0.02), deskX - 0.2, bottom + 0.82, deskZ + 0.84);
      R(roomDark, cyl(0.025, 0.025, 0.45, 6), deskX - 0.2, bottom + 0.23, deskZ + 0.62);
      R(labels, label("map", 0.9, 0.9), -side * (wide / 2 - 0.75), bottom + 1.55, back + 0.012);
      R(roomWood, bx(1.0, 0.03, 0.22), deskX, bottom + 1.72, back + 0.12);
      for (let binder = 0; binder < 9; binder += 1) R([paintRed, paintPale, roomDark, paintOrange][Math.floor(next() * 4)], bx(0.06, 0.26 + next() * 0.05, 0.19), deskX - 0.42 + binder * 0.075, bottom + 1.87, back + 0.12);
    }
  };

  /** `facing` is the way the glass looks: +x on the habitat, -x on the shed, -z on the main building. */
  const windowAt = (facing: "+x" | "-x" | "-z", face: number, along: number, y: number, w: number, h: number, kind: number) => {
    const turn = facing === "+x" ? PI / 2 : facing === "-x" ? -PI / 2 : PI;
    const F = facing === "-z" ? frame(along, y, face, turn) : frame(face, y, along, turn), T = mk(F);
    for (const side of [-1, 1]) {
      T(metals.darkMetal, bx(w + 0.02, 0.055, 0.12), 0, side * (h / 2 - 0.02), -0.12);
      T(metals.darkMetal, bx(0.055, h, 0.12), side * (w / 2 - 0.02), 0, -0.12);
    }
    T(metals.darkMetal, bx(0.04, h, 0.07), 0, 0, -0.12);
    T(metals.darkMetal, bx(w / 2, 0.03, 0.06), -w / 4, h * 0.18, -0.12);
    T(metals.darkMetal, bx(w + 0.26, 0.035, 0.2), 0, -h / 2 - 0.018, 0.04);
    T(metals.darkMetal, bx(w + 0.2, 0.045, 0.07), 0, h / 2 + 0.06, 0.035);
    T(snow, pad(w + 0.2, 0.11, 0.18), 0, -h / 2 + 0.05, 0.05);
    T(snow, pad(w + 0.16, 0.06, 0.08), 0, h / 2 + 0.1, 0.04);
    for (let x = -w / 2; x < w / 2; x += 0.1 + random() * 0.3) hang(...toWorld(F, x, -h / 2 - 0.035, 0.12), 0.05 + random() * 0.22, 0.7);
    const at = toWorld(F, 0, 0, -0.13);
    (kind < 0 ? darkPanes : glassPanes).push({ position: at, rotation: [0, turn, 0], scale: [w - 0.04, h - 0.04, 1] });
    if (kind < 0) return;
    room(F, w, h, kind);
    // Light spilling onto the snow under a ground-floor window.
    if (y < 2.5) pools.push({ position: toWorld(F, 0, 0.012 - y, 1.3), rotation: [-PI / 2, 0, turn], scale: [3.2, 3.4, 1] });
  };

  /** A steel door in its frame; origin on the threshold, +z out of the wall. */
  const door = (F: THREE.Matrix4, leaf: THREE.Material, plate: keyof typeof LABELS | null) => {
    const T = mk(F), TH = mk(F, { hit: true, fine: false });
    // The frame lines the opening and stands 2 cm proud of the reveal, so no two faces share a plane.
    for (const side of [-1, 1]) T(metals.darkMetal, bx(0.1, 2.18, 0.22), side * 0.58, 1.09, -0.07);
    T(metals.darkMetal, bx(1.26, 0.1, 0.22), 0, 2.23, -0.07);
    TH(leaf, rb(1.1, 2.2, 0.05, 0.008), 0, 1.1, -0.13);
    T(leaf, rb(0.84, 0.72, 0.014, 0.006), 0, 0.72, -0.1);
    // Light in the leaf.
    for (const side of [-1, 1]) { T(metals.darkMetal, bx(0.035, 0.6, 0.03), side * 0.2, 1.62, -0.095); T(metals.darkMetal, bx(0.435, 0.035, 0.03), 0, 1.62 + side * 0.3, -0.095); }
    T(litGlass, plane(0.37, 0.57), 0, 1.62, -0.098);
    T(metals.brushed, bx(1.0, 0.24, 0.008), 0, 0.16, -0.102);
    T(metals.brushed, bx(0.055, 0.22, 0.012), 0.42, 1.06, -0.1);
    T(metals.brushed, cylZ(0.014, 0.014, 0.06, 8), 0.42, 1.08, -0.07);
    T(metals.brushed, cylX(0.013, 0.013, 0.15, 8), 0.355, 1.08, -0.042);
    T(metals.darkMetal, cyl(0.012, 0.012, 0.03, 8), 0.42, 0.99, -0.092, [PI / 2, 0, 0]);
    for (const y of [0.3, 1.1, 1.9]) T(metals.brushed, cyl(0.016, 0.016, 0.12, 8), -0.555, y, -0.092);
    T(metals.darkMetal, bx(0.3, 0.055, 0.06), -0.3, 2.13, -0.075);
    T(metals.brushed, rod([-0.16, 2.12, -0.06], [0.2, 2.17, -0.04], 0.008), 0, 0, 0);
    T(metals.brushed, bx(1.1, 0.02, 0.22), 0, 0.01, -0.06);
    T(snow, pad(1.0, 0.07, 0.14), 0.05, 0.03, -0.04);
    if (plate) {
      T(metals.darkMetal, bx(0.38, 0.38, 0.012), 0.9, 2, 0.006);
      T(labels, label(plate, 0.34, 0.34), 0.9, 2, 0.016);
    }
    // Canopy with its lamp.
    T(metals.darkMetal, bx(1.7, 0.05, 0.75), 0, 2.5, 0.36, [0.08, 0, 0], null, { shadow: true, fine: false });
    for (const side of [-1, 1]) T(metals.darkMetal, rod([side * 0.8, 2.48, 0.7], [side * 0.8, 2.1, 0.02], 0.014), 0, 0, 0);
    T(snow, pad(1.76, 0.2, 0.8), 0, 2.6, 0.37, [0.08, 0, 0]);
    for (let x = -0.82; x < 0.82; x += 0.07 + random() * 0.2) hang(...toWorld(F, x, 2.44, 0.72), 0.06 + Math.pow(random(), 2) * 0.4, 0.8);
    T(metals.darkMetal, rb(0.42, 0.1, 0.16, 0.02), 0, 2.38, 0.1);
    T(sodium, bx(0.34, 0.03, 0.1), 0, 2.325, 0.1);
    halo(toWorld(F, 0, 2.28, 0.16), 1.5, 0xffa758, 0.55);
    const foot = toWorld(F, 0, 0, 0.9);
    pools.push({ position: [foot[0], 0.014, foot[2]], rotation: [-PI / 2, 0, 0], scale: [3.4, 3.4, 1] });
    pools.push({ position: toWorld(F, 0, 1.5, 0.004), rotation: [0, Math.atan2(F.elements[8], F.elements[10]), 0], scale: [2.6, 2.6, 1] });
  };

  // ---- Habitat block (-x): two storeys of insulated cabins -----------------
  const sideRun = SIDE_TO - SIDE_FROM, sideZ = (SIDE_FROM + SIDE_TO) / 2;
  const upstairs = [-26.8, -24.2, -21.25, -18.4, -15.5, -12.7, -9.75, -6.95, -3.9, -1.3];
  const upstairsKind = [0, -1, 1, 0, 2, -1, 0, 1, -1, 0];
  const downstairs: Array<[number, number]> = [[-26.8, 0], [-24.2, 1], [-1.3, 2]];
  const habDoorZ = -3.9;
  {
    const holes = [
      ...upstairs.map((z) => ({ x: sideZ - z, width: 1.1, spring: 4.8, sill: 3.8, flat: true })),
      ...downstairs.map(([z]) => ({ x: sideZ - z, width: 1.1, spring: 2.25, sill: 1.25, flat: true })),
      { x: sideZ - habDoorZ, width: 1.1, spring: 2.34, flat: true },
    ];
    WH(panelOrange, archedWall(sideRun, HAB_TOP, 0.3, holes, 2.6), -9.69, 0, sideZ, [0, PI / 2, 0]);
    WH(panelOrange, worldBox(3.44, HAB_TOP, sideRun, 2.6), -13.74, HAB_TOP / 2, sideZ);
    for (const z of [SIDE_FROM + 0.15, SIDE_TO - 0.15]) WH(panelOrange, worldBox(2.06, HAB_TOP, 0.3, 2.6), -10.87, HAB_TOP / 2, z);
    // Behind the door leaf.
    W(roomDark, bx(0.05, 2.3, 1.3), -9.86, 1.15, habDoorZ);
  }
  W(metals.darkMetal, rb(0.1, 0.34, habDoorZ - 0.75 - SIDE_FROM, 0.02, 2.2), -9.5, 0.17, (SIDE_FROM + habDoorZ - 0.75) / 2, null, null, { hit: true, fine: false });
  W(metals.darkMetal, rb(0.1, 0.34, SIDE_TO - habDoorZ - 0.75, 0.02, 2.2), -9.5, 0.17, (SIDE_TO + habDoorZ + 0.75) / 2, null, null, { hit: true, fine: false });
  W(metals.darkMetal, rb(0.07, 0.16, sideRun, 0.02, 2.2), -9.52, 2.85, sideZ);
  W(metals.darkMetal, rb(0.09, 0.2, sideRun + 0.1, 0.02, 2.2), -9.51, HAB_TOP - 0.1, sideZ);
  const moduleZ = Array.from({ length: 6 }, (_, i) => SIDE_FROM + 0.1 + i * (sideRun - 0.2) / 5);
  for (const z of moduleZ) if (Math.abs(z - habDoorZ) > 0.9) W(metals.darkMetal, rb(0.09, HAB_TOP, 0.18, 0.02, 2.2), -9.515, HAB_TOP / 2, z);
  // Panel joints: a pressed cover strip every 1.2 m, clear of the openings.
  const clearOf = (z: number, spots: number[], gap: number) => spots.every((spot) => Math.abs(z - spot) > gap);
  {
    const lower: Transform[] = [], upper: Transform[] = [], fixings: Transform[] = [];
    for (let z = SIDE_FROM + 0.7; z < SIDE_TO - 0.3; z += 1.19) {
      if (!clearOf(z, moduleZ, 0.25)) continue;
      if (clearOf(z, [...downstairs.map(([spot]) => spot), habDoorZ], 0.72)) lower.push({ position: [-9.53, 1.56, z] });
      if (clearOf(z, upstairs, 0.7)) upper.push({ position: [-9.53, 4.3, z] });
      for (const y of [0.5, 2.6, 3.1, 5.4]) fixings.push({ position: [-9.515, y, z], rotation: [0, 0, PI / 2] });
    }
    inst(bx(0.03, 2.42, 0.07), panelOrange, lower);
    inst(bx(0.03, 2.7, 0.07), panelOrange, upper);
    if (high) inst(cyl(0.016, 0.016, 0.03, 6), metals.brushed, fixings);
  }
  // Roof: a season of snow, a cornice curled over the eave, gutter and downpipes under it.
  WS(snow, pad(6.1, 0.4, sideRun + 0.5), -12.55, HAB_TOP + 0.16, sideZ);
  WS(snow, corniceGeometry(sideRun + 0.4, 5), -9.5, HAB_TOP, sideZ);
  drift(sideRun - 1, 4.6, 0.5, -12.6, sideZ, PI / 2, 0.42, HAB_TOP + 0.34);
  const gutter = new THREE.CylinderGeometry(0.075, 0.075, sideRun, 8, 1, true, PI / 2, PI).rotateX(PI / 2);
  for (const side of [-1, 1]) {
    const top = side < 0 ? HAB_TOP : SHED_TOP;
    W(metals.brushed, gutter, side * 9.43, top - 0.26, sideZ);
    W(snow, pad(0.13, 0.07, sideRun - 0.2), side * 9.43, top - 0.27, sideZ);
    inst(bx(0.11, 0.02, 0.03), metals.darkMetal, Array.from({ length: 16 }, (_, i) => ({ position: [side * 9.48, top - 0.33, SIDE_FROM + 0.6 + i * 1.86] as V3 })));
    for (const z of [SIDE_FROM + 0.32, SIDE_TO - 0.3]) {
      W(metals.brushed, tube([[side * 9.43, top - 0.3, z], [side * 9.43, top - 0.45, z], [side * 9.5, top - 0.62, z], [side * 9.5, top - 0.9, z]], 0.045, 8, 12), 0, 0, 0);
      W(metals.brushed, cyl(0.045, 0.045, top - 1.1, 8), side * 9.5, (top - 0.9 + 0.2) / 2, z);
      W(metals.brushed, tube([[side * 9.5, 0.24, z], [side * 9.5, 0.14, z], [side * 9.42, 0.07, z], [side * 9.3, 0.05, z]], 0.045, 8, 10), 0, 0, 0);
      for (const y of [1.2, 2.6, top - 1.1]) W(metals.darkMetal, bx(0.06, 0.03, 0.13), side * 9.52, y, z);
      // Meltwater refrozen where the pipe empties.
      W(ice, ball(1, 10, 5), side * 9.2, 0, z, null, [0.3, 0.03, 0.22]);
    }
    eave("z", side * 9.4, SIDE_FROM, SIDE_TO, top - 0.33, side < 0 ? 0.2 : 0.24);
  }
  // Stove pipes with cowls and storm collars.
  const pipes: V3[] = [[-11.6, HAB_TOP, -6.2], [-11.9, HAB_TOP, -20.4]];
  for (const [x, y, z] of pipes) {
    WS(metals.brushed, cyl(0.11, 0.11, 1.6, 12), x, y + 0.8, z);
    W(metals.darkMetal, cyl(0.15, 0.2, 0.12, 12), x, y + 0.55, z);
    W(metals.darkMetal, cyl(0.03, 0.24, 0.16, 12), x, y + 1.78, z);
    for (let leg = 0; leg < 3; leg += 1) W(metals.darkMetal, bx(0.015, 0.14, 0.03), x + Math.sin(leg * 2.1) * 0.11, y + 1.65, z + Math.cos(leg * 2.1) * 0.11);
    for (const turn of [0.6, 2.7, 4.8]) W(cableMaterial, rod([x, y + 1.3, z], [x + Math.sin(turn) * 0.9, y + 0.42, z + Math.cos(turn) * 0.9], 0.006, 4), 0, 0, 0);
    plumes.push({ at: [x, y + 1.9, z], size: 1 });
  }
  // Solar panels racked along the eave, half cleared.
  for (const z of [-27, -24.9, -22.8, -17.4, -15.3, -13.2, -3.4, -1.3]) {
    const F = frame(-10.95, HAB_TOP + 1.02, z, 0, 0, -0.75), T = mk(F);
    T(metals.brushed, bx(1.16, 0.04, 1.96), 0, 0, 0, null, null, { shadow: true, fine: false });
    T(solar, bx(1.1, 0.012, 1.9), 0, 0.024, 0);
    const covered = 0.25 + random() * 0.45;
    T(snow, pad(covered * 1.1, 0.07, 1.9), 0.55 - covered * 0.55, 0.05, 0);
    for (const along of [-0.8, 0.8]) {
      W(metals.structural, rod([-11.33, HAB_TOP + 0.3, z + along], [-11.33, HAB_TOP + 1.36, z + along], 0.018), 0, 0, 0);
      W(metals.structural, rod([-10.58, HAB_TOP + 0.3, z + along], [-10.58, HAB_TOP + 0.66, z + along], 0.018), 0, 0, 0);
      W(metals.structural, rod([-11.33, HAB_TOP + 0.8, z + along], [-10.58, HAB_TOP + 0.4, z + along], 0.012), 0, 0, 0);
    }
  }
  // Wall furniture. Conduit runs under the storey rail and the eave, with boxes where it drops.
  W(metals.brushed, cylZ(0.022, 0.022, sideRun - 0.8, 6), -9.5, 5.28, sideZ);
  W(metals.brushed, cylZ(0.016, 0.016, sideRun - 0.8, 6), -9.5, 5.2, sideZ);
  inst(bx(0.03, 0.14, 0.04), metals.darkMetal, Array.from({ length: 20 }, (_, i) => ({ position: [-9.51, 5.24, SIDE_FROM + 0.9 + i * 1.42] as V3 })));
  for (const [z, drop] of [[-8.3, 2.3], [-19.95, 1.9], [-2.9, 2.7], [-22.9, 4.5]]) {
    W(metals.brushed, cyl(0.02, 0.02, drop, 6), -9.5, 5.2 - drop / 2, z);
    W(metals.darkMetal, rb(0.07, 0.16, 0.16, 0.012), -9.5, 5.2 - drop, z);
    W(metals.darkMetal, rb(0.07, 0.12, 0.12, 0.012), -9.5, 5.24, z);
  }
  // Meter cabinet, heater flues low on the wall, a thermometer screen.
  W(paintPale, rb(0.2, 0.75, 0.55, 0.015), -9.43, 1.35, -7.55, null, null, { hit: true, fine: false });
  W(metals.darkMetal, bx(0.012, 0.6, 0.012), -9.325, 1.35, -7.55);
  W(metals.brushed, bx(0.02, 0.06, 0.03), -9.32, 1.35, -7.4);
  W(metals.brushed, cyl(0.02, 0.02, 3.5, 6), -9.5, 3.45, -7.55);
  W(snow, pad(0.24, 0.07, 0.6), -9.43, 1.76, -7.55);
  for (const z of [-22.9, -6.4]) {
    const F = frame(-9.54, 0.62, z, PI / 2), T = mk(F);
    T(metals.brushed, cylZ(0.07, 0.07, 0.3, 10), 0, 0, 0.12);
    T(metals.darkMetal, cylZ(0.1, 0.1, 0.03, 10), 0, 0, 0.015);
    T(metals.brushed, tube([[0, 0, 0.24], [0, 0.03, 0.31], [0, 0.12, 0.34], [0, 0.26, 0.34]], 0.07, 8, 10), 0, 0, 0);
    T(metals.darkMetal, cyl(0.02, 0.11, 0.07, 10), 0, 0.31, 0.34);
    T(ice, ball(1, 8, 5), 0, -0.6, 0.34, null, [0.2, 0.025, 0.2]);
    hang(...toWorld(F, 0, -0.07, 0.12), 0.2, 0.9);
    plumes.push({ at: toWorld(F, 0, 0.42, 0.34), size: 0.12 });
  }
  // Skis and poles racked by the door, shovels and axes within reach, a bench under the last window.
  {
    const F = frame(-9.54, 0, -5.25, PI / 2), T = mk(F);
    for (const y of [0.55, 1.35]) { T(metals.darkMetal, bx(1.1, 0.04, 0.04), 0, y, 0.16); for (const side of [-1, 1]) T(metals.darkMetal, bx(0.03, 0.03, 0.16), side * 0.52, y, 0.08); }
    const ski = skiGeometry(1.75, 0.085, 0.012, 0.12);
    [paintRed, paintRed, paintPale, paintPale, paintOrange, paintOrange].forEach((paint, index) => {
      const x = -0.44 + index * 0.13 + (index % 2) * 0.02;
      T(paint, ski, x, 0.9, 0.2 + (index % 2) * 0.022, [PI / 2 - 0.05, PI / 2, 0], null, { shadow: true, fine: false });
    });
    for (let pole = 0; pole < 4; pole += 1) {
      const x = 0.36 + pole * 0.045;
      T(metals.brushed, rod([x, 0.03, 0.24], [x + 0.01, 1.42, 0.19], 0.008, 5), 0, 0, 0);
      T(rubber, cyl(0.014, 0.012, 0.14, 6), x + 0.01, 1.44, 0.19);
      T(rubber, cyl(0.05, 0.05, 0.008, 8), x, 0.12, 0.237);
    }
    T(snow, pad(1.1, 0.06, 0.1), 0, 1.4, 0.16);
  }
  const shovel = (F: THREE.Matrix4, paint: THREE.Material) => {
    const T = mk(F);
    T(planks, cyl(0.016, 0.016, 1.05, 6), 0, 0.85, 0);
    T(paint, rod([-0.07, 1.38, 0], [0.07, 1.38, 0], 0.015), 0, 0, 0);
    T(paint, bx(0.03, 0.1, 0.02), 0, 1.36, 0);
    T(metals.brushed, rb(0.26, 0.36, 0.02, 0.008), 0, 0.2, 0.012, [0.12, 0, 0]);
    T(metals.brushed, bx(0.26, 0.03, 0.045), 0, 0.37, 0.01);
  };
  shovel(frame(-9.4, 0, -2.85, PI / 2, -0.085), paintRed);
  shovel(frame(-9.37, 0, -2.55, PI / 2 + 0.2, -0.08, 0.06), paintOrange);
  {
    const F = frame(-9.54, 1.5, -2.25, PI / 2), T = mk(F);
    T(metals.darkMetal, bx(0.4, 0.03, 0.03), 0, 0.3, 0.02);
    for (const x of [-0.12, 0.1]) {
      T(metals.brushed, cyl(0.011, 0.011, 0.62, 6), x, 0, 0.04);
      T(metals.brushed, bx(0.24, 0.022, 0.012), x + 0.03, 0.3, 0.04, [0, 0, -0.12]);
      T(metals.brushed, bx(0.07, 0.05, 0.01), x - 0.1, 0.29, 0.04);
      T(paintOrange, cyl(0.014, 0.014, 0.2, 6), x, -0.2, 0.04);
    }
  }
  {
    const F = frame(-9.3, 0, -1.3, PI / 2), T = mk(F, { shadow: true, fine: false });
    for (const z of [-0.09, 0.09]) T(planks, bx(1.3, 0.035, 0.15, 0.9), 0, 0.46, z);
    for (const x of [-0.55, 0.55]) T(planks, bx(0.05, 0.45, 0.3, 0.9), x, 0.225, 0);
    T(snow, pad(1.24, 0.09, 0.3), 0, 0.51, 0, null, null, { shadow: false, fine: true });
  }
  // Windows and the door.
  upstairs.forEach((z, index) => windowAt("+x", -9.54, z, 4.3, 1.1, 1.0, upstairsKind[index]));
  downstairs.forEach(([z, kind]) => windowAt("+x", -9.54, z, 1.75, 1.1, 1.0, kind));
  {
    const F = frame(-9.54, 0.14, habDoorZ, PI / 2), T = mk(F);
    door(F, paintPale, "hab");
    // Porch: checker plate on a frame, a rail either side, a scraper.
    T(deck, bx(1.54, 0.04, 0.58, 0.8), 0, -0.02, 0.29, null, null, { shadow: true, fine: false });
    for (const side of [-1, 1]) {
      T(metals.structural, bx(0.05, 0.11, 0.48), side * 0.72, -0.085, 0.265);
      T(metals.structural, tube([[side * 0.74, -0.1, 0.5], [side * 0.74, 0.86, 0.5], [side * 0.74, 0.95, 0.42], [side * 0.74, 0.95, 0.02]], 0.02, 6, 14), 0, 0, 0);
      T(metals.structural, rod([side * 0.74, 0.45, 0.5], [side * 0.74, 0.45, 0.02], 0.014), 0, 0, 0);
      T(snow, pad(0.07, 0.05, 0.4), side * 0.74, 0.985, 0.22);
    }
    T(metals.structural, bx(1.5, 0.11, 0.05), 0, -0.085, 0.53);
    T(snow, pad(0.5, 0.06, 0.3), -0.45, 0.012, 0.36);
    T(metals.darkMetal, bx(0.3, 0.1, 0.03), 0.95, -0.09, 0.3);
  }

  // ---- Machine shed (+x) ---------------------------------------------------
  const doorZ = -4.5;
  WH(iron, archedWall(sideRun, SHED_TOP, 0.3, [{ x: doorZ - sideZ, width: 3.6, spring: 3.3, flat: true }], 2.4), 9.69, 0, sideZ, [0, -PI / 2, 0]);
  // Solid cores either side of the workshop and behind it; each stops 6 cm short of the workshop's lining.
  WH(iron, worldBox(5.82, SHED_TOP, doorZ - 2.66 - SIDE_FROM, 2.4), 12.75, SHED_TOP / 2, (SIDE_FROM + doorZ - 2.66) / 2);
  WH(iron, worldBox(5.82, SHED_TOP, SIDE_TO - doorZ - 2.66, 2.4), 12.75, SHED_TOP / 2, (SIDE_TO + doorZ + 2.66) / 2);
  WH(iron, worldBox(2.46, SHED_TOP, 5.32, 2.4), 14.43, SHED_TOP / 2, doorZ);
  for (const [from, to] of [[SIDE_FROM, -13.7], [-9.5, -6.45], [-2.55, SIDE_TO]]) {
    W(metals.darkMetal, rb(0.1, 0.34, to - from, 0.02, 2.2), 9.5, 0.17, (from + to) / 2, null, null, { hit: true, fine: false });
  }
  W(metals.darkMetal, rb(0.09, 0.2, sideRun + 0.1, 0.02, 2.2), 9.51, SHED_TOP - 0.1, sideZ);
  for (const z of [SIDE_FROM + 0.1, -20.6, -14.2, -8.9, SIDE_TO - 0.1]) W(metals.darkMetal, rb(0.09, SHED_TOP, 0.18, 0.02, 2.2), 9.515, SHED_TOP / 2, z);
  WS(snow, pad(6.3, 0.38, sideRun + 0.5), 12.65, SHED_TOP + 0.15, sideZ);
  WS(snow, corniceGeometry(sideRun + 0.4, 23), 9.5, SHED_TOP, sideZ, [0, PI, 0]);
  drift(sideRun - 1, 4.8, 0.45, 12.7, sideZ, PI / 2, 0.6, SHED_TOP + 0.32);
  // Sectional door, run up to head height: the workshop shows under it.
  {
    const F = frame(9.54, 0, doorZ, -PI / 2), T = mk(F), TS = mk(F, { shadow: true, fine: false }), TH = mk(F, { shadow: true, fine: false, hit: true }), S = putIn(F);
    for (const side of [-1, 1]) {
      // Jambs stand 2 cm into the opening and stop under the head.
      TS(metals.darkMetal, rb(0.16, 3.28, 0.36, 0.015), side * 1.86, 1.64, -0.13);
      T(hazard, bx(0.172, 1.1, 0.372, 0.5), side * 1.86, 0.56, -0.13);
      T(metals.brushed, bx(0.05, 3.3, 0.07), side * 1.77, 1.65, -0.24);
      T(metals.brushed, tube([[side * 1.77, 3.2, -0.24], [side * 1.77, 3.42, -0.3], [side * 1.77, 3.55, -0.5], [side * 1.77, 3.56, -0.8]], 0.03, 5, 10), 0, 0, 0);
      T(metals.brushed, bx(0.05, 0.06, 2.3), side * 1.77, 3.56, -1.95);
      T(metals.darkMetal, rod([side * 1.77, 3.6, -3.0], [side * 1.77, 3.9, -3.0], 0.012), 0, 0, 0);
      T(metals.darkMetal, cylX(0.09, 0.09, 0.07, 12), side * 1.7, 3.72, -0.34);
    }
    TS(metals.darkMetal, rb(3.88, 0.18, 0.36, 0.015), 0, 3.37, -0.13);
    T(metals.brushed, cylX(0.02, 0.02, 3.5, 8), 0, 3.72, -0.34);
    for (const x of [-0.7, 0.7]) T(metals.darkMetal, cylX(0.05, 0.05, 0.7, 10), x, 3.72, -0.34);
    const open = 1.72, panel = 0.55;
    for (let i = 0; i < 3; i += 1) {
      const y = open + panel * (i + 0.5);
      if (y + panel / 2 > 3.36) break;
      TH(paintPale, rb(3.5, panel - 0.02, 0.05, 0.012), 0, y, -0.235);
      for (const rib of [-0.13, 0.13]) T(paintPale, bx(3.46, 0.03, 0.012), 0, y + rib, -0.205);
      for (const x of [-1.72, -0.58, 0.58, 1.72]) T(metals.brushed, bx(0.045, 0.12, 0.012), x, y + panel / 2, -0.268);
    }
    // The lowest panel in view carries the lights.
    for (let i = 0; i < 4; i += 1) {
      const x = -1.2 + i * 0.8, y = open + panel * 0.5;
      T(metals.darkMetal, rb(0.52, 0.3, 0.02, 0.008), x, y, -0.2);
      T(darkGlass, bx(0.44, 0.22, 0.012), x, y, -0.193);
    }
    T(rubber, rb(3.5, 0.07, 0.07, 0.03), 0, open - 0.02, -0.235);
    T(metals.brushed, rb(0.3, 0.04, 0.05, 0.012), 0, open + 0.1, -0.19);
    T(snow, pad(3.4, 0.05, 0.06), 0, open + 0.02, -0.195);
    for (let x = -1.7; x < 1.7; x += 0.1 + random() * 0.35) hang(...toWorld(F, x, open - 0.05, -0.22), 0.04 + random() * 0.16, 0.7);
    // Panels already over the bend lie on the horizontal track.
    for (let i = 0; i < 3; i += 1) T(paintPale, rb(3.5, 0.05, panel - 0.02, 0.012), 0, 3.5, -0.75 - panel * i);
    T(metals.darkMetal, rb(0.3, 0.2, 0.42, 0.02), 0, 3.72, -3.1);
    T(metals.brushed, bx(0.05, 0.04, 2.7), 0, 3.68, -1.7);
    // Lamp over the door.
    T(metals.darkMetal, rb(0.5, 0.16, 0.14, 0.03), 0, 3.82, 0.07);
    T(sodium, bx(0.4, 0.09, 0.04), 0, 3.8, 0.14);
    halo(toWorld(F, 0, 3.78, 0.22), 2.2, 0xffa758, 0.6);
    T(snow, pad(0.54, 0.07, 0.18), 0, 3.93, 0.07);
    T(metals.darkMetal, bx(0.44, 0.44, 0.012), 2.35, 1.62, 0.006);
    T(labels, label("workshop", 0.4, 0.4), 2.35, 1.62, 0.016);
    // Threshold plate and the snow the door has pushed aside.
    T(deck, bx(3.6, 0.03, 0.6, 0.9), 0, 0.015, -0.1);
    T(snow, pad(3.3, 0.05, 0.2), 0.1, 0.02, 0.16);
    // The workshop itself.
    const wide = 5.2, tall = 3.9, D = 3.3, back = -0.3 - D, zc = -0.3 - D / 2;
    T(shopWall, plane(wide, tall), 0, tall / 2, back);
    T(shopWall, plane(D, tall), -wide / 2, tall / 2, zc, [0, PI / 2, 0]);
    T(shopWall, plane(D, tall), wide / 2, tall / 2, zc, [0, -PI / 2, 0]);
    T(roomDark, plane(wide, D), 0, tall, zc, [PI / 2, 0, 0]);
    T(shopFloor, plane(wide, D + 0.3), 0, 0.004, zc + 0.15, [-PI / 2, 0, 0]);
    T(roomDark, bx(0.8, tall, 0.02), -2.2, tall / 2, -0.31); T(roomDark, bx(0.8, tall, 0.02), 2.2, tall / 2, -0.31);
    for (const x of [-1.3, 1.3]) { T(roomDark, rb(1.3, 0.07, 0.2, 0.02), x, 3.42, -2.0); T(tubeLight, bx(1.2, 0.03, 0.12), x, 3.38, -2.0); for (const end of [-0.55, 0.55]) T(roomDark, rod([x + end, 3.45, -2.0], [x + end, 3.9, -2.0], 0.006, 4), 0, 0, 0); }
    // Bench with a vice, tool board over it.
    const benchX = -1.25, benchZ = back + 0.4;
    T(planks, rb(2.3, 0.07, 0.72, 0.012, 1), benchX, 0.9, benchZ);
    for (const x of [-1.08, 1.08]) for (const z of [-0.3, 0.3]) T(roomDark, bx(0.06, 0.88, 0.06), benchX + x, 0.44, benchZ + z);
    T(roomDark, bx(2.2, 0.04, 0.62), benchX, 0.28, benchZ);
    T(paintRed, rb(0.62, 0.42, 0.56, 0.015), benchX + 0.72, 0.62, benchZ + 0.02);
    for (const y of [0.5, 0.62, 0.74]) T(metals.brushed, bx(0.3, 0.015, 0.012), benchX + 0.72, y, benchZ + 0.305);
    T(metals.structural, rb(0.14, 0.12, 0.3, 0.02), benchX - 0.8, 1.0, benchZ + 0.22);
    T(metals.structural, bx(0.16, 0.1, 0.04), benchX - 0.8, 1.08, benchZ + 0.3); T(metals.structural, bx(0.16, 0.1, 0.04), benchX - 0.8, 1.08, benchZ + 0.2);
    T(metals.brushed, cylX(0.008, 0.008, 0.24, 5), benchX - 0.8, 1.02, benchZ + 0.39);
    T(roomWood, bx(2.2, 1.1, 0.03), benchX, 1.8, back + 0.03);
    if (high) {
      const next = rng(515);
      for (let i = 0; i < 9; i += 1) T(metals.brushed, bx(0.035, 0.22 + next() * 0.2, 0.012), benchX - 0.95 + i * 0.13, 2.02 - next() * 0.05, back + 0.055, [0, 0, (next() - 0.5) * 0.2]);
      T(paintOrange, bx(0.5, 0.14, 0.012), benchX + 0.55, 2.05, back + 0.055, [0, 0, 0.15]); T(metals.brushed, bx(0.42, 0.09, 0.008), benchX + 0.62, 2.0, back + 0.06, [0, 0, 0.15]);
      for (let i = 0; i < 4; i += 1) { T(planks, cyl(0.014, 0.014, 0.26, 6), benchX + 0.2 + i * 0.16, 1.55, back + 0.06); T(metals.structural, bx(0.09, 0.035, 0.03), benchX + 0.2 + i * 0.16, 1.69, back + 0.06); }
      for (const [x, z, size] of [[-0.3, -0.1, 1.5], [-0.17, -0.17, 1.2], [-0.42, 0.04, 1.2]]) S("tin", benchX + x, 0.935, benchZ + z, x * 40, { scale: [size, size, size] });
      T(roomDark, rb(0.34, 0.16, 0.2, 0.02), benchX + 0.2, 1.015, benchZ + 0.05);
    }
    // Racking down the right wall: spares in cartons, fuel cans, tins of grease. Gas bottles and a track roll on the left.
    for (const z of [-1.1, -2.2, -3.3]) T(roomDark, bx(0.04, 2.5, 0.04), 2.5, 1.25, z + 0.0);
    for (const z of [-1.1, -2.2, -3.3]) T(roomDark, bx(0.04, 2.5, 0.04), 2.1, 1.25, z);
    for (const y of [0.35, 1.0, 1.65, 2.3]) T(roomWood, bx(0.46, 0.03, 2.3), 2.3, y, -2.2);
    {
      // Each entry: kind, place along the shelf, yaw off square, height above the shelf. Everything faces the bench.
      const out = -PI / 2, fuelCan = (paint: THREE.Material, y: number, z: number) => T(paint, rb(0.16, 0.44, 0.33, 0.025), 2.3, y + 0.235, z);
      const shelves: Array<[number, Array<[PropKind, number, number, number?]>]> = [
        [0.365, [["cartonLarge", -2.92, 0.06], ["cartonLarge", -2.2, -0.1], ["carton", -2.16, 0.3, 0.42], ["cartonTall", -1.36, 0.12]]],
        [1.015, [["carton", -3.02, -0.08], ["cartonFlat", -3.0, 0.2, 0.32], ["carton", -2.46, 0.14], ["cartonSmall", -1.3, 0.3], ["cartonSmall", -1.32, -0.25, 0.2]]],
        [1.665, [["cartonTall", -3.1, 0.1], ["cartonSmall", -2.76, -0.2], ["cartonFlat", -1.5, 0.07], ["cartonFlat", -1.48, -0.12, 0.12], ["cartonFlat", -1.51, 0.2, 0.24]]],
        [2.315, [["cartonLarge", -2.9, -0.07], ["cartonFlat", -1.95, 0.1], ["carton", -1.36, 0.22]]],
      ];
      for (const [y, row] of shelves) for (const [kind, z, turn, lift = 0] of row) S(kind, 2.3, y + lift, z, out + turn);
      fuelCan(paintRed, 0.35, -1.72); fuelCan(paintRed, 1.65, -2.4); fuelCan(paintPale, 1.65, -2.04);
      // Grease tins: a block on the middle shelf with a second tier begun, three strays on the top one.
      const grease: Look = { scale: [1.5, 2, 1.5], variant: 1 };
      for (let i = 0; i < 8; i += 1) S("tin", 2.24 + (i % 2) * 0.12, 1.015, -2.02 + Math.floor(i / 2) * 0.125, i * 2.3, grease);
      S("tin", 2.24, 1.215, -1.957, 1.1, grease); S("tin", 2.365, 1.215, -1.76, 4.2, grease);
      for (const [x, z] of [[2.22, -2.5], [2.35, -2.48], [2.29, -2.37]]) S("tin", x, 2.315, z, x * 31, { ...grease, variant: 3 });
    }
    for (const z of [-2.9, -2.55]) {
      T(z < -2.7 ? paintRed : paintPale, cyl(0.115, 0.115, 1.25, 12), -2.42, 0.63, z);
      T(z < -2.7 ? paintRed : paintPale, cap(0.115, 12, 4), -2.42, 1.255, z);
      T(metals.brushed, cyl(0.03, 0.03, 0.14, 6), -2.42, 1.42, z);
    }
    T(metals.brushed, bx(0.02, 0.03, 0.75), -2.3, 0.95, -2.72);
    for (let i = 0; i < 3; i += 1) T(rubber, new THREE.TorusGeometry(0.3, 0.11, 8, 18), -2.15, 0.11 + i * 0.22, -1.2, [PI / 2, 0, 0]);
    // Chain hoist on a runway beam.
    T(metals.structural, bx(wide, 0.16, 0.1), 0, 3.82, -1.35);
    T(paintOrange, rb(0.24, 0.2, 0.3, 0.03), 0.4, 3.62, -1.35);
    T(metals.brushed, cyl(0.008, 0.008, 1.2, 4), 0.4, 2.95, -1.35);
    T(metals.structural, new THREE.TorusGeometry(0.05, 0.014, 5, 10, PI * 1.4), 0.4, 2.3, -1.35, [0, 0, 2.2]);
    snowmobile(mk(F.clone().multiply(frame(0.55, 0.0, -1.75, 2.3))), mk(F.clone().multiply(frame(0.55, 0.0, -1.75, 2.3))), paintOrange, false);
  }
  // Bollards either side.
  hazardMap.repeat.set(1, 1);
  for (const z of [-6.75, -2.25]) {
    W(hazard, new THREE.CylinderGeometry(0.085, 0.085, 1.05, 14), 9.2, 0.52, z, null, null, { hit: true, shadow: true, fine: false });
    W(metals.darkMetal, cyl(0.12, 0.13, 0.05, 14), 9.2, 0.025, z);
    W(snow, cap(0.1, 12, 4), 9.2, 1.04, z, null, [1, 0.7, 1]);
  }
  // Clerestory lights over the signs, framed and split by mullions.
  const clerestory = Array.from({ length: 6 }, (_, i) => -27 + i * 2.3).filter((z) => z < -14.6);
  for (const z of clerestory) {
    W(metals.darkMetal, bx(0.08, 0.62, 1.84), 9.51, 4.22, z);
    W(tubeLight, bx(0.03, 0.46, 1.68), 9.48, 4.22, z);
    for (const m of [-0.42, 0.42]) W(metals.darkMetal, bx(0.05, 0.46, 0.035), 9.47, 4.22, z + m);
    W(metals.darkMetal, bx(0.12, 0.03, 1.9), 9.47, 3.9, z);
    W(snow, pad(0.12, 0.06, 1.8), 9.46, 3.94, z);
    for (let along = z - 0.9; along < z + 0.9; along += 0.12 + random() * 0.4) hang(9.43, 3.885, along, 0.05 + random() * 0.2, 0.7);
  }
  // Exhaust stacks with rain caps.
  const stacks: V3[] = [[11.2, SHED_TOP, -8.2], [11.2, SHED_TOP, -7.4]];
  for (const [x, y, z] of stacks) {
    WS(metals.brushed, cyl(0.13, 0.13, 2.0, 12), x, y + 1.0, z);
    W(metals.darkMetal, cyl(0.17, 0.22, 0.14, 12), x, y + 0.5, z);
    W(metals.darkMetal, cyl(0.2, 0.2, 0.02, 12), x - 0.06, y + 2.08, z, [0, 0, 0.5]);
  }
  plumes.push({ at: [11.2, SHED_TOP + 2.1, -7.8], size: 1.2 }, { at: [9.28, 5.9, -10.55], size: 1.1 });
  // Wall furniture: a fire point, a heat exchanger on brackets, a fan cowl, cable tray under the eave.
  {
    const F = frame(9.54, 0, -1.15, -PI / 2), T = mk(F);
    T(paintRed, rb(0.5, 0.8, 0.2, 0.015), 0, 1.3, 0.1, null, null, { hit: true, fine: false });
    // A glazed front with the extinguisher behind it, frosted like every other pane out here.
    T(roomDark, bx(0.36, 0.52, 0.006), 0, 1.36, 0.204);
    for (const side of [-1, 1]) { T(metals.darkMetal, bx(0.02, 0.56, 0.13), side * 0.18, 1.36, 0.265); T(metals.darkMetal, bx(0.34, 0.02, 0.13), 0, 1.36 + side * 0.27, 0.265); }
    T(paintRed, cyl(0.055, 0.055, 0.32, 12), -0.04, 1.3, 0.265);
    T(paintRed, ball(0.055, 12, 6), -0.04, 1.46, 0.265);
    T(metals.darkMetal, cyl(0.018, 0.024, 0.07, 8), -0.04, 1.53, 0.265);
    T(metals.darkMetal, bx(0.1, 0.018, 0.03), -0.01, 1.565, 0.265);
    T(rubber, tube([[-0.04, 1.52, 0.27], [0.05, 1.5, 0.275], [0.085, 1.38, 0.275], [0.08, 1.2, 0.275]], 0.011, 5, 12), 0, 0, 0);
    glassPanes.push({ position: toWorld(F, 0, 1.36, 0.322), rotation: [0, -PI / 2, 0], scale: [0.34, 0.52, 1] });
    T(metals.brushed, bx(0.03, 0.1, 0.02), 0.225, 1.3, 0.21);
    T(snow, pad(0.54, 0.07, 0.24), 0, 1.73, 0.1);
    T(labels, label("fire", 0.36, 0.36), 0, 2.1, 0.006);
    T(paintRed, cyl(0.012, 0.012, 0.8, 6), 0.42, 1.25, 0.05); T(metals.brushed, bx(0.2, 0.09, 0.012), 0.47, 1.62, 0.05);
  }
  {
    const F = frame(9.54, 0, -8.05, -PI / 2), T = mk(F);
    T(paintPale, rb(1.0, 0.85, 0.36, 0.03), 0, 1.25, 0.24, null, null, { hit: true, shadow: true, fine: false });
    T(metals.darkMetal, cylZ(0.33, 0.33, 0.02, 20), -0.12, 1.25, 0.425);
    T(metals.brushed, new THREE.TorusGeometry(0.33, 0.014, 5, 20), -0.12, 1.25, 0.44);
    for (let ring = 1; ring < 4; ring += 1) T(metals.brushed, new THREE.TorusGeometry(ring * 0.085, 0.006, 4, 16), -0.12, 1.25, 0.445);
    for (let spoke = 0; spoke < 4; spoke += 1) T(metals.brushed, bx(0.66, 0.01, 0.008), -0.12, 1.25, 0.447, [0, 0, spoke * PI / 4]);
    for (const side of [-1, 1]) { T(metals.darkMetal, bx(0.04, 0.04, 0.42), side * 0.4, 0.8, 0.21); T(metals.darkMetal, rod([side * 0.4, 0.8, 0.4], [side * 0.4, 0.45, 0.02], 0.014), 0, 0, 0); }
    T(snow, pad(1.04, 0.1, 0.4), 0, 1.72, 0.24);
    T(metals.brushed, tube([[0.42, 1.5, 0.1], [0.62, 1.5, 0.06], [0.66, 1.9, 0.04], [0.66, 4.6, 0.04]], 0.018, 5, 16), 0, 0, 0);
    T(cableMaterial, tube([[0.42, 1.4, 0.1], [0.66, 1.38, 0.06], [0.72, 1.9, 0.04], [0.72, 4.6, 0.04]], 0.024, 5, 16), 0, 0, 0);
    for (let x = -0.45; x < 0.45; x += 0.1 + random() * 0.2) hang(...toWorld(F, x, 0.83, 0.4), 0.06 + random() * 0.25, 0.8);
  }
  {
    const F = frame(9.54, 4.15, -9.9, -PI / 2), T = mk(F);
    T(metals.darkMetal, cylZ(0.3, 0.3, 0.12, 18), 0, 0, 0.06);
    for (let slat = 0; slat < 6; slat += 1) T(metals.brushed, bx(0.56 * Math.sqrt(1 - Math.pow((slat - 2.5) / 3.2, 2)), 0.012, 0.07), 0, -0.22 + slat * 0.088, 0.13, [0.6, 0, 0]);
    T(snow, pad(0.5, 0.07, 0.14), 0, 0.3, 0.07);
  }
  W(metals.brushed, bx(0.05, 0.03, 12.5), 9.47, 4.68, -6.3);
  W(cableMaterial, cylZ(0.016, 0.016, 12.5, 5), 9.46, 4.71, -6.3); W(cableMaterial, cylZ(0.012, 0.012, 12.5, 5), 9.43, 4.705, -6.3);
  inst(bx(0.09, 0.05, 0.03), metals.darkMetal, Array.from({ length: 9 }, (_, i) => ({ position: [9.5, 4.66, -12.3 + i * 1.5] as V3 })));
  // Roof-edge rail on the shed, a hatch, a vent row.
  {
    const posts: Transform[] = [], caps: Transform[] = [];
    for (let z = SIDE_FROM + 0.8; z <= SIDE_TO - 0.4; z += 1.94) { posts.push({ position: [10.1, SHED_TOP + 0.85, z] }); caps.push({ position: [10.1, SHED_TOP + 1.42, z] }); }
    inst(cyl(0.022, 0.022, 1.1, 6), metals.structural, posts, true);
    inst(cap(0.05, 8, 3), snow, caps);
    for (const y of [0.85, 1.38]) WS(metals.structural, cylZ(0.02, 0.02, sideRun - 1.2, 6), 10.1, SHED_TOP + y, sideZ);
    W(snow, pad(0.06, 0.035, sideRun - 1.4), 10.1, SHED_TOP + 1.41, sideZ);
    for (const z of [-17.5, -12.2]) {
      WS(metals.darkMetal, rb(0.9, 0.5, 0.9, 0.03), 11.6, SHED_TOP + 0.5, z);
      W(snow, pad(0.96, 0.16, 0.96), 11.6, SHED_TOP + 0.8, z);
    }
    for (const z of [-3.2, -1.6]) { WS(metals.brushed, cyl(0.16, 0.16, 0.5, 12), 11.4, SHED_TOP + 0.55, z); W(metals.brushed, cap(0.24, 12, 4), 11.4, SHED_TOP + 0.8, z, null, [1, 0.6, 1]); W(snow, cap(0.2, 10, 3), 11.4, SHED_TOP + 0.93, z, null, [1, 0.5, 1]); }
  }

  // ---- Main building behind the firing line --------------------------------
  const mainWindows: Array<[number, number, number]> = [[-8.4, 1.95, 0], [-8.4, 5.6, 1], [8.4, 5.6, 2]];
  WH(panelPine, archedWall(20.8, MAIN_TOP, 0.3, [
    ...mainWindows.map(([x, y]) => ({ x, width: 1.5, spring: y + 0.6, sill: y - 0.6, flat: true })),
    { x: 8.4, width: 1.1, spring: 2.2, flat: true },
  ], 2.6), 0, 0, 9.85);
  WH(panelPine, worldBox(20.8, MAIN_TOP, 2.84, 2.6), 0, MAIN_TOP / 2, 13.58);
  for (const side of [-1, 1]) WH(panelPine, worldBox(0.3, MAIN_TOP, 2.16, 2.6), side * 10.25, MAIN_TOP / 2, 11.08);
  W(roomDark, bx(1.3, 2.3, 0.05), 8.4, 1.15, 10.02);
  W(metals.darkMetal, rb(18.4, 0.34, 0.1, 0.02, 2.2), -1.2, 0.17, 9.66, null, null, { hit: true, fine: false });
  W(metals.darkMetal, rb(1.3, 0.34, 0.1, 0.02, 2.2), 9.75, 0.17, 9.66);
  W(metals.darkMetal, rb(20.9, 0.2, 0.09, 0.02, 2.2), 0, MAIN_TOP - 0.1, 9.69);
  for (const x of [-10.3, -6.4, 6.4, 10.3]) W(metals.darkMetal, rb(0.18, MAIN_TOP, 0.09, 0.02, 2.2), x, MAIN_TOP / 2, 9.685);
  WS(snow, pad(21.2, 0.4, 5.5), 0, MAIN_TOP + 0.16, 12.6);
  WS(snow, corniceGeometry(21.4, 41), 0, MAIN_TOP, 9.9, [0, PI / 2, 0]);
  eave("x", 9.64, -10.4, 10.4, MAIN_TOP - 0.08, 0.22, 0.8);
  // Signal-orange band at the storey line, broken by the chart.
  for (const side of [-1, 1]) W(paintOrange, rb(3.9, 0.5, 0.05, 0.015, 1.6), side * 8.42, 3.62, 9.69);
  // Observation cabin on the roof, railed deck in front of it.
  WS(panelOrange, rb(7, 2.5, 3.6, 0.08, 2.6, 2), -3.2, MAIN_TOP + 1.45, 12.4);
  WS(snow, pad(7.4, 0.36, 4), -3.2, MAIN_TOP + 2.82, 12.4);
  WS(snow, corniceGeometry(7.2, 77), -3.2, MAIN_TOP + 2.66, 10.5, [0, PI / 2, 0], [0.6, 0.6, 1]);
  eave("x", 10.36, -6.7, 0.3, MAIN_TOP + 2.6, 0.3, 0.4);
  W(metals.structural, cyl(0.03, 0.04, 4.2, 6), 4.6, MAIN_TOP + 2.3, 12.2);
  W(metals.structural, cyl(0.02, 0.03, 3, 6), 5.4, MAIN_TOP + 1.7, 12.9);
  for (const x of [-5.4, -3.2, -1]) {
    W(metals.darkMetal, bx(1.76, 1.16, 0.1), x, MAIN_TOP + 1.6, 10.588);
    W(litGlass, plane(1.6, 1.0), x, MAIN_TOP + 1.6, 10.53, [0, PI, 0]);
    W(metals.darkMetal, bx(0.05, 1.0, 0.04), x, MAIN_TOP + 1.6, 10.52);
    W(snow, pad(1.8, 0.09, 0.14), x, MAIN_TOP + 1.07, 10.52);
  }
  {
    const posts: Transform[] = [], caps: Transform[] = [];
    for (let x = -10; x <= 10.01; x += 2) { posts.push({ position: [x, MAIN_TOP + 0.85, 10.25] }); caps.push({ position: [x, MAIN_TOP + 1.42, 10.25] }); }
    inst(cyl(0.022, 0.022, 1.1, 6), metals.structural, posts, true);
    inst(cap(0.05, 8, 3), snow, caps);
    for (const y of [0.85, 1.38]) WS(metals.structural, cylX(0.02, 0.02, 20, 6), 0, MAIN_TOP + y, 10.25);
    W(snow, pad(19.8, 0.035, 0.06), 0, MAIN_TOP + 1.41, 10.25);
    // Horn speakers and a floodlight on the cabin corner.
    for (const turn of [-0.5, 0.6]) {
      const F = frame(0.42, MAIN_TOP + 2.35, 10.62, PI + turn, 0.25), T = mk(F);
      T(paintPale, new THREE.CylinderGeometry(0.2, 0.04, 0.36, 14, 1, true).rotateX(PI / 2), 0, 0, 0.2);
      T(metals.darkMetal, cylZ(0.06, 0.06, 0.16, 8), 0, 0, -0.02);
    }
    W(metals.darkMetal, rb(0.36, 0.24, 0.14, 0.03), 0.42, MAIN_TOP + 1.85, 10.55);
    W(headlamp, bx(0.3, 0.18, 0.02), 0.42, MAIN_TOP + 1.85, 10.47);
    halo([0.42, MAIN_TOP + 1.85, 10.4], 2.6, 0xfff1d6, 0.55);
  }
  mainWindows.forEach(([x, y, kind]) => windowAt("-z", 9.7, x, y, 1.5, 1.2, kind));
  door(frame(8.4, 0, 9.7, PI), paintOrange, null);
  // By the door: the station plate and a notice board. On the other side: rescue gear on the wall.
  {
    const F = frame(7.05, 0, 9.7, PI), T = mk(F);
    T(metals.darkMetal, rb(1.3, 0.68, 0.03, 0.01), 0, 2.72, 0.015);
    T(labels, label("plate", 1.24, 0.62), 0, 2.72, 0.038);
    T(planks, rb(1.36, 1.0, 0.05, 0.012, 0.9), 0, 1.62, 0.025, null, null, { hit: true, fine: false });
    T(roomWood, bx(1.24, 0.88, 0.012), 0, 1.62, 0.052);
    T(labels, label("bulletin", 0.56, 0.56), 0.3, 1.74, 0.062, [0, 0, 0.02]);
    T(labels, label("map", 0.5, 0.5), -0.3, 1.78, 0.062, [0, 0, -0.03]);
    T(linen, plane(0.3, 0.2), -0.36, 1.33, 0.062, [0, 0, 0.06]); T(linen, plane(0.22, 0.26), 0.05, 1.32, 0.063, [0, 0, -0.08]); T(paintOrange, plane(0.2, 0.14), 0.42, 1.3, 0.062);
    T(snow, pad(1.4, 0.08, 0.1), 0, 2.15, 0.04);
    T(snow, pad(1.32, 0.06, 0.08), 0, 3.08, 0.03);
  }
  {
    const F = frame(-7.0, 0, 9.7, PI), T = mk(F);
    T(paintPale, rb(0.62, 0.62, 0.2, 0.02), 0, 1.55, 0.1, null, null, { hit: true, fine: false });
    T(paintRed, bx(0.34, 0.1, 0.01), 0, 1.55, 0.205); T(paintRed, bx(0.1, 0.34, 0.01), 0, 1.55, 0.205);
    T(snow, pad(0.66, 0.07, 0.24), 0, 1.89, 0.1);
    // Probes and a rescue sled stood on end.
    for (let i = 0; i < 3; i += 1) T(i === 1 ? paintOrange : metals.brushed, cyl(0.012, 0.012, 2.3, 6), -0.6 + i * 0.07, 1.25, 0.06, [0.02, 0, 0]);
    T(metals.darkMetal, bx(0.3, 0.04, 0.05), -0.53, 1.9, 0.04); T(metals.darkMetal, bx(0.3, 0.04, 0.05), -0.53, 0.7, 0.04);
    T(paintOrange, rb(0.55, 1.9, 0.12, 0.05, 1.6, 2), 2.75, 1.0, 0.16, [-0.08, 0, 0], null, { shadow: true, fine: false });
    T(rope, new THREE.TorusGeometry(0.12, 0.02, 5, 14), 2.75, 1.75, 0.2, [-0.08, 0, 0]);
  }

  // ---- Lamp posts and the wind fences at the open corners -------------------
  for (const side of [-1, 1]) {
    WH(planks, rb(0.34, 6.3, 0.34, 0.03, 1.2), side * 9.72, 3.15, 3.5);
    W(snow, pad(0.42, 0.14, 0.42), side * 9.72, 6.35, 3.5);
    W(metals.structural, bx(1.5, 0.07, 0.07), side * 9.0, 6.0, 3.5, [0, 0, side * 0.1]);
    W(metals.structural, rod([side * 9.6, 5.3, 3.5], [side * 8.75, 5.98, 3.5], 0.016), 0, 0, 0);
    W(metals.darkMetal, rb(0.56, 0.13, 0.3, 0.04), side * 8.3, 5.9, 3.5);
    W(sodium, bx(0.44, 0.03, 0.2), side * 8.3, 5.82, 3.5);
    halo([side * 8.3, 5.76, 3.5], 3.4, 0xffa758, 0.6);
    W(snow, pad(0.6, 0.09, 0.34), side * 8.3, 6.0, 3.5);
    for (const y of [1.4, 4.4]) W(metals.darkMetal, bx(0.37, 0.05, 0.37), side * 9.72, y, 3.5);
    W(metals.darkMetal, rb(0.2, 0.3, 0.1, 0.015), side * 9.72, 1.7, 3.29);
    W(metals.brushed, cyl(0.016, 0.016, 4.3, 5), side * 9.66, 3.95, 3.31);
    for (let x = -0.24; x < 0.24; x += 0.06 + random() * 0.1) hang(side * 8.3 + x, 5.84, 3.5 + (random() - 0.5) * 0.26, 0.06 + random() * 0.2, 0.7);
  }
  // Fences: posts and rails, with a gate gap on the -x side where the snowmobile comes through.
  const fencePosts: Transform[] = [], fenceRails: Transform[] = [], fenceCaps: Transform[] = [], railCaps: Transform[] = [];
  const fence = (x: number, from: number, to: number) => {
    const count = Math.max(1, Math.round((to - from) / 1.55)), step = (to - from) / count;
    for (let i = 0; i <= count; i += 1) {
      fencePosts.push({ position: [x, 0.78, from + i * step], rotation: [0, 0, (random() - 0.5) * 0.05] });
      fenceCaps.push({ position: [x, 1.58, from + i * step] });
    }
    for (const y of [0.36, 0.72, 1.08, 1.4]) fenceRails.push({ position: [x + 0.06 * Math.sign(-x), y, (from + to) / 2], rotation: [(random() - 0.5) * 0.012, 0, 0], scale: [1, 1, to - from + 0.2] });
    railCaps.push({ position: [x + 0.06 * Math.sign(-x), 1.49, (from + to) / 2], scale: [1, 1, to - from] });
  };
  fence(-9.74, 0.5, 2.9); fence(-9.74, 7.3, 9.5);
  fence(9.74, 0.5, 3.1); fence(9.74, 3.9, 9.5);
  instances(rb(0.1, 1.6, 0.1, 0.015, 0.9), planks, fencePosts, true, true);
  instances(projectUv(new THREE.BoxGeometry(0.03, 0.16, 1), 0.9), planks, fenceRails, true, true);
  inst(pad(0.15, 0.08, 0.15), snow, fenceCaps);
  inst(pad(0.05, 0.035, 1), snow, railCaps);
  // The gate leaf, swung back against the outside of the fence.
  {
    const F = frame(-9.8, 0, 2.95, PI - 0.22), T = mk(F, { shadow: true, fine: false });
    for (const z of [0.05, 2.1, 4.15]) T(planks, bx(0.07, 1.4, 0.09, 0.9), 0, 0.82, z);
    for (const y of [0.3, 0.82, 1.38]) T(planks, bx(0.035, 0.14, 4.2, 0.9), 0.05, y, 2.1);
    T(planks, bx(0.035, 0.12, 4.3, 0.9), 0.05, 0.84, 2.1, [0.25, 0, 0]);
    T(snow, pad(0.07, 0.04, 4.1), 0.05, 1.47, 2.1, null, null, { shadow: false, fine: true });
    T(metals.darkMetal, bx(0.03, 0.2, 0.05), 0, 0.5, 0.0); T(metals.darkMetal, bx(0.03, 0.2, 0.05), 0, 1.2, 0.0);
  }

  // ---- Snow banks ----------------------------------------------------------
  // Ploughed up behind the fences and piled at the foot of every wall.
  drift(9.6, 3.4, 1.25, -11.9, 0.7, PI / 2 + 0.04, 0.4, 0, 0.3);
  drift(3.4, 3.2, 1.2, -11.6, 8.6, PI / 2, 0.4);
  drift(4.2, 1.5, 0.55, 10.55, 7.5, PI / 2, 0.62);
  drift(2.3, 0.7, 0.34, -9.36, 1.7, -PI / 2, 0.92);
  drift(2.3, 0.7, 0.3, -9.36, 8.4, -PI / 2, 0.92);
  drift(8.6, 0.8, 0.36, 9.33, 5.2, PI / 2, 0.92);
  // Wall foot drifts; they stop short of doors and the furnace.
  drift(7.4, 0.62, 0.3, -9.21, -24.4, -PI / 2, 0.95);
  drift(11.4, 0.6, 0.26, -9.22, -14.2, -PI / 2, 0.95);
  drift(2.0, 0.6, 0.3, -9.22, -0.9, -PI / 2, 0.95);
  drift(13.6, 0.62, 0.3, 9.21, -21.2, PI / 2, 0.95);
  drift(2.4, 0.6, 0.28, 9.22, -1.0, PI / 2, 0.95);
  drift(7.6, 0.7, 0.34, -4.2, 9.33, PI, 0.95);
  drift(4.6, 0.7, 0.3, 3.0, 9.33, PI, 0.95);
  // The far berm, thrown up by the plough, with a gate gap for the tracked carrier.
  drift(24, 5.2, 1.5, -11.2, -31.5, 0.02, 0.56);
  drift(15.6, 5, 1.4, 14.4, -31.1, -0.03, 0.5);
  drift(6, 2.2, 0.5, -3.4, -29.9, 0.1, 0.6);
  // Outside the corners, where nobody clears it.
  drift(12, 7, 1.7, -17.2, 5.2, PI / 2 - 0.2, 0.5);
  drift(12, 7, 1.8, 19.6, 5.2, PI / 2 + 0.15, 0.5);
  drift(9, 5, 1.2, -18.5, -31, 0.5, 0.5);
  drift(9, 5, 1.2, 19, -31.5, -0.4, 0.5);
  // Clods at the foot of each ploughed bank, and sastrugi where the wind has the ground to itself.
  if (high) {
    const clods: Transform[] = [];
    const scatter = (count: number, x0: number, x1: number, z0: number, z1: number, size: number) => {
      for (let i = 0; i < count; i += 1) {
        const s = size * (0.35 + Math.pow(random(), 2) * 1.2);
        clods.push({ position: [x0 + random() * (x1 - x0), s * 0.22, z0 + random() * (z1 - z0)], rotation: [random() * 0.5, random() * 6.3, random() * 0.5], scale: [s * (0.8 + random() * 0.6), s * (0.6 + random() * 0.4), s] });
      }
    };
    scatter(70, -9.4, 0.6, -29.6, -28.7, 0.22); scatter(40, 6.8, 9.6, -29.4, -28.7, 0.22); scatter(30, 0.8, 6.6, -31.5, -28.8, 0.12);
    scatter(26, -10.6, -9.95, 0.4, 2.9, 0.2); scatter(22, -10.5, -9.95, 7.2, 9.6, 0.2); scatter(40, 9.95, 10.5, 0.5, 9.5, 0.18);
    scatter(16, -9.45, -9.1, -28.2, -20.5, 0.12); scatter(16, 9.1, 9.45, -28.2, -14, 0.12);
    inst(clodGeometry(9), snow, clods);
    const ridge = cap(1, 10, 4);
    const ridges: Transform[] = [];
    for (let i = 0; i < 150; i += 1) {
      const side = i % 3, x = side === 0 ? -9.2 + random() * 18.4 : (side === 1 ? -1 : 1) * (10.5 + random() * 30), z = side === 0 ? -34.5 - random() * 26 : -40 + random() * 62;
      if (Math.abs(x) < 16.5 && z > -29 && Math.abs(x) > 9.6) continue;
      const s = 0.6 + random() * 1.6;
      ridges.push({ position: [x, groundAt(x, z) - 0.02, z], rotation: [0, Math.atan2(-WIND.z, WIND.x) + (random() - 0.5) * 0.2, 0], scale: [s * (1.4 + random()), 0.07 + random() * 0.12, s * 0.36] });
    }
    inst(ridge, snow, ridges);
  }

  // ---- Cables --------------------------------------------------------------
  const cable = (from: V3, to: V3, sag: number, radius = 0.014, sides = 5) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const points = Array.from({ length: 17 }, (_, i) => {
      const t = i / 16;
      return a.clone().lerp(b, t).setY(THREE.MathUtils.lerp(a.y, b.y, t) - sag * 4 * t * (1 - t));
    });
    const curve = new THREE.CatmullRomCurve3(points);
    W(cableMaterial, new THREE.TubeGeometry(curve, 28, radius, sides), 0, 0, 0);
    return curve;
  };
  cable([-9.72, 6.25, 3.5], [9.72, 6.25, 3.5], 0.9);
  cable([-9.72, 6.2, 3.56], [-9.9, HAB_TOP + 0.5, 0.2], 0.25);
  cable([9.72, 6.2, 3.56], [9.9, SHED_TOP + 0.45, 0.2], 0.3);
  cable([-9.72, 6.2, 3.44], [-8.2, MAIN_TOP + 0.3, 9.75], 0.4);
  cable([9.72, 6.2, 3.44], [8.6, MAIN_TOP + 0.3, 9.75], 0.4);
  // Work lights strung across the yard.
  const festoonZ = -14.6;
  W(metals.structural, cyl(0.03, 0.03, 1.2, 8), -9.8, HAB_TOP + 0.9, festoonZ);
  W(metals.structural, cyl(0.03, 0.03, 1.9, 8), 9.8, SHED_TOP + 1.25, festoonZ);
  const festoon = cable([-9.8, HAB_TOP + 1.45, festoonZ], [9.8, SHED_TOP + 2.15, festoonZ], 1.5, 0.016);
  const bulbs = Array.from({ length: 11 }, (_, i) => festoon.getPointAt(0.1 + i * 0.08));
  for (const point of bulbs) {
    W(metals.darkMetal, cyl(0.05, 0.085, 0.1, 10), point.x, point.y - 0.07, point.z);
    W(bulb, ball(0.055, 10, 8), point.x, point.y - 0.15, point.z, null, null, { fine: false });
    halo([point.x, point.y - 0.15, point.z], 1.25, 0xffc27a, 0.5);
    W(snow, cap(0.06, 8, 3), point.x, point.y - 0.02, point.z, null, [1, 0.6, 1]);
  }

  // ---- Radio mast beyond the habitat ---------------------------------------
  const mastX = -13.4, mastZ = -36.5, mastBase = terrainHeight(mastX, mastZ) - 0.1, mastTop = 26, mastHalf = 0.42;
  const mastHeight = mastTop - mastBase;
  WS(concrete, rb(1.9, 0.6, 1.9, 0.04, 1.6), mastX, mastBase + 0.3, mastZ);
  W(snow, pad(1.8, 0.2, 1.8), mastX, mastBase + 0.62, mastZ);
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    WS(metals.structural, cyl(0.045, 0.055, mastHeight, 8), mastX + a * mastHalf, mastBase + mastHeight / 2, mastZ + b * mastHalf);
    W(metals.structural, bx(0.24, 0.03, 0.24), mastX + a * mastHalf, mastBase + 0.62, mastZ + b * mastHalf);
  }
  const levels = 13, level = mastHeight / levels, lean = Math.atan(mastHalf * 2 / level);
  const braces: Transform[] = [], rings: Transform[] = [];
  for (let i = 0; i < levels; i += 1) {
    const y = mastBase + (i + 0.5) * level, way = i % 2 ? 1 : -1;
    for (const side of [-1, 1]) {
      braces.push({ position: [mastX + side * mastHalf, y, mastZ], rotation: [way * side * lean, 0, 0] });
      braces.push({ position: [mastX, y, mastZ + side * mastHalf], rotation: [0, 0, way * side * lean] });
      rings.push({ position: [mastX + side * mastHalf, y + level / 2, mastZ], rotation: [PI / 2, 0, 0] });
      rings.push({ position: [mastX, y + level / 2, mastZ + side * mastHalf], rotation: [0, 0, PI / 2] });
    }
  }
  instances(new THREE.BoxGeometry(0.035, Math.hypot(mastHalf * 2, level), 0.035), metals.structural, braces, false);
  instances(new THREE.BoxGeometry(0.035, mastHalf * 2, 0.035), metals.structural, rings, false, false);
  // Rime builds on the windward side of the lattice.
  instances(new THREE.BoxGeometry(0.07, 1, 0.1), snow, Array.from({ length: levels }, (_, i) => ({ position: [mastX - mastHalf - 0.03, mastBase + (i + 0.5) * level, mastZ - mastHalf] as V3, scale: [1, level * (0.5 + random() * 0.45), 1] as V3 })), false, false);
  // Ladder with a safety cage up the yard face, feeder cables on a tray up the corner, two rest platforms.
  {
    const lz = mastZ + mastHalf + 0.09, ladderTop = mastTop - 1;
    for (const side of [-1, 1]) W(metals.brushed, cyl(0.016, 0.016, ladderTop - mastBase - 0.6, 5), mastX + side * 0.17, (ladderTop + mastBase + 0.6) / 2, lz);
    const rungs: Transform[] = [], hoops: Transform[] = [];
    for (let y = mastBase + 0.9; y < ladderTop; y += 0.3) rungs.push({ position: [mastX, y, lz] });
    for (let y = mastBase + 3.2; y < ladderTop; y += 1.1) hoops.push({ position: [mastX, y, lz], rotation: [PI / 2, 0, 0] });
    inst(cylX(0.01, 0.01, 0.34, 4), metals.brushed, rungs);
    inst(new THREE.TorusGeometry(0.34, 0.012, 4, 12, PI), metals.brushed, hoops);
    for (const turn of [-0.9, 0, 0.9]) W(metals.brushed, cyl(0.008, 0.008, ladderTop - mastBase - 3.2, 4), mastX + Math.sin(turn) * 0.34, (ladderTop + mastBase + 3.2) / 2, lz + Math.cos(turn) * 0.34);
    for (let i = 0; i < 4; i += 1) W(cableMaterial, cyl(0.014 + (i % 2) * 0.008, 0.014 + (i % 2) * 0.008, 23 - mastBase - i * 1.6, 5), mastX + mastHalf + 0.07, (23 - i * 1.6 + mastBase) / 2 + 0.3, mastZ - 0.18 + i * 0.07);
    for (let y = mastBase + 1.5; y < 21; y += 1.5) W(metals.darkMetal, bx(0.08, 0.03, 0.36), mastX + mastHalf + 0.05, y, mastZ - 0.08);
    for (const y of [12.6, 20.4]) {
      WS(deck, bx(1.7, 0.04, 1.7, 0.9), mastX, y, mastZ);
      W(snow, pad(1.6, 0.1, 0.5), mastX, y + 0.06, mastZ - 0.55);
      for (const a of [-1, 1]) for (const b of [-1, 1]) W(metals.structural, cyl(0.016, 0.016, 1.0, 5), mastX + a * 0.82, y + 0.5, mastZ + b * 0.82);
      for (const h of [0.55, 1.0]) for (const a of [-1, 1]) { W(metals.structural, cylX(0.014, 0.014, 1.64, 5), mastX, y + h, mastZ + a * 0.82); W(metals.structural, cylZ(0.014, 0.014, 1.64, 5), mastX + a * 0.82, y + h, mastZ); }
    }
  }
  const relay = dishGeometry(0.8);
  const dishPaint = new THREE.MeshStandardMaterial({ color: 0xc3c9d0, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide, envMapIntensity: 0.9 });
  const mastDishes: Array<[V3, V3, number]> = [
    [[mastX + 0.62, 17.4, mastZ + 0.2], [0.05, -PI / 2 - 0.4, 0], 1],
    [[mastX - 0.1, 20.6, mastZ + 0.66], [0, PI + 0.3, 0], 1],
    [[mastX + 0.5, 22.6, mastZ - 0.3], [0.1, -2.2, 0], 0.6],
    [[mastX + 0.3, 14.6, mastZ + 0.7], [0.02, PI - 0.5, 0], 0.75],
  ];
  for (const [position, rotation, scale] of mastDishes) {
    // Kit dishes open toward -z; the feed and its struts sit in front, the mount behind.
    const F = frame(position[0], position[1], position[2], rotation[1], rotation[0]), T = mk(F);
    T(dishPaint, relay, 0, 0, 0, null, scale, { shadow: true, fine: false });
    T(paintPale, cylZ(0.1 * scale, 0.1 * scale, 0.5 * scale, 8), 0, 0, 0.3 * scale);
    T(metals.darkMetal, cylZ(0.05 * scale, 0.07 * scale, 0.16 * scale, 8), 0, 0, -0.72 * scale);
    for (const turn of [0.5, 2.6, 4.7]) T(metals.structural, rod([Math.sin(turn) * 0.74 * scale, Math.cos(turn) * 0.74 * scale, -0.08 * scale], [0, 0, -0.7 * scale], 0.01), 0, 0, 0);
    T(snow, ball(0.3 * scale, 8, 5), 0, -0.66 * scale, -0.06 * scale, null, [1.6, 0.4, 0.4]);
  }
  for (let i = 0; i < 3; i += 1) {
    const turn = i * 2.094 + 0.4, F = frame(mastX + Math.sin(turn) * 0.66, 24.6, mastZ + Math.cos(turn) * 0.66, turn), T = mk(F);
    T(paintPale, rb(0.26, 1.5, 0.12, 0.03), 0, 0, 0, null, null, { shadow: true, fine: false });
    for (const y of [-0.5, 0.5]) T(metals.structural, bx(0.06, 0.05, 0.26), 0, y, -0.14);
    T(snow, pad(0.28, 0.06, 0.14), 0, 0.77, 0);
  }
  // Yagis, whips and the top beacon.
  for (const [y, turn] of [[18.9, 2.2], [15.8, -1.9]]) {
    const F = frame(mastX, y, mastZ, turn), T = mk(F);
    T(metals.brushed, cylZ(0.014, 0.014, 2.0, 5), 0, 0, 1.4);
    for (let element = 0; element < 7; element += 1) T(metals.brushed, cylX(0.007, 0.007, 0.9 - element * 0.07, 4), 0, 0, 0.6 + element * 0.28);
  }
  W(metals.structural, cyl(0.012, 0.02, 3.2, 6), mastX, mastTop + 1.6, mastZ);
  W(paintPale, cyl(0.03, 0.03, 2.2, 6), mastX - 0.4, mastTop + 0.6, mastZ - 0.4);
  W(metals.structural, cyl(0.006, 0.01, 2.6, 4), mastX + 0.42, mastTop + 1.0, mastZ - 0.42);
  const beacon = emissive(0xff2a1c, 4);
  W(beacon, ball(0.15, 12, 8), mastX + 0.3, mastTop + 0.18, mastZ + 0.3);
  W(beacon, ball(0.11, 12, 8), mastX + mastHalf + 0.1, 14, mastZ + mastHalf + 0.1);
  halo([mastX + 0.3, mastTop + 0.18, mastZ + 0.3], 4.6, 0xff2a1c, 1.1, 2.1);
  halo([mastX + mastHalf + 0.1, 14, mastZ + mastHalf + 0.1], 3.0, 0xff2a1c, 0.8);
  kit.updates.push((now) => {
    const pulse = 0.2 + 0.8 * Math.pow(Math.max(0, Math.sin(now * 0.0028)), 6);
    beacon.color.setRGB(5.5 * pulse, 0.5 * pulse, 0.3 * pulse);
  });
  // Guys run from two heights to three anchors, each through a turnbuckle.
  for (const angle of [0.5, 2.6, 4.7]) {
    // The yard-side guy comes down short of the fence line, outside the yard.
    const reach = angle < 1 ? 8.2 : 11, ax = mastX + Math.sin(angle) * reach, az = mastZ + Math.cos(angle) * reach, ay = groundAt(ax, az) - 0.1;
    WS(concrete, rb(0.6, 0.6, 0.6, 0.05, 1.2), ax, ay + 0.1, az);
    W(snow, pad(0.62, 0.14, 0.62), ax, ay + 0.44, az);
    for (const y of [13, 22]) {
      const from: V3 = [mastX + Math.sin(angle) * mastHalf, y, mastZ + Math.cos(angle) * mastHalf], to: V3 = [ax, ay + 0.4, az];
      W(cableMaterial, rod(from, to, 0.012, 5), 0, 0, 0);
      const t = 0.93;
      W(metals.brushed, rod([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t], [from[0] + (to[0] - from[0]) * (t + 0.03), from[1] + (to[1] - from[1]) * (t + 0.03), from[2] + (to[2] - from[2]) * (t + 0.03)], 0.03, 6), 0, 0, 0);
    }
  }
  // Equipment cabin at the foot of the mast, with its cable bridge.
  {
    const hx = mastX + 3.0, hz = mastZ + 0.8, hy = terrainHeight(hx, hz) - 0.1, F = frame(hx, hy, hz, 0.25), T = mk(F), TS = mk(F, { shadow: true, fine: false });
    TS(panelOrange, rb(2.6, 2.3, 2.0, 0.04, 2.6), 0, 1.35, 0);
    TS(metals.darkMetal, bx(2.7, 0.2, 2.1), 0, 0.1, 0);
    T(snow, pad(2.9, 0.34, 2.3), 0, 2.62, 0);
    T(paintPale, rb(0.85, 1.8, 0.05, 0.01), 0.4, 1.15, 1.01);
    T(metals.brushed, bx(0.04, 0.16, 0.03), 0.72, 1.15, 1.05);
    T(metals.darkMetal, bx(0.5, 0.4, 0.04), -0.7, 1.7, 1.01);
    for (let slat = 0; slat < 5; slat += 1) T(metals.brushed, bx(0.46, 0.012, 0.05), -0.7, 1.56 + slat * 0.07, 1.04, [0.6, 0, 0]);
    T(sodium, bx(0.2, 0.05, 0.04), 0.4, 2.2, 1.04);
    halo(toWorld(F, 0.4, 2.18, 1.12), 1.7, 0xffa758, 0.7);
    T(metals.brushed, bx(0.3, 0.04, 2.3), -1.0, 2.9, 0.2, [0, -0.4, 0]);
    for (const end of [-0.9, 0.9]) T(metals.structural, cyl(0.02, 0.02, 0.5, 5), -1.0 - end * 0.4, 2.66, 0.2 + end);
    drift(3.4, 1.4, 0.7, hx - 0.2, hz - 1.5, 0.25, 0.8);
  }

  // ---- Satellite dish on the shed roof --------------------------------------
  {
    const base = frame(12.3, SHED_TOP + 0.3, -23.6), T = mk(base, { shadow: true, fine: false });
    T(metals.structural, rb(1.5, 0.3, 1.5, 0.04), 0, 0.15, 0);
    T(paintPale, cyl(0.16, 0.2, 1.7, 14), 0, 1.1, 0);
    T(metals.darkMetal, rb(0.36, 0.3, 0.36, 0.03), 0, 1.95, 0);
    const head = frame(12.3, SHED_TOP + 2.4, -23.6, 2.25, -0.72), H = mk(head, { shadow: true, fine: false });
    H(dishPaint, dishGeometry(1.55), 0, 0, 0);
    H(paintPale, rb(0.5, 0.5, 0.5, 0.05), 0, 0, 0.42);
    for (let rib = 0; rib < 8; rib += 1) H(metals.structural, rod([Math.sin(rib * PI / 4) * 0.3, Math.cos(rib * PI / 4) * 0.3, 0.22], [Math.sin(rib * PI / 4) * 1.5, Math.cos(rib * PI / 4) * 1.5, 0.02], 0.014, 4), 0, 0, 0, null, null, { shadow: false, fine: true });
    for (const turn of [0.5, 2.6, 4.7]) H(metals.structural, rod([Math.sin(turn) * 1.4, Math.cos(turn) * 1.4, -0.06], [0, 0, -1.42], 0.014), 0, 0, 0);
    H(metals.darkMetal, cylZ(0.11, 0.07, 0.3, 10), 0, 0, -1.45);
    // Snow lies in the lower lip of the bowl.
    H(snow, ball(0.5, 14, 8), 0, -1.02, -0.02, null, [1.5, 0.42, 0.26], { shadow: false, fine: true });
    H(metals.darkMetal, rod([0, -0.3, 0.6], [0, -0.75, 0.75], 0.03), 0, 0, 0);
  }

  // ---- Small things that travel --------------------------------------------
  function jerrycan(T: Put, paint: THREE.Material, x: number, y: number, z: number, turn = 0) {
    const F = frame(x, y, z, turn), at = (lx: number, ly: number, lz: number) => toWorld(F, lx, ly, lz);
    T(paint, rb(0.34, 0.44, 0.16, 0.03), x, y + 0.22, z, [0, turn, 0]);
    T(paint, bx(0.2, 0.03, 0.03), ...at(-0.02, 0.475, 0), [0, turn, 0]);
    for (const end of [-0.1, 0.06]) T(paint, bx(0.025, 0.05, 0.03), ...at(end, 0.455, 0), [0, turn, 0]);
    T(metals.darkMetal, cyl(0.03, 0.03, 0.06, 8), ...at(0.13, 0.46, 0), [0, 0, -0.5]);
  }
  /**
   * Freight sledge: sprung runners, slatted deck. Runs along +z. It carries a lashed load with a crate roped on
   * at the front, ammunition boxes half unloaded, or nothing but the snow that fell on it.
   */
  function sledge(x: number, y: number, z: number, turn: number, load: "freight" | "boxes" | "none", crate: "crateSmall" | "crateSlat" = "crateSlat") {
    const F = frame(x, y, z, turn), T = mk(F, { shadow: true, fine: false }), D = mk(F), S = putIn(F), bed = 0.316;
    const runner = skiGeometry(2.9, 0.06, 0.05, 0.2);
    for (const side of [-1, 1]) {
      T(planks, runner, side * 0.31, 0, 0, null, null, { hit: true });
      T(metals.brushed, bx(0.062, 0.006, 2.5), side * 0.31, 0.002, -0.15);
      for (const lz of [-1.05, -0.35, 0.35, 1.0]) T(planks, bx(0.045, 0.24, 0.05, 0.9), side * 0.31, 0.16, lz);
    }
    for (const lz of [-1.05, -0.35, 0.35, 1.0]) T(planks, bx(0.7, 0.045, 0.06, 0.9), 0, 0.27, lz);
    for (let slat = 0; slat < 5; slat += 1) T(planks, bx(0.115, 0.022, 2.35, 0.9), -0.29 + slat * 0.145, 0.305, -0.05, null, null, { hit: true });
    D(planks, tube([[-0.31, 0.2, 1.44], [-0.24, 0.3, 1.52], [0, 0.34, 1.56], [0.24, 0.3, 1.52], [0.31, 0.2, 1.44]], 0.018, 5, 14), 0, 0, 0);
    D(rope, tube([[0, 0.33, 1.56], [0.05, 0.12, 1.9], [0.2, 0.02, 2.3], [0.1, 0.02, 2.75], [-0.25, 0.02, 2.6], [-0.1, 0.02, 2.2]], 0.012, 4, 30), 0, 0, 0);
    if (load === "none") { D(snow, pad(0.6, 0.05, 1.5), 0, 0.33, -0.3); return; }
    if (load === "boxes") {
      // Two boxes still on the deck, a third thrown across them; the rest are already on the snow.
      const box = heightOf("crateAmmo");
      S("crateAmmo", 0.02, bed, -0.66, PI / 2 + 0.04, { variant: 0 });
      S("crateAmmo", -0.03, bed, 0.4, PI / 2 - 0.07, { variant: 2 });
      S("crateAmmo", 0.01, bed + box, -0.5, PI / 2 + 0.33, { variant: 0 });
      D(snow, pad(0.3, 0.05, 0.8), -0.03, bed + box + 0.008, 0.48, [0, -0.07, 0]);
      D(snow, pad(0.3, 0.06, 0.84), 0.01, bed + box * 2 + 0.012, -0.5, [0, 0.33, 0]);
      return;
    }
    const small = crate === "crateSmall", crateZ = small ? 0.98 : 0.95, crateTop = bed + heightOf(crate);
    T(tarp, rb(0.68, 0.5, 1.75, 0.15, 0.7, 2), 0, 0.57, -0.25, null, null, { hit: true });
    S(crate, 0, bed, crateZ, PI / 2 + 0.1);
    jerrycan(D, paintRed, -0.14, 0.32, -1.02, PI / 2); jerrycan(D, paintPale, 0.18, 0.32, -1.02, PI / 2);
    for (const lz of [-0.85, -0.25, 0.35]) D(rope, bx(0.7, 0.52, 0.02), 0, 0.57, lz);
    D(rope, rod([-0.34, 0.33, -1.0], [0.34, 0.82, -0.3], 0.008, 4), 0, 0, 0); D(rope, rod([0.34, 0.33, -1.0], [-0.34, 0.82, -0.3], 0.008, 4), 0, 0, 0);
    D(snow, pad(0.6, 0.1, 1.6), 0, 0.84, -0.25);
    // A closed crate carries a slab of snow; a slatted one has filled with it.
    if (small) D(snow, pad(0.46, 0.07, 0.62), 0, crateTop + 0.018, crateZ, [0, 0.1, 0]);
    else D(snow, pad(0.33, 0.1, 0.52), 0, crateTop - 0.05, crateZ, [0, 0.1, 0]);
  }
  /** Snowmobile, nose toward +z. `S` takes the fine parts, `SS` the bodywork. */
  function snowmobile(S: Put, SS: Put, paint: THREE.Material, snowy: boolean) {
    const body = { shadow: true, fine: false, hit: true };
    // Track and tunnel.
    SS(rubber, rb(0.38, 0.26, 1.42, 0.12, 1, 2), 0, 0.15, -0.55, null, null, body);
    for (let lug = 0; lug < 13; lug += 1) S(rubber, bx(0.4, 0.03, 0.035), 0, 0.03, -1.2 + lug * 0.105);
    for (let lug = 0; lug < 4; lug += 1) S(rubber, bx(0.4, 0.035, 0.03), 0, 0.09 + lug * 0.055, -1.262 - Math.sin(lug * 0.5) * 0.01);
    SS(metals.darkMetal, rb(0.46, 0.12, 1.5, 0.03), 0, 0.36, -0.5, null, null, body);
    for (const side of [-1, 1]) {
      for (const lz of [-1.05, -0.62, -0.2]) S(metals.structural, cylX(0.065, 0.065, 0.03, 10), side * 0.2, 0.1, lz);
      S(metals.structural, bx(0.02, 0.03, 1.0), side * 0.2, 0.13, -0.62);
      // Running boards.
      SS(metals.darkMetal, bx(0.2, 0.025, 0.85), side * 0.33, 0.3, -0.2, null, null, body);
      S(deck, bx(0.18, 0.006, 0.8, 0.5), side * 0.33, 0.316, -0.2);
    }
    // Belly pan, bonnet, side pods.
    SS(metals.darkMetal, rb(0.62, 0.2, 1.0, 0.09, 1.2, 2), 0, 0.33, 0.55, null, null, body);
    SS(paint, ball(1, 16, 10), 0, 0.5, 0.56, null, [0.36, 0.25, 0.74], body);
    SS(paint, rb(0.56, 0.2, 0.5, 0.08, 1.2, 2), 0, 0.52, 0.02, null, null, body);
    for (const side of [-1, 1]) {
      S(metals.darkMetal, bx(0.012, 0.07, 0.3), side * 0.345, 0.46, 0.5, [0, side * 0.1, 0]);
      for (let slot = 0; slot < 3; slot += 1) S(metals.darkMetal, bx(0.2, 0.012, 0.03), side * 0.16, 0.705 - slot * 0.004, 0.72 + slot * 0.07);
    }
    S(metals.darkMetal, rb(0.3, 0.05, 0.12, 0.02), 0, 0.5, 1.26);
    S(headlamp, cylZ(0.065, 0.065, 0.02, 12), 0, 0.56, 1.262, [-0.25, 0, 0]);
    S(metals.darkMetal, new THREE.TorusGeometry(0.07, 0.014, 5, 14), 0, 0.56, 1.265, [-0.25, 0, 0]);
    // Windscreen, bars, instruments.
    S(smoke, new THREE.CylinderGeometry(0.25, 0.33, 0.34, 12, 1, true, -1.05, 2.1), 0, 0.86, 0.14, [-0.42, 0, 0]);
    S(metals.darkMetal, rb(0.3, 0.07, 0.14, 0.02), 0, 0.68, 0.22, [-0.5, 0, 0]);
    S(metals.darkMetal, rod([0, 0.6, 0.1], [0, 0.9, -0.04], 0.022), 0, 0, 0);
    S(metals.darkMetal, tube([[-0.36, 0.9, -0.14], [-0.2, 0.93, -0.06], [0, 0.92, -0.04], [0.2, 0.93, -0.06], [0.36, 0.9, -0.14]], 0.014, 6, 16), 0, 0, 0);
    for (const side of [-1, 1]) {
      S(rubber, rod([side * 0.27, 0.915, -0.095], [side * 0.38, 0.895, -0.15], 0.02), 0, 0, 0);
      S(metals.brushed, rod([side * 0.3, 0.92, -0.06], [side * 0.36, 0.93, 0.0], 0.006, 4), 0, 0, 0);
    }
    // Seat with a backrest, rack and can behind.
    SS(rubber, rb(0.34, 0.16, 0.95, 0.07, 1, 2), 0, 0.5, -0.62, null, null, body);
    SS(rubber, rb(0.32, 0.22, 0.14, 0.05, 1, 2), 0, 0.68, -1.06, [-0.15, 0, 0], null, body);
    S(metals.darkMetal, tube([[-0.2, 0.42, -1.05], [-0.22, 0.46, -1.3], [0, 0.46, -1.38], [0.22, 0.46, -1.3], [0.2, 0.42, -1.05]], 0.012, 5, 16), 0, 0, 0);
    S(tail, bx(0.14, 0.04, 0.02), 0, 0.42, -1.27);
    S(rubber, bx(0.38, 0.22, 0.012), 0, 0.2, -1.3, [0.25, 0, 0]);
    // Skis on sprung struts.
    const ski = skiGeometry(1.2, 0.13, 0.02, 0.13);
    for (const side of [-1, 1]) {
      SS(metals.darkMetal, ski, side * 0.45, 0, 0.72, null, null, body);
      S(paint, tube([[side * 0.45, 0.02, 0.9], [side * 0.45, 0.1, 1.05], [side * 0.45, 0.16, 1.26]], 0.01, 4, 8), 0, 0, 0);
      S(metals.brushed, bx(0.012, 0.03, 0.9), side * 0.45, -0.004, 0.62);
      S(metals.structural, rod([side * 0.45, 0.03, 0.74], [side * 0.36, 0.34, 0.7], 0.02), 0, 0, 0);
      S(metals.structural, rod([side * 0.44, 0.12, 0.74], [side * 0.14, 0.26, 0.5], 0.012), 0, 0, 0);
      S(metals.structural, rod([side * 0.44, 0.12, 0.74], [side * 0.14, 0.26, 0.95], 0.012), 0, 0, 0);
      S(paintOrange, rod([side * 0.4, 0.14, 0.74], [side * 0.24, 0.46, 0.68], 0.03, 8), 0, 0, 0);
    }
    S(metals.darkMetal, tube([[-0.3, 0.3, 1.02], [-0.2, 0.3, 1.3], [0, 0.3, 1.36], [0.2, 0.3, 1.3], [0.3, 0.3, 1.02]], 0.014, 5, 14), 0, 0, 0);
    if (!snowy) return;
    jerrycan(S, paintPale, 0, 0.47, -1.24);
    S(snow, pad(0.3, 0.06, 0.72), 0, 0.59, -0.6);
    S(snow, ball(1, 10, 6), 0, 0.7, 0.62, null, [0.24, 0.05, 0.42]);
    for (const side of [-1, 1]) S(snow, pad(0.18, 0.04, 0.6), side * 0.33, 0.33, -0.28);
  }
  /** Tracked carrier: cab forward, cargo cabin behind, nose toward +z. */
  function carrier(F: THREE.Matrix4) {
    const T = mk(F), TS = mk(F, { shadow: true, fine: false });
    const loop = new THREE.CatmullRomCurve3([[-1.8, 0.05], [0, 0.05], [1.8, 0.05], [2.34, 0.26], [2.46, 0.56], [2.22, 0.84], [0, 0.88], [-2.22, 0.84], [-2.46, 0.56], [-2.34, 0.26]].map(([z, y]) => new THREE.Vector3(0, y, z)), true, "catmullrom", 0.4);
    const links = high ? 72 : 36, linkLength = loop.getLength() / links;
    const wheel = wheelGeometry(0.27, 0.16), small = wheelGeometry(0.11, 0.12), sprocket = cylX(0.3, 0.3, 0.1, 12);
    for (const side of [-1, 1]) {
      // Track: a band under grousered links.
      for (let i = 0; i < links; i += 1) {
        const at = loop.getPointAt(i / links), way = loop.getTangentAt(i / links), pitch = Math.atan2(-way.y, way.z);
        T(rubber, bx(0.52, 0.035, linkLength * 0.9), side * 0.98, at.y, at.z, [pitch, 0, 0], null, { shadow: i % 6 === 0, fine: true });
        if (high) T(metals.darkMetal, bx(0.5, 0.03, 0.035), side * 0.98, at.y - way.z * 0.03, at.z + way.y * 0.03, [pitch, 0, 0]);
      }
      for (let i = 0; i < 5; i += 1) {
        T(metals.darkMetal, wheel, side * 1.0, 0.36, -1.72 + i * 0.86);
        T(metals.structural, rod([side * 0.86, 0.36, -1.72 + i * 0.86], [side * 0.8, 0.62, -1.5 + i * 0.86], 0.03), 0, 0, 0);
      }
      T(paintOrange, sprocket, side * 1.0, 0.56, -2.18); T(metals.darkMetal, cylX(0.34, 0.34, 0.03, 12), side * 1.0, 0.56, -2.18);
      T(metals.darkMetal, wheelGeometry(0.26, 0.16), side * 1.0, 0.56, 2.2);
      for (const lz of [-1.0, 0, 1.0]) T(metals.darkMetal, small, side * 1.0, 0.74, lz);
      // Mudguard with its skirt and a season of snow.
      TS(paintOrange, rb(0.66, 0.05, 4.7, 0.02), side * 0.98, 0.98, 0);
      T(paintOrange, bx(0.02, 0.16, 4.5), side * 1.3, 0.9, 0);
      T(rubber, bx(0.6, 0.3, 0.02), side * 0.98, 0.84, -2.36, [-0.2, 0, 0]);
      T(snow, pad(0.6, 0.09, 1.7), side * 0.98, 1.04, 0.05);
    }
    TS(metals.darkMetal, rb(1.46, 0.62, 4.5, 0.06), 0, 0.72, 0);
    // Cab: raked screen, door each side.
    const cab = new THREE.Shape();
    cab.moveTo(0.36, 1.02); cab.lineTo(2.18, 1.02); cab.lineTo(2.22, 1.5); cab.lineTo(1.88, 2.34); cab.lineTo(0.36, 2.34); cab.closePath();
    const cabGeometry = new THREE.ExtrudeGeometry(cab, { depth: 2.02, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 });
    cabGeometry.rotateY(-PI / 2); cabGeometry.translate(1.01, 0, 0);
    TS(paintOrange, projectUv(cabGeometry, 1.6), 0, 0, 0);
    TS(paintOrange, rb(2.1, 1.42, 2.6, 0.08, 1.6, 2), 0, 1.74, -1.02);
    const rake = Math.atan2(0.34, 0.84);
    T(rubber, bx(1.86, 0.78, 0.03), 0, 1.92, 2.068, [-rake, 0, 0]);
    T(darkGlass, bx(1.76, 0.68, 0.035), 0, 1.92, 2.072, [-rake, 0, 0]);
    T(rubber, bx(0.04, 0.7, 0.04), 0, 1.92, 2.078, [-rake, 0, 0]);
    for (const side of [-1, 1]) {
      T(rubber, rod([side * 0.3, 1.6, 2.2], [side * 0.62, 1.95, 2.07], 0.008, 4), 0, 0, 0);
      T(rubber, bx(0.03, 0.62, 1.18), side * 1.052, 1.94, 1.18);
      T(darkGlass, bx(0.03, 0.54, 1.1), side * 1.058, 1.94, 1.18);
      T(metals.darkMetal, bx(0.012, 1.24, 0.012), side * 1.056, 1.68, 0.5); T(metals.darkMetal, bx(0.012, 0.55, 0.012), side * 1.056, 1.32, 1.8);
      T(metals.brushed, bx(0.02, 0.03, 0.14), side * 1.064, 1.52, 0.66);
      for (const lz of [-0.5, -1.5]) { T(rubber, bx(0.03, 0.46, 0.68), side * 1.052, 2.0, lz); T(darkGlass, bx(0.03, 0.4, 0.62), side * 1.058, 2.0, lz); }
      // Mirrors, step, lamps behind guards.
      T(metals.darkMetal, rod([side * 1.05, 1.9, 1.95], [side * 1.34, 1.98, 2.02], 0.012), 0, 0, 0);
      T(metals.darkMetal, rb(0.05, 0.26, 0.16, 0.02), side * 1.36, 1.96, 2.02);
      T(deck, bx(0.24, 0.03, 0.5, 0.5), side * 1.18, 0.62, 1.2);
      for (const lx of [0.46, 0.8]) {
        T(metals.darkMetal, cylZ(0.11, 0.1, 0.1, 14), side * lx, 1.3, 2.26);
        T(headlamp, cylZ(0.085, 0.085, 0.02, 14), side * lx, 1.3, 2.315);
        if (lx > 0.6) halo(toWorld(F, side * lx, 1.3, 2.4), 1.5, 0xfff1d6, 0.5);
        T(metals.darkMetal, bx(0.24, 0.012, 0.012), side * lx, 1.3, 2.33); T(metals.darkMetal, bx(0.012, 0.24, 0.012), side * lx, 1.3, 2.33);
      }
      T(amber, bx(0.08, 0.06, 0.03), side * 0.98, 1.18, 2.3);
      T(tail, bx(0.1, 0.14, 0.03), side * 0.9, 1.3, -2.335);
      T(labels, label("livery", 0.5, 0.5), side * 1.056, 1.45, -1.0, [0, side * PI / 2, 0]);
    }
    TS(metals.darkMetal, rb(2.3, 0.14, 0.12, 0.03), 0, 1.02, 2.3);
    T(metals.darkMetal, tube([[-0.9, 1.05, 2.3], [-0.9, 1.5, 2.4], [0, 1.56, 2.42], [0.9, 1.5, 2.4], [0.9, 1.05, 2.3]], 0.025, 6, 18), 0, 0, 0);
    T(metals.darkMetal, rb(0.5, 0.2, 0.3, 0.03), 0, 0.82, 2.36);
    T(metals.brushed, cylX(0.07, 0.07, 0.34, 10), 0, 0.86, 2.5);
    // Roof: light bar, rack with a lashed load, whip aerial, exhaust.
    T(metals.darkMetal, rb(1.2, 0.1, 0.16, 0.03), 0, 2.44, 1.82);
    for (const lx of [-0.42, 0, 0.42]) T(amber, rb(0.2, 0.09, 0.05, 0.02), lx, 2.45, 1.91);
    halo(toWorld(F, 0, 2.45, 1.98), 2.0, 0xffb040, 0.55);
    for (const side of [-1, 1]) T(metals.darkMetal, tube([[side * 0.95, 2.44, -2.2], [side * 0.95, 2.7, -2.1], [side * 0.95, 2.7, 0.1], [side * 0.95, 2.44, 0.2]], 0.02, 5, 16), 0, 0, 0);
    for (const lz of [-1.9, -1.0, -0.1]) T(metals.darkMetal, cylX(0.016, 0.016, 1.9, 5), 0, 2.7, lz);
    TS(tarpGreen, rb(1.5, 0.4, 1.3, 0.14, 0.7, 2), -0.05, 2.9, -1.3);
    for (const lz of [-1.7, -0.95]) T(rope, bx(1.52, 0.42, 0.02), -0.05, 2.9, lz);
    jerrycan(T, paintRed, 0.5, 2.71, -0.35, 0.2); jerrycan(T, paintRed, 0.1, 2.71, -0.38, 0.1);
    T(snow, pad(1.4, 0.14, 1.2), -0.05, 3.13, -1.3);
    T(snow, pad(1.9, 0.16, 1.5), 0, 2.42, 1.0);
    T(snow, pad(0.7, 0.1, 0.5), -0.5, 2.5, -0.2);
    T(metals.structural, cyl(0.008, 0.012, 2.4, 5), 0.9, 3.5, 0.5, [0.1, 0, 0]);
    T(metals.brushed, cyl(0.05, 0.05, 1.5, 8), -1.0, 2.1, 0.22);
    T(metals.darkMetal, cyl(0.07, 0.07, 0.6, 8), -1.0, 1.9, 0.22);
    plumes.push({ at: toWorld(F, -1.0, 2.95, 0.22), size: 0.5 });
    // Rear: door, ladder, tow hitch, a spare road wheel.
    T(metals.darkMetal, rb(0.8, 1.2, 0.05, 0.02), 0.3, 1.62, -2.33);
    T(darkGlass, bx(0.4, 0.3, 0.02), 0.3, 1.95, -2.36);
    T(metals.brushed, bx(0.03, 0.14, 0.03), 0.62, 1.55, -2.37);
    for (const lx of [-0.82, -0.52]) T(metals.brushed, cyl(0.014, 0.014, 1.5, 5), lx, 1.75, -2.38);
    for (let rung = 0; rung < 5; rung += 1) T(metals.brushed, cylX(0.012, 0.012, 0.3, 5), -0.67, 1.1 + rung * 0.3, -2.38);
    T(metals.darkMetal, rb(0.2, 0.12, 0.3, 0.02), 0, 0.6, -2.4);
    T(metals.darkMetal, wheel, -0.3, 1.25, -2.42, [0, PI / 2, 0]);
  }

  // ---- Vehicles ------------------------------------------------------------
  const carrierX = 4.9, carrierZ = -35.8;
  carrier(frame(carrierX, terrainHeight(carrierX, carrierZ) - 0.04, carrierZ, 0.42));
  drift(4.6, 1.6, 0.42, carrierX - 1.6, carrierZ - 0.6, PI / 2 + 0.42, 0.75);
  // The snowmobile stands in the gateway, nose to the yard.
  {
    const F = frame(-11.35, 0, 5.15, 1.85);
    snowmobile(mk(F), mk(F, { shadow: true, fine: false }), paintRed, true);
    halo(toWorld(F, 0, 0.56, 1.32), 1.0, 0xfff1d6, 0.4);
  }
  sledge(-8.6, 0, -14.2, 0.05, "freight", "crateSmall");
  sledge(-12.3, 0.02, 8.3, 1.2, "freight");
  sledge(8.62, 0, -21.3, -0.06, "boxes");
  sledge(carrierX - 0.9, terrainHeight(carrierX - 0.9, carrierZ - 4.6) + 0.02, carrierZ - 4.6, 0.5, "freight");

  // ---- Weather station beyond the far end -----------------------------------
  const spinners: Array<{ mesh: THREE.Mesh; rate: number }> = [];
  {
    // Mast with cup anemometer and vane, logger box and its own small panel.
    const px = -6.3, pz = -29.75;
    WS(metals.brushed, cyl(0.03, 0.04, 3.4, 8), px, 1.7, pz);
    W(metals.brushed, cylX(0.014, 0.014, 1.1, 6), px, 3.3, pz);
    for (const turn of [0.3, 2.4, 4.5]) W(cableMaterial, rod([px, 2.5, pz], [px + Math.sin(turn) * 1.3, 0.02, pz + Math.cos(turn) * 1.3], 0.005, 4), 0, 0, 0);
    W(paintPale, rb(0.34, 0.44, 0.2, 0.02), px, 1.35, pz + 0.13);
    W(snow, pad(0.38, 0.07, 0.24), px, 1.6, pz + 0.13);
    W(solar, bx(0.5, 0.012, 0.4), px, 2.2, pz + 0.24, [0.9, 0, 0]);
    W(metals.brushed, bx(0.54, 0.02, 0.44), px, 2.19, pz + 0.23, [0.9, 0, 0]);
    W(snow, pad(0.5, 0.04, 0.16), px, 2.1, pz + 0.37, [0.9, 0, 0]);
    hang(px + 0.4, 3.29, pz, 0.14, 0.6); hang(px - 0.2, 3.29, pz, 0.09, 0.6);
    const cups: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i += 1) {
      const turn = i * PI * 2 / 3;
      cups.push(rod([0, 0, 0], [Math.sin(turn) * 0.2, 0, Math.cos(turn) * 0.2], 0.006, 4).toNonIndexed());
      const cup = new THREE.SphereGeometry(0.055, 10, 6, 0, PI).rotateY(turn + PI / 2).translate(Math.sin(turn) * 0.2, 0, Math.cos(turn) * 0.2);
      cups.push(cup.toNonIndexed());
    }
    cups.push(cyl(0.02, 0.02, 0.08, 6).toNonIndexed());
    const rotor = new THREE.Mesh(mergeGeometries(cups), new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide }));
    rotor.position.set(px + 0.5, 3.4, pz);
    scene.add(rotor); kit.mirrorHidden.push(rotor);
    spinners.push({ mesh: rotor, rate: 7.5 });
    W(metals.brushed, cyl(0.008, 0.008, 0.12, 5), px + 0.5, 3.35, pz); W(metals.brushed, cyl(0.008, 0.008, 0.16, 5), px - 0.5, 3.37, pz);
    const vane = new THREE.Mesh(mergeGeometries([rod([0, 0, -0.26], [0, 0, 0.22], 0.007, 4).toNonIndexed(), bx(0.006, 0.14, 0.16).translate(0, 0.02, -0.26).toNonIndexed(), new THREE.ConeGeometry(0.02, 0.07, 6).rotateX(PI / 2).translate(0, 0, 0.25).toNonIndexed()]), metals.darkMetal);
    vane.position.set(px - 0.5, 3.46, pz);
    scene.add(vane); kit.mirrorHidden.push(vane);
    kit.updates.push((now) => { vane.rotation.y = -1.05 + Math.sin(now * 0.0011) * 0.22 + Math.sin(now * 0.0037) * 0.08; });
    // Stevenson screen: a louvred box on legs.
    const F = frame(-4.4, 0, -30.0, 0.2), T = mk(F), TS = mk(F, { shadow: true, fine: false });
    for (const lx of [-0.3, 0.3]) for (const lz of [-0.24, 0.24]) T(paintPale, bx(0.045, 1.25, 0.045), lx * 1.06, 0.62, lz * 1.08, [lz * 0.16, 0, -lx * 0.14]);
    for (const lz of [-0.22, 0.22]) T(paintPale, bx(0.66, 0.035, 0.035), 0, 0.5, lz);
    TS(paintPale, bx(0.62, 0.06, 0.52), 0, 1.25, 0);
    for (const lx of [-0.3, 0.3]) for (const lz of [-0.25, 0.25]) T(paintPale, bx(0.04, 0.56, 0.04), lx, 1.55, lz);
    for (let slat = 0; slat < 7; slat += 1) {
      const y = 1.32 + slat * 0.075;
      for (const side of [-1, 1]) {
        T(paintPale, bx(0.58, 0.012, 0.07), 0, y, side * 0.25, [side * 0.7, 0, 0], null, slat === 3 ? { shadow: true } : undefined);
        T(paintPale, bx(0.07, 0.012, 0.48), side * 0.3, y, 0, [0, 0, -side * 0.7]);
      }
    }
    TS(paintPale, bx(0.78, 0.035, 0.68), 0, 1.86, 0, [0.1, 0, 0]);
    T(snow, pad(0.78, 0.14, 0.68), 0, 1.94, 0, [0.1, 0, 0]);
    T(metals.brushed, bx(0.04, 0.03, 0.02), 0.18, 1.55, 0.275);
    for (let x = -0.36; x < 0.36; x += 0.08 + random() * 0.15) hang(...toWorld(F, x, 1.88, 0.36), 0.05 + random() * 0.18, 0.7);
    // Precipitation gauge inside a ring of hinged wind-shield leaves.
    const gx = -8.3, gz = -29.9;
    W(metals.brushed, cyl(0.04, 0.04, 1.3, 8), gx, 0.65, gz);
    WS(metals.brushed, cyl(0.11, 0.11, 0.5, 14), gx, 1.5, gz);
    W(metals.darkMetal, new THREE.TorusGeometry(0.11, 0.012, 5, 14), gx, 1.75, gz, [PI / 2, 0, 0]);
    W(metals.brushed, new THREE.TorusGeometry(0.42, 0.01, 4, 20), gx, 1.72, gz, [PI / 2, 0, 0]);
    for (let leaf = 0; leaf < 16; leaf += 1) {
      const turn = leaf * PI / 8;
      W(metals.brushed, bx(0.11, 0.36, 0.008), gx + Math.sin(turn) * 0.42, 1.53, gz + Math.cos(turn) * 0.42, [0.25, turn, 0]);
      if (leaf % 4 === 0) W(metals.brushed, rod([gx, 1.6, gz], [gx + Math.sin(turn) * 0.42, 1.72, gz + Math.cos(turn) * 0.42], 0.007, 4), 0, 0, 0);
    }
    W(snow, cap(0.1, 10, 3), gx, 1.75, gz, null, [1, 0.5, 1]);
    // Graduated snow stakes.
    const bands: Transform[] = [];
    for (const [x, z, lean] of [[-2.9, -29.5, 0.03], [-7.4, -30.6, -0.04], [-1.6, -30.4, 0.02], [7.6, -29.6, -0.03]]) {
      W(paintPale, cyl(0.022, 0.022, 2.2, 8), x, 1.1, z, [lean, 0, lean]);
      for (let b = 0; b < 5; b += 1) bands.push({ position: [x + (0.3 + b * 0.4 - 1.1) * 0, 0.3 + b * 0.4, z], rotation: [lean, 0, lean] });
      W(snow, cap(0.03, 8, 3), x, 2.2, z);
    }
    inst(cyl(0.024, 0.024, 0.1, 8), paintRed, bands);
  }
  kit.updates.push((now) => { for (const spinner of spinners) spinner.mesh.rotation.y = now * 0.001 * spinner.rate * (0.8 + 0.2 * Math.sin(now * 0.0007)); });

  // ---- Generator hut and fuel dump outside the +x corner ---------------------
  const tankX = 13.3, tankZ = 6.2;
  {
    const F = frame(12.75, 0, 2.2, -PI / 2), T = mk(F), TS = mk(F, { shadow: true, fine: false, hit: true });
    TS(concrete, bx(2.5, 0.2, 2.9, 2), 0, 0.1, 0);
    TS(iron, rb(2.2, 2.2, 2.6, 0.03, 2.4), 0, 1.3, 0);
    T(snow, pad(2.5, 0.34, 2.9), 0, 2.52, 0);
    for (const side of [-1, 1]) T(metals.darkMetal, bx(0.08, 2.2, 0.08), side * 1.08, 1.3, 1.29);
    // Louvred door, warning plate, lamp.
    T(metals.darkMetal, rb(0.96, 1.9, 0.05, 0.01), -0.4, 1.2, 1.31);
    T(paintPale, rb(0.88, 1.82, 0.04, 0.01), -0.4, 1.2, 1.33);
    for (let slat = 0; slat < 9; slat += 1) T(metals.brushed, bx(0.7, 0.014, 0.06), -0.4, 0.5 + slat * 0.075, 1.36, [0.65, 0, 0]);
    T(metals.brushed, bx(0.04, 0.16, 0.04), -0.06, 1.2, 1.37);
    for (const y of [0.5, 1.9]) T(metals.brushed, cyl(0.014, 0.014, 0.1, 6), -0.84, y, 1.35);
    T(labels, label("generator", 0.56, 0.56), 0.55, 1.95, 1.306);
    T(metals.darkMetal, rb(0.3, 0.1, 0.12, 0.02), -0.4, 2.28, 1.36);
    T(amber, bx(0.24, 0.03, 0.08), -0.4, 2.225, 1.36);
    halo(toWorld(F, -0.4, 2.2, 1.44), 1.6, 0xffb040, 0.6);
    for (let x = -1.1; x < 1.1; x += 0.08 + random() * 0.2) hang(...toWorld(F, x, 2.38, 1.42), 0.06 + Math.pow(random(), 2) * 0.45, 0.8);
    // Side louvres, exhaust through the roof with a flap, the feeder up to the lamp post.
    for (const lz of [-0.5, 0.5]) { T(metals.darkMetal, bx(0.04, 0.6, 0.7), -1.11, 1.6, lz); for (let slat = 0; slat < 6; slat += 1) T(metals.brushed, bx(0.05, 0.012, 0.64), -1.14, 1.36 + slat * 0.09, lz, [0, 0, 0.65]); }
    T(metals.brushed, tube([[0.6, 2.3, -0.6], [0.6, 3.1, -0.6], [0.6, 3.35, -0.66], [0.6, 3.45, -0.9]], 0.07, 8, 14), 0, 0, 0, null, null, { shadow: true, fine: false });
    T(metals.darkMetal, cyl(0.1, 0.13, 0.12, 10), 0.6, 2.72, -0.6);
    T(metals.darkMetal, cylZ(0.085, 0.085, 0.012, 10), 0.6, 3.5, -0.96, [0.5, 0, 0]);
    plumes.push({ at: toWorld(F, 0.6, 3.5, -1.0), size: 0.9 });
    T(metals.structural, cyl(0.025, 0.025, 1.2, 6), -0.9, 3.0, 1.1);
    cable(toWorld(F, -0.9, 3.55, 1.1), [9.72, 6.15, 3.5], 0.35);
    // Fuel line on sleepers from the tank, with a valve.
    W(metals.brushed, tube([[13.6, 0.5, tankZ - 1.9], [13.6, 0.3, tankZ - 2.3], [13.6, 0.26, 3.9], [13.6, 0.3, 3.62], [13.6, 0.6, 3.52]], 0.03, 6, 24), 0, 0, 0);
    W(paintRed, new THREE.TorusGeometry(0.09, 0.012, 5, 12), 13.6, 0.44, 3.9, [PI / 2, 0, 0]); W(paintRed, cyl(0.01, 0.01, 0.16, 5), 13.6, 0.36, 3.9);
    W(planks, bx(0.4, 0.1, 0.12, 0.9), 13.6, 0.2, 3.95);
  }
  {
    const tank = new THREE.CylinderGeometry(0.85, 0.85, 3.6, 28).rotateX(PI / 2);
    WS(paintPale, tank, tankX, 1.3, tankZ, null, null, { hit: true });
    const tankEnd = new THREE.SphereGeometry(0.85, 28, 8, 0, PI * 2, 0, PI / 2).rotateX(PI / 2);
    WS(paintPale, tankEnd, tankX, 1.3, tankZ + 1.8, null, [1, 1, 0.32]); WS(paintPale, tankEnd, tankX, 1.3, tankZ - 1.8, [0, PI, 0], [1, 1, 0.32]);
    W(paintOrange, new THREE.CylinderGeometry(0.862, 0.862, 0.5, 28, 1, true).rotateX(PI / 2), tankX, 1.3, tankZ + 0.9);
    for (const z of [-1.1, 1.1]) { WS(concrete, rb(1.5, 0.55, 0.3, 0.03, 1.4), tankX, 0.28, tankZ + z); W(metals.darkMetal, new THREE.CylinderGeometry(0.87, 0.87, 0.08, 28, 1, true).rotateX(PI / 2), tankX, 1.3, tankZ + z); }
    W(snow, snowSaddle(0.85, 4.1, 0.95, 0.2, 5), tankX, 1.3, tankZ);
    // Bund wall, capped with snow.
    for (const side of [-1, 1]) {
      WS(concrete, bx(0.16, 0.5, 5.0, 2), tankX + side * 1.4, 0.25, tankZ); W(snow, pad(0.2, 0.09, 4.9), tankX + side * 1.4, 0.53, tankZ);
      WS(concrete, bx(2.96, 0.5, 0.16, 2), tankX, 0.25, tankZ + side * 2.5); W(snow, pad(2.9, 0.09, 0.2), tankX, 0.53, tankZ + side * 2.5);
    }
    // Manhole, vent, dip tube, ladder on the yard side.
    W(metals.darkMetal, cyl(0.26, 0.26, 0.14, 16), tankX, 2.19, tankZ - 0.9);
    W(metals.brushed, cyl(0.3, 0.3, 0.03, 16), tankX, 2.27, tankZ - 0.9);
    W(snow, cap(0.28, 12, 3), tankX, 2.28, tankZ - 0.9, null, [1, 0.35, 1]);
    W(metals.brushed, tube([[tankX, 2.1, tankZ + 1.3], [tankX, 2.6, tankZ + 1.3], [tankX + 0.08, 2.7, tankZ + 1.3], [tankX + 0.16, 2.6, tankZ + 1.3]], 0.03, 6, 12), 0, 0, 0);
    W(metals.brushed, cyl(0.012, 0.012, 1.5, 5), tankX - 0.87, 1.3, tankZ + 1.5); W(metals.darkMetal, bx(0.05, 0.06, 0.05), tankX - 0.87, 2.0, tankZ + 1.5);
    for (const z of [-0.2, 0.18]) W(metals.brushed, rod([tankX - 1.25, 0.05, tankZ - 0.9 + z], [tankX - 0.62, 2.1, tankZ - 0.9 + z], 0.016, 5), 0, 0, 0);
    for (let rung = 0; rung < 6; rung += 1) W(metals.brushed, cylZ(0.012, 0.012, 0.38, 5), tankX - 1.25 + (0.3 + rung * 0.32) / 2.05 * 0.63, 0.35 + rung * 0.32, tankZ - 0.91);
    W(metals.brushed, tube([[tankX + 0.3, 0.6, tankZ - 1.75], [tankX + 0.3, 0.5, tankZ - 1.95]], 0.03, 6, 4), 0, 0, 0);
    eave("z", tankX - 0.7, tankZ - 1.6, tankZ + 1.6, 0.86, 0.5, 0.3);
  }
  // Power line marching off into the weather.
  {
    const run: Array<[number, number]> = [[17.2, -1.5], [23, -16], [30, -31.5], [38, -48], [47, -65], [57, -83]];
    let before: V3[] | null = null;
    for (const [x, z] of run) {
      const y = groundAt(x, z) - 0.2, turn = 0.42;
      WS(planks, cyl(0.1, 0.14, 7.6, 8), x, y + 3.8, z);
      const F = frame(x, y + 7.0, z, turn), T = mk(F);
      T(planks, bx(2.0, 0.12, 0.12, 0.9), 0, 0, 0, null, null, { shadow: true, fine: false });
      T(snow, pad(1.9, 0.07, 0.14), 0, 0.09, 0);
      T(snow, cap(0.11, 8, 3), 0, 0.6, 0);
      for (const side of [-1, 1]) T(metals.structural, rod([side * 0.7, 0, 0.06], [0, -0.7, 0.1], 0.012, 4), 0, 0, 0);
      const heads: V3[] = [-0.85, 0, 0.85].map((lx) => { T(paintPale, cyl(0.035, 0.05, 0.16, 8), lx, lx === 0 ? 0.68 : 0.14, 0); return toWorld(F, lx, lx === 0 ? 0.76 : 0.22, 0); });
      if (before) heads.forEach((head, index) => cable(before![index], head, 1.1, 0.012, 4));
      before = heads;
    }
    cable([17.2 - 0.78, groundAt(17.2, -1.5) + 7.0, -1.85], toWorld(frame(12.75, 0, 2.2, -PI / 2), -0.9, 3.55, 1.1), 0.5, 0.012, 4);
  }
  // Slatted wind fences upwind of the yard, each with the drift it was built to catch.
  {
    const posts: Transform[] = [], slats: Transform[] = [];
    for (const [x, z, turn] of [[-23, -22, 0.5], [-26, -9, 0.45], [-24, 4, 0.55], [-31, -30, 0.5], [24, 14, 0.5]] as Array<[number, number, number]>) {
      const y = groundAt(x, z), dx = Math.cos(turn), dz = -Math.sin(turn);
      for (let post = 0; post < 5; post += 1) posts.push({ position: [x + dx * (post - 2) * 1.8, groundAt(x + dx * (post - 2) * 1.8, z + dz * (post - 2) * 1.8) + 0.85, z + dz * (post - 2) * 1.8], rotation: [0.12, turn, 0] });
      for (let slat = 0; slat < 6; slat += 1) slats.push({ position: [x, y + 0.45 + slat * 0.26, z], rotation: [0.12, turn, 0] });
      drift(8, 3.4, 0.9, x + dz * 2.2, z - dx * 2.2, turn, 0.3);
    }
    instances(bx(0.1, 2.0, 0.1, 0.9), planks, posts, false, false);
    instances(bx(7.6, 0.16, 0.03, 0.9), planks, slats, false, false);
  }

  // ---- Out in the weather ---------------------------------------------------
  // What stands beyond the yard, in three depths: clear, hazed, ghost. All of it is real geometry in the same fog,
  // so it sharpens as you walk toward it and nothing out there is a picture.
  /** Direction a drift must turn to pile against the local +x flank of something turned by `turn`. */
  const against = (turn: number) => Math.atan2(-Math.cos(turn), Math.sin(turn));
  /** A lamp on a pole and the glow it leaves in the blowing snow under it. */
  const poleLamp = (x: number, z: number, height: number, turn: number, colour = 0xffa758, gain = 0.8) => {
    const F = frame(x, groundAt(x, z) - 0.15, z, turn), T = mk(F);
    T(planks, cyl(0.05, 0.075, height + 0.15, 7), 0, (height + 0.15) / 2, 0, null, null, { shadow: true, fine: false });
    T(metals.structural, rod([0, height - 0.32, 0], [0, height - 0.02, 0.62], 0.016, 5), 0, 0, 0);
    T(metals.darkMetal, rb(0.22, 0.09, 0.34, 0.03), 0, height - 0.02, 0.7);
    T(colour === 0xffa758 ? sodium : amber, bx(0.15, 0.025, 0.24), 0, height - 0.078, 0.7);
    T(snow, pad(0.26, 0.07, 0.38), 0, height + 0.05, 0.7);
    T(snow, cap(0.07, 8, 3), 0, height + 0.15, 0);
    halo(toWorld(F, 0, height - 0.14, 0.7), 2.6, colour, gain);
    halo(toWorld(F, 0, 0.7, 0.9), 5.5, colour, gain * 0.22);
  };
  /** A horizontal fuel tank on two saddles, axis along local z. */
  const fuelTank = (x: number, z: number, turn: number, paint: THREE.Material, seed: number) => {
    const F = frame(x, groundAt(x, z) - 0.12, z, turn), T = mk(F), TS = mk(F, { shadow: true, fine: false });
    const R = 1.25, L = 5.4, up = 1.8;
    TS(paint, new THREE.CylinderGeometry(R, R, L, 24).rotateX(PI / 2), 0, up, 0);
    const end = new THREE.SphereGeometry(R, 24, 6, 0, PI * 2, 0, PI / 2).rotateX(PI / 2);
    TS(paint, end, 0, up, L / 2, null, [1, 1, 0.3]); TS(paint, end, 0, up, -L / 2, [0, PI, 0], [1, 1, 0.3]);
    for (const at of [-1.7, 1.7]) {
      TS(concrete, rb(2.3, 1.0, 0.4, 0.04, 1.4), 0, 0.5, at);
      T(metals.darkMetal, new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.1, 24, 1, true).rotateX(PI / 2), 0, up, at);
      T(snow, pad(0.5, 0.12, 0.44), 1.0, 1.04, at); T(snow, pad(0.5, 0.12, 0.44), -1.0, 1.04, at);
    }
    T(snow, snowSaddle(R, L + 0.5, 0.95, 0.3, seed), 0, up, 0);
    T(metals.darkMetal, cyl(0.3, 0.3, 0.2, 12), 0, up + R + 0.06, -1.2);
    T(snow, cap(0.32, 12, 3), 0, up + R + 0.16, -1.2, null, [1, 0.4, 1]);
    T(metals.brushed, tube([[0, up + R - 0.1, 1.6], [0, up + R + 0.5, 1.6], [0.1, up + R + 0.6, 1.6], [0.2, up + R + 0.5, 1.6]], 0.035, 6, 12), 0, 0, 0);
    // Fill line down to a valve, and a ladder to the manhole.
    T(metals.brushed, tube([[-R - 0.03, up - 0.3, -1.2], [-R - 0.2, up - 0.5, -1.2], [-R - 0.2, 0.5, -1.2], [-R - 0.2, 0.4, -0.9]], 0.04, 6, 14), 0, 0, 0);
    T(paintRed, cylZ(0.09, 0.09, 0.03, 10), -R - 0.2, 0.62, -1.14);
    for (const side of [-0.2, 0.2]) T(metals.brushed, rod([R + 0.75, 0.05, -1.2 + side], [0.5, up + R + 0.1, -1.2 + side], 0.018, 5), 0, 0, 0);
    if (high) for (let rung = 0; rung < 8; rung += 1) { const k = (0.3 + rung * 0.36) / (up + R + 0.05); T(metals.brushed, cylZ(0.013, 0.013, 0.4, 5), R + 0.75 - k * (R + 0.25), 0.3 + rung * 0.36, -1.2); }
  };
  /** A shipping container, long side along local x, doors at +x. */
  const container = (x: number, z: number, turn: number, paint: THREE.Material, lift = 0) => {
    const F = frame(x, groundAt(x, z) - 0.14 + lift, z, turn), T = mk(F), TS = mk(F, { shadow: true, fine: false });
    TS(paint, rb(6.06, 2.59, 2.44, 0.02, 2.4), 0, 1.3, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) T(metals.darkMetal, bx(0.16, 2.64, 0.16), sx * 2.99, 1.3, sz * 1.18);
    for (const sz of [-1, 1]) { T(metals.darkMetal, bx(5.84, 0.14, 0.1), 0, 2.55, sz * 1.19); T(metals.darkMetal, bx(5.84, 0.16, 0.1), 0, 0.08, sz * 1.19); }
    if (high) for (let rib = 0; rib < 19; rib += 1) for (const sz of [-1, 1]) T(paint, bx(0.13, 2.3, 0.05, 2.4), -2.7 + rib * 0.3, 1.31, sz * 1.22);
    for (const dz of [-0.6, 0.6]) for (const bar of [-0.26, 0.26]) T(metals.brushed, cyl(0.022, 0.022, 2.44, 5), 3.07, 1.3, dz + bar);
    T(metals.darkMetal, bx(0.03, 2.5, 0.05), 3.045, 1.3, 0);
    T(snow, pad(6.16, 0.34, 2.54), 0, 2.74, 0);
  };
  /** A barrel-roofed hut half buried in the drift it has gathered; the door end faces local +z. */
  const hut = (x: number, z: number, turn: number, length: number, seed: number, occupied: boolean) => {
    const F = frame(x, groundAt(x, z) - 0.2, z, turn), T = mk(F), TS = mk(F, { shadow: true, fine: false }), R = 2.5;
    const shell = new THREE.CylinderGeometry(R, R, length, 22, 1, true, -PI / 2, PI).rotateX(-PI / 2), shellUv = shell.attributes.uv;
    for (let i = 0; i < shellUv.count; i += 1) shellUv.setXY(i, shellUv.getX(i) * PI * R / 2.4, shellUv.getY(i) * length / 2.4);
    TS(iron, shell, 0, 0, 0);
    for (const side of [-1, 1]) {
      TS(planks, projectUv(new THREE.CircleGeometry(R - 0.03, 22, 0, PI), 1.6), 0, 0, side * (length / 2 - 0.04), side < 0 ? [0, PI, 0] : null);
      T(metals.darkMetal, new THREE.TorusGeometry(R, 0.05, 5, 22, PI), 0, 0, side * (length / 2 - 0.02));
    }
    T(snow, snowSaddle(R, length + 0.4, 1.12, 0.42, seed), 0, 0, 0);
    const front = length / 2 - 0.04;
    T(metals.darkMetal, bx(1.06, 2.06, 0.08), 0, 1.03, front + 0.02);
    T(occupied ? paintPale : paintRed, rb(0.92, 1.94, 0.06, 0.01), 0, 1.0, front + 0.06);
    T(metals.brushed, bx(0.04, 0.16, 0.04), 0.34, 1.0, front + 0.1);
    T(metals.darkMetal, bx(1.4, 0.05, 0.6), 0, 2.16, front + 0.3, [0.12, 0, 0]);
    T(snow, pad(1.46, 0.16, 0.66), 0, 2.26, front + 0.3, [0.12, 0, 0]);
    T(metals.darkMetal, bx(0.7, 0.6, 0.06), -1.35, 1.3, front + 0.02);
    if (occupied) {
      T(litGlass, plane(0.6, 0.5), -1.35, 1.3, front + 0.056);
      T(metals.darkMetal, bx(0.03, 0.5, 0.02), -1.35, 1.3, front + 0.066);
      T(sodium, bx(0.2, 0.05, 0.05), 0, 2.08, front + 0.1);
      halo(toWorld(F, 0, 2.02, front + 0.2), 1.8, 0xffa758, 0.75);
      halo(toWorld(F, -1.35, 1.3, front + 0.12), 1.3, 0xffc27a, 0.5);
      // The stove is lit.
      T(metals.brushed, cyl(0.09, 0.09, 1.5, 10), 0.9, R + 0.2, -length / 4);
      T(metals.darkMetal, cyl(0.03, 0.2, 0.14, 10), 0.9, R + 1.0, -length / 4);
      plumes.push({ at: toWorld(F, 0.9, R + 1.1, -length / 4), size: 0.9 });
    } else {
      T(unlitGlass, plane(0.6, 0.5), -1.35, 1.3, front + 0.056);
    }
    // Snow has filled in the windward flank and curled round the door end.
    const flank = toWorld(F, R + 1.0, 0, 0), toe = toWorld(F, 1.9, 0, front + 0.9);
    drift(length + 1.5, 4.2, 1.9, flank[0], flank[2], against(turn), 0.62);
    drift(2.6, 1.7, 0.75, toe[0], toe[2], against(turn - PI / 2), 0.8);
  };

  // Clear: the fuel farm and the cargo line just past the berm, lit by their own lamps.
  [[10.6, -47.2, paintPale], [13.9, -47.9, paintPale], [17.2, -48.6, paintOrange]].forEach(([x, z, paint], index) => fuelTank(x as number, z as number, 0.21, paint as THREE.Material, 31 + index * 7));
  {
    const x = 14.1, z = -43.8, F = frame(x, groundAt(x, z) - 0.1, z, 0.21 + PI / 2), T = mk(F);
    // Manifold along the valve ends, on low sleepers.
    T(metals.brushed, cylX(0.06, 0.06, 9.6, 8), 0, 0.5, 0);
    for (const along of [-4.2, -1.4, 1.4, 4.2]) { T(planks, bx(0.3, 0.42, 0.5, 0.9), along, 0.2, 0); T(snow, pad(0.34, 0.08, 0.5), along, 0.6, 0); }
    for (const along of [-3.3, 0, 3.3]) { T(paintRed, cyl(0.1, 0.1, 0.04, 10), along, 0.72, 0); T(metals.darkMetal, cyl(0.02, 0.02, 0.2, 5), along, 0.62, 0); }
    drift(11, 2.6, 0.7, x - 0.4, z + 1.2, against(0.21 + PI), 0.7);
  }
  poleLamp(8.3, -44.6, 5.2, -0.5);
  drift(12, 5.5, 1.5, 15.4, -51.6, 0.2, 0.55);
  container(-9.4, -47.4, 0.12, panelPine);
  container(-15.9, -48.3, 0.16, paintRed);
  container(-12.6, -50.9, 0.1, paintPale);
  container(-15.6, -48.3, 0.2, panelOrange, 2.6);
  drift(15, 4.6, 1.7, -12.4, -45.2, PI + 0.14, 0.6);
  poleLamp(-6.2, -46.2, 5.0, 2.2);
  sledge(2.9, groundAt(2.9, -42.2) + 0.02, -42.2, 0.2, "freight");
  sledge(3.6, groundAt(3.6, -45.6) + 0.02, -45.6, 0.24, "freight");
  sledge(4.5, groundAt(4.5, -49.0) + 0.02, -49.0, 0.28, "none");

  // Hazed: the radome on its tower, two wind generators, the route lamps counting off the distance.
  {
    const x = -13.5, z = -60, F = frame(x, groundAt(x, z) - 0.25, z, 0.3), T = mk(F), TS = mk(F, { shadow: true, fine: false }), top = 5.4;
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      TS(metals.structural, cyl(0.09, 0.12, top, 8), a * 2.1, top / 2, b * 2.1);
      T(concrete, rb(0.8, 0.5, 0.8, 0.04), a * 2.1, 0.2, b * 2.1);
      T(snow, pad(0.9, 0.16, 0.9), a * 2.1, 0.5, b * 2.1);
    }
    for (const side of [-1, 1]) for (const way of [-1, 1]) {
      T(metals.structural, rod([-2.1 * way, 0.5, side * 2.1], [2.1 * way, top - 0.3, side * 2.1], 0.035, 5), 0, 0, 0);
      T(metals.structural, rod([side * 2.1, 0.5, -2.1 * way], [side * 2.1, top - 0.3, 2.1 * way], 0.035, 5), 0, 0, 0);
    }
    TS(deck, bx(5.6, 0.12, 5.6, 0.9), 0, top, 0);
    for (const side of [-1, 1]) {
      T(metals.structural, cylX(0.022, 0.022, 5.5, 5), 0, top + 1.05, side * 2.75); T(metals.structural, cylZ(0.022, 0.022, 5.5, 5), side * 2.75, top + 1.05, 0);
      T(metals.structural, cylX(0.016, 0.016, 5.5, 5), 0, top + 0.55, side * 2.75); T(metals.structural, cylZ(0.016, 0.016, 5.5, 5), side * 2.75, top + 0.55, 0);
      for (const along of [-2.75, 0, 2.75]) { T(metals.structural, cyl(0.022, 0.022, 1.0, 5), along, top + 0.56, side * 2.75); if (along === 0) T(metals.structural, cyl(0.022, 0.022, 1.0, 5), side * 2.75, top + 0.56, 0); }
      T(snow, pad(5.3, 0.12, 0.5), 0, top + 0.1, side * 2.45); T(snow, pad(0.5, 0.12, 4.2), side * 2.45, top + 0.1, 0);
    }
    TS(paintPale, cyl(1.95, 1.95, 1.0, 22), 0, top + 0.56, 0);
    const shell = new THREE.IcosahedronGeometry(3.0, 2);
    shell.computeVertexNormals();
    TS(paintPale, shell, 0, top + 3.3, 0);
    // Ladder up one leg, a beacon on the crown.
    for (const side of [-0.2, 0.2]) T(metals.brushed, cyl(0.016, 0.016, top - 0.4, 5), 2.1 + side, top / 2 + 0.2, 2.26);
    T(beacon, ball(0.1, 10, 6), 0, top + 6.36, 0);
    halo(toWorld(F, 0, top + 6.36, 0), 3.2, 0xff2a1c, 0.9, 1.4);
    drift(8, 3.6, 1.3, x + 4.2, z - 0.6, against(0.3), 0.6);
  }
  const mills: Array<[number, number, number]> = [[11.5, -61, 10.5], [19, -68.5, 12]];
  for (const [x, z, height] of mills) {
    const y = groundAt(x, z) - 0.2;
    WS(metals.structural, cyl(0.1, 0.2, height, 10), x, y + height / 2, z);
    W(concrete, rb(1.2, 0.5, 1.2, 0.04), x, y + 0.2, z); W(snow, pad(1.3, 0.18, 1.3), x, y + 0.5, z);
    W(paintPale, rb(0.4, 0.42, 1.3, 0.12, 1.6, 3), x - WIND.x * 0.25, y + height + 0.12, z - WIND.z * 0.25, [0, Math.atan2(WIND.x, WIND.z), 0]);
    for (const turn of [0.4, 2.5, 4.6]) W(cableMaterial, rod([x, y + height * 0.62, z], [x + Math.sin(turn) * 5.2, groundAt(x + Math.sin(turn) * 5.2, z + Math.cos(turn) * 5.2), z + Math.cos(turn) * 5.2], 0.01, 4), 0, 0, 0);
  }
  {
    // One rotor, drawn at both generators and turned by the wind.
    const blade = new THREE.BoxGeometry(0.3, 2.9, 0.05, 1, 4, 1), at = blade.attributes.position;
    for (let i = 0; i < at.count; i += 1) { const t = at.getY(i) / 2.9 + 0.5; at.setX(i, at.getX(i) * (1.15 - t * 0.8) + 0.05 * t); at.setZ(i, at.getZ(i) + at.getX(i) * (0.5 - t * 0.45)); }
    blade.translate(0, 1.62, 0);
    const parts: THREE.BufferGeometry[] = [0, 1, 2].map((index) => blade.clone().rotateZ(index * PI * 2 / 3));
    parts.push(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12).rotateX(PI / 2), new THREE.SphereGeometry(0.2, 12, 6, 0, PI * 2, 0, PI / 2).rotateX(PI / 2).translate(0, 0, 0.15));
    const rotor = mergeGeometries(parts.map((part) => { part.computeVertexNormals(); return part; }));
    const mesh = instances(rotor, paintPale, mills.map(() => ({ position: [0, 0, 0] as V3 })), false, false);
    mesh.frustumCulled = false;
    kit.mirrorHidden.push(mesh);
    const into = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-WIND.x, -WIND.z)), spin = new THREE.Quaternion(), turned = new THREE.Quaternion(), matrix = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), hub = new THREE.Vector3(), AXIS = new THREE.Vector3(0, 0, 1);
    kit.updates.push((now) => {
      mills.forEach(([x, z, height], index) => {
        spin.setFromAxisAngle(AXIS, now / 1000 * (3.4 + index * 0.9) + index * 1.3);
        hub.set(x - WIND.x * 0.98, groundAt(x, z) - 0.2 + height + 0.12, z - WIND.z * 0.98);
        mesh.setMatrixAt(index, matrix.compose(hub, turned.copy(into).multiply(spin), one));
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
  // Lamps along the flagged route, each one dimmer and wider than the last.
  for (const [x, z, turn] of [[2.6, -39.6, -1.2], [1.3, -51.5, -1.3], [-1.6, -62.5, -1.35], [-4.6, -74, -1.4], [-7.4, -86, -1.45], [-10, -99, -1.5]]) poleLamp(x, z, 4.4, turn, 0xffb040, 0.75);

  // Ghost: a second mast and a field hut up the route, seen as a beacon and a lit window before anything else.
  {
    const x = 6.5, z = -92, base = groundAt(x, z) - 0.3, height = 34, half = 0.5;
    const legs = [0, 1, 2].map((leg) => [x + Math.sin(leg * 2.094) * half, z + Math.cos(leg * 2.094) * half]);
    legs.forEach(([lx, lz]) => W(metals.structural, cyl(0.045, 0.06, height, 6), lx, base + height / 2, lz));
    for (let level = 0; level < height / 2 - 1; level += 1) legs.forEach(([lx, lz], leg) => {
      const [nx, nz] = legs[(leg + 1) % 3], y = base + 1 + level * 2;
      W(metals.structural, rod([lx, y, lz], [nx, y, nz], 0.022, 4), 0, 0, 0);
      W(metals.structural, rod([lx, y, lz], [nx, y + 2, nz], 0.02, 4), 0, 0, 0);
    });
    for (const [at, reach] of [[0.55, 15], [0.92, 19]]) for (const turn of [0.5, 2.6, 4.7]) {
      const ax = x + Math.sin(turn) * reach, az = z + Math.cos(turn) * reach;
      W(cableMaterial, rod([x, base + height * at, z], [ax, groundAt(ax, az), az], 0.012, 4), 0, 0, 0);
    }
    W(beacon, ball(0.16, 10, 6), x, base + height + 0.2, z);
    W(beacon, ball(0.12, 10, 6), x, base + height * 0.55, z + half + 0.1);
    halo([x, base + height + 0.2, z], 5.5, 0xff2a1c, 1.3, 1.7);
    halo([x, base + height * 0.55, z + half + 0.1], 3.6, 0xff2a1c, 0.9);
  }
  hut(-16.5, -78, 0.5, 7, 51, true);
  hut(15.5, -84, -0.35, 6, 57, false);

  // Out through the corners of the yard: the aerial field and the old huts on the -x side, the cargo dump on the +x.
  hut(-27.5, 5.6, PI / 2 + 0.12, 8, 61, true);
  hut(-36, -8.5, PI / 2 - 0.1, 7, 67, false);
  poleLamp(-21.6, 8.4, 4.6, PI / 2 + 0.4);
  {
    const poles: V3[] = [[-33, 0, 12], [-39, 0, 4.5], [-44, 0, -4], [-31.5, 0, -19], [-38, 0, -27]];
    let before: V3 | null = null;
    for (const [x, , z] of poles) {
      const y = groundAt(x, z) - 0.2, height = 8.5;
      WS(metals.structural, cyl(0.035, 0.06, height, 6), x, y + height / 2, z);
      W(metals.structural, cylX(0.014, 0.014, 2.4, 4), x, y + height - 0.3, z, [0, 0.9, 0]);
      W(metals.structural, cylX(0.014, 0.014, 1.6, 4), x, y + height - 1.1, z, [0, 0.9, 0]);
      for (const turn of [0.2, 2.3, 4.4]) W(cableMaterial, rod([x, y + height * 0.7, z], [x + Math.sin(turn) * 3.6, groundAt(x + Math.sin(turn) * 3.6, z + Math.cos(turn) * 3.6), z + Math.cos(turn) * 3.6], 0.008, 4), 0, 0, 0);
      W(snow, cap(0.06, 8, 3), x, y + height, z);
      const head: V3 = [x, y + height - 0.3, z];
      if (before && high) cable(before, head, 0.7, 0.01, 4);
      before = head;
    }
  }
  container(27.5, 4.2, 1.35, paintPale);
  container(27.9, 4.4, 1.3, panelPine, 2.6);
  container(31.5, 11.5, 0.9, paintRed);
  drift(9, 4.4, 1.6, 29.6, 2.4, against(1.35 + PI / 2), 0.6);
  poleLamp(23.2, 7.2, 4.6, -PI / 2 - 0.3);
  hut(34, -8, -PI / 2 + 0.2, 7, 71, false);

  // ---- Marker poles --------------------------------------------------------
  // Flagged bamboo marks the track out through the gate and the edge of the cleared ground.
  const flagSpots: Array<[number, number]> = [
    [1.3, -31.6], [7.3, -31.4], [0.9, -37.6], [9.6, -39.2], [-0.4, -45], [7.8, -47], [-2.6, -54], [5.8, -56.5], [-5.2, -64.5], [3.4, -67], [-8, -77], [1, -80],
    [-8.6, -31.2], [-16.5, -31.6], [14.2, -31.3], [20.5, -31], [-17.6, 2.2], [-13.6, 10.2], [17.8, 1.6], [15.6, 10.4],
  ];
  const poles: Transform[] = [], flags: Transform[] = [];
  flagSpots.forEach(([x, z], index) => {
    const y = Math.max(0, terrainHeight(x, z)) + (z > -33 && z < -29 ? 1.0 : 0), tilt: V3 = [(random() - 0.5) * 0.12, 0, (random() - 0.5) * 0.12];
    poles.push({ position: [x, y + 1.2, z], rotation: tilt });
    flags.push({ position: [x, y + 2.42, z], rotation: [0, Math.atan2(-WIND.z, WIND.x) + (random() - 0.5) * 0.3 + (index % 5 === 0 ? 0.2 : 0), 0] });
  });
  instances(new THREE.CylinderGeometry(0.014, 0.02, 3.0, 6), bamboo, poles, false);
  const flagGeometry = new THREE.PlaneGeometry(0.46, 0.3, 8, 3);
  flagGeometry.translate(0.23, 0, 0);
  const pennant = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const flagMesh = instances(flagGeometry, pennant, flags, false, false);
  flagSpots.forEach((_, index) => flagMesh.setColorAt(index, new THREE.Color(index % 3 === 1 ? 0x101216 : 0xe2470c)));
  flagMesh.instanceColor!.needsUpdate = true;
  flagMesh.userData.walkThrough = true;
  life.cloth(pennant, { amplitude: 0.05, frequency: 2.6, pin: "left", lean: 0.3 });

  // ---- Stores in the yard ----------------------------------------------------
  // Whatever stands outside has stood through a few blows: snow lies on every lid, banks against the face the
  // weather reaches and fills the corners between one thing and the next. Nothing stands clean on the white.
  const CRATE = heightOf("crateLarge"), DRUM = heightOf("drum"), BOX = heightOf("crateAmmo"), BOTTLES = heightOf("cratePlastic"), sunk = -0.02;
  const DIESEL: Look = { tint: 0x8a2c1c, variant: 2 }, OIL: Look = { tint: 0xa9aba4, variant: 0 }, WASTE: Look = { tint: 0x22262a, variant: 3 }, SALT: Look = { variant: 3 };
  /** Snow lying on a lid `w` by `d`. */
  const lid = (x: number, top: number, z: number, yaw: number, w: number, d: number, deep = 0.1) => W(snow, pad(w, deep, d), x, top + deep / 2 - 0.02, z, [0, yaw, 0]);
  /** Snow heaped inside the rim of a standing drum. */
  const crown = (x: number, top: number, z: number, deep = 0.1, radius = 0.258) => W(snow, cap(radius, 14, 4), x, top - 0.027, z, null, [1, deep * 0.65 / radius, 1]);
  /** Snow banked against a face: a point at the foot of the face, the way the face looks, then the size of the bank. */
  const bank = (x: number, z: number, facing: number, length: number, width: number, height: number, crest = 0.88) => {
    const out = (crest - 0.5) * width - 0.04;
    drift(length, width, height, x + Math.sin(facing) * out, z + Math.cos(facing) * out, facing + PI, crest);
  };
  const drum = (x: number, z: number, yaw: number, look: Look, deep = 0.1) => {
    const y = groundAt(x, z) + sunk;
    put("drum", x, y, z, yaw, look);
    crown(x, y + DRUM, z, deep);
  };
  /** A drum on its side, half drifted in. `x`, `z` is its middle, `yaw` the way its top points, `flank` the side the snow has banked against. */
  const felled = (x: number, z: number, yaw: number, spin: number, look: Look, flank: 1 | -1) => {
    const y = groundAt(x, z) + 0.24, side = yaw + flank * PI / 2;
    put("drum", x - Math.sin(yaw) * DRUM / 2, y, z - Math.cos(yaw) * DRUM / 2, tipped(yaw, PI / 2, 0, spin), look);
    W(snow, snowSaddle(0.3, 0.84, 0.85, 0.07, Math.round(Math.abs(x * 7 + z * 3))), x, y, z, [0, yaw, 0]);
    bank(x + Math.sin(side) * 0.24, z + Math.cos(side) * 0.24, side, 1.3, 0.7, 0.24);
  };
  /** Four drums on two pallets, a tarpaulin roped down over three of them: the sheet takes the shape of what is under it. */
  const covered = (x: number, z: number, turn: number, cover: THREE.Material, look: Look) => {
    const F = frame(x, groundAt(x, z) + sunk, z, turn), T = mk(F, { shadow: true, fine: false }), D = mk(F), S = putIn(F), deck = heightOf("pallet"), top = deck + DRUM;
    for (const side of [-1, 1]) {
      S("pallet", side * 0.012, 0, side * 0.41, side * 0.025);
      for (const lx of [-0.3, 0.3]) S("drum", lx + side * 0.012, deck, side * 0.4, lx * 7 + side, look);
    }
    const under: Array<[number, number]> = [[0.31, -0.4], [0.31, 0.4], [-0.29, -0.4]];
    under.forEach(([lx, lz], index) => {
      T(cover, new THREE.CylinderGeometry(0.325, 0.345 + index * 0.008, 0.6 + index * 0.03, 20, 1, true), lx, top - 0.27 - index * 0.015, lz, [0, index * 1.3, 0]);
      T(cover, cap(0.325, 20, 4), lx, top + 0.029, lz, null, [1, 0.14, 1]);
    });
    // The sheet pulled tight between one drum and the next.
    T(cover, rb(0.5, 0.58, 0.5, 0.08, 0.7), 0.31, top - 0.262, 0);
    T(cover, rb(0.36, 0.56, 0.5, 0.08, 0.7), 0.01, top - 0.262, -0.4);
    D(rope, tube([[0.31, top - 0.57, -0.76], [0.31, top - 0.1, -0.74], [0.31, top + 0.08, -0.4], [0.31, top + 0.04, 0], [0.31, top + 0.08, 0.4], [0.31, top - 0.1, 0.74], [0.31, top - 0.57, 0.76]], 0.011, 5, 36), 0, 0, 0);
    D(rope, tube([[-0.65, top - 0.57, -0.4], [-0.63, top - 0.1, -0.4], [-0.29, top + 0.08, -0.4], [0.01, top + 0.04, -0.4], [0.31, top + 0.09, -0.4], [0.65, top - 0.1, -0.4], [0.67, top - 0.57, -0.4]], 0.011, 5, 36), 0, 0, 0);
    D(snow, pad(0.54, 0.1, 1.3), 0.31, top + 0.07, 0);
    D(snow, pad(0.5, 0.09, 0.5), -0.29, top + 0.065, -0.4);
    const bare = toWorld(F, -0.288, top, 0.4);
    crown(bare[0], bare[1], bare[2], 0.11);
  };

  // East wall, down range: freight off the sledge, stacked under the signs; a spare pallet stood against the wall.
  put("crateLarge", 8.78, sunk, -16.6, -PI / 2 + 0.05, { variant: 2 });
  put("crateLarge", 8.7, sunk, -17.85, -PI / 2 - 0.11, { variant: 3 });
  put("crateSmall", 8.64, CRATE + sunk, -16.47, -PI / 2 + 0.5, { variant: 1 });
  lid(8.78, CRATE + sunk, -16.6, -PI / 2 + 0.05, 1.07, 0.8, 0.07);
  lid(8.7, CRATE + sunk, -17.85, -PI / 2 - 0.11, 1.07, 0.8, 0.13);
  lid(8.64, CRATE + sunk + heightOf("crateSmall"), -16.47, -PI / 2 + 0.5, 0.6, 0.44, 0.09);
  put("pallet", 9.385, 0.56, -15.3, tipped(0.05, 0, 1.309), { variant: 1 });
  bank(8.32, -17.25, -PI / 2, 3.1, 0.95, 0.3);
  bank(8.8, -16.03, 0, 1.1, 0.7, 0.24);
  bank(8.7, -18.42, PI, 1.0, 0.6, 0.2);
  // Two boxes already on the snow beside the sledge.
  put("crateAmmo", 7.86, sunk / 2, -21.6, -PI / 2 + 0.12, { variant: 1 });
  put("crateAmmo", 7.9, sunk / 2 + BOX, -21.5, -PI / 2 - 0.3, { variant: 3 });
  lid(7.9, sunk / 2 + BOX * 2, -21.5, -PI / 2 - 0.3, 0.86, 0.32, 0.06);
  bank(7.64, -21.55, -PI / 2, 1.6, 0.6, 0.15);
  // The slot between the control desk and the wall: diesel, out of the way.
  drum(8.95, -24.75, -PI / 2 + 0.6, DIESEL, 0.09);
  drum(8.85, -25.42, -PI / 2 - 0.2, DIESEL, 0.12);
  drum(9.1, -26.05, 0.4, OIL);
  bank(8.9, -24.44, 0, 1.2, 0.7, 0.22);

  // West wall, down range: drums under a tarpaulin, an empty rolled aside; crates and plastic drums in the slot
  // beside the control desk, under the stores window.
  covered(-8.65, -18.4, PI / 2, tarpGreen, DIESEL);
  bank(-7.9, -18.4, PI / 2, 2.1, 0.85, 0.28);
  bank(-8.6, -17.71, 0, 1.5, 0.8, 0.24);
  felled(-8.75, -21.6, 0.25, 1, WASTE, 1);
  put("crateLarge", -8.88, sunk, -24.98, PI / 2 + 0.07, { variant: 3 });
  put("crateSmall", -8.9, CRATE + sunk, -25.1, PI / 2 + 0.4, { variant: 0 });
  lid(-8.88, CRATE + sunk, -24.98, PI / 2 + 0.07, 1.07, 0.8, 0.07);
  lid(-8.9, CRATE + sunk + heightOf("crateSmall"), -25.1, PI / 2 + 0.4, 0.6, 0.44, 0.1);
  for (const [x, z, yaw, tint, variant] of [[-9.03, -25.92, 1.9, 0x1a3f7c, 0], [-8.95, -26.6, 1.2, 0x9a9788, 3]]) {
    put("drumPlastic", x, sunk, z, yaw, { tint, variant });
    crown(x, sunk + heightOf("drumPlastic"), z, 0.09, 0.25);
  }
  bank(-8.88, -24.41, 0, 1.1, 0.7, 0.26);

  // West wall under the range sign: diesel for the habitat stoves, a crate with the cans that carry it indoors.
  put("crateLarge", -8.85, sunk, -10.7, PI / 2 + 0.06, { variant: 0 });
  lid(-8.85, CRATE + sunk, -10.7, PI / 2 + 0.06, 1.07, 0.8, 0.07);
  jerrycan(W, paintRed, -8.96, CRATE + sunk, -10.92, 0.5); jerrycan(W, paintPale, -8.74, CRATE + sunk, -10.5, 1.9);
  drum(-9.03, -9.62, PI / 2 - 0.5, DIESEL, 0.12);
  drum(-9.02, -8.86, PI / 2 + 0.3, DIESEL, 0.08);
  drum(-8.52, -9.28, PI / 2 + 0.1, WASTE);
  bank(-8.24, -9.3, PI / 2, 1.5, 0.75, 0.24);
  bank(-8.42, -10.7, PI / 2, 1.5, 0.85, 0.28);
  bank(-8.95, -8.56, 0, 1.2, 0.7, 0.2);
  bank(-8.85, -11.27, PI, 1.2, 0.7, 0.22);
  // Empties on and beside the bench.
  put("cratePlastic", -9.3, 0.478, -0.92, PI / 2 + 0.15, { tint: 0x9c2a1e, variant: 0 });
  put("cratePlastic", -9.24, sunk / 2, -2.2, 0.1, { tint: 0x9c2a1e, variant: 0 });
  put("cratePlastic", -9.22, sunk / 2 + BOTTLES, -2.19, -0.14, { tint: 0x23282c, variant: 1 });
  lid(-9.22, sunk / 2 + BOTTLES * 2, -2.19, -0.14, 0.34, 0.25, 0.06);

  // By the workshop door: salt for the threshold under the fire point, drums of oil, one of them empty and down.
  put("sack", 9.12, sunk / 2, -1.72, -PI / 2 + 0.12, SALT);
  put("sack", 9.1, sunk / 2, -1.14, -PI / 2 - 0.2, SALT);
  put("sackLying", 8.5, sunk / 2, -1.5, PI / 2 + 0.2, SALT);
  for (const z of [-1.72, -1.14]) W(snow, cap(0.2, 10, 3), 9.13, 0.57, z, null, [0.8, 0.4, 1]);
  lid(8.5, heightOf("sackLying") - 0.03, -1.5, PI / 2 + 0.2, 0.56, 0.3, 0.06);
  drum(9.03, -0.42, -PI / 2 + 0.3, DIESEL);
  drum(9.05, 0.24, -PI / 2 - 0.5, OIL, 0.13);
  felled(8.42, -0.15, 0.3, 2, WASTE, -1);

  // By the main door: salt under the notice board, empties and fuel cans in the corner by the fence.
  put("sack", 6.8, sunk / 2, 9.3, PI + 0.14, SALT);
  W(snow, cap(0.2, 10, 3), 6.8, 0.57, 9.31, null, [1, 0.4, 0.8]);
  put("sackOpen", 7.42, sunk / 2, 9.2, PI - 0.3, { variant: 3, tint2: 0xdfe4e6 });
  put("cratePlastic", 9.32, sunk / 2, 9.28, 0.1, { tint: 0x9c2a1e, variant: 0 });
  put("cratePlastic", 9.3, sunk / 2 + BOTTLES, 9.27, -0.2, { tint: 0x9c2a1e, variant: 0 });
  lid(9.3, sunk / 2 + BOTTLES * 2, 9.27, -0.2, 0.34, 0.25, 0.06);
  jerrycan(W, paintRed, 9.27, 0, 8.62, PI / 2 + 0.2); jerrycan(W, paintRed, 9.3, 0, 8.22, PI / 2 - 0.1);

  // Behind the fence at the generator: the fuel dump.
  covered(10.85, 4.75, 0.1, tarp, DIESEL);
  bank(10.85, 3.95, PI, 1.6, 0.8, 0.28);
  drum(10.32, 0.74, -PI / 2 + 0.4, OIL, 0.12);
  drum(10.98, 0.7, -PI / 2 - 0.2, DIESEL, 0.09);
  felled(10.45, 2.85, 1.3, 0.5, DIESEL, 1);
  bank(10.65, 1.05, 0, 1.6, 0.8, 0.26);

  // Tongues of drift reach out from the foot of each wall across the dye lines, so no line runs unbroken.
  for (const [side, z, length, width, height] of [
    [1, -23.5, 1.6, 1.7, 0.12], [1, -8.4, 1.8, 2.1, 0.15], [1, 2.1, 2.4, 1.8, 0.13], [1, 6.5, 2, 2.2, 0.16],
    [-1, -23.1, 1.4, 1.6, 0.12], [-1, -20.2, 1.6, 2, 0.14], [-1, -16.5, 1.6, 1.8, 0.13], [-1, -12.2, 1.8, 2.2, 0.15], [-1, -7, 2, 1.7, 0.12], [-1, 1.6, 2.2, 2, 0.15],
  ]) drift(length, width, height, side * (9.5 - width / 2), z, side * PI / 2, 0.8);

  // ---- Trees -----------------------------------------------------------------
  // Spruce at the edge of the tree line, loaded with snow and leaning from the same wind as everything else: a few
  // at the open corners where they can be walked up to, a rank behind each building that shows its tops over the
  // roof, ghosts on the slopes beyond, and two dead larches the weather has not yet felled.
  const firs: TreeItem[] = [];
  const fir = (x: number, z: number, scale: number, look: Partial<TreeItem>) => {
    firs.push({ at: [x, groundAt(x, z) - 0.15, z], yaw: chance() * 6.3, scale, snow: 0.84, lean: [WIND.x * (0.03 + chance() * 0.04), WIND.z * 0.05], ...look });
  };
  /** The trees near enough to see snow let go of a bough: where each stands and how tall. */
  const shedders: Array<{ x: number; y: number; z: number; tall: number }> = [];
  for (const [x, z, scale, variant] of [[-15.2, 7.2, 0.92, 0], [-17.2, 10.9, 1, 2], [-13.1, 12.5, 1.15, 2], [17, 6.6, 0.86, 0], [19.4, 10, 1, 2], [16.6, 12.6, 1.2, 2]]) {
    fir(x, z, scale, { variant, detail: "hero" });
    shedders.push({ x, y: groundAt(x, z), z, tall: (variant ? 5.2 : 10.5) * scale });
    // Snow banked up round the foot.
    W(snow, cap(1, 12, 4), x, groundAt(x, z) - 0.08, z, null, [1.2 + scale * 0.5, 0.24, 1.2 + scale * 0.5]);
  }
  for (const [x, z, scale] of [[17.4, -7.6, 1.14], [17.6, -13.9, 1.02], [17.3, -21.3, 1.24], [-17.3, -4.4, 1.3], [-17.6, -11.6, 1.18], [-17.2, -18.9, 1.34], [-17.5, -25.6, 1.22]]) fir(x, z, scale, { variant: 0, detail: "mid" });
  for (const [x, z] of [
    [-21, -41], [-25, -46], [-22.5, -53], [-29, -50], [-27, -60], [-33, -44], [-20, -66], [-31, -70],
    [22, -38], [26.5, -43], [24, -52], [33, -56], [27, -63], [36, -66], [23, -73], [31, -40.5],
    [-34, -1], [-39, 8], [-43, 1], [-47, 13], [-32, 17], [-51, 5], [-41, 20],
    [37, 1], [41, 11], [45, 4], [34, 18], [50, 14], [43, 22],
  ]) fir(x, z, 0.8 + chance() * 0.7, { variant: 1, detail: "far", snow: 0.92 });
  trees.place("spruce", firs);
  trees.place("bare", ([[-19.4, 10.4, 0.82], [20.6, 10.8, 0.7]] as V3[]).map(([x, z, scale], index): TreeItem => ({ at: [x, groundAt(x, z) - 0.1, z], yaw: 0.8 + index * 2.2, scale, snow: 0.75, variant: 0, detail: "mid", lean: [WIND.x * 0.07, WIND.z * 0.07] })));

  // ---- Life ------------------------------------------------------------------
  // Crows keep to the rails and post tops clear of the firing line, and take to the air over the yard at a shot;
  // three more ride the wind high over the range. The hens the coop was built for scratch about in front of it.
  life.birds("crow", {
    perches: [
      { from: [10.1, SHED_TOP + 1.43, -22.2], to: [10.1, SHED_TOP + 1.43, -12.4], thin: true },
      { from: [3.2, MAIN_TOP + 1.43, 10.25], to: [9.2, MAIN_TOP + 1.43, 10.25], thin: true },
      [-9.8, HAB_TOP + 1.5, -14.6], [9.8, SHED_TOP + 2.2, -14.6], [-9.72, 6.42, 3.5], [9.72, 6.42, 3.5],
    ],
    count: 6,
    roam: { x: [-7.5, 7.5], y: [8.5, 13], z: [-24, -1] },
  });
  life.soaring("crow", { centre: [1, 0, -20], radius: 22, height: 17, count: 3 });
  life.chickens({ areas: [[-8.2, 3.6, -4.4, 7.8]], count: 4 });
  // Spindrift: racing over the open snow behind the firing line, and streaming off the lee edge of the shed roof.
  life.drift("spindrift", { volume: { x: [-9.3, 9.3], y: [0, 1], z: [-2.5, 8.8] }, count: 30 });
  life.drift("spindrift", { volume: { x: [6.2, 15.6], y: [SHED_TOP + 0.5, SHED_TOP + 1.5], z: [SIDE_FROM, SIDE_TO] }, count: 32, scale: 1.25 });

  // ---- What the wind turns and lifts -----------------------------------------
  // The depot's flag on the habitat roof, on a material of its own so only it ripples.
  const flagAt: V3 = [-10.3, HAB_TOP + 0.34, -9.6], flagRise = 5.2;
  {
    const [x, y, z] = flagAt, T = mk(frame(x, y, z));
    T(metals.structural, rb(0.5, 0.08, 0.5, 0.02), 0, 0.04, 0);
    T(metals.brushed, cyl(0.03, 0.045, flagRise, 8), 0, flagRise / 2, 0, null, null, { shadow: true, fine: false });
    T(metals.brushed, ball(0.06, 10, 6), 0, flagRise + 0.04, 0);
    for (const turn of [0.7, 2.8, 4.9]) T(cableMaterial, rod([0, flagRise * 0.56, 0], [Math.sin(turn) * 1.5, 0.06, Math.cos(turn) * 1.5], 0.006, 4), 0, 0, 0);
    T(rope, cyl(0.006, 0.006, flagRise - 0.5, 4), 0.05, flagRise / 2 + 0.1, 0);
    T(metals.darkMetal, bx(0.07, 0.03, 0.03), 0.03, 0.9, 0);
    const banner = new THREE.PlaneGeometry(2.4, 1.5, 32, 18).translate(1.2, 0, 0);
    const bannerMap = track(labelMap.clone());
    bannerMap.repeat.set(LABELS.flag[2] / SHEET, LABELS.flag[3] / SHEET);
    bannerMap.offset.set(LABELS.flag[0] / SHEET, 1 - (LABELS.flag[1] + LABELS.flag[3]) / SHEET);
    bannerMap.needsUpdate = true;
    const cloth = new THREE.MeshStandardMaterial({ map: bannerMap, side: THREE.DoubleSide, roughness: 0.86, metalness: 0, envMapIntensity: 0.5 });
    cloth.name = "banner";
    const flag = new THREE.Mesh(banner, cloth);
    flag.position.set(x - 0.03, y + flagRise - 0.95, z);
    flag.rotation.y = Math.atan2(-WIND.z, WIND.x);
    flag.userData.walkThrough = true;
    scene.add(flag);
    kit.mirrorHidden.push(flag);
    life.cloth(cloth, { amplitude: 0.17, pin: "left", frequency: 0.85 }).snap([x + WIND.x * 1.2, y + flagRise - 0.95, z + WIND.z * 1.2]);
  }
  // A windsock on the near end of the shed roof, where the pilot and the whole yard can see it: it fills and lifts
  // out over the eave in the gusts and hangs in the lulls.
  const SOCK = 2.3;
  {
    const x = 11.3, z = -3.4, foot = SHED_TOP + 0.34, mast = 3.6, sockRise = foot + mast, T = mk(frame(x, foot, z));
    T(metals.structural, rb(0.44, 0.08, 0.44, 0.02), 0, 0.04, 0);
    T(metals.brushed, cyl(0.03, 0.05, mast + 0.3, 8), 0, (mast + 0.3) / 2, 0, null, null, { shadow: true, fine: false });
    T(paintRed, cyl(0.045, 0.048, 0.5, 8), 0, 1.3, 0);
    T(snow, cap(0.05, 8, 3), 0, mast + 0.3, 0);
    for (const turn of [0.4, 2.5, 4.6]) T(cableMaterial, rod([0, mast * 0.62, 0], [Math.sin(turn) * 1.2, 0.05, Math.cos(turn) * 1.2], 0.006, 4), 0, 0, 0);
    // The hoop faces the wind on a swivel.
    const hoop = mk(frame(x, sockRise, z, Math.atan2(-WIND.z, WIND.x)));
    hoop(metals.brushed, new THREE.TorusGeometry(0.27, 0.012, 5, 18).rotateY(PI / 2), 0.07, 0, 0);
    for (const turn of [0.5, 2.6, 4.7]) hoop(metals.brushed, rod([0, 0, 0], [0.07, Math.cos(turn) * 0.27, Math.sin(turn) * 0.27], 0.006, 4), 0, 0, 0);
    // The sock: a tapered sleeve along +x, banded, bent along an arc that tightens as the wind drops.
    const sleeve = new THREE.CylinderGeometry(0.12, 0.26, SOCK, 14, 18, true).rotateZ(-PI / 2).translate(SOCK / 2 + 0.07, 0, 0).toNonIndexed();
    const at = sleeve.attributes.position, bands = new Float32Array(at.count * 3), orange = new THREE.Color(0xc2440f), white = new THREE.Color(0xb9bbb6);
    for (let i = 0; i < at.count; i += 3) {
      const band = Math.floor(((at.getX(i) + at.getX(i + 1) + at.getX(i + 2)) / 3 - 0.07) / SOCK * 5);
      for (let corner = 0; corner < 3; corner += 1) (band % 2 ? white : orange).toArray(bands, (i + corner) * 3);
    }
    sleeve.setAttribute("color", new THREE.BufferAttribute(bands, 3));
    const fabric = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, envMapIntensity: 0.5 });
    fabric.name = "windsock";
    fabric.onBeforeCompile = (shader) => {
      applyWind(shader, wind);
      shader.uniforms.sockAt = { value: new THREE.Vector2(x, z) };
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", /* glsl */`
          uniform vec2 sockAt;
          vec3 sockBend(vec3 p, out float turn) {
            float fill = smoothstep(0.14, 0.6, windAt(sockAt)), along = clamp(p.x / ${SOCK.toFixed(2)}, 0.0, 1.1);
            float droop = max(0.03, (1.0 - fill) * 1.3 + 0.07 * sin(windTime * 3.3) + 0.05 * sin(windTime * 7.9 + 1.0));
            turn = droop * along;
            vec2 axis = vec2(sin(turn), cos(turn) - 1.0) * (${SOCK.toFixed(2)} / droop);
            float swing = sin(windTime * 5.1 - along * 3.0) * 0.12 * along * (0.3 + fill);
            return vec3(axis.x + p.y * sin(turn) * mix(0.6, 1.0, fill), axis.y + p.y * cos(turn) * mix(0.6, 1.0, fill), p.z + swing);
          }
          void main() {`)
        .replace("#include <beginnormal_vertex>", /* glsl */`#include <beginnormal_vertex>
          { float turn; sockBend(position, turn); objectNormal = vec3(objectNormal.x * cos(turn) + objectNormal.y * sin(turn), objectNormal.y * cos(turn) - objectNormal.x * sin(turn), objectNormal.z); }`)
        .replace("#include <begin_vertex>", /* glsl */`#include <begin_vertex>
          { float turn; transformed = sockBend(position, turn); }`);
    };
    fabric.customProgramCacheKey = () => "outpost-windsock";
    const sock = new THREE.Mesh(sleeve, fabric);
    sock.position.set(x, sockRise, z);
    sock.rotation.y = Math.atan2(-WIND.z, WIND.x);
    sock.frustumCulled = false;
    sock.userData.walkThrough = true;
    scene.add(sock);
    kit.mirrorHidden.push(sock);
  }
  // Search radar on a pylon on the shed roof: the one thing out here that never stops turning.
  const radarAt: V3 = [12.6, SHED_TOP + 3.72, -17.4];
  const scanner = new THREE.Mesh(mergeGeometries([
    rb(2.9, 0.3, 0.24, 0.07, 1.6, 2), bx(2.5, 0.12, 0.1).translate(0, 0, -0.17), cyl(0.07, 0.09, 0.3, 10).translate(0, -0.28, 0), bx(0.3, 0.2, 0.3).translate(0, -0.16, -0.1),
  ].map((part) => (part.index ? part.toNonIndexed() : part))), paintPale);
  {
    const [x, y, z] = radarAt, foot = SHED_TOP + 0.34, tall = y - 0.5 - foot, T = mk(frame(x, foot, z), { shadow: true, fine: false });
    T(metals.structural, rb(1.1, 0.14, 1.1, 0.03), 0, 0.07, 0);
    for (const a of [-1, 1]) for (const b of [-1, 1]) T(metals.structural, rod([a * 0.44, 0.1, b * 0.44], [a * 0.16, tall, b * 0.16], 0.026, 6), 0, 0, 0);
    for (let level = 0; level < 3; level += 1) {
      const low = 0.25 + level * (tall - 0.3) / 3, high = low + (tall - 0.3) / 3, wide = (at: number) => 0.44 - (at - 0.1) / (tall - 0.1) * 0.28;
      for (const side of [-1, 1]) {
        T(metals.structural, rod([-wide(low), low, side * wide(low)], [wide(high), high, side * wide(high)], 0.012, 4), 0, 0, 0, null, null, { shadow: false, fine: true });
        T(metals.structural, rod([side * wide(low), low, wide(low)], [side * wide(high), high, -wide(high)], 0.012, 4), 0, 0, 0, null, null, { shadow: false, fine: true });
      }
    }
    T(deck, bx(0.62, 0.04, 0.62, 0.9), 0, tall, 0);
    T(metals.darkMetal, rb(0.42, 0.34, 0.42, 0.04), 0, tall + 0.19, 0);
    T(snow, pad(1.1, 0.1, 1.1), 0, 0.17, 0, null, null, { shadow: false, fine: true });
    T(cableMaterial, tube([[0.2, tall, 0.1], [0.3, tall - 0.6, 0.3], [0.5, 0.3, 0.5], [0.9, 0.05, 0.6]], 0.016, 5, 14), 0, 0, 0, null, null, { shadow: false, fine: true });
    scanner.position.set(x, y, z);
    scanner.userData.walkThrough = true;
    scene.add(scanner);
    kit.mirrorHidden.push(scanner);
  }
  // The supply helicopter's two lamps borrow halos; it is far below ground until it flies.
  const heliLamps = halos.length;
  halo([0, -900, 0], 3.8, 0xfff1d6, 1.25);
  halo([0, -900, 0], 2.6, 0xff2a1c, 1.6, 9);

  // ---- Stencils and notices ---------------------------------------------------
  // The depot's name, sprayed across the signal band either side of the chart.
  W(labels, label("iceworld", 3.6, 0.4), 8.42, 3.62, 9.662, [0, PI, 0]);
  W(labels, label("depot", 3.6, 0.4), -8.42, 3.62, 9.662, [0, PI, 0]);
  // The way out for the rescued, on the habitat's end wall where it shows above the fence.
  W(labels, label("rescue", 4.2, 1.2), -12.3, 3.2, SIDE_TO + 0.004);
  // Enamel boards: the armoury's by the workshop door, the office's by the habitat door. Each stands off the wall on
  // four brackets, clear of the pipes that run up behind it.
  const notice = (F: THREE.Matrix4, name: keyof typeof LABELS, w: number, h: number, y: number) => {
    const T = mk(F);
    for (const side of [-1, 1]) for (const rise of [-1, 1]) T(metals.darkMetal, bx(0.05, 0.05, 0.076), side * (w / 2 - 0.15), y + rise * (h / 2 - 0.1), 0.038);
    T(metals.darkMetal, rb(w + 0.08, h + 0.08, 0.03, 0.01), 0, y, 0.09, null, null, { hit: true, fine: false });
    T(labels, label(name, w, h), 0, y, 0.108);
    T(snow, pad(w + 0.1, 0.07, 0.13), 0, y + h / 2 + 0.07, 0.062);
  };
  notice(frame(9.54, 0, -7.65, -PI / 2), "rifle", 2.2, 0.997, 2.85);
  notice(frame(-9.54, 0, -7, PI / 2), "office", 2.42, 0.691, 2.32);
  // The fuel placard hangs on the compound fence, where the yard can read all of it.
  W(paintPale, bx(1.36, 0.71, 0.014), 9.656, 1.1, 6, [0, -PI / 2, 0]);
  W(labels, label("diesel", 1.3, 0.65), 9.646, 1.1, 6, [0, -PI / 2, 0]);
  // Morale notice, screwed to the yard side of the gate leaf.
  {
    const T = mk(frame(-9.8, 0, 2.95, PI - 0.22));
    T(planks, bx(0.03, 1.2, 1.68, 0.9), -0.052, 1.12, 2.1, null, null, { shadow: true, fine: false });
    T(labels, label("snowball", 1.6, 1.12), -0.07, 1.12, 2.1, [0, -PI / 2, 0]);
    T(snow, pad(0.07, 0.06, 1.66), -0.05, 1.745, 2.1);
  }
  // Chicken coop in the corner by the rescue gear: a hutch on legs with a pop hole and a ramp, its board on two posts
  // behind, and the promised jumpers pegged out under it.
  {
    const F = frame(-9.36, 0, 8.3, PI / 2), T = mk(F), TS = mk(F, { shadow: true, fine: false, hit: true });
    for (const x of [-0.6, 0.6]) for (const z of [-0.24, 0.24]) T(planks, bx(0.07, 0.5, 0.07, 0.9), x, 0.25, z);
    TS(planks, rb(1.36, 0.66, 0.6, 0.012, 0.9), 0, 0.81, 0);
    TS(metals.darkMetal, bx(1.5, 0.04, 0.74), 0, 1.21, 0.04, [0.16, 0, 0]);
    T(snow, pad(1.54, 0.15, 0.76), 0, 1.3, 0.04, [0.16, 0, 0]);
    // Pop hole and ramp.
    T(rubber, bx(0.26, 0.34, 0.012), -0.38, 0.67, 0.302);
    for (const side of [-1, 1]) T(planks, bx(0.035, 0.38, 0.02, 0.9), -0.38 + side * 0.148, 0.67, 0.312);
    T(planks, bx(0.33, 0.035, 0.02, 0.9), -0.38, 0.857, 0.312);
    T(planks, bx(0.24, 0.022, 0.6, 0.9), -0.38, 0.262, 0.49, [0.9, 0, 0]);
    for (let cleat = 0; cleat < 4; cleat += 1) T(planks, bx(0.24, 0.016, 0.022, 0.9), -0.38, 0.435 - cleat * 0.11, 0.365 + cleat * 0.087, [0.9, 0, 0]);
    // Wire front.
    T(rubber, bx(0.56, 0.3, 0.012), 0.3, 0.86, 0.302);
    for (const [w, h, x, y] of [[0.62, 0.035, 0.3, 1.027], [0.62, 0.035, 0.3, 0.693], [0.035, 0.37, 0.007, 0.86], [0.035, 0.37, 0.593, 0.86]]) T(planks, bx(w, h, 0.02, 0.9), x, y, 0.312);
    for (let wire = 0; wire < 7; wire += 1) T(metals.brushed, cyl(0.004, 0.004, 0.3, 4), 0.09 + wire * 0.07, 0.86, 0.312);
    // The board.
    for (const x of [-0.76, 0.76]) { TS(planks, bx(0.07, 2.1, 0.07, 0.9), x, 1.05, -0.255); T(snow, pad(0.11, 0.06, 0.11), x, 2.125, -0.255); }
    T(planks, bx(1.66, 0.485, 0.03, 0.9), 0, 1.86, -0.205);
    T(labels, label("coop", 1.6, 0.425), 0, 1.86, -0.187);
    T(snow, pad(1.5, 0.06, 0.07), 0, 2.13, -0.205);
    // Three jumpers on a cord: knitted body, sleeves out, a pale band round the middle.
    T(rope, tube([[-0.73, 1.6, -0.17], [0, 1.578, -0.17], [0.73, 1.6, -0.17]], 0.004, 4, 12), 0, 0, 0);
    [[-0.42, tarp, 0.08], [-0.04, paintRed, -0.06], [0.36, tarpGreen, 0.05]].forEach(([x, knit, lean]) => {
      const J = mk(F.clone().multiply(frame(x as number, 1.582 + Math.abs(x as number) * 0.02, -0.17, 0, 0, lean as number)));
      J(knit as THREE.Material, rb(0.12, 0.11, 0.014, 0.005, 0.3), 0, -0.068, 0);
      for (const side of [-1, 1]) {
        J(knit as THREE.Material, rb(0.075, 0.04, 0.014, 0.005, 0.3), side * 0.078, -0.04, 0, [0, 0, side * -0.55]);
        J(planks, bx(0.012, 0.03, 0.02, 0.9), side * 0.04, -0.008, 0);
      }
      J(paintPale, bx(0.122, 0.02, 0.016), 0, -0.075, 0);
    });
  }
  bank(-9.02, 8.3, PI / 2, 1.5, 0.7, 0.16);

  // ---- Sky -----------------------------------------------------------------
  // The overcast is computed, not painted: a cloud deck streaming on the wind overhead, thin where the sun stands
  // behind it, dissolving into exactly the fog colour toward the horizon. There is no picture to run out of pixels.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 20, 0, PI * 2, 0, PI * 0.56), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), snowClock, skySun: { value: TO_SUN } },
    vertexShader: /* glsl */`
      varying vec3 vSky;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vSky = world.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`
      uniform float snowClock;
      uniform vec3 fogColor, skySun;
      varying vec3 vSky;
      ${snowGlsl()}
      void main() {
        vec3 dir = normalize(vSky);
        float up = max(dir.y, 0.0);
        // The deck is a level sheet overhead, so it bunches up toward the horizon as real cloud does.
        vec2 sheet = snowWind(dir.xz / (up + 0.16));
        float time = snowClock * 0.011;
        float mass = snowFbm(vec2(sheet.x * 0.3 + time, sheet.y * 0.62));
        float wisp = snowFbm(vec2(sheet.x * 1.1 + time * 2.4, sheet.y * 2.7) + mass * 1.8);
        float shred = snowFbm(vec2(sheet.x * 3.4 + time * 5.0, sheet.y * 9.0) + wisp * 1.2);
        float cloud = mass * 0.56 + wisp * 0.31 + shred * 0.13;
        vec3 colour = mix(fogColor * vec3(0.7, 0.74, 0.8), fogColor * vec3(1.14, 1.12, 1.09), smoothstep(0.32, 0.7, cloud));
        float sun = max(0.0, dot(dir, skySun));
        colour += fogColor * vec3(2.0, 1.8, 1.5) * (pow(sun, 5.0) * 0.16 + pow(sun, 48.0) * 0.5) * smoothstep(0.3, 0.75, cloud + 0.18);
        gl_FragColor = vec4(mix(colour, fogColor, exp(-pow(up * 3.1, 1.6))), 1.0);
        #include <colorspace_fragment>
      }`,
  }));
  // The sky is in every view, so the camera that draws it from eye height says where the player stands and looks
  // (the floor's mirror is below ground, the reflection probe above head height).
  dome.onBeforeRender = (_renderer, _scene, camera) => {
    const at = camera.matrixWorld.elements;
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera && at[13] > 1.2 && at[13] < 2.1) { eye.x = at[12]; eye.y = at[13]; eye.z = at[14]; eye.look = at[8] + at[9] * 1.7; }
  };
  dome.scale.set(236, 64, 236);
  dome.position.set(0, -4, -9);
  // Drawn after everything solid, so only the sky that shows is ever shaded.
  dome.renderOrder = 1;
  dome.frustumCulled = false;
  scene.add(dome);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 2.2);

  // ---- Everything gathered above -------------------------------------------
  // One batch per kind of prop. Tins, jars and cartons stand indoors behind glass: nothing reaches them and they
  // throw no shadow worth a pass, so they stay out of the bullet list, the shadow map and the mirror.
  const indoors: PropKind[] = ["tin", "jar", "carton", "cartonSmall", "cartonLarge", "cartonFlat", "cartonTall"];
  for (const [kind, items] of stock) {
    const inside = indoors.includes(kind), meshes = props.place(kind, items, inside ? { shadow: false, hit: false } : {});
    if (inside) kit.mirrorHidden.push(...meshes);
  }
  flush();
  const icicle = new THREE.ConeGeometry(0.024, 1, 6).rotateX(PI).translate(0, -0.5, 0);
  inst(icicle, ice, icicles);
  const pane = new THREE.PlaneGeometry(1, 1);
  instances(pane, unlitGlass, darkPanes, true, false);
  const glass = instances(pane, glazing, glassPanes, true, false);
  glass.renderOrder = 2;
  // Warm light thrown on snow and wall where a lamp would be: painted, not computed.
  const poolMap = track(softDiscTexture());
  const pool = inst(pane, new THREE.MeshBasicMaterial({ map: poolMap, color: new THREE.Color(1, 0.56, 0.24).multiplyScalar(0.34), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), pools);
  pool.receiveShadow = false;
  pool.renderOrder = -2;
  kit.probeHidden.push(pool);
  // Halos: one patch per lamp, turned to the eye and pulled a little toward it so it never slices the fitting.
  // The fog does to them what it does to a real lamp: further off, the glow is wider and weaker.
  let haloPlaces: THREE.InstancedBufferAttribute;
  {
    const geometry = new THREE.InstancedBufferGeometry();
    // An octagon just outside the radius at which the glow has faded to nothing: a third less to blend than a square.
    const rim = Array.from({ length: 8 }, (_, corner) => [Math.cos((corner + 0.5) * PI / 4) * 0.487, Math.sin((corner + 0.5) * PI / 4) * 0.487, 0]).flat();
    geometry.setIndex(Array.from({ length: 8 }, (_, corner) => [0, corner + 1, (corner + 1) % 8 + 1]).flat());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, ...rim], 3));
    const place = new Float32Array(halos.length * 4), tint = new Float32Array(halos.length * 4), colour = new THREE.Color();
    halos.forEach((entry, index) => {
      place.set([...entry.at, entry.size], index * 4);
      colour.set(entry.colour).multiplyScalar(entry.gain);
      tint.set([colour.r, colour.g, colour.b, entry.blink], index * 4);
    });
    haloPlaces = new THREE.InstancedBufferAttribute(place, 4);
    geometry.setAttribute("halo", haloPlaces);
    geometry.setAttribute("tint", new THREE.InstancedBufferAttribute(tint, 4));
    geometry.instanceCount = halos.length;
    const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), snowClock },
      vertexShader: /* glsl */`
        attribute vec4 halo;
        attribute vec4 tint;
        uniform float snowClock, fogDensity;
        varying vec2 vAt;
        varying vec3 vTint;
        void main() {
          vec4 centre = viewMatrix * vec4(halo.xyz, 1.0);
          float range = length(centre.xyz);
          float spread = 1.0 + range * 0.028;
          float clear = exp(-pow(fogDensity * range, 2.0) * 0.5);
          centre.xyz -= normalize(centre.xyz) * min(halo.w * 0.4, range * 0.5);
          centre.xy += position.xy * halo.w * spread;
          vAt = position.xy * 2.0;
          float pulse = tint.a > 0.0 ? 0.3 + 0.7 * smoothstep(0.2, 0.9, sin(snowClock * tint.a)) : 1.0;
          vTint = tint.rgb * clear * pulse * smoothstep(0.4, 1.8, range) / sqrt(spread);
          gl_Position = projectionMatrix * centre;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vAt;
        varying vec3 vTint;
        void main() {
          float r = length(vAt);
          float glow = pow(max(0.0, 1.0 - r), 2.4) * 0.42 * smoothstep(0.9, 0.8, r) + exp(-r * r * 26.0) * 0.8;
          gl_FragColor = vec4(vTint * glow, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.name = "halos";
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  }

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xc4d6f2, 0xaebfda, 1.15));
  const sun = kit.sunLight({ color: 0xfff1e0, intensity: 1.7, toSun: TO_SUN, extent: 34, distance: 56, near: 6, far: 110, radius: 4 });
  const lamp = (colour: number, intensity: number, reach: number, x: number, y: number, z: number) => {
    const light = new THREE.PointLight(colour, intensity, reach, 2);
    light.position.set(x, y, z);
    scene.add(light);
    return light;
  };
  // Four lamps only: the two posts, the festoon and the shed door. Every other glow is painted or emissive.
  const fills = [
    lamp(0xffa55c, 50, 18, -8.2, 5.5, 3.5),
    lamp(0xffa55c, 50, 18, 8.2, 5.5, 3.5),
    lamp(0xffb46e, 34, 15, 0, 5.0, festoonZ),
    lamp(0xffa55c, 26, 12, 8.75, 3.2, doorZ),
  ];

  // ---- Air -----------------------------------------------------------------
  // Snow in the air, all of it moved on the GPU: flakes falling on the wind through a box that follows the eye,
  // and spindrift racing along the ground under them. Speeds are whole multiples of box / period so the clock can
  // wrap without a jump; a flake fades out before it reaches the lens rather than popping on the near plane.
  const flakeMap = track(softDiscTexture());
  // `flakeRun` is the same clock run fast in the gusts and slow in the lulls: what the flakes travel by.
  const flakeClock = { value: 0 }, flakeRun = { value: 0 }, flakeGust = { value: 0.5 };
  const AIR_PERIOD = 240;
  const airborne = (count: number, box: V3, size: number, opacity: number, low: boolean) => {
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i += 1) seeds[i] = Math.random();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    const material = new THREE.PointsMaterial({ map: flakeMap, color: 0xf6f9ff, size, sizeAttenuation: true, transparent: true, opacity, depthWrite: false });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { flakeClock, flakeRun, flakeGust });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float flakeClock, flakeRun, flakeGust;\nvarying float vFlake;")
        .replace("#include <begin_vertex>", /* glsl */`
          vec3 box = vec3(${box.map((value) => value.toFixed(1)).join(", ")});
          vec3 seed = position;
          float pick = fract(seed.x * 37.7 + seed.z * 91.3);
          float along = ${low ? "floor(60.0 + pick * 34.0)" : "floor(22.0 + pick * 16.0)"} * box.x / ${AIR_PERIOD.toFixed(1)};
          float swirl = ${(PI * 2 / AIR_PERIOD).toFixed(6)} * flakeClock;
          vec2 wander = vec2(sin(swirl * 34.0 + seed.x * 40.0), cos(swirl * 27.0 + seed.z * 31.0)) * ${low ? "0.12" : "0.3"};
          // Box axes: x down the wind, z across it.
          vec2 drift = vec2(seed.x * box.x + along * flakeRun + wander.x, seed.z * box.z + wander.y);
          vec2 eye = vec2(cameraPosition.x * ${WIND.x.toFixed(3)} + cameraPosition.z * ${WIND.z.toFixed(3)}, cameraPosition.z * ${WIND.x.toFixed(3)} - cameraPosition.x * ${WIND.z.toFixed(3)});
          drift = eye + mod(drift - eye, box.xz) - 0.5 * box.xz;
          vec3 transformed = vec3(drift.x * ${WIND.x.toFixed(3)} - drift.y * ${WIND.z.toFixed(3)}, 0.0, drift.x * ${WIND.z.toFixed(3)} + drift.y * ${WIND.x.toFixed(3)});
          ${low
            ? "float lift = fract(seed.y * 7.0 + floor(50.0 + pick * 70.0) * flakeClock / " + AIR_PERIOD.toFixed(1) + "); transformed.y = 0.03 + box.y * seed.y * seed.y * (0.35 + 0.65 * sin(lift * 3.14159));"
            : "transformed.y = box.y - mod(seed.y * box.y * 7.0 + floor(16.0 + fract(pick * 7.3) * 14.0) * box.y / " + AIR_PERIOD.toFixed(1) + " * flakeClock, box.y);"}`)
        .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
          vFlake = smoothstep(0.45, 1.6, -mvPosition.z)${low ? " * (0.35 + 0.65 * fract(pick * 13.1)) * (0.3 + 0.7 * flakeGust)" : " * smoothstep(0.0, 0.8, transformed.y)"};`)
        .replace("gl_PointSize = size;", low ? "gl_PointSize = size * (0.6 + pick);" : "gl_PointSize = size * (0.7 + 0.6 * fract(pick * 5.3));");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vFlake;")
        .replace("#include <map_particle_fragment>", "#include <map_particle_fragment>\n  diffuseColor.a *= vFlake;");
    };
    material.customProgramCacheKey = () => `outpost-air-2-${low}`;
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    scene.add(points);
    kit.mirrorHidden.push(points);
    kit.probeHidden.push(points);
    return points;
  };
  airborne(high ? 3200 : 1300, [26, 12, 26], 0.07, 0.9, false);
  airborne(high ? 2600 : 900, [30, 0.7, 30], 0.085, 0.5, true);
  let airThen = -1;
  kit.updates.push((now) => {
    const dt = airThen < 0 ? 0 : Math.min(0.1, (now - airThen) / 1000);
    airThen = now;
    flakeClock.value = (now / 1000) % AIR_PERIOD;
    // Wind where the eye is, as a share of the steady breeze: about 0.35 in a lull, close to 2 in a hard gust.
    const gust = wind.at(eye.x, eye.z) / 0.5;
    flakeRun.value = (flakeRun.value + dt * (0.3 + 0.9 * gust)) % AIR_PERIOD;
    flakeGust.value = THREE.MathUtils.smoothstep(gust, 0.5, 1.4);
  });
  // Stove smoke, exhaust and vent steam: in this cold every warm outlet shows, and the wind tears each one over.
  const outlets = (from: number, to: number) => plumes.filter((plume) => plume.size >= from && plume.size < to).map((plume) => plume.at);
  life.plume("smoke", outlets(0.9, 9), { rise: 4.6, size: [0.4, 2.3], color: 0xb4bcc6, opacity: 0.55, lean: 7, density: 15 });
  life.plume("steam", outlets(0.3, 0.9), { rise: 2.2, size: [0.18, 1.2], opacity: 0.4, lean: 3.4 });
  life.plume("breath", outlets(0, 0.3), { rise: 0.6, size: [0.08, 0.5], opacity: 0.3 });
  // The generator misses a beat now and then and coughs a dark slug of diesel out of its stack.
  life.plume("smoke", toWorld(frame(12.75, 0, 2.2, -PI / 2), 0.6, 3.5, -1.0), { rise: 3, size: [0.35, 1.9], color: 0x26292d, opacity: 0.95, density: 26, burst: { every: 34, length: 1.6 }, cue: "generatorCough" });

  // ---- Things that happen -------------------------------------------------------
  // Loose snow thrown into the air by whatever lets go of it: a pool of soft puffs, each sent off by writing where
  // and when it was born. The shader carries them (first push, settling speed, the wind) and lands them.
  const PUFFS = high ? 160 : 80;
  const puffBorn = new Float32Array(PUFFS * 4).fill(-1e4), puffPush = new Float32Array(PUFFS * 4), puffTint = new Float32Array(PUFFS * 4), puffFall = new Float32Array(PUFFS * 2);
  const puffClock = { value: 0 };
  let puffNext = 0;
  const puffs = new THREE.InstancedBufferGeometry();
  puffs.setIndex([0, 1, 2, 2, 1, 3]);
  puffs.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3));
  const puffAttributes = [new THREE.InstancedBufferAttribute(puffBorn, 4), new THREE.InstancedBufferAttribute(puffPush, 4), new THREE.InstancedBufferAttribute(puffTint, 4), new THREE.InstancedBufferAttribute(puffFall, 2)];
  ["born", "push", "tint", "fall"].forEach((name, index) => puffs.setAttribute(name, puffAttributes[index]));
  puffs.instanceCount = PUFFS;
  {
    const mesh = new THREE.Mesh(puffs, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: true,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...wind.uniforms, puffClock },
      vertexShader: /* glsl */`
        attribute vec4 born;   // where, when
        attribute vec4 push;   // first velocity, size
        attribute vec4 tint;   // colour, seconds it lasts
        attribute vec2 fall;   // settling speed, height of what it lands on
        uniform float puffClock;
        varying vec2 vAt;
        varying vec4 vTint;
        #include <fog_pars_vertex>
        ${WIND_GLSL}
        void main() {
          float age = puffClock - born.w, spent = age / tint.a;
          vec3 at = born.xyz + push.xyz * (1.0 - exp(-age * 1.9)) / 1.9;
          at.y -= fall.x * (age - (1.0 - exp(-age * 2.6)) / 2.6);
          at.xz += normalize(windVector) * windAt(born.xz) * age * 1.6;
          at.y = max(at.y, fall.y);
          vec4 mvPosition = viewMatrix * vec4(at, 1.0);
          mvPosition.xy += position.xy * push.w * (0.55 + 0.9 * spent);
          vAt = position.xy * 2.0;
          vTint = vec4(tint.rgb, age < 0.0 || spent > 1.0 ? 0.0 : smoothstep(0.0, 0.07, spent) * pow(1.0 - spent, 1.4));
          gl_Position = vTint.a > 0.0 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vAt;
        varying vec4 vTint;
        #include <fog_pars_fragment>
        void main() {
          float r = dot(vAt, vAt);
          gl_FragColor = vec4(vTint.rgb, vTint.a * exp(-r * 2.6) * (1.0 - smoothstep(0.6, 1.0, r)));
          #include <fog_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.name = "puffs";
    mesh.userData.walkThrough = true;
    scene.add(mesh);
    kit.mirrorHidden.push(mesh);
    kit.probeHidden.push(mesh);
  }
  /** Throws `count` puffs from around a point: how far apart they start, how hard they are flung, how big, how long. */
  const flurry = (x: number, y: number, z: number, floor: number, count: number, spread: number, fling: number, size: number, seconds: number, settle: number, tone = 0.86) => {
    for (let i = 0; i < (high ? count : Math.ceil(count / 2)); i += 1) {
      const slot = puffNext = (puffNext + 1) % PUFFS, turn = chance() * 6.283, out = Math.sqrt(chance());
      puffBorn.set([x + Math.sin(turn) * out * spread, y + (chance() - 0.5) * spread, z + Math.cos(turn) * out * spread, puffClock.value + chance() * 0.25], slot * 4);
      puffPush.set([Math.sin(turn) * fling * chance(), fling * (chance() - 0.2), Math.cos(turn) * fling * chance(), size * (0.6 + chance() * 0.8)], slot * 4);
      puffTint.set([tone * 0.95, tone * 0.985, tone * 1.04, seconds * (0.7 + chance() * 0.6)], slot * 4);
      puffFall.set([settle * (0.75 + chance() * 0.5), floor + 0.05], slot * 2);
    }
    for (const attribute of puffAttributes) attribute.needsUpdate = true;
  };

  // A handful of icicles hang loose from the eaves over the yard. Now and then one lets go, falls and breaks, and a
  // new one grows where it hung.
  const loose = ([
    [-9.4, HAB_TOP - 0.33, -3.6], [-9.4, HAB_TOP - 0.33, -14], [-9.4, HAB_TOP - 0.33, -21.8], [9.4, SHED_TOP - 0.33, -1.4], [9.4, SHED_TOP - 0.33, -14.1],
    [-5.2, MAIN_TOP - 0.08, 9.64], [3.4, MAIN_TOP - 0.08, 9.64],
  ] as V3[]).map(([x, y, z]) => ({ x, y, z, length: 0.5 + chance() * 0.35, state: 0, since: 0, heard: false }));
  const looseMesh = new THREE.InstancedMesh(icicle, ice, loose.length);
  looseMesh.frustumCulled = false;
  looseMesh.userData.walkThrough = true;
  scene.add(looseMesh);
  kit.mirrorHidden.push(looseMesh);
  const hung = new THREE.Matrix4(), hungAt = new THREE.Vector3(), hungTurn = new THREE.Quaternion(), hungSize = new THREE.Vector3(), hungTip = new THREE.Euler();
  const hangLoose = (index: number, drop: number, grown: number, tumble: number) => {
    const one = loose[index];
    hungTurn.setFromEuler(hungTip.set(tumble, 0, tumble * 0.6));
    looseMesh.setMatrixAt(index, hung.compose(hungAt.set(one.x, one.y - drop, one.z), hungTurn, hungSize.set(1.7 * Math.min(1, grown * 2), one.length * grown, 1.7 * Math.min(1, grown * 2))));
    looseMesh.instanceMatrix.needsUpdate = true;
  };
  loose.forEach((_, index) => hangLoose(index, 0, 1, 0));
  const LANDS = 0.22, GROWS = 26;

  // The supply helicopter: one body, one rotor disc, one load on its line. It crosses the range on a loose timer,
  // heard before it comes out of the weather, and is parked out of sight in between.
  const heli = new THREE.Group(), heliLoad = new THREE.Group();
  const rotor = new THREE.Mesh(new THREE.CircleGeometry(5.3, 60).rotateX(-PI / 2), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  {
    const tinted = (geometry: THREE.BufferGeometry, colour: number, x = 0, y = 0, z = 0) => {
      const part = geometry.index ? geometry.toNonIndexed() : geometry, tone = new THREE.Color(colour), colours = new Float32Array(part.attributes.position.count * 3);
      for (let i = 0; i < colours.length; i += 3) tone.toArray(colours, i);
      part.deleteAttribute("uv");
      part.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      return part.translate(x, y, z);
    };
    const ORANGE = 0xc2440f, PALE = 0xb9bdc0, DARK = 0x16181b, GLASS = 0x0c1218, NET = 0x4a563a;
    // Nose toward -z: cabin and glazing, engine cowl and mast, tail boom with a shrouded fan in the fin, skids.
    const body = [
      tinted(new THREE.SphereGeometry(1, 18, 12).scale(1.05, 1.02, 2.3), ORANGE),
      tinted(new THREE.SphereGeometry(1, 16, 10).scale(0.985, 0.72, 1.3), GLASS, 0, 0.24, -1.2),
      tinted(rb(1.3, 0.6, 2.7, 0.2, 1.6, 3), PALE, 0, 1.06, 0.4),
      tinted(cyl(0.1, 0.13, 0.56, 8), DARK, 0, 1.6, 0.2),
      tinted(new THREE.CylinderGeometry(0.15, 0.46, 4.7, 10).rotateX(PI / 2), ORANGE, 0, 0.48, 4.2),
      tinted(bx(0.1, 1.9, 1.05).rotateX(-0.35), ORANGE, 0, 1.2, 6.55),
      tinted(new THREE.TorusGeometry(0.5, 0.11, 6, 16).rotateY(PI / 2), DARK, 0, 0.66, 6.4),
      tinted(bx(2.4, 0.07, 0.55), PALE, 0, 0.74, 5.4),
      tinted(bx(1.07, 0.3, 4.62), PALE, 0, -0.5, 0),
    ];
    for (const side of [-1, 1]) {
      body.push(tinted(cylZ(0.05, 0.05, 3.8, 6), DARK, side * 1.08, -1.42, -0.1));
      for (const z of [-1.2, 1.0]) body.push(tinted(rod([side * 0.72, -0.72, z], [side * 1.08, -1.42, z], 0.04, 5), DARK));
    }
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.8 });
    paint.name = "helicopter";
    heli.add(new THREE.Mesh(mergeGeometries(body), paint));
    // Three blades smeared into a disc: mostly air, darker where a blade is.
    const blades = new Float32Array(62 * 4);
    for (let i = 0; i < 62; i += 1) blades.set([0.03, 0.035, 0.04, i ? 0.07 + 0.5 * Math.pow(Math.abs(Math.cos((i - 1) / 60 * PI * 3)), 14) : 0.4], i * 4);
    rotor.geometry.setAttribute("color", new THREE.BufferAttribute(blades, 4));
    rotor.position.set(0, 1.92, 0.2);
    rotor.renderOrder = 3;
    heli.add(rotor);
    // A netted load on a long line under the belly.
    const slung = [tinted(cyl(0.014, 0.014, 9, 5), DARK, 0, -4.5, 0), tinted(rb(1.4, 1.15, 1.4, 0.14, 1.6, 2), NET, 0, -9.6, 0)];
    for (const turn of [0, PI / 2]) slung.push(tinted(bx(1.46, 0.06, 0.08).rotateY(turn), DARK, 0, -9.6, 0), tinted(bx(0.08, 1.2, 1.46).rotateY(turn), DARK, 0, -9.6, 0));
    for (const side of [-1, 1]) for (const way of [-1, 1]) slung.push(tinted(rod([0, -8.2, 0], [side * 0.66, -9.05, way * 0.66], 0.012, 4), DARK));
    heliLoad.add(new THREE.Mesh(mergeGeometries(slung), paint));
    heliLoad.position.set(0, -0.6, 0.2);
    heli.add(heliLoad);
    heli.rotation.order = "YXZ";
    heli.visible = false;
    heli.traverse((part) => { part.userData.walkThrough = true; part.frustumCulled = false; });
    scene.add(heli);
    kit.mirrorHidden.push(heli);
    kit.probeHidden.push(heli);
  }
  // It flies the supply run one way, then back: in over the far end and out over the main building, or the reverse.
  const HELI_SPEED = 16, HEARD_AHEAD = 6.75;
  const runFrom = new THREE.Vector3(-6, 27, -100), runTo = new THREE.Vector3(10, 27, 62), runLength = runFrom.distanceTo(runTo), heliAt = new THREE.Vector3();
  const flight = { leaves: -1, back: false, flushed: true, asked: -1, asks: 4, pitch: 1 };
  const parkLamps = () => { for (let lamp = 0; lamp < 2; lamp += 1) haloPlaces.setY(heliLamps + lamp, -900); haloPlaces.needsUpdate = true; };

  // One clock for all of it. Nothing below runs oftener than once a second on average, and each is heard where it is seen.
  const beat = { began: -1, entered: -1, looked: NaN, gustWas: 0, gustHeard: -100, turns: 0, slide: 16 + chance() * 8, slideAt: -1, drop: 9 + chance() * 8, call: -1, radioed: false };
  kit.updates.push((now) => {
    const seconds = now / 1000;
    if (beat.began < 0) beat.began = seconds;
    const since = seconds - beat.began;
    puffClock.value = since;
    // The first helicopter is called as the player comes in: when the pointer is taken (which is also when sound
    // starts) or, where there is no pointer to take, when the view first moves.
    if (beat.entered < 0 && since > 0.5) {
      const view = eye.x + eye.z + eye.look;
      if (Number.isNaN(beat.looked)) beat.looked = view;
      if (document.pointerLockElement || Math.abs(view - beat.looked) > 0.01) { beat.entered = since; beat.call = since + 2.4; }
    }

    // Radar: about one turn in two and a half seconds, with a dry bearing heard every other turn.
    scanner.rotation.y = since * 2.4;
    if (Math.floor(scanner.rotation.y / (PI * 4)) > beat.turns) { beat.turns = Math.floor(scanner.rotation.y / (PI * 4)); say("metalCreak", radarAt[0], radarAt[1], radarAt[2], 0.28, 0.85 + chance() * 0.3); }

    // A gust front reaching the player is heard arriving from upwind.
    const gust = wind.at(eye.x, eye.z);
    if (gust > 0.5 && beat.gustWas <= 0.5 && since - beat.gustHeard > 8) {
      beat.gustHeard = since;
      say("windGust", eye.x - WIND.x * 12, 3, eye.z - WIND.z * 12, 0.55 + gust * 0.5, 0.9 + chance() * 0.2);
    }
    beat.gustWas = gust;

    // Snow lets go of a bough or a roof edge when a gust shakes it: a slab drops, bursts and drifts off downwind.
    if (since > beat.slide && beat.slideAt < 0) beat.slideAt = since;
    if (beat.slideAt >= 0 && (gust > 0.42 || since - beat.slideAt > 7)) {
      beat.slideAt = -1; beat.slide = since + 17 + chance() * 20;
      const tree = shedders[Math.floor(chance() * shedders.length)], roof = chance() < 0.45, side = eye.x < 0 || chance() < 0.3 ? -1 : 1;
      const x = roof ? side * 9.42 : tree.x + (chance() - 0.5) * 1.6, z = roof ? THREE.MathUtils.clamp(eye.z - 2 - chance() * 9, -27, -1) : tree.z + (chance() - 0.5) * 1.6;
      const y = roof ? (side < 0 ? HAB_TOP : SHED_TOP) + 0.1 : tree.y + tree.tall * (0.4 + chance() * 0.25), floor = roof ? 0.25 : tree.y + 0.1;
      say("snowSlide", x, y, z, roof ? 0.9 : 0.75, 0.9 + chance() * 0.25);
      flurry(x, y, z, floor, 26, roof ? 0.7 : 0.5, 1.1, roof ? 0.6 : 0.5, 2.7, 3.3);
      flurry(x, y, z, floor, 10, 0.3, 0.5, 0.3, 2.3, 3.8, 0.92);
    }

    // Icicles.
    if (since > beat.drop) {
      beat.drop = since + 20 + chance() * 30;
      const hanging = loose.map((one, index) => (one.state === 0 ? index : -1)).filter((index) => index >= 0);
      if (hanging.length) { const one = loose[hanging[Math.floor(chance() * hanging.length)]]; one.state = 1; one.since = since; one.heard = false; }
    }
    for (let index = 0; index < loose.length; index += 1) {
      const one = loose[index];
      if (one.state === 0) continue;
      const age = since - one.since;
      if (one.state === 1) {
        const drop = 4.9 * age * age, lands = Math.sqrt((one.y - one.length - LANDS) / 4.9);
        // The sound is a snap and then the break a third of a second on: started so the break meets the ground.
        if (!one.heard && age > lands - 0.35) { one.heard = true; say("icicleDrop", one.x, LANDS, one.z, 0.9, 0.9 + chance() * 0.25); }
        if (age < lands) { hangLoose(index, drop, 1, age * 1.3); continue; }
        flurry(one.x, LANDS + 0.05, one.z, LANDS, 8, 0.12, 1.5, 0.16, 0.8, 1.6, 0.95);
        one.state = 2; one.since = since;
        hangLoose(index, 0, 0, 0);
      } else if (age > GROWS) {
        const grown = Math.min(1, (age - GROWS) / 30);
        hangLoose(index, 0, grown, 0);
        if (grown >= 1) one.state = 0;
      }
    }

    // Helicopter. The radio breaks squelch, the rotor is heard, then it comes out of the weather, crosses and is gone.
    if (beat.call >= 0 && since > beat.call - 1.3 && !beat.radioed) { beat.radioed = true; say("radioSquelch", -8.8, 1.6, -4, 0.9, 1); }
    if (beat.call >= 0 && since > beat.call) {
      const from = flight.back ? runTo : runFrom, to = flight.back ? runFrom : runTo;
      // It is nearest the player a fixed time after it is first heard, wherever they stand along its way.
      const nearest = THREE.MathUtils.clamp(((eye.x - from.x) * (to.x - from.x) + (eye.z - from.z) * (to.z - from.z)) / runLength, 20, runLength - 20);
      flight.leaves = since + HEARD_AHEAD - nearest / HELI_SPEED;
      flight.flushed = false;
      flight.asked = since; flight.asks = 0; flight.pitch = 0.94 + chance() * 0.12;
      beat.call = -1; beat.radioed = false;
    }
    // The rotor is asked for until it has had time to answer: a voice this long may still be rendering the first
    // time it is wanted (and is then not played), and asking again for one that is already playing does nothing.
    if (flight.asks < 4 && since >= flight.asked + flight.asks * 0.7) { flight.asks += 1; say("heliPass", eye.x, 27, eye.z, 1, flight.pitch); }
    if (flight.leaves >= 0) {
      const flown = (since - flight.leaves) * HELI_SPEED, from = flight.back ? runTo : runFrom, to = flight.back ? runFrom : runTo;
      if (flown > runLength) {
        heli.visible = false; flight.leaves = -1; flight.back = !flight.back;
        parkLamps();
        beat.call = since + 48 + chance() * 30;
      } else if (flown >= 0) {
        heliAt.lerpVectors(from, to, flown / runLength);
        heliAt.y += Math.sin(since * 0.9) * 0.5;
        heli.visible = true;
        heli.position.copy(heliAt);
        heli.rotation.set(-0.09 + Math.sin(since * 1.3) * 0.015, Math.atan2(from.x - to.x, from.z - to.z), Math.sin(since * 0.8) * 0.05);
        rotor.rotation.y = since * 7.3;
        heliLoad.rotation.set(0.2 + Math.sin(since * 1.25) * 0.07, 0, Math.sin(since * 1.05 + 1) * 0.06);
        const yaw = heli.rotation.y;
        haloPlaces.setXYZ(heliLamps, heliAt.x - Math.sin(yaw) * 2.1, heliAt.y - 0.9, heliAt.z - Math.cos(yaw) * 2.1);
        haloPlaces.setXYZ(heliLamps + 1, heliAt.x, heliAt.y - 1.3, heliAt.z);
        haloPlaces.needsUpdate = true;
        // Low over the main building it puts up the crows on that roof; the ones down the range sit tight for the guns.
        if (!flight.flushed && Math.abs(heliAt.z - 8) < 5) { flight.flushed = true; life.startle(heliAt, 0.45); }
      }
    }
  });

  const sunlit = sunlitFromBoxes(TO_SUN, [
    new THREE.Box3(new THREE.Vector3(9.54, 0, SIDE_FROM), new THREE.Vector3(15.7, SHED_TOP + 0.4, SIDE_TO)),
    new THREE.Box3(new THREE.Vector3(-15.5, 0, SIDE_FROM), new THREE.Vector3(-9.54, HAB_TOP + 0.4, SIDE_TO)),
    new THREE.Box3(new THREE.Vector3(-10.4, 0, 9.7), new THREE.Vector3(10.4, MAIN_TOP + 0.4, 15)),
  ]);

  const range = kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: [
      { position: new THREE.Vector3(-8.3, 5.7, 3.5), color: new THREE.Color(0xffa758).multiplyScalar(0.8) },
      { position: new THREE.Vector3(8.3, 5.7, 3.5), color: new THREE.Color(0xffa758).multiplyScalar(0.8) },
      { position: new THREE.Vector3(0, 5.2, festoonZ), color: new THREE.Color(0xffc27a).multiplyScalar(0.5) },
    ],
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: FOG, fog: FOG, fogDensity: high ? 0.0185 : 0.0195,
      haze: new THREE.Color(0.2, 0.225, 0.26), hazeDensity: 0.0038, hazeCeiling: 11, hazeFade: 5,
      environmentIntensity: 0.9, exposure: 0.8, far: 300,
    },
    sunlitAt: (point) => 0.35 + 0.65 * sunlit(point),
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
  return { ...range, startle: life.startle, struck: (object, point) => life.struck(object, point) };
}

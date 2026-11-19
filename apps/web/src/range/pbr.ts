import * as THREE from "three";
import { shrinkRgba } from "./touch";

// Procedural, tileable PBR texture sets generated once at load.
// Every set carries base colour, a tangent-space normal map derived from a
// height field, and an ORM map (R = occlusion, G = roughness, B = metalness),
// so no surface in the range is a flat colour any more and nothing is fetched
// from a third party at runtime.

export type PbrSet = {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  ormMap: THREE.DataTexture;
};

type RGB = [number, number, number];

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Tileable value noise: `px` × `py` lattice cells across an n × n tile. */
function valueNoise(n: number, px: number, py: number, seed: number) {
  const next = random(seed);
  const lattice = new Float32Array(px * py);
  for (let i = 0; i < lattice.length; i += 1) lattice[i] = next();
  const out = new Float32Array(n * n);
  const x0 = new Int32Array(n), x1 = new Int32Array(n), tx = new Float32Array(n);
  for (let x = 0; x < n; x += 1) {
    const f = (x / n) * px, i = Math.floor(f), t = f - i;
    x0[x] = i % px; x1[x] = (i + 1) % px; tx[x] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < n; y += 1) {
    const f = (y / n) * py, i = Math.floor(f), t = f - i, ty = t * t * (3 - 2 * t);
    const r0 = (i % py) * px, r1 = ((i + 1) % py) * px, row = y * n;
    for (let x = 0; x < n; x += 1) {
      const a = lattice[r0 + x0[x]], b = lattice[r0 + x1[x]], c = lattice[r1 + x0[x]], d = lattice[r1 + x1[x]];
      const top = a + (b - a) * tx[x], bottom = c + (d - c) * tx[x];
      out[row + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

function fbm(n: number, px: number, py: number, octaves: number, seed: number, gain = 0.5) {
  const out = new Float32Array(n * n);
  let amplitude = 1, total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const layer = valueNoise(n, Math.min(n, px << octave), Math.min(n, py << octave), seed + octave * 977);
    for (let i = 0; i < out.length; i += 1) out[i] += layer[i] * amplitude;
    total += amplitude;
    amplitude *= gain;
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const toSrgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

class Surface {
  readonly n: number;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array; // linear albedo
  readonly height: Float32Array; readonly rough: Float32Array; readonly metal: Float32Array; readonly ao: Float32Array;

  constructor(n: number, color: RGB, roughness: number, metalness: number) {
    this.n = n;
    const size = n * n;
    this.r = new Float32Array(size).fill(color[0]);
    this.g = new Float32Array(size).fill(color[1]);
    this.b = new Float32Array(size).fill(color[2]);
    this.height = new Float32Array(size);
    this.rough = new Float32Array(size).fill(roughness);
    this.metal = new Float32Array(size).fill(metalness);
    this.ao = new Float32Array(size).fill(1);
  }

  index(x: number, y: number) {
    const n = this.n;
    return (((y % n) + n) % n) * n + (((x % n) + n) % n);
  }

  tint(i: number, color: RGB, amount: number) {
    this.r[i] += (color[0] - this.r[i]) * amount;
    this.g[i] += (color[1] - this.g[i]) * amount;
    this.b[i] += (color[2] - this.b[i]) * amount;
  }

  scale(i: number, factor: number) { this.r[i] *= factor; this.g[i] *= factor; this.b[i] *= factor; }

  /** Thin wrapped stroke; `paint` receives the pixel index and a 0..1 falloff. */
  stroke(x: number, y: number, angle: number, length: number, width: number, paint: (i: number, weight: number) => void) {
    const dx = Math.cos(angle), dy = Math.sin(angle), half = Math.ceil(width);
    for (let step = 0; step < length; step += 1) {
      const cx = x + dx * step, cy = y + dy * step, fade = Math.sin((step / length) * Math.PI);
      for (let o = -half; o <= half; o += 1) {
        const weight = clamp01(1 - Math.abs(o) / width) * fade;
        if (weight > 0) paint(this.index(Math.round(cx - dy * o), Math.round(cy + dx * o)), weight);
      }
    }
  }

  disc(x: number, y: number, radius: number, paint: (i: number, weight: number, distance: number) => void) {
    const reach = Math.ceil(radius);
    for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const distance = Math.hypot(ox, oy) / radius;
        if (distance <= 1) paint(this.index(Math.round(x + ox), Math.round(y + oy)), 1 - distance, distance);
      }
    }
  }

  build(normalStrength: number, anisotropy: number): PbrSet {
    const n = this.n, size = n * n;
    const albedo = new Uint8Array(size * 4), normal = new Uint8Array(size * 4), orm = new Uint8Array(size * 4);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = y * n + x, o = i * 4;
        albedo[o] = toSrgb(clamp01(this.r[i])); albedo[o + 1] = toSrgb(clamp01(this.g[i])); albedo[o + 2] = toSrgb(clamp01(this.b[i])); albedo[o + 3] = 255;
        const left = this.height[this.index(x - 1, y)], right = this.height[this.index(x + 1, y)];
        const down = this.height[this.index(x, y - 1)], up = this.height[this.index(x, y + 1)];
        const nx = (left - right) * normalStrength, ny = (down - up) * normalStrength;
        const inverse = 1 / Math.hypot(nx, ny, 1);
        normal[o] = Math.round((nx * inverse * 0.5 + 0.5) * 255);
        normal[o + 1] = Math.round((ny * inverse * 0.5 + 0.5) * 255);
        normal[o + 2] = Math.round((inverse * 0.5 + 0.5) * 255);
        normal[o + 3] = 255;
        orm[o] = Math.round(clamp01(this.ao[i]) * 255);
        orm[o + 1] = Math.round(clamp01(this.rough[i]) * 255);
        orm[o + 2] = Math.round(clamp01(this.metal[i]) * 255);
        orm[o + 3] = 255;
      }
    }
    const texture = (full: Uint8Array, srgb: boolean) => {
      const { data, width, height } = shrinkRgba(full, n, n);
      const result = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
      result.wrapS = result.wrapT = THREE.RepeatWrapping;
      result.magFilter = THREE.LinearFilter;
      result.minFilter = THREE.LinearMipmapLinearFilter;
      result.generateMipmaps = true;
      result.anisotropy = anisotropy;
      if (srgb) result.colorSpace = THREE.SRGBColorSpace;
      result.needsUpdate = true;
      return result;
    };
    return { map: texture(albedo, true), normalMap: texture(normal, false), ormMap: texture(orm, false) };
  }
}

/** Factory-painted steel plate: panel seams, rivets, chipped edges, rust and grime runs. */
export function paintedSteel(anisotropy: number, paint: RGB, seed = 11, wear = 0.5, n = 1024): PbrSet {
  const s = new Surface(n, paint, 0.52, 0);
  const tone = fbm(n, 3, 3, 4, seed), peel = fbm(n, 96, 96, 2, seed + 1), chips = fbm(n, 28, 28, 4, seed + 2, 0.55);
  const streak = fbm(n, 64, 2, 3, seed + 3), grime = fbm(n, 5, 5, 4, seed + 4);
  const panel = n / 2, next = random(seed + 5);
  const bare: RGB = [0.3, 0.29, 0.275], rust: RGB = [0.2, 0.075, 0.028];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x;
      const sx = Math.min(x % panel, panel - (x % panel)), sy = Math.min(y % panel, panel - (y % panel));
      const seam = Math.min(sx, sy);
      s.scale(i, 0.84 + tone[i] * 0.32);
      s.height[i] = 0.5 + (peel[i] - 0.5) * 0.035;
      s.rough[i] = 0.46 + peel[i] * 0.1 + grime[i] * 0.16;
      // Dirt gathers in drips below horizontal seams and in broad patches.
      const drip = smooth(0.52, 0.78, streak[i]) * smooth(panel * 0.62, 0, sy) * (0.2 + wear * 0.4);
      const dirt = clamp01(drip + smooth(0.56, 0.86, grime[i]) * (0.14 + wear * 0.36));
      s.tint(i, [0.035, 0.03, 0.025], dirt);
      s.rough[i] += dirt * 0.22;
      // Paint flakes away at panel edges first.
      const edge = smooth(46, 0, seam);
      const chip = chips[i] + edge * 0.2 - (1 - wear) * 0.13;
      if (chip > 0.7) {
        const depth = smooth(0.7, 0.735, chip);
        s.tint(i, bare, depth); s.metal[i] = depth; s.rough[i] = 0.5 - depth * 0.14 + peel[i] * 0.12;
        s.height[i] -= depth * 0.07;
      } else if (chip > 0.655) {
        const halo = smooth(0.655, 0.7, chip);
        s.tint(i, rust, halo * 0.85); s.rough[i] = Math.max(s.rough[i], 0.6 + halo * 0.3);
      }
      if (seam < 3.5) { const groove = 1 - seam / 3.5; s.height[i] -= groove * 0.55; s.scale(i, 1 - groove * 0.72); s.ao[i] = 1 - groove * 0.7; s.rough[i] = 0.85; }
      else if (seam < 12) s.ao[i] = 0.72 + (seam - 3.5) / 8.5 * 0.28;
    }
  }
  for (let px = 0; px < n; px += panel) {
    for (let step = panel / 8; step < n; step += panel / 4) {
      for (const [cx, cy] of [[px + 15, step], [px + panel - 15, step], [step, px + 15], [step, px + panel - 15]]) {
        s.disc(cx, cy, 6.5, (i, weight, distance) => {
          s.height[i] += Math.sqrt(1 - distance * distance) * 0.42;
          s.rough[i] = 0.42; s.scale(i, 1 + weight * 0.1);
        });
        s.disc(cx, cy + 8, 9, (i, weight) => { s.ao[i] = Math.min(s.ao[i], 1 - weight * 0.4); s.tint(i, rust, weight * 0.28); });
      }
    }
  }
  for (let count = 0; count < 30 + wear * 160; count += 1) {
    const deep = next() > 0.78;
    s.stroke(next() * n, next() * n, next() * Math.PI, 30 + next() * 190, deep ? 1.6 : 0.9, (i, weight) => {
      s.tint(i, deep ? bare : [0.42, 0.44, 0.43], weight * (deep ? 0.85 : 0.3));
      if (deep) { s.metal[i] = Math.max(s.metal[i], weight); s.height[i] -= weight * 0.05; }
      s.rough[i] = Math.min(s.rough[i], 0.5 - weight * 0.18);
    });
  }
  return s.build(5.2, anisotropy);
}

/** Bare machined or blued steel with fine directional scratching. */
export function steel(anisotropy: number, color: RGB, roughness = 0.4, seed = 23, n = 512): PbrSet {
  const s = new Surface(n, color, roughness, 1);
  const tone = fbm(n, 4, 4, 4, seed), grain = fbm(n, 128, 128, 2, seed + 1), smear = fbm(n, 3, 24, 3, seed + 2);
  const next = random(seed + 3);
  for (let i = 0; i < n * n; i += 1) {
    s.scale(i, 0.8 + tone[i] * 0.42);
    s.height[i] = 0.5 + (grain[i] - 0.5) * 0.05;
    s.rough[i] = roughness - 0.1 + tone[i] * 0.16 + smear[i] * 0.1 + (grain[i] - 0.5) * 0.08;
    s.tint(i, [0.09, 0.06, 0.04], smooth(0.6, 0.9, smear[i]) * 0.25);
  }
  for (let count = 0; count < 520; count += 1) {
    const angle = (next() - 0.5) * 0.5 + (next() > 0.86 ? Math.PI / 2 : 0);
    const bright = next() > 0.4;
    s.stroke(next() * n, next() * n, angle, 12 + next() * 120, 0.8, (i, weight) => {
      s.scale(i, bright ? 1 + weight * 0.75 : 1 - weight * 0.3);
      s.rough[i] = clamp01(s.rough[i] - weight * 0.16);
      s.height[i] -= weight * 0.035;
    });
  }
  return s.build(3.4, anisotropy);
}

/** Linear brushed metal for ducting and rails. */
export function brushedMetal(anisotropy: number, color: RGB, seed = 31, n = 512): PbrSet {
  const s = new Surface(n, color, 0.34, 1);
  const lines = fbm(n, 2, 256, 2, seed), tone = fbm(n, 4, 4, 3, seed + 1), spots = fbm(n, 22, 22, 3, seed + 2);
  for (let i = 0; i < n * n; i += 1) {
    s.scale(i, 0.78 + lines[i] * 0.3 + tone[i] * 0.16);
    s.height[i] = 0.5 + (lines[i] - 0.5) * 0.06;
    s.rough[i] = 0.26 + lines[i] * 0.2 + tone[i] * 0.12;
    const stain = smooth(0.66, 0.82, spots[i]);
    s.tint(i, [0.07, 0.05, 0.035], stain * 0.5); s.rough[i] += stain * 0.3;
  }
  return s.build(2.6, anisotropy);
}

/** Corrugated galvanised roof deck (ribs run along V). */
export function roofDeck(anisotropy: number, seed = 41, n = 1024): PbrSet {
  const s = new Surface(n, [0.3, 0.33, 0.34], 0.5, 1);
  const tone = fbm(n, 6, 6, 4, seed), spangle = fbm(n, 90, 90, 2, seed + 1), streak = fbm(n, 48, 2, 3, seed + 2);
  const ribs = 8, period = n / ribs;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x, phase = (x % period) / period;
      // Trapezoidal rib profile.
      const rib = smooth(0.08, 0.24, phase) - smooth(0.52, 0.68, phase);
      s.height[i] = rib * 0.9 + (spangle[i] - 0.5) * 0.02;
      s.scale(i, 0.72 + tone[i] * 0.3 + spangle[i] * 0.2);
      s.ao[i] = 0.55 + rib * 0.45;
      s.rough[i] = 0.4 + spangle[i] * 0.2 + tone[i] * 0.1;
      const corrosion = smooth(0.6, 0.86, streak[i] * 0.6 + tone[i] * 0.5);
      s.tint(i, [0.17, 0.085, 0.04], corrosion * 0.55);
      s.metal[i] = 1 - corrosion * 0.8; s.rough[i] += corrosion * 0.32;
      if (y % (n / 2) < 3) { s.height[i] -= 0.25; s.scale(i, 0.45); }
    }
  }
  return s.build(7, anisotropy);
}

/** Timber. `planks` > 0 lays boards along V with dark gaps; 0 gives one continuous stock blank. */
export function timber(anisotropy: number, dark: RGB, light: RGB, planks: number, seed = 53, n = 512): PbrSet {
  const s = new Surface(n, light, 0.62, 0);
  const warp = fbm(n, 3, 2, 4, seed), fine = fbm(n, 160, 6, 2, seed + 1), tone = fbm(n, 4, 4, 3, seed + 2), pores = fbm(n, 200, 24, 2, seed + 3);
  const next = random(seed + 4);
  const boardWidth = planks > 0 ? n / planks : n;
  const boardTone = Array.from({ length: Math.max(planks, 1) }, () => 0.82 + next() * 0.36);
  const boardShift = Array.from({ length: Math.max(planks, 1) }, () => next() * 50);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x, board = Math.min(boardTone.length - 1, Math.floor(x / boardWidth));
      const rings = Math.sin((x / n) * Math.PI * 2 * (planks > 0 ? 44 : 30) + warp[i] * 9 + boardShift[board]);
      const grain = clamp01(0.5 + rings * 0.13 + (fine[i] - 0.5) * 1.05 + (tone[i] - 0.5) * 0.3);
      const shade = (0.76 + tone[i] * 0.42) * boardTone[board];
      s.r[i] = (dark[0] + (light[0] - dark[0]) * grain) * shade;
      s.g[i] = (dark[1] + (light[1] - dark[1]) * grain) * shade;
      s.b[i] = (dark[2] + (light[2] - dark[2]) * grain) * shade;
      s.height[i] = 0.5 + (grain - 0.5) * 0.16 - smooth(0.62, 0.9, pores[i]) * 0.07;
      s.rough[i] = 0.5 + (1 - grain) * 0.22 + pores[i] * 0.12;
      if (planks > 0) {
        const gap = Math.min(x % boardWidth, boardWidth - (x % boardWidth));
        if (gap < 3) { const groove = 1 - gap / 3; s.height[i] -= groove * 0.6; s.scale(i, 1 - groove * 0.85); s.ao[i] = 1 - groove * 0.75; }
        else if (gap < 9) s.ao[i] = 0.78 + (gap - 3) / 6 * 0.22;
      }
    }
  }
  if (planks > 0) {
    for (let count = 0; count < planks * 2; count += 1) {
      const cx = next() * n, cy = next() * n, radius = 9 + next() * 12;
      s.disc(cx, cy, radius, (i, weight, distance) => {
        const ring = 0.5 + 0.5 * Math.sin(distance * 16);
        s.scale(i, 1 - weight * 0.62 - ring * 0.12 * (1 - weight));
        s.height[i] -= weight * 0.1; s.rough[i] = Math.min(1, s.rough[i] + weight * 0.12);
      });
    }
    for (let count = 0; count < 70; count += 1) {
      s.stroke(next() * n, next() * n, Math.PI / 2 + (next() - 0.5) * 1.3, 8 + next() * 60, 1.1, (i, weight) => {
        s.scale(i, 1 + weight * 0.35); s.height[i] -= weight * 0.08; s.rough[i] = Math.min(1, s.rough[i] + weight * 0.2);
      });
    }
  }
  return s.build(planks > 0 ? 5 : 2.2, anisotropy);
}

/** Moulded polymer / rubber: tight stipple, no metal. */
export function polymer(anisotropy: number, color: RGB, seed = 67, n = 256): PbrSet {
  const s = new Surface(n, color, 0.62, 0);
  const stipple = fbm(n, 128, 128, 1, seed), tone = fbm(n, 5, 5, 3, seed + 1);
  for (let i = 0; i < n * n; i += 1) {
    s.scale(i, 0.82 + tone[i] * 0.36);
    s.height[i] = stipple[i] * 0.3;
    s.rough[i] = 0.52 + stipple[i] * 0.2 + tone[i] * 0.12;
  }
  return s.build(2.4, anisotropy);
}

export function disposePbr(set: PbrSet) {
  set.map.dispose();
  set.normalMap.dispose();
  set.ormMap.dispose();
}

/** Standard material wired to a generated set. */
export function pbrMaterial(set: PbrSet, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.ormMap,
    metalnessMap: set.ormMap,
    aoMap: set.ormMap,
    roughness: 1,
    metalness: 1,
    ...options,
  });
}

/** Tiling is per texture in three.js, so apply it to the whole set. */
export function tile(set: PbrSet, x: number, y: number) {
  for (const texture of [set.map, set.normalMap, set.ormMap]) texture.repeat.set(x, y);
  return set;
}

/** Independent tiling of an already generated set (shares the pixel data). */
export function retile(set: PbrSet, x: number, y: number): PbrSet {
  const copy = (texture: THREE.DataTexture) => { const next = texture.clone(); next.needsUpdate = true; return next; };
  return tile({ map: copy(set.map), normalMap: copy(set.normalMap), ormMap: copy(set.ormMap) }, x, y);
}

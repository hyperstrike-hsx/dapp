import * as THREE from "three";
import { drawnOnce } from "./memory";
import type { Kit } from "./kit";
import { applyWind, type Wind } from "./wind";

// Shared tree and plant library.
//
// Every map used to hand-roll its vegetation: blob canopies, flat cards, nothing moving. This file
// grows the plants once, properly, and every map places them:
//
//   const trees = createTrees(kit, { wind, sun: () => sun });   // the sun light may be made later
//   trees.place("plane", [{ at: [6, 0, -12], yaw: 0.4 }, { at: [-7, 0, -20], variant: 1, scale: 0.9 }]);
//   trees.place("treeGrate", [{ at: [6, 0, -12] }]);
//
// The library adds its own update to kit.updates (it advances the wind and follows the sun).
//
// How a tree is put together:
//   - A branching skeleton is grown from a seed (trunk, scaffolds, branches, twigs): limbs arc as
//     they go, kink where a branch leaves them and end in forks, and their thickness follows the
//     pipe model (a limb's section is the sum of those it feeds). Every limb is meshed as a tube
//     with a collar at its base and a buttressed root flare at the ground. Palms get a leaning stem
//     latticed with old leaf bases, with boots under the crown.
//   - Foliage is thousands of small sprig cards set round the twigs, each facing its own way, cut
//     from one drawn atlas of species-correct sprays (conifers: needle sprays raked off each bough).
//     The atlas carries its own mip chain with alpha coverage preserved, so thin leaves keep their
//     density at a distance. Card normals are bent towards the crown's masses and depth-in-canopy is
//     baked to vertex colour, so a crown shades as a volume, not as a pile of cards.
//   - Three materials serve the whole library (bark, foliage, pots and soil). Light passing through
//     leaves, snow settling on upward faces, dryness and the wind are all in their shaders.
//   - The wind is the map's shared field (range/wind.ts): trunks lean by height squared, limbs sway
//     with their own phase, leaves flutter, fronds bob and twist. Nothing moves at strength 0.
//   - Shadows: the sun's map is rendered once, so shadows are those of the tree at rest, and leaves
//     cast leaf-shaped ones (alpha-tested depth material).
//   - Only trunks and pots stand in the player's way: foliage and the plants in pots are marked
//     `userData.walkThrough` for range/solids.ts.
//
// Everything is one InstancedMesh per kind, part, shape variant and detail level.

export type TreeKind =
  | "plane" | "orange" | "olive" | "bare" | "cypress" | "spruce" | "datePalm" | "fanPalm"
  | "shrub" | "boxBall" | "hedge"
  | "potLaurel" | "potFern" | "potAgave" | "flowerBox"
  | "ivy" | "bougainvillea" | "grass" | "weeds"
  | "treePit" | "treeGrate" | "soilRing" | "leafLitter";

/** hero: can be walked up to. mid: across the range. far: backdrop beyond about 40 m. */
export type TreeDetail = "hero" | "mid" | "far";
export type TreePart = "bark" | "foliage" | "pot";

export type TreeItem = {
  /** Where the plant meets the ground (or, for wall climbers, the foot of the wall). */
  at: [number, number, number];
  yaw?: number;
  scale?: number | [number, number, number];
  /** Seeded shape variant, wrapped to the number the kind has (see `get(kind).variants`). */
  variant?: number;
  /** Tilt of the whole plant in radians: a number tips it towards its own +x, a pair towards world [x, z]. */
  lean?: number | [number, number];
  /** Multiplies the plant's colour (bark, leaves and pot alike). */
  tint?: THREE.ColorRepresentation;
  detail?: TreeDetail;
  /** 0..1 snow lying on upward faces; on the spruce it also loads the boughs. */
  snow?: number;
  /** 0..1 drought: leaves yellow and brown. */
  dry?: number;
  /** 0..1 how much fruit or flower shows (oranges, geraniums, bougainvillea bracts). Default 1. */
  bloom?: number;
};

export type TreePlaceOptions = {
  /** Detail for items that do not name their own. Default "hero". */
  detail?: TreeDetail;
  /** Cast shadows. Default true (false for ground decals). */
  shadow?: boolean;
  /** Stop bullets on trunks and pots. Default true. */
  hit?: boolean;
  /** Make the foliage stand in the player's way too (a hedge used as a barrier). Default false. */
  solid?: boolean;
};

export type TreeInfo = {
  kind: TreeKind;
  detail: TreeDetail;
  variant: number;
  variants: number;
  /** Width (x), height (y) and depth (z) of the plant at rest, metres. */
  size: [number, number, number];
  triangles: number;
  parts: Partial<Record<TreePart, number>>;
  note: string;
};

export type Trees = {
  readonly kinds: TreeKind[];
  /** Builds (once) and describes a kind without placing it. */
  get: (kind: TreeKind, detail?: TreeDetail, variant?: number) => TreeInfo;
  /** Places instances; returns the meshes it added (one per part, variant and detail in use). */
  place: (kind: TreeKind, items: TreeItem[], options?: TreePlaceOptions) => THREE.InstancedMesh[];
  /** Advances the shared wind and follows the sun. Already on kit.updates; call it yourself only outside a kit loop. */
  update: (now: number) => void;
  dispose: () => void;
};

export type TreesOptions = {
  seed?: number;
  /** The map's shared wind (range/wind.ts). */
  wind: Wind;
  /**
   * The sun: its light, the direction towards it, or a function returning either (for a light the map
   * makes after its trees). Given the light, leaves under a thin cover of crown also glow with the
   * sun that comes through it; that reads the light's own shadow map, which must be the first
   * shadow-casting directional light in the scene.
   */
  sun: THREE.DirectionalLight | THREE.Vector3 | (() => THREE.DirectionalLight | THREE.Vector3);
};

type V3 = [number, number, number];
type V4 = [number, number, number, number];
type Random = () => number;
type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const UP: V3 = [0, 1, 0];

function rng(seed: number): Random {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, value: number) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };
const add = (a: V3, b: V3, scale = 1): V3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const norm = (a: V3, fallback: V3 = UP): V3 => { const length = Math.hypot(a[0], a[1], a[2]); return length > 1e-6 ? [a[0] / length, a[1] / length, a[2] / length] : fallback; };
const side = (direction: V3): V3 => norm(Math.abs(direction[1]) < 0.92 ? cross(direction, UP) : cross(direction, [1, 0, 0]));
/** `v` turned by `angle` round the unit `axis`. */
const turn = (v: V3, axis: V3, angle: number): V3 => {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v) * (1 - c), x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
};
/** A random unit vector. */
const anywhere = (random: Random): V3 => { const y = random() * 2 - 1, a = random() * TAU, r = Math.sqrt(1 - y * y); return [Math.cos(a) * r, y, Math.sin(a) * r]; };

/**
 * Growing mesh. Besides position, normal and uv every vertex carries:
 *   color  rgb: baked shade and hue variation. a: a tag the shaders read (bark: which bark; foliage:
 *          1 leaf, 0.75 fruit or flower shown by `bloom`, 0.5 snow load shown by `snow`).
 *   wind   x: metres the trunk carries this point at full wind. y: metres its limb sways.
 *          z: limb phase and a per-card random packed as (floor(phase * 16) + random) / 16.
 *          w: signed metres of flutter along the normal (opposite signs across a card rock it).
 */
class Geo {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly t: number[] = [];
  readonly c: number[] = [];
  readonly w: number[] = [];
  readonly i: number[] = [];
  get count() { return this.p.length / 3; }
  get triangles() { return this.i.length / 3; }
  vert(p: V3, n: V3, u: number, v: number, c: V4, w: V4) {
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.t.push(u, v);
    this.c.push(c[0], c[1], c[2], c[3]); this.w.push(w[0], w[1], w[2], w[3]);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.i.push(a, b, c, a, c, d); }
  at(index: number): V3 { return [this.p[index * 3], this.p[index * 3 + 1], this.p[index * 3 + 2]]; }
  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.t, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 4));
    geometry.setAttribute("treeWind", new THREE.Float32BufferAttribute(this.w, 4));
    geometry.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Packs a limb's phase with a per-card random for `wind.z`. */
const phased = (phase: number, random: number) => (Math.floor(clamp(phase, 0, 0.999) * 16) + clamp(random, 0.02, 0.98)) / 16;

type Path = {
  pts: V3[];
  rad: number[];
  /** Per point: metres carried by the trunk and by the limb at full wind. */
  bend: number[];
  sway: number[];
  phase: number;
};

type TubeOptions = {
  /** Which bark (column of the bark atlas). */
  bark: number;
  /** Metres of bark one tile covers along the limb. */
  metres?: number;
  tint?: V3;
  /** Multiplies the radius at ring `i`, angle `a` (root flare, flutes, ring scars). */
  swell?: (i: number, a: number, t: number) => number;
  /** Darkens ring `i` (0..1 multiplier). */
  shade?: (i: number, t: number) => number;
  cap?: boolean;
};

/** Meshes a path as a tapered tube with smooth normals, bark coordinates and the path's wind weights. */
function tube(g: Geo, path: Path, sides: number, o: TubeOptions) {
  const { pts, rad } = path, count = pts.length, tint = o.tint ?? [1, 1, 1], metres = o.metres ?? 3;
  if (count < 2) return;
  // Whole turns of the bark tile round the limb, picked so the grain keeps its scale on thin limbs.
  const girth = TAU * (rad[0] + rad[count - 1]) * 0.5, turns = Math.max(1, Math.round(girth * 8 / metres));
  let normal = side(norm(sub(pts[1], pts[0]))), along = 0;
  const first = g.count, tag = o.bark / 4 + 0.02;
  for (let i = 0; i < count; i += 1) {
    const tangent = norm(sub(pts[Math.min(count - 1, i + 1)], pts[Math.max(0, i - 1)]));
    normal = norm(sub(normal, [tangent[0] * dot(normal, tangent), tangent[1] * dot(normal, tangent), tangent[2] * dot(normal, tangent)]), side(tangent));
    const binormal = cross(tangent, normal), t = i / (count - 1), shade = o.shade ? o.shade(i, t) : 1;
    if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    for (let k = 0; k <= sides; k += 1) {
      const a = (k % sides) / sides * TAU, c = Math.cos(a), s = Math.sin(a);
      const out: V3 = [normal[0] * c + binormal[0] * s, normal[1] * c + binormal[1] * s, normal[2] * c + binormal[2] * s];
      const r = rad[i] * (o.swell ? o.swell(i, a, t) : 1);
      g.vert(add(pts[i], out, r), out, k / sides * turns, along / metres, [tint[0] * shade, tint[1] * shade, tint[2] * shade, tag], [path.bend[i], path.sway[i], phased(path.phase, 0.5), 0]);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < count - 1; i += 1) for (let k = 0; k < sides; k += 1) {
    const a = first + i * ring + k;
    g.quad(a, a + 1, a + ring + 1, a + ring);
  }
  if (o.cap) {
    const last = count - 1, tangent = norm(sub(pts[last], pts[last - 1]));
    const centre = g.vert(pts[last], tangent, 0.5, along / metres, [tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8, tag], [path.bend[last], path.sway[last], phased(path.phase, 0.5), 0]);
    for (let k = 0; k < sides; k += 1) g.tri(first + last * ring + k, first + last * ring + k + 1, centre);
  }
}

/** A rectangle of an atlas in pixels, and the atlas size, for mapping cards. */
type Rect = { x: number; y: number; w: number; h: number };

type CardOptions = {
  /** 2: three by three vertices (hero). 1: three along, two across. 0: one quad. */
  grid: number;
  /** How far the tip hangs below the card's plane, as a fraction of its length. */
  droop?: number;
  /** Raises (positive) or drops (negative) the edges, as a fraction of the width. */
  cup?: number;
  bend: number;
  sway: number;
  phase: number;
  random: number;
  /** Metres of flutter at the card's edge. */
  flutter?: number;
  tint?: V3;
  tag?: number;
  /** Mirror the cell left to right. */
  flip?: boolean;
  /** Extra sway at the tip (hanging sprays, fronds). */
  whip?: number;
};

type Card = { first: number; count: number; centre: V3; normal: V3; area: number; group: number };

/**
 * One leaf-cluster card: the cell's foot (bottom centre, where its twig starts) sits on `base`, the
 * spray runs along `axis` and faces `normal`. Returns what the canopy pass needs to shade it.
 */
function card(g: Geo, cards: Card[] | null, group: number, base: V3, axis: V3, normal: V3, length: number, width: number, rect: Rect, size: number, o: CardOptions) {
  const across = norm(cross(axis, normal)), face = norm(cross(across, axis));
  const rows = o.grid > 0 ? 3 : 2, columns = o.grid > 1 ? 3 : 2, droop = o.droop ?? 0, cup = o.cup ?? 0, flutter = o.flutter ?? 0, tint = o.tint ?? [1, 1, 1];
  const first = g.count, z = phased(o.phase, o.random), tag = o.tag ?? 1;
  for (let r = 0; r < rows; r += 1) {
    const t = r / (rows - 1);
    for (let c = 0; c < columns; c += 1) {
      const s = c / (columns - 1) - 0.5, lift = -droop * length * t * t + cup * width * (4 * s * s - 0.33);
      const p: V3 = [
        base[0] + axis[0] * length * t + across[0] * width * s + face[0] * lift,
        base[1] + axis[1] * length * t + across[1] * width * s + face[1] * lift,
        base[2] + axis[2] * length * t + across[2] * width * s + face[2] * lift,
      ];
      const n = norm([face[0] + axis[0] * 2 * droop * t - across[0] * 8 * cup * s, face[1] + axis[1] * 2 * droop * t - across[1] * 8 * cup * s, face[2] + axis[2] * 2 * droop * t - across[2] * 8 * cup * s]);
      const u = (rect.x + (o.flip ? 0.5 - s : 0.5 + s) * rect.w) / size, v = (rect.y + (1 - t) * rect.h) / size;
      g.vert(p, n, u, v, [tint[0], tint[1], tint[2], tag], [o.bend, o.sway + (o.whip ?? 0) * t * t, z, flutter * (s * 2 * (0.35 + t) + 0.35 * t)]);
    }
  }
  for (let r = 0; r < rows - 1; r += 1) for (let c = 0; c < columns - 1; c += 1) {
    const a = first + r * columns + c;
    g.quad(a, a + 1, a + columns + 1, a + columns);
  }
  if (cards) cards.push({ first, count: rows * columns, centre: add(base, axis, length * 0.55), normal: face, area: length * width, group });
}


// ---- The foliage atlas ---------------------------------------------------------------------------
// One 2048 sheet of leaf sprays, each drawn leaf by leaf with its species' outline, veins and
// arrangement on the twig. A second canvas, painted in step, holds height (red), roughness (green)
// and how much light passes through (blue): it becomes the normal and surface map.

const ATLAS = 2048;
const cell = (x: number, y: number, w = 512, h = 512): Rect => ({ x, y, w, h });
const CELLS = {
  planeA: cell(0, 0), planeB: cell(512, 0), citrusA: cell(1024, 0), citrusB: cell(1536, 0),
  olive: cell(0, 512), box: cell(512, 512), ivy: cell(1024, 512), bract: cell(1536, 512),
  cypress: cell(0, 1024), spruce: cell(512, 1024), fan: cell(1024, 1024), geraniumLeaf: cell(1536, 1024, 256, 512), geraniumFlower: cell(1792, 1024, 256, 512),
  frond: cell(0, 1536, 1024, 256), fern: cell(1024, 1536, 512, 256), grass: cell(1536, 1536, 256, 256), weeds: cell(1792, 1536, 256, 256),
  twigs: cell(0, 1792, 512, 256), litter: cell(512, 1792, 512, 256), agave: cell(1024, 1792, 256, 256),
  fruit: cell(1284, 1796, 120, 120), core: cell(1412, 1796, 120, 120), snow: cell(1280, 1920, 256, 128), oliveB: cell(1536, 1792, 512, 256),
};

/** The four quarters of a cell: small sprigs of a dozen leaves, for crowns built from many small cards. */
const quarters = (rect: Rect): Rect[] => [cell(rect.x, rect.y, 256, 256), cell(rect.x + 256, rect.y, 256, 256), cell(rect.x, rect.y + 256, 256, 256), cell(rect.x + 256, rect.y + 256, 256, 256)];
const SPRIGS = {
  plane: [...quarters(CELLS.planeA), ...quarters(CELLS.planeB)],
  citrus: quarters(CELLS.citrusB),
  olive: [...quarters(CELLS.olive), cell(1536, 1792, 256, 256), cell(1792, 1792, 256, 256)],
};

type Ink = { a: Ctx; d: Ctx; random: Random };
type Hsl = [number, number, number];
type Shape = "ovate" | "lance" | "obovate" | "palmate" | "ivy" | "round";

const hsl = (h: number, s: number, l: number, alpha = 1) => `hsla(${Math.round(h)},${Math.round(clamp(s, 0, 100))}%,${Math.round(clamp(l, 0, 100))}%,${alpha})`;
/** Colour for the surface canvas: height, roughness and translucency, each 0..1. */
const surf = (height: number, rough: number, thru: number) => `rgb(${Math.round(clamp(height) * 255)},${Math.round(clamp(rough) * 255)},${Math.round(clamp(thru) * 255)})`;

const LOBES: Record<"palmate" | "ivy", Array<[number, number]>> = {
  palmate: [[-1.72, 0.52], [-0.84, 0.86], [0, 1], [0.84, 0.86], [1.72, 0.52]],
  ivy: [[-1.95, 0.5], [-0.98, 0.76], [0, 1], [0.98, 0.76], [1.95, 0.5]],
};

/** Leaf outline in its own frame: stalk end at the origin, tip at (length, 0). */
function outline(c: Ctx, shape: Shape, length: number, width: number) {
  c.beginPath();
  if (shape === "palmate" || shape === "ivy") {
    const lobes = LOBES[shape], hub = length * 0.2, reach = length * 0.8, squash = width / (length * 1.02);
    const point = (angle: number, radius: number): [number, number] => [hub + Math.cos(angle) * radius, Math.sin(angle) * radius * squash];
    c.moveTo(length * 0.06, 0);
    lobes.forEach(([angle, long], index) => {
      const r = reach * long;
      if (shape === "palmate") {
        // Each lobe: a shoulder tooth, a nick, the tip, and the same going down.
        c.lineTo(...point(angle - 0.3, r * 0.6)); c.lineTo(...point(angle - 0.2, r * 0.7)); c.lineTo(...point(angle - 0.16, r * 0.64));
        c.lineTo(...point(angle, r));
        c.lineTo(...point(angle + 0.16, r * 0.64)); c.lineTo(...point(angle + 0.2, r * 0.7)); c.lineTo(...point(angle + 0.3, r * 0.6));
      } else {
        const [tx, ty] = point(angle, r), [ax, ay] = point(angle - 0.34, r * 0.74), [bx, by] = point(angle + 0.34, r * 0.74);
        c.quadraticCurveTo(ax, ay, tx, ty); c.lineTo(bx, by);
      }
      if (index < lobes.length - 1) {
        const next = lobes[index + 1];
        c.lineTo(...point((angle + next[0]) / 2, reach * Math.min(long, next[1]) * (shape === "palmate" ? 0.5 : 0.7)));
      }
    });
    c.closePath();
  } else if (shape === "round") {
    const r = length / 2;
    for (let k = 0; k <= 40; k += 1) {
      const angle = Math.PI + 0.22 + k / 40 * (TAU - 0.44), radius = r * (0.93 + 0.07 * Math.cos(angle * 9));
      c.lineTo(r + Math.cos(angle) * radius, Math.sin(angle) * radius * (width / length));
    }
    c.lineTo(r * 0.78, 0);
    c.closePath();
  } else {
    const belly = shape === "obovate" ? 0.66 : shape === "lance" ? 0.42 : 0.36, half = width * 0.66;
    c.moveTo(0, 0);
    c.bezierCurveTo(length * belly * 0.5, -half, length * (belly + 0.3), -half * (shape === "obovate" ? 1.05 : 0.8), length, 0);
    c.bezierCurveTo(length * (belly + 0.3), half * (shape === "obovate" ? 1.05 : 0.8), length * belly * 0.5, half, 0, 0);
    c.closePath();
  }
}

type LeafLook = { rough: number; thru: number; veins?: number; shadow?: number; fold?: number; rib?: number };

/** One leaf on both canvases: shadow on what lies under it, graded blade, lit half, midrib and veins. */
function leaf(ink: Ink, x: number, y: number, angle: number, length: number, width: number, shape: Shape, colour: Hsl, look: LeafLook) {
  const { a, d } = ink, [h, s, l] = colour, veins = look.veins ?? 4, rib = look.rib ?? 14;
  if ((look.shadow ?? 1) > 0) {
    a.save(); a.globalCompositeOperation = "source-atop"; a.translate(x + length * 0.03, y + length * 0.05); a.rotate(angle);
    outline(a, shape, length * 1.03, width * 1.12); a.fillStyle = `rgba(5,12,4,${0.4 * (look.shadow ?? 1)})`; a.fill(); a.restore();
  }
  const lobed = shape === "palmate" || shape === "ivy", hub = lobed ? length * 0.2 : 0;
  const ribs = (c: Ctx) => {
    c.beginPath();
    if (lobed) {
      const squash = width / (length * 1.02);
      c.moveTo(0, 0); c.lineTo(hub, 0);
      for (const [lobe, long] of LOBES[shape as "palmate" | "ivy"]) { c.moveTo(hub, 0); c.lineTo(hub + Math.cos(lobe) * length * 0.74 * long, Math.sin(lobe) * length * 0.74 * long * squash); }
    } else if (shape === "round") {
      for (let k = 0; k < 7; k += 1) { const lobe = -1.9 + k * 0.63; c.moveTo(length * 0.5, 0); c.lineTo(length * 0.5 + Math.cos(lobe) * length * 0.44, Math.sin(lobe) * width * 0.44); }
    } else { c.moveTo(0, 0); c.lineTo(length * 0.97, 0); }
    c.stroke();
  };
  const side = (c: Ctx) => {
    if (lobed || shape === "round" || veins <= 0) return;
    c.beginPath();
    for (let k = 1; k <= veins; k += 1) {
      const at = length * (0.1 + 0.72 * k / (veins + 1)), reach = width * 0.42 * Math.sin(Math.PI * (0.15 + 0.7 * k / (veins + 1)));
      c.moveTo(at, 0); c.lineTo(at + reach * 0.9, -reach); c.moveTo(at, 0); c.lineTo(at + reach * 0.9, reach);
    }
    c.stroke();
  };
  a.save(); a.translate(x, y); a.rotate(angle);
  outline(a, shape, length, width);
  const grade = a.createLinearGradient(0, 0, length, 0);
  grade.addColorStop(0, hsl(h, s, l - 4)); grade.addColorStop(0.55, hsl(h, s, l)); grade.addColorStop(1, hsl(h - 4, s + 4, l + 4));
  a.fillStyle = grade; a.fill();
  a.strokeStyle = hsl(h, s, l - 9, 0.55); a.lineWidth = Math.max(1, length * 0.012); a.stroke();
  a.clip();
  a.fillStyle = hsl(h - 3, s, l + 7, look.fold ?? 0.42); a.fillRect(-length, -width * 2, length * 3, width * 2);
  a.lineCap = "round";
  a.strokeStyle = hsl(h - 10, s * 0.75, l + rib, 0.85); a.lineWidth = Math.max(1.2, length * 0.02); ribs(a);
  a.strokeStyle = hsl(h - 8, s * 0.8, l + rib * 0.7, 0.5); a.lineWidth = Math.max(0.8, length * 0.009); side(a);
  a.restore();
  d.save(); d.translate(x, y); d.rotate(angle);
  outline(d, shape, length, width);
  // A leaf is a shallow V along its midrib: the two halves catch the light differently.
  const valley = d.createLinearGradient(0, -width * 0.5, 0, width * 0.5);
  valley.addColorStop(0, surf(0.72, look.rough, look.thru)); valley.addColorStop(0.5, surf(0.4, look.rough, look.thru)); valley.addColorStop(1, surf(0.72, look.rough, look.thru));
  d.fillStyle = valley; d.fill(); d.clip();
  d.lineCap = "round";
  d.strokeStyle = surf(0.62, look.rough + 0.15, look.thru * 0.45); d.lineWidth = Math.max(1.2, length * 0.022); ribs(d);
  d.strokeStyle = surf(0.6, look.rough + 0.08, look.thru * 0.7); d.lineWidth = Math.max(0.8, length * 0.01); side(d);
  d.restore();
}

/** A woody stroke on both canvases. */
function stem(ink: Ink, points: Array<[number, number]>, width: number, colour: string, taper = 1) {
  for (const c of [ink.a, ink.d]) {
    c.strokeStyle = c === ink.a ? colour : surf(0.8, 0.85, 0);
    c.lineCap = "round"; c.lineJoin = "round";
    for (let k = 0; k < points.length - 1; k += 1) {
      c.lineWidth = Math.max(1, width * lerp(1, taper, k / Math.max(1, points.length - 2)));
      c.beginPath(); c.moveTo(points[k][0], points[k][1]); c.lineTo(points[k + 1][0], points[k + 1][1]); c.stroke();
    }
  }
}

/** Clips both canvases to a cell (kept a few pixels inside it so mips never bleed into a neighbour). */
function within(ink: Ink, rect: Rect, draw: () => void, margin = 3) {
  for (const c of [ink.a, ink.d]) { c.save(); c.beginPath(); c.rect(rect.x + margin, rect.y + margin, rect.w - margin * 2, rect.h - margin * 2); c.clip(); }
  draw();
  ink.a.restore(); ink.d.restore();
}

type Spray = {
  shape: Shape; twigs: number; perTwig: number; length: [number, number]; aspect: number; splay: number;
  hue: [number, number]; sat: number; light: [number, number]; bark: string; stalk: number;
  look: LeafLook;
  /** Chance a leaf shows its pale underside, and that underside's colour. */
  under?: [number, Hsl];
  /** Chance of a young, yellower leaf. */
  young?: number;
  fan?: number;
};

/** A leafy spray: a twig rising from the foot of the cell, side twigs, and leaves set along them. */
function spray(ink: Ink, rect: Rect, o: Spray) {
  const { random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 5, pad = 9;
  type Leaf = { x: number; y: number; angle: number; length: number; key: number };
  const leaves: Leaf[] = [];
  const twig = (x: number, y: number, angle: number, long: number, width: number, count: number) => {
    const points: Array<[number, number]> = [[x, y]];
    let heading = angle, px = x, py = y;
    const steps = Math.max(3, count);
    for (let k = 0; k < steps; k += 1) {
      heading += (random() - 0.5) * 0.22 + (-Math.PI / 2 - heading) * 0.04;
      px += Math.cos(heading) * long / steps; py += Math.sin(heading) * long / steps;
      px = clamp(px, rect.x + pad * 2, rect.x + rect.w - pad * 2); py = clamp(py, rect.y + pad * 2, rect.y + rect.h - pad);
      points.push([px, py]);
      const t = (k + 1) / steps, size = lerp(o.length[1], o.length[0], t * 0.75 + random() * 0.25);
      const sideways = (k % 2 ? 1 : -1) * o.splay * (0.75 + random() * 0.5);
      leaves.push({ x: px, y: py, angle: heading + sideways, length: size, key: py + random() * 40 });
      if (random() < 0.45) leaves.push({ x: px, y: py, angle: heading - sideways * (0.7 + random() * 0.5), length: size * (0.75 + random() * 0.25), key: py + random() * 40 });
    }
    leaves.push({ x: px, y: py, angle: heading + (random() - 0.5) * 0.3, length: lerp(o.length[0], o.length[1], 0.4), key: py - 30 });
    stem(ink, points, width, o.bark, 0.35);
    return points;
  };
  const rise = rect.h * (o.fan ? 0.5 : 0.66);
  const main = twig(footX, footY, -Math.PI / 2 + (random() - 0.5) * 0.2, rise, rect.w * 0.014 + 2, o.perTwig);
  for (let k = 1; k < o.twigs; k += 1) {
    const from = main[Math.min(main.length - 2, 1 + Math.floor((k - 1) / Math.max(1, o.twigs - 1) * (main.length - 2) * 0.8))];
    const lean = (k % 2 ? 1 : -1) * (0.5 + random() * 0.45 + (o.fan ?? 0));
    twig(from[0], from[1], -Math.PI / 2 + lean, rise * (0.5 + random() * 0.3), rect.w * 0.008 + 1.5, Math.max(3, Math.round(o.perTwig * 0.7)));
  }
  leaves.sort((p, q) => q.key - p.key);
  for (const item of leaves) {
    // Keep every leaf inside the cell: shorten the ones that would poke out.
    let long = item.length;
    const reach = (value: number, low: number, high: number, step: number) => step > 0 ? (high - value) / step : step < 0 ? (low - value) / step : 1e9;
    const dx = Math.cos(item.angle), dy = Math.sin(item.angle), half = long * o.aspect * 0.55 + pad;
    long = Math.min(long, reach(item.x, rect.x + half, rect.x + rect.w - half, dx), reach(item.y, rect.y + half, rect.y + rect.h - pad, dy));
    if (long < o.length[0] * 0.45) continue;
    const underside = o.under && random() < o.under[0], young = !underside && random() < (o.young ?? 0);
    const colour: Hsl = underside ? [o.under![1][0], o.under![1][1], o.under![1][2] + (random() - 0.5) * 8]
      : [lerp(o.hue[0], o.hue[1], random()) - (young ? 14 : 0), o.sat + (random() - 0.5) * 10 + (young ? 8 : 0), lerp(o.light[0], o.light[1], random()) + (young ? 9 : 0)];
    if (o.stalk > 0) stem(ink, [[item.x, item.y], [item.x + dx * o.stalk, item.y + dy * o.stalk]], 1.6, hsl(colour[0] - 20, colour[1] * 0.7, colour[2] + 8));
    leaf(ink, item.x + dx * o.stalk, item.y + dy * o.stalk, item.angle + (random() - 0.5) * 0.25, long, long * o.aspect, o.shape, colour, underside ? { ...o.look, rough: 0.8, rib: 6 } : o.look);
  }
}

/** Scale-leaf spray of a cypress: a dark flame of feathery upright branchlets. */
function paintCypress(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 8, tall = rect.h - 84;
  // Scale-leaved sprigs, each a short shoot with two side shoots, packed into a flame: the dark ones
  // are drawn first, so the pale tips of the outer sprigs lie over the shade inside.
  const lists: Array<Array<[number, number, number, number]>> = [[], [], [], []], rows = 30;
  for (let row = 0; row < rows; row += 1) {
    const t = row / (rows - 1), y = footY - t * tall, half = rect.w * 0.33 * Math.min(1, 0.3 + t * 3.2) * Math.pow(1 - t, 0.55) + 5, count = Math.max(2, Math.round(half / 8));
    for (let k = 0; k < count; k += 1) {
      const u = (k + random()) / count * 2 - 1, x = footX + u * half, lean = u * 0.6 + (random() - 0.5) * 0.45, long = 28 + random() * 26;
      const tone = Math.min(3, Math.floor(random() * 2 + Math.abs(u) * 0.9 + t * 0.9)), ex = x + Math.sin(lean) * long, ey = y - Math.cos(lean) * long;
      lists[tone].push([x, y, ex, ey]);
      for (const way of [-1, 1]) {
        const f = 0.3 + random() * 0.35, sx = x + (ex - x) * f, sy = y + (ey - y) * f, turnBy = lean + way * (0.45 + random() * 0.35), reach = long * (0.4 + random() * 0.25);
        lists[tone].push([sx, sy, sx + Math.sin(turnBy) * reach, sy - Math.cos(turnBy) * reach]);
      }
    }
  }
  lists.forEach((list, index) => {
    for (const c of [a, d]) {
      c.lineCap = "round"; c.lineWidth = 7 - index * 0.7;
      c.strokeStyle = c === a ? hsl(126 - index * 5, 30 + index * 2, 11 + index * 4.6) : surf(0.3 + index * 0.2, 0.74, 0.14 + index * 0.05);
      c.beginPath();
      for (const [x0, y0, x1, y1] of list) { c.moveTo(x0, y0); c.lineTo(x1, y1); }
      c.stroke();
    }
  });
}

/** A spruce bough seen from above: solid, saw-edged branchlets off a woody axis, needles bristling past their edges. */
function paintSpruce(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 6, top = rect.y + 14;
  const needles: Array<Array<[number, number, number, number]>> = [[], [], []], wood: Array<[number, number, number, number, number]> = [];
  const branchlet = (x: number, y: number, angle: number, long: number, depth: number) => {
    const ex = x + Math.cos(angle) * long, ey = y + Math.sin(angle) * long;
    wood.push([x, y, ex, ey, depth ? 3.4 : 2]);
    const count = Math.round(long / 4.2);
    for (let k = 0; k <= count; k += 1) {
      const t = (k + random() * 0.6) / count, px = x + (ex - x) * t, py = y + (ey - y) * t, size = (12 + random() * 7) * (1 - t * 0.3);
      for (const turnBy of [-0.8, 0.8]) {
        const heading = angle + turnBy + (random() - 0.5) * 0.4, nx = px + Math.cos(heading) * size, ny = py + Math.sin(heading) * size;
        if (nx > rect.x + 6 && nx < rect.x + rect.w - 6 && ny > rect.y + 6 && ny < rect.y + rect.h - 4) needles[Math.floor(random() * 3)].push([px, py, nx, ny]);
      }
    }
    if (depth > 0) {
      const twigs = Math.round(long / 30);
      for (let k = 1; k <= twigs; k += 1) {
        const t = k / (twigs + 0.6);
        branchlet(x + (ex - x) * t, y + (ey - y) * t, angle + (k % 2 ? 1 : -1) * (0.5 + random() * 0.4), long * (0.44 - t * 0.2) * (0.75 + random() * 0.5), depth - 1);
      }
    }
  };
  const axis = footY - top, rows = 13;
  branchlet(footX, footY, -Math.PI / 2, axis, 0);
  for (let k = 0; k < rows; k += 1) {
    const t = (k + 0.4) / rows, y = footY - axis * t, reach = rect.w * 0.47 * Math.min(1, 0.35 + t * 2.2) * Math.pow(1 - t, 0.62) * 1.25;
    for (const way of [-1, 1]) branchlet(footX, y + (random() - 0.5) * 14, -Math.PI / 2 + way * (1.02 - t * 0.3 + random() * 0.26), Math.min(reach, rect.w * 0.47) * (0.72 + random() * 0.28), 1);
  }
  // Each branchlet is a solid blade with a saw edge, over a solid heart: seen from any distance the bough is a mass, not lace.
  for (const c of [a, d]) {
    c.fillStyle = c === a ? hsl(138, 30, 11) : surf(0.45, 0.68, 0.08);
    c.beginPath(); c.moveTo(footX, footY);
    for (const way of [-1, 1]) for (let i = 0; i <= 12; i += 1) {
      const t = way < 0 ? i / 12 : 1 - i / 12, half = Math.min(rect.w * 0.47, rect.w * 0.47 * Math.min(1, 0.35 + t * 2.2) * Math.pow(1 - t, 0.62) * 1.25) * (0.58 + (i % 2) * 0.1);
      c.lineTo(footX + way * half, footY - axis * t * 0.97);
    }
    c.closePath(); c.fill();
    for (const [x0, y0, x1, y1, width] of wood) {
      const dx = x1 - x0, dy = y1 - y0, long = Math.hypot(dx, dy) || 1, nx = -dy / long, ny = dx / long, half = width > 3 ? 16 : 12, steps = Math.max(3, Math.round(long / 8));
      const wide = (i: number, odd: boolean) => { const t = i / steps; return half * Math.min(1, t * 5 + 0.3) * (1 - t * 0.72) * ((i % 2 === 1) === odd ? 1 : 0.7); };
      c.beginPath(); c.moveTo(x0, y0);
      for (let i = 1; i <= steps; i += 1) { const t = i / steps, w = wide(i, true); c.lineTo(x0 + dx * t + nx * w, y0 + dy * t + ny * w); }
      for (let i = steps; i >= 1; i -= 1) { const t = i / steps, w = wide(i, false); c.lineTo(x0 + dx * t - nx * w, y0 + dy * t - ny * w); }
      c.closePath(); c.fill();
    }
  }
  needles.forEach((list, index) => {
    // On the colour sheet the needles only tint the blades they lie on.
    a.save(); a.globalCompositeOperation = "source-atop"; a.lineCap = "butt"; a.lineWidth = 2.6;
    a.strokeStyle = hsl(128 + index * 9, 30 + index * 3, 15 + index * 5.5);
    a.beginPath();
    for (const [x0, y0, x1, y1] of list) { a.moveTo(x0, y0); a.lineTo(x1, y1); }
    a.stroke(); a.restore();
    d.lineCap = "butt"; d.lineWidth = 2.6; d.strokeStyle = surf(0.4 + index * 0.2, 0.62, 0.2);
    d.beginPath();
    for (const [x0, y0, x1, y1] of list) { d.moveTo(x0, y0); d.lineTo(x1, y1); }
    d.stroke();
  });
  // One needle in three reaches past the edge.
  a.lineCap = "round"; a.lineWidth = 2.2; a.strokeStyle = hsl(134, 31, 17);
  a.beginPath();
  needles[1].forEach(([x0, y0, x1, y1]) => { a.moveTo(x0, y0); a.lineTo(x1, y1); });
  a.stroke();
  for (const c of [a, d]) {
    c.lineCap = "round"; c.strokeStyle = c === a ? hsl(28, 30, 20) : surf(0.85, 0.85, 0);
    for (const [x0, y0, x1, y1, width] of wood) { c.lineWidth = width; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
  }
}

/** One side of a date-palm frond: the rib along the bottom, leaflets raked towards the tip. */
function paintFrond(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, rib = rect.y + rect.h - 7, x0 = rect.x + 6, x1 = rect.x + rect.w - 6, span = x1 - x0, tall = rect.h - 16;
  for (let x = x0 + 4; x < x1 - 4; x += 8.5 + random() * 2.5) {
    const t = (x - x0) / span;
    const profile = t < 0.3 ? lerp(0.16, 1, smooth(0, 0.3, t)) : t < 0.68 ? 1 - (t - 0.3) * 0.2 : lerp(0.92, 0.42, (t - 0.68) / 0.32);
    const rake = lerp(1.2, 0.62, t) + (random() - 0.5) * 0.16, long = Math.min(tall * profile / Math.sin(rake), (x1 - x) / Math.max(0.05, Math.cos(rake))) * (0.88 + random() * 0.12);
    const tipX = x + Math.cos(rake) * long, tipY = rib - Math.sin(rake) * long, width = lerp(8.5, 5.5, t) * (0.85 + random() * 0.3), light = 30 + random() * 9;
    for (const c of [a, d]) {
      c.beginPath(); c.moveTo(x - width * 0.5, rib + 1); c.quadraticCurveTo(lerp(x, tipX, 0.5) - width * 0.45, lerp(rib, tipY, 0.5), tipX, tipY);
      c.quadraticCurveTo(lerp(x, tipX, 0.5) + width * 0.55, lerp(rib, tipY, 0.5), x + width * 0.5, rib + 1); c.closePath();
      c.fillStyle = c === a ? hsl(84 + random() * 12, 27, light) : surf(0.35 + random() * 0.4, 0.5, 0.5); c.fill();
    }
    a.strokeStyle = hsl(80, 24, light + 12, 0.6); a.lineWidth = 1; a.beginPath(); a.moveTo(x, rib); a.lineTo(tipX, tipY); a.stroke();
  }
  stem(ink, [[x0, rib], [x0 + span * 0.5, rib], [x1, rib]], 9, hsl(62, 30, 34), 0.3);
}

/** A fan-palm leaf: pleated blade fused for half its radius, then split into pointed segments. */
function paintFan(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, cx = rect.x + rect.w / 2, cy = rect.y + rect.h - 64, radius = Math.min(rect.w / 2 - 8, rect.h - 76), segments = 40, sweep = 4.1;
  const at = (angle: number, r: number): [number, number] => [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  for (let k = 0; k < segments; k += 1) {
    const a0 = -Math.PI / 2 - sweep / 2 + k / segments * sweep, a1 = a0 + sweep / segments, mid = (a0 + a1) / 2;
    const edge = Math.abs(k + 0.5 - segments / 2) / (segments / 2), long = radius * (1 - edge * edge * 0.22) * (0.9 + random() * 0.1), fused = long * (0.56 + random() * 0.06), light = 24 + random() * 7 + (k % 2 ? 3 : -2);
    for (const c of [a, d]) {
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(...at(a0 - 0.004, fused)); c.lineTo(...at(mid + (random() - 0.5) * 0.02, long)); c.lineTo(...at(a1 + 0.004, fused)); c.closePath();
      c.fillStyle = c === a ? hsl(98 + random() * 8, 36, light) : surf(k % 2 ? 0.7 : 0.3, 0.48, 0.5); c.fill();
    }
    a.strokeStyle = hsl(92, 30, light + 13, 0.7); a.lineWidth = 1.3; a.beginPath(); a.moveTo(cx, cy); a.lineTo(...at(mid, long * 0.96)); a.stroke();
    d.strokeStyle = surf(0.95, 0.5, 0.3); d.lineWidth = 2; d.beginPath(); d.moveTo(cx, cy); d.lineTo(...at(mid, long * 0.96)); d.stroke();
  }
  stem(ink, [[cx, rect.y + rect.h - 5], [cx, cy + 4]], 12, hsl(70, 32, 30), 0.8);
}

/** A fern frond lying along the cell, pinnae shortening to the tip. */
function paintFern(ink: Ink, rect: Rect) {
  const { random } = ink, x0 = rect.x + 6, x1 = rect.x + rect.w - 8, mid = rect.y + rect.h / 2, reach = rect.h / 2 - 10;
  for (let x = x0 + 14; x < x1 - 6; x += 12.5) {
    const t = (x - x0) / (x1 - x0), long = reach * (t < 0.3 ? lerp(0.35, 1, t / 0.3) : Math.pow(1 - (t - 0.3) / 0.7, 0.8)) + 5;
    for (const way of [-1, 1]) leaf(ink, x, mid, way * (1.25 - t * 0.25) + (random() - 0.5) * 0.12, long, Math.max(6, 15 - t * 6), "lance", [100 + random() * 12, 52, 30 + random() * 8], { rough: 0.6, thru: 0.9, veins: 0, shadow: 0.5 });
  }
  stem(ink, [[x0, mid], [(x0 + x1) / 2, mid], [x1, mid]], 5, hsl(84, 40, 28), 0.3);
}

function paintGrass(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 4;
  for (let k = 0; k < 46; k += 1) {
    const lean = (random() - 0.5) * 1.5, tall = rect.h * (0.38 + random() * 0.56) * (1 - Math.abs(lean) * 0.3), x = footX + (random() - 0.5) * rect.w * 0.3;
    const tipX = clamp(x + Math.sin(lean) * tall * 0.9, rect.x + 8, rect.x + rect.w - 8), tipY = footY - Math.cos(lean) * tall, bowX = x + Math.sin(lean) * tall * 0.2, bowY = footY - tall * 0.6, width = 3.2 + random() * 3;
    const dry = random() < 0.22;
    for (const c of [a, d]) {
      c.beginPath(); c.moveTo(x - width, footY); c.quadraticCurveTo(bowX - width * 0.6, bowY, tipX, tipY); c.quadraticCurveTo(bowX + width * 0.6, bowY, x + width, footY); c.closePath();
      c.fillStyle = c === a ? (dry ? hsl(46 + random() * 10, 42, 44 + random() * 10) : hsl(76 + random() * 24, 44, 26 + random() * 14)) : surf(0.3 + random() * 0.5, 0.6, 0.85); c.fill();
    }
  }
}

function paintWeeds(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 5;
  for (let k = 0; k < 4; k += 1) {
    const x = footX + (k - 1.5) * 9, topX = clamp(x + (random() - 0.5) * 120, rect.x + 22, rect.x + rect.w - 22), topY = rect.y + 22 + random() * 70;
    stem(ink, [[x, footY], [lerp(x, topX, 0.4), lerp(footY, topY, 0.5)], [topX, topY]], 4.2, hsl(88, 34, 30), 0.7);
    for (const c of [a, d]) {
      const seed = k === 3;
      c.fillStyle = c === a ? (seed ? "rgba(176,174,158,0.95)" : hsl(46, 76, 40)) : surf(0.7, 0.8, 0.7);
      c.beginPath(); c.arc(topX, topY, seed ? 13 : 10, 0, TAU); c.fill();
      if (!seed) { c.fillStyle = c === a ? hsl(34, 80, 34) : surf(0.9, 0.8, 0.4); c.beginPath(); c.arc(topX, topY, 4.5, 0, TAU); c.fill(); }
    }
  }
  for (let k = 0; k < 11; k += 1) {
    const angle = -Math.PI / 2 + (k - 5) / 5 * 1.25 + (random() - 0.5) * 0.2;
    leaf(ink, footX, footY - 2, angle, (70 + random() * 55) * (1 - Math.abs(angle + Math.PI / 2) * 0.12), 24 + random() * 9, "lance", [92 + random() * 16, 40, 27 + random() * 9], { rough: 0.62, thru: 0.8, veins: 5, shadow: 0.7, rib: 22 });
  }
}

/** Bare winter twigs: forking shoots with buds, wide enough to fill the cell and thick enough to hold at a distance. */
function paintTwigs(ink: Ink, rect: Rect) {
  const { a, random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 4;
  const shoot = (x: number, y: number, angle: number, long: number, width: number, depth: number) => {
    const bow = angle + (random() - 0.5) * 0.3, ex = clamp(x + Math.cos(bow) * long, rect.x + 8, rect.x + rect.w - 8), ey = clamp(y + Math.sin(bow) * long, rect.y + 8, rect.y + rect.h - 4);
    stem(ink, [[x, y], [lerp(x, ex, 0.5) + (random() - 0.5) * 8, lerp(y, ey, 0.5) + (random() - 0.5) * 8], [ex, ey]], width, hsl(24 + random() * 10, 16, 17 + random() * 9), 0.6);
    if (depth <= 0) { a.fillStyle = hsl(18, 30, 24); a.beginPath(); a.arc(ex, ey, 2.6, 0, TAU); a.fill(); return; }
    const forks = 2 + (random() < 0.45 ? 1 : 0);
    for (let k = 0; k < forks; k += 1) shoot(lerp(x, ex, 0.5 + k * 0.5 / forks), lerp(y, ey, 0.5 + k * 0.5 / forks), angle + ((k % 2 ? 1 : -1) * (0.3 + random() * 0.45)), long * (0.62 + random() * 0.2), Math.max(2.6, width * 0.7), depth - 1);
  };
  for (let k = 0; k < 6; k += 1) { const lean = (k - 2.5) * 0.42 + (random() - 0.5) * 0.2; shoot(footX + lean * 16, footY, -Math.PI / 2 + lean, rect.h * (0.46 + Math.abs(lean) * 0.22), 7, 3); }
}

/** Eight fallen leaves, one to a 128 square. */
function paintLitter(ink: Ink, rect: Rect) {
  const { a, random } = ink;
  const tones: Hsl[] = [[44, 62, 46], [24, 56, 34], [30, 42, 25], [58, 46, 40], [36, 66, 40], [18, 50, 28], [48, 50, 52], [28, 48, 31]];
  for (let k = 0; k < 8; k += 1) {
    const x = rect.x + (k % 4) * 128 + 64, y = rect.y + Math.floor(k / 4) * 128 + 64, angle = random() * TAU, shape: Shape = k % 4 < 2 ? "palmate" : k % 4 === 2 ? "ovate" : "lance";
    const long = shape === "palmate" ? 104 : 108, wide = shape === "palmate" ? 100 : shape === "ovate" ? 52 : 30;
    leaf(ink, x - Math.cos(angle) * long * 0.48, y - Math.sin(angle) * long * 0.48, angle, long, wide, shape, tones[k], { rough: 0.85, thru: 0.4, veins: 5, shadow: 0, fold: 0.25, rib: 10 });
    // Blotches of decay.
    a.save(); a.globalCompositeOperation = "source-atop";
    for (let n = 0; n < 9; n += 1) { a.fillStyle = hsl(20 + random() * 16, 40, 12 + random() * 12, 0.35); a.beginPath(); a.arc(x + (random() - 0.5) * 90, y + (random() - 0.5) * 90, 3 + random() * 9, 0, TAU); a.fill(); }
    a.restore();
  }
}

/** One agave blade, foot at the bottom: glaucous, pale margin with teeth, dark terminal spine. */
function paintAgave(ink: Ink, rect: Rect) {
  const { a, d, random } = ink, cx = rect.x + rect.w / 2, foot = rect.y + rect.h - 4, tip = rect.y + 6, tall = foot - tip;
  const half = (t: number) => rect.w * 0.5 * 0.86 * (t < 0.3 ? lerp(0.78, 1, Math.sin(t / 0.3 * Math.PI / 2)) : Math.pow(1 - (t - 0.3) / 0.7, 0.8) * 0.97 + 0.03);
  const blade = (c: Ctx, inset: number) => {
    c.beginPath();
    for (let k = 0; k <= 24; k += 1) { const t = k / 24; c.lineTo(cx - Math.max(0.5, half(t) - inset), foot - tall * t); }
    for (let k = 24; k >= 0; k -= 1) { const t = k / 24; c.lineTo(cx + Math.max(0.5, half(t) - inset), foot - tall * t); }
    c.closePath();
  };
  blade(a, 0); a.fillStyle = hsl(74, 30, 66); a.fill();
  blade(d, 0); const dish = d.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
  dish.addColorStop(0, surf(0.8, 0.55, 0.12)); dish.addColorStop(0.5, surf(0.3, 0.5, 0.12)); dish.addColorStop(1, surf(0.8, 0.55, 0.12)); d.fillStyle = dish; d.fill();
  blade(a, 5); const body = a.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
  body.addColorStop(0, hsl(160, 20, 37)); body.addColorStop(0.5, hsl(168, 17, 46)); body.addColorStop(1, hsl(156, 21, 35)); a.fillStyle = body; a.fill();
  a.save(); blade(a, 5); a.clip();
  // The print the neighbouring leaves left in the bud, and the powdery bloom.
  for (let k = 0; k < 7; k += 1) { const y = foot - tall * (0.12 + k * 0.1); a.strokeStyle = hsl(170, 16, 54, 0.3); a.lineWidth = 3; a.beginPath(); a.moveTo(rect.x, y); a.quadraticCurveTo(cx, y - 40, rect.x + rect.w, y); a.stroke(); }
  for (let k = 0; k < 160; k += 1) { a.fillStyle = hsl(165, 14, 30 + random() * 30, 0.14); a.beginPath(); a.arc(rect.x + random() * rect.w, rect.y + random() * rect.h, 2 + random() * 7, 0, TAU); a.fill(); }
  a.restore();
  for (let k = 2; k < 22; k += 1) for (const way of [-1, 1]) { const t = k / 24, x = cx + way * half(t), y = foot - tall * t; a.fillStyle = hsl(24, 40, 18); a.beginPath(); a.moveTo(x - way * 3, y + 4); a.lineTo(x + way * 4.5, y - 2); a.lineTo(x - way * 3, y - 5); a.fill(); }
  a.fillStyle = hsl(20, 45, 14); a.beginPath(); a.moveTo(cx - 3.5, tip + 26); a.lineTo(cx, tip - 1); a.lineTo(cx + 3.5, tip + 26); a.fill();
}

/** Geraniums: scalloped leaves with their dark horseshoe on the left cell, heads of florets on the right. */
function paintGeranium(ink: Ink, leaves: Rect, flowers: Rect) {
  const { a, d, random } = ink;
  const footX = leaves.x + leaves.w / 2, footY = leaves.y + leaves.h - 5;
  const spots: Array<[number, number, number]> = [];
  for (let k = 0; k < 15; k += 1) spots.push([leaves.x + 44 + random() * (leaves.w - 88), leaves.y + 46 + random() * (leaves.h - 120), 34 + random() * 14]);
  spots.sort((p, q) => q[1] - p[1]);
  for (const [x, y] of spots) stem(ink, [[footX, footY], [lerp(footX, x, 0.4), lerp(footY, y, 0.3)], [x, y]], 2.4, hsl(96, 36, 32), 0.8);
  for (const [x, y, r] of spots) {
    const angle = Math.atan2(y - footY, x - footX) + (random() - 0.5) * 0.9, colour: Hsl = [106 + random() * 10, 44, 27 + random() * 8];
    const lx = x - Math.cos(angle) * r, ly = y - Math.sin(angle) * r;
    leaf(ink, lx, ly, angle, r * 2, r * 1.9, "round", colour, { rough: 0.66, thru: 0.7, shadow: 1, fold: 0.3, rib: 12 });
    a.save(); a.translate(lx, ly); a.rotate(angle); outline(a, "round", r * 2, r * 1.9); a.clip();
    a.strokeStyle = hsl(60, 34, 14, 0.42); a.lineWidth = r * 0.24; a.beginPath(); a.arc(r, 0, r * 0.52, 0, TAU); a.stroke(); a.restore();
  }
  const fx = flowers.x + flowers.w / 2, fy = flowers.y + flowers.h - 5;
  const heads: Array<[number, number, number]> = [[fx - 52, flowers.y + 150, 54], [fx + 50, flowers.y + 96, 58], [fx - 8, flowers.y + 250, 50], [fx + 58, flowers.y + 300, 44]];
  for (const [x, y] of heads) stem(ink, [[fx, fy], [lerp(fx, x, 0.3), lerp(fy, y, 0.5)], [x, y + 10]], 3, hsl(98, 34, 34), 0.8);
  for (const [x, y, r] of heads) {
    const hue = 352 + random() * 12;
    for (let k = 0; k < 20; k += 1) {
      const angle = random() * TAU, far = Math.sqrt(random()) * r * 0.78, px = x + Math.cos(angle) * far, py = y + Math.sin(angle) * far * 0.85, light = 42 + random() * 12, petal = 10 + random() * 3;
      for (let n = 0; n < 5; n += 1) {
        const turnBy = n / 5 * TAU + angle;
        for (const c of [a, d]) {
          c.fillStyle = c === a ? hsl(hue, 82, light + (n % 2) * 3) : surf(0.4 + n * 0.1, 0.7, 0.9);
          c.beginPath(); c.ellipse(px + Math.cos(turnBy) * petal * 0.7, py + Math.sin(turnBy) * petal * 0.7, petal * 0.72, petal * 0.5, turnBy, 0, TAU); c.fill();
        }
      }
      a.fillStyle = hsl(hue - 8, 70, 24); a.beginPath(); a.arc(px, py, 2.2, 0, TAU); a.fill();
    }
  }
}

/** Bougainvillea: papery bracts in threes over a few plain leaves. */
function paintBracts(ink: Ink, rect: Rect) {
  const { a, random } = ink, footX = rect.x + rect.w / 2, footY = rect.y + rect.h - 5;
  const tip: [number, number] = [footX + (random() - 0.5) * 80, rect.y + 90];
  stem(ink, [[footX, footY], [lerp(footX, tip[0], 0.5) + 30, lerp(footY, tip[1], 0.5)], tip], 5, hsl(30, 26, 26), 0.4);
  for (let k = 0; k < 16; k += 1) {
    const x = rect.x + 70 + random() * (rect.w - 140), y = rect.y + 140 + random() * (rect.h - 230);
    leaf(ink, x, y, random() * TAU, 78 + random() * 26, 44 + random() * 10, "ovate", [104 + random() * 12, 40, 22 + random() * 7], { rough: 0.6, thru: 0.7, veins: 5 });
  }
  for (let k = 0; k < 46; k += 1) {
    const t = random(), x = clamp(lerp(footX, tip[0], t) + (random() - 0.5) * rect.w * 0.8 * Math.sin(Math.PI * clamp(t + 0.15)), rect.x + 60, rect.x + rect.w - 60);
    const y = clamp(lerp(footY - 80, tip[1], t) + (random() - 0.5) * 150, rect.y + 60, rect.y + rect.h - 70);
    const hue = 316 + random() * 16, light = 40 + random() * 14, spin = random() * TAU, long = 38 + random() * 14;
    for (let n = 0; n < 3; n += 1) leaf(ink, x, y, spin + n * TAU / 3 + (random() - 0.5) * 0.3, long, long * 0.78, "ovate", [hue, 70, light + n * 2], { rough: 0.72, thru: 1, veins: 3, shadow: 0.8, fold: 0.3, rib: 8 });
    a.fillStyle = hsl(52, 60, 78); a.beginPath(); a.arc(x, y, 2.6, 0, TAU); a.fill();
  }
}

/** Plain swatches: orange peel, the dark inner mass of a clipped bush, and a lump of settled snow. */
function paintSwatches(ink: Ink) {
  const { a, d, random } = ink, fruit = CELLS.fruit, core = CELLS.core, snow = CELLS.snow;
  for (const c of [a, d]) { c.fillStyle = c === a ? hsl(27, 92, 49) : surf(0.5, 0.42, 0.05); c.fillRect(fruit.x - 4, fruit.y - 4, fruit.w + 8, fruit.h + 8); }
  for (let k = 0; k < 420; k += 1) {
    const x = fruit.x + random() * fruit.w, y = fruit.y + random() * fruit.h;
    a.fillStyle = hsl(22 + random() * 12, 90, 40 + random() * 16, 0.4); a.beginPath(); a.arc(x, y, 1.2 + random() * 1.6, 0, TAU); a.fill();
    d.fillStyle = surf(0.3, 0.5, 0.05); d.beginPath(); d.arc(x, y, 1.6, 0, TAU); d.fill();
  }
  for (const c of [a, d]) { c.fillStyle = c === a ? hsl(112, 34, 13) : surf(0.5, 0.85, 0); c.fillRect(core.x - 4, core.y - 4, core.w + 8, core.h + 8); }
  for (let k = 0; k < 150; k += 1) leaf(ink, core.x + 8 + random() * (core.w - 30), core.y + 10 + random() * (core.h - 20), random() * TAU, 14 + random() * 8, 8, "ovate", [104 + random() * 14, 36, 14 + random() * 10], { rough: 0.7, thru: 0, veins: 0, shadow: 0 });
  for (let k = 0; k < 26; k += 1) {
    const x = snow.x + 30 + random() * (snow.w - 60), y = snow.y + snow.h / 2 + (random() - 0.5) * 34, r = 16 + random() * 22;
    const shade = a.createRadialGradient(x - r * 0.2, y - r * 0.35, r * 0.1, x, y, r);
    shade.addColorStop(0, "rgb(214,219,228)"); shade.addColorStop(1, "rgb(176,188,208)");
    a.fillStyle = shade; a.beginPath(); a.ellipse(x, y, r, r * 0.72, 0, 0, TAU); a.fill();
    const dome = d.createRadialGradient(x, y, 0, x, y, r);
    dome.addColorStop(0, surf(0.9, 0.9, 0.35)); dome.addColorStop(1, surf(0.25, 0.9, 0.35));
    d.fillStyle = dome; d.beginPath(); d.ellipse(x, y, r, r * 0.72, 0, 0, TAU); d.fill();
  }
}

type AtlasPixels = { size: number; colour: Uint8ClampedArray; surface: Uint8ClampedArray; surfaceSize: number };

/** Paints the whole foliage sheet at `size` (2048 on HIGH) and its surface sheet at half that. */
function paintFoliage(size: number, seed: number): AtlasPixels {
  const make = (pixels: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = pixels;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.scale(pixels / ATLAS, pixels / ATLAS);
    return context;
  };
  const a = make(size), d = make(size / 2), ink: Ink = { a, d, random: rng(seed) };
  d.fillStyle = surf(0.5, 0.62, 0.5); d.fillRect(0, 0, ATLAS, ATLAS);
  const cellInk = (name: keyof typeof CELLS, draw: (rect: Rect) => void, index: number) => { ink.random = rng(seed * 31 + index * 977); within(ink, CELLS[name], () => draw(CELLS[name])); };
  const plane: Spray = { shape: "palmate", twigs: 5, perTwig: 8, length: [66, 100], aspect: 0.98, splay: 0.95, hue: [84, 100], sat: 46, light: [27, 35], bark: hsl(34, 22, 24), stalk: 20, look: { rough: 0.58, thru: 0.9 }, young: 0.14, fan: 0.2 };
  const citrus: Spray = { shape: "ovate", twigs: 5, perTwig: 7, length: [66, 104], aspect: 0.46, splay: 0.8, hue: [108, 124], sat: 44, light: [17, 25], bark: hsl(70, 26, 24), stalk: 6, look: { rough: 0.34, thru: 0.5, veins: 6 }, young: 0.12, fan: 0.25 };
  const olive: Spray = { shape: "lance", twigs: 7, perTwig: 9, length: [44, 66], aspect: 0.2, splay: 0.7, hue: [82, 98], sat: 20, light: [29, 37], bark: hsl(40, 12, 34), stalk: 2, look: { rough: 0.55, thru: 0.35, veins: 0 }, under: [0.2, [84, 13, 52]], fan: 0.35 };
  const box: Spray = { shape: "obovate", twigs: 9, perTwig: 10, length: [26, 38], aspect: 0.62, splay: 0.85, hue: [94, 112], sat: 44, light: [19, 27], bark: hsl(50, 20, 24), stalk: 1, look: { rough: 0.4, thru: 0.4, veins: 0 }, young: 0.22, fan: 0.4 };
  const ivy: Spray = { shape: "ivy", twigs: 4, perTwig: 7, length: [70, 104], aspect: 1.0, splay: 1.1, hue: [118, 134], sat: 38, light: [15, 22], bark: hsl(30, 24, 22), stalk: 14, look: { rough: 0.4, thru: 0.4, rib: 26 }, young: 0.1, fan: 0.3 };
  cellInk("citrusA", (rect) => spray(ink, rect, citrus), 3);
  // Sprigs: a twig or three with a dozen leaves each, every cell its own.
  const sprigs = (rects: Rect[], look: Spray, first: number, perTwig: number, twigs = 2) => rects.forEach((rect, k) => {
    ink.random = rng(seed * 31 + (first + k) * 977);
    within(ink, rect, () => spray(ink, rect, { ...look, twigs: twigs + (k % 2), perTwig: perTwig + (k % 3 === 0 ? 1 : 0), fan: (look.fan ?? 0) + (k % 4) * 0.1 }));
  });
  sprigs(SPRIGS.plane, plane, 40, 3);
  sprigs(SPRIGS.citrus, citrus, 50, 4);
  sprigs(SPRIGS.olive, { ...olive, length: [50, 72], aspect: 0.22 }, 60, 8, 4);
  cellInk("box", (rect) => spray(ink, rect, box), 7);
  cellInk("ivy", (rect) => spray(ink, rect, ivy), 8);
  cellInk("bract", paintBracts.bind(null, ink), 9);
  cellInk("cypress", paintCypress.bind(null, ink), 10);
  cellInk("spruce", paintSpruce.bind(null, ink), 11);
  cellInk("fan", paintFan.bind(null, ink), 12);
  cellInk("frond", paintFrond.bind(null, ink), 13);
  cellInk("fern", paintFern.bind(null, ink), 14);
  cellInk("grass", paintGrass.bind(null, ink), 15);
  cellInk("weeds", paintWeeds.bind(null, ink), 16);
  cellInk("twigs", paintTwigs.bind(null, ink), 17);
  cellInk("litter", paintLitter.bind(null, ink), 18);
  cellInk("agave", paintAgave.bind(null, ink), 19);
  ink.random = rng(seed * 31 + 20 * 977);
  within(ink, CELLS.geraniumLeaf, () => undefined);
  for (const c of [a, d]) { c.save(); c.beginPath(); c.rect(CELLS.geraniumLeaf.x + 3, CELLS.geraniumLeaf.y + 3, 506, 506); c.clip(); }
  paintGeranium(ink, CELLS.geraniumLeaf, CELLS.geraniumFlower);
  a.restore(); d.restore();
  ink.random = rng(seed * 31 + 21 * 977);
  paintSwatches(ink);
  return { size, colour: a.getImageData(0, 0, size, size).data, surface: d.getImageData(0, 0, size / 2, size / 2).data, surfaceSize: size / 2 };
}

/**
 * Turns the painted sheet into a texture with its own mip chain. Two things a plain mip chain gets
 * wrong for leaves are fixed here: empty texels are given the colour of the leaves around them (so
 * filtering never drags a dark fringe in), and every level's alpha is rescaled region by region so
 * the share of texels that pass the cut-out stays what it is at full size (otherwise needles and
 * leaflets thin out and vanish with distance).
 */
function foliageTexture(pixels: AtlasPixels, anisotropy: number) {
  const { size } = pixels, blocks = 128, block = size / blocks, regions = 8, each = blocks / regions;
  const colour = new Uint8Array(pixels.colour.buffer, pixels.colour.byteOffset, pixels.colour.length), words = new Uint32Array(colour.buffer, colour.byteOffset, size * size);
  // Mean leaf colour per block, spread into blocks that have none.
  const mean = new Float32Array(blocks * blocks * 4);
  for (let by = 0; by < blocks; by += 1) for (let bx = 0; bx < blocks; bx += 1) {
    let r = 0, g = 0, b = 0, weight = 0;
    for (let y = by * block; y < (by + 1) * block; y += 2) {
      let at = y * size + bx * block;
      for (let x = 0; x < block; x += 2, at += 2) { const word = words[at], alpha = word >>> 24; if (alpha >= 40) { r += (word & 255) * alpha; g += ((word >>> 8) & 255) * alpha; b += ((word >>> 16) & 255) * alpha; weight += alpha; } }
    }
    if (weight > 0) { const to = (by * blocks + bx) * 4; mean[to] = r / weight; mean[to + 1] = g / weight; mean[to + 2] = b / weight; mean[to + 3] = 1; }
  }
  for (let pass = 0; pass < 12; pass += 1) {
    const before = mean.slice();
    for (let y = 0; y < blocks; y += 1) for (let x = 0; x < blocks; x += 1) {
      const to = (y * blocks + x) * 4;
      if (before[to + 3] > 0) continue;
      let r = 0, g = 0, b = 0, found = 0;
      if (x > 0 && before[to - 1] > 0) { r += before[to - 4]; g += before[to - 3]; b += before[to - 2]; found += 1; }
      if (x < blocks - 1 && before[to + 7] > 0) { r += before[to + 4]; g += before[to + 5]; b += before[to + 6]; found += 1; }
      if (y > 0 && before[to - blocks * 4 + 3] > 0) { r += before[to - blocks * 4]; g += before[to - blocks * 4 + 1]; b += before[to - blocks * 4 + 2]; found += 1; }
      if (y < blocks - 1 && before[to + blocks * 4 + 3] > 0) { r += before[to + blocks * 4]; g += before[to + blocks * 4 + 1]; b += before[to + blocks * 4 + 2]; found += 1; }
      if (found) { mean[to] = r / found; mean[to + 1] = g / found; mean[to + 2] = b / found; mean[to + 3] = 1; }
    }
  }
  // Fill the empty texels, and count the coverage of each of the 8 x 8 regions at full size.
  const target = new Float32Array(regions * regions);
  for (let by = 0; by < blocks; by += 1) for (let bx = 0; bx < blocks; bx += 1) {
    const from = (by * blocks + bx) * 4, fill = mean[from + 3] > 0 ? (Math.round(mean[from]) | (Math.round(mean[from + 1]) << 8) | (Math.round(mean[from + 2]) << 16)) : (40 | (62 << 8) | (28 << 16));
    let covered = 0;
    for (let y = by * block; y < (by + 1) * block; y += 1) {
      let at = y * size + bx * block;
      for (let x = 0; x < block; x += 1, at += 1) { const alpha = words[at] >>> 24; if (alpha < 40) words[at] = (fill | (alpha << 24)) >>> 0; else if (alpha >= 128) covered += 1; }
    }
    target[Math.floor(by / each) * regions + Math.floor(bx / each)] += covered;
  }
  for (let k = 0; k < target.length; k += 1) target[k] /= (size / regions) * (size / regions);
  const levels: Array<{ data: Uint8Array; width: number; height: number }> = [{ data: colour, width: size, height: size }];
  let from = colour, width = size;
  const histogram = new Uint32Array(256);
  while (width > 1) {
    const half = width >> 1, to = new Uint8Array(half * half * 4), row = width * 4;
    for (let y = 0; y < half; y += 1) {
      let p = y * 2 * row, out = y * half * 4;
      for (let x = 0; x < half; x += 1, p += 8, out += 4) {
        to[out] = (from[p] + from[p + 4] + from[p + row] + from[p + row + 4] + 2) >> 2;
        to[out + 1] = (from[p + 1] + from[p + 5] + from[p + row + 1] + from[p + row + 5] + 2) >> 2;
        to[out + 2] = (from[p + 2] + from[p + 6] + from[p + row + 2] + from[p + row + 6] + 2) >> 2;
        to[out + 3] = (from[p + 3] + from[p + 7] + from[p + row + 3] + from[p + row + 7] + 2) >> 2;
      }
    }
    const span = half / regions;
    if (span >= 2) {
      for (let ry = 0; ry < regions; ry += 1) for (let rx = 0; rx < regions; rx += 1) {
        const want = target[ry * regions + rx] * span * span;
        if (want < 1) continue;
        histogram.fill(0);
        for (let y = ry * span; y < (ry + 1) * span; y += 1) { let at = (y * half + rx * span) * 4 + 3; for (let x = 0; x < span; x += 1, at += 4) histogram[to[at]] += 1; }
        // The alpha value that leaves the wanted number of texels above it becomes the new cut-off.
        let cut = 255, above = 0;
        while (cut > 1 && above + histogram[cut] < want) { above += histogram[cut]; cut -= 1; }
        const gain = clamp(128 / cut, 1, 3.5);
        if (gain > 1.02) for (let y = ry * span; y < (ry + 1) * span; y += 1) { let at = (y * half + rx * span) * 4 + 3; for (let x = 0; x < span; x += 1, at += 4) to[at] = Math.min(255, to[at] * gain); }
      }
    }
    levels.push({ data: to, width: half, height: half });
    from = to; width = half;
  }
  const texture = drawnOnce(new THREE.DataTexture(colour, size, size, THREE.RGBAFormat, THREE.UnsignedByteType));
  texture.mipmaps = levels as unknown as THREE.DataTexture["mipmaps"];
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Normal (red, green), roughness (blue) and translucency (alpha) from the painted surface sheet. */
function surfaceTexture(source: Uint8ClampedArray, width: number, height: number, strength: number, anisotropy: number, wrap = false) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const up = (y > 0 ? y - 1 : wrap ? height - 1 : 0) * width, down = (y < height - 1 ? y + 1 : wrap ? 0 : y) * width, row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = x > 0 ? x - 1 : wrap ? width - 1 : 0, right = x < width - 1 ? x + 1 : wrap ? 0 : x, at = (row + x) * 4;
      const dx = (source[(row + right) * 4] - source[(row + left) * 4]) * strength, dy = (source[(down + x) * 4] - source[(up + x) * 4]) * strength;
      const scale = 127 / Math.sqrt(dx * dx + dy * dy + 1);
      out[at] = 128 - dx * scale; out[at + 1] = 128 - dy * scale; out[at + 2] = source[at + 1]; out[at + 3] = source[at + 2];
    }
  }
  const texture = drawnOnce(new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.UnsignedByteType));
  texture.generateMipmaps = true;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  if (wrap) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}


// ---- Bark and pots -------------------------------------------------------------------------------
// The bark sheet is four barks side by side, each a column 256 wide and 2048 tall that tiles on
// itself: the texture repeats down the limb in hardware and round it in the shader (see BARK_MAP).
// Columns: 0 plane (mottled, flaking), 1 furrowed, 2 palm (ring scars and fibre), 3 scaly conifer.

const BARK_W = 256, BARK_H = 2048;
const BARK = { plane: 0, furrowed: 1, palm: 2, scaly: 3 };

type Blob = Array<[number, number]>;
const blobShape = (random: Random, rx: number, ry: number, points = 11, rough = 0.34): Blob => {
  const shape: Blob = [];
  for (let k = 0; k < points; k += 1) { const angle = k / points * TAU, r = 1 - rough + random() * rough * 2; shape.push([Math.cos(angle) * rx * r, Math.sin(angle) * ry * r]); }
  return shape;
};
const blobPath = (c: Ctx, shape: Blob, x: number, y: number) => {
  c.beginPath();
  const count = shape.length;
  c.moveTo(x + (shape[count - 1][0] + shape[0][0]) / 2, y + (shape[count - 1][1] + shape[0][1]) / 2);
  for (let k = 0; k < count; k += 1) { const next = shape[(k + 1) % count]; c.quadraticCurveTo(x + shape[k][0], y + shape[k][1], x + (shape[k][0] + next[0]) / 2, y + (shape[k][1] + next[1]) / 2); }
  c.closePath();
};

/** Runs `draw` on both canvases at the spot and at its wrapped copies, so a column tiles on itself. */
function tiled(ink: Ink, column: number, x: number, y: number, reach: number, draw: (c: Ctx, x: number, y: number, colour: boolean) => void, wide = BARK_W, tall = BARK_H) {
  const xs = x < reach ? [0, wide] : x > wide - reach ? [0, -wide] : [0], ys = y < reach ? [0, tall] : y > tall - reach ? [0, -tall] : [0];
  for (const dx of xs) for (const dy of ys) { draw(ink.a, column * wide + x + dx, y + dy, true); draw(ink.d, column * wide + x + dx, y + dy, false); }
}

function paintBark(scale: number, seed: number) {
  const make = () => {
    const canvas = document.createElement("canvas");
    canvas.width = BARK_W * 4 * scale; canvas.height = BARK_H * scale;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.scale(scale, scale);
    return context;
  };
  const a = make(), d = make(), ink: Ink = { a, d, random: rng(seed) };
  const column = (index: number, base: string, height: number, rough: number, draw: (random: Random) => void) => {
    for (const c of [a, d]) { c.save(); c.beginPath(); c.rect(index * BARK_W, 0, BARK_W, BARK_H); c.clip(); c.fillStyle = c === a ? base : surf(height, rough, 0); c.fillRect(index * BARK_W, 0, BARK_W, BARK_H); }
    draw(rng(seed * 13 + index * 101));
    a.restore(); d.restore();
  };
  const rgb = (r: number, g: number, b: number, alpha = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
  /** Short strokes along the grain: the fibre every bark has under its bigger pattern. */
  const fibre = (index: number, random: Random, count: number, long: [number, number], tone: [number, number, number], spread: number, dent = 0.18) => {
    for (let k = 0; k < count; k += 1) {
      const x = random() * BARK_W, y = random() * BARK_H, length = lerp(long[0], long[1], random()), value = (random() - 0.5) * spread, width = 0.8 + random() * 2.2, drift = (random() - 0.5) * 6, lift = random();
      tiled(ink, index, x, y, length, (c, px, py, colour) => {
        c.strokeStyle = colour ? rgb(tone[0] + value, tone[1] + value, tone[2] + value, 0.4) : `rgba(${lift < 0.5 ? 30 : 230},220,0,${dent})`;
        c.lineWidth = width; c.lineCap = "round"; c.beginPath(); c.moveTo(px, py); c.lineTo(px + drift, py + length); c.stroke();
      });
    }
  };

  // 0: plane. Smooth pale bark in creams and olive-greys, shed in irregular flakes; darker old plates still cling on.
  column(BARK.plane, rgb(166, 162, 138), 0.4, 0.6, (random) => {
    const fresh: Array<[number, number, number]> = [[194, 188, 162], [158, 160, 130], [176, 166, 132], [146, 150, 128], [186, 178, 150], [154, 154, 136]];
    for (let k = 0; k < 120; k += 1) {
      const x = random() * BARK_W, y = random() * BARK_H, rx = 12 + random() * 30, ry = rx * (1.2 + random() * 1.5), shape = blobShape(random, rx, ry, 12, 0.4), tone = fresh[Math.floor(random() * fresh.length)], level = 0.2 + random() * 0.16;
      const inner = blobShape(random, rx * 0.55, ry * 0.55, 9, 0.4), shiftX = (random() - 0.5) * rx * 0.5, shiftY = (random() - 0.5) * ry * 0.5, pale = 1.03 + random() * 0.06;
      tiled(ink, BARK.plane, x, y, ry * 1.5, (c, px, py, colour) => {
        blobPath(c, shape, px, py); c.fillStyle = colour ? rgb(tone[0], tone[1], tone[2], 0.86) : surf(level, 0.56, 0); c.fill();
        blobPath(c, inner, px + shiftX, py + shiftY); c.fillStyle = colour ? rgb(tone[0] * pale, tone[1] * pale, tone[2] * pale, 0.7) : surf(level - 0.05, 0.5, 0); c.fill();
      });
    }
    fibre(BARK.plane, random, 700, [10, 60], [160, 156, 134], 22, 0.07);
    for (let k = 0; k < 1400; k += 1) { const x = random() * BARK_W, y = random() * BARK_H, wide = 1 + random() * 2.5; tiled(ink, BARK.plane, x, y, 6, (c, px, py, colour) => { c.fillStyle = colour ? rgb(108, 100, 82, 0.35) : surf(0.3, 0.7, 0); c.fillRect(px, py, wide * 2, wide * 0.8); }); }
    const old: Array<[number, number, number]> = [[140, 130, 108], [128, 122, 106], [150, 138, 114], [132, 124, 102]];
    for (let k = 0; k < 38; k += 1) {
      const x = random() * BARK_W, y = random() * BARK_H, rx = 9 + random() * 22, ry = rx * (1.5 + random() * 1.8), shape = blobShape(random, rx, ry, 10, 0.45), core = blobShape(random, rx * 0.6, ry * 0.6, 8, 0.45), tone = old[Math.floor(random() * old.length)];
      tiled(ink, BARK.plane, x, y, ry * 1.6, (c, px, py, colour) => {
        // A plate about to fall stands off the trunk: a soft shadow under its lower edge, no outline.
        if (colour) { blobPath(c, shape, px + 1, py + 2.5); c.fillStyle = rgb(70, 62, 50, 0.3); c.fill(); }
        // Its edge curls up from the stem: a sloping rim on the height sheet under the plate itself.
        if (!colour) { blobPath(c, shape, px, py); c.strokeStyle = surf(0.56, 0.84, 0); c.lineWidth = 5; c.lineJoin = "round"; c.stroke(); }
        blobPath(c, shape, px, py); c.fillStyle = colour ? rgb(tone[0], tone[1], tone[2], 0.92) : surf(0.74, 0.84, 0); c.fill();
        // The plate is weathered unevenly: a second, smaller patch of another grey inside it.
        if (colour) { blobPath(c, core, px + rx * 0.1, py - ry * 0.12); c.fillStyle = rgb(tone[0] * 0.9, tone[1] * 0.9, tone[2] * 0.92, 0.6); c.fill(); }
      });
    }
    fibre(BARK.plane, random, 320, [6, 26], [138, 130, 110], 22, 0.07);
    for (let k = 0; k < 260; k += 1) { const x = random() * BARK_W, y = random() * BARK_H, wide = 3 + random() * 6; tiled(ink, BARK.plane, x, y, 10, (c, px, py, colour) => { c.fillStyle = colour ? rgb(92, 82, 64, 0.4) : surf(0.56, 0.8, 0); c.fillRect(px, py, wide, 1.4); }); }
  });

  // 1: furrowed. Ridges of grey-brown cork between deep, wandering fissures.
  column(BARK.furrowed, rgb(98, 84, 68), 0.64, 0.86, (random) => {
    fibre(BARK.furrowed, random, 1500, [14, 90], [100, 86, 70], 46);
    for (let k = 0; k < 30; k += 1) {
      const path: Array<[number, number]> = [];
      let x = random() * BARK_W;
      const top = random() * BARK_H, long = 260 + random() * 900, width = 4 + random() * 8;
      for (let y = 0; y <= long; y += 26) { x += (random() - 0.5) * 16; path.push([x, top + y]); }
      for (const dx of [-BARK_W, 0, BARK_W]) for (const dy of [-BARK_H, 0, BARK_H]) for (const c of [a, d]) {
        c.lineCap = "round"; c.lineJoin = "round";
        // A furrow has sloping sides: three passes, wide and faint to narrow and dark.
        for (const [grow, alpha, level] of [[1.9, 0.28, 0.42], [1.1, 0.5, 0.24], [0.45, 0.85, 0.08]]) {
          c.strokeStyle = c === a ? rgb(40, 32, 25, alpha) : surf(level, 0.95, 0); c.lineWidth = width * grow;
          c.beginPath(); path.forEach(([px, py], index) => { const tx = BARK.furrowed * BARK_W + px + dx, ty = py + dy; if (index) c.lineTo(tx, ty); else c.moveTo(tx, ty); }); c.stroke();
        }
        if (c === a) { c.strokeStyle = rgb(132, 116, 96, 0.3); c.lineWidth = 1.5; c.beginPath(); path.forEach(([px, py], index) => { const tx = BARK.furrowed * BARK_W + px + dx + width * 0.75, ty = py + dy; if (index) c.lineTo(tx, ty); else c.moveTo(tx, ty); }); c.stroke(); }
      }
    }
    for (let k = 0; k < 520; k += 1) { const x = random() * BARK_W, y = random() * BARK_H, wide = 5 + random() * 16; tiled(ink, BARK.furrowed, x, y, 22, (c, px, py, colour) => { c.fillStyle = colour ? rgb(40, 32, 25, 0.6) : surf(0.25, 0.9, 0); c.fillRect(px, py, wide, 1.8); }); }
    for (let k = 0; k < 20; k += 1) { const x = random() * BARK_W, y = random() * BARK_H, shape = blobShape(random, 10 + random() * 22, 14 + random() * 30); tiled(ink, BARK.furrowed, x, y, 60, (c, px, py, colour) => { if (!colour) return; blobPath(c, shape, px, py); c.fillStyle = rgb(150, 156, 132, 0.3); c.fill(); }); }
  });

  // 2: palm. A lattice of old leaf bases: each a blunt scale standing proud at its cut upper edge, fibrous, dark in the joints.
  column(BARK.palm, rgb(70, 58, 46), 0.12, 0.92, (random) => {
    const across = 3, wide = BARK_W / across, tall = 64, rows = BARK_H / tall;
    for (let row = 0; row < rows; row += 1) for (let k = 0; k < across; k += 1) {
      const x = (k + (row % 2) * 0.5 + (random() - 0.5) * 0.08) * wide, y = row * tall + tall / 2 + (random() - 0.5) * 8, value = 0.82 + random() * 0.36, warm = random() * 14, half = wide * (0.5 + random() * 0.05), up = tall * (0.92 + random() * 0.12);
      tiled(ink, BARK.palm, x, y, wide, (c, px, py, colour) => {
        // Wide and cut square at the top, narrowing to where it clasps the stem below.
        c.beginPath(); c.moveTo(px - half * 0.86, py - up * 0.55); c.lineTo(px + half * 0.86, py - up * 0.55);
        c.quadraticCurveTo(px + half * 1.02, py + up * 0.1, px, py + up * 0.98); c.quadraticCurveTo(px - half * 1.02, py + up * 0.1, px - half * 0.86, py - up * 0.55); c.closePath();
        const grade = c.createLinearGradient(0, py - up * 0.55, 0, py + up);
        if (colour) { grade.addColorStop(0, rgb((150 + warm) * value, 128 * value, 100 * value)); grade.addColorStop(0.2, rgb((132 + warm) * value, 112 * value, 88 * value)); grade.addColorStop(1, rgb(92 * value, 76 * value, 60 * value)); }
        else { grade.addColorStop(0, surf(0.96, 0.82, 0)); grade.addColorStop(0.18, surf(0.8, 0.86, 0)); grade.addColorStop(1, surf(0.3, 0.9, 0)); }
        c.fillStyle = grade; c.fill();
        c.strokeStyle = colour ? rgb(40, 31, 24, 0.75) : surf(0.06, 0.95, 0); c.lineWidth = 3; c.stroke();
        // The cut end: a pale rim of fibre.
        c.strokeStyle = colour ? rgb(176 * value, 156 * value, 124 * value, 0.7) : surf(1, 0.8, 0); c.lineWidth = 2.5;
        c.beginPath(); c.moveTo(px - half * 0.74, py - up * 0.5); c.lineTo(px + half * 0.74, py - up * 0.5); c.stroke();
      });
    }
    fibre(BARK.palm, random, 2600, [8, 34], [126, 108, 86], 50, 0.1);
  });

  // 3: scaly. Thin red-brown plates with grey bloom, dark in the gaps.
  column(BARK.scaly, rgb(62, 46, 38), 0.2, 0.9, (random) => {
    const plates: Array<[number, number, number]> = [[112, 84, 68], [128, 98, 80], [100, 76, 64], [134, 120, 110], [118, 92, 74]];
    for (let k = 0; k < 520; k += 1) {
      const x = random() * BARK_W, y = random() * BARK_H, rx = 9 + random() * 13, ry = rx * (1.3 + random() * 1.2), shape = blobShape(random, rx, ry, 8, 0.3), tone = plates[Math.floor(random() * plates.length)], level = 0.6 + random() * 0.3, value = 0.85 + random() * 0.3;
      tiled(ink, BARK.scaly, x, y, ry * 1.4, (c, px, py, colour) => {
        blobPath(c, shape, px, py); c.fillStyle = colour ? rgb(tone[0] * value, tone[1] * value, tone[2] * value) : surf(level, 0.8, 0); c.fill();
        if (colour) { c.strokeStyle = rgb(44, 33, 26, 0.4); c.lineWidth = 1.2; c.stroke(); }
      });
    }
    fibre(BARK.scaly, random, 500, [6, 26], [110, 86, 72], 40);
  });

  const width = BARK_W * 4 * scale, height = BARK_H * scale;
  return { colour: a.getImageData(0, 0, width, height).data, surface: d.getImageData(0, 0, width, height).data, width, height };
}

// The pots sheet, 1024 square. Bands that run the full width wrap round a pot in hardware.
const POTS = 1024;
const BAND = {
  clay: { x: 0, y: 4, w: 1024, h: 248 }, soil: { x: 0, y: 260, w: 1024, h: 248 }, stone: { x: 0, y: 516, w: 1024, h: 120 }, wood: { x: 0, y: 644, w: 1024, h: 120 },
  grate: { x: 2, y: 770, w: 252, h: 252 }, zinc: { x: 262, y: 772, w: 756, h: 248 },
};

function paintPots(scale: number, seed: number) {
  const make = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = POTS * scale;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.scale(scale, scale);
    return context;
  };
  const a = make(), d = make(), random = rng(seed), ink: Ink = { a, d, random };
  const rgb = (r: number, g: number, b: number, alpha = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
  const band = (y0: number, y1: number, base: string, height: number, rough: number) => { a.fillStyle = base; a.fillRect(0, y0, POTS, y1 - y0); d.fillStyle = surf(height, rough, 0); d.fillRect(0, y0, POTS, y1 - y0); };
  /** A soft cloud of colour, repeated across the seam. */
  const cloud = (x: number, y: number, r: number, colour: string) => { for (const dx of x < r ? [0, POTS] : x > POTS - r ? [0, -POTS] : [0]) { const fade = a.createRadialGradient(x + dx, y, 0, x + dx, y, r); fade.addColorStop(0, colour); fade.addColorStop(1, colour.replace(/[\d.]+\)$/, "0)")); a.fillStyle = fade; a.fillRect(x + dx - r, y - r, r * 2, r * 2); } };
  const clip = (y0: number, y1: number, x0 = 0, x1 = POTS) => { for (const c of [a, d]) { c.save(); c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip(); } };
  const unclip = () => { a.restore(); d.restore(); };

  // Fired clay: firing clouds, throwing rings, lime bloom under the rim, damp and algae at the foot.
  band(0, 256, rgb(184, 106, 66), 0.5, 0.8); clip(0, 256);
  for (let k = 0; k < 60; k += 1) cloud(random() * POTS, random() * 256, 40 + random() * 90, random() < 0.5 ? rgb(214, 136, 88, 0.3) : rgb(140, 72, 44, 0.3));
  for (let y = 3; y < 256; y += 5 + random() * 6) { a.fillStyle = rgb(120, 60, 36, 0.1 + random() * 0.1); a.fillRect(0, y, POTS, 1.5); d.fillStyle = surf(0.38, 0.8, 0); d.fillRect(0, y, POTS, 2); d.fillStyle = surf(0.6, 0.8, 0); d.fillRect(0, y + 2, POTS, 1.5); }
  for (let k = 0; k < 46; k += 1) { const x = random() * POTS, y = 18 + random() * 60, r = 18 + random() * 50; cloud(x, y, r, rgb(232, 222, 206, 0.34)); a.fillStyle = rgb(230, 220, 204, 0.1); a.fillRect(x - r * 0.3, y, r * 0.6, 60 + random() * 90); }
  const damp = a.createLinearGradient(0, 176, 0, 256); damp.addColorStop(0, rgb(70, 44, 30, 0)); damp.addColorStop(1, rgb(58, 40, 28, 0.7)); a.fillStyle = damp; a.fillRect(0, 176, POTS, 80);
  for (let k = 0; k < 40; k += 1) cloud(random() * POTS, 226 + random() * 30, 14 + random() * 30, rgb(70, 92, 48, 0.4));
  for (let k = 0; k < 900; k += 1) { const x = random() * POTS, y = random() * 256, r = 0.8 + random() * 1.8; a.fillStyle = random() < 0.5 ? rgb(110, 58, 36, 0.5) : rgb(226, 170, 130, 0.45); a.beginPath(); a.arc(x, y, r, 0, TAU); a.fill(); d.fillStyle = surf(0.25 + random() * 0.5, 0.85, 0); d.beginPath(); d.arc(x, y, r + 0.5, 0, TAU); d.fill(); }
  unclip();

  // Soil and mulch, mapped polar on pot tops and pits (crumbs are squashed to allow for the stretch).
  band(256, 512, rgb(44, 34, 26), 0.4, 0.95); clip(256, 512);
  for (let k = 0; k < 3600; k += 1) {
    const x = random() * POTS, y = 256 + random() * 256, rx = 2 + random() * 6, value = 24 + random() * 46;
    for (const dx of x < 8 ? [0, POTS] : x > POTS - 8 ? [0, -POTS] : [0]) for (const c of [a, d]) { c.fillStyle = c === a ? rgb(value * 1.12, value * 0.86, value * 0.64) : surf(0.2 + random() * 0.7, 0.95, 0); c.beginPath(); c.ellipse(x + dx, y, rx, rx * 0.5, random() * 3, 0, TAU); c.fill(); }
  }
  for (let k = 0; k < 220; k += 1) {
    const x = random() * POTS, y = 260 + random() * 248, long = 8 + random() * 18, chip = random() < 0.7, turnBy = random() * 3;
    for (const c of [a, d]) { c.save(); c.translate(x, y); c.rotate(turnBy); c.fillStyle = c === a ? (chip ? rgb(92 + random() * 30, 60 + random() * 16, 40) : rgb(120 + random() * 40, 116 + random() * 30, 108)) : surf(0.8, 0.85, 0); c.fillRect(-long / 2, -2, long, chip ? 4 : 5); c.restore(); }
  }
  unclip();

  // Stone kerb: pale, pitted, stained dark and green where water sits.
  band(512, 640, rgb(178, 170, 152), 0.55, 0.82); clip(512, 640);
  for (let k = 0; k < 70; k += 1) cloud(random() * POTS, 512 + random() * 128, 20 + random() * 60, random() < 0.5 ? rgb(206, 198, 180, 0.3) : rgb(140, 134, 120, 0.3));
  for (let k = 0; k < 900; k += 1) { const x = random() * POTS, y = 512 + random() * 128, r = 0.7 + random() * 2.2; a.fillStyle = rgb(96, 90, 78, 0.55); a.beginPath(); a.arc(x, y, r, 0, TAU); a.fill(); d.fillStyle = surf(0.15, 0.9, 0); d.beginPath(); d.arc(x, y, r + 0.6, 0, TAU); d.fill(); }
  const stain = a.createLinearGradient(0, 590, 0, 640); stain.addColorStop(0, rgb(60, 66, 44, 0)); stain.addColorStop(1, rgb(54, 60, 40, 0.6)); a.fillStyle = stain; a.fillRect(0, 590, POTS, 50);
  unclip();

  // Weathered boards for window boxes: three planks, grain, nail heads.
  band(640, 768, rgb(124, 104, 82), 0.55, 0.8); clip(640, 768);
  for (let k = 0; k < 900; k += 1) { const x = random() * POTS, y = 640 + random() * 128, long = 30 + random() * 160, value = (random() - 0.5) * 50; a.fillStyle = rgb(124 + value, 104 + value, 82 + value, 0.4); a.fillRect(x, y, long, 1 + random() * 1.4); d.fillStyle = `rgba(${random() < 0.5 ? 60 : 200},200,0,0.2)`; d.fillRect(x, y, long, 1.6); }
  for (const y of [640 + 42, 640 + 84]) { a.fillStyle = rgb(30, 24, 18); a.fillRect(0, y - 1.5, POTS, 3); d.fillStyle = surf(0.05, 0.9, 0); d.fillRect(0, y - 2, POTS, 4); }
  unclip();

  // Cast-iron tree grate, one quarter: the trunk's hole is at the top left corner.
  const g = BAND.grate; clip(768, 1024, 0, 258);
  a.fillStyle = rgb(48, 46, 44); a.fillRect(0, 768, 258, 256); d.fillStyle = surf(0.72, 0.55, 0); d.fillRect(0, 768, 258, 256);
  for (let k = 0; k < 500; k += 1) { a.fillStyle = random() < 0.6 ? rgb(96, 58, 36, 0.3) : rgb(20, 20, 20, 0.3); a.beginPath(); a.arc(random() * 258, 768 + random() * 256, 1 + random() * 4, 0, TAU); a.fill(); }
  for (let r = 104; r < 360; r += 30) {
    const count = Math.round(r / 13);
    for (let k = 0; k < count; k += 1) {
      const a0 = (k + 0.18) / count * Math.PI / 2, a1 = (k + 0.82) / count * Math.PI / 2;
      for (const c of [a, d]) { c.strokeStyle = c === a ? rgb(6, 6, 6) : surf(0, 0.95, 0); c.lineWidth = 12; c.lineCap = "butt"; c.beginPath(); c.arc(g.x - 2, g.y - 2, r, a0, a1); c.stroke(); }
    }
  }
  for (const c of [a, d]) {
    c.fillStyle = c === a ? rgb(54, 52, 50) : surf(0.9, 0.5, 0);
    c.fillRect(238, 768, 20, 256); c.fillRect(0, 1004, 258, 20);
    c.beginPath(); c.arc(g.x - 2, g.y - 2, 86, 0, Math.PI / 2); c.lineTo(g.x - 2, g.y - 2); c.fill();
  }
  unclip();

  // Zinc: dull grey with spangle and drip stains.
  clip(768, 1024, 258, POTS);
  a.fillStyle = rgb(128, 132, 134); a.fillRect(258, 768, 766, 256); d.fillStyle = surf(0.5, 0.48, 0); d.fillRect(258, 768, 766, 256);
  for (let k = 0; k < 260; k += 1) { const x = 258 + random() * 766, y = 768 + random() * 256, shape = blobShape(random, 8 + random() * 16, 8 + random() * 16, 7, 0.4), light = random() < 0.5; blobPath(a, shape, x, y); a.fillStyle = light ? rgb(168, 172, 174, 0.3) : rgb(96, 100, 104, 0.3); a.fill(); blobPath(d, shape, x, y); d.fillStyle = surf(0.5, light ? 0.36 : 0.6, 0); d.fill(); }
  for (let k = 0; k < 40; k += 1) { const x = 258 + random() * 766; a.fillStyle = rgb(210, 212, 208, 0.16); a.fillRect(x, 768 + random() * 60, 2 + random() * 5, 80 + random() * 170); }
  unclip();
  void ink;
  const size = POTS * scale;
  return { colour: a.getImageData(0, 0, size, size).data, surface: d.getImageData(0, 0, size, size).data, width: size, height: size };
}

/** Colour texture with roughness in its alpha, and a normal map, from a painted opaque sheet. */
function sheetTextures(sheet: { colour: Uint8ClampedArray; surface: Uint8ClampedArray; width: number; height: number }, strength: number, anisotropy: number, repeatT: boolean, grain: number) {
  const { colour, surface, width, height } = sheet;
  // Grain: paint is flat between its strokes, and nothing that grows or weathers is. A hash per texel
  // and one per 4 x 4 block move the value and the height a little.
  for (let y = 0, at = 0; y < height; y += 1) for (let x = 0; x < width; x += 1, at += 4) {
    let fine = Math.imul(x + y * 7919, 668265263); fine = (fine ^ (fine >>> 13)) & 255;
    let coarse = Math.imul((x >> 2) + (y >> 2) * 104729, 374761393); coarse = (coarse ^ (coarse >>> 15)) & 255;
    const by = 1 + ((fine - 127.5) * 0.55 + (coarse - 127.5) * 0.45) * grain / 127.5;
    colour[at] *= by; colour[at + 1] *= by; colour[at + 2] *= by;
    surface[at] += (fine - 127.5) * grain * 1.6;
    colour[at + 3] = surface[at + 1];
  }
  const map = drawnOnce(new THREE.DataTexture(colour, width, height, THREE.RGBAFormat, THREE.UnsignedByteType));
  map.colorSpace = THREE.SRGBColorSpace;
  map.generateMipmaps = true; map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter;
  map.wrapS = THREE.RepeatWrapping; map.wrapT = repeatT ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  map.anisotropy = anisotropy; map.needsUpdate = true;
  const normal = surfaceTexture(surface, width, height, strength, anisotropy, true);
  if (!repeatT) normal.wrapT = THREE.ClampToEdgeWrapping;
  return { map, normal };
}


// ---- Shaders -------------------------------------------------------------------------------------
// The three materials are MeshStandardMaterials with the same vertex patch (per-instance variation
// and the wind) and small fragment patches: bark tiles its column, leaves shade as a volume and let
// light through, and all three take snow on faces that look up.

const VERTEX_PARS = /* glsl */ `
attribute vec4 treeWind;
attribute vec4 treeVary;
varying vec4 vTreeVary;
varying float vTreeRandom;
`;

/** Fruit, flowers and snow loads are single meshes with the leaves: the ones not wanted fold to a point. */
const VERTEX_HIDE = /* glsl */ `
if ( color.a < 0.9 ) {
  float treePick = fract( treeWind.z * 16.0 );
  if ( color.a > 0.6 ) { if ( treePick > treeVary.w ) transformed *= 0.0; }
  else if ( treePick * 0.5 + 0.22 > treeVary.z ) transformed *= 0.0;
}
`;

const VERTEX_BEGIN = /* glsl */ `
vTreeVary = treeVary;
vTreeRandom = fract( treeWind.z * 16.0 );
`;

/**
 * Replaces project_vertex. The wind is applied in world space after the instance transform, so a
 * gust front crosses a row of trees one by one. Three motions add up: the whole plant leans from its
 * foot (weight wind.x, grown with height squared), each limb sways and bobs with its own phase
 * (wind.y), and leaves rock along their normal (wind.w, quick for small weights, slow for fronds).
 */
const VERTEX_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 treeWorld = modelMatrix * mvPosition;
float treeCalm = length( windVector );
if ( treeCalm > 0.0001 ) {
  #ifdef USE_INSTANCING
    vec3 treeRoot = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    float treeSize = length( instanceMatrix[ 1 ].xyz );
    vec3 treeFace = normalize( mat3( modelMatrix ) * ( mat3( instanceMatrix ) * objectNormal ) );
  #else
    vec3 treeRoot = modelMatrix[ 3 ].xyz;
    float treeSize = 1.0;
    vec3 treeFace = normalize( mat3( modelMatrix ) * objectNormal );
  #endif
  vec2 treeDir = windVector / treeCalm;
  vec2 treeSide = vec2( - treeDir.y, treeDir.x );
  float treeTurn = treeVary.x * 6.2832;
  float treeLimb = floor( treeWind.z * 16.0 ) * 0.3927 + treeTurn;
  float treeGust = windAt( treeRoot.xz );
  float treeHere = windAt( treeWorld.xz );
  treeWorld.xz += ( treeDir * ( 0.8 + 0.2 * sin( windTime * 1.1 + treeTurn ) ) + treeSide * ( 0.3 * sin( windTime * 0.83 + treeTurn * 1.7 ) ) ) * ( treeGust * treeWind.x * treeSize );
  float treeSway = treeWind.y * treeSize * treeHere;
  treeWorld.xz += treeDir * ( treeSway * ( 0.55 + 0.45 * sin( windTime * 1.9 + treeLimb ) ) ) + treeSide * ( treeSway * 0.4 * sin( windTime * 2.6 + treeLimb * 1.3 ) );
  treeWorld.y += treeSway * ( 0.35 * sin( windTime * 2.3 + treeLimb * 0.7 ) - 0.2 );
  float treeRate = mix( 10.0, 2.6, clamp( abs( treeWind.w ) * 8.0, 0.0, 1.0 ) );
  float treeBeat = sin( windTime * treeRate + vTreeRandom * 37.0 + treeLimb ) + 0.5 * sin( windTime * treeRate * 1.7 + vTreeRandom * 61.0 );
  treeWorld.xyz += treeFace * ( treeWind.w * treeSize * treeBeat * ( treeHere + 0.25 * treeCalm ) );
}
mvPosition = viewMatrix * treeWorld;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec3 treeSun;
uniform float treeDepth;
varying vec4 vTreeVary;
varying float vTreeRandom;
float treeThru = 0.0;
float treeShade = 1.0;
vec3 treeFace = vec3( 0.0, 0.0, 1.0 );
`;

/** Snow lies on whatever faces the sky: the test uses the true face, so the underside of a bough stays green. */
const FRAGMENT_SNOW = /* glsl */ `
if ( vTreeVary.z > 0.003 ) {
  vec3 treeFlat = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
  float treeUp = dot( treeFlat, viewMatrix[ 1 ].xyz ) * 0.5 + 0.5;
  float treeLie = smoothstep( 0.82 - vTreeVary.z * 0.34, 1.04 - vTreeVary.z * 0.32, treeUp + ( diffuseColor.g - 0.15 ) * 0.4 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.6, 0.64, 0.7 ), treeLie );
  roughnessFactor = mix( roughnessFactor, 0.82, treeLie );
  normal = normalize( mix( normal, viewMatrix[ 1 ].xyz, treeLie * 0.5 ) );
  treeThru *= 1.0 - treeLie * 0.7;
}
`;

/** Tangent-space normal from a surface sheet (z rebuilt: blue and alpha carry other things). */
const FRAGMENT_NORMAL = /* glsl */ `
{
  vec2 treeBump = ( treeSurface.xy * 2.0 - 1.0 ) * normalScale;
  normal = normalize( tbn[ 0 ] * treeBump.x + tbn[ 1 ] * treeBump.y + normal * sqrt( max( 0.05, 1.0 - dot( treeBump, treeBump ) ) ) );
}
`;

/**
 * Leaves. On top of the standard light: a wrap term so the crown's terminator is soft, and light
 * coming through the blade. A blade lit on the side turned away from the eye shows that light
 * through itself (its own face decides, not the crown's bent normal), most of all looking towards
 * the sun; all scaled by the sheet's translucency. Shadows still apply: they are in
 * directLight.color by then.
 */
const FRAGMENT_LEAF_LIGHT = /* glsl */ `
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float treeNl = dot( geometryNormal, directLight.direction );
  float treeWrap = saturate( ( treeNl + 0.6 ) / 1.6 ) - saturate( treeNl );
  float treeToSun = saturate( dot( geometryViewDir, - directLight.direction ) );
  float treeGlow = treeToSun * treeToSun * treeToSun * ( 0.45 + 0.55 * saturate( 0.4 - treeNl ) );
  float treeBack = saturate( - dot( treeFace, directLight.direction ) );
  vec3 treeTint = material.diffuseContribution * vec3( 1.5, 1.45, 0.42 );
  reflectedLight.directDiffuse += directLight.color * treeTint * ( ( treeWrap * 0.7 + treeGlow * 1.0 + treeBack * ( 0.7 + 0.5 * treeToSun ) ) * treeThru * RECIPROCAL_PI );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`;

type TreeMaterialKind = "foliage" | "bark" | "pot";

function patchTreeMaterial(material: THREE.MeshStandardMaterial, kind: TreeMaterialKind, wind: Wind, sun: { value: THREE.Vector3 }, depth: { value: number }) {
  material.customProgramCacheKey = () => `tree-${kind}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.treeSun = sun;
    shader.uniforms.treeDepth = depth;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_BEGIN}${kind === "foliage" ? VERTEX_HIDE : ""}`)
      .replace("#include <project_vertex>", VERTEX_PROJECT);
    applyWind(shader, wind);
    let fragment = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace("#include <color_fragment>", "diffuseColor.rgb *= vColor.rgb;")
      .replace("#include <normal_fragment_maps>", FRAGMENT_NORMAL)
      .replace("#include <lights_physical_fragment>", `${FRAGMENT_SNOW}\n#include <lights_physical_fragment>`);
    if (kind === "foliage") {
      fragment = fragment
        .replace("#include <color_fragment>", "")
        .replace("diffuseColor.rgb *= vColor.rgb;", /* glsl */ `
          diffuseColor.rgb *= vColor.rgb;
          treeShade = clamp( dot( vColor.rgb, vec3( 0.42 ) ), 0.0, 1.0 );
          if ( vColor.a > 0.9 ) {
            float treeLuma = dot( diffuseColor.rgb, vec3( 0.3, 0.55, 0.15 ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, treeLuma * vec3( 2.2, 1.45, 0.5 ), clamp( vTreeVary.y * ( 0.45 + 0.8 * vTreeRandom ), 0.0, 1.0 ) );
          }`)
        .replace("#include <roughnessmap_fragment>", /* glsl */ `
          vec4 treeSurface = texture2D( normalMap, vNormalMapUv );
          float roughnessFactor = roughness * treeSurface.b;
          treeThru = treeSurface.a;`)
        // Both faces of a card shade with the crown's bent normal: undo the back-face flip.
        .replace("#include <normal_fragment_begin>", /* glsl */ `#include <normal_fragment_begin>
          treeFace = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
          #ifdef DOUBLE_SIDED
            normal *= faceDirection;
          #endif`)
        .replace("#include <lights_physical_pars_fragment>", `#include <lights_physical_pars_fragment>\n${FRAGMENT_LEAF_LIGHT}`)
        .replace("#include <lights_physical_fragment>", /* glsl */ `#include <lights_physical_fragment>
          {
            // No mirror-like glints off leaves seen from behind their shading normal, nor from deep in the crown.
            float treeFacing = smoothstep( - 0.1, 0.35, dot( normal, normalize( vViewPosition ) ) ) * treeShade * 0.6;
            material.specularColor *= treeFacing; material.specularColorBlended *= treeFacing; material.specularF90 *= treeFacing;
          }`)
        .replace("#include <aomap_fragment>", /* glsl */ `#include <aomap_fragment>
          {
            // Sky light is a little stronger from the sun's side, and some of it comes through the leaf from behind.
            vec3 treeSunView = normalize( ( viewMatrix * vec4( treeSun, 0.0 ) ).xyz );
            reflectedLight.indirectDiffuse *= 1.0 + 0.3 * dot( normal, treeSunView );
            #ifdef USE_ENVMAP
              reflectedLight.indirectDiffuse += material.diffuseContribution * vec3( 1.5, 1.45, 0.42 ) * getIBLIrradiance( - treeFace ) * ( treeThru * 0.5 * RECIPROCAL_PI );
            #endif
            // Sun that has come through a thin cover of leaves: the shadow map is asked again with the
            // surface moved towards the light, so a leaf under 0.3 m of crown glows and one under 3 m does not.
            #if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF ) && NUM_DIR_LIGHT_SHADOWS > 0 && ! defined( USE_REVERSED_DEPTH_BUFFER )
              if ( treeDepth > 0.0 ) {
                vec3 treeCoord = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
                if ( treeCoord.x > 0.0 && treeCoord.x < 1.0 && treeCoord.y > 0.0 && treeCoord.y < 1.0 && treeCoord.z < 1.0 ) {
                  float treeLit = texture( directionalShadowMap[ 0 ], vec3( treeCoord.xy, treeCoord.z + directionalLightShadows[ 0 ].shadowBias ) );
                  float treePass = 0.4 * texture( directionalShadowMap[ 0 ], vec3( treeCoord.xy, treeCoord.z - 0.3 * treeDepth ) )
                    + 0.28 * texture( directionalShadowMap[ 0 ], vec3( treeCoord.xy, treeCoord.z - 0.8 * treeDepth ) )
                    + 0.2 * texture( directionalShadowMap[ 0 ], vec3( treeCoord.xy, treeCoord.z - 1.6 * treeDepth ) )
                    + 0.12 * texture( directionalShadowMap[ 0 ], vec3( treeCoord.xy, treeCoord.z - 2.8 * treeDepth ) );
                  treePass = max( treePass - treeLit, 0.0 );
                  float treeLook = saturate( dot( geometryViewDir, - directionalLights[ 0 ].direction ) );
                  reflectedLight.directDiffuse += directionalLights[ 0 ].color * material.diffuseContribution * vec3( 1.5, 1.45, 0.42 ) * ( treePass * treeThru * ( 0.34 + 0.5 * treeLook * treeLook ) * RECIPROCAL_PI );
                }
              }
            #endif
          }`);
    } else {
      const sample = kind === "bark" ? /* glsl */ `
          // Bark: the column of the sheet named by the vertex tag, wrapped by hand with its own gradients.
          float treeBark = floor( vColor.a * 4.0 + 0.25 );
          vec2 treeUv = vec2( ( treeBark + clamp( fract( vMapUv.x ), 0.008, 0.992 ) ) * 0.25, vMapUv.y );
          vec2 treeDx = dFdx( vMapUv ) * vec2( 0.25, 1.0 ), treeDy = dFdy( vMapUv ) * vec2( 0.25, 1.0 );
          vec4 treeTexel = textureGrad( map, treeUv, treeDx, treeDy );
          vec4 treeSurface = textureGrad( normalMap, treeUv, treeDx, treeDy );` : /* glsl */ `
          vec4 treeTexel = texture2D( map, vMapUv );
          vec4 treeSurface = texture2D( normalMap, vMapUv );`;
      fragment = fragment
        .replace("#include <map_fragment>", `${sample}\n diffuseColor.rgb *= treeTexel.rgb;`)
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness * treeTexel.a;");
    }
    shader.fragmentShader = fragment;
  };
}

/** Depth materials for leaf shadows: the map and cut-off come from the leaf material; this only hides what the instance hides. */
function patchTreeDepth<T extends THREE.Material>(material: T) {
  material.customProgramCacheKey = () => "tree-depth";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 color;\nattribute vec4 treeWind;\nattribute vec4 treeVary;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_HIDE}`);
  };
  return material;
}


// ---- Growing a tree ------------------------------------------------------------------------------

/** What a detail level may spend. */
type Lod = {
  /** 2 hero, 1 mid, 0 far. */
  rank: number;
  /** Limbs thinner than this (metres) are not meshed; their leaves still are. */
  cut: number;
  /** Share of the leaf cards kept, and how much the kept ones grow to hold the crown's density. */
  keep: number;
  grow: number;
  grid: number;
  /** Multiplies the number of sides of a limb. */
  round: number;
  /** False on PERFORMANCE, where every budget is halved. */
  fine: boolean;
};

const lodOf = (detail: TreeDetail, high: boolean): Lod =>
  detail === "hero" ? (high ? { rank: 2, cut: 0.012, keep: 1, grow: 1, grid: 1, round: 1, fine: true } : { rank: 2, cut: 0.024, keep: 0.5, grow: 1.36, grid: 1, round: 0.72, fine: false })
    : detail === "mid" ? (high ? { rank: 1, cut: 0.03, keep: 0.4, grow: 1.5, grid: 1, round: 0.62, fine: true } : { rank: 1, cut: 0.05, keep: 0.21, grow: 2, grid: 1, round: 0.5, fine: false })
      : (high ? { rank: 0, cut: 0.09, keep: 0.15, grow: 2.5, grid: 0, round: 0.42, fine: true } : { rank: 0, cut: 0.14, keep: 0.08, grow: 3.2, grid: 0, round: 0.36, fine: false });

const sidesFor = (radius: number, lod: Lod) => Math.max(3, Math.round((radius < 0.014 ? 3 : radius < 0.03 ? 4 : radius < 0.06 ? 5 : radius < 0.11 ? 7 : radius < 0.18 ? 10 : radius < 0.26 ? 13 : 16) * lod.round));

/** Drops points from a path for the cheaper detail levels, always keeping the ends (and the first `head` points). */
function thin(path: Path, step: number, head = 0): Path {
  if (step <= 1 || path.pts.length <= 3) return path;
  const keep: number[] = [];
  for (let i = 0; i < path.pts.length; i += 1) if (i <= head || i === path.pts.length - 1 || (i - head) % step === 0) keep.push(i);
  return { pts: keep.map((i) => path.pts[i]), rad: keep.map((i) => path.rad[i]), bend: keep.map((i) => path.bend[i]), sway: keep.map((i) => path.sway[i]), phase: path.phase };
}

type LimbSpec = {
  count: [number, number];
  /** Where along the parent the children leave it. */
  span: [number, number];
  /** Angle away from the parent's direction. */
  angle: [number, number];
  /** Length as a share of the parent's. */
  length: [number, number];
  /** Pull towards the sky per segment (negative droops). */
  up: number;
  gnarl: number;
  segments: number;
  /** Length multiplier by position along the parent: shapes the crown. */
  profile?: (t: number) => number;
  /** 0..1 flattens the heading (spreading crowns). */
  flat?: number;
  /** Radians the limb turns towards the sky over its first and over its second half (negative: out and down). */
  curve?: [number, number];
  /** How many of the children leave together from the parent's tip, as a fork, and how wide the fork opens. */
  fork?: number;
  open?: [number, number];
  /** How far the parent is pushed aside where one of these leaves it. */
  kink?: number;
};

type LeafSpec = {
  cells: Rect[];
  /** Spray length, metres. */
  size: [number, number];
  aspect: number;
  /** Metres between sprays along a limb. */
  every: number;
  /** Limbs this deep and deeper carry sprays. */
  level: number;
  from: number;
  /** Sprays fanned at each tip. */
  tips: number;
  droop: number;
  cup: number;
  hang: number;
  flutter: number;
  whip?: number;
  tints: V3[];
  /** How far normals bend to the crown's masses, and how dark the deepest leaves go. */
  bend: number;
  dark: number;
  /** 0..1: sprays follow their twig (bare twigs) instead of facing the light. */
  along?: number;
  /** Angle between a spray and its twig. */
  splay?: number;
  /** How far each blade turns its own way instead of facing out of the crown. */
  wild?: number;
};

type TreeSpec = {
  height: number; radius: number; segments: number; gnarl: number; lean: number;
  flare: number; lobes: number; flute?: number; twist?: number;
  bark: number; tint: V3; metres: number;
  limbs: LimbSpec[];
  leaves: LeafSpec | null;
  /** Metres the top leans, and limb tips sway, in a full wind. */
  flex: number; limber: number;
  /** Overall height, for the lean. */
  tall: number;
  /** Exponent of the pipe model: a limb's section is the sum of those it feeds (2 keeps area; lower thins the trunk less). */
  pipe?: number;
  /** Multiplies the radius below which limbs are not meshed (a bare tree shows its finest twigs). */
  twigs?: number;
};

type Limb = { path: Path; dirs: V3[]; level: number; group: number; length: number; forked?: boolean };
type Shoot = { limb: Limb; runs: number[]; area: number[]; kids: Array<{ t: number; shoot: Shoot }> };

/** Turns a heading towards the sky by `angle` radians (away from it when negative). */
function lift(dir: V3, angle: number): V3 {
  const axis = cross(dir, UP), length = Math.hypot(axis[0], axis[1], axis[2]);
  if (length < 1e-4) return dir;
  return norm(turn(dir, [axis[0] / length, axis[1] / length, axis[2] / length], angle));
}

/**
 * Grows the skeleton: the trunk, then each level of limbs off the one before. A limb arcs as it
 * goes (out and then up, or up and then drooping, by species), is pushed aside where a branch
 * leaves it, and may end in a fork. Thickness comes afterwards from the pipe model: every limb's
 * section is the sum of the sections it feeds, so scaffolds are stout, limbs step down at each
 * branch and twigs come out fine, whatever the branching.
 */
function growTree(spec: TreeSpec, seed: number): { limbs: Limb[]; groups: number } {
  const random = rng(seed), limbs: Limb[] = [], power = spec.pipe ?? 2.1;
  let groups = 0;
  const grow = (start: V3, heading: V3, length: number, level: number, group: number, phase: number, sway0: number, own: { segments: number; gnarl: number; up: number; curve?: [number, number] }): Shoot => {
    const child = spec.limbs[level] as LimbSpec | undefined, steps: number[] = [];
    if (level === 0) {
      // A trunk starts under the ground and has close rings at its foot, for the root flare.
      const foot = [0.16, ...(length > 0.8 ? [0.1, 0.16, 0.24, 0.34].map((step) => step * Math.min(1, length / 2.6)) : [])], used = foot.reduce((sum, step) => sum + step, 0);
      steps.push(...foot);
      for (let i = 0; i < own.segments; i += 1) steps.push(Math.max(0.05, length - used) / own.segments);
    } else for (let i = 0; i < own.segments; i += 1) steps.push(length / own.segments);
    const total = steps.reduce((sum, step) => sum + step, 0);
    // Where the children leave is settled first, so the limb can bend away from each as it passes.
    const marks: Array<{ t: number; tip: boolean; k: number; out?: V3 }> = [];
    if (child) {
      const count = Math.round(lerp(child.count[0], child.count[1], random())), fork = Math.min(count, child.fork ?? 0), sides = count - fork;
      for (let k = 0; k < sides; k += 1) marks.push({ t: Math.min(0.97, lerp(child.span[0], child.span[1], (k + random() * 0.7) / Math.max(1, sides - 0.3))), tip: false, k });
      for (let k = 0; k < fork; k += 1) marks.push({ t: 1, tip: true, k });
    }
    const spin = random() * TAU, sways = (at: V3) => spec.flex * Math.pow(clamp(at[1] / spec.tall, 0, 1.2), 2);
    const pts: V3[] = [start], dirs: V3[] = [heading], runs = [0], bend = [sways(start)], sway = [sway0];
    const reach = spec.limber * Math.min(1.3, length / (spec.tall * 0.35)) * Math.pow(0.62, Math.max(0, level - 1));
    let dir = heading, at = start, run = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const t0 = run / total;
      run += steps[i];
      const t = run / total, wander = anywhere(random), share = steps[i] / total * 2;
      if (own.curve) dir = lift(dir, (t <= 0.5 ? own.curve[0] : own.curve[1]) * share);
      dir = norm([dir[0] + wander[0] * own.gnarl, dir[1] + wander[1] * own.gnarl * 0.6 + own.up, dir[2] + wander[2] * own.gnarl]);
      for (const mark of marks) {
        if (mark.tip || mark.t <= t0 || mark.t > t) continue;
        let out = turn(side(dir), dir, spin + mark.k * 2.39996 + (random() - 0.5) * 0.7);
        // Limbs off a leaning branch seldom grow straight down.
        if (level > 0 && out[1] < -0.15 && random() < 0.75) out = norm([out[0], -out[1] * 0.5, out[2]]);
        mark.out = out;
        const kink = child!.kink ?? 0;
        if (kink && level > 0) dir = norm([dir[0] - out[0] * kink, dir[1] - out[1] * kink, dir[2] - out[2] * kink]);
      }
      at = add(at, dir, steps[i]);
      pts.push(at); dirs.push(dir); runs.push(run); bend.push(sways(at));
      sway.push(level ? sway0 + reach * Math.pow(t, 1.6) : 0);
    }
    const limb: Limb = { path: { pts, rad: [], bend, sway, phase }, dirs, level, group, length: total, forked: marks.some((mark) => mark.tip) };
    limbs.push(limb);
    const shoot: Shoot = { limb, runs, area: [], kids: [] };
    if (!child) return shoot;
    const forks = marks.filter((mark) => mark.tip).length, forkSpin = random() * TAU;
    for (const mark of marks) {
      const reached = mark.t * total;
      let i = 0;
      while (i < steps.length - 1 && runs[i + 1] < reached) i += 1;
      const u = clamp((reached - runs[i]) / (runs[i + 1] - runs[i])), from = mix3(pts[i], pts[i + 1], u), along = norm(mix3(dirs[i], dirs[i + 1], u));
      let out: V3, angle: number;
      if (mark.tip) {
        const open = child.open ?? [0.3, 0.6];
        out = turn(side(along), along, forkSpin + mark.k / forks * TAU + (random() - 0.5) * 0.6);
        angle = lerp(open[0], open[1], random()) * (forks === 1 ? 0.45 : 1);
      } else {
        const lean = mark.out ?? side(along), off = dot(lean, along);
        out = norm([lean[0] - along[0] * off, lean[1] - along[1] * off, lean[2] - along[2] * off], side(along));
        angle = lerp(child.angle[0], child.angle[1], random());
      }
      const c = Math.cos(angle), s = Math.sin(angle);
      let next = norm([along[0] * c + out[0] * s, along[1] * c + out[1] * s, along[2] * c + out[2] * s]);
      if (child.flat) next = norm([next[0], next[1] * (1 - child.flat), next[2]]);
      const long = length * lerp(child.length[0], child.length[1], random()) * (child.profile ? child.profile(mark.t) : 1);
      shoot.kids.push({ t: mark.t, shoot: grow(from, next, long, level + 1, level === 0 ? groups++ : group, level === 0 ? random() : phase, lerp(sway[i], sway[i + 1], u), child) });
    }
    return shoot;
  };
  const tilt = random() * TAU;
  const trunk = grow([0, -0.16, 0], norm([Math.cos(tilt) * spec.lean, 1, Math.sin(tilt) * spec.lean]), spec.height + 0.16, 0, 0, 0, 0, { segments: spec.segments, gnarl: spec.gnarl, up: 0.06 });
  // Sections, tips first: a little for the shoot's own tip, some for every metre of it, and all it feeds.
  const sized = (shoot: Shoot): number => {
    const total = shoot.runs[shoot.runs.length - 1], kids = shoot.kids.map((kid) => ({ t: kid.t, area: sized(kid.shoot) }));
    shoot.area = shoot.runs.map((run) => {
      let area = 0.22 + (total - run) * 1.5;
      for (const kid of kids) if (kid.t >= run / total - 1e-4) area += kid.area;
      return area;
    });
    return shoot.area[0];
  };
  const unit = spec.radius / Math.pow(sized(trunk), 1 / power);
  const fit = (shoot: Shoot, scale: number) => {
    const { limb, runs } = shoot, total = runs[runs.length - 1];
    limb.path.rad = shoot.area.map((area, i) => Math.max(0.003, unit * Math.pow(area, 1 / power) * scale * (limb.level === 0 ? 1 + 0.14 * (1 - runs[i] / total) : 1)));
    for (const kid of shoot.kids) {
      const reached = kid.t * total;
      let i = 0;
      while (i < runs.length - 2 && runs[i + 1] < reached) i += 1;
      // A branch is never as stout as the limb it leaves.
      const girth = Math.min(limb.path.rad[i], limb.path.rad[i + 1] * 1.25) * 0.94, base = unit * Math.pow(kid.shoot.area[0], 1 / power) * scale;
      fit(kid.shoot, base > girth ? scale * girth / base : scale);
    }
  };
  fit(trunk, 1);
  return { limbs, groups: Math.max(1, groups) };
}

/**
 * Shades a set of leaf cards as one volume. Normals are bent from each card's own face towards the
 * direction out of its limb's mass and of the whole crown; how deep a card sits (leaf area between
 * it and the open air, outwards and upwards, counted on a coarse grid) is baked into its colour with
 * a hue and value of its own.
 */
function finishCanopy(g: Geo, cards: Card[], groups: number, o: { bend: number; dark: number; tints: V3[]; seed: number; squash?: number }) {
  if (!cards.length) return;
  const random = rng(o.seed), centre: V3 = [0, 0, 0], group: Array<[number, number, number, number]> = [];
  for (let k = 0; k < groups; k += 1) group.push([0, 0, 0, 0]);
  const low: V3 = [1e9, 1e9, 1e9], high: V3 = [-1e9, -1e9, -1e9];
  let total = 0;
  for (const item of cards) {
    const c = item.centre, own = group[Math.min(groups - 1, item.group)];
    for (let k = 0; k < 3; k += 1) { centre[k] += c[k] * item.area; own[k] += c[k] * item.area; low[k] = Math.min(low[k], c[k]); high[k] = Math.max(high[k], c[k]); }
    own[3] += item.area; total += item.area;
  }
  for (let k = 0; k < 3; k += 1) centre[k] /= total;
  const size = 11, span: V3 = [Math.max(0.2, high[0] - low[0]) / size, Math.max(0.2, high[1] - low[1]) / size, Math.max(0.2, high[2] - low[2]) / size];
  const density = new Float32Array(size * size * size), face = Math.pow(span[0] * span[1] * span[2], 2 / 3);
  const slot = (p: V3) => {
    const x = Math.floor((p[0] - low[0]) / span[0]), y = Math.floor((p[1] - low[1]) / span[1]), z = Math.floor((p[2] - low[2]) / span[2]);
    return x < 0 || y < 0 || z < 0 || x >= size || y >= size || z >= size ? -1 : (z * size + y) * size + x;
  };
  for (const item of cards) { const at = slot(item.centre); if (at >= 0) density[at] += item.area * 0.5 / face; }
  const stride = Math.min(span[0], span[1], span[2]), squash = o.squash ?? 1;
  for (const item of cards) {
    const own = group[Math.min(groups - 1, item.group)], mass: V3 = own[3] > 0 ? [own[0] / own[3], own[1] / own[3], own[2] / own[3]] : centre;
    const outward = norm(mix3(norm(sub(item.centre, mass)), norm(sub(item.centre, centre)), 0.45));
    let thick = 0;
    for (let s = 1; s <= 7; s += 1) {
      const a = slot(add(item.centre, outward, s * stride)), b = slot(add(item.centre, UP, s * stride));
      thick += (a >= 0 ? density[a] * 0.6 : 0) + (b >= 0 ? density[b] * 0.22 : 0);
    }
    const open = Math.exp(-thick * 0.42), shade = lerp(o.dark, 1, open) * (0.86 + random() * 0.26), tint = o.tints[Math.floor(random() * o.tints.length)];
    // Leaves in the open are the young, lighter ones.
    const fresh = 0.94 + open * 0.12;
    for (let v = item.first; v < item.first + item.count; v += 1) {
      const p = g.at(v), away = norm(mix3(norm([p[0] - mass[0], (p[1] - mass[1]) * squash, p[2] - mass[2]]), norm([p[0] - centre[0], (p[1] - centre[1]) * squash, p[2] - centre[2]]), 0.45));
      let n: V3 = [g.n[v * 3], g.n[v * 3 + 1], g.n[v * 3 + 2]];
      if (dot(n, away) < 0) n = [-n[0], -n[1], -n[2]];
      n = norm(mix3(n, away, o.bend));
      g.n[v * 3] = n[0]; g.n[v * 3 + 1] = n[1]; g.n[v * 3 + 2] = n[2];
      g.c[v * 4] *= shade * tint[0] * fresh; g.c[v * 4 + 1] *= shade * tint[1] * fresh; g.c[v * 4 + 2] *= shade * tint[2];
    }
  }
}

type Grown = { bark: Geo; foliage: Geo; pot: Geo };
const grown = (): Grown => ({ bark: new Geo(), foliage: new Geo(), pot: new Geo() });

/** Position, direction and wind weights at `t` along a limb. */
function along(limb: Limb, t: number) {
  const n = limb.path.pts.length - 1, f = clamp(t) * n, i = Math.min(n - 1, Math.floor(f)), u = f - i, path = limb.path;
  return { at: mix3(path.pts[i], path.pts[i + 1], u), dir: norm(mix3(limb.dirs[i], limb.dirs[i + 1], u)), bend: lerp(path.bend[i], path.bend[i + 1], u), sway: lerp(path.sway[i], path.sway[i + 1], u), radius: lerp(path.rad[i], path.rad[i + 1], u) };
}

/** Grows a branching tree from its spec and meshes it at a detail level: bark tubes, then the crown. */
function buildTree(spec: TreeSpec, seed: number, lod: Lod, out: Grown = grown(), extra?: (limbs: Limb[], cards: Card[], centre: V3) => void): Grown {
  const { limbs, groups } = growTree(spec, seed), flareTurn = rng(seed + 5)() * TAU, cut = lod.cut * (spec.twigs ?? 1);
  for (const limb of limbs) {
    if (limb.level > 0 && limb.path.rad[0] < cut) continue;
    const step = lod.rank === 2 ? 1 : lod.rank === 1 ? 2 : 3;
    if (limb.level === 0) {
      const path = thin(limb.path, step, lod.rank === 2 ? 5 : 3), pts = path.pts, reach = Math.max(0.12, spec.radius * 1.15);
      tube(out.bark, path, sidesFor(spec.radius, lod), {
        bark: spec.bark, tint: spec.tint, metres: spec.metres, cap: true,
        // Root flare: the stem widens into buttresses as it meets the ground; flutes twist up an old trunk.
        swell: (i, a) => {
          const low = Math.exp(-Math.max(0, pts[i][1] + 0.04) / reach);
          return 1 + spec.flare * low * (1 + (0.35 + 0.5 * low) * Math.cos(spec.lobes * a + flareTurn)) + (spec.flute ?? 0) * Math.cos(3 * a + (spec.twist ?? 0) * pts[i][1] + flareTurn) * clamp(1.4 - pts[i][1] / spec.height);
        },
        shade: (i) => 0.7 + 0.3 * smooth(0, 0.5, pts[i][1]),
      });
    } else {
      // A collar where the limb leaves its parent, and a closed end where it forks.
      tube(out.bark, thin(limb.path, step), sidesFor(limb.path.rad[0], lod), { bark: spec.bark, tint: spec.tint, metres: spec.metres, swell: (i) => (i === 0 ? 1.32 : 1), cap: limb.forked });
    }
  }
  const leaf = spec.leaves;
  if (!leaf) return out;
  // Where the crown and each main limb's mass are, from the skeleton.
  const centre: V3 = [0, 0, 0], masses: V3[] = [], weights: number[] = [];
  for (let k = 0; k < groups; k += 1) { masses.push([0, 0, 0]); weights.push(0); }
  let weight = 0;
  for (const limb of limbs) {
    if (limb.level < leaf.level) continue;
    const tip = limb.path.pts[limb.path.pts.length - 1], mass = masses[limb.group];
    for (let k = 0; k < 3; k += 1) { centre[k] += tip[k]; mass[k] += tip[k]; }
    weights[limb.group] += 1; weight += 1;
  }
  for (let k = 0; k < 3; k += 1) centre[k] /= Math.max(1, weight);
  masses.forEach((mass, index) => { for (let k = 0; k < 3; k += 1) mass[k] = weights[index] ? mass[k] / weights[index] : centre[k]; });
  const cards: Card[] = [], vary = rng(seed + 104729), pick = rng(seed + 7919);
  const splay = leaf.splay ?? 0.85, loose = leaf.along ?? 0, wild = leaf.wild ?? 0.8, deepest = spec.limbs.length;
  // One small spray: it leaves its twig at an angle, any way round it, reaches for the open air and
  // hangs by its own weight; its blades face the light, each with a turn of its own. Thousands of
  // them, none lying in one surface, are what gives the crown depth from every side.
  const sprayAt = (limb: Limb, t: number, index: number, tip: boolean) => {
    const jitter = anywhere(vary), size = vary(), cellPick = vary(), roll = vary(), spinBy = vary(), chosen = pick() < lod.keep;
    if (!chosen) return;
    const here = along(limb, t), outward = norm(mix3(norm(sub(here.at, masses[limb.group])), norm(sub(here.at, centre)), 0.4));
    const radial = turn(side(here.dir), here.dir, index * 2.39996 + spinBy * 1.3);
    const lean = (tip ? (index ? splay * 0.7 : 0.12) : splay * (0.7 + roll * 0.5)) * (1 - loose * 0.6), c = Math.cos(lean), s = Math.sin(lean), pull = 0.3 * (1 - loose);
    const axis = norm([here.dir[0] * c + radial[0] * s + outward[0] * pull, here.dir[1] * c + radial[1] * s + outward[1] * pull - leaf.hang, here.dir[2] * c + radial[2] * s + outward[2] * pull]);
    const facing: V3 = [outward[0] * 0.55 * (1 - loose) + jitter[0] * wild, (outward[1] * 0.55 + 0.5) * (1 - loose) + jitter[1] * wild, outward[2] * 0.55 * (1 - loose) + jitter[2] * wild];
    const off = dot(facing, axis), normal = norm([facing[0] - axis[0] * off, facing[1] - axis[1] * off, facing[2] - axis[2] * off], side(axis));
    const rect = leaf.cells[Math.floor(cellPick * leaf.cells.length)], long = lerp(leaf.size[0], leaf.size[1], size) * lod.grow;
    card(out.foliage, cards, limb.group, add(here.at, axis, -long * 0.04), axis, normal, long, long * leaf.aspect * rect.w / rect.h, rect, ATLAS, {
      grid: 0, droop: leaf.droop * (0.5 + roll), cup: leaf.cup, bend: here.bend, sway: here.sway, phase: limb.path.phase, random: roll, flutter: leaf.flutter, flip: roll > 0.5, whip: leaf.whip,
    });
  };
  for (const limb of limbs) {
    if (limb.level < leaf.level) continue;
    // Limbs that carry twigs of their own are thinner in leaf: the twigs do the work.
    const every = leaf.every * (limb.level < deepest ? 1.7 : 1);
    let index = Math.floor(vary() * 8);
    for (let s = limb.length * leaf.from + vary() * every; s < limb.length * 0.95; s += every * (0.7 + vary() * 0.6)) { sprayAt(limb, s / limb.length, index, false); index += 1; }
    for (let k = 0; k < leaf.tips; k += 1) sprayAt(limb, 1, k, true);
  }
  if (extra) extra(limbs, cards, centre);
  finishCanopy(out.foliage, cards, groups, { bend: leaf.bend, dark: leaf.dark, tints: leaf.tints, seed: seed + 31 });
  return out;
}

// ---- The trees -----------------------------------------------------------------------------------

const GREENS: V3[] = [[1, 1, 1], [1.1, 1.05, 0.84], [0.9, 0.98, 0.94], [1.02, 1.02, 0.9]];

/** A small sphere mapped onto a swatch (fruit). `wind` is copied from the spray it hangs by. */
function ball(g: Geo, centre: V3, radius: number, rect: Rect, wind: V4, tag: number, shade: number, lod: Lod) {
  const around = lod.rank === 2 ? 6 : 4, rings = lod.rank === 2 ? 4 : 3, first = g.count;
  for (let r = 0; r <= rings; r += 1) for (let k = 0; k <= around; k += 1) {
    const polar = r / rings * Math.PI, a = k / around * TAU, n: V3 = [Math.sin(polar) * Math.cos(a), Math.cos(polar), Math.sin(polar) * Math.sin(a)];
    g.vert(add(centre, n, radius), n, (rect.x + (0.1 + 0.8 * k / around) * rect.w) / ATLAS, (rect.y + (0.1 + 0.8 * r / rings) * rect.h) / ATLAS, [shade, shade, shade, tag], wind);
  }
  for (let r = 0; r < rings; r += 1) for (let k = 0; k < around; k += 1) { const a = first + r * (around + 1) + k; g.quad(a, a + 1, a + around + 2, a + around + 1); }
}

/** A strip along a path: `across` verts wide, mapped up a cell (foot at the bottom) or along it (foot at the left). */
function ribbon(g: Geo, cards: Card[] | null, group: number, pts: V3[], faces: V3[], width: (t: number) => number, rect: Rect, o: { lengthwise?: boolean; columns: number; cup?: number; tint?: V3 | ((t: number) => V3); tag?: number; bend: (i: number) => number; sway: (t: number) => number; phase: number; random: number; flutter?: number }) {
  const first = g.count, count = pts.length, columns = o.columns, z = phased(o.phase, o.random), tag = o.tag ?? 1;
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1), tangent = norm(sub(pts[Math.min(count - 1, i + 1)], pts[Math.max(0, i - 1)])), across = norm(cross(tangent, faces[i])), face = norm(cross(across, tangent)), wide = width(t);
    const tint = typeof o.tint === "function" ? o.tint(t) : o.tint ?? [1, 1, 1];
    if (i > 0) area += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) * wide;
    for (let c = 0; c < columns; c += 1) {
      const s = c / (columns - 1) - 0.5, lift = (o.cup ?? 0) * wide * (4 * s * s - 0.33);
      const p: V3 = [pts[i][0] + across[0] * wide * s + face[0] * lift, pts[i][1] + across[1] * wide * s + face[1] * lift, pts[i][2] + across[2] * wide * s + face[2] * lift];
      const n = norm([face[0] - across[0] * 8 * (o.cup ?? 0) * s, face[1] - across[1] * 8 * (o.cup ?? 0) * s, face[2] - across[2] * 8 * (o.cup ?? 0) * s]);
      const u = o.lengthwise ? rect.x + t * rect.w : rect.x + (0.5 + s) * rect.w, v = o.lengthwise ? rect.y + (0.5 - s) * rect.h : rect.y + (1 - t) * rect.h;
      g.vert(p, n, u / ATLAS, v / ATLAS, [tint[0], tint[1], tint[2], tag], [o.bend(i), o.sway(t), z, (o.flutter ?? 0) * s * 2 * t]);
    }
  }
  for (let i = 0; i < count - 1; i += 1) for (let c = 0; c < columns - 1; c += 1) { const a = first + i * columns + c; g.quad(a, a + 1, a + columns + 1, a + columns); }
  const mid = Math.floor(count / 2);
  if (cards) cards.push({ first, count: count * columns, centre: pts[mid], normal: faces[mid], area, group });
}

const planeSpec = (): TreeSpec => ({
  height: 4.3, radius: 0.34, segments: 7, gnarl: 0.035, lean: 0.05, flare: 0.6, lobes: 5,
  bark: BARK.plane, tint: [1, 1, 1], metres: 3,
  limbs: [
    // The stem divides at about 4 m into ascending scaffolds, with a couple of limbs below the fork.
    { count: [6, 7], fork: 3, open: [0.36, 0.6], span: [0.62, 0.92], angle: [0.65, 0.95], length: [0.9, 1.12], up: 0.03, gnarl: 0.09, segments: 9, curve: [-0.08, 0.4], profile: (t) => (t < 0.97 ? 0.76 : 1) },
    { count: [8, 10], fork: 2, open: [0.3, 0.6], span: [0.2, 0.93], angle: [0.6, 1.05], length: [0.36, 0.5], up: 0.02, gnarl: 0.13, segments: 6, curve: [0.15, -0.22], kink: 0.16, profile: (t) => 1.2 - 0.45 * t },
    { count: [6, 8], fork: 1, span: [0.2, 0.95], angle: [0.55, 1.0], length: [0.36, 0.52], up: 0, gnarl: 0.18, segments: 3, curve: [0.05, -0.3], kink: 0.2 },
    { count: [3, 4], fork: 1, span: [0.25, 0.95], angle: [0.5, 1.0], length: [0.42, 0.62], up: -0.02, gnarl: 0.22, segments: 2, curve: [0, -0.2] },
  ],
  leaves: { cells: SPRIGS.plane, size: [0.44, 0.6], aspect: 1, every: 0.14, level: 3, from: 0.18, tips: 3, droop: 0.14, cup: 0, hang: 0.32, flutter: 0.03, whip: 0.04, tints: GREENS, bend: 0.7, dark: 0.5 },
  flex: 0.14, limber: 0.3, tall: 11.5,
});

const orangeSpec = (): TreeSpec => ({
  height: 1.35, radius: 0.085, segments: 4, gnarl: 0.04, lean: 0.04, flare: 0.45, lobes: 4,
  bark: BARK.furrowed, tint: [1.12, 1.06, 0.96], metres: 1.5,
  limbs: [
    { count: [4, 5], fork: 3, open: [0.45, 0.75], span: [0.72, 0.95], angle: [0.8, 1.15], length: [0.48, 0.62], up: 0.06, gnarl: 0.12, segments: 5, curve: [-0.1, 0.3] },
    { count: [6, 7], fork: 2, open: [0.4, 0.7], span: [0.25, 0.92], angle: [0.6, 1.1], length: [0.46, 0.6], up: 0.03, gnarl: 0.18, segments: 4, curve: [0.1, -0.1], kink: 0.15 },
    { count: [4, 5], fork: 1, span: [0.25, 0.95], angle: [0.6, 1.1], length: [0.5, 0.7], up: 0, gnarl: 0.2, segments: 2, curve: [0, -0.15], kink: 0.15 },
  ],
  leaves: { cells: SPRIGS.citrus, size: [0.27, 0.37], aspect: 1, every: 0.06, level: 2, from: 0.12, tips: 3, droop: 0.12, cup: 0, hang: 0.18, flutter: 0.02, tints: GREENS, bend: 0.75, dark: 0.46 },
  flex: 0.05, limber: 0.1, tall: 3.4,
});

const oliveSpec = (): TreeSpec => ({
  height: 1.55, radius: 0.3, segments: 5, gnarl: 0.09, lean: 0.09, flare: 0.55, lobes: 4, flute: 0.2, twist: 2.4, pipe: 2.3, twigs: 1.5,
  bark: BARK.furrowed, tint: [1.08, 1.08, 1.04], metres: 2.4,
  limbs: [
    { count: [4, 5], fork: 3, open: [0.42, 0.72], span: [0.6, 0.9], angle: [0.7, 1.05], length: [0.95, 1.25], up: 0.04, gnarl: 0.2, segments: 8, curve: [-0.15, 0.35] },
    { count: [7, 8], fork: 2, open: [0.4, 0.7], span: [0.22, 0.92], angle: [0.55, 1.05], length: [0.4, 0.55], up: 0.03, gnarl: 0.24, segments: 5, curve: [0.1, -0.2], kink: 0.22 },
    { count: [5, 6], fork: 1, span: [0.2, 0.95], angle: [0.5, 1.1], length: [0.42, 0.62], up: -0.01, gnarl: 0.25, segments: 3, curve: [0, -0.35], kink: 0.2 },
    { count: [2, 3], fork: 1, span: [0.3, 0.95], angle: [0.5, 1.0], length: [0.45, 0.7], up: -0.04, gnarl: 0.25, segments: 2, curve: [0, -0.3] },
  ],
  leaves: { cells: SPRIGS.olive, size: [0.34, 0.48], aspect: 1, every: 0.055, level: 3, from: 0.1, tips: 3, droop: 0.15, cup: 0, hang: 0.25, flutter: 0.022, whip: 0.04, tints: [[1, 1, 1], [1.1, 1.08, 1.0], [0.9, 0.95, 0.92]], bend: 0.65, dark: 0.52 },
  flex: 0.05, limber: 0.2, tall: 4.6,
});

const bareSpec = (): TreeSpec => ({
  height: 2.7, radius: 0.2, segments: 6, gnarl: 0.05, lean: 0.06, flare: 0.5, lobes: 5, twigs: 0.5,
  bark: BARK.furrowed, tint: [0.78, 0.78, 0.8], metres: 2.6,
  limbs: [
    { count: [6, 7], fork: 3, open: [0.3, 0.55], span: [0.6, 0.93], angle: [0.6, 1.0], length: [0.82, 1.05], up: 0.04, gnarl: 0.12, segments: 8, curve: [-0.1, 0.35], profile: (t) => (t < 0.97 ? 0.75 : 1) },
    { count: [5, 7], fork: 2, span: [0.25, 0.92], angle: [0.5, 0.95], length: [0.38, 0.52], up: 0.03, gnarl: 0.18, segments: 5, curve: [0.1, -0.1], kink: 0.2 },
    { count: [4, 5], fork: 1, span: [0.2, 0.95], angle: [0.45, 0.9], length: [0.42, 0.6], up: 0.02, gnarl: 0.24, segments: 3, curve: [0, -0.15], kink: 0.2 },
    { count: [3, 4], fork: 1, span: [0.2, 0.95], angle: [0.4, 0.9], length: [0.45, 0.65], up: 0.01, gnarl: 0.3, segments: 2, curve: [0, -0.1], kink: 0.15 },
  ],
  leaves: { cells: [CELLS.twigs], size: [0.5, 0.72], aspect: 1.8, every: 0.42, level: 3, from: 0.3, tips: 1, droop: 0, cup: 0, hang: -0.05, along: 0.8, flutter: 0.008, tints: [[0.8, 0.8, 0.82], [1, 0.96, 0.9]], bend: 0.25, dark: 0.75 },
  flex: 0.1, limber: 0.22, tall: 8.2,
});

const shrubSpec = (): TreeSpec => ({
  height: 0.3, radius: 0.055, segments: 2, gnarl: 0.05, lean: 0.05, flare: 0.2, lobes: 3,
  bark: BARK.furrowed, tint: [0.95, 0.9, 0.82], metres: 1.2,
  limbs: [
    { count: [7, 9], fork: 2, open: [0.2, 0.5], span: [0.3, 0.9], angle: [0.3, 0.85], length: [1.25, 1.8], up: 0.06, gnarl: 0.15, segments: 5, curve: [-0.1, 0.25] },
    { count: [5, 6], fork: 1, span: [0.25, 0.95], angle: [0.5, 1.0], length: [0.38, 0.55], up: 0.03, gnarl: 0.2, segments: 3, curve: [0, -0.1], kink: 0.15 },
    { count: [2, 3], fork: 1, span: [0.3, 0.95], angle: [0.5, 1.0], length: [0.5, 0.7], up: 0, gnarl: 0.2, segments: 2 },
  ],
  leaves: { cells: SPRIGS.citrus, size: [0.22, 0.32], aspect: 1, every: 0.05, level: 1, from: 0.3, tips: 2, droop: 0.15, cup: 0, hang: 0.15, flutter: 0.02, tints: GREENS, bend: 0.7, dark: 0.45 },
  flex: 0.02, limber: 0.12, tall: 1.5,
});

/** Variants of a branching tree are the same species grown from another seed, a little taller or squatter. */
function branching(spec: TreeSpec, variant: number, seed: number, lod: Lod, fruit = false) {
  const stretch = [1, 0.88, 1.1][variant % 3];
  spec.height *= stretch; spec.tall *= stretch; spec.radius *= lerp(1, stretch, 0.5);
  const out = grown(), fruitRandom = rng(seed + 77);
  return buildTree(spec, seed + variant * 1013, lod, out, fruit ? (_limbs, cards) => {
    // Oranges hang under the outer sprays: about ninety on a tree seen close.
    const share = (lod.rank === 2 ? 90 : lod.rank === 1 ? 40 : 0) / Math.max(1, cards.length);
    for (const item of cards) {
      const roll = fruitRandom(), away = fruitRandom(), down = fruitRandom();
      if (roll > share) continue;
      const g = out.foliage, v = item.first, wind: V4 = [g.w[v * 4], g.w[v * 4 + 1], phased(fruitRandom(), fruitRandom()), 0];
      ball(g, [item.centre[0] + (away - 0.5) * 0.12, item.centre[1] - 0.05 - down * 0.08, item.centre[2] + (roll / share - 0.5) * 0.12], 0.036 + down * 0.008, CELLS.fruit, wind, 0.75, 0.82 + away * 0.3, lod);
    }
  } : undefined);
}

/** Italian cypress: a dark flame of upright sprays round a thin stem, lumpy in outline. */
function buildCypress(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 811), height = [8.2, 6.6, 4.8][variant % 3] * (0.96 + random() * 0.08), wide = [0.62, 0.68, 0.5][variant % 3];
  const girth = (h: number) => wide * Math.min(1, 0.4 + h * 7) * Math.pow(Math.max(0, 1 - h), 0.5) * 1.12, flex = 0.26, lump = random() * TAU;
  const trunk: Path = { pts: [], rad: [], bend: [], sway: [], phase: 0 };
  for (const y of [-0.15, 0, 0.12, 0.4, 1.2, height * 0.5, height * 0.86]) { trunk.pts.push([0, y, 0]); trunk.rad.push(lerp(0.12, 0.015, clamp(y / height))); trunk.bend.push(flex * Math.pow(clamp(y / height), 2)); trunk.sway.push(0); }
  tube(out.bark, thin(trunk, lod.rank === 2 ? 1 : 2, 3), sidesFor(0.12, lod), { bark: BARK.scaly, tint: [1.05, 0.98, 0.94], metres: 1.6, swell: (i) => 1 + 0.5 * Math.exp(-Math.max(0, trunk.pts[i][1] + 0.1) / 0.25) });
  const cards: Card[] = [], count = Math.round(height * 150), pick = rng(seed + 3);
  for (let k = 0; k < count; k += 1) {
    const h = 0.03 + 0.95 * Math.pow((k + random()) / count, 0.9), azimuth = k * 2.39996 + random(), inner = k % 3 === 0, jitter = (random() - 0.5) * 1.0, size = random(), tilt = random(), keep = pick() < lod.keep;
    if (!keep) continue;
    const r = girth(h) * (inner ? 0.5 : 0.78 + random() * 0.26) * (1 + 0.2 * Math.sin(azimuth * 3 + h * 10 + lump)), long = lerp(0.6, 1.0, size) * Math.sqrt(lod.grow) * (h > 0.85 ? 0.7 : 1);
    const c = Math.cos(azimuth), s = Math.sin(azimuth), axis = norm([c * (0.16 + tilt * 0.16), 1, s * (0.16 + tilt * 0.16)]);
    card(out.foliage, cards, 0, [c * r * 0.7, Math.max(0.12, h * height - long * 0.4), s * r * 0.7], axis, [Math.cos(azimuth + jitter), 0.12, Math.sin(azimuth + jitter)], long, long * 0.56 * Math.sqrt(lod.grow), CELLS.cypress, ATLAS, {
      grid: lod.grid, droop: -0.04, cup: -0.09, bend: flex * h * h, sway: 0.06 * h, phase: random(), random: random(), flutter: 0.014, flip: random() > 0.5, whip: 0.05,
    });
  }
  // A dark inner column closes the gaps between sprays.
  const rings = lod.rank === 2 ? 8 : 4, around = lod.rank === 2 ? 7 : 5, core = CELLS.core;
  for (let ring = 0; ring < rings; ring += 1) for (let k = 0; k < around; k += 1) {
    const corner = (dr: number, dk: number) => {
      const h = 0.05 + (ring + dr) / rings * 0.9, a = (k + dk) / around * TAU, r = girth(h) * 0.5;
      return out.foliage.vert([Math.cos(a) * r, h * height, Math.sin(a) * r], [Math.cos(a), 0.1, Math.sin(a)], (core.x + (dk ? 0.9 : 0.1) * core.w) / ATLAS, (core.y + (dr ? 0.1 : 0.9) * core.h) / ATLAS, [0.72, 0.72, 0.72, 1], [flex * h * h, 0, phased(0, 0.5), 0]);
    };
    const a = corner(0, 0), b = corner(0, 1), c = corner(1, 1), d = corner(1, 0);
    out.foliage.quad(a, d, c, b);
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.6, dark: 0.52, tints: [[1, 1, 1], [1.08, 1.04, 0.9], [0.9, 0.96, 0.96]], seed: seed + 9, squash: 0.12 });
  return out;
}

/**
 * Spruce: whorls of boughs that sweep down and lift at the tip. Each bough is a woody axis with flat
 * needle sprays raked off both sides, shortest at the tip, branchlets hanging under it and a paler
 * shoot at its end; snow loads lie along the ridge on request. Far away a bough is one tented card.
 */
function buildSpruce(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 577), height = [10.5, 7.6, 5.2][variant % 3] * (0.96 + random() * 0.08), spread = height * 0.235, flex = 0.2;
  const trunk: Path = { pts: [], rad: [], bend: [], sway: [], phase: 0 }, base = height * 0.016 + 0.06;
  for (const y of [-0.15, 0, 0.12, 0.4, 1.2, height * 0.35, height * 0.65, height * 0.88, height]) { trunk.pts.push([0, y, 0]); trunk.rad.push(lerp(base, 0.012, Math.pow(clamp(y / height), 0.9))); trunk.bend.push(flex * Math.pow(clamp(y / height), 2)); trunk.sway.push(0); }
  tube(out.bark, thin(trunk, lod.rank === 2 ? 1 : 2, 3), sidesFor(base, lod), { bark: BARK.scaly, tint: [1, 1, 1], metres: 2, swell: (i, a) => 1 + 0.5 * Math.exp(-Math.max(0, trunk.pts[i][1] + 0.05) / 0.22) * (1 + 0.4 * Math.cos(5 * a)) });
  const cards: Card[] = [], spruce = CELLS.spruce;
  // With distance: fewer whorls of larger boughs.
  const sparse = lod.rank === 2 ? (lod.fine ? 1 : 1.5) : lod.rank === 1 ? (lod.fine ? 1.3 : 1.9) : (lod.fine ? 2.2 : 3), swell = Math.pow(sparse, 0.45), tent = -0.42;
  const shape = (t: number) => (t < 0.3 ? lerp(0.62, 1, t / 0.3) : lerp(1, 0.36, (t - 0.3) / 0.7));
  let turnBy = random() * TAU;
  for (let y = 0.7 + random() * 0.3; y < height - 0.35; y += lerp(0.42, 0.2, y / height) * (0.9 + random() * 0.2) * sparse) {
    const h = y / height, boughs = lod.rank === 0 ? 4 : h > 0.9 ? 5 : 6 + (random() < 0.5 ? 1 : 0);
    turnBy += 0.7 + random();
    for (let k = 0; k < boughs; k += 1) {
      const azimuth = turnBy + k / boughs * TAU + (random() - 0.5) * 0.35, long = (spread * Math.pow(1 - h, 0.85) + 0.22) * (0.7 + random() * 0.5) * (y < 1.6 ? 0.82 : 1), off = (random() - 0.5) * 0.34 * sparse;
      const rise = lerp(-0.4, 0.42, Math.pow(h, 1.5)) + (random() - 0.5) * 0.2 - (lod.rank === 0 ? 0.25 : 0), phase = random();
      // The bough: out and down, then lifting towards its tip.
      const c = Math.cos(azimuth), s = Math.sin(azimuth), pts: V3[] = [[c * 0.02, Math.min(height - 0.4, y + off), s * 0.02]], dirs: V3[] = [];
      let dir: V3 = norm([c * Math.cos(rise - 0.12), Math.sin(rise - 0.12), s * Math.cos(rise - 0.12)]);
      const steps = 6;
      for (let i = 1; i <= steps; i += 1) { dirs.push(dir); pts.push(add(pts[i - 1], dir, long / steps)); dir = norm([dir[0], dir[1] + (i < 3 ? -0.07 : 0.11), dir[2]]); }
      dirs.push(dir);
      const limb: Limb = { path: { pts, rad: pts.map((_p, i) => lerp(0.012 + long * 0.011, 0.004, i / steps)), bend: pts.map((p) => flex * Math.pow(clamp(p[1] / height), 2)), sway: pts.map((_p, i) => 0.16 * (long / spread) * Math.pow(i / steps, 1.6)), phase }, dirs, level: 1, group: 0, length: long };
      if (limb.path.rad[0] >= lod.cut && (lod.rank === 2 || (lod.rank === 1 && long > 1.3))) tube(out.bark, lod.rank === 2 ? limb.path : thin(limb.path, 2), 3, { bark: BARK.scaly, tint: [0.9, 0.86, 0.8], metres: 1.2 });
      if (lod.rank === 0) {
        const here = along(limb, 0), there = along(limb, 1), axis = norm(sub(there.at, here.at)), reach = long * 1.25, roll = random();
        card(out.foliage, cards, 0, here.at, axis, [c * 0.1, 1, s * 0.1], reach, reach * 0.95 * swell, spruce, ATLAS, { grid: 0, droop: 0.1, cup: tent, bend: here.bend, sway: here.sway, phase, random: roll, flutter: 0.012, whip: there.sway - here.sway, flip: roll > 0.5 });
        card(out.foliage, null, 0, add(here.at, UP, 0.3 * reach * -tent), axis, UP, reach * 0.8, reach * 0.42 * swell, CELLS.snow, ATLAS, { grid: 0, droop: 0.1, bend: here.bend, sway: there.sway * 0.5, phase, random: random(), tag: 0.5 });
        continue;
      }
      const gap = (lod.rank === 2 ? 0.23 : 0.36) * (lod.fine ? 1 : 1.5), pairs = Math.max(1, Math.round(long / gap)), widest = clamp(long * 0.5, 0.36, 0.9) * (lod.rank === 2 ? 1 : 1.3) * (lod.fine ? 1 : 1.2);
      for (let n = 0; n < pairs; n += 1) {
        const t = 0.1 + (n + 0.3 + random() * 0.4) / pairs * 0.84, here = along(limb, t), flat = norm(cross(here.dir, UP), [s, 0, -c]);
        const tint: V3 = t > 0.68 ? [1.1, 1.16, 0.94] : [1, 1, 1];
        for (const way of [-1, 1]) {
          const rake = 0.8 + random() * 0.35, cr = Math.cos(rake), sr = Math.sin(rake) * way, size = widest * shape(t) * (0.85 + random() * 0.3), roll = random();
          const axis = norm([here.dir[0] * cr + flat[0] * sr, here.dir[1] * cr + flat[1] * sr - 0.2 - random() * 0.2, here.dir[2] * cr + flat[2] * sr]);
          card(out.foliage, cards, 0, here.at, axis, [flat[0] * way * 0.35 + (random() - 0.5) * 0.3, 1, flat[2] * way * 0.35 + (random() - 0.5) * 0.3], size, size * 0.72, spruce, ATLAS, { grid: lod.rank === 2 && lod.fine ? 1 : 0, droop: 0.18, cup: -0.1, bend: here.bend, sway: here.sway, phase, random: roll, flutter: 0.012, whip: 0.04, flip: roll > 0.5, tint });
        }
        // Branchlets hang like a comb under the bough.
        if (long > 0.6 && n % (lod.rank === 2 ? 2 : 3) === 0) {
          const drop = lerp(0.3, 0.62, random()) * Math.min(1.1, long) * (lod.rank === 2 ? 1 : 1.25), way = random() < 0.5 ? -1 : 1, roll = random();
          card(out.foliage, cards, 0, add(here.at, UP, -0.02), norm([flat[0] * way * 0.25 + here.dir[0] * 0.2, -1, flat[2] * way * 0.25 + here.dir[2] * 0.2]), [here.dir[0] + flat[0] * way * 0.7, 0.2, here.dir[2] + flat[2] * way * 0.7], drop, drop * 0.78, spruce, ATLAS, { grid: 0, bend: here.bend, sway: here.sway, phase, random: roll, flutter: 0.014, whip: 0.05, flip: way > 0 });
        }
      }
      // The young shoot at the end of the bough is paler.
      { const here = along(limb, 0.84), size = clamp(long * 0.4, 0.3, 0.7), roll = random(); card(out.foliage, cards, 0, here.at, here.dir, [(random() - 0.5) * 0.3, 1, (random() - 0.5) * 0.3], size, size * 0.62, spruce, ATLAS, { grid: 0, droop: 0.1, cup: -0.08, bend: here.bend, sway: here.sway, phase, random: roll, flutter: 0.012, whip: 0.05, tint: [1.12, 1.18, 0.94] }); }
      // Snow loads: lying along the ridge, folded away unless the instance asks for snow.
      const loads = lod.rank === 2 ? Math.max(1, Math.round(long / 0.6)) : 1;
      for (let n = 0; n < loads; n += 1) {
        const t = 0.08 + (n + 0.5) / loads * 0.8, here = along(limb, t), wide = widest * shape(t) * 1.25;
        card(out.foliage, null, 0, add(here.at, UP, 0.035), here.dir, UP, long / loads * 1.15, wide, CELLS.snow, ATLAS, { grid: 0, droop: 0.08, bend: here.bend, sway: here.sway, phase, random: random(), tag: 0.5 });
      }
    }
  }
  // The leader and its last shoots.
  for (let k = 0; k < 3; k += 1) {
    const a = k / 3 * TAU + random();
    card(out.foliage, cards, 0, [0, height - 0.72, 0], norm([Math.cos(a) * 0.1, 1, Math.sin(a) * 0.1]), [Math.cos(a + 1.57), 0.1, Math.sin(a + 1.57)], 0.95, 0.5, spruce, ATLAS, { grid: lod.grid, bend: flex, sway: 0.03, phase: random(), random: random(), flutter: 0.01, tint: [1.08, 1.12, 0.96] });
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.42, dark: 0.5, tints: [[1.2, 1.22, 1.16], [1.08, 1.2, 1.22], [1.28, 1.26, 1.08]], seed: seed + 9, squash: 0.3 });
  return out;
}

type PalmLook = { height: number; lean: number; radius: number; fronds: number; long: number };

/** The stem both palms share: leaning, thick at the foot and under the crown, with leaf-base stubs where fronds were cut. */
function palmStem(out: Grown, random: Random, look: PalmLook, lod: Lod, stubsFrom: number, flex: number) {
  const heading = random() * TAU, trunk: Path = { pts: [], rad: [], bend: [], sway: [], phase: 0 }, steps = 14, dirs: V3[] = [];
  let at: V3 = [0, -0.15, 0];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps, tiltBy = look.lean * (1.25 - 1.7 * t), dir = norm([Math.cos(heading) * tiltBy, 1, Math.sin(heading) * tiltBy]);
    if (i > 0) at = add(at, dir, (look.height + 0.15) / steps);
    trunk.pts.push(at); dirs.push(dir);
    trunk.rad.push(look.radius * (1 + 0.3 * Math.exp(-t * 9) + 0.16 * smooth(0.72, 1, t)));
    trunk.bend.push(flex * t * t); trunk.sway.push(0);
  }
  tube(out.bark, thin(trunk, lod.rank === 2 ? 1 : lod.rank === 1 ? 2 : 4, 1), sidesFor(look.radius, lod), { bark: BARK.palm, tint: [1, 1, 1], metres: 2.6, shade: (_i, t) => 0.8 + 0.2 * smooth(0, 0.1, t) });
  if (lod.rank > 0) {
    const stubs = Math.round((1 - stubsFrom) * look.height * (lod.rank === 2 ? (lod.fine ? 22 : 12) : 7));
    for (let k = 0; k < stubs; k += 1) {
      const t = lerp(stubsFrom, 0.985, (k + random() * 0.5) / stubs), f = t * steps, i = Math.min(steps - 1, Math.floor(f)), u = f - i;
      const centre = mix3(trunk.pts[i], trunk.pts[i + 1], u), up = dirs[i], around = turn(side(up), up, k * 2.39996), r = lerp(trunk.rad[i], trunk.rad[i + 1], u);
      // A boot: the stub of a cut frond, wide where it clasps the stem, turned up at its end.
      const foot = add(add(centre, around, r * 0.78), up, -0.05), mid = add(add(foot, around, 0.09 + random() * 0.04), up, 0.1), tip = add(add(mid, around, 0.05 + random() * 0.04), up, 0.13 + random() * 0.09), bend = flex * t * t, tone = 0.7 + random() * 0.25;
      tube(out.bark, { pts: [foot, mid, tip], rad: [0.075, 0.055, 0.03], bend: [bend, bend, bend], sway: [0, 0, 0], phase: 0 }, lod.rank === 2 ? 4 : 3, { bark: BARK.palm, tint: [0.84 * tone, 0.74 * tone, 0.62 * tone], metres: 0.8, cap: true });
    }
  }
  return { top: trunk.pts[steps], up: dirs[steps] };
}

/** Date palm: a ringed, leaning stem booted with old leaf bases, a full head of arching feather fronds, the oldest hanging dry, and strands of dates under it. */
function buildDatePalm(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 359), flex = 0.22;
  const look: PalmLook = [{ height: 8.2, lean: 0.1, radius: 0.25, fronds: 76, long: 3.8 }, { height: 6.2, lean: 0.2, radius: 0.24, fronds: 68, long: 3.6 }, { height: 10.2, lean: 0.06, radius: 0.26, fronds: 82, long: 4.0 }][variant % 3];
  const crown = palmStem(out, random, look, lod, 0.66, flex), cards: Card[] = [];
  const fronds = Math.round(look.fronds * (lod.rank === 2 ? 1 : lod.rank === 1 ? 0.6 : 0.36) * (lod.fine ? 1 : 0.62)), steps = lod.rank === 2 ? (lod.fine ? 12 : 7) : lod.rank === 1 ? 6 : 3, frond = CELLS.frond;
  // Leaflets stand off the rib in more than one plane: a shallow pair of rows and a steep one, so a frond has body from any side.
  const rows: Array<[number, number]> = lod.rank === 2 ? [[0.3, 1], [0.95, 0.8]] : lod.rank === 1 ? [[0.3, 1.1], [0.95, 0.85]] : [[0.5, 1.35]];
  for (let k = 0; k < fronds; k += 1) {
    const order = (k + 0.5) / fronds, azimuth = k * 2.39996 + random() * 0.5, rise = lerp(1.36, -1.1, Math.pow(order, 0.9)) + (random() - 0.5) * 0.14, old = order > 0.87, young = order < 0.12;
    const long = look.long * (0.82 + random() * 0.3) * (young ? 0.7 : old ? 0.85 : 1), phase = random(), roll = random(), twist0 = (random() - 0.5) * 0.5, twist1 = (random() - 0.5) * 1.6;
    const c = Math.cos(azimuth), s = Math.sin(azimuth), pts: V3[] = [add(crown.top, [c * 0.12, -0.14 + (1 - order) * 0.34, s * 0.12])], faces: V3[] = [];
    let dir: V3 = norm([c * Math.cos(rise), Math.sin(rise), s * Math.cos(rise)]);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps, across = norm(cross(dir, UP), [s, 0, -c]), flatFace = norm(cross(across, dir));
      faces.push(turn(flatFace, dir, twist0 + twist1 * (t - 1 / steps)));
      pts.push(add(pts[i - 1], dir, long / steps));
      dir = norm([dir[0], dir[1] - (young ? 0.05 : 0.17) * (0.5 + t) * (11 / steps), dir[2]]);
    }
    { const across = norm(cross(dir, UP), [s, 0, -c]); faces.push(turn(norm(cross(across, dir)), dir, twist0 + twist1)); }
    const dry: V3 = old ? [1.7, 1.05, 0.5] : young ? [1.14, 1.12, 0.84] : [1, 1, 1], bendAt = flex * 1.0;
    const sway = (t: number) => 0.42 * t * t * (old ? 0.6 : 1);
    const first = out.foliage.count, z = phased(phase, roll), wide = 0.5 * (0.9 + roll * 0.2) * (lod.rank === 0 ? 1.3 : 1), each = 1 + rows.length * 2;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps, tangent = norm(sub(pts[Math.min(steps, i + 1)], pts[Math.max(0, i - 1)])), face = faces[i], across = norm(cross(tangent, face));
      const u = (frond.x + 4 + t * (frond.w - 8)) / ATLAS;
      out.foliage.vert(pts[i], face, u, (frond.y + frond.h - 5) / ATLAS, [dry[0], dry[1], dry[2], 1], [bendAt, sway(t), z, 0]);
      for (const [fold0, span] of rows) for (const way of [-1, 1]) {
        const fold = old ? fold0 * 0.4 : fold0, cf = Math.cos(fold), sf = Math.sin(fold), shade = fold0 > 0.6 ? 0.88 : 1;
        const reach: V3 = [across[0] * way * cf + face[0] * sf, across[1] * way * cf + face[1] * sf, across[2] * way * cf + face[2] * sf];
        const normal = norm([face[0] * cf - across[0] * way * sf, face[1] * cf - across[1] * way * sf, face[2] * cf - across[2] * way * sf]);
        out.foliage.vert(add(pts[i], reach, wide * span), normal, u, (frond.y + 6) / ATLAS, [dry[0] * shade, dry[1] * shade, dry[2] * shade, 1], [bendAt, sway(t), z, way * 0.1 * t]);
      }
    }
    for (let i = 0; i < steps; i += 1) for (let r = 0; r < rows.length; r += 1) {
      const rib = first + i * each, left = rib + 1 + r * 2, right = left + 1;
      out.foliage.quad(rib, left, left + each, rib + each); out.foliage.quad(rib, rib + each, right + each, right);
    }
    cards.push({ first, count: (steps + 1) * each, centre: pts[Math.floor(steps * 0.5)], normal: faces[Math.floor(steps * 0.5)], area: long * wide * 2, group: 0 });
    if (lod.rank === 2 && lod.fine) {
      const pick = [0, 3, 6, 9, steps].filter((i, index, list) => i <= steps && list.indexOf(i) === index);
      tube(out.bark, { pts: pick.map((i) => pts[i]), rad: pick.map((i) => lerp(0.03, 0.007, i / steps)), bend: pick.map(() => bendAt), sway: pick.map((i) => sway(i / steps)), phase }, 4, { bark: BARK.palm, tint: old ? [1.1, 0.95, 0.7] : [0.95, 1.1, 0.6], metres: 1.5 });
    }
  }
  // Strands of dates arch out from under the head and hang (shown by `bloom`).
  if (lod.rank > 0) {
    const strands = lod.rank === 2 ? 7 : 4;
    for (let k = 0; k < strands; k += 1) {
      const azimuth = k / strands * TAU + random() * 0.8, c = Math.cos(azimuth), s = Math.sin(azimuth), long = 1.0 + random() * 0.5, phase = random(), pts: V3[] = [add(crown.top, [c * 0.12, -0.3, s * 0.12])];
      let dir: V3 = norm([c * 0.75, 0.5, s * 0.75]);
      for (let i = 1; i <= 5; i += 1) { pts.push(add(pts[i - 1], dir, long / 5)); dir = norm([dir[0], dir[1] - 0.45, dir[2]]); }
      const hang = (i: number) => 0.2 * Math.pow(i / 5, 2);
      tube(out.bark, { pts, rad: pts.map((_p, i) => lerp(0.022, 0.012, i / 5)), bend: pts.map(() => flex), sway: pts.map((_p, i) => hang(i)), phase }, 4, { bark: BARK.palm, tint: [1.55, 1.05, 0.42], metres: 1.2 });
      const dates = lod.rank === 2 ? 9 : 4;
      for (let n = 0; n < dates; n += 1) ball(out.foliage, [pts[5][0] + (random() - 0.5) * 0.2, pts[5][1] - 0.04 - random() * 0.5, pts[5][2] + (random() - 0.5) * 0.2], 0.05 + random() * 0.03, CELLS.fruit, [flex, hang(5), phased(phase, random()), 0], 0.75, 0.7 + random() * 0.3, lod);
    }
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.25, dark: 0.5, tints: [[1, 1, 1], [1.06, 1.04, 0.9], [0.93, 0.98, 0.98]], seed: seed + 9 });
  return out;
}

/** Fan palm: a stout stem cross-hatched with old leaf bases, and pleated fans on long stalks. */
function buildFanPalm(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 241), flex = 0.1;
  const look: PalmLook = [{ height: 3.3, lean: 0.07, radius: 0.19, fronds: 44, long: 1.05 }, { height: 2.2, lean: 0.14, radius: 0.2, fronds: 38, long: 0.95 }, { height: 4.6, lean: 0.05, radius: 0.18, fronds: 48, long: 1.1 }][variant % 3];
  const crown = palmStem(out, random, look, lod, 0.35, flex), cards: Card[] = [], fan = CELLS.fan;
  const leaves = Math.round(look.fronds * (lod.rank === 2 ? 1 : lod.rank === 1 ? 0.7 : 0.45) * (lod.fine ? 1 : 0.7)), pleats = lod.rank === 2 ? (lod.fine ? 12 : 8) : lod.rank === 1 ? 6 : 3, sweep = 4.1;
  for (let k = 0; k < leaves; k += 1) {
    const order = (k + 0.5) / leaves, azimuth = k * 2.39996 + random() * 0.5, old = order > 0.8, rise = (old ? -1.2 : lerp(1.3, -0.9, Math.pow(order / 0.8, 0.9))) + (random() - 0.5) * 0.16;
    const stalk = look.long * (0.8 + random() * 0.35), phase = random(), roll = random(), blade = (0.62 + random() * 0.14) * (lod.rank === 0 ? 1.25 : 1);
    // The oldest fans hang against the stem below the head, a petticoat.
    const c = Math.cos(azimuth), s = Math.sin(azimuth), pts: V3[] = [add(add(crown.top, [c * (old ? 0.16 : 0.08), -0.1 + (1 - order) * 0.2, s * (old ? 0.16 : 0.08)]), crown.up, old ? -Math.min(look.height * 0.3, (order - 0.8) * 4.5) : 0)];
    let dir: V3 = norm([c * Math.cos(rise), Math.sin(rise), s * Math.cos(rise)]);
    for (let i = 1; i <= 3; i += 1) { pts.push(add(pts[i - 1], dir, stalk / 3)); dir = norm([dir[0], dir[1] - 0.12, dir[2]]); }
    const sway = (t: number) => 0.16 * t * t, bendAt = flex;
    if (lod.rank > 0) tube(out.bark, { pts, rad: [0.022, 0.018, 0.015, 0.012], bend: pts.map(() => bendAt), sway: pts.map((_p, i) => sway(i / 4)), phase }, 3, { bark: BARK.palm, tint: old ? [1.05, 0.9, 0.65] : [0.9, 1.1, 0.6], metres: 1.2 });
    // The blade: a pleated dish opening from the end of the stalk, its tips hanging.
    const hub = pts[3], across = norm(cross(dir, UP), [s, 0, -c]), face = norm(cross(across, dir)), tint: V3 = old ? [1.6, 1.0, 0.5] : [1, 1, 1], first = out.foliage.count, z = phased(phase, roll);
    const hubU = (fan.x + fan.w / 2) / ATLAS, hubV = (fan.y + fan.h - 64) / ATLAS, pixels = Math.min(fan.w / 2 - 8, fan.h - 76) / ATLAS;
    const centre = out.foliage.vert(hub, face, hubU, hubV, [tint[0], tint[1], tint[2], 1], [bendAt, sway(0.75), z, 0]);
    for (let p = 0; p <= pleats; p += 1) {
      const angle = (p / pleats - 0.5) * sweep, ca = Math.cos(angle), sa = Math.sin(angle), fold = (p % 2 ? 1 : -1) * 0.025;
      for (const [r, drop] of [[0.56, 0.02 + Math.abs(sa) * 0.04], [1, 0.14 + Math.abs(sa) * 0.1]] as Array<[number, number]>) {
        const reach = blade * r, position: V3 = [hub[0] + (dir[0] * ca + across[0] * sa) * reach + face[0] * (fold * r - drop * blade), hub[1] + (dir[1] * ca + across[1] * sa) * reach + face[1] * (fold * r - drop * blade) - (r === 1 ? 0.05 * blade : 0), hub[2] + (dir[2] * ca + across[2] * sa) * reach + face[2] * (fold * r - drop * blade)];
        const normal = norm([face[0] + (dir[0] * ca + across[0] * sa) * drop * 1.6 + across[0] * fold * 6, face[1] + (dir[1] * ca + across[1] * sa) * drop * 1.6 + across[1] * fold * 6, face[2] + (dir[2] * ca + across[2] * sa) * drop * 1.6 + across[2] * fold * 6]);
        out.foliage.vert(position, normal, hubU + sa * r * pixels, hubV - ca * r * pixels, [tint[0], tint[1], tint[2], 1], [bendAt, sway(0.75 + r * 0.25), z, (p % 2 ? 1 : -1) * 0.05 * r]);
      }
    }
    for (let p = 0; p < pleats; p += 1) { const a = first + 1 + p * 2; out.foliage.tri(centre, a, a + 2); out.foliage.quad(a, a + 1, a + 3, a + 2); }
    cards.push({ first, count: 1 + (pleats + 1) * 2, centre: add(hub, dir, blade * 0.5), normal: face, area: blade * blade * 1.6, group: 0 });
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.25, dark: 0.45, tints: [[1, 1, 1], [1.06, 1.04, 0.9], [0.92, 0.98, 0.98]], seed: seed + 9 });
  return out;
}


// ---- Clipped shapes, pots, climbers and the ground --------------------------------------------------

const NO_WIND: V4 = [0, 0, 0.03, 0];

/** Turns a profile ([radius, y] from the foot up) round the y axis, mapped onto a band of the pots sheet. */
function lathe(g: Geo, profile: Array<[number, number]>, sides: number, band: Rect, o: { tint?: V3; turns?: number; x?: number; z?: number } = {}) {
  const tint = o.tint ?? [1, 1, 1], turns = o.turns ?? 1, first = g.count, lengths = [0];
  for (let i = 1; i < profile.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const total = lengths[lengths.length - 1];
  for (let i = 0; i < profile.length; i += 1) {
    const before = profile[Math.max(0, i - 1)], after = profile[Math.min(profile.length - 1, i + 1)], slope = norm([after[1] - before[1], -(after[0] - before[0]), 0], [1, 0, 0]);
    for (let k = 0; k <= sides; k += 1) {
      const a = (k % sides) / sides * TAU, c = Math.cos(a), s = Math.sin(a);
      g.vert([(o.x ?? 0) + c * profile[i][0], profile[i][1], (o.z ?? 0) + s * profile[i][0]], [c * slope[0], slope[1], s * slope[0]], k / sides * turns, (band.y + (1 - lengths[i] / total) * band.h) / POTS, [tint[0], tint[1], tint[2], 1], NO_WIND);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < profile.length - 1; i += 1) for (let k = 0; k < sides; k += 1) { const a = first + i * ring + k; g.quad(a, a + ring, a + ring + 1, a + 1); }
}

/** Soil seen from above, mapped polar so the stretch is at the middle, under the plant. `edge(angle)` shapes the rim. */
function soil(g: Geo, y: number, sides: number, edge: (angle: number) => number, o: { mound?: number; tint?: V3; x?: number; z?: number; turns?: number } = {}) {
  const band = BAND.soil, tint = o.tint ?? [1, 1, 1], first = g.count, turns = o.turns ?? 2, cx = o.x ?? 0, cz = o.z ?? 0;
  for (const ring of [0, 0.5, 1]) for (let k = 0; k <= sides; k += 1) {
    const a = (k % sides) / sides * TAU, r = edge(a) * ring, lift = (o.mound ?? 0) * (1 - ring * ring);
    g.vert([cx + Math.cos(a) * r, y + lift, cz + Math.sin(a) * r], norm([Math.cos(a) * (o.mound ?? 0) * ring, 1, Math.sin(a) * (o.mound ?? 0) * ring]), k / sides * turns, (band.y + 4 + ring * (band.h - 8)) / POTS, [tint[0], tint[1], tint[2], 1], NO_WIND);
  }
  for (let ring = 0; ring < 2; ring += 1) for (let k = 0; k < sides; k += 1) { const a = first + ring * (sides + 1) + k; g.quad(a, a + 1, a + sides + 2, a + sides + 1); }
}

/** A box with every face mapped flat into a rectangle of the pots sheet (optionally open on top). */
function slab(g: Geo, centre: V3, size: V3, rect: Rect, o: { tint?: V3; open?: boolean; yaw?: number } = {}) {
  const tint = o.tint ?? [1, 1, 1], [sx, sy, sz] = size, yaw = o.yaw ?? 0, c = Math.cos(yaw), s = Math.sin(yaw);
  const faces: Array<[V3, V3, V3, number, number]> = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], sx, sy], [[0, 0, -1], [-1, 0, 0], [0, 1, 0], sx, sy],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], sz, sy], [[-1, 0, 0], [0, 0, 1], [0, 1, 0], sz, sy],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], sx, sz], [[0, -1, 0], [1, 0, 0], [0, 0, 1], sx, sz],
  ];
  const place = (v: V3): V3 => [centre[0] + v[0] * c + v[2] * s, centre[1] + v[1], centre[2] - v[0] * s + v[2] * c], spin = (v: V3): V3 => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  // Faces share the rectangle at one scale, so the grain keeps its size on every side.
  const scale = Math.min(rect.w / Math.max(sx, sz), rect.h / Math.max(sy, Math.min(sx, sz)));
  faces.forEach(([normal, right, up, wide, tall], index) => {
    if (o.open && index === 4) return;
    const half: V3 = [normal[0] * sx / 2, normal[1] * sy / 2, normal[2] * sz / 2], first = g.count;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p: V3 = [half[0] + right[0] * u * wide / 2 + up[0] * v * tall / 2, half[1] + right[1] * u * wide / 2 + up[1] * v * tall / 2, half[2] + right[2] * u * wide / 2 + up[2] * v * tall / 2];
      g.vert(place(p), spin(normal), (rect.x + (u + 1) / 2 * Math.min(rect.w, wide * scale)) / POTS, (rect.y + (1 - (v + 1) / 2) * Math.min(rect.h, tall * scale)) / POTS, [tint[0], tint[1], tint[2], 1], NO_WIND);
    }
    g.quad(first, first + 1, first + 2, first + 3);
  });
}

type Surface = (u: number, v: number, inset: number) => { p: V3; n: V3 };

/**
 * A clipped shape (ball, cone, hedge): small-leaved sprays laid over a surface like scales, some set
 * deeper for depth, round a dark core that keeps the daylight out.
 */
function clipped(out: Grown, seed: number, lod: Lod, surface: Surface, count: number, o: { cells: Rect[]; size: [number, number]; core: [number, number]; tints?: V3[]; sway?: number; bend?: number }) {
  const random = rng(seed), pick = rng(seed + 3), cards: Card[] = [], sway = o.sway ?? 0.01;
  for (let k = 0; k < count; k += 1) {
    const u = (k * 0.61803398875 + random() * 0.05) % 1, v = (k + random()) / count, deep = k % 4 === 0, spinBy = random() * TAU, size = random(), jitter = anywhere(random), roll = random(), keep = pick() < Math.sqrt(lod.keep);
    if (!keep) continue;
    const { p, n } = surface(u, v, deep ? 0.14 : 0.02), normal = norm([n[0] + jitter[0] * 0.4, n[1] + jitter[1] * 0.4, n[2] + jitter[2] * 0.4]);
    const axis = turn(side(n), n, spinBy), long = lerp(o.size[0], o.size[1], size) * Math.pow(lod.grow, 0.6);
    card(out.foliage, cards, 0, add(p, axis, -long * 0.5), axis, normal, long, long * 0.95, o.cells[Math.floor(roll * o.cells.length)], ATLAS, { grid: lod.rank === 2 ? 1 : 0, droop: 0.08, bend: 0, sway: sway * clamp(p[1]), phase: roll, random: random(), flutter: 0.008, flip: roll > 0.5 });
  }
  const [around, rings] = o.core, core = CELLS.core;
  for (let ring = 0; ring < rings; ring += 1) for (let k = 0; k < around; k += 1) {
    const corner = (dr: number, dk: number) => { const { p, n } = surface((k + dk) / around, (ring + dr) / rings, 0.2); return out.foliage.vert(p, n, (core.x + (dk ? 0.9 : 0.1) * core.w) / ATLAS, (core.y + (dr ? 0.1 : 0.9) * core.h) / ATLAS, [0.62, 0.62, 0.62, 1], NO_WIND); };
    const a = corner(0, 0), b = corner(0, 1), c = corner(1, 1), d = corner(1, 0);
    out.foliage.quad(a, d, c, b);
  }
  finishCanopy(out.foliage, cards, 1, { bend: o.bend ?? 0.75, dark: 0.4, tints: o.tints ?? GREENS, seed: seed + 9 });
}

const ballSurface = (radius: number, y: number, squash = 1): Surface => (u, v, inset) => {
  const polar = lerp(Math.PI * 0.86, 0.02, v), a = u * TAU, n: V3 = [Math.sin(polar) * Math.cos(a), Math.cos(polar), Math.sin(polar) * Math.sin(a)], r = radius * (1 - inset);
  return { p: [n[0] * r, y + n[1] * r * squash, n[2] * r], n };
};
const coneSurface = (radius: number, height: number, foot: number): Surface => (u, v, inset) => {
  const a = u * TAU, t = Math.pow(v, 0.8), r = radius * (1 - t) * (1 - inset) + 0.02, slope = radius / height, n = norm([Math.cos(a), slope, Math.sin(a)]);
  return { p: [Math.cos(a) * r, foot + t * height * (1 - inset * 0.3), Math.sin(a) * r], n };
};
/** A hedge section `long` along x: square shoulders, flat top. */
const hedgeSurface = (long: number, tall: number, deep: number): Surface => (u, v, inset) => {
  // Round the section by distance, not by angle, so the faces are as leafy as the shoulders.
  const power = 0.3, around = tall * 2 + deep, reached = clamp(v) * around;
  const angle = reached < tall ? Math.asin(Math.pow(reached / tall, 1 / power)) : reached > tall + deep ? Math.PI - Math.asin(Math.pow((around - reached) / tall, 1 / power)) : Math.acos(Math.sign(1 - (reached - tall) / deep * 2) * Math.pow(Math.abs(1 - (reached - tall) / deep * 2), 1 / power));
  const c = Math.cos(angle), s = Math.sin(angle), sign = c < 0 ? -1 : 1;
  const z = deep / 2 * sign * Math.pow(Math.abs(c), power) * (1 - inset), y = 0.06 + (tall - 0.06) * Math.pow(s, power) * (1 - inset * 0.5);
  return { p: [(u - 0.5) * long, y, z], n: norm([0, Math.pow(s, 2 - power) / tall, sign * Math.pow(Math.abs(c), 2 - power) / (deep / 2)]) };
};

function buildClipped(kind: "boxBall" | "hedge", variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), cells = [CELLS.box];
  if (kind === "hedge") {
    const long = 1.25, tall = [0.95, 1.5, 0.55][variant % 3], deep = [0.55, 0.7, 0.45][variant % 3];
    clipped(out, seed + variant, lod, hedgeSurface(long, tall, deep), Math.round((tall * 2 + deep) * long * 115), { cells, size: [0.2, 0.3], core: [3, 5] });
    // The two ends.
    const random = rng(seed + 41), cards: Card[] = [];
    for (const way of [-1, 1]) for (let k = 0; k < Math.round(tall * deep * 75 * Math.sqrt(lod.keep)); k += 1) {
      const y = 0.1 + random() * (tall - 0.2), z = (random() - 0.5) * deep * 0.86, long2 = 0.2 + random() * 0.1, axis = turn([0, 1, 0], [1, 0, 0], random() * TAU);
      card(out.foliage, cards, 0, add([way * long / 2 * 0.98, y, z], axis, -long2 / 2), axis, [way, (random() - 0.5) * 0.5, (random() - 0.5) * 0.5], long2, long2, CELLS.box, ATLAS, { grid: 0, bend: 0, sway: 0.01, phase: random(), random: random(), flutter: 0.006 });
    }
    finishCanopy(out.foliage, cards, 1, { bend: 0.6, dark: 0.7, tints: GREENS, seed: seed + 5 });
    // The core is closed at both ends, for the last section of a run.
    const core = CELLS.core, section = hedgeSurface(long, tall, deep);
    for (const way of [-1, 1]) {
      const x = way * long * 0.47, centre = out.foliage.vert([x, tall * 0.45, 0], [way, 0, 0], (core.x + core.w / 2) / ATLAS, (core.y + core.h / 2) / ATLAS, [0.62, 0.62, 0.62, 1], NO_WIND);
      let last = -1;
      for (let i = 0; i <= 6; i += 1) {
        const { p } = section(0, i / 6, 0.2), v = out.foliage.vert([x, p[1], p[2]], [way, 0, 0], (core.x + (0.1 + 0.8 * i / 6) * core.w) / ATLAS, (core.y + 0.12 * core.h) / ATLAS, [0.62, 0.62, 0.62, 1], NO_WIND);
        if (last >= 0) out.foliage.tri(centre, last, v);
        last = v;
      }
    }
    return out;
  }
  if (variant % 3 === 1) clipped(out, seed + 1, lod, coneSurface(0.34, 1.05, 0.05), 330, { cells, size: [0.24, 0.32], core: [6, 4] });
  else if (variant % 3 === 2) clipped(out, seed + 2, lod, ballSurface(0.52, 0.2, 0.62), 380, { cells, size: [0.26, 0.34], core: [7, 4] });
  else clipped(out, seed, lod, ballSurface(0.37, 0.36), 300, { cells, size: [0.24, 0.32], core: [7, 5] });
  return out;
}

/** Hand-thrown terracotta: foot bead, tapered wall, rolled rim, and the inside down to the soil. */
function pot(out: Grown, radius: number, height: number, lod: Lod, style = 0) {
  const r = radius, h = height, sides = lod.rank === 2 ? (lod.fine ? 24 : 14) : 10;
  const profile: Array<[number, number]> = style === 1
    ? [[r * 0.55, 0], [r * 0.6, h * 0.04], [r * 0.9, h * 0.4], [r, h * 0.8], [r * 1.04, h * 0.9], [r * 1.05, h * 0.97], [r * 1.0, h], [r * 0.92, h], [r * 0.9, h * 0.9]]
    : [[r * 0.66, 0], [r * 0.7, h * 0.03], [r * 0.69, h * 0.07], [r * 0.92, h * 0.84], [r * 1.0, h * 0.86], [r * 1.03, h * 0.93], [r * 1.0, h], [r * 0.9, h], [r * 0.88, h * 0.9]];
  lathe(out.pot, profile, sides, BAND.clay, { turns: 1 });
  soil(out.pot, h * 0.9, sides, () => r * 0.89, { mound: 0.02, turns: 1 });
  return h * 0.9;
}

/** Moves everything added to `g` since vertex `from` up by `lift` (plants are grown at the origin, then set in their pot). */
const raise = (g: Geo, from: number, lift: number) => { for (let v = from; v < g.count; v += 1) g.p[v * 3 + 1] += lift; };

function buildPotLaurel(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), top = pot(out, 0.24, 0.42, lod), cells = [CELLS.citrusA, CELLS.citrusB];
  const bark = out.bark.count, leaves = out.foliage.count;
  if (variant % 3 === 0) {
    // Standard: a clear stem and a clipped ball.
    const stem: Path = { pts: [[0, -0.04, 0], [0.01, 0.3, 0.008], [-0.008, 0.62, 0], [0, 0.92, 0]], rad: [0.026, 0.021, 0.019, 0.017], bend: [0, 0.004, 0.012, 0.022], sway: [0, 0, 0, 0], phase: 0 };
    tube(out.bark, stem, sidesFor(0.03, lod), { bark: BARK.furrowed, tint: [1.05, 1, 0.9], metres: 1 });
    clipped(out, seed, lod, ballSurface(0.31, 1.02), 230, { cells, size: [0.3, 0.4], core: [6, 4], sway: 0.03 });
  } else if (variant % 3 === 1) {
    clipped(out, seed + 1, lod, coneSurface(0.3, 1.15, 0), 300, { cells, size: [0.28, 0.38], core: [6, 4], sway: 0.03 });
  } else {
    const spec = shrubSpec();
    spec.limbs[0].length = [0.72, 1.0]; spec.limbs[0].angle = [0.2, 0.6]; spec.limbs[0].gnarl = 0.1;
    buildTree(spec, seed + 2, lod, out);
  }
  raise(out.bark, bark, top); raise(out.foliage, leaves, top);
  return out;
}

function buildPotFern(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 97), top = pot(out, [0.2, 0.17, 0.26][variant % 3], [0.24, 0.3, 0.2][variant % 3], lod, 1), cards: Card[] = [];
  const fronds = Math.round([24, 18, 30][variant % 3] * (lod.rank === 2 ? 1 : 0.6) * (lod.fine ? 1 : 0.7)), steps = lod.rank === 2 ? 5 : 3;
  for (let k = 0; k < fronds; k += 1) {
    const azimuth = k * 2.39996 + random() * 0.4, rise = lerp(1.35, 0.3, Math.pow((k + 0.5) / fronds, 0.8)), long = lerp(0.42, 0.72, random()) * [1, 0.85, 1.15][variant % 3], phase = random(), roll = random();
    const c = Math.cos(azimuth), s = Math.sin(azimuth), pts: V3[] = [[c * 0.03, top, s * 0.03]], faces: V3[] = [];
    let dir: V3 = norm([c * Math.cos(rise), Math.sin(rise), s * Math.cos(rise)]);
    for (let i = 0; i <= steps; i += 1) {
      const across = norm(cross(dir, UP), [s, 0, -c]);
      faces.push(norm(cross(across, dir)));
      if (i < steps) { pts.push(add(pts[i], dir, long / steps)); dir = norm([dir[0], dir[1] - 0.42 * (5 / steps), dir[2]]); }
    }
    ribbon(out.foliage, cards, 0, pts, faces, () => long * 0.34, CELLS.fern, { lengthwise: true, columns: lod.rank === 2 ? 3 : 2, cup: 0.1, bend: () => 0, sway: (t) => 0.07 * t * t, phase, random: roll, flutter: 0.02 });
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.3, dark: 0.5, tints: GREENS, seed: seed + 9 });
  return out;
}

function buildPotAgave(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 83), top = pot(out, [0.26, 0.2, 0.3][variant % 3], [0.3, 0.34, 0.24][variant % 3], lod, variant % 3 === 2 ? 1 : 0), cards: Card[] = [];
  const blades = Math.round([22, 16, 26][variant % 3] * (lod.rank === 2 ? 1 : 0.7)), steps = lod.rank === 2 ? 6 : 3, grow = [1, 0.8, 1.15][variant % 3];
  for (let k = 0; k < blades; k += 1) {
    const order = (k + 0.5) / blades, azimuth = k * 2.39996, rise = lerp(1.4, 0.2, Math.pow(order, 0.75)), long = lerp(0.3, 0.62, Math.pow(order, 0.6)) * grow, phase = random(), roll = random();
    const c = Math.cos(azimuth), s = Math.sin(azimuth), pts: V3[] = [[c * 0.02, top - 0.02, s * 0.02]], faces: V3[] = [];
    let dir: V3 = norm([c * Math.cos(rise), Math.sin(rise), s * Math.cos(rise)]);
    for (let i = 0; i <= steps; i += 1) {
      const across = norm(cross(dir, UP), [s, 0, -c]);
      faces.push(norm(cross(across, dir)));
      if (i < steps) { pts.push(add(pts[i], dir, long / steps)); dir = norm([dir[0], dir[1] + (i < steps * 0.5 ? 0.1 : -0.16) * order * (6 / steps), dir[2]]); }
    }
    ribbon(out.foliage, cards, 0, pts, faces, () => long * 0.27, CELLS.agave, { columns: 3, cup: 0.16, bend: () => 0, sway: (t) => 0.012 * t * t, phase, random: roll, flutter: 0.002, tint: [0.95 + roll * 0.14, 1, 1] });
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.1, dark: 0.55, tints: [[1, 1, 1], [1.04, 1.02, 0.96]], seed: seed + 9 });
  return out;
}

/** A window box of geraniums: trough of clay, board or zinc, a mound of leaves, heads of flowers above and trailing over the front. */
function buildFlowerBox(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 61), long = 0.8, tall = 0.17, deep = 0.2, style = variant % 3, cards: Card[] = [];
  const skin = style === 0 ? BAND.clay : style === 1 ? BAND.wood : BAND.zinc, wall = 0.016;
  slab(out.pot, [0, tall / 2, 0], [long, tall, deep], skin, { open: true });
  for (const [x, z, sx, sz] of [[0, deep / 2 - wall / 2, long, wall], [0, -deep / 2 + wall / 2, long, wall], [long / 2 - wall / 2, 0, wall, deep], [-long / 2 + wall / 2, 0, wall, deep]]) slab(out.pot, [x, tall + 0.004, z], [sx, 0.008, sz], skin, { tint: [0.9, 0.9, 0.9] });
  { // Soil just under the rim.
    const band = BAND.soil, first = out.pot.count;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) out.pot.vert([u * (long / 2 - wall), tall - 0.02, -v * (deep / 2 - wall)], UP, (u + 1) / 2 * 0.6, (band.y + 20 + (v + 1) / 2 * 150) / POTS, [1, 1, 1, 1], NO_WIND);
    out.pot.quad(first, first + 1, first + 2, first + 3);
  }
  const plants = Math.round(16 * (lod.rank === 2 ? 1 : 0.6));
  for (let k = 0; k < plants; k += 1) {
    const x = (k + 0.5) / plants * (long - 0.1) - (long - 0.1) / 2 + (random() - 0.5) * 0.04, front = k % 3 === 0, z = front ? deep * 0.3 : (random() - 0.5) * deep * 0.5, lean = (random() - 0.5) * 0.7;
    const axis: V3 = front ? norm([lean * 0.5, 0.25 - random() * 0.5, 1]) : norm([lean, 1, (random() - 0.3) * 0.5]), size = 0.26 + random() * 0.1;
    card(out.foliage, cards, 0, [x, tall - 0.03, z], axis, front ? [lean * 0.3, 1, 0.5] : [(random() - 0.5) * 0.8, 0.15, random() < 0.8 ? 1 : -1], size, size * 0.5, CELLS.geraniumLeaf, ATLAS, { grid: lod.grid, droop: front ? 0.5 : 0.12, bend: 0, sway: 0.015, phase: random(), random: random(), flutter: 0.012, whip: 0.02, flip: random() > 0.5 });
  }
  for (let k = 0; k < Math.round(plants * 0.6); k += 1) {
    const x = (random() - 0.5) * (long - 0.12), size = 0.3 + random() * 0.1, lean = (random() - 0.5) * 0.6;
    card(out.foliage, cards, 0, [x, tall - 0.03, (random() - 0.4) * deep * 0.5], norm([lean, 1, (random() - 0.2) * 0.5]), [(random() - 0.5) * 0.6, 0.1, 1], size, size * 0.5, CELLS.geraniumFlower, ATLAS, { grid: lod.grid, droop: 0.06, bend: 0, sway: 0.02, phase: random(), random: random(), flutter: 0.012, whip: 0.03, tag: 0.75, flip: random() > 0.5 });
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.15, dark: 0.7, tints: [[1, 1, 1], [1.06, 1.04, 0.94]], seed: seed + 9 });
  return out;
}

/**
 * Wall climbers, grown in the wall's own frame: the wall is the plane z = 0 and the plant is on its
 * +z side, x along the wall, y up. Stems creep and fork; leaves overlap like shingles off them.
 */
function buildClimber(kind: "ivy" | "bougainvillea", variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 53), pick = rng(seed + 3), cards: Card[] = [], bloom = kind === "bougainvillea", shape = variant % 3;
  // 0: a fan climbing from the ground. 1: a tall column (a corner, a drainpipe). 2: a curtain hanging from the top of a wall.
  const wide = [2.4, 1.1, 2.4][shape], tall = [2.9, 3.8, 1.7][shape], hanging = shape === 2, budget = Math.round([150, 120, 130][shape] * (bloom ? 0.9 : 1));
  type Shoot = { x: number; y: number; heading: number; girth: number; left: number };
  const shoots: Shoot[] = [], starts = [3, 2, 5][shape];
  for (let k = 0; k < starts; k += 1) shoots.push(hanging ? { x: ((k + 0.5) / starts - 0.5) * wide * 0.9, y: 0, heading: Math.PI + (random() - 0.5) * 0.5, girth: 0.008, left: 8 + random() * 5 } : { x: (k - (starts - 1) / 2) * 0.16, y: 0, heading: (k - (starts - 1) / 2) * (shape ? 0.12 : 0.5) + (random() - 0.5) * 0.2, girth: 0.014, left: 14 + random() * 6 });
  let spent = 0;
  const reach = bloom ? 1 : 0.35, limit = (y: number) => wide / 2 * (hanging ? 1 : shape ? 0.6 + 0.4 * clamp(y / tall) : 0.22 + 0.78 * Math.sqrt(clamp(y / tall)));
  while (shoots.length && spent < budget) {
    const shoot = shoots.shift()!, pts: V3[] = [], rad: number[] = [], sway: number[] = [], phase = random();
    let { x, y, heading } = shoot;
    for (let step = 0; step <= shoot.left && spent < budget; step += 1) {
      spent += 1;
      const progress = hanging ? clamp(-y / tall) : clamp(y / tall), away = 0.012 + (bloom ? 0.34 * Math.sin(progress * 2.6) + random() * 0.08 : random() * 0.02), slack = hanging ? 0.05 * progress : 0.012 * progress * reach;
      pts.push([x, y, away]); rad.push(Math.max(0.0035, shoot.girth * (1 - step / (shoot.left + 2)))); sway.push(slack * (bloom ? 3 : 1));
      // Leaves off this node.
      const leaves = bloom ? 2 : 2 + (random() < 0.4 ? 1 : 0);
      for (let n = 0; n < leaves; n += 1) {
        const spread = random() * TAU, lift = random(), size = random(), tilt = anywhere(random), flower = bloom && random() < 0.42 + progress * 0.3, cellPick = random(), roll = random(), keep = pick() < Math.sqrt(lod.keep);
        if (!keep) continue;
        const long = (bloom ? lerp(0.42, 0.62, size) : lerp(0.34, 0.56, size)) * Math.pow(lod.grow, 0.6) * (step > shoot.left - 2 ? 0.7 : 1);
        const down = hanging ? 0.9 : 0.35, axis = norm([Math.sin(spread), Math.cos(spread) - down, bloom ? 0.25 : 0.02]);
        const rect = flower ? CELLS.bract : bloom ? (cellPick < 0.5 ? CELLS.citrusA : CELLS.citrusB) : CELLS.ivy;
        card(out.foliage, cards, 0, [x + (random() - 0.5) * 0.1, y + (random() - 0.5) * 0.1, away + 0.02 + lift * (bloom ? 0.16 : 0.07)], axis, [tilt[0] * 0.5, tilt[1] * 0.4 + 0.15, 1], long, long * 0.95, rect, ATLAS, {
          grid: lod.grid, droop: 0.1 + lift * 0.1, cup: 0, bend: 0, sway: slack + 0.004, phase, random: roll, flutter: bloom ? 0.016 : 0.01, whip: bloom ? 0.03 : 0.012, tag: flower ? 0.75 : 1, flip: roll > 0.5,
        });
      }
      // Onward: wander, stay inside the shape, fork now and then.
      heading += (random() - 0.5) * 0.7;
      const home = hanging ? Math.PI : 0;
      heading += (home - heading) * 0.12;
      if (Math.abs(x) > limit(Math.abs(y))) heading += (x > 0 ? 1 : -1) * (hanging ? -0.5 : 0.5) * -1;
      x += Math.sin(heading) * 0.2; y += Math.cos(heading) * 0.2;
      if (!hanging && y > tall) break;
      if (hanging && -y > tall * (0.6 + random() * 0.4)) break;
      if (random() < 0.3 && shoots.length < 14) shoots.push({ x, y, heading: heading + (random() < 0.5 ? 1 : -1) * (0.6 + random() * 0.5), girth: Math.max(0.005, shoot.girth * 0.7), left: Math.max(3, Math.round((shoot.left - step) * (0.5 + random() * 0.4))) });
    }
    if (pts.length > 1 && lod.rank > 0) tube(out.bark, { pts, rad, bend: pts.map(() => 0), sway, phase }, 3, { bark: BARK.furrowed, tint: bloom ? [1.05, 0.95, 0.8] : [0.8, 0.72, 0.62], metres: 0.9 });
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.12, dark: bloom ? 0.5 : 0.42, tints: GREENS, seed: seed + 9 });
  return out;
}

/** Grass and weeds for cracks and edges: blades lean out from their foot like a pinwheel, never crossed quads. */
function buildTuft(kind: "grass" | "weeds", variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 47), cards: Card[] = [], shape = variant % 3;
  const tuft = (x: number, z: number, tall: number, rect: Rect, blades: number, lean: number) => {
    const spinBy = random() * TAU;
    for (let k = 0; k < blades; k += 1) {
      const a = spinBy + k / blades * TAU + (random() - 0.5) * 0.5, c = Math.cos(a), s = Math.sin(a), tip = lean * (0.6 + random() * 0.8), long = tall * (0.75 + random() * 0.5);
      card(out.foliage, cards, 0, [x + c * 0.025, 0, z + s * 0.025], norm([c * tip, 1, s * tip]), [c, 0.35, s], long, long * 0.9, rect, ATLAS, { grid: lod.rank === 2 ? 1 : 0, droop: 0.12, bend: 0, sway: 0, phase: random(), random: random(), flutter: 0.014, whip: 0.07, flip: random() > 0.5 });
    }
  };
  const blades = lod.rank === 2 ? 5 : 3;
  if (kind === "grass") {
    if (shape === 0) tuft(0, 0, 0.3, CELLS.grass, blades, 0.4);
    else if (shape === 1) { tuft(0, 0, 0.5, CELLS.grass, blades + 1, 0.3); tuft(0.07, 0.05, 0.3, CELLS.grass, 3, 0.7); }
    else for (let k = 0; k < 6; k += 1) tuft((k - 2.5) * 0.17 + (random() - 0.5) * 0.08, (random() - 0.5) * 0.06, 0.2 + random() * 0.18, CELLS.grass, 3, 0.5);
  } else {
    if (shape === 0) tuft(0, 0, 0.36, CELLS.weeds, blades - 1, 0.3);
    else if (shape === 1) { tuft(0, 0, 0.2, CELLS.weeds, blades, 1.3); tuft(0.02, 0.01, 0.16, CELLS.grass, 3, 0.8); }
    else for (let k = 0; k < 5; k += 1) tuft((k - 2) * 0.19 + (random() - 0.5) * 0.08, (random() - 0.5) * 0.05, 0.14 + random() * 0.18, k % 2 ? CELLS.grass : CELLS.weeds, 3, 0.6);
  }
  finishCanopy(out.foliage, cards, 1, { bend: 0.5, dark: 0.8, tints: [[1, 1, 1], [1.1, 1.06, 0.86], [0.92, 0.98, 0.92]], seed: seed + 9 });
  return out;
}

/** What a tree stands in: a kerbed pit, a cast-iron grate, or a ring of mulch. */
function buildGround(kind: "treePit" | "treeGrate" | "soilRing", variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 43), shape = variant % 3;
  if (kind === "soilRing") {
    const radius = [0.62, 0.4, 0.9][shape], wobble = [random() * TAU, random() * TAU];
    soil(out.pot, 0.004, lod.rank === 2 ? 18 : 10, (a) => radius * (1 + 0.07 * Math.sin(a * 3 + wobble[0]) + 0.04 * Math.sin(a * 7 + wobble[1])), { mound: 0.045 });
    return out;
  }
  if (kind === "treePit") {
    const half = 0.75, kerb = 0.11;
    if (shape === 1) {
      lathe(out.pot, [[0.76, 0], [0.76, 0.085], [0.75, 0.095], [0.645, 0.095], [0.635, 0.085], [0.635, 0.02]], lod.rank === 2 ? 28 : 14, BAND.stone, { turns: 4 });
      soil(out.pot, 0.03, lod.rank === 2 ? 20 : 12, () => 0.64, { mound: 0.04 });
    } else {
      const squareEdge = (inset: number) => (a: number) => (half - inset) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      if (shape === 0) for (const [x, z, sx, sz] of [[0, half - kerb / 2, half * 2, kerb], [0, -half + kerb / 2, half * 2, kerb], [half - kerb / 2, 0, kerb, half * 2 - kerb * 2], [-half + kerb / 2, 0, kerb, half * 2 - kerb * 2]]) slab(out.pot, [x, 0.045, z], [sx, 0.09, sz], BAND.stone, { tint: [0.96 + random() * 0.08, 0.97, 0.97] });
      else for (const [x, z, sx, sz] of [[0, half - 0.008, half * 2, 0.016], [0, -half + 0.008, half * 2, 0.016], [half - 0.008, 0, 0.016, half * 2], [-half + 0.008, 0, 0.016, half * 2]]) slab(out.pot, [x, 0.02, z], [sx, 0.04, sz], BAND.zinc, { tint: [0.5, 0.5, 0.52] });
      soil(out.pot, shape === 0 ? 0.03 : 0.012, 16, squareEdge(shape === 0 ? kerb : 0.016), { mound: 0.035 });
    }
    return out;
  }
  // Grate: four quarters of one casting, slots painted in, round a hole for the trunk.
  const half = [0.75, 0.6, 0.9][shape], hole = half / 3, top = 0.024, g = out.pot, rect = BAND.grate, steps = lod.rank === 2 ? 8 : 4;
  for (const [mx, mz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const first = g.count;
    for (let k = 0; k <= steps; k += 1) {
      const a = k / steps * Math.PI / 2, c = Math.cos(a), s = Math.sin(a), far = half / Math.max(c, s);
      for (const r of [hole, far]) g.vert([mx * c * r, top, mz * s * r], UP, (rect.x + c * r / half * rect.w) / POTS, (rect.y + s * r / half * rect.h) / POTS, [1, 1, 1, 1], NO_WIND);
    }
    for (let k = 0; k < steps; k += 1) { const a = first + k * 2; if (mx * mz > 0) g.quad(a, a + 2, a + 3, a + 1); else g.quad(a, a + 1, a + 3, a + 2); }
  }
  for (const [x, z, sx, sz] of [[0, half, half * 2, 0.012], [0, -half, half * 2, 0.012], [half, 0, 0.012, half * 2], [-half, 0, 0.012, half * 2]]) slab(g, [x, top / 2, z], [sx, top, sz], BAND.zinc, { tint: [0.3, 0.3, 0.3] });
  soil(g, 0.006, 12, () => hole * 1.04, { mound: 0.01 });
  return out;
}

/** Fallen leaves: a scatter lying flat, each a sprite of the litter cell, some curled up off the ground. */
function buildLitter(variant: number, seed: number, lod: Lod): Grown {
  const out = grown(), random = rng(seed + variant * 37), shape = variant % 3, count = Math.round([56, 64, 34][shape] * (lod.rank === 2 ? 1 : 0.5) * (lod.fine ? 1 : 0.6)), g = out.foliage, sheet = CELLS.litter;
  for (let k = 0; k < count; k += 1) {
    const far = Math.pow(random(), 0.7), a = random() * TAU;
    const x = shape === 1 ? (random() - 0.5) * 2.4 : Math.cos(a) * far * (shape === 2 ? 1.8 : 1.1), z = shape === 1 ? -Math.pow(random(), 2.2) * 0.55 : Math.sin(a) * far * (shape === 2 ? 1.8 : 1.1);
    const size = 0.09 + random() * 0.08, spinBy = random() * TAU, sprite = Math.floor(random() * 8), curl = random() < 0.3 ? 0.25 + random() * 0.4 : random() * 0.1, value = 0.72 + random() * 0.4, y = 0.004 + k * 0.0003, first = g.count, z0 = phased(random(), random());
    const c = Math.cos(spinBy), s = Math.sin(spinBy), cell: Rect = { x: sheet.x + (sprite % 4) * 128 + 4, y: sheet.y + Math.floor(sprite / 4) * 128 + 4, w: 120, h: 120 };
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lift = u > 0 ? curl * size : 0;
      g.vert([x + (u * c - v * s) * size / 2, y + lift, z + (u * s + v * c) * size / 2], norm([-c * curl, 1, -s * curl]), (cell.x + (u + 1) / 2 * cell.w) / ATLAS, (cell.y + (v + 1) / 2 * cell.h) / ATLAS, [value, value, value, 1], [0, 0, z0, u > 0 ? 0.004 + curl * 0.01 : 0]);
    }
    g.quad(first, first + 3, first + 2, first + 1);
  }
  return out;
}


// ---- The library ---------------------------------------------------------------------------------

type KindSpec = {
  variants: number;
  note: string;
  /** The trunk stands in the player's way and stops bullets (trees), or the whole plant is walked through (shrubs, pots' plants). */
  trunk: boolean;
  /** Ground dressing: casts no shadow, stops nothing. */
  flat?: boolean;
  build: (variant: number, seed: number, lod: Lod) => Grown;
};

const KINDS: Record<TreeKind, KindSpec> = {
  plane: { variants: 3, trunk: true, note: "Large street tree, mottled flaking bark, lobed leaves; the stem forks at 4 m into ascending scaffolds. About 11 m tall, crown 9 m, clear stem 3 m.", build: (v, s, lod) => branching(planeSpec(), v, s, lod) },
  orange: { variants: 3, trunk: true, note: "Small round-headed orange tree with fruit (bloom sets how much). About 3.3 m tall, crown 2.4 m.", build: (v, s, lod) => branching(orangeSpec(), v, s + 101, lod, true) },
  olive: { variants: 3, trunk: true, note: "Old olive: short twisted fluted trunk, wide silver-green crown. About 4.6 m tall, 5.5 m wide.", build: (v, s, lod) => branching(oliveSpec(), v, s + 202, lod) },
  bare: { variants: 3, trunk: true, note: "Leafless winter tree: four orders of branching and fine twigs. About 8 m tall, 6 m wide.", build: (v, s, lod) => branching(bareSpec(), v, s + 303, lod) },
  cypress: { variants: 3, trunk: true, note: "Italian cypress, dark columnar flame. Variants 8.2 m, 6.6 m and 4.8 m tall, about 1.3 m wide.", build: (v, s, lod) => buildCypress(v, s + 404, lod) },
  spruce: { variants: 3, trunk: true, note: "Spruce with drooping whorled boughs; `snow` whitens it and loads the boughs. Variants 10.5 m, 7.6 m and 5.2 m.", build: (v, s, lod) => buildSpruce(v, s + 505, lod) },
  datePalm: { variants: 3, trunk: true, note: "Date palm: leaning stem latticed with leaf bases, boots under a full head of arching fronds, oldest ones dry, strands of dates (bloom). Stem 8.2 m, 6.2 m (more lean) or 10.2 m; crown 7.5 m across.", build: (v, s, lod) => buildDatePalm(v, s + 606, lod) },
  fanPalm: { variants: 3, trunk: true, note: "Fan palm: stout latticed stem, pleated fans on long stalks, a petticoat of old fans under the head. Stem 3.3 m, 2.2 m or 4.6 m; crown 3.5 m across.", build: (v, s, lod) => buildFanPalm(v, s + 707, lod) },
  shrub: { variants: 3, trunk: false, note: "Loose many-stemmed evergreen shrub, glossy leaves. About 1.4 m tall, 1.7 m wide.", build: (v, s, lod) => branching(shrubSpec(), v, s + 808, lod) },
  boxBall: { variants: 3, trunk: false, note: "Clipped box. 0: ball 0.75 m. 1: cone 1.1 m tall. 2: low cushion 1.05 m across.", build: (v, s, lod) => buildClipped("boxBall", v, s + 909, lod) },
  hedge: { variants: 3, trunk: false, note: "Clipped hedge section 1.25 m long (place end to end along x). 0: 0.95 m tall, 0.55 deep. 1: 1.5 m tall. 2: 0.55 m low border.", build: (v, s, lod) => buildClipped("hedge", v, s + 1010, lod) },
  potLaurel: { variants: 3, trunk: false, note: "Bay laurel in a terracotta pot (0.48 m across). 0: standard, ball on a stem, 1.75 m. 1: clipped cone 1.55 m. 2: loose bush 1.5 m.", build: (v, s, lod) => buildPotLaurel(v, s + 1111, lod) },
  potFern: { variants: 3, trunk: false, note: "Fern in a clay bowl, fronds arching over the rim. About 0.9 m across, 0.6 m tall.", build: (v, s, lod) => buildPotFern(v, s + 1212, lod) },
  potAgave: { variants: 3, trunk: false, note: "Agave rosette in a terracotta pot: thick glaucous toothed blades. About 0.9 m across, 0.75 m tall.", build: (v, s, lod) => buildPotAgave(v, s + 1313, lod) },
  flowerBox: { variants: 3, trunk: false, note: "Window box 0.8 x 0.17 x 0.2 m of geraniums (bloom sets the flowers). 0: clay trough. 1: boards. 2: zinc.", build: (v, s, lod) => buildFlowerBox(v, s + 1414, lod) },
  ivy: { variants: 3, trunk: false, note: "Ivy on a wall: `at` is the foot of the wall, `yaw` turns local +z to face out of it. 0: fan 2.4 x 2.9 m. 1: column 1.1 x 3.8 m. 2: curtain hanging 1.7 m down from `at`.", build: (v, s, lod) => buildClimber("ivy", v, s + 1515, lod) },
  bougainvillea: { variants: 3, trunk: false, note: "Bougainvillea on a wall, arching up to 0.5 m off it, magenta bracts (bloom). Same three shapes and frame as ivy.", build: (v, s, lod) => buildClimber("bougainvillea", v, s + 1616, lod) },
  grass: { variants: 3, trunk: false, flat: true, note: "Grass for cracks and edges. 0: tuft 0.3 m. 1: tall clump 0.5 m. 2: strip 1 m long along x.", build: (v, s, lod) => buildTuft("grass", v, s + 1717, lod) },
  weeds: { variants: 3, trunk: false, flat: true, note: "Weeds. 0: upright with flower heads 0.36 m. 1: low rosette. 2: strip 0.9 m long of weeds and grass.", build: (v, s, lod) => buildTuft("weeds", v, s + 1818, lod) },
  treePit: { variants: 3, trunk: false, flat: true, note: "Planting pit 1.5 m: soil with 0: a stone kerb, 1: a round stone ring, 2: a thin steel edge flush with paving.", build: (v, s, lod) => buildGround("treePit", v, s + 1919, lod) },
  treeGrate: { variants: 3, trunk: false, flat: true, note: "Cast-iron tree grate, slotted, with a hole for the trunk. 0: 1.5 m. 1: 1.2 m. 2: 1.8 m.", build: (v, s, lod) => buildGround("treeGrate", v, s + 2020, lod) },
  soilRing: { variants: 3, trunk: false, flat: true, note: "Mound of soil and mulch round a foot. 0: 1.25 m across. 1: 0.8 m. 2: 1.8 m.", build: (v, s, lod) => buildGround("soilRing", v, s + 2121, lod) },
  leafLitter: { variants: 3, trunk: false, flat: true, note: "Fallen leaves lying on the ground. 0: scatter 2.2 m across. 1: drift 2.4 m long against a wall on its -z side. 2: thin scatter 3.6 m.", build: (v, s, lod) => buildLitter(v, s + 2222, lod) },
};

const PARTS: TreePart[] = ["bark", "foliage", "pot"];

export function createTrees(kit: Kit, options: TreesOptions): Trees {
  const seed = options.seed ?? 1, { high } = kit, { wind } = options;
  const sun = { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() };
  /** 1 / depth of the sun's shadow volume in metres, for the light that comes through leaves; 0 when the sun is only a direction. */
  const reach = { value: 0 };
  const followSun = () => {
    let given: THREE.DirectionalLight | THREE.Vector3 | undefined;
    // A map may hand over `() => sun` before its `const sun` exists: until then the default direction stands.
    try { given = typeof options.sun === "function" ? options.sun() : options.sun; } catch { return; }
    if (!given) return;
    const source = given as THREE.DirectionalLight;
    if (source.isDirectionalLight) {
      sun.value.copy(source.position).sub(source.target.position).normalize();
      const camera = source.shadow?.camera;
      reach.value = source.castShadow && camera ? 1 / Math.max(1, camera.far - camera.near) : 0;
    } else { sun.value.copy(given as THREE.Vector3).normalize(); reach.value = 0; }
  };
  followSun();

  const materials: Partial<Record<TreePart, THREE.MeshStandardMaterial>> = {};
  const owned: Array<{ dispose: () => void }> = [], meshes: THREE.InstancedMesh[] = [];
  const own = <T extends { dispose: () => void }>(item: T) => { owned.push(item); return kit.track(item); };
  let depth: THREE.MeshDepthMaterial | null = null, distance: THREE.MeshDistanceMaterial | null = null;
  const material = (part: TreePart) => {
    const ready = materials[part];
    if (ready) return ready;
    let made: THREE.MeshStandardMaterial;
    if (part === "foliage") {
      const pixels = paintFoliage(high ? 2048 : 1024, seed);
      const map = own(foliageTexture(pixels, kit.anisotropy)), surface = own(surfaceTexture(pixels.surface, pixels.surfaceSize, pixels.surfaceSize, 0.04, kit.anisotropy));
      // HIGH: the scene pass is multisampled, so alpha goes to coverage for a soft, stable edge. PERFORMANCE: a plain cut-out.
      made = new THREE.MeshStandardMaterial({ map, normalMap: surface, side: THREE.DoubleSide, vertexColors: true, roughness: 1, metalness: 0, alphaTest: 0.5, alphaToCoverage: high, envMapIntensity: 0.5 });
      depth = own(patchTreeDepth(new THREE.MeshDepthMaterial()));
      distance = own(patchTreeDepth(new THREE.MeshDistanceMaterial()));
    } else {
      const sheet = part === "bark" ? paintBark(high ? 1 : 0.5, seed + 1) : paintPots(high ? 1 : 0.5, seed + 2);
      const textures = sheetTextures(sheet, part === "bark" ? 0.034 : 0.02, kit.anisotropy, part === "bark", part === "bark" ? 0.1 : 0.05);
      made = new THREE.MeshStandardMaterial({ map: own(textures.map), normalMap: own(textures.normal), vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
    }
    patchTreeMaterial(made, part, wind, sun, reach);
    materials[part] = own(made);
    return made;
  };

  type Built = { parts: Partial<Record<TreePart, THREE.BufferGeometry>>; info: TreeInfo };
  const built = new Map<string, Built>();
  const names = Object.keys(KINDS) as TreeKind[];
  const wrap = (kind: TreeKind, variant: number) => { const count = KINDS[kind].variants; return ((Math.round(variant) % count) + count) % count; };
  const build = (kind: TreeKind, variant: number, detail: TreeDetail): Built => {
    const key = `${kind}:${variant}:${detail}`, ready = built.get(key);
    if (ready) return ready;
    const spec = KINDS[kind], result = spec.build(variant, seed * 7919 + names.indexOf(kind) * 131, lodOf(detail, high));
    const parts: Built["parts"] = {}, counts: TreeInfo["parts"] = {}, box = new THREE.Box3();
    let triangles = 0;
    for (const part of PARTS) {
      const geo = result[part];
      if (!geo.triangles) continue;
      const geometry = own(geo.build());
      parts[part] = geometry; counts[part] = geo.triangles; triangles += geo.triangles;
      box.union(geometry.boundingBox!);
    }
    const size = box.getSize(new THREE.Vector3());
    const entry: Built = { parts, info: { kind, detail, variant, variants: spec.variants, size: [size.x, Math.max(0, box.max.y), size.z], triangles, parts: counts, note: spec.note } };
    built.set(key, entry);
    return entry;
  };

  /** Stable 0..1 from a place: gives each plant its own shape, phase and shade without the map asking. */
  const chance = (x: number, z: number, salt: number) => { const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453; return value - Math.floor(value); };

  const place = (kind: TreeKind, items: TreeItem[], o: TreePlaceOptions = {}) => {
    const spec = KINDS[kind], added: THREE.InstancedMesh[] = [];
    const groups = new Map<string, { variant: number; detail: TreeDetail; items: TreeItem[] }>();
    for (const item of items) {
      const detail = item.detail ?? o.detail ?? "hero";
      const variant = wrap(kind, item.variant ?? Math.floor(chance(item.at[0], item.at[2], 1) * spec.variants));
      const key = `${variant}:${detail}`, group = groups.get(key) ?? { variant, detail, items: [] };
      group.items.push(item); groups.set(key, group);
    }
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), turnQ = new THREE.Quaternion(), tiltQ = new THREE.Quaternion(), axis = new THREE.Vector3(), colour = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0);
    for (const group of groups.values()) {
      const entry = build(kind, group.variant, group.detail);
      for (const part of PARTS) {
        const source = entry.parts[part];
        if (!source) continue;
        // The mesh data is shared; each placement owns only its per-instance variation.
        const geometry = new THREE.BufferGeometry();
        for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.attributes[name]);
        geometry.setIndex(source.index);
        geometry.boundingBox = source.boundingBox; geometry.boundingSphere = source.boundingSphere;
        const vary = new Float32Array(group.items.length * 4);
        geometry.setAttribute("treeVary", new THREE.InstancedBufferAttribute(vary, 4));
        const stands = part === "pot" ? !spec.flat : part === "bark" ? spec.trunk || o.solid === true : o.solid === true;
        const mesh = kit.instances(geometry, material(part), group.items.map((item) => ({ position: item.at })), stands && part !== "foliage" && (o.hit ?? true), (o.shadow ?? !spec.flat) && !(kind === "leafLitter"));
        group.items.forEach((item, index) => {
          const size = item.scale ?? 1, yaw = item.yaw ?? 0, lean = item.lean ?? 0;
          const leanX = typeof lean === "number" ? Math.cos(yaw) * lean : lean[0], leanZ = typeof lean === "number" ? -Math.sin(yaw) * lean : lean[1], tilt = Math.hypot(leanX, leanZ);
          turnQ.setFromAxisAngle(Y, yaw);
          if (tilt > 1e-5) { tiltQ.setFromAxisAngle(axis.set(leanZ, 0, -leanX).normalize(), tilt); turnQ.premultiply(tiltQ); }
          if (typeof size === "number") scale.setScalar(size); else scale.set(size[0], size[1], size[2]);
          mesh.setMatrixAt(index, matrix.compose(position.set(item.at[0], item.at[1], item.at[2]), turnQ, scale));
          const shade = 0.93 + chance(item.at[0], item.at[2], 2) * 0.14;
          colour.set(item.tint ?? 0xffffff).multiplyScalar(shade);
          mesh.setColorAt(index, colour);
          vary[index * 4] = chance(item.at[0], item.at[2], 3); vary[index * 4 + 1] = clamp(item.dry ?? 0); vary[index * 4 + 2] = clamp(item.snow ?? 0); vary[index * 4 + 3] = clamp(item.bloom ?? 1);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();
        mesh.name = `tree:${kind}:${part}:${group.variant}:${group.detail}`;
        if (part === "foliage") { mesh.customDepthMaterial = depth!; mesh.customDistanceMaterial = distance!; }
        if (!stands) mesh.userData.walkThrough = true;
        owned.push(geometry);
        meshes.push(mesh); added.push(mesh);
      }
    }
    return added;
  };

  const update = (now: number) => { wind.update(now); followSun(); };
  // The map's frame loop drives the wind and keeps the sun followed; calling update() by hand as well does no harm.
  kit.updates.push(update);
  return {
    kinds: names,
    get: (kind, detail = "hero", variant = 0) => build(kind, wrap(kind, variant), detail).info,
    place,
    update,
    dispose() {
      const at = kit.updates.indexOf(update);
      if (at >= 0) kit.updates.splice(at, 1);
      for (const mesh of meshes) mesh.removeFromParent();
      for (const item of owned) item.dispose();
      meshes.length = 0; owned.length = 0; built.clear();
      materials.bark = materials.foliage = materials.pot = undefined;
    },
  };
}

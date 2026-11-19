import * as THREE from "three";
import type { Kit, Transform } from "./kit";

// Shared small props for every range map: bottles, jars, produce, casks, drums, crates,
// cartons, sacks and baskets, built once per map from a handful of shared PBR materials.
//
//   const props = createProps(kit);                       // nothing is generated yet
//
//   // 1. High level: one call per kind, instanced through the kit (shadows, hit list, disposal).
//   props.place("drum", [{ position: [8.4, 0, -6.4], rotation: [0, 1.3, 0] }, { position: [8.9, 0, -5.8] }]);
//   props.place("crateLarge", spots.map((position) => ({ position })), { tint: 0xc9a878 });
//   props.place("bottleWine", [{ position: [x, shelfY, z], variant: 1 }], { seed: 7 });
//
//   // 2. Heaps: containers filled in one call, or things settled onto any surface.
//   props.fill("basket", [{ position: [2, 0, -3] }, { position: [2.6, 0, -3.2] }], ["orange", "lemon"], { count: 40 });
//   props.heap("watermelon", { at: [4, tableTop, -3], size: [1.2, 0.6], count: 9 });
//
//   // 3. Low level, for maps that merge or instance by themselves.
//   const { parts, size } = props.get("cask");            // parts[i].geometry / .material, size in metres
//
// Conventions
//   - Every prop stands on y = 0 with its origin at the middle of its footprint and faces +z
//     (labels, stencils and prints look toward +z). Sizes are metres.
//   - `tint` is the main colour of a kind (glass, paint, glaze, skin, timber stain) and `tint2`
//     the second one where there is one (liquid, contents, hoops). Both default to a palette.
//   - `variant` picks a label, stencil, print or skin from the atlas; left out, it is drawn
//     from the seed. Variants never change the silhouette.
//   - Geometries are indexed and carry position, normal, uv, decalUv and an RGBA colour, so any
//     two of them merge. Materials are shared and patched: per-instance tint comes from
//     `instanceColor`, per-instance atlas cell from the instanced `propShift` attribute, so use
//     them on an InstancedMesh (or accept white tint and variant 0 on a plain Mesh).
//   - Small things (bottles, jars, fruit) receive shadows only and are not bullet-stops by
//     default; the rest cast, receive and stop bullets. Override per batch with `shadow` / `hit`.
//   - Glass is a blended shell over an opaque liquid or contents mesh: no transmission pass.
//   - Everything is deterministic from the seed and lazy: a kind costs nothing until first used,
//     and whatever it creates is registered with the kit and disposed with the map.

export type PropKind =
  | "bottleWine" | "bottleBeer" | "bottleSpirits" | "bottleSoda" | "bottleSauce"
  | "jar" | "tin" | "jarCeramic" | "crock" | "amphora" | "urn"
  | "orange" | "lemon" | "apple" | "pomegranate" | "melon" | "watermelon" | "bananas" | "tomato" | "pepper" | "onion" | "garlic" | "grapes"
  | "cask" | "drum" | "drumPlastic" | "keg"
  | "crateSlat" | "crateLarge" | "crateSmall" | "crateProduce" | "crateAmmo" | "cratePlastic" | "pallet"
  | "carton" | "cartonSmall" | "cartonLarge" | "cartonFlat" | "cartonTall" | "cartonOpen" | "cartonCrushed"
  | "sack" | "sackLying" | "sackOpen" | "basket" | "basketTray";

/** One drawable piece of a prop: the kit instances each part as its own batch. */
export type PropPart = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Which tint the part takes: 0 = `tint`, 1 = `tint2`, -1 = none. */
  slot: 0 | 1 | -1;
  /** Glass shells and the like never cast shadows. */
  cast: boolean;
  /** Per-instance atlas shift for a variant: [base u, base v, decal u, decal v]. */
  shift: (variant: number, random: () => number) => [number, number, number, number];
};

export type PropInfo = {
  kind: PropKind;
  /** Bounding size in metres: width (x), height (y), depth (z). */
  size: [number, number, number];
  /** Triangles in one instance, all parts together. */
  triangles: number;
  parts: PropPart[];
  /** Number of label / stencil / skin variants. */
  variants: number;
  /** Default tints by variant (or drawn from, where a kind has a single variant). */
  palette: number[];
  palette2: number[];
  /** "small" props receive shadows only and are left out of the hit list unless asked. */
  scale: "small" | "medium" | "large";
  /** Radius used when heaping, and how the thing likes to lie. */
  radius: number;
  rest: "any" | "flat" | "up";
  /** Containers only (baskets, trays, open crates and cartons): the room `fill` heaps into. */
  inside?: Room;
};

/** The hollow of a container in its own space: floor height, round or rectangular footprint at the floor, wall height above the floor and how much the walls open out per metre of height. */
export type Room = { floor: number; radius?: number; size?: [number, number]; rim: number; flare: number };

export type PropItem = Transform & { tint?: THREE.ColorRepresentation; tint2?: THREE.ColorRepresentation; variant?: number };

export type PlaceOptions = {
  seed?: number;
  /** One colour for the batch, or a list cycled over the items. */
  tint?: THREE.ColorRepresentation | THREE.ColorRepresentation[];
  tint2?: THREE.ColorRepresentation | THREE.ColorRepresentation[];
  variant?: number;
  /** 0..1 natural colour variation between instances (default 0.5; 0 turns it off). */
  vary?: number;
  shadow?: boolean;
  hit?: boolean;
};

export type HeapOptions = {
  /** Middle of the surface the heap rests on (the basket floor, the tray bottom, the table top). */
  at: [number, number, number];
  /** Round footprint, or `size` for a rectangular one (x, z). */
  radius?: number;
  size?: [number, number];
  yaw?: number;
  /** Height of the container wall above `at`; 0 or left out for an open pile on a table. */
  rim?: number;
  /** How much the container opens out per metre of height (a basket's sloping wall). */
  flare?: number;
  count: number;
  /** Scale of every item, and its variation. */
  scale?: number;
  jitter?: number;
  seed?: number;
  /** False returns the settled items without placing them. */
  place?: boolean;
} & Pick<PlaceOptions, "tint" | "tint2" | "variant" | "vary" | "shadow" | "hit">;

export type FillOptions = {
  /** Items per container. */
  count: number;
  scale?: number;
  jitter?: number;
  seed?: number;
  /** Options for the containers themselves (tint, variant, shadow, hit). */
  container?: PlaceOptions;
} & Pick<PlaceOptions, "tint" | "tint2" | "variant" | "vary" | "shadow" | "hit">;

export type Props = {
  /** Geometry, material and size of a kind, generated on first use. */
  get: (kind: PropKind) => PropInfo;
  /** Instances a kind at the given transforms; returns one InstancedMesh per part. */
  place: (kind: PropKind, items: PropItem[], options?: PlaceOptions) => THREE.InstancedMesh[];
  /** Settles `count` items of the given kinds into a container or onto a surface. */
  heap: (kinds: PropKind | PropKind[], options: HeapOptions) => { items: Array<PropItem & { kind: PropKind }>; meshes: THREE.InstancedMesh[] };
  /** Places upright containers of one kind and settles `count` items into each: one batch per kind for all of them. */
  fill: (container: PropKind, where: PropItem[], kinds: PropKind | PropKind[], options: FillOptions) => { items: Array<PropItem & { kind: PropKind }>; meshes: THREE.InstancedMesh[] };
  kinds: PropKind[];
};

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

type V3 = [number, number, number];
type RGBA = [number, number, number, number];
/** Texture rectangle: u0, v0 (bottom), u1, v1 (top). */
type Rect = [number, number, number, number];

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

function rng(seed: number) {
  let state = (seed | 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise summed over octaves, n × n, 0..1. */
function fbmTable(n: number, cells: number, octaves: number, seed: number, gain = 0.5) {
  const out = new Float32Array(n * n), next = rng(seed);
  let amplitude = 1, total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const c = Math.min(n, cells << octave), lattice = new Float32Array(c * c);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = next();
    for (let y = 0; y < n; y += 1) {
      const fy = (y / n) * c, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty), r0 = (iy % c) * c, r1 = ((iy + 1) % c) * c;
      for (let x = 0; x < n; x += 1) {
        const fx = (x / n) * c, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx), x0 = ix % c, x1 = (ix + 1) % c;
        const top = lattice[r0 + x0] + (lattice[r0 + x1] - lattice[r0 + x0]) * sx, bottom = lattice[r1 + x0] + (lattice[r1 + x1] - lattice[r1 + x0]) * sx;
        out[y * n + x] += (top + (bottom - top) * sy) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= gain;
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry toolkit
// ---------------------------------------------------------------------------------------------

/** decalUv of a vertex without a decal: far enough below zero that a bevel shared with a decalled face shows none of it. */
const NONE = -1000;

/** Growing indexed mesh with the attribute set every prop shares. */
class Geo {
  private readonly p: number[] = [];
  private readonly n: number[] = [];
  private readonly t: number[] = [];
  private readonly d: number[] = [];
  private readonly c: number[] = [];
  private readonly i: number[] = [];
  /** Colour given to new vertices: rgb shades the surface, alpha is the material's extra (wear, thickness, liquid). */
  shade: RGBA = [1, 1, 1, 1];

  get count() { return this.p.length / 3; }
  get triangles() { return this.i.length / 3; }

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, du = NONE, dv = NONE, colour?: RGBA) {
    const c = colour ?? this.shade;
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, v); this.d.push(du, dv);
    this.c.push(Math.round(clamp01(c[0]) * 255), Math.round(clamp01(c[1]) * 255), Math.round(clamp01(c[2]) * 255), Math.round(clamp01(c[3]) * 255));
    return this.p.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.i.push(a, b, c, a, c, d); }

  /** Triangle wound so it faces away from `from`. */
  triOut(a: number, b: number, c: number, from: V3) {
    const p = this.p, ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az, vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const facing = (uy * vz - uz * vy) * (ax - from[0]) + (uz * vx - ux * vz) * (ay - from[1]) + (ux * vy - uy * vx) * (az - from[2]);
    if (facing >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }

  /** Moves every vertex from `from` on by a matrix. */
  xf(from: number, matrix: THREE.Matrix4) {
    const e = matrix.elements, normal = new THREE.Matrix3().getNormalMatrix(matrix).elements;
    for (let k = from * 3; k < this.p.length; k += 3) {
      const x = this.p[k], y = this.p[k + 1], z = this.p[k + 2];
      this.p[k] = e[0] * x + e[4] * y + e[8] * z + e[12]; this.p[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; this.p[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const nx = this.n[k], ny = this.n[k + 1], nz = this.n[k + 2];
      const ox = normal[0] * nx + normal[3] * ny + normal[6] * nz, oy = normal[1] * nx + normal[4] * ny + normal[7] * nz, oz = normal[2] * nx + normal[5] * ny + normal[8] * nz;
      const inverse = 1 / (Math.hypot(ox, oy, oz) || 1);
      this.n[k] = ox * inverse; this.n[k + 1] = oy * inverse; this.n[k + 2] = oz * inverse;
    }
    return this;
  }

  /** Shorthand for a rigid move of everything added since `from`. */
  move(from: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) {
    return this.xf(from, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s)));
  }

  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.p), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.n), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.t), 2));
    geometry.setAttribute("decalUv", new THREE.BufferAttribute(new Float32Array(this.d), 2));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(this.c), 4, true));
    geometry.setIndex(this.count > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.i), 1) : new THREE.BufferAttribute(new Uint16Array(this.i), 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

type ProfilePoint = [number, number] | [number, number, number];

/** A patch of a turned surface that takes a decal, is left open, or is all that is built. */
type LatheWindow = {
  /** Middle of the patch and its width, in turns (0.25 faces +z). */
  at: number; span: number;
  y0: number; y1: number;
  rect?: Rect;
  /** A decal that does not change with the variant. */
  fixed?: boolean;
  hole?: boolean;
  /** Tiles the decal this many times across the span. */
  repeat?: number;
};

type LatheOptions = {
  segs: number;
  uv: Rect;
  /** Repeats the cell this many times round (atlas cells: seams are split so nothing bleeds). */
  wrap?: number;
  /** Maps uv from above instead: this radius reaches the edge of the cell. */
  planar?: number;
  /** Moves a point of the surface; `out` arrives as the plain turned position. */
  shape?: (theta: number, r: number, y: number, out: V3) => void;
  /** `tile` is the repeat the vertex belongs to and `across` its place in it, 0..1. */
  colour?: (theta: number, y: number, r: number, tile: number, across: number) => RGBA | undefined;
  /** Own uv per repeat (staves, each with its board): `t` runs 0..1 along the profile. */
  uvOf?: (tile: number, across: number, t: number) => [number, number];
  /** Turn fraction of each segment boundary, for uneven spacing (narrow bevels between wide faces). */
  spacing?: (s: number) => number;
  /** Repeats meet at a hard edge instead of a smooth one. */
  facet?: boolean;
  windows?: LatheWindow[];
  /** Build the windows alone (a label that sits in a hole of the glass). */
  only?: boolean;
  /** With `only`: stretch the cell over the window instead of the whole turn. */
  fit?: boolean;
  inward?: boolean;
  /** Points of the profile on the axis stay there under `shape`, so no triangles are spent on them. */
  poles?: boolean;
  /** Profile corners sharper than this (radians) are hard edges. */
  crease?: number;
  phase?: number;
};

/** Turns a profile (radius, height) about the y axis. Listed bottom to top along the outside it faces outward. */
function lathe(g: Geo, profile: ProfilePoint[], o: LatheOptions) {
  const segs = o.segs, wrap = o.wrap ?? 1, [u0, v0, u1, v1] = o.uv, phase = o.phase ?? 0, flip = o.inward ? -1 : 1;
  const pts = profile.map(([r, y, hard]) => ({ r, y, hard: hard === 1, cut: false }));
  const windows = o.windows ?? [], poles = o.poles ?? !o.shape;
  for (const w of windows) for (const y of [w.y0, w.y1]) {
    for (let k = 0; k < pts.length - 1; k += 1) {
      const a = pts[k], b = pts[k + 1];
      if (Math.abs(a.y - y) < 1e-6) { a.cut = true; break; }
      if (Math.abs(b.y - y) < 1e-6) { b.cut = true; break; }
      if ((a.y - y) * (b.y - y) < 0) { const t = (y - a.y) / (b.y - a.y); pts.splice(k + 1, 0, { r: lerp(a.r, b.r, t), y, hard: false, cut: true }); break; }
    }
  }
  const count = pts.length, along = new Float32Array(count);
  for (let k = 1; k < count; k += 1) along[k] = along[k - 1] + Math.hypot(pts[k].r - pts[k - 1].r, pts[k].y - pts[k - 1].y);
  const length = along[count - 1] || 1, crease = Math.cos(o.crease ?? 0.6);
  for (let k = 1; k < count - 1; k += 1) {
    const ax = pts[k].r - pts[k - 1].r, ay = pts[k].y - pts[k - 1].y, bx = pts[k + 1].r - pts[k].r, by = pts[k + 1].y - pts[k].y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < crease) pts[k].hard = true;
  }
  // Rows break at hard edges and at window borders; columns at cell repeats and window sides.
  const rowBreaks = [0];
  for (let k = 1; k < count - 1; k += 1) if (pts[k].hard || pts[k].cut) rowBreaks.push(k);
  rowBreaks.push(count - 1);
  const cols = windows.map((w) => {
    let s0 = Math.round((w.at - w.span / 2) * segs), s1 = Math.round((w.at + w.span / 2) * segs);
    while (s0 < 0) { s0 += segs; s1 += segs; }
    while (s1 > segs) { s0 -= segs; s1 -= segs; }
    return [Math.max(0, s0), Math.max(1, s1)] as [number, number];
  });
  const colBreaks = new Set<number>([0, segs]);
  for (let j = 1; j < wrap; j += 1) colBreaks.add(Math.round((j * segs) / wrap));
  cols.forEach(([s0, s1], index) => {
    colBreaks.add(s0); colBreaks.add(s1);
    const repeat = windows[index].repeat ?? 1;
    for (let j = 1; j < repeat; j += 1) colBreaks.add(Math.round(s0 + ((s1 - s0) * j) / repeat));
  });
  const columns = [...colBreaks].sort((a, b) => a - b);

  const turnOf = (s: number) => (o.spacing ? o.spacing(s) : s / segs);
  const a: V3 = [0, 0, 0], b: V3 = [0, 0, 0], c: V3 = [0, 0, 0];
  const point = (k: number, theta: number, out: V3) => {
    const r = pts[k].r, y = pts[k].y;
    out[0] = r * Math.cos(theta); out[1] = y; out[2] = r * Math.sin(theta);
    if (o.shape) o.shape(theta, r, y, out);
  };
  const EPS = 1e-3;
  for (let rb = 0; rb < rowBreaks.length - 1; rb += 1) {
    const k0 = rowBreaks[rb], k1 = rowBreaks[rb + 1];
    // The smooth run this block belongs to, for normals that carry across soft cuts.
    let lo = k0, hi = k1;
    while (lo > 0 && !pts[lo].hard) lo -= 1;
    while (hi < count - 1 && !pts[hi].hard) hi += 1;
    const yMid = (pts[k0].y + pts[k1].y) / 2;
    for (let cb = 0; cb < columns.length - 1; cb += 1) {
      const c0 = columns[cb], c1 = columns[cb + 1];
      const hit = windows.findIndex((w, index) => c0 >= cols[index][0] && c1 <= cols[index][1] && yMid > Math.min(w.y0, w.y1) && yMid < Math.max(w.y0, w.y1));
      const w = hit >= 0 ? windows[hit] : null;
      if ((o.only && !w) || w?.hole) continue;
      const span = c1 - c0 + 1, base = g.count, tile = segs / wrap, tileIndex = Math.min(wrap - 1, Math.floor((c0 + 0.5) / tile));
      const tileFrom = turnOf(Math.round(tileIndex * tile)), tileTo = turnOf(Math.round((tileIndex + 1) * tile));
      for (let k = k0; k <= k1; k += 1) {
        for (let s = c0; s <= c1; s += 1) {
          const turn = turnOf(s), theta = phase + turn * TAU, across = wrap > 1 ? (turn - tileFrom) / (tileTo - tileFrom) : turn;
          point(k, theta, a);
          point(Math.min(k + 1, hi), theta, b); point(Math.max(k - 1, lo), theta, c);
          const px = b[0] - c[0], py = b[1] - c[1], pz = b[2] - c[2];
          point(k, theta + (o.facet && s === c1 ? 0 : EPS), b); point(k, theta - (o.facet && s === c0 ? 0 : EPS), c);
          let tx = b[0] - c[0], ty = b[1] - c[1], tz = b[2] - c[2];
          if (tx * tx + ty * ty + tz * tz < 1e-16) { tx = -Math.sin(theta); ty = 0; tz = Math.cos(theta); }
          let nx = py * tz - pz * ty, ny = pz * tx - px * tz, nz = px * ty - py * tx;
          const size = Math.hypot(nx, ny, nz);
          if (size < 1e-12) { nx = 0; ny = 1; nz = 0; } else { nx /= size; ny /= size; nz /= size; }
          const t = along[k] / length;
          let u: number, v: number;
          if (o.planar) { u = (u0 + u1) / 2 + (a[0] / o.planar) * (u1 - u0) * 0.5; v = (v0 + v1) / 2 - (a[2] / o.planar) * (v1 - v0) * 0.5; }
          else if (o.only && o.fit && w) { const cell = w.rect ?? o.uv; u = lerp(cell[2], cell[0], (s - cols[hit][0]) / (cols[hit][1] - cols[hit][0])); v = lerp(cell[1], cell[3], (pts[k].y - w.y0) / (w.y1 - w.y0)); }
          else if (o.uvOf) [u, v] = o.uvOf(tileIndex, across, t);
          else { u = lerp(u0, u1, across); v = lerp(v0, v1, t); }
          let du = NONE, dv = NONE;
          if (w?.rect && !o.fit) {
            const repeat = w.repeat ?? 1, across = ((s - cols[hit][0]) / (cols[hit][1] - cols[hit][0])) * repeat;
            const cell = Math.min(repeat - 1, Math.floor(((c0 + c1) / 2 - cols[hit][0]) / (cols[hit][1] - cols[hit][0]) * repeat));
            du = lerp(w.rect[2], w.rect[0], across - cell) + (w.fixed ? 2 : 0);
            dv = lerp(w.rect[1], w.rect[3], (pts[k].y - w.y0) / (w.y1 - w.y0));
          }
          g.v(a[0], a[1], a[2], nx * flip, ny * flip, nz * flip, u, v, du, dv, o.colour?.(theta, pts[k].y, pts[k].r, tileIndex, across));
        }
      }
      for (let k = k0; k < k1; k += 1) {
        for (let s = 0; s < span - 1; s += 1) {
          const p0 = base + (k - k0) * span + s, p1 = p0 + span;
          const lowPole = pts[k].r === 0 && poles, highPole = pts[k + 1].r === 0 && poles;
          if (!lowPole) { if (flip > 0) g.tri(p0, p1, p0 + 1); else g.tri(p0, p0 + 1, p1); }
          if (!highPole) { if (flip > 0) g.tri(p1, p1 + 1, p0 + 1); else g.tri(p1, p0 + 1, p1 + 1); }
        }
      }
    }
  }
}

/** Profile of a rounded body standing on y = 0: `power` below one squares it, `top` and `bottom` sink a hollow at the poles. */
function ovoid(r: number, h: number, rows: number, o: { power?: number; top?: number; bottom?: number; hollow?: number } = {}): ProfilePoint[] {
  const out: ProfilePoint[] = [], power = o.power ?? 1, wide = (o.hollow ?? 0.4) * r;
  for (let k = 0; k <= rows; k += 1) {
    const phi = -Math.PI / 2 + (Math.PI * k) / rows, radius = k === 0 || k === rows ? 0 : r * Math.cos(phi) ** power, fall = Math.exp(-((radius / wide) ** 2));
    out.push([radius, h / 2 + (h / 2) * Math.sin(phi) - (phi > 0 ? (o.top ?? 0) : -(o.bottom ?? 0)) * fall]);
  }
  return out;
}

/** The six faces of a box as seen from outside: normal, and the directions that read as right and up. */
const FACES: Array<{ n: V3; r: V3; u: V3 }> = [
  { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
];
const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const axisOf = (v: V3) => (v[0] !== 0 ? 0 : v[1] !== 0 ? 1 : 2);

type BoxOptions = {
  bevel?: number;
  /** Faces to leave out (PX | NX | PY | NY | PZ | NZ). */
  skip?: number;
  /** uv of a point of face `f`, given its offsets (metres) along the face's right and up. */
  uv: (f: number, a: number, b: number) => [number, number];
  /** `mid` is the middle (along right) of the piece of face being built, to decide whether it lies in a window. */
  decal?: (f: number, a: number, b: number, mid: number) => [number, number] | null;
  /** Splits a face along its right axis at these offsets, so a decal can cover part of it. */
  cuts?: (f: number) => number[] | null | undefined;
};

/** Box with softened edges for the price of 24 vertices: the bevel strips reuse the face corners. */
function bevelBox(g: Geo, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: BoxOptions) {
  const half: V3 = [sx / 2, sy / 2, sz / 2], bevel = Math.min(o.bevel ?? 0, sx * 0.45, sy * 0.45, sz * 0.45), skip = o.skip ?? 0;
  const ids: number[][] = [];
  FACES.forEach((face, f) => {
    const hn = Math.abs(dot3(face.n, half)), ha = Math.abs(dot3(face.r, half)) - bevel, hb = Math.abs(dot3(face.u, half)) - bevel;
    const corner: number[] = [];
    const cut = o.cuts?.(f) ?? null;
    const vertex = (pa: number, pb: number, mid: number, plain: boolean) => {
      const uv = o.uv(f, pa, pb), decal = plain ? null : o.decal?.(f, pa, pb, mid) ?? null;
      return g.v(cx + face.n[0] * hn + face.r[0] * pa + face.u[0] * pb, cy + face.n[1] * hn + face.r[1] * pa + face.u[1] * pb, cz + face.n[2] * hn + face.r[2] * pa + face.u[2] * pb,
        face.n[0], face.n[1], face.n[2], uv[0], uv[1], decal ? decal[0] : NONE, decal ? decal[1] : NONE);
    };
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corner.push(vertex(sa * ha, sb * hb, 0, !!cut));
    ids.push(corner);
    if (skip & (1 << f)) return;
    if (!cut) { g.quad(corner[0], corner[1], corner[2], corner[3]); return; }
    const edges = [-ha, ...cut.filter((value) => value > -ha + 1e-5 && value < ha - 1e-5).sort((x, y) => x - y), ha];
    for (let i = 0; i < edges.length - 1; i += 1) {
      const mid = (edges[i] + edges[i + 1]) / 2;
      g.quad(vertex(edges[i], -hb, mid, false), vertex(edges[i + 1], -hb, mid, false), vertex(edges[i + 1], hb, mid, false), vertex(edges[i], hb, mid, false));
    }
  });
  if (bevel <= 0) return;
  // Each face corner sits at a sign triple; edges join two faces, corners three.
  const centre: V3 = [cx, cy, cz];
  const at = (f: number, sign: V3) => {
    const face = FACES[f], sa = dot3(face.r, sign) > 0 ? 1 : 0, sb = dot3(face.u, sign) > 0 ? 1 : 0;
    return ids[f][sb ? (sa ? 2 : 3) : (sa ? 1 : 0)];
  };
  const faceOf = (axis: number, sign: number) => axis * 2 + (sign > 0 ? 0 : 1);
  for (let axis = 0; axis < 3; axis += 1) {
    const p = (axis + 1) % 3, q = (axis + 2) % 3;
    for (const sp of [-1, 1]) for (const sq of [-1, 1]) {
      const fp = faceOf(p, sp), fq = faceOf(q, sq);
      if ((skip & (1 << fp)) && (skip & (1 << fq))) continue;
      const lowSign: V3 = [0, 0, 0], highSign: V3 = [0, 0, 0];
      lowSign[axis] = -1; highSign[axis] = 1; lowSign[p] = highSign[p] = sp; lowSign[q] = highSign[q] = sq;
      const a = at(fp, lowSign), b = at(fp, highSign), c = at(fq, highSign), d = at(fq, lowSign);
      g.triOut(a, b, c, centre); g.triOut(a, c, d, centre);
    }
  }
  for (const sx1 of [-1, 1]) for (const sy1 of [-1, 1]) for (const sz1 of [-1, 1]) {
    const sign: V3 = [sx1, sy1, sz1];
    g.triOut(at(faceOf(0, sx1), sign), at(faceOf(1, sy1), sign), at(faceOf(2, sz1), sign), centre);
  }
}

/** `turn` lays the cell on its side: its u runs up the face. */
type SoftWindow = { face: number; a0: number; b0: number; a1: number; b1: number; rect: Rect; fixed?: boolean; turn?: boolean };

type SoftBoxOptions = {
  radius: number;
  /** Subdivisions of each rounded edge, and extra ones across the flat of each axis. */
  round?: number;
  cuts?: V3;
  uv: (f: number, a: number, b: number) => [number, number];
  windows?: SoftWindow[];
  /** Deforms a point in place after rounding. */
  warp?: (p: V3) => void;
  colour?: (p: V3, f: number) => RGBA | undefined;
  skip?: number;
  /** Extra grid lines at these x, y and z, for creases the warp folds along. */
  borders?: [number[], number[], number[]];
  /** Signed distance of an unwarped point to a fold plane: quads the fold crosses are split along it and shaded hard. */
  ridge?: (p: V3) => number;
};

/** Rounded, deformable box centred on the origin; its faces are cut where decal windows start and end. */
function softBox(g: Geo, sx: number, sy: number, sz: number, o: SoftBoxOptions) {
  const half: V3 = [sx / 2, sy / 2, sz / 2], radius = Math.min(o.radius, sx / 2, sy / 2, sz / 2), round = o.round ?? 1, cuts = o.cuts ?? [1, 1, 1];
  const p: V3 = [0, 0, 0], q: V3 = [0, 0, 0], r: V3 = [0, 0, 0];
  const surface = (f: number, pa: number, pb: number, out: V3, raw = false) => {
    const face = FACES[f], hn = Math.abs(dot3(face.n, half));
    let length = 0;
    for (let k = 0; k < 3; k += 1) {
      const value = face.n[k] * hn + face.r[k] * pa + face.u[k] * pb, inner = Math.max(-(half[k] - radius), Math.min(half[k] - radius, value));
      out[k] = inner; q[k] = value - inner; length += q[k] * q[k];
    }
    length = Math.sqrt(length) || 1;
    for (let k = 0; k < 3; k += 1) out[k] += (q[k] / length) * radius;
    if (o.warp && !raw) o.warp(out);
  };
  FACES.forEach((face, f) => {
    if ((o.skip ?? 0) & (1 << f)) return;
    const ha = half[axisOf(face.r)], hb = half[axisOf(face.u)];
    const lines = (h: number, extra: number, borders: number[]) => {
      const set = new Set<number>();
      for (let i = 0; i <= round; i += 1) { const edge = h - radius + radius * Math.tan(((i / round) * Math.PI) / 4); set.add(Math.min(h, edge)); set.add(-Math.min(h, edge)); }
      for (let i = 1; i < extra; i += 1) set.add(-(h - radius) + ((h - radius) * 2 * i) / extra);
      for (const border of borders) set.add(Math.max(-h, Math.min(h, border)));
      const sorted = [...set].sort((x, y) => x - y);
      return sorted.filter((value, index) => index === 0 || value - sorted[index - 1] > 1e-5);
    };
    const windows = (o.windows ?? []).filter((w) => w.face === f);
    const ra = axisOf(face.r), ua = axisOf(face.u), extra = (axis: number, sign: number) => (o.borders?.[axis] ?? []).map((value) => value * sign);
    const as = lines(ha, cuts[ra], [...windows.flatMap((w) => [w.a0, w.a1]), ...extra(ra, face.r[ra])]), bs = lines(hb, cuts[ua], [...windows.flatMap((w) => [w.b0, w.b1]), ...extra(ua, face.u[ua])]);
    const E = 1e-4;
    for (let i = 0; i < as.length - 1; i += 1) for (let j = 0; j < bs.length - 1; j += 1) {
      const am = (as[i] + as[i + 1]) / 2, bm = (bs[j] + bs[j + 1]) / 2;
      const w = windows.find((candidate) => am > candidate.a0 && am < candidate.a1 && bm > candidate.b0 && bm < candidate.b1);
      const corners = [[as[i], bs[j]], [as[i + 1], bs[j]], [as[i + 1], bs[j + 1]], [as[i], bs[j + 1]]];
      /** A vertex whose normal is read `lean` of the way toward (ta, tb): across a crease each side keeps its own. */
      const vertex = (pa: number, pb: number, ta: number, tb: number, lean: number) => {
        const sa = pa + (ta - pa) * lean, sb = pb + (tb - pb) * lean;
        surface(f, sa + E, sb, p); surface(f, sa - E, sb, r);
        const ax = p[0] - r[0], ay = p[1] - r[1], az = p[2] - r[2];
        surface(f, sa, sb + E, p); surface(f, sa, sb - E, r);
        const bx = p[0] - r[0], by = p[1] - r[1], bz = p[2] - r[2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const size = Math.hypot(nx, ny, nz) || 1;
        nx /= size; ny /= size; nz /= size;
        surface(f, pa, pb, p);
        const uv = o.uv(f, pa, pb);
        const fa = w ? (pa - w.a0) / (w.a1 - w.a0) : 0, fb = w ? (pb - w.b0) / (w.b1 - w.b0) : 0;
        const du = w ? lerp(w.rect[0], w.rect[2], w.turn ? fb : fa) + (w.fixed ? 2 : 0) : NONE, dv = w ? lerp(w.rect[1], w.rect[3], w.turn ? 1 - fa : fb) : NONE;
        return g.v(p[0], p[1], p[2], nx, ny, nz, uv[0], uv[1], du, dv, o.colour?.(p, f));
      };
      const ridge = o.ridge;
      if (!ridge) { const ids = corners.map(([pa, pb]) => vertex(pa, pb, pa, pb, 0)); g.quad(ids[0], ids[1], ids[2], ids[3]); continue; }
      const side = corners.map(([pa, pb]) => { surface(f, pa, pb, p, true); return ridge(p); });
      // Split along the diagonal that runs with the fold; where the fold crosses the quad its two halves do not share normals.
      const order = Math.abs(side[0] - side[2]) < Math.abs(side[1] - side[3]) ? [0, 1, 2, 3] : [1, 2, 3, 0];
      if (Math.max(...side) < 0.002 || Math.min(...side) > -0.002) { const ids = order.map((k) => vertex(corners[k][0], corners[k][1], am, bm, 0.06)); g.quad(ids[0], ids[1], ids[2], ids[3]); continue; }
      for (const tri of [[order[0], order[1], order[2]], [order[0], order[2], order[3]]]) {
        const ta = (corners[tri[0]][0] + corners[tri[1]][0] + corners[tri[2]][0]) / 3, tb = (corners[tri[0]][1] + corners[tri[1]][1] + corners[tri[2]][1]) / 3;
        const ids = tri.map((k) => vertex(corners[k][0], corners[k][1], ta, tb, 0.06));
        g.tri(ids[0], ids[1], ids[2]);
      }
    }
  });
}

/** Round bar swept along a path; `radius` may vary along it. */
function tube(g: Geo, path: V3[], radius: number | ((t: number) => number), sides: number, uv: Rect, o: { caps?: boolean; squash?: number; twist?: number } = {}) {
  const n = path.length, base = g.count;
  const tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3(), previous = new THREE.Vector3(), here = new THREE.Vector3(), turn = new THREE.Quaternion(), axis = new THREE.Vector3();
  let length = 0;
  const lengths = path.map((point, index) => (index ? (length += Math.hypot(point[0] - path[index - 1][0], point[1] - path[index - 1][1], point[2] - path[index - 1][2])) : 0));
  for (let k = 0; k < n; k += 1) {
    const before = path[Math.max(0, k - 1)], after = path[Math.min(n - 1, k + 1)];
    tangent.set(after[0] - before[0], after[1] - before[1], after[2] - before[2]).normalize();
    if (k === 0) {
      normal.set(0, 1, 0);
      if (Math.abs(tangent.y) > 0.9) normal.set(1, 0, 0);
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
    } else {
      axis.crossVectors(previous, tangent);
      if (axis.lengthSq() > 1e-12) { turn.setFromAxisAngle(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, previous.dot(tangent))))); normal.applyQuaternion(turn); }
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
    }
    previous.copy(tangent);
    binormal.crossVectors(tangent, normal);
    const t = lengths[k] / (length || 1), r = typeof radius === "number" ? radius : radius(t);
    for (let s = 0; s <= sides; s += 1) {
      const angle = (s / sides) * TAU + (o.twist ?? 0) * t, ca = Math.cos(angle), sa = Math.sin(angle) * (o.squash ?? 1);
      here.set(0, 0, 0).addScaledVector(normal, ca).addScaledVector(binormal, sa);
      const nx = normal.x * ca + binormal.x * Math.sin(angle), ny = normal.y * ca + binormal.y * Math.sin(angle), nz = normal.z * ca + binormal.z * Math.sin(angle);
      g.v(path[k][0] + here.x * r, path[k][1] + here.y * r, path[k][2] + here.z * r, nx, ny, nz, lerp(uv[0], uv[2], s / sides), lerp(uv[1], uv[3], t));
    }
  }
  for (let k = 0; k < n - 1; k += 1) for (let s = 0; s < sides; s += 1) {
    const p0 = base + k * (sides + 1) + s, p1 = p0 + sides + 1;
    g.tri(p0, p0 + 1, p1); g.tri(p1, p0 + 1, p1 + 1);
  }
  if (o.caps) for (const end of [0, n - 1]) {
    const sign = end ? 1 : -1, before = path[Math.max(0, end - 1)], after = path[Math.min(n - 1, end + 1)];
    tangent.set(after[0] - before[0], after[1] - before[1], after[2] - before[2]).normalize().multiplyScalar(sign);
    const centre = g.v(path[end][0], path[end][1], path[end][2], tangent.x, tangent.y, tangent.z, (uv[0] + uv[2]) / 2, end ? uv[3] : uv[1]);
    for (let s = 0; s < sides; s += 1) {
      const p0 = base + end * (sides + 1) + s;
      if (end) g.tri(centre, p0 + 1, p0); else g.tri(centre, p0, p0 + 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Textures: generated tiles, and atlases painted on canvas
// ---------------------------------------------------------------------------------------------

type Maps = { map: THREE.Texture; normalMap: THREE.Texture; ormMap: THREE.Texture };
type Ctx = CanvasRenderingContext2D;

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const BLOCK = 'Impact, "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const SCRIPT = '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive';

function dataTexture(data: Uint8Array, width: number, height: number, srgb: boolean, anisotropy: number) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Tangent-space normals from a tileable height field whose row 0 is v = 0. */
function normalsOf(height: Float32Array, w: number, h: number, strength: number) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const below = ((y + h - 1) % h) * w, above = ((y + 1) % h) * w, row = y * w;
    for (let x = 0; x < w; x += 1) {
      const dx = (height[row + ((x + w - 1) % w)] - height[row + ((x + 1) % w)]) * strength, dy = (height[below + x] - height[above + x]) * strength;
      const inverse = 127.5 / Math.sqrt(dx * dx + dy * dy + 1), i = (row + x) * 4;
      out[i] = 127.5 + dx * inverse; out[i + 1] = 127.5 + dy * inverse; out[i + 2] = 127.5 + inverse; out[i + 3] = 255;
    }
  }
  return out;
}

/** A tile written pixel by pixel: `fill` returns height and writes colour (sRGB bytes) and ORM for one texel. */
function tile(n: number, anisotropy: number, strength: number, fill: (x: number, y: number, rgb: Uint8Array, orm: Uint8Array, at: number) => number): Maps {
  const rgb = new Uint8Array(n * n * 4), orm = new Uint8Array(n * n * 4), height = new Float32Array(n * n);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
    const at = (y * n + x) * 4;
    rgb[at + 3] = 255; orm[at + 3] = 255;
    height[y * n + x] = fill(x, y, rgb, orm, at);
  }
  return { map: dataTexture(rgb, n, n, true, anisotropy), normalMap: dataTexture(normalsOf(height, n, n, strength), n, n, false, anisotropy), ormMap: dataTexture(orm, n, n, false, anisotropy) };
}

/** Noise shared by every generator: coarse blotches, mid mottling and fine grain, 256 square and tileable. */
type Noise = { coarse: Float32Array; mid: Float32Array; fine: Float32Array; at: (table: Float32Array, x: number, y: number) => number };
function makeNoise(seed: number): Noise {
  const n = 256;
  return {
    coarse: fbmTable(n, 4, 5, seed), mid: fbmTable(n, 16, 4, seed + 1), fine: fbmTable(n, 64, 2, seed + 2, 0.6),
    at: (table, x, y) => table[((y & 255) << 8) | (x & 255)],
  };
}

/** Wear, chipping and stencil-edge noise for the prop shader: R chips, G fine grain, B streaks. */
function noiseTexture(noise: Noise, anisotropy: number) {
  const n = 256, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
    const at = (y * n + x) * 4, chips = noise.at(noise.coarse, x * 3, y * 3) * 0.55 + noise.at(noise.mid, x, y) * 0.3 + noise.at(noise.fine, x, y) * 0.15;
    data[at] = clamp01((chips - 0.25) * 2) * 255; data[at + 1] = noise.at(noise.fine, x * 2, y * 2) * 255; data[at + 2] = (noise.at(noise.mid, x * 4, y >> 2) * 0.7 + noise.at(noise.fine, x * 2, y >> 1) * 0.3) * 255; data[at + 3] = 255;
  }
  return dataTexture(data, n, n, false, anisotropy);
}

/** Bare steel: fine directional scratching, tinted per instance into iron, zinc or stainless. */
function metalTile(n: number, noise: Noise, anisotropy: number) {
  const s = 256 / n;
  return tile(n, anisotropy, 1.6, (x, y, rgb, orm, at) => {
    const X = Math.round(x * s), Y = Math.round(y * s);
    const brush = noise.at(noise.fine, X >> 3, Y * 4), tone = noise.at(noise.coarse, X, Y), pit = noise.at(noise.mid, X * 2, Y * 2);
    const value = 200 + (brush - 0.5) * 40 + (tone - 0.5) * 44 - smooth(0.7, 0.85, pit) * 44;
    rgb[at] = value; rgb[at + 1] = value; rgb[at + 2] = value + 2;
    orm[at] = 255; orm[at + 1] = (0.36 + brush * 0.16 + tone * 0.12 + smooth(0.7, 0.85, pit) * 0.25) * 255; orm[at + 2] = 200;
    return brush * 0.35 - smooth(0.7, 0.85, pit) * 0.5;
  });
}

/** Moulded plastic: pale so the instance tint is the colour, with a tight stipple and scuffs. */
function plasticTile(n: number, noise: Noise, anisotropy: number) {
  const s = 256 / n;
  return tile(n, anisotropy, 1.1, (x, y, rgb, orm, at) => {
    const X = Math.round(x * s), Y = Math.round(y * s);
    const stipple = noise.at(noise.fine, X * 2, Y * 2), tone = noise.at(noise.coarse, X, Y), scuff = smooth(0.62, 0.8, noise.at(noise.mid, X * 3, Y >> 1));
    const value = 214 + (tone - 0.5) * 30 + scuff * 22;
    rgb[at] = value; rgb[at + 1] = value; rgb[at + 2] = value;
    orm[at] = 255; orm[at + 1] = (0.42 + stipple * 0.12 + scuff * 0.3 + tone * 0.08) * 255; orm[at + 2] = 0;
    return stipple * 0.5 - scuff * 0.2;
  });
}

/** Kraft liner over corrugated board: fibre fleck and the faint washboard of the flutes (running along v). */
function kraftTile(n: number, noise: Noise, anisotropy: number) {
  const s = 256 / n, flutes = n === 512 ? 48 : 24;
  return tile(n, anisotropy, 1.4, (x, y, rgb, orm, at) => {
    const X = Math.round(x * s), Y = Math.round(y * s);
    const fibre = noise.at(noise.fine, X * 3, Y >> 1), tone = noise.at(noise.coarse, X, Y), fleck = noise.at(noise.mid, X * 4, Y * 4);
    const wave = Math.cos((x / n) * TAU * flutes), dark = smooth(0.72, 0.8, fleck) * 0.16;
    const shade = 0.86 + tone * 0.2 + (fibre - 0.5) * 0.14 + wave * 0.025 - dark;
    rgb[at] = 186 * shade; rgb[at + 1] = 142 * shade; rgb[at + 2] = 94 * shade;
    orm[at] = 255; orm[at + 1] = (0.78 + fibre * 0.14 - wave * 0.03) * 255; orm[at + 2] = 0;
    return wave * 0.22 + fibre * 0.3 + tone * 0.4;
  });
}

/** Jute sacking in plain weave, pale so prints and tints read; yarns thicken, thin and fray. */
function burlapTile(n: number, noise: Noise, anisotropy: number) {
  const yarns = n === 512 ? 64 : 32, pitch = n / yarns, s = 256 / n;
  const warp = new Float32Array(yarns), weft = new Float32Array(yarns), next = rng(733);
  for (let i = 0; i < yarns; i += 1) { warp[i] = 0.7 + next() * 0.6; weft[i] = 0.7 + next() * 0.6; }
  return tile(n, anisotropy, 3.2, (x, y, rgb, orm, at) => {
    const X = Math.round(x * s), Y = Math.round(y * s);
    const drift = (noise.at(noise.coarse, X, Y * 2) - 0.5) * 1.6, sway = (noise.at(noise.coarse, X * 2 + 91, Y) - 0.5) * 1.6;
    const u = (x + sway) / pitch, v = (y + drift) / pitch, iu = Math.floor(u), iv = Math.floor(v), fu = u - iu - 0.5, fv = v - iv - 0.5;
    const over = (iu + iv) & 1, wu = warp[((iu % yarns) + yarns) % yarns], wv = weft[((iv % yarns) + yarns) % yarns];
    // The yarn on top is round across its width and arches along its length; the other dips under it.
    const across = over ? fv / wv : fu / wu, lengthwise = over ? fu : fv;
    const round = Math.max(0, 1 - across * across * 5.2), arch = 0.62 + 0.38 * Math.cos(lengthwise * Math.PI);
    const under = Math.max(0, 1 - (over ? fu / wu : fv / wv) ** 2 * 5.2) * 0.45;
    const fuzz = noise.at(noise.fine, X * 3, Y * 3), tone = noise.at(noise.mid, X, Y);
    const height = Math.max(round * arch, under) * (0.8 + fuzz * 0.4);
    const twist = 0.9 + 0.1 * Math.sin((lengthwise * 5 + across * 2) * Math.PI);
    const shade = (0.36 + height * 0.74) * (0.82 + tone * 0.3) * twist * (over ? 1 : 0.94);
    rgb[at] = Math.min(255, 214 * shade); rgb[at + 1] = Math.min(255, 186 * shade); rgb[at + 2] = Math.min(255, 138 * shade);
    orm[at] = 255; orm[at + 1] = (0.86 + fuzz * 0.14) * 255; orm[at + 2] = 0;
    return height;
  });
}

/** Randed willow: weavers passing in front of and behind upright stakes (stakes run along v). */
function wickerTile(n: number, noise: Noise, anisotropy: number) {
  const rows = n === 512 ? 32 : 16, stakes = n === 512 ? 12 : 6, rowHeight = n / rows, stakePitch = n / stakes, s = 256 / n;
  const tones = new Float32Array(rows), next = rng(912);
  for (let i = 0; i < rows; i += 1) tones[i] = 0.78 + next() * 0.34;
  return tile(n, anisotropy, 3.4, (x, y, rgb, orm, at) => {
    const X = Math.round(x * s), Y = Math.round(y * s);
    const row = Math.floor(y / rowHeight), fy = y / rowHeight - row - 0.5;
    // A weaver bulges forward where it crosses in front of a stake and sinks between them.
    const front = 0.5 + 0.5 * Math.cos((x / stakePitch) * TAU + (row & 1) * Math.PI);
    const round = Math.max(0, 1 - fy * fy * 4.4);
    const stakeX = ((x / stakePitch + 0.5) % 1) - 0.5, stake = Math.max(0, 1 - stakeX * stakeX * 60) * (1 - front) * 0.55;
    const fibre = noise.at(noise.fine, X * 4, Y), tone = noise.at(noise.mid, X, Y);
    const height = Math.max(round * (0.35 + front * 0.65), stake);
    const shade = (0.3 + height * 0.8) * tones[row] * (0.86 + fibre * 0.2 + tone * 0.12);
    rgb[at] = Math.min(255, 198 * shade); rgb[at + 1] = Math.min(255, 148 * shade); rgb[at + 2] = Math.min(255, 86 * shade);
    orm[at] = 255; orm[at + 1] = (0.5 + (1 - height) * 0.3 + fibre * 0.14) * 255; orm[at + 2] = 0;
    return height;
  });
}

function canvas2d(width: number, height: number, read = false): Ctx {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas.getContext("2d", read ? { willReadFrequently: true } : undefined)!;
}

/** Grey noise as a canvas, for pattern fills. `tint` leaves the other channels white (for the ORM canvas). */
function noiseCanvas(table: Float32Array, channel: -1 | 1) {
  const context = canvas2d(256, 256), image = context.createImageData(256, 256);
  for (let i = 0; i < 65536; i += 1) {
    const value = table[i] * 255;
    image.data[i * 4] = channel === 1 ? 255 : value; image.data[i * 4 + 1] = value; image.data[i * 4 + 2] = channel === 1 ? 255 : value; image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return context.canvas;
}

type Grain = { fine: HTMLCanvasElement; mid: HTMLCanvasElement; coarse: HTMLCanvasElement; fineG: HTMLCanvasElement; midG: HTMLCanvasElement };
const makeGrain = (noise: Noise): Grain => ({ fine: noiseCanvas(noise.fine, -1), mid: noiseCanvas(noise.mid, -1), coarse: noiseCanvas(noise.coarse, -1), fineG: noiseCanvas(noise.fine, 1), midG: noiseCanvas(noise.mid, 1) });

/**
 * Paints colour, ORM (R tint mask, G roughness, B metalness) and height with the same strokes.
 * Coordinates are reference pixels; the canvases behind may be smaller.
 */
class Painter {
  readonly a: Ctx;
  readonly o: Ctx;
  readonly h: Ctx;
  private live: Ctx[] = [];

  constructor(readonly width: number, readonly height: number, scale: number, dataScale: number, private readonly grainOf: Grain) {
    this.a = canvas2d(Math.round(width * scale), Math.round(height * scale));
    this.o = canvas2d(Math.round(width * dataScale), Math.round(height * dataScale));
    this.h = canvas2d(Math.round(width * dataScale), Math.round(height * dataScale), true);
    this.a.scale(scale, scale); this.o.scale(dataScale, dataScale); this.h.scale(dataScale, dataScale);
    this.o.fillStyle = "rgb(0,200,0)"; this.o.fillRect(0, 0, width, height);
    this.h.fillStyle = "rgb(128,128,128)"; this.h.fillRect(0, 0, width, height);
    for (const context of [this.a, this.o, this.h]) { context.lineCap = "round"; context.lineJoin = "round"; }
  }

  /** Sets what the next shapes lay down; a layer given null is left alone. */
  ink(colour: string | null, orm: [number, number, number] | null = null, height: number | null = null) {
    this.live = [];
    if (colour) { this.a.fillStyle = this.a.strokeStyle = colour; this.live.push(this.a); }
    if (orm) { this.o.fillStyle = this.o.strokeStyle = `rgb(${Math.round(orm[0] * 255)},${Math.round(orm[1] * 255)},${Math.round(orm[2] * 255)})`; this.live.push(this.o); }
    if (height !== null) { const value = Math.round(clamp01(height) * 255); this.h.fillStyle = this.h.strokeStyle = `rgb(${value},${value},${value})`; this.live.push(this.h); }
    return this;
  }

  alpha(value: number) { for (const context of [this.a, this.o, this.h]) context.globalAlpha = value; return this; }
  rect(x: number, y: number, w: number, h: number) { for (const context of this.live) context.fillRect(x, y, w, h); return this; }

  oval(x: number, y: number, rx: number, ry = rx, turn = 0) {
    for (const context of this.live) { context.beginPath(); context.ellipse(x, y, rx, ry, turn, 0, TAU); context.fill(); }
    return this;
  }

  poly(points: number[]) {
    for (const context of this.live) {
      context.beginPath(); context.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
      context.closePath(); context.fill();
    }
    return this;
  }

  line(points: number[], width: number) {
    for (const context of this.live) {
      context.lineWidth = width; context.beginPath(); context.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
      context.stroke();
    }
    return this;
  }

  /** Runs `draw` clipped to a rectangle on every layer. */
  clip(x: number, y: number, w: number, h: number, draw: () => void) {
    for (const context of [this.a, this.o, this.h]) { context.save(); context.beginPath(); context.rect(x, y, w, h); context.clip(); }
    draw();
    for (const context of [this.a, this.o, this.h]) { context.restore(); context.globalAlpha = 1; }
  }

  /** Runs `draw` three times, shifted by the cell width, so what it paints tiles sideways. */
  around(w: number, draw: () => void) {
    for (const shift of [-w, 0, w]) {
      for (const context of [this.a, this.o, this.h]) { context.save(); context.translate(shift, 0); }
      draw();
      for (const context of [this.a, this.o, this.h]) context.restore();
    }
  }

  /** Breaks up a flat area: `colour` mottles the albedo, `rough` cuts roughness in patches, `height` adds relief. */
  grain(x: number, y: number, w: number, h: number, o: { size?: number; stretch?: number; colour?: number; rough?: number; height?: number; table?: "fine" | "mid" | "coarse" }) {
    const size = o.size ?? 1, matrix = new DOMMatrix([size, 0, 0, size * (o.stretch ?? 1), x, y]), table = o.table ?? "mid";
    const fill = (context: Ctx, source: HTMLCanvasElement, mode: GlobalCompositeOperation, amount: number) => {
      const pattern = context.createPattern(source, "repeat")!;
      pattern.setTransform(matrix);
      context.save(); context.globalCompositeOperation = mode; context.globalAlpha = amount; context.fillStyle = pattern; context.fillRect(x, y, w, h); context.restore();
    };
    if (o.colour) fill(this.a, this.grainOf[table], "overlay", o.colour);
    if (o.rough) fill(this.o, table === "fine" ? this.grainOf.fineG : this.grainOf.midG, "multiply", o.rough);
    if (o.height) fill(this.h, this.grainOf[table], "overlay", o.height);
    return this;
  }

  /** Scatters round marks; `wrap` repeats them across the cell edge. */
  dots(random: () => number, count: number, x: number, y: number, w: number, h: number, r0: number, r1: number, wrap = true) {
    for (let i = 0; i < count; i += 1) {
      const px = x + random() * w, py = y + random() * h, r = r0 + random() * (r1 - r0);
      this.oval(px, py, r);
      if (wrap && px - r < x) this.oval(px + w, py, r); else if (wrap && px + r > x + w) this.oval(px - w, py, r);
    }
    return this;
  }

  /** Colour, ORM and normal textures of the finished sheet. */
  finish(strength: number, anisotropy: number): Maps {
    const map = new THREE.CanvasTexture(this.a.canvas), ormMap = new THREE.CanvasTexture(this.o.canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = ormMap.anisotropy = anisotropy;
    const w = this.h.canvas.width, h = this.h.canvas.height, source = this.h.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      const up = (y > 0 ? y - 1 : y) * w, down = (y < h - 1 ? y + 1 : y) * w, row = y * w, target = (h - 1 - y) * w;
      for (let x = 0; x < w; x += 1) {
        const dx = (source[(row + (x > 0 ? x - 1 : x)) * 4] - source[(row + (x < w - 1 ? x + 1 : x)) * 4]) * strength, dy = (source[(down + x) * 4] - source[(up + x) * 4]) * strength;
        const inverse = 127.5 / Math.sqrt(dx * dx + dy * dy + 1), i = (target + x) * 4;
        out[i] = 127.5 + dx * inverse; out[i + 1] = 127.5 + dy * inverse; out[i + 2] = 127.5 + inverse; out[i + 3] = 255;
      }
    }
    const normalMap = dataTexture(out, w, h, false, anisotropy);
    normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
    return { map, normalMap, ormMap };
  }
}

/** Atlas cell in reference pixels (y down) as a texture rectangle, inset by `pad`. */
const cellOf = (W: number, H: number, x: number, y: number, w: number, h: number, pad = 0): Rect => [(x + pad) / W, 1 - (y + h - pad) / H, (x + w - pad) / W, 1 - (y + pad) / H];

/** Text shrunk to fit a width, centred on (x, y). */
function fitText(context: Ctx, text: string, x: number, y: number, maxWidth: number, size: number, font: string, weight = "") {
  let px = size;
  context.textAlign = "center"; context.textBaseline = "middle";
  for (;;) {
    context.font = `${weight} ${px}px ${font}`;
    if (px <= 5 || context.measureText(text).width <= maxWidth) break;
    px -= 1;
  }
  context.fillText(text, x, y);
  return px;
}

/** Text set round a circle, reading clockwise from the top. */
function arcText(context: Ctx, text: string, x: number, y: number, radius: number, size: number, font: string, spread = 0.9) {
  context.font = `${size}px ${font}`; context.textAlign = "center"; context.textBaseline = "middle";
  const step = Math.min((TAU * spread) / text.length, (size * 0.78) / radius);
  for (let i = 0; i < text.length; i += 1) {
    const angle = (i - (text.length - 1) / 2) * step;
    context.save(); context.translate(x + Math.sin(angle) * radius, y - Math.cos(angle) * radius); context.rotate(angle); context.fillText(text[i], 0, 0); context.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// Marks atlas: stencils (left half, alpha thresholded in the shader) and labels (right half)
// ---------------------------------------------------------------------------------------------

const MARKS = 2048;
const markCell = (x: number, y: number, w: number, h: number, pad = 0) => cellOf(MARKS, MARKS, x, y, w, h, pad);
/** Shift from one variant's cell to the next in the marks atlas. */
const MARK_STEP = 256 / MARKS;

const MARK = {
  crate: markCell(0, 0, 256, 192, 3), sack: markCell(0, 192, 256, 288, 3), drum: markCell(0, 480, 256, 160, 3), ammo: markCell(0, 640, 256, 96, 3),
  cask: markCell(0, 736, 256, 256, 3), pallet: markCell(512, 736, 128, 96, 3), plastic: markCell(512, 832, 256, 96, 3),
  carton: markCell(0, 992, 256, 192, 3), cartonEnd: markCell(0, 1184, 256, 192, 3), stitch: markCell(0, 1380, 256, 24),
  tape: markCell(1024, 4, 512, 56), drumLabel: markCell(1024, 80, 256, 176, 3), cartonLabel: markCell(1024, 272, 256, 176, 3),
  endGrain: markCell(1024, 464, 128, 128, 4), flute: markCell(1280, 468, 512, 24), rust: markCell(1280, 560, 512, 128),
};

function paintMarks(scale: number, anisotropy: number) {
  const c = canvas2d(MARKS * scale, MARKS * scale);
  c.scale(scale, scale);
  c.lineCap = "round"; c.lineJoin = "round";
  const random = rng(4417);
  /** Stencilled line of text: soft-edged for the shader's threshold, cut by the bridges of a stencil plate. */
  const stencil = (text: string, x: number, y: number, size: number, width: number, colour: string, bridges = true) => {
    c.save();
    c.fillStyle = colour; c.shadowColor = colour; c.shadowBlur = 1.6 * scale;
    const px = fitText(c, text, x, y, width, size, BLOCK), span = c.measureText(text).width;
    c.shadowBlur = 0;
    if (bridges) {
      c.globalCompositeOperation = "destination-out";
      for (let cut = x - span / 2 + px * 0.27; cut < x + span / 2; cut += px * 0.47) c.fillRect(cut, y - px * 0.6, Math.max(1.4, px * 0.045), px * 1.2);
    }
    c.restore();
  };
  const soft = (colour: string, blur = 1.4) => { c.fillStyle = c.strokeStyle = colour; c.shadowColor = colour; c.shadowBlur = blur * scale; };
  const hard = () => { c.shadowBlur = 0; c.shadowColor = "transparent"; };
  const frame = (x: number, y: number, w: number, h: number, width: number) => { c.lineWidth = width; c.strokeRect(x, y, w, h); };
  const arrow = (x: number, y: number, h: number) => {
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + h * 0.36, y + h * 0.42); c.lineTo(x + h * 0.13, y + h * 0.42); c.lineTo(x + h * 0.13, y + h); c.lineTo(x - h * 0.13, y + h); c.lineTo(x - h * 0.13, y + h * 0.42); c.lineTo(x - h * 0.36, y + h * 0.42); c.closePath(); c.fill();
    c.fillRect(x - h * 0.36, y + h * 1.08, h * 0.72, h * 0.09);
  };
  const glass = (x: number, y: number, h: number) => {
    c.beginPath(); c.moveTo(x - h * 0.3, y); c.lineTo(x + h * 0.3, y); c.lineTo(x + h * 0.24, y + h * 0.3); c.quadraticCurveTo(x + h * 0.2, y + h * 0.5, x + h * 0.045, y + h * 0.54);
    c.lineTo(x + h * 0.045, y + h * 0.9); c.lineTo(x + h * 0.24, y + h); c.lineTo(x - h * 0.24, y + h); c.lineTo(x - h * 0.045, y + h * 0.9); c.lineTo(x - h * 0.045, y + h * 0.54);
    c.quadraticCurveTo(x - h * 0.2, y + h * 0.5, x - h * 0.24, y + h * 0.3); c.closePath(); c.fill();
    // The crack that makes it "fragile".
    c.save(); c.globalCompositeOperation = "destination-out"; c.lineWidth = h * 0.045; c.beginPath(); c.moveTo(x - h * 0.05, y); c.lineTo(x + h * 0.06, y + h * 0.16); c.lineTo(x - h * 0.04, y + h * 0.24); c.lineTo(x + h * 0.03, y + h * 0.4); c.stroke(); c.restore();
  };
  const umbrella = (x: number, y: number, h: number) => {
    c.beginPath(); c.arc(x, y + h * 0.5, h * 0.5, Math.PI, 0); c.closePath(); c.fill();
    c.lineWidth = h * 0.07; c.beginPath(); c.moveTo(x, y + h * 0.5); c.lineTo(x, y + h * 0.92); c.arc(x - h * 0.1, y + h * 0.92, h * 0.1, 0, Math.PI); c.stroke();
    for (const dx of [-0.34, 0.02, 0.36]) { c.beginPath(); c.ellipse(x + dx * h, y - h * 0.02, h * 0.035, h * 0.075, 0.3, 0, TAU); c.fill(); }
  };
  const barcode = (x: number, y: number, w: number, h: number) => {
    for (let at = 0; at < w;) { const bar = 1 + Math.floor(random() * 3) * 0.9; if (random() > 0.42) c.fillRect(x + at, y, bar, h); at += bar + (random() > 0.6 ? 1.2 : 0); }
  };
  const lines = (x: number, y: number, w: number, rows: number, gap: number) => { for (let i = 0; i < rows; i += 1) c.fillRect(x, y + i * gap, w * (0.55 + random() * 0.45), 2.2); };

  // -- Stencils on crates: 256 x 192 each ------------------------------------------------------
  const RED = "rgb(150,34,26)", BLACK = "rgb(26,23,20)", NAVY = "rgb(24,34,62)", WHITE = "rgb(236,232,220)", YELLOW = "rgb(232,196,48)";
  {
    soft(RED); glass(46, 38, 96); stencil("FRAGILE", 158, 70, 60, 150, RED); stencil("HANDLE WITH CARE", 158, 122, 22, 150, RED); soft(RED); c.fillRect(84, 148, 150, 5); hard();
    soft(BLACK); arrow(256 + 44, 22, 104); arrow(256 + 212, 22, 104); stencil("THIS", 256 + 128, 50, 40, 100, BLACK); stencil("SIDE", 256 + 128, 92, 40, 100, BLACK); stencil("UP", 256 + 128, 134, 40, 100, BLACK); hard();
    soft(BLACK); c.save(); c.translate(512 + 128, 44); c.rotate(Math.PI / 4); frame(-22, -22, 44, 44, 6); c.restore(); stencil("T", 512 + 128, 46, 34, 30, BLACK, false);
    stencil("RUSH B", 512 + 128, 104, 50, 220, BLACK); stencil("LINES Co.  LOT 1337", 512 + 128, 152, 22, 220, BLACK); hard();
    soft(NAVY); frame(768 + 16, 16, 224, 160, 5); stencil("PORT MIRAGE", 768 + 128, 48, 28, 196, NAVY); stencil("NET 48 KG", 768 + 128, 88, 30, 196, NAVY); stencil("GROSS 61 KG", 768 + 128, 124, 30, 196, NAVY); stencil("No 12 / 40", 768 + 128, 156, 20, 196, NAVY); hard();
  }
  // -- Prints on sacks: 256 x 288 --------------------------------------------------------------
  {
    const BLUE = "rgb(28,52,128)", GREEN = "rgb(22,84,46)", INK = "rgb(30,26,24)", SACK_RED = "rgb(168,34,30)", oy = 192;
    soft(SACK_RED); c.fillRect(24, oy + 20, 208, 9); c.fillRect(24, oy + 34, 208, 4); c.fillRect(24, oy + 258, 208, 9); hard();
    soft(BLUE); for (let i = 0; i < 7; i += 1) for (const side of [-1, 1]) { c.beginPath(); c.ellipse(128 + side * (6 + i * 1.2), oy + 62 + i * 7, 9, 3.6, side * (0.9 - i * 0.03), 0, TAU); c.fill(); } c.fillRect(126.5, oy + 60, 3, 62); hard();
    stencil("LONG A", 128, oy + 150, 50, 204, BLUE); stencil("MILLS · RIZ LONG GRAIN", 128, oy + 188, 19, 204, BLUE); stencil("25 KG", 128, oy + 228, 44, 180, SACK_RED);
    soft(GREEN); c.lineWidth = 4; c.beginPath(); c.moveTo(256 + 60, oy + 80); c.quadraticCurveTo(256 + 128, oy + 30, 256 + 200, oy + 62); c.stroke();
    for (let i = 0; i < 6; i += 1) { const t = i / 5, x = 256 + 66 + t * 126, y = oy + 74 - Math.sin(t * Math.PI) * 26; c.beginPath(); c.ellipse(x, y + (i % 2 ? 13 : -13), 15, 6.5, i % 2 ? 0.9 : -0.9, 0, TAU); c.fill(); } hard();
    stencil("ECO ROUND", 256 + 128, oy + 126, 40, 208, GREEN); stencil("COFFEE", 256 + 128, oy + 164, 28, 208, INK); stencil("60 KG", 256 + 128, oy + 208, 48, 200, INK); stencil("PRODUCE OF INFERNO", 256 + 128, oy + 252, 17, 208, GREEN);
    soft(BLUE); c.save(); c.translate(512 + 128, oy + 58); for (let i = 0; i < 4; i += 1) { c.rotate(Math.PI / 2); c.beginPath(); c.moveTo(0, 0); c.lineTo(34, -6); c.lineTo(34, 9); c.closePath(); c.fill(); } c.beginPath(); c.arc(0, 0, 7, 0, TAU); c.fill(); c.restore(); hard();
    stencil("FARINE", 512 + 128, oy + 130, 54, 204, BLUE); stencil("T64", 512 + 128, oy + 186, 58, 150, BLUE); stencil("MOULINS DE LA CACHE · 50 KG", 512 + 128, oy + 238, 17, 208, BLUE); soft(BLUE); frame(512 + 20, oy + 16, 216, 256, 4); hard();
    soft(SACK_RED); for (const y of [22, 36, 50, 240, 254, 268]) c.fillRect(768 + 22, oy + y, 212, 7); hard();
    stencil("PURE SALT", 768 + 128, oy + 104, 42, 204, INK); stencil("POST-MATCH", 768 + 128, oy + 150, 30, 150, INK); stencil("50 KG", 768 + 128, oy + 200, 50, 190, SACK_RED);
  }
  // -- Stencils on steel drums (256 x 160) and ammunition crates (256 x 96) ---------------------
  {
    let oy = 480;
    stencil("SURF", 128, oy + 48, 62, 220, WHITE); stencil("HYDRAULIC OIL ISO 64", 128, oy + 100, 22, 224, WHITE); stencil("208 L", 128, oy + 134, 28, 150, WHITE);
    stencil("MOLLY CHEMICAL", 256 + 128, oy + 34, 26, 224, YELLOW); stencil("SOLVENT C-4", 256 + 128, oy + 82, 40, 224, YELLOW); stencil("UN 1993", 256 + 128, oy + 130, 26, 150, YELLOW);
    stencil("DIESEL", 512 + 128, oy + 62, 76, 220, WHITE); stencil("200 L   No. 37", 512 + 128, oy + 128, 24, 210, WHITE);
    stencil("WASTE OIL", 768 + 128, oy + 58, 50, 224, YELLOW); stencil("DO NOT REFILL", 768 + 128, oy + 116, 24, 210, YELLOW);
    oy = 640;
    const OCHRE = "rgb(226,188,62)";
    [["840 CTG 7.62 MM BALL", "LOT HS-2700-47"], ["150 CTG NEGEV UNSOLD", "LOT HS-1700-00"], ["48 FLASH · DO NOT LOOK", "LOT HS-0313-81"], ["RATION FIELD 24 MEALS", "PACKED 06-99"]].forEach(([top, bottom], k) => {
      stencil(top, k * 256 + 128, oy + 32, 28, 232, OCHRE); stencil(bottom, k * 256 + 128, oy + 70, 21, 200, OCHRE);
    });
  }
  // -- Brands burnt into cask heads (256 square), pallet stamps, moulded crate marks -------------
  {
    const BURNT = "rgb(38,22,12)", oy = 736;
    [["GLOBAL ELITE DISTILLERY", "No 114", "1999 · FIRST FILL"], ["CHÂTEAU SILVER I · ROUGE", "225 L", "MIS EN FÛT 1999"]].forEach(([ring, middle, foot], k) => {
      const x = k * 256 + 128, y = oy + 128;
      soft(BURNT, 1.2); c.lineWidth = 3.5; c.beginPath(); c.arc(x, y, 112, 0, TAU); c.stroke(); c.lineWidth = 2; c.beginPath(); c.arc(x, y, 76, 0, TAU); c.stroke();
      arcText(c, ring, x, y, 93, 23, BLOCK, 0.62); stencil(middle, x, y - 6, 46, 130, BURNT, false); stencil(foot, x, y + 36, 15, 124, BURNT, false); hard();
    });
    ["DE-0002", "CS-1600"].forEach((code, k) => {
      const x = 512 + k * 128 + 64, y = oy + 48;
      soft(BURNT, 1.2); c.lineWidth = 3; c.beginPath(); c.ellipse(x, y, 54, 36, 0, 0, TAU); c.stroke(); c.fillRect(x - 54, y - 1.5, 108, 3);
      stencil(code, x, y - 16, 17, 84, BURNT, false); stencil("HT   KD", x, y + 17, 17, 80, BURNT, false); hard();
    });
    ["CLUTCH", "DECOY"].forEach((name, k) => {
      const x = 512 + k * 256 + 128, y = oy + 96 + 48;
      soft(WHITE); c.lineWidth = 5; c.beginPath(); c.roundRect(x - 112, y - 34, 224, 68, 14); c.stroke(); stencil(name, x, y + 2, 46, 196, WHITE, false); hard();
    });
  }
  // -- Flexo prints on cartons: long faces and ends (256 x 192) ----------------------------------
  {
    const INK = "rgb(44,32,26)", PRINT_RED = "rgb(170,38,28)";
    let oy = 992;
    soft(PRINT_RED); frame(14, oy + 14, 228, 164, 6); glass(52, oy + 40, 104); stencil("FRAGILE", 162, oy + 76, 56, 140, PRINT_RED, false); stencil("HANDLE WITH CARE", 162, oy + 132, 19, 140, PRINT_RED, false); hard();
    soft(INK); frame(256 + 18, oy + 18, 92, 156, 5); arrow(256 + 64, oy + 34, 100); frame(256 + 146, oy + 18, 92, 156, 5); umbrella(256 + 192, oy + 44, 78); stencil("KEEP DRY", 256 + 192, oy + 152, 15, 80, INK, false); hard();
    soft(INK); c.fillRect(512 + 20, oy + 22, 216, 54); c.save(); c.globalCompositeOperation = "destination-out"; fitText(c, "RUSH B", 512 + 128, oy + 50, 196, 44, BLOCK); c.restore();
    stencil("LOGISTICS", 512 + 128, oy + 100, 26, 210, INK, false); stencil("QTY 12   REF 47-2700", 512 + 128, oy + 136, 17, 210, INK, false); c.fillRect(512 + 20, oy + 160, 216, 5); hard();
    soft(INK); c.lineWidth = 4; c.beginPath(); c.ellipse(768 + 128, oy + 78, 104, 54, 0, 0, TAU); c.stroke(); c.font = `italic 40px ${SERIF}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("Inferno", 768 + 128, oy + 76);
    stencil("12 × 75 cl", 768 + 128, oy + 156, 22, 180, INK, false); hard();
    oy = 1184;
    for (let k = 0; k < 4; k += 1) {
      const ox = k * 256, ink = k === 3 ? PRINT_RED : INK;
      soft(ink);
      for (let i = 0; i < 3; i += 1) frame(ox + 20 + i * 76, oy + 22, 64, 84, 4);
      glass(ox + 52, oy + 34, 60); arrow(ox + 128, oy + 34, 52); umbrella(ox + 204, oy + 40, 44);
      stencil(["DO NOT STACK OVER 6", "STORE BELOW 25 °C", "THIS END UP", "GLASS · WITH CARE"][k], ox + 128, oy + 132, 19, 220, ink, false); stencil(["48-2207 / 12", "RSB 1337", "MRG 0016 / 24", "INF 1999 / 12"][k], ox + 128, oy + 164, 15, 200, ink, false);
      hard();
    }
    // Twine stitches for sack seams.
    soft("rgb(226,208,170)", 0.8);
    for (let x = 4; x < 252; x += 13) { c.save(); c.translate(x + 5, 1392); c.rotate(-0.16); c.fillRect(-4.5, -1.8, 9, 3.6); c.restore(); }
    hard();
  }
  // -- Labels, right half: packing tape (glossy), drum and carton labels, end grain, flutes, rust -
  {
    const tape = c.createLinearGradient(0, 4, 0, 60);
    tape.addColorStop(0, "rgba(168,128,70,0.9)"); tape.addColorStop(0.08, "rgba(196,158,98,0.86)"); tape.addColorStop(0.92, "rgba(190,150,92,0.86)"); tape.addColorStop(1, "rgba(160,120,66,0.9)");
    c.fillStyle = tape; c.fillRect(1024, 4, 512, 56);
    for (let i = 0; i < 46; i += 1) { c.fillStyle = `rgba(${random() > 0.5 ? "232,204,150" : "150,112,62"},${0.08 + random() * 0.12})`; c.fillRect(1024, 6 + random() * 52, 512, 0.8 + random() * 1.6); }
    let oy = 80;
    // 0: flammable diamond and panel.
    c.fillStyle = "rgb(238,236,228)"; c.fillRect(1024 + 8, oy + 8, 240, 160);
    c.save(); c.translate(1024 + 76, oy + 88); c.rotate(Math.PI / 4); c.fillStyle = "rgb(204,32,28)"; c.fillRect(-46, -46, 92, 92); c.strokeStyle = "rgb(20,18,18)"; c.lineWidth = 3; c.strokeRect(-42, -42, 84, 84); c.restore();
    c.fillStyle = "rgb(18,16,16)"; c.beginPath(); c.moveTo(1024 + 76, oy + 44); c.bezierCurveTo(1024 + 104, oy + 72, 1024 + 96, oy + 100, 1024 + 76, oy + 104); c.bezierCurveTo(1024 + 52, oy + 100, 1024 + 52, oy + 78, 1024 + 66, oy + 66); c.bezierCurveTo(1024 + 68, oy + 78, 1024 + 76, oy + 74, 1024 + 76, oy + 44); c.fill();
    c.fillRect(1024 + 60, oy + 110, 32, 4); fitText(c, "3", 1024 + 76, oy + 124, 20, 15, SANS, "bold");
    fitText(c, "FLAMMABLE", 1024 + 190, oy + 44, 110, 22, SANS, "bold"); fitText(c, "LIQUID", 1024 + 190, oy + 68, 110, 22, SANS, "bold"); c.fillRect(1024 + 138, oy + 86, 104, 2.5);
    c.font = `9px ${SANS}`; lines(1024 + 138, oy + 98, 104, 5, 9); barcode(1024 + 138, oy + 146, 104, 16);
    // 1: supplier label.
    c.fillStyle = "rgb(240,238,230)"; c.fillRect(1280 + 8, oy + 8, 240, 160); c.fillStyle = "rgb(22,58,128)"; c.fillRect(1280 + 8, oy + 8, 240, 44);
    c.fillStyle = "rgb(240,238,230)"; fitText(c, "SURF", 1280 + 84, oy + 31, 130, 30, BLOCK); c.font = `bold 11px ${SANS}`; c.textAlign = "left"; c.fillText("LUBRICANTS", 1280 + 160, oy + 31);
    c.fillStyle = "rgb(24,22,22)"; c.textAlign = "left"; c.font = `bold 15px ${SANS}`; c.fillText("HYDRAULIC OIL ISO 64", 1280 + 18, oy + 70); c.font = `11px ${SANS}`; c.fillText("Batch 1337-B   Net 208 L   184 kg", 1280 + 18, oy + 90);
    lines(1280 + 18, oy + 104, 130, 5, 9); barcode(1280 + 160, oy + 104, 78, 44); c.font = `8px ${SANS}`; c.fillText("4 417092 608124", 1280 + 162, oy + 158);
    // 2: flammable-liquid diamond on a yellow panel (this label rides on the DIESEL drum).
    c.fillStyle = "rgb(236,196,40)"; c.fillRect(1536 + 8, oy + 8, 240, 160); c.fillStyle = "rgb(20,18,18)"; c.fillRect(1536 + 8, oy + 8, 240, 10); c.fillRect(1536 + 8, oy + 158, 240, 10);
    c.save(); c.translate(1536 + 74, oy + 88); c.rotate(Math.PI / 4); c.fillStyle = "rgb(20,18,18)"; c.fillRect(-42, -42, 84, 84); c.fillStyle = "rgb(204,44,32)"; c.fillRect(-38, -38, 76, 76); c.rotate(-Math.PI / 4);
    c.fillStyle = "rgb(240,238,230)"; c.beginPath(); c.moveTo(0, -30); c.bezierCurveTo(22, -8, 20, 14, 0, 18); c.bezierCurveTo(-20, 14, -12, -4, -6, -10); c.bezierCurveTo(-4, -2, 2, -6, 0, -30); c.closePath(); c.fill(); c.font = `bold 20px ${SANS}`; c.textAlign = "center"; c.fillText("3", 0, 44); c.restore();
    c.fillStyle = "rgb(20,18,18)"; fitText(c, "FLAMMABLE", 1536 + 186, oy + 60, 112, 22, SANS, "bold"); fitText(c, "UN 1202", 1536 + 186, oy + 92, 112, 26, SANS, "bold"); c.textAlign = "left"; lines(1536 + 132, oy + 116, 106, 4, 9);
    oy = 272;
    for (let k = 0; k < 4; k += 1) {
      const ox = 1024 + k * 256;
      if (k === 3) {
        c.fillStyle = "rgb(214,96,26)"; c.fillRect(ox + 24, oy + 34, 208, 108); c.fillStyle = "rgb(250,244,232)"; fitText(c, "HEAVY", ox + 128, oy + 74, 180, 50, BLOCK); fitText(c, "2 PERSON LIFT · 25 KG", ox + 128, oy + 116, 180, 16, SANS, "bold");
        continue;
      }
      c.fillStyle = "rgb(244,242,236)"; c.fillRect(ox + 10, oy + 10, 236, 156);
      c.fillStyle = "rgb(22,20,20)"; c.fillRect(ox + 10, oy + 10, 236, 3); c.fillRect(ox + 10, oy + 62, 236, 2); c.fillRect(ox + 10, oy + 118, 236, 2);
      c.textAlign = "left"; c.textBaseline = "middle"; c.font = `bold 9px ${SANS}`; c.fillText("SHIP TO", ox + 18, oy + 24); c.font = `bold 13px ${SANS}`; c.fillText(["MIRAGE DEPOT B", "INFERNO CAVES S.A.", "RUSH B PIER 4"][k], ox + 18, oy + 38); c.font = `10px ${SANS}`; c.fillText(["Palace Road 12 · Mirage", "Via Banana 3 · Inferno", "Dock Gate B · Rush B"][k], ox + 18, oy + 52);
      c.font = `bold 36px ${SANS}`; c.fillText(["MRG-07", "INF-21", "RSB-04"][k], ox + 18, oy + 92); c.fillRect(ox + 176, oy + 70, 60, 42); c.fillStyle = "rgb(244,242,236)"; c.font = `bold 26px ${SANS}`; c.textAlign = "center"; c.fillText(["C4", "A1", "F9"][k], ox + 206, oy + 92);
      c.fillStyle = "rgb(22,20,20)"; barcode(ox + 18, oy + 126, 150, 26); c.font = `8px ${SANS}`; c.textAlign = "left"; c.fillText(["(00) 0 4417092 608124 7", "(00) 0 1987114 220713 4", "(00) 0 0926441 700318 2"][k], ox + 18, oy + 159); c.font = `bold 15px ${SANS}`; c.fillText(["1/4", "3/12", "2/6"][k], ox + 196, oy + 140);
    }
    // End grain, opaque: rings about a pith that lies off the piece, with checks running out from it.
    oy = 464;
    for (let k = 0; k < 2; k += 1) {
      const ox = 1024 + k * 128, px = ox + (k ? -30 : 150), py = oy + (k ? 40 : 170);
      c.save(); c.beginPath(); c.rect(ox, oy, 128, 128); c.clip();
      c.fillStyle = "rgb(150,116,78)"; c.fillRect(ox, oy, 128, 128);
      for (let r = 8; r < 320; r += 3 + random() * 6) { c.strokeStyle = `rgba(${random() > 0.5 ? "92,62,36" : "186,150,104"},${0.3 + random() * 0.45})`; c.lineWidth = 0.8 + random() * 2.2; c.beginPath(); c.arc(px, py, r, 0, TAU); c.stroke(); }
      for (let i = 0; i < 9; i += 1) { const angle = random() * TAU, r0 = 30 + random() * 120; c.strokeStyle = "rgba(40,26,14,0.7)"; c.lineWidth = 0.8 + random(); c.beginPath(); c.moveTo(px + Math.cos(angle) * r0, py + Math.sin(angle) * r0); c.lineTo(px + Math.cos(angle) * (r0 + 20 + random() * 50), py + Math.sin(angle) * (r0 + 20 + random() * 50)); c.stroke(); }
      for (let i = 0; i < 500; i += 1) { c.fillStyle = `rgba(60,40,24,${random() * 0.25})`; c.fillRect(ox + random() * 128, oy + random() * 128, 1.2, 1.2); }
      c.restore();
    }
    // Cut edge of corrugated board: two liners and the flute between them.
    c.fillStyle = "rgb(92,66,40)"; c.fillRect(1280, 468, 512, 24); c.fillStyle = "rgb(190,150,104)"; c.fillRect(1280, 468, 512, 4.5); c.fillRect(1280, 487.5, 512, 4.5);
    c.strokeStyle = "rgb(204,166,118)"; c.lineWidth = 2.6; c.beginPath();
    for (let x = 0; x <= 512; x += 2) { const y = 480 + Math.sin((x / 512) * TAU * 20) * 6.2; if (x) c.lineTo(1280 + x, y); else c.moveTo(1280 + x, y); }
    c.stroke();
    // Rust weeping down from a seam.
    for (let i = 0; i < 70; i += 1) {
      const width = 1.5 + random() * 5, x = 1280 + random() * (512 - width), length = 18 + random() * random() * 108, run = c.createLinearGradient(0, 560, 0, 560 + length);
      const tone = random() > 0.4 ? "126,60,24" : "70,36,18";
      run.addColorStop(0, `rgba(${tone},${0.5 + random() * 0.4})`); run.addColorStop(1, `rgba(${tone},0)`);
      c.fillStyle = run;
      c.fillRect(x, 560, width, length);
    }
  }
  const texture = new THREE.CanvasTexture(c.canvas);
  texture.premultiplyAlpha = true;
  texture.anisotropy = anisotropy;
  return texture;
}

// ---------------------------------------------------------------------------------------------
// Smalls atlas: labels, closures, liquids, jar contents and printed tins, one column per variant
// ---------------------------------------------------------------------------------------------

const SMALLS_W = 2048, SMALLS_H = 1280;
const smallCell = (x: number, y: number, w: number, h: number, pad = 2) => cellOf(SMALLS_W, SMALLS_H, x, y, w, h, pad);
/** Cells of variant 0 of each family, and the step to the next variant. */
const SMALL = {
  wine: { step: [256 / SMALLS_W, 0], label: smallCell(0, 0, 256, 256), capSide: smallCell(0, 256, 192, 96), capTop: smallCell(192, 256, 64, 64), liquid: smallCell(196, 324, 24, 56, 0) },
  spirits: { step: [256 / SMALLS_W, 0], label: smallCell(768, 0, 224, 288), capSide: smallCell(768, 288, 192, 96), capTop: smallCell(960, 288, 64, 64), liquid: smallCell(996, 8, 24, 240, 0) },
  sauce: { step: [168 / SMALLS_W, 0], label: smallCell(1536, 0, 168, 128), capSide: smallCell(1536, 128, 104, 64), capTop: smallCell(1640, 128, 64, 64), liquid: smallCell(1540, 196, 24, 56, 0) },
  beer: { step: [384 / SMALLS_W, 0], label: smallCell(0, 384, 384, 192), capTop: smallCell(0, 576, 64, 64), capSide: smallCell(64, 576, 128, 32), neck: smallCell(192, 576, 160, 64), liquid: smallCell(356, 580, 24, 56, 0) },
  soda: { step: [256 / SMALLS_W, 0], label: smallCell(1152, 384, 256, 160), capTop: smallCell(1152, 544, 64, 64), capSide: smallCell(1216, 544, 128, 32), liquid: smallCell(1348, 548, 24, 56, 0) },
  jar: { step: [256 / SMALLS_W, 0], contents: smallCell(0, 640, 256, 224, 0), label: smallCell(0, 864, 256, 128), lidTop: smallCell(0, 992, 96, 96), lidSide: smallCell(96, 992, 160, 48) },
  tin: { step: [512 / SMALLS_W, 288 / SMALLS_H], wrap: smallCell(1024, 640, 512, 208, 0), lidTop: smallCell(1024, 848, 80, 80), lidSide: smallCell(1104, 848, 256, 32) },
};

type Crest = "shield" | "sun" | "bird" | "hops" | "diamond" | "drop" | "flame" | "leaf" | "bee" | "anchor" | "none";

function paintCrest(c: Ctx, kind: Crest, x: number, y: number, s: number) {
  c.save(); c.translate(x, y); c.lineWidth = s * 0.07; c.lineJoin = "round";
  if (kind === "shield") { c.beginPath(); c.moveTo(-s * 0.42, -s * 0.5); c.lineTo(s * 0.42, -s * 0.5); c.lineTo(s * 0.42, 0); c.quadraticCurveTo(s * 0.4, s * 0.38, 0, s * 0.55); c.quadraticCurveTo(-s * 0.4, s * 0.38, -s * 0.42, 0); c.closePath(); c.stroke(); c.beginPath(); c.moveTo(-s * 0.42, -s * 0.12); c.lineTo(s * 0.42, -s * 0.12); c.moveTo(0, -s * 0.5); c.lineTo(0, s * 0.55); c.stroke(); }
  else if (kind === "sun") { c.beginPath(); c.arc(0, 0, s * 0.24, 0, TAU); c.fill(); for (let i = 0; i < 12; i += 1) { c.rotate(TAU / 12); c.beginPath(); c.moveTo(s * 0.3, -s * 0.045); c.lineTo(s * (i % 2 ? 0.52 : 0.44), 0); c.lineTo(s * 0.3, s * 0.045); c.closePath(); c.fill(); } }
  else if (kind === "bird") { c.beginPath(); c.moveTo(-s * 0.55, -s * 0.2); c.quadraticCurveTo(-s * 0.2, -s * 0.36, 0, s * 0.06); c.quadraticCurveTo(s * 0.2, -s * 0.36, s * 0.55, -s * 0.2); c.quadraticCurveTo(s * 0.2, -s * 0.1, s * 0.07, s * 0.3); c.lineTo(0, s * 0.18); c.lineTo(-s * 0.07, s * 0.3); c.quadraticCurveTo(-s * 0.2, -s * 0.1, -s * 0.55, -s * 0.2); c.fill(); }
  else if (kind === "hops") { for (let row = 0; row < 4; row += 1) for (let i = -row; i <= row; i += 2) { c.beginPath(); c.ellipse(i * s * 0.1, -s * 0.4 + row * s * 0.2, s * 0.12, s * 0.15, 0, 0, TAU); c.fill(); } c.beginPath(); c.ellipse(0, s * 0.46, s * 0.1, s * 0.13, 0, 0, TAU); c.fill(); }
  else if (kind === "diamond") { c.beginPath(); c.moveTo(0, -s * 0.5); c.lineTo(s * 0.36, 0); c.lineTo(0, s * 0.5); c.lineTo(-s * 0.36, 0); c.closePath(); c.stroke(); c.beginPath(); c.moveTo(0, -s * 0.24); c.lineTo(s * 0.17, 0); c.lineTo(0, s * 0.24); c.lineTo(-s * 0.17, 0); c.closePath(); c.fill(); }
  else if (kind === "drop") { c.beginPath(); c.moveTo(0, -s * 0.52); c.bezierCurveTo(s * 0.5, s * 0.05, s * 0.34, s * 0.5, 0, s * 0.5); c.bezierCurveTo(-s * 0.34, s * 0.5, -s * 0.5, s * 0.05, 0, -s * 0.52); c.fill(); }
  else if (kind === "flame") { c.beginPath(); c.moveTo(0, -s * 0.55); c.bezierCurveTo(s * 0.5, -s * 0.05, s * 0.4, s * 0.5, 0, s * 0.5); c.bezierCurveTo(-s * 0.44, s * 0.5, -s * 0.4, s * 0.02, -s * 0.16, -s * 0.14); c.bezierCurveTo(-s * 0.12, s * 0.06, 0, s * 0.0, 0, -s * 0.55); c.fill(); }
  else if (kind === "leaf") { c.beginPath(); c.moveTo(0, -s * 0.55); c.quadraticCurveTo(s * 0.5, -s * 0.1, 0, s * 0.5); c.quadraticCurveTo(-s * 0.5, -s * 0.1, 0, -s * 0.55); c.fill(); c.beginPath(); c.moveTo(0, s * 0.3); c.lineTo(0, s * 0.62); c.stroke(); }
  else if (kind === "bee") { c.beginPath(); c.ellipse(0, s * 0.08, s * 0.2, s * 0.32, 0, 0, TAU); c.fill(); c.beginPath(); c.arc(0, -s * 0.32, s * 0.13, 0, TAU); c.fill(); c.globalAlpha *= 0.6; for (const side of [-1, 1]) { c.beginPath(); c.ellipse(side * s * 0.3, -s * 0.06, s * 0.26, s * 0.12, side * 0.5, 0, TAU); c.fill(); } }
  else if (kind === "anchor") { c.beginPath(); c.arc(0, -s * 0.4, s * 0.1, 0, TAU); c.stroke(); c.beginPath(); c.moveTo(0, -s * 0.3); c.lineTo(0, s * 0.45); c.moveTo(-s * 0.22, -s * 0.1); c.lineTo(s * 0.22, -s * 0.1); c.stroke(); c.beginPath(); c.arc(0, s * 0.1, s * 0.36, 0.15, Math.PI - 0.15); c.stroke(); }
  c.restore();
}

type LabelArt = {
  layout: "classic" | "band" | "oval" | "bold";
  paper: string; ink: string; accent: string;
  brand: string; font: string; weight?: string;
  tag: string; small: string; crest: Crest;
  /** Print the accent as metal foil. */
  foil?: boolean;
};

/** A printed paper label filling the rectangle. */
function paintLabel(P: Painter, x: number, y: number, w: number, h: number, art: LabelArt) {
  const c = P.a, foil = (draw: (context: Ctx) => void) => {
    c.fillStyle = c.strokeStyle = art.accent; draw(c);
    if (art.foil) { P.o.fillStyle = P.o.strokeStyle = "rgb(0,70,235)"; draw(P.o); }
  };
  P.ink(art.paper, [0, 0.74, 0], 0.5).rect(x, y, w, h);
  const cx = x + w / 2;
  if (art.layout === "classic") {
    foil((k) => { k.lineWidth = 2.2; k.strokeRect(x + 9, y + 9, w - 18, h - 18); k.lineWidth = 0.9; k.strokeRect(x + 14, y + 14, w - 28, h - 28); });
    foil((k) => paintCrest(k, art.crest, cx, y + h * 0.2, h * 0.2));
    c.fillStyle = art.ink; fitText(c, art.brand, cx, y + h * 0.45, w - 44, h * 0.15, art.font, art.weight ?? "");
    foil((k) => { k.fillRect(cx - w * 0.28, y + h * 0.555, w * 0.56, 1.4); });
    c.fillStyle = art.ink; fitText(c, art.tag, cx, y + h * 0.65, w - 50, h * 0.085, SERIF, "italic");
    const lines = art.small.split("|");
    lines.forEach((line, i) => fitText(c, line, cx, y + h * (0.78 + i * 0.07), w - 56, h * 0.045, SANS));
  } else if (art.layout === "band") {
    c.fillStyle = art.accent; c.fillRect(x, y, w, h * 0.3); c.fillRect(x, y + h * 0.9, w, h * 0.1);
    c.fillStyle = art.paper; fitText(c, art.brand, cx, y + h * 0.155, w - 28, h * 0.17, art.font, art.weight ?? "");
    c.fillStyle = art.ink; paintCrest(c, art.crest, cx, y + h * 0.47, h * 0.2);
    fitText(c, art.tag, cx, y + h * 0.68, w - 36, h * 0.1, SERIF, "italic");
    art.small.split("|").forEach((line, i) => fitText(c, line, cx, y + h * (0.79 + i * 0.06), w - 40, h * 0.04, SANS));
  } else if (art.layout === "oval") {
    c.fillStyle = art.accent; c.fillRect(x, y, w, h);
    foil((k) => { k.lineWidth = 3; k.beginPath(); k.ellipse(cx, y + h / 2, w * 0.45, h * 0.44, 0, 0, TAU); k.stroke(); });
    c.fillStyle = art.paper; c.beginPath(); c.ellipse(cx, y + h / 2, w * 0.43, h * 0.41, 0, 0, TAU); c.fill();
    c.fillStyle = art.accent; paintCrest(c, art.crest, cx, y + h * 0.23, h * 0.17);
    c.fillStyle = art.ink; c.fillRect(x + w * 0.04, y + h * 0.37, w * 0.92, h * 0.27);
    c.fillStyle = art.paper; fitText(c, art.brand, cx, y + h * 0.51, w * 0.84, h * 0.22, art.font, art.weight ?? "");
    c.fillStyle = art.ink; fitText(c, art.tag, cx, y + h * 0.73, w * 0.56, h * 0.085, SANS, "bold"); fitText(c, art.small, cx, y + h * 0.83, w * 0.42, h * 0.05, SANS);
  } else {
    c.fillStyle = art.accent; c.beginPath(); c.moveTo(x, y + h * 0.62); c.lineTo(x + w, y + h * 0.42); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath(); c.fill();
    c.fillStyle = art.ink; paintCrest(c, art.crest, x + w * 0.16, y + h * 0.24, h * 0.3);
    fitText(c, art.brand, x + w * 0.6, y + h * 0.27, w * 0.68, h * 0.3, art.font, art.weight ?? "");
    c.fillStyle = art.paper; fitText(c, art.tag, cx, y + h * 0.72, w - 24, h * 0.14, SANS, "bold"); fitText(c, art.small, cx, y + h * 0.89, w - 30, h * 0.07, SANS);
  }
  P.grain(x, y, w, h, { colour: 0.14, size: 1.5 });
}

function paintSmalls(scale: number, grain: Grain, anisotropy: number): Maps {
  const P = new Painter(SMALLS_W, SMALLS_H, scale, scale / 2, grain), c = P.a, random = rng(2207);
  P.ink("rgb(120,120,120)", [0, 0.6, 0], 0.5).rect(0, 0, SMALLS_W, SMALLS_H);
  const liquid = (x: number, y: number, w: number, h: number) => {
    const fade = c.createLinearGradient(0, y, 0, y + h);
    fade.addColorStop(0, "rgb(255,255,255)"); fade.addColorStop(0.2, "rgb(226,226,226)"); fade.addColorStop(1, "rgb(168,168,168)");
    c.fillStyle = fade; c.fillRect(x - 4, y - 4, w + 8, h + 8);
    P.ink(null, [1, 0.1, 0], 0.5).rect(x - 4, y - 4, w + 8, h + 8);
  };
  /** Foil or enamel over metal: a sleeve with drawn-down wrinkles and a band near its foot. */
  const foilSide = (x: number, y: number, w: number, h: number, colour: string, band: string, metal = 0.85) => {
    P.ink(colour, [0, 0.4, metal], 0.5).rect(x, y, w, h);
    for (let i = 0; i < 60; i += 1) { const lx = x + random() * w, top = y + random() * h * 0.5; P.ink(random() > 0.5 ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.14)", null, 0.5 + (random() - 0.5) * 0.5).line([lx, top, lx + (random() - 0.5) * 3, top + h * (0.3 + random() * 0.6)], 0.8 + random()); }
    P.ink(band, [0, 0.3, metal], 0.62).rect(x, y + h * 0.8, w, h * 0.07).rect(x, y + h * 0.9, w, h * 0.025);
  };
  const discTop = (x: number, y: number, s: number, colour: string, mark: string, crest: Crest, metal = 0.85, letter = "") => {
    P.ink(colour, [0, 0.36, metal], 0.5).rect(x, y, s, s);
    P.ink(null, null, 0.75).line(Array.from({ length: 33 }, (_, i) => [x + s / 2 + Math.cos((i / 32) * TAU) * s * 0.36, y + s / 2 + Math.sin((i / 32) * TAU) * s * 0.36]).flat(), 2.4);
    c.fillStyle = c.strokeStyle = mark;
    if (letter) fitText(c, letter, x + s / 2, y + s / 2 + 1, s * 0.5, s * 0.46, BLOCK); else paintCrest(c, crest, x + s / 2, y + s / 2, s * 0.44);
  };
  /** Skirt of a crown cap or the ribbed side of a lid: `flutes` ridges across the cell. */
  const fluted = (x: number, y: number, w: number, h: number, colour: string, flutes: number, metal = 0.85, from = 0) => {
    P.ink(colour, [0, 0.4, metal], 0.5).rect(x, y, w, h);
    for (let i = 0; i < flutes; i += 1) {
      const fx = x + ((i + 0.5) / flutes) * w, fw = (w / flutes) * 0.5;
      P.ink("rgba(0,0,0,0.3)", null, 0.2).rect(fx - fw / 2, y + h * from, fw, h * (1 - from));
      P.ink("rgba(255,255,255,0.22)", null, 0.85).rect(fx + fw / 2, y + h * from, fw * 0.5, h * (1 - from));
    }
  };

  // -- Wine: label, capsule, cork end ------------------------------------------------------------
  const wines: Array<[LabelArt, string, string]> = [
    [{ layout: "classic", paper: "rgb(238,230,208)", ink: "rgb(40,26,22)", accent: "rgb(150,112,40)", brand: "CHÂTEAU SILVER I", font: SERIF, tag: "Grand Vin de Garde", small: "MIS EN BOUTEILLE AU SPAWN|1999 · 75 cl · 12,5% vol", crest: "shield", foil: true }, "rgb(92,18,26)", "rgb(190,150,60)"],
    [{ layout: "band", paper: "rgb(244,240,230)", ink: "rgb(52,34,28)", accent: "rgb(150,52,30)", brand: "LONG A", font: SERIF, weight: "bold", tag: "Rosso Riserva 1999", small: "TENUTA INFERNO · COLLINE DEL SUD|750 ml · 13,5% vol", crest: "sun" }, "rgb(24,22,22)", "rgb(170,60,36)"],
    [{ layout: "classic", paper: "rgb(22,24,28)", ink: "rgb(214,186,112)", accent: "rgb(206,172,88)", brand: "JUAN DEAG", font: SERIF, tag: "Blanco Seco", small: "BODEGA JUAN DEAG · UN SOLO TIRO|75 cl · 12% vol", crest: "bird", foil: true }, "rgb(196,160,70)", "rgb(240,226,170)"],
  ];
  wines.forEach(([art, foil, band], k) => {
    const x = k * 256;
    paintLabel(P, x, 0, 256, 256, art);
    foilSide(x, 256, 192, 96, foil, band);
    discTop(x + 192, 256, 64, foil, band, art.crest);
    liquid(x + 196, 324, 24, 56);
  });
  // -- Spirits -----------------------------------------------------------------------------------
  const spirits: Array<[LabelArt, string, string]> = [
    [{ layout: "classic", paper: "rgb(232,222,196)", ink: "rgb(34,30,26)", accent: "rgb(134,36,30)", brand: "GLOBAL ELITE", font: SERIF, weight: "bold", tag: "Blended Malt · Aged 12 Rounds", small: "DISTILLED AND BOTTLED IN OVERTIME|70 cl · 43% vol", crest: "bird" }, "rgb(20,20,22)", "rgb(190,150,70)"],
    [{ layout: "band", paper: "rgb(236,220,178)", ink: "rgb(30,22,18)", accent: "rgb(24,22,24)", brand: "NINJA DEFUSE", font: BLOCK, tag: "Dark Navy Rum", small: "BLENDED IN SMOKE · BATCH No 040|700 ml · 40% vol", crest: "anchor" }, "rgb(150,34,26)", "rgb(230,206,150)"],
    [{ layout: "bold", paper: "rgb(238,242,246)", ink: "rgb(24,52,120)", accent: "rgb(24,52,120)", brand: "NO STOP", font: BLOCK, tag: "CRYSTAL VODKA", small: "TRIPLE FILTERED · 70 cl · 40% vol", crest: "diamond" }, "rgb(196,200,206)", "rgb(30,60,130)"],
  ];
  spirits.forEach(([art, cap, band], k) => {
    const x = 768 + k * 256;
    paintLabel(P, x, 0, 224, 288, art);
    liquid(x + 228, 8, 24, 240);
    fluted(x, 288, 192, 96, cap, 46, k === 2 ? 0.9 : 0.1, 0); P.ink(band, [0, 0.35, 0.6], 0.6).rect(x, 288 + 78, 192, 6);
    discTop(x + 192, 288, 64, cap, band, art.crest, k === 2 ? 0.9 : 0.1);
  });
  // -- Sauces and oils ---------------------------------------------------------------------------
  const sauces: Array<[LabelArt, string, string]> = [
    [{ layout: "bold", paper: "rgb(250,214,60)", ink: "rgb(170,26,20)", accent: "rgb(170,26,20)", brand: "MOLLY", font: BLOCK, tag: "HOT CHILI SAUCE", small: "FIRE IN THE HOLE · 150 ml", crest: "flame" }, "rgb(176,30,24)", "rgb(250,214,60)"],
    [{ layout: "classic", paper: "rgb(240,236,214)", ink: "rgb(46,70,30)", accent: "rgb(160,130,50)", brand: "FULL BUY", font: SERIF, tag: "Extra Virgin", small: "COLD PRESSED OLIVE OIL|250 ml", crest: "leaf" }, "rgb(36,58,30)", "rgb(190,160,70)"],
    [{ layout: "band", paper: "rgb(240,234,220)", ink: "rgb(24,20,18)", accent: "rgb(150,26,22)", brand: "SHADOW DAGGERS", font: BLOCK, tag: "Dark Soy Sauce", small: "NOBODY'S FIRST PICK|150 ml", crest: "drop" }, "rgb(24,22,22)", "rgb(170,36,28)"],
  ];
  sauces.forEach(([art, cap, band], k) => {
    const x = 1536 + k * 168;
    paintLabel(P, x, 0, 168, 128, art);
    fluted(x, 128, 104, 64, cap, 30, 0.05, 0.25);
    discTop(x + 104, 128, 64, cap, band, "none", 0.05);
    liquid(x + 4, 196, 24, 56);
  });
  // -- Beer --------------------------------------------------------------------------------------
  const beers: Array<[LabelArt, string, string]> = [
    [{ layout: "oval", paper: "rgb(244,236,212)", ink: "rgb(150,28,26)", accent: "rgb(196,160,64)", brand: "CLUTCH", font: BLOCK, tag: "PREMIUM PILS", small: "33 cl · 4,8% vol", crest: "hops", foil: true }, "rgb(196,160,64)", "rgb(150,28,26)"],
    [{ layout: "oval", paper: "rgb(240,232,204)", ink: "rgb(30,74,48)", accent: "rgb(30,74,48)", brand: "FORCE BUY", font: SERIF, weight: "bold", tag: "AMBER ALE", small: "330 ml · 5,2% vol", crest: "leaf" }, "rgb(30,74,48)", "rgb(240,232,204)"],
    [{ layout: "oval", paper: "rgb(28,26,26)", ink: "rgb(204,170,84)", accent: "rgb(204,170,84)", brand: "OVERTIME", font: SERIF, weight: "bold", tag: "EXPORT STOUT", small: "33 cl · 6,5% vol", crest: "anchor", foil: true }, "rgb(24,22,22)", "rgb(204,170,84)"],
  ];
  beers.forEach(([art, cap, mark], k) => {
    const x = k * 384, y = 384;
    paintLabel(P, x, y, 384, 192, art.layout === "oval" && k === 2 ? { ...art, ink: "rgb(204,170,84)", paper: "rgb(28,26,26)" } : art);
    if (k === 2) { c.fillStyle = "rgb(28,26,26)"; fitText(c, art.brand, x + 192, y + 192 * 0.51, 384 * 0.84, 192 * 0.22, art.font, "bold"); }
    discTop(x, y + 192, 64, cap, mark, "none", 0.8, art.brand[0]);
    fluted(x + 64, y + 192, 128, 32, cap, 21, 0.8, 0.3);
    P.ink(art.accent, [0, 0.72, 0], 0.5).rect(x + 192, y + 192, 160, 64); c.fillStyle = art.paper; fitText(c, art.brand, x + 272, y + 224, 140, 26, art.font, art.weight ?? "");
    liquid(x + 356, y + 196, 24, 56);
  });
  // -- Soda --------------------------------------------------------------------------------------
  const sodas: Array<[LabelArt, string, string]> = [
    [{ layout: "bold", paper: "rgb(250,246,240)", ink: "rgb(250,246,240)", accent: "rgb(130,20,22)", brand: "DECOY", font: SCRIPT, weight: "bold", tag: "COLA", small: "SOUNDS LIKE THE REAL THING · 250 ml", crest: "none" }, "rgb(196,32,30)", "rgb(250,246,240)"],
    [{ layout: "bold", paper: "rgb(40,110,60)", ink: "rgb(40,110,60)", accent: "rgb(250,222,60)", brand: "EZ PZ", font: BLOCK, tag: "CITRON", small: "LEMON SQUEEZY · 250 ml", crest: "sun" }, "rgb(250,222,60)", "rgb(40,110,60)"],
    [{ layout: "bold", paper: "rgb(250,246,236)", ink: "rgb(26,60,140)", accent: "rgb(236,120,24)", brand: "ONE TAP", font: BLOCK, tag: "ORANGE", small: "WITH REAL JUICE · 250 ml", crest: "drop" }, "rgb(26,60,140)", "rgb(250,246,236)"],
  ];
  sodas.forEach(([art, cap, mark], k) => {
    const x = 1152 + k * 256, y = 384;
    if (k === 0) { P.ink("rgb(196,32,30)", [0, 0.6, 0], 0.5).rect(x, y, 256, 160); c.fillStyle = "rgb(250,246,240)"; fitText(c, "Decoy", x + 128, y + 62, 220, 76, SCRIPT, "bold"); c.fillRect(x + 30, y + 104, 196, 3); fitText(c, "C O L A", x + 128, y + 126, 200, 24, SANS, "bold"); fitText(c, "SOUNDS LIKE THE REAL THING · 250 ml", x + 128, y + 148, 220, 10, SANS); }
    else { P.ink(k === 1 ? "rgb(250,240,170)" : "rgb(250,246,236)", [0, 0.6, 0], 0.5).rect(x, y, 256, 160); paintLabel(P, x, y, 256, 160, art); }
    discTop(x, y + 160, 64, cap, mark, "none", 0.8, art.brand[0]);
    fluted(x + 64, y + 160, 128, 32, cap, 21, 0.8, 0.3);
    liquid(x + 196, y + 164, 24, 56);
  });
  // -- Preserving jars: what is inside, the label, the lid ----------------------------------------
  const jars: Array<[LabelArt, string, string]> = [
    [{ layout: "band", paper: "rgb(240,236,220)", ink: "rgb(36,60,30)", accent: "rgb(40,84,44)", brand: "1 v 5", font: SERIF, weight: "bold", tag: "Dill Pickles", small: "FOR WHEN YOU ARE IN ONE · 680 g", crest: "leaf" }, "rgb(44,92,50)", "rgb(230,224,200)"],
    [{ layout: "band", paper: "rgb(238,232,212)", ink: "rgb(40,40,30)", accent: "rgb(30,30,32)", brand: "PIT", font: BLOCK, tag: "Green Olives", small: "WHOLE · PITTED AT A SITE · 350 g", crest: "drop" }, "rgb(28,28,30)", "rgb(200,170,90)"],
    [{ layout: "classic", paper: "rgb(248,236,196)", ink: "rgb(70,44,14)", accent: "rgb(200,140,24)", brand: "HOLO", font: SERIF, weight: "bold", tag: "Wildflower Honey", small: "STICKY · GOLD · 454 g", crest: "bee" }, "rgb(206,166,60)", "rgb(90,56,16)"],
    [{ layout: "band", paper: "rgb(240,230,208)", ink: "rgb(60,30,20)", accent: "rgb(150,40,28)", brand: "SPRAY", font: SERIF, weight: "bold", tag: "Whole Spice Mix", small: "PEPPER · CORIANDER · CONTROL · 180 g", crest: "sun" }, "rgb(160,40,30)", "rgb(240,230,208)"],
  ];
  jars.forEach(([art, lid, mark], k) => {
    const x = k * 256, y = 640, w = 256, h = 224;
    P.clip(x, y, w, h, () => {
      if (k === 0) {
        const brine = c.createLinearGradient(0, y, 0, y + h); brine.addColorStop(0, "rgb(150,150,62)"); brine.addColorStop(1, "rgb(92,98,34)");
        c.fillStyle = brine; c.fillRect(x, y, w, h); P.ink(null, [0, 0.14, 0], 0.5).rect(x, y, w, h);
        P.around(w, () => {
          for (let i = 0; i < 9; i += 1) {
            const gx = x + (i + 0.5) * (w / 9) + (random() - 0.5) * 8, lean = (random() - 0.5) * 0.16, top = y + 26 + random() * 22, green = 96 + random() * 34;
            c.save(); c.translate(gx, y + h); c.rotate(lean);
            const body = c.createLinearGradient(-13, 0, 13, 0); body.addColorStop(0, `rgb(${green * 0.5},${green * 0.72},26)`); body.addColorStop(0.45, `rgb(${green * 0.86},${green + 18},44)`); body.addColorStop(1, `rgb(${green * 0.42},${green * 0.62},22)`);
            c.fillStyle = body; c.beginPath(); c.roundRect(-13, top - (y + h), 26, y + h - top + 10, 12); c.fill();
            for (let j = 0; j < 26; j += 1) { c.fillStyle = `rgba(${random() > 0.5 ? "190,206,110" : "40,62,18"},0.5)`; c.beginPath(); c.arc((random() - 0.5) * 20, (top - (y + h)) * random(), 1 + random() * 1.3, 0, TAU); c.fill(); }
            c.restore();
          }
          for (let i = 0; i < 16; i += 1) { c.strokeStyle = "rgba(34,70,24,0.8)"; c.lineWidth = 1; const fx = x + random() * w, fy = y + 18 + random() * 150; c.beginPath(); for (let j = 0; j < 7; j += 1) { c.moveTo(fx, fy); c.lineTo(fx + (random() - 0.5) * 22, fy + (random() - 0.5) * 26); } c.stroke(); }
          for (let i = 0; i < 26; i += 1) { c.fillStyle = random() > 0.4 ? "rgb(28,22,16)" : "rgb(206,176,64)"; c.beginPath(); c.arc(x + random() * w, y + h - 6 - random() * random() * 180, 2.2 + random() * 1.2, 0, TAU); c.fill(); }
        });
      } else if (k === 1) {
        const brine = c.createLinearGradient(0, y, 0, y + h); brine.addColorStop(0, "rgb(150,146,72)"); brine.addColorStop(1, "rgb(88,90,36)");
        c.fillStyle = brine; c.fillRect(x, y, w, h); P.ink(null, [0, 0.14, 0], 0.5).rect(x, y, w, h);
        P.around(w, () => {
          for (let row = 0; row < 8; row += 1) for (let i = 0; i < 8; i += 1) {
            const ox = x + (i + (row % 2) * 0.5) * 32 + (random() - 0.5) * 8, oy = y + h - 12 - row * 25 + (random() - 0.5) * 6, dark = random() > 0.84, turn = random() * 3;
            const skin = c.createRadialGradient(ox - 4, oy - 5, 1, ox, oy, 17);
            if (dark) { skin.addColorStop(0, "rgb(96,70,84)"); skin.addColorStop(1, "rgb(26,16,24)"); } else { const g0 = 120 + random() * 30; skin.addColorStop(0, `rgb(${g0 + 46},${g0 + 50},70)`); skin.addColorStop(0.6, `rgb(${g0 - 6},${g0 + 6},40)`); skin.addColorStop(1, `rgb(${g0 * 0.45},${g0 * 0.5},18)`); }
            c.fillStyle = skin; c.beginPath(); c.ellipse(ox, oy, 16, 12.5, turn, 0, TAU); c.fill();
            if (!dark && random() > 0.55) { c.fillStyle = "rgb(188,44,26)"; c.beginPath(); c.arc(ox + Math.cos(turn) * 12, oy + Math.sin(turn) * 9, 3.6, 0, TAU); c.fill(); }
          }
        });
      } else if (k === 2) {
        const honey = c.createLinearGradient(0, y, 0, y + h); honey.addColorStop(0, "rgb(236,170,40)"); honey.addColorStop(0.5, "rgb(214,134,18)"); honey.addColorStop(1, "rgb(150,78,8)");
        c.fillStyle = honey; c.fillRect(x, y, w, h); P.ink(null, [1, 0.1, 0], 0.5).rect(x, y, w, h);
        P.around(w, () => {
          for (let i = 0; i < 40; i += 1) { c.fillStyle = `rgba(255,226,140,${0.1 + random() * 0.25})`; c.beginPath(); c.arc(x + random() * w, y + 6 + random() * random() * 80, 0.8 + random() * 1.8, 0, TAU); c.fill(); }
          // A piece of comb sunk in it.
          c.save(); c.translate(x + 150, y + 136); c.rotate(0.25); c.fillStyle = "rgba(246,200,84,0.75)"; c.fillRect(-40, -52, 80, 104); c.strokeStyle = "rgba(170,100,10,0.7)"; c.lineWidth = 1.3;
          for (let row = 0; row < 11; row += 1) for (let i = 0; i < 8; i += 1) { const hx = -36 + i * 10.4 + (row % 2) * 5.2, hy = -47 + row * 9; if (hx > 36) continue; c.beginPath(); for (let v = 0; v < 6; v += 1) { const a = (v / 6) * TAU + Math.PI / 6; if (v) c.lineTo(hx + Math.cos(a) * 5.6, hy + Math.sin(a) * 5.6); else c.moveTo(hx + Math.cos(a) * 5.6, hy + Math.sin(a) * 5.6); } c.closePath(); c.stroke(); }
          c.restore();
        });
      } else {
        P.ink("rgb(70,44,26)", [1, 0.5, 0], 0.5).rect(x, y, w, h);
        P.around(w, () => {
          const tones = ["rgb(34,26,22)", "rgb(52,36,28)", "rgb(190,150,96)", "rgb(206,170,112)", "rgb(170,36,22)", "rgb(196,60,28)", "rgb(96,104,50)", "rgb(226,196,120)"];
          for (let i = 0; i < 1500; i += 1) {
            const sx = x + random() * w, sy = y + random() * h, tone = tones[Math.floor(random() * tones.length)], r = 2.4 + random() * 2.6;
            c.fillStyle = tone; c.beginPath();
            if (tone.startsWith("rgb(1") && tone.includes("36,22") || tone.includes("60,28")) c.ellipse(sx, sy, r * 1.5, r * 0.6, random() * 3, 0, TAU); else c.arc(sx, sy, r, 0, TAU);
            c.fill();
            c.fillStyle = "rgba(255,255,255,0.16)"; c.beginPath(); c.arc(sx - r * 0.3, sy - r * 0.3, r * 0.35, 0, TAU); c.fill();
          }
        });
      }
    });
    paintLabel(P, x, y + 224, 256, 128, art);
    // Lid: pressed rings, a safety button, and a ribbed skirt.
    const lx = x, ly = y + 352, ring = (r: number, height: number, width: number) => P.ink(null, null, height).line(Array.from({ length: 41 }, (_, i) => [lx + 48 + Math.cos((i / 40) * TAU) * r, ly + 48 + Math.sin((i / 40) * TAU) * r]).flat(), width);
    P.ink(lid, [0, 0.34, 0.7], 0.5).rect(lx, ly, 96, 96);
    if (k === 3) { for (let i = 0; i < 8; i += 1) { c.fillStyle = "rgba(250,244,232,0.85)"; c.fillRect(lx + i * 12, ly, 6, 96); } for (let i = 0; i < 8; i += 1) { c.fillStyle = "rgba(250,244,232,0.5)"; c.fillRect(lx, ly + i * 12, 96, 6); } P.ink(null, [0, 0.8, 0]).rect(lx, ly, 96, 96); }
    ring(40, 0.85, 3); ring(30, 0.3, 2); ring(11, 0.8, 2.5);
    c.fillStyle = mark; if (k !== 3) arcText(c, `${art.brand} · ${art.brand}`, lx + 48, ly + 48, 21, 8.5, SANS, 0.96);
    fluted(lx + 96, ly, 160, 48, lid, 24, k === 3 ? 0 : 0.7, 0.2);
  });
  // -- Printed tins --------------------------------------------------------------------------------
  const tins: Array<[string, string, string, string, string, Crest]> = [
    ["rgb(176,40,28)", "rgb(238,206,120)", "rgb(30,24,22)", "PAPRIKA", "SMOKED · MID", "flame"],
    ["rgb(28,76,84)", "rgb(232,196,96)", "rgb(240,232,210)", "SAFFRON TEA", "FINE LEAF BLEND", "sun"],
    ["rgb(206,162,54)", "rgb(60,34,22)", "rgb(60,34,22)", "CUMIN", "SEED 661", "leaf"],
    ["rgb(58,84,50)", "rgb(236,222,180)", "rgb(236,222,180)", "CARDAMOM", "GREEN PODS", "diamond"],
  ];
  tins.forEach(([ground, trim, ink, name, sub, crest], k) => {
    const x = 1024 + (k % 2) * 512, y = 640 + Math.floor(k / 2) * 288, w = 512, h = 208;
    P.clip(x, y, w, h, () => {
      P.ink(ground, [0, 0.36, 0.35], 0.5).rect(x, y, w, h);
      // Lithographed bands top and bottom: lozenges and beading.
      for (const by of [y + 6, y + h - 30]) {
        P.ink(trim, [0, 0.3, 0.6], 0.56).rect(x, by, w, 24);
        c.fillStyle = ground; for (let i = 0; i < 32; i += 1) { const lx = x + i * 16 + 8; c.beginPath(); c.moveTo(lx, by + 4); c.lineTo(lx + 6, by + 12); c.lineTo(lx, by + 20); c.lineTo(lx - 6, by + 12); c.closePath(); c.fill(); }
      }
      for (const by of [y + 36, y + h - 38]) for (let i = 0; i < 64; i += 1) { c.fillStyle = trim; c.beginPath(); c.arc(x + i * 8 + 4, by, 1.7, 0, TAU); c.fill(); }
      // Two cartouches a half turn apart, a scroll between them.
      for (const cxm of [x + 128, x + 384]) {
        c.fillStyle = trim; c.beginPath(); c.ellipse(cxm, y + h / 2, 106, 58, 0, 0, TAU); c.fill();
        c.fillStyle = ground; c.beginPath(); c.ellipse(cxm, y + h / 2, 100, 52, 0, 0, TAU); c.fill();
        c.fillStyle = c.strokeStyle = trim; paintCrest(c, crest, cxm, y + h / 2 - 28, 30);
        c.fillStyle = ink === ground ? trim : ink; if (ink === "rgb(30,24,22)" || ink === "rgb(60,34,22)") c.fillStyle = trim;
        fitText(c, name, cxm, y + h / 2 + 6, 170, 34, SERIF, "bold"); fitText(c, sub, cxm, y + h / 2 + 30, 150, 12, SANS, "bold");
      }
      for (const cxm of [x, x + 256, x + 512]) { c.strokeStyle = trim; c.lineWidth = 2; for (const flip of [-1, 1]) { c.beginPath(); c.moveTo(cxm, y + h / 2 - 36); c.bezierCurveTo(cxm + flip * 22, y + h / 2 - 20, cxm + flip * 22, y + h / 2 + 20, cxm, y + h / 2 + 36); c.stroke(); } c.fillStyle = trim; fitText(c, "SPRAY", cxm, y + h / 2 - 4, 30, 8, SANS, "bold"); fitText(c, "TRADING Co", cxm, y + h / 2 + 6, 30, 7, SANS); }
      // Scuffs through to the tinplate.
      for (let i = 0; i < 40; i += 1) { const sx = x + random() * w, sy = y + random() * h; P.ink("rgba(196,198,196,0.6)", [0, 0.3, 1], null).line([sx, sy, sx + (random() - 0.5) * 16, sy + (random() - 0.5) * 5], 0.7 + random()); }
    });
    P.grain(x, y, w, h, { colour: 0.12, rough: 0.3, size: 2 });
    discTop(x, y + 208, 80, ground, trim, crest, 0.4);
    P.ink(trim, [0, 0.3, 0.7], 0.5).rect(x + 80, y + 208, 256, 32); P.ink(ground, [0, 0.36, 0.4], 0.4).rect(x + 80, y + 218, 256, 12);
  });
  return P.finish(0.05, anisotropy);
}

// ---------------------------------------------------------------------------------------------
// Produce atlas: fruit and vegetable skins (stalk end at the top of each cell), and loose goods
// ---------------------------------------------------------------------------------------------

const PRODUCE_W = 2048, PRODUCE_H = 1024;
/** Skins wrap sideways, so they are inset at the poles only. */
const skinCell = (x: number, y: number, w: number, h: number, padU = 1, padV = 3): Rect => [(x + padU) / PRODUCE_W, 1 - (y + h - padV) / PRODUCE_H, (x + w - padU) / PRODUCE_W, 1 - (y + padV) / PRODUCE_H];
const FRUIT = {
  watermelon: skinCell(0, 0, 512, 512), melon: skinCell(512, 0, 512, 256), pomegranate: skinCell(512, 256, 256, 256), tomato: skinCell(768, 256, 256, 256),
  apple: skinCell(1024, 0, 256, 256), banana: skinCell(1792, 0, 128, 512, 3, 2), pepper: skinCell(1024, 256, 256, 256), onion: skinCell(1280, 256, 256, 256),
  orange: skinCell(0, 512, 256, 256), lemon: skinCell(256, 512, 256, 256), garlic: skinCell(512, 512, 256, 256),
  grape: skinCell(768, 512, 128, 128, 6, 6), stem: skinCell(896, 512, 128, 128, 6, 6), leaf: skinCell(768, 640, 256, 128, 6, 6),
  grain: skinCell(1024, 512, 256, 256, 8, 8),
};
const GRAINS = 8;

function paintProduce(scale: number, grain: Grain, anisotropy: number): Maps {
  const P = new Painter(PRODUCE_W, PRODUCE_H, scale, scale / 2, grain), c = P.a, h = P.h, random = rng(9113);
  P.ink("rgb(110,100,80)", [0, 0.7, 0], 0.5).rect(0, 0, PRODUCE_W, PRODUCE_H);
  /** Skin colour from the stalk end down, its roughness, and whether the instance tint reaches it. */
  const skin = (x: number, y: number, w: number, hh: number, top: string, bottom: string, rough: number, mask = 1) => {
    const fade = c.createLinearGradient(0, y, 0, y + hh);
    fade.addColorStop(0, top); fade.addColorStop(1, bottom);
    c.fillStyle = fade; c.fillRect(x, y, w, hh);
    P.ink(null, [mask, rough, 0], 0.5).rect(x, y, w, hh);
  };
  /** A wash across the cell that fades down (or up) from one of its ends. */
  const end = (x: number, y: number, w: number, hh: number, depth: number, colour: string, atTop = true) => {
    const fade = c.createLinearGradient(0, atTop ? y : y + hh, 0, atTop ? y + depth : y + hh - depth);
    fade.addColorStop(0, colour); fade.addColorStop(1, colour.replace(/[\d.]+\)$/, "0)"));
    c.fillStyle = fade; c.fillRect(x, atTop ? y : y + hh - depth, w, depth);
  };
  /** Many discs in one path on each layer: [x, y, r, x, y, r, ...]. */
  const discs = (layers: Ctx[], points: number[]) => {
    for (const k of layers) { k.beginPath(); for (let i = 0; i < points.length; i += 3) { k.moveTo(points[i] + points[i + 2], points[i + 1]); k.arc(points[i], points[i + 1], points[i + 2], 0, TAU); } k.fill(); }
  };
  const scatter = (n: number, x: number, y: number, w: number, hh: number, r0: number, r1: number) => { const out: number[] = []; for (let i = 0; i < n; i += 1) out.push(x + random() * w, y + random() * hh, r0 + random() * (r1 - r0)); return out; };
  /** Strokes running from pole to pole with a little wander, as one path. */
  const streaks = (n: number, x: number, y: number, w: number, hh: number, colour: string, width: number, reach = 1, skip?: (sx: number) => boolean) => {
    c.strokeStyle = colour; c.lineWidth = width; c.beginPath();
    for (let i = 0; i < n; i += 1) {
      const sx = x + random() * w, from = y + random() * hh * (1 - reach), length = hh * reach * (0.5 + random() * 0.5);
      if (skip?.(sx - x)) continue;
      c.moveTo(sx, from); c.bezierCurveTo(sx + (random() - 0.5) * 8, from + length * 0.33, sx + (random() - 0.5) * 8, from + length * 0.66, sx + (random() - 0.5) * 6, from + length);
    }
    c.stroke();
  };
  const cell = (x: number, y: number, w: number, hh: number, draw: () => void) => P.clip(x, y, w, hh, () => P.around(w, draw));

  // -- Watermelon: ragged dark bands from end to end ------------------------------------------------
  cell(0, 0, 512, 512, () => {
    skin(0, 0, 512, 512, "rgb(64,112,46)", "rgb(58,104,42)", 0.52);
    const lane = rng(77);
    for (let i = 0; i < 5; i += 1) {
      const sx = (i + 0.5) * 102.4, left: number[][] = [], right: number[][] = [];
      for (let k = 0; k <= 40; k += 1) { const yy = k * 12.8, taper = 0.3 + 0.7 * Math.sin((Math.PI * k) / 40); left.push([sx - (9 + lane() * 16) * taper, yy]); right.push([sx + (9 + lane() * 16) * taper, yy]); }
      c.fillStyle = "rgb(24,56,26)"; c.beginPath(); c.moveTo(left[0][0], left[0][1]);
      for (const [px, py] of left) c.lineTo(px, py);
      for (const [px, py] of right.reverse()) c.lineTo(px, py);
      c.closePath(); c.fill();
      c.strokeStyle = "rgba(24,56,26,0.75)"; c.lineWidth = 1.6; c.beginPath();
      for (let k = 0; k < 70; k += 1) { const yy = 20 + lane() * 472, side = lane() > 0.5 ? 1 : -1, from = sx + side * (6 + lane() * 16); c.moveTo(from, yy); c.quadraticCurveTo(from + side * 14, yy + (lane() - 0.5) * 24, from + side * (16 + lane() * 22), yy + (lane() - 0.5) * 40); }
      c.stroke();
    }
    end(0, 0, 512, 512, 30, "rgba(40,70,30,0.8)"); end(0, 0, 512, 512, 22, "rgba(150,140,80,0.6)", false);
  });
  P.grain(0, 0, 512, 512, { colour: 0.22, size: 2, rough: 0.3 });
  // -- Netted melon -------------------------------------------------------------------------------
  cell(512, 0, 512, 256, () => {
    skin(512, 0, 512, 256, "rgb(186,172,124)", "rgb(196,182,132)", 0.86);
    c.fillStyle = "rgba(104,128,80,0.4)"; for (let i = 0; i < 5; i += 1) c.fillRect(512 + (i + 0.5) * 102.4 - 5, 0, 10, 256);
    // The cell is twice as wide as it is tall for a skin that is not: the net is drawn squashed to come out even.
    for (const layer of [c, h]) {
      const lay = rng(31);
      layer.save(); layer.translate(512, 0); layer.scale(1, 0.5);
      layer.strokeStyle = layer === c ? "rgba(232,224,196,0.9)" : "rgb(205,205,205)"; layer.lineWidth = 2.3; layer.beginPath();
      for (let i = 0; i < 3600; i += 1) { const x = lay() * 512, y = lay() * 512, a = lay() * TAU, l = 5 + lay() * 9; layer.moveTo(x, y); layer.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (lay() - 0.5) * 5, y + Math.sin(a) * l * 0.5 + (lay() - 0.5) * 5, x + Math.cos(a) * l, y + Math.sin(a) * l); }
      layer.stroke(); layer.restore();
    }
    end(512, 0, 512, 256, 14, "rgba(120,110,70,0.8)");
  });
  // -- Apples: streaked red, green, and yellow with a blush -----------------------------------------
  cell(1024, 0, 256, 256, () => {
    skin(1024, 0, 256, 256, "rgb(190,186,84)", "rgb(206,194,90)", 0.3);
    const blush = c.createLinearGradient(1024, 0, 1280, 0);
    blush.addColorStop(0, "rgba(160,22,28,0.82)"); blush.addColorStop(0.16, "rgba(160,22,28,0.3)"); blush.addColorStop(0.38, "rgba(160,22,28,0.3)"); blush.addColorStop(0.56, "rgba(160,22,28,0.82)"); blush.addColorStop(1, "rgba(160,22,28,0.82)");
    c.fillStyle = blush; c.fillRect(1024, 0, 256, 256);
    streaks(520, 1024, 0, 256, 256, "rgba(150,16,24,0.5)", 4, 0.8, (sx) => Math.abs(sx - 70) < 44 && random() > 0.25);
    streaks(200, 1024, 0, 256, 256, "rgba(120,10,20,0.4)", 2, 0.6, (sx) => Math.abs(sx - 70) < 50);
    c.fillStyle = "rgba(244,228,176,0.8)"; discs([c], scatter(170, 1024, 16, 256, 224, 0.6, 1.2));
    end(1024, 0, 256, 256, 30, "rgba(128,112,56,0.85)"); end(1024, 0, 256, 256, 16, "rgba(60,44,26,0.85)", false);
  });
  cell(1280, 0, 256, 256, () => {
    skin(1280, 0, 256, 256, "rgb(132,172,58)", "rgb(152,186,70)", 0.28);
    streaks(120, 1280, 0, 256, 256, "rgba(190,210,110,0.3)", 5, 0.7);
    c.fillStyle = "rgba(226,240,190,0.75)"; discs([c], scatter(220, 1280, 16, 256, 224, 0.6, 1.3));
    end(1280, 0, 256, 256, 26, "rgba(120,120,50,0.8)"); end(1280, 0, 256, 256, 16, "rgba(60,50,26,0.85)", false);
  });
  cell(1536, 0, 256, 256, () => {
    skin(1536, 0, 256, 256, "rgb(226,200,84)", "rgb(232,206,96)", 0.3);
    streaks(260, 1536, 0, 256, 256, "rgba(216,92,56,0.32)", 5, 0.75, (sx) => Math.abs(sx - 150) > 70);
    c.fillStyle = "rgba(130,96,40,0.7)"; discs([c], scatter(180, 1536, 16, 256, 224, 0.6, 1.1));
    end(1536, 0, 256, 256, 28, "rgba(140,116,50,0.85)"); end(1536, 0, 256, 256, 16, "rgba(70,50,26,0.85)", false);
  });
  // -- Bananas: yellow, and riper with sugar spots ----------------------------------------------------
  for (const k of [0, 1]) {
    const x = 1792 + k * 128;
    P.clip(x, 0, 128, 512, () => {
      skin(x, 0, 128, 512, k ? "rgb(218,174,46)" : "rgb(216,184,58)", k ? "rgb(206,160,40)" : "rgb(204,172,50)", 0.5);
      // Bruises where the hand has been handled.
      for (let i = 0; i < (k ? 9 : 5); i += 1) { const bx = x + random() * 128, by = 60 + random() * 400, br = 6 + random() * 14, bruise = c.createRadialGradient(bx, by, 0, bx, by, br); bruise.addColorStop(0, "rgba(104,70,22,0.4)"); bruise.addColorStop(1, "rgba(104,70,22,0)"); c.fillStyle = bruise; c.fillRect(bx - br, by - br, br * 2, br * 2); }
      c.fillStyle = "rgba(150,116,30,0.5)"; for (let i = 0; i <= 5; i += 1) c.fillRect(x + i * 25.6 - 1.5, 0, 3, 512);
      P.ink(null, null, 0.72); for (let i = 0; i <= 5; i += 1) P.rect(x + i * 25.6 - 2.5, 0, 5, 512);
      streaks(60, x, 0, 128, 512, "rgba(120,86,24,0.35)", 1, 0.3);
      c.fillStyle = "rgba(84,52,18,0.75)"; discs([c], scatter(k ? 190 : 30, x, 40, 128, 440, 0.7, k ? 2.6 : 1.4));
      end(x, 0, 128, 512, 80, k ? "rgba(140,130,40,0.9)" : "rgba(120,150,46,0.95)"); end(x, 0, 128, 512, 22, "rgba(70,52,26,1)");
      end(x, 0, 128, 512, 40, "rgba(120,100,40,0.8)", false); end(x, 0, 128, 512, 16, "rgba(30,22,14,1)", false);
    });
  }
  // -- Pomegranate, tomato, pepper (white, tinted), onions ---------------------------------------------
  cell(512, 256, 256, 256, () => {
    skin(512, 256, 256, 256, "rgb(150,30,40)", "rgb(176,40,46)", 0.46);
    for (let i = 0; i < 16; i += 1) { const px = 512 + random() * 256, py = 280 + random() * 220, r = 12 + random() * 30, glow = c.createRadialGradient(px, py, 0, px, py, r); glow.addColorStop(0, "rgba(220,150,84,0.5)"); glow.addColorStop(1, "rgba(220,150,84,0)"); c.fillStyle = glow; c.fillRect(px - r, py - r, r * 2, r * 2); }
    c.fillStyle = "rgba(90,16,24,0.5)"; discs([c], scatter(260, 512, 256, 256, 256, 0.6, 1.6));
    end(512, 256, 256, 256, 30, "rgba(96,30,30,0.9)"); end(512, 256, 256, 256, 14, "rgba(110,40,30,0.7)", false);
  });
  P.grain(512, 256, 256, 256, { colour: 0.3, size: 1.5, height: 0.2, rough: 0.2 });
  cell(768, 256, 256, 256, () => {
    skin(768, 256, 256, 256, "rgb(196,36,20)", "rgb(206,30,18)", 0.2);
    end(768, 256, 256, 256, 46, "rgba(196,120,26,0.7)"); end(768, 256, 256, 256, 14, "rgba(96,110,30,0.8)");
    streaks(40, 768, 256, 256, 256, "rgba(236,90,50,0.22)", 6, 0.5);
    end(768, 256, 256, 256, 8, "rgba(120,40,20,0.8)", false);
  });
  cell(1024, 256, 256, 256, () => {
    skin(1024, 256, 256, 256, "rgb(214,214,214)", "rgb(240,240,240)", 0.15);
    streaks(30, 1024, 256, 256, 256, "rgba(0,0,0,0.07)", 12, 0.9); streaks(24, 1024, 256, 256, 256, "rgba(255,255,255,0.4)", 8, 0.8);
    end(1024, 256, 256, 256, 20, "rgba(120,120,120,0.7)");
  });
  [["rgb(190,120,48)", "rgb(204,134,56)", "rgba(116,62,18,0.34)", "rgba(244,200,124,0.3)", "rgba(206,176,122,0.95)"], ["rgb(122,34,76)", "rgb(138,40,84)", "rgba(66,12,42,0.4)", "rgba(220,156,186,0.28)", "rgba(196,150,136,0.95)"]].forEach(([top, bottom, dark, light, neck], k) => {
    const x = 1280 + k * 256;
    cell(x, 256, 256, 256, () => {
      skin(x, 256, 256, 256, top, bottom, 0.42);
      streaks(260, x, 256, 256, 256, dark, 1.2, 0.95); streaks(200, x, 256, 256, 256, light, 1.6, 0.9);
      for (let i = 0; i < 7; i += 1) { c.fillStyle = light.replace(/[\d.]+\)$/, "0.5)"); c.beginPath(); c.ellipse(x + random() * 256, 300 + random() * 170, 8 + random() * 16, 18 + random() * 30, (random() - 0.5) * 0.4, 0, TAU); c.fill(); }
      end(x, 256, 256, 256, 64, neck); end(x, 256, 256, 256, 18, "rgba(226,214,186,0.95)", false);
    });
    P.grain(x, 256, 256, 256, { rough: 0.5, size: 2, stretch: 3 });
  });
  // -- Citrus: pores sunk into the peel ---------------------------------------------------------------
  [[0, "rgb(236,130,20)", "rgb(240,138,24)", "rgba(184,84,6,0.5)", "rgba(100,104,40,0.95)", "rgba(206,104,14,0.8)"], [256, "rgb(238,204,36)", "rgb(240,210,44)", "rgba(190,150,10,0.45)", "rgba(160,176,44,0.75)", "rgba(170,176,40,0.6)"]].forEach(([x0, top, bottom, pore, stalk, tip]) => {
    const x = x0 as number;
    cell(x, 512, 256, 256, () => {
      skin(x, 512, 256, 256, top as string, bottom as string, 0.46);
      const pores = scatter(1500, x, 512, 256, 256, 0.6, 1.25);
      c.fillStyle = pore as string; h.fillStyle = "rgb(88,88,88)"; discs([c, h], pores);
      end(x, 512, 256, 256, x ? 30 : 10, stalk as string); end(x, 512, 256, 256, x ? 30 : 12, tip as string, false);
    });
    P.grain(x, 512, 256, 256, { colour: 0.14, size: 2, rough: 0.25 });
  });
  // -- Garlic ---------------------------------------------------------------------------------------
  cell(512, 512, 256, 256, () => {
    skin(512, 512, 256, 256, "rgb(226,216,196)", "rgb(236,230,216)", 0.6, 0);
    streaks(90, 512, 512, 256, 256, "rgba(150,92,132,0.3)", 3, 0.8); streaks(160, 512, 512, 256, 256, "rgba(150,132,104,0.3)", 1, 0.95);
    end(512, 512, 256, 256, 70, "rgba(206,188,150,0.95)"); end(512, 512, 256, 256, 16, "rgba(124,100,72,0.95)", false);
  });
  // -- Grape skin (white, tinted), woody stalk, leaf ----------------------------------------------------
  skin(768, 512, 128, 128, "rgb(222,222,222)", "rgb(236,236,236)", 0.24);
  c.fillStyle = "rgba(255,255,255,0.3)"; discs([c], scatter(40, 768, 512, 128, 128, 4, 12));
  P.grain(768, 512, 128, 128, { rough: 0.6, size: 1, colour: 0.2 });
  skin(896, 512, 128, 128, "rgb(104,88,48)", "rgb(84,74,40)", 0.8, 0);
  streaks(90, 896, 512, 128, 128, "rgba(50,40,20,0.5)", 1.2, 0.9); streaks(40, 896, 512, 128, 128, "rgba(160,150,90,0.4)", 1, 0.9);
  skin(768, 640, 256, 128, "rgb(52,104,38)", "rgb(70,124,44)", 0.55, 0);
  c.strokeStyle = "rgba(150,186,96,0.6)"; c.lineWidth = 1.4; c.beginPath();
  for (let i = 0; i < 12; i += 1) { c.moveTo(768 + i * 22, 640); c.lineTo(768 + i * 22 + 8, 768); for (let j = 0; j < 5; j += 1) { c.moveTo(768 + i * 22 + j * 1.6, 650 + j * 24); c.lineTo(768 + i * 22 + 11, 662 + j * 24); } }
  c.stroke();
  // -- Loose goods, seen from above: each grain laid down with its highlight and its own height ----------
  const goods: Array<{ ground: string; tones: string[]; n: number; rx: number; ry: number; rough: number; mask?: number; crease?: boolean; curl?: number }> = [
    { ground: "rgb(150,140,118)", tones: ["rgb(240,234,214)", "rgb(230,222,198)", "rgb(246,241,226)"], n: 900, rx: 5.6, ry: 1.9, rough: 0.6 },
    { ground: "rgb(120,50,20)", tones: ["rgb(226,112,40)", "rgb(212,94,32)", "rgb(236,132,58)"], n: 620, rx: 4.5, ry: 4.3, rough: 0.6 },
    { ground: "rgb(26,16,10)", tones: ["rgb(74,42,22)", "rgb(60,32,16)", "rgb(90,54,28)"], n: 330, rx: 7.4, ry: 5.2, rough: 0.38, crease: true },
    { ground: "rgb(228,224,216)", tones: [], n: 0, rx: 0, ry: 0, rough: 0.95, mask: 1 },
    { ground: "rgb(140,108,60)", tones: ["rgb(226,196,130)", "rgb(212,180,114)", "rgb(234,206,146)"], n: 300, rx: 7.6, ry: 7, rough: 0.62 },
    { ground: "rgb(60,14,10)", tones: ["rgb(150,24,16)", "rgb(118,16,12)", "rgb(172,40,20)"], n: 230, rx: 17, ry: 3.6, rough: 0.34, curl: 1 },
    { ground: "rgb(50,18,16)", tones: ["rgb(122,30,34)", "rgb(102,22,28)", "rgb(138,42,44)"], n: 280, rx: 8.6, ry: 5.2, rough: 0.28 },
    { ground: "rgb(84,56,32)", tones: ["rgb(178,122,72)", "rgb(160,106,60)", "rgb(190,138,86)"], n: 230, rx: 10.5, ry: 6.2, rough: 0.6, crease: true },
  ];
  goods.forEach((kind, index) => {
    const x = 1024 + (index % 4) * 256, y = 512 + Math.floor(index / 4) * 256, w = 256;
    P.clip(x, y, w, w, () => {
      P.ink(kind.ground, [kind.mask ?? 0, kind.rough, 0], 0.3).rect(x, y, w, w);
      if (!kind.n) { P.ink(null, null, 0.5).rect(x, y, w, w); return; }
      const lay = rng(index * 7 + 3), list: number[][] = [];
      for (let i = 0; i < kind.n; i += 1) list.push([x + lay() * w, y + lay() * w, lay() * Math.PI, 0.85 + lay() * 0.3, Math.floor(lay() * kind.tones.length)]);
      const path = (layer: Ctx, only: number, grow: number, dx: number, dy: number) => {
        layer.beginPath();
        for (const [gx, gy, turn, size, tone] of list) {
          if (only >= 0 && tone !== only) continue;
          // Grains near an edge are drawn again across it, so the cell tiles.
          const ox = gx < x + 20 ? w : gx > x + w - 20 ? -w : 0, oy = gy < y + 20 ? w : gy > y + w - 20 ? -w : 0;
          for (let copy = 0; copy < 3; copy += 1) {
            if ((copy === 1 && !ox) || (copy === 2 && !oy)) continue;
            const cx = gx + (copy === 1 ? ox : 0) + dx, cy = gy + (copy === 2 ? oy : 0) + dy, rx = kind.rx * size * grow, ry = kind.ry * size * grow;
            layer.moveTo(cx + Math.cos(turn) * rx, cy + Math.sin(turn) * rx);
            layer.ellipse(cx, cy, rx, ry, turn, 0, TAU);
          }
        }
      };
      // Shadow under each, then the grains by tone, their highlights, and the relief.
      c.fillStyle = "rgba(0,0,0,0.35)"; path(c, -1, 1.12, 0.8, 1.2); c.fill();
      kind.tones.forEach((tone, t) => { c.fillStyle = tone; path(c, t, 1, 0, 0); c.fill(); });
      c.fillStyle = "rgba(255,255,255,0.2)"; path(c, -1, 0.5, -0.6, -0.9); c.fill();
      h.fillStyle = "rgb(150,150,150)"; path(h, -1, 1, 0, 0); h.fill(); h.fillStyle = "rgb(200,200,200)"; path(h, -1, 0.6, 0, 0); h.fill();
      if (kind.crease) { c.strokeStyle = "rgba(20,10,6,0.6)"; c.lineWidth = 1.1; c.beginPath(); for (const [gx, gy, turn, size] of list) { c.moveTo(gx - Math.cos(turn) * kind.rx * size * 0.75, gy - Math.sin(turn) * kind.rx * size * 0.75); c.lineTo(gx + Math.cos(turn) * kind.rx * size * 0.75, gy + Math.sin(turn) * kind.rx * size * 0.75); } c.stroke(); }
    });
    if (!kind.n) P.grain(x, y, w, w, { colour: 0.3, size: 1, height: 0.5, table: "coarse" }).grain(x, y, w, w, { colour: 0.2, size: 0.5, height: 0.3, table: "fine" });
  });
  return P.finish(0.045, anisotropy);
}

// ---------------------------------------------------------------------------------------------
// Ceramic atlas: a glazed pot (left) and an earthenware one (right), rim at the top, foot below
// ---------------------------------------------------------------------------------------------

const POT = { glazed: [1 / 1024, 4 / 1024, 511 / 1024, 1020 / 1024] as Rect, earthen: [513 / 1024, 4 / 1024, 1023 / 1024, 1020 / 1024] as Rect };

function paintCeramic(scale: number, grain: Grain, anisotropy: number): Maps {
  const P = new Painter(1024, 1024, scale, scale / 2, grain), c = P.a, random = rng(5521);
  const wave = (x: number) => 868 + 12 * Math.sin((x / 512) * TAU * 3 + 1) + 8 * Math.sin((x / 512) * TAU * 7 + 2.3);
  const chips = (x0: number, colour: string, mask: number, random: () => number) => {
    for (let i = 0; i < 5; i += 1) {
      const x = x0 + random() * 512, w = 3 + random() * 8, d = 3 + random() * 7, points = [x - w, 0];
      for (let k = 0; k <= 6; k += 1) points.push(x - w + (2 * w * k) / 6, d * Math.sin((Math.PI * k) / 6) * (0.7 + random() * 0.5) + 1);
      points.push(x + w, 0);
      P.ink(colour, [mask, 0.92, 0], 0.3).poly(points);
    }
  };
  /** A soft patch: a wash of colour, more roughness, and less of the instance tint showing through. */
  const blot = (x: number, y: number, r: number, tone: string, alpha: number, rough: number, mask: number) => {
    const soft = (context: Ctx, inner: string, outer: string, mode: GlobalCompositeOperation) => {
      const fill = context.createRadialGradient(x, y, 0, x, y, r);
      fill.addColorStop(0, inner); fill.addColorStop(1, outer);
      context.save(); context.globalCompositeOperation = mode; context.fillStyle = fill; context.fillRect(x - r, y - r, r * 2, r * 2); context.restore();
    };
    soft(P.a, `rgba(${tone},${alpha})`, `rgba(${tone},0)`, "source-over");
    soft(P.o, `rgb(0,${Math.round(rough * 255)},0)`, "rgb(0,0,0)", "lighter");
    soft(P.o, `rgb(${Math.round(mask * 255)},255,255)`, "rgb(255,255,255)", "multiply");
  };
  // -- Glazed: a glass skin of uneven thickness. It runs, gathers above the bare foot, goes thin and brown
  // over the rim, crazes, pinholes, and holds dust low down. The same strokes every pass, so the cell tiles.
  P.clip(0, 0, 512, 1024, () => P.around(512, () => {
    const random = rng(7717);
    P.ink("rgb(222,222,216)", [1, 0.36, 0], 0.56).rect(0, 0, 512, 1024);
    // Thickness: broad soft runs down the wall, darker and glossier where the glaze lies thick.
    for (let i = 0; i < 70; i += 1) {
      const x = random() * 512, y = random() * 640, length = 160 + random() * 380, w = 14 + random() * 44, thick = random() > 0.4;
      const run = (context: Ctx, peak: string, clear: string) => {
        const fill = context.createLinearGradient(0, y, 0, y + length);
        fill.addColorStop(0, clear); fill.addColorStop(0.5, peak); fill.addColorStop(1, clear); context.fillStyle = fill;
        for (const k of [0, 0.16, 0.3, 0.4]) context.fillRect(x + w * k, y, w * (1 - 2 * k), length);
      };
      run(c, thick ? "rgba(0,0,0,0.05)" : "rgba(255,246,232,0.045)", thick ? "rgba(0,0,0,0)" : "rgba(255,246,232,0)");
      if (thick) { P.o.save(); P.o.globalCompositeOperation = "multiply"; run(P.o, "rgba(255,170,255,0.3)", "rgba(255,170,255,0)"); P.o.restore(); }
    }
    // Throwing rings: faint ridges, and lows where a little more glaze has settled.
    for (let y = 46; y < 850; y += 18 + random() * 34) {
      const low = random() > 0.5;
      P.alpha(0.7).ink(low ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.03)", null, low ? 0.535 : 0.585).rect(0, y, 512, 2 + random() * 3.5);
    }
    P.alpha(1);
    // The glaze gathers before it stops: a darker band over a rounded edge, then bare clay down to the foot.
    const edge: number[] = [];
    for (let x = -8; x <= 520; x += 8) edge.push(x, wave(x));
    const pool = c.createLinearGradient(0, 770, 0, 880);
    pool.addColorStop(0, "rgba(0,0,0,0)"); pool.addColorStop(1, "rgba(0,0,0,0.22)"); c.fillStyle = pool; c.fillRect(0, 770, 512, 110);
    P.ink("rgb(166,110,76)", [0, 0.9, 0], 0.4).poly([-8, 1024, ...edge, 520, 1024]);
    P.ink("rgba(40,30,22,0.35)", null, 0.72).line(edge.map((value, index) => (index % 2 ? value - 4 : value)), 7);
    // Runs that got further before the kiln froze them, each ending in a bead.
    for (let i = 0; i < 5; i += 1) {
      const x = 30 + random() * 452, top = wave(x) - 6, length = 20 + random() * 40, w = 3.5 + random() * 3;
      P.ink("rgb(198,198,192)", [1, 0.14, 0], 0.78).poly([x - w * 1.7, top, x - w, top + length * 0.5, x - w, top + length, x + w, top + length, x + w, top + length * 0.5, x + w * 1.7, top]).oval(x, top + length, w * 1.25, w * 1.5);
    }
    // Thin over the rim: the body shows through brown, drier and untinted.
    const thin = c.createLinearGradient(0, 0, 0, 40);
    thin.addColorStop(0, "rgba(98,64,38,0.8)"); thin.addColorStop(1, "rgba(98,64,38,0)"); c.fillStyle = thin; c.fillRect(0, 0, 512, 40);
    const bare = P.o.createLinearGradient(0, 0, 0, 40), dry = P.o.createLinearGradient(0, 0, 0, 40);
    bare.addColorStop(0, "rgb(90,255,255)"); bare.addColorStop(1, "rgb(255,255,255)"); dry.addColorStop(0, "rgb(0,80,0)"); dry.addColorStop(1, "rgb(0,0,0)");
    P.o.save(); P.o.globalCompositeOperation = "multiply"; P.o.fillStyle = bare; P.o.fillRect(0, 0, 512, 40); P.o.globalCompositeOperation = "lighter"; P.o.fillStyle = dry; P.o.fillRect(0, 0, 512, 40); P.o.restore();
    chips(0, "rgb(158,110,78)", 0, random);
    // Dry patches where it went on thin, and dust that has settled on the lower wall and the foot.
    for (let i = 0; i < 7; i += 1) blot(random() * 512, 60 + random() * 760, 14 + random() * 26, "150,104,74", 0.55, 0.3, 0.86);
    for (let i = 0; i < 60; i += 1) blot(random() * 512, 955 - random() ** 1.6 * 300, 16 + random() * 26, "150,128,104", 0.22, 0.2, 0.93);
    // Crazing, pinholes and iron specks.
    P.ink("rgba(58,44,30,0.3)", null, 0.5);
    for (let i = 0; i < 230; i += 1) {
      let x = random() * 512, y = 30 + random() * 800, turn = random() * TAU;
      const path = [x, y];
      for (let k = 0; k < 5; k += 1) { turn += (random() - 0.5) * 1.6; x += Math.cos(turn) * (7 + random() * 12); y += Math.sin(turn) * (7 + random() * 12); path.push(x, y); }
      P.line(path, 0.75);
    }
    P.ink("rgba(52,36,24,0.75)", [0.4, 0.75, 0], 0.3).dots(random, 150, 0, 24, 512, 830, 0.55, 1.2, false);
    P.ink("rgba(96,58,28,0.7)", [0.15, 0.5, 0], null).dots(random, 60, 0, 24, 512, 830, 0.9, 2.4, false);
  }));
  P.grain(0, 0, 512, 866, { colour: 0.4, size: 4, table: "coarse" }).grain(0, 0, 512, 866, { colour: 0.14, size: 1.5, rough: 0.45, table: "mid" }).grain(0, 0, 512, 866, { rough: 0.6, size: 6, height: 0.5, table: "coarse" }).grain(0, 880, 512, 144, { colour: 0.3, size: 1, height: 0.3, table: "fine" });
  // -- Earthenware: throwing rings, a slipped frieze, lime bloom and a sooty foot ---------------------
  P.clip(512, 0, 512, 1024, () => P.around(512, () => {
    P.ink("rgb(224,214,202)", [1, 0.86, 0], 0.5).rect(512, 0, 512, 1024);
    for (let y = 8; y < 1020; y += 9 + random() * 13) { P.alpha(0.5).ink(random() > 0.5 ? "rgba(0,0,0,0.09)" : "rgba(255,255,255,0.12)", null, random() > 0.5 ? 0.4 : 0.6).rect(512, y, 512, 2 + random() * 3); }
    P.alpha(1);
    const SLIP = "rgb(92,46,32)";
    P.ink(SLIP, [0, 0.93, 0], 0.52);
    for (const y of [118, 132, 236, 326, 640, 654, 668]) P.rect(512, y, 512, y === 236 || y === 326 ? 7 : 4);
    const zig: number[] = [];
    for (let x = 0; x <= 512; x += 32) zig.push(512 + x, (x / 32) % 2 ? 262 : 310);
    P.line(zig, 6);
    for (let x = 16; x < 512; x += 64) { P.oval(512 + x + 16, 268, 5).oval(512 + x - 16, 304, 5); }
    for (let i = 0; i < 26; i += 1) { const x = 512 + random() * 512, y = 60 + random() * 800, r = 24 + random() * 60, bloom = c.createRadialGradient(x, y, 0, x, y, r); bloom.addColorStop(0, "rgba(246,240,226,0.34)"); bloom.addColorStop(1, "rgba(246,240,226,0)"); c.fillStyle = bloom; c.fillRect(x - r, y - r, r * 2, r * 2); }
    const soot = c.createLinearGradient(0, 820, 0, 1024); soot.addColorStop(0, "rgba(44,32,26,0)"); soot.addColorStop(1, "rgba(44,32,26,0.6)"); c.fillStyle = soot; c.fillRect(512, 820, 512, 204);
    const lip = c.createLinearGradient(0, 0, 0, 30); lip.addColorStop(0, "rgba(60,40,30,0.5)"); lip.addColorStop(1, "rgba(60,40,30,0)"); c.fillStyle = lip; c.fillRect(512, 0, 512, 30);
    chips(512, "rgb(240,228,214)", 1, random);
  }));
  P.grain(512, 0, 512, 1024, { colour: 0.3, size: 2.5, table: "mid" }).grain(512, 0, 512, 1024, { colour: 0.16, size: 1.2, height: 0.09, rough: 0.2, table: "fine" });
  return P.finish(0.04, anisotropy);
}

// ---------------------------------------------------------------------------------------------
// The prop shader: a standard material with masked instance tint, a decal layer, wear and glass
// ---------------------------------------------------------------------------------------------

type PropShader = {
  /** Instance tint applies where the ORM red channel is set (atlases keep labels, stems and rust untinted). */
  mask?: boolean;
  /** Recolours a photographed green paint: the value is the gain that brings its green channel to one. */
  key?: number;
  /** Vertex alpha below one marks liquid: dark toward the silhouette, lit from behind by the room. */
  liquid?: boolean;
  /** Blended shell: instance tint is the colour the glass lets through, vertex alpha its thickness. */
  glass?: boolean;
  /** Skin over wet flesh: light that gets in comes back out of the shaded side and the silhouette, in the fruit's own colour. */
  flesh?: boolean;
  /** Second texture laid over the base through `decalUv`: stencils left of u = 0.5, full-colour labels right of it. */
  decal?: { map: THREE.Texture; roughness: number; fray: number };
  /** Vertex alpha below one wears the finish through to this. */
  wear?: { colour: THREE.ColorRepresentation; roughness: number; metalness: number; scale: number; bias?: number; soft?: number };
  noise?: THREE.Texture;
};

/** v above this in the label half of the marks atlas is glossy (packing tape). */
const GLOSS_LINE = 1 - 72 / 2048;

const VERTEX_PARS = /* glsl */`
attribute vec2 decalUv;
attribute vec4 propShift;
varying vec3 vPropTint;
varying vec2 vDecalUv;
`;

const VERTEX_UV = /* glsl */`
#ifdef USE_MAP
  vMapUv += propShift.xy;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv += propShift.xy;
#endif
#ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv += propShift.xy;
#endif
#ifdef USE_METALNESSMAP
  vMetalnessMapUv += propShift.xy;
#endif
vDecalUv = decalUv;
// 2 and up: a decal that stays put. 0..1: one that moves with the variant. Below 0: none.
// An absent instanced attribute reads (0, 0, 0, 1), hence the one taken off w.
if ( decalUv.x >= 2.0 ) vDecalUv.x -= 2.0; else if ( decalUv.x >= 0.0 ) vDecalUv += vec2( propShift.z, propShift.w - 1.0 );
`;

const VERTEX_COLOUR = /* glsl */`
vColor = vec4( 1.0 );
#ifdef USE_COLOR_ALPHA
  vColor *= color;
#elif defined( USE_COLOR )
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vPropTint = instanceColor.rgb;
#else
  vPropTint = vec3( 1.0 );
#endif
`;

const FRAGMENT_PARS = /* glsl */`
varying vec3 vPropTint;
varying vec2 vDecalUv;
#ifdef PROP_DECAL
  uniform sampler2D propDecal;
  uniform vec4 propDecalFx;
#endif
#if defined( PROP_DECAL ) || defined( PROP_WEAR )
  uniform sampler2D propNoise;
#endif
#ifdef PROP_WEAR
  uniform vec3 propWearColour;
  uniform vec4 propWearFx;
  uniform float propWearSoft;
#endif
float propInk = 0.0;
float propGloss = 0.0;
float propWorn = 0.0;
`;

const FRAGMENT_COLOUR = /* glsl */`
#ifdef PROP_GLASS
  {
    // Glass scatters next to nothing: what colour it has comes through it, and its darkness is what it holds back.
    float propDark = clamp( 1.0 - dot( vPropTint, vec3( 0.3, 0.55, 0.15 ) ), 0.0, 1.0 );
    diffuseColor.rgb = vPropTint * ( 0.012 + propDark * 0.1 ) * vColor.rgb;
    diffuseColor.a = clamp( mix( 0.05, 0.8, propDark ) + ( 1.0 - vColor.a ) * 0.5, 0.0, 1.0 );
  }
#else
  {
    #ifdef PROP_KEY
      float propRust = smoothstep( -0.008, 0.02, diffuseColor.r - diffuseColor.g );
      diffuseColor.rgb = mix( vPropTint * ( 0.35 + 0.65 * diffuseColor.g * PROP_KEY ), diffuseColor.rgb * 2.2, propRust );
    #elif defined( PROP_MASK ) && defined( USE_ROUGHNESSMAP )
      diffuseColor.rgb *= mix( vec3( 1.0 ), vPropTint, texture2D( roughnessMap, vRoughnessMapUv ).r );
    #else
      diffuseColor.rgb *= vPropTint;
    #endif
    #ifdef PROP_WEAR
      vec4 propChip = texture2D( propNoise, vMapUv * propWearFx.z );
      propWorn = smoothstep( 0.0, propWearSoft, ( 1.0 - vColor.a ) * 0.9 + propWearFx.w + propChip.r * 0.6 - 0.6 );
      diffuseColor.rgb = mix( diffuseColor.rgb, propWearColour * ( 0.5 + propChip.g + propChip.b * 0.6 ), propWorn );
    #endif
    #ifdef PROP_DECAL
      vec4 propMark = texture2D( propDecal, vDecalUv );
      vec4 propFray = texture2D( propNoise, vDecalUv * 37.0 );
      float propOn = step( 0.0, vDecalUv.x );
      float propCover = propMark.a;
      if ( vDecalUv.x < 0.5 ) propCover = smoothstep( 0.4, 0.6, propCover + ( propFray.g * 0.75 + propFray.r * 0.25 - 0.5 ) * propDecalFx.y );
      else propGloss = step( propDecalFx.z, vDecalUv.y ) * propCover * propOn;
      propCover *= propOn * ( 1.0 - propWorn );
      diffuseColor.rgb = mix( diffuseColor.rgb, pow( propMark.rgb / max( propMark.a, 0.004 ), vec3( 2.2 ) ) * 0.7, propCover );
      propInk = propCover;
    #endif
    diffuseColor.rgb *= vColor.rgb;
  }
#endif
`;

const FRAGMENT_SURFACE = /* glsl */`
#ifdef PROP_DECAL
  roughnessFactor = mix( mix( roughnessFactor, propDecalFx.x, propInk ), 0.22, propGloss );
  metalnessFactor *= 1.0 - propInk;
#endif
#ifdef PROP_WEAR
  roughnessFactor = mix( roughnessFactor, propWearFx.x, propWorn );
  metalnessFactor = mix( metalnessFactor, propWearFx.y, propWorn );
#endif
`;

/** A hollow bottle has no solid edge to mirror the room: without this every silhouette wears a bright line indoors. */
const FRAGMENT_GLASS = /* glsl */`
#ifdef PROP_GLASS
  material.specularF90 = 0.22;
#endif
`;

const FRAGMENT_VIEW = /* glsl */`
#ifdef PROP_GLASS
  {
    float propEdge = 1.0 - abs( dot( normal, normalize( vViewPosition ) ) );
    float propRim = propEdge * propEdge;
    propRim *= propRim;
    diffuseColor.a = mix( diffuseColor.a, 1.0, propRim * 0.45 );
    #ifdef USE_ENVMAP
      // Coloured glass shows its colour by the light that comes through it from behind.
      totalEmissiveRadiance += vPropTint * getIBLIrradiance( - normal ) * RECIPROCAL_PI * diffuseColor.a * 0.5 * ( 1.0 - propRim );
      // The long highlights a doorway or a strip of sky lays down the side of a bottle.
      if ( gl_FrontFacing ) {
        float propStreak = pow( max( dot( normal, vec3( -0.557, 0.253, 0.791 ) ), 0.0 ), 90.0 ) + 0.5 * pow( max( dot( normal, vec3( 0.704, 0.1, 0.704 ) ), 0.0 ), 140.0 );
        totalEmissiveRadiance += getIBLIrradiance( normal ) * RECIPROCAL_PI * propStreak * 1.6;
      }
    #endif
  }
#endif
#if defined( PROP_FLESH ) && defined( USE_ENVMAP )
  {
    float propGraze = 1.0 - abs( dot( normal, normalize( vViewPosition ) ) );
    vec3 propWarm = diffuseColor.rgb * sqrt( diffuseColor.rgb ) * vec3( 1.25, 1.0, 0.72 );
    totalEmissiveRadiance += propWarm * RECIPROCAL_PI * ( getIBLIrradiance( - normal ) * 0.55 + getIBLIrradiance( normal ) * propGraze * propGraze * 0.5 );
  }
#endif
#ifdef PROP_LIQUID
  {
    float propDeep = 1.0 - vColor.a;
    vec3 propView = normalize( vViewPosition );
    float propEdge = 1.0 - abs( dot( normal, propView ) );
    #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
      // What lies behind, bent through the liquid and stained by it.
      vec3 propRay = transformDirectionByInverseViewMatrix( refract( - propView, normal, 0.75 ), viewMatrix );
      totalEmissiveRadiance += pow( diffuseColor.rgb, vec3( 1.25 ) ) * textureCubeUV( envMap, envMapRotation * propRay, 0.3 ).rgb * envMapIntensity * propDeep * 1.5 * ( 1.0 - 0.55 * propEdge * propEdge );
    #endif
    diffuseColor.rgb *= 1.0 - propDeep * ( 0.6 + propEdge * propEdge * 0.35 );
  }
#endif
`;

function patch<M extends THREE.MeshStandardMaterial>(material: M, f: PropShader): M {
  material.vertexColors = true;
  const defines: Record<string, unknown> = { ...(material.defines ?? {}) };
  if (f.mask) defines.PROP_MASK = "";
  if (f.key) defines.PROP_KEY = f.key.toFixed(3);
  if (f.liquid) defines.PROP_LIQUID = "";
  if (f.glass) defines.PROP_GLASS = "";
  if (f.flesh) defines.PROP_FLESH = "";
  if (f.decal) defines.PROP_DECAL = "";
  if (f.wear) defines.PROP_WEAR = "";
  material.defines = defines;
  const uniforms: Record<string, THREE.IUniform> = {};
  if (f.decal) { uniforms.propDecal = { value: f.decal.map }; uniforms.propDecalFx = { value: new THREE.Vector4(f.decal.roughness, f.decal.fray, GLOSS_LINE, 0) }; }
  if (f.decal || f.wear) uniforms.propNoise = { value: f.noise ?? null };
  if (f.wear) { uniforms.propWearColour = { value: new THREE.Color(f.wear.colour) }; uniforms.propWearFx = { value: new THREE.Vector4(f.wear.roughness, f.wear.metalness, f.wear.scale, f.wear.bias ?? 0) }; uniforms.propWearSoft = { value: f.wear.soft ?? 0.07 }; }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <color_pars_vertex>", `#include <color_pars_vertex>\n${VERTEX_PARS}`)
      .replace("#include <uv_vertex>", `#include <uv_vertex>\n${VERTEX_UV}`)
      .replace("#include <color_vertex>", VERTEX_COLOUR);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <color_pars_fragment>", `#include <color_pars_fragment>\n${FRAGMENT_PARS}`)
      .replace("#include <color_fragment>", FRAGMENT_COLOUR)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${FRAGMENT_SURFACE}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAGMENT_VIEW}`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>\n${FRAGMENT_GLASS}`);
  };
  return material;
}

// ---------------------------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------------------------

type Draft = {
  parts: Array<{ geo: Geo; material: THREE.Material; slot?: 0 | 1 | -1; cast?: boolean; shift?: PropPart["shift"] }>;
  variants?: number;
  palette?: number[];
  palette2?: number[];
  /** The palette follows the variant (a label and its glass) instead of being dealt round the batch. */
  tied?: boolean;
  radius?: number;
  rest?: PropInfo["rest"];
  inside?: Room;
};

const NO_SHIFT: PropPart["shift"] = () => [0, 0, 0, 0];
const lazy = <T>(make: () => T) => { let value: T | undefined; return () => (value ??= make()); };
/** The photographed boards lie along u, thirteen to the tile, with their middles on v = k / 13. */
const PLANKS = 13, WOOD_TILE = 1.3;

export function createProps(kit: Kit, options: { seed?: number } = {}): Props {
  const { high, anisotropy, track } = kit;
  const baseSeed = options.seed ?? 1;
  /** Segment count for the quality in use, kept even. */
  const seg = (n: number) => (high ? n : Math.max(6, Math.round(n / 4) * 2));
  const px = high ? 1 : 0.5;
  /** Boxes keep their softened edges on HIGH only: a bevel costs 32 of a box's 44 triangles. */
  const box: typeof bevelBox = (g, cx, cy, cz, sx, sy, sz, o) => bevelBox(g, cx, cy, cz, sx, sy, sz, high ? o : { ...o, bevel: 0 });
  const noise = lazy(() => makeNoise(baseSeed * 131 + 7));
  const grain = lazy(() => makeGrain(noise()));
  const keep = (maps: Maps) => { track(maps.map); track(maps.normalMap); track(maps.ormMap); return maps; };
  const noiseMap = lazy(() => track(noiseTexture(noise(), anisotropy)));
  const marks = lazy(() => track(paintMarks(px, anisotropy)));
  const standard = (maps: Maps, parameters: THREE.MeshStandardMaterialParameters = {}) => track(new THREE.MeshStandardMaterial({ map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.ormMap, metalnessMap: maps.ormMap, roughness: 1, metalness: 1, ...parameters }));

  // ---- Materials ---------------------------------------------------------------------------
  const wood = lazy(() => patch(track(new THREE.MeshStandardMaterial({ ...kit.photoSet("/textures/weathered_brown_planks-2k", 1, 1, false), color: new THREE.Color(2.6, 2.7, 2.6), roughness: 1, metalness: 0, envMapIntensity: 0.5 })), { decal: { map: marks(), roughness: 0.9, fray: 1.05 }, noise: noiseMap() }));
  const paint = lazy(() => patch(track(new THREE.MeshStandardMaterial({ ...kit.photoSet("/textures/green_metal_rust-2k", 1, 1, false), roughness: 0.95, metalness: 0, envMapIntensity: 0.9 })), {
    key: 13.5, decal: { map: marks(), roughness: 0.6, fray: 0.8 }, wear: { colour: new THREE.Color(0.2, 0.105, 0.06), roughness: 0.62, metalness: 0.55, scale: 2.6, bias: 0.035 }, noise: noiseMap(),
  }));
  const iron = lazy(() => patch(standard(keep(metalTile(high ? 512 : 256, noise(), anisotropy)), { envMapIntensity: 1 }), { wear: { colour: new THREE.Color(0.105, 0.05, 0.026), roughness: 0.9, metalness: 0.1, scale: 1.3, soft: 0.3 }, noise: noiseMap() }));
  const plastic = lazy(() => patch(standard(keep(plasticTile(high ? 256 : 128, noise(), anisotropy)), { envMapIntensity: 0.8 }), { decal: { map: marks(), roughness: 0.55, fray: 0.3 }, noise: noiseMap() }));
  const glass = lazy(() => patch(track(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 0, envMapIntensity: 1.5, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  })), { glass: true }));
  const smalls = lazy(() => patch(standard(keep(paintSmalls(px, grain(), anisotropy)), { color: 0xcfcfcf }), { mask: true, liquid: true }));
  const produce = lazy(() => patch(standard(keep(paintProduce(px, grain(), anisotropy)), { color: 0xd4d4d4 }), { mask: true, flesh: true }));
  const ceramic = lazy(() => patch(standard(keep(paintCeramic(px, grain(), anisotropy)), { envMapIntensity: 0.85 }), { mask: true, wear: { colour: new THREE.Color(0.2, 0.105, 0.06), roughness: 0.8, metalness: 0, scale: 3.1, soft: 0.5 }, noise: noiseMap() }));
  const kraft = lazy(() => patch(standard(keep(kraftTile(high ? 512 : 256, noise(), anisotropy)), { envMapIntensity: 0.6 }), { decal: { map: marks(), roughness: 0.72, fray: 0.3 }, noise: noiseMap() }));
  const burlap = lazy(() => patch(standard(keep(burlapTile(high ? 512 : 256, noise(), anisotropy)), { envMapIntensity: 0.4 }), { decal: { map: marks(), roughness: 0.95, fray: 1.25 }, noise: noiseMap() }));
  const wicker = lazy(() => patch(standard(keep(wickerTile(high ? 512 : 256, noise(), anisotropy)), { envMapIntensity: 0.5 }), {}));

  // ---- Shared builders ------------------------------------------------------------------------
  /** A sawn board: grain along its longest side, end grain on its ends, and a tone of its own. */
  const board = (g: Geo, random: () => number, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: { bevel?: number; skip?: number; decal?: BoxOptions["decal"]; cuts?: BoxOptions["cuts"]; ends?: boolean; grain?: number; tone?: number } = {}) => {
    const size: V3 = [sx, sy, sz], grainAxis = o.grain ?? (sx >= sy && sx >= sz ? 0 : sy >= sz ? 1 : 2);
    const offset = random() * 5, plank = Math.floor(random() * PLANKS), endCell = random() > 0.5 ? 128 / MARKS : 0, tone = o.tone ?? 0.74 + random() * 0.26, alpha = g.shade[3];
    g.shade = [tone, tone * (0.97 + random() * 0.03), tone * (0.94 + random() * 0.06), alpha];
    box(g, cx, cy, cz, sx, sy, sz, {
      bevel: o.bevel ?? 0.0025, skip: o.skip, cuts: o.cuts,
      uv: (f, a, b) => {
        const face = FACES[f], right = axisOf(face.r), up = axisOf(face.u);
        if (axisOf(face.n) === grainAxis) return [offset + a / WOOD_TILE, plank / PLANKS + b / WOOD_TILE];
        const along = right === grainAxis ? a : b, across = right === grainAxis ? b : a, width = size[right === grainAxis ? up : right];
        return [offset + along / WOOD_TILE, plank / PLANKS + across / Math.max(WOOD_TILE, (width * PLANKS) / 0.84)];
      },
      decal: (f, a, b, mid) => {
        const face = FACES[f];
        if (axisOf(face.n) !== grainAxis) return o.decal?.(f, a, b, mid) ?? null;
        if (o.ends === false) return null;
        const w = size[axisOf(face.r)], h = size[axisOf(face.u)], reach = Math.max(w, h) * 1.1;
        return [2 + endCell + lerp(MARK.endGrain[0], MARK.endGrain[2], 0.5 + a / reach), lerp(MARK.endGrain[1], MARK.endGrain[3], 0.5 + b / reach)];
      },
    });
    g.shade = [1, 1, 1, alpha];
  };
  /** Head of a nail or screw sitting on a face of the given normal axis. */
  /** What a potter's hands leave: a body not quite round and a rim not quite level. The foot stays flat on the floor. */
  const handmade = (seed: number, top: number, oval = 0.014, tilt = 0.012): NonNullable<LatheOptions["shape"]> => {
    const random = rng(baseSeed * 97 + seed), p1 = random() * TAU, p2 = random() * TAU, p3 = random() * TAU;
    return (theta, r, y, out) => {
      const rise = smooth(0, top * 0.35, y), f = 1 + (oval * Math.sin(theta * 2 + p1) + oval * 0.4 * Math.sin(theta * 3 + p2)) * rise;
      out[0] *= f; out[2] *= f; out[1] += tilt * r * Math.sin(theta + p3) * (y / top) ** 2;
    };
  };
  /** Glaze by vertex: it pools dark in turned grooves and breaks to the clay over ridges and rims (alpha is its thickness). */
  const glazeOn = (grooves: number[], crests: number[], band?: (y: number) => RGBA | undefined) => (_theta: number, y: number): RGBA | undefined => {
    const near = (list: number[]) => list.some((at) => Math.abs(at - y) < 0.0012);
    return near(grooves) ? [0.6, 0.6, 0.6, 1] : near(crests) ? [1.05, 1.03, 1, 0.5] : band?.(y);
  };
  const nail = (g: Geo, x: number, y: number, z: number, f: number, r = 0.0032) => {
    if (!high) return;
    const face = FACES[f], keepShade = g.shade;
    g.shade = [0.2, 0.19, 0.18, 1];
    const lift = 0.0006, at = (a: number, b: number) => g.v(x + face.n[0] * lift + face.r[0] * a + face.u[0] * b, y + face.n[1] * lift + face.r[1] * a + face.u[1] * b, z + face.n[2] * lift + face.r[2] * a + face.u[2] * b, face.n[0], face.n[1], face.n[2], 0.31, 0.31);
    const ids = [at(-r, 0), at(0, -r), at(r, 0), at(0, r)];
    g.quad(ids[0], ids[1], ids[2], ids[3]);
    g.shade = keepShade;
  };
  /** Decal lookup for a flat window on a face: `a0..a1`, `b0..b1` in face offsets from the given centre. */
  const windowOn = (rect: Rect, a0: number, b0: number, a1: number, b1: number, fixed = false) => (a: number, b: number, mid: number): [number, number] | null =>
    mid > a0 && mid < a1 && b > b0 - 1e-6 && b < b1 + 1e-6 ? [lerp(rect[0], rect[2], (a - a0) / (a1 - a0)) + (fixed ? 2 : 0), lerp(rect[1], rect[3], (b - b0) / (b1 - b0))] : null;
  type BottleSpec = {
    segs: number; shell: ProfilePoint[]; liquid: ProfilePoint[]; cap: ProfilePoint[]; fill: number;
    labels: Array<{ at: number; span: number; y0: number; y1: number; rect: Rect }>;
    cells: { step: number[]; liquid: Rect; capSide: Rect; capTop: Rect };
    palette: number[]; palette2: number[];
    shape?: LatheOptions["shape"]; spacing?: LatheOptions["spacing"]; phase?: number;
  };
  /** Glass shell with holes where the paper sits, the labels in those holes, the liquid inside and the closure on top. */
  const bottle = (spec: BottleSpec): Draft => {
    const sm = new Geo(), sh = new Geo(), { segs, shape, spacing, phase } = spec, top = spec.shell[spec.shell.length - 1][1];
    // Thick glass at the foot and the lip takes more of what is behind it.
    lathe(sh, spec.shell, { segs, uv: [0, 0, 1, 1], shape, spacing, phase, crease: 1.2, windows: spec.labels.map((label) => ({ ...label, rect: undefined, hole: true })), colour: (_t, y) => [1, 1, 1, y < 0.011 ? 0.35 : y > top - 0.03 ? 0.75 : 1] });
    lathe(sm, spec.shell, { segs, uv: spec.labels[0].rect, shape, spacing, phase, windows: spec.labels, only: true, fit: true });
    sm.shade = [1, 1, 1, 0.3];
    const inner = spacing ? segs : Math.max(8, segs - 4), closure = Math.max(8, segs - 6);
    lathe(sm, [...spec.liquid, [0, spec.fill]], { segs: inner, uv: spec.cells.liquid, shape, spacing, phase, crease: 1.2 });
    sm.shade = [1, 1, 1, 1];
    const last = spec.cap[spec.cap.length - 1];
    lathe(sm, spec.cap, { segs: closure, uv: spec.cells.capSide, crease: 0.9 });
    lathe(sm, [last, [0, last[1] + 0.0004]], { segs: closure, uv: spec.cells.capTop, planar: last[0] });
    return {
      parts: [{ geo: sm, material: smalls(), slot: 1, shift: (variant) => [variant * spec.cells.step[0], 0, 0, 0] }, { geo: sh, material: glass(), slot: 0, cast: false }],
      variants: 3, palette: spec.palette, palette2: spec.palette2, tied: true, rest: "flat",
    };
  };
  /** A corrugated carton: soft edges, a slight bulge, tape, prints and a shipping label; open or crushed on request. */
  const carton = (W: number, H: number, D: number, o: { open?: boolean; crushed?: boolean } = {}): Draft => {
    const g = new Geo(), random = rng(baseSeed * 131 + Math.round(W * 1000) + Math.round(H * 77)), hx = W / 2, hy = H / 2, hz = D / 2, TILE = 0.32, tape = 0.03;
    const windows: SoftWindow[] = [], drop = Math.min(0.075, H * 0.4), strip = MARK.tape, tapeEnd: Rect = [strip[0], strip[1], lerp(strip[0], strip[2], 0.16), strip[3]];
    if (!o.open) {
      // Taped along the seam of the top flaps, the tape carried down both ends.
      // The crushed one has lost half its tape: it stops short of the middle and is gone from one end.
      const kept = o.crushed ? 0.56 : 1;
      windows.push({ face: 2, a0: -hx, b0: -tape, a1: -hx + W * kept, b1: tape, rect: [strip[0], strip[1], lerp(strip[0], strip[2], kept), strip[3]], fixed: true });
      for (const face of o.crushed ? [1] : [0, 1]) windows.push({ face, a0: -tape, b0: hy - drop, a1: tape, b1: hy, rect: tapeEnd, fixed: true, turn: true });
      const lw = Math.min(0.13, W * 0.34), lh = (lw * 176) / 256;
      if (!o.crushed && hz - tape > lh + 0.03) windows.push({ face: 2, a0: hx - 0.035 - lw, b0: tape + 0.015, a1: hx - 0.035, b1: tape + 0.015 + lh, rect: MARK.cartonLabel });
    }
    // Prints are kept clear of the corner the crushed one folds in, so no grid line of theirs crosses its creases.
    const small = o.crushed ? 0.55 : 1, pw = Math.min(W * 0.62, H * 0.86 * (4 / 3), 0.32) * small, ph = pw * 0.75;
    for (const face of [4, 5]) windows.push({ face, a0: -pw / 2, b0: -ph / 2, a1: pw / 2, b1: ph / 2, rect: MARK.carton });
    const ew = Math.min(D * 0.62, (H - drop - 0.03) * (4 / 3), 0.24) * small, eh = ew * 0.75;
    if (ew > 0.07) for (const face of [0, 1]) windows.push({ face, a0: -ew / 2, b0: -hy + (H - drop - eh) / 2, a1: ew / 2, b1: -hy + (H - drop - eh) / 2 + eh, rect: MARK.cartonEnd });
    const offsets = FACES.map(() => [random() * 3, random() * 3]), bulge = 0.0045, bell = (v: number) => Math.max(0, 1 - v * v);
    // The crushed variant was dropped on a top corner: the corner is folded in along three creases, the front
    // panel has buckled along an upright one, and the lid sags.
    const dent = o.crushed ? { reach: Math.min(W, D) * 0.62, normal: [0.6014, 0.6215, 0.5012] as V3, back: 0.055, fold: -0.075, wide: 0.085, deep: 0.024 } : null;
    const quarters = (corner: number, k: number) => (high ? [0.25, 0.5, 0.75, 1] : [0.5, 1]).map((part) => corner - (dent!.back / dent!.normal[k]) * part);
    const borders: [number[], number[], number[]] | undefined = dent ? [[...quarters(hx, 0), ...(high ? [dent.fold - dent.wide, dent.fold, dent.fold + dent.wide] : [])], [...quarters(hy, 1), ...(high ? [0, -hy * 0.55] : [])], [...quarters(hz, 2), ...(high ? [0] : [])]] : undefined;
    softBox(g, W, H, D, {
      radius: o.crushed ? 0.002 : 0.005, round: 1, cuts: o.crushed || !high ? [1, 1, 1] : [2, 2, 2], windows, skip: o.open ? PY : 0, borders, ...(dent ? { ridge: (p: V3) => (p[0] - hx) * dent.normal[0] + (p[1] - hy) * dent.normal[1] + (p[2] - hz) * dent.normal[2] + dent.back } : {}),
      uv: (f, a, b) => [offsets[f][0] + a / TILE, offsets[f][1] + b / TILE],
      warp: (p) => {
        const ax = p[0] / hx, ay = p[1] / hy, az = p[2] / hz;
        p[0] += ax * bulge * bell(ay) * bell(az); p[2] += az * bulge * bell(ax) * bell(ay);
        if (!o.open) p[1] -= (ay > 0 ? 1 : 0) * (o.crushed ? 0.016 : 0.003) * bell(ax) * bell(az);
        if (dent) {
          const beyond = (p[0] - hx) * dent.normal[0] + (p[1] - hy) * dent.normal[1] + (p[2] - hz) * dent.normal[2] + dent.back;
          if (beyond > 0) for (let k = 0; k < 3; k += 1) p[k] -= dent.normal[k] * beyond * 1.75;
          if (p[2] > hz * 0.9) p[2] -= dent.deep * Math.max(0, 1 - Math.abs(p[0] - dent.fold) / dent.wide) * bell(ay);
        }
        p[1] += hy;
      },
      // Scuffed pale along the edges, dusty toward the floor.
      colour: (p) => {
        const edge = (Math.abs(p[0]) > hx - 0.006 ? 1 : 0) + (Math.abs(p[1] - hy) > hy - 0.006 ? 1 : 0) + (Math.abs(p[2]) > hz - 0.006 ? 1 : 0), tone = (edge >= 2 ? 1.1 : 0.96) * (0.84 + 0.16 * smooth(0, 0.12, p[1]));
        const knock = dent ? 1 - 0.3 * Math.max(0, 1 - Math.hypot(p[0] - hx, p[1] - H, p[2] - hz) / dent.reach) - (p[2] > hz * 0.85 ? 0.14 * Math.max(0, 1 - Math.abs(p[0] - dent.fold) / 0.02) : 0) : 1;
        return [tone * knock, tone * knock * 0.99, tone * knock * 0.97, 1];
      },
    });
    // A flap is a board of its own: its cut edges show the fluting.
    const t = 0.005, flute = MARK.flute, piece = 0.16;
    const flap = (length: number, deep: number, fold: number, yaw: number, x: number, z: number) => {
      const from = g.count, cuts: number[] = [];
      for (let at = -length / 2 + piece; at < length / 2 - 0.02; at += piece) cuts.push(at);
      box(g, 0, t / 2, -deep / 2, length - 0.004, t, deep, {
        bevel: 0.0008, cuts: (f) => (f >= 4 ? cuts : null),
        uv: (f, a, b) => [f * 0.37 + a / TILE, b / TILE],
        decal: (f, a, b, mid) => {
          if (f === 2 || f === 3) return null;
          const start = f >= 4 ? Math.floor((mid + length / 2) / piece + 1e-6) * piece - length / 2 : -deep / 2;
          return [2 + lerp(flute[0], flute[2], clamp01((a - start) / piece)), lerp(flute[1], flute[3], 0.5 + b / t)];
        },
      });
      g.xf(from, new THREE.Matrix4().makeTranslation(x, H, z).multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(new THREE.Matrix4().makeRotationX(fold)));
    };
    // The knock burst the seam: the back flap has sprung up from under what is left of the tape.
    if (o.crushed) flap(W, D / 2, 0.3, Math.PI, 0, -hz);
    if (o.open) {
      // Inside walls and floor, darker toward the bottom, and the cut edge of the board round the opening.
      const inner = (x0: number, z0: number, x1: number, z1: number) => {
        const nx = z0 - z1, nz = x1 - x0, length = Math.hypot(nx, nz), u = random() * 3;
        const ids = [g.v(x0, t, z0, nx / length, 0, nz / length, u, 0, NONE, NONE, [0.3, 0.29, 0.28, 1]), g.v(x1, t, z1, nx / length, 0, nz / length, u + Math.hypot(x1 - x0, z1 - z0) / TILE, 0, NONE, NONE, [0.3, 0.29, 0.28, 1]),
          g.v(x1, H - 0.001, z1, nx / length, 0, nz / length, u + Math.hypot(x1 - x0, z1 - z0) / TILE, H / TILE, NONE, NONE, [0.78, 0.76, 0.74, 1]), g.v(x0, H - 0.001, z0, nx / length, 0, nz / length, u, H / TILE, NONE, NONE, [0.78, 0.76, 0.74, 1])];
        g.quad(ids[0], ids[1], ids[2], ids[3]);
      };
      const ix = hx - t, iz = hz - t;
      inner(-ix, iz, ix, iz); inner(ix, iz, ix, -iz); inner(ix, -iz, -ix, -iz); inner(-ix, -iz, -ix, iz);
      g.shade = [0.3, 0.29, 0.28, 1];
      g.quad(g.v(-ix, t, iz, 0, 1, 0, 0, 0), g.v(ix, t, iz, 0, 1, 0, W / TILE, 0), g.v(ix, t, -iz, 0, 1, 0, W / TILE, D / TILE), g.v(-ix, t, -iz, 0, 1, 0, 0, D / TILE));
      g.shade = [1, 1, 1, 1];
      // Flaps, each folded back a different way.
      flap(W, D / 2, 3.5, 0, 0, hz); flap(W, D / 2, 1.85, Math.PI, 0, -hz); flap(D, D / 2, 4.1, Math.PI / 2, hx, 0); flap(D, D / 2, 2.9, -Math.PI / 2, -hx, 0);
    }
    const room: Room = { floor: 0.005, size: [W - 0.012, D - 0.012], rim: H - 0.02, flare: 0 };
    return { parts: [{ geo: g, material: kraft(), shift: driftShift }], variants: 4, palette: [0xffffff, 0xf0e2cc, 0xe2d0b4, 0xf6ecd8], ...(o.open ? { inside: room } : {}) };
  };
  /** A face sheathed in boards that run up it: each lies flat, chamfered at its edges and sunk at the joints. */
  const sheath = (g: Geo, random: () => number, f: number, centre: V3, wide: number, tall: number, count: number, mark?: { rect: Rect; from: number; to: number; b0: number; b1: number }) => {
    const face = FACES[f], width = wide / count, chamfer = 0.004, sink = 0.003, lean = 0.75, size = Math.hypot(1, lean);
    for (let i = 0; i < count; i += 1) {
      const x0 = -wide / 2 + i * width, x1 = x0 + width, tone = 0.72 + random() * 0.28, plank = Math.floor(random() * PLANKS), start = random() * 4, marked = !!mark && i >= mark.from && i <= mark.to;
      const strips: Array<[number, number, number, number, number]> = [[x0, x0 + chamfer, sink, 0, -lean], [x0 + chamfer, x1 - chamfer, 0, 0, 0], [x1 - chamfer, x1, 0, sink, lean]];
      const rows = marked ? [-tall / 2, mark!.b0, mark!.b1, tall / 2] : [-tall / 2, tall / 2];
      for (let row = 0; row < rows.length - 1; row += 1) for (const [a0, a1, d0, d1, tilt] of strips) {
        const ids: number[] = [];
        for (const [a, b, depth] of [[a0, rows[row], d0], [a1, rows[row], d1], [a1, rows[row + 1], d1], [a0, rows[row + 1], d0]]) {
          const dark = depth > 0 ? 0.5 : 1, on = marked && row === 1;
          const du = on ? lerp(mark!.rect[0], mark!.rect[2], (a - (-wide / 2 + mark!.from * width)) / ((mark!.to - mark!.from + 1) * width)) : NONE, dv = on ? lerp(mark!.rect[1], mark!.rect[3], (b - mark!.b0) / (mark!.b1 - mark!.b0)) : NONE;
          ids.push(g.v(centre[0] - face.n[0] * depth + face.r[0] * a + face.u[0] * b, centre[1] - face.n[1] * depth + face.r[1] * a + face.u[1] * b, centre[2] - face.n[2] * depth + face.r[2] * a + face.u[2] * b,
            (face.n[0] + face.r[0] * tilt) / (tilt ? size : 1), (face.n[1] + face.r[1] * tilt) / (tilt ? size : 1), (face.n[2] + face.r[2] * tilt) / (tilt ? size : 1),
            start + b / WOOD_TILE, plank / PLANKS + (a - (x0 + x1) / 2) / Math.max(WOOD_TILE, (width * PLANKS) / 0.84), du, dv, [tone * dark, tone * dark * 0.98, tone * dark * 0.95, 1]));
        }
        g.quad(ids[0], ids[1], ids[2], ids[3]);
      }
    }
  };
  /** A closed shipping crate: sheathed panels in a batten frame, braced on the ends, cleated on top, stencilled on the long sides. */
  const crate = (W: number, body: number, D: number, o: { planks: number; batten: number; thick: number; skid: number; seed: number }): Draft => {
    const g = new Geo(), random = rng(baseSeed * 149 + o.seed), bw = o.batten, t = o.thick, y0 = o.skid, mid = y0 + body / 2;
    const plank = W / o.planks, from = Math.floor((o.planks - 3) / 2), wide = plank * 3, tall = Math.min(wide * 0.75, body - 2 * bw - 0.04);
    const mark = { rect: MARK.crate, from, to: from + 2, b0: -tall / 2, b1: tall / 2 };
    sheath(g, random, 4, [0, mid, D / 2], W, body, o.planks, mark); sheath(g, random, 5, [0, mid, -D / 2], W, body, o.planks, mark);
    const across = Math.max(3, Math.round(D / plank));
    sheath(g, random, 0, [W / 2, mid, 0], D, body, across); sheath(g, random, 1, [-W / 2, mid, 0], D, body, across);
    sheath(g, random, 2, [0, y0 + body, 0], W, D, o.planks); sheath(g, random, 3, [0, y0, 0], W, D, 2);
    for (const side of [1, -1]) {
      const z = side * (D / 2 + t / 2), x = side * (W / 2 + t / 2), f = side > 0 ? 4 : 5, e = side > 0 ? 0 : 1;
      // Long sides: stiles lapping over the end battens, rails between them.
      for (const end of [-1, 1]) { board(g, random, end * (W / 2 + t - (bw + t) / 2), mid, z, bw + t, body, t, { grain: 1 }); for (const dy of [0.03, body / 2, body - 0.03]) nail(g, end * (W / 2 - bw / 2), y0 + dy, side * (D / 2 + t), f, 0.004); }
      for (const y of [y0 + bw / 2, y0 + body - bw / 2]) { board(g, random, 0, y, z, W - 2 * bw, bw, t, { grain: 0, ends: false }); for (const dx of [-0.42, 0, 0.42]) nail(g, dx * (W - 2 * bw), y, side * (D / 2 + t), f, 0.004); }
      // Ends: a frame and a diagonal brace let in between its corners.
      for (const end of [-1, 1]) board(g, random, x, mid, end * (D / 2 - bw / 2), t, body, bw, { grain: 1 });
      for (const y of [y0 + bw / 2, y0 + body - bw / 2]) board(g, random, x, y, 0, t, bw, D - 2 * bw, { grain: 2, ends: false });
      const run = D - 2 * bw, rise = body - 2 * bw, brace = g.count;
      board(g, random, 0, 0, 0, t, bw * 0.9, Math.hypot(run, rise) - bw * 0.5, { grain: 2 });
      g.move(brace, x, mid, 0, side * Math.atan2(rise, run), 0, 0);
      for (const end of [-1, 1]) for (const dy of [0.03, body - 0.03]) nail(g, side * (W / 2 + t), y0 + dy, end * (D / 2 - bw / 2), e, 0.004);
    }
    // Cleats across the lid, and skids underneath for the forks.
    for (const x of W > 0.8 ? [-W * 0.34, 0, W * 0.34] : [-W * 0.3, W * 0.3]) { board(g, random, x, y0 + body + t / 2, 0, bw, t, D + 2 * t, { grain: 2 }); for (const dz of [-0.4, 0, 0.4]) nail(g, x, y0 + body + t, dz * D, 2, 0.004); }
    if (o.skid > 0) for (const z of [-D * 0.32, D * 0.32]) board(g, random, 0, o.skid / 2, z, W - 0.04, o.skid, bw, { grain: 0, skip: PY });
    return { parts: [{ geo: g, material: wood(), shift: woodShift }], variants: 4, palette: [0xe8d2b0, 0xd8c4a4, 0xc8b494, 0xf0dcc0] };
  };
  const woodShift: PropPart["shift"] = (variant, random) => [random() * 3, Math.floor(random() * PLANKS) / PLANKS, variant * MARK_STEP, 0];
  const driftShift: PropPart["shift"] = (variant, random) => [random(), random(), variant * MARK_STEP, 0];

  // ---- Kinds ---------------------------------------------------------------------------------
  const drafts: Partial<Record<PropKind, () => Draft>> = {
    // ---- Barrels and drums ---------------------------------------------------------------------
    drum: () => {
      const g = new Geo(), fit = new Geo(), R = 0.292, random = rng(baseSeed * 31 + 5), segs = seg(32);
      const dents = Array.from({ length: 5 }, () => ({ at: random() * TAU, y: 0.1 + random() * 0.68, depth: 0.004 + random() * 0.011, wide: 0.22 + random() * 0.3, tall: 0.05 + random() * 0.08 }));
      const dent = (theta: number, r: number, y: number, out: V3) => {
        if (r < R - 0.001 || y < 0.03 || y > 0.85) return;
        let push = 0;
        for (const d of dents) { const turn = Math.atan2(Math.sin(theta - d.at), Math.cos(theta - d.at)); push += d.depth * Math.exp(-((turn / d.wide) ** 2) - ((y - d.y) / d.tall) ** 2); }
        out[0] *= (r - push) / r; out[2] *= (r - push) / r;
      };
      // Paint goes first on the crests of the hoops and on the chimes.
      const worn = (_: number, y: number, r: number): RGBA => { const dust = 0.78 + 0.22 * smooth(0.0, 0.3, y); return [dust, dust * 0.98, dust * 0.95, r > R + 0.008 ? 0.3 : (y < 0.02 || y > 0.862) && r > R - 0.02 ? 0.42 : 1]; };
      const bead = (y: number): ProfilePoint[] => [[R, y - 0.018], [R + 0.0065, y - 0.011], [R + 0.011, y], [R + 0.0065, y + 0.011], [R, y + 0.018]];
      lathe(g, [
        [R - 0.03, 0.014], [R - 0.022, 0.014], [R - 0.012, 0.002], [R + 0.004, 0.003], [R + 0.006, 0.012], [R, 0.03],
        ...bead(0.29), ...bead(0.59),
        [R, 0.85], [R + 0.006, 0.868], [R + 0.004, 0.877], [R - 0.006, 0.88], [R - 0.016, 0.876], [R - 0.022, 0.866], [R - 0.022, 0.856], [R - 0.03, 0.855],
      ], {
        segs, uv: [0, 0, 2, 1.1], shape: dent, colour: worn, crease: 1.0,
        windows: [
          { at: 0.25, span: 6 / 32, y0: 0.335, y1: 0.56, rect: MARK.drum },
          { at: 0.25, span: 4 / 32, y0: 0.655, y1: 0.795, rect: MARK.drumLabel },
          { at: 0.5, span: 1, y0: 0.72, y1: 0.85, rect: MARK.rust, fixed: true, repeat: 4 },
          { at: 0.5, span: 1, y0: 0.445, y1: 0.572, rect: MARK.rust, fixed: true, repeat: 4 },
          { at: 0.5, span: 1, y0: 0.16, y1: 0.272, rect: MARK.rust, fixed: true, repeat: 4 },
        ],
      });
      // Lid and bottom, mapped from above so the paint does not pinch at the middle.
      lathe(g, [[R - 0.03, 0.855], [0.215, 0.855], [0.21, 0.8585], [0.205, 0.855], [0.09, 0.855], [0, 0.857]], { segs, uv: [0, 0, 0.64, 0.64], planar: R, crease: 1.4 });
      lathe(g, [[0, 0.016], [R - 0.03, 0.014]], { segs, uv: [0.2, 0.3, 0.84, 0.94], planar: R });
      // Bungs: the two-inch one and the vent opposite it.
      for (const [x, r] of [[-0.185, 0.034], [0.185, 0.021]]) {
        const from = fit.count;
        lathe(fit, [[r, 0], [r, 0.005], [r * 0.82, 0.007], [r * 0.82, 0.011]], { segs: seg(12), uv: [0, 0, 0.3, 0.05] });
        lathe(fit, [[r * 0.82, 0.011], [r * 0.5, 0.011], [r * 0.5, 0.008], [0, 0.008]], { segs: 6, uv: [0.1, 0.1, 0.3, 0.2], crease: 0.3 });
        fit.move(from, 0, 0.855, x);
      }
      return {
        parts: [{ geo: g, material: paint(), shift: driftShift }, { geo: fit, material: iron(), slot: 1 }],
        variants: 4, palette: [0x1c4c8c, 0x8a2c1c, 0x58682c, 0xc4961c, 0x22262a, 0x1c6a64, 0xa9aba4], palette2: [0x6a6c68],
      };
    },
    cask: () => {
      const g = new Geo(), fit = new Geo(), random = rng(baseSeed * 53 + 11);
      const H = 0.92, R0 = 0.255, R1 = 0.315, staves = high ? 16 : 10, per = 4, thick = 0.024, inset = 0.034, spans = 5;
      const radius = (y: number) => R0 + (R1 - R0) * (1 - ((2 * y) / H - 1) ** 2);
      const fractions = [0, 0.075, 0.5, 0.925], phase = Math.PI / 2 + Math.PI / staves;
      const tones = Array.from({ length: staves }, () => 0.7 + random() * 0.3), boards = tones.map(() => Math.floor(random() * PLANKS)), starts = tones.map(() => random() * 4);
      const profile: ProfilePoint[] = [[R0 - thick, inset], [R0 - thick, 0], [R0, 0]];
      for (let k = 1; k < spans; k += 1) profile.push([radius((H * k) / spans), (H * k) / spans]);
      profile.push([R0, H], [R0 - thick, H], [R0 - thick, H - inset]);
      lathe(g, profile, {
        segs: staves * per, wrap: staves, facet: true, phase, uv: [0, 0, 1, 1],
        spacing: (s) => (Math.floor(s / per) + fractions[s % per]) / staves,
        // Staves bear on each other at a bevelled joint: a shallow V that the hoops bridge.
        shape: (theta, r, _y, out) => {
          const local = ((((theta - phase) / TAU) * staves) % 1 + 1) % 1, edge = Math.min(local, 1 - local);
          if (edge < 0.075) { const f = (r - 0.004 * (1 - edge / 0.075)) / r; out[0] *= f; out[2] *= f; }
        },
        uvOf: (stave, across, t) => [starts[stave] + (t * 1.06) / WOOD_TILE, boards[stave] / PLANKS + ((across - 0.5) * 0.8) / PLANKS],
        colour: (_theta, _y, _r, stave, across) => { const joint = across < 0.01 || across > 0.99 ? 0.42 : 1, tone = tones[stave] * joint; return [tone, tone * 0.98, tone * 0.95, 1]; },
      });
      // Heads: five boards, tongued together, sitting in the croze below the chime.
      const head = (y: number, up: boolean) => {
        const Rh = R0 - thick + 0.001, count = 5, width = (2 * Rh) / count, steps = high ? 3 : 2;
        for (let i = 0; i < count; i += 1) {
          const tone = 0.72 + random() * 0.26, plank = Math.floor(random() * PLANKS), start = random() * 4, x0 = -Rh + i * width, x1 = x0 + width;
          g.shade = [tone, tone * 0.98, tone * 0.95, 1];
          for (let k = 0; k < steps; k += 1) {
            const xa = lerp(x0, x1, k / steps), xb = lerp(x0, x1, (k + 1) / steps), ids: number[] = [];
            for (const [x, side] of [[xa, -1], [xa, 1], [xb, 1], [xb, -1]]) {
              const z = side * Math.sqrt(Math.max(0, Rh * Rh - x * x));
              const decal: [number, number] = up ? [lerp(MARK.cask[0], MARK.cask[2], 0.5 + x / (2 * Rh)), lerp(MARK.cask[1], MARK.cask[3], 0.5 - z / (2 * Rh))] : [NONE, NONE];
              ids.push(g.v(x, y, z, 0, up ? 1 : -1, 0, start + z / WOOD_TILE, plank / PLANKS + (x - (x0 + x1) / 2) / ((width * PLANKS) / 0.84), decal[0], decal[1]));
            }
            const from: V3 = [0, y + (up ? -1 : 1), 0];
            g.triOut(ids[0], ids[1], ids[2], from); g.triOut(ids[0], ids[2], ids[3], from);
          }
        }
        g.shade = [1, 1, 1, 1];
      };
      head(H - inset, true); head(inset, false);
      // Bung in the bilge stave.
      const bung = g.count;
      g.shade = [0.62, 0.58, 0.52, 1];
      lathe(g, [[0.027, 0], [0.027, 0.011], [0.021, 0.015], [0, 0.015]], { segs: seg(10), uv: [0.2, 0.52, 0.26, 0.56], planar: 0.03 });
      g.move(bung, 0, H / 2, R1 - 0.004, Math.PI / 2);
      g.shade = [1, 1, 1, 1];
      // Hoops, driven on from each end, each riveted where its ends lap.
      const hoops: Array<[number, number]> = [[0.012, 0.062], [0.13, 0.172], [0.262, 0.3]];
      [...hoops, ...hoops.map(([a, b]) => [H - b, H - a] as [number, number])].forEach(([y0, y1], index) => {
        const t = 0.0026, rust = 0.62 + random() * 0.2;
        fit.shade = [1, 1, 1, rust];
        lathe(fit, [[radius(y0) + t, y0], [radius(y1) + t, y1 - 0.0025], [radius(y1) + 0.0003, y1]], { segs: staves * 2, phase, uv: [0, 0, 5, 0.12], crease: 1.3 });
        const from = fit.count, yc = (y0 + y1) / 2, r = radius(yc) + t;
        box(fit, 0, yc, r + 0.0008, 0.07, (y1 - y0) * 0.92, 0.0022, { skip: NZ, uv: (_f, a, b) => [0.5 + a, 0.5 + b] });
        for (const x of [-0.02, 0.02]) {
          const rivet = fit.count;
          lathe(fit, [[0.0062, 0], [0.0045, 0.0022], [0, 0.003]], { segs: 6, uv: [0.3, 0.3, 0.34, 0.34], planar: 0.007, crease: 2 });
          fit.move(rivet, x, yc, r + 0.0018, Math.PI / 2);
        }
        fit.xf(from, new THREE.Matrix4().makeRotationY(0.9 + index * 2.3));
      });
      fit.shade = [1, 1, 1, 1];
      return { parts: [{ geo: g, material: wood(), shift: woodShift }, { geo: fit, material: iron(), slot: 1 }], variants: 2, palette: [0xc8a070, 0xb89468, 0xa88458], palette2: [0x4f4c47] };
    },
    // ---- Crates ---------------------------------------------------------------------------------
    crateSlat: () => {
      const g = new Geo(), random = rng(baseSeed * 71 + 3), W = 0.6, D = 0.4, t = 0.012, post = 0.032, slat = 0.074;
      const ys = [0.045, 0.142, 0.239, 0.336], px = W / 2 - t - post / 2, pz = D / 2 - t - post / 2;
      // The mark is sprayed across the two middle slats of each long side.
      const y0 = ys[1] - slat / 2, y1 = ys[2] + slat / 2, half = ((y1 - y0) * 256) / 192 / 2;
      ys.forEach((y, row) => {
        for (const side of [1, -1]) {
          const stencil = row === 1 || row === 2 ? windowOn(MARK.crate, -half, y0 - y, half, y1 - y) : null;
          board(g, random, 0, y, side * (D / 2 - t / 2), W, slat, t, { cuts: (f) => (stencil && f === (side > 0 ? 4 : 5) ? [-half, half] : null), decal: (f, a, b, mid) => (stencil && f === (side > 0 ? 4 : 5) ? stencil(a, b, mid) : null) });
          board(g, random, side * (W / 2 - t / 2), y, 0, t, slat, D - 2 * t - 0.003);
          for (const end of [-1, 1]) for (const dy of [-0.02, 0.02]) {
            nail(g, end * px, y + dy, side * (D / 2), side > 0 ? 4 : 5);
            nail(g, side * (W / 2), y + dy, end * pz, side > 0 ? 0 : 1);
          }
        }
      });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) board(g, random, sx * px, 0.19, sz * pz, post, 0.372, post, { skip: NY });
      for (let i = 0; i < 4; i += 1) board(g, random, 0, 0.007, -0.141 + i * 0.094, W - 2 * t - 0.004, t, 0.078, { skip: NY });
      return { parts: [{ geo: g, material: wood(), shift: woodShift }], variants: 4, palette: [0xf0dcc0, 0xe4cca8, 0xd8c4a8, 0xc8b8a0], inside: { floor: 0.013, size: [0.568, 0.368], rim: 0.34, flare: 0 } };
    },
    pallet: () => {
      const g = new Geo(), random = rng(baseSeed * 73 + 9), W = 1.2, D = 0.8, t = 0.022, block = 0.078;
      // Bottom boards, blocks, stringers and deck: the 1200 x 800 pattern.
      for (const z of [-0.35, 0, 0.35]) board(g, random, 0, t / 2, z, W, t, z === 0 ? 0.145 : 0.1, { skip: NY });
      for (const x of [-0.5275, 0, 0.5275]) for (const z of [-0.35, 0, 0.35]) {
        const w = 0.145, d = z === 0 ? 0.145 : 0.1, stamp = windowOn(MARK.pallet, -0.052, -0.035, 0.052, 0.035);
        board(g, random, x, t + block / 2, z, w, block, d, { grain: 0, skip: PY | NY, cuts: (f) => (f >= 4 && z !== 0 && x !== 0 ? [-0.052, 0.052] : null), decal: (f, a, b, mid) => (f === (z > 0 ? 4 : 5) && z !== 0 && x !== 0 ? stamp(a, b, mid) : null) });
      }
      for (const x of [-0.5275, 0, 0.5275]) board(g, random, x, t + block + t / 2, 0, 0.145, t, D, { skip: 0 });
      [-0.3275, -0.1725, 0, 0.1725, 0.3275].forEach((z, i) => {
        const d = i % 2 === 0 ? 0.145 : 0.1, y = t * 2 + block + t / 2;
        board(g, random, 0, y, z, W, t, d);
        for (const x of [-0.5275, 0, 0.5275]) for (const dz of [-0.03, 0.03]) nail(g, x + dz * 0.4, y + t / 2, z + dz, 2, 0.0042);
      });
      return { parts: [{ geo: g, material: wood(), shift: woodShift }], variants: 2, palette: [0xecdcc4, 0xdccbb0, 0xccbca4] };
    },
    // ---- Bottles, jars and tins -------------------------------------------------------------------
    bottleWine: () => bottle({
      segs: seg(16), cells: SMALL.wine, fill: 0.2365,
      shell: [[0, 0.02], [0.017, 0.013], [0.0335, 0], [0.0375, 0.008], [0.0375, 0.188], [0.0362, 0.201], [0.0305, 0.215], [0.0215, 0.226], [0.0165, 0.237], [0.015, 0.247]],
      liquid: [[0, 0.0225], [0.027, 0.0065], [0.0353, 0.012], [0.0353, 0.188], [0.0285, 0.2135], [0.0146, 0.2365]],
      cap: [[0.0169, 0.2365], [0.0156, 0.2465], [0.0152, 0.281], [0.0162, 0.2825], [0.0162, 0.2915], [0.0152, 0.293], [0.0146, 0.3005]],
      labels: [{ at: 0.25, span: 0.375, y0: 0.058, y1: 0.15, rect: SMALL.wine.label }],
      palette: [0x3f6b2a, 0x4a4a1e, 0xd8ecc8], palette2: [0x1a0508, 0x1c0608, 0xd9c46a],
    }),
    bottleBeer: () => bottle({
      segs: seg(16), cells: SMALL.beer, fill: 0.2,
      shell: [[0, 0.007], [0.021, 0.0045], [0.0272, 0], [0.0305, 0.006], [0.0305, 0.112], [0.0297, 0.126], [0.0262, 0.141], [0.0212, 0.156], [0.015, 0.178], [0.0128, 0.212], [0.014, 0.215], [0.014, 0.2205], [0.0132, 0.2275]],
      liquid: [[0, 0.009], [0.0262, 0.0035], [0.0284, 0.0095], [0.0284, 0.112], [0.024, 0.141], [0.013, 0.178], [0.011, 0.2]],
      cap: [[0.0153, 0.2212], [0.0156, 0.2262], [0.0146, 0.2296], [0.0128, 0.2306]],
      labels: [{ at: 0.25, span: 0.5, y0: 0.036, y1: 0.09, rect: SMALL.beer.label }, { at: 0.25, span: 0.5, y0: 0.156, y1: 0.178, rect: SMALL.beer.neck }],
      palette: [0x2f7a3a, 0x7a3c0c, 0x5a2c0a], palette2: [0x6a6a14, 0x4a1c04, 0x0c0503],
    }),
    bottleSpirits: () => {
      // A square-shouldered bottle: the turned profile is pushed out to a rounded square below the neck.
      const per = high ? 6 : 3, stops = high ? [0, 5 / 90, 11 / 90, 0.5, 79 / 90, 85 / 90] : [0, 11 / 90, 79 / 90];
      return bottle({
        segs: per * 4, cells: SMALL.spirits, fill: 0.158, phase: Math.PI / 4, spacing: (s) => (Math.floor(s / per) + stops[s % per]) / 4,
        shape: (theta, r, _y, out) => {
          const c = Math.cos(theta), s = Math.sin(theta), square = 1 / Math.sqrt(Math.sqrt(c * c * c * c + s * s * s * s)), f = lerp(1, square, smooth(0.016, 0.036, r));
          out[0] *= f; out[2] *= f;
        },
        shell: [[0, 0.009], [0.038, 0], [0.0425, 0.008], [0.0425, 0.168], [0.041, 0.18], [0.033, 0.19], [0.019, 0.1985], [0.0152, 0.206], [0.0146, 0.222]],
        liquid: [[0, 0.0115], [0.0365, 0.0035], [0.0398, 0.011], [0.0398, 0.158]],
        cap: [[0.016, 0.2165], [0.016, 0.2625], [0.015, 0.2645]],
        labels: [{ at: (high ? 3 : 1.5) / (per * 4), span: (high ? 2 : 1) / (per * 4), y0: 0.052, y1: 0.122, rect: SMALL.spirits.label }],
        palette: [0xf2f6f4, 0xeef2ea, 0x2446a8], palette2: [0xb5681a, 0x4a1c08, 0x0c1c4a],
      });
    },
    bottleSoda: () => bottle({
      segs: seg(16), cells: SMALL.soda, fill: 0.208,
      shell: [[0, 0.007], [0.0252, 0], [0.029, 0.008], [0.0293, 0.032], [0.0262, 0.062], [0.0282, 0.09], [0.03, 0.112], [0.0296, 0.132], [0.0255, 0.154], [0.018, 0.18], [0.014, 0.2], [0.0128, 0.221], [0.014, 0.224], [0.014, 0.2295], [0.0132, 0.2365]],
      liquid: [[0, 0.009], [0.024, 0.0035], [0.0272, 0.012], [0.0272, 0.032], [0.0242, 0.062], [0.028, 0.112], [0.0276, 0.132], [0.0235, 0.153], [0.012, 0.199], [0.0112, 0.208]],
      cap: [[0.0153, 0.2302], [0.0156, 0.2352], [0.0146, 0.2386], [0.0128, 0.2396]],
      labels: [{ at: 0.25, span: 0.5, y0: 0.084, y1: 0.139, rect: SMALL.soda.label }],
      palette: [0xf0f6f2, 0x4f9a4a, 0xf0f6f2], palette2: [0x1c0a05, 0xb9c44a, 0xe07a14],
    }),
    bottleSauce: () => bottle({
      segs: seg(12), cells: SMALL.sauce, fill: 0.128,
      shell: [[0, 0.005], [0.0192, 0], [0.022, 0.006], [0.022, 0.084], [0.0206, 0.097], [0.014, 0.116], [0.0108, 0.13], [0.0106, 0.142]],
      liquid: [[0, 0.007], [0.018, 0.0035], [0.02, 0.009], [0.02, 0.084], [0.0186, 0.096], [0.0122, 0.115], [0.0092, 0.128]],
      cap: [[0.0128, 0.138], [0.0128, 0.16], [0.012, 0.1625]],
      labels: [{ at: 0.25, span: 0.5, y0: 0.022, y1: 0.074, rect: SMALL.sauce.label }],
      palette: [0xf0f6f2, 0xdce8c0, 0xf0f6f2], palette2: [0xb5200f, 0x9aa01e, 0x120805],
    }),
    jar: () => {
      const sm = new Geo(), sh = new Geo(), segs = seg(16), label = { at: 0.25, span: 0.375, y0: 0.034, y1: 0.086 };
      const shell: ProfilePoint[] = [[0, 0.005], [0.034, 0.0035], [0.0435, 0], [0.047, 0.003], [0.048, 0.01], [0.048, 0.104], [0.0462, 0.114], [0.0425, 0.119], [0.042, 0.126]];
      lathe(sh, shell, { segs, uv: [0, 0, 1, 1], windows: [{ ...label, hole: true }], crease: 1.2, colour: (_t, y) => [1, 1, 1, y < 0.008 ? 0.4 : y > 0.11 ? 0.7 : 1] });
      lathe(sm, shell, { segs, uv: SMALL.jar.label, windows: [{ ...label, rect: SMALL.jar.label }], only: true, fit: true });
      // What is in it: a wall of pickles, olives, honey or spice, and the level seen from above.
      sm.shade = [1, 1, 1, 0.62];
      lathe(sm, [[0.0415, 0.0035], [0.0455, 0.011], [0.0455, 0.103], [0.0437, 0.112]], { segs, uv: SMALL.jar.contents });
      const c = SMALL.jar.contents;
      lathe(sm, [[0.0437, 0.112], [0, 0.112]], { segs, uv: [lerp(c[0], c[2], 0.3), lerp(c[1], c[3], 0.45), lerp(c[0], c[2], 0.7), lerp(c[1], c[3], 0.95)], planar: 0.0437 });
      sm.shade = [1, 1, 1, 1];
      lathe(sm, [[0.0452, 0.1215], [0.0456, 0.1245], [0.0456, 0.1375], [0.044, 0.1398]], { segs, uv: SMALL.jar.lidSide, wrap: 2, crease: 1 });
      lathe(sm, [[0.044, 0.1398], [0, 0.1404]], { segs, uv: SMALL.jar.lidTop, planar: 0.044 });
      return {
        parts: [{ geo: sm, material: smalls(), slot: 1, shift: (variant) => [variant * SMALL.jar.step[0], 0, 0, 0] }, { geo: sh, material: glass(), slot: 0, cast: false }],
        variants: 4, palette: [0xf2f7f4], palette2: [0xffffff], radius: 0.05, rest: "flat",
      };
    },
    tin: () => {
      const g = new Geo(), segs = seg(16);
      lathe(g, [[0.0355, 0], [0.0375, 0.002], [0.0375, 0.079]], { segs, uv: [SMALL.tin.wrap[2], SMALL.tin.wrap[1], SMALL.tin.wrap[0], SMALL.tin.wrap[3]], crease: 1 });
      lathe(g, [[0.0355, 0], [0, 0]], { segs, uv: SMALL.tin.lidSide, planar: 0.2, inward: true });
      lathe(g, [[0.0386, 0.076], [0.0389, 0.078], [0.0386, 0.08], [0.0386, 0.0932], [0.0372, 0.095]], { segs, uv: SMALL.tin.lidSide, wrap: 2, crease: 1 });
      lathe(g, [[0.0372, 0.095], [0, 0.0955]], { segs, uv: SMALL.tin.lidTop, planar: 0.0372 });
      return { parts: [{ geo: g, material: smalls(), slot: -1, shift: (variant) => [(variant % 2) * SMALL.tin.step[0], -Math.floor(variant / 2) * SMALL.tin.step[1], 0, 0] }], variants: 4, radius: 0.04, rest: "flat" };
    },
    // ---- Fruit and vegetables -------------------------------------------------------------------
    orange: () => {
      const g = new Geo();
      lathe(g, ovoid(0.037, 0.07, seg(8), { top: 0.004, bottom: 0.002 }), { segs: seg(12), uv: FRUIT.orange, poles: true, shape: (theta, _r, _y, out) => { const f = 1 + 0.02 * Math.sin(theta * 3 + 1); out[0] *= f; out[2] *= f; } });
      return { parts: [{ geo: g, material: produce() }], palette: [0xffffff, 0xfff2e2, 0xf4e6d6], radius: 0.036, rest: "any" };
    },
    lemon: () => {
      const g = new Geo();
      lathe(g, [[0, 0], [0.006, 0.002], [0.011, 0.007], [0.021, 0.018], [0.0275, 0.034], [0.0285, 0.046], [0.025, 0.06], [0.016, 0.072], [0.008, 0.079], [0.005, 0.084], [0, 0.086]], { segs: seg(10), uv: FRUIT.lemon, crease: 3 });
      return { parts: [{ geo: g, material: produce() }], palette: [0xffffff, 0xf6f6e0, 0xfff6d8], radius: 0.031, rest: "any" };
    },
    apple: () => {
      const g = new Geo(), h = 0.066;
      lathe(g, ovoid(0.036, h, seg(8) + 1, { power: 0.82, top: 0.013, bottom: 0.006, hollow: 0.36 }), {
        segs: seg(12), uv: FRUIT.apple, poles: true,
        // Broad shoulders, and five bumps round the eye.
        shape: (theta, _r, y, out) => { const f = (1 + 0.14 * (y / h - 0.5)) * (1 + 0.04 * Math.cos(theta * 5) * (1 - y / h) ** 2); out[0] *= f; out[2] *= f; },
      });
      tube(g, [[0, h - 0.014, 0], [0.0008, h - 0.002, 0.0004], [0.003, h + 0.009, 0.0014]], 0.0015, 4, FRUIT.stem, { caps: true });
      return { parts: [{ geo: g, material: produce(), shift: (variant) => [(variant * 256) / PRODUCE_W, 0, 0, 0] }], variants: 3, palette: [0xffffff, 0xfff0ea, 0xf0f0e0], radius: 0.036, rest: "up" };
    },
    pomegranate: () => {
      const g = new Geo(), h = 0.082, lobed: LatheOptions["shape"] = (theta, _r, _y, out) => { const f = 1 + 0.035 * Math.cos(theta * 6 + 0.5); out[0] *= f; out[2] *= f; };
      lathe(g, ovoid(0.046, h, seg(8), { power: 0.9, bottom: 0.003 }), { segs: seg(12), uv: FRUIT.pomegranate, poles: true, shape: lobed });
      // The crown: a short flared calyx of six points.
      const crown: LatheOptions["shape"] = (theta, _r, y, out) => { const f = 1 + 0.3 * Math.cos(theta * 6) * smooth(h, h + 0.016, y); out[0] *= f; out[2] *= f; };
      const top = FRUIT.pomegranate, band: Rect = [top[0], lerp(top[1], top[3], 0.9), top[2], top[3]];
      lathe(g, [[0.009, h - 0.004], [0.0095, h + 0.006], [0.015, h + 0.016]], { segs: 12, uv: band, shape: crown });
      lathe(g, [[0.014, h + 0.016], [0.008, h + 0.006], [0, h + 0.002]], { segs: 12, uv: band, shape: crown, inward: false });
      return { parts: [{ geo: g, material: produce() }], palette: [0xffffff, 0xffe8e0, 0xe8d0d0], radius: 0.046, rest: "any" };
    },
    melon: () => {
      const g = new Geo();
      lathe(g, ovoid(0.078, 0.166, seg(10), { top: 0.004, bottom: 0.003 }), { segs: seg(20), wrap: 2, uv: FRUIT.melon, poles: true, shape: (theta, _r, _y, out) => { const f = 1 + 0.012 * Math.cos(theta * 10); out[0] *= f; out[2] *= f; } });
      return { parts: [{ geo: g, material: produce() }], palette: [0xffffff, 0xf0f2d8, 0xfff0c8], radius: 0.08, rest: "any" };
    },
    watermelon: () => {
      const g = new Geo(), r = 0.115;
      lathe(g, ovoid(r, 0.34, seg(12), { power: 0.86 }), { segs: seg(20), wrap: 2, uv: FRUIT.watermelon, poles: true });
      // Lying along x, on the ground.
      g.xf(0, new THREE.Matrix4().makeTranslation(0, r, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(0, -0.17, 0)));
      return { parts: [{ geo: g, material: produce() }], palette: [0xffffff, 0xeaf6e0, 0xf6f6d6], radius: 0.13, rest: "flat" };
    },
    bananas: () => {
      const g = new Geo(), random = rng(baseSeed * 97 + 2), steps = high ? 8 : 5;
      // A hand of five, joined at the crown and resting on their backs.
      for (let i = -2; i <= 2; i += 1) {
        const path: V3[] = [], lean = (random() - 0.5) * 0.01, long = 0.168 + random() * 0.02;
        for (let k = 0; k <= steps; k += 1) { const t = k / steps; path.push([-0.082 + long * t, 0.0165 + 0.05 * (1 - t) ** 2.2 * (1 - 0.2 * Math.abs(i)) + 0.02 * t ** 3 + Math.abs(i) * 0.004, i * (0.008 + 0.026 * Math.sin(t * 2.2)) + lean * t]); }
        tube(g, path, (t) => 0.0165 * Math.min(1, 0.36 + t * 7, 0.42 + (1 - t) * 4.6), 5, FRUIT.banana, { caps: true, twist: i * 0.3 });
      }
      const crown = g.count;
      lathe(g, [[0.01, 0], [0.012, 0.012], [0.008, 0.03], [0, 0.031]], { segs: 6, uv: [FRUIT.banana[0], lerp(FRUIT.banana[1], FRUIT.banana[3], 0.96), FRUIT.banana[2], FRUIT.banana[3]] });
      g.move(crown, -0.079, 0.064, 0, 0, 0, 1.25);
      return { parts: [{ geo: g, material: produce(), shift: (variant) => [(variant * 128) / PRODUCE_W, 0, 0, 0] }], variants: 2, palette: [0xffffff, 0xfff4d6, 0xf2f2d0], radius: 0.1, rest: "flat" };
    },
    tomato: () => {
      const g = new Geo(), h = 0.056, r = 0.037;
      lathe(g, ovoid(r, h, seg(8), { top: 0.006, bottom: 0.002, power: 0.92 }), { segs: seg(12), uv: FRUIT.tomato, poles: true, shape: (theta, _r, y, out) => { const f = 1 + 0.03 * Math.cos(theta * 5 + 1) * (y / h); out[0] *= f; out[2] *= f; } });
      // Calyx: five sepals lying on the shoulder, and the stub of the stalk.
      const leaf = FRUIT.leaf, yAt = (rho: number) => h / 2 + (h / 2) * Math.sin(Math.acos(Math.min(1, rho / r) ** (1 / 0.92))) - 0.006 * Math.exp(-((rho / (0.4 * r)) ** 2)) + 0.0012;
      for (let i = 0; i < 5; i += 1) {
        const a = (i / 5) * TAU + 0.3, c = Math.cos(a), s = Math.sin(a), reach = 0.019 + (i % 2) * 0.004, w = 0.0045;
        const centre = g.v(0, yAt(0) + 0.001, 0, 0, 1, 0, lerp(leaf[0], leaf[2], 0.5), leaf[1]);
        const left = g.v(c * reach * 0.45 - s * w, yAt(reach * 0.45), s * reach * 0.45 + c * w, 0, 1, 0, leaf[0], lerp(leaf[1], leaf[3], 0.5));
        const right = g.v(c * reach * 0.45 + s * w, yAt(reach * 0.45), s * reach * 0.45 - c * w, 0, 1, 0, leaf[2], lerp(leaf[1], leaf[3], 0.5));
        const tip = g.v(c * reach, yAt(reach) + 0.002, s * reach, c * 0.4, 0.9, s * 0.4, lerp(leaf[0], leaf[2], 0.5), leaf[3]);
        g.tri(centre, left, right); g.tri(left, tip, right);
      }
      tube(g, [[0, h - 0.008, 0], [0.001, h + 0.004, 0], [0.004, h + 0.011, 0.001]], 0.0017, 4, FRUIT.leaf, { caps: true });
      return { parts: [{ geo: g, material: produce() }], palette: [0xffffff, 0xffe6dc, 0xf6dcd0], radius: 0.037, rest: "up" };
    },
    pepper: () => {
      const g = new Geo(), random = rng(baseSeed * 101 + 4), lobes = 3, turn = random() * TAU;
      lathe(g, [[0, 0.012], [0.012, 0.004], [0.024, 0], [0.033, 0.008], [0.038, 0.03], [0.041, 0.06], [0.04, 0.078], [0.033, 0.09], [0.02, 0.094], [0.008, 0.088], [0, 0.084]], {
        segs: seg(12), uv: FRUIT.pepper, poles: true, crease: 3,
        // Blocky lobes, deepest at the blossom end.
        shape: (theta, _r, y, out) => { const f = 1 + (0.1 - 0.06 * (y / 0.094)) * Math.cos(theta * lobes + turn) + 0.03 * Math.cos(theta * 2 + 1); out[0] *= f; out[2] *= f; },
      });
      g.shade = [1, 1, 1, 1];
      tube(g, [[0, 0.083, 0], [0.001, 0.098, 0], [0.005, 0.112, 0.002]], (t) => 0.0062 - t * 0.0016, 5, FRUIT.leaf, { caps: true });
      return { parts: [{ geo: g, material: produce() }], palette: [0xc81e14, 0x2e7d1e, 0xe8b414, 0xdc5a16], radius: 0.042, rest: "up" };
    },
    onion: () => {
      const g = new Geo();
      lathe(g, [[0, 0.004], [0.008, 0], [0.022, 0.004], [0.034, 0.016], [0.04, 0.034], [0.038, 0.052], [0.028, 0.066], [0.014, 0.075], [0.006, 0.083], [0.003, 0.094], [0, 0.096]], { segs: seg(12), uv: FRUIT.onion, crease: 3 });
      return { parts: [{ geo: g, material: produce(), shift: (variant) => [(variant * 256) / PRODUCE_W, 0, 0, 0] }], variants: 2, palette: [0xffffff, 0xfff0e0, 0xf0e4e0], radius: 0.04, rest: "any" };
    },
    garlic: () => {
      const g = new Geo();
      lathe(g, [[0, 0.003], [0.012, 0], [0.022, 0.006], [0.027, 0.018], [0.025, 0.03], [0.016, 0.04], [0.007, 0.047], [0.005, 0.058], [0.0035, 0.066], [0, 0.067]], {
        segs: seg(16), uv: FRUIT.garlic, poles: true, crease: 3,
        shape: (theta, r, _y, out) => { const f = 1 - 0.1 * smooth(0.008, 0.02, r) * Math.abs(Math.sin(theta * 4)) ** 3; out[0] *= f; out[2] *= f; },
      });
      return { parts: [{ geo: g, material: produce(), slot: -1 }], radius: 0.027, rest: "any" };
    },
    grapes: () => {
      const g = new Geo(), random = rng(baseSeed * 103 + 6), cell = FRUIT.grape;
      // Twenty-sided berries packed round a cone, pressed flat where the bunch lies.
      const T = (1 + Math.sqrt(5)) / 2, corners: V3[] = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]];
      const faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
      const norm = Math.hypot(1, T), rings = high ? 7 : 5;
      for (let ring = 0; ring < rings; ring += 1) {
        const t = ring / (rings - 1), rho = 0.034 * (1 - t ** 1.6), n = Math.max(1, Math.round((TAU * rho) / 0.0235)), x = -0.055 + t * 0.118;
        for (let i = 0; i < n; i += 1) {
          const a = (i / n) * TAU + ring * 0.9, r = 0.0105 + random() * 0.0018, from = g.count, tone = 0.82 + random() * 0.18;
          g.shade = [tone, tone, tone, 1];
          for (const [cx, cy, cz] of corners) g.v((cx / norm) * r, (cy / norm) * r * 1.12, (cz / norm) * r, cx / norm, cy / norm, cz / norm, lerp(cell[0], cell[2], 0.5 + (cx / norm) * 0.45), lerp(cell[1], cell[3], 0.5 + (cy / norm) * 0.45));
          for (let k = 0; k < faces.length; k += 3) g.tri(from + faces[k], from + faces[k + 1], from + faces[k + 2]);
          g.move(from, x + (random() - 0.5) * 0.006, 0.0115 + Math.max(0, 0.026 + Math.sin(a) * rho * 0.78), Math.cos(a) * rho, random() * 3, random() * 3, random() * 3);
        }
      }
      g.shade = [1, 1, 1, 1];
      tube(g, [[0.03, 0.035, 0], [-0.045, 0.04, 0], [-0.07, 0.05, 0.002], [-0.092, 0.066, 0.004]], (t) => 0.0016 + t * 0.0012, 4, FRUIT.stem, { caps: true });
      tube(g, [[-0.092, 0.058, -0.01], [-0.092, 0.066, 0.004], [-0.09, 0.07, 0.02]], 0.0024, 4, FRUIT.stem, { caps: true });
      return { parts: [{ geo: g, material: produce() }], palette: [0x9db53a, 0x4a1e4a, 0x7a2030, 0xa8c04a], radius: 0.07, rest: "flat" };
    },
    // ---- Jars, crocks and amphorae -----------------------------------------------------------------
    jarCeramic: () => {
      const g = new Geo(), segs = seg(20), cell = POT.glazed, upper: Rect = [cell[0], lerp(cell[1], cell[3], 0.6), cell[2], cell[3]], foot: Rect = [cell[0], cell[1], cell[2], lerp(cell[1], cell[3], 0.05)], body: Rect = [cell[0], lerp(cell[1], cell[3], 0.072), cell[2], cell[3]], shape = handmade(1, 0.3), colour = glazeOn([0.212], [0.2715, 0.3, 0.362]);
      lathe(g, [[0, 0.004], [0.066, 0.004], [0.07, 0]], { segs, wrap: 2, uv: foot });
      // A turned groove on the shoulder and a cordon under the neck.
      lathe(g, [[0.07, 0], [0.078, 0.008], [0.08, 0.02], [0.115, 0.08], [0.132, 0.15], [0.1295, 0.2], [0.1275, 0.2075], [0.1245, 0.212], [0.1262, 0.2165], [0.105, 0.262], [0.0985, 0.267], [0.1, 0.2715], [0.092, 0.2745], [0.075, 0.285], [0.068, 0.3]], { segs, wrap: 2, uv: body, crease: 1.1, shape, colour });
      // The lid: a dome with a turned knob.
      lathe(g, [[0.066, 0.288], [0.08, 0.292], [0.082, 0.3], [0.07, 0.325], [0.035, 0.338], [0.012, 0.342], [0.01, 0.352], [0.018, 0.362], [0.016, 0.372], [0, 0.376]], { segs, wrap: 2, uv: upper, crease: 1.1, shape, colour, poles: true });
      return { parts: [{ geo: g, material: ceramic() }], palette: [0xd8d2c2, 0xa2b0a0, 0x566068, 0x85663a, 0x5c2620, 0x3a5752] };
    },
    crock: () => {
      const g = new Geo(), segs = seg(20), cell = POT.glazed, upper: Rect = [cell[0], lerp(cell[1], cell[3], 0.62), cell[2], cell[3]], plain: Rect = [cell[0], lerp(cell[1], cell[3], 0.5), cell[2], lerp(cell[1], cell[3], 0.56)], foot: Rect = [cell[0], cell[1], cell[2], lerp(cell[1], cell[3], 0.05)], body: Rect = [cell[0], lerp(cell[1], cell[3], 0.072), cell[2], cell[3]], shape = handmade(2, 0.29, 0.008, 0.01);
      // A band of cobalt slip under the glaze.
      const colour = glazeOn([0.249], [0.283, 0.292, 0.326], (y) => (y > 0.151 && y < 0.179 ? [0.4, 0.5, 0.8, 1] : undefined));
      lathe(g, [[0, 0.004], [0.106, 0.004], [0.11, 0]], { segs, wrap: 2, uv: foot });
      lathe(g, [[0.11, 0], [0.118, 0.006], [0.12, 0.02], [0.1245, 0.15, 1], [0.1247, 0.152], [0.1249, 0.178], [0.125, 0.18, 1], [0.125, 0.244], [0.1222, 0.249], [0.1242, 0.254], [0.118, 0.268], [0.122, 0.276], [0.128, 0.283], [0.124, 0.292], [0.112, 0.29]], { segs, wrap: 2, uv: body, crease: 1.1, shape, colour });
      lathe(g, [[0.112, 0.286], [0.105, 0.298], [0.03, 0.304], [0.026, 0.318], [0.034, 0.326], [0.028, 0.334], [0, 0.336]], { segs, wrap: 2, uv: upper, crease: 0.9, shape, colour, poles: true });
      for (const side of [-1, 1]) tube(g, ([[0.117, 0.218, 0], [0.15, 0.224, 0], [0.155, 0.2, 0], [0.12, 0.184, 0]] as V3[]).map(([x, y, z]) => [x * side, y, z] as V3), 0.0095, seg(6), plain, { squash: 1.5 });
      return { parts: [{ geo: g, material: ceramic() }], palette: [0xcfc6ae, 0xb09a78, 0xa7aaa2, 0xc4b594] };
    },
    amphora: () => {
      const g = new Geo(), segs = seg(24), cell = POT.earthen, plain: Rect = [cell[0], lerp(cell[1], cell[3], 0.44), cell[2], lerp(cell[1], cell[3], 0.52)];
      lathe(g, [[0, 0.006], [0.062, 0.006], [0.07, 0], [0.085, 0.012], [0.075, 0.03], [0.06, 0.05], [0.13, 0.14], [0.2, 0.28], [0.235, 0.42], [0.225, 0.56], [0.17, 0.68], [0.1, 0.76], [0.07, 0.8], [0.065, 0.86], [0.085, 0.9], [0.095, 0.915], [0.09, 0.925]], { segs, wrap: 2, uv: cell, crease: 1.1 });
      g.shade = [0.34, 0.3, 0.28, 1];
      lathe(g, [[0.09, 0.925], [0.07, 0.92], [0.055, 0.88], [0.05, 0.8], [0, 0.8]], { segs, wrap: 2, uv: plain, crease: 1.1 });
      g.shade = [1, 1, 1, 1];
      for (const side of [-1, 1]) tube(g, ([[0.064, 0.848, 0], [0.13, 0.868, 0], [0.175, 0.81, 0], [0.19, 0.71, 0], [0.176, 0.628, 0]] as V3[]).map(([x, y, z]) => [x * side, y, z] as V3), 0.017, seg(6), plain, { squash: 1.45 });
      return { parts: [{ geo: g, material: ceramic() }], palette: [0xb86a42, 0xc98a5e, 0x9a5a3c, 0xd0a878] };
    },
    urn: () => {
      const g = new Geo(), segs = seg(24), cell = POT.glazed, plain: Rect = [cell[0], lerp(cell[1], cell[3], 0.5), cell[2], lerp(cell[1], cell[3], 0.58)], foot: Rect = [cell[0], cell[1], cell[2], lerp(cell[1], cell[3], 0.05)], body: Rect = [cell[0], lerp(cell[1], cell[3], 0.072), cell[2], cell[3]], shape = handmade(3, 0.76), colour = glazeOn([0.5, 0.525], [0.681, 0.75, 0.762]);
      // The glaze stops short of the foot: the underside and the foot ring are bare clay.
      lathe(g, [[0, 0.006], [0.122, 0.006], [0.13, 0]], { segs, wrap: 2, uv: foot });
      // Two turned grooves on the shoulder, a cordon where the neck begins.
      lathe(g, [[0.13, 0], [0.15, 0.01], [0.16, 0.03], [0.23, 0.16], [0.285, 0.34], [0.29, 0.44], [0.2772, 0.4955], [0.2735, 0.5], [0.2752, 0.5045], [0.2714, 0.5205], [0.2677, 0.525], [0.2694, 0.5295], [0.26, 0.57], [0.2, 0.66], [0.188, 0.674], [0.19, 0.681], [0.179, 0.686], [0.165, 0.7], [0.17, 0.72], [0.195, 0.735], [0.2, 0.75], [0.185, 0.762]], { segs, wrap: 2, uv: body, crease: 1.1, shape, colour });
      g.shade = [0.3, 0.27, 0.25, 1];
      lathe(g, [[0.185, 0.762], [0.165, 0.755], [0.15, 0.72], [0.16, 0.62], [0, 0.62]], { segs, wrap: 2, uv: plain, crease: 1.1, shape, poles: true });
      g.shade = [1, 1, 1, 1];
      for (const side of [-1, 1]) tube(g, ([[0.224, 0.612, 0], [0.288, 0.64, 0], [0.31, 0.585, 0], [0.262, 0.535, 0]] as V3[]).map(([x, y, z]) => [x * side, y, z] as V3), 0.014, seg(6), plain, { squash: 1.5 });
      return { parts: [{ geo: g, material: ceramic() }], palette: [0xa2b0a0, 0x8c703c, 0x3a5752, 0x5c2620, 0x503828, 0xd8d2c2] };
    },
    // ---- Cartons --------------------------------------------------------------------------------
    carton: () => carton(0.46, 0.32, 0.34),
    cartonSmall: () => carton(0.3, 0.2, 0.22),
    cartonLarge: () => carton(0.6, 0.42, 0.45),
    cartonFlat: () => carton(0.56, 0.12, 0.4),
    cartonTall: () => carton(0.34, 0.6, 0.34),
    cartonOpen: () => carton(0.46, 0.32, 0.34, { open: true }),
    cartonCrushed: () => carton(0.46, 0.3, 0.34, { crushed: true }),
    // ---- Sacks and baskets --------------------------------------------------------------------------
    sack: () => {
      const g = new Geo(), segs = seg(24), pleats = 8;
      // A full sack, tied at the neck: it slumps wider than it is deep, bulges unevenly and gathers into pleats.
      const shape: LatheOptions["shape"] = (theta, r, y, out) => {
        if (r === 0) return;
        const bodyWeight = smooth(0.01, 0.1, y) * (1 - smooth(0.46, 0.6, y)), lump = 0.05 * Math.sin(theta * 3 + y * 5) * Math.sin(y * 7 + 1) + 0.035 * Math.sin(theta * 5 - y * 9 + 2);
        const gather = 0.17 * Math.cos(theta * pleats) * smooth(0.5, 0.63, y) + 0.2 * Math.cos(theta * pleats + 1) * smooth(0.66, 0.74, y);
        const f = 1 + lump * bodyWeight + gather;
        out[0] *= f * lerp(1, 1.08, bodyWeight); out[2] *= f * lerp(1, 0.93, bodyWeight);
        out[1] += 0.012 * Math.sin(theta * 2 + 0.7) * smooth(0.6, 0.76, y);
      };
      lathe(g, [[0, 0], [0.14, 0], [0.2, 0.02], [0.235, 0.1], [0.245, 0.22], [0.235, 0.36], [0.205, 0.48], [0.15, 0.57], [0.075, 0.625], [0.05, 0.645], [0.048, 0.665], [0.075, 0.7], [0.105, 0.74], [0.11, 0.755], [0.095, 0.75], [0.04, 0.69], [0, 0.68]], {
        segs, uv: [0, 0, 7, 5], shape, crease: 2.4, windows: [{ at: 0.25, span: 5 / 24, y0: 0.1, y1: 0.46, rect: MARK.sack }],
        colour: (_t, y) => { const dust = 0.82 + 0.18 * smooth(0, 0.14, y); return [dust, dust, dust, 1]; },
      });
      // Two turns of twine.
      g.shade = [0.5, 0.42, 0.3, 1];
      for (const y of [0.649, 0.661]) { const ring: V3[] = []; for (let k = 0; k <= 10; k += 1) { const a = (k / 10) * TAU; ring.push([Math.cos(a) * 0.054, y + Math.sin(a * 2) * 0.002, Math.sin(a) * 0.054]); } tube(g, ring, 0.0045, 4, [0, 0, 0.1, 1.2]); }
      g.shade = [1, 1, 1, 1];
      return { parts: [{ geo: g, material: burlap(), shift: (variant, random) => [random(), random(), variant * MARK_STEP, 0] }], variants: 4, palette: [0xffffff, 0xeee2cc, 0xe2d2b4, 0xf6f0e2] };
    },
    sackLying: () => {
      const g = new Geo(), W = 0.74, H = 0.2, D = 0.46, hx = W / 2, hz = D / 2;
      softBox(g, W, H, D, {
        radius: 0.09, round: high ? 2 : 1, cuts: [4, 1, 3], skip: NY, uv: (f, a, b) => [a / 0.2 + f * 0.31, b / 0.2],
        windows: [
          { face: 2, a0: -0.2, b0: -0.178, a1: 0.2, b1: 0.178, rect: MARK.sack, turn: true },
          { face: 2, a0: hx - 0.062, b0: -hz + 0.04, a1: hx - 0.04, b1: hz - 0.04, rect: MARK.stitch, fixed: true, turn: true },
          { face: 2, a0: -hx + 0.04, b0: -hz + 0.04, a1: -hx + 0.062, b1: hz - 0.04, rect: MARK.stitch, fixed: true, turn: true },
        ],
        // A pillow: fat in the middle, pinched flat to the sewn ends, lumpy on top.
        warp: (p) => {
          const ax = p[0] / hx, az = p[2] / hz, pinch = 1 - 0.82 * Math.abs(ax) ** 3.2, up = (p[1] + H / 2) / H;
          p[1] = (p[1] + H / 2) * pinch * (1 + 0.1 * (1 - az * az)) + up * 0.014 * Math.sin(p[0] * 13 + 1) * Math.sin(p[2] * 11) * (1 - Math.abs(ax));
          p[2] *= 1 + 0.06 * Math.abs(ax) ** 2; p[0] += up * 0.01 * Math.sin(p[2] * 9);
        },
      });
      return { parts: [{ geo: g, material: burlap(), shift: (variant, random) => [random(), random(), variant * MARK_STEP, 0] }], variants: 4, palette: [0xffffff, 0xeee2cc, 0xe2d2b4, 0xf6f0e2], rest: "flat" };
    },
    sackOpen: () => {
      const g = new Geo(), fill = new Geo(), segs = seg(24), R = 0.224;
      const shape: LatheOptions["shape"] = (theta, r, y, out) => {
        if (r === 0) return;
        const weight = smooth(0.01, 0.1, y) * (1 - smooth(0.26, 0.345, y)), f = 1 + (0.05 * Math.sin(theta * 3 + y * 6) * Math.sin(y * 8 + 1) + 0.03 * Math.sin(theta * 5 - y * 9 + 2)) * weight + 0.012 * Math.sin(theta * 2 + 1);
        out[0] *= f * lerp(1, 1.05, weight); out[2] *= f * lerp(1, 0.96, weight);
        out[1] += 0.008 * Math.sin(theta * 3 + 2) * smooth(0.33, 0.36, y);
      };
      // The mouth is rolled down on itself into a thick collar.
      lathe(g, [[0, 0], [0.15, 0], [0.21, 0.02], [0.24, 0.1], [0.246, 0.2], [0.238, 0.3], [0.234, 0.348], [0.252, 0.346], [0.272, 0.356], [0.282, 0.378], [0.272, 0.4], [0.25, 0.412], [0.232, 0.404], [0.224, 0.386], [0.222, 0.34]], {
        segs, uv: [0, 0, 7, 3.4], shape, crease: 2.4, colour: (_t, y) => { const dust = 0.82 + 0.18 * smooth(0, 0.14, y); return [dust, dust, dust, 1]; },
      });
      // What it holds, heaped a little: a grid of tiles of the goods texture, drawn in to the collar at its edge.
      const cell = FRUIT.grain, TILE = 0.15, n = 6, step = TILE / 2, heightAt = (x: number, z: number) => 0.352 + 0.04 * (1 - (x * x + z * z) / (R * R)) + 0.006 * Math.sin(x * 31 + 1) * Math.sin(z * 27);
      for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
        const ids: number[] = [], tx = Math.floor((i - n / 2) / 2), tz = Math.floor((j - n / 2) / 2);
        let outside = 0;
        for (const [di, dj] of [[0, 1], [1, 1], [1, 0], [0, 0]]) {
          let x = (i + di - n / 2) * step, z = (j + dj - n / 2) * step;
          const d = Math.hypot(x, z);
          if (d > R) { x *= R / d; z *= R / d; outside += 1; }
          const y = heightAt(x, z), nx = -(heightAt(x + 0.01, z) - heightAt(x - 0.01, z)) / 0.02, nz = -(heightAt(x, z + 0.01) - heightAt(x, z - 0.01)) / 0.02, size = Math.hypot(nx, 1, nz);
          ids.push(fill.v(x, y, z, nx / size, 1 / size, nz / size, lerp(cell[0], cell[2], clamp01(x / TILE - tx)), lerp(cell[1], cell[3], clamp01(z / TILE - tz))));
        }
        if (outside < 4) fill.quad(ids[0], ids[1], ids[2], ids[3]);
      }
      return {
        parts: [{ geo: g, material: burlap(), shift: (_variant, random) => [random(), random(), 0, 0] }, { geo: fill, material: produce(), slot: 1, cast: false, shift: (variant) => [((variant % 4) * 256) / PRODUCE_W, (-Math.floor(variant / 4) * 256) / PRODUCE_H, 0, 0] }],
        variants: GRAINS, tied: true, palette: [0xffffff, 0xeee2cc, 0xe2d2b4, 0xf6f0e2, 0xffffff, 0xeee2cc, 0xe2d2b4, 0xf6f0e2], palette2: [0xffffff, 0xffffff, 0xffffff, 0xd69a1c, 0xffffff, 0xffffff, 0xffffff, 0xffffff],
      };
    },
    basket: () => {
      const g = new Geo(), segs = seg(24), wobble: LatheOptions["shape"] = (theta, _r, y, out) => { const f = 1 + 0.016 * Math.sin(theta * 2 + 1) + 0.008 * Math.sin(theta * 5 + y * 20); out[0] *= f; out[2] *= f; };
      lathe(g, [[0, 0.004], [0.15, 0.004], [0.165, 0]], { segs, uv: [0, 0, 1.6, 1.6], planar: 0.165 });
      lathe(g, [[0.165, 0], [0.172, 0.012], [0.2, 0.1], [0.228, 0.2], [0.238, 0.236]], { segs, uv: [0, 0, 6, 1.25], shape: wobble, colour: (_t, y) => { const tone = 0.78 + 0.22 * smooth(0, 0.1, y); return [tone, tone, tone, 1]; } });
      // The border: a thick roll wrapped the other way.
      lathe(g, [[0.238, 0.236], [0.249, 0.238], [0.255, 0.25], [0.249, 0.262], [0.236, 0.264], [0.227, 0.254], [0.226, 0.246]], { segs, uv: [0, 0, 26, 0.22], shape: wobble, crease: 3 });
      g.shade = [0.72, 0.7, 0.68, 1];
      lathe(g, [[0.226, 0.246], [0.218, 0.2], [0.19, 0.1], [0.164, 0.016]], { segs, uv: [0, 0, 6, 1.25], shape: wobble });
      lathe(g, [[0.164, 0.016], [0, 0.014]], { segs, uv: [0, 0, 1.6, 1.6], planar: 0.165 });
      g.shade = [1, 1, 1, 1];
      for (const side of [-1, 1]) tube(g, ([[0.24, 0.252, -0.062], [0.262, 0.298, -0.04], [0.27, 0.318, 0], [0.262, 0.298, 0.04], [0.24, 0.252, 0.062]] as V3[]).map(([x, y, z]) => [x * side, y, z] as V3), 0.008, seg(6), [0, 0, 0.3, 2.4]);
      return { parts: [{ geo: g, material: wicker(), shift: (_variant, random) => [random(), 0, 0, 0] }], palette: [0xffffff, 0xe4d2b8, 0xb89468], radius: 0.19, inside: { floor: 0.016, radius: 0.158, rim: 0.2, flare: 0.27 } };
    },
    basketTray: () => {
      const g = new Geo(), segs = seg(24);
      lathe(g, [[0, 0.003], [0.22, 0.003], [0.24, 0]], { segs, uv: [0, 0, 2.4, 2.4], planar: 0.24 });
      lathe(g, [[0.24, 0], [0.262, 0.012], [0.3, 0.06]], { segs, uv: [0, 0, 8, 0.4] });
      lathe(g, [[0.3, 0.06], [0.311, 0.062], [0.316, 0.073], [0.31, 0.084], [0.298, 0.085], [0.291, 0.076], [0.29, 0.07]], { segs, uv: [0, 0, 32, 0.22], crease: 3 });
      g.shade = [0.76, 0.74, 0.72, 1];
      lathe(g, [[0.29, 0.07], [0.258, 0.022], [0.238, 0.011]], { segs, uv: [0, 0, 8, 0.4] });
      lathe(g, [[0.238, 0.011], [0, 0.01]], { segs, uv: [0, 0, 2.4, 2.4], planar: 0.24 });
      g.shade = [1, 1, 1, 1];
      return { parts: [{ geo: g, material: wicker(), shift: (_variant, random) => [random(), 0, 0, 0] }], palette: [0xffffff, 0xe4d2b8, 0xb89468], radius: 0.25, inside: { floor: 0.011, radius: 0.232, rim: 0.05, flare: 0.8 } };
    },
    // ---- More drums and crates --------------------------------------------------------------------
    drumPlastic: () => {
      const g = new Geo(), fit = new Geo(), segs = seg(32), R = 0.29;
      const rib = (y: number): ProfilePoint[] => [[R, y - 0.03], [R + 0.007, y - 0.016], [R + 0.007, y + 0.016], [R, y + 0.03]];
      // Open-head drum: a moulded body with two rolling hoops, and a dark lid held down by a lever ring.
      lathe(g, [[0, 0.012], [0.25, 0.012], [0.262, 0], [0.278, 0.004], [0.286, 0.03], [R, 0.2], ...rib(0.3), ...rib(0.63), [R, 0.8], [0.283, 0.838], [0.286, 0.856]], {
        segs, uv: [0, 0, 6, 3], crease: 1, colour: (_t, y) => { const dust = 0.8 + 0.2 * smooth(0, 0.25, y); return [dust, dust, dust, 1]; },
        windows: [{ at: 0.25, span: 5 / 32, y0: 0.39, y1: 0.555, rect: MARK.drumLabel }],
      });
      g.shade = [0.2, 0.2, 0.21, 1];
      lathe(g, [[0.288, 0.86], [0.292, 0.9], [0.286, 0.914], [0.27, 0.924], [0.2, 0.924], [0.192, 0.916], [0.1, 0.916], [0, 0.918]], { segs, uv: [0, 0, 1.6, 1.6], planar: 0.29, crease: 0.9 });
      g.shade = [1, 1, 1, 1];
      lathe(fit, [[0.289, 0.853], [0.3, 0.857], [0.303, 0.874], [0.3, 0.891], [0.292, 0.896]], { segs, uv: [0, 0, 6, 0.12], crease: 1.4 });
      const lever = fit.count;
      box(fit, 0, 0.874, 0.31, 0.11, 0.03, 0.014, { bevel: 0.003, uv: (_f, a, b) => [0.5 + a, 0.5 + b] });
      box(fit, 0.07, 0.874, 0.304, 0.03, 0.036, 0.022, { bevel: 0.003, uv: (_f, a, b) => [0.2 + a, 0.2 + b] });
      fit.xf(lever, new THREE.Matrix4().makeRotationY(2.2));
      return { parts: [{ geo: g, material: plastic(), shift: driftShift }, { geo: fit, material: iron(), slot: 1 }], variants: 4, palette: [0x1d4f9e, 0x1a3f7c, 0x24507e, 0x2c6e49, 0x9a9788], palette2: [0x868987] };
    },
    keg: () => {
      const g = new Geo(), segs = seg(32), R = 0.2, holes: LatheWindow[] = [0, 0.5].map((at) => ({ at, span: 4 / 32, y0: 0.548, y1: 0.584, hole: true }));
      const bead = (y: number): ProfilePoint[] => [[R, y - 0.016], [R + 0.007, y - 0.006], [R + 0.007, y + 0.006], [R, y + 0.016]];
      // Scuffed where it is rolled and stacked: the chimes and the beads.
      const scuff = (_t: number, y: number, r: number): RGBA => [1, 1, 1, r > R + 0.004 || y < 0.012 || y > 0.59 ? 0.72 : 1];
      lathe(g, [[0, 0.05], [0.18, 0.04], [0.18, 0.006], [0.186, 0], [0.196, 0.003], [R, 0.012], ...bead(0.2), ...bead(0.4), [R, 0.5], [R, 0.54], [R, 0.588], [0.196, 0.597], [0.188, 0.6], [0.184, 0.594], [0.184, 0.584, 1], [0.184, 0.548, 1], [0.184, 0.53]], { segs, uv: [0, 0, 5, 2.4], crease: 1, colour: scuff, windows: holes });
      lathe(g, [[0.184, 0.53], [0.16, 0.545], [0.1, 0.56], [0.04, 0.566], [0.032, 0.566], [0.032, 0.586], [0.026, 0.591], [0.026, 0.598], [0, 0.598]], { segs: seg(20), uv: [0, 0, 1.2, 1.2], planar: 0.19, crease: 0.9 });
      return { parts: [{ geo: g, material: iron(), shift: driftShift }], palette: [0xeceef0, 0xdcdfe0, 0xc6cacc], radius: 0.21 };
    },
    crateLarge: () => crate(1.08, 0.84, 0.82, { planks: 7, batten: 0.09, thick: 0.022, skid: 0.05, seed: 1 }),
    crateSmall: () => crate(0.62, 0.44, 0.46, { planks: 5, batten: 0.06, thick: 0.018, skid: 0, seed: 2 }),
    crateProduce: () => {
      const g = new Geo(), random = rng(baseSeed * 79 + 13), W = 0.5, D = 0.34, H = 0.14, t = 0.008, slat = 0.046, post = 0.026;
      const px = W / 2 - t - post / 2, pz = D / 2 - t - post / 2, stamp = windowOn(MARK.pallet, -0.027, -0.02, 0.027, 0.02);
      for (const y of [0.035, 0.115]) for (const side of [1, -1]) {
        board(g, random, 0, y, side * (D / 2 - t / 2), W, slat, t);
        board(g, random, side * (W / 2 - t / 2), y, 0, t, slat, D - 2 * t - 0.002, { cuts: (f) => (y > 0.1 && f === (side > 0 ? 0 : 1) ? [-0.027, 0.027] : null), decal: (f, a, b, mid) => (y > 0.1 && f === (side > 0 ? 0 : 1) ? stamp(a, b, mid) : null) });
        for (const end of [-1, 1]) { nail(g, end * px, y, side * (D / 2), side > 0 ? 4 : 5, 0.0026); nail(g, side * (W / 2), y, end * pz, side > 0 ? 0 : 1, 0.0026); }
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) board(g, random, sx * px, H / 2, sz * pz, post, H, post, { skip: NY });
      for (let i = 0; i < 5; i += 1) board(g, random, -0.196 + i * 0.098, 0.016, 0, 0.082, 0.007, D - 2 * t - 0.004, { skip: NY, grain: 2 });
      return { parts: [{ geo: g, material: wood(), shift: woodShift }], variants: 2, palette: [0xf4e2c8, 0xe8d2b0, 0xdcc8a8], inside: { floor: 0.02, size: [0.476, 0.316], rim: 0.11, flare: 0 } };
    },
    crateAmmo: () => {
      const g = new Geo(), fit = new Geo(), rope = new Geo(), random = rng(baseSeed * 83 + 17), W = 0.8, D = 0.36, H = 0.28, t = 0.018, lid = 0.02;
      const y0 = 0.07, y1 = 0.21, half = 0.2, stencil = (y: number) => windowOn(MARK.ammo, -half, 0.105 - y, half, 0.255 - y);
      // Two boards to each long side, the mark sprayed across the joint; a lid that sits proud all round.
      for (const side of [1, -1]) for (const y of [y0, y1]) {
        const mark = stencil(y);
        board(g, random, 0, y, side * (D / 2 - t / 2), W, 0.138, t, { cuts: (f) => (side > 0 && f === 4 ? [-half, half] : null), decal: (f, a, b, mid) => (side > 0 && f === 4 ? mark(a, b, mid) : null) });
      }
      for (const side of [1, -1]) {
        board(g, random, side * (W / 2 - t / 2), H / 2, 0, t, H - 0.002, D - 2 * t - 0.002, { grain: 2 });
        board(g, random, side * (W / 2 + 0.011), 0.165, 0, 0.022, 0.07, D * 0.86, { grain: 2 });
        // Rope becket through the cleat.
        const x = side * (W / 2 + 0.022);
        tube(rope, ([[0, 0.168, -0.075], [0.012, 0.16, -0.075], [0.034, 0.118, -0.058], [0.04, 0.092, 0], [0.034, 0.118, 0.058], [0.012, 0.16, 0.075], [0, 0.168, 0.075]] as V3[]).map(([dx, y, z]) => [x + dx * side, y, z] as V3), 0.0085, seg(6), [0, 0, 0.22, 2.2], { twist: 9, caps: true });
      }
      board(g, random, 0, 0.009, 0, W - 2 * t - 0.002, t, D - 2 * t - 0.002, { skip: NY });
      board(g, random, 0, H + lid / 2, 0, W + 0.008, lid, D + 0.008);
      // Hinges at the back, toggle latches at the front: plates on lid and body, a knuckle or a wire loop between.
      const plain = (_f: number, a: number, b: number): [number, number] => [0.5 + a * 2, 0.5 + b * 2];
      for (const x of [-0.24, 0.24]) {
        box(fit, x, H - 0.03, -D / 2 - 0.0015, 0.05, 0.05, 0.003, { bevel: 0.001, skip: PZ, uv: plain });
        box(fit, x, H + 0.01, -D / 2 - 0.0055, 0.05, 0.02, 0.003, { bevel: 0.001, skip: PZ, uv: plain });
        const knuckle = fit.count;
        lathe(fit, [[0, -0.027], [0.005, -0.027], [0.005, 0.027], [0, 0.027]], { segs: 6, uv: [0, 0, 0.1, 0.1], crease: 1 });
        fit.move(knuckle, x, H - 0.002, -D / 2 - 0.006, 0, 0, Math.PI / 2);
        box(fit, x, H - 0.045, D / 2 + 0.0015, 0.04, 0.05, 0.003, { bevel: 0.001, skip: NZ, uv: plain });
        box(fit, x, H + 0.01, D / 2 + 0.0055, 0.04, 0.018, 0.003, { bevel: 0.001, skip: NZ, uv: plain });
        box(fit, x, H - 0.014, D / 2 + 0.006, 0.022, 0.05, 0.004, { bevel: 0.0015, uv: plain });
        for (const dx of [-0.013, 0.013]) for (const y of [H - 0.06, H - 0.032]) nail(fit, x + dx, y, D / 2 + 0.003, 4, 0.003);
      }
      return {
        parts: [{ geo: g, material: wood(), shift: woodShift }, { geo: fit, material: iron(), slot: 1 }, { geo: rope, material: burlap(), slot: -1, shift: (_variant, random2) => [random2(), random2(), 0, 0] }],
        variants: 4, palette: [0x7a8450, 0x6a7446, 0x8a8a5c, 0x5c6a40], palette2: [0x404143],
      };
    },
    cratePlastic: () => {
      const g = new Geo(), W = 0.4, D = 0.3, H = 0.27, wall = 0.012, pillar = 0.036, band = 0.075, foot = 0.06;
      const uv = (f: number, a: number, b: number): [number, number] => [a / 0.25 + f * 0.3, b / 0.25], logo = windowOn(MARK.plastic, -0.1, -0.0375, 0.1, 0.0375);
      box(g, 0, 0.006, 0, W - 0.004, 0.012, D - 0.004, { bevel: 0.003, uv });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, sx * (W / 2 - pillar / 2), H / 2, sz * (D / 2 - pillar / 2), pillar, H, pillar, { bevel: 0.005, uv });
      for (const side of [1, -1]) {
        const z = side * (D / 2 - wall / 2), x = side * (W / 2 - wall / 2), f = side > 0 ? 4 : 5;
        // Long sides: a branded band at the top, a kick band at the foot, a post between.
        box(g, 0, H - band / 2, z, W - 2 * pillar, band, wall, { bevel: 0.003, uv, cuts: (face) => (face === f ? [-0.1, 0.1] : null), decal: (face, a, b, mid) => (face === f ? logo(a, b, mid) : null) });
        box(g, 0, foot / 2 + 0.008, z, W - 2 * pillar, foot, wall, { bevel: 0.003, uv });
        box(g, 0, H / 2, z, 0.03, H - band - foot, wall, { bevel: 0.002, uv, skip: PY | NY });
        // Ends: the same, with a hand hold through the top band.
        box(g, x, H - 0.011, 0, wall, 0.022, D - 2 * pillar, { bevel: 0.003, uv });
        box(g, x, H - band + 0.009, 0, wall, 0.018, D - 2 * pillar, { bevel: 0.003, uv });
        for (const end of [-1, 1]) box(g, x, H - band / 2, end * (D / 2 - pillar - 0.027), wall, band - 0.036, 0.054, { bevel: 0.002, uv, skip: PY | NY });
        box(g, x, foot / 2 + 0.008, 0, wall, foot, D - 2 * pillar, { bevel: 0.003, uv });
      }
      // The grid that keeps twelve bottles apart.
      g.shade = [0.8, 0.8, 0.8, 1];
      for (const x of [-0.092, 0, 0.092]) box(g, x, 0.07, 0, 0.004, 0.116, D - 2 * wall, { uv, skip: NY });
      for (const z of [-0.046, 0.046]) box(g, 0, 0.07, z, W - 2 * wall, 0.116, 0.004, { uv, skip: NY });
      g.shade = [1, 1, 1, 1];
      return { parts: [{ geo: g, material: plastic(), shift: driftShift }], variants: 2, palette: [0xb5221c, 0x1c4fa0, 0xd9a514, 0x1f7a3a, 0x2a2c2e] };
    },
  };

  // ---- Access --------------------------------------------------------------------------------
  const SCALE: Record<PropInfo["scale"], PropKind[]> = {
    small: ["bottleWine", "bottleBeer", "bottleSpirits", "bottleSoda", "bottleSauce", "jar", "tin", "orange", "lemon", "apple", "pomegranate", "melon", "watermelon", "bananas", "tomato", "pepper", "onion", "garlic", "grapes"],
    medium: ["jarCeramic", "crock", "crateSlat", "crateSmall", "crateProduce", "crateAmmo", "cratePlastic", "pallet", "carton", "cartonSmall", "cartonLarge", "cartonFlat", "cartonTall", "cartonOpen", "cartonCrushed", "sack", "sackLying", "sackOpen", "basket", "basketTray", "keg"],
    large: ["amphora", "urn", "cask", "drum", "drumPlastic", "crateLarge"],
  };
  const scaleOf = (kind: PropKind): PropInfo["scale"] => (SCALE.small.includes(kind) ? "small" : SCALE.large.includes(kind) ? "large" : "medium");
  const cache = new Map<PropKind, PropInfo>(), tied = new Set<PropKind>();
  const get = (kind: PropKind): PropInfo => {
    const known = cache.get(kind);
    if (known) return known;
    const make = drafts[kind];
    if (!make) throw new Error(`props: unknown kind "${kind}"`);
    const draft = make(), bounds = new THREE.Box3();
    let triangles = 0;
    const parts = draft.parts.map((part): PropPart => {
      const geometry = track(part.geo.build());
      bounds.union(geometry.boundingBox!);
      triangles += part.geo.triangles;
      return { geometry, material: part.material, slot: part.slot ?? 0, cast: part.cast ?? true, shift: part.shift ?? NO_SHIFT };
    });
    const size = bounds.getSize(new THREE.Vector3());
    const info: PropInfo = {
      kind, size: [size.x, size.y, size.z], triangles, parts, variants: draft.variants ?? 1, palette: draft.palette ?? [0xffffff], palette2: draft.palette2 ?? [0xffffff],
      scale: scaleOf(kind), radius: draft.radius ?? Math.max(size.x, size.z) / 2, rest: draft.rest ?? "up", ...(draft.inside ? { inside: draft.inside } : {}),
    };
    if (draft.tied) tied.add(kind);
    cache.set(kind, info);
    return info;
  };

  const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
  const listed = (value: THREE.ColorRepresentation | THREE.ColorRepresentation[] | undefined, index: number) => (Array.isArray(value) ? value[index % value.length] : value);

  const place = (kind: PropKind, items: PropItem[], o: PlaceOptions = {}): THREE.InstancedMesh[] => {
    if (!items.length) return [];
    const info = get(kind), random = rng((o.seed ?? baseSeed) * 7919 + hash(kind)), count = items.length, vary = o.vary ?? 0.5;
    const small = info.scale === "small", shadow = o.shadow ?? !small, hit = o.hit ?? !small;
    const variants = items.map((item) => (((item.variant ?? o.variant ?? Math.floor(random() * info.variants)) % info.variants) + info.variants) % info.variants);
    // One natural variation per item, shared by its parts: a little lighter or darker, a little warmer or cooler.
    const light = items.map(() => 1 + (random() - 0.5) * 0.24 * vary), warm = items.map(() => (random() - 0.5) * 0.1 * vary);
    const deal = items.map((_, i) => i + Math.floor(random() * 3)), colour = new THREE.Color();
    return info.parts.map((part, index) => {
      const geometry = new THREE.BufferGeometry();
      for (const name of Object.keys(part.geometry.attributes)) geometry.setAttribute(name, part.geometry.attributes[name]);
      geometry.setIndex(part.geometry.index);
      geometry.boundingBox = part.geometry.boundingBox; geometry.boundingSphere = part.geometry.boundingSphere;
      const shift = new Float32Array(count * 4), shiftRandom = rng((o.seed ?? baseSeed) * 104729 + hash(kind) + index * 17);
      for (let i = 0; i < count; i += 1) { const s = part.shift(variants[i], shiftRandom); shift[i * 4] = s[0]; shift[i * 4 + 1] = s[1]; shift[i * 4 + 2] = s[2]; shift[i * 4 + 3] = s[3] + 1; }
      geometry.setAttribute("propShift", new THREE.InstancedBufferAttribute(shift, 4));
      const mesh = kit.instances(geometry, part.material, items, hit && index === 0, shadow && part.cast);
      for (let i = 0; i < count; i += 1) {
        const item = items[i], palette = part.slot === 1 ? info.palette2 : info.palette;
        const chosen = part.slot === 1 ? item.tint2 ?? listed(o.tint2, i) : part.slot === 0 ? item.tint ?? listed(o.tint, i) : 0xffffff;
        colour.set(chosen ?? palette[(tied.has(kind) ? variants[i] : deal[i]) % palette.length]);
        if (part.slot >= 0 && vary > 0) { colour.r *= light[i] * (1 + warm[i]); colour.g *= light[i]; colour.b *= light[i] * (1 - warm[i]); }
        mesh.setColorAt(i, colour);
      }
      mesh.instanceColor!.needsUpdate = true;
      return mesh;
    });
  };

  const heap: Props["heap"] = (kinds, o) => {
    const list = Array.isArray(kinds) ? kinds : [kinds], random = rng((o.seed ?? baseSeed) * 15485863 + hash(list.join()));
    const infos = list.map(get), scale = o.scale ?? 1, jitter = o.jitter ?? 0.12, rim = o.rim ?? 0, yaw = o.yaw ?? 0, flare = o.flare ?? 0, wide = flare * rim;
    const round = !o.size, R = o.radius ?? 0.25, half = o.size ? [o.size[0] / 2, o.size[1] / 2] : [R, R];
    const placed: Array<{ x: number; y: number; z: number; r: number }> = [], items: Array<PropItem & { kind: PropKind }> = [];
    const restAt = (x: number, z: number, r: number) => {
      let y = r;
      for (const other of placed) {
        const reach = r + other.r, dx = x - other.x, dz = z - other.z, d2 = dx * dx + dz * dz;
        if (d2 < reach * reach) y = Math.max(y, other.y + Math.sqrt(reach * reach - d2));
      }
      return y;
    };
    /** Room left inside the footprint at a height: walls hold things up to the rim, above it the heap slopes in. */
    const inside = (x: number, z: number, y: number, r: number) => {
      const lean = rim > 0 ? Math.max(0, y - r * 0.4 - rim) * 1.15 : Math.max(0, y - r) * 0.9, margin = (rim > 0 ? r * 0.92 : r * 0.3) + lean;
      const grow = flare * Math.min(Math.max(y - r * 0.5, 0), rim) - margin;
      return round ? Math.hypot(x, z) <= R + grow : Math.abs(x) <= half[0] + grow && Math.abs(z) <= half[1] + grow;
    };
    const euler = new THREE.Euler(), turn = new THREE.Matrix4(), lift = new THREE.Vector3(), cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let i = 0; i < o.count; i += 1) {
      const pick = Math.floor(random() * infos.length), info = infos[pick], s = scale * (1 + (random() - 0.5) * 2 * jitter), r = info.radius * s;
      let best: { x: number; y: number; z: number } | null = null;
      for (let attempt = 0; attempt < 18; attempt += 1) {
        const angle = random() * TAU, reach = Math.sqrt(random());
        let x = round ? Math.cos(angle) * reach * (R + wide) : (random() * 2 - 1) * (half[0] + wide), z = round ? Math.sin(angle) * reach * (R + wide) : (random() * 2 - 1) * (half[1] + wide), y = restAt(x, z, r);
        if (!inside(x, z, y, r)) continue;
        // Roll downhill a little: a thing dropped on a heap ends in a hollow, not on a crown.
        for (let step = 0; step < 6; step += 1) {
          let moved = false;
          for (let k = 0; k < 6; k += 1) {
            const a = (k / 6) * TAU + step, nx = x + Math.cos(a) * r * 0.45, nz = z + Math.sin(a) * r * 0.45, ny = restAt(nx, nz, r);
            if (ny < y - 1e-4 && inside(nx, nz, ny, r)) { x = nx; z = nz; y = ny; moved = true; }
          }
          if (!moved) break;
        }
        if (!best || y < best.y) best = { x, y, z };
      }
      if (!best) continue;
      placed.push({ ...best, r });
      // Round things lie any way up; long ones lie flat; stalked ones mostly keep their stalk up.
      if (info.rest === "any") euler.set(random() * TAU, random() * TAU, random() * TAU);
      else if (info.rest === "flat") euler.set((random() - 0.5) * 0.5, random() * TAU, (random() - 0.5) * 0.5, "YXZ");
      else euler.set((random() - 0.5) * 1.5, random() * TAU, (random() - 0.5) * 1.5, "YXZ");
      turn.makeRotationFromEuler(euler);
      if (info.rest === "flat") lift.set(0, -r, 0); else lift.set(0, (-info.size[1] / 2) * s, 0).applyMatrix4(turn);
      const lx = best.x + lift.x, ly = best.y + lift.y, lz = best.z + lift.z;
      euler.setFromRotationMatrix(new THREE.Matrix4().makeRotationY(yaw).multiply(turn), "XYZ");
      items.push({ kind: info.kind, position: [o.at[0] + lx * cy + lz * sy, o.at[1] + ly, o.at[2] - lx * sy + lz * cy], rotation: [euler.x, euler.y, euler.z], scale: [s, s, s] });
    }
    const meshes: THREE.InstancedMesh[] = [];
    if (o.place !== false) for (const info of infos) meshes.push(...place(info.kind, items.filter((item) => item.kind === info.kind), { seed: o.seed, tint: o.tint, tint2: o.tint2, variant: o.variant, vary: o.vary, shadow: o.shadow, hit: o.hit }));
    return { items, meshes };
  };

  const fill: Props["fill"] = (container, where, kinds, o) => {
    const room = get(container).inside;
    if (!room) throw new Error(`props: "${container}" has no inside to fill`);
    const meshes = place(container, where, o.container), items: Array<PropItem & { kind: PropKind }> = [], seed = o.seed ?? baseSeed;
    where.forEach((spot, index) => {
      const s = spot.scale?.[0] ?? 1, at: [number, number, number] = [spot.position[0], spot.position[1] + room.floor * (spot.scale?.[1] ?? 1), spot.position[2]];
      const footprint = room.size ? { size: [room.size[0] * s, room.size[1] * s] as [number, number] } : { radius: (room.radius ?? 0.2) * s };
      items.push(...heap(kinds, { at, ...footprint, yaw: spot.rotation?.[1] ?? 0, rim: room.rim * s, flare: room.flare, count: o.count, scale: (o.scale ?? 1) * s, ...(o.jitter === undefined ? {} : { jitter: o.jitter }), seed: seed + index * 131, place: false }).items);
    });
    for (const kind of new Set(items.map((item) => item.kind))) meshes.push(...place(kind, items.filter((item) => item.kind === kind), { seed, tint: o.tint, tint2: o.tint2, variant: o.variant, vary: o.vary, shadow: o.shadow, hit: o.hit }));
    return { items, meshes };
  };

  return { get, place, heap, fill, kinds: Object.keys(drafts) as PropKind[] };
}

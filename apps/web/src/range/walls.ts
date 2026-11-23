import * as THREE from "three";
import { registerRelief } from "./relief";
import { textureLimit } from "./touch";
import { WALL_FRAGMENT, WALL_VERTEX } from "./walls.glsl";

/**
 * The wall bakery. Every wall finish a range needs — brickwork in its bonds, block, dressed and
 * rough stone, render, cast concrete — is drawn once on the graphics card into a tileable set
 * (colour, normal, and occlusion/roughness with the height in alpha) when the range is built.
 * Nothing is downloaded, a set is a quarter to the same memory as a photographed one, and no two
 * ranges need share a wall.
 *
 * A set comes back in the shape of `kit.photoSet`, so it spreads into a material the same way.
 */
export type WallSet = { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture; aoMap: THREE.Texture };

type Style = {
  kind: 0 | 1 | 2 | 3;
  /** Metres one tile covers, and the depth of its relief. */
  span: number; depth: number;
  /** Normal strength over the true slope. */
  bump: number; seed: number; size: number;
  p: number[][]; c: number[];
};

const BOND = { running: 0, third: 1, stack: 2, flemish: 3, english: 4, random: 5, common: 6 } as const;
const FACE = { brick: 0, rock: 1, glazed: 2, block: 3, tooled: 4, travertine: 5 } as const;

type Overlay = {
  /** Paint over everything: share covered, its roughness, how far it hides what is under, and how far it flakes unit by unit. */
  paint?: { colour: number; cover: number; rough?: number; hide?: number; byUnit?: number };
  soot?: number; bloom?: number; moss?: number; mossColour?: number;
  bump?: number; seed?: number; size?: number;
};
const overlay = (o: Overlay) => [[o.paint ? o.paint.cover : 0, o.paint?.rough ?? 0.7, o.paint?.hide ?? 0.96, o.paint?.byUnit ?? 0.4], [o.soot ?? 0, o.bloom ?? 0, o.moss ?? 0, 0]];
const paintIn = (o: Overlay) => (o.paint ? (o.paint.cover > 0 ? o.paint.colour : 0) : 0);

type Masonry = Overlay & {
  span: number; cols: number; rows: number; bond?: keyof typeof BOND; face?: keyof typeof FACE;
  /** Tones: two bodies, the overburnt or odd one, and the mortar. */
  colours: [number, number, number, number];
  /** Millimetres. */
  joint?: number; bevel?: number; wobble?: number; depth?: number;
  /** Mortar level against the face, 0 raked right out to 1 flush. */
  level?: number;
  jitter?: [number, number];
  relief?: number; chips?: number; hvar?: number; tilt?: number; cvar?: number; grime?: number; dark?: number; flash?: number; ragged?: number; gloss?: number;
  /** Share of the units with a pale crust of salts or kiln scum. */
  crust?: number;
};
const masonry = (o: Masonry): Style => ({
  kind: 0, span: o.span, depth: (o.depth ?? 12) / 1000, bump: o.bump ?? 1.25, seed: o.seed ?? 1, size: o.size ?? 2048,
  p: [
    [o.cols, o.rows, BOND[o.bond ?? "running"], o.jitter?.[0] ?? 0.06],
    [(o.joint ?? 10) / 1000, o.level ?? 0.45, (o.bevel ?? 1.6) / 1000, (o.wobble ?? 2) / 1000],
    [FACE[o.face ?? "brick"], o.relief ?? 0.13, o.chips ?? 0.6, o.jitter?.[1] ?? 0.05],
    [o.hvar ?? 0.14, o.tilt ?? 0.12, o.cvar ?? 0.28, o.grime ?? 0.5],
    [o.dark ?? 0.1, o.flash ?? 0.3, o.ragged ?? 0.5, o.gloss ?? 1],
    [o.crust ?? 0.1, 0, 0, 0], [0, 0, 0, 0], ...overlay(o),
  ],
  c: [...o.colours, 0, 0, paintIn(o), o.mossColour ?? 0x3d4a2a],
});

type Rubble = Overlay & {
  span: number; cells: [number, number]; colours: [number, number, number, number];
  gap?: number; bevel?: number; depth?: number;
  jitter?: number; dome?: number; relief?: number; level?: number; cvar?: number; hvar?: number; ragged?: number; grime?: number; dark?: number; bedding?: number;
};
const rubble = (o: Rubble): Style => ({
  kind: 1, span: o.span, depth: (o.depth ?? 35) / 1000, bump: o.bump ?? 1, seed: o.seed ?? 1, size: o.size ?? 2048,
  p: [
    [o.cells[0], o.cells[1], o.jitter ?? 0.9, (o.gap ?? 16) / 1000],
    [o.dome ?? 0.25, o.relief ?? 0.12, o.level ?? 0.35, o.cvar ?? 0.22],
    [(o.bevel ?? 8) / 1000, o.hvar ?? 0.3, o.ragged ?? 1, o.grime ?? 0.5],
    [o.dark ?? 0.15, o.bedding ?? 0.6, 0, 0],
    [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], ...overlay(o),
  ],
  c: [...o.colours, 0, 0, paintIn(o), o.mossColour ?? 0x3d4a2a],
});

type Plaster = Overlay & {
  span: number;
  /** Two tones of the render, and what its stains multiply by. */
  colours: [number, number]; stain?: number;
  depth?: number; rough?: number;
  trowel?: number; grain?: number; pebble?: number; strata?: number; swell?: number;
  crack?: number; crackCells?: number;
  streaks?: number; stains?: number; speckle?: number;
  /** Render fallen away to the wall behind: share lost, and that wall. */
  lost?: { share: number; cols: number; rows: number; face?: keyof typeof FACE; colours: [number, number, number, number] };
};
const plaster = (o: Plaster): Style => ({
  kind: 2, span: o.span, depth: (o.depth ?? (o.lost ? 16 : 4)) / 1000, bump: o.bump ?? 1.6, seed: o.seed ?? 1, size: o.size ?? 1024,
  p: [
    [o.trowel ?? 0.5, o.grain ?? 0.6, o.crack ?? 0.3, o.pebble ?? 0],
    [o.lost ? o.lost.share : 0, o.lost?.cols ?? 10, o.lost?.rows ?? 30, FACE[o.lost?.face ?? "brick"]],
    [o.streaks ?? 0.25, o.stains ?? 0.2, o.speckle ?? 0.1, o.strata ?? 0],
    [o.rough ?? 0.9, 0, o.crackCells ?? 5, o.swell ?? 1],
    [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], ...overlay({ ...o, paint: undefined }),
  ],
  c: [o.colours[0], o.colours[1], o.lost?.colours[0] ?? 0, o.lost?.colours[3] ?? 0x8f8676, o.stain ?? 0xa59f93, o.lost?.colours[1] ?? 0, o.lost?.colours[2] ?? 0, o.mossColour ?? 0x3d4a2a],
});

type Concrete = Overlay & {
  span: number;
  /** Two tones of the concrete, what its stains and its tie rust multiply by, and two stones of the aggregate. */
  colours: [number, number]; stain?: number; rust?: number; stones?: [number, number];
  depth?: number; rough?: number;
  boards?: number; upright?: boolean; step?: number; grain?: number;
  ties?: [number, number]; tieRadius?: number; tieDepth?: number;
  blowholes?: number; blowholeSize?: number; lifts?: number; aggregate?: number;
  streaks?: number; tieRust?: number; stains?: number;
  panels?: [number, number]; joint?: number; jointDepth?: number;
};
const concrete = (o: Concrete): Style => ({
  kind: 3, span: o.span, depth: (o.depth ?? 5) / 1000, bump: o.bump ?? 1.5, seed: o.seed ?? 1, size: o.size ?? 1024,
  p: [
    [o.boards ?? 0, o.upright ? 1 : 0, o.step ?? 0.16, o.grain ?? 0.8],
    [o.ties?.[0] ?? 0, o.ties?.[1] ?? 0, (o.tieRadius ?? 16) / 1000, o.tieDepth ?? 0.5],
    [o.blowholes ?? 0.25, o.blowholeSize ?? 0.3, o.lifts ?? 0, o.aggregate ?? 0],
    [o.streaks ?? 0.35, o.tieRust ?? 0.5, o.stains ?? 0.3, o.rough ?? 0.88],
    [o.panels?.[0] ?? 0, o.panels?.[1] ?? 0, (o.joint ?? 12) / 1000, o.jointDepth ?? 0.6],
    [0, 0, 0, 0], [0, 0, 0, 0], ...overlay(o),
  ],
  c: [o.colours[0], o.colours[1], o.stain ?? 0x9a968c, o.rust ?? 0xb08a64, o.stones?.[0] ?? 0x9a8f7c, o.stones?.[1] ?? 0x5f5a55, paintIn(o), o.mossColour ?? 0x3d4a2a],
});

/**
 * The catalogue. A brick course is 75 mm and a stretcher 225 mm wherever the span allows, so walls
 * are the size walls are; a map says how many metres its texture coordinates run to and the set is
 * scaled to suit.
 */
export const WALLS = {
  // -- Brickwork --
  /** Soft red stock in stretcher bond, a few overburnt: the plain workshop wall. */
  redStock: masonry({ span: 2.25, cols: 10, rows: 30, colours: [0x6e4537, 0x805140, 0x45342f, 0x7d7566], dark: 0.08, flash: 0.3 }),
  /** Yellow London stock in Flemish bond under a century of smoke. */
  yellowStock: masonry({ span: 2.7, cols: 8, rows: 36, bond: "flemish", colours: [0xae9866, 0xa08454, 0x4d423a, 0x716a60], dark: 0.14, flash: 0.35, grime: 0.42, soot: 0.25, level: 0.5, seed: 2 }),
  /** Blue engineering brick in English bond: hard, tight and faintly glossy. */
  blueEngineering: masonry({ span: 2.25, cols: 10, rows: 30, bond: "english", colours: [0x3b4350, 0x4b4a56, 0x25272e, 0x8f8c84], crust: 0, joint: 8, level: 0.6, bevel: 1.5, wobble: 0.8, relief: 0.035, chips: 0.15, hvar: 0.05, tilt: 0.05, cvar: 0.1, grime: 0.3, flash: 0, ragged: 0.2, gloss: 0.55, depth: 8, seed: 3 }),
  /** Old red brick under flaking whitewash. */
  whitewashed: masonry({ span: 2.25, cols: 10, rows: 30, colours: [0x8a4936, 0x9c583c, 0x3c2b28, 0x8f8674], level: 0.55, paint: { colour: 0xbdb7a8, cover: 0.8, rough: 0.74, byUnit: 0.22 }, grime: 0.35, flash: 0.15, crust: 0.03, seed: 4 }),
  /** Thin handmade brick, rose to ochre, in fat lime joints smeared nearly flush. */
  venetianRose: masonry({ span: 2.25, cols: 9, rows: 36, colours: [0x9a5843, 0xa87856, 0x5e392f, 0xafa58f], crust: 0.2, joint: 14, level: 0.72, bevel: 4, wobble: 4, chips: 0.8, hvar: 0.18, tilt: 0.16, cvar: 0.26, ragged: 0.9, bloom: 0.5, moss: 0.25, jitter: [0.16, 0.12], seed: 5 }),
  /** Purple-black clinker, fused and misshapen, standing proud of dark mortar. */
  clinker: masonry({ span: 2.25, cols: 10, rows: 30, bond: "third", colours: [0x3e2c2b, 0x55322c, 0x1a1617, 0x47423c], crust: 0.04, cvar: 0.2, level: 0.3, hvar: 0.3, tilt: 0.25, relief: 0.1, dark: 0.35, flash: 0.3, gloss: 0.8, wobble: 3, jitter: [0.12, 0.08], depth: 16, seed: 6 }),
  /** Mill brick in common bond — a header course every sixth — black with soot. */
  foundryCommon: masonry({ span: 2.25, cols: 10, rows: 30, bond: "common", colours: [0x7a4232, 0x924c34, 0x261f1e, 0x6a6257], grime: 0.55, soot: 0.35, dark: 0.12, flash: 0.45, level: 0.35, seed: 7 }),
  /** Warm handmade Tuscan brick in wide pale joints. */
  tuscan: masonry({ span: 2.25, cols: 10, rows: 30, colours: [0xa3664a, 0xb27850, 0x6e422f, 0xb9ad94], crust: 0.14, joint: 14, level: 0.75, bevel: 3.5, wobble: 3.5, ragged: 0.8, cvar: 0.25, chips: 0.7, jitter: [0.14, 0.1], seed: 8 }),
  /** Sun-dried mud brick laid in mud. */
  mudBrick: masonry({ span: 2.25, cols: 6, rows: 18, colours: [0x9a7e5a, 0xa88c64, 0x7e6244, 0x8e7758], crust: 0, joint: 18, level: 0.7, bevel: 8, wobble: 6, relief: 0.14, chips: 1, ragged: 1, hvar: 0.2, cvar: 0.15, grime: 0.4, flash: 0.1, jitter: [0.2, 0.16], depth: 14, seed: 9 }),
  /** Bottle-green glazed tile, brick-laid. */
  glazedGreen: masonry({ span: 2.25, cols: 15, rows: 30, face: "glazed", colours: [0x2f5d50, 0x356a5a, 0x24463d, 0x9a968c], crust: 0, joint: 3, level: 0.55, bevel: 2, wobble: 0, chips: 0.05, hvar: 0.05, tilt: 0.12, cvar: 0.08, grime: 0.3, flash: 0, dark: 0.06, ragged: 0, depth: 3, bump: 1.6, jitter: [0, 0], seed: 10 }),
  /** White square glazed tile, straight-laid in dark grout. */
  glazedWhite: masonry({ span: 2.25, cols: 15, rows: 15, bond: "stack", face: "glazed", colours: [0xb4b2aa, 0xbdbbb3, 0xa3a096, 0x5d5c58], crust: 0, joint: 3, level: 0.5, bevel: 2, wobble: 0, chips: 0.05, hvar: 0.05, tilt: 0.12, cvar: 0.05, grime: 0.4, flash: 0, dark: 0.08, ragged: 0, depth: 3, bump: 1.6, jitter: [0, 0], seed: 11 }),
  /** Cream glazed brick in English bond: the lining of a works or a station. */
  glazedCream: masonry({ span: 2.25, cols: 10, rows: 30, bond: "english", face: "glazed", colours: [0xb5a986, 0xbfb492, 0x7c5236, 0x7b7466], crust: 0, joint: 6, level: 0.5, bevel: 2.5, wobble: 0.5, chips: 0.2, hvar: 0.06, tilt: 0.1, cvar: 0.08, grime: 0.5, flash: 0, dark: 0.04, ragged: 0.1, depth: 5, bump: 1.4, seed: 12 }),
  /** Small dark Dutch brick, pointed in pale lime. */
  dutch: masonry({ span: 2.25, cols: 10, rows: 36, colours: [0x643a32, 0x754438, 0x33272a, 0x9c968a], joint: 9, level: 0.6, flash: 0.2, crust: 0.06, dark: 0.14, cvar: 0.24, seed: 20 }),
  /** Thin buff brick of the desert towns, laid nearly flush in its own clay. */
  buffBrick: masonry({ span: 2.2, cols: 10, rows: 40, colours: [0x9f8a66, 0xad9872, 0x7c6748, 0x9a8c72], joint: 8, level: 0.8, bevel: 2.5, wobble: 3, ragged: 0.8, crust: 0.05, flash: 0.1, dark: 0.12, cvar: 0.22, grime: 0.4, jitter: [0.14, 0.1], seed: 21 }),
  // -- Block and dressed stone --
  /** Bare concrete block. */
  block: masonry({ span: 2, cols: 5, rows: 10, face: "block", colours: [0x8e8c86, 0x9a9891, 0x77756f, 0x7f7c75], crust: 0, level: 0.5, bevel: 2, wobble: 0.5, relief: 0.12, chips: 0.3, hvar: 0.06, tilt: 0.05, cvar: 0.1, grime: 0.4, flash: 0, ragged: 0.2, depth: 8, jitter: [0.01, 0.01], seed: 13 }),
  /** Block under thick paint, chipped back to grey at the knocks. */
  blockPainted: masonry({ span: 2, cols: 5, rows: 10, face: "block", colours: [0x8e8c86, 0x9a9891, 0x77756f, 0x7f7c75], crust: 0, level: 0.6, bevel: 2, wobble: 0.5, relief: 0.1, chips: 0.3, hvar: 0.06, tilt: 0.05, cvar: 0.1, grime: 0.35, flash: 0, ragged: 0.2, depth: 7, jitter: [0.01, 0.01], paint: { colour: 0xa9a598, cover: 0.9, rough: 0.6, byUnit: 0.2 }, seed: 14 }),
  /** Fine limestone ashlar, tooled, in courses of uneven height. */
  ashlar: masonry({ span: 2.4, cols: 4, rows: 8, bond: "random", face: "tooled", colours: [0xb0a68c, 0xbcb39a, 0x968a6e, 0x9d937c], crust: 0.06, joint: 5, level: 0.55, bevel: 3, wobble: 0.6, relief: 0.07, chips: 0.35, hvar: 0.08, tilt: 0.05, cvar: 0.12, grime: 0.4, flash: 0.08, ragged: 0.3, depth: 8, jitter: [0.5, 0.3], seed: 15 }),
  /** Rock-faced rustication: big bossed blocks in deep channels. */
  rusticated: masonry({ span: 2.4, cols: 3, rows: 6, face: "rock", colours: [0xa0977f, 0xaea48c, 0x857b67, 0x665f53], crust: 0.05, joint: 24, level: 0.1, bevel: 16, wobble: 1, relief: 0.2, chips: 0.5, hvar: 0.15, tilt: 0.1, cvar: 0.12, grime: 0.55, flash: 0, ragged: 0.4, depth: 45, jitter: [0.04, 0.02], seed: 16 }),
  /** Honey sandstone in split-faced courses. */
  sandstone: masonry({ span: 2.4, cols: 5, rows: 10, bond: "random", face: "rock", colours: [0xa18661, 0xae946e, 0x8a6a44, 0x857861], crust: 0.05, joint: 9, level: 0.4, bevel: 5, wobble: 2.5, relief: 0.2, soot: 0.25, chips: 0.7, hvar: 0.2, tilt: 0.14, cvar: 0.16, grime: 0.6, flash: 0.1, ragged: 0.7, depth: 22, jitter: [0.45, 0.35], seed: 17 }),
  /** Honed travertine slabs. */
  travertine: masonry({ span: 2.4, cols: 2, rows: 4, face: "travertine", colours: [0xbdb198, 0xc6bca4, 0xaa9c80, 0x9c917a], crust: 0, joint: 3, level: 0.5, bevel: 1.5, wobble: 0, relief: 0.12, chips: 0.1, hvar: 0.03, tilt: 0.02, cvar: 0.1, grime: 0.3, flash: 0, dark: 0.2, ragged: 0, gloss: 0.9, depth: 5, bump: 1.4, jitter: [0, 0], size: 1024, seed: 18 }),
  /** Grey granite setts as a wall: small squared blocks, rough-split. */
  granite: masonry({ span: 2.4, cols: 8, rows: 12, bond: "random", face: "rock", colours: [0x77787a, 0x8a8a88, 0x55575b, 0x6a665e], crust: 0.03, joint: 10, level: 0.3, bevel: 6, wobble: 2, relief: 0.09, chips: 0.5, hvar: 0.22, tilt: 0.16, cvar: 0.14, grime: 0.5, flash: 0, ragged: 0.6, depth: 18, jitter: [0.3, 0.15], seed: 19 }),
  /** Old ashlar of a ruin: big tooled blocks, chipped, stained and mossed in the joints. To be tinted. */
  weatheredAshlar: masonry({ span: 2.4, cols: 3, rows: 6, bond: "random", face: "tooled", colours: [0x8d846e, 0x9a917a, 0x736a56, 0x6f6756], joint: 8, level: 0.3, bevel: 6, wobble: 2, relief: 0.14, chips: 1, hvar: 0.14, tilt: 0.1, cvar: 0.16, grime: 0.7, flash: 0.05, crust: 0.04, ragged: 0.8, depth: 16, jitter: [0.45, 0.3], moss: 0.5, soot: 0.3, seed: 22 }),
  // -- Rough stone --
  /** Fieldstone rubble bedded in lime. */
  fieldstone: rubble({ span: 2.4, cells: [8, 12], colours: [0x857d6f, 0x9a917f, 0x5c5750, 0x9a907c], bedding: 0.25, hvar: 0.35, relief: 0.16 }),
  /** Dry-stone: flat slabs stacked without mortar, dark between. */
  dryStone: rubble({ span: 2.4, cells: [6, 15], colours: [0x6f6c68, 0x86827a, 0x4f4b47, 0x24211e], gap: 9, level: 0, dome: 0.12, depth: 50, bedding: 0.4, grime: 0.6, relief: 0.14, seed: 2 }),
  /** Water-rounded cobbles set in a wall. */
  cobbleWall: rubble({ span: 2.4, cells: [10, 10], colours: [0x8a8780, 0x9d968a, 0x6d6a66, 0x8f8672], dome: 0.6, bevel: 14, level: 0.3, relief: 0.05, bedding: 0.2, depth: 30, ragged: 0.3, seed: 3 }),
  /** Warm desert rubble, sand-blown and sun-bleached. */
  desertRubble: rubble({ span: 2.4, cells: [6, 9], colours: [0xb89a6c, 0xc9ae80, 0x8e7048, 0xb7a078], level: 0.55, dome: 0.2, gap: 22, depth: 28, grime: 0.3, seed: 4 }),
  // -- Render --
  /** Limewashed render, to be tinted: soft trowel work, hairline cracks, rain marks. */
  limewash: plaster({ span: 3, colours: [0xb3aba7, 0xa39b98] }),
  /** Smooth painted wall, to be tinted: the roller's stipple and nothing else. */
  painted: plaster({ span: 2.4, colours: [0xb0a8a4, 0xa8a09d], trowel: 0.07, grain: 1, crack: 0, streaks: 0.04, stains: 0.08, speckle: 0.04, rough: 0.78, swell: 0.3, depth: 1.5, bump: 2.2, seed: 2 }),
  /** Harbour paint over render: chalked by salt, streaked by rain, hairline cracks. */
  quayPaint: plaster({ span: 2.6, colours: [0xb1a9a5, 0xa39b98], stain: 0x8f8a80, trowel: 0.16, grain: 0.85, crack: 0.3, crackCells: 4, streaks: 0.5, stains: 0.3, speckle: 0.1, rough: 0.86, swell: 0.4, depth: 2, bump: 2, bloom: 0.3, seed: 27 }),
  /** Marmorino: polished plaster gone soft and stained by canal air. To be tinted. */
  marmorino: plaster({ span: 3, colours: [0xb7ada6, 0x9f9690], stain: 0x8e877b, trowel: 0.28, grain: 0.3, crack: 0.5, crackCells: 4, streaks: 0.6, stains: 0.5, speckle: 0.06, rough: 0.72, moss: 0.3, seed: 3 }),
  /** Roughcast: pebble thrown at wet render and washed over. To be tinted. */
  roughcast: plaster({ span: 2.4, colours: [0xb2aaa5, 0xa29a96], trowel: 0.2, grain: 0.8, pebble: 1, crack: 0.15, streaks: 0.35, stains: 0.25, rough: 0.95, depth: 7, bump: 1.3, seed: 4 }),
  /** Old stucco, to be tinted: heavy trowel work, cracked, the brick showing where it has fallen. */
  stucco: plaster({ span: 2.25, colours: [0xb5ada8, 0xa29a96], trowel: 0.75, grain: 0.7, crack: 0.6, crackCells: 6, streaks: 0.4, stains: 0.35, lost: { share: 0.24, cols: 10, rows: 30, colours: [0x7a4a3a, 0x8a5642, 0x3c2c29, 0x8d8474] }, size: 2048, seed: 5 }),
  /** Ochre stucco off a sunlit street, patched and peeling to the brick. */
  ochreStucco: plaster({ span: 2.25, colours: [0xb3966a, 0xa3845a], stain: 0x9c9382, trowel: 0.7, grain: 0.7, crack: 0.55, crackCells: 6, streaks: 0.45, stains: 0.4, lost: { share: 0.3, cols: 10, rows: 30, colours: [0x80503c, 0x925e44, 0x3e2e2a, 0xa69b84] }, size: 2048, seed: 6 }),
  /** Mud render with straw in it, crazed by the sun. */
  adobe: plaster({ span: 2.4, colours: [0xa58b66, 0x977d5a], stain: 0x9d927f, trowel: 0.9, grain: 0.9, pebble: 0.12, crack: 0.55, crackCells: 9, streaks: 0.3, stains: 0.3, speckle: 0.5, rough: 0.96, depth: 7, seed: 7 }),
  /** Rammed earth: lift on lift, each a different day's mix. */
  rammedEarth: plaster({ span: 2.4, colours: [0xa08260, 0x8e7252], stain: 0x9d927f, trowel: 0.2, grain: 0.9, strata: 1, crack: 0.3, crackCells: 4, streaks: 0.3, stains: 0.2, speckle: 0.4, rough: 0.96, depth: 8, seed: 8 }),
  /** Thick daub, to be tinted: laid on by hand and never ruled flat. */
  daub: plaster({ span: 2.4, colours: [0xb1a9a4, 0xa39b97], trowel: 1, grain: 0.8, crack: 0.25, streaks: 0.3, stains: 0.3, swell: 2.2, depth: 9, bump: 1.3, seed: 9 }),
  /** Mud render under a pale wash, to be tinted: straw, grit and sun cracks. */
  adobeWash: plaster({ span: 2.4, colours: [0xb0a8a2, 0xa29a94], trowel: 0.9, grain: 0.9, pebble: 0.12, crack: 0.55, crackCells: 9, streaks: 0.3, stains: 0.3, speckle: 0.5, rough: 0.96, depth: 7, seed: 10 }),
  /** Skim-coated interior plaster, to be tinted: flat, with the odd settlement crack. */
  skim: plaster({ span: 3, colours: [0xb2aaa6, 0xaaa29e], trowel: 0.14, grain: 0.35, crack: 0.42, crackCells: 3, streaks: 0.08, stains: 0.14, speckle: 0.03, rough: 0.7, swell: 0.5, depth: 2, bump: 2, seed: 11 }),
  /** Distemper on old plaster, to be tinted: damp-stained and run with years of leaks. */
  distemper: plaster({ span: 2.4, colours: [0xb4aca8, 0x9d9591], stain: 0x8a8378, trowel: 0.4, grain: 0.7, crack: 0.5, crackCells: 7, streaks: 0.7, stains: 0.6, speckle: 0.15, rough: 0.92, seed: 12 }),
  /** Polished plaster, to be tinted: burnished nearly to a shine. */
  lustro: plaster({ span: 3, colours: [0xb3aba6, 0xa69e99], trowel: 0.2, grain: 0.15, crack: 0.2, crackCells: 3, streaks: 0.05, stains: 0.25, speckle: 0.02, rough: 0.5, swell: 0.6, depth: 1.5, bump: 2, seed: 13 }),
  /** Lime render of a southern street, to be tinted: trowelled, cracked, streaked under every sill. */
  intonaco: plaster({ span: 3, colours: [0xb5ada8, 0xa39b96], trowel: 0.6, grain: 0.7, crack: 0.45, crackCells: 5, streaks: 0.55, stains: 0.4, seed: 14 }),
  // -- Concrete --
  /** Board-marked concrete, to be tinted: the grain of every board, tie holes and their runs. */
  boardMarked: concrete({ span: 3, colours: [0x8a867b, 0x79756a], boards: 20, ties: [2, 2] }),
  /** The same poured against upright boards. */
  boardMarkedUpright: concrete({ span: 3, colours: [0x88847a, 0x77736a], boards: 24, upright: true, ties: [2, 3], streaks: 0.5, seed: 2 }),
  /** Precast panels with open joints. To be tinted. */
  precast: concrete({ span: 3, colours: [0x8b877c, 0x7f7b70], panels: [2, 2], ties: [4, 4], tieRadius: 22, tieDepth: 0.35, blowholes: 0.12, streaks: 0.45, tieRust: 0.35, seed: 3 }),
  /** Plain cast concrete in lifts, pocked where the air stayed. To be tinted. */
  cast: concrete({ span: 3, colours: [0x87837a, 0x78746b], lifts: 5, blowholes: 0.5, blowholeSize: 0.6, streaks: 0.5, stains: 0.4, seed: 4 }),
  /** Exposed aggregate: the cement brushed off the stones. */
  aggregate: concrete({ span: 2, colours: [0x7f7868, 0x716a5c], aggregate: 0.9, blowholes: 0, streaks: 0.3, stains: 0.25, rough: 0.92, depth: 6, seed: 5 }),
  /** Fair-faced concrete, to be tinted: a grid of ties on smooth ply-formed panels. */
  fairFaced: concrete({ span: 2.4, colours: [0x8e8a80, 0x838076], panels: [2, 1], joint: 5, jointDepth: 0.3, ties: [4, 2], tieRadius: 14, tieDepth: 0.45, blowholes: 0.3, blowholeSize: 0.15, streaks: 0.15, tieRust: 0.1, stains: 0.2, rough: 0.7, depth: 4, seed: 6 }),
  /** Ply-shuttered concrete, to be tinted: clean sheets, a tight grid of ties. */
  shuttered: concrete({ span: 2.4, colours: [0x8b8a86, 0x80807c], panels: [2, 2], joint: 4, jointDepth: 0.25, ties: [4, 4], tieRadius: 12, tieDepth: 0.4, blowholes: 0.2, blowholeSize: 0.1, streaks: 0.2, tieRust: 0.15, stains: 0.25, rough: 0.72, depth: 4, seed: 7 }),
  /** Cast concrete of a works, to be tinted: smoke-stained and run with rust. */
  castStained: concrete({ span: 3, colours: [0x7f7b72, 0x6f6b63], lifts: 4, blowholes: 0.4, blowholeSize: 0.5, streaks: 0.8, stains: 0.6, soot: 0.4, seed: 8 }),
} satisfies Record<string, Style>;

export type WallStyle = keyof typeof WALLS;

/** A bakery for one renderer. `high` is the full-quality profile; relief is recorded only for it. */
export function createWalls(renderer: THREE.WebGLRenderer, options: { high: boolean; anisotropy: number; track: <T extends { dispose: () => void }>(item: T) => T }) {
  let rig: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.RawShaderMaterial } | null = null;
  const prepare = () => {
    if (rig) return rig;
    const geometry = options.track(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const material = options.track(new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: WALL_VERTEX, fragmentShader: WALL_FRAGMENT, depthTest: false, depthWrite: false,
      uniforms: {
        uMode: { value: 0 }, uKind: { value: 0 }, uSeed: { value: 0 }, uSpan: { value: 1 }, uTexel: { value: 1 }, uDepth: { value: 0.01 }, uBump: { value: 1 },
        uP: { value: Array.from({ length: 9 }, () => new THREE.Vector4()) }, uC: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      },
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    rig = { scene, camera: new THREE.Camera(), material };
    return rig;
  };
  const colour = new THREE.Color();

  /**
   * A wall finish as a set. `metres` is how far the material's texture coordinates run per unit
   * (a geometry mapped at 2.8 m passes 2.8), so the wall comes out life-size; `metresY` if the two
   * ways differ.
   */
  return (name: WallStyle, metres?: number, metresY = metres): WallSet => {
    const style: Style = WALLS[name], { scene, camera, material } = prepare(), uniforms = material.uniforms;
    const size = Math.max(256, Math.min(options.high ? style.size : style.size / 2, textureLimit()));
    uniforms.uKind.value = style.kind; uniforms.uSeed.value = style.seed * 17.17; uniforms.uSpan.value = style.span;
    uniforms.uTexel.value = 1 / size; uniforms.uDepth.value = style.depth; uniforms.uBump.value = style.bump;
    style.p.forEach((row, index) => (uniforms.uP.value as THREE.Vector4[])[index].set(row[0], row[1], row[2], row[3]));
    style.c.forEach((hex, index) => { colour.setHex(hex); (uniforms.uC.value as THREE.Vector3[])[index].set(colour.r, colour.g, colour.b); });
    const previous = renderer.getRenderTarget(), xr = renderer.xr.enabled, shadows = renderer.shadowMap.needsUpdate;
    renderer.xr.enabled = false;
    const [map, normalMap, orm] = [true, false, false].map((srgb, mode) => {
      const target = options.track(new THREE.WebGLRenderTarget(size, size, {
        depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: options.anisotropy, colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      }));
      uniforms.uMode.value = mode;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      target.texture.repeat.set(metres === undefined ? 1 : metres / style.span, metresY === undefined ? 1 : metresY / style.span);
      target.texture.name = `wall-${name}-${["colour", "normal", "orm"][mode]}`;
      return target.texture;
    }) as [THREE.Texture, THREE.Texture, THREE.Texture];
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xr;
    renderer.shadowMap.needsUpdate = shadows;
    if (options.high && style.depth >= 0.0055) registerRelief(normalMap, orm, "a", style.depth);
    return { map, normalMap, roughnessMap: orm, aoMap: orm };
  };
}

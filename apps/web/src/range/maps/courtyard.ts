import * as THREE from "three";
import { paintedSteel, pbrMaterial } from "../pbr";
import {
  archedWall, canvasTexture, clothGeometry, crateGeometry, createKit, drumGeometry, softBox, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";

// Dust Court: a walled desert courtyard under a midday sun.
//
// Lighting model: one hard sun, matched to the sky's own sun, falls through
// cloth awnings strung between the walls, so the ground is striped with shade
// and the dusty air shows the shafts between them. Bounce comes from a probe of
// the sunlit court itself, which is what turns the shade warm.

/** Direction to the sun in `goegap-2k.hdr`. */
const TO_SUN = new THREE.Vector3(0.535, 0.725, 0.433).normalize();
const WALL_X = 9.94;
const WALL_TOP = 5.2;

type V3 = [number, number, number];

/** Woven stripes for the awnings, in sun-bleached brand colours. */
function stripeTexture(base: string, stripe: string, accent: string) {
  const texture = canvasTexture(256, 256, (context) => {
    context.fillStyle = base;
    context.fillRect(0, 0, 256, 256);
    const bands: Array<[number, number, string]> = [[18, 26, stripe], [58, 8, accent], [96, 44, stripe], [158, 8, accent], [188, 26, stripe], [232, 10, accent]];
    for (const [y, height, colour] of bands) { context.fillStyle = colour; context.fillRect(0, y, 256, height); }
    // Weave and sun-fade.
    let seed = 91;
    for (let i = 0; i < 5200; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const shade = (seed >> 24) & 1 ? 255 : 0;
      context.fillStyle = `rgba(${shade},${shade},${shade},.045)`;
      context.fillRect(seed & 255, (seed >> 8) & 255, 1 + ((seed >> 16) & 15), 1);
    }
  }, true);
  return texture;
}

/** Glazed tile frieze: repeating eight-point stars. */
function friezeTexture() {
  return canvasTexture(256, 128, (context) => {
    context.fillStyle = "#e9e0cc";
    context.fillRect(0, 0, 256, 128);
    for (let cell = 0; cell < 2; cell += 1) {
      const cx = 64 + cell * 128, cy = 64;
      context.fillStyle = "#1f6f6a";
      for (const turn of [0, Math.PI / 4]) {
        context.save(); context.translate(cx, cy); context.rotate(turn); context.fillRect(-36, -36, 72, 72); context.restore();
      }
      context.fillStyle = "#e9e0cc";
      context.beginPath(); context.arc(cx, cy, 24, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#d58a2e";
      context.save(); context.translate(cx, cy); context.rotate(Math.PI / 4); context.fillRect(-12, -12, 24, 24); context.restore();
      context.fillStyle = "#1f6f6a";
      context.beginPath(); context.arc(cx + 64, cy - 64, 15, 0, Math.PI * 2); context.arc(cx + 64, cy + 64, 15, 0, Math.PI * 2); context.fill();
    }
    context.fillStyle = "#17524f";
    context.fillRect(0, 0, 256, 9); context.fillRect(0, 119, 256, 9);
    context.strokeStyle = "rgba(60,48,30,.35)";
    context.lineWidth = 2;
    for (let x = 0; x <= 256; x += 64) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 128); context.stroke(); }
  }, true);
}

/** One palm frond with a clear background: a rib and its leaflets. */
function frondTexture() {
  const texture = canvasTexture(256, 512, (context) => {
    context.clearRect(0, 0, 256, 512);
    context.lineCap = "round";
    for (let i = 0; i < 74; i += 1) {
      const t = i / 73, y = 500 - t * 480, reach = 112 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) * (1 - t * 0.35) + 10;
      for (const side of [-1, 1]) {
        const green = 96 + ((i * 37 + (side > 0 ? 11 : 0)) % 46);
        context.strokeStyle = `rgb(${Math.round(green * 0.62)},${green},${Math.round(green * 0.34)})`;
        context.lineWidth = 5.2 - t * 2.4;
        context.beginPath();
        context.moveTo(128, y);
        context.quadraticCurveTo(128 + side * reach * 0.55, y - 16, 128 + side * reach, y - 44 - t * 22);
        context.stroke();
      }
    }
    context.strokeStyle = "#8b8a4c";
    context.lineWidth = 6;
    context.beginPath(); context.moveTo(128, 512); context.lineTo(128, 16); context.stroke();
  });
  texture.anisotropy = 8;
  return texture;
}

/** A frond lying along +z from the origin, arching up and then drooping. */
function frondGeometry(length: number, rise: number, droop: number) {
  const geometry = new THREE.PlaneGeometry(1.25, length, 4, 12);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, -length / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const t = -position.getZ(i) / length, x = position.getX(i);
    position.setY(i, rise * t - droop * t * t - Math.abs(x) * 0.34 * (0.4 + t));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Leaning trunk standing on y = 0; the crown sits at the returned top. */
function trunkGeometry(height: number, lean: number) {
  const geometry = new THREE.CylinderGeometry(0.15, 0.25, height, 10, 14);
  geometry.translate(0, height / 2, 0);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const t = position.getY(i) / height;
    position.setX(i, position.getX(i) + lean * t * t);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Storage jar turned on a wheel. */
function urnGeometry(scale: number) {
  const profile = [[0, 0], [0.16, 0], [0.2, 0.03], [0.3, 0.22], [0.34, 0.42], [0.31, 0.62], [0.2, 0.78], [0.15, 0.84], [0.17, 0.9], [0.2, 0.92], [0.17, 0.94], [0.13, 0.9], [0.12, 0.8]]
    .map(([x, y]) => new THREE.Vector2(x * scale, y * scale));
  return new THREE.LatheGeometry(profile, 24);
}

export function buildCourtyard(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  const metals = kit.metals();

  // ---- Materials -----------------------------------------------------------
  const sand = photoSet("/textures/sandstone_cracks-2k", 96 / 3.4, 104 / 3.4, false);
  const plaster = photoSet("/textures/painted_plaster_wall-1k", 1, 1, false);
  const plasterMaterial = (color: number, normal = 1) => new THREE.MeshStandardMaterial({ ...plaster, color, normalScale: new THREE.Vector2(normal, normal), roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  const wallPlaster = plasterMaterial(0xe2c59a);
  const capPlaster = plasterMaterial(0xf0dfc0, 0.7);
  const plinthPlaster = plasterMaterial(0xb48f63, 1.3);
  const townPlaster = [plasterMaterial(0xdcc09a), plasterMaterial(0xcfae84), plasterMaterial(0xe6d3b2)];
  const shade = new THREE.MeshStandardMaterial({ color: 0x120d09, roughness: 1, metalness: 0, envMapIntensity: 0.1 });
  const shutterPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.07, 0.3, 0.3], 411, 0.9, 512)), { metalness: 0, envMapIntensity: 0.4 });
  const drumPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.1, 0.33, 0.32], 311, 0.85, 512)), { envMapIntensity: 1 });
  const terracotta = new THREE.MeshStandardMaterial({ color: 0xb4633a, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.78, metalness: 0, envMapIntensity: 0.5 });
  const rope = new THREE.MeshStandardMaterial({ color: 0x8a744f, roughness: 1, metalness: 0 });
  const frieze = track(friezeTexture());
  frieze.anisotropy = anisotropy;

  // ---- Ground --------------------------------------------------------------
  const ground = new THREE.MeshStandardMaterial({ ...sand, color: 0xb4b2ab, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 1, metalness: 0, envMapIntensity: 0.35 });
  // Dry ground: chalked range lines, no standing water, no mirror pass.
  const reflection = kit.floor(ground, { width: 96, depth: 104, z: -12 }, {
    lane: new THREE.Color(0.86, 0.8, 0.68),
    edge: new THREE.Color(0.86, 0.8, 0.68),
    markings: 0.5,
    wet: -1,
  }, false);

  // ---- Court walls ---------------------------------------------------------
  const sideRun = 29.7, sideZ = -14.55;
  const arcade = archedWall(10.1, WALL_TOP, 0.8, [{ x: -2.4, width: 3.2, spring: 1.9 }, { x: 2.4, width: 3.2, spring: 1.9 }], 3);
  arcade.rotateY(Math.PI / 2);
  for (const side of [-1, 1]) {
    const x = side * WALL_X;
    place(new THREE.Mesh(worldBox(0.8, WALL_TOP, sideRun, 3), wallPlaster), x, WALL_TOP / 2, sideZ, true, true);
    place(new THREE.Mesh(arcade, wallPlaster), x, 0, 5.35, true, true);
    place(new THREE.Mesh(softBox(1.04, 0.24, 39.9, 0.06, 3), capPlaster), x, WALL_TOP + 0.1, -9.5, true);
    place(new THREE.Mesh(softBox(0.14, 0.95, sideRun, 0.03, 2.2), plinthPlaster), side * 9.5, 0.475, sideZ, false, true);
    // Tile frieze under the coping.
    const band = frieze.clone();
    band.needsUpdate = true;
    band.repeat.set(27 / 1.3, 1);
    track(band);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.65, 27), new THREE.MeshStandardMaterial({ map: band, roughness: 0.32, metalness: 0, envMapIntensity: 0.9 })), side * 9.525, 4.45, -13.5, false);
  }
  const buttressZ = [-1.5, -7.5, -14.05, -19.95, -26.2];
  const buttress = softBox(0.5, 4.3, 0.6, 0.05, 3);
  instances(buttress, wallPlaster, buttressZ.flatMap((z) => [-1, 1].map((side) => ({ position: [side * 9.36, 2.15, z] as V3, rotation: [0, 0, side * 0.045] as V3 }))));
  instances(softBox(0.62, 0.16, 0.72, 0.04, 3), capPlaster, buttressZ.flatMap((z) => [-1, 1].map((side) => ({ position: [side * 9.28, 4.36, z] as V3 }))), false);
  // Gatehouse behind the firing line and the end wall behind the control centre.
  place(new THREE.Mesh(worldBox(20.7, 7.6, 0.8, 3), wallPlaster), 0, 3.8, 10.12, true, true);
  place(new THREE.Mesh(softBox(21, 0.26, 1.04, 0.06, 3), capPlaster), 0, 7.72, 10.12, true);
  place(new THREE.Mesh(worldBox(20.7, 6.2, 0.8, 3), wallPlaster), 0, 3.1, -29.8, true, true);
  place(new THREE.Mesh(softBox(21, 0.26, 1.04, 0.06, 3), capPlaster), 0, 6.32, -29.8, true);
  // Merlons along the end wall and gatehouse.
  instances(softBox(0.9, 0.6, 0.8, 0.05, 3), wallPlaster, [
    ...Array.from({ length: 10 }, (_, i) => ({ position: [-9 + i * 2, 6.74, -29.8] as V3 })),
    ...Array.from({ length: 10 }, (_, i) => ({ position: [-9 + i * 2, 8.14, 10.12] as V3 })),
  ], false);
  // Roof beams poke through the gatehouse and end wall, as on every building in town.
  const beamEnd = new THREE.CylinderGeometry(0.075, 0.075, 1.5, 8);
  beamEnd.rotateX(Math.PI / 2);
  instances(beamEnd, metals.crate, [
    ...Array.from({ length: 13 }, (_, i) => ({ position: [-9 + i * 1.5, 6.9, 9.9] as V3 })),
    ...Array.from({ length: 13 }, (_, i) => ({ position: [-9 + i * 1.5, 5.55, -29.6] as V3 })),
  ], false);

  // ---- Town beyond the walls -----------------------------------------------
  // [x, z, width, depth, height]
  const town: Array<[number, number, number, number, number]> = [
    [-19, 6, 10, 12, 8.5], [-21, -9, 12, 14, 11.5], [-18.5, -25, 9, 12, 7.8], [-27, -40, 16, 12, 13],
    [19.5, 8, 11, 12, 9.8], [20, -7, 10, 11, 7.2], [22, -22, 13, 13, 12.4], [27, -41, 14, 12, 9.5],
    [-8, -43, 14, 12, 10.5], [9, -45, 12, 12, 14.5], [0, 24, 22, 12, 11], [-24, 24, 16, 12, 9], [24, 25, 16, 12, 13],
    [-36, -12, 12, 30, 15], [37, -10, 12, 30, 16],
  ];
  const openings: Transform[] = [], shutters: Transform[] = [], lintels: Transform[] = [], vigas: Transform[] = [], parapets: Transform[] = [];
  town.forEach(([x, z, w, d, h], index) => {
    place(new THREE.Mesh(worldBox(w, h, d, 3.4), townPlaster[index % 3]), x, h / 2, z, true);
    parapets.push({ position: [x, h + 0.22, z], scale: [w + 0.3, 1, d + 0.3] });
    // Windows on the faces that look into the court.
    const faces: Array<{ along: "x" | "z"; at: number; normal: number; from: number; span: number }> = [];
    if (Math.abs(x) > 12) faces.push({ along: "z", at: x - Math.sign(x) * w / 2, normal: -Math.sign(x), from: z - d / 2, span: d });
    if (z < -32) faces.push({ along: "x", at: z + d / 2, normal: 1, from: x - w / 2, span: w });
    if (z > 14) faces.push({ along: "x", at: z - d / 2, normal: -1, from: x - w / 2, span: w });
    for (const face of faces) {
      const columns = Math.max(2, Math.floor(face.span / 3.1)), floors = Math.max(1, Math.floor((h - 2.2) / 3));
      for (let floor = 0; floor < floors; floor += 1) for (let column = 0; column < columns; column += 1) {
        if ((index * 7 + floor * 3 + column * 5) % 6 === 0) continue;
        const along = face.from + (column + 0.5) * (face.span / columns), y = 3.1 + floor * 3;
        const turn = face.along === "z" ? Math.PI / 2 : 0;
        const at = (offset: number, shift = 0): V3 => face.along === "z" ? [face.at + face.normal * offset, y, along + shift] : [along + shift, y, face.at + face.normal * offset];
        openings.push({ position: at(0.02), rotation: [0, turn, 0] });
        lintels.push({ position: [at(0.09)[0], y + 0.86, at(0.09)[2]], rotation: [0, turn, 0] });
        if ((index + floor + column) % 3 !== 0) shutters.push({ position: at(0.1, (column % 2 ? 1 : -1) * 0.84), rotation: [0, turn, 0] });
      }
      const rows = Math.floor(face.span / 1.1);
      for (let i = 0; i < rows; i += 1) {
        const along = face.from + (i + 0.5) * (face.span / rows);
        vigas.push({ position: face.along === "z" ? [face.at + face.normal * 0.3, h - 0.7, along] : [along, h - 0.7, face.at + face.normal * 0.3], rotation: [0, face.along === "z" ? Math.PI / 2 : 0, 0] });
      }
    }
  });
  instances(softBox(1, 0.5, 1, 0.08, 3.4), capPlaster, parapets, false);
  instances(new THREE.BoxGeometry(1, 1.5, 0.12), shade, openings, false, false);
  instances(softBox(1.3, 0.16, 0.2, 0.03, 1.2), metals.crate, lintels, false, false);
  instances(softBox(0.56, 1.5, 0.06, 0.015, 1.1), shutterPaint, shutters, false, false);
  const viga = new THREE.CylinderGeometry(0.09, 0.09, 0.9, 8);
  viga.rotateX(Math.PI / 2);
  instances(viga, metals.crate, vigas, false);
  // A dome and a slim tower close the far end of the court.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4.2, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), capPlaster);
  place(dome, 9, 15.6, -45, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(4.35, 4.35, 1.1, 40), townPlaster[0]), 9, 15.05, -45, true);
  place(new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.5, 10), metals.brushed), 9, 20.4, -45, false);
  place(new THREE.Mesh(worldBox(3, 21, 3, 3.4), townPlaster[2]), -8.5, 10.5, -39.2, true);
  place(new THREE.Mesh(softBox(3.7, 0.4, 3.7, 0.08, 3.4), capPlaster), -8.5, 17.4, -39.2, true);
  place(new THREE.Mesh(archedWall(3, 3.2, 3, [{ x: 0, width: 1.5, spring: 1.4, sill: 0.5 }], 3.4), townPlaster[2]), -8.5, 21, -39.2, true);
  place(new THREE.Mesh(new THREE.SphereGeometry(1.75, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), capPlaster), -8.5, 24.2, -39.2, true);

  // ---- Awnings -------------------------------------------------------------
  const cloths: Array<{ z: number; depth: number; sag: number; map: THREE.Texture }> = [
    { z: 3.4, depth: 3.4, sag: 1.0, map: track(stripeTexture("#e8dcc3", "#2f8f88", "#d79a45")) },
    { z: -5.6, depth: 2.6, sag: 0.8, map: track(stripeTexture("#d8a25a", "#efe4cc", "#8a4a22")) },
    { z: -12.6, depth: 3.6, sag: 1.15, map: track(stripeTexture("#efe6d2", "#c9772d", "#2f8f88")) },
    { z: -20.2, depth: 2.8, sag: 0.9, map: track(stripeTexture("#2f8f88", "#efe4cc", "#d79a45")) },
  ];
  const clothBoxes: THREE.Box3[] = [];
  const posts: Transform[] = [], lines: Transform[] = [];
  cloths.forEach(({ z, depth, sag, map }) => {
    map.repeat.set(1, depth / 1.7);
    map.anisotropy = anisotropy;
    // The underside glows with the light that soaks through the weave.
    const material = new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.3, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4 });
    const mesh = place(new THREE.Mesh(clothGeometry(18.9, depth, sag), material), 0, 6.5, z, true);
    mesh.receiveShadow = false;
    clothBoxes.push(new THREE.Box3(new THREE.Vector3(-8.6, 5.3, z - depth / 2), new THREE.Vector3(8.6, 6.5, z + depth / 2)));
    for (const side of [-1, 1]) for (const end of [-1, 1]) {
      posts.push({ position: [side * 9.75, 5.95, z + end * depth / 2] });
      lines.push({ position: [side * 9.6, 6.5, z + end * depth / 2], rotation: [0, 0, Math.PI / 2] });
    }
  });
  instances(new THREE.CylinderGeometry(0.045, 0.055, 1.5, 8), metals.crate, posts, false);
  instances(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 5), rope, lines, false, false);

  // ---- Palms ---------------------------------------------------------------
  const frondMap = track(frondTexture());
  const frondMaterial = new THREE.MeshStandardMaterial({ map: frondMap, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.7, metalness: 0, envMapIntensity: 0.5 });
  const barkMap = track(canvasTexture(64, 256, (context) => {
    for (let y = 0; y < 256; y += 1) {
      const ring = (y % 22) / 22, tone = 96 + Math.round(40 * ring) - (ring < 0.14 ? 46 : 0);
      context.fillStyle = `rgb(${tone},${Math.round(tone * 0.8)},${Math.round(tone * 0.58)})`;
      context.fillRect(0, y, 64, 1);
    }
  }, true));
  const bark = new THREE.MeshStandardMaterial({ map: barkMap, roughness: 0.95, metalness: 0, envMapIntensity: 0.3 });
  // [x, z, height, lean, turn]
  const palms: Array<[number, number, number, number, number]> = [
    [-12.4, 2.6, 9.4, 1.3, 0.4], [-13.2, -16.5, 10.6, -0.9, 2.1], [12.6, -1.8, 8.8, -1.1, 3.6], [13.4, -18.6, 10.2, 1.2, 5.0],
    [-4.5, -33.2, 11.4, 0.8, 1.2], [4.2, -33.6, 9.6, -1.0, 4.1], [-12.8, 13.5, 11.8, 0.7, 0.9], [12.2, 14.2, 10.4, -0.8, 2.8],
  ];
  const upper: Transform[] = [], lower: Transform[] = [];
  palms.forEach(([x, z, height, lean, turn]) => {
    const trunk = place(new THREE.Mesh(trunkGeometry(height, lean), bark), x, 0, z, true);
    trunk.rotation.y = turn;
    const crown = new THREE.Vector3(lean, height - 0.1, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn).add(new THREE.Vector3(x, 0, z));
    for (let i = 0; i < 9; i += 1) upper.push({ position: [crown.x, crown.y, crown.z], rotation: [0, turn + i * 0.698 + 0.2, 0] });
    for (let i = 0; i < 8; i += 1) lower.push({ position: [crown.x, crown.y - 0.12, crown.z], rotation: [0, turn + i * 0.785, 0] });
  });
  instances(frondGeometry(3.6, 2.5, 3.1), frondMaterial, upper, false);
  instances(frondGeometry(3.3, 0.7, 3.3), frondMaterial, lower, false);

  // ---- Props ---------------------------------------------------------------
  const crateSpots: V3[] = [
    [-7.9, 0.54, -3.4], [-7.82, 0.54, -4.7], [-7.86, 1.62, -4.0], [7.8, 0.54, -3.1], [7.9, 0.54, -20.2], [7.82, 1.62, -20.2], [7.86, 0.54, -21.5], [-7.9, 0.54, -22.6],
  ];
  instances(crateGeometry(1.08), metals.crate, crateSpots.map((position, index) => ({ position, rotation: [0, (index % 3 - 1) * 0.14 + (index % 2) * Math.PI / 2, 0] as V3 })));
  const drumSpots: V3[] = [[8.4, 0, -6.4], [8.85, 0, -5.8], [-8.6, 0, -16.2], [8.5, 0, -25.4]];
  instances(drumGeometry(), drumPaint, drumSpots.map((position, index) => ({ position, rotation: [0, index * 1.3, 0] as V3 })));
  const urnSpots: Array<[number, number, number]> = [
    [-8.55, -9.2, 1.25], [-8.2, -10.1, 0.9], [-8.75, -10.5, 1.05], [8.6, -15.6, 1.2], [8.3, -16.5, 0.85], [8.7, 1.6, 1.15], [8.25, 0.9, 0.9],
    [-8.6, 8.4, 1.3], [-7.7, 8.7, 0.95], [8.5, 8.5, 1.3], [-8.7, -25.4, 1.1], [-8.2, -26.0, 0.85],
  ];
  instances(urnGeometry(1), terracotta, urnSpots.map(([x, z, scale], index) => ({ position: [x, 0, z] as V3, rotation: [0, index * 0.9, 0] as V3, scale: [scale, scale, scale] as V3 })));
  // Trader's stall under the first awning.
  const stallX = -7.7, stallZ = 5.2;
  instances(new THREE.CylinderGeometry(0.045, 0.05, 2.5, 8), metals.crate, [[-0.95, -1.5], [-0.95, 1.5], [0.95, -1.5], [0.95, 1.5]].map(([x, z]) => ({ position: [stallX + x, 1.25, stallZ + z] as V3 })));
  place(new THREE.Mesh(softBox(1.7, 0.08, 2.9, 0.02, 1.1), metals.crate), stallX, 0.86, stallZ, true, true);
  instances(softBox(0.08, 0.84, 0.08, 0.015, 1.1), metals.crate, [[-0.7, -1.3], [-0.7, 1.3], [0.7, -1.3], [0.7, 1.3]].map(([x, z]) => ({ position: [stallX + x, 0.42, stallZ + z] as V3 })), false);
  const canopyMap = track(stripeTexture("#c9772d", "#efe4cc", "#2f8f88"));
  canopyMap.repeat.set(1, 2);
  const canopyGeometry = clothGeometry(2.2, 3.3, 0.22, 0.015);
  const canopy = place(new THREE.Mesh(canopyGeometry, new THREE.MeshStandardMaterial({ map: canopyMap, emissive: 0xffffff, emissiveMap: canopyMap, emissiveIntensity: 0.25, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })), stallX, 2.62, stallZ, true);
  canopy.rotation.z = -0.1;
  instances(urnGeometry(0.42), terracotta, [[-0.3, -0.9], [0.2, -0.5], [-0.1, 0.1], [0.35, 0.7], [-0.35, 1.0]].map(([x, z], index) => ({ position: [stallX + x, 0.9, stallZ + z] as V3, rotation: [0, index, 0] as V3 })), false);
  // A rug spread in front of the stall.
  const rugMap = track(canvasTexture(256, 512, (context) => {
    context.fillStyle = "#7c2f22"; context.fillRect(0, 0, 256, 512);
    context.strokeStyle = "#e3c58f"; context.lineWidth = 10; context.strokeRect(16, 16, 224, 480);
    context.strokeStyle = "#1f6f6a"; context.lineWidth = 6; context.strokeRect(34, 34, 188, 444);
    for (let i = 0; i < 4; i += 1) {
      const cy = 100 + i * 104;
      context.fillStyle = i % 2 ? "#d58a2e" : "#1f6f6a";
      context.beginPath(); context.moveTo(128, cy - 44); context.lineTo(190, cy); context.lineTo(128, cy + 44); context.lineTo(66, cy); context.closePath(); context.fill();
      context.fillStyle = "#e3c58f";
      context.beginPath(); context.moveTo(128, cy - 18); context.lineTo(152, cy); context.lineTo(128, cy + 18); context.lineTo(104, cy); context.closePath(); context.fill();
    }
  }));
  rugMap.anisotropy = anisotropy;
  const rug = place(new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.8), new THREE.MeshStandardMaterial({ map: rugMap, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), -5.9, 0.012, 5.3, false);
  rug.rotation.set(-Math.PI / 2, 0, 0.08);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, 2.4);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xa9c8ee, 0xc79a62, 0.7));
  const sun = kit.sunLight({ color: 0xfff2dd, intensity: 8.5, toSun: TO_SUN, extent: 30, distance: 52, near: 6, far: 100, radius: 2 });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 420, x: 18, y: [0.2, 6], z: [-28, 8], color: 0xffe6bd, opacity: 0.14 });

  const lit = sunlitFromBoxes(TO_SUN, [
    ...clothBoxes,
    new THREE.Box3(new THREE.Vector3(9.54, 0, -29.4), new THREE.Vector3(10.4, WALL_TOP, 10.4)),
    new THREE.Box3(new THREE.Vector3(-10.4, 0, 9.7), new THREE.Vector3(10.4, 7.6, 10.5)),
  ]);

  return kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills: [],
    reflection,
    look: {
      sky: "/environment/goegap-2k.hdr", skyIntensity: 2.2, skyRotation: 0, skyClamp: 24,
      background: 0x86a9d6, fog: 0xd9c4a2, fogDensity: high ? 0.0042 : 0.006,
      haze: new THREE.Color(0.05, 0.04, 0.028), hazeDensity: 0.0022, hazeCeiling: 9, hazeFade: 3,
      environmentIntensity: 1, exposure: 0.78, far: 220,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.4, -9),
  });
}

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { paintedSteel, pbrMaterial, roofDeck, tile } from "../pbr";
import {
  BRAND, STRIKE_ORANGE, canvasTexture, crateGeometry, createKit, drumGeometry, iBeam, softBox, softDiscTexture, sunlitFromBoxes, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";

// Nightline: the roof of a tower after rain, forty storeys above a city that
// does not exist anywhere else.
//
// Lighting model: a cool moon, matched to the one in the sky photograph, is the
// only shadow-casting light. Sodium lamps, neon and wall bulkheads carry the
// range itself; the wet deck mirrors them, and a probe of the lit roof stands in
// for the sky as image-based light. The skyline is unlit geometry with painted
// windows: a handful of merged meshes, faded into violet haze by the fog.

/** Direction to the moon in `rooftop_night-2k.hdr`. */
const TO_MOON = new THREE.Vector3(0.08, 0.76, -0.64).normalize();
const ROOF = { x0: -16, x1: 16, z0: -33, z1: 15.2 };
const PLANT_TOP = 6.4;
const SCREEN_TOP = 5.2;
/** One window bay and one storey of the skyline, in metres. */
const BAY = 1.7, STOREY = 3.5, BAYS = 32, STOREYS = 64;

type V3 = [number, number, number];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A tiling facade at night: 32 bays by 64 storeys, a scatter of lit rooms. */
function windowTexture(seed: number, style: number) {
  const texture = canvasTexture(512, 1024, (context) => {
    const next = rng(seed);
    context.fillStyle = ["#07070d", "#06080f", "#08070c", "#06060a"][style];
    context.fillRect(0, 0, 512, 1024);
    const density = [0.2, 0.3, 0.22, 0.15][style];
    for (let row = 0; row < STOREYS; row += 1) {
      const mood = next();
      const chance = mood < 0.16 ? 0.015 : mood > 0.95 ? 0.94 : density * (0.35 + next() * 1.1);
      const temperature = next();
      let run = false;
      for (let column = 0; column < BAYS; column += 1) {
        const pier = style === 2 && column % 4 === 3;
        const narrow = style === 3;
        const x = column * 16 + (narrow ? 4 : 2), y = row * 16 + 3, w = narrow ? 8 : 12, h = narrow ? 9 : 10;
        if (pier) { next(); continue; }
        context.fillStyle = style === 1 ? "#0c111c" : "#0d0e16";
        context.fillRect(x, y, w, h);
        const lit: boolean = next() < chance * (run ? 2.1 : 0.8);
        run = lit;
        if (!lit) continue;
        const pick = next(), level = 0.5 + next() * 0.5;
        let colour: V3 = temperature < 0.55 ? [255, 190, 112] : temperature < 0.82 ? [255, 232, 196] : [176, 214, 255];
        if (style === 1) colour = pick < 0.7 ? [186, 220, 255] : [255, 236, 204];
        if (pick > 0.99) colour = [142, 245, 227];
        else if (pick > 0.98) colour = [255, 120, 190];
        context.fillStyle = `rgb(${Math.round(colour[0] * level)},${Math.round(colour[1] * level)},${Math.round(colour[2] * level)})`;
        context.fillRect(x, y, w, h);
        // Blinds, furniture, a mullion: no two lit rooms are the same rectangle.
        context.fillStyle = "rgba(8,8,14,.55)";
        if (next() < 0.4) context.fillRect(x, y, w, 2 + Math.floor(next() * 5));
        if (!narrow) context.fillRect(x + 5, y, 1, h);
      }
    }
  }, true);
  return texture;
}

/** A skyline box whose faces sample the facade in world units; roofs are dark. */
function facadeBox(w: number, h: number, d: number, x: number, top: number, z: number, turn: number, tint: V3, next: () => number) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const uv = geometry.attributes.uv, colours = new Float32Array(24 * 3);
  const u0 = Math.floor(next() * BAYS) / BAYS, v0 = Math.floor(next() * STOREYS) / STOREYS;
  const shades = [1, 0.7, 0, 0, 0.86, 0.6];
  for (let i = 0; i < 24; i += 1) {
    const face = i >> 2;
    let shade = 0.02;
    if (face === 2 || face === 3) uv.setXY(i, 0.5 / 512, 0.5 / 1024);
    else {
      const extent = face < 2 ? d : w;
      uv.setXY(i, uv.getX(i) * extent / (BAY * BAYS) + u0, uv.getY(i) * h / (STOREY * STOREYS) + v0);
      shade = shades[face];
    }
    colours[i * 3] = tint[0] * shade; colours[i * 3 + 1] = tint[1] * shade; colours[i * 3 + 2] = tint[2] * shade;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  geometry.rotateY(turn);
  geometry.translate(x, top - h / 2, z);
  return geometry;
}

/** A plain box carrying one vertex colour (crown bands, spires). */
function tintedBox(w: number, h: number, d: number, x: number, y: number, z: number, turn: number, colour: V3) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const colours = new Float32Array(24 * 3);
  for (let i = 0; i < 24; i += 1) colours.set(colour, i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  geometry.rotateY(turn);
  geometry.translate(x, y, z);
  return geometry;
}

/** Illuminated board for a tower: an invented name beside an invented mark. */
function brandBoard(name: string, colour: string, glyph: number) {
  return canvasTexture(1024, 384, (context) => {
    context.fillStyle = "#05060a";
    context.fillRect(0, 0, 1024, 384);
    context.strokeStyle = colour; context.fillStyle = colour;
    context.shadowColor = colour; context.shadowBlur = 26;
    context.lineWidth = 16; context.lineCap = "round"; context.lineJoin = "round";
    const cx = 170, cy = 192;
    if (glyph === 0) {
      // Split ring with a bar through it.
      context.beginPath(); context.arc(cx, cy, 92, 0.5, Math.PI - 0.5); context.stroke();
      context.beginPath(); context.arc(cx, cy, 92, Math.PI + 0.5, -0.5); context.stroke();
      context.beginPath(); context.moveTo(cx - 120, cy); context.lineTo(cx + 120, cy); context.stroke();
    } else if (glyph === 1) {
      // Three stacked chevrons.
      for (let i = 0; i < 3; i += 1) { context.beginPath(); context.moveTo(cx - 96, cy + 96 - i * 62); context.lineTo(cx, cy + 30 - i * 62); context.lineTo(cx + 96, cy + 96 - i * 62); context.stroke(); }
    } else if (glyph === 2) {
      // A square turned on its corner inside a square.
      context.strokeRect(cx - 96, cy - 96, 192, 192);
      context.beginPath(); context.moveTo(cx, cy - 70); context.lineTo(cx + 70, cy); context.lineTo(cx, cy + 70); context.lineTo(cx - 70, cy); context.closePath(); context.fill();
    } else {
      // Rising bars.
      for (let i = 0; i < 4; i += 1) context.fillRect(cx - 104 + i * 58, cy + 100 - (60 + i * 46), 34, 60 + i * 46);
    }
    context.font = "700 168px 'Helvetica Neue', Arial, sans-serif";
    context.textBaseline = "middle";
    context.fillText(name, 340, 202, 640);
  });
}

/** The roof's own sign: glass tube lettering. */
function neonLettering() {
  return canvasTexture(2048, 256, (context) => {
    context.clearRect(0, 0, 2048, 256);
    context.fillStyle = "#000"; context.fillRect(0, 0, 2048, 256);
    context.font = "600 190px 'Helvetica Neue', Arial, sans-serif";
    context.textBaseline = "middle"; context.textAlign = "center";
    context.lineJoin = "round"; context.lineCap = "round";
    const draw = (width: number, colour: string, blur: number) => {
      context.shadowColor = "#8ef5e3"; context.shadowBlur = blur;
      context.strokeStyle = colour; context.lineWidth = width;
      const letters = "NIGHTLINE";
      for (let i = 0; i < letters.length; i += 1) context.strokeText(letters[i], 1024 + (i - 4) * 212, 134);
    };
    draw(13, "#2f9c8c", 34);
    draw(8, "#8ef5e3", 14);
    draw(3, "#e6fffa", 0);
  });
}

/** Axial fan behind a wire guard. */
function fanTexture() {
  return canvasTexture(256, 256, (context) => {
    context.fillStyle = "#6a7176"; context.fillRect(0, 0, 256, 256);
    context.fillStyle = "#101315"; context.beginPath(); context.arc(128, 128, 112, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#3a4046";
    for (let blade = 0; blade < 7; blade += 1) {
      const a = blade * Math.PI * 2 / 7;
      context.beginPath(); context.moveTo(128, 128); context.arc(128, 128, 104, a, a + 0.5); context.closePath(); context.fill();
    }
    context.strokeStyle = "#9aa4aa"; context.lineWidth = 2;
    for (let ring = 14; ring <= 112; ring += 14) { context.beginPath(); context.arc(128, 128, ring, 0, Math.PI * 2); context.stroke(); }
    context.lineWidth = 4;
    for (let spoke = 0; spoke < 4; spoke += 1) { const a = spoke * Math.PI / 4; context.beginPath(); context.moveTo(128 - Math.cos(a) * 114, 128 - Math.sin(a) * 114); context.lineTo(128 + Math.cos(a) * 114, 128 + Math.sin(a) * 114); context.stroke(); }
    context.fillStyle = "#2a2f33"; context.beginPath(); context.arc(128, 128, 20, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "#3b4146"; context.lineWidth = 8; context.beginPath(); context.arc(128, 128, 116, 0, Math.PI * 2); context.stroke();
  });
}

/** Pressed steel louvre slats. */
function louvreTexture() {
  return canvasTexture(64, 64, (context) => {
    for (let slat = 0; slat < 4; slat += 1) {
      const gradient = context.createLinearGradient(0, slat * 16, 0, slat * 16 + 16);
      gradient.addColorStop(0, "#59626a"); gradient.addColorStop(0.55, "#2a3036"); gradient.addColorStop(0.7, "#040506"); gradient.addColorStop(1, "#040506");
      context.fillStyle = gradient; context.fillRect(0, slat * 16, 64, 16);
    }
  }, true);
}

/** Timber pallet, 1.2 × 1.0 m, standing on y = 0. */
function palletGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number) => { const part = worldBox(w, h, d, 1.1); part.translate(x, y, z); parts.push(part); };
  for (let i = 0; i < 5; i += 1) add(1.2, 0.022, 0.1, 0, 0.133, -0.45 + i * 0.225);
  for (const x of [-0.55, 0, 0.55]) add(0.1, 0.1, 1.0, x, 0.072, 0);
  for (const z of [-0.45, 0, 0.45]) add(1.2, 0.022, 0.1, 0, 0.011, z);
  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  return merged;
}

/** Cable drum, axis on Y, standing on one flange. */
function spoolGeometry() {
  const profile = [[0.1, 0], [0.62, 0], [0.62, 0.06], [0.3, 0.06], [0.3, 0.74], [0.62, 0.74], [0.62, 0.8], [0.1, 0.8]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 28);
}

export function buildRooftop(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  const metals = kit.metals();

  // ---- Materials -----------------------------------------------------------
  const asphalt = photoSet("/textures/asphalt_02-1k", 32 / 3.2, 48.2 / 3.2, false);
  const cast = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1);
  const brick = photoSet("/textures/brick_wall_001-2k", 1, 1);
  const concrete = new THREE.MeshStandardMaterial({ ...cast, color: 0x9a9ca2, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  const brickwork = new THREE.MeshStandardMaterial({ ...brick, color: 0xb9aca4, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  const screenPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.075, 0.1, 0.125], 511, 0.55)), { envMapIntensity: 1 });
  const plantPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.3, 0.32, 0.33], 613, 0.45, 512)), { envMapIntensity: 1 });
  const tankPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.17, 0.085, 0.05], 717, 0.8, 512)), { envMapIntensity: 0.9 });
  const drumPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.06, 0.2, 0.2], 311, 0.8, 512)), { envMapIntensity: 1 });
  const amberPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.5, 0.24, 0.05], 811, 0.6, 512)), { envMapIntensity: 0.9 });
  const sheeting = pbrMaterial(keep(tile(roofDeck(anisotropy, 43), 6, 2)), { envMapIntensity: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xa8cfe0, transparent: true, opacity: 0.17, roughness: 0.04, metalness: 0, envMapIntensity: 1.8, depthWrite: false });
  const emissive = (colour: number, gain: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(gain), toneMapped: false });
  const mintTube = emissive(BRAND, 2.6), amberTube = emissive(STRIKE_ORANGE, 3), sodium = emissive(0xffa758, 3), markerGlow = emissive(0xffb45a, 2.4);
  const fanMap = track(fanTexture());
  fanMap.anisotropy = anisotropy;
  const fanFace = new THREE.MeshStandardMaterial({ map: fanMap, roughness: 0.6, metalness: 0.25, envMapIntensity: 0.8 });
  const louvreMap = track(louvreTexture());
  louvreMap.anisotropy = anisotropy;
  const louvre = (across: number, slats: number) => {
    const map = track(louvreMap.clone());
    map.needsUpdate = true;
    map.repeat.set(across, slats);
    return new THREE.MeshStandardMaterial({ map, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.8 });
  };

  // ---- Roof deck -----------------------------------------------------------
  const deck = new THREE.MeshStandardMaterial({ ...asphalt, color: 0x9498a2, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  const roofWidth = ROOF.x1 - ROOF.x0, roofDepth = ROOF.z1 - ROOF.z0, roofZ = (ROOF.z0 + ROOF.z1) / 2;
  const reflection = kit.floor(deck, { width: roofWidth, depth: roofDepth, z: roofZ }, {
    lane: new THREE.Color(BRAND).multiplyScalar(0.62),
    edge: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.7),
    markings: 0.85,
    wet: 0.06,
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
  // Service door with a bulkhead lamp over it.
  place(new THREE.Mesh(softBox(0.09, 2.3, 1.3, 0.02, 1.4), metals.darkMetal), -9.51, 1.15, -4, false, true);
  place(new THREE.Mesh(softBox(0.06, 2.12, 1.04, 0.015, 1.6), screenPaint), -9.475, 1.08, -4, false, true);
  place(new THREE.Mesh(softBox(0.05, 0.05, 0.16, 0.012, 1), metals.brushed), -9.43, 1.05, -4.38, false);
  place(new THREE.Mesh(softBox(0.1, 0.14, 0.42, 0.03, 1), metals.darkMetal), -9.47, 2.52, -4, false);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.34), sodium), -9.415, 2.5, -4, false);
  // Intake louvre and switchgear at the far end.
  place(new THREE.Mesh(softBox(0.1, 1.7, 2.5, 0.02, 1.4), metals.darkMetal), -9.51, 2.35, -24.3, false, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.5, 2.3), louvre(1, 14)), -9.455, 2.35, -24.3, false);
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

  // The roof's sign: tube lettering between amber chevrons that point down range.
  const lettering = track(neonLettering());
  lettering.anisotropy = anisotropy;
  place(new THREE.Mesh(softBox(0.08, 1.5, 12.6, 0.02, 1.6), metals.darkMetal), -9.5, 5.2, -14, false, true);
  const sign = place(new THREE.Mesh(new THREE.PlaneGeometry(9.2, 1.15), new THREE.MeshBasicMaterial({ map: lettering, color: new THREE.Color(2.4, 2.4, 2.4), toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false })), -9.45, 5.2, -14, false);
  sign.rotation.y = Math.PI / 2;
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
  const fanPlane = new THREE.PlaneGeometry(1.75, 1.75);
  instances(fanPlane, fanFace, chillers.flatMap((z) => [-1.08, 1.08].map((offset) => ({ position: [-11.19, plantY + 1.2, z + offset] as V3, rotation: [0, Math.PI / 2, 0] as V3 }))), false, false);
  instances(new THREE.CylinderGeometry(0.82, 0.86, 0.3, 24), metals.darkMetal, chillers.flatMap((z) => [-1.08, 1.08].map((offset) => ({ position: [-12.6, plantY + 2.38, z + offset] as V3 }))), false);
  const ductMain = new THREE.CylinderGeometry(0.34, 0.34, 23.5, 20);
  ductMain.rotateX(Math.PI / 2);
  place(new THREE.Mesh(ductMain, metals.brushed), -10.35, plantY + 0.62, -13.6, true);
  const flange = new THREE.TorusGeometry(0.355, 0.035, 8, 24);
  instances(flange, metals.structural, Array.from({ length: 9 }, (_, i) => ({ position: [-10.35, plantY + 0.62, -24.6 + i * 2.75] as V3 })), false, false);
  instances(softBox(0.9, 0.28, 0.12, 0.02, 1), metals.darkMetal, Array.from({ length: 8 }, (_, i) => ({ position: [-10.35, plantY + 0.14, -23.2 + i * 2.75] as V3 })), false, false);
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
  const mastBeacon = emissive(0xff2a1c, 4);
  place(new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), mastBeacon), mastX + 0.3, mastTop + 0.16, mastZ + 0.3, false);
  kit.updates.push((now) => {
    const pulse = 0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(now * 0.0031)), 6);
    mastBeacon.color.setRGB(5 * pulse, 0.5 * pulse, 0.3 * pulse);
  });

  // ---- Mechanical yard screen (+x) -----------------------------------------
  place(new THREE.Mesh(worldBox(0.16, SCREEN_TOP, sideRun, 2.4), screenPaint), 9.62, SCREEN_TOP / 2, sideZ, true, true);
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
  // Bulkhead lamps on the screen.
  const bulkheads = [-3.6, -20.1];
  instances(softBox(0.12, 0.22, 0.5, 0.03, 1), metals.darkMetal, bulkheads.map((z) => ({ position: [9.5, 4.08, z] as V3 })), false, false);
  instances(new THREE.BoxGeometry(0.04, 0.12, 0.4), sodium, bulkheads.map((z) => ({ position: [9.43, 4.06, z] as V3 })), false, false);

  // Billboard seen from behind: columns, walers, bracing, a catwalk.
  const boardZ = -20.7, boardRun = 12.4, boardLow = 6.2, boardHigh = 12.8;
  const boardColumns = [-26.4, -22.6, -18.8, -15];
  instances(iBeam(0.3, 0.3, boardHigh + 0.1, 0.035, 0.025), metals.structural, boardColumns.map((z) => ({ position: [10.5, 0, z] as V3 })), false);
  const sheet = place(new THREE.Mesh(new THREE.BoxGeometry(0.1, boardHigh - boardLow, boardRun), sheeting), 11.0, (boardLow + boardHigh) / 2, boardZ, true);
  sheet.receiveShadow = true;
  instances(softBox(0.1, 0.12, boardRun, 0.02, 1.4), metals.structural, [6.3, 7.9, 9.5, 11.1, 12.7].map((y) => ({ position: [10.78, y, boardZ] as V3 })), false);
  const bay = 3.8, rise = 3.2, tilt = Math.atan(bay / rise);
  const boardBraces: Transform[] = [];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 2; j += 1) {
    boardBraces.push({ position: [10.62, 6.3 + rise * (j + 0.5), boardColumns[i] + bay / 2], rotation: [((i + j) % 2 ? 1 : -1) * tilt, 0, 0] });
  }
  instances(new THREE.BoxGeometry(0.05, Math.hypot(bay, rise), 0.05), metals.structural, boardBraces, false);
  place(new THREE.Mesh(softBox(0.95, 0.06, boardRun + 0.4, 0.015, 1.2), metals.darkMetal), 10.2, 5.72, boardZ, true);
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
  place(new THREE.Mesh(new THREE.ConeGeometry(2.16, 0.95, 36), tankPaint), tankX, tankFloor + 4.17, tankZ, true);
  const hoop = new THREE.TorusGeometry(2.02, 0.035, 8, 48);
  hoop.rotateX(Math.PI / 2);
  instances(hoop, metals.structural, [0.5, 1.4, 2.4, 3.3].map((y) => ({ position: [tankX, tankFloor + 0.2 + y, tankZ] as V3 })), false, false);
  instances(new THREE.BoxGeometry(0.03, tankFloor + 3.6, 0.03), metals.structural, [-0.2, 0.2].map((z) => ({ position: [tankX - 2.1, (tankFloor + 3.6) / 2, tankZ + z] as V3 })), false);
  instances(new THREE.BoxGeometry(0.025, 0.025, 0.4), metals.structural, Array.from({ length: 28 }, (_, i) => ({ position: [tankX - 2.1, 0.4 + i * 0.38, tankZ] as V3 })), false, false);

  // ---- Stair and lift core behind the firing line ---------------------------
  const coreTop = 8.4;
  place(new THREE.Mesh(worldBox(20.8, coreTop, 5.3, 2.6), brickwork), 0, coreTop / 2, 12.35, true, true);
  place(new THREE.Mesh(softBox(21.1, 0.24, 5.6, 0.04, 3), concrete), 0, coreTop + 0.12, 12.35, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(20.4, 0.04, 0.03), amberTube), 0, coreTop - 0.06, 9.68, false);
  place(new THREE.Mesh(softBox(6.2, 2.7, 3.8, 0.05, 2.6), concrete), 3.6, coreTop + 1.55, 12.6, true);
  place(new THREE.Mesh(softBox(1.3, 2.3, 0.09, 0.02, 1.4), metals.darkMetal), 8.4, 1.15, 9.69, false, true);
  place(new THREE.Mesh(softBox(1.04, 2.12, 0.06, 0.015, 1.6), screenPaint), 8.4, 1.08, 9.665, false, true);
  place(new THREE.Mesh(softBox(0.42, 0.14, 0.1, 0.03, 1), metals.darkMetal), 8.4, 2.52, 9.66, false);
  place(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.03), sodium), 8.4, 2.5, 9.605, false);
  place(new THREE.Mesh(softBox(2.3, 1.7, 0.1, 0.02, 1.4), metals.darkMetal), -8.3, 2.6, 9.69, false, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.5, 0.03), louvre(1, 14)), -8.3, 2.6, 9.635, false);

  // ---- Lamp piers and the glazed edge of the firing point -------------------
  const piers = [-1, 1].map((side) => ({ position: [side * 9.84, 2.35, 3.5] as V3 }));
  instances(softBox(0.6, 4.7, 0.6, 0.04, 2.2), concrete, piers);
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
  place(new THREE.Mesh(softBox(roofWidth, upstand, 0.4, 0.03, 2.4), concrete), 0, upstand / 2, ROOF.z0 + 0.2, true);
  place(new THREE.Mesh(softBox(roofWidth, upstand, 0.4, 0.03, 2.4), concrete), 0, upstand / 2, ROOF.z1 - 0.2, true);
  for (const side of [-1, 1]) place(new THREE.Mesh(softBox(0.4, upstand, roofDepth, 0.03, 2.4), concrete), side * (ROOF.x1 - 0.2), upstand / 2, roofZ, true);
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
  instances(fanPlane, fanFace, [-1.05, 1.05].map((offset) => ({ position: [11.84, 1.3, 5.2 + offset] as V3, rotation: [0, -Math.PI / 2, 0] as V3 })), false, false);
  place(new THREE.Mesh(softBox(0.8, 0.8, 3.2, 0.03, 1.6), metals.brushed), 13.2, 2.86, 5.2, true);
  place(new THREE.Mesh(softBox(0.8, 2.5, 0.8, 0.03, 1.6), metals.brushed), 13.2, 1.25, 1.2, true);
  place(new THREE.Mesh(softBox(0.8, 0.8, 3.2, 0.03, 1.6), metals.brushed), 13.2, 2.86, 2.4, true);
  // A floor vent on the -x deck breathing steam.
  place(new THREE.Mesh(softBox(1.5, 0.7, 1.5, 0.04, 1.6), plantPaint), -12.9, 0.35, 5.4, true, true);
  place(new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.03, 1.3), louvre(1, 9)), -12.9, 0.715, 5.4, false);
  place(new THREE.Mesh(softBox(2.4, 0.5, 1.2, 0.04, 1.6), concrete), -13.4, 0.25, 1.8, true);

  // ---- Props ---------------------------------------------------------------
  const crateSpots: V3[] = [
    [-8.2, 0.54, -1.5], [-8.15, 0.54, -22.3], [-8.25, 0.54, -26.4], [-8.2, 1.62, -26.3],
    [8.1, 0.54, -2.3], [8.2, 0.54, -3.6], [8.15, 1.62, -2.9], [-11.6, 0.54, 8.2], [11.4, 0.54, 8.6],
  ];
  instances(crateGeometry(1.08), metals.crate, crateSpots.map((position, index) => ({ position, rotation: [0, (index % 3 - 1) * 0.13 + (index % 2) * Math.PI / 2, 0] as V3 })));
  const drumSpots: V3[] = [[-8.5, 0, -6.1], [-8.95, 0, -5.4], [8.55, 0, -7.4], [8.95, 0, -8.1], [8.5, 0, -26.9], [-14.2, 0, 7.6], [-14.7, 0, 6.9]];
  instances(drumGeometry(), drumPaint, drumSpots.map((position, index) => ({ position, rotation: [0, index * 1.3, 0] as V3 })));
  const pallet = palletGeometry();
  instances(pallet, metals.crate, [
    { position: [8.2, 0, -5.4], rotation: [0, 0.1, 0] }, { position: [8.2, 0.145, -5.4], rotation: [0, -0.06, 0] }, { position: [8.2, 0.29, -5.4], rotation: [0, 0.16, 0] },
    { position: [-8.2, 0, -20.6], rotation: [0, Math.PI / 2 + 0.05, 0] },
    { position: [-11.8, 0, 3.2], rotation: [0, 0.3, 0] }, { position: [-11.8, 0.145, 3.2], rotation: [0, 0.2, 0] },
    { position: [12.2, 0, 8.9], rotation: [0, -0.2, 0] },
  ]);
  const spool = spoolGeometry();
  instances(spool, metals.crate, [
    { position: [-7.75, 0.62, -24.1], rotation: [0, 0.12, Math.PI / 2] },
    { position: [8.75, 0, -0.9], rotation: [0, 0.5, 0] },
    { position: [-14.3, 0.62, 3.4], rotation: [0, 1.2, Math.PI / 2], scale: [1, 1, 1] },
  ]);
  const coil = new THREE.CylinderGeometry(0.31, 0.31, 0.6, 24, 1, true);
  instances(coil, new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.55, metalness: 0 }), [
    { position: [-8.15, 0.62, -24.1], rotation: [0, 0.12, Math.PI / 2] }, { position: [8.75, 0.4, -0.9] },
  ], false, false);

  // ---- Skyline -------------------------------------------------------------
  const facades = [0, 1, 2, 3].map((style) => {
    const map = track(windowTexture(1301 + style * 97, style));
    map.anisotropy = anisotropy;
    return map;
  });
  const next = rng(4242);
  const bodies: THREE.BufferGeometry[][] = [[], [], [], []];
  const bands: THREE.BufferGeometry[] = [], darks: THREE.BufferGeometry[] = [];
  const beacons: V3[][] = [[], []];
  const snap = (metres: number) => Math.max(4, Math.round(metres / BAY)) * BAY;
  const bandColours: V3[] = [[0.56 * 2.2, 0.96 * 2.2, 0.89 * 2.2], [0.91 * 2.4, 0.6 * 2.4, 0.26 * 2.4], [1.9, 1.95, 2.2], [2.2, 0.7, 1.4]];
  // [x, z, width, depth, top, facade, turn]
  const towers: Array<[number, number, number, number, number, number, number]> = [
    [-16, -80, 20, 20, 50, 0, 0], [22, -95, 24, 22, 66, 1, 0], [2, -128, 26, 26, 62, 2, 0.3], [-46, -112, 22, 24, 96, 3, 0.2],
    [52, -124, 26, 22, 104, 0, -0.25], [-36, -56, 16, 16, 30, 1, 0.12], [38, -58, 18, 18, 46, 2, -0.1], [-72, -84, 26, 26, 80, 0, 0.5],
    [78, -78, 24, 28, 88, 3, -0.4], [-4, -164, 30, 24, 110, 1, 0], [-98, -130, 28, 28, 150, 2, 0.6], [100, -140, 30, 26, 140, 1, -0.5],
    [-52, -30, 18, 22, 88, 2, 0], [-48, -2, 20, 18, 52, 3, 0.08], [-80, -26, 26, 24, 126, 1, -0.2], [-62, 26, 22, 22, 70, 0, 0],
    [-110, 10, 30, 30, 112, 3, 0.3], [50, -34, 18, 20, 64, 0, 0.1], [56, -8, 20, 20, 96, 1, -0.06], [62, 18, 20, 24, 58, 2, 0],
    [88, -36, 26, 26, 136, 3, 0.4], [112, 14, 30, 28, 98, 0, -0.3], [-36, 58, 22, 20, 76, 1, 0.2], [6, 66, 26, 22, 108, 2, 0],
    [44, 60, 20, 22, 66, 3, -0.2], [-78, 70, 28, 26, 122, 0, 0.5], [84, 76, 26, 28, 92, 1, -0.5], [-20, 112, 30, 26, 140, 3, 0.1],
    [40, 120, 28, 28, 118, 0, -0.1], [-120, 80, 30, 30, 100, 2, 0.7], [124, -60, 28, 28, 120, 2, -0.6], [-126, -60, 30, 28, 108, 0, 0.6],
    [130, 80, 30, 30, 130, 3, -0.7], [64, -176, 28, 28, 124, 2, -0.3], [-60, -172, 28, 26, 100, 3, 0.3],
  ];
  towers.forEach(([x, z, width, depth, top, style, turn], index) => {
    const w = snap(width), d = snap(depth);
    const warmth = next();
    const tint: V3 = [1.5 + warmth * 0.3, 1.5, 1.8 - warmth * 0.3];
    bodies[style].push(facadeBox(w, top + 120, d, x, top, z, turn, tint, next));
    let crown = top, cw = w, cd = d;
    if (index % 3 !== 1) {
      // A stepped crown.
      cw = snap(w * 0.62); cd = snap(d * 0.62); crown = top + 8 + Math.floor(next() * 4) * STOREY;
      bodies[style].push(facadeBox(cw, crown - top + 2, cd, x, crown, z, turn, tint, next));
    }
    if (index % 2 === 0) bands.push(tintedBox(cw + 0.7, 1.3, cd + 0.7, x, crown - 1.2, z, turn, bandColours[index % 4 === 0 ? (index / 4) % 4 : 2]));
    if (index % 5 === 3) bands.push(tintedBox(w + 0.7, 0.9, d + 0.7, x, top * 0.55, z, turn, bandColours[(index + 1) % 4]));
    let tip = crown;
    if (index % 4 !== 2) {
      const spire = 8 + next() * 22;
      darks.push(tintedBox(1.1, spire, 1.1, x, crown + spire / 2, z, turn, [1, 1, 1]));
      darks.push(tintedBox(cw * 0.4, 3, cd * 0.4, x, crown + 1.5, z, turn, [1, 1, 1]));
      tip = crown + spire;
    }
    beacons[index % 2].push([x, tip + 0.9, z]);
    if (index % 3 === 0) beacons[(index + 1) % 2].push([x + (cw / 2 - 0.8), crown + 0.8, z + (cd / 2 - 0.8)]);
  });
  // Lower blocks close the gaps between the towers.
  for (let i = 0; i < 46; i += 1) {
    const angle = next() * Math.PI * 2, radius = 42 + next() * 78;
    const w = snap(14 + next() * 20), d = snap(14 + next() * 20), top = -26 + next() * 44;
    const x = Math.sin(angle) * radius, z = -9 + Math.cos(angle) * radius * 1.15;
    if (Math.abs(x) - w / 2 < 24 && Math.abs(z + 9) - d / 2 < 32) continue;
    if (towers.some(([tx, tz, tw, td]) => Math.abs(tx - x) < (tw + w) / 2 + 1 && Math.abs(tz - z) < (td + d) / 2 + 1)) continue;
    bodies[i % 4].push(facadeBox(w, top + 120, d, x, top, z, 0, [1.4, 1.4, 1.6], next));
    if (i % 5 === 0) bands.push(tintedBox(w + 0.6, 0.8, d + 0.6, x, top - 0.8, z, 0, bandColours[i % 4]));
  }
  const merge = (parts: THREE.BufferGeometry[]) => {
    const merged = mergeGeometries(parts);
    parts.forEach((part) => part.dispose());
    return merged;
  };
  const far = (mesh: THREE.Mesh) => { mesh.castShadow = false; mesh.receiveShadow = false; mesh.matrixAutoUpdate = false; scene.add(mesh); return mesh; };
  bodies.forEach((parts, style) => {
    if (parts.length) far(new THREE.Mesh(merge(parts), new THREE.MeshBasicMaterial({ map: facades[style], vertexColors: true, toneMapped: false })));
  });
  far(new THREE.Mesh(merge(bands), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })));
  far(new THREE.Mesh(merge(darks), new THREE.MeshBasicMaterial({ color: 0x08090f, vertexColors: true })));
  // Aviation beacons, in two groups that blink out of step.
  const beaconGeometry = new THREE.SphereGeometry(0.85, 10, 8);
  const beaconMaterials = beacons.map((spots) => {
    const material = emissive(0xff2a1c, 4);
    const mesh = instances(beaconGeometry, material, spots.map((position) => ({ position })), false, false);
    mesh.receiveShadow = false;
    return material;
  });
  kit.updates.push((now) => {
    beaconMaterials.forEach((material, index) => {
      const pulse = 0.12 + 0.88 * Math.pow(Math.max(0, Math.sin(now * 0.0026 + index * 2.2)), 4);
      material.color.setRGB(6 * pulse, 0.5 * pulse, 0.32 * pulse);
    });
  });
  // Illuminated boards on four towers: invented marks in the range's two colours.
  const boards: Array<{ name: string; colour: string; glyph: number; size: [number, number]; position: V3; turn: number; gain: number }> = [
    { name: "HALCYA", colour: "#8ef5e3", glyph: 0, size: [18, 6.75], position: [-16, 19, -69.3], turn: 0, gain: 2.3 },
    { name: "ORVANE", colour: "#e89a42", glyph: 1, size: [21, 7.9], position: [22, 33, -83.3], turn: 0, gain: 2.6 },
    { name: "KYDO·7", colour: "#e89a42", glyph: 2, size: [16, 6], position: [51.2, 13, 18], turn: -Math.PI / 2, gain: 2.4 },
    { name: "TESSELAR", colour: "#8ef5e3", glyph: 3, size: [17, 6.4], position: [-50.2, 14, 26], turn: Math.PI / 2, gain: 2.3 },
  ];
  for (const board of boards) {
    const map = track(brandBoard(board.name, board.colour, board.glyph));
    map.anisotropy = anisotropy;
    const mesh = far(new THREE.Mesh(new THREE.PlaneGeometry(...board.size), new THREE.MeshBasicMaterial({ map, color: new THREE.Color(board.gain, board.gain, board.gain), toneMapped: false })));
    mesh.position.set(...board.position);
    mesh.rotation.y = board.turn;
    mesh.updateMatrix();
  }
  // City glow: a ring of haze that swallows the horizon of the sky photograph.
  const hazeMap = track(canvasTexture(4, 256, (context) => {
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, "rgba(64,44,92,0)");
    gradient.addColorStop(0.1, "rgba(64,44,92,.3)");
    gradient.addColorStop(0.22, "rgba(60,42,88,.9)");
    gradient.addColorStop(0.3, "rgba(46,34,72,1)");
    gradient.addColorStop(1, "rgba(18,14,32,1)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4, 256);
  }));
  const hazeRing = far(new THREE.Mesh(new THREE.CylinderGeometry(225, 225, 180, 48, 1, true), new THREE.MeshBasicMaterial({ map: hazeMap, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false })));
  hazeRing.position.set(0, -40, -9);
  hazeRing.updateMatrix();
  const cityFloor = far(new THREE.Mesh(new THREE.CircleGeometry(226, 48), new THREE.MeshBasicMaterial({ color: 0x120e20, fog: false })));
  cityFloor.rotation.x = -Math.PI / 2;
  cityFloor.position.set(0, -120, -9);
  cityFloor.updateMatrix();

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
  const fills = [
    lamp(0xffab62, 70, 20, -8.2, 6.0, 3.5),
    lamp(0xffab62, 70, 20, 8.2, 6.0, 3.5),
    lamp(BRAND, 64, 22, -7.4, 4.6, -14),
    lamp(0xffa55c, 44, 17, 8.2, 3.9, -20.1),
    lamp(0xffa55c, 44, 17, 8.2, 3.9, -3.6),
    lamp(0xb8ccff, 50, 20, -7.2, 4.6, -24.5),
  ];

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 260, x: 18, y: [0.2, 6], z: [-28, 8], color: 0xc8d0ff, opacity: 0.2 });
  // Slow steam from the vents.
  const sources: V3[] = [[-14, plantY + 1.7, -8.9], [-13.9, plantY + 1.7, -16.3], [-12.9, 0.8, 5.4]];
  const perSource = high ? 34 : 18, steamCount = sources.length * perSource;
  const steamPositions = new Float32Array(steamCount * 3), steamColours = new Float32Array(steamCount * 3), phases = new Float32Array(steamCount);
  const steamRandom = rng(77);
  for (let i = 0; i < steamCount; i += 1) phases[i] = steamRandom();
  const steamGeometry = new THREE.BufferGeometry();
  steamGeometry.setAttribute("position", new THREE.BufferAttribute(steamPositions, 3));
  steamGeometry.setAttribute("color", new THREE.BufferAttribute(steamColours, 3));
  steamGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(-13, 6, -6), 22);
  const steam = new THREE.Points(steamGeometry, new THREE.PointsMaterial({ map: track(softDiscTexture()), size: 1.7, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.085, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(steam);
  kit.probeHidden.push(steam);
  kit.mirrorHidden.push(steam);
  kit.updates.push((now) => {
    const seconds = now / 1000;
    for (let i = 0; i < steamCount; i += 1) {
      const source = sources[Math.floor(i / perSource)], phase = phases[i];
      const life = (seconds * 0.085 + phase * 7.31 + i / perSource) % 1;
      const sway = Math.sin(phase * 40 + seconds * 0.6) * 0.35 * life;
      steamPositions[i * 3] = source[0] + sway + life * life * 1.5;
      steamPositions[i * 3 + 1] = source[1] + life * 5.2;
      steamPositions[i * 3 + 2] = source[2] + Math.cos(phase * 31 + seconds * 0.45) * 0.35 * life + life * life * 0.8;
      const fade = Math.sin(Math.PI * Math.min(1, life * 1.02)) * (1 - life * 0.5);
      steamColours[i * 3] = 0.72 * fade; steamColours[i * 3 + 1] = 0.7 * fade; steamColours[i * 3 + 2] = 0.95 * fade;
    }
    steamGeometry.attributes.position.needsUpdate = true;
    steamGeometry.attributes.color.needsUpdate = true;
  });

  const lit = sunlitFromBoxes(TO_MOON, [
    new THREE.Box3(new THREE.Vector3(-15.2, 0, sideFrom), new THREE.Vector3(-9.54, PLANT_TOP + 2.5, sideTo)),
    new THREE.Box3(new THREE.Vector3(9.54, 0, sideFrom), new THREE.Vector3(9.8, SCREEN_TOP, sideTo)),
    new THREE.Box3(new THREE.Vector3(10.9, boardLow, boardZ - boardRun / 2), new THREE.Vector3(11.1, boardHigh, boardZ + boardRun / 2)),
    new THREE.Box3(new THREE.Vector3(-8.5, 0, -26.6), new THREE.Vector3(8.5, 5.2, -25.4)),
  ]);

  return kit.finish({
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
      sky: "/environment/rooftop_night-2k.hdr", skyIntensity: 1.1, skyRotation: 0, skyClamp: 12,
      background: 0x1a1430, fog: 0x1b1630, fogDensity: high ? 0.0075 : 0.01,
      haze: new THREE.Color(0.02, 0.016, 0.034), hazeDensity: 0.004, hazeCeiling: 12, hazeFade: 4,
      environmentIntensity: 1.15, exposure: 1.05, far: 260,
    },
    sunlitAt: lit,
    probeAt: new THREE.Vector3(0, 2.3, -9),
  });
}

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { brushedMetal, paintedSteel, pbrMaterial, steel, tile } from "../pbr";
import {
  BRAND, STRIKE_ORANGE, canvasTexture, crateGeometry, createKit, drumGeometry, hazardTexture, iBeam, jerseyBarrier, softBox, worldBox,
  type RangeEnvironment, type RangeOptions, type Transform,
} from "../kit";
import type { Glow } from "../volumetric";

// Core Hall: a sealed containment hall with the range laid out on its floor.
//
// Lighting model: the roof is a concrete slab cut by four luminous slots that
// span the hall. The key light is the cold flood falling through those slots,
// so the slot mullions, the bridge crane, the catwalks and the pipe runs print
// crisp shadows and stand as shafts in the haze. Beyond the control centre the
// hall runs on to the vessel, whose core seam breathes cyan into the air and
// across the sealed floor. Everything else is bounce from a probe of the room.

const WALL_X = 9.54;
const CONCRETE_X = 9.62;
const WAINSCOT = 4.6;
const CEILING = 13.6;
const BACK_Z = 9.7;
const END_Z = -47;
/** Luminous roof slots: centre z of each, and their half extents. */
const SLOTS = [5, -7, -19, -32];
const SLOT_HALF = { x: 9, z: 2 };
/** Direction from the floor up to the flood lamps. */
const TO_LAMP = new THREE.Vector3(0.06, 1, 0.2).normalize();
const CORE = { x: 0, z: -39, radius: 4.6, base: 2.6, top: 10.2 };
const CORE_CYAN = new THREE.Color(0.1, 0.78, 1);
const CRANE_Z = -9.5;

type V3 = [number, number, number];

function scaleUv<T extends THREE.BufferGeometry>(geometry: T, u: number, v: number): T {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
  return geometry;
}

/** Board-marked concrete, 4.8 m square: 2.4 x 1.2 m shutter panels, tie holes, pour lines and run-off. */
function formworkTexture() {
  return canvasTexture(1024, 1024, (context) => {
    let seed = 4177;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const panelW = 512, panelH = 256;
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 2; column += 1) {
      const tone = 150 + Math.round(next() * 26);
      context.fillStyle = `rgb(${tone - 5},${tone + 1},${tone + 2})`;
      context.fillRect(column * panelW, row * panelH, panelW, panelH);
    }
    // Mottle and pour lines.
    for (let i = 0; i < 2600; i += 1) {
      const shade = next() > 0.5 ? 255 : 0, size = 6 + next() * 46;
      context.fillStyle = `rgba(${shade},${shade},${shade},${0.012 + next() * 0.022})`;
      context.beginPath(); context.ellipse(next() * 1024, next() * 1024, size * 1.8, size * 0.6, 0, 0, Math.PI * 2); context.fill();
    }
    for (let i = 0; i < 9000; i += 1) {
      const shade = next() > 0.6 ? 235 : 30;
      context.fillStyle = `rgba(${shade},${shade},${shade},.07)`;
      context.fillRect(next() * 1024, next() * 1024, 1 + next() * 2, 1 + next() * 2);
    }
    // Run-off stains falling from the panel joints.
    for (let i = 0; i < 46; i += 1) {
      const x = next() * 1024, y = Math.floor(next() * 4) * panelH, length = 40 + next() * 170, width = 2 + next() * 9;
      const gradient = context.createLinearGradient(0, y, 0, y + length);
      gradient.addColorStop(0, `rgba(30,36,36,${0.1 + next() * 0.14})`);
      gradient.addColorStop(1, "rgba(30,36,36,0)");
      context.fillStyle = gradient;
      context.fillRect(x, y, width, length);
    }
    // Shutter joints: a dark arris with a light fin beside it.
    for (let row = 0; row < 4; row += 1) {
      context.fillStyle = "rgba(24,28,28,.62)"; context.fillRect(0, row * panelH, 1024, 3);
      context.fillStyle = "rgba(235,240,240,.2)"; context.fillRect(0, row * panelH + 3, 1024, 2);
    }
    for (let column = 0; column < 2; column += 1) {
      context.fillStyle = "rgba(24,28,28,.62)"; context.fillRect(column * panelW, 0, 3, 1024);
      context.fillStyle = "rgba(235,240,240,.2)"; context.fillRect(column * panelW + 3, 0, 2, 1024);
    }
    // Tie holes, two per panel, each with a faint weep below.
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const x = 128 + column * 256, y = row * panelH + 128;
      const weep = context.createLinearGradient(0, y, 0, y + 90);
      weep.addColorStop(0, "rgba(40,44,44,.22)"); weep.addColorStop(1, "rgba(40,44,44,0)");
      context.fillStyle = weep; context.fillRect(x - 4, y, 8, 90);
      context.fillStyle = "rgba(225,230,230,.25)"; context.beginPath(); context.arc(x, y + 1.5, 9.5, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#1b1f1f"; context.beginPath(); context.arc(x, y, 7.5, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#34393a"; context.beginPath(); context.arc(x, y + 2, 4.5, 0, Math.PI * 2); context.fill();
    }
  }, true);
}

/** Bar grating with see-through cells; dense enough to stay solid when minified. */
function gratingTexture() {
  return canvasTexture(64, 64, (context) => {
    context.clearRect(0, 0, 64, 64);
    for (let i = 0; i < 4; i += 1) {
      context.fillStyle = "#3d4648"; context.fillRect(i * 16, 0, 7, 64);
      context.fillStyle = "#59666a"; context.fillRect(i * 16 + 1, 0, 2, 64);
    }
    context.fillStyle = "#333b3d";
    for (let i = 0; i < 2; i += 1) context.fillRect(0, i * 32, 64, 5);
  }, true);
}

/** Worn stencil paint on a clear ground. */
function stencilTexture(width: number, height: number, colour: string, lines: Array<{ text: string; size: number; y: number; x?: number; align?: CanvasTextAlign }>, wear = 0.3) {
  const texture = canvasTexture(width, height, (context) => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = colour;
    context.textBaseline = "middle";
    for (const line of lines) {
      context.font = `900 ${line.size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
      context.textAlign = line.align ?? "center";
      context.fillText(line.text, line.x ?? width / 2, line.y);
    }
    // Stencil bridges, then scuffing.
    context.globalCompositeOperation = "destination-out";
    let seed = width * 31 + height;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < width * height * wear * 0.012; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.25 + next() * 0.6})`;
      context.fillRect(next() * width, next() * height, 1 + next() * 5, 1 + next() * 2);
    }
    for (let i = 0; i < 60 * wear; i += 1) {
      context.fillStyle = `rgba(0,0,0,${0.15 + next() * 0.3})`;
      context.beginPath(); context.ellipse(next() * width, next() * height, 6 + next() * 30, 3 + next() * 12, next() * 3, 0, Math.PI * 2); context.fill();
    }
    context.globalCompositeOperation = "source-over";
  });
  return texture;
}

/** Prismatic diffuser cells for the roof slots. */
function diffuserTexture() {
  return canvasTexture(512, 128, (context) => {
    let seed = 913;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let column = 0; column < 16; column += 1) for (let row = 0; row < 4; row += 1) {
      const tone = 214 + Math.round(next() * 41);
      context.fillStyle = `rgb(${tone - 22},${tone - 6},${tone})`;
      context.fillRect(column * 32, row * 32, 32, 32);
    }
    context.fillStyle = "rgba(60,80,90,.55)";
    for (let column = 0; column <= 16; column += 1) context.fillRect(column * 32 - 1, 0, 2, 128);
    for (let row = 0; row <= 4; row += 1) context.fillRect(0, row * 32 - 1, 512, 2);
  });
}

/** Handwheel on a stem: wheel in the YZ plane at the origin, stem running back along -x. */
function valveWheelGeometry(radius: number) {
  const rim = new THREE.TorusGeometry(radius, radius * 0.11, 8, 28);
  rim.rotateY(Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [rim];
  for (let i = 0; i < 3; i += 1) {
    const spoke = new THREE.BoxGeometry(radius * 0.12, radius * 2, radius * 0.12);
    spoke.rotateX(i * Math.PI / 3);
    parts.push(spoke);
  }
  const stem = new THREE.CylinderGeometry(radius * 0.14, radius * 0.14, radius * 1.7, 10);
  stem.rotateZ(Math.PI / 2);
  stem.translate(-radius * 0.85, 0, 0);
  parts.push(stem);
  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  return merged;
}

/** Shielded transfer cask standing on y = 0. */
function caskGeometry() {
  const profile = [
    [0, 0], [0.6, 0], [0.64, 0.04], [0.64, 0.2], [0.58, 0.24], [0.58, 0.5], [0.62, 0.53], [0.62, 0.6], [0.58, 0.63],
    [0.58, 1.1], [0.62, 1.13], [0.62, 1.2], [0.58, 1.23], [0.58, 1.44], [0.66, 1.48], [0.66, 1.62], [0.6, 1.66], [0.24, 1.68], [0.22, 1.74], [0, 1.74],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return scaleUv(new THREE.LatheGeometry(profile, 36), 3, 2);
}

export function buildReactor(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, keep, track, photoSet, place, instances } = kit;
  const metals = kit.metals();
  const at = (x: number, y: number, z: number, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): Transform => ({ position: [x, y, z], rotation, scale });
  const sides = [-1, 1];

  // ---- Materials -----------------------------------------------------------
  const slab = photoSet("/textures/concrete_floor_worn_001-2k", 40 / 4.2, 66 / 4.2);
  const cast = photoSet("/textures/concrete_floor_worn_001-2k", 2, 2);
  const formwork = track(formworkTexture());
  formwork.anisotropy = anisotropy;
  const concreteMaterial = (color: number, envMapIntensity = 0.5) => new THREE.MeshStandardMaterial({
    map: formwork, normalMap: cast.normalMap, roughnessMap: cast.roughnessMap, aoMap: cast.aoMap,
    normalScale: new THREE.Vector2(0.8, 0.8), color, roughness: 0.95, metalness: 0, aoMapIntensity: 0.7, envMapIntensity,
  });
  const concrete = concreteMaterial(0xc4cbca);
  const roofConcrete = concreteMaterial(0x9aa3a3, 0.4);
  const shieldConcrete = concreteMaterial(0xb3bcbb, 0.55);

  const wainscot = pbrMaterial(keep(paintedSteel(anisotropy, [0.075, 0.105, 0.12], 611, 0.35)), { envMapIntensity: 0.9 });
  const cranePaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.52, 0.31, 0.03], 621, 0.42)), { envMapIntensity: 0.85 });
  const vesselPaint = pbrMaterial(keep(tile(paintedSteel(anisotropy, [0.36, 0.44, 0.45], 631, 0.3), 10, 3)), { envMapIntensity: 1 });
  const tealPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.035, 0.3, 0.3], 641, 0.4, 512)), { envMapIntensity: 1 });
  const amberPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.66, 0.3, 0.04], 651, 0.4, 512)), { envMapIntensity: 1 });
  const greyPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.33, 0.37, 0.38], 661, 0.45, 512)), { envMapIntensity: 1 });
  const drumPaint = pbrMaterial(keep(paintedSteel(anisotropy, [0.62, 0.44, 0.05], 671, 0.7, 512)), { envMapIntensity: 1 });
  const lead = pbrMaterial(keep(steel(anisotropy, [0.2, 0.215, 0.24], 0.52, 83, 256)), { envMapIntensity: 0.9 });
  const insulation = pbrMaterial(keep(tile(brushedMetal(anisotropy, [0.56, 0.6, 0.62], 91), 6, 3)), { envMapIntensity: 1.1 });
  const cable = new THREE.MeshStandardMaterial({ color: 0x0b0d0f, roughness: 0.55, metalness: 0 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.8, metalness: 0 });

  const hazard = track(hazardTexture());
  hazard.anisotropy = anisotropy;
  const hazardCopy = (x: number, y: number, wrapT = false) => {
    const copy = track(hazard.clone());
    copy.needsUpdate = true;
    if (wrapT) copy.wrapT = THREE.RepeatWrapping;
    copy.repeat.set(x, y);
    return copy;
  };
  const hazardMaterial = (x: number, y: number, wrapT = false) => new THREE.MeshStandardMaterial({ map: hazardCopy(x, y, wrapT), roughness: 0.45, metalness: 0, envMapIntensity: 0.8 });

  const glowWhite = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xdcefff).multiplyScalar(3), toneMapped: false });
  const ledAmber = new THREE.MeshBasicMaterial({ color: new THREE.Color(STRIKE_ORANGE).multiplyScalar(2.4), toneMapped: false });
  const ledMint = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(2.2), toneMapped: false });
  const coreGlow = new THREE.MeshBasicMaterial({ color: CORE_CYAN.clone().multiplyScalar(3), toneMapped: false });
  const portGlow = new THREE.MeshBasicMaterial({ color: CORE_CYAN.clone().multiplyScalar(3), toneMapped: false });
  const decal = (map: THREE.Texture, color = 0xffffff, opacity = 0.8) => {
    map.anisotropy = anisotropy;
    return new THREE.MeshStandardMaterial({ map, color, transparent: true, opacity, roughness: 0.8, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 0.6 });
  };

  // ---- Floor ---------------------------------------------------------------
  const floorMaterial = new THREE.MeshStandardMaterial({
    ...slab, normalScale: new THREE.Vector2(0.9, 0.9), color: 0x8c9ea3, roughness: 0.74, metalness: 0, aoMapIntensity: 0.8, envMapIntensity: 0.5,
  });
  const reflection = kit.floor(floorMaterial, { width: 40, depth: 66, z: -18.5 }, {
    lane: new THREE.Color(BRAND).multiplyScalar(0.62),
    edge: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.8),
    markings: 1,
    wet: 0.02,
  });

  // ---- Shell ---------------------------------------------------------------
  const hallLength = BACK_Z - END_Z, hallMid = (BACK_Z + END_Z) / 2;
  for (const side of sides) {
    place(new THREE.Mesh(worldBox(0.6, CEILING, hallLength + 1.2, 4.8), concrete), side * (CONCRETE_X + 0.3), CEILING / 2, hallMid, false, true);
    // Painted steel wainscot: the flat face the range signs hang on.
    place(new THREE.Mesh(worldBox(0.08, WAINSCOT, hallLength, 2.4), wainscot), side * (WALL_X + 0.04), WAINSCOT / 2, hallMid, false, true);
    place(new THREE.Mesh(softBox(0.16, 0.1, hallLength, 0.02, 1.4), metals.structural), side * (WALL_X + 0.02), WAINSCOT + 0.03, hallMid, false);
    place(new THREE.Mesh(softBox(0.3, 0.32, hallLength, 0.03, 2.2), shieldConcrete), side * 9.48, 0.16, hallMid, false, true);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.13, 37), hazardMaterial(37 / 0.52, 1)), side * (WALL_X - 0.003), 4.42, -9.5, false);
    place(new THREE.Mesh(worldBox(0.06, 0.08, hallLength, 1.4), metals.darkMetal), side * 9.5, 0.44, hallMid, false);
    place(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, hallLength), side < 0 ? ledAmber : ledMint), side * 9.47, 0.44, hallMid, false);
  }
  // Cover strips over the wainscot sheet joints.
  instances(worldBox(0.01, WAINSCOT - 0.36, 0.05, 1.4), metals.structural, sides.flatMap((side) => Array.from({ length: 24 }, (_, i) => at(side * (WALL_X - 0.004), WAINSCOT / 2 + 0.16, 8.5 - i * 2.4))), false, false);
  place(new THREE.Mesh(worldBox(20.4, CEILING, 0.6, 4.8), concrete), 0, CEILING / 2, BACK_Z + 0.3, false, true);
  place(new THREE.Mesh(worldBox(20.4, CEILING, 0.6, 4.8), concrete), 0, CEILING / 2, END_Z - 0.3, false, true);
  place(new THREE.Mesh(worldBox(19.1, WAINSCOT, 0.08, 2.4), wainscot), 0, WAINSCOT / 2, END_Z + 0.04, false, true);

  // Pilasters carry the crane rails; they start above the wainscot so the sign wall stays flat.
  const pilasterZ = [9, -3, -15, -27, -39];
  instances(softBox(0.4, CEILING - WAINSCOT - 0.08, 0.9, 0.04, 4.8), concrete, pilasterZ.flatMap((z) => sides.map((side) => at(side * 9.46, (CEILING + WAINSCOT + 0.08) / 2, z))), false, false);
  instances(softBox(0.86, 0.5, 0.9, 0.04, 4.8), concrete, pilasterZ.flatMap((z) => sides.map((side) => at(side * 9.22, 9.55, z))), false);

  // ---- Roof ----------------------------------------------------------------
  const roofZ0 = END_Z - 0.6, roofZ1 = BACK_Z + 0.6;
  const roofSpans: Array<[number, number]> = [];
  let cursor = roofZ1;
  for (const z of SLOTS) { roofSpans.push([z + SLOT_HALF.z, cursor]); cursor = z - SLOT_HALF.z; }
  roofSpans.push([roofZ0, cursor]);
  roofSpans.forEach(([from, to]) => place(new THREE.Mesh(worldBox(SLOT_HALF.x * 2, 0.4, to - from, 4.8), roofConcrete), 0, CEILING + 0.2, (from + to) / 2, true));
  for (const side of sides) place(new THREE.Mesh(worldBox(1.4, 0.4, roofZ1 - roofZ0, 4.8), roofConcrete), side * (SLOT_HALF.x + 0.7), CEILING + 0.2, (roofZ0 + roofZ1) / 2, true);
  // Downstand beams frame every slot; lighter ones break up the long panels.
  instances(softBox(19.3, 0.9, 0.5, 0.03, 4.8), roofConcrete, [...SLOTS.flatMap((z) => [z - 2.3, z + 2.3]), -38.4, -43.2].map((z) => at(0, CEILING - 0.45, z)), false);
  instances(softBox(0.36, 0.5, 7.4, 0.03, 4.8), roofConcrete, [-1, -13, -25.5].flatMap((z) => [-6, 0, 6].map((x) => at(x, CEILING - 0.25, z))), false, false);
  // Slots: a luminous diffuser set back in an upstand, with mullions that print the light.
  const diffuser = track(diffuserTexture());
  diffuser.anisotropy = anisotropy;
  const diffuserMaterial = new THREE.MeshBasicMaterial({ map: diffuser, color: new THREE.Color(0xdcefff).multiplyScalar(2), toneMapped: false });
  const wellMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xb9d3e2).multiplyScalar(0.85), side: THREE.BackSide, toneMapped: false });
  const diffuserGeometry = new THREE.PlaneGeometry(SLOT_HALF.x * 2, SLOT_HALF.z * 2);
  diffuserGeometry.rotateX(Math.PI / 2);
  SLOTS.forEach((z) => {
    place(new THREE.Mesh(diffuserGeometry, diffuserMaterial), 0, CEILING + 1.0, z, false).receiveShadow = false;
    place(new THREE.Mesh(new THREE.BoxGeometry(SLOT_HALF.x * 2, 1.02, SLOT_HALF.z * 2), wellMaterial), 0, CEILING + 0.5, z, false).receiveShadow = false;
  });
  instances(worldBox(0.11, 0.16, SLOT_HALF.z * 2, 1.4), metals.structural, SLOTS.flatMap((z) => [-6.75, -4.5, -2.25, 0, 2.25, 4.5, 6.75].map((x) => at(x, CEILING + 0.06, z))), false);
  instances(worldBox(SLOT_HALF.x * 2, 0.16, 0.11, 1.4), metals.structural, SLOTS.map((z) => at(0, CEILING + 0.06, z)), false);

  // ---- Bridge crane --------------------------------------------------------
  const railRun = hallLength - 0.6;
  instances(iBeam(0.34, 0.55, railRun, 0.05, 0.03), metals.structural, sides.map((side) => at(side * 9.02, 10.075, END_Z + 0.3, [Math.PI / 2, 0, 0])), false);
  instances(worldBox(0.07, 0.08, railRun, 1.4), metals.darkMetal, sides.map((side) => at(side * 9.02, 10.39, hallMid)), false, false);
  instances(softBox(0.56, 0.5, 3.8, 0.04, 1.6), cranePaint, sides.map((side) => at(side * 9.02, 10.72, CRANE_Z)), false);
  const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 20);
  wheel.rotateZ(Math.PI / 2);
  instances(wheel, metals.darkMetal, sides.flatMap((side) => [-1.5, 1.5].map((o) => at(side * 9.02, 10.62, CRANE_Z + o, [0, 0, 0], [5.2, 1, 1]))), false, false);
  instances(softBox(17.7, 1.0, 0.48, 0.03, 1.8), cranePaint, [-1, 1].map((o) => at(0, 11.0, CRANE_Z + o)), false);
  // Hazard ends on the girders, facing down the range.
  const chevrons = hazardMaterial(2, 1);
  instances(new THREE.BoxGeometry(1.3, 0.96, 0.012), chevrons, sides.flatMap((side) => [1.245, -1.245].map((o) => at(side * 8.1, 11.0, CRANE_Z + o))), false, false);
  const plate = track(stencilTexture(512, 128, "#101214", [{ text: "SWL 40 t", size: 92, y: 50 }, { text: "BRIDGE 2  ·  KEEP CLEAR OF THE HOOK PATH", size: 26, y: 108 }], 0.18));
  const plateMesh = place(new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), decal(plate, 0xffffff, 0.9)), 3.2, 11.0, CRANE_Z + 1.246, false);
  plateMesh.receiveShadow = false;
  // Trolley, hoist drum, falls and hook block.
  const hookX = -2.6;
  place(new THREE.Mesh(softBox(2.3, 0.4, 2.7, 0.04, 1.6), metals.machine), hookX, 11.72, CRANE_Z, true);
  place(new THREE.Mesh(softBox(0.9, 0.62, 0.8, 0.04, 1.6), greyPaint), hookX + 0.5, 12.2, CRANE_Z - 0.6, true);
  const hoistDrum = new THREE.CylinderGeometry(0.34, 0.34, 1.5, 24);
  hoistDrum.rotateZ(Math.PI / 2);
  place(new THREE.Mesh(scaleUv(hoistDrum, 3, 2), metals.brushed), hookX, 11.3, CRANE_Z, true);
  const blockY = 7.5;
  instances(new THREE.CylinderGeometry(0.014, 0.014, 11.2 - blockY - 0.3, 6), cable, [[-0.2, -0.1], [0.2, -0.1], [-0.2, 0.1], [0.2, 0.1]].map(([x, z]) => at(hookX + x, (11.2 + blockY + 0.3) / 2, CRANE_Z + z)), false);
  place(new THREE.Mesh(softBox(0.66, 0.74, 0.3, 0.05, 1), cranePaint), hookX, blockY, CRANE_Z, true);
  const sheave = new THREE.CylinderGeometry(0.27, 0.27, 0.38, 24);
  sheave.rotateX(Math.PI / 2);
  place(new THREE.Mesh(sheave, metals.darkMetal), hookX, blockY + 0.06, CRANE_Z, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.34, 10), metals.darkMetal), hookX, blockY - 0.5, CRANE_Z, true);
  const hook = place(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.055, 10, 24, Math.PI * 1.45), metals.darkMetal), hookX, blockY - 0.84, CRANE_Z, true);
  hook.rotation.z = Math.PI * 0.82;
  // Festoon track with its loops of flat cable.
  place(new THREE.Mesh(worldBox(17.4, 0.05, 0.05, 1.4), metals.darkMetal), 0, 11.66, CRANE_Z + 1.36, false);
  instances(new THREE.TorusGeometry(0.3, 0.02, 6, 14, Math.PI), rubber, Array.from({ length: 17 }, (_, i) => at(hookX + 0.9 + i * 0.6, 11.62, CRANE_Z + 1.36, [Math.PI, 0, 0], [1, 1 + (i % 3) * 0.25, 1])), false);

  // ---- Catwalks ------------------------------------------------------------
  const walkFrom = -28.6, walkTo = 9.6, walkRun = walkTo - walkFrom, walkMid = (walkFrom + walkTo) / 2, deckY = 5.3;
  const grating = track(gratingTexture());
  grating.repeat.set(7, walkRun / 0.2);
  grating.anisotropy = anisotropy;
  const gratingMaterial = new THREE.MeshStandardMaterial({ map: grating, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.9 });
  const deckGeometry = new THREE.PlaneGeometry(1.4, walkRun);
  deckGeometry.rotateX(-Math.PI / 2);
  instances(deckGeometry, gratingMaterial, sides.map((side) => at(side * 8.85, deckY, walkMid)), false);
  instances(worldBox(0.07, 0.2, walkRun, 1.4), metals.structural, sides.flatMap((side) => [8.17, 9.5].map((x) => at(side * x, deckY - 0.1, walkMid))), false);
  const bracketZ = Array.from({ length: 13 }, (_, i) => 8 - i * 3);
  instances(worldBox(1.38, 0.1, 0.08, 1.4), metals.structural, bracketZ.flatMap((z) => sides.map((side) => at(side * 8.85, deckY - 0.25, z))), false);
  const strut = Math.atan2(0.36, 1.25);
  instances(worldBox(Math.hypot(1.25, 0.36), 0.07, 0.07, 1.4), metals.structural, bracketZ.flatMap((z) => sides.map((side) => at(side * 8.9, deckY - 0.46, z, [0, 0, -side * strut]))), false);
  const postZ = Array.from({ length: 26 }, (_, i) => walkTo - 0.35 - i * 1.5);
  instances(new THREE.CylinderGeometry(0.022, 0.022, 1.1, 8), metals.brushed, postZ.flatMap((z) => sides.map((side) => at(side * 8.17, deckY + 0.55, z))), false);
  const handrail = new THREE.CylinderGeometry(0.024, 0.024, walkRun, 8);
  handrail.rotateX(Math.PI / 2);
  instances(scaleUv(handrail, 1, 30), metals.brushed, sides.flatMap((side) => [1.1, 0.6].map((y) => at(side * 8.17, deckY + y, walkMid))), false);
  instances(worldBox(0.012, 0.12, walkRun, 1.4), metals.structural, sides.map((side) => at(side * 8.15, deckY + 0.07, walkMid)), false, false);
  // Wall-wash tubes under the decks light the wainscot.
  const washZ = bracketZ.slice(0, -1).map((z) => z - 1.5);
  const washTube = new THREE.CylinderGeometry(0.024, 0.024, 2.3, 8);
  washTube.rotateX(Math.PI / 2);
  instances(washTube, glowWhite, washZ.flatMap((z) => sides.map((side) => at(side * 9.3, deckY - 0.33, z))), false, false);
  instances(softBox(0.16, 0.06, 2.44, 0.015, 1.4), metals.darkMetal, washZ.flatMap((z) => sides.map((side) => at(side * 9.3, deckY - 0.26, z))), false, false);

  // ---- Services ------------------------------------------------------------
  // Cable trays on arms from the pilasters.
  const trayY = 7.5, trayX = 8.7, trayRun = hallLength - 0.4;
  instances(worldBox(0.03, 0.1, trayRun, 1.4), metals.brushed, sides.flatMap((side) => [-0.2, 0.2].map((o) => at(side * trayX + o, trayY, hallMid))), false);
  instances(worldBox(0.4, 0.02, 0.04, 1.4), metals.brushed, sides.flatMap((side) => Array.from({ length: 94 }, (_, i) => at(side * trayX, trayY - 0.03, BACK_Z - 0.5 - i * 0.6))), false, false);
  const trayCable = new THREE.CylinderGeometry(0.03, 0.03, trayRun, 8);
  trayCable.rotateX(Math.PI / 2);
  instances(trayCable, cable, sides.flatMap((side) => [-0.12, -0.04, 0.05, 0.13].map((o, i) => at(side * trayX + o, trayY + 0.012, hallMid, [0, 0, 0], [1 - (i % 2) * 0.3, 1 - (i % 2) * 0.3, 1]))), false, false);
  instances(worldBox(1.0, 0.07, 0.07, 1.4), metals.structural, pilasterZ.flatMap((z) => sides.map((side) => at(side * 8.95, trayY - 0.09, z))), false, false);
  // Process mains above the trays, colour-coded: teal feed, amber return, grey service.
  const mainFrom = -39.8, mainTo = 9.5, mainRun = mainTo - mainFrom, mainMid = (mainFrom + mainTo) / 2;
  const mains: Array<{ x: number; y: number; radius: number; material: THREE.Material }> = [
    { x: -8.95, y: 8.2, radius: 0.26, material: tealPaint }, { x: -8.95, y: 8.86, radius: 0.22, material: amberPaint },
    { x: 8.52, y: 8.2, radius: 0.2, material: amberPaint }, { x: 8.52, y: 8.74, radius: 0.16, material: greyPaint },
  ];
  const flangeZ = Array.from({ length: 13 }, (_, i) => 7.6 - i * 3.9);
  mains.forEach(({ x, y, radius, material }) => {
    const pipe = new THREE.CylinderGeometry(radius, radius, mainRun, 20);
    pipe.rotateX(Math.PI / 2);
    place(new THREE.Mesh(scaleUv(pipe, 1, 28), material), x, y, mainMid, true);
    const flange = new THREE.CylinderGeometry(radius + 0.06, radius + 0.06, 0.09, 20);
    flange.rotateX(Math.PI / 2);
    instances(flange, metals.structural, [...flangeZ, mainFrom + 0.05].map((z) => at(x, y, z)), false);
  });
  instances(worldBox(0.9, 0.08, 0.12, 1.4), metals.structural, pilasterZ.slice(0, 4).flatMap((z) => [at(-9.0, 7.9, z + 0.3), at(9.0, 7.96, z + 0.3)]), false, false);
  instances(worldBox(0.05, 0.9, 0.1, 1.4), metals.structural, pilasterZ.slice(0, 4).flatMap((z) => [at(-8.6, 8.3, z + 0.3), at(8.25, 8.3, z + 0.3)]), false, false);
  // Risers against the walls with gate valves at hand height.
  const risers: Array<{ side: number; z: number; material: THREE.Material }> = [
    { side: -1, z: -2.3, material: tealPaint }, { side: -1, z: -1.6, material: amberPaint }, { side: -1, z: 7.0, material: greyPaint },
    { side: 1, z: -4.6, material: amberPaint }, { side: 1, z: -3.9, material: tealPaint }, { side: 1, z: 5.4, material: greyPaint },
  ];
  const riserGeometry = scaleUv(new THREE.CylinderGeometry(0.13, 0.13, CEILING, 16), 1, 8);
  for (const material of [tealPaint, amberPaint, greyPaint]) {
    instances(riserGeometry, material, risers.filter((riser) => riser.material === material).map(({ side, z }) => at(side * 9.3, CEILING / 2, z)), false);
  }
  instances(new THREE.CylinderGeometry(0.19, 0.19, 0.07, 16), metals.structural, risers.flatMap(({ side, z }) => [0.035, 0.95, 1.55, 4.75, 9.2].map((y) => at(side * 9.3, y, z))), false, false);
  instances(softBox(0.34, 0.5, 0.34, 0.05, 1), metals.darkMetal, risers.map(({ side, z }) => at(side * 9.3, 1.25, z)), true, false);
  instances(valveWheelGeometry(0.17), new THREE.MeshStandardMaterial({ color: 0xb8301c, roughness: 0.45, metalness: 0.2, envMapIntensity: 0.9 }), risers.map(({ side, z }) => at(side * 8.86, 1.25, z, [0, side > 0 ? 0 : Math.PI, 0])), false);

  // ---- Reactor vessel ------------------------------------------------------
  const core = (x: number, y: number, z: number, rotation?: V3, scale?: V3) => at(CORE.x + x, y, CORE.z + z, rotation, scale);
  const ring = (count: number, radius: number, y: number, phase = 0, scale?: V3) => Array.from({ length: count }, (_, i) => {
    const angle = phase + (i / count) * Math.PI * 2;
    return core(Math.sin(angle) * radius, y, Math.cos(angle) * radius, [0, angle, 0], scale);
  });
  place(new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(6.1, 6.4, CORE.base, 72), 8, CORE.base / 4.8), shieldConcrete), CORE.x, CORE.base / 2, CORE.z, true, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(6.16, 6.16, 0.12, 72), metals.structural), CORE.x, CORE.base + 0.02, CORE.z, false);
  const shieldBand = place(new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.24, 0.3, 72, 1, true), hazardMaterial(60, 1)), CORE.x, CORE.base - 0.42, CORE.z, false);
  shieldBand.receiveShadow = true;
  const shellHeight = CORE.top - CORE.base;
  place(new THREE.Mesh(new THREE.CylinderGeometry(CORE.radius, CORE.radius, shellHeight, 72, 1, true), vesselPaint), CORE.x, CORE.base + shellHeight / 2, CORE.z, true, true);
  const dome = new THREE.SphereGeometry(CORE.radius, 64, 20, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.5, 1);
  place(new THREE.Mesh(dome, vesselPaint), CORE.x, CORE.top, CORE.z, true);
  // Girth flanges, with the core seam held open between the upper pair.
  const seamY = 8.6;
  instances(new THREE.CylinderGeometry(CORE.radius + 0.2, CORE.radius + 0.2, 0.22, 72), metals.structural, [3.0, 5.7, seamY - 0.3, seamY + 0.3, CORE.top - 0.06].map((y) => core(0, y, 0)), false);
  place(new THREE.Mesh(new THREE.CylinderGeometry(CORE.radius + 0.05, CORE.radius + 0.05, 0.4, 72, 1, true), coreGlow), CORE.x, seamY, CORE.z, false).receiveShadow = false;
  instances(softBox(0.16, 0.42, 0.26, 0.02, 1), metals.darkMetal, ring(36, CORE.radius + 0.13, seamY), false, false);
  const stud = new THREE.CylinderGeometry(0.04, 0.04, 0.95, 6);
  instances(stud, metals.brushed, ring(72, CORE.radius + 0.14, seamY, 0.04), false, false);
  // Stiffening ribs in two tiers, with the view ports between the upper ones.
  instances(softBox(0.16, 2.36, 0.36, 0.03, 1.6), vesselPaint, ring(28, CORE.radius + 0.14, 4.35), false);
  instances(softBox(0.16, 2.26, 0.36, 0.03, 1.6), vesselPaint, ring(14, CORE.radius + 0.14, 7.0, Math.PI / 14), false);
  const portRim = new THREE.CylinderGeometry(0.6, 0.66, 0.34, 28);
  portRim.rotateX(Math.PI / 2);
  instances(portRim, metals.darkMetal, ring(14, CORE.radius + 0.08, 6.95), false);
  const portLens = new THREE.CylinderGeometry(0.44, 0.44, 0.06, 28);
  portLens.rotateX(Math.PI / 2);
  instances(portLens, portGlow, ring(14, CORE.radius + 0.24, 6.95), false, false);
  const portBolt = new THREE.CylinderGeometry(0.035, 0.035, 0.06, 6);
  portBolt.rotateX(Math.PI / 2);
  instances(portBolt, metals.brushed, ring(14, CORE.radius + 0.27, 6.95).flatMap((port) => Array.from({ length: 10 }, (_, i) => {
    const turn = (i / 10) * Math.PI * 2, yaw = port.rotation![1];
    return at(port.position[0] + Math.cos(yaw) * Math.cos(turn) * 0.54, 6.95 + Math.sin(turn) * 0.54, port.position[2] - Math.sin(yaw) * Math.cos(turn) * 0.54, [0, yaw, 0]);
  })), false, false);
  // Head: drive housings around a central stack that passes through the roof.
  place(new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.15, CEILING - 12.1, 32), metals.machine), CORE.x, (CEILING + 12.1) / 2, CORE.z, true);
  place(new THREE.Mesh(new THREE.CylinderGeometry(1.32, 1.32, 0.16, 32), metals.structural), CORE.x, 12.62, CORE.z, false);
  instances(new THREE.CylinderGeometry(0.12, 0.14, 1.1, 12), metals.brushed, ring(12, 2.7, 12.5), false);
  instances(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), metals.darkMetal, ring(12, 2.7, 12.02), false, false);
  // Unit number stencilled across the upper shell.
  const unitMap = track(stencilTexture(1024, 256, "#e9f1f0", [{ text: "U-04", size: 230, y: 136 }], 0.34));
  unitMap.anisotropy = anisotropy;
  const unitArc = 1.0;
  const unit = place(new THREE.Mesh(new THREE.CylinderGeometry(CORE.radius + 0.012, CORE.radius + 0.012, unitArc * CORE.radius / 4, 32, 1, true, -unitArc / 2, unitArc), decal(unitMap, 0xffffff, 0.85)), CORE.x, 9.5, CORE.z, false);
  unit.renderOrder = 1;
  // Service gallery rail around the top of the shield.
  const galleryRail = new THREE.TorusGeometry(5.86, 0.026, 8, 96);
  galleryRail.rotateX(Math.PI / 2);
  instances(galleryRail, metals.brushed, [3.15, 3.7].map((y) => core(0, y, 0)), false);
  instances(new THREE.CylinderGeometry(0.024, 0.024, 1.1, 8), metals.brushed, ring(40, 5.86, 3.15), false);
  // Exchanger towers either side, tied to the vessel by the loop pipes.
  const pipeBetween = (from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material, joints = true) => {
    const length = from.distanceTo(to);
    const mesh = new THREE.Mesh(scaleUv(new THREE.CylinderGeometry(radius, radius, length, 24), 2, Math.max(1, length / 2)), material);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    if (joints) for (const t of [0.22, 0.78]) {
      const flange = new THREE.Mesh(new THREE.CylinderGeometry(radius + 0.08, radius + 0.08, 0.1, 24), metals.structural);
      flange.position.copy(from).lerp(to, t);
      flange.quaternion.copy(mesh.quaternion);
      flange.castShadow = true; flange.receiveShadow = true;
      scene.add(flange);
    }
    return mesh;
  };
  const towerX = 7.55, towerZ = CORE.z - 2.6;
  instances(scaleUv(new THREE.CapsuleGeometry(1.25, 7.1, 10, 36), 1, 1), insulation, sides.map((side) => at(side * towerX, 5.3, towerZ)), true);
  instances(new THREE.CylinderGeometry(1.12, 1.2, 1.1, 32), metals.darkMetal, sides.map((side) => at(side * towerX, 0.55, towerZ)), false);
  instances(new THREE.CylinderGeometry(1.29, 1.29, 0.09, 36), metals.structural, sides.flatMap((side) => [2.1, 4.4, 6.7, 8.6].map((y) => at(side * towerX, y, towerZ))), false, false);
  for (const side of sides) {
    const hot = side < 0 ? amberPaint : tealPaint, cold = side < 0 ? tealPaint : amberPaint;
    pipeBetween(new THREE.Vector3(side * 4.2, 9.45, CORE.z - 1.5), new THREE.Vector3(side * 6.6, 9.45, towerZ + 0.1), 0.42, hot);
    pipeBetween(new THREE.Vector3(side * 4.2, 4.3, CORE.z - 1.5), new THREE.Vector3(side * 6.6, 4.3, towerZ + 0.1), 0.42, cold);
    // Mains leave the towers for the hall walls.
    const main = mains.filter((entry) => Math.sign(entry.x) === side);
    main.forEach((entry, index) => pipeBetween(new THREE.Vector3(entry.x, entry.y, mainFrom + 0.02), new THREE.Vector3(side * (towerX + 0.5), entry.y - 0.25 - index * 0.3, towerZ + 0.5 + index * 0.3), entry.radius, entry.material, false));
  }
  // Rail and floor band closing the range off from the vessel floor.
  const fenceZ = -29.6;
  instances(new THREE.CylinderGeometry(0.028, 0.028, 1.1, 8), metals.brushed, Array.from({ length: 11 }, (_, i) => at(-9.2 + i * 1.84, 0.55, fenceZ)), false);
  const crossRail = new THREE.CylinderGeometry(0.026, 0.026, 18.5, 8);
  crossRail.rotateZ(Math.PI / 2);
  instances(scaleUv(crossRail, 1, 14), metals.brushed, [1.08, 0.58].map((y) => at(0, y, fenceZ)), false);
  const floorBand = new THREE.PlaneGeometry(18.6, 0.5);
  floorBand.rotateX(-Math.PI / 2);
  const band = place(new THREE.Mesh(floorBand, new THREE.MeshStandardMaterial({ map: hazardCopy(18.6 / 2, 1), roughness: 0.6, metalness: 0, transparent: true, opacity: 0.82, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), 0, 0.006, fenceZ - 0.5, false);
  kit.mirrorHidden.push(band);

  // ---- Stencils ------------------------------------------------------------
  const bayZ = [3, -9, -21, -33];
  bayZ.forEach((z, index) => {
    const map = track(stencilTexture(512, 512, "#dfe8e7", [{ text: `0${index + 1}`, size: 330, y: 220 }, { text: `BAY ${"ABCD"[index]}  ·  +10.4 m`, size: 46, y: 448 }], 0.45));
    const material = decal(map, 0xffffff, 0.62);
    for (const side of sides) {
      const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), material), side * (CONCRETE_X - 0.004), 11.9, z, false);
      mesh.rotation.y = -side * Math.PI / 2;
    }
  });
  const hallMap = track(stencilTexture(2048, 256, "#dfe8e7", [{ text: "CORE HALL", size: 210, y: 132, x: 60, align: "left" }, { text: "UNIT 04", size: 120, y: 96, x: 1990, align: "right" }, { text: "SEALED AREA  ·  DOSIMETER REQUIRED", size: 44, y: 206, x: 1990, align: "right" }], 0.4));
  const hallSign = place(new THREE.Mesh(new THREE.PlaneGeometry(13.6, 1.7), decal(hallMap, 0xffffff, 0.66)), 0, 9.6, BACK_Z - 0.004, false);
  hallSign.rotation.y = Math.PI;

  // ---- Beacons -------------------------------------------------------------
  const beaconSpots: V3[] = [
    [-7.4, 10.32, CRANE_Z + 1], [7.4, 10.32, CRANE_Z - 1], [-9.2, 1.2, fenceZ], [9.2, 1.2, fenceZ],
    [-8.17, deckY + 1.2, walkFrom + 0.4], [8.17, deckY + 1.2, walkFrom + 0.4], [-8.17, deckY + 1.2, walkTo - 0.35], [8.17, deckY + 1.2, walkTo - 0.35],
  ];
  instances(new THREE.CylinderGeometry(0.075, 0.085, 0.07, 14), metals.darkMetal, beaconSpots.map(([x, y, z]) => at(x, y - 0.075, z)), false, false);
  const beaconGeometry = new THREE.CylinderGeometry(0.06, 0.068, 0.13, 14);
  const beaconAmber = new THREE.Color(1, 0.5, 0.08);
  const beaconMaterials = [0, 1].map((phase) => {
    const material = new THREE.MeshBasicMaterial({ color: beaconAmber.clone(), toneMapped: false });
    instances(beaconGeometry, material, beaconSpots.filter((_, index) => index % 2 === phase).map(([x, y, z]) => at(x, y + 0.02, z)), false, false);
    return material;
  });

  // ---- Props ---------------------------------------------------------------
  // Hazard bollards mark the service strips along both walls.
  const bollardZ = Array.from({ length: 11 }, (_, i) => 8 - i * 3);
  const bollards = bollardZ.flatMap((z) => sides.filter((side) => !(side > 0 && z < -8.5 && z > -14.5)).map((side) => ({ x: side * 7.56, z })));
  instances(scaleUv(new THREE.CylinderGeometry(0.075, 0.075, 0.98, 16), 1, 1), hazardMaterial(1, 2.6, true), bollards.map(({ x, z }) => at(x, 0.49, z)));
  instances(new THREE.SphereGeometry(0.082, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), metals.darkMetal, bollards.map(({ x, z }) => at(x, 0.975, z)), false, false);
  instances(new THREE.CylinderGeometry(0.13, 0.14, 0.03, 16), metals.darkMetal, bollards.map(({ x, z }) => at(x, 0.015, z)), false, false);
  instances(jerseyBarrier(2.4), shieldConcrete, [at(-8.0, 0, 5.0, [0, Math.PI / 2 + 0.05, 0]), at(8.0, 0, -0.6, [0, Math.PI / 2 - 0.04, 0]), at(-8.05, 0, -25.4, [0, Math.PI / 2 - 0.06, 0])]);
  const crateSpots: V3[] = [[-8.2, 0.54, 2.3], [-8.28, 0.54, 1.1], [-8.24, 1.62, 1.7], [8.25, 0.54, -20.4], [8.2, 0.54, -21.65], [8.22, 1.62, -21.0]];
  instances(crateGeometry(1.08), metals.crate, crateSpots.map((position, index) => at(...position, [0, (index % 3 - 1) * 0.12 + (index % 2) * Math.PI / 2, 0])));
  const drumSpots: Array<[number, number]> = [[-8.5, 8.5], [-8.95, 7.95], [-8.4, -4.4], [-8.9, -5.0], [8.5, -7.3], [8.95, -6.7], [8.4, 3.4], [-8.7, -27.6], [8.6, -27.4]];
  instances(drumGeometry(), drumPaint, drumSpots.map(([x, z], index) => at(x, 0, z, [0, index * 1.3, 0])));
  instances(new THREE.CylinderGeometry(0.296, 0.296, 0.12, 28, 1, true), rubber, drumSpots.map(([x, z]) => at(x, 0.44, z)), false, false);
  // Pallet of lead bricks, the top course part used.
  const palletX = 8.3, palletZ = 1.9;
  place(new THREE.Mesh(softBox(1.2, 0.035, 1.0, 0.008, 1.1), metals.crate), palletX, 0.128, palletZ, true, true);
  instances(softBox(0.1, 0.11, 1.0, 0.008, 1.1), metals.crate, [-0.5, 0, 0.5].map((x) => at(palletX + x, 0.055, palletZ)), false);
  const bricks: Transform[] = [];
  for (let layer = 0; layer < 4; layer += 1) for (let i = 0; i < 5; i += 1) for (let j = 0; j < 8; j += 1) {
    if (layer === 3 && (i > 2 || (i === 2 && j > 4))) continue;
    const shift = layer % 2 ? 0.012 : -0.012;
    bricks.push(at(palletX - 0.42 + i * 0.21 + shift, 0.198 + layer * 0.102, palletZ - 0.37 + j * 0.106 - shift, [0, ((i * 7 + j * 3 + layer) % 5 - 2) * 0.006, 0]));
  }
  instances(softBox(0.2, 0.1, 0.1, 0.012, 0.6), lead, bricks, true);
  // Transfer cask on its cradle and a rack of gas bottles.
  place(new THREE.Mesh(caskGeometry(), insulation), -8.3, 0.12, -22.6, true, true);
  instances(softBox(1.5, 0.12, 0.2, 0.02, 1.2), cranePaint, [-0.45, 0.45].map((o) => at(-8.3, 0.06, -22.6 + o)), false);
  const trunnion = new THREE.CylinderGeometry(0.09, 0.09, 1.46, 14);
  trunnion.rotateX(Math.PI / 2);
  place(new THREE.Mesh(trunnion, metals.darkMetal), -8.3, 1.42, -22.6, true);
  const bottleProfile = [[0, 0], [0.11, 0], [0.115, 0.02], [0.115, 1.18], [0.09, 1.3], [0.045, 1.36], [0.045, 1.44], [0.06, 1.45], [0.06, 1.5], [0, 1.5]].map(([x, y]) => new THREE.Vector2(x, y));
  const bottle = new THREE.LatheGeometry(bottleProfile, 16);
  instances(bottle, tealPaint, [0, 2, 3].map((i) => at(-9.28, 0, -7.1 + i * 0.27)));
  instances(bottle, amberPaint, [1, 4].map((i) => at(-9.28, 0, -7.1 + i * 0.27)));
  instances(worldBox(0.05, 0.04, 1.5, 1), metals.structural, [0.5, 1.05].map((y) => at(-9.14, y, -6.56)), false, false);
  // Switchgear cabinets with status lamps.
  const cabinetZ = [6.5, 7.42, 8.34];
  instances(softBox(0.6, 2.05, 0.88, 0.02, 1.6), metals.machine, cabinetZ.map((z) => at(9.22, 1.025, z)));
  instances(softBox(0.02, 1.7, 0.7, 0.008, 1.6), greyPaint, cabinetZ.map((z) => at(8.915, 1.05, z)), false, false);
  instances(new THREE.BoxGeometry(0.012, 0.03, 0.09), ledMint, cabinetZ.flatMap((z) => [-0.2, 0, 0.2].map((o) => at(8.9, 1.72, z + o))), false, false);
  instances(new THREE.BoxGeometry(0.012, 0.03, 0.09), ledAmber, cabinetZ.map((z) => at(8.9, 1.62, z - 0.2)), false, false);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: metals.machine, darkMetal: metals.darkMetal, structural: metals.structural, duct: metals.brushed }, CEILING - 3.6);

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xb9d6e6, 0x1c2426, 0.28));
  const sun = kit.sunLight({ color: 0xe2f0ff, intensity: 9, toSun: TO_LAMP, extent: 32, distance: 46, near: 6, far: 84, radius: 2.2 });
  sun.target.position.set(0, 0, -18);
  sun.position.copy(sun.target.position).addScaledVector(TO_LAMP, 46);
  const fills = [SLOTS[0], SLOTS[1], SLOTS[2]].map((z, index) => {
    const fill = new THREE.PointLight(0xd3e8ff, 210, 34, 2);
    fill.position.set(index === 1 ? 3.6 : -3.6, 12.3, z);
    scene.add(fill);
    return fill;
  });
  const coreLight = new THREE.PointLight(0x2fd0ff, 240, 40, 2);
  coreLight.position.set(CORE.x, 8.2, CORE.z + CORE.radius + 2.4);
  scene.add(coreLight);
  const coreAir: Glow = { position: new THREE.Vector3(CORE.x, 8.2, CORE.z + CORE.radius + 0.6), color: new THREE.Color() };
  kit.updates.push((now) => {
    const seconds = now / 1000;
    // The core breathes over about nine seconds, with a faint faster shimmer.
    const breath = 0.8 + 0.2 * Math.sin(seconds * 0.7) + 0.03 * Math.sin(seconds * 3.1);
    coreGlow.color.copy(CORE_CYAN).multiplyScalar(3.2 * breath);
    portGlow.color.copy(CORE_CYAN).multiplyScalar(1.1 + 1.1 * breath);
    coreLight.intensity = 240 * breath;
    coreAir.color.copy(CORE_CYAN).multiplyScalar(1.3 * breath);
    beaconMaterials.forEach((material, phase) => {
      const sweep = Math.pow(0.5 + 0.5 * Math.sin(seconds * 2.6 + phase * Math.PI), 6);
      material.color.copy(beaconAmber).multiplyScalar(0.35 + sweep * 5.5);
    });
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 620, x: 18, y: [0.2, 11], z: [-34, 8], color: 0xdff1ff, opacity: 0.24 });

  const probe = new THREE.Vector3();
  return kit.finish({
    furnace,
    materials: { darkMetal: metals.darkMetal, machine: metals.machine, structural: metals.structural, brushed: metals.brushed },
    sun,
    fills,
    reflection,
    glows: [coreAir],
    look: {
      sky: null, skyIntensity: 1, skyRotation: 0,
      background: 0x05090b, fog: 0x0b1416, fogDensity: high ? 0.006 : 0.012,
      haze: new THREE.Color(0.016, 0.03, 0.036), hazeDensity: 0.017, hazeCeiling: 13, hazeFade: 1.5,
      environmentIntensity: 1.2, exposure: 1, far: 130,
    },
    sunlitAt(point) {
      const t = (CEILING - point.y) / TO_LAMP.y;
      if (t <= 0) return 0;
      probe.copy(point).addScaledVector(TO_LAMP, t);
      const acrossX = 1 - THREE.MathUtils.smoothstep(Math.abs(probe.x), SLOT_HALF.x - 0.4, SLOT_HALF.x);
      let lit = 0;
      for (const z of SLOTS) lit = Math.max(lit, 1 - THREE.MathUtils.smoothstep(Math.abs(probe.z - z), SLOT_HALF.z - 0.4, SLOT_HALF.z));
      return lit * acrossX;
    },
    probeAt: new THREE.Vector3(0, 2.6, -9),
  });
}

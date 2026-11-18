import * as THREE from "three";
import { brushedMetal, paintedSteel, pbrMaterial, roofDeck, steel, tile, timber } from "./pbr";
import { BRAND, STRIKE_ORANGE, crateGeometry, createKit, drumGeometry, hazardTexture, iBeam, jerseyBarrier, softBox, worldBox, type RangeEnvironment, type RangeOptions } from "./kit";

export { projectUv } from "./kit";
export type { RangeEnvironment, RangeQuality } from "./kit";

// The physical range: architecture, structure, fixtures, props and lighting.
//
// Lighting model: the room is sealed, so the only daylight is a sun that enters
// through three roof lights and casts real shadows of the glazing bars, trusses
// and ducts. Everything else is lit by what is actually in the room — lamp
// tubes, screens and the furnace — captured once into a local reflection probe
// that replaces the outdoor sky as the image-based light.

const SKYLIGHTS = [2.1, -10.3, -22.7];
const SKYLIGHT_HALF = { x: 3.45, z: 1.725 };
const SKYLIGHT_Y = 6.2;

/** Emissive display with a glossy face so screens pick up reflections like real panels. */
export function displayMaterial(texture: THREE.Texture, gain = 1) {
  return new THREE.MeshPhysicalMaterial({
    color: 0x010203,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: gain,
    roughness: 0.3,
    metalness: 0,
    // Soft sheen only: lamp hot-spots must never hide market copy.
    specularIntensity: 0.35,
    envMapIntensity: 0.5,
  });
}

export function buildRange(options: RangeOptions): RangeEnvironment {
  const kit = createKit(options);
  const { scene, high, anisotropy, shootable, keep, track, photoSet, place, instances } = kit;

  // ---- Materials -----------------------------------------------------------
  const slab = photoSet("/textures/concrete_floor_worn_001-2k", 38 / 4.2, 52 / 4.2);
  const cast = photoSet("/textures/concrete_floor_worn_001-2k", 1, 1);
  const brick = photoSet("/textures/brick_wall_001-2k", 1, 1);

  const cladding = keep(paintedSteel(anisotropy, [0.105, 0.155, 0.165], 11, 0.5));
  const machinePaint = keep(paintedSteel(anisotropy, [0.04, 0.062, 0.068], 211, 0.12));
  const drumPaint = keep(paintedSteel(anisotropy, [0.36, 0.13, 0.03], 311, 0.75, 512));
  const darkSteel = keep(steel(anisotropy, [0.1, 0.11, 0.12], 0.46, 23));
  const beamSteel = keep(steel(anisotropy, [0.16, 0.17, 0.175], 0.58, 29));
  const duct = keep(tile(brushedMetal(anisotropy, [0.5, 0.52, 0.53], 31), 3, 14));
  const deck = keep(roofDeck(anisotropy, 41));
  const boards = keep(timber(anisotropy, [0.11, 0.06, 0.028], [0.42, 0.27, 0.14], 4, 53));

  const claddingMaterial = pbrMaterial(cladding, { envMapIntensity: 0.9 });
  const machineMaterial = pbrMaterial(machinePaint, { envMapIntensity: 1 });
  const structural = pbrMaterial(beamSteel, { envMapIntensity: 0.9 });
  const darkMetal = pbrMaterial(darkSteel, { envMapIntensity: 1.1 });
  const ductMaterial = pbrMaterial(duct, { envMapIntensity: 1.1 });
  const deckMaterial = pbrMaterial(deck, { envMapIntensity: 0.8, normalScale: new THREE.Vector2(1.2, 1.2) });
  const crateMaterial = pbrMaterial(boards, { metalness: 0, envMapIntensity: 0.55 });
  const drumMaterial = pbrMaterial(drumPaint, { envMapIntensity: 1 });
  const concrete = new THREE.MeshStandardMaterial({ ...cast, normalScale: new THREE.Vector2(0.9, 0.9), color: 0xb9b6a9, roughness: 0.95, metalness: 0, aoMapIntensity: 0.8, envMapIntensity: 0.5 });
  const brickMaterial = new THREE.MeshStandardMaterial({ ...brick, normalScale: new THREE.Vector2(1.25, 1.25), color: 0xc9b9aa, roughness: 0.96, metalness: 0, aoMapIntensity: 0.9, envMapIntensity: 0.45 });

  // ---- Floor ---------------------------------------------------------------
  const floorMaterial = new THREE.MeshStandardMaterial({
    ...slab,
    normalScale: new THREE.Vector2(1.15, 1.15),
    color: 0xa9aca6,
    roughness: 0.86,
    metalness: 0,
    aoMapIntensity: 0.85,
    envMapIntensity: 0.4,
  });
  const reflection = kit.floor(floorMaterial, { width: 38, depth: 52, z: -8 }, {
    lane: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.8),
    edge: new THREE.Color(0.62, 0.6, 0.52),
  });

  // ---- Walls ---------------------------------------------------------------
  for (const x of [-10, 10]) {
    place(new THREE.Mesh(worldBox(0.7, 8, 48, 2.4), claddingMaterial), x, 4, -9, true, true);
    place(new THREE.Mesh(worldBox(0.12, 4.2, 42, 2.8), brickMaterial), x * 0.96, 2.3, -9, false, true);
    // Cast kerb at the foot of the brickwork and a steel capping above it.
    place(new THREE.Mesh(softBox(0.3, 0.32, 42, 0.03, 2.2), concrete), x * 0.948, 0.16, -9, false, true);
    place(new THREE.Mesh(worldBox(0.2, 0.09, 42, 1.4), structural), x * 0.956, 4.44, -9, false);
  }
  place(new THREE.Mesh(worldBox(20, 7, 0.6, 2.4), claddingMaterial), 0, 3.5, -29, true, true);
  place(new THREE.Mesh(worldBox(20, 8, 0.6, 2.4), claddingMaterial), 0, 4, 10, true, true);

  // ---- Structure -----------------------------------------------------------
  const bayZ = [4, -2, -8, -14, -20, -26];
  instances(iBeam(0.44, 0.46, 6.25, 0.045, 0.035), structural, bayZ.flatMap((z) => [-9.42, 9.42].map((x) => ({ position: [x, 0, z] as [number, number, number], rotation: [0, Math.PI / 2, 0] as [number, number, number] }))));
  // Base plates with anchor bolts.
  instances(worldBox(0.62, 0.035, 0.6, 1.4), structural, bayZ.flatMap((z) => [-9.4, 9.4].map((x) => ({ position: [x, 0.018, z] as [number, number, number] }))), false, false);
  instances(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 6), darkMetal, bayZ.flatMap((z) => [-9.4, 9.4].flatMap((x) => [[-0.25, -0.24], [0.25, -0.24], [-0.25, 0.24], [0.25, 0.24]].map(([ox, oz]) => ({ position: [x + ox, 0.05, z + oz] as [number, number, number] })))), false, false);

  // Gallery decks along both walls with brackets and a two-rail balustrade.
  instances(softBox(2.2, 0.24, 5.3, 0.02, 2.2), concrete, bayZ.flatMap((z) => [-8.55, 8.55].map((x) => ({ position: [x, 3.78, z - 2.7] as [number, number, number] }))));
  instances(worldBox(1.9, 0.14, 0.1, 1.4), structural, bayZ.flatMap((z) => [-8.5, 8.5].map((x) => ({ position: [x, 3.59, z - 0.34] as [number, number, number] }))), false);
  const railTransforms = bayZ.flatMap((z) => [-7.62, 7.62].map((x) => ({ x, z: z - 2.7 })));
  const railGeometry = new THREE.CylinderGeometry(0.024, 0.024, 5.3, 8);
  railGeometry.rotateX(Math.PI / 2);
  instances(railGeometry, ductMaterial, railTransforms.flatMap(({ x, z }) => [4.92, 4.42].map((y) => ({ position: [x, y, z] as [number, number, number] }))), false);
  instances(new THREE.CylinderGeometry(0.022, 0.022, 1.04, 8), ductMaterial, bayZ.flatMap((z) => [-7.62, 7.62].flatMap((x) => [z - 5.1, z - 3.5, z - 1.9, z - 0.3].map((postZ) => ({ position: [x, 4.42, postZ] as [number, number, number] })))), false);
  instances(worldBox(0.012, 0.1, 5.3, 1.4), structural, railTransforms.map(({ x, z }) => ({ position: [x, 3.96, z] as [number, number, number] })), false, false);

  // Open-web roof trusses.
  const trussZ = [8, 1.8, -4.4, -10.6, -16.8, -23];
  instances(worldBox(19.3, 0.11, 0.15, 1.4), structural, trussZ.flatMap((z) => [6.14, 5.72].map((y) => ({ position: [0, y, z] as [number, number, number] }))), false);
  const webRun = 1.2, webRise = 0.42, webAngle = Math.atan2(webRise, webRun);
  instances(worldBox(Math.hypot(webRun, webRise), 0.05, 0.05, 1.4), structural, trussZ.flatMap((z) => Array.from({ length: 16 }, (_, index) => ({
    position: [-9 + webRun / 2 + index * webRun, 5.93, z] as [number, number, number],
    rotation: [0, 0, index % 2 ? -webAngle : webAngle] as [number, number, number],
  }))), false);
  instances(worldBox(0.05, 0.42, 0.05, 1.4), structural, trussZ.flatMap((z) => [-9.6, -4.8, 0, 4.8, 9.6].map((x) => ({ position: [x, 5.93, z] as [number, number, number] }))), false);
  // Purlins tie the trusses together under the deck.
  instances(worldBox(0.08, 0.1, 38, 1.4), structural, [-8.4, -6, 6, 8.4].map((x) => ({ position: [x, 6.19, -9.5] as [number, number, number] })), false, false);

  // ---- Roof ----------------------------------------------------------------
  const deckPanels: Array<[number, number, number, number]> = [
    [6.3, 44, -6.85, -9.5], [6.3, 44, 6.85, -9.5], [7.4, 4.1, 0, 6], [7.4, 7.2, 0, -4.1], [7.4, 7.2, 0, -16.5], [7.4, 3.8, 0, -27],
  ];
  deckPanels.forEach(([w, d, x, z]) => place(new THREE.Mesh(worldBox(w, 0.18, d, 1.7), deckMaterial), x, 6.34, z, true));
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ea, transparent: true, opacity: 0.16, roughness: 0.06, metalness: 0, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false });
  SKYLIGHTS.forEach((z) => {
    const kerbs: Array<[number, number, number, number, number]> = [
      [7.8, 0.34, 0, z - 1.98, 0], [7.8, 0.34, 0, z + 1.98, 0], [0.34, 3.62, -3.73, z, 0], [0.34, 3.62, 3.73, z, 0],
    ];
    kerbs.forEach(([w, d, x, kz]) => place(new THREE.Mesh(worldBox(w, 0.3, d, 1.4), structural), x, 6.32, kz, true));
    // Glazing bars: these are what print the window pattern into the sun patches.
    for (const x of [-1.15, 1.15]) place(new THREE.Mesh(worldBox(0.07, 0.08, 3.62, 1.4), structural), x, 6.22, z, true);
    place(new THREE.Mesh(worldBox(6.9, 0.08, 0.07, 1.4), structural), 0, 6.22, z, true);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(6.9, 3.45), glass);
    pane.rotation.x = -Math.PI / 2;
    pane.position.set(0, 6.26, z);
    scene.add(pane);
  });

  // ---- Lamps ---------------------------------------------------------------
  const lampSpots = trussZ.flatMap((z) => [-5, 0, 5].filter((x) => x !== 0 || !SKYLIGHTS.some((sky) => Math.abs(sky - z) < 2.6)).map((x) => ({ x, z })));
  instances(softBox(2.86, 0.09, 0.24, 0.02, 1.4), darkMetal, lampSpots.map(({ x, z }) => ({ position: [x, 5.565, z] as [number, number, number] })), false);
  instances(worldBox(0.012, 0.16, 0.012, 1.4), darkMetal, lampSpots.flatMap(({ x, z }) => [-1.1, 1.1].map((o) => ({ position: [x + o, 5.66, z] as [number, number, number] }))), false, false);
  const tubeMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd9fff6).multiplyScalar(4.2), toneMapped: false });
  const tubeGeometry = new THREE.CylinderGeometry(0.028, 0.028, 2.66, 10);
  tubeGeometry.rotateZ(Math.PI / 2);
  instances(tubeGeometry, tubeMaterial, lampSpots.flatMap(({ x, z }) => [-0.055, 0.055].map((o) => ({ position: [x, 5.5, z + o] as [number, number, number] }))), false, false);
  // Warm bulkhead lamps on every column give the cool room its colour contrast.
  const bulkheadMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb468).multiplyScalar(4.2), toneMapped: false });
  instances(softBox(0.1, 0.3, 0.2, 0.03, 1), darkMetal, bayZ.flatMap((z) => [-9.16, 9.16].map((x) => ({ position: [x, 3.1, z] as [number, number, number] }))), false);
  instances(softBox(0.05, 0.2, 0.13, 0.02, 1), bulkheadMaterial, bayZ.flatMap((z) => [-9.105, 9.105].map((x) => ({ position: [x, 3.1, z] as [number, number, number] }))), false, false);

  // ---- Services ------------------------------------------------------------
  const ductGeometry = new THREE.CylinderGeometry(0.23, 0.23, 39, 20);
  ductGeometry.rotateX(Math.PI / 2);
  instances(ductGeometry, ductMaterial, [-7.2, 7.2].map((x) => ({ position: [x, 5.3, -10.5] as [number, number, number] })), false);
  const flange = new THREE.CylinderGeometry(0.255, 0.255, 0.05, 20);
  flange.rotateX(Math.PI / 2);
  const ductJoints = Array.from({ length: 14 }, (_, index) => 8.2 - index * 2.9);
  instances(flange, structural, ductJoints.flatMap((z) => [-7.2, 7.2].map((x) => ({ position: [x, 5.3, z] as [number, number, number] }))), false, false);
  instances(worldBox(0.014, 0.66, 0.014, 1), darkMetal, ductJoints.filter((_, index) => index % 2 === 0).flatMap((z) => [-7.2, 7.2].flatMap((x) => [-0.24, 0.24].map((o) => ({ position: [x + o, 5.83, z + 0.08] as [number, number, number] })))), false, false);
  // Electrical conduit runs with junction boxes at each column.
  const conduit = new THREE.CylinderGeometry(0.022, 0.022, 41.6, 8);
  conduit.rotateX(Math.PI / 2);
  instances(conduit, ductMaterial, [-9.56, 9.56].flatMap((x) => [4.62, 4.72, 4.82].map((y) => ({ position: [x, y, -9] as [number, number, number] }))), false, false);
  instances(softBox(0.1, 0.34, 0.26, 0.015, 1), machineMaterial, bayZ.flatMap((z) => [-9.56, 9.56].map((x) => ({ position: [x, 4.72, z + 0.62] as [number, number, number] }))), false, false);
  const cableMaterial = new THREE.MeshStandardMaterial({ color: 0x0c0e10, roughness: 0.55, metalness: 0 });
  for (const x of [-5.2, 0, 5.2]) {
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(x - 1.2, 5.9, 6), new THREE.Vector3(x, 5.42 - Math.abs(x) * 0.02, -4),
      new THREE.Vector3(x + 0.8, 5.66, -15), new THREE.Vector3(x - 0.4, 5.4, -27),
    ]), 72, 0.022, 6, false), cableMaterial);
    cable.castShadow = true;
    scene.add(cable);
  }

  // ---- Wall LED guides -----------------------------------------------------
  const ledOrange = new THREE.MeshBasicMaterial({ color: new THREE.Color(STRIKE_ORANGE).multiplyScalar(2.4), toneMapped: false });
  const ledMint = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(2.2), toneMapped: false });
  instances(worldBox(0.03, 0.035, 41, 1), ledOrange, [{ position: [-9.47, 0.44, -9] }], false, false);
  instances(worldBox(0.03, 0.035, 41, 1), ledMint, [{ position: [9.47, 0.44, -9] }], false, false);
  instances(worldBox(0.06, 0.08, 41, 1.4), darkMetal, [-9.5, 9.5].map((x) => ({ position: [x, 0.44, -9] as [number, number, number] })), false, false);
  const laneMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND).multiplyScalar(1.9), toneMapped: false });
  instances(worldBox(0.03, 0.006, 16, 1), laneMaterial, [-3.2, 3.2].map((x) => ({ position: [x, 0.006, -17] as [number, number, number] })), false, false);

  // ---- Props ---------------------------------------------------------------
  const crateSpots: Array<[number, number, number]> = [
    [-7.7, 0.54, 2.5], [-7.62, 0.54, 1.25], [-7.66, 1.62, 1.85],
    [7.7, 0.54, -2.1], [7.62, 0.54, -3.35], [7.66, 1.62, -2.75],
    [-7.7, 0.54, -14.8], [-7.62, 1.62, -14.8], [7.7, 0.54, -19.5], [7.62, 0.54, -20.75],
  ];
  instances(crateGeometry(1.08), crateMaterial, crateSpots.map((position, index) => ({ position, rotation: [0, (index % 3 - 1) * 0.12 + (index % 2) * Math.PI / 2, 0] as [number, number, number] })));
  const barrierSpots: Array<[number, number, number]> = [[-6.5, 0, 5], [-8.35, 0, -10.5], [-6.5, 0, -18], [6.5, 0, 0], [6.5, 0, -11.5], [6.5, 0, -23]];
  instances(jerseyBarrier(2.4), concrete, barrierSpots.map((position, index) => ({ position, rotation: [0, index % 2 ? -0.08 : 0.08, 0] as [number, number, number] })));
  const hazard = track(hazardTexture());
  hazard.repeat.set(3, 1);
  hazard.anisotropy = anisotropy;
  const hazardMaterial = new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.42, metalness: 0, envMapIntensity: 0.8 });
  for (const side of [-1, 1]) {
    instances(new THREE.BoxGeometry(2.32, 0.16, 0.012), hazardMaterial, barrierSpots.map((position, index) => {
      const yaw = index % 2 ? -0.08 : 0.08;
      return { position: [position[0] + Math.sin(yaw) * 0.118 * side, 0.82, position[2] + Math.cos(yaw) * 0.118 * side] as [number, number, number], rotation: [side * -0.095, yaw, 0] as [number, number, number] };
    }), false, false);
  }
  const drumSpots: Array<[number, number, number]> = [[-8.3, 0, 4.2], [-8.75, 0, 3.6], [8.45, 0, -5.2], [-8.6, 0, -16.3], [8.5, 0, -21.9], [8.9, 0, -22.5], [8.2, 0, 3.4]];
  instances(drumGeometry(), drumMaterial, drumSpots.map((position, index) => ({ position, rotation: [0, index * 1.3, 0] as [number, number, number] })));

  // Service doors with frames, kick plates and pull handles.
  const doors: Array<[number, number]> = [[-9.56, -4.6], [9.56, -15.6]];
  instances(softBox(0.16, 2.72, 1.72, 0.012, 2), machineMaterial, doors.map(([x, z]) => ({ position: [x, 1.38, z] as [number, number, number] })));
  instances(worldBox(0.22, 2.92, 0.12, 1.4), structural, doors.flatMap(([x, z]) => [-0.95, 0.95].map((o) => ({ position: [x, 1.46, z + o] as [number, number, number] }))), false, false);
  instances(worldBox(0.22, 0.12, 2.02, 1.4), structural, doors.map(([x, z]) => ({ position: [x, 2.86, z] as [number, number, number] })), false, false);
  instances(worldBox(0.012, 0.3, 1.6, 1.4), ductMaterial, doors.map(([x, z]) => ({ position: [x - Math.sign(x) * 0.085, 0.24, z] as [number, number, number] })), false, false);
  instances(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 8), ductMaterial, doors.map(([x, z]) => ({ position: [x - Math.sign(x) * 0.12, 1.2, z + 0.62] as [number, number, number] })), false, false);

  // ---- Furnace -------------------------------------------------------------
  const furnace = kit.furnace({ machine: machineMaterial, darkMetal, structural, duct: ductMaterial });

  // ---- Light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xbcd3d6, 0x2b2620, 0.3));
  const sun = new THREE.DirectionalLight(0xfff0d8, 7.5);
  const sunTravel = new THREE.Vector3(-5, -16, 7).normalize();
  sun.target.position.set(0, 0, -9.5);
  sun.position.copy(sun.target.position).addScaledVector(sunTravel, -42);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(high ? 4096 : 2048);
  sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24;
  sun.shadow.camera.near = 8; sun.shadow.camera.far = 72;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);
  // Soft overhead fill from the lamp rows (the probe carries the rest).
  const fills = [3, -9, -21].map((z, index) => {
    const lampFill = new THREE.PointLight(0xd3f1ec, 52, 19, 2);
    lampFill.position.set(index === 1 ? -3.4 : 3.4, 5.1, z);
    scene.add(lampFill);
    return lampFill;
  });

  // ---- Air -----------------------------------------------------------------
  kit.motes({ count: 520, x: 18, y: [0.2, 5.8], z: [-28, 8], color: 0xfff3dc });

  const toSun = sunTravel.clone().negate();
  const probe = new THREE.Vector3();

  return kit.finish({
    furnace,
    materials: { darkMetal, machine: machineMaterial, structural, brushed: ductMaterial },
    sun,
    fills,
    reflection,
    look: {
      sky: "/environment/bonzai-sky.hdr", skyIntensity: 1, skyRotation: 0,
      background: 0x6f8fa8, fog: 0x16201f, fogDensity: high ? 0.0045 : 0.011,
      haze: new THREE.Color(0.022, 0.038, 0.042), hazeDensity: 0.015, hazeCeiling: 6.3, hazeFade: 0.25,
      environmentIntensity: 1.2, exposure: 1, far: 110,
    },
    sunlitAt(point) {
      const t = (SKYLIGHT_Y - point.y) / toSun.y;
      if (t <= 0) return 0;
      probe.copy(point).addScaledVector(toSun, t);
      const edgeX = 1 - THREE.MathUtils.smoothstep(Math.abs(probe.x), SKYLIGHT_HALF.x - 0.35, SKYLIGHT_HALF.x);
      let lit = 0;
      for (const z of SKYLIGHTS) lit = Math.max(lit, 1 - THREE.MathUtils.smoothstep(Math.abs(probe.z - z), SKYLIGHT_HALF.z - 0.35, SKYLIGHT_HALF.z));
      return lit * edgeX;
    },
  });
}

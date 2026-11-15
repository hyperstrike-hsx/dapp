import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyWetFloor, createFloorReflection, type FloorReflection } from "./floor";
import { brushedMetal, disposePbr, paintedSteel, pbrMaterial, roofDeck, steel, tile, timber, type PbrSet } from "./pbr";
import type { Glow } from "./volumetric";

// The physical range: architecture, structure, fixtures, props and lighting.
//
// Lighting model: the room is sealed, so the only daylight is a sun that enters
// through three roof lights and casts real shadows of the glazing bars, trusses
// and ducts. Everything else is lit by what is actually in the room — lamp
// tubes, screens and the furnace — captured once into a local reflection probe
// that replaces the outdoor sky as the image-based light.

export type RangeQuality = "HIGH" | "PERFORMANCE";

const BRAND = 0x8ef5e3;
const STRIKE_ORANGE = 0xe89a42;
const SKYLIGHTS = [2.1, -10.3, -22.7];
const SKYLIGHT_HALF = { x: 3.45, z: 1.725 };
const SKYLIGHT_Y = 6.2;

type Transform = { position: [number, number, number]; rotation?: [number, number, number] };

export type RangeEnvironment = {
  shootable: THREE.Object3D[];
  furnaceMeshes: THREE.Mesh[];
  furnace: THREE.Group;
  materials: { darkMetal: THREE.MeshStandardMaterial; machine: THREE.MeshStandardMaterial; structural: THREE.MeshStandardMaterial; brushed: THREE.MeshStandardMaterial };
  sun: THREE.DirectionalLight;
  /** Overhead lamp fill lights, exposed so game modes can restage the room. */
  fills: THREE.PointLight[];
  reflection: FloorReflection;
  /** Objects hidden while the mirrored floor pass renders. */
  mirrorHidden: THREE.Object3D[];
  glows: Glow[];
  /** 0..1 amount of direct sun reaching a point. */
  sunlitAt: (point: THREE.Vector3) => number;
  /** Replaces the sky IBL with a probe of the lit room. */
  captureProbe: (pmrem: THREE.PMREMGenerator) => THREE.WebGLRenderTarget;
  update: (now: number) => void;
  dispose: () => void;
};

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

/** Rewrites UVs by box projection so one texture tile always spans `metres`. */
export function projectUv<T extends THREE.BufferGeometry>(geometry: T, metres: number): T {
  const position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const ax = Math.abs(normal.getX(i)), ay = Math.abs(normal.getY(i)), az = Math.abs(normal.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, z / metres, y / metres);
    else if (ay >= az) uv.setXY(i, x / metres, z / metres);
    else uv.setXY(i, x / metres, y / metres);
  }
  uv.needsUpdate = true;
  return geometry;
}

const worldBox = (w: number, h: number, d: number, metres: number) => projectUv(new THREE.BoxGeometry(w, h, d), metres);
const softBox = (w: number, h: number, d: number, radius: number, metres: number) => projectUv(new RoundedBoxGeometry(w, h, d, 3, radius), metres);

/** Rolled steel I-section standing on the floor. */
function iBeam(width: number, depth: number, height: number, flange: number, web: number) {
  const w = width / 2, d = depth / 2, f = flange, t = web / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w, -d); shape.lineTo(w, -d); shape.lineTo(w, -d + f); shape.lineTo(t, -d + f);
  shape.lineTo(t, d - f); shape.lineTo(w, d - f); shape.lineTo(w, d); shape.lineTo(-w, d);
  shape.lineTo(-w, d - f); shape.lineTo(-t, d - f); shape.lineTo(-t, -d + f); shape.lineTo(-w, -d + f);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return projectUv(geometry, 1.4);
}

/** Precast "Jersey" traffic barrier, long axis on X. */
function jerseyBarrier(length: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.3, 0); shape.lineTo(0.3, 0); shape.lineTo(0.3, 0.09); shape.lineTo(0.165, 0.32);
  shape.lineTo(0.1, 1.0); shape.lineTo(0.075, 1.04); shape.lineTo(-0.075, 1.04); shape.lineTo(-0.1, 1.0);
  shape.lineTo(-0.165, 0.32); shape.lineTo(-0.3, 0.09);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 2 });
  geometry.translate(0, 0, -length / 2);
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  return projectUv(geometry, 2.2);
}

/** Shipping crate: boarded core with proud edge battens and a diagonal brace per side. */
function crateGeometry(size: number) {
  const half = size / 2, batten = 0.085, proud = 0.022;
  const parts: THREE.BufferGeometry[] = [worldBox(size - proud * 2, size - proud * 2, size - proud * 2, 1.1)];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, rotation?: THREE.Euler) => {
    const part = new RoundedBoxGeometry(w, h, d, 1, 0.008);
    if (rotation) part.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rotation));
    part.translate(x, y, z);
    parts.push(projectUv(part, 1.1));
  };
  const edge = half - batten / 2;
  for (const a of [-edge, edge]) {
    for (const b of [-edge, edge]) {
      add(size, batten, batten, 0, a, b);
      add(batten, size, batten, a, 0, b);
      add(batten, batten, size, a, b, 0);
    }
  }
  const brace = Math.hypot(size, size) - batten * 2.6;
  for (const side of [-1, 1]) {
    add(brace, batten, proud * 1.6, 0, 0, side * (half - proud * 0.8), new THREE.Euler(0, 0, side * Math.PI / 4));
    add(proud * 1.6, batten, brace, side * (half - proud * 0.8), 0, 0, new THREE.Euler(side * Math.PI / 4, 0, 0));
  }
  const merged = mergeGeometries(parts.map((part) => part.index ? part.toNonIndexed() : part));
  parts.forEach((part) => part.dispose());
  return merged;
}

/** 200-litre steel drum with rolled hoops and a recessed lid. */
function drumGeometry() {
  const r = 0.29, h = 0.88;
  const profile = [
    [0, 0], [r - 0.02, 0], [r, 0.02], [r, 0.27], [r + 0.016, 0.29], [r + 0.016, 0.31], [r, 0.33],
    [r, 0.55], [r + 0.016, 0.57], [r + 0.016, 0.59], [r, 0.61], [r, h - 0.03], [r + 0.012, h - 0.02],
    [r + 0.012, h], [r - 0.02, h], [r - 0.024, h - 0.022], [0, h - 0.022],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geometry = new THREE.LatheGeometry(profile, 28);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * 1.6, uv.getY(i) * 0.8);
  return geometry;
}

function softDiscTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,.45)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

function hazardTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#d98a2b";
  context.fillRect(0, 0, 256, 64);
  context.fillStyle = "#14110d";
  for (let x = -64; x < 256; x += 64) {
    context.beginPath(); context.moveTo(x, 64); context.lineTo(x + 32, 64); context.lineTo(x + 96, 0); context.lineTo(x + 64, 0); context.closePath(); context.fill();
  }
  let seed = 77;
  for (let i = 0; i < 900; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = (seed & 255), y = (seed >> 8) & 63, shade = 40 + ((seed >> 16) & 63);
    context.fillStyle = `rgba(${shade},${shade},${shade},.35)`;
    context.fillRect(x, y, 1 + ((seed >> 22) & 3), 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const FIRE_SHADER = {
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += noise(p) * a; p = p * 2.02 + 11.3; a *= 0.5; } return s; }
    void main() {
      vec2 p = vec2(vUv.x * 3.2, vUv.y * 2.1);
      float rise = time * 1.35;
      float turbulence = fbm(p * 1.6 + vec2(fbm(p + vec2(0.0, -rise * 0.6)) * 1.4, -rise));
      float body = turbulence * 1.5 - vUv.y * 1.05 + 0.28;
      float flame = smoothstep(0.12, 0.95, body);
      float embers = smoothstep(0.55, 0.0, vUv.y) * (0.6 + 0.4 * noise(p * 5.0 + vec2(0.0, time * 0.4)));
      float heat = clamp(flame + embers * 0.55, 0.0, 1.4);
      // Black-body ramp: deep red -> orange -> pale yellow core.
      vec3 color = vec3(1.0, 0.09, 0.012) * smoothstep(0.0, 0.5, heat) * 2.2
                 + vec3(1.0, 0.42, 0.04) * smoothstep(0.32, 0.85, heat) * 4.2
                 + vec3(1.0, 0.86, 0.5) * smoothstep(0.78, 1.25, heat) * 5.0;
      gl_FragColor = vec4(color + vec3(0.05, 0.008, 0.0), 1.0);
    }
  `,
};

export function buildRange(options: {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  quality: RangeQuality;
  loadingManager: THREE.LoadingManager;
}): RangeEnvironment {
  const { scene, renderer, quality, loadingManager } = options;
  const high = quality === "HIGH";
  const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const shootable: THREE.Object3D[] = [];
  const furnaceMeshes: THREE.Mesh[] = [];
  const mirrorHidden: THREE.Object3D[] = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const sets: PbrSet[] = [];
  const keep = <T extends PbrSet>(set: T) => { sets.push(set); return set; };

  // ---- Materials -----------------------------------------------------------
  const loader = new THREE.TextureLoader(loadingManager);
  const photoSet = (root: string, repeatX: number, repeatY: number) => {
    const maps = ["diffuse", "normal-gl", "roughness", "ao"].map((name) => {
      const texture = loader.load(`${root}/${name}.jpg`);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeatX, repeatY);
      texture.anisotropy = anisotropy;
      disposables.push(texture);
      return texture;
    });
    maps[0].colorSpace = THREE.SRGBColorSpace;
    return { map: maps[0], normalMap: maps[1], roughnessMap: maps[2], aoMap: maps[3] };
  };
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

  const place = (mesh: THREE.Mesh, x: number, y: number, z: number, shadow = true, hit = false) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (hit) shootable.push(mesh);
    return mesh;
  };
  const instances = (geometry: THREE.BufferGeometry, material: THREE.Material, transforms: Transform[], hit = true, shadow = true) => {
    const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    const dummy = new THREE.Object3D();
    transforms.forEach((transform, index) => {
      dummy.position.set(...transform.position);
      dummy.rotation.set(...(transform.rotation ?? [0, 0, 0]));
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.computeBoundingSphere();
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (hit) shootable.push(mesh);
    return mesh;
  };

  // ---- Floor ---------------------------------------------------------------
  const reflection = createFloorReflection(renderer, high);
  const floorMaterial = new THREE.MeshStandardMaterial({
    ...slab,
    normalScale: new THREE.Vector2(1.15, 1.15),
    color: 0xa9aca6,
    roughness: 0.86,
    metalness: 0,
    aoMapIntensity: 0.85,
    envMapIntensity: 0.4,
  });
  applyWetFloor(floorMaterial, reflection, {
    lane: new THREE.Color(STRIKE_ORANGE).multiplyScalar(0.8),
    edge: new THREE.Color(0.62, 0.6, 0.52),
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(38, 52), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -8;
  floor.receiveShadow = true;
  scene.add(floor);
  shootable.push(floor);
  mirrorHidden.push(floor);

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
  const hazard = hazardTexture();
  hazard.repeat.set(3, 1);
  hazard.anisotropy = anisotropy;
  disposables.push(hazard);
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
  const furnace = new THREE.Group();
  furnace.position.set(9.18, 0, -11.6);
  furnace.rotation.y = -Math.PI / 2;
  const furnacePart = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, utility = false) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (utility) { mesh.userData.utility = "furnace"; furnaceMeshes.push(mesh); }
    furnace.add(mesh);
    return mesh;
  };
  furnacePart(softBox(3.3, 3.5, 1.15, 0.05, 1.6), machineMaterial, 0, 1.75, 0);
  furnacePart(softBox(3.6, 0.22, 1.4, 0.03, 1.6), darkMetal, 0, 0.11, 0.05);
  furnacePart(softBox(3.5, 0.16, 1.3, 0.03, 1.6), darkMetal, 0, 3.56, 0.02);
  // Flue rising to the roof with a collar.
  const flue = new THREE.CylinderGeometry(0.3, 0.3, 2.7, 20);
  furnacePart(flue, ductMaterial, -1.05, 4.95, -0.1);
  furnacePart(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 20), structural, -1.05, 3.7, -0.1);
  const fireMaterial = new THREE.ShaderMaterial({ ...FIRE_SHADER, uniforms: { time: { value: 0 } }, toneMapped: false });
  furnacePart(new THREE.PlaneGeometry(2.42, 1.86), fireMaterial, 0, 1.68, 0.59, true).castShadow = false;
  const doorFrame = new THREE.Shape();
  doorFrame.moveTo(-1.425, -1.175); doorFrame.lineTo(1.425, -1.175); doorFrame.lineTo(1.425, 1.175); doorFrame.lineTo(-1.425, 1.175); doorFrame.closePath();
  const doorHole = new THREE.Path();
  doorHole.moveTo(-1.12, -0.81); doorHole.lineTo(-1.12, 0.81); doorHole.lineTo(1.12, 0.81); doorHole.lineTo(1.12, -0.81); doorHole.closePath();
  doorFrame.holes.push(doorHole);
  const doorGeometry = new THREE.ExtrudeGeometry(doorFrame, { depth: 0.2, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
  doorGeometry.translate(0, 0, -0.1);
  furnacePart(projectUv(doorGeometry, 1.2), darkMetal, 0, 1.68, 0.71, true);
  for (const x of [-0.82, -0.41, 0, 0.41, 0.82]) furnacePart(softBox(0.075, 1.72, 0.08, 0.012, 1), darkMetal, x, 1.68, 0.8);
  const boltGeometry = new THREE.CylinderGeometry(0.034, 0.034, 0.05, 6);
  boltGeometry.rotateX(Math.PI / 2);
  for (const x of [-1.3, -0.65, 0, 0.65, 1.3]) for (const y of [0.62, 2.74]) furnacePart(boltGeometry, structural, x, y, 0.83);
  for (const y of [1.15, 1.68, 2.21]) for (const x of [-1.3, 1.3]) furnacePart(boltGeometry, structural, x, y, 0.83);
  const furnaceLight = new THREE.PointLight(0xff6817, 34, 11, 2);
  furnaceLight.position.set(0, 1.7, 1.25);
  furnace.add(furnaceLight);
  scene.add(furnace);
  shootable.push(...furnace.children.filter((child) => child instanceof THREE.Mesh));

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
  const moteMap = softDiscTexture();
  disposables.push(moteMap);
  const moteCount = high ? 520 : 260;
  const motePositions = new Float32Array(moteCount * 3);
  for (let i = 0; i < moteCount; i += 1) {
    motePositions[i * 3] = (Math.random() - 0.5) * 18;
    motePositions[i * 3 + 1] = 0.2 + Math.random() * 5.6;
    motePositions[i * 3 + 2] = 8 - Math.random() * 36;
  }
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({ map: moteMap, color: 0xfff3dc, size: 0.035, sizeAttenuation: true, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(motes);
  mirrorHidden.push(motes);

  const glows: Glow[] = [{ position: new THREE.Vector3(), color: new THREE.Color() }];
  const toSun = sunTravel.clone().negate();
  const probe = new THREE.Vector3();

  return {
    shootable,
    furnaceMeshes,
    furnace,
    materials: { darkMetal, machine: machineMaterial, structural, brushed: ductMaterial },
    sun,
    fills,
    reflection,
    mirrorHidden,
    glows,
    sunlitAt(point) {
      const t = (SKYLIGHT_Y - point.y) / toSun.y;
      if (t <= 0) return 0;
      probe.copy(point).addScaledVector(toSun, t);
      const edgeX = 1 - THREE.MathUtils.smoothstep(Math.abs(probe.x), SKYLIGHT_HALF.x - 0.35, SKYLIGHT_HALF.x);
      let lit = 0;
      for (const z of SKYLIGHTS) lit = Math.max(lit, 1 - THREE.MathUtils.smoothstep(Math.abs(probe.z - z), SKYLIGHT_HALF.z - 0.35, SKYLIGHT_HALF.z));
      return lit * edgeX;
    },
    captureProbe(pmrem) {
      motes.visible = false;
      const strength = reflection.uniforms.reflectionStrength.value;
      reflection.uniforms.reflectionStrength.value = 0;
      const target = pmrem.fromScene(scene, 0, 0.1, 90, { size: 256, position: new THREE.Vector3(0, 2.3, -9) });
      reflection.uniforms.reflectionStrength.value = strength;
      motes.visible = true;
      return target;
    },
    update(now) {
      const seconds = now / 1000;
      fireMaterial.uniforms.time.value = seconds;
      const flicker = 0.78 + Math.sin(seconds * 11.3) * 0.08 + Math.sin(seconds * 23.7 + 1.3) * 0.06 + Math.sin(seconds * 5.1) * 0.08;
      furnaceLight.intensity = 34 * flicker;
      furnaceLight.getWorldPosition(glows[0].position);
      glows[0].color.setRGB(1, 0.36, 0.07).multiplyScalar(2.6 * flicker);
      motes.rotation.y = now * 0.000012;
      motes.position.y = Math.sin(now * 0.00021) * 0.12;
    },
    dispose() {
      sets.forEach(disposePbr);
      disposables.forEach((item) => item.dispose());
      reflection.dispose();
    },
  };
}

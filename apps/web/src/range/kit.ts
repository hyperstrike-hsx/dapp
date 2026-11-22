import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyWetFloor, createFloorReflection, type FloorPaint, type FloorReflection } from "./floor";
import { brushedMetal, disposePbr, paintedSteel, pbrMaterial, steel, tile, timber, type PbrSet } from "./pbr";
import type { Glow } from "./volumetric";
import type { Cue } from "./cues";
import { leanAssets, leanCanvas, photoRoot } from "./touch";

// Shared parts every range map is built from: the contract a map fulfils, the
// geometry and texture helpers, the furnace, the sun and the floor.
//
// Every map keeps the same play space so stations, signs, the control centre and
// the wave mode work unchanged: a clear floor from x = -9.5 to 9.5 and z = -28 to 9.5,
// a solid face at |x| = 9.54 from z = -27 to 0 up to 4.5 m (wall signs hang there),
// a solid face at z = 9.7 up to 7.2 m (the chart hangs there), and the furnace
// against the +x side at z = -11.6.

export type RangeQuality = "HIGH" | "PERFORMANCE";

export const BRAND = 0x8ef5e3;
export const STRIKE_ORANGE = 0xe89a42;

export type Transform = { position: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] };

/** How the renderer should stage a map: sky, air and exposure. */
export type RangeLook = {
  /** Equirectangular HDR shown as the sky, or null for a sealed room. */
  sky: string | null;
  skyIntensity: number;
  /** Turn of the sky about the vertical axis, in radians. */
  skyRotation: number;
  /** Caps the sky's brightest pixels (the sun disc) so bloom and reflections stay in range. */
  skyClamp?: number;
  background: number;
  fog: number;
  fogDensity: number;
  haze: THREE.Color;
  hazeDensity: number;
  /** World height above which the air is clear, and how gradually it clears. */
  hazeCeiling: number;
  hazeFade: number;
  environmentIntensity: number;
  exposure: number;
  /** Camera far plane in metres. */
  far: number;
};

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
  look: RangeLook;
  /** 0..1 amount of direct sun reaching a point. */
  sunlitAt: (point: THREE.Vector3) => number;
  /** Replaces the sky IBL with a probe of the lit map. */
  captureProbe: (pmrem: THREE.PMREMGenerator) => THREE.WebGLRenderTarget;
  update: (now: number) => void;
  /** Called with the camera just before each frame is drawn, for whatever a map draws ahead of it. */
  beforeRender: (camera: THREE.PerspectiveCamera) => void;
  /** Something loud happened at `at` (a shot: loudness 1): birds take off, animals bolt. */
  startle?: (at: THREE.Vector3, loudness: number) => void;
  /**
   * A bullet struck one of this map's `shootable` objects. Return true when the map dealt
   * with it itself (an animal that bursts into feathers), so no bullet hole is left in mid-air.
   */
  struck?: (object: THREE.Object3D, point: THREE.Vector3) => boolean;
  dispose: () => void;
};

export type RangeOptions = {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  quality: RangeQuality;
  loadingManager: THREE.LoadingManager;
  /** Asks for one of the named sounds of range/cues.ts at a place in the world. Absent in tools and tests. */
  cue?: Cue;
  /**
   * True where something solid stands on the floor (the plan of range/solids.ts). It answers false
   * everywhere until the map has finished loading, so ask at walk time, not at build time.
   */
  blocked?: (x: number, z: number) => boolean;
};

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

export const worldBox = (w: number, h: number, d: number, metres: number) => projectUv(new THREE.BoxGeometry(w, h, d), metres);
export const softBox = (w: number, h: number, d: number, radius: number, metres: number) => projectUv(new RoundedBoxGeometry(w, h, d, 3, radius), metres);

/** Rolled steel I-section standing on the floor. */
export function iBeam(width: number, depth: number, height: number, flange: number, web: number) {
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
export function jerseyBarrier(length: number) {
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
export function crateGeometry(size: number) {
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
export function drumGeometry() {
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

export function softDiscTexture() {
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

export function hazardTexture() {
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

export const FIRE_SHADER = {
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

/** A canvas painted once and wrapped as a colour texture. */
export function canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void, repeat = false) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(leanCanvas(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * A wall slab standing on y = 0 and centred on x, pierced by round-headed openings.
 * `sill` raises an opening off the ground (a window instead of a doorway).
 */
export function archedWall(width: number, height: number, thickness: number, openings: Array<{ x: number; width: number; spring: number; sill?: number; flat?: boolean }>, metres = 2.4) {
  // Doorways are notched out of the outline (a hole may not touch its edge); windows are true holes.
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  for (const opening of [...openings].filter((o) => o.sill === undefined).sort((p, q) => p.x - q.x)) {
    const half = opening.width / 2;
    shape.lineTo(opening.x - half, 0);
    shape.lineTo(opening.x - half, opening.spring);
    if (opening.flat) shape.lineTo(opening.x + half, opening.spring);
    else shape.absarc(opening.x, opening.spring, half, Math.PI, 0, true);
    shape.lineTo(opening.x + half, 0);
  }
  shape.lineTo(width / 2, 0); shape.lineTo(width / 2, height); shape.lineTo(-width / 2, height); shape.closePath();
  for (const opening of openings) {
    if (opening.sill === undefined) continue;
    const half = opening.width / 2, sill = opening.sill;
    const hole = new THREE.Path();
    hole.moveTo(opening.x - half, sill);
    hole.lineTo(opening.x - half, opening.spring);
    if (opening.flat) hole.lineTo(opening.x + half, opening.spring);
    else hole.absarc(opening.x, opening.spring, half, Math.PI, 0, true);
    hole.lineTo(opening.x + half, sill);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 14 });
  geometry.translate(0, 0, -thickness / 2);
  return projectUv(geometry, metres);
}

/** Cloth hung between two edges along x, sagging in the middle; `depth` runs along z. */
export function clothGeometry(width: number, depth: number, sag: number, ripple = 0.03) {
  const geometry = new THREE.PlaneGeometry(width, depth, 24, 6);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const u = position.getX(i) / (width / 2), v = position.getZ(i) / (depth / 2);
    position.setY(i, -sag * (1 - u * u) * (1 - 0.25 * v * v) + Math.sin(u * 9 + v * 4) * ripple * (1 - u * u));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** True where a ray from `point` toward the sun clears every box: cheap direct-sun test for open-air maps. */
export function sunlitFromBoxes(toSun: THREE.Vector3, boxes: THREE.Box3[]) {
  const ray = new THREE.Ray(new THREE.Vector3(), toSun.clone().normalize());
  return (point: THREE.Vector3) => {
    ray.origin.copy(point);
    for (const box of boxes) if (ray.intersectsBox(box)) return 0;
    return 1;
  };
}

export type Kit = ReturnType<typeof createKit>;

/** Scene-building tools bound to one map: placement, instancing, texture loading and clean-up. */
export function createKit(options: RangeOptions) {
  const { scene, renderer, quality, loadingManager } = options;
  const high = quality === "HIGH";
  const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const shootable: THREE.Object3D[] = [];
  const mirrorHidden: THREE.Object3D[] = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const sets: PbrSet[] = [];
  const updates: Array<(now: number) => void> = [];
  /** Run with the camera just before each frame is drawn. */
  const frames: Array<(camera: THREE.PerspectiveCamera) => void> = [];
  const probeHidden: THREE.Object3D[] = [];
  const loader = new THREE.TextureLoader(loadingManager);

  /** Registers a generated set for disposal. */
  const keep = <T extends PbrSet>(set: T) => { sets.push(set); return set; };
  /** Registers anything with a `dispose` (textures, render targets) and returns it. */
  const track = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item; };

  /** Photographed PBR maps from `public/textures`; `ao` is optional because newer sets leave it out. */
  const photoSet = (root: string, repeatX: number, repeatY: number, ao = true) => {
    const folder = photoRoot(root);
    const maps = ["diffuse", "normal-gl", "roughness", ...(ao ? ["ao"] : [])].map((name) => {
      const texture = loader.load(`${folder}/${name}.jpg`);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeatX, repeatY);
      texture.anisotropy = anisotropy;
      disposables.push(texture);
      return texture;
    });
    maps[0].colorSpace = THREE.SRGBColorSpace;
    return { map: maps[0], normalMap: maps[1], roughnessMap: maps[2], ...(ao ? { aoMap: maps[3] } : {}) };
  };

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
      dummy.scale.set(...(transform.scale ?? [1, 1, 1]));
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

  /** The machine finishes the stations, control centre and furnace are made of, plus crate timber and drum paint. */
  const metals = () => {
    const machine = pbrMaterial(keep(paintedSteel(anisotropy, [0.04, 0.062, 0.068], 211, 0.12)), { envMapIntensity: 1 });
    const structural = pbrMaterial(keep(steel(anisotropy, [0.16, 0.17, 0.175], 0.58, 29)), { envMapIntensity: 0.9 });
    const darkMetal = pbrMaterial(keep(steel(anisotropy, [0.1, 0.11, 0.12], 0.46, 23)), { envMapIntensity: 1.1 });
    const brushed = pbrMaterial(keep(tile(brushedMetal(anisotropy, [0.5, 0.52, 0.53], 31), 3, 14)), { envMapIntensity: 1.1 });
    const crate = pbrMaterial(keep(timber(anisotropy, [0.11, 0.06, 0.028], [0.42, 0.27, 0.14], 4, 53)), { metalness: 0, envMapIntensity: 0.55 });
    return { machine, structural, darkMetal, brushed, crate };
  };

  /** The mirror-reflecting ground slab every map stands on. */
  const floor = (material: THREE.MeshStandardMaterial, size: { width: number; depth: number; z: number }, paint: FloorPaint, reflective = high) => {
    const reflection = createFloorReflection(renderer, reflective);
    applyWetFloor(material, reflection, paint);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.width, size.depth), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.z = size.z;
    mesh.receiveShadow = true;
    scene.add(mesh);
    shootable.push(mesh);
    mirrorHidden.push(mesh);
    return reflection;
  };

  /** Shadow-casting key light aimed at the middle of the range from `toSun`. */
  const sunLight = (config: { color: number; intensity: number; toSun: THREE.Vector3; extent?: number; distance?: number; near?: number; far?: number; radius?: number }) => {
    const sun = new THREE.DirectionalLight(config.color, config.intensity);
    const extent = config.extent ?? 24, distance = config.distance ?? 42;
    sun.target.position.set(0, 0, -9.5);
    sun.position.copy(sun.target.position).addScaledVector(config.toSun.clone().normalize(), distance);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(high ? 4096 : leanAssets() ? 1024 : 2048);
    sun.shadow.camera.left = -extent; sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent; sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.near = config.near ?? 8; sun.shadow.camera.far = config.far ?? 72;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = config.radius ?? 2.5;
    scene.add(sun, sun.target);
    return sun;
  };

  /** Drifting dust in the air; left out of mirror and probe renders. */
  const motes = (config: { count: number; x: number; y: [number, number]; z: [number, number]; color: number; size?: number; opacity?: number }) => {
    const map = track(softDiscTexture());
    const count = high ? config.count : Math.floor(config.count / 2);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * config.x;
      positions[i * 3 + 1] = config.y[0] + Math.random() * (config.y[1] - config.y[0]);
      positions[i * 3 + 2] = config.z[0] + Math.random() * (config.z[1] - config.z[0]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ map, color: config.color, size: config.size ?? 0.035, sizeAttenuation: true, transparent: true, opacity: config.opacity ?? 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(points);
    mirrorHidden.push(points);
    probeHidden.push(points);
    updates.push((now) => {
      points.rotation.y = now * 0.000012;
      points.position.y = Math.sin(now * 0.00021) * 0.12;
    });
    return points;
  };

  /** The strike furnace: same machine and interaction in every map. */
  const furnace = (materials: { machine: THREE.Material; darkMetal: THREE.Material; structural: THREE.Material; duct: THREE.Material }, flue = 2.7) => {
    const group = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    group.position.set(9.18, 0, -11.6);
    group.rotation.y = -Math.PI / 2;
    const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, utility = false) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (utility) { mesh.userData.utility = "furnace"; meshes.push(mesh); }
      group.add(mesh);
      return mesh;
    };
    part(softBox(3.3, 3.5, 1.15, 0.05, 1.6), materials.machine, 0, 1.75, 0);
    part(softBox(3.6, 0.22, 1.4, 0.03, 1.6), materials.darkMetal, 0, 0.11, 0.05);
    part(softBox(3.5, 0.16, 1.3, 0.03, 1.6), materials.darkMetal, 0, 3.56, 0.02);
    // Flue rising to the roof with a collar.
    part(new THREE.CylinderGeometry(0.3, 0.3, flue, 20), materials.duct, -1.05, 3.6 + flue / 2, -0.1);
    part(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 20), materials.structural, -1.05, 3.7, -0.1);
    const fire = new THREE.ShaderMaterial({ ...FIRE_SHADER, uniforms: { time: { value: 0 } }, toneMapped: false });
    part(new THREE.PlaneGeometry(2.42, 1.86), fire, 0, 1.68, 0.59, true).castShadow = false;
    const doorFrame = new THREE.Shape();
    doorFrame.moveTo(-1.425, -1.175); doorFrame.lineTo(1.425, -1.175); doorFrame.lineTo(1.425, 1.175); doorFrame.lineTo(-1.425, 1.175); doorFrame.closePath();
    const doorHole = new THREE.Path();
    doorHole.moveTo(-1.12, -0.81); doorHole.lineTo(-1.12, 0.81); doorHole.lineTo(1.12, 0.81); doorHole.lineTo(1.12, -0.81); doorHole.closePath();
    doorFrame.holes.push(doorHole);
    const doorGeometry = new THREE.ExtrudeGeometry(doorFrame, { depth: 0.2, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
    doorGeometry.translate(0, 0, -0.1);
    part(projectUv(doorGeometry, 1.2), materials.darkMetal, 0, 1.68, 0.71, true);
    for (const x of [-0.82, -0.41, 0, 0.41, 0.82]) part(softBox(0.075, 1.72, 0.08, 0.012, 1), materials.darkMetal, x, 1.68, 0.8);
    const bolt = new THREE.CylinderGeometry(0.034, 0.034, 0.05, 6);
    bolt.rotateX(Math.PI / 2);
    for (const x of [-1.3, -0.65, 0, 0.65, 1.3]) for (const y of [0.62, 2.74]) part(bolt, materials.structural, x, y, 0.83);
    for (const y of [1.15, 1.68, 2.21]) for (const x of [-1.3, 1.3]) part(bolt, materials.structural, x, y, 0.83);
    const light = new THREE.PointLight(0xff6817, 34, 11, 2);
    light.position.set(0, 1.7, 1.25);
    group.add(light);
    scene.add(group);
    shootable.push(...group.children.filter((child) => child instanceof THREE.Mesh));
    const glow: Glow = { position: new THREE.Vector3(), color: new THREE.Color() };
    updates.push((now) => {
      const seconds = now / 1000;
      fire.uniforms.time.value = seconds;
      const flicker = 0.78 + Math.sin(seconds * 11.3) * 0.08 + Math.sin(seconds * 23.7 + 1.3) * 0.06 + Math.sin(seconds * 5.1) * 0.08;
      light.intensity = 34 * flicker;
      light.getWorldPosition(glow.position);
      glow.color.setRGB(1, 0.36, 0.07).multiplyScalar(2.6 * flicker);
    });
    return { group, meshes, glow };
  };

  /** Assembles what the renderer needs from a finished map. */
  const finish = (parts: {
    furnace: { group: THREE.Group; meshes: THREE.Mesh[]; glow: Glow };
    materials: RangeEnvironment["materials"];
    sun: THREE.DirectionalLight;
    fills: THREE.PointLight[];
    reflection: FloorReflection;
    glows?: Glow[];
    look: RangeLook;
    sunlitAt: (point: THREE.Vector3) => number;
    probeAt?: THREE.Vector3;
  }): RangeEnvironment => ({
    shootable,
    furnaceMeshes: parts.furnace.meshes,
    furnace: parts.furnace.group,
    materials: parts.materials,
    sun: parts.sun,
    fills: parts.fills,
    reflection: parts.reflection,
    mirrorHidden,
    glows: [parts.furnace.glow, ...(parts.glows ?? [])],
    look: parts.look,
    sunlitAt: parts.sunlitAt,
    captureProbe(pmrem) {
      const visible = probeHidden.map((object) => object.visible);
      probeHidden.forEach((object) => { object.visible = false; });
      const strength = parts.reflection.uniforms.reflectionStrength.value;
      parts.reflection.uniforms.reflectionStrength.value = 0;
      const target = pmrem.fromScene(scene, 0, 0.1, parts.look.far, { size: 256, position: parts.probeAt ?? new THREE.Vector3(0, 2.3, -9) });
      parts.reflection.uniforms.reflectionStrength.value = strength;
      probeHidden.forEach((object, index) => { object.visible = visible[index]; });
      return target;
    },
    update(now) { updates.forEach((update) => update(now)); },
    beforeRender(camera) { frames.forEach((frame) => frame(camera)); },
    dispose() {
      sets.forEach(disposePbr);
      disposables.forEach((item) => item.dispose());
      parts.reflection.dispose();
    },
  });

  return { scene, renderer, high, anisotropy, shootable, mirrorHidden, probeHidden, updates, frames, keep, track, photoSet, place, instances, metals, floor, sunLight, motes, furnace, finish };
}

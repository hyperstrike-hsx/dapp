import * as THREE from "three";
import { polymer, steel, type PbrSet } from "./pbr";
import { AK_SKINS, NOISE_GLSL, RIFLE_SKINS, SKIN_COATS, SKIN_PARS, SKIN_VERTEX, SKIN_VERTEX_PARS, skinApply, type Skin } from "./skins";

// Weapon surfacing.
//
// The source model ships with flat colours and no usable UV layout, so the
// rifle is re-surfaced at load:
//   1. Every mesh is unwrapped by box projection in rifle space, giving all
//      parts the same texel density for tiling steel and polymer sets.
//   2. Hard convex edges are found geometrically and stored per triangle. The
//      shader turns the distance to those edges into wear: black oxide rubbed
//      back to bright steel on corners, paint worn through where it is handled.
//   3. A skin (see skins.ts) is painted over the finish and under that wear.
// This is the curvature-driven "smart material" approach used for hero props,
// computed in a few milliseconds instead of being baked into textures.

export type Finish = {
  set: PbrSet;
  wearColor: THREE.Color;
  wearRoughness: number;
  wearMetalness: number;
  wearAmount: number;
  options: THREE.MeshPhysicalMaterialParameters;
  /** Paint over the finish. */
  skin?: Skin;
};

export type WeaponSurfacing = {
  /** Muzzle crown and bore direction in the rifle root's local space. */
  muzzle: THREE.Vector3;
  bore: THREE.Vector3;
  /** Takes the model's own space into weapon space, for its skin. Set once the model is mounted. */
  frame: THREE.Matrix4;
  dispose: () => void;
};

const WEAR_KEY = "hyperstrike-weapon-wear-v2";

function skinUniforms(skin: Skin, frame: THREE.Matrix4) {
  const coats = Array.from({ length: SKIN_COATS }, (_, index) => skin.coats[index] ?? skin.coats[0]);
  return {
    skinFrame: { value: frame },
    skinColor: { value: coats.map((coat) => new THREE.Color(coat.color)) },
    skinFinish: { value: coats.map((coat) => new THREE.Vector2(coat.roughness, coat.metalness)) },
  };
}

/** Paints a skin over a material that keeps its own baked maps. Its meshes need an `aRifle` attribute. */
function skinMaterial(material: THREE.MeshStandardMaterial, skin: Skin, frame: THREE.Matrix4) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skinUniforms(skin, frame));
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 aRifle;\n${SKIN_VERTEX_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SKIN_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${NOISE_GLSL}${SKIN_PARS}`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${skinApply(skin.paint)}`);
  };
  material.customProgramCacheKey = () => `hyperstrike-skin:${skin.key}`;
  material.needsUpdate = true;
}

function wearMaterial(finish: Finish, wearWidth: number, noiseScale: number, frame: THREE.Matrix4) {
  const skin = finish.skin;
  const material = new THREE.MeshPhysicalMaterial({
    map: finish.set.map,
    normalMap: finish.set.normalMap,
    roughnessMap: finish.set.ormMap,
    metalnessMap: finish.set.ormMap,
    roughness: 1,
    metalness: 1,
    ...finish.options,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.wearColor = { value: finish.wearColor };
    shader.uniforms.wearSurface = { value: new THREE.Vector4(finish.wearRoughness, finish.wearMetalness, finish.wearAmount, wearWidth) };
    shader.uniforms.wearNoiseScale = { value: noiseScale };
    if (skin) Object.assign(shader.uniforms, skinUniforms(skin, frame));
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", /* glsl */`#include <common>
        attribute vec3 aBary;
        attribute vec3 aEdge;
        attribute vec3 aEdgeHeight;
        attribute vec3 aRifle;
        varying vec3 vBary;
        varying vec3 vEdge;
        varying vec3 vEdgeHeight;
        varying vec3 vRifle;
        ${skin ? SKIN_VERTEX_PARS : ""}
      `)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvBary = aBary; vEdge = aEdge; vEdgeHeight = aEdgeHeight; vRifle = aRifle; ${skin ? SKIN_VERTEX : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */`#include <common>
        uniform vec3 wearColor;
        uniform vec4 wearSurface;
        uniform float wearNoiseScale;
        varying vec3 vBary;
        varying vec3 vEdge;
        varying vec3 vEdgeHeight;
        varying vec3 vRifle;
        ${NOISE_GLSL}
        ${skin ? SKIN_PARS : ""}
      `)
      .replace("#include <metalnessmap_fragment>", /* glsl */`#include <metalnessmap_fragment>
        ${skin ? skinApply(skin.paint) : ""}
        {
          vec3 distanceToEdge = vBary * vEdgeHeight;
          // Small parts get proportionally thinner wear so they are never worn all over.
          vec3 width = min(vec3(wearSurface.w), vEdgeHeight * 0.3);
          vec3 band = vEdge * (1.0 - smoothstep(vec3(0.0), width, distanceToEdge));
          float edge = max(band.x, max(band.y, band.z));
          float breakup = wearFbm(vRifle * wearNoiseScale);
          float scuff = smoothstep(0.7, 0.86, wearFbm(vRifle * wearNoiseScale * 0.45 + 21.0)) * 0.55;
          float wear = clamp(max(smoothstep(0.34, 0.72, edge * (0.35 + breakup * 1.25)), scuff * breakup) * wearSurface.z, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, wearColor, wear);
          roughnessFactor = mix(roughnessFactor, wearSurface.x, wear);
          metalnessFactor = mix(metalnessFactor, wearSurface.y, wear);
          // Grime settles away from handled edges.
          float grime = smoothstep(0.45, 0.8, wearFbm(vRifle * wearNoiseScale * 0.8 + 5.0)) * (1.0 - edge) * 0.35;
          diffuseColor.rgb *= 1.0 - grime;
          roughnessFactor = min(1.0, roughnessFactor + grime * 0.3);
        }
      `);
  };
  material.customProgramCacheKey = () => `${WEAR_KEY}:${skin?.key ?? ""}`;
  return material;
}

/** Re-unwraps a mesh and bakes per-triangle hard-edge data. Positions are taken in rifle space. */
function surfaceGeometry(mesh: THREE.Mesh, toRifle: THREE.Matrix4, uvScale: number) {
  const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const position = source.attributes.position as THREE.BufferAttribute;
  const count = position.count, triangles = count / 3;
  const rifle = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const bary = new Float32Array(count * 3), edge = new Float32Array(count * 3), edgeHeight = new Float32Array(count * 3);
  const points: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    v.fromBufferAttribute(position, i).applyMatrix4(toRifle);
    points.push(v.clone());
    rifle.set([v.x, v.y, v.z], i * 3);
  }
  const quantum = 1 / (uvScale * 400);
  const key = (p: THREE.Vector3) => `${Math.round(p.x / quantum)},${Math.round(p.y / quantum)},${Math.round(p.z / quantum)}`;
  const keys = points.map(key);
  const normals: THREE.Vector3[] = [];
  const edges = new Map<string, Array<{ triangle: number; opposite: number }>>();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < triangles; t += 1) {
    const a = t * 3, b = a + 1, c = a + 2;
    const normal = ab.subVectors(points[b], points[a]).cross(ac.subVectors(points[c], points[a])).clone();
    const area = normal.length();
    normal.normalize();
    normals.push(normal);
    // Box projection per triangle keeps every face free of stretching.
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    for (const i of [a, b, c]) {
      const p = points[i];
      if (ax >= ay && ax >= az) uv.set([p.z * uvScale, p.y * uvScale], i * 2);
      else if (ay >= az) uv.set([p.x * uvScale, p.z * uvScale], i * 2);
      else uv.set([p.x * uvScale, p.y * uvScale], i * 2);
    }
    bary.set([1, 0, 0, 0, 1, 0, 0, 0, 1], a * 3);
    for (let corner = 0; corner < 3; corner += 1) {
      const p = a + (corner + 1) % 3, q = a + (corner + 2) % 3;
      const length = points[p].distanceTo(points[q]);
      const height = length > 0 ? area / length : 0;
      for (const i of [a, b, c]) edgeHeight[i * 3 + corner] = height;
      const id = keys[p] < keys[q] ? `${keys[p]}|${keys[q]}` : `${keys[q]}|${keys[p]}`;
      const list = edges.get(id);
      if (list) list.push({ triangle: t, opposite: a + corner });
      else edges.set(id, [{ triangle: t, opposite: a + corner }]);
    }
  }
  const offset = new THREE.Vector3();
  edges.forEach((faces) => {
    if (faces.length < 2) return;
    for (const face of faces) {
      let sharp = 0;
      for (const other of faces) {
        if (other === face) continue;
        const alignment = normals[face.triangle].dot(normals[other.triangle]);
        if (alignment > 0.78) continue;
        // Convex when the neighbouring triangle falls away behind this face.
        const anchor = points[face.triangle * 3 + ((face.opposite - face.triangle * 3 + 1) % 3)];
        if (offset.subVectors(points[other.opposite], anchor).dot(normals[face.triangle]) < -quantum * 0.25) {
          sharp = Math.max(sharp, THREE.MathUtils.clamp((0.78 - alignment) / 0.5 + 0.55, 0, 1));
        }
      }
      if (sharp > 0) {
        const corner = face.opposite - face.triangle * 3;
        for (let i = 0; i < 3; i += 1) edge[(face.triangle * 3 + i) * 3 + corner] = sharp;
      }
    }
  });
  source.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  source.setAttribute("aRifle", new THREE.BufferAttribute(rifle, 3));
  source.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
  source.setAttribute("aEdge", new THREE.BufferAttribute(edge, 3));
  source.setAttribute("aEdgeHeight", new THREE.BufferAttribute(edgeHeight, 3));
  return source;
}

/** Re-surfaces the loaded rifle in place. `root` must not yet be parented. */
export function surfaceWeapon(root: THREE.Object3D, anisotropy: number): WeaponSurfacing {
  root.updateMatrixWorld(true);
  const length = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const span = Math.max(length.x, length.y, length.z);
  const uvScale = 5.5 / span;
  const wearWidth = span * 0.0075;
  const noiseScale = 46 / span;

  const sets = {
    black: steel(anisotropy, [0.034, 0.036, 0.041], 0.5, 101),
    bright: steel(anisotropy, [0.2, 0.205, 0.21], 0.36, 103),
    polymer: polymer(anisotropy, [0.026, 0.026, 0.028], 109),
    brass: steel(anisotropy, [0.72, 0.52, 0.2], 0.3, 113, 256),
    copper: steel(anisotropy, [0.66, 0.33, 0.17], 0.34, 127, 256),
  };
  const moulded = { metalness: 0, envMapIntensity: 0.85, normalScale: new THREE.Vector2(0.45, 0.45) };
  const finishes: Record<string, Finish> = {
    // Receiver, barrel, magazine: black oxide rubbed bright on its corners.
    Material_1: { set: sets.black, wearColor: new THREE.Color(0.52, 0.52, 0.5), wearRoughness: 0.3, wearMetalness: 1, wearAmount: 0.95, options: { envMapIntensity: 1.15 }, skin: AK_SKINS.Material_1 },
    // Furniture: black moulded panels, polished smooth where they are held.
    Material_2: { set: sets.polymer, wearColor: new THREE.Color(0.1, 0.1, 0.1), wearRoughness: 0.34, wearMetalness: 0, wearAmount: 0.75, options: moulded, skin: AK_SKINS.Material_2 },
    Material_3: { set: sets.black, wearColor: new THREE.Color(0.44, 0.44, 0.43), wearRoughness: 0.34, wearMetalness: 1, wearAmount: 0.85, options: { envMapIntensity: 1.1 }, skin: AK_SKINS.Material_3 },
    Material_4: { set: sets.polymer, wearColor: new THREE.Color(0.075, 0.07, 0.065), wearRoughness: 0.36, wearMetalness: 0, wearAmount: 0.8, options: moulded },
    // Bolt carrier: bare machined steel.
    Material_5: { set: sets.bright, wearColor: new THREE.Color(0.66, 0.66, 0.64), wearRoughness: 0.22, wearMetalness: 1, wearAmount: 0.7, options: { envMapIntensity: 1.25 }, skin: AK_SKINS.Material_5 },
    Round_1_Material_1: { set: sets.brass, wearColor: new THREE.Color(0.86, 0.68, 0.34), wearRoughness: 0.22, wearMetalness: 1, wearAmount: 0.4, options: {} },
    Round_1_Material_2: { set: sets.copper, wearColor: new THREE.Color(0.8, 0.46, 0.26), wearRoughness: 0.25, wearMetalness: 1, wearAmount: 0.4, options: {} },
  };
  const frame = new THREE.Matrix4();
  const materials = new Map<string, THREE.MeshPhysicalMaterial>();
  const geometries: THREE.BufferGeometry[] = [];
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const toRifle = new THREE.Matrix4();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const original = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.Material;
    const name = Object.keys(finishes).sort((x, y) => y.length - x.length).find((suffix) => original.name.endsWith(suffix)) ?? "Material_1";
    let material = materials.get(name);
    if (!material) {
      material = wearMaterial(finishes[name], wearWidth, noiseScale, frame);
      material.name = original.name;
      materials.set(name, material);
    }
    toRifle.multiplyMatrices(inverseRoot, child.matrixWorld);
    const geometry = surfaceGeometry(child, toRifle, uvScale);
    child.geometry.dispose();
    original.dispose();
    child.geometry = geometry;
    child.material = material;
    child.castShadow = true;
    child.receiveShadow = true;
    geometries.push(geometry);
  });
  // Locate the muzzle: the rifle's long axis, at whichever end is the slimmer one.
  const bounds = new THREE.Box3();
  geometries.forEach((geometry) => bounds.union(new THREE.Box3().setFromBufferAttribute(geometry.attributes.aRifle as THREE.BufferAttribute)));
  const extent = bounds.getSize(new THREE.Vector3());
  const axis = extent.x >= extent.y && extent.x >= extent.z ? "x" : extent.y >= extent.z ? "y" : "z";
  const ends = [new THREE.Box3(), new THREE.Box3()];
  const point = new THREE.Vector3();
  geometries.forEach((geometry) => {
    const rifle = geometry.attributes.aRifle;
    for (let i = 0; i < rifle.count; i += 1) {
      point.fromBufferAttribute(rifle, i);
      if (point[axis] < bounds.min[axis] + span * 0.02) ends[0].expandByPoint(point);
      else if (point[axis] > bounds.max[axis] - span * 0.02) ends[1].expandByPoint(point);
    }
  });
  const girth = ends.map((end) => { const size = end.getSize(new THREE.Vector3()); size[axis] = 0; return size.length(); });
  const front = girth[1] <= girth[0] ? 1 : 0;
  const muzzle = ends[front].getCenter(new THREE.Vector3());
  muzzle[axis] = front ? bounds.max[axis] : bounds.min[axis];
  const bore = new THREE.Vector3();
  bore[axis] = front ? 1 : -1;
  return {
    muzzle,
    bore,
    frame,
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      Object.values(sets).forEach((set) => { set.map.dispose(); set.normalMap.dispose(); set.ormMap.dispose(); });
    },
  };
}

/**
 * Prepares an authored rifle (baked PBR textures) for the viewmodel: shadows,
 * texture filtering, its skin, and the muzzle crown found geometrically — the
 * long axis, at whichever end is the slimmer one. Display-only props and the
 * cloth wrap that would hide the lacquered stock are removed.
 */
export function prepareRifle(root: THREE.Object3D, anisotropy: number): WeaponSurfacing {
  const props: THREE.Object3D[] = [];
  root.traverse((child) => { if (/bullet|wrap/i.test(child.name)) props.push(child); });
  props.forEach((prop) => prop.removeFromParent());
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    meshes.push(child);
    child.castShadow = true;
    child.receiveShadow = true;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      materials.add(material);
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 1.1;
        for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
          if (texture) { texture.anisotropy = anisotropy; textures.add(texture); }
        }
      }
    }
  });
  const bounds = new THREE.Box3();
  const toRoot = new THREE.Matrix4(), point = new THREE.Vector3();
  const each = (visit: (p: THREE.Vector3) => void) => meshes.forEach((mesh) => {
    toRoot.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) visit(point.fromBufferAttribute(position, i).applyMatrix4(toRoot));
  });
  // The skin is painted in the rifle's own space: every vertex carries where it rests there.
  const frame = new THREE.Matrix4();
  meshes.forEach((mesh) => {
    toRoot.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    const position = mesh.geometry.attributes.position;
    const rest = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) point.fromBufferAttribute(position, i).applyMatrix4(toRoot).toArray(rest, i * 3);
    mesh.geometry.setAttribute("aRifle", new THREE.BufferAttribute(rest, 3));
  });
  materials.forEach((material) => {
    const skin = RIFLE_SKINS[material.name];
    if (skin && material instanceof THREE.MeshStandardMaterial) skinMaterial(material, skin, frame);
  });
  each((p) => bounds.expandByPoint(p));
  const extent = bounds.getSize(new THREE.Vector3());
  const span = Math.max(extent.x, extent.y, extent.z);
  const axis = extent.x >= extent.y && extent.x >= extent.z ? "x" : extent.y >= extent.z ? "y" : "z";
  const ends = [new THREE.Box3(), new THREE.Box3()];
  each((p) => {
    if (p[axis] < bounds.min[axis] + span * 0.02) ends[0].expandByPoint(p);
    else if (p[axis] > bounds.max[axis] - span * 0.02) ends[1].expandByPoint(p);
  });
  const girth = ends.map((end) => { const size = end.getSize(new THREE.Vector3()); size[axis] = 0; return size.length(); });
  const front = girth[1] <= girth[0] ? 1 : 0;
  const muzzle = ends[front].getCenter(new THREE.Vector3());
  muzzle[axis] = front ? bounds.max[axis] : bounds.min[axis];
  const bore = new THREE.Vector3();
  bore[axis] = front ? 1 : -1;
  return {
    muzzle,
    bore,
    frame,
    dispose() {
      meshes.forEach((mesh) => mesh.geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
    },
  };
}

/** Shared finishes for weapons modelled in code. Each mesh names one in `userData.finish`. */
export type FinishKit = { finishes: Record<string, Finish>; dispose: () => void };

export function createFinishKit(anisotropy: number): FinishKit {
  const sets = {
    anodized: steel(anisotropy, [0.04, 0.042, 0.047], 0.54, 201),
    parkerized: steel(anisotropy, [0.058, 0.06, 0.064], 0.62, 203),
    blued: steel(anisotropy, [0.04, 0.042, 0.05], 0.42, 205),
    bright: steel(anisotropy, [0.46, 0.46, 0.45], 0.3, 207, 256),
    polymer: polymer(anisotropy, [0.026, 0.026, 0.028], 209),
    grey: polymer(anisotropy, [0.034, 0.036, 0.037], 211),
    rubber: polymer(anisotropy, [0.018, 0.018, 0.018], 213),
    brass: steel(anisotropy, [0.72, 0.52, 0.2], 0.3, 215, 256),
  };
  const metal = (set: PbrSet, wear: number, amount: number, env = 1.1, metalness = 1): Finish => ({ set, wearColor: new THREE.Color(wear, wear, wear * 0.98), wearRoughness: 0.32, wearMetalness: 1, wearAmount: amount, options: { envMapIntensity: env, metalness } });
  const plastic = (set: PbrSet, wear: number, amount: number): Finish => ({ set, wearColor: new THREE.Color(wear, wear, wear), wearRoughness: 0.4, wearMetalness: 0, wearAmount: amount, options: { metalness: 0, envMapIntensity: 0.8, normalScale: new THREE.Vector2(0.3, 0.3) } });
  return {
    finishes: {
      anodized: metal(sets.anodized, 0.5, 0.75, 0.8, 0.55),
      parkerized: metal(sets.parkerized, 0.52, 0.85, 0.85, 0.6),
      blued: metal(sets.blued, 0.5, 0.9, 1.2),
      bright: metal(sets.bright, 0.75, 0.6, 1.3),
      polymer: plastic(sets.polymer, 0.09, 0.7),
      grey: plastic(sets.grey, 0.12, 0.75),
      rubber: plastic(sets.rubber, 0.05, 0.4),
      brass: metal(sets.brass, 0.85, 0.3),
    },
    dispose() { Object.values(sets).forEach((set) => { set.map.dispose(); set.normalMap.dispose(); set.ormMap.dispose(); }); },
  };
}

/**
 * Surfaces every mesh under `root` that names a finish, painting `skins` (by finish name)
 * over them. `root` is the weapon's own space and must not yet be parented.
 */
export function surfaceBuilt(root: THREE.Object3D, kit: FinishKit, skins: Record<string, Skin> = {}) {
  root.updateMatrixWorld(true);
  const frame = new THREE.Matrix4();
  const materials = new Map<string, THREE.MeshPhysicalMaterial>();
  const geometries: THREE.BufferGeometry[] = [];
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const toRoot = new THREE.Matrix4();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.userData.finish) return;
    const name = child.userData.finish as string;
    let material = materials.get(name);
    if (!material) { material = wearMaterial(skins[name] ? { ...kit.finishes[name], skin: skins[name] } : kit.finishes[name], 0.0055, 60, frame); materials.set(name, material); }
    toRoot.multiplyMatrices(inverseRoot, child.matrixWorld);
    const geometry = surfaceGeometry(child, toRoot, 7);
    child.geometry.dispose();
    child.geometry = geometry;
    child.material = material;
    child.castShadow = true;
    child.receiveShadow = true;
    geometries.push(geometry);
  });
  return { dispose() { geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose()); } };
}

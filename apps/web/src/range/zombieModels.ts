import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

// Skinned zombies for the wave mode: ten bodies on two skeletons, each skeleton
// with its own retargeted clips. Files are in centimetres, Z-up under a rotated
// rig root, and animate in place. See public/models/README.md for the source.

const BASE = "/models/zombies";
/** Rig units are centimetres; this also brings the ~1.65 m bodies up to the height the mode is tuned for. */
export const MODEL_SCALE = 0.0105;

export type Skeleton = "male" | "female";
const FOLDER: Record<Skeleton, string> = { male: "ZombieMale", female: "ZombieFemale" };
const VARIANTS = ["A", "B", "C", "D", "E"];
const CLIP_FILES = {
  attackLeft: "attack_left_70f",
  attackRight: "attack_right_70f",
  alert: "idle_alert_120f",
  run: "running_58f",
  shamble: "slowWalk_85f",
  walk: "walk_64f",
  aggressive: "walk_agressive_64f",
  limp: "walk_limp_60f",
} as const;
export type ClipKey = keyof typeof CLIP_FILES;
export const GAITS: ClipKey[] = ["shamble", "limp", "walk", "aggressive", "run"];

export type ZombieLibrary = {
  variants: Array<{ scene: THREE.Object3D; skeleton: Skeleton }>;
  clips: Record<Skeleton, Record<ClipKey, THREE.AnimationClip>>;
  /** Ground speed each gait covers at normal playback, in metres per second at scale 1. */
  pace: Record<Skeleton, Record<ClipKey, number>>;
  dispose: () => void;
};

export type ZombieModel = {
  object: THREE.Object3D;
  skeleton: Skeleton;
  mixer: THREE.AnimationMixer;
  bone: (name: string) => THREE.Bone;
};

/** Bone names as GLTFLoader stores them ("bip L Forearm" becomes "bip_L_Forearm"). */
const node = (name: string) => THREE.PropertyBinding.sanitizeNodeName(name);
const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let shared: Promise<ZombieLibrary> | null = null;

/**
 * The bodies and their clips. Fetched and parsed once for the page: `dispose` on the result only
 * gives back what a renderer holds for it, so the next range (which has a renderer of its own)
 * gets the same library without the wait.
 */
export function loadZombies(): Promise<ZombieLibrary> {
  shared ??= fetchZombies().catch((error) => { shared = null; throw error; });
  return shared;
}

async function fetchZombies(): Promise<ZombieLibrary> {
  const manager = new THREE.LoadingManager();
  // Every file points at its own copy of the one palette texture; it is loaded once below instead.
  manager.setURLModifier((url) => (/zcolors\.png$/i.test(url) ? BLANK : url));
  const loader = new GLTFLoader(manager);
  const palette = await new THREE.TextureLoader().loadAsync(`${BASE}/Textures/zcolors.png`);
  palette.flipY = false;
  palette.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: palette, roughness: 0.86, metalness: 0, envMapIntensity: 0.6 });
  const geometries: THREE.BufferGeometry[] = [];

  /** Frees what a loaded file brought along that is not used. */
  const strip = (scene: THREE.Object3D, keepGeometry: boolean) => scene.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    const own = mesh.material as THREE.MeshStandardMaterial;
    own.map?.dispose();
    own.dispose();
    if (keepGeometry) { mesh.material = material; mesh.castShadow = true; mesh.frustumCulled = false; geometries.push(mesh.geometry); }
    else mesh.geometry.dispose();
  });

  const skeletons: Skeleton[] = ["male", "female"];
  const variants = (await Promise.all(skeletons.flatMap((skeleton) => VARIANTS.map(async (letter) => {
    const gltf = await loader.loadAsync(`${BASE}/rig-gltf_joined/${FOLDER[skeleton]}_${letter}_joined.gltf`);
    strip(gltf.scene, true);
    // The renderer wants a skinned mesh's bounds the first time it draws it, and works them out bone
    // by bone. Done here, every copy inherits them and no frame of the game pays for it.
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((child) => { if ((child as THREE.SkinnedMesh).isSkinnedMesh) (child as THREE.SkinnedMesh).computeBoundingSphere(); });
    return { scene: gltf.scene, skeleton };
  }))));

  const clips = { male: {}, female: {} } as ZombieLibrary["clips"];
  const pace = { male: {}, female: {} } as ZombieLibrary["pace"];
  await Promise.all(skeletons.flatMap((skeleton) => (Object.keys(CLIP_FILES) as ClipKey[]).map(async (key) => {
    const gltf = await loader.loadAsync(`${BASE}/animations-gltf/gltf_${FOLDER[skeleton]}/${FOLDER[skeleton]}@${CLIP_FILES[key]}.gltf`);
    strip(gltf.scene, false);
    const clip = gltf.animations[0];
    // Rotations drive the pose. Only the hips keep their motion, so severed parts can be scaled away.
    clip.tracks = clip.tracks.filter((track) => track.name.endsWith(".quaternion")
      || track.name === `${node("bip")}.position` || track.name === `${node("bip Pelvis")}.position`);
    clip.name = key;
    clip.resetDuration();
    clips[skeleton][key] = clip;
  })));

  // How far a foot sweeps under the body tells how fast each gait really covers ground,
  // so playback can be matched to movement and feet do not slide.
  const foot = new THREE.Vector3();
  for (const skeleton of skeletons) {
    const sample = cloneSkinned(variants.find((variant) => variant.skeleton === skeleton)!.scene);
    const mixer = new THREE.AnimationMixer(sample);
    const left = sample.getObjectByName(node("bip L Foot"))!;
    for (const key of Object.keys(CLIP_FILES) as ClipKey[]) {
      const clip = clips[skeleton][key];
      const action = mixer.clipAction(clip);
      action.play();
      // A foot travels back under the body and forward again once per stride, however many strides the clip holds.
      let travel = 0, lastZ = 0;
      for (let i = 0; i <= 64; i += 1) {
        mixer.setTime((clip.duration * i) / 64);
        sample.updateMatrixWorld(true);
        left.getWorldPosition(foot);
        if (i > 0) travel += Math.abs(foot.z - lastZ);
        lastZ = foot.z;
      }
      action.stop();
      pace[skeleton][key] = (travel * MODEL_SCALE) / clip.duration;
    }
    mixer.uncacheRoot(sample);
  }

  return {
    variants,
    clips,
    pace,
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      material.dispose();
      palette.dispose();
    },
  };
}

/** An independent copy of one body, with its own skeleton and mixer. */
export function createZombieModel(library: ZombieLibrary, index: number): ZombieModel {
  const variant = library.variants[index % library.variants.length];
  const object = cloneSkinned(variant.scene);
  object.scale.setScalar(MODEL_SCALE);
  return {
    object,
    skeleton: variant.skeleton,
    mixer: new THREE.AnimationMixer(object),
    bone: (name) => {
      const found = object.getObjectByName(node(name));
      if (!found) throw new Error(`Zombie rig has no bone "${name}"`);
      return found as THREE.Bone;
    },
  };
}

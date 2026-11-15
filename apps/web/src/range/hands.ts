import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { disposePbr, pbrMaterial, polymer, tile } from "./pbr";

// First-person arms.
//
// Gloved hands with fully articulated fingers and sleeved forearms, built in
// real metres. A hand is posed by where its palm is, which way the fingers
// point and which way the palm faces — far easier to author than Euler angles —
// plus a curl per finger. Forearms simply run from each wrist toward an elbow
// that stays put off-screen, which is what a shouldered arm looks like in view.

type V3 = [number, number, number];
export type HandPose = { p: V3; f: V3; n: V3; curl: number | number[] };
export type ResolvedPose = { position: THREE.Vector3; quaternion: THREE.Quaternion; curl: number[] };

const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3(), basis = new THREE.Matrix4();

/** Local -Z follows the fingers, local -Y is the direction the palm faces. */
export function resolvePose(pose: HandPose): ResolvedPose {
  bz.set(...pose.f).normalize().negate();
  by.set(...pose.n).negate();
  by.addScaledVector(bz, -by.dot(bz)).normalize();
  bx.crossVectors(by, bz);
  basis.makeBasis(bx, by, bz);
  const curl = typeof pose.curl === "number" ? [pose.curl, pose.curl, pose.curl, pose.curl, pose.curl] : pose.curl;
  return { position: new THREE.Vector3(...pose.p), quaternion: new THREE.Quaternion().setFromRotationMatrix(basis), curl: [...curl] };
}

export function blendPose(a: ResolvedPose, b: ResolvedPose, t: number, out: ResolvedPose) {
  out.position.lerpVectors(a.position, b.position, t);
  out.quaternion.slerpQuaternions(a.quaternion, b.quaternion, t);
  for (let i = 0; i < 5; i += 1) out.curl[i] = a.curl[i] + (b.curl[i] - a.curl[i]) * t;
  return out;
}

export function emptyPose(): ResolvedPose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), curl: [0, 0, 0, 0, 0] };
}

export type Arm = { apply: (pose: ResolvedPose) => void; elbow: THREE.Vector3 };
export type Arms = {
  /** Add to the group that carries the weapon (hands follow it). */
  hands: THREE.Group;
  /** Add to the steady parent of that group (elbows do not follow the weapon). */
  sleeves: THREE.Group;
  left: Arm;
  right: Arm;
  update: () => void;
  dispose: () => void;
};

const FINGERS = [
  { x: -0.0315, lengths: [0.043, 0.026, 0.022], radius: 0.0102, splay: 0.07 },
  { x: -0.0105, lengths: [0.047, 0.03, 0.023], radius: 0.0105, splay: 0.02 },
  { x: 0.0105, lengths: [0.043, 0.027, 0.022], radius: 0.01, splay: -0.03 },
  { x: 0.0305, lengths: [0.034, 0.02, 0.019], radius: 0.009, splay: -0.09 },
];
const WRIST = 0.082;

export function createArms(anisotropy: number): Arms {
  const sets = [
    tile(polymer(anisotropy, [0.05, 0.052, 0.055], 171), 3, 3),
    tile(polymer(anisotropy, [0.012, 0.012, 0.014], 173), 2, 2),
    tile(polymer(anisotropy, [0.055, 0.062, 0.05], 177), 5, 9),
  ];
  const glove = pbrMaterial(sets[0], { envMapIntensity: 0.6 });
  const armour = pbrMaterial(sets[1], { envMapIntensity: 0.9 });
  armour.roughness = 0.7;
  const sleeve = pbrMaterial(sets[2], { envMapIntensity: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x06100f, emissive: 0x8ef5e3, emissiveIntensity: 0.5, roughness: 0.15, metalness: 0.2 });
  const geometries: THREE.BufferGeometry[] = [];
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D) => {
    geometries.push(geometry);
    const object = new THREE.Mesh(geometry, material);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  };
  const segment = (radius: number, length: number) => {
    const geometry = new THREE.CapsuleGeometry(radius, length, 3, 9);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, -length / 2);
    return geometry;
  };

  const hands = new THREE.Group(), sleeves = new THREE.Group();
  const wristPoint = new THREE.Vector3(), elbowPoint = new THREE.Vector3();
  const updates: Array<() => void> = [];

  const build = (mirror: boolean, elbow: THREE.Vector3): Arm => {
    const wrist = new THREE.Group();
    const hand = new THREE.Group();
    if (mirror) hand.scale.x = -1;
    wrist.add(hand);
    hands.add(wrist);
    mesh(new RoundedBoxGeometry(0.086, 0.03, 0.1, 2, 0.012), glove, hand);
    const thenar = mesh(new THREE.SphereGeometry(0.022, 10, 8), glove, hand);
    thenar.position.set(-0.026, -0.006, 0.02);
    thenar.scale.set(1, 0.75, 1.5);
    const plate = mesh(new RoundedBoxGeometry(0.074, 0.012, 0.03, 1, 0.005), armour, hand);
    plate.position.set(0, 0.017, -0.036);
    const backPad = mesh(new RoundedBoxGeometry(0.06, 0.008, 0.042, 1, 0.003), armour, hand);
    backPad.position.set(0.002, 0.016, 0.012);
    const cuff = mesh(new THREE.CylinderGeometry(0.035, 0.033, 0.05, 14), glove, hand);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.z = 0.068;
    cuff.scale.z = 0.76;
    const strap = mesh(new RoundedBoxGeometry(0.05, 0.006, 0.022, 1, 0.002), armour, hand);
    strap.position.set(0, 0.027, 0.07);
    if (mirror) {
      const watch = mesh(new RoundedBoxGeometry(0.032, 0.009, 0.032, 1, 0.003), armour, hand);
      watch.position.set(0, 0.031, 0.098);
      const face = mesh(new THREE.PlaneGeometry(0.022, 0.022), glass, hand);
      face.rotation.x = -Math.PI / 2;
      face.position.set(0, 0.0358, 0.098);
      face.castShadow = false;
    }
    const joints: THREE.Group[][] = FINGERS.map((finger) => {
      let parent: THREE.Object3D = hand;
      return finger.lengths.map((length, index) => {
        const joint = new THREE.Group();
        if (index === 0) { joint.position.set(finger.x, -0.002, -0.05); joint.rotation.order = "YXZ"; joint.rotation.y = finger.splay; }
        else joint.position.z = -finger.lengths[index - 1];
        parent.add(joint);
        mesh(segment(finger.radius * (1 - index * 0.07), length), glove, joint);
        if (index === 0) {
          const knuckle = mesh(new THREE.SphereGeometry(finger.radius * 1.12, 8, 6), armour, joint);
          knuckle.position.y = 0.003;
        }
        parent = joint;
        return joint;
      });
    });
    const thumb: THREE.Group[] = [];
    let parent: THREE.Object3D = hand;
    [0.04, 0.032, 0.027].forEach((length, index) => {
      const joint = new THREE.Group();
      joint.rotation.order = "YXZ";
      if (index === 0) joint.position.set(-0.034, -0.006, 0.026);
      else joint.position.z = -[0.04, 0.032][index - 1];
      parent.add(joint);
      mesh(segment(0.0125 - index * 0.001, length), glove, joint);
      parent = joint;
      thumb.push(joint);
    });

    const forearm = new THREE.Group();
    const sleeveGeometry = new THREE.CylinderGeometry(0.056, 0.037, 0.52, 16, 1);
    sleeveGeometry.rotateX(Math.PI / 2);
    sleeveGeometry.translate(0, 0, 0.26);
    const sleeveMesh = mesh(sleeveGeometry, sleeve, forearm);
    sleeveMesh.scale.set(1, 0.86, 1);
    for (const z of [0.05, 0.17, 0.3]) {
      const fold = mesh(new THREE.TorusGeometry(0.039 + z * 0.037, 0.0045, 6, 18), sleeve, forearm);
      fold.position.z = z;
      fold.rotation.set(0.25 - z, 0.2, 0);
      fold.scale.y = 0.86;
    }
    sleeves.add(forearm);

    updates.push(() => {
      hand.localToWorld(wristPoint.set(0, 0, WRIST));
      forearm.position.copy(sleeves.worldToLocal(wristPoint));
      forearm.lookAt(sleeves.localToWorld(elbowPoint.copy(elbow)));
    });

    return {
      elbow,
      apply(pose) {
        wrist.position.copy(pose.position);
        wrist.quaternion.copy(pose.quaternion);
        joints.forEach((finger, index) => {
          const c = pose.curl[index];
          finger[0].rotation.x = -c * 1.2;
          finger[1].rotation.x = -c * 1.5;
          finger[2].rotation.x = -c * 0.95;
        });
        const c = pose.curl[4];
        thumb[0].rotation.set(-0.3 - c * 0.35, 0.95 - c * 0.5, 0);
        thumb[1].rotation.y = -c * 0.75;
        thumb[2].rotation.y = -c * 0.7;
      },
    };
  };

  const right = build(false, new THREE.Vector3(0.1, -0.34, 0.5));
  const left = build(true, new THREE.Vector3(-0.36, -0.4, 0.34));

  return {
    hands,
    sleeves,
    left,
    right,
    update() {
      hands.updateWorldMatrix(true, true);
      sleeves.updateWorldMatrix(true, false);
      updates.forEach((update) => update());
    },
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      [glove, armour, sleeve, glass].forEach((material) => material.dispose());
      sets.forEach(disposePbr);
    },
  };
}

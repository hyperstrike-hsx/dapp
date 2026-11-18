import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Collider, Contact } from "./collider";

// First-person arms.
//
// A skinned, sculpted pair of arms (see public/models/README.md) driven by code.
// A hand is posed by where its palm is, which way the fingers point and which
// way the palm faces — far easier to author than Euler angles — plus a curl per
// finger. Each forearm runs from its wrist toward an elbow that stays put
// off-screen, which is what a shouldered arm looks like in view.

type V3 = [number, number, number];
export type HandPose = { p: V3; f: V3; n: V3; curl: number | number[] };
/** `flex` holds the bend of every finger joint in radians: three per finger, index to little finger, then the thumb. */
export type ResolvedPose = { position: THREE.Vector3; quaternion: THREE.Quaternion; flex: number[] };

const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3(), basis = new THREE.Matrix4();

/** Local -Z follows the fingers, local -Y is the direction the palm faces. */
export function resolvePose(pose: HandPose): ResolvedPose {
  bz.set(...pose.f).normalize().negate();
  by.set(...pose.n).negate();
  by.addScaledVector(bz, -by.dot(bz)).normalize();
  bx.crossVectors(by, bz);
  basis.makeBasis(bx, by, bz);
  const curl = typeof pose.curl === "number" ? [pose.curl, pose.curl, pose.curl, pose.curl, pose.curl] : pose.curl;
  const flex: number[] = [];
  curl.forEach((c, finger) => (finger < 4 ? TUNING.finger : TUNING.thumb).forEach((gain) => flex.push((c - TUNING.restCurl) * gain)));
  return { position: new THREE.Vector3(...pose.p), quaternion: new THREE.Quaternion().setFromRotationMatrix(basis), flex };
}

export function blendPose(a: ResolvedPose, b: ResolvedPose, t: number, out: ResolvedPose) {
  out.position.lerpVectors(a.position, b.position, t);
  out.quaternion.slerpQuaternions(a.quaternion, b.quaternion, t);
  for (let i = 0; i < 15; i += 1) out.flex[i] = a.flex[i] + (b.flex[i] - a.flex[i]) * t;
  return out;
}

export function emptyPose(): ResolvedPose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), flex: new Array<number>(15).fill(0) };
}

export type Arm = { apply: (pose: ResolvedPose) => void; elbow: THREE.Vector3 };
export type Arms = {
  /** Add to the group that carries the weapon (hands follow it). */
  hands: THREE.Group;
  /** Add to the steady parent of that group (elbows do not follow the weapon). */
  sleeves: THREE.Group;
  left: Arm;
  right: Arm;
  tuning: typeof TUNING;
  /** False until the model has loaded. */
  ready: () => boolean;
  /**
   * Seats a resting grip on a weapon: the palm settles onto the surface and the hand slides
   * along its length until the knuckles sit just past the edge of what it holds.
   */
  fit: (pose: ResolvedPose, left: boolean, contact: Contact) => void;
  /**
   * Poses the arms for the frame. With `contact`, hands collide with the weapon: palms are
   * pushed out of it and every finger closes only as far as the surface allows.
   */
  update: (contact?: Contact | null) => void;
  /** Share of each hand's surface that is inside the weapon, and how deep the worst point is (metres). */
  penetration: (contact: Contact) => { left: number; right: number; depth: number; bones: Record<string, number>; moved: number[]; bent: number[][]; fixed: number[] };
  dispose: () => void;
};

/** How the authored poses map onto the model's hands. Lengths are in the model's centimetres. */
const TUNING = {
  /** Model size relative to life size. */
  scale: 1,
  /**
   * Where a pose's origin sits in the model: back from the knuckles, and off the bones toward the back of the
   * hand. The model's bones run along the back of a thick gloved hand, so the origin is moved into the palm
   * until the palm's skin is `palm` metres in front of it, which is what the poses were authored against.
   */
  palmBack: 5, palmLift: -2.5,
  /** Radians of flex per unit curl for the three joints of a finger, then of the thumb. */
  finger: [1.4, 1.6, 1], thumb: [0.5, 0.7, 0.6],
  /** Curl already present in the model's relaxed rest pose. */
  restCurl: 0.12,
  /** Contact, in metres: how far the palm's skin and the back of the hand are from a pose's origin, how far a resting palm may be drawn in, and how far a hand may slide to seat. */
  palm: 0.015, back: 0.04, reach: 0.035, seat: 0.03,
  /** Measured radii of the three bones of a finger, then of the thumb, and of the ball of the thumb. */
  fingerRadius: [0.0135, 0.0115, 0.0095], thumbRadius: [0.02, 0.0145, 0.0115], thenar: 0.026,
  /** How far each joint of a gripping finger may close past its authored bend to reach the surface, and its limit. */
  wrapPast: 0.45, wrap: [1.5, 1.75, 1.2],
  /** The sleeved forearm as the weapon feels it: radius near the elbow, and length. */
  sleeveRadius: 0.042, sleeveLength: 0.24,
  /** How far the padding of the palm compresses against what it holds. */
  soft: 0.007,
  /** How far a hand may be moved off its authored place to clear the weapon; past that it stays put. */
  give: 0.035,
};

type Flex = { bone: THREE.Bone; rest: THREE.Quaternion; axis: THREE.Vector3 };
type SideRig = {
  upper: THREE.Bone; fore: THREE.Bone; wrist: THREE.Bone;
  upperLength: number; foreLength: number;
  wristRestInverse: THREE.Quaternion; foreRestInverse: THREE.Quaternion;
  /** Model wrist bone relative to the authored hand frame. */
  offset: THREE.Matrix4;
  fingers: Flex[][];
  thumb: Flex[];
  /** Fingertip bones, index to little finger then thumb. */
  tips: THREE.Bone[];
  /** Axis, in the thumb's first bone, that swings it across the palm's plane. */
  thumbSwing: THREE.Vector3;
  /**
   * Points just under the skin of the palm, the heel of the hand and the ball of the thumb, in the
   * hand's frame. Those on the ball of the thumb also carry their place in the thumb's first bone.
   */
  skin: Array<{ at: THREE.Vector3; out: THREE.Vector3; onThumb?: THREE.Vector3; outOnThumb?: THREE.Vector3 }>;
};
type Side = {
  target: THREE.Group; elbow: THREE.Vector3; left: boolean; rig?: SideRig;
  /** Authored joint bends for the frame, the bends the surface allows, and what is shown (eased). */
  flex: number[]; solved: number[]; shown: number[];
  /** How far the thumb is swung aside to clear the weapon: solved, and shown. */
  swing: number; swingShown: number;
  /** What the last solve was for, so a hand that has not moved is not solved again. */
  stamp: string;
  /** Where the elbow has been moved to keep the sleeve out of the weapon: solved, and shown. */
  elbowShift: THREE.Vector3; elbowShown: THREE.Vector3;
  /** Where the hand ended up after being pushed out of the weapon. */
  settled: THREE.Vector3; authored: THREE.Vector3;
};

const FORWARD = new THREE.Vector3(0, 0, -1), ONE = new THREE.Vector3(1, 1, 1);

export function createArms(anisotropy: number, manager: THREE.LoadingManager, isDisposed: () => boolean): Arms {
  const hands = new THREE.Group(), sleeves = new THREE.Group();
  const side = (left: boolean, elbow: THREE.Vector3): Side => {
    const target = new THREE.Group();
    hands.add(target);
    return { target, elbow, left, flex: new Array<number>(15).fill(0), solved: new Array<number>(15).fill(0), shown: new Array<number>(15).fill(0), swing: 0, swingShown: 0, stamp: "", elbowShift: new THREE.Vector3(), elbowShown: new THREE.Vector3(), settled: new THREE.Vector3(), authored: new THREE.Vector3() };
  };
  const sides = [side(false, new THREE.Vector3(0.17, -0.3, 0.42)), side(true, new THREE.Vector3(-0.4, -0.25, 0.02))];
  const arm = (s: Side): Arm => ({
    elbow: s.elbow,
    apply(pose) {
      s.target.position.copy(pose.position);
      s.target.quaternion.copy(pose.quaternion);
      for (let i = 0; i < 15; i += 1) s.flex[i] = pose.flex[i];
    },
  });

  let model: THREE.Object3D | undefined, space: THREE.Object3D | undefined;
  const chestRest = new THREE.Matrix4();

  new GLTFLoader(manager).load("/models/arms/scene.gltf", ({ scene }) => {
    if (isDisposed()) { release(scene); return; }
    const bones = new Map<string, THREE.Bone>();
    let skinned: THREE.SkinnedMesh | undefined;
    scene.traverse((object) => {
      if ((object as THREE.Bone).isBone) bones.set(object.name.replace(/_\d+$/, ""), object as THREE.Bone);
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      if (mesh.isSkinnedMesh) skinned = mesh;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const material = mesh.material as THREE.MeshStandardMaterial;
      [material.map, material.normalMap, material.roughnessMap].forEach((texture) => { if (texture) texture.anisotropy = anisotropy; });
    });
    const chest = bones.get("chest");
    if (!chest?.parent) return;
    scene.scale.setScalar(0.01 * TUNING.scale);
    sleeves.add(scene);
    scene.updateWorldMatrix(true, true);
    const root = chest.parent;
    const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const rest = (bone: THREE.Object3D) => new THREE.Matrix4().multiplyMatrices(inverse, bone.matrixWorld);
    const at = (bone: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(rest(bone));
    const turn = (bone: THREE.Object3D) => new THREE.Quaternion().setFromRotationMatrix(rest(bone));
    chestRest.copy(rest(chest));
    // A skinned mesh only refreshes its bind transform here, and reading vertices needs it.
    scene.updateMatrixWorld(true);
    skinned?.skeleton.update();

    for (const s of sides) {
      const get = (name: string) => bones.get(`${s.left ? "L" : "R"}_${name}`);
      const upper = get("arm"), fore = get("elbow"), wrist = get("wrist");
      const chains = ["point", "middle", "ring", "pink", "thumb"].map((name) => [1, 2, 3, 4].map((n) => get(`${name}${n}`)));
      if (!upper || !fore || !wrist || chains.some((chain) => chain.some((bone) => !bone))) return;
      const chain = (index: number) => chains[index] as THREE.Bone[];
      const wristAt = at(wrist);
      const knuckles = at(chain(1)[0]).add(at(chain(2)[0])).multiplyScalar(0.5);
      const f = knuckles.clone().sub(wristAt).normalize();
      const across = at(chain(0)[0]).sub(at(chain(3)[0]));
      across.addScaledVector(f, -across.dot(f)).normalize();
      const facing = new THREE.Vector3().crossVectors(f, across).multiplyScalar(s.left ? 1 : -1);
      const y = facing.clone().negate(), z = f.clone().negate(), x = new THREE.Vector3().crossVectors(y, z);
      const origin = knuckles.clone().addScaledVector(f, -TUNING.palmBack).addScaledVector(facing, -TUNING.palmLift);
      const frame = new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
      const skin = sampleSkin(skinned, new Set([wrist, get("palm"), chain(4)[0]]), chain(4)[0], frame, root);
      const flex = (list: THREE.Bone[], toward: (from: THREE.Vector3) => THREE.Vector3): Flex[] => list.slice(0, 3).map((bone, index) => {
        const from = at(bone), along = at(list[index + 1]).sub(from).normalize();
        const axis = new THREE.Vector3().crossVectors(along, toward(from)).normalize();
        return { bone, rest: bone.quaternion.clone(), axis: axis.applyQuaternion(turn(bone).invert()) };
      });
      const grasp = origin.clone().addScaledVector(facing, 4.5).addScaledVector(f, 2.5);
      s.rig = {
        upper, fore, wrist,
        upperLength: fore.position.length(), foreLength: wrist.position.length(),
        wristRestInverse: wrist.quaternion.clone().invert(), foreRestInverse: fore.quaternion.clone().invert(),
        offset: frame.invert().multiply(rest(wrist)),
        fingers: [0, 1, 2, 3].map((index) => flex(chain(index), () => facing)),
        thumb: flex(chain(4), (from) => grasp.clone().sub(from).normalize()),
        tips: [0, 1, 2, 3, 4].map((index) => chain(index)[3]),
        thumbSwing: facing.clone().applyQuaternion(turn(chain(4)[0]).invert()),
        skin,
      };
    }
    model = scene;
    space = root;
  });

  const m = new THREE.Matrix4(), inv = new THREE.Matrix4(), parent = new THREE.Matrix4(), wristMatrix = new THREE.Matrix4(), boneMatrix = new THREE.Matrix4();
  const p = new THREE.Vector3(), scale = new THREE.Vector3(), e = new THREE.Vector3(), dir = new THREE.Vector3(), axis = new THREE.Vector3(), back = new THREE.Vector3();
  const q = new THREE.Quaternion(), wq = new THREE.Quaternion(), fq = new THREE.Quaternion(), uq = new THREE.Quaternion(), swing = new THREE.Quaternion(), bend = new THREE.Quaternion();
  const place = (bone: THREE.Bone, world: THREE.Matrix4) => {
    m.copy(parent).invert().multiply(world).decompose(bone.position, bone.quaternion, bone.scale);
    parent.copy(world);
  };
  const curlTo = (joint: Flex, angle: number) => joint.bone.quaternion.copy(joint.rest).multiply(bend.setFromAxisAngle(joint.axis, angle));

  const begin = () => {
    if (!model || !space) return false;
    hands.updateWorldMatrix(true, true);
    sleeves.updateWorldMatrix(true, false);
    space.updateWorldMatrix(true, false);
    inv.copy(space.matrixWorld).invert();
    return true;
  };
  const solve = (s: Side) => {
      const rig = s.rig;
      if (!rig) return;
      // Wrist: the authored hand frame, expressed in the armature's space.
      m.multiplyMatrices(inv, s.target.matrixWorld).decompose(p, q, scale);
      wristMatrix.compose(p, q, ONE).multiply(rig.offset);
      wristMatrix.decompose(p, wq, scale);
      // Forearm: from the wrist toward the elbow anchor, twisting with the hand so the cuff never wrings.
      e.copy(s.elbow).add(s.elbowShown).applyMatrix4(sleeves.matrixWorld).applyMatrix4(inv);
      dir.copy(e).sub(p).normalize();
      e.copy(p).addScaledVector(dir, rig.foreLength);
      fq.copy(wq).multiply(rig.wristRestInverse);
      swing.setFromUnitVectors(axis.copy(FORWARD).applyQuaternion(fq), dir.negate());
      fq.premultiply(swing);
      // Upper arm: carries on behind and below the view.
      back.set(s.left ? -0.25 : 0.2, -0.7, 0.9).transformDirection(sleeves.matrixWorld).transformDirection(inv);
      dir.negate().add(back).normalize();
      uq.copy(fq).multiply(rig.foreRestInverse);
      swing.setFromUnitVectors(axis.copy(FORWARD).applyQuaternion(uq), back.copy(dir).negate());
      uq.premultiply(swing);
      parent.copy(chestRest);
      place(rig.upper, boneMatrix.compose(back.copy(e).addScaledVector(dir, rig.upperLength), uq, ONE));
      place(rig.fore, boneMatrix.compose(e, fq, ONE));
      place(rig.wrist, wristMatrix);
  };
  const chainOf = (rig: SideRig, index: number) => (index < 4 ? rig.fingers[index] : rig.thumb);
  const swingQ = new THREE.Quaternion();
  /** The thumb's first joint: swung across the palm's plane, then bent. */
  const thumbTo = (rig: SideRig, swing: number, angle: number) => {
    const joint = rig.thumb[0];
    joint.bone.quaternion.copy(joint.rest).multiply(swingQ.setFromAxisAngle(rig.thumbSwing, swing)).multiply(bend.setFromAxisAngle(joint.axis, angle));
  };
  const show = (s: Side, angles: number[], swing: number) => {
    for (let index = 0; index < 5; index += 1) chainOf(s.rig!, index).forEach((joint, n) => curlTo(joint, angles[index * 3 + n]));
    thumbTo(s.rig!, swing, angles[12]);
  };

  // Collision. Everything below works in the `hands` group's space, which is the weapon's.
  const toHands = new THREE.Matrix4(), hit = new THREE.Vector3(), centre = new THREE.Vector3(), push = new THREE.Vector3(), point = new THREE.Vector3();
  const joints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  /** Spheres that stand for the palm, in the hand's own frame (right hand; mirrored for the left). */
  const SLAB = (TUNING.palm + TUNING.back) / 2, MID = (TUNING.back - TUNING.palm) / 2;
  const PALM: Array<[number, number, number, number]> = [
    [-0.02, MID, -0.03, SLAB], [0.02, MID, -0.03, SLAB], [-0.02, MID, 0.015, SLAB], [0.02, MID, 0.015, SLAB],
    [0, MID, 0.05, SLAB], [-0.045, MID - 0.004, 0.02, TUNING.thenar],
  ];
  const SKIN_RADIUS = SKIN * 0.01 * TUNING.scale, UNDER = 0.02, push2 = new THREE.Vector3();
  /** Moves the hand out of the weapon. Returns false when the hand is nowhere near it. */
  const depenetrate = (s: Side, whole: Contact) => {
    // Only the fixed body pushes a hand away: parts it works or carries are there to be held.
    const contact = whole.body;
    if (whole.closest(s.target.position, 0.22) === Infinity) return false;
    let moved = 0;
    for (let pass = 0; pass < 10 && moved < TUNING.give; pass += 1) {
      let worst = 0;
      const probe = (radius: number, range: number) => {
        centre.applyQuaternion(s.target.quaternion).add(s.target.position);
        const distance = contact.closest(centre, range, hit);
        if (distance === Infinity || distance < 1e-6) return;
        if (radius + distance <= worst) return;
        const buried = contact.inside(centre);
        const depth = buried ? radius + distance : radius - distance;
        if (depth <= worst) return;
        worst = depth;
        push.subVectors(centre, hit).multiplyScalar((buried ? -1 : 1) / distance);
      };
      for (const [x, y, z, radius] of PALM) { centre.set(s.left ? -x : x, y, z); probe(radius, radius + 0.03); }
      // The skin itself: each patch is probed from inside the hand outward, so whatever it meets
      // pushes the hand back the way that patch faces, never through to the far side.
      for (const sample of s.rig!.skin) {
        // The ball of the thumb goes where the thumb goes: it is handled with the thumb.
        if (sample.onThumb) continue;
        push2.copy(sample.out).applyQuaternion(s.target.quaternion);
        centre.copy(sample.at).applyQuaternion(s.target.quaternion).add(s.target.position);
        const fraction = contact.segment(point.copy(centre).addScaledVector(push2, -UNDER), centre.addScaledVector(push2, SKIN_RADIUS));
        // A gloved palm gives a little where it presses on what it holds.
        const depth = (1 - fraction) * (UNDER + SKIN_RADIUS) - TUNING.soft;
        if (!(depth > worst)) continue;
        worst = depth;
        push.copy(push2).negate();
      }
      if (worst < 0.0004) break;
      const step = Math.min(worst, TUNING.give - moved);
      s.target.position.addScaledVector(push, step);
      moved += step;
    }
    return true;
  };
  /** Fingers are tested at full thickness first, then thinner: one lying along a surface is touching it, not blocked by it. */
  let slim = 1;
  const touches = (rig: SideRig, index: number, from: number, contact: Collider, moved = from) => {
    const chain = chainOf(rig, index), radii = index < 4 ? TUNING.fingerRadius : TUNING.thumbRadius;
    chain[moved].bone.updateWorldMatrix(false, true);
    chain.forEach((joint, n) => joints[n].setFromMatrixPosition(joint.bone.matrixWorld).applyMatrix4(toHands));
    joints[3].setFromMatrixPosition(rig.tips[index].matrixWorld).applyMatrix4(toHands);
    for (let n = from; n < 3; n += 1) for (const t of [0.34, 0.67, 1]) {
      if (contact.closest(point.lerpVectors(joints[n], joints[n + 1], t), radii[n] * slim) < radii[n] * slim) return true;
    }
    return false;
  };
  const thumbToHands = new THREE.Matrix4();
  const STEP = 0.11, OPEN = [-0.45, -0.1, -0.1], REACH_OUT = 0.06, way = new THREE.Vector3();
  /** Ways a hand can withdraw, in its own frame: off the back of the hand, and back along the fingers. */
  const WAYS_OUT = [[0, 1, 0], [0, 0, 1], [0, 0.7, 0.7]];
  /** Directions to try moving the thumb base in: [swing, lift] pairs, gentlest first. */
  const THUMB_WAYS = [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [0, -1], [1, -1], [-1, -1]];
  /** Limits of the thumb's base joint, in radians: how far back from the model's relaxed pose, how far in past the authored bend, and to either side. */
  const THUMB_BACK = -0.2, THUMB_IN = 1.2, THUMB_ASIDE = 0.45;
  /**
   * Each joint closes in turn, knuckle first, and stops just short of contact — the way a hand
   * wraps an object — so a finger follows a corner instead of cutting through it. The search
   * starts from last frame's answer, so a settled grip costs a couple of tests per joint.
   */
  const closeFingers = (s: Side, contact: Contact, mayPush: boolean) => {
    const rig = s.rig!;
    let worst = 0;
    rig.upper.updateWorldMatrix(true, true);
    toHands.copy(hands.matrixWorld).invert();
    // Thumb base: it cannot simply open like a finger, so when it is in the way it swings aside
    // or lifts by the smallest amount that clears, preferring where it was authored. Its first
    // bone is the ball of the thumb, which rests on what the palm holds and is handled with the palm.
    // The base is judged with the rest of the thumb held open, as it closes onto the surface afterwards.
    rig.thumb.forEach((joint, n) => curlTo(joint, Math.min(s.flex[12 + n], OPEN[n])));
    const thumbBone = rig.thumb[0].bone;
    /** How much of the thumb is in the way with its base swung and lifted like this: zero when it is clear. */
    const thumbBlocked = (swing: number, lift: number) => {
      thumbTo(rig, swing, s.flex[12] + lift);
      thumbBone.updateWorldMatrix(false, true);
      rig.thumb.forEach((joint, n) => joints[n].setFromMatrixPosition(joint.bone.matrixWorld).applyMatrix4(toHands));
      joints[3].setFromMatrixPosition(rig.tips[4].matrixWorld).applyMatrix4(toHands);
      let count = 0;
      for (let n = 1; n < 3; n += 1) for (const t of [0.34, 0.67, 1]) {
        const radius = TUNING.thumbRadius[n] * slim;
        if (contact.closest(point.lerpVectors(joints[n], joints[n + 1], t), radius) < radius) count += 3;
      }
      thumbToHands.multiplyMatrices(toHands, thumbBone.matrixWorld);
      for (const sample of rig.skin) {
        if (sample.onThumb && contact.body.closest(point.copy(sample.onThumb).applyMatrix4(thumbToHands), SKIN_RADIUS) < SKIN_RADIUS * 0.8 * slim) count += 1;
      }
      return count;
    };
    // The base joint only moves as far as a thumb can: a little back from relaxed, in across the
    // palm, a little to either side, the gentlest first. It is tried at full thickness, then
    // thinner, since a thumb lying along the weapon is resting on it rather than blocked by it.
    const lowest = Math.min(0, THUMB_BACK - s.flex[12]);
    let swing = 0, lift = 0, left = Infinity;
    for (const thin of [1, 0.55]) {
      slim = thin;
      left = Infinity;
      const attempt = (nextSwing: number, nextLift: number) => {
        if (left === 0) return;
        const count = thumbBlocked(nextSwing, nextLift);
        if (count < left) { swing = nextSwing; lift = nextLift; left = count; }
      };
      attempt(0, 0);
      attempt(THREE.MathUtils.clamp(s.swing, -THUMB_ASIDE, THUMB_ASIDE), THREE.MathUtils.clamp(s.solved[12] - s.flex[12], lowest, THUMB_IN));
      for (const reach of [0.25, 0.5, 0.75, 1]) for (const [a, b] of THUMB_WAYS) attempt(a * reach * THUMB_ASIDE, b < 0 ? -b * reach * lowest : b * reach * THUMB_IN);
      if (left === 0) break;
    }
    slim = 1;
    s.swing = swing;
    s.solved[12] = s.flex[12] + lift;
    thumbTo(rig, swing, s.solved[12]);
    if (left > 0) {
      // No way of holding the thumb clears the body: the hand gives way, as far as the ball of the thumb is in it.
      thumbBone.updateWorldMatrix(false, false);
      thumbToHands.multiplyMatrices(toHands, thumbBone.matrixWorld);
      for (const sample of rig.skin) {
        if (!sample.onThumb) continue;
        centre.copy(sample.outOnThumb!).transformDirection(thumbToHands);
        point.copy(sample.onThumb).applyMatrix4(thumbToHands);
        const fraction = contact.body.segment(hit.copy(point).addScaledVector(centre, -UNDER), point.addScaledVector(centre, SKIN_RADIUS));
        const depth = (1 - fraction) * (UNDER + SKIN_RADIUS);
        if (depth > worst) { worst = depth; push.copy(centre).negate(); }
      }
      worst = Math.min(worst, 0.008);
    }

    for (let index = 0; index < 5; index += 1) {
      const chain = chainOf(rig, index), base = index * 3;
      // Fingers authored as gripping may close past their authored bend to find the surface.
      const wraps = index < 4 && s.flex[base] > 0.5;
      let held = false;
      if (index < 4) chain.forEach((joint, n) => curlTo(joint, s.solved[base + n]));
      for (let n = index < 4 ? 0 : 1; n < 3; n += 1) {
        const authored = s.flex[base + n];
        const limit = wraps ? Math.min(TUNING.wrap[n], authored + TUNING.wrapPast) : authored, floor = Math.min(authored, OPEN[n]);
        const blocked = (angle: number, by: Collider = contact) => { curlTo(chain[n], angle); return touches(rig, index, n, by); };
        let free = floor, stop = NaN, stuck = false;
        for (const thin of [1, 0.55]) {
          slim = thin;
          stuck = false;
          free = THREE.MathUtils.clamp(s.solved[base + n], floor, limit);
          stop = NaN;
          if (blocked(free)) {
            held = true;
            stop = free;
            while (free > floor) { free = Math.max(floor, free - STEP); if (!blocked(free)) break; stop = free; }
            if (free === floor && blocked(free)) { stop = NaN; stuck = true; }
          } else {
            while (free < limit) { const next = Math.min(limit, free + STEP); if (blocked(next)) { stop = next; break; } free = next; }
            if (!Number.isNaN(stop)) held = true;
          }
          // Good enough unless the finger had to straighten right out: then it is tried again thinner.
          if (!stuck && free > authored - 0.5) break;
        }
        if (stuck) {
          if (blocked(free, contact.body)) {
            // Buried in the body even fully open: only moving the hand can free it. Each buried part
            // of the finger looks for the shortest way out that really frees it: backing the hand
            // off, drawing it back along its fingers, or straight to the nearest surface.
            const radii = index < 4 ? TUNING.fingerRadius : TUNING.thumbRadius;
            for (let k = Math.max(n, index < 4 ? 0 : 1); k < 3; k += 1) for (const t of [0.5, 1]) {
              point.lerpVectors(joints[k], joints[k + 1], t);
              const radius = radii[k] * slim;
              let depth = Infinity;
              if (!contact.body.inside(point)) {
                const distance = contact.body.closest(point, radius, hit);
                if (distance < radius && distance > 1e-6) { depth = radius - distance; way.subVectors(point, hit).multiplyScalar(1 / distance); }
              } else {
                for (const [x, y, z] of WAYS_OUT) {
                  back.set(x, y, z).applyQuaternion(s.target.quaternion);
                  const out = contact.body.segment(point, centre.copy(point).addScaledVector(back, REACH_OUT)) * REACH_OUT + radius;
                  if (out < depth && contact.body.closest(centre.copy(point).addScaledVector(back, out), radius) >= radius) { depth = out; way.copy(back); }
                }
                if (depth === Infinity) {
                  const distance = contact.body.closest(point, 0.04, hit);
                  if (distance < 0.04 && distance > 1e-6) { depth = radius + distance; way.subVectors(hit, point).multiplyScalar(1 / distance); }
                }
              }
              if (depth !== Infinity && depth > worst) { worst = depth; push.copy(way); }
            }
          } else {
            // Only something it holds is in the way: keep the authored bend, as far as the body allows.
            free = Math.max(floor, Math.min(authored, limit));
            while (free > floor && blocked(free, contact.body)) free = Math.max(floor, free - STEP);
          }
        }
        for (let refine = 0; refine < 3 && !Number.isNaN(stop); refine += 1) {
          const middle = (free + stop) / 2;
          if (blocked(middle)) stop = middle; else free = middle;
        }
        s.solved[base + n] = free;
        curlTo(chain[n], free);
        slim = 1;
      }
      // Reaching for a surface that is not there: fall back to the authored hand shape.
      if (wraps && !held) for (let n = 0; n < 3; n += 1) s.solved[base + n] = s.flex[base + n];
    }
    if (!mayPush || worst < 0.001 || s.target.position.distanceTo(s.authored) >= TUNING.give * 1.6) return false;
    s.target.position.addScaledVector(push, Math.min(worst, 0.02, Math.max(0, TUNING.give * 1.6 - s.target.position.distanceTo(s.authored))));
    return true;
  };

  const contactIds = new WeakMap<Contact, number>();
  let contactCount = 0;
  const contactId = (contact: Contact) => {
    let id = contactIds.get(contact);
    if (id === undefined) contactIds.set(contact, id = contactCount += 1);
    return id;
  };

  // Forearm: when the straight line to the elbow would cross the weapon, the elbow swings
  // down or outward until the sleeve clears it.
  const sleeveToHands = new THREE.Matrix4(), wristAt = new THREE.Vector3(), elbowAt = new THREE.Vector3(), shifted = new THREE.Vector3();
  const ELBOW_WAYS = [[0, -1, 0], [1, 0, 0], [1, -1, 0], [0, -1, 1], [1, 0, 1], [0, 1, 0], [1, 1, 0], [-1, -1, 0], [-1, 0, 0]];
  const steerElbow = (s: Side, contact: Contact) => {
    sleeveToHands.copy(hands.matrixWorld).invert().multiply(sleeves.matrixWorld);
    wristAt.set(0, MID, 0.075).applyQuaternion(s.target.quaternion).add(s.target.position);
    const clear = (x: number, y: number, z: number) => {
      elbowAt.copy(s.elbow).add(shifted.set(x, y, z)).applyMatrix4(sleeveToHands).sub(wristAt).setLength(TUNING.sleeveLength);
      for (const t of [0.1, 0.3, 0.55, 0.8, 1]) {
        const radius = TUNING.sleeveRadius * (0.8 + 0.2 * t);
        if (contact.closest(point.copy(wristAt).addScaledVector(elbowAt, t), radius) < radius) return false;
      }
      return true;
    };
    if (clear(0, 0, 0)) { s.elbowShift.set(0, 0, 0); return; }
    if (clear(s.elbowShift.x, s.elbowShift.y, s.elbowShift.z)) return;
    const out = s.left ? -1 : 1;
    for (const reach of [0.12, 0.24, 0.36, 0.5]) for (const [x, y, z] of ELBOW_WAYS) {
      if (clear(x * out * reach, y * reach, z * reach)) { s.elbowShift.set(x * out * reach, y * reach, z * reach); return; }
    }
  };

  return {
    hands,
    sleeves,
    right: arm(sides[0]),
    left: arm(sides[1]),
    tuning: TUNING,
    ready: () => Boolean(model),
    fit(pose, left, contact) {
      const s = sides[left ? 1 : 0], rig = s.rig;
      if (!rig || !begin()) return;
      const facing = new THREE.Vector3(0, -1, 0).applyQuaternion(pose.quaternion);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const across = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      // Palm: probe from behind the hand toward what it holds, and sit the palm on the nearest surface.
      const BEHIND = 0.045, span = BEHIND + TUNING.palm + TUNING.reach;
      let nearest = Infinity;
      for (const along of [-0.03, 0, 0.03]) for (const over of [-0.025, 0, 0.025]) {
        a.copy(pose.position).addScaledVector(forward, along).addScaledVector(across, over).addScaledVector(facing, -BEHIND);
        nearest = Math.min(nearest, contact.segment(a, b.copy(a).addScaledVector(facing, span)) * span);
      }
      const gap = nearest - BEHIND - TUNING.palm;
      if (gap < TUNING.reach) pose.position.addScaledVector(facing, gap);

      // Seat: slide until the knuckles are just past the edge, so the fingers have something to
      // fold around instead of folding into it.
      const gripping = [0, 1, 2, 3].filter((index) => pose.flex[index * 3] > 0.5);
      if (gripping.length < 3) return;
      s.target.position.copy(pose.position);
      s.target.quaternion.copy(pose.quaternion);
      hands.updateWorldMatrix(true, true);
      solve(s);
      rig.upper.updateWorldMatrix(true, true);
      toHands.copy(hands.matrixWorld).invert();
      const knuckles = gripping.map((index) => new THREE.Vector3().setFromMatrixPosition(rig.fingers[index][0].bone.matrixWorld).applyMatrix4(toHands));
      const clear = (slide: number) => knuckles.every((knuckle) => {
        a.copy(knuckle).addScaledVector(forward, slide - TUNING.fingerRadius[0]);
        return contact.segment(a, b.copy(a).addScaledVector(facing, 0.04)) > 1;
      });
      let slide = 0;
      if (clear(0)) { while (slide > -TUNING.seat && clear(slide - 0.003)) slide -= 0.003; }
      else { while (slide < TUNING.seat && !clear(slide)) slide += 0.003; if (!clear(slide)) slide = 0; }
      pose.position.addScaledVector(forward, slide);
    },
    update(contact) {
      if (!begin()) return;
      for (const s of sides) {
        if (!s.rig) continue;
        // A hand that has not moved against the weapon since last frame keeps its answer.
        const t = s.target, stamp = contact ? `${contactId(contact)}|${contact.version}|${t.position.x},${t.position.y},${t.position.z}|${t.quaternion.x},${t.quaternion.y},${t.quaternion.z}|${s.flex.join()}` : "free";
        const fresh = stamp !== s.stamp;
        if (fresh) s.authored.copy(t.position);
        s.stamp = stamp;
        if (!fresh) { t.position.copy(s.settled); hands.updateWorldMatrix(false, true); }
        const near = contact && fresh ? depenetrate(s, contact) : false;
        if (near) { hands.updateWorldMatrix(false, true); steerElbow(s, contact!); }
        else if (fresh) s.elbowShift.set(0, 0, 0);
        s.elbowShown.lerp(s.elbowShift, 0.3);
        solve(s);
        if (near) {
          // Fingers that stay buried even fully open move the whole hand, then everything is solved again.
          for (let pass = 0; pass < 4 && closeFingers(s, contact!, pass < 3); pass += 1) { hands.updateWorldMatrix(false, true); solve(s); }
        } else if (fresh) { s.swing = 0; for (let i = 0; i < 15; i += 1) s.solved[i] = s.flex[i]; }
        if (fresh) s.settled.copy(t.position);
        // Ease toward the answer so a finger settles onto a surface rather than snapping to it.
        for (let i = 0; i < 15; i += 1) s.shown[i] += (s.solved[i] - s.shown[i]) * 0.5;
        s.swingShown += (s.swing - s.swingShown) * 0.5;
        show(s, s.shown, s.swingShown);
      }
    },
    penetration(contact) {
      // `moved` is how far each hand (right, left) sits from where it was authored; `bent` is how far each joint is from its authored bend.
      const result = { left: 0, right: 0, depth: 0, bones: {} as Record<string, number>, moved: sides.map((s) => s.settled.distanceTo(s.authored)), bent: sides.map((s) => s.solved.map((angle, i) => angle - s.flex[i])), fixed: [0, 0] };
      let mesh: THREE.SkinnedMesh | undefined;
      model?.traverse((object) => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) mesh = object as THREE.SkinnedMesh; });
      if (!mesh) return result;
      model!.updateWorldMatrix(true, true);
      toHands.copy(hands.matrixWorld).invert().multiply(mesh.matrixWorld);
      const position = mesh.geometry.getAttribute("position"), v = new THREE.Vector3();
      const totals = { left: 0, right: 0 };
      for (let i = 0; i < position.count; i += 2) {
        const side = position.getX(i) > 0 ? "left" : "right";
        totals[side] += 1;
        mesh.getVertexPosition(i, v).applyMatrix4(toHands);
        if (!contact.inside(v)) continue;
        result[side] += 1;
        if (contact.body.inside(v)) result.fixed[side === "right" ? 0 : 1] += 1;
        const skinIndex = mesh.geometry.getAttribute("skinIndex"), skinWeight = mesh.geometry.getAttribute("skinWeight");
        let heavy = 0;
        for (let k = 1; k < 4; k += 1) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, heavy)) heavy = k;
        const bone = mesh.skeleton.bones[skinIndex.getComponent(i, heavy)].name.replace(/_\d+$/, "");
        result.bones[bone] = (result.bones[bone] ?? 0) + 1;
        result.depth = Math.max(result.depth, Math.min(0.05, contact.closest(v, 0.05)));
      }
      result.left /= Math.max(1, totals.left);
      result.right /= Math.max(1, totals.right);
      result.fixed[0] /= Math.max(1, totals.right);
      result.fixed[1] /= Math.max(1, totals.left);
      return result;
    },
    dispose() {
      if (model) release(model);
    },
  };
}

/** How far under the skin the sampled points sit, which is also their radius: centimetres in the model. */
const SKIN = 0.5;

/**
 * Reads the shape of the inside of a hand off the model: one point per patch of skin carried by
 * `carriers`, set just under the surface. `frame` is the hand's frame in `root`'s space.
 */
function sampleSkin(mesh: THREE.SkinnedMesh | undefined, carriers: Set<THREE.Bone | undefined>, thumb: THREE.Bone, frame: THREE.Matrix4, root: THREE.Object3D) {
  if (!mesh) return [];
  const toFrame = new THREE.Matrix4().copy(frame).invert().multiply(new THREE.Matrix4().copy(root.matrixWorld).invert()).multiply(mesh.matrixWorld);
  const toThumb = new THREE.Matrix4().copy(thumb.matrixWorld).invert().multiply(root.matrixWorld).multiply(frame);
  const position = mesh.geometry.getAttribute("position"), normal = mesh.geometry.getAttribute("normal");
  const skinIndex = mesh.geometry.getAttribute("skinIndex"), skinWeight = mesh.geometry.getAttribute("skinWeight");
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const cells = new Map<string, { at: THREE.Vector3; out: THREE.Vector3; count: number; thumb: boolean }>();
  for (let i = 0; i < position.count; i += 1) {
    let heavy = 0;
    for (let k = 1; k < 4; k += 1) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, heavy)) heavy = k;
    const bone = mesh.skeleton.bones[skinIndex.getComponent(i, heavy)];
    if (!carriers.has(bone)) continue;
    mesh.getVertexPosition(i, v).applyMatrix4(toFrame);
    n.fromBufferAttribute(normal, i).transformDirection(toFrame);
    // Not the back of the hand, and not the forearm behind the wrist.
    if (n.y > 0.25 || v.z > 6.5) continue;
    const key = `${bone === thumb}|${Math.round(v.x / 1.3)}|${Math.round(v.y / 1.3)}|${Math.round(v.z / 1.3)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = { at: new THREE.Vector3(), out: new THREE.Vector3(), count: 0, thumb: bone === thumb });
    cell.at.add(v); cell.out.add(n); cell.count += 1;
  }
  return [...cells.values()].map((cell) => {
    const at = cell.at.multiplyScalar(1 / cell.count).addScaledVector(cell.out.normalize(), -SKIN);
    return {
      at: at.clone().multiplyScalar(0.01 * TUNING.scale), out: cell.out.clone(),
      onThumb: cell.thumb ? at.clone().applyMatrix4(toThumb) : undefined, outOnThumb: cell.thumb ? cell.out.clone().transformDirection(toThumb) : undefined,
    };
  });
}

function release(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material as THREE.MeshStandardMaterial;
    [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap].forEach((texture) => texture?.dispose());
    material.dispose();
  });
}

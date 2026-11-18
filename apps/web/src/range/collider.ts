import * as THREE from "three";

// Triangle soup with a bounding-volume hierarchy, so the hands can ask the
// weapon "how close is your surface here?" a few thousand times a frame.

export type Collider = {
  /** Fraction along a→b of the first surface crossed (either side), or Infinity. */
  segment: (a: THREE.Vector3, b: THREE.Vector3) => number;
  /** Distance from `p` to the nearest surface if under `radius`, else Infinity. `out` receives that surface point. */
  closest: (p: THREE.Vector3, radius: number, out?: THREE.Vector3) => number;
  /** How many closed shells a→b leaves, less those it enters: above zero means `a` is inside solid. */
  winding: (a: THREE.Vector3, b: THREE.Vector3) => number;
};

/** A weapon as the hands feel it: a fixed body plus parts that move during a reload. */
export type Contact = Collider & {
  /** Call after the weapon's parts have been posed for the frame. */
  update: () => void;
  /** Changes whenever a part has moved, appeared or gone since the last `update`. */
  version: number;
  /** True when `p` is inside the weapon's solid volume. */
  inside: (p: THREE.Vector3) => boolean;
  /** The fixed body alone, without the parts a hand works or carries. */
  body: Collider & { inside: (p: THREE.Vector3) => boolean };
};

export type Mover = { object: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion };

const LEAF = 6;

/**
 * Gathers the meshes under `root`, expressed in `frame`'s local space. Subtrees in `skip`
 * are left out; hidden objects are too unless `hidden` is set.
 */
export function buildCollider(root: THREE.Object3D, frame: THREE.Object3D, skip?: Set<THREE.Object3D>, hidden = false): Collider {
  root.updateWorldMatrix(true, true);
  frame.updateWorldMatrix(true, false);
  const toFrame = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  const soup: number[] = [];
  const matrix = new THREE.Matrix4(), v = new THREE.Vector3();
  const visit = (object: THREE.Object3D) => {
    if ((!object.visible && !hidden) || (skip?.has(object) && object !== root)) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry.getAttribute("position")) {
      const position = mesh.geometry.getAttribute("position"), index = mesh.geometry.getIndex();
      matrix.multiplyMatrices(toFrame, mesh.matrixWorld);
      const count = index ? index.count : position.count;
      for (let i = 0; i < count; i += 1) {
        v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix);
        soup.push(v.x, v.y, v.z);
      }
    }
    object.children.forEach(visit);
  };
  visit(root);

  const triangles = new Float32Array(soup), total = triangles.length / 9;
  const centroid = new Float32Array(total * 3);
  for (let t = 0; t < total; t += 1) for (let k = 0; k < 3; k += 1) centroid[t * 3 + k] = (triangles[t * 9 + k] + triangles[t * 9 + 3 + k] + triangles[t * 9 + 6 + k]) / 3;
  const order = new Uint32Array(total);
  for (let t = 0; t < total; t += 1) order[t] = t;
  // Node: [minX, minY, minZ, maxX, maxY, maxZ, left | first, right | -count]
  const nodes: number[] = [];
  const build = (start: number, end: number): number => {
    const at = nodes.length;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i += 1) for (let c = 0; c < 9; c += 1) {
      const value = triangles[order[i] * 9 + c], k = c % 3;
      if (value < box[k]) box[k] = value;
      if (value > box[k + 3]) box[k + 3] = value;
    }
    nodes.push(...box, start, start - end);
    if (end - start <= LEAF) return at;
    const axis = box[3] - box[0] > box[4] - box[1] ? (box[3] - box[0] > box[5] - box[2] ? 0 : 2) : (box[4] - box[1] > box[5] - box[2] ? 1 : 2);
    order.subarray(start, end).sort((a, b) => centroid[a * 3 + axis] - centroid[b * 3 + axis]);
    const middle = (start + end) >> 1;
    nodes[at + 6] = build(start, middle);
    nodes[at + 7] = build(middle, end);
    return at;
  };
  if (total) build(0, total);
  const tree = new Float32Array(nodes);
  const stack: number[] = [];

  return {
    segment(a, b) {
      if (!total) return Infinity;
      const ox = a.x, oy = a.y, oz = a.z, dx = b.x - ox, dy = b.y - oy, dz = b.z - oz;
      const o = [ox, oy, oz], d = [dx, dy, dz];
      let best = Infinity;
      stack.length = 0;
      stack.push(0);
      while (stack.length) {
        const node = stack.pop()!;
        let near = 0, far = Math.min(1, best), miss = false;
        for (let k = 0; k < 3 && !miss; k += 1) {
          if (Math.abs(d[k]) < 1e-12) { if (o[k] < tree[node + k] || o[k] > tree[node + k + 3]) miss = true; continue; }
          let t0 = (tree[node + k] - o[k]) / d[k], t1 = (tree[node + k + 3] - o[k]) / d[k];
          if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
          if (t0 > near) near = t0;
          if (t1 < far) far = t1;
          if (near > far) miss = true;
        }
        if (miss) continue;
        const count = -tree[node + 7];
        if (count <= 0) { stack.push(tree[node + 6], tree[node + 7]); continue; }
        const first = tree[node + 6];
        for (let i = first; i < first + count; i += 1) {
          const t = order[i] * 9;
          const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
          const e1x = triangles[t + 3] - ax, e1y = triangles[t + 4] - ay, e1z = triangles[t + 5] - az;
          const e2x = triangles[t + 6] - ax, e2y = triangles[t + 7] - ay, e2z = triangles[t + 8] - az;
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-18) continue;
          const tx = ox - ax, ty = oy - ay, tz = oz - az;
          const u = (tx * px + ty * py + tz * pz) / det;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const w = (dx * qx + dy * qy + dz * qz) / det;
          if (w < 0 || u + w > 1) continue;
          const hit = (e2x * qx + e2y * qy + e2z * qz) / det;
          if (hit >= 0 && hit <= 1 && hit < best) best = hit;
        }
      }
      return best;
    },
    closest(p, radius, out) {
      if (!total) return Infinity;
      const px = p.x, py = p.y, pz = p.z;
      let best = radius * radius, found = false, cx = 0, cy = 0, cz = 0;
      stack.length = 0;
      stack.push(0);
      while (stack.length) {
        const node = stack.pop()!;
        const bx = Math.max(tree[node] - px, 0, px - tree[node + 3]), by = Math.max(tree[node + 1] - py, 0, py - tree[node + 4]), bz = Math.max(tree[node + 2] - pz, 0, pz - tree[node + 5]);
        if (bx * bx + by * by + bz * bz >= best) continue;
        const count = -tree[node + 7];
        if (count <= 0) { stack.push(tree[node + 6], tree[node + 7]); continue; }
        const first = tree[node + 6];
        for (let i = first; i < first + count; i += 1) {
          const t = order[i] * 9;
          const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
          const abx = triangles[t + 3] - ax, aby = triangles[t + 4] - ay, abz = triangles[t + 5] - az;
          const acx = triangles[t + 6] - ax, acy = triangles[t + 7] - ay, acz = triangles[t + 8] - az;
          const apx = px - ax, apy = py - ay, apz = pz - az;
          // Closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5).
          let v = 0, w = 0;
          const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
          if (!(d1 <= 0 && d2 <= 0)) {
            const d3 = d1 - (abx * abx + aby * aby + abz * abz), d4 = d2 - (acx * abx + acy * aby + acz * abz);
            if (d3 >= 0 && d4 <= d3) v = 1;
            else {
              const vc = d1 * d4 - d3 * d2;
              if (vc <= 0 && d1 >= 0 && d3 <= 0) v = d1 / (d1 - d3);
              else {
                const d5 = d1 - (abx * acx + aby * acy + abz * acz), d6 = d2 - (acx * acx + acy * acy + acz * acz);
                if (d6 >= 0 && d5 <= d6) w = 1;
                else {
                  const vb = d5 * d2 - d1 * d6;
                  if (vb <= 0 && d2 >= 0 && d6 <= 0) w = d2 / (d2 - d6);
                  else {
                    const va = d3 * d6 - d5 * d4;
                    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / (d4 - d3 + (d5 - d6)); v = 1 - w; }
                    else { const denom = 1 / (va + vb + vc); v = vb * denom; w = vc * denom; }
                  }
                }
              }
            }
          }
          const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
          const d = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
          if (d < best) { best = d; found = true; cx = qx; cy = qy; cz = qz; }
        }
      }
      if (!found) return Infinity;
      out?.set(cx, cy, cz);
      return Math.sqrt(best);
    },
    winding(a, b) {
      if (!total) return 0;
      const ox = a.x, oy = a.y, oz = a.z, dx = b.x - ox, dy = b.y - oy, dz = b.z - oz;
      const o = [ox, oy, oz], d = [dx, dy, dz];
      let sum = 0;
      stack.length = 0;
      stack.push(0);
      while (stack.length) {
        const node = stack.pop()!;
        let near = 0, far = 1, miss = false;
        for (let k = 0; k < 3 && !miss; k += 1) {
          if (Math.abs(d[k]) < 1e-12) { if (o[k] < tree[node + k] || o[k] > tree[node + k + 3]) miss = true; continue; }
          let t0 = (tree[node + k] - o[k]) / d[k], t1 = (tree[node + k + 3] - o[k]) / d[k];
          if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
          if (t0 > near) near = t0;
          if (t1 < far) far = t1;
          if (near > far) miss = true;
        }
        if (miss) continue;
        const count = -tree[node + 7];
        if (count <= 0) { stack.push(tree[node + 6], tree[node + 7]); continue; }
        const first = tree[node + 6];
        for (let i = first; i < first + count; i += 1) {
          const t = order[i] * 9;
          const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
          const e1x = triangles[t + 3] - ax, e1y = triangles[t + 4] - ay, e1z = triangles[t + 5] - az;
          const e2x = triangles[t + 6] - ax, e2y = triangles[t + 7] - ay, e2z = triangles[t + 8] - az;
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-18) continue;
          const tx = ox - ax, ty = oy - ay, tz = oz - az;
          const u = (tx * px + ty * py + tz * pz) / det;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const w = (dx * qx + dy * qy + dz * qz) / det;
          if (w < 0 || u + w > 1) continue;
          const hit = (e2x * qx + e2y * qy + e2z * qz) / det;
          // A positive determinant is a front face: the ray is entering a shell there.
          if (hit >= 0 && hit <= 1) sum += det > 0 ? -1 : 1;
        }
      }
      return sum;
    },
  };
}

const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The whole weapon: its fixed body and each moving part, which is queried in the
 * place it was built and so stays correct while a reload slides or rotates it.
 */
export function buildContact(root: THREE.Object3D, frame: THREE.Object3D, movers: Mover[]): Contact {
  const skip = new Set(movers.map((mover) => mover.object));
  const body = buildCollider(root, frame, skip);
  frame.updateWorldMatrix(true, false);
  const toFrame = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  const parts = movers.filter((mover) => mover.object.parent).map((mover) => {
    const parentToFrame = new THREE.Matrix4().multiplyMatrices(toFrame, mover.object.parent!.matrixWorld);
    return {
      mover,
      collider: buildCollider(mover.object, frame, undefined, true),
      // frame ← parent, rest pose within the parent, and back again.
      rest: new THREE.Matrix4().compose(mover.position, mover.quaternion, mover.object.scale).premultiply(parentToFrame),
      fromFrame: parentToFrame.clone().invert(),
      toRest: new THREE.Matrix4(), fromRest: new THREE.Matrix4(), active: false, last: new THREE.Matrix4(),
    };
  });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), local = new THREE.Matrix4();
  const far = new THREE.Vector3();
  const each = <T>(base: T, fold: (value: T, collider: Collider, toRest: THREE.Matrix4 | null, fromRest: THREE.Matrix4 | null) => T) => {
    let value = fold(base, body, null, null);
    for (const part of parts) if (part.active) value = fold(value, part.collider, part.toRest, part.fromRest);
    return value;
  };
  const insideOf = (collider: Collider, p: THREE.Vector3) => {
    let votes = 0;
    for (const axis of AXES) if (collider.winding(p, far.set(axis[0], axis[1], axis[2]).multiplyScalar(4).add(p)) > 0) votes += 1;
    return votes >= 4;
  };
  const contact: Contact = {
    version: 0,
    update() {
      for (const part of parts) {
        const active = part.mover.object.visible;
        part.mover.object.updateMatrix();
        if (active !== part.active || !part.last.equals(part.mover.object.matrix)) contact.version += 1;
        part.last.copy(part.mover.object.matrix);
        part.active = active;
        if (!part.active) continue;
        // rest ∘ current⁻¹: where a point of the frame sits relative to the part as it was built.
        part.toRest.copy(part.rest).multiply(local.copy(part.mover.object.matrix).invert()).multiply(part.fromFrame);
        part.fromRest.copy(part.toRest).invert();
      }
    },
    segment: (from, to) => each(Infinity, (best, collider, toRest) => Math.min(best, toRest ? collider.segment(a.copy(from).applyMatrix4(toRest), b.copy(to).applyMatrix4(toRest)) : collider.segment(from, to))),
    closest(p, radius, out) {
      return each(Infinity, (best, collider, toRest, fromRest) => {
        const distance = collider.closest(toRest ? a.copy(p).applyMatrix4(toRest) : p, Math.min(radius, best), c);
        if (distance >= best) return best;
        if (out) { out.copy(c); if (fromRest) out.applyMatrix4(fromRest); }
        return distance;
      });
    },
    winding: (from, to) => each(0, (sum, collider, toRest) => sum + (toRest ? collider.winding(a.copy(from).applyMatrix4(toRest), b.copy(to).applyMatrix4(toRest)) : collider.winding(from, to))),
    inside: (p) => insideOf(contact, p),
    body: { ...body, inside: (p) => insideOf(body, p) },
  };
  contact.update();
  return contact;
}

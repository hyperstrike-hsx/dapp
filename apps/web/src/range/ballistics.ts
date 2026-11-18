import * as THREE from "three";

// Shot feedback: tracer streaks, impact sparks, dust, bullet-hole decals and
// ejected brass. Everything is pooled, so firing allocates nothing per shot
// and automatic fire cannot hitch on garbage collection or shader compiles.

const TRACERS = 8, SPARKS = 220, HOLES = 96, PUFFS = 10, CASINGS = 14;

function radialTexture(stops: Array<[number, string]>) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export type Ballistics = {
  /** Objects the mirrored floor pass and probe should skip. */
  transient: THREE.Object3D[];
  fire: (now: number, start: THREE.Vector3, end: THREE.Vector3, hit?: THREE.Intersection) => void;
  eject: (now: number, position: THREE.Vector3, velocity: THREE.Vector3) => void;
  update: (now: number, dt: number) => void;
  dispose: () => void;
};

export function createBallistics(scene: THREE.Scene): Ballistics {
  const group = new THREE.Group();
  scene.add(group);
  const up = new THREE.Vector3(0, 0, 1), axis = new THREE.Vector3(), normal = new THREE.Vector3(), matrix = new THREE.Matrix4(), instanceMatrix = new THREE.Matrix4();

  // Tracers: unit-length streaks stretched between muzzle and impact.
  const tracerGeometry = new THREE.CylinderGeometry(0.0045, 0.011, 1, 6, 1, true);
  tracerGeometry.rotateX(Math.PI / 2);
  const tracers = Array.from({ length: TRACERS }, () => {
    const mesh = new THREE.Mesh(tracerGeometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.82, 0.5).multiplyScalar(5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, born: -1e6 };
  });
  let tracerCursor = 0;

  // Sparks: one draw call, simulated on the CPU.
  const sparkPosition = new Float32Array(SPARKS * 3).fill(-999), sparkColor = new Float32Array(SPARKS * 3);
  const sparkVelocity = new Float32Array(SPARKS * 3), sparkBorn = new Float32Array(SPARKS).fill(-1e6), sparkLife = new Float32Array(SPARKS).fill(1);
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPosition, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute("color", new THREE.BufferAttribute(sparkColor, 3).setUsage(THREE.DynamicDrawUsage));
  const sparkMap = radialTexture([[0, "rgba(255,255,255,1)"], [0.4, "rgba(255,255,255,.5)"], [1, "rgba(255,255,255,0)"]]);
  const sparks = new THREE.Points(sparkGeometry, new THREE.PointsMaterial({ map: sparkMap, size: 0.05, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  sparks.frustumCulled = false;
  group.add(sparks);
  let sparkCursor = 0;

  // Bullet holes: instanced decals laid flat on the struck surface.
  const holeMap = radialTexture([[0, "rgba(4,4,4,1)"], [0.26, "rgba(8,8,8,.96)"], [0.42, "rgba(38,36,34,.7)"], [0.7, "rgba(60,58,55,.24)"], [1, "rgba(70,68,64,0)"]]);
  const holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: holeMap, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), HOLES);
  holes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  holes.count = 0;
  holes.frustumCulled = false;
  group.add(holes);
  let holeCursor = 0;
  const holeDummy = new THREE.Object3D();

  // Dust kicked off the surface.
  const puffMap = radialTexture([[0, "rgba(255,255,255,.55)"], [0.5, "rgba(255,255,255,.22)"], [1, "rgba(255,255,255,0)"]]);
  const puffs = Array.from({ length: PUFFS }, () => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffMap, color: 0x9b958a, transparent: true, depthWrite: false }));
    sprite.visible = false;
    group.add(sprite);
    return { sprite, born: -1e6, drift: new THREE.Vector3() };
  });
  let puffCursor = 0;

  // Ejected brass.
  const casingGeometry = new THREE.CylinderGeometry(0.0085, 0.0095, 0.052, 8);
  const casingMaterial = new THREE.MeshStandardMaterial({ color: 0xc79a4a, metalness: 1, roughness: 0.28 });
  const casings = Array.from({ length: CASINGS }, () => {
    const mesh = new THREE.Mesh(casingGeometry, casingMaterial);
    mesh.visible = false;
    group.add(mesh);
    return { mesh, born: -1e6, velocity: new THREE.Vector3(), spin: new THREE.Vector3(), resting: false };
  });
  let casingCursor = 0;

  return {
    transient: [group],
    fire(now, start, end, hit) {
      const tracer = tracers[tracerCursor];
      tracerCursor = (tracerCursor + 1) % TRACERS;
      axis.subVectors(end, start);
      const length = axis.length();
      tracer.mesh.position.copy(start).addScaledVector(axis, 0.5);
      tracer.mesh.quaternion.setFromUnitVectors(up, axis.normalize());
      tracer.mesh.scale.set(1, 1, length);
      tracer.mesh.visible = true;
      tracer.born = now;
      if (!hit) return;

      // World-space surface normal (instanced props carry their own transform).
      normal.copy(hit.face?.normal ?? axis.clone().negate());
      matrix.copy(hit.object.matrixWorld);
      if (hit.object instanceof THREE.InstancedMesh && hit.instanceId !== undefined) {
        hit.object.getMatrixAt(hit.instanceId, instanceMatrix);
        matrix.multiply(instanceMatrix);
      }
      normal.transformDirection(matrix);
      if (normal.dot(axis) > 0) normal.negate();

      const screen = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!screen?.emissiveMap) {
        holeDummy.position.copy(end).addScaledVector(normal, 0.004);
        holeDummy.quaternion.setFromUnitVectors(up, normal);
        holeDummy.rotateZ(Math.random() * Math.PI * 2);
        holeDummy.scale.setScalar(0.07 + Math.random() * 0.035);
        holeDummy.updateMatrix();
        holes.setMatrixAt(holeCursor, holeDummy.matrix);
        holeCursor = (holeCursor + 1) % HOLES;
        holes.count = Math.min(HOLES, holes.count + 1);
        holes.instanceMatrix.needsUpdate = true;
      }

      // Sparks leave along the mirrored bullet path, spread around the normal.
      const bounce = axis.clone().reflect(normal);
      for (let i = 0; i < 12; i += 1) {
        const o = sparkCursor * 3;
        const speed = 2.5 + Math.random() * 6.5;
        sparkPosition[o] = end.x; sparkPosition[o + 1] = end.y; sparkPosition[o + 2] = end.z;
        sparkVelocity[o] = (bounce.x * 0.55 + normal.x * 0.45 + (Math.random() - 0.5) * 0.9) * speed;
        sparkVelocity[o + 1] = (bounce.y * 0.55 + normal.y * 0.45 + (Math.random() - 0.5) * 0.9) * speed;
        sparkVelocity[o + 2] = (bounce.z * 0.55 + normal.z * 0.45 + (Math.random() - 0.5) * 0.9) * speed;
        sparkBorn[sparkCursor] = now;
        sparkLife[sparkCursor] = 180 + Math.random() * 320;
        sparkCursor = (sparkCursor + 1) % SPARKS;
      }

      const puff = puffs[puffCursor];
      puffCursor = (puffCursor + 1) % PUFFS;
      puff.sprite.position.copy(end).addScaledVector(normal, 0.06);
      puff.drift.copy(normal).multiplyScalar(0.55).add(new THREE.Vector3(0, 0.18, 0));
      puff.sprite.visible = true;
      puff.born = now;
    },
    eject(now, position, velocity) {
      const casing = casings[casingCursor];
      casingCursor = (casingCursor + 1) % CASINGS;
      casing.mesh.position.copy(position);
      casing.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      casing.velocity.copy(velocity);
      casing.spin.set(8 + Math.random() * 10, 4 + Math.random() * 8, 6 + Math.random() * 8);
      casing.mesh.visible = true;
      casing.resting = false;
      casing.born = now;
    },
    update(now, dt) {
      for (const tracer of tracers) {
        if (!tracer.mesh.visible) continue;
        const age = (now - tracer.born) / 85;
        if (age >= 1) tracer.mesh.visible = false;
        else (tracer.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - age;
      }
      for (let i = 0; i < SPARKS; i += 1) {
        const age = (now - sparkBorn[i]) / sparkLife[i], o = i * 3;
        if (age >= 1) {
          if (sparkPosition[o + 1] > -900) { sparkPosition[o + 1] = -999; sparkColor[o] = sparkColor[o + 1] = sparkColor[o + 2] = 0; }
          continue;
        }
        sparkVelocity[o + 1] -= 9.8 * dt;
        sparkPosition[o] += sparkVelocity[o] * dt;
        sparkPosition[o + 1] += sparkVelocity[o + 1] * dt;
        sparkPosition[o + 2] += sparkVelocity[o + 2] * dt;
        if (sparkPosition[o + 1] < 0.01) { sparkPosition[o + 1] = 0.01; sparkVelocity[o + 1] *= -0.35; }
        // Cool from white-hot through orange to dull red.
        const heat = 1 - age;
        sparkColor[o] = 6 * heat; sparkColor[o + 1] = 3.6 * heat * heat; sparkColor[o + 2] = 1.4 * heat * heat * heat;
      }
      sparkGeometry.attributes.position.needsUpdate = true;
      sparkGeometry.attributes.color.needsUpdate = true;
      for (const puff of puffs) {
        if (!puff.sprite.visible) continue;
        const age = (now - puff.born) / 620;
        if (age >= 1) { puff.sprite.visible = false; continue; }
        puff.sprite.position.addScaledVector(puff.drift, dt * (1 - age));
        puff.sprite.scale.setScalar(0.12 + age * 0.55);
        puff.sprite.material.opacity = 0.5 * (1 - age) * (1 - age);
      }
      for (const casing of casings) {
        if (!casing.mesh.visible) continue;
        if (now - casing.born > 6000) { casing.mesh.visible = false; continue; }
        if (casing.resting) continue;
        casing.velocity.y -= 9.8 * dt;
        casing.mesh.position.addScaledVector(casing.velocity, dt);
        casing.mesh.rotation.x += casing.spin.x * dt;
        casing.mesh.rotation.y += casing.spin.y * dt;
        casing.mesh.rotation.z += casing.spin.z * dt;
        if (casing.mesh.position.y < 0.012) {
          casing.mesh.position.y = 0.012;
          if (Math.abs(casing.velocity.y) < 0.9) { casing.resting = true; casing.mesh.rotation.x = Math.PI / 2; casing.mesh.rotation.y = 0; }
          else { casing.velocity.y *= -0.34; casing.velocity.x *= 0.55; casing.velocity.z *= 0.55; casing.spin.multiplyScalar(0.6); }
        }
      }
    },
    dispose() {
      [sparkMap, holeMap, puffMap].forEach((texture) => texture.dispose());
    },
  };
}

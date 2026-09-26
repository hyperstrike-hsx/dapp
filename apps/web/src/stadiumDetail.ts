import * as THREE from "three";

/** Shared geometry + instancing: a populated stadium without a draw call per seat. */
export function addStadiumDetail(
  scene: THREE.Scene,
  seats: number[],
  concrete: THREE.Material,
) {
  const steel = new THREE.MeshStandardMaterial({
    color: 0x344440,
    metalness: 0.78,
    roughness: 0.42,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: 0x20332e,
    roughness: 0.64,
    metalness: 0.24,
  });
  const lamp = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.4, 2.65, 2.4),
    toneMapped: false,
  });
  const groups = new Map<THREE.Material, THREE.Matrix4[]>();
  const dummy = new THREE.Object3D();
  const box = (
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    angle = 0,
  ) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(0, 0, angle);
    dummy.updateMatrix();
    const list = groups.get(material) ?? [];
    list.push(dummy.matrix.clone());
    groups.set(material, list);
  };
  // Cantilever canopies, repeated trusses and a solid rear concourse anchor the crowd.
  for (const side of [-1, 1]) {
    box(trim, side * 13.2, 8.6, -8, 7.5, 0.22, 43);
    box(concrete, side * 16.3, 4.5, -8, 0.5, 8.7, 43);
    for (let z = 11; z >= -27; z -= 4.75) {
      box(steel, side * 15.4, 4.35, z, 0.2, 8.7, 0.22);
      box(steel, side * 12.6, 8.1, z, 7, 0.16, 0.18, side * 0.075);
      box(steel, side * 13.6, 7.05, z, 4.8, 0.13, 0.14, side * 0.43);
      box(lamp, side * 10.2, 7.95, z, 1.3, 0.06, 0.36);
    }
    box(steel, side * 9.1, 1.15, -7, 0.07, 0.07, 38);
    for (let z = 11; z > -25; z -= 2.5)
      box(steel, side * 9.1, 0.7, z, 0.06, 1.0, 0.06);
    // Concrete perimeter and amber aisle markers — separate from the painted pitch.
    box(concrete, side * 10.0, 0.08, -6, 2.3, 0.15, 42);
  }
  box(concrete, 0, 3.7, -24.1, 33, 7.4, 0.5);
  box(trim, 0, 8.65, -23.2, 33, 0.24, 5.2);
  for (let x = -15; x <= 15; x += 3) {
    box(steel, x, 4.35, -23, 0.18, 8.7, 0.18);
    box(steel, x, 8.25, -21.8, 0.15, 0.2, 6);
    box(lamp, x, 7.65, -21.3, 1.2, 0.08, 0.35);
  }
  // Board supports keep the match display from floating over the goal.
  for (const x of [-5.25, 5.25]) box(steel, x, 3.7, -11.1, 0.12, 7.4, 0.12);
  box(steel, 0, 6.36, -11, 10.8, 0.16, 0.22);
  box(trim, 0, 5.35, -10.94, 10.55, 2.08, 0.18);
  for (const [material, matrices] of groups) {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      material,
      matrices.length,
    );
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = material !== lamp;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const count = seats.length / 3;
  const chair = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.36, 0.34, 0.09),
    new THREE.MeshStandardMaterial({ color: 0x49645d, roughness: 0.68 }),
    count,
  );
  const bodies = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 7, 5),
    new THREE.MeshStandardMaterial({ roughness: 0.93 }),
    count,
  );
  const heads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 7, 5),
    new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    count,
  );
  const arms = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.047, 0.055, 0.3, 5),
    new THREE.MeshStandardMaterial({ roughness: 0.93 }),
    count * 2,
  );
  const jackets = [
    0x425e55, 0xb9c8b8, 0x183e35, 0x7e4d33, 0x657374, 0x202b29, 0x9f584b,
  ];
  const skin = [0xa57250, 0x6d4837, 0xc79570, 0x584031];
  for (let i = 0; i < count; i++) {
    const x = seats[i * 3],
      y = seats[i * 3 + 1] - 0.82,
      z = seats[i * 3 + 2];
    const yaw = z < -17 ? 0 : x < 0 ? Math.PI / 2 : -Math.PI / 2;
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.position.set(x, y + 0.14, z);
    dummy.updateMatrix();
    chair.setMatrixAt(i, dummy.matrix);
    dummy.scale.set(0.18, 0.26, 0.14);
    dummy.position.set(x, y + 0.36, z);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
    bodies.setColorAt(i, new THREE.Color(jackets[(i * 17) % jackets.length]));
    dummy.scale.set(0.095, 0.115, 0.095);
    dummy.position.y = y + 0.69;
    dummy.updateMatrix();
    heads.setMatrixAt(i, dummy.matrix);
    heads.setColorAt(i, new THREE.Color(skin[i % skin.length]));
    for (const side of [-1, 1]) {
      const a = i * 2 + (side === 1 ? 1 : 0);
      dummy.position.set(
        x + Math.cos(yaw) * side * 0.2,
        y + 0.44,
        z - Math.sin(yaw) * side * 0.2,
      );
      dummy.rotation.set(0, yaw, side * (i % 3 === 0 ? 1.0 : 0.2));
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      arms.setMatrixAt(a, dummy.matrix);
      arms.setColorAt(a, new THREE.Color(jackets[(i * 17) % jackets.length]));
    }
  }
  scene.add(chair, bodies, heads, arms);
  bodies.receiveShadow = true;
  heads.receiveShadow = true;
  // Crowd motion stays on the GPU; no thousands of matrix uploads each frame.
  const time = { value: 0 };
  for (const mesh of [bodies, heads, arms])
    mesh.material.onBeforeCompile = (shader) => {
      shader.uniforms.stadiumTime = time;
      shader.vertexShader =
        "uniform float stadiumTime;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        `
      #include <project_vertex>
      float wave = max(0.0, sin(stadiumTime * 3.8 + instanceMatrix[3].x * 0.25 + instanceMatrix[3].z * 0.18));
      mvPosition.y += wave * 0.045;
      gl_Position = projectionMatrix * mvPosition;
    `,
      );
    };
  return {
    update: (now: number) => {
      time.value = now * 0.001;
    },
  };
}

export function footballTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#e3e8db";
  c.fillRect(0, 0, 1024, 512);
  for (let row = -1; row < 6; row++)
    for (let col = -1; col < 11; col++) {
      const x = col * 108 + (row % 2) * 54,
        y = row * 100;
      c.beginPath();
      for (let p = 0; p < 6; p++) {
        const a = (p / 6) * Math.PI * 2;
        const xx = x + 58 * Math.cos(a),
          yy = y + 58 * Math.sin(a);
        if (!p) c.moveTo(xx, yy);
        else c.lineTo(xx, yy);
      }
      c.closePath();
      c.fillStyle = (row + col) % 3 === 0 ? "#102821" : "#e3e8db";
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = "#687970";
      c.stroke();
    }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

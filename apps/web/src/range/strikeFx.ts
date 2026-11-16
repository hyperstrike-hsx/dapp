import * as THREE from "three";

// What a YES / NO target does when a round lands on it: a flash, two shockwave
// rings racing across the panel, a burst of glowing shards thrown back at the
// shooter and a "+1" that lifts off the impact. Everything is pooled.

export type StrikeSide = "YES" | "NO";
export type StrikeFx = {
  /** Objects the mirrored floor pass and probe should skip. */
  transient: THREE.Object3D[];
  hit: (now: number, point: THREE.Vector3, normal: THREE.Vector3, side: StrikeSide, streak: number) => void;
  update: (now: number, dt: number) => void;
  dispose: () => void;
};

export const STRIKE_COLOR: Record<StrikeSide, string> = { YES: "#6df3b6", NO: "#ff776f" };

const BURSTS = 8, SHARDS = 56, RINGS = 2;
const RING_MS = 520, FLASH_MS = 170, LABEL_MS = 1100;
const FORWARD = new THREE.Vector3(0, 0, 1);

function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,.75)");
  gradient.addColorStop(0.6, "rgba(255,255,255,.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function labelTexture(side: StrikeSide) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "900 92px Arial";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.shadowColor = STRIKE_COLOR[side];
  ctx.shadowBlur = 22;
  ctx.fillStyle = STRIKE_COLOR[side];
  ctx.fillText(`+1 ${side}`, 192, 68);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,.9)";
  ctx.fillText(`+1 ${side}`, 192, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createStrikeFx(scene: THREE.Scene): StrikeFx {
  const group = new THREE.Group();
  scene.add(group);
  const glow = glowTexture();
  const labels: Record<StrikeSide, THREE.Texture> = { YES: labelTexture("YES"), NO: labelTexture("NO") };
  const colors: Record<StrikeSide, THREE.Color> = { YES: new THREE.Color(STRIKE_COLOR.YES), NO: new THREE.Color(STRIKE_COLOR.NO) };
  const ringGeometry = new THREE.RingGeometry(0.86, 1, 64), flashGeometry = new THREE.PlaneGeometry(1, 1);
  const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide } as const;

  const bursts = Array.from({ length: BURSTS }, () => {
    const holder = new THREE.Group();
    holder.visible = false;
    const rings = Array.from({ length: RINGS }, () => new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ ...additive })));
    const flash = new THREE.Mesh(flashGeometry, new THREE.MeshBasicMaterial({ ...additive, map: glow }));
    holder.add(...rings, flash);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
    label.visible = false;
    const position = new Float32Array(SHARDS * 3), velocity = new Float32Array(SHARDS * 3), life = new Float32Array(SHARDS);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
    const shards = new THREE.Points(geometry, new THREE.PointsMaterial({ ...additive, map: glow, size: 0.085, sizeAttenuation: true }));
    shards.frustumCulled = false;
    shards.visible = false;
    group.add(holder, label, shards);
    return { holder, rings, flash, label, shards, position, velocity, life, born: -1e6, size: 1, origin: new THREE.Vector3(), side: "YES" as StrikeSide };
  });
  let cursor = 0;
  const tangent = new THREE.Vector3(), bitangent = new THREE.Vector3(), tint = new THREE.Color();

  return {
    transient: [group],
    hit(now, point, normal, side, streak) {
      const burst = bursts[cursor];
      cursor = (cursor + 1) % BURSTS;
      burst.born = now;
      burst.side = side;
      // A run of hits lands harder each time.
      burst.size = 1 + Math.min(streak, 8) * 0.07;
      burst.origin.copy(point).addScaledVector(normal, 0.03);
      burst.holder.position.copy(burst.origin);
      burst.holder.quaternion.setFromUnitVectors(FORWARD, normal);
      burst.holder.visible = true;
      tint.copy(colors[side]).multiplyScalar(5);
      burst.rings.forEach((ring) => ring.material.color.copy(tint));
      burst.flash.material.color.copy(colors[side]).multiplyScalar(7);
      burst.label.material.map = labels[side];
      burst.label.material.needsUpdate = true;
      burst.label.visible = true;
      burst.shards.material.color.copy(colors[side]).multiplyScalar(4);
      burst.shards.visible = true;
      tangent.set(0, 1, 0).cross(normal);
      if (tangent.lengthSq() < 1e-4) tangent.set(1, 0, 0);
      tangent.normalize();
      bitangent.crossVectors(normal, tangent);
      for (let i = 0; i < SHARDS; i += 1) {
        const angle = Math.random() * Math.PI * 2, spread = 0.6 + Math.random() * 2.6, out = 1.2 + Math.random() * 4.2;
        const x = Math.cos(angle) * spread, y = Math.sin(angle) * spread;
        burst.position.set([burst.origin.x, burst.origin.y, burst.origin.z], i * 3);
        burst.velocity[i * 3] = tangent.x * x + bitangent.x * y + normal.x * out;
        burst.velocity[i * 3 + 1] = tangent.y * x + bitangent.y * y + normal.y * out + 1.1;
        burst.velocity[i * 3 + 2] = tangent.z * x + bitangent.z * y + normal.z * out;
        burst.life[i] = 380 + Math.random() * 520;
      }
    },
    update(now, dt) {
      for (const burst of bursts) {
        const age = now - burst.born;
        if (age > Math.max(LABEL_MS, 900)) {
          burst.holder.visible = burst.label.visible = burst.shards.visible = false;
          continue;
        }
        // Rings: the second chases the first, both thinning as they spread.
        burst.rings.forEach((ring, index) => {
          const t = (age - index * 90) / RING_MS;
          ring.visible = t > 0 && t < 1;
          if (!ring.visible) return;
          const eased = 1 - (1 - t) ** 3;
          ring.scale.setScalar((0.05 + eased * (0.46 - index * 0.12)) * burst.size);
          ring.material.opacity = (1 - t) ** 1.6;
        });
        const flash = age / FLASH_MS;
        burst.flash.visible = flash < 1;
        if (burst.flash.visible) {
          burst.flash.scale.setScalar((0.2 + flash * 0.65) * burst.size);
          burst.flash.material.opacity = (1 - flash) ** 2;
        }
        // Shards: thrown back off the panel, falling and dimming.
        const position = burst.position, velocity = burst.velocity;
        let alive = 0;
        for (let i = 0; i < SHARDS; i += 1) {
          if (age > burst.life[i]) { position[i * 3 + 1] = -999; continue; }
          alive += 1;
          velocity[i * 3 + 1] -= 7.5 * dt;
          const drag = 1 - 1.8 * dt;
          velocity[i * 3] *= drag; velocity[i * 3 + 2] *= drag;
          position[i * 3] += velocity[i * 3] * dt;
          position[i * 3 + 1] += velocity[i * 3 + 1] * dt;
          position[i * 3 + 2] += velocity[i * 3 + 2] * dt;
        }
        burst.shards.visible = alive > 0;
        burst.shards.material.opacity = Math.max(0, 1 - age / 900);
        burst.shards.geometry.attributes.position.needsUpdate = true;
        // Label: pops, then lifts away.
        const lift = age / LABEL_MS;
        burst.label.visible = lift < 1;
        if (burst.label.visible) {
          const pop = Math.min(1, age / 110);
          const scale = (0.2 + 0.8 * (1 - (1 - pop) ** 3)) * 0.34 * burst.size;
          burst.label.scale.set(scale * 3, scale, 1);
          burst.label.position.copy(burst.origin);
          burst.label.position.y += 0.16 + (1 - (1 - lift) ** 2) * 0.62;
          burst.label.material.opacity = lift < 0.55 ? 1 : 1 - (lift - 0.55) / 0.45;
        }
      }
    },
    dispose() {
      scene.remove(group);
      ringGeometry.dispose();
      flashGeometry.dispose();
      glow.dispose();
      labels.YES.dispose();
      labels.NO.dispose();
      bursts.forEach((burst) => {
        burst.rings.forEach((ring) => ring.material.dispose());
        burst.flash.material.dispose();
        burst.label.material.dispose();
        burst.shards.geometry.dispose();
        burst.shards.material.dispose();
      });
    },
  };
}

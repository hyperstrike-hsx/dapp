import { Mesh, Sprite, type Scene, type Object3D } from "three";

// GTAO's normal override ignores alpha maps. Glass, decals and sprites must
// not write solid rectangles into its depth/normal buffer.
export function withOpaqueOccluders<T>(scene: Scene, render: () => T): T {
  const hidden: Object3D[] = [];
  scene.traverse((object) => {
    if (!object.visible) return;
    const materials =
      object instanceof Mesh
        ? Array.isArray(object.material)
          ? object.material
          : [object.material]
        : [];
    if (
      object instanceof Sprite ||
      materials.some((m) => m.transparent || !m.depthWrite || m.alphaTest > 0)
    ) {
      hidden.push(object);
      object.visible = false;
    }
  });
  try {
    return render();
  } finally {
    hidden.forEach((object) => {
      object.visible = true;
    });
  }
}

import { describe, expect, it } from "vitest";
import { Scene, MeshStandardMaterial, InstancedMesh } from "three";
import { addStadiumDetail } from "./stadiumDetail";
describe("stadium architecture", () => {
  it("batches architecture and spectators instead of creating a mesh per fan", () => {
    const scene = new Scene();
    const seats: number[] = [];
    for (let i = 0; i < 1200; i++)
      seats.push((i % 40) * 0.48 - 10, 1.6 + Math.floor(i / 40) * 0.1, -18);
    const detail = addStadiumDetail(scene, seats, new MeshStandardMaterial());
    expect(scene.children.length).toBeLessThan(12);
    expect(scene.children.every((mesh) => mesh instanceof InstancedMesh)).toBe(
      true,
    );
    expect(
      scene.children.filter((mesh) => (mesh as InstancedMesh).count === 1200),
    ).toHaveLength(3);
    expect(() => detail.update(12000)).not.toThrow();
  });
});

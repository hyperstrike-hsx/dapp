import { describe, expect, it } from "vitest";
import { Scene, Mesh, MeshBasicMaterial, Sprite, BoxGeometry } from "three";
import { withOpaqueOccluders } from "./opaqueOcclusion";
describe("ambient occlusion transparency", () => {
  it("excludes alpha surfaces and sprites, then restores their original visibility", () => {
    const scene = new Scene();
    const solid = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const glass = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ transparent: true }),
    );
    const decal = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ alphaTest: 0.1 }),
    );
    const sprite = new Sprite(),
      hidden = new Sprite();
    hidden.visible = false;
    scene.add(solid, glass, decal, sprite, hidden);
    withOpaqueOccluders(scene, () => {
      expect(solid.visible).toBe(true);
      [glass, decal, sprite, hidden].forEach((o) =>
        expect(o.visible).toBe(false),
      );
    });
    [solid, glass, decal, sprite].forEach((o) => expect(o.visible).toBe(true));
    expect(hidden.visible).toBe(false);
    expect(() =>
      withOpaqueOccluders(scene, () => {
        throw Error("render failed");
      }),
    ).toThrow();
    expect(sprite.visible).toBe(true);
  });
});

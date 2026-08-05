import { describe, expect, it } from "vitest";
import { paperMarkets } from "./markets";

describe("skin range launch markets", () => {
  it("uses local textures so WebGL does not depend on cross-origin image access", () => {
    expect(paperMarkets).toHaveLength(3);
    expect(paperMarkets.every((market) => market.image.startsWith("/skins/"))).toBe(true);
  });

  it("keeps stand accents in the HyperStrike mint, orange, and cyan palette", () => {
    expect(paperMarkets.map((market) => market.accent)).toEqual([0x8ef5e3, 0xe89a42, 0x4fc9df]);
  });
});

import { describe, expect, it } from "vitest";
import {
  createSportsReceipt,
  sportsDemoMarkets,
  sportsDemoPrices,
} from "./sportsDemoData";
describe("retired sports demonstration", () => {
  it("uses only explicit demo fixtures and prices", () => {
    expect(sportsDemoMarkets).toHaveLength(4);
    sportsDemoMarkets.forEach((m) => {
      expect(m.quoteToken).toBe("DEMO USD");
      expect(
        sportsDemoPrices[m.outcome].YES + sportsDemoPrices[m.outcome].NO,
      ).toBe(1);
    });
  });
  it("turns staged contracts into a local receipt without token burns", () => {
    const receipt = createSportsReceipt(90001, "YES", 100);
    expect(receipt).toMatchObject({
      contracts: 100,
      limitPrice: 0.52,
      orderValue: 52,
      burnAmount: 0,
      status: "SAVED",
    });
    expect(createSportsReceipt(90002, "NO", 21).orderValue).toBe(13.02);
  });
  it("rejects invalid drafts", () => {
    for (const count of [0, -1, 1.5, NaN, Infinity])
      expect(() => createSportsReceipt(90001, "YES", count)).toThrow();
    expect(() => createSportsReceipt(123, "YES", 1)).toThrow();
  });
});

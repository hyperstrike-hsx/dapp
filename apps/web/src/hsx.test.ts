import { describe, expect, it } from "vitest";
import { formatSupply, HSX_ADDRESS, type HsxStatus } from "./hsx";

describe("HSX metadata", () => {
  it("uses the canonical HyperEVM address", () => {
    expect(HSX_ADDRESS).toBe("0xab5dbc5a6070d066697d8e55471877ea4343ece3");
  });

  it("formats the verified billion-token supply", () => {
    const status: HsxStatus = {
      online: true,
      address: HSX_ADDRESS,
      decimals: 18,
      totalSupply: 1_000_000_000n * 10n ** 18n,
      supportsBurn: true,
      supportsBurnFrom: true,
    };
    expect(formatSupply(status)).toBe("1B");
  });
});

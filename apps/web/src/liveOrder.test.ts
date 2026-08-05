import { describe, expect, it } from "vitest";
import { deriveOrderId } from "./liveOrder";

describe("live HIP-4 order receipts", () => {
  const draft = {
    wallet: "0x1111111111111111111111111111111111111111",
    outcomeId: 189,
    marketName: "France",
    side: "YES" as const,
    contracts: 37,
    limitPrice: 0.4154,
    orderValue: 15.37,
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  it("derives stable 32-byte receipt IDs from reviewed order drafts", async () => {
    await expect(deriveOrderId(draft)).resolves.toMatch(/^0x[a-f0-9]{64}$/);
    await expect(deriveOrderId(draft)).resolves.toBe(await deriveOrderId(draft));
  });

  it("changes the receipt ID when the trade side changes", async () => {
    await expect(deriveOrderId({ ...draft, side: "NO" })).resolves.not.toBe(await deriveOrderId(draft));
  });
});

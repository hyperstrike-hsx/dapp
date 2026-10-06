import { describe, it, expect } from "vitest";
import { refreshSnapshot } from "./static-snapshot";
import { ageIndicativeFeed } from "@hyperstrike/market-types";
const now = 1800000000;
function source(time = now, factor = 1) {
  const row = (name: string, price: number, i: number) => ({
    market_hash_name: name,
    currency: "USD",
    min_price: price * factor,
    quantity: 100 - i,
    updated_at: time,
    created_at: now - 100 * 86400,
  });
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => row(`★ Knife ${i}`, 100, i)),
    ...Array.from({ length: 12 }, (_, i) => row(`★ Sport Gloves ${i}`, 100, i)),
    ...Array.from({ length: 20 }, (_, i) =>
      row(`AK-47 | Standard ${i}`, 10, i),
    ),
    ...Array.from({ length: 22 }, (_, i) => row(`AWP | Premium ${i}`, 300, i)),
    ...Array.from({ length: 22 }, (_, i) => row(`Equipment ${i} Case`, 1, i)),
  ];
  return (async () => new Response(JSON.stringify(rows))) as typeof fetch;
}
describe("static snapshot publication", () => {
  it("preserves initial baskets, baselines and history across stateless runs", async () => {
    const first = await refreshSnapshot(undefined, source(), () => now * 1000);
    const second = await refreshSnapshot(
      JSON.parse(JSON.stringify(first)),
      source(now + 600, 1.1),
      () => (now + 600) * 1000,
    );
    for (const index of second.indexes) {
      expect(index.value).toBe(1100);
      expect(index.baseAt).toBe(now);
      expect(index.history.map((p) => p.value)).toEqual([1000, 1100]);
      expect(
        index.constituents.map((c) => [c.name, c.baseUsd, c.weight]),
      ).toEqual(
        first.indexes
          .find((i) => i.ticker === index.ticker)!
          .constituents.map((c) => [c.name, c.baseUsd, c.weight]),
      );
    }
  });
  it("fails closed on provider outage without changing the prior snapshot", async () => {
    const first = await refreshSnapshot(undefined, source(), () => now * 1000);
    const before = JSON.stringify(first);
    await expect(
      refreshSnapshot(
        first,
        (async () => new Response("", { status: 429 })) as typeof fetch,
        () => (now + 600) * 1000,
      ),
    ).rejects.toThrow("preserving");
    expect(JSON.stringify(first)).toBe(before);
  });
  it("refuses invalid provenance, missing members or corrupted baselines", async () => {
    const first = await refreshSnapshot(undefined, source(), () => now * 1000);
    const invalid = structuredClone(first);
    invalid.indexes[0].constituents.pop();
    await expect(
      refreshSnapshot(invalid, source(), () => now * 1000),
    ).rejects.toThrow("baseline");
    await expect(
      refreshSnapshot(
        { ...first, methodology: "other" },
        source(),
        () => now * 1000,
      ),
    ).rejects.toThrow("methodology");
  });
  it("expires a static snapshot without inventing new data or mutating its provenance", async () => {
    const first = await refreshSnapshot(undefined, source(), () => now * 1000);
    const aged = ageIndicativeFeed(first, (now + 901) * 1000);
    expect(
      aged.indexes.every(
        (i) =>
          i.status === "STALE" &&
          i.value === 1000 &&
          i.settlementEligible === false,
      ),
    ).toBe(true);
    expect(first.indexes.every((i) => i.status === "OK")).toBe(true);
  });
});

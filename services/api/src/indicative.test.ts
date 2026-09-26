import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi } from "vitest";
import {
  createIndicativeFeed,
  validItems,
  selectBasket,
  calculatePreview,
  type Item,
} from "./indicative";
const now = 1800000000;
const item = (name: string, price = 100, quantity = 20): Item => ({
  market_hash_name: name,
  currency: "USD",
  min_price: price,
  quantity,
  updated_at: now,
  created_at: now - 100 * 86400,
});
const catalog = () => [
  ...Array.from({ length: 25 }, (_, i) =>
    item(`★ Knife ${i}`, 100 + i, 100 - i),
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    item(`★ Sport Gloves ${i}`, 100 + i, 100 - i),
  ),
  ...Array.from({ length: 20 }, (_, i) =>
    item(`AK-47 | Standard ${i}`, 10 + i, 100 - i),
  ),
  ...Array.from({ length: 22 }, (_, i) =>
    item(`AWP | Premium ${i}`, 300 + i, 100 - i),
  ),
  ...Array.from({ length: 22 }, (_, i) =>
    item(`Equipment ${i} Case`, 1 + i, 100 - i),
  ),
];
describe("display-only Skinport indexes", () => {
  it("rejects stale, malformed, duplicate, variant and non-USD rows", () => {
    const rows = [
      item("good"),
      item("duplicate"),
      item("duplicate"),
      { ...item("old"), updated_at: now - 901 },
      { ...item("future"), updated_at: now + 1 },
      { ...item("eur"), currency: "EUR" },
      { ...item("variant"), version: "phase1" },
      { ...item("invalid"), min_price: 0 },
      null,
    ];
    expect(validItems(rows, now).map((r) => r.market_hash_name)).toEqual([
      "good",
    ]);
  });
  it("selects complete deterministic baskets with exact sleeve weights and a 1,000 base", () => {
    for (const [ticker, count] of [
      ["HS-CS50", 50],
      ["HS-KNIFE20", 20],
      ["HS-GLOVE10", 10],
      ["HS-BLUE20", 20],
      ["HS-CASE20", 20],
    ] as const) {
      const basket = selectBasket(ticker, catalog(), now)!;
      expect(basket.members).toHaveLength(count);
      expect(new Set(basket.members.map((m) => m.name)).size).toBe(count);
      expect(basket.members.reduce((n, m) => n + m.weight, 0)).toBeCloseTo(
        1,
        12,
      );
      expect(calculatePreview(basket, catalog()).value).toBe(1000);
      expect(selectBasket(ticker, catalog().reverse(), now)).toEqual(basket);
    }
    const basket = selectBasket("HS-CS50", catalog(), now)!;
    expect(
      basket.members
        .filter((m) => m.name.startsWith("★ Knife"))
        .reduce((n, m) => n + m.weight, 0),
    ).toBeCloseTo(0.3);
    expect(selectBasket("HS-CS50", [], now)).toBeNull();
  });
  it("measures actual price moves but refuses partial-basket reweighting", () => {
    const basket = selectBasket("HS-KNIFE20", catalog(), now)!;
    expect(
      calculatePreview(
        basket,
        catalog().map((i) => ({ ...i, min_price: i.min_price * 1.1 })),
      ).value,
    ).toBe(1100);
    expect(
      calculatePreview(
        basket,
        catalog().filter((i) => i.market_hash_name !== basket.members[0].name),
      ).value,
    ).toBeNull();
  });
  it("deduplicates requests, persists baselines across restart, and marks failures stale without touching oracle tables", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE canonical_observations(value TEXT)");
    let time = now * 1000;
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            catalog().map((i) => ({
              ...i,
              updated_at: Math.floor(time / 1000),
              min_price: i.min_price * (time > now * 1000 ? 1.1 : 1),
            })),
          ),
        ),
    );
    const feed = createIndicativeFeed(db, request as typeof fetch, () => time);
    const [first, parallel] = await Promise.all([feed(), feed()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(parallel).toEqual(first);
    expect(
      first.indexes.every(
        (i) => i.value === 1000 && i.status === "OK" && !i.settlementEligible,
      ),
    ).toBe(true);
    await feed();
    expect(request).toHaveBeenCalledTimes(1);
    time += 300001;
    const restarted = createIndicativeFeed(
      db,
      request as typeof fetch,
      () => time,
    );
    const next = await restarted();
    expect(
      next.indexes.every(
        (i) => i.value === 1100 && i.baseAt === now && i.history.length === 2,
      ),
    ).toBe(true);
    time += 300001;
    request.mockRejectedValueOnce(Error("offline"));
    const stale = await restarted();
    expect(
      stale.indexes.every(
        (i) => i.value === 1100 && i.status === "STALE" && i.coverage === 0,
      ),
    ).toBe(true);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM canonical_observations").get()!
        .count,
    ).toBe(0);
    db.close();
  });
  it("never invents a baseline when the upstream is unavailable", async () => {
    const db = new DatabaseSync(":memory:");
    const feed = createIndicativeFeed(
      db,
      (async () => new Response("rate limit", { status: 429 })) as typeof fetch,
      () => now * 1000,
    );
    expect(
      (await feed()).indexes.every(
        (i) =>
          i.value === null &&
          i.status === "UNAVAILABLE" &&
          i.history.length === 0,
      ),
    ).toBe(true);
    db.close();
  });
  it("expires source observations even within the five-minute cache", async () => {
    const db = new DatabaseSync(":memory:");
    let time = now * 1000;
    const feed = createIndicativeFeed(
      db,
      (async () =>
        new Response(
          JSON.stringify(
            catalog().map((i) => ({ ...i, updated_at: now - 850 })),
          ),
        )) as typeof fetch,
      () => time,
    );
    expect((await feed()).indexes[0].status).toBe("OK");
    time += 60000;
    expect((await feed()).indexes[0].status).toBe("STALE");
    db.close();
  });
});

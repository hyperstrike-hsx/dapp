import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
process.env.HS_DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";
const { server, db } = await import("./server");
let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
describe("public API fails closed", () => {
  it("exposes five canonical indexes, never invented observations", async () => {
    const r = await fetch(`${base}/v1/indexes`);
    const rows = await r.json();
    expect(rows).toHaveLength(5);
    expect(rows.every((r: { latest: unknown }) => r.latest === null)).toBe(
      true,
    );
  });
  it("does not label a missing oracle as live", async () => {
    const r = await fetch(`${base}/v1/oracle/status`);
    expect((await r.json()).status).toBe("UNAVAILABLE");
  });
  it("requires published composition and keeps history empty", async () => {
    expect((await fetch(`${base}/v1/indexes/HS-CS50/composition`)).status).toBe(
      503,
    );
    expect(
      await (await fetch(`${base}/v1/indexes/HS-CS50/history`)).json(),
    ).toEqual([]);
  });
  it("rejects item-market identifiers and arbitrary request fields", async () => {
    const r = await fetch(`${base}/v1/markets/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skinId: "dragon-lore", definition: {} }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("Unsupported field");
  });
  it("never fabricates executable liquidity", async () => {
    const r = await fetch(`${base}/v1/markets/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId: "missing",
        side: "YES",
        action: "BUY",
        amount: "25",
      }),
    });
    expect(r.status).toBe(503);
  });
  it("exposes monitoring without inventing healthy publication", async () => {
    const r = await fetch(`${base}/metrics`);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(await r.text()).toContain(
      'hyperstrike_index_available{index="HS-CS50"} 0',
    );
  });
});

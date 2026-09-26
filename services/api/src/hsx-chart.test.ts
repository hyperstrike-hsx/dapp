import { describe, expect, it, vi } from "vitest";
import { HSX, createHsxFeed, parseHsxCandles } from "./hsx-chart";
const time = 1_790_000_000_000;
const payload = (rows: unknown[] = [[1790000000, 2, 4, 1, 3, 50]]) => ({
  meta: { base: { address: HSX } },
  data: { attributes: { ohlcv_list: rows } },
});
describe("HSX display feed", () => {
  it("sorts real candles without inventing empty intervals", () => {
    const rows = parseHsxCandles(
      payload([
        [1790000000, 2, 4, 1, 3, 50],
        [1789900000, 1, 2, 1, 2, 5],
      ]),
      time,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe(1789900000);
  });
  it("rejects the wrong token and invalid price data", () => {
    expect(() =>
      parseHsxCandles(
        { ...payload(), meta: { base: { address: "0xwrong" } } },
        time,
      ),
    ).toThrow();
    for (const row of [
      [1790000000, 2, 1, 1, 3, 50],
      [1790000000, 2, 4, 1, 3, -1],
      [1790000000, 0, 4, 1, 3, 1],
      [1790000000, 2, 4, 1, NaN, 1],
    ]) {
      expect(() => parseHsxCandles(payload([row]), time)).toThrow();
    }
  });
  it("coalesces concurrent requests, caches, and labels last-good data stale", async () => {
    let now = time;
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload() });
    const get = createHsxFeed(fetcher, () => now);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 31000;
    fetcher.mockRejectedValue(Error("offline"));
    const stale = await get();
    expect(stale.status).toBe("STALE");
    expect(stale.fetchedAt).toBe(time);
    expect(stale.candles).toEqual(a.candles);
    await get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("returns unavailable, not fictional candles, on initial failure", async () => {
    const get = createHsxFeed(
      vi.fn().mockRejectedValue(Error("offline")),
      () => time,
    );
    expect(await get()).toMatchObject({
      status: "UNAVAILABLE",
      candles: [],
      fetchedAt: 0,
    });
  });
});

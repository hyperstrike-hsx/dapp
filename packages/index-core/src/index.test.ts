import { describe, it, expect } from "vitest";
import {
  referencePrice,
  ASK_REFERENCE_POLICY,
  cappedWeights,
  calculateIndex,
  continuityDivisor,
  settlementTwap,
  eligibilityScore,
  E8,
  WAD,
  type VenueObservation,
  type ReferencePrice,
} from "./index";
import {
  integratedCost,
  quoteBuy,
  quoteSell,
  mintQuote,
} from "../../sdk/src/index";
import {
  expiryTime,
  INDEXES,
  marketKey,
  resolvesYes,
  SETTLEMENT_POLICY_ID,
  type MarketDefinition,
} from "../../market-types/src/index";
const now = 1_800_000_000_000;
const quote = (providerId: string, price: bigint): VenueObservation => ({
  constituentId: "internal-1",
  providerId,
  observedAtMs: now,
  receivedAtMs: now,
  bidE8: price - E8 / 100n,
  askE8: price + E8 / 100n,
  bidDepthUsdE8: 1000n * E8,
  askDepthUsdE8: 1000n * E8,
  rawPayloadHash: "0xab",
});
const hrp = (valueE8: bigint, confidenceBps = 10000): ReferencePrice => ({
  status: "AVAILABLE",
  valueE8,
  confidenceBps,
  observedAtMs: now,
  components: {},
  sources: [],
  rejected: [],
});
describe("reference price deterministic engine", () => {
  it("ranks eligibility deterministically without overriding the minimum gates", () => {
    const input = {
      sources: 3,
      uptimeBps: 10000,
      spreadBps: 0,
      historyDays: 30,
      integrityFlag: false,
      ageDays: 120,
      liquidityBps: 10000,
      agreementBps: 10000,
    };
    expect(eligibilityScore(input)).toMatchObject({
      scoreBps: 10000,
      eligible: true,
    });
    expect(eligibilityScore({ ...input, integrityFlag: true })).toMatchObject({
      scoreBps: 10000,
      eligible: false,
    });
    expect(eligibilityScore({ ...input, uptimeBps: NaN })).toMatchObject({
      scoreBps: 0,
      eligible: false,
    });
    expect(() => eligibilityScore({ ...input, liquidityBps: 10001 })).toThrow();
  });
  it("golden vector: midpoint of two qualifying venue mids", () => {
    const r = referencePrice(
      "internal-1",
      [quote("a", 100n * E8), quote("b", 102n * E8)],
      now,
    );
    expect(r.status).toBe("AVAILABLE");
    if (r.status === "AVAILABLE") {
      expect(r.valueE8).toBe(101n * E8);
      expect(r.confidenceBps).toBeLessThan(9000);
    }
  });
  describe("HS-MVA-1 consolidated ask reference", () => {
    const ask = (
      providerId: string,
      usd: number,
      listed = 50,
      bidUsd?: number,
      ageMs = 0,
    ): VenueObservation => ({
      constituentId: "internal-1",
      providerId,
      observedAtMs: now - ageMs,
      receivedAtMs: now - ageMs,
      askE8: BigInt(Math.round(usd * 100)) * (E8 / 100n),
      askDepthUsdE8: BigInt(Math.round(usd * 100)) * (E8 / 100n) * BigInt(listed),
      bidE8: bidUsd ? BigInt(Math.round(bidUsd * 100)) * (E8 / 100n) : undefined,
      rawPayloadHash: "0xab",
    });
    const price = (qs: VenueObservation[]) =>
      referencePrice("internal-1", qs, now, ASK_REFERENCE_POLICY);
    it("needs three venues and prices ask-only quotes", () => {
      expect(price([ask("a", 100), ask("b", 101)]).status).toBe("UNAVAILABLE");
      const r = price([ask("a", 100), ask("b", 101), ask("c", 104)]);
      expect(r.status).toBe("AVAILABLE");
      if (r.status === "AVAILABLE") {
        expect(r.valueE8).toBe(101n * E8);
        expect(r.components.sources).toBe(400);
        // No resting bid anywhere is a fixed corroboration penalty.
        expect(r.components.spread).toBe(300);
      }
    });
    it("takes the depth-weighted median with no venue above 40%", () => {
      const r = price([
        ask("a", 100, 1),
        ask("b", 101, 1),
        ask("c", 102, 1),
        ask("d", 103, 1),
        ask("e", 110, 100_000),
      ]);
      // The deep venue is capped at 40%, so it cannot drag the median to 110.
      if (r.status === "AVAILABLE") expect(r.valueE8).toBe(103n * E8);
      else throw Error("unavailable");
    });
    it("rejects an outlier ask and a venue with no ask, and is permutation invariant", () => {
      const qs = [
        ask("a", 100),
        ask("b", 101),
        ask("c", 102),
        ask("d", 150),
        { ...ask("e", 100), askE8: undefined },
      ];
      const r = price(qs);
      expect(price([...qs].reverse())).toEqual(r);
      if (r.status !== "AVAILABLE") throw Error("unavailable");
      expect(r.valueE8).toBe(101n * E8);
      expect(r.rejected).toEqual(
        expect.arrayContaining([
          { providerId: "d", reason: "OUTLIER" },
          { providerId: "e", reason: "NO_ASK" },
        ]),
      );
    });
    it("uses bids only as corroboration and forgives one venue cache interval", () => {
      const tight = price([
        ask("a", 100, 50, 98),
        ask("b", 100),
        ask("c", 100),
        ask("d", 100, 50, undefined, 300_000),
      ]);
      if (tight.status !== "AVAILABLE") throw Error("unavailable");
      expect(tight.valueE8).toBe(100n * E8);
      expect(tight.components.spread).toBe(100);
      expect(tight.components.staleness).toBe(0);
      expect(tight.confidenceBps).toBe(9900);
      const old = price([
        ask("a", 100),
        ask("b", 100),
        ask("c", 100),
        ask("d", 100, 50, undefined, 450_000),
        ask("e", 100, 50, undefined, 600_001),
      ]);
      if (old.status !== "AVAILABLE") throw Error("unavailable");
      expect(old.components.staleness).toBe(350);
      expect(old.rejected).toEqual([
        { providerId: "e", reason: "STALE_OR_FUTURE" },
      ]);
    });
  });
  it("rejects one extreme outlier and is permutation invariant", () => {
    const qs = [
      quote("a", 100n * E8),
      quote("b", 101n * E8),
      quote("c", 100n * E8),
      quote("d", 9000n * E8),
    ];
    const r = referencePrice("internal-1", qs, now);
    expect(referencePrice("internal-1", [...qs].reverse(), now)).toEqual(r);
    if (r.status === "AVAILABLE") {
      expect(r.valueE8).toBe(100n * E8);
      expect(r.rejected).toContainEqual({ providerId: "d", reason: "OUTLIER" });
    }
  });
  it("cannot gain source coverage through duplicate provider identity", () => {
    expect(
      referencePrice(
        "internal-1",
        [quote("a", 100n * E8), quote("a", 100n * E8)],
        now,
      ).status,
    ).toBe("UNAVAILABLE");
  });
  it("rejects stale, crossed, future, and ask-only observations", () => {
    for (const invalid of [
      { observedAtMs: now - 300001 },
      { bidE8: 102n * E8 },
      { observedAtMs: now + 1 },
      { bidE8: undefined },
    ]) {
      expect(
        referencePrice(
          "internal-1",
          [{ ...quote("a", 100n * E8), ...invalid }, quote("b", 100n * E8)],
          now,
        ).status,
      ).toBe("UNAVAILABLE");
    }
  });
  it("caps even extreme source weights, preserves exact WAD", () => {
    for (let i = 1n; i < 100n; i++) {
      const weights = cappedWeights([i ** 10n, 20n, 1n]);
      expect(weights.reduce((a, b) => a + b, 0n)).toBe(WAD);
      expect(weights.every((w) => w <= (WAD * 40n) / 100n)).toBe(true);
    }
  });
  it("handles prices beyond JS integer precision without rounding to doubles", () => {
    const p = 10n ** 28n;
    const result = referencePrice(
      "internal-1",
      [quote("a", p), quote("b", p + 2n)],
      now,
    );
    if (result.status === "AVAILABLE") expect(result.valueE8).toBe(p + 1n);
    else throw Error("price unavailable");
  });
});
describe("canonical index math", () => {
  const basket = Array.from({ length: 10 }, (_, i) => ({
    constituentId: `glove-${i}`,
    weightE18: WAD / 10n,
    basePriceE8: 100n * E8,
    hrp: hrp(110n * E8),
  }));
  it("golden 10% return = 1100, exact harmonic confidence", () => {
    const result = calculateIndex(basket, 1000n * E8);
    expect(result.valueE8).toBe(1100n * E8);
    expect(result.confidenceBps).toBe(10000);
  });
  it("allows exactly 10% missing; two missing gloves are unavailable", () => {
    const missing = { status: "UNAVAILABLE", rejected: [] } as ReferencePrice;
    const one = calculateIndex(
      basket.map((b, i) => (i === 0 ? { ...b, hrp: missing } : b)),
      1000n * E8,
    );
    expect(one.status).toBe("DEGRADED");
    expect(one.valueE8! >= 1100n * E8 - 10n).toBe(true);
    expect(
      calculateIndex(
        basket.map((b, i) => (i < 2 ? { ...b, hrp: missing } : b)),
        1000n * E8,
      ).status,
    ).toBe("UNAVAILABLE");
  });
  it("refuses wrong weights and preserves rebalance continuity", () => {
    expect(() => calculateIndex(basket.slice(1), 1000n * E8)).toThrow();
    expect(continuityDivisor(1100n * E8, (11n * WAD) / 10n)).toBe(1000n * E8);
  });
  it("uses harmonic rather than arithmetic confidence", () => {
    const values = [
      { ...basket[0], weightE18: WAD / 2n, hrp: hrp(100n * E8, 10000) },
      { ...basket[1], weightE18: WAD / 2n, hrp: hrp(100n * E8, 5000) },
    ];
    expect(calculateIndex(values, 1000n * E8).confidenceBps).toBe(6666);
  });
  it("TWAP requires covering boundaries, cadence and confidence", () => {
    const t = 1800000000;
    const obs = [-300, 0, 300].map((dt, i) => ({
      indexId: INDEXES[0].indexId,
      versionId: "0x01" as const,
      observedAt: t + dt,
      valueE8: BigInt(1000 + i * 100) * E8,
      confidenceBps: 9500,
      status: "HEALTHY" as const,
      constituentRoot: "0x02" as const,
      sourceDataRoot: "0x03" as const,
      sequence: BigInt(i + 1),
    }));
    expect(settlementTwap(obs, INDEXES[0].indexId, t, t + 300)).toMatchObject({
      state: "READY",
      valueE8: 1050n * E8,
    });
    expect(
      settlementTwap(obs.slice(1), INDEXES[0].indexId, t, t + 300),
    ).toEqual({ state: "WAITING" });
    expect(settlementTwap(obs, INDEXES[0].indexId, t, t + 86400, true)).toEqual(
      { state: "INVALID" },
    );
  });
});
describe("capacity and complete-set AMM", () => {
  it("curve integral stays consistent across splitting and target boundary", () => {
    const S = 9999n * WAD,
      q = 3n * WAD;
    const joined = integratedCost(S, q, 20n * WAD, 100n * WAD, 10000n * WAD);
    const split =
      integratedCost(S, WAD, 20n * WAD, 100n * WAD, 10000n * WAD) +
      integratedCost(S + WAD, 2n * WAD, 20n * WAD, 100n * WAD, 10000n * WAD);
    expect(joined).toBe(split);
    expect(joined < 300n * WAD).toBe(true);
    expect(mintQuote(0n, WAD, E8).hsxIn >= 20n * WAD).toBe(true);
  });
  it("fuzzes alternating trades: k never falls and roundtrips cannot print collateral", () => {
    for (let i = 2n; i < 300n; i++) {
      const reserve = 5000_000000n;
      const gross = i * 123456n;
      const buy = quoteBuy(reserve, reserve, i % 2n ? "YES" : "NO", gross);
      expect(buy.yes * buy.no >= reserve * reserve).toBe(true);
      const sold = quoteSell(
        buy.yes,
        buy.no,
        i % 2n ? "YES" : "NO",
        buy.tokens,
      );
      expect(sold.collateral < gross).toBe(true);
      expect(sold.yes * sold.no >= buy.yes * buy.no).toBe(true);
    }
  });
  it("rejects zero-output/zero-liquidity trades", () => {
    expect(() => quoteBuy(0n, 100n, "YES", 100n)).toThrow();
    expect(() => quoteBuy(100n, 100n, "YES", 1n)).toThrow();
    expect(() => quoteSell(100n, 100n, "YES", 1n)).toThrow();
  });
});
describe("canonical slots", () => {
  it("handles month end, leap year, weekly Friday and cutoff", () => {
    const sec = (s: string) => Date.parse(s) / 1000;
    expect(expiryTime("MONTHLY", sec("2028-02-01T00:00:00Z"))).toBe(
      sec("2028-02-29T16:00:00Z"),
    );
    expect(expiryTime("WEEKLY", sec("2026-09-25T15:56:00Z"))).toBe(
      sec("2026-10-02T16:00:00Z"),
    );
    expect(expiryTime("DAILY", sec("2026-09-25T15:55:00Z"))).toBe(
      sec("2026-09-26T16:00:00Z"),
    );
  });
  it("has deterministic keys and equality resolves YES in either direction", () => {
    const d: MarketDefinition = {
      template: "MOVE",
      indexId: INDEXES[0].indexId,
      direction: "DOWN",
      thresholdE8: 5n * E8,
      creationReferenceTime: 1,
      creationReferenceValueE8: 1000n * E8,
      resolutionTime: 1000,
      tradeCloseTime: 700,
      settlementPolicyId: SETTLEMENT_POLICY_ID,
    };
    expect(resolvesYes(d, 950n * E8)).toBe(true);
    expect(resolvesYes(d, 951n * E8)).toBe(false);
    expect(marketKey(d)).toBe(marketKey({ ...d }));
  });
});

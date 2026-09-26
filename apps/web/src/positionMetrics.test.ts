import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell } from "@hyperstrike/sdk";
import { positionMetrics } from "./positionMetrics";

describe("position presentation", () => {
  const q = quoteBuy(5_000_000_000n, 5_000_000_000n, "YES", 25_000_000n);
  const p = {
    id: "test",
    marketId: "test",
    name: "HS-CS50",
    side: "YES" as const,
    tokens: q.tokens.toString(),
    spent: "25000000",
    createdAt: 0,
  };
  const tape = { yes: q.yes.toString(), no: q.no.toString() };
  it("uses an executable full-position sell quote rather than spot multiplication", () => {
    const m = positionMetrics(p, tape);
    expect(m.exitValue).toBe(
      Number(quoteSell(q.yes, q.no, "YES", q.tokens).collateral) / 1e6,
    );
    expect(m.pnl).toBeLessThan(0);
    expect(m.cost).toBe(25);
    expect(m.winningPayout).toBe(Number(q.tokens) / 1e6);
  });
  it("does not invent valuations for absent, closed or invalid markets", () => {
    expect(positionMetrics(p).exitValue).toBeNull();
    expect(positionMetrics(p, tape, false).pnl).toBeNull();
    expect(positionMetrics(p, { yes: "0", no: "0" }).exitValue).toBeNull();
  });
});

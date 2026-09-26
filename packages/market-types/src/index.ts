import { AbiCoder, id, keccak256 } from "ethers";
export type { IndicativeIndex, IndicativeFeed } from "./indicative";
import type { Hex } from "@hyperstrike/oracle-types";
export const INDEXES = [
  {
    ticker: "HS-CS50",
    name: "The CS2 economy",
    count: 50,
    description:
      "A diversified benchmark of knives, gloves, weapon skins, cases and collectibles.",
  },
  {
    ticker: "HS-KNIFE20",
    name: "The knife economy",
    count: 20,
    description:
      "Twenty liquid knife configurations, diversified across families and finishes.",
  },
  {
    ticker: "HS-GLOVE10",
    name: "The glove economy",
    count: 10,
    description:
      "Ten liquid glove configurations. Equal weight. No single-item bets.",
  },
  {
    ticker: "HS-BLUE20",
    name: "Premium collectibles",
    count: 20,
    description:
      "Iconic, liquid collectibles with stricter source and history requirements.",
  },
  {
    ticker: "HS-CASE20",
    name: "Cases & containers",
    count: 20,
    description:
      "Twenty seasoned cases and containers, with a 90-day eligibility floor.",
  },
].map((i) => ({ ...i, indexId: id(i.ticker) as Hex }));
export type Expiry = "DAILY" | "WEEKLY" | "MONTHLY";
export type MarketDefinition = {
  template: "LEVEL" | "MOVE";
  indexId: Hex;
  direction: "UP" | "DOWN";
  thresholdE8: bigint;
  creationReferenceTime: number;
  creationReferenceValueE8: bigint;
  tradeCloseTime: number;
  resolutionTime: number;
  settlementPolicyId: Hex;
};
export const SETTLEMENT_POLICY_ID = id("HS-TWAP-5M-15M-24H-V1") as Hex;
export function expiryTime(expiry: Expiry, now: number): number {
  const d = new Date(now * 1000);
  d.setUTCHours(16, 0, 0, 0);
  if (expiry === "DAILY") {
    if (d.getTime() / 1000 - 300 <= now) d.setUTCDate(d.getUTCDate() + 1);
  } else if (expiry === "WEEKLY") {
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
    if (d.getTime() / 1000 - 300 <= now) d.setUTCDate(d.getUTCDate() + 7);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    if (d.getTime() / 1000 - 300 <= now) d.setUTCMonth(d.getUTCMonth() + 2, 0);
  }
  return d.getTime() / 1000;
}
export const moveThresholds = (expiry: Expiry): bigint[] =>
  (expiry === "DAILY"
    ? [250, 500]
    : expiry === "WEEKLY"
      ? [500, 750, 1000]
      : [1000, 1500, 2000]
  ).map((v) => BigInt(v) * 1_000_000n);
export function levelThresholds(levelE8: bigint, expiry: Expiry): bigint[] {
  // V1 improved precision: step derived from a power-of-ten reference bucket.
  // The exact grid is shared with ProtocolConfig, never chosen by a creator.
  let magnitude = 100_000_000n;
  while (magnitude * 10n <= levelE8) magnitude *= 10n;
  const step =
    (magnitude *
      BigInt(expiry === "DAILY" ? 100 : expiry === "WEEKLY" ? 250 : 500)) /
    10_000n;
  const center = ((levelE8 + step / 2n) / step) * step;
  return [-2n, -1n, 0n, 1n, 2n]
    .map((n) => center + n * step)
    .filter((v) => v > 0n);
}
export function marketKey(d: MarketDefinition): Hex {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint8", "bytes32", "uint8", "int192", "uint192", "uint64", "bytes32"],
      [
        d.template === "LEVEL" ? 0 : 1,
        d.indexId,
        d.direction === "UP" ? 0 : 1,
        d.thresholdE8,
        d.creationReferenceValueE8,
        d.resolutionTime,
        d.settlementPolicyId,
      ],
    ),
  ) as Hex;
}
export function validateDefinition(
  d: MarketDefinition,
  now: number,
  reference: { valueE8: bigint; observedAt: number; confidenceBps: number },
) {
  if (!INDEXES.some((i) => i.indexId === d.indexId))
    throw new Error("Only canonical indexes are accepted");
  if (
    !["LEVEL", "MOVE"].includes(d.template) ||
    !["UP", "DOWN"].includes(d.direction)
  )
    throw new Error("Invalid template/direction");
  if (d.settlementPolicyId !== SETTLEMENT_POLICY_ID)
    throw new Error("Unknown settlement policy");
  if (
    reference.confidenceBps < 9000 ||
    reference.observedAt > now ||
    now - reference.observedAt > 300
  )
    throw new Error("Fresh healthy index required");
  const expiry = (["DAILY", "WEEKLY", "MONTHLY"] as Expiry[]).find(
    (e) =>
      expiryTime(e, now) === d.resolutionTime &&
      (d.template === "LEVEL"
        ? levelThresholds(reference.valueE8, e)
        : moveThresholds(e)
      ).includes(d.thresholdE8),
  );
  if (!expiry || d.tradeCloseTime !== d.resolutionTime - 300)
    throw new Error("Noncanonical expiry or strike");
  if (
    d.template === "MOVE" &&
    (d.creationReferenceValueE8 !== reference.valueE8 ||
      d.creationReferenceTime !== reference.observedAt)
  )
    throw new Error("MOVE reference mismatch");
  if (
    d.template === "LEVEL" &&
    (d.creationReferenceTime !== 0 || d.creationReferenceValueE8 !== 0n)
  )
    throw new Error("LEVEL has no creation reference");
  return true;
}
export function question(d: MarketDefinition): string {
  const ticker =
    INDEXES.find((i) => i.indexId === d.indexId)?.ticker ?? "Unknown index";
  return d.template === "LEVEL"
    ? `Will ${ticker} close ${d.direction === "UP" ? "at or above" : "at or below"} ${(Number(d.thresholdE8) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 })}?`
    : `Will ${ticker} ${d.direction === "UP" ? "rise" : "fall"} at least ${(Number(d.thresholdE8) / 1e8).toFixed(1)}%?`;
}
export function resolvesYes(d: MarketDefinition, valueE8: bigint): boolean {
  const compared =
    d.template === "LEVEL"
      ? valueE8
      : ((valueE8 - d.creationReferenceValueE8) * 100n * 100_000_000n) /
        d.creationReferenceValueE8;
  return d.direction === "UP"
    ? compared >= d.thresholdE8
    : compared <= (d.template === "LEVEL" ? d.thresholdE8 : -d.thresholdE8);
}

import {
  INDEXES,
  expiryTime,
  levelThresholds,
  moveThresholds,
  marketKey,
  question,
  SETTLEMENT_POLICY_ID,
  type Expiry,
  type MarketDefinition,
} from "@hyperstrike/market-types";
export function opportunities(
  indexId: string,
  ref: { valueE8: string; observedAt: number; confidenceBps: number },
  now: number,
  existing = new Set<string>(),
) {
  if (
    ref.confidenceBps < 9000 ||
    ref.observedAt > now ||
    now - ref.observedAt > 300 ||
    !INDEXES.some((i) => i.indexId === indexId)
  )
    return [];
  return (["DAILY", "WEEKLY", "MONTHLY"] as Expiry[]).flatMap((expiry) =>
    (["LEVEL", "MOVE"] as const).flatMap((template) =>
      (template === "LEVEL"
        ? levelThresholds(BigInt(ref.valueE8), expiry)
        : moveThresholds(expiry)
      ).flatMap((threshold) =>
        (["UP", "DOWN"] as const).map((direction) => {
          const resolutionTime = expiryTime(expiry, now);
          const definition: MarketDefinition = {
            template,
            indexId: indexId as `0x${string}`,
            direction,
            thresholdE8: threshold,
            creationReferenceTime: template === "MOVE" ? ref.observedAt : 0,
            creationReferenceValueE8:
              template === "MOVE" ? BigInt(ref.valueE8) : 0n,
            tradeCloseTime: resolutionTime - 300,
            resolutionTime,
            settlementPolicyId: SETTLEMENT_POLICY_ID,
          };
          const id = marketKey(definition);
          return {
            id,
            definition,
            expiry,
            question: question(definition),
            strikeCost: "1000000000000000000",
            creatorFeeShareBps: 3000,
            available: !existing.has(id),
          };
        }),
      ),
    ),
  );
}

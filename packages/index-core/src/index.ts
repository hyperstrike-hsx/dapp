import type { IndexObservation, IndexStatus } from "@hyperstrike/oracle-types";
export const E8 = 100_000_000n;
export const WAD = 10n ** 18n;
export const abs = (n: bigint) => (n < 0n ? -n : n);
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export function median(values: bigint[]): bigint {
  if (!values.length) throw new Error("Empty median");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2n;
}

// This data domain is deliberately not exported by market-types.
export type VenueObservation = {
  constituentId: string;
  providerId: string;
  observedAtMs: number;
  receivedAtMs: number;
  bidE8?: bigint;
  askE8?: bigint;
  bidDepthUsdE8?: bigint;
  askDepthUsdE8?: bigint;
  lastSaleE8?: bigint;
  rollingVolumeUsdE8?: bigint;
  sourceSequence?: string;
  rawPayloadHash: `0x${string}`;
  integrityValid?: boolean;
};
export type ProviderInstrumentMapping = {
  providerId: string;
  constituentId: string;
  instrument: string;
};
export interface PriceProvider {
  providerId(): string;
  fetch(mapping: ProviderInstrumentMapping): Promise<VenueObservation>;
}
export type HrpPolicy = {
  maxAgeMs: number;
  maxSpreadBps: bigint;
  minDepthUsdE8: bigint;
  disabledProviders: readonly string[];
};
export const DEFAULT_HRP_POLICY: HrpPolicy = {
  maxAgeMs: 300_000,
  maxSpreadBps: 1500n,
  minDepthUsdE8: 100n * E8,
  disabledProviders: [],
};
export type ReferencePrice =
  | {
      status: "AVAILABLE";
      valueE8: bigint;
      confidenceBps: number;
      observedAtMs: number;
      components: Record<string, number>;
      sources: { providerId: string; midE8: bigint; weightE18: bigint }[];
      rejected: { providerId: string; reason: string }[];
    }
  | {
      status: "UNAVAILABLE";
      rejected: { providerId: string; reason: string }[];
    };

/** Deterministic water-filling: no source exceeds 40%, even with extreme liquidity. */
export function cappedWeights(raw: bigint[]): bigint[] {
  if (raw.length < 3 || raw.some((v) => v <= 0n))
    throw new Error("Three positive weights required");
  const cap = (WAD * 40n) / 100n;
  const result = raw.map(() => 0n);
  let remaining = WAD;
  let open = raw.map((_, i) => i);
  while (open.length) {
    const total = open.reduce((s, i) => s + raw[i], 0n);
    const capped = open.filter((i) => (raw[i] * remaining) / total > cap);
    if (!capped.length) {
      for (const i of open) result[i] = (raw[i] * remaining) / total;
      let dust = WAD - result.reduce((s, v) => s + v, 0n);
      for (const i of open) {
        if (dust && result[i] < cap) {
          result[i]++;
          dust--;
        }
      }
      return result;
    }
    for (const i of capped) {
      result[i] = cap;
      remaining -= cap;
    }
    open = open.filter((i) => !capped.includes(i));
  }
  return result;
}

export function referencePrice(
  constituentId: string,
  inputs: readonly VenueObservation[],
  nowMs: number,
  policy = DEFAULT_HRP_POLICY,
): ReferencePrice {
  const rejected: { providerId: string; reason: string }[] = [];
  const counts = new Map<string, number>();
  inputs.forEach((q) =>
    counts.set(q.providerId, (counts.get(q.providerId) ?? 0) + 1),
  );
  const quotes = inputs
    .filter((q) => {
      let reason = "";
      if (q.constituentId !== constituentId) reason = "WRONG_CONSTITUENT";
      else if (counts.get(q.providerId)! > 1) reason = "DUPLICATE_PROVIDER";
      else if (policy.disabledProviders.includes(q.providerId))
        reason = "DISABLED";
      else if (q.integrityValid === false) reason = "INTEGRITY";
      else if (
        !Number.isSafeInteger(q.observedAtMs) ||
        !Number.isSafeInteger(q.receivedAtMs) ||
        q.observedAtMs < 0 ||
        q.observedAtMs > nowMs ||
        q.receivedAtMs > nowMs ||
        q.receivedAtMs < q.observedAtMs ||
        nowMs - q.observedAtMs > policy.maxAgeMs
      )
        reason = "STALE_OR_FUTURE";
      else if (!q.bidE8 || !q.askE8 || q.bidE8 <= 0n || q.bidE8 >= q.askE8)
        reason = "NOT_TWO_SIDED";
      else if (
        ((q.askE8 - q.bidE8) * 20_000n) / (q.askE8 + q.bidE8) >
        policy.maxSpreadBps
      )
        reason = "SPREAD";
      if (reason) rejected.push({ providerId: q.providerId, reason });
      return !reason;
    })
    .map((q) => ({ ...q, mid: (q.bidE8! + q.askE8!) / 2n }))
    .sort((a, b) =>
      a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
    );
  if (quotes.length < 2) return { status: "UNAVAILABLE", rejected };
  const m = median(quotes.map((q) => q.mid));
  const mad = median(quotes.map((q) => abs(q.mid - m)));
  const limit =
    (m * 1250n) / 10_000n > (mad * 7413n) / 1000n
      ? (m * 1250n) / 10_000n
      : (mad * 7413n) / 1000n;
  const valid = quotes.filter((q) => {
    if (abs(q.mid - m) <= limit) return true;
    rejected.push({ providerId: q.providerId, reason: "OUTLIER" });
    return false;
  });
  if (valid.length < 2) return { status: "UNAVAILABLE", rejected };
  const depth = valid.map((q) => {
    const observed = (q.bidDepthUsdE8 ?? 0n) + (q.askDepthUsdE8 ?? 0n);
    return observed > 0n
      ? observed
      : (q.rollingVolumeUsdE8 ?? 0n) > 0n
        ? q.rollingVolumeUsdE8!
        : 1n;
  });
  const weights =
    valid.length === 2 ? [WAD / 2n, WAD / 2n] : cappedWeights(depth);
  let valueE8 = (valid[0].mid + valid[1].mid) / 2n;
  if (valid.length > 2) {
    const sorted = valid
      .map((q, i) => ({ mid: q.mid, weight: weights[i] }))
      .sort((a, b) => (a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0));
    let sum = 0n;
    for (const q of sorted) {
      sum += q.weight;
      if (sum >= WAD / 2n) {
        valueE8 = q.mid;
        break;
      }
    }
  }
  const age = Math.max(...valid.map((q) => nowMs - q.observedAtMs));
  const spread = median(
    valid.map((q) => ((q.askE8! - q.bidE8!) * 10_000n) / q.mid),
  );
  const dispersion = median(valid.map((q) => (abs(q.mid - m) * 10_000n) / m));
  const components = {
    sources: valid.length === 2 ? 1400 : 0,
    staleness: Math.floor((age * 700) / policy.maxAgeMs),
    spread: Math.min(1000, (Number(spread) / 2) | 0),
    dispersion: Math.min(1200, Number(dispersion)),
    liquidity: median(depth) < policy.minDepthUsdE8 ? 800 : 0,
    outage: Math.min(400, rejected.length * 100),
  };
  return {
    status: "AVAILABLE",
    valueE8,
    confidenceBps: Math.max(
      0,
      10_000 - Object.values(components).reduce((s, v) => s + v, 0),
    ),
    components,
    observedAtMs: nowMs - age,
    sources: valid.map((q, i) => ({
      providerId: q.providerId,
      midE8: q.mid,
      weightE18: weights[i],
    })),
    rejected,
  };
}

export type ConstituentInput = {
  constituentId: string;
  weightE18: bigint;
  basePriceE8: bigint;
  hrp: ReferencePrice;
};
export type IndexCalculation = {
  status: IndexStatus;
  valueE8: bigint | null;
  confidenceBps: number;
  missingWeightE18: bigint;
  contributions: {
    constituentId: string;
    weightE18: bigint;
    contributionE8: bigint;
  }[];
};
export function calculateIndex(
  inputs: readonly ConstituentInput[],
  divisorE8: bigint,
  transitionPenaltyBps = 0,
): IndexCalculation {
  if (
    !inputs.length ||
    !Number.isSafeInteger(transitionPenaltyBps) ||
    transitionPenaltyBps < 0 ||
    transitionPenaltyBps > 10000 ||
    divisorE8 <= 0n ||
    inputs.some(
      (i) =>
        i.weightE18 <= 0n ||
        i.basePriceE8 <= 0n ||
        (i.hrp.status === "AVAILABLE" &&
          (i.hrp.valueE8 <= 0n ||
            !Number.isInteger(i.hrp.confidenceBps) ||
            i.hrp.confidenceBps < 0 ||
            i.hrp.confidenceBps > 10000)),
    ) ||
    inputs.reduce((s, i) => s + i.weightE18, 0n) !== WAD ||
    new Set(inputs.map((i) => i.constituentId)).size !== inputs.length
  )
    throw new Error("Invalid basket");
  const valid = inputs.filter((i) => i.hrp.status === "AVAILABLE");
  const available = valid.reduce((s, i) => s + i.weightE18, 0n);
  const missing = WAD - available;
  if (missing > WAD / 10n)
    return {
      status: "UNAVAILABLE",
      valueE8: null,
      confidenceBps: 0,
      missingWeightE18: missing,
      contributions: [],
    };
  const contributions = valid.map((i) => ({
    constituentId: i.constituentId,
    weightE18: (i.weightE18 * WAD) / available,
    contributionE8:
      (divisorE8 *
        i.weightE18 *
        (i.hrp as Extract<ReferencePrice, { status: "AVAILABLE" }>).valueE8) /
      (available * i.basePriceE8),
  }));
  let denominator = 0n;
  let zeroConfidence = false;
  for (const i of valid) {
    const c = (i.hrp as Extract<ReferencePrice, { status: "AVAILABLE" }>)
      .confidenceBps;
    if (c <= 0) zeroConfidence = true;
    else denominator += (i.weightE18 * WAD) / BigInt(c);
  }
  const harmonic = zeroConfidence ? 0 : Number((available * WAD) / denominator);
  const confidenceBps = Math.max(
    0,
    harmonic - Number((missing * 10_000n) / WAD) - transitionPenaltyBps,
  );
  const status: IndexStatus =
    confidenceBps < 7500
      ? "UNSAFE"
      : confidenceBps < 9000 || missing > 0n
        ? "DEGRADED"
        : "HEALTHY";
  return {
    status,
    valueE8: contributions.reduce((s, i) => s + i.contributionE8, 0n),
    confidenceBps,
    missingWeightE18: missing,
    contributions,
  };
}
export function continuityDivisor(
  oldValueE8: bigint,
  newRawE18: bigint,
): bigint {
  if (oldValueE8 <= 0n || newRawE18 <= 0n)
    throw new Error("Invalid continuity inputs");
  return (oldValueE8 * WAD) / newRawE18;
}
/** Left-continuous step TWAP, with samples covering both window boundaries. */
export function settlementTwap(
  observations: readonly IndexObservation[],
  indexId: string,
  t: number,
  now: number,
  incident = false,
):
  | {
      state: "READY";
      valueE8: bigint;
      sequences: bigint[];
      window: "PRIMARY" | "FALLBACK";
    }
  | { state: "WAITING" | "INVALID" } {
  if (incident) return { state: now >= t + 86400 ? "INVALID" : "WAITING" };
  for (const radius of [300, 900]) {
    if (now < t + radius) continue;
    const rows = observations
      .filter(
        (o) =>
          o.indexId === indexId &&
          o.observedAt >= t - radius &&
          o.observedAt <= t + radius &&
          o.confidenceBps >= 8500 &&
          o.status !== "UNSAFE",
      )
      .sort((a, b) => a.observedAt - b.observedAt);
    if (
      rows.length < 3 ||
      rows[0].observedAt !== t - radius ||
      rows.at(-1)!.observedAt !== t + radius ||
      new Set(rows.map((o) => o.observedAt)).size !== rows.length
    )
      continue;
    let weighted = 0n;
    let valid = true;
    for (let i = 0; i < rows.length - 1; i++) {
      const duration = rows[i + 1].observedAt - rows[i].observedAt;
      if (duration > radius || rows[i + 1].sequence <= rows[i].sequence) {
        valid = false;
        break;
      }
      weighted += rows[i].valueE8 * BigInt(duration);
    }
    if (valid)
      return {
        state: "READY",
        valueE8: weighted / BigInt(radius * 2),
        sequences: rows.map((o) => o.sequence),
        window: radius === 300 ? "PRIMARY" : "FALLBACK",
      };
  }
  return { state: now >= t + 86400 ? "INVALID" : "WAITING" };
}
export function eligibility(
  input: {
    sources: number;
    uptimeBps: number;
    spreadBps: number;
    historyDays: number;
    integrityFlag: boolean;
    ageDays: number;
  },
  maxSpreadBps = 1500,
  seasoningDays = 0,
) {
  const reasons = [
    (!Number.isInteger(input.sources) ||
      input.sources < 0 ||
      !Number.isInteger(input.uptimeBps) ||
      input.uptimeBps < 0 ||
      input.uptimeBps > 10000 ||
      !Number.isFinite(input.spreadBps) ||
      input.spreadBps < 0 ||
      !Number.isFinite(input.historyDays) ||
      input.historyDays < 0 ||
      !Number.isFinite(input.ageDays) ||
      input.ageDays < 0) &&
      "INVALID_METRICS",
    input.sources < 2 && "SOURCE_COVERAGE",
    input.uptimeBps < 9000 && "UPTIME",
    input.spreadBps > maxSpreadBps && "SPREAD",
    input.historyDays < 30 && "HISTORY",
    input.integrityFlag && "INTEGRITY",
    input.ageDays < seasoningDays && "SEASONING",
  ].filter(Boolean);
  return { eligible: reasons.length === 0, reasons };
}

/** Eligibility ranking v1. Minimum gates are never overridden by a high score. */
export function eligibilityScore(
  input: Parameters<typeof eligibility>[0] & {
    liquidityBps: number;
    agreementBps: number;
  },
  maxSpreadBps = 1500,
  seasoningDays = 0,
) {
  const gate = eligibility(input, maxSpreadBps, seasoningDays);
  if (
    ![input.liquidityBps, input.agreementBps].every(
      (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
    ) ||
    maxSpreadBps <= 0
  )
    throw Error("Invalid normalized ranking metrics");
  const components = {
    sourceCoverage: Math.min(10000, Math.floor((input.sources * 10000) / 3)),
    uptime: input.uptimeBps,
    liquidity: input.liquidityBps,
    spread: Math.max(
      0,
      10000 - Math.floor((input.spreadBps * 10000) / maxSpreadBps),
    ),
    history: Math.min(10000, Math.floor((input.historyDays * 10000) / 30)),
    agreement: input.agreementBps,
  };
  const scoreBps = gate.reasons.includes("INVALID_METRICS")
    ? 0
    : Math.floor(
        (25 * components.sourceCoverage +
          20 * components.uptime +
          20 * components.liquidity +
          15 * components.spread +
          10 * components.history +
          10 * components.agreement) /
          100,
      );
  return { ...gate, version: "ELIGIBILITY-1", scoreBps, components };
}

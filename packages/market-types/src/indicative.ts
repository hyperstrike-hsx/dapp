/** Display-only observations. Deliberately incompatible with signed oracle observations. */
export type IndicativeIndex = {
  ticker: string;
  indexId: string;
  provenance: "INDICATIVE";
  settlementEligible: false;
  status: "OK" | "STALE" | "UNAVAILABLE";
  value: number | null;
  changeSinceBasePct: number | null;
  baseAt: number | null;
  observedAt: number | null;
  coverage: number;
  count: number;
  /** Multi-venue feed only: index confidence and the committed composition version. */
  confidenceBps?: number;
  versionId?: string;
  constituents: {
    name: string;
    baseUsd: number;
    priceUsd: number | null;
    weight: number;
    updatedAt: number | null;
    /** Venues whose quote passed the freshness and outlier filters. */
    sources?: number;
  }[];
  history: { value: number; observedAt: number }[];
};
export type IndicativeFeed = {
  /** Human-readable venue list. */
  source: string;
  sourceUrl: string;
  venues?: { id: string; label: string; site: string; ok: boolean }[];
  currency: "USD";
  methodology: string;
  checkedAt: number;
  error?: string;
  indexes: IndicativeIndex[];
};

/** Expire source observations at read time, even from cached static files. */
export function ageIndicativeFeed(
  feed: IndicativeFeed,
  now = Date.now(),
): IndicativeFeed {
  return {
    ...feed,
    indexes: feed.indexes.map((i) =>
      i.status === "OK" &&
      (i.observedAt === null ||
        i.observedAt > now / 1000 + 60 ||
        now / 1000 - i.observedAt > 900)
        ? { ...i, status: "STALE" }
        : i,
    ),
  };
}

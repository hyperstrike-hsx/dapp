/**
 * The official base day: every index is 1,000 at the freeze taken on Wednesday
 * 6 January 2027 (UTC), the first weekly drop reset after the Singapore Major
 * and the 2026 Winter Sale. A series based before it is a preview.
 */
export const INDEX_BASE_AT = Date.UTC(2027, 0, 6) / 1000;
/**
 * Nothing older is published or drawn. 23 October 2025 is the first full day
 * after the trade-up change that repriced knives and gloves; prices from
 * before it describe a different market.
 */
export const INDEX_HISTORY_FLOOR_AT = Date.UTC(2025, 9, 23) / 1000;

export type IndexPoint = { value: number; observedAt: number };
/**
 * History from before a series' base, rescaled to meet that base at 1,000.
 * PREVIEW was observed live on an earlier basket; BACKFILLED is reconstructed
 * from another source. Neither is part of the series itself.
 */
export type PriorSegment = {
  provenance: "PREVIEW" | "BACKFILLED";
  points: IndexPoint[];
};
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
  history: IndexPoint[];
  /** Earlier history, oldest first. Read it through `priorHistory`. */
  prior?: PriorSegment[];
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

/** A series based before the official base day is a preview of it. */
export const isPreview = (index: Pick<IndicativeIndex, "baseAt">) =>
  index.baseAt !== null && index.baseAt < INDEX_BASE_AT;
/** Earlier history as it may be published or drawn: nothing from before the floor. */
export const priorHistory = (
  index: Pick<IndicativeIndex, "prior">,
): PriorSegment[] =>
  (index.prior ?? [])
    .map((segment) => ({
      ...segment,
      points: segment.points.filter(
        (p) => p.observedAt >= INDEX_HISTORY_FLOOR_AT,
      ),
    }))
    .filter((segment) => segment.points.length);

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

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
  constituents: {
    name: string;
    baseUsd: number;
    priceUsd: number | null;
    weight: number;
    updatedAt: number | null;
  }[];
  history: { value: number; observedAt: number }[];
};
export type IndicativeFeed = {
  source: "Skinport";
  sourceUrl: string;
  currency: "USD";
  methodology: string;
  checkedAt: number;
  error?: string;
  indexes: IndicativeIndex[];
};

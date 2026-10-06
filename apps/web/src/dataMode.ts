// Static is the safe default in dev and production. API mode is explicit opt-in.
export const API_ENABLED = import.meta.env.VITE_DATA_MODE === "api";
export const INDEX_FEED_URL = API_ENABLED
  ? "/v1/indicative/indexes"
  : "/data/indicative-indexes.json";
export const HSX_FEED_URL = API_ENABLED
  ? "/v1/hsx/ohlcv"
  : "/data/hsx-ohlcv.json";

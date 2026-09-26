export const HSX = "0xab5dbc5a6070d066697d8e55471877ea4343ece3";
export const HSX_POOL = "0xa92ab5ed3041025b844233b109216c6c3c0bc63c";
type Candle = [number, number, number, number, number, number];
type Chart = {
  pool: string;
  source: string;
  interval: string;
  currency: string;
  candles: Candle[];
  fetchedAt: number;
  checkedAt: number;
  status: "OK" | "STALE" | "UNAVAILABLE";
};
export function parseHsxCandles(payload: unknown, now = Date.now()): Candle[] {
  const p = payload as {
    meta?: { base?: { address?: string } };
    data?: { attributes?: { ohlcv_list?: unknown } };
  };
  if (p?.meta?.base?.address?.toLowerCase() !== HSX)
    throw Error("Unexpected chart base token");
  const rows = p.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw Error("Missing OHLCV data");
  const result = new Map<number, Candle>();
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 6 ||
      !row.every((v) => typeof v === "number" && Number.isFinite(v))
    )
      throw Error("Invalid candle");
    const [t, o, h, l, c, v] = row as Candle;
    if (
      !Number.isInteger(t) ||
      t <= 0 ||
      t > now / 1000 + 300 ||
      Math.min(o, h, l, c) <= 0 ||
      v < 0 ||
      h < Math.max(o, l, c) ||
      l > Math.min(o, h, c)
    )
      throw Error("Invalid OHLCV values");
    result.set(t, [t, o, h, l, c, v]);
  }
  return [...result.values()].sort((a, b) => a[0] - b[0]).slice(-168);
}

// Fixed public pool, shared cache, coalesced requests and bounded timeout.
// This display feed is NOT used for mint quotes or index settlement.
export function createHsxFeed(fetcher = fetch, clock = Date.now) {
  let cached: Chart | undefined;
  let pending: Promise<Chart> | undefined;
  let nextCheck = 0;
  return async function getChart(): Promise<Chart> {
    if (cached && clock() < nextCheck) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetcher(
          `https://api.geckoterminal.com/api/v2/networks/hyperevm/pools/${HSX_POOL}/ohlcv/hour?aggregate=1&limit=168&currency=usd&token=base&include_empty_intervals=false`,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!response.ok) throw Error(`Chart provider HTTP ${response.status}`);
        const candles = parseHsxCandles(await response.json(), clock());
        cached = {
          pool: HSX_POOL,
          source: "GeckoTerminal",
          interval: "1h",
          currency: "USD",
          candles,
          fetchedAt: clock(),
          checkedAt: clock(),
          status: "OK",
        };
      } catch {
        cached =
          cached && cached.fetchedAt > 0
            ? { ...cached, status: "STALE", checkedAt: clock() }
            : {
                pool: HSX_POOL,
                source: "GeckoTerminal",
                interval: "1h",
                currency: "USD",
                candles: [],
                fetchedAt: 0,
                checkedAt: clock(),
                status: "UNAVAILABLE",
              };
      }
      nextCheck = clock() + 30_000;
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
export const getHsxChart = createHsxFeed();

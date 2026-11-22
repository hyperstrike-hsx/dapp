import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { VenueObservation } from "@hyperstrike/index-core";
import { commitPayload, stringify } from "./store";

/**
 * Public CS2 marketplace adapters for methodology HS-MVA-1.
 *
 * Each venue publishes one bulk price list keyed by Steam market_hash_name, so
 * a whole basket costs one request per venue. All five quote USD and charge the
 * seller, so the lowest ask is the buyer's all-in price and is comparable
 * across venues. Venues that require a login, a per-item crawl, or that quote
 * non-cashable balances (Steam Community Market wallet funds) are excluded.
 */
export type VenueRow = {
  askE8: bigint;
  askCount: number;
  bidE8?: bigint;
  bidCount?: number;
  observedAtMs?: number;
  createdAt?: number;
  raw: unknown;
};
export type VenueSnapshot = {
  providerId: string;
  receivedAtMs: number;
  /** sha256 over every upstream response body, in request order. */
  bodySha256: `0x${string}`;
  rows: Map<string, VenueRow>;
};
type Fetch = typeof fetch;
type Venue = {
  id: string;
  label: string;
  site: string;
  /** names === null fetches the whole catalogue (basket construction only). */
  read(
    names: readonly string[] | null,
    request: Fetch,
    clock: () => number,
  ): Promise<VenueSnapshot>;
};

const E8 = 100_000_000n;
/** Exact decimal → E8 integer. Floats are formatted, never multiplied. */
export function usdE8(value: unknown): bigint {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? value.toFixed(8)
      : typeof value === "string"
        ? value.trim()
        : "";
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text);
  if (!m) return 0n;
  return BigInt(m[1]) * E8 + BigInt((m[2] ?? "").padEnd(8, "0").slice(0, 8));
}
const count = (v: unknown) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const coolDown = new Map<string, number>();
async function body(
  request: Fetch,
  url: string,
  init: RequestInit = {},
  retry429 = false,
) {
  const until = coolDown.get(new URL(url).host) ?? 0;
  if (until > Date.now())
    throw Error(
      `${new URL(url).host} rate-limited until ${new Date(until).toISOString()}`,
    );
  for (let attempt = 0; ; attempt++) {
    const response = await request(url, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
    });
    // Rate limits are transient: back off briefly, bounded so a five-minute cycle is never missed.
    // Only where the limit is a short burst window (DMarket). Skinport allows 8
    // requests per 5 minutes and every retry counts against it.
    if (retry429 && response.status === 429 && attempt < 3) {
      const wait = Number(response.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(r, Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1500 * 2 ** attempt, 8000)),
      );
      continue;
    }
    if (!response.ok) {
      // A venue that names its own cool-down is left alone until it has passed:
      // Skinport escalates to a ~50-minute block if requests continue.
      const wait = Number(response.headers.get("retry-after"));
      if (response.status === 429 && wait > 0)
        coolDown.set(new URL(url).host, Date.now() + wait * 1000);
      throw Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }
    const text = await response.text();
    if (text.length > 60_000_000) throw Error("Oversized venue response");
    return text;
  }
}
function snapshot(
  providerId: string,
  bodies: string[],
  rows: Map<string, VenueRow>,
  clock: () => number,
): VenueSnapshot {
  const hash = createHash("sha256");
  for (const b of bodies) hash.update(b).update("\n");
  if (!rows.size) throw Error(`${providerId}: no usable rows`);
  return {
    providerId,
    receivedAtMs: clock(),
    bodySha256: `0x${hash.digest("hex")}`,
    rows,
  };
}
const wanted = (names: readonly string[] | null) => {
  const set = names && new Set(names);
  return (name: unknown): name is string =>
    typeof name === "string" && (!set || set.has(name));
};
const list = (value: unknown, venue: string): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw Error(`${venue}: unexpected response shape`);
  return value;
};

export const VENUES: readonly Venue[] = [
  {
    id: "skinport",
    label: "Skinport",
    site: "https://skinport.com/",
    async read(names, request, clock) {
      // Brotli is mandatory for this endpoint; responses are cached 5 minutes upstream.
      const raw = await body(
        request,
        "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0",
        { headers: { "Accept-Encoding": "br" } },
      );
      const want = wanted(names);
      const rows = new Map<string, VenueRow>();
      for (const r of list(JSON.parse(raw), "skinport")) {
        // Versioned rows are Doppler phases: not fungible with the base name.
        if (!want(r.market_hash_name) || r.version != null || r.currency !== "USD")
          continue;
        const askE8 = usdE8(r.min_price),
          askCount = count(r.quantity);
        if (askE8 > 0n && askCount && Number.isSafeInteger(r.updated_at))
          rows.set(r.market_hash_name, {
            askE8,
            askCount,
            observedAtMs: (r.updated_at as number) * 1000,
            createdAt: Number.isSafeInteger(r.created_at)
              ? (r.created_at as number)
              : undefined,
            raw: r,
          });
      }
      return snapshot("skinport", [raw], rows, clock);
    },
  },
  {
    id: "marketcsgo",
    label: "Market.CSGO",
    site: "https://market.csgo.com/",
    async read(names, request, clock) {
      const [asks, bids] = await Promise.all([
        body(request, "https://market.csgo.com/api/v2/prices/USD.json"),
        body(request, "https://market.csgo.com/api/v2/prices/orders/USD.json"),
      ]);
      const a = JSON.parse(asks),
        b = JSON.parse(bids);
      if (a?.success !== true || a.currency !== "USD")
        throw Error("marketcsgo: unexpected response shape");
      const want = wanted(names);
      const orders = new Map<string, Record<string, unknown>>();
      if (b?.success === true && b.currency === "USD")
        for (const r of list(b.items, "marketcsgo"))
          if (want(r.market_hash_name)) orders.set(r.market_hash_name, r);
      const observedAtMs = Number.isSafeInteger(a.time) ? a.time * 1000 : undefined;
      const rows = new Map<string, VenueRow>();
      for (const r of list(a.items, "marketcsgo")) {
        if (!want(r.market_hash_name)) continue;
        const askE8 = usdE8(r.price),
          askCount = count(r.volume);
        if (!(askE8 > 0n && askCount)) continue;
        const o = orders.get(r.market_hash_name);
        rows.set(r.market_hash_name, {
          askE8,
          askCount,
          bidE8: o ? usdE8(o.price) || undefined : undefined,
          bidCount: o ? count(o.volume) || undefined : undefined,
          observedAtMs,
          raw: { ask: r, bid: o ?? null, time: a.time },
        });
      }
      return snapshot("marketcsgo", [asks, bids], rows, clock);
    },
  },
  {
    id: "dmarket",
    label: "DMarket",
    site: "https://dmarket.com/",
    async read(names, request, clock) {
      const url = "https://api.dmarket.com/marketplace-api/v1/aggregated-prices";
      const bodies: string[] = [];
      const rows = new Map<string, VenueRow>();
      const page = async (filter: object, cursor: string) => {
        const raw = await body(request, url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter, limit: "1000", cursor }),
        }, true);
        bodies.push(raw);
        const j = JSON.parse(raw);
        for (const r of list(j.aggregatedPrices, "dmarket")) {
          const offer = r.offerBestPrice as Record<string, unknown> | null,
            order = r.orderBestPrice as Record<string, unknown> | null;
          if (typeof r.title !== "string" || offer?.Currency !== "USD") continue;
          // Amounts are integer US cents.
          const cents = (p: Record<string, unknown> | null) =>
            p?.Currency === "USD" && typeof p.Amount === "string" && /^\d+$/.test(p.Amount)
              ? BigInt(p.Amount) * 1_000_000n
              : 0n;
          const askE8 = cents(offer),
            askCount = count(r.offerCount);
          if (askE8 > 0n && askCount)
            rows.set(r.title, {
              askE8,
              askCount,
              bidE8: cents(order) || undefined,
              bidCount: count(r.orderCount) || undefined,
              raw: r,
            });
        }
        return typeof j.nextCursor === "string" ? j.nextCursor : "";
      };
      if (names)
        for (let i = 0; i < names.length; i += 100)
          await page({ game: "a8db", titles: names.slice(i, i + 100) }, "");
      else {
        let cursor = "",
          guard = 0;
        do {
          cursor = await page({ game: "a8db" }, cursor);
          // Whole-catalogue reads are rare (basket construction); pace them.
          await new Promise((r) => setTimeout(r, 400));
        } while (cursor && ++guard < 200);
      }
      return snapshot("dmarket", bodies, rows, clock);
    },
  },
  {
    id: "waxpeer",
    label: "Waxpeer",
    site: "https://waxpeer.com/",
    async read(names, request, clock) {
      const raw = await body(
        request,
        "https://api.waxpeer.com/v1/prices?game=csgo&minified=0",
      );
      const j = JSON.parse(raw);
      if (j?.success !== true) throw Error("waxpeer: unexpected response shape");
      const want = wanted(names);
      const rows = new Map<string, VenueRow>();
      for (const r of list(j.items, "waxpeer")) {
        // `min` is an integer in thousandths of a US dollar.
        if (!want(r.name) || !Number.isSafeInteger(r.min) || (r.min as number) <= 0)
          continue;
        const askCount = count(r.count);
        if (askCount)
          rows.set(r.name, {
            askE8: BigInt(r.min as number) * 100_000n,
            askCount,
            raw: { name: r.name, min: r.min, count: r.count },
          });
      }
      return snapshot("waxpeer", [raw], rows, clock);
    },
  },
  {
    id: "lisskins",
    label: "LIS-SKINS",
    site: "https://lis-skins.com/",
    async read(names, request, clock) {
      const raw = await body(
        request,
        "https://lis-skins.com/market_export_json/csgo.json",
      );
      const want = wanted(names);
      const rows = new Map<string, VenueRow>();
      for (const r of list(JSON.parse(raw), "lisskins")) {
        if (!want(r.name)) continue;
        const askE8 = usdE8(r.price),
          askCount = count(r.count);
        if (askE8 > 0n && askCount)
          rows.set(r.name, {
            askE8,
            askCount,
            raw: { name: r.name, price: r.price, count: r.count },
          });
      }
      return snapshot("lisskins", [raw], rows, clock);
    },
  },
];
export const VENUE_IDS = VENUES.map((v) => v.id);

export type VenueFailure = { providerId: string; reason: string };
/** Reads every venue concurrently; one venue failing never blocks the others. */
export async function readVenues(
  names: readonly string[] | null,
  request: Fetch = fetch,
  venues: readonly Venue[] = VENUES,
  clock: () => number = Date.now,
) {
  // Operator switch for a misbehaving venue: HS_DISABLED_VENUES=waxpeer,lisskins
  const disabled = (process.env.HS_DISABLED_VENUES ?? "")
    .split(",")
    .map((v) => v.trim());
  const settled = await Promise.allSettled(
    venues.map((v) =>
      disabled.includes(v.id)
        ? Promise.reject(Error("disabled by operator"))
        : v.read(names, request, clock),
    ),
  );
  const snapshots: VenueSnapshot[] = [],
    failures: VenueFailure[] = [];
  settled.forEach((r, i) =>
    r.status === "fulfilled"
      ? snapshots.push(r.value)
      : failures.push({
          providerId: venues[i].id,
          reason: String(r.reason?.message ?? r.reason).slice(0, 200),
        }),
  );
  return { snapshots, failures };
}

/** One normalized quote per (venue, constituent). The constituent ID is the market_hash_name. */
export function toObservation(
  snapshot: VenueSnapshot,
  name: string,
  rawPayloadHash: `0x${string}`,
): VenueObservation | null {
  const row = snapshot.rows.get(name);
  if (!row) return null;
  return {
    constituentId: name,
    providerId: snapshot.providerId,
    // Venues without a server timestamp are stamped at receipt.
    observedAtMs: Math.min(
      row.observedAtMs ?? snapshot.receivedAtMs,
      snapshot.receivedAtMs,
    ),
    receivedAtMs: snapshot.receivedAtMs,
    askE8: row.askE8,
    askDepthUsdE8: row.askE8 * BigInt(row.askCount),
    bidE8: row.bidE8,
    bidDepthUsdE8:
      row.bidE8 && row.bidCount ? row.bidE8 * BigInt(row.bidCount) : undefined,
    sourceSequence: String(snapshot.receivedAtMs),
    rawPayloadHash,
  };
}

/**
 * The committed payload is the verbatim venue rows for the basket plus the
 * sha256 of the complete upstream body. Storing ~30 MB of full catalogues every
 * five minutes is not sustainable; the extract keeps every input replayable.
 */
export function extractPayload(snapshot: VenueSnapshot, names: readonly string[]) {
  return stringify({
    venue: snapshot.providerId,
    receivedAtMs: snapshot.receivedAtMs,
    bodySha256: snapshot.bodySha256,
    rows: [...names]
      .sort()
      .flatMap((n) => (snapshot.rows.has(n) ? [snapshot.rows.get(n)!.raw] : [])),
  });
}
export function commitSnapshot(
  db: DatabaseSync,
  snapshot: VenueSnapshot,
  names: readonly string[],
) {
  const hash = commitPayload(
    db,
    snapshot.providerId,
    extractPayload(snapshot, names),
    snapshot.receivedAtMs,
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO venue_observations(provider_id,constituent_id,source_sequence,observed_at,payload_hash,data) VALUES(?,?,?,?,?,?)",
  );
  const observations: VenueObservation[] = [];
  for (const name of names) {
    const q = toObservation(snapshot, name, hash);
    if (!q) continue;
    insert.run(
      q.providerId,
      q.constituentId,
      q.sourceSequence!,
      q.observedAtMs,
      hash,
      stringify(q),
    );
    observations.push(q);
  }
  return observations;
}

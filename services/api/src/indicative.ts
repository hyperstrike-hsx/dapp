import type { DatabaseSync } from "node:sqlite";
import {
  INDEXES,
  type IndicativeFeed,
  type IndicativeIndex,
} from "@hyperstrike/market-types";

export const SKINPORT_URL =
  "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=1";
const INTERVAL = 300_000;
const MAX_AGE = 900;
const VERSION = "skinport-ask-preview-v1";
export type Item = {
  market_hash_name: string;
  version?: string | null;
  currency: string;
  min_price: number;
  quantity: number;
  updated_at: number;
  created_at: number;
};
type Member = { name: string; baseUsd: number; weight: number };
type Basket = { baseAt: number; members: Member[] };
const weapon =
  /^(AK-47|M4A4|M4A1-S|AWP|Glock-18|USP-S|Desert Eagle|P250|Five-SeveN|Tec-9|P90|MP9|MP7|FAMAS|Galil AR|AUG|SG 553|SSG 08|MAC-10|UMP-45|Nova|XM1014|MAG-7|Sawed-Off|Negev|M249|G3SG1|SCAR-20|CZ75-Auto|R8 Revolver|Dual Berettas|PP-Bizon|MP5-SD) \|/;
const glove = /Gloves|Hand Wraps/;
export function validItems(raw: unknown, now: number): Item[] {
  if (!Array.isArray(raw)) throw Error("Invalid Skinport response");
  const counts = new Map<string, number>();
  const rows = raw.filter(
    (r): r is Item =>
      r &&
      typeof r.market_hash_name === "string" &&
      r.version == null &&
      r.currency === "USD" &&
      Number.isFinite(r.min_price) &&
      r.min_price > 0 &&
      Number.isSafeInteger(r.quantity) &&
      r.quantity > 0 &&
      Number.isSafeInteger(r.updated_at) &&
      r.updated_at <= now &&
      now - r.updated_at <= MAX_AGE,
  );
  rows.forEach((r) =>
    counts.set(r.market_hash_name, (counts.get(r.market_hash_name) ?? 0) + 1),
  );
  return rows.filter((r) => counts.get(r.market_hash_name) === 1);
}
export function selectBasket(
  ticker: string,
  items: Item[],
  now: number,
): Basket | null {
  // Membership is frozen at first successful initialization, never reranked each poll.
  const eligible = items.filter(
    (r) => r.quantity >= 5 && !/StatTrak|Souvenir/.test(r.market_hash_name),
  );
  const byLiquidity = (a: Item, b: Item) =>
    b.quantity - a.quantity ||
    (a.market_hash_name < b.market_hash_name ? -1 : 1);
  const knives = eligible
    .filter(
      (r) =>
        r.market_hash_name.startsWith("★") && !glove.test(r.market_hash_name),
    )
    .sort(byLiquidity);
  const gloves = eligible
    .filter((r) => glove.test(r.market_hash_name))
    .sort(byLiquidity);
  const weapons = eligible
    .filter((r) => weapon.test(r.market_hash_name))
    .sort(byLiquidity);
  const premium = weapons.filter((r) => r.min_price >= 250);
  const cases = eligible
    .filter(
      (r) =>
        / Case$/.test(r.market_hash_name) &&
        Number.isSafeInteger(r.created_at) &&
        now - r.created_at >= 90 * 86400,
    )
    .sort(byLiquidity);
  const groups: [Item[], number, number][] =
    ticker === "HS-CS50"
      ? [
          [knives, 15, 0.3],
          [gloves, 8, 0.15],
          [weapons.filter((r) => r.min_price < 250), 12, 0.25],
          [cases, 10, 0.2],
          [premium, 5, 0.1],
        ]
      : ticker === "HS-KNIFE20"
        ? [[knives, 20, 1]]
        : ticker === "HS-GLOVE10"
          ? [[gloves, 10, 1]]
          : ticker === "HS-BLUE20"
            ? [[premium, 20, 1]]
            : [[cases, 20, 1]];
  if (groups.some(([rows, count]) => rows.length < count)) return null;
  return {
    baseAt: now,
    members: groups.flatMap(([rows, count, weight]) =>
      rows
        .slice(0, count)
        .map((r) => ({
          name: r.market_hash_name,
          baseUsd: r.min_price,
          weight: weight / count,
        })),
    ),
  };
}
export function calculatePreview(basket: Basket, items: Item[]) {
  const lookup = new Map(items.map((r) => [r.market_hash_name, r]));
  const constituents = basket.members.map((m) => {
    const row = lookup.get(m.name);
    return {
      ...m,
      priceUsd: row?.min_price ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
  const coverage = constituents.filter((c) => c.priceUsd !== null).length;
  // No substitution or reweighting when a frozen constituent disappears.
  const value =
    coverage === constituents.length
      ? Math.round(
          1e9 *
            constituents.reduce(
              (s, c) => s + (c.weight * c.priceUsd!) / c.baseUsd,
              0,
            ),
        ) / 1e6
      : null;
  return {
    constituents,
    coverage,
    value,
    observedAt:
      value === null
        ? null
        : Math.min(...constituents.map((c) => c.updatedAt!)),
  };
}
export function createIndicativeFeed(
  db: DatabaseSync,
  request: typeof fetch = fetch,
  clock = Date.now,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS indicative_baskets(version TEXT,ticker TEXT,data TEXT,PRIMARY KEY(version,ticker));
    CREATE TABLE IF NOT EXISTS indicative_samples(version TEXT,ticker TEXT,observed_at INTEGER,data TEXT,PRIMARY KEY(version,ticker,observed_at));
    CREATE TABLE IF NOT EXISTS indicative_cache(id TEXT PRIMARY KEY,checked_at INTEGER,data TEXT);`);
  let pending: Promise<IndicativeFeed> | undefined;
  const result = (items: Item[], error?: string): IndicativeFeed => {
    const now = Math.floor(clock() / 1000);
    const indexes = INDEXES.map((index) => {
      let stored = db
        .prepare(
          "SELECT data FROM indicative_baskets WHERE version=? AND ticker=?",
        )
        .get(VERSION, index.ticker);
      if (!stored && !error) {
        const basket = selectBasket(index.ticker, items, now);
        if (basket) {
          db.prepare(
            "INSERT OR IGNORE INTO indicative_baskets VALUES(?,?,?)",
          ).run(VERSION, index.ticker, JSON.stringify(basket));
          stored = db
            .prepare(
              "SELECT data FROM indicative_baskets WHERE version=? AND ticker=?",
            )
            .get(VERSION, index.ticker);
        }
      }
      const basket: Basket | null = stored
        ? JSON.parse(String(stored.data))
        : null;
      const calculated = basket ? calculatePreview(basket, items) : null;
      if (
        calculated?.value !== null &&
        calculated?.value !== undefined &&
        !error
      ) {
        db.prepare(
          "INSERT OR IGNORE INTO indicative_samples VALUES(?,?,?,?)",
        ).run(
          VERSION,
          index.ticker,
          calculated.observedAt!,
          JSON.stringify({
            value: calculated.value,
            observedAt: calculated.observedAt,
          }),
        );
      }
      const history = db
        .prepare(
          "SELECT data FROM indicative_samples WHERE version=? AND ticker=? ORDER BY observed_at DESC LIMIT 288",
        )
        .all(VERSION, index.ticker)
        .map((r) => JSON.parse(String(r.data)))
        .reverse();
      const last = history.at(-1);
      const fresh = calculated?.value != null && !error;
      const value = fresh ? calculated.value : (last?.value ?? null);
      return {
        ticker: index.ticker,
        indexId: index.indexId,
        provenance: "INDICATIVE",
        settlementEligible: false,
        status: fresh ? "OK" : last ? "STALE" : "UNAVAILABLE",
        value,
        changeSinceBasePct: value === null ? null : (value / 1000 - 1) * 100,
        baseAt: basket?.baseAt ?? null,
        observedAt: fresh ? calculated.observedAt : (last?.observedAt ?? null),
        coverage: calculated?.coverage ?? 0,
        count: index.count,
        constituents: calculated?.constituents ?? [],
        history,
      } satisfies IndicativeIndex;
    });
    return {
      source: "Skinport",
      sourceUrl: "https://skinport.com/",
      currency: "USD",
      methodology: VERSION,
      checkedAt: now,
      error,
      indexes,
    };
  };
  return async (): Promise<IndicativeFeed> => {
    if (pending) return pending;
    const cached = db
      .prepare("SELECT * FROM indicative_cache WHERE id=?")
      .get(VERSION);
    if (cached && clock() - Number(cached.checked_at) < INTERVAL) {
      const feed = JSON.parse(String(cached.data)) as IndicativeFeed;
      feed.indexes = feed.indexes.map((i) =>
        i.status === "OK" &&
        (i.observedAt === null || clock() / 1000 - i.observedAt > MAX_AGE)
          ? { ...i, status: "STALE" }
          : i,
      );
      return feed;
    }
    pending = (async () => {
      let next: IndicativeFeed;
      try {
        if (process.env.HS_INDICATIVE_ENABLED === "false")
          throw Error("Indicative feed disabled");
        const response = await request(SKINPORT_URL, {
          headers: { Accept: "application/json", "Accept-Encoding": "br" },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!response.ok) throw Error(`Skinport HTTP ${response.status}`);
        const raw = await response.text();
        if (raw.length > 30_000_000) throw Error("Oversized Skinport response");
        const items = validItems(JSON.parse(raw), Math.floor(clock() / 1000));
        if (!items.length)
          throw Error("Skinport returned no fresh USD listings");
        next = result(items);
      } catch {
        next = result(
          [],
          "Skinport unavailable or data stale. Last valid values, if any, are not current quotes.",
        );
      }
      db.prepare(
        "INSERT INTO indicative_cache VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,data=excluded.data",
      ).run(VERSION, clock(), JSON.stringify(next));
      return next;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

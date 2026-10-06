import { DatabaseSync } from "node:sqlite";
import { INDEXES, type IndicativeFeed } from "@hyperstrike/market-types";
import { createIndicativeFeed } from "./indicative";
export const SNAPSHOT_VERSION = "skinport-ask-preview-v1";

// Only public basket/price data is restored. Never copy the operational database.
export function restoreSnapshot(db: DatabaseSync, snapshot: IndicativeFeed) {
  if (
    snapshot.methodology !== SNAPSHOT_VERSION ||
    snapshot.source !== "Skinport" ||
    snapshot.currency !== "USD" ||
    snapshot.indexes.length !== INDEXES.length
  )
    throw Error("Invalid snapshot methodology");
  for (const definition of INDEXES) {
    const matches = snapshot.indexes.filter(
      (i) => i.indexId === definition.indexId && i.ticker === definition.ticker,
    );
    if (matches.length !== 1) throw Error("Missing or duplicate index");
    const i = matches[0];
    if (
      i.provenance !== "INDICATIVE" ||
      i.settlementEligible !== false ||
      i.count !== definition.count
    )
      throw Error("Invalid preview provenance");
    if (
      i.baseAt === null &&
      i.constituents.length === 0 &&
      i.history.length === 0 &&
      i.value === null
    )
      continue;
    if (
      !Number.isSafeInteger(i.baseAt) ||
      i.baseAt! <= 0 ||
      i.constituents.length !== definition.count ||
      new Set(i.constituents.map((c) => c.name)).size !== definition.count ||
      i.constituents.some(
        (c) =>
          !c.name ||
          !Number.isFinite(c.baseUsd) ||
          c.baseUsd <= 0 ||
          !Number.isFinite(c.weight) ||
          c.weight <= 0,
      ) ||
      Math.abs(i.constituents.reduce((s, c) => s + c.weight, 0) - 1) > 1e-9
    )
      throw Error("Invalid frozen basket; refusing to reset baseline");
    if (
      !Array.isArray(i.history) ||
      i.history.some(
        (p) =>
          !Number.isFinite(p.value) ||
          p.value <= 0 ||
          !Number.isSafeInteger(p.observedAt) ||
          p.observedAt <= 0,
      )
    )
      throw Error("Invalid snapshot history");
    db.prepare("INSERT INTO indicative_baskets VALUES(?,?,?)").run(
      SNAPSHOT_VERSION,
      i.ticker,
      JSON.stringify({
        baseAt: i.baseAt,
        members: i.constituents.map((c) => ({
          name: c.name,
          baseUsd: c.baseUsd,
          weight: c.weight,
        })),
      }),
    );
    for (const point of i.history.slice(-288))
      db.prepare(
        "INSERT OR REPLACE INTO indicative_samples VALUES(?,?,?,?)",
      ).run(
        SNAPSHOT_VERSION,
        i.ticker,
        point.observedAt,
        JSON.stringify(point),
      );
  }
}
export async function refreshSnapshot(
  previous: IndicativeFeed | undefined,
  request: typeof fetch = fetch,
  clock = Date.now,
) {
  const db = new DatabaseSync(":memory:");
  try {
    const get = createIndicativeFeed(db, request, clock);
    if (previous) restoreSnapshot(db, previous);
    const next = await get();
    if (next.error || !next.indexes.some((i) => i.status === "OK"))
      throw Error(
        "No fresh index observations; preserving the published snapshot",
      );
    return next;
  } finally {
    db.close();
  }
}

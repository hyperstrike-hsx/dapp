import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { IndicativeFeed } from "@hyperstrike/market-types";
import {
  refreshSnapshot,
  SNAPSHOT_VERSION,
} from "../services/api/src/static-snapshot";
import { createHsxFeed } from "../services/api/src/hsx-chart";

const directory = fileURLToPath(
  new URL("../apps/web/public/data/", import.meta.url),
);
async function readJson(name: string) {
  try {
    return JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function publish(name: string, value: unknown) {
  const path = `${directory}/${name}`;
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
let previous: IndicativeFeed | undefined = await readJson(
  "indicative-indexes.json",
);
const args = process.argv.slice(2);
if (args.length) {
  if (args.length !== 2 || args[0] !== "--bootstrap-db" || previous)
    throw Error(
      "Usage: publish-snapshots [--bootstrap-db PATH] (bootstrap only before a snapshot exists)",
    );
  const db = new DatabaseSync(args[1], { readOnly: true });
  try {
    const cached = db
      .prepare("SELECT data FROM indicative_cache WHERE id=?")
      .get(SNAPSHOT_VERSION);
    if (!cached) throw Error("No existing indicative baseline to migrate");
    previous = JSON.parse(String(cached.data));
  } finally {
    db.close();
  }
}
const indexes = await refreshSnapshot(previous);
const chart = await createHsxFeed()();
const oldChart = await readJson("hsx-ohlcv.json");
await mkdir(directory, { recursive: true });
await publish("indicative-indexes.json", indexes);
// A failed chart fetch must not erase existing valid candles or their timestamp.
if (chart.status === "OK" || !oldChart) await publish("hsx-ohlcv.json", chart);
if (chart.status !== "OK")
  console.warn(
    "HSX chart provider unavailable; preserved last snapshot where available.",
  );
console.log(
  JSON.stringify(
    {
      publishedAt: indexes.checkedAt,
      indexes: indexes.indexes.map((i) => ({
        ticker: i.ticker,
        status: i.status,
        baseAt: i.baseAt,
        value: i.value,
      })),
      chart: chart.status,
    },
    null,
    2,
  ),
);

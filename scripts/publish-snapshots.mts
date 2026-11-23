import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IndicativeFeed } from "@hyperstrike/market-types";
import { refreshComposite } from "../services/api/src/composite-feed";
import { loadGenesis } from "../services/api/src/oracle-engine";
import {
  METHODOLOGY,
  BASE_DAY,
  freezeStage,
} from "../services/api/src/genesis";
import { buildGenesis, writeGenesis } from "../services/api/src/genesis-build";
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
const previous: IndicativeFeed | undefined = await readJson(
  "indicative-indexes.json",
);
// The single-venue Skinport preview is retired, not rewritten: its last
// published state is kept beside the multi-venue feed that replaces it.
if (previous && previous.methodology !== METHODOLOGY)
  await publish("indicative-indexes.skinport-preview-v1.json", previous);
// The official baskets are frozen by the first --freeze run of the base day
// (the scheduled job passes it; a run on someone's machine does not). The
// preview they replace is kept beside the feed and stays on the chart as
// earlier history.
const stage = freezeStage(loadGenesis().generatedAt, Date.now() / 1000);
if (stage === "OFFICIAL" && process.argv.includes("--freeze"))
  try {
    await writeGenesis(await buildGenesis());
    if (previous)
      await publish("indicative-indexes.preview-hs-mva-1.json", previous);
    console.log(`Official baskets frozen on the base day, ${BASE_DAY} UTC.`);
  } catch (error) {
    // The preview keeps publishing; the next run of the day tries again.
    console.warn(
      `::warning::Official basket freeze failed: ${(error as Error).message}`,
    );
  }
if (stage === "MISSED")
  console.warn(
    `::warning::The official base day (${BASE_DAY} UTC) passed without a freeze; still publishing the preview. Choose a new day in INDEX_BASE_AT.`,
  );
const indexes = await refreshComposite(previous, loadGenesis());
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

import { writeFile, access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readVenues, VENUE_IDS } from "../services/api/src/venues";
import {
  buildCandidates,
  parseSalesTape,
  selectGenesis,
  METHODOLOGY,
  METHODOLOGY_HASH,
  RULES,
  type GenesisConfig,
} from "../services/api/src/genesis";

// Builds the genesis baskets from live five-venue data. The output is the
// composition committed on chain at deployment, so it is never overwritten
// silently: pass --force only before anything has been deployed against it.
const target = fileURLToPath(
  new URL("../config/index-genesis.json", import.meta.url),
);
const force = process.argv.includes("--force");
if (!force)
  try {
    await access(target);
    throw Error(
      `${target} already exists. It is the committed genesis composition; use --force only before deployment.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
const [{ snapshots, failures }, tape] = await Promise.all([
  readVenues(null),
  fetch("https://api.skinport.com/v1/sales/history?app_id=730&currency=USD", {
    headers: { Accept: "application/json", "Accept-Encoding": "br" },
    signal: AbortSignal.timeout(25_000),
  }).then(async (r) => {
    if (!r.ok) throw Error(`Skinport sales history HTTP ${r.status}`);
    return parseSalesTape(await r.json());
  }),
]);
if (failures.length)
  throw Error(
    `Genesis needs every venue; failed: ${failures.map((f) => `${f.providerId} (${f.reason})`).join(", ")}`,
  );
const now = Date.now();
const { candidates, excluded } = buildCandidates(snapshots, tape, now);
const approvedAt = Math.floor(now / 1000);
const config: GenesisConfig = {
  methodology: METHODOLOGY,
  methodologyHash: METHODOLOGY_HASH,
  generatedAt: approvedAt,
  venues: VENUE_IDS,
  rules: RULES,
  baskets: selectGenesis(candidates, approvedAt),
};
await mkdir(fileURLToPath(new URL("../config/", import.meta.url)), {
  recursive: true,
});
await writeFile(target, JSON.stringify(config, null, 2) + "\n");
// Near-miss candidates and the gate each one failed, published beside the baskets.
await writeFile(
  target.replace(/\.json$/, ".exclusions.json"),
  JSON.stringify({ generatedAt: approvedAt, excluded }) + "\n",
);
console.log(
  `Genesis written: ${candidates.length} eligible candidates, ${excluded.length} near-miss exclusions recorded.`,
);
for (const b of config.baskets)
  console.log(
    `${b.ticker.padEnd(11)} ${b.constituents.length} constituents  root ${b.compositionRoot}`,
  );

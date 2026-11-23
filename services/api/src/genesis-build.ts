import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readVenues, VENUE_IDS } from "./venues";
import { GENESIS_PATH } from "./oracle-engine";
import {
  buildCandidates,
  parseSalesTape,
  selectGenesis,
  METHODOLOGY,
  METHODOLOGY_HASH,
  RULES,
  type GenesisConfig,
} from "./genesis";

/** When the committed composition was built, or null if there is none. */
export async function committedAt(target = GENESIS_PATH) {
  try {
    await access(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return (JSON.parse(await readFile(target, "utf8")) as GenesisConfig)
    .generatedAt;
}
/** Reads the five venues and Skinport's sales tape once and selects the baskets as of now. */
export async function buildGenesis(
  request: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  const [{ snapshots, failures }, tape] = await Promise.all([
    readVenues(null, request, undefined, clock),
    request("https://api.skinport.com/v1/sales/history?app_id=730&currency=USD", {
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
  const now = clock();
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
  return { config, excluded, eligible: candidates.length };
}
export async function writeGenesis(
  { config, excluded }: Awaited<ReturnType<typeof buildGenesis>>,
  target = GENESIS_PATH,
) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(config, null, 2) + "\n");
  // Near-miss candidates and the gate each one failed, published beside the baskets.
  await writeFile(
    target.replace(/\.json$/, ".exclusions.json"),
    JSON.stringify({ generatedAt: config.generatedAt, excluded }) + "\n",
  );
}

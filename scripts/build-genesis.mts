import { freezeStage, BASE_DAY } from "../services/api/src/genesis";
import { GENESIS_PATH } from "../services/api/src/oracle-engine";
import {
  buildGenesis,
  committedAt,
  writeGenesis,
} from "../services/api/src/genesis-build";

// Builds the baskets from live five-venue data. Until the official base day
// the result is a preview and may be rebuilt with --force. On the base day it
// is the composition committed on chain at deployment, and is never rebuilt.
const existing = await committedAt();
const stage = freezeStage(existing, Date.now() / 1000);
if (stage === "FROZEN")
  throw Error(
    `${GENESIS_PATH} holds the official baskets frozen on ${new Date(existing! * 1000).toISOString()}. Later compositions go through IndexRegistry.schedule.`,
  );
if (stage === "MISSED")
  throw Error(
    `The official base day (${BASE_DAY} UTC) passed without a freeze. Choose a new day in INDEX_BASE_AT before building; a late build would not be the base that was announced.`,
  );
if (stage === "PREVIEW" && existing !== null && !process.argv.includes("--force"))
  throw Error(
    `${GENESIS_PATH} already exists. Pass --force to rebuild the preview baskets; the official ones are frozen on ${BASE_DAY} UTC.`,
  );
const built = await buildGenesis();
await writeGenesis(built);
console.log(
  `${stage === "OFFICIAL" ? "Official baskets frozen" : `Preview baskets written (official freeze on ${BASE_DAY} UTC)`}: ${built.eligible} eligible candidates, ${built.excluded.length} near-miss exclusions recorded.`,
);
for (const b of built.config.baskets)
  console.log(
    `${b.ticker.padEnd(11)} ${b.constituents.length} constituents  root ${b.compositionRoot}`,
  );

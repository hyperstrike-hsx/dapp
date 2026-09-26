import { openStore, stringify } from "./store";
import { replay, type ReplayInput } from "./pipeline";
import { INDEXES } from "@hyperstrike/market-types";
const args = process.argv.slice(2);
const param = (key: string) => args[args.indexOf(key) + 1];
const index = INDEXES.find((i) => i.ticker === param("--index"));
const timestamp = Date.parse(param("--timestamp")) / 1000;
if (!index || !Number.isFinite(timestamp))
  throw new Error(
    "Usage: pnpm replay-index --index HS-KNIFE20 --timestamp ISO_UTC",
  );
const db = openStore();
const record = db
  .prepare(
    "SELECT input,output FROM replay_records WHERE index_id=? AND observed_at=?",
  )
  .get(index.indexId, timestamp);
if (!record) throw new Error("No committed calculation at requested timestamp");
const actual = stringify(
  replay(JSON.parse(String(record.input)) as ReplayInput),
);
if (actual !== record.output)
  throw new Error("REPLAY MISMATCH: refuse to sign");
console.log(actual);
db.close();

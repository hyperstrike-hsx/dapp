import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("../apps/web/dist/", import.meta.url);
const files = await readdir(new URL("assets/", root));
for (const file of files.filter((f) => f.endsWith(".js"))) {
  const source = await readFile(new URL(`assets/${file}`, root), "utf8");
  assert(
    !/\/v1\/(indicative|indexes|oracle|markets|strike|hsx)/.test(source),
    `Runtime API reference in static bundle: ${file}`,
  );
}
const indexes = JSON.parse(
  await readFile(new URL("data/indicative-indexes.json", root), "utf8"),
);
assert.equal(indexes.indexes.length, 5);
assert(
  indexes.indexes.every(
    (i) => i.provenance === "INDICATIVE" && i.settlementEligible === false,
  ),
);
const chart = JSON.parse(
  await readFile(new URL("data/hsx-ohlcv.json", root), "utf8"),
);
assert.equal(chart.pool, "0xa92ab5ed3041025b844233b109216c6c3c0bc63c");
console.log(
  "Static release verified: five indicative indexes, HSX snapshot, no runtime /v1 references.",
);

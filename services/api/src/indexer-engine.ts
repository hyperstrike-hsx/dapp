import { readFile } from "node:fs/promises";
import { INDEXES } from "@hyperstrike/market-types";
import { eligibilityScore, WAD } from "@hyperstrike/index-core";
import { pollProvider, type HttpProviderConfig } from "./provider";
import { openStore, audit, stringify } from "./store";
import {
  commitCalculation,
  compositionRoot,
  type ReplayInput,
} from "./pipeline";
type Basket = {
  indexId: string;
  versionId: string;
  divisorE8: string;
  approvedAt: number;
  activatesAt: number;
  constituents: {
    constituentId: string;
    weightE18: string;
    basePriceE8: string;
    family: string;
    finish: string;
    sleeve: string;
    eligibility: Parameters<typeof eligibilityScore>[0];
    mappings: { providerId: string; instrument: string }[];
  }[];
};
export function validateBasket(b: Basket, providers: HttpProviderConfig[]) {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(b.versionId) ||
    !Number.isSafeInteger(b.approvedAt) ||
    !Number.isSafeInteger(b.activatesAt) ||
    b.approvedAt < 0
  )
    throw Error("Invalid version/announcement metadata");
  const index = INDEXES.find((i) => i.indexId === b.indexId);
  if (!index || index.count !== b.constituents.length)
    throw Error("Wrong canonical basket size");
  if (
    BigInt(b.divisorE8) <= 0n ||
    b.constituents.reduce((s, c) => s + BigInt(c.weightE18), 0n) !== WAD
  )
    throw Error("Invalid divisor/weights");
  if (
    new Set(b.constituents.map((c) => c.constituentId)).size !==
    b.constituents.length
  )
    throw Error("Duplicate constituent");
  if (b.approvedAt > b.activatesAt - 7 * 86400)
    throw Error("Composition needs seven-day announcement");
  for (const c of b.constituents) {
    if (BigInt(c.basePriceE8) <= 0n || BigInt(c.weightE18) <= 0n)
      throw Error("Nonpositive basket input");
    if (
      !eligibilityScore(
        c.eligibility,
        1500,
        index.ticker === "HS-CASE20" ? 90 : 0,
      ).eligible
    )
      throw Error(`Ineligible constituent ${c.constituentId}`);
    if (
      new Set(c.mappings.map((m) => m.providerId)).size < 2 ||
      c.mappings.some((m) => !providers.some((p) => p.id === m.providerId))
    )
      throw Error("Two independent configured providers required");
    if (
      index.ticker !== "HS-CS50" &&
      BigInt(c.weightE18) !== WAD / BigInt(index.count)
    )
      throw Error("Equal weighting required");
  }
  if (index.ticker === "HS-KNIFE20" || index.ticker === "HS-GLOVE10") {
    for (const c of b.constituents)
      if (b.constituents.filter((i) => i.family === c.family).length > 2)
        throw Error("Family concentration");
  }
  if (index.ticker === "HS-KNIFE20")
    for (const c of b.constituents)
      if (
        b.constituents
          .filter((i) => i.finish === c.finish)
          .reduce((s, i) => s + BigInt(i.weightE18), 0n) >
        WAD / 4n
      )
        throw Error("Finish concentration");
  if (index.ticker === "HS-CS50") {
    const sleeves = {
      knives: 30n,
      gloves: 15n,
      weapons: 25n,
      cases: 20n,
      premium: 10n,
    };
    for (const [name, weight] of Object.entries(sleeves)) {
      const members = b.constituents.filter((c) => c.sleeve === name);
      if (
        !members.length ||
        members.reduce((s, c) => s + BigInt(c.weightE18), 0n) !==
          (WAD * weight) / 100n
      )
        throw Error("Sleeve allocation");
      const first = BigInt(members[0].weightE18);
      if (members.some((c) => BigInt(c.weightE18) !== first))
        throw Error("Equal weights within sleeves required");
    }
  }
}
export async function runEngine(configFile: string) {
  const config = JSON.parse(await readFile(configFile, "utf8")) as {
    providers: HttpProviderConfig[];
    baskets: Basket[];
  };
  if (
    config.providers.length < 2 ||
    new Set(config.providers.map((p) => p.id)).size !==
      config.providers.length ||
    new Set(config.providers.map((p) => new URL(p.origin).hostname)).size < 2
  )
    throw Error("Independent provider origins required");
  if (
    config.baskets.length !== 5 ||
    new Set(config.baskets.map((b) => b.indexId)).size !== 5
  )
    throw Error("Configure all five canonical baskets exactly once");
  const db = openStore();
  try {
    for (const b of config.baskets) {
      validateBasket(b, config.providers);
      const now = Math.floor(Date.now() / 1000);
      const versionData = stringify({
        ...b,
        methodologyVersion: "HRP-1",
        provenance: "COMMITTEE_CONFIG",
        announcementTime: b.approvedAt,
        inclusionDecisions: b.constituents.map((c) => ({
          constituentId: c.constituentId,
          ...eligibilityScore(
            c.eligibility,
            1500,
            INDEXES.find((i) => i.indexId === b.indexId)!.ticker === "HS-CASE20"
              ? 90
              : 0,
          ),
        })),
      });
      const existing = db
        .prepare("SELECT data FROM index_versions WHERE version_id=?")
        .get(b.versionId);
      if (existing && existing.data !== versionData)
        throw Error("Published composition cannot be rewritten");
      db.prepare("INSERT OR IGNORE INTO index_versions VALUES(?,?,?,?)").run(
        b.indexId,
        b.versionId,
        b.activatesAt,
        versionData,
      );
      if (now < b.activatesAt) continue;
      const jobs = b.constituents.flatMap((c) =>
        c.mappings.map(
          (m) => () =>
            pollProvider(
              db,
              config.providers.find((p) => p.id === m.providerId)!,
              c.constituentId,
              m.instrument,
            ),
        ),
      );
      for (let offset = 0; offset < jobs.length; offset += 4) {
        const results = await Promise.allSettled(
          jobs.slice(offset, offset + 4).map((run) => run()),
        );
        for (const r of results)
          if (r.status === "rejected")
            audit(db, "PROVIDER_FAILURE", { reason: String(r.reason) });
      }
      const observedAt = Math.floor(Date.now() / 1000 / 60) * 60;
      const basket = b.constituents.map((c) => ({
        constituentId: c.constituentId,
        weightE18: c.weightE18,
        basePriceE8: c.basePriceE8,
        observations: c.mappings.flatMap((m) => {
          const row = db
            .prepare(
              "SELECT data FROM venue_observations WHERE constituent_id=? AND provider_id=? AND observed_at<=? ORDER BY observed_at DESC LIMIT 1",
            )
            .get(c.constituentId, m.providerId, observedAt * 1000);
          return row ? [JSON.parse(String(row.data))] : [];
        }),
      }));
      if (
        db
          .prepare(
            "SELECT 1 FROM replay_records WHERE index_id=? AND observed_at=?",
          )
          .get(b.indexId, observedAt)
      )
        continue;
      const result = commitCalculation(db, {
        indexId: b.indexId,
        observedAt,
        divisorE8: b.divisorE8,
        basket,
      } satisfies ReplayInput);
      const i = result.output.index;
      if (
        observedAt % 300 === 0 &&
        i.valueE8 !== null &&
        i.status !== "UNSAFE"
      ) {
        const previous = db
          .prepare(
            "SELECT MAX(sequence) AS sequence FROM index_observations WHERE index_id=?",
          )
          .get(b.indexId);
        const constituentRoot = compositionRoot({
          indexId: b.indexId,
          divisorE8: b.divisorE8,
          basket,
        });
        console.log(
          stringify({
            indexId: b.indexId,
            versionId: b.versionId,
            observedAt,
            valueE8: i.valueE8,
            confidenceBps: i.confidenceBps,
            constituentRoot,
            sourceDataRoot: result.hash,
            sequence: BigInt(Number(previous?.sequence ?? 0)) + 1n,
          }),
        );
      }
      audit(db, "INDEX_CALCULATED", {
        indexId: b.indexId,
        observedAt,
        status: i.status,
        confidenceBps: i.confidenceBps,
      });
    }
  } finally {
    db.close();
  }
}
if (process.argv[1]?.endsWith("indexer-engine.ts")) {
  if (!process.argv[2])
    throw Error("Supply an approved provider/basket JSON configuration");
  await runEngine(process.argv[2]);
}

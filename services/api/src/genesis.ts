import { id } from "ethers";
import { INDEXES, INDEX_BASE_AT } from "@hyperstrike/market-types";
import {
  referencePrice,
  eligibilityScore,
  ASK_REFERENCE_POLICY,
  WAD,
  type ReferencePrice,
} from "@hyperstrike/index-core";
import { toObservation, type VenueSnapshot } from "./venues";
import { compositionRoot } from "./pipeline";
import { validateBasket, type Basket } from "./indexer-engine";

/**
 * Genesis basket construction for methodology HS-MVA-1.
 * Deterministic: the same venue snapshots and sales tape always produce the
 * same baskets. Nothing here is hand-picked.
 */
export const METHODOLOGY = "HS-MVA-1";
export const METHODOLOGY_HASH = id(
  "HS-MVA-1|venue-relative-ask|min3venues|cap40|outlier12.5pct-or-7.413MAD|maxAge600s|fresh300s|divisor1000",
);
export const RULES = {
  minVenues: 5,
  maxDispersionBps: 1250,
  maxSpreadBps: 1500,
  minAgeDays: 30,
  caseSeasoningDays: 90,
  minMonthlySales: { knife: 8, glove: 8, premium: 5, weapon: 150, case: 80 },
  weaponSleeveUsd: [5, 100],
  premiumMinUsd: 100,
  // Below $1 a one-cent tick moves a case by more than 1%.
  caseMinUsd: 1,
} as const;
/**
 * What may be built at `now` (seconds), given when the committed composition
 * was built (null: there is none). The baskets are frozen once, on the official
 * base day: before it every build is a preview, after it nothing is rebuilt,
 * and a base day that passed without a freeze needs a new date, not a late one.
 */
export const BASE_DAY = new Date(INDEX_BASE_AT * 1000).toISOString().slice(0, 10);
export function freezeStage(committedAt: number | null, now: number) {
  if (committedAt !== null && committedAt >= INDEX_BASE_AT) return "FROZEN";
  if (now < INDEX_BASE_AT) return "PREVIEW";
  return now < INDEX_BASE_AT + 86_400 ? "OFFICIAL" : "MISSED";
}
export type Category = "knife" | "glove" | "weapon" | "premium" | "case";
const WEAPON =
  /^(AK-47|M4A4|M4A1-S|AWP|Glock-18|USP-S|Desert Eagle|P250|Five-SeveN|Tec-9|P90|MP9|MP7|FAMAS|Galil AR|AUG|SG 553|SSG 08|MAC-10|UMP-45|Nova|XM1014|MAG-7|Sawed-Off|Negev|M249|G3SG1|SCAR-20|CZ75-Auto|R8 Revolver|Dual Berettas|PP-Bizon|MP5-SD|P2000|Zeus x27) \| /;
const GLOVE = /Gloves|Hand Wraps/;
export function classify(name: string) {
  // StatTrak/Souvenir are thin variants; Doppler names bundle non-fungible phases.
  if (/StatTrak|Souvenir|Doppler/.test(name)) return null;
  if (/(^| )Case( [23])?$/.test(name))
    return { kind: "case" as const, family: name, finish: name };
  const m = /^(★ )?([^|]+?)(?: \| (.+?))?(?: \(([^)]+)\))?$/.exec(name);
  if (!m) return null;
  const [, star, family, finish] = m;
  if (star)
    return {
      kind: GLOVE.test(family) ? ("glove" as const) : ("knife" as const),
      family,
      finish: finish ?? "Vanilla",
    };
  if (WEAPON.test(name) && finish)
    return { kind: "weapon" as const, family, finish };
  return null;
}
export type SalesTape = Map<string, { units30d: number; medianUsd: number }>;
export function parseSalesTape(raw: unknown): SalesTape {
  if (!Array.isArray(raw)) throw Error("Invalid Skinport sales history");
  const tape: SalesTape = new Map();
  for (const r of raw) {
    const d = r?.last_30_days;
    if (
      typeof r?.market_hash_name === "string" &&
      r.version == null &&
      r.currency === "USD" &&
      Number.isSafeInteger(d?.volume) &&
      d.volume > 0 &&
      Number.isFinite(d.median) &&
      d.median > 0
    )
      tape.set(r.market_hash_name, { units30d: d.volume, medianUsd: d.median });
  }
  return tape;
}
export type Candidate = {
  name: string;
  category: Category;
  family: string;
  finish: string;
  reference: Extract<ReferencePrice, { status: "AVAILABLE" }>;
  venues: string[];
  /** Each venue's own ask at approval: the base its later quotes are measured against. */
  venueAskE8: Record<string, string>;
  dispersionBps: number;
  spreadBps: number;
  ageDays: number;
  units30d: number;
  volume30dUsd: number;
};
export type Exclusion = { name: string; reasons: string[] };

export function buildCandidates(
  snapshots: readonly VenueSnapshot[],
  tape: SalesTape,
  nowMs: number,
) {
  const names = new Set<string>();
  for (const s of snapshots) for (const n of s.rows.keys()) names.add(n);
  const skinport = snapshots.find((s) => s.providerId === "skinport");
  const candidates: Candidate[] = [],
    excluded: Exclusion[] = [];
  for (const name of [...names].sort()) {
    const c = classify(name);
    if (!c) continue;
    const quotes = snapshots.flatMap((s) => {
      const q = toObservation(s, name, "0x");
      return q ? [q] : [];
    });
    const reference = referencePrice(name, quotes, nowMs, ASK_REFERENCE_POLICY);
    const sale = tape.get(name);
    const created = skinport?.rows.get(name)?.createdAt;
    const ageDays = created ? Math.floor((nowMs / 1000 - created) / 86400) : 0;
    if (reference.status !== "AVAILABLE") {
      if (quotes.length >= 3)
        excluded.push({ name, reasons: ["NO_REFERENCE_PRICE"] });
      continue;
    }
    const usd = Number(reference.valueE8) / 1e8;
    const category: Category =
      c.kind === "weapon"
        ? usd >= RULES.premiumMinUsd
          ? "premium"
          : "weapon"
        : c.kind;
    const asks = quotes.map((q) => Number(q.askE8) / 1e8);
    const mid = [...asks].sort((a, b) => a - b)[asks.length >> 1];
    const dispersionBps = Math.round(
      Math.max(...asks.map((a) => Math.abs(a - mid) / mid)) * 10_000,
    );
    const spreads = quotes
      .filter((q) => q.bidE8 && q.bidE8 < q.askE8!)
      .map((q) => Number(((q.askE8! - q.bidE8!) * 10_000n) / q.askE8!));
    const reasons = [
      quotes.length < RULES.minVenues && "VENUE_COVERAGE",
      reference.rejected.length > 0 && "REJECTED_QUOTES",
      dispersionBps > RULES.maxDispersionBps && "CROSS_VENUE_DISPERSION",
      ageDays <
        (category === "case" ? RULES.caseSeasoningDays : RULES.minAgeDays) &&
        "SEASONING",
      (sale?.units30d ?? 0) < RULES.minMonthlySales[category] && "SALES_VOLUME",
      category === "weapon" &&
        (usd < RULES.weaponSleeveUsd[0] || usd >= RULES.weaponSleeveUsd[1]) &&
        "PRICE_BAND",
      category === "case" && usd < RULES.caseMinUsd && "TICK_SIZE",
      // A resting bid within 15% of the ask on at least one venue.
      !(Math.min(...spreads, Infinity) <= RULES.maxSpreadBps) && "BID_SUPPORT",
    ].filter(Boolean) as string[];
    if (reasons.length) {
      // Publish only near-misses; the full catalogue is tens of thousands of names.
      if (quotes.length >= RULES.minVenues && sale) excluded.push({ name, reasons });
      continue;
    }
    candidates.push({
      name,
      category,
      family: c.family,
      finish: c.finish,
      reference,
      venues: quotes.map((q) => q.providerId).sort(),
      venueAskE8: Object.fromEntries(
        quotes.map((q) => [q.providerId, String(q.askE8)]),
      ),
      dispersionBps,
      spreadBps: Math.min(...spreads),
      ageDays,
      units30d: sale!.units30d,
      volume30dUsd: sale!.units30d * sale!.medianUsd,
    });
  }
  return { candidates, excluded };
}

/** Ranked by real 30-day traded USD volume; caps keep any one family or finish from dominating. */
export function pick(
  pool: readonly Candidate[],
  category: Category,
  count: number,
  caps: { family: number; finish: number },
  taken: ReadonlySet<string> = new Set(),
) {
  const ranked = pool
    .filter((c) => c.category === category && !taken.has(c.name))
    .sort(
      (a, b) => b.volume30dUsd - a.volume30dUsd || (a.name < b.name ? -1 : 1),
    );
  const chosen: Candidate[] = [];
  const tally = (key: (c: Candidate) => string, c: Candidate) =>
    chosen.filter((x) => key(x) === key(c)).length;
  for (const c of ranked) {
    if (chosen.length === count) break;
    // One wear per skin: wears of the same skin move together.
    if (chosen.some((x) => x.family === c.family && x.finish === c.finish))
      continue;
    if (
      tally((x) => x.family, c) >= caps.family ||
      (category !== "case" && tally((x) => x.finish, c) >= caps.finish)
    )
      continue;
    chosen.push(c);
  }
  if (chosen.length < count)
    throw Error(`Not enough eligible ${category} constituents (${chosen.length}/${count})`);
  return chosen;
}
const CAPS: Record<Category, { family: number; finish: number }> = {
  knife: { family: 2, finish: 4 },
  glove: { family: 2, finish: 2 },
  premium: { family: 4, finish: 2 },
  weapon: { family: 2, finish: 2 },
  case: { family: 1, finish: 1 },
};
const SLEEVE = {
  knife: "knives",
  glove: "gloves",
  weapon: "weapons",
  case: "cases",
  premium: "premium",
} as const;
export function selectGenesis(
  candidates: readonly Candidate[],
  approvedAt: number,
) {
  const liquidityRank = new Map<string, number>();
  for (const category of Object.keys(CAPS) as Category[]) {
    const ranked = candidates
      .filter((c) => c.category === category)
      .sort((a, b) => a.volume30dUsd - b.volume30dUsd);
    ranked.forEach((c, i) =>
      liquidityRank.set(
        c.name,
        ranked.length > 1 ? Math.round((i * 10_000) / (ranked.length - 1)) : 10_000,
      ),
    );
  }
  const groups: Record<string, [Category, number, bigint][]> = {
    "HS-CS50": [
      ["knife", 15, 30n],
      ["glove", 8, 15n],
      ["weapon", 12, 25n],
      ["case", 10, 20n],
      ["premium", 5, 10n],
    ],
    "HS-KNIFE20": [["knife", 20, 100n]],
    "HS-GLOVE10": [["glove", 10, 100n]],
    "HS-BLUE20": [["premium", 20, 100n]],
    "HS-CASE20": [["case", 20, 100n]],
  };
  return INDEXES.map((index) => {
    const constituents = groups[index.ticker].flatMap(
      ([category, count, percent]) => {
        const members = pick(candidates, category, count, CAPS[category]);
        const sleeve = (WAD * percent) / 100n;
        return members.map((c, i) => ({
          constituentId: c.name,
          // Integer dust goes to the first member so weights sum to exactly 1e18.
          weightE18: String(
            sleeve / BigInt(count) + (i === 0 ? sleeve % BigInt(count) : 0n),
          ),
          basePriceE8: String(c.reference.valueE8),
          family: c.family,
          finish: c.finish,
          sleeve: SLEEVE[c.category],
          eligibility: {
            sources: c.venues.length,
            // Share of configured venues quoting at approval; replaced by measured uptime at the first rebalance.
            uptimeBps: Math.round((c.venues.length * 10_000) / 5),
            spreadBps: c.spreadBps,
            historyDays: Math.min(c.ageDays, 3650),
            integrityFlag: false,
            ageDays: c.ageDays,
            liquidityBps: liquidityRank.get(c.name)!,
            agreementBps: Math.max(
              0,
              10_000 - Math.round((c.dispersionBps * 10_000) / RULES.maxDispersionBps),
            ),
          },
          mappings: c.venues.map((providerId) => ({
            providerId,
            instrument: c.name,
          })),
          venueBaseE8: Object.fromEntries(
            c.venues.map((v) => [v, c.venueAskE8[v]]),
          ),
          evidence: {
            referenceUsd: Number(c.reference.valueE8) / 1e8,
            confidenceBps: c.reference.confidenceBps,
            dispersionBps: c.dispersionBps,
            skinportUnits30d: c.units30d,
            skinportVolume30dUsd: Math.round(c.volume30dUsd),
          },
        }));
      },
    );
    const basket = {
      indexId: index.indexId,
      versionId: id(`${index.ticker}|${METHODOLOGY}|genesis|${approvedAt}`),
      divisorE8: "100000000000",
      approvedAt,
      activatesAt: approvedAt,
      constituents,
    };
    validateBasket(
      basket as Basket,
      [...new Set(constituents.flatMap((c) => c.mappings.map((m) => m.providerId)))].map(
        (providerId) => ({ id: providerId }),
      ),
      { genesis: true, minProviders: 3 },
    );
    return {
      ticker: index.ticker,
      ...basket,
      compositionRoot: compositionRoot({
        indexId: basket.indexId,
        divisorE8: basket.divisorE8,
        basket: constituents.map((c) => ({ ...c, observations: [] })),
      }),
    };
  });
}
export type GenesisConfig = {
  methodology: typeof METHODOLOGY;
  methodologyHash: string;
  generatedAt: number;
  venues: string[];
  rules: typeof RULES;
  baskets: ReturnType<typeof selectGenesis>;
};

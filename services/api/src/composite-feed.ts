import {
  isPreview,
  priorHistory,
  type IndexPoint,
  type IndicativeFeed,
  type IndicativeIndex,
  type PriorSegment,
} from "@hyperstrike/market-types";
import type { ReferencePrice } from "@hyperstrike/index-core";
import { replay } from "./pipeline";
import { METHODOLOGY, type GenesisConfig } from "./genesis";
import { VENUES, readVenues } from "./venues";
import { buildInput, genesisNames, observationsOf } from "./oracle-engine";

export const HISTORY_LIMIT = 1008; // one week of ten-minute snapshots
const DAY = 86_400;
/** The last observation of each UTC day. */
export function dailyCloses(points: readonly IndexPoint[]) {
  const closes = new Map<number, IndexPoint>();
  for (const p of points) closes.set(Math.floor(p.observedAt / DAY), p);
  return [...closes.values()];
}
/**
 * Every observation of the latest week, and one close a day before that, so a
 * series keeps its whole length however often it is published. The base point
 * always stays.
 */
export function thin(history: readonly IndexPoint[]) {
  const [base, ...rest] = history;
  const recent = rest.findIndex(
    (p) => p.observedAt >= history.at(-1)!.observedAt - 7 * DAY,
  );
  return [
    base,
    ...dailyCloses(rest.slice(0, recent)),
    ...rest.slice(recent).slice(-HISTORY_LIMIT),
  ];
}
/**
 * What a preview series becomes once new baskets replace it: daily closes,
 * rescaled with whatever preceded them so the line meets the new base at 1,000.
 */
export function supersede(index: IndicativeIndex): PriorSegment[] {
  const scale = 1000 / index.history.at(-1)!.value;
  const rescaled = (points: readonly IndexPoint[]) =>
    points.map((p) => ({
      value: Math.round(p.value * scale * 1e8) / 1e8,
      observedAt: p.observedAt,
    }));
  const segments = (index.prior ?? []).map((segment) => ({
    ...segment,
    points: rescaled(segment.points),
  }));
  const closes = rescaled(dailyCloses(index.history));
  if (segments.at(-1)?.provenance === "PREVIEW")
    segments.at(-1)!.points.push(...closes);
  else segments.push({ provenance: "PREVIEW", points: closes });
  return segments;
}
/**
 * Public display feed for methodology HS-MVA-1: the same baskets, venue
 * adapters and integer arithmetic as the on-chain oracle, minus signatures.
 * It stays provenance INDICATIVE — only quorum-signed observations settle.
 */
export async function refreshComposite(
  previous: IndicativeFeed | undefined,
  config: GenesisConfig,
  request: typeof fetch = fetch,
  clock = Date.now,
): Promise<IndicativeFeed> {
  const names = genesisNames(config);
  const { snapshots, failures } = await readVenues(
    names,
    request,
    undefined,
    clock,
  );
  if (snapshots.length < 3)
    throw Error(
      `Only ${snapshots.length} venues answered; preserving the published snapshot`,
    );
  const quotes = observationsOf(snapshots, names);
  const observedAt = Math.ceil(
    Math.max(clock(), ...snapshots.map((s) => s.receivedAtMs)) / 1000,
  );
  const continued = previous?.methodology === METHODOLOGY ? previous : undefined;
  const indexes = config.baskets.map((basket) => {
    const { constituents, index } = replay(
      buildInput(basket, observedAt, quotes),
    );
    const published = continued?.indexes.find(
      (i) => i.indexId === basket.indexId,
    );
    const before =
      published?.versionId === basket.versionId ? published : undefined;
    // New baskets start a new series at 1,000. A preview they replace stays on
    // the chart as earlier history; it is never spliced into the series.
    const prior = priorHistory({
      prior: before
        ? before.prior
        : published?.history.length && isPreview(published)
          ? supersede(published)
          : published?.prior,
    });
    // By construction the index is exactly 1,000 at the basket's approval snapshot.
    const history = before?.history.length
      ? [...before.history]
      : [{ value: 1000, observedAt: config.generatedAt }];
    const fresh = index.valueE8 !== null && index.status !== "UNSAFE";
    const value = fresh ? Number(index.valueE8) / 1e8 : (history.at(-1)?.value ?? null);
    if (fresh && observedAt > history.at(-1)!.observedAt)
      history.push({ value: value!, observedAt });
    const available = (h: ReferencePrice) =>
      h.status === "AVAILABLE" ? h : null;
    return {
      ticker: basket.ticker,
      indexId: basket.indexId,
      provenance: "INDICATIVE",
      settlementEligible: false,
      status: fresh ? "OK" : "STALE",
      value,
      changeSinceBasePct:
        value === null ? null : Math.round((value / 1000 - 1) * 1e6) / 1e4 || 0,
      baseAt: config.generatedAt,
      observedAt: fresh ? observedAt : (history.at(-1)?.observedAt ?? null),
      coverage: constituents.filter((c) => c.hrp.status === "AVAILABLE").length,
      count: basket.constituents.length,
      confidenceBps: index.confidenceBps,
      versionId: basket.versionId,
      constituents: constituents.map((c) => {
        const h = available(c.hrp);
        return {
          name: c.constituentId,
          baseUsd: Number(c.basePriceE8) / 1e8,
          priceUsd: h ? Number(h.valueE8) / 1e8 : null,
          weight: Number(c.weightE18) / 1e18,
          updatedAt: h ? Math.floor(h.observedAtMs / 1000) : null,
          sources: h ? h.sources.length : 0,
        };
      }),
      history: thin(history),
      ...(prior.length ? { prior } : {}),
    } satisfies IndicativeIndex;
  });
  if (!indexes.some((i) => i.status === "OK"))
    throw Error("No fresh index observations; preserving the published snapshot");
  return {
    source: VENUES.map((v) => v.label).join(" · "),
    sourceUrl: "/#Indexes",
    venues: VENUES.map((v) => ({
      id: v.id,
      label: v.label,
      site: v.site,
      ok: !failures.some((f) => f.providerId === v.id),
    })),
    currency: "USD",
    methodology: METHODOLOGY,
    checkedAt: Math.floor(clock() / 1000),
    error: failures.length
      ? `Unavailable this cycle: ${failures.map((f) => f.providerId).join(", ")}.`
      : undefined,
    indexes,
  };
}

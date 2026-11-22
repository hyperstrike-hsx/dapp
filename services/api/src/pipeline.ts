import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  calculateIndex,
  referencePrice,
  ASK_REFERENCE_POLICY,
  DEFAULT_HRP_POLICY,
  type VenueObservation,
  type ConstituentInput,
} from "@hyperstrike/index-core";
import { commitPayload, stringify } from "./store";
// Adapters normalize only AFTER the exact provider payload has been committed.
export async function ingest(
  db: DatabaseSync,
  providerId: string,
  fetchRaw: () => Promise<string>,
  normalize: (
    raw: string,
  ) => Omit<VenueObservation, "rawPayloadHash" | "receivedAtMs" | "providerId">,
) {
  const raw = await fetchRaw(),
    receivedAtMs = Date.now();
  const rawPayloadHash = commitPayload(db, providerId, raw, receivedAtMs);
  const q: VenueObservation = {
    ...normalize(raw),
    providerId,
    rawPayloadHash,
    receivedAtMs,
  };
  if (
    !q.constituentId ||
    !Number.isSafeInteger(q.observedAtMs) ||
    q.observedAtMs > receivedAtMs
  )
    throw new Error("Malformed normalized observation");
  db.prepare(
    "INSERT INTO venue_observations(provider_id,constituent_id,source_sequence,observed_at,payload_hash,data) VALUES(?,?,?,?,?,?)",
  ).run(
    providerId,
    q.constituentId,
    q.sourceSequence ?? null,
    q.observedAtMs,
    rawPayloadHash,
    stringify(q),
  );
  return q;
}
export type ReplayInput = {
  indexId: string;
  observedAt: number;
  divisorE8: string;
  /** Absent = two-sided HRP-1. The methodology is part of the committed input. */
  methodology?: "HS-MVA-1";
  basket: {
    constituentId: string;
    weightE18: string;
    basePriceE8: string;
    /**
     * Each venue's own ask at basket approval. When present, a venue is read as
     * a price relative to its own base, so persistent level differences between
     * venues (fees, audience) cancel and a venue outage cannot shift the index.
     */
    venueBaseE8?: Record<string, string>;
    observations: Record<string, unknown>[];
  }[];
};
export function compositionRoot(
  input: Pick<ReplayInput, "indexId" | "divisorE8" | "basket">,
) {
  const constituents = [...input.basket]
    .sort((a, b) =>
      a.constituentId < b.constituentId
        ? -1
        : a.constituentId > b.constituentId
          ? 1
          : 0,
    )
    .map((c) => ({
      id: c.constituentId,
      weightE18: BigInt(c.weightE18).toString(),
      basePriceE8: BigInt(c.basePriceE8).toString(),
      ...(c.venueBaseE8
        ? {
            venueBaseE8: Object.fromEntries(
              Object.entries(c.venueBaseE8)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([venue, base]) => [venue, BigInt(base).toString()]),
            ),
          }
        : {}),
    }));
  return keccak256(
    toUtf8Bytes(
      stringify({
        indexId: input.indexId,
        divisorE8: BigInt(input.divisorE8).toString(),
        constituents,
      }),
    ),
  );
}
function reviveQuote(q: Record<string, unknown>): VenueObservation {
  const copy = { ...q };
  for (const key of [
    "bidE8",
    "askE8",
    "bidDepthUsdE8",
    "askDepthUsdE8",
    "lastSaleE8",
    "rollingVolumeUsdE8",
  ]) {
    if (copy[key] !== undefined) copy[key] = BigInt(String(copy[key]));
  }
  return copy as VenueObservation;
}
/** Rescales a venue quote onto the constituent's base level; quotes from a venue with no base are dropped. */
export function basisAdjusted(
  quotes: VenueObservation[],
  basePriceE8: bigint,
  venueBaseE8?: Record<string, string>,
): VenueObservation[] {
  if (!venueBaseE8) return quotes;
  return quotes.flatMap((q) => {
    const base = venueBaseE8[q.providerId];
    if (!base || BigInt(base) <= 0n) return [];
    const scale = (v?: bigint) =>
      v === undefined ? undefined : (v * basePriceE8) / BigInt(base);
    return [{ ...q, askE8: scale(q.askE8), bidE8: scale(q.bidE8) }];
  });
}
export function replay(input: ReplayInput) {
  const constituents: ConstituentInput[] = input.basket.map((i) => ({
    constituentId: i.constituentId,
    weightE18: BigInt(i.weightE18),
    basePriceE8: BigInt(i.basePriceE8),
    hrp: referencePrice(
      i.constituentId,
      basisAdjusted(
        i.observations.map(reviveQuote),
        BigInt(i.basePriceE8),
        i.venueBaseE8,
      ),
      input.observedAt * 1000,
      input.methodology === "HS-MVA-1"
        ? ASK_REFERENCE_POLICY
        : DEFAULT_HRP_POLICY,
    ),
  }));
  return {
    constituents,
    index: calculateIndex(constituents, BigInt(input.divisorE8)),
  };
}
/** Canonical ordering: the committed hash never depends on fetch or iteration order. */
export function canonicalInput(input: ReplayInput): ReplayInput {
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    ...input,
    basket: [...input.basket]
      .sort((a, b) => order(a.constituentId, b.constituentId))
      .map((i) => ({
        ...i,
        observations: [...i.observations].sort((a, b) =>
          order(String(a.providerId), String(b.providerId)),
        ),
      })),
  };
}
export const inputHash = (canonical: ReplayInput) =>
  `0x${createHash("sha256").update(stringify(canonical)).digest("hex")}` as const;
export function commitCalculation(db: DatabaseSync, input: ReplayInput) {
  const canonical = canonicalInput(input);
  const serialized = stringify(canonical),
    hash = inputHash(canonical);
  const output = replay(canonical);
  db.prepare("INSERT INTO replay_records VALUES(?,?,?,?,?)").run(
    input.indexId,
    input.observedAt,
    hash,
    serialized,
    stringify(output),
  );
  return { hash, output };
}

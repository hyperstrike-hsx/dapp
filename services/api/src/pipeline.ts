import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  calculateIndex,
  referencePrice,
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
  basket: {
    constituentId: string;
    weightE18: string;
    basePriceE8: string;
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
export function replay(input: ReplayInput) {
  const constituents: ConstituentInput[] = input.basket.map((i) => ({
    constituentId: i.constituentId,
    weightE18: BigInt(i.weightE18),
    basePriceE8: BigInt(i.basePriceE8),
    hrp: referencePrice(
      i.constituentId,
      i.observations.map(reviveQuote),
      input.observedAt * 1000,
    ),
  }));
  return {
    constituents,
    index: calculateIndex(constituents, BigInt(input.divisorE8)),
  };
}
export function commitCalculation(db: DatabaseSync, input: ReplayInput) {
  const canonical = {
    ...input,
    basket: [...input.basket]
      .sort((a, b) =>
        a.constituentId < b.constituentId
          ? -1
          : a.constituentId > b.constituentId
            ? 1
            : 0,
      )
      .map((i) => ({
        ...i,
        observations: [...i.observations].sort((a, b) =>
          String(a.providerId) < String(b.providerId)
            ? -1
            : String(a.providerId) > String(b.providerId)
              ? 1
              : 0,
        ),
      })),
  };
  const serialized = stringify(canonical),
    hash = `0x${createHash("sha256").update(serialized).digest("hex")}`;
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TypedDataEncoder, type Wallet, type HDNodeWallet } from "ethers";
import { INDEXES } from "@hyperstrike/market-types";
import { OBSERVATION_TYPES } from "@hyperstrike/oracle-types";
import type { VenueObservation } from "@hyperstrike/index-core";
import {
  canonicalInput,
  compositionRoot,
  inputHash,
  replay,
  type ReplayInput,
} from "./pipeline";
import { stringify } from "./store";
import { validateBasket, type Basket } from "./indexer-engine";
import { METHODOLOGY, type GenesisConfig } from "./genesis";
import { VENUE_IDS, toObservation, type VenueSnapshot } from "./venues";

export const GENESIS_PATH = fileURLToPath(
  new URL("../../../config/index-genesis.json", import.meta.url),
);
type GenesisBasket = GenesisConfig["baskets"][number];
/** Loads the committed composition and refuses anything that no longer hashes to its root. */
export function loadGenesis(
  path = process.env.HS_GENESIS_CONFIG ?? GENESIS_PATH,
): GenesisConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as GenesisConfig;
  if (
    config.methodology !== METHODOLOGY ||
    config.baskets.length !== INDEXES.length ||
    INDEXES.some((index, i) => config.baskets[i].indexId !== index.indexId)
  )
    throw Error("Genesis config must hold the five canonical baskets in order");
  for (const b of config.baskets) {
    validateBasket(
      b as Basket,
      VENUE_IDS.map((id) => ({ id })),
      { genesis: true, minProviders: 3 },
    );
    if (basketRoot(b) !== b.compositionRoot)
      throw Error(`${b.ticker}: composition does not match its committed root`);
  }
  return config;
}
export const basketRoot = (b: GenesisBasket) =>
  compositionRoot({
    indexId: b.indexId,
    divisorE8: b.divisorE8,
    basket: b.constituents.map((c) => ({ ...c, observations: [] })),
  });
export const genesisNames = (config: GenesisConfig) => [
  ...new Set(
    config.baskets.flatMap((b) => b.constituents.map((c) => c.constituentId)),
  ),
];
export const observationsOf = (
  snapshots: readonly VenueSnapshot[],
  names: readonly string[],
  hashes: ReadonlyMap<string, `0x${string}`> = new Map(),
) =>
  snapshots.flatMap((s) =>
    names.flatMap((n) => {
      const q = toObservation(s, n, hashes.get(s.providerId) ?? s.bodySha256);
      return q ? [q] : [];
    }),
  );

export function buildInput(
  basket: GenesisBasket,
  observedAt: number,
  observations: readonly VenueObservation[],
): ReplayInput {
  return canonicalInput({
    indexId: basket.indexId,
    observedAt,
    divisorE8: basket.divisorE8,
    methodology: METHODOLOGY,
    basket: basket.constituents.map((c) => ({
      constituentId: c.constituentId,
      weightE18: c.weightE18,
      basePriceE8: c.basePriceE8,
      venueBaseE8: c.venueBaseE8,
      observations: observations
        .filter(
          (q) =>
            q.constituentId === c.constituentId &&
            c.mappings.some((m) => m.providerId === q.providerId),
        )
        .map((q) => JSON.parse(stringify(q))),
    })),
  });
}
export type Candidate = {
  indexId: string;
  versionId: string;
  observedAt: number;
  valueE8: string;
  confidenceBps: number;
  constituentRoot: string;
  sourceDataRoot: string;
  sequence: string;
};
/** Null when the index is not publishable (unavailable or unsafe): nothing is ever signed for it. */
export function candidateOf(
  basket: GenesisBasket,
  input: ReplayInput,
): Candidate | null {
  const { index } = replay(input);
  if (index.valueE8 === null || index.status === "UNSAFE") return null;
  return {
    indexId: basket.indexId,
    versionId: basket.versionId,
    observedAt: input.observedAt,
    valueE8: String(index.valueE8),
    confidenceBps: index.confidenceBps,
    constituentRoot: basket.compositionRoot,
    sourceDataRoot: inputHash(input),
    // One slot per five-minute boundary: monotonic without any shared counter.
    sequence: String(Math.floor(input.observedAt / 300)),
  };
}
export const oracleDomain = (chainId: bigint | number, oracle: string) => ({
  name: "HyperStrike Index Oracle",
  version: "1",
  chainId: Number(chainId),
  verifyingContract: oracle,
});
/** Mirrors IndexOracle.PUBLICATION_WINDOW. */
export const PUBLICATION_WINDOW = 240;
/**
 * A signer never trusts the proposer. It replays the committed inputs, checks
 * them against the committed composition, and requires the result to agree
 * with venue data it fetched itself.
 */
export function verifyCandidate(
  config: GenesisConfig,
  candidate: Candidate,
  input: ReplayInput,
  own: readonly VenueObservation[],
  nowSeconds: number,
  toleranceBps = 75,
) {
  const basket = config.baskets.find((b) => b.indexId === candidate.indexId);
  if (!basket) throw Error("Noncanonical index");
  if (
    input.methodology !== METHODOLOGY ||
    input.indexId !== basket.indexId ||
    input.divisorE8 !== basket.divisorE8 ||
    input.observedAt !== candidate.observedAt ||
    compositionRoot(input) !== basket.compositionRoot ||
    candidate.constituentRoot !== basket.compositionRoot ||
    candidate.versionId !== basket.versionId
  )
    throw Error("Inputs do not match the committed composition");
  if (
    candidate.observedAt % 300 !== 0 ||
    candidate.observedAt > nowSeconds ||
    nowSeconds - candidate.observedAt > PUBLICATION_WINDOW ||
    candidate.sequence !== String(candidate.observedAt / 300)
  )
    throw Error("Outside the publication window");
  for (const c of input.basket)
    for (const q of c.observations)
      if (
        q.constituentId !== c.constituentId ||
        !VENUE_IDS.includes(String(q.providerId))
      )
        throw Error("Quote from an unknown venue or constituent");
  const canonical = canonicalInput(input);
  if (inputHash(canonical) !== candidate.sourceDataRoot)
    throw Error("Source data root mismatch");
  const expected = candidateOf(basket, canonical);
  if (
    !expected ||
    expected.valueE8 !== candidate.valueE8 ||
    expected.confidenceBps !== candidate.confidenceBps
  )
    throw Error("Observation differs from deterministic replay");
  const mine = candidateOf(
    basket,
    buildInput(basket, candidate.observedAt, own),
  );
  if (!mine) throw Error("Signer has no independent index value");
  const a = BigInt(mine.valueE8),
    b = BigInt(candidate.valueE8);
  const gap = Number(((a > b ? a - b : b - a) * 10_000n) / a);
  if (gap > toleranceBps)
    throw Error(`Proposed value is ${gap} bps from independently fetched data`);
  return { independentValueE8: mine.valueE8, gapBps: gap };
}
export async function signCandidate(
  wallet: Wallet | HDNodeWallet,
  domain: ReturnType<typeof oracleDomain>,
  candidate: Candidate,
) {
  return {
    signer: wallet.address,
    digest: TypedDataEncoder.hash(domain, OBSERVATION_TYPES, candidate),
    signature: await wallet.signTypedData(domain, OBSERVATION_TYPES, candidate),
  };
}

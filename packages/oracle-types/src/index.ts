export type Hex = `0x${string}`;
export type IndexStatus = "HEALTHY" | "DEGRADED" | "UNSAFE" | "UNAVAILABLE";
export type IndexObservation = {
  indexId: Hex;
  versionId: Hex;
  observedAt: number;
  valueE8: bigint;
  confidenceBps: number;
  status: Exclude<IndexStatus, "UNAVAILABLE">;
  constituentRoot: Hex;
  sourceDataRoot: Hex;
  sequence: bigint;
};
export type IndexSettlementValue = {
  indexId: Hex;
  resolutionTime: number;
  valueE8: bigint;
  observationSequences: bigint[];
  window: "PRIMARY" | "FALLBACK";
};
export const OBSERVATION_TYPES = {
  IndexObservation: [
    { name: "indexId", type: "bytes32" },
    { name: "versionId", type: "bytes32" },
    { name: "observedAt", type: "uint64" },
    { name: "valueE8", type: "uint192" },
    { name: "confidenceBps", type: "uint32" },
    { name: "constituentRoot", type: "bytes32" },
    { name: "sourceDataRoot", type: "bytes32" },
    { name: "sequence", type: "uint64" },
  ],
};

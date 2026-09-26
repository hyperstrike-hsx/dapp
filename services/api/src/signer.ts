import { Wallet, TypedDataEncoder, Contract, JsonRpcProvider } from "ethers";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  OBSERVATION_TYPES,
  type IndexObservation,
} from "@hyperstrike/oracle-types";
import { openStore, stringify, audit } from "./store";
import { replay, compositionRoot, type ReplayInput } from "./pipeline";
// One process, one isolated signer key, one independently maintained source database.
// This command outputs a signature only; it never broadcasts or holds treasury authority.
const [file] = process.argv.slice(2);
if (
  !file ||
  !process.env.HS_SIGNER_KEY ||
  !process.env.HS_RPC_URL ||
  !process.env.HS_INDEX_ORACLE_ADDRESS
)
  throw Error(
    "Usage: signer observation.json with signer-local environment configuration",
  );
const candidate = JSON.parse(await readFile(file, "utf8"));
const db = openStore();
const provider = new JsonRpcProvider(process.env.HS_RPC_URL);
try {
  if ((await provider.getNetwork()).chainId !== 999n)
    throw Error("Chain mismatch");
  const row = db
    .prepare(
      "SELECT input,input_hash,output FROM replay_records WHERE index_id=? AND observed_at=?",
    )
    .get(candidate.indexId, candidate.observedAt);
  if (!row) throw Error("Missing independently committed source data");
  const localHash = `0x${createHash("sha256").update(String(row.input)).digest("hex")}`;
  if (localHash !== row.input_hash || candidate.sourceDataRoot !== localHash)
    throw Error("Committed source root mismatch");
  const input = JSON.parse(String(row.input)) as ReplayInput,
    result = replay(input);
  if (
    stringify(result) !== row.output ||
    result.index.valueE8 === null ||
    result.index.status === "UNSAFE" ||
    result.index.status === "UNAVAILABLE"
  )
    throw Error("Replay mismatch or unsafe result");
  if (
    candidate.valueE8 !== String(result.index.valueE8) ||
    candidate.confidenceBps !== result.index.confidenceBps
  )
    throw Error("Observation differs from replay");
  const constituentRoot = compositionRoot(input);
  if (candidate.constituentRoot !== constituentRoot)
    throw Error("Constituent commitment mismatch");
  // Recheck all raw payload hashes in the signer's independently ingested database.
  for (const constituent of input.basket)
    for (const quote of constituent.observations) {
      const normalized = db
        .prepare(
          "SELECT data FROM venue_observations WHERE provider_id=? AND constituent_id=? AND payload_hash=?",
        )
        .get(
          String(quote.providerId),
          constituent.constituentId,
          String(quote.rawPayloadHash),
        );
      if (!normalized || String(normalized.data) !== stringify(quote))
        throw Error(
          "Quote differs from independently normalized source record",
        );
      const raw = db
        .prepare("SELECT payload FROM raw_provider_payloads WHERE hash=?")
        .get(String(quote.rawPayloadHash));
      if (
        !raw ||
        `0x${createHash("sha256").update(String(raw.payload)).digest("hex")}` !==
          quote.rawPayloadHash
      )
        throw Error("Missing/corrupt raw payload");
    }
  const now = Math.floor(Date.now() / 1000);
  if (
    candidate.observedAt % 300 ||
    candidate.observedAt > now ||
    now - candidate.observedAt > 90
  )
    throw Error("Missed publication window");
  const oracle = new Contract(
    process.env.HS_INDEX_ORACLE_ADDRESS,
    [
      "function registry() view returns(address)",
      "function signers() view returns(address)",
      "function latest(bytes32) view returns((bytes32 indexId,bytes32 versionId,uint64 observedAt,uint192 valueE8,uint32 confidenceBps,bytes32 constituentRoot,bytes32 sourceDataRoot,uint64 sequence))",
    ],
    provider,
  );
  const registry = new Contract(
    await oracle.registry(),
    [
      "function versionAt(bytes32,uint64) view returns(bytes32)",
      "function compositionAt(bytes32,uint64) view returns(bytes32)",
      "function incident(bytes32) view returns(bool)",
    ],
    provider,
  );
  if (
    (await registry.versionAt(candidate.indexId, candidate.observedAt)) !==
      candidate.versionId ||
    (await registry.compositionAt(candidate.indexId, candidate.observedAt)) !==
      constituentRoot ||
    (await registry.incident(candidate.indexId))
  )
    throw Error("Index version/incident");
  if (
    BigInt(candidate.sequence) <=
    (await oracle.latest(candidate.indexId)).sequence
  )
    throw Error("Sequence replay");
  const wallet = new Wallet(process.env.HS_SIGNER_KEY);
  const signers = new Contract(
    await oracle.signers(),
    ["function signer(address) view returns(bool)"],
    provider,
  );
  if (!(await signers.signer(wallet.address)))
    throw Error("Unregistered signer");
  const domain = {
    name: "HyperStrike Index Oracle",
    version: "1",
    chainId: 999,
    verifyingContract: process.env.HS_INDEX_ORACLE_ADDRESS,
  };
  const digest = TypedDataEncoder.hash(domain, OBSERVATION_TYPES, candidate);
  const signature = await wallet.signTypedData(
    domain,
    OBSERVATION_TYPES,
    candidate,
  );
  audit(db, "ORACLE_SIGNATURE", {
    signer: wallet.address,
    digest,
    observation: candidate,
    signature,
  });
  console.log(
    stringify({
      signer: wallet.address,
      digest,
      signature,
      observation: candidate as IndexObservation,
    }),
  );
} finally {
  db.close();
  provider.destroy();
}

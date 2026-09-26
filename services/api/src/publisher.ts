import { readFile } from "node:fs/promises";
import {
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  Wallet,
  verifyTypedData,
} from "ethers";
import { OBSERVATION_TYPES } from "@hyperstrike/oracle-types";
import { openStore, audit, stringify } from "./store";
import { INDEXES } from "@hyperstrike/market-types";

// Collect signatures from isolated hosts; this process never holds their keys.
const paths = process.argv.slice(2).filter((a) => a !== "--broadcast");
if (
  paths.length < 2 ||
  !process.env.HS_INDEX_ORACLE_ADDRESS ||
  !process.env.HS_RPC_URL
)
  throw Error(
    "Supply at least two signer-output JSON files and native oracle/RPC configuration",
  );
const signed = await Promise.all(
  paths.map(async (p) => JSON.parse(await readFile(p, "utf8"))),
);
const observation = signed[0].observation;
if (!INDEXES.some((i) => i.indexId === observation.indexId))
  throw Error("Noncanonical index");
const domain = {
  name: "HyperStrike Index Oracle",
  version: "1",
  chainId: 999,
  verifyingContract: process.env.HS_INDEX_ORACLE_ADDRESS,
};
const digest = TypedDataEncoder.hash(domain, OBSERVATION_TYPES, observation);
const signatures = signed
  .map((s) => {
    if (
      TypedDataEncoder.hash(domain, OBSERVATION_TYPES, s.observation) !==
        digest ||
      s.digest !== digest
    )
      throw Error("Signer observations disagree");
    const address = verifyTypedData(
      domain,
      OBSERVATION_TYPES,
      observation,
      s.signature,
    );
    if (address.toLowerCase() !== String(s.signer).toLowerCase())
      throw Error("Invalid signer envelope");
    return { address, signature: s.signature };
  })
  .sort((a, b) =>
    a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
  );
if (new Set(signatures.map((s) => s.address)).size !== signatures.length)
  throw Error("Duplicate signer");
const provider = new JsonRpcProvider(process.env.HS_RPC_URL);
const db = openStore();
try {
  if ((await provider.getNetwork()).chainId !== 999n)
    throw Error("Wrong chain");
  const tuple =
    "(bytes32 indexId,bytes32 versionId,uint64 observedAt,uint192 valueE8,uint32 confidenceBps,bytes32 constituentRoot,bytes32 sourceDataRoot,uint64 sequence)";
  const oracle = new Contract(
    process.env.HS_INDEX_ORACLE_ADDRESS,
    [
      `function publish(${tuple},bytes[])`,
      "function signers() view returns(address)",
    ],
    provider,
  );
  const registry = new Contract(
    await oracle.signers(),
    [
      "function quorum() view returns(uint256)",
      "function signer(address) view returns(bool)",
    ],
    provider,
  );
  if (signatures.length < Number(await registry.quorum()))
    throw Error("Insufficient quorum");
  for (const s of signatures)
    if (!(await registry.signer(s.address))) throw Error("Unregistered signer");
  await oracle.publish.staticCall(
    observation,
    signatures.map((s) => s.signature),
  );
  if (!process.argv.includes("--broadcast")) {
    console.log(
      stringify({
        mode: "SIMULATION_ONLY",
        digest,
        signers: signatures.map((s) => s.address),
      }),
    );
  } else {
    if (!process.env.HS_PUBLISHER_KEY)
      throw Error("Isolated funded publisher signer required");
    const publisher = oracle.connect(
      new Wallet(process.env.HS_PUBLISHER_KEY, provider),
    ) as Contract;
    const tx = await publisher.publish(
      observation,
      signatures.map((s) => s.signature),
    );
    audit(db, "ORACLE_BROADCAST", { digest, transaction: tx.hash });
    await tx.wait();
    console.log(stringify({ digest, transaction: tx.hash }));
  }
} finally {
  db.close();
  provider.destroy();
}

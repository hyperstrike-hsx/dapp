import { Contract, Interface, JsonRpcProvider } from "ethers";
import { openStore, audit, stringify } from "./store";
import {
  INDEXES,
  question,
  type MarketDefinition,
} from "@hyperstrike/market-types";
const observationTuple =
  "(bytes32 indexId,bytes32 versionId,uint64 observedAt,uint192 valueE8,uint32 confidenceBps,bytes32 constituentRoot,bytes32 sourceDataRoot,uint64 sequence)";
const definitionTuple =
  "(uint8 template,bytes32 indexId,uint8 direction,int192 thresholdE8,uint64 creationReferenceTime,uint192 creationReferenceValueE8,uint64 tradeCloseTime,uint64 resolutionTime,bytes32 settlementPolicyId)";
const eventAbi = [
  "event MarketCreated(bytes32 indexed key,address indexed market,address indexed creator,bytes32 indexId,uint64 resolutionTime,uint256 seedLiquidity)",
  "event Published(bytes32 indexed indexId,uint64 indexed observedAt,uint64 sequence,bytes32 digest,uint192 valueE8,uint32 confidenceBps)",
  "event Traded(address indexed trader,uint8 side,bool buy,uint256 collateralAmount,uint256 tokens,uint256 fee)",
  "event StateChanged(uint8 state)",
  "event Redeemed(address indexed account,uint256 yesAmount,uint256 noAmount,uint256 payout)",
  "event Finalized(address indexed market,uint8 result)",
  "event Minted(address indexed account,uint256 strikeAmount,uint256 hsxBurned,uint256 hypePaid)",
  "event Accrued(address indexed market,address indexed creator,uint256 creatorFee,uint256 protocolFee)",
  "event Claimed(address indexed account,uint256 amount)",
];
export async function indexChain() {
  if (
    !process.env.HS_RPC_URL ||
    !process.env.HS_FACTORY_ADDRESS ||
    !process.env.HS_INDEX_ORACLE_ADDRESS ||
    !process.env.HS_DEPLOYMENT_BLOCK
  )
    throw Error("Native deployment/RPC configuration required");
  const db = openStore(),
    provider = new JsonRpcProvider(process.env.HS_RPC_URL);
  try {
    if ((await provider.getNetwork()).chainId !== 999n)
      throw Error("Wrong chain");
    const previous = db
      .prepare(
        "SELECT data FROM audit_events WHERE kind='CHAIN_CHECKPOINT' ORDER BY id DESC LIMIT 1",
      )
      .get();
    const checkpoint = previous ? JSON.parse(String(previous.data)) : null;
    if (
      checkpoint &&
      (await provider.getBlock(checkpoint.block))?.hash !== checkpoint.hash
    ) {
      audit(db, "CHAIN_REORG", checkpoint);
      throw Error(
        "Finalized checkpoint changed; halt and rebuild read model from a new database",
      );
    }
    const from = checkpoint
      ? checkpoint.block + 1
      : Number(process.env.HS_DEPLOYMENT_BLOCK);
    const finalized =
      (await provider.getBlockNumber()) -
      Number(process.env.HS_CONFIRMATIONS ?? 20);
    const to = Math.min(finalized, from + 999);
    if (from > to) return;
    const base = [
      process.env.HS_FACTORY_ADDRESS,
      process.env.HS_INDEX_ORACLE_ADDRESS,
      process.env.HS_SETTLEMENT_ADDRESS,
      process.env.HS_MINTER_ADDRESS,
      process.env.HS_FEE_VAULT_ADDRESS,
    ].filter((v): v is string => !!v);
    const iface = new Interface(eventAbi),
      logs = await provider.getLogs({
        address: base,
        fromBlock: from,
        toBlock: to,
      });
    const created = logs.flatMap((log) => {
      try {
        const e = iface.parseLog(log);
        return e?.name === "MarketCreated" ? [String(e.args.market)] : [];
      } catch {
        return [];
      }
    });
    const addresses = [
      ...new Set([
        ...db
          .prepare("SELECT market_id FROM markets")
          .all()
          .map((r) => String(r.market_id)),
        ...created,
      ]),
    ];
    if (addresses.length)
      logs.push(
        ...(await provider.getLogs({
          address: addresses,
          fromBlock: from,
          toBlock: to,
        })),
      );
    for (const log of logs.sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
    )) {
      const e = iface.parseLog(log);
      if (!e) continue;
      const data: Record<string, unknown> = {
        market: log.address,
        txHash: log.transactionHash,
      };
      e.fragment.inputs.forEach((input, i) => (data[input.name] = e.args[i]));
      db.prepare(
        "INSERT OR IGNORE INTO chain_events VALUES(?,?,?,?,?,?,?)",
      ).run(
        999,
        log.blockNumber,
        log.blockHash,
        log.transactionHash,
        log.index,
        e.name,
        stringify(data),
      );
      if (e.name === "MarketCreated") {
        const c = new Contract(
          e.args.market,
          [`function definition() view returns(${definitionTuple})`],
          provider,
        );
        const d = await c.definition();
        if (!INDEXES.some((i) => i.indexId === d.indexId))
          throw Error("Noncanonical market detected");
        const definition: MarketDefinition = {
          template: Number(d.template) === 0 ? "LEVEL" : "MOVE",
          indexId: d.indexId,
          direction: Number(d.direction) === 0 ? "UP" : "DOWN",
          thresholdE8: d.thresholdE8,
          creationReferenceTime: Number(d.creationReferenceTime),
          creationReferenceValueE8: d.creationReferenceValueE8,
          tradeCloseTime: Number(d.tradeCloseTime),
          resolutionTime: Number(d.resolutionTime),
          settlementPolicyId: d.settlementPolicyId,
        };
        db.prepare("INSERT OR IGNORE INTO markets VALUES(?,?,?,?)").run(
          e.args.market,
          e.args.key,
          d.indexId,
          stringify({
            address: e.args.market,
            marketKey: e.args.key,
            creator: e.args.creator,
            initialLiquidity: e.args.seedLiquidity,
            definition,
            question: question(definition),
            createdAtBlock: log.blockNumber,
          }),
        );
      }
      if (e.name === "Published") {
        const c = new Contract(
          process.env.HS_INDEX_ORACLE_ADDRESS,
          [`function at(bytes32,uint64) view returns(${observationTuple})`],
          provider,
        );
        const o = await c.at(e.args.indexId, e.args.observedAt);
        const tx = await provider.getTransaction(log.transactionHash);
        const publisher = new Interface([
          `function publish(${observationTuple},bytes[])`,
        ]);
        const publication = tx
          ? publisher.parseTransaction({ data: tx.data })
          : null;
        const data = {
          indexId: o.indexId,
          versionId: o.versionId,
          observedAt: Number(o.observedAt),
          valueE8: String(o.valueE8),
          confidenceBps: Number(o.confidenceBps),
          status:
            Number(o.confidenceBps) >= 9000
              ? "HEALTHY"
              : Number(o.confidenceBps) >= 7500
                ? "DEGRADED"
                : "UNSAFE",
          constituentRoot: o.constituentRoot,
          sourceDataRoot: o.sourceDataRoot,
          sequence: String(o.sequence),
          transaction: log.transactionHash,
          signatureCount: publication?.args[1]?.length ?? 0,
        };
        db.prepare(
          "INSERT OR IGNORE INTO index_observations VALUES(?,?,?,?,?)",
        ).run(
          o.indexId,
          Number(o.observedAt),
          Number(o.sequence),
          stringify(data),
          "CANONICAL",
        );
      }
    }
    const snapshots = [];
    for (const address of addresses) {
      const c = new Contract(
        address,
        [
          "function collateral() view returns(address)",
          "function liability() view returns(uint256)",
          "function lockedCollateral() view returns(uint256)",
          "function state() view returns(uint8)",
        ],
        provider,
      );
      const token = new Contract(
        await c.collateral(),
        ["function balanceOf(address) view returns(uint256)"],
        provider,
      );
      const [backing, liability, locked, state] = await Promise.all([
        token.balanceOf(address, { blockTag: to }),
        c.liability({ blockTag: to }),
        c.lockedCollateral({ blockTag: to }),
        c.state({ blockTag: to }),
      ]);
      if (backing < liability || locked < liability) {
        audit(db, "COLLATERAL_INVARIANT_BREACH", {
          address,
          backing,
          liability,
          locked,
        });
        throw Error(`Collateral invariant breached: ${address}`);
      }
      snapshots.push({
        address,
        surplus: String(backing - liability),
        locked: String(locked),
        liability: String(liability),
        backing: String(backing),
        state: Number(state),
      });
    }
    audit(db, "COLLATERAL_SNAPSHOT", snapshots);
    const block = await provider.getBlock(to);
    audit(db, "CHAIN_CHECKPOINT", { block: to, hash: block!.hash });
    console.log(`Indexed finalized blocks ${from}–${to}`);
  } finally {
    db.close();
    provider.destroy();
  }
}
if (process.argv[1]?.endsWith("chain-indexer.ts")) await indexChain();

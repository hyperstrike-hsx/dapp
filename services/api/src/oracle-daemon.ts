import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  JsonRpcProvider,
  NonceManager,
  TypedDataEncoder,
  Wallet,
  verifyTypedData,
} from "ethers";
import { OBSERVATION_TYPES } from "@hyperstrike/oracle-types";
import type { VenueObservation } from "@hyperstrike/index-core";
import { openStore, audit, stringify } from "./store";
import { commitCalculation, type ReplayInput } from "./pipeline";
import { commitSnapshot, readVenues } from "./venues";
import {
  PUBLICATION_WINDOW,
  buildInput,
  candidateOf,
  genesisNames,
  loadGenesis,
  observationsOf,
  oracleDomain,
  signCandidate,
  verifyCandidate,
  type Candidate,
} from "./oracle-engine";

/**
 * One long-running process per host.
 *
 *   proposer  fetches the venues, computes the five indexes on every
 *             five-minute boundary, gathers a signer quorum and publishes.
 *             It also pushes the HSX reference price and settles markets.
 *   signer    fetches the venues independently and signs a proposal only if
 *             it replays exactly and agrees with the signer's own data.
 *
 * --dry-run needs no chain and no keys: it runs real venue data through the
 * whole path with throwaway signers and prints what would be published.
 * --once runs a single cycle and exits.
 */
const flags = new Set(process.argv.slice(2));
const DRY = flags.has("--dry-run");
const ONCE = flags.has("--once") || DRY;
const ROLE = process.env.HS_ORACLE_ROLE === "signer" ? "signer" : "proposer";
const LEAD_MS = 45_000; // venue reads start this long before the boundary
const log = (event: string, data: object = {}) =>
  console.log(stringify({ at: new Date().toISOString(), event, ...data }));
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw Error(`Missing ${name}`);
  return value;
};
const sleepUntil = (ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms - Date.now())));

const config = loadGenesis();
const names = genesisNames(config);
const db = openStore(DRY ? ":memory:" : undefined);
const provider = DRY ? null : new JsonRpcProvider(env("HS_RPC_URL"));
const chainId = provider ? (await provider.getNetwork()).chainId : 999n;
const oracleAddress = DRY
  ? "0x0000000000000000000000000000000000000001"
  : env("HS_INDEX_ORACLE_ADDRESS");
const domain = oracleDomain(chainId, oracleAddress);
const TUPLE =
  "(bytes32 indexId,bytes32 versionId,uint64 observedAt,uint192 valueE8,uint32 confidenceBps,bytes32 constituentRoot,bytes32 sourceDataRoot,uint64 sequence)";
const oracle = provider
  ? new Contract(
      oracleAddress,
      [
        `function publish(${TUPLE},bytes[])`,
        "function registry() view returns(address)",
        "function signers() view returns(address)",
        `function latest(bytes32) view returns(${TUPLE})`,
      ],
      provider,
    )
  : null;
const signerRegistry = oracle
  ? new Contract(
      await oracle.signers(),
      [
        "function quorum() view returns(uint256)",
        "function signer(address) view returns(bool)",
      ],
      provider,
    )
  : null;
const indexRegistry = oracle
  ? new Contract(
      await oracle.registry(),
      [
        "function versionAt(bytes32,uint64) view returns(bytes32)",
        "function compositionAt(bytes32,uint64) view returns(bytes32)",
        "function incident(bytes32) view returns(bool)",
      ],
      provider,
    )
  : null;
const localSigners = DRY
  ? [Wallet.createRandom(), Wallet.createRandom()]
  : [
      process.env.HS_SIGNER_KEY,
      ...(process.env.HS_SIGNER_KEYS ?? "").split(","),
    ]
      .map((k) => k?.trim())
      .filter((k): k is string => !!k)
      .map((k) => new Wallet(k));
if (signerRegistry)
  for (const w of localSigners)
    if (!(await signerRegistry.signer(w.address)))
      throw Error(`${w.address} is not a registered oracle signer`);

/** Venue reads for the boundary T, committed before anything is calculated. */
async function observe(T: number) {
  const { snapshots, failures } = await readVenues(names);
  const hashes = new Map<string, `0x${string}`>();
  const quotes: VenueObservation[] = [];
  for (const s of snapshots) {
    const committed = commitSnapshot(db, s, names);
    if (committed[0]) hashes.set(s.providerId, committed[0].rawPayloadHash);
    quotes.push(...committed);
  }
  for (const f of failures) audit(db, "PROVIDER_FAILURE", { T, ...f });
  log("venues", {
    T,
    ok: snapshots.map((s) => s.providerId),
    failed: failures,
    quotes: quotes.length,
  });
  return quotes.length ? quotes : observationsOf(snapshots, names, hashes);
}

type Signed = { signer: string; signature: string };
async function chainAllows(candidate: Candidate) {
  if (!indexRegistry || !oracle) return;
  const [version, root, incident, latest] = await Promise.all([
    indexRegistry.versionAt(candidate.indexId, candidate.observedAt),
    indexRegistry.compositionAt(candidate.indexId, candidate.observedAt),
    indexRegistry.incident(candidate.indexId),
    oracle.latest(candidate.indexId),
  ]);
  if (version !== candidate.versionId || root !== candidate.constituentRoot)
    throw Error("On-chain composition differs from the local genesis config");
  if (incident) throw Error("Index incident active");
  if (BigInt(candidate.sequence) <= latest.sequence)
    throw Error("Sequence replay");
}

// ───────────────────────── signer role ─────────────────────────
const ownQuotes = new Map<number, VenueObservation[]>();
function serveSigner() {
  const token = env("HS_SIGNER_TOKEN");
  const wallet = localSigners[0];
  if (!wallet) throw Error("Signer role needs HS_SIGNER_KEY");
  createServer((req, res) => {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(stringify(body));
    };
    if (
      req.method !== "POST" ||
      !["/sign", "/sign-hsx"].includes(req.url ?? "")
    )
      return reply(404, {});
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, {});
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        if (req.url === "/sign-hsx") {
          const { value } = JSON.parse(raw) as { value: HsxValue };
          const signed = await signHsx(wallet, value, await readHsxUsdE8());
          audit(db, "HSX_REFERENCE_SIGNATURE", { ...signed, value });
          return reply(200, signed);
        }
        const { candidate, input } = JSON.parse(raw) as {
          candidate: Candidate;
          input: ReplayInput;
        };
        const own = ownQuotes.get(candidate.observedAt);
        if (!own) throw Error("No independent venue data for this boundary");
        const check = verifyCandidate(
          config,
          candidate,
          input,
          own,
          Math.floor(Date.now() / 1000),
        );
        await chainAllows(candidate);
        const signed = await signCandidate(wallet, domain, candidate);
        audit(db, "ORACLE_SIGNATURE", { ...signed, candidate, check });
        reply(200, signed);
      } catch (error) {
        log("refused", { reason: String((error as Error).message) });
        reply(422, { error: String((error as Error).message) });
      }
    });
  }).listen(
    Number(process.env.HS_SIGNER_PORT ?? 8790),
    process.env.HOST ?? "127.0.0.1",
  );
  log("signer-listening", { address: wallet.address });
}

// ───────────────────────── proposer role ─────────────────────────
const signerUrls = () =>
  (process.env.HS_SIGNER_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
async function askSigner(
  url: string,
  path: string,
  body: object,
): Promise<Signed> {
  const r = await fetch(new URL(path, url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env("HS_SIGNER_TOKEN")}`,
    },
    body: stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const answer = (await r.json()) as Signed & { error?: string };
  if (!r.ok) throw Error(`${url}: ${answer.error}`);
  return answer;
}
async function gather(
  candidate: Candidate,
  input: ReplayInput,
): Promise<Signed[]> {
  const signed: Signed[] = await Promise.all(
    localSigners.map((w) => signCandidate(w, domain, candidate)),
  );
  const remote = await Promise.allSettled(
    signerUrls().map((url) => askSigner(url, "/sign", { candidate, input })),
  );
  for (const r of remote)
    if (r.status === "fulfilled") signed.push(r.value);
    else log("signer-unavailable", { reason: String(r.reason?.message) });
  // Never trust a returned address: recover it from the signature itself.
  const recovered = new Map<string, string>();
  for (const s of signed)
    recovered.set(
      verifyTypedData(domain, OBSERVATION_TYPES, candidate, s.signature),
      s.signature,
    );
  return [...recovered]
    .map(([signer, signature]) => ({ signer, signature }))
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
}
const publisher =
  provider && ROLE === "proposer"
    ? new NonceManager(new Wallet(env("HS_PUBLISHER_KEY"), provider))
    : null;
/**
 * The oracle rejects an observation stamped after the block it lands in. The
 * wall clock passes a boundary before the chain's latest block does, so wait
 * for a block at or after the slot instead of simulating against an older one.
 */
async function chainReached(T: number) {
  for (let i = 0; i < 60; i++) {
    const block = await provider!.getBlock("latest");
    if (block && block.timestamp >= T) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw Error("Chain clock did not reach the observation slot");
}
async function propose(T: number, quotes: VenueObservation[]) {
  const quorum = signerRegistry ? Number(await signerRegistry.quorum()) : 2;
  const sends: Promise<unknown>[] = [];
  for (const basket of config.baskets) {
    try {
      const input = buildInput(basket, T, quotes);
      const candidate = candidateOf(basket, input);
      const { output } = commitCalculation(db, input);
      audit(db, "INDEX_CALCULATED", {
        ticker: basket.ticker,
        observedAt: T,
        status: output.index.status,
        confidenceBps: output.index.confidenceBps,
      });
      if (!candidate) {
        log("not-publishable", {
          ticker: basket.ticker,
          status: output.index.status,
        });
        continue;
      }
      await chainAllows(candidate);
      const signatures = await gather(candidate, input);
      const summary = {
        ticker: basket.ticker,
        observedAt: T,
        value: Number(candidate.valueE8) / 1e8,
        confidenceBps: candidate.confidenceBps,
        signers: signatures.map((s) => s.signer),
      };
      if (signatures.length < quorum) {
        log("no-quorum", summary);
        continue;
      }
      if (!publisher || !oracle) {
        log("dry-run-observation", {
          ...summary,
          digest: TypedDataEncoder.hash(domain, OBSERVATION_TYPES, candidate),
        });
        continue;
      }
      if (Date.now() / 1000 - T > PUBLICATION_WINDOW - 10) {
        log("missed-window", summary);
        continue;
      }
      const writer = oracle.connect(publisher) as Contract;
      const args = [candidate, signatures.map((s) => s.signature)] as const;
      await chainReached(T);
      await writer.publish.staticCall(...args);
      const tx = await writer.publish(...args);
      audit(db, "ORACLE_BROADCAST", { ...summary, transaction: tx.hash });
      db.prepare(
        "INSERT OR IGNORE INTO index_observations VALUES(?,?,?,?,'CANONICAL')",
      ).run(
        candidate.indexId,
        T,
        Number(candidate.sequence),
        stringify({ ...candidate, status: output.index.status }),
      );
      log("published", { ...summary, transaction: tx.hash });
      sends.push(tx.wait());
    } catch (error) {
      publisher?.reset();
      log("index-failed", {
        ticker: basket.ticker,
        reason: String((error as Error).message).slice(0, 300),
      });
    }
  }
  await Promise.allSettled(sends);
}

// HSX reference: the signer quorum's own reading of the pool spot price, the
// independent leg that the STRIKE minter compares against the on-chain TWAP.
const HSX_TYPES = {
  HsxReference: [
    { name: "usdE8", type: "uint192" },
    { name: "observedAt", type: "uint64" },
    { name: "sequence", type: "uint64" },
  ],
};
/** HSX/USD from the pool's spot price and Hyperliquid's HYPE mid, read by this host alone. */
async function readHsxUsdE8() {
  const pool = new Contract(
    process.env.HS_HSX_POOL ?? "0xa92ab5ed3041025b844233b109216c6c3c0bc63c",
    [
      "function slot0() view returns(uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
    ],
    provider,
  );
  const [slot, mids] = await Promise.all([
    pool.slot0(),
    fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.json() as Promise<Record<string, string>>),
  ]);
  const hype = Number(mids.HYPE);
  if (!(hype > 0)) throw Error("No HYPE mid");
  // token0 = WHYPE, token1 = HSX: the pool price is HSX per HYPE.
  const sqrt = BigInt(slot.sqrtPriceX96);
  const hsxPerHypeE18 = (sqrt * sqrt * 10n ** 18n) >> 192n;
  const usdE8 = (BigInt(Math.round(hype * 1e8)) * 10n ** 18n) / hsxPerHypeE18;
  if (usdE8 <= 0n) throw Error("HSX price rounds to zero");
  return usdE8;
}
type HsxValue = { usdE8: string; observedAt: number; sequence: number };
const hsxDomain = () => ({
  name: "HyperStrike HSX Reference",
  version: "1",
  chainId: Number(chainId),
  verifyingContract: env("HS_HSX_REFERENCE_ADDRESS"),
});
/** A signer attests the proposer's HSX price only within 2% of its own reading, inside the 120 s window. */
async function signHsx(
  wallet: Wallet | ReturnType<typeof Wallet.createRandom>,
  value: HsxValue,
  own: bigint,
) {
  const proposed = BigInt(value.usdE8);
  const gap =
    ((proposed > own ? proposed - own : own - proposed) * 10_000n) / own;
  const now = Math.floor(Date.now() / 1000);
  if (gap > 200n)
    throw Error(`HSX reference is ${gap} bps from this signer's reading`);
  if (
    value.observedAt > now ||
    now - value.observedAt > 110 ||
    value.sequence !== Math.floor(value.observedAt / 300)
  )
    throw Error("HSX reference outside its window");
  return {
    signer: wallet.address,
    signature: await wallet.signTypedData(hsxDomain(), HSX_TYPES, value),
  };
}
async function pushHsxReference(T: number) {
  const address = process.env.HS_HSX_REFERENCE_ADDRESS;
  if (!address || !provider || !publisher) return;
  try {
    const usdE8 = await readHsxUsdE8();
    const value: HsxValue = {
      usdE8: String(usdE8),
      observedAt: T,
      sequence: Math.floor(T / 300),
    };
    const signed: Signed[] = await Promise.all(
      localSigners.map((w) => signHsx(w, value, usdE8)),
    );
    for (const r of await Promise.allSettled(
      signerUrls().map((url) => askSigner(url, "/sign-hsx", { value })),
    ))
      if (r.status === "fulfilled") signed.push(r.value);
      else log("signer-unavailable", { reason: String(r.reason?.message) });
    const recovered = new Map<string, string>();
    for (const s of signed)
      recovered.set(
        verifyTypedData(hsxDomain(), HSX_TYPES, value, s.signature),
        s.signature,
      );
    const signatures = [...recovered].sort((a, b) =>
      BigInt(a[0]) < BigInt(b[0]) ? -1 : 1,
    );
    const reference = new Contract(
      address,
      [
        "function publish((uint192 usdE8,uint64 observedAt,uint64 sequence),bytes[])",
      ],
      publisher,
    );
    const args = [value, signatures.map((x) => x[1])] as const;
    await reference.publish.staticCall(...args);
    const tx = await reference.publish(...args);
    log("hsx-reference", {
      usdE8: value.usdE8,
      signers: signatures.length,
      transaction: tx.hash,
    });
    await tx.wait();
  } catch (error) {
    publisher.reset();
    log("hsx-reference-failed", {
      reason: String((error as Error).message).slice(0, 300),
    });
  }
}

// Settlement keeper: anyone may propose/finalize; this just makes sure someone does.
const KEEPER_FILE =
  process.env.HS_KEEPER_STATE ??
  fileURLToPath(new URL("../../../var/keeper.json", import.meta.url));
type KeeperState = { cursor: number; open: string[] };
function keeperState(): KeeperState {
  try {
    return JSON.parse(readFileSync(KEEPER_FILE, "utf8"));
  } catch {
    return { cursor: Number(process.env.HS_DEPLOYMENT_BLOCK ?? 0), open: [] };
  }
}
async function settle() {
  const factoryAddress = process.env.HS_FACTORY_ADDRESS,
    settlementAddress = process.env.HS_SETTLEMENT_ADDRESS;
  if (!factoryAddress || !settlementAddress || !provider || !publisher) return;
  const state = keeperState();
  try {
    const factory = new Contract(
      factoryAddress,
      [
        "event MarketCreated(bytes32 indexed key,address indexed market,address indexed creator,bytes32 indexId,uint64 resolutionTime,uint256 seedLiquidity)",
      ],
      provider,
    );
    const head =
      (await provider.getBlockNumber()) -
      Number(process.env.HS_CONFIRMATIONS ?? 2);
    if (!state.cursor) state.cursor = head;
    // Bounded catch-up per cycle keeps every RPC request small.
    for (let i = 0; i < 20 && state.cursor < head; i++) {
      const to = Math.min(state.cursor + 1000, head);
      for (const e of await factory.queryFilter(
        "MarketCreated",
        state.cursor + 1,
        to,
      ))
        if ("args" in e && !state.open.includes(e.args.market))
          state.open.push(e.args.market);
      state.cursor = to;
    }
    const settlement = new Contract(
      settlementAddress,
      [
        "function propose(address)",
        "function finalize(address)",
        "function refresh(address)",
        "function proposals(address) view returns(uint192 valueE8,uint64 proposedAt,uint8 result,bool challenged,address challenger,bytes32 evidenceHash)",
      ],
      publisher,
    );
    for (const address of [...state.open]) {
      const market = new Contract(
        address,
        ["function state() view returns(uint8)"],
        provider,
      );
      const s = Number(await market.state());
      if (s >= 4) {
        state.open = state.open.filter((a) => a !== address);
        continue;
      }
      // 2 = AWAITING_ORACLE, 3 = PROPOSED. A failed simulation means "not yet".
      for (const action of s === 2
        ? ["propose"]
        : s === 3
          ? ["finalize", "refresh"]
          : []) {
        try {
          await settlement[action].staticCall(address);
          const tx = await settlement[action](address);
          log("settlement", { action, market: address, transaction: tx.hash });
          await tx.wait();
          break;
        } catch {
          publisher.reset();
        }
      }
    }
  } catch (error) {
    log("keeper-failed", {
      reason: String((error as Error).message).slice(0, 300),
    });
  }
  mkdirSync(dirname(KEEPER_FILE), { recursive: true });
  writeFileSync(KEEPER_FILE, JSON.stringify(state));
}

log("started", {
  role: ROLE,
  dryRun: DRY,
  chainId: String(chainId),
  oracle: oracleAddress,
  signers: localSigners.map((w) => w.address),
  constituents: names.length,
});
if (ROLE === "signer") serveSigner();
for (;;) {
  // Dry runs price as if the boundary were one lead time away, without waiting.
  const T = DRY
    ? Math.ceil((Date.now() + LEAD_MS) / 1000)
    : Math.ceil((Date.now() + LEAD_MS + 5_000) / 300_000) * 300;
  if (!DRY) await sleepUntil(T * 1000 - LEAD_MS);
  try {
    const quotes = await observe(T);
    if (ROLE === "signer") {
      ownQuotes.set(T, quotes);
      for (const key of ownQuotes.keys())
        if (key < T - 600) ownQuotes.delete(key);
    } else {
      // Quotes are received before T; one extra second absorbs block-clock skew.
      if (!DRY) await sleepUntil(T * 1000 + 1000);
      await propose(T, quotes);
      await pushHsxReference(T);
      await settle();
    }
  } catch (error) {
    log("cycle-failed", {
      T,
      reason: String((error as Error).message).slice(0, 300),
    });
  }
  if (ONCE) break;
}
db.close();
provider?.destroy();

import { readFile, writeFile, mkdir, access as exists } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AbiCoder,
  ContractFactory,
  Wallet,
  Contract,
  JsonRpcProvider,
  parseUnits,
  parseEther,
  keccak256,
  Interface,
  id,
  toBeHex,
  zeroPadValue,
  randomBytes,
  hexlify,
} from "ethers";
import {
  preflight,
  ROOT,
  HSX,
  WHYPE,
  HSX_POOL,
  NATIVE_USDC,
  HYPE_PERP_INDEX,
  ORACLE_PX_PRECOMPILE,
  TICKERS,
} from "../../scripts/native-preflight.mjs";

const broadcast = process.argv.includes("--broadcast");
const rehearse = process.argv.includes("--rehearse");
// --rehearse --hold keeps the local fork running after deployment (and skips the time-warping
// publish smoke test) so the real oracle daemon can be pointed at it end to end.
const hold = process.argv.includes("--hold");
const PLAN =
  "ProtocolAccess → [ConfigTimelock] → IndexRegistry(genesis baskets) → OracleSignerRegistry → IndexOracle → ProtocolConfig → STRIKEToken → HsxV3Twap → HsxSignedReference → HsxPriceOracle → StrikeMinter (+minter wiring) → FeeVault → SettlementManager → NativeBinaryMarket implementation → MarketFactory";
if (broadcast && rehearse) throw Error("Choose --rehearse or --broadcast");
if (!broadcast && !rehearse) {
  console.log(
    `Native deployment plan: ${PLAN}. Run production:check with reviewed configuration first. No transactions sent. Use --rehearse to execute the identical sequence on a local fork (no real funds); pass --broadcast only after review.`,
  );
  process.exit(0);
}

const artifact = async (name, file = name) =>
  JSON.parse(
    await readFile(resolve(ROOT, `contracts/out/${file}.sol/${name}.json`), "utf8"),
  );

/** The deployment sequence. Identical for rehearsal and mainnet. */
async function deployAll({ provider, signer, addresses, signers, collateralDecimals, genesis, manifest, save }) {
  // HyperEVM small blocks are the default lane; refuse anything that cannot fit instead of hanging.
  const recent = await Promise.all(
    [0, 1, 2, 3, 4].map(async (back) => {
      const head = await provider.getBlockNumber();
      return (await provider.getBlock(head - back)).gasLimit;
    }),
  );
  const blockGas = recent.reduce((a, b) => (a < b ? a : b));
  // Explicit nonces: RPC "pending" counts can lag a just-mined transaction.
  let nonce = await provider.getTransactionCount(signer.address, "latest");
  const send = async (label, populate) => {
    const request = { ...(await populate), nonce };
    const estimate = await signer.estimateGas(request);
    if (estimate > blockGas)
      throw Error(
        `${label}: needs ${estimate} gas, above the ${blockGas} small-block limit. Enable big blocks for the deployer (HyperCore action evmUserModify usingBigBlocks=true) and retry.`,
      );
    const padded = (estimate * 110n) / 100n;
    const tx = await signer.sendTransaction({
      ...request,
      gasLimit: padded > blockGas ? blockGas : padded,
    });
    nonce++;
    return { tx, estimate };
  };
  const deploy = async (name, args) => {
    const a = await artifact(name);
    const factory = new ContractFactory(a.abi, a.bytecode.object, signer);
    const { tx, estimate } = await send(name, factory.getDeployTransaction(...args));
    manifest.contracts[name] = { constructorArgs: args, transaction: tx.hash, status: "PENDING" };
    await save();
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress)
      throw Error(`${name}: deployment failed (${tx.hash})`);
    const address = receipt.contractAddress;
    manifest.contracts[name] = {
      address,
      bytecodeHash: keccak256(await provider.getCode(address)),
      constructorArgs: args,
      transaction: tx.hash,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasEstimate: estimate,
      status: "DEPLOYED",
    };
    manifest.deploymentBlock ??= receipt.blockNumber;
    await save();
    console.log(`${name}: ${address} (gas ${receipt.gasUsed})`);
    return address;
  };
  const call = async (label, to, abi, fn, args) => {
    const data = new Interface(abi).encodeFunctionData(fn, args);
    const { tx } = await send(label, Promise.resolve({ to, data }));
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw Error(`${label} failed (${tx.hash})`);
    manifest.setupTransactions.push({ label, to, transaction: tx.hash });
    await save();
  };

  // A 30-minute TWAP needs observation history that survives swaps. Anyone may pay to extend it.
  const pool = new Contract(
    HSX_POOL,
    ["function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"],
    provider,
  );
  let cardinality = Number((await pool.slot0())[4]);
  manifest.poolObservationCardinalityBefore = cardinality;
  // 1800 slots: at one-second blocks nobody can push the 30-minute lookback out of the buffer
  // with dust swaps and so stall STRIKE minting.
  while (cardinality < 1800) {
    const next = Math.min(1800, cardinality + 100); // ~22k gas per new slot, 2.2M per chunk
    await call(
      `HSX pool observation cardinality → ${next}`,
      HSX_POOL,
      ["function increaseObservationCardinalityNext(uint16)"],
      "increaseObservationCardinalityNext",
      [next],
    );
    cardinality = next;
  }

  const access = await deploy("ProtocolAccess", [addresses.HS_ADMIN_MULTISIG]);
  const timelock =
    addresses.HS_CONFIG_TIMELOCK ??
    (await deploy("ConfigTimelock", [addresses.HS_ADMIN_MULTISIG]));
  manifest.configTimelock = timelock;
  const registry = await deploy("IndexRegistry", [
    access,
    genesis.versionIds,
    genesis.compositionRoots,
    genesis.methodologyHash,
  ]);
  const signerRegistry = await deploy("OracleSignerRegistry", [access, signers]);
  const oracle = await deploy("IndexOracle", [registry, signerRegistry]);
  const config = await deploy("ProtocolConfig", [
    addresses.HS_COLLATERAL_ADDRESS,
    oracle,
    parseUnits(process.env.HS_PILOT_CAP ?? "10000", collateralDecimals),
  ]);
  const strike = await deploy("STRIKEToken", [signer.address]);
  const twap = await deploy("HsxV3Twap", [HSX_POOL, HSX, WHYPE, HYPE_PERP_INDEX, 10000]);
  const reference = await deploy("HsxSignedReference", [signerRegistry]);
  const hsxOracle = await deploy("HsxPriceOracle", [access, twap, reference]);
  const minter = await deploy("StrikeMinter", [strike, HSX, access, hsxOracle, addresses.HS_TREASURY]);
  await call("STRIKE minter wiring", strike, ["function setMinter(address)"], "setMinter", [minter]);
  const fees = await deploy("FeeVault", [addresses.HS_COLLATERAL_ADDRESS, addresses.HS_TREASURY]);
  const settlement = await deploy("SettlementManager", [oracle, access, addresses.HS_TREASURY]);
  const implementation = await deploy("NativeBinaryMarket", []);
  const factory = await deploy("MarketFactory", [access, config, strike, settlement, fees, implementation]);

  const grant = new Interface(["function grantRole(bytes32,address)"]);
  for (const [roles, holder] of [
    [["CONFIG_ROLE", "ORACLE_ADMIN_ROLE", "RAIL_ADMIN_ROLE", "TREASURY_ROLE"], timelock],
    [["PAUSER_ROLE", "RESOLUTION_ROLE"], addresses.HS_ADMIN_MULTISIG],
  ])
    for (const role of roles)
      manifest.adminTransactions.push({
        to: access,
        data: grant.encodeFunctionData("grantRole", [id(role), holder]),
        role,
        holder,
      });
  manifest.env = {
    HS_FACTORY_ADDRESS: factory,
    HS_INDEX_ORACLE_ADDRESS: oracle,
    HS_INDEX_REGISTRY_ADDRESS: registry,
    HS_SIGNER_REGISTRY_ADDRESS: signerRegistry,
    HS_SETTLEMENT_ADDRESS: settlement,
    HS_MINTER_ADDRESS: minter,
    HS_STRIKE_ADDRESS: strike,
    HS_FEE_VAULT_ADDRESS: fees,
    HS_HSX_TWAP_ADDRESS: twap,
    HS_HSX_REFERENCE_ADDRESS: reference,
    HS_HSX_PRICE_ORACLE_ADDRESS: hsxOracle,
    HS_CONFIG_TIMELOCK: timelock,
    HS_COLLATERAL_ADDRESS: addresses.HS_COLLATERAL_ADDRESS,
    HS_DEPLOYMENT_BLOCK: String(manifest.deploymentBlock),
    VITE_NATIVE_FACTORY_ADDRESS: factory,
    VITE_COLLATERAL_ADDRESS: addresses.HS_COLLATERAL_ADDRESS,
    VITE_STRIKE_MINTER_ADDRESS: minter,
    VITE_STRIKE_ADDRESS: strike,
    VITE_FEE_VAULT_ADDRESS: fees,
  };
  await save();
  return { access, registry, signerRegistry, oracle, reference, hsxOracle, minter, twap, factory, config };
}

const envText = (env) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const jsonSafe = (_, v) => (typeof v === "bigint" ? v.toString() : v);

if (broadcast) {
  const { provider, addresses, signers, collateralDecimals, review, genesis } = await preflight();
  try {
    if (!process.env.HS_DEPLOYER_KEY) throw Error("Local deployer signer configuration missing");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: ROOT }).trim();
    if (
      commit !== review.commit ||
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: ROOT }).trim()
    )
      throw Error("Deploy only the exact clean externally reviewed commit");
    const signer = new Wallet(process.env.HS_DEPLOYER_KEY, provider);
    const manifest = {
      chainId: 999,
      commit,
      compiler: "0.8.26",
      configVersion: "index-native-v1",
      genesis,
      contracts: {},
      setupTransactions: [],
      adminTransactions: [],
      createdAt: new Date().toISOString(),
    };
    await mkdir(resolve(ROOT, "infra/deployments"), { recursive: true });
    const manifestPath = resolve(ROOT, `infra/deployments/native-${Date.now()}.json`);
    const save = () => writeFile(manifestPath, JSON.stringify(manifest, jsonSafe, 2));
    await save();
    await deployAll({ provider, signer, addresses, signers, collateralDecimals, genesis, manifest, save });
    console.log(`\nDeployment recorded in ${manifestPath}. Environment for services and web:\n\n${envText(manifest.env)}\n`);
    console.log(
      "Remaining explicit activation steps: multisig executes manifest.adminTransactions (role grants), explorer verification, then start oracle signers/publisher. Index genesis versions are live from the IndexRegistry constructor. No oracle values were fabricated.",
    );
  } finally {
    provider.destroy();
  }
} else {
  // ---- Rehearsal: identical sequence on a throwaway local fork. Nothing leaves this machine. ----
  const upstream = process.env.HS_RPC_URL ?? "https://rpc.hyperliquid.xyz/evm";
  const live = new JsonRpcProvider(upstream);
  if ((await live.getNetwork()).chainId !== 999n) throw Error("Rehearsal forks HyperEVM chain 999");
  // Local forks do not emulate HyperCore precompiles: copy the live HYPE oracle price into a stub.
  const rawPx = BigInt(
    await live.call({
      to: ORACLE_PX_PRECOMPILE,
      data: AbiCoder.defaultAbiCoder().encode(["uint32"], [HYPE_PERP_INDEX]),
    }),
  );
  live.destroy();
  const port = await new Promise((done, fail) => {
    const s = createServer().once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => done(p));
    });
  });
  const anvil = spawn(
    "anvil",
    ["--fork-url", upstream, "--port", String(port), "--gas-limit", "3000000", "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const stop = () => anvil.kill("SIGTERM");
  process.on("exit", stop);
  const local = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(local, 999, { staticNetwork: true });
  provider.pollingInterval = 100;
  let failed = false;
  try {
    for (let i = 0; ; i++) {
      try {
        await provider.getBlockNumber();
        break;
      } catch (error) {
        if (i > 150 || anvil.exitCode !== null) throw Error(`anvil fork did not start: ${error.message}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const notes = [];
    const stub = async (name) => {
      const a = Wallet.createRandom().address;
      await provider.send("anvil_setCode", [a, "0x00"]); // STOP: a contract account that accepts HYPE
      process.env[name] = a;
      notes.push(`${name} unset → throwaway contract account ${a}`);
    };
    for (const name of ["HS_ADMIN_MULTISIG", "HS_TREASURY"]) if (!process.env[name]) await stub(name);
    if (!process.env.HS_COLLATERAL_ADDRESS) {
      process.env.HS_COLLATERAL_ADDRESS = NATIVE_USDC;
      notes.push(`HS_COLLATERAL_ADDRESS unset → native USDC ${NATIVE_USDC}`);
    }
    let signerKeys = null;
    if (!process.env.HS_ORACLE_SIGNERS) {
      signerKeys = [0, 1, 2].map(() => Wallet.createRandom());
      process.env.HS_ORACLE_SIGNERS = signerKeys.map((w) => w.address).join(",");
      notes.push("HS_ORACLE_SIGNERS unset → three throwaway signer keys (oracle publishing is smoke-tested)");
    }
    if (!process.env.HS_GENESIS_CONFIG) {
      const standard = resolve(ROOT, "config/index-genesis.json");
      if (!(await exists(standard).then(() => true, () => false))) {
        const dummy = join(tmpdir(), `hs-rehearsal-genesis-${process.pid}.json`);
        await writeFile(
          dummy,
          JSON.stringify({
            methodologyHash: id("REHEARSAL-METHODOLOGY"),
            baskets: TICKERS.map((ticker) => ({
              ticker,
              indexId: id(ticker),
              versionId: id(`REHEARSAL-VERSION:${ticker}`),
              compositionRoot: id(`REHEARSAL-COMPOSITION:${ticker}`),
            })),
          }),
        );
        process.env.HS_GENESIS_CONFIG = dummy;
        notes.push("config/index-genesis.json absent → DUMMY genesis baskets (rehearsal only, not deployable)");
      }
    }
    process.env.HS_RPC_URL = local;
    const { addresses, signers, collateralDecimals, genesis } = await preflight({ rehearse: true, provider });
    const signer = new Wallet(hexlify(randomBytes(32)), provider);
    await provider.send("anvil_setBalance", [signer.address, toBeHex(parseEther("100"))]);
    const manifest = {
      chainId: 999,
      mode: "REHEARSAL_LOCAL_FORK",
      forkedAtBlock: await provider.getBlockNumber(),
      genesis,
      contracts: {},
      setupTransactions: [],
      adminTransactions: [],
      createdAt: new Date().toISOString(),
    };
    await mkdir(resolve(ROOT, "contracts/cache"), { recursive: true });
    const manifestPath = resolve(ROOT, `contracts/cache/rehearsal-${Date.now()}.json`);
    const save = () => writeFile(manifestPath, JSON.stringify(manifest, jsonSafe, 2));
    const balanceBefore = await provider.getBalance(signer.address);
    const d = await deployAll({ provider, signer, addresses, signers, collateralDecimals, genesis, manifest, save });
    const spent = balanceBefore - (await provider.getBalance(signer.address));

    // Post-deployment checks a mainnet launch would perform by hand.
    const checks = [];
    const registry = new Contract(
      d.registry,
      ["function versionAt(bytes32,uint64) view returns(bytes32)", "function compositionAt(bytes32,uint64) view returns(bytes32)"],
      provider,
    );
    const now = (await provider.getBlock("latest")).timestamp;
    for (const [i, ticker] of TICKERS.entries())
      if (
        (await registry.versionAt(id(ticker), now)) !== genesis.versionIds[i] ||
        (await registry.compositionAt(id(ticker), now)) !== genesis.compositionRoots[i]
      )
        throw Error(`Genesis version not live for ${ticker}`);
    checks.push("genesis versions live for all five indexes");
    // Multisig role grants exactly as recorded for the real multisig.
    await provider.send("anvil_setBalance", [addresses.HS_ADMIN_MULTISIG, toBeHex(parseEther("1"))]);
    await provider.send("anvil_impersonateAccount", [addresses.HS_ADMIN_MULTISIG]);
    for (const t of manifest.adminTransactions) {
      const hash = await provider.send("eth_sendTransaction", [{ from: addresses.HS_ADMIN_MULTISIG, to: t.to, data: t.data }]);
      let receipt = null; // direct polling: no new blocks arrive on an idle fork to wake a listener
      for (let i = 0; !receipt && i < 100; i++) {
        receipt = await provider.send("eth_getTransactionReceipt", [hash]);
        if (!receipt) await new Promise((r) => setTimeout(r, 100));
      }
      if (receipt?.status !== "0x1") throw Error(`Role grant failed: ${t.role}`);
    }
    const accessControl = new Contract(d.access, ["function hasRole(bytes32,address) view returns(bool)"], provider);
    for (const t of manifest.adminTransactions)
      if (!(await accessControl.hasRole(id(t.role), t.holder))) throw Error(`Role missing: ${t.role}`);
    checks.push(`${manifest.adminTransactions.length} multisig role grants execute and hold`);
    // HSX price path: real pool TWAP × HYPE oracle price (stubbed precompile carrying the live value).
    const mock = await artifact("MockOraclePx", "HsxPriceSources.t");
    await provider.send("anvil_setCode", [ORACLE_PX_PRECOMPILE, mock.deployedBytecode.object]);
    await provider.send("anvil_setStorageAt", [ORACLE_PX_PRECOMPILE, zeroPadValue("0x00", 32), zeroPadValue(toBeHex(rawPx), 32)]);
    const twap = new Contract(d.twap, ["function consult() view returns(uint192,uint64)", "function meanTick() view returns(int24)"], provider);
    const [twapUsdE8] = await twap.consult();
    checks.push(`HSX pool TWAP readable: mean tick ${await twap.meanTick()}, HYPE $${Number(rawPx) / 1e4}, HSX usdE8 ${twapUsdE8} ($${Number(twapUsdE8) / 1e8})`);
    if (signerKeys && !hold) {
      const ordered = [...signerKeys].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1)).slice(0, 2);
      const boundary = (Math.floor(now / 300) + 1) * 300;
      await provider.send("evm_setNextBlockTimestamp", [boundary]);
      const refValue = { usdE8: twapUsdE8, observedAt: boundary, sequence: 1 };
      const refDomain = { name: "HyperStrike HSX Reference", version: "1", chainId: 999, verifyingContract: d.reference };
      const refTypes = { HsxReference: [{ name: "usdE8", type: "uint192" }, { name: "observedAt", type: "uint64" }, { name: "sequence", type: "uint64" }] };
      const reference = new Contract(d.reference, ["function publish((uint192 usdE8,uint64 observedAt,uint64 sequence),bytes[])"], signer);
      await (await reference.publish(refValue, await Promise.all(ordered.map((w) => w.signTypedData(refDomain, refTypes, refValue))), { gasLimit: 500000, nonce: await provider.getTransactionCount(signer.address, "latest") })).wait();
      const observation = {
        indexId: id("HS-CS50"),
        versionId: genesis.versionIds[0],
        observedAt: boundary,
        valueE8: 100000000000n,
        confidenceBps: 9500,
        constituentRoot: genesis.compositionRoots[0],
        sourceDataRoot: id("rehearsal-sources"),
        sequence: 1,
      };
      const tuple = "(bytes32 indexId,bytes32 versionId,uint64 observedAt,uint192 valueE8,uint32 confidenceBps,bytes32 constituentRoot,bytes32 sourceDataRoot,uint64 sequence)";
      const oracle = new Contract(d.oracle, [`function publish(${tuple},bytes[])`, `function latest(bytes32) view returns(${tuple})`], signer);
      const domain = { name: "HyperStrike Index Oracle", version: "1", chainId: 999, verifyingContract: d.oracle };
      const types = {
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
      const receipt = await (await oracle.publish(observation, await Promise.all(ordered.map((w) => w.signTypedData(domain, types, observation))), { gasLimit: 800000, nonce: await provider.getTransactionCount(signer.address, "latest") })).wait();
      if ((await oracle.latest(observation.indexId)).valueE8 !== observation.valueE8) throw Error("Oracle publish not recorded");
      checks.push(`2-of-3 EIP-712 index observation accepted on-chain (gas ${receipt.gasUsed}); signed HSX reference accepted`);
      const minter = new Contract(d.minter, ["function quote(uint256) view returns(uint256,uint256,uint64)"], provider);
      const [hsxIn, hypeIn] = await minter.quote(parseEther("1"));
      checks.push(`STRIKE mint quote live: 1 STRIKE = ${Number(hsxIn) / 1e18} HSX burned + ${Number(hypeIn) / 1e18} HYPE`);
    } else checks.push("oracle publishing NOT smoke-tested (real HS_ORACLE_SIGNERS supplied; rehearsal holds no keys)");
    const gas = Object.entries(manifest.contracts).map(([n, c]) => `${n} ${c.gasUsed}`);
    // Held forks mine a block per second so off-chain services see the chain clock advance.
    if (hold) await provider.send("evm_setIntervalMining", [1]);
    if (hold)
      await writeFile(
        resolve(ROOT, "contracts/cache/rehearsal-hold.json"),
        JSON.stringify({ rpc: local, env: manifest.env, deployerKey: signer.privateKey, signerKeys: signerKeys?.map((w) => w.privateKey) ?? [] }, null, 2),
      );
    console.log(`\nREHEARSAL PASSED on a local fork of HyperEVM block ${manifest.forkedAtBlock}. No real transaction was sent.`);
    for (const n of notes) console.log(`  note: ${n}`);
    for (const c of checks) console.log(`  ok: ${c}`);
    console.log(`  deployments: ${gas.length}, largest ${gas.sort((a, b) => Number(b.split(" ")[1]) - Number(a.split(" ")[1]))[0]} (small-block limit 3000000)`);
    console.log(`  pool observation cardinality before: ${manifest.poolObservationCardinalityBefore} → 1800`);
    console.log(`  deployer spend at fork gas price: ${Number(spent) / 1e18} HYPE`);
    console.log(`  manifest: ${manifestPath}\n\nEnvironment a real deployment would emit (rehearsal addresses, do not use):\n${envText(manifest.env)}`);
  } catch (error) {
    failed = true;
    console.error(`REHEARSAL FAILED: ${error.stack ?? error.message}`);
  } finally {
    provider.destroy();
    if (!hold || failed) stop();
  }
  if (hold && !failed) {
    console.log(`\nHOLDING local fork at ${local} — Ctrl-C to stop. Throwaway keys: contracts/cache/rehearsal-hold.json`);
    await new Promise((done) => ["SIGINT", "SIGTERM"].forEach((sig) => process.on(sig, done)));
    stop();
  }
  process.exit(failed ? 1 : 0);
}

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  id,
  parseUnits,
} from "../../apps/web/node_modules/ethers/lib.esm/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ARTIFACT = resolve(ROOT, "contracts/out/HSXBurnGate.sol/HSXBurnGate.json");
const HYPEREVM_RPC = process.env.HYPEREVM_RPC ?? "https://rpc.hyperliquid.xyz/evm";
const HSX_TOKEN = process.env.HSX_TOKEN ?? "0xab5dbc5a6070d066697d8e55471877ea4343ece3";
const WORLD_CUP_DESCRIPTION = /2026 FIFA World Cup champion/i;

const hsxAbi = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
];

const gateAbi = [
  "function owner() view returns (address)",
  "function issuanceBurnAmount() view returns (uint256)",
  "function issuedBy(bytes32 specHash) view returns (address)",
  "function isOutcomeBound(uint64 outcomeId) view returns (bool)",
  "function outcomeSpec(uint64 outcomeId) view returns (bytes32)",
  "function burnToIssue(bytes32 specHash)",
  "function bindOutcome(bytes32 specHash, uint64 outcomeId)",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function wallet() {
  return new Wallet(requireEnv("PRIVATE_KEY"), new JsonRpcProvider(HYPEREVM_RPC));
}

async function artifact() {
  return JSON.parse(await readFile(ARTIFACT, "utf8"));
}

function specHashForWorldCup(outcome) {
  return id(`hyperstrike:worldcup-2026-champion:${outcome.outcome}:${outcome.name}`);
}

async function activeWorldCupChampionOutcomes() {
  const [metaResponse, midsResponse] = await Promise.all([
    fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "outcomeMeta" }),
    }),
    fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    }),
  ]);
  if (!metaResponse.ok) throw new Error(`outcomeMeta failed: ${metaResponse.status}`);
  if (!midsResponse.ok) throw new Error(`allMids failed: ${midsResponse.status}`);
  const meta = await metaResponse.json();
  const mids = await midsResponse.json();
  return meta.outcomes.filter((outcome) => {
    const yes = Number(mids[`#${outcome.outcome * 10}`]);
    const no = Number(mids[`#${outcome.outcome * 10 + 1}`]);
    return (
      WORLD_CUP_DESCRIPTION.test(outcome.description ?? "") &&
      outcome.sideSpecs?.length === 2 &&
      outcome.sideSpecs[0]?.name === "Yes" &&
      outcome.sideSpecs[1]?.name === "No" &&
      yes > 0.005 && yes < 0.995 &&
      no > 0.005 && no < 0.995
    );
  }).sort((left, right) => left.outcome - right.outcome);
}

async function deploy() {
  const signer = wallet();
  const { abi, bytecode } = await artifact();
  const owner = process.env.GATE_OWNER ?? await signer.getAddress();
  const issuanceBurn = parseUnits(requireEnv("ISSUANCE_BURN_HSX"), 18);
  const factory = new ContractFactory(abi, bytecode.object ?? bytecode, signer);
  console.log(`Deploying HSXBurnGate on HyperEVM`);
  console.log(`HSX token: ${HSX_TOKEN}`);
  console.log(`Owner: ${owner}`);
  console.log(`Issuance burn: ${formatUnits(issuanceBurn, 18)} HSX`);
  const gate = await factory.deploy(HSX_TOKEN, owner, issuanceBurn);
  await gate.waitForDeployment();
  console.log(`HSXBurnGate deployed: ${await gate.getAddress()}`);
}

async function bindWorldCup() {
  const signer = wallet();
  const address = requireEnv("GATE_ADDRESS");
  const gate = new Contract(address, gateAbi, signer);
  const hsx = new Contract(HSX_TOKEN, hsxAbi, signer);
  const signerAddress = await signer.getAddress();
  const owner = await gate.owner();
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(`Signer ${signerAddress} is not gate owner ${owner}; cannot bind outcomes.`);
  }
  const outcomes = await activeWorldCupChampionOutcomes();
  if (outcomes.length === 0) throw new Error("No active World Cup champion HIP-4 outcomes found.");
  const issuanceBurn = await gate.issuanceBurnAmount();
  const requiredApproval = issuanceBurn * BigInt(outcomes.length);
  const allowance = await hsx.allowance(signerAddress, address);
  if (allowance < requiredApproval) {
    console.log(`Approving ${formatUnits(requiredApproval, 18)} HSX issuance burn budget`);
    const approval = await hsx.approve(address, requiredApproval);
    console.log(`Approval tx: ${approval.hash}`);
    await approval.wait();
  }
  for (const outcome of outcomes) {
    const specHash = specHashForWorldCup(outcome);
    const alreadyBound = await gate.isOutcomeBound(outcome.outcome);
    if (!alreadyBound) {
      const issuer = await gate.issuedBy(specHash);
      if (/^0x0{40}$/i.test(issuer)) {
        console.log(`Issuing ${outcome.name} #${outcome.outcome} with spec ${specHash}`);
        const issue = await gate.burnToIssue(specHash);
        console.log(`Issue burn tx: ${issue.hash}`);
        await issue.wait();
      }
      console.log(`Binding ${outcome.name} #${outcome.outcome}`);
      const bind = await gate.bindOutcome(specHash, outcome.outcome);
      console.log(`Bind tx: ${bind.hash}`);
      await bind.wait();
    } else {
      console.log(`Already bound: ${outcome.name} #${outcome.outcome}`);
    }
  }
  console.log("World Cup burn gate bindings complete.");
}

async function main() {
  const command = process.argv[2];
  if (command === "deploy") return deploy();
  if (command === "bind-worldcup") return bindWorldCup();
  console.error(`Usage:
  PRIVATE_KEY=0x... ISSUANCE_BURN_HSX=1000 node contracts/script/burn-gate-admin.mjs deploy
  PRIVATE_KEY=0x... GATE_ADDRESS=0x... node contracts/script/burn-gate-admin.mjs bind-worldcup

Environment:
  HYPEREVM_RPC defaults to ${HYPEREVM_RPC}
  HSX_TOKEN defaults to ${HSX_TOKEN}
  GATE_OWNER defaults to the deployer wallet for deploy`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

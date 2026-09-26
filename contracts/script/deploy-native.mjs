import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  ContractFactory,
  Wallet,
  Contract,
  parseUnits,
  keccak256,
  Interface,
} from "ethers";
import { preflight, HSX } from "../../scripts/native-preflight.mjs";
const broadcast = process.argv.includes("--broadcast");
if (!broadcast) {
  console.log(
    "Native deployment plan: ProtocolAccess → IndexRegistry → OracleSignerRegistry → IndexOracle → ProtocolConfig → STRIKEToken → HsxPriceOracle → StrikeMinter → FeeVault → SettlementManager → MarketFactory. Run production:check with reviewed configuration first. No transactions sent. Pass --broadcast only after review.",
  );
  process.exit(0);
}
const { provider, addresses, signers, collateralDecimals, review } =
  await preflight();
try {
  if (!process.env.HS_DEPLOYER_KEY)
    throw Error("Local deployer signer configuration missing");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (
    commit !== review.commit ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    throw Error("Deploy only the exact clean externally reviewed commit");
  const signer = new Wallet(process.env.HS_DEPLOYER_KEY, provider);
  const manifest = {
    chainId: 999,
    commit,
    compiler: "0.8.26",
    configVersion: "index-native-v1",
    contracts: {},
    adminTransactions: [],
    createdAt: new Date().toISOString(),
  };
  await mkdir("infra/deployments", { recursive: true });
  const manifestPath = `infra/deployments/native-${Date.now()}.json`;
  const save = () =>
    writeFile(
      manifestPath,
      JSON.stringify(
        manifest,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
  await save();
  const deploy = async (name, args) => {
    const artifact = JSON.parse(
      await readFile(`contracts/out/${name}.sol/${name}.json`, "utf8"),
    );
    const c = await new ContractFactory(
      artifact.abi,
      artifact.bytecode.object,
      signer,
    ).deploy(...args);
    manifest.contracts[name] = {
      constructorArgs: args,
      transaction: c.deploymentTransaction().hash,
      status: "PENDING",
    };
    await save();
    await c.waitForDeployment();
    const address = await c.getAddress();
    manifest.contracts[name] = {
      address,
      bytecodeHash: keccak256(await provider.getCode(address)),
      constructorArgs: args,
      transaction: c.deploymentTransaction().hash,
      status: "DEPLOYED",
    };
    await save();
    console.log(`${name}: ${address}`);
    return address;
  };
  const access = await deploy("ProtocolAccess", [addresses.HS_ADMIN_MULTISIG]);
  const registry = await deploy("IndexRegistry", [access]);
  const signerRegistry = await deploy("OracleSignerRegistry", [
    access,
    signers,
  ]);
  const oracle = await deploy("IndexOracle", [registry, signerRegistry]);
  const config = await deploy("ProtocolConfig", [
    addresses.HS_COLLATERAL_ADDRESS,
    oracle,
    parseUnits(process.env.HS_PILOT_CAP ?? "10000", collateralDecimals),
  ]);
  const strike = await deploy("STRIKEToken", [signer.address]);
  const hsxOracle = await deploy("HsxPriceOracle", [
    access,
    addresses.HS_HSX_TWAP_ADDRESS,
    addresses.HS_HSX_REFERENCE_ADDRESS,
  ]);
  const minter = await deploy("StrikeMinter", [
    strike,
    HSX,
    access,
    hsxOracle,
    addresses.HS_TREASURY,
  ]);
  const setMinter = await new Contract(
    strike,
    ["function setMinter(address)"],
    signer,
  ).setMinter(minter);
  await setMinter.wait();
  manifest.minterWiringTransaction = setMinter.hash;
  await save();
  const fees = await deploy("FeeVault", [
    addresses.HS_COLLATERAL_ADDRESS,
    addresses.HS_TREASURY,
  ]);
  const settlement = await deploy("SettlementManager", [
    oracle,
    access,
    addresses.HS_TREASURY,
  ]);
  await deploy("MarketFactory", [access, config, strike, settlement, fees]);
  const iface = new Interface(["function grantRole(bytes32,address)"]);
  const { id } = await import("ethers");
  for (const role of [
    "CONFIG_ROLE",
    "ORACLE_ADMIN_ROLE",
    "RAIL_ADMIN_ROLE",
    "TREASURY_ROLE",
  ])
    manifest.adminTransactions.push({
      to: access,
      data: iface.encodeFunctionData("grantRole", [
        id(role),
        addresses.HS_CONFIG_TIMELOCK,
      ]),
      role,
    });
  for (const role of ["PAUSER_ROLE", "RESOLUTION_ROLE"])
    manifest.adminTransactions.push({
      to: access,
      data: iface.encodeFunctionData("grantRole", [
        id(role),
        addresses.HS_ADMIN_MULTISIG,
      ]),
      role,
    });
  await save();
  console.log(
    "Deployment recorded. Multisig role grants, composition scheduling and explorer verification remain explicit activation steps. No oracle values were fabricated.",
  );
} finally {
  provider.destroy();
}

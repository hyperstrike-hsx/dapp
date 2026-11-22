import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { Contract, JsonRpcProvider, getAddress, keccak256, id } from "ethers";
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const HSX = "0xab5dbc5a6070d066697d8e55471877ea4343ece3";
export const WHYPE = "0x5555555555555555555555555555555555555555";
export const HSX_POOL = "0xa92ab5ed3041025b844233b109216c6c3c0bc63c";
export const NATIVE_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
export const HYPE_PERP_INDEX = 159; // HyperCore oracle precompile: raw * 1e4 = USD E8
export const ORACLE_PX_PRECOMPILE = "0x0000000000000000000000000000000000000807";
export const TICKERS = [
  "HS-CS50",
  "HS-KNIFE20",
  "HS-GLOVE10",
  "HS-BLUE20",
  "HS-CASE20",
];
const bytes32 = (v) =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) && !/^0x0+$/.test(v);

/** Committee-approved genesis baskets, in the canonical on-chain order. */
export async function loadGenesis(file = process.env.HS_GENESIS_CONFIG) {
  const path = file
    ? isAbsolute(file)
      ? file
      : resolve(process.cwd(), file)
    : resolve(ROOT, "config/index-genesis.json");
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw Error(`Genesis index configuration unreadable (${path}): ${error.message}`);
  }
  if (!bytes32(config.methodologyHash))
    throw Error("Genesis methodologyHash must be a nonzero bytes32");
  if (!Array.isArray(config.baskets) || config.baskets.length !== 5)
    throw Error("Genesis must define exactly the five canonical baskets");
  const ordered = TICKERS.map((ticker) => {
    const matches = config.baskets.filter((b) => b.ticker === ticker);
    if (matches.length !== 1) throw Error(`Genesis basket missing/duplicated: ${ticker}`);
    const b = matches[0];
    if (b.indexId !== undefined && String(b.indexId).toLowerCase() !== id(ticker))
      throw Error(`Genesis indexId mismatch: ${ticker}`);
    if (!bytes32(b.versionId) || !bytes32(b.compositionRoot))
      throw Error(`Genesis version/composition root invalid: ${ticker}`);
    return b;
  });
  return {
    path,
    methodologyHash: config.methodologyHash,
    versionIds: ordered.map((b) => b.versionId),
    compositionRoots: ordered.map((b) => b.compositionRoot),
  };
}

/**
 * Fail-closed launch checks. `rehearse` (local fork only) skips nothing except the human review-report
 * attestations, which a rehearsal cannot and must not satisfy.
 */
export async function preflight({ rehearse = false, provider: supplied } = {}) {
  const required = [
    "HS_RPC_URL",
    "HS_ADMIN_MULTISIG",
    "HS_TREASURY",
    "HS_COLLATERAL_ADDRESS",
    "HS_ORACLE_SIGNERS",
    ...(rehearse ? [] : ["HS_REVIEW_REPORT"]),
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length)
    throw Error(`Missing launch configuration: ${missing.join(", ")}`);
  const provider = supplied ?? new JsonRpcProvider(process.env.HS_RPC_URL);
  try {
    if ((await provider.getNetwork()).chainId !== 999n)
      throw Error("Expected HyperEVM chain 999");
    const genesis = await loadGenesis();
    const addresses = Object.fromEntries(
      [
        "HS_ADMIN_MULTISIG",
        "HS_TREASURY",
        "HS_COLLATERAL_ADDRESS",
        ...(process.env.HS_CONFIG_TIMELOCK ? ["HS_CONFIG_TIMELOCK"] : []),
      ].map((k) => [k, getAddress(process.env[k])]),
    );
    for (const [name, address] of Object.entries({
      ...addresses,
      HSX,
      HSX_POOL,
      WHYPE,
    })) {
      if ((await provider.getCode(address)) === "0x")
        throw Error(`${name}: no deployed code`);
    }
    // Unset timelock: the deployment creates ConfigTimelock (48h, multisig proposer/executor, no admin).
    if (addresses.HS_CONFIG_TIMELOCK) {
      const timelock = new Contract(
        addresses.HS_CONFIG_TIMELOCK,
        ["function getMinDelay() view returns(uint256)"],
        provider,
      );
      if ((await timelock.getMinDelay()) < 172800n)
        throw Error("Configuration timelock must be at least 48 hours");
    }
    const tokenAbi = [
      "function decimals() view returns(uint8)",
      "function totalSupply() view returns(uint256)",
    ];
    const hsx = new Contract(HSX, tokenAbi, provider),
      collateral = new Contract(
        addresses.HS_COLLATERAL_ADDRESS,
        tokenAbi,
        provider,
      );
    const hsxDecimals = Number(await hsx.decimals()),
      collateralDecimals = Number(await collateral.decimals());
    if (hsxDecimals !== 18 || collateralDecimals > 18)
      throw Error("Unsupported decimals");
    const hsxSupply = String(await hsx.totalSupply());
    const pool = new Contract(
      HSX_POOL,
      [
        "function token0() view returns(address)",
        "function token1() view returns(address)",
        "function observe(uint32[]) view returns(int56[],uint160[])",
      ],
      provider,
    );
    if (
      (await pool.token0()).toLowerCase() !== WHYPE ||
      (await pool.token1()).toLowerCase() !== HSX
    )
      throw Error("HSX pool token order changed");
    await pool.observe([1800, 0]); // 30-minute TWAP must be readable now
    const signers = process.env.HS_ORACLE_SIGNERS.split(",").map((s) =>
      getAddress(s.trim()),
    );
    if (signers.length !== 3 || new Set(signers).size !== 3)
      throw Error("Three distinct independent oracle signers required");
    if (
      signers.some((s) =>
        [addresses.HS_TREASURY, addresses.HS_ADMIN_MULTISIG].includes(s),
      )
    )
      throw Error("Signer and treasury/admin identities overlap");
    let review = null;
    if (!rehearse) {
      review = JSON.parse(await readFile(process.env.HS_REVIEW_REPORT, "utf8"));
      if (
        review.hsx?.codeHash !== keccak256(await provider.getCode(HSX)) ||
        review.hsx?.burnFromReducesTotalSupply !== true ||
        review.hsx?.expectedSupply !== hsxSupply
      )
        throw Error("HSX fork-review/code hash/current-supply evidence mismatch");
      if (
        review.collateral?.address?.toLowerCase() !==
          addresses.HS_COLLATERAL_ADDRESS.toLowerCase() ||
        review.collateral?.codeHash !==
          keccak256(await provider.getCode(addresses.HS_COLLATERAL_ADDRESS)) ||
        review.collateral?.decimals !== collateralDecimals ||
        !review.collateral?.nonRebasing ||
        !review.collateral?.noTransferFee ||
        !review.collateral?.noTransferHooks
      )
        throw Error("Collateral transfer-semantics review required");
      for (const gate of [
        "initialBasketsApproved",
        "twoVenuesPerConstituent",
        "historicalBackfillReviewed",
        "independentSignerInfrastructure",
        "externalContractReview",
        "hsxOracleLiquidityReview",
        "monitoringConfigured",
      ])
        if (review[gate] !== true)
          throw Error(`Release gate incomplete: ${gate}`);
      if (!review.commit || !review.reportUri)
        throw Error("External review must identify commit and report");
    }
    return {
      provider,
      addresses,
      signers,
      hsxSupply,
      collateralDecimals,
      review,
      genesis,
    };
  } catch (error) {
    if (!supplied) provider.destroy();
    throw error;
  }
}

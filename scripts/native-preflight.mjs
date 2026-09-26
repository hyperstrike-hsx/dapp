import { readFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, getAddress, keccak256 } from "ethers";
export const HSX = "0xab5dbc5a6070d066697d8e55471877ea4343ece3";
export async function preflight() {
  const required = [
    "HS_RPC_URL",
    "HS_ADMIN_MULTISIG",
    "HS_CONFIG_TIMELOCK",
    "HS_TREASURY",
    "HS_COLLATERAL_ADDRESS",
    "HS_HSX_TWAP_ADDRESS",
    "HS_HSX_REFERENCE_ADDRESS",
    "HS_ORACLE_SIGNERS",
    "HS_REVIEW_REPORT",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length)
    throw Error(`Missing launch configuration: ${missing.join(", ")}`);
  const provider = new JsonRpcProvider(process.env.HS_RPC_URL);
  try {
    if ((await provider.getNetwork()).chainId !== 999n)
      throw Error("Expected HyperEVM chain 999");
    const review = JSON.parse(
      await readFile(process.env.HS_REVIEW_REPORT, "utf8"),
    );
    const addresses = Object.fromEntries(
      required
        .filter(
          (k) =>
            k.endsWith("ADDRESS") ||
            ["HS_ADMIN_MULTISIG", "HS_CONFIG_TIMELOCK", "HS_TREASURY"].includes(
              k,
            ),
        )
        .map((k) => [k, getAddress(process.env[k])]),
    );
    for (const [name, address] of Object.entries({ ...addresses, HSX })) {
      if ((await provider.getCode(address)) === "0x")
        throw Error(`${name}: no deployed code`);
    }
    const timelock = new Contract(
      addresses.HS_CONFIG_TIMELOCK,
      ["function getMinDelay() view returns(uint256)"],
      provider,
    );
    if ((await timelock.getMinDelay()) < 172800n)
      throw Error("Configuration timelock must be at least 48 hours");
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
    return {
      provider,
      addresses,
      signers,
      hsxSupply,
      collateralDecimals,
      review,
    };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

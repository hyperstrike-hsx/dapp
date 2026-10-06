import {
  BrowserProvider,
  Contract,
  parseUnits,
  type Eip1193Provider,
} from "ethers";
import {
  marketKey,
  type MarketDefinition,
  type Expiry,
} from "@hyperstrike/market-types";
import { API_ENABLED } from "./dataMode";
const env: Partial<ImportMetaEnv> = API_ENABLED ? import.meta.env : {};
export const nativeConfig = {
  factory: env.VITE_NATIVE_FACTORY_ADDRESS as string | undefined,
  minter: env.VITE_STRIKE_MINTER_ADDRESS as string | undefined,
  strike: env.VITE_STRIKE_ADDRESS as string | undefined,
  collateral: env.VITE_COLLATERAL_ADDRESS as string | undefined,
  feeVault: env.VITE_FEE_VAULT_ADDRESS as string | undefined,
};
export async function signer() {
  const ethereum = (window as unknown as { ethereum?: Eip1193Provider })
    .ethereum;
  if (!ethereum) throw new Error("Connect an EVM wallet to continue");
  const p = new BrowserProvider(ethereum);
  await p.send("eth_requestAccounts", []);
  if ((await p.getNetwork()).chainId !== 999n) {
    await p.send("wallet_switchEthereumChain", [{ chainId: "0x3e7" }]);
    return new BrowserProvider(ethereum).getSigner();
  }
  return p.getSigner();
}
async function approve(
  token: string,
  spender: string,
  amount: bigint,
  s: Awaited<ReturnType<typeof signer>>,
) {
  const c = new Contract(
    token,
    [
      "function allowance(address,address) view returns(uint256)",
      "function approve(address,uint256) returns(bool)",
    ],
    s,
  );
  if ((await c.allowance(await s.getAddress(), spender)) < amount) {
    const t = await c.approve(spender, amount);
    await t.wait();
  }
}
export async function createNativeMarket(
  d: MarketDefinition,
  expiry: Expiry,
  seed: string,
) {
  if (!nativeConfig.factory || !nativeConfig.strike || !nativeConfig.collateral)
    throw new Error("Native deployment is not configured");
  const s = await signer();
  const token = new Contract(
    nativeConfig.collateral,
    ["function decimals() view returns(uint8)"],
    s,
  );
  const amount = parseUnits(seed, Number(await token.decimals()));
  await approve(nativeConfig.strike, nativeConfig.factory, 10n ** 18n, s);
  await approve(nativeConfig.collateral, nativeConfig.factory, amount, s);
  const c = new Contract(
    nativeConfig.factory,
    [
      "function create((uint8 template,bytes32 indexId,uint8 direction,int192 thresholdE8,uint64 creationReferenceTime,uint192 creationReferenceValueE8,uint64 tradeCloseTime,uint64 resolutionTime,bytes32 settlementPolicyId),uint8,uint256) returns(address)",
    ],
    s,
  );
  const tx = await c.create(
    {
      ...d,
      template: d.template === "LEVEL" ? 0 : 1,
      direction: d.direction === "UP" ? 0 : 1,
    },
    ["DAILY", "WEEKLY", "MONTHLY"].indexOf(expiry),
    amount,
  );
  await tx.wait();
  return tx.hash as string;
}
export async function tradeNative(
  address: string,
  side: "YES" | "NO",
  action: "BUY" | "SELL",
  amount: string,
  minOut: bigint,
  deadline: number,
) {
  if (!nativeConfig.collateral) throw new Error("Collateral is not configured");
  const s = await signer();
  const token = new Contract(
    nativeConfig.collateral,
    ["function decimals() view returns(uint8)"],
    s,
  );
  const value = parseUnits(amount, Number(await token.decimals()));
  if (action === "BUY")
    await approve(nativeConfig.collateral, address, value, s);
  const c = new Contract(
    address,
    [
      "function buy(uint8,uint256,uint256,uint64) returns(uint256)",
      "function sell(uint8,uint256,uint256,uint64) returns(uint256)",
    ],
    s,
  );
  const tx = await c[action === "BUY" ? "buy" : "sell"](
    side === "YES" ? 0 : 1,
    value,
    minOut,
    deadline,
  );
  await tx.wait();
  return tx.hash as string;
}
export async function mintNativeStrike(
  amount: bigint,
  hsxMax: bigint,
  hypeMax: bigint,
  deadline: number,
) {
  if (!nativeConfig.minter) throw Error("STRIKE minter is not configured");
  const s = await signer();
  const c = new Contract(
    nativeConfig.minter,
    [
      "function quote(uint256) view returns(uint256,uint256,uint64)",
      "function mintStrike(uint256,uint256,uint256,uint64) payable",
    ],
    s,
  );
  const q = await c.quote(amount);
  if (q[0] > hsxMax || q[1] > hypeMax)
    throw Error("Mint quote exceeded your reviewed maximum");
  await approve(
    "0xab5dbc5a6070d066697d8e55471877ea4343ece3",
    nativeConfig.minter,
    hsxMax,
    s,
  );
  // Exact HYPE value is quoted after approval; movement can revert, never silently overpay.
  const refreshed = await c.quote(amount);
  if (refreshed[0] > hsxMax || refreshed[1] > hypeMax)
    throw Error("Quote moved. Review a fresh quote.");
  const tx = await c.mintStrike(amount, hsxMax, hypeMax, deadline, {
    value: refreshed[1],
  });
  await tx.wait();
  return tx.hash as string;
}
export async function readNativeMarket(
  address: string,
  definition: MarketDefinition,
) {
  if (!nativeConfig.factory) throw Error("Native factory is not configured");
  const ethereum = (window as unknown as { ethereum?: Eip1193Provider })
    .ethereum;
  if (!ethereum)
    throw Error("Connect a HyperEVM wallet to read the live market");
  const provider = new BrowserProvider(ethereum);
  if ((await provider.getNetwork()).chainId !== 999n)
    throw Error("Switch your wallet to HyperEVM");
  const factory = new Contract(
    nativeConfig.factory,
    ["function markets(bytes32) view returns(address)"],
    provider,
  );
  if (
    (await factory.markets(marketKey(definition))).toLowerCase() !==
    address.toLowerCase()
  )
    throw Error("Market does not match the canonical factory registry");
  const market = new Contract(
    address,
    [
      "function reserve(uint256) view returns(uint256)",
      "function state() view returns(uint8)",
      "function creator() view returns(address)",
      "function collateral() view returns(address)",
      "function balanceOf(address,uint8) view returns(uint256)",
      "function quoteBuy(uint8,uint256) view returns(uint256 tokens,uint256 net,uint256 fee)",
      "function quoteSell(uint8,uint256) view returns(uint256 output,uint256 merged,uint256 fee)",
      "function lockedCollateral() view returns(uint256)",
    ],
    provider,
  );
  const collateral = await market.collateral();
  if (collateral.toLowerCase() !== nativeConfig.collateral?.toLowerCase())
    throw Error("Unexpected collateral token");
  const token = new Contract(
    collateral,
    [
      "function decimals() view returns(uint8)",
      "function symbol() view returns(string)",
    ],
    provider,
  );
  return {
    market,
    decimals: Number(await token.decimals()),
    symbol: (await token.symbol()) as string,
    state: Number(await market.state()),
    collateral,
  };
}
export async function redeemNative(address: string) {
  const s = await signer();
  const c = new Contract(address, ["function redeem() returns(uint256)"], s);
  const tx = await c.redeem();
  await tx.wait();
  return tx.hash as string;
}

import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { BrowserProvider, Contract, ZeroAddress, parseUnits } from "ethers";
import { HSX_ADDRESS } from "./hsx";
import { outcomeAssetId, outcomeCoin } from "./hip4";
import type { VoteSide } from "./types";

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

const GATE_ADDRESS = import.meta.env.VITE_HSX_BURN_GATE_ADDRESS as string | undefined;
const HYPEREVM_CHAIN_ID = "0x3e7";
const GATE_ABI = [
  "function burnToParticipate(uint64 outcomeId, bytes32 orderId, uint256 orderValueE18)",
  "function participationBurnedBy(bytes32 orderId) view returns (address)",
  "function isOutcomeBound(uint64 outcomeId) view returns (bool)",
] as const;
const HSX_APPROVAL_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export type LiveOutcomeOrder = {
  outcomeId: number;
  sideIndex: 0 | 1;
  contracts: number;
  limitPrice: number;
  orderValue: number;
  orderId: `0x${string}`;
};

export type LiveOrderReceipt = {
  wallet: string;
  approvalTransaction?: string;
  burnTransaction?: string;
  orderId: string;
  status: string;
};

const liveTradingConfigured = Boolean(GATE_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(GATE_ADDRESS));

export type LiveOrderDraft = {
  wallet: string | null;
  outcomeId: number;
  marketName: string;
  side: VoteSide;
  contracts: number;
  limitPrice: number;
  orderValue: number;
  nonce: string;
};

export function configuredBurnGateAddress(): string | null {
  return liveTradingConfigured && GATE_ADDRESS ? GATE_ADDRESS : null;
}

export async function connectHyperliquidWallet(): Promise<string> {
  if (!window.ethereum) throw new Error("No injected wallet found. Install a browser wallet that supports EIP-712 signing.");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  return (await provider.getSigner()).getAddress();
}

async function switchToHyperEvm(provider: BrowserProvider) {
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: HYPEREVM_CHAIN_ID }]);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) throw error;
    await provider.send("wallet_addEthereumChain", [{
      chainId: HYPEREVM_CHAIN_ID,
      chainName: "HyperEVM",
      nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
      rpcUrls: ["https://rpc.hyperliquid.xyz/evm"],
      blockExplorerUrls: ["https://hyperevmscan.io"],
    }]);
  }
}

function compactDecimal(value: number, decimals = 6): string {
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function burnAmountForOrderValue(orderValue: number): bigint {
  return parseUnits(orderValue.toFixed(6), 18) / 100n;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Live order failed.");
}

export async function deriveOrderId(draft: LiveOrderDraft): Promise<`0x${string}`> {
  const payload = JSON.stringify({
    app: "hyperstrike-live-order-v1",
    wallet: draft.wallet?.toLowerCase() ?? "not-connected",
    outcomeId: draft.outcomeId,
    marketName: draft.marketName,
    side: draft.side,
    contracts: draft.contracts,
    limitPrice: compactDecimal(draft.limitPrice),
    orderValue: compactDecimal(draft.orderValue),
    nonce: draft.nonce,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type BookLevel = { px?: string; p?: string; sz?: string; s?: string };

async function preflightOutcomeLiquidity(order: LiveOutcomeOrder): Promise<void> {
  const coin = outcomeCoin(order.outcomeId, order.sideIndex);
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
  });
  if (!response.ok) throw new Error(`HIP-4 order-book preflight failed: ${response.status}`);
  const book = await response.json() as { levels?: [BookLevel[], BookLevel[]] };
  const asks = book.levels?.[1] ?? [];
  const fillableSize = asks.reduce((sum, level) => {
    const price = Number(level.px ?? level.p);
    const size = Number(level.sz ?? level.s);
    return Number.isFinite(price) && Number.isFinite(size) && price <= order.limitPrice ? sum + size : sum;
  }, 0);
  if (fillableSize <= 0) {
    throw new Error(`No visible ${coin} ask is fillable at ${compactDecimal(order.limitPrice)}. Raise the IOC limit or wait for liquidity.`);
  }
}

export async function placeLiveOutcomeOrder(order: LiveOutcomeOrder): Promise<LiveOrderReceipt> {
  if (!liveTradingConfigured || !GATE_ADDRESS) throw new Error("The production HSX burn gate address is not configured.");
  if (!window.ethereum) throw new Error("No injected wallet found.");
  if (!Number.isInteger(order.contracts) || order.contracts < 1) throw new Error("At least one kicked contract is required.");
  if (!(order.limitPrice > 0 && order.limitPrice < 1)) throw new Error("The IOC limit must be between 0 and 1 USDC.");
  await preflightOutcomeLiquidity(order);

  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  await switchToHyperEvm(provider);
  const signer = await provider.getSigner();
  const wallet = await signer.getAddress();
  const gate = new Contract(GATE_ADDRESS, GATE_ABI, signer);
  const isOutcomeBound = Boolean(await gate.isOutcomeBound(order.outcomeId));
  if (!isOutcomeBound) {
    throw new Error(`HIP-4 outcome #${order.outcomeId} is not bound in the HyperStrike burn gate yet.`);
  }
  const burnedBy = String(await gate.participationBurnedBy(order.orderId));
  const burnAmount = burnAmountForOrderValue(order.orderValue);
  let burnTransaction: string | undefined;
  let approvalTransaction: string | undefined;

  if (burnedBy === ZeroAddress) {
    const token = new Contract(HSX_ADDRESS, HSX_APPROVAL_ABI, signer);
    const allowance = await token.allowance(wallet, GATE_ADDRESS) as bigint;
    if (allowance < burnAmount) {
      const approval = await token.approve(GATE_ADDRESS, burnAmount);
      approvalTransaction = approval.hash as string;
      await approval.wait();
    }
    const orderValueE18 = parseUnits(order.orderValue.toFixed(6), 18);
    const transaction = await gate.burnToParticipate(order.outcomeId, order.orderId, orderValueE18);
    burnTransaction = transaction.hash as string;
    await transaction.wait();
  } else if (burnedBy.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error("This order receipt belongs to a different wallet.");
  }

  const client = new ExchangeClient({
    transport: new HttpTransport({ isTestnet: false }),
    wallet: signer,
    defaultExpiresAfter: () => Date.now() + 60_000,
  });
  const cloid = `0x${order.orderId.slice(2, 34)}` as `0x${string}`;
  const response = await client.order({
    orders: [{
      a: outcomeAssetId(order.outcomeId, order.sideIndex),
      b: true,
      p: compactDecimal(order.limitPrice),
      s: String(order.contracts),
      r: false,
      t: { limit: { tif: "Ioc" } },
      c: cloid,
    }],
    grouping: "na",
  });
  const outcome = response.response.data.statuses[0];
  if (typeof outcome === "object" && outcome !== null && "error" in outcome) {
    throw new Error(`HIP-4 order rejected after burn: ${String(outcome.error)}`);
  }
  const status = typeof outcome === "string"
    ? outcome.toUpperCase()
    : "filled" in outcome
      ? `FILLED ${outcome.filled.totalSz} @ ${outcome.filled.avgPx}`
      : "resting" in outcome
        ? `RESTING #${outcome.resting.oid}`
        : "SUBMITTED";
  return { wallet, approvalTransaction, burnTransaction, orderId: order.orderId, status };
}

export function liveOrderErrorMessage(error: unknown): string {
  const message = normalizeError(error).message;
  if (/user rejected|denied|rejected request/i.test(message)) return "Wallet signature rejected. No further action was taken unless a prior approval or burn was already confirmed.";
  if (/insufficient/i.test(message)) return `${message} Check both HyperEVM gas/$HSX and HyperCore USDC before retrying.`;
  return message;
}

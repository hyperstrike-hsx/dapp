export const HSX_ADDRESS = "0xab5dbc5a6070d066697d8e55471877ea4343ece3" as const;
const RPC_URL = "https://rpc.hyperliquid.xyz/evm";
const HYPEREVM_CHAIN_ID = "0x3e7";
const HSX_BURN_ABI = ["function burn(uint256 amount)", "function decimals() view returns (uint8)"] as const;

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

export type HsxStatus = {
  online: boolean;
  address: typeof HSX_ADDRESS;
  decimals: number;
  totalSupply: bigint;
  supportsBurn: boolean;
  supportsBurnFrom: boolean;
};

async function rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`HyperEVM RPC request failed: ${response.status}`);
  const payload = await response.json() as { result?: T; error?: { message: string } };
  if (payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? "Missing RPC result");
  return payload.result;
}

export async function fetchHsxStatus(signal?: AbortSignal): Promise<HsxStatus> {
  const [decimalsHex, supplyHex, code] = await Promise.all([
    rpc<string>("eth_call", [{ to: HSX_ADDRESS, data: "0x313ce567" }, "latest"], signal),
    rpc<string>("eth_call", [{ to: HSX_ADDRESS, data: "0x18160ddd" }, "latest"], signal),
    rpc<string>("eth_getCode", [HSX_ADDRESS, "latest"], signal),
  ]);
  const normalizedCode = code.toLowerCase();
  return {
    online: true,
    address: HSX_ADDRESS,
    decimals: Number(BigInt(decimalsHex)),
    totalSupply: BigInt(supplyHex),
    supportsBurn: normalizedCode.includes("42966c68"),
    supportsBurnFrom: normalizedCode.includes("79cc6790"),
  };
}

export function formatSupply(status: HsxStatus): string {
  const whole = status.totalSupply / (10n ** BigInt(status.decimals));
  return whole >= 1_000_000_000n ? `${Number(whole) / 1_000_000_000}B` : Number(whole).toLocaleString();
}

export type ManualBurnReceipt = { wallet: string; transactionHash: string; amount: string };

export async function burnHsx(amount: string): Promise<ManualBurnReceipt> {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a positive $HSX amount.");
  const { BrowserProvider, Contract, parseUnits } = await import("ethers");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: HYPEREVM_CHAIN_ID }]);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) throw error;
    await provider.send("wallet_addEthereumChain", [{
      chainId: HYPEREVM_CHAIN_ID,
      chainName: "HyperEVM",
      nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
      rpcUrls: [RPC_URL],
      blockExplorerUrls: ["https://hyperevmscan.io"],
    }]);
  }
  const signer = await provider.getSigner();
  const token = new Contract(HSX_ADDRESS, HSX_BURN_ABI, signer);
  const decimals = Number(await token.decimals());
  const transaction = await token.burn(parseUnits(amount, decimals));
  await transaction.wait();
  return { wallet: await signer.getAddress(), transactionHash: transaction.hash as string, amount };
}

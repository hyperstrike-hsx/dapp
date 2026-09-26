export * from "@hyperstrike/market-types";
export const WAD = 10n ** 18n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** Integral evaluated once, rounding cost up. Supply/quantity/cost use 18 decimals. */
export function integratedCost(
  supply: bigint,
  quantity: bigint,
  min: bigint,
  max: bigint,
  target: bigint,
): bigint {
  if (supply < 0n || quantity <= 0n || target <= 0n || max < min || min < 0n)
    throw new Error("Invalid curve input");
  const end = supply + quantity;
  const a = supply < target ? supply : target,
    b = end < target ? end : target;
  const numerator =
    min * (b - a) * 3n * target * target +
    (max - min) * (b * b * b - a * a * a);
  return (
    ceil(numerator, 3n * target * target * WAD) +
    ceil(max * (end - b - (supply - a)), WAD)
  );
}
export function mintQuote(supply: bigint, quantity: bigint, hsxUsdE8: bigint) {
  if (hsxUsdE8 <= 0n) throw new Error("Safe HSX/USD reference required");
  const usdE18 = integratedCost(
    supply,
    quantity,
    20n * WAD,
    100n * WAD,
    10_000n * WAD,
  );
  return {
    hsxIn: ceil(usdE18 * 100_000_000n, hsxUsdE8),
    hypeIn: integratedCost(supply, quantity, WAD / 2n, 3n * WAD, 10_000n * WAD),
    usdE18,
  };
}
// Complete-set collateral enters BOTH reserves before the selected side is paid out.
export function quoteBuy(
  yes: bigint,
  no: bigint,
  side: "YES" | "NO",
  gross: bigint,
  feeBps = 20n,
) {
  if (yes <= 0n || no <= 0n || gross <= 0n)
    throw new Error("Insufficient liquidity");
  const fee = ceil(gross * feeBps, 10_000n),
    net = gross - fee;
  const own = side === "YES" ? yes : no,
    other = side === "YES" ? no : yes;
  const remaining = ceil(own * other, other + net),
    tokens = own + net - remaining;
  if (tokens <= 0n) throw new Error("Zero output");
  return {
    tokens,
    fee,
    net,
    yes: side === "YES" ? remaining : yes + net,
    no: side === "NO" ? remaining : no + net,
  };
}
export function quoteSell(
  yes: bigint,
  no: bigint,
  side: "YES" | "NO",
  tokens: bigint,
  feeBps = 20n,
) {
  if (yes <= 0n || no <= 0n || tokens <= 0n)
    throw new Error("Insufficient liquidity");
  const own = side === "YES" ? yes : no,
    other = side === "YES" ? no : yes,
    k = own * other;
  let lo = 0n,
    hi = (own + tokens < other ? own + tokens : other) - 1n;
  while (lo < hi) {
    const m = (lo + hi + 1n) / 2n;
    if ((own + tokens - m) * (other - m) >= k) lo = m;
    else hi = m - 1n;
  }
  const fee = ceil(lo * feeBps, 10_000n),
    collateral = lo - fee;
  if (collateral <= 0n) throw new Error("Zero output");
  return {
    collateral,
    fee,
    merged: lo,
    yes: side === "YES" ? own + tokens - lo : other - lo,
    no: side === "NO" ? own + tokens - lo : other - lo,
  };
}

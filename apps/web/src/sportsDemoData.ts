import type { Hip4Outcome } from "./hip4";
import type { DemoWorldCupPrediction, VoteSide } from "./types";

export const SPORTS_DEMO_KEY = "hyperstrike.demoWorldCupPredictions.v1";
export const sportsDemoMarkets: Hip4Outcome[] = [
  "France",
  "Argentina",
  "Brazil",
  "England",
].map((name, i) => ({
  outcome: 90001 + i,
  name,
  description: `World Cup replay: ${name} lifts the trophy. Fictional demonstration, not an active market.`,
  sideSpecs: [{ name: "Yes" }, { name: "No" }],
  quoteToken: "DEMO USD",
}));
export const sportsDemoPrices: Record<number, Record<VoteSide, number>> = {
  90001: { YES: 0.52, NO: 0.48 },
  90002: { YES: 0.38, NO: 0.62 },
  90003: { YES: 0.34, NO: 0.66 },
  90004: { YES: 0.27, NO: 0.73 },
};
export function createSportsReceipt(
  outcomeId: number,
  side: VoteSide,
  contracts: number,
): DemoWorldCupPrediction {
  const market = sportsDemoMarkets.find((m) => m.outcome === outcomeId);
  if (
    !market ||
    !["YES", "NO"].includes(side) ||
    !Number.isSafeInteger(contracts) ||
    contracts < 1
  )
    throw Error("Invalid demo ticket");
  const orderId = crypto.randomUUID();
  const limitPrice = sportsDemoPrices[outcomeId][side];
  return {
    id: `${outcomeId}-${orderId}`,
    orderId,
    outcomeId,
    marketName: market.name,
    description: market.description,
    side,
    contracts,
    limitPrice,
    orderValue: Math.round(contracts * limitPrice * 100) / 100,
    burnAmount: 0,
    status: "SAVED",
    createdAt: Date.now(),
  };
}
export function readSportsReceipts(): DemoWorldCupPrediction[] {
  const data = JSON.parse(localStorage.getItem(SPORTS_DEMO_KEY) ?? "[]");
  if (!Array.isArray(data))
    throw Error(
      "Stored sports receipts are not a list. Export your historical archive before saving new receipts.",
    );
  return data;
}

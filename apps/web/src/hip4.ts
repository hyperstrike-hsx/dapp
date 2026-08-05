export type Hip4Outcome = {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: Array<{ name: string }>;
  quoteToken: string;
};

export type Hip4Question = {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes: number[];
};

export type Hip4Status = {
  online: boolean;
  outcomeCount: number;
  questionCount: number;
  binaryCount: number;
  quoteTokens: string[];
  outcomes: Hip4Outcome[];
  questions: Hip4Question[];
  mids: Record<string, string>;
  checkedAt: number;
};

const ALLOWED_QUOTES = new Set(["USDC", "USDH"]);

export function parseOutcomeMeta(input: unknown): Hip4Outcome[] {
  if (typeof input !== "object" || input === null || !("outcomes" in input)) return [];
  const outcomes = (input as { outcomes?: unknown }).outcomes;
  if (!Array.isArray(outcomes)) return [];

  return outcomes.filter((value): value is Hip4Outcome => {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Partial<Hip4Outcome>;
    return (
      Number.isInteger(item.outcome) &&
      typeof item.name === "string" &&
      typeof item.description === "string" &&
      typeof item.quoteToken === "string" &&
      ALLOWED_QUOTES.has(item.quoteToken) &&
      Array.isArray(item.sideSpecs) &&
      item.sideSpecs.every((side) => side && typeof side.name === "string")
    );
  });
}

export function parseOutcomeQuestions(input: unknown, outcomeIds?: Set<number>): Hip4Question[] {
  if (typeof input !== "object" || input === null || !("questions" in input)) return [];
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter((value): value is Hip4Question => {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Partial<Hip4Question>;
    const validIds = Number.isInteger(item.fallbackOutcome) &&
      Array.isArray(item.namedOutcomes) && item.namedOutcomes.every(Number.isInteger) &&
      Array.isArray(item.settledNamedOutcomes) && item.settledNamedOutcomes.every(Number.isInteger);
    if (!Number.isInteger(item.question) || typeof item.name !== "string" || typeof item.description !== "string" || !validIds) return false;
    if (!outcomeIds) return true;
    return outcomeIds.has(item.fallbackOutcome!) && item.namedOutcomes!.every((id) => outcomeIds.has(id));
  });
}

export function isBinaryYesNo(outcome: Hip4Outcome): boolean {
  return outcome.sideSpecs.length === 2 && outcome.sideSpecs[0]?.name === "Yes" && outcome.sideSpecs[1]?.name === "No";
}

export function isWorldCupChampion(outcome: Hip4Outcome): boolean {
  return isBinaryYesNo(outcome) && /2026 FIFA World Cup champion/i.test(outcome.description);
}

export function hasActiveOutcomeMarket(outcome: Hip4Outcome, mids: Record<string, string>, settlementBand = 0.005): boolean {
  const yes = Number(mids[outcomeCoin(outcome.outcome, 0)]);
  const no = Number(mids[outcomeCoin(outcome.outcome, 1)]);
  return (
    Number.isFinite(yes) && Number.isFinite(no) &&
    yes > settlementBand && yes < 1 - settlementBand &&
    no > settlementBand && no < 1 - settlementBand
  );
}

export function outcomeCoin(outcomeId: number, sideIndex: 0 | 1): `#${number}` {
  return `#${outcomeId * 10 + sideIndex}`;
}

export function outcomeAssetId(outcomeId: number, sideIndex: 0 | 1): number {
  return 100_000_000 + outcomeId * 10 + sideIndex;
}

export async function fetchHip4Status(signal?: AbortSignal): Promise<Hip4Status> {
  const request = (type: string) => fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
    signal,
  });
  const [metaResponse, midsResponse] = await Promise.all([request("outcomeMeta"), request("allMids")]);
  if (!metaResponse.ok) throw new Error(`HIP-4 metadata request failed: ${metaResponse.status}`);
  if (!midsResponse.ok) throw new Error(`HIP-4 mids request failed: ${midsResponse.status}`);
  const rawMeta: unknown = await metaResponse.json();
  const outcomes = parseOutcomeMeta(rawMeta);
  const questions = parseOutcomeQuestions(rawMeta, new Set(outcomes.map((outcome) => outcome.outcome)));
  const rawMids: unknown = await midsResponse.json();
  const mids = typeof rawMids === "object" && rawMids !== null
    ? Object.fromEntries(Object.entries(rawMids).filter(([coin, value]) => coin.startsWith("#") && typeof value === "string"))
    : {};
  return {
    online: true,
    outcomeCount: outcomes.length,
    questionCount: questions.length,
    binaryCount: outcomes.filter(isBinaryYesNo).length,
    quoteTokens: [...new Set(outcomes.map((outcome) => outcome.quoteToken))],
    outcomes,
    questions,
    mids,
    checkedAt: Date.now(),
  };
}

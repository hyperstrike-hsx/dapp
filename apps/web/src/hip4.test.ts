import { describe, expect, it } from "vitest";
import { hasActiveOutcomeMarket, isBinaryYesNo, isWorldCupChampion, outcomeAssetId, outcomeCoin, parseOutcomeMeta, parseOutcomeQuestions } from "./hip4";

describe("HIP-4 metadata parser", () => {
  it("accepts supported outcome metadata", () => {
    const [market] = parseOutcomeMeta({
      outcomes: [{ outcome: 12, name: "Test", description: "Terms", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" }],
    });
    expect(market?.outcome).toBe(12);
    expect(market && isBinaryYesNo(market)).toBe(true);
  });

  it("rejects unknown quote tokens", () => {
    expect(parseOutcomeMeta({
      outcomes: [{ outcome: 12, name: "Test", description: "Terms", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "UNKNOWN" }],
    })).toEqual([]);
  });

  it("distinguishes named-side markets", () => {
    const [market] = parseOutcomeMeta({
      outcomes: [{ outcome: 14, name: "Final", description: "Terms", sideSpecs: [{ name: "Alpha" }, { name: "Bravo" }], quoteToken: "USDH" }],
    });
    expect(market && isBinaryYesNo(market)).toBe(false);
  });

  it("derives official HIP-4 outcome coins and asset IDs", () => {
    expect(outcomeCoin(173, 0)).toBe("#1730");
    expect(outcomeCoin(173, 1)).toBe("#1731");
    expect(outcomeAssetId(173, 0)).toBe(100001730);
  });

  it("selects binary 2026 World Cup champion outcomes", () => {
    const [market] = parseOutcomeMeta({
      outcomes: [{ outcome: 173, name: "Argentina", description: "This outcome resolves to Yes if Argentina is officially declared the 2026 FIFA World Cup champion.", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" }],
    });
    expect(market && isWorldCupChampion(market)).toBe(true);
  });

  it("keeps live two-sided outcomes and removes economically settled markets", () => {
    const [market] = parseOutcomeMeta({
      outcomes: [{ outcome: 173, name: "Argentina", description: "Terms", sideSpecs: [{ name: "Yes" }, { name: "No" }], quoteToken: "USDC" }],
    });
    expect(market && hasActiveOutcomeMarket(market, { "#1730": "0.18", "#1731": "0.82" })).toBe(true);
    expect(market && hasActiveOutcomeMarket(market, { "#1730": "0.001", "#1731": "0.999" })).toBe(false);
    expect(market && hasActiveOutcomeMarket(market, { "#1730": "0.18" })).toBe(false);
  });

  it("accepts complete permissionless multi-outcome questions", () => {
    expect(parseOutcomeQuestions({ questions: [{ question: 166, name: "Range", description: "class:priceBucket", fallbackOutcome: 13, namedOutcomes: [14, 15], settledNamedOutcomes: [] }] }, new Set([13, 14, 15]))).toHaveLength(1);
  });

  it("rejects questions with missing outcome references", () => {
    expect(parseOutcomeQuestions({ questions: [{ question: 166, name: "Range", description: "class:priceBucket", fallbackOutcome: 13, namedOutcomes: [14, 99], settledNamedOutcomes: [] }] }, new Set([13, 14, 15]))).toEqual([]);
  });
});

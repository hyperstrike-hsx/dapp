import { describe, it, expect } from "vitest";
import { id } from "ethers";
import { INDEXES } from "@hyperstrike/market-types";
import { validateBasket } from "./indexer-engine";
const providers = [
  {
    id: "a",
    origin: "https://venue-a.example",
    path: "/quote",
    instrumentParam: "id",
  },
  {
    id: "b",
    origin: "https://venue-b.example",
    path: "/quote",
    instrumentParam: "id",
  },
];
const basket = () => ({
  indexId: INDEXES.find((i) => i.ticker === "HS-GLOVE10")!.indexId,
  versionId: id("test-only-version"),
  approvedAt: 100,
  activatesAt: 100 + 7 * 86400,
  divisorE8: "100000000000",
  constituents: Array.from({ length: 10 }, (_, i) => ({
    constituentId: `test-only-${i}`,
    weightE18: "100000000000000000",
    basePriceE8: "100000000",
    family: `family-${Math.floor(i / 2)}`,
    finish: `finish-${i}`,
    sleeve: "gloves",
    eligibility: {
      sources: 2,
      uptimeBps: 9800,
      spreadBps: 200,
      historyDays: 30,
      integrityFlag: false,
      ageDays: 120,
      liquidityBps: 9000,
      agreementBps: 9500,
    },
    mappings: [
      { providerId: "a", instrument: `a-${i}` },
      { providerId: "b", instrument: `b-${i}` },
    ],
  })),
});
describe("approved basket validation", () => {
  it("accepts a correctly gated equal-weight diversified fixture", () =>
    expect(() => validateBasket(basket(), providers)).not.toThrow());
  it("rejects missing history, concentrated families, duplicate identity and short notice", () => {
    const history = basket();
    history.constituents[0].eligibility.historyDays = 29;
    expect(() => validateBasket(history, providers)).toThrow("Ineligible");
    const concentrated = basket();
    concentrated.constituents[2].family = "family-0";
    expect(() => validateBasket(concentrated, providers)).toThrow(
      "concentration",
    );
    const duplicate = basket();
    duplicate.constituents[0].constituentId =
      duplicate.constituents[1].constituentId;
    expect(() => validateBasket(duplicate, providers)).toThrow("Duplicate");
    const notice = basket();
    notice.approvedAt++;
    expect(() => validateBasket(notice, providers)).toThrow("seven-day");
  });
});

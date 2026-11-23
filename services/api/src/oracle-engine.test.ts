import { describe, it, expect } from "vitest";
import { readVenues, usdE8, extractPayload, VENUE_IDS } from "./venues";
import {
  buildCandidates,
  parseSalesTape,
  selectGenesis,
  classify,
  METHODOLOGY,
  METHODOLOGY_HASH,
  RULES,
  freezeStage,
  type GenesisConfig,
} from "./genesis";
import {
  INDEX_BASE_AT,
  INDEX_HISTORY_FLOOR_AT,
  isPreview,
} from "@hyperstrike/market-types";
import {
  basketRoot,
  buildInput,
  candidateOf,
  genesisNames,
  observationsOf,
  verifyCandidate,
} from "./oracle-engine";
import { refreshComposite, thin } from "./composite-feed";

const NOW = 1_800_000_000;
const weapons = ["AK-47", "M4A4", "AWP", "USP-S", "Glock-18", "Desert Eagle"];
const catalogue: { name: string; usd: number; units: number }[] = [
  ...Array.from({ length: 30 }, (_, i) => ({
    name: `★ Knife${i % 10} | Finish${i} (Factory New)`,
    usd: 200 + i,
    units: 100 - i,
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `★ Sport${i % 5} Gloves | Glove${i} (Field-Tested)`,
    usd: 150 + i,
    units: 90 - i,
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    name: `${weapons[i % 6]} | Common${i} (Field-Tested)`,
    usd: 20 + i,
    units: 400 - i,
  })),
  ...Array.from({ length: 24 }, (_, i) => ({
    name: `${weapons[i % 6]} | Rare${i} (Factory New)`,
    usd: 300 + i,
    units: 60 - i,
  })),
  ...Array.from({ length: 22 }, (_, i) => ({
    name: `Vault${i} Case`,
    usd: 2 + i / 10,
    units: 5000 - i,
  })),
];
/** Five venues in their real wire formats. `skew` moves one venue; `down` takes venues offline. */
function market(
  options: {
    factor?: number;
    skew?: Record<string, number>;
    down?: string[];
    time?: number;
  } = {},
) {
  const { factor = 1, skew = {}, down = [], time = NOW } = options;
  const px = (venue: string, usd: number) =>
    Math.round(usd * factor * (skew[venue] ?? 1) * 100) / 100;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body));
    const off = (venue: string) => down.includes(venue);
    if (url.includes("skinport.com/v1/items"))
      return off("skinport")
        ? new Response("", { status: 503 })
        : json(
            catalogue.map((c) => ({
              market_hash_name: c.name,
              version: null,
              currency: "USD",
              min_price: px("skinport", c.usd),
              quantity: 40,
              created_at: time - 400 * 86400,
              updated_at: time - 30,
            })),
          );
    if (url.includes("skinport.com/v1/sales/history"))
      return json(
        catalogue.map((c) => ({
          market_hash_name: c.name,
          version: null,
          currency: "USD",
          last_30_days: { median: c.usd, volume: c.units },
        })),
      );
    if (url.includes("market.csgo.com/api/v2/prices/orders"))
      return json({
        success: true,
        currency: "USD",
        items: catalogue.map((c) => ({
          market_hash_name: c.name,
          price: px("marketcsgo", c.usd) * 0.97,
          volume: 10,
        })),
      });
    if (url.includes("market.csgo.com/api/v2/prices/USD"))
      return off("marketcsgo")
        ? new Response("", { status: 500 })
        : json({
            success: true,
            time: time - 20,
            currency: "USD",
            items: catalogue.map((c) => ({
              market_hash_name: c.name,
              price: px("marketcsgo", c.usd).toFixed(3),
              volume: 30,
            })),
          });
    if (url.includes("dmarket.com")) {
      if (off("dmarket")) return new Response("", { status: 502 });
      const titles: string[] | undefined = JSON.parse(String(init!.body)).filter
        .titles;
      return json({
        aggregatedPrices: catalogue
          .filter((c) => !titles || titles.includes(c.name))
          .map((c) => ({
            title: c.name,
            offerBestPrice: {
              Currency: "USD",
              Amount: String(Math.round(px("dmarket", c.usd) * 100)),
            },
            offerCount: "25",
            orderBestPrice: {
              Currency: "USD",
              Amount: String(Math.round(px("dmarket", c.usd) * 96)),
            },
            orderCount: "12",
          })),
        nextCursor: "",
      });
    }
    if (url.includes("waxpeer.com"))
      return off("waxpeer")
        ? new Response("", { status: 500 })
        : json({
            success: true,
            items: catalogue.map((c) => ({
              name: c.name,
              min: Math.round(px("waxpeer", c.usd) * 1000),
              count: 35,
            })),
          });
    if (url.includes("lis-skins.com"))
      return off("lisskins")
        ? new Response("", { status: 500 })
        : json(
            catalogue.map((c) => ({
              name: c.name,
              price: px("lisskins", c.usd),
              count: 50,
            })),
          );
    throw Error(`Unexpected request ${url}`);
  }) as typeof fetch;
}
async function genesis(
  options: Parameters<typeof market>[0] = {},
  at = NOW,
): Promise<GenesisConfig> {
  const request = market({ time: at, ...options });
  const { snapshots } = await readVenues(
    null,
    request,
    undefined,
    () => at * 1000,
  );
  const tape = parseSalesTape(
    await (await request("https://api.skinport.com/v1/sales/history")).json(),
  );
  const { candidates } = buildCandidates(snapshots, tape, at * 1000 + 5000);
  return {
    methodology: METHODOLOGY,
    methodologyHash: METHODOLOGY_HASH,
    generatedAt: at,
    venues: VENUE_IDS,
    rules: RULES,
    baskets: selectGenesis(candidates, at),
  };
}
const liveQuotes = async (config: GenesisConfig, request: typeof fetch) => {
  const names = genesisNames(config);
  const { snapshots } = await readVenues(
    names,
    request,
    undefined,
    () => NOW * 1000 + 100_000,
  );
  return observationsOf(snapshots, names);
};
const T = NOW + 300;

describe("venue adapters", () => {
  it("converts every wire format to exact E8 integers", async () => {
    expect(usdE8(126.89)).toBe(12_689_000_000n);
    expect(usdE8("9.855")).toBe(985_500_000n);
    expect(usdE8("abc")).toBe(0n);
    expect(usdE8(-1)).toBe(0n);
    const { snapshots, failures } = await readVenues(null, market());
    expect(failures).toEqual([]);
    expect(snapshots.map((s) => s.providerId)).toEqual(VENUE_IDS);
    const name = "Vault5 Case"; // $2.50
    for (const s of snapshots)
      expect(s.rows.get(name)!.askE8).toBe(250_000_000n);
    const dm = snapshots.find((s) => s.providerId === "dmarket")!.rows.get(name)!;
    expect(dm.bidE8).toBe(240_000_000n);
    expect(dm.askCount).toBe(25);
  });
  it("isolates a failing venue and commits only the basket rows", async () => {
    const { snapshots, failures } = await readVenues(
      ["Vault5 Case"],
      market({ down: ["waxpeer"] }),
    );
    expect(failures.map((f) => f.providerId)).toEqual(["waxpeer"]);
    expect(snapshots).toHaveLength(4);
    const payload = JSON.parse(extractPayload(snapshots[0], ["Vault5 Case"]));
    expect(payload.rows).toHaveLength(1);
    expect(payload.bodySha256).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("genesis basket selection", () => {
  it("classifies names and drops variants that are not fungible", () => {
    expect(classify("★ Karambit | Fade (Factory New)")).toMatchObject({
      kind: "knife",
      family: "Karambit",
      finish: "Fade",
    });
    expect(classify("★ Kukri Knife")).toMatchObject({ finish: "Vanilla" });
    expect(classify("★ Sport Gloves | Vice (Field-Tested)")!.kind).toBe("glove");
    expect(classify("CS:GO Weapon Case 2")!.kind).toBe("case");
    expect(classify("★ Karambit | Doppler (Factory New)")).toBeNull();
    expect(classify("StatTrak™ AK-47 | Redline (Field-Tested)")).toBeNull();
    expect(classify("Sticker | Crown (Foil)")).toBeNull();
  });
  it("is deterministic, diversified, and commits to its composition", async () => {
    const a = await genesis(),
      b = await genesis();
    expect(a.baskets).toEqual(b.baskets);
    expect(a.baskets.map((x) => x.constituents.length)).toEqual([
      50, 20, 10, 20, 20,
    ]);
    for (const basket of a.baskets) {
      expect(basketRoot(basket)).toBe(basket.compositionRoot);
      expect(
        basket.constituents.reduce((s, c) => s + BigInt(c.weightE18), 0n),
      ).toBe(10n ** 18n);
    }
    const knives = a.baskets[1].constituents;
    for (const c of knives)
      expect(
        knives.filter((k) => k.family === c.family).length,
      ).toBeLessThanOrEqual(2);
    // Highest traded volume first: Knife0 | Finish0 leads.
    expect(knives[0].constituentId).toBe("★ Knife0 | Finish0 (Factory New)");
  });
});

describe("index computation and independent signing", () => {
  it("starts at 1,000 and tracks a uniform move exactly", async () => {
    const config = await genesis();
    const flat = await liveQuotes(config, market());
    const up = await liveQuotes(config, market({ factor: 1.1 }));
    for (const basket of config.baskets) {
      // Integer division leaves at most one E8 unit of dust per constituent.
      expect(
        Number(candidateOf(basket, buildInput(basket, T, flat))!.valueE8) / 1e8,
      ).toBeCloseTo(1000, 5);
      const moved = candidateOf(basket, buildInput(basket, T, up))!;
      expect(Number(moved.valueE8) / 1e8).toBeCloseTo(1100, 0);
      expect(moved.confidenceBps).toBeGreaterThanOrEqual(9000);
      expect(moved.sequence).toBe(String(T / 300));
    }
  });
  it("one manipulated venue cannot move the index", async () => {
    const config = await genesis();
    const quotes = await liveQuotes(config, market({ skew: { waxpeer: 1.5 } }));
    const c = candidateOf(config.baskets[0], buildInput(config.baskets[0], T, quotes))!;
    expect(Number(c.valueE8) / 1e8).toBeCloseTo(1000, 5);
  });
  it("a venue outage cannot shift the level when venues price at different levels", async () => {
    // Skinport persistently 5% cheap, Market.CSGO 6% dear: typical of the real venues.
    const skew = { skinport: 0.95, marketcsgo: 1.06 };
    const config = await genesis({ skew });
    for (const down of [[], ["skinport"], ["marketcsgo"], ["skinport", "lisskins"]]) {
      const names = genesisNames(config);
      const { snapshots } = await readVenues(
        names,
        market({ skew, down }),
        undefined,
        () => NOW * 1000 + 100_000,
      );
      const quotes = observationsOf(snapshots, names);
      for (const basket of config.baskets)
        expect(
          Number(candidateOf(basket, buildInput(basket, T, quotes))!.valueE8) /
            1e8,
        ).toBeCloseTo(1000, 5);
    }
  });
  it("a signer accepts an honest proposal and refuses every tampered one", async () => {
    const config = await genesis();
    const basket = config.baskets[1];
    const proposerQuotes = await liveQuotes(config, market());
    const own = await liveQuotes(config, market({ factor: 1.002 }));
    const input = buildInput(basket, T, proposerQuotes);
    const candidate = candidateOf(basket, input)!;
    const now = T + 5;
    expect(
      verifyCandidate(config, candidate, input, own, now).gapBps,
    ).toBeLessThan(75);
    // Value changed after the fact.
    expect(() =>
      verifyCandidate(
        config,
        { ...candidate, valueE8: "100100000000" },
        input,
        own,
        now,
      ),
    ).toThrow("deterministic replay");
    // Self-consistent inputs that disagree with what the signer sees itself.
    const forgedQuotes = await liveQuotes(config, market({ factor: 1.05 }));
    const forgedInput = buildInput(basket, T, forgedQuotes);
    expect(() =>
      verifyCandidate(
        config,
        candidateOf(basket, forgedInput)!,
        forgedInput,
        own,
        now,
      ),
    ).toThrow("independently fetched");
    // Swapped composition, stale boundary, and no independent data.
    expect(() =>
      verifyCandidate(
        config,
        { ...candidate, indexId: config.baskets[2].indexId },
        input,
        own,
        now,
      ),
    ).toThrow("committed composition");
    expect(() =>
      verifyCandidate(config, candidate, input, own, T + 241),
    ).toThrow("publication window");
    expect(() => verifyCandidate(config, candidate, input, [], now)).toThrow(
      "no independent index value",
    );
  });
});

describe("published multi-venue feed", () => {
  it("continues history, survives two venues down, and refuses with fewer than three", async () => {
    const config = await genesis();
    const first = await refreshComposite(
      undefined,
      config,
      market({ time: NOW + 600 }),
      () => (NOW + 600) * 1000,
    );
    expect(first.methodology).toBe(METHODOLOGY);
    for (const i of first.indexes) {
      expect(i.status).toBe("OK");
      expect(i.value).toBeCloseTo(1000, 5);
      expect(i.history[0]).toEqual({ value: 1000, observedAt: NOW });
      expect(i.coverage).toBe(i.count);
    }
    const second = await refreshComposite(
      JSON.parse(JSON.stringify(first)),
      config,
      market({
        factor: 1.05,
        down: ["skinport", "lisskins"],
        time: NOW + 1200,
      }),
      () => (NOW + 1200) * 1000,
    );
    expect(second.venues!.filter((v) => !v.ok).map((v) => v.id)).toEqual([
      "skinport",
      "lisskins",
    ]);
    for (const i of second.indexes) {
      // Cent rounding on low-priced cases shifts the move slightly.
      expect(i.value).toBeCloseTo(1050, -1);
      expect(i.history.length).toBe(first.indexes[0].history.length + 1);
      expect(i.constituents.every((c) => c.sources === 3)).toBe(true);
    }
    await expect(
      refreshComposite(
        first,
        config,
        market({ down: ["skinport", "lisskins", "waxpeer"] }),
      ),
    ).rejects.toThrow("preserving the published snapshot");
  });
  it("freezes the baskets once, on the official base day", () => {
    const day = 86_400;
    expect(freezeStage(null, INDEX_BASE_AT - 1)).toBe("PREVIEW");
    expect(freezeStage(INDEX_BASE_AT - 40 * day, INDEX_BASE_AT - 1)).toBe(
      "PREVIEW",
    );
    expect(freezeStage(INDEX_BASE_AT - 40 * day, INDEX_BASE_AT)).toBe(
      "OFFICIAL",
    );
    expect(freezeStage(INDEX_BASE_AT - 40 * day, INDEX_BASE_AT + day - 1)).toBe(
      "OFFICIAL",
    );
    expect(freezeStage(INDEX_BASE_AT - 40 * day, INDEX_BASE_AT + day)).toBe(
      "MISSED",
    );
    expect(freezeStage(INDEX_BASE_AT + 420, INDEX_BASE_AT + 900)).toBe(
      "FROZEN",
    );
    expect(freezeStage(INDEX_BASE_AT + 420, INDEX_BASE_AT + 400 * day)).toBe(
      "FROZEN",
    );
  });
  it("keeps the preview as earlier history that meets the official base at 1,000", async () => {
    const day = 86_400;
    const started = INDEX_BASE_AT - 40 * day;
    const run = (
      previous: Awaited<ReturnType<typeof refreshComposite>> | undefined,
      config: GenesisConfig,
      at: number,
      factor = 1,
    ) =>
      refreshComposite(
        previous && JSON.parse(JSON.stringify(previous)),
        config,
        market({ factor, time: at }),
        () => at * 1000,
      );
    const preview = await genesis({}, started);
    let feed = await run(undefined, preview, started + 600);
    feed = await run(feed, preview, started + 3 * day, 0.9);
    feed = await run(feed, preview, INDEX_BASE_AT - 3600, 0.8);
    for (const i of feed.indexes) {
      expect(isPreview(i)).toBe(true);
      expect(i.prior).toBeUndefined();
      expect(i.value).toBeCloseTo(800, -1);
    }
    // Something reconstructed from before the floor must never be published.
    feed.indexes[0].prior = [
      {
        provenance: "BACKFILLED",
        points: [
          { value: 700, observedAt: INDEX_HISTORY_FLOOR_AT - 1 },
          { value: 720, observedAt: INDEX_HISTORY_FLOOR_AT },
        ],
      },
    ];
    const frozenAt = INDEX_BASE_AT + 420;
    const official = await genesis({ factor: 0.8 }, frozenAt);
    feed = await run(feed, official, frozenAt + 180, 0.8);
    for (const [n, i] of feed.indexes.entries()) {
      expect(isPreview(i)).toBe(false);
      expect(i.baseAt).toBe(frozenAt);
      expect(i.history[0]).toEqual({ value: 1000, observedAt: frozenAt });
      expect(i.value).toBeCloseTo(1000, 5);
      const earlier = i.prior!.at(-1)!;
      expect(earlier.provenance).toBe("PREVIEW");
      // One close a day: the start, the fall three days in, and the eve of the base.
      expect(earlier.points.map((p) => p.observedAt)).toEqual([
        started + 600,
        started + 3 * day,
        INDEX_BASE_AT - 3600,
      ]);
      expect(earlier.points.at(-1)!.value).toBe(1000);
      expect(earlier.points[0].value).toBeCloseTo(1250, -1);
      expect(i.prior!.length).toBe(n === 0 ? 2 : 1);
    }
    // The point before the floor is gone; the rest is rescaled with the preview (800 → 1,000).
    const backfilled = feed.indexes[0].prior![0];
    expect(backfilled.provenance).toBe("BACKFILLED");
    expect(backfilled.points.map((p) => p.observedAt)).toEqual([
      INDEX_HISTORY_FLOOR_AT,
    ]);
    expect(backfilled.points[0].value).toBeCloseTo(900, 3);
    // The official series then runs on its own; earlier history is left as it is.
    const next = await run(feed, official, frozenAt + 2 * day, 0.88);
    for (const [n, i] of next.indexes.entries()) {
      expect(i.value).toBeCloseTo(1100, -1);
      expect(i.prior).toEqual(feed.indexes[n].prior);
    }
  });
  it("keeps a long series whole: a week in full, one close a day before", () => {
    const start = INDEX_BASE_AT;
    const history = Array.from({ length: 30 * 144 + 1 }, (_, n) => ({
      value: 1000 + n / 100,
      observedAt: start + n * 600,
    }));
    const thinned = thin(history);
    expect(thinned[0]).toEqual(history[0]);
    expect(thinned.at(-1)).toEqual(history.at(-1));
    // The base, 23 earlier days, then every ten-minute observation of the last seven.
    expect(thinned.length).toBe(1 + 23 + 7 * 144);
    expect(thin(thinned)).toEqual(thinned);
  });
});

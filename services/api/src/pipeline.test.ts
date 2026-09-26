import { describe, it, expect } from "vitest";
import { openStore, commitPayload, stringify } from "./store";
import { ingest, commitCalculation, replay, compositionRoot } from "./pipeline";
describe("append-only audit pipeline", () => {
  it("binds composition to weights, base prices and the continuity multiplier", () => {
    const input = {
      indexId: "index",
      divisorE8: "100000000000",
      basket: [
        {
          constituentId: "a",
          weightE18: "1000000000000000000",
          basePriceE8: "100000000",
          observations: [],
        },
      ],
    };
    expect(compositionRoot(input)).not.toBe(
      compositionRoot({ ...input, divisorE8: "200000000000" }),
    );
    expect(compositionRoot(input)).toBe(
      compositionRoot({ ...input, basket: [...input.basket].reverse() }),
    );
  });
  it("commits payload before normalization errors and forbids history edits", async () => {
    const db = openStore(":memory:");
    await expect(
      ingest(
        db,
        "venue-a",
        async () => '{"raw":true}',
        () => {
          throw Error("normalize failure");
        },
      ),
    ).rejects.toThrow();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM raw_provider_payloads").get()!.n,
    ).toBe(1);
    expect(() => db.exec("DELETE FROM raw_provider_payloads")).toThrow(
      "append-only",
    );
    db.close();
  });
  it("rejects sequence replays at the store boundary", async () => {
    const db = openStore(":memory:");
    const normalize = () => ({
      constituentId: "internal-only",
      observedAtMs: 1,
      bidE8: 10n,
      askE8: 12n,
      sourceSequence: "1",
    });
    await ingest(db, "venue-a", async () => "first", normalize);
    await expect(
      ingest(db, "venue-a", async () => "second", normalize),
    ).rejects.toThrow();
    db.close();
  });
  it("replays an unavailable publication bit for bit without inventing a price", () => {
    const db = openStore(":memory:");
    const input = {
      indexId: "index",
      observedAt: 1000,
      divisorE8: "100000000000",
      basket: [
        {
          constituentId: "internal",
          weightE18: "1000000000000000000",
          basePriceE8: "100000000",
          observations: [],
        },
      ],
    };
    const committed = commitCalculation(db, input);
    expect(committed.output.index.status).toBe("UNAVAILABLE");
    expect(stringify(replay(input))).toBe(
      db.prepare("SELECT output FROM replay_records").get()!.output,
    );
    db.close();
  });
});

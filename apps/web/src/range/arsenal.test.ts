import { describe, expect, it } from "vitest";
import { ARSENAL, createTrigger, nextMode, pressTrigger, releaseTrigger, takeShot } from "./arsenalSpec";
import { createSequenceDetector, KONAMI } from "./konami";
import { comboMultiplier, killScore, spawnOrder, wavePlan, zombieStats } from "./hordeRules";

const spec = (id: string) => ARSENAL.find((weapon) => weapon.id === id)!;
/** Simulates frames at 250 Hz and counts rounds fired. */
function run(id: string, mode: Parameters<typeof takeShot>[1], from: number, to: number, trigger = createTrigger()) {
  let shots = 0;
  for (let now = from; now < to; now += 4) if (takeShot(spec(id), mode, trigger, now)) shots += 1;
  return shots;
}

describe("arsenal", () => {
  it("offers five weapons, each with its own fire modes", () => {
    expect(ARSENAL.map((weapon) => weapon.id)).toEqual(["ak47", "m4", "famas", "uzi", "rifle"]);
    expect(spec("m4").modes).toEqual(["AUTO", "BURST", "SEMI"]);
    expect(spec("rifle").modes).toEqual(["BOLT"]);
    expect(nextMode(spec("m4"), "SEMI")).toBe("AUTO");
    expect(nextMode(spec("rifle"), "BOLT")).toBe("BOLT");
  });

  it("fires continuously in AUTO at the cyclic rate", () => {
    const trigger = createTrigger();
    pressTrigger(trigger);
    // 600 rpm = one round every 100 ms.
    expect(run("ak47", "AUTO", 0, 1000, trigger)).toBe(10);
  });

  it("fires once per pull in SEMI", () => {
    const trigger = createTrigger();
    pressTrigger(trigger);
    expect(run("ak47", "SEMI", 0, 1000, trigger)).toBe(1);
    releaseTrigger(trigger);
    pressTrigger(trigger);
    expect(run("ak47", "SEMI", 1000, 2000, trigger)).toBe(1);
  });

  it("finishes a three-round burst even if the trigger is released", () => {
    const trigger = createTrigger();
    pressTrigger(trigger);
    expect(takeShot(spec("famas"), "BURST", trigger, 0)).toBe(true);
    releaseTrigger(trigger);
    expect(run("famas", "BURST", 4, 1000, trigger)).toBe(2);
  });

  it("makes the bolt-action wait for the action to cycle", () => {
    const trigger = createTrigger();
    pressTrigger(trigger);
    expect(takeShot(spec("rifle"), "BOLT", trigger, 0)).toBe(true);
    releaseTrigger(trigger);
    pressTrigger(trigger);
    expect(takeShot(spec("rifle"), "BOLT", trigger, 400)).toBe(false);
    expect(run("rifle", "BOLT", 404, 2000, trigger)).toBe(1);
  });
});

describe("konami sequence", () => {
  it("triggers only on the full sequence", () => {
    const feed = createSequenceDetector();
    expect(KONAMI.slice(0, -1).map(feed).some(Boolean)).toBe(false);
    expect(feed("KeyA")).toBe(true);
  });

  it("recovers from a wrong key and an extra leading up", () => {
    const feed = createSequenceDetector();
    feed("ArrowUp"); feed("KeyW");
    expect(["ArrowUp", ...KONAMI].map(feed).filter(Boolean)).toHaveLength(1);
  });
});

describe("wave rules", () => {
  it("starts gentle and escalates", () => {
    const first = wavePlan(1), tenth = wavePlan(10);
    expect(first).toMatchObject({ runners: 0, brutes: 0, total: 8 });
    expect(tenth.total).toBeGreaterThan(first.total);
    expect(tenth.brutes).toBeGreaterThan(0);
    expect(tenth.spawnEvery).toBeLessThan(first.spawnEvery);
    for (let wave = 1; wave <= 40; wave += 1) {
      const plan = wavePlan(wave);
      expect(plan.walkers + plan.runners + plan.brutes).toBe(plan.total);
      expect(plan.walkers).toBeGreaterThanOrEqual(0);
      expect(spawnOrder(plan)).toHaveLength(plan.total);
    }
  });

  it("scales zombies and rewards headshots and streaks", () => {
    expect(zombieStats("brute", 5).health).toBeGreaterThan(zombieStats("walker", 5).health * 3);
    expect(zombieStats("runner", 5).speed).toBeGreaterThan(zombieStats("walker", 5).speed);
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(7)).toBe(3);
    expect(comboMultiplier(999)).toBe(8);
    expect(killScore("walker", 1, true, 0)).toBe(150);
    expect(killScore("walker", 1, false, 3)).toBe(200);
  });
});

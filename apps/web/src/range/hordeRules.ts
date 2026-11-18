// Wave-mode balance. Pure functions so the pacing can be tested without a renderer.

export type ZombieKind = "walker" | "runner" | "brute";

export type WavePlan = {
  walkers: number;
  runners: number;
  brutes: number;
  total: number;
  /** Seconds between spawns and how many may be up at once. */
  spawnEvery: number;
  maxAlive: number;
};

export function wavePlan(wave: number): WavePlan {
  const w = Math.max(1, Math.floor(wave));
  const total = Math.min(60, 5 + w * 3);
  const brutes = w >= 4 ? Math.min(6, Math.floor((w - 1) / 3)) : 0;
  const runners = w >= 2 ? Math.min(total - brutes, Math.round((total - brutes) * Math.min(0.55, 0.12 * (w - 1)))) : 0;
  return {
    walkers: total - brutes - runners,
    runners,
    brutes,
    total,
    spawnEvery: Math.max(0.35, 1.5 - w * 0.11),
    maxAlive: Math.min(20, 6 + w * 2),
  };
}

export type ZombieStats = { health: number; speed: number; damage: number; score: number; scale: number };

export function zombieStats(kind: ZombieKind, wave: number): ZombieStats {
  const w = Math.max(1, wave);
  if (kind === "runner") return { health: 70 + w * 9, speed: Math.min(5.4, 3.3 + w * 0.14), damage: 12, score: 150, scale: 0.96 };
  if (kind === "brute") return { health: 520 + w * 70, speed: Math.min(2.2, 1.25 + w * 0.05), damage: 34, score: 500, scale: 1.34 };
  return { health: 100 + w * 14, speed: Math.min(2.4, 1.05 + w * 0.09), damage: 16, score: 100, scale: 1 };
}

/** Kill streaks inside the combo window raise the multiplier in steps, capped at x8. */
export function comboMultiplier(streak: number) {
  return Math.min(8, 1 + Math.floor(Math.max(0, streak) / 3));
}

export function killScore(kind: ZombieKind, wave: number, headshot: boolean, streak: number) {
  return Math.round(zombieStats(kind, wave).score * (headshot ? 1.5 : 1) * comboMultiplier(streak));
}

/** The order zombies leave the ground in: weak first, brutes spread through the back half. */
export function spawnOrder(plan: WavePlan, random: () => number = Math.random): ZombieKind[] {
  const order: ZombieKind[] = [
    ...Array.from({ length: plan.walkers }, () => "walker" as const),
    ...Array.from({ length: plan.runners }, () => "runner" as const),
  ];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i < plan.brutes; i += 1) {
    const at = Math.floor(order.length * (0.5 + (0.5 * (i + 1)) / (plan.brutes + 1)));
    order.splice(Math.min(order.length, at), 0, "brute");
  }
  return order;
}

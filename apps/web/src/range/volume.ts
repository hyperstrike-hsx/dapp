// The range's master volume, remembered between visits. Kept free of renderer and audio imports
// so the HUD can show and change it; World listens and applies it to the audio output.
const KEY = "hyperstrike.range.volume";

/** The levels the HUD button steps through; 0 is muted. */
export const VOLUME_STEPS = [1, 0.6, 0.3, 0] as const;

function stored(): number {
  try {
    const saved = window.localStorage.getItem(KEY);
    const value = saved === null ? NaN : Number(saved);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  } catch { /* storage can be blocked; fall through to the default */ }
  return 1;
}

let level = stored();
/** What the M key returns to when unmuting. */
let audible = level > 0 ? level : 1;
const listeners = new Set<(level: number) => void>();

export const rangeVolume = () => level;

export function setRangeVolume(next: number) {
  level = Math.min(1, Math.max(0, next));
  if (level > 0) audible = level;
  try { window.localStorage.setItem(KEY, String(level)); } catch { /* not fatal */ }
  for (const listener of listeners) listener(level);
}

/** The next step down, wrapping from muted back to full. */
export function cycleRangeVolume() {
  const at = VOLUME_STEPS.findIndex((step) => step <= level + 1e-6);
  setRangeVolume(VOLUME_STEPS[(Math.max(0, at) + 1) % VOLUME_STEPS.length]);
}

export function toggleRangeMute() {
  setRangeVolume(level > 0 ? 0 : audible);
}

export function onRangeVolume(listener: (level: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

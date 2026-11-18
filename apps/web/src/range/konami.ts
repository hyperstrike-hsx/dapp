// Classic cheat sequence: up up down down left right left right B A.
export const KONAMI = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "KeyB", "KeyA",
] as const;

/** Feeds key codes one at a time; returns true on the key that completes the sequence. */
export function createSequenceDetector(sequence: readonly string[] = KONAMI) {
  let matched = 0;
  return (code: string) => {
    if (code === sequence[matched]) matched += 1;
    else {
      // Fall back to the longest prefix that the keys typed so far still end with
      // (so up-up-up-down... still completes).
      const typed = [...sequence.slice(0, matched), code];
      matched = 0;
      for (let length = Math.min(typed.length, sequence.length - 1); length > 0; length -= 1) {
        if (sequence.slice(0, length).every((key, index) => key === typed[typed.length - length + index])) { matched = length; break; }
      }
    }
    if (matched < sequence.length) return false;
    matched = 0;
    return true;
  };
}

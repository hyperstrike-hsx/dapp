// Kept free of renderer imports so the app shell can ask before three.js is loaded.

/**
 * True where the range is played with thumbs: a touch screen with no mouse to capture. Phones cannot
 * lock a pointer at all, so there the range is entered and left by its own on-screen controls.
 * `?touch=1` / `?touch=0` overrides the guess, for testing.
 */
export function touchControls(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const forced = new URLSearchParams(window.location.search).get("touch");
    if (forced === "1") return true;
    if (forced === "0") return false;
    if (typeof document.documentElement.requestPointerLock !== "function") return true;
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * True on a phone or tablet, where a browser allows a page far less memory than a desktop does: a
 * range at full texture size is over a gigabyte and the page is closed for it. There the surface
 * photographs are loaded at 1K instead of 2K and nothing is uploaded larger than 1024 pixels.
 * `?lean=1` / `?lean=0` overrides the guess, for testing.
 */
export function leanAssets(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const forced = new URLSearchParams(window.location.search).get("lean");
    if (forced === "1") return true;
    if (forced === "0") return false;
  } catch { /* fall through to the guess */ }
  return touchControls();
}

/**
 * The largest texture a lean device uploads, in pixels. Android reports its memory class, and a
 * phone with 4 GB or less gets half the size again; Safari reports nothing, so iPhones get 1024.
 */
export function leanTextureSize(): number {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === "number" && memory <= 4 ? 512 : 1024;
}

/** The folder of a photographed surface set at the size this device should load. */
export function photoRoot(root: string): string {
  return leanAssets() ? root.replace(/-2k$/, "-1k") : root;
}

/** What the on-screen controls drive. The range fills this in while a map is loaded. */
export type TouchApi = {
  /** The movement stick: x to the right, y towards the player, each -1 to 1. */
  move: (x: number, y: number) => void;
  /** A drag across the view, in CSS pixels. */
  look: (dx: number, dy: number) => void;
  fire: (down: boolean) => void;
  aim: (on: boolean) => void;
  reload: () => void;
  nextWeapon: () => void;
  mode: () => void;
  pause: () => void;
  /** Called from inside a touch, which is what lets a phone start or resume sound. */
  wake: () => void;
};

/** What the app shell asks of the range. */
export type RangeControl = {
  /** Start or resume play: capture the mouse, or bring up the touch controls. Rejects where the mouse could not be captured. */
  engage: () => Promise<void>;
  /** Stop play and free the pointer. */
  pause: () => void;
  /** Open what the player is standing at (the E key). */
  use: () => void;
};

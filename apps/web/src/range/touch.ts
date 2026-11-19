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
 * range at full texture size is over a gigabyte and the page is closed for it. There every texture
 * is kept small (see `leanTextureSize`) and the files are fetched as their lighter copies.
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
 * The largest texture a lean device keeps, in pixels. A phone draws the range about 550 pixels
 * wide, so 512 loses little, and it is what keeps a map inside what a phone's browser will hold:
 * at 1024 a map is some 470 MB of textures, and Safari on an iPhone closes the page for that.
 * Only a device that says it has 8 GB or more (Android reports it, Safari never does) gets 1024.
 * `?texcap=N` overrides the guess, for testing.
 */
export function leanTextureSize(): number {
  try {
    const forced = Number(new URLSearchParams(window.location.search).get("texcap"));
    if (Number.isFinite(forced) && forced >= 64) return forced;
  } catch { /* fall through to the guess */ }
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === "number" && memory >= 8 ? 1024 : 512;
}

/** The longest side a painted or generated texture keeps on this device: no limit off a phone. */
export function textureLimit(): number {
  return leanAssets() ? leanTextureSize() : Infinity;
}

/**
 * Generated RGBA texels halved (a 2 × 2 average) until they fit `limit`. three.js scales images and
 * canvases down as it uploads them but sends raw texels as they are, and keeps them in memory too.
 */
export function shrinkRgba(data: Uint8Array, width: number, height: number, limit = textureLimit()) {
  while (Math.max(width, height) > limit && width % 2 === 0 && height % 2 === 0) {
    const w = width / 2, h = height / 2, out = new Uint8Array(w * h * 4), below = width * 4;
    for (let y = 0; y < h; y += 1) {
      let from = y * 2 * below, to = y * w * 4;
      for (let x = 0; x < w; x += 1, from += 8) {
        for (let channel = 0; channel < 4; channel += 1, to += 1) {
          const at = from + channel;
          out[to] = (data[at] + data[at + 4] + data[at + below] + data[at + below + 4] + 2) >> 2;
        }
      }
    }
    data = out; width = w; height = h;
  }
  return { data, width, height };
}

/**
 * A painted canvas at the size this device keeps: the canvas itself, or on a phone a smaller copy,
 * with the original emptied so its pixels are given back at once rather than whenever the browser
 * next collects. Only for a canvas that is painted once.
 */
export function leanCanvas(canvas: HTMLCanvasElement, limit = textureLimit()): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height);
  if (!(longest > limit)) return canvas;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round((canvas.width * limit) / longest));
  small.height = Math.max(1, Math.round((canvas.height * limit) / longest));
  const context = small.getContext("2d");
  if (!context) return canvas;
  context.drawImage(canvas, 0, 0, small.width, small.height);
  canvas.width = canvas.height = 0;
  return small;
}

/** The folder of a photographed surface set at the size this device should load. */
export function photoRoot(root: string): string {
  return leanAssets() ? root.replace(/-2k$/, leanTextureSize() <= 512 ? "-512" : "-1k") : root;
}

/**
 * Where a phone fetches a range file from: the lighter copy kept beside the full one, for the
 * files that have one (the surface sets, the first-person rifle and arms, and the skies). A range
 * is 40 to 50 MB to download at full size and about a third of that this way. Set as the loading
 * manager's URL modifier, so it also catches files a map asks for by their full-size name.
 */
export function leanUrl(url: string): string {
  return url
    .replace(/\/textures\/([a-z0-9_]+)-2k\//, (whole, name: string) => (LEAN_SETS.has(name) ? `/textures/${photoRoot(`${name}-2k`)}/` : whole))
    .replace(/\/models\/arms\/textures\/(\w+)\.png$/, "/models/arms/textures-lean/$1.jpg")
    .replace(/\/models\/bolt-action-rifle\/textures\//, "/models/bolt-action-rifle/textures-lean/")
    .replace(/\/environment\/(\w+)-2k\.hdr$/, "/environment/$1-1k.hdr")
    .replace(/\/environment\/bonzai-sky\.hdr$/, "/environment/bonzai-sky-1k.hdr");
}
const LEAN_SETS = new Set([
  "asphalt_02", "brick_wall_001", "cobblestone_floor_04", "concrete_floor_worn_001", "concrete_wall_007", "corrugated_iron_02",
  "fabric_pattern_07", "green_metal_rust", "lacquered_cherry_wood", "metal_plate", "painted_plaster_wall", "rusty_metal_02",
  "sandstone_cracks", "snow_02", "tiled_floor_001", "weathered_brown_planks",
]);

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

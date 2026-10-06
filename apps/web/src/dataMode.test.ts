import { describe, it, expect, vi, afterEach } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("release data mode", () => {
  it("defaults to published files with no API dependency", async () => {
    vi.stubEnv("VITE_DATA_MODE", "");
    const mode = await import("./dataMode");
    expect(mode.API_ENABLED).toBe(false);
    expect(mode.INDEX_FEED_URL).toBe("/data/indicative-indexes.json");
    expect(mode.HSX_FEED_URL).toBe("/data/hsx-ohlcv.json");
    expect(
      (await import("./nativeClient")).nativeConfig.factory,
    ).toBeUndefined();
  });
  it("requires explicit opt-in to the runtime API", async () => {
    vi.stubEnv("VITE_DATA_MODE", "api");
    const mode = await import("./dataMode");
    expect(mode.API_ENABLED).toBe(true);
    expect(mode.INDEX_FEED_URL).toBe("/v1/indicative/indexes");
  });
});

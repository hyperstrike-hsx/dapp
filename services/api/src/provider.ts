import { ingest } from "./pipeline";
import type { DatabaseSync } from "node:sqlite";
export type HttpProviderConfig = {
  id: string;
  origin: string;
  path: string;
  credentialEnv?: string;
  instrumentParam: string;
};
/** Adapter for licensed normalized bid/ask feeds. Providers never control an index ID. */
export async function pollProvider(
  db: DatabaseSync,
  config: HttpProviderConfig,
  constituentId: string,
  instrument: string,
) {
  const url = new URL(config.path, config.origin);
  if (url.protocol !== "https:") throw Error("Price providers require HTTPS");
  if (url.origin !== new URL(config.origin).origin)
    throw Error("Provider origin escape");
  url.searchParams.set(config.instrumentParam, instrument);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.credentialEnv) {
    const key = process.env[config.credentialEnv];
    if (!key) throw Error(`Missing provider credential for ${config.id}`);
    headers.Authorization = `Bearer ${key}`;
  }
  return ingest(
    db,
    config.id,
    async () => {
      const r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(12000),
        redirect: "error",
      });
      if (!r.ok) throw Error(`Provider ${config.id}: HTTP ${r.status}`);
      const raw = await r.text();
      if (raw.length > 1_000_000) throw Error("Provider payload too large");
      return raw;
    },
    (raw) => {
      const q = JSON.parse(raw);
      if (
        typeof q.sequence !== "string" ||
        !Number.isSafeInteger(q.observedAtMs)
      )
        throw Error("Provider sequence/time missing");
      const integer = (v: unknown) => {
        if (typeof v !== "string" || !/^\d+$/.test(v))
          throw Error("Price/depth must be integer E8 strings");
        return BigInt(v);
      };
      return {
        constituentId,
        observedAtMs: q.observedAtMs,
        sourceSequence: q.sequence,
        bidE8: integer(q.bidE8),
        askE8: integer(q.askE8),
        bidDepthUsdE8: integer(q.bidDepthUsdE8),
        askDepthUsdE8: integer(q.askDepthUsdE8),
        rollingVolumeUsdE8:
          q.rollingVolumeUsdE8 === undefined
            ? undefined
            : integer(q.rollingVolumeUsdE8),
      };
    },
  );
}

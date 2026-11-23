# Published index feed

The website shows the five indexes computed with methodology
[HS-MVA-1](INDEX_METHODOLOGY.md) from five marketplaces: Skinport, Market.CSGO,
DMarket, Waxpeer and LIS-SKINS. The feed uses the same baskets
(`config/index-genesis.json`) and the same code path as the on-chain oracle, but
it is **not signed**. Markets settle only on `IndexOracle` observations. Prices
are in USD; market collateral is USDC and no conversion is implied.

## Default release: static snapshots

The browser reads `/data/indicative-indexes.json` and `/data/hsx-ohlcv.json`.
`pnpm dev` starts only the front end and `pnpm build` copies the checked-in
snapshots without network access.

`pnpm snapshots:publish` restores history from the last published JSON, reads
the five venues once, recomputes every index and atomically replaces the
snapshot. It needs at least three venues; with fewer the previous files are
left untouched. A failed chart request keeps the prior candles. No database,
wallet or credential is published.

The GitHub Actions job targets ten-minute updates, commits only the two data
files to `main` and never force-pushes. The browser re-evaluates the 15-minute
source age itself, so a delayed job shows `STALE` rather than fake freshness.
Gaps are kept; a series is never back-filled. Observations older than a week
are kept as one close per UTC day, so a series keeps its whole length.

The official base of 1,000 is set on Wednesday 6 January 2027 (UTC); see
[the methodology](INDEX_METHODOLOGY.md#base-date-and-earlier-history). Until
then the feed is a preview started at 1,000 on 21 November 2026 and says so.
The job runs `pnpm snapshots:publish --freeze`: its first run of the base day
selects and freezes the official baskets, commits `config/index-genesis.json`
and its exclusions file once, restarts every series at 1,000, and keeps the
last preview feed at `/data/indicative-indexes.preview-hs-mva-1.json`. Without
`--freeze` (any run on a developer's machine) nothing is frozen. If no run
succeeds that day the preview carries on, the job warns, and a new base day has
to be chosen.

Each index may carry `prior`: history from before its base, as `PREVIEW` or
`BACKFILLED` segments rescaled to meet the base at 1,000. It is drawn dashed,
is not part of the series, and never reaches back before 23 October 2025.

The last state of the earlier single-venue preview is archived at
`/data/indicative-indexes.skinport-preview-v1.json` and is not continued.

## Optional runtime API

`GET /v1/indicative/indexes` serves the same feed from the API process
(`VITE_DATA_MODE=api`, `pnpm dev:full`). Refresh is demand-driven with a
five-minute cache, so history has gaps while nobody requests it.
`HS_INDICATIVE_ENABLED=false` stops upstream reads; the last value stays
visible and is marked stale. `HS_DISABLED_VENUES=skinport,…` removes venues
without a deployment.

## Limits

- Skinport allows 8 requests per 5 minutes per IP and penalises repeat
  offenders for up to an hour. The feed makes one request per run and never
  retries it. Run the snapshot job, the API and each oracle host on different
  IPs.
- The endpoints are public, but no venue has granted a commercial data licence.

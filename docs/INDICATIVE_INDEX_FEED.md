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
Gaps are kept; history is never back-filled.

The history starts at 1,000 when the baskets were frozen. The last state of the
earlier single-venue preview is archived at
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

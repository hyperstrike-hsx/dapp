# Launch preview: Skinport USD ask-price indexes

This feed is **display only**. It does not publish observations to the oracle,
authorize market creation, feed paper-market pricing, or settle contracts.
USDC remains market collateral; Skinport quotes are denominated in **USD**, not
USDC. Do not imply a conversion or redemption guarantee.

## Source and operation

### Default release: static snapshots

The browser reads `/data/indicative-indexes.json` and `/data/hsx-ohlcv.json`, not
the API routes below. `pnpm dev` starts only the frontend; `pnpm build` copies the
checked-in public snapshots without network access. The optional API mode requires
`VITE_DATA_MODE=api` explicitly (`pnpm dev:full` locally).

`pnpm snapshots:publish` runs the existing preview calculator in a temporary
in-memory database, restores baskets/history from the last published JSON, fetches
fresh prices, and atomically replaces public snapshots. No operational database,
wallets, positions or credentials are published. A failed index refresh leaves
the prior files untouched; a failed chart request retains prior candles.

The GitHub Actions publisher targets ten-minute updates, commits only these two
data files to `main`, and never force-pushes on conflicts. The static hosting
provider must deploy these data commits. See the README deployment requirements.
The browser re-evaluates the 15-minute source age even when the file says `OK`.
Delayed jobs/builds therefore produce a visible `STALE` label, never fake freshness.
Sampling gaps are retained; no history is filled in retrospectively.

### Optional runtime API (not required for release one)

- Official endpoint: `https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=1`.
- Documentation: https://docs.skinport.com/items. No API key required.
- Server requests Brotli encoding, as required by Skinport. One catalog request
  serves all five indexes; concurrent requests are coalesced. Successes and
  failures are cached for five minutes, including across API restarts.
- Public application endpoint: `GET /v1/indicative/indexes`. The browser checks
  it every minute. Upstream refresh is demand-driven, not a continuous collector.
  History therefore contains gaps while no clients request the feed.
- Run with `pnpm dev:full` (web + API), or `pnpm dev:api` alongside an API-mode web server.
  Preserve `HS_DATABASE_PATH` on a persistent volume so the baseline survives
  deployments. A new empty database starts a new preview baseline.
- `HS_INDICATIVE_ENABLED=false` disables upstream reads after the cached response
  expires. Existing last-known values remain explicitly stale.
- Run a single API worker with this SQLite cache. Multiple workers need a shared
  upstream request lock before scaling. Review provider redistribution terms and
  availability requirements before public commercial launch; this is not a paid SLA.

## Preview methodology: `skinport-ask-preview-v1`

Only fresh (at most 15 minutes old), positive USD minimum listing prices with
positive inventory qualify. Ambiguous duplicate names and variant-specific rows
are excluded. StatTrak and Souvenir items are excluded at basket initialization.
Initial selection requires at least five listings per item; it ranks by listed
inventory descending, with deterministic name tie-breaking. Inventory is **not
traded volume or executable bid liquidity**.

| Preview    | Initial basket                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| HS-CS50    | 15 knives (30%), 8 gloves (15%), 12 weapon skins below $250 (25%), 10 cases (20%), 5 weapon skins at/above $250 (10%)       |
| HS-KNIFE20 | 20 knife configurations, equal weight                                                                                       |
| HS-GLOVE10 | 10 glove configurations, equal weight                                                                                       |
| HS-BLUE20  | 20 weapon skins at/above $250, equal weight; **premium weapon proxy**, not the approved collectible basket                  |
| HS-CASE20  | 20 cases, equal weight; Skinport creation timestamp at least 90 days old (source-age proxy, not verified game release date) |

Membership, weights, and USD base asks are frozen at first successful initialization
per index. There is no automatic substitution or periodic reranking. This preview
does **not** enforce the approved canonical methodology's family caps, multiple
venues, bids, executed trades, history requirements, or quarterly rebalance rules.

`preview = 1,000 × Σ(weight × current_min_ask / initial_min_ask)`

The first observation is 1,000, not an invented historical price. Return labels
are **since base**, never 24h/7d/30d without the relevant history. Each index exposes
its exact constituents, base asks, current asks, source timestamps and weights.
The source observation timestamp is the oldest constituent update. A maximum of
288 latest recorded observations is returned. Samples are retained in SQLite.

All frozen constituents must be available and fresh. Missing constituents or an
upstream failure preserve the last complete observation with `STALE` status;
there is no reweighting. No prior observation means `UNAVAILABLE` and `value: null`.
Frontend connection failures also mark retained data stale.

## Separation from settlement

The response uses `provenance: INDICATIVE` and `settlementEligible: false` and is
stored exclusively in `indicative_*` tables. Canonical routes, signer, publisher,
market creation and settlement paths do not consume it. Canonical status remains
unavailable until genuine signed canonical observations are published.

Tests cover malformed/stale data, basket counts and weights, price moves,
incomplete coverage, caching/concurrent reads, restart persistence, failures,
source expiry inside cache lifetime, and the absence of canonical writes.

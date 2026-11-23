# Index methodology HS-MVA-1 (multi-venue ask reference)

This is the methodology the five HyperStrike indexes run on, both in the
published website feed and in the quorum-signed on-chain oracle. One code path
computes both (`services/api/src/oracle-engine.ts`); the only difference is that
on-chain observations carry signatures.

It supersedes the single-venue `skinport-ask-preview-v1` feed. The last
published state of that preview is kept at
`apps/web/public/data/indicative-indexes.skinport-preview-v1.json`.

## Venues

| Venue       | Endpoint                                                             | Ask | Bid | Listed depth |
| ----------- | -------------------------------------------------------------------- | --- | --- | ------------ |
| Skinport    | `api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0`        | yes | no  | yes          |
| Market.CSGO | `market.csgo.com/api/v2/prices/USD.json` + `prices/orders/USD.json`   | yes | yes | yes          |
| DMarket     | `api.dmarket.com/marketplace-api/v1/aggregated-prices` (POST)         | yes | yes | yes          |
| Waxpeer     | `api.waxpeer.com/v1/prices?game=csgo`                                 | yes | no  | yes          |
| LIS-SKINS   | `lis-skins.com/market_export_json/csgo.json`                          | yes | no  | yes          |

All five are public, keyless bulk price lists in USD, keyed by Steam
`market_hash_name`, on which the seller pays the fee — so the lowest ask is the
buyer's all-in price and is comparable across venues.

Evaluated and excluded: Steam Community Market (wallet funds are not cashable
and the API is rate-limited per item), CSFloat, Buff.Market, Skinbaron,
ShadowPay (login or key required), BitSkins (public endpoint returns suggested
prices, not listings), GamerPay (EUR, ~600 items), Loot.Farm and Tradeit (trade
bots, not marketplaces), CS.MONEY and Avan.Market (bot-protected).

Operational limits observed on 2026-11-21: Skinport allows 8 requests per 5
minutes per IP and is never retried; DMarket rate-limits bursts and is retried
with backoff. Each host therefore makes one Skinport request per cycle. Run the
website snapshot job and the oracle daemon from different IPs.

## Constituent reference price

For each constituent, every five minutes:

1. Take each venue's lowest ask, at most 10 minutes old.
2. Rescale it by `constituent base price / that venue's own ask at basket
   approval`. A venue is thus read as a _return since base_. Venues sit at
   persistently different price levels (Skinport is typically the cheapest,
   Market.CSGO the dearest); without this step a single venue dropping out moved
   the index by 1–2%.
3. Reject asks further than `max(12.5% of the median, 7.413 × MAD)` from the
   cross-venue median.
4. Require at least **three** surviving venues, otherwise the constituent is
   unavailable for this observation.
5. The reference price is the listed-depth-weighted median, with no venue
   weighted above 40%.

Resting bids (Market.CSGO, DMarket) never set the price; they corroborate it and
feed the confidence score.

Confidence starts at 10,000 bps and loses: 400 if only three venues survive;
up to 700 for quote age beyond five minutes; half the tightest bid/ask spread
(300 if no venue has a bid), capped at 1,000; the median cross-venue dispersion,
capped at 1,200; 800 if median listed depth is under $100; 100 per rejected
quote, capped at 400.

## Index

`index = 1000 × Σ weight × reference / base`, renormalised over available
constituents. More than 10% of weight missing makes the index unavailable. Index
confidence is the weight-harmonic mean of constituent confidence minus the
missing weight. Below 7,500 the index is UNSAFE and nothing is signed. Market
creation needs ≥ 9,000 on chain; settlement samples need ≥ 8,500.

## Base date and earlier history

Every index is 1,000 at the freeze taken on **Wednesday 6 January 2027 (UTC)**
(`INDEX_BASE_AT` in `packages/market-types/src/indicative.ts`). It is the first
weekly drop reset after the Singapore Major (ends 13 December 2026) and the
Steam Winter Sale (17 December to 4 January), so the base is taken inside
neither. The base is stamped with the time of the freeze itself, not rounded to
midnight.

The base cannot be earlier than the day it is observed: a constituent's base is
its ask on each venue at the freeze, and no five-venue record exists from
before 21 November 2026. Until the base day the published series is a
**preview**: same methodology, baskets built on 21 November 2026, labelled as a
preview wherever it is shown. On the base day the baskets are selected again and
frozen, and the series restarts at 1,000.

History from before the base is never part of the index. It may be drawn beside
it, dashed and labelled, rescaled so the line meets the base at 1,000:

- **PREVIEW**: the daily closes of the preview series, on the preview baskets.
  Published automatically at the freeze.
- **BACKFILLED**: a reconstruction from another source. None is published yet.
  None of the five venues offers price history, so it needs a separate licensed
  source; and because the baskets are picked in January 2027, pricing them back
  in time flatters them with hindsight. It must say so where it is shown.

Nothing from before **23 October 2025** is published or drawn
(`INDEX_HISTORY_FLOOR_AT`; the feed drops it and the chart ignores it). That is
the first full day after the trade-up change of 22 October 2025, which let five
Covert skins be exchanged for a knife or gloves and repriced both overnight.
Three of the five indexes are mostly knives and gloves; a line carried back
through that date would describe a different market.

## Publication and settlement

Observations are published on five-minute boundaries and must land on chain
within 240 seconds of their slot. A market stops trading 15 minutes before it
resolves, so no trade can be made once the ±5-minute settlement window can be
observed. Settlement is the time-weighted average of signed observations over
±5 minutes, falling back to ±15 minutes and then ±1 hour when observations are
missing. Slots voided by the resolution committee are skipped.

## Genesis baskets

`pnpm genesis:build` selects the baskets deterministically from a live snapshot
(`services/api/src/genesis.ts`); nothing is hand-picked. Before the base day it
writes preview baskets (`--force` to replace existing ones); on the base day it
writes the official ones, once; after that it refuses to run. A candidate must:

- be quoted on **all five** venues with cross-venue ask dispersion ≤ 12.5% and no
  rejected quote;
- have a resting bid within 15% of the ask on at least one venue;
- have been listed on Skinport for ≥ 30 days (cases: ≥ 90);
- meet a minimum of Skinport sales in the last 30 days (knives/gloves 8, premium
  5, weapons 150, cases 80);
- not be StatTrak, Souvenir, or a Doppler (phases are not fungible under one
  name); cases must be ≥ $1 so a one-cent tick is under 1%.

Candidates are ranked by 30-day traded USD volume on Skinport (the only public
sales tape) with one wear per skin and caps per family and finish.

| Index      | Composition                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| HS-CS50    | 15 knives (30%), 8 gloves (15%), 12 weapon skins $5–$100 (25%), 10 cases (20%), 5 premium weapons (10%)  |
| HS-KNIFE20 | 20 knives, equal weight, ≤ 2 per knife type, ≤ 4 per finish                                              |
| HS-GLOVE10 | 10 gloves, equal weight, ≤ 2 per glove type                                                              |
| HS-BLUE20  | 20 weapon skins ≥ $100, equal weight, ≤ 4 per weapon                                                     |
| HS-CASE20  | 20 cases, equal weight                                                                                   |

The result is `config/index-genesis.json`. Its per-index `compositionRoot`
(weights, base prices and per-venue bases) is written into `IndexRegistry` at
deployment, and every published observation must carry it.
`config/index-genesis.exclusions.json` lists near-miss candidates and the gate
each failed. The official file is the committed composition and is never
regenerated. Later compositions go through `IndexRegistry.schedule` with seven
days' notice.

## Known limits

- **Asks, not trades.** Only Skinport publishes a sales tape, so the index is an
  executable-ask index. Moving it requires changing the lowest ask on at least
  three venues at once.
- **Uptime and history gates are bootstrap proxies.** `uptimeBps` is the share
  of venues quoting at approval and `historyDays` is Skinport listing age; there
  is no 30-day multi-venue archive yet. The daemon's append-only store builds
  one from the first cycle and the first rebalance should use it.
- **Base prices come from a single snapshot.** A venue whose ask was anomalous
  at approval reads slightly off until the next rebalance; the median bounds the
  effect.
- **Published feed vs. oracle.** The website snapshot is computed by a scheduled
  job and is not signed. Only `IndexOracle` observations settle markets.
- **Terms of use.** These are public endpoints, but none of the venues has
  granted a commercial data licence. Review each venue's terms before relying
  on them for a product that charges fees.

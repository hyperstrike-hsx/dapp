# Data configuration and operating boundaries

No bundled constituent fixture is approved production data. Configure the engine only after committee approval and a provider agreement permitting executable quote ingestion and display. A different hostname alone does not establish economic source independence; that is an operating review.

The JSON accepted by `services/api/src/indexer-engine.ts` has:

- `providers`: at least two unique `{id, origin, path, instrumentParam, credentialEnv?}` descriptors. HTTPS only, redirects prohibited, same-origin paths, 12-second timeout, four concurrent requests maximum. Credentials are injected from environment and never emitted in records.
- `baskets`: exactly the five canonical index IDs, once each. `{indexId, versionId, divisorE8, approvedAt, activatesAt, constituents}`. Bytes32 version; seconds UTC; seven-day notice; integer-string E8 multiplier.
- Constituents: `{constituentId, weightE18, basePriceE8, family, finish, sleeve, eligibility, mappings}`. Mappings are `{providerId,instrument}`. These identifiers belong only to the data domain.
- Eligibility: `{sources, uptimeBps, spreadBps, historyDays, integrityFlag, ageDays, liquidityBps, agreementBps}`. Liquidity/agreement are calibrated 0–10000 evidence-derived measures, not values a creator may choose.

The normalized provider response schema is `{sequence, observedAtMs, bidE8, askE8, bidDepthUsdE8, askDepthUsdE8, rollingVolumeUsdE8?}`. Sequence is a string; amounts are nonnegative decimal integer strings; time is an integer. Vendor-specific adapters must map the provider's actual schema into this feed and preserve raw source provenance. The current generic adapter is not a substitute for licensed integration.

Eligibility v1 weights source coverage/uptime/liquidity/spread/history/agreement by 25/20/20/15/10/10. Coverage saturates at three venues; history at 30 days; spread quality reaches zero at the threshold. Minimum gates apply independently of ranking. Case seasoning is 90 days. Publish excluded candidates and reasons alongside the approved configurations before activation.

## One-shot workflow

1. Poll adapters and commit original payloads before normalization.
2. Calculate each minute from timestamped eligible inputs. Record both input/output; never retroactively edit.
3. On a five-minute boundary generate a candidate. The operator must budget feed polling plus signer verification and broadcast within the contract's 90-second publication window. The one-shot worker is not an SLO guarantee; provider batching/caching and production scheduling must be tested.
4. Each isolated signer verifies the approved version, source commitments, replay, freshness and chain sequence. Run `pnpm oracle:sign candidate.json` on each signer host.
5. Transfer only signed envelopes to the publisher. `pnpm oracle:publish signer-a.json signer-b.json` validates and simulates; only an operator-controlled `--broadcast` sends gas. Keep publisher keys separate from oracle keys.
6. `pnpm chain:index` follows finalized events, validates stored checkpoint hash and reconstructs native market/observation read models. Collateral reconciliation reads one block tag for all balances. Reorg beyond finality halts; rebuild a separate database and investigate rather than rewriting history.
7. Replay any canonical candidate using `pnpm replay-index --index HS-CS50 --timestamp ISO_UTC` against the archived input snapshot.

Replays verify calculations, not the truth of compromised raw market data. Independence, quote integrity, history completeness, backup restores and quorum/key custody require evidence outside this repository. Never publish a reconstructed observation as if it had been signed at that past time.

# Implementation and release status

This is a **substantial local implementation, not completion of every production requirement** in the supplied v3 specification. No mainnet deployment, real order or token burn was executed during implementation. Independent contract review and operational data evidence cannot be replaced by passing unit tests.

## Coverage against v3

| Spec sections | Implemented locally | Remaining / limitation |
|---|---|---|
| 1–4, 16–19, 53 | Index-only domains, 5 keccak IDs, LEVEL/MOVE, canonical calendar, grid, uniqueness, monorepo packages | Approve grid clarification in INDEX_NATIVE_SPEC |
| 5–7, 12 | Weight validation, sleeve/equal weighting, source/history/uptime eligibility gates, versioned normalized eligibility score, family/finish caps, continuity function, 7-day announcement, stored inclusion scores | Approved constituents and empirical metric calibration, exclusion decisions, automated quarterly rebalance and empirical continuity acceptance |
| 8–11, 14 | Normalized HTTPS adapter, raw-before-normalization store, HRP/outlier/40% cap, missing-weight handling, harmonic confidence, 60s calculation / 5m candidate, isolated replay signer, quorum-verifying publisher CLI, EIP-712 quorum contract | Licensed provider-specific bindings and executable feeds; independent signer hosts and scheduled broadcaster service; calibrated cross-sectional/version confidence penalties; production uptime |
| 13, 43–44 | Append-only SQLite audit/replay/observations; canonical/backfilled schema separation; replay CLI; source commitments | 30-day reconstruction, PostgreSQL/object-store deployment, independent restore/audit, signed backfill publication procedure |
| 15, 31–32 | Primary/fallback TWAP, lock, proposals, bond/challenge/adjudication/finalize, INVALID, pause-safe claims | Independent review of challenge liveness/griefing and operational resolution drills |
| 20 | Canonical opportunity slots, existing-key filtering, fees/liquidity metadata, strict creation validation | Relevance scoring against real history/volume; opportunity consumption analytics |
| 21–26 | HSX price cross-check interface, true-burn checks, STRIKE ERC20/permit/burn, integrated bounded curve, cost limits/deadlines, delayed curve changes | Review actual HSX contract; deploy real TWAP/reference sources; approve price bounds/curve governance; fund treasury |
| 27–30, 36, 47 | Single collateral, complete-set accounting, cap/price-impact bounds, buy/sell, segregated fees, pull claims, solvency assertions, invalid/dust tests | Collateral address and transfer behavior review; adversarial token/reentrancy/fork/stateful invariant audit beyond included unit/fuzz coverage |
| 33–35 | Native-only execution, immutable markets, access roles, default-admin delay, no active HIP-4 dependency | Routing is consolidated (no separate RailRouter/NativeRailAdapter/TradeRouter). Internal claims, not external OutcomeToken1155. No future HIP-4 adapter implemented |
| 37–41 | Six-section UI; paper buy/sell + persistent portfolio; canonical observation/history/composition reads; native create/quote/trade/redeem; STRIKE quote/mint; creator fee/pool claims; legacy archive; range order staging | Live-config wallet end-to-end acceptance; depth/orderbook UI not applicable to this AMM prototype; contribution visualization, rankings, full opportunity UI and historical return analytics incomplete |
| 42 | Index/latest/history/composition/contributions, oracle status, opportunities, market detail/trades/resolution, prepare/quote, STRIKE quote and token stats | Production pagination/auth/rate limiting/load tests, complete API schema generation |
| 45–46, 49–51 | Metrics and alert definitions, incident runbook, chain-event read model/checkpoint reorg halt, collateral reconciliation, fail-closed deployment preflight, incrementally recorded deployment manifest, CI | Hosted monitoring, device/load/failover tests, multi-provider RPC, production services/secrets, signer key ceremony, public incident pages and external review |
| 48, 54–56 | Unit/golden/property-style tests, API failure tests, contract integration/fuzz coverage, strict TypeScript and production build | Thirty-day evidence, independent audits, real-user pilot and all original release gates are **not yet satisfied** |

## Implemented visual changes

- Updated mint/teal/cream/orange terminal, canonical index cards and a deliberate paper/live separation.
- Local 2K Poly Haven PBR floor/brick maps; real roughness/normal/AO instead of flat environment colors.
- Half-resolution GTAO, cached architectural shadows, controlled bloom, fixed initial render resolution, reduced lens distortion, corrected postprocessing/viewmodel ordering.
- Explicit HIGH / PERFORMANCE switch and live FPS telemetry. Performance disables GTAO and caps rendering at 1.3 MP; quality never changes silently after loading.
- Shoulder-oriented AK with muzzle convergence to the aiming ray, shared bloom for muzzle flash, retained automatic firing/reload mechanics.
- Stable scene lifecycle: changing portfolio/vote callbacks no longer tears down/recreates WebGL renderers. Resource cleanup releases passes/textures/context.

This does **not** establish CS2 visual parity, real ray tracing or stable 60 FPS across hardware. The current AK is a stylized third-party asset. Replacing it with a licensed realistic first-person model/hand rig and authored animations is the largest remaining weapon-fidelity improvement. Full first-person interaction testing is still required in a browser that supports pointer lock; the embedded test browser rejected capture, and the app now reports that clearly.

## Verification performed

- Strict frontend and protocol TypeScript checks.
- HRP/index arithmetic, source duplication/permutation/outlier cases, missing-weight equality, confidence, divisor, calendar, settlement and curve tests.
- Append-only raw storage/replay tests and HTTP tests ensuring missing data/deployments fail closed.
- Solidity integration/fuzz tests for create/burn atomicity, immutable uniqueness, oracle signatures/replays, fee segregation, trading lock/pause, redemption/INVALID/dust, challenge timing, curve cost/timelock, leap-month expiry.
- Browser smoke test: paper buy and sell, portfolio persistence after reload, routing, range asset load and shader rendering, single-canvas lifecycle after quality switches. Native onchain portfolio and wallet actions are implemented but not validated against a deployed pilot. The embedded browser measured approximately 30 FPS in both presets; this is not a 60 FPS acceptance result.

Latest automated run: **43 JavaScript/TypeScript tests and 23 Solidity tests passed**, plus strict typecheck and production build. The two Solidity fuzz tests also passed with 10,000 runs each. Production build retains a large-chunk advisory for the lazy Three.js bundle and the main wallet-enabled bundle; it is not a build failure.

Passing this suite is useful engineering evidence, **not an audit**. CI contains an extended fuzz configuration; the current tests are not a complete stateful adversarial invariant campaign.

## Live launch blockers (in order)

1. **Product approval:** review the clarifications, risk caps, curve parameters, challenge policy and internal-claim/native-only architecture.
2. **Data:** choose licensed executable bid/ask providers, supply source mappings, approve exact constituent baskets, publish methodology/inclusion decisions, reconstruct 30 days and replay/audit the outputs.
3. **Collateral and price feeds:** identify the sole approved stablecoin address; review its code/decimals/transfer semantics; deploy reviewed HSX TWAP plus independent reference.
4. **Security:** independent review of the exact clean commit, economic/settlement simulation, fork tests against the actual token, stateful invariant/reentrancy campaign, and source verification.
5. **Operations:** production DB/backup/object archive, signer isolation (3 independent keys), multisig/timelock/treasury addresses, broadcaster cadence, API/worker monitoring, incident and challenge drills.
6. **Pilot:** deploy reviewed contracts with a small explicit cap, complete role grants/version scheduling, verify every address/constructor/runtime hash, then user-controlled funded-wallet tests of mint→create→buy→sell→resolve→redeem→fee claim.
7. **Scale only after evidence:** liquidity/usage/settlement/error budgets and all v3 release gates.

`pnpm production:check` must fail until reviewed configuration and evidence are supplied. `pnpm native:deploy` prints a plan only. Broadcast requires an explicit flag, local signer configuration and the clean externally reviewed commit. The script records each deployment progressively but does not automatically resume a partially deployed system—inspect its manifest before retrying, to avoid duplicate deployments.

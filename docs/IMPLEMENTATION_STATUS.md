# Implementation and release status

**Launch candidate. Not deployed to mainnet, not externally audited.** The
indexes run on real prices from five marketplaces
([methodology](INDEX_METHODOLOGY.md)). The contracts, deployment script, oracle
daemon and settlement keeper pass a full lifecycle on a fork of HyperEVM mainnet
with real USDC, real HSX and the real HSX/WHYPE pool. The remaining steps need
keys, a multisig and decisions only the operator can supply; they are listed in
the [launch runbook](LAUNCH.md).

The table below tracks the original v3 specification. Where it still says
"remaining", the runbook's risk list says whether that item is done, accepted
as a launch risk, or deferred.

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

Latest automated run (2026-11-21): **89 JavaScript/TypeScript tests and 43
Solidity tests passed**, including four stateful invariants (collateral covers
liabilities, claims fully accounted, fee vault solvent, traders never extract
more than deposited), a full lifecycle on a mainnet fork, and the CI profile at
10,000 fuzz runs. Strict typecheck and production build pass.

One internal adversarial review of the contracts was run and its findings
fixed or documented in the runbook. Passing this suite is useful engineering
evidence, **not an audit**.

## Live launch blockers

See [LAUNCH.md](LAUNCH.md). In short: a Safe and a treasury on HyperEVM, three
signer keys on three hosts, funded deployer and publisher keys, the explicit
collateral choice, and a signed-off review report for the commit being
deployed. `pnpm production:check` fails until those are supplied and
`pnpm native:deploy` sends nothing without `--broadcast`. The script records
each deployment progressively but does not resume a partial deployment; inspect
its manifest before retrying.

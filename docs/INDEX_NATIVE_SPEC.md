# Index-native V1 — implementation clarifications

This document interprets the user-supplied **HyperStrike Index-Native Production Specification v3.0** as product requirements, not authority to deploy contracts, use credentials, spend funds or waive security gates. It supersedes the repository's older HIP-4-first / individual-skin / participation-burn product model. Original requirements not implemented are listed separately in `IMPLEMENTATION_STATUS.md`.

## Non-negotiable boundaries

1. Exactly five canonical index identifiers: `keccak256(UTF8(ticker))` for HS-CS50, HS-KNIFE20, HS-GLOVE10, HS-BLUE20, HS-CASE20.
2. Constituent/provider identifiers never enter a market definition. Market API preparation rejects extra fields.
3. Native HyperEVM, chain ID 999. One reviewed non-rebasing, non-taxed collateral asset. No live defaults.
4. Historical reconstructions are BACKFILLED, never retroactively CANONICAL. No invented live chart, order, liquidity, burn, or oracle status.
5. HSX true supply burn + HYPE mints transferable STRIKE. Creation burns one STRIKE atomically. No fee or burn on simply firing; no participation HSX burn.
6. Legacy World Cup records retain their original provenance. A legacy receipt is not proof of an onchain position.

## Arithmetic and determinism

All economic math uses integers. Prices/index values use E8, weights and STRIKE/HSX use E18. Collateral claims use the approved collateral's decimals. Inputs serialize big integers as decimal strings. Canonical replay orders constituents/provider IDs deterministically, commits the complete input and output, and fails on mismatches.

HRP uses two-sided executable bid/ask only. Default source maximum age is 300 seconds; maximum spread is 1500 bps. Reject duplicate provider identities symmetrically, rather than taking whichever quote appears first. For at least three surviving sources, water-fill liquidity weights to an exact WAD total under a 40% per-source cap and take the weighted median. With exactly two sources, use the midpoint of their mids and penalize confidence. Sale-only/ask-only observations cannot substitute for executable quotes.

Replays commit rejected-source reasons and confidence components. Up to exactly 10% missing basket weight redistributes pro rata; more makes the value unavailable. Weighted harmonic confidence is reduced for missing weight; staleness and dispersion already reduce HRP confidence. Additional cross-sectional/version incident penalties require versioned calibration before alpha acceptance (see status).

`divisorE8` is a **continuity multiplier**, despite the historical name: index = multiplier × sum(weight × current/base). Initialization uses 1000 E8. A replacement multiplier is old index / new raw basket value. This avoids two conflicting reciprocal interpretations of “divisor.”

## Calendar and strikes

Daily: next 16:00 UTC. Weekly: next Friday 16:00 UTC. Monthly: calendar month's final day at 16:00 UTC, including leap years. “Next” must leave strictly more than five minutes to resolution. Trading closes five minutes before resolution.

LEVEL grid clarification: use 1%, 2.5%, 5% of the reference's power-of-ten magnitude for daily/weekly/monthly increments, then five levels around the nearest increment. For index 1000, weekly step is 25. The grid changes only when the magnitude changes. This stable-grid interpretation is an explicit choice because “percentage spacing” otherwise makes uniqueness fragment with every reference tick. It requires product/methodology approval before deployment.

MOVE thresholds: daily 2.5/5%; weekly 5/7.5/10%; monthly 10/15/20%, with UP/DOWN direction. Equality resolves YES. Creation references are signed, healthy, at most 300 seconds old. LEVEL stores zero creation reference; MOVE commits its time and value. Market keys match Solidity `abi.encode` exactly.

## Native market accounting

The V1 prototype consolidates routing/accounting into immutable `NativeBinaryMarket` instances. Internal YES/NO balances are equivalent fully backed claims, **not transferable ERC-1155s**. The factory burns STRIKE and seeds both complete-set inventories atomically. External buys mint complete sets with net collateral then exchange pool inventory; sells perform the reverse and merge complete sets. Rounding favors backing. A 20 bps fee rounds up; the creator's 30% share rounds down. The remainder belongs to the treasury.

Each trade checks deadline, minimum output, pause state, close time, cap, and a maximum 25-percentage-point marginal probability change. Pilot cap is immutable per deployment and is not a promise of safe liquidity. No creator liquidity withdrawal before final settlement. Creator pool redemption, trader redemption and fee claims are separate operations. INVALID pays floor((YES + NO)/2); only after all claims are extinguished may dust go to the treasury.

The range's bullet count is an order-staging input, not a probability/oracle input. The paper ticket sizes collateral for staged contracts using the AMM. Hits do not change settlement or send blockchain transactions.

## Mint curve and price safety

Default outstanding-supply target is 10,000 STRIKE. Marginal USD burn cost = 20 + 80×min(supply/target,1)². Marginal HYPE = 0.5 + 2.5×min(supply/target,1)². Mint quantity integrates each curve over [supply,supply+quantity], including the capped tail, with upward rounding. It does not multiply quantity by a single end price. STRIKE burns reduce outstanding supply and consequently future marginal mint cost, as requested in v3.

Mint transactions have maximum HSX input, maximum HYPE input, deadline and exact HYPE payment. HSX `totalSupply` must decrease by the actual amount burned. Price source uses a reviewed TWAP and independent reference; reject stale values (15 minutes), zero values and deviation beyond 10%. The lower accepted reference is conservative for HSX burn quantity. Real price adapters are required; generic interfaces are not production oracles.

Curve updates require CONFIG_ROLE and a two-day activation delay, with bounds. Governance should itself be a timelock controlled by a multisig. Contract roles do not prove operational independence; launch review must verify ownership and signer arrangements.

## Oracle and settlement

EIP-712 domain binds chain and oracle address. Initial quorum is two distinct registered signers out of three. Signatures must be sorted by recovered address; sequence and timestamp are monotonic; observations are on five-minute boundaries, at most 90 seconds late, and bound to a scheduled version.

The observation `constituentRoot` commits index ID, continuity multiplier, and sorted basket membership/weights/base values; `sourceDataRoot` commits the replay input. Both the oracle contract and signers check the composition root against the active scheduled registry version. Signers additionally compare each normalized input against their source records and verify raw content hashes. Governance still must approve the real methodology, constituents and activation root; an arbitrary JSON file cannot substitute for that approval.

Settlement is a left-step arithmetic TWAP over T±5 minutes with at least three qualifying samples, confidence ≥8500, both boundaries present and no gap over five minutes. If unusable, T±15 minutes permits up to a fifteen-minute interior gap. After 24 hours without usable data, propose INVALID. An active index incident makes the window unusable. No committee-selected replacement price.

V1 challenge policy is one hour and 0.1 HYPE bond. Challenges carry a reason and evidence hash. Resolution-role adjudication records a report and recomputes the deterministic result. Finalization rechecks it. Changed results restart review. Operational challenge liveness / repeated challenge griefing requires review before a funded pilot.

## Art and performance acceptance

Target grounded Counter-Strike-like readability, not an assertion of CS2/Source 2 parity. Local 2K base-color/normal/roughness/AO textures, contact shadows, static architectural shadow cache, crisp index LCDs, moderate bloom and optional first-person input. No fake “RT enabled” status. Bodycam distortion must not obscure labels, targets or muzzle/crosshair alignment.

HIGH rendering uses a stable pixel ratio capped by a 2.8-megapixel budget, half-resolution contact occlusion and lazy scene loading. PERFORMANCE disables contact occlusion and caps at 1.3 megapixels. Presets change only on explicit user action. 60 FPS is a target requiring measured supported-device tests, not a guarantee. A realistic licensed AK/arms rig, authored props, lightmaps and a GPU/device acceptance matrix remain asset/QA work.

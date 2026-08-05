# HyperStrike — Product and Architecture Specification

## 1. Product invariant

HyperStrike is the world's first prediction market dedicated to Counter-Strike 2 skin prices. HIP-4 is its fundamental trading standard.

The product combines a serious market interface with an original first-person 3D world that runs directly in the browser. The world is the discovery, identity, and retention layer; it is not the resolution source. HIP-4 on HyperCore is the canonical execution, position, collateral, and settlement layer. HyperEVM is used only for optional application-specific composability that HIP-4 does not provide.

Every listed market MUST concern a CS2 skin or the skin economy. Allowed launch subjects are:

- A named skin's reference price above or below a threshold at a future time.
- A named skin's percentage move over a defined period.
- The spread between two named venues at a future time.
- A bounded skin-market event with an objective price or listing-count criterion.

Markets on esports matches, rounds, kills, player performance, or outcomes caused by HyperStrike gameplay are out of scope.

## 2. Product promise

> Walk the market. Inspect the skin. Trade the probability.

A user can open a URL as a guest, enter an original first-person market gallery, walk to a skin exhibit, inspect its price history and venue health, and open a precise 2D trading panel. A conventional market list is always available for accessibility and efficient trading.

The minimum useful loop is:

1. Enter immediately as a guest; no wallet gate.
2. Move through a small first-person gallery and optional shooting range.
3. Discover a skin-price market from a diegetic exhibit or search.
4. Review the exact resolution rule and oracle health in a 2D panel.
5. Make a paper-money prediction in the prototype, or sign a HIP-4 HyperCore order after wallet onboarding in the regulated production path.
6. Return to see the market's provisional and final resolution.

The first-person layer MUST remain responsive while panels are open and MUST never obscure the contractual market terms.

## 3. Launch scope

### 3.1 In scope

- Desktop browsers with pointer lock and keyboard/mouse controls.
- One original gallery/range environment.
- 8–12 liquid launch skins, each with one canonical condition such as Field-Tested.
- Binary threshold and percentage-move markets.
- Paper-money mode before wallet connection.
- HIP-4 integration on Hyperliquid testnet, followed by mainnet only after the builder/listing path, oracle policy, security, and legal gates are satisfied.
- A complete conventional 2D market interface sharing the same route and data model as the 3D world.

### 3.2 Deferred

- Multiplayer combat.
- User-generated markets.
- HIP-4 multi-price/bucket markets.
- Autonomous news-created markets.
- Discord as a primary surface.
- A public paid oracle API.
- Operator revenue tokens or governance tokens.
- Skin custody, Steam inventory escrow, or skin-backed collateral.
- Mobile first-person controls.

Deferral is deliberate. These features do not validate whether users want to explore and trade skin probabilities in a browser world.

## 4. Experience design

### 4.1 The market gallery

The initial world is a compact, original industrial showroom rather than a copied CS2 map. It contains:

- A central live-market board.
- One exhibit bay per launch asset.
- A shooting lane for testing first-person movement, recoil feel, sound, and inspect animations.
- An oracle-status room showing venue freshness and divergence.
- A portfolio terminal.

Interaction uses a crosshair prompt and the `E` key. Selecting an exhibit opens the same accessible market drawer used by the 2D route.

### 4.2 FPS boundaries

The FPS mechanics are movement, camera control, weapon handling, target shooting, inspection, and spatial interaction. They create presence without introducing unrelated match betting.

Shooting MUST NOT:

- Change an oracle price.
- Manipulate a HIP-4 order book or displayed probability.
- Grant financial leverage or trading advantages.
- Decide a market outcome.
- Create a pay-to-win loop.

Cosmetic progression may unlock original HyperStrike world items, but it cannot alter market execution.

### 4.3 Asset and trademark safety

HyperStrike may refer textually to canonical market hash names where necessary to identify the underlying item. It MUST NOT ship copied Valve maps, weapon models, textures, sounds, logos, or skin artwork without documented commercial permission.

Prototype exhibits use original weapon silhouettes and abstract material swatches. Catalog imagery is enabled only for sources with a documented license or permission. All public pages include a clear non-affiliation notice.

## 5. Market definition

Market terms are data, not prose alone. A market is identified by a canonical `MarketSpec`:

```ts
type MarketSpecBase = {
  version: 1;
  assetId: string;
  marketHashName: string;
  condition: "FN" | "MW" | "FT" | "WW" | "BS";
  statTrak: boolean;
  souvenir: boolean;
  comparison: "GT" | "GTE" | "LT" | "LTE";
  opensAt: number;
  closesAt: number;
  resolutionWindowStart: number;
  resolutionWindowEnd: number;
  oraclePolicyId: string;
};

type MarketSpec = MarketSpecBase & (
  | {
      kind: "PRICE_THRESHOLD";
      thresholdUsd6: bigint;
    }
  | {
      kind: "PERCENT_MOVE";
      thresholdBps: number;
      baselineReportId: string;
    }
  | {
      kind: "VENUE_SPREAD";
      thresholdBps: number;
      venueA: string;
      venueB: string;
    }
);
```

The canonical specification is encoded into the HIP-4 market description in the format required by the active standard. HyperStrike stores its parsed form and a deterministic hash for verification; an optional HyperEVM commitment may mirror that hash but is not the market. UI text is generated from the parsed HIP-4 metadata so `>` and `>=`, asset condition, baseline, and resolution time cannot drift between the trading venue, oracle, and interface.

Launch markets close before the resolution window begins. Market duration is 24 hours to 30 days; the default resolution window is 60 minutes.

## 6. HIP-4 market execution

### 6.1 Source of truth

HyperStrike MUST use HIP-4 outcome markets on HyperCore for live trading. It MUST NOT deploy a parallel LMSR, AMM, CLOB, outcome token, collateral vault, market factory, or settlement contract on HyperEVM.

HIP-4 owns:

- Outcome identity and active-market metadata.
- YES/NO side assets.
- Order matching and order-book state.
- Fully collateralized positions.
- Fees defined by the protocol.
- Expiry and canonical settlement balances.

HyperStrike is a specialized frontend, skin-price data/oracle producer, market curator, and—when the active HIP-4 rollout permits it—builder/deployer. It never presents its database or an EVM mirror as canonical market state.

### 6.2 Discovery and identity

The adapter discovers active markets through the Hyperliquid Info API's `outcomeMeta` response. Each outcome has a numeric outcome identifier, encoded description, and explicit side specifications. Tradable sides use HIP-4 `#N` coin identifiers.

The adapter stores all of the following atomically:

```ts
type Hip4MarketBinding = {
  outcomeId: number;
  yesCoin: `#${number}`;
  noCoin: `#${number}`;
  quoteToken: string;
  rawSideSpecs: Array<{ name: string }>;
  rawDescription: string;
  parsedSpec: MarketSpec;
  observedAt: number;
};
```

Coin identifiers MUST be derived using the active HIP-4 encoding and verified against returned `sideSpecs`; they are never guessed from display order alone. Unknown description schemas, fields, quote tokens, or side layouts are quarantined rather than traded.

Launch supports only HIP-4 skin markets whose returned side specifications are exactly `Yes` and `No`. HyperStrike does not assume an undocumented description class: it parses and validates the actual metadata produced by the active builder interface. Multi-price and named-side markets are deferred until binary skin markets are stable.

### 6.3 CLOB semantics

HIP-4 is a central-limit-order-book market, not LMSR. Displayed probability comes from executable HIP-4 bids and asks:

- Best bid and ask are shown separately; the midpoint is never presented as an executable price.
- A market order is implemented as a user-approved IOC limit with an explicit worst price.
- Limit, IOC, GTC, and post-only behavior follows the active Hyperliquid Exchange API.
- Size, price tick, minimum notional, and decimal rules come from live metadata.
- YES and NO books may temporarily imply a sum different from one; the UI does not fabricate complement prices.
- Paper trading uses a local CLOB simulator shaped like HIP-4 messages, not an LMSR.

Every confirmation shows outcome, side, direction, size, limit price, time in force, estimated fill, maximum spend or minimum receive, protocol fees, expiry, and resolution rule.

### 6.4 Collateral and settlement

Outcome positions are fully collateralized by HIP-4 and settle within the protocol-defined fixed range. HyperStrike does not custody market collateral and does not implement claims.

The quote/settlement asset is discovered from `outcomeMeta.quoteToken` and displayed verbatim. The live mainnet response currently reports `USDC`, but the adapter still validates this field against a network allowlist instead of hardcoding it into market identity. It is not modeled as an ERC-20 on HyperEVM and no cross-chain token address is assumed.

HyperStrike MUST NOT invent a `0.5` Invalid payout. Cancellation, fallback, invalid, or exceptional settlement behavior must be supported by HIP-4 and encoded in the registered market terms. If HIP-4 cannot represent the required fallback for an unreliable skin-price source, that market is not listed.

### 6.5 Orders and signing

Live orders are signed Hyperliquid actions submitted to the Exchange API. The implementation uses the official signing schema and treats network, nonce, expiry, wallet address, account/subaccount, and agent authorization as security-critical fields.

- The master address is used for account and position queries even when an API/agent wallet signs.
- Nonces are generated centrally per signer and never reused.
- Client order IDs are unique and persisted before submission.
- Ambiguous timeouts are reconciled against open orders and fills before retry.
- Cancels and replace flows remain idempotent.
- No server-held trading key is created for a human user without explicit, revocable agent-wallet authorization.

### 6.6 Builder availability gate

HyperStrike's ability to launch CS2 skin markets depends on the active HIP-4 builder/deployment rollout and its accepted settlement sources. This is a hard external dependency.

The code isolates discovery, order entry, market registration, and settlement submission behind a versioned `Hip4Adapter`. Permissionless deployment is treated as a gated operator capability: HyperStrike uses only validator-approved templates and documented actions, maintains the required 500,000 HYPE deployer stake and six-month lock, and accepts settlement and slashing responsibility. Live skin trading remains disabled until the deployed outcome IDs are discoverable on mainnet, bound to the burn gate, and verified by the production readiness check.

### 6.7 `$HSX` burn utility

Canonical HyperEVM mainnet token: `0xab5dbc5a6070d066697d8e55471877ea4343ece3`. It reports symbol `HSX`, 18 decimals, a current total supply of 1 billion tokens, and exposes `burn` plus `burnFrom` in its deployed bytecode.

HyperStrike requires an actual supply-reducing `$HSX` burn for two application actions:

1. **Issue:** burn the configured creation amount before HyperStrike's operator submits a new `MarketSpec` through the HIP-4 builder path.
2. **Participate:** every order draft burns an `$HSX` amount equal to 1% of its 18-decimal normalized quote value before HyperStrike enables submission. Each bullet hit stages one contract, so order value is `contracts × selected-side price`.

The HyperEVM `HSXBurnGate` calls `burnFrom(user, amount)` on the canonical `$HSX` token and records the market-spec or order-draft receipt. The participation receipt is keyed by the agent-derived order hash, preventing the same burn from authorizing multiple submissions. Sending tokens to a treasury is not a burn. Sending to a dead address is used only if the token contract cannot burn and the product explicitly discloses that total supply does not decrease; the preferred production mode is `burnFrom`.

Issuance gating is enforceable because HyperStrike controls its HIP-4 submission workflow. Participation gating is enforceable in HyperStrike's frontend and approved agent flow, but it is **not protocol-enforceable against direct orders submitted to the public HIP-4 market** unless HIP-4 adds a native authorization hook. HyperStrike MUST disclose this distinction and MUST NOT claim that all market participants burned `$HSX` when users can bypass the application.

The issuance burn is immutable per gate deployment. Participation burns are deterministically `orderValueE18 / 100`, denominated in `$HSX` native decimals, and derived from transparent usage economics rather than a promised token-price target.

HyperStrike does not promise, target, or market a guaranteed increase in `$HSX` price or market capitalization. Product reporting focuses on active predictors, created markets, volume, liquidity, oracle reliability, and tokens verifiably burned.

## 7. HyperCore and HyperEVM architecture

```text
Browser world + 2D trading UI
  │
  ├─ read ─────► HyperStrike API/indexer ─────► HyperCore Info + WebSocket APIs
  │                                                │
  ├─ sign ─────────────────────────────────────────► HIP-4 Exchange API
  │                                                │
  │                                           orders, fills,
  │                                           positions, settlement
  │
  └─ optional app action ─────────────────────► HyperEVM app contract

Skin venue adapters ─► deterministic oracle report ─► HIP-4-authorized settlement path
```

HIP-4 execution lives on HyperCore. HyperStrike-specific contracts may live on HyperEVM only for non-canonical app functions such as a public report-hash commitment, cosmetic ownership, or rewards. Those contracts MUST NOT duplicate market balances, accept outcome collateral, override HIP-4 settlement, or be required to close a HIP-4 position.

HyperCore market data uses:

- Mainnet REST: `https://api.hyperliquid.xyz`
- Testnet REST: `https://api.hyperliquid-testnet.xyz`
- Mainnet WebSocket: `wss://api.hyperliquid.xyz/ws`
- Testnet WebSocket: `wss://api.hyperliquid-testnet.xyz/ws`

The WebSocket client sends heartbeats, reconnects with backoff, reloads snapshots, and reconciles missed fills after every disconnect.

Optional HyperEVM contracts use chain `999` on mainnet and `998` on testnet, with HYPE as gas. The official HyperEVM RPC has separate limitations from the HyperCore API. No HIP-4 order should require HYPE or an EVM transaction.

## 8. Oracle design

### 8.1 Resolution value

A market resolves from observations across its full resolution window, not a single request at one timestamp.

For each venue:

1. Collect a normalized executable listing price at a fixed cadence, default every 5 minutes.
2. Reject observations that fail asset identity, currency, timestamp, or liquidity requirements.
3. Compute that venue's time median across the window.
4. Compute the cross-venue median of valid venue medians.

At least three valid venues are preferred. A two-venue fallback is usable only when the policy permits it and their relative divergence is at or below the declared threshold. A one-venue report is unusable.

Do not use a `>2σ` outlier rule on three venues; it provides little protection. Do not give one venue a 0.5 median weight that allows it to determine the result by itself.

### 8.2 HIP-4 settlement evidence

Every signed report contains:

- `marketSpecHash`.
- Window start and end.
- Per-venue observation count and venue median.
- Exclusion reasons.
- Final price in USD6.
- FX source and timestamp where conversion was required.
- Raw-observation Merkle root.
- Oracle policy version.
- Proposed HIP-4 YES or NO settlement value.

Raw responses and normalized observations are retained in append-only storage for disputes. The report is formatted for the settlement source and authorization model accepted by the active HIP-4 deployment. A signed HyperStrike report has no settlement authority by itself.

### 8.3 Unusable-report reasons

- Fewer than the policy's minimum valid venues.
- Venue divergence above the declared limit.
- Insufficient observations across the resolution window.
- Asset identity cannot be proven consistently.
- Required FX data is stale.
- A venue basket or policy version differs from the committed market terms.

An unusable report does not authorize HyperStrike to invent a third payout. The operator follows the exact fallback or delayed-settlement behavior encoded in the HIP-4 market terms. Markets whose terms cannot safely handle missing data are rejected before registration.

### 8.4 Resolution governance

The UI may show HyperStrike's provisional oracle report, clearly labeled as non-final. Finality, disputes, and settlement balances follow HIP-4 rather than a HyperStrike smart contract.

The launch signer or resolver set may be permissioned by the active HIP-4 market policy. Calling a single reporter or opaque resolver “decentralized” is prohibited in product copy.

### 8.5 Venue access

Prefer documented APIs, licensed feeds, or written data agreements. Each adapter records its legal/operational status, rate limit, cache policy, and permitted redistribution. Residential-proxy rotation and user-agent evasion are not an acceptable production dependency.

## 9. Browser architecture

### 9.1 Client

- TypeScript and React for routing, authentication, accessible panels, and application state.
- Three.js for the real-time world, initially WebGL 2 with a measured WebGPU path.
- Rapier for world collision queries; character movement remains a custom fixed-step controller.
- Zustand or an equivalent small external store for shared UI/game state.
- glTF assets, KTX2 textures, mesh compression, and streamed environment bundles.
- Web Audio with pooled sources and user-controlled volume categories.

React MUST NOT own per-frame transforms. The world uses a fixed simulation step and renders independently; React receives coarse interaction and market state updates.

### 9.2 Routes

```text
/                         Fast landing and Enter World CTA
/world                    First-person gallery
/markets                  Accessible 2D market browser
/markets/:address         Canonical market detail and trade route
/portfolio                Positions, claims, history
/oracle                   Venue and report transparency
/docs                     Rules, risks, and resolution methodology
```

The 3D exhibit and `/markets/:address` open the same market module. Deep links never require loading the 3D bundle.

### 9.3 Performance budgets

- First useful 2D content under 2 seconds on a typical broadband laptop.
- 3D entry bundle under 5 MB compressed; additional assets stream after entry.
- Stable 60 FPS at 1080p on the reference mid-range laptop in the launch room.
- No runtime shader compilation hitch during first interaction; warm required variants.
- Quality tiers for shadows, post-processing, pixel ratio, and texture resolution.
- Context-loss recovery returns the user to the same exhibit and preserves any unsigned trade draft.

## 10. Application API and indexing

The browser does not reconstruct HIP-4 state from raw history on each load. An indexer consumes `outcomeMeta`, order-book snapshots, trades, user fills, positions, and settlement changes into PostgreSQL and serves a versioned API.

Core resources:

- `/v1/assets`
- `/v1/markets`
- `/v1/markets/:outcomeId`
- `/v1/oracle/reports/:id`
- `/v1/portfolio/:address`
- `/v1/books/:coin`
- `/v1/orders/preview`

Fresh HyperCore metadata and book state verify execution-critical values immediately before signing. Indexed values are discovery data, not transaction authority.

Redis may cache hot market lists and coordinate jobs. Oracle observations use durable append-only storage rather than Redis as their source of truth.

## 11. Wallet and transaction UX

- Guests can enter the world, view all data, and use paper balances.
- Wallet creation occurs only when the user chooses live trading.
- Embedded wallets are supported, with an export path and explicit custody disclosure.
- HIP-4 orders use signed HyperCore actions, not ERC-20 approvals or HyperEVM transactions.
- If optional HyperEVM features are exposed, show their HYPE gas requirement separately and never imply HYPE is needed for a HIP-4 order.
- Every confirmation shows HIP-4 outcome ID, side coin, direction, size, limit price, time in force, estimated fill, fee, expiry, and resolution rule.
- The 3D scene pauses pointer-lock interaction while signing; it never interprets gun input as financial confirmation.
- Failed or rejected actions preserve the draft but never retry a signature automatically. Ambiguous submissions reconcile before retry.

## 12. Security, compliance, and integrity gates

Mainnet is blocked until all of the following are complete:

- Independent review of HIP-4 metadata parsing, action construction, wallet signing, nonce management, and reconciliation.
- Audit of any optional HyperEVM app contract; no such contract is permitted in the market-critical path.
- At least 30 days of recorded oracle-window replays across launch assets.
- Venue access and image/metadata rights review.
- Jurisdiction-specific legal opinion covering event contracts, gambling, financial promotion, sanctions, age gating, KYC/AML, custody, and consumer disclosures.
- Country controls enforced at API, wallet, and order-submission layers where required; landing-page IP filtering alone is insufficient.
- Market surveillance for self-trading, sybil behavior, oracle-linked accounts, and unusual pre-resolution activity.
- Incident response for bad reports, venue outages, compromised operator keys, API disconnections, duplicate actions, and indexer divergence.

No copy may claim “no Valve risk,” “decentralized,” “risk free,” or “audited” unless the precise claim is currently true and documented.

## 13. Testing requirements

### 13.1 HIP-4 integration

- Recorded `outcomeMeta` fixtures for every supported schema and market class.
- Property tests for outcome/side-coin mapping and unknown-schema rejection.
- Tick size, lot size, minimum notional, and decimal validation from live metadata.
- Limit, IOC, GTC, post-only, cancel, and replace action construction.
- Signing-domain, network, master/agent address, nonce, expiry, and client-order-ID tests.
- Disconnect recovery from snapshot plus deltas without duplicate fills.
- Ambiguous submission reconciliation before retry.
- Position and PnL parity against HyperCore responses through settlement.

### 13.2 Oracle

- Recorded venue fixtures with schema-version detection.
- Window completeness, stale FX, divergence, identity mismatch, and insufficient-source cases.
- Reproducible report from identical observation sets regardless of input order.
- Signed-report verification and raw-observation Merkle proof tests.
- Historical replay around known price spikes.

### 13.3 Browser

- Unit tests for market-term rendering and transaction previews.
- Playwright coverage for guest entry, 2D trade, world-to-market interaction, wallet rejection, order cancellation, and settled-position display.
- Visual regression snapshots for quality tiers.
- Performance traces on the reference laptop and integrated-GPU fallback.
- Pointer-lock, focus loss, context loss, reduced motion, and keyboard-only 2D navigation.

## 14. Delivery plan

### Phase 0 — Product proof

Deliver one original room, movement, one firing lane, three market exhibits, the shared market drawer, fixture price histories, and a local HIP-4-shaped paper CLOB. No wallet and no live scraping.

Exit criteria: new users can enter, find a market, understand its resolution rule, and place a paper prediction without instruction.

### Phase 1 — Oracle proof

Implement three compliant venue adapters or licensed fixture-equivalent feeds, a 60-minute observation window, deterministic reports, historical replay, and oracle transparency UI.

Exit criteria: 30 consecutive days of reports can be independently reproduced from retained observations.

### Phase 2 — HIP-4 testnet integration

Implement `outcomeMeta` discovery, HIP-4 side mapping, books, orders, cancels, fills, positions, settlement display, agent-wallet handling, and exhaustive reconciliation tests against Hyperliquid testnet. Validate the market registration and settlement adapter only through interfaces actually enabled and documented for the target network.

Exit criteria: adversarially reviewed signing code and an end-to-end testnet order through HIP-4 settlement in both 2D and 3D entry paths.

### Phase 3 — Closed live beta

Add embedded wallets, production indexer, monitoring, support tooling, restricted jurisdictions, and a deliberately small market set with capped exposure.

Exit criteria: security audit resolved, legal gates signed off, oracle operations staffed, and incident drills passed.

### Phase 4 — Expansion

Consider more assets, venue-spread markets, Discord notifications, licensed catalog imagery, public API access, and carefully reviewed news-driven market creation only after core retention and settlement reliability are proven.

## 15. Decisions that remain open

These choices require prototypes or external review rather than assumptions:

- Final product name and relationship between HyperStrike and SkinCast.
- Exact launch jurisdictions and whether live HIP-4 trading is offered directly or through a licensed partner.
- Availability and requirements of the HIP-4 builder/deployment path for CS2 skin markets.
- HIP-4-supported settlement-source, exceptional-resolution, fee, and revenue-share rules.
- Licensed source for skin imagery and catalog metadata.
- Venue basket and executable-price definition per asset class.
- Market-maker strategy, quote width, inventory limits, and maximum per-market exposure on the HIP-4 CLOB.
- Embedded-wallet and revocable Hyperliquid agent-wallet strategy.
- Which oracle/reporting design HIP-4 will authorize for the launch skin-price policy.

Until decided, implementations expose configuration and use conservative testnet defaults; they do not invent production claims.

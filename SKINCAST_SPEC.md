# SkinCast — Archived Build Specification

> **Archived:** This document is historical source material and is no longer authoritative. Do not implement it as written. The current product direction and corrected market/oracle design live in [`HYPERSTRIKE_SPEC.md`](./HYPERSTRIKE_SPEC.md).

> **Historical instruction only.** The implementation prompts below are preserved to explain the earlier concept; they are superseded by the current specification.

---

## 0. Product summary

SkinCast is a Counter-Strike skin **prediction market + price oracle + trading-tool suite**, all in one stack.

Three product surfaces, one shared infrastructure:

1. **Prediction markets** — Users bet on where specific skin prices land by a given date, settled in USDC on Base, resolved by a decentralized oracle network. Includes traditional binary threshold markets, **cross-platform spread markets** (unique to SkinCast — exploits the Steam vs Buff163 vs Skinport gaps that aren't accessible elsewhere), and **auto-created news-event markets** that go live within 90 seconds of player retirements, team transfers, and Major wins (the +50–400% moves traders already chase informally).
2. **Public price oracle API** — The same multi-venue weighted median that resolves markets is exposed as a paid HTTP API. Free tier 100 req/day, $20/mo for 100k req/day. Operators that run scrapers earn a pro-rata share of API revenue weighted by attestation count. This turns infrastructure cost into a revenue line and creates the canonical price feed for the broader CS trading ecosystem.
3. **Discord-native trading suite** — Slash commands for navigation, embed buttons for actions, plus a wallet-free **scanner suite** (`/arbitrage`, `/tradeup`, `/float`, `/spread`, `/ask`, `/news`) that drives DAU even between trading sessions. Privy embedded wallets for humans, Coinbase Agentic Wallets for autonomous agents.

**Primary UI:** Discord bot. CS traders already speculate in Discord — we meet them there.

**Secondary UI:** Landing page that routes visitors to (a) the Discord bot, (b) the OpenClaw oracle skill installer, and (c) the public price API key dashboard.

**Settlement:** Base mainnet. USDC-denominated. Binary markets at launch (threshold, spread, news-event); scalar/categorical later.

**Oracle:** Python skill polling Buff163 (primary, highest weight), CS.MONEY, Skinport, plus CSFloat for float-tier markets. Weighted median with stale/divergence/confidence filters. Publishes resolutions on-chain via authorized signer. Packaged as an OpenClaw skill so third parties can run oracle nodes and earn API + resolution rewards.

---

## 0.5 Design principles

These are non-negotiable cross-cutting choices. Every phase must honor them.

1. **Agent-first.** Every user-facing command and every oracle operation must be usable by an autonomous agent without human interaction. Discord bot uses Privy embedded wallets (humans) and supports Coinbase Agentic Wallets (agents). Oracle CLI is headless by default; `init` is the only interactive command. All write commands accept `--dry-run` and all quote/preview paths are read-only.
2. **Custom errors, not revert strings.** Every revert in every contract uses a typed custom error. Errors are documented as a single reference list in each contract (see section 4.1.5). This is both a gas decision and a developer-ergonomics decision — ABIs carry error selectors, so off-chain callers can surface friendly messages.
3. **Immutable contracts; multi-sig pause only.** Contracts do not have upgrade proxies. Emergency pause lives on `MarketFactory` behind a 2-of-3 Safe. Existing markets continue trading during pause; only new market creation is gated. All disclosures must state this plainly. A discovered exploitable bug is remediated by deploying a new contract and announcing migration — see section 9.2.
4. **Dispute windows everywhere it matters.** No oracle resolution is final instantly. A 24-hour dispute window follows every `resolve()`, during which any registered oracle with ≥2× the resolving oracle's stake can submit a challenge. After the window, `finalize()` transitions the market to `Resolved` and claims open. See 4.4.
5. **Explicit Invalid outcome semantics.** `Outcome.Invalid` is a first-class result — not an error. It triggers pro-rata refund. The conditions that produce it are bounded and testable (section 4.4.3). An oracle that cannot satisfy those conditions must submit `Invalid` rather than guessing.
6. **Dry-run and cache everywhere.** Every off-chain component has a dry-run mode that produces logged tx hex instead of broadcasting. Every external API call is cached with an explicit TTL policy (section 5.2.6). CI works offline via fixture fallback.
7. **Dust goes to pool, never to msg.sender.** Integer division residues in fee splitting and payout computations accrue to the platform treasury (via `FeeSplitter`). Never to the caller; never silently lost.
8. **Stake before you speak.** Oracle operators post a per-resolution bond in addition to the registration stake (section 4.1). The registration stake bootstraps reputation; the per-resolution bond bounds the cost of a wrong call and funds dispute pay-outs.
9. **Separate concerns across chains and services.** Contracts hold canonical truth. The off-chain oracle proposes resolutions. Discord is a UX layer that reads both. The landing page is read-only + auth handoff. Each component is independently deployable and testable.
10. **Bilingual-ready UI, English-only at launch.** Every user-facing string in the Discord bot and landing page is routed through a translation layer (i18n keys, not inline strings), even though only `en` is populated at launch. Chinese (zh) and Russian (ru) are the known Phase 7 additions — the CS scene's two largest non-English markets. See section 11.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SkinCast System                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌────────────────┐      ┌─────────────────┐              │
│   │ Discord bot    │      │ Landing page    │              │
│   │ (TS/Node)      │      │ (Next.js)       │              │
│   │                │      │                 │              │
│   │ slash + embeds │      │ markets preview │              │
│   │ Privy wallets  │      │ CTA → Discord   │              │
│   │                │      │ CTA → OpenClaw  │              │
│   └───────┬────────┘      └────────┬────────┘              │
│           │                        │                        │
│           └────────────┬───────────┘                        │
│                        │                                    │
│                        ▼                                    │
│           ┌─────────────────────────┐                       │
│           │ Solidity contracts      │                       │
│           │ (Foundry)               │                       │
│           │                         │                       │
│           │  • MarketFactory        │                       │
│           │  • Market (LMSR)        │                       │
│           │  • FeeSplitter          │                       │
│           │  • OracleRegistry       │                       │
│           └───────────┬─────────────┘                       │
│                       ▲                                     │
│                       │ resolve() call                      │
│                       │                                     │
│           ┌───────────┴─────────────┐                       │
│           │ Oracle (Python)         │                       │
│           │                         │                       │
│           │  • Buff163 scraper      │                       │
│           │  • CS.MONEY scraper     │                       │
│           │  • Skinport scraper     │                       │
│           │  • Weighted median agg  │                       │
│           │  • Base publisher       │                       │
│           │  • Scheduler            │                       │
│           │                         │                       │
│           │  Packaged as OpenClaw   │                       │
│           │  skill → ClawHub        │                       │
│           └─────────────────────────┘                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Tech stack

| Layer | Technology | Rationale |
|---|---|---|
| Smart contracts | Solidity 0.8.26, Foundry | Direct fork of BaoClaw patterns |
| Fixed-point math | PRBMath (`UD60x18`) | Audited, ergonomic `ln`/`exp` |
| Contract tests | Foundry (forge) + invariant tests | Native, fast |
| Oracle | Python 3.11, httpx, APScheduler | Fork BaoClaw oracle patterns |
| Oracle on-chain tx | web3.py + eth-account | Standard EVM Python |
| Discord bot | discord.js v14 / TypeScript / Node 20 | Industry default |
| Wallet | Privy embedded EVM wallets | Email/social login, server-side signing, Base-native |
| On-ramp | Coinbase Onramp SDK | USDC-to-Base direct, lowest friction |
| Landing page | Next.js 14 App Router / Tailwind / shadcn/ui | Fast, clean |
| RPC | Alchemy or Base's public RPC + BaseScan | Free tier sufficient for launch |
| Monitoring | Grafana Cloud free tier + Sentry + Tenderly | Tenderly gives EVM tx tracing |
| Deployment | Railway for bot + oracle, Vercel for landing | Zero-ops |

---

## 3. Repository structure

```
skincast/
├── contracts/
│   ├── src/
│   │   ├── MarketFactory.sol
│   │   ├── Market.sol
│   │   ├── OracleRegistry.sol
│   │   ├── FeeSplitter.sol
│   │   ├── interfaces/
│   │   └── lib/
│   │       └── LMSR.sol          # PRBMath-based
│   ├── test/
│   │   ├── Market.t.sol
│   │   ├── MarketFactory.t.sol
│   │   ├── LMSR.t.sol
│   │   ├── invariants/
│   │   └── fixtures/
│   ├── script/
│   │   ├── Deploy.s.sol
│   │   └── SeedMarkets.s.sol
│   ├── foundry.toml
│   └── remappings.txt
├── oracle/                       # Python oracle
│   ├── skincast_oracle/
│   │   ├── __init__.py
│   │   ├── scrapers/
│   │   │   ├── buff163.py
│   │   │   ├── csmoney.py
│   │   │   └── skinport.py
│   │   ├── aggregator.py
│   │   ├── publisher.py          # web3.py client
│   │   ├── scheduler.py
│   │   ├── registry.py
│   │   └── cli.py
│   ├── registry/
│   │   └── tier1.json            # 24 launch assets
│   ├── tests/
│   ├── pyproject.toml
│   └── SKILL.md                  # OpenClaw skill manifest
├── bot/                          # Discord bot
│   ├── src/
│   │   ├── index.ts
│   │   ├── commands/
│   │   │   ├── markets.ts
│   │   │   ├── predict.ts
│   │   │   ├── positions.ts
│   │   │   ├── claim.ts
│   │   │   ├── wallet.ts
│   │   │   └── create.ts
│   │   ├── interactions/
│   │   │   └── buttons.ts
│   │   ├── embeds/
│   │   ├── privy/
│   │   │   └── client.ts
│   │   ├── evm/
│   │   │   ├── client.ts
│   │   │   └── tx.ts
│   │   ├── db/
│   │   │   └── schema.ts         # Drizzle ORM
│   │   └── config.ts
│   ├── package.json
│   └── tsconfig.json
├── web/                          # Landing page
│   ├── app/
│   │   ├── page.tsx
│   │   ├── markets/
│   │   ├── docs/
│   │   └── api/
│   ├── components/
│   ├── lib/
│   ├── public/
│   └── package.json
├── scripts/
│   ├── deploy-base-sepolia.sh
│   ├── deploy-base-mainnet.sh
│   ├── seed-markets.ts
│   └── register-oracle-operator.ts
├── .env.example
├── package.json                  # Root pnpm workspace
├── pnpm-workspace.yaml
├── README.md
└── SKINCAST_SPEC.md              # This file
```

---

## 4. Phase 1 — Solidity contracts

**Goal:** Deploy LMSR binary prediction market contracts to Base Sepolia with full test coverage.

### 4.1 Contracts

**`MarketFactory.sol`** — deploys markets, holds global config. Supports two creation paths: user-paid (`createMarket`) and treasury-funded (`createTreasuryMarket`) for autonomous news-event market creation by an authorized off-chain agent.

```solidity
contract MarketFactory is Ownable2Step, Pausable {
    IERC20 public immutable usdc;
    IOracleRegistry public oracleRegistry;
    FeeSplitter public feeSplitter;

    uint16 public feeBps;                 // 250 = 2.5%
    uint16 public creatorFeeBps;          // portion of feeBps to creator
    uint16 public oracleFeeBps;           // portion of feeBps to oracle operator
    uint64 public minCreatorStake;        // USDC seeded as initial liquidity
    uint64 public marketCount;

    // Treasury-creator mechanism (news-event markets — see 4.1.6)
    address public treasuryCreator;       // authorized agent address; can be a Safe or an EOA
    uint256 public treasuryBalance;       // USDC held by factory as initial-stake reserves
    uint256 public dailyTreasurySpendCap; // hard cap on USDC spent via createTreasuryMarket per UTC day
    uint256 public treasurySpentToday;
    uint64  public treasurySpendDay;      // floor(block.timestamp / 1 days)

    mapping(uint64 => address) public markets;
    mapping(bytes32 => uint64) public marketByKey;  // keccak256(itemHash, resolutionTime, priceThreshold) → marketId+1

    event MarketCreated(uint64 indexed marketId, address market, address creator, bytes32 itemHash, uint64 resolutionTime);
    event TreasuryMarketCreated(uint64 indexed marketId, address market, bytes32 itemHash, bytes32 newsEventId, uint8 newsTier);
    event TreasuryFunded(address indexed from, uint256 amount, uint256 newBalance);
    event TreasurySpendCapUpdated(uint256 oldCap, uint256 newCap);

    function createMarket(
        string calldata question,
        bytes32 itemHash,
        uint64 resolutionTime,
        uint256 priceThreshold,           // YES if oracle price > threshold
        uint256 liquidityParamB,          // LMSR b
        uint256 initialStake,             // USDC from creator, becomes initial reserve
        address oracle                    // must be registered in OracleRegistry
    ) external whenNotPaused returns (address market, uint64 marketId);

    /// @notice Treasury-funded market creation for autonomous news-event markets.
    /// @dev Skips minCreatorStake check; creator field is set to address(this); creator-fee bucket
    ///      accrues to treasury via FeeSplitter. Hard-capped by dailyTreasurySpendCap to bound damage
    ///      from a compromised treasuryCreator key.
    /// @param newsEventId  bytes32 identifier from the news monitor — keccak256(source, postId, timestamp)
    /// @param newsTier     1 = retirement/disbandment, 2 = team transfer/major win, 3 = minor event
    function createTreasuryMarket(
        string calldata question,
        bytes32 itemHash,
        uint64 resolutionTime,
        uint256 priceThreshold,
        uint256 liquidityParamB,
        uint256 initialStake,
        address oracle,
        bytes32 newsEventId,
        uint8 newsTier
    ) external whenNotPaused returns (address market, uint64 marketId);

    // Treasury management (owner only)
    function fundTreasury(uint256 amount) external;                    // pulls USDC from caller
    function setTreasuryCreator(address creator) external onlyOwner;
    function setDailyTreasurySpendCap(uint256 cap) external onlyOwner;
    function withdrawTreasury(address to, uint256 amount) external onlyOwner;
}
```

**Treasury creator authorization model:**
- `treasuryCreator` is a single address — typically a Safe 2-of-3 controlling an EOA used by the news monitor service. Why an intermediate EOA? Hot-key risk: the news monitor needs to sign without human approval for the killer-feature 60-second-from-news-to-market window. The Safe owns the EOA's stake of treasury USDC and can rotate it instantly if compromised.
- `dailyTreasurySpendCap` (default 5000 USDC) bounds the loss if the EOA key leaks. At 100 USDC default `initialStake` per market that's max 50 markets/day from a hijacked key — easily caught by monitoring.
- Treasury creator cannot create markets with `oracle == address(0)` or with `itemHash` that resolves to no-cache asset (off-chain enforcement only — the factory accepts any 32-byte hash).

### 4.1.6 News-event market template parameters

Treasury-created markets use a fixed parameter envelope so the news monitor's classifier can produce them mechanically without per-event tuning:

| Parameter | Tier 1 (retirement, disband) | Tier 2 (transfer, major win) | Tier 3 (minor) |
|---|---|---|---|
| `resolutionTime` | now + 72h | now + 96h | now + 168h |
| `liquidityParamB` | 500 USDC | 250 USDC | 100 USDC |
| `initialStake` | 200 USDC | 100 USDC | 50 USDC |
| `priceThreshold` | current_median × 1.5 | current_median × 1.3 | current_median × 1.15 |
| Question template | "Will [asset] close ≥ 50% above pre-event price within 72h?" | "Will [asset] close ≥ 30% above within 96h?" | "Will [asset] close ≥ 15% above within 168h?" |

These thresholds match the article's empirical move ranges. The `current_median × multiplier` calculation runs at creation time using the same aggregator the eventual resolution will use — guaranteeing the threshold is denominated in the right venue blend.

**`Market.sol`** — one deployment per market. Adds a dispute window between `Closed → Proposed → Resolved` so a faulty resolution is not instantly final.

```solidity
contract Market is ReentrancyGuard {
    using UD60x18 for uint256;

    enum State { Open, Closed, Proposed, Resolved, Cancelled }
    enum Outcome { None, Yes, No, Invalid }

    MarketFactory public immutable factory;
    IERC20 public immutable usdc;
    address public immutable oracle;          // primary oracle assigned at creation
    address public immutable creator;

    string public question;
    bytes32 public itemHash;
    uint64 public resolutionTime;
    uint256 public priceThreshold;
    uint256 public liquidityParamB;           // UD60x18

    // LMSR state
    uint256 public qYes;                      // UD60x18 net YES shares
    uint256 public qNo;                       // UD60x18 net NO shares
    uint256 public feesAccrued;

    // Lifecycle
    State public state;
    Outcome public proposedOutcome;           // set at resolve()
    Outcome public outcome;                   // set at finalize()
    uint256 public resolutionPrice;
    address public resolvingOracle;           // may be oracle OR a backup after grace
    uint64  public proposedAt;                // block.timestamp when resolve() was called
    uint64  public disputeWindow;             // seconds; factory-configured default 24h
    uint256 public perResolutionBond;         // USDC locked by resolving oracle, returned on finalize
    address public challenger;                // first to dispute; 0x0 if none
    uint256 public challengerBond;            // USDC locked by challenger, 2× perResolutionBond
    Outcome public counterOutcome;            // challenger's proposed alternative

    mapping(address => uint256) public yesShares;   // UD60x18
    mapping(address => uint256) public noShares;
    mapping(address => bool) public claimed;

    event Buy(address indexed user, bool isYes, uint256 shares, uint256 cost, uint256 newProb);
    event Sell(address indexed user, bool isYes, uint256 shares, uint256 proceeds, uint256 newProb);
    event ResolutionProposed(address indexed resolver, Outcome outcome, uint256 price, uint256 bond);
    event ResolutionChallenged(address indexed challenger, Outcome counterOutcome, uint256 bond);
    event ResolutionFinalized(Outcome outcome, uint256 price, address winner, uint256 payout);
    event Claimed(address indexed user, uint256 payout);
    event Cancelled(bytes32 reason);

    // Trading
    function buy(bool isYes, uint256 sharesOut, uint256 maxCost) external nonReentrant;
    function sell(bool isYes, uint256 sharesIn, uint256 minProceeds) external nonReentrant;

    // Lifecycle
    function close() external;                                      // anyone after resolutionTime
    function resolve(Outcome _outcome, uint256 _price) external;    // primary oracle OR backup after BACKUP_DELAY
    function challenge(Outcome _counterOutcome) external;           // any registered oracle with stake ≥ 2× perResolutionBond
    function finalize() external;                                   // anyone after disputeWindow, adjudicates if challenged
    function claim() external nonReentrant;
    function cancel(bytes32 reason) external;                       // factory owner, specific bounded reasons only
    function invalidateResolution() external;                       // factory owner, only within disputeWindow
}
```

**Backup oracle path:** if `state == Closed` and `block.timestamp > resolutionTime + BACKUP_DELAY` (48h default) and the primary `oracle` has not called `resolve()`, any address registered and active in `OracleRegistry` may call `resolve()`. `resolvingOracle` records who actually submitted. Rewards and bond penalties follow `resolvingOracle`, not the assigned `oracle`.

**Challenge flow:** during `disputeWindow`, a challenger posts `2 × perResolutionBond` and a counter-outcome. This transitions the market to awaiting arbitration. Arbitration is deterministic: the factory owner (Safe 2-of-3) calls `finalize(Outcome winningOutcome)` referencing off-chain evidence; the losing side forfeits its bond to the winning side (50%) and the platform treasury (50%). If no challenge is posted, `finalize()` at the end of the window confirms `proposedOutcome` and returns `perResolutionBond` to `resolvingOracle`.

**`OracleRegistry.sol`** — registered oracle operators, their registration stake, and a separate per-resolution bond escrow. Resolution bonds are locked on `resolve()` and returned on uncontested `finalize()`.

```solidity
contract OracleRegistry is Ownable2Step {
    struct Oracle {
        address operator;
        string  name;
        uint256 stake;                  // registration stake (USDC), gates registry membership
        uint256 lockedInResolutions;    // sum of active per-resolution bonds
        int256  reputationScore;        // +1 per uncontested finalize, −3 per lost challenge
        uint64  cooldownUntil;          // if deactivate() called, stake unlocks at this timestamp
        bool    active;
    }

    mapping(address => Oracle) public oracles;
    address[] public operatorList;      // iterable registry for backup-oracle fallback
    uint256 public minStake;            // e.g. 1000 USDC
    uint256 public perResolutionBond;   // e.g. 100 USDC; Market pulls this on resolve()
    uint64  public cooldownPeriod;      // e.g. 14 days between deactivate() and stake withdrawal

    // Lifecycle
    function register(string calldata name, uint256 initialStake) external;
    function increaseStake(uint256 amount) external;
    function deactivate() external;                                     // enters cooldown
    function withdrawStake() external;                                  // only after cooldownUntil

    // Per-resolution bond escrow, callable only by Market contracts via factory
    function lockResolutionBond(address operator) external returns (uint256 bondAmount);
    function releaseResolutionBond(address operator) external;
    function forfeitResolutionBond(address operator, address to) external;

    // Governance
    function slash(address operator, uint256 amount) external onlyOwner;  // lost dispute, off-chain proof
    function setMinStake(uint256) external onlyOwner;
    function setPerResolutionBond(uint256) external onlyOwner;

    // Read
    function canResolve(address operator) external view returns (bool);
    function activeOperatorCount() external view returns (uint256);
}
```

**`FeeSplitter.sol`** — accumulates platform trading fees, splits into three buckets on withdrawal: platform treasury, market creator, resolving oracle. Dust goes to treasury.

```solidity
contract FeeSplitter {
    MarketFactory public immutable factory;
    IERC20        public immutable usdc;

    // Per-recipient pending balances (pull-payment pattern — never push)
    mapping(address => uint256) public pending;
    uint256 public treasuryPending;

    function recordFee(uint256 amount, address creator, address oracle) external;  // only from Market
    function withdraw() external;                                                   // caller's balance
    function withdrawTreasury(address to) external;                                 // factory owner only
}
```

**Default fee parameters** (factory-configurable, set at deploy time):

| Parameter | Value | Rationale |
|---|---|---|
| `feeBps` | 250 (2.5%) | Polymarket-aligned; covers oracle + creator + platform |
| Platform split | 40% | Covers infra, on-chain costs, future audits |
| Creator split | 30% | Incentive to create high-quality markets |
| Oracle split | 30% | Rewards the operator who actually resolved the market |
| `minCreatorStake` | 100 USDC | Spam deterrent on `/create` |
| `perResolutionBond` | 100 USDC | Pulled from oracle's registry stake on `resolve()`, returned on clean finalize |
| `disputeWindow` | 86400 (24h) | Window for challenger to post 2× bond |
| `BACKUP_DELAY` | 172800 (48h) | After this much past `resolutionTime`, any registered oracle may resolve |
| `GRACE_PERIOD` | 604800 (7d) | After this much past `resolutionTime` with no resolve at all, factory owner may cancel |

Fee flow worked example — at $10k daily volume × 2.5% fee = $250/day:
- $100/day → treasury pending
- $75/day → split pro-rata across creators of traded markets
- $75/day → resolving oracle (paid out at finalize)
- Dust (wei rounding) → treasury

### 4.1.5 Canonical custom errors

Every contract uses typed custom errors, not revert strings. Complete authoritative list — implementations must match these selectors exactly.

**`Market.sol`:**

| Error | Raised when |
|---|---|
| `MarketNotOpen()` | `buy`/`sell` called outside `State.Open` |
| `MarketExpired()` | `buy`/`sell` called after `resolutionTime` |
| `MarketNotExpired()` | `close()` called before `resolutionTime` |
| `MarketNotClosed()` | `resolve()` called outside `State.Closed` |
| `MarketNotProposed()` | `challenge()` or `finalize()` called outside `State.Proposed` |
| `MarketNotFinal()` | `claim()` called outside `{Resolved, Cancelled}` |
| `AlreadyClaimed()` | Double-claim guard |
| `SlippageExceeded(uint256 needed, uint256 limit)` | `maxCost` or `minProceeds` violated |
| `InvalidOutcome()` | `resolve` given an outcome not in {Yes, No, Invalid} |
| `NotAuthorizedOracle()` | Non-primary and non-registered caller tried `resolve()` |
| `BackupDelayNotElapsed()` | Backup oracle tried `resolve()` before `BACKUP_DELAY` |
| `DisputeWindowOpen()` | `finalize()` called before `proposedAt + disputeWindow` |
| `DisputeWindowClosed()` | `challenge()` called after window |
| `InsufficientChallengerStake()` | Challenger's registry stake < 2× `perResolutionBond` |
| `AlreadyChallenged()` | Second challenge on the same proposal |
| `ReservesInsufficient(uint256 needed, uint256 have)` | LMSR would require more USDC than is in the contract; transitions to `Invalid` |
| `ZeroShares()` | `buy`/`sell` with amount 0 |
| `CancelReasonInvalid(bytes32)` | `cancel()` reason not in allowed set |

**`MarketFactory.sol`:**

| Error | Raised when |
|---|---|
| `FactoryPaused()` | `createMarket` while paused |
| `OracleNotRegistered()` | `createMarket` with oracle not in `OracleRegistry.canResolve` |
| `ResolutionTimeInPast()` | `createMarket` with `resolutionTime < block.timestamp + MIN_MARKET_DURATION` |
| `ResolutionTimeTooFar()` | `createMarket` with `resolutionTime > block.timestamp + MAX_MARKET_DURATION` |
| `LiquidityTooLow()` | `initialStake < minCreatorStake` or `liquidityParamB < MIN_B` |
| `DuplicateMarket(bytes32)` | Same `(itemHash, resolutionTime, priceThreshold)` already exists |

**`OracleRegistry.sol`:**

| Error | Raised when |
|---|---|
| `AlreadyRegistered()` | `register()` a second time |
| `NotRegistered()` | Any op on unregistered address |
| `StakeBelowMinimum(uint256 have, uint256 need)` | Registration or post-slash balance too low |
| `CooldownActive(uint64 until)` | `withdrawStake()` before `cooldownUntil` |
| `StakeLocked()` | `withdrawStake()` while `lockedInResolutions > 0` |
| `NotCallableFromMarket()` | Bond escrow functions called by non-Market address |
| `OperatorInactive()` | `lockResolutionBond` on deactivated operator |

**`FeeSplitter.sol`:**

| Error | Raised when |
|---|---|
| `NotCallableFromMarket()` | `recordFee` from non-Market address |
| `NothingPending()` | `withdraw()` with zero balance |

### 4.2 LMSR math (critical)

Log Market Scoring Rule. Cost function:

```
C(q_yes, q_no) = b * ln(exp(q_yes / b) + exp(q_no / b))
```

**Implementation via PRBMath:**

```solidity
library LMSR {
    using UD60x18 for uint256;

    // Cost of moving from (qYes, qNo) to (qYes + dYes, qNo + dNo)
    function cost(uint256 qYesBefore, uint256 qNoBefore, uint256 qYesAfter, uint256 qNoAfter, uint256 b)
        internal pure returns (uint256);

    // Marginal price of YES at current state
    function priceYes(uint256 qYes, uint256 qNo, uint256 b) internal pure returns (uint256);
}
```

Use PRBMath's `exp` and `ln` on `UD60x18`. Clamp `q/b` to `[0, 40e18]` before `exp` to prevent overflow — PRBMath's `exp` overflows around 133.

Write a Python reference in `contracts/test/fixtures/lmsr_reference.py` using `mpmath` with 50 decimal places. Foundry fuzz test compares Solidity output to a precomputed JSON of reference values (~10k cases) read via `vm.readFile`.

### 4.3 Buy flow

```solidity
function buy(bool isYes, uint256 sharesOut, uint256 maxCost) external nonReentrant {
    require(state == State.Open, "not open");
    require(block.timestamp < resolutionTime, "expired");

    uint256 qYesNew = isYes ? qYes + sharesOut : qYes;
    uint256 qNoNew = isYes ? qNo : qNo + sharesOut;

    uint256 netCost = LMSR.cost(qYes, qNo, qYesNew, qNoNew, liquidityParamB);
    uint256 fee = (netCost * factory.feeBps()) / 10_000;
    uint256 total = netCost + fee;
    require(total <= maxCost, "slippage");

    usdc.safeTransferFrom(msg.sender, address(this), total);

    qYes = qYesNew;
    qNo = qNoNew;
    feesAccrued += fee;

    if (isYes) yesShares[msg.sender] += sharesOut;
    else noShares[msg.sender] += sharesOut;

    emit Buy(msg.sender, isYes, sharesOut, total, LMSR.priceYes(qYes, qNo, liquidityParamB));
}
```

### 4.4 Resolve, challenge, finalize, claim

**State machine** (post section 0.5 principle 4):

```
Open ──close()──► Closed ──resolve()──► Proposed ──finalize()──► Resolved ──claim()──► (user funds out)
                                          │
                                          └─── challenge() ───► Proposed (awaits owner arbitration via finalize)

Closed ──cancel() [bounded reasons, after GRACE_PERIOD]──► Cancelled
Proposed ──invalidateResolution() [factory owner, within disputeWindow]──► Closed (retries)
```

#### 4.4.1 `resolve()` — propose an outcome

```solidity
function resolve(Outcome _outcome, uint256 _price) external {
    if (state != State.Closed) revert MarketNotClosed();
    if (_outcome == Outcome.None) revert InvalidOutcome();

    // Auth: primary oracle, or any registered active oracle after BACKUP_DELAY
    bool isPrimary = msg.sender == oracle;
    bool isBackup  = !isPrimary
        && block.timestamp > resolutionTime + factory.BACKUP_DELAY()
        && factory.oracleRegistry().canResolve(msg.sender);
    if (!isPrimary && !isBackup) revert NotAuthorizedOracle();

    // Solvency check: reserves must cover the maximum possible payout for the winning outcome.
    uint256 maxPayout = _outcome == Outcome.Yes ? qYesTotalOutstanding()
                     : _outcome == Outcome.No  ? qNoTotalOutstanding()
                     : yesShares + noShares; // Invalid = refund everyone
    uint256 reserves = usdc.balanceOf(address(this)) - feesAccrued;
    if (reserves < maxPayout) revert ReservesInsufficient(maxPayout, reserves);

    // Pull per-resolution bond from the resolving oracle's registry stake
    uint256 bond = factory.oracleRegistry().lockResolutionBond(msg.sender);
    perResolutionBond = bond;
    resolvingOracle   = msg.sender;
    proposedOutcome   = _outcome;
    resolutionPrice   = _price;
    proposedAt        = uint64(block.timestamp);
    disputeWindow     = factory.disputeWindow();
    state             = State.Proposed;

    emit ResolutionProposed(msg.sender, _outcome, _price, bond);
}
```

#### 4.4.2 `challenge()` and `finalize()`

```solidity
function challenge(Outcome _counterOutcome) external {
    if (state != State.Proposed) revert MarketNotProposed();
    if (block.timestamp > proposedAt + disputeWindow) revert DisputeWindowClosed();
    if (challenger != address(0)) revert AlreadyChallenged();
    if (_counterOutcome == proposedOutcome || _counterOutcome == Outcome.None) revert InvalidOutcome();

    uint256 needed = 2 * perResolutionBond;
    if (factory.oracleRegistry().oracles(msg.sender).stake
        - factory.oracleRegistry().oracles(msg.sender).lockedInResolutions < needed) {
        revert InsufficientChallengerStake();
    }

    usdc.safeTransferFrom(msg.sender, address(this), needed);
    challenger      = msg.sender;
    challengerBond  = needed;
    counterOutcome  = _counterOutcome;

    emit ResolutionChallenged(msg.sender, _counterOutcome, needed);
}

function finalize() external {
    if (state != State.Proposed) revert MarketNotProposed();
    if (block.timestamp <= proposedAt + disputeWindow) revert DisputeWindowOpen();

    if (challenger == address(0)) {
        // Uncontested: accept proposed outcome, return oracle's bond, +1 reputation
        outcome = proposedOutcome;
        factory.oracleRegistry().releaseResolutionBond(resolvingOracle);
        _flushFees(resolvingOracle);
        emit ResolutionFinalized(outcome, resolutionPrice, resolvingOracle, 0);
    } else {
        // Contested: factory owner (Safe 2-of-3) must call arbitration path instead.
        // This branch only fires if owner did not arbitrate within a second window;
        // defaults to Invalid and refunds both bonds.
        if (block.timestamp <= proposedAt + disputeWindow + factory.ARBITRATION_WINDOW()) {
            revert DisputeWindowOpen();
        }
        outcome = Outcome.Invalid;
        usdc.safeTransfer(challenger, challengerBond);
        factory.oracleRegistry().releaseResolutionBond(resolvingOracle);
        _flushFees(address(0)); // no oracle reward — Invalid
        emit ResolutionFinalized(outcome, resolutionPrice, address(0), 0);
    }
    state = State.Resolved;
}

// Factory owner only, within arbitration window. Adjudicates a challenged resolution.
function arbitrate(Outcome _winningOutcome) external {
    if (msg.sender != factory.owner()) revert NotAuthorizedOracle();
    if (state != State.Proposed) revert MarketNotProposed();
    if (challenger == address(0)) revert InvalidOutcome();

    outcome = _winningOutcome;

    if (_winningOutcome == proposedOutcome) {
        // Primary oracle wins: gets bond back + 50% of challenger's bond. 50% to treasury.
        factory.oracleRegistry().releaseResolutionBond(resolvingOracle);
        uint256 reward = challengerBond / 2;
        usdc.safeTransfer(resolvingOracle, reward);
        usdc.safeTransfer(address(factory.feeSplitter()), challengerBond - reward);
        factory.oracleRegistry().slash(challenger, 0); // reputation only; stake already forfeit
        _flushFees(resolvingOracle);
    } else {
        // Challenger wins: gets 150% of their bond (original + half oracle's). Primary slashed.
        factory.oracleRegistry().forfeitResolutionBond(resolvingOracle, challenger);
        usdc.safeTransfer(challenger, challengerBond + perResolutionBond / 2);
        usdc.safeTransfer(address(factory.feeSplitter()), perResolutionBond / 2);
        _flushFees(challenger);
    }

    state = State.Resolved;
    emit ResolutionFinalized(outcome, resolutionPrice,
        _winningOutcome == proposedOutcome ? resolvingOracle : challenger,
        challengerBond);
}
```

#### 4.4.3 `Outcome.Invalid` — explicit criteria

An oracle MUST submit `Outcome.Invalid` if any of the following is true at resolution time. These are the *only* conditions — the oracle is not allowed to return `Invalid` for discretionary reasons:

| Condition | Detail |
|---|---|
| **Source count** | Fewer than 2 venues returned a price within `VENUE_FRESHNESS` (default 30 min) |
| **Confidence** | After outlier exclusion (>2σ from mean), fewer than 2 venues remain |
| **Divergence** | Range of surviving venue prices > 15% of their median |
| **Reserve solvency** | Contract reserves < max payout for either Yes or No (market ran dry via fees or precision loss) |
| **Itemhash unresolvable** | `itemHash` points to an item that no longer exists on any tracked venue (delisted skin, renamed collection, etc.) |

Each condition is enumerable so the oracle's audit log can cite which criterion fired. The oracle SDK exposes this as an enum `InvalidReason`.

#### 4.4.4 `claim()`

```solidity
function claim() external nonReentrant {
    if (state != State.Resolved && state != State.Cancelled) revert MarketNotFinal();
    if (claimed[msg.sender]) revert AlreadyClaimed();
    claimed[msg.sender] = true;

    uint256 payout;
    if (state == State.Cancelled || outcome == Outcome.Invalid) {
        payout = _refundAmount(msg.sender);         // pro-rata against shares × current cost basis
    } else if (outcome == Outcome.Yes) {
        payout = yesShares[msg.sender];             // 1 YES share = 1 USDC
    } else if (outcome == Outcome.No) {
        payout = noShares[msg.sender];
    }

    if (payout > 0) usdc.safeTransfer(msg.sender, payout);
    emit Claimed(msg.sender, payout);
}
```

#### 4.4.5 `cancel()` — bounded reasons only

`cancel(bytes32 reason)` is callable only by `factory.owner()`. `reason` must be one of the following bytes32 constants (emitted in the `Cancelled` event for audit):

- `"NO_RESOLUTION_AFTER_GRACE"` — no `resolve()` call within `resolutionTime + GRACE_PERIOD` (7 days)
- `"ITEM_DELISTED"` — underlying skin permanently unavailable on all venues
- `"REGULATORY"` — jurisdiction-specific legal requirement
- `"CRITICAL_BUG"` — pause + migrate scenario per section 9.2

Any other `reason` reverts with `CancelReasonInvalid(bytes32)`.

### 4.5 Prompt to paste to Claude Code

> Implement the Solidity contracts at `contracts/` per section 4 of `SKINCAST_SPEC.md`. Requirements:
>
> 1. Scaffold with `forge init contracts`. Solidity 0.8.26. Foundry stable channel.
> 2. Install deps: `@openzeppelin/contracts` v5 (for `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`), `@prb/math` v4 for `UD60x18`, `forge-std`. Set remappings.
> 3. Implement all four contracts per 4.1 with the exact function signatures AND the exact custom-error selectors enumerated in 4.1.5. USDC is the real Base USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on mainnet, `0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Base Sepolia. Use `SafeERC20` for all transfers. No `require(..., "string")`; every revert uses a typed custom error.
> 4. Implement `LMSR.sol` library per 4.2 using PRBMath's `UD60x18.ln` and `.exp`. Clamp `q/b` arguments to `[0, 40e18]`. Write a reference implementation in `contracts/test/fixtures/lmsr_reference.py` using `mpmath` with 50 decimal places and pre-generate `lmsr_cases.json` with 10,000 random `(qYes, qNo, delta, b)` inputs and expected costs at 18 decimals. Foundry fuzz test reads this file and asserts Solidity output within 1000 wei of reference (pre-adjusted for rounding).
> 5. Implement buy/sell per 4.3 with slippage protection. Implement the full state machine in 4.4: `resolve → challenge → finalize → claim`, with the `arbitrate`, `invalidateResolution`, and bounded-reason `cancel` paths. `Outcome.Invalid` criteria per 4.4.3 are enforced off-chain by the oracle but documented in a commented constant block in `Market.sol` so on-chain readers see the contract's expectations.
> 6. Fee flow per 4.1 defaults: platform 40% / creator 30% / oracle 30% of `feeBps`. Markets call `FeeSplitter.recordFee(feesAccrued, creator, resolvingOracle)` at finalize time (not resolve time — fees are only paid out on final outcomes, and the recipient is `resolvingOracle`, which may differ from the market's primary `oracle` if the backup path was taken). Dust goes to treasury.
> 7. `OracleRegistry` per-resolution bond escrow: `lockResolutionBond(operator)` pulls `perResolutionBond` from the operator's `stake` into `lockedInResolutions`, returns the amount; callable only by contracts the `MarketFactory` has deployed (validate via `factory.markets(marketId) == msg.sender`). `releaseResolutionBond` and `forfeitResolutionBond(operator, to)` mirror it.
> 8. Comprehensive Foundry test suite in `contracts/test/` — **minimum 120 tests total**:
>    - `Market.t.sol` — all state transitions including the full dispute path (propose → challenge → arbitrate-primary-wins, propose → challenge → arbitrate-challenger-wins, propose → no-challenge → finalize, propose → challenge → no-arbitration → default-to-Invalid). Backup oracle path. All five `Invalid` criteria in 4.4.3. All four bounded `cancel` reasons. Gas-bounded claim/buy/sell. Target: 60+ tests.
>    - `LMSR.t.sol` — unit + fuzz tests including the 10k reference comparison. Target: 20+ tests.
>    - `MarketFactory.t.sol` — market creation, fee config, pause, authority transfer, duplicate detection, duration bounds. Target: 20+ tests.
>    - `OracleRegistry.t.sol` — register, stake up/down, cooldown, deactivation, per-resolution bond lock/release/forfeit, authorization (only markets can lock). Target: 15+ tests.
>    - `FeeSplitter.t.sol` — recordFee, withdraw, treasury withdrawal, split math, dust accrual. Target: 10+ tests.
>    - `TreasuryCreator.t.sol` — `createTreasuryMarket` happy path; daily spend cap reset on day rollover; spend cap exceeded reverts; only `treasuryCreator` can call; treasury depletion reverts cleanly; `setTreasuryCreator` rotation; key-loss simulation (cap-bounded loss across N markets). Target: 12+ tests.
>    - `invariants/MarketInvariants.t.sol` — sum of YES/NO prices ∈ [0.99, 1.01]; cost monotonic in q; share supply = qYes + qNo; reserves ≥ max possible payout at all times (enforced via `ReservesInsufficient` revert before state transitions); no double-claim; claimed[user] monotonic; perResolutionBond accounting matches OracleRegistry state; `treasurySpentToday ≤ dailyTreasurySpendCap` always; `marketByKey` round-trips.
> 9. Deploy script `script/Deploy.s.sol` that deploys in order: `FeeSplitter` → `OracleRegistry` → `MarketFactory` (which references the other two), then calls `factory.setFeeSplitter`, `factory.setOracleRegistry`, `feeSplitter.setFactory`, `oracleRegistry.setFactory`. Outputs the deployment JSON to `deployments/<chainId>.json`.
> 10. Seed script `script/SeedMarkets.s.sol` that creates 5 demo markets on Base Sepolia reading from `script/launch-markets.json`. Each seeded market must have: valid assigned oracle (registered with ≥ `minStake`), `initialStake ≥ minCreatorStake`, `resolutionTime` between `now + 1h` and `now + 30d`.
> 11. `foundry.toml` with optimizer enabled (runs 10_000), via-IR on, gas reports on tests, Base Sepolia + mainnet RPC configs. Profile `ci` that adds `verbosity = 3` and `fuzz = { runs = 10_000 }` for the LMSR parity test.
> 12. `package.json` scripts: `pnpm forge:build`, `pnpm forge:test`, `pnpm forge:fmt`, `pnpm forge:deploy:sepolia`, `pnpm forge:deploy:mainnet`, `pnpm forge:seed:sepolia`.
>
> Do not implement the oracle, bot, or web yet. Commit as "feat(contracts): LMSR binary prediction markets with dispute window on Base".

### 4.6 Acceptance criteria

- `forge test` passes all 120+ cases
- LMSR reference parity test passes 10,000 fuzz inputs
- Every revert path tested — no uncovered custom errors
- Deploy to Base Sepolia succeeds, addresses saved to `deployments/84532.json`
- `SeedMarkets` creates 5 markets visible on Basescan Sepolia, each with a registered oracle
- Full dispute-flow E2E test on Sepolia: propose → challenge → arbitrate (both winners), plus one uncontested propose → finalize
- Gas for `buy`: under 180k
- Gas for `claim`: under 80k
- Gas for `finalize` (uncontested path): under 120k

### 4.7 Attack surface

Enumerated threat model for Phase 1. Each vector must have at least one dedicated test in `contracts/test/`.

| # | Vector | Mitigation |
|---|---|---|
| 1 | Oracle collusion — primary oracle submits wrong outcome | Challenge window (24h), 2× bond requirement for challengers, factory-owner arbitration, lost-dispute stake forfeiture, reputation impact |
| 2 | Oracle silence — assigned oracle never calls `resolve()` | `BACKUP_DELAY` (48h) after which any registered oracle may resolve; `GRACE_PERIOD` (7d) hard cancel fallback |
| 3 | Challenge spam — free challenges to delay resolution | Challenger must stake 2× `perResolutionBond`; losing the dispute forfeits it |
| 4 | Reserve insolvency — LMSR precision loss or fee extraction drains reserves below max payout | `ReservesInsufficient` pre-check on `resolve()` forces transition to `Invalid` and pro-rata refund |
| 5 | First-depositor share dilution | Initial reserves seeded atomically via factory's `createMarket` — creator's `initialStake` and first LMSR quote are computed in the same tx |
| 6 | Sandwich/MEV on `resolve()` | `resolve()` transitions `Proposed` not `Resolved`; no claim is possible during dispute window, so MEV extractor can't use outcome info to front-run trades (trading is already closed) |
| 7 | Price threshold gaming — small buys right before `resolutionTime` to shift LMSR price | Resolution uses *oracle-aggregated external price* vs `priceThreshold`, NOT the LMSR's internal probability; internal probability is a trading signal only |
| 8 | Slippage on buy/sell | `maxCost` / `minProceeds` parameters on `buy`/`sell`; reverts with `SlippageExceeded` |
| 9 | Re-entrancy on USDC transfers | `ReentrancyGuard` on all external functions that move funds; USDC's non-reentrant behavior does not preclude future compromise |
| 10 | Factory authority compromise | Ownership behind Safe 2-of-3; `Pausable` blocks only new market creation, never existing trading; emergency migration via fresh deploy + published tool |
| 11 | Double-claim | `claimed[user]` mapping set to `true` on first claim; `AlreadyClaimed` revert on repeats |
| 12 | Duplicate market creation | `DuplicateMarket(bytes32 key)` check on `keccak256(itemHash, resolutionTime, priceThreshold)` |
| 13 | Registry operator list growing unbounded | Soft cap of 50 active operators enforced in `register()` to bound backup-oracle iteration gas |
| 14 | Treasury-creator key compromise | Hard `dailyTreasurySpendCap` (5000 USDC default) bounds single-day damage; rotation via Safe `setTreasuryCreator`; news-monitor logs published in real time so anomalies are caught within minutes |
| 15 | News-monitor classifier hallucinates a TIER1 event | Treasury creator's authorized parameter envelope (4.1.6) bounds market parameters; even a fully wrong market resolves cleanly via Invalid (mismatch with reality), losing only `initialStake` |
| 16 | Duplicate news-event markets from re-classified posts | `newsEventId` (`keccak256(source, postId, timestamp)`) deduped on-chain via `marketByKey` check on `(itemHash, resolutionTime, priceThreshold)` |

---

## 5. Phase 2 — Python oracle

**Goal:** Fetch skin prices from 3 venues, aggregate to a trusted reference, publish resolutions on-chain. Package as OpenClaw skill.

### 5.1 Reference registry

Create `oracle/registry/tier1.json`:

```json
{
  "version": "1.0.0",
  "chain": "base",
  "assets": [
    {
      "id": "awp_dragon_lore_ft",
      "display_name": "AWP | Dragon Lore",
      "item_hash": "AWP | Dragon Lore (Field-Tested)",
      "wear": "FT",
      "float_min": 0.15,
      "float_max": 0.38,
      "stattrak": false,
      "souvenir": false,
      "buff163_goods_id": 776627,
      "csmoney_slug": "awp-dragon-lore-field-tested",
      "skinport_market_hash_name": "AWP | Dragon Lore (Field-Tested)"
    }
    // ... 23 more (see section 5.5)
  ]
}
```

### 5.2 Scrapers

Each scraper exposes:

```python
class Scraper(Protocol):
    async def fetch_price(self, asset: Asset) -> VenuePrice: ...

@dataclass
class VenuePrice:
    venue: str
    asset_id: str
    price_usd: Decimal
    listed_count: int
    timestamp: datetime
    raw: dict  # full response for audit
```

**Buff163 (primary).** Cloudflare + login-gated. Use `httpx` with residential proxy support (configurable via env), session cookie reuse, retry with exponential backoff. CNY→USD via `https://open.er-api.com/v6/latest/CNY`. Rate limit to 1 req / 5s per asset. Free tier: none (scraping against ToS; residential proxy required for production).

**CS.MONEY.** Public market endpoint. JSON API. No auth needed but rate-limit aggressively. Rate limit to 1 req / 2s per asset.

**Skinport.** Public API at `https://api.skinport.com/v1/items`. Documented, easy. EUR→USD conversion via same FX endpoint. Rate limit to 8 req/min globally (documented limit).

Each scraper has pluggable proxy config and a dry-run mode that returns fixtures from `oracle/tests/fixtures/` for CI without network calls.

#### 5.2.5 Venue fallback matrix

Ordered by weight. On failure, the aggregator proceeds with the remaining sources provided `>= 2` survive.

| Venue | Weight | Fallback if down | Currency | Rate limit | Auth |
|---|---|---|---|---|---|
| Buff163 | 0.5 | Redistribute to CS.MONEY + Skinport | CNY | 1 req / 5s / asset | Session cookie via `BUFF163_SESSION_COOKIE`, residential proxy via `BUFF163_PROXY_URL` |
| CS.MONEY | 0.3 | Continue with Buff163 + Skinport | USD | 1 req / 2s / asset | None (public) |
| Skinport | 0.2 | Continue with Buff163 + CS.MONEY | EUR | 8 req/min global | None (public) |

If only 1 venue survives, the oracle MUST return `Outcome.Invalid` per 4.4.3 criterion "Source count". If the 2 surviving venues disagree by >15% of their median, MUST return `Outcome.Invalid` per "Divergence".

#### 5.2.6 Cache strategy

| Cache | TTL | Location | Invalidation |
|---|---|---|---|
| Asset metadata (name, image, venue IDs) | 30 days | `~/.skincast-oracle/cache/assets.json` | Manual via `skincast-oracle cache-clear --assets` |
| Venue prices (per asset per venue) | 60 seconds | In-memory LRU (max 1024 entries) | TTL-only; prediction markets need fresh data |
| FX rates (CNY/EUR → USD) | 30 minutes | `~/.skincast-oracle/cache/fx.json` | TTL-only |
| Discovered markets (from MarketCreated events) | Infinite | SQLite `~/.skincast-oracle/markets.db` | Replay events if DB missing |
| Resolution log | Append-only | `~/.skincast-oracle/settlement_log.jsonl` | Never |

Fixtures for CI live under `oracle/tests/fixtures/` and are loaded when `SKINCAST_ORACLE_DRY_RUN=fixtures` env is set. This lets CI run offline and deterministically.

### 5.3 Aggregator

```python
def aggregate(prices: list[VenuePrice], weights: dict[str, Decimal], max_age_s: int = 1800) -> AggregatedPrice:
    """
    Weighted median across venues.
    Filter stale entries (timestamp < now - max_age_s).
    Exclude outliers > 2 stdev from mean.
    Require at least 2 venues survive for a valid aggregation.
    If the survivors' range > 15% of their median, flag as Invalid.
    """
```

Default weights: `{"buff163": 0.5, "csmoney": 0.3, "skinport": 0.2}`.
Default `max_age_s`: 1800 (30 min) — matches contract `VENUE_FRESHNESS`.

Returns:

```python
@dataclass
class AggregatedPrice:
    median_usd: Decimal
    used_venues: list[str]
    excluded_venues: dict[str, ExclusionReason]   # {"skinport": "STALE", ...}
    confidence: Decimal                            # 0.0–1.0; 1 = all venues agreed, 0 = 2σ'd out to 2
    invalid_reason: InvalidReason | None           # matches 4.4.3 enum; None means valid aggregation
```

`InvalidReason` enum:
- `INSUFFICIENT_SOURCES` — <2 venues fresh
- `LOW_CONFIDENCE` — post-outlier, <2 venues remain
- `HIGH_DIVERGENCE` — range > 15% of median
- `ITEM_UNRESOLVABLE` — all venues returned 404 or "item not found"

### 5.4 Publisher

```python
class Publisher:
    async def resolve_market(self, market_addr: ChecksumAddress, outcome: int, price_usd: Decimal) -> TxHash:
        """Call Market.resolve(outcome, price) on Base."""

    async def poll_resolution_queue(self) -> list[Market]:
        """Scan MarketFactory events + MarketCreated log, filter markets where state == Closed and block.timestamp >= resolutionTime."""

    async def run(self):
        """Main loop: poll queue, aggregate prices, submit resolutions."""
```

Uses `web3.py` v7 with async provider. ABI loaded from `../contracts/out/Market.sol/Market.json`. Signer keypair loaded from env (`ORACLE_SIGNER_PRIVATE_KEY`). EIP-1559 gas config with Base-appropriate maxPriorityFee (0.01 gwei baseline). Logs every submission with tx hash and a `settlement_log.jsonl` append-only audit file.

Resolution flow (aligned with the 4.4 state machine):

1. Find all `Market` contracts via factory `MarketCreated` events (cache in local SQLite)
2. For each known market, read `state` on-chain. Act based on state:
3. **`Closed`** and `block.timestamp >= resolutionTime` and we are the assigned `oracle` (or we are a registered operator and `block.timestamp > resolutionTime + BACKUP_DELAY`):
   - Aggregate current price via section 5.3
   - If `aggregated.invalid_reason is not None`: build `resolve(Outcome.Invalid, 0)` tx
   - Else: `outcome = Yes if price > priceThreshold else No`; build `resolve(outcome, price)` tx
   - Verify operator has ≥ `perResolutionBond` unlocked stake in registry; if not, alert + skip
   - Build, simulate (`eth_call`), submit, wait 1 conf, log
4. **`Proposed`** and we are a registered operator with stake ≥ 2× `perResolutionBond`:
   - Independently aggregate price; if our outcome disagrees with `proposedOutcome`, emit a `CHALLENGE_CANDIDATE` log event (do NOT auto-challenge — challenges are human-authorized to avoid cascading disputes in bugs; operator can set `AUTO_CHALLENGE=true` to opt in)
5. **`Proposed`** and dispute window elapsed, no challenger:
   - Any caller can submit `finalize()` — this is a gas-only transaction, so there's a public-good "keeper" role. Run it if our address matches the market's `resolvingOracle` (we get the bond back + fee share).
6. **`Resolved`** — nothing to do; recordkeeping only.
7. **`Cancelled`** — nothing to do; recordkeeping only.

Every on-chain action is written to `settlement_log.jsonl` with `{timestamp, market_addr, action, outcome, price_usd, tx_hash, gas_used, block_number}`. This log is the operator's audit trail and supports dispute responses.

### 5.5 Launch asset list (24 assets)

Tier 1 blue-chips × 3 float buckets each:

| Skin | FN | MW | FT |
|---|---|---|---|
| AWP \| Dragon Lore | ✓ | ✓ | ✓ |
| Karambit \| Fade | ✓ | ✓ | — |
| Karambit \| Doppler | ✓ | ✓ | — |
| M4A4 \| Howl | ✓ | ✓ | ✓ |
| Butterfly Knife \| Fade | ✓ | ✓ | — |
| AK-47 \| Fire Serpent | ✓ | ✓ | ✓ |
| M9 Bayonet \| Marble Fade | ✓ | ✓ | — |
| Glock-18 \| Fade | ✓ | ✓ | — |

(Fill to 24 total. Knives typically don't come in FT since they're factory-sealed higher quality.)

### 5.5.4 Tier 2 news-asset registry

In addition to the 24 Tier-1 tradeable assets, the news monitor (5.5.6) needs a registry of **news-eligible assets** — primarily player autograph stickers, team capsules, and tournament collections. These are the assets that move on news events.

`oracle/registry/news_assets.json`:

```json
{
  "version": "1.0.0",
  "entities": {
    "navi": {
      "type": "team",
      "tournaments": ["pgl_major_stockholm_2021", "iem_cologne_2022", ...],
      "stickers": [
        { "asset_id": "sticker_navi_holo_pgl_stockholm_2021", "item_hash": "Sticker | NaVi (Holo) | Stockholm 2021" },
        ...
      ]
    },
    "s1mple": {
      "type": "player",
      "team_history": ["navi", "falcons"],
      "autograph_stickers": [
        { "asset_id": "sticker_s1mple_gold_paris_2023", "item_hash": "Sticker | s1mple (Gold) | Paris 2023" },
        ...
      ]
    }
    ...
  }
}
```

The classifier resolves news entities (player names, team names, tournament names) to entity keys, then enumerates the relevant sticker / capsule asset IDs for market creation. Coverage at launch: top 30 players + top 10 teams + last 8 Majors. Maintained as a separate file from `tier1.json` so the news monitor and the tradeable market list evolve independently.

### 5.5.5 Skin resolver (natural-language → canonical ID)

Analog to BaoClaw's `card-resolver.mjs`. Users type free-form names; the resolver maps them to a canonical `asset_id` in `registry/tier1.json` and fetches metadata + thumbnail.

```python
# oracle/skincast_oracle/resolver.py

@dataclass
class ResolvedSkin:
    asset_id: str                 # "awp_dragon_lore_ft"
    display_name: str             # "AWP | Dragon Lore (Field-Tested)"
    item_hash: str                # canonical Steam market_hash_name
    wear: str                     # "FT", "MW", "FN", ...
    thumbnail_url: str | None
    float_range: tuple[float, float]
    stattrak: bool
    souvenir: bool

def resolve(query: str) -> ResolvedSkin | None:
    """
    Natural-language input → canonical asset.
    Examples:
        "dragon lore ft"                 → awp_dragon_lore_ft
        "AWP | Dragon Lore"              → awp_dragon_lore_fn  (default to best wear available)
        "fire serpent minimal"           → ak47_fire_serpent_mw
        "kara fade"                      → karambit_fade_fn
    """
```

**Algorithm:**
1. Normalize: lowercase, strip punctuation, collapse whitespace
2. Tokenize
3. Match against `tier1.json` using fuzzy matching on `display_name` + `item_hash` (rapidfuzz `WRatio` ≥ 75)
4. Tiebreaker: wear specifier in query (`ft`, `fn`, `mw`, `ws`, `bs`, `minimal wear`, `field-tested`, etc.) selects across same base skin
5. Fall back to Steam Community Market search API if no registry match (for `/create` flow where user creates a market on an item outside Tier 1)

Caches resolution results in `~/.skincast-oracle/cache/resolver.json` (30-day TTL per 5.2.6).

CLI exposure: `skincast-oracle resolve "dragon lore ft"` prints the ResolvedSkin as JSON.

### 5.5.6 News monitor and event-driven market creation

The killer feature. A long-running service inside `oracle/skincast_oracle/news/` that polls CS news sources, classifies posts via Claude, and submits `MarketFactory.createTreasuryMarket` for TIER1/TIER2 events. End-to-end target: news → on-chain market in **under 90 seconds**.

```python
# oracle/skincast_oracle/news/monitor.py

@dataclass
class NewsEvent:
    source: Literal["hltv", "reddit", "twitter"]
    post_id: str
    timestamp: datetime
    url: str
    headline: str
    body: str
    @property
    def event_id(self) -> bytes:
        return keccak256(f"{self.source}:{self.post_id}:{int(self.timestamp.timestamp())}".encode())

@dataclass
class Classification:
    tier: Literal[1, 2, 3, 0]                     # 0 = ignore
    affected_entities: list[str]                  # entity keys from news_assets.json
    expected_window_hours: int
    expected_upside_pct: int
    rationale: str                                # for audit log
```

#### Sources (every 60 seconds)

| Source | Method | Rate limit |
|---|---|---|
| HLTV news RSS | `https://www.hltv.org/rss/news` | 1 req/min |
| HLTV transfer rumors RSS | `https://www.hltv.org/rss/transfers` | 1 req/min |
| Reddit `r/GlobalOffensive` | `praw` API, `new` listing, top 20 | 60 req/min (Reddit limit) |
| Twitter (curated list) | Twitter API v2 / nitter mirror, ~50 CS pros + casters + team accounts | 300 req/15min |

Posts are deduplicated by `event_id` against a SQLite log at `~/.skincast-oracle/news_log.db`.

#### Classifier prompt (claude-haiku-4-5)

System prompt template:
```
You are a Counter-Strike market analyst. Classify the news post for impact on
sticker / skin prices.

Tiers:
  TIER1 — player retirement OR team disbandment OR major win (winner stickers).
          Expected move +50–400% within 24–72h.
  TIER2 — player transfer to/from a top-10 team OR top-3 placement at a Major.
          Expected move +30–100% within 72–96h.
  TIER3 — minor event (top-10 team adds coach, branded item announcement).
          Expected move +10–30% within a week.
  IGNORE — not market-relevant (results articles, opinion pieces, patch notes).

Output JSON:
{
  "tier": 1 | 2 | 3 | 0,
  "affected_entities": ["entity_key_1", "entity_key_2", ...],
  "expected_window_hours": int,
  "expected_upside_pct": int,
  "rationale": "<= 200 chars"
}

Available entities are listed in <entities> below. Match by name with fuzzy logic.
Return entity keys only — never invent new ones.

<entities>
{news_assets.json entity keys + display names}
</entities>
```

Each classification call costs ≈ $0.001 with Haiku 4.5. At 60-second polling × 4 sources × 5 posts/poll on average = 28,800 calls/day = $28.80/day. Cap monthly via `CLASSIFIER_DAILY_BUDGET_USD` (default 50).

#### Market creation pipeline

For each TIER1/TIER2 classification:
1. Resolve `affected_entities` to `asset_id`s via `news_assets.json`. For TIER1, enumerate ALL stickers for the entity (e.g., player retirement → all autograph stickers across all tournaments). For TIER2, only the most recent tournament collection.
2. For each `asset_id`:
   - Fetch current aggregated price via 5.3 (must succeed; if `Invalid`, skip and log `INVALID_PRICE`)
   - Compute `priceThreshold = round(median × tier_multiplier, 18)` per the 4.1.6 envelope
   - Check `factory.marketByKey` for duplicate; skip if exists
   - Build the question string from a Jinja template
   - Pick `oracle` from `OracleRegistry` — highest-reputation active operator with adequate stake
   - Call `factory.createTreasuryMarket(question, itemHash, resolutionTime, priceThreshold, b, initialStake, oracle, newsEventId, tier)`
3. Wait for receipt; on success, write to `news_market_log.jsonl` with `{event_id, classification, market_addresses, tx_hashes, gas_used}`
4. Push a structured event to a local queue read by the Discord bot (5.5.6.1)

#### 5.5.6.1 Bot bridge

The news monitor publishes to a Redis stream (`SKINCAST_NEWS_STREAM`) on every market creation. The Discord bot's worker subscribes and announces to `#news-events` in under 5 seconds, including:
- Headline + source link
- Created markets (one embed per market with question + initial liquidity + resolution time)
- Tier badge (TIER1 = red, TIER2 = amber)

Operators can set `--max-markets-per-event 5` to cap fan-out for events that touch dozens of stickers (e.g., a player with 40+ autograph stickers).

#### CLI

- `skincast-oracle news watch` — start the long-running monitor
- `skincast-oracle news classify <post_url>` — one-shot classify, useful for tuning
- `skincast-oracle news log [--since <ts>]` — tail the audit log
- `skincast-oracle news replay <event_id>` — re-run market creation for a past event (idempotent via `marketByKey`)

#### Operator economics

The oracle account that signs `createTreasuryMarket` does NOT need to be the `treasuryCreator` — it just needs the EOA controlled by the news monitor service. The treasury creator role and the oracle role can be the same address or separate. Default config: separate addresses, news monitor key has `createTreasuryMarket` permission only, oracle key has `resolve`/`finalize` permission.

### 5.6 OpenClaw skill packaging

Create `oracle/SKILL.md`:

```markdown
---
name: skincast-oracle
description: Poll CS skin prices from Buff163, CS.MONEY, and Skinport. Aggregate to weighted median. Optionally publish resolutions to the SkinCast contracts on Base as an oracle operator. Use when the user wants to quote a skin price, run an oracle node, or inspect the resolution queue.
version: 1.0.0
---

# SkinCast Oracle

This skill provides tools for CS skin price quoting and SkinCast oracle operation.

## Commands

- `quote <item_hash_name>` — fetch aggregated current price
- `list-assets` — show the 24 Tier 1 assets
- `run-oracle` — start the scheduler loop (requires ORACLE_SIGNER_PRIVATE_KEY env)
- `resolve-queue` — inspect markets pending resolution

## Installation

1. `pip install skincast-oracle`
2. `skincast-oracle init` — interactive setup (see 5.6.5)
3. (Optional) Add `ORACLE_SIGNER_PRIVATE_KEY` to env and register address with `skincast-oracle register-operator`
4. `skincast-oracle run-oracle`

## Fee economics

Oracle operators earn 30% of the 2.5% platform trading fee on every market they successfully resolve. The resolving oracle's fee bucket is paid out at `finalize()`. If a challenge succeeds, the challenger takes the fee bucket instead. Registration requires ≥ `minStake` (1000 USDC default); every resolution locks `perResolutionBond` (100 USDC default) until the dispute window closes cleanly.
```

### 5.6.5 `skincast-oracle init` walkthrough

Interactive wizard, modeled on BaoClaw's `!bao setup`. Runs in sequence; each step is resumable if the user quits mid-flow.

1. **Config path** — creates `~/.skincast-oracle/config.toml` (or `$SKINCAST_ORACLE_HOME/config.toml` if set). Never reads/writes shell rc files.
2. **Base RPC** — prompts for Alchemy/QuickNode URL, falls back to `https://base.publicnode.com`. Tests connectivity with `eth_chainId`; rejects if not `0x2105` (Base mainnet) or `0x14a34` (Sepolia).
3. **Signer keypair** — offers (a) generate new, (b) import hex private key, (c) import keystore JSON. Saves to OS keyring via `keyring` package; never to plaintext config.
4. **Factory address** — pre-filled from known deployments; override available.
5. **Venues** — optional configuration for each:
   - Buff163: prompt for session cookie + proxy URL. If skipped, Buff163 excluded.
   - CS.MONEY: no credentials needed; just confirm reachability.
   - Skinport: no credentials; confirm reachability.
6. **Oracle operator registration** (optional): if user wants to resolve markets (not just quote), walk through:
   - Show current `minStake` and `perResolutionBond` from on-chain
   - Prompt for USDC amount to stake (≥ minStake)
   - Build and display the `register(name, stake)` tx; require explicit `yes` to sign
7. **Telemetry consent** — anonymized crash reports to Sentry, opt-in.
8. **Test run** — aggregate one quote for `"AWP | Dragon Lore (Field-Tested)"`. Prints the full pipeline output. If any venue fails, shows remediation hints ("Set BUFF163_SESSION_COOKIE and retry").
9. **Summary** — prints commands to run next (`skincast-oracle run-oracle`, `skincast-oracle resolve-queue`).

Flag `--non-interactive` accepts all defaults and reads values from env vars. Used by Docker/Railway deployments.

### 5.7 Prompt to paste to Claude Code

> Implement the Python oracle at `oracle/` per section 5 of `SKINCAST_SPEC.md`. Requirements:
>
> 1. Python 3.11+, `uv` for dependency management, `pyproject.toml`. Strict mypy + ruff.
> 2. Implement three scrapers (`buff163.py`, `csmoney.py`, `skinport.py`) conforming to the `Scraper` protocol in 5.2. Use `httpx.AsyncClient`. Include fixtures for each in `oracle/tests/fixtures/` so CI works offline when `SKINCAST_ORACLE_DRY_RUN=fixtures`. Buff163 scraper must support residential proxy via env var `BUFF163_PROXY_URL` and session cookie via `BUFF163_SESSION_COOKIE`. Respect the per-venue rate limits in 5.2.5.
> 3. Implement aggregator per 5.3: stale-filter with `max_age_s=1800`, outlier exclusion (>2σ from mean), venue weighting, minimum 2 survivors, 15% divergence cap, and the full `InvalidReason` enum matching section 4.4.3.
> 4. Implement the Tier 1 asset registry in `registry/tier1.json` with all 24 assets per 5.5. Each asset needs `buff163_goods_id`, `csmoney_slug`, `skinport_market_hash_name`, float range, stattrak/souvenir flags. Fetch real IDs from the venues at scaffold time — don't guess.
> 5. Implement the skin resolver per 5.5.5 using `rapidfuzz`. CLI: `skincast-oracle resolve "<query>"`.
> 6. Implement the cache layer per 5.2.6: in-memory LRU for prices, JSON files for metadata/FX, SQLite for market discovery. Expose `skincast-oracle cache-clear` with `--assets`, `--fx`, `--markets`, `--all` flags.
> 7. Implement publisher per 5.4 using `web3.py` v7 async. Load ABI from `../contracts/out/*.sol/*.json`. Handle all four state branches (`Closed`, `Proposed` as potential challenger, `Proposed` finalize-keeper, `Resolved`/`Cancelled` recordkeep). Simulate via `eth_call` before every send. Dry-run mode writes tx hex to stdout without broadcasting. EIP-1559 gas with 0.01 gwei base priority, exponential backoff on replacement.
> 8. Implement scheduler with APScheduler: poll prices every 5 minutes for assets with active markets, poll resolution queue every 1 minute, submit resolutions as they become due. Graceful shutdown on SIGTERM (flushes pending logs).
> 9. Implement `skincast-oracle init` per 5.6.5. Use `typer` + `rich` for the interactive prompts. Store signer keys in OS keyring (`keyring` package), never plaintext.
> 10. CLI via `typer`, all commands support `--dry-run` where relevant: `skincast-oracle init`, `quote`, `resolve`, `list-assets`, `run-oracle`, `resolve-queue`, `register-operator`, `cache-clear`, `settlement-log [--since <ts>]`.
> 11. Write `oracle/SKILL.md` per 5.6 and `oracle/README.md` with full usage including the 5.6.5 walkthrough.
> 12. Tests (minimum **50 tests**):
>    - `tests/test_aggregator.py` — synthetic inputs covering all `InvalidReason` branches, outlier handling, weighting, stale filter (15 tests)
>    - `tests/test_resolver.py` — fuzzy match correctness including ambiguous queries and wear disambiguation (10 tests)
>    - `tests/test_scrapers.py` — fixture-based tests for each venue, proxy support, cookie handling, retry/backoff (15 tests)
>    - `tests/test_publisher.py` — tx building, gas estimation, the four state branches, dry-run output format (10 tests)
>    - `tests/test_cache.py` — TTL expiry, LRU eviction, SQLite schema migrations
>    - `tests/test_integration.py` — end-to-end dry-run against fixtures: resolve("dragon lore ft") → aggregate → build tx
>
> Commit as "feat(oracle): multi-venue skin price oracle + OpenClaw skill".

### 5.8 Acceptance criteria

- `skincast-oracle quote "AWP | Dragon Lore (Field-Tested)"` returns a real aggregated USD price
- All 24 Tier 1 assets return valid prices from at least 2 venues each
- `skincast-oracle resolve "dragon lore ft"` returns the correct canonical asset
- `skincast-oracle init` completes in under 3 minutes on a clean machine
- Scheduler runs without crashing for 10 minutes against Base Sepolia
- Dry-run resolution produces valid, signed tx hex visible in logs
- On a market in `Proposed` state where our aggregation disagrees with `proposedOutcome`, operator sees a `CHALLENGE_CANDIDATE` log entry (challenge not auto-submitted unless `AUTO_CHALLENGE=true`)
- News monitor: a TIER1 fixture (e.g., a sample retirement post) end-to-end produces ≥1 created market on Base Sepolia within 90 seconds (target latency)
- News monitor: replay of the same `event_id` is a no-op (idempotent via `marketByKey` dedup)
- All 50+ tests pass; CI passes offline via fixtures

---

## 5.9 Public price oracle API

The aggregator already produces a high-quality multi-venue median for SkinCast's own resolutions. Exposing it as a public HTTP API turns infrastructure cost into a revenue line and creates a neutral, paid data source for the broader CS trading ecosystem (per the article: every arbitrage scanner, EV calculator, and float sniper starts by scraping the same venues this service already aggregates).

### 5.9.1 Service shape

A FastAPI service at `oracle/skincast_oracle/api/` that runs alongside the scheduler in the same process (shares the cache and aggregator instance — zero extra latency). Deployed to Railway as a sidecar container alongside the oracle worker.

```python
# oracle/skincast_oracle/api/server.py

app = FastAPI(title="SkinCast Price API", version="1.0")

@app.get("/v1/price/{item_hash}")
async def price(item_hash: str, wear: str | None = None) -> AggregatedPriceResponse: ...

@app.get("/v1/spread/{item_hash}")
async def spread(item_hash: str, venue_a: str, venue_b: str, wear: str | None = None) -> SpreadResponse: ...

@app.get("/v1/venues/{item_hash}")
async def venues(item_hash: str, wear: str | None = None) -> dict[str, VenuePrice]: ...

@app.get("/v1/assets")
async def list_assets() -> list[Asset]: ...

@app.get("/v1/markets")
async def list_markets(state: str | None = None, limit: int = 50) -> list[MarketSummary]: ...

@app.get("/v1/news/recent")
async def news_recent(tier: int | None = None, limit: int = 20) -> list[NewsClassification]: ...

@app.get("/v1/operators")
async def operators() -> list[OperatorPublicProfile]: ...    # name, stake, reputation
```

### 5.9.2 Response format

```json
GET /v1/price/awp_dragon_lore_ft
{
  "item_hash": "AWP | Dragon Lore (Field-Tested)",
  "median_usd": 1847.32,
  "venues": {
    "buff163": { "price_usd": 1789.50, "listed_count": 12, "timestamp": 1714502400 },
    "csmoney": { "price_usd": 1899.00, "listed_count": 4,  "timestamp": 1714502380 },
    "skinport": { "price_usd": 1925.00, "listed_count": 7,  "timestamp": 1714502410 }
  },
  "confidence": 0.94,
  "as_of": 1714502420,
  "ttl_seconds": 60,
  "request_id": "01HZ5J..."
}
```

All numeric values are JSON numbers (USDC-equivalent), not strings. `request_id` is a ULID for support tracing.

### 5.9.3 Auth and rate limiting

| Tier | Price | Rate limit | Auth |
|---|---|---|---|
| Anonymous | Free | 100 req/day per IP | None |
| Developer | $20/mo | 100k req/day | API key in `X-API-Key` header |
| Pro | $200/mo | 5M req/day | API key + commits to monthly minimum |

API keys issued via Stripe + custom dashboard at `app.skincast.io/api-keys` (added to `web/` in Phase 4). Rate limiting via Redis token bucket (`@slowapi/fastapi-limiter`). Anonymous tier uses IP-based bucket; authenticated tiers use key-based.

CORS allowed origins: `*` for `/v1/price/*`, `/v1/spread/*`, `/v1/assets`, `/v1/markets`, `/v1/operators`. The data is non-sensitive and useful in third-party browser apps.

### 5.9.4 Operator revenue share (the BaoClaw analog)

Every venue request the aggregator serves is *because an oracle operator's scraping kept the cache warm*. Pay them.

- API revenue is collected monthly by Stripe into a `feeSplitter` treasury bucket
- 50% of API revenue → operator-rewards pool, distributed pro-rata by **attestation count over the period**
  - An "attestation" is one `(asset, venue, timestamp)` tuple the operator pushed into the shared cache during the period
  - Operators that don't run scrapers (only resolve markets) get zero share — incentive aligned with feed health
- 30% → platform treasury (covers infra: API hosting, Stripe fees, Redis, monitoring)
- 20% → reserve fund (seed liquidity for future news markets)
- Distribution uses the existing `FeeSplitter.recordFee` mechanism with `creator = address(0)`, `oracle = pool_address`. Pool then redistributes by attestation count. Or a separate `OperatorRewardsPool` contract — implementation choice in Phase 5+.

The attestation count needs an on-chain commitment to be trustless. Two implementation options for Phase 9:
1. **Off-chain with audit log:** simple, centralized; operator dashboard shows attestation count; trust the platform
2. **On-chain Merkle commitment:** operator signs daily Merkle root of `(timestamp, asset, venue, price)` tuples, posts to a `PriceAttestations` contract; rewards distributed against signed roots. Adds gas cost but is verifiable.

Ship #1 at launch. Migrate to #2 post-revenue.

### 5.9.5 Prompt to paste to Claude Code

> Extend `oracle/` per section 5.9 of `SKINCAST_SPEC.md`. Requirements:
>
> 1. Implement FastAPI service at `oracle/skincast_oracle/api/` per 5.9.1. Reuses the same `Aggregator`, `SkinResolver`, and SQLite market cache as the scheduler — single shared instance, no duplicate scraping.
> 2. Pydantic response models per 5.9.2 in `api/models.py`. Backward-compatible versioning via `/v1/` prefix.
> 3. Auth + rate limiting per 5.9.3 using `slowapi` + Redis (Railway Redis add-on). Stripe webhook handler for key provisioning at `/internal/stripe/webhook` (HMAC-verified).
> 4. Local dev: `skincast-oracle api --port 8000 --no-auth` runs the API without rate limits or Stripe (for local agents).
> 5. Operator attestation tracking: every time `Aggregator.aggregate()` uses a venue price freshly contributed by operator X, increment `attestations[X]` in the shared cache. Persist hourly to SQLite `attestations` table. CLI: `skincast-oracle attestations [--operator <addr>] [--since <ts>]`.
> 6. Tests (minimum 15 additional): unit tests for endpoint serialization, rate-limit bucket behavior, auth header handling, Stripe webhook signature verification, attestation counter math. CI runs against fixtures.
>
> Commit as "feat(oracle): public price API + operator attestation rewards".

### 5.9.6 Acceptance criteria

- `curl -s https://api.skincast.io/v1/price/awp_dragon_lore_ft | jq .median_usd` returns a number
- 100 req/day anonymous limit enforced; 101st request returns 429
- API key in `X-API-Key` lifts the limit to 100k req/day
- p50 latency < 50ms (cache-hit path); p99 < 200ms
- One full month of attestations counted correctly per operator and reconcilable to the rewards distribution
- Stripe sandbox flow: customer signs up → webhook fires → API key issued → first authenticated request succeeds within 30 seconds

---

## 6. Phase 3 — Discord bot

**Goal:** Full trading UX inside Discord. Slash commands for navigation, embed buttons for actions. Privy embedded wallets on Base for signing.

### 6.1 Slash commands

**Trading commands:**

| Command | Options | Behavior |
|---|---|---|
| `/markets` | `tier?`, `sort?`, `state?` | List open markets as paginated embeds. Each has YES/NO price, volume, resolution time, state badge. Buttons: "Trade", "Details". |
| `/predict <market_id>` | | Full market detail card. Shows state (Open, Closed, Proposed, Resolved, Cancelled). Buttons vary by state: Open → `[Buy YES] [Buy NO] [Sell] [Info]`; Proposed → `[View Resolution] [Info]`; Resolved → `[Claim] [Info]`. |
| `/positions` | | List user's open positions across states. Buttons per position: context-sensitive ("Sell" if Open, "Claim" if Resolved/Cancelled, "View" if Proposed). |
| `/claim` | | List claimable winnings. Button: "Claim all". |
| `/wallet` | | Show embedded wallet address, USDC balance, ETH balance. Buttons: "Deposit", "Withdraw". |
| `/create` | `item`, `threshold`, `resolution_date`, `oracle?` | Permissionless market creation (guarded by `minCreatorStake`). Default oracle = highest-reputation active operator. Skin resolution uses same resolver as oracle (shared registry endpoint). |
| `/oracle` | `subcommand` | Oracle-operator-only commands: `status` (registered? stake? locked? reputation?), `propose <market_id> <outcome> <price>`, `challenge <market_id> <counter_outcome>`, `news-status` (recent classifier decisions). Gated on `OracleRegistry.canResolve(user.evmAddress)`. |
| `/help` | | Command reference. |

**Scanner / utility commands** (read-only, work without a wallet — drives DAU even when users aren't trading):

| Command | Options | Behavior |
|---|---|---|
| `/arbitrage <skin>` | `wear?`, `min_pct?` | Cross-platform spread table for the resolved skin. Shows Steam, Buff163, CS.MONEY, Skinport, CSFloat lowest-listed prices side-by-side, computes post-fee ROI per route (e.g., "Buff→Steam: +21.15 / 13.1% / 7d hold"), highlights opportunities ≥ `min_pct` (default 12%). Output mirrors the article's scanner table. Pagination if >5 venues per asset. |
| `/tradeup` | (modal) | Modal opens for pasting 10 input skins. On submit, computes EV using current aggregated prices, expected outputs from CSGO API trade-up data, and the article's formula. Returns RUN ✅ / SKIP ❌ / MARGINAL ⚠️ verdict + step-by-step math. |
| `/float <skin>` | `max_float?`, `phase?` (Doppler), `limit?` | Live CSFloat listings sorted by float ascending. Applies the float-premium model from the article: ×2.5–3.0 below 0.005, ×1.6–2.0 below 0.01, etc. Flags listings priced ≥20% below fair-value as `SNIPE`. Returns up to 10 results with deeplinks. |
| `/spread <skin>` | `venue_a`, `venue_b`, `wear?` | Single-pair spread chart over last 7 days as a Discord embed image (rendered via `@vercel/og` SVG endpoint hosted by `web/`). Useful for identifying when to enter spread markets. |
| `/ask <question>` | | Free-form question routed to Claude API (`claude-haiku-4-5`) with current price context for any skins mentioned + active markets pre-loaded. Cap: 50 calls/user/day on free tier, 500/day for premium. Examples: "Is the AK Redline FT spread real or thin liquidity?", "What's a fair price for an FN with 0.003 float?". Disclaimer footer: "AI-generated, not financial advice." |
| `/news` | `tier?`, `since?` | Tail the news monitor's audit log. Shows recent classifications + market creations. Public access — increases trust in the auto-creation system. |

### 6.2 Button flow — buying

User runs `/predict awp_dragon_lore_ft_2026_01_31`:

1. Bot replies with embed: question, current YES price, current NO price, volume, resolution date. Buttons: `[Buy YES]` `[Buy NO]` `[Sell]` `[Info]`.
2. User clicks `Buy YES`. Bot replies ephemerally with amount selector embed: preset buttons `[$10]` `[$25]` `[$100]` `[$500]` `[Custom]`.
3. User clicks `$100`. Bot computes shares via LMSR preview (reads chain state via viem), replies ephemerally: "You'll get ~N YES shares. If YES wins, you receive $M. Confirm?" Buttons: `[Confirm]` `[Cancel]`.
4. User clicks `Confirm`. Bot:
   - Fetches Privy wallet for the Discord user (lookup by discord_user_id in internal DB)
   - Checks USDC allowance to the market; if insufficient, first sends `approve()` tx
   - Constructs `Market.buy(isYes, sharesOut, maxCost)` tx with slippage buffer
   - Signs via Privy server-side signing
   - Submits via Alchemy RPC
   - Polls receipt
   - Updates the ephemeral message: "✓ Bought N YES at avg $X. Tx: [Basescan link]"
5. If user doesn't have enough USDC, bot prompts `/wallet` → `Deposit` which opens the Coinbase Onramp widget in-browser.

### 6.2.5 Scanner-command implementation

The 6 utility commands in 6.1 (`/arbitrage`, `/tradeup`, `/float`, `/spread`, `/ask`, `/news`) are pure read-only flows and **must work for users without a connected wallet**. They drive DAU between trading sessions and act as the funnel into the prediction-market product.

**Backend wiring:** all scanner commands hit the public price API (5.9) via the bot's authenticated developer key — bot is its own first customer. This validates the API on every release and makes the bot trivially portable to other surfaces (Telegram, web).

```typescript
// bot/src/scanner/client.ts
import { skincastApi } from '../api';

export async function arbitrage(skin: string, opts: { wear?: string; minPct?: number }) {
  const venues = await skincastApi.venues(skin, opts.wear);
  return computeArbitrageRoutes(venues, FEE_TABLE, TRADE_HOLD_DAYS);
}
```

**`/arbitrage` output spec:**

```
🎯 Arbitrage scan — AWP | Asiimov (Field-Tested)

  Venue       Lowest    Listed    Fee     Route ROI*
  ─────────────────────────────────────────────────
  Buff163     $52.10    87        2.5%    —
  Skinport    $58.20    23        12%     +0.4% ❌
  CS.MONEY    $61.30    14        8%      +5.3% ⚠️
  Steam       $73.80    412       13%    +21.3% ✅

  *Route ROI assumes Buff163→target, post-fee, 7-day hold

  ✅ 1 opportunity ≥ 12% gap detected
  Sweep estimate: $21.10 profit per unit
  Liquidity: 87 units available on Buff163

  [View on Buff163]  [View on Steam]  [Set price alert]
```

**`/tradeup` modal flow:** Discord modal → 10 text inputs (autocomplete from `/v1/assets`) → on submit, bot calls API for current prices, fetches CSGO trade-up probability table from `oracle/registry/tradeups.json` (a static lookup of which collection skins outcome-into which next-tier skins), runs the article's EV formula, returns embed.

**`/float` output spec:**

```
🔍 Low-float listings — Karambit | Doppler

  Float       Phase     Source       Price     Fair*    Discount   Verdict
  ──────────────────────────────────────────────────────────────────────────
  0.00031     Ruby      CSFloat      $4,820    $5,640   −14.5%     ⚠️
  0.00064     Sapphire  CSFloat      $3,140    $3,950   −20.5%     SNIPE ✅
  0.00091     Phase 2   Skinport     $1,290    $1,475   −12.5%     ⚠️
  0.00112     Phase 1   CSFloat      $1,180    $1,310   −9.9%      —

  *Fair value applies float-tier multipliers vs base FN price
  Sniped a deal? Tag it back in #snipes
```

**`/ask` Claude integration:**

```typescript
// bot/src/scanner/ask.ts
import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic();

async function ask(question: string, userId: string) {
  // 1. Extract entity references from question via cheap Claude Haiku call
  const entities = await extractEntities(question);  // ["AK Redline FT"]
  // 2. Pre-fetch current prices for any mentioned skins
  const context = await Promise.all(entities.map(e => skincastApi.price(e)));
  // 3. Pre-fetch active markets matching the entities
  const markets = await skincastApi.markets({ assets: entities, state: 'Open' });
  // 4. Compose system prompt with context + restrict to CS-trading topics
  const systemPrompt = buildSystemPrompt(context, markets);
  // 5. Stream Claude Haiku response back to Discord with rate-limit per user

  return claude.messages.stream({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });
}
```

Rate limit: 50 calls/day on free tier (tracked in Postgres), 500/day for Pro tier (announced separately, paid via Stripe). Cost is real — at $0.001/call × 50/user/day × 1000 users = $50/day. Cap monthly via `BOT_ASK_DAILY_BUDGET_USD` env (default 100).

**Disclaimer footer on every `/ask` response:**

> ⚠️ AI-generated guidance. Not financial advice. Verify prices and market state before trading.

**`/news` output:** tail of the last 20 news classifications + market creations from `/v1/news/recent`. Public access.

### 6.3 Privy integration

```typescript
import { PrivyClient } from '@privy-io/server-auth';

const privy = new PrivyClient(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!,
);

async function getOrCreateWallet(discordUserId: string): Promise<{ address: `0x${string}`, privyUserId: string }> {
  // First time: bot DMs an OAuth flow link to the landing page.
  // User completes Discord OAuth via Privy, Privy creates embedded EVM wallet,
  // landing page stores discord_id → privy_user_id → address in shared Postgres,
  // redirects user back to Discord.
}

async function signAndSendTx(privyUserId: string, unsignedTx: TransactionRequest): Promise<Hash> {
  // Privy server-side signing for embedded EVM wallets
  const { hash } = await privy.walletApi.ethereum.sendTransaction({
    walletId: privyUserId,
    caip2: 'eip155:8453',  // Base mainnet; Sepolia = eip155:84532
    transaction: {
      to: unsignedTx.to!,
      data: unsignedTx.data,
      value: unsignedTx.value?.toString() ?? '0',
    },
  });
  return hash as Hash;
}
```

Use `viem` (not ethers) as the low-level chain client — smaller, faster, better TypeScript inference.

### 6.4 Database

Minimal relational state for Discord-to-wallet mapping and market caching:

```typescript
// db/schema.ts (Drizzle)

export const users = pgTable('users', {
  discordId: text('discord_id').primaryKey(),
  privyUserId: text('privy_user_id').notNull().unique(),
  evmAddress: text('evm_address').notNull(),                // 0x...
  createdAt: timestamp('created_at').defaultNow(),
});

export const marketsCache = pgTable('markets_cache', {
  address: text('address').primaryKey(),                    // contract address
  marketId: bigint('market_id', { mode: 'number' }).notNull(),
  question: text('question').notNull(),
  assetId: text('asset_id').notNull(),
  resolutionTime: timestamp('resolution_time').notNull(),
  state: text('state').notNull(),
  lastSyncedAt: timestamp('last_synced_at').defaultNow(),
});

export const tradeLog = pgTable('trade_log', {
  id: serial('id').primaryKey(),
  discordId: text('discord_id').notNull(),
  marketAddress: text('market_address').notNull(),
  side: text('side').notNull(),                              // 'yes' | 'no'
  action: text('action').notNull(),                          // 'buy' | 'sell'
  amountUsd: numeric('amount_usd').notNull(),
  shares: numeric('shares').notNull(),
  txHash: text('tx_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});
```

Use Neon free tier for Postgres.

### 6.5 Market sync worker

Background process inside the bot:
- Subscribe to `MarketFactory.MarketCreated` events via `eth_getLogs` polling every 15 seconds
- For each known market, poll `state()`, `qYes()`, `qNo()` every 30 seconds (batched via multicall)
- Subscribe to per-market events: `Buy`, `Sell`, `ResolutionProposed`, `ResolutionChallenged`, `ResolutionFinalized`, `Cancelled`
- Upsert into `markets_cache`; write an event row per-event into `event_log`
- Emit Discord channel announcements for:
  - New markets (in `#markets`)
  - Markets resolving in <24h (reminder in `#markets`)
  - `ResolutionProposed` (in `#oracle-operators`, for visibility into pending resolutions)
  - `ResolutionChallenged` (in `#oracle-operators` and `#announcements`)
  - `ResolutionFinalized` (in `#announcements`, tagging users with positions in that market)
  - Large trades (>$1000 notional, via `Buy`/`Sell` events, in `#whale-watch`)
- Ping authenticated oracle operators directly when a market they are assigned to enters `Closed` state — this gives humans a chance to act before any backup-oracle window elapses

### 6.5.5 Agent-mode operation

Bots and autonomous agents operating at scale (market makers, arbitrage bots, keeper bots running `finalize()`) should use **Coinbase Agentic Wallets** instead of Privy embedded wallets. Discord bot exposes an opt-in for this:

- User sets `WALLET=coinbase` in their DM interactions with the bot
- Bot routes signing requests through `@coinbase/onchainkit` programmatic API instead of Privy
- No Discord OAuth needed for the wallet — agents register via Coinbase AW's headless flow
- Same onchain surface; only the signing backend differs

This mirrors BaoClaw's dual-wallet architecture. Human traders default to Privy (email login, no seed phrase). Agent operators default to Coinbase AW (service account, no human in the loop).

### 6.6 Prompt to paste to Claude Code

> Build the Discord bot at `bot/` per section 6 of `SKINCAST_SPEC.md`. Requirements:
>
> 1. TypeScript (strict mode, no `any`), Node 20, discord.js v14, pnpm. `viem` for chain interactions, ABIs generated from `../contracts/out/`. Biome for formatting. Anthropic SDK (`@anthropic-ai/sdk`) for `/ask`.
> 2. Implement all slash commands in 6.1 — both the trading set and the scanner set. Register globally with a `scripts/register-commands.ts` script. All user-facing strings go through an `i18n/` layer (only `en` at launch per principle 10).
> 3. Full button flow per 6.2 for buy (and mirror for sell and claim). All mid-flow messages are ephemeral. Final confirmation message is ephemeral with tx hash link to `basescan.org`. Before every buy, check and set USDC `approve` on the target market if needed (bundle when possible via user-signed multicall, otherwise two sequential txs with clear UI progress). State-aware embeds: show `Proposed` / `Resolved` / `Cancelled` markets differently and gray out inapplicable buttons.
> 4. Implement scanner commands per 6.2.5 hitting the public price API at `process.env.SKINCAST_API_URL` with `process.env.SKINCAST_API_KEY` as the bot's own developer key. `/arbitrage`, `/tradeup`, `/float`, `/spread`, `/news` are wallet-free reads. `/ask` integrates Anthropic Haiku 4.5 with cost cap and per-user rate limiting.
> 5. Privy server-side integration per 6.3. First-time users get DM'd an OAuth link that goes to `/auth/discord` on the landing page, completes Discord OAuth via Privy, creates an embedded EVM wallet, and returns. Bot stores mapping. `caip2` for Base mainnet is `eip155:8453`.
> 6. Coinbase Agentic Wallets path per 6.5.5 — parallel signing backend behind a `WALLET=coinbase` per-user preference stored in `users.walletBackend`. Default: `privy`.
> 7. Postgres schema per 6.4 via Drizzle ORM. Migrations via `drizzle-kit`. Target Neon free tier. Add `walletBackend` column to `users`, an `event_log` table for the sync worker, and an `ask_usage` table tracking Claude API spend per Discord user.
> 8. Market sync worker per 6.5 as a separate process entry (`bot/src/worker.ts`). Use viem's `watchEvent` + `multicall` for efficient polling. Emits configurable announcements per the channel mapping in 6.5. Oracle-operator DMs on `Closed` state transitions. Subscribes to the news monitor's Redis stream (`SKINCAST_NEWS_STREAM`) for real-time TIER1/TIER2 announcements in `#news-events`.
> 9. Rich embed builders in `src/embeds/`: `marketEmbed(market)`, `positionEmbed(position)`, `confirmBuyEmbed(...)`, `resolutionProposedEmbed(...)`, `disputeEmbed(...)`, `arbitrageEmbed(routes)`, `tradeUpEmbed(verdict)`, `floatScanEmbed(listings)`, `newsEventEmbed(classification, markets)`. Use the SkinCast color palette (primary: muted amber `#C9884A`, accent: deep purple `#5A4FCF`; YES `#4ADE80`, NO `#F87171`, INVALID `#9A9893`; TIER1 news `#DC2626`, TIER2 news `#F59E0B`). Show pricing as percentages ("YES 64¢ · NO 36¢") and volume as USD.
> 10. Error handling: map every contract custom error (section 4.1.5) to a user-friendly message. `ReservesInsufficient` → "Market ran low on reserves — await resolution for refund." `SlippageExceeded` → "Price moved; retry with a higher slippage tolerance." All tx failures show a "Report issue" button that DMs a support role.
> 11. Slippage protection: quote price client-side via public RPC, compute `maxCost` = quoted × 1.02 (2% default, user-configurable 0.5–5%), pass into `buy`.
> 12. Coinbase Onramp widget integration for `/wallet` → `Deposit`. Use Coinbase Onramp SDK URL with `destinationWallets` set to the user's embedded address + USDC on Base. DM the user a unique onramp URL.
> 13. Tests (minimum **35 tests**): unit tests for embed builders including state-dependent rendering, unit tests for the error-to-message mapper, scanner command tests with mocked API responses, `/ask` rate-limit + cost-cap tests, news-stream subscription tests, integration tests against Base Sepolia with a test Discord server, end-to-end flow test (OAuth → deposit mock → buy → resolve → claim).
> 14. Dockerfile for Railway deploy. Env vars documented in `.env.example`. Graceful shutdown on SIGTERM (flushes inflight Discord replies, updates DB).
>
> Commit as "feat(bot): Discord-native trading + scanner suite + news-event announcements on Base".

### 6.7 Acceptance criteria

- Fresh Discord user can run `/wallet`, complete OAuth, see their empty USDC balance
- User can fund wallet (via Coinbase Onramp), return to Discord, run `/markets`, `/predict`, buy YES, see confirmation within 20 seconds (including the approve tx on first buy)
- `ResolutionProposed` events trigger `#oracle-operators` announcements within 60 seconds of the on-chain event
- Markets in `Proposed` state show disabled Buy/Sell buttons with a "Dispute window: Xh Ym remaining" footer
- Claim flow works end-to-end on a `Resolved` market and on a `Cancelled` market
- Oracle operator can use `/oracle propose` and `/oracle challenge` from Discord with their embedded wallet
- `WALLET=coinbase` path routes signing through Coinbase AW without Privy ever being called
- `/arbitrage AWP | Asiimov FT` returns a populated table within 3 seconds (cache-warm)
- `/tradeup` modal accepts 10 inputs and returns a verdict embed within 5 seconds
- `/float "Karambit | Doppler" --max-float 0.005` returns at least one listing flagged `SNIPE` from CSFloat fixture data
- `/ask` rate limit triggers at the 51st call in a 24h window for a free-tier user
- TIER1 news monitor fixture → market created → `#news-events` announcement within 90 seconds end-to-end (oracle and bot together)

---

## 7. Phase 4 — Landing page

**Goal:** Modern, beautiful marketing site that converts visitors to either Discord users or OpenClaw oracle operators.

### 7.1 Information architecture

```
/                           Hero + live markets strip + 2 CTAs
/markets                    All markets, filterable, links to Discord for trading
/markets/[address]          Individual market detail (read-only)
/docs                       How it works, oracle operator guide, FAQ
/docs/oracle                OpenClaw skill installation walkthrough
/auth/discord               Privy OAuth handler
/api/markets                JSON endpoint for bot and external use
```

### 7.2 Hero

Above the fold:

- Logo "SkinCast" in a monospace weight
- Headline: "Predict CS skin prices. Settle on-chain."
- Subheadline: "Binary prediction markets for blue-chip Counter-Strike skins. USDC on Base. No custody. No Steam bots. No Valve risk."
- Two large CTAs side-by-side:
  - Primary: "Trade on Discord" → Discord invite link
  - Secondary: "Run an oracle node" → `/docs/oracle`
- Below fold: live strip of 6 most active markets with YES/NO prices ticking in real time via `viem` event subscriptions proxied through an SSE endpoint at `/api/markets/stream`

### 7.3 Visual design

**Typography:**
- Display: Geist Mono (headline, logo, prices)
- Body: Inter
- Code: JetBrains Mono

**Color palette:**
- Background: `#0B0B0F` (near-black, warm undertone)
- Surface: `#14141A`
- Primary: `#C9884A` (muted amber — evokes CS gold / case opening)
- Accent: `#5A4FCF` (deep purple — for links, interactive elements)
- Success/YES: `#4ADE80` (muted green)
- Danger/NO: `#F87171` (muted red)
- Text primary: `#E8E6E0`
- Text secondary: `#9A9893`

**Motion:** Subtle. Framer Motion for: hero text stagger on load, number tickers on live prices, card hover lift. No parallax, no scroll-jacking, no animated backgrounds.

**Layout:** Max-width 1280px. Generous whitespace. Grid-based. No rounded corners above `md` (8px). Sharp, editorial feel.

### 7.4 Market card component

```tsx
<MarketCard>
  <AssetThumbnail src={asset.imageUrl} /> {/* small, 48px */}
  <Question>{market.question}</Question>
  <PriceRow>
    <Outcome side="yes" price={0.64} volume={12340} />
    <Outcome side="no" price={0.36} volume={8902} />
  </PriceRow>
  <Meta>
    <ResolutionTime timestamp={market.resolutionTime} />
    <OracleStatus status="active" />
  </Meta>
  <CTA href={discordTradeLink(market)}>Trade on Discord →</CTA>
</MarketCard>
```

### 7.5 Oracle operator page (`/docs/oracle`)

Prominent install command block at the top:

```bash
pip install skincast-oracle
skincast-oracle init
skincast-oracle register-operator --name "MyOracle"
skincast-oracle run-oracle
```

Or, for OpenClaw users:

```
Install the `skincast-oracle` skill from ClawHub:
  [Copy skill link] → paste into OpenClaw → confirm
```

Below: architecture diagram (SVG), fee economics table, requirements (Base RPC endpoint, signer private key, Buff163 account optional), and a "why run an oracle" section that makes the economic pitch (fees, reputation, skin in the game).

### 7.6 Prompt to paste to Claude Code

> Build the landing page at `web/` per section 7 of `SKINCAST_SPEC.md`. Requirements:
>
> 1. Next.js 14 App Router, TypeScript, Tailwind CSS, shadcn/ui. Dark mode only (no theme toggle — it's always dark).
> 2. Fonts via `next/font`: Geist Mono (display), Inter (body), JetBrains Mono (code).
> 3. Color tokens per 7.3 set in `tailwind.config.ts`. Sharp design — `rounded-lg` max except for pills/badges which are `rounded-full`.
> 4. Pages: `/`, `/markets`, `/markets/[address]`, `/docs`, `/docs/oracle`, plus `/auth/discord` handler and `/api/markets` JSON endpoint.
> 5. Hero per 7.2 with two CTAs and live markets strip. Live strip reads from `/api/markets/stream` (SSE endpoint backed by a `viem` `watchContractEvent` subscription on `Buy`/`Sell`/`Resolved` events from known market addresses).
> 6. Market card component per 7.4. Use real asset thumbnails from Steam CDN (`https://community.cloudflare.steamstatic.com/economy/image/...`). Include a fallback silhouette SVG.
> 7. Oracle page per 7.5 with a prominent install block (copy-to-clipboard button), architecture SVG (draw a simple 3-box diagram: sources → oracle → Base), fee economics table, and "why run an oracle" section.
> 8. Docs page (`/docs`) written in MDX, 6-8 pages covering: how it works, markets, trading on Discord, fees, oracle operators, FAQ, terms. Use shadcn `Sidebar` for nav.
> 9. Motion: Framer Motion hero stagger, live price tickers (rAF-driven number animations), card hover lift (`transform: translateY(-2px)` on `hover:`). No page transitions, no parallax.
> 10. SEO: proper `<title>`, `<meta description>`, OG image (generate a default via `@vercel/og` with logo + headline), `robots.txt`, `sitemap.xml`.
> 11. `/auth/discord` handler: initiates Privy OAuth with Discord as provider, on success creates an embedded EVM wallet (chain: Base), stores the `discord_id → privy_user_id → evm_address` mapping in the shared Postgres (same DB as bot), redirects to success page with "return to Discord" button.
> 12. Vercel deploy config. Env vars in `.env.example`.
>
> Commit as "feat(web): landing page + docs + oracle installer".

### 7.7 Acceptance criteria

- Lighthouse score ≥95 on Performance, Accessibility, SEO, Best Practices
- Live market strip updates within 5 seconds of an on-chain trade on Base Sepolia
- Oracle install flow walks a non-technical user through to a running node in under 10 minutes
- Discord OAuth completes round-trip and creates the mapping correctly

---

## 8. Phase 5 — OpenClaw skill publishing

**Goal:** Publish `skincast-oracle` to ClawHub so OpenClaw users can install it with one click.

### 8.1 Package

The skill is already scaffolded in `oracle/SKILL.md` from Phase 2. Publishing steps:

1. Tag release `oracle-v1.0.0` in git
2. Publish Python package to PyPI: `skincast-oracle`
3. Create ClawHub manifest entry — reference the PyPI package and entrypoint CLI
4. Add a post-install hook that walks the user through:
   - Generating a signer keypair (or importing one)
   - Funding it with ETH on Base for tx fees (~$5 worth covers months of resolutions)
   - Registering as an oracle operator via `skincast-oracle register-operator`
   - Starting the scheduler

### 8.2 Prompt to paste to Claude Code

> Publish the `skincast-oracle` Python package to PyPI and package it as an OpenClaw skill. Steps:
>
> 1. Finalize `oracle/pyproject.toml` with correct metadata (name, version, description, authors, license MIT, Python 3.11+ classifier).
> 2. Add a `skincast-oracle init` command that runs an interactive setup: creates `~/.skincast-oracle/config.toml`, generates or imports a keypair, tests Base RPC connectivity, optionally registers as oracle operator.
> 3. Write GitHub Actions workflow `.github/workflows/publish-oracle.yml`: on tag push matching `oracle-v*`, build sdist + wheel, publish to PyPI via trusted publishing.
> 4. Create ClawHub skill manifest at `oracle/clawhub.json` with install instructions referencing the PyPI package.
> 5. Write `oracle/INSTALL.md` documenting both install paths (bare pip vs ClawHub one-click).
> 6. Add E2E test `oracle/tests/test_skill_install.py` that simulates the full install flow in a clean virtualenv.
>
> Commit as "feat(oracle): PyPI + ClawHub publishing pipeline".

### 8.3 Acceptance criteria

- `pip install skincast-oracle` works on a clean machine
- `skincast-oracle init` produces a valid config in <2 minutes
- ClawHub manifest passes validation

---

## 9. Phase 6 — Launch runbook

**Goal:** Go from Base Sepolia-complete to Base mainnet-live with real markets and real users.

### 9.1 Pre-launch checklist

**Security:**
- [ ] Contest on Cantina or Code4rena Sprint (2-week scope, $15-30k budget). Scope: all contracts in `contracts/src/`, focus on the dispute/finalize state machine.
- [ ] Slither + Echidna runs clean on all contracts
- [ ] Re-run 4.7 attack-surface table: one dedicated test per vector, all green
- [ ] Internal threat model review: oracle manipulation, price spikes, MEV on resolution, factory authority compromise, challenge spam, reserve insolvency from LMSR precision loss
- [ ] Multi-sig on factory authority (Safe, 2-of-3) on Base
- [ ] Pause mechanism tested end-to-end on Sepolia — confirm existing markets continue trading during pause
- [ ] `arbitrate()` drill — walk through the Safe-signed arbitration flow on a Sepolia contested market
- [ ] Emergency migration plan drafted, including signed-refund claim mechanism for off-chain migration

**Oracle:**
- [ ] At least 3 independent oracle operators registered (yourself + 2 trusted parties for launch), each with ≥ `minStake` and verified per-resolution bond capacity
- [ ] Oracle node monitoring dashboards (Grafana): price divergence alerts, missed-resolution alerts, venue downtime alerts, backup-oracle-invocation alerts, challenge-submitted alerts
- [ ] Venue ToS review — Buff163 scraping exposure, mitigations (rate limits per 5.2.5, proxy rotation, user-agent rotation)
- [ ] Dry-run settlement cycle: one full `resolve → wait 24h → finalize` on Sepolia per operator
- [ ] Challenge drill on Sepolia: operator A resolves incorrectly, operator B challenges, owner arbitrates both outcomes

**Capital:**
- [ ] Seed liquidity budget: ~$10k USDC split across Tier 1 markets as initial creator stakes
- [ ] ETH treasury for tx fees: 0.2 ETH on Base to start
- [ ] Oracle stake treasury: 3 × `minStake` = 3000 USDC held for operator subsidies if needed during launch
- [ ] Market-creation gating thresholds confirmed

**Product:**
- [ ] 24 Tier 1 markets created, all with valid oracle feeds for 7 consecutive days on Sepolia
- [ ] Discord server set up: channels (#announcements, #markets, #oracle-operators, #whale-watch, #support), roles (Trader, Oracle Operator, Moderator), mod bot, rules
- [ ] Landing page live at skincast.io (or chosen domain)
- [ ] Terms of service + Privacy policy drafted by a lawyer familiar with prediction markets jurisdiction (US exposure in particular — geoblock US IPs at landing page via Vercel middleware; Polymarket paid the CFTC $1.4M for exactly this reason)
- [ ] Disclosure banner on landing page and inside Discord bot: "Unaudited as of launch / Audited by <firm> as of <date>", whichever is accurate at launch
- [ ] Docs complete and proofread; oracle operator guide walked end-to-end by a non-team tester

**Launch:**
- [ ] Soft launch: announce to 50 hand-picked CS trader Discords, monitor closely for 1 week
- [ ] Public launch: r/GlobalOffensiveTrade post, Twitter thread, reach out to CS influencers (ohnePixel, anomaly, CS community devs)
- [ ] Monitoring: Sentry for bot and web, Grafana for oracle, Tenderly for on-chain tx tracing, contract events tailed to Discord #ops channel

### 9.2 Incident response

**Scenario: oracle publishes divergent price (challenge path)**
- Detection: another operator's local aggregation disagrees with `proposedOutcome`; Grafana alert when a `ResolutionProposed` event lands where our aggregation disagrees by > the configured threshold
- Response (automated): any operator with `AUTO_CHALLENGE=true` and ≥ 2× `perResolutionBond` available submits `challenge()` within the 24h window
- Response (human): factory owner reviews off-chain evidence, calls `arbitrate(winningOutcome)` during the arbitration window
- Result: losing side forfeits bond (half to winner, half to treasury); reputation score updated
- Post-mortem public within 72h

**Scenario: assigned oracle goes silent**
- Detection: `Closed` state markets older than `resolutionTime + BACKUP_DELAY` (48h) with no `ResolutionProposed` event
- Response: any registered operator submits `resolve()` as backup oracle. Oracle operators watching the queue are incentivized by the 30% fee share.
- Follow-up: investigate why primary was silent; reputation penalty via governance if repeated

**Scenario: challenge spam**
- Detection: same address posts ≥3 failed challenges in 24h
- Response: governance review, potential slash via `OracleRegistry.slash()`; operator list entry removed if egregious
- Non-action: do NOT raise challenger bond ratio mid-attack; wait for post-mortem to adjust

**Scenario: Buff163 blocks scraping**
- Detection: scraper error rate >50% for >30 minutes (per-operator Grafana alert)
- Response: fall back to CS.MONEY and Skinport only (aggregator auto-reweights per 5.2.5). Confidence drops; if it drops below 0.5, mark resolutions `Outcome.Invalid` rather than proceeding with weak data.
- Human: rotate residential proxy pool, update session cookie

**Scenario: LMSR reserve insolvency**
- Detection: `ReservesInsufficient` revert during `resolve()`
- Response: market auto-transitions to `Outcome.Invalid` at resolve time (contract enforces this per 4.4.1). Pro-rata refund at claim.
- Investigation: gas-profiling and fuzz re-run to identify the precision-loss path; post-mortem and patch in next deployment

**Scenario: Privy outage**
- Detection: signing failures >10% over 5 minutes
- Response: bot shows banner "trading temporarily paused via Privy, existing positions safe; use `WALLET=coinbase` to bypass", queue user intents, retry on recovery. Agent-mode users (Coinbase AW) continue unaffected.

**Scenario: exploitable contract bug found**
- Detection: audit report, bug bounty submission, or unusual tx pattern
- Response: factory owner calls `pause()` (blocks new markets only; existing trading unaffected), public communication within 1h, fix + redeploy + announce migration within 72h. Users export signed claims against their positions; new contract accepts those claims via a verified migration adapter.

**Scenario: registry grows past soft cap (50 operators)**
- Detection: `register()` reverts in test or live
- Response: governance proposal to raise cap; in the meantime deregistration of inactive operators (`deactivate()` + cooldown) frees slots

### 9.3 Prompt to paste to Claude Code

> Generate operational tooling per section 9 of `SKINCAST_SPEC.md`:
>
> 1. `scripts/mainnet-deploy.sh` — sequenced deploy with prompts between steps, dry-run flag, explicit confirmation before irreversible actions. Uses Foundry scripts under the hood.
> 2. `scripts/seed-mainnet-markets.ts` — creates the 24 Tier 1 markets with correct parameters, reads a `scripts/launch-markets.json` config.
> 3. `ops/grafana/` directory with JSON dashboard exports for: oracle health, contract event volume, market volume, bot uptime.
> 4. `ops/alerts.yml` — Grafana alert rules for incidents in 9.2.
> 5. `ops/INCIDENT_RESPONSE.md` — detailed runbook for each scenario with exact commands to run.
> 6. `ops/THREAT_MODEL.md` — STRIDE-style threat model covering oracle manipulation, MEV, authority compromise, Privy compromise, scraping failures, Discord compromise.
> 7. Vercel middleware in `web/middleware.ts` for US IP geoblock on `/markets/*` and `/api/markets/*`.
> 8. Tenderly alert config for any tx that reverts on our deployed contracts.
>
> Commit as "chore(ops): launch runbook + monitoring + incident response".

---

## 10. Environment variables (consolidated)

Grouped by concern. Each block is self-contained and can be dropped into a single `.env` at repo root — workspace packages `contracts/`, `oracle/`, `bot/`, `web/` each read the subset they need.

```bash
# ─── Chain (shared across all packages) ──────────────────────────────────────
BASE_MAINNET_RPC=https://base-mainnet.g.alchemy.com/v2/<key>
BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/<key>
BASESCAN_API_KEY=<key>
USDC_MAINNET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_SEPOLIA=0x036CbD53842c5426634e7929541eC2318f3dCF7e
SKINCAST_FACTORY_MAINNET=<address>          # filled after deploy
SKINCAST_FACTORY_SEPOLIA=<address>
SKINCAST_ORACLE_REGISTRY_MAINNET=<address>
SKINCAST_ORACLE_REGISTRY_SEPOLIA=<address>
SKINCAST_FEE_SPLITTER_MAINNET=<address>
SKINCAST_FEE_SPLITTER_SEPOLIA=<address>

# ─── Deployer (one-shot use, then rotated out) ───────────────────────────────
DEPLOYER_PRIVATE_KEY=<0x...>                 # NEVER commit; used only by forge script

# ─── Oracle (oracle/ package) ────────────────────────────────────────────────
ORACLE_SIGNER_PRIVATE_KEY=<0x...>            # signer for resolve() / challenge() / finalize()
TREASURY_CREATOR_PRIVATE_KEY=<0x...>         # signer for createTreasuryMarket; auth'd by MarketFactory
SKINCAST_ORACLE_HOME=~/.skincast-oracle      # optional override for config + cache path
BUFF163_PROXY_URL=http://user:pass@proxy.example.com:8080
BUFF163_SESSION_COOKIE=<cookie>
CSFLOAT_API_KEY=<optional, for richer float listings>
FX_API_KEY=<optional, for CNY/EUR rates>
AUTO_CHALLENGE=false                         # opt into auto-challenge when our aggregation disagrees
SKINCAST_ORACLE_DRY_RUN=                     # "fixtures" to force fixture-based CI, empty for live

# News monitor (5.5.6)
ANTHROPIC_API_KEY=<sk-ant-...>               # claude-haiku-4-5 for news classifier
HLTV_RSS_URL=https://www.hltv.org/rss/news
REDDIT_CLIENT_ID=<praw client>
REDDIT_CLIENT_SECRET=<praw secret>
REDDIT_USER_AGENT=skincast-newsmonitor/1.0
TWITTER_BEARER_TOKEN=<optional>              # if using Twitter API v2
CLASSIFIER_DAILY_BUDGET_USD=50               # caps Anthropic spend
NEWS_REDIS_URL=redis://...                   # publishes SKINCAST_NEWS_STREAM for the bot

# Public price API (5.9)
SKINCAST_API_PORT=8000
SKINCAST_API_REDIS_URL=redis://...           # rate-limit token buckets
STRIPE_SECRET_KEY=<sk_live_... or sk_test_...>
STRIPE_WEBHOOK_SECRET=<whsec_...>
STRIPE_PRICE_DEVELOPER=<price_id_for_$20/mo>
STRIPE_PRICE_PRO=<price_id_for_$200/mo>

# ─── Discord bot (bot/ package) ──────────────────────────────────────────────
DISCORD_TOKEN=<bot token>
DISCORD_CLIENT_ID=<app id>
ANNOUNCEMENTS_CHANNEL_ID=<channel id>
MARKETS_CHANNEL_ID=<channel id>
ORACLE_OPS_CHANNEL_ID=<channel id>
WHALE_WATCH_CHANNEL_ID=<channel id>
NEWS_EVENTS_CHANNEL_ID=<channel id>          # TIER1/TIER2 news + auto-created markets
PRIVY_APP_ID=<privy app id>
PRIVY_APP_SECRET=<privy app secret>
COINBASE_AW_API_KEY=<optional, for agent-mode signing>
COINBASE_ONRAMP_APP_ID=<app id>
DATABASE_URL=postgres://...                  # shared with web/

# Bot's own credentials for the public price API (eats its own dogfood)
SKINCAST_API_URL=https://api.skincast.io
SKINCAST_API_KEY=<bot's own developer key>

# /ask command — Anthropic SDK
BOT_ANTHROPIC_API_KEY=<sk-ant-...>           # may be same as oracle's
BOT_ASK_DAILY_BUDGET_USD=100                 # caps /ask spend across all users
BOT_ASK_FREE_TIER_DAILY_LIMIT=50             # per-user
BOT_ASK_PRO_TIER_DAILY_LIMIT=500             # per-user

# News-event consumer (Redis stream from oracle)
NEWS_REDIS_URL=redis://...                   # same as oracle

# ─── Web (web/ package) ──────────────────────────────────────────────────────
NEXT_PUBLIC_FACTORY_ADDRESS=<address>
NEXT_PUBLIC_RPC_URL=<alchemy url>
NEXT_PUBLIC_DISCORD_INVITE=https://discord.gg/skincast
NEXT_PUBLIC_CHAIN_ID=8453                    # Base mainnet; 84532 for Sepolia
PRIVY_APP_ID=<same as bot>
PRIVY_APP_SECRET=<same as bot>
DATABASE_URL=<same as bot>

# ─── Ops (monitoring) ────────────────────────────────────────────────────────
SENTRY_DSN_BOT=<dsn>
SENTRY_DSN_WEB=<dsn>
SENTRY_DSN_ORACLE=<dsn>
GRAFANA_CLOUD_API_KEY=<key>
TENDERLY_ACCESS_KEY=<key>
```

---

## 11. Claude Code working instructions

**Commit policy:** one commit per phase section (4, 5, 6, 7, 8, 9). Use Conventional Commits. No squash during development.

**Test policy:** every phase adds tests. Never commit with failing tests. If a test is flaky, fix it or delete it — don't `.skip` it.

**When blocked:** if you cannot resolve a spec ambiguity, ask one sharp question in the commit message and move on with the stated default. Don't ping me for trivial decisions.

**When adding dependencies:** audit them. Prefer small, single-purpose libraries. Reject anything that hasn't been updated in >12 months unless it's a known-stable standard (OpenZeppelin, viem, PRBMath).

**Code style:** Solidity: solhint + default formatter. TypeScript: strict mode, no `any`, Biome for formatting. Python: ruff + mypy strict.

**No bonus features.** Implement the spec as written. If you see a gap, flag it in a comment prefixed `// SPEC-GAP:` and continue.

**Documentation:** every public function gets a docstring/jsdoc/natspec. Keep `README.md` updated with quickstart and dev instructions.

---

## 12. Starting sequence

After pasting this file into the repo as `SKINCAST_SPEC.md`, run through phases in order:

1. Paste prompt 4.5 → wait for green tests → commit
2. Paste prompt 5.7 → wait for green tests → commit
3. Paste prompt 6.6 → wait for green tests → commit
4. Paste prompt 7.6 → wait for green tests → commit
5. Paste prompt 8.2 → publish → commit
6. Paste prompt 9.3 → commit
7. Execute section 9.1 checklist manually
8. Soft launch

Target timeline: 3–4 weekends of focused work end-to-end. (Base is meaningfully faster to build than Solana would have been — LMSR via PRBMath saves multiple sessions of fixed-point math work, Foundry's test ergonomics are unmatched, and EVM tooling for monitoring and audit is more mature.)

---

## 13. Known spec gaps (deferred to post-launch)

These are conscious deferrals, not oversights. Each entry has a rationale and a tentative phase for follow-up.

| Gap | Rationale | Target |
|---|---|---|
| **Bilingual UI (zh, ru)** | CS scene has huge CN/RU communities; i18n layer is wired in Phase 3/4 per principle 10 but only `en` strings are populated at launch. Adding more locales is a translation task, not code. | Phase 7 |
| **Scalar / categorical markets** | Phase 1 ships binary only — but binary now includes threshold, spread, and news-event types. Scalar (e.g., "closing price") and categorical (e.g., "which skin drops most") require different LMSR formulations. | Phase 8 |
| **Float-tier markets as their own MarketType** | The spec accepts float-tier prediction markets as binary thresholds (e.g., "Will any new M9 Marble Fade with float < 0.001 list within 7 days?"). A first-class `MarketType.FloatThreshold` with CSFloat as a 4th oracle venue makes them more ergonomic. | Phase 7 |
| **On-chain median of multiple oracle proposals** | Current model: one primary oracle + backup path + challenge window. A richer model would take median of N independent oracle proposals like BaoClaw does for price reports. Defers because the single-primary-plus-challenge model is simpler to reason about and dispute costs cap damage. | Phase 9 |
| **Trustless attestation accounting for API revenue** | Phase 2 ships off-chain attestation counting (operator dashboard, audit log, trust the platform). Migrating to a Merkle-committed `PriceAttestations` contract makes operator revenue verifiable on-chain. Defer until API revenue is meaningful. | Phase 9 |
| **Token / governance layer** | Spec ships without a protocol token. Fee flow works without one. A future governance token could hold `OracleRegistry` `setMinStake` and similar knobs currently on the Safe 2-of-3. | Phase 10+ |
| **Market-creator reputation** | No reputation on creators; `/create` is gated only by `minCreatorStake`. Low-quality markets are discouraged by the stake-at-risk (creator forfeits stake if market gets `Cancelled` for `ITEM_DELISTED`). A reputation score improves discoverability. Treasury-created news markets are exempt — they're attributed to `address(this)`. | Phase 8 |
| **Automated dispute arbitration** | Currently requires a human to sign the Safe 2-of-3 `arbitrate()` tx. A future version could use UMA-style optimistic oracle or a committee vote. | Phase 10+ |
| **Skin-backed LP positions via Steam OAuth** | Power users hold $10k+ in skins on Steam. Allowing skins as LP collateral requires centralized escrow (no on-chain proof of Steam inventory), which conflicts with the trust-minimization story. | Post-revenue |
| **Telegram bot mirror** | RU/CN demand is real per the article; same backend as Discord bot. Cheap second surface, but adds another distribution channel to maintain — defer until Discord has product-market fit. | Phase 7 |
| **Mobile push notifications** | News markets are time-sensitive. Discord mobile push works but a dedicated PWA with iOS/Android push for "TIER1 event detected" or "Your market resolves in 1h" would convert better. | Phase 8 |
| **Additional chains** | Base-only at launch. Any multi-chain deploy must solve USDC fragmentation (can't claim positions across chains without bridging). | Post-revenue |

When any phase encounters one of these gaps, the correct response is: flag it with a `// SPEC-GAP:` comment, implement the minimal placeholder, and continue. Do not build toward these unless/until explicitly unblocked.

— End of spec —

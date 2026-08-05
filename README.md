# HyperStrike

The world's first prediction market for Counter-Strike 2 skin prices, presented as a browser-native first-person 3D experience.

> **Status:** production-candidate paper launch. The browser app validates mainnet HIP-4 outcomes and multi-outcome questions, while live skin trading stays fail-closed until permissionless deployment, settlement, oracle, gate, and jurisdiction checks pass. [`HYPERSTRIKE_SPEC.md`](./HYPERSTRIKE_SPEC.md) is authoritative. [`SKINCAST_SPEC.md`](./SKINCAST_SPEC.md) is historical source material only.

Canonical `$HSX` on HyperEVM mainnet: `0xab5dbc5a6070d066697d8e55471877ea4343ece3` (`HSX`, 18 decimals, 1 billion current supply). The deployed token supports `burn` and `burnFrom`, so the burn gate can reduce total supply directly.

HyperStrike is built on Hyperliquid: HIP-4 outcome markets execute natively on HyperCore, while optional HyperStrike-specific onchain components live on HyperEVM. It combines three layers:

1. **HIP-4 skin outcome markets** — Fully collateralized, dated markets about future CS2 skin prices, executed and settled by HyperCore's native outcome-trading primitive.
2. **First-person market world** — An original WebGL/WebGPU environment where users move, inspect market exhibits, use a shooting range, and open precise trading panels without leaving the world.
3. **Skin price oracle** — A versioned, multi-venue reference-price service using resolution-window observations rather than a manipulable single spot quote.

The prediction subject is always a skin or the skin economy. HyperStrike does not offer markets on match winners, rounds, kills, or player performance.

## Repository layout

```text
hyperstrike/
├── apps/
│   └── web/                 Browser shell, 3D client, 2D market UI
├── packages/
│   ├── game/                First-person controls, scene, interactions
│   ├── hip4/                Outcome metadata, CLOB and signing adapters
│   ├── protocol/            API and event schemas
│   └── ui/                  Accessible application components
├── services/
│   ├── api/                 HIP-4 indexer and application API
│   └── oracle/              Venue adapters, aggregation, signed reports
├── contracts/               Tested HyperEVM HSXBurnGate; never market execution
├── scripts/                 Deployment and fixture tooling
└── HYPERSTRIKE_SPEC.md      Authoritative specification
```

## Delivery order

Build the experience before expanding the protocol surface:

1. A one-room first-person market gallery with a local HIP-4-shaped paper CLOB.
2. A deterministic oracle prototype with recorded fixtures.
3. HIP-4 discovery, order, position, and settlement integration on Hyperliquid testnet.
4. Signed HyperCore trading inside the browser.
5. Production data agreements, security review, and jurisdiction review before Hyperliquid mainnet.

## Commands

```bash
pnpm install
pnpm dev                 # browser application
pnpm build               # JavaScript/TypeScript workspaces
pnpm test                # browser + Solidity suites
pnpm hip4:test           # HIP-4 adapter and testnet integration tests
pnpm production:check    # fail-closed mainnet configuration + outcome discovery
pnpm contracts:test      # HSXBurnGate tests
```

The local alpha opens at `http://localhost:5173`. Its three launch-candidate skin markets and `$HSX` balance are explicitly simulated; the HIP-4 network status is live. The retired World Cup event is a demo replay: the anime penalty sequence still stages contract size through its oscillating 1–100 power gauge, but the ticket is saved locally only. It never opens a wallet, burns `$HSX`, or submits a HIP-4 order.

## Permissionless HIP-4 production path

The permissionless upgrade changes HyperStrike from waiting for a curated listing into operating a deployer. Production enablement remains conditional on a validator-approved market template, 500,000 HYPE staked and locked for six months, deployer settlement operations, and three mainnet outcome IDs discoverable through `outcomeMeta`. The app now parses both `outcomes` and `questions`; `pnpm production:check` refuses readiness when any required configuration or launch outcome is missing.

The first launch set is deliberately liquidity-first:

1. **AK-47 Slate (Field-Tested)** - broad retail price point and the strongest observed Steam turnover.
2. **AK-47 Redline (Field-Tested)** - iconic, long-lived reference item with meaningful turnover.
3. **Glock-18 Water Elemental (Field-Tested)** - recognizable non-AK exposure with adequate turnover.

The former Dragon Lore, Howl, and Karambit Fade fixtures are removed from the launch set. They are attractive showcase assets but had no reported Steam volume in the August 5 snapshot, making their reference prices materially easier to distort and harder to reproduce. Thresholds must be refreshed from the approved oracle report immediately before deployment; the values in the 3D client remain paper fixtures until then.

## World Cup demo replay

Because the World Cup event is over, the stadium is preserved as a product demo rather than a trading surface. It demonstrates the event-world pattern without implying active tradability:

1. Choose a demo outcome from the stadium selector.
2. Aim a penalty at YES or NO.
3. Click while the 1–100 gauge is moving; the captured value becomes the demo contract count.
4. Review the simulated reference price, order value, and 1% `$HSX` burn math.
5. Save a local demo receipt in the portfolio.

No injected wallet, HyperEVM transaction, burn gate, or HyperCore IOC order is called from this flow.

The `contracts/` burn-gate tooling and `apps/web/src/liveOrder.ts` remain in the repository as future-event infrastructure, but the current production UI only uses them for non-World-Cup paths such as the manual `$HSX` furnace or future audited live markets.

## Required before live orders

- Production `HSXBurnGate` deployed, verified, funded/owned by the intended owner, and configured for the next live market launch.
- Supported live HIP-4 outcome IDs bound in the gate by the owner/admin wallet.
- One real tiny funded-wallet end-to-end test covering approval, burn, IOC submit, zero/partial/full fill messaging, and portfolio receipt before enabling any live order UI.
- Registered HIP-4 CS2 skin outcome IDs and accepted settlement/oracle policy before moving skins out of paper mode.
- Validator-approved HIP-4 template, 500,000 HYPE deployer stake, six-month lock acknowledgment, settlement runbook, and slashing controls.
- `pnpm production:check` passing against mainnet with exactly three approved launch outcome IDs.
- Wallet, jurisdiction, risk-disclosure, and production hosting configuration.

The participation burn is enforceable inside HyperStrike, but a public HIP-4 market can also be traded through other clients. It must not be advertised as a protocol-wide participation requirement unless HIP-4 adds a native gate.

## License

MIT. Counter-Strike 2 and related marks and assets belong to their respective owners. HyperStrike must use original world, weapon, sound, and interface assets unless separate commercial rights are obtained.

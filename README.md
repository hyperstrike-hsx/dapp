# SkinCast

Counter-Strike skin price prediction markets, public price oracle, and Discord trading suite — settled in USDC on Base.

> **Status: pre-launch, under active build.** See [`SKINCAST_SPEC.md`](./SKINCAST_SPEC.md) for the master build specification.

Three product surfaces, one shared infrastructure:

1. **Prediction markets** — Binary markets on skin prices, cross-platform spreads, and auto-created news-event markets. LMSR pricing, dispute window with bonded oracle resolution.
2. **Public price oracle API** — Multi-venue weighted-median price feed exposed as a paid HTTP API. Operators that run scrapers earn a pro-rata share of API revenue.
3. **Discord-native trading suite** — Slash commands for trading, plus a wallet-free scanner suite (`/arbitrage`, `/tradeup`, `/float`, `/spread`, `/ask`, `/news`) that drives DAU even between trades.

## Repository layout

```
skincast/
├── contracts/       Foundry — LMSR markets, dispute mechanism, oracle registry
├── oracle/          Python — multi-venue scrapers, aggregator, publisher, news monitor, public API
├── bot/             TypeScript — discord.js bot with Privy + Coinbase Agentic Wallets
├── web/             Next.js — landing page, docs, OAuth handler, API key dashboard
├── scripts/         Cross-cutting deploy/seed scripts
├── .env.example
├── pnpm-workspace.yaml
└── SKINCAST_SPEC.md  ← canonical spec
```

## Development

```bash
pnpm install                 # installs workspace JS/TS deps
pnpm forge:build             # build contracts
pnpm forge:test              # run all 120+ contract tests
pnpm oracle:test             # run oracle tests against fixtures
pnpm bot:test                # run bot tests
pnpm test:all                # everything
```

Each package has its own README with details. The spec (`SKINCAST_SPEC.md`) is authoritative — when in doubt, read it.

## License

MIT

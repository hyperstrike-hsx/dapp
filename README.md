# HyperStrike — Trade the CS2 Economy

Five canonical CS2 economy indexes. Native, fully collateralized binary markets on HyperEVM. A browser-first trading terminal with an optional first-person range.

**Current status: launch candidate, not yet deployed and not externally audited.** The indexes run on real prices from five marketplaces. The contracts, deployment script, oracle daemon and settlement keeper are complete and pass a full lifecycle on a fork of HyperEVM with real USDC and HSX. Nothing has been deployed to mainnet. See the [launch runbook](docs/LAUNCH.md) for the exact remaining steps and [implementation status](docs/IMPLEMENTATION_STATUS.md) for what is and is not verified.

**Indexes:** every constituent is priced from the lowest executable USD ask on Skinport, Market.CSGO, DMarket, Waxpeer and LIS-SKINS (liquidity-weighted median, at least three venues, outliers rejected). Baskets were selected by traded volume from items quoted on all five venues and start at 1,000. [Methodology and limits](docs/INDEX_METHODOLOGY.md).

**Static site:** the app reads published `/data/*.json` files with **no runtime backend**. A scheduled job recomputes the indexes with the same code the oracle uses and commits the result; your static host must deploy those updates. That feed is unsigned: markets settle only on the quorum-signed on-chain series. USDC is market collateral.

## Run locally

Use Node **22.13+** (Node 24 recommended), pnpm 11.7, and Foundry for Solidity tests. pnpm is the JavaScript package manager used by this monorepo.

```sh
pnpm install
pnpm dev
```

This starts only Vite on `localhost:1337`. It serves
the same checked-in snapshots as production. Open the printed URL in Chrome or
Firefox for mouse capture. Paper trading and the sports demo require no wallet.

## Deploy the static release

Build with `pnpm install --frozen-lockfile && pnpm build` from the repository root.
Publish **`apps/web/dist`**. Leave `VITE_DATA_MODE` unset (or set to `static`).
Configure your host's SPA fallback for page routes, but serve `/data/*.json` as
real files. No API process, database, signing keys or contract deployment is needed.

`.github/workflows/publish-snapshots.yml` targets ten-minute updates and supports
manual runs. Enable GitHub Actions with repository-content write permission and
allow this workflow to push data commits to `main`. Each run extends the history in
`apps/web/public/data/indicative-indexes.json`; baskets and base prices come from the
committed `config/index-genesis.json`. Fewer than three venues answering preserves the
prior snapshot; the browser marks old data stale based on source timestamps.

**Hosting requirement:** your Git-connected static host must redeploy on snapshot
commits. This repo does not contain hosting credentials or a production deployment
workflow. GitHub-token pushes do not trigger other GitHub Actions workflows; if
you deploy through Actions, add deployment to the snapshot workflow itself. Verify
both `/data/indicative-indexes.json` and `/data/hsx-ohlcv.json` on the live domain.
Use short/revalidated cache lifetimes for these files, not immutable asset caching.
Scheduled runs and host builds may be delayed, so this is a periodically published
preview, not a real-time price service.

Run `pnpm snapshots:publish` manually to refresh the public files (network needed).
Normal builds never fetch providers. Do not delete the published index snapshot:
it contains the persistent preview baseline. For API development only, run
`pnpm dev:full`; production API mode requires explicit `VITE_DATA_MODE=api`, a Node
API deployment with persistent SQLite storage, and `/v1` reverse-proxy routing.

```sh
pnpm typecheck
pnpm test                   # TypeScript and Solidity tests
pnpm build
pnpm production:check       # deliberately fails without reviewed live configuration
pnpm native:deploy          # plan only; never broadcasts by default
pnpm native:deploy --rehearse   # full deployment on a local fork, no real funds
pnpm oracle:daemon --dry-run    # live venue data through the oracle path, no chain, no keys
```

Default SQLite storage is `<repo>/var/hyperstrike.sqlite`, regardless of the service working directory. Set `HS_DATABASE_PATH` to an absolute path to override it. Use the variables in `.env.native.example`; services consume process environment, and Vite reads public variables from `apps/web/.env.local`. Do not put private keys in any `VITE_` variable. No credentials are required for local paper trading.

## Product model

`venue asks → constituent reference prices → canonical indexes → index markets`

- **HS-CS50**, **HS-KNIFE20**, **HS-GLOVE10**, **HS-BLUE20**, **HS-CASE20** are the only market underlyings. Individual skins are data constituents, never market IDs.
- **LEVEL** asks whether the index reaches a canonical level. **MOVE** asks whether it moves a canonical percentage from its creation reference.
- **HSX → STRIKE:** minting capacity burns actual HSX supply and pays an integrated HYPE mint cost. The existing HSX address is `0xab5dbc5a6070d066697d8e55471877ea4343ece3`; its reviewed deployment behavior must still pass launch preflight.
- **Create:** burning exactly one STRIKE, seeding stablecoin liquidity, and registering a unique market happen atomically.
- **Trade:** native complete-set AMM, 20 bps fee, 30% of that fee accrued to the creator. No participation burn.
- **Resolve:** signed index observations, deterministic settlement windows, one bonded challenge with a three-day adjudication timeout, then claim redemption. Fees are segregated from outcome backing.
- **Range:** one target hit stages one contract. It does not send an order. Review and explicit confirmation are required; current range targets use paper markets only.

HIP-4 is a future optional adapter, **not the V1 execution dependency**. World Cup is retired from primary navigation. Historical paper, demo, and legacy World Cup records are preserved and available through Portfolio → Historical archive. Legacy HIP-4 code/contracts remain for reference but are not imported into the new execution path.

## Repository

```text
apps/web/                   React terminal, paper ledger, native wallet actions, Three.js range
packages/index-core/        Pure integer reference-price/index/settlement calculations
packages/market-types/      Canonical index IDs, market definitions, calendars and hashes
packages/oracle-types/      Signed observation schema
packages/sdk/               AMM and integrated mint-curve quote math
services/api/               Append-only store, providers, engine, API, sign/replay/index CLIs
contracts/src/native/       HyperEVM index-native contracts
contracts/test/             Integration, invariants and fuzz tests
infra/                      Monitoring and operational runbooks
docs/                       Improved specification, coverage and release status
```

## Operator tools

```sh
pnpm genesis:build          # select baskets from live data (refuses to overwrite)
pnpm oracle:daemon          # proposer: compute, gather quorum, publish, settle
HS_ORACLE_ROLE=signer pnpm oracle:daemon   # independent signer host
pnpm replay-index --index HS-KNIFE20 --timestamp 2026-09-25T16:00:00Z
pnpm oracle:sign /path/to/candidate-observation.json
pnpm oracle:publish /path/to/signer-a.json /path/to/signer-b.json # simulate only
pnpm chain:index
```

`oracle:daemon` is the long-running service: it reads the venues 45 seconds before each five-minute boundary, commits the inputs, computes the five indexes, gathers a signer quorum and publishes inside the contract's 90-second window. A signer host fetches the venues itself and signs only a proposal that replays exactly and lies within 75 bps of its own data. Nothing is running until you start it. The older one-shot `oracle:sign` / `oracle:publish` commands remain for manual recovery. See [operator runbook](infra/runbooks/index-incidents.md) and [launch checklist](docs/IMPLEMENTATION_STATUS.md).

## Design and assets

[DESIGN.md](DESIGN.md) defines grounded industrial materials, mint/teal brand surfaces, orange accents and readable financial state. The range has local 2K PBR maps, contact occlusion, fixed-resolution rendering, restrained bloom and shoulder-aligned weapon convergence. It does not use ray tracing or Valve game assets. The existing stylized AK is still a fidelity limitation; a licensed realistic first-person weapon/hand rig and authored lighting/props are the next art-production step.

Texture and model attribution lives alongside assets in `apps/web/public/textures/README.md` and `apps/web/public/models/README.md`.

## Which specification applies?

[docs/INDEX_NATIVE_SPEC.md](docs/INDEX_NATIVE_SPEC.md) records the operational clarifications to the supplied Index-Native Production Spec v3. [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) identifies implemented, partial and externally blocked requirements. Older `HYPERSTRIKE_SPEC.md` and `SKINCAST_SPEC.md` are historical and must not be used as current launch instructions.

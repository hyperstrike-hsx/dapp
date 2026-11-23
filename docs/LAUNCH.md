# Launch runbook

Everything below has been executed against a local fork of HyperEVM mainnet
(real USDC, real HSX, the real HSX/WHYPE pool). Nothing has been broadcast to
mainnet. This page lists what is left, in order, and who has to do it.

## 1. Inputs only the operator can supply

| Input                   | What it is                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `HS_ADMIN_MULTISIG`     | A deployed Safe (contract account) on HyperEVM. Holds every admin role after deployment.                            |
| `HS_TREASURY`           | A deployed contract account that receives protocol fees and slashed challenge bonds.                                |
| `HS_COLLATERAL_ADDRESS` | Explicit choice of collateral. Native USDC is `0xb88339CB7199b77E23DB6E890353E22632Ba630f`.                         |
| `HS_ORACLE_SIGNERS`     | Three addresses whose keys live on three separate hosts (2-of-3 quorum).                                            |
| `HS_DEPLOYER_KEY`       | A funded throwaway deployer. Rehearsals spent 0.07–0.32 HYPE depending on gas price; fund 1 HYPE. It keeps no role. |
| `HS_PUBLISHER_KEY`      | A funded hot key that only pays gas for oracle publishes and settlement proposals. Holds no role.                   |
| `HS_REVIEW_REPORT`      | JSON attestation checked by `pnpm production:check`: commit, report URI, HSX and collateral findings.               |
| `HS_PILOT_CAP`          | Per-market collateral cap in whole USDC. Default 10,000. Seed liquidity is limited to a quarter.                    |

`HS_REVIEW_REPORT` is a deliberate gate. The deployment script refuses to
broadcast without a file naming the reviewed commit and a report URI. The
contracts have had one internal adversarial review (findings below), not an
external audit. Decide consciously whether that is sufficient for the cap you
set.

## 2. Freeze the baskets

The baskets are frozen once, on the official base day, **Wednesday 6 January
2027 (UTC)**. The snapshot job freezes and commits them on its first run of
that day. GitHub has been starting that job hours late, so to base at 00:00 UTC
start the "Publish indicative snapshots" workflow by hand at that time, or
freeze from a trusted machine and commit the result:

```bash
pnpm genesis:build
```

Inspect `config/index-genesis.json` and `config/index-genesis.exclusions.json`
before deploying. From the freeze the file does not change, and the build
refuses to replace it: its composition roots are written into `IndexRegistry`
at deployment and every signed observation must match them.

Do not deploy before the base day. The composition written on chain would be
the preview, and the on-chain index would keep that earlier base.

## 3. Rehearse, then deploy

```bash
pnpm contracts:build
```

```bash
pnpm native:deploy --rehearse
```

```bash
pnpm production:check
```

```bash
pnpm native:deploy --broadcast
```

The broadcast runs the same sequence as the rehearsal: 15 deployments, each
under the 3M-gas small-block limit, plus the pool's observation cardinality
raised to 1,800 so the 30-minute HSX TWAP cannot be starved. `SettlementManager`
is the tightest fit at 2.90M gas; if the small-block limit is ever lowered,
switch the deployer to HyperEVM big blocks for that one transaction. It writes a
manifest containing the environment block for the services and the list of role
grants the multisig must execute. Until the multisig executes them, nothing can
be paused or adjudicated; do that before announcing.

## 4. Run the oracle

Three hosts on three different IPs (Skinport allows 8 requests per 5 minutes per
IP), each with the repository at the deployed commit and the manifest's
environment.

Two signer hosts:

```bash
HS_ORACLE_ROLE=signer HS_SIGNER_KEY=… HS_SIGNER_TOKEN=… HS_SIGNER_PORT=8791 pnpm oracle:daemon
```

One proposer host, which also signs, publishes and runs the settlement keeper:

```bash
HS_SIGNER_KEY=… HS_PUBLISHER_KEY=… HS_SIGNER_URLS=https://signer-b,https://signer-c HS_SIGNER_TOKEN=… pnpm oracle:daemon
```

`pnpm oracle:daemon --dry-run` computes and prints one cycle without keys or
transactions; run it first on each host. Every five minutes the proposer reads
the five venues, computes each index, collects one co-signature (each signer
refetches the venues itself and refuses a value more than 75 bps from its own),
and publishes. Observations must land within 240 seconds of their slot.

The same process pushes the quorum-signed HSX reference price and proposes and
finalises expired markets.

## 5. Front end

Put the manifest's `VITE_*` addresses into the web build, run `pnpm build` and
`pnpm static:check`, and deploy. Keep the snapshot job (`pnpm
snapshots:publish`) on a different IP from the oracle hosts.

## Operations

- **Bad print.** The resolution committee calls `IndexRegistry.voidSlots` for the
  affected five-minute slots (at most six hours, within two days). Settlement
  skips them. Declaring an incident halts creation and trading on that index
  going forward; it never rewrites past observations.
- **Pause.** `PAUSER_ROLE` can pause minting, creation or trading. Only the
  admin multisig can unpause.
- **Oracle outage.** Settlement uses a ±5-minute TWAP, then ±15 minutes, then
  ±1 hour around resolution. If none is usable 24 hours after resolution the
  market resolves INVALID and every YES and NO token redeems for half its face
  value.
- **Challenge.** Anyone can challenge a proposal once with a 0.1 HYPE bond. The
  committee cannot choose a price, only recompute from the oracle. An
  unadjudicated challenge lapses after three days.
- **Rebalance.** New compositions go through `IndexRegistry.schedule` with seven
  days' notice.

## Known risks accepted at launch

1. **No external audit.** One internal adversarial review found no way to drain
   or lock collateral. Its two high-severity findings (a pauser could force
   INVALID retroactively; a short oracle outage voided markets) are fixed and
   covered by tests.
2. **The multisig is trusted.** As `DEFAULT_ADMIN_ROLE` it can grant itself any
   role immediately. Parameter changes go through the 48-hour `ConfigTimelock`;
   role grants do not.
3. **Two of three signers colluding can publish any index value.** Run them in
   separate custody.
4. **HSX price.** The HSX/WHYPE pool held about $14k and had not traded for
   roughly two months when measured. STRIKE minting requires that pool's
   30-minute TWAP and a quorum-signed reference to agree; the reference itself
   reads the same pool's spot price, so the two are not independent. Cheap to
   move for a determined actor; the damage is bounded to mispriced STRIKE
   mints, not to market collateral.
5. **Ask-based index.** No venue except Skinport publishes trades. Moving the
   index needs the lowest ask changed on three venues at once. Baskets hold
   liquid items, but a $10,000 market cap is the intended bound on the incentive.
6. **Data licence.** The five venue endpoints are public but none has granted a
   commercial licence. Venue terms need a legal read before fees are charged at
   scale.
7. **Regulatory.** Prediction markets with real collateral are regulated in many
   jurisdictions. Nothing in this repository addresses that.

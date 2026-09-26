# Range fixes and HSX market tape

- Removed large camera-facing light-shaft sprites. GTAO now excludes transparent,
  alpha-tested and non-depth-writing objects during the normal/depth pass only;
  visibility is restored even if rendering throws. The normal beauty pass keeps
  glass, fire and other transparent effects.
- Instruction/foundry signs sit against the side walls, outside market lanes.
  Screen text stays below the bloom threshold; bodycam chromatic separation and
  grain are reduced. Labels use larger, higher-contrast typography.
- Foundry and chart are native modal dialogs over the existing range. **Back to
  range** closes the dialog and requests mouse capture, retaining position, aim,
  ammunition and staged votes. **Escape / Close** returns to the paused range.
  Paused range shortcuts also open both panels; E opens the targeted furnace or
  chart wall. Key input is ignored by the weapon while a dialog has focus.

## Chart

The entrance wall at z=10 (behind the initial spawn) displays a 1920×960 native
WebGL canvas texture. It updates on feed changes, not on every animation frame.
Aim at it and press E, or pause and choose **$HSX candle chart**, to expand it.

The exact HyperEVM pool is `0xa92ab5ed3041025b844233b109216c6c3c0bc63c`.
HSX base token is checked against `0xab5dbc5a6070d066697d8e55471877ea4343ece3`.

- `GET /v1/hsx/ohlcv` proxies GeckoTerminal's public hourly USD OHLCV endpoint.
- Fixed upstream URL, 8-second timeout, 30-second server cache and coalesced
  requests; client uses one shared, cancellable poll for both displays.
- No API key required. Run both web and API using `pnpm dev`.
- It is polling, not a streaming/tick-by-tick feed. Provider indexing can lag.
- No synthetic candles or forward-filled inactive intervals. Time gaps remain
  visible. Last candle time and successful fetch time are displayed separately.
- Upstream failure retains last good data with an explicit STALE label; initial
  failure shows UNAVAILABLE and retries. It never presents a fake price.
- This is a display feed, not a mint-price or settlement oracle.

DEXTools' [official widget documentation](https://github.com/dextools-io/chart-widget)
states that localhost embedding is unsupported. The in-world chart therefore
uses [GeckoTerminal OHLCV](https://api.geckoterminal.com/docs/index.html) for the
same pool and clearly labels that source. The expanded panel links to the
[requested DEXTools pair](https://www.dextools.io/app/hyperevm/pair-explorer/0xa92ab5ed3041025b844233b109216c6c3c0bc63c).

Checks: `pnpm typecheck`, `pnpm test:js`, `pnpm build`. New tests cover opaque-only
occlusion/restoration, token/OHLCV validation, sparse candles, cache coalescing,
and initial/subsequent upstream failures.

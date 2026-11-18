# Evolution: multiplayer range and social trading

Status: proposal, not scheduled. Written 2026-11-18. Nothing described here is implemented.

## Where the product is today

- The app has no realtime transport. `services/api` serves HTTP only (`/v1`, proxied by Vite), and the
  production path can be a static snapshot.
- The range is single-player. Shots at a station ("votes") live in React state in `apps/web/src/App.tsx`
  and are lost on reload.
- Wave mode (`apps/web/src/range/horde.ts`) is simulated entirely in the browser.
- Orders go from the wallet to the contracts. `services/api/src/chain-indexer.ts` already indexes chain events.
- Every range map shares one footprint and fixed station positions (`apps/web/src/range/kit.ts`), which makes
  shared state between players simple: a position means the same thing on every client.

## Recommended order

Build three layers, each usable on its own. The first is the foundation for the other two.

### 1. Realtime channel

Add a WebSocket endpoint to `services/api`, next to the existing HTTP server.

- Rooms: one per range instance, keyed by map id plus a short room code, capped at about 8 to 16 players.
- Identity: the connected wallet signs a one-time message to open the socket. Guests join as read-only
  spectators with a generated name.
- Authority: the server relays and validates messages. It never holds funds or keys; orders stay
  wallet to contract.

### 2. Multiplayer range

- Presence: each client sends position, yaw, weapon and stance about 15 times a second; other clients
  interpolate. Remote players can reuse the first-person arms rig with a simple body, or a full character
  loaded the way `range/zombieModels.ts` loads skinned models.
- Shared shots: send "fired at station X, side YES or NO" as an event and play the existing tracer and
  strike effects for everyone in the room. Station tallies become a room-wide count instead of local state.
- Co-op waves: make one player the host who simulates the zombies and broadcasts their state, instead of
  moving the simulation to the server. This is much less work and adequate for co-op. It is not cheat-proof,
  so wave scores must not feed any leaderboard that pays out.

### 3. Social trading

Derive as much as possible from chain data, so the client does not have to be trusted.

- Profiles and leaderboards: positions, realised profit and loss, and win rate per address, from indexed fills.
- Activity feed: "X bought YES on HS-KNIFE20" from indexed events, pushed over the same socket. In the range
  it can appear on the control-centre screens.
- Follow: an off-chain follow list in the API store, signed by the follower's wallet.
- Copy trading, first version: a followed trader's fill pre-fills the follower's ticket, and the follower
  confirms it themselves.
- Copy trading, automatic: needs delegated session keys or a vault contract. That is a contract change with
  an audit and, depending on jurisdiction, a regulatory question. Treat it as a separate project.

## Decisions to make before starting

- Anti-cheat depth: relay-only is enough while the range is a trading interface. Competitive modes with
  rewards would need server-side hit validation.
- Hosting: WebSockets need a long-running server; the static-snapshot deployment cannot serve them.
- Privacy: whether positions are public by default or opt-in per profile.

## Suggested first step

Presence and shared shots. It is the smallest piece that makes the range feel shared, and the socket, rooms
and identity it requires are reused by the feed and the leaderboards.

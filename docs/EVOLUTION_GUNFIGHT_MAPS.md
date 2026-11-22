# Evolution: fight maps and multiplayer gunfights

Status: proposal, not scheduled. Written 2026-11-22. Nothing described here is implemented.

This covers turning the range into maps players can fight on, and round-based matches between players.
It goes further than [EVOLUTION_MULTIPLAYER_SOCIAL.md](EVOLUTION_MULTIPLAYER_SOCIAL.md), which describes
players sharing the existing range (presence, shared shots, host-simulated co-op waves). That proposal is
the cheaper intermediate step, and its realtime channel and wallet identity are groundwork for this one.

## Summary

The art side carries over well. The game underneath is a shooting gallery, not yet a game other players
can share. Four things have to be built, and only one of them (map scenery) can be produced as fast as the
ranges were.

## Where the range is today

- **One footprint.** All 18 ranges are scenery around the same flat 19 x 37 m rectangle. Buildings outside
  it are front-only shells, drawn to be seen from inside.
- **Movement.** The player is clamped to that rectangle (`apps/web/src/World.tsx`: x within 8.6 m of the
  centre line, z from -24.4 to 8). The floor has one height. A jump lifts the camera and nothing else.
- **Collision.** `apps/web/src/range/solids.ts` photographs the scene from above, between knee and chest
  height, and uses the picture as a 2D map of where a body cannot stand. There is no vertical collision.
- **Shots.** A ray from the centre of the camera against the scene's meshes, decided in the browser.
- **Game loop.** One effect of about 2,000 lines in `World.tsx` holds movement, weapons, wave mode and
  rendering together.
- **Server.** None at runtime. The released site is static; `services/api` serves HTTP only.
- **Players.** First-person arms only. There is no human body, and no teams or rounds.
- **Download.** Every map's code ships in one chunk (681 kB gzipped with 18 ranges).

## What carries over

- The map kit: photo materials, props, lighting, weather, wildlife and the synthesised soundscapes.
- Six weapons with hands, reloads, world models, and dropping and picking up.
- Wave mode's enemies, damage and headshots, in single-player form.
- Touch controls for phones.

## What has to be built

| Piece | Needed | Size |
|---|---|---|
| Movement and collision | A character controller on real 3D collision: stairs, ramps, crates to jump on, gaps to crouch under. It must behave identically in the browser and on a server. | Medium. Everything else waits on it. |
| Maps | Real layouts: routes, cover, sightlines, two spawn areas. Each starts as a collision blockout, is playtested, then dressed with a range's theme. | Medium per map. Dressing can be done in parallel; layout and playtesting cannot. |
| Netcode and server | An authoritative game server at a fixed tick, client prediction with reconciliation, interpolation of other players, and hits judged on the server with lag compensation. | Large. The bulk of the work. |
| Players and rules | A rigged, animated player model with hitboxes. Rounds, spawns, loadouts, scoreboard, kill feed, spectating. | Medium. |

Three structural points sit under the table.

- **Split the simulation from the renderer.** Movement, weapons and damage have to leave `World.tsx` and
  become a module with no browser or three.js imports, so the same code runs on both sides.
- **The existing ranges do not convert automatically.** Their themes and assets do; their geometry mostly
  does not. The practical route is to pick two or three themes and build a fight layout in each.
  Layouts are original designs, as the ranges are.
- **Load maps on demand.** Larger maps make the single chunk untenable. Each map's code should download
  only when it is picked.

Rendering also needs rework for larger maps: the range uses one shadow map rendered once, and a mirror
floor and haze pass tuned for one room.

## Decisions to make before starting

1. **Mode.** Recommended: 2v2 rounds, the smallest thing that plays like a team game. A 1v1 duel is
   simpler to build first and is a fair stepping stone.
2. **Stakes.** A browser client cannot be trusted against cheats; aim assistance is easy to write for a
   JavaScript game. If matches ever carry money or tokens, cheat prevention and regulatory questions
   become the main problem. Recommended: no stakes on gunfights at first.
3. **Hosting.** Always-on game servers close to the players, with a monthly cost and an account to
   provision. Rooms by invite link are the simplest way to start; matchmaking can follow.
4. **Player model.** It has to be sourced, which means a download and a licence check.
5. **Phones.** Playable, but not on equal terms with mouse and keyboard, and larger maps push a phone's
   memory harder. Recommended: desktop first.

## Order of work

1. **Greybox arena.** Real movement and collision in an untextured test map, the simulation split out,
   no networking. Done when the player can climb stairs, walk a ramp, jump onto a crate, crouch through a
   gap, cannot pass a wall or leave the map, shots stop on the collision world, and the step function
   runs under test outside the browser with the same result every time.
2. **One networked match.** A hosted server, invite-link rooms, placeholder bodies, fixed loadouts,
   rounds.
3. **Make it a game.** A proper player model, one dressed map, then a second and third, and a buy menu
   if wanted.
4. **Scale.** Matchmaking, regions, cheat hardening, phones.

Steps 1 and 2 are a few weeks of focused work. That is a judgement, not a measurement. Feel and
real-network latency cannot be judged from automated checks; they need people playing.

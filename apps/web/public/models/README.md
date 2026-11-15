# Weapon models

`bolt-action-rifle/` is **Bolt Action Rifle 7.62** by Mateusz Sadek, the bolt-action rifle (slot 5).

- Source: https://polyhaven.com/a/bolt_action_rifle_7_62
- License: CC0
- glTF with 2K maps for the rifle and 1K maps for its accessories (about 12 MB).
  Reproduce with `node scripts/fetch-range-rifle.mjs`, which verifies each file's MD5.

`ak-platform.glb` is **Stylized AK-47** by GoldbergR, the AK-47 (slot 1), re-surfaced at load.

- Source: https://www.getglb.com/combat-assets/stylized-ak-47/
- License: Creative Commons Attribution


The M4A1, FAMAS and Uzi, the gloved arms and the wave-mode zombies have no model files:
they are built in code (`src/range/arsenal.ts`, `src/range/hands.ts`, `src/range/horde.ts`).

# Weapon models

`bolt-action-rifle/` is **Bolt Action Rifle 7.62** by Mateusz Sadek, the bolt-action rifle (slot 5).

- Source: https://polyhaven.com/a/bolt_action_rifle_7_62
- License: CC0
- glTF with 2K maps for the rifle and 1K maps for its accessories (about 12 MB).
  Reproduce with `node scripts/fetch-range-rifle.mjs`, which verifies each file's MD5.

`ak-platform.glb` is **Stylized AK-47** by GoldbergR, the AK-47 (slot 1), re-surfaced at load.

- Source: https://www.getglb.com/combat-assets/stylized-ak-47/
- License: Creative Commons Attribution


`arms/` is **First Person arms** by DJMaesen, the first-person arms and gloved hands.
Its skeleton is posed in code (`src/range/hands.ts`); the file ships no animations.

- Source: https://sketchfab.com/3d-models/first-person-arms-e3c42c05b22944e5839deb8e003f0987
- License: CC BY 4.0 (see `arms/license.txt`)
- glTF with 2K base colour, normal and roughness maps (about 13 MB).

`zombies/` is **Free Zombies** (v0.98, glTF) by Denys Almaral, the wave-mode zombies:
ten bodies on two skeletons, with ten retargeted clips per skeleton, all sharing one
palette texture. Loaded by `src/range/zombieModels.ts` the first time wave mode starts.

- Source: https://denysalmaral.com/gamedev/free-zombies/
- License: not stated in the pack's `ReadMe_FreeZombies.txt`; confirm the terms with the
  author before publishing these files.
- About 15 MB; each animation file repeats the mesh, which the loader discards.

The M4A1, FAMAS and Uzi have no model files: they are built in code (`src/range/arsenal.ts`).


Phones and tablets fetch lighter copies of the first-person textures (`leanUrl` in `src/range/touch.ts`):
`arms/textures-lean/` is `arms/textures/` at 1024 pixels as JPG (`sips -Z 1024 -s format jpeg -s formatOptions 88`),
and `bolt-action-rifle/textures-lean/` is `bolt-action-rifle/textures/` at half size under the same file names
(`-s formatOptions 86`). Same licences as their sources. Regenerate them after replacing a source texture.

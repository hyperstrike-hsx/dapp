# Rendering environment

`bonzai-sky.hdr` is imported from the local `bonzai-desktop-dapp` rendering stack. In the range it is only the sky seen through the roof lights. Image-based lighting comes from a reflection probe captured from the lit room itself at load (`src/range/environment.ts`), so reflections and ambient light match the lamps, screens and furnace actually present.

The other range maps each have their own sky, 2K HDRIs from [Poly Haven](https://polyhaven.com/license) (CC0),
fetched and MD5-verified by `node scripts/fetch-range-maps.mjs`:

- `goegap-2k.hdr`: [Goegap](https://polyhaven.com/a/goegap), the Dust Court sky.
- `tears_of_steel_bridge-2k.hdr`: [Tears of Steel Bridge](https://polyhaven.com/a/tears_of_steel_bridge), the Piazza sky.
- `rooftop_night-2k.hdr`: [Rooftop Night](https://polyhaven.com/a/rooftop_night), the Nightline sky.

Each map's sun or moon light is aimed along the direction measured from its sky file, so shadows agree with
the sky, and image-based light is again a probe captured from the lit map (`src/range/kit.ts`). The Core Hall
map is sealed and has no sky.

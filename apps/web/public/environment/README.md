# Rendering environment

`bonzai-sky.hdr` is imported from the local `bonzai-desktop-dapp` rendering stack. In the range it is only the sky seen through the roof lights. Image-based lighting comes from a reflection probe captured from the lit room itself at load (`src/range/environment.ts`), so reflections and ambient light match the lamps, screens and furnace actually present.

The other range maps each have their own sky, 2K HDRIs from [Poly Haven](https://polyhaven.com/license) (CC0),
fetched and MD5-verified by `node scripts/fetch-range-maps.mjs`:

- `goegap-2k.hdr`: [Goegap](https://polyhaven.com/a/goegap), the Dust Court, Airframe and Bazaar sky.
- `tears_of_steel_bridge-2k.hdr`: [Tears of Steel Bridge](https://polyhaven.com/a/tears_of_steel_bridge), the Piazza sky.
- `rooftop_night-2k.hdr`: [Rooftop Night](https://polyhaven.com/a/rooftop_night), the Nightline and Quayside sky.

On HIGH quality the sky the player sees is not the 2K HDR, which reads soft on a high-density display, but an
8K tonemapped JPG of the same panorama drawn on a dome (`src/range/skyBackdrop.ts`). The HDR keeps lighting the
scene and feeding the floor reflections. The JPGs come from the same Poly Haven assets (CC0) and the same script:

- `goegap-8k.jpg`, `tears_of_steel_bridge-8k.jpg`, `rooftop_night-8k.jpg` (8192 × 4096, about 17 MB together).

A tonemapped JPG is display-referred, so `skyBackdrop.ts` carries a measured curve per sky that maps it back to
the HDR's radiance; the dome then matches the background it replaces in brightness and colour. Devices that
cannot hold an 8K texture, touch devices and PERFORMANCE quality keep the HDR background.

Each map's sun or moon light is aimed along the direction measured from its sky file, so shadows agree with
the sky, and image-based light is again a probe captured from the lit map (`src/range/kit.ts`). Core Hall,
Underline and Whiteout have no sky file (sealed, underground and overcast).


Phones and tablets fetch each sky as its `*-1k.hdr` copy (`bonzai-sky-1k.hdr` for the foundry): the same picture at
1024 x 512, a 2 x 2 average of the 2K file in linear light, run-length encoded (`leanUrl` in `src/range/touch.ts`).
A quarter of the download, and three.js then builds a 12 MB sky cube from it instead of a 48 MB one.

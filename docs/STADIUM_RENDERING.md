# Stadium rendering pass

The retired sports demo keeps its four goal cut-ins, 1–100 contract gauge and
local-only receipts. This update affects rendering, not the trading protocol.

## Visible changes

- Locally served 2K grass base-color, normal, roughness and AO maps, with mowing
  stripes. Turf is rough and non-metallic instead of a glossy blue surface.
- Painted, non-emissive field markings and a penalty arc outside the box.
- Concrete terracing, seat rows, jacket/head/arm silhouettes, concourses,
  cantilever roofs and steel trusses. Spectators are seated on their own tread,
  with aisles; they no longer consist only of floating points.
- Instanced spectators sway in the vertex shader; the existing waving phone
  lights, flags and wind-drifting red smoke remain.
- A raking floodlight key from behind the goal, with mint/amber practical accents
  as fill. A cached 4096 shadow map anchors the static architecture and is only
  re-rendered while the ball is in flight, so the ball casts a shadow.
- Volumetric haze (`range/volumetric.ts`) ray-marched against that shadow map, with
  analytic halos around four floodlight banks; wind-slanted rain streaks.
- Rain-soaked turf (`stadiumSurface.ts`): procedural mowing bands, goal-mouth wear,
  damp sheets and a blurred planar reflection rendered at 35% resolution. The
  crowd and rain are left out of the mirror.
- Scrolling LED perimeter boards, and glossy emissive scoreboard and target panels.
- Image-based lighting captured from the stadium itself once at load (two passes
  for one bounce) instead of no environment light.
- Half-resolution GTAO adds contact depth. Transparent effects are excluded from
  the GTAO override.
- Highlight bloom, then tone mapping, then FXAA on the display-referred image.
  Stable internal resolution capped at 2.8 million pixels / 1.75 DPR. No
  depth-of-field blur or automatic resolution downgrade. This is rasterized WebGL
  lighting, not hardware ray tracing.
- Deep side/back/roof goal netting, short impact deformation, a panel-textured
  ball, and a smaller focus portrait that leaves the goal visible.

## Lifecycle and performance

Materials load before the first revealed frame. A failed asset leaves a fallback
material and does not hang startup. No runtime texture-provider dependency.
Instancing batches stadium architecture and the crowd. Only two additional bank
spotlights are used, and two of the four smoke flares carry a point light.
Measured uncapped on an Apple M1 Max at the 2.8 MP budget, the pass costs about
a quarter of the previous frame rate (roughly 100 → 75 FPS). Materials, postprocessing,
textures and the WebGL context are disposed on leaving the demo.

The actual animation-loop FPS is available at `.soccer-world.dataset.fps` for
diagnostics. It is a local measurement, not a hardware-independent 60 FPS promise.
Run `pnpm typecheck`, `pnpm --filter @hyperstrike/web test`, and `pnpm build`.

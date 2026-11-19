# Environment textures

`concrete-floor-worn-001/` is the 1K JPG PBR set for **Concrete Floor Worn 001** by Dimitrios Savva and Rico Cilliers, downloaded from [Poly Haven](https://polyhaven.com/a/concrete_floor_worn_001).

Poly Haven assets are released under [CC0](https://polyhaven.com/license). The set includes diffuse, OpenGL normal, roughness, and ambient-occlusion maps.

Index-native range additions:

- `concrete_floor_worn_001-2k/`: local 2K base color, OpenGL normal, roughness and AO from [Concrete Floor Worn 001](https://polyhaven.com/a/concrete_floor_worn_001).
- `brick_wall_001-2k/`: local 2K base color, OpenGL normal, roughness and AO from [Brick Wall 001](https://polyhaven.com/a/brick_wall_001).

Both sets are CC0. `scripts/fetch-range-materials.mjs` verifies downloaded files against the API's content MD5 before saving. No runtime third-party texture requests are made. Base-color maps are sRGB; data maps remain linear.

Stadium upgrade:

- `grass_ground-2k/`: 2K diffuse, OpenGL normal, roughness and AO from
  [Grass Ground by Charlotte Baglioni](https://polyhaven.com/a/grass_ground), CC0.
  Reproduce with `node scripts/fetch-range-materials.mjs grass_ground`.
- The stadium reuses the existing concrete PBR maps for terracing and concourses.
- Seats, fans, roof trusses, the football pattern and flags are generated in code.

Rifle furniture:

- `lacquered_cherry_wood-2k/`: 2K diffuse, OpenGL normal and roughness from
  [Lacquered Cherry Wood](https://polyhaven.com/a/lacquered_cherry_wood), CC0. The AO map is not used and not kept.
  Reproduce with `node scripts/fetch-range-materials.mjs lacquered_cherry_wood`.

Range maps (all 2K: diffuse, OpenGL normal and roughness; AO maps are not kept; all CC0 from Poly Haven):

| Folder | Source | Used for |
| --- | --- | --- |
| `sandstone_cracks-2k/` | [Sandstone Cracks](https://polyhaven.com/a/sandstone_cracks) | Dust Court ground |
| `cobblestone_floor_04-2k/` | [Cobblestone Floor 04](https://polyhaven.com/a/cobblestone_floor_04) | Piazza paving |
| `painted_plaster_wall-2k/` | [Painted Plaster Wall](https://polyhaven.com/a/painted_plaster_wall) | Plaster, tinted per building |
| `asphalt_02-2k/` | [Asphalt 02](https://polyhaven.com/a/asphalt_02) | Roof decks, quays, aprons |
| `snow_02-2k/` | [Snow 02](https://polyhaven.com/a/snow_02) | Whiteout ground and drifts |
| `corrugated_iron_02-2k/` | [Corrugated Iron 02](https://polyhaven.com/a/corrugated_iron_02) | Roof decks, sheds, containers |
| `metal_plate-2k/` | [Metal Plate](https://polyhaven.com/a/metal_plate) | Floor plates, machinery |
| `rusty_metal_02-2k/` | [Rusty Metal 02](https://polyhaven.com/a/rusty_metal_02) | Weathered steel |
| `green_metal_rust-2k/` | [Green Metal Rust](https://polyhaven.com/a/green_metal_rust) | Painted steel with wear |
| `tiled_floor_001-2k/` | [Tiled Floor 001](https://polyhaven.com/a/tiled_floor_001) | Station and market tiling |
| `weathered_brown_planks-2k/` | [Weathered Brown Planks](https://polyhaven.com/a/weathered_brown_planks) | Timber, crates, stalls |
| `fabric_pattern_07-2k/` | [Fabric Pattern 07](https://polyhaven.com/a/fabric_pattern_07) (colour variant 1) | Cloth, awnings, rugs |
| `concrete_wall_007-2k/` | [Concrete Wall 007](https://polyhaven.com/a/concrete_wall_007) | Cast concrete walls |

Reproduce all of them, and the map skies, with `node scripts/fetch-range-maps.mjs`
(MD5-verified against the Poly Haven API; files already present are skipped).

Phones and tablets:

- Every `*-1k/` folder is its `*-2k/` neighbour resized to 1024 pixels (`sips -Z 1024 -s formatOptions 82`), same files, same licence.
  The range loads these on touch devices, where a browser closes a page that holds a desktop's worth of textures
  (see `leanAssets` in `src/range/touch.ts`). Regenerate a set after replacing its 2K source.

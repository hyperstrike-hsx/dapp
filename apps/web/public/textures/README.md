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

Range maps (Dust Court, Piazza, Nightline):

- `sandstone_cracks-2k/`: 2K diffuse, OpenGL normal and roughness from
  [Sandstone Cracks](https://polyhaven.com/a/sandstone_cracks), CC0. The Dust Court ground.
- `cobblestone_floor_04-2k/`: 2K diffuse, OpenGL normal and roughness from
  [Cobblestone Floor 04](https://polyhaven.com/a/cobblestone_floor_04), CC0. The Piazza paving.
- `painted_plaster_wall-1k/`: 1K diffuse, OpenGL normal and roughness from
  [Painted Plaster Wall](https://polyhaven.com/a/painted_plaster_wall), CC0. Tinted per building in both towns.
- `asphalt_02-1k/`: 1K diffuse, OpenGL normal and roughness from
  [Asphalt 02](https://polyhaven.com/a/asphalt_02), CC0. The Nightline roof deck.

AO maps are not kept for these sets. Reproduce all four, and the map skies, with
`node scripts/fetch-range-maps.mjs` (MD5-verified, about 37 MB in total).

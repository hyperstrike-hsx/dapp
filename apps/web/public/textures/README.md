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

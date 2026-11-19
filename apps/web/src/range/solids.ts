import * as THREE from "three";

// A plan of what stands on the floor, so the player cannot walk through it.
//
// Every map dresses the edges of the lane with its own crates, drums, carts, barriers and
// furniture, and none of them carries collision data. Instead of asking ten maps to describe their
// props, the scene is photographed once from above: an orthographic render of only the slab between
// knee and chest height, with every solid mesh drawn opaque. A covered pixel is something a body
// would hit (coverage is read from alpha: instanced props multiply their own tint into the colour,
// so a dark drum would otherwise go missing). The picture is grown by the body's radius, so the lookup at walk time is one array read.
//
// The slab starts at knee height on purpose: kerbs, cable covers, drifts and puddles stay walkable.
// It stops below head height: a lamp or banner overhead must not become an invisible wall.

const X0 = -9.3, X1 = 9.3, Z0 = -25.6, Z1 = 9.0;
const CELL = 0.05, LOW = 0.45, HIGH = 1.25, LAYER = 7;

export type Solids = {
  /** True where a body centred on this point would overlap something standing on the floor. */
  blocked: (x: number, z: number) => boolean;
};

function standsSolid(object: THREE.Object3D): object is THREE.Mesh {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh || (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh || mesh.userData.walkThrough) return false;
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) if (!node.visible) return false;
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material | undefined;
  if (!material) return false;
  // Glows, light pools, haze cards, flames, decals and the sky dome are not things to bump into.
  if (material.blending === THREE.AdditiveBlending || material.depthWrite === false) return false;
  if (material.transparent && material.opacity < 0.35) return false;
  return true;
}

/**
 * Photographs the floor plan. `start` is where the player spawns and `mustReach` are points the
 * player has to be able to walk to (the stations, the furnace): if the plan would cut any of them
 * off, something that is not really an obstacle got into it, and no plan is better than a wrong one.
 */
export function surveySolids(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, body: number,
  start: [number, number], mustReach: Array<[number, number]>,
): Solids | null {
  const width = Math.round((X1 - X0) / CELL), height = Math.round((Z1 - Z0) / CELL);
  const camera = new THREE.OrthographicCamera(X0, X1, -Z0, -Z1, 0, HIGH - LOW);
  camera.position.set(0, HIGH, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.layers.set(LAYER);

  const tagged: THREE.Mesh[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse((object) => { if (standsSolid(object)) { object.layers.enable(LAYER); tagged.push(object); } });

  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: false });
  const kept = {
    background: scene.background, override: scene.overrideMaterial, fog: scene.fog,
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), target: renderer.getRenderTarget(),
  };
  const pixels = new Uint8Array(width * height * 4);
  try {
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = white;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    scene.overrideMaterial = kept.override;
    scene.background = kept.background;
    scene.fog = kept.fog;
    renderer.setClearColor(kept.clear, kept.alpha);
    renderer.setRenderTarget(kept.target);
    tagged.forEach((mesh) => mesh.layers.disable(LAYER));
    target.dispose();
    white.dispose();
  }

  // Grow by the body's radius: a row pass then a column pass gives a square, close enough to a disc here.
  const reach = Math.max(1, Math.round(body / CELL));
  const raw = new Uint8Array(width * height), rows = new Uint8Array(width * height), grown = new Uint8Array(width * height);
  for (let i = 0; i < raw.length; i += 1) raw[i] = pixels[i * 4 + 3] > 127 ? 1 : 0;
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    for (let x = -reach; x < width; x += 1) {
      const ahead = x + reach;
      if (ahead < width && raw[y * width + ahead]) run = reach * 2 + 1;
      if (x >= 0 && run > 0) rows[y * width + x] = 1;
      if (run > 0) run -= 1;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let run = 0;
    for (let y = -reach; y < height; y += 1) {
      const ahead = y + reach;
      if (ahead < height && rows[ahead * width + x]) run = reach * 2 + 1;
      if (y >= 0 && run > 0) grown[y * width + x] = 1;
      if (run > 0) run -= 1;
    }
  }

  // Read-back rows run bottom-up, and the bottom of the view is the near end of the range (z = Z1).
  const cell = (x: number, z: number) => {
    const ix = Math.floor((x - X0) / CELL), iy = Math.floor((Z1 - z) / CELL);
    return ix < 0 || iy < 0 || ix >= width || iy >= height ? -1 : iy * width + ix;
  };

  const from = cell(start[0], start[1]);
  if (from < 0 || grown[from]) return null;
  const reached = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  queue[tail++] = from;
  reached[from] = 1;
  while (head < tail) {
    const at = queue[head++], x = at % width, y = (at - x) / width;
    if (x > 0 && !grown[at - 1] && !reached[at - 1]) { reached[at - 1] = 1; queue[tail++] = at - 1; }
    if (x < width - 1 && !grown[at + 1] && !reached[at + 1]) { reached[at + 1] = 1; queue[tail++] = at + 1; }
    if (y > 0 && !grown[at - width] && !reached[at - width]) { reached[at - width] = 1; queue[tail++] = at - width; }
    if (y < height - 1 && !grown[at + width] && !reached[at + width]) { reached[at + width] = 1; queue[tail++] = at + width; }
  }
  const near = Math.round(0.9 / CELL);
  for (const [x, z] of mustReach) {
    const at = cell(x, z);
    if (at < 0) return null;
    const cx = at % width, cy = (at - cx) / width;
    let found = false;
    for (let dy = -near; dy <= near && !found; dy += 1) {
      for (let dx = -near; dx <= near && !found; dx += 1) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && reached[ny * width + nx]) found = true;
      }
    }
    if (!found) return null;
  }

  return {
    blocked: (x, z) => { const at = cell(x, z); return at >= 0 && grown[at] === 1; },
  };
}

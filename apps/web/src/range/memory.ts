import * as THREE from "three";

// Keeping the range's memory down without touching what is drawn. Everything here leaves the picture
// exactly as it was: it only stops the page and the graphics card holding things nothing will read again.

/**
 * Gives every shadow-casting sun or spot light its shadow map before the renderer makes one. The renderer's
 * own comes with a full-colour picture beside the depth (64 MB at 4096 x 4096) that soft shadows never
 * read: they sample the depth alone. This makes the same depth, and a colour half of one byte a pixel.
 * Call it once the lights are set up, just before the first frame, which is when the renderer would.
 */
export function leanShadowMaps(renderer: THREE.WebGLRenderer, ...scenes: THREE.Object3D[]) {
  const soft = renderer.shadowMap.type === THREE.PCFShadowMap;
  if (!soft && renderer.shadowMap.type !== THREE.BasicShadowMap) return;
  const limit = renderer.capabilities.maxTextureSize;
  for (const scene of scenes) scene.traverse((object) => {
    if (!(object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight)) return;
    const light = object;
    if (!light.castShadow || light.shadow.map) return;
    const shadow = light.shadow, width = Math.min(shadow.mapSize.x, limit), height = Math.min(shadow.mapSize.y, limit);
    const map = new THREE.WebGLRenderTarget(width, height, { format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    map.texture.name = `${light.name}.shadowMapColour`;
    const depth = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    depth.name = `${light.name}.shadowMap`;
    depth.format = THREE.DepthFormat;
    depth.compareFunction = soft ? THREE.LessEqualCompare : null;
    depth.minFilter = depth.magFilter = soft ? THREE.LinearFilter : THREE.NearestFilter;
    map.depthTexture = depth;
    shadow.map = map;
    shadow.camera.updateProjectionMatrix();
  });
}

// What a picture is made from: an image, a canvas, a decoded bitmap, or an array with its size.
type Held = THREE.Texture["source"];
type Copy = { data?: unknown; width: number; height: number; complete?: boolean } | null;

const once = new WeakSet<Held>();

/** Marks a picture made from an array that is filled once and never written again, so its array may be let go. */
export function drawnOnce<T extends THREE.Texture>(texture: T): T {
  once.add(texture.source);
  return texture;
}

/**
 * Lets go of the page's own copy of each picture the graphics card now holds and nothing will send again:
 * the arrays behind generated surfaces (see drawnOnce) and the decoded pictures of loaded models. Pictures
 * that share one copy go together or not at all, and one not yet sent is sent first, so nothing is left
 * waiting on a copy that has gone. Decoded image files and canvases are left alone: the browser already
 * drops the first by itself, and the second are still drawn on. Returns the bytes let go.
 */
export function releasePictures(renderer: THREE.WebGLRenderer, ...roots: THREE.Object3D[]) {
  const sharing = new Map<Held, Set<THREE.Texture>>();
  const bitmap = (data: unknown): data is ImageBitmap => typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap;
  const see = (value: unknown) => {
    const texture = value as THREE.Texture | null | undefined;
    if (!texture?.isTexture || texture.isRenderTargetTexture) return;
    const source = texture.source, data = source.data as Copy;
    if (!data || data.complete === false || !(bitmap(data) || (once.has(source) && ArrayBuffer.isView(data.data)))) return;
    const set = sharing.get(source);
    if (set) set.add(texture); else sharing.set(source, new Set([texture]));
  };
  for (const root of roots) root.traverse((object) => {
    for (const material of [(object as THREE.Mesh).material ?? []].flat()) {
      for (const value of Object.values(material)) see(value);
      const uniforms = (material as THREE.ShaderMaterial).uniforms;
      if (uniforms) for (const uniform of Object.values(uniforms)) see(uniform?.value);
    }
  });
  // A picture is with the card once the card's copy is the picture's latest; one never marked for sending never goes.
  const sent = (texture: THREE.Texture) => {
    const held = renderer.properties.get(texture) as { __webglTexture?: unknown; __version?: number };
    return texture.version === 0 || (held.__webglTexture !== undefined && held.__version === texture.version);
  };
  let bytes = 0;
  for (const [source, textures] of sharing) {
    for (const texture of textures) if (!sent(texture)) renderer.initTexture(texture);
    if (![...textures].every(sent)) continue;
    const data = source.data as NonNullable<Copy>;
    // What stands in keeps the size for anyone who asks, and reads as "not ready" to the renderer: were a
    // picture ever marked for sending again, it would keep the card's copy rather than send nothing.
    if (bitmap(data)) {
      bytes += data.width * data.height * 4;
      source.data = { width: data.width, height: data.height, complete: false };
      data.close();
    } else {
      bytes += (data.data as ArrayBufferView).byteLength;
      source.data = { ...data, data: null, complete: false };
      // Smaller copies drawn by hand (a leaf atlas keeps its own) are sent with the picture and go with it.
      for (const texture of textures) {
        const levels = texture.mipmaps as unknown as Array<{ data?: ArrayBufferView | null }> | undefined;
        if (!levels?.length || !levels.every((level) => ArrayBuffer.isView(level.data))) continue;
        for (const level of levels) bytes += level.data!.byteLength;
        texture.mipmaps = levels.map((level) => ({ ...level, data: null })) as unknown as THREE.Texture["mipmaps"];
      }
    }
  }
  return bytes;
}

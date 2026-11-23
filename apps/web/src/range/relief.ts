import * as THREE from "three";

/**
 * Relief: surfaces drawn with real depth. A material whose normal map has a height field on record
 * is traced through that field for every pixel (parallax occlusion), so mortar sits behind the brick
 * face and a cobble hides the joint beyond it, instead of both being shaded onto a flat sheet.
 *
 * The field is found by the normal map's image, so nothing about a material or a map changes: a
 * set from the wall bakery carries its height in the alpha of its roughness map, and a photographed
 * set gets one worked out from its normals as it loads.
 */
type Relief = { height: THREE.Texture; channel: "r" | "a"; depth: number };

const reliefs = new WeakMap<object, Relief>();

/** Puts a height field (0 deepest, 1 the surface) on record for a normal map. `depth` is in metres. */
export function registerRelief(normalMap: THREE.Texture, height: THREE.Texture, channel: "r" | "a", depth: number) {
  reliefs.set(normalMap.source, { height, channel, depth });
}

const TRACE = /* glsl */`
uniform float reliefDepth;
#ifdef RELIEF_OWN
  uniform sampler2D reliefMap;
  #define RELIEF_TEX reliefMap
#else
  #define RELIEF_TEX roughnessMap
#endif
vec2 reliefBase = vec2( 0.0 );
vec2 reliefShift = vec2( 0.0 );
// How far the texture slides under this pixel: the eye's ray is walked down into the height field
// until it goes under, and the last two steps are joined for the crossing.
vec2 reliefTrace() {
  vec2 uv = vNormalMapUv;
  reliefBase = uv;
  vec3 at = - vViewPosition;
  float fade = 1.0 - smoothstep( RELIEF_FAR * 0.5, RELIEF_FAR, length( at ) );
  if ( fade <= 0.0 ) return vec2( 0.0 );
  vec3 px = dFdx( at ), py = dFdy( at );
  vec2 ux = dFdx( uv ), uy = dFdy( uv );
  float det = ux.x * uy.y - uy.x * ux.y;
  if ( abs( det ) < 1e-14 ) return vec2( 0.0 );
  // Metres along the surface for one unit of each texture axis.
  vec3 T = ( px * uy.y - py * ux.y ) / det, B = ( py * ux.x - px * uy.x ) / det;
  vec3 N = normalize( cross( px, py ) ), V = normalize( vViewPosition );
  float nv = dot( N, V );
  if ( nv < 0.0 ) { N = - N; nv = - nv; }
  vec3 slide = ( N * nv - V ) / max( nv, 0.28 );
  float tt = dot( T, T ), bb = dot( B, B ), tb = dot( T, B ), gram = tt * bb - tb * tb;
  if ( gram < 1e-20 ) return vec2( 0.0 );
  vec2 span = vec2( dot( slide, T ) * bb - dot( slide, B ) * tb, dot( slide, B ) * tt - dot( slide, T ) * tb ) / gram * reliefDepth * fade;
  float layer = 1.0 / mix( float( RELIEF_STEPS ), float( RELIEF_STEPS ) * 0.34, nv );
  float ray = 0.0, last = 0.0, top = 1.0 - textureGrad( RELIEF_TEX, uv, ux, uy ).RELIEF_CH, before = top;
  for ( int i = 0; i < RELIEF_STEPS; i ++ ) {
    if ( ray >= top ) break;
    last = ray; before = top;
    ray += layer;
    top = 1.0 - textureGrad( RELIEF_TEX, uv + span * ray, ux, uy ).RELIEF_CH;
  }
  float a = before - last, b = top - ray;
  return span * ( a - b > 1e-5 ? mix( last, ray, clamp( a / ( a - b ), 0.0, 1.0 ) ) : ray );
}
`;

const hooked = new WeakMap<THREE.Material, unknown>();

/**
 * Gives a material relief if its normal map has a height field on record. Whatever the material
 * already does to its program is kept and runs first. Returns whether it applied.
 */
export function reliefMaterial(material: THREE.Material, options: { steps: number; far: number }): boolean {
  const m = material as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || !m.normalMap || m.normalMapType !== THREE.TangentSpaceNormalMap) return false;
  const relief = reliefs.get(m.normalMap.source);
  if (!relief || hooked.get(m) === m.onBeforeCompile) return false;
  const normal = m.normalMap;
  const follows = (t: THREE.Texture | null) => !!t && t.channel === normal.channel && t.repeat.equals(normal.repeat) && t.offset.equals(normal.offset) && t.rotation === normal.rotation;
  const own = relief.height !== m.roughnessMap || !follows(m.roughnessMap);
  const slots = ([["USE_MAP", "vMapUv", m.map], ["USE_ROUGHNESSMAP", "vRoughnessMapUv", m.roughnessMap], ["USE_METALNESSMAP", "vMetalnessMapUv", m.metalnessMap], ["USE_AOMAP", "vAoMapUv", m.aoMap]] as const)
    .filter(([, , texture]) => follows(texture));
  const defines = [
    `#define RELIEF_STEPS ${options.steps}`, `#define RELIEF_FAR ${options.far.toFixed(1)}`, `#define RELIEF_CH ${relief.channel}`, ...(own ? ["#define RELIEF_OWN"] : []),
  ].join("\n");
  const slide = ["#define vNormalMapUv ( vNormalMapUv + reliefShift )", ...slots.map(([flag, name]) => `#ifdef ${flag}\n#define ${name} ( ${name} + reliefShift )\n#endif`)].join("\n");
  const before = Object.prototype.hasOwnProperty.call(m, "onBeforeCompile") ? m.onBeforeCompile : null;
  const key = Object.prototype.hasOwnProperty.call(m, "customProgramCacheKey") ? m.customProgramCacheKey : null;
  const signature = `|relief:${options.steps}:${options.far}:${relief.channel}:${own ? 1 : 0}:${slots.map(([flag]) => flag).join(",")}`;
  const uniforms = { reliefDepth: { value: relief.depth }, reliefMap: { value: relief.height } };
  m.onBeforeCompile = (shader, renderer) => {
    before?.call(m, shader, renderer);
    if (!shader.fragmentShader.includes("void main() {") || shader.fragmentShader.includes("reliefTrace")) return;
    shader.uniforms.reliefDepth = uniforms.reliefDepth;
    if (own) shader.uniforms.reliefMap = uniforms.reliefMap;
    shader.fragmentShader = shader.fragmentShader
      // The tangent frame is taken from the texture as it lies, not as it slides.
      .replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("vNormalMapUv", "reliefBase"))
      .replace("void main() {", `${defines}\n${TRACE}\n${slide}\nvoid main() {\n\treliefShift = reliefTrace();`);
  };
  m.customProgramCacheKey = () => (key ? key.call(m) : before ? before.toString() : "") + signature;
  hooked.set(m, m.onBeforeCompile);
  m.needsUpdate = true;
  return true;
}

/** Looks through a scene for materials that can take relief; call it again as things are added. */
export function createReliefWatch(scene: THREE.Object3D, options: { steps: number; far: number }) {
  const seen = new WeakSet<THREE.Material>();
  return () => {
    scene.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      for (const one of Array.isArray(material) ? material : [material]) {
        if (seen.has(one)) continue;
        // A photographed set's height arrives after its picture, so a normal-mapped material without
        // one yet is looked at again next time.
        if (reliefMaterial(one, options) || !(one as THREE.MeshStandardMaterial).normalMap) seen.add(one);
      }
    });
  };
}

// ---- Height from a normal map ---------------------------------------------------------------------

/** In-place radix-2 transform of `n` values spaced `step` apart from `start`. */
function fft(re: Float32Array, im: Float32Array, start: number, step: number, n: number, cos: Float32Array, sin: Float32Array, inverse: boolean) {
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = start + i * step, b = start + j * step, r = re[a], q = im[a];
      re[a] = re[b]; im[a] = im[b]; re[b] = r; im[b] = q;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, stride = cos.length * 2 / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k += 1) {
        const c = cos[k * stride], s = inverse ? sin[k * stride] : -sin[k * stride];
        const a = start + (i + k) * step, b = a + half * step;
        const r = re[b] * c - im[b] * s, q = re[b] * s + im[b] * c;
        re[b] = re[a] - r; im[b] = im[a] - q; re[a] += r; im[a] += q;
      }
    }
  }
}

function fft2(re: Float32Array, im: Float32Array, n: number, inverse: boolean) {
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k += 1) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
  for (let y = 0; y < n; y += 1) fft(re, im, y * n, 1, n, cos, sin, inverse);
  for (let x = 0; x < n; x += 1) fft(re, im, x, n, n, cos, sin, inverse);
}

/**
 * The height field a tangent-space normal map (OpenGL convention) describes, as `size`² bytes with
 * the first row at v = 0. The slopes are integrated in the frequency domain, which suits a map that
 * tiles; swells longer than a third of the tile are left out, since on a wall they are only the
 * photograph's drift and would use up the range.
 */
export function heightFromNormal(image: CanvasImageSource, size = 512): Uint8Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data, count = size * size;
  const re = new Float32Array(count), im = new Float32Array(count);
  let meanP = 0, meanQ = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const from = (y * size + x) * 4, to = (size - 1 - y) * size + x, nz = Math.max(0.1, pixels[from + 2] / 127.5 - 1);
    const p = Math.max(-4, Math.min(4, -(pixels[from] / 127.5 - 1) / nz)), q = Math.max(-4, Math.min(4, -(pixels[from + 1] / 127.5 - 1) / nz));
    re[to] = p; im[to] = q; meanP += p; meanQ += q;
  }
  meanP /= count; meanQ /= count;
  for (let i = 0; i < count; i += 1) { re[i] -= meanP; im[i] -= meanQ; }
  fft2(re, im, size, false);
  const hr = new Float32Array(count), hi = new Float32Array(count), cut = Math.pow(2 * Math.PI * 3 / size, 2);
  for (let ky = 0; ky < size; ky += 1) for (let kx = 0; kx < size; kx += 1) {
    const i = ky * size + kx, j = ((size - ky) % size) * size + ((size - kx) % size);
    const wx = 2 * Math.PI * (kx <= size / 2 ? kx : kx - size) / size, wy = 2 * Math.PI * (ky <= size / 2 ? ky : ky - size) / size, w = wx * wx + wy * wy;
    if (w === 0) continue;
    const pr = (re[i] + re[j]) / 2, pi = (im[i] - im[j]) / 2, qr = (im[i] + im[j]) / 2, qi = -(re[i] - re[j]) / 2, gain = 1 / (w + cut);
    hr[i] = (wx * pi + wy * qi) * gain; hi[i] = -(wx * pr + wy * qr) * gain;
  }
  fft2(hr, hi, size, true);
  // Stretch between the 1st and 99th hundredths, so a stray pit does not flatten everything else.
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < count; i += 1) { if (hr[i] < low) low = hr[i]; if (hr[i] > high) high = hr[i]; }
  const bins = new Uint32Array(1024), scale = 1023 / Math.max(1e-9, high - low);
  for (let i = 0; i < count; i += 1) bins[Math.floor((hr[i] - low) * scale)] += 1;
  let from = 0, to = 1023;
  for (let sum = 0; from < 1023 && (sum += bins[from]) < count * 0.01; from += 1);
  for (let sum = 0; to > 0 && (sum += bins[to]) < count * 0.01; to -= 1);
  const floor = low + from / scale, range = Math.max(1e-9, low + to / scale - floor), out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = Math.max(0, Math.min(255, Math.round((hr[i] - floor) / range * 255)));
  return out;
}

const waiting: Array<() => void> = [];
let working = false;
function next() {
  const job = waiting.shift();
  if (!job) { working = false; return; }
  working = true;
  setTimeout(() => { job(); next(); }, 0);
}

/**
 * Works a height field out of a loaded normal map and puts it on record. One at a time and off the
 * loading path, so a range does not open any later for it.
 */
export function reliefFromNormal(normalMap: THREE.Texture, depth: number, track: (texture: THREE.Texture) => void) {
  waiting.push(() => {
    const image = normalMap.image as (CanvasImageSource & { width: number }) | null;
    if (!image || !image.width) return;
    const size = 512, data = heightFromNormal(image, size);
    if (!data) return;
    const height = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
    height.wrapS = height.wrapT = THREE.RepeatWrapping;
    height.magFilter = THREE.LinearFilter;
    height.minFilter = THREE.LinearMipmapLinearFilter;
    height.generateMipmaps = true;
    height.needsUpdate = true;
    track(height);
    registerRelief(normalMap, height, "r", depth);
  });
  if (!working) next();
}

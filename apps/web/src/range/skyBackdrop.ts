import * as THREE from "three";

// The 2K HDR skies light the maps well but read soft as a backdrop: at a 76° field of view a
// 2048-pixel panorama gives about a third of a screen pixel per texel on a retina panel. On HIGH
// the visible sky is therefore an 8K tonemapped JPG of the same panorama, drawn on a camera-centred
// dome, while the HDR keeps its other jobs (floor reflections and the light probe).
//
// A tonemapped JPG is display-referred, the scene is not. `curve` is the measured inverse: for 33
// evenly spaced sRGB values, the median radiance of the HDR pixels that the JPG shows at that
// value. Mapping through it puts the dome within a few percent of the HDR background it replaces,
// so exposure, bloom and the wave-mode dimming behave as they did.

type Backdrop = { url: string; curve: number[] };

const BACKDROPS: Record<string, Backdrop> = {
  "/environment/goegap-2k.hdr": {
    url: "/environment/goegap-8k.jpg",
    curve: [0, 0.003723, 0.006348, 0.009644, 0.01379, 0.01855, 0.02344, 0.03223, 0.04297, 0.05273, 0.06836, 0.09082, 0.1133, 0.1348, 0.1465, 0.1592, 0.207, 0.2441, 0.2812, 0.3145, 0.3496, 0.3945, 0.4453, 0.498, 0.5352, 0.5898, 0.6992, 0.8867, 1.148, 1.578, 2.625, 6.094, 27.94],
  },
  "/environment/tears_of_steel_bridge-2k.hdr": {
    url: "/environment/tears_of_steel_bridge-8k.jpg",
    curve: [0, 0.0005608, 0.001305, 0.002213, 0.003403, 0.004944, 0.006714, 0.008423, 0.01038, 0.01288, 0.01575, 0.01831, 0.02173, 0.0249, 0.0293, 0.03418, 0.03809, 0.04443, 0.05029, 0.05762, 0.06738, 0.0791, 0.09229, 0.1094, 0.1289, 0.1289, 0.1318, 0.1602, 0.2021, 0.2461, 0.3047, 0.4863, 0.7461],
  },
  "/environment/rooftop_night-2k.hdr": {
    url: "/environment/rooftop_night-8k.jpg",
    curve: [0, 0.008301, 0.01086, 0.01489, 0.02002, 0.02795, 0.03711, 0.04834, 0.05713, 0.06836, 0.0835, 0.09863, 0.1152, 0.1406, 0.1621, 0.1836, 0.209, 0.2383, 0.2617, 0.2969, 0.3359, 0.377, 0.4355, 0.6289, 0.7734, 0.9453, 1.102, 1.352, 1.695, 2.406, 3.672, 6.656, 9.562],
  },
};

const VERTEX = /* glsl */ `
  uniform mat3 turn;
  varying vec3 vDirection;
  void main() {
    vDirection = turn * position;
    // Camera-centred and pinned to the far plane: the dome only fills pixels nothing else covered.
    vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position = clip.xyww;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D curve;
  uniform float intensity;
  uniform float cap;
  varying vec3 vDirection;
  float radiance(float linear) {
    float encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
    return texture2D(curve, vec2(encoded * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).r;
  }
  void main() {
    vec3 d = normalize(vDirection);
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494309189535 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5);
    // The longitude wraps once around the dome; take derivatives from whichever unwrapping is
    // continuous here so the seam does not drop to the coarsest mip.
    vec2 shifted = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
    vec2 dxA = dFdx(uv), dyA = dFdy(uv), dxB = dFdx(shifted), dyB = dFdy(shifted);
    bool plain = abs(dxA.x) + abs(dyA.x) <= abs(dxB.x) + abs(dyB.x);
    vec3 shown = textureGrad(map, uv, plain ? dxA : dxB, plain ? dyA : dyB).rgb;
    vec3 sky = vec3(radiance(shown.r), radiance(shown.g), radiance(shown.b));
    gl_FragColor = vec4(min(sky, vec3(cap)) * intensity, 1.0);
  }
`;

export type SkyBackdrop = {
  mesh: THREE.Mesh;
  /** True once the 8K image is on the GPU; until then the HDR background stays in view. */
  ready: () => boolean;
  setIntensity: (value: number) => void;
  dispose: () => void;
};

/** The sharp backdrop for `sky`, or null where there is none or the device should not hold an 8K texture. */
export function createSkyBackdrop(
  renderer: THREE.WebGLRenderer, loadingManager: THREE.LoadingManager,
  sky: string, rotation: number, clamp: number | undefined,
): SkyBackdrop | null {
  const source = BACKDROPS[sky];
  if (!source || renderer.capabilities.maxTextureSize < 8192) return null;
  // About 180 MB of texture memory with mips: fine on a desktop GPU, not on a phone.
  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) return null;

  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const at = (i / 255) * (source.curve.length - 1), low = Math.floor(at), high = Math.min(source.curve.length - 1, low + 1);
    table[i] = THREE.DataUtils.toHalfFloat(THREE.MathUtils.lerp(source.curve[low], source.curve[high], at - low));
  }
  const curve = new THREE.DataTexture(table, 256, 1, THREE.RedFormat, THREE.HalfFloatType);
  curve.minFilter = curve.magFilter = THREE.LinearFilter;
  curve.needsUpdate = true;

  let loaded = false;
  const map = new THREE.TextureLoader(loadingManager).load(source.url, () => { loaded = true; });
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      curve: { value: curve },
      intensity: { value: 1 },
      cap: { value: clamp ?? 1e6 },
      // The renderer turns the lookup direction by the inverse of the background's rotation.
      turn: { value: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(-rotation)) },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
  mesh.frustumCulled = false;
  // Last of the opaque pass, so the depth test rejects every pixel the map already drew.
  mesh.renderOrder = 10_000;
  mesh.visible = false;

  return {
    mesh,
    ready: () => loaded,
    setIntensity: (value) => { material.uniforms.intensity.value = value; },
    dispose: () => { map.dispose(); curve.dispose(); material.dispose(); mesh.geometry.dispose(); },
  };
}

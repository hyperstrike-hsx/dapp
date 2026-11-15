import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";

// Volumetric lighting.
//
// The sun only reaches the range through three roof lights, so the air itself
// should show it. This pass ray-marches the view ray through a thin haze and,
// at every step, asks the sun's own shadow map whether that point is lit. The
// result is true light shafts that are occluded by trusses, ducts and props.
// Local emitters (furnace, lamps) add an analytic in-scatter glow that needs no
// marching. Marching runs at half resolution with an ordered dither that the
// depth-aware upsample removes.

const MAX_GLOWS = 4;

const MARCH_SHADER = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */`
    #define STEPS 18
    #define MAX_GLOWS ${MAX_GLOWS}
    uniform sampler2D tDepth;
    uniform sampler2DShadow tShadow;
    uniform mat4 shadowMatrix;
    uniform mat4 projectionInverse;
    uniform mat4 cameraWorld;
    uniform vec3 eye;
    uniform vec3 sunDirection;
    uniform vec3 sunColor;
    uniform vec3 hazeColor;
    uniform float density;
    uniform float time;
    uniform vec3 glowPosition[MAX_GLOWS];
    uniform vec3 glowColor[MAX_GLOWS];
    varying vec2 vUv;

    float bayer(vec2 p) {
      ivec2 c = ivec2(mod(p, 4.0));
      int index = c.x + c.y * 4;
      float pattern[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
      return (pattern[index] + 0.5) / 16.0;
    }
    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float noise(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
    }

    void main() {
      float depth = texture2D(tDepth, vUv).x;
      vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      view /= view.w;
      vec3 world = (cameraWorld * view).xyz;
      vec3 ray = world - eye;
      float reach = min(length(ray), 46.0);
      vec3 direction = normalize(ray);

      // Forward-scattering phase function: shafts brighten when looking toward the sun.
      float cosine = dot(direction, -sunDirection);
      float g = 0.52;
      float phase = (1.0 - g * g) / (4.0 * 3.14159 * pow(1.0 + g * g - 2.0 * g * cosine, 1.5));

      float stride = reach / float(STEPS);
      float jitter = bayer(gl_FragCoord.xy);
      vec3 scatter = vec3(0.0);
      float transmittance = 1.0;
      vec3 drift = vec3(time * 0.035, time * -0.012, time * 0.02);
      for (int i = 0; i < STEPS; i++) {
        vec3 p = eye + direction * (float(i) + jitter) * stride;
        vec4 coordinate = shadowMatrix * vec4(p, 1.0);
        coordinate.xyz /= coordinate.w;
        float lit = 0.0;
        if (coordinate.x > 0.0 && coordinate.x < 1.0 && coordinate.y > 0.0 && coordinate.y < 1.0 && coordinate.z < 1.0) {
          lit = texture(tShadow, vec3(coordinate.xy, coordinate.z - 0.0006));
        }
        float swirl = 0.55 + 0.9 * noise(p * 0.55 + drift);
        // The haze belongs to the room: nothing scatters above the roof deck.
        float local = density * swirl * (1.0 + 0.5 * smoothstep(2.4, 0.0, p.y)) * (1.0 - smoothstep(6.05, 6.3, p.y));
        scatter += transmittance * (sunColor * phase * lit + hazeColor) * local * stride;
        transmittance *= exp(-local * stride * 0.85);
      }

      // Closed-form in-scatter from point emitters along the ray.
      for (int i = 0; i < MAX_GLOWS; i++) {
        vec3 q = eye - glowPosition[i];
        float b = dot(direction, q);
        float h = sqrt(max(dot(q, q) - b * b, 0.0025));
        float integral = (atan((reach + b) / h) - atan(b / h)) / h;
        scatter += glowColor[i] * integral * density;
      }
      gl_FragColor = vec4(scatter, transmittance);
    }
  `,
};

const COMPOSITE_SHADER = {
  vertexShader: MARCH_SHADER.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tVolume;
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float near;
    uniform float far;
    varying vec2 vUv;
    float linearDepth(float d) { return near * far / (far - d * (far - near)); }
    void main() {
      float centre = linearDepth(texture2D(tDepth, vUv).x);
      vec4 sum = vec4(0.0);
      float total = 0.0;
      // 4 bilinear taps cover the 4x4 dither tile; depth weights stop haze bleeding over foreground edges.
      for (int i = 0; i < 4; i++) {
        vec2 offset = vec2(i == 0 || i == 2 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * texel;
        float tap = linearDepth(texture2D(tDepth, vUv + offset).x);
        float weight = 1.0 / (0.02 + abs(tap - centre) / max(centre, 0.1) * 12.0);
        sum += texture2D(tVolume, vUv + offset) * weight;
        total += weight;
      }
      vec4 volume = sum / total;
      vec4 scene = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(scene.rgb * volume.a + volume.rgb, scene.a);
    }
  `,
};

export type Glow = { position: THREE.Vector3; color: THREE.Color };

export class VolumetricPass extends Pass {
  readonly glows: Glow[] = [];
  density = 0.015;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly depth: THREE.Texture;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly march: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private elapsed = 0;

  constructor(camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, depth: THREE.Texture, haze: THREE.Color) {
    super();
    this.camera = camera;
    this.sun = sun;
    this.depth = depth;
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.march = new THREE.ShaderMaterial({
      ...MARCH_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDepth: { value: depth },
        tShadow: { value: null },
        shadowMatrix: { value: new THREE.Matrix4() },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        eye: { value: new THREE.Vector3() },
        sunDirection: { value: new THREE.Vector3(0, -1, 0) },
        sunColor: { value: new THREE.Color() },
        hazeColor: { value: haze },
        density: { value: this.density },
        time: { value: 0 },
        glowPosition: { value: Array.from({ length: MAX_GLOWS }, () => new THREE.Vector3(0, -100, 0)) },
        glowColor: { value: Array.from({ length: MAX_GLOWS }, () => new THREE.Color(0, 0, 0)) },
      },
    });
    this.composite = new THREE.ShaderMaterial({
      ...COMPOSITE_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tVolume: { value: this.target.texture },
        tDepth: { value: depth },
        texel: { value: new THREE.Vector2() },
        near: { value: camera.near },
        far: { value: camera.far },
      },
    });
  }

  setSize(width: number, height: number) {
    const w = Math.max(2, Math.floor(width / 2)), h = Math.max(2, Math.floor(height / 2));
    this.target.setSize(w, h);
    this.composite.uniforms.texel.value.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number) {
    const shadow = this.sun.shadow.map?.depthTexture ?? null;
    const u = this.march.uniforms;
    this.elapsed += deltaTime;
    u.tShadow.value = shadow;
    u.shadowMatrix.value.copy(this.sun.shadow.matrix);
    u.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(this.camera.matrixWorld);
    u.eye.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.sunDirection.value.copy(this.sun.target.position).sub(this.sun.position).normalize();
    u.sunColor.value.copy(this.sun.color).multiplyScalar(shadow ? this.sun.intensity : 0);
    u.density.value = this.density;
    u.time.value = this.elapsed;
    for (let i = 0; i < MAX_GLOWS; i += 1) {
      const glow = this.glows[i];
      if (glow) { u.glowPosition.value[i].copy(glow.position); u.glowColor.value[i].copy(glow.color); }
      else u.glowColor.value[i].setScalar(0);
    }
    this.quad.material = this.march;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);

    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.composite;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.march.dispose();
    this.composite.dispose();
    this.quad.dispose();
  }
}

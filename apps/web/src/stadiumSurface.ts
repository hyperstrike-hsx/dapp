import * as THREE from "three";
import type { FloorReflection } from "./range/floor";

// Night-match surfaces for the penalty stadium: rain-soaked turf that mirrors
// the LED boards, the perimeter boards themselves, and wind-blown rain.

const TURF_KEY = "hyperstrike-turf-v1";

/** Mowing bands, goal-mouth wear, standing damp and a planar reflection for a standard turf material. */
export function applyWetTurf(material: THREE.MeshStandardMaterial, reflection: FloorReflection) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.tReflection = reflection.uniforms.tReflection;
    shader.uniforms.reflectionMatrix = reflection.uniforms.reflectionMatrix;
    shader.uniforms.reflectionStrength = reflection.uniforms.reflectionStrength;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTurfWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvTurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */`#include <common>
        varying vec3 vTurfWorld;
        uniform sampler2D tReflection;
        uniform mat4 reflectionMatrix;
        uniform float reflectionStrength;
        float turfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float turfNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(turfHash(i), turfHash(i + vec2(1.0, 0.0)), f.x), mix(turfHash(i + vec2(0.0, 1.0)), turfHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float turfFbm(vec2 p) {
          float sum = 0.0, amplitude = 0.5;
          for (int i = 0; i < 4; i++) { sum += turfNoise(p) * amplitude; p = p * 2.03 + 17.3; amplitude *= 0.5; }
          return sum / 0.9375;
        }
        float turfWet = 0.0;
      `)
      .replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
        {
          vec2 p = vTurfWorld.xz;
          // Mown bands: blades lean alternately toward and away from the camera.
          float along = fract(p.y / 5.2 + 0.2);
          float band = smoothstep(0.0, 0.012, along) - smoothstep(0.5, 0.512, along);
                    float patchy = turfFbm(p * 0.9);
          diffuseColor.rgb *= mix(0.84, 1.03, band) * (0.86 + patchy * 0.28);
          // Scuffed, muddier grass where keepers and takers stand.
          float mouth = exp(-(p.x * p.x * 0.11 + (p.y + 8.2) * (p.y + 8.2) * 0.8));
          float spot = exp(-(p.x * p.x + (p.y - 1.75) * (p.y - 1.75)) * 1.6);
          float worn = clamp(max(mouth, spot) * (0.45 + turfFbm(p * 3.1) * 0.9), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.17, 0.1) * (0.6 + patchy), worn * 0.5);
          // Rain collects in broad shallow sheets rather than puddles.
          turfWet = smoothstep(0.42, 0.7, turfFbm(p * 0.22 + 5.3) + worn * 0.25);
          diffuseColor.rgb *= mix(1.0, 0.86, turfWet);
          roughnessFactor = mix(roughnessFactor * mix(0.95, 0.86, band), 0.34, turfWet * 0.5);
          normal = normalize(mix(normal, nonPerturbedNormal, turfWet * 0.55));
        }
      `)
      .replace("#include <opaque_fragment>", /* glsl */`
        {
          vec3 toEye = normalize(cameraPosition - vTurfWorld);
          float fresnel = 0.04 + 0.96 * pow(1.0 - clamp(toEye.y, 0.0, 1.0), 5.0);
          vec4 projected = reflectionMatrix * vec4(vTurfWorld, 1.0);
          vec2 ripple = (normal.xy - nonPerturbedNormal.xy) * mix(0.16, 0.05, turfWet);
          float gloss = 1.0 - roughnessFactor;
          // Blades break the mirror up: never sharper than a few mips down.
          float lod = 2.2 + roughnessFactor * 5.0;
          vec2 jitter = vec2(turfHash(gl_FragCoord.xy), turfHash(gl_FragCoord.yx + 19.7)) - 0.5;
          vec2 mirrorUv = projected.xy / projected.w + ripple + jitter * exp2(lod) * 1.4 / vec2(textureSize(tReflection, 0));
          vec3 mirrored = min(textureLod(tReflection, mirrorUv, lod).rgb, vec3(16.0));
          float amount = fresnel * gloss * gloss * mix(0.4, 1.0, turfWet);
          outgoingLight = outgoingLight * (1.0 - amount * 0.3) + mirrored * amount * reflectionStrength;
        }
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => TURF_KEY;
  material.needsUpdate = true;
}

/** Scrolling LED perimeter-board artwork with a visible diode pitch. */
export function ledBoardTexture(anisotropy: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 4096;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#01060a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const panels: Array<[string, string, string]> = [
    ["HYPERSTRIKE", "#8ef5e3", "#052a2a"],
    ["TRADE THE MOMENT", "#f2c077", "#2c1705"],
    ["HSX / STRIKE", "#f3fffd", "#0b2030"],
    ["YES  ·  NO  ·  YOUR CALL", "#f06d63", "#2a0907"],
  ];
  const width = canvas.width / panels.length;
  panels.forEach(([label, ink, wash], index) => {
    const x = index * width;
    const gradient = ctx.createLinearGradient(x, 0, x + width, 0);
    gradient.addColorStop(0, "#01060a");
    gradient.addColorStop(0.5, wash);
    gradient.addColorStop(1, "#01060a");
    ctx.fillStyle = gradient;
    ctx.fillRect(x, 0, width, canvas.height);
    ctx.fillStyle = ink;
    ctx.fillRect(x + 28, 18, 10, canvas.height - 36);
    ctx.fillRect(x + width - 38, 18, 10, canvas.height - 36);
    ctx.font = "italic 900 78px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + width / 2, canvas.height / 2 + 4, width - 130);
  });
  // Diode pitch: dark seams every fourth pixel survive as a fine texture up close.
  ctx.fillStyle = "rgba(0,0,0,.34)";
  for (let x = 0; x < canvas.width; x += 4) ctx.fillRect(x, 0, 1, canvas.height);
  for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Soft radial glare for lamp faces. */
export function glareTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.08, "rgba(255,255,255,.55)");
  gradient.addColorStop(0.3, "rgba(255,255,255,.12)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  // Horizontal anamorphic streak.
  const streak = ctx.createLinearGradient(0, 0, 256, 0);
  streak.addColorStop(0, "rgba(255,255,255,0)");
  streak.addColorStop(0.5, "rgba(255,255,255,.5)");
  streak.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = streak;
  ctx.fillRect(0, 125, 256, 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Rain as short wind-slanted streaks that catch the floodlights. */
export function createRain(count: number) {
  const positions = new Float32Array(count * 6);
  const speed = new Float32Array(count);
  const fall = new THREE.Vector3(-0.16, -1, 0.05).normalize();
  const place = (index: number, y: number) => {
    const x = (Math.random() - 0.5) * 30, z = 12 - Math.random() * 40;
    const length = 0.22 + Math.random() * 0.3;
    positions.set([x, y, z, x - fall.x * length, y - fall.y * length, z - fall.z * length], index * 6);
  };
  for (let index = 0; index < count; index += 1) { place(index, Math.random() * 14); speed[index] = 11 + Math.random() * 6; }
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute("position", attribute);
  const material = new THREE.LineBasicMaterial({ color: new THREE.Color(0.75, 0.9, 0.95), transparent: true, opacity: 0.11, depthWrite: false, blending: THREE.AdditiveBlending });
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;
  return {
    object,
    update(dt: number) {
      for (let index = 0; index < count; index += 1) {
        const offset = index * 6, step = speed[index] * dt;
        if (positions[offset + 1] < 0) { place(index, 13 + Math.random() * 2); continue; }
        for (const vertex of [offset, offset + 3]) {
          positions[vertex] += fall.x * step;
          positions[vertex + 1] += fall.y * step;
          positions[vertex + 2] += fall.z * step;
        }
      }
      attribute.needsUpdate = true;
    },
  };
}

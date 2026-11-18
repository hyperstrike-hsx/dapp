import * as THREE from "three";

// Planar floor reflection + a "smart" floor material.
//
// The floor is the largest surface on screen, so it carries most of the
// perceived quality. The scene is rendered a second time from a camera mirrored
// about y = 0 into a mip-mapped HDR target. The floor shader then:
//   - derives standing water from world-space noise (puddles follow the slab,
//     not the texture tiling), flattening the normal and dropping roughness;
//   - samples the mirror image at a mip chosen from roughness, so dry concrete
//     gets a broad sheen and water gets a sharp reflection;
//   - paints worn lane markings procedurally so they inherit wetness too.

const SHADER_KEY = "hyperstrike-floor-v1";

export type FloorReflection = {
  uniforms: {
    tReflection: { value: THREE.Texture | null };
    reflectionMatrix: { value: THREE.Matrix4 };
    reflectionStrength: { value: number };
  };
  render: (scene: THREE.Scene, camera: THREE.PerspectiveCamera, hidden: THREE.Object3D[]) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
};

export function createFloorReflection(renderer: THREE.WebGLRenderer, enabled: boolean): FloorReflection {
  const target = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const mirror = new THREE.PerspectiveCamera();
  const uniforms = {
    tReflection: { value: enabled ? target.texture : null },
    reflectionMatrix: { value: new THREE.Matrix4() },
    reflectionStrength: { value: enabled ? 1 : 0 },
  };
  const up = new THREE.Vector3(), forward = new THREE.Vector3(), lookAt = new THREE.Vector3();
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  return {
    uniforms,
    setSize(width, height) {
      if (enabled) target.setSize(Math.max(2, Math.floor(width)), Math.max(2, Math.floor(height)));
    },
    render(scene, camera, hidden) {
      if (!enabled) return;
      // Mirror the camera about the y = 0 plane. Nothing in the range extends
      // below the slab, so no oblique clipping plane is required.
      camera.getWorldDirection(forward);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      mirror.position.set(camera.position.x, -camera.position.y, camera.position.z);
      lookAt.set(mirror.position.x + forward.x, mirror.position.y - forward.y, mirror.position.z + forward.z);
      mirror.up.set(up.x, -up.y, up.z);
      mirror.lookAt(lookAt);
      mirror.projectionMatrix.copy(camera.projectionMatrix);
      mirror.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      mirror.updateMatrixWorld(true);
      uniforms.reflectionMatrix.value.copy(bias).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);

      const visibility = hidden.map((object) => object.visible);
      hidden.forEach((object) => { object.visible = false; });
      const previous = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(scene, mirror);
      } finally {
        renderer.setRenderTarget(previous);
        hidden.forEach((object, index) => { object.visible = visibility[index]; });
      }
    },
    dispose() { target.dispose(); },
  };
}

export type FloorPaint = {
  lane: THREE.Color;
  edge: THREE.Color;
  /** 0 leaves the ground unpainted (default 1: range lane and hazard edging). */
  markings?: number;
  /** Shifts how much standing water there is: negative dries the ground, positive floods it (default 0). */
  wet?: number;
};

/** Adds puddles, mirror reflection and painted markings to a standard material. */
export function applyWetFloor(material: THREE.MeshStandardMaterial, reflection: FloorReflection, paint: FloorPaint) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.tReflection = reflection.uniforms.tReflection;
    shader.uniforms.reflectionMatrix = reflection.uniforms.reflectionMatrix;
    shader.uniforms.reflectionStrength = reflection.uniforms.reflectionStrength;
    shader.uniforms.lanePaint = { value: paint.lane };
    shader.uniforms.edgePaint = { value: paint.edge };
    shader.uniforms.floorMarkings = { value: paint.markings ?? 1 };
    shader.uniforms.floorWetBias = { value: paint.wet ?? 0 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFloorWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFloorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */`#include <common>
        varying vec3 vFloorWorld;
        uniform sampler2D tReflection;
        uniform mat4 reflectionMatrix;
        uniform float reflectionStrength;
        uniform vec3 lanePaint;
        uniform vec3 edgePaint;
        uniform float floorMarkings;
        uniform float floorWetBias;
        float floorHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float floorNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(floorHash(i), floorHash(i + vec2(1.0, 0.0)), f.x), mix(floorHash(i + vec2(0.0, 1.0)), floorHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float floorFbm(vec2 p) {
          float sum = 0.0, amplitude = 0.5;
          for (int i = 0; i < 4; i++) { sum += floorNoise(p) * amplitude; p = p * 2.03 + 17.3; amplitude *= 0.5; }
          return sum / 0.9375;
        }
        float floorWet = 0.0;
      `)
      .replace("#include <normal_fragment_maps>", /* glsl */`#include <normal_fragment_maps>
        {
          vec2 slab = vFloorWorld.xz;
          float wornTexel = texture2D(roughnessMap, vRoughnessMapUv).g;
          float chips = floorFbm(slab * 9.0);
          // Painted markings: a worn centre lane and hazard edging along both walls.
          float lane = 1.0 - smoothstep(0.19, 0.215, abs(slab.x));
          float edge = (1.0 - smoothstep(0.045, 0.06, abs(abs(slab.x) - 8.62)));
          float hazard = step(0.5, fract((slab.x + slab.y) * 1.6)) * (1.0 - smoothstep(0.19, 0.205, abs(abs(slab.x) - 9.02)));
          float firingLine = (1.0 - smoothstep(0.05, 0.065, abs(slab.y - 4.6))) * step(abs(slab.x), 8.4);
          float coverage = smoothstep(0.30, 0.52, chips + (1.0 - wornTexel) * 0.35);
          float laneMask = lane * coverage * floorMarkings;
          float edgeMask = max(max(edge, hazard), firingLine) * smoothstep(0.24, 0.46, chips + 0.12) * floorMarkings;
          diffuseColor.rgb = mix(diffuseColor.rgb, lanePaint * (0.72 + chips * 0.4), laneMask * 0.94);
          diffuseColor.rgb = mix(diffuseColor.rgb, edgePaint * (0.72 + chips * 0.4), edgeMask * 0.92);
          float painted = max(laneMask, edgeMask);
          roughnessFactor = mix(roughnessFactor, 0.5, painted * 0.8);
          normal = normalize(mix(normal, nonPerturbedNormal, painted * 0.55));
          // Standing water pools in broad low areas; damp halos surround it.
          float basin = floorFbm(slab * 0.26 + 3.1) + (floorNoise(slab * 1.9) - 0.5) * 0.06 + floorWetBias;
          floorWet = smoothstep(0.615, 0.655, basin);
          float damp = smoothstep(0.5, 0.63, basin);
          diffuseColor.rgb *= mix(1.0, 0.56, max(floorWet, damp * 0.7));
          roughnessFactor = mix(roughnessFactor * mix(1.0, 0.62, damp), 0.035, floorWet);
          normal = normalize(mix(normal, nonPerturbedNormal, max(floorWet * 0.985, damp * 0.35)));
        }
      `)
      .replace("#include <opaque_fragment>", /* glsl */`
        {
          vec3 toEye = normalize(cameraPosition - vFloorWorld);
          float facing = clamp(toEye.y, 0.0, 1.0);
          float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
          vec4 projected = reflectionMatrix * vec4(vFloorWorld, 1.0);
          vec2 ripple = (normal.xy - nonPerturbedNormal.xy) * mix(0.09, 0.004, floorWet);
          float gloss = 1.0 - roughnessFactor;
          float lod = roughnessFactor * 7.5;
          // Stochastic footprint: turns blocky mip steps into fine grain that reads as a rough reflection.
          vec2 jitter = vec2(floorHash(gl_FragCoord.xy), floorHash(gl_FragCoord.yx + 19.7)) - 0.5;
          vec2 mirrorUv = projected.xy / projected.w + ripple + jitter * exp2(lod) * 1.6 / vec2(textureSize(tReflection, 0));
          vec3 mirrored = textureLod(tReflection, mirrorUv, lod).rgb;
          // Clamp fireflies from HDR emitters so reflections never out-shine their source.
          mirrored = min(mirrored, vec3(24.0));
          float amount = fresnel * gloss * gloss * mix(0.85, 1.0, floorWet) + floorWet * 0.035;
          outgoingLight = outgoingLight * (1.0 - amount * 0.35) + mirrored * amount * reflectionStrength;
        }
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => SHADER_KEY;
  material.needsUpdate = true;
}

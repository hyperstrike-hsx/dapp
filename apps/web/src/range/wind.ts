import * as THREE from "three";

// One wind for the whole map.
//
// Trees, cloth, hanging lamps, drifting leaves and the gusts you hear all read the same field, so
// a gust visibly crosses the range: the far awning lifts, then the palms, then the dust at your
// feet. The field is a base breeze along one heading with gust fronts travelling down it. The
// same formula runs in GLSL (WIND_GLSL, for vertex shaders) and on the CPU (wind.at, for things
// animated in script), so the two never disagree.

export type WindOptions = {
  /** Where the wind blows towards, as a yaw: 0 is towards -z (down-range), PI / 2 towards -x. */
  heading?: number;
  /** Steady breeze, 0 (dead calm) .. 1 (strong). Around 0.3 reads as a pleasant day. */
  strength?: number;
  /** How much of the wind arrives as gusts, 0 (steady) .. 1 (all lulls and gusts). */
  gustiness?: number;
};

export type Wind = {
  /** Shared uniform objects: put these same objects on a shader (see applyWind). */
  readonly uniforms: {
    windTime: { value: number };
    /** Direction (xz) scaled by the steady strength. */
    windVector: { value: THREE.Vector2 };
    /** x: gustiness. y: unused. */
    windGusts: { value: THREE.Vector2 };
  };
  /** Unit direction the wind blows towards, in xz. */
  readonly direction: THREE.Vector2;
  /** Wind strength at a place right now: 0 calm, about 1 in a strong gust. */
  at: (x: number, z: number) => number;
  set: (options: WindOptions) => void;
  /** Call once per frame with the same `now` (milliseconds) the map's update receives. */
  update: (now: number) => void;
};

/**
 * GLSL for a vertex shader: `float windAt(vec2 worldXZ)` gives the strength at a place, and
 * `windVector` normalised is the direction. Needs the three uniforms of Wind.uniforms.
 */
export const WIND_GLSL = /* glsl */ `
uniform float windTime;
uniform vec2 windVector;
uniform vec2 windGusts;
float windAt(vec2 place) {
  float steady = length(windVector);
  if (steady < 0.0001) return 0.0;
  vec2 heading = windVector / steady;
  float along = dot(place, heading), across = dot(place, vec2(-heading.y, heading.x));
  // Gust fronts a few tens of metres apart, bent so they are not ruler-straight, under slow lulls.
  float front = sin(along * 0.11 - windTime * 0.9 + sin(across * 0.07 + windTime * 0.13) * 1.7) * 0.5 + 0.5;
  float lull = sin(along * 0.031 - windTime * 0.23 + across * 0.02) * 0.5 + 0.5;
  float flutter = sin(along * 0.9 - windTime * 3.1 + across * 0.6) * 0.5 + 0.5;
  return steady * (1.0 - windGusts.x + windGusts.x * (front * lull * 2.2 + flutter * 0.25));
}
`;

export function createWind(options: WindOptions = {}): Wind {
  const direction = new THREE.Vector2(0, -1);
  const uniforms = { windTime: { value: 0 }, windVector: { value: new THREE.Vector2() }, windGusts: { value: new THREE.Vector2(0.5, 0) } };
  let strength = 0.3;
  const set = (next: WindOptions) => {
    if (next.heading !== undefined) direction.set(-Math.sin(next.heading), -Math.cos(next.heading));
    if (next.strength !== undefined) strength = next.strength;
    if (next.gustiness !== undefined) uniforms.windGusts.value.x = THREE.MathUtils.clamp(next.gustiness, 0, 1);
    uniforms.windVector.value.copy(direction).multiplyScalar(strength);
  };
  set({ heading: 0, strength: 0.3, gustiness: 0.5, ...options });
  return {
    uniforms,
    direction,
    at(x, z) {
      if (strength < 0.0001) return 0;
      const time = uniforms.windTime.value, gustiness = uniforms.windGusts.value.x;
      const along = x * direction.x + z * direction.y, across = -x * direction.y + z * direction.x;
      const front = Math.sin(along * 0.11 - time * 0.9 + Math.sin(across * 0.07 + time * 0.13) * 1.7) * 0.5 + 0.5;
      const lull = Math.sin(along * 0.031 - time * 0.23 + across * 0.02) * 0.5 + 0.5;
      const flutter = Math.sin(along * 0.9 - time * 3.1 + across * 0.6) * 0.5 + 0.5;
      return strength * (1 - gustiness + gustiness * (front * lull * 2.2 + flutter * 0.25));
    },
    set,
    update(now) { uniforms.windTime.value = now / 1000; },
  };
}

/** Gives a shader (inside onBeforeCompile) the wind uniforms and `windAt`. */
export function applyWind(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string }, wind: Wind) {
  shader.uniforms.windTime = wind.uniforms.windTime;
  shader.uniforms.windVector = wind.uniforms.windVector;
  shader.uniforms.windGusts = wind.uniforms.windGusts;
  shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${WIND_GLSL}`);
}

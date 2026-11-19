import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { CopyShader } from "three/addons/shaders/CopyShader.js";

/**
 * The scene pass, multisampled. The composer's own buffers stay single-sampled: making those
 * multisampled would resolve the full frame again after every post effect, which costs far more
 * than the scene itself. Here the scene is drawn once into a multisampled target, resolved once,
 * and handed to the rest of the chain as an ordinary texture.
 *
 * Without this, anything thinner than a pixel (cables, railings, lattices, distant edges) crawls
 * and flashes as the camera moves; the edge filter at the end of the chain cannot bring back
 * coverage that was never sampled.
 */
export class MultisampledRenderPass extends RenderPass {
  private readonly target: THREE.WebGLRenderTarget | null;
  private readonly quad: FullScreenQuad | null;

  constructor(scene: THREE.Scene, camera: THREE.Camera, samples: number) {
    super(scene, camera);
    this.target = samples > 0 ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples }) : null;
    this.quad = this.target
      ? new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
        vertexShader: CopyShader.vertexShader,
        fragmentShader: CopyShader.fragmentShader,
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
      }))
      : null;
  }

  override setSize(width: number, height: number) {
    this.target?.setSize(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    if (!this.target || !this.quad || this.renderToScreen) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    (this.quad.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
  }

  override dispose() {
    this.target?.dispose();
    this.quad?.dispose();
  }
}

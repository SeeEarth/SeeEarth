// WebGPU renderer + ambient occlusion (node-based post-processing). Only included in the WebGPU build.
import * as THREE from "three/webgpu";
import { pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, sample, screenUV } from "three/tsl";
import { ao } from "three/addons/tsl/display/GTAONode.js";

export async function createRenderer(canvas: HTMLCanvasElement) {
  const r = new THREE.WebGPURenderer({ canvas, antialias: true });
  await r.init();
  return r;
}

export function createAO(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const Pipeline = ((THREE as unknown as Record<string, unknown>).RenderPipeline ?? (THREE as unknown as Record<string, unknown>).PostProcessing) as new (r: THREE.WebGPURenderer) => { outputNode: unknown; render(): void };
  const pipeline = new Pipeline(renderer);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
  const color = scenePass.getTextureNode("output");
  const normalTex = scenePass.getTextureNode("normal");
  const depth = scenePass.getTextureNode("depth");
  const sceneNormal = sample((uv) => unpackRGBToNormal(normalTex.sample(uv)));
  const aoPass = ao(depth, sceneNormal, camera);
  aoPass.resolutionScale = 0.5;
  pipeline.outputNode = aoPass.getTextureNode().sample(screenUV).r.mul(color);
  return { render: () => pipeline.render(), setSize: (_w: number, _h: number) => {} };
}

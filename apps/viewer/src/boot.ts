// Picks the renderer: the WebGPU build when the browser supports it (?renderer=webgl|webgpu to force).
import "./style.css";

const p = new URLSearchParams(location.search);
const want = p.get("renderer");
async function hasWebGPU() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try { return !!(await gpu.requestAdapter()); } catch { return false; }
}
const useGpu = want === "webgpu" || (want !== "webgl" && p.get("render") !== "1" && (await hasWebGPU()));
document.documentElement.dataset.renderer = useGpu ? "webgpu" : "webgl";
if (useGpu) {
  const url = "/gpu/gpu-main.js";
  await import(/* @vite-ignore */ url).catch(async (e) => { console.warn("WebGPU build failed, using WebGL", e); await import("./main"); });
} else await import("./main");

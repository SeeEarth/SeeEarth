// Second build of the viewer for WebGPU: same code, with `three` resolved to three.js's WebGPU build.
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/gpu/",
  define: { "import.meta.env.VITE_GPU": JSON.stringify("1") },
  resolve: { alias: [{ find: /^three$/, replacement: "three/webgpu" }] },
  build: {
    outDir: "dist/gpu", emptyOutDir: false, target: "es2022", chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/main.ts"),
      output: { entryFileNames: "gpu-main.js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});

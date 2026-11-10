import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: {
    outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500, target: "es2022",
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), model: resolve(import.meta.dirname, "model.html") } },
  },
});

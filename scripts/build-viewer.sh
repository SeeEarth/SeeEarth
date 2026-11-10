#!/bin/bash
# Build the viewer (WebGL build + WebGPU build under /gpu/) into a fresh folder and swap it in,
# so a running server never serves a half-written dist.
set -e
cd "$(dirname "$0")/../apps/viewer"
npx vite build --outDir dist-next --emptyOutDir >/dev/null
npx vite build -c vite.gpu.config.ts --outDir dist-next/gpu >/dev/null
rm -rf dist-old; [ -d dist ] && mv dist dist-old; mv dist-next dist; rm -rf dist-old
echo "✓ viewer built (webgl + webgpu)"

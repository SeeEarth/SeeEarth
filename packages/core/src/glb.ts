// Minimal GLB inspection: size, triangle count, no external resources.
export interface GlbInfo { ok: boolean; errors: string[]; triangles: number; bytes: number }

export function inspectGlb(buf: ArrayBuffer, limits: { maxBytes: number; maxTriangles: number }): GlbInfo {
  const errors: string[] = [];
  const bytes = buf.byteLength;
  const fail = (e: string): GlbInfo => ({ ok: false, errors: [e], triangles: 0, bytes });
  if (bytes > limits.maxBytes) return fail(`file is ${bytes} bytes; max ${limits.maxBytes}`);
  if (bytes < 20) return fail("not a GLB file");
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) return fail("not a GLB file (bad magic); export as binary glTF (.glb)");
  if (dv.getUint32(4, true) !== 2) return fail("only glTF 2.0 is supported");
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) return fail("first GLB chunk must be JSON");
  let gltf: any;
  try { gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))); } catch { return fail("GLB JSON chunk is invalid"); }
  for (const b of gltf.buffers ?? []) if (b.uri) errors.push("buffers must be embedded (no external .bin)");
  for (const im of gltf.images ?? []) if (im.uri && !String(im.uri).startsWith("data:")) errors.push("images must be embedded (no external textures)");
  let triangles = 0;
  for (const m of gltf.meshes ?? []) for (const p of m.primitives ?? []) {
    const mode = p.mode ?? 4;
    const count = p.indices != null ? gltf.accessors?.[p.indices]?.count : gltf.accessors?.[p.attributes?.POSITION]?.count;
    if (typeof count !== "number") continue;
    if (mode === 4) triangles += count / 3; else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
  }
  // Instanced nodes multiply cost; count mesh references.
  const refs = new Map<number, number>();
  for (const n of gltf.nodes ?? []) if (n.mesh != null) refs.set(n.mesh, (refs.get(n.mesh) ?? 0) + 1);
  if (refs.size) {
    triangles = 0;
    for (const [mi, k] of refs) for (const p of gltf.meshes?.[mi]?.primitives ?? []) {
      const count = p.indices != null ? gltf.accessors?.[p.indices]?.count : gltf.accessors?.[p.attributes?.POSITION]?.count;
      if (typeof count === "number") triangles += ((p.mode ?? 4) === 4 ? count / 3 : Math.max(0, count - 2)) * k;
    }
  }
  triangles = Math.round(triangles);
  if (triangles > limits.maxTriangles) errors.push(`${triangles} triangles; max ${limits.maxTriangles}. Simplify the model.`);
  if (triangles === 0) errors.push("model has no triangles");
  return { ok: errors.length === 0, errors, triangles, bytes };
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

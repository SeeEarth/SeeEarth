// Surface detail shared by procedural buildings and contributors' models: normal maps derived
// from colour textures (mortar joints, slates and window frames get relief that catches the
// light), reflective glass, and a sky environment so glass and metal reflect the real sky.
import * as THREE from "three";

const normalCache = new WeakMap<object, THREE.Texture>();

/**
 * Tangent-space normal map from a texture's luminance: dark = recessed (joints, gaps between
 * slates, glass behind frames), light = raised. `strength` scales the slope.
 */
export function normalFromImage(src: CanvasImageSource & { width: number; height: number }, strength = 2.5, maxSize = 256): HTMLCanvasElement {
  const W = Math.min(maxSize, src.width), H = Math.min(maxSize, src.height);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, W, H);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  const L = (x: number, y: number) => lum[((y + H) % H) * W + ((x + W) % W)]; // wraps: textures tile
  const out = g.createImageData(W, H), o = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // Sobel
    const dx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1)) - (L(x - 1, y - 1) + 2 * L(x - 1, y) + L(x - 1, y + 1));
    const dy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1)) - (L(x - 1, y - 1) + 2 * L(x, y - 1) + L(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * W + x) * 4;
    o[i] = (nx * 0.5 + 0.5) * 255; o[i + 1] = (ny * 0.5 + 0.5) * 255; o[i + 2] = (nz * 0.5 + 0.5) * 255; o[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c;
}

/** A normal map that tiles exactly like `map` (same wrapping, repeat, offset and flip). */
export function normalMapFor(map: THREE.Texture, strength = 2.5): THREE.Texture | null {
  const img = map.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width) return null;
  let t = normalCache.get(img);
  if (!t) {
    t = new THREE.CanvasTexture(normalFromImage(img, strength));
    t.colorSpace = THREE.NoColorSpace;
    normalCache.set(img, t);
  }
  const n = t.clone(); // shares the image; own transform
  n.wrapS = map.wrapS; n.wrapT = map.wrapT; n.repeat.copy(map.repeat); n.offset.copy(map.offset);
  n.rotation = map.rotation; n.center.copy(map.center); n.flipY = map.flipY; n.channel = map.channel;
  n.anisotropy = map.anisotropy; n.needsUpdate = true;
  return n;
}

const done = new WeakSet<THREE.Material>();

/**
 * Upgrade a material from a contributor's model in place: relief from its texture, real glass.
 * Kit materials are named "<kind> <#colour>" (stone, brick, slate, plain…), which survives glTF.
 */
export function enhanceMaterial(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || done.has(m)) return;
  done.add(m);
  const kind = (m.name || "").split(" ")[0];
  const glassy = m.roughness <= 0.3 && m.metalness < 0.5 && !m.map && m.color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.35;
  if (glassy) {
    // dark glass that mirrors the sky; slightly blue so it never reads as a black hole
    m.roughness = 0.06; m.metalness = 0.0; m.envMapIntensity = 1.6;
    m.color.lerp(new THREE.Color("#2b3a46"), 0.35);
    m.needsUpdate = true;
    return;
  }
  if (m.map && !m.normalMap) {
    const strength = kind === "brick" || kind === "slate" || kind === "tiles" ? 3 : kind === "stone" ? 2.2 : 1.5;
    const n = normalMapFor(m.map, strength);
    if (n) { m.normalMap = n; m.normalScale.set(1, 1); m.needsUpdate = true; }
  }
}

/** Environment map of the open sky (blue zenith, bright horizon, warm ground, a sun glint). */
export function skyEnvironment(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): THREE.Texture {
  const s = new THREE.Scene();
  const g = new THREE.SphereGeometry(100, 48, 24);
  const pos = g.getAttribute("position"), col = new Float32Array(pos.count * 3);
  const zen = new THREE.Color(0x6a93c2), hor = new THREE.Color(0xe8e6de), gnd = new THREE.Color(0x857a68), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 100;
    if (y >= 0) c.copy(hor).lerp(zen, Math.pow(y, 0.5)); else c.copy(hor).lerp(gnd, Math.min(1, -y * 6));
    c.toArray(col, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  s.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2d8).multiplyScalar(12) }));
  sunDisc.position.copy(sunDir).multiplyScalar(90);
  s.add(sunDisc);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.02).texture;
  pm.dispose();
  return tex;
}

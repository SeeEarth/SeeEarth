// Procedural facade textures: one texture = one window bay × one floor, tiled over walls.
import * as THREE from "three";

const cache = new Map<string, THREE.MeshStandardMaterial>();

export interface FacadeKey {
  material: string; color: string; pattern: string; windowColor: string; density: number; trim?: string;
}

function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, f);
  return "#" + c.getHexString();
}

function drawWall(g: CanvasRenderingContext2D, S: number, k: FacadeKey) {
  g.fillStyle = k.color; g.fillRect(0, 0, S, S);
  // material texture
  if (k.material === "brick") {
    g.strokeStyle = shade(k.color, 0.12); g.lineWidth = 1;
    const bh = S / 12;
    for (let r = 0; r < 12; r++) {
      g.beginPath(); g.moveTo(0, r * bh); g.lineTo(S, r * bh); g.stroke();
      const off = r % 2 ? S / 8 : 0;
      for (let x = off; x < S; x += S / 4) { g.beginPath(); g.moveTo(x, r * bh); g.lineTo(x, (r + 1) * bh); g.stroke(); }
    }
  } else if (k.material === "stone" || k.material === "marble") {
    g.strokeStyle = shade(k.color, -0.06); g.lineWidth = 1.5;
    for (let r = 0; r < 4; r++) {
      g.beginPath(); g.moveTo(0, (r * S) / 4); g.lineTo(S, (r * S) / 4); g.stroke();
      const off = r % 2 ? S / 4 : 0;
      for (let x = off; x < S; x += S / 2) { g.beginPath(); g.moveTo(x, (r * S) / 4); g.lineTo(x, ((r + 1) * S) / 4); g.stroke(); }
    }
  } else if (k.material === "concrete") {
    g.strokeStyle = shade(k.color, -0.05); g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);
  } else if (k.material === "wood") {
    g.strokeStyle = shade(k.color, -0.08);
    for (let x = 0; x < S; x += S / 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
  } else if (k.material === "metal") {
    g.strokeStyle = shade(k.color, -0.07);
    for (let x = 0; x < S; x += S / 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
  }
  // grime / variation
  const grad = g.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,0.06)");
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  // floor slab line
  g.fillStyle = k.trim ?? shade(k.color, -0.08);
  g.fillRect(0, S - 3, S, 3);
}

function drawWindows(g: CanvasRenderingContext2D, S: number, k: FacadeKey) {
  const d = k.density;
  const glass = k.windowColor;
  const frame = k.trim ?? shade(k.color, 0.15);
  const pane = (x: number, y: number, w: number, h: number, arched = false) => {
    g.fillStyle = frame; g.fillRect(x - 2, y - 2, w + 4, h + 4);
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, shade(glass, 0.12)); grd.addColorStop(1, shade(glass, -0.06));
    g.fillStyle = grd;
    if (arched) {
      g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y + w / 2); g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); g.lineTo(x + w, y + h); g.closePath(); g.fill();
    } else g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(255,255,255,0.18)"; g.fillRect(x + 2, y + 2, Math.max(2, w * 0.15), h - 4);
  };
  switch (k.pattern) {
    case "none": return;
    case "curtain": {
      const grd = g.createLinearGradient(0, 0, S, S);
      grd.addColorStop(0, shade(glass, 0.1)); grd.addColorStop(1, shade(glass, -0.05));
      g.fillStyle = grd; g.fillRect(0, 0, S, S);
      g.fillStyle = frame; g.fillRect(0, 0, 3, S); g.fillRect(0, S - 4, S, 4); g.fillRect(S / 2 - 1, 0, 2, S);
      return;
    }
    case "bands": pane(0, S * 0.22, S, S * 0.5 * Math.max(0.4, d) / 0.5); return;
    case "sparse": { const w = S * 0.28, h = S * 0.4; pane((S - w) / 2, S * 0.25, w, h); return; }
    case "arched": { const w = S * 0.42 * (0.6 + d * 0.6), h = S * 0.6; pane((S - w) / 2, S * 0.16, w, h, true); return; }
    default: { const w = S * 0.55 * (0.5 + d), h = S * 0.55; pane((S - Math.min(w, S * 0.9)) / 2, S * 0.18, Math.min(w, S * 0.9), h); }
  }
}

export function facadeMaterial(k: FacadeKey, renderer: THREE.WebGLRenderer): THREE.MeshStandardMaterial {
  const key = JSON.stringify(k);
  let m = cache.get(key);
  if (m) return m;
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  drawWall(g, S, k);
  drawWindows(g, S, k);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const r = renderer as unknown as { capabilities?: { getMaxAnisotropy(): number }; getMaxAnisotropy?(): number };
  tex.anisotropy = Math.min(8, r.capabilities?.getMaxAnisotropy() ?? r.getMaxAnisotropy?.() ?? 4);
  tex.generateMipmaps = true;
  m = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: k.material === "glass" || k.pattern === "curtain" ? 0.25 : k.material === "metal" ? 0.5 : 0.88,
    metalness: k.material === "glass" || k.pattern === "curtain" ? 0.35 : k.material === "metal" ? 0.4 : 0.02,
  });
  cache.set(key, m);
  return m;
}

export function groundFloorMaterial(kind: string, color: string, renderer: THREE.WebGLRenderer): THREE.MeshStandardMaterial {
  const key = `gf|${kind}|${color}`;
  let m = cache.get(key);
  if (m) return m;
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  g.fillStyle = color; g.fillRect(0, 0, S, S);
  if (kind === "shopfront" || kind === "glass") {
    g.fillStyle = "#3d4e5c"; g.fillRect(S * 0.08, S * 0.25, S * 0.84, S * 0.75);
    g.fillStyle = "rgba(255,240,200,0.35)"; g.fillRect(S * 0.1, S * 0.3, S * 0.8, S * 0.68);
    g.fillStyle = shade(color, -0.2); g.fillRect(0, S * 0.05, S, S * 0.14); // signage band
  } else if (kind === "arcade") {
    g.fillStyle = "#2f2b27";
    g.beginPath(); g.moveTo(S * 0.15, S); g.lineTo(S * 0.15, S * 0.45); g.arc(S / 2, S * 0.45, S * 0.35, Math.PI, 0); g.lineTo(S * 0.85, S); g.closePath(); g.fill();
  } else {
    g.fillStyle = "#3a3f44"; g.fillRect(S * 0.35, S * 0.35, S * 0.3, S * 0.65);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  cache.set(key, m);
  return m;
}

export function flatMaterial(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const key = `flat|${color}|${JSON.stringify(opts)}`;
  let m = cache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts }); cache.set(key, m); }
  return m;
}

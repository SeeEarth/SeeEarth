// Procedural facade textures: one texture = one window bay × one floor, tiled over walls.
import * as THREE from "three";
import { normalFromImage } from "./surface";

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

// Mask colours for the roughness (G) / metalness (B) map: walls are matte, glass is a mirror.
const MASK_WALL = "rgb(0,235,8)", MASK_GLASS = "rgb(0,20,40)", MASK_FRAME = "rgb(0,150,8)";

/** Window layout. With `mask`, paints the roughness/metalness mask instead of colours. */
function drawWindows(g: CanvasRenderingContext2D, S: number, k: FacadeKey, mask = false) {
  const d = k.density;
  const glass = k.windowColor;
  const frame = k.trim ?? shade(k.color, 0.15);
  const pane = (x: number, y: number, w: number, h: number, arched = false) => {
    const shapePath = (inset: number) => {
      g.beginPath();
      if (arched) { g.moveTo(x + inset, y + h - inset); g.lineTo(x + inset, y + w / 2); g.arc(x + w / 2, y + w / 2, w / 2 - inset, Math.PI, 0); g.lineTo(x + w - inset, y + h - inset); g.closePath(); }
      else g.rect(x + inset, y + inset, w - 2 * inset, h - 2 * inset);
    };
    // sill and frame
    g.fillStyle = mask ? MASK_FRAME : frame;
    g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillRect(x - 5, y + h + 1, w + 10, 4);
    if (mask) { g.fillStyle = MASK_GLASS; shapePath(1); g.fill(); return; }
    // glass: sky reflection gradient, darker towards the top where the lintel shades it
    const grd = g.createLinearGradient(x, y, x, y + h);
    grd.addColorStop(0, shade(glass, -0.1)); grd.addColorStop(0.35, shade(glass, 0.06)); grd.addColorStop(1, shade(glass, -0.02));
    g.fillStyle = grd; shapePath(1); g.fill();
    // reveal shadow: the glass sits back in the wall
    g.save(); shapePath(1); g.clip();
    g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(x, y, w, Math.max(3, h * 0.1)); g.fillRect(x, y, Math.max(2, w * 0.08), h);
    g.restore();
    // glazing bars
    g.fillStyle = frame;
    if (w > S * 0.18) g.fillRect(x + w / 2 - 1, y + 1, 2, h - 2);
    if (h > S * 0.3) g.fillRect(x + 1, y + h * 0.55, w - 2, 2);
  };
  switch (k.pattern) {
    case "none": return;
    case "curtain": {
      if (mask) { g.fillStyle = MASK_GLASS; g.fillRect(0, 0, S, S); g.fillStyle = MASK_FRAME; g.fillRect(0, 0, 3, S); g.fillRect(0, S - 4, S, 4); g.fillRect(S / 2 - 1, 0, 2, S); return; }
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
  const r = renderer as unknown as { capabilities?: { getMaxAnisotropy(): number }; getMaxAnisotropy?(): number };
  const aniso = Math.min(8, r.capabilities?.getMaxAnisotropy() ?? r.getMaxAnisotropy?.() ?? 4);
  const wrap = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  // roughness/metalness mask: matte walls, mirror-like glass
  const maskC = document.createElement("canvas");
  maskC.width = maskC.height = S;
  const mg = maskC.getContext("2d")!;
  const glassWall = k.material === "glass" || k.material === "metal";
  mg.fillStyle = glassWall ? MASK_FRAME : MASK_WALL; mg.fillRect(0, 0, S, S);
  drawWindows(mg, S, k, true);
  const rm = wrap(maskC, false);
  m = new THREE.MeshStandardMaterial({
    map: wrap(canvas, true),
    normalMap: wrap(normalFromImage(canvas, k.material === "brick" ? 3 : 2.2), false),
    roughnessMap: rm, metalnessMap: rm, roughness: 1, metalness: k.material === "metal" ? 1 : 0.6,
    envMapIntensity: 1.2,
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

// ---------------------------------------------------------------- ground surfaces (world-UV, 1 unit = `metres`)
function rnd(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

export const GROUND_METRES: Record<string, number> = { paving: 4, asphalt: 6, grass: 5, gravel: 3, water: 20, plain: 8, garden: 24 };

function paintGround(g: CanvasRenderingContext2D, S: number, kind: string, color: string) {
  const r = rnd(kind.length * 977 + color.length);
  const base = new THREE.Color(color);
  g.fillStyle = color; g.fillRect(0, 0, S, S);
  const speck = (n: number, size: number, amp: number) => {
    for (let i = 0; i < n; i++) {
      const c = base.clone().offsetHSL(0, 0, (r() - 0.5) * amp);
      g.fillStyle = "#" + c.getHexString(); g.globalAlpha = 0.6;
      g.fillRect(r() * S, r() * S, size * (0.5 + r()), size * (0.5 + r()));
    }
    g.globalAlpha = 1;
  };
  if (kind === "paving") {
    // flagstones, 0.6 × 0.9 m, staggered (4 m tile = 7×4 rows)
    const rows = 7, cols = 5;
    for (let y = 0; y < rows; y++) for (let x = -1; x < cols + 1; x++) {
      const w = S / cols, h = S / rows, ox = (y % 2) * w * 0.5;
      g.fillStyle = "#" + base.clone().offsetHSL(0, 0, (r() - 0.5) * 0.06).getHexString();
      g.fillRect(x * w + ox + 1, y * h + 1, w - 2, h - 2);
    }
    g.strokeStyle = shade(color, -0.12); g.lineWidth = 1.5;
    for (let y = 0; y <= rows; y++) { g.beginPath(); g.moveTo(0, (y * S) / rows); g.lineTo(S, (y * S) / rows); g.stroke(); }
    for (let y = 0; y < rows; y++) for (let x = 0; x <= cols; x++) { const xx = (x * S) / cols + (y % 2) * (S / cols) * 0.5; g.beginPath(); g.moveTo(xx % S, (y * S) / rows); g.lineTo(xx % S, ((y + 1) * S) / rows); g.stroke(); }
    speck(300, 2, 0.08);
  } else if (kind === "asphalt") {
    speck(2500, 1.5, 0.12);
    for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.04})`; g.beginPath(); g.ellipse(r() * S, r() * S, 20 + r() * 50, 10 + r() * 30, r() * 3, 0, Math.PI * 2); g.fill(); }
  } else if (kind === "grass") {
    speck(3000, 2, 0.14);
    for (let i = 0; i < 10; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "60,80,20" : "160,170,90"},${0.05 + r() * 0.06})`; g.beginPath(); g.ellipse(r() * S, r() * S, 20 + r() * 40, 20 + r() * 40, 0, 0, Math.PI * 2); g.fill(); }
  } else if (kind === "garden") {
    // 24 m of back gardens: lawn, patios, beds, sheds' shadows, hedges between plots
    speck(3000, 2, 0.14);
    const patch = (rgb: string, a: number, n: number, rmin: number, rmax: number) => {
      for (let i = 0; i < n; i++) { g.fillStyle = `rgba(${rgb},${a})`; g.beginPath(); g.ellipse(r() * S, r() * S, rmin + r() * (rmax - rmin), rmin + r() * (rmax - rmin), r() * 3, 0, Math.PI * 2); g.fill(); }
    };
    patch("150,140,120", 0.45, 10, 6, 18);   // patios and paths
    patch("95,80,55", 0.35, 12, 4, 12);      // beds and bare soil
    patch("55,70,35", 0.4, 14, 5, 16);       // shrubs
    g.strokeStyle = "rgba(45,60,30,0.55)"; g.lineWidth = 3;
    for (let i = 0; i < 4; i++) { const x = (i + 0.5) * (S / 4) + (r() - 0.5) * 10; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); } // hedges between plots
  } else if (kind === "gravel") {
    speck(4000, 2.5, 0.2);
  } else {
    speck(800, 3, 0.05);
  }
}

/** Tiling ground material with relief. UVs must be world metres / GROUND_METRES[kind]. */
export function groundMaterial(kind: string, color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const key = `ground|${kind}|${color}|${JSON.stringify(opts)}`;
  let m = cache.get(key);
  if (m) return m;
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  paintGround(canvas.getContext("2d")!, S, kind, color);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const nm = new THREE.CanvasTexture(normalFromImage(canvas, kind === "paving" ? 2.5 : 1.5));
  nm.wrapS = nm.wrapT = THREE.RepeatWrapping; nm.anisotropy = 8;
  m = new THREE.MeshStandardMaterial({ map: tex, normalMap: nm, roughness: kind === "water" ? 0.15 : 0.95, ...opts });
  cache.set(key, m);
  return m;
}

// ---------------------------------------------------------------- roofs (UV: u along the eaves, v up the slope, metres / 2)
export function roofKind(material: string | undefined, color: string, pitched: boolean): string {
  if (material === "metal" || material === "copper" || material === "lead") return "metal";
  if (material === "tiles" || material === "tile" || material === "clay") return "tiles";
  if (material === "slate" || material === "stone") return "slate";
  if (!pitched) return "membrane";
  const hsl = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 });
  if ((hsl.h < 0.11 || hsl.h > 0.95) && hsl.s > 0.25) return "tiles";
  return "slate";
}

export function roofMaterial(kind: string, color: string): THREE.MeshStandardMaterial {
  const key = `roof|${kind}|${color}`;
  let m = cache.get(key);
  if (m) return m;
  const S = 256, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!, r = rnd(color.length * 31 + kind.length), base = new THREE.Color(color);
  const tone = (amp: number) => "#" + base.clone().offsetHSL(0, 0, (r() - 0.5) * amp).getHexString();
  g.fillStyle = color; g.fillRect(0, 0, S, S);
  if (kind === "slate" || kind === "tiles") {
    // courses run along u; 2 m of roof per texture → slates ~0.25 m, tiles ~0.2 m
    const rows = kind === "slate" ? 8 : 10, cols = kind === "slate" ? 8 : 10, h = S / rows, w = S / cols;
    for (let y = 0; y < rows; y++) for (let x = -1; x <= cols; x++) {
      const ox = (y % 2) * w * 0.5;
      g.fillStyle = tone(kind === "slate" ? 0.08 : 0.12);
      if (kind === "tiles") { g.beginPath(); g.ellipse(x * w + ox + w / 2, y * h + h * 0.55, w / 2 - 0.5, h * 0.55, 0, 0, Math.PI); g.fill(); g.fillRect(x * w + ox + 0.5, y * h, w - 1, h * 0.55); }
      else g.fillRect(x * w + ox + 1, y * h, w - 2, h - 1);
      // course shadow at the lower edge of each row
      g.fillStyle = "rgba(0,0,0,0.28)"; g.fillRect(x * w + ox, y * h + h - 2, w, 2);
    }
  } else if (kind === "metal") {
    g.fillStyle = shade(color, -0.12);
    for (let x = 0; x < S; x += S / 5) g.fillRect(x, 0, 3, S);
  } else {
    // flat roofs: membrane / gravel with patches
    for (let i = 0; i < 1500; i++) { g.fillStyle = tone(0.1); g.globalAlpha = 0.5; g.fillRect(r() * S, r() * S, 2, 2); }
    g.globalAlpha = 1;
  }
  // weathering streaks down the slope
  for (let i = 0; i < 12; i++) { g.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.04})`; g.fillRect(r() * S, 0, 4 + r() * 20, S); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const nm = new THREE.CanvasTexture(normalFromImage(c, kind === "tiles" ? 3.5 : 2.5));
  nm.wrapS = nm.wrapT = THREE.RepeatWrapping; nm.anisotropy = 8;
  m = new THREE.MeshStandardMaterial({ map: tex, normalMap: nm, roughness: kind === "metal" ? 0.45 : 0.85, metalness: kind === "metal" ? 0.5 : 0, side: THREE.DoubleSide });
  cache.set(key, m);
  return m;
}

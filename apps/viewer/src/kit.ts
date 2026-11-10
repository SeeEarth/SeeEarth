// seeEarth modelling kit: helpers contributor agents use to build real 3D building models.
//
// Conventions: metres; Y is up; the model stands on y = 0, centred on x = z = 0.
// The building's LONG side runs along X. The "front" is the -Z face (it can be flipped when fitted).
// Everything returns ordinary three.js objects, so agents can mix helpers with raw THREE code.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// ---------------------------------------------------------------- materials (procedural, tile in metres)

type TexPainter = (g: CanvasRenderingContext2D, S: number, base: THREE.Color) => void;
const texCache = new Map<string, THREE.CanvasTexture>();
const shade = (c: THREE.Color, l: number) => "#" + c.clone().offsetHSL(0, 0, l).getHexString();

function noise(g: CanvasRenderingContext2D, S: number, amount: number, seed = 1) {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** A canvas texture that represents `metres` × `metres` of surface. */
function tex(name: string, color: string, paint: TexPainter, S = 256): THREE.CanvasTexture {
  const key = `${name}|${color}`;
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const base = new THREE.Color(color);
  g.fillStyle = color; g.fillRect(0, 0, S, S);
  paint(g, S, base);
  t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  texCache.set(key, t);
  return t;
}

const painters: Record<string, { metres: number; paint: TexPainter; rough: number; metal?: number }> = {
  // Ashlar: large smooth stone blocks (Oxford's Headington/Clipsham stone, Portland stone…)
  stone: { metres: 2.4, rough: 0.85, paint: (g, S, b) => {
    noise(g, S, 18, 3);
    g.strokeStyle = shade(b, -0.1); g.lineWidth = 2;
    const rows = 6;
    for (let r = 0; r < rows; r++) {
      const y = (r * S) / rows; g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
      const off = r % 2 ? S / 4 : 0;
      for (let x = off; x < S + 1; x += S / 2) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + S / rows); g.stroke(); }
    }
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`; g.fillRect(Math.random() * S, Math.random() * S, 20 + Math.random() * 60, 10 + Math.random() * 30); }
  } },
  brick: { metres: 1.2, rough: 0.9, paint: (g, S, b) => {
    g.fillStyle = shade(b, 0.18); g.fillRect(0, 0, S, S); // mortar
    const rows = 16, bw = S / 4;
    for (let r = 0; r < rows; r++) for (let x = (r % 2) * (bw / 2) - bw; x < S; x += bw) {
      g.fillStyle = shade(b, (Math.random() - 0.5) * 0.08);
      g.fillRect(x + 1, (r * S) / rows + 1, bw - 2, S / rows - 2);
    }
    noise(g, S, 14, 5);
  } },
  render: { metres: 3, rough: 0.92, paint: (g, S) => noise(g, S, 10, 7) },
  slate: { metres: 1.5, rough: 0.75, paint: (g, S, b) => {
    const rows = 10;
    for (let r = 0; r < rows; r++) for (let x = (r % 2) * 16 - 32; x < S; x += 32) {
      g.fillStyle = shade(b, (Math.random() - 0.5) * 0.1);
      g.fillRect(x + 1, (r * S) / rows, 30, S / rows - 1);
    }
    noise(g, S, 10, 9);
  } },
  tiles: { metres: 1.2, rough: 0.8, paint: (g, S, b) => {
    const rows = 12;
    for (let r = 0; r < rows; r++) for (let x = (r % 2) * 12 - 24; x < S; x += 24) {
      g.fillStyle = shade(b, (Math.random() - 0.5) * 0.12);
      g.beginPath(); g.ellipse(x + 12, (r * S) / rows + 14, 12, 12, 0, 0, Math.PI); g.fill();
    }
    noise(g, S, 12, 11);
  } },
  lead: { metres: 2, rough: 0.6, metal: 0.3, paint: (g, S, b) => {
    g.strokeStyle = shade(b, -0.08); g.lineWidth = 3;
    for (let x = 0; x < S; x += S / 4) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
    noise(g, S, 10, 13);
  } },
  copper: { metres: 2, rough: 0.6, metal: 0.2, paint: (g, S, b) => {
    g.strokeStyle = shade(b, -0.06); g.lineWidth = 2;
    for (let x = 0; x < S; x += S / 6) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
    noise(g, S, 16, 15);
  } },
  wood: { metres: 1.5, rough: 0.8, paint: (g, S, b) => {
    g.strokeStyle = shade(b, -0.1);
    for (let x = 0; x < S; x += S / 12) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
    noise(g, S, 12, 17);
  } },
  concrete: { metres: 3, rough: 0.9, paint: (g, S, b) => {
    noise(g, S, 12, 19);
    g.strokeStyle = shade(b, -0.06); g.strokeRect(1, 1, S - 2, S - 2);
  } },
};

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function material(kind: string, color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const key = `${kind}|${color}|${JSON.stringify(extra)}`;
  let m = matCache.get(key);
  if (m) return m;
  const p = painters[kind];
  m = p
    ? new THREE.MeshStandardMaterial({ map: tex(kind, color, p.paint), roughness: p.rough, metalness: p.metal ?? 0, ...extra })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
  m.userData.metres = p?.metres ?? 2;
  m.name = `${kind} ${color}`;
  matCache.set(key, m);
  return m;
}

/** Material presets. Colours are #rrggbb; sample them from photos. */
export const materials = {
  stone: (c = "#d8c49b") => material("stone", c),          // honey limestone (Oxford colleges)
  brick: (c = "#9a5440") => material("brick", c),
  render: (c = "#e9e2d2") => material("render", c),        // plaster / stucco / painted render
  concrete: (c = "#bdbab3") => material("concrete", c),
  slate: (c = "#4f5560") => material("slate", c),
  tiles: (c = "#9c4f36") => material("tiles", c),          // clay roof tiles
  lead: (c = "#8d939a") => material("lead", c),            // lead roofs and domes
  copper: (c = "#6f9c8a") => material("copper", c),        // verdigris
  wood: (c = "#7a5536") => material("wood", c),
  glass: (c = "#1f2a33") => material("plain", c, { roughness: 0.25, metalness: 0.2, envMapIntensity: 0.6 }),
  metal: (c = "#9aa0a6") => material("plain", c, { roughness: 0.4, metalness: 0.7 }),
  paint: (c: string) => material("plain", c, { roughness: 0.6 }),
  gold: (c = "#d4a83a") => material("plain", c, { roughness: 0.3, metalness: 0.9 }),
};

// ---------------------------------------------------------------- geometry helpers

/** Re-project UVs so textures tile at a fixed real-world size on every face. */
function worldUV(g: THREE.BufferGeometry, metres: number): THREE.BufferGeometry {
  g = g.index ? g.toNonIndexed() : g;
  g.computeVertexNormals();
  const p = g.getAttribute("position"), n = g.getAttribute("normal");
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u: number, v: number;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u / metres; uv[i * 2 + 1] = v / metres;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
  const mm = m as THREE.MeshStandardMaterial;
  const out = new THREE.Mesh(mm.map ? worldUV(g, mm.userData.metres ?? 2) : g, m);
  out.castShadow = out.receiveShadow = true;
  out.userData.kitUV = true;
  return out;
}

export function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const c of children) if (c) g.add(c);
  return g;
}

/** Move/rotate an object in place and return it. rotY in degrees. */
export function at<T extends THREE.Object3D>(obj: T, x = 0, y = 0, z = 0, rotY = 0): T {
  obj.position.set(x, y, z);
  obj.rotation.y = THREE.MathUtils.degToRad(rotY);
  return obj;
}

/** Axis-aligned box standing on y=0 (or at `y`), centred at x,z. */
export function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return mesh(g, m);
}

export function cylinder(r: number, h: number, m: THREE.Material, opts: { x?: number; y?: number; z?: number; segments?: number; rTop?: number } = {}): THREE.Mesh {
  const g = new THREE.CylinderGeometry(opts.rTop ?? r, r, h, opts.segments ?? 16);
  g.translate(opts.x ?? 0, (opts.y ?? 0) + h / 2, opts.z ?? 0);
  return mesh(g, m);
}

// ---------------------------------------------------------------- roofs (on a w×d rectangle)

export interface RoofOpts { w: number; d: number; at: number; h?: number; overhang?: number; material?: THREE.Material }

function triGeo(points: [number, number, number][], tris: number[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...points[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export const roof = {
  /** Ridge along X. Gable ends are walls; pass `gableMaterial` to match the walls. */
  gabled(o: RoofOpts & { gableMaterial?: THREE.Material }): THREE.Group {
    const ov = o.overhang ?? 0.3, h = o.h ?? Math.min(o.d * 0.45, 6), y = o.at;
    const W = o.w / 2 + ov, D = o.d / 2 + ov;
    const slope = triGeo([[-W, y, -D], [W, y, -D], [W, y + h, 0], [-W, y + h, 0], [-W, y, D], [W, y, D]],
      [[0, 3, 1], [1, 3, 2], [4, 5, 3], [5, 2, 3]]);
    const w2 = o.w / 2, d2 = o.d / 2;
    const ends = triGeo([[w2, y, -d2], [w2, y, d2], [w2, y + h * (d2 / D), 0], [-w2, y, -d2], [-w2, y, d2], [-w2, y + h * (d2 / D), 0]], [[0, 2, 1], [3, 4, 5]]);
    return group(mesh(slope, o.material ?? materials.slate()), mesh(ends, o.gableMaterial ?? materials.stone()));
  },
  hipped(o: RoofOpts): THREE.Mesh {
    const ov = o.overhang ?? 0.3, h = o.h ?? Math.min(o.d * 0.4, 5), y = o.at;
    const W = o.w / 2 + ov, D = o.d / 2 + ov, r = Math.max(0, W - D);
    return mesh(triGeo([[-W, y, -D], [W, y, -D], [W, y, D], [-W, y, D], [-r, y + h, 0], [r, y + h, 0]],
      [[0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 3], [3, 5, 4], [3, 4, 0]]), o.material ?? materials.slate());
  },
  pyramid(o: RoofOpts): THREE.Mesh {
    const ov = o.overhang ?? 0.2, h = o.h ?? Math.max(o.w, o.d) * 0.6, y = o.at;
    const W = o.w / 2 + ov, D = o.d / 2 + ov;
    return mesh(triGeo([[-W, y, -D], [W, y, -D], [W, y, D], [-W, y, D], [0, y + h, 0]], [[0, 4, 1], [1, 4, 2], [2, 4, 3], [3, 4, 0]]), o.material ?? materials.slate());
  },
  /** Mansard: steep lower slope then a shallow top. */
  mansard(o: RoofOpts): THREE.Mesh {
    const h = o.h ?? 4, y = o.at, i = Math.min(o.w, o.d) * 0.18;
    const W = o.w / 2, D = o.d / 2;
    return mesh(triGeo([[-W, y, -D], [W, y, -D], [W, y, D], [-W, y, D], [-W + i, y + h, -D + i], [W - i, y + h, -D + i], [W - i, y + h, D - i], [-W + i, y + h, D - i]],
      [[0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 6], [2, 6, 3], [3, 6, 7], [3, 7, 0], [0, 7, 4], [4, 7, 5], [5, 7, 6]]), o.material ?? materials.slate());
  },
  flat(o: RoofOpts & { parapet?: number; wallMaterial?: THREE.Material }): THREE.Group {
    const g = group(box(o.w, 0.15, o.d, o.material ?? materials.lead(), 0, o.at, 0));
    if (o.parapet) g.add(...ring(o.w, o.d, o.parapet, 0.3, o.wallMaterial ?? materials.stone(), o.at));
    return g;
  },
};

/** Four thin walls around a w×d rectangle (parapets, enclosures). */
function ring(w: number, d: number, h: number, t: number, m: THREE.Material, y: number): THREE.Mesh[] {
  return [box(w, h, t, m, 0, y, -d / 2 + t / 2), box(w, h, t, m, 0, y, d / 2 - t / 2), box(t, h, d - 2 * t, m, -w / 2 + t / 2, y, 0), box(t, h, d - 2 * t, m, w / 2 - t / 2, y, 0)];
}

/** Battlements (crenellations) around the top of a w×d block at height `at`. */
export function crenellations(w: number, d: number, at: number, m: THREE.Material = materials.stone(), size = 0.6): THREE.Group {
  const g = group(...ring(w, d, size, 0.35, m, at));
  const step = size * 2;
  for (const [len, axis, off] of [[w, "x", -d / 2], [w, "x", d / 2], [d, "z", -w / 2], [d, "z", w / 2]] as const) {
    for (let s = -len / 2 + size / 2; s <= len / 2 - size / 2; s += step) {
      g.add(axis === "x" ? box(size, size, 0.35, m, s, at + size, off + (off < 0 ? 0.175 : -0.175)) : box(0.35, size, size, m, off + (off < 0 ? 0.175 : -0.175), at + size, s));
    }
  }
  return g;
}

/** Small spiky pinnacles at the four corners of a w×d block (Gothic towers, chapels). */
export function pinnacles(w: number, d: number, at: number, h = 2.5, m: THREE.Material = materials.stone()): THREE.Group {
  const g = group();
  for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    g.add(box(0.6, h * 0.45, 0.6, m, x, at, z));
    g.add(cylinder(0.32, h * 0.55, m, { x, y: at + h * 0.45, z, segments: 4, rTop: 0.02 }));
  }
  return g;
}

// ---------------------------------------------------------------- windows & doors

export type WindowStyle = "sash" | "square" | "arched" | "gothic" | "slit" | "shop";
export interface FacadeOpts {
  /** facade length (m) and its centre/rotation are handled by `windows()`; here per-window: */
  style?: WindowStyle;
  width?: number;           // window width in metres (default by style)
  height?: number;          // window height (default ~55% of the floor)
  frame?: string;           // frame colour
  glass?: string;           // glass colour
  spacing?: number;         // centre-to-centre spacing (m); default ≈ 2.2 × width
}

/** One window, facing -Z, centred at (0, cy). Returns geometry pieces by material. */
function windowParts(style: WindowStyle, w: number, h: number, cy: number) {
  const glass: THREE.BufferGeometry[] = [], frame: THREE.BufferGeometry[] = [];
  const b = (bw: number, bh: number, bd: number, x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(bw, bh, bd); g.translate(x, y, z); return g; };
  const shapeGeo = (s: THREE.Shape, depth: number, z: number) => { const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 6 }); g.translate(0, cy - h / 2, z); return g; };
  const t = 0.1;
  if (style === "gothic" || style === "arched") {
    const s = new THREE.Shape();
    const rise = style === "gothic" ? w * 0.75 : w / 2;
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h - rise);
    if (style === "gothic") { s.quadraticCurveTo(w / 2, h - rise * 0.25, 0, h); s.quadraticCurveTo(-w / 2, h - rise * 0.25, -w / 2, h - rise); }
    else s.absarc(0, h - rise, w / 2, 0, Math.PI, false);
    s.lineTo(-w / 2, 0);
    glass.push(shapeGeo(s, 0.04, -0.09));    // glass in front…
    // surround: a slightly bigger copy behind
    const o = new THREE.Shape(); const W2 = w / 2 + t, H2 = h + t;
    o.moveTo(-W2, -t); o.lineTo(W2, -t); o.lineTo(W2, H2 - rise - t);
    if (style === "gothic") { o.quadraticCurveTo(W2, H2 - rise * 0.25, 0, H2); o.quadraticCurveTo(-W2, H2 - rise * 0.25, -W2, H2 - rise - t); }
    else o.absarc(0, H2 - rise - t, W2, 0, Math.PI, false);
    o.lineTo(-W2, -t);
    frame.push(shapeGeo(o, 0.03, -0.05));    // …its stone surround just behind it, showing as a rim
    if (style === "gothic" && w > 1) frame.push(b(0.08, h - rise, 0.1, 0, cy - rise / 2, -0.1)); // mullion
  } else {
    glass.push(b(w, h, 0.04, 0, cy, -0.03));
    // head, sill and jambs stand proud of the wall so the glass reads as set back
    frame.push(b(w + 2 * t, t * 1.2, 0.2, 0, cy + h / 2 + t * 0.6, -0.1), b(w + 2 * t + 0.16, t * 1.4, 0.26, 0, cy - h / 2 - t * 0.7, -0.13));
    frame.push(b(t, h, 0.18, -w / 2 - t / 2, cy, -0.09), b(t, h, 0.18, w / 2 + t / 2, cy, -0.09));
    if (style === "sash") frame.push(b(w, 0.06, 0.08, 0, cy, -0.06), b(0.05, h, 0.08, 0, cy, -0.06));
    if (style === "shop") frame.push(b(w, 0.4, 0.12, 0, cy + h / 2 + 0.3, -0.07));
  }
  return { glass, frame };
}

/**
 * Rows of windows on all four faces of a w×d block (or only some faces).
 * floors: number of storeys; first window row starts at `base` (default 0).
 */
export function windows(o: {
  w: number; d: number; floors: number; floorHeight?: number; base?: number;
  faces?: ("front" | "back" | "left" | "right")[]; skipGround?: boolean;
} & FacadeOpts): THREE.Group {
  const fh = o.floorHeight ?? 3.2, style = o.style ?? "sash";
  const ww = o.width ?? (style === "slit" ? 0.35 : style === "shop" ? 2.6 : style === "gothic" ? 1.3 : 1.1);
  const wh = o.height ?? (style === "slit" ? fh * 0.5 : style === "shop" ? fh * 0.7 : fh * (style === "gothic" ? 0.7 : 0.55));
  const spacing = o.spacing ?? Math.max(ww * 2.1, ww + 0.8);
  const faces = o.faces ?? ["front", "back", "left", "right"];
  const glass: THREE.BufferGeometry[] = [], frame: THREE.BufferGeometry[] = [];
  for (const f of faces) {
    const len = f === "front" || f === "back" ? o.w : o.d;
    const n = Math.max(1, Math.floor((len - 0.6) / spacing));
    const start = -((n - 1) * spacing) / 2;
    for (let fl = o.skipGround ? 1 : 0; fl < o.floors; fl++) {
      const cy = (o.base ?? 0) + fl * fh + fh * 0.5;
      for (let i = 0; i < n; i++) {
        const parts = windowParts(style, ww, wh, cy);
        const m = new THREE.Matrix4();
        const x = start + i * spacing;
        if (f === "front") m.makeTranslation(x, 0, -o.d / 2);
        else if (f === "back") m.makeRotationY(Math.PI).premultiply(new THREE.Matrix4().makeTranslation(-x, 0, o.d / 2));
        // windows are built facing −Z; rotate them to face outwards on each side
        else if (f === "left") m.makeRotationY(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(-o.w / 2, 0, -x));
        else m.makeRotationY(-Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(o.w / 2, 0, x));
        for (const g of parts.glass) glass.push(g.applyMatrix4(m));
        for (const g of parts.frame) frame.push(g.applyMatrix4(m));
      }
    }
  }
  const out = group();
  const norm = (gs: THREE.BufferGeometry[]) => gs.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { g.deleteAttribute("uv"); return g; });
  if (glass.length) out.add(mesh(mergeGeometries(norm(glass))!, materials.glass(o.glass)));
  if (frame.length) out.add(mesh(mergeGeometries(norm(frame))!, materials.paint(o.frame ?? "#efe9dc")));
  return out;
}

/** A door on the front (-Z) face at offset x. */
export function door(x = 0, o: { w?: number; h?: number; color?: string; arched?: boolean; d: number }): THREE.Group {
  const w = o.w ?? 1.2, h = o.h ?? 2.4;
  const parts = windowParts(o.arched ? "arched" : "square", w, h, h / 2);
  for (const p of parts.glass) p.translate(0, 0, -0.08); // the door leaf sits in front of its frame
  const g = group(
    mesh(mergeGeometries(parts.glass.map((x) => x.toNonIndexed()))!, materials.paint(o.color ?? "#3b2b22")),
    mesh(mergeGeometries(parts.frame.map((x) => { const y = x.toNonIndexed(); y.deleteAttribute("uv"); return y; }))!, materials.paint("#e8e2d4")),
  );
  return at(g, x, 0, -o.d / 2);
}

// ---------------------------------------------------------------- whole blocks

export interface BlockOpts {
  w: number; d: number;
  floors: number; floorHeight?: number;
  wall?: THREE.Material;
  windows?: FacadeOpts | false;
  ground?: FacadeOpts;                 // different windows on the ground floor (e.g. { style: "shop" })
  roof?: "gabled" | "hipped" | "pyramid" | "mansard" | "flat" | "crenellated";
  roofHeight?: number;
  roofMaterial?: THREE.Material;
  parapet?: number;
  door?: boolean | { x?: number; arched?: boolean; color?: string };
  chimneys?: number;
  plinth?: boolean;                    // slightly wider base course
}

/** A complete rectangular building: walls, windows, door, roof, chimneys. The workhorse. */
export function block(o: BlockOpts): THREE.Group {
  const fh = o.floorHeight ?? 3.2, H = o.floors * fh, wall = o.wall ?? materials.render();
  const g = group(box(o.w, H, o.d, wall));
  if (o.plinth) g.add(box(o.w + 0.2, 0.6, o.d + 0.2, materials.stone(shadeHex(wall, -0.08))));
  // string course / cornice
  g.add(box(o.w + 0.25, 0.25, o.d + 0.25, wall, 0, H - 0.25, 0));
  if (o.windows !== false) {
    if (o.ground) g.add(windows({ w: o.w, d: o.d, floors: 1, floorHeight: fh, ...o.ground }));
    g.add(windows({ w: o.w, d: o.d, floors: o.floors, floorHeight: fh, skipGround: !!o.ground || !!o.door, ...(o.windows ?? {}) }));
    if (o.door && !o.ground) g.add(windows({ w: o.w, d: o.d, floors: 1, floorHeight: fh, faces: ["back", "left", "right"], ...(o.windows ?? {}) }));
  }
  if (o.door) { const dd = typeof o.door === "object" ? o.door : {}; g.add(door(dd.x ?? 0, { d: o.d, arched: dd.arched, color: dd.color })); }
  const r = o.roof ?? "gabled", rm = o.roofMaterial;
  if (r === "gabled") g.add(roof.gabled({ w: o.w, d: o.d, at: H, h: o.roofHeight, material: rm, gableMaterial: wall }));
  else if (r === "hipped") g.add(roof.hipped({ w: o.w, d: o.d, at: H, h: o.roofHeight, material: rm }));
  else if (r === "pyramid") g.add(roof.pyramid({ w: o.w, d: o.d, at: H, h: o.roofHeight, material: rm }));
  else if (r === "mansard") g.add(roof.mansard({ w: o.w, d: o.d, at: H, h: o.roofHeight, material: rm }));
  else if (r === "crenellated") { g.add(roof.flat({ w: o.w, d: o.d, at: H, material: rm })); g.add(crenellations(o.w, o.d, H, wall)); }
  else g.add(roof.flat({ w: o.w, d: o.d, at: H, material: rm, parapet: o.parapet ?? 0.9, wallMaterial: wall }));
  for (let i = 0; i < (o.chimneys ?? 0); i++) {
    const x = (i % 2 ? 1 : -1) * (o.w / 2 - 0.8);
    g.add(box(0.8, (o.roofHeight ?? Math.min(o.d * 0.45, 6)) + 1.4, 0.6, materials.brick(), x, H, (i > 1 ? 1 : -1) * o.d * 0.15));
  }
  return g;
}

function shadeHex(m: THREE.Material, l: number): string {
  const c = (m as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color("#cccccc");
  const map = (m as THREE.MeshStandardMaterial).map;
  if (map) { const name = m.name.split(" ")[1]; if (name) c.set(name); }
  return "#" + c.offsetHSL(0, 0, l).getHexString();
}

// ---------------------------------------------------------------- towers, spires, domes

export interface TowerOpts {
  w: number; h: number; d?: number; round?: boolean;
  wall?: THREE.Material;
  top?: "spire" | "pyramid" | "crenellated" | "dome" | "onion" | "cupola" | "flat";
  topHeight?: number; topMaterial?: THREE.Material;
  pinnacles?: boolean; windows?: FacadeOpts & { floors?: number };
  x?: number; z?: number; base?: number;
}

export function tower(o: TowerOpts): THREE.Group {
  const d = o.d ?? o.w, wall = o.wall ?? materials.stone(), y0 = o.base ?? 0;
  const g = group(o.round ? cylinder(o.w / 2, o.h, wall, { y: y0, segments: 20 }) : box(o.w, o.h, d, wall, 0, y0, 0));
  if (o.windows && !o.round) g.add(at(windows({ w: o.w, d, floors: o.windows.floors ?? Math.max(1, Math.round(o.h / 6)), floorHeight: o.h / (o.windows.floors ?? Math.max(1, Math.round(o.h / 6))), style: "gothic", ...o.windows }), 0, y0, 0));
  const top = o.top ?? "pyramid", th = o.topHeight, tm = o.topMaterial, H = y0 + o.h;
  if (top === "spire") g.add(cylinder(Math.min(o.w, d) * 0.45, th ?? o.h * 0.9, tm ?? wall, { y: H, segments: 8, rTop: 0.05 }));
  else if (top === "pyramid") g.add(o.round ? cylinder(o.w / 2 + 0.2, th ?? o.w, tm ?? materials.slate(), { y: H, segments: 20, rTop: 0.02 }) : roof.pyramid({ w: o.w, d, at: H, h: th, material: tm }));
  else if (top === "crenellated") g.add(crenellations(o.w, d, H, wall));
  else if (top === "dome" || top === "onion" || top === "cupola") g.add(at(dome({ r: Math.min(o.w, d) / 2, h: th, onion: top === "onion", lantern: top === "cupola", material: tm }), 0, H, 0));
  if (o.pinnacles && !o.round) g.add(pinnacles(o.w, d, H));
  return at(g, o.x ?? 0, 0, o.z ?? 0);
}

/** Dome (optionally onion-shaped, optionally with a lantern on top) sitting on y=0. */
export function dome(o: { r: number; h?: number; onion?: boolean; lantern?: boolean; drum?: number; material?: THREE.Material; drumMaterial?: THREE.Material }): THREE.Group {
  const h = o.h ?? o.r, m = o.material ?? materials.lead();
  const g = group();
  let y = 0;
  if (o.drum) { g.add(cylinder(o.r, o.drum, o.drumMaterial ?? materials.stone(), { segments: 24 })); y = o.drum; }
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const rr = o.onion ? o.r * Math.max(0.02, Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t * 0.7) + (t < 0.25 ? t * 0.6 : 0)) : o.r * Math.cos((t * Math.PI) / 2);
    pts.push(new THREE.Vector2(Math.max(0.01, rr), y + t * h * (o.onion ? 1.4 : 1)));
  }
  g.add(mesh(new THREE.LatheGeometry(pts, 28), m));
  const top = y + h * (o.onion ? 1.4 : 1);
  if (o.lantern) {
    g.add(cylinder(o.r * 0.18, o.r * 0.4, materials.stone(), { y: top - 0.1, segments: 8 }));
    g.add(cylinder(o.r * 0.22, o.r * 0.3, m, { y: top + o.r * 0.3, segments: 8, rTop: 0.02 }));
  } else g.add(cylinder(0.08, h * 0.15, materials.gold(), { y: top - 0.05, segments: 6, rTop: 0.01 }));
  return g;
}

/** Cloister-style row of arches along X (length `len`), facing -Z. */
export function arcade(len: number, h: number, o: { bays?: number; depth?: number; material?: THREE.Material } = {}): THREE.Group {
  const m = o.material ?? materials.stone(), bays = o.bays ?? Math.max(2, Math.round(len / 3)), bw = len / bays, d = o.depth ?? 0.6;
  const g = group(box(len, h * 0.25, d, m, 0, h * 0.75, 0));
  for (let i = 0; i <= bays; i++) g.add(box(bw * 0.18, h * 0.8, d, m, -len / 2 + i * bw, 0, 0));
  return g;
}

// ---------------------------------------------------------------- shapes from outlines and profiles
// (Promoted from helpers contributor agents wrote for Oxford landmarks.)

type P = [number, number];

/** Vertical prism from a plan outline [[x, z], …] (e.g. `params.footprint`), from y0 up to y1. Holes optional. */
export function prism(ring: P[], y0: number, y1: number, m: THREE.Material, holes: P[][] = []): THREE.Mesh {
  // any winding works: outer rings are made counter-clockwise and holes clockwise (in x, −z)
  const s = new THREE.Shape(ccw(openRing(ring)).map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) s.holes.push(new THREE.Path([...ccw(openRing(h))].reverse().map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
  return mesh(g, m);
}

/** Solid of revolution from a profile [[radius, y], …] (domes, drums, urns, finials, onion caps). */
export function lathe(profile: P[], m: THREE.Material, o: { x?: number; y?: number; z?: number; segments?: number } = {}): THREE.Mesh {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y)), o.segments ?? 24);
  g.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  return mesh(g, m);
}

/** Ogee (S-curved) cap profile, as on Tom Tower and many cupolas. Use with `lathe`. */
export function ogeeProfile(r: number, h: number, bulge = 0.12, steps = 12): P[] {
  const pts: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const rr = t < 0.55 ? r * (1 + bulge * Math.sin((t / 0.55) * Math.PI)) * (1 - 0.45 * Math.pow(t / 0.55, 2))
      : r * 0.55 * (1 - Math.pow((t - 0.55) / 0.45, 0.6)) + r * 0.04;
    pts.push([rr, t * h]);
  }
  return pts;
}

/** Regular n-sided prism (octagonal towers, turrets), flat sides aligned to the axes. */
export function ngon(n: number, r: number, h: number, m: THREE.Material, o: { x?: number; y?: number; z?: number; rTop?: number } = {}): THREE.Mesh {
  const g = new THREE.CylinderGeometry(o.rTop ?? r, r, h, n, 1);
  g.rotateY(Math.PI / n); g.translate(o.x ?? 0, (o.y ?? 0) + h / 2, o.z ?? 0);
  return mesh(g, m);
}

/** A flat shape drawn in elevation (x across, y up), extruded `t` thick, facing −Z: pediments, gables, parapets. */
export function elevation(outline: P[], t: number, m: THREE.Material, o: { x?: number; y?: number; z?: number; rotY?: number } = {}): THREE.Mesh {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([a, b]) => new THREE.Vector2(a, b))), { depth: t, bevelEnabled: false, curveSegments: 8 });
  g.translate(0, 0, -t / 2);
  const out = mesh(g, m);
  out.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  out.rotation.y = THREE.MathUtils.degToRad(o.rotY ?? 0);
  return out;
}

/** Classical column with base and capital (cap 0 = plain Tuscan, 1 = fuller Ionic/Corinthian capital). */
export function column(r: number, h: number, m: THREE.Material, o: { x?: number; y?: number; z?: number; cap?: number; segments?: number } = {}): THREE.Group {
  const x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0, cap = o.cap ?? 1, seg = o.segments ?? 12;
  return group(
    box(r * 2.6, r * 0.5, r * 2.6, m, x, y, z),
    cylinder(r * 1.15, r * 0.35, m, { x, y: y + r * 0.5, z, segments: seg }),
    cylinder(r * 0.85, h - r * (0.85 + 0.6 * cap), m, { x, y: y + r * 0.85, z, segments: seg, rTop: r * 0.75 }),
    cylinder(r * (0.95 + 0.25 * cap), r * 0.4 * cap + 0.05, m, { x, y: y + h - r * 0.6 * cap - 0.05, z, segments: seg, rTop: r * (1.05 + 0.35 * cap) }),
    box(r * (2.4 + 0.4 * cap), r * 0.25, r * (2.4 + 0.4 * cap), m, x, y + h - r * 0.25, z),
  );
}

/** Balustrade (rails, balusters, piers) along X, centred, facing −Z. */
export function balustrade(len: number, h: number, m: THREE.Material, o: { spacing?: number; pierEvery?: number } = {}): THREE.Group {
  const g = group(box(len, 0.18, 0.4, m), box(len, 0.14, 0.42, m, 0, h - 0.14, 0));
  const n = Math.max(1, Math.floor(len / (o.spacing ?? 0.32)));
  for (let i = 0; i < n; i++) g.add(cylinder(0.07, h - 0.32, m, { x: -len / 2 + (i + 0.5) * (len / n), y: 0.18, segments: 5, rTop: 0.1 }));
  const np = Math.max(2, Math.round(len / (o.pierEvery ?? 6)) + 1);
  for (let i = 0; i < np; i++) g.add(box(0.42, h, 0.44, m, -len / 2 + 0.21 + i * ((len - 0.42) / (np - 1)), 0, 0));
  return g;
}

/** Crocketed Gothic pinnacle: square shaft plus spirelet. */
export function pinnacle(s: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Group {
  return group(box(s, h * 0.45, s, m, x, y, z), box(s * 1.2, 0.15, s * 1.2, m, x, y + h * 0.45, z),
    cylinder(s * 0.55, h * 0.55, m, { x, y: y + h * 0.45 + 0.1, z, segments: 4, rTop: 0.02 }));
}

export type OpeningKind = "rect" | "arch" | "gothic" | "ogee" | "round";
function openingShape(w: number, h: number, kind: OpeningKind): THREE.Shape {
  const sh = new THREE.Shape(), r = w / 2;
  if (kind === "round") { sh.absarc(0, h / 2, r, 0, Math.PI * 2, false); return sh; }
  sh.moveTo(-r, 0); sh.lineTo(r, 0);
  if (kind === "rect") { sh.lineTo(r, h); sh.lineTo(-r, h); }
  else if (kind === "arch") { sh.lineTo(r, h - r); sh.absarc(0, h - r, r, 0, Math.PI, false); }
  else if (kind === "gothic") { const rise = w * 0.85; sh.lineTo(r, h - rise); sh.quadraticCurveTo(r, h - rise * 0.3, 0, h); sh.quadraticCurveTo(-r, h - rise * 0.3, -r, h - rise); }
  else { const rise = w * 0.9; sh.lineTo(r, h - rise); sh.quadraticCurveTo(r, h - rise * 0.5, r * 0.5, h - rise * 0.45); sh.quadraticCurveTo(0, h - rise * 0.3, 0, h); sh.quadraticCurveTo(0, h - rise * 0.3, -r * 0.5, h - rise * 0.45); sh.quadraticCurveTo(-r, h - rise * 0.5, -r, h - rise); }
  sh.lineTo(-r, 0);
  return sh;
}

/**
 * One window, door or niche facing −Z, bottom at y=0, centred on x=0: the opening (glass or door
 * colour) in front, an optional stone surround behind it, and optional mullions/transom.
 */
export function opening(w: number, h: number, kind: OpeningKind = "rect", o: { fill?: THREE.Material; surround?: THREE.Material; surroundWidth?: number; mullions?: number; depth?: number; sill?: boolean; hood?: boolean } = {}): THREE.Group {
  // The surround is a ring standing `depth` proud of the wall with the glass set back inside it,
  // so every window has a real reveal that catches shadow (the single biggest cue that a facade
  // is solid). Sills and hood moulds are optional extras on rectangular and arched openings.
  const fill = o.fill ?? materials.glass(), sw = o.surroundWidth ?? 0.22, depth = o.depth ?? 0.2;
  const g = group();
  const pane = new THREE.ExtrudeGeometry(openingShape(w, h, kind), { depth: 0.03, bevelEnabled: false, curveSegments: 8 });
  pane.translate(0, 0, -0.04); g.add(mesh(pane, fill));
  if (o.surround) {
    const outer = openingShape(w + 2 * sw, h + sw, kind);
    if (kind === "round") outer.holes.push(new THREE.Path(openingShape(w, h, kind).getPoints(16).map((p) => new THREE.Vector2(p.x, p.y + sw / 2))));
    else outer.holes.push(new THREE.Path(openingShape(w, h, kind).getPoints(8)));
    const s = new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: false, curveSegments: 8 });
    s.translate(0, kind === "round" ? -sw / 2 : 0, -depth); g.add(mesh(s, o.surround));
    const md = Math.min(0.12, depth * 0.6);
    for (let i = 1; i <= (o.mullions ?? 0); i++) g.add(box(0.12, h * (kind === "rect" ? 1 : 0.72), md, o.surround, -w / 2 + (i * w) / ((o.mullions ?? 0) + 1), 0, -0.04 - md / 2));
    if (o.mullions && kind === "rect" && h > 2.2) g.add(box(w, 0.12, md, o.surround, 0, h * 0.62, -0.04 - md / 2));
    if (o.sill ?? kind !== "round") g.add(box(w + 2 * sw + 0.2, 0.14, depth + 0.12, o.surround, 0, -0.14, -(depth + 0.12) / 2));
    if (o.hood && kind === "rect") g.add(box(w + 2 * sw + 0.3, 0.18, depth + 0.1, o.surround, 0, h + sw, -(depth + 0.1) / 2));
  }
  return g;
}

/** Place an object built facing −Z at (x, y, z) so its front faces the outward direction (nx, nz). */
export function face<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number, nx: number, nz: number): THREE.Group {
  const g = group(obj); g.position.set(x, y, z); g.rotation.y = Math.atan2(-nx, -nz); return g;
}

/** A wall from plan point p0 to p1 ([x, z]), `t` thick, from y0 up `h`. */
export function wall(p0: P, p1: P, y0: number, h: number, t: number, m: THREE.Material): THREE.Group {
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const g = group(box(Math.hypot(dx, dz), h, t, m));
  g.position.set((p0[0] + p1[0]) / 2, y0, (p0[1] + p1[1]) / 2);
  g.rotation.y = -Math.atan2(dz, dx);
  return g;
}

/** Outward normal of a ring edge: whichever side of the edge's midpoint is outside the outline. */
function edgeNormal(ring: P[], i: number): [number, number] {
  const a = ring[i], b = ring[(i + 1) % ring.length];
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  const n: [number, number] = [dz / L, -dx / L];
  const probe: P = [(a[0] + b[0]) / 2 + n[0] * 0.3, (a[1] + b[1]) / 2 + n[1] * 0.3];
  let inside = false;
  for (let p = 0, q = ring.length - 1; p < ring.length; q = p++) {
    const [xi, zi] = ring[p], [xj, zj] = ring[q];
    if ((zi > probe[1]) !== (zj > probe[1]) && probe[0] < ((xj - xi) * (probe[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside ? [-n[0], -n[1]] : n;
}

/** A row of openings along every edge of a plan outline (or along edge `edges`), `n` per 4 m by default. */
export function openingsAlong(ring: P[], y: number, w: number, h: number, kind: OpeningKind, o: { spacing?: number; minEdge?: number; edges?: number[]; fill?: THREE.Material; surround?: THREE.Material; mullions?: number } = {}): THREE.Group {
  const g = group();
  const pts = ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  for (let i = 0; i < pts.length; i++) {
    if (o.edges && !o.edges.includes(i)) continue;
    const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < (o.minEdge ?? Math.max(w * 1.6, 2))) continue;
    const n = Math.max(1, Math.floor(L / (o.spacing ?? Math.max(w * 2.2, 3))));
    const [nx, nz] = edgeNormal(pts, i);
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      g.add(face(opening(w, h, kind, o), a[0] + (b[0] - a[0]) * t + nx * 0.02, y, a[1] + (b[1] - a[1]) * t + nz * 0.02, nx, nz));
    }
  }
  return g;
}

/** Crenellated or plain parapet following a plan outline at height y. */
export function parapetAlong(ring: P[], y: number, m: THREE.Material, o: { height?: number; crenellated?: boolean } = {}): THREE.Group {
  const g = group();
  const pts = ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const h = o.height ?? 0.9;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    g.add(wall(a, b, y, h * (o.crenellated ? 0.6 : 1), 0.35, m));
    if (o.crenellated) for (let s = 0.6; s < L - 0.3; s += 1.2) {
      const t = s / L;
      g.add(wall([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], [a[0] + (b[0] - a[0]) * Math.min(1, (s + 0.6) / L), a[1] + (b[1] - a[1]) * Math.min(1, (s + 0.6) / L)], y + h * 0.6, h * 0.5, 0.35, m));
    }
  }
  return g;
}

/** Standing draped figure (robe, shoulders, head) for niches, rooflines and gateways; faces −Z. */
export function statue(h: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Group {
  // a robed silhouette: flared hem, waist, broad shoulders, neck; then head and folded arms
  const prof: P[] = ([[0.001, 0], [0.17, 0], [0.16, 0.08], [0.12, 0.45], [0.11, 0.55], [0.14, 0.7], [0.15, 0.76], [0.07, 0.8], [0.05, 0.83], [0.001, 0.83]] as P[]).map(([r, yy]) => [r * h, yy * h] as P);
  const body = lathe(prof, m, { segments: 10 });
  body.scale.set(1, 1, 0.72); // flatter front to back
  const head = new THREE.SphereGeometry(0.075 * h, 10, 8); head.scale(0.9, 1.1, 0.95); head.translate(0, 0.9 * h, 0);
  const fig = group(body, mesh(head, m), box(0.2 * h, 0.06 * h, 0.08 * h, m, 0, 0.55 * h, -0.08 * h));
  fig.position.set(x, y, z);
  return fig;
}

// ---------------------------------------------------------------- outlines: winding, offsets, edges, mouldings

const openRing = (ring: P[]): P[] => (ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);
/** Signed plan area in (x, −z): positive = counter-clockwise seen from above. */
const planArea = (r: P[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * -r[i][1] - r[i][0] * -r[j][1]; return a / 2; };
/** The same outline, counter-clockwise seen from above (the winding `prism` and `offset` expect). Edge i stays edge i only if it was already ccw. */
export function ccw(ring: P[]): P[] { const r = openRing(ring); return planArea(r) < 0 ? [...r].reverse() : r; }

/** Grow (d > 0) or shrink (d < 0) an outline by d metres, with mitred corners. Edge indices are kept. */
export function offset(ring: P[], d: number): P[] {
  const r = openRing(ring), sgn = planArea(r) < 0 ? -1 : 1, n = r.length;
  // outward normal of an edge (dx, dz) of a ring that is ccw seen from above is (−dz, dx)/L
  const N = (i: number): [number, number] => { const a = r[i], b = r[(i + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [(sgn * -dz) / L, (sgn * dx) / L]; };
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const n0 = N((i - 1 + n) % n), n1 = N(i);
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const cos = Math.max(0.35, mx * n1[0] + mz * n1[1]); // limit spikes at very sharp corners
    out.push([r[i][0] + (mx * d) / cos, r[i][1] + (mz * d) / cos]);
  }
  return out;
}

export interface EdgeInfo { i: number; a: P; b: P; length: number; /** compass bearing the edge faces (0 = north, 90 = east) */ bearing: number; nx: number; nz: number; mid: P }
/** Every edge of an outline with its length, outward normal and the compass direction it faces. */
export function edges(ring: P[]): EdgeInfo[] {
  const r = openRing(ring);
  return r.map((a, i) => {
    const b = r[(i + 1) % r.length], [nx, nz] = edgeNormal(r, i);
    return { i, a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]), bearing: (THREE.MathUtils.radToDeg(Math.atan2(nx, -nz)) + 360) % 360, nx, nz, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as P };
  });
}

/**
 * The longest edge facing a compass direction (± `tolerance` degrees): usually the street front.
 * Returns the edge plus `place(obj, u, y)`, which stands an object built facing −Z at `u` metres
 * along the edge (from its start), on the wall face, facing out.
 */
export function front(ring: P[], bearing: number, tolerance = 60) {
  const diff = (a: number) => Math.abs(((a - bearing + 540) % 360) - 180);
  const cands = edges(ring).filter((e) => diff(e.bearing) <= tolerance).sort((x, y) => y.length - x.length);
  const e = cands[0] ?? edges(ring).sort((x, y) => diff(x.bearing) - diff(y.bearing))[0];
  const ux = (e.b[0] - e.a[0]) / e.length, uz = (e.b[1] - e.a[1]) / e.length;
  return { ...e, ux, uz, place: <T extends THREE.Object3D>(obj: T, u: number, y = 0, out = 0) => face(obj, e.a[0] + ux * u + e.nx * out, y, e.a[1] + uz * u + e.nz * out, e.nx, e.nz) };
}

/** Call fn(x, z, t) at n evenly spaced points from p0 to p1 (centres of n equal bays). */
export function along<T>(p0: P, p1: P, n: number, fn: (x: number, z: number, t: number, i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; out.push(fn(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, t, i)); }
  return out;
}

/** A moulded cornice following the outline at height y: three stepped courses projecting `depth`. */
export function cornice(ring: P[], y: number, m: THREE.Material, o: { depth?: number; height?: number } = {}): THREE.Group {
  const d = o.depth ?? 0.45, h = o.height ?? 0.6;
  return group(
    prism(offset(ring, d * 0.3), y, y + h * 0.3, m),
    prism(offset(ring, d * 0.6), y + h * 0.3, y + h * 0.55, m),
    prism(offset(ring, d), y + h * 0.55, y + h, m),
  );
}

/** A plain projecting band (string course, sill band or plinth) following the outline. */
export function band(ring: P[], y: number, m: THREE.Material, o: { depth?: number; height?: number } = {}): THREE.Mesh {
  return prism(offset(ring, o.depth ?? 0.1), y, y + (o.height ?? 0.25), m);
}

/** Alternating long-and-short corner stones on every convex corner, from y0 to y1. */
export function quoins(ring: P[], y0: number, y1: number, m: THREE.Material, o: { size?: number; course?: number } = {}): THREE.Group {
  const r = openRing(ring), s = o.size ?? 0.5, c = o.course ?? 0.35, g = group(), sgn = planArea(r) < 0 ? -1 : 1;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], a = r[(i - 1 + r.length) % r.length], b = r[(i + 1) % r.length];
    const cross = (p[0] - a[0]) * -(b[1] - p[1]) - -(p[1] - a[1]) * (b[0] - p[0]);
    if (cross * sgn <= 0) continue; // concave corner
    const u1 = [(a[0] - p[0]), (a[1] - p[1])], u2 = [(b[0] - p[0]), (b[1] - p[1])];
    const l1 = Math.hypot(u1[0], u1[1]) || 1, l2 = Math.hypot(u2[0], u2[1]) || 1;
    let k = 0;
    for (let y = y0; y + c <= y1 + 1e-6; y += c, k++) {
      const len1 = k % 2 ? s : s * 1.6, len2 = k % 2 ? s * 1.6 : s;
      const q: P[] = [p, [p[0] + (u1[0] / l1) * len1, p[1] + (u1[1] / l1) * len1], [p[0] + (u1[0] / l1) * len1 + (u2[0] / l2) * 0.3, p[1] + (u1[1] / l1) * len1 + (u2[1] / l2) * 0.3], [p[0] + (u2[0] / l2) * 0.3, p[1] + (u2[1] / l2) * 0.3]];
      const q2: P[] = [p, [p[0] + (u2[0] / l2) * len2, p[1] + (u2[1] / l2) * len2], [p[0] + (u2[0] / l2) * len2 + (u1[0] / l1) * 0.3, p[1] + (u2[1] / l2) * len2 + (u1[1] / l1) * 0.3], [p[0] + (u1[0] / l1) * 0.3, p[1] + (u1[1] / l1) * 0.3]];
      g.add(prism(offset(q, 0.04), y + 0.02, y + c - 0.02, m), prism(offset(q2, 0.04), y + 0.02, y + c - 0.02, m));
    }
  }
  return g;
}

/** Everything agents can use, passed to the model script as `k`. */
export const kit = {
  THREE, materials, group, at, box, cylinder, roof, crenellations, pinnacles, windows, door, block, tower, dome, arcade,
  prism, lathe, ogeeProfile, ngon, elevation, column, balustrade, pinnacle, opening, face, wall, openingsAlong, parapetAlong, statue,
  ccw, offset, edges, front, along, cornice, band, quoins,
};
export type Kit = typeof kit;

/** Merge all meshes that share a material into one mesh each (fewer draw calls, smaller files). */
export function optimize(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    const tm = m.material as THREE.MeshStandardMaterial;
    // raw THREE meshes with a kit texture get world-scale UVs too, so the texture tiles properly
    if (tm.map && !m.userData.kitUV) g = worldUV(g, tm.userData.metres ?? 2);
    if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    byMat.set(m.material, [...(byMat.get(m.material) ?? []), g]);
  });
  const out = new THREE.Group();
  for (const [mat, gs] of byMat) {
    const merged = mergeGeometries(gs);
    if (!merged) continue;
    const mm = new THREE.Mesh(mergeVertices(merged, 1e-4), mat);
    mm.castShadow = mm.receiveShadow = true;
    out.add(mm);
  }
  return out;
}

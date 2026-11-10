// Turn resolved buildings (style specs) into batched three.js meshes.
import * as THREE from "three";
import type { ResolvedBuilding, ResolvedVolume, LL } from "@seeearth/core";
import { facadeMaterial, flatMaterial, groundFloorMaterial } from "./textures";
import type { Projector } from "./geo";

type V2 = [number, number]; // (east, north) metres

/** Geometry bucket per material; remembers which building owns each triangle (for picking). */
export class Buckets {
  private map = new Map<THREE.Material, { pos: number[]; nrm: number[]; uv: number[]; owners: string[] }>();
  get(m: THREE.Material) {
    let b = this.map.get(m);
    if (!b) { b = { pos: [], nrm: [], uv: [], owners: [] }; this.map.set(m, b); }
    return b;
  }
  tri(m: THREE.Material, owner: string, a: number[], b: number[], c: number[], n: number[] | null, uva = [0, 0], uvb = [0, 0], uvc = [0, 0]) {
    const k = this.get(m);
    let nn = n;
    if (!nn) {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      nn = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const l = Math.hypot(nn[0], nn[1], nn[2]) || 1; nn = [nn[0] / l, nn[1] / l, nn[2] / l];
    }
    k.pos.push(...a, ...b, ...c);
    k.nrm.push(...nn, ...nn, ...nn);
    k.uv.push(...uva, ...uvb, ...uvc);
    k.owners.push(owner);
  }
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [m, b] of this.map) {
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.owners = b.owners;
      out.push(mesh);
    }
    return out;
  }
}

const signedArea = (r: V2[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };
function clean(r: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of r) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p); }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.05) out.pop();
  return out;
}
const ccw = (r: V2[]) => (signedArea(r) < 0 ? [...r].reverse() : r);
const cw = (r: V2[]) => (signedArea(r) > 0 ? [...r].reverse() : r);
// three: x = east, y = up, z = -north
const P = (p: V2, y: number) => [p[0], y, -p[1]];

/** Minimum-area oriented rectangle: returns centre, axis (unit, along long side), half-length, half-width. */
function orientedRect(r: V2[], forcedDir?: number) {
  const dirs: number[] = [];
  if (forcedDir != null) dirs.push((90 - forcedDir) * (Math.PI / 180)); // compass → math angle
  else for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; dirs.push(Math.atan2(b[1] - a[1], b[0] - a[0])); }
  let best = { area: Infinity, c: [0, 0] as V2, ax: [1, 0] as V2, hl: 0, hw: 0 };
  for (const t of dirs) {
    const ux = Math.cos(t), uy = Math.sin(t);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of r) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      let ax: V2 = [ux, uy], hl = (maxU - minU) / 2, hw = (maxV - minV) / 2;
      if (forcedDir == null && hw > hl) { ax = [-uy, ux]; [hl, hw] = [hw, hl]; }
      best = { area, c: [cu * ux - cv * uy, cu * uy + cv * ux], ax, hl, hw };
    }
  }
  return best;
}

export interface BuildContext { proj: Projector; renderer: THREE.WebGLRenderer }

function wallMaterials(v: ResolvedVolume, ctx: BuildContext) {
  const f = v.facade;
  const pattern = f.windows?.pattern ?? (f.material === "glass" ? "curtain" : v.height < 4 && v.floors <= 1 ? "sparse" : "grid");
  return facadeMaterial({
    material: f.material, color: f.color, pattern, trim: f.trim,
    windowColor: f.windows?.color ?? (pattern === "curtain" ? "#5d7d93" : "#3e4c58"),
    density: f.windows?.density ?? 0.5,
  }, ctx.renderer);
}

function addVolume(B: Buckets, owner: string, v: ResolvedVolume, ctx: BuildContext) {
  const wallMat = wallMaterials(v, ctx);
  const bay = v.facade.windows?.bay ?? 3.2;
  const gf = v.groundFloor?.kind && v.minHeight < 0.5 ? v.groundFloor : undefined;
  const gfH = gf ? Math.min(gf.height ?? 4.2, v.height * 0.6) : 0;
  const gfMat = gf ? groundFloorMaterial(gf.kind!, gf.color ?? v.facade.color, ctx.renderer) : null;
  const roofMat = flatMaterial(v.roof.color, { side: THREE.DoubleSide });

  for (const poly of v.polygons) {
    const outer = ccw(clean(poly.outer.map((p) => ctx.proj.en(p))));
    if (outer.length < 3) continue;
    const holes = poly.holes.map((h) => cw(clean(h.map((p) => ctx.proj.en(p))))).filter((h) => h.length >= 3);
    const rect = orientedRect(outer, v.roof.direction);
    const fill = Math.abs(signedArea(outer)) / Math.max(1e-6, 4 * rect.hl * rect.hw);
    let shape = v.roof.shape;
    const rectish = fill > 0.82 && holes.length === 0;
    if ((shape === "gabled" || shape === "hipped") && !rectish) shape = fill > 0.6 && holes.length === 0 ? "pyramidal" : "flat";
    if (shape === "pyramidal" && holes.length) shape = "flat";
    const rh = v.roof.height ?? (shape === "gabled" || shape === "hipped" ? Math.min(rect.hw * 0.7, 6) : shape === "pyramidal" ? Math.min(rect.hw, 8) : shape === "skillion" ? Math.min(rect.hw * 0.4, 3) : shape === "dome" || shape === "onion" ? rect.hw * 0.95 : 0);
    const top = v.height;
    let topAt = (_p: V2) => top;
    if (shape === "skillion") {
      const d = ((v.roof.direction ?? 0) * Math.PI) / 180; const dx = Math.sin(d), dy = Math.cos(d);
      const vals = outer.map((p) => p[0] * dx + p[1] * dy); const lo = Math.min(...vals), hi = Math.max(...vals);
      topAt = (p) => top + rh * (1 - (p[0] * dx + p[1] * dy - lo) / Math.max(1e-6, hi - lo));
    }

    // walls
    for (const ring of [outer, ...holes]) {
      let run = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.01) continue;
        const n = [(b[1] - a[1]) / len, 0, (b[0] - a[0]) / len]; // outward for ccw outer / cw holes
        const u0 = run / bay, u1 = (run + len) / bay; run += len;
        const quad = (m: THREE.Material, y0: number, y1a: number, y1b: number, v0: number, v1a: number, v1b: number) => {
          B.tri(m, owner, P(a, y0), P(b, y0), P(b, y1b), n, [u0, v0], [u1, v0], [u1, v1b]);
          B.tri(m, owner, P(a, y0), P(b, y1b), P(a, y1a), n, [u0, v0], [u1, v1b], [u0, v1a]);
        };
        const base = v.minHeight;
        const wallStart = gf ? base + gfH : base;
        if (gf && gfMat) quad(gfMat, base, base + gfH, base + gfH, 0, 1, 1);
        const ta = topAt(a), tb = topAt(b);
        const fh = v.floorHeight;
        if (ta > wallStart + 0.01 || tb > wallStart + 0.01) quad(wallMat, wallStart, ta, tb, 0, (ta - wallStart) / fh, (tb - wallStart) / fh);
      }
    }

    // roof
    let roofMatOverride: THREE.Material | null = null;
    const roofFlat = (y: (p: V2) => number) => {
      const tris = THREE.ShapeUtils.triangulateShape(outer.map((p) => new THREE.Vector2(p[0], p[1])), holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1]))));
      const all = [...outer, ...holes.flat()];
      for (const [i, j, k] of tris) {
        let [a, b, c] = [all[i], all[j], all[k]];
        if (signedArea([a, b, c]) < 0) [b, c] = [c, b];
        B.tri(roofMatOverride ?? roofMat, owner, P(a, y(a)), P(b, y(b)), P(c, y(c)), null, [a[0] / 4, a[1] / 4], [b[0] / 4, b[1] / 4], [c[0] / 4, c[1] / 4]);
      }
    };

    if (shape === "flat" || shape === "none" || rh <= 0.05) { roofFlat(() => top); continue; }
    if (shape === "skillion") { roofFlat(topAt); continue; }
    if (shape === "pyramidal") {
      const c: V2 = [outer.reduce((s, p) => s + p[0], 0) / outer.length, outer.reduce((s, p) => s + p[1], 0) / outer.length];
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i], b = outer[(i + 1) % outer.length];
        B.tri(roofMat, owner, P(a, top), P(b, top), P(c, top + rh), null);
      }
      continue;
    }
    if (shape === "gabled" || shape === "hipped") {
      const { c, ax, hl, hw } = rect;
      const pv: V2 = [-ax[1], ax[0]];
      const at = (u: number, v: number): V2 => [c[0] + ax[0] * u + pv[0] * v, c[1] + ax[1] * u + pv[1] * v];
      const ridge = shape === "hipped" ? Math.max(0, hl - hw) : hl;
      const r0 = at(-ridge, 0), r1 = at(ridge, 0);
      const A = at(-hl, -hw), Bc = at(hl, -hw), Cc = at(hl, hw), D = at(-hl, hw);
      // two long slopes
      B.tri(roofMat, owner, P(A, top), P(Bc, top), P(r1, top + rh), null);
      B.tri(roofMat, owner, P(A, top), P(r1, top + rh), P(r0, top + rh), null);
      B.tri(roofMat, owner, P(Cc, top), P(D, top), P(r0, top + rh), null);
      B.tri(roofMat, owner, P(Cc, top), P(r0, top + rh), P(r1, top + rh), null);
      // ends: vertical gables (wall material) or hips (roof material)
      const endMat = shape === "gabled" ? wallMat : roofMat;
      B.tri(endMat, owner, P(Bc, top), P(Cc, top), P(r1, top + rh), null, [0, 0], [hw * 2 / bay, 0], [hw / bay, rh / v.floorHeight]);
      B.tri(endMat, owner, P(D, top), P(A, top), P(r0, top + rh), null, [0, 0], [hw * 2 / bay, 0], [hw / bay, rh / v.floorHeight]);
      // cap any footprint area the rectangle misses
      roofFlat(() => top - 0.02);
      continue;
    }
    if (shape === "dome" || shape === "onion") {
      // the deck around a dome takes the wall trim colour, not the dome colour
      const deckCol = new THREE.Color(v.facade.trim ?? v.facade.color).offsetHSL(0, 0, -0.06);
      const deck = flatMaterial("#" + deckCol.getHexString(), { side: THREE.DoubleSide });
      roofMatOverride = deck; roofFlat(() => top); roofMatOverride = null;
      const r = rect.hw * 0.95;
      const geo = shape === "dome"
        ? new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
        : new THREE.LatheGeometry(Array.from({ length: 16 }, (_, i) => { const t = i / 15; const w = Math.sin(Math.PI * Math.min(1, t * 1.25)) * (1 - t * 0.85) + (t < 0.15 ? t * 2 : 0); return new THREE.Vector2(Math.max(0.001, r * Math.max(w, i === 15 ? 0 : 0.02)), t * rh * 1.4); }), 24);
      if (shape === "dome") geo.scale(1, rh / r, 1);
      geo.translate(rect.c[0], top, -rect.c[1]);
      const pos = geo.toNonIndexed().getAttribute("position");
      for (let i = 0; i < pos.count; i += 3) {
        B.tri(roofMat, owner, [pos.getX(i), pos.getY(i), pos.getZ(i)], [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)], [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)], null);
      }
      continue;
    }
    roofFlat(() => top);
  }
}

export function buildBuildings(buildings: ResolvedBuilding[], ctx: BuildContext, opts: { dim?: (b: ResolvedBuilding) => boolean } = {}): Buckets {
  const B = new Buckets();
  const ghost = flatMaterial("#e6e6e6", { transparent: true, opacity: 0.12, depthWrite: false });
  for (const b of buildings) {
    if (b.hidden) continue;
    if (b.asset || b.model) continue; // replaced by a real 3D model
    if (opts.dim?.(b)) { for (const v of b.volumes) addGhost(B, b.id, v, ctx, ghost); continue; }
    for (const v of b.volumes) addVolume(B, b.id, v, ctx);
  }
  return B;
}

/** Plain translucent box, used to fade out buildings in highlight renders. */
function addGhost(B: Buckets, owner: string, v: ResolvedVolume, ctx: BuildContext, m: THREE.Material) {
  for (const poly of v.polygons) {
    const outer = ccw(clean(poly.outer.map((p) => ctx.proj.en(p))));
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], b = outer[(i + 1) % outer.length];
      B.tri(m, owner, P(a, v.minHeight), P(b, v.minHeight), P(b, v.height), null);
      B.tri(m, owner, P(a, v.minHeight), P(b, v.height), P(a, v.height), null);
    }
  }
}

export function centroidOf(r: LL[]): LL {
  let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length];
}

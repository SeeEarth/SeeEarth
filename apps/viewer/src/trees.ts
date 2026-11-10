// Trees: OSM's individual trees and tree rows, plus deterministic scatter in parks and woods.
// Drawn as instanced low-poly trees (two shapes), so thousands cost a few draw calls.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { hashString, type BaseTile, type Polygon, type ResolvedGround } from "@seeearth/core";
import type { Projector } from "./geo";

type P2 = [number, number];

const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 6).translate(0, 0.5, 0);
/** A clumpy broadleaf crown: several lumpy blobs merged, unit radius. */
const broadGeo = (() => {
  const blobs: THREE.BufferGeometry[] = [];
  const spots: [number, number, number, number][] = [[0, 0.05, 0, 0.78], [0.45, -0.1, 0.2, 0.55], [-0.4, -0.05, 0.3, 0.55], [0.1, -0.1, -0.48, 0.55], [-0.2, 0.42, -0.1, 0.5], [0.3, 0.35, 0.25, 0.45]];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [x, y, z, r] of spots) {
    const g = new THREE.IcosahedronGeometry(r, 2);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const k = 1 + (rnd() - 0.5) * 0.22;
      p.setXYZ(i, p.getX(i) * k + x, p.getY(i) * k * 0.9 + y, p.getZ(i) * k + z);
    }
    blobs.push(g);
  }
  // smooth normals: weld each blob's seams, then merge
  const merged = mergeGeometries(blobs.map((b) => { b.deleteAttribute("uv"); b.deleteAttribute("normal"); const w = mergeVertices(b); w.computeVertexNormals(); return w; }))!;
  // darker inside and underneath: fake self-shadowing baked into vertex colours
  const p = merged.getAttribute("position"), col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
    const v = THREE.MathUtils.clamp(0.55 + 0.35 * r + 0.25 * p.getY(i), 0.45, 1.15);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
  }
  merged.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return merged;
})();
const coniferGeo = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 });
const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true });
const coneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function inPoly(p: P2, ring: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface TreeSpot { x: number; z: number; h: number; conifer: boolean; tint: number }

export function buildTrees(base: BaseTile, proj: Projector, ground: ResolvedGround[] = []): THREE.Object3D[] {
  // no scattered trees on contributors' paved/gravel/water patches or on OSM's paved areas
  const bare = [...ground.filter((g) => !["grass", "garden"].includes(g.surface)).map((g) => g.area),
    ...base.areas.filter((a) => a.kind === "paved" || a.kind === "water" || a.tags.leisure === "pitch").flatMap((a) => a.polygons.map((p) => p.outer))]
    .map((r) => r.map((q) => proj.xz(q as [number, number])));
  const spots: TreeSpot[] = [];
  const r = rng(hashString(base.tile));
  const add = (x: number, z: number, conifer = false, h = 7 + r() * 7) => spots.push({ x, z, h, conifer, tint: r() });
  // tile bounds in local metres (scatter only inside this tile, so neighbours don't double up)
  const [w, s, e, n] = base.bbox;
  const [x0, z1] = proj.xz([w, s]), [x1, z0] = proj.xz([e, n]);
  const inside = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;

  for (const t of base.trees ?? []) { const [x, z] = proj.xz(t); add(x, z); }
  for (const row of base.treeRows ?? []) {
    const pts = row.line.map((p) => proj.xz(p));
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], len = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d < len; d += 9) { const x = ax + ((bx - ax) * d) / len, z = az + ((bz - az) * d) / len; if (inside(x, z)) add(x, z); }
    }
  }
  // Parks get scattered trees (sparser on open grass), woods get dense mixed forest.
  const buildingRings = base.buildings.flatMap((b) => b.polygons.map((p) => p.outer.map((q) => proj.xz(q))));
  // residential land includes its streets: keep garden trees off roads (5 m grid of road cells)
  const roadCells = new Set<string>();
  const cell = (x: number, z: number) => `${Math.floor(x / 5)},${Math.floor(z / 5)}`;
  for (const rd of base.roads) {
    const pts = rd.line.map((q) => proj.xz(q));
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], len = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d <= len; d += 2.5) {
        const x = ax + ((bx - ax) * d) / Math.max(len, 1e-6), z = az + ((bz - az) * d) / Math.max(len, 1e-6);
        for (let ox = -5; ox <= 5; ox += 5) for (let oz = -5; oz <= 5; oz += 5) roadCells.add(cell(x + ox, z + oz));
      }
    }
  }
  for (const a of base.areas) {
    if (a.kind !== "green" && a.kind !== "forest" && a.kind !== "yard") continue;
    const sport = a.tags.leisure === "pitch" || a.tags.leisure === "golf_course" || a.tags.landuse === "farmland";
    if (sport) continue;
    const spacing = a.kind === "forest" ? 7 : a.kind === "yard" ? 18 : a.tags.leisure === "park" || a.tags.leisure === "garden" ? 22 : 35;
    for (const poly of a.polygons as Polygon[]) {
      const ring = poly.outer.map((q) => proj.xz(q));
      const holes = poly.holes.map((h) => h.map((q) => proj.xz(q)));
      let mx = Infinity, Mx = -Infinity, mz = Infinity, Mz = -Infinity;
      for (const [x, z] of ring) { mx = Math.min(mx, x); Mx = Math.max(Mx, x); mz = Math.min(mz, z); Mz = Math.max(Mz, z); }
      mx = Math.max(mx, x0); Mx = Math.min(Mx, x1); mz = Math.max(mz, z0); Mz = Math.min(Mz, z1);
      for (let x = mx; x < Mx; x += spacing) for (let z = mz; z < Mz; z += spacing) {
        const px = x + (r() - 0.5) * spacing * 0.9, pz = z + (r() - 0.5) * spacing * 0.9;
        if (!inside(px, pz) || !inPoly([px, pz], ring) || holes.some((h) => inPoly([px, pz], h))) continue;
        if (buildingRings.some((b) => inPoly([px, pz], b))) continue;
        if (a.kind !== "forest" && r() < (a.kind === "yard" ? 0.55 : 0.35)) continue; // leave clearings in parks
        if (a.kind === "yard" && roadCells.has(cell(px, pz))) continue;
        if (bare.some((r) => inPoly([px, pz], r))) continue;
        add(px, pz, a.kind === "forest" && r() < 0.35);
      }
      if (spots.length > 4000) break;
    }
  }
  if (!spots.length) return [];

  const count = spots.length;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const broad = spots.filter((t) => !t.conifer), conif = spots.filter((t) => t.conifer);
  const crowns = new THREE.InstancedMesh(broadGeo, leafMat, Math.max(1, broad.length));
  const cones = new THREE.InstancedMesh(coniferGeo, coneMat, Math.max(1, conif.length));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const green = (t: number, conifer: boolean) => new THREE.Color().setHSL(conifer ? 0.36 : 0.22 + t * 0.08, 0.38 + t * 0.15, conifer ? 0.2 : 0.26 + t * 0.08);
  spots.forEach((t, i) => {
    m.compose(pos.set(t.x, 0, t.z), q.identity(), sc.set(1, t.h * 0.35, 1));
    trunks.setMatrixAt(i, m);
  });
  broad.forEach((t, i) => {
    const rad = t.h * 0.32;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.tint * 6.28);
    const squash = 0.8 + ((t.tint * 997) % 1) * 0.35;
    m.compose(pos.set(t.x, t.h * 0.62, t.z), q, sc.set(rad, rad * squash, rad));
    crowns.setMatrixAt(i, m); crowns.setColorAt(i, green(t.tint, false));
  });
  conif.forEach((t, i) => {
    m.compose(pos.set(t.x, t.h * 0.2, t.z), q.identity(), sc.set(t.h * 0.22, t.h * 0.85, t.h * 0.22));
    cones.setMatrixAt(i, m); cones.setColorAt(i, green(t.tint, true));
  });
  const out = [trunks, crowns, cones].filter((x) => x.count > 0 && (x !== crowns || broad.length) && (x !== cones || conif.length));
  for (const o of out) { o.castShadow = true; o.receiveShadow = true; o.computeBoundingSphere(); }
  return out;
}

// Flat ground features: roads, rails, water, parks.
//
// Roads are drawn the way map renderers do it: every line is a chain of straight segments with
// a round disc at each vertex (round joins and caps), so bends and junctions of any shape blend
// cleanly without miter spikes. Vehicle roads get a lighter "casing" underneath (kerb and
// pavement), and major roads a dashed centre line. Layers are painted in a fixed order without
// depth writes, so nothing z-fights; buildings still occlude them through the depth test.
import * as THREE from "three";
import type { BaseArea, BaseLine } from "@seeearth/core";
import type { Projector } from "./geo";
import { flatMaterial } from "./textures";

type P2 = [number, number];

interface RoadStyle { width: number; color: string; casing?: string; centre?: boolean; order: number }

const FOOT = { color: "#c9bfa9", order: 6 };
const ROADS: Record<string, Omit<RoadStyle, "order"> & { order?: number }> = {
  motorway: { width: 16, color: "#62656a", casing: "#bdb6a8", centre: true },
  trunk: { width: 14, color: "#64676c", casing: "#c4bdb0", centre: true },
  primary: { width: 12, color: "#686b70", casing: "#c9c2b5", centre: true },
  secondary: { width: 10, color: "#6c6f74", casing: "#ccc5b8", centre: true },
  tertiary: { width: 8.5, color: "#707378", casing: "#cfc8bb" },
  unclassified: { width: 6.5, color: "#74777b", casing: "#d1cabd" },
  residential: { width: 6.5, color: "#74777b", casing: "#d1cabd" },
  living_street: { width: 5.5, color: "#7a7d80", casing: "#d3ccbf" },
  busway: { width: 7, color: "#6e6464" },
  service: { width: 4, color: "#7d8084" },
  track: { width: 3, color: "#a99c80", order: 6 },
  pedestrian: { width: 6, color: "#cdc5b6", order: 6 },
  footway: { width: 2.2, ...FOOT },
  path: { width: 1.8, ...FOOT, color: "#bfb294" },
  steps: { width: 2.2, ...FOOT, color: "#b9b0a0" },
  cycleway: { width: 2.2, color: "#a9aeb0", order: 6 },
  bridleway: { width: 2, ...FOOT, color: "#b5a98c" },
};
const LINK = /^(motorway|trunk|primary|secondary|tertiary)_link$/;
const SKIP = new Set(["construction", "proposed", "platform", "corridor", "elevator", "raceway", "abandoned", "razed"]);

function roadStyle(t: Record<string, string>): RoadStyle | null {
  const h = t.highway;
  if (!h || SKIP.has(h)) return null;
  const linkOf = LINK.exec(h)?.[1];
  const base = ROADS[linkOf ?? h] ?? ROADS.service;
  let width = Number.parseFloat(t.width) || (Number(t.lanes) ? Number(t.lanes) * 3.3 : base.width);
  if (linkOf) width = Math.min(width, 7);
  return { ...base, width: Math.min(Math.max(width, 1.2), 40), centre: !linkOf && base.centre, order: base.order ?? 8 };
}

const AREA_COLOR = { water: "#6a98b5", green: "#8fae74", forest: "#6f8f58", sand: "#dccb9c", paved: "#c6bfb1" } as const;
const AREA_ORDER = { paved: 1, sand: 2, green: 3, forest: 4, water: 5 } as const;

class Layers {
  private m = new Map<string, { pos: number[]; order: number }>();
  add(color: string, order: number) {
    const k = `${order}|${color}`;
    let l = this.m.get(k);
    if (!l) { l = { pos: [], order }; this.m.set(k, l); }
    return l.pos;
  }
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [k, l] of this.m) {
      if (!l.pos.length) continue;
      const color = k.split("|")[1];
      // Make every triangle face up, so lighting is right whatever order its points came in.
      const p = l.pos;
      for (let i = 0; i < p.length; i += 9) {
        const cross = (p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) - (p[i + 5] - p[i + 2]) * (p[i + 6] - p[i]);
        if (cross > 0) for (let j = 0; j < 3; j++) { const t = p[i + 3 + j]; p[i + 3 + j] = p[i + 6 + j]; p[i + 6 + j] = t; }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(l.pos, 3));
      const n = new Float32Array(l.pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1;
      g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
      g.computeBoundingSphere();
      const water = color === AREA_COLOR.water;
      const mesh = new THREE.Mesh(g, flatMaterial(color, { depthWrite: false, roughness: water ? 0.25 : 0.95, metalness: water ? 0.1 : 0 }));
      mesh.renderOrder = l.order;
      mesh.receiveShadow = true;
      out.push(mesh);
    }
    return out;
  }
}

/** Straight segments plus a disc at every vertex: round joins and caps for any polyline. */
function strokeRound(pts: P2[], width: number, y: number, pos: number[]) {
  const h = width / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const nx = (-dz / len) * h, nz = (dx / len) * h;
    pos.push(ax + nx, y, az + nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz, ax + nx, y, az + nz, bx - nx, y, bz - nz, ax - nx, y, az - nz);
  }
  const seg = width > 8 ? 14 : 10;
  for (const [cx, cz] of pts) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      pos.push(cx, y, cz, cx + Math.cos(a0) * h, y, cz + Math.sin(a0) * h, cx + Math.cos(a1) * h, y, cz + Math.sin(a1) * h);
    }
  }
}

/** Dashed centre line (3 m dash, 6 m gap). */
function dashes(pts: P2[], y: number, pos: number[]) {
  const dash = 3, gap = 6, h = 0.12;
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len, nx = -uz * h, nz = ux * h;
    for (let s = carry; s < len; s += dash + gap) {
      const e = Math.min(len, s + dash);
      const p0x = ax + ux * s, p0z = az + uz * s, p1x = ax + ux * e, p1z = az + uz * e;
      pos.push(p0x + nx, y, p0z + nz, p1x + nx, y, p1z + nz, p1x - nx, y, p1z - nz, p0x + nx, y, p0z + nz, p1x - nx, y, p1z - nz, p0x - nx, y, p0z - nz);
    }
    carry = ((carry - len) % (dash + gap) + dash + gap) % (dash + gap);
  }
}

const bridgeLift = (t: Record<string, string>) => (t.bridge && t.bridge !== "no" ? 6 * Math.max(1, Number(t.layer) || 1) : 0);

/**
 * Build the flat layers for one tile. Features crossing tile edges are drawn by every tile
 * they touch (identical, overlapping pixels), so unloading a neighbour never leaves gaps.
 */
export function buildGround(roads: BaseLine[], rails: BaseLine[], areas: BaseArea[], proj: Projector): THREE.Object3D[] {
  const L = new Layers();

  for (const a of areas) {
    for (const poly of a.polygons) {
      const outer = poly.outer.slice(0, -1).map((p) => proj.xz(p));
      if (outer.length < 3) continue;
      const holes = poly.holes.map((h) => h.slice(0, -1).map((p) => proj.xz(p)));
      const tris = THREE.ShapeUtils.triangulateShape(outer.map(([x, z]) => new THREE.Vector2(x, z)), holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z))));
      const all = [...outer, ...holes.flat()];
      const pos = L.add(AREA_COLOR[a.kind], AREA_ORDER[a.kind]);
      for (const [i, j, k] of tris) pos.push(all[i][0], 0, all[i][1], all[j][0], 0, all[j][1], all[k][0], 0, all[k][1]);
    }
  }

  for (const r of roads) {
    const t = r.tags;
    if (t.tunnel && t.tunnel !== "no") continue;
    const st = roadStyle(t);
    if (!st) continue;
    const pts = r.line.map((p) => proj.xz(p));
    const y = bridgeLift(t);
    if (st.casing) strokeRound(pts, st.width + 3, y, L.add(st.casing, 7));
    strokeRound(pts, st.width, y, L.add(st.color, st.order + (st.casing ? 1 : 0)));
    if (st.centre && (Number(t.lanes) || 2) >= 2 && t.oneway !== "yes") dashes(pts, y, L.add("#e9e6dc", 10));
  }

  for (const r of rails) {
    if (r.tags.tunnel && r.tags.tunnel !== "no") continue;
    const pts = r.line.map((p) => proj.xz(p));
    const y = bridgeLift(r.tags);
    strokeRound(pts, 3.2, y, L.add("#8d8378", 6));
    strokeRound(pts, 1.6, y, L.add("#5b534c", 7));
  }

  return L.meshes();
}

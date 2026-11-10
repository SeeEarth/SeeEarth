// Ground infill: guess the surface of unmapped open ground from the patches people HAVE drawn.
//
// Every open space in a tile is classified by its setting:
//   court  – enclosed by buildings, no street frontage (college quads, courtyards)
//   front  – within 12 m of a street (forecourts, front gardens, the strip by the pavement)
//   back   – behind the street front, near buildings (back gardens, rear yards)
//   open   – more than 30 m from any building (playing fields, open land)
// Contributors' ground patches and OSM's small mapped lawns/paved areas are evidence: "around
// here, courts are lawns and fronts are paved". Each unmapped region takes the surface that
// nearby evidence of the same class agrees on (distance-weighted vote). Regions that already
// hold a patch are left alone: someone looked at them, and what they left blank is deliberate.
//
// Analysis is per tile (a 1.5 m grid), evidence is pooled across loaded tiles by World, so a
// patch drawn in one tile fills matching spaces in its neighbours too.
import * as THREE from "three";
import type { BaseTile, LL, Polygon, ResolvedBuilding, ResolvedGround } from "@seeearth/core";
import type { Projector } from "./geo";
import { Layers, SURFACE_STYLE } from "./ground";

type P2 = [number, number];
export type InfillClass = "court" | "front" | "back" | "open";
const CLASSES: InfillClass[] = ["court", "front", "back", "open"];

export interface Evidence { x: number; z: number; cls: InfillClass; surface: string; weight: number }
interface Region { cls: InfillClass; cx: number; cz: number; area: number; cells: number[]; yard: Uint8Array; looked: boolean }
export interface InfillAnalysis { cell: number; x0: number; z0: number; nx: number; nz: number; regions: Region[]; evidence: Evidence[] }

const CELL = 1.5;
const COURT_MAX_M2 = 8000;
const FRONT_M = 12;
const OPEN_M = 30;
/** Evidence further than this from a region is ignored; weight halves at HALF_M... roughly. */
const REACH_M = 800;
const HALF_M = 200;
/** OSM areas bigger than this are parks/fields, not evidence about yards and courts. */
const OSM_EVIDENCE_MAX_M2 = 20000;
/** Surfaces worth propagating (beds, water and sand are too specific to guess). */
const SPREAD = new Set(["grass", "garden", "paving", "cobbles", "asphalt", "gravel"]);

const STREETS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|busway|pedestrian)(_link)?$/;
const STREET_WIDTH: Record<string, number> = { motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8.5, pedestrian: 6, living_street: 5.5 };

/** Even-odd scanline fill of rings (outer + holes) into the grid; calls `hit` per covered cell. */
function scan(rings: P2[][], g: { x0: number; z0: number; nx: number; nz: number }, hit: (i: number) => void) {
  let zmin = Infinity, zmax = -Infinity;
  for (const r of rings) for (const p of r) { zmin = Math.min(zmin, p[1]); zmax = Math.max(zmax, p[1]); }
  const j0 = Math.max(0, Math.floor((zmin - g.z0) / CELL)), j1 = Math.min(g.nz - 1, Math.ceil((zmax - g.z0) / CELL));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = g.z0 + (j + 0.5) * CELL;
    xs.length = 0;
    for (const r of rings) for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const [xa, za] = r[a], [xb, zb] = r[b];
      if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) / (zb - za)) * (xb - xa));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / CELL - 0.5)), i1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) hit(j * g.nx + i);
    }
  }
}

/** Chamfer distance (metres) from every cell to the nearest seed cell. */
function distance(seed: Uint8Array, nx: number, nz: number): Float32Array {
  const d = new Float32Array(nx * nz).fill(1e9);
  for (let i = 0; i < d.length; i++) if (seed[i]) d[i] = 0;
  const a = CELL, b = CELL * Math.SQRT2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a);
    if (j > 0) { v = Math.min(v, d[k - nx] + a); if (i > 0) v = Math.min(v, d[k - nx - 1] + b); if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + b); }
    d[k] = v;
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; let v = d[k];
    if (i < nx - 1) v = Math.min(v, d[k + 1] + a);
    if (j < nz - 1) { v = Math.min(v, d[k + nx] + a); if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + b); if (i > 0) v = Math.min(v, d[k + nx - 1] + b); }
    d[k] = v;
  }
  return d;
}

const openRing = (r: LL[]) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);

export function analyseTile(base: BaseTile, buildings: ResolvedBuilding[], ground: ResolvedGround[], proj: Projector): InfillAnalysis {
  const [w, s, e, n] = base.bbox;
  const [xa, za] = proj.xz([w, n]), [xb, zb] = proj.xz([e, s]);
  const g = { x0: Math.min(xa, xb), z0: Math.min(za, zb), nx: Math.ceil(Math.abs(xb - xa) / CELL), nz: Math.ceil(Math.abs(zb - za) / CELL) };
  const N = g.nx * g.nz;
  const ringsXZ = (p: Polygon | { outer: LL[]; holes: LL[][] }) => [p.outer, ...p.holes].map((r) => openRing(r).map((q) => proj.xz(q)));

  // buildings (any volume of any non-hidden building)
  const bld = new Uint8Array(N);
  for (const b of buildings) {
    if (b.hidden) continue;
    for (const v of b.volumes) for (const p of v.polygons) if (v.minHeight < 3) scan(ringsXZ(p), g, (i) => (bld[i] = 1));
  }
  // streets, with their pavements
  const street = new Uint8Array(N);
  for (const r of base.roads) {
    const h = r.tags.highway ?? "";
    if (!STREETS.test(h) || (r.tags.tunnel && r.tags.tunnel !== "no")) continue;
    const half = (Number.parseFloat(r.tags.width) || STREET_WIDTH[h.replace("_link", "")] || 6.5) / 2 + 1.7;
    const pts = r.line.map((q) => proj.xz(q));
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - g.x0) / CELL)), i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx) + half - g.x0) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - half - g.z0) / CELL)), j1 = Math.min(g.nz - 1, Math.floor((Math.max(az, bz) + half - g.z0) / CELL));
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = g.x0 + (i + 0.5) * CELL, pz = g.z0 + (j + 0.5) * CELL;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
        if (Math.hypot(px - ax - t * dx, pz - az - t * dz) <= half) street[j * g.nx + i] = 1;
      }
    }
  }
  // barrier = buildings grown by one cell (closes hairline gaps between neighbours) + streets
  const wall = new Uint8Array(N);
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i;
    if (street[k] || bld[k] || (i > 0 && bld[k - 1]) || (i < g.nx - 1 && bld[k + 1]) || (j > 0 && bld[k - g.nx]) || (j < g.nz - 1 && bld[k + g.nx])) wall[k] = 1;
  }

  // connected open spaces
  const comp = new Int32Array(N).fill(-1);
  const comps: { size: number; street: boolean; edge: boolean }[] = [];
  const stack: number[] = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (wall[k0] || comp[k0] >= 0) continue;
    const c = { size: 0, street: false, edge: false }, id = comps.length;
    comps.push(c); comp[k0] = id; stack.push(k0);
    while (stack.length) {
      const k = stack.pop()!, i = k % g.nx, j = (k / g.nx) | 0;
      c.size++;
      if (i === 0 || j === 0 || i === g.nx - 1 || j === g.nz - 1) c.edge = true;
      for (const m of [i > 0 ? k - 1 : -1, i < g.nx - 1 ? k + 1 : -1, j > 0 ? k - g.nx : -1, j < g.nz - 1 ? k + g.nx : -1]) {
        if (m < 0) continue;
        if (street[m]) c.street = true;
        else if (!wall[m] && comp[m] < 0) { comp[m] = id; stack.push(m); }
      }
    }
  }
  const dStreet = distance(street, g.nx, g.nz), dBld = distance(bld, g.nx, g.nz);
  const cellCls = new Int8Array(N).fill(-1);
  for (let k = 0; k < N; k++) {
    const c = comp[k];
    if (c < 0) continue;
    const C = comps[c];
    cellCls[k] = !C.street && !C.edge && C.size * CELL * CELL <= COURT_MAX_M2 ? 0 : dStreet[k] <= FRONT_M ? 1 : dBld[k] > OPEN_M ? 3 : 2;
  }

  // evidence: contributors' patches (weight 3) and OSM's small lawns and paved areas (weight 1)
  const mapped = new Uint8Array(N);   // already drawn: don't fill
  const yard = new Uint8Array(N);     // OSM residential land: already gardens, only repaint if evidence says paved
  const looked = new Uint8Array(N);   // covered by evidence: its region is left alone
  const evidence: Evidence[] = [];
  const addEvidence = (rings: P2[][], surface: string, weight: number) => {
    const acc = CLASSES.map(() => ({ n: 0, x: 0, z: 0 }));
    scan(rings, g, (k) => {
      mapped[k] = 1; looked[k] = 1;
      const c = cellCls[k];
      if (c < 0) return;
      const a = acc[c]; a.n++; a.x += g.x0 + ((k % g.nx) + 0.5) * CELL; a.z += g.z0 + (((k / g.nx) | 0) + 0.5) * CELL;
    });
    if (!SPREAD.has(surface)) return;
    acc.forEach((a, c) => { if (a.n >= 4) evidence.push({ x: a.x / a.n, z: a.z / a.n, cls: CLASSES[c], surface, weight: a.n * CELL * CELL * weight }); });
  };
  for (const p of ground) addEvidence(ringsXZ({ outer: p.area, holes: p.holes }), p.surface, 3);
  for (const a of base.areas) {
    if (a.kind === "yard") { for (const p of a.polygons) scan(ringsXZ(p), g, (k) => (yard[k] = 1)); continue; } // a land-use guess, not evidence
    const surface = a.kind === "green" ? "grass" : a.kind === "paved" ? "paving" : a.kind;
    for (const p of a.polygons) {
      const big = Math.abs(p.outer.length > 2 ? areaXZ(p.outer.map((q) => proj.xz(q))) : 0) > OSM_EVIDENCE_MAX_M2;
      if (big || a.kind === "forest") scan(ringsXZ(p), g, (k) => (mapped[k] = 1));
      else addEvidence(ringsXZ(p), surface, 1);
    }
  }

  // regions = (open space, class); "looked" if evidence covers ≥ 15% of it
  const byKey = new Map<number, Region & { seen: number }>();
  for (let k = 0; k < N; k++) {
    const c = cellCls[k];
    if (c < 0) continue;
    const key = comp[k] * 4 + c;
    let r = byKey.get(key);
    if (!r) { r = { cls: CLASSES[c], cx: 0, cz: 0, area: 0, cells: [], yard: new Uint8Array(0), looked: false, seen: 0 }; byKey.set(key, r); }
    r.area++; r.cx += g.x0 + ((k % g.nx) + 0.5) * CELL; r.cz += g.z0 + (((k / g.nx) | 0) + 0.5) * CELL;
    if (looked[k]) r.seen++;
    if (!mapped[k]) r.cells.push(k);
  }
  const regions: Region[] = [];
  for (const r of byKey.values()) {
    const area = r.area * CELL * CELL;
    if (area < 25 || !r.cells.length) continue;
    regions.push({ cls: r.cls, cx: r.cx / r.area, cz: r.cz / r.area, area, cells: r.cells, yard: Uint8Array.from(r.cells, (k) => yard[k]), looked: r.seen / r.area >= 0.15 });
  }
  return { cell: CELL, x0: g.x0, z0: g.z0, nx: g.nx, nz: g.nz, regions, evidence };
}

function areaXZ(r: P2[]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

export interface InfillGuess { cls: InfillClass; surface: string; area: number; confidence: number; x: number; z: number }

/** The surface nearby evidence agrees on for a region, or null. */
export function vote(r: { cls: InfillClass; cx: number; cz: number }, pool: Evidence[]): { surface: string; confidence: number } | null {
  const w = new Map<string, number>();
  let total = 0;
  for (const e of pool) {
    if (e.cls !== r.cls) continue;
    const d = Math.hypot(e.x - r.cx, e.z - r.cz);
    if (d > REACH_M) continue;
    const v = e.weight / (1 + (d / HALF_M) ** 2);
    w.set(e.surface, (w.get(e.surface) ?? 0) + v); total += v;
  }
  if (total < 40) return null;   // under ~40 m² of nearby agreement: no guess
  let best = "", bw = 0;
  for (const [s, v] of w) if (v > bw) { best = s; bw = v; }
  return bw / total >= 0.55 ? { surface: best, confidence: bw / total } : null;
}

/** Meshes for the guessed surfaces, drawn under OSM areas and patches (they cover any overlap). */
export function buildInfill(a: InfillAnalysis, pool: Evidence[]): { meshes: THREE.Object3D[]; guesses: InfillGuess[] } {
  const L = new Layers();
  const guesses: InfillGuess[] = [];
  const pad = a.cell; // grow each run one cell so fills tuck under walls and pavements
  for (const r of a.regions) {
    if (r.looked) continue;
    const v = vote(r, pool);
    if (!v) continue;
    // residential yards already look like gardens: only repaint them if the guess is a hard surface
    const green = v.surface === "grass" || v.surface === "garden";
    const cells = green ? r.cells.filter((_, n) => !r.yard[n]) : r.cells; // ascending index order
    if (!cells.length) continue;
    guesses.push({ cls: r.cls, surface: v.surface, area: Math.round(cells.length * a.cell * a.cell), confidence: Math.round(v.confidence * 100) / 100, x: r.cx, z: r.cz });
    const st = SURFACE_STYLE[v.surface] ?? SURFACE_STYLE.paving;
    const pos = L.add(st.color, 0.6 + Object.keys(SURFACE_STYLE).indexOf(v.surface) * 0.01, st.texture); // distinct orders: no fighting
    // merge cells into horizontal runs
    for (let s = 0; s < cells.length;) {
      let t = s;
      while (t + 1 < cells.length && cells[t + 1] === cells[t] + 1 && (cells[t + 1] % a.nx) !== 0) t++;
      const j = (cells[s] / a.nx) | 0, i0 = cells[s] % a.nx, i1 = cells[t] % a.nx;
      const x0 = a.x0 + i0 * a.cell - pad, x1 = a.x0 + (i1 + 1) * a.cell + pad, z0 = a.z0 + j * a.cell - pad / 2, z1 = a.z0 + (j + 1) * a.cell + pad / 2;
      pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
      s = t + 1;
    }
  }
  const meshes = L.meshes();
  for (const m of meshes) m.name = "infill";
  return { meshes, guesses };
}

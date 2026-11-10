// Layer resolution: OSM tags → scoped rules (broadest first) → per-building spec.
// The most specific layer wins, field by field.
import { pointInRing, ringAreaM2, type BaseBuilding, type LL, type Polygon } from "./osm.js";
import type { AssetChange, BuildingSpec, GroundChange, Part, RuleChange, StoredChange, Style, Tower } from "./schema.js";
import { pointInBBox, type BBox } from "./tiles.js";

export interface ResolvedVolume extends Required<Pick<Style, "height" | "minHeight" | "floorHeight">> {
  polygons: Polygon[];
  facade: Omit<NonNullable<Style["facade"]>, "material" | "color"> & { material: string; color: string };
  roof: Omit<NonNullable<Style["roof"]>, "shape" | "color"> & { shape: string; color: string };
  groundFloor?: Style["groundFloor"];
  floors: number;
}

export interface ResolvedBuilding {
  id: string;
  name?: string;
  tags: Record<string, string>;
  centroid: LL;
  volumes: ResolvedVolume[];
  hidden: boolean;
  asset?: { change: AssetChange; author: string; changeId: number };
  /** A fitted 3D model replaces the procedural volumes (typology rule or building spec). */
  model?: { assets: string[]; fit: "stretch" | "uniform" | "none"; heading?: number; height: number; minHeight: number; seed: number };
  /** Who shaped this building, most recent first (for "contributed by"). */
  contributors: string[];
  layers: { kind: "osm" | "rule" | "spec" | "asset"; id?: number; label?: string; author?: string }[];
}

const num = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|')?\s*$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "ft" || m[2] === "'" ? n * 0.3048 : n;
};

const OSM_MATERIAL: Record<string, string> = {
  brick: "brick", bricks: "brick", concrete: "concrete", glass: "glass", stone: "stone", sandstone: "stone",
  limestone: "stone", wood: "wood", timber_framing: "wood", metal: "metal", steel: "metal", plaster: "plaster",
  marble: "marble", tiles: "tile", tile: "tile", roof_tiles: "tile", cement_block: "concrete", granite: "stone",
};

const OSM_COLOURS: Record<string, string> = {
  white: "#f2f0ea", black: "#2a2a2a", grey: "#9a9a9a", gray: "#9a9a9a", red: "#a8483a", brown: "#7a5a43",
  beige: "#d9c9a8", yellow: "#d9c45a", blue: "#4a6fa5", green: "#5f8a5a", orange: "#d08040", pink: "#d9a0a8",
  silver: "#c0c4c8", tan: "#cbb38f", maroon: "#6e2a2a", cream: "#efe6cf",
};

function colour(v?: string): string | undefined {
  if (!v) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + v.slice(1).split("").map((c) => c + c).join("").toLowerCase();
  return OSM_COLOURS[v.toLowerCase()];
}

/** Style implied by OSM tags alone. */
export function styleFromTags(tags: Record<string, string>): Style {
  const s: Style = {};
  const h = num(tags.height), mh = num(tags.min_height);
  const lv = num(tags["building:levels"]), mlv = num(tags["building:min_level"]);
  const rh = num(tags["roof:height"]), rlv = num(tags["roof:levels"]);
  if (lv != null) s.floors = Math.round(lv);
  if (h != null) s.height = Math.max(0, h - (rh ?? 0));
  if (mh != null) s.minHeight = mh; else if (mlv != null) s.minHeight = mlv * 3;
  const facadeMat = OSM_MATERIAL[tags["building:material"] ?? ""];
  const facadeCol = colour(tags["building:colour"]);
  if (facadeMat || facadeCol) s.facade = { ...(facadeMat ? { material: facadeMat as never } : {}), ...(facadeCol ? { color: facadeCol } : {}) };
  const shape = tags["roof:shape"];
  const roofShape = shape === "gambrel" || shape === "mansard" || shape === "half-hipped" ? "hipped"
    : shape === "round" ? "dome" : shape;
  const roof: NonNullable<Style["roof"]> = {};
  if (roofShape && ["flat", "gabled", "hipped", "pyramidal", "skillion", "dome", "onion"].includes(roofShape)) roof.shape = roofShape as never;
  if (rh != null) roof.height = rh; else if (rlv != null) roof.height = rlv * 3;
  const rc = colour(tags["roof:colour"]); if (rc) roof.color = rc;
  const rm = OSM_MATERIAL[tags["roof:material"] ?? ""]; if (rm) roof.material = rm as never;
  if (Object.keys(roof).length) s.roof = roof;
  return s;
}

/** Merge b over a, one level deep for the nested objects. */
export function mergeStyle<T extends Style>(a: T, b: Style | undefined): T {
  if (!b) return a;
  const out: Style = { ...a };
  // A layer that sets floors but not height (or the reverse) re-derives the other, so a
  // "10 floors" spec over an inherited 7 m height gives a 10-floor building, not 10 floors in 7 m.
  if (b.floors !== undefined && b.height === undefined) delete out.height;
  if (b.height !== undefined && b.floors === undefined) delete out.floors;
  for (const [k, v] of Object.entries(b) as [keyof Style, unknown][]) {
    if (v === undefined) continue;
    if (k === "facade" || k === "roof" || k === "groundFloor") {
      const base = (a[k] ?? {}) as Record<string, unknown>;
      const next = { ...base, ...(v as Record<string, unknown>) };
      if (k === "facade" && (a.facade?.windows || (v as Style["facade"])?.windows)) {
        (next as Record<string, unknown>).windows = { ...(a.facade?.windows ?? {}), ...((v as Style["facade"])?.windows ?? {}) };
      }
      (out as Record<string, unknown>)[k] = next;
    } else (out as Record<string, unknown>)[k] = v;
  }
  return out as T;
}

export function ruleMatches(rule: RuleChange, b: { tags: Record<string, string>; centroid: LL }): boolean {
  if (!pointInBBox(b.centroid[0], b.centroid[1], rule.scope.bbox as BBox)) return false;
  for (const [k, v] of Object.entries(rule.select.tags)) {
    const have = b.tags[k];
    if (v.startsWith("!")) {
      // negative selector: "!*" = tag absent, "!a|b" = tag is neither a nor b
      const not = v.slice(1);
      if (not === "*" ? have != null : have != null && not.split("|").includes(have)) return false;
      continue;
    }
    if (have == null) return false;
    if (v !== "*" && v.split("|").every((alt) => alt !== have)) return false;
  }
  return true;
}

const bboxArea = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);

/** Small deterministic hash for per-building variation. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const DEFAULT_FACADE = ["#e8e2d6", "#ddd5c4", "#d6cfc2", "#e9e4dc", "#cfc6b5", "#e3d9c6", "#c9c2b8", "#efeae0"];
const DEFAULT_ROOF = ["#b3ada4", "#a49e95", "#bdb7ad", "#9c968d", "#c4bcae"];

function defaultFloors(tags: Record<string, string>, areaM2: number): number {
  const b = tags.building ?? tags["building:part"] ?? "yes";
  switch (b) {
    case "house": case "detached": case "semidetached_house": case "terrace": case "residential": return 2;
    case "bungalow": case "hut": case "shed": case "garage": case "garages": case "roof": case "carport": case "kiosk": return 1;
    case "apartments": case "flats": return areaM2 > 600 ? 6 : 4;
    case "commercial": case "retail": case "office": return areaM2 > 2000 ? 5 : 3;
    case "industrial": case "warehouse": return 2;
    case "hospital": case "hotel": return 5;
    case "school": case "university": case "college": case "public": case "civic": case "government": return 3;
    case "mosque": case "church": case "temple": case "cathedral": return 2;
    default: return areaM2 < 60 ? 1 : 2;
  }
}

function defaultRoofShape(tags: Record<string, string>): string {
  const b = tags.building;
  if (b === "roof" || b === "carport") return "flat";
  return "flat";
}

function finalise(id: string, s: Style, polygons: Polygon[], tags: Record<string, string>, areaM2: number): ResolvedVolume {
  const h = hashString(id);
  // If both height and floors are given, the storey height follows from them.
  const derived = s.height != null && s.floors ? (s.height - (s.minHeight ?? 0)) / s.floors : undefined;
  const kind = tags.building ?? tags["building:part"] ?? "";
  const monumental = /^(church|cathedral|chapel|mosque|temple|shrine|synagogue|basilica|monastery)$/.test(kind) || !!tags.historic || tags.amenity === "place_of_worship";
  const floorHeight = s.floorHeight ?? (derived && derived >= 2 && derived <= 12 ? derived : monumental ? 6 : 3.2);
  const floors = s.floors ?? (s.height != null ? Math.max(1, Math.round((s.height - (s.minHeight ?? 0)) / floorHeight)) : defaultFloors(tags, areaM2));
  const height = s.height ?? (s.minHeight ?? 0) + floors * floorHeight;
  const material = s.facade?.material ?? (tags.building === "industrial" || tags.building === "warehouse" ? "metal" : "plaster");
  return {
    polygons,
    height,
    minHeight: Math.min(s.minHeight ?? 0, height),
    floorHeight,
    floors,
    facade: {
      ...s.facade,
      ...(monumental && !s.facade?.windows?.pattern ? { windows: { ...s.facade?.windows, pattern: "arched" as const, density: s.facade?.windows?.density ?? 0.3, bay: s.facade?.windows?.bay ?? 5 } } : {}),
      material,
      color: s.facade?.color ?? (material === "brick" ? "#9c5640" : material === "glass" ? "#6f8ea3" : material === "metal" ? "#a9adb1" : DEFAULT_FACADE[h % DEFAULT_FACADE.length]),
    },
    roof: { ...s.roof, shape: s.roof?.shape ?? defaultRoofShape(tags), color: s.roof?.color ?? DEFAULT_ROOF[(h >>> 4) % DEFAULT_ROOF.length] },
    groundFloor: s.groundFloor,
  };
}

const polyFromRing = (r: LL[]): Polygon[] => [{ outer: r, holes: [] }];

export interface ResolveInput {
  buildings: BaseBuilding[];
  changes: StoredChange[];
}

/**
 * Fold base buildings + live changes into renderable buildings.
 * Changes must be live (not reverted) and are applied in createdAt order.
 */
export function resolveBuildings({ buildings, changes }: ResolveInput): ResolvedBuilding[] {
  const sorted = [...changes].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const rules = sorted.filter((c) => c.change.kind === "rule")
    // broadest scope first so narrower rules override it; ties keep creation order
    .sort((a, b) => bboxArea((b.change as RuleChange).scope.bbox) - bboxArea((a.change as RuleChange).scope.bbox));
  const specs = new Map<string, StoredChange[]>();
  const assets = new Map<string, StoredChange>();
  for (const c of sorted) {
    if (c.change.kind === "building") {
      const list = specs.get(c.change.target) ?? [];
      list.push(c); specs.set(c.change.target, list);
    } else if (c.change.kind === "asset") assets.set(c.change.target, c);
  }

  const out: ResolvedBuilding[] = [];
  const seen = new Set<string>();

  const specOf = (id: string) => {
    let spec: BuildingSpec = {};
    const list = specs.get(id) ?? [];
    for (const c of list) {
      const s = (c.change as { spec: BuildingSpec }).spec;
      spec = { ...mergeStyle(spec, s), ...(s.name !== undefined ? { name: s.name } : {}), ...(s.footprint ? { footprint: s.footprint } : {}), ...(s.parts ? { parts: s.parts } : {}), ...(s.towers ? { towers: s.towers } : {}), ...(s.hidden !== undefined ? { hidden: s.hidden } : {}) };
    }
    return { spec, list };
  };

  // building:part features inherit materials/colours from a spec on their outline.
  const outlines = buildings.filter((b) => b.hasParts);
  const parentOf = (b: BaseBuilding) => b.isPart ? outlines.find((o) => o.polygons.some((p) => pointInRing(b.centroid, p.outer)))?.id : undefined;

  const build = (id: string, tags: Record<string, string>, polygons: Polygon[], centroid: LL, areaM2: number, hasParts: boolean, parent?: string) => {
    seen.add(id);
    const layers: ResolvedBuilding["layers"] = [];
    const contributors: string[] = [];
    // Area rules are the broadest guess, so they go first; OSM's per-building tags (measured
    // heights, levels, colours) override them; contributor specs for this building override both.
    let style: Style = {};
    for (const r of rules) {
      const rc = r.change as RuleChange;
      if (ruleMatches(rc, { tags, centroid })) {
        style = mergeStyle(style, rc.set);
        layers.push({ kind: "rule", id: r.id, label: rc.label, author: r.author });
      }
    }
    style = mergeStyle(style, styleFromTags(tags));
    layers.unshift({ kind: "osm" });
    const parentTags = parent ? buildings.find((b) => b.id === parent)?.tags : undefined;
    const kindTags = parentTags ? { ...parentTags, ...tags } : tags;
    const parentModelled = parent && specs.has(parent) && !!specOf(parent).spec.model; // only an explicit model on the outline replaces its parts
    if (parentModelled) { seen.add(id); return; } // the whole building is a model: its OSM parts aren't drawn
    if (parent && specs.has(parent)) {
      const ps = specOf(parent);
      const inherit: Style = {};
      if (ps.spec.facade) inherit.facade = ps.spec.facade;
      if (ps.spec.floorHeight) inherit.floorHeight = ps.spec.floorHeight;
      if (ps.spec.roof?.color || ps.spec.roof?.material) inherit.roof = { ...(ps.spec.roof.color ? { color: ps.spec.roof.color } : {}), ...(ps.spec.roof.material ? { material: ps.spec.roof.material } : {}) };
      if (ps.spec.groundFloor && !(tags.min_height || tags["building:min_level"])) inherit.groundFloor = ps.spec.groundFloor;
      style = mergeStyle(style, inherit);
      for (const c of ps.list) { layers.push({ kind: "spec", id: c.id, author: c.author, label: "from the whole building" }); contributors.unshift(c.author); }
    }
    const { spec, list } = specOf(id);
    for (const c of list) { layers.push({ kind: "spec", id: c.id, author: c.author }); contributors.unshift(c.author); }
    // A typology model from an area rule is for ordinary buildings: a building with its own
    // description, or one OSM already models in 3D parts, keeps its own shape.
    if (style.model && !spec.model && (list.length || hasParts)) { const { model: _drop, ...rest } = style; style = rest; }
    const { name, footprint, parts, towers, hidden, ...specStyle } = spec;
    style = mergeStyle(style, specStyle);
    const polys = footprint ? polyFromRing(footprint) : polygons;
    // An OSM outline that already has building:part children is drawn by its parts,
    // unless the contributor redraws it with an explicit footprint/parts.
    const mainHidden = hasParts && !footprint && !parts?.length;
    const volumes: ResolvedVolume[] = mainHidden ? [] : parts?.length
      ? parts.map((p: Part, i: number) => { const { footprint: fp, ...ps } = p; return finalise(`${id}#${i}`, mergeStyle(style, ps), polyFromRing(fp), kindTags, areaM2); })
      : [finalise(id, style, polys, kindTags, areaM2)];
    if (towers?.length) {
      const ring = (parts?.length ? parts.map((p) => p.footprint).sort((x, y) => Math.abs(ringAreaM2(y)) - Math.abs(ringAreaM2(x)))[0] : polys[0]?.outer) ?? [];
      towers.forEach((t, i) => {
        const base: Style = { facade: { ...style.facade, windows: { pattern: "sparse", ...(style.facade?.windows?.color ? { color: style.facade.windows.color } : {}) } }, floorHeight: 4 };
        const ts = mergeStyle(mergeStyle(base, { facade: t.facade, roof: { shape: "dome", color: style.roof?.color, ...t.roof } }), { height: t.height, minHeight: t.minHeight ?? 0 });
        towerPositions(t, ring).forEach((pos, j) => volumes.push(finalise(`${id}#t${i}.${j}`, { ...ts, floors: undefined }, polyFromRing(circleRing(pos, t.radius)), kindTags, areaM2)));
      });
    }
    const a = assets.get(id);
    if (a) { layers.push({ kind: "asset", id: a.id, author: a.author }); contributors.unshift(a.author); }
    let model: ResolvedBuilding["model"];
    if (spec.model && polys.length) {
      // The building's own model wins over any parts: fit it to the outline/footprint itself.
      volumes.splice(0, volumes.length, finalise(id, style, polys, kindTags, areaM2));
    } else if (style.model && !parts?.length && !volumes[0] && polys.length) {
      volumes.push(finalise(id, style, polys, kindTags, areaM2));
    }
    if (style.model && (!parts?.length || spec.model) && volumes[0]) {
      // The viewer picks the variant whose proportions best match the footprint (seeded per building).
      model = { assets: style.model.assets, fit: style.model.fit ?? "stretch", heading: style.model.heading, height: volumes[0].height, minHeight: volumes[0].minHeight, seed: hashString(id) };
    }
    for (const l of layers) if (l.kind === "rule" && l.author && !contributors.includes(l.author)) contributors.push(l.author);
    out.push({
      id, name: name ?? tags.name, tags, centroid, volumes,
      hidden: hidden === true || (volumes.length === 0 && !a),
      ...(a ? { asset: { change: a.change as AssetChange, author: a.author, changeId: a.id } } : {}),
      ...(model ? { model } : {}),
      contributors: [...new Set(contributors)],
      layers,
    });
  };

  for (const b of buildings) build(b.id, b.tags, b.polygons, b.centroid, b.areaM2, !!b.hasParts, parentOf(b));
  // New buildings (n:slug) defined only by contributors.
  for (const [target, list] of specs) {
    if (seen.has(target) || !target.startsWith("n:")) continue;
    // the newest outline: an explicit footprint, else the hull of all its parts
    const fp = [...list].reverse().map((c) => { const s = (c.change as { spec: BuildingSpec }).spec; return s.footprint ?? (s.parts?.length ? hullLL(s.parts.flatMap((p) => p.footprint)) : undefined); }).find(Boolean);
    if (!fp) continue;
    let cx = 0, cy = 0; for (const p of fp) { cx += p[0]; cy += p[1]; }
    build(target, { building: "yes" }, polyFromRing(fp), [cx / fp.length, cy / fp.length], 100, false);
  }
  // Assets on targets with no building at all (e.g. monuments): emit asset-only entries.
  for (const [target, a] of assets) {
    if (seen.has(target)) continue;
    const t = (a.change as AssetChange).transform;
    out.push({ id: target, tags: {}, centroid: [t.lon, t.lat], volumes: [], hidden: false, asset: { change: a.change as AssetChange, author: a.author, changeId: a.id }, contributors: [a.author], layers: [{ kind: "asset", id: a.id, author: a.author }] });
  }
  return out;
}

/** Convex hull of lon/lat points (closed ring, counter-clockwise). */
export function hullLL(pts: LL[]): LL[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return [...p, p[0]];
  const cross = (o: LL, a: LL, b: LL) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: LL[] = [], hi: LL[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  const ring = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  return [...ring, ring[0]];
}

// ---------------------------------------------------------------- towers

/** Minimum-area bounding rectangle of a lon/lat ring, in local metres around its first point. */
export function orientedRectLL(ring: LL[]) {
  const lat0 = ring[0]?.[1] ?? 0, lon0 = ring[0]?.[0] ?? 0;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110574;
  const pts = ring.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
  let best = { area: Infinity, c: [0, 0], ax: [1, 0], hl: 0, hw: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const t = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    const ux = Math.cos(t), uy = Math.sin(t);
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, y] of pts) { const u = x * ux + y * uy, v = -x * uy + y * ux; a = Math.min(a, u); b = Math.max(b, u); c = Math.min(c, v); d = Math.max(d, v); }
    const area = (b - a) * (d - c);
    if (area < best.area) {
      const cu = (a + b) / 2, cv = (c + d) / 2;
      let ax = [ux, uy], hl = (b - a) / 2, hw = (d - c) / 2;
      if (hw > hl) { ax = [-uy, ux]; [hl, hw] = [hw, hl]; }
      best = { area, c: [cu * ux - cv * uy, cu * uy + cv * ux], ax, hl, hw };
    }
  }
  const toLL = (x: number, y: number): LL => [lon0 + x / kx, lat0 + y / ky];
  const at = (u: number, v: number): LL => toLL(best.c[0] + best.ax[0] * u - best.ax[1] * v, best.c[1] + best.ax[1] * u + best.ax[0] * v);
  return { ...best, at, kx, ky };
}

export function towerPositions(t: Tower, ring: LL[]): LL[] {
  if (Array.isArray(t.at)) return t.at as LL[];
  if (ring.length < 3) return [];
  const r = orientedRectLL(ring);
  const inset = t.inset ?? t.radius;
  if (t.at === "centre") return [r.at(0, 0)];
  if (t.at === "ends") return [r.at(-(r.hl - inset), 0), r.at(r.hl - inset, 0)];
  if (typeof t.at === "string" && t.at.startsWith("end-")) {
    // One tower at the short end nearest the given compass direction (e.g. a church's west tower).
    const ends = [r.at(-(r.hl - inset), 0), r.at(r.hl - inset, 0)];
    const c = r.at(0, 0);
    const dir = ({ "end-north": [0, 1], "end-south": [0, -1], "end-east": [1, 0], "end-west": [-1, 0] } as Record<string, number[]>)[t.at]!;
    const score = (p: LL) => (p[0] - c[0]) * r.kx * dir[0] + (p[1] - c[1]) * r.ky * dir[1];
    return [score(ends[0]) >= score(ends[1]) ? ends[0] : ends[1]];
  }
  const L = Math.max(0, r.hl - inset), W = Math.max(0, r.hw - inset);
  const pts = [r.at(-L, -W), r.at(L, -W), r.at(L, W), r.at(-L, W)];
  if ((t.count ?? 4) >= 6) pts.push(r.at(0, -W), r.at(0, W));
  if ((t.count ?? 4) >= 8) pts.push(r.at(-L, 0), r.at(L, 0));
  return pts;
}

export function circleRing(c: LL, radiusM: number, n = 14): LL[] {
  const kx = 111320 * Math.cos((c[1] * Math.PI) / 180), ky = 110574;
  const out: LL[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([c[0] + (Math.cos(a) * radiusM) / kx, c[1] + (Math.sin(a) * radiusM) / ky]); }
  out.push(out[0]);
  return out;
}

// ---------------------------------------------------------------- ground surfaces

export interface ResolvedGround { id: string; label: string; surface: string; area: LL[]; holes: LL[][]; color?: string; author: string; changeId: number }

/** Contributor ground patches (g:…): the latest live change per id wins; hidden ones are dropped. */
export function resolveGround(changes: StoredChange[]): ResolvedGround[] {
  const latest = new Map<string, StoredChange>();
  for (const c of changes) if (c.change.kind === "ground") latest.set(c.change.target, c);
  const out: ResolvedGround[] = [];
  for (const [id, c] of latest) {
    const g = c.change as GroundChange;
    if (g.hidden) continue;
    out.push({ id, label: g.label, surface: g.surface, area: g.area as LL[], holes: (g.holes ?? []) as LL[][], ...(g.color ? { color: g.color } : {}), author: c.author, changeId: c.id });
  }
  return out;
}

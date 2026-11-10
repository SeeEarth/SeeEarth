// OSM base layer: fetch a tile's features from Overpass and normalise them.
import { type BBox, type TileId, tileBBox, tileKey, pointInBBox, bboxIntersects } from "./tiles.js";

export type LL = [number, number];
export interface Polygon { outer: LL[]; holes: LL[][] }

export interface BaseBuilding {
  id: string;               // w123 / r456
  tags: Record<string, string>;
  polygons: Polygon[];
  centroid: LL;
  areaM2: number;
  /** building:part feature (rendered instead of its parent outline). */
  isPart?: boolean;
  /** Outline that has building:part children; not rendered unless overridden. */
  hasParts?: boolean;
}

export interface BaseLine { id: string; tags: Record<string, string>; line: LL[] }
export type AreaKind = "water" | "green" | "forest" | "sand" | "paved";
export interface BaseArea { id: string; kind: AreaKind; tags: Record<string, string>; polygons: Polygon[] }

export interface BaseTile {
  tile: string;
  bbox: BBox;
  fetchedAt: number;
  buildings: BaseBuilding[];
  roads: BaseLine[];
  rails: BaseLine[];
  areas: BaseArea[];
  /** Individual trees (OSM natural=tree) in the tile. */
  trees?: LL[];
  /** Lines of trees (OSM natural=tree_row) touching the tile. */
  treeRows?: BaseLine[];
}

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** Public Overpass instances, tried in order when one is busy. */
export const OVERPASS_MIRRORS = [OVERPASS_URL, "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

const lineBBox = (pts: LL[]): BBox => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of pts) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
};

export function overpassQuery(b: BBox): string {
  const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`;
  return `[out:json][timeout:180][maxsize:536870912];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["building:part"](${bb});
  way["highway"](${bb});
  way["railway"~"^(rail|light_rail|subway|tram)$"](${bb});
  way["natural"~"^(water|wood|scrub|grassland|beach|sand|wetland|tree_row)$"](${bb});
  node["natural"="tree"](${bb});
  relation["natural"~"^(water|wood)$"](${bb});
  way["waterway"="riverbank"](${bb});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|farmland|orchard)$"](${bb});
  way["leisure"~"^(park|garden|pitch|golf_course|playground)$"](${bb});
  relation["leisure"="park"](${bb});
  way["amenity"="parking"](${bb});
  way["area:highway"](${bb});
);
out body geom;`;
}

const KEEP_TAG = /^(building|building:.*|height|min_height|roof:.*|name|name:en|amenity|shop|tourism|historic|religion|office|leisure|man_made|wikidata|wikipedia|addr:street|addr:housenumber|addr:city|highway|lanes|width|layer|bridge|tunnel|surface|oneway|railway|natural|landuse|waterway|water|service|sport|area:highway|construction)$/;

function keepTags(t: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!t) return out;
  for (const [k, v] of Object.entries(t)) if (KEEP_TAG.test(k)) out[k] = v;
  return out;
}

interface OPGeom { lat: number; lon: number }
interface OPElement {
  type: "way" | "relation" | "node";
  id: number;
  lat?: number; lon?: number;
  tags?: Record<string, string>;
  geometry?: (OPGeom | null)[];
  members?: { type: string; ref: number; role: string; geometry?: (OPGeom | null)[] }[];
}

const toLL = (g: (OPGeom | null)[] | undefined): LL[] =>
  (g ?? []).filter((p): p is OPGeom => !!p).map((p) => [p.lon, p.lat] as LL);

const isClosed = (r: LL[]) => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];

/** Join open way segments into closed rings (multipolygon assembly). */
export function assembleRings(segments: LL[][]): LL[][] {
  const rings: LL[][] = [];
  const open: LL[][] = [];
  for (const s of segments) {
    if (s.length < 2) continue;
    if (isClosed(s)) rings.push(s); else open.push([...s]);
  }
  const same = (a: LL, b: LL) => a[0] === b[0] && a[1] === b[1];
  while (open.length) {
    let cur = open.shift()!;
    let grew = true;
    while (!isClosed(cur) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i];
        const end = cur[cur.length - 1];
        const start = cur[0];
        if (same(end, s[0])) cur = cur.concat(s.slice(1));
        else if (same(end, s[s.length - 1])) cur = cur.concat([...s].reverse().slice(1));
        else if (same(start, s[s.length - 1])) cur = s.concat(cur.slice(1));
        else if (same(start, s[0])) cur = [...s].reverse().concat(cur.slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (isClosed(cur)) rings.push(cur);
  }
  return rings;
}

/** Signed area of a lon/lat ring in m² (positive = counter-clockwise). */
export function ringAreaM2(r: LL[]): number {
  if (r.length < 3) return 0;
  const lat0 = (r[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110574;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += (r[j][0] * kx) * (r[i][1] * ky) - (r[i][0] * kx) * (r[j][1] * ky);
  }
  return a / 2;
}

export function pointInRing(p: LL, r: LL[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringCentroid(r: LL[]): LL {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-14) {
    const n = r.length;
    return [r.reduce((s, p) => s + p[0], 0) / n, r.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function polygonsFromRelation(el: OPElement): Polygon[] {
  const outers = assembleRings((el.members ?? []).filter((m) => m.type === "way" && m.role !== "inner").map((m) => toLL(m.geometry)));
  const inners = assembleRings((el.members ?? []).filter((m) => m.type === "way" && m.role === "inner").map((m) => toLL(m.geometry)));
  return outers.map((outer) => ({
    outer,
    holes: inners.filter((h) => pointInRing(h[0], outer)),
  }));
}

function areaKind(t: Record<string, string>): AreaKind | null {
  if (t.natural === "water" || t.waterway === "riverbank" || t.natural === "wetland") return "water";
  if (t.natural === "wood" || t.landuse === "forest" || t.landuse === "orchard") return "forest";
  if (t.natural === "beach" || t.natural === "sand") return "sand";
  if (t.amenity === "parking" || t["area:highway"]) return "paved";
  if (t.natural || t.landuse || t.leisure) return "green";
  return null;
}

/** Normalise an Overpass response into a BaseTile for the given work tile. */
export function parseOverpass(json: { elements: OPElement[] }, t: TileId, now = Date.now()): BaseTile {
  const bbox = tileBBox(t);
  const buildings: BaseBuilding[] = [];
  const roads: BaseLine[] = [];
  const rails: BaseLine[] = [];
  const areas: BaseArea[] = [];
  const trees: LL[] = [];
  const treeRows: BaseLine[] = [];

  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    if (el.type === "node") {
      if (tags.natural === "tree" && el.lon != null && el.lat != null && pointInBBox(el.lon, el.lat, bbox)) trees.push([el.lon, el.lat]);
      continue;
    }
    if (el.type === "way" && tags.natural === "tree_row") {
      treeRows.push({ id: `w${el.id}`, tags: {}, line: toLL(el.geometry) });
      continue;
    }
    const id = `${el.type === "way" ? "w" : el.type === "relation" ? "r" : "n"}${el.id}`;
    let polygons: Polygon[] | null = null;
    if (el.type === "way") {
      const ring = toLL(el.geometry);
      if (isClosed(ring)) polygons = [{ outer: ring, holes: [] }];
      else if (tags.highway && !tags["area:highway"]) { roads.push({ id, tags: keepTags(tags), line: ring }); continue; }
      else if (tags.railway) { rails.push({ id, tags: keepTags(tags), line: ring }); continue; }
      else continue;
    } else if (el.type === "relation") {
      polygons = polygonsFromRelation(el);
    } else continue;
    if (!polygons?.length) continue;

    if (tags.building || tags["building:part"]) {
      if (tags.building === "no" || tags["building:part"] === "no") continue;
      const main = polygons.reduce((a, b) => (Math.abs(ringAreaM2(a.outer)) >= Math.abs(ringAreaM2(b.outer)) ? a : b));
      const centroid = ringCentroid(main.outer);
      if (!pointInBBox(centroid[0], centroid[1], bbox)) continue; // owned by a neighbouring tile
      const areaM2 = polygons.reduce((s, p) => s + Math.abs(ringAreaM2(p.outer)) - p.holes.reduce((h, r) => h + Math.abs(ringAreaM2(r)), 0), 0);
      const isPart = !tags.building && !!tags["building:part"];
      buildings.push({ id, tags: keepTags(tags), polygons, centroid, areaM2: Math.round(areaM2), ...(isPart ? { isPart } : {}) });
    } else if (tags.highway && el.type === "way" && !tags["area:highway"] && tags.area !== "yes") {
      // closed highway loop (roundabout etc.)
      roads.push({ id, tags: keepTags(tags), line: polygons[0].outer });
    } else {
      const kind = areaKind(tags);
      if (kind) areas.push({ id, kind, tags: keepTags(tags), polygons });
    }
  }

  // Lines/areas: keep only those touching this tile (the response may cover a larger block).
  const touches = (pts: LL[]) => pts.length > 0 && bboxIntersects(lineBBox(pts), bbox);
  const keepRoads = roads.filter((r) => touches(r.line));
  const keepRails = rails.filter((r) => touches(r.line));
  const keepAreas = areas.filter((a) => a.polygons.some((p) => touches(p.outer)));
  const keepRows = treeRows.filter((r) => touches(r.line));

  // Outlines that contain building:part features are represented by their parts.
  const parts = buildings.filter((b) => b.isPart);
  if (parts.length) {
    for (const b of buildings) {
      if (b.isPart) continue;
      if (parts.some((p) => b.polygons.some((poly) => pointInRing(p.centroid, poly.outer)))) b.hasParts = true;
    }
  }

  return { tile: tileKey(t), bbox, fetchedAt: now, buildings, roads: keepRoads, rails: keepRails, areas: keepAreas, trees, treeRows: keepRows };
}

/** The 2×2 block of work tiles fetched together (one Overpass request instead of four). */
export function blockTiles(t: TileId): TileId[] {
  const x0 = t.x - (t.x % 2), y0 = t.y - (t.y % 2);
  return [{ x: x0, y: y0 }, { x: x0 + 1, y: y0 }, { x: x0, y: y0 + 1 }, { x: x0 + 1, y: y0 + 1 }];
}

export async function fetchOverpass(b: BBox, opts: { fetch?: typeof fetch; userAgent?: string; mirrors?: string[]; timeoutMs?: number } = {}): Promise<{ elements: OPElement[] }> {
  const f = opts.fetch ?? fetch;
  const errors: string[] = [];
  for (const url of opts.mirrors ?? OVERPASS_MIRRORS) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": opts.userAgent ?? "seeearth/0.1" },
        body: "data=" + encodeURIComponent(overpassQuery(b)),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!res.ok) { errors.push(`${new URL(url).host} ${res.status}`); continue; }
      const json = (await res.json()) as { elements: OPElement[]; remark?: string };
      if (json.remark && /runtime error|timed out/i.test(json.remark)) { errors.push(`${new URL(url).host}: ${json.remark.slice(0, 80)}`); continue; }
      return json;
    } catch (e) { errors.push(`${new URL(url).host}: ${(e as Error).message}`); }
  }
  throw new Error(`all Overpass mirrors failed: ${errors.join("; ")}`);
}

/** Fetch the 2×2 block containing t; returns a BaseTile for each of the four tiles. */
export async function fetchBaseBlock(t: TileId, opts: Parameters<typeof fetchOverpass>[1] = {}): Promise<BaseTile[]> {
  const tiles = blockTiles(t);
  const bbs = tiles.map(tileBBox);
  const b: BBox = [Math.min(...bbs.map((x) => x[0])), Math.min(...bbs.map((x) => x[1])), Math.max(...bbs.map((x) => x[2])), Math.max(...bbs.map((x) => x[3]))];
  const json = await fetchOverpass(b, opts);
  const now = Date.now();
  return tiles.map((tt) => parseOverpass(json, tt, now));
}

export async function fetchBaseTile(t: TileId, opts: Parameters<typeof fetchOverpass>[1] = {}): Promise<BaseTile> {
  return parseOverpass(await fetchOverpass(tileBBox(t), opts), t);
}

/** Fetch a whole rectangle of tiles in one Overpass request (for pre-seeding an area). */
export async function fetchBaseArea(x0: number, y0: number, x1: number, y1: number, opts: Parameters<typeof fetchOverpass>[1] = {}): Promise<BaseTile[]> {
  const nw = tileBBox({ x: x0, y: y0 }), se = tileBBox({ x: x1, y: y1 });
  const json = await fetchOverpass([nw[0], se[1], se[2], nw[3]], { timeoutMs: 200_000, ...opts });
  const now = Date.now();
  const out: BaseTile[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(parseOverpass(json, { x, y }, now));
  return out;
}

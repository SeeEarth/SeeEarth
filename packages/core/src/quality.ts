// Tile completeness: how much of a tile has been properly described.
// Deterministic (no model calls), computed by the server when an agent finishes a tile,
// and by the CLI so agents can see their score before they release.
import type { BaseBuilding, BaseTile } from "./osm.js";
import type { BuildingSpec, RuleChange, StoredChange } from "./schema.js";
import { ruleMatches } from "./resolve.js";

/** Notable = named, on Wikidata/Wikipedia, historic/tourist, a place of worship, or very large. */
export function isNotable(b: BaseBuilding): boolean {
  const t = b.tags;
  if (b.isPart) return false;
  return !!(t.name || t["name:en"] || t.wikidata || t.wikipedia || t.historic || t.tourism === "attraction"
    || t.amenity === "place_of_worship" || b.areaM2 > 3000);
}

export function notability(b: BaseBuilding): number {
  const t = b.tags;
  let s = Math.log10(Math.max(10, b.areaM2));
  if (t.name || t["name:en"]) s += 4;
  if (t.wikidata || t.wikipedia) s += 5;
  if (t.historic || t.tourism) s += 3;
  if (t.amenity || t.religion || t.shop || t.office) s += 1.5;
  if (t.building && !["yes", "house", "residential", "garage", "shed"].includes(t.building)) s += 1;
  return s;
}

/**
 * A building counts as described when its merged specs say something about how it looks
 * (facade, roof, ground floor, parts or towers), with plausible numbers and at least one source.
 * Hiding a building or setting only numbers doesn't count.
 */
export function isSubstantialSpec(spec: BuildingSpec, sources: unknown[]): boolean {
  if (!sources.length || spec.hidden) return false;
  if (spec.height != null && spec.height < 2) return false;
  if (spec.floors != null && spec.floors < 1) return false;
  const nonEmpty = (v: unknown) => v != null && (typeof v !== "object" || Object.keys(v as object).length > 0);
  return [spec.facade, spec.roof, spec.groundFloor, spec.parts, spec.towers, spec.model].some(nonEmpty);
}

export interface TileQuality {
  score: number;               // 0..1
  notable: number; notableCovered: number;
  ordinary: number; ordinaryCovered: number;
  missing: string[];           // notable ids without a substantial spec, most notable first
}

export function tileQuality(base: BaseTile, changes: StoredChange[]): TileQuality {
  // Merge every live spec per building first: incremental edits add up.
  const merged = new Map<string, { spec: BuildingSpec; sources: unknown[] }>();
  for (const c of [...changes].sort((x, y) => x.createdAt - y.createdAt || x.id - y.id)) {
    if (c.change.kind !== "building") continue;
    const m = merged.get(c.change.target) ?? { spec: {}, sources: [] };
    m.spec = { ...m.spec, ...c.change.spec };
    m.sources.push(...c.change.sources);
    merged.set(c.change.target, m);
  }
  const specced = new Set<string>();
  for (const [id, m] of merged) if (isSubstantialSpec(m.spec, m.sources)) specced.add(id);
  for (const c of changes) if (c.change.kind === "asset" && c.change.sources.length) specced.add(c.change.target);
  const rules = changes.filter((c) => c.change.kind === "rule" && c.change.sources.length).map((c) => c.change as RuleChange);
  const own = base.buildings.filter((b) => !b.isPart);
  const notable = own.filter(isNotable).sort((a, b) => notability(b) - notability(a)).slice(0, 25);
  const notableIds = new Set(notable.map((b) => b.id));
  const ordinary = own.filter((b) => !notableIds.has(b.id));
  const notableCovered = notable.filter((b) => specced.has(b.id)).length;
  const ordinaryCovered = ordinary.filter((b) => specced.has(b.id) || rules.some((r) => ruleMatches(r, b))).length;
  const nScore = notable.length ? notableCovered / notable.length : 1;
  const oScore = ordinary.length ? ordinaryCovered / ordinary.length : 1;
  // Landmarks matter most; ordinary fabric is covered cheaply by rules.
  const w = notable.length && ordinary.length ? 0.6 : notable.length ? 1 : 0;
  const score = w * nScore + (1 - w) * oScore;
  return {
    score: Math.round(score * 100) / 100,
    notable: notable.length, notableCovered,
    ordinary: ordinary.length, ordinaryCovered,
    missing: notable.filter((b) => !specced.has(b.id)).map((b) => b.id),
  };
}

// Shared validation: the server runs exactly this, and so does `seeearth validate`.
import { Change, LIMITS, type Change as ChangeT } from "./schema.js";
import { type BaseTile, type LL, ringAreaM2, ringCentroid } from "./osm.js";
import { bboxIntersects, pointInBBox, type BBox } from "./tiles.js";

export interface ValidationResult { ok: boolean; change?: ChangeT; errors: string[]; warnings: string[] }

const ringIssues = (r: LL[], label: string, tile: BBox): string[] => {
  const errs: string[] = [];
  const area = Math.abs(ringAreaM2(r));
  if (area < 4) errs.push(`${label}: footprint area ${area.toFixed(1)} m² is too small`);
  if (area > 500_000) errs.push(`${label}: footprint area ${Math.round(area)} m² is too large (max 500000)`);
  const pad = 0.01; // ~1 km slack: parts may poke out of the owning tile
  if (r.some(([lon, lat]) => lon < tile[0] - pad || lon > tile[2] + pad || lat < tile[1] - pad || lat > tile[3] + pad)) {
    errs.push(`${label}: footprint wanders more than ~1 km outside the tile`);
  }
  return errs;
};

/** Validate one raw change against the tile's OSM base. */
export interface ValidateOptions {
  /** Max rule bbox span in degrees (smaller for new/low-trust contributors). */
  ruleMaxSpanDeg?: number;
}

const isEmptyDeep = (v: unknown): boolean =>
  v == null || (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(isEmptyDeep));

function vertexCount(c: ChangeT): number {
  if (c.kind === "ground") return c.area.length + (c.holes ?? []).reduce((n, h) => n + h.length, 0);
  if (c.kind !== "building") return 0;
  const s = c.spec;
  return (s.footprint?.length ?? 0) + (s.parts ?? []).reduce((n, p) => n + p.footprint.length, 0)
    + (s.towers ?? []).reduce((n, t) => n + (Array.isArray(t.at) ? t.at.length : 0), 0);
}

function pointInRingLL(p: LL, ring: LL[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function validateChange(raw: unknown, base: BaseTile, opts: ValidateOptions = {}): ValidationResult {
  const size = JSON.stringify(raw ?? null).length;
  if (size > LIMITS.maxChangeBytes) return { ok: false, errors: [`change is ${size} bytes; max ${LIMITS.maxChangeBytes}`], warnings: [] };
  const parsed = Change.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`), warnings: [] };
  }
  const c = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (vertexCount(c) > LIMITS.maxChangeVertices) errors.push(`too many footprint points (${vertexCount(c)}); max ${LIMITS.maxChangeVertices}`);
  if (!c.sources.length) errors.push("sources is required: list the photos/pages you based this on");
  const known = new Set(base.buildings.map((b) => b.id));

  if (c.kind === "building" || c.kind === "asset") {
    if (c.target.startsWith("n:")) {
      if (c.kind === "building") {
        const fp = c.spec.footprint ?? c.spec.parts?.[0]?.footprint;
        if (!fp) errors.push("new building (n:...) needs spec.footprint or spec.parts");
        else {
          const cen = ringCentroid(fp);
          if (!pointInBBox(cen[0], cen[1], base.bbox)) errors.push("new building's footprint centre is outside this tile");
        }
      }
    } else if (!known.has(c.target)) {
      errors.push(`target ${c.target} is not a building in tile ${base.tile} (use ids from buildings.md)`);
    }
  }

  if (c.kind === "building") {
    const s = c.spec;
    if (s.footprint) errors.push(...ringIssues(s.footprint, "spec.footprint", base.bbox));
    s.parts?.forEach((p, i) => {
      errors.push(...ringIssues(p.footprint, `spec.parts[${i}].footprint`, base.bbox));
      if (p.minHeight != null && p.height != null && p.minHeight >= p.height) errors.push(`spec.parts[${i}]: minHeight must be below height`);
    });
    if (s.minHeight != null && s.height != null && s.minHeight >= s.height) errors.push("spec: minHeight must be below height");
    s.towers?.forEach((t, i) => {
      if (t.minHeight != null && t.minHeight >= t.height) errors.push(`spec.towers[${i}]: minHeight must be below height`);
      if (Array.isArray(t.at)) for (const [lon, lat] of t.at) {
        if (lon < base.bbox[0] - 0.01 || lon > base.bbox[2] + 0.01 || lat < base.bbox[1] - 0.01 || lat > base.bbox[3] + 0.01) errors.push(`spec.towers[${i}].at: position is far outside this tile`);
      }
    });
    if (s.height != null && s.floors != null && s.floors > 0) {
      const per = (s.height - (s.minHeight ?? 0)) / s.floors;
      if (per < 2 || per > 12) warnings.push(`spec: height/floors = ${per.toFixed(1)} m per floor looks wrong`);
    }
    if (isEmptyDeep({ ...s, name: undefined })) errors.push("spec describes nothing about the building (set heights, facade, roof, parts or towers)");
  }

  if (c.kind === "rule") {
    const b = c.scope.bbox as BBox;
    if (!(b[0] < b[2] && b[1] < b[3])) errors.push("scope.bbox must be [west, south, east, north] with west<east, south<north");
    const span = opts.ruleMaxSpanDeg ?? LIMITS.ruleMaxSpanDeg;
    if (b[2] - b[0] > span || b[3] - b[1] > span) errors.push(`scope.bbox may span at most ${span}° each way${span < LIMITS.ruleMaxSpanDeg ? " for new contributors (grows as your work gets approved)" : ""}`);
    if (!bboxIntersects(b, base.bbox)) errors.push("scope.bbox must overlap the tile you are working on");
    const sel = Object.entries(c.select.tags);
    if (!sel.length) errors.push("select.tags must have at least one tag (e.g. {\"building\":\"house\"})");
    else if (sel.every(([, v]) => v === "*" || v.startsWith("!"))) errors.push("select.tags must name at least one concrete value (e.g. \"building\": \"house|residential\"); \"*\" alone would restyle landmarks too");
    if (isEmptyDeep(c.set)) errors.push("set is empty");
  }

  if (c.kind === "ground") {
    const cen = ringCentroid(c.area);
    if (!pointInBBox(cen[0], cen[1], base.bbox)) errors.push("the ground area's centre is outside this tile (it belongs to the tile containing its centre)");
    const area = Math.abs(ringAreaM2(c.area));
    if (area < 4) errors.push(`area is ${area.toFixed(1)} m²: too small`);
    if (area > 100_000) errors.push(`area is ${Math.round(area)} m² (max 100000): split it, or leave big parks to OSM`);
    const pad = 0.01;
    if (c.area.some(([lon, lat]) => lon < base.bbox[0] - pad || lon > base.bbox[2] + pad || lat < base.bbox[1] - pad || lat > base.bbox[3] + pad)) errors.push("area wanders more than ~1 km outside the tile");
    // Most ground lies between buildings: warn if it mostly covers a building
    const inside = base.buildings.filter((b) => !b.isPart && b.polygons.some((p) => pointInRingLL(cen, p.outer) && !p.holes.some((h) => pointInRingLL(cen, h))));
    if (inside.length) warnings.push(`its centre is inside building ${inside[0].id}; ground goes in courtyards and open spaces, not under roofs`);
  }

  if (c.kind === "asset") {
    const { lon, lat } = c.transform;
    const pad = 0.01;
    if (!pointInBBox(lon, lat, [base.bbox[0] - pad, base.bbox[1] - pad, base.bbox[2] + pad, base.bbox[3] + pad])) errors.push("asset transform lon/lat is not in or near this tile");
  }

  return { ok: errors.length === 0, change: c, errors, warnings };
}

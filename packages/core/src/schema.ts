import { z } from "zod";

// ---------------------------------------------------------------------------
// Building style: the declarative description agents write. The viewer turns
// it into geometry, so agents never have to produce meshes for ordinary
// buildings. Every field is optional; whatever is missing falls through to the
// layer below (rules → OSM tags → defaults).
// ---------------------------------------------------------------------------

export const MATERIALS = ["plaster", "brick", "concrete", "glass", "stone", "wood", "metal", "marble", "tile"] as const;
export const ROOF_SHAPES = ["flat", "gabled", "hipped", "pyramidal", "skillion", "dome", "onion", "none"] as const;
export const WINDOW_PATTERNS = ["grid", "bands", "curtain", "sparse", "arched", "none"] as const;
export const GROUND_FLOORS = ["plain", "shopfront", "arcade", "glass"] as const;

export const Hex = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, "colour must be #rrggbb").transform((v) => v.length === 4 ? "#" + v.slice(1).split("").map((c) => c + c).join("") : v);
export const LonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-85.06).max(85.06)]);
export const Ring = z.array(LonLat).min(3).max(500);

export const Facade = z.strictObject({
  material: z.enum(MATERIALS).optional(),
  color: Hex.optional(),
  /** Accent colour for trims, balcony slabs, window frames. */
  trim: Hex.optional(),
  windows: z.strictObject({
    pattern: z.enum(WINDOW_PATTERNS).optional(),
    color: Hex.optional(),
    /** 0..1: fraction of each bay that is window. */
    density: z.number().min(0).max(1).optional(),
    /** Horizontal spacing between window bays in metres. */
    bay: z.number().min(1).max(20).optional(),
  }).optional(),
});

export const Roof = z.strictObject({
  shape: z.enum(ROOF_SHAPES).optional(),
  /** Roof height in metres above the wall top. */
  height: z.number().min(0).max(300).optional(),
  color: Hex.optional(),
  material: z.enum(MATERIALS).optional(),
  /** Ridge direction in degrees clockwise from north (gabled/skillion). */
  direction: z.number().min(0).max(360).optional(),
});

export const GroundFloor = z.strictObject({
  kind: z.enum(GROUND_FLOORS).optional(),
  color: Hex.optional(),
  height: z.number().min(2).max(12).optional(),
});

/**
 * Real 3D models for a building, fitted to its footprint. In a rule this is a typology set
 * ("every house here is one of these 12 models"): each building picks the variant whose
 * proportions match its footprint best. Models are uploaded .glb files (see `se model`).
 */
export const ModelRef = z.strictObject({
  assets: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(24),
  /** stretch: scale to the footprint's bounding rectangle and the building height.
   *  uniform: keep proportions, fit inside the rectangle. */
  /** none: real size, no scaling: the model was built on `params.footprint` (see `se model --target`),
   *  so its origin is the footprint's bounding-box centre and −Z is north (heading 0). */
  fit: z.enum(["stretch", "uniform", "none"]).default("stretch"),
  /** Compass direction (degrees) the model's front (−Z) faces, e.g. 180 = facing south.
   *  Omit to face the nearest street. Use it for landmarks so they never come out reversed. */
  heading: z.number().min(0).max(360).optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const Style = z.strictObject({
  /** Wall-top height above ground in metres (excludes roof). */
  height: z.number().min(0).max(1000).optional(),
  minHeight: z.number().min(0).max(1000).optional(),
  floors: z.number().int().min(0).max(250).optional(),
  floorHeight: z.number().min(2).max(12).optional(),
  facade: Facade.optional(),
  roof: Roof.optional(),
  groundFloor: GroundFloor.optional(),
  model: ModelRef.optional(),
});
export type Style = z.infer<typeof Style>;

export const Part = Style.extend({ footprint: Ring });
export type Part = z.infer<typeof Part>;

/**
 * Round towers placed relative to the footprint: minarets, spires, chimneys, extra domes.
 * `at: "corners"` puts one at each corner of the footprint's bounding rectangle;
 * `at: "centre"` one in the middle; or give explicit [lon, lat] positions.
 */
export const Tower = z.strictObject({
  at: z.union([
    z.enum(["corners", "centre", "ends", "end-north", "end-south", "end-east", "end-west"]),
    z.array(LonLat).min(1).max(12),
    LonLat.transform((p) => [p]),
  ]),
  /** With "corners": 4 (default), 6 (adds the middle of both long sides) or 8 (adds all side midpoints). */
  count: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(),
  /** Total height of the shaft (top of walls) in metres above ground. */
  height: z.number().min(1).max(1000),
  /** Shaft radius in metres. */
  radius: z.number().min(0.3).max(40).default(2),
  /** Pull "corners"/"ends" towers inwards (metres) so they sit on the building. */
  inset: z.number().min(-20).max(40).optional(),
  minHeight: z.number().min(0).max(1000).optional(),
  facade: Facade.optional(),
  roof: Roof.optional(),
});
export type Tower = z.infer<typeof Tower>;

export const BuildingSpec = Style.extend({
  name: z.string().max(200).optional(),
  towers: z.array(Tower).max(12).optional(),
  /** Replace the OSM footprint (or define one for a new building). */
  footprint: Ring.optional(),
  /** Stacked/stepped volumes. When present they replace the main volume. */
  parts: z.array(Part).max(60).optional(),
  /** Building no longer exists. */
  hidden: z.boolean().optional(),
});
export type BuildingSpec = z.infer<typeof BuildingSpec>;

export const SOURCE_KINDS = ["photo", "wikipedia", "wikidata", "wikimedia", "mapillary", "kartaview", "osm", "report", "website", "news", "other"] as const;
export const Source = z.strictObject({
  url: z.string().url().max(2000),
  kind: z.enum(SOURCE_KINDS).optional(),
  note: z.string().max(500).optional(),
});
export type Source = z.infer<typeof Source>;

/** OSM ids: w123 (way), r456 (relation). New buildings: n:<slug>. */
export const TargetId = z.string().regex(/^(?:[wr]\d{1,12}|n:[a-z0-9][a-z0-9-]{2,60})$/, "target must be w<id>, r<id> or n:<slug> (slug: lowercase letters, digits and hyphens, 3–61 chars, e.g. n:clock-tower)");

export const BBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** Scoped override: "within this box, every feature whose OSM tags match gets this style". */
export const RuleSelect = z.strictObject({
  /** All must match. Value "*" means the key just has to exist. */
  tags: z.record(z.string().max(60), z.string().max(120)),
});

export const BuildingChange = z.strictObject({
  kind: z.literal("building"),
  target: TargetId,
  spec: BuildingSpec,
  sources: z.array(Source).max(20).default([]),
  note: z.string().max(1000).optional(),
});

export const RuleChange = z.strictObject({
  kind: z.literal("rule"),
  label: z.string().min(3).max(120),
  scope: z.strictObject({ bbox: BBoxSchema }),
  select: RuleSelect,
  set: Style,
  sources: z.array(Source).max(20).default([]),
  note: z.string().max(1000).optional(),
});

export const AssetChange = z.strictObject({
  kind: z.literal("asset"),
  target: TargetId,
  assetKey: z.string().regex(/^[0-9a-f]{64}$/),
  transform: z.strictObject({
    lon: z.number().min(-180).max(180),
    lat: z.number().min(-85.06).max(85.06),
    /** Degrees clockwise from north that the model's -Z axis faces. */
    heading: z.number().min(0).max(360).default(0),
    scale: z.number().min(0.01).max(100).default(1),
    altitude: z.number().min(-50).max(1000).default(0),
  }),
  sources: z.array(Source).max(20).default([]),
  note: z.string().max(1000).optional(),
});

export const Change = z.discriminatedUnion("kind", [BuildingChange, RuleChange, AssetChange]);
export type Change = z.infer<typeof Change>;
export type ChangeInput = z.input<typeof Change>;
export type BuildingChange = z.infer<typeof BuildingChange>;
export type RuleChange = z.infer<typeof RuleChange>;
export type AssetChange = z.infer<typeof AssetChange>;

/** A change as stored and served: payload plus provenance. */
export interface StoredChange {
  id: number;
  tile: string;
  author: string;
  createdAt: number;
  change: Change;
}

export const LIMITS = {
  /** Max span (degrees) of a rule's bbox: roughly city-district scale. */
  ruleMaxSpanDeg: 0.5,
  maxChangesPerSubmit: 200,
  maxChangesPerHour: 3000,
  maxAssetBytes: 8 * 1024 * 1024,
  maxAssetTriangles: 200_000,
  maxAssetsPerDay: 60,
  leaseMinutes: 45,
  /** Max serialized size of one change (JSON bytes). */
  maxChangeBytes: 64 * 1024,
  /** Max total footprint vertices in one change (footprint + all parts + tower positions). */
  maxChangeVertices: 3000,
  /** Rules by contributors below this trust are limited to a smaller span. */
  trustedRuleSpanDeg: 0.5,
  newRuleSpanDeg: 0.06,
  trustForWideRules: 3,
  /** A finished tile below this completeness goes to needs_work instead of done. */
  doneQuality: 0.7,
  maxLeasesPerContributor: 3,
  /** Done tiles older than this re-enter the pool (lowest priority) for a refresh/review. */
  staleAfterDays: 180,
  maxReportMediaBytes: 25 * 1024 * 1024,
  maxReportMedia: 4,
} as const;

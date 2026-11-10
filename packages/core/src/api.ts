// Shapes of API responses shared by server, CLI and viewer.
import type { BaseTile } from "./osm.js";
import type { StoredChange } from "./schema.js";

export type TileStatus = "open" | "leased" | "done" | "needs_work";

export interface TileNote { author: string; text: string; createdAt: number }

export interface TileBundle {
  base: BaseTile;
  changes: StoredChange[];
  status: {
    status: TileStatus; reported: boolean; doneBy?: string;
    /** 0..1 completeness from the last finish (see core/quality.ts). */
    quality?: number | null;
    /** Why the tile needs more work (low quality, report, failed review, stale…). */
    reason?: string | null;
    reviews?: { ok: number; failed: number };
  };
  notes?: TileNote[];
  /** Unverified names visitors suggested for unnamed buildings: target → name. */
  names?: Record<string, string>;
}

export interface ReportInfo {
  id: number; tile: string; lat: number; lon: number; target?: string | null;
  message: string; media: string[]; createdAt: number; status: "open" | "resolved";
}

export interface ClaimResponse {
  tile: string; bbox: [number, number, number, number]; leaseExpires: number;
  /** Secret for this lease; send it as `x-lease` on submit/heartbeat/release/review. */
  leaseId: string;
  kind: "build" | "review";
  /** Largest rule bbox span (degrees) this contributor may submit; grows with trust. */
  ruleMaxSpanDeg: number;
  reason: string; reports: ReportInfo[]; buildingCount: number;
  notes: TileNote[];
}

export interface LeaderboardRow { name: string; buildings: number; rules: number; assets: number; tiles: number; areaKm2: number; reviews: number; quality: number }


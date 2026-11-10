import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  LIMITS, TargetId, fetchBaseBlock, inspectGlb, isValidTile, lonLatToTile, parseTileKey, pickSeedCity, resolveBuildings,
  ringsForRadius, sha256Hex, tileAreaKm2, tileBBox, tileCenter, tileKey, tileQuality, tileRing, validateChange,
  type BaseTile, type Change, type ClaimResponse, type LeaderboardRow, type ReportInfo, type StoredChange, type TileBundle,
  type TileId, type TileNote, type TileStatus,
} from "@seeearth/core";

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
}
type C = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-lease"], allowMethods: ["GET", "POST", "OPTIONS"] }));
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const now = () => Date.now();
const LEASE_MS = LIMITS.leaseMinutes * 60_000;
const DAY = 24 * 3600_000;
const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const ipOf = (c: C) => c.req.header("cf-connecting-ip") ?? "local";

// ---------------------------------------------------------------- helpers

/** Fixed-window rate limit. Throws 429 when `key` exceeds `max` hits in `windowMs`. */
async function rateHit(env: Env, key: string, windowMs: number, max: number, cost = 1, msg = "rate limit reached; try again later") {
  const win = Math.floor(now() / windowMs) * windowMs;
  const r = await env.DB.prepare("INSERT INTO rate (key, win, n) VALUES (?, ?, ?) ON CONFLICT (key, win) DO UPDATE SET n = n + excluded.n RETURNING n")
    .bind(key, win, cost).first<{ n: number }>();
  if ((r?.n ?? 0) > max) throw new HttpError(429, msg);
}

async function me(c: C): Promise<{ id: number; name: string; trust: number }> {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "missing token: run `npm run se -- login --name <name>`");
  const row = await c.env.DB.prepare("SELECT id, name, banned, trust FROM contributors WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ id: number; name: string; banned: number; trust: number }>();
  if (!row) throw new HttpError(401, "unknown token");
  if (row.banned) throw new HttpError(403, "this contributor has been banned");
  return { id: row.id, name: row.name, trust: row.trust };
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
function requireAdmin(c: C) {
  const t = c.env.ADMIN_TOKEN;
  if (!t || !safeEqual(c.req.header("authorization") ?? "", `Bearer ${t}`)) throw new HttpError(403, "admin only");
}

function parseKey(k: string): TileId {
  try { return parseTileKey(k); } catch (e) { throw new HttpError(400, String((e as Error).message)); }
}
const tileParam = (c: C) => parseKey(c.req.param("key") ?? "");

async function body<T>(c: C, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

const BASE_VERSION = "v2";
const BASE_MAX_AGE = 30 * DAY;

/** OSM base for a tile, cached in R2 (refreshed monthly). Fetched from Overpass in 2×2 blocks. */
const inflight = new Map<string, Promise<BaseTile[]>>();
async function getBase(env: Env, t: TileId, opts: { anonymous?: boolean } = {}): Promise<BaseTile> {
  const key = `base/${BASE_VERSION}/${tileKey(t)}.json`;
  const obj = await env.BUCKET.get(key);
  let stale: BaseTile | null = null;
  if (obj) {
    stale = await obj.json<BaseTile>();
    if (now() - stale.fetchedAt < BASE_MAX_AGE) return stale;
  }
  const bk = tileKey({ x: t.x - (t.x % 2), y: t.y - (t.y % 2) });
  let p = inflight.get(bk);
  if (!p) {
    // Global budget so browsing (or a script walking tile keys) can't get us blocked by Overpass.
    try { await rateHit(env, "overpass", 60_000, opts.anonymous ? 20 : 40); }
    catch { if (stale) return stale; throw new HttpError(503, "this area hasn't been loaded yet and the map source is busy; try again in a minute"); }
    p = fetchBaseBlock(t).then(async (tiles) => {
      await Promise.all(tiles.map((b) => env.BUCKET.put(`base/${BASE_VERSION}/${b.tile}.json`, JSON.stringify(b), { httpMetadata: { contentType: "application/json" } })));
      return tiles;
    }).finally(() => inflight.delete(bk));
    inflight.set(bk, p);
  }
  try {
    return (await p).find((b) => b.tile === tileKey(t))!;
  } catch (e) {
    if (stale) return stale;
    throw new HttpError(503, `OpenStreetMap (Overpass) is busy, retry in a minute: ${(e as Error).message}`);
  }
}

const buildingCount = (b: BaseTile) => b.buildings.filter((x) => !x.hasParts).length;

interface ChangeRow { id: number; tile: string; payload: string; created_at: number; author_name: string; status?: string; seq?: number }
const toStored = (r: ChangeRow): StoredChange => ({ id: r.id, tile: r.tile, author: r.author_name, createdAt: r.created_at, change: JSON.parse(r.payload) as Change });

async function liveChangesForTile(env: Env, t: TileId): Promise<StoredChange[]> {
  const [w, s, e, n] = tileBBox(t);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.tile, c.payload, c.created_at, k.name AS author_name FROM changes c JOIN contributors k ON k.id = c.author
     WHERE c.status = 'live' AND ((c.tile = ?1 AND c.kind != 'rule') OR (c.kind = 'rule' AND c.w <= ?4 AND c.e >= ?2 AND c.s <= ?5 AND c.n >= ?3))
     ORDER BY c.id`,
  ).bind(tileKey(t), w, s, e, n).all<ChangeRow>();
  return results.map(toStored);
}

interface TileRow {
  key: string; x: number; y: number; status: TileStatus; prev_status: TileStatus | null; lease_kind: string | null; lease_id: string | null;
  lease_holder: number | null; lease_expires: number | null; leased_at: number | null; done_by: number | null; done_at: number | null;
  building_count: number | null; quality: number | null; reason: string | null; reported: number; reviews_ok: number; reviews_failed: number;
  done_by_name?: string | null;
}
async function tileRow(env: Env, key: string) {
  return env.DB.prepare("SELECT t.*, k.name AS done_by_name FROM tiles t LEFT JOIN contributors k ON k.id = t.done_by WHERE t.key = ?").bind(key).first<TileRow>();
}
/** Status as the world should see it: an expired lease falls back to what the tile was before. */
const effectiveStatus = (r: TileRow | null): TileStatus =>
  !r ? "open" : r.status === "leased" && (r.lease_expires ?? 0) < now() ? (r.prev_status ?? "open") : r.status;

async function ensureTileRow(env: Env, t: TileId) {
  await env.DB.prepare("INSERT OR IGNORE INTO tiles (key, x, y, status, updated_at) VALUES (?, ?, ?, 'open', ?)").bind(tileKey(t), t.x, t.y, now()).run();
}

const LEASE_GRACE_MS = 10 * 60_000;
/** Return abandoned leases to their previous state so no tile gets stuck as "leased". */
async function sweepExpired(env: Env) {
  await env.DB.prepare(
    "UPDATE tiles SET status = COALESCE(prev_status, 'open'), prev_status = NULL, lease_id = NULL, lease_holder = NULL, lease_kind = NULL, lease_expires = NULL WHERE status = 'leased' AND lease_expires < ?",
  ).bind(now() - LEASE_GRACE_MS).run();
}

/** Atomically lease a tile for building or reviewing. Returns the lease id, or null if not available. */
async function tryLease(env: Env, t: TileId, who: number, kind: "build" | "review", opts: { improveDone?: boolean } = {}): Promise<string | null> {
  await ensureTileRow(env, t);
  const leaseId = randomHex(16);
  // Done tiles can be claimed again to improve them (add models, fix details), but only on request.
  const states = opts.improveDone ? "'open', 'needs_work', 'done'" : "'open', 'needs_work'";
  const can = kind === "build"
    ? `(status IN (${states}) OR (status = 'leased' AND lease_expires < ?4 AND COALESCE(prev_status, 'open') IN (${states})))`
    : `(status = 'done' OR (status = 'leased' AND lease_expires < ?4 AND prev_status = 'done'))
       AND building_count > 0 AND done_by IS NOT NULL AND done_by != ?2
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.tile = tiles.key AND r.reviewer = ?2 AND r.created_at >= COALESCE(tiles.done_at, 0))
       AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.tile = tiles.key AND c.author = ?2 AND c.status = 'live')`;
  const r = await env.DB.prepare(
    `UPDATE tiles SET prev_status = CASE WHEN status = 'leased' THEN prev_status ELSE status END, status = 'leased',
       lease_kind = ?5, lease_id = ?6, lease_holder = ?2, lease_expires = ?3, leased_at = ?4, updated_at = ?4
     WHERE key = ?1 AND ${can}`,
  ).bind(tileKey(t), who, now() + LEASE_MS, now(), kind, leaseId).run();
  return (r.meta.changes ?? 0) > 0 ? leaseId : null;
}

/** Check the caller holds this tile's lease (x-lease header). Renews an expired lease nobody took. */
async function requireLease(c: C, key: string, who: number, kind: "build" | "review"): Promise<TileRow & { leaseId: string }> {
  const leaseId = c.req.header("x-lease") ?? "";
  const row = await tileRow(c.env, key);
  if (!row || row.status !== "leased" || row.lease_holder !== who || !leaseId || !safeEqual(row.lease_id ?? "", leaseId)) {
    throw new HttpError(409, `you don't hold tile ${key} (or another session of yours does); run claim again`);
  }
  if (row.lease_kind !== kind) throw new HttpError(409, `this is a ${row.lease_kind} lease; use the ${row.lease_kind} commands`);
  // Every authenticated action renews the lease, so it can't expire mid-request.
  await c.env.DB.prepare("UPDATE tiles SET lease_expires = ? WHERE key = ? AND lease_id = ?").bind(now() + LEASE_MS, key, leaseId).run();
  return { ...row, leaseId };
}

async function openReports(env: Env, key: string): Promise<ReportInfo[]> {
  const { results } = await env.DB.prepare("SELECT * FROM reports WHERE tile = ? AND status = 'open' ORDER BY id LIMIT 30").bind(key).all<any>();
  return results.map((r) => ({ id: r.id, tile: r.tile, lat: r.lat, lon: r.lon, target: r.target, message: r.message, media: JSON.parse(r.media).map((m: string) => `/api/media/${m}`), createdAt: r.created_at, status: r.status }));
}

async function tileNotes(env: Env, key: string): Promise<TileNote[]> {
  const { results } = await env.DB.prepare("SELECT n.text, n.created_at, k.name FROM notes n JOIN contributors k ON k.id = n.author WHERE n.tile = ? ORDER BY n.id DESC LIMIT 20").bind(key).all<{ text: string; created_at: number; name: string }>();
  return results.map((r) => ({ author: r.name, text: r.text, createdAt: r.created_at }));
}

/** Mark a tile as needing work (keeps serving the current version). */
function needsWorkStmt(env: Env, key: string, reason: string, reported: boolean) {
  return env.DB.prepare(
    `UPDATE tiles SET reason = ?2, reported = CASE WHEN ?3 THEN 1 ELSE reported END,
       status = CASE WHEN status = 'leased' THEN status ELSE 'needs_work' END,
       prev_status = CASE WHEN status = 'leased' THEN 'needs_work' ELSE prev_status END, updated_at = ?4
     WHERE key = ?1`,
  ).bind(key, reason.slice(0, 300), reported ? 1 : 0, now());
}

const nextSeq = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM changes)";

// ---------------------------------------------------------------- contributors

app.post("/api/contributors", async (c) => {
  const { name: raw } = await body(c, z.object({ name: z.string() }));
  const name = raw.trim();
  if (!/^[\p{L}\p{N}_ .\-]{2,32}$/u.test(name)) throw new HttpError(400, "name must be 2-32 letters, numbers, spaces, _ . -");
  await rateHit(c.env, `register|${ipOf(c)}`, 3600_000, 5, 1, "too many new contributors from your network this hour");
  const token = randomHex(24);
  try {
    await c.env.DB.prepare("INSERT INTO contributors (name, token_hash, created_at, created_ip) VALUES (?, ?, ?, ?)").bind(name, await sha256Hex(token), now(), ipOf(c)).run();
  } catch {
    throw new HttpError(409, `the name "${name}" is taken; pick another (or log in with the token you got when you first registered it)`);
  }
  return c.json({ name, token });
});

app.get("/api/me", async (c) => {
  const who = await me(c);
  const { results } = await c.env.DB.prepare("SELECT key, lease_kind, lease_expires FROM tiles WHERE status = 'leased' AND lease_holder = ? AND lease_expires > ?").bind(who.id, now()).all();
  return c.json({ ...who, leases: results });
});

// ---------------------------------------------------------------- claiming work

const ClaimBody = z.object({
  lon: z.number().min(-180).max(180).optional(),
  lat: z.number().min(-85).max(85).optional(),
  radiusKm: z.number().min(1).max(300).optional(),
  tile: z.string().optional(),
  /** build = map a tile; review = check someone else's finished tile; auto = server decides (mostly build). */
  kind: z.enum(["build", "review", "auto"]).default("auto"),
});


app.post("/api/claim", async (c) => {
  const who = await me(c);
  const b = await body(c, ClaimBody);
  const env = c.env;
  await sweepExpired(env);
  const respond = async (t: TileId, leaseId: string, kind: "build" | "review", reason: string) => {
    try { return c.json(await claimResponse(env, t, leaseId, kind, reason, who.trust)); }
    catch (e) {
      // Never leave a lease behind for a claim the caller didn't receive.
      await env.DB.prepare("UPDATE tiles SET status = COALESCE(prev_status, 'open'), prev_status = NULL, lease_id = NULL, lease_holder = NULL, lease_kind = NULL, lease_expires = NULL WHERE key = ? AND lease_id = ?").bind(tileKey(t), leaseId).run();
      throw e;
    }
  };

  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM tiles WHERE status = 'leased' AND lease_holder = ? AND lease_expires > ?").bind(who.id, now()).first<{ n: number }>();
  if ((active?.n ?? 0) >= LIMITS.maxLeasesPerContributor) throw new HttpError(409, `you already hold ${active!.n} tiles; finish or release one first (npm run se -- status)`);

  if (b.tile) {
    const t = parseKey(b.tile);
    const kind = b.kind === "review" ? "review" : "build";
    const row = await tileRow(env, tileKey(t));
    // Retrying a claim you already hold (e.g. after a timeout) hands the same lease back.
    if (row?.status === "leased" && row.lease_holder === who.id && (row.lease_expires ?? 0) > now() && row.lease_id) {
      return respond(t, row.lease_id, (row.lease_kind as "build" | "review") ?? kind, "you already hold this tile");
    }
    if (kind === "review" && row?.done_by === who.id) throw new HttpError(409, "you can't review a tile you finished");
    const leaseId = await tryLease(env, t, who.id, kind, { improveDone: true });
    if (!leaseId) throw new HttpError(409, kind === "build" ? "someone is working on that tile right now; try again later" : "that tile isn't waiting for a review from you");
    return respond(t, leaseId, kind, `requested tile (${kind})`);
  }

  const hasCenter = b.lon != null && b.lat != null;
  const radiusKm = b.radiusKm ?? (hasCenter ? 25 : 15);

  // Reviews: other people's finished tiles, riskiest first. Mixed into normal work for
  // contributors who have finished a few tiles themselves.
  let wantReview = b.kind === "review";
  if (b.kind === "auto") {
    const done = await env.DB.prepare("SELECT COUNT(*) AS n FROM credits WHERE contributor = ?").bind(who.id).first<{ n: number }>();
    wantReview = (done?.n ?? 0) >= 3 && Math.random() < 0.2;
  }
  if (wantReview) {
    const r = await claimReview(env, who.id, hasCenter ? lonLatToTile(b.lon!, b.lat!) : null, hasCenter ? ringsForRadius(b.lat!, radiusKm) : 0);
    if (r) return respond(r.t, r.leaseId, "review", "review someone else's finished tile");
    if (b.kind === "review") throw new HttpError(404, "no finished tiles are waiting for review there; try without --near or claim normally");
  }

  let lon = b.lon, lat = b.lat, reason: string;
  if (!hasCenter) {
    // No preference: reported/failed-review areas anywhere first, then near a (population-weighted) random city.
    const rep = await env.DB.prepare("SELECT key FROM tiles WHERE status IN ('open', 'needs_work') AND reported = 1 ORDER BY random() LIMIT 5").all<{ key: string }>();
    for (const r of rep.results) {
      const t = parseKey(r.key);
      const id = await tryLease(env, t, who.id, "build");
      if (id) return respond(t, id, "build", "an area someone reported as wrong");
    }
    const [city, clon, clat] = pickSeedCity();
    lon = clon; lat = clat; reason = `random pick near ${city}`;
  } else reason = "nearest unfinished tile to your chosen place";

  const center = lonLatToTile(lon!, lat!);
  const R = Math.min(ringsForRadius(lat!, radiusKm), 150);
  const near = (rows: { x: number; y: number }[]) => rows.sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));

  // 1. Reported / failed-review tiles nearby.
  const rep = await env.DB.prepare(
    "SELECT x, y FROM tiles WHERE status IN ('open', 'needs_work') AND reported = 1 AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? LIMIT 200",
  ).bind(center.x - R, center.x + R, center.y - R, center.y + R).all<{ x: number; y: number }>();
  for (const r of near(rep.results).slice(0, 5)) {
    const id = await tryLease(env, r, who.id, "build");
    if (id) return respond(r, id, "build", "an area someone reported as wrong, near your chosen place");
  }

  // 2. About a third of the time, improve a partly finished tile nearby before opening new ground,
  //    so partial work keeps getting finished instead of waiting for the whole city to be covered.
  const partialNearby = () => env.DB.prepare(
    "SELECT x, y FROM tiles WHERE status = 'needs_work' AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? ORDER BY quality ASC LIMIT 20",
  ).bind(center.x - R, center.x + R, center.y - R, center.y + R).all<{ x: number; y: number }>();
  if (Math.random() < 0.33) {
    for (const r of near((await partialNearby()).results).slice(0, 5)) {
      const id = await tryLease(env, r, who.id, "build");
      if (id) return respond(r, id, "build", "a partly finished tile near your chosen place (improve it)");
    }
  }

  // 3. Untouched tiles, spiralling outwards. One indexed query fetches every touched tile in the
  //    box; untouched tiles have no row, so the spiral itself runs in memory.
  const { results: touched } = await env.DB.prepare(
    "SELECT key, status, prev_status, lease_expires, building_count FROM tiles WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?",
  ).bind(center.x - R, center.x + R, center.y - R, center.y + R).all<TileRow>();
  const known = new Map(touched.map((r) => [r.key, r]));
  let overpassBudget = 6;
  for (let ring = 0; ring <= R; ring++) {
    for (const t of near(tileRing(center, ring))) {
      const row = known.get(tileKey(t)) ?? null;
      if (effectiveStatus(row) !== "open" || row?.building_count === 0) continue;
      if (row?.building_count == null) {
        // Skip empty land/sea without making an agent look at it.
        const cached = await env.BUCKET.head(`base/${BASE_VERSION}/${tileKey(t)}.json`);
        if (!cached && overpassBudget-- <= 0) throw new HttpError(503, "still loading map data for this area (server busy); run claim again in a minute");
        const base = await getBase(env, t);
        await ensureTileRow(env, t);
        const n = buildingCount(base);
        await env.DB.prepare(`UPDATE tiles SET building_count = ?2 ${n === 0 ? ", status = 'done', quality = 1, done_at = ?3" : ""}, updated_at = ?3 WHERE key = ?1 AND status != 'leased'`).bind(tileKey(t), n, now()).run();
        if (n === 0) continue;
      }
      const id = await tryLease(env, t, who.id, "build");
      if (id) return respond(t, id, "build", reason);
    }
  }

  // 4. Partly finished tiles nearby, least complete first.
  for (const r of (await partialNearby()).results) {
    const id = await tryLease(env, r, who.id, "build");
    if (id) return respond(r, id, "build", "a partly finished tile near your chosen place (improve it)");
  }

  // 5. Nothing to build: offer a review instead of a dead end.
  const r = await claimReview(env, who.id, center, R);
  if (r) return respond(r.t, r.leaseId, "review", "nothing left to build nearby, so: review someone else's finished tile");
  throw new HttpError(404, `no unfinished tiles with buildings within ${radiusKm} km; widen --radius or try another place`);
});

async function claimReview(env: Env, who: number, center: TileId | null, R: number) {
  const area = center ? "AND t.x BETWEEN ?3 AND ?4 AND t.y BETWEEN ?5 AND ?6" : "";
  const stmt = env.DB.prepare(
    `SELECT t.x, t.y FROM tiles t JOIN contributors k ON k.id = t.done_by
     WHERE t.status = 'done' AND t.building_count > 0 AND t.done_by != ?1
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.tile = t.key AND r.reviewer = ?1 AND r.created_at > COALESCE(t.done_at, 0))
       AND (t.reviews_ok = 0 OR t.done_at < ?2 OR k.trust < 0) ${area}
     ORDER BY (k.trust < 0) DESC, t.reviews_ok ASC, t.done_at ASC LIMIT 5`,
  );
  const staleBefore = now() - LIMITS.staleAfterDays * DAY;
  const { results } = await (center ? stmt.bind(who, staleBefore, center.x - R, center.x + R, center.y - R, center.y + R) : stmt.bind(who, staleBefore)).all<{ x: number; y: number }>();
  for (const r of results) {
    const id = await tryLease(env, r, who, "review");
    if (id) return { t: { x: r.x, y: r.y }, leaseId: id };
  }
  return null;
}

async function claimResponse(env: Env, t: TileId, leaseId: string, kind: "build" | "review", reason: string, trust: number): Promise<ClaimResponse> {
  const row = await env.DB.prepare("SELECT lease_expires FROM tiles WHERE key = ?").bind(tileKey(t)).first<{ lease_expires: number }>();
  const base = await getBase(env, t);
  return {
    tile: tileKey(t), bbox: tileBBox(t), leaseExpires: row?.lease_expires ?? 0, leaseId, kind, reason,
    ruleMaxSpanDeg: trust >= LIMITS.trustForWideRules ? LIMITS.trustedRuleSpanDeg : LIMITS.newRuleSpanDeg,
    reports: await openReports(env, tileKey(t)), buildingCount: buildingCount(base), notes: await tileNotes(env, tileKey(t)),
  };
}

app.post("/api/tiles/:key/heartbeat", async (c) => {
  const who = await me(c);
  const key = tileKey(tileParam(c));
  const row = await tileRow(c.env, key);
  await requireLease(c, key, who.id, (row?.lease_kind as "build" | "review") ?? "build");
  return c.json({ ok: true, leaseExpires: now() + LEASE_MS });
});

const Notes = z.array(z.string().trim().min(3).max(500)).max(8).default([]);

app.post("/api/tiles/:key/release", async (c) => {
  const who = await me(c);
  const t = tileParam(c), key = tileKey(t);
  const row = await tileRow(c.env, key);
  const kind = (row?.lease_kind as "build" | "review") ?? "build";
  const lease = await requireLease(c, key, who.id, kind);
  const b = await body(c, z.object({ done: z.boolean().default(false), notes: Notes }));
  const notes = b.notes.map((text) => c.env.DB.prepare("INSERT INTO notes (tile, author, text, created_at) VALUES (?, ?, ?, ?)").bind(key, who.id, text, now()));
  const back = c.env.DB.prepare("UPDATE tiles SET status = COALESCE(prev_status, 'open'), prev_status = NULL, lease_id = NULL, lease_holder = NULL, lease_expires = NULL, lease_kind = NULL, updated_at = ? WHERE key = ? AND lease_id = ?").bind(now(), key, lease.leaseId);

  if (kind === "review" || !b.done) {
    await c.env.DB.batch([...notes, back]);
    return c.json({ ok: true, status: lease.prev_status ?? "open" });
  }

  // Finishing a build: score it. Below the bar it stays in the pool as needs_work.
  const base = await getBase(c.env, t);
  const changes = await liveChangesForTile(c.env, t);
  const q = tileQuality(base, changes);
  const { results: mineRows } = await c.env.DB.prepare("SELECT id, target FROM changes WHERE tile = ? AND author = ? AND created_at >= ? AND status = 'live'").bind(key, who.id, lease.leased_at ?? 0).all<{ id: number; target: string | null }>();
  const mineIds = new Set(mineRows.map((r) => r.id));
  const worked = mineIds.size > 0;
  // Credit only what this lease added: completeness with vs. without this contributor's new changes.
  const gained = worked ? Math.max(0, q.score - tileQuality(base, changes.filter((ch) => !mineIds.has(ch.id))).score) : 0;
  const touched = [...new Set(mineRows.map((r) => r.target).filter((t): t is string => !!t))];
  const done = q.score >= LIMITS.doneQuality;
  const reason = done ? null : `partial: completeness ${Math.round(q.score * 100)}%${q.missing.length ? `; landmarks without a description: ${q.missing.slice(0, 8).join(", ")}` : ""}${q.ordinary && q.ordinaryCovered < q.ordinary ? `; ${q.ordinary - q.ordinaryCovered} ordinary buildings not covered by any area rule` : ""}`;
  const area = tileAreaKm2(t);
  await c.env.DB.batch([
    ...notes,
    c.env.DB.prepare(
      `UPDATE tiles SET status = ?2, prev_status = NULL, lease_id = NULL, lease_holder = NULL, lease_expires = NULL, lease_kind = NULL,
         done_by = CASE WHEN ?3 THEN ?4 ELSE done_by END, done_at = CASE WHEN ?2 = 'done' THEN ?5 ELSE done_at END,
         building_count = ?6, area_km2 = ?7, quality = ?8, reason = ?9, reported = 0, updated_at = ?5 WHERE key = ?1 AND lease_id = ?10`,
    ).bind(key, done ? "done" : "needs_work", worked ? 1 : 0, who.id, now(), buildingCount(base), area, q.score, reason, lease.leaseId),
    // Reports the agent could see (filed before it claimed) count as handled only if it changed the
    // reported building (or, for reports without a target, changed anything).
    c.env.DB.prepare(
      `UPDATE reports SET status = 'resolved' WHERE tile = ? AND status = 'open' AND created_at <= ? AND ?
         AND (target IS NULL OR target IN (SELECT value FROM json_each(?)))`,
    ).bind(key, lease.leased_at ?? 0, worked ? 1 : 0, JSON.stringify(touched)),
    ...(gained > 0 ? [c.env.DB.prepare("INSERT INTO credits (contributor, tile, delta, area_km2, created_at) VALUES (?, ?, ?, ?, ?)").bind(who.id, key, gained, area, now())] : []),
  ]);
  // Reports still open (filed during the lease, or not acted on) keep the tile in the queue.
  await c.env.DB.prepare("UPDATE tiles SET status = 'needs_work', reported = 1, reason = COALESCE(reason, 'open reports') WHERE key = ? AND EXISTS (SELECT 1 FROM reports WHERE tile = ? AND status = 'open')").bind(key, key).run();
  const after = await tileRow(c.env, key);
  return c.json({ ok: true, status: after?.status, quality: q, reason: after?.reason });
});

// ---------------------------------------------------------------- reviews & flags

const ReviewBody = z.object({
  verdict: z.enum(["approve", "needs_work"]),
  summary: z.string().trim().min(10).max(1000),
  problems: z.array(z.object({ target: TargetId.optional(), message: z.string().trim().min(5).max(1000) })).max(30).default([]),
});

app.post("/api/tiles/:key/review", async (c) => {
  const who = await me(c);
  const t = tileParam(c), key = tileKey(t);
  const lease = await requireLease(c, key, who.id, "review");
  const b = await body(c, ReviewBody);
  await rateHit(c.env, `review|${who.id}`, 3600_000, 20, 1, "review limit reached for this hour");
  if (b.verdict === "needs_work" && !b.problems.length) throw new HttpError(400, "list the problems you found (problems: [{target?, message}])");
  const [lon, lat] = tileCenter(t);
  // A reviewer can move one contributor's trust at most 3 times in 30 days (stops sock-puppet boosting).
  const pair = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE reviewer = ? AND subject = ? AND created_at > ?").bind(who.id, lease.done_by, now() - 30 * DAY).first<{ n: number }>();
  const trustCounts = (pair?.n ?? 0) < 3;
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT INTO reviews (tile, reviewer, subject, verdict, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(key, who.id, lease.done_by, b.verdict, b.summary, now()),
    c.env.DB.prepare(
      `UPDATE tiles SET lease_id = NULL, lease_holder = NULL, lease_expires = NULL, lease_kind = NULL, last_review_at = ?2,
         status = CASE WHEN reported = 1 OR prev_status = 'needs_work' THEN 'needs_work' ELSE 'done' END, prev_status = NULL, updated_at = ?2
       WHERE key = ?1 AND lease_id = ?3`,
    ).bind(key, now(), lease.leaseId),
  ];
  if (b.verdict === "approve") {
    stmts.push(c.env.DB.prepare("UPDATE tiles SET reviews_ok = reviews_ok + 1 WHERE key = ?").bind(key));
    if (lease.done_by && trustCounts) stmts.push(c.env.DB.prepare("UPDATE contributors SET trust = trust + 1 WHERE id = ?").bind(lease.done_by));
  } else {
    stmts.push(c.env.DB.prepare("UPDATE tiles SET reviews_failed = reviews_failed + 1 WHERE key = ?").bind(key));
    for (const p of b.problems) {
      stmts.push(c.env.DB.prepare("INSERT INTO reports (tile, lat, lon, target, message, source, author, created_at) VALUES (?, ?, ?, ?, ?, 'review', ?, ?)").bind(key, lat, lon, p.target ?? null, p.message, who.id, now()));
    }
    stmts.push(needsWorkStmt(c.env, key, `review: ${b.summary}`, true));
    if (lease.done_by && trustCounts) stmts.push(c.env.DB.prepare("UPDATE contributors SET trust = trust - 2 WHERE id = ?").bind(lease.done_by));
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, verdict: b.verdict });
});

/** Agents flag problems they notice in any tile (not just their own lease). */
app.post("/api/flags", async (c) => {
  const who = await me(c);
  const b = await body(c, z.object({ tile: z.string(), target: TargetId.optional(), message: z.string().trim().min(5).max(1000) }));
  await rateHit(c.env, `flag|${who.id}`, 3600_000, 30);
  const t = parseKey(b.tile);
  const [lon, lat] = tileCenter(t);
  await ensureTileRow(c.env, t);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO reports (tile, lat, lon, target, message, source, author, created_at) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?)").bind(tileKey(t), lat, lon, b.target ?? null, b.message, who.id, now()),
    needsWorkStmt(c.env, tileKey(t), "flagged by an agent", true),
    c.env.DB.prepare("UPDATE tiles SET status = 'open' WHERE key = ? AND status = 'needs_work' AND done_at IS NULL AND quality IS NULL").bind(tileKey(t)),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- contributions

app.post("/api/tiles/:key/changes", async (c) => {
  const who = await me(c);
  const t = tileParam(c), key = tileKey(t);
  await requireLease(c, key, who.id, "build");
  const b = await body(c, z.object({ changes: z.array(z.unknown()).min(1).max(LIMITS.maxChangesPerSubmit), keys: z.array(z.string().max(64)).optional() }));
  const list = b.changes;
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE author = ? AND created_at > ?").bind(who.id, now() - 3600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) + list.length > LIMITS.maxChangesPerHour) throw new HttpError(429, "hourly change limit reached; take a break");

  const base = await getBase(c.env, t);
  const bbox = tileBBox(t);
  const ruleMaxSpanDeg = who.trust >= LIMITS.trustForWideRules ? LIMITS.trustedRuleSpanDeg : LIMITS.newRuleSpanDeg;
  const results: { index: number; ok: boolean; id?: number; errors: string[]; warnings: string[] }[] = [];
  const stmts: D1PreparedStatement[] = [];
  const accepted: { index: number; key: string | null }[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = validateChange(list[i], base, { ruleMaxSpanDeg });
    if (v.ok && v.change) {
      const ch = v.change;
      const keys = ch.kind === "asset" ? [ch.assetKey] : (ch.kind === "rule" ? ch.set.model?.assets : ch.spec.model?.assets) ?? [];
      for (const k of keys) {
        const a = await c.env.DB.prepare("SELECT 1 AS ok FROM assets WHERE key = ?").bind(k).first<{ ok: number }>();
        if (!a) { v.ok = false; v.errors.push(`model ${k.slice(0, 12)}… not found: upload it first (npm run se -- model build … --upload)`); }
      }
    }
    results.push({ index: i, ok: v.ok, errors: v.errors, warnings: v.warnings });
    if (!v.ok || !v.change) continue;
    const ch = v.change;
    const [w, s, e, n] = ch.kind === "rule" ? ch.scope.bbox : bbox;
    const ck = b.keys?.[i] ?? null;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO changes (seq, tile, kind, target, payload, author, client_key, created_at, w, s, e, n)
       VALUES (${nextSeq}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (author, client_key) DO NOTHING RETURNING id`,
    ).bind(key, ch.kind, ch.kind === "rule" ? null : ch.target, JSON.stringify(ch), who.id, ck, now(), w, s, e, n));
    accepted.push({ index: i, key: ck });
  }
  // (requireLease already renewed the lease, even if everything below is rejected.)
  for (const a of accepted) {
    const ch = list[a.index] as { kind?: string; target?: string; spec?: { name?: string } };
    if (ch?.kind === "building" && ch.target && ch.spec?.name) {
      stmts.push(c.env.DB.prepare("UPDATE names SET status = CASE WHEN lower(name) = lower(?) THEN 'accepted' ELSE 'rejected' END WHERE tile = ? AND target = ? AND status = 'pending'").bind(ch.spec.name, key, ch.target));
    }
  }
  const out = stmts.length ? await c.env.DB.batch<{ id: number }>(stmts) : [];
  for (const [j, a] of accepted.entries()) {
    let id: number | undefined = out[j].results[0]?.id;
    if (id == null && a.key) id = (await c.env.DB.prepare("SELECT id FROM changes WHERE author = ? AND client_key = ?").bind(who.id, a.key).first<{ id: number }>())?.id;
    results[a.index].id = id;
  }
  return c.json({ accepted: accepted.length, rejected: list.length - accepted.length, results });
});

app.post("/api/assets", async (c) => {
  const who = await me(c);
  const len = Number(c.req.header("content-length") ?? NaN);
  if (!Number.isFinite(len) || len > LIMITS.maxAssetBytes) throw new HttpError(413, `send the .glb with a content-length of at most ${LIMITS.maxAssetBytes} bytes`);
  await rateHit(c.env, `asset|${who.id}`, DAY, LIMITS.maxAssetsPerDay, 1, `model upload limit reached for today (${LIMITS.maxAssetsPerDay}); reuse variants or continue tomorrow`);
  const buf = await c.req.arrayBuffer();
  const info = inspectGlb(buf, { maxBytes: LIMITS.maxAssetBytes, maxTriangles: LIMITS.maxAssetTriangles });
  if (!info.ok) throw new HttpError(400, info.errors.join("; "));
  const key = await sha256Hex(buf);
  await c.env.BUCKET.put(`assets/${key}.glb`, buf, { httpMetadata: { contentType: "model/gltf-binary" } });
  await c.env.DB.prepare("INSERT OR IGNORE INTO assets (key, owner, bytes, triangles, created_at) VALUES (?, ?, ?, ?, ?)").bind(key, who.id, info.bytes, info.triangles, now()).run();
  return c.json({ assetKey: key, triangles: info.triangles, bytes: info.bytes });
});

app.get("/api/assets/:file", async (c) => {
  const m = /^([0-9a-f]{64})\.glb$/.exec(c.req.param("file"));
  if (!m) throw new HttpError(404, "not found");
  const obj = await c.env.BUCKET.get(`assets/${m[1]}.glb`);
  if (!obj) throw new HttpError(404, "not found");
  return new Response(obj.body, { headers: { "content-type": "model/gltf-binary", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" } });
});

// ---------------------------------------------------------------- reading the world

app.get("/api/tiles/:key", async (c) => {
  const t = tileParam(c);
  const [base, changes, row, notes, names] = await Promise.all([getBase(c.env, t, { anonymous: true }), liveChangesForTile(c.env, t), tileRow(c.env, tileKey(t)), tileNotes(c.env, tileKey(t)), nameSuggestions(c.env, tileKey(t))]);
  const bundle: TileBundle = {
    base, changes, notes, names,
    status: {
      status: effectiveStatus(row), reported: !!row?.reported, quality: row?.quality ?? null, reason: row?.reason ?? null,
      reviews: { ok: row?.reviews_ok ?? 0, failed: row?.reviews_failed ?? 0 },
      ...(row?.done_by_name ? { doneBy: row.done_by_name } : {}),
    },
  };
  return c.json(bundle, 200, { "cache-control": "public, max-age=20" });
});

/**
 * Resolved buildings as GeoJSON: one Feature per volume, with the final height, materials and
 * colours after all layers. The easiest format for GIS tools and engine importers.
 */
app.get("/api/tiles/:key/buildings.geojson", async (c) => {
  const t = tileParam(c);
  const [base, changes] = await Promise.all([getBase(c.env, t, { anonymous: true }), liveChangesForTile(c.env, t)]);
  const features = [];
  for (const b of resolveBuildings({ buildings: base.buildings, changes })) {
    if (b.hidden) continue;
    for (const [i, v] of b.volumes.entries()) {
      features.push({
        type: "Feature",
        id: b.volumes.length > 1 ? `${b.id}#${i}` : b.id,
        geometry: { type: "MultiPolygon", coordinates: v.polygons.map((p) => [p.outer, ...p.holes]) },
        properties: {
          building: b.id, name: b.name ?? null, part: i,
          height: v.height, min_height: v.minHeight, floors: v.floors, floor_height: v.floorHeight,
          facade_material: v.facade.material, facade_color: v.facade.color, facade_trim: v.facade.trim ?? null,
          windows: v.facade.windows?.pattern ?? null, window_color: v.facade.windows?.color ?? null,
          roof_shape: v.roof.shape, roof_color: v.roof.color, roof_height: v.roof.height ?? null, roof_direction: v.roof.direction ?? null,
          ground_floor: v.groundFloor?.kind ?? null,
          asset: b.asset ? `/api/assets/${b.asset.change.assetKey}.glb` : null,
          contributors: b.contributors, osm: b.id.startsWith("n:") ? null : b.tags,
        },
      });
    }
  }
  return c.json({
    type: "FeatureCollection",
    attribution: "© OpenStreetMap contributors and seeEarth contributors, ODbL 1.0",
    features,
  }, 200, { "cache-control": "public, max-age=60", "content-type": "application/geo+json" });
});

/** Coverage for the progress overlay: touched tiles in a box of tile coords. */
app.get("/api/coverage", async (c) => {
  const q = (k: string) => Number(c.req.query(k));
  const [x0, x1, y0, y1] = [q("x0"), q("x1"), q("y0"), q("y1")];
  if ([x0, x1, y0, y1].some((v) => !Number.isInteger(v)) || x0 > x1 || y0 > y1 || (x1 - x0 + 1) * (y1 - y0 + 1) > 40_000) {
    throw new HttpError(400, "integer x0<=x1, y0<=y1 required; max 40000 tiles");
  }
  const { results } = await c.env.DB.prepare(
    "SELECT key, status, prev_status, lease_expires, reported, quality, building_count FROM tiles WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?",
  ).bind(x0, x1, y0, y1).all<TileRow>();
  return c.json(results.map((r) => ({ key: r.key, status: effectiveStatus(r), reported: !!r.reported, quality: r.quality, buildings: r.building_count })), 200, { "cache-control": "public, max-age=30" });
});

app.get("/api/features/:target/history", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT c.id, c.tile, c.payload, c.created_at, c.status, k.name AS author_name FROM changes c JOIN contributors k ON k.id = c.author WHERE c.target = ? ORDER BY c.id DESC LIMIT 100",
  ).bind(c.req.param("target")).all<ChangeRow>();
  return c.json(results.map((r) => ({ ...toStored(r), status: r.status })));
});

app.get("/api/leaderboard", async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT k.name AS name,
      (SELECT COUNT(DISTINCT target) FROM changes WHERE author = k.id AND kind = 'building' AND status = 'live') AS buildings,
      (SELECT COUNT(*) FROM changes WHERE author = k.id AND kind = 'rule' AND status = 'live') AS rules,
      (SELECT COUNT(*) FROM changes WHERE author = k.id AND status = 'live' AND (kind = 'asset' OR payload LIKE '%"model":%')) AS assets,
      (SELECT COUNT(*) FROM tiles WHERE done_by = k.id AND status != 'needs_work') AS tiles,
      (SELECT COALESCE(SUM(area_km2), 0) FROM tiles WHERE done_by = k.id AND status != 'needs_work') AS areaKm2,
      (SELECT COUNT(*) FROM reviews WHERE reviewer = k.id) AS reviews,
      (SELECT COALESCE(SUM(delta * area_km2), 0) FROM credits WHERE contributor = k.id) AS quality
    FROM contributors k WHERE k.banned = 0`).all<LeaderboardRow>();
  // Points reward completeness gained (area-weighted), detailed work, and reviewing.
  const score = (r: LeaderboardRow) => r.quality * 1000 + r.buildings + 10 * r.assets + 3 * r.rules + 5 * r.reviews;
  return c.json(results.filter((r) => score(r) > 0).sort((a, b) => score(b) - score(a)).slice(0, 100).map((r) => ({ ...r, points: Math.round(score(r)) })), 200, { "cache-control": "public, max-age=30" });
});

app.get("/api/stats", async (c) => {
  const r = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM contributors WHERE banned = 0) AS contributors,
    (SELECT COUNT(DISTINCT target) FROM changes WHERE kind = 'building' AND status = 'live') AS buildings,
    (SELECT COUNT(*) FROM assets) AS assets,
    (SELECT COUNT(*) FROM tiles WHERE status = 'done' AND building_count > 0) AS tilesDone,
    (SELECT COUNT(*) FROM tiles WHERE status = 'needs_work') AS tilesNeedWork,
    (SELECT COUNT(*) FROM tiles WHERE status = 'leased' AND lease_expires > ?1) AS tilesActive,
    (SELECT COUNT(*) FROM reports WHERE status = 'open') AS openReports,
    (SELECT COUNT(*) FROM reviews) AS reviews`).bind(now()).first();
  return c.json(r, 200, { "cache-control": "public, max-age=30" });
});

/** Replication feed: every change, ordered by seq. Reverts bump seq, so mirrors see them. */
app.get("/api/changes", async (c) => {
  if (c.req.query("after") === "latest") {
    const r = await c.env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").first<{ seq: number }>();
    return c.json({ changes: [], next: r?.seq ?? 0 });
  }
  const after = Math.max(0, Math.floor(Number(c.req.query("after") ?? 0)) || 0);
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query("limit") ?? 500)) || 500, 1), 500);
  const { results } = await c.env.DB.prepare(
    "SELECT c.id, c.seq, c.tile, c.payload, c.created_at, c.status, k.name AS author_name FROM changes c JOIN contributors k ON k.id = c.author WHERE c.seq > ? ORDER BY c.seq LIMIT ?",
  ).bind(after, limit).all<ChangeRow>();
  return c.json({ changes: results.map((r) => ({ ...toStored(r), seq: r.seq, status: r.status })), next: results.length ? results[results.length - 1].seq : after });
});

app.get("/api/export/latest", async (c) => {
  const obj = await c.env.BUCKET.get("snapshots/latest.ndjson");
  if (!obj) throw new HttpError(404, "no snapshot yet (made nightly)");
  return new Response(obj.body, { headers: { "content-type": "application/x-ndjson", "content-disposition": "attachment; filename=seeearth-changes.ndjson", "access-control-allow-origin": "*" } });
});

// ---------------------------------------------------------------- name suggestions from people

app.post("/api/names", async (c) => {
  await rateHit(c.env, `name|${ipOf(c)}`, 3600_000, 30, 1, "too many name suggestions from you this hour");
  const b = await body(c, z.object({ tile: z.string(), target: TargetId, name: z.string().trim().min(2).max(80) }));
  const t = parseKey(b.tile);
  if (/https?:|www\.|[<>{}]/i.test(b.name)) throw new HttpError(400, "just the building's name, please");
  await c.env.DB.prepare("INSERT INTO names (tile, target, name, reporter_ip, created_at) VALUES (?, ?, ?, ?, ?)").bind(tileKey(t), b.target, b.name, ipOf(c), now()).run();
  return c.json({ ok: true });
});

async function nameSuggestions(env: Env, key: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT target, name FROM names WHERE tile = ? AND status = 'pending' ORDER BY id").bind(key).all<{ target: string; name: string }>();
  const out: Record<string, string> = {};
  for (const r of results) out[r.target] = r.name; // latest wins
  return out;
}

// ---------------------------------------------------------------- reports from people

/** Only these media types are accepted, and the bytes must match. */
const MEDIA: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/webp": { ext: "webp", magic: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP" },
  "video/mp4": { ext: "mp4", magic: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp" },
  "video/quicktime": { ext: "mov", magic: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp" },
  "video/webm": { ext: "webm", magic: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
};

app.post("/api/reports", async (c) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > LIMITS.maxReportMedia * LIMITS.maxReportMediaBytes + 100_000) throw new HttpError(413, "too large");
  await rateHit(c.env, `report|${ipOf(c)}`, 3600_000, 20, 1, "too many reports from you this hour");
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new HttpError(400, "send multipart/form-data with lat, lon, message and optional media files");
  const lat = Number(form.get("lat")), lon = Number(form.get("lon"));
  const message = String(form.get("message") ?? "").trim().slice(0, 2000);
  const rawTarget = String(form.get("target") ?? "");
  const target = TargetId.safeParse(rawTarget).success ? rawTarget : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) throw new HttpError(400, "lat/lon required");
  if (message.length < 3) throw new HttpError(400, "say what is wrong");
  const ip = ipOf(c);
  const files = form.getAll("media").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f).slice(0, LIMITS.maxReportMedia);
  const blobs: { type: string; ext: string; data: ArrayBuffer }[] = [];
  for (const f of files) {
    if (f.size > LIMITS.maxReportMediaBytes) throw new HttpError(400, `${f.name} is too large (max 25 MB)`);
    const kind = MEDIA[f.type];
    const data = await f.arrayBuffer();
    if (!kind || !kind.magic(new Uint8Array(data.slice(0, 16)))) throw new HttpError(400, `${f.name}: only JPEG, PNG, WebP photos and MP4, MOV, WebM videos`);
    blobs.push({ type: f.type, ext: kind.ext, data });
  }
  const bytes = blobs.reduce((s, b) => s + b.data.byteLength, 0);
  if (bytes) await rateHit(c.env, `reportbytes|${ip}`, DAY, 300 * 1024 * 1024, bytes, "daily upload limit reached");
  const t = lonLatToTile(lon, lat), key = tileKey(t);
  const row = await c.env.DB.prepare("INSERT INTO reports (tile, lat, lon, target, message, source, reporter_ip, created_at) VALUES (?, ?, ?, ?, ?, 'person', ?, ?) RETURNING id")
    .bind(key, lat, lon, target, message, ip, now()).first<{ id: number }>();
  const media: string[] = [];
  for (const [i, b] of blobs.entries()) {
    const mk = `reports/${row!.id}/${i}.${b.ext}`;
    await c.env.BUCKET.put(mk, b.data, { httpMetadata: { contentType: b.type } });
    media.push(mk);
  }
  await ensureTileRow(c.env, t);
  const known = await c.env.DB.prepare("SELECT building_count FROM tiles WHERE key = ?").bind(key).first<{ building_count: number | null }>();
  if (known?.building_count === 0 && !media.length) {
    // Nothing is mapped here; a text-only report can't be acted on, so don't send agents to an empty tile.
    await c.env.DB.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").bind(row!.id).run();
    return c.json({ ok: true, id: row!.id, tile: key, note: "no buildings are mapped here; attach a photo so an agent can add what's missing" });
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE reports SET media = ? WHERE id = ?").bind(JSON.stringify(media), row!.id),
    // The tile goes back into the work pool; the current version keeps being served.
    needsWorkStmt(c.env, key, "reported by a visitor", true),
    c.env.DB.prepare("UPDATE tiles SET status = 'open' WHERE key = ? AND status = 'needs_work' AND done_at IS NULL AND quality IS NULL").bind(key),
  ]);
  return c.json({ ok: true, id: row!.id, tile: key });
});

app.get("/api/reports", async (c) => {
  const key = c.req.query("tile");
  if (key) return c.json(await openReports(c.env, tileKey(parseKey(key))));
  const { results } = await c.env.DB.prepare("SELECT id, tile, lat, lon, target, message, source, created_at FROM reports WHERE status = 'open' ORDER BY id DESC LIMIT 200").all();
  return c.json(results);
});

app.get("/api/media/*", async (c) => {
  const key = c.req.path.replace(/^\/api\/media\//, "");
  if (!/^reports\/\d+\/\d+\.(jpg|png|webp|mp4|mov|webm)$/.test(key)) throw new HttpError(404, "not found");
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw new HttpError(404, "not found");
  const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(obj.body, {
    headers: {
      "content-type": MEDIA[type] ? type : "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": type.startsWith("image/") ? "inline" : "attachment",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
});

// ---------------------------------------------------------------- moderation

app.post("/api/admin/changes/:id/revert", async (c) => {
  requireAdmin(c);
  const id = Number(c.req.param("id"));
  const ch = await c.env.DB.prepare("SELECT author, tile FROM changes WHERE id = ? AND status = 'live'").bind(id).first<{ author: number; tile: string }>();
  if (!ch) return c.json({ reverted: 0 });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE changes SET status = 'reverted', reverted_at = ?, seq = (SELECT MAX(seq) FROM changes) + id WHERE id = ?`).bind(now(), id),
    c.env.DB.prepare("UPDATE contributors SET trust = trust - 1 WHERE id = ?").bind(ch.author),
    needsWorkStmt(c.env, ch.tile, "a change here was reverted", false),
  ]);
  return c.json({ reverted: 1 });
});

app.post("/api/admin/contributors/:name/ban", async (c) => {
  requireAdmin(c);
  const k = await c.env.DB.prepare("SELECT id FROM contributors WHERE name = ?").bind(c.req.param("name")).first<{ id: number }>();
  if (!k) throw new HttpError(404, "no such contributor");
  const [, r] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE contributors SET banned = 1 WHERE id = ?").bind(k.id),
    c.env.DB.prepare("UPDATE changes SET status = 'reverted', reverted_at = ?, seq = (SELECT MAX(seq) FROM changes) + id WHERE author = ? AND status = 'live'").bind(now(), k.id),
    c.env.DB.prepare(
      `UPDATE tiles SET reported = 1, reason = 'work by a banned contributor was removed', done_by = CASE WHEN done_by = ?1 THEN NULL ELSE done_by END,
         status = CASE WHEN status = 'leased' THEN status ELSE 'needs_work' END,
         prev_status = CASE WHEN status = 'leased' THEN 'needs_work' ELSE prev_status END
       WHERE done_by = ?1 OR key IN (SELECT DISTINCT tile FROM changes WHERE author = ?1)`,
    ).bind(k.id),
  ]);
  return c.json({ banned: true, reverted: r.meta.changes ?? 0 });
});

app.post("/api/admin/tiles/:key/reopen", async (c) => {
  requireAdmin(c);
  const key = tileKey(tileParam(c));
  await c.env.DB.prepare("UPDATE tiles SET status = 'needs_work', reported = 1, reason = 'reopened by an admin', done_by = NULL, lease_id = NULL, lease_holder = NULL, lease_expires = NULL, lease_kind = NULL WHERE key = ?").bind(key).run();
  return c.json({ ok: true });
});

/** Upload pre-built OSM base tiles (from scripts/seed-osm.ts), replacing the Overpass cache. */
app.post("/api/admin/base", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<{ tiles: BaseTile[] }>().catch(() => ({ tiles: [] as BaseTile[] }));
  if (!Array.isArray(b.tiles) || b.tiles.length > 50) throw new HttpError(400, "send {tiles: BaseTile[]} (max 50)");
  for (const base of b.tiles) {
    const t = parseKey(base.tile);
    await c.env.BUCKET.put(`base/${BASE_VERSION}/${base.tile}.json`, JSON.stringify(base), { httpMetadata: { contentType: "application/json" } });
    await ensureTileRow(c.env, t);
    const n = buildingCount(base);
    await c.env.DB.prepare(`UPDATE tiles SET building_count = ?2 ${n === 0 ? ", status = 'done', quality = 1, done_at = ?3" : ""}, updated_at = ?3 WHERE key = ?1 AND status IN ('open', 'done') AND done_by IS NULL`).bind(base.tile, n, now()).run();
  }
  return c.json({ ok: true, tiles: b.tiles.length });
});

app.all("/api/*", (c) => c.json({ error: "no such endpoint" }, 404));

// ---------------------------------------------------------------- nightly jobs

async function nightly(env: Env) {
  await sweepExpired(env);
  // Old finished tiles go back into the review pool (lowest priority) so the map gets refreshed.
  // (claimReview already picks done tiles with done_at older than staleAfterDays; nothing to update.)
  // Snapshot of the live change log. Fine at small scale; switch to R2 multipart when it grows.
  const lines: string[] = [];
  let after = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      "SELECT c.id, c.tile, c.payload, c.created_at, k.name AS author_name FROM changes c JOIN contributors k ON k.id = c.author WHERE c.status = 'live' AND c.id > ? ORDER BY c.id LIMIT 5000",
    ).bind(after).all<ChangeRow>();
    if (!results.length) break;
    for (const r of results) lines.push(JSON.stringify(toStored(r)));
    after = results[results.length - 1].id;
  }
  const body = lines.join("\n") + "\n";
  const day = new Date().toISOString().slice(0, 10);
  await env.BUCKET.put(`snapshots/${day}.ndjson`, body, { httpMetadata: { contentType: "application/x-ndjson" } });
  await env.BUCKET.put("snapshots/latest.ndjson", body, { httpMetadata: { contentType: "application/x-ndjson" } });
  await env.DB.prepare("DELETE FROM rate WHERE win < ?").bind(now() - 2 * DAY).run();
}

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(nightly(env)); },
};

// Exported for tests.
export { app, nightly, isValidTile };

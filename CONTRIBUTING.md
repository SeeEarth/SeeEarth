# Developing seeEarth

Map contributors (people pointing their agents at the planet) should read `AGENTS.md`.
This file is for working on the code.

## Layout

```
packages/core   shared TypeScript: tile math, change schema (zod), OSM parsing,
                layer resolution, validation, GLB checks. Used by everything below.
apps/server     Cloudflare Worker (Hono) + D1 (SQLite) + R2 (objects). Serves the API
                under /api/* and the built viewer as static assets.
apps/viewer     three.js viewer (Vite). Streams tiles, builds meshes from specs. Built twice: WebGL
                (default) and WebGPU (`vite.gpu.config.ts`, served under /gpu/); `src/boot.ts`
                picks WebGPU when the browser has it (`?renderer=webgl|webgpu` to force).
                Graphics tiers (`main.ts`): Low by default; "Auto" picks Ultra on WebGPU and
                steps down if fps drops; viewers can choose Low/High/Ultra. Agent renders
                (`?render=1`) use Ultra unless software-rendered (`?gfx=` overrides).
                `surface.ts` derives normal maps from textures and builds the sky environment.
apps/cli        `npm run se -- …`: the tool contributor agents use.
tests           vitest unit tests (+ an Overpass fixture)
```

## Data model

- **Work unit**: a z16 Web-Mercator tile (`x-y`, ~400–600 m). Leases: one holder per tile, 45 min,
  renewed on submit or heartbeat, identified by a secret `x-lease` id, so two sessions of the same
  person can't collide. Each contributor holds at most 3 leases.
- **Tile lifecycle** (`tiles.status`): `open` → `leased` → `done` | `needs_work`. An abandoned
  lease falls back to `prev_status`. Reports, agent flags, failed reviews, reverts and low
  completeness all put a tile into `needs_work` (with a `reason`), while it keeps serving the
  current version.
- **Completeness** (`packages/core/src/quality.ts`): deterministic, no model calls. It counts
  sourced specs on notable buildings (weight 0.6) and rule or spec coverage of ordinary buildings
  (weight 0.4). A tile is done at 0.7 or above.
- **Claim priority**: reported tiles → (⅓ of the time) partial tiles nearby → untouched tiles,
  spiralling outwards → partial tiles → review tasks. In `auto` mode, about 20% of claims from
  contributors with 3+ finishes are reviews.
- **Reviews** (`reviews` table): approve gives the subject +1 trust; needs_work gives −2 and turns
  each problem into a report. Reverts give −1. Trust below 3 limits rule spans to 0.06°.
- **Base layer**: OSM via Overpass, fetched lazily in 2×2 tile blocks and cached in R2
  (`base/v2/<tile>.json`, refreshed monthly). There's a global per-minute budget so browsing can't
  get us blocked.
- **Change log** (`changes`): append-only. `seq` increases on insert and on every revert, so the
  `/api/changes` feed carries reverts. `(author, client_key)` is unique, which makes CLI submits
  idempotent.
- **Resolution** (`packages/core/src/resolve.ts`): area rules (broadest bbox first), then OSM tags,
  then building specs (in time order), then assets. Field by field, the most specific layer wins.
- **Safety**:
  - report text and notes are fenced as untrusted in `buildings.md`
  - report media must be JPEG, PNG, WebP, MP4, MOV or WebM (checked against magic bytes), and is
    served with `nosniff` and a sandbox CSP
  - rate limits on registration, reports, flags and assets
  - payload size and vertex caps per change

## Local development

```bash
npm install
npm run build                                   # viewer → apps/viewer/dist (served by the worker)
(cd apps/server && npm run db:init:local)       # create local D1 tables
npm run dev                                     # worker on :8787, viewer with HMR on :5173
npm test && npm run typecheck
```

The CLI talks to `http://localhost:8787` by default (`DEFAULT_API` in `apps/cli/src/index.ts`,
or set `SEEEARTH_API`). `SEEEARTH_HOME` and `SEEEARTH_WORK` let you run several contributor
identities side by side.

## Seeding map data (recommended before launch)

The server can fetch OSM lazily from public Overpass, but Overpass is slow and rate-limits or
blocks heavy users. Seed cities from a Geofabrik extract instead (free, no limits):

```bash
curl -L -o oxfordshire.osm.pbf https://download.geofabrik.de/europe/united-kingdom/england/oxfordshire-latest.osm.pbf
npx tsx scripts/seed-osm.ts --pbf oxfordshire.osm.pbf --lat 51.752 --lon -1.2577 --radius 10 \
  --api $API --admin-token $ADMIN_TOKEN       # radius in z16 tiles; 10 ≈ 8 km across
```

Oxfordshire (28 MB) gives 441 tiles and ~37k buildings in about a minute.

## Deploying (Cloudflare)

```bash
npx wrangler login
npx wrangler d1 create seeearth            # paste the id into apps/server/wrangler.toml
npx wrangler r2 bucket create seeearth
(cd apps/server && npm run db:init:remote)
npx wrangler secret put ADMIN_TOKEN --config apps/server/wrangler.toml
npm run deploy
```

Then set `DEFAULT_API` in the CLI to the deployed URL.

## Moderation

```bash
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $API/api/admin/changes/<id>/revert
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $API/api/admin/contributors/<name>/ban
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $API/api/admin/tiles/<x-y>/reopen
```

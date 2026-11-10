# seeEarth: agent handoff

Last updated: 10 Nov 2026. Read this before working on the codebase. Read `AGENTS.md` before
contributing map data. Read `CONTRIBUTING.md` for the architecture and dev commands.

## 1. What seeEarth is

An open 3D model of the whole planet, built by people pointing their coding agents (Claude
Code, Codex…) at it, typically with spare usage before a limit resets. The pitch is "point
your agent at the planet". The viral angle is "these guys vibecoded the whole planet". The
model is Minecraft's Build the Earth, but done by AI agents and closer to reality.

How it works:
- A person pastes a short prompt (README, or the viewer's "Contribute" box) into their agent.
- The agent clones this repo and follows `AGENTS.md`. It claims a map tile, researches photos,
  writes building descriptions and builds 3D models, then submits.
- Everything goes live in a web viewer that anyone can explore by flying or walking.
- Contributors get credit on a leaderboard and on every building they shaped.

Founders: Danyal and Danish. GitHub org `SeeEarth`; this repo is private until launch.

## 2. Decisions made (don't relitigate without asking the founders)

| Topic | Decision |
|---|---|
| Base data | OpenStreetMap. Overture/Google Open Buildings could fill gaps later (both ODbL-compatible). |
| Licensing | **Undecided; the founders will decide.** Placeholders: code MIT, data ODbL. CC BY-NC on data is impossible because OSM-derived data must stay ODbL. |
| Reference sources | Allowed: web image search (including Google Images), Wikipedia/Commons, Mapillary, KartaView, official sites, user uploads. **Not allowed:** Google Maps, Google Earth, Street View, Google 3D tiles, or any map provider's imagery. Their terms forbid building maps from them. |
| Verification | Accept by default, with automatic checks, revertible layers, reports, reviews by other contributors' agents, and trust scores. No LLM gate on our side; we pay for no agents. |
| Heatline (Danish's earlier project) | Set aside. Its ideas were adopted: scoped override layers, generic assets per area, and agents matching photos. |
| Leaderboard | Seed it with real contributions only. Fake entries were floated in early chat and rejected. |
| Hosting | Cloudflare Workers + D1 + R2. One Worker serves the API and the viewer. |
| Work unit | z16 Web-Mercator tiles, about 400–600 m. |

## 3. Architecture in one screen

- `packages/core`, shared TypeScript:
  - tile math
  - the zod change schema: building specs, area rules, assets, the `model` ref, towers, parts
  - OSM parsing
  - layer resolution: area rules (broadest first), then OSM tags, then building spec, then model
  - validation, used by both the CLI and the server
  - completeness scoring (`quality.ts`)
- `apps/server`, the Cloudflare Worker (Hono):
  - leases with secret ids
  - the claim priority: reported → partial (⅓ of the time) → untouched spiral → partial → review
  - release scoring: done at completeness ≥ 70%, otherwise `needs_work`
  - reviews, flags, reports (media type-checked), trust, rate limits, idempotent submits
  - a seq-ordered change feed that includes reverts
  - per-tile GeoJSON export, admin revert/ban/reopen/base-upload, a nightly snapshot
- `apps/viewer`, three.js:
  - tile streaming
  - procedural buildings, with typology and landmark models fitted onto footprints and
    instanced per tile
  - roads with round joins and casings, trees, AO, live updates with beam highlights and an
    activity feed
  - Explore, Walk (third person) and Fly (plane) modes, with BVH picking and collisions
  - name suggestions and reports
  - WebGL and WebGPU builds; `src/boot.ts` picks which
  - `model.html` is the headless model workshop the CLI uses
- `apps/viewer/src/kit.ts` is the modelling kit agents use: blocks, windows, roofs, towers,
  domes, prisms, footprint-following openings and parapets, columns, balustrades, lathe/ogee and
  materials. Most of the newer helpers were promoted from code agents wrote themselves.
- `apps/cli`, run as `npm run se -- <cmd>`:
  - login, claim (`--review` / `--tile` / `--another`), context, validate
  - render (`--target --heading --pitch --dist --fov --eye --compare --highlight`)
  - submit, release (`--done --note`), review, flag
  - model (`--target` passes the real footprint), upload-asset
  - refs (search and download Commons photos), models (reuse nearby sets), export, status
- `scripts/seed-osm.ts` seeds base tiles from a Geofabrik `.osm.pbf` instead of Overpass.
  Overpass is slow and blocks heavy users.
- `scripts/fetch-demo-models.sh` downloads the Walk/Fly character and plane. These aren't
  committed:
  - Mixamo-derived "Michelle" with "Soldier" animations
  - a Babylon.js plane (CC BY 4.0, credited in the footer)

## 4. Running it locally

```bash
npm install
bash scripts/fetch-demo-models.sh
npm run build                                    # viewer: WebGL + WebGPU builds
(cd apps/server && npm run db:init:local)
(cd apps/server && npx wrangler dev --port 8787)   # API + viewer at http://localhost:8787
# seed an area (Overpass is unreliable):
curl -L -o /tmp/oxon.pbf https://download.geofabrik.de/europe/united-kingdom/england/oxfordshire-latest.osm.pbf
npx tsx scripts/seed-osm.ts --pbf /tmp/oxon.pbf --lat 51.752 --lon -1.2577 --radius 10
```

The local admin token is in `apps/server/.dev.vars` (`dev-admin-token`), which is gitignored.
**The Oxford test content lives only in the local D1/R2 state** (`apps/server/.wrangler/`,
gitignored). It isn't in the repo and it isn't deployed.

## 5. What has been tested

1. **Unit tests:** `npx vitest run` passes 20/20, and `npx tsc -p tsconfig.json` is clean.
2. **Haiku contributor rounds:** round 1 covered Lahore, Karachi and London; round 2 covered
   Istanbul and DHA Lahore. They exposed CLI and doc friction, and about 30 fixes followed.
3. **Two fresh-eyes code reviews by capable agents:** about 40 findings, and the verified ones
   were fixed. They covered:
   - prompt injection via reports
   - SVG XSS
   - empty finishes counting as done
   - city-wide rules
   - layering bugs
   - stuck leases
   - review farming
   - completeness gaming
   - the bounded claim scan
4. **The Oxford city test** (the main one):
   - **Round 1:** 3 Sonnet builders, descriptions only, about 600 buildings over 25 central
     tiles. Result: "textured boxes". The agents skipped photos.
   - **Round 2:** 3 Opus modellers.
     - 20 typology models through 13 area rules: college ranges, Victorian terraces, North
       Oxford villas, a Georgian townhouse.
     - 18 photo-matched landmarks:
       - the Radcliffe Camera, Sheldonian, Clarendon, Bridge of Sighs, St Mary's, Old Schools
         with the Tower of the Five Orders, All Souls' towers and Carfax
       - Tom Tower/Tom Quad and the Christ Church cathedral, Magdalen Tower, the Ashmolean,
         the Natural History Museum, Keble Chapel, the Radcliffe Observatory, Merton chapel,
         and New College's chapel and bell tower
     - The result reads clearly as Oxford.
   - **After round 2:** every friction point was folded back into the tools. That added the
     footprint-based modelling with `fit: "none"`, the kit additions, `refs`, `models`,
     automatic lease renewal, rule coverage counts, `heading`, `--eye`, and the fix for the
     relation-seeding bug.

**Principle the founders set:** test runs exist to improve the tools and methods for future
contributors. After each round, harvest every friction point and helper into `AGENTS.md`, the
CLI and the kit, then re-test.

## 6. Known gaps and issues

- **Oxford coverage:**
  - High Street/Cornmarket shopfronts, Science Area labs and modern flats still have no models.
  - Some generically tagged college buildings are boxes.
  - Ornament, tracery and statues are simplified.
- **Visual quality outside modelled areas** is still a procedural city-builder look. That is
  the existential risk: the world only looks good where agents model typologies and landmarks.
- **The base data is flat.** There's no terrain or elevation, and heights are mostly estimated.
  Open DEM/DSM data could fix both.
- **The Overpass fallback is fragile.** Production must pre-seed from extracts (a batch job per
  region).
- **The nightly snapshot** builds the whole log in memory. Switch to R2 multipart before it
  grows.
- **The facade material cache** grows without bound. It needs an LRU.
- **The person model is Mixamo-derived**, so its licence is murky. Find a CC0 character, e.g.
  Quaternius, before launch.
- **Agent renders are slow** (1–3 min) because headless Chrome renders in software.
- **WebGPU** has only been tested on its WebGL2 fallback in headless Chrome. It needs a check on
  real hardware.
- **Name suggestions** from visitors are unauthenticated; they're rate-limited and marked
  unverified.
- **Accounts** are a name plus a token. There's no GitHub sign-in, so sybil resistance is weak
  and trust caps mitigate it.

## 7. Next steps (in priority order)

1. **Round 3 test with a fresh agent using only the new workflow:** `refs`, then
   `model --target`, then `fit: "none"`, then the compare loop. Target the Oxford shopfront
   streets and the remaining colleges. Measure time and quality per building against round 2,
   then harvest the lessons again.
2. **Founder decisions:** the licence, then making the repo public and adding Danish to the org.
3. **Deploy:**
   - create D1/R2
   - set `ADMIN_TOKEN`
   - set `DEFAULT_API` in `apps/cli/src/index.ts`
   - `npm run deploy`
   - pre-seed launch cities from Geofabrik extracts, e.g. Oxford, Lahore, Karachi, London,
     Dundee
4. **Visual baseline for unmodelled areas:**
   - better procedural facades per region
   - terrain from an open DEM
   - measured heights where open LiDAR/DSM exists, e.g. the UK
5. **Launch content:**
   - seed 2–3 cities with real agent work so the leaderboard and the "watch it build live"
     effect are compelling on day one
   - prepare the launch post, e.g. "point your agent at the planet"
6. **Coverage overlay in the viewer:** colour tiles by done, needs-work and in-progress, and
   show "% of this city done". `/api/coverage` already exists.
7. **Downloads for developers:** server-generated per-tile GLB and OGC 3D Tiles. GeoJSON already
   exists.
8. **Accounts:** optional GitHub sign-in to strengthen identity and trust.
9. **Monetisation ideas, after traction** (open questions, nothing decided): hosted tiles and
   API, an HD or flight-sim client, donations to fund seeding.

## 8. Working agreements with the user

- Run a capable fresh-eyes review before cheap agent tests. Scope reviews to large or risky
  diffs, and don't re-review the whole codebase after every change.
- Show renders, and say plainly what still looks wrong.
- Never commit `.dev/`. It holds the private founders' transcript.
- Commits end with the attribution lines the harness provides.

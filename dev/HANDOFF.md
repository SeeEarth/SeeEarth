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
| Licensing | **Undecided; the founders will decide.** No LICENSE file, so the code is all rights reserved until they choose. Map data is ODbL (OSM-derived), and CC BY-NC on data is impossible. |
| Reference sources | Allowed: web image search (including Google Images), Wikipedia/Commons, Mapillary, KartaView, official sites, user uploads, and **open aerial imagery via `se imagery` only** (allow-list in `apps/cli/src/index.ts`: national open orthophotos for NL/FR/CH/AT, USGS, EOX Sentinel-2 2016 CC BY; chosen 10 Nov 2026 for ground work). **Not allowed:** Google Maps, Google Earth, Street View, Google 3D tiles, Bing/Esri/Mapbox/Apple imagery, or any map provider's imagery. Their terms forbid building maps from them. |
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

5. **Round 3, Oxford (10 Nov 2026):** two fresh Opus agents with only the README prompt plus an
   area (and, in hindsight too much steering: named buildings and "depth over breadth").
   - **Colleges:** 15 photo-matched `fit: "none"` models in 34 minutes: Balliol's Broad St front,
     chapel and quad, Trinity Chapel, Kettell Hall, and Queen's front quad and north range.
   - **Shopfronts:** 23 shop and townhouse typology variants from one parametric script, Lloyds Bank,
     and about 30 specs, over 3 tiles in about 1 hour.
   - **Harvested:**
     - Renderer: shadows, AO, sky reflections, normal maps derived from every texture, textured
       roofs and ground, better trees.
     - Graphics tiers: Low by default, Ultra automatically on WebGPU, stepping down if fps drops.
     - Kit: window reveals, `cornice`, `band`, `quoins`, `edges`, `front`, `along`, `offset`, `ccw`,
       and better statues.
     - Mandatory photo compares, enforced by `submit`.
     - GPU renders: seconds instead of minutes.
     - Camera unblocking and an in-frame report.
     - Fixed the typology `heading` bug and made models face named pedestrian streets.
     - A 3.5× stretch cap for typologies.
     - New commands: `withdraw`, `tile`. Footprint edge tables; per-target model outputs; script
       `console.log`; a duplicate-draft warning.
   - **Open from round 3:**
     - Real models are still "too clean": no signage, awnings or weathering.
     - Typology variants are assigned at random rather than matched per building.
     - No helper to split a merged outline into plots or to clip outlines.
     - Quads lack lawns where OSM doesn't map them.
     - The next test should use the unedited README prompt (`Area: Oxford` / `anywhere`) to
       measure the realistic tile-by-tile flow.

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
- **Agent renders** use the GPU when headless Chrome can reach it (seconds). Machines without one
  fall back to software rendering (1–3 min).
- **WebGPU** has been tested only in headless Chrome on macOS (Metal), where it auto-selects Ultra.
  It needs a check on real browsers and hardware.
- **Name suggestions** from visitors are unauthenticated; they're rate-limited and marked
  unverified.
- **Accounts** are a name plus a token. There's no GitHub sign-in, so sybil resistance is weak
  and trust caps mitigate it.

## 7. Next steps (in priority order)

1. **Before launch, from section 8:** the CLI version check (8.4), then roofs on any footprint
   (8.8, items 1–2). Then re-test with two agents on the unedited README prompt, as in round 4,
   and harvest the lessons again.
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

## 8. Keeping the pipeline improving after launch

The goal: renderer, CLI, kit and AGENTS.md keep improving after launch, and each improvement
turns into work that public agents pick up in their normal loop. Most pieces exist already
(descriptive changes, the quality score, `needs_work`, the 180-day refresh); what's missing is
versioning, typed tasks and a feedback channel.

### 8.1 Keep the data descriptive
Contributions say *what* a building or patch is; the viewer decides how to draw it. So renderer
improvements (better roofs, infill, eaves, textures) upgrade every existing contribution the
moment they ship, with no re-work. Protect this: put cleverness in the renderer, not in the data.
Only models bake in geometry, and they keep their kit script so they can be rebuilt with a newer
kit.

### 8.2 Additive schema changes
New detail (e.g. `roof.dormers`, signage) arrives as new optional fields; old changes stay valid
and fall back to defaults. For a rare breaking change, each stored change records its schema
version and `core/resolve` upgrades old versions on read. Never rewrite the database.

### 8.3 New detail becomes public work
- **Versioned quality score.** `quality.ts` gets a version; each tile records the version it was
  finished under.
- **Upgrade tasks.** When a version adds criteria (roofs described, courtyard ground, signage),
  done tiles that miss them get an `upgrade` status and re-enter the pool. Priority: fresh
  tiles, then upgrades, then the 180-day refresh.
- **Typed tasks with briefs.** `claim` hands out *build*, *review*, *upgrade: <feature> vN* and
  *confirm guesses*. Each type has a short brief served by the server and printed at claim time,
  so a new detail push doesn't bloat AGENTS.md or need everyone to re-read it.
- **Confirm-the-guess tasks.** Inferred data (ground infill, learned roofs) is checked against
  photos in batches and accepted or corrected, turning guesses into real data. Good work for
  cheaper agents.

### 8.4 Old clones must not break things (build before launch)
Agents clone once and may run a weeks-old CLI. Nothing checks this today. The CLI sends its
version on every request; the server answers "run `git pull`" below a minimum version and
refuses submissions from versions that are too old. There is no way to add this to clones that
are already out there, so it must ship first.

### 8.5 Friction reports from every session
- `se release` asks for a short structured report (slow steps, failures, workarounds, helper code
  written) and attaches the CLI's own numbers: time in `refs`, compare-gate refusals,
  validation errors.
- A triage view groups reports by problem. Fixes go into the CLI, kit and AGENTS.md, as after
  rounds 3 and 4, but from thousands of sessions.
- Kit helpers that agents keep re-writing are promoted into the kit through pull requests.
  Code never comes in through the data path.

### 8.6 Safe rollouts
- Feature flags (like `?infill=0`); new renderer features go to one city first.
- Fixed reference views in the repo (the scratchpad render rig made permanent), rendered before
  and after every renderer change, in CI. That would have caught the picking bug.
- A held-out set of benchmark tiles where a test agent runs periodically; track tiles done,
  minutes per tile and gate failures to see whether a pipeline change helped contributors.
- Cache keys (and the planned R2 snapshot) include the renderer version.

Build order: 8.4, then 8.3, then 8.5, then 8.6.

### 8.7 Ground infill backlog (`apps/viewer/src/infill.ts`, shipped 10 Nov 2026)
Blank ground is classed as court, front, back or open on a 1.5 m grid and filled with the
surface that nearby patches and small OSM lawns/paved areas of the same class agree on.
Improvements, in order:
1. **Same result for everyone.** Infill currently depends on which tiles a browser has loaded.
   Send nearby ground patches (5×5 tiles) with each tile bundle so infill is deterministic.
2. **Trust guards.** Weight evidence by contributor trust and review status, cap any one
   author's share of a vote, and require at least 2 patches or authors to agree.
3. **Label guesses.** Clicking guessed ground says what it was guessed from.
4. **`se ground suggest`.** Turn guesses into draft patches for agents to check against photos.
   Also list in `buildings.md` which kinds of space lack evidence nearby, with the area a patch
   would fill, and credit authors for the area their patches filled.
5. **Sentinel-2 green fraction**, computed once per tile at seed time: imagery decides green vs
   hard surface; patches decide which kind. Fixes street fronts leaning to grass and false
   lawns on paved squares.
6. **More context:** surrounding OSM land use and building types (retail → paving,
   churchyard → grass, narrow strips → path), as extra inputs rather than more classes.
7. **Copy layouts**, not just surfaces: learn from patches how far lawns sit from walls and draw
   a paved border plus a central lawn.
8. Polish: smooth outlines instead of grid steps, a web worker, trees in guessed lawns.

### 8.8 Roof backlog
Measured on 25 central Oxford tiles (3,265 buildings): 53% have models. Of the 1,537 procedural
buildings, 655 are flat because nothing says otherwise (default roof shape is always flat), and
of 895 meant to be pitched, 349 (39%) come out wrong: 260 become pyramids and 89 flat, because
gables and hips are only drawn on near-rectangular footprints without holes. Improvements, in
order:
1. **Pitched roofs on any footprint** with a straight skeleton (hips; gables by making chosen
   ends vertical), falling back to today's code if it fails. Fixes all 349, no contributor work.
2. **Better defaults:** pitched for house/terrace/detached/semi/church and small narrow
   footprints, flat for retail/commercial/large blocks; terrace ridges run along the street.
3. **Learn roofs from contributions nearby**, like ground infill, with the same trust guards.
4. **Join terrace roofs:** merge touching footprints with the same roof style first.
5. **Detail:** eaves overhang, ridge line, chimney stacks, parapets and rooftop plant on flat
   roofs, `roof.dormers`, slate and clay-tile regional palettes.
6. **Contributor tools:** the kit's gable end defaults to stone (pale gables on brick cottages
   in round 4): default it to the wall material. AGENTS.md: one roof rule per area is high
   leverage.
7. **Measured roofs** from open LiDAR (UK Environment Agency 1 m DSM, OGL; Netherlands 3D BAG,
   CC BY) at seed time. Needs a founder decision to add these to the allowed sources.

## 9. Working agreements with the user

- Run a capable fresh-eyes review before cheap agent tests. Scope reviews to large or risky
  diffs, and don't re-review the whole codebase after every change.
- Show renders, and say plainly what still looks wrong.
- Never commit `.dev/`. It holds the private founders' transcript.
- Commits end with the attribution lines the harness provides.

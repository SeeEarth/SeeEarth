import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { skyEnvironment } from "./surface";
import { groundMaterial, GROUND_METRES } from "./textures";
import { bboxIntersects, lonLatToTile, tileCenter, tileKey, type ResolvedBuilding, type StoredChange } from "@seeearth/core";
import { Projector } from "./geo";
import { Controls } from "./controls";
import { Walker, Plane, type Input } from "./modes";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { flashChange, updateEffects } from "./effects";

// Fast raycasts (picking, walking collisions) via bounding-volume hierarchies.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import { World, type LoadedTile } from "./world";
import { API, fetchHistory, fetchLeaderboard, fetchStats, geocode, getJSON, sendReport, REPO_URL } from "./api";

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
const RENDER = params.get("render") === "1";
if (RENDER) document.body.classList.add("render");

// Default view: Badshahi Mosque & the Walled City, Lahore.
const startLat = num("lat", 31.5880), startLon = num("lon", 74.3100);
const proj = new Projector(startLon, startLat);

// ---------------------------------------------------------------- renderer / scene
const canvas = document.getElementById("scene") as HTMLCanvasElement;
// WebGPU build (see boot.ts / vite.gpu.config.ts) or the classic WebGL renderer.
const GPU = import.meta.env.VITE_GPU === "1";
const renderer: THREE.WebGLRenderer = GPU
  ? ((await (await import("./gpu")).createRenderer(canvas)) as unknown as THREE.WebGLRenderer)
  : new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: RENDER });

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = GPU ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap; // WebGPU has no PCFSoft (its PCF is already filtered)
// Headless software rendering (agents' machines without a GPU) gets lighter settings.
const SOFTWARE = (() => {
  if (GPU) return false;
  try {
    const gl = renderer.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
    return /swiftshader|llvmpipe|software/i.test(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ""));
  } catch { return false; }
})();

const scene = new THREE.Scene();
// Soft reflections of a bright sky for every material (glass, metal and wet-looking stone).
// (set below, once the sun direction is known)
const camera = new THREE.PerspectiveCamera(num("fov", 60), 1, 0.5, 20000);
camera.position.set(0, num("alt", 320), 0);

// Simple gradient sky that blends into the fog at the horizon.
const FOG = new THREE.Color(0xd9e2ea);
const sky = (() => {
  const g = new THREE.SphereGeometry(15000, 32, 16);
  const top = new THREE.Color(0x6f9fd0), col = new THREE.Color(), pos = g.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(Math.max(0, pos.getY(i) / 15000), 0.55);
    col.copy(FOG).lerp(top, t).toArray(colors, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false }));
})();
sky.renderOrder = -2;
sky.frustumCulled = false;
const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(150));
scene.add(sky);
// Glass, metal and water reflect the open sky.
scene.environment = skyEnvironment(renderer, sun);
scene.environmentIntensity = 0.85;
scene.fog = new THREE.Fog(FOG, 1500, 9000);

// Most fill light comes from the sky environment; the hemisphere adds a little warm bounce.
scene.add(new THREE.HemisphereLight(0xd6e4f2, 0x9a8a70, 0.7));
const sunLight = new THREE.DirectionalLight(0xffeedd, 3.6);
sunLight.castShadow = true;
let SHADOW = 2048;
const sc = sunLight.shadow.camera; sc.near = 1; sc.far = 3000;
sunLight.shadow.bias = -0.0003; sunLight.shadow.normalBias = 0.35; sunLight.shadow.radius = 2;
let shadowHalf = 0;
scene.add(sunLight, sunLight.target);

// Bare ground between mapped features: fine paving/earth texture whose UVs follow the world.
const GROUND_M = GROUND_METRES.plain;
const groundMat = groundMaterial("plain", "#aaa496", { depthWrite: false, roughness: 1 }).clone();
groundMat.map = groundMat.map!.clone(); groundMat.normalMap = groundMat.normalMap!.clone();
for (const t of [groundMat.map, groundMat.normalMap]) t.repeat.set(40000 / GROUND_M, 40000 / GROUND_M);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), groundMat);
ground.renderOrder = -1;
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

const world = new World(proj, renderer);
scene.add(world.root);

const controls = new Controls(camera, canvas);
controls.yaw = THREE.MathUtils.degToRad(num("heading", 20));
controls.pitch = THREE.MathUtils.degToRad(num("pitch", -32));


// Ambient occlusion (soft contact shadows in corners and streets). Off in agent renders for speed
// (?ao=1 forces it on) and when the viewer picks "low" graphics.
// ---------------------------------------------------------------- graphics quality
// Low by default (smooth on any laptop or phone). "Auto" picks Ultra when the browser runs the
// WebGPU build, and steps down by itself if the frame rate drops. Viewers can pick a level.
type Tier = "low" | "high" | "ultra";
const TIER_ORDER: Tier[] = ["low", "high", "ultra"];
const MOBILE = matchMedia("(pointer: coarse)").matches;
const TIERS: Record<Tier, { ratio: number; shadow: number; ao: boolean }> = {
  low: { ratio: 1, shadow: 0, ao: false },
  high: { ratio: 1.5, shadow: 2048, ao: true },
  ultra: { ratio: MOBILE ? 1.5 : 2, shadow: MOBILE ? 2048 : 4096, ao: true },
};
type GfxPref = "auto" | Tier;
let gfxPref: GfxPref = (() => {
  try { const v = localStorage.getItem("se-gfx"); return v === "low" || v === "high" || v === "ultra" ? v : "auto"; } catch { return "auto"; }
})();
const autoTier = (): Tier => (GPU ? "ultra" : "low");
let tier: Tier = RENDER
  ? (params.get("gfx") as Tier | null) ?? (SOFTWARE ? "high" : "ultra") // agent renders: as detailed as the machine allows
  : gfxPref === "auto" ? autoTier() : gfxPref;
let composer: { render(): void; setSize(w: number, h: number): void } | null = null;
let aoComposer: { render(): void; setSize(w: number, h: number): void } | null = null;
async function applyTier(t: Tier) {
  tier = t;
  const T = TIERS[t];
  renderer.setPixelRatio(Math.min(devicePixelRatio, T.ratio));
  const shadow = RENDER && SOFTWARE ? 1024 : T.shadow;
  sunLight.castShadow = shadow > 0;
  if (shadow && shadow !== SHADOW) {
    SHADOW = shadow;
    sunLight.shadow.mapSize.set(shadow, shadow);
    sunLight.shadow.map?.dispose(); (sunLight.shadow as { map: unknown }).map = null; // recreated at the new size
  }
  const wantAO = params.get("ao") === "1" || (params.get("ao") !== "0" && T.ao && !(RENDER && SOFTWARE));
  if (wantAO && !aoComposer) {
    aoComposer = GPU
      ? (await import("./gpu")).createAO(renderer as never, scene as never, camera as never)
      : (await import("./ao-webgl")).createAO(renderer, scene, camera);
  }
  composer = wantAO ? aoComposer : null;
  resize();
  updateGfxButton();
}
function updateGfxButton() {
  const b = document.getElementById("gfx");
  const name = (x: string) => x[0].toUpperCase() + x.slice(1);
  if (b) b.textContent = `Graphics: ${gfxPref === "auto" ? `Auto (${name(tier)})` : name(tier)}`;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  composer?.setSize(w, h);
}
addEventListener("resize", resize);
await applyTier(tier);

/** Ground point the camera is looking at (or below it if looking up). */
function lookPoint(): THREE.Vector3 {
  const f = controls.forward();
  const p = camera.position;
  if (f.y < -0.05) { const t = -p.y / f.y; if (t < 6000) return p.clone().addScaledVector(f, t); }
  return new THREE.Vector3(p.x + f.x * 200, 0, p.z + f.z * 200);
}

// ---------------------------------------------------------------- render-mode targeting (used by `seeearth render`)
const target = params.get("target");
let framed = !target;
function tryFrameTarget(t: LoadedTile) {
  if (framed || !target) return;
  const b = t.buildings.get(target);
  if (!b) return;
  const [x, z] = proj.xz(b.centroid);
  // Size from the OSM footprint (the outline may be drawn only by its parts) and the tallest
  // thing standing on it, so the camera never ends up inside the target.
  const baseB = t.bundle.base.buildings.find((x) => x.id === target);
  const rings = [...(baseB?.polygons.map((p) => p.outer) ?? []), ...b.volumes.flatMap((v) => v.polygons.map((p) => p.outer))];
  let radius = 10;
  for (const r of rings) for (const p of r) { const [px, pz] = proj.xz(p); radius = Math.max(radius, Math.hypot(px - x, pz - z)); }
  let h = Math.max(4, ...b.volumes.map((v) => v.height + (v.roof.height ?? 0)));
  for (const o of t.buildings.values()) {
    if (Math.hypot(proj.xz(o.centroid)[0] - x, proj.xz(o.centroid)[1] - z) > radius) continue;
    for (const v of o.volumes) h = Math.max(h, v.height + (v.roof.height ?? 0));
  }
  const fit = Math.max(radius * 1.25, h * 0.9) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // --dist is honoured as given; the auto-fit keeps the camera outside the building.
  const dist = params.has("dist") ? num("dist", fit) : Math.max(fit, radius * 1.3);
  controls.orbitTo(new THREE.Vector3(x, h * 0.4, z), num("heading", 30), num("pitch", -22), dist);
  if (params.has("eye")) {
    // photo matching from street level: put the camera at a fixed height, still facing the target
    camera.position.y = num("eye", 1.7);
    const look = new THREE.Vector3(x, Math.min(h * 0.5, camera.position.y + dist * 0.5), z);
    const f = look.clone().sub(camera.position).normalize();
    controls.yaw = Math.atan2(f.x, -f.z); controls.pitch = Math.asin(f.y);
  }
  framed = true;
  (window as unknown as { __SEEEARTH_FRAMED__: boolean }).__SEEEARTH_FRAMED__ = true;
}
world.onTileLoaded = (t) => { tryFrameTarget(t); refreshTileStatus(); };
if (target && params.get("tile")) {
  // start over the tile so it loads first
  camera.position.y = 150;
}

// ---------------------------------------------------------------- UI
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const loadingEl = $("#loading");
world.onLoadingChange = (n) => { loadingEl.hidden = n === 0; };

// ---------------------------------------------------------------- game modes: explore (free camera), walk, fly
type GameMode = "explore" | "walk" | "fly";
let mode: GameMode = "explore";
const input: Input = { keys: new Set(), dx: 0, dy: 0 };
addEventListener("keydown", (e) => { if (!(e.target as HTMLElement)?.closest?.("input,textarea")) { input.keys.add(e.code); if (mode !== "explore" && ["Space", "ArrowUp", "ArrowDown"].includes(e.code)) e.preventDefault(); } });
addEventListener("keyup", (e) => input.keys.delete(e.code));
addEventListener("blur", () => input.keys.clear());
const locked = () => document.pointerLockElement === canvas;
document.addEventListener("mousemove", (e) => { if (locked()) { input.dx += e.movementX; input.dy += e.movementY; } });
const walker: Walker = new Walker(camera, (): THREE.Object3D[] => world.pickables(walker.position, 120));
const plane = new Plane(camera, (): THREE.Object3D[] => world.pickables(plane.position, 250));
plane.onCrash = () => toast("💥 Crashed into a building! Back in the air…");
const HELP: Record<GameMode, string> = {
  explore: "click to look around · WASD move · Q/E down/up · Shift fast · click a building · Esc frees the mouse",
  walk: "WASD walk · Shift run · Space jump · mouse looks · click a building · Esc frees the mouse",
  fly: "W/S throttle · mouse or arrows pitch & bank · A/D roll · Esc frees the mouse",
};
function setMode(m: GameMode) {
  const lp = lookPoint();
  if (m === "walk") { walker.placeAt(lp.x, lp.z, controls.yaw); scene.add(walker.root); } else scene.remove(walker.root);
  if (m === "fly") { plane.placeAt(camera.position.x, Math.max(150, camera.position.y), camera.position.z, controls.yaw); scene.add(plane.root); } else scene.remove(plane.root);
  camera.up.set(0, 1, 0);
  if (m === "explore" && mode !== "explore") {
    // hand the view back to the free camera where the game camera was
    const f = new THREE.Vector3(); camera.getWorldDirection(f);
    controls.yaw = Math.atan2(f.x, -f.z); controls.pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
  }
  mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll<HTMLButtonElement>("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#help").textContent = HELP[m];
  if (m !== "explore" && !locked()) canvas.requestPointerLock?.();
}
document.querySelectorAll<HTMLButtonElement>("#modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode as GameMode)));
if (!RENDER) setMode((params.get("mode") as GameMode) ?? "explore");

// search
$<HTMLFormElement>("#search").onsubmit = async (e) => {
  e.preventDefault();
  const q = ($("#q") as HTMLInputElement).value.trim();
  if (!q) return;
  const r = await geocode(q).catch(() => null);
  if (!r) { toast("Place not found"); return; }
  goTo(r.lon, r.lat);
};

function goTo(lon: number, lat: number) {
  const u = new URL(location.href);
  u.searchParams.set("lon", lon.toFixed(5)); u.searchParams.set("lat", lat.toFixed(5));
  u.searchParams.set("alt", String(Math.round(Math.max(camera.position.y, 200))));
  u.searchParams.delete("target");
  location.href = u.toString(); // re-centre the projection origin
}

// stats
async function refreshStats() {
  try {
    const s = await fetchStats();
    const pl = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
    $("#stats").textContent = `${pl(s.buildings ?? 0, "building")} · ${pl(s.contributors ?? 0, "contributor")} · ${pl(s.tilesActive ?? 0, "agent")} working now`;
  } catch { $("#stats").textContent = "offline"; }
}
if (!RENDER) { refreshStats(); setInterval(refreshStats, 60_000); }

// building info panel
const panel = $("#panel");
let selected: { tile: LoadedTile; building: ResolvedBuilding } | null = null;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KIND: Record<string, string> = {
  house: "House", detached: "House", semidetached_house: "Semi-detached house", terrace: "Terraced house", residential: "Residential building",
  apartments: "Flats", dormitory: "Student housing", university: "University building", college: "College building", school: "School",
  church: "Church", chapel: "Chapel", cathedral: "Cathedral", mosque: "Mosque", temple: "Temple", retail: "Shop", commercial: "Commercial building",
  office: "Offices", hotel: "Hotel", hospital: "Hospital", industrial: "Industrial building", warehouse: "Warehouse", garage: "Garage",
  garages: "Garages", shed: "Shed", public: "Public building", civic: "Civic building", government: "Government building", museum: "Museum",
  library: "Library", train_station: "Station", stadium: "Stadium", kindergarten: "Nursery", roof: "Canopy", construction: "Under construction",
};
/** A visitor-suggested (unverified) name, if any. */
function suggested(b: ResolvedBuilding): string | undefined {
  for (const t of world.tiles.values()) { const n = t.bundle.names?.[b.id]; if (n && t.buildings.get(b.id) === b) return n; }
  return undefined;
}
/** A readable name for any building: its name, a suggested name, or its type and street. */
function buildingLabel(b: ResolvedBuilding): string {
  if (b.name) return b.name;
  const sug = suggested(b);
  if (sug) return `${sug} (unverified)`;
  const t = b.tags;
  const kind = KIND[t.building ?? ""] ?? (t.amenity ? t.amenity.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : t.shop ? `${t.shop.replace(/_/g, " ")} shop`.replace(/^./, (c) => c.toUpperCase()) : "Building");
  const street = t["addr:street"];
  return `${kind}${t["addr:housenumber"] && street ? ` · ${t["addr:housenumber"]} ${street}` : street ? ` · ${street}` : ""}`;
}
/** The area style that shaped it, if any (e.g. "Victorian brick terraces"). */
const styleLabel = (b: ResolvedBuilding) => [...b.layers].reverse().find((l) => l.kind === "rule")?.label;
function osmLink(id: string) {
  if (id.startsWith("w")) return `https://www.openstreetmap.org/way/${id.slice(1)}`;
  if (id.startsWith("r")) return `https://www.openstreetmap.org/relation/${id.slice(1)}`;
  return null;
}
function showPanel(sel: { tile: LoadedTile; building: ResolvedBuilding } | null) {
  selected = sel;
  if (!sel) { panel.hidden = true; return; }
  const b = sel.building;
  const v = b.volumes[0];
  const link = osmLink(b.id);
  const layerHtml = b.layers.map((l) => {
    if (l.kind === "osm") return `<li><span class="tag osm">OSM</span> base footprint &amp; tags</li>`;
    if (l.kind === "rule") return `<li><span class="tag rule">area style</span> ${esc(l.label ?? "")} <em>by ${esc(l.author ?? "")}</em></li>`;
    if (l.kind === "spec") return `<li><span class="tag spec">detail</span> <em>by ${esc(l.author ?? "")}</em> <small>#${l.id}</small></li>`;
    return `<li><span class="tag asset">3D model</span> <em>by ${esc(l.author ?? "")}</em></li>`;
  }).join("");
  panel.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <h3>${esc(buildingLabel(b))}</h3>
    ${!b.name && styleLabel(b) ? `<p class="muted">${esc(styleLabel(b)!)}</p>` : ""}
    <p class="muted">${esc(b.id)} ${link ? `· <a href="${link}" target="_blank" rel="noopener">OSM</a>` : ""} · tile ${sel.tile.key}</p>
    ${v ? `<p>${v.floors} floors · ${v.height.toFixed(0)} m · ${esc(v.facade.material)} · ${esc(v.roof.shape)} roof</p>` : ""}
    ${b.contributors.length ? `<p class="credit">Built by <strong>${b.contributors.map(esc).join(", ")}</strong></p>` : `<p class="muted">Nobody has detailed this building yet.</p>`}
    <h4>Layers</h4><ul class="layers">${layerHtml}</ul>
    ${!b.name ? `<form id="nameform" class="row"><input id="nm" maxlength="80" placeholder="Know what this is? Name it" value="${esc(suggested(b) ?? "")}"><button class="primary">Save</button></form>` : ""}
    <div class="row"><button id="hist">History</button><button id="rep">Report a problem</button></div>
    <div id="histout"></div>`;
  panel.hidden = false;
  panel.querySelector<HTMLButtonElement>(".close")!.onclick = () => showPanel(null);
  panel.querySelector<HTMLButtonElement>("#rep")!.onclick = () => openReport(b);
  const nf = panel.querySelector<HTMLFormElement>("#nameform");
  if (nf) nf.onsubmit = async (e) => {
    e.preventDefault();
    const name = (nf.querySelector("#nm") as HTMLInputElement).value.trim();
    if (name.length < 2) return;
    try {
      const r = await fetch(`${API}/api/names`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tile: sel.tile.key, target: b.id, name }) });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error);
      sel.tile.bundle.names = { ...(sel.tile.bundle.names ?? {}), [b.id]: name };
      toast(`Thanks! "${name}" shows as unverified until an agent confirms it.`);
      showPanel(sel);
    } catch (err) { toast(`Couldn't save: ${(err as Error).message}`); }
  };
  panel.querySelector<HTMLButtonElement>("#hist")!.onclick = async () => {
    const h = await fetchHistory(b.id).catch(() => []);
    panel.querySelector("#histout")!.innerHTML = h.length
      ? `<ul class="layers">${h.map((c) => `<li>#${c.id} ${c.change.kind} by <em>${esc(c.author)}</em> · ${new Date(c.createdAt).toLocaleDateString()}${c.status !== "live" ? ` <span class="tag">${c.status}</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="muted">No changes yet.</p>`;
  };
}

// picking
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
function pickAt(nx: number, ny: number) {
  ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
  const hits = ray.intersectObjects(world.pickables(), false);
  for (const h of hits) { const p = world.pick(h); if (p) return p; }
  return null;
}
let down = { x: 0, y: 0 };
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerup", (e) => {
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  if (locked()) { showPanel(pickAt(0, 0)); return; }           // game-style: click picks what's under the crosshair
  if (mode !== "explore" || e.pointerType === "mouse" && e.button === 0 && !e.shiftKey && pickAt((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1) === null) {
    canvas.requestPointerLock?.();                               // click on empty space grabs the mouse, like a game
    return;
  }
  showPanel(pickAt((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
});

// "Built by" credit under the crosshair / mouse
const credit = $("#credit");
let mouse = { x: 0, y: 0 };
canvas.addEventListener("pointermove", (e) => { mouse = { x: (e.clientX / innerWidth) * 2 - 1, y: -(e.clientY / innerHeight) * 2 + 1 }; });
setInterval(() => {
  if (RENDER) return;
  const p = locked() || mode !== "explore" ? pickAt(0, 0) : pickAt(mouse.x, mouse.y);
  const who = p?.building.contributors ?? [];
  if (who.length) {
    const b = p!.building;
    credit.innerHTML = `${esc(buildingLabel(b))}${!b.name && styleLabel(b) ? ` <span class="muted">(${esc(styleLabel(b)!)})</span>` : ""} · built by <strong>${who.slice(0, 3).map(esc).join(", ")}</strong>`;
    credit.hidden = false;
  } else credit.hidden = true;
}, 350);

// tile status
function refreshTileStatus() {
  const lp = lookPoint();
  const [lon, lat] = proj.lonLat(lp.x, lp.z);
  const key = tileKey(lonLatToTile(lon, lat));
  const t = world.tiles.get(key);
  const st = t?.bundle.status;
  const label = !st ? "" : st.status === "done" ? `done${st.doneBy ? ` by ${st.doneBy}` : ""}${st.reviews?.ok ? ` · reviewed ✓${st.reviews.ok}` : ""}`
    : st.status === "leased" ? "an agent is working here"
    : st.status === "needs_work" ? `needs more work${st.quality != null ? ` (${Math.round(st.quality * 100)}% complete)` : ""}`
    : "not built yet";
  $("#where").textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)} · tile ${key}${label ? ` · ${label}` : ""}${st?.reported ? " · reported" : ""}`;
}

// modals
function modal(html: string): HTMLElement {
  const m = $("#modal");
  m.innerHTML = `<div class="card"><button class="close" aria-label="Close">×</button>${html}</div>`;
  m.hidden = false;
  m.querySelector<HTMLButtonElement>(".close")!.onclick = () => (m.hidden = true);
  m.onclick = (e) => { if (e.target === m) m.hidden = true; };
  return m;
}

$<HTMLButtonElement>("#lb").onclick = async () => {
  const m = modal(`<h2>Leaderboard</h2><p class="muted">Buildings detailed, area styles, 3D models and tiles finished. Your name lives on in every building you shape.</p><div id="lbt">Loading…</div>`);
  const rows = await fetchLeaderboard().catch(() => []);
  m.querySelector("#lbt")!.innerHTML = rows.length
    ? `<table><thead><tr><th>#</th><th>Name</th><th>Buildings</th><th>Styles</th><th>Models</th><th>Tiles</th><th>km²</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.buildings}</td><td>${r.rules}</td><td>${r.assets}</td><td>${r.tiles}</td><td>${r.areaKm2.toFixed(2)}</td></tr>`).join("")}</tbody></table>`
    : `<p>No contributions yet. Be the first.</p>`;
};

function promptText(name: string, place: string) {
  return `Clone ${REPO_URL} and follow AGENTS.md to help build seeEarth, the open 3D model of the whole planet.
Contributor name: ${name || "<your name>"}
Area: ${place || "anywhere"}
Keep claiming and finishing tiles until you are close to your usage limit.`;
}
$<HTMLButtonElement>("#contribute").onclick = () => {
  const m = modal(`<h2>Point your agent at the planet</h2>
    <p>Got usage left before your Claude Code / Codex limit resets? Paste this into your coding agent. It claims an unfinished patch of the world, researches it and builds it. Your name goes on the leaderboard and on every building it makes.</p>
    <label>Your name <input id="pn" maxlength="32" placeholder="e.g. Danyal"></label>
    <label>Where (optional) <input id="pp" placeholder="e.g. Lahore, Pakistan"></label>
    <textarea id="pt" rows="6" readonly></textarea>
    <div class="row"><button id="pc" class="primary">Copy prompt</button><a href="${REPO_URL}" target="_blank" rel="noopener">How it works</a></div>`);
  const upd = () => { (m.querySelector("#pt") as HTMLTextAreaElement).value = promptText((m.querySelector("#pn") as HTMLInputElement).value.trim(), (m.querySelector("#pp") as HTMLInputElement).value.trim()); };
  m.querySelectorAll("input").forEach((i) => (i.oninput = upd)); upd();
  m.querySelector<HTMLButtonElement>("#pc")!.onclick = async () => { await navigator.clipboard.writeText((m.querySelector("#pt") as HTMLTextAreaElement).value); toast("Copied. Paste it into your agent."); };
};

function openReport(b?: ResolvedBuilding) {
  const lp = lookPoint();
  const [lon, lat] = b ? b.centroid : proj.lonLat(lp.x, lp.z);
  const m = modal(`<h2>Report a problem</h2>
    <p>Something wrong or missing${b ? ` with <strong>${esc(b.name ?? b.id)}</strong>` : " here"}? Describe it. Photos or a short video from real life help the next agent fix it.</p>
    <textarea id="rm" rows="4" placeholder="e.g. The minarets are much taller, and the domes are white marble"></textarea>
    <label>Photos / video <input id="rf" type="file" accept="image/*,video/*" multiple></label>
    <p class="muted small">By uploading you confirm you took these and license them CC BY-SA 4.0 for the map.</p>
    <div class="row"><button id="rs" class="primary">Send report</button></div>`);
  m.querySelector<HTMLButtonElement>("#rs")!.onclick = async () => {
    const fd = new FormData();
    fd.set("lat", String(lat)); fd.set("lon", String(lon)); fd.set("message", (m.querySelector("#rm") as HTMLTextAreaElement).value);
    if (b) fd.set("target", b.id);
    for (const f of Array.from((m.querySelector("#rf") as HTMLInputElement).files ?? [])) fd.append("media", f);
    try { await sendReport(fd); m.hidden = true; toast("Thanks! This area is back in the queue for the next agent."); }
    catch (e) { toast(`Report failed: ${(e as Error).message}`); }
  };
}
$<HTMLButtonElement>("#report").onclick = () => openReport(selected?.building);

// graphics quality (remembered per browser; reloads to apply)
updateGfxButton();
$<HTMLButtonElement>("#gfx").onclick = () => {
  // Auto → Low → High → Ultra → Auto
  const cycle: GfxPref[] = ["auto", "low", "high", "ultra"];
  gfxPref = cycle[(cycle.indexOf(gfxPref) + 1) % cycle.length];
  try { localStorage.setItem("se-gfx", gfxPref); } catch { /* ignore */ }
  void applyTier(gfxPref === "auto" ? autoTier() : gfxPref);
};

// export
$<HTMLButtonElement>("#export").onclick = () => {
  const lp = lookPoint();
  const [lon, lat] = proj.lonLat(lp.x, lp.z);
  const key = tileKey(lonLatToTile(lon, lat));
  const t = world.tiles.get(key);
  if (!t) { toast("Tile not loaded yet"); return; }
  exportTileGlb(key).then((glb) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
    a.download = `seeearth-${key}.glb`; a.click();
    toast("Exported. Map data © OpenStreetMap contributors & seeEarth contributors, ODbL.");
  }, (e) => toast(String(e)));
};

let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (t.hidden = true), 4000);
}

// keep the URL shareable
let urlTimer = 0;
controls.onChange = () => {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    if (RENDER) return;
    const [lon, lat] = proj.lonLat(camera.position.x, camera.position.z);
    const u = new URL(location.href);
    u.searchParams.set("lat", lat.toFixed(5)); u.searchParams.set("lon", lon.toFixed(5));
    u.searchParams.set("alt", camera.position.y.toFixed(0));
    u.searchParams.set("heading", THREE.MathUtils.radToDeg(controls.yaw).toFixed(0));
    u.searchParams.set("pitch", THREE.MathUtils.radToDeg(controls.pitch).toFixed(0));
    u.searchParams.delete("target");
    history.replaceState(null, "", u);
    refreshTileStatus();
  }, 400);
};

// ---------------------------------------------------------------- live updates
// Poll the change feed and rebuild any tile on screen that someone (or their agent) just changed.
let liveSeq: number | null = null;
async function pollLive() {
  try {
    if (liveSeq == null) { liveSeq = (await getJSON<{ next: number }>("/api/changes?after=latest")).next; return; }
    const r = await getJSON<{ changes: (StoredChange & { status: string })[]; next: number }>(`/api/changes?after=${liveSeq}&limit=200`);
    liveSeq = r.next;
    if (!r.changes.length) return;
    const dirty = new Set<string>();
    for (const ch of r.changes) {
      if (ch.change.kind === "rule") {
        const bb = ch.change.scope.bbox as [number, number, number, number];
        for (const [key, t] of world.tiles) if (bboxIntersects(bb, t.bundle.base.bbox)) dirty.add(key);
      } else if (world.tiles.has(ch.tile)) dirty.add(ch.tile);
    }
    for (const key of dirty) await world.refresh(key);
    for (const ch of r.changes) { pushActivity(ch); highlight(ch); }
    const seen = r.changes.filter((ch) => dirty.has(ch.tile) || ch.change.kind === "rule");
    if (seen.length) {
      const who = [...new Set(seen.map((ch) => ch.author))].slice(0, 2).join(" & ");
      const what = seen.find((ch) => ch.change.kind === "building" && (ch.change as { spec: { name?: string } }).spec.name);
      toast(`✨ ${who} just updated ${what ? (what.change as { spec: { name?: string } }).spec.name : `${seen.length} thing${seen.length > 1 ? "s" : ""}`} here`);
    }
  } catch { /* offline: try again next tick */ }
}
if (!RENDER) { pollLive(); setInterval(pollLive, 4000); }

/** Make a just-arrived change impossible to miss: a beam of light on the building, a ripple for area rules. */
function highlight(ch: StoredChange) {
  const t = world.tiles.get(ch.tile);
  if (ch.change.kind === "rule") {
    const [w, s2, e, n] = ch.change.scope.bbox as number[];
    const [x0, z0] = proj.xz([w, n]), [x1, z1] = proj.xz([e, s2]);
    flashChange(scene, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, radius: Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) / 2, area: true });
    return;
  }
  const b = t?.buildings.get((ch.change as { target: string }).target);
  if (!b) return;
  const [x, z] = proj.xz(b.centroid);
  const h = Math.max(10, ...b.volumes.map((v) => v.height + (v.roof.height ?? 0)));
  flashChange(scene, { x, z, height: h, radius: 6 });
}

// Activity feed: the latest changes anywhere; click one to fly there.
const feed: { ch: StoredChange; at: number }[] = [];
function pushActivity(ch: StoredChange) {
  feed.unshift({ ch, at: Date.now() });
  feed.length = Math.min(feed.length, 8);
  renderFeed();
}
function renderFeed() {
  const el = $("#activity");
  if (!feed.length) { el.hidden = true; return; }
  el.hidden = false;
  const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`; };
  el.innerHTML = `<div class="feed-title">Live</div>` + feed.map((f, i) => {
    const c = f.ch.change;
    const what = c.kind === "rule" ? `area style “${c.label}”` : c.kind === "building" ? (c.spec.name ?? (c.spec.model ? "a 3D model" : "a building")) : "a 3D model";
    return `<button data-i="${i}"><strong>${esc(f.ch.author)}</strong> ${c.kind === "rule" ? "restyled" : "updated"} ${esc(what)} <span class="muted">${ago(f.at)}</span></button>`;
  }).join("");
  el.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => (btn.onclick = () => {
    const f = feed[Number(btn.dataset.i)];
    const c = f.ch.change;
    let lonlat: [number, number] | null = null;
    if (c.kind === "rule") { const b = c.scope.bbox as number[]; lonlat = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
    else { const b = world.tiles.get(f.ch.tile)?.buildings.get(c.target); if (b) lonlat = b.centroid; }
    if (!lonlat) { const k = f.ch.tile.split("-").map(Number); lonlat = tileCenter({ x: k[0], y: k[1] }); }
    flyTo(lonlat);
  }));
}
setInterval(renderFeed, 10_000);

function flyTo([lon, lat]: [number, number]) {
  const [x, z] = proj.xz([lon, lat]);
  // far jumps re-centre the map; nearby ones glide
  if (Math.hypot(x - camera.position.x, z - camera.position.z) > 4000) { goTo(lon, lat); return; }
  if (mode !== "explore") setMode("explore");
  controls.glideTo(new THREE.Vector3(x, 0, z), 40, -35, 180);
}

// ---------------------------------------------------------------- render cameras inside buildings
/** The building (id) whose walls enclose point p, if any. */
function buildingAt(p: THREE.Vector3): string | null {
  const ll = proj.lonLat(p.x, p.z) as [number, number];
  for (const t of world.tiles.values()) {
    if (!bboxIntersects(t.bundle.base.bbox, [ll[0], ll[1], ll[0], ll[1]])) continue;
    for (const b of t.buildings.values()) {
      if (b.hidden) continue;
      for (const v of b.volumes) {
        if (p.y < v.minHeight - 0.1 || p.y > v.height + (v.roof.height ?? 0)) continue;
        if (v.polygons.some((poly) => pointInLL(ll, poly.outer as [number, number][]) && !poly.holes.some((h) => pointInLL(ll, h as [number, number][])))) return b.id;
      }
    }
  }
  return null;
}
function pointInLL(p: [number, number], ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/**
 * Agent renders: a camera standing inside another building shows only a wall. With a target,
 * walk the camera towards it until it's in the open; either way report what happened.
 */
function unblockCamera() {
  const report: { insideOf: string | null; movedMetres: number } = { insideOf: buildingAt(camera.position), movedMetres: 0 };
  if (report.insideOf && target && report.insideOf !== target) {
    const b = [...world.tiles.values()].map((t) => t.buildings.get(target)).find(Boolean);
    if (b) {
      const [tx, tz] = proj.xz(b.centroid);
      const start = camera.position.clone(), dir = new THREE.Vector3(tx - start.x, 0, tz - start.z);
      const total = dir.length(); dir.normalize();
      for (let d = 1; d < total; d += 1) {
        const q = start.clone().addScaledVector(dir, d);
        const at = buildingAt(q);
        if (at === target) break;
        if (!at) { camera.position.copy(q); report.movedMetres = d; break; }
      }
      const f = new THREE.Vector3(tx, camera.position.y, tz).sub(camera.position).normalize();
      controls.yaw = Math.atan2(f.x, -f.z);
    }
  }
  (window as unknown as { __SEEEARTH_CAMERA__: unknown }).__SEEEARTH_CAMERA__ = { ...report, stillInside: buildingAt(camera.position) };
}

/** Which buildings are actually visible in the frame, and which of the agent's drafts shaped them. */
function seenInFrame() {
  camera.updateMatrixWorld();
  const buildings = new Map<string, number>(), drafts = new Set<number>();
  const N = 40, M = 26;
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const p = pickAt(((i + 0.5) / N) * 2 - 1, ((j + 0.5) / M) * 2 - 1);
    if (!p) continue;
    buildings.set(p.building.id, (buildings.get(p.building.id) ?? 0) + 1);
    for (const l of p.building.layers) if ("id" in l && typeof l.id === "number" && l.id >= 1e9) drafts.add(l.id - 1e9);
  }
  // share of the frame each building fills (0–1), biggest first
  const share = [...buildings].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, share: Math.round((n / (N * M)) * 1000) / 1000 }));
  return { buildings: share, drafts: [...drafts].sort((a, b) => a - b) };
}
Object.assign(window, { __SEEEARTH_SEEN__: () => seenInFrame() });

// ---------------------------------------------------------------- loop
const clock = new THREE.Timer();
let readyFrames = 0;
let tick = 0;
// Auto quality: if the frame rate stays low once the map has loaded, step down a level.
const fpsWin = { t: 0, n: 0 };
function watchFps(raw: number) {
  if (RENDER || gfxPref !== "auto" || tier === "low" || document.hidden || raw > 0.5 || !loadingEl.hidden) { fpsWin.t = fpsWin.n = 0; return; }
  fpsWin.t += raw; fpsWin.n++;
  if (fpsWin.t < 4) return;
  const fps = fpsWin.n / fpsWin.t;
  fpsWin.t = fpsWin.n = 0;
  if (fps < 28) {
    void applyTier(TIER_ORDER[TIER_ORDER.indexOf(tier) - 1]);
    toast(`Graphics lowered to ${tier === "high" ? "High" : "Low"} to keep things smooth (change it in the menu)`);
  }
}

function frame() {
  clock.update();
  const raw = clock.getDelta();
  watchFps(raw);
  const dt = Math.min(raw, 0.1);
  if (mode === "walk") walker.update(dt, input);
  else if (mode === "fly") plane.update(dt, input);
  else { if (locked()) controls.look(input.dx, input.dy); controls.update(dt); }
  input.dx = input.dy = 0;
  // Until a render target is framed, load the map around the target itself (the origin),
  // not wherever the initial camera happens to be looking.
  const lp = !framed ? new THREE.Vector3(0, 0, 0) : mode === "walk" ? walker.position.clone() : mode === "fly" ? plane.position.clone().setY(0) : lookPoint();
  if (tick++ % 10 === 0) world.update(camera, lp);
  // Shadows cover what you're looking at: a tight box (sharp shadows) at street level, wider from the air.
  const half = THREE.MathUtils.clamp(Math.round((camera.position.y * 1.3 + 90) / 20) * 20, 100, 700);
  if (half !== shadowHalf) {
    shadowHalf = half; sc.left = sc.bottom = -half; sc.right = sc.top = half; sc.updateProjectionMatrix();
  }
  const fw = controls.forward();
  const focus = mode === "walk" ? walker.position.clone() : mode === "fly" ? plane.position.clone().setY(0)
    : new THREE.Vector3(camera.position.x, 0, camera.position.z).addScaledVector(new THREE.Vector3(fw.x, 0, fw.z).normalize(), Math.hypot(fw.x, fw.z) > 0.05 ? half * 0.6 : 0);
  // snap to shadow texels so shadows don't shimmer as the camera moves
  const texel = (2 * half) / SHADOW; focus.x = Math.round(focus.x / texel) * texel; focus.z = Math.round(focus.z / texel) * texel;
  sunLight.position.set(focus.x + sun.x * 1200, sun.y * 1200, focus.z + sun.z * 1200);
  sunLight.target.position.set(focus.x, 0, focus.z);
  ground.position.set(camera.position.x, 0, camera.position.z);
  for (const t of [groundMat.map!, groundMat.normalMap!]) t.offset.set((camera.position.x / GROUND_M) % 1, (-camera.position.z / GROUND_M) % 1);
  sky.position.copy(camera.position);
  const alt = camera.position.y;
  (scene.fog as THREE.Fog).near = 600 + alt * 2; (scene.fog as THREE.Fog).far = 2500 + alt * 6;
  updateEffects();
  world.pump(6);       // build queued tiles a few milliseconds per frame, so loading never stutters
  if (composer) composer.render(); else renderer.render(scene, camera);
  if (RENDER && !window.__SEEEARTH_READY__) {
    if (framed && world.allLoaded(world.wanted(camera, lp)) && world.assetsPending === 0) {
      if (readyFrames === 6) unblockCamera();
      if (++readyFrames > 8) window.__SEEEARTH_READY__ = true;
    } else readyFrames = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debugging / automation hooks
/** Export one loaded tile as a binary glTF (used by `seeearth export --format glb`). */
function exportTileGlb(key: string): Promise<ArrayBuffer> {
  const t = world.tiles.get(key);
  if (!t) return Promise.reject(new Error(`tile ${key} not loaded`));
  return new Promise((resolve, reject) => new GLTFExporter().parse(t.group, (glb) => resolve(glb as ArrayBuffer), reject, { binary: true }));
}
async function exportTileBase64(key: string): Promise<string> {
  const bytes = new Uint8Array(await exportTileGlb(key));
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
Object.assign(window, { seeearth: { world, camera, controls, proj, goTo, exportTileGlb, exportTileBase64, setMode, input, walker, plane } });

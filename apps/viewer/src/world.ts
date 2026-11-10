// Streams tiles around the camera and builds their meshes.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enhanceMaterial } from "./surface";
import {
  bboxIntersects, hashString, lonLatToTile, resolveGround, orientedRectLL, parseTileKey, resolveBuildings, ringAreaM2, tileKey, tileRing,
  type BBox, type ResolvedBuilding, type StoredChange, type TileBundle,
} from "@seeearth/core";
import { fetchTile, API } from "./api";
import { buildBuildings } from "./buildings";
import { buildGround } from "./ground";
import { buildTrees } from "./trees";
import type { Projector } from "./geo";

export interface LoadedTile {
  key: string;
  group: THREE.Group;
  bundle: TileBundle;
  buildings: Map<string, ResolvedBuilding>;
  /** Cleared on unload so late asset loads don't attach to a dead tile. */
  alive: boolean;
  /** Building and model meshes in this tile (for picking/collisions). */
  solids: THREE.Mesh[];
  center: THREE.Vector3;
}

declare global {
  interface Window {
    /** Unsubmitted changes injected by `seeearth render` so agents can preview their work. */
    __SEEEARTH_DRAFT__?: { tile?: string; changes: StoredChange["change"][] };
    __SEEEARTH_READY__?: boolean;
  }
}

const gltf = new GLTFLoader();
/** Largest factor a typology model is stretched along its width before the building falls back to its described shape. */
const MAX_STRETCH = 3.5;

/** Each uploaded model is downloaded once and shared by every building that uses it. */
const modelCache = new Map<string, Promise<{ scene: THREE.Object3D; size: THREE.Vector3; min: THREE.Vector3 } | null>>();
function loadModel(key: string) {
  let p = modelCache.get(key);
  if (!p) {
    p = gltf.loadAsync(`${API}/api/assets/${key}.glb`).then((g) => {
      const box = new THREE.Box3().setFromObject(g.scene);
      g.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = m.receiveShadow = true; m.geometry.computeBoundsTree(); for (const mat of Array.isArray(m.material) ? m.material : [m.material]) enhanceMaterial(mat); } });
      return { scene: g.scene, size: box.getSize(new THREE.Vector3()), min: box.min.clone() };
    }).catch((e) => { console.warn("model", key, e); return null; });
    modelCache.set(key, p);
  }
  return p;
}

export class World {
  tiles = new Map<string, LoadedTile>();
  /** Fixed number of tile rings to load around the view (plan renders only need neighbours). */
  ringOverride: number | null = null;
  private pending = new Set<string>();
  private failed = new Map<string, number>();
  root = new THREE.Group();
  /** Tiles downloaded but not yet built; built a little each frame (see pump). */
  private queue: { key: string; bundle: TileBundle }[] = [];
  assetsPending = 0;
  onTileLoaded: (t: LoadedTile) => void = () => {};
  onLoadingChange: (n: number) => void = () => {};

  constructor(private proj: Projector, private renderer: THREE.WebGLRenderer) {}

  wanted(cam: THREE.PerspectiveCamera, look: THREE.Vector3): string[] {
    const [lon, lat] = this.proj.lonLat(look.x, look.z);
    const c = lonLatToTile(lon, lat);
    const alt = cam.position.y;
    const R = this.ringOverride ?? (alt < 120 ? 1 : alt < 700 ? 2 : 3);
    const keys: string[] = [];
    for (let r = 0; r <= R; r++) for (const t of tileRing(c, r)) keys.push(tileKey(t));
    return keys;
  }

  update(cam: THREE.PerspectiveCamera, look: THREE.Vector3) {
    const want = this.wanted(cam, look);
    const wantSet = new Set(want);
    for (const key of want) {
      if (this.tiles.has(key) || this.pending.has(key)) continue;
      if ((this.failed.get(key) ?? 0) > Date.now()) continue;
      if (this.pending.size >= 2) break;
      this.load(key);
    }
    // unload far tiles (keep a margin)
    const [lon, lat] = this.proj.lonLat(look.x, look.z);
    const c = lonLatToTile(lon, lat);
    for (const [key, t] of this.tiles) {
      if (wantSet.has(key)) continue;
      const { x, y } = parseTileKey(key);
      if (Math.max(Math.abs(x - c.x), Math.abs(y - c.y)) > 5) this.unload(t);
    }
  }

  allLoaded(keys: string[]) { return this.queue.length === 0 && keys.every((k) => this.tiles.has(k) || (this.failed.get(k) ?? 0) > Date.now()); }

  /** Build queued tiles for up to `budgetMs` this frame (at least one). */
  pump(budgetMs: number) {
    const t0 = performance.now();
    while (this.queue.length) {
      const { key, bundle } = this.queue.shift()!;
      if (!this.tiles.has(key)) this.add(key, bundle);
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  /** Meshes worth raycasting (buildings and models), optionally only near a point. */
  pickables(near?: THREE.Vector3, radius = 300): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const t of this.tiles.values()) {
      if (near) {
        const c = t.center;
        if (Math.hypot(c.x - near.x, c.z - near.z) > radius + 400) continue;
      }
      out.push(...t.solids);
    }
    return out;
  }

  private async load(key: string) {
    this.pending.add(key); this.onLoadingChange(this.pending.size);
    try {
      const bundle = await fetchTile(key);
      this.queue.push({ key, bundle });
    } catch (e) {
      console.warn("tile", key, e);
      this.failed.set(key, Date.now() + 15_000);
    } finally {
      this.pending.delete(key); this.onLoadingChange(this.pending.size);
    }
  }

  private draftFor(bundle: TileBundle): StoredChange[] {
    const d = window.__SEEEARTH_DRAFT__;
    if (!d?.changes?.length) return [];
    // id = 1e9 + the draft's position in the list the CLI injected, so renders can report which drafts they showed
    return d.changes
      .map((change, i) => ({ id: 1e9 + i, tile: bundle.base.tile, author: "(your draft)", createdAt: Date.now() + i, change }))
      .filter(({ change: c }) => {
        try { return c.kind === "rule" ? bboxIntersects(c.scope.bbox as BBox, bundle.base.bbox) : d.tile === bundle.base.tile; }
        catch { return false; } // malformed draft: the CLI validates before injecting, but never break the view
      });
  }

  /** Re-download a loaded tile and rebuild it (live updates). */
  async refresh(key: string) {
    if (!this.tiles.has(key)) return;
    try {
      const bundle = await fetchTile(key);
      const t = this.tiles.get(key);
      if (!t) return;
      this.unload(t);
      this.add(key, bundle);   // live updates build immediately
    } catch (e) { console.warn("refresh", key, e); }
  }

  /** Rebuild a tile (e.g. after a draft changes). */
  rebuild(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    this.unload(t);
    this.add(key, t.bundle);
  }

  private add(key: string, bundle: TileBundle) {
    const group = new THREE.Group();
    group.name = `tile ${key}`;
    const changes = [...bundle.changes, ...this.draftFor(bundle)];
    const resolved = resolveBuildings({ buildings: bundle.base.buildings, changes });
    const ctx = { proj: this.proj, renderer: this.renderer };
    const highlight = new URLSearchParams(location.search).get("highlight") === "1";
    const meshes = buildBuildings(resolved, ctx, highlight ? { dim: (b) => !b.contributors.includes("(your draft)") } : {}).meshes();
    for (const m of meshes) {
      m.userData.tile = key; group.add(m);
      m.geometry.computeBoundsTree();   // fast picking & collisions
    }
    const ground = resolveGround(changes);
    for (const g of buildGround(bundle.base.roads, bundle.base.rails, bundle.base.areas, this.proj, ground)) group.add(g);
    for (const t of buildTrees(bundle.base, this.proj, ground)) group.add(t);
    const buildings = new Map(resolved.map((b) => [b.id, b]));
    this.root.add(group);
    const [w, s0, e, n] = bundle.base.bbox;
    const [cx, cz] = this.proj.xz([(w + e) / 2, (s0 + n) / 2]);
    const t: LoadedTile = { key, group, bundle, buildings, alive: true, solids: [...meshes], center: new THREE.Vector3(cx, 0, cz) };
    for (const b of resolved) if (b.asset) this.loadAsset(b, t);
    this.placeModels(resolved.filter((b) => b.model && !b.asset && !b.hidden), t);
    this.tiles.set(key, t);
    this.onTileLoaded(t);
  }

  private loadAsset(b: ResolvedBuilding, tile: LoadedTile) {
    const { group, key } = tile;
    const a = b.asset!.change;
    this.assetsPending++;
    gltf.load(`${API}/api/assets/${a.assetKey}.glb`, (g) => {
      const obj = g.scene;
      const [x, z] = this.proj.xz([a.transform.lon, a.transform.lat]);
      obj.position.set(x, a.transform.altitude, z);
      obj.rotation.y = -(a.transform.heading * Math.PI) / 180;
      obj.scale.setScalar(a.transform.scale);
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; o.userData.owner = b.id; o.userData.tile = key; tile.solids.push(o as THREE.Mesh); }
      });
      this.assetsPending--;
      if (!tile.alive) { disposeTree(obj); return; }
      group.add(obj);
    }, undefined, (e) => { console.warn("asset", a.assetKey, e); this.assetsPending--; });
  }

  /** Fit a typology/landmark model onto the building's footprint (see core ModelRef). */
  /**
   * Fit typology/landmark models onto their footprints (see core ModelRef). All copies of the same
   * model in a tile are drawn as ONE instanced mesh per material, so hundreds of houses cost a
   * handful of draw calls.
   */
  private async placeModels(list: ResolvedBuilding[], tile: LoadedTile) {
    if (!list.length) return;
    this.assetsPending++;
    try {
      const keys = [...new Set(list.flatMap((b) => b.model!.assets))];
      const loaded = new Map<string, NonNullable<Awaited<ReturnType<typeof loadModel>>>>();
      await Promise.all(keys.map(async (k) => { const v = await loadModel(k); if (v) loaded.set(k, v); }));
      if (!tile.alive) return;
      const byVariant = new Map<string, { m: THREE.Matrix4; owner: string }[]>();
      // road points in this tile, for turning model fronts towards the street
      // (streets first; named pedestrian streets and cycleways count where no street is within 30 m)
      const roadPts: [number, number][] = [], pathPts: [number, number][] = [];
      for (const r of tile.bundle.base.roads) {
        const minor = /footway|path|steps|cycleway|track|service|pedestrian/.test(r.tags.highway ?? "");
        if (minor && !r.tags.name) continue; // unnamed paths cross yards and quads: not a street front
        for (const p of r.line) (minor ? pathPts : roadPts).push(this.proj.xz(p));
      }
      for (const b of list) {
        const m = b.model!;
        const ring = b.volumes[0]?.polygons.reduce((a, p) => (p.outer.length > a.length ? p.outer : a), [] as [number, number][]) ?? [];
        const variants = m.assets.map((k) => [k, loaded.get(k)] as const).filter((x): x is readonly [string, NonNullable<typeof x[1]>] => !!x[1]);
        if (ring.length < 4 || !variants.length) continue;
        if (m.fit === "none") {
          // built on the real footprint at real size: origin = footprint bbox centre, −Z = north
          let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
          for (const [lon, lat] of ring) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
          const [cx, cz] = this.proj.xz([(w + e) / 2, (s + n) / 2]);
          const key = variants[m.seed % variants.length][0];
          const place = new THREE.Matrix4().compose(new THREE.Vector3(cx, m.minHeight, cz),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -THREE.MathUtils.degToRad(m.heading ?? 0)), new THREE.Vector3(1, 1, 1));
          byVariant.set(key, [...(byVariant.get(key) ?? []), { m: place, owner: b.id }]);
          continue;
        }
        const r = orientedRectLL(ring);
        // L-shapes, courtyards and other non-rectangular footprints would be filled in solid by a
        // stretched box-shaped model: keep their procedural shape instead.
        const fill = Math.abs(ringAreaM2(ring)) / Math.max(1, 4 * r.hl * r.hw);
        if (m.fit !== "uniform" && fill < 0.7) { this.fallbackVolumes(b, tile); continue; }
        const [cx, cz] = this.proj.xz(r.at(0, 0));
        // nearest street (or, failing that within 30 m, the nearest path or pedestrian street)
        const nearest = (pts: [number, number][]) => { let best: [number, number] | null = null, bd = Infinity; for (const p of pts) { const d = (p[0] - cx) ** 2 + (p[1] - cz) ** 2; if (d < bd) { bd = d; best = p; } } return { p: best, d: bd }; };
        let nr = nearest(roadPts);
        if (nr.d > 30 * 30) { const np = nearest(pathPts); if (np.d < nr.d) nr = np; }
        const near = nr.p;
        if (m.heading != null) {
          // Explicit compass heading for the front: pick the footprint side facing closest to it,
          // then fit the model's width (X) along that side and its depth (Z) into the plot. This
          // works for wide ranges and for narrow, deep shop plots alike.
          const hd = THREE.MathUtils.degToRad(m.heading), want = [Math.sin(hd), Math.cos(hd)]; // (east, north)
          const u = r.ax, v: [number, number] = [-r.ax[1], r.ax[0]];
          const sides = [{ n: v, w: r.hl, d: r.hw }, { n: [-v[0], -v[1]], w: r.hl, d: r.hw }, { n: u, w: r.hw, d: r.hl }, { n: [-u[0], -u[1]], w: r.hw, d: r.hl }];
          const side = sides.sort((a, c) => (c.n[0] * want[0] + c.n[1] * want[1]) - (a.n[0] * want[0] + a.n[1] * want[1]))[0];
          const aspect = side.w / Math.max(side.d, 0.5);
          const ranked = variants.map(([key, v]) => ({ key, v, score: Math.abs(Math.log(v.size.x / Math.max(0.5, v.size.z) / aspect)) })).sort((a, c) => a.score - c.score);
          const pick = ranked[m.seed % Math.min(3, ranked.length)];
          let sx = (2 * side.w) / pick.v.size.x, sz = (2 * side.d) / pick.v.size.z, sy = (sx + sz) / 2;
          if (sx > MAX_STRETCH && m.fit !== "uniform") { this.fallbackVolumes(b, tile); continue; } // one shop stretched over a whole block
          if (m.fit === "uniform") sx = sz = sy = Math.min(sx, sz);
          else { const total = pick.v.size.y * sy, target = Math.max(4, m.height); if (total > target * 1.8 || total < target * 0.6) sy = (target * 1.2) / pick.v.size.y; }
          // model −Z → side.n: a rotation by yaw sends −Z to (east −sin yaw, north cos yaw)
          const yaw = Math.atan2(-side.n[0], side.n[1]);
          const place = new THREE.Matrix4().compose(new THREE.Vector3(cx, m.minHeight, cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sx, sy, sz));
          place.multiply(new THREE.Matrix4().makeTranslation(-(pick.v.min.x + pick.v.size.x / 2), -pick.v.min.y, -(pick.v.min.z + pick.v.size.z / 2)));
          byVariant.set(pick.key, [...(byVariant.get(pick.key) ?? []), { m: place, owner: b.id }]);
          continue;
        }
        const fpAspect = r.hl / Math.max(r.hw, 0.5);
        // rank variants by how well their proportions match this footprint; pick among the best few
        const ranked = variants.map(([key, v]) => {
          const long = Math.max(v.size.x, v.size.z), short = Math.max(0.5, Math.min(v.size.x, v.size.z));
          return { key, v, long, short, turn: v.size.z > v.size.x, score: Math.abs(Math.log(long / short / fpAspect)) };
        }).sort((a, c) => a.score - c.score);
        const pick = ranked[m.seed % Math.min(3, ranked.length)];
        const sl = (2 * r.hl) / pick.long, ss = (2 * r.hw) / pick.short;
        // a typology is built at a typical real size: stretched more than 3.5× (a merged block,
        // a whole terrace drawn as one outline) it looks absurd, so draw the outline instead
        if (sl > MAX_STRETCH && m.fit !== "uniform") { this.fallbackVolumes(b, tile); continue; }
        let sx = sl, sz = ss, sy = (sl + ss) / 2;
        if (m.fit === "uniform") sx = sz = sy = Math.min(sl, ss);
        else {
          // keep the overall height believable relative to the building's known height
          const total = pick.v.size.y * sy, target = Math.max(4, m.height);
          if (total > target * 1.8 || total < target * 0.6) sy = (target * 1.2) / pick.v.size.y;
        }
        // Which way should the model's front (−Z) face? Towards the nearest road.
        const baseYaw = Math.atan2(r.ax[1], r.ax[0]) + (pick.turn ? Math.PI / 2 : 0);
        const frontAt = (yaw: number) => new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        let yaw = baseYaw;
        if (near) { const f = frontAt(baseYaw); if (f.x * (near[0] - cx) + f.z * (near[1] - cz) < 0) yaw += Math.PI; }
        else if ((m.seed >> 3) % 2) yaw += Math.PI;
        const place = new THREE.Matrix4().compose(
          new THREE.Vector3(cx, m.minHeight, cz),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw - (pick.turn ? Math.PI / 2 : 0)),
          new THREE.Vector3(sx, sy, sz),
        );
        if (pick.turn) place.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
        place.multiply(new THREE.Matrix4().makeTranslation(-(pick.v.min.x + pick.v.size.x / 2), -pick.v.min.y, -(pick.v.min.z + pick.v.size.z / 2)));
        byVariant.set(pick.key, [...(byVariant.get(pick.key) ?? []), { m: place, owner: b.id }]);
      }
      for (const [key, placements] of byVariant) {
        const v = loaded.get(key)!;
        v.scene.updateMatrixWorld(true);
        v.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
          placements.forEach((p, i) => inst.setMatrixAt(i, p.m.clone().multiply(mesh.matrixWorld)));
          inst.instanceMatrix.needsUpdate = true;
          // Repeated typology models: each house gets slightly different stone, render and roof
          // weathering, so a terrace doesn't look copy-pasted. Glass and paint stay exact.
          const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
          if (placements.length > 1 && mat.map) {
            const c = new THREE.Color();
            placements.forEach((p, i) => {
              const h = hashString(p.owner);
              const l = 0.9 + ((h & 255) / 255) * 0.14, warm = (((h >> 8) & 255) / 255 - 0.5) * 0.06;
              inst.setColorAt(i, c.setRGB(l * (1 + warm), l, l * (1 - warm)));
            });
          }
          inst.computeBoundingSphere(); inst.computeBoundingBox();
          inst.castShadow = inst.receiveShadow = true;
          inst.userData = { shared: true, tile: tile.key, instanceOwners: placements.map((p) => p.owner) };
          tile.group.add(inst);
          tile.solids.push(inst);
        });
      }
    } finally { this.assetsPending--; }
  }

  /** Draw a building procedurally after all (its footprint doesn't suit a fitted model). */
  private fallbackVolumes(b: ResolvedBuilding, tile: LoadedTile) {
    const meshes = buildBuildings([{ ...b, model: undefined }], { proj: this.proj, renderer: this.renderer }).meshes();
    for (const m of meshes) { m.userData.tile = tile.key; m.geometry.computeBoundsTree(); tile.group.add(m); tile.solids.push(m); }
  }

  private unload(t: LoadedTile) {
    t.alive = false;
    this.root.remove(t.group);
    disposeTree(t.group);
    this.tiles.delete(t.key);
  }

  /** Resolve a raycast hit to the building it belongs to. */
  pick(hit: THREE.Intersection): { tile: LoadedTile; building: ResolvedBuilding } | null {
    const o = hit.object;
    let owner: string | undefined;
    const owners = o.userData.owners as string[] | undefined;
    if (owners && hit.faceIndex != null) {
      // owners[] is in the original triangle order. three-mesh-bvh adds an index to non-indexed
      // geometry and sorts triangles in it, so map the hit back through that index.
      const idx = (o as THREE.Mesh).geometry?.index;
      owner = owners[idx ? Math.floor(idx.getX(hit.faceIndex * 3) / 3) : hit.faceIndex];
    }
    const inst = o.userData.instanceOwners as string[] | undefined;
    if (!owner && inst && hit.instanceId != null) owner = inst[hit.instanceId];
    let p: THREE.Object3D | null = o;
    while (!owner && p) { owner = p.userData.owner; p = p.parent; }
    let tileKeyStr: string | undefined = o.userData.tile;
    p = o;
    while (!tileKeyStr && p) { tileKeyStr = p.userData.tile; p = p.parent; }
    if (!owner || !tileKeyStr) return null;
    const tile = this.tiles.get(tileKeyStr);
    const building = tile?.buildings.get(owner);
    return tile && building ? { tile, building } : null;
  }
}

/** Free geometry, plus materials/textures that belong only to loaded models (shared procedural materials are cached). */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m as unknown as THREE.InstancedMesh).isInstancedMesh) { (m as unknown as THREE.InstancedMesh).dispose(); return; }
    if (!m.isMesh || m.userData.shared) return; // shared model geometry stays cached
    m.geometry.disposeBoundsTree?.();
    m.geometry.dispose();
    if (m.userData.owner) {
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
        mat.dispose();
      }
    }
  });
}

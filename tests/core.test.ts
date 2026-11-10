import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assembleRings, inspectGlb, tileQuality, lonLatToTile, parseOverpass, parseTileKey, resolveBuildings, ringAreaM2,
  styleFromTags, tileBBox, tileKey, tileRing, validateChange, type StoredChange, type LL,
} from "../packages/core/src/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/overpass-46295-26701.json", import.meta.url), "utf8"));
const tile = parseTileKey("46295-26701");
const base = parseOverpass(fixture, tile, 0);

describe("tiles", () => {
  it("round-trips lon/lat into the right tile bbox", () => {
    const t = lonLatToTile(74.31, 31.588);
    const [w, s, e, n] = tileBBox(t);
    expect(74.31).toBeGreaterThanOrEqual(w); expect(74.31).toBeLessThan(e);
    expect(31.588).toBeGreaterThanOrEqual(s); expect(31.588).toBeLessThan(n);
    expect(tileKey(t)).toBe("46295-26701");
  });
  it("rings have 8r tiles", () => {
    expect(tileRing({ x: 100, y: 100 }, 0)).toHaveLength(1);
    expect(tileRing({ x: 100, y: 100 }, 1)).toHaveLength(8);
    expect(tileRing({ x: 100, y: 100 }, 3)).toHaveLength(24);
  });
});

describe("osm parsing", () => {
  it("extracts buildings owned by the tile", () => {
    expect(base.buildings.length).toBeGreaterThan(5);
    for (const b of base.buildings) {
      expect(b.centroid[0]).toBeGreaterThanOrEqual(base.bbox[0]);
      expect(b.centroid[0]).toBeLessThan(base.bbox[2]);
      expect(b.polygons[0].outer.length).toBeGreaterThanOrEqual(4);
    }
    expect(base.roads.length).toBeGreaterThan(0);
  });
  it("assembles multipolygon rings from open segments", () => {
    const a: LL[] = [[0, 0], [1, 0]], b: LL[] = [[1, 1], [1, 0]], c: LL[] = [[1, 1], [0, 1], [0, 0]];
    const rings = assembleRings([a, b, c]);
    expect(rings).toHaveLength(1);
    expect(Math.abs(ringAreaM2(rings[0]))).toBeGreaterThan(1e9);
  });
});

describe("tag styles", () => {
  it("reads heights, levels and roof tags", () => {
    const s = styleFromTags({ height: "30 m", "building:levels": "8", "roof:shape": "gabled", "roof:height": "4", "building:colour": "white", "building:material": "brick" });
    expect(s.height).toBe(26);
    expect(s.floors).toBe(8);
    expect(s.roof).toMatchObject({ shape: "gabled", height: 4 });
    expect(s.facade).toMatchObject({ material: "brick", color: "#f2f0ea" });
  });
});

const target = () => base.buildings.find((b) => !b.isPart)!;
const sc = (id: number, author: string, change: any, createdAt = id): StoredChange => ({ id, author, createdAt, tile: base.tile, change });

describe("layer resolution", () => {
  it("applies rule then spec, most specific wins", () => {
    const b = target();
    const [lon, lat] = b.centroid;
    const wide = { kind: "rule", label: "wide", scope: { bbox: [lon - 0.2, lat - 0.2, lon + 0.2, lat + 0.2] }, select: { tags: { building: "*" } }, set: { facade: { material: "brick", color: "#aa5533" }, floors: 3 }, sources: [] };
    const narrow = { kind: "rule", label: "narrow", scope: { bbox: [lon - 0.001, lat - 0.001, lon + 0.001, lat + 0.001] }, select: { tags: { building: "*" } }, set: { facade: { color: "#ffffff" } }, sources: [] };
    const spec = { kind: "building", target: b.id, spec: { floors: 7 }, sources: [] };
    // narrow created before wide: specificity, not time, decides rule order
    const res = resolveBuildings({ buildings: [b], changes: [sc(1, "alice", narrow), sc(2, "bob", wide), sc(3, "carol", spec)] });
    const v = res[0].volumes[0];
    expect(v.floors).toBe(7);
    expect(v.facade.material).toBe("brick");
    expect(v.facade.color).toBe("#ffffff");
    expect(res[0].contributors[0]).toBe("carol");
    expect(res[0].layers.map((l) => l.kind)).toEqual(["osm", "rule", "rule", "spec"]);
  });
  it("creates new buildings from n: targets", () => {
    const [lon, lat] = target().centroid;
    const fp: LL[] = [[lon, lat], [lon + 0.0002, lat], [lon + 0.0002, lat + 0.0002], [lon, lat + 0.0002], [lon, lat]];
    const res = resolveBuildings({ buildings: [], changes: [sc(1, "a", { kind: "building", target: "n:new-kiosk", spec: { footprint: fp, floors: 1 }, sources: [] })] });
    expect(res).toHaveLength(1);
    expect(res[0].volumes[0].height).toBeCloseTo(3.2);
  });
});

describe("validation", () => {
  it("accepts a well-formed spec", () => {
    const r = validateChange({ kind: "building", target: target().id, spec: { floors: 3, facade: { material: "brick", color: "#a0522d" } }, sources: [{ url: "https://commons.wikimedia.org/wiki/File:X.jpg", kind: "wikimedia" }] }, base);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("rejects empty specs and oversized payloads", () => {
    const src = [{ url: "https://example.org/x.jpg" }];
    expect(validateChange({ kind: "building", target: target().id, spec: { name: "x" }, sources: src }, base).ok).toBe(false);
    const big = { kind: "building", target: target().id, spec: { floors: 2 }, sources: src, note: "x".repeat(70_000) };
    expect(validateChange(big, base).ok).toBe(false);
  });
  it("rejects unknown targets, bad colours and unknown fields", () => {
    expect(validateChange({ kind: "building", target: "w1", spec: {} }, base).ok).toBe(false);
    expect(validateChange({ kind: "building", target: target().id, spec: { facade: { color: "red" } } }, base).ok).toBe(false);
    expect(validateChange({ kind: "building", target: target().id, spec: { wings: 3 } }, base).ok).toBe(false);
  });
  it("bounds rules", () => {
    const [lon, lat] = target().centroid;
    const src = [{ url: "https://commons.wikimedia.org/wiki/Category:Lahore" }];
    const ok = validateChange({ kind: "rule", label: "old city brick", scope: { bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01] }, select: { tags: { building: "yes|house" } }, set: { facade: { material: "brick" } }, sources: src }, base);
    expect(ok.errors).toEqual([]);
    const huge = validateChange({ kind: "rule", label: "everything", scope: { bbox: [lon - 2, lat - 2, lon + 2, lat + 2] }, select: { tags: { building: "house" } }, set: { floors: 2 }, sources: src }, base);
    expect(huge.ok).toBe(false);
    const wildcard = validateChange({ kind: "rule", label: "all buildings", scope: { bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01] }, select: { tags: { building: "*" } }, set: { floors: 2 }, sources: src }, base);
    expect(wildcard.errors.join()).toMatch(/concrete value/);
    const unsourced = validateChange({ kind: "rule", label: "no sources", scope: { bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01] }, select: { tags: { building: "house" } }, set: { floors: 2 } }, base);
    expect(unsourced.errors.join()).toMatch(/sources is required/);
    const narrow = validateChange({ kind: "rule", label: "district", scope: { bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1] }, select: { tags: { building: "house" } }, set: { floors: 2 }, sources: src }, base, { ruleMaxSpanDeg: 0.06 });
    expect(narrow.ok).toBe(false);
  });
});

describe("glb", () => {
  it("rejects non-glb data", () => {
    expect(inspectGlb(new TextEncoder().encode("hello world, not a glb").buffer, { maxBytes: 1e6, maxTriangles: 10 }).ok).toBe(false);
  });
  it("counts triangles in a minimal glb", () => {
    const json = JSON.stringify({ asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], accessors: [{ count: 6, componentType: 5126, type: "VEC3" }] });
    const pad = (4 - (json.length % 4)) % 4;
    const jb = new TextEncoder().encode(json + " ".repeat(pad));
    const buf = new ArrayBuffer(20 + jb.length);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, buf.byteLength, true);
    dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(buf, 20).set(jb);
    const info = inspectGlb(buf, { maxBytes: 1e6, maxTriangles: 10 });
    expect(info.triangles).toBe(2);
    expect(info.ok).toBe(true);
  });
});

describe("towers, parts and storeys", () => {
  it("derives storey height from height + floors", () => {
    const b = target();
    const res = resolveBuildings({ buildings: [b], changes: [sc(1, "a", { kind: "building", target: b.id, spec: { height: 16, floors: 2 }, sources: [] })] });
    expect(res[0].volumes[0].floorHeight).toBe(8);
  });
  it("places corner towers as extra volumes", () => {
    const b = target();
    const res = resolveBuildings({ buildings: [b], changes: [sc(1, "a", { kind: "building", target: b.id, spec: { towers: [{ at: "corners", height: 40, radius: 2 }, { at: "centre", height: 12, radius: 5, roof: { shape: "onion" } }] }, sources: [] })] });
    const v = res[0].volumes;
    expect(v).toHaveLength(1 + 4 + 1);
    expect(v[1].height).toBe(40);
    expect(v[1].roof.shape).toBe("dome");
    expect(v[5].roof.shape).toBe("onion");
  });
  it("passes outline specs down to OSM building:parts", () => {
    const sq = (lon: number, lat: number, d: number): LL[] => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];
    const [lon, lat] = target().centroid;
    const outline = { id: "w1", tags: { building: "church" }, polygons: [{ outer: sq(lon, lat, 0.001), holes: [] }], centroid: [lon + 0.0005, lat + 0.0005] as LL, areaM2: 9000, hasParts: true };
    const part = { id: "w2", tags: { "building:part": "yes", height: "30" }, polygons: [{ outer: sq(lon + 0.0002, lat + 0.0002, 0.0003), holes: [] }], centroid: [lon + 0.00035, lat + 0.00035] as LL, areaM2: 900, isPart: true };
    const res = resolveBuildings({ buildings: [outline, part], changes: [sc(1, "a", { kind: "building", target: "w1", spec: { facade: { material: "stone", color: "#ccbbaa" } }, sources: [] })] });
    const o = res.find((r) => r.id === "w1")!, p = res.find((r) => r.id === "w2")!;
    expect(o.hidden).toBe(true);
    expect(p.volumes[0].facade.color).toBe("#ccbbaa");
    expect(p.volumes[0].height).toBe(30);
    expect(p.contributors).toContain("a");
  });
});

describe("layering and completeness", () => {
  it("OSM-measured heights beat area rules", () => {
    const b = { ...target(), tags: { building: "apartments", "building:levels": "10", height: "32" } };
    const [lon, lat] = b.centroid;
    const rule = { kind: "rule", label: "low houses", scope: { bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01] }, select: { tags: { building: "apartments" } }, set: { floors: 2, height: 7, facade: { color: "#aabbcc" } }, sources: [] };
    const v = resolveBuildings({ buildings: [b], changes: [sc(1, "a", rule)] })[0].volumes[0];
    expect(v.height).toBe(32);
    expect(v.floors).toBe(10);
    expect(v.facade.color).toBe("#aabbcc");
  });
  it("a spec with only floors re-derives an inherited height", () => {
    const b = { ...target(), tags: { building: "yes", height: "7" } };
    const v = resolveBuildings({ buildings: [b], changes: [sc(1, "a", { kind: "building", target: b.id, spec: { floors: 10 }, sources: [] })] })[0].volumes[0];
    expect(v.floors).toBe(10);
    expect(v.height).toBeCloseTo(32);
  });
  it("scores tiles by sourced landmark specs and rule coverage", () => {
    const q0 = tileQuality(base, []);
    expect(q0.score).toBeLessThan(0.7);
    const src = [{ url: "https://example.org/a.jpg" }];
    const changes = [
      ...q0.missing.map((id, i) => sc(i + 1, "a", { kind: "building", target: id, spec: { floors: 3, facade: { material: "brick" } }, sources: src })),
      sc(99, "a", { kind: "rule", label: "all", scope: { bbox: base.bbox }, select: { tags: { building: "yes|house|residential|apartments|retail|commercial|school|mosque|hospital|office|public|industrial|construction|roof|hut|shed|garage|garages|university|college|kindergarten|church|temple|warehouse|hotel|government|civic" } }, set: { floors: 2 }, sources: src }),
    ];
    const q1 = tileQuality(base, changes);
    expect(q1.notableCovered).toBe(q1.notable);
    expect(q1.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe("completeness can't be gamed", () => {
  const src = [{ url: "https://example.org/a.jpg" }];
  it("hidden or numbers-only specs don't count; incremental and parts-only specs do", () => {
    const ids = tileQuality(base, []).missing;
    const hidden = tileQuality(base, ids.map((id, i) => sc(i + 1, "a", { kind: "building", target: id, spec: { hidden: true }, sources: src })));
    expect(hidden.notableCovered).toBe(0);
    const junk = tileQuality(base, ids.map((id, i) => sc(i + 1, "a", { kind: "building", target: id, spec: { height: 1, floors: 0, facade: { color: "#ffffff" } }, sources: src })));
    expect(junk.notableCovered).toBe(0);
    const id = ids[0];
    const inc = tileQuality(base, [
      sc(1, "a", { kind: "building", target: id, spec: { height: 20 }, sources: src }),
      sc(2, "a", { kind: "building", target: id, spec: { roof: { shape: "dome" } }, sources: src }),
    ]);
    expect(inc.notableCovered).toBe(1);
    const towersOnly = tileQuality(base, [sc(1, "a", { kind: "building", target: id, spec: { towers: [{ at: "corners", height: 30, radius: 2 }] }, sources: src })]);
    expect(towersOnly.notableCovered).toBe(1);
  });
});

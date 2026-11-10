import { describe, expect, it } from "vitest";
import { tileBBox, type BaseTile, type LL, type ResolvedBuilding, type ResolvedGround } from "@seeearth/core";
import { Projector } from "./geo";
import { analyseTile, vote } from "./infill";

const tile = { x: 32539, y: 21720 };
const [w, s, e, n] = tileBBox(tile);
const proj = new Projector((w + e) / 2, (s + n) / 2);
/** Square ring of half-size h (metres) around (x, z) in local coordinates, as lon/lat. */
const sq = (x: number, z: number, h: number): LL[] => {
  const r: [number, number][] = [[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h], [x - h, z - h]];
  return r.map(([px, pz]) => proj.lonLat(px, pz));
};
/** A block of buildings around an enclosed courtyard (a donut footprint). */
const quad = (id: string, x: number, z: number) =>
  ({ id, hidden: false, volumes: [{ minHeight: 0, polygons: [{ outer: sq(x, z, 35), holes: [sq(x, z, 18)] }] }] }) as unknown as ResolvedBuilding;

const base = { tile: "32539-21720", bbox: [w, s, e, n], fetchedAt: 0, buildings: [], roads: [], rails: [], areas: [], trees: [], treeRows: [] } as unknown as BaseTile;
const lawn: ResolvedGround = { id: "g:quad-a-lawn", label: "lawn", surface: "grass", area: sq(-80, 0, 12), holes: [], author: "t", changeId: 1 };

describe("ground infill", () => {
  const a = analyseTile(base, [quad("w1", -80, 0), quad("w2", 80, 0)], [lawn], proj);
  const courts = a.regions.filter((r) => r.cls === "court");

  it("finds both courtyards and learns from the patch", () => {
    expect(courts).toHaveLength(2);
    expect(a.evidence).toEqual([expect.objectContaining({ cls: "court", surface: "grass" })]);
  });

  it("leaves the patched courtyard alone and fills the empty one", () => {
    const [patched, empty] = [...courts].sort((p, q) => p.cx - q.cx);
    expect(patched.looked).toBe(true);
    expect(empty.looked).toBe(false);
    expect(vote(empty, a.evidence)?.surface).toBe("grass");
  });

  it("makes no guess without nearby evidence of the same kind", () => {
    const empty = courts.find((r) => !r.looked)!;
    expect(vote({ ...empty, cls: "back" }, a.evidence)).toBeNull();
    expect(vote({ ...empty, cx: empty.cx + 5000 }, a.evidence)).toBeNull();
  });
});

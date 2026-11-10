import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ccw, edges, front, offset, quoins, prism } from "./kit";

type P = [number, number];
// 20 m (east) × 10 m (north) rectangle; z points south
const rect: P[] = [[-10, -5], [10, -5], [10, 5], [-10, 5]]; // north edge first (z = -5)
const m = new THREE.MeshStandardMaterial();

describe("kit outline helpers", () => {
  it("edges report compass bearings for either winding", () => {
    for (const r of [rect, [...rect].reverse()]) {
      const byBearing = Object.fromEntries(edges(r).map((e) => [Math.round(e.bearing), e.length]));
      expect(byBearing).toEqual({ 0: 20, 90: 10, 180: 20, 270: 10 });
    }
  });
  it("offset grows the outline outward for either winding", () => {
    for (const r of [rect, [...rect].reverse()]) {
      const xs = offset(r, 1).map((p) => p[0]), zs = offset(r, 1).map((p) => p[1]);
      expect(Math.max(...xs)).toBeCloseTo(11); expect(Math.min(...zs)).toBeCloseTo(-6);
    }
  });
  it("front finds the street edge and places objects on it", () => {
    const f = front(rect, 180);
    expect(Math.round(f.bearing)).toBe(180);
    const g = f.place(new THREE.Object3D(), f.length / 2);
    expect(g.position.z).toBeCloseTo(5);
  });
  it("prism and quoins work on clockwise rings", () => {
    const cw = [...ccw(rect)].reverse();
    const p = prism(cw, 0, 3, m); p.geometry.computeBoundingBox();
    expect(p.geometry.boundingBox!.max.y).toBeCloseTo(3);
    expect(quoins(cw, 0, 3, m).children.length).toBeGreaterThan(8 * 2);
    // an L-shape has one concave corner, which gets no quoins
    const L: P[] = [[0, 0], [10, 0], [10, -4], [4, -4], [4, -10], [0, -10]];
    const perCorner = quoins([[0, 0], [1, 0], [1, -1], [0, -1]], 0, 3, m).children.length / 4;
    expect(quoins(L, 0, 3, m).children.length).toBe(perCorner * 5);
  });
});

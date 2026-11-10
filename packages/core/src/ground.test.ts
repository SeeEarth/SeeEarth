import { describe, expect, it } from "vitest";
import { resolveGround, validateChange, type BaseTile, type StoredChange } from "./index.js";

const base = { tile: "1-1", bbox: [-1.26, 51.75, -1.25, 51.76], buildings: [], roads: [], rails: [], areas: [] } as unknown as BaseTile;
const lawn = (extra: Record<string, unknown> = {}) => ({
  kind: "ground", target: "g:test-lawn", label: "test lawn", surface: "grass",
  area: [[-1.2560, 51.7550], [-1.2555, 51.7550], [-1.2555, 51.7553], [-1.2560, 51.7553]],
  sources: [{ url: "https://cloudless.eox.at", kind: "imagery" }], ...extra,
});

describe("ground changes", () => {
  it("validates a lawn in the tile", () => expect(validateChange(lawn(), base).ok).toBe(true));
  it("rejects a patch centred outside the tile", () => {
    const r = validateChange(lawn({ area: [[-1.2460, 51.7550], [-1.2455, 51.7550], [-1.2455, 51.7553], [-1.2460, 51.7553]] }), base);
    expect(r.ok).toBe(false);
  });
  it("rejects unknown surfaces and bad ids", () => {
    expect(validateChange(lawn({ surface: "lava" }), base).ok).toBe(false);
    expect(validateChange(lawn({ target: "w123" }), base).ok).toBe(false);
  });
  it("latest change per id wins; hidden removes it", () => {
    const sc = (id: number, ch: unknown) => ({ id, tile: "1-1", author: "a", createdAt: id, change: ch }) as StoredChange;
    expect(resolveGround([sc(1, lawn()), sc(2, lawn({ surface: "paving" }))]).map((g) => g.surface)).toEqual(["paving"]);
    expect(resolveGround([sc(1, lawn()), sc(2, lawn({ hidden: true }))])).toEqual([]);
  });
});

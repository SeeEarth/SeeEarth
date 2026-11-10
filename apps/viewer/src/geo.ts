import type { LL } from "@seeearth/core";

/** Local tangent-plane projection around a fixed origin (metres; east, north). */
export class Projector {
  readonly kx: number;
  readonly ky = 110574;
  constructor(readonly lon0: number, readonly lat0: number) {
    this.kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  }
  en(p: LL): [number, number] { return [(p[0] - this.lon0) * this.kx, (p[1] - this.lat0) * this.ky]; }
  /** three.js coords: x = east, z = -north */
  xz(p: LL): [number, number] { const [e, n] = this.en(p); return [e, -n]; }
  lonLat(x: number, z: number): LL { return [this.lon0 + x / this.kx, this.lat0 + -z / this.ky]; }
}

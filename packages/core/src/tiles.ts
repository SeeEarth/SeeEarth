// Work units are Web-Mercator ("slippy map") tiles at a fixed zoom.
// z16 tiles are ~610 m across at the equator (~550 m in Lahore, ~380 m in London).

export const WORK_ZOOM = 16;

export interface TileId { x: number; y: number }
/** [west, south, east, north] in degrees */
export type BBox = [number, number, number, number];

const N = 2 ** WORK_ZOOM;

export function tileKey(t: TileId): string { return `${t.x}-${t.y}`; }

export function parseTileKey(key: string): TileId {
  const m = /^(\d+)-(\d+)$/.exec(key);
  if (!m) throw new Error(`bad tile key: ${key}`);
  const t = { x: Number(m[1]), y: Number(m[2]) };
  if (!isValidTile(t)) throw new Error(`tile out of range: ${key}`);
  return t;
}

export function isValidTile(t: TileId): boolean {
  return Number.isInteger(t.x) && Number.isInteger(t.y) && t.x >= 0 && t.y >= 0 && t.x < N && t.y < N;
}

export function lonLatToTile(lon: number, lat: number): TileId {
  const latR = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * N);
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * N);
  return { x: Math.min(N - 1, Math.max(0, x)), y: Math.min(N - 1, Math.max(0, y)) };
}

function tileXToLon(x: number): number { return (x / N) * 360 - 180; }
function tileYToLat(y: number): number {
  const n = Math.PI - (2 * Math.PI * y) / N;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function tileBBox(t: TileId): BBox {
  return [tileXToLon(t.x), tileYToLat(t.y + 1), tileXToLon(t.x + 1), tileYToLat(t.y)];
}

export function tileCenter(t: TileId): [number, number] {
  const [w, s, e, n] = tileBBox(t);
  return [(w + e) / 2, (s + n) / 2];
}

/** Approximate tile area in km². */
export function tileAreaKm2(t: TileId): number {
  const [w, s, e, n] = tileBBox(t);
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const wKm = (e - w) * 111.32 * Math.cos(lat);
  const hKm = (n - s) * 110.574;
  return wKm * hKm;
}

/** Tiles on the square ring at Chebyshev distance r around c (r=0 → c itself). */
export function tileRing(c: TileId, r: number): TileId[] {
  if (r === 0) return [c];
  const out: TileId[] = [];
  for (let dx = -r; dx <= r; dx++) {
    out.push({ x: c.x + dx, y: c.y - r }, { x: c.x + dx, y: c.y + r });
  }
  for (let dy = -r + 1; dy <= r - 1; dy++) {
    out.push({ x: c.x - r, y: c.y + dy }, { x: c.x + r, y: c.y + dy });
  }
  return out.filter(isValidTile);
}

/** Number of tile rings needed to cover radiusKm around a latitude. */
export function ringsForRadius(lat: number, radiusKm: number): number {
  const tileKm = (40075 * Math.cos((lat * Math.PI) / 180)) / N;
  return Math.max(0, Math.ceil(radiusKm / Math.max(tileKm, 0.01)));
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function pointInBBox(lon: number, lat: number, b: BBox): boolean {
  return lon >= b[0] && lon < b[2] && lat >= b[1] && lat < b[3];
}

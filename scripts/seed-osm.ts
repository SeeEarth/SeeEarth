// Seed the OSM base layer for an area from a Geofabrik .osm.pbf extract instead of live Overpass.
// No rate limits, and it's how cities get pre-loaded before launch.
//
//   npx tsx scripts/seed-osm.ts --pbf oxfordshire.osm.pbf --lat 51.752 --lon -1.2577 --radius 10 \
//       [--api http://localhost:8787] [--admin-token dev-admin-token]
//
// --radius is in tiles (z16) around the centre. Download extracts from https://download.geofabrik.de
import { createReadStream } from "node:fs";
import osmPbfParser from "osm-pbf-parser";
import { lonLatToTile, parseOverpass, tileBBox, type BaseTile } from "../packages/core/src/index.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const pbf = arg("pbf") ?? (console.error("--pbf <file> required"), process.exit(1));
const lat = Number(arg("lat")), lon = Number(arg("lon")), R = Number(arg("radius", "8"));
const api = (arg("api", process.env.SEEEARTH_API ?? "http://localhost:8787") as string).replace(/\/$/, "");
const token = arg("admin-token", process.env.ADMIN_TOKEN ?? "dev-admin-token");

const c = lonLatToTile(lon, lat);
const x0 = c.x - R, x1 = c.x + R, y0 = c.y - R, y1 = c.y + R;
const nw = tileBBox({ x: x0, y: y0 }), se = tileBBox({ x: x1, y: y1 });
const pad = 0.01; // keep features that reach into the area from just outside
const W = nw[0] - pad, S = se[1] - pad, E = se[2] + pad, N = nw[3] + pad;

// Same selection as the Overpass query in packages/core/src/osm.ts.
const wanted = (t: Record<string, string>) =>
  !!(t.building || t["building:part"] || t.highway || t["area:highway"] ||
    /^(rail|light_rail|subway|tram)$/.test(t.railway ?? "") ||
    /^(water|wood|scrub|grassland|beach|sand|wetland|tree_row)$/.test(t.natural ?? "") || t.waterway === "riverbank" ||
    /^(grass|forest|meadow|recreation_ground|cemetery|village_green|farmland|orchard)$/.test(t.landuse ?? "") ||
    /^(park|garden|pitch|golf_course|playground)$/.test(t.leisure ?? "") || t.amenity === "parking");

type LL = { lat: number; lon: number };
const nodes = new Map<number, LL>();
const ways = new Map<number, { tags?: Record<string, string>; refs: number[] }>();
const elements: unknown[] = [];
const geom = (refs: number[]) => refs.map((r) => nodes.get(r) ?? null);

console.error(`reading ${pbf} for tiles ${x0}..${x1} × ${y0}..${y1} (${(2 * R + 1) ** 2} tiles)…`);
const parser = osmPbfParser();
const handle = (items: any[]) => {
  for (const it of items) {
    if (it.type === "node") {
      if (it.lat >= S && it.lat <= N && it.lon >= W && it.lon <= E) {
        nodes.set(it.id, { lat: it.lat, lon: it.lon });
        if (it.tags?.natural === "tree") elements.push({ type: "node", id: it.id, lat: it.lat, lon: it.lon, tags: { natural: "tree" } });
      }
    } else if (it.type === "way") {
      if (!it.refs.some((r: number) => nodes.has(r))) continue;
      ways.set(it.id, { tags: it.tags, refs: it.refs }); // untagged ways are kept for multipolygon members
      if (wanted(it.tags ?? {})) elements.push({ type: "way", id: it.id, tags: it.tags, geometry: geom(it.refs) });
    } else if (it.type === "relation") {
      const t = it.tags ?? {};
      if (t.type !== "multipolygon" || !(t.building || /^(water|wood)$/.test(t.natural ?? "") || t.leisure === "park")) continue;
      // osm-pbf-parser names a member's way id `id` (Overpass calls it `ref`)
      const members = it.members.map((m: any) => ({ ...m, ref: m.ref ?? m.id }))
        .filter((m: any) => m.type === "way" && ways.has(m.ref))
        .map((m: any) => ({ type: "way", ref: m.ref, role: m.role, geometry: geom(ways.get(m.ref)!.refs) }));
      if (members.length) elements.push({ type: "relation", id: it.id, tags: t, members });
    }
  }
};
await new Promise<void>((resolve, reject) => {
  parser.on("data", handle).on("end", resolve).on("error", reject);
  createReadStream(pbf).on("error", reject).pipe(parser);
});
console.error(`${nodes.size} nodes, ${elements.length} features in the area; cutting tiles…`);

const tiles: BaseTile[] = [];
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push(parseOverpass({ elements } as any, { x, y }));

for (let i = 0; i < tiles.length; i += 20) {
  const batch = tiles.slice(i, i + 20);
  const res = await fetch(`${api}/api/admin/base`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ tiles: batch }),
  });
  if (!res.ok) { console.error(`upload failed: ${res.status} ${await res.text()}`); process.exit(1); }
  process.stderr.write(`\ruploaded ${Math.min(i + 20, tiles.length)}/${tiles.length}`);
}
console.error(`\n✓ seeded ${tiles.length} tiles (${tiles.reduce((s, t) => s + t.buildings.length, 0)} buildings)`);

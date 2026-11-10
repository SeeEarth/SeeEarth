// Dev helper: npx tsx tests/fetch-fixture.ts <lon> <lat> → tests/fixtures/overpass-<tile>.json
import { writeFileSync } from "node:fs";
import { lonLatToTile, overpassQuery, tileBBox, tileKey, OVERPASS_URL } from "../packages/core/src/index.js";
const [lon, lat] = process.argv.slice(2).map(Number);
const t = lonLatToTile(lon, lat);
const res = await fetch(OVERPASS_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "seeearth-dev/0.1" }, body: "data=" + encodeURIComponent(overpassQuery(tileBBox(t))) });
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const json: any = await res.json();
writeFileSync(`tests/fixtures/overpass-${tileKey(t)}.json`, JSON.stringify(json));
console.log(tileKey(t), json.elements.length, "elements");

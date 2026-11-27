// Downloads raw OpenStreetMap data for the map (Brookfield + Waukesha, WI) from the Overpass API.
// Saves responses to data-raw/ so build-map.mjs can run offline.
// The bbox is fetched as a grid of tiles (one Overpass request each, cached in data-raw/osm-tiles/) and merged by
// element id, so the area can grow without hitting Overpass timeouts.
//
// Usage: node scripts/fetch-osm.mjs [--force] [--only=roads,pois]
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX } from './bbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data-raw');

// Tile grid: each tile is about the size of the old Brookfield-only bbox (~10 x 9 km), which fit in one request.
const NX = 2, NY = 2;
const TILES = [];
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const lat = (k) => BBOX.south + ((BBOX.north - BBOX.south) * k) / NY, lon = (k) => BBOX.west + ((BBOX.east - BBOX.west) * k) / NX;
  TILES.push(`${lat(j).toFixed(5)},${lon(i).toFixed(5)},${lat(j + 1).toFixed(5)},${lon(i + 1).toFixed(5)}`);
}
const WHOLE = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
// small queries that are fetched in one piece
const UNTILED = new Set(['boundaries']);

const ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road';

const QUERIES = (B) => ({
  // Roads + rail with node ids so shared nodes give us intersections.
  roads: `[out:json][timeout:180][bbox:${B}];
(
  way["highway"~"^(${DRIVABLE})$"];
  way["railway"="rail"];
);
out body;
>;
out body qt;`,

  buildings: `[out:json][timeout:180][bbox:${B}];
way["building"];
out tags geom;`,

  // Named businesses/places (for storefront signs), street lamps, sidewalks.
  pois: `[out:json][timeout:180][bbox:${B}];
(
  nwr["name"]["shop"];
  nwr["name"]["amenity"];
  nwr["name"]["office"];
  nwr["name"]["leisure"~"^(fitness_centre|sports_centre|bowling_alley|ice_rink)$"];
  nwr["name"]["tourism"~"^(hotel|motel)$"];
  nwr["name"]["healthcare"];
);
out center tags;`,

  lamps: `[out:json][timeout:120][bbox:${B}];
node["highway"="street_lamp"];
out;`,

  footways: `[out:json][timeout:180][bbox:${B}];
way["highway"="footway"]["footway"="sidewalk"];
out tags geom;`,

  // No global [bbox] here: it would clip relation member geometry and break ring stitching.
  areas: `[out:json][timeout:180];
(
  way["natural"="water"](${B});
  relation["natural"="water"](${B});
  way["leisure"~"^(park|golf_course|pitch|playground|nature_reserve)$"](${B});
  relation["leisure"~"^(park|golf_course|nature_reserve)$"](${B});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|farmland)$"](${B});
  relation["landuse"~"^(forest|meadow|cemetery)$"](${B});
  way["natural"~"^(wood|wetland)$"](${B});
  relation["natural"~"^(wood|wetland)$"](${B});
  way["amenity"="parking"](${B});
);
out geom;`,

  boundaries: `[out:json][timeout:180];
relation["boundary"="administrative"]["admin_level"="8"](${B});
out geom;`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchQuery(name, query) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of ENDPOINTS) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'User-Agent': 'osm-driving-game/0.1',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(200_000),
        });
        const text = await res.text();
        if (!res.ok || !text.trimStart().startsWith('{')) {
          console.log(`  ${name}: ${url} -> HTTP ${res.status}`);
          continue;
        }
        const json = JSON.parse(text);
        if (json.remark && /runtime error|timed out/i.test(json.remark)) {
          console.log(`  ${name}: ${url} -> ${json.remark.slice(0, 120)}`);
          continue;
        }
        console.log(`  ${name}: ${url} -> ${json.elements.length} elements in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return text;
      } catch (err) {
        console.log(`  ${name}: ${url} -> ${err.name}: ${err.message}`);
      }
    }
    const wait = 10_000 * (attempt + 1);
    console.log(`  ${name}: all endpoints failed, retrying in ${wait / 1000}s...`);
    await sleep(wait);
  }
  throw new Error(`Could not fetch "${name}" from any Overpass endpoint`);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const force = process.argv.includes('--force');
// --only=roads,pois refetches just those queries (ignores the cache for them)
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const TILE_DIR = join(RAW, 'osm-tiles');
await mkdir(TILE_DIR, { recursive: true });
const tag = (b) => b.replace(/[^0-9.,-]/g, '').replace(/,/g, '_');
for (const name of Object.keys(QUERIES(WHOLE))) {
  const out = join(RAW, `${name}.json`);
  if (only && !only.includes(name)) continue;
  const refetch = force || !!only;
  const boxes = UNTILED.has(name) ? [WHOLE] : TILES;
  // the merged file is current if it was built from exactly these tiles
  if (!refetch && (await exists(out))) {
    try {
      const prev = JSON.parse(await readFile(out, 'utf8'));
      if (JSON.stringify(prev.tiles) === JSON.stringify(boxes)) { console.log(`${name}: cached (use --force to refetch)`); continue; }
    } catch {}
  }
  const seen = new Set();
  const elements = [];
  let header = null;
  for (const [k, box] of boxes.entries()) {
    const tileFile = join(TILE_DIR, `${name}-${tag(box)}.json`);
    let text;
    if (!refetch && (await exists(tileFile))) {
      text = await readFile(tileFile, 'utf8');
      console.log(`${name} [${k + 1}/${boxes.length}]: cached tile`);
    } else {
      console.log(`${name} [${k + 1}/${boxes.length}]: fetching ${box}...`);
      text = await fetchQuery(`${name}[${k + 1}]`, QUERIES(box)[name]);
      await writeFile(tileFile, text);
    }
    const json = JSON.parse(text);
    header ??= { version: json.version, generator: json.generator, osm3s: json.osm3s };
    // a way/relation crossing a tile edge (and every node it shares) comes back in more than one tile
    for (const e of json.elements) {
      const id = `${e.type}/${e.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      elements.push(e);
    }
  }
  await writeFile(out, JSON.stringify({ ...header, tiles: boxes, elements }));
  console.log(`${name}: ${elements.length} elements from ${boxes.length} tile(s)`);
}
console.log('Done. Now run: npm run build-map');

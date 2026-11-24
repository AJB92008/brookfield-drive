// Downloads raw OpenStreetMap data for Brookfield, WI from the Overpass API.
// Saves responses to data-raw/ so build-map.mjs can run offline.
//
// Usage: node scripts/fetch-osm.mjs [--force]
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX } from './bbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data-raw');

const B = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

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

const QUERIES = {
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
};

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
await mkdir(RAW, { recursive: true });
for (const [name, query] of Object.entries(QUERIES)) {
  const out = join(RAW, `${name}.json`);
  if (only && !only.includes(name)) continue;
  if (!force && !only && (await exists(out))) {
    console.log(`${name}: cached (use --force to refetch)`);
    continue;
  }
  console.log(`${name}: fetching...`);
  const text = await fetchQuery(name, query);
  await writeFile(out, text);
}
console.log('Done. Now run: npm run build-map');

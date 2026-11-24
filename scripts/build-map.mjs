// Converts raw Overpass JSON (data-raw/) into a compact game map (public/data/brookfield.json).
// Runs fully offline. Coordinates are projected to local meters:
//   x = east, z = south (so north is -z), origin = bbox center.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, LAT0, LON0, M_PER_DEG_LAT, M_PER_DEG_LON, toX, toZ } from './geo.mjs';
import { analyzeAerial } from './aerial-analysis.mjs';
import { computeFurniture } from './street-furniture.mjs';
import { buildTerrain } from './terrain-build.mjs';
import { access } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data-raw');
const OUT = join(ROOT, 'public', 'data', 'brookfield.json');

const readRaw = async (n) => JSON.parse(await readFile(join(RAW, `${n}.json`), 'utf8'));

// ---------- projection (shared with fetch-aerial.mjs) ----------
const r1 = (v) => Math.round(v * 10) / 10;
const projX = (lon) => r1(toX(lon));
const projZ = (lat) => r1(toZ(lat));

// ---------- helpers ----------
function hash(n) {
  // deterministic 0..1 from an integer id
  let x = Number(BigInt.asUintN(32, BigInt(n))) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function parseLength(v) {
  if (!v) return NaN;
  const s = String(v).trim().toLowerCase();
  const ft = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|')/);
  if (ft) return parseFloat(ft[1]) * 0.3048;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseMaxspeed(v) {
  if (!v) return 0;
  const m = String(v).match(/(\d+)\s*(mph)?/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return m[2] ? n : Math.round(n / 1.609); // store in mph
}

// Flat [x,z,...] ring without the closing duplicate; drops consecutive duplicates.
function ringFromLatLon(geom) {
  const out = [];
  for (const p of geom) {
    if (!p) continue;
    const x = projX(p.lon), z = projZ(p.lat);
    const n = out.length;
    if (n >= 2 && out[n - 2] === x && out[n - 1] === z) continue;
    out.push(x, z);
  }
  if (out.length >= 4 && out[0] === out.at(-2) && out[1] === out.at(-1)) out.length -= 2;
  return out;
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
  }
  return a / 2;
}

// Join relation member ways into closed rings.
function stitchRings(members) {
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const pool = members.map((m) => m.geometry.filter(Boolean)).filter((g) => g.length >= 2);
  const rings = [];
  while (pool.length) {
    let ring = pool.pop().slice();
    let guard = 0;
    while (key(ring[0]) !== key(ring.at(-1)) && guard++ < 10000) {
      const end = key(ring.at(-1));
      let idx = pool.findIndex((g) => key(g[0]) === end || key(g.at(-1)) === end);
      if (idx < 0) break;
      const g = pool.splice(idx, 1)[0];
      ring = ring.concat(key(g[0]) === end ? g.slice(1) : g.slice().reverse().slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// ---------- roads ----------
const ROAD_CLASS = {
  motorway: { lanes: 2, laneW: 3.7, shoulder: 2.5, mph: 65 },
  trunk: { lanes: 4, laneW: 3.6, shoulder: 1.5, mph: 50 },
  primary: { lanes: 4, laneW: 3.5, shoulder: 1.0, mph: 40 },
  secondary: { lanes: 2, laneW: 3.5, shoulder: 1.0, mph: 35 },
  tertiary: { lanes: 2, laneW: 3.4, shoulder: 0.8, mph: 30 },
  unclassified: { lanes: 2, laneW: 3.3, shoulder: 0.5, mph: 25 },
  residential: { lanes: 2, laneW: 3.3, shoulder: 0.5, mph: 25 },
  living_street: { lanes: 2, laneW: 3.0, shoulder: 0, mph: 15 },
  road: { lanes: 2, laneW: 3.3, shoulder: 0.5, mph: 25 },
  motorway_link: { lanes: 1, laneW: 3.7, shoulder: 1.5, mph: 40 },
  trunk_link: { lanes: 1, laneW: 3.6, shoulder: 1.2, mph: 35 },
  primary_link: { lanes: 1, laneW: 3.5, shoulder: 1.0, mph: 25 },
  secondary_link: { lanes: 1, laneW: 3.5, shoulder: 1.0, mph: 25 },
  tertiary_link: { lanes: 1, laneW: 3.4, shoulder: 0.8, mph: 25 },
  service: { lanes: 1, laneW: 4.5, shoulder: 0, mph: 15 },
};

function onewayOf(t) {
  const o = (t.oneway || '').toLowerCase();
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === 'no' || o === 'false' || o === '0') return 0;
  if (t.highway === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular') return 1;
  return 0;
}

function roadShape(t, oneway) {
  const cls = ROAD_CLASS[t.highway];
  let lanes = parseInt(t.lanes, 10);
  if (!Number.isFinite(lanes) || lanes < 1 || lanes > 8) {
    lanes = cls.lanes;
    if (oneway && lanes > 1 && !t.highway.endsWith('_link') && t.highway !== 'motorway') lanes = Math.max(1, Math.round(lanes / 2));
  }
  let w;
  if (t.highway === 'service') {
    w = t.service === 'driveway' ? 3.6 : t.service === 'parking_aisle' ? 6 : t.service === 'drive-through' ? 3.8 : 5;
    lanes = t.service === 'parking_aisle' ? 2 : 1;
  } else {
    w = lanes * cls.laneW + 2 * cls.shoulder;
  }
  const tagged = parseLength(t.width);
  if (tagged >= 3 && tagged <= 30) w = tagged;
  return { lanes, w: r1(w) };
}

// ---------- buildings ----------
function buildingInfo(el, area) {
  const t = el.tags;
  const b = t.building;
  const rnd = hash(el.id);
  let cat;
  if (/^(house|detached|semidetached_house|residential|bungalow|farm)$/.test(b)) cat = 'h';
  else if (/^(garage|garages|shed|carport|roof|hut)$/.test(b)) cat = 'g';
  else if (/^(apartments|dormitory|hotel|terrace)$/.test(b)) cat = 'a';
  else if (/^(commercial|retail|office|restaurant|supermarket)$/.test(b)) cat = 'c';
  else if (/^(industrial|warehouse|hangar|manufacture)$/.test(b)) cat = 'i';
  else if (/^(school|church|public|government|civic|hospital|kindergarten|university|ice_rink|grandstand)$/.test(b)) cat = 'p';
  else if (area < 45) cat = 'g';
  else if (area < 400) cat = 'h';
  else cat = area > 2500 ? 'i' : 'c';

  let h = parseLength(t.height);
  if (!(h > 1.5 && h < 150)) {
    const levels = parseFloat(t['building:levels']);
    if (levels > 0 && levels < 40) h = levels * 3.2 + 1;
    else {
      const base = { h: 6.2, g: 3.0, a: 11, c: 7.5, i: 9, p: 10 }[cat];
      const span = { h: 2.4, g: 0.8, a: 4, c: 3, i: 3, p: 4 }[cat];
      h = base + (rnd - 0.5) * span;
      if (cat !== 'g' && cat !== 'h') h += Math.min(8, Math.sqrt(area) / 25); // big footprints run taller
    }
  }
  return { cat, h: r1(h), rnd };
}

// ---------- main ----------
const [roadsRaw, buildingsRaw, areasRaw, boundsRaw] = await Promise.all(
  ['roads', 'buildings', 'areas', 'boundaries'].map(readRaw),
);
const readOptional = async (n) => { try { return await readRaw(n); } catch { return { elements: [] }; } };
const [poisRaw, lampsRaw, footwaysRaw] = await Promise.all(['pois', 'lamps', 'footways'].map(readOptional));

// Nodes
const osmNode = new Map();
for (const e of roadsRaw.elements) if (e.type === 'node') osmNode.set(e.id, e);

const nodeIndex = new Map(); // osm id -> output index
const nodes = []; // flat [x,z,...]
function useNode(id) {
  let i = nodeIndex.get(id);
  if (i !== undefined) return i;
  const n = osmNode.get(id);
  if (!n) return -1;
  i = nodes.length / 2;
  nodes.push(projX(n.lon), projZ(n.lat));
  nodeIndex.set(id, i);
  return i;
}

const roads = [];
const rails = [];
const stats = { roadsByType: {} };
for (const e of roadsRaw.elements) {
  if (e.type !== 'way') continue;
  const t = e.tags || {};
  if (t.railway === 'rail' && !t.highway) {
    const nd = e.nodes.map(useNode).filter((i) => i >= 0);
    if (nd.length >= 2) rails.push(nd);
    continue;
  }
  if (!ROAD_CLASS[t.highway] || t.area === 'yes') continue;
  const ow = onewayOf(t);
  let ids = e.nodes.slice();
  if (ow === -1) ids.reverse();
  const nd = [];
  for (const id of ids) {
    const i = useNode(id);
    if (i < 0) continue;
    if (nd.length && nd.at(-1) === i) continue;
    // also skip same-position duplicates with different ids
    if (nd.length) {
      const p = nd.at(-1);
      if (nodes[p * 2] === nodes[i * 2] && nodes[p * 2 + 1] === nodes[i * 2 + 1]) continue;
    }
    nd.push(i);
  }
  if (nd.length < 2) continue;
  const { lanes, w } = roadShape(t, ow !== 0);
  const road = { t: t.highway, w, l: lanes, o: ow !== 0 ? 1 : 0, nd };
  if (t.name) road.n = t.name;
  if (t.ref) road.r = t.ref.replace(/^I (\d+)/, 'I-$1');
  const mph = parseMaxspeed(t.maxspeed);
  if (mph) road.s = mph;
  if (t.service) road.sv = t.service;
  if (t.bridge && t.bridge !== 'no') road.b = 1;
  roads.push(road);
  stats.roadsByType[t.highway] = (stats.roadsByType[t.highway] || 0) + 1;
}

// Buildings
const buildings = [];
let skippedBuildings = 0;
for (const e of buildingsRaw.elements) {
  if (e.type !== 'way' || !e.geometry) { skippedBuildings++; continue; }
  const ring = ringFromLatLon(e.geometry);
  if (ring.length < 6) { skippedBuildings++; continue; }
  const area = Math.abs(ringArea(ring));
  if (area < 4) { skippedBuildings++; continue; }
  const { cat, h } = buildingInfo(e, area);
  buildings.push({ k: cat, h, p: ring });
}

// Areas (ground cover)
function areaKind(t) {
  if (t.natural === 'water') return 'water';
  if (t.natural === 'wetland') return 'wetland';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'forest';
  if (t.amenity === 'parking') return 'parking';
  if (t.landuse === 'farmland') return 'farm';
  if (t.leisure === 'golf_course') return 'golf';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.leisure === 'nature_reserve') return 'reserve';
  return 'park'; // park, grass, meadow, cemetery, playground, recreation_ground
}
const AREA_ORDER = { farm: 0, reserve: 1, park: 2, golf: 2, forest: 3, wetland: 3, pitch: 4, water: 5, parking: 6 };
const areas = [];
for (const e of areasRaw.elements) {
  const t = e.tags || {};
  const k = areaKind(t);
  if (e.type === 'way') {
    if (!e.geometry) continue;
    const ring = ringFromLatLon(e.geometry);
    if (ring.length >= 6) areas.push({ k, p: ring });
  } else if (e.type === 'relation' && e.members) {
    const outers = stitchRings(e.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry));
    const inners = stitchRings(e.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry));
    const holes = inners.map(ringFromLatLon).filter((r) => r.length >= 6);
    for (const o of outers) {
      const ring = ringFromLatLon(o);
      if (ring.length < 6) continue;
      const a = { k, p: ring };
      if (holes.length) a.holes = holes; // client assigns holes to the outer that contains them
      areas.push(a);
    }
  }
}
areas.sort((a, b) => AREA_ORDER[a.k] - AREA_ORDER[b.k]);

// Municipal boundaries (for the "you are in ..." HUD)
const places = [];
for (const e of boundsRaw.elements) {
  if (!e.members) continue;
  const rings = stitchRings(e.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry))
    .map(ringFromLatLon)
    .filter((r) => r.length >= 6);
  const holes = stitchRings(e.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry))
    .map(ringFromLatLon)
    .filter((r) => r.length >= 6);
  let name = e.tags.name;
  if (e.tags.border_type === 'town' && !/^Town of/.test(name)) name = `Town of ${name}`;
  if (rings.length) places.push({ n: name, city: e.id === 251870 ? 1 : 0, rings, holes });
}

// Spawn: on West Bluemound Rd near the Moorland Rd intersection (Brookfield Square).
function findSpawn() {
  const byNode = new Map();
  roads.forEach((r, ri) => r.nd.forEach((n) => {
    if (!byNode.has(n)) byNode.set(n, []);
    byNode.get(n).push(ri);
  }));
  for (const [n, rs] of byNode) {
    if (!rs.some((ri) => /Moorland/i.test(roads[ri].n || ''))) continue;
    for (const blue of rs) {
      const road = roads[blue];
      if (!/Bluemound/i.test(road.n || '')) continue;
      const k = road.nd.indexOf(n);
      if (k <= 0) continue;
      // Back up along the road (against travel direction) ~60 m so we drive toward the intersection.
      let dist = 0, i = k;
      while (i > 0 && dist < 60) {
        const a = road.nd[i], b = road.nd[i - 1];
        dist += Math.hypot(nodes[a * 2] - nodes[b * 2], nodes[a * 2 + 1] - nodes[b * 2 + 1]);
        i--;
      }
      const a = road.nd[i], b = road.nd[i + 1];
      const ax = nodes[a * 2], az = nodes[a * 2 + 1], bx = nodes[b * 2], bz = nodes[b * 2 + 1];
      const heading = Math.round(Math.atan2(bx - ax, bz - az) * 1000) / 1000;
      return { x: ax, z: az, heading, road: blue, note: 'Bluemound @ Moorland' };
    }
  }
  // Fallback: the primary/secondary road node nearest the origin
  let best = null;
  roads.forEach((r, ri) => {
    if (!/^(primary|secondary)$/.test(r.t)) return;
    for (let j = 0; j < r.nd.length - 1; j++) {
      const a = r.nd[j], b = r.nd[j + 1];
      const d = Math.hypot(nodes[a * 2], nodes[a * 2 + 1]);
      if (!best || d < best.d) best = { d: r1(d), x: nodes[a * 2], z: nodes[a * 2 + 1], heading: Math.atan2(nodes[b * 2] - nodes[a * 2], nodes[b * 2 + 1] - nodes[a * 2 + 1]), road: ri, note: 'fallback' };
    }
  });
  return best;
}
const spawn = findSpawn();

// Street furniture (signals, stop signs, crosswalks, streetlights, street-name signs, sidewalks)
const nodeTags = new Map();
for (const [id, idx] of nodeIndex) {
  const t = osmNode.get(id)?.tags;
  if (t && (t.highway || t.crossing)) nodeTags.set(idx, t);
}
const lamps = lampsRaw.elements.filter((e) => e.type === 'node').map((e) => ({ x: projX(e.lon), z: projZ(e.lat) }));
const sidewalks = footwaysRaw.elements.filter((e) => e.geometry).map((e) => ringFromLatLon(e.geometry)).filter((p) => p.length >= 4);
const furniture = computeFurniture({ nodes, roads, nodeTags, lamps, sidewalks });

// Named businesses / places for storefront signs
const POI_KEYS = ['shop', 'amenity', 'office', 'leisure', 'tourism', 'healthcare'];
const pois = [];
for (const e of poisRaw.elements) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  if (!t.name || lat === undefined) continue;
  if (/^(parking|bench|waste_basket|bicycle_parking|toilets|post_box|atm|vending_machine|fire_hydrant|shelter|parking_entrance|charging_station|drinking_water)$/.test(t.amenity || '')) continue;
  const key = POI_KEYS.find((k) => t[k]);
  pois.push({ n: t.name, k: `${key}:${t[key]}`, x: projX(lon), z: projZ(lat), w: e.type === 'node' ? 0 : 1 });
}

// Aerial photo analysis (roof colors + real tree positions), if the NAIP tiles have been fetched.
let trees = null;
try {
  await access(join(ROOT, 'public', 'aerial', 'manifest.json'));
  const debugTile = process.argv.find((a) => a.startsWith('--debug-tile='))?.split('=')[1] ?? null;
  console.log('Analyzing aerial imagery…');
  ({ trees } = await analyzeAerial({ root: ROOT, map: { nodes, roads, buildings }, debugTile }));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.log('No aerial imagery (run npm run fetch-aerial) - skipping roof colors / canopy trees');
}

// Real elevation (USGS 3DEP) + bridge deck heights, if the terrain has been fetched.
let terrain = null;
try {
  await access(join(ROOT, 'data-raw', 'terrain.tif'));
  terrain = await buildTerrain({ root: ROOT, roads, nodes, spawn });
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.log('No terrain (run npm run fetch-terrain) - world stays flat');
}

const halfW = (M_PER_DEG_LON * (BBOX.east - BBOX.west)) / 2;
const halfH = (M_PER_DEG_LAT * (BBOX.north - BBOX.south)) / 2;
const map = {
  attribution: '© OpenStreetMap contributors (ODbL)',
  generated: new Date().toISOString(),
  origin: { lat: LAT0, lon: LON0 },
  bounds: { minX: r1(-halfW), maxX: r1(halfW), minZ: r1(-halfH), maxZ: r1(halfH) },
  spawn,
  nodes,
  roads,
  rails,
  buildings,
  areas,
  places,
};
if (trees) map.trees = trees;
map.furniture = furniture;
if (terrain) map.terrain = terrain;
map.pois = pois;

await mkdir(dirname(OUT), { recursive: true });
const json = JSON.stringify(map);
await writeFile(OUT, json);

console.log('Map built ->', OUT);
console.log(`  size: ${(json.length / 1e6).toFixed(2)} MB, extent ${(halfW * 2 / 1000).toFixed(1)} x ${(halfH * 2 / 1000).toFixed(1)} km`);
console.log(`  nodes: ${nodes.length / 2}, roads: ${roads.length}, rails: ${rails.length}`);
console.log('  roads by type:', stats.roadsByType);
console.log(`  buildings: ${buildings.length} (skipped ${skippedBuildings})`);
console.log(`  areas: ${areas.length}, places: ${places.map((p) => `${p.n}(${p.rings.length})`).join(', ')}`);
console.log('  spawn:', spawn);
console.log(`  furniture: ${furniture.signals.length} signalized intersections (${furniture.signals.reduce((a, s) => a + s.p.length, 0)} poles), ${furniture.stops.length / 4} stop signs, ${furniture.crosswalks.length / 5} crosswalks, ${furniture.lights.length / 4} streetlights, ${furniture.streetSigns.length / 6} street-name signs (${furniture.streetNames.length} names), ${furniture.sidewalks.length} sidewalks`);
console.log(`  pois: ${pois.length} named places`);

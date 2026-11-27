// Downloads bare-earth elevation (USGS 3D Elevation Program, lidar-derived, public domain) covering the
// map plus a margin, as float32 GeoTIFF tiles: data-raw/terrain-{i}-{j}.tif + data-raw/terrain.json (tile extents).
// The server times out on one big export, so the area is split into a grid of overlapping tiles, each about the
// size of the old single Brookfield request (~2900 px); terrain-build.mjs samples across them.
// Usage: node scripts/fetch-terrain.mjs [--force]
import { writeFile, readFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLon, toLat, EXTENT, M_PER_DEG_LAT, M_PER_DEG_LON } from './geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data-raw');
const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const MARGIN = 700; // m beyond the map bbox
const PX_M = 4; // ~4 m east-west pixels (the server keeps pixels square in degrees)
const MAX_TILE_M = 11000; // tile side in meters (~2750 px)
const OVERLAP = 150; // m each tile reaches past its cell, so samples near a seam come from inside a tile

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const minX = EXTENT.minX - MARGIN, maxX = EXTENT.maxX + MARGIN, minZ = EXTENT.minZ - MARGIN, maxZ = EXTENT.maxZ + MARGIN;
const NX = Math.ceil((maxX - minX) / MAX_TILE_M), NZ = Math.ceil((maxZ - minZ) / MAX_TILE_M);
const cells = [];
for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
  const x0 = minX + ((maxX - minX) * i) / NX - (i > 0 ? OVERLAP : 0), x1 = minX + ((maxX - minX) * (i + 1)) / NX + (i < NX - 1 ? OVERLAP : 0);
  const z0 = minZ + ((maxZ - minZ) * j) / NZ - (j > 0 ? OVERLAP : 0), z1 = minZ + ((maxZ - minZ) * (j + 1)) / NZ + (j < NZ - 1 ? OVERLAP : 0);
  cells.push({ file: `terrain-${i}-${j}.tif`, west: toLon(x0), east: toLon(x1), north: toLat(z0), south: toLat(z1), wM: x1 - x0 });
}
const key = cells.map((c) => [c.west, c.south, c.east, c.north].map((v) => v.toFixed(6)).join(',')).join(';');
const force = process.argv.includes('--force');
if (!force && (await exists(join(RAW, 'terrain.json')))) {
  const prev = JSON.parse(await readFile(join(RAW, 'terrain.json'), 'utf8'));
  if (prev.key === key && (await Promise.all(prev.tiles.map((t) => exists(join(RAW, t.file))))).every(Boolean)) {
    console.log('terrain: cached (use --force to refetch)');
    process.exit(0);
  }
}
await mkdir(RAW, { recursive: true });

async function fetchTile(c) {
  const PX_W = Math.round(c.wM / PX_M);
  const PX_H = Math.round(PX_W / ((c.east - c.west) / (c.north - c.south)));
  const bbox = [c.west, c.south, c.east, c.north].map((v) => v.toFixed(7)).join(',');
  const url = `${SERVICE}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${PX_W},${PX_H}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=json`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`terrain ${c.file}: requesting ${PX_W}x${PX_H} (~${(((c.east - c.west) * M_PER_DEG_LON) / PX_W).toFixed(1)} x ${(((c.north - c.south) * M_PER_DEG_LAT) / PX_H).toFixed(1)} m pixels)…`);
      const res = await fetch(url, { headers: { 'User-Agent': 'osm-driving-game/0.1' }, signal: AbortSignal.timeout(180000) });
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}, not JSON`);
      const meta = JSON.parse(text);
      if (!meta.href) throw new Error(JSON.stringify(meta).slice(0, 200));
      const buf = Buffer.from(await (await fetch(meta.href, { headers: { 'User-Agent': 'osm-driving-game/0.1' }, signal: AbortSignal.timeout(300000) })).arrayBuffer());
      if (buf.length < 1e6) throw new Error(`suspiciously small TIFF (${buf.length} bytes)`);
      await writeFile(join(RAW, c.file), buf);
      console.log(`terrain ${c.file}: saved ${(buf.length / 1e6).toFixed(1)} MB`);
      return { file: c.file, extent: meta.extent, width: meta.width, height: meta.height };
    } catch (err) {
      console.log(`  attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw new Error(`could not fetch terrain tile ${c.file}`);
}

const tiles = [];
for (const c of cells) tiles.push(await fetchTile(c));
await writeFile(join(RAW, 'terrain.json'), JSON.stringify({ source: 'USGS 3DEP (public domain)', key, tiles }));
console.log(`terrain: ${tiles.length} tiles saved`);

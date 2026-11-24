// Downloads bare-earth elevation (USGS 3D Elevation Program, lidar-derived, public domain) covering the
// map plus a margin, as a float32 GeoTIFF: data-raw/terrain.tif + data-raw/terrain.json (extent).
// Usage: node scripts/fetch-terrain.mjs [--force]
import { writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLon, toLat, HALF_W, HALF_H, M_PER_DEG_LAT, M_PER_DEG_LON } from './geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data-raw');
const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const MARGIN = 700; // m beyond the map bbox
const PX_W = 2900; // ~4 m east-west; the server keeps pixels square in degrees

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
if (!process.argv.includes('--force') && (await exists(join(RAW, 'terrain.tif')))) {
  console.log('terrain: cached (use --force to refetch)');
  process.exit(0);
}
await mkdir(RAW, { recursive: true });
const west = toLon(-HALF_W - MARGIN), east = toLon(HALF_W + MARGIN);
const north = toLat(-HALF_H - MARGIN), south = toLat(HALF_H + MARGIN);
const aspect = (east - west) / (north - south);
const PX_H = Math.round(PX_W / aspect);
const bbox = [west, south, east, north].map((v) => v.toFixed(7)).join(',');
const url = `${SERVICE}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${PX_W},${PX_H}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=json`;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    console.log(`terrain: requesting ${PX_W}x${PX_H} (~${(((east - west) * M_PER_DEG_LON) / PX_W).toFixed(1)} x ${(((north - south) * M_PER_DEG_LAT) / PX_H).toFixed(1)} m pixels)…`);
    const meta = await (await fetch(url, { headers: { 'User-Agent': 'osm-driving-game/0.1' }, signal: AbortSignal.timeout(180000) })).json();
    if (!meta.href) throw new Error(JSON.stringify(meta).slice(0, 200));
    const buf = Buffer.from(await (await fetch(meta.href, { headers: { 'User-Agent': 'osm-driving-game/0.1' }, signal: AbortSignal.timeout(300000) })).arrayBuffer());
    if (buf.length < 1e6) throw new Error(`suspiciously small TIFF (${buf.length} bytes)`);
    await writeFile(join(RAW, 'terrain.tif'), buf);
    await writeFile(join(RAW, 'terrain.json'), JSON.stringify({ source: 'USGS 3DEP (public domain)', extent: meta.extent, width: meta.width, height: meta.height }));
    console.log(`terrain: saved ${(buf.length / 1e6).toFixed(1)} MB`);
    process.exit(0);
  } catch (err) {
    console.log(`  attempt ${attempt} failed: ${err.message}`);
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
}
throw new Error('could not fetch terrain');

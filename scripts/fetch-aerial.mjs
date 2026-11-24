// Downloads public-domain USDA NAIP aerial imagery (via the USGS National Map) for the map extent.
//   public/aerial/t_{i}_{j}.jpg   500 m RGB tiles shipped with the game (~0.5 m/px)
//   public/aerial/overview.jpg    whole-map low-res image for distant ground
//   public/aerial/manifest.json   tile extents in local meters (as returned by the server)
//   data-raw/aerial-nir/…         near-infrared false-color tiles used offline for trees/roofs
// Usage: node scripts/fetch-aerial.mjs [--force]
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLon, toLat, toX, toZ, HALF_W, HALF_H, M_PER_DEG_LAT, M_PER_DEG_LON } from './geo.mjs';
import jpeg from 'jpeg-js';

// The server occasionally returns a tile with a solid magenta block (a rendering glitch). Real
// scenery almost never has red and blue both far above green, so treat that as corrupt and retry.
function magentaFraction(buf) {
  const { width: W, height: H, data } = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false });
  let mag = 0, total = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 3, r = data[i], g = data[i + 1], b = data[i + 2];
    total++;
    if (r > g * 1.6 + 10 && b > g * 1.35 + 10) mag++;
  }
  return mag / total;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'aerial');
const NIR = join(ROOT, 'data-raw', 'aerial-nir');
const SERVICE = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const TILE = 500; // meters
const PX_W = 1024; // pixels across a tile (east-west)
const ASPECT = M_PER_DEG_LAT / M_PER_DEG_LON; // server keeps pixels square in degrees
const PX_H = Math.round(PX_W / ASPECT);
const force = process.argv.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function exportImage({ west, south, east, north, w, h, bands, quality = 80 }) {
  const bbox = [west, south, east, north].map((v) => v.toFixed(7)).join(',');
  const url = `${SERVICE}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=jpg&compressionQuality=${quality}&bandIds=${bands}&f=json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const meta = await (await fetch(url, { headers: { 'User-Agent': 'osm-driving-game/0.1' }, signal: AbortSignal.timeout(60000) })).json();
      if (!meta.href) throw new Error(JSON.stringify(meta).slice(0, 200));
      const img = await fetch(meta.href, { headers: { 'User-Agent': 'osm-driving-game/0.1' }, signal: AbortSignal.timeout(60000) });
      if (!img.ok) throw new Error(`image HTTP ${img.status}`);
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
      if (bands === '0,1,2' && magentaFraction(buf) > 0.002) throw new Error('corrupt tile (magenta block)');
      return { buf, extent: meta.extent, width: meta.width, height: meta.height };
    } catch (err) {
      console.log(`    retry ${attempt + 1}: ${err.message}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error('exportImage failed after retries');
}

// extent (degrees) -> local meters
const toLocal = (e) => ({ minX: +toX(e.xmin).toFixed(2), maxX: +toX(e.xmax).toFixed(2), minZ: +toZ(e.ymax).toFixed(2), maxZ: +toZ(e.ymin).toFixed(2) });

await mkdir(OUT, { recursive: true });
await mkdir(NIR, { recursive: true });
const manifestPath = join(OUT, 'manifest.json');
const manifest = (!force && (await exists(manifestPath))) ? JSON.parse(await readFile(manifestPath, 'utf8')) : { tile: TILE, tiles: {} };
manifest.source = 'USDA NAIP imagery via USGS The National Map (public domain)';

// overview
if (force || !manifest.overview) {
  console.log('overview…');
  const r = await exportImage({ west: toLon(-HALF_W - 300), east: toLon(HALF_W + 300), north: toLat(-HALF_H - 300), south: toLat(HALF_H + 300), w: 2048, h: Math.round(2048 / (((2 * HALF_W + 600) / M_PER_DEG_LON) / ((2 * HALF_H + 600) / M_PER_DEG_LAT))), bands: '0,1,2', quality: 78 });
  await writeFile(join(OUT, 'overview.jpg'), r.buf);
  manifest.overview = { file: 'overview.jpg', ...toLocal(r.extent), w: r.width, h: r.height };
  await writeFile(manifestPath, JSON.stringify(manifest));
}

const i0 = Math.floor(-HALF_W / TILE), i1 = Math.ceil(HALF_W / TILE) - 1;
const j0 = Math.floor(-HALF_H / TILE), j1 = Math.ceil(HALF_H / TILE) - 1;
const jobs = [];
for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) jobs.push([i, j]);
console.log(`${jobs.length} tiles of ${TILE} m at ${PX_W}x${PX_H}px`);

let done = 0, bytes = 0;
const t0 = Date.now();
async function worker() {
  while (jobs.length) {
    const [i, j] = jobs.shift();
    const key = `${i}_${j}`;
    const file = `t_${key}.jpg`;
    const nirFile = join(NIR, `n_${key}.jpg`);
    const x0 = i * TILE, z0 = j * TILE;
    const box = { west: toLon(x0), east: toLon(x0 + TILE), north: toLat(z0), south: toLat(z0 + TILE) };
    if (force || !manifest.tiles[key] || !(await exists(join(OUT, file)))) {
      const r = await exportImage({ ...box, w: PX_W, h: PX_H, bands: '0,1,2' });
      await writeFile(join(OUT, file), r.buf);
      bytes += r.buf.length;
      manifest.tiles[key] = { file, ...toLocal(r.extent), w: r.width, h: r.height };
    }
    if (force || !(await exists(nirFile))) {
      // NIR, Red, Green false color at ~1 m/px for vegetation (NDVI) analysis; never shipped
      const r = await exportImage({ ...box, w: PX_W / 2, h: Math.round(PX_H / 2), bands: '3,0,1', quality: 90 });
      await writeFile(nirFile, r.buf);
      manifest.tiles[key].nir = { ...toLocal(r.extent), w: r.width, h: r.height };
    }
    done++;
    if (done % 20 === 0) {
      await writeFile(manifestPath, JSON.stringify(manifest));
      console.log(`  ${done} tiles, ${(bytes / 1e6).toFixed(1)} MB new, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await sleep(150);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
await writeFile(manifestPath, JSON.stringify(manifest));
console.log(`done: ${Object.keys(manifest.tiles).length} tiles, ${(bytes / 1e6).toFixed(1)} MB downloaded this run`);

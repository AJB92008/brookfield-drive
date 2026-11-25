// Offline analysis of the NAIP aerial tiles:
//  - roof color per building (mean photo color inside the footprint, ignoring tree pixels via NDVI)
//  - tree positions from the canopy (vegetation that is dark/textured, i.e. not lawn)
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { RoadIndex, BuildingIndex, pointInRing } from '../src/spatial.js';

const decode = async (file) => jpeg.decode(await readFile(file), { useTArray: true, formatAsRGBA: false });

// Tunables (checked against debug images of known places).
export const PARAMS = {
  ndviVeg: 0.18, // NDVI above this = vegetation
  // In these NAIP renders lawns mostly fall below ndviVeg and tree crowns above it; of what remains,
  // only bright *and* smooth vegetation (sports fields, lush lawns) is treated as non-tree.
  lawnLum: 0.5, // vegetation brighter than this (visible luminance 0..1)...
  lawnStd: 0.04, // ...and smoother than this (local NIR std dev) is lawn, not canopy
  maxTrees: 110000,
  minSpacing: 8, // m
  cellFill: 0.45, // fraction of a grid cell that must be canopy to plant a tree there
};

function sampler(img, ext) {
  const { width: w, height: h, data } = img;
  const sx = w / (ext.maxX - ext.minX), sz = h / (ext.maxZ - ext.minZ);
  return (x, z, out) => {
    const px = Math.floor((x - ext.minX) * sx), pz = Math.floor((z - ext.minZ) * sz);
    if (px < 0 || pz < 0 || px >= w || pz >= h) return false;
    const o = (pz * w + px) * 3;
    out[0] = data[o]; out[1] = data[o + 1]; out[2] = data[o + 2];
    return true;
  };
}

export async function analyzeAerial({ root, map, log = console.log, debugTile = null }) {
  const manifest = JSON.parse(await readFile(join(root, 'data-raw', 'aerial-rgb', 'manifest.json'), 'utf8'));
  const roads = new RoadIndex(map);
  const bindex = new BuildingIndex(map);
  const nb = map.buildings.length;
  const sumR = new Float64Array(nb), sumG = new Float64Array(nb), sumB = new Float64Array(nb), cnt = new Uint32Array(nb), seen = new Uint32Array(nb);

  // Pass 1 per tile: canopy mask + roof sampling.
  const canopyTiles = [];
  let canopyPx = 0, totalPx = 0;
  const keys = Object.keys(manifest.tiles);
  let k = 0;
  for (const key of keys) {
    const t = manifest.tiles[key];
    if (!t.nir) continue;
    let rgb, nir;
    try {
      rgb = await decode(join(root, 'data-raw', 'aerial-rgb', t.file));
      nir = await decode(join(root, 'data-raw', 'aerial-nir', `n_${key}.jpg`));
    } catch (err) {
      log(`  skip ${key}: ${err.message}`);
      continue;
    }
    const W = nir.width, H = nir.height, nd = nir.data;
    const ext = t.nir;
    const sRGB = sampler(rgb, t);
    const pxW = (ext.maxX - ext.minX) / W, pxH = (ext.maxZ - ext.minZ) / H;
    // NIR brightness for local texture
    const nirB = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) nirB[i] = nd[i * 3] / 255;
    const mask = new Uint8Array(W * H);
    const c = [0, 0, 0];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const n = nd[i * 3], r = nd[i * 3 + 1];
        const ndvi = (n - r) / (n + r + 1);
        if (ndvi < PARAMS.ndviVeg) continue;
        mask[i] = 1; // vegetation
        const wx = ext.minX + (x + 0.5) * pxW, wz = ext.minZ + (y + 0.5) * pxH;
        let lum = 1;
        if (sRGB(wx, wz, c)) lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
        // 3x3 NIR std dev
        let s = 0, s2 = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = nirB[i + dy * W + dx]; s += v; s2 += v * v; }
        const std = Math.sqrt(Math.max(0, s2 / 9 - (s / 9) ** 2));
        if (!(lum > PARAMS.lawnLum && std < PARAMS.lawnStd)) { mask[i] = 2; canopyPx++; } // tree canopy
      }
    }
    totalPx += W * H;
    canopyTiles.push({ key, ext, W, H, mask, pxW, pxH });

    // Roof colors: sample buildings overlapping this tile on a ~1 m grid, 1 m inside the walls.
    const seenThisTile = new Set();
    bindex.bboxGrid.forBox(t.minX, t.minZ, t.maxX, t.maxZ, (bi) => {
      if (seenThisTile.has(bi)) return;
      seenThisTile.add(bi);
      const ring = bindex.rings[bi];
      const bb = bindex.bbox;
      const x0 = Math.max(bb[bi * 4], t.minX), x1 = Math.min(bb[bi * 4 + 2], t.maxX);
      const z0 = Math.max(bb[bi * 4 + 1], t.minZ), z1 = Math.min(bb[bi * 4 + 3], t.maxZ);
      const step = (x1 - x0) * (z1 - z0) > 20000 ? 2.5 : 1;
      for (let z = z0 + 0.5; z < z1; z += step) {
        for (let x = x0 + 0.5; x < x1; x += step) {
          if (!pointInRing(x, z, ring) || !pointInRing(x + 1, z, ring) || !pointInRing(x - 1, z, ring) || !pointInRing(x, z + 1, ring) || !pointInRing(x, z - 1, ring)) continue;
          seen[bi]++;
          const mx = Math.floor((x - ext.minX) / pxW), mz = Math.floor((z - ext.minZ) / pxH);
          if (mx >= 0 && mz >= 0 && mx < W && mz < H && mask[mz * W + mx]) continue; // tree over roof
          if (!sRGB(x, z, c)) continue;
          if (c[0] > c[1] * 1.6 + 10 && c[2] > c[1] * 1.35 + 10) continue; // imagery glitch, not a roof color
          sumR[bi] += c[0]; sumG[bi] += c[1]; sumB[bi] += c[2]; cnt[bi]++;
        }
      }
    });
    if (debugTile === key) await writeDebug(root, key, rgb, mask, W, H);
    if (++k % 50 === 0) log(`  analyzed ${k}/${keys.length} tiles`);
  }

  // Roof colors (sRGB 0-255). Need a few clean samples and at least a third of the roof unobstructed.
  let roofCount = 0;
  map.buildings.forEach((b, bi) => {
    if (cnt[bi] >= 4 && cnt[bi] >= seen[bi] * 0.33) {
      b.rc = [Math.round(sumR[bi] / cnt[bi]), Math.round(sumG[bi] / cnt[bi]), Math.round(sumB[bi] / cnt[bi])];
      roofCount++;
    }
  });

  // Trees: grid sized so the canopy is covered with at most maxTrees, jittered, cleared of roads/buildings.
  const canopyArea = canopyPx * (canopyTiles[0]?.pxW ?? 1) * (canopyTiles[0]?.pxH ?? 1);
  // Dense near roads (what you see while driving), sparse deep in the woods.
  const S_NEAR = 14, S_FAR = 28, NEAR_ROAD = 70;
  const S = S_NEAR;
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const trees = [];
  let rejected = 0;
  for (const t of canopyTiles) {
    const { ext, W, H, mask, pxW, pxH } = t;
    for (const pass of ['near', 'far']) {
      const step = pass === 'near' ? S_NEAR : S_FAR;
      for (let cz = ext.minZ; cz < ext.maxZ; cz += step) {
        for (let cx = ext.minX; cx < ext.maxX; cx += step) {
          const ccx = cx + step / 2, ccz = cz + step / 2;
          const nearRoad = !!roads.nearest(ccx, ccz, NEAR_ROAD);
          if ((pass === 'near') !== nearRoad) continue;
          // canopy fraction in this cell
          const x0 = Math.floor((cx - ext.minX) / pxW), x1 = Math.min(W, Math.floor((cx + step - ext.minX) / pxW));
          const z0 = Math.floor((cz - ext.minZ) / pxH), z1 = Math.min(H, Math.floor((cz + step - ext.minZ) / pxH));
          let tot = 0, can = 0;
          for (let y = z0; y < z1; y++) for (let x = x0; x < x1; x++) { tot++; if (mask[y * W + x] === 2) can++; }
          if (!tot || can / tot < PARAMS.cellFill) continue;
          let px = 0, pz = 0, found = false;
          for (let attempt = 0; attempt < 8 && !found; attempt++) {
            const x = x0 + Math.floor((0.25 + rand() * 0.5) * (x1 - x0)), y = z0 + Math.floor((0.25 + rand() * 0.5) * (z1 - z0));
            if (mask[y * W + x] === 2) { px = x; pz = y; found = true; }
          }
          if (!found) continue;
          const wx = ext.minX + (px + 0.5) * pxW, wz = ext.minZ + (pz + 0.5) * pxH;
          const near = roads.nearest(wx, wz, 20);
          if (near && near.dist < map.roads[near.road].w / 2 + 1.2) { rejected++; continue; }
          if (bindex.buildingAt(wx, wz) >= 0 || bindex.distToWall(wx, wz, 2) < 2) { rejected++; continue; }
          const scale = Math.min(3.2, (step / 5.2) * (0.85 + rand() * 0.35));
          trees.push(+wx.toFixed(1), +wz.toFixed(1), +scale.toFixed(2), rand() < 0.14 ? 1 : 0);
        }
      }
    }
  }
  log(`  canopy ${(canopyArea / 1e6).toFixed(1)} km² of ${(totalPx * (canopyTiles[0]?.pxW ?? 1) * (canopyTiles[0]?.pxH ?? 1) / 1e6).toFixed(0)} km²; tree spacing ${S.toFixed(1)} m; ${trees.length / 4} trees (${rejected} rejected near roads/buildings); roof colors for ${roofCount}/${nb} buildings`);
  return { trees };
}

async function writeDebug(root, key, rgb, mask, W, H) {
  // side by side: photo (downsampled to mask size) | mask (green = canopy, yellow-green = lawn/other veg)
  const out = Buffer.alloc(W * 2 * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.floor((x / W) * rgb.width), sy = Math.floor((y / H) * rgb.height);
      const si = (sy * rgb.width + sx) * 3;
      const o = (y * W * 2 + x) * 4;
      out[o] = rgb.data[si]; out[o + 1] = rgb.data[si + 1]; out[o + 2] = rgb.data[si + 2]; out[o + 3] = 255;
      const m = mask[y * W + x];
      const o2 = (y * W * 2 + W + x) * 4;
      const col = m === 2 ? [20, 110, 30] : m === 1 ? [190, 220, 90] : [rgb.data[si] * 0.5, rgb.data[si + 1] * 0.5, rgb.data[si + 2] * 0.5];
      out[o2] = col[0]; out[o2 + 1] = col[1]; out[o2 + 2] = col[2]; out[o2 + 3] = 255;
    }
  }
  const enc = jpeg.encode({ data: out, width: W * 2, height: H }, 85);
  const file = join(root, 'data-raw', `debug-canopy-${key}.jpg`);
  await writeFile(file, enc.data);
}

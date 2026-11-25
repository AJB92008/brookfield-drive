// Turns the NAIP aerial photos into stylized ground tiles for classic mode: every ~1 m pixel is
// classified (lawn, tree canopy, dry grass/field, bare soil, concrete, asphalt, water) from the
// photo + near-infrared, cleaned up with a majority filter, and painted with the game's flat palette.
//   public/ground/g_{key}.png + public/ground/overview.png + public/ground/manifest.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import { pointInRing } from '../src/spatial.js';

const { PNG } = pngjs;
const C = { ASPHALT: 0, CONCRETE: 1, LAWN: 2, CANOPY: 3, DRY: 4, SOIL: 5, WATER: 6, SHADE: 7 };
// cartoon palette (sRGB), tuned to sit with the low-poly buildings/trees
const PALETTE = [
  [126, 128, 130], // asphalt (parking lots, driveways)
  [200, 196, 187], // concrete
  [120, 170, 84], // lawn
  [70, 116, 58], // tree canopy
  [178, 172, 114], // dry grass / fields
  [168, 142, 106], // bare soil
  [78, 134, 182], // water
];

const decode = async (file) => jpeg.decode(await readFile(file), { useTArray: true, formatAsRGBA: false });

// Shaded pixels take the look of what surrounds them: mostly grass/trees -> lawn (or canopy),
// mostly pavement -> asphalt. Uses integral images over a 15x15 window.
function resolveShade(cls, W, H, R = 7) {
  const veg = new Int32Array((W + 1) * (H + 1)), can = new Int32Array((W + 1) * (H + 1)), hard = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rv = 0, rc = 0, rh = 0;
    for (let x = 0; x < W; x++) {
      const c = cls[y * W + x];
      rv += c === C.LAWN || c === C.CANOPY || c === C.DRY ? 1 : 0;
      rc += c === C.CANOPY ? 1 : 0;
      rh += c === C.ASPHALT || c === C.CONCRETE || c === C.SOIL ? 1 : 0;
      const o = (y + 1) * (W + 1) + x + 1, up = y * (W + 1) + x + 1;
      veg[o] = veg[up] + rv; can[o] = can[up] + rc; hard[o] = hard[up] + rh;
    }
  }
  const box = (I, x0, y0, x1, y1) => I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (cls[i] !== C.SHADE) continue;
      const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(W, x + R + 1), y1 = Math.min(H, y + R + 1);
      const v = box(veg, x0, y0, x1, y1), c = box(can, x0, y0, x1, y1), h = box(hard, x0, y0, x1, y1);
      cls[i] = v >= h ? (c > v * 0.6 ? C.CANOPY : C.LAWN) : C.ASPHALT;
    }
  }
}

// Merge connected patches smaller than minSize pixels into their most common neighboring class, so
// the ground reads as clean cartoon shapes instead of speckle.
function removeSmall(cls, W, H, minSize = 12) {
  const label = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H), px = new Int32Array(W * H);
  const small = [];
  let id = 0;
  for (let s0 = 0; s0 < W * H; s0++) {
    if (label[s0] >= 0) continue;
    const c = cls[s0];
    let sp = 0, n = 0;
    stack[sp++] = s0; label[s0] = id;
    while (sp) {
      const p = stack[--sp];
      px[n++] = p;
      const x = p % W;
      if (x > 0 && label[p - 1] < 0 && cls[p - 1] === c) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && label[p + 1] < 0 && cls[p + 1] === c) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= W && label[p - W] < 0 && cls[p - W] === c) { label[p - W] = id; stack[sp++] = p - W; }
      if (p < W * (H - 1) && label[p + W] < 0 && cls[p + W] === c) { label[p + W] = id; stack[sp++] = p + W; }
    }
    if (n < minSize) small.push([id, px.slice(0, n)]);
    id++;
  }
  const counts = new Int32Array(8);
  for (const [rid, pts] of small) {
    counts.fill(0);
    for (const p of pts) {
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q < 0 || q >= W * H || label[q] === rid) continue;
        counts[cls[q]]++;
      }
    }
    let best = -1, bc = 0;
    for (let k = 0; k < 8; k++) if (counts[k] > bc) { bc = counts[k]; best = k; }
    if (best >= 0) for (const p of pts) { cls[p] = best; label[p] = -2; }
  }
  return cls;
}

function majority(cls, W, H, passes = 2) {
  let src = cls, dst = new Uint8Array(cls.length);
  const counts = new Uint8Array(8);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
          counts[src[yy * W + xx]]++;
        }
        let best = src[y * W + x], bc = counts[best];
        for (let k = 0; k < 7; k++) if (counts[k] > bc + 1) { best = k; bc = counts[k]; }
        dst[y * W + x] = best;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

export async function stylizeGround({ root, rgbDir, nirDir, aerialManifest, map, only = null, debugDir = null, log = console.log }) {
  const OUT = join(root, 'public', 'ground');
  await mkdir(OUT, { recursive: true });
  // OSM water + parking polygons (with bboxes) to sharpen those classes
  const polys = (kind) => map.areas.filter((a) => a.k === kind).map((a) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < a.p.length; i += 2) { minX = Math.min(minX, a.p[i]); maxX = Math.max(maxX, a.p[i]); minZ = Math.min(minZ, a.p[i + 1]); maxZ = Math.max(maxZ, a.p[i + 1]); }
    return { p: a.p, minX, minZ, maxX, maxZ };
  });
  const water = polys('water'), parking = polys('parking');
  const inside = (list, x, z) => list.some((q) => x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ && pointInRing(x, z, q.p));

  const manifest = { source: 'Stylized from USDA NAIP imagery (public domain) + OpenStreetMap', tiles: {} };
  const ov = aerialManifest.overview;
  const OVW = 2048, OVH = Math.round(2048 * ((ov.maxZ - ov.minZ) / (ov.maxX - ov.minX)));
  const overview = new Uint8Array(OVW * OVH * 3).fill(0);
  const ovFilled = new Uint8Array(OVW * OVH);
  const counts = new Array(7).fill(0);
  const keys = Object.keys(aerialManifest.tiles).filter((k) => !only || only.includes(k));
  let n = 0;
  for (const key of keys) {
    const t = aerialManifest.tiles[key];
    if (!t.nir) continue;
    const rgb = await decode(join(rgbDir, t.file));
    const nir = await decode(join(nirDir, `n_${key}.jpg`));
    const W = nir.width, H = nir.height, ext = t.nir;
    const pxW = (ext.maxX - ext.minX) / W, pxH = (ext.maxZ - ext.minZ) / H;
    const sx = rgb.width / (t.maxX - t.minX), sz = rgb.height / (t.maxZ - t.minZ);
    const cls = new Uint8Array(W * H);
    const nirB = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) nirB[i] = nir.data[i * 3] / 255;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const wx = ext.minX + (x + 0.5) * pxW, wz = ext.minZ + (y + 0.5) * pxH;
        // average the (2x finer) photo over this pixel
        let R = 0, G = 0, B = 0, cnt = 0;
        const px0 = Math.floor((wx - pxW / 2 - t.minX) * sx), pz0 = Math.floor((wz - pxH / 2 - t.minZ) * sz);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(rgb.width - 1, Math.max(0, px0 + dx)), pz = Math.min(rgb.height - 1, Math.max(0, pz0 + dy));
          const o = (pz * rgb.width + px) * 3;
          R += rgb.data[o]; G += rgb.data[o + 1]; B += rgb.data[o + 2]; cnt++;
        }
        R /= cnt; G /= cnt; B /= cnt;
        const n0 = nir.data[i * 3], r0 = nir.data[i * 3 + 1];
        const ndvi = (n0 - r0) / (n0 + r0 + 1);
        const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx > 0 ? (mx - mn) / mx : 0;
        let std = 0;
        if (x > 0 && y > 0 && x < W - 1 && y < H - 1) {
          let s = 0, s2 = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = nirB[i + dy * W + dx]; s += v; s2 += v * v; }
          std = Math.sqrt(Math.max(0, s2 / 9 - (s / 9) ** 2));
        }
        let c;
        if (inside(water, wx, wz)) c = C.WATER;
        else if (ndvi > 0.18) c = lum > 0.5 && std < 0.04 ? C.LAWN : C.CANOPY;
        else if (ndvi > 0.03) c = G >= R * 0.95 ? C.LAWN : C.DRY;
        else if (inside(parking, wx, wz)) c = C.ASPHALT;
        else if (lum < 0.34) c = C.SHADE; // shade (or dark pavement): decided from the surroundings below
        else if (sat < 0.16) c = lum > 0.55 ? C.CONCRETE : C.ASPHALT;
        else if (R > B + 15) c = C.SOIL;
        else c = C.ASPHALT;
        cls[i] = c;
      }
    }
    resolveShade(cls, W, H);
    const clean = removeSmall(majority(cls, W, H, 3), W, H, 12);
    const png = new PNG({ width: W, height: H, colorType: 2, inputHasAlpha: false });
    // png.data is RGBA internally
    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = PALETTE[clean[i]]; // flat colors: crisp cartoon look, and PNG compresses them well
      png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
      counts[clean[i]]++;
    }
    const file = `g_${key}.png`;
    await writeFile(join(OUT, file), PNG.sync.write(png, { colorType: 2 }));
    manifest.tiles[key] = { file, minX: ext.minX, maxX: ext.maxX, minZ: ext.minZ, maxZ: ext.maxZ, w: W, h: H };
    // splat into the overview
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const wx = ext.minX + (x + 0.5) * pxW, wz = ext.minZ + (y + 0.5) * pxH;
      const ox = Math.floor(((wx - ov.minX) / (ov.maxX - ov.minX)) * OVW), oz = Math.floor(((wz - ov.minZ) / (ov.maxZ - ov.minZ)) * OVH);
      if (ox < 0 || oz < 0 || ox >= OVW || oz >= OVH || ovFilled[oz * OVW + ox]) continue;
      const [r, g, b] = PALETTE[clean[y * W + x]];
      overview.set([r, g, b], (oz * OVW + ox) * 3);
      ovFilled[oz * OVW + ox] = 1;
    }
    if (debugDir) {
      const dbg = new PNG({ width: W * 2, height: H });
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const px = Math.min(rgb.width - 1, Math.floor((x / W) * rgb.width)), pz = Math.min(rgb.height - 1, Math.floor((y / H) * rgb.height));
        const o = (pz * rgb.width + px) * 3, d = (y * W * 2 + x) * 4, d2 = (y * W * 2 + W + x) * 4, s = (y * W + x) * 4;
        dbg.data.set([rgb.data[o], rgb.data[o + 1], rgb.data[o + 2], 255], d);
        dbg.data.set([png.data[s], png.data[s + 1], png.data[s + 2], 255], d2);
      }
      await writeFile(join(debugDir, `stylized-${key}.png`), PNG.sync.write(dbg));
    }
    if (++n % 50 === 0) log(`  stylized ${n}/${keys.length}`);
  }
  if (!only) {
    // fill overview holes with lawn, then write
    const ovPng = new PNG({ width: OVW, height: OVH, colorType: 2 });
    for (let i = 0; i < OVW * OVH; i++) {
      const c = ovFilled[i] ? [overview[i * 3], overview[i * 3 + 1], overview[i * 3 + 2]] : PALETTE[C.LAWN];
      ovPng.data[i * 4] = c[0]; ovPng.data[i * 4 + 1] = c[1]; ovPng.data[i * 4 + 2] = c[2]; ovPng.data[i * 4 + 3] = 255;
    }
    await writeFile(join(OUT, 'overview.png'), PNG.sync.write(ovPng, { colorType: 2 }));
    manifest.overview = { file: 'overview.png', minX: ov.minX, maxX: ov.maxX, minZ: ov.minZ, maxZ: ov.maxZ };
    await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest));
  }
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  log(`  ground classes: ${['asphalt', 'concrete', 'lawn', 'canopy', 'dry', 'soil', 'water'].map((nm, k) => `${nm} ${((counts[k] / total) * 100).toFixed(1)}%`).join(', ')}`);
  return manifest;
}

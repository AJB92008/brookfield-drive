// Bakes USGS 3DEP elevation into the game's terrain grid and computes bridge deck heights.
//   public/data/terrain.bin : Uint16 grid, decimeters above minH, row-major (rows = z, cols = x), 10 m spacing
//   meta (returned)         : { step, minX, minZ, cols, rows, minH, scale, base }
// Heights in the game are meters relative to `base` (the ground at the spawn), matching photoreal mode.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { toX, toZ, EXTENT } from './geo.mjs';

const STEP = 10;
const MARGIN = 600;

export async function buildTerrain({ root, roads, nodes, spawn, log = console.log }) {
  const meta = JSON.parse(await readFile(join(root, 'data-raw', 'terrain.json'), 'utf8'));
  // tiled (terrain-{i}-{j}.tif, overlapping) or the older single terrain.tif
  const list = meta.tiles ?? [{ file: 'terrain.tif', extent: meta.extent }];
  let bad = 0;
  const tiles = [];
  for (const t of list) {
    const buf = await readFile(join(root, 'data-raw', t.file));
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const img = await tiff.getImage();
    const [src] = await img.readRasters();
    const e = t.extent;
    for (let i = 0; i < src.length; i++) if (!(src[i] > -100 && src[i] < 9000)) { src[i] = NaN; bad++; }
    tiles.push({ src, W: img.getWidth(), H: img.getHeight(), sMinX: toX(e.xmin), sMaxX: toX(e.xmax), sMinZ: toZ(e.ymax), sMaxZ: toZ(e.ymin) });
  }
  // the tile in which (x,z) is deepest inside (tiles overlap, so a seam is never sampled at a tile's edge)
  const tileAt = (x, z) => {
    let best = tiles[0], bestD = -Infinity;
    for (const t of tiles) {
      const d = Math.min(x - t.sMinX, t.sMaxX - x, z - t.sMinZ, t.sMaxZ - z);
      if (d > bestD) { bestD = d; best = t; }
    }
    return best;
  };

  // bilinear sample of the source raster at local (x,z)
  const srcH = (x, z) => {
    const { src, W, H, sMinX, sMaxX, sMinZ, sMaxZ } = tileAt(x, z);
    const fx = ((x - sMinX) / (sMaxX - sMinX)) * W - 0.5, fz = ((z - sMinZ) / (sMaxZ - sMinZ)) * H - 0.5;
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))), z0 = Math.max(0, Math.min(H - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - x0)), tz = Math.max(0, Math.min(1, fz - z0));
    const a = src[z0 * W + x0], b = src[z0 * W + x0 + 1], c = src[(z0 + 1) * W + x0], d = src[(z0 + 1) * W + x0 + 1];
    const vals = [[a, (1 - tx) * (1 - tz)], [b, tx * (1 - tz)], [c, (1 - tx) * tz], [d, tx * tz]].filter(([v]) => !Number.isNaN(v));
    const w = vals.reduce((s, [, k]) => s + k, 0);
    return w > 0 ? vals.reduce((s, [v, k]) => s + v * k, 0) / w : NaN;
  };

  // output grid with a small box filter (average of 9 samples per cell)
  const minX = Math.floor((EXTENT.minX - MARGIN) / STEP) * STEP, minZ = Math.floor((EXTENT.minZ - MARGIN) / STEP) * STEP;
  const cols = Math.ceil((EXTENT.maxX + MARGIN - minX) / STEP) + 1, rows = Math.ceil((EXTENT.maxZ + MARGIN - minZ) / STEP) + 1;
  const grid = new Float32Array(cols * rows);
  let minH = Infinity, maxH = -Infinity, holes = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + c * STEP, z = minZ + r * STEP;
      let s = 0, n = 0;
      for (const ox of [-3.3, 0, 3.3]) for (const oz of [-3.3, 0, 3.3]) { const v = srcH(x + ox, z + oz); if (!Number.isNaN(v)) { s += v; n++; } }
      const v = n ? s / n : NaN;
      grid[r * cols + c] = v;
      if (Number.isNaN(v)) holes++; else { minH = Math.min(minH, v); maxH = Math.max(maxH, v); }
    }
  }
  if (holes) for (let i = 0; i < grid.length; i++) if (Number.isNaN(grid[i])) grid[i] = minH; // outside coverage: flat

  const enc = new Uint16Array(grid.length);
  for (let i = 0; i < grid.length; i++) enc[i] = Math.round((grid[i] - minH) * 10);
  await writeFile(join(root, 'public', 'data', 'terrain.bin'), Buffer.from(enc.buffer));

  // height relative to the spawn (game y)
  const gridH = (x, z) => {
    const fx = (x - minX) / STEP, fz = (z - minZ) / STEP;
    const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - c0)), tz = Math.max(0, Math.min(1, fz - r0));
    const g = (r, c) => enc[r * cols + c] * 0.1 + minH;
    const A = g(r0, c0), D = g(r0, c0 + 1), B = g(r0 + 1, c0), C = g(r0 + 1, c0 + 1);
    return tx + tz <= 1 ? A + (D - A) * tx + (B - A) * tz : C + (B - C) * (1 - tx) + (D - C) * (1 - tz); // same split as the game
  };
  const base = gridH(spawn.x, spawn.z);

  // Bridge decks: bare-earth elevation has no bridges, so a deck runs straight from abutment to abutment.
  // Consecutive bridge ways (OSM often splits a bridge) are chained so the deck doesn't dip at the split.
  const X = (n) => nodes[n * 2], Z = (n) => nodes[n * 2 + 1];
  const bridgeIdx = roads.map((r, i) => (r.b ? i : -1)).filter((i) => i >= 0);
  const endsAt = new Map(); // node -> bridge road indices with an endpoint there
  for (const i of bridgeIdx) for (const n of [roads[i].nd[0], roads[i].nd.at(-1)]) { if (!endsAt.has(n)) endsAt.set(n, []); endsAt.get(n).push(i); }
  const done = new Set();
  let chains = 0;
  for (const start of bridgeIdx) {
    if (done.has(start)) continue;
    // grow the chain both ways through nodes joining exactly two bridge ways
    const chain = [start];
    done.add(start);
    for (const dir of ['back', 'fwd']) {
      let cur = start, node = dir === 'fwd' ? roads[start].nd.at(-1) : roads[start].nd[0];
      for (;;) {
        const nxt = (endsAt.get(node) || []).filter((i) => i !== cur && !done.has(i));
        if ((endsAt.get(node) || []).length !== 2 || nxt.length !== 1) break;
        const n = nxt[0];
        done.add(n);
        if (dir === 'fwd') chain.push(n); else chain.unshift(n);
        node = roads[n].nd[0] === node ? roads[n].nd.at(-1) : roads[n].nd[0];
        cur = n;
      }
    }
    // ordered node list along the chain
    const seq = [];
    let tail = null;
    for (const i of chain) {
      let nd = roads[i].nd;
      if (tail !== null && nd[0] !== tail) nd = nd.slice().reverse();
      if (tail === null && chain.length > 1) {
        const nextNd = roads[chain[1]].nd;
        if (nd.at(-1) !== nextNd[0] && nd.at(-1) !== nextNd.at(-1)) nd = nd.slice().reverse();
      }
      for (const n of nd) if (seq.at(-1) !== n) seq.push(n);
      tail = nd.at(-1);
    }
    const cum = [0];
    for (let k = 1; k < seq.length; k++) cum.push(cum[k - 1] + Math.hypot(X(seq[k]) - X(seq[k - 1]), Z(seq[k]) - Z(seq[k - 1])));
    const L = cum.at(-1) || 1;
    const h0 = gridH(X(seq[0]), Z(seq[0])) - base, h1 = gridH(X(seq.at(-1)), Z(seq.at(-1))) - base;
    const deck = new Map(seq.map((n, k) => [n, h0 + ((h1 - h0) * cum[k]) / L]));
    for (const i of chain) roads[i].dh = roads[i].nd.map((n) => Math.round(deck.get(n) * 100) / 100);
    chains++;
  }

  const out = { step: STEP, minX, minZ, cols, rows, minH: Math.round(minH * 100) / 100, scale: 0.1, base: Math.round(base * 100) / 100, source: 'USGS 3DEP (public domain)' };
  log(`  terrain: ${cols}x${rows} grid at ${STEP} m, ${minH.toFixed(1)}–${maxH.toFixed(1)} m above sea level (spawn ${base.toFixed(1)} m), ${bad} nodata source px; ${bridgeIdx.length} bridge ways in ${chains} decks; ${(enc.byteLength / 1e6).toFixed(1)} MB`);
  return out;
}

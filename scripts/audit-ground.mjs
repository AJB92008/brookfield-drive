// Audits every road for places where any drawn ground could poke through the pavement: the 10 m ground
// tiles, the coarse distant overview and the fallback plane (all depth-writing). Rebuilds each road ribbon
// the way world.js does (5 m stations, level across at the centerline) and compares with each surface
// using the same triangle interpolation as the meshes. Also checks sidewalks against the ground tiles.
// Usage: node scripts/audit-ground.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleGrid, carveRoadBeds, groundMinIn, sidewalkQuads, setTerrain, isMinorRoad, ROAD_SURFACE, ROAD_STATION } from '../src/terrain.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(await readFile(join(ROOT, 'public', 'data', 'brookfield.json'), 'utf8'));
const buf = await readFile(join(ROOT, 'public', 'data', 'terrain.bin'));
const grid = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
const m = map.terrain, off = m.minH - m.base;
const orig = Float32Array.from(grid, (v) => v * m.scale + off);
const ground = carveRoadBeds(orig, m, map.nodes, map.roads);
const T = (x, z) => sampleGrid(ground, m, x, z); // drawn ground
const Troad = (x, z) => sampleGrid(orig, m, x, z); // road surfaces
const gmeta = { ...m, ground };
setTerrain(T, Troad); // sidewalkQuads reads the game's T()

// coarse meshes exactly as aerial.js makeQuad / world.js build them (PlaneGeometry grid, B-D split)
function coarse(ext, sx, sz, offset) {
  const cw = (ext.maxX - ext.minX) / sx, ch = (ext.maxZ - ext.minZ) / sz, n = sx + 1;
  const Hs = new Float32Array((sx + 1) * (sz + 1));
  for (let iy = 0; iy <= sz; iy++) for (let ix = 0; ix <= sx; ix++) {
    const x = ext.minX + ix * cw, z = ext.minZ + iy * ch;
    Hs[iy * n + ix] = groundMinIn(x - cw, z - ch, x + cw, z + ch, gmeta) + offset;
  }
  return (x, z) => {
    const fx = (x - ext.minX) / cw, fz = (z - ext.minZ) / ch;
    if (fx < 0 || fz < 0 || fx > sx || fz > sz) return -Infinity;
    const c0 = Math.min(sx - 1, Math.floor(fx)), r0 = Math.min(sz - 1, Math.floor(fz)), tx = fx - c0, tz = fz - r0, i = r0 * n + c0;
    const A = Hs[i], D = Hs[i + 1], B = Hs[i + n], C = Hs[i + n + 1];
    return tx + tz <= 1 ? A + (D - A) * tx + (B - A) * tz : C + (B - C) * (1 - tx) + (D - C) * (1 - tz);
  };
}
const gm = JSON.parse(await readFile(join(ROOT, 'public', 'ground', 'manifest.json'), 'utf8')).overview;
const ovW = gm.maxX - gm.minX, ovSx = 220, ovSz = Math.max(1, Math.round((220 * (gm.maxZ - gm.minZ)) / ovW));
const overviewH = coarse(gm, ovSx, ovSz, -1.5);
const b = map.bounds, MARGIN = 2500;
const fallbackH = coarse({ minX: b.minX - MARGIN, maxX: b.maxX + MARGIN, minZ: b.minZ - MARGIN, maxZ: b.maxZ + MARGIN }, 180, 180, -4);
let coarseBad = 0, coarseWorst = Infinity;

const LIFT = ROAD_SURFACE;
const MAX_SEG = ROAD_STATION;
const { nodes, roads } = map;
let samples = 0, bad = 0, worst = 0, edges = 0, floating = 0;
const badRoads = new Map();
for (const r of roads) {
  if (r.dh || isMinorRoad(r)) continue; // bridge decks are above the ground by design; minor roads aren't drawn
  const pts = [];
  for (let k = 0; k < r.nd.length; k++) {
    const x = nodes[r.nd[k] * 2], z = nodes[r.nd[k] * 2 + 1];
    if (k > 0) {
      const [ax, az] = pts[pts.length - 1];
      const steps = Math.floor(Math.hypot(x - ax, z - az) / MAX_SEG);
      for (let j = 1; j <= steps; j++) { const t = j / (steps + 1); pts.push([ax + (x - ax) * t, az + (z - az) * t]); }
    }
    pts.push([x, z]);
  }
  const hw = r.w / 2;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const L = Math.hypot(bx - ax, bz - az) || 1e-6;
    const nx = -(bz - az) / L, nz = (bx - ax) / L;
    // the ribbon quad's four corners (terrain + lift), sampled inside on a small grid
    const c = [[ax + nx * hw, az + nz * hw], [ax - nx * hw, az - nz * hw], [bx + nx * hw, bz + nz * hw], [bx - nx * hw, bz - nz * hw]];
    const ha = Troad(ax, az) + LIFT, hb = Troad(bx, bz) + LIFT;
    for (const [x, z] of c) { edges++; if ((x === c[0][0] || x === c[1][0] ? ha : hb) - T(x, z) > 0.5) floating++; }
    const h = [ha, ha, hb, hb]; // level across the width (world.js ribbon)
    for (const u of [0.25, 0.5, 0.75]) {
      for (const v of [0.1, 0.5, 0.9]) {
        // triangles (c0,c1,c3) and (c0,c3,c2) split the quad; use the matching planar interpolation
        const x = (c[0][0] * (1 - v) + c[1][0] * v) * (1 - u) + (c[2][0] * (1 - v) + c[3][0] * v) * u;
        const z = (c[0][1] * (1 - v) + c[1][1] * v) * (1 - u) + (c[2][1] * (1 - v) + c[3][1] * v) * u;
        const roadH = u <= v ? h[0] + (h[1] - h[0]) * v + (h[3] - h[1]) * u : h[0] + (h[2] - h[0]) * u + (h[3] - h[2]) * v;
        if (x < m.minX || z < m.minZ || x > m.minX + (m.cols - 1) * m.step || z > m.minZ + (m.rows - 1) * m.step) continue; // off the grid
        const gap = roadH - T(x, z);
        samples++;
        const cg = roadH - Math.max(overviewH(x, z), fallbackH(x, z));
        coarseWorst = Math.min(coarseWorst, cg);
        if (cg < 0.03) coarseBad++;
        if (gap < 0.03) {
          bad++;
          worst = Math.min(worst, gap);
          const name = r.n || r.r || r.t;
          const e = badRoads.get(name) || { n: 0, worst: 0, x, z };
          e.n++; if (gap < e.worst) { e.worst = gap; e.x = x; e.z = z; }
          badRoads.set(name, e);
        }
      }
    }
  }
}
console.log(`checked ${samples.toLocaleString()} points on ${roads.filter((r) => !r.dh && !isMinorRoad(r)).length.toLocaleString()} drawn roads`);
console.log(`road edges more than 0.5 m above the ground (get a concrete edge): ${((floating / edges) * 100).toFixed(1)}%`);
console.log(`ground within 3 cm of / above the pavement at ${bad} points (${((bad / samples) * 100).toFixed(3)}%), worst ${worst.toFixed(2)} m`);
for (const [name, e] of [...badRoads.entries()].sort((a, b) => a[1].worst - b[1].worst).slice(0, 12)) {
  console.log(`  ${name}: ${e.n} points, worst ${e.worst.toFixed(2)} m at (${e.x.toFixed(0)}, ${e.z.toFixed(0)})`);
}
console.log(`coarse overview / fallback plane within 3 cm of / above the pavement: ${coarseBad} points (closest ${coarseWorst.toFixed(2)} m below)`);

// sidewalks: furniture.js quads (terrain.js sidewalkQuads) at their lifted base + 0.205 m
let swSamples = 0, swBad = 0, swWorst = Infinity;
const SW_Y = 0.15 + 0.055;
for (const raw of map.furniture.sidewalks) {
  sidewalkQuads(raw, (q, hs) => {
    const qh = hs.map((v) => v + SW_Y);
    for (const [i0, i1, i2] of [[0, 1, 2], [0, 2, 3]]) {
      for (const [w0, w1, w2] of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [0.45, 0.45, 0.1], [0.1, 0.45, 0.45]]) {
        const x = q[i0][0] * w0 + q[i1][0] * w1 + q[i2][0] * w2, z = q[i0][1] * w0 + q[i1][1] * w1 + q[i2][1] * w2;
        const gap = qh[i0] * w0 + qh[i1] * w1 + qh[i2] * w2 - T(x, z);
        swSamples++;
        swWorst = Math.min(swWorst, gap);
        if (gap < 0.03) swBad++;
      }
    }
  });
}
console.log(`sidewalks: ground within 3 cm of / above the concrete at ${swBad} of ${swSamples.toLocaleString()} points (closest ${swWorst.toFixed(2)} m)`);

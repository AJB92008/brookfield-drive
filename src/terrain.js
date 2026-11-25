// Real ground elevation (USGS 3DEP lidar, baked to a 10 m grid by scripts/terrain-build.mjs).
// T(x, z) = ground height in meters relative to the spawn point (0 when no terrain is loaded).
let heightFn = () => 0, roadFn = () => 0;
// T: the drawn ground (road beds cut in). Troad: the original lidar surface, used for road surfaces.
export const T = (x, z) => heightFn(x, z);
export const Troad = (x, z) => roadFn(x, z);
export function setTerrain(fn, road = fn) { heightFn = fn || (() => 0); roadFn = road || (() => 0); }

// Triangle-interpolated height on a grid (cells split along B-D, matching the ground mesh).
export function sampleGrid(grid, meta, x, z) {
  const { step, minX, minZ, cols, rows } = meta;
  const fx = (x - minX) / step, fz = (z - minZ) / step;
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - c0)), tz = Math.max(0, Math.min(1, fz - r0));
  const i = r0 * cols + c0;
  const A = grid[i], D = grid[i + 1], B = grid[i + cols], C = grid[i + cols + 1];
  return tx + tz <= 1 ? A + (D - A) * tx + (B - A) * tz : C + (B - C) * (1 - tx) + (D - C) * (1 - tz);
}

// Road geometry shared with world.js (ribbons) and spatial.js (physics).
export const ROAD_STATION = 5; // m: road centerlines are subdivided at least this often
export const ROAD_SURFACE = 0.22; // road top above the original ground (0.07 road layer + 0.15 GROUND_LIFT)
// driveways / parking aisles: not drawn over the stylized ground (it already shows them), driven as ground
export const isMinorRoad = (r) => r.t === 'service' && (r.sv === 'parking_aisle' || r.sv === 'driveway');

// Cut road beds into the ground, just enough that it never shows through a road. Roads are drawn level
// across their width at the original lidar height of the centerline (sampled every ROAD_STATION m), so
// on side slopes, crests and grid creases the 10 m ground triangles can rise above the pavement. The
// drawn pavement (ribbons + junction discs) is sampled densely; wherever the ground comes within MARGIN
// of it, the three vertices of the ground triangle there are lowered (least change that fixes it).
// Lowering never raises ground anywhere else, so one pass fixes every sample.
export function carveRoadBeds(orig, meta, nodes, roads) {
  const { step, minX, minZ, cols, rows } = meta;
  const out = Float32Array.from(orig);
  const H = (x, z) => sampleGrid(orig, meta, x, z) + ROAD_SURFACE;
  const MARGIN = 0.06;
  const clampAt = (x, z, h) => {
    const fx = (x - minX) / step, fz = (z - minZ) / step;
    if (!(fx >= 0 && fz >= 0 && fx < cols - 1 && fz < rows - 1)) return;
    const c0 = Math.floor(fx), r0 = Math.floor(fz), tx = fx - c0, tz = fz - r0, i = r0 * cols + c0;
    let ia, ib, ic, wa, wb, wc;
    if (tx + tz <= 1) { ia = i; ib = i + 1; ic = i + cols; wa = 1 - tx - tz; wb = tx; wc = tz; }
    else { ia = i + cols + 1; ib = i + cols; ic = i + 1; wa = tx + tz - 1; wb = 1 - tx; wc = 1 - tz; }
    const excess = out[ia] * wa + out[ib] * wb + out[ic] * wc - (h - MARGIN);
    if (excess <= 0) return;
    const k = (excess + 1e-4) / (wa * wa + wb * wb + wc * wc);
    out[ia] -= k * wa; out[ib] -= k * wb; out[ic] -= k * wc;
  };
  const disc = (cx, cz, r, h) => {
    clampAt(cx, cz, h);
    for (const f of [0.5, 1]) for (let a = 0; a < 12; a++) clampAt(cx + Math.cos(a * Math.PI / 6) * r * f, cz + Math.sin(a * Math.PI / 6) * r * f, h);
  };
  const ends = new Map(); // node -> [hw of roads ending here, any non-minor?, count of incident roads, service-only]
  for (const r of roads) {
    r.nd.forEach((n, k) => {
      let e = ends.get(n);
      if (!e) ends.set(n, (e = { r: 0, end: false, count: 0, minorOnly: true, bridge: false, service: true }));
      e.count++;
      if (!isMinorRoad(r)) e.minorOnly = false;
      if (r.t !== 'service') e.service = false;
      if (r.dh) e.bridge = true;
      if (k === 0 || k === r.nd.length - 1) { e.end = true; e.r = Math.max(e.r, r.w / 2); }
    });
    if (r.b || r.dh || isMinorRoad(r)) continue;
    // stations exactly like world.js polyline()
    const pts = [];
    for (let i = 0; i < r.nd.length; i++) {
      const bx = nodes[r.nd[i] * 2], bz = nodes[r.nd[i] * 2 + 1];
      if (i > 0) {
        const ax = nodes[r.nd[i - 1] * 2], az = nodes[r.nd[i - 1] * 2 + 1];
        const steps = Math.floor(Math.hypot(bx - ax, bz - az) / ROAD_STATION);
        for (let k = 1; k <= steps; k++) { const t = k / (steps + 1); pts.push(ax + (bx - ax) * t, az + (bz - az) * t); }
      }
      pts.push(bx, bz);
    }
    const n = pts.length / 2, hw = r.w / 2;
    const h = new Float32Array(n);
    for (let i = 0; i < n; i++) h[i] = H(pts[i * 2], pts[i * 2 + 1]);
    let pnx = 0, pnz = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-3) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      // sharp bend at station i: world.js draws a level disc there
      if (i > 0) { const sx = pnx + nx, sz = pnz + nz, sl = Math.hypot(sx, sz); if (sl < 1e-4 || (sx * pnx + sz * pnz) / sl < 0.8) disc(ax, az, hw, h[i]); }
      pnx = nx; pnz = nz;
      const along = Math.max(2, Math.ceil(L / 2));
      for (let a = 0; a <= along; a++) {
        const u = a / along, x = ax + (bx - ax) * u, z = az + (bz - az) * u, hh = h[i] + (h[i + 1] - h[i]) * u;
        for (const v of [-1, -0.5, 0, 0.5, 1]) clampAt(x + nx * hw * v, z + nz * hw * v, hh);
      }
    }
  }
  // junction / end-cap discs (world.js buildRoads)
  for (const [n, e] of ends) {
    if (!e.end || e.bridge || e.minorOnly || (e.count === 1 && e.service)) continue;
    const x = nodes[n * 2], z = nodes[n * 2 + 1];
    disc(x, z, e.r, H(x, z));
  }
  return out;
}
let terrainMeta = null;
// raw grid access for building meshes on the exact grid points (null when no terrain)
export const terrainGrid = () => terrainMeta;

export async function loadTerrain(map, base = import.meta.env?.BASE_URL ?? '/') {
  const m = map.terrain;
  if (!m) return null;
  let grid;
  const res = await fetch(`${base}data/terrain.bin`).catch(() => null);
  if (res?.ok) grid = new Uint16Array(await res.arrayBuffer());
  else {
    // hosts that don't serve .bin files get the same grid as base64 inside JSON
    const alt = await fetch(`${base}data/terrain.b64.json`);
    if (!alt.ok) throw new Error(`terrain data HTTP ${res?.status ?? 'error'} / ${alt.status}`);
    const bin = atob((await alt.json()).data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    grid = new Uint16Array(bytes.buffer);
  }
  if (grid.length !== m.cols * m.rows) throw new Error('terrain.bin size mismatch');
  // meters relative to the spawn
  const off = m.minH - m.base;
  const orig = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) orig[i] = grid[i] * m.scale + off;
  const ground = carveRoadBeds(orig, m, map.nodes, map.roads);
  setTerrain((x, z) => sampleGrid(ground, m, x, z), (x, z) => sampleGrid(orig, m, x, z));
  terrainMeta = { ...m, ground };
  return { min: off };
}

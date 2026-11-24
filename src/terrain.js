// Real ground elevation (USGS 3DEP lidar, baked to a 10 m grid by scripts/terrain-build.mjs).
// T(x, z) = ground height in meters relative to the spawn point (0 when no terrain is loaded).
let heightFn = () => 0;
export const T = (x, z) => heightFn(x, z);
export function setTerrain(fn) { heightFn = fn || (() => 0); }

export async function loadTerrain(map, base = import.meta.env?.BASE_URL ?? '/') {
  const m = map.terrain;
  if (!m) return null;
  const res = await fetch(`${base}data/terrain.bin`);
  if (!res.ok) throw new Error(`terrain.bin HTTP ${res.status}`);
  const grid = new Uint16Array(await res.arrayBuffer());
  if (grid.length !== m.cols * m.rows) throw new Error('terrain.bin size mismatch');
  const { step, minX, minZ, cols, rows, scale } = m;
  const off = m.minH - m.base;
  const fn = (x, z) => {
    const fx = (x - minX) / step, fz = (z - minZ) / step;
    const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - c0)), tz = Math.max(0, Math.min(1, fz - r0));
    const i = r0 * cols + c0;
    const a = grid[i], b = grid[i + 1], c = grid[i + cols], d = grid[i + cols + 1];
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz) * scale + off;
  };
  setTerrain(fn);
  return { fn, min: off, max: off + 6553.5 };
}

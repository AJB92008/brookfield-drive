// Uniform-grid spatial indexes for road segments and building edges.

const KEY_OFFSET = 4096;
const key = (ix, iz) => (ix + KEY_OFFSET) * 8192 + (iz + KEY_OFFSET);

export class Grid {
  constructor(cell) {
    this.cell = cell;
    this.cells = new Map();
  }
  insertBox(minX, minZ, maxX, maxZ, id) {
    const c = this.cell;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c), z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = key(ix, iz);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(id);
      }
    }
  }
  // Calls fn(id) for each id in cells overlapping the box. Ids may repeat across cells.
  forBox(minX, minZ, maxX, maxZ, fn) {
    const c = this.cell;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c), z1 = Math.floor(maxZ / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.cells.get(key(ix, iz));
        if (arr) for (let i = 0; i < arr.length; i++) fn(arr[i]);
      }
    }
  }
}

// Closest point on segment AB to P; returns t in [0,1].
export function segT(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-9) return 0;
  const t = ((px - ax) * dx + (pz - az) * dz) / L2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class RoadIndex {
  constructor(map) {
    const { nodes, roads } = map;
    let count = 0;
    for (const r of roads) count += r.nd.length - 1;
    this.ax = new Float32Array(count);
    this.az = new Float32Array(count);
    this.bx = new Float32Array(count);
    this.bz = new Float32Array(count);
    this.road = new Int32Array(count);
    this.roads = roads;
    this.grid = new Grid(40);
    let s = 0;
    roads.forEach((r, ri) => {
      const hw = r.w / 2;
      for (let i = 0; i < r.nd.length - 1; i++, s++) {
        const a = r.nd[i], b = r.nd[i + 1];
        const ax = nodes[a * 2], az = nodes[a * 2 + 1], bx = nodes[b * 2], bz = nodes[b * 2 + 1];
        this.ax[s] = ax; this.az[s] = az; this.bx[s] = bx; this.bz[s] = bz; this.road[s] = ri;
        this.grid.insertBox(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, s);
      }
    });
    this.count = count;
    this._stamp = new Int32Array(count);
    this._q = 0;
  }

  // Nearest road segment to (x,z) within maxDist. filter(roadIdx) optional.
  nearest(x, z, maxDist = 30, filter = null) {
    let best = null, bestD = maxDist;
    const q = ++this._q;
    this.grid.forBox(x - maxDist, z - maxDist, x + maxDist, z + maxDist, (s) => {
      if (this._stamp[s] === q) return;
      this._stamp[s] = q;
      const ri = this.road[s];
      if (filter && !filter(this.roads[ri])) return;
      const t = segT(x, z, this.ax[s], this.az[s], this.bx[s], this.bz[s]);
      const px = this.ax[s] + (this.bx[s] - this.ax[s]) * t;
      const pz = this.az[s] + (this.bz[s] - this.az[s]) * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) {
        bestD = d;
        best = { seg: s, road: ri, dist: d, t, px, pz };
      }
    });
    if (best) {
      const s = best.seg;
      const dx = this.bx[s] - this.ax[s], dz = this.bz[s] - this.az[s];
      const L = Math.hypot(dx, dz) || 1;
      best.dirX = dx / L;
      best.dirZ = dz / L;
    }
    return best;
  }

  // Is (x,z) on any road surface? Prefers the road you're actually on (smallest dist - halfWidth).
  roadAt(x, z) {
    let best = null, bestScore = 0.4; // allow 0.4 m slack past the edge
    const q = ++this._q;
    this.grid.forBox(x, z, x, z, (s) => {
      if (this._stamp[s] === q) return;
      this._stamp[s] = q;
      const r = this.roads[this.road[s]];
      const t = segT(x, z, this.ax[s], this.az[s], this.bx[s], this.bz[s]);
      const d = Math.hypot(x - (this.ax[s] + (this.bx[s] - this.ax[s]) * t), z - (this.az[s] + (this.bz[s] - this.az[s]) * t));
      const score = d - r.w / 2;
      if (score < bestScore) {
        bestScore = score;
        best = this.road[s];
      }
    });
    return best; // road index or null
  }

  // Height of the drivable surface under (x,z) for something currently at height y.
  // Flat world for now; this is the single hook for adding bridges/elevation later.
  surfaceHeight(_x, _z, _y) {
    return 0;
  }
}

export class BuildingIndex {
  constructor(map) {
    const { buildings } = map;
    // Normalize every ring to CCW (positive signed area in x/z) so outward normal = (dz, -dx).
    let edgeCount = 0;
    this.rings = buildings.map((b) => {
      const p = b.p;
      let a = 0;
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
      }
      edgeCount += n;
      if (a >= 0) return p;
      const r = new Array(p.length);
      for (let i = 0; i < n; i++) {
        r[i * 2] = p[(n - 1 - i) * 2];
        r[i * 2 + 1] = p[(n - 1 - i) * 2 + 1];
      }
      return r;
    });
    this.ax = new Float32Array(edgeCount);
    this.az = new Float32Array(edgeCount);
    this.bx = new Float32Array(edgeCount);
    this.bz = new Float32Array(edgeCount);
    this.nx = new Float32Array(edgeCount);
    this.nz = new Float32Array(edgeCount);
    this.owner = new Int32Array(edgeCount);
    this.edgeGrid = new Grid(32);
    this.bboxGrid = new Grid(64);
    this.bbox = new Float32Array(buildings.length * 4);
    this.edgeStart = new Int32Array(buildings.length + 1);
    let e = 0;
    this.rings.forEach((p, bi) => {
      const n = p.length / 2;
      this.edgeStart[bi] = e;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++, e++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az) || 1;
        this.ax[e] = ax; this.az[e] = az; this.bx[e] = bx; this.bz[e] = bz;
        this.nx[e] = (bz - az) / L; this.nz[e] = -(bx - ax) / L;
        this.owner[e] = bi;
        this.edgeGrid.insertBox(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), e);
        if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
        if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
      }
      this.bbox.set([minX, minZ, maxX, maxZ], bi * 4);
      this.bboxGrid.insertBox(minX, minZ, maxX, maxZ, bi);
    });
    this.edgeStart[buildings.length] = e;
    this._stamp = new Int32Array(edgeCount);
    this._bstamp = new Int32Array(buildings.length);
    this._q = 0;
  }

  // Calls fn(edge) for building edges near the circle.
  forEdgesNear(x, z, r, fn) {
    const q = ++this._q;
    this.edgeGrid.forBox(x - r, z - r, x + r, z + r, (e) => {
      if (this._stamp[e] === q) return;
      this._stamp[e] = q;
      fn(e);
    });
  }

  // Index of the building containing (x,z), or -1.
  buildingAt(x, z) {
    let hit = -1;
    const q = ++this._q;
    this.bboxGrid.forBox(x, z, x, z, (bi) => {
      if (hit >= 0 || this._bstamp[bi] === q) return;
      this._bstamp[bi] = q;
      const b = this.bbox;
      if (x < b[bi * 4] || x > b[bi * 4 + 2] || z < b[bi * 4 + 1] || z > b[bi * 4 + 3]) return;
      if (pointInRing(x, z, this.rings[bi])) hit = bi;
    });
    return hit;
  }

  // Distance from (x,z) to the nearest building wall within r (Infinity if none).
  distToWall(x, z, r) {
    let best = Infinity;
    this.forEdgesNear(x, z, r, (e) => {
      const t = segT(x, z, this.ax[e], this.az[e], this.bx[e], this.bz[e]);
      const d = Math.hypot(x - (this.ax[e] + (this.bx[e] - this.ax[e]) * t), z - (this.az[e] + (this.bz[e] - this.az[e]) * t));
      if (d < best) best = d;
    });
    return best;
  }

  // Push a circle out of building walls. Returns {x, z, nx, nz, hit} with the summed push normal.
  resolveCircle(x, z, r) {
    let hit = false, sx = 0, sz = 0;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      // Center actually inside a footprint (e.g. thin wall tunnelled at speed): pop out through the nearest wall.
      const inside = this.buildingAt(x, z);
      if (inside >= 0) {
        let best = Infinity, bx = 0, bz = 0, bnx = 0, bnz = 0;
        for (let e = this.edgeStart[inside]; e < this.edgeStart[inside + 1]; e++) {
          const t = segT(x, z, this.ax[e], this.az[e], this.bx[e], this.bz[e]);
          const cx = this.ax[e] + (this.bx[e] - this.ax[e]) * t, cz = this.az[e] + (this.bz[e] - this.az[e]) * t;
          const d = Math.hypot(x - cx, z - cz);
          if (d < best) { best = d; bx = cx; bz = cz; bnx = this.nx[e]; bnz = this.nz[e]; }
        }
        x = bx + bnx * r; z = bz + bnz * r;
        sx += bnx; sz += bnz;
        hit = true;
        continue;
      }
      // Outside: plain circle-vs-segment push (radial at corners, so scraping past a corner is smooth).
      this.forEdgesNear(x, z, r, (e) => {
        const ax = this.ax[e], az = this.az[e], bx = this.bx[e], bz = this.bz[e];
        const t = segT(x, z, ax, az, bx, bz);
        const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
        const dx = x - cx, dz = z - cz;
        const d = Math.hypot(dx, dz);
        if (d >= r) return;
        let nx, nz;
        if (d < 1e-6) { nx = this.nx[e]; nz = this.nz[e]; } else { nx = dx / d; nz = dz / d; }
        x += nx * (r - d); z += nz * (r - d);
        sx += nx; sz += nz;
        hit = moved = true;
      });
      if (!moved) break;
    }
    const L = Math.hypot(sx, sz) || 1;
    return { x, z, nx: sx / L, nz: sz / L, hit };
  }
}

export function pointInRing(x, z, p) {
  let inside = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Simple point grid (trees) for circle collisions.
export class PointIndex {
  constructor(cell = 16) {
    this.grid = new Grid(cell);
    this.xs = [];
    this.zs = [];
    this.rs = [];
  }
  add(x, z, r) {
    const id = this.xs.length;
    this.xs.push(x); this.zs.push(z); this.rs.push(r);
    this.grid.insertBox(x, z, x, z, id);
  }
  forNear(x, z, r, fn) {
    this.grid.forBox(x - r, z - r, x + r, z + r, fn);
  }
}

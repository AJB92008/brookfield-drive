// Builds all static scenery meshes from the baked OSM map.
import * as THREE from 'three';
import { makeDetailTexture } from './textures.js';
import { Grid, pointInRing, PointIndex } from './spatial.js';

const TILE = 500; // meters; static geometry is merged per tile so frustum culling works

export const LAYER_Y = {
  farm: 0.01, reserve: 0.015, park: 0.02, golf: 0.02, forest: 0.025, wetland: 0.025,
  pitch: 0.03, water: 0.035, parking: 0.045, railBed: 0.05, road: 0.07, marking: 0.095, rail: 0.13,
};

const AREA_COLOR = {
  farm: 0x9aa86a, reserve: 0x77ad62, park: 0x7cb565, golf: 0x86c46c, forest: 0x4e7a40,
  wetland: 0x6b8d68, pitch: 0x6aa957, water: 0x4677a8, parking: 0x8b8c8c,
};

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const scale3 = (c, s) => [c[0] * s, c[1] * s, c[2] * s];

const WALLS = {
  h: [0xe6dccb, 0xd8d3cb, 0xc8b59a, 0xb9c3c9, 0xa96a52, 0xece8e1, 0x9aa38f, 0xc9c0ae, 0x8f9aa6].map(lin),
  g: [0x9c8f80, 0xb3aa9b, 0xc4bcae].map(lin),
  a: [0xc4a484, 0xa47a5c, 0xd8cfc2, 0xb6a998].map(lin),
  c: [0xd0c9bd, 0xbdb6aa, 0xdad0bf, 0xa9a59f, 0xc9bba3].map(lin),
  i: [0xb9b9b4, 0xa7abb1, 0xc9c4ba, 0x9da3a8].map(lin),
  p: [0xb27552, 0xc8b08d, 0xbfa88c].map(lin),
};
const ROOF_SLOPED = [0x4a4a4d, 0x5b4c42, 0x3e444a, 0x6a5e55, 0x55524f].map(lin);
const ROOF_FLAT = [0x8f8f8d, 0x9b9a96, 0x7f8184, 0xa6a39d].map(lin);

const WHITE = lin(0xf2f2ee);
const YELLOW = lin(0xe7bd34);

function hash01(i) {
  let x = (i + 1) * 0x9e3779b1;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- geometry accumulation ----------
class Geo {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }
  v(x, y, z, nx, ny, nz, c) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    if (c) this.col.push(c[0], c[1], c[2]);
  }
  // Horizontal triangle, wound so it faces up.
  flat(x1, z1, x2, z2, x3, z3, y, c) {
    if ((z2 - z1) * (x3 - x1) - (x2 - x1) * (z3 - z1) < 0) {
      let t = x2; x2 = x3; x3 = t; t = z2; z2 = z3; z3 = t;
    }
    this.v(x1, y, z1, 0, 1, 0, c); this.v(x2, y, z2, 0, 1, 0, c); this.v(x3, y, z3, 0, 1, 0, c);
  }
  // Arbitrary triangle with flat normal, wound so the normal has a positive dot with (hx,hy,hz).
  tri(a, b, c, col, hx, hy, hz, colB, colC) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    colB = colB || col; colC = colC || col;
    if (nx * hx + ny * hy + nz * hz < 0) {
      [b, c] = [c, b]; [colB, colC] = [colC, colB];
      nx = -nx; ny = -ny; nz = -nz;
    }
    this.v(a[0], a[1], a[2], nx, ny, nz, col);
    this.v(b[0], b[1], b[2], nx, ny, nz, colB);
    this.v(c[0], c[1], c[2], nx, ny, nz, colC);
  }
  disc(cx, cz, r, y, c, segs = 14) {
    for (let k = 0; k < segs; k++) {
      const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2;
      this.flat(cx, cz, cx + Math.cos(a0) * r, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, cz + Math.sin(a1) * r, y, c);
    }
  }
  toGeometry(uvScale = 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (uvScale) {
      const uv = new Float32Array((this.pos.length / 3) * 2);
      for (let i = 0, j = 0; i < this.pos.length; i += 3, j += 2) {
        uv[j] = this.pos[i] / uvScale;
        uv[j + 1] = this.pos[i + 2] / uvScale;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    g.computeBoundingSphere();
    return g;
  }
}

class Tiles {
  constructor(size = TILE) { this.size = size; this.map = new Map(); }
  at(x, z) {
    const k = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let g = this.map.get(k);
    if (!g) this.map.set(k, (g = new Geo()));
    return g;
  }
  addTo(group, material, { uvScale = 0, cast = false, receive = true, name = '' } = {}) {
    let tris = 0;
    for (const geo of this.map.values()) {
      if (!geo.pos.length) continue;
      const mesh = new THREE.Mesh(geo.toGeometry(uvScale), material);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.matrixAutoUpdate = false;
      mesh.name = name;
      group.add(mesh);
      tris += geo.pos.length / 9;
    }
    return tris;
  }
}

// ---------- polyline helpers ----------
// Precomputes per-vertex miter vectors and arc lengths for a road's centerline.
function polyline(pts) {
  const n = pts.length / 2;
  const sx = new Float32Array(n - 1), sz = new Float32Array(n - 1);
  const S = new Float32Array(n);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i * 2 + 2] - pts[i * 2], dz = pts[i * 2 + 3] - pts[i * 2 + 1];
    const L = Math.hypot(dx, dz) || 1e-6;
    sx[i] = dx / L; sz[i] = dz / L;
    S[i + 1] = S[i] + L;
  }
  // miter (unit offset to the right of travel direction; right normal of (dx,dz) is (-dz,dx))
  const mx = new Float32Array(n), mz = new Float32Array(n);
  const sharp = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      const s = i === 0 ? 0 : n - 2;
      mx[i] = -sz[s]; mz[i] = sx[s];
      continue;
    }
    const ax = -sz[i - 1], az = sx[i - 1], bx = -sz[i], bz = sx[i];
    let x = ax + bx, z = az + bz;
    const L = Math.hypot(x, z);
    if (L < 1e-4) { mx[i] = ax; mz[i] = az; sharp.push(i); continue; }
    x /= L; z /= L;
    const dot = x * ax + z * az;
    const s = 1 / Math.max(dot, 0.5);
    if (dot < 0.8) sharp.push(i);
    mx[i] = x * s; mz[i] = z * s;
  }
  return { pts, n, sx, sz, S, mx, mz, sharp, len: S[n - 1] };
}

function pointAt(pl, s, off) {
  const { pts, S, n } = pl;
  let i = 0;
  // binary search segment
  let lo = 0, hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (S[mid] <= s) lo = mid; else hi = mid - 1;
  }
  i = lo;
  const segL = S[i + 1] - S[i] || 1e-6;
  const t = Math.min(1, Math.max(0, (s - S[i]) / segL));
  const ax = pts[i * 2] + pl.mx[i] * off, az = pts[i * 2 + 1] + pl.mz[i] * off;
  const bx = pts[i * 2 + 2] + pl.mx[i + 1] * off, bz = pts[i * 2 + 3] + pl.mz[i + 1] * off;
  return [ax + (bx - ax) * t, az + (bz - az) * t, i];
}

function ribbon(tiles, pl, hw, y, c) {
  const { pts, n, mx, mz } = pl;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
    const g = tiles.at((ax + bx) / 2, (az + bz) / 2);
    const rax = ax + mx[i] * hw, raz = az + mz[i] * hw, lax = ax - mx[i] * hw, laz = az - mz[i] * hw;
    const rbx = bx + mx[i + 1] * hw, rbz = bz + mz[i + 1] * hw, lbx = bx - mx[i + 1] * hw, lbz = bz - mz[i + 1] * hw;
    g.flat(rax, raz, lax, laz, lbx, lbz, y, c);
    g.flat(rax, raz, lbx, lbz, rbx, rbz, y, c);
  }
  for (const i of pl.sharp) tiles.at(pts[i * 2], pts[i * 2 + 1]).disc(pts[i * 2], pts[i * 2 + 1], hw, y, c);
}

// Subtract sorted-or-not exclusion intervals from [a,b] pieces.
function subtract(pieces, excl) {
  if (!excl.length) return pieces;
  let out = pieces;
  for (const [ea, eb] of excl) {
    const next = [];
    for (const [a, b] of out) {
      if (eb <= a || ea >= b) { next.push([a, b]); continue; }
      if (ea > a) next.push([a, ea]);
      if (eb < b) next.push([eb, b]);
    }
    out = next;
  }
  return out;
}

// Painted line along a polyline at lateral offset `off` (+ = right of travel direction).
function paintLine(tiles, pl, off, width, color, y, { dash = 0, gap = 0, excl = [] } = {}) {
  const L = pl.len;
  let pieces = [];
  if (dash) {
    for (let s = gap / 2; s < L; s += dash + gap) pieces.push([s, Math.min(L, s + dash)]);
  } else pieces.push([0, L]);
  pieces = subtract(pieces, excl);
  const hw = width / 2;
  for (const [a, b] of pieces) {
    if (b - a < 0.3) continue;
    let s = a;
    while (s < b - 0.01) {
      const [x0, z0, i] = pointAt(pl, s + 0.001, off);
      const segEnd = Math.min(b, pl.S[i + 1]);
      const [x1, z1] = pointAt(pl, segEnd - 0.001, off);
      const nx = -pl.sz[i] * hw, nz = pl.sx[i] * hw;
      const g = tiles.at(x0, z0);
      g.flat(x0 + nx, z0 + nz, x0 - nx, z0 - nz, x1 - nx, z1 - nz, y, color);
      g.flat(x0 + nx, z0 + nz, x1 - nx, z1 - nz, x1 + nx, z1 + nz, y, color);
      if (segEnd <= s) break;
      s = segEnd;
    }
  }
}

const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const EDGE_LINED = /^(motorway|trunk|primary|secondary)(_link)?$/;

function markingPlan(r) {
  if (!(MAJOR.test(r.t) || r.t === 'unclassified') || r.w < 5) return [];
  const lines = [];
  const lanes = Math.max(1, r.l);
  if (r.o) {
    const laneW = Math.min(3.7, r.w / (lanes + 0.6));
    const half = (laneW * lanes) / 2;
    for (let k = 1; k < lanes; k++) lines.push({ off: -half + k * laneW, c: WHITE, dash: 3, gap: 9 });
    if (EDGE_LINED.test(r.t)) {
      lines.push({ off: -half, c: YELLOW });
      lines.push({ off: half, c: WHITE });
    }
  } else {
    if (lanes >= 2 && r.w >= 6.5) {
      lines.push({ off: -0.16, c: YELLOW });
      lines.push({ off: 0.16, c: YELLOW });
    }
    const per = Math.max(1, Math.floor(lanes / 2));
    const laneW = Math.min(3.6, r.w / (lanes + 0.5));
    for (let k = 1; k < per; k++) {
      lines.push({ off: k * laneW, c: WHITE, dash: 3, gap: 9 });
      lines.push({ off: -k * laneW, c: WHITE, dash: 3, gap: 9 });
    }
    if (EDGE_LINED.test(r.t)) {
      lines.push({ off: per * laneW, c: WHITE });
      lines.push({ off: -per * laneW, c: WHITE });
    }
  }
  return lines;
}

function buildRoads(map, group, mats) {
  const { nodes, roads } = map;
  const surface = new Tiles();
  const paint = new Tiles();
  const P = (r) => {
    const pts = new Array(r.nd.length * 2);
    r.nd.forEach((n, k) => { pts[k * 2] = nodes[n * 2]; pts[k * 2 + 1] = nodes[n * 2 + 1]; });
    return pts;
  };

  // node -> incident roads
  const inc = new Map();
  roads.forEach((r, ri) => r.nd.forEach((n, k) => {
    let a = inc.get(n);
    if (!a) inc.set(n, (a = []));
    a.push({ ri, end: k === 0 || k === r.nd.length - 1 });
  }));

  const polys = roads.map((r) => polyline(P(r)));

  // Surfaces: service roads first so major roads draw cleanly over them (same color anyway).
  roads.forEach((r, ri) => ribbon(surface, polys[ri], r.w / 2, LAYER_Y.road, null));

  // Junction / end-cap discs
  for (const [n, list] of inc) {
    let r = 0;
    let anyEnd = false;
    for (const e of list) if (e.end) { anyEnd = true; r = Math.max(r, roads[e.ri].w / 2); }
    if (!anyEnd) continue;
    if (list.length === 1 && roads[list[0].ri].t === 'service') continue; // driveway ends
    surface.at(nodes[n * 2], nodes[n * 2 + 1]).disc(nodes[n * 2], nodes[n * 2 + 1], r, LAYER_Y.road, null, 12);
  }

  // Markings
  roads.forEach((r, ri) => {
    const plan = markingPlan(r);
    if (!plan.length) return;
    const pl = polys[ri];
    if (pl.len < 12) return;
    const excl = [];
    r.nd.forEach((n, k) => {
      let rad = 0;
      for (const e of inc.get(n)) {
        if (e.ri === ri) continue;
        const o = roads[e.ri];
        if (o.t === 'service' && o.sv !== undefined && o.sv !== 'parking_aisle') continue;
        if (o.t === 'service' && r.t !== 'service' && !o.n) continue; // unnamed driveways/lots don't break lines
        rad = Math.max(rad, o.w / 2 + 1.5);
      }
      if (rad > 0) excl.push([pl.S[k] - rad, pl.S[k] + rad]);
    });
    for (const line of plan) {
      paintLine(paint, pl, line.off, 0.14, line.c, LAYER_Y.marking, { dash: line.dash, gap: line.gap, excl });
    }
  });

  const tris = surface.addTo(group, mats.road, { uvScale: 7, name: 'roads' }) + paint.addTo(group, mats.paint, { name: 'paint' });
  return { tris, polys };
}

function buildRails(map, group, mats) {
  const { nodes, rails } = map;
  const t = new Tiles();
  const bed = lin(0x7b7066), steel = lin(0x4a4847), ties = lin(0x5a4636);
  for (const nd of rails) {
    const pts = [];
    nd.forEach((n) => pts.push(nodes[n * 2], nodes[n * 2 + 1]));
    const pl = polyline(pts);
    ribbon(t, pl, 1.7, LAYER_Y.railBed, bed);
    paintLine(t, pl, 0, 2.5, ties, LAYER_Y.railBed + 0.02, { dash: 0.25, gap: 0.45 });
    paintLine(t, pl, -0.72, 0.1, steel, LAYER_Y.rail);
    paintLine(t, pl, 0.72, 0.1, steel, LAYER_Y.rail);
  }
  return t.addTo(group, mats.vertexColored, { name: 'rails' });
}

function buildAreas(map, group, mats) {
  const geo = new Geo();
  const toV2 = (p) => {
    const out = [];
    for (let i = 0; i < p.length; i += 2) out.push(new THREE.Vector2(p[i], p[i + 1]));
    return out;
  };
  let failed = 0;
  for (const a of map.areas) {
    const contour = toV2(a.p);
    const holes = (a.holes || []).filter((h) => pointInRing(h[0], h[1], a.p)).map(toV2);
    let faces;
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch {
      failed++;
      continue;
    }
    const verts = contour.concat(...holes);
    const y = LAYER_Y[a.k] ?? 0.02;
    const col = lin(AREA_COLOR[a.k] ?? AREA_COLOR.park);
    for (const [i, j, k] of faces) {
      geo.flat(verts[i].x, verts[i].y, verts[j].x, verts[j].y, verts[k].x, verts[k].y, y, col);
    }
  }
  const mesh = new THREE.Mesh(geo.toGeometry(9), mats.area);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'areas';
  group.add(mesh);
  return { tris: geo.pos.length / 9, failed };
}

function isConvex(p) {
  const n = p.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n, c = (i + 2) % n;
    const cross = (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[b * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[b * 2]);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function buildBuildings(map, bindex, group, mats) {
  const tiles = new Tiles();
  let failed = 0;
  map.buildings.forEach((b, bi) => {
    const p = bindex.rings[bi]; // CCW
    const n = p.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
    cx /= n; cz /= n;
    const g = tiles.at(cx, cz);
    const r1 = hash01(bi), r2 = hash01(bi + 777777);
    const pal = WALLS[b.k] || WALLS.c;
    const wall = pal[Math.floor(r1 * pal.length)];
    const wallLow = scale3(wall, 0.62);
    const h = b.h;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
    }
    area = Math.abs(area / 2);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const nx = (bz - az) / L, nz = -(bx - ax) / L;
      // (a0, b1, b0) and (a0, a1, b1) face outward for CCW rings
      g.v(ax, 0, az, nx, 0, nz, wallLow); g.v(bx, h, bz, nx, 0, nz, wall); g.v(bx, 0, bz, nx, 0, nz, wallLow);
      g.v(ax, 0, az, nx, 0, nz, wallLow); g.v(ax, h, az, nx, 0, nz, wall); g.v(bx, h, bz, nx, 0, nz, wall);
    }

    const sloped = (b.k === 'h' || b.k === 'g') && n <= 12 && isConvex(p);
    if (sloped) {
      const roof = ROOF_SLOPED[Math.floor(r2 * ROOF_SLOPED.length)];
      const rh = b.k === 'g' ? 0.9 : Math.min(3.2, 0.3 * Math.sqrt(area));
      const apex = [cx, h + rh, cz];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        g.tri([p[i * 2], h, p[i * 2 + 1]], [p[j * 2], h, p[j * 2 + 1]], apex, roof, 0, 1, 0);
      }
    } else {
      const roof = ROOF_FLAT[Math.floor(r2 * ROOF_FLAT.length)];
      const contour = [];
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
      let faces;
      try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch { faces = []; failed++; }
      for (const [i, j, k] of faces) {
        g.flat(contour[i].x, contour[i].y, contour[j].x, contour[j].y, contour[k].x, contour[k].y, h, roof);
      }
    }
  });
  const tris = tiles.addTo(group, mats.building, { cast: true, receive: true, name: 'buildings' });
  return { tris, failed };
}

// ---------- trees ----------
function buildTrees(map, roadIndex, bindex, group, mats, bounds) {
  const rand = mulberry32(20261123);
  const blockers = map.areas.filter((a) => a.k === 'water' || a.k === 'parking' || a.k === 'pitch');
  const blockGrid = new Grid(100);
  const blockBox = blockers.map((a, i) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < a.p.length; k += 2) {
      minX = Math.min(minX, a.p[k]); maxX = Math.max(maxX, a.p[k]);
      minZ = Math.min(minZ, a.p[k + 1]); maxZ = Math.max(maxZ, a.p[k + 1]);
    }
    blockGrid.insertBox(minX, minZ, maxX, maxZ, i);
    return [minX, minZ, maxX, maxZ];
  });
  const blocked = (x, z) => {
    let hit = false;
    blockGrid.forBox(x, z, x, z, (i) => {
      if (hit) return;
      const b = blockBox[i];
      if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInRing(x, z, blockers[i].p)) hit = true;
    });
    return hit;
  };
  const clear = (x, z) => {
    const near = roadIndex.nearest(x, z, 14);
    if (near && near.dist < map.roads[near.road].w / 2 + 2.5) return false;
    if (bindex.distToWall(x, z, 3.5) < 3.5) return false;
    if (bindex.buildingAt(x, z) >= 0) return false;
    if (blocked(x, z)) return false;
    return true;
  };

  const trees = []; // [x, z, scale, kind]
  // Dense trees in woods/forests, sparse in parks.
  for (const a of map.areas) {
    const density = a.k === 'forest' ? 1 / 140 : a.k === 'reserve' || a.k === 'wetland' ? 1 / 400 : a.k === 'park' || a.k === 'golf' ? 1 / 900 : 0;
    if (!density) continue;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, area = 0;
    const p = a.p;
    for (let k = 0, n = p.length / 2; k < n; k++) {
      const j = (k + 1) % n;
      area += p[k * 2] * p[j * 2 + 1] - p[j * 2] * p[k * 2 + 1];
      minX = Math.min(minX, p[k * 2]); maxX = Math.max(maxX, p[k * 2]);
      minZ = Math.min(minZ, p[k * 2 + 1]); maxZ = Math.max(maxZ, p[k * 2 + 1]);
    }
    const count = Math.min(2500, Math.round((Math.abs(area / 2) * density)));
    for (let t = 0, tries = 0; t < count && tries < count * 4; tries++) {
      const x = minX + rand() * (maxX - minX), z = minZ + rand() * (maxZ - minZ);
      if (!pointInRing(x, z, p) || !clear(x, z)) continue;
      trees.push([x, z, 0.8 + rand() * 0.6, rand() < (a.k === 'forest' ? 0.3 : 0.15) ? 1 : 0]);
      t++;
    }
  }
  const forestCount = trees.length;
  // Yard trees around houses (Brookfield is a leafy suburb).
  map.buildings.forEach((b, bi) => {
    if (b.k !== 'h') return;
    const p = bindex.rings[bi];
    let cx = 0, cz = 0;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
    cx /= n; cz /= n;
    const bb = bindex.bbox;
    const radius = Math.hypot(bb[bi * 4 + 2] - bb[bi * 4], bb[bi * 4 + 3] - bb[bi * 4 + 1]) / 2;
    const want = rand() < 0.75 ? (rand() < 0.45 ? 2 : 1) : 0;
    for (let t = 0, tries = 0; t < want && tries < 4; tries++) {
      const ang = rand() * Math.PI * 2, d = radius + 4 + rand() * 9;
      const x = cx + Math.cos(ang) * d, z = cz + Math.sin(ang) * d;
      if (!clear(x, z)) continue;
      trees.push([x, z, 0.8 + rand() * 0.6, rand() < 0.18 ? 1 : 0]);
      t++;
    }
  });
  const yardCount = trees.length - forestCount;
  // Trees scattered everywhere else.
  const SCATTER = 7000;
  for (let t = 0, tries = 0; t < SCATTER && tries < SCATTER * 6; tries++) {
    const x = bounds.minX + rand() * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + rand() * (bounds.maxZ - bounds.minZ);
    if (!clear(x, z)) continue;
    trees.push([x, z, 0.75 + rand() * 0.55, rand() < 0.12 ? 1 : 0]);
    t++;
  }

  // Per-1km-tile instanced meshes so far tiles get frustum culled.
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 3, 5, 1, true).translate(0, 1.5, 0);
  const leafGeo = new THREE.IcosahedronGeometry(2.6, 0).translate(0, 4.6, 0);
  const pineGeo = new THREE.ConeGeometry(2.1, 6.5, 7).translate(0, 5.0, 0);
  const buckets = new Map();
  for (const tr of trees) {
    const k = `${Math.floor(tr[0] / 1000)},${Math.floor(tr[1] / 1000)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(tr);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const leafColors = [0x4f7a3a, 0x5c8a3f, 0x45703a, 0x6b8f3e, 0x3f6634, 0x7a9440].map((h) => new THREE.Color(h));
  const pineColors = [0x2f5a3a, 0x355f3f, 0x2a4f35].map((h) => new THREE.Color(h));
  const points = new PointIndex(16);
  for (const list of buckets.values()) {
    const leafy = list.filter((t) => t[3] === 0), pines = list.filter((t) => t[3] === 1);
    const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, list.length);
    const leaves = new THREE.InstancedMesh(leafGeo, mats.leaf, Math.max(1, leafy.length));
    const pinesM = new THREE.InstancedMesh(pineGeo, mats.leaf, Math.max(1, pines.length));
    leaves.count = leafy.length;
    pinesM.count = pines.length;
    let li = 0, pi = 0;
    list.forEach((t, i) => {
      const [x, z, sc, kind] = t;
      q.setFromAxisAngle(up, hash01(Math.round(x * 7 + z * 13)) * Math.PI * 2);
      s.set(sc, sc * (kind ? 1.15 : 1), sc);
      pos.set(x, 0, z);
      m.compose(pos, q, s);
      trunks.setMatrixAt(i, m);
      if (kind === 0) {
        leaves.setMatrixAt(li, m);
        leaves.setColorAt(li++, leafColors[Math.floor(hash01(i * 31 + li) * leafColors.length)]);
      } else {
        pinesM.setMatrixAt(pi, m);
        pinesM.setColorAt(pi++, pineColors[Math.floor(hash01(i * 17 + pi) * pineColors.length)]);
      }
      points.add(x, z, 0.45 * sc);
    });
    for (const im of [trunks, leaves, pinesM]) {
      if (!im.count) continue;
      im.castShadow = true;
      im.receiveShadow = false;
      im.computeBoundingSphere();
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      group.add(im);
    }
  }
  return { count: trees.length, forestCount, yardCount, points };
}

// ---------- entry ----------
export async function buildWorld(map, roadIndex, bindex, scene, progress = async () => {}) {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  const detail = makeDetailTexture({ seed: 7 });
  const mats = {
    road: new THREE.MeshLambertMaterial({ color: 0x6a6c70, map: detail }),
    paint: new THREE.MeshLambertMaterial({ vertexColors: true }),
    area: new THREE.MeshLambertMaterial({ vertexColors: true, map: detail }),
    vertexColored: new THREE.MeshLambertMaterial({ vertexColors: true }),
    building: new THREE.MeshLambertMaterial({ vertexColors: true }),
    trunk: new THREE.MeshLambertMaterial({ color: 0x5a4130 }),
    leaf: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    ground: new THREE.MeshLambertMaterial({ color: 0x6f9a50, map: detail }),
  };

  const b = map.bounds;
  const margin = 2500;
  const gw = b.maxX - b.minX + margin * 2, gh = b.maxZ - b.minZ + margin * 2;
  const groundGeo = new THREE.PlaneGeometry(gw, gh, 1, 1).rotateX(-Math.PI / 2).translate((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  const gpos = groundGeo.attributes.position;
  const guv = groundGeo.attributes.uv;
  for (let i = 0; i < gpos.count; i++) guv.setXY(i, gpos.getX(i) / 11, gpos.getZ(i) / 11);
  const ground = new THREE.Mesh(groundGeo, mats.ground);
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  const stats = {};
  await progress('Laying down roads…');
  const roadsOut = buildRoads(map, group, mats);
  stats.roadTris = roadsOut.tris;
  stats.railTris = buildRails(map, group, mats);
  await progress('Planting parks & water…');
  const areas = buildAreas(map, group, mats);
  stats.areaTris = areas.tris; stats.areaFailed = areas.failed;
  await progress('Raising buildings…');
  const blds = buildBuildings(map, bindex, group, mats);
  stats.buildingTris = blds.tris; stats.buildingFailed = blds.failed;
  await progress('Growing trees…');
  const trees = buildTrees(map, roadIndex, bindex, group, mats, b);
  stats.trees = trees.count; stats.forestTrees = trees.forestCount; stats.yardTrees = trees.yardCount;
  stats.meshes = group.children.length;
  return { group, stats, treePoints: trees.points };
}

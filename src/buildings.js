// Detailed buildings: facade bays (windows/doors/garages/storefronts) from the facade texture array,
// gable/hip/pyramid roofs on houses, flat roofs with parapets + rooftop units on commercial buildings.
import * as THREE from 'three';
import { BAY_W, L, makeFacadeTexture, makeBuildingMaterial } from './facades.js';
import { pointInRing } from './spatial.js';

const TILE = 500;
const ROOF_V = 3.0; // roof texture repeat (m) up the slope

const hex = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
const PAINT = {
  siding: ['#ebe6da', '#d7d2c6', '#c9b89b', '#b7c2c8', '#9ea58f', '#d9cfb4', '#f3f1ea', '#8a96a3', '#c7b08a', '#a9b4a0', '#c2c7c9'].map(hex),
  brick: ['#a5573e', '#b86a4b', '#8e4a36', '#c27d5c', '#9b5d4a', '#b08a6e'].map(hex),
  stucco: ['#e8dcc4', '#d9c8a8', '#cfc3b0', '#e6e1d6', '#c8b9a0'].map(hex),
  retail: ['#d8d0c0', '#c9c1b2', '#e2dccf', '#bfb6a6', '#b5a48c', '#a7a39b'].map(hex),
  metal: ['#c9ccce', '#b8c0c6', '#d6d3cb', '#a9b2b8', '#c4bcae'].map(hex),
  concrete: ['#cfcfcb', '#bdbdb8', '#d8d4cc'].map(hex),
};
const ROOF_DEFAULT = { pitched: ['#4a4a4d', '#5b4c42', '#3e444a', '#6a5e55', '#55524f'].map(hex), flat: ['#a9a8a4', '#9b9a96', '#8f9194', '#b8b6b0'].map(hex) };
const WIN = { siding: L.SIDING_WIN, brick: L.BRICK_WIN, stucco: L.STUCCO_WIN };
const PLAIN = { siding: L.SIDING, brick: L.BRICK, stucco: L.STUCCO, retail: L.STUCCO, metal: L.METAL, concrete: L.STUCCO };

function hash01(i) {
  let x = (i + 1) * 0x9e3779b1;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];
const srgb = (rgb, k = 1) => { const c = new THREE.Color().setRGB(Math.min(1, (rgb[0] / 255) * k), Math.min(1, (rgb[1] / 255) * k), Math.min(1, (rgb[2] / 255) * k), THREE.SRGBColorSpace); return [c.r, c.g, c.b]; };
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

class FGeo {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.fac = []; }
  // Triangle with flat normal, wound to face along hint (hx,hy,hz). p = [x,y,z], uv = [u,v].
  tri(a, b, c, ua, ub, uc, layer, ca, cb, cc, hx, hy, hz) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (nx * hx + ny * hy + nz * hz < 0) {
      [b, c] = [c, b]; [ub, uc] = [uc, ub]; [cb, cc] = [cc, cb];
      nx = -nx; ny = -ny; nz = -nz;
    }
    for (const [p, uv, col] of [[a, ua, ca], [b, ub, cb], [c, uc, cc]]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(col[0], col[1], col[2]);
      this.fac.push(uv[0], uv[1], layer);
    }
  }
  // Vertical wall rectangle from (ax,az)->(bx,bz), y0..y1, u0..u1 across, v0..v1 up, facing (nx,nz).
  wall(ax, az, bx, bz, y0, y1, u0, u1, v0, v1, layer, col, nx, nz, aoBottom = false) {
    const cb = aoBottom ? shade(col, 0.72) : col;
    const a0 = [ax, y0, az], b0 = [bx, y0, bz], a1 = [ax, y1, az], b1 = [bx, y1, bz];
    this.tri(a0, b0, b1, [u0, v0], [u1, v0], [u1, v1], layer, cb, cb, col, nx, 0, nz);
    this.tri(a0, b1, a1, [u0, v0], [u1, v1], [u0, v1], layer, cb, col, col, nx, 0, nz);
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('facade', new THREE.Float32BufferAttribute(this.fac, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------- footprint geometry helpers ----------
function hull(p) {
  const pts = [];
  for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Minimum-area bounding rectangle: center, long axis (ux,uz), half extents A (long) >= B (short).
function obb(p) {
  const h = hull(p);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [x0, z0] = h[i], [x1, z1] = h[(i + 1) % h.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of h) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  let { ux, uz } = best;
  let A = (best.maxU - best.minU) / 2, B = (best.maxV - best.minV) / 2;
  const cu = (best.maxU + best.minU) / 2, cv = (best.maxV + best.minV) / 2;
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  if (B > A) { [A, B] = [B, A]; [ux, uz] = [-uz, ux]; }
  return { cx, cz, ux, uz, A, B, area: best.area };
}

function ringArea(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  return a / 2;
}

function isConvex(p) {
  const n = p.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n, c = (i + 2) % n;
    const cr = (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[b * 2 + 1]) - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[b * 2]);
    if (Math.abs(cr) < 1e-6) continue;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// ---------- roofs ----------
// Gable (hip=false) or hip roof over an oriented rectangle. Gable ends get wall-textured triangles.
function pitchedRoof(g, o, h, rise, roofCol, wallLayer, wallCol, hip, floorH) {
  const { cx, cz, ux, uz, A, B } = o;
  const ov = 0.35; // eave overhang
  const vx = -uz, vz = ux; // short axis
  const P = (s, t, y) => [cx + ux * s + vx * t, y, cz + uz * s + vz * t];
  const he = h - (ov * rise) / B, hr = h + rise;
  const slope = Math.hypot(B + ov, rise + (ov * rise) / B);
  const Ae = A + ov, Be = B + ov;
  const ridge = hip ? Math.max(0, A - B) : Ae;
  // two long roof planes
  for (const side of [1, -1]) {
    const e0 = P(-Ae, side * Be, he), e1 = P(Ae, side * Be, he), r1 = P(ridge, 0, hr), r0 = P(-ridge, 0, hr);
    const hx = vx * side, hz = vz * side;
    const U = (s) => s / BAY_W;
    g.tri(e0, e1, r1, [U(-Ae), 0], [U(Ae), 0], [U(ridge), slope / ROOF_V], L.SHINGLE, roofCol, roofCol, roofCol, hx, 1, hz);
    if (ridge > 0.01) g.tri(e0, r1, r0, [U(-Ae), 0], [U(ridge), slope / ROOF_V], [U(-ridge), slope / ROOF_V], L.SHINGLE, roofCol, roofCol, roofCol, hx, 1, hz);
  }
  for (const end of [1, -1]) {
    if (hip) {
      // hip end triangle
      const e0 = P(end * Ae, -Be, he), e1 = P(end * Ae, Be, he), r = P(end * ridge, 0, hr);
      const sl = Math.hypot(Ae - ridge, hr - he);
      g.tri(e0, e1, r, [-Be / BAY_W, 0], [Be / BAY_W, 0], [0, sl / ROOF_V], L.SHINGLE, roofCol, roofCol, roofCol, ux * end, 1, uz * end);
    } else {
      // gable end wall triangle in the wall plane
      const a = P(end * A, -B, h), b = P(end * A, B, h), c = P(end * A, 0, hr);
      g.tri(a, b, c, [0, 0], [(2 * B) / BAY_W, 0], [B / BAY_W, rise / floorH], wallLayer, wallCol, wallCol, wallCol, ux * end, 0, uz * end);
    }
  }
}

function pyramidRoof(g, p, h, rise, roofCol) {
  const n = p.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
  cx /= n; cz /= n;
  const apex = [cx, h + rise, cz];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [p[i * 2], h, p[i * 2 + 1]], b = [p[j * 2], h, p[j * 2 + 1]];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    // distance from apex foot to edge = slope run
    const ex = b[0] - a[0], ez = b[2] - a[2];
    const t = ((cx - a[0]) * ex + (cz - a[2]) * ez) / (len * len || 1);
    const fx = a[0] + ex * t, fz = a[2] + ez * t;
    const sl = Math.hypot(Math.hypot(cx - fx, cz - fz), rise);
    g.tri(a, b, apex, [0, 0], [len / BAY_W, 0], [(t * len) / BAY_W, sl / ROOF_V], L.SHINGLE, roofCol, roofCol, roofCol, 0, 1, 0);
  }
}

function flatRoof(g, p, y, roofCol) {
  const contour = [];
  for (let i = 0; i < p.length; i += 2) contour.push(new THREE.Vector2(p[i], p[i + 1]));
  let faces;
  try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch { return false; }
  for (const [i, j, k] of faces) {
    const a = contour[i], b = contour[j], c = contour[k];
    g.tri([a.x, y, a.y], [b.x, y, b.y], [c.x, y, c.y], [a.x / BAY_W, a.y / ROOF_V], [b.x / BAY_W, b.y / ROOF_V], [c.x / BAY_W, c.y / ROOF_V], L.FLATROOF, roofCol, roofCol, roofCol, 0, 1, 0);
  }
  return true;
}

function box(g, cx, cz, w, d, y0, y1, rot, layer, col) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (x, z) => [cx + x * c - z * s, cz + x * s + z * c];
  const corners = [P(-w / 2, -d / 2), P(w / 2, -d / 2), P(w / 2, d / 2), P(-w / 2, d / 2)];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const ex = bx - ax, ez = bz - az, len = Math.hypot(ex, ez);
    // outward normal for a CCW-in-(x,z) square: (ez,-ex); our corner order may be CW so test vs center
    let nx = ez / len, nz = -ex / len;
    if (nx * ((ax + bx) / 2 - cx) + nz * ((az + bz) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
    g.wall(ax, az, bx, bz, y0, y1, 0, len / BAY_W, 0, (y1 - y0) / 3, layer, col, nx, nz);
  }
  const [k0, k1, k2, k3] = corners;
  g.tri([k0[0], y1, k0[1]], [k1[0], y1, k1[1]], [k2[0], y1, k2[1]], [0, 0], [1, 0], [1, 1], layer, col, col, col, 0, 1, 0);
  g.tri([k0[0], y1, k0[1]], [k2[0], y1, k2[1]], [k3[0], y1, k3[1]], [0, 0], [1, 1], [0, 1], layer, col, col, col, 0, 1, 0);
}

// ---------- per-building style ----------
function styleOf(b, r, area, commercial) {
  // big boxes with mapped businesses are stores, not warehouses
  const k = commercial && b.k === 'i' ? 'c' : b.k;
  switch (k) {
    case 'h': { const m = r < 0.62 ? 'siding' : r < 0.86 ? 'brick' : 'stucco'; return { kind: 'house', mat: m, paint: pick(PAINT[m], hash01(r * 1e6)), floorH: 2.9, roof: 'pitched' }; }
    case 'g': return { kind: 'garage', mat: 'siding', paint: pick(PAINT.siding, r), floorH: 2.7, roof: 'pitched' };
    case 'a': { const m = r < 0.5 ? 'brick' : 'siding'; return { kind: 'apartment', mat: m, paint: pick(PAINT[m], hash01(r * 7e5)), floorH: 3.0, roof: area < 1800 ? 'pitched' : 'flat' }; }
    case 'p': return { kind: 'public', mat: 'brick', paint: pick(PAINT.brick, r), floorH: 3.8, roof: 'flat' };
    case 'i': return { kind: 'industrial', mat: 'metal', paint: pick(PAINT.metal, r), floorH: 5, roof: 'flat' };
    default: {
      if (b.h > 12) return { kind: 'office', mat: r < 0.5 ? 'glass' : 'ribbon', paint: pick(PAINT.concrete, r), floorH: 3.6, roof: 'flat' };
      const m = r < 0.45 ? 'stucco' : r < 0.75 ? 'brick' : 'retail';
      return { kind: 'retail', mat: m, paint: pick(m === 'brick' ? PAINT.brick : PAINT.retail, hash01(r * 3e5)), floorH: 4.2, roof: 'flat' };
    }
  }
}

export function buildBuildings(map, bindex, roadIndex, group, commercialSet = new Set()) {
  const tex = makeFacadeTexture();
  const material = makeBuildingMaterial(tex);
  const tiles = new Map();
  const geoAt = (x, z) => {
    const k = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
    let g = tiles.get(k);
    if (!g) tiles.set(k, (g = new FGeo()));
    return g;
  };
  const fronts = []; // street-facing wall per building (used for business signs)
  let failed = 0;
  const stats = { gable: 0, hip: 0, pyramid: 0, flat: 0 };

  map.buildings.forEach((b, bi) => {
    const p = bindex.rings[bi]; // CCW
    const n = p.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += p[i * 2]; cz += p[i * 2 + 1]; }
    cx /= n; cz /= n;
    const g = geoAt(cx, cz);
    const r1 = hash01(bi), r2 = hash01(bi + 777777), r3 = hash01(bi + 31337);
    const area = Math.abs(ringArea(p));
    const st = styleOf(b, r1, area, commercialSet.has(bi));
    const h = b.h;
    const flat = st.roof === 'flat';
    const parapet = flat ? (st.kind === 'office' ? 1.2 : 0.9) : 0;
    const wallTop = h + parapet;

    // which wall faces the street
    const near = roadIndex.nearest(cx, cz, 90, (r) => r.t !== 'service' || !!r.n);
    let dirX = 0, dirZ = 0;
    if (near) { const d = Math.hypot(near.px - cx, near.pz - cz) || 1; dirX = (near.px - cx) / d; dirZ = (near.pz - cz) / d; }
    let front = -1, frontScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = p[j * 2] - p[i * 2], ez = p[j * 2 + 1] - p[i * 2 + 1];
      const len = Math.hypot(ex, ez);
      if (len < 2) continue;
      const nx = ez / len, nz = -ex / len;
      const facing = near ? nx * dirX + nz * dirZ : 0;
      const score = (near ? facing * 2 : 0) + Math.min(len, 20) / 20;
      if (facing > 0.35 || !near) { if (score > frontScore) { frontScore = score; front = i; } }
    }

    // walls
    const groundH = Math.min(h, st.kind === 'retail' || st.kind === 'industrial' ? 4.2 : st.floorH);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const nx = (bz - az) / len, nz = -(bx - ax) / len;
      const isFront = i === front;
      const nb = Math.max(1, Math.round(len / BAY_W));
      const col = st.paint;
      const small = len < 2.4 || h < 2.6;
      let upperLayer, groundLayers = null;
      switch (st.kind) {
        case 'house': case 'apartment': case 'public':
          upperLayer = small ? PLAIN[st.mat] : (r3 < 0.15 && !isFront ? PLAIN[st.mat] : WIN[st.mat]);
          if (isFront && st.kind === 'house' && nb >= 2) {
            // garage door(s) at one end, front door next to it, windows elsewhere
            const garages = nb >= 4 ? 2 : 1;
            groundLayers = Array.from({ length: nb }, (_, k) => (k < garages ? L.GARAGE : k === garages ? L.DOOR : WIN[st.mat]));
            if (r2 < 0.5) groundLayers.reverse();
          } else if (isFront && st.kind !== 'house') {
            groundLayers = Array.from({ length: nb }, (_, k) => (k === Math.floor(nb / 2) ? L.DOOR : WIN[st.mat]));
          }
          break;
        case 'garage':
          upperLayer = PLAIN.siding;
          if (isFront && len >= 2.8) groundLayers = Array.from({ length: nb }, () => L.GARAGE);
          break;
        case 'retail':
          upperLayer = PLAIN[st.mat] ?? L.STUCCO;
          if (st.mat === 'brick' && !isFront) upperLayer = r3 < 0.5 ? L.BRICK : L.BRICK_WIN;
          if (isFront) groundLayers = Array.from({ length: nb }, () => L.STOREFRONT);
          break;
        case 'office':
          upperLayer = st.mat === 'glass' ? L.GLASS : L.RIBBON;
          if (isFront) groundLayers = Array.from({ length: nb }, (_, k) => (k === Math.floor(nb / 2) ? L.STOREFRONT : upperLayer));
          break;
        case 'industrial':
          upperLayer = L.METAL;
          if (isFront && area < 4000 && nb >= 3) groundLayers = Array.from({ length: nb }, (_, k) => (k === 1 ? L.STOREFRONT : L.METAL));
          else if (!isFront && r3 < 0.4 && nb >= 4) groundLayers = Array.from({ length: nb }, (_, k) => (k % 3 === 1 ? L.DOCK : L.METAL));
          break;
      }
      const fh = st.floorH;
      if (groundLayers && groundH > 1.5) {
        // ground floor, one quad per bay so each bay can be a different layer
        for (let k = 0; k < nb; k++) {
          const t0 = k / nb, t1 = (k + 1) / nb;
          g.wall(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, 0, groundH, 0, 1, 0, 1, groundLayers[k], col, nx, nz, true);
        }
        if (wallTop > groundH + 0.01) g.wall(ax, az, bx, bz, groundH, wallTop, 0, nb, 0, (wallTop - groundH) / fh, upperLayer, col, nx, nz);
      } else {
        g.wall(ax, az, bx, bz, 0, wallTop, 0, nb, 0, wallTop / fh, upperLayer, col, nx, nz, true);
      }
      if (isFront) fronts.push({ bi, ax, az, bx, bz, nx, nz, len, groundH, h, kind: st.kind });
    }

    // roof
    const roofRGB = b.rc ? srgb(b.rc, flat ? 1.05 : 1.2) : (flat ? pick(ROOF_DEFAULT.flat, r2) : pick(ROOF_DEFAULT.pitched, r2));
    let done = false;
    if (!flat) {
      const o = obb(p);
      const fill = o ? area / (4 * o.A * o.B) : 0;
      if (o && o.B > 1 && fill > 0.7 && n <= 24) {
        const rise = Math.min(4.5, o.B * (st.kind === 'garage' ? 0.4 : 0.58));
        const hip = r2 < 0.42 && o.A - o.B > 0.5;
        pitchedRoof(g, o, h, rise, roofRGB, PLAIN[st.mat] ?? L.SIDING, st.paint, hip, st.floorH);
        stats[hip ? 'hip' : 'gable']++;
        done = true;
      } else if (n <= 14 && isConvex(p)) {
        pyramidRoof(g, p, h, Math.min(3.2, 0.3 * Math.sqrt(area)), roofRGB);
        stats.pyramid++;
        done = true;
      }
    }
    if (!done) {
      if (!flatRoof(g, p, h, roofRGB)) failed++;
      stats.flat++;
      // rooftop units on big flat roofs
      if (flat && area > 450) {
        const count = Math.min(7, Math.floor(area / 650));
        const bb = bindex.bbox;
        const unit = shade(pick(PAINT.metal, r3), 0.95);
        for (let k = 0, tries = 0; k < count && tries < count * 6; tries++) {
          const ux = bb[bi * 4] + hash01(bi * 13 + tries) * (bb[bi * 4 + 2] - bb[bi * 4]);
          const uz = bb[bi * 4 + 1] + hash01(bi * 17 + tries + 5) * (bb[bi * 4 + 3] - bb[bi * 4 + 1]);
          const w = 1.8 + hash01(bi + tries * 3) * 2.2, d = 1.4 + hash01(bi + tries * 7) * 1.8;
          if (!pointInRing(ux, uz, p) || bindex.distToWall(ux, uz, 4) < 3.5) continue;
          box(g, ux, uz, w, d, h, h + 1 + hash01(bi + tries) * 0.9, hash01(bi * 3 + tries) * Math.PI, L.METAL, unit);
          k++;
        }
      }
    }
  });

  let tris = 0;
  for (const geo of tiles.values()) {
    if (!geo.pos.length) continue;
    const mesh = new THREE.Mesh(geo.toGeometry(), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'buildings';
    group.add(mesh);
    tris += geo.pos.length / 9;
  }
  return { tris, failed, fronts, roofs: stats };
}

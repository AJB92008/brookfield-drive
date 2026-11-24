// Business name signs on storefronts, from OSM named places (shops, restaurants, offices...).
// Text only (no logos): colored panel + lettering from a shared text atlas.
import * as THREE from 'three';
import { pointInRing } from './spatial.js';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const PANELS = [
  ['#b3202a', '#ffffff'], ['#1d3e74', '#ffffff'], ['#f2f2ee', '#1c1c1c'], ['#1f1f1f', '#ffffff'], ['#0f6b3a', '#ffffff'],
  ['#6d1f3b', '#f4e7c8'], ['#e3b52c', '#1c1c1c'], ['#2c5d8f', '#ffffff'], ['#4a3b2f', '#f0e6d2'], ['#ffffff', '#b3202a'],
];
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

function textAtlas(names) {
  const CW = 256, CH = 32, COLS = 16;
  const rows = Math.ceil(names.length / COLS);
  const W = CW * COLS, H = Math.max(CH, rows * CH);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const aspect = [];
  names.forEach((n, i) => {
    const x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH;
    let size = 24;
    ctx.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
    let w = ctx.measureText(n).width;
    if (w > CW - 10) { size = Math.max(10, Math.floor((size * (CW - 10)) / w)); ctx.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`; w = ctx.measureText(n).width; }
    ctx.fillText(n, x + CW / 2, y + CH / 2 + 1);
    aspect.push({ uw: Math.min(CW, w + 14), size });
  });
  const img = ctx.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(W * H * 2);
  for (let i = 0, j = 0; i < W * H; i++, j += 2) {
    const y = Math.floor(i / W), x = i % W;
    data[j] = data[j + 1] = img[((H - 1 - y) * W + x) * 4 + 3];
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { tex, CW, CH, COLS, W, H, aspect };
}

function ringArea(bindex, bi) {
  const p = bindex.rings[bi];
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  return Math.abs(a / 2);
}
function edgeDistOf(bindex, bi, x, z) {
  const p = bindex.rings[bi];
  let best = Infinity;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
}

// Named places -> the (non-house) building they're in or next to. Map<buildingIndex, poi[]>
export function assignPois(map, bindex) {
  const byBuilding = new Map();
  for (const poi of map.pois || []) {
    let bi = bindex.buildingAt(poi.x, poi.z);
    if (bi < 0) {
      let best = 28;
      bindex.bboxGrid.forBox(poi.x - 28, poi.z - 28, poi.x + 28, poi.z + 28, (b) => {
        const d = edgeDistOf(bindex, b, poi.x, poi.z);
        if (d < best) { best = d; bi = b; }
      });
    }
    if (bi < 0) continue;
    const k = map.buildings[bi].k;
    if (k === 'h' || k === 'g') continue; // home businesses: no storefront
    if (!byBuilding.has(bi)) byBuilding.set(bi, []);
    const list = byBuilding.get(bi);
    if (!list.some((q) => q.n === poi.n)) list.push(poi);
  }
  return byBuilding;
}

export function buildSigns(map, bindex, fronts, group, assigned = assignPois(map, bindex)) {
  if (!map.pois?.length) return null;
  const frontOf = new Map(fronts.map((f) => [f.bi, f]));
  const area = (bi) => {
    const p = bindex.rings[bi];
    let a = 0;
    for (let i = 0, n = p.length / 2; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
    return Math.abs(a / 2);
  };
  const edgeDist = (bi, x, z) => {
    const p = bindex.rings[bi];
    let best = Infinity;
    for (let i = 0, n = p.length / 2; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
      best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
    }
    return best;
  };

  const byBuilding = new Map([...assigned].filter(([bi]) => frontOf.has(bi)));
  const names = [], nameIdx = new Map();
  const nid = (s) => { if (!nameIdx.has(s)) { nameIdx.set(s, names.length); names.push(s); } return nameIdx.get(s); };
  const signs = []; // { f, t, w, h, y, n }
  for (const [bi, list] of byBuilding) {
    const f = frontOf.get(bi);
    const big = area(bi) > 9000;
    let pois = list;
    if (big) {
      // malls: the building's own name + stores that sit on an exterior wall
      pois = list.filter((p) => p.w === 1 && /mall|department_store/.test(p.k)).concat(list.filter((p) => edgeDist(bi, p.x, p.z) < 15)).slice(0, 6);
      if (!pois.length) pois = list.slice(0, 1);
    }
    const ex = f.bx - f.ax, ez = f.bz - f.az;
    const proj = pois.map((p) => ({ p, t: Math.max(0.08, Math.min(0.92, ((p.x - f.ax) * ex + (p.z - f.az) * ez) / (f.len * f.len))) })).sort((a, b) => a.t - b.t);
    if (proj.length === 1) proj[0].t = 0.5;
    const large = f.kind === 'office' || f.kind === 'industrial' || big;
    const h = large ? 1.5 : 0.8;
    const slot = f.len / Math.max(1, proj.length);
    let lastEnd = -Infinity;
    for (const { p, t } of proj) {
      const n = p.n.length > 34 ? p.n.slice(0, 33) + '…' : p.n;
      const id = nid(n);
      const w = Math.min(large ? 14 : 7, Math.max(1.6, h * 0.85 * Math.max(5, n.length) * 0.62), slot * 0.9);
      let center = t * f.len;
      if (center - w / 2 < lastEnd + 0.4) center = lastEnd + 0.4 + w / 2;
      if (center + w / 2 > f.len - 0.2) continue;
      lastEnd = center + w / 2;
      const y = large ? Math.min(f.h - h / 2 - 0.4, Math.max(f.groundH + 1.2, f.h * 0.72)) : Math.max(1.8, f.groundH - 0.42);
      signs.push({ f, c: center, w, h, y, id, key: n });
    }
  }
  if (!signs.length) return null;

  const atlas = textAtlas(names);
  const pPos = [], pCol = [], tPos = [], tUv = [], tCol = [];
  for (const s of signs) {
    const { f } = s;
    const ux = (f.bx - f.ax) / f.len, uz = (f.bz - f.az) / f.len;
    const off = 0.08;
    const P = (along, up, o) => [f.ax + ux * along + f.nx * o, up + (f.base || 0), f.az + uz * along + f.nz * o];
    const [bg, fg] = PANELS[Math.floor(hash(s.key) * PANELS.length)];
    const bgc = lin(bg), fgc = lin(fg);
    const a0 = s.c - s.w / 2, a1 = s.c + s.w / 2, y0 = s.y - s.h / 2, y1 = s.y + s.h / 2;
    // panel (facing outward: wall normal). Wall edge runs a->b with outward normal (nx,nz); seen from
    // outside, "along" increases to the viewer's LEFT, so text runs from a1 (left) to a0 (right).
    const panel = [P(a1, y0, off), P(a0, y0, off), P(a0, y1, off), P(a1, y0, off), P(a0, y1, off), P(a1, y1, off)];
    panel.forEach((v) => { pPos.push(...v); pCol.push(...bgc); });
    // text: fit the atlas cell's used width into the panel keeping the aspect ratio
    const col = s.id % atlas.COLS, row = Math.floor(s.id / atlas.COLS);
    const uw = atlas.aspect[s.id].uw;
    const textH = s.h * 0.78, textW = Math.min(s.w * 0.94, (textH * uw) / atlas.CH);
    const tc = s.c, ta0 = tc - textW / 2, ta1 = tc + textW / 2, ty0 = s.y - textH / 2, ty1 = s.y + textH / 2;
    const u0 = (col * atlas.CW + (atlas.CW - uw) / 2) / atlas.W, u1 = (col * atlas.CW + (atlas.CW + uw) / 2) / atlas.W;
    const vT = 1 - (row * atlas.CH) / atlas.H, vB = 1 - ((row + 1) * atlas.CH) / atlas.H;
    const tq = [P(ta1, ty0, off + 0.01), P(ta0, ty0, off + 0.01), P(ta0, ty1, off + 0.01), P(ta1, ty0, off + 0.01), P(ta0, ty1, off + 0.01), P(ta1, ty1, off + 0.01)];
    const tu = [[u0, vB], [u1, vB], [u1, vT], [u0, vB], [u1, vT], [u0, vT]];
    tq.forEach((v, i) => { tPos.push(...v); tUv.push(...tu[i]); tCol.push(...fgc); });
  }
  const out = new THREE.Group();
  out.name = 'business-signs';
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
  pg.setAttribute('color', new THREE.Float32BufferAttribute(pCol, 3));
  pg.computeVertexNormals();
  const panels = new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(tUv, 2));
  tg.setAttribute('color', new THREE.Float32BufferAttribute(tCol, 3));
  const text = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, alphaMap: atlas.tex, alphaTest: 0.4, side: THREE.DoubleSide }));
  for (const m of [panels, text]) { m.matrixAutoUpdate = false; out.add(m); }
  group.add(out);
  const where = signs.map((s) => {
    const ux = (s.f.bx - s.f.ax) / s.f.len, uz = (s.f.bz - s.f.az) / s.f.len;
    return { name: names[s.id], x: s.f.ax + ux * s.c, z: s.f.az + uz * s.c, nx: s.f.nx, nz: s.f.nz };
  });
  return { count: signs.length, buildings: byBuilding.size, names: names.length, where };
}

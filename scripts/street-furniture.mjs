// Places street furniture from OSM tags at build time (positions/orientations only; the client renders).
//   signals:    traffic signals clustered per intersection, one mast-arm pole per approach
//   stops:      stop signs on the right side of each approach to a highway=stop node
//   crosswalks: painted crosswalks at marked crossing nodes
//   lights:     cobra-head streetlights along arterials + OSM street_lamp nodes
//   streetSigns: green street-name blades at intersections of differently named roads
//   sidewalks:  footway=sidewalk polylines
import { RoadIndex } from '../src/spatial.js';

const RANK = {
  motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6, motorway_link: 5, trunk_link: 5, primary_link: 5,
  secondary_link: 5, tertiary_link: 5, unclassified: 4, residential: 3, road: 3, living_street: 2, service: 1,
};
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const ABBR = [
  [/\bNorth\b/g, 'N'], [/\bSouth\b/g, 'S'], [/\bEast\b/g, 'E'], [/\bWest\b/g, 'W'],
  [/\bStreet\b/g, 'St'], [/\bRoad\b/g, 'Rd'], [/\bAvenue\b/g, 'Ave'], [/\bDrive\b/g, 'Dr'], [/\bCourt\b/g, 'Ct'],
  [/\bLane\b/g, 'Ln'], [/\bBoulevard\b/g, 'Blvd'], [/\bCircle\b/g, 'Cir'], [/\bPlace\b/g, 'Pl'], [/\bParkway\b/g, 'Pkwy'],
  [/\bTrail\b/g, 'Trl'], [/\bTerrace\b/g, 'Ter'], [/\bHighway\b/g, 'Hwy'], [/\bPoint\b/g, 'Pt'], [/\bCrossing\b/g, 'Xing'],
];
export const abbreviate = (n) => ABBR.reduce((s, [re, to]) => s.replace(re, to), n);

export function computeFurniture({ nodes, roads, nodeTags, lamps, sidewalks }) {
  const roadIndex = new RoadIndex({ nodes, roads });
  const X = (n) => nodes[n * 2], Z = (n) => nodes[n * 2 + 1];
  const drivable = (r) => r.t !== 'service';
  const onDriveSurface = (x, z) => { const ri = roadIndex.roadAt(x, z); return ri !== null && roads[ri].t !== 'service'; };

  // node -> incident [roadIdx, k]
  const inc = new Map();
  roads.forEach((r, ri) => r.nd.forEach((n, k) => { if (!inc.has(n)) inc.set(n, []); inc.get(n).push([ri, k]); }));

  // Walk along road ri from index k in direction dir (+1/-1) until `dist` meters away from (cx,cz).
  function walkOut(ri, k, dir, cx, cz, dist) {
    const nd = roads[ri].nd;
    for (let i = k + dir; i >= 0 && i < nd.length; i += dir) {
      const d = Math.hypot(X(nd[i]) - cx, Z(nd[i]) - cz);
      if (d >= dist) return [(X(nd[i]) - cx) / d, (Z(nd[i]) - cz) / d];
    }
    return null;
  }

  // ---------- traffic signals ----------
  const sigNodes = [...nodeTags.entries()].filter(([n, t]) => t.highway === 'traffic_signals' && inc.has(n)).map(([n]) => n);
  const parent = new Map(sigNodes.map((n) => [n, n]));
  const find = (n) => { while (parent.get(n) !== n) { parent.set(n, parent.get(parent.get(n))); n = parent.get(n); } return n; };
  for (let i = 0; i < sigNodes.length; i++) for (let j = i + 1; j < sigNodes.length; j++) {
    const a = sigNodes[i], b = sigNodes[j];
    if (Math.hypot(X(a) - X(b), Z(a) - Z(b)) < 45) parent.set(find(a), find(b));
  }
  const clusters = new Map();
  for (const n of sigNodes) { const r = find(n); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(n); }

  const signals = [];
  const signalNodeSet = new Set(sigNodes);
  for (const members of clusters.values()) {
    const cx = members.reduce((a, n) => a + X(n), 0) / members.length, cz = members.reduce((a, n) => a + Z(n), 0) / members.length;
    const radius = Math.max(0, ...members.map((n) => Math.hypot(X(n) - cx, Z(n) - cz)));
    // arms: sample road segments in a ring around the intersection (robust to how OSM splits ways)
    const Rm = radius + 30, R2 = Rm + 2;
    const raw = [];
    const seen = new Set();
    roadIndex.grid.forBox(cx - R2, cz - R2, cx + R2, cz + R2, (sgi) => {
      if (seen.has(sgi)) return;
      seen.add(sgi);
      const r = roads[roadIndex.road[sgi]];
      if (!drivable(r) || r.t.endsWith('_link')) return;
      // where does this segment cross the circle of radius Rm around the center?
      const ax = roadIndex.ax[sgi] - cx, az = roadIndex.az[sgi] - cz, ex = roadIndex.bx[sgi] - roadIndex.ax[sgi], ez = roadIndex.bz[sgi] - roadIndex.az[sgi];
      const A = ex * ex + ez * ez, B = 2 * (ax * ex + az * ez), C = ax * ax + az * az - Rm * Rm;
      const disc = B * B - 4 * A * C;
      if (A < 1e-9 || disc < 0) return;
      for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
        if (t < 0 || t > 1) continue;
        const px = ax + ex * t, pz = az + ez * t, d = Math.hypot(px, pz) || 1;
        raw.push({ dx: px / d, dz: pz / d, w: r.w, rank: RANK[r.t] || 0 });
      }
    });
    const arms = [];
    for (const a of raw.sort((p, q) => q.rank - p.rank)) {
      const ang = Math.atan2(a.dz, a.dx);
      const m = arms.find((b) => Math.abs(Math.atan2(Math.sin(ang - b.ang), Math.cos(ang - b.ang))) < 0.55);
      if (m) { m.w = Math.max(m.w, a.w); m.sx += a.dx; m.sz += a.dz; m.n++; } else arms.push({ ang, w: a.w, rank: a.rank, n: 1, sx: a.dx, sz: a.dz });
    }
    for (const a of arms) { const L = Math.hypot(a.sx, a.sz) || 1; a.dx = a.sx / L; a.dz = a.sz / L; a.ang = Math.atan2(a.dz, a.dx); }
    if (arms.length < 2) continue;
    const main = arms.reduce((p, q) => (q.rank > p.rank || (q.rank === p.rank && q.w > p.w) ? q : p));
    const poles = [];
    for (const arm of arms) {
      const others = arms.filter((b) => b !== arm);
      const D = radius + Math.max(...others.map((b) => b.w)) / 2 + 4;
      // traffic approaching on this arm travels along -arm; its right-hand side is (dz, -dx)
      const rx = arm.dz, rz = -arm.dx;
      const px0 = cx + arm.dx * D, pz0 = cz + arm.dz * D;
      let wasOn = false, onSpan = 0, edge = null;
      for (let s = 0; s <= 45; s += 0.5) {
        const on = onDriveSurface(px0 + rx * s, pz0 + rz * s);
        if (on) { wasOn = true; onSpan += 0.5; } else if (wasOn) { edge = s; break; }
      }
      if (edge === null) { edge = arm.w / 2 + 1; onSpan = arm.w / 2; } // couldn't find the curb: use the road width
      const px = px0 + rx * (edge + 1.3), pz = pz0 + rz * (edge + 1.3);
      const len = Math.min(14, Math.max(3, onSpan * 0.85 + 1));
      const sameAxis = Math.abs(Math.cos(arm.ang - main.ang)) > 0.7;
      poles.push([r1(px), r1(pz), r2(arm.dx), r2(arm.dz), r2(-rx), r2(-rz), r1(len), Math.max(1, Math.min(3, Math.round(onSpan / 3.6))), sameAxis ? 0 : 1]);
    }
    if (poles.length) signals.push({ x: r1(cx), z: r1(cz), p: poles, nodes: members });
  }

  // ---------- stop signs ----------
  const stops = [];
  for (const [n, t] of nodeTags) {
    if (t.highway !== 'stop' || !inc.has(n)) continue;
    const list = inc.get(n);
    const junction = list.length >= 2;
    const approaches = [];
    if (!junction) {
      // stop line before a junction: travel direction = toward the closer junction along the way
      const [ri, k] = list[0];
      const nd = roads[ri].nd;
      let best = null;
      for (const dir of [1, -1]) {
        let dist = 0;
        for (let i = k + dir; i >= 0 && i < nd.length; i += dir) {
          dist += Math.hypot(X(nd[i]) - X(nd[i - dir]), Z(nd[i]) - Z(nd[i - dir]));
          if ((inc.get(nd[i]) || []).length >= 2) { if (!best || dist < best.dist) best = { dist, dir }; break; }
          if (dist > 60) break;
        }
      }
      if (!best) continue;
      const j = k + best.dir;
      const L = Math.hypot(X(nd[j]) - X(n), Z(nd[j]) - Z(n)) || 1;
      approaches.push({ x: X(n), z: Z(n), tx: (X(nd[j]) - X(n)) / L, tz: (Z(nd[j]) - Z(n)) / L, w: roads[ri].w, oneway: roads[ri].o, setback: 0 });
    } else {
      const maxRank = Math.max(...list.map(([ri]) => RANK[roads[ri].t] || 0));
      const majorW = Math.max(...list.filter(([ri]) => (RANK[roads[ri].t] || 0) === maxRank).map(([ri]) => roads[ri].w));
      for (const [ri, k] of list) {
        const r = roads[ri];
        if ((RANK[r.t] || 0) >= maxRank && list.length > 1 && new Set(list.map(([q]) => RANK[roads[q].t])).size > 1) continue; // major road doesn't stop
        for (const dir of [1, -1]) {
          const i = k - dir; // neighbor we come from
          if (i < 0 || i >= r.nd.length) continue;
          if (r.o && dir === -1) continue; // one-way: only approach in node order
          const L = Math.hypot(X(n) - X(r.nd[i]), Z(n) - Z(r.nd[i])) || 1;
          approaches.push({ x: X(n), z: Z(n), tx: (X(n) - X(r.nd[i])) / L, tz: (Z(n) - Z(r.nd[i])) / L, w: r.w, oneway: r.o, setback: majorW / 2 + 2.5 });
        }
      }
    }
    for (const a of approaches) {
      const rx = -a.tz, rz = a.tx; // right of travel
      const side = a.w / 2 + 1.1;
      const x = a.x - a.tx * a.setback + rx * side, z = a.z - a.tz * a.setback + rz * side;
      stops.push(r1(x), r1(z), r2(-a.tx), r2(-a.tz));
    }
  }

  // ---------- crosswalks ----------
  const MARKED = new Set(['marked', 'zebra', 'traffic_signals', 'uncontrolled', 'pedestrian_signals']);
  const crosswalks = [];
  for (const [n, t] of nodeTags) {
    if (t.highway !== 'crossing' && t.crossing === undefined) continue;
    const marked = MARKED.has(t.crossing) || (t['crossing:markings'] && t['crossing:markings'] !== 'no') || t.crossing_ref === 'zebra';
    if (!marked) continue;
    const list = (inc.get(n) || []).filter(([ri]) => roads[ri].t !== 'service' || roads[ri].n);
    if (!list.length) continue;
    const [ri, k] = list[0];
    const nd = roads[ri].nd;
    const a = nd[Math.max(0, k - 1)], b = nd[Math.min(nd.length - 1, k + 1)];
    const L = Math.hypot(X(b) - X(a), Z(b) - Z(a)) || 1;
    crosswalks.push(r1(X(n)), r1(Z(n)), r2((X(b) - X(a)) / L), r2((Z(b) - Z(a)) / L), r1(roads[ri].w));
  }

  // ---------- streetlights ----------
  const lights = [];
  const nearSignal = (x, z) => signals.some((s) => Math.abs(s.x - x) < 40 && Math.abs(s.z - z) < 40 && Math.hypot(s.x - x, s.z - z) < 35);
  const LIT = /^(trunk|primary|secondary|tertiary)$/;
  roads.forEach((r) => {
    if (!LIT.test(r.t)) return;
    const nd = r.nd;
    let acc = 22, side = 1, count = 0;
    for (let i = 0; i < nd.length - 1; i++) {
      const ax = X(nd[i]), az = Z(nd[i]), bx = X(nd[i + 1]), bz = Z(nd[i + 1]);
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      let s = acc;
      while (s < L) {
        const x = ax + tx * s, z = az + tz * s;
        const sd = r.o ? 1 : side;
        const rx = -tz * sd, rz = tx * sd;
        const lx = x + rx * (r.w / 2 + 1.3), lz = z + rz * (r.w / 2 + 1.3);
        if (!roadIndex.roadAt(lx, lz) && !nearSignal(x, z)) { lights.push(r1(lx), r1(lz), r2(-rx), r2(-rz)); count++; }
        side = -side;
        s += 52;
      }
      acc = s - L;
    }
  });
  for (const l of lamps) {
    const near = roadIndex.nearest(l.x, l.z, 30);
    if (!near) continue;
    const d = Math.hypot(near.px - l.x, near.pz - l.z) || 1;
    lights.push(r1(l.x), r1(l.z), r2((near.px - l.x) / d), r2((near.pz - l.z) / d));
  }

  // ---------- street-name signs ----------
  const nameList = [], nameIdx = new Map();
  const nameId = (s) => { if (!nameIdx.has(s)) { nameIdx.set(s, nameList.length); nameList.push(s); } return nameIdx.get(s); };
  const placed = [];
  const streetSigns = [];
  for (const [n, list] of inc) {
    const named = list.filter(([ri]) => drivable(roads[ri]) && roads[ri].n && !roads[ri].t.endsWith('_link') && roads[ri].t !== 'motorway');
    const names = [...new Set(named.map(([ri]) => abbreviate(roads[ri].n)))];
    if (names.length < 2) continue;
    const key = names.slice(0, 2).sort().join('|');
    if (placed.some((p) => p.key === key && Math.hypot(p.x - X(n), p.z - Z(n)) < 60)) continue;
    // a direction for each of the two streets
    const dirs = names.slice(0, 2).map((nm) => {
      const [ri, k] = named.find(([q]) => abbreviate(roads[q].n) === nm);
      const nd = roads[ri].nd;
      const a = nd[Math.max(0, k - 1)], b = nd[Math.min(nd.length - 1, k + 1)];
      const L = Math.hypot(X(b) - X(a), Z(b) - Z(a)) || 1;
      return { dx: (X(b) - X(a)) / L, dz: (Z(b) - Z(a)) / L, w: roads[ri].w };
    });
    // corner: offset diagonally between the two streets, outside both road surfaces
    let best = null;
    for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
      const ox = dirs[0].dx * s1 + dirs[1].dx * s2, oz = dirs[0].dz * s1 + dirs[1].dz * s2;
      const ol = Math.hypot(ox, oz) || 1;
      const dist = Math.max(dirs[0].w, dirs[1].w) / 2 + 3.2;
      const x = X(n) + (ox / ol) * dist, z = Z(n) + (oz / ol) * dist;
      if (roadIndex.roadAt(x, z) === null) { best = [x, z]; break; }
    }
    if (!best) continue;
    placed.push({ key, x: X(n), z: Z(n) });
    streetSigns.push(r1(best[0]), r1(best[1]), nameId(names[0]), r2(Math.atan2(dirs[0].dx, dirs[0].dz)), nameId(names[1]), r2(Math.atan2(dirs[1].dx, dirs[1].dz)));
  }

  return { signals, stops, crosswalks, lights, streetSigns, streetNames: nameList, sidewalks, signalNodes: [...signalNodeSet] };
}

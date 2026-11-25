// AI traffic on the real OSM road graph.
//  - Drivers: Intelligent Driver Model car-following; each driver aims for the posted speed limit of the
//    road they're on times a personal factor (cautious / normal / aggressive), slows for curves and turns.
//  - Intersections: cars reserve the junction before entering, and movements whose paths cross are never
//    in it together. Traffic signals (+ right on red), stop signs (two-way: wait for a gap; all-way: first
//    come first served), yield to bigger roads, yield to the right on equal roads, left turns yield to
//    oncoming traffic, ramps merge onto I-94 by gap acceptance, and nobody blocks the box.
//  - Lanes: lane 0 = curb lane. MOBIL lane changes (pass slower cars, keep right) and mandatory moves
//    into the correct lane for a turn or a lane drop, with turn signals. Smooth curves through junctions.
//  - Vehicles: sedans, SUVs, pickups, vans, box trucks, buses, semis with trailers, police.
//  - You: they predict your path and brake or swerve, yield to you at junctions, and get knocked around
//    by impulse physics when you hit them, then recover and drive off.
//  - Police: patrol like everyone else; pursuit routing / chasing / everyone pulling over (police.js
//    decides when).
import * as THREE from 'three';
import { Grid } from './spatial.js';
import { phaseState, signalOffset } from './furniture.js';
import { computeSpeedLimits } from './speedlimits.js';
import { VEHICLE_TYPES, TYPE, makeFleetMeshes } from './vehicles.js';
import { blobTexture } from './car.js';

const MPH = 0.44704;
const TAU = Math.PI * 2;
const RANK = {
  motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 1, living_street: 0, road: 1,
  motorway_link: 4, trunk_link: 4, primary_link: 3, secondary_link: 3, tertiary_link: 2,
};
// relative traffic volume per meter of road (spawn density and route choice)
const VOLUME = {
  motorway: 9, trunk: 6, primary: 5, secondary: 3, tertiary: 1.8, unclassified: 0.7, residential: 0.3, living_street: 0.15, road: 0.5,
  motorway_link: 1.6, trunk_link: 1.2, primary_link: 1.2, secondary_link: 0.8, tertiary_link: 0.6,
};
// minimum road rank each big vehicle sticks to
const MIN_RANK = { boxtruck: 3, bus: 3, semi: 4 };
export const PERSONALITIES = [
  { id: 'cautious', share: 25, v0: [0.9, 0.97], T: 1.9, a: 1.5, b: 2.2, s0: 2.6, p: 0.6, lcTh: 0.45, gap: 5.5, latA: 2.2, react: 1.1, roll: false },
  { id: 'normal', share: 60, v0: [0.97, 1.04], T: 1.4, a: 2.1, b: 2.8, s0: 2.0, p: 0.3, lcTh: 0.25, gap: 4.5, latA: 2.8, react: 0.7, roll: false },
  { id: 'aggressive', share: 15, v0: [1.08, 1.18], T: 0.9, a: 3.0, b: 3.6, s0: 1.4, p: 0.05, lcTh: 0.08, gap: 3.0, latA: 3.6, react: 0.3, roll: true },
];
const PURSUIT = { id: 'pursuit', v0: [1, 1], T: 0.6, a: 4.5, b: 6, s0: 1.2, p: 0, lcTh: 0, gap: 1.5, latA: 5.5, react: 0, roll: true };

const roulette = (list, w) => {
  let total = 0;
  for (const x of list) total += w(x);
  let r = Math.random() * total;
  for (const x of list) if ((r -= w(x)) <= 0) return x;
  return list[list.length - 1];
};
const smooth = (t) => t * t * (3 - 2 * t);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// distance between segments AB and CD
function segDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const cross = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = cross(cx, cz, dx, dz, ax, az), d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz), d4 = cross(ax, az, bx, bz, dx, dz);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  const pt = (px, pz, sx, sz, ex, ez) => {
    const vx = ex - sx, vz = ez - sz, L2 = vx * vx + vz * vz || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - sx) * vx + (pz - sz) * vz) / L2));
    return Math.hypot(px - sx - vx * t, pz - sz - vz * t);
  };
  return Math.min(pt(ax, az, cx, cz, dx, dz), pt(bx, bz, cx, cz, dx, dz), pt(cx, cz, ax, az, bx, bz), pt(dx, dz, ax, az, bx, bz));
}

export class Traffic {
  constructor(map, scene, { maxCars = 150, roads = null, buildings = null } = {}) {
    this.map = map;
    this.maxCars = maxCars;
    this.roadIndex = roads;
    this.buildings = buildings;
    this.limits = computeSpeedLimits(map);
    this.buildGraph();
    this.meshes = makeFleetMeshes(scene, maxCars);
    // contact shadows (photoreal mode)
    this.blobMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.06, 0),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, toneMapped: false }),
      maxCars * 2,
    );
    this.blobMesh.frustumCulled = false;
    this.blobMesh.renderOrder = 1;
    this.blobMesh.count = 0;
    this.blobMesh.visible = false;
    scene.add(this.blobMesh);
    // Height providers (set by main). null = flat world at y = 0.
    this.ground = null; // (x, z, y) -> surface height just below y, or null
    this.groundInit = null; // (x, z, onBridge) -> surface height for a freshly spawned car, or null
    this._rr = 0;
    this.cars = [];
    this.occ = new Map(); // junction vertex -> Set of cars cleared to cross it
    this.cc = new Map(); // conflict cache per vertex
    this.pathCache = new Map(); // sampled movement paths
    this.events = []; // collisions with the player, read by police.js
    this.offRoad = []; // crashed / chasing cars (obstacles for everyone else)
    this.dbg = { forced: 0, committed: 0, samples: [] };
    this.time = 0;
    this.nextId = 1;
    this.navDist = null;
    this.navTimer = 0;
    this.player = { x: 0, z: 0, vx: 0, vz: 0, heading: 0 };
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this.enabled = true;
    this.obeySignals = true;
  }

  // ------------------------------------------------------------------ graph
  buildGraph() {
    const { nodes, roads } = this.map;
    const mph = this.limits.mph;
    const use = new Map();
    const drivable = (r) => r.t !== 'service';
    roads.forEach((r) => {
      if (!drivable(r)) return;
      r.nd.forEach((n, k) => {
        const e = k === 0 || k === r.nd.length - 1;
        use.set(n, (use.get(n) || 0) + (e ? 2 : 1));
      });
    });
    const vertexOf = new Map();
    const vx = [], vz = [], vnode = [];
    const vid = (n) => {
      let v = vertexOf.get(n);
      if (v === undefined) {
        v = vx.length;
        vertexOf.set(n, v);
        vx.push(nodes[n * 2]); vz.push(nodes[n * 2 + 1]); vnode.push(n);
      }
      return v;
    };
    const edges = [];
    const out = [];
    const addEdge = (from, to, pts, road, twinOf) => {
      const n = pts.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      const r = roads[road];
      const lanes = r.o ? Math.max(1, r.l) : Math.max(1, Math.floor(r.l / 2));
      const laneW = Math.min(3.6, (r.w - 0.6) / Math.max(1, r.l));
      const e = {
        id: edges.length, from, to, road, pts: Float32Array.from(pts), cum, len: cum[n - 1],
        lanes, laneW, oneway: !!r.o, w: r.w,
        speed: mph[road] * MPH, limitMph: mph[road],
        rank: RANK[r.t] ?? 1, vol: VOLUME[r.t] ?? 0.5,
        freeway: r.t === 'motorway' || r.t === 'motorway_link', link: /_link$/.test(r.t),
        twin: null, cars: [], stop: null, signal: null, inner: false,
      };
      if (twinOf) { e.twin = twinOf; twinOf.twin = e; }
      edges.push(e);
      (out[from] ||= []).push(e);
      return e;
    };
    // signal stop-line nodes become vertices too, so an edge ends exactly where cars must stop
    const sigNodes = new Set((this.map.furniture?.signals || []).flatMap((s) => s.nodes));
    roads.forEach((r, ri) => {
      if (!drivable(r)) return;
      let start = 0;
      for (let k = 1; k < r.nd.length; k++) {
        const n = r.nd[k];
        if (k < r.nd.length - 1 && (use.get(n) || 0) < 2 && !sigNodes.has(n)) continue;
        const slice = r.nd.slice(start, k + 1);
        const pts = [];
        slice.forEach((m) => pts.push(nodes[m * 2], nodes[m * 2 + 1]));
        if (pts.length >= 4) {
          const a = vid(r.nd[start]), b = vid(n);
          const fwd = addEdge(a, b, pts, ri, null);
          if (fwd.len < 0.5) { edges.pop(); out[a].pop(); start = k; continue; }
          if (!r.o) {
            const rev = [];
            for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
            addEdge(b, a, rev, ri, fwd);
          }
        }
        start = k;
      }
    });
    this.edges = edges;
    this.out = out;
    this.vx = vx; this.vz = vz;
    const V = vx.length;
    this.vIn = Array.from({ length: V }, () => []);
    for (const e of edges) { e.inIdx = this.vIn[e.to].length; this.vIn[e.to].push(e); }
    for (let v = 0; v < V; v++) (out[v] || []).forEach((e, i) => { e.outIdx = i; });

    // junctions: 3+ distinct road directions meet. Box radius from the widest road there.
    this.vJunc = new Uint8Array(V);
    this.vMerge = new Uint8Array(V); // lanes drop here: merging cars take turns
    this.vR = new Float32Array(V);
    for (let v = 0; v < V; v++) {
      const outs = out[v] || [], ins = this.vIn[v];
      const deg = outs.length + ins.filter((e) => !e.twin || !outs.includes(e.twin)).length;
      let hw = 0;
      for (const e of [...outs, ...ins]) hw = Math.max(hw, e.w / 2);
      this.vJunc[v] = deg >= 3 ? 1 : 0;
      if (deg < 3) for (const e of ins) for (const o of outs) if (o !== e.twin && o.lanes < e.lanes) this.vMerge[v] = 1;
      let R = deg >= 3 ? Math.min(13, Math.max(5, hw + 2.5)) : Math.min(6, Math.max(2.5, hw + 0.5));
      if (deg >= 3) {
        // roads meeting at a shallow angle (Y junctions, ramps) overlap well before the junction point:
        // the zone runs out to where their pavements separate
        const legs = [...outs.map((e) => [this.startDir(e), e.w]), ...ins.filter((e) => !e.twin || !outs.includes(e.twin)).map((e) => { const [x, z] = this.endDir(e); return [[-x, -z], e.w]; })];
        for (let i = 0; i < legs.length; i++) {
          for (let j = i + 1; j < legs.length; j++) {
            const [[ax, az], wa] = legs[i], [[bx, bz], wb] = legs[j];
            const half = Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz))) / 2;
            if (half > 0.02) R = Math.max(R, Math.min(30, (wa + wb) / (4 * Math.sin(half))));
          }
        }
      }
      this.vR[v] = R;
    }

    // curve speed limits at bends inside each edge
    for (const e of edges) {
      const b = [];
      const { pts, cum } = e;
      for (let i = 1; i < cum.length - 1; i++) {
        const lp = cum[i] - cum[i - 1], ln = cum[i + 1] - cum[i];
        if (lp < 1e-3 || ln < 1e-3) continue;
        const ax = (pts[i * 2] - pts[i * 2 - 2]) / lp, az = (pts[i * 2 + 1] - pts[i * 2 - 1]) / lp;
        const bx = (pts[i * 2 + 2] - pts[i * 2]) / ln, bz = (pts[i * 2 + 3] - pts[i * 2 + 1]) / ln;
        const phi = Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz)));
        if (phi < 0.12) continue;
        const R = Math.max(0.5 * (lp + ln), 8) / phi;
        const vb = Math.max(5, Math.sqrt(2.8 * R));
        if (vb < 38) b.push(cum[i], vb);
      }
      e.bends = Float32Array.from(b);
    }

    // segment grid (stop-sign matching, putting crashed / chasing cars back on the road)
    this.segGrid = new Grid(50);
    this.segRef = [];
    for (const e of edges) {
      for (let i = 0; i < e.cum.length - 1; i++) {
        const ax = e.pts[i * 2], az = e.pts[i * 2 + 1], bx = e.pts[i * 2 + 2], bz = e.pts[i * 2 + 3];
        this.segGrid.insertBox(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), this.segRef.length);
        this.segRef.push(e.id * 65536 + i);
      }
    }

    // Traffic signals: an edge that enters a signalized cluster from outside stops at its end on red.
    const sigs = this.map.furniture?.signals || [];
    const clusterOf = new Map();
    sigs.forEach((s, si) => s.nodes.forEach((n) => clusterOf.set(n, si)));
    // Intersection clusters: junctions joined by short links (divided roads crossing, offset T's) and
    // signalized node groups act as one intersection: you enter only if your whole way through is clear,
    // and once inside you're committed.
    const parent = Int32Array.from({ length: V }, (_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    for (const e of edges) if (e.len < 32 && this.vJunc[e.from] && this.vJunc[e.to]) union(e.from, e.to);
    // a short stub leading into a junction belongs to it: decide before driving onto the stub
    // (a signal's stop line joins the junction it controls, so the light's approach is the way in)
    for (const e of edges) if (e.len < 28 && this.vJunc[e.to] && !this.vJunc[e.from]) union(e.from, e.to);
    const sigVerts = new Map();
    sigs.forEach((sg, si) => sg.nodes.forEach((n) => { const v = vertexOf.get(n); if (v !== undefined) { if (sigVerts.has(si)) union(v, sigVerts.get(si)); else sigVerts.set(si, v); } }));
    const size = new Int32Array(V);
    for (let v = 0; v < V; v++) size[find(v)]++;
    this.vCluster = new Int32Array(V);
    for (let v = 0; v < V; v++) this.vCluster[v] = size[find(v)] > 1 ? find(v) : -1;
    for (const e of edges) {
      e.inner = this.vCluster[e.from] >= 0 && this.vCluster[e.from] === this.vCluster[e.to];
      e.entry = !e.inner && this.vCluster[e.to] >= 0;
    }
    let signalEdges = 0;
    for (const e of edges) {
      const si = clusterOf.get(vnode[e.to]);
      if (si === undefined) continue;
      if (clusterOf.get(vnode[e.from]) === si) { e.inner = true; e.entry = false; continue; }
      const [dx, dz] = this.endDir(e);
      let best = null, bestDot = -2;
      for (const p of sigs[si].p) { const d = -(p[2] * dx + p[3] * dz); if (d > bestDot) { bestDot = d; best = p; } }
      e.signal = { si, phase: best ? best[8] : 0 };
      signalEdges++;
    }
    this.signalEdges = signalEdges;
    this.vnode = vnode; this.vertexOf = vertexOf; this.clusterOf = clusterOf;

    // Stop signs: match each sign (on the right of its approach, facing oncoming traffic) to an edge.
    const st = this.map.furniture?.stops || [];
    let stopEdges = 0;
    for (let i = 0; i < st.length; i += 4) {
      const px = st[i], pz = st[i + 1], tx = -st[i + 2], tz = -st[i + 3];
      let best = null, bestErr = 5;
      const seen = new Set();
      this.segGrid.forBox(px - 25, pz - 25, px + 25, pz + 25, (k) => {
        if (seen.has(k)) return;
        seen.add(k);
        const ref = this.segRef[k], e = edges[Math.floor(ref / 65536)], j = ref % 65536;
        const ax = e.pts[j * 2], az = e.pts[j * 2 + 1], bx = e.pts[j * 2 + 2], bz = e.pts[j * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az) || 1e-6;
        const dx = (bx - ax) / L, dz = (bz - az) / L;
        if (dx * tx + dz * tz < 0.75) return;
        const along = (px - ax) * dx + (pz - az) * dz;
        if (along < -3 || along > L + 3) return;
        const lat = (px - ax) * -dz + (pz - az) * dx; // + = right of travel
        const err = Math.abs(lat - (e.w / 2 + 1.1));
        if (err < bestErr) { bestErr = err; best = { e, s: e.cum[j] + Math.max(0, Math.min(L, along)) }; }
      });
      if (best) {
        const s = Math.max(0.5, Math.min(best.e.len - 0.5, best.s - 0.8));
        if (!best.e.stop) stopEdges++;
        if (!best.e.stop || s > best.e.stop.s) best.e.stop = { s };
      }
    }
    this.stopEdges = stopEdges;
    // all-way stops and the biggest road through each junction
    this.vAllWay = new Uint8Array(V);
    this.vMaxRank = new Int8Array(V);
    for (let v = 0; v < V; v++) {
      const ins = this.vIn[v];
      this.vAllWay[v] = this.vJunc[v] && ins.length >= 2 && ins.every((e) => e.stop && e.len - e.stop.s < 45) ? 1 : 0;
      let mr = -1;
      for (const e of ins) if (!(e.stop && e.len - e.stop.s < 45)) mr = Math.max(mr, e.rank);
      this.vMaxRank[v] = mr;
    }
    // spawn grid of edges by midpoint
    this.edgeGrid = new Grid(200);
    for (const e of edges) {
      const mid = this.pointOn(e, e.len / 2, 0);
      e.mx = mid.x; e.mz = mid.z;
      this.edgeGrid.insertBox(mid.x, mid.z, mid.x, mid.z, e.id);
    }
  }

  // Position/direction at distance s along edge e with lateral offset (+ = right).
  pointOn(e, s, off, hint = 0) {
    const { pts, cum } = e;
    const n = cum.length;
    let i = Math.min(hint, n - 2);
    while (i < n - 2 && cum[i + 1] < s) i++;
    while (i > 0 && cum[i] > s) i--;
    const L = cum[i + 1] - cum[i] || 1e-6;
    const t = Math.max(0, Math.min(1, (s - cum[i]) / L));
    const dx = (pts[i * 2 + 2] - pts[i * 2]) / L, dz = (pts[i * 2 + 3] - pts[i * 2 + 1]) / L;
    return {
      x: pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * t - dz * off,
      z: pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * t + dx * off,
      dx, dz, seg: i,
    };
  }

  // lateral offset of a lane's center (lane 0 = curb lane, + = right of the edge's centerline)
  laneOffset(e, lane) {
    if (e.oneway) return (e.lanes * e.laneW) / 2 - (lane + 0.5) * e.laneW;
    return (e.lanes - lane - 0.5) * e.laneW;
  }

  endDir(e) {
    const n = e.cum.length, p = e.pts;
    const L = Math.hypot(p[n * 2 - 2] - p[n * 2 - 4], p[n * 2 - 1] - p[n * 2 - 3]) || 1;
    return [(p[n * 2 - 2] - p[n * 2 - 4]) / L, (p[n * 2 - 1] - p[n * 2 - 3]) / L];
  }
  startDir(e) {
    const p = e.pts;
    const L = Math.hypot(p[2] - p[0], p[3] - p[1]) || 1;
    return [(p[2] - p[0]) / L, (p[3] - p[1]) / L];
  }

  // 0 straight, 1 right, -1 left, 2 U-turn
  turnInfo(e, n) {
    if (!n) return { sharp: 0, dir: 0 };
    const [ax, az] = this.endDir(e), [bx, bz] = this.startDir(n);
    const sharp = 1 - (ax * bx + az * bz);
    let dir = 0;
    if (n === e.twin || sharp > 1.75) dir = 2;
    else if (sharp > 0.3) dir = ax * bz - az * bx > 0 ? 1 : -1;
    return { sharp, dir };
  }
  // lane on n after the movement. Going straight, lanes keep their place counted from the left; where
  // lanes drop, the curb lanes zipper into lane 0 (the reservation system takes them in turn).
  mapLane(e, lane, n, dir) {
    if (!n) return 0;
    if (dir === 1) return 0;
    if (dir === -1 || dir === 2) return n.lanes - 1;
    return Math.max(0, Math.min(n.lanes - 1, lane + n.lanes - e.lanes));
  }
  laneRange(e, n, dir) {
    if (!n || e.lanes === 1) return [0, e.lanes - 1];
    if (dir === 1) return [0, 0];
    if (dir === -1 || dir === 2) return [e.lanes - 1, e.lanes - 1];
    return [0, e.lanes - 1];
  }
  rIn(e) { return Math.min(this.vR[e.to], e.len * 0.45); }
  rOut(n) { return Math.min(this.vR[n.from], n.len * 0.45); }

  chooseNext(e, car = null) {
    const outs = this.out[e.to] || [];
    if (car?.pursuit && this.navDist) {
      let best = null, bd = Infinity;
      for (const o of outs) {
        const d = o.len + this.navDist[o.to] + (o === e.twin ? 40 : 0);
        if (d < bd) { bd = d; best = o; }
      }
      if (best) return best;
    }
    let opts = outs.filter((o) => o !== e.twin);
    if (!opts.length) return e.twin; // dead end: U-turn (null if one-way dead end)
    if (e.inner && opts.length > 1) {
      // inside a divided-road intersection a sharp turn is usually half of a U-turn: avoid when possible
      const [ax, az] = this.endDir(e);
      const fwd = opts.filter((o) => { const [bx, bz] = this.startDir(o); return ax * bx + az * bz > -0.5; });
      if (fwd.length) opts = fwd;
    }
    const [ax, az] = this.endDir(e);
    const minRank = car ? MIN_RANK[car.type.id] || 0 : 0;
    return roulette(opts, (o) => {
      const [bx, bz] = this.startDir(o);
      const straight = ax * bx + az * bz;
      let w = (0.3 + o.vol) * (straight > 0.9 ? 3 : straight > 0.3 ? 1.4 : straight > -0.3 ? 1 : 0.3);
      if (e.rank >= 4 && o.rank <= 1) w *= 0.3; // stay on big roads
      if (o.rank < minRank) w *= 0.03;
      if (car?.type.noFreeway && o.freeway) w *= 0.02;
      if (car && e.lanes > 1) {
        const [lo, hi] = this.laneRange(e, o, this.turnInfo(e, o).dir);
        const k = car.lane < lo ? lo - car.lane : car.lane > hi ? car.lane - hi : 0;
        if (k) w *= e.len > 90 * k + 60 ? 0.5 : 0.04;
      }
      return w;
    });
  }

  // ------------------------------------------------------------------ spawning
  spawnNear(px, pz, minR, maxR, { police = false } = {}) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ang = Math.random() * TAU;
      const d = minR + Math.random() * (maxR - minR);
      const x = px + Math.cos(ang) * d, z = pz + Math.sin(ang) * d;
      const cand = [];
      this.edgeGrid.forBox(x - 160, z - 160, x + 160, z + 160, (id) => { const e = this.edges[id]; if (e.len >= 20 && !e.inner) cand.push(e); });
      if (!cand.length) continue;
      const e = roulette(cand, (c) => c.vol * c.lanes * Math.min(c.len, 300));
      const s = 6 + Math.random() * Math.max(1, e.len - 6 - this.rIn(e) - 18);
      if (s > e.len - this.rIn(e) - 12) continue;
      const p = this.pointOn(e, s, 0);
      const dd = Math.hypot(p.x - px, p.z - pz);
      if (dd < minR || dd > maxR + 60) continue;
      let type = police ? TYPE.police : roulette(VEHICLE_TYPES.filter((t) => t.share > 0), (t) => t.share);
      if (!police && this.policeCount() < 3 && Math.random() < 0.04) type = TYPE.police;
      if ((MIN_RANK[type.id] || 0) > e.rank || (type.noFreeway && e.freeway)) type = TYPE.sedan;
      const lane = Math.floor(Math.random() * e.lanes);
      const back = type.len / 2 + (type.trailerLen ? type.trailerLen - 1.6 : 0), front = type.len / 2;
      if (e.cars.some((c) => this.inLane(c, lane) && (c.s > s ? c.s - c.back - s - front < (c.speed < 1 ? 40 : 10) : s - back - c.s - c.front < 10))) continue;
      return this.addCar(e, s, lane, type);
    }
    return null;
  }
  policeCount() { let n = 0; for (const c of this.cars) if (c.police) n++; return n; }

  addCar(e, s, lane, type = TYPE.sedan, pers = null) {
    if (this.cars.length >= this.maxCars) return null;
    pers ||= type.id === 'police' ? PERSONALITIES[1] : roulette(PERSONALITIES, (p) => p.share);
    const trailerLen = type.trailerLen || 0;
    const car = {
      id: this.nextId++, type, pers, police: type.id === 'police',
      len: type.len, width: type.width, mass: type.mass + (trailerLen ? 8000 : 0),
      front: type.len / 2, back: type.len / 2 + (trailerLen ? trailerLen - 1.6 : 0),
      aMax: pers.a * type.accel, maxV: type.maxMph ? type.maxMph * MPH : 1e9,
      v0f: pers.v0[0] + Math.random() * (pers.v0[1] - pers.v0[0]),
      mode: 'drive', edge: e, s, lane, off: this.laneOffset(e, lane), lc: null, next: null, curve: null,
      speed: 0, acc: 0, res: [], waitT: 0,
      stopDone: false, stopT: 0, arrT: 0, held: false, yielding: false, wasHeld: false, startDelay: 0, rtorStop: false, rerouted: false,
      blink: 0, brake: 0, hazard: false, swerve: 0, swerveT: 0, swerveDir: 0, pullT: 0, pullOff: 0, stunT: 0,
      lcTimer: Math.random(), seg: 0, color: type.colors[Math.floor(Math.random() * type.colors.length)],
      x: 0, z: 0, heading: 0, y: 0, ty: 0, pitch: 0, yKnown: !this.groundInit,
      trailer: null, vx: 0, vz: 0, w: 0, restT: 0, blendT: 0, blendFrom: null,
      pursuit: false, chaseStuck: 0, lightsT: 0,
    };
    car.speed = Math.min(e.speed * car.v0f, car.maxV) * 0.85;
    car.next = this.chooseNext(e, car);
    this.planCluster(car);
    e.cars.push(car);
    const p = this.pointOn(e, s, car.off);
    car.x = p.x; car.z = p.z; car.heading = Math.atan2(p.dx, p.dz);
    if (trailerLen) {
      const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
      const kx = car.x - hx * (car.len / 2 - 1.3), kz = car.z - hz * (car.len / 2 - 1.3);
      car.trailer = { ax: kx - hx * (trailerLen - 2.4), az: kz - hz * (trailerLen - 2.4), x: 0, z: 0, heading: car.heading, y: 0, pitch: 0 };
      this.updateTrailer(car);
    }
    this.cars.push(car);
    return car;
  }

  removeCar(car) {
    this.release(car);
    if (car.mode === 'drive') {
      const list = car.edge.cars, i = list.indexOf(car);
      if (i >= 0) list.splice(i, 1);
    }
    const j = this.cars.indexOf(car);
    if (j >= 0) this.cars.splice(j, 1);
  }

  clear() {
    for (const c of this.cars.slice()) this.removeCar(c);
    this.occ.clear();
    this.events.length = 0;
  }

  // ------------------------------------------------------------------ junction rules
  // Bezier control point where the entry and exit lane lines meet (shared by the drawn curve and the
  // conflict test)
  controlPoint(p0, p2, rIn, rOut) {
    const ex = p2.x - p0.x, ez = p2.z - p0.z;
    const den = p0.dx * p2.dz - p0.dz * p2.dx;
    let cx = (p0.x + p2.x) / 2, cz = (p0.z + p2.z) / 2;
    const lim = 3 * Math.max(rIn, rOut) + 6;
    if (Math.abs(den) > 0.12) {
      const t = (ex * p2.dz - ez * p2.dx) / den;
      const u = -(p0.dx * ez - p0.dz * ex) / den;
      if (t > 0 && t < lim && u < 0 && -u < lim) { cx = p0.x + p0.dx * t; cz = p0.z + p0.dz * t; }
    } else if (p0.dx * p2.dx + p0.dz * p2.dz < 0) {
      cx += p0.dx * (rIn + 3); cz += p0.dz * (rIn + 3); // U-turn bulb
    }
    return [cx, cz];
  }
  // sampled path of a movement through the junction at e.to, from lane `lane` of e to lane `nl` of n
  movementPath(e, lane, n, nl) {
    const key = `${e.id}|${lane}|${n.id}|${nl}`;
    let path = this.pathCache.get(key);
    if (path) return path;
    const rIn = this.rIn(e), rOut = this.rOut(n);
    const p0 = this.pointOn(e, e.len - rIn, this.laneOffset(e, lane));
    const p2 = this.pointOn(n, rOut, this.laneOffset(n, nl));
    const [cx, cz] = this.controlPoint(p0, p2, rIn, rOut);
    const K = 9;
    path = new Float32Array(K * 2);
    for (let k = 0; k < K; k++) {
      const t = k / (K - 1), a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      path[k * 2] = a * p0.x + b * cx + c * p2.x; path[k * 2 + 1] = a * p0.z + b * cz + c * p2.z;
    }
    this.pathCache.set(key, path);
    return path;
  }
  // Do two movements through junction v come within a car's width of each other?
  conflicts(v, e1, l1, n1, nl1, e2, l2, n2, nl2) {
    if (!n1 || !n2) return false;
    if (e1 === e2 && l1 === l2) return false; // same lane: following handles it
    let cache = this.cc.get(v);
    if (!cache) this.cc.set(v, (cache = new Map()));
    const m = (e, l, n, nl) => ((e.inIdx & 15) << 10) | ((l & 7) << 7) | ((n.outIdx & 15) << 3) | (nl & 7);
    const key = m(e1, l1, n1, nl1) * 16384 + m(e2, l2, n2, nl2);
    let r = cache.get(key);
    if (r === undefined) {
      const A = this.movementPath(e1, l1, n1, nl1), B = this.movementPath(e2, l2, n2, nl2);
      let minD = Infinity;
      for (let i = 0; i < A.length - 2 && minD > 0; i += 2) {
        for (let j = 0; j < B.length - 2; j += 2) {
          const d = segDist(A[i], A[i + 1], A[i + 2], A[i + 3], B[j], B[j + 1], B[j + 2], B[j + 3]);
          if (d < minD) minD = d;
        }
      }
      r = minD < 3.2;
      cache.set(key, r);
    }
    return r;
  }
  nlOf(o, f, nxt) {
    if (o.curve && o.edge === f) return o.curve.nl;
    return this.mapLane(f, o.lane, nxt, this.turnInfo(f, nxt).dir);
  }

  controlOf(car, e, v, n, ti) {
    if (car.rtorStop) return 'stop';
    if (e.signal) return 'signal';
    if (e.inner) return 'inner';
    if (e.stop && e.len - e.stop.s < 45) return this.vAllWay[v] ? 'allway' : 'stop';
    if (e.rank < this.vMaxRank[v]) return e.link && n.rank >= 6 && ti.sharp < 0.5 ? 'merge' : 'yield';
    return 'priority';
  }

  // Reservations: a car is cleared through a junction (or a whole intersection cluster, all at once)
  // before it enters. occ: vertex -> Map(car -> its movement there {v, e, lane, n, nl}).
  reserve(car, path) {
    for (const mv of path) {
      let m = this.occ.get(mv.v);
      if (!m) this.occ.set(mv.v, (m = new Map()));
      const old = m.get(car);
      if (old) car.res.splice(car.res.indexOf(old), 1);
      m.set(car, mv);
      car.res.push(mv);
    }
    car.yielding = false;
    car.waitT = 0;
  }
  release(car) {
    for (const mv of car.res) this.occ.get(mv.v)?.delete(car);
    car.res = [];
  }
  hasRes(car, v, e) { for (const mv of car.res) if (mv.v === v && mv.e === e) return true; return false; }
  reservedAt(o, v) { return this.occ.get(v)?.has(o) || false; }
  // Stalled for a while before a junction we reserved (traffic ahead stopped)? Give back every claim we
  // haven't physically entered yet, so nobody waits on us; ask again when we can actually go.
  releaseUnentered(car) {
    const e = car.edge;
    const enteredHere = car.curve || car.s + car.front >= e.len - this.rIn(e);
    const keep = [];
    for (const mv of car.res) {
      const current = mv.e === e;
      if ((mv.reached && !current) || (current && enteredHere)) keep.push(mv); // boxes we're in
      else this.occ.get(mv.v)?.delete(car);
    }
    car.res = keep;
  }
  // drop reservations for junctions we've cleared
  releasePassed(car) {
    if (!car.res.length) return;
    let keep = null;
    for (const mv of car.res) {
      if (car.edge === mv.e) mv.reached = true;
      const passed = mv.reached && car.edge !== mv.e && (car.edge !== mv.n || car.s - car.back > this.rOut(mv.n) - 1);
      if (passed) this.occ.get(mv.v)?.delete(car);
      else (keep ||= []).push(mv);
    }
    car.res = keep || [];
  }
  // the junction movements for entering at e.to toward n: just that junction, or every junction of an
  // intersection cluster along the planned way through it
  reservationPath(car, e, n) {
    const lane = car.lane, nl = this.mapLane(e, lane, n, this.turnInfo(e, n).dir);
    const path = [{ v: e.to, e, lane, n, nl, reached: false }];
    let cur = n, cl = nl, idx = 0;
    const v = Math.max(car.speed, 0.75 * this.desiredSpeed(car, n)); // the speed we'll be doing by then
    const seen = new Set([e.to, n.to]);
    // continue through intersection clusters, and through links too short to stop on at this speed
    while (idx < 8 && path.length < 8 && (cur.inner || (this.needsRes(cur) && cur.len - this.rIn(cur) < (v * v) / 6 + 6))) {
      car.plan ||= [];
      let nx = car.plan[idx];
      if (!nx) {
        nx = this.pickPlanNext(cur, car, seen, this.endDir(e));
        if (!nx) break;
        car.plan.push(nx);
      }
      if (seen.has(nx.to)) { car.plan.length = idx; break; } // never reserve one junction twice
      seen.add(nx.to);
      idx++;
      const nl2 = this.mapLane(cur, cl, nx, this.turnInfo(cur, nx).dir);
      if (this.needsRes(cur)) path.push({ v: cur.to, e: cur, lane: cl, n: nx, nl: nl2, reached: false });
      cur = nx; cl = nl2;
    }
    return path;
  }
  needsRes(e) { return this.vJunc[e.to] || this.vMerge[e.to] || e.entry; }
  // next link for a plan through an intersection: no junction twice, and don't double back the way we came
  pickPlanNext(cur, car, seen, entryDir) {
    const ok = (c) => c && !seen.has(c.to) && (() => { const [bx, bz] = this.startDir(c); return bx * entryDir[0] + bz * entryDir[1] > -0.3; })();
    for (let k = 0; k < 6; k++) { const c = this.chooseNext(cur, car); if (ok(c)) return c; }
    return (this.out[cur.to] || []).find((o) => o !== cur.twin && ok(o)) || (this.out[cur.to] || []).find((o) => !seen.has(o.to) && o !== cur.twin) || null;
  }
  // too short to stop on before its junction at our speed: decide before driving onto it
  shortNext(car, n) {
    if (!n || !this.needsRes(n)) return false;
    const v = Math.max(car.speed, 0.75 * this.desiredSpeed(car, n));
    return n.len - this.rIn(n) < (v * v) / 6 + 6;
  }

  exitBlocked(n, nl, car) {
    let minRear = Infinity;
    for (const o of n.cars) {
      if (o.lane !== nl && !(o.lc && o.lc.fromLane === nl)) continue;
      const rear = o.s - o.back;
      if (rear < minRear) minRear = rear;
    }
    return minRear < this.rOut(n) + car.front + car.back + 1;
  }

  playerBlocks(car, v, ctrl) {
    const P = this.player;
    const dx = P.x - this.vx[v], dz = P.z - this.vz[v], d = Math.hypot(dx, dz);
    if (d < this.vR[v] + 3) return this.playerStillT < 4; // you're in the junction
    if (ctrl === 'priority' || ctrl === 'signal' || ctrl === 'inner') return false;
    const sp = Math.hypot(P.vx, P.vz);
    if (sp < 2 || d > 90) return false;
    const approach = -(dx * P.vx + dz * P.vz) / d;
    return approach > 1.5 && d / approach < car.pers.gap;
  }

  // Is any car that hasn't been cleared yet coming at us within `gapT` seconds on a crossing path?
  approaching(car, v, e, lane, n, nl, gapT) {
    const check = (o, f, dist) => {
      if (o === car || o.mode !== 'drive' || this.reservedAt(o, v) || !o.next || o.held || o.yielding) return false;
      if (dist > 160 || dist / Math.max(o.speed, 1) > gapT) return false;
      return this.conflicts(v, e, lane, n, nl, f, o.lane, o.next, this.nlOf(o, f, o.next));
    };
    for (const f of this.vIn[v]) {
      if (f === e) continue;
      for (const o of f.cars) if (check(o, f, f.len - o.s - o.front)) return true;
      if (f.len < 60) {
        for (const g of this.vIn[f.from]) {
          if (g === f.twin) continue;
          for (const o of g.cars) {
            if (o.next !== f || o === car) continue;
            const dist = g.len - o.s - o.front + f.len;
            if (o.mode !== 'drive' || o.held || o.yielding || dist > 160 || dist / Math.max(o.speed, 1) > gapT) continue;
            // their movement at v isn't chosen yet: assume straight through
            const nn = (this.out[v] || []).find((x) => x !== f.twin && this.turnInfo(f, x).dir === 0) || (this.out[v] || [])[0];
            const fl = Math.min(o.lane, f.lanes - 1);
            if (nn && this.conflicts(v, e, lane, n, nl, f, fl, nn, this.mapLane(f, fl, nn, this.turnInfo(f, nn).dir))) return true;
          }
        }
      }
    }
    return false;
  }

  yieldRight(car, v, e, n, nl) {
    if (car.waitT > 3) return true; // break 4-way deadlocks
    const [ax, az] = this.endDir(e);
    const myEta = (e.len - car.s - car.front) / Math.max(car.speed, 1);
    for (const f of this.vIn[v]) {
      if (f === e || f.rank !== e.rank || f.stop || f.signal) continue;
      const [bx, bz] = this.endDir(f);
      if (ax * bz - az * bx > -0.5) continue; // not coming from our right
      for (const o of f.cars) {
        if (o.mode !== 'drive' || this.reservedAt(o, v) || o.held || o.yielding || !o.next) continue;
        const eta = (f.len - o.s - o.front) / Math.max(o.speed, 1);
        if (eta < 6 && eta < myEta + 1 && this.conflicts(v, e, car.lane, n, nl, f, o.lane, o.next, this.nlOf(o, f, o.next))) return false;
      }
    }
    return true;
  }

  earlierAtAllWay(car, v, e, n, nl) {
    for (const f of this.vIn[v]) {
      if (f === e) continue;
      for (const o of f.cars) {
        if (o.mode !== 'drive' || this.reservedAt(o, v) || !o.stopDone || !o.next) continue;
        if (f.len - o.s - o.front > 9) continue;
        if (o.arrT < car.arrT - 0.05 && this.conflicts(v, e, car.lane, n, nl, f, o.lane, o.next, this.nlOf(o, f, o.next))) return true;
      }
    }
    return false;
  }

  mergeBlocked(car, v, e, n) {
    const myEta = (e.len - car.s - car.front) / Math.max(car.speed, 1);
    for (const f of this.vIn[v]) {
      if (f === e) continue;
      for (const o of f.cars) {
        if (o.mode !== 'drive' || o.next !== n || this.reservedAt(o, v)) continue;
        const eta = (f.len - o.s - o.front) / Math.max(o.speed, 1);
        if (eta < 7 && Math.abs(eta - myEta) < 1.8) return true;
      }
    }
    return false;
  }

  mayEnter(car, v, e, n, ti) {
    const ctrl = this.controlOf(car, e, v, n, ti);
    const path = this.reservationPath(car, e, n);
    const last = path[path.length - 1];
    // don't block the box: room where we come out, and nobody stopped on the links inside
    this.denyWhy = '';
    if (this.exitBlocked(last.n, last.nl, car)) { this.denyWhy = `exit full (${last.n.id})`; return null; }
    for (let i = 0; i < path.length - 1; i++) {
      const mv = path[i];
      for (const o of mv.n.cars) if (o !== car && o.mode === 'drive' && o.speed < 0.5 && this.inLane(o, mv.nl) && o.s - o.back < mv.n.len * 0.8) { this.denyWhy = `stopped car inside (${mv.n.id}, car ${o.id})`; return null; }
    }
    const committed = ctrl === 'inner' && car.waitT > 9; // stuck in the middle of an intersection: go
    if (committed) this.dbg.committed++;
    for (const mv of path) {
      const occ = this.occ.get(mv.v);
      if (occ && !committed) {
        for (const [o, om] of occ) {
          if (o === car) continue;
          if (om.e === mv.e && om.lane === mv.lane) continue; // same lane: following handles it
          if (om.n === mv.n && om.nl === mv.nl && ctrl === 'priority' && mv.n.rank >= 6) continue; // freeway: merge in behind it
          if (this.conflicts(mv.v, mv.e, mv.lane, mv.n, mv.nl, om.e, om.lane, om.n, om.nl)) { this.denyWhy = `crossing car ${o.id} at ${mv.v}`; return null; }
        }
      }
      if (this.playerBlocks(car, mv.v, ctrl)) { this.denyWhy = 'player'; return null; }
    }
    const left = ti.dir === -1 || ti.dir === 2 || path.some((mv) => this.turnInfo(mv.e, mv.n).dir === -1);
    const gapOK = (gapT) => !path.some((mv) => this.approaching(car, mv.v, mv.e, mv.lane, mv.n, mv.nl, gapT));
    let ok = true;
    switch (ctrl) {
      case 'priority': ok = this.yieldRight(car, v, e, n, path[0].nl); break;
      case 'signal': case 'inner': ok = committed || !left || gapOK(4.5); break;
      case 'allway': ok = !this.earlierAtAllWay(car, v, e, n, path[0].nl); break;
      case 'stop': ok = gapOK(car.pers.gap * (car.waitT > 15 ? 0.7 : 1)); break;
      case 'yield': ok = gapOK(car.pers.gap * (car.waitT > 15 ? 0.6 : 0.85)); break;
      case 'merge': ok = !this.mergeBlocked(car, v, e, n); break;
    }
    if (!ok) this.denyWhy = 'yielding (' + ctrl + ')';
    return ok ? path : null;
  }

  // route through an intersection cluster, decided when we arrive at it
  planCluster(car) {
    if (car.plan && car.plan.length) return;
    car.plan = null;
    if (!car.edge.entry || !car.next || !car.next.inner) return;
    car.plan = [];
    let cur = car.next;
    const seen = new Set([car.edge.to, cur.to]);
    const entryDir = this.endDir(car.edge);
    while (cur && cur.inner && car.plan.length < 6) {
      const nx = this.pickPlanNext(cur, car, seen, entryDir);
      if (!nx) break;
      car.plan.push(nx);
      seen.add(nx.to);
      cur = nx;
    }
  }

  // ------------------------------------------------------------------ driving
  idm(car, v, v0, gap, vLead) {
    const p = car.pers, a = car.aMax;
    const v0c = Math.max(v0, 0.1);
    const free = v <= v0c ? a * (1 - (v / v0c) ** 4) : -p.b * (1 - Math.pow(v0c / v, (a * 4) / p.b));
    if (gap === Infinity) return free;
    const sStar = p.s0 + Math.max(0, v * p.T + (v * (v - vLead)) / (2 * Math.sqrt(a * p.b)));
    return free - a * (sStar / Math.max(gap, 0.1)) ** 2;
  }

  inLane(o, lane) { return o.lane === lane || (o.lc !== null && o.lc.fromLane === lane); }

  // nearest vehicle ahead in `lane` of e from s, then on n in lane nl (incl. cars merging into n)
  leaderOf(car, e, s, lane, n, nl, maxD = 160) {
    let best = null, bestGap = maxD;
    for (const o of e.cars) {
      if (o === car || !this.inLane(o, lane)) continue;
      if (car.pursuit && o.pullT > 0) continue;
      const d = o.s - s;
      if (d <= 0) continue;
      const gap = d - o.back - car.front;
      if (gap < bestGap) { bestGap = gap; best = o; }
    }
    if (n && e.len - s < maxD) {
      // distance from here to where our junction curve ends on n
      const rOut = this.rOut(n);
      const myRemain = car.curve && car.edge === e ? car.curve.sStart + car.curve.len - s : e.len - this.rIn(e) - s + this.rIn(e) + rOut;
      for (const o of n.cars) {
        if (o === car || !this.inLane(o, nl)) continue;
        if (car.pursuit && o.pullT > 0) continue;
        const gap = myRemain + o.s - rOut - o.back - car.front;
        if (gap < bestGap) { bestGap = gap; best = o; }
      }
      // other cars cleared through the same junction into the same lane: whoever is closer to the exit leads
      const occ = this.occ.get(e.to);
      if (occ) {
        for (const [o, om] of occ) {
          if (o === car || o.edge === e || o.edge === n || om.n !== n || om.nl !== nl || o.edge !== om.e) continue;
          const oe = o.edge;
          const oRemain = o.curve ? o.curve.sStart + o.curve.len - o.s : oe.len - o.s + rOut;
          if (oRemain >= myRemain) continue;
          const gap = myRemain - oRemain - o.back - car.front;
          if (gap < bestGap) { bestGap = gap; best = o; }
        }
      }
    }
    return best ? { gap: bestGap, v: best.mode === 'drive' ? best.speed : 0, car: best } : null;
  }
  followerOf(car, e, s, lane) {
    let best = null, bestGap = 120;
    for (const o of e.cars) {
      if (o === car || !this.inLane(o, lane)) continue;
      const d = s - o.s;
      if (d <= 0) continue;
      const gap = d - car.back - o.front;
      if (gap < bestGap) { bestGap = gap; best = o; }
    }
    return best ? { gap: bestGap, car: best } : null;
  }

  desiredSpeed(car, e) {
    if (car.pursuit) return Math.min(50, Math.max(e.speed * 1.6, 27));
    return Math.min(e.speed * car.v0f, car.maxV);
  }

  // Where must the car's front stop (stop line, red light, junction it isn't cleared for)? null = go.
  holdPoint(car, e, n, ti, sStart, dt) {
    let hold = null;
    car.held = false;
    const v = car.speed, now = this.time;
    const front = car.s + car.front;
    // stop sign
    if (e.stop && !car.stopDone) {
      const sl = Math.min(e.stop.s, sStart - 0.5);
      const d = sl - front;
      if (d < 30) {
        if (d < 3.5 && (v < 0.35 || (car.pers.roll && v < 2.4))) {
          car.stopT += dt;
          if (car.stopT > (car.pers.roll ? 0 : 0.8)) { car.stopDone = true; car.arrT = now; }
        }
        if (!car.stopDone) { hold = sl; car.held = true; car.why = 'stop sign'; }
      }
    }
    // wrong lane for where we're going and no other way out: wait near the end and merge over
    if (hold === null && n && !car.lc) {
      const [lo, hi] = this.laneRange(e, n, ti.dir);
      if ((car.lane < lo || car.lane > hi) && sStart - car.s < 60) {
        car.wrongT = (car.wrongT || 0) + (v < 0.5 ? dt : 0);
        const L = car.lane < lo ? car.lane + 1 : car.lane - 1; // one lane at a time
        const clear = car.wrongT > 2 && !this.exitBlocked(n, this.mapLane(e, L, n, ti.dir), car) &&
          !e.cars.some((o) => o !== car && this.inLane(o, L) && o.s - o.back < car.s + car.front + 6 && o.s + o.front > car.s - car.back - 10);
        if (clear) { car.lc = { fromLane: car.lane, fromOff: car.off, t: 0, delay: 0, dur: 1.6 }; car.lane = L; car.wrongT = 0; }
        else { hold = Math.max(front + 0.05, sStart - 7); car.held = true; car.why = 'wrong lane'; }
      }
    }
    // the light is just around a very short approach link: check it before driving onto it
    if (hold === null && n && n.signal && n.len < 25 && this.obeySignals && car.sigCommit !== n) {
      const st = phaseState(n.signal.phase, now + signalOffset(n.signal.si));
      const sl = sStart - 0.5, d = sl - front;
      if (st !== 2 && d > -0.5 && d < (v * v) / (2 * (st === 1 ? 4 : 8)) + 0.5) car.sigCommit = n;
      else if (st !== 2 && d > -0.5) { hold = sl; car.held = true; car.why = 'short signal'; if (car.res.length) this.releaseUnentered(car); }
    }
    // traffic signal
    if (hold === null && e.signal && this.obeySignals && n && !car.rtorStop && car.sigCommit !== e) {
      const st = phaseState(e.signal.phase, now + signalOffset(e.signal.si));
      const sl = Math.min(e.len - 2.5, sStart - 0.5);
      const d = sl - front;
      // too close to stop on yellow (or to stop at all when it just turned red): keep going
      if (st !== 2 && d > -0.5 && d < (v * v) / (2 * (st === 1 ? 4 : 8)) + 0.5) car.sigCommit = e;
      else if (st !== 2 && d > -0.5) {
        // right on red after a full stop (only where the light is at the junction itself)
        if (st === 0 && ti.dir === 1 && this.vJunc[e.to] && d < 3 && v < 0.35) {
          car.stopT += dt;
          if (car.stopT > 1.2) { car.rtorStop = true; car.arrT = now; }
        }
        if (!car.rtorStop) { hold = sl; car.held = true; car.why = 'red light'; if (car.res.length) this.releaseUnentered(car); }
      }
    }
    // junction box
    const vtx = e.to;
    if (hold === null && n && (this.needsRes(e) || this.shortNext(car, n)) && !this.hasRes(car, vtx, e)) {
      const hj = sStart - 0.5;
      const d = hj - front;
      const look = Math.max(20, (v * v) / (2 * 3) + 8); // decide about where comfortable braking would start
      if (d < look) {
        const path = this.mayEnter(car, vtx, e, n, ti);
        if (path) this.reserve(car, path);
        else if (d < (v * v) / (2 * 8.5) - 1) { // can't stop any more
          this.reserve(car, this.reservationPath(car, e, n));
          this.dbg.forced++;
          if (this.dbg.samples.length < 12) this.dbg.samples.push({ e: e.id, len: +e.len.toFixed(0), inner: e.inner, entry: e.entry, d: +d.toFixed(1), v: +v.toFixed(1), s: +car.s.toFixed(1), vtx, junc: this.vJunc[vtx], fromJunc: this.vJunc[e.from], fromCl: this.vCluster[e.from], toCl: this.vCluster[vtx] });
        }
        else { hold = Math.max(hj, front + 0.05); car.yielding = true; car.why = 'junction: ' + this.denyWhy; }
      }
    }
    if (hold === null) car.yielding = false;
    return hold;
  }

  // a point d meters further along the car's own path (lane, junction curve, next road)
  aheadPoint(car, d, out) {
    const e = car.edge;
    if (car.curve) {
      const c = car.curve, u = car.s + d - c.sStart;
      if (u < c.len) {
        const t = Math.max(0, u / c.len), a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, cc = t * t;
        out.x = a * c.x0 + b * c.x1 + cc * c.x2; out.z = a * c.z0 + b * c.z1 + cc * c.z2;
        return out;
      }
      const n = car.next, p = this.pointOn(n, Math.min(n.len, c.rOut + u - c.len), this.laneOffset(n, c.nl));
      out.x = p.x; out.z = p.z;
      return out;
    }
    const s = car.s + d;
    if (s <= e.len || !car.next) {
      const p = this.pointOn(e, Math.min(s, e.len), car.off, car.seg);
      out.x = p.x; out.z = p.z;
      return out;
    }
    const n = car.next, p = this.pointOn(n, Math.min(n.len, s - e.len), this.laneOffset(n, this.mapLane(e, car.lane, n, this.turnInfo(e, n).dir)));
    out.x = p.x; out.z = p.z;
    return out;
  }

  // The player as an obstacle: on our path ahead, or about to cut across it.
  playerAcc(car, v, v0) {
    const P = this.player;
    const dx = P.x - car.x, dz = P.z - car.z;
    if (dx * dx + dz * dz > 95 * 95 || Math.abs((P.y ?? car.y) - car.y) > 4) return Infinity;
    const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
    if (dx * hx + dz * hz < -6) return Infinity; // behind us
    const halfW = (car.width + 1.9) / 2 + 0.35;
    const pts = this._ahead || (this._ahead = Array.from({ length: 17 }, () => ({ x: 0, z: 0 })));
    const reach = Math.min(48, 10 + v * 2.5);
    for (let k = 0; k < 17; k++) this.aheadPoint(car, (k / 16) * reach, pts[k]);
    for (let t = 0; t <= 2.5; t += 0.25) {
      const px = P.x + P.vx * t, pz = P.z + P.vz * t;
      for (let k = 0; k < 17; k++) {
        const d = (k / 16) * reach;
        if (d < v * t - 3) continue; // we'd already be past this spot by then
        if (Math.hypot(px - pts[k].x, pz - pts[k].z) < halfW) {
          const kk = Math.min(16, k + 1), tx = pts[kk].x - pts[Math.max(0, kk - 1)].x, tz = pts[kk].z - pts[Math.max(0, kk - 1)].z, tl = Math.hypot(tx, tz) || 1;
          const pAlong = (P.vx * tx + P.vz * tz) / tl;
          const gap = Math.max(0.1, d - car.front - 2.3);
          const acc = this.idm(car, v, v0, gap, Math.max(0, pAlong));
          if (acc < -6 && t < 1.4 && car.swerveT <= 0) {
            const side = -dx * hz + dz * hx;
            if (Math.abs(side) > 0.25) { car.swerveT = 1.6; car.swerveDir = side > 0 ? -1 : 1; }
          }
          return acc;
        }
      }
    }
    return Infinity;
  }

  // crashed cars and chasing police lying across our path
  obstacleAcc(car, v, v0) {
    let acc = Infinity;
    const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
    for (const o of this.offRoad) {
      if (o === car) continue;
      const dx = o.x - car.x, dz = o.z - car.z;
      if (Math.abs(dx) > 90 || Math.abs(dz) > 90) continue;
      const along = dx * hx + dz * hz;
      if (along < 0 || along > 90) continue;
      const side = -dx * hz + dz * hx;
      if (Math.abs(side) > (car.width + o.width) / 2 + 0.4) continue;
      const ov = o.mode === 'crash' ? o.vx * hx + o.vz * hz : o.speed * Math.cos(o.heading - car.heading);
      acc = Math.min(acc, this.idm(car, v, v0, Math.max(0.1, along - car.front - o.front), Math.max(0, ov)));
    }
    return acc;
  }

  think(car, dt) {
    const e = car.edge, n = car.next, v = car.speed, p = car.pers;
    const ti = this.turnInfo(e, n);
    const rIn = n ? this.rIn(e) : 0;
    const sStart = n ? e.len - rIn : e.len;
    let v0 = this.desiredSpeed(car, e);
    const latA = p.latA;
    // turn ahead: arc tangent to both legs
    if (n && ti.sharp > 0.08) {
      const theta = Math.acos(Math.max(-1, Math.min(1, 1 - ti.sharp)));
      const R = ((rIn + this.rOut(n)) / 2) / Math.max(0.05, Math.tan(theta / 2));
      const vt = Math.max(3.5, Math.sqrt(latA * R));
      v0 = Math.min(v0, car.curve ? vt : Math.sqrt(vt * vt + 2 * p.b * Math.max(0, sStart - car.s)));
    }
    // bends along this edge
    const bs = e.bends, latK = Math.sqrt(latA / 2.8);
    for (let i = 0; i < bs.length; i += 2) {
      const d = bs[i] - car.s;
      if (d < -4 || d > 170) continue;
      const vb = bs[i + 1] * latK;
      v0 = Math.min(v0, Math.sqrt(vb * vb + 2 * p.b * Math.max(0, d)));
    }
    // ease off before a lower limit ahead
    if (n && !car.pursuit) {
      const vn = this.desiredSpeed(car, n);
      if (vn < v0) v0 = Math.min(v0, Math.sqrt(vn * vn + 2 * 1.0 * Math.max(0, e.len - car.s)));
    }

    let acc = this.idm(car, v, v0, Infinity, 0);
    const nl = n ? (car.curve ? car.curve.nl : this.mapLane(e, car.lane, n, ti.dir)) : 0;
    const lead = this.leaderOf(car, e, car.s, car.lane, n, nl);
    if (lead) acc = Math.min(acc, this.idm(car, v, v0, lead.gap, lead.v));
    if (car.lc && car.lc.t < 0.5) {
      const l2 = this.leaderOf(car, e, car.s, car.lc.fromLane, n, nl, 60);
      if (l2) acc = Math.min(acc, this.idm(car, v, v0, l2.gap, l2.v));
    }
    let hold = null;
    if (!car.pursuit && !car.curve) hold = this.holdPoint(car, e, n, ti, sStart, dt);
    else car.held = car.yielding = false;
    if (hold !== null) acc = Math.min(acc, this.idm(car, v, v0, Math.max(0.05, hold - car.s - car.front), 0));
    // reaction time when the way clears (green light, gap found)
    const stopped = hold !== null || (lead && lead.gap < 6 && lead.v < 0.5);
    if (car.wasHeld && !stopped && v < 0.5) car.startDelay = p.react * (0.6 + Math.random() * 0.8);
    car.wasHeld = stopped;
    if (car.startDelay > 0) { car.startDelay -= dt; acc = Math.min(acc, 0); }
    acc = Math.min(acc, this.obstacleAcc(car, v, v0), this.playerAcc(car, v, v0));
    if (car.pullT > 0) {
      car.pullT -= dt;
      acc = Math.min(acc, v > 0.3 ? -Math.min(3.5, 0.55 * v + 0.4) : 0);
    }
    if (car.stunT > 0) { car.stunT -= dt; acc = Math.min(acc, -6); }
    if (car.yielding || car.held) car.waitT += dt;
    car.acc = Math.max(-9, Math.min(car.aMax, acc));
    car.brake = car.acc < -0.7 || (v < 0.3 && (stopped || car.pullT > 0)) ? 1 : 0;

    // lanes, route fixes, signals
    if (!car.curve) this.laneLogic(car, e, n, ti, sStart, dt);
    if (car.lc) car.blink = car.lane > car.lc.fromLane ? -1 : 1;
    else if (car.pullT > 0) car.blink = 1;
    else if (n && (ti.dir === 1 || ti.dir === -1 || ti.dir === 2) && (car.curve || sStart - car.s < 50)) car.blink = ti.dir === 1 ? 1 : -1;
    else car.blink = 0;
  }

  laneLogic(car, e, n, ti, sStart, dt) {
    if (car.lc || (n && this.hasRes(car, e.to, e))) return;
    const distEnd = sStart - car.s;
    const [lo, hi] = this.laneRange(e, n, ti.dir);
    const wrong = car.lane < lo || car.lane > hi;
    // too late to get over: pick a different way out that works from this lane
    if (wrong && n && distEnd < 35 && !car.rerouted && !car.pursuit) {
      car.rerouted = true;
      const alt = (this.out[e.to] || []).filter((o) => o !== e.twin && o !== n).filter((o) => {
        const [a, b] = this.laneRange(e, o, this.turnInfo(e, o).dir);
        return car.lane >= a && car.lane <= b;
      });
      if (alt.length) { car.next = alt[Math.floor(Math.random() * alt.length)]; car.plan = null; this.planCluster(car); }
      return;
    }
    if (e.lanes < 2 || car.pullT > 0) return;
    car.lcTimer -= dt;
    if (car.lcTimer > 0) return;
    car.lcTimer = 0.6 + Math.random() * 0.6;
    const v = car.speed;
    const dur = Math.min(4, 2.2 + v * 0.05) * (car.pers.id === 'aggressive' ? 0.75 : 1);
    if (car.s < 4 || distEnd < v * (dur + 0.7) + 6) return;
    let tries;
    if (wrong && distEnd < 320) tries = [car.lane < lo ? car.lane + 1 : car.lane - 1];
    else tries = [car.lane + 1, car.lane - 1].filter((l) => l >= 0 && l < e.lanes && (distEnd > 150 || (l >= lo && l <= hi)));
    const mandatory = wrong && distEnd < 320;
    for (const L of tries) {
      if (this.mobil(car, e, n, ti, L, mandatory)) {
        car.lc = { fromLane: car.lane, fromOff: car.off, t: 0, delay: car.pers.id === 'aggressive' ? 0.25 : 0.7, dur };
        car.lane = L;
        return;
      }
    }
  }

  // MOBIL: change lanes if it helps us more than it costs the new follower (and is safe)
  mobil(car, e, n, ti, L, mandatory) {
    const v = car.speed, p = car.pers;
    const v0 = this.desiredSpeed(car, e);
    const curL = this.leaderOf(car, e, car.s, car.lane, n, this.mapLane(e, car.lane, n, ti.dir));
    const newL = this.leaderOf(car, e, car.s, L, n, this.mapLane(e, L, n, ti.dir));
    if (newL && newL.gap < 2) return false;
    const fol = this.followerOf(car, e, car.s, L);
    let dFol = 0;
    if (fol) {
      if (fol.gap < 1.5) return false;
      const f = fol.car, fv0 = this.desiredSpeed(f, e);
      const fNew = this.idm(f, f.speed, fv0, fol.gap, v);
      if (fNew < -(mandatory ? 4.5 : 2.5)) return false;
      const fOld = newL ? this.idm(f, f.speed, fv0, fol.gap + car.front + car.back + newL.gap, newL.v) : this.idm(f, f.speed, fv0, Infinity, 0);
      dFol = fNew - fOld;
    }
    if (mandatory) return true;
    const aCur = curL ? this.idm(car, v, v0, curL.gap, curL.v) : this.idm(car, v, v0, Infinity, 0);
    const aNew = newL ? this.idm(car, v, v0, newL.gap, newL.v) : this.idm(car, v, v0, Infinity, 0);
    const keepRight = L > car.lane ? 0.25 : -0.25; // passing on the left takes a bit more reason
    return aNew - aCur + p.p * dFol > p.lcTh + keepRight;
  }

  buildCurve(car) {
    const e = car.edge, n = car.next;
    const ti = this.turnInfo(e, n);
    const nl = this.mapLane(e, car.lane, n, ti.dir);
    const rIn = this.rIn(e), rOut = this.rOut(n);
    const sStart = e.len - rIn;
    const p0 = this.pointOn(e, sStart, car.off);
    const p2 = this.pointOn(n, rOut, this.laneOffset(n, nl));
    const [cx, cz] = this.controlPoint(p0, p2, rIn, rOut);
    let len = 0, lx = p0.x, lz = p0.z;
    for (let k = 1; k <= 10; k++) {
      const t = k / 10, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      const x = a * p0.x + b * cx + c * p2.x, z = a * p0.z + b * cz + c * p2.z;
      len += Math.hypot(x - lx, z - lz); lx = x; lz = z;
    }
    car.curve = { x0: p0.x, z0: p0.z, x1: cx, z1: cz, x2: p2.x, z2: p2.z, len: Math.max(len, 0.5), sStart, rOut, nl };
    car.lc = null;
  }

  transfer(car) {
    const c = car.curve, e = car.edge, n = car.next;
    const over = car.s - (c.sStart + c.len);
    const list = e.cars, i = list.indexOf(car);
    if (i >= 0) list.splice(i, 1);
    car.edge = n;
    car.s = c.rOut + over;
    car.lane = c.nl;
    car.off = this.laneOffset(n, c.nl);
    car.curve = null;
    car.seg = 0;
    n.cars.push(car);
    car.stopDone = false; car.stopT = 0; car.rtorStop = false; car.rerouted = false; car.arrT = 0; car.sigCommit = null;
    car.next = car.plan && car.plan.length ? car.plan.shift() : this.chooseNext(n, car);
    if (car.plan && !car.plan.length) car.plan = null;
    if (n.entry) this.planCluster(car);
  }

  advance(car, dt) {
    car.speed = Math.max(0, car.speed + car.acc * dt);
    car.s += car.speed * dt;
    let e = car.edge;
    // lane change / lateral easing
    if (car.lc) {
      const lc = car.lc;
      if (lc.delay > 0) lc.delay -= dt; else lc.t += dt / lc.dur;
      const k = smooth(Math.min(1, lc.t));
      car.off = lc.fromOff + (this.laneOffset(e, car.lane) - lc.fromOff) * k;
      if (lc.t >= 1) car.lc = null;
    } else if (!car.curve) {
      const target = this.laneOffset(e, car.lane);
      car.off += (target - car.off) * Math.min(1, dt * 2.5);
    }
    // swerve / pull over offsets
    if (car.swerveT > 0) car.swerveT -= dt;
    const swTarget = car.swerveT > 0 ? car.swerveDir * 1.3 : 0;
    car.swerve += (swTarget - car.swerve) * Math.min(1, dt * 3);
    const pullTarget = car.pullT > 0 ? 1.7 : 0;
    car.pullOff += (pullTarget - car.pullOff) * Math.min(1, dt * 1.2);
    // into the junction / onto the next edge
    if (car.next && !car.curve) {
      const sStart = e.len - this.rIn(e);
      if (car.s >= sStart) {
        if (this.needsRes(e) && !this.hasRes(car, e.to, e) && !car.pursuit) { car.s = sStart - 0.01; car.speed = 0; }
        else this.buildCurve(car);
      }
    }
    if (car.curve && car.s >= car.curve.sStart + car.curve.len) {
      this.transfer(car);
      e = car.edge;
    } else if (!car.next && car.s >= e.len) return false;
    this.releasePassed(car);
    // where that puts us
    let px, pz, dx, dz;
    if (car.curve) {
      const c = car.curve, t = Math.max(0, Math.min(1, (car.s - c.sStart) / c.len));
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, cc = t * t;
      px = a * c.x0 + b * c.x1 + cc * c.x2; pz = a * c.z0 + b * c.z1 + cc * c.z2;
      dx = 2 * (1 - t) * (c.x1 - c.x0) + 2 * t * (c.x2 - c.x1); dz = 2 * (1 - t) * (c.z1 - c.z0) + 2 * t * (c.z2 - c.z1);
      if (dx * dx + dz * dz < 1e-8) { dx = c.x2 - c.x0; dz = c.z2 - c.z0; }
    } else {
      const p = this.pointOn(e, Math.min(car.s, e.len), car.off + car.swerve + car.pullOff, car.seg);
      car.seg = p.seg; px = p.x; pz = p.z; dx = p.dx; dz = p.dz;
    }
    const h = Math.atan2(dx, dz);
    if (car.blendT > 0) {
      // easing back onto the road after a crash
      car.blendT = Math.max(0, car.blendT - dt);
      const k = smooth(1 - car.blendT);
      const f = car.blendFrom;
      car.x = f.x + (px - f.x) * k; car.z = f.z + (pz - f.z) * k;
      car.heading = f.heading + wrap(h - f.heading) * k;
    } else {
      car.x = px; car.z = pz;
      car.heading += wrap(h - car.heading) * Math.min(1, dt * 14);
    }
    return true;
  }

  updateTrailer(car) {
    const t = car.trailer;
    if (!t) return;
    const L = car.type.trailerLen;
    const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
    const kx = car.x - hx * (car.len / 2 - 1.3), kz = car.z - hz * (car.len / 2 - 1.3); // fifth wheel
    const dx = kx - t.ax, dz = kz - t.az, d = Math.hypot(dx, dz) || 1;
    const ux = dx / d, uz = dz / d; // the rear axle is dragged toward the kingpin
    t.ax = kx - ux * (L - 2.4); t.az = kz - uz * (L - 2.4);
    t.heading = Math.atan2(ux, uz);
    t.x = kx - ux * (L / 2 - 1.0); t.z = kz - uz * (L / 2 - 1.0);
  }

  // ------------------------------------------------------------------ crashes
  enterCrash(car, vx, vz) {
    this.release(car);
    if (car.mode === 'drive') {
      const list = car.edge.cars, i = list.indexOf(car);
      if (i >= 0) list.splice(i, 1);
    }
    car.mode = 'crash';
    car.vx = vx; car.vz = vz;
    car.restT = 0; car.hazard = true; car.lc = null; car.curve = null; car.speed = 0;
    car.pullT = 0; car.swerve = 0; car.pullOff = 0; car.blink = 0;
  }

  crashStep(car, dt) {
    const sp = Math.hypot(car.vx, car.vz);
    if (sp > 0) { const dec = Math.min(sp, 7 * dt); car.vx -= (car.vx / sp) * dec; car.vz -= (car.vz / sp) * dec; }
    car.w -= Math.sign(car.w) * Math.min(Math.abs(car.w), 2.6 * dt);
    car.x += car.vx * dt; car.z += car.vz * dt;
    car.heading += car.w * dt;
    this.wallBounce(car, 0.3);
    car.speed = sp;
    if (sp < 0.2 && Math.abs(car.w) < 0.05) car.restT += dt;
    if (car.restT > 4.5) {
      const far = Math.hypot(car.x - this.player.x, car.z - this.player.z);
      if (far > 160) return false;
      if (far > 10) this.recover(car); else car.restT = 3.5;
    }
    return true;
  }

  wallBounce(car, restitution) {
    if (!this.buildings) return;
    const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
    for (const off of [car.len * 0.3, -car.len * 0.3]) {
      const cx = car.x + hx * off, cz = car.z + hz * off;
      const r = this.buildings.resolveCircle(cx, cz, car.width / 2);
      if (!r.hit) continue;
      car.x += r.x - cx; car.z += r.z - cz;
      if (car.mode === 'crash') {
        const vn = car.vx * r.nx + car.vz * r.nz;
        if (vn < 0) { car.vx -= (1 + restitution) * vn * r.nx; car.vz -= (1 + restitution) * vn * r.nz; car.w *= 0.6; }
      } else car.speed *= 0.6;
    }
  }

  // nearest edge position for a free-roaming car (aligned with its heading if possible)
  locate(x, z, heading, maxD = 25) {
    const hx = Math.sin(heading), hz = Math.cos(heading);
    let best = null, bestScore = Infinity;
    this.segGrid.forBox(x - maxD, z - maxD, x + maxD, z + maxD, (k) => {
      const ref = this.segRef[k], e = this.edges[Math.floor(ref / 65536)], j = ref % 65536;
      const ax = e.pts[j * 2], az = e.pts[j * 2 + 1], bx = e.pts[j * 2 + 2], bz = e.pts[j * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az) || 1e-6;
      const dx = (bx - ax) / L, dz = (bz - az) / L;
      const t = Math.max(0, Math.min(L, (x - ax) * dx + (z - az) * dz));
      const qx = ax + dx * t, qz = az + dz * t;
      const d = Math.hypot(x - qx, z - qz);
      if (d > maxD) return;
      const score = d + (dx * hx + dz * hz < 0.2 ? 14 : 0);
      if (score < bestScore) {
        bestScore = score;
        const lat = (x - ax) * -dz + (z - az) * dx;
        best = { e, s: Math.max(2, Math.min(e.len - 2, e.cum[j] + t)), lat };
      }
    });
    if (!best) return null;
    let lane = 0, bd = Infinity;
    for (let l = 0; l < best.e.lanes; l++) { const d = Math.abs(this.laneOffset(best.e, l) - best.lat); if (d < bd) { bd = d; lane = l; } }
    best.lane = lane;
    return best;
  }

  recover(car) {
    const loc = this.locate(car.x, car.z, car.heading, 22);
    if (!loc) { car.restT = -20; return; } // stuck somewhere odd: leave it as a wreck for a while
    car.mode = 'drive';
    car.edge = loc.e; car.s = loc.s; car.lane = loc.lane; car.seg = 0;
    car.off = Math.max(-12, Math.min(12, loc.lat));
    car.speed = 0; car.hazard = false; car.w = 0; car.vx = car.vz = 0;
    car.stopDone = false; car.rtorStop = false; car.curve = null; car.lc = null;
    car.next = this.chooseNext(loc.e, car);
    car.plan = null;
    this.planCluster(car);
    loc.e.cars.push(car);
    car.blendT = 1.2; car.blendFrom = { x: car.x, z: car.z, heading: car.heading };
    car.startDelay = 1.5;
  }

  // collision circles of a vehicle body: [x, z, r] list (tractor + trailer)
  circles(car, out) {
    out.length = 0;
    const add = (x, z, h, len, w) => {
      const r = w / 2 + 0.05, hx = Math.sin(h), hz = Math.cos(h);
      const n = Math.max(2, Math.ceil(len / (r * 1.5)));
      for (let i = 0; i < n; i++) {
        const o = -len / 2 + r + ((len - 2 * r) * i) / (n - 1);
        out.push(x + hx * o, z + hz * o, r);
      }
    };
    add(car.x, car.z, car.heading, car.len, car.width);
    if (car.trailer) add(car.trailer.x, car.trailer.z, car.trailer.heading, car.type.trailerLen, 2.6);
    return out;
  }

  velocityOf(car) {
    if (car.mode === 'crash') return [car.vx, car.vz];
    return [Math.sin(car.heading) * car.speed, Math.cos(car.heading) * car.speed];
  }

  // Impulse on `car` at a contact point. n = unit normal from the other body toward `car` (car is pushed
  // along +n), rel = car velocity - other velocity. Returns the impulse magnitude (0 if separating).
  impulse(car, rel, nx, nz, cx, cz, otherMass) {
    const vn = rel[0] * nx + rel[1] * nz;
    if (vn >= 0) return 0;
    const J = (-(1 + 0.25) * vn) / (1 / otherMass + 1 / car.mass);
    const [vx, vz] = this.velocityOf(car);
    const dvA = J / car.mass;
    const big = car.type.big && car.mode === 'drive';
    if (car.mode === 'crash' || (!big && dvA > 0.6) || dvA > 1.6) {
      if (car.mode !== 'crash') { this.enterCrash(car, vx, vz); car.w = 0; }
      car.vx += nx * dvA; car.vz += nz * dvA;
      // spin from where we got hit
      const rx = cx - car.x, rz = cz - car.z;
      const Fx = nx * J, Fz = nz * J;
      const I = (car.mass * (car.len * car.len + car.width * car.width)) / 12;
      car.w += Math.max(-4, Math.min(4, (Fx * rz - Fz * rx) / I));
    } else {
      car.speed = Math.max(0, car.speed - dvA * 1.5);
      car.stunT = 1.5;
      car.hazard = true;
    }
    return J;
  }

  // Player vs traffic. Called from the player's physics step; returns the player's response.
  collidePlayer(player) {
    const mP = 1742;
    const pc = this._pc || (this._pc = []), cc = this._cc || (this._cc = []);
    const hx = Math.sin(player.heading), hz = Math.cos(player.heading);
    pc.length = 0;
    for (const o of [1.25, -1.25]) pc.push(player.x + hx * o, player.z + hz * o, 1.05);
    let best = null;
    for (const car of this.cars) {
      if (!car.yKnown) continue;
      const reach = car.back + car.front + 4;
      if (Math.abs(player.x - car.x) > reach || Math.abs(player.z - car.z) > reach) continue;
      if (Math.abs((player.y || 0) - car.y) > 3) continue; // e.g. one of us is on an overpass
      this.circles(car, cc);
      for (let i = 0; i < pc.length; i += 3) {
        for (let j = 0; j < cc.length; j += 3) {
          const dx = pc[i] - cc[j], dz = pc[i + 1] - cc[j + 1], d = Math.hypot(dx, dz), min = pc[i + 2] + cc[j + 2];
          if (d < min && d > 1e-4 && (!best || min - d > best.pen)) best = { car, nx: dx / d, nz: dz / d, pen: min - d, cx: cc[j] + (dx / d) * cc[j + 2], cz: cc[j + 1] + (dz / d) * cc[j + 2] };
        }
      }
    }
    if (!best) return null;
    const car = best.car;
    const share = car.mass / (car.mass + mP);
    const out = { nx: best.nx, nz: best.nz, pen: best.pen * share, dvx: 0, dvz: 0, impact: 0, car };
    if (car.mode === 'crash') { car.x -= best.nx * best.pen * (1 - share); car.z -= best.nz * best.pen * (1 - share); }
    const [ax, az] = this.velocityOf(car);
    const rel = [player.vx - ax, player.vz - az];
    const vn = rel[0] * best.nx + rel[1] * best.nz;
    if (vn < 0) {
      // AI car's view: normal from the player toward it, velocity relative to the player
      const J = this.impulse(car, [-rel[0], -rel[1]], -best.nx, -best.nz, best.cx, best.cz, mP);
      out.dvx = (J / mP) * best.nx; out.dvz = (J / mP) * best.nz;
      out.impact = -vn;
      if (-vn > 1) this.events.push({ type: 'hit', car, speed: -vn, time: this.time });
    }
    return out;
  }

  // crashed cars sliding into other traffic
  crashChain() {
    const ca = this._ca || (this._ca = []), cb = this._cb || (this._cb = []);
    for (const a of this.cars) {
      if (a.mode !== 'crash' || Math.hypot(a.vx, a.vz) < 1) continue;
      this.circles(a, ca);
      for (const b of this.cars) {
        if (b === a || !b.yKnown) continue;
        const reach = a.back + b.back + a.front + b.front;
        if (Math.abs(a.x - b.x) > reach || Math.abs(a.z - b.z) > reach) continue;
        this.circles(b, cb);
        let hit = null;
        for (let i = 0; i < ca.length && !hit; i += 3) {
          for (let j = 0; j < cb.length; j += 3) {
            const dx = cb[j] - ca[i], dz = cb[j + 1] - ca[i + 1], d = Math.hypot(dx, dz);
            if (d < ca[i + 2] + cb[j + 2] && d > 1e-4) { hit = { nx: dx / d, nz: dz / d, cx: cb[j] - (dx / d) * cb[j + 2], cz: cb[j + 1] - (dz / d) * cb[j + 2] }; break; }
          }
        }
        if (!hit) continue;
        // normal points from a toward b; b gets pushed along it, a away from it
        const [bvx, bvz] = this.velocityOf(b);
        const rel = [bvx - a.vx, bvz - a.vz];
        const J = this.impulse(b, rel, hit.nx, hit.nz, hit.cx, hit.cz, a.mass);
        if (J > 0) { a.vx -= (hit.nx * J) / a.mass; a.vz -= (hit.nz * J) / a.mass; }
      }
    }
  }

  // ------------------------------------------------------------------ police support
  startPursuit(car) {
    if (car.pursuit) return;
    car.pursuit = true;
    car.pers = PURSUIT;
    car.aMax = PURSUIT.a * car.type.accel;
    this.release(car);
    car.held = car.yielding = false;
    car.stopDone = true;
  }
  endPursuit(car) {
    if (!car.pursuit) return;
    car.pursuit = false;
    car.pers = PERSONALITIES[1];
    car.aMax = car.pers.a * car.type.accel;
    car.lightsT = 3;
    if (car.mode === 'chase') {
      car.restT = 0;
      this.recover(car);
      if (car.mode !== 'drive') this.removeCar(car);
    }
  }
  spawnPursuer(px, pz, heading) {
    // prefer roads behind you, out of sight
    for (let k = 0; k < 4; k++) {
      const c = this.spawnNear(px, pz, 170, 290, { police: true });
      if (!c) continue;
      const behind = (c.x - px) * Math.sin(heading) + (c.z - pz) * Math.cos(heading) < 0;
      if (behind || k === 3) { this.startPursuit(c); return c; }
      this.removeCar(c);
    }
    return null;
  }

  // shortest road distance from every junction to the player (backward Dijkstra)
  updateNav() {
    const P = this.player;
    const loc = this.locate(P.x, P.z, P.heading, 60);
    if (!loc) return;
    const V = this.vx.length;
    const dist = this.navDist && this.navDist.length === V ? this.navDist : new Float64Array(V);
    dist.fill(Infinity);
    const heap = [];
    const push = (v, d) => {
      if (d >= dist[v]) return;
      dist[v] = d;
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    push(loc.e.from, loc.s);
    push(loc.e.to, loc.e.len - loc.s);
    while (heap.length) {
      const [d, v] = pop();
      if (d > dist[v]) continue;
      if (d > 6000) break;
      for (const f of this.vIn[v]) push(f.from, d + f.len);
    }
    this.navDist = dist;
  }

  chaseStep(car, dt) {
    const P = this.player;
    const tx = P.x + P.vx * 0.5, tz = P.z + P.vz * 0.5;
    const dx = tx - car.x, dz = tz - car.z, dist = Math.hypot(dx, dz);
    const psp = Math.hypot(P.vx, P.vz);
    const want = Math.atan2(dx, dz);
    const dh = wrap(want - car.heading);
    const maxTurn = Math.min(2.4, 0.4 + Math.abs(car.speed) * 0.18);
    if (car.speed >= 0) car.heading += Math.max(-maxTurn * dt, Math.min(maxTurn * dt, dh));
    else car.heading -= Math.max(-maxTurn * dt, Math.min(maxTurn * dt, dh)) * 0.6;
    let target = dist > 30 ? Math.min(55, psp + 12) : dist > 12 ? psp + 4 : Math.max(0, psp - 0.5);
    if (Math.abs(dh) > 1.1) target = Math.min(target, 9);
    if (car.chaseStuck > 2.5) target = -5; // back up and try again
    car.speed += Math.max(-9 * dt, Math.min(5 * dt, target - car.speed));
    car.x += Math.sin(car.heading) * car.speed * dt;
    car.z += Math.cos(car.heading) * car.speed * dt;
    this.wallBounce(car, 0.2);
    if (Math.abs(car.speed) < 1 && dist > 14) car.chaseStuck += dt; else car.chaseStuck = Math.max(0, car.chaseStuck - dt * 2);
    if (car.chaseStuck > 3.5) car.chaseStuck = 0;
    car.brake = target < car.speed - 1 ? 1 : 0;
    if (dist > 130) { this.recover(car); if (car.mode === 'drive') car.startDelay = 0; }
  }

  // ------------------------------------------------------------------ main loop
  // Switch between flat (classic) and mesh-following (photoreal) heights.
  setGround(ground, groundInit, { cheap = false, blobs = true } = {}) {
    this.ground = ground;
    this.groundInit = groundInit;
    this.groundCheap = cheap;
    this.blobMesh.visible = !!groundInit && blobs;
    for (const c of this.cars) { c.yKnown = !groundInit; if (!groundInit) c.y = c.ty = 0; }
  }

  update(dt, player, time = performance.now() / 1000) {
    if (!this.enabled) {
      for (const k in this.meshes) this.meshes[k].body.count = this.meshes[k].details.count = 0;
      this.blobMesh.count = 0;
      return;
    }
    dt = Math.min(dt, 0.1);
    this.time = time;
    const P = this.player;
    P.x = player.x; P.z = player.z; P.y = player.y; P.heading = player.heading;
    P.vx = player.vx || 0; P.vz = player.vz || 0;
    this.playerStillT = Math.hypot(P.vx, P.vz) < 0.5 ? (this.playerStillT || 0) + dt : 0;
    const px = player.x, pz = player.z;
    // despawn far cars, top up near the player
    for (const c of this.cars.slice()) {
      const d = Math.hypot(c.x - px, c.z - pz);
      if (d > (c.pursuit ? 1500 : 820)) this.removeCar(c);
    }
    let spawnBudget = this.cars.length < this.maxCars * 0.5 ? 20 : 3;
    while (this.cars.length < this.maxCars && spawnBudget-- > 0) {
      const first = this.cars.length < this.maxCars * 0.5 && !this._seeded;
      this.spawnNear(px, pz, first ? 40 : 260, first ? 620 : 660);
    }
    if (this.cars.length >= this.maxCars * 0.5) this._seeded = true;

    // police: routing toward you, chasing up close, everyone else pulling over
    const pursuers = this.cars.filter((c) => c.pursuit);
    if (pursuers.length) {
      this.navTimer -= dt;
      if (this.navTimer <= 0 && pursuers.some((c) => c.mode === 'drive')) {
        this.navTimer = 1;
        this.updateNav();
        // you're back the other way: swing around right here instead of driving to the next junction
        for (const c of pursuers) {
          const e = c.edge;
          if (c.mode !== 'drive' || c.curve || !e.twin || !this.navDist) continue;
          const ahead = e.len - c.s + this.navDist[e.to], back = c.s + this.navDist[e.from];
          if (back < ahead - 60) {
            this.release(c);
            const list = e.cars, i = list.indexOf(c);
            if (i >= 0) list.splice(i, 1);
            const t = e.twin;
            c.blendFrom = { x: c.x, z: c.z, heading: c.heading }; c.blendT = 1.4;
            c.edge = t; c.s = Math.max(1, t.len - c.s); c.lane = t.lanes - 1; c.off = this.laneOffset(t, c.lane);
            c.speed *= 0.3; c.seg = 0; c.lc = null; c.plan = null;
            c.next = this.chooseNext(t, c);
            t.cars.push(c);
          }
        }
      }
      for (const c of pursuers) {
        if (c.mode === 'drive' && Math.hypot(c.x - px, c.z - pz) < 55 && Math.abs(c.y - (player.y ?? c.y)) < 4) {
          this.release(c);
          const list = c.edge.cars, i = list.indexOf(c);
          if (i >= 0) list.splice(i, 1);
          c.mode = 'chase'; c.curve = null; c.lc = null; c.off = 0; c.chaseStuck = 0;
        }
        const hx = Math.sin(c.heading), hz = Math.cos(c.heading);
        for (const o of this.cars) {
          if (o === c || o.police || o.mode !== 'drive' || o.curve) continue;
          const dx = o.x - c.x, dz = o.z - c.z;
          if (Math.abs(dx) > 100 || Math.abs(dz) > 100) continue;
          const along = dx * hx + dz * hz, side = -dx * hz + dz * hx;
          if (along > 0 && along < 100 && Math.abs(side) < 9) o.pullT = 2.2;
        }
      }
    }
    this.offRoad = this.cars.filter((c) => c.mode !== 'drive');

    for (const car of this.cars) if (car.mode === 'drive') this.think(car, dt);
    for (const car of this.cars.slice()) {
      if (car.mode !== 'drive') continue;
      car.resStallT = car.res.length && car.speed < 0.3 && !car.pursuit ? (car.resStallT || 0) + dt : 0;
      if (car.resStallT > 5) { car.resStallT = 0; this.releaseUnentered(car); }
      car.stillT = car.speed < 0.1 && !car.held ? (car.stillT || 0) + dt : 0;
      if (car.stillT > 30) {
        // stuck in a jam where you can't see it: it quietly turns off somewhere
        const dx = car.x - px, dz = car.z - pz, d = Math.hypot(dx, dz);
        const behind = dx * Math.sin(player.heading) + dz * Math.cos(player.heading) < -20;
        if (d > 170 || (d > 50 && behind)) this.removeCar(car);
      }
    }
    for (const car of this.cars.slice()) {
      let alive = true;
      if (car.mode === 'drive') alive = this.advance(car, dt);
      else if (car.mode === 'crash') alive = this.crashStep(car, dt);
      else if (car.mode === 'chase') this.chaseStep(car, dt);
      if (!alive) { this.removeCar(car); continue; }
      if (car.trailer) this.updateTrailer(car);
      if (car.lightsT > 0) car.lightsT -= dt;
    }
    this.crashChain();

    // heights (+ pitch on slopes where ground lookups are cheap)
    if (this.groundInit) {
      const n = this.cars.length;
      let unknownBudget = this.groundCheap ? 1e9 : 8;
      for (const car of this.cars) {
        if (car.yKnown || unknownBudget <= 0) continue;
        unknownBudget--;
        const h = this.groundInit(car.x, car.z, car.mode === 'drive' && !!this.map.roads[car.edge.road].b);
        if (h !== null) { car.y = car.ty = h; car.yKnown = true; }
      }
      if (this.groundCheap) {
        for (const car of this.cars) {
          if (!car.yKnown) continue;
          const h = this.ground(car.x, car.z, car.y);
          if (h !== null) car.ty = h;
          const hx = Math.sin(car.heading) * car.len * 0.4, hz = Math.cos(car.heading) * car.len * 0.4;
          const yf = this.ground(car.x + hx, car.z + hz, car.y + 1), yb = this.ground(car.x - hx, car.z - hz, car.y + 1);
          if (yf !== null && yb !== null) car.pitch = Math.atan2(yb - yf, car.len * 0.8);
          if (car.trailer) {
            const t = car.trailer, th = car.type.trailerLen * 0.4, tx = Math.sin(t.heading) * th, tz = Math.cos(t.heading) * th;
            const ty = this.ground(t.x, t.z, car.y + 1);
            t.y = ty ?? car.y;
            const f = this.ground(t.x + tx, t.z + tz, car.y + 1), b = this.ground(t.x - tx, t.z - tz, car.y + 1);
            t.pitch = f !== null && b !== null ? Math.atan2(b - f, th * 2) : 0;
          }
        }
      } else {
        for (let k = 0; k < Math.min(n, 14); k++) {
          const car = this.cars[(this._rr++) % n];
          if (!car.yKnown) continue;
          const h = this.ground(car.x, car.z, car.y);
          if (h !== null) car.ty = h;
        }
        for (const car of this.cars) if (car.mode === 'chase' && car.yKnown) { const h = this.ground(car.x, car.z, car.y); if (h !== null) car.ty = h; }
        for (const car of this.cars) { car.pitch = 0; if (car.trailer) { car.trailer.y = car.y; car.trailer.pitch = 0; } }
      }
      const kY = this.groundCheap ? 1 : Math.min(1, dt * 6);
      for (const car of this.cars) car.y += (car.ty - car.y) * kY;
    }
    this.render();
  }

  render() {
    const m = this._m, q = this._q, e = this._e, pos = this._p, sc = this._s;
    for (const k in this.meshes) this.meshes[k].n = 0;
    const blink = Math.floor(this.time * 3) % 2 === 0 ? 1 : 0;
    const flash = Math.floor(this.time * 7) % 2 === 0 ? 1 : 2;
    const blobs = this.blobMesh.visible;
    let nb = 0;
    const put = (M, x, y, z, heading, pitch, color, brake, left, right, bar) => {
      const i = M.n++;
      e.set(pitch, heading, 0, 'YXZ');
      q.setFromEuler(e);
      pos.set(x, y, z);
      m.compose(pos, q, sc);
      M.body.setMatrixAt(i, m);
      M.details.setMatrixAt(i, m);
      M.body.setColorAt(i, this._c.setHex(color));
      M.lamps.setXYZW(i, brake, left, right, bar);
    };
    for (const car of this.cars) {
      if (!car.yKnown) continue;
      const left = blink && (car.blink === -1 || car.hazard) ? 1 : 0;
      const right = blink && (car.blink === 1 || car.hazard) ? 1 : 0;
      const bar = car.police && (car.pursuit || car.lightsT > 0) ? flash : 0;
      put(this.meshes[car.type.id], car.x, car.y, car.z, car.heading, car.pitch, car.color, car.brake, left, right, bar);
      if (car.trailer) {
        const t = car.trailer;
        put(this.meshes.trailer, t.x, t.y || car.y, t.z, t.heading, t.pitch, 0xeeeeee, car.brake, left, right, 0);
      }
      if (blobs) {
        const s2 = this._s2 || (this._s2 = new THREE.Vector3());
        s2.set(car.width + 0.6, 1, car.len + 0.6);
        e.set(0, car.heading, 0);
        q.setFromEuler(e);
        pos.set(car.x, car.y, car.z);
        m.compose(pos, q, s2);
        this.blobMesh.setMatrixAt(nb++, m);
      }
    }
    for (const k in this.meshes) {
      const M = this.meshes[k];
      M.body.count = M.details.count = M.n;
      if (M.n) {
        M.body.instanceMatrix.needsUpdate = true;
        M.details.instanceMatrix.needsUpdate = true;
        M.body.instanceColor.needsUpdate = true;
        M.lamps.needsUpdate = true;
      }
    }
    this.blobMesh.count = nb;
    if (blobs) this.blobMesh.instanceMatrix.needsUpdate = true;
  }

  get count() { return this.cars.length; }
}

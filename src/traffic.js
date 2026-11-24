// AI traffic that drives the real OSM road graph (right-hand traffic, respects one-ways).
import * as THREE from 'three';
import { carGeometries, blobTexture } from './car.js';
import { Grid } from './spatial.js';
import { phaseState, signalOffset } from './furniture.js';

const CLASS_WEIGHT = {
  motorway: 3.5, trunk: 3, primary: 3, secondary: 2.5, tertiary: 2,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  unclassified: 1, residential: 0.8, living_street: 0.4, road: 0.8,
};
const DEFAULT_MPH = {
  motorway: 65, trunk: 50, primary: 40, secondary: 35, tertiary: 30, unclassified: 30,
  residential: 25, living_street: 15, road: 25,
  motorway_link: 35, trunk_link: 30, primary_link: 25, secondary_link: 25, tertiary_link: 25,
};
const MPH = 0.44704;
const COLORS = [0xf2f2f2, 0x1c1c1e, 0x8d9399, 0xb5b9bd, 0x24427a, 0x7a1f1f, 0x2e4d35, 0xc9b38a, 0x3c5f8f, 0x9e2b25, 0x5b5f63, 0xe6e0d0, 0x253b52, 0xd4a017];

export class Traffic {
  constructor(map, scene, { maxCars = 150 } = {}) {
    this.map = map;
    this.maxCars = maxCars;
    this.buildGraph();
    const { body, details } = carGeometries();
    this.bodyMesh = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ vertexColors: true }), maxCars);
    this.detailMesh = new THREE.InstancedMesh(details, new THREE.MeshLambertMaterial({ vertexColors: true }), maxCars);
    for (const m of [this.bodyMesh, this.detailMesh]) {
      m.castShadow = true;
      m.frustumCulled = false; // instances move around; bounding sphere would go stale
      m.count = 0;
      scene.add(m);
    }
    // contact shadows (photoreal mode)
    this.blobMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2.5, 5.2).rotateX(-Math.PI / 2).translate(0, 0.06, 0),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, toneMapped: false }),
      maxCars,
    );
    this.blobMesh.frustumCulled = false;
    this.blobMesh.renderOrder = 1;
    this.blobMesh.count = 0;
    this.blobMesh.visible = false;
    scene.add(this.blobMesh);
    // Height providers (set by main for photoreal mode). null = flat world at y=0.
    this.ground = null; // (x, z, y) -> surface height just below y, or null
    this.groundInit = null; // (x, z, onBridge) -> surface height for a freshly spawned car, or null
    this._rr = 0;
    this.cars = [];
    this.free = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
    this.enabled = true;
  }

  buildGraph() {
    const { nodes, roads } = this.map;
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
        lanes, laneW, oneway: !!r.o,
        speed: (r.s || DEFAULT_MPH[r.t] || 25) * MPH,
        weight: CLASS_WEIGHT[r.t] ?? 1,
        twin: null, cars: [],
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
    // Traffic signals: an edge that enters a signalized intersection from outside stops at its end on red.
    const sigs = this.map.furniture?.signals || [];
    const clusterOf = new Map();
    sigs.forEach((s, si) => s.nodes.forEach((n) => clusterOf.set(n, si)));
    let signalEdges = 0;
    for (const e of edges) {
      const si = clusterOf.get(vnode[e.to]);
      if (si === undefined || clusterOf.get(vnode[e.from]) === si) continue;
      const [dx, dz] = this.endDir(e);
      // the pole whose arm we're arriving on (arm points away from the center, we travel toward it)
      let best = null, bestDot = -2;
      for (const p of sigs[si].p) { const d = -(p[2] * dx + p[3] * dz); if (d > bestDot) { bestDot = d; best = p; } }
      e.signal = { si, phase: best ? best[8] : 0 };
      signalEdges++;
    }
    this.signalEdges = signalEdges;
    this.vnode = vnode; this.vertexOf = vertexOf; this.clusterOf = clusterOf;
    this.obeySignals = true;
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

  laneOffset(e, lane) {
    if (e.oneway) return (e.lanes * e.laneW) / 2 - (lane + 0.5) * e.laneW;
    return (lane + 0.5) * e.laneW;
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

  chooseNext(e) {
    const opts = (this.out[e.to] || []).filter((o) => o !== e.twin);
    if (!opts.length) return e.twin; // dead end: U-turn (null if one-way dead end)
    const [ax, az] = this.endDir(e);
    let total = 0;
    const w = opts.map((o) => {
      const [bx, bz] = this.startDir(o);
      const straight = ax * bx + az * bz; // 1 = straight on
      let wt = o.weight * (straight > 0.9 ? 3 : straight > 0.3 ? 1.4 : straight > -0.3 ? 1 : 0.3);
      if (e.weight >= 2.5 && o.weight < 1) wt *= 0.35; // stay on big roads
      total += wt;
      return wt;
    });
    let r = Math.random() * total;
    for (let i = 0; i < opts.length; i++) if ((r -= w[i]) <= 0) return opts[i];
    return opts[opts.length - 1];
  }

  turnSharpness(e, next) {
    if (!next) return 1;
    const [ax, az] = this.endDir(e), [bx, bz] = this.startDir(next);
    return 1 - (ax * bx + az * bz); // 0 straight .. 2 U-turn
  }

  spawnNear(px, pz, minR, maxR) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const d = minR + Math.random() * (maxR - minR);
      const x = px + Math.cos(ang) * d, z = pz + Math.sin(ang) * d;
      const cand = [];
      this.edgeGrid.forBox(x - 100, z - 100, x + 100, z + 100, (id) => cand.push(this.edges[id]));
      if (!cand.length) continue;
      const e = cand[Math.floor(Math.random() * cand.length)];
      if (e.len < 15 || Math.random() > e.weight / 3.5) continue;
      const dd = Math.hypot(e.mx - px, e.mz - pz);
      if (dd < minR || dd > maxR + 100) continue;
      const lane = Math.floor(Math.random() * e.lanes);
      const s = 5 + Math.random() * (e.len - 10);
      if (e.cars.some((c) => c.lane === lane && Math.abs(c.s - s) < 14)) continue;
      return this.addCar(e, s, lane);
    }
    return null;
  }

  addCar(e, s, lane) {
    if (this.cars.length >= this.maxCars) return null;
    const car = {
      edge: e, s, lane, seg: 0,
      speed: e.speed * 0.8,
      mood: 0.88 + Math.random() * 0.24,
      next: null, x: 0, z: 0, heading: 0,
      stopped: 0,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      big: Math.random() < 0.3 ? 1 : 0,
      y: 0, ty: 0, yKnown: !this.groundInit,
    };
    car.next = this.chooseNext(e);
    e.cars.push(car);
    const p = this.pointOn(e, s, this.laneOffset(e, lane));
    car.x = p.x; car.z = p.z; car.heading = Math.atan2(p.dx, p.dz);
    this.cars.push(car);
    return car;
  }

  removeCar(car) {
    const list = car.edge.cars;
    const i = list.indexOf(car);
    if (i >= 0) list.splice(i, 1);
    const j = this.cars.indexOf(car);
    if (j >= 0) this.cars.splice(j, 1);
  }

  clear() {
    for (const c of this.cars.slice()) this.removeCar(c);
  }

  // Gap to the nearest car ahead in the same lane (this edge, then the next one).
  gapAhead(car) {
    let gap = Infinity;
    for (const o of car.edge.cars) {
      if (o === car || o.lane !== car.lane) continue;
      const d = o.s - car.s;
      if (d > 0 && d < gap) gap = d;
    }
    if (gap === Infinity && car.next) {
      const rest = car.edge.len - car.s;
      for (const o of car.next.cars) {
        if (Math.min(o.lane, car.next.lanes - 1) !== Math.min(car.lane, car.next.lanes - 1)) continue;
        const d = rest + o.s;
        if (d < gap) gap = d;
      }
    }
    return gap;
  }

  // Switch between flat (classic) and mesh-following (photoreal) heights.
  setGround(ground, groundInit) {
    this.ground = ground;
    this.groundInit = groundInit;
    this.blobMesh.visible = !!groundInit;
    for (const c of this.cars) { c.yKnown = !groundInit; if (!groundInit) c.y = c.ty = 0; }
  }

  update(dt, player, time = performance.now() / 1000) {
    if (!this.enabled) {
      this.bodyMesh.count = this.detailMesh.count = this.blobMesh.count = 0;
      return;
    }
    const px = player.x, pz = player.z;
    // despawn far cars, top up near the player
    for (const c of this.cars.slice()) {
      if (Math.hypot(c.x - px, c.z - pz) > 800) this.removeCar(c);
    }
    let spawnBudget = this.cars.length < this.maxCars * 0.5 ? 20 : 3;
    while (this.cars.length < this.maxCars && spawnBudget-- > 0) {
      const first = this.cars.length < this.maxCars * 0.5 && !this._seeded;
      this.spawnNear(px, pz, first ? 40 : 260, first ? 600 : 650);
    }
    if (this.cars.length >= this.maxCars * 0.5) this._seeded = true;

    const pfx = Math.sin(player.heading), pfz = Math.cos(player.heading);
    for (const car of this.cars.slice()) {
      const e = car.edge;
      let target = e.speed * car.mood;
      // slow for turns
      const rest = e.len - car.s;
      const sharp = this.turnSharpness(e, car.next);
      if (sharp > 0.3) {
        const turnSpeed = sharp > 1.5 ? 4 : sharp > 0.8 ? 6.5 : 10;
        if (rest < 40) target = Math.min(target, turnSpeed + rest * 0.35);
      }
      // traffic signals: stop on red, and on yellow if there's room to stop comfortably
      if (this.obeySignals && e.signal) {
        const st = phaseState(e.signal.phase, time + signalOffset(e.signal.si));
        if (st !== 2) {
          const stopDist = rest - 2.5;
          const canStop = stopDist > (car.speed * car.speed) / (2 * 5) + 1;
          if (st === 0 ? stopDist > -1 : canStop) target = Math.min(target, stopDist < 0.4 ? 0 : Math.sqrt(2 * 4.5 * stopDist));
        }
      }
      // follow the car ahead
      const gap = this.gapAhead(car);
      if (gap < 40) target = Math.min(target, Math.max(0, (gap - 7) * 0.9));
      // don't run into the player
      const dx = px - car.x, dz = pz - car.z;
      const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
      const along = dx * hx + dz * hz;
      const side = Math.abs(dx * hz - dz * hx);
      if (along > 0 && along < 30 && side < 2.6) target = Math.min(target, Math.max(0, (along - 7) * 0.7));
      if (car.stopped > 0) { car.stopped -= dt; target = 0; }

      const dv = target - car.speed;
      car.speed += Math.max(-9 * dt, Math.min(2.6 * dt, dv));
      if (car.speed < 0) car.speed = 0;
      car.s += car.speed * dt;

      // advance through edges
      let alive = true;
      while (car.s > car.edge.len) {
        const nxt = car.next;
        if (!nxt) { alive = false; break; }
        car.s -= car.edge.len;
        const list = car.edge.cars;
        list.splice(list.indexOf(car), 1);
        car.edge = nxt;
        car.lane = Math.min(car.lane, nxt.lanes - 1);
        car.seg = 0;
        nxt.cars.push(car);
        car.next = this.chooseNext(nxt);
      }
      if (!alive) { this.removeCar(car); continue; }

      const p = this.pointOn(car.edge, car.s, this.laneOffset(car.edge, car.lane), car.seg);
      car.seg = p.seg;
      // smooth position a little so lane-offset jumps at joints don't pop
      const k = Math.min(1, dt * 10);
      car.x += (p.x - car.x) * k;
      car.z += (p.z - car.z) * k;
      const h = Math.atan2(p.dx, p.dz);
      let dh = h - car.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      car.heading += dh * Math.min(1, dt * 8);
    }

    // heights: a few cars per frame (raycasts against the streamed 3D mesh)
    if (this.groundInit) {
      const n = this.cars.length;
      let unknownBudget = 8;
      for (const car of this.cars) {
        if (car.yKnown || unknownBudget <= 0) continue;
        unknownBudget--;
        const h = this.groundInit(car.x, car.z, !!this.map.roads[car.edge.road].b);
        if (h !== null) { car.y = car.ty = h; car.yKnown = true; }
      }
      for (let k = 0; k < Math.min(n, 14); k++) {
        const car = this.cars[(this._rr++) % n];
        if (!car.yKnown) continue;
        const h = this.ground(car.x, car.z, car.y);
        if (h !== null) car.ty = h;
      }
      const kY = Math.min(1, dt * 6);
      for (const car of this.cars) car.y += (car.ty - car.y) * kY;
    }

    // render
    const m = this._m, q = this._q, pos = this._p, s = this._s;
    let i = 0;
    for (const car of this.cars) {
      if (!car.yKnown) continue; // don't draw until we know where the ground is
      q.setFromAxisAngle(this._up, car.heading);
      pos.set(car.x, car.y, car.z);
      if (car.big) s.set(1.06, 1.18, 1.08); else s.set(1, 1, 1);
      m.compose(pos, q, s);
      this.bodyMesh.setMatrixAt(i, m);
      this.detailMesh.setMatrixAt(i, m);
      this.bodyMesh.setColorAt(i, this._c.setHex(car.color));
      if (this.blobMesh.visible) this.blobMesh.setMatrixAt(i, m);
      i++;
    }
    this.bodyMesh.count = this.detailMesh.count = i;
    if (this.blobMesh.visible) { this.blobMesh.count = i; this.blobMesh.instanceMatrix.needsUpdate = true; }
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.detailMesh.instanceMatrix.needsUpdate = true;
    if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
  }

  // Circle-vs-circle with the player. Returns push normal for the player or null.
  collidePlayer(player) {
    let best = null;
    for (const car of this.cars) {
      const dx = player.x - car.x, dz = player.z - car.z;
      if (Math.abs(dx) > 6 || Math.abs(dz) > 6) continue;
      if (!car.yKnown || Math.abs((player.y || 0) - car.y) > 3) continue; // e.g. one of us is on an overpass
      // test player's two circles against the AI car's two circles
      const pf = [Math.sin(player.heading), Math.cos(player.heading)];
      const cf = [Math.sin(car.heading), Math.cos(car.heading)];
      for (const po of [1.25, -1.25]) {
        for (const co of [1.25, -1.25]) {
          const ax = player.x + pf[0] * po, az = player.z + pf[1] * po;
          const bx = car.x + cf[0] * co, bz = car.z + cf[1] * co;
          const ddx = ax - bx, ddz = az - bz;
          const d = Math.hypot(ddx, ddz);
          if (d < 2.1 && d > 1e-4) {
            const pen = 2.1 - d;
            if (!best || pen > best.pen) best = { nx: ddx / d, nz: ddz / d, pen, car };
          }
        }
      }
    }
    if (best) {
      best.car.stopped = 2.5;
      best.car.speed *= 0.3;
    }
    return best;
  }

  get count() { return this.cars.length; }
}

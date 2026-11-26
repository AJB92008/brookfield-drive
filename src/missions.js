// Mission mode: timed runs from wherever you are to a destination. Press N for the mission list.
//  - A route (shortest by travel time at posted limits, one-ways respected, service roads and parking
//    aisles included for the last bit) is drawn on the minimap and the big map and follows you if you
//    leave it.
//  - A light beacon stands over the destination; an on-screen label (or an edge arrow when it's off
//    screen) shows where it is and how far.
//  - Par = the route's time at the speed limits from where you started. Gold <= 50% of par, silver <=
//    65%, bronze <= 85% (see MEDALS). No other rules: only your time counts. Best results are saved.
import * as THREE from 'three';
import { computeSpeedLimits } from './speedlimits.js';

const MPH = 0.44704;
export const MISSIONS = [
  {
    id: 'kings-ridge', name: '15185 Kings Ridge Ct.', sub: 'Kings Ridge Court, Brookfield',
    // the house isn't mapped in OpenStreetMap; by the street's numbering it's on the northwest side of
    // the cul-de-sac bulb next to 15165, so the destination is the curb in front of it
    x: 2090, z: -745, r: 15, color: 0xff3fd2, // magenta: stands out against sky, trees and the minimap
  },
  {
    id: 'brookfield-square', name: 'Brookfield Square', sub: 'Mall at Moorland & Bluemound',
    x: 1200, z: 3209, r: 30, color: 0xffb02e, // west entrance parking aisle
  },
];
const MIN_RUN = 400; // m by road
// fractions of par. Calibrated with a scripted driver (no traffic, full throttle on straights, braking
// for corners): it finished both runs in 41-42% of par, so gold is that pace plus ~20%
const MEDALS = [['gold', 0.5], ['silver', 0.65], ['bronze', 0.85]];
const fmt = (t) => {
  if (!Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

// ------------------------------------------------------------------ router
class Router {
  constructor(map, roadIndex) {
    const { nodes, roads } = map;
    this.nodes = nodes;
    this.ri = roadIndex;
    const N = nodes.length / 2;
    const lim = computeSpeedLimits(map).mph;
    // directed edges (u -> v, cost in seconds at the limit) in CSR form, forward and reverse
    const eu = [], ev = [], ec = [];
    this.segA = []; this.segB = []; this.segOne = []; this.segSpeed = [];
    // service roads are slow on purpose so routes only use them to reach a destination (parking lots,
    // driveways), not to cut corners between real streets
    const SERVICE_MPH = { '': 12, alley: 8, driveway: 6, parking_aisle: 8, 'drive-through': 4, slipway: 8 };
    roads.forEach((r, ri) => {
      const closed = r.t === 'service' && !((r.sv || '') in SERVICE_MPH);
      const speed = (r.t === 'service' ? SERVICE_MPH[r.sv || ''] ?? 8 : Math.max(20, lim[ri] || 25)) * MPH;
      for (let k = 0; k < r.nd.length - 1; k++) {
        const a = r.nd[k], b = r.nd[k + 1];
        const len = Math.hypot(nodes[b * 2] - nodes[a * 2], nodes[b * 2 + 1] - nodes[a * 2 + 1]);
        // same order as RoadIndex's segments, so its spatial grid can be reused for snapping
        this.segA.push(a); this.segB.push(b); this.segOne.push(!!r.o); this.segSpeed.push(speed);
        if (closed) continue; // emergency access lanes
        eu.push(a); ev.push(b); ec.push(len / speed);
        if (!r.o) { eu.push(b); ev.push(a); ec.push(len / speed); }
      }
    });
    const build = (from, to) => {
      const start = new Int32Array(N + 1);
      for (const u of from) start[u + 1]++;
      for (let i = 0; i < N; i++) start[i + 1] += start[i];
      const fill = start.slice(0, N), adj = new Int32Array(from.length), cost = new Float32Array(from.length);
      for (let i = 0; i < from.length; i++) { const k = fill[from[i]]++; adj[k] = to[i]; cost[k] = ec[i]; }
      return { start, adj, cost };
    };
    this.fwd = build(eu, ev);
    this.rev = build(ev, eu);
    this.N = N;
  }

  // segments near (x, z): [{ s, t, d, px, pz }]
  near(x, z, r) {
    const ri = this.ri, out = [], seen = new Set();
    ri.grid.forBox(x - r, z - r, x + r, z + r, (s) => {
      if (seen.has(s)) return;
      seen.add(s);
      const ax = ri.ax[s], az = ri.az[s], bx = ri.bx[s], bz = ri.bz[s];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
      const px = ax + ex * t, pz = az + ez * t, d = Math.hypot(x - px, z - pz);
      if (d <= r) out.push({ s, t, d, px, pz, len: Math.sqrt(L2), dx: ex / Math.sqrt(L2), dz: ez / Math.sqrt(L2) });
    });
    return out;
  }

  // travel time from every node to the target point (backward Dijkstra)
  setTarget(x, z) {
    const key = `${x},${z}`;
    this.cache ??= new Map();
    const hit = this.cache.get(key);
    if (hit) { this.target = hit.target; this.dist = hit.dist; return true; }
    const cands = this.near(x, z, 120).sort((a, b) => a.d - b.d);
    if (!cands.length) return false;
    const c = cands[0];
    this.target = { x, z, s: c.s, t: c.t, px: c.px, pz: c.pz };
    const dist = new Float64Array(this.N).fill(Infinity);
    const heap = [];
    const push = (v, d) => {
      if (d >= dist[v]) return;
      dist[v] = d; heap.push([d, v]);
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
    const s = c.s, a = this.segA[s], b = this.segB[s], seg = c.len / this.segSpeed[s];
    push(a, c.t * seg); // reach it driving a -> b
    if (!this.segOne[s]) push(b, (1 - c.t) * seg);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      const { start, adj, cost } = this.rev;
      for (let k = start[u]; k < start[u + 1]; k++) push(adj[k], d + cost[k]);
    }
    this.dist = dist;
    this.cache.set(key, { target: this.target, dist });
    return true;
  }

  // route from (x, z) facing `heading`: { pts: [x, z, ...], time (s at the limits), length (m) }
  route(x, z, heading) {
    if (!this.dist) return null;
    const D = this.dist, nodes = this.nodes, T = this.target;
    const hx = Math.sin(heading), hz = Math.cos(heading);
    let best = null;
    let cands = [];
    for (const r of [45, 150, 400]) { cands = this.near(x, z, r); if (cands.length) break; } // off-road: find the nearest road
    let dMin = Infinity;
    for (const c of cands) dMin = Math.min(dMin, c.d);
    for (const c of cands) {
      const s = c.s, a = this.segA[s], b = this.segB[s], seg = c.len / this.segSpeed[s];
      // stay on the road you're on: hopping to one farther away (the other side of a median, a parallel
      // street) costs a lot
      const hop = c.d / 8 + Math.max(0, c.d - dMin - 5) * 3;
      const opts = [[b, (1 - c.t) * seg, c.dx * hx + c.dz * hz]];
      if (!this.segOne[s]) opts.push([a, c.t * seg, -(c.dx * hx + c.dz * hz)]);
      for (const [end, toEnd, align] of opts) {
        if (!Number.isFinite(D[end])) continue;
        let total = toEnd + D[end] + hop + (align < -0.2 ? 12 : 0); // turning around costs time
        // already on the target's segment, heading toward it
        if (s === T.s) {
          const ahead = end === b ? T.t >= c.t : T.t <= c.t;
          if (ahead) total = Math.abs(T.t - c.t) * seg + hop;
        }
        if (!best || total < best.total) best = { total, end, c, direct: s === T.s && total < toEnd + D[end] };
      }
    }
    if (!best) return null;
    const pts = [best.c.px, best.c.pz];
    let time = best.total, u = best.end;
    if (!best.direct) {
      pts.push(nodes[u * 2], nodes[u * 2 + 1]);
      const { start, adj, cost } = this.fwd;
      for (let step = 0; step < 6000; step++) {
        const s = T.s, a = this.segA[s], b = this.segB[s];
        // the target is on the next stretch: finish there
        if ((u === a && Math.abs(D[u] - T.t * (this.segLen(s) / this.segSpeed[s])) < 1e-3) || (u === b && !this.segOne[s] && Math.abs(D[u] - (1 - T.t) * (this.segLen(s) / this.segSpeed[s])) < 1e-3)) break;
        let nv = -1, nd = Infinity;
        for (let k = start[u]; k < start[u + 1]; k++) { const d = cost[k] + D[adj[k]]; if (d < nd) { nd = d; nv = adj[k]; } }
        if (nv < 0) break;
        u = nv;
        pts.push(nodes[u * 2], nodes[u * 2 + 1]);
      }
    }
    pts.push(T.px, T.pz, T.x, T.z);
    let length = 0;
    for (let i = 2; i < pts.length; i += 2) length += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    return { pts, time, length };
  }
  segLen(s) { const a = this.segA[s], b = this.segB[s], n = this.nodes; return Math.hypot(n[b * 2] - n[a * 2], n[b * 2 + 1] - n[a * 2 + 1]); }
}

// ------------------------------------------------------------------ beacon
function makeBeacon(color) {
  const g = new THREE.Group();
  const mat = (opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
  // light column: soft outer shell + bright core, fading out with height (vertex alpha via a gradient texture)
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const ctx = c.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, 128);
  // alphaMap reads the green channel: opaque grayscale, black (clear) at the top to white at the base
  grd.addColorStop(0, '#000');
  grd.addColorStop(0.35, '#666');
  grd.addColorStop(0.8, '#eee');
  grd.addColorStop(1, '#fff');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 4, 128);
  const fade = new THREE.CanvasTexture(c);
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 400, 28, 1, true).translate(0, 200, 0), mat(0.38));
  outer.material.alphaMap = fade;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 400, 12, 1, true).translate(0, 200, 0), mat(0.9));
  core.material.alphaMap = fade;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2), mat(0.85));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), mat(0.18));
  for (const m of [outer, core, ring, disc]) { m.renderOrder = 5; m.frustumCulled = false; g.add(m); }
  g.userData = { ring, disc, outer, core };
  return g;
}

// ------------------------------------------------------------------ missions
export class Missions {
  constructor({ map, roads, scene, player, hud, police, ground }) {
    this.map = map;
    this.player = player;
    this.hud = hud;
    this.police = police;
    this.ground = ground; // (x, z, y) -> height
    this.scene = scene;
    this.router = new Router(map, roads);
    this.active = null; // { m, phase: 'countdown'|'run', t, par, beacon }
    this.result = null;
    this.hold = false; // countdown: keep the car still
    this.routeT = 0;
    try { this.best = JSON.parse(localStorage.getItem('brookfield-drive-missions') || '{}'); } catch { this.best = {}; }
    const $ = (id) => document.getElementById(id);
    this.menu = $('missions');
    this.list = $('missions-list');
    this.hudEl = $('mission-hud');
    this.countEl = $('mission-count');
    this.resultEl = $('mission-result');
    this.marker = $('mission-marker');
    this.buildMenu();
  }

  get running() { return !!this.active; }

  buildMenu() {
    this.list.innerHTML = '';
    MISSIONS.forEach((m, i) => {
      const b = this.best[m.id];
      const btn = document.createElement('button');
      btn.className = 'mission-item';
      btn.innerHTML = `<span class="mi-key">${i + 1}</span><span class="mi-main"><b>${m.name}</b><small>${m.sub}</small></span>` +
        `<span class="mi-best">${b ? `<i class="medal ${b.medal || 'none'}"></i>${fmt(b.time)}<small>par ${fmt(b.par)}</small>` : '<small>not driven yet</small>'}</span>`;
      btn.style.setProperty('--mc', `#${m.color.toString(16).padStart(6, '0')}`);
      btn.addEventListener('click', () => this.start(i));
      this.list.appendChild(btn);
    });
    const ab = document.getElementById('missions-abandon');
    ab.hidden = !this.active;
    ab.onclick = () => { this.abort('Mission abandoned.'); this.toggleMenu(false); };
  }

  toggleMenu(force) {
    const open = force ?? this.menu.hidden;
    if (open) {
      this.buildMenu();
      // distances along the road from here
      const P = this.player;
      [...this.list.children].forEach((el, i) => {
        const m = MISSIONS[i];
        const r = this.router.setTarget(m.x, m.z) && this.router.route(P.x, P.z, P.heading);
        el.querySelector('small').textContent = r ? `${m.sub} · ${fmtDist(r.length)} by road` : `${m.sub} · ${fmtDist(Math.hypot(m.x - P.x, m.z - P.z))} away`;
      });
      if (this.active) this.router.setTarget(this.active.m.x, this.active.m.z); // back to the current mission's table
    }
    this.menu.hidden = !open;
  }

  start(i) {
    const m = MISSIONS[i];
    if (!m) return;
    this.abort();
    this.toggleMenu(false);
    if (!this.router.setTarget(m.x, m.z)) { this.hud.toast("Couldn't find a road to that destination."); return; }
    const P = this.player;
    const route = this.router.route(P.x, P.z, P.heading);
    if (!route) { this.hud.toast("Couldn't find a route from here. Press R to get back on a road."); return; }
    // too short a run makes a meaningless (and farmable) best
    if (route.length < MIN_RUN) { this.hud.toast(`Too close: start at least ${MIN_RUN} m away by road.`, 3500); return; }
    const beacon = makeBeacon(m.color);
    const base = new THREE.Vector3(m.x, (this.ground?.(m.x, m.z) ?? 0) + 0.08, m.z);
    beacon.position.copy(base);
    beacon.userData.ring.scale.setScalar(m.r);
    beacon.userData.disc.scale.setScalar(m.r);
    this.scene.add(beacon);
    // stop the car for the countdown
    P.vx = P.vz = 0; P.speed = 0; P.spin = 0;
    this.active = { m, phase: 'countdown', t: 3, par: route.time + 2, beacon, base, route, groundT: 1 };
    this.hold = true;
    this.police?.reset();
    if (this.police) this.police.suspended = true; // no rules in missions: the police leave you alone
    this.result = null;
    this.resultEl.hidden = true;
    this.hud.route = { pts: route.pts, color: m.color, dest: [m.x, m.z] };
    this.render();
  }

  abort(msg) {
    if (!this.active) return;
    this.scene.remove(this.active.beacon);
    this.active.beacon.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.active = null;
    this.hold = false;
    if (this.police) { this.police.suspended = false; this.police.cool = Math.max(this.police.cool, 5); } // no instant chase for crossing the line at 150 mph
    this.hud.route = null;
    this.countEl.hidden = true;
    this.hudEl.hidden = true;
    this.marker.hidden = true;
    if (msg) this.hud.toast(msg, 3500);
  }

  finish() {
    const a = this.active, m = a.m, time = a.t;
    const ratio = time / a.par;
    const medal = (MEDALS.find(([, k]) => ratio <= k) || [null])[0];
    const prev = this.best[m.id];
    const better = !prev || a.par / time > prev.score;
    if (better) {
      this.best[m.id] = { score: a.par / time, time, par: a.par, medal };
      try { localStorage.setItem('brookfield-drive-missions', JSON.stringify(this.best)); } catch { /* storage blocked */ }
    }
    this.abort();
    this.result = { m, time, par: a.par, medal, better, prev, until: 9 };
    const r = this.result;
    this.resultEl.innerHTML = `<div class="mr-title">${medal ? `<i class="medal ${medal}"></i>${medal[0].toUpperCase() + medal.slice(1)}` : 'Arrived'}</div>` +
      `<div class="mr-dest">${m.name}</div><div class="mr-time">${fmt(time)}</div>` +
      `<div class="mr-sub">par ${fmt(a.par)} · gold ${fmt(a.par * MEDALS[0][1])}</div>` +
      `<div class="mr-sub">${better ? (prev ? 'New best!' : 'First run saved') : `Best: ${fmt(prev.time)} (par ${fmt(prev.par)})`}</div>` +
      '<div class="mr-hint">N for missions</div>';
    this.resultEl.hidden = false;
  }

  update(dt, camera, renderer) {
    if (this.result) {
      this.result.until -= dt;
      if (this.result.until <= 0) { this.resultEl.hidden = true; this.result = null; }
    }
    const a = this.active;
    if (!a) return;
    const P = this.player, m = a.m;
    if (a.phase === 'countdown') {
      a.t -= dt;
      P.vx = P.vz = 0; P.spin = 0; P.gear = 1;
      this.countEl.hidden = false;
      this.countEl.textContent = a.t > 0 ? String(Math.ceil(a.t)) : 'GO!';
      if (a.t <= 0) { a.phase = 'run'; a.t = 0; this.hold = false; this.goT = 0.8; }
    } else {
      a.t += dt;
      if (this.goT > 0) { this.goT -= dt; if (this.goT <= 0) this.countEl.hidden = true; }
      if (Math.hypot(P.x - m.x, P.z - m.z) < m.r) { this.finish(); return; }
    }
    // keep the route current (it follows you if you leave it)
    this.routeT -= dt;
    if (this.routeT <= 0) {
      this.routeT = 0.5;
      const r = this.router.route(P.x, P.z, P.heading);
      if (r) { a.route = r; this.hud.route = { pts: r.pts, color: m.color, dest: [m.x, m.z] }; }
    }
    // re-sample the ground under the beacon (3D-city tiles load in as you get closer; mode switches)
    a.groundT -= dt;
    if (a.groundT <= 0) {
      a.groundT = 1;
      const gy = this.ground?.(m.x, m.z);
      if (gy !== null && gy !== undefined && Number.isFinite(gy)) a.base.y = gy + 0.08;
    }
    // past the far plane, draw a scaled-down copy just inside it (same size on screen) so the beacon
    // can be seen from across town
    const cp = camera.position, far = camera.far * 0.85;
    const d = Math.hypot(a.base.x - cp.x, a.base.y - cp.y, a.base.z - cp.z);
    if (d > far) {
      const s = far / d;
      a.beacon.position.set(cp.x + (a.base.x - cp.x) * s, cp.y + (a.base.y - cp.y) * s, cp.z + (a.base.z - cp.z) * s);
      a.beacon.scale.setScalar(s);
    } else {
      a.beacon.position.copy(a.base);
      a.beacon.scale.setScalar(1);
    }
    // the column widens with distance so it stays at least ~9 px wide on screen
    const focal = innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const w = Math.max(1, (9 * d) / (2 * 2.6 * focal));
    const h = Math.max(1, (d * 0.25) / 400); // and rises at least ~14 degrees, above the treetops
    a.beacon.userData.outer.scale.set(w, h, w);
    a.beacon.userData.core.scale.set(w, h, w);
    // beacon ring pulses
    const k = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    a.beacon.userData.ring.material.opacity = 0.55 + 0.4 * k;
    this.render();
    this.placeMarker(camera, renderer);
  }

  render() {
    const a = this.active;
    if (!a) return;
    this.hudEl.hidden = false;
    const left = a.route ? a.route.length : Math.hypot(this.player.x - a.m.x, this.player.z - a.m.z);
    const t = a.phase === 'run' ? a.t : 0;
    const goal = MEDALS.find(([, k]) => t <= a.par * k);
    this.hudEl.innerHTML = `<div class="mh-name" style="--mc:#${a.m.color.toString(16).padStart(6, '0')}">${a.m.name}</div>` +
      `<div class="mh-time">${fmt(t)}</div>` +
      `<div class="mh-row"><span>${fmtDist(left)} to go</span><span>par ${fmt(a.par)}</span></div>` +
      `<div class="mh-row">${goal ? `<span><i class="medal ${goal[0]}"></i>${goal[0]} until ${fmt(a.par * goal[1])}</span>` : '<span>no medal, keep going</span>'}</div>`;
  }

  // label over the destination, or an arrow at the screen edge pointing to it
  placeMarker(camera) {
    const a = this.active, m = a.m;
    const v = this._v || (this._v = new THREE.Vector3());
    v.set(m.x, a.base.y + 4, m.z).project(camera);
    const w = innerWidth, h = innerHeight;
    const d = Math.hypot(this.player.x - m.x, this.player.z - m.z);
    const behind = v.z > 1;
    let sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    if (behind) { sx = w - sx; sy = h - sy; }
    const pad = 44;
    const on = !behind && sx > pad && sx < w - pad && sy > pad && sy < h - pad;
    this.marker.hidden = false;
    this.marker.classList.toggle('edge', !on);
    this.marker.style.setProperty('--mc', `#${m.color.toString(16).padStart(6, '0')}`);
    if (on) {
      this.marker.style.left = `${sx}px`; this.marker.style.top = `${sy}px`;
      this.marker.style.setProperty('--rot', '0rad');
    } else {
      // clamp to the screen edge along the direction from the center
      const cx = w / 2, cy = h / 2, dx = sx - cx, dy = sy - cy;
      const s = Math.min((w / 2 - pad) / Math.abs(dx || 1e-6), (h / 2 - pad) / Math.abs(dy || 1e-6));
      this.marker.style.left = `${cx + dx * s}px`; this.marker.style.top = `${cy + dy * s}px`;
      this.marker.style.setProperty('--rot', `${Math.atan2(dy, dx) + Math.PI / 2}rad`);
    }
    this.marker.querySelector('.mm-dist').textContent = fmtDist(d);
  }
}

// Mission mode: 13 timed A-to-B runs between Brookfield and Waukesha landmarks, in three tiers. Press N for the list.
//  - Every mission has a fixed start (you're taken there, car repaired) and fixed gold/silver/bronze
//    times, so every run of a mission is comparable. No other rules: only your time counts.
//  - The route (fastest at the posted limits, one-ways respected, service roads only for the last bit)
//    is drawn on the minimap and the big map and follows you if you leave it.
//  - A light beam stands over the finish; an on-screen label (or an edge arrow when it's off screen)
//    shows where it is and how far.
//  - Splits at 3/4, 1/2 and 1/4 of the distance to go, against your best run, and a see-through ghost
//    car that replays your best run. Results screen at the finish. Bests and ghosts stay in the browser.
import * as THREE from 'three';
import { computeSpeedLimits } from './speedlimits.js';
import { buildModel } from './sc430.js';

const MPH = 0.44704;
export const TIERS = [
  { id: 'easy', label: 'Easy', color: 0xffd23f },
  { id: 'medium', label: 'Medium', color: 0xff8a2b },
  { id: 'hard', label: 'Hard', color: 0xff3fd2 },
];
const KR = '15185 Kings Ridge Ct.';
// Starts are on the street or lot by each place; finishes are the nearest drivable spot to the building.
// 15185 Kings Ridge Ct. isn't in OpenStreetMap: by the street's numbering it's on the northwest side of the
// cul-de-sac bulb next to 15165, so that finish is the curb there. Brookfield Square's is the west entrance.
// Medal times [gold, silver, bronze] in seconds come from a scripted pure-pursuit driver (traffic off, full
// throttle on straights, braking for corners; best of two runs on a fixed 60 Hz clock):
// gold = its time x1.2, silver x1.6, bronze x2.05.
export const MISSIONS = [
  { id: 'village-errand', tier: 'easy', name: 'Village Errand', from: 'Tonawanda Elementary School', to: 'Elm Grove Village Hall', start: [3632.7, 787.3, -1.624], finish: [3482.5, 1587], r: 20, medals: [76, 101, 129] },
  { id: 'ice-time', tier: 'easy', name: 'Ice Time', from: 'Burleigh Elementary School', to: 'The Ponds of Brookfield Ice Arena', start: [1016.4, -1778.6, -1.622], finish: [122.5, -1042.7], r: 20, medals: [90, 120, 153] },
  { id: 'after-school', tier: 'easy', name: 'After-School Shopping', from: 'Pilgrim Park Middle School', to: 'Brookfield Square', start: [1827.2, 1430.9, -1.835], finish: [1200, 3209], r: 30, medals: [99, 132, 169] },
  { id: 'code-blue', tier: 'easy', name: 'Code Blue', from: 'Brookfield Fire Station No. 1', to: 'Ascension Elmbrook Hospital', start: [108, 336.4, 1.539], finish: [-2276.8, 186.7], r: 20, medals: [112, 150, 192] },
  { id: 'movie-night', tier: 'medium', name: 'Movie Night', from: 'Brookfield Public Library', to: 'Silverspot Cinema', start: [73.1, 631.1, -1.627], finish: [-3018.5, 2928], r: 20, medals: [168, 223, 286] },
  { id: 'last-bell', tier: 'medium', name: 'Last Bell', from: 'Brookfield East High School', to: KR, start: [3002.6, -1947.4, 0.001], finish: [2090, -745], r: 15, medals: [178, 238, 305] },
  { id: 'commute', tier: 'medium', name: 'Morning Commute', from: KR, to: 'Brookfield City Hall', start: [2091.1, -743.3, -1.075], finish: [65.9, 547.5], r: 20, medals: [194, 258, 331] },
  { id: 'rivalry', tier: 'medium', name: 'Rivalry Game', from: 'Brookfield Central High School', to: 'Brookfield East High School', start: [329.3, 542.2, -1.606], finish: [3002.6, -1947.4], r: 20, medals: [219, 292, 374] },
  { id: 'mall-dash', tier: 'hard', name: 'Mall Dash', from: KR, to: 'Brookfield Square', start: [2091.1, -743.3, -1.075], finish: [1200, 3209], r: 30, medals: [224, 299, 383] },
  { id: 'bullseye', tier: 'hard', name: 'Bullseye to Bullseye', from: 'Target (west)', to: 'Target (east)', start: [-4204.7, 2998.4, -0.006], finish: [4480.7, 3094.2], r: 20, medals: [241, 321, 412] },
  { id: 'long-way-home', tier: 'hard', name: 'The Long Way Home', from: 'Brookfield Sports Complex', to: KR, start: [-2271, -4755, -1.569], finish: [2090, -745], r: 15, medals: [286, 382, 489] },
  { id: 'cross-town', tier: 'hard', name: 'Cross-Town', from: 'Brookfield Academy', to: 'Elm Grove Village Hall', start: [-1575.6, -2322.4, -0.325], finish: [3482.5, 1587], r: 20, medals: [322, 429, 550] },
  { id: 'first-bell', tier: 'hard', name: 'First Bell', from: KR, to: 'Catholic Memorial High School', start: [2091.1, -743.3, -1.075], finish: [-7630, 6595.4], r: 20, medals: [512, 682, 874] }, // in Waukesha
];
const MEDAL_NAMES = ['gold', 'silver', 'bronze'];
const SPLITS = [0.75, 0.5, 0.25]; // fraction of the starting route length still to go
const GHOST_HZ = 10; // samples per second: x, y, z, yaw, pitch
const STORE = 'brookfield-drive-missions-v2';
const tierOf = (m) => TIERS.find((t) => t.id === m.tier);
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const medalFor = (m, t) => { const i = m.medals.findIndex((s) => t <= s); return i < 0 ? null : MEDAL_NAMES[i]; };
const fmt = (t) => {
  if (!Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};
const fmtDelta = (d) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}`;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toB64 = (f32) => {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => {
  const s = atob(b64), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
};

// ------------------------------------------------------------------ router
class Router {
  constructor(map, roadIndex, buildings) {
    const { nodes, roads } = map;
    this.nodes = nodes;
    this.ri = roadIndex;
    const N = nodes.length / 2;
    const lim = computeSpeedLimits(map).mph;
    // directed edges (u -> v, cost in seconds at the limit) in CSR form, forward and reverse
    const eu = [], ev = [], ec = [];
    this.segA = []; this.segB = []; this.segOne = []; this.segSpeed = []; this.segBlocked = [];
    // some service drives run under buildings in real life (covered drives, drive-throughs); here the
    // buildings are solid, so those stretches are closed (~50 ms to check; only service roads do this)
    const blocked = (ax, az, bx, bz, L) => {
      if (!buildings) return false;
      for (let d = 1.5; d < L - 1.5; d += 3) if (buildings.buildingAt(ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L) >= 0) return true;
      return false;
    };
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
        const shut = closed || (r.t === 'service' && blocked(nodes[a * 2], nodes[a * 2 + 1], nodes[b * 2], nodes[b * 2 + 1], len));
        this.segA.push(a); this.segB.push(b); this.segOne.push(!!r.o); this.segSpeed.push(speed); this.segBlocked.push(shut);
        if (shut) continue; // emergency access lanes, drives through buildings
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
      if (seen.has(s) || this.segBlocked[s]) return;
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

// ------------------------------------------------------------------ ghost car
function makeGhostModel() {
  const { group, parts } = buildModel(null);
  // the loose-panel copies sit on top of the body: hide them so the see-through ghost isn't patchy
  for (const p of Object.values(parts.panels)) p.pivot.visible = false;
  const mat = new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false });
  group.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 4; } });
  group.visible = false;
  return group;
}

// ------------------------------------------------------------------ missions
export class Missions {
  // teleport(x, z, heading): put the car there, repaired, and reset traffic around it
  // ground(x, z): ground height for the current mode; mode(): 'classic' | 'photo'; damage(): 0..100
  // onRunStart(mission, routePts, [x, z]) / onRunEnd(): a run starts / ends (mission traffic)
  constructor({ map, roads, buildings, scene, player, hud, ground, teleport, mode, damage, onRunStart, onRunEnd, clock }) {
    this.map = map;
    this.player = player;
    this.hud = hud;
    this.ground = ground;
    this.teleport = teleport;
    this.onRunStart = onRunStart; // (mission, route points, start) -> the same traffic every run (main.js)
    this.onRunEnd = onRunEnd;
    this.clock = clock; // () -> mission traffic clock (s since the run began), or null
    this.mode = mode || (() => 'classic');
    this.damage = damage || (() => 0);
    this.scene = scene;
    this.router = new Router(map, roads, buildings);
    this.active = null;
    this.hold = false; // ready + countdown: the car is held still
    this.sel = 0; // menu selection
    this.last = -1; // index of the last mission started (for retry)
    this.ghost = null;
    try { this.ghostOn = localStorage.getItem('brookfield-drive-ghost') !== 'off'; } catch { this.ghostOn = true; }
    try { this.best = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { this.best = {}; }
    const $ = (id) => document.getElementById(id);
    this.menu = $('missions');
    this.list = $('missions-list');
    this.summary = $('missions-summary');
    this.hudEl = $('mission-hud');
    this.introEl = $('mission-intro');
    this.countEl = $('mission-count');
    this.resultEl = $('mission-result');
    this.marker = $('mission-marker');
    this.splitEl = $('mission-split');
    $('missions-abandon').onclick = () => { this.abort('Mission abandoned.'); this.toggleMenu(false); };
    this.resultEl.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'retry') this.retry();
      else if (act === 'menu') { this.closeResult(); this.toggleMenu(true); }
      else if (act === 'close') this.closeResult();
    });
    this.buildMenu();
  }

  get running() { return !!this.active; }
  get menuOpen() { return !this.menu.hidden; }
  get resultOpen() { return !this.resultEl.hidden; }

  // ---------------------------------------------------------------- menu
  buildMenu() {
    const counts = { gold: 0, silver: 0, bronze: 0 };
    for (const m of MISSIONS) { const b = this.best[m.id]; if (b?.medal) counts[b.medal]++; }
    const done = MISSIONS.filter((m) => this.best[m.id]).length;
    this.summary.innerHTML = MEDAL_NAMES.map((n) => `<span><i class="medal ${n}"></i>${counts[n]}</span>`).join('') +
      `<span class="ms-done">${done}/${MISSIONS.length} driven</span>`;
    this.list.innerHTML = '';
    for (const tier of TIERS) {
      const head = document.createElement('div');
      head.className = 'ms-tier';
      head.style.setProperty('--tc', hex(tier.color));
      head.textContent = tier.label;
      this.list.appendChild(head);
      MISSIONS.forEach((m, i) => {
        if (m.tier !== tier.id) return;
        const b = this.best[m.id];
        const btn = document.createElement('button');
        btn.className = 'mission-item' + (i === this.sel ? ' sel' : '');
        btn.dataset.i = i;
        btn.style.setProperty('--mc', hex(tier.color));
        btn.innerHTML = `<span class="mi-main"><b>${esc(m.name)}</b><small>${esc(m.from)} → ${esc(m.to)}</small>` +
          `<span class="mi-medals">${m.medals.map((s, k) => `<span><i class="medal ${MEDAL_NAMES[k]}"></i>${fmt(s)}</span>`).join('')}</span></span>` +
          `<span class="mi-best">${b ? `<span><i class="medal ${b.medal || 'none'}"></i>${fmt(b.time)}</span><small>your best</small>` : '<small>not driven yet</small>'}</span>`;
        btn.addEventListener('click', () => this.start(i));
        btn.addEventListener('mouseenter', () => this.select(i));
        this.list.appendChild(btn);
      });
    }
    document.getElementById('missions-abandon').hidden = !this.active;
  }

  select(i) {
    this.sel = (i + MISSIONS.length) % MISSIONS.length;
    for (const el of this.list.querySelectorAll('.mission-item')) el.classList.toggle('sel', +el.dataset.i === this.sel);
    this.list.querySelector('.mission-item.sel')?.scrollIntoView({ block: 'nearest' });
  }

  // keyboard / gamepad: returns true if the key was used
  nav(dir) { if (!this.menuOpen) return false; this.select(this.sel + dir); return true; }
  confirm() {
    if (this.menuOpen) { this.start(this.sel); return true; }
    if (this.resultOpen) { this.retry(); return true; }
    return false;
  }

  toggleMenu(force) {
    const open = force ?? this.menu.hidden;
    if (open) { this.closeResult(); this.buildMenu(); }
    this.menu.hidden = !open;
    if (open) this.select(this.sel);
  }

  toggleGhost() {
    this.ghostOn = !this.ghostOn;
    try { localStorage.setItem('brookfield-drive-ghost', this.ghostOn ? 'on' : 'off'); } catch { /* storage blocked */ }
    if (this.ghost && !this.ghostOn) this.ghost.visible = false;
    this.hud.toast(`Ghost car ${this.ghostOn ? 'on' : 'off'}`, 1800);
  }

  // ---------------------------------------------------------------- run lifecycle
  retry() { if (this.last >= 0) this.start(this.last); }

  start(i) {
    const m = MISSIONS[i];
    if (!m) return;
    this.abort();
    this.toggleMenu(false);
    this.closeResult();
    this.sel = i;
    this.last = i;
    const [sx, sz, sh] = m.start, [fx, fz] = m.finish;
    if (!this.router.setTarget(fx, fz)) { this.hud.toast("Couldn't find a road to that destination."); return; }
    this.teleport(sx, sz, sh);
    const route = this.router.route(sx, sz, sh);
    if (!route) { this.hud.toast("Couldn't find a route for this mission."); return; }
    const color = tierOf(m).color;
    const beacon = makeBeacon(color);
    const base = new THREE.Vector3(fx, (this.ground?.(fx, fz) ?? 0) + 0.08, fz);
    beacon.position.copy(base);
    beacon.userData.ring.scale.setScalar(m.r);
    beacon.userData.disc.scale.setScalar(m.r);
    this.scene.add(beacon);
    const best = this.best[m.id];
    let ghostData = null;
    if (best?.ghost) { try { ghostData = fromB64(best.ghost); } catch { ghostData = null; } }
    this.active = {
      m, i, color, phase: 'ready', t: 0, count: 3, beacon, base, route, groundT: 0,
      L0: route.length, splits: [], prevRem: route.length, prevT: 0, routeT: 0,
      rec: [], recT: 0, top: 0, dist: 0, best, ghostData, ghostMode: best?.ghostMode, ghostY: null, ghostYT: 0,
    };
    this.hold = true;
    this.onRunStart?.(m, route.pts, [sx, sz]);
    this.hud.route = { pts: route.pts, color, dest: [fx, fz] };
    // start card
    this.introEl.innerHTML = `<div class="mx-tier" style="--tc:${hex(color)}">${tierOf(m).label}</div><div class="mx-name">${esc(m.name)}</div>` +
      `<div class="mx-route">${esc(m.from)} → ${esc(m.to)} · ${fmtDist(route.length)}</div>` +
      `<div class="mx-medals">${m.medals.map((s, k) => `<span><i class="medal ${MEDAL_NAMES[k]}"></i>${fmt(s)}</span>`).join('')}</div>` +
      `<div class="mx-best">${best ? `Your best: ${fmt(best.time)}${best.ghost && this.ghostOn ? ' · ghost on (G)' : ''}` : 'First run'}</div>`;
    this.introEl.hidden = false;
    this.render();
  }

  abort(msg) {
    if (!this.active) return;
    this.onRunEnd?.();
    this.scene.remove(this.active.beacon);
    this.active.beacon.traverse((o) => { o.geometry?.dispose(); o.material?.alphaMap?.dispose(); o.material?.dispose(); });
    this.active = null;
    this.hold = false;
    if (this.ghost) this.ghost.visible = false;
    this.hud.route = null;
    for (const el of [this.countEl, this.hudEl, this.marker, this.introEl, this.splitEl]) el.hidden = true;
    if (msg) this.hud.toast(msg, 3500);
  }

  closeResult() { this.resultEl.hidden = true; }

  finish() {
    const a = this.active, m = a.m, time = a.t;
    this.sample(a, true);
    const medal = medalFor(m, time);
    const prev = this.best[m.id];
    const better = !prev || time < prev.time;
    // splits not reached (e.g. a shortcut past a split point) count as reached at the finish
    while (a.splits.length < SPLITS.length) a.splits.push(time);
    const dmg = this.damage();
    const stats = { top: a.top, avg: a.dist / Math.max(1e-3, time), dist: a.dist, dmg };
    if (better) {
      const entry = { time, medal, splits: a.splits, date: Date.now(), ghostMode: this.mode(), ghost: toB64(new Float32Array(a.rec)) };
      this.best[m.id] = entry;
      try { localStorage.setItem(STORE, JSON.stringify(this.best)); } catch {
        // over quota: keep the time, drop the ghost
        delete entry.ghost;
        try { localStorage.setItem(STORE, JSON.stringify(this.best)); } catch { /* storage blocked */ }
      }
    }
    this.abort();
    this.showResult({ m, time, medal, better, prev, splits: a.splits, stats });
  }

  showResult({ m, time, medal, better, prev, splits, stats }) {
    const color = tierOf(m).color;
    const title = medal ? medal[0].toUpperCase() + medal.slice(1) : 'Finished';
    const bestLine = better
      ? (prev ? `New best! <b class="fast">${fmtDelta(time - prev.time)}</b>` : 'First run: saved as your best')
      : `Best ${fmt(prev.time)} <b class="slow">${fmtDelta(time - prev.time)}</b>`;
    const labels = ['3/4 to go', 'Halfway', '1/4 to go', 'Finish'];
    const rows = [...splits, time].map((t, k) => {
      const ref = prev ? (k < 3 ? prev.splits?.[k] : prev.time) : null;
      const d = Number.isFinite(ref) ? t - ref : null;
      return `<tr><td>${labels[k]}</td><td>${fmt(t)}</td><td class="${d === null ? '' : d <= 0 ? 'fast' : 'slow'}">${d === null ? '' : fmtDelta(d)}</td></tr>`;
    }).join('');
    const mph = (v) => Math.round(v / MPH);
    this.resultEl.style.setProperty('--tc', hex(color));
    this.resultEl.innerHTML =
      `<div class="mr-head"><span class="mr-tier">${tierOf(m).label}</span><span class="mr-dest">${esc(m.name)}</span></div>` +
      `<div class="mr-title">${medal ? `<i class="medal ${medal}"></i>` : ''}${title}</div>` +
      `<div class="mr-time">${fmt(time)}</div>` +
      `<div class="mr-sub">${bestLine}</div>` +
      `<div class="mr-medals">${m.medals.map((s, k) => `<span class="${time <= s ? 'got' : ''}"><i class="medal ${MEDAL_NAMES[k]}"></i>${fmt(s)}</span>`).join('')}</div>` +
      `<div class="mr-cols"><table class="mr-splits"><thead><tr><th>Split</th><th>Time</th><th>${prev ? 'vs best' : ''}</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<dl class="mr-stats"><dt>Top speed</dt><dd>${mph(stats.top)} mph</dd><dt>Average</dt><dd>${mph(stats.avg)} mph</dd>` +
      `<dt>Distance</dt><dd>${fmtDist(stats.dist)}</dd><dt>Damage</dt><dd>${Math.round(stats.dmg)}%</dd></dl></div>` +
      '<div class="mr-actions"><button data-act="retry"><kbd>Enter</kbd> Retry</button><button data-act="menu"><kbd>N</kbd> Missions</button><button data-act="close"><kbd>Esc</kbd> Drive on</button></div>';
    this.resultEl.hidden = false;
  }

  // ghost sample at GHOST_HZ (always at least the final pose)
  sample(a, force) {
    const P = this.player, g = P.group;
    while (force || a.t >= a.recT) {
      a.rec.push(P.x, g.position.y, P.z, P.heading, g.rotation.x);
      a.recT += 1 / GHOST_HZ;
      if (force) break;
    }
  }

  update(dt, camera) {
    const a = this.active;
    if (!a) return;
    const P = this.player, m = a.m, [fx, fz] = m.finish;
    if (a.phase === 'ready') {
      // the 3D city needs its ground under the new start before the clock can run
      P.vx = P.vz = 0; P.spin = 0;
      if (!P.groundPending) a.phase = 'countdown';
      this.countEl.hidden = false;
      this.countEl.textContent = '';
    } else if (a.phase === 'countdown') {
      // on the traffic clock when there's mission traffic, so GO comes at the same moment for the traffic
      const c = this.clock?.();
      if (c !== null && c !== undefined) a.count = Math.min(a.count, 3 - c); else a.count -= dt;
      P.vx = P.vz = 0; P.spin = 0; P.gear = 1;
      this.countEl.hidden = false;
      this.countEl.textContent = a.count > 0 ? String(Math.ceil(a.count)) : 'GO!';
      if (a.count <= 0) { a.phase = 'run'; a.t = 0; this.hold = false; this.goT = 0.8; this.introEl.hidden = true; }
    } else {
      a.t += dt;
      if (this.goT > 0) { this.goT -= dt; if (this.goT <= 0) this.countEl.hidden = true; }
      const v = P.groundSpeed ?? Math.abs(P.speed);
      a.top = Math.max(a.top, v);
      a.dist += v * dt;
      this.sample(a, false);
      if (Math.hypot(P.x - fx, P.z - fz) < m.r) { this.finish(); return; }
    }
    // keep the route current (it follows you if you leave it) and time the splits off the distance to go
    a.routeT -= dt;
    if (a.routeT <= 0) {
      a.routeT = a.phase === 'run' ? 0.25 : 0.5;
      const r = this.router.route(P.x, P.z, P.heading);
      if (r) {
        a.route = r;
        this.hud.route = { pts: r.pts, color: a.color, dest: [fx, fz] };
        if (a.phase === 'run') {
          while (a.splits.length < SPLITS.length && r.length <= a.L0 * SPLITS[a.splits.length]) {
            const thr = a.L0 * SPLITS[a.splits.length];
            const k = a.prevRem > r.length ? (a.prevRem - thr) / (a.prevRem - r.length) : 1;
            const st = a.prevT + (a.t - a.prevT) * Math.max(0, Math.min(1, k));
            a.splits.push(st);
            this.showSplit(a, a.splits.length - 1, st);
          }
          a.prevRem = r.length; a.prevT = a.t;
        }
      }
    }
    if (this.splitT > 0) { this.splitT -= dt; if (this.splitT <= 0) this.splitEl.hidden = true; }
    this.updateGhost(a, dt);
    this.updateBeacon(a, dt, camera);
    this.render();
    this.placeMarker(camera);
  }

  showSplit(a, k, t) {
    const ref = a.best?.splits?.[k];
    const d = Number.isFinite(ref) ? t - ref : null;
    this.splitEl.innerHTML = `<span>${['3/4 to go', 'Halfway', '1/4 to go'][k]}</span><b>${fmt(t)}</b>` +
      (d === null ? '' : `<b class="${d <= 0 ? 'fast' : 'slow'}">${fmtDelta(d)}</b>`);
    this.splitEl.hidden = false;
    this.splitT = 3.5;
  }

  updateGhost(a, dt) {
    const data = a.ghostData;
    if (!data || !this.ghostOn || a.phase !== 'run') { if (this.ghost) this.ghost.visible = false; return; }
    if (!this.ghost) { this.ghost = makeGhostModel(); this.scene.add(this.ghost); }
    const n = data.length / 5;
    const f = Math.min(n - 1, a.t * GHOST_HZ), i = Math.min(n - 2, Math.floor(f)), k = n > 1 ? f - i : 0;
    const at = (j, c) => data[Math.max(0, j) * 5 + c];
    const lerp = (c) => at(i, c) + (at(i + 1, c) - at(i, c)) * k;
    const x = lerp(0), z = lerp(2);
    let dh = at(i + 1, 3) - at(i, 3);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    let y = lerp(1);
    if (a.ghostMode && a.ghostMode !== this.mode()) {
      // recorded in the other look: put it on this look's ground
      a.ghostYT -= dt;
      if (a.ghostYT <= 0 || a.ghostY === null) { a.ghostYT = 0.2; const gy = this.ground?.(x, z); if (Number.isFinite(gy)) a.ghostY = gy; }
      if (a.ghostY !== null) y = a.ghostY;
    }
    this.ghost.position.set(x, y, z);
    this.ghost.rotation.set(lerp(4), at(i, 3) + dh * k, 0, 'YXZ');
    // fade out once it has finished, and when it's right on top of you
    const near = Math.hypot(x - this.player.x, z - this.player.z);
    this.ghost.visible = a.t * GHOST_HZ < n + 15 && near > 1.2;
  }

  updateBeacon(a, dt, camera) {
    const [fx, fz] = a.m.finish;
    // re-sample the ground under the beacon (3D-city tiles load in as you get closer; mode switches)
    a.groundT -= dt;
    if (a.groundT <= 0) {
      a.groundT = 1;
      const gy = this.ground?.(fx, fz);
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
    const k = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    a.beacon.userData.ring.material.opacity = 0.55 + 0.4 * k;
  }

  render() {
    const a = this.active;
    if (!a) return;
    this.hudEl.hidden = false;
    const left = a.route ? a.route.length : Math.hypot(this.player.x - a.m.finish[0], this.player.z - a.m.finish[1]);
    const t = a.phase === 'run' ? a.t : 0;
    const k = a.m.medals.findIndex((s) => t <= s);
    this.hudEl.style.setProperty('--mc', hex(a.color));
    this.hudEl.innerHTML = `<div class="mh-name">${esc(a.m.name)}</div>` +
      `<div class="mh-time">${fmt(t)}</div>` +
      `<div class="mh-row"><span>${fmtDist(left)} to go</span><span>${a.best ? `best ${fmt(a.best.time)}` : ''}</span></div>` +
      `<div class="mh-row">${k >= 0 ? `<span><i class="medal ${MEDAL_NAMES[k]}"></i>${MEDAL_NAMES[k]} until ${fmt(a.m.medals[k])}</span>` : '<span>no medal, keep going</span>'}<span class="mh-keys">Backspace restart</span></div>`;
  }

  // label over the destination, or an arrow at the screen edge pointing to it
  placeMarker(camera) {
    const a = this.active, [fx, fz] = a.m.finish;
    const v = this._v || (this._v = new THREE.Vector3());
    v.set(fx, a.base.y + 4, fz).project(camera);
    const w = innerWidth, h = innerHeight;
    const d = Math.hypot(this.player.x - fx, this.player.z - fz);
    const behind = v.z > 1;
    let sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    if (behind) { sx = w - sx; sy = h - sy; }
    const pad = 44;
    const on = !behind && sx > pad && sx < w - pad && sy > pad && sy < h - pad;
    this.marker.hidden = false;
    this.marker.classList.toggle('edge', !on);
    this.marker.style.setProperty('--mc', hex(a.color));
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

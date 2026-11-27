// Damage model for the player's car. Where you hit and what you hit decide what breaks:
//  - 10 zones (front-left / front / front-right, left, right, rear-left / rear / rear-right, roof, underside)
//    take structural damage scaled by the impact energy. Another car shares the energy by mass (a semi is
//    like a wall, a sedan takes half), poles and trees crush one spot deep, walls and cars spread it out.
//  - Parts with their own symptoms: radiator (coolant leak -> temperature climbs -> power loss, misfires,
//    seized engine), engine (direct hits, overheating, low oil, fire), gearbox (top gears lost, jammed in gear,
//    broken driveline), brakes per side (weak, pulls), steering (off-center, less lock), and per wheel:
//    suspension (alignment pull, camber, sag) and tire (slow leak, flat, blowout, shredded to the rim,
//    wheel torn off).
//  - What it looks like: dents, paint scuffed down to bare metal where you scrape, bumpers that hang and drag
//    then drop onto the road (and stay there), a hood that crumples, pops its latch and can fly up at speed,
//    a trunk lid and doors that spring open, a windshield that cracks in spider webs, side windows that
//    shatter, steam, smoke, an engine fire, and oil / coolant puddles where you stop. All of that is visual:
//    only effects() feeds the physics.
//  - effects() turns all of it into what the physics uses (sc430.js reads player.dmg). With no damage it is
//    exactly NO_DAMAGE, so an undamaged car drives as before.
//  - Repairs happen at repair shops (shops.js); repair() restores everything on the car. Parts that fell off
//    stay where they landed.
import * as THREE from 'three';

const M_PLAYER = 1742;
const PAINT = 0xa3101b;
export const NO_DAMAGE = Object.freeze({
  power: 1, drag: 1, pull: 0, grip: 1, wobble: 0, maxGear: 5, stuckGear: 0, brake: 1, brakePull: 0,
  steerLock: 1, rimDrag: 0, engineDead: false, noDrive: false,
});
export const ZONES = ['FL', 'F', 'FR', 'L', 'R', 'RL', 'B', 'RR', 'roof', 'under'];
const NEIGHBORS = { FL: ['F', 'L'], F: ['FL', 'FR'], FR: ['F', 'R'], L: ['FL', 'RL'], R: ['FR', 'RR'], RL: ['L', 'B'], B: ['RL', 'RR'], RR: ['R', 'B'], roof: [], under: [] };
// what you hit: mult = damage per unit of energy, spread = share passed to neighboring zones,
// conc = how hard it bites into parts behind the panel, dent = [depth scale, radius]
const OBJECTS = {
  wall: { mult: 1, spread: 0.3, conc: 1, dent: [1, 1] },
  car: { mult: 1, spread: 0.25, conc: 1, dent: [0.9, 1.05] },
  tree: { mult: 1.1, spread: 0.12, conc: 1.15, dent: [1.25, 0.75] },
  pole: { mult: 1.2, spread: 0.05, conc: 1.3, dent: [1.5, 0.55] },
};
const WHEEL_NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// panels: which zones hit them, how they come loose, and the most they swing open (rad)
const PANELS = {
  bumperF: { zones: ['F', 'FL', 'FR'], kind: 'bumper', end: 1, max: 0.45, label: 'Front bumper' },
  bumperB: { zones: ['B', 'RL', 'RR'], kind: 'bumper', end: -1, max: 0.45, label: 'Rear bumper' },
  hood: { zones: ['F', 'FL', 'FR'], kind: 'hood', max: 1.25, label: 'Hood' },
  trunk: { zones: ['B', 'RL', 'RR'], kind: 'trunk', max: 1.3, label: 'Trunk lid' },
  doorL: { zones: ['L', 'FL', 'RL'], kind: 'door', side: 1, max: 1.25, label: 'Left door' },
  doorR: { zones: ['R', 'FR', 'RR'], kind: 'door', side: -1, max: 1.25, label: 'Right door' },
};
const BARE = [0.07, 0.07, 0.075]; // what's under a panel that's open or gone
const METAL = [0.46, 0.47, 0.49];
const SCUFF = [0.42, 0.16, 0.16]; // dull, hazy red where the clear coat is gone
const SOOT = [0.045, 0.04, 0.035];
const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };

function freshState() {
  return {
    zones: Object.fromEntries(ZONES.map((z) => [z, 0])),
    radiator: 1, coolant: 1, coolantLeak: 0, temp: 90,
    engine: 1, oil: 1, oilLeak: 0, engineDead: false,
    trans: 1, stuckGear: 0,
    brakeL: 1, brakeR: 1,
    steerOffset: 0, steerLock: 1,
    fire: 0, fireT: 0, burnt: false,
    // per wheel: FL, FR, RL, RR (along = + forward, left = + left, car-local meters)
    wheels: [[1.31, 0.78], [1.31, -0.78], [-1.31, 0.79], [-1.31, -0.79]].map(([along, left], i) => ({
      i, along, left, front: i < 2, susp: 1, toe: 0, pressure: 1, leak: 0, state: 'ok', shred: 0,
    })),
    panels: Object.fromEntries(Object.keys(PANELS).map((k) => [k, { state: 'ok', hp: 0, ang: 0, w: 0, ang0: 0, wear: 0, side: 0, flipped: false, tearT: 0 }])),
  };
}

// ---------------------------------------------------------------- glass
// spider-web crack at (u, v): radial cracks with jagged rings between them, kept as strokes in uv space
// (x across, y up) so the same crack can be drawn on the glass texture and, sharp, over the screen
function drawSpider(gl, u, v, size) {
  const R = size * 0.42, aspect = gl.canvas.width / gl.canvas.height; // R in units of the glass height
  const n = 7 + Math.round(size * 7);
  const strokes = [], rays = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5, len = R * (0.55 + Math.random() * 0.5);
    const pts = [[u, v]];
    let x = u, y = v, ang = a;
    for (let d = 0; d < len; d += R * 0.09) {
      ang += (Math.random() - 0.5) * 0.16;
      x += (Math.cos(ang) * R * 0.09) / aspect; y += Math.sin(ang) * R * 0.09;
      pts.push([x, y]);
    }
    rays.push(pts);
    strokes.push({ pts, w: 1.3 });
  }
  for (const f of [0.18, 0.34, 0.55, 0.78]) {
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.3) continue;
      const A = rays[i], B = rays[(i + 1) % n];
      const a = A[Math.min(A.length - 1, Math.round(A.length * f))], b = B[Math.min(B.length - 1, Math.round(B.length * f * (0.85 + Math.random() * 0.3)))];
      const m = [(a[0] + b[0]) / 2 + ((Math.random() - 0.5) * R * 0.06) / aspect, (a[1] + b[1]) / 2 + (Math.random() - 0.5) * R * 0.06];
      strokes.push({ pts: [a, m, b], w: 0.9 });
    }
  }
  const crack = { u, v, R, strokes };
  gl.list = gl.list || [];
  gl.list.push(crack);
  paintCrack(gl.ctx, crack, gl.canvas.width, gl.canvas.height, false);
  gl.cracks += size;
  gl.mesh.visible = true;
  gl.tex.needsUpdate = true;
}

// draw one crack into a W x H canvas (mirror: seen from inside the car)
function paintCrack(ctx, crack, W, H, mirror) {
  const X = (x) => (mirror ? 1 - x : x) * W, Y = (y) => (1 - y) * H;
  const px = H / 256; // line widths are in texture pixels of a 256-high glass
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(238,243,247,0.85)';
  for (const st of crack.strokes) {
    ctx.lineWidth = Math.max(0.75, st.w * px * (mirror ? 0.55 : 1));
    ctx.beginPath();
    st.pts.forEach(([x, y], k) => (k ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke();
  }
  // crushed core where it was hit
  const cx = X(crack.u), cy = Y(crack.v), r = crack.R * H * 0.12;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, 'rgba(245,248,250,0.85)');
  g.addColorStop(1, 'rgba(245,248,250,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
}

// tempered side glass: crazes into little cubes and mostly falls out, leaving a jagged frosted edge
function drawShatter(gl) {
  const { ctx, canvas } = gl, W = canvas.width, H = canvas.height;
  ctx.fillStyle = 'rgba(214,226,232,0.32)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(240,245,248,0.75)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * W, y = Math.random() * H, a = Math.random() * Math.PI, l = 4 + Math.random() * 12;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  // the hole
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  const n = 22;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, r = 0.36 + Math.random() * 0.1;
    const x = W / 2 + Math.cos(a) * W * r, y = H / 2 + Math.sin(a) * H * r * 1.05;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
  gl.shattered = true;
  gl.cracks += 1;
  gl.mesh.visible = true;
  gl.tex.needsUpdate = true;
}

// ---------------------------------------------------------------- puddles
class Puddles {
  constructor(scene) {
    this.max = 160;
    this.list = [];
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2), mat, this.max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Color(); this._e = new THREE.Euler();
    this.dirty = false;
  }
  // a stream of fluid at (x, z): grows the nearest puddle of the same kind, or starts one
  pour(x, y, z, kind, amount, maxR) {
    let best = null, bd = 0.45;
    for (const p of this.list) {
      if (p.kind !== kind) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) {
      if (this.list.length >= this.max) this.list.shift();
      best = { x, y, z, kind, area: 0, maxR, rot: Math.random() * Math.PI, sx: 0.75 + Math.random() * 0.5, age: 0 };
      this.list.push(best);
    }
    best.area = Math.min(Math.PI * best.maxR * best.maxR, best.area + amount);
    best.age = 0;
    this.dirty = true;
  }
  update(dt, px, pz) {
    let n = 0;
    for (const p of this.list) {
      p.age += dt;
      // coolant evaporates, oil soaks in slowly
      const life = p.kind === 'oil' ? 600 : 240;
      if (p.age > life || Math.hypot(p.x - px, p.z - pz) > 1500) continue;
      this.list[n++] = p;
    }
    if (n !== this.list.length) { this.list.length = n; this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    const m = this._m, q = this._q, e = this._e;
    this.list.forEach((p, i) => {
      const r = Math.sqrt(p.area / Math.PI);
      q.setFromEuler(e.set(0, p.rot, 0));
      m.compose(this._v.set(p.x, p.y, p.z), q, this._s.set(r * p.sx, 1, r / p.sx));
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, this._c.setHex(p.kind === 'oil' ? 0x0d0b09 : 0x3fae5a));
    });
    this.mesh.count = this.list.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.list.length) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class DamageModel {
  constructor(player, fx, hud) {
    this.player = player;
    this.fx = fx;
    this.hud = hud;
    this.s = freshState();
    this.parts = player.parts; // body/cabin meshes, lights, mirrors, wheels, panels, glass
    this.panels = this.parts.panels || {};
    this.glass = this.parts.glass || {};
    // everything that dents / scuffs keeps its original shape and colors, plus per-vertex wear and soot
    this.skins = [this.parts.body, this.parts.cabin, ...Object.values(this.panels).map((p) => p.mesh)];
    for (const mesh of this.skins) {
      const g = mesh.geometry;
      mesh.userData.orig = Float32Array.from(g.attributes.position.array);
      mesh.userData.origCol = Float32Array.from(g.attributes.color.array);
      mesh.userData.wear = new Float32Array(g.attributes.position.count);
      mesh.userData.soot = new Float32Array(g.attributes.position.count);
    }
    for (const p of Object.values(this.panels)) { p.pivotHome = p.pivot.position.clone(); p.meshHome = p.mesh.position.clone(); }
    // model wheels in FL, FR, RL, RR order (pivot x > 0 is the car's left)
    this.wheelParts = [0, 1, 2, 3].map((i) => this.parts.wheels.find((w) => w.front === i < 2 && (w.pivot.position.x > 0) === (i % 2 === 0)));
    for (const w of this.wheelParts) w.home = w.pivot.position.clone();
    this.broken = new Set();
    this.brokenMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 });
    this.misfireT = 0; this.misfire = 0;
    this.smokeT = 0; this.sparkT = 0; this.renderT = 0; this.dragT = 0; this.sootT = 0; this.dripD = 0;
    this.time = 0;
    this.events = []; // short messages for the HUD ("Front-left tire blown")
    this.loose = []; // parts lying on the road
    this.puddles = fx.scene ? new Puddles(fx.scene) : null;
    this.insideView = false;
    this.overlay = document.getElementById('crack-overlay');
    this.overlayVer = -1; this.crackVer = 0;
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._e = new THREE.Euler();
    this.onWrecked = null;
    player.dmg = NO_DAMAGE;
    this.buildHud();
    this.apply();
  }

  // ---------------------------------------------------------------- state summaries
  get zones() { return this.s.zones; }
  // 0..100 overall (missions show it)
  get total() {
    const s = this.s, z = s.zones;
    let structural = 0;
    for (const k of ZONES) structural += z[k];
    structural = Math.min(100, structural / 3.2 + Math.max(...Object.values(z)) * 0.3);
    const tires = s.wheels.reduce((a, w) => a + (w.state === 'off' ? 1 : w.state === 'ok' ? 0 : 0.6 - 0.4 * w.pressure + (w.state === 'rim' ? 0.3 : 0)), 0) / 4;
    const susp = s.wheels.reduce((a, w) => a + (1 - w.susp), 0) / 4;
    const parts = ((1 - s.engine) * 1.5 + (1 - s.radiator) + (1 - s.trans) + (2 - s.brakeL - s.brakeR) * 0.5 + tires + susp + Math.abs(s.steerOffset) * 4) / 6.5;
    return Math.min(100, structural * 0.65 + Math.min(1, parts) * 100 * 0.6);
  }
  get wheelsOff() { return this.s.wheels.filter((w) => w.state === 'off').length; }
  // can't drive on: needs a tow
  get wrecked() { const s = this.s; return s.engineDead || s.trans <= 0.08 || this.wheelsOff >= 2; }
  get any() { return this.total >= 0.5; }

  // ---------------------------------------------------------------- what it does to the driving
  effects() {
    const s = this.s, z = s.zones;
    let grip = 0, tirePull = 0, rimDrag = 0;
    for (const w of s.wheels) {
      const g = w.state === 'ok' ? 1 : w.state === 'leak' ? 0.65 + 0.35 * w.pressure : w.state === 'flat' ? 0.5 : w.state === 'rim' ? 0.32 : 0.15;
      grip += g / 4;
      tirePull += (1 - g) * (w.left > 0 ? -1 : 1) * (w.front ? 0.03 : 0.015); // a soft tire drags its side back
      rimDrag += w.state === 'flat' ? 0.012 : w.state === 'rim' ? 0.025 : w.state === 'off' ? 0.07 : 0;
    }
    const side = Math.max(z.L, z.R, z.FL, z.FR, z.RL, z.RR) / 100;
    const toe = s.wheels.reduce((a, w) => a + w.toe * (w.front ? 1 : 0.5), 0);
    const front = Math.min(1, (z.F + 0.5 * (z.FL + z.FR)) / 140);
    const bentFront = Math.max(0, 0.65 - Math.min(s.wheels[0].susp, s.wheels[1].susp));
    // engine output: health, heat, misfires, a slipping gearbox
    const heat = s.temp > 112 ? Math.max(0.35, 1 - (s.temp - 112) / 45) : 1;
    const slip = s.trans < 0.6 ? 0.7 + 0.5 * s.trans : 1;
    const power = (0.3 + 0.7 * s.engine) * heat * slip * (this.misfire > 0 ? 0.15 : 1) * (1 - 0.12 * (z.B / 100));
    const maxGear = s.trans > 0.7 ? 5 : s.trans > 0.5 ? 4 : 3;
    if (this.total < 0.01 && !s.engineDead) return NO_DAMAGE;
    return {
      power: Math.min(1, power),
      drag: 1 + 0.45 * front,
      pull: Math.max(-0.12, Math.min(0.12, s.steerOffset + toe + tirePull)),
      grip: grip * (1 - 0.12 * side),
      wobble: bentFront * 1.6,
      maxGear,
      stuckGear: s.stuckGear,
      brake: 0.3 + 0.35 * (s.brakeL + s.brakeR),
      brakePull: (s.brakeR - s.brakeL) * 0.055, // the stronger side grabs
      steerLock: s.steerLock,
      rimDrag,
      engineDead: s.engineDead,
      noDrive: s.trans <= 0.08,
    };
  }

  // ---------------------------------------------------------------- hits
  // ev: { x, z, nx, nz, impact (closing speed m/s), kind: wall|tree|pole|car, mass (other car) }
  hit(ev) {
    const P = this.player, s = this.s;
    const { x: cx, z: cz, nx, nz, impact, kind } = ev;
    if (impact < 2.2) return;
    const h = P.heading, fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h); // forward, left
    const dx = cx - P.x, dz = cz - P.z;
    const along = dx * fx + dz * fz, left = dx * lx + dz * lz;
    // energy: a fixed object takes the full hit, another car shares it by mass (reduced mass)
    const mEff = kind === 'car' && ev.mass ? (M_PLAYER * ev.mass) / (M_PLAYER + ev.mass) : M_PLAYER;
    const veq = impact * Math.sqrt(mEff / M_PLAYER); // wall-equivalent speed
    const obj = OBJECTS[kind] || OBJECTS.wall;
    const zone = Math.abs(along) > 1.3 ? (along > 0 ? (left > 0.42 ? 'FL' : left < -0.42 ? 'FR' : 'F') : (left > 0.42 ? 'RL' : left < -0.42 ? 'RR' : 'B')) : left > 0 ? 'L' : 'R';
    let dmg = Math.min(80, Math.pow(Math.max(0, veq - 2), 1.35) * 1.15 * obj.mult);
    // one crash often makes several contacts in a row (the other car keeps shoving): count the worst once
    const now = performance.now();
    const recent = this.lastHit && now - this.lastHit.t < 300 && this.lastHit.zone === zone ? this.lastHit.dmg : 0;
    this.lastHit = { t: now, zone, dmg: Math.max(dmg, recent) };
    const sevPrev = recent ? this.lastSev || 0 : 0;
    dmg = Math.max(0, dmg - recent);
    if (dmg <= 0) return;
    s.zones[zone] = Math.min(100, s.zones[zone] + dmg);
    for (const n of NEIGHBORS[zone]) s.zones[n] = Math.min(100, s.zones[n] + dmg * obj.spread);
    // parts behind the panel: only the part of this hit that's new
    const sev = veq * obj.conc;
    this.lastSev = Math.max(sev, sevPrev);
    const fresh = sev > sevPrev;
    if (fresh) this.breakParts(zone, sev, along, left);
    // dent the body where it was hit (push direction in car-local coordinates: x = left, z = forward)
    const pnx = nx * lx + nz * lz, pnz = nx * fx + nz * fz;
    const lp = [Math.max(-0.95, Math.min(0.95, left)), 0.62, Math.max(-2.25, Math.min(2.25, along))];
    this.dentSkin(lp, [pnx, 0, pnz], Math.min(0.45, 0.02 * veq * obj.dent[0]), Math.min(1.2, (0.5 + veq * 0.035) * obj.dent[1]));
    if (Math.abs(along) < 1.2 && veq > 7) this.dent(this.parts.cabin, [lp[0], 1.05, lp[2]], [pnx * 0.7, -0.2, pnz * 0.7], Math.min(0.12, veq * 0.006), 0.7);
    // paint knocked off where it hit
    this.scuff(lp, 0.3 + Math.min(0.5, veq * 0.03), Math.min(1, veq / 14));
    if (fresh) { this.hitPanels(zone, sev, dmg, along, left); this.hitGlass(zone, sev, along, left, kind); }
    // lights and mirrors near the hit
    const near = (p, r) => Math.hypot(p.x - lp[0], p.z - lp[2]) < r;
    for (const [key, mesh] of Object.entries(this.parts.lamps)) {
      if (key === 'grille' || this.broken.has(key) || !near(mesh.position, veq > 9 ? 1.1 : 0.75) || veq < 4.5) continue;
      this.breakLamp(key, nx, nz);
    }
    for (const [key, mesh] of Object.entries(this.parts.mirrors)) {
      if (this.broken.has(key) || !near(mesh.position, 0.9) || veq < 5) continue;
      this.broken.add(key);
      mesh.visible = false;
      const wp = mesh.getWorldPosition(new THREE.Vector3());
      this.fx.debrisBurst(wp.x, wp.y, wp.z, nx * 3, nz * 3, 3, [PAINT, 0x111214, 0xdfe7ea], 1.2);
    }
    this.fx.debrisBurst(cx, P.y + 0.5, cz, -nx * 3 + P.vx * 0.3, -nz * 3 + P.vz * 0.3, Math.min(18, Math.round(veq * 0.9)), [PAINT, PAINT, 0x111214, 0x3a3c40]);
    this.apply();
  }

  breakLamp(key, nx = 0, nz = 0) {
    const mesh = this.parts.lamps[key];
    if (!mesh || this.broken.has(key)) return;
    this.broken.add(key);
    if (key.startsWith('brake') || key === 'grille') mesh.visible = false;
    else { mesh.userData.mat ||= mesh.material; mesh.material = this.brokenMat; mesh.scale.y = 0.6; }
    const wp = mesh.getWorldPosition(new THREE.Vector3());
    this.fx.debrisBurst(wp.x, wp.y, wp.z, -nx * 2, -nz * 2, 6, key.startsWith('head') ? [0xdfe7ea, 0xf4f8fb] : key === 'grille' ? [0x111214] : [0xc4141a, 0x8a0a10], 0.6);
  }

  // what a hit of severity sev (wall-equivalent m/s, x concentration) in a zone breaks
  breakParts(zone, sev, along, left) {
    const s = this.s, R = Math.random;
    const front = zone === 'F' || zone === 'FL' || zone === 'FR';
    const rear = zone === 'B' || zone === 'RL' || zone === 'RR';
    if (front) {
      const center = zone === 'F' ? 1 : 0.55;
      // the radiator sits right behind the grille: it cracks first and leaks
      if (sev > 4) {
        const was = s.radiator;
        s.radiator = Math.max(0, s.radiator - ((sev - 4) / 15) * center);
        s.coolantLeak = (1 - s.radiator) * 0.018; // a smashed one empties in about a minute
        if (was > 0.97 && s.radiator <= 0.97) this.note('Radiator cracked: coolant leaking');
      }
      if (sev > 11) {
        s.engine = Math.max(0, s.engine - ((sev - 11) / 24) * center);
        if (sev > 14 && R() < 0.5) s.oilLeak = Math.max(s.oilLeak, Math.min(0.012, (sev - 14) * 0.0015));
      }
      // a big enough front hit splits a fuel or oil line onto the hot engine
      if (sev > 19 && R() < (sev - 19) / 12) this.ignite();
    }
    // the gearbox, driveshaft and differential sit low and toward the back (rear-wheel drive)
    if (rear && sev > 9) {
      const was = s.trans;
      s.trans = Math.max(0, s.trans - ((sev - 9) / 28) * (zone === 'B' ? 1 : 0.6));
      if (was > 0.7 && s.trans <= 0.7) this.note(s.trans > 0.5 ? 'Gearbox damaged: 5th gear gone' : 'Gearbox damaged: top gears gone');
    }
    // wheels near the hit: suspension, alignment, brakes, steering, tires
    for (const w of s.wheels) {
      // crush travels back from the bumper into the wheel behind it, less so sideways
      const d = Math.hypot((along - w.along) * 0.6, (left - w.left) * 1.3);
      if (d > 1.4) continue;
      const k = sev * (1 - d / 1.4);
      const sideSign = w.left > 0 ? -1 : 1; // damage on the left pulls left (negative steer)
      if (k > 5) {
        w.susp = Math.max(0, w.susp - (k - 5) / 18);
        w.toe = Math.max(-0.035, Math.min(0.035, w.toe + sideSign * (k - 5) * 0.0025));
        if (w.front) {
          s.steerOffset = Math.max(-0.05, Math.min(0.05, s.steerOffset + sideSign * (k - 5) * 0.002));
          s.steerLock = Math.max(0.5, s.steerLock - (k - 5) / 45);
        }
      }
      if (k > 9) {
        const key = w.left > 0 ? 'brakeL' : 'brakeR';
        const was = s[key];
        s[key] = Math.max(0, s[key] - (k - 9) / 22);
        if (was > 0.8 && s[key] <= 0.8) this.note('Brake line damaged: brakes weak, pulling');
      }
      if (w.state === 'off') continue;
      if (k > 18 && R() < (k - 18) / 10) { this.loseWheel(w); continue; }
      if (k > 12 && R() < (k - 12) / 9 && (w.state === 'ok' || w.state === 'leak')) { this.flatten(w, true); continue; }
      if (k > 6.5 && w.state === 'ok' && R() < (k - 6.5) / 10) {
        w.state = 'leak'; w.leak = 0.015 + (k - 6.5) * 0.008;
        this.note(`${cap(WHEEL_NAMES[w.i])} tire punctured`);
      }
    }
  }

  flatten(w, blowout) {
    w.pressure = 0; w.state = 'flat'; w.leak = 0;
    const p = this.wheelWorld(w);
    if (blowout) this.fx.debrisBurst(p.x, p.y, p.z, this.player.vx * 0.4, this.player.vz * 0.4, 10, [0x161616, 0x222222, 0x0c0c0c], 1.1);
    this.note(`${cap(WHEEL_NAMES[w.i])} tire ${blowout ? 'blown out' : 'flat'}`);
  }

  loseWheel(w) {
    w.state = 'off'; w.pressure = 0; w.susp = 0;
    const p = this.wheelWorld(w);
    this.fx.debrisBurst(p.x, p.y, p.z, this.player.vx * 0.6, this.player.vz * 0.6, 8, [0x161616, 0xd6d8da, 0x2c2f32], 1.6);
    this.note(`The ${WHEEL_NAMES[w.i]} wheel came off`);
  }

  // ---------------------------------------------------------------- panels
  hitPanels(zone, sev, dmg, along, left) {
    const R = Math.random;
    for (const [name, cfg] of Object.entries(PANELS)) {
      const ps = this.s.panels[name], pn = this.panels[name];
      if (!pn || ps.state === 'off' || !cfg.zones.includes(zone)) continue;
      if (cfg.kind === 'door' && (along < -1.05 || along > 0.8)) continue; // corner hits miss the door
      const share = zone === cfg.zones[0] ? 1 : 0.75;
      ps.hp += dmg * share;
      const k = sev * share;
      if (cfg.kind === 'hood') {
        // the hood buckles up in the middle as the nose is pushed back
        this.dent(pn.mesh, [left * 0.4, 0.9, 1.25 + R() * 0.3], [0, 1, -0.5], Math.min(0.16, k * 0.008), 0.55 + Math.min(0.4, k * 0.02));
      }
      const loosenAt = cfg.kind === 'bumper' ? 9 : cfg.kind === 'door' ? 9.5 : 8;
      const offAt = cfg.kind === 'bumper' ? 19 : cfg.kind === 'door' ? 19 : 21;
      if (ps.state === 'ok' && (k > loosenAt || ps.hp > (cfg.kind === 'bumper' ? 22 : 30))) this.loosen(name, left);
      else if (ps.state === 'loose') ps.wear += k / 18;
      if (ps.state === 'loose' && (k > offAt || ps.hp > 75 || ps.wear >= 1)) this.detach(name);
    }
  }

  // a panel comes loose: bumpers hang from one corner, the rest spring open a little
  loosen(name, left = 0) {
    const ps = this.s.panels[name], pn = this.panels[name], cfg = PANELS[name], R = Math.random;
    if (!pn || ps.state !== 'ok') return;
    ps.state = 'loose';
    ps.ang = 0; ps.w = 0; ps.wear = 0;
    if (cfg.kind === 'bumper') {
      // the side that was hit tears free and drops; it hangs from the other corner
      ps.side = left > 0.15 ? 1 : left < -0.15 ? -1 : (R() < 0.5 ? 1 : -1);
      const b = pn.mesh.geometry.boundingBox;
      const hang = new THREE.Vector3(-ps.side * 0.78, b.max.y - 0.06, cfg.end > 0 ? b.min.z + 0.05 : b.max.z - 0.05);
      pn.pivot.position.copy(hang);
      pn.mesh.position.copy(hang).negate();
      ps.ang0 = 0.1 + R() * 0.08;
      this.note(`${cfg.label} hanging off`);
    } else if (cfg.kind === 'hood') { ps.ang0 = 0.05 + R() * 0.07; this.note('Hood latch broken'); }
    else if (cfg.kind === 'trunk') { ps.ang0 = 0.12 + R() * 0.3; this.note('Trunk lid popped open'); }
    else { ps.ang0 = 0.06 + R() * 0.16; this.note(`${cfg.label} sprung open`); }
    this.bare(pn, true);
  }

  // a panel tears off and drops onto the road (where it stays)
  detach(name) {
    const ps = this.s.panels[name], pn = this.panels[name], cfg = PANELS[name], P = this.player, R = Math.random;
    if (!pn || ps.state === 'off') return;
    if (ps.state === 'ok') this.bare(pn, true);
    ps.state = 'off';
    const h = P.heading, fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
    let vx = P.vx * 0.85, vy = 0.6, vz = P.vz * 0.85;
    if (cfg.kind === 'hood') { vx = P.vx * 0.55; vy = 4 + R() * 2; vz = P.vz * 0.55; } // catches the wind and flies over the car
    else if (cfg.kind === 'door') { vx += lx * cfg.side * 2.5; vz += lz * cfg.side * 2.5; }
    else if (cfg.kind === 'bumper') { vx += fx * cfg.end * 0.8; vz += fz * cfg.end * 0.8; }
    this.spawnLoose(pn.mesh, vx, vy, vz);
    pn.pivot.visible = false;
    if (name === 'bumperF') { for (const k of ['headL', 'headR', 'grille']) this.breakLamp(k); }
    if (name === 'bumperB') { for (const k of ['brakeL', 'brakeR']) this.breakLamp(k); }
    this.note(`${cfg.label} came off`);
  }

  // darken the body under a panel that's open or gone (bare structure), or restore it
  bare(pn, on) {
    const body = this.parts.body, col = body.geometry.attributes.color.array, orig = body.userData.origCol;
    for (const i of pn.under) {
      for (let k = 0; k < 3; k++) col[i * 3 + k] = on ? BARE[k] : orig[i * 3 + k];
    }
    body.geometry.attributes.color.needsUpdate = true;
  }

  // copy of a panel (with its dents and scuffs) as a free body in the world
  spawnLoose(mesh, vx, vy, vz) {
    if (!this.fx.scene) return;
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry.clone();
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);
    geo.computeBoundingBox();
    const part = new THREE.Mesh(geo, mesh.material);
    part.castShadow = true;
    const pos = c.clone().applyMatrix4(mesh.matrixWorld), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    mesh.matrixWorld.decompose(new THREE.Vector3(), q, sc);
    part.position.copy(pos);
    part.quaternion.copy(q);
    this.fx.scene.add(part);
    const b = geo.boundingBox;
    const corners = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z));
    // the thinnest axis is the one that ends up pointing up when it lies flat
    const ext = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    const thin = ext.indexOf(Math.min(...ext));
    const R = Math.random;
    this.loose.push({ mesh: part, vx, vy, vz, w: new THREE.Vector3((R() - 0.5) * 6, (R() - 0.5) * 4, (R() - 0.5) * 6), corners, thin, rest: false, scrapeT: 0 });
    while (this.loose.length > 12) this.removeLoose(this.loose[0]);
  }

  removeLoose(l) {
    l.mesh.removeFromParent();
    l.mesh.geometry.dispose();
    this.loose.splice(this.loose.indexOf(l), 1);
  }

  // fallen parts: tumble, bounce, slide and settle flat; you can kick them along by driving into them
  updateLoose(dt) {
    const P = this.player, v = this._v, q = this._q, q2 = this._q2;
    for (const l of [...this.loose]) {
      const m = l.mesh;
      if (Math.hypot(m.position.x - P.x, m.position.z - P.z) > 1500) { this.removeLoose(l); continue; }
      // driving into it
      const dx = m.position.x - P.x, dz = m.position.z - P.z, d = Math.hypot(dx, dz);
      const pv = Math.hypot(P.vx, P.vz);
      if (d < 1.7 && pv > 2 && Math.abs(m.position.y - P.y) < 1.5) {
        const away = (pv * 0.25) / Math.max(0.4, d);
        l.vx = P.vx * 0.8 + (dx / Math.max(0.1, d)) * away; l.vz = P.vz * 0.8 + (dz / Math.max(0.1, d)) * away; l.vy = Math.max(l.vy, 1 + pv * 0.08);
        l.w.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8);
        l.rest = false;
        if (pv > 6) this.fx.sparkBurst(m.position.x, m.position.y, m.position.z, dx / d, dz / d, -dz / d, dx / d, 6, pv * 0.4);
      }
      if (l.rest) continue;
      l.vy -= 9.8 * dt;
      m.position.x += l.vx * dt; m.position.y += l.vy * dt; m.position.z += l.vz * dt;
      const wl = l.w.length();
      if (wl > 1e-4) { q.setFromAxisAngle(v.copy(l.w).divideScalar(wl), wl * dt); m.quaternion.premultiply(q); }
      // lowest corner vs the ground
      let minY = Infinity;
      for (const c of l.corners) { const y = v.copy(c).applyQuaternion(m.quaternion).y + m.position.y; if (y < minY) minY = y; }
      const gy = this.fx.groundAt(m.position.x, m.position.z, m.position.y);
      if (minY < gy + 0.01) {
        m.position.y += gy + 0.01 - minY;
        const sp = Math.hypot(l.vx, l.vz);
        if (l.vy < -1.5) { l.vy = -l.vy * 0.25; this.fx.debrisBurst(m.position.x, gy + 0.1, m.position.z, l.vx * 0.3, l.vz * 0.3, 2, [PAINT, 0x111214], 0.7); } else l.vy = 0;
        // sliding metal on asphalt
        const f = Math.min(1, dt * 3.5);
        l.vx *= 1 - f; l.vz *= 1 - f;
        l.w.multiplyScalar(1 - Math.min(1, dt * 4));
        l.scrapeT -= dt;
        if (sp > 4 && l.scrapeT <= 0) { l.scrapeT = 0.05; this.fx.sparkBurst(m.position.x, gy + 0.05, m.position.z, 0, 0, l.vx / sp, l.vz / sp, 3, sp * 0.5); }
        // settle flat: turn the thin axis toward straight up or down, whichever is closer
        const axis = v.set(l.thin === 0 ? 1 : 0, l.thin === 1 ? 1 : 0, l.thin === 2 ? 1 : 0).applyQuaternion(m.quaternion);
        const up = axis.y >= 0 ? 1 : -1;
        q2.setFromUnitVectors(axis.clone(), new THREE.Vector3(0, up, 0));
        q.identity().slerp(q2, Math.min(1, dt * 3));
        m.quaternion.premultiply(q);
        if (sp < 0.15 && Math.abs(l.vy) < 0.1 && Math.abs(axis.y) > 0.995) l.rest = true;
      }
    }
  }

  // loose panels swing: bumpers bounce and drag, the hood flutters (and can fly up), the trunk bobs,
  // doors swing with the turns and the wind pushes them shut
  updatePanels(dt) {
    const P = this.player, v = Math.abs(P.groundSpeed ?? P.speed ?? 0), R = Math.random;
    for (const [name, cfg] of Object.entries(PANELS)) {
      const ps = this.s.panels[name], pn = this.panels[name];
      if (!pn || ps.state !== 'loose') continue;
      let target = ps.ang0, kick = (R() - 0.5) * v * 0.9;
      if (cfg.kind === 'bumper') {
        ps.wear += dt * (v / 30) ** 2 * 0.06;
        target = ps.ang0 + Math.min(0.18, ps.wear * 0.18);
        // the dropped corner drags on the road: sparks, and it works loose faster
        const end = this._v.set(ps.side * 0.82, 0.3, cfg.end > 0 ? 2.15 : -2.15);
        pn.mesh.localToWorld(end);
        const gy = this.fx.groundAt(end.x, end.z, end.y);
        if (end.y < gy + 0.07 && v > 3) {
          ps.wear += dt * v * 0.004;
          this.dragT -= dt;
          if (this.dragT <= 0) { this.dragT = 0.04; this.fx.sparkBurst(end.x, gy + 0.04, end.z, 0, 0, -Math.sin(P.heading), -Math.cos(P.heading), 3, v * 0.5); }
        }
        if (ps.wear >= 1) { this.detach(name); continue; }
      } else if (cfg.kind === 'hood') {
        if (!ps.flipped && v > 27 && R() < dt * (v - 27) * 0.05) {
          // the wind gets under it: it slams up against the windshield
          ps.flipped = true;
          this.note('Hood flew up!');
          if (this.glass.windshield) { drawSpider(this.glass.windshield, 0.5 + (R() - 0.5) * 0.3, 0.8, 0.95); this.crackVer++; }
        }
        if (ps.flipped) {
          target = 1.17 + Math.sin(this.time * 23) * 0.025 * Math.min(1.5, v / 30);
          ps.tearT = v > 36 ? ps.tearT + dt : Math.max(0, ps.tearT - dt);
          if (ps.tearT > 2.5) { this.detach(name); continue; }
        } else target = ps.ang0 + Math.sin(this.time * 17) * 0.012 * Math.min(1, v / 20);
      } else if (cfg.kind === 'door') {
        // swings out on turns away from its side, the wind closes it
        const turn = (P.headingRate || 0) * v * cfg.side;
        target = Math.max(0.02, Math.min(1.2, ps.ang0 + Math.max(0, -turn) * 0.05 - Math.min(ps.ang0 * 0.8, v * 0.012)));
        kick *= 0.5;
      }
      ps.w += (60 * (target - ps.ang) - 7 * ps.w + kick) * dt;
      ps.ang += ps.w * dt;
      if (ps.ang < 0) { ps.ang = 0; ps.w = Math.abs(ps.w) * 0.3; }
      if (ps.ang > cfg.max) { ps.ang = cfg.max; ps.w = -Math.abs(ps.w) * 0.3; }
      this.posePanel(name);
    }
  }

  posePanel(name) {
    const ps = this.s.panels[name], pn = this.panels[name], cfg = PANELS[name];
    const r = pn.pivot.rotation;
    r.set(0, 0, 0);
    if (cfg.kind === 'bumper') { r.z = -ps.side * ps.ang; r.y = -ps.side * cfg.end * ps.ang * 0.25; } // free end drops and sticks out
    else if (cfg.kind === 'hood') r.x = -ps.ang;
    else if (cfg.kind === 'trunk') r.x = ps.ang;
    else r.y = -cfg.side * ps.ang;
  }

  // ---------------------------------------------------------------- glass
  hitGlass(zone, sev, along, left, kind) {
    const G = this.glass, R = Math.random;
    const front = zone === 'F' || zone === 'FL' || zone === 'FR', rear = zone === 'B' || zone === 'RL' || zone === 'RR';
    const conc = kind === 'pole' || kind === 'tree' ? 1.25 : 1;
    if (front && G.windshield && sev * conc > 7.5) {
      drawSpider(G.windshield, clamp01(0.5 + left * 0.45), 0.15 + R() * 0.25, Math.min(1.2, 0.25 + (sev * conc - 7.5) / 12));
      this.crackVer++;
    }
    if (rear && G.rear && sev > 11) {
      if (sev > 17 && !G.rear.shattered) drawShatter(G.rear);
      else drawSpider(G.rear, clamp01(0.5 - left * 0.45), 0.2 + R() * 0.3, Math.min(1.1, 0.3 + (sev - 11) / 12));
    }
    const sideGlass = zone === 'L' || zone === 'FL' || zone === 'RL' ? G.sideL : zone === 'R' || zone === 'FR' || zone === 'RR' ? G.sideR : null;
    if (sideGlass && !sideGlass.shattered && sev > (zone === 'L' || zone === 'R' ? 8.5 : 13) && along > -1.1 && along < 0.8) {
      this.shatterSide(sideGlass);
    }
  }

  shatterSide(gl) {
    if (gl.shattered) return;
    drawShatter(gl);
    const P = this.player;
    if (!gl.mesh.geometry.boundingSphere) gl.mesh.geometry.computeBoundingSphere();
    const wp = gl.mesh.localToWorld(gl.mesh.geometry.boundingSphere.center.clone());
    this.fx.debrisBurst(wp.x, wp.y, wp.z, P.vx * 0.3, P.vz * 0.3, 14, [0xd6ecf2, 0xeef8fb, 0xb9d6de], 0.35);
  }

  setInsideView(on) {
    if (this.insideView === on) return;
    this.insideView = on;
    this.overlayVer = -1;
  }

  // in the driver's-eye camera the car isn't drawn, so the cracked windshield is laid over the screen
  updateOverlay() {
    const el = this.overlay, ws = this.glass.windshield;
    if (!el || !ws) return;
    const show = this.insideView && ws.cracks > 0;
    if (el.hidden !== !show) el.hidden = !show;
    if (!show) return;
    const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (this.overlayVer === this.crackVer && el.width === W && el.height === H) return;
    this.overlayVer = this.crackVer;
    if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // seen from inside, the car's left is on the left of the screen: mirrored, redrawn sharp at screen size
    for (const c of ws.list || []) paintCrack(ctx, c, W, H, true);
  }

  // ---------------------------------------------------------------- paint
  // scrape the paint at car-local point p: hazy scuffs first, bare metal when it keeps going
  scuff(p, r, amount) {
    for (const mesh of this.skins) {
      if (mesh.parent && mesh.parent.visible === false) continue;
      const pn = Object.values(this.panels).find((x) => x.mesh === mesh);
      if (pn && Math.abs(pn.pivot.rotation.x) + Math.abs(pn.pivot.rotation.y) + Math.abs(pn.pivot.rotation.z) > 0.02) continue;
      const a = mesh.geometry.attributes.position.array, wear = mesh.userData.wear;
      let touched = false;
      for (let i = 0; i < wear.length; i++) {
        const d = Math.hypot(a[i * 3] - p[0], (a[i * 3 + 1] - p[1]) * 1.5, a[i * 3 + 2] - p[2]);
        if (d > r) continue;
        wear[i] = Math.min(1.2, wear[i] + amount * (1 - d / r) * (0.6 + 0.8 * hash(i)));
        touched = true;
      }
      if (touched) this.recolor(mesh);
    }
  }

  // soot from a fire, around car-local point p
  soot(p, r, amount) {
    for (const mesh of this.skins) {
      const a = mesh.geometry.attributes.position.array, soot = mesh.userData.soot;
      let touched = false;
      for (let i = 0; i < soot.length; i++) {
        const d = Math.hypot(a[i * 3] - p[0], a[i * 3 + 1] - p[1], a[i * 3 + 2] - p[2]);
        if (d > r) continue;
        soot[i] = Math.min(1, soot[i] + amount * (1 - d / r));
        touched = true;
      }
      if (touched) this.recolor(mesh);
    }
  }

  recolor(mesh) {
    const col = mesh.geometry.attributes.color.array, orig = mesh.userData.origCol, wear = mesh.userData.wear, soot = mesh.userData.soot;
    const underSet = mesh === this.parts.body ? this.bareSet() : null;
    for (let i = 0; i < wear.length; i++) {
      if (underSet?.has(i)) continue;
      const o0 = orig[i * 3], o1 = orig[i * 3 + 1], o2 = orig[i * 3 + 2];
      const painted = o0 > 0.3; // red paint: trim and glass don't scuff
      let c0 = o0, c1 = o1, c2 = o2;
      const w = painted ? wear[i] : 0;
      if (w > 0) {
        const k1 = Math.min(1, w / 0.5) * 0.55, k2 = Math.max(0, Math.min(1, (w - 0.5) / 0.5)), n = 0.85 + 0.3 * hash(i + 7);
        c0 += (SCUFF[0] - c0) * k1; c1 += (SCUFF[1] - c1) * k1; c2 += (SCUFF[2] - c2) * k1;
        c0 += (METAL[0] * n - c0) * k2; c1 += (METAL[1] * n - c1) * k2; c2 += (METAL[2] * n - c2) * k2;
      }
      const s = soot[i];
      if (s > 0) { c0 += (SOOT[0] - c0) * s; c1 += (SOOT[1] - c1) * s; c2 += (SOOT[2] - c2) * s; }
      col[i * 3] = c0; col[i * 3 + 1] = c1; col[i * 3 + 2] = c2;
    }
    mesh.geometry.attributes.color.needsUpdate = true;
  }

  // body vertices currently showing bare structure (under an open or missing panel)
  bareSet() {
    const set = new Set();
    for (const [name, pn] of Object.entries(this.panels)) if (this.s.panels[name].state !== 'ok') for (const i of pn.under) set.add(i);
    return set;
  }

  // a sliding contact (wall, car) at world (x, z): scuff that spot
  scrape(x, z, speed, dt) {
    const P = this.player, h = P.heading, fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
    const dx = x - P.x, dz = z - P.z;
    this.scrapeAcc = (this.scrapeAcc || 0) + dt * Math.min(2, speed / 12) * 1.1;
    this.scrapeAt = [Math.max(-0.95, Math.min(0.95, dx * lx + dz * lz)), 0.58, Math.max(-2.25, Math.min(2.25, dx * fx + dz * fz))];
  }

  // ---------------------------------------------------------------- fire
  ignite() {
    const s = this.s;
    if (s.fire > 0 || s.burnt) return;
    s.fire = 0.05; s.fireT = 0;
    this.note('Engine fire!');
    this.hud?.toast('Engine fire! The car is finished: press F for a tow.', 6000);
  }

  // ---------------------------------------------------------------- rollovers, landings
  // rolled onto the roof / side: crush the cabin
  rollHit(speed) {
    if (speed < 1.5) return;
    const s = this.s, dmg = Math.min(40, speed * 6), R = Math.random;
    s.zones.roof = Math.min(100, s.zones.roof + dmg);
    for (const z of ['L', 'R', 'F', 'B']) s.zones[z] = Math.min(100, s.zones[z] + dmg * (z === 'F' || z === 'B' ? 0.25 : 0.45));
    // landing on a corner bends that wheel's suspension
    const side = Math.sign(this.player.roll) < 0 ? 'left' : 'right';
    for (const w of s.wheels) if ((w.left > 0) === (side === 'left')) w.susp = Math.max(0, w.susp - speed * 0.04);
    this.dent(this.parts.cabin, [0, 1.35, -0.3], [0, -1, 0], Math.min(0.25, speed * 0.05), 1.3);
    this.dentSkin([Math.sign(this.player.roll) * -0.9, 0.9, 0], [Math.sign(this.player.roll), -0.3, 0], Math.min(0.15, speed * 0.03), 1.4);
    // roof and the side it landed on get ground down to metal
    this.scuff([0, 1.35, -0.3], 1.1, Math.min(1, speed * 0.18));
    this.scuff([side === 'left' ? 0.9 : -0.9, 0.8, 0], 1.4, Math.min(1, speed * 0.15));
    // glass and doors don't survive a roll
    const G = this.glass;
    if (G.windshield && speed > 2) { drawSpider(G.windshield, 0.3 + R() * 0.4, 0.7 + R() * 0.2, Math.min(1.1, speed * 0.2)); this.crackVer++; }
    const sg = side === 'left' ? G.sideL : G.sideR;
    if (sg && speed > 2.5) this.shatterSide(sg);
    if (G.rear && speed > 3 && R() < 0.5) drawSpider(G.rear, R(), 0.6, 0.6);
    for (const name of ['doorL', 'doorR', 'trunk', 'hood']) if (R() < speed * 0.12) this.loosen(name, 0);
    if (s.engine < 0.4 && s.oilLeak > 0 && R() < 0.15) this.ignite();
    this.apply();
  }

  // came down hard (vertical speed v m/s): underside, suspension, tires, oil pan
  // (9 m/s is a ~4 m drop; smaller hops over the terrain data's bumps are free)
  landing(v) {
    if (v < 9) return;
    const s = this.s, k = v - 9, R = Math.random;
    s.zones.under = Math.min(100, s.zones.under + k * 8);
    for (const w of s.wheels) {
      w.susp = Math.max(0, w.susp - k * 0.04);
      if (w.state === 'ok' && R() < k * 0.06) { w.state = 'leak'; w.leak = 0.02 + k * 0.01; this.note(`${cap(WHEEL_NAMES[w.i])} tire punctured`); }
    }
    if (k > 1.5) { s.oilLeak = Math.max(s.oilLeak, Math.min(0.012, k * 0.002)); this.note('Oil pan cracked: oil leaking'); }
    if (k > 3) s.trans = Math.max(0, s.trans - k * 0.04);
    // a hanging bumper takes the bounce badly
    for (const name of ['bumperF', 'bumperB']) if (this.s.panels[name].state === 'loose') this.s.panels[name].wear += k * 0.15;
    if (this.glass.windshield && k > 2 && R() < 0.3) { drawSpider(this.glass.windshield, 0.2 + R() * 0.6, 0.05, 0.3); this.crackVer++; }
    const P = this.player;
    this.fx.sparkBurst(P.x, P.y + 0.15, P.z, 0, 0, Math.sin(P.heading), Math.cos(P.heading), Math.min(60, Math.round(k * 15)), k * 2);
    this.apply();
  }

  // ---------------------------------------------------------------- dents
  // the body and every panel still attached, so panels dent along with the metal under them
  dentSkin(p, dir, depth, radius) {
    this.dent(this.parts.body, p, dir, depth, radius);
    for (const [name, pn] of Object.entries(this.panels)) if (this.s.panels[name].state === 'ok') this.dent(pn.mesh, p, dir, depth, radius);
  }

  dent(mesh, p, dir, depth, radius) {
    const attr = mesh.geometry.attributes.position, a = attr.array, o = mesh.userData.orig;
    const L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const ux = dir[0] / L, uy = dir[1] / L, uz = dir[2] / L;
    for (let i = 0; i < a.length; i += 3) {
      const dx = a[i] - p[0], dy = (a[i + 1] - p[1]) * 1.4, dz = a[i + 2] - p[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const w = (1 - d / radius) ** 2;
      const crumple = 1 + (Math.sin(a[i] * 37 + a[i + 2] * 23) * 0.35);
      a[i] += ux * depth * w * crumple; a[i + 1] += uy * depth * w * crumple; a[i + 2] += uz * depth * w * crumple;
      // never more than 55 cm from the original shape
      const ox = a[i] - o[i], oy = a[i + 1] - o[i + 1], oz = a[i + 2] - o[i + 2], od = Math.hypot(ox, oy, oz);
      if (od > 0.55) { a[i] = o[i] + (ox / od) * 0.55; a[i + 1] = o[i + 1] + (oy / od) * 0.55; a[i + 2] = o[i + 2] + (oz / od) * 0.55; }
    }
    attr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    // lights, grille and mirrors ride along with the metal they're bolted to
    if (mesh === this.parts.body) {
      for (const part of [...Object.values(this.parts.lamps), ...Object.values(this.parts.mirrors)]) {
        part.userData.home ||= part.position.clone();
        const q = part.position, d = Math.hypot(q.x - p[0], (q.y - p[1]) * 1.4, q.z - p[2]);
        if (d > radius) continue;
        const w = (1 - d / radius) ** 2;
        q.x += ux * depth * w; q.y += uy * depth * w; q.z += uz * depth * w;
        if (q.distanceTo(part.userData.home) > 0.55) q.sub(part.userData.home).setLength(0.55).add(part.userData.home);
      }
    }
  }

  // push the state onto the car: physics effects and how it sits
  apply() {
    const P = this.player, s = this.s;
    P.dmg = this.effects();
    // each corner sits lower when its suspension is bent, its tire is flat or its wheel is gone
    const sag = s.wheels.map((w) => (w.state === 'off' ? 0.26 : 0) + (w.state === 'flat' ? 0.07 : w.state === 'rim' ? 0.11 : w.state === 'leak' ? 0.07 * (1 - w.pressure) : 0) + (1 - w.susp) * 0.06);
    const frontS = (sag[0] + sag[1]) / 2, rearS = (sag[2] + sag[3]) / 2, leftS = (sag[0] + sag[2]) / 2, rightS = (sag[1] + sag[3]) / 2;
    P.dmgPitch = Math.atan2(frontS - rearS, 2.62); // nose down when the front sags
    P.dmgRoll = Math.atan2(leftS - rightS, 1.56) * -1;
    P.dmgLift = -(frontS + rearS) / 2;
    s.wheels.forEach((w, i) => {
      const wp = this.wheelParts[i];
      if (!wp) return;
      wp.pivot.visible = w.state !== 'off';
      // a bent arm leans the wheel; a flat tire squashes
      const bend = Math.max(0, 0.7 - w.susp) / 0.7;
      wp.pivot.rotation.z = (w.left > 0 ? 1 : -1) * bend * 0.16;
      // a flat sits the rim lower; a shredded tire is gone (tire = child 0, sidewalls = children 2 and 3)
      for (const k of [0, 2, 3]) if (wp.spin.children[k]) wp.spin.children[k].visible = w.state !== 'rim';
      wp.pivot.position.y = wp.home.y - (w.state === 'flat' ? 0.05 : w.state === 'rim' ? 0.1 : 0);
    });
    this.render(true);
  }

  repair() {
    this.s = freshState();
    for (const mesh of this.skins) {
      const g = mesh.geometry;
      g.attributes.position.array.set(mesh.userData.orig);
      g.attributes.position.needsUpdate = true;
      g.attributes.color.array.set(mesh.userData.origCol);
      g.attributes.color.needsUpdate = true;
      mesh.userData.wear.fill(0);
      mesh.userData.soot.fill(0);
      g.computeVertexNormals();
    }
    for (const pn of Object.values(this.panels)) {
      pn.pivot.position.copy(pn.pivotHome);
      pn.mesh.position.copy(pn.meshHome);
      pn.pivot.rotation.set(0, 0, 0);
      pn.pivot.visible = true;
    }
    for (const gl of Object.values(this.glass)) {
      gl.ctx.clearRect(0, 0, gl.canvas.width, gl.canvas.height);
      gl.cracks = 0; gl.shattered = false; gl.list = [];
      gl.mesh.visible = false;
      gl.tex.needsUpdate = true;
    }
    this.crackVer++;
    for (const mesh of Object.values(this.parts.lamps)) { mesh.visible = true; if (mesh.userData.mat) mesh.material = mesh.userData.mat; mesh.scale.y = 1; }
    for (const mesh of Object.values(this.parts.mirrors)) mesh.visible = true;
    for (const mesh of [...Object.values(this.parts.lamps), ...Object.values(this.parts.mirrors)]) if (mesh.userData.home) mesh.position.copy(mesh.userData.home);
    for (const w of this.wheelParts) { w.pivot.position.copy(w.home); w.pivot.visible = true; for (const c of w.spin.children) c.visible = true; }
    this.broken.clear();
    this.events.length = 0;
    this.misfire = 0;
    this.scrapeAcc = 0;
    this.apply();
  }

  wheelWorld(w) {
    const P = this.player, h = P.heading;
    return { x: P.x + Math.sin(h) * w.along + Math.cos(h) * w.left, y: P.y + 0.3, z: P.z + Math.cos(h) * w.along - Math.sin(h) * w.left };
  }

  // car-local (along = forward, left) to world x/z
  toWorld(along, left) {
    const P = this.player, h = P.heading;
    return [P.x + Math.sin(h) * along + Math.cos(h) * left, P.z + Math.cos(h) * along - Math.sin(h) * left];
  }

  note(msg) {
    this.events.push({ msg, t: 5 });
    if (this.events.length > 3) this.events.shift();
  }

  // ---------------------------------------------------------------- over time
  update(dt) {
    const s = this.s, P = this.player;
    this.time += dt;
    // parts on the road, puddles and the cracked-windshield overlay live on after a repair
    this.updateLoose(dt);
    this.puddles?.update(dt, P.x, P.z);
    this.updateOverlay();
    // scrapes collected by the physics steps, applied a few times a second
    if (this.scrapeAcc > 0.02) { this.scuff(this.scrapeAt, 0.45, this.scrapeAcc); this.scrapeAcc = 0; }
    if (this.total < 0.01 && !s.fire) { if (this.renderT !== -1) { this.render(); this.renderT = -1; } return; }
    const v = Math.abs(P.speed || 0);
    // fire: grows for about a minute, then burns itself out; it finishes the engine and scorches the front
    if (s.fire > 0) {
      s.fireT += dt;
      s.fire = s.fireT < 70 ? Math.min(1, s.fire + dt / 10) : s.fire - dt / 25;
      s.engine = Math.max(0, s.engine - dt * 0.15);
      s.radiator = 0; s.coolant = 0; s.temp = Math.max(s.temp, 160);
      if (s.fire <= 0) { s.fire = 0; s.burnt = true; this.note('The fire burned out'); }
      const R = Math.random;
      const n = Math.round((30 + 70 * s.fire) * dt + R());
      const hoodGone = this.s.panels.hood?.state === 'off';
      for (let i = 0; i < n; i++) {
        const [x, z] = this.toWorld(1.0 + R() * 0.9, (R() - 0.5) * 1.1);
        this.fx.flamePuff(x, P.y + (hoodGone ? 0.75 : 0.95), z, 0.16 + 0.3 * s.fire);
      }
      if (R() < dt * 14) { const [x, z] = this.toWorld(1.2, 0); this.fx.smokePuff(x, P.y + 1.6, z, true, 1); }
      this.sootT -= dt;
      if (this.sootT <= 0) { this.sootT = 0.5; this.soot([0, 0.85, 1.35], 0.9 + 0.7 * s.fire, 0.04 * s.fire); }
    }
    const running = !s.engineDead;
    // cooling: heat in from the engine's load, out through the radiator (needs coolant and air flow)
    s.coolant = Math.max(0, s.coolant - s.coolantLeak * dt);
    const load = running ? 0.25 + 0.75 * clamp01(P.throttleIn || 0) * Math.min(1, (P.rpm || 0) / 5500) : 0;
    const capC = s.coolant * (0.3 + 0.7 * s.radiator) * (0.85 + 0.15 * Math.min(1, v / 25)) * 1.2;
    const target = running ? 90 + 85 * Math.max(0, load - capC) + (s.coolant < 0.1 ? 18 : 0) : 20;
    if (!s.fire) s.temp += (target - s.temp) * Math.min(1, dt / (target > s.temp ? 16 : 45));
    // heat and oil starvation wear the engine out
    if (running) {
      if (s.temp > 128) s.engine -= (s.temp - 128) * 0.0011 * dt;
      s.oil = Math.max(0, s.oil - s.oilLeak * dt);
      if (s.oil < 0.25) s.engine -= (0.25 - s.oil) * 0.05 * dt * (0.4 + (P.rpm || 0) / 6000);
      s.engine = Math.max(0, s.engine);
      // a cooked engine dripping oil onto the exhaust can catch fire
      if (!s.fire && s.temp > 138 && (s.oilLeak > 0 || s.engine < 0.15) && Math.random() < dt * 0.03) this.ignite();
      if (s.engine <= 0.02 && !s.engineDead) {
        s.engineDead = true;
        this.note(s.fire ? 'Engine burned out' : s.temp > 125 ? 'Engine seized from overheating' : 'Engine died');
        if (!s.fire) this.hud?.toast('Engine dead. Press F to call a tow.', 5000);
      }
    }
    // misfires: a sick engine or a very hot one cuts out for a moment now and then
    this.misfire = Math.max(0, this.misfire - dt);
    if (running && (s.engine < 0.5 || s.temp > 124) && Math.random() < dt * (s.engine < 0.25 || s.temp > 132 ? 3 : 1.2)) this.misfire = 0.08 + Math.random() * 0.2;
    // gearbox: badly damaged ones jam in whatever gear they're in
    if (s.trans <= 0.25 && !s.stuckGear && s.trans > 0.08) { s.stuckGear = Math.max(1, Math.min(3, P.gear > 0 ? P.gear : 1)); this.note(`Gearbox jammed in ${s.stuckGear}${['st', 'nd', 'rd'][s.stuckGear - 1]} gear`); }
    // tires: leaks go flat; driving on a flat shreds it down to the rim
    for (const w of s.wheels) {
      if (w.state === 'leak') {
        w.pressure = Math.max(0, w.pressure - w.leak * dt * (1 + v / 30));
        if (w.pressure < 0.3) this.flatten(w, false);
      } else if (w.state === 'flat' && v > 3) {
        w.shred += dt * v / 260;
        if (w.shred >= 1) {
          w.state = 'rim';
          const p = this.wheelWorld(w);
          this.fx.debrisBurst(p.x, p.y, p.z, P.vx * 0.3, P.vz * 0.3, 12, [0x161616, 0x0c0c0c], 1.3);
          this.note(`${cap(WHEEL_NAMES[w.i])} tire shredded: on the rim`);
        }
      }
    }
    this.updatePanels(dt);
    // sparks from a bare rim or a hub dragging on the road
    this.sparkT -= dt;
    if (this.sparkT <= 0 && v > 4) {
      this.sparkT = 0.05;
      for (const w of s.wheels) {
        if (w.state !== 'rim' && w.state !== 'off') continue;
        const p = this.wheelWorld(w);
        const bx = -Math.sin(P.heading), bz = -Math.cos(P.heading);
        this.fx.sparkBurst(p.x, P.y + 0.08, p.z, bx, bz, -bz, bx, w.state === 'off' ? 5 : 3, v * 0.6);
      }
    }
    // leaks: puddles where you stop, a trail of drips while you drive
    if (this.puddles) {
      const leaks = [];
      if (s.oilLeak > 0 && s.oil > 0.01) leaks.push(['oil', 0.9, s.oilLeak, 0.9]);
      if (s.coolantLeak > 0 && s.coolant > 0.01) leaks.push(['coolant', 1.75, s.coolantLeak, 1.3]);
      if (leaks.length) {
        this.dripD += v * dt;
        for (const [kind, along, rate, maxR] of leaks) {
          const [x, z] = this.toWorld(along, 0);
          const y = this.fx.groundAt(x, z, P.y) + 0.03;
          if (v < 0.8) this.puddles.pour(x, y, z, kind, rate * dt * 12, maxR);
          else if (this.dripD > 1.6) this.puddles.pour(x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.2, kind, 0.01 + rate * 0.6, 0.12);
        }
        if (this.dripD > 1.6) this.dripD = 0;
      }
    }
    // steam from a leaking hot radiator, smoke from a sick engine
    this.smokeT -= dt;
    if (this.smokeT <= 0) {
      const [x, z] = this.toWorld(1.5, 0);
      if (s.engine < 0.6 || s.engineDead) {
        this.smokeT = s.engine < 0.3 ? 0.05 : 0.12;
        this.fx.smokePuff(x, P.y + 1.0, z, s.engine < 0.3, 1);
      } else if ((s.coolantLeak > 0 && s.coolant > 0.05) || s.temp > 112) {
        this.smokeT = s.temp > 112 ? 0.06 : 0.25;
        this.fx.steamPuff(x, P.y + 0.95, z);
      } else this.smokeT = 0.3;
    }
    for (const e of this.events) e.t -= dt;
    while (this.events.length && this.events[0].t <= 0) this.events.shift();
    P.dmg = this.effects();
    this.renderT -= dt;
    if (this.renderT <= 0) { this.renderT = 0.2; this.render(); }
  }

  // ---------------------------------------------------------------- HUD
  buildHud() {
    const $ = (id) => document.getElementById(id);
    this.el = $('damage');
    if (!this.el) return;
    this.pctEl = $('damage-pct');
    this.zoneEls = Object.fromEntries(ZONES.map((z) => [z, $(`dz-${z}`)]));
    this.tireEls = [0, 1, 2, 3].map((i) => $(`dt-${i}`));
    this.listEl = $('dmg-list');
    this.lightsEl = $('dmg-lights');
    this.msgEl = $('dmg-msg');
  }

  status() {
    const s = this.s;
    const tires = s.wheels.filter((w) => w.state !== 'ok');
    const worstSusp = Math.min(...s.wheels.map((w) => w.susp));
    const brakes = Math.min(s.brakeL, s.brakeR);
    const st = (h) => (h > 0.85 ? 'ok' : h > 0.5 ? 'warn' : 'bad');
    const off = Object.entries(PANELS).filter(([k]) => s.panels[k].state === 'off').map(([, c]) => c.label.toLowerCase());
    const loose = Object.entries(PANELS).filter(([k]) => s.panels[k].state === 'loose').map(([k, c]) => (k === 'hood' && s.panels[k].flipped ? 'hood up' : c.label.toLowerCase()));
    const G = this.glass;
    const glassTxt = [G.windshield?.cracks > 0 ? `windshield ${G.windshield.cracks > 1.6 ? 'smashed' : 'cracked'}` : '', G.sideL?.shattered || G.sideR?.shattered ? 'side glass out' : '', G.rear?.cracks > 0 ? 'rear cracked' : ''].filter(Boolean);
    const rows = [
      { label: 'Engine', h: s.engineDead ? 0 : s.engine, text: s.fire > 0 ? 'ON FIRE' : s.engineDead ? (s.burnt ? 'burned out' : 'dead') : s.engine > 0.85 ? 'OK' : this.misfire > 0 || s.engine < 0.5 ? 'misfiring' : 'damaged', cls: s.fire > 0 ? 'bad' : undefined },
      { label: 'Cooling', h: Math.min(s.radiator, s.coolant), text: `${Math.round(s.temp)}°C${s.coolantLeak > 0 && s.coolant > 0 ? ' · leak' : s.coolant <= 0.02 ? ' · empty' : ''}`, cls: s.temp > 125 ? 'bad' : s.temp > 112 ? 'warn' : undefined },
      { label: 'Oil', h: s.oil, text: s.oilLeak > 0 ? `${Math.round(s.oil * 100)}% · leak` : 'OK' },
      { label: 'Gearbox', h: s.trans, text: s.trans <= 0.08 ? 'broken' : s.stuckGear ? `jammed in ${s.stuckGear}` : s.trans > 0.7 ? 'OK' : s.trans > 0.5 ? 'no 5th' : 'no 4th/5th' },
      { label: 'Brakes', h: brakes, text: brakes > 0.85 ? 'OK' : `${Math.round((s.brakeL + s.brakeR) * 50)}%${Math.abs(s.brakeL - s.brakeR) > 0.15 ? ' · pulls' : ''}` },
      { label: 'Steering', h: Math.min(s.steerLock, 1 - Math.abs(s.steerOffset) * 4), text: Math.abs(s.steerOffset) > 0.015 ? `pulls ${s.steerOffset < 0 ? 'left' : 'right'}` : s.steerLock < 0.95 ? 'stiff' : 'OK' },
      { label: 'Suspension', h: worstSusp, text: worstSusp > 0.85 ? 'OK' : worstSusp > 0.5 ? 'bent' : 'broken' },
      { label: 'Tires', h: tires.length ? Math.min(...tires.map((w) => (w.state === 'leak' ? 0.6 : 0.1))) : 1, text: tires.length ? tires.map((w) => `${['FL', 'FR', 'RL', 'RR'][w.i]} ${w.state === 'leak' ? `${Math.round(w.pressure * 100)}%` : w.state === 'rim' ? 'rim' : w.state}`).join(', ') : 'OK' },
    ];
    if (off.length || loose.length) rows.push({ label: 'Body', h: off.length ? 0.2 : 0.6, text: [...off.map((x) => `${x} gone`), ...loose.map((x) => `${x} loose`)].join(', ') });
    if (glassTxt.length) rows.push({ label: 'Glass', h: G.windshield?.cracks > 1.6 || glassTxt.length > 1 ? 0.3 : 0.6, text: glassTxt.join(', ') });
    return rows.map((r) => ({ ...r, cls: r.cls || st(r.h) }));
  }

  render(force) {
    if (!this.el) return;
    const t = Math.round(this.total), s = this.s;
    this.el.hidden = t < 1 && !s.fire;
    if (this.el.hidden && !force) return;
    this.pctEl.textContent = `${t}%`;
    for (const z of ZONES) {
      const el = this.zoneEls[z];
      if (!el) continue;
      const v = s.zones[z] / 100;
      const hue = Math.round(120 * (1 - Math.min(1, v))); // green -> yellow -> red
      el.setAttribute('fill', v < 0.01 ? 'rgba(255,255,255,0.16)' : `hsl(${hue}, 80%, 50%)`);
    }
    s.wheels.forEach((w, i) => {
      const el = this.tireEls[i];
      if (!el) return;
      const col = w.state === 'ok' ? (w.susp < 0.6 ? '#f0b429' : '#2b2f33') : w.state === 'leak' ? '#f0b429' : w.state === 'off' ? 'none' : '#e5484d';
      el.setAttribute('fill', col);
      el.setAttribute('stroke', w.state === 'off' ? '#e5484d' : 'rgba(255,255,255,0.5)');
      el.setAttribute('stroke-dasharray', w.state === 'off' ? '2 1.5' : '');
    });
    if (this.listEl) {
      this.listEl.innerHTML = this.status().map((r) => `<div class="dr ${r.cls}"><span>${r.label}</span><i style="--h:${Math.round(Math.max(0, Math.min(1, r.h)) * 100)}%"></i><em>${r.text}</em></div>`).join('');
    }
    if (this.lightsEl) {
      const w = s.wheels.some((x) => x.state !== 'ok');
      const lights = [
        ['ENG', s.engineDead || s.engine < 0.7 || this.misfire > 0 ? (s.engine < 0.3 || s.engineDead ? 'red' : 'amber') : ''],
        ['TEMP', s.temp > 125 ? 'red' : s.temp > 112 ? 'amber' : ''],
        ['OIL', s.oil < 0.3 ? 'red' : s.oilLeak > 0 ? 'amber' : ''],
        ['TIRE', s.wheels.some((x) => x.state === 'flat' || x.state === 'rim' || x.state === 'off') ? 'red' : w ? 'amber' : ''],
        ['BRAKE', Math.min(s.brakeL, s.brakeR) < 0.5 ? 'red' : Math.min(s.brakeL, s.brakeR) < 0.85 ? 'amber' : ''],
      ];
      if (s.fire > 0) lights.unshift(['FIRE', 'red']);
      this.lightsEl.innerHTML = lights.map(([n, c]) => `<b class="${c}">${n}</b>`).join('');
    }
    if (this.msgEl) {
      const ev = this.events[this.events.length - 1];
      const shop = this.shopHint?.();
      this.msgEl.innerHTML = this.wrecked ? '<b>Can\'t drive.</b> Press <kbd>F</kbd> for a tow to the nearest repair shop.'
        : ev ? ev.msg : shop ? `Repairs: ${shop}` : 'Drive to a repair shop (wrench on the map)';
      this.msgEl.classList.toggle('alert', this.wrecked || !!ev);
    }
  }
}

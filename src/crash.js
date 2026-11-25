// Crashes for the player's car: sparks, flying debris and smoke; a damage model (front / rear / left /
// right) that dents the body where you hit, breaks lights and mirrors, smokes, and hurts how the car
// drives until you press R; and breakaway poles (streetlights, stop signs, street-name posts) that snap
// at the base and fall over.
import * as THREE from 'three';

// ------------------------------------------------------------------ particles
const PVERT = `
uniform float uScale;
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PFRAG = `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  float a = vColor.a * texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Particles {
  constructor(scene, max, blending) {
    this.max = max;
    this.p = [];
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uMap: { value: softDot() } },
      vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }
  add(p) { if (this.p.length < this.max) this.p.push(p); }
  update(dt, step) {
    let n = 0;
    for (let i = 0; i < this.p.length; i++) {
      const p = this.p[i];
      p.age += dt;
      if (p.age >= p.life || !step(p, dt)) continue;
      this.p[n++] = p;
    }
    this.p.length = n;
    for (let i = 0; i < n; i++) {
      const p = this.p[i];
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      this.col[i * 4] = p.r; this.col[i * 4 + 1] = p.g; this.col[i * 4 + 2] = p.b; this.col[i * 4 + 3] = p.a;
      this.size[i] = p.s;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const k of ['position', 'aColor', 'aSize']) g.attributes[k].needsUpdate = true;
  }
}

export class CrashFX {
  constructor(scene, ground) {
    this.ground = ground; // (x, z, y) -> ground height or null
    // daylight on pale concrete: additive sparks vanish, so they're drawn as solid hot-colored streaks
    this.sparks = new Particles(scene, 900, THREE.NormalBlending);
    this.smoke = new Particles(scene, 260, THREE.NormalBlending);
    // debris: little boxes that tumble, bounce and settle
    this.maxDebris = 160;
    this.debris = [];
    this.debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ vertexColors: false }), this.maxDebris);
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxDebris * 3), 3);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = true;
    scene.add(this.debrisMesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
  }

  groundAt(x, z, y) { const g = this.ground ? this.ground(x, z, y + 1.5) : null; return g ?? y - 0.6; }

  // sparks at a contact: hot streaks thrown off along the surface and up
  sparkBurst(x, y, z, nx, nz, tx, tz, n, speed) {
    for (let i = 0; i < n; i++) {
      const along = (Math.random() - 0.5) * 2 + Math.sign(Math.random() - 0.5) * 0.4;
      const v = 2 + Math.random() * (3 + speed * 0.35);
      this.sparks.add({
        x, y, z, vx: tx * along * v + nx * v * 0.5 * Math.random(), vy: 1 + Math.random() * 4, vz: tz * along * v + nz * v * 0.5 * Math.random(),
        r: 1, g: 0.75 + Math.random() * 0.2, b: 0.3, a: 1, s: 0.18 + Math.random() * 0.16, age: 0, life: 0.35 + Math.random() * 0.55,
      });
    }
  }

  debrisBurst(x, y, z, vx, vz, n, colors, size = 1) {
    for (let i = 0; i < n && this.debris.length < this.maxDebris; i++) {
      const col = colors[Math.floor(Math.random() * colors.length)];
      const s = (0.04 + Math.random() * 0.12) * size;
      this.debris.push({
        x, y, z, vx: vx * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 5, vy: 1.5 + Math.random() * 4, vz: vz * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 5,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, wx: (Math.random() - 0.5) * 18, wy: (Math.random() - 0.5) * 18, wz: (Math.random() - 0.5) * 18,
        sx: s * (0.6 + Math.random()), sy: s * (0.3 + Math.random() * 0.5), sz: s * (0.6 + Math.random()), color: col, age: 0, life: 9 + Math.random() * 4, gy: this.groundAt(x, z, y),
      });
    }
  }

  smokePuff(x, y, z, dark, n = 1) {
    for (let i = 0; i < n; i++) {
      const g = dark ? 0.12 + Math.random() * 0.08 : 0.55 + Math.random() * 0.2;
      this.smoke.add({
        x: x + (Math.random() - 0.5) * 0.4, y, z: z + (Math.random() - 0.5) * 0.4, vx: (Math.random() - 0.5) * 0.6, vy: 0.9 + Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.6,
        r: g, g, b: g * 1.02, a: dark ? 0.55 : 0.4, a0: dark ? 0.55 : 0.4, s: 0.5, s0: 0.5 + Math.random() * 0.4, age: 0, life: 2.2 + Math.random() * 1.4,
      });
    }
  }

  update(dt, camera, renderer) {
    const scale = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.sparks.mat.uniforms.uScale.value = this.smoke.mat.uniforms.uScale.value = scale;
    this.sparks.update(dt, (p, h) => {
      p.vy -= 9.8 * h; p.x += p.vx * h; p.y += p.vy * h; p.z += p.vz * h;
      const k = p.age / p.life;
      // white-hot -> yellow -> orange as it cools
      p.r = 1; p.g = Math.max(0.32, 0.95 - k * 0.9); p.b = Math.max(0.0, 0.55 - k * 1.4); p.a = 1 - k * k;
      return true;
    });
    this.smoke.update(dt, (p, h) => {
      p.x += p.vx * h; p.y += p.vy * h; p.z += p.vz * h; p.vy *= 1 - h * 0.4;
      const k = p.age / p.life;
      p.s = p.s0 + k * 2.6; p.a = p.a0 * (1 - k);
      return true;
    });
    // debris
    const m = this._m, q = this._q, e = this._e, v = this._v, s = this._s;
    let n = 0;
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age > d.life) continue;
      if (d.y > d.gy + d.sy / 2 || d.vy > 0) {
        d.vy -= 9.8 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
        if (d.y < d.gy + d.sy / 2) {
          d.y = d.gy + d.sy / 2;
          d.vy = Math.abs(d.vy) > 1.2 ? -d.vy * 0.3 : 0;
          d.vx *= 0.55; d.vz *= 0.55; d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
        }
      }
      this.debris[n++] = d;
    }
    this.debris.length = n;
    for (let i = 0; i < n; i++) {
      const d = this.debris[i];
      const fade = Math.min(1, (d.life - d.age) / 1.5);
      q.setFromEuler(e.set(d.rx, d.ry, d.rz));
      m.compose(v.set(d.x, d.y, d.z), q, s.set(d.sx * fade, d.sy * fade, d.sz * fade));
      this.debrisMesh.setMatrixAt(i, m);
      this.debrisMesh.setColorAt(i, this._c.setHex(d.color));
    }
    this.debrisMesh.count = n;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (n) this.debrisMesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ breakaway poles
export class Poles {
  constructor(furniture, fx) {
    this.f = furniture;
    this.fx = fx;
    this.list = furniture?.obstacles || [];
    this.cell = 20;
    this.grid = new Map();
    this.list.forEach((ob) => {
      ob.alive = true;
      const k = `${Math.floor(ob.x / this.cell)},${Math.floor(ob.z / this.cell)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(ob);
    });
    this.anims = [];
  }
  forNear(x, z, r, cb) {
    const c0 = Math.floor((x - r) / this.cell), c1 = Math.floor((x + r) / this.cell);
    const r0 = Math.floor((z - r) / this.cell), r1 = Math.floor((z + r) / this.cell);
    for (let a = c0; a <= c1; a++) for (let b = r0; b <= r1; b++) for (const ob of this.grid.get(`${a},${b}`) || []) if (ob.alive) cb(ob);
  }
  // snap it at the base and let it fall the way the car was going
  knock(ob, dx, dz, speed) {
    ob.alive = false;
    const L = Math.hypot(dx, dz) || 1;
    const height = ob.kind === 'light' ? 8.6 : ob.kind === 'sign' ? 2.9 : 2.6;
    this.anims.push({ ob, dx: dx / L, dz: dz / L, th: 0, w: 0.8 + Math.min(4, speed * 0.12), g: (1.5 * 9.8) / height, done: false });
    const colors = ob.kind === 'stop' ? [0xc41e1e, 0x8a9096, 0xf2f2f2] : ob.kind === 'sign' ? [0x1d6b3c, 0x8a9096] : [0x8a9096, 0x6c7176, 0xdfe7ea];
    this.fx.debrisBurst(ob.x, ob.gy + 0.4, ob.z, dx * 0.4, dz * 0.4, ob.kind === 'light' ? 10 : 5, colors);
  }
  update(dt) {
    for (const a of this.anims) {
      if (a.done) continue;
      a.w += a.g * Math.sin(a.th) * dt; // a rod falling over about its base
      a.th += a.w * dt;
      if (a.th >= 1.52) {
        a.th = 1.52;
        if (a.w > 0.8) { a.w = -a.w * 0.25; this.fx.debrisBurst(a.ob.x + a.dx * 2, a.ob.gy + 0.2, a.ob.z + a.dz * 2, a.dx, a.dz, 3, [0x8a9096]); } else a.done = true;
      }
      this.f.setTilt(a.ob, a.th, a.dx, a.dz);
    }
  }
}

// ------------------------------------------------------------------ damage
const NO_DAMAGE = { power: 1, drag: 1, pull: 0, grip: 1, wobble: 0 };
const PAINT = 0xa3101b;

export class Damage {
  constructor(player, fx, hud) {
    this.player = player;
    this.fx = fx;
    this.hud = hud;
    this.zones = { front: 0, rear: 0, left: 0, right: 0 };
    this.parts = player.parts; // body/cabin meshes, lights, mirrors, wheels
    for (const mesh of [this.parts.body, this.parts.cabin]) mesh.userData.orig = Float32Array.from(mesh.geometry.attributes.position.array);
    this.broken = new Set();
    this.brokenMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 });
    this.smokeT = 0;
    this.el = document.getElementById('damage');
    this.pctEl = document.getElementById('damage-pct');
    this.zoneEls = Object.fromEntries(['front', 'rear', 'left', 'right'].map((z) => [z, document.getElementById(`dz-${z}`)]));
    player.dmg = NO_DAMAGE;
    this.render();
  }

  get total() {
    const z = this.zones;
    return Math.min(100, z.front * 0.4 + z.rear * 0.15 + z.left * 0.225 + z.right * 0.225 + Math.max(z.front, z.rear, z.left, z.right) * 0.25);
  }

  // what the damage does to the driving
  effects() {
    const z = this.zones, f = z.front / 100, side = Math.max(z.left, z.right) / 100;
    return {
      power: 1 - 0.6 * f * f - 0.15 * (z.rear / 100), // crushed radiator / engine, bent exhaust
      drag: 1 + 0.5 * f, // crumpled nose
      pull: ((z.right - z.left) / 100) * 0.09, // bent suspension pulls toward the damaged side
      grip: 1 - 0.18 * side,
      wobble: Math.max(0, side - 0.45) * 1.4, // a bent wheel shimmies
    };
  }

  // a hit at world point (cx, cz) with impact speed (m/s); n = push direction on the car (world)
  hit(cx, cz, impact, nx, nz) {
    const P = this.player;
    if (impact < 2.2) return;
    const h = P.heading, fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h); // forward, left
    const dx = cx - P.x, dz = cz - P.z;
    const along = dx * fx + dz * fz, left = dx * lx + dz * lz;
    const zone = Math.abs(along) > 1.45 ? (along > 0 ? 'front' : 'rear') : left > 0 ? 'left' : 'right';
    let dmg = Math.min(70, Math.pow(impact - 2, 1.35) * 1.15);
    // one crash often makes several contacts in a row (the other car keeps shoving): count the worst once
    const now = performance.now();
    const recent = this.lastHit && now - this.lastHit.t < 300 && this.lastHit.zone === zone ? this.lastHit.dmg : 0;
    this.lastHit = { t: now, zone, dmg: Math.max(dmg, recent) };
    dmg = Math.max(0, dmg - recent);
    this.zones[zone] = Math.min(100, this.zones[zone] + dmg);
    // dent the body where it was hit (push direction in car-local coordinates: x = left, z = forward)
    const pnx = nx * lx + nz * lz, pnz = nx * fx + nz * fz;
    const lp = [Math.max(-0.95, Math.min(0.95, left)), 0.62, Math.max(-2.25, Math.min(2.25, along))];
    this.dent(this.parts.body, lp, [pnx, 0, pnz], Math.min(0.45, 0.02 * impact), Math.min(1.2, 0.5 + impact * 0.035));
    if (Math.abs(along) < 1.2 && impact > 7) this.dent(this.parts.cabin, [lp[0], 1.05, lp[2]], [pnx * 0.7, -0.2, pnz * 0.7], Math.min(0.12, impact * 0.006), 0.7);
    // lights and mirrors near the hit
    const near = (p, r) => Math.hypot(p.x - lp[0], p.z - lp[2]) < r;
    for (const [key, mesh] of Object.entries(this.parts.lamps)) {
      if (key === 'grille' || this.broken.has(key) || !near(mesh.position, impact > 9 ? 1.1 : 0.75) || impact < 4.5) continue;
      this.broken.add(key);
      if (key.startsWith('brake')) mesh.visible = false;
      else { mesh.userData.mat ||= mesh.material; mesh.material = this.brokenMat; mesh.scale.y = 0.6; }
      const wp = mesh.getWorldPosition(new THREE.Vector3());
      this.fx.debrisBurst(wp.x, wp.y, wp.z, -nx * 2, -nz * 2, 6, key.startsWith('head') ? [0xdfe7ea, 0xf4f8fb] : [0xc4141a, 0x8a0a10], 0.6);
    }
    for (const [key, mesh] of Object.entries(this.parts.mirrors)) {
      if (this.broken.has(key) || !near(mesh.position, 0.9) || impact < 5) continue;
      this.broken.add(key);
      mesh.visible = false;
      const wp = mesh.getWorldPosition(new THREE.Vector3());
      this.fx.debrisBurst(wp.x, wp.y, wp.z, nx * 3, nz * 3, 3, [PAINT, 0x111214, 0xdfe7ea], 1.2);
    }
    // body bits
    this.fx.debrisBurst(cx, P.y + 0.5, cz, -nx * 3 + P.vx * 0.3, -nz * 3 + P.vz * 0.3, Math.min(18, Math.round(impact * 0.9)), [PAINT, PAINT, 0x111214, 0x3a3c40]);
    this.apply();
  }

  // rolled onto the roof / side: crush the cabin
  rollHit(speed) {
    if (speed < 1.5) return;
    const dmg = Math.min(40, speed * 6);
    for (const z of ['left', 'right', 'front', 'rear']) this.zones[z] = Math.min(100, this.zones[z] + dmg * (z === 'front' || z === 'rear' ? 0.4 : 0.7));
    this.dent(this.parts.cabin, [0, 1.35, -0.3], [0, -1, 0], Math.min(0.25, speed * 0.05), 1.3);
    this.dent(this.parts.body, [Math.sign(this.player.roll) * -0.9, 0.9, 0], [Math.sign(this.player.roll), -0.3, 0], Math.min(0.15, speed * 0.03), 1.4);
    this.apply();
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

  apply() {
    const P = this.player;
    P.dmg = this.effects();
    // a badly bent wheel leans
    for (const w of this.parts.wheels) {
      const side = w.pivot.position.x > 0 ? 'left' : 'right';
      const bend = Math.max(0, this.zones[side] - 55) / 45;
      w.pivot.rotation.z = (side === 'left' ? 1 : -1) * bend * 0.16 * (w.front ? 1 : 0.6);
    }
    this.render();
  }

  repair() {
    for (const k in this.zones) this.zones[k] = 0;
    for (const mesh of [this.parts.body, this.parts.cabin]) {
      mesh.geometry.attributes.position.array.set(mesh.userData.orig);
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    for (const mesh of Object.values(this.parts.lamps)) { mesh.visible = true; if (mesh.userData.mat) mesh.material = mesh.userData.mat; mesh.scale.y = 1; }
    for (const mesh of Object.values(this.parts.mirrors)) mesh.visible = true;
    for (const mesh of [...Object.values(this.parts.lamps), ...Object.values(this.parts.mirrors)]) if (mesh.userData.home) mesh.position.copy(mesh.userData.home);
    this.broken.clear();
    this.apply();
  }

  // smoke from a damaged engine
  update(dt) {
    const f = this.zones.front;
    if (f < 40) return;
    this.smokeT -= dt;
    if (this.smokeT > 0) return;
    this.smokeT = f > 75 ? 0.05 : 0.12;
    const P = this.player, h = P.heading;
    const x = P.x + Math.sin(h) * 1.5, z = P.z + Math.cos(h) * 1.5;
    this.fx.smokePuff(x, P.y + 1.0, z, f > 75, 1);
  }

  render() {
    const t = Math.round(this.total);
    this.el.hidden = t < 1;
    this.pctEl.textContent = `${t}%`;
    for (const [z, el] of Object.entries(this.zoneEls)) {
      const v = this.zones[z] / 100;
      // green -> yellow -> red
      const hue = Math.round(120 * (1 - Math.min(1, v)));
      el.setAttribute('fill', v < 0.01 ? 'rgba(255,255,255,0.18)' : `hsl(${hue}, 80%, 50%)`);
    }
  }
}

// ------------------------------------------------------------------ everything together
export class CrashSystem {
  constructor({ scene, player, furniture, ground, hud }) {
    this.fx = new CrashFX(scene, ground);
    this.poles = new Poles(furniture, this.fx);
    this.damage = new Damage(player, this.fx, hud);
    this.player = player;
    this.scrapeT = 0;
  }
  setGround(ground) { this.fx.ground = ground; }

  // a collision impulse on the player (impact = closing speed at the contact, m/s)
  impact(ev) {
    const { x, z, nx, nz, impact, kind } = ev;
    const y = this.player.y + 0.5;
    const tx = -nz, tz = nx;
    if (impact > 3 && kind !== 'tree') this.fx.sparkBurst(x, y, z, nx, nz, tx, tz, Math.min(110, Math.round(impact * 5)), impact);
    if (kind === 'tree' && impact > 4) this.fx.debrisBurst(x, y + 0.8, z, -nx * 2, -nz * 2, Math.min(14, Math.round(impact)), [0x3f6b2a, 0x5a8a3a, 0x6b4a2a]);
    this.damage.hit(x, z, impact, nx, nz);
  }
  // sliding along a wall or car: a stream of sparks
  scrape(x, z, nx, nz, speed, dt) {
    this.scrapeT -= dt;
    if (this.scrapeT > 0 || speed < 3) return;
    this.scrapeT = 0.03;
    this.fx.sparkBurst(x, this.player.y + 0.45, z, nx, nz, -nz, nx, Math.min(8, Math.round(speed * 0.4)), speed * 0.5);
  }
  // body hitting the ground while rolling over
  rollHit(speed) {
    const P = this.player;
    this.fx.sparkBurst(P.x, P.y + 0.2, P.z, 0, 0, Math.sin(P.heading), Math.cos(P.heading), Math.min(50, Math.round(speed * 12)), speed * 3);
    this.fx.debrisBurst(P.x, P.y + 0.6, P.z, P.vx * 0.5, P.vz * 0.5, Math.min(20, Math.round(speed * 5)), [PAINT, 0x111214, 0xdfe7ea]);
    this.damage.rollHit(speed);
  }
  repair() { this.damage.repair(); }
  update(dt, camera, renderer) {
    this.poles.update(dt);
    this.damage.update(dt);
    this.fx.update(dt, camera, renderer);
  }
}

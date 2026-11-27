// Crashes for the player's car: sparks, flying debris, smoke and steam; breakaway poles (streetlights,
// stop signs, street-name posts) that snap at the base and fall over. The damage model itself (what
// breaks and what it does to the car) is in damage.js.
import * as THREE from 'three';
import { DamageModel } from './damage.js';

const PAINT = 0xa3101b;

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
    this.scene = scene;
    this.ground = ground; // (x, z, y) -> ground height or null
    // daylight on pale concrete: additive sparks vanish, so they're drawn as solid hot-colored streaks
    this.sparks = new Particles(scene, 900, THREE.NormalBlending);
    this.smoke = new Particles(scene, 420, THREE.NormalBlending);
    this.flames = new Particles(scene, 500, THREE.AdditiveBlending); // flames glow
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

  // white, fast-fading steam (a hot, leaking radiator)
  steamPuff(x, y, z) {
    this.smoke.add({
      x: x + (Math.random() - 0.5) * 0.5, y, z: z + (Math.random() - 0.5) * 0.5, vx: (Math.random() - 0.5) * 0.8, vy: 1.6 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.8,
      r: 0.92, g: 0.94, b: 0.96, a: 0.32, a0: 0.32, s: 0.35, s0: 0.4 + Math.random() * 0.3, age: 0, life: 0.9 + Math.random() * 0.6,
    });
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

  // a tongue of flame: rises, swells and cools from yellow through orange and red to soot
  flamePuff(x, y, z, size) {
    this.flames.add({
      x: x + (Math.random() - 0.5) * 0.3, y, z: z + (Math.random() - 0.5) * 0.3, vx: (Math.random() - 0.5) * 0.7, vy: 1.6 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 0.7,
      r: 1, g: 0.85, b: 0.35, a: 0.6, s: size, s0: size * (0.7 + Math.random() * 0.5), age: 0, life: 0.3 + Math.random() * 0.3,
    });
  }

  update(dt, camera, renderer) {
    const scale = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.sparks.mat.uniforms.uScale.value = this.smoke.mat.uniforms.uScale.value = this.flames.mat.uniforms.uScale.value = scale;
    this.flames.update(dt, (p, h) => {
      p.x += p.vx * h; p.y += p.vy * h; p.z += p.vz * h; p.vy += 1.2 * h;
      const k = p.age / p.life;
      p.s = p.s0 * (1 + k * 0.8) * (1 - k * 0.5);
      p.r = 1; p.g = Math.max(0.18, 0.82 - k * 0.9); p.b = Math.max(0.03, 0.4 - k * 0.9);
      p.a = 0.6 * (1 - k);
      return true;
    });
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
// ------------------------------------------------------------------ everything together
export class CrashSystem {
  constructor({ scene, player, furniture, ground, hud }) {
    this.fx = new CrashFX(scene, ground);
    this.poles = new Poles(furniture, this.fx);
    this.damage = new DamageModel(player, this.fx, hud);
    this.player = player;
    this.scrapeT = 0;
    this.traffic = null; // set by main.js: damaged AI cars steam, smoke and sometimes burn
    this.aiT = 0;
  }
  setGround(ground) { this.fx.ground = ground; }

  // a collision impulse on the player (impact = closing speed at the contact, m/s)
  impact(ev) {
    const { x, z, nx, nz, impact, kind } = ev;
    const y = this.player.y + 0.5;
    const tx = -nz, tz = nx;
    if (impact > 3 && kind !== 'tree') this.fx.sparkBurst(x, y, z, nx, nz, tx, tz, Math.min(110, Math.round(impact * 5)), impact);
    if (kind === 'tree' && impact > 4) this.fx.debrisBurst(x, y + 0.8, z, -nx * 2, -nz * 2, Math.min(14, Math.round(impact)), [0x3f6b2a, 0x5a8a3a, 0x6b4a2a]);
    this.damage.hit(ev);
  }
  // sliding along a wall or car: a stream of sparks
  scrape(x, z, nx, nz, speed, dt) {
    this.damage.scrape(x, z, speed, dt); // paint scuffed where it rubs
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
  // came down hard from a jump or a drop
  landing(v) { this.damage.landing(v); }
  repair() { this.damage.repair(); }
  // AI cars with a crushed front: steam, then smoke, then (rarely) fire, within sight of the player
  updateTraffic(dt) {
    const cars = this.traffic?.cars;
    if (!cars) return;
    this.aiT -= dt;
    const tick = this.aiT <= 0;
    if (tick) this.aiT = 0.08;
    const P = this.player;
    for (const car of cars) {
      const f = car.dent?.[0] || 0;
      if (f < 0.2 && !car.fire) continue;
      if (Math.abs(car.x - P.x) > 260 || Math.abs(car.z - P.z) > 260) continue;
      const h = car.heading, fx = Math.sin(h), fz = Math.cos(h);
      const nose = car.len / 2 - 0.7 - f;
      const x = car.x + fx * nose, z = car.z + fz * nose, y = car.y + 1.05;
      if (car.fire > 0) {
        car.fire = Math.max(0, car.fire - dt / 75);
        const n = Math.round(45 * car.fire * dt + Math.random());
        for (let i = 0; i < n; i++) this.fx.flamePuff(x + (Math.random() - 0.5) * 1.2, y - 0.1, z + (Math.random() - 0.5) * 1.2, 0.2 + 0.3 * car.fire);
        if (tick) this.fx.smokePuff(x, y + 0.6, z, true, 1);
      } else if (tick && Math.random() < 0.6) {
        if (f > 0.45 || car.wrecked) this.fx.smokePuff(x, y, z, f > 0.6, 1);
        else this.fx.steamPuff(x, y - 0.1, z);
      }
    }
  }

  update(dt, camera, renderer) {
    this.poles.update(dt);
    this.damage.update(dt);
    this.updateTraffic(dt);
    this.fx.update(dt, camera, renderer);
  }
}

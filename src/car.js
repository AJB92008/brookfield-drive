// Player car: low-poly model + arcade physics (grip-decay drift model).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const box = (w, h, l, x, y, z) => new THREE.BoxGeometry(w, h, l).translate(x, y, z);

function colorize(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo.toNonIndexed ? geo.toNonIndexed() : geo;
}

// Shared car shape (local +z = forward). Returns { body, details } geometries.
// `body` is uncolored (white) so InstancedMesh colors / material colors tint it.
export function carGeometries({ length = 4.5, width = 1.85, height = 1.0, cabinLen = 2.3, cabinH = 0.62 } = {}) {
  const body = mergeGeometries([
    colorize(box(width, 0.62, length, 0, 0.62, 0), 0xffffff),
    colorize(box(width * 0.86, cabinH, cabinLen, 0, 0.93 + cabinH / 2, -0.25), 0xffffff),
  ]);
  const glassY = 0.93 + cabinH / 2 + 0.03;
  const details = mergeGeometries([
    // windows band (slightly wider/longer than the cabin so it shows on all sides)
    colorize(box(width * 0.875, cabinH * 0.62, cabinLen * 0.92, 0, glassY, -0.25), 0x1d2a35),
    colorize(box(width * 0.8, cabinH * 0.5, 0.06, 0, glassY, -0.25 + cabinLen / 2 + 0.01), 0x1d2a35),
    // lights
    colorize(box(0.42, 0.16, 0.06, -width / 2 + 0.33, 0.72, length / 2 + 0.01), 0xfff6d8),
    colorize(box(0.42, 0.16, 0.06, width / 2 - 0.33, 0.72, length / 2 + 0.01), 0xfff6d8),
    colorize(box(0.42, 0.16, 0.06, -width / 2 + 0.33, 0.74, -length / 2 - 0.01), 0xc4141a),
    colorize(box(0.42, 0.16, 0.06, width / 2 - 0.33, 0.74, -length / 2 - 0.01), 0xc4141a),
    // wheels
    ...[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) =>
      colorize(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10).rotateZ(Math.PI / 2).translate(sx * (width / 2 - 0.08), 0.36, sz * (length / 2 - 0.85)), 0x161616)),
  ]);
  return { body, details };
}

let _blobTex = null;
// Soft dark ellipse used as a contact shadow under cars in photoreal mode.
export function blobTexture() {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.6)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

export class PlayerCar {
  constructor(scene) {
    this.group = new THREE.Group();
    const L = 4.5, W = 1.85;
    this.length = L;
    const body = mergeGeometries([
      box(W, 0.6, L, 0, 0.62, 0),
      box(W * 0.84, 0.58, 2.2, 0, 1.2, -0.3),
      box(W * 0.98, 0.1, 1.1, 0, 0.97, 1.55), // hood bump
    ]);
    const paint = new THREE.MeshLambertMaterial({ color: 0xd42a2a });
    const bodyMesh = new THREE.Mesh(body, paint);
    bodyMesh.castShadow = true;
    this.group.add(bodyMesh);
    const dark = new THREE.MeshLambertMaterial({ color: 0x1b2630 });
    const glass = new THREE.Mesh(mergeGeometries([
      box(W * 0.855, 0.38, 2.0, 0, 1.24, -0.3),
      box(W * 0.78, 0.34, 0.05, 0, 1.22, 0.81),
      box(W * 0.78, 0.3, 0.05, 0, 1.22, -1.41),
    ]), dark);
    this.group.add(glass);
    const stripe = new THREE.Mesh(box(0.35, 0.02, L * 0.98, 0, 1.502, -0.0), new THREE.MeshLambertMaterial({ color: 0xf4f4f4 }));
    stripe.visible = false;
    this.group.add(stripe);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
    this.brakeMat = new THREE.MeshBasicMaterial({ color: 0x6a0a0a });
    for (const sx of [-1, 1]) {
      this.group.add(new THREE.Mesh(box(0.45, 0.16, 0.05, sx * (W / 2 - 0.33), 0.75, L / 2 + 0.01), lightMat));
      this.group.add(new THREE.Mesh(box(0.45, 0.16, 0.05, sx * (W / 2 - 0.33), 0.77, -L / 2 - 0.01), this.brakeMat));
    }
    const tireGeo = new THREE.CylinderGeometry(0.37, 0.37, 0.28, 14).rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.3, 8).rotateZ(Math.PI / 2);
    const tireMat = new THREE.MeshLambertMaterial({ color: 0x151515 });
    const hubMat = new THREE.MeshLambertMaterial({ color: 0xb8b8b8 });
    this.wheels = [];
    for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * (W / 2 - 0.1), 0.37, sz * (L / 2 - 0.85));
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      spin.add(tire, new THREE.Mesh(hubGeo, hubMat));
      pivot.add(spin);
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, front: sz > 0 });
    }
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.4).rotateX(-Math.PI / 2).translate(0, 0.06, 0), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, toneMapped: false }));
    this.blob.visible = false;
    this.blob.renderOrder = 1;
    this.group.add(this.blob);
    scene.add(this.group);

    // physics state
    this.x = 0; this.z = 0; this.y = 0;
    this.heading = 0;
    this.vx = 0; this.vz = 0;
    this.steer = 0;
    this.wheelSpin = 0;
    this.offRoad = false;
    this.onRoadIdx = null;
    this.speed = 0; // signed forward speed m/s
    this.impact = 0; // last collision strength (for camera shake / HUD)
    this.bodyRoll = 0;
    this.bodyPitch = 0;
  }

  place(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vx = this.vz = 0; this.steer = 0; this.speed = 0;
    this.sync();
  }

  get forward() { return [Math.sin(this.heading), Math.cos(this.heading)]; }

  update(dt, input, env) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = -Math.cos(this.heading), rz = Math.sin(this.heading); // right-hand side
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * rx + this.vz * rz;

    this.onRoadIdx = env.roads.roadAt(this.x, this.z);
    this.offRoad = this.onRoadIdx === null;
    const TOP = 62;
    const throttle = input.throttle, brake = input.brake, hb = input.handbrake;

    // longitudinal
    let a = 0;
    if (throttle > 0) {
      if (vf < -0.5) a += 14 * throttle; // braking out of reverse
      else a += (8.5 * Math.max(0, 1 - vf / TOP) + 1.0) * throttle;
    }
    if (brake > 0) {
      if (vf > 0.5) a -= 16 * brake;
      else if (vf > -12) a -= 5.5 * brake; // reverse
    }
    if (!throttle && !brake) a -= Math.sign(vf) * Math.min(Math.abs(vf) / Math.max(dt, 1e-3), 1.1);
    const drag = (this.offRoad ? 1.6 : 0.3) + (this.offRoad ? 0.004 : 0.0015) * vf * vf;
    if (Math.abs(vf) > 0.05) a -= Math.sign(vf) * drag;
    if (hb) a -= Math.sign(vf) * Math.min(Math.abs(vf) / Math.max(dt, 1e-3), 5);
    vf += a * dt;
    if (!throttle && !brake && Math.abs(vf) < 0.15) vf = 0;

    // steering
    const steerTarget = input.steer;
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 7);
    const absV = Math.abs(vf);
    const maxSteer = 0.62 / (1 + absV / 16);
    // yaw > 0 = turning right. Heading increases counter-clockwise seen from above (toward the left),
    // so a right turn decreases heading.
    let yaw = (vf / 2.7) * Math.tan(this.steer * maxSteer);
    const latMax = hb ? 26 : this.offRoad ? 9 : 15;
    const maxYaw = Math.min(2.6, latMax / Math.max(absV, 0.5));
    yaw = Math.max(-maxYaw, Math.min(maxYaw, yaw));
    this.heading -= yaw * dt;

    // lateral grip (world velocity is kept; grip bleeds off the sideways part)
    const grip = hb ? 1.4 : this.offRoad ? 5 : 9;
    const scrub = Math.abs(vl) * (hb ? 0.25 : 0.6) * dt;
    vl *= Math.exp(-grip * dt);
    vf = Math.sign(vf) * Math.max(0, Math.abs(vf) - scrub);

    this.vx = fx * vf + rx * vl;
    this.vz = fz * vf + rz * vl;

    // integrate
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.speed = this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading);

    this.collide(env);

    // stay inside the map
    const b = env.bounds, pad = 150;
    this.x = Math.max(b.minX - pad, Math.min(b.maxX + pad, this.x));
    this.z = Math.max(b.minZ - pad, Math.min(b.maxZ + pad, this.z));

    // (height is handled once per frame in updateVertical)

    // visuals
    this.wheelSpin += (this.speed / 0.37) * dt;
    const latAcc = yaw * this.speed;
    this.bodyRoll += (Math.max(-0.07, Math.min(0.07, -latAcc * 0.006)) - this.bodyRoll) * Math.min(1, dt * 6);
    this.bodyPitch += (Math.max(-0.05, Math.min(0.05, -a * 0.004)) - this.bodyPitch) * Math.min(1, dt * 6);
    this.braking = brake > 0 && vf > 0.5;
    this.sync();
  }

  // Vertical motion: follow the ground under the car (flat in classic mode, the real 3D mesh in
  // photoreal mode). env.ground(x, z, y) returns the surface height just below y+1.6, or null if unknown.
  updateVertical(dt, env) {
    if (!env.ground) { this.y = 0; this.vy = 0; this.slopePitch = 0; return; }
    const g = env.ground(this.x, this.z, this.y);
    if (g === null) return; // tiles still streaming; hold height
    this.vy = (this.vy || 0) - 22 * dt;
    if (g >= this.y + this.vy * dt) {
      this.y = this.y + (g - this.y) * Math.min(1, dt * 20); // follow slopes / ramps
      if (Math.abs(g - this.y) > 0.6) this.y = g;
      this.vy = 0;
    } else {
      this.y += this.vy * dt; // airborne off a ledge
    }
    // pitch to match the slope under the wheels
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const gf = env.ground(this.x + fx * 1.6, this.z + fz * 1.6, this.y);
    const gb = env.ground(this.x - fx * 1.6, this.z - fz * 1.6, this.y);
    const target = gf !== null && gb !== null ? Math.max(-0.35, Math.min(0.35, Math.atan2(gb - gf, 3.2))) : 0;
    this.slopePitch = (this.slopePitch || 0) + (target - (this.slopePitch || 0)) * Math.min(1, dt * 8);
    this.sync();
  }

  collide(env) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let hitSpeed = 0;
    const bounce = (nx, nz, restitution) => {
      const vn = this.vx * nx + this.vz * nz;
      if (vn < 0) {
        this.vx -= (1 + restitution) * vn * nx;
        this.vz -= (1 + restitution) * vn * nz;
        this.vx *= 0.92; this.vz *= 0.92;
        hitSpeed = Math.max(hitSpeed, -vn);
      }
    };
    // two circles cover the car's length
    for (const off of [1.25, -1.25]) {
      const cx = this.x + fx * off, cz = this.z + fz * off;
      const r = 1.05;
      const res = env.buildings.resolveCircle(cx, cz, r);
      if (res.hit) {
        this.x += res.x - cx; this.z += res.z - cz;
        bounce(res.nx, res.nz, 0.25);
      }
      // trees
      if (env.trees) env.trees.forNear(cx, cz, r + 1, (i) => {
        const tx = env.trees.xs[i], tz = env.trees.zs[i], tr = env.trees.rs[i];
        const dx = cx - tx, dz = cz - tz;
        const d = Math.hypot(dx, dz), min = r + tr;
        if (d < min && d > 1e-4) {
          const nx = dx / d, nz = dz / d;
          this.x += nx * (min - d); this.z += nz * (min - d);
          bounce(nx, nz, 0.2);
        }
      });
    }
    // traffic
    if (env.traffic) {
      const hit = env.traffic.collidePlayer(this);
      if (hit) {
        bounce(hit.nx, hit.nz, 0.35);
        this.x += hit.nx * hit.pen; this.z += hit.nz * hit.pen;
      }
    }
    this.impact = hitSpeed;
  }

  sync() {
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(this.bodyPitch + (this.slopePitch || 0), this.heading, this.bodyRoll, 'YXZ');
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -this.steer * 0.5 : 0; // local +x is the car's left side
    }
    this.brakeMat.color.setHex(this.braking ? 0xff2020 : 0x6a0a0a);
  }
}

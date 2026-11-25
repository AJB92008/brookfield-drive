// Player car: 2002 Lexus SC 430, modeled from the published spec sheet.
//   Body: lofted cross-sections built to the official dimensions.
//   Drivetrain: 3UZ-FE torque curve -> torque converter -> 5-speed automatic -> 3.266 final drive -> 245/40R18,
//   rear-wheel-drive traction limit, Cd 0.30 aero drag, rolling resistance, 155 mph limiter.
import * as THREE from 'three';
import { blobTexture } from './car.js';

const MPH = 0.44704;
export const SC430 = {
  name: 'Lexus SC 430',
  year: 2002,
  // Lexus Canada 2002 SC 430 specification sheet
  lengthM: 4.515, widthM: 1.825, heightM: 1.35, wheelbaseM: 2.62, trackF: 1.549, trackR: 1.533,
  massKg: 1742,
  engine: '4.3 L (4293 cc) 3UZ-FE DOHC 32-valve V8, VVT-i',
  hp: 300, hpRpm: 5600, torqueLbFt: 325, torqueNm: 440, torqueRpm: 3400,
  transmission: '5-speed Super ECT automatic', drive: 'Rear-wheel drive',
  finalDrive: 3.266,
  zeroToSixty: 5.9, cd: 0.30, turningCircleM: 10.8, steeringTurns: 3.3,
  tire: '245/40ZR18', wheel: '18 x 8 JJ 5-spoke alloy',
  // not on the Lexus sheet: A650E ratios as published by owners' forums / gearbox references,
  // and the US-market electronic speed limiter
  gears: [3.357, 2.18, 1.424, 1.0, 0.753], reverse: 3.431,
  topSpeedMph: 155,
};

const G = 9.81;
const TIRE_R = (18 * 25.4 + 2 * 245 * 0.4) / 2000; // 245/40R18 -> 0.3266 m
const FRONTAL_AREA = SC430.widthM * SC430.heightM * 0.85; // ~2.09 m^2
const RHO = 1.225, CRR = 0.012, DRIVELINE = 0.86;
const IDLE = 650, REDLINE = 6000, FUEL_CUT = 6250, STALL = 2400, TC_MULT = 2.0;
const MU = 0.93; // summer performance tires (effective, with TRAC/VSC intervening)
const CG_H = 0.5, REAR_STATIC = 0.47; // CG height (m), static rear weight fraction
// Steering lock that gives a curb-to-curb turning circle (outer front tire path) of diameter d meters
// (the physics turns the car about its center: center-path radius = wheelbase / tan(steer),
//  outer front tire sits half a wheelbase ahead and half a track outward of that path)
const steerForCircle = (d) => Math.atan(SC430.wheelbaseM / (Math.sqrt((d / 2) ** 2 - (SC430.wheelbaseM / 2) ** 2) - SC430.trackF / 2));
const MAX_STEER = steerForCircle(SC430.turningCircleM); // matches the official 10.8 m (35.4 ft) turning circle

// Stock = the real car. Sport = more power, no limiter, stickier tires, quicker shifts, tighter steering.
export const TUNES = {
  stock: { label: 'Stock', powerMult: 1, revLimit: FUEL_CUT, shiftRpm: REDLINE - 250, mu: MU, maxSteer: MAX_STEER, steerFalloff: 20, steerRate: 6, latG: 0.92, upshiftTime: 0.42, downshiftTime: 0.28, limiterMph: SC430.topSpeedMph },
  sport: { label: 'Sport tune', powerMult: 1.5, revLimit: 6800, shiftRpm: 6600, mu: 1.12, maxSteer: steerForCircle(8.5), /* 27.9 ft turning circle */ steerFalloff: 34, steerRate: 9, latG: 1.05, upshiftTime: 0.18, downshiftTime: 0.15, limiterMph: null },
};
const turningCircleFt = (t) => {
  const rCenter = SC430.wheelbaseM / Math.tan(t.maxSteer);
  return 2 * Math.hypot(rCenter + SC430.trackF / 2, SC430.wheelbaseM / 2) * 3.281;
};
export const tuneSummary = (t) => ({
  hp: Math.round(SC430.hp * t.powerMult), lbft: Math.round(SC430.torqueLbFt * t.powerMult),
  limiter: t.limiterMph ? `${t.limiterMph} mph (limited)` : 'none (rev-limited)', turningFt: turningCircleFt(t).toFixed(1),
});
// 3UZ-FE full-throttle torque (N·m) vs rpm, anchored to 440 N·m @ 3400 and 223 kW (300 hp) @ 5600
const TORQUE = [[600, 300], [1000, 335], [2000, 392], [3000, 432], [3400, 440], [4000, 433], [4600, 418], [5000, 405], [5600, 380], [6000, 352], [6250, 330]];
export function engineTorque(rpm) {
  if (rpm <= TORQUE[0][0]) return TORQUE[0][1];
  for (let i = 1; i < TORQUE.length; i++) {
    if (rpm <= TORQUE[i][0]) {
      const [r0, t0] = TORQUE[i - 1], [r1, t1] = TORQUE[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return TORQUE[TORQUE.length - 1][1];
}

// ---------- body model ----------
function lerpTable(table, z, col) {
  if (z <= table[0][0]) return table[0][col];
  for (let i = 1; i < table.length; i++) {
    if (z <= table[i][0]) {
      const t = (z - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
      return table[i - 1][col] + (table[i][col] - table[i - 1][col]) * t;
    }
  }
  return table[table.length - 1][col];
}

// Loft rings (each ring = array of [x,y] around the section) along z into a closed mesh.
function loft(stations, ringFn, segs, colorFn) {
  const pos = [], col = [];
  const rings = stations.map((z) => ringFn(z).map(([x, y]) => [x, y, z]));
  const push = (p, c) => { pos.push(p[0], p[1], p[2]); col.push(c[0], c[1], c[2]); };
  for (let s = 0; s < rings.length - 1; s++) {
    const a = rings[s], b = rings[s + 1];
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs;
      const c = colorFn ? colorFn(a[k], b[k]) : [1, 1, 1];
      // wound so normals point outward (rings run counter-clockwise in x/y, stations run +z)
      push(a[k], c); push(b[k1], c); push(b[k], c);
      push(a[k], c); push(a[k1], c); push(b[k1], c);
    }
  }
  // end caps
  for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    const c = [cx / segs, cy / segs, ring[0][2]];
    const cc = colorFn ? colorFn(c, c) : [1, 1, 1];
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs;
      if (flip) { push(c, cc); push(ring[k1], cc); push(ring[k], cc); } else { push(c, cc); push(ring[k], cc); push(ring[k1], cc); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // smooth normals: merge by position then recompute
  const merged = mergeByPosition(g);
  merged.computeVertexNormals();
  return merged;
}

function mergeByPosition(g) {
  const pos = g.attributes.position.array, col = g.attributes.color.array;
  const map = new Map(), outPos = [], outCol = [], idx = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${pos[i * 3].toFixed(4)},${pos[i * 3 + 1].toFixed(4)},${pos[i * 3 + 2].toFixed(4)},${col[i * 3].toFixed(2)}`;
    let v = map.get(key);
    if (v === undefined) {
      v = outPos.length / 3;
      map.set(key, v);
      outPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      outCol.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
    }
    idx.push(v);
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  m.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
  m.setIndex(idx);
  return m;
}

function buildModel(envMap) {
  const L2 = SC430.lengthM / 2, AX = SC430.wheelbaseM / 2;
  const group = new THREE.Group();
  const paintColor = new THREE.Color(0xa3101b); // "Absolutely Red"
  const paint = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.12, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.12, envMap, envMapIntensity: 0.55 });
  const PAINT = [paintColor.r, paintColor.g, paintColor.b];
  const GLASS = [0.05, 0.07, 0.09];
  const TRIM = [0.06, 0.06, 0.065];

  // Body below the beltline: [z, yTop, halfWidth] coarse profile
  const prof = [
    [-L2, 0.70, 0.5], [-2.22, 0.84, 0.78], [-2.12, 0.91, 0.85], [-2.0, 0.95, 0.885], [-1.6, 0.985, 0.905], [-1.0, 0.99, 0.912],
    [-0.4, 0.98, 0.912], [0.4, 0.955, 0.91], [1.0, 0.875, 0.898], [1.6, 0.79, 0.878], [2.05, 0.69, 0.83], [2.18, 0.62, 0.76], [L2, 0.53, 0.5],
  ];
  const baseBottom = (z) => (z < -2.0 ? 0.24 + Math.pow((-2.0 - z) / (L2 - 2.0), 2) * 0.3 : z > 2.0 ? 0.24 + Math.pow((z - 2.0) / (L2 - 2.0), 2) * 0.2 : 0.2);
  // wheel arches: raise the bottom edge over each axle (semi-circle r 0.40 around y 0.33)
  const archBottom = (z) => {
    let y = baseBottom(z);
    for (const az of [-AX, AX]) {
      const d = Math.abs(z - az);
      if (d < 0.41) y = Math.max(y, 0.33 + Math.sqrt(Math.max(0, 0.41 * 0.41 - d * d)) * 0.92);
    }
    return y;
  };
  const stationsBody = new Set(prof.map((p) => p[0]));
  for (const az of [-AX, AX]) for (const o of [-0.42, -0.38, -0.33, -0.25, -0.15, 0, 0.15, 0.25, 0.33, 0.38, 0.42]) stationsBody.add(+(az + o).toFixed(3));
  for (let z = -L2; z <= L2; z += 0.25) stationsBody.add(+z.toFixed(3));
  const zs = [...stationsBody].filter((z) => z >= -L2 && z <= L2).sort((a, b) => a - b);
  const SEG = 28;
  const bodyRing = (z) => {
    const top = lerpTable(prof, z, 1), hw = lerpTable(prof, z, 2), bot = archBottom(z);
    const cy = (top + bot) / 2, hh = (top - bot) / 2;
    const ring = [];
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      // squircle-ish section; upper half rounds in more (tumblehome)
      const n = s > 0 ? 3.2 : 5;
      const x = hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * (s > 0 ? 1 - 0.06 * s : 1);
      const y = cy + hh * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      ring.push([x, y]);
    }
    return ring;
  };
  const body = new THREE.Mesh(loft(zs, bodyRing, SEG, (p) => (p[1] < 0.27 ? TRIM : PAINT)), paint);
  body.castShadow = true;
  group.add(body);

  // Greenhouse: windshield, side glass, rear glass, body-colored hardtop roof
  const cabin = [
    // z, yBase, yTop, hwBase, hwTop
    [-1.15, 0.985, 0.995, 0.86, 0.84], [-0.95, 0.985, 1.13, 0.85, 0.70], [-0.65, 0.985, 1.29, 0.84, 0.63], [-0.35, 0.985, 1.345, 0.84, 0.61],
    [0.0, 0.975, 1.35, 0.835, 0.61], [0.22, 0.97, 1.30, 0.83, 0.63], [0.45, 0.962, 1.12, 0.825, 0.70], [0.62, 0.955, 0.965, 0.82, 0.80],
  ];
  const CSEG = 20;
  const cabRing = (z) => {
    const yb = lerpTable(cabin, z, 1), yt = lerpTable(cabin, z, 2), wb = lerpTable(cabin, z, 3), wt = lerpTable(cabin, z, 4);
    const ring = [];
    // go around: bottom right -> top right -> roof arc -> top left -> bottom left -> bottom (flat)
    for (let k = 0; k < CSEG; k++) {
      const a = (k / CSEG) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      if (s >= 0) {
        const t = Math.pow(s, 0.6);
        const w = wb + (wt - wb) * t;
        ring.push([w * Math.sign(c) * Math.pow(Math.abs(c), 0.5), yb + (yt - yb) * t]);
      } else ring.push([wb * Math.sign(c) * Math.pow(Math.abs(c), 0.35), yb - 0.01]);
    }
    return ring;
  };
  const czs = [];
  for (let z = -1.15; z <= 0.62 + 1e-6; z += 0.0885) czs.push(+z.toFixed(3));
  const cabinMesh = new THREE.Mesh(loft(czs, cabRing, CSEG, (p, q) => {
    // roof panel (high, between A and C pillars) is body color; everything else is glass
    const y = (p[1] + q[1]) / 2, z = (p[2] + q[2]) / 2, x = Math.abs((p[0] + q[0]) / 2);
    return y > 1.27 && z > -0.75 && z < 0.2 && x < 0.58 ? PAINT : GLASS;
  }), paint);
  cabinMesh.castShadow = true;
  group.add(cabinMesh);

  // lights, grille, mirrors
  const lamp = new THREE.MeshPhysicalMaterial({ color: 0xe9eef2, roughness: 0.05, metalness: 0.1, transmission: 0, envMap, emissive: 0x222222 });
  const tail = new THREE.MeshPhysicalMaterial({ color: 0x8a0a10, roughness: 0.15, envMap, emissive: 0x220000 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6, envMap });
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12).scale(1.25, 0.42, 0.55), lamp);
    hl.position.set(sx * 0.56, 0.63, L2 - 0.3);
    hl.rotation.y = sx * -0.5;
    group.add(hl);
    const tl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12).scale(1.05, 0.45, 0.35), tail);
    tl.position.set(sx * 0.6, 0.8, -L2 + 0.2);
    tl.rotation.y = sx * 0.55;
    group.add(tl);
    const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8).scale(1.1, 0.7, 1.3), new THREE.MeshPhysicalMaterial({ color: 0xa3101b, metalness: 0.12, roughness: 0.38, clearcoat: 1, envMap, envMapIntensity: 0.55 }));
    mirror.position.set(sx * 0.95, 1.04, 0.46);
    group.add(mirror);
  }
  const grille = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 10).scale(1.5, 0.45, 0.25), dark);
  grille.position.set(0, 0.47, L2 - 0.03);
  group.add(grille);
  const brakeLights = new THREE.MeshBasicMaterial({ color: 0x3a0306 });
  for (const sx of [-1, 1]) {
    const bl = new THREE.Mesh(new THREE.CircleGeometry(0.07, 12), brakeLights);
    bl.position.set(sx * 0.6, 0.8, -L2 + 0.05);
    bl.rotation.y = Math.PI;
    group.add(bl);
  }

  // wheels: 245/40R18 tires on 18" 5-spoke alloys
  const tireGeo = new THREE.CylinderGeometry(TIRE_R, TIRE_R, 0.245, 28, 1, true).rotateZ(Math.PI / 2);
  const sidewallGeo = new THREE.RingGeometry(0.2286, TIRE_R, 28).rotateY(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.2286, 0.2286, 0.2, 28, 1, true).rotateZ(Math.PI / 2); // barrel only
  const hubFace = new THREE.CircleGeometry(0.2286, 28).rotateY(Math.PI / 2);
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9, side: THREE.DoubleSide });
  const alloy = new THREE.MeshStandardMaterial({ color: 0xd6d8da, metalness: 0.9, roughness: 0.25, envMap });
  const barrel = new THREE.MeshStandardMaterial({ color: 0x2c2f32, metalness: 0.5, roughness: 0.5, envMap, side: THREE.DoubleSide });
  const wheels = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const track = sz > 0 ? SC430.trackF : SC430.trackR;
    const pivot = new THREE.Group();
    pivot.position.set(sx * (track / 2), TIRE_R, sz * AX);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, rubber);
    tire.castShadow = true;
    spin.add(tire, new THREE.Mesh(rimGeo, barrel));
    for (const side of [1, -1]) {
      const wall = new THREE.Mesh(sidewallGeo, rubber);
      wall.position.x = side * 0.1225;
      if (side < 0) wall.rotation.y = Math.PI;
      spin.add(wall);
    }
    // 5 spokes + center cap on the outer face
    const face = sx * 0.105;
    const dish = new THREE.Mesh(hubFace, barrel);
    dish.position.x = sx * 0.04;
    if (sx < 0) dish.rotation.y = Math.PI;
    spin.add(dish);
    for (let k = 0; k < 5; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.055), alloy);
      spoke.position.set(face, 0, 0);
      spoke.rotation.x = (k / 5) * Math.PI * 2;
      spoke.translateY(0.11);
      spin.add(spoke);
    }
    const ringOuter = new THREE.Mesh(new THREE.TorusGeometry(0.215, 0.018, 6, 28).rotateY(Math.PI / 2), alloy);
    ringOuter.position.x = face;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 12).rotateZ(Math.PI / 2), alloy);
    cap.position.x = face;
    spin.add(ringOuter, cap);
    pivot.add(spin);
    group.add(pivot);
    wheels.push({ pivot, spin, front: sz > 0 });
  }
  return { group, wheels, brakeLights };
}

// Simple outdoor reflection environment: blue sky overhead, bright horizon, gray ground below.
function skyEnvironment() {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const cols = [];
  const pos = geo.attributes.position;
  const sky = new THREE.Color(0x7fa6cc), horizon = new THREE.Color(0xc4ccd2), ground = new THREE.Color(0x3c3a37);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) c.copy(horizon).lerp(sky, Math.pow(y, 0.6)); else c.copy(horizon).lerp(ground, Math.min(1, -y * 4));
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  // a soft "sun" highlight
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  sun.position.set(-5, 7.5, 3.8);
  scene.add(sun);
  return scene;
}

export class PlayerCar {
  constructor(scene, renderer) {
    let envMap = null;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      envMap = pmrem.fromScene(skyEnvironment(), 0.02).texture;
      pmrem.dispose();
    } catch { /* reflections are optional */ }
    const model = buildModel(envMap);
    this.group = model.group;
    this.wheels = model.wheels;
    this.brakeMat = model.brakeLights;
    this.length = SC430.lengthM;
    this.spec = SC430;
    this.tuneName = 'sport';
    this.tune = TUNES.sport;
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 5.2).rotateX(-Math.PI / 2).translate(0, 0.06, 0), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, toneMapped: false }));
    this.blob.visible = false;
    this.blob.renderOrder = 1;
    this.group.add(this.blob);
    scene.add(this.group);

    this.x = 0; this.z = 0; this.y = 0;
    this.heading = 0;
    this.vx = 0; this.vz = 0;
    this.steer = 0;
    this.wheelSpin = 0;
    this.speed = 0; // signed forward speed (m/s)
    this.groundSpeed = 0; // |velocity| (m/s): what the speedometer shows
    this.gear = 1; // 1..5, -1 = reverse
    this.rpm = IDLE;
    this.shiftTimer = 0;
    this.accel = 0;
    this.impact = 0;
    this.bodyRoll = 0; this.bodyPitch = 0;
    this.offRoad = false;
  }

  setTune(name) {
    this.tuneName = TUNES[name] ? name : 'sport';
    this.tune = TUNES[this.tuneName];
  }

  place(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vx = this.vz = 0; this.steer = 0; this.speed = 0; this.groundSpeed = 0;
    this.gear = 1; this.rpm = IDLE; this.accel = 0;
    this.sync();
  }

  get gearLabel() {
    if (this.gear < 0) return 'R';
    if (this.groundSpeed < 0.3 && this.rpm <= IDLE + 50) return 'D';
    return `D${this.gear}`;
  }

  update(dt, input, env) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = -Math.cos(this.heading), rz = Math.sin(this.heading);
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * rx + this.vz * rz;
    const m = SC430.massKg;

    this.onRoadIdx = env.roads.roadAt(this.x, this.z);
    this.offRoad = this.onRoadIdx === null;
    const T = this.tune;
    const mu = this.offRoad ? 0.65 : T.mu;
    let throttle = input.throttle, brake = input.brake;

    // Gear selection: S held at a standstill selects reverse; W selects drive again.
    if (this.gear > 0 && brake > 0 && !throttle && vf < 0.4) this.gear = -1;
    else if (this.gear < 0 && throttle > 0 && vf > -0.4) this.gear = 1;
    // in reverse, S is the accelerator and W the brake
    if (this.gear < 0) [throttle, brake] = [brake, throttle];

    // ----- powertrain -----
    const ratio = this.gear < 0 ? SC430.reverse : SC430.gears[this.gear - 1];
    const total = ratio * SC430.finalDrive;
    const wheelRpm = (Math.abs(vf) / TIRE_R) * (60 / (2 * Math.PI));
    const lockedRpm = wheelRpm * total;
    // torque converter: slips below stall speed (engine revs up, torque multiplied)
    let engineRpm, tcMult = 1;
    if (lockedRpm < STALL) {
      const stallTarget = IDLE + (STALL - IDLE) * throttle;
      engineRpm = Math.max(lockedRpm, stallTarget);
      tcMult = 1 + (TC_MULT - 1) * Math.max(0, 1 - lockedRpm / Math.max(stallTarget, 1));
    } else engineRpm = lockedRpm;
    this.rpm += (Math.min(engineRpm, T.revLimit) - this.rpm) * Math.min(1, dt * 12);

    let driveForce = 0;
    const limited = this.gear > 0 && T.limiterMph && vf >= T.limiterMph * MPH;
    if (throttle > 0 && engineRpm < T.revLimit && !limited) {
      const shiftCut = this.shiftTimer > 0 ? 0.35 : 1;
      driveForce = (engineTorque(Math.min(engineRpm, FUEL_CUT)) * T.powerMult * throttle * tcMult * total * DRIVELINE * shiftCut) / TIRE_R;
    } else if (!throttle && lockedRpm > IDLE * 1.2) {
      // engine braking (closed throttle)
      driveForce = -((25 + 0.006 * lockedRpm) * total * DRIVELINE) / TIRE_R;
    }
    if (this.gear < 0) driveForce = -driveForce;

    // rear-wheel-drive traction limit with longitudinal load transfer (TRAC)
    const rearLoad = m * G * REAR_STATIC + (m * this.accel * CG_H) / SC430.wheelbaseM;
    const maxTraction = mu * Math.max(0, rearLoad);
    driveForce = Math.max(-maxTraction, Math.min(maxTraction, driveForce));

    // brakes (4-wheel discs + ABS): up to ~1 g on dry pavement
    let brakeForce = brake * mu * m * G * 0.98;
    if (input.handbrake) brakeForce = Math.max(brakeForce, mu * m * G * 0.45);
    const aero = 0.5 * RHO * SC430.cd * FRONTAL_AREA * vf * vf;
    const rolling = CRR * m * G * (this.offRoad ? 4 : 1);
    // automatic in gear with no throttle: torque-converter creep holds the car on gentle slopes (~7%)
    // when nearly stopped; steeper hills still roll it back
    const creepHold = this.gear !== 0 && !throttle ? m * G * 0.07 * Math.max(0, 1 - Math.abs(vf) / 2) : 0;
    let resist = aero + rolling + brakeForce + creepHold;
    let a = driveForce / m;
    // gravity along the slope: slopePitch > 0 means the nose points downhill
    a += G * Math.sin(this.slopePitch || 0);
    // resistances always oppose motion and can't reverse it
    const slopeForce = m * G * Math.sin(this.slopePitch || 0);
    if (Math.abs(vf) > 1e-3) a -= Math.sign(vf) * (resist / m);
    else if (Math.abs(driveForce + slopeForce) < resist) a = 0; // parked on a slope: brakes/friction hold it
    const newVf = vf + a * dt;
    if (Math.abs(vf) > 1e-3 && Math.sign(newVf) !== Math.sign(vf) && Math.abs(driveForce + slopeForce) < resist) vf = 0;
    else vf = newVf;
    this.accel = a;

    // ----- automatic transmission -----
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.gear > 0 && this.shiftTimer === 0) {
      const rpmIn = (g) => wheelRpm * SC430.gears[g - 1] * SC430.finalDrive;
      const upAt = 1900 + (T.shiftRpm - 1900) * throttle;
      const downAt = 1150 + 2400 * throttle;
      if (this.gear < 5 && rpmIn(this.gear) > upAt && rpmIn(this.gear + 1) > 1100) { this.gear++; this.shiftTimer = T.upshiftTime; }
      else if (this.gear > 1 && rpmIn(this.gear) < downAt && rpmIn(this.gear - 1) < T.shiftRpm - 400) { this.gear--; this.shiftTimer = T.downshiftTime; }
    }

    // ----- steering & lateral grip -----
    this.steer += (input.steer - this.steer) * Math.min(1, dt * T.steerRate);
    const absV = Math.abs(vf);
    const steerAngle = (this.steer * T.maxSteer) / (1 + Math.max(0, absV - 5) / T.steerFalloff); // full lock at parking speeds, less at highway speeds (keyboard steering)
    let yaw = (vf / SC430.wheelbaseM) * Math.tan(steerAngle);
    const latMax = (input.handbrake ? T.latG * 1.45 : T.latG) * mu * G; // cornering grip
    const maxYaw = Math.min(2.5, latMax / Math.max(absV, 0.5));
    yaw = Math.max(-maxYaw, Math.min(maxYaw, yaw));
    this.heading -= yaw * dt;
    const grip = input.handbrake ? 1.4 : this.offRoad ? 5 : 10;
    const scrub = Math.abs(vl) * (input.handbrake ? 0.25 : 0.6) * dt;
    vl *= Math.exp(-grip * dt);
    vf = Math.sign(vf) * Math.max(0, Math.abs(vf) - scrub);

    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    const nrx = -Math.cos(this.heading), nrz = Math.sin(this.heading);
    this.vx = nfx * vf + nrx * vl;
    this.vz = nfz * vf + nrz * vl;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.speed = vf;

    this.collide(env);
    const b = env.bounds, pad = 150;
    this.x = Math.max(b.minX - pad, Math.min(b.maxX + pad, this.x));
    this.z = Math.max(b.minZ - pad, Math.min(b.maxZ + pad, this.z));
    this.speed = this.vx * nfx + this.vz * nfz;
    this.groundSpeed = Math.hypot(this.vx, this.vz);

    this.wheelSpin += (this.speed / TIRE_R) * dt;
    const latAcc = yaw * this.speed;
    this.bodyRoll += (Math.max(-0.06, Math.min(0.06, -latAcc * 0.005)) - this.bodyRoll) * Math.min(1, dt * 6);
    this.bodyPitch += (Math.max(-0.04, Math.min(0.04, -a * 0.004)) - this.bodyPitch) * Math.min(1, dt * 6);
    this.braking = brake > 0 && Math.abs(vf) > 0.3;
    this.sync();
  }

  updateVertical(dt, env) {
    if (!env.ground) { this.y = 0; this.vy = 0; this.slopePitch = 0; return; }
    const g = env.ground(this.x, this.z, this.y);
    if (g === null) return;
    this.vy = (this.vy || 0) - 22 * dt;
    if (g >= this.y + this.vy * dt) {
      this.y = this.y + (g - this.y) * Math.min(1, dt * 20);
      if (Math.abs(g - this.y) > 0.6) this.y = g;
      this.vy = 0;
    } else this.y += this.vy * dt;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const gf = env.ground(this.x + fx * 1.3, this.z + fz * 1.3, this.y);
    const gb = env.ground(this.x - fx * 1.3, this.z - fz * 1.3, this.y);
    const target = gf !== null && gb !== null ? Math.max(-0.35, Math.min(0.35, Math.atan2(gb - gf, 2.6))) : 0;
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
    for (const off of [1.3, -1.3]) {
      const cx = this.x + fx * off, cz = this.z + fz * off;
      const r = 0.95;
      const res = env.buildings.resolveCircle(cx, cz, r);
      if (res.hit) { this.x += res.x - cx; this.z += res.z - cz; bounce(res.nx, res.nz, 0.25); }
      if (env.trees) env.trees.forNear(cx, cz, r + 1, (i) => {
        const tx = env.trees.xs[i], tz = env.trees.zs[i], tr = env.trees.rs[i];
        const dx = cx - tx, dz = cz - tz, d = Math.hypot(dx, dz), min = r + tr;
        if (d < min && d > 1e-4) { const nx = dx / d, nz = dz / d; this.x += nx * (min - d); this.z += nz * (min - d); bounce(nx, nz, 0.2); }
      });
    }
    if (env.traffic) {
      const hit = env.traffic.collidePlayer(this);
      if (hit) { bounce(hit.nx, hit.nz, 0.35); this.x += hit.nx * hit.pen; this.z += hit.nz * hit.pen; }
    }
    this.impact = hitSpeed;
  }

  sync() {
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(this.bodyPitch + (this.slopePitch || 0), this.heading, this.bodyRoll, 'YXZ');
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -this.steer * 0.45 : 0;
    }
    this.brakeMat.color.setHex(this.braking ? 0xff1a1a : 0x3a0306);
  }
}

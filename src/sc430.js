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
const INERTIA = (1742 * (4.515 ** 2 + 1.825 ** 2)) / 12; // yaw moment of inertia (kg m^2), uniform slab
// body cross-section corners relative to the center of gravity (x = left, y = up): where it touches the
// ground when it rolls. CG 0.5 m up; 1.825 m wide at the sills, ~1.25 m across the roof, 1.35 m tall.
const CORNERS = [[0.91, -0.5], [-0.91, -0.5], [0.62, 0.85], [-0.62, 0.85]];
// CG height above the ground for a roll angle (+ = right side down), and which corner is lowest
function rollGeometry(roll) {
  const s = Math.sin(roll), c = Math.cos(roll);
  let min = Infinity, k = 0;
  for (let i = 0; i < 4; i++) { const y = CORNERS[i][1] * c - CORNERS[i][0] * s; if (y < min) { min = y; k = i; } }
  return [-min, k];
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Steering assist (hands off the steering on a road): see update(). Two strengths, blended by the gas
// pedal: on the gas it clicks the car onto the road; coasting or braking it only nudges.
const DEG = Math.PI / 180;
const ASSIST = {
  // delay/ramp: s after the last steering input before it starts, then fades in
  // full/off: full strength within `full` of the road's direction, none past `off`
  // gain/maxRate: yaw toward the road = gain x the error (1/s), capped (rad/s; also kept inside the tires' grip)
  gas: { delay: 0.2, ramp: 0.15, full: 12 * DEG, off: 22 * DEG, gain: 4, maxRate: 0.6 },
  coast: { delay: 0.25, ramp: 0.35, full: 5 * DEG, off: 9 * DEG, gain: 0.8, maxRate: 0.05 },
  minSpeed: 3, // m/s
};
const assistParam = (k, g) => ASSIST.coast[k] + (ASSIST.gas[k] - ASSIST.coast[k]) * g;
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

// A body panel that can dent, open, hang and fall off (damage.js): a copy of the source mesh's own surface
// over the triangles `pick(cx, cy, cz, nx, ny, nz)` accepts (centroid, averaged normal), lifted `lift` m off it.
// Geometry stays in car coordinates. `under` lists the source vertices it fully covers, which damage.js
// darkens to show the bare structure once the panel opens or comes off.
function extractPanel(src, pick, lift = 0.004) {
  const pos = src.attributes.position.array, nrm = src.attributes.normal.array, col = src.attributes.color.array, idx = src.index.array;
  const remap = new Map(), P = [], N = [], C = [], I = [];
  const total = new Uint16Array(pos.length / 3), inPanel = new Uint16Array(pos.length / 3);
  // loft() emits two triangles per quad, in order: decide per quad so panel edges run straight
  for (let t = 0; t < idx.length; t += 6) {
    const v = [];
    for (let k = t; k < Math.min(t + 6, idx.length); k++) v.push(idx[k]);
    for (const i of v) total[i]++;
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    for (const i of v) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; nx += nrm[i * 3]; ny += nrm[i * 3 + 1]; nz += nrm[i * 3 + 2]; }
    const nl = Math.hypot(nx, ny, nz) || 1, n = v.length;
    if (!pick(cx / n, cy / n, cz / n, nx / nl, ny / nl, nz / nl, col[v[0] * 3])) continue;
    for (const i of v) {
      inPanel[i]++;
      let j = remap.get(i);
      if (j === undefined) {
        j = P.length / 3;
        remap.set(i, j);
        P.push(pos[i * 3] + nrm[i * 3] * lift, pos[i * 3 + 1] + nrm[i * 3 + 1] * lift, pos[i * 3 + 2] + nrm[i * 3 + 2] * lift);
        N.push(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
        C.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
      }
      I.push(j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  g.computeBoundingBox();
  const under = [];
  for (const i of remap.keys()) if (inPanel[i] === total[i]) under.push(i);
  return { geo: g, under };
}

// Glass for cracks: the same kind of copy, with planar UVs uv(x, y, z) -> [u, v] and a transparent canvas
// texture damage.js draws the cracks on. Hidden until the glass cracks.
function glassOverlay(src, pick, uv, w, h) {
  const { geo } = extractPanel(src, pick, 0.006);
  const p = geo.attributes.position.array, out = new Float32Array((p.length / 3) * 2);
  for (let i = 0; i < p.length / 3; i++) { const [u, v] = uv(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); out[i * 2] = u; out[i * 2 + 1] = v; }
  geo.setAttribute('uv', new THREE.BufferAttribute(out, 2));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
  mesh.visible = false;
  mesh.renderOrder = 2;
  return { mesh, canvas, ctx: canvas.getContext('2d'), tex, cracks: 0, shattered: false };
}

export function buildModel(envMap) {
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
  for (let z = -L2; z <= L2; z += 0.12) stationsBody.add(+z.toFixed(3));
  const zs = [...stationsBody].filter((z) => z >= -L2 && z <= L2).sort((a, b) => a - b);
  const SEG = 36;
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

  // Panels that can come loose (damage.js). Each sits in a pivot at its hinge (or, for a bumper, at the corner
  // it hangs from) with the mesh offset back, so the mesh's own coordinates are still car coordinates.
  const panels = {};
  const addPanel = (name, pick, hingeOf) => {
    const { geo, under } = extractPanel(body.geometry, pick);
    const hinge = hingeOf(geo.boundingBox);
    const pivot = new THREE.Group();
    pivot.position.copy(hinge);
    const mesh = new THREE.Mesh(geo, paint);
    mesh.position.copy(hinge).negate();
    mesh.castShadow = true;
    pivot.add(mesh);
    group.add(pivot);
    panels[name] = { mesh, pivot, hinge: hinge.clone(), under };
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // bumper covers: the whole nose / the lower tail, hanging from the middle until damage.js picks a corner
  addPanel('bumperF', (x, y, z) => z > 1.93, (b) => V(0, (b.min.y + b.max.y) / 2, b.min.z));
  addPanel('bumperB', (x, y, z) => z < -2.0 && y < 0.78, (b) => V(0, (b.min.y + b.max.y) / 2, b.max.z));
  // hood: hinged at the windshield, latched at the nose; trunk lid: hinged at the rear glass
  addPanel('hood', (x, y, z, nx, ny) => z > 0.66 && z < 1.93 && ny > 0.5 && Math.abs(x) < 0.8, (b) => V(0, b.max.y, b.min.z));
  addPanel('trunk', (x, y, z, nx, ny) => z > -2.0 && z < -1.2 && ny > 0.55 && Math.abs(x) < 0.78, (b) => V(0, b.max.y, b.max.z));
  // doors: hinged at the front edge (local +x is the car's left)
  addPanel('doorL', (x, y, z, nx) => nx > 0.55 && z > -0.88 && z < 0.62 && y > 0.34 && y < 0.97, (b) => V(b.max.x, 0, b.max.z));
  addPanel('doorR', (x, y, z, nx) => nx < -0.55 && z > -0.88 && z < 0.62 && y > 0.34 && y < 0.97, (b) => V(b.min.x, 0, b.max.z));

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

  // glass that can crack (windshield, rear glass) or shatter (side windows); glass is the dark vertex color
  const isGlass = (c) => c < 0.3;
  const glass = {
    windshield: glassOverlay(cabinMesh.geometry, (x, y, z, nx, ny, nz, c) => isGlass(c) && z > 0.15 && nz > 0.3, (x, y) => [(x + 0.9) / 1.8, (y - 0.95) / 0.42], 512, 256),
    rear: glassOverlay(cabinMesh.geometry, (x, y, z, nx, ny, nz, c) => isGlass(c) && z < -0.7 && nz < -0.3, (x, y) => [(0.9 - x) / 1.8, (y - 0.95) / 0.42], 256, 128),
    sideL: glassOverlay(cabinMesh.geometry, (x, y, z, nx, ny, nz, c) => isGlass(c) && nx > 0.45 && Math.abs(nz) < 0.6, (x, y, z) => [(z + 1.2) / 1.85, (y - 0.95) / 0.42], 256, 128),
    sideR: glassOverlay(cabinMesh.geometry, (x, y, z, nx, ny, nz, c) => isGlass(c) && nx < -0.45 && Math.abs(nz) < 0.6, (x, y, z) => [(0.65 - z) / 1.85, (y - 0.95) / 0.42], 256, 128),
  };
  for (const gl of Object.values(glass)) group.add(gl.mesh);

  // lights, grille, mirrors
  const lamp = new THREE.MeshPhysicalMaterial({ color: 0xe9eef2, roughness: 0.05, metalness: 0.1, transmission: 0, envMap, emissive: 0x222222 });
  const tail = new THREE.MeshPhysicalMaterial({ color: 0x8a0a10, roughness: 0.15, envMap, emissive: 0x220000 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6, envMap });
  const lamps = {}, mirrors = {};
  for (const sx of [-1, 1]) {
    const side = sx > 0 ? 'L' : 'R'; // local +x is the car's left
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12).scale(1.25, 0.42, 0.55), lamp);
    lamps['head' + side] = hl;
    hl.position.set(sx * 0.56, 0.63, L2 - 0.3);
    hl.rotation.y = sx * -0.5;
    group.add(hl);
    const tl = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12).scale(1.05, 0.45, 0.35), tail);
    lamps['tail' + side] = tl;
    tl.position.set(sx * 0.6, 0.8, -L2 + 0.2);
    tl.rotation.y = sx * 0.55;
    group.add(tl);
    const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8).scale(1.1, 0.7, 1.3), new THREE.MeshPhysicalMaterial({ color: 0xa3101b, metalness: 0.12, roughness: 0.38, clearcoat: 1, envMap, envMapIntensity: 0.55 }));
    mirror.position.set(sx * 0.95, 1.04, 0.46);
    group.add(mirror);
    mirrors['mirror' + side] = mirror;
  }
  const grille = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 10).scale(1.5, 0.45, 0.25), dark);
  grille.position.set(0, 0.47, L2 - 0.03);
  group.add(grille);
  lamps.grille = grille;
  const brakeLights = new THREE.MeshBasicMaterial({ color: 0x3a0306 });
  for (const sx of [-1, 1]) {
    const bl = new THREE.Mesh(new THREE.CircleGeometry(0.07, 12), brakeLights);
    lamps['brake' + (sx > 0 ? 'L' : 'R')] = bl;
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
  return { group, wheels, brakeLights, parts: { body, cabin: cabinMesh, lamps, mirrors, wheels, panels, glass } };
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
    this.parts = model.parts;
    this.dmg = { power: 1, drag: 1, pull: 0, grip: 1, wobble: 0, maxGear: 5, stuckGear: 0, brake: 1, brakePull: 0, steerLock: 1, rimDrag: 0, engineDead: false, noDrive: false }; // set by the damage model (damage.js)
    this.resetCrashState();
  }

  // spin, rollover and jolt state
  resetCrashState() {
    this.spin = 0; // extra yaw rate from impacts (rad/s, + = heading increasing)
    this.headingRate = 0;
    this.roll = 0; this.rollRate = 0; this.lift = 0; this.lowCorner = 0;
    this.jPitch = 0; this.jPitchRate = 0; this.jRoll = 0; this.jRollRate = 0;
    this.tripped = false; this.flipped = false; this.flipT = 0; this.skidT = 0;
    this.contacts = [];
  }

  setTune(name) {
    this.tuneName = TUNES[name] ? name : 'sport';
    this.tune = TUNES[this.tuneName];
  }

  place(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vx = this.vz = 0; this.steer = 0; this.speed = 0; this.groundSpeed = 0;
    this.gear = 1; this.rpm = IDLE; this.accel = 0;
    this.camHeading = heading;
    if (this.resetCrashState) this.resetCrashState();
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
    const wasOff = this.offRoad;
    this.offRoad = this.onRoadIdx === null;
    const T = this.tune, D = this.dmg;
    const mu = (this.offRoad ? 0.65 : T.mu) * D.grip;
    // up on two wheels or more: no traction, no steering
    const rolled = Math.abs(this.roll) > 0.45;
    let throttle = rolled ? 0 : input.throttle, brake = rolled ? 0 : input.brake;
    this.throttleIn = throttle; // engine load, for the damage model's cooling
    const driveOk = !D.engineDead && !D.noDrive;

    // Gear selection: S held at a standstill selects reverse; W selects drive again. (A jammed gearbox
    // can't.)
    if (this.gear > 0 && brake > 0 && !throttle && vf < 0.4 && !D.stuckGear) this.gear = -1;
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
    this.rpm += ((D.engineDead ? 0 : Math.min(engineRpm, T.revLimit)) - this.rpm) * Math.min(1, dt * 12);

    let driveForce = 0;
    const limited = this.gear > 0 && T.limiterMph && vf >= T.limiterMph * MPH;
    if (throttle > 0 && engineRpm < T.revLimit && !limited && driveOk) {
      const shiftCut = this.shiftTimer > 0 ? 0.35 : 1;
      driveForce = (engineTorque(Math.min(engineRpm, FUEL_CUT)) * T.powerMult * D.power * throttle * tcMult * total * DRIVELINE * shiftCut) / TIRE_R;
    }
    if (this.gear < 0) driveForce = -driveForce;
    if (!throttle && lockedRpm > IDLE * 1.2 && driveOk) {
      // engine braking (closed throttle) always opposes the way the wheels are turning
      driveForce = -Math.sign(vf) * ((25 + 0.006 * lockedRpm) * total * DRIVELINE) / TIRE_R;
    }

    // rear-wheel-drive traction limit with longitudinal load transfer (TRAC)
    const rearLoad = m * G * REAR_STATIC + (m * this.accel * CG_H) / SC430.wheelbaseM;
    const maxTraction = mu * Math.max(0, rearLoad);
    driveForce = Math.max(-maxTraction, Math.min(maxTraction, driveForce));

    // brakes (4-wheel discs + ABS): up to ~1 g on dry pavement
    let brakeForce = brake * mu * m * G * 0.98 * D.brake;
    if (input.handbrake) brakeForce = Math.max(brakeForce, mu * m * G * 0.45);
    const aero = 0.5 * RHO * SC430.cd * D.drag * FRONTAL_AREA * vf * vf;
    const rolling = (CRR + D.rimDrag) * m * G * (this.offRoad ? 4 : 1); // + a flat, a bare rim or a missing wheel dragging
    // automatic in gear with no throttle: torque-converter creep holds the car on gentle slopes (~7%)
    // when nearly stopped; steeper hills still roll it back
    const creepHold = this.gear !== 0 && !throttle && driveOk ? m * G * 0.07 * Math.max(0, 1 - Math.abs(vf) / 2) : 0;
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
    if (this.gear > 0 && D.stuckGear) this.gear = D.stuckGear; // jammed: no shifting at all
    else if (this.gear > D.maxGear) { this.gear = D.maxGear; this.shiftTimer = T.downshiftTime; } // lost the top gears
    if (this.gear > 0 && this.shiftTimer === 0 && !D.stuckGear) {
      const rpmIn = (g) => wheelRpm * SC430.gears[g - 1] * SC430.finalDrive;
      const upAt = 1900 + (T.shiftRpm - 1900) * throttle;
      const downAt = 1150 + 2400 * throttle;
      if (this.gear < D.maxGear && rpmIn(this.gear) > upAt && rpmIn(this.gear + 1) > 1100) { this.gear++; this.shiftTimer = T.upshiftTime; }
      else if (this.gear > 1 && rpmIn(this.gear) < downAt && rpmIn(this.gear - 1) < T.shiftRpm - 400) { this.gear--; this.shiftTimer = T.downshiftTime; }
    }

    // ----- steering & lateral grip -----
    // damage: a bent suspension pulls to one side, a bent wheel shimmies
    const steerIn = input.steer + D.pull + D.brakePull * brake + (D.wobble ? D.wobble * 0.06 * Math.sin(performance.now() * 0.013) * Math.min(1, Math.abs(vf) / 10) : 0);
    this.steer += (steerIn - this.steer) * Math.min(1, dt * T.steerRate);
    const absV = Math.abs(vf);
    const steerAngle = (this.steer * T.maxSteer * D.steerLock) / (1 + Math.max(0, absV - 5) / T.steerFalloff); // full lock at parking speeds, less at highway speeds (keyboard steering)
    let yaw = (vf / SC430.wheelbaseM) * Math.tan(steerAngle);
    const latMax = (input.handbrake ? T.latG * 1.45 : T.latG) * mu * G; // cornering grip
    const maxYaw = Math.min(2.5, latMax / Math.max(absV, 0.5));
    yaw = Math.max(-maxYaw, Math.min(maxYaw, yaw));
    // skidding (knocked sideways or spun): tires slide, steering barely bites
    this.skidT = Math.max(0, (this.skidT || 0) - dt);
    const sliding = (this.skidT > 0 && Math.abs(vl) > 1.5) || Math.abs(this.spin) > 0.9;
    if (rolled) yaw = 0;
    else if (sliding) yaw *= 0.35;
    this.heading -= yaw * dt; // the velocity turns with steering (tires gripping)...
    // Steering assist: with no steering input at all, turn the heading onto the direction of the road
    // you're on, so the car tracks straight and follows the road's bends. On the gas it clicks on firmly
    // (within ~22 deg of the road, about a quarter second to line up); coasting or braking it only nudges
    // (within 9 deg, slowly). Any steering input switches it off for that moment and the physics are
    // exactly as without it. Past the window (turning into a junction, a driveway, a U-turn) it does
    // nothing, and it doesn't pull you toward the middle of the lane.
    this.handsOffT = input.steer !== 0 ? 0 : (this.handsOffT || 0) + dt;
    const handsOff = this.laneAssist !== false && input.steer === 0 && !rolled && !sliding && !input.handbrake && this.gear > 0;
    let assistTarget = 0;
    const gas = Math.min(1, throttle / 0.5); // full "click" from half throttle up (analog triggers)
    const delay = assistParam('delay', gas);
    if (handsOff && this.handsOffT > delay && !this.offRoad && vf > ASSIST.minSpeed && Math.abs(this.spin) < 0.1) {
      const hx = Math.sin(this.heading), hz = Math.cos(this.heading);
      const road = env.roads.alignedDir(this.x, this.z, hx, hz);
      if (road) {
        const err = wrapPi(Math.atan2(road.dirX, road.dirZ) - this.heading); // + = the road heads to a larger heading
        const a = Math.abs(err), off = assistParam('off', gas), full = assistParam('full', gas);
        if (a < off) {
          const w = Math.min(1, (off - a) / (off - full)) * Math.min(1, (this.handsOffT - delay) / assistParam('ramp', gas));
          const cap = Math.min(assistParam('maxRate', gas), maxYaw * 0.7);
          assistTarget = Math.max(-cap, Math.min(cap, err * assistParam('gain', gas))) * w;
        }
      }
    }
    // eased (~0.08 s) so the bends between the map's straight road pieces, or grazing the road edge, don't
    // twitch the car; any steering input (or the assist turned off, a skid, the handbrake) zeroes it at once
    this.assistYaw = handsOff ? (this.assistYaw || 0) + (assistTarget - (this.assistYaw || 0)) * Math.min(1, dt / 0.08) : 0;
    this.heading += this.assistYaw * dt;
    // the front wheels show the assist turning them (the steer that would give the same yaw)
    this.assistSteer = this.assistYaw ? Math.max(-1, Math.min(1, (-Math.atan((this.assistYaw * SC430.wheelbaseM) / Math.max(vf, 1)) / (T.maxSteer * D.steerLock)) * (1 + Math.max(0, absV - 5) / T.steerFalloff))) : 0;
    if (rolled) {
      // sliding on its side / roof: body friction, no tires
      const sp = Math.hypot(vf, vl), dec = Math.min(sp, 0.55 * G * dt);
      if (sp > 0) { vf -= (vf / sp) * dec; vl -= (vl / sp) * dec; }
    } else if (sliding && !input.handbrake) {
      // tires skidding sideways: friction-limited, so a hard shove carries you for a while
      vl = Math.sign(vl) * Math.max(0, Math.abs(vl) - mu * G * 0.85 * dt);
      vf = Math.sign(vf) * Math.max(0, Math.abs(vf) - mu * G * 0.2 * dt * Math.min(1, Math.abs(vl) / 4));
    } else {
      const grip = input.handbrake ? 1.4 : this.offRoad ? 5 : 10;
      const scrub = Math.abs(vl) * (input.handbrake ? 0.25 : 0.6) * dt;
      vl *= Math.exp(-grip * dt);
      vf = Math.sign(vf) * Math.max(0, Math.abs(vf) - scrub);
    }

    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    const nrx = -Math.cos(this.heading), nrz = Math.sin(this.heading);
    this.vx = nfx * vf + nrx * vl;
    this.vz = nfz * vf + nrz * vl;
    // ...but a spin from an impact turns the body without turning the velocity (it skids)
    this.heading += this.spin * dt;
    this.headingRate = this.spin - yaw + this.assistYaw;
    const spinFriction = rolled ? 1.6 : sliding ? 2.4 : 5.5; // tires resist the rotation
    this.spin -= Math.sign(this.spin) * Math.min(Math.abs(this.spin), spinFriction * dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.speed = vf;

    // sliding sideways off the pavement at speed digs in and trips the car: rollover
    if (!rolled && Math.abs(vl) > 9 && (this.offRoad || wasOff !== this.offRoad) && !this.tripped) {
      this.tripped = true;
      this.rollRate += Math.sign(vl) * (Math.abs(vl) - 7) * 0.3;
      this.vy = (this.vy || 0) + 1.2;
    }
    if (Math.abs(vl) < 4) this.tripped = false;
    this.stepBody(dt, env);

    this.collide(env, dt);
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
      if (this.vy < -9) env.crash?.landing(-this.vy); // came down hard: underside, suspension, tires
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

  // Rigid-body impulse at a contact point against something solid (n = unit normal pushing the car
  // out, e = restitution, muC = friction along the surface). Returns the closing speed (0 if separating).
  contact(nx, nz, cx, cz, e, muC) {
    const m = SC430.massKg;
    const rx = cx - this.x, rz = cz - this.z;
    const px = rz, pz = -rx; // how the contact point moves per unit of heading rate
    const w = this.headingRate || 0;
    const vcx = this.vx + w * px, vcz = this.vz + w * pz;
    const vn = vcx * nx + vcz * nz;
    if (vn >= 0) return { impact: 0, vt: 0 };
    const rn = px * nx + pz * nz;
    // crumple zones soak up hard hits: the faster the impact, the less it bounces back
    const eff = e * Math.exp(vn / 14) + 0.04;
    const J = (-(1 + eff) * vn) / (1 / m + (rn * rn) / INERTIA);
    const tx = -nz, tz = nx;
    const vt = vcx * tx + vcz * tz, rt = px * tx + pz * tz;
    const Jt = Math.max(-muC * J, Math.min(muC * J, -vt / (1 / m + (rt * rt) / INERTIA)));
    const ix = J * nx + Jt * tx, iz = J * nz + Jt * tz;
    this.applyImpulse(ix, iz, px, pz);
    return { impact: -vn, vt };
  }

  // linear + angular impulse (ix, iz) at a point whose rotation lever is (px, pz); body jolt and tripping
  applyImpulse(ix, iz, px, pz) {
    const m = SC430.massKg;
    const dvx = ix / m, dvz = iz / m;
    this.vx += dvx; this.vz += dvz;
    if (Math.hypot(dvx, dvz) > 2) this.skidT = 1.5; // knocked loose: the tires skid for a moment
    this.spin = Math.max(-6, Math.min(6, this.spin + (ix * px + iz * pz) / INERTIA));
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading), rx = -Math.cos(this.heading), rz = Math.sin(this.heading);
    const dvf = dvx * fx + dvz * fz, dvl = dvx * rx + dvz * rz;
    // the body pitches / rolls with the hit
    this.jPitchRate = Math.max(-5, Math.min(5, this.jPitchRate - dvf * 0.11));
    this.jRollRate = Math.max(-5, Math.min(5, this.jRollRate + dvl * 0.09));
    // a hard enough shove sideways trips the car over
    if (Math.abs(dvl) > 8) this.rollRate += Math.sign(dvl) * (Math.abs(dvl) - 7) * 0.22;
    if (Math.hypot(dvx, dvz) > 6) this.vy = Math.max(this.vy || 0, Math.min(2.5, Math.hypot(dvx, dvz) * 0.12));
  }

  // body roll (rollovers) and the jolt springs
  stepBody(dt, env) {
    // jolts: stiff, damped springs back to level
    this.jPitchRate += (-110 * this.jPitch - 12 * this.jPitchRate) * dt;
    this.jPitch += this.jPitchRate * dt;
    this.jRollRate += (-110 * this.jRoll - 12 * this.jRollRate) * dt;
    this.jRoll += this.jRollRate * dt;
    // rollover: gravity torque about whichever corner is on the ground (from the body's shape)
    if (Math.abs(this.roll) < 0.04 && Math.abs(this.rollRate) < 0.6) {
      this.rollRate += (-80 * this.roll - 12 * this.rollRate) * dt; // on its wheels: suspension
    } else {
      const e = 0.01, dh = (rollGeometry(this.roll + e)[0] - rollGeometry(this.roll - e)[0]) / (2 * e);
      this.rollRate += (-(G * dh) / 1.1 - 0.35 * this.rollRate) * dt;
    }
    const before = this.lowCorner, fast = Math.abs(this.rollRate);
    this.roll = wrapPi(this.roll + this.rollRate * dt);
    const [h, k] = rollGeometry(this.roll);
    this.lowCorner = k;
    if (k !== before && Math.abs(this.roll) > 0.3) {
      // a new corner slams into the ground: energy lost, damage, sparks
      this.rollRate *= 0.62;
      if (fast > 1.2) env.crash?.rollHit(fast);
    }
    this.lift = h - CG_H;
    // resting on its side or roof?
    this.flipT = Math.abs(this.roll) > 0.6 && Math.abs(this.rollRate) < 0.25 && this.groundSpeed < 1 ? this.flipT + dt : 0;
    if (this.flipT > 1.2 && !this.flipped) { this.flipped = true; env.onFlipped?.(); }
    if (Math.abs(this.roll) < 0.1) this.flipped = false;
  }

  collide(env, dt = 1 / 120) {
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let hitSpeed = 0;
    const R = 0.9;
    const hit = (nx, nz, cx, cz, e, muC, kind) => {
      const c = this.contact(nx, nz, cx, cz, e, muC);
      if (c.impact > 1.2) env.crash?.impact({ x: cx, z: cz, nx, nz, impact: c.impact, kind });
      else if (Math.abs(c.vt) > 3) env.crash?.scrape(cx, cz, nx, nz, Math.abs(c.vt), dt);
      hitSpeed = Math.max(hitSpeed, c.impact);
    };
    for (const off of [1.45, 0, -1.45]) {
      const cx = this.x + fx * off, cz = this.z + fz * off;
      const res = env.buildings.resolveCircle(cx, cz, R);
      if (res.hit) {
        this.x += res.x - cx; this.z += res.z - cz;
        hit(res.nx, res.nz, res.x - res.nx * R, res.z - res.nz * R, 0.3, 0.45, 'wall');
      }
      if (env.trees) env.trees.forNear(cx, cz, R + 1, (i) => {
        const tx = env.trees.xs[i], tz = env.trees.zs[i], tr = env.trees.rs[i];
        const dx = cx - tx, dz = cz - tz, d = Math.hypot(dx, dz), min = R + tr;
        if (d < min && d > 1e-4) {
          const nx = dx / d, nz = dz / d;
          this.x += nx * (min - d); this.z += nz * (min - d);
          hit(nx, nz, tx + nx * tr, tz + nz * tr, 0.2, 0.5, 'tree');
        }
      });
      // poles: signal masts are rigid; streetlights and sign posts break away at speed
      if (env.poles) env.poles.forNear(cx, cz, R + 0.5, (ob) => {
        const dx = cx - ob.x, dz = cz - ob.z, d = Math.hypot(dx, dz), min = R + ob.r;
        if (d >= min || d < 1e-4) return;
        const nx = dx / d, nz = dz / d;
        const vn = -(this.vx * nx + this.vz * nz);
        if (ob.breakable && vn > (ob.kind === 'light' ? 3.5 : 1.8)) {
          // snaps off: costs some speed (the base is designed to shear), the pole falls the way you're going
          const absorb = Math.min(vn, ob.kind === 'light' ? 3.2 : 1.2);
          this.applyImpulse(nx * absorb * SC430.massKg, nz * absorb * SC430.massKg, (ob.z + nz * ob.r - this.z), -(ob.x + nx * ob.r - this.x));
          env.poles.knock(ob, this.vx, this.vz, vn);
          env.crash?.impact({ x: ob.x, z: ob.z, nx, nz, impact: absorb + 1.5, kind: 'pole' });
          return;
        }
        this.x += nx * (min - d); this.z += nz * (min - d);
        hit(nx, nz, ob.x + nx * ob.r, ob.z + nz * ob.r, 0.25, 0.4, 'pole');
      });
    }
    if (env.traffic) {
      const t = env.traffic.collidePlayer(this);
      if (t) {
        // momentum exchange with the other vehicle (impulse computed by traffic from both masses),
        // applied at the contact point so off-center hits spin you
        this.x += t.nx * t.pen; this.z += t.nz * t.pen;
        if (t.J > 0) {
          const rx = t.pcx - this.x, rz = t.pcz - this.z;
          this.applyImpulse(t.J * t.nx, t.J * t.nz, rz, -rx);
          if (t.impact > 1.2) env.crash?.impact({ x: t.pcx, z: t.pcz, nx: t.nx, nz: t.nz, impact: t.impact, kind: 'car', mass: t.car?.mass });
        }
        hitSpeed = Math.max(hitSpeed, t.impact);
      }
    }
    this.impact = hitSpeed;
  }

  sync() {
    // rolled over: the model pivots at ground level, so shift it to keep the center of gravity where the
    // physics has it (CG 0.5 m up, lowest corner on the ground)
    const ro = this.roll || 0, sr = Math.sin(ro);
    const side = CG_H * sr, lift = (this.lift || 0) + CG_H * (1 - Math.cos(ro));
    this.group.position.set(this.x + Math.cos(this.heading) * side, this.y + lift + (this.dmgLift || 0), this.z - Math.sin(this.heading) * side);
    this.group.rotation.set(this.bodyPitch + (this.slopePitch || 0) + (this.jPitch || 0) + (this.dmgPitch || 0), this.heading, this.bodyRoll + (this.jRoll || 0) + (this.roll || 0) + (this.dmgRoll || 0), 'YXZ');
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -(this.steer + (this.assistSteer || 0)) * 0.45 : 0;
    }
    this.brakeMat.color.setHex(this.braking ? 0xff1a1a : 0x3a0306);
  }
}

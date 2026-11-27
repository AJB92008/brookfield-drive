// AI vehicle types: low-poly models (local +z = forward, +x = the vehicle's LEFT side, y = 0 on the
// ground), real-world sizes / masses / performance, and a lamp shader so brake lights, turn signals and
// police light bars can light up per instance.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// lamp ids baked into the geometry (vertex attribute `lamp`)
export const LAMP = { NONE: 0, TAIL: 1, LEFT: 2, RIGHT: 3, HEAD: 4, RED: 5, BLUE: 6 };

const COLORS = [0xf2f2f2, 0x1c1c1e, 0x8d9399, 0xb5b9bd, 0x24427a, 0x7a1f1f, 0x2e4d35, 0xc9b38a, 0x3c5f8f, 0x9e2b25, 0x5b5f63, 0xe6e0d0, 0x253b52, 0xd4a017];
const TRUCK_COLORS = [0xf2f2f2, 0xe8e8e8, 0xc9ccd0, 0x9e2b25, 0x24427a, 0x2e4d35, 0x1c1c1e];

function part(geo, hex, lamp = LAMP.NONE) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), lp = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; lp[i] = lamp; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('lamp', new THREE.BufferAttribute(lp, 1));
  return g;
}
const box = (w, h, l, x, y, z, hex, lamp) => part(new THREE.BoxGeometry(w, h, l).translate(x, y, z), hex, lamp);
const wheel = (r, w, x, z) => part(new THREE.CylinderGeometry(r, r, w, 10).rotateZ(Math.PI / 2).translate(x, r, z), 0x151515);
const GLASS = 0x1d2a35, TRIM = 0x2a2b2d, BUMPER = 0x3a3c40;

// Lights common to every vehicle: headlights, tail/brake lights, amber corner signals.
function lights(W, L, yHead, yTail, inset = 0.32) {
  const zf = L / 2 + 0.01, zr = -L / 2 - 0.01;
  return [
    box(0.38, 0.15, 0.06, W / 2 - inset, yHead, zf, 0xfff6d8, LAMP.HEAD),
    box(0.38, 0.15, 0.06, -W / 2 + inset, yHead, zf, 0xfff6d8, LAMP.HEAD),
    box(0.12, 0.12, 0.08, W / 2 - 0.06, yHead, zf - 0.02, 0x6b4a12, LAMP.LEFT),
    box(0.12, 0.12, 0.08, -W / 2 + 0.06, yHead, zf - 0.02, 0x6b4a12, LAMP.RIGHT),
    box(0.4, 0.16, 0.06, W / 2 - inset, yTail, zr, 0x4a0608, LAMP.TAIL),
    box(0.4, 0.16, 0.06, -W / 2 + inset, yTail, zr, 0x4a0608, LAMP.TAIL),
    box(0.14, 0.12, 0.07, W / 2 - 0.07, yTail - 0.16, zr, 0x6b4a12, LAMP.LEFT),
    box(0.14, 0.12, 0.07, -W / 2 + 0.07, yTail - 0.16, zr, 0x6b4a12, LAMP.RIGHT),
  ];
}
const wheels4 = (W, L, r = 0.36, inset = 0.85, wd = 0.26) =>
  [[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => wheel(r, wd, sx * (W / 2 - 0.08), sz * (L / 2 - inset)));

function car({ L, W, bodyH, cabinH, cabinL, cabinZ, wheelR = 0.36, tall = false }) {
  const yb = wheelR * 0.75 + bodyH / 2;
  const top = wheelR * 0.75 + bodyH;
  const body = mergeGeometries([
    part(new THREE.BoxGeometry(W, bodyH, L).translate(0, yb, 0), 0xffffff),
    part(new THREE.BoxGeometry(W * 0.88, cabinH, cabinL).translate(0, top + cabinH / 2, cabinZ), 0xffffff),
  ]);
  const gy = top + cabinH * 0.55;
  const details = [
    box(W * 0.885, cabinH * 0.6, cabinL * 0.93, 0, gy, cabinZ, GLASS),
    box(W * 0.8, cabinH * 0.55, 0.06, 0, gy, cabinZ + cabinL / 2 + 0.01, GLASS),
    box(W * 0.8, cabinH * 0.5, 0.06, 0, gy, cabinZ - cabinL / 2 - 0.01, GLASS),
    box(W + 0.04, 0.2, 0.18, 0, wheelR * 0.75 + 0.12, L / 2 - 0.04, BUMPER),
    box(W + 0.04, 0.2, 0.18, 0, wheelR * 0.75 + 0.12, -L / 2 + 0.04, BUMPER),
    ...lights(W, L, top - 0.16, top - 0.14),
    ...wheels4(W, L, wheelR, tall ? 0.95 : 0.85),
  ];
  return { body, details: mergeGeometries(details) };
}

function pickup({ L = 5.8, W = 2.0 }) {
  const r = 0.42, top = r * 0.75 + 0.78;
  const body = mergeGeometries([
    part(new THREE.BoxGeometry(W, 0.78, L).translate(0, r * 0.75 + 0.39, 0), 0xffffff),
    part(new THREE.BoxGeometry(W * 0.92, 0.72, 2.2).translate(0, top + 0.36, 0.55), 0xffffff),
    // bed walls
    part(new THREE.BoxGeometry(0.1, 0.5, 2.1).translate(W / 2 - 0.05, top + 0.25, -L / 2 + 1.12), 0xffffff),
    part(new THREE.BoxGeometry(0.1, 0.5, 2.1).translate(-W / 2 + 0.05, top + 0.25, -L / 2 + 1.12), 0xffffff),
    part(new THREE.BoxGeometry(W, 0.5, 0.1).translate(0, top + 0.25, -L / 2 + 0.05), 0xffffff),
  ]);
  const details = mergeGeometries([
    box(W * 0.93, 0.42, 2.05, 0, top + 0.42, 0.55, GLASS),
    box(W * 0.85, 0.38, 0.06, 0, top + 0.42, 0.55 + 1.11, GLASS),
    box(W - 0.2, 0.04, 2.05, 0, top + 0.02, -L / 2 + 1.12, TRIM), // bed floor
    box(W * 0.5, 0.4, 0.12, 0, top - 0.25, L / 2 + 0.03, 0x8e9194), // grille
    box(W + 0.04, 0.22, 0.2, 0, r * 0.75 + 0.12, L / 2 - 0.05, BUMPER),
    box(W + 0.04, 0.22, 0.2, 0, r * 0.75 + 0.12, -L / 2 + 0.05, BUMPER),
    ...lights(W, L, top - 0.18, top - 0.2, 0.2),
    ...wheels4(W, L, r, 1.0, 0.3),
  ]);
  return { body, details };
}

function boxTruck() {
  const L = 7.6, W = 2.4, r = 0.5;
  const body = mergeGeometries([
    part(new THREE.BoxGeometry(W, 2.6, 5.4).translate(0, 1.0 + 1.3, -1.05), 0xffffff), // cargo box
  ]);
  const details = mergeGeometries([
    box(W * 0.95, 1.45, 1.9, 0, r + 0.95, L / 2 - 0.95, 0xe9e9e9), // cab
    box(W * 0.9, 0.6, 0.06, 0, r + 1.35, L / 2 + 0.01, GLASS),
    box(W * 0.96, 0.62, 1.3, 0, r + 1.35, L / 2 - 0.85, GLASS),
    box(W, 0.35, L, 0, r + 0.1, 0, TRIM), // chassis
    box(W + 0.04, 0.25, 0.2, 0, r + 0.05, L / 2 - 0.02, BUMPER),
    ...lights(W, L, r + 0.6, r + 0.45, 0.25),
    wheel(r, 0.32, W / 2 - 0.15, L / 2 - 1.2), wheel(r, 0.32, -W / 2 + 0.15, L / 2 - 1.2),
    wheel(r, 0.42, W / 2 - 0.2, -L / 2 + 1.5), wheel(r, 0.42, -W / 2 + 0.2, -L / 2 + 1.5),
  ]);
  return { body, details };
}

function bus() {
  const L = 12.2, W = 2.55, r = 0.5;
  const body = mergeGeometries([part(new THREE.BoxGeometry(W, 2.55, L).translate(0, 0.42 + 1.27, 0), 0xffffff)]);
  const details = mergeGeometries([
    box(W + 0.02, 0.9, L - 2.4, 0, 2.05, -0.6, GLASS), // side windows
    box(W * 0.94, 1.3, 0.06, 0, 1.8, L / 2 + 0.01, GLASS), // windshield
    box(W + 0.03, 0.22, L - 0.2, 0, 1.25, 0, 0x2457a5), // stripe
    box(W * 0.6, 0.3, 0.06, 0, 2.75, L / 2 + 0.02, 0x101010), // destination sign
    box(W * 0.6, 0.18, 0.07, 0, 2.75, L / 2 + 0.03, 0xffb000, LAMP.HEAD),
    box(W + 0.04, 0.3, 0.22, 0, 0.55, L / 2 - 0.05, BUMPER),
    box(W + 0.04, 0.3, 0.22, 0, 0.55, -L / 2 + 0.05, BUMPER),
    ...lights(W, L, 0.75, 0.95, 0.3),
    wheel(r, 0.34, W / 2 - 0.15, L / 2 - 2.5), wheel(r, 0.34, -W / 2 + 0.15, L / 2 - 2.5),
    wheel(r, 0.5, W / 2 - 0.2, -L / 2 + 3.0), wheel(r, 0.5, -W / 2 + 0.2, -L / 2 + 3.0),
  ]);
  return { body, details };
}

function semiTractor() {
  const L = 6.4, W = 2.5, r = 0.52;
  const body = mergeGeometries([
    part(new THREE.BoxGeometry(W * 0.9, 1.25, 2.0).translate(0, r + 0.85, L / 2 - 1.0), 0xffffff), // hood
    part(new THREE.BoxGeometry(W, 2.2, 2.6).translate(0, r + 1.65, 0.2), 0xffffff), // cab + sleeper
  ]);
  const details = mergeGeometries([
    box(W * 0.92, 0.7, 0.06, 0, r + 2.15, 1.51, GLASS),
    box(W + 0.02, 0.6, 1.0, 0, r + 2.1, 1.0, GLASS),
    box(W * 0.7, 0.8, 0.06, 0, r + 0.9, L / 2 + 0.01, 0x9a9da1), // grille
    box(W, 0.3, L, 0, r + 0.15, 0, TRIM), // frame
    box(0.14, 2.4, 0.14, W / 2 - 0.05, r + 1.8, -1.2, 0xb8bcc2), // stacks
    box(0.14, 2.4, 0.14, -W / 2 + 0.05, r + 1.8, -1.2, 0xb8bcc2),
    box(W + 0.04, 0.3, 0.25, 0, r + 0.1, L / 2 - 0.05, BUMPER),
    ...lights(W, L, r + 0.75, r + 0.4, 0.3),
    wheel(r, 0.32, W / 2 - 0.15, L / 2 - 1.2), wheel(r, 0.32, -W / 2 + 0.15, L / 2 - 1.2),
    wheel(r, 0.5, W / 2 - 0.2, -L / 2 + 1.3), wheel(r, 0.5, -W / 2 + 0.2, -L / 2 + 1.3),
    wheel(r, 0.5, W / 2 - 0.2, -L / 2 + 0.3), wheel(r, 0.5, -W / 2 + 0.2, -L / 2 + 0.3),
  ]);
  return { body, details };
}

function trailer() {
  const L = 16.2, W = 2.6, r = 0.5;
  const body = mergeGeometries([part(new THREE.BoxGeometry(W, 2.9, L).translate(0, 1.25 + 1.45, 0), 0xffffff)]);
  const details = mergeGeometries([
    box(W, 0.25, L, 0, 1.15, 0, TRIM),
    box(W + 0.02, 0.3, 1.2, 0, 1.15, L / 2 - 3, 0x55585c), // landing gear area
    ...lights(W, L, 2.5, 1.1, 0.3).slice(4), // rear only
    ...[0.6, 1.9].flatMap((z) => [wheel(r, 0.5, W / 2 - 0.2, -L / 2 + z), wheel(r, 0.5, -W / 2 + 0.2, -L / 2 + z)]),
  ]);
  return { body, details };
}

function police() {
  const v = car({ L: 5.05, W: 2.0, bodyH: 0.8, cabinH: 0.68, cabinL: 2.9, cabinZ: -0.35, wheelR: 0.4, tall: true });
  const top = 0.3 + 0.8 + 0.68;
  const extra = mergeGeometries([
    box(2.0 * 0.885 + 0.01, 0.02, 1.2, 0, top + 0.01, -0.2, 0x111111), // bar base
    box(0.55, 0.14, 0.32, 0.32, top + 0.1, -0.2, 0x5a0a0a, LAMP.RED), // left = red
    box(0.55, 0.14, 0.32, -0.32, top + 0.1, -0.2, 0x0a1a5a, LAMP.BLUE), // right = blue
    box(2.02, 0.42, 1.9, 0, 0.75, 0.05, 0x111214), // black doors
    box(2.0, 0.05, 1.35, 0, 1.12, 1.82, 0x111214), // black hood
    box(1.3, 0.35, 0.18, 0, 0.6, 2.62, 0x111214), // push bar
  ]);
  return { body: v.body, details: mergeGeometries([v.details, extra]) };
}

// spawn share, size, mass, acceleration and top-speed multipliers, which roads they use
export const VEHICLE_TYPES = [
  { id: 'sedan', share: 36, len: 4.8, width: 1.85, mass: 1500, accel: 1, build: () => car({ L: 4.8, W: 1.85, bodyH: 0.62, cabinH: 0.6, cabinL: 2.4, cabinZ: -0.25 }), colors: COLORS },
  { id: 'suv', share: 26, len: 4.9, width: 1.95, mass: 2000, accel: 0.95, build: () => car({ L: 4.9, W: 1.95, bodyH: 0.82, cabinH: 0.7, cabinL: 2.95, cabinZ: -0.3, wheelR: 0.4, tall: true }), colors: COLORS },
  { id: 'pickup', share: 14, len: 5.8, width: 2.0, mass: 2300, accel: 0.9, build: () => pickup({}), colors: COLORS },
  { id: 'van', share: 8, len: 5.15, width: 2.0, mass: 2050, accel: 0.85, build: () => car({ L: 5.15, W: 2.0, bodyH: 0.75, cabinH: 0.85, cabinL: 3.6, cabinZ: -0.5, wheelR: 0.38, tall: true }), colors: COLORS },
  { id: 'boxtruck', share: 4, len: 7.6, width: 2.4, mass: 7000, accel: 0.55, maxMph: 65, big: true, roads: 2, build: boxTruck, colors: TRUCK_COLORS },
  { id: 'bus', share: 2, len: 12.2, width: 2.55, mass: 13000, accel: 0.5, maxMph: 55, big: true, roads: 3, noFreeway: true, build: bus, colors: [0xf4f4f0] },
  { id: 'semi', share: 4, len: 6.4, width: 2.5, mass: 16000, accel: 0.4, maxMph: 65, big: true, roads: 4, trailerLen: 16.2, build: semiTractor, colors: [0xf2f2f2, 0x9e2b25, 0x24427a, 0x1c1c1e, 0x2e4d35, 0xd4a017] },
  { id: 'police', share: 0, len: 5.05, width: 2.0, mass: 2150, accel: 1.15, build: police, colors: [0xf4f4f4] },
];
export const TYPE = Object.fromEntries(VEHICLE_TYPES.map((t) => [t.id, t]));
export const TRAILER = { id: 'trailer', build: trailer };

// Crash damage, per instance (instanced attribute `aDent`: x = front, y = rear, z = left, w = right crush in m).
// Every vertex knows where it sits on the vehicle (`aNorm`: x and z -1..1 across the width and length, y 0..1
// up the height), so a crushed end is pushed in, the roofline over it sags and the metal crumples.
const DENT_HEAD = 'attribute vec3 aNorm;\nattribute vec4 aDent;\n';
const DENT_VERT = `
{
  float fr = smoothstep(0.3, 1.0, aNorm.z), rr = smoothstep(0.3, 1.0, -aNorm.z);
  float lf = smoothstep(0.35, 1.0, aNorm.x), rt = smoothstep(0.35, 1.0, -aNorm.x);
  float mid = 1.0 - 0.6 * abs(aNorm.z);
  transformed.z += aDent.y * rr - aDent.x * fr;
  transformed.x += (aDent.w * rt - aDent.z * lf) * mid;
  float crush = aDent.x * fr + aDent.y * rr + (aDent.z * lf + aDent.w * rt) * mid;
  transformed.y -= crush * 0.2 * smoothstep(0.35, 0.9, aNorm.y);
  transformed.y += crush * 0.07 * sin(position.x * 9.0 + position.z * 7.0);
}`;
function addDent(sh) {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\n${DENT_HEAD}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${DENT_VERT}`);
}

// Lambert material whose emissive picks up per-instance lamp states (instanced attribute `lampState`:
// x = brake 0..1, y = left signal on, z = right signal on, w = police bar 0 off / 1 red / 2 blue).
export function makeLampMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    addDent(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float lamp;\nattribute vec4 lampState;\nvarying float vLampId;\nvarying vec4 vLampState;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampId = lamp;\nvLampState = lampState;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vLampId;
varying vec4 vLampState;
vec3 lampGlow(float id, vec4 st) {
  if (id < 0.5) return vec3(0.0);
  if (id < 1.5) return vec3(1.0, 0.06, 0.04) * (0.25 + 2.2 * st.x);
  if (id < 2.5) return vec3(1.0, 0.5, 0.03) * 2.6 * st.y;
  if (id < 3.5) return vec3(1.0, 0.5, 0.03) * 2.6 * st.z;
  if (id < 4.5) return vec3(1.0, 0.95, 0.8) * 0.5;
  if (id < 5.5) return vec3(1.0, 0.08, 0.06) * (st.w > 0.5 && st.w < 1.5 ? 4.0 : 0.12);
  return vec3(0.12, 0.3, 1.0) * (st.w > 1.5 ? 4.5 : 0.12);
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += lampGlow(vLampId, vLampState);');
  };
  mat.customProgramCacheKey = () => 'vehicle-lamps-dent-v2';
  return mat;
}

// One body + one detail InstancedMesh per vehicle type (+ trailers), each with `count` slots.
export function makeFleetMeshes(scene, count) {
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  bodyMat.onBeforeCompile = addDent;
  bodyMat.customProgramCacheKey = () => 'vehicle-body-dent-v1';
  const lampMat = makeLampMaterial();
  const meshes = {};
  for (const t of [...VEHICLE_TYPES, TRAILER]) {
    const { body, details } = t.build();
    details.setAttribute('lampState', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
    // where each vertex sits on this vehicle (the body's box, shared by its details) + the shared crush state
    body.computeBoundingBox();
    const bb = body.boundingBox, hw = Math.max(bb.max.x, -bb.min.x), hl = Math.max(bb.max.z, -bb.min.z), ht = bb.max.y || 1;
    for (const g of [body, details]) {
      const pa = g.attributes.position.array, nrm = new Float32Array(pa.length);
      for (let i = 0; i < pa.length; i += 3) { nrm[i] = pa[i] / hw; nrm[i + 1] = pa[i + 1] / ht; nrm[i + 2] = pa[i + 2] / hl; }
      g.setAttribute('aNorm', new THREE.BufferAttribute(nrm, 3));
    }
    const dent = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    body.setAttribute('aDent', dent);
    details.setAttribute('aDent', dent);
    const b = new THREE.InstancedMesh(body, bodyMat, count);
    const d = new THREE.InstancedMesh(details, lampMat, count);
    b.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    for (const m of [b, d]) {
      m.castShadow = true;
      m.frustumCulled = false; // instances move around; bounding sphere would go stale
      m.count = 0;
      scene.add(m);
    }
    meshes[t.id] = { body: b, details: d, lamps: details.attributes.lampState, dent, n: 0 };
  }
  return meshes;
}

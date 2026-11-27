// Street furniture renderer: traffic signals (mast arms + cycling lights), stop signs, crosswalks,
// streetlights, street-name blades, sidewalks. Positions come pre-computed in map.furniture.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { T, Troad, sidewalkQuads } from './terrain.js';

const Y_SIDEWALK = 0.055, Y_XWALK = 0.1;
export const SIGNAL_CYCLE = 34; // s: phase 0 green 0-13, yellow 13-16, all-red 16-17, phase 1 green 17-30, yellow 30-33, all-red 33-34

// per-intersection offset so neighboring signals aren't all in sync (shared with AI traffic)
export const signalOffset = (i) => (((i * 7919) % 97) / 97) * SIGNAL_CYCLE;

// state of a phase at cycle time t: 0 red, 1 yellow, 2 green
export function phaseState(phase, t) {
  const c = ((t % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const local = phase === 0 ? c : (c + SIGNAL_CYCLE - 17) % SIGNAL_CYCLE;
  return local < 13 ? 2 : local < 16 ? 1 : 0;
}

// Everything is built per 1.2 km cell so the cells outside the view (and past the fog) get culled:
// one map-wide mesh of every streetlight in Brookfield + Waukesha would be drawn in full every frame.
const CELL = 1200;
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
function inCell(cells, x, z, make) {
  const k = cellKey(x, z);
  let c = cells.get(k);
  if (!c) cells.set(k, (c = make()));
  return c;
}

function place(geo, x, y, z, rotY = 0, rotX = 0, rotZ = 0) {
  const g = geo.clone();
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ'));
  m.setPosition(x, y, z);
  return g.applyMatrix4(m);
}

function stopTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const oct = (r) => { ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; ctx.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); } ctx.closePath(); };
  ctx.fillStyle = '#f4f4f4'; oct(63); ctx.fill();
  ctx.fillStyle = '#c8161d'; oct(57); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('STOP', 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Street-name atlas: white text on transparent, stored in RG8 so it can drive an alphaMap (uses .g).
function nameAtlas(names) {
  // cells shrink when there are too many names to fit a 4096 x 4096 texture (the most many phones take)
  const fit = Math.min(1, Math.sqrt((4096 * 4096 * 0.96) / (names.length * 256 * 32)));
  const CW = Math.floor(256 * fit), CH = Math.floor(32 * fit), COLS = Math.floor(4096 / CW);
  const rows = Math.ceil(names.length / COLS);
  const W = CW * COLS, H = Math.max(CH, rows * CH);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const widths = [];
  names.forEach((n, i) => {
    const x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH;
    let size = Math.round(24 * fit);
    ctx.font = `600 ${size}px "Highway Gothic", "Arial Narrow", Arial, sans-serif`;
    let w = ctx.measureText(n).width;
    const pad = Math.round(12 * fit);
    if (w > CW - pad) { size = Math.floor((size * (CW - pad)) / w); ctx.font = `600 ${size}px "Arial Narrow", Arial, sans-serif`; w = ctx.measureText(n).width; }
    ctx.fillText(n, x + CW / 2, y + CH / 2 + 1);
    widths.push(Math.min(1, (w + 16 * fit) / CW));
  });
  const img = ctx.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(W * H * 2);
  for (let i = 0, j = 0; i < W * H; i++, j += 2) {
    // canvas rows are top-down; DataTexture rows are bottom-up
    const y = Math.floor(i / W), x = i % W;
    const src = ((H - 1 - y) * W + x) * 4 + 3;
    data[j] = data[j + 1] = img[src];
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { tex, CW, CH, COLS, W, H, widths };
}

export function buildFurniture(map, group) {
  const f = map.furniture;
  if (!f) return null;
  const out = new THREE.Group();
  // everything a car can hit: { kind, x, z, gy, r, breakable, rotY, i } (signal poles are rigid; streetlights,
  // stop signs and street-name posts are breakaway, like the real ones)
  const obstacles = [];
  out.name = 'furniture';
  group.add(out);
  const galv = new THREE.MeshLambertMaterial({ color: 0x8a9096 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x24282c });
  const add = (mesh, cast = true) => { mesh.castShadow = cast; mesh.receiveShadow = false; mesh.matrixAutoUpdate = false; mesh.updateMatrix(); out.add(mesh); return mesh; };

  // ---------- traffic signals ----------
  const poleGeo = new THREE.CylinderGeometry(0.16, 0.2, 7, 8).translate(0, 3.5, 0);
  const armGeo = new THREE.CylinderGeometry(0.07, 0.12, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5); // along +z, unit length
  const headGeo = new THREE.BoxGeometry(0.42, 1.15, 0.3);
  const plateGeo = new THREE.BoxGeometry(0.72, 1.45, 0.03);
  const sigCells = new Map(); // cell -> { stat: [], plates: [], lamps: [] }
  const lamps = []; // { si, phase, kind, x, y, z, rotY, mesh, j }
  f.signals.forEach((s, si) => {
    for (const [px, pz, fx, fz, ax, az, len, heads, phase] of s.p) {
      const gy = T(px, pz); // pole base on the real ground
      const cell = inCell(sigCells, px, pz, () => ({ stat: [], plates: [], lamps: [] }));
      const staticParts = cell.stat, plateParts = cell.plates;
      staticParts.push(place(poleGeo, px, gy, pz));
      obstacles.push({ kind: 'signal', x: px, z: pz, gy, r: 0.2, breakable: false });
      const armRot = Math.atan2(ax, az);
      const arm = armGeo.clone().scale(1, 1, len);
      staticParts.push(place(arm, px, gy + 6.6, pz, armRot));
      const faceRot = Math.atan2(fx, fz);
      for (let k = 0; k < heads; k++) {
        const t = Math.max(1.2, len - 0.9 - k * 3.4);
        const hx = px + ax * t, hz = pz + az * t;
        staticParts.push(place(headGeo, hx, gy + 5.95, hz, faceRot));
        plateParts.push(place(plateGeo, hx - fx * 0.17, gy + 5.95, hz - fz * 0.17, faceRot));
        for (let kind = 0; kind < 3; kind++) {
          const l = { si, phase, kind, x: hx + fx * 0.16, y: gy + 6.3 - kind * 0.36, z: hz + fz * 0.16, rotY: faceRot };
          lamps.push(l);
          cell.lamps.push(l);
        }
      }
    }
  });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3();
  const signalMat = new THREE.MeshLambertMaterial({ color: 0x3a3f2e }), lampGeo = new THREE.CircleGeometry(0.13, 12), lampMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const lampMeshes = [];
  for (const cell of sigCells.values()) {
    add(new THREE.Mesh(mergeGeometries(cell.stat), signalMat));
    add(new THREE.Mesh(mergeGeometries(cell.plates), dark));
    const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, cell.lamps.length);
    cell.lamps.forEach((l, j) => {
      q.setFromEuler(e.set(0, l.rotY, 0));
      m4.compose(pv.set(l.x, l.y, l.z), q, sc);
      lampMesh.setMatrixAt(j, m4);
      l.mesh = lampMesh; l.j = j;
    });
    lampMesh.computeBoundingSphere();
    add(lampMesh, false);
    lampMeshes.push(lampMesh);
  }
  const LIT = [new THREE.Color(1, 0.12, 0.08), new THREE.Color(1, 0.72, 0.05), new THREE.Color(0.15, 1, 0.45)];
  const DIM = [new THREE.Color(0.18, 0.04, 0.03), new THREE.Color(0.18, 0.13, 0.02), new THREE.Color(0.03, 0.14, 0.07)];
  const offsets = f.signals.map((s, i) => signalOffset(i));
  let lastKey = '';
  function updateSignals(time) {
    // only touch colors when some signal changed state
    let key = '';
    for (let i = 0; i < offsets.length; i++) key += phaseState(0, time + offsets[i]);
    if (key === lastKey) return;
    lastKey = key;
    for (const l of lamps) {
      const st = phaseState(l.phase, time + offsets[l.si]);
      const on = (l.kind === 0 && st === 0) || (l.kind === 1 && st === 1) || (l.kind === 2 && st === 2);
      l.mesh.setColorAt(l.j, on ? LIT[l.kind] : DIM[l.kind]);
    }
    for (const m of lampMeshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  updateSignals(0);

  // ---------- stop signs ----------
  const nStops = f.stops.length / 4;
  if (nStops) {
    const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.2, 6).translate(0, 1.1, 0), faceGeo = new THREE.PlaneGeometry(0.76, 0.76).translate(0, 2.45, 0.03);
    const backGeo = new THREE.CircleGeometry(0.38, 8).rotateZ(Math.PI / 8).rotateY(Math.PI).translate(0, 2.45, 0.02);
    const faceMat = new THREE.MeshLambertMaterial({ map: stopTexture(), alphaTest: 0.5, side: THREE.FrontSide });
    const cells = new Map();
    for (let i = 0; i < nStops; i++) inCell(cells, f.stops[i * 4], f.stops[i * 4 + 1], () => []).push(i);
    for (const list of cells.values()) {
      const meshes = [new THREE.InstancedMesh(postGeo, galv, list.length), new THREE.InstancedMesh(faceGeo, faceMat, list.length), new THREE.InstancedMesh(backGeo, galv, list.length)];
      list.forEach((i, j) => {
        const [x, z, fx, fz] = f.stops.slice(i * 4, i * 4 + 4);
        q.setFromEuler(e.set(0, Math.atan2(fx, fz), 0));
        m4.compose(pv.set(x, T(x, z), z), q, sc);
        for (const m of meshes) m.setMatrixAt(j, m4);
        obstacles.push({ kind: 'stop', x, z, gy: T(x, z), r: 0.05, breakable: true, rotY: Math.atan2(fx, fz), meshes, i: j });
      });
      for (const m of meshes) { m.computeBoundingSphere(); add(m); }
    }
  }

  // ---------- streetlights (cobra heads) ----------
  const nLights = f.lights.length / 4;
  if (nLights) {
    const geo = mergeGeometries([
      new THREE.CylinderGeometry(0.08, 0.13, 8.6, 6).translate(0, 4.3, 0),
      new THREE.CylinderGeometry(0.045, 0.06, 2.4, 5).rotateX(Math.PI / 2 - 0.12).translate(0, 8.7, 1.15),
      new THREE.BoxGeometry(0.34, 0.16, 0.75).translate(0, 8.82, 2.5),
    ].map((g) => g.toNonIndexed()));
    const cells = new Map();
    for (let i = 0; i < nLights; i++) inCell(cells, f.lights[i * 4], f.lights[i * 4 + 1], () => []).push(i);
    for (const list of cells.values()) {
      const lightsMesh = new THREE.InstancedMesh(geo, galv, list.length);
      list.forEach((i, j) => {
        const [x, z, dx, dz] = f.lights.slice(i * 4, i * 4 + 4);
        q.setFromEuler(e.set(0, Math.atan2(dx, dz), 0));
        m4.compose(pv.set(x, T(x, z), z), q, sc);
        lightsMesh.setMatrixAt(j, m4);
        obstacles.push({ kind: 'light', x, z, gy: T(x, z), r: 0.13, breakable: true, rotY: Math.atan2(dx, dz), meshes: [lightsMesh], i: j });
      });
      lightsMesh.computeBoundingSphere();
      add(lightsMesh);
    }
  }

  // ---------- street-name signs ----------
  const nSigns = f.streetSigns.length / 6;
  if (nSigns) {
    const atlas = nameAtlas(f.streetNames);
    const signGreen = new THREE.MeshLambertMaterial({ color: 0x1d6b3c });
    const textMat = new THREE.MeshBasicMaterial({ color: 0xf4f4f4, alphaMap: atlas.tex, alphaTest: 0.35, side: THREE.DoubleSide });
    const cells = new Map();
    for (let i = 0; i < nSigns; i++) {
      const [x, z, n1, a1, n2, a2] = f.streetSigns.slice(i * 6, i * 6 + 6);
      const gy = T(x, z);
      const cell = inCell(cells, x, z, () => ({ posts: [], blades: [], textPos: [], textUv: [], obs: [] }));
      const { posts, blades, textPos, textUv } = cell;
      posts.push(place(new THREE.CylinderGeometry(0.03, 0.03, 2.9, 5).translate(0, 1.45, 0), x, gy, z));
      const ob = { kind: 'sign', x, z, gy, r: 0.05, breakable: true, i: cell.obs.length };
      cell.obs.push(ob);
      obstacles.push(ob);
      [[n1, a1, 2.82], [n2, a2, 2.6]].forEach(([n, ang, y]) => {
        const len = 0.35 + atlas.widths[n] * 1.0;
        blades.push(place(new THREE.BoxGeometry(0.025, 0.17, len), x, gy + y, z, ang));
        // text quads on both faces; u range covers the used width of the cell, centered
        const col = n % atlas.COLS, row = Math.floor(n / atlas.COLS);
        const uw = atlas.widths[n] * atlas.CW;
        const u0 = (col * atlas.CW + (atlas.CW - uw) / 2) / atlas.W, u1 = (col * atlas.CW + (atlas.CW + uw) / 2) / atlas.W;
        const vTop = 1 - (row * atlas.CH) / atlas.H, vBot = 1 - ((row + 1) * atlas.CH) / atlas.H;
        const s = Math.sin(ang), c = Math.cos(ang);
        const hl = len / 2 - 0.05, hh = 0.075;
        for (const side of [1, -1]) {
          const ox = c * 0.014 * side, oz = -s * 0.014 * side; // blade normal = (cos, -sin) rotated frame x axis
          const P = (along, up) => [x + s * along + ox, gy + y + up, z + c * along + oz];
          // reading direction: on the +side the text runs toward -along so it isn't mirrored
          const a0 = side > 0 ? hl : -hl, a1_ = side > 0 ? -hl : hl;
          const quad = [P(a0, -hh), P(a1_, -hh), P(a1_, hh), P(a0, -hh), P(a1_, hh), P(a0, hh)];
          const uvs = [[u0, vBot], [u1, vBot], [u1, vTop], [u0, vBot], [u1, vTop], [u0, vTop]];
          quad.forEach((p) => textPos.push(...p));
          uvs.forEach((uv) => textUv.push(...uv));
        }
      });
    }
    for (const { posts, blades, textPos, textUv, obs } of cells.values()) {
      const postNI = posts.map((g) => g.toNonIndexed()), bladeNI = blades.map((g) => g.toNonIndexed());
      const postMesh = add(new THREE.Mesh(mergeGeometries(postNI), galv));
      const bladeMesh = add(new THREE.Mesh(mergeGeometries(bladeNI), signGreen));
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute(textPos, 3));
      tg.setAttribute('uv', new THREE.Float32BufferAttribute(textUv, 2));
      tg.computeVertexNormals();
      const textMesh = add(new THREE.Mesh(tg, textMat), false);
      // every sign adds the same number of vertices to each of its cell's merged meshes: [mesh, vertices per sign]
      const parts = [[postMesh, postNI[0].attributes.position.count], [bladeMesh, bladeNI[0].attributes.position.count * 2], [textMesh, 24]];
      for (const [mesh] of parts) mesh.userData.orig = Float32Array.from(mesh.geometry.attributes.position.array);
      for (const ob of obs) ob.parts = parts;
    }
  }

  // ---------- crosswalks + sidewalks (flat) ----------
  const flatCells = new Map(); // cell -> { pos: [], col: [] }
  const white = new THREE.Color(0xf0f0ea), concrete = new THREE.Color(0xc7c3ba);
  const flatAt = (pts) => inCell(flatCells, pts[0][0], pts[0][1], () => ({ pos: [], col: [] }));
  // y = height above the real ground at each corner
  // base: fixed ground height for the whole quad (crosswalks lie on the level road surface)
  const quad = (pts, y, col, base = null) => {
    const { pos, col: cs } = flatAt(pts);
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(pts[k][0], y + 0.15 + (base ?? T(pts[k][0], pts[k][1])), pts[k][1]); cs.push(col.r, col.g, col.b); }
  };
  const quadH = (pts, hs, y, col) => {
    const { pos, col: cs } = flatAt(pts);
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(pts[k][0], y + 0.15 + hs[k], pts[k][1]); cs.push(col.r, col.g, col.b); }
  };
  for (let i = 0; i < f.crosswalks.length; i += 5) {
    const [x, z, dx, dz, w] = f.crosswalks.slice(i, i + 5);
    const px = -dz, pz = dx; // across the road
    const half = w / 2 - 0.3;
    for (let s = -half; s < half - 0.4; s += 1.2) {
      const a = s, b = s + 0.6;
      // bar runs along the road (dx,dz), 2.8 m long
      const c0 = [x + px * a - dx * 1.4, z + pz * a - dz * 1.4], c1 = [x + px * b - dx * 1.4, z + pz * b - dz * 1.4];
      const c2 = [x + px * b + dx * 1.4, z + pz * b + dz * 1.4], c3 = [x + px * a + dx * 1.4, z + pz * a + dz * 1.4];
      quad([c0, c1, c2, c3], Y_XWALK, white, Troad(x, z));
    }
  }
  for (const raw of f.sidewalks) sidewalkQuads(raw, (q, hs) => quadH(q, hs, Y_SIDEWALK, concrete));
  const flatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  for (const { pos: flatPos, col: flatCol } of flatCells.values()) {
    const fg = new THREE.BufferGeometry();
    // make every triangle face up
    for (let i = 0; i < flatPos.length; i += 9) {
      const ax = flatPos[i], az = flatPos[i + 2], bx = flatPos[i + 3], bz = flatPos[i + 5], cx = flatPos[i + 6], cz = flatPos[i + 8];
      if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) {
        for (let k = 0; k < 3; k++) { const t = flatPos[i + 3 + k]; flatPos[i + 3 + k] = flatPos[i + 6 + k]; flatPos[i + 6 + k] = t; }
      }
    }
    fg.setAttribute('position', new THREE.Float32BufferAttribute(flatPos, 3));
    fg.setAttribute('color', new THREE.Float32BufferAttribute(flatCol, 3));
    fg.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(flatPos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const fm = new THREE.Mesh(fg, flatMat);
    fm.receiveShadow = true;
    fm.matrixAutoUpdate = false;
    out.add(fm);
  }

  // Knock a breakaway pole over: rotate it about its base by `angle` toward horizontal direction (dx, dz).
  const tq = new THREE.Quaternion(), ry = new THREE.Quaternion(), ax = new THREE.Vector3(), tv = new THREE.Vector3();
  function setTilt(ob, angle, dx, dz) {
    tq.setFromAxisAngle(ax.set(dz, 0, -dx).normalize(), angle);
    if (ob.kind === 'stop' || ob.kind === 'light') {
      ry.setFromEuler(e.set(0, ob.rotY, 0));
      m4.compose(pv.set(ob.x, ob.gy, ob.z), tq.clone().multiply(ry), sc);
      for (const mesh of ob.meshes) { mesh.setMatrixAt(ob.i, m4); mesh.instanceMatrix.needsUpdate = true; }
    } else if (ob.kind === 'sign') {
      for (const [mesh, per] of ob.parts) {
        const attr = mesh.geometry.attributes.position, a = attr.array, o = mesh.userData.orig;
        const start = ob.i * per;
        for (let k = start; k < start + per; k++) {
          tv.set(o[k * 3] - ob.x, o[k * 3 + 1] - ob.gy, o[k * 3 + 2] - ob.z).applyQuaternion(tq);
          a[k * 3] = tv.x + ob.x; a[k * 3 + 1] = tv.y + ob.gy; a[k * 3 + 2] = tv.z + ob.z;
        }
        attr.clearUpdateRanges();
        attr.addUpdateRange(start * 3, per * 3);
        attr.needsUpdate = true;
      }
    }
  }

  return {
    group: out,
    updateSignals,
    obstacles,
    setTilt,
    offsets,
    stats: { signals: f.signals.length, lamps: lamps.length, stops: nStops, lights: nLights, signs: nSigns, crosswalks: f.crosswalks.length / 5, sidewalks: f.sidewalks.length },
  };
}

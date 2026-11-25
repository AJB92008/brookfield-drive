// Streams the stylized ground (classified from USDA NAIP aerial photos) for classic mode: one low-res
// overview for the whole map plus 500 m tiles around the player, draped on the real terrain grid.
import * as THREE from 'three';
import { T, terrainGrid } from './terrain.js';

const NEAR = 1500; // load full tiles whose center is within this distance (fog ends ~1.5 km)
const FAR = 1900; // and drop them beyond this one
const MAX_INFLIGHT = 6;
const TILE = 500;

// The ground images are flat-colored class maps at ~1 m/px. Plain bilinear filtering smears every edge
// over a meter or two up close, so near the camera the shader looks at the 4 nearest texels, picks the
// color with the most bilinear weight and anti-aliases the boundary: smooth, crisp cartoon edges from
// low-res data. Where texels shrink below a pixel it fades to normal mipmapped sampling (no shimmer).
const GROUND_HEADER = `
float gEq(vec3 a, vec3 b) { vec3 d = a - b; return step(dot(d, d), 1e-6); }
`;
const GROUND_MAP = `
#ifdef USE_MAP
{
  vec2 tsz = vec2(textureSize(map, 0));
  vec2 tp = vMapUv * tsz - 0.5;
  vec2 f = fract(tp);
  ivec2 i0 = ivec2(floor(tp)), hi = ivec2(tsz) - 1;
  vec3 c0 = texelFetch(map, clamp(i0, ivec2(0), hi), 0).rgb;
  vec3 c1 = texelFetch(map, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0).rgb;
  vec3 c2 = texelFetch(map, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0).rgb;
  vec3 c3 = texelFetch(map, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0).rgb;
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  vec4 s = vec4(
    w.x + w.y * gEq(c1, c0) + w.z * gEq(c2, c0) + w.w * gEq(c3, c0),
    w.y + w.x * gEq(c0, c1) + w.z * gEq(c2, c1) + w.w * gEq(c3, c1),
    w.z + w.x * gEq(c0, c2) + w.y * gEq(c1, c2) + w.w * gEq(c3, c2),
    w.w + w.x * gEq(c0, c3) + w.y * gEq(c1, c3) + w.z * gEq(c2, c3));
  vec3 cb = c0; float sb = s.x;
  if (s.y > sb) { cb = c1; sb = s.y; }
  if (s.z > sb) { cb = c2; sb = s.z; }
  if (s.w > sb) { cb = c3; sb = s.w; }
  vec3 cr = cb; float sr = 0.0;
  if (gEq(c0, cb) < 0.5 && s.x > sr) { cr = c0; sr = s.x; }
  if (gEq(c1, cb) < 0.5 && s.y > sr) { cr = c1; sr = s.y; }
  if (gEq(c2, cb) < 0.5 && s.z > sr) { cr = c2; sr = s.z; }
  if (gEq(c3, cb) < 0.5 && s.w > sr) { cr = c3; sr = s.w; }
  float dw = sb - sr;
  float aa = clamp(dw / max(fwidth(dw), 1e-4), 0.0, 1.0);
  vec3 crisp = mix(0.5 * (cb + cr), cb, aa);
  vec3 smoothC = texture2D(map, vMapUv).rgb;
  float fp = max(length(dFdx(vMapUv * tsz)), length(dFdy(vMapUv * tsz)));
  diffuseColor.rgb *= mix(crisp, smoothC, smoothstep(0.9, 2.2, fp));
}
#endif
`;
function makeGroundMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_HEADER}`)
      .replace('#include <map_fragment>', GROUND_MAP);
  };
  mat.customProgramCacheKey = () => 'crisp-ground-v1';
  return mat;
}

export class AerialGround {
  constructor({ group, renderer, base = import.meta.env.BASE_URL, folder = 'ground/' }) {
    this.base = `${base}${folder}`;
    this.group = new THREE.Group();
    this.group.name = 'aerial';
    group.add(this.group);
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.tiles = new Map(); // key -> { mesh, loading }
    this.inflight = 0;
    this.ready = false;
    this.enabled = true;
  }

  async load() {
    const res = await fetch(`${this.base}manifest.json`);
    if (!res.ok) throw new Error(`aerial manifest HTTP ${res.status}`);
    this.manifest = await res.json();
    const ov = this.manifest.overview;
    const tex = await this.loadTexture(ov.file);
    this.overview = this.makeQuad(ov, tex, -1.5, 220); // coarse: kept well below the real ground
    this.overview.renderOrder = -2;
    this.list = Object.entries(this.manifest.tiles).map(([key, t]) => ({ key, ...t, cx: (t.minX + t.maxX) / 2, cz: (t.minZ + t.maxZ) / 2 }));
    this.ready = true;
  }

  loadTexture(file) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(`${this.base}${file}`, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.maxAniso;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // no bleeding across tile seams
        tex.generateMipmaps = true;
        resolve(tex);
      }, undefined, reject);
    });
  }

  // Flat quad covering an extent (local meters), with UVs so north is up in the image.
  makeQuad(ext, tex, y, segs = 1) {
    const w = ext.maxX - ext.minX, h = ext.maxZ - ext.minZ;
    // a grid draped over the real terrain (y = small offset above / below the ground)
    const sx = Math.max(1, Math.round(segs)), sz = Math.max(1, Math.round((segs * h) / w));
    const geo = new THREE.PlaneGeometry(w, h, sx, sz).rotateX(-Math.PI / 2).translate((ext.minX + ext.maxX) / 2, 0, (ext.minZ + ext.maxZ) / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, T(p.getX(i), p.getZ(i)) + y);
    geo.computeVertexNormals();
    // PlaneGeometry UV v=1 is at -z after rotation, i.e. north edge = top of the image. Matches.
    const mat = makeGroundMaterial(tex);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    return mesh;
  }

  // A 500 m tile whose vertices are exactly the terrain grid points (heights straight from the grid) and
  // whose triangles split each cell the same way terrain.js interpolates, so the drawn ground, the roads
  // and the car all agree. UVs map world positions into the tile image using its true extent.
  makeTile(t, tex) {
    const tg = terrainGrid();
    const i = Math.round((t.minX + t.maxX) / 2 / TILE - 0.5), j = Math.round((t.minZ + t.maxZ) / 2 / TILE - 0.5);
    const x0 = i * TILE, z0 = j * TILE;
    if (!tg) return this.makeQuad({ minX: x0, maxX: x0 + TILE, minZ: z0, maxZ: z0 + TILE, uv: t }, tex, 0, 50);
    const n = Math.round(TILE / tg.step) + 1;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = x0 + c * tg.step, z = z0 + r * tg.step, k = r * n + c;
        pos[k * 3] = x; pos[k * 3 + 1] = T(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = (x - t.minX) / (t.maxX - t.minX);
        uv[k * 2 + 1] = 1 - (z - t.minZ) / (t.maxZ - t.minZ);
      }
    }
    const idx = [];
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const A = r * n + c, D = A + 1, B = A + n, C = B + 1;
        idx.push(A, B, D, B, C, D); // split along B-D (see terrain.js)
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, makeGroundMaterial(tex));
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  update(px, pz) {
    if (!this.ready || !this.enabled) return;
    // drop far tiles
    for (const [key, t] of this.tiles) {
      if (t.loading) continue;
      const m = this.manifest.tiles[key];
      if (Math.hypot((m.minX + m.maxX) / 2 - px, (m.minZ + m.maxZ) / 2 - pz) > FAR) {
        t.mesh.removeFromParent();
        t.mesh.geometry.dispose();
        t.mesh.material.map.dispose();
        t.mesh.material.dispose();
        this.tiles.delete(key);
      }
    }
    // load near tiles, closest first
    if (this.inflight >= MAX_INFLIGHT) return;
    const want = [];
    for (const t of this.list) {
      if (this.tiles.has(t.key)) continue;
      const d = Math.hypot(t.cx - px, t.cz - pz);
      if (d < NEAR) want.push([d, t]);
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, t] of want.slice(0, MAX_INFLIGHT - this.inflight)) {
      const entry = { loading: true, mesh: null };
      this.tiles.set(t.key, entry);
      this.inflight++;
      this.loadTexture(t.file).then((tex) => {
        entry.mesh = this.makeTile(t, tex);
        entry.loading = false;
      }).catch((err) => {
        console.warn('[aerial] tile failed', t.key, err?.message || err);
        this.tiles.delete(t.key);
      }).finally(() => { this.inflight--; });
    }
  }

  get stats() {
    let loaded = 0;
    for (const t of this.tiles.values()) if (!t.loading) loaded++;
    return { ready: this.ready, loaded, inflight: this.inflight };
  }
}

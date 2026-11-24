// Streams real aerial photos (USDA NAIP, public domain) as the ground in classic mode:
// one low-res overview for the whole map plus sharp 500 m tiles loaded around the player.
import * as THREE from 'three';

const NEAR = 900; // load full-res tiles whose center is within this distance
const FAR = 1300; // and drop them beyond this one
const MAX_INFLIGHT = 6;

export class AerialGround {
  constructor({ group, renderer, base = import.meta.env.BASE_URL }) {
    this.base = `${base}aerial/`;
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
    this.overview = this.makeQuad(ov, tex, -0.02);
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
  makeQuad(ext, tex, y) {
    const w = ext.maxX - ext.minX, h = ext.maxZ - ext.minZ;
    const geo = new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2).translate((ext.minX + ext.maxX) / 2, y, (ext.minZ + ext.maxZ) / 2);
    // PlaneGeometry UV v=1 is at -z after rotation, i.e. north edge = top of the image. Matches.
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
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
        entry.mesh = this.makeQuad(t, tex, 0);
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

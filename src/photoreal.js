// Photorealistic mode: streams Google Photorealistic 3D Tiles (via a Cesium ion token) around the
// player. OSM data stays underneath as the invisible physics/traffic/HUD layer; this module also
// answers "how high is the real ground here?" by raycasting the streamed mesh.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const GOOGLE_PHOTOREAL_ASSET = 2275207; // Cesium ion's proxy for Google Photorealistic 3D Tiles
const DEG = Math.PI / 180;
const DOWN = new THREE.Vector3(0, -1, 0);

export class Photoreal {
  constructor({ token, origin, camera, renderer, scene, onError }) {
    this.camera = camera;
    this.renderer = renderer;
    this.failed = false;
    this.error = '';
    this.onError = onError;
    this.loadedModels = 0;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: GOOGLE_PHOTOREAL_ASSET, autoRefreshToken: true }));
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    // Put the map origin (bbox center) at (0,0,0) with +Y up, so OSM x/z line up with the mesh.
    tiles.registerPlugin(new ReorientationPlugin({ lat: origin.lat * DEG, lon: origin.lon * DEG, height: 0, recenter: true }));
    tiles.registerPlugin(new TilesFadePlugin());
    tiles.lruCache.minSize = 900;
    tiles.lruCache.maxSize = 1600;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);

    tiles.addEventListener('load-model', ({ scene: model }) => {
      this.loadedModels++;
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundsTree();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.toneMapped = false; // keep the photo colors as captured
          m.fog = true;
        }
      });
    });
    tiles.addEventListener('dispose-model', ({ scene: model }) => {
      model.traverse((o) => { if (o.isMesh) o.geometry.disposeBoundsTree?.(); });
    });
    tiles.addEventListener('load-error', ({ error, url }) => {
      // Only a failed root (auth / quota / blocked network) means photoreal is unavailable.
      if (!this.rootLoaded) {
        this.failed = true;
        this.error = error?.message || String(error);
        console.warn('[photoreal] root load failed', url, this.error);
        this.onError?.(this.error);
      }
    });
    tiles.addEventListener('load-root-tileset', () => { this.rootLoaded = true; });

    // Parent group lets us shift the whole mesh vertically so the ground near spawn sits at y≈0.
    this.root = new THREE.Group();
    // ReorientationPlugin puts east at -X and north at +Z; our OSM frame is east = +X, north = -Z.
    // A half turn about Y lines the two up (measured: spawn lands within ~1 m of its OSM position).
    this.root.rotation.y = Math.PI;
    this.root.add(tiles.group);
    scene.add(this.root);
    this.tiles = tiles;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this._v = new THREE.Vector3();
    this.leveled = false;
    this.visible = true;
  }

  setVisible(v) {
    this.visible = v;
    this.root.visible = v;
  }

  update() {
    if (this.failed) return;
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
    this.camera.updateMatrixWorld();
    this.tiles.update();
  }

  // Ground height under (x,z): casts down from fromY and returns the first surface hit, or null.
  groundAt(x, z, fromY, maxDrop = 400) {
    if (this.failed || !this.rootLoaded) return null;
    const rc = this.raycaster;
    rc.firstHitOnly = true;
    rc.set(this._v.set(x, fromY, z), DOWN);
    rc.far = maxDrop;
    const hit = rc.intersectObject(this.tiles.group, true)[0];
    return hit ? hit.point.y : null;
  }

  // All surface heights under (x,z), top to bottom (used to tell a bridge deck from the road below).
  groundsAt(x, z, fromY = 900, maxDrop = 2000) {
    if (this.failed || !this.rootLoaded) return [];
    const rc = this.raycaster;
    rc.firstHitOnly = false;
    rc.set(this._v.set(x, fromY, z), DOWN);
    rc.far = maxDrop;
    const hits = rc.intersectObject(this.tiles.group, true);
    rc.firstHitOnly = true;
    const ys = [];
    for (const h of hits) if (!ys.length || ys[ys.length - 1] - h.point.y > 0.5) ys.push(h.point.y);
    return ys;
  }

  // Once tiles under the spawn exist, shift the mesh so that ground is at y=0 there.
  levelAt(x, z) {
    if (this.leveled) return true;
    const ys = this.groundsAt(x, z);
    if (!ys.length) return false;
    const ground = ys[ys.length - 1];
    this.root.position.y -= ground;
    this.root.updateMatrixWorld(true);
    this.leveled = true;
    console.log(`[photoreal] leveled: ground at spawn was ${ground.toFixed(1)} m in tile space`);
    return true;
  }

  attributions() {
    const out = [];
    try { this.tiles.getAttributions(out); } catch { /* not ready */ }
    return out;
  }

  get stats() {
    const t = this.tiles;
    return { loadedModels: this.loadedModels, visible: t.visibleTiles?.size ?? 0, active: t.activeTiles?.size ?? 0, downloading: t.stats?.downloading ?? 0, parsing: t.stats?.parsing ?? 0, failed: this.failed, error: this.error, rootLoaded: !!this.rootLoaded, leveled: this.leveled };
  }

  dispose() {
    this.tiles.dispose();
    this.root.removeFromParent();
  }
}

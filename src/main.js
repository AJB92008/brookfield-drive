import * as THREE from 'three';
import { RoadIndex, BuildingIndex } from './spatial.js';
import { buildWorld } from './world.js';
import { PlayerCar, tuneSummary } from './sc430.js';
import { Traffic } from './traffic.js';
import { Police } from './police.js';
import { CrashSystem } from './crash.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { AerialGround } from './aerial.js';
import { loadTerrain, T } from './terrain.js';

const CESIUM_TOKEN = (import.meta.env.VITE_CESIUM_TOKEN || '').trim();

const loadingEl = document.getElementById('loading');
const statusEl = loadingEl.querySelector('.status');
const fillEl = loadingEl.querySelector('.fill');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
let step = 0;
const STEPS = 10;
async function status(text) {
  statusEl.textContent = text;
  fillEl.style.width = `${Math.round((++step / STEPS) * 100)}%`;
  console.log(`[brookfield] ${text}`);
  await nextFrame();
}

async function main(saved = {}) {
  await status('Downloading Brookfield map data…');
  const res = await fetch(`${import.meta.env.BASE_URL}data/brookfield.json`);
  if (!res.ok) throw new Error(`Map data missing (HTTP ${res.status}). Run: npm run fetch-map && npm run build-map`);
  const map = await res.json();

  // real elevation (USGS 3DEP); everything below is built on top of it
  try {
    const t = await loadTerrain(map, import.meta.env.BASE_URL);
    if (t) console.log(`[brookfield] terrain loaded: ${map.terrain.cols}x${map.terrain.rows} @ ${map.terrain.step} m`);
  } catch (err) {
    console.warn('[brookfield] terrain unavailable, world is flat', err?.message || err);
  }

  await status('Indexing roads & buildings…');
  const roads = new RoadIndex(map);
  const buildings = new BuildingIndex(map);

  // renderer / scene
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, reversedDepthBuffer: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }); // reversed-Z when supported (keeps early depth test), log depth as fallback
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const SKY = 0xa9c9e8;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 300, 1500);
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 1650);

  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5b6a48, 1.35));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.7);
  const sunDir = new THREE.Vector3(-0.5, 0.78, 0.38).normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const SH = 120;
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 10, far: 900 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const world = await buildWorld(map, roads, buildings, scene, status);
  console.log('[brookfield] world stats ' + JSON.stringify(world.stats));

  // Real aerial photos as the ground (classic mode). The photo already shows lawns, parking lots and
  // driveways, so the flat area polygons and parking-aisle/driveway ribbons are hidden once it loads.
  let aerial = null;
  try {
    aerial = new AerialGround({ group: world.group, renderer });
    await aerial.load();
    for (const m of world.group.children) if (m.name === 'areas' || m.name === 'roads-minor') m.visible = false;
    roads.minorAsGround = true; // driveways/parking aisles aren't drawn, so the car drives on the ground there
    const ground = world.group.getObjectByName('ground');

    document.getElementById('imagery-credit').hidden = false;
  } catch (err) {
    console.warn('[brookfield] aerial imagery unavailable, using drawn ground', err?.message || err);
    aerial = null;
  }

  await status('Starting traffic…');
  const traffic = new Traffic(map, scene, { maxCars: 150, roads, buildings });
  console.log(`[brookfield] traffic graph: ${traffic.edges.length} directed edges, ${traffic.signalEdges} signal approaches, ${traffic.stopEdges} stop-sign approaches`);

  const player = new PlayerCar(scene, renderer);
  const env = { roads, buildings, trees: world.treePoints, traffic, bounds: map.bounds };

  // Put the car on the nearest real road to (x,z), in the right-hand lane, facing `prefer` if two-way.
  function placeOnRoad(x, z, preferHeading, maxDist = 400) {
    const ok = (r) => r.t !== 'service';
    const near = roads.nearest(x, z, maxDist, ok) || roads.nearest(x, z, maxDist * 3);
    if (!near) return false;
    const r = map.roads[near.road];
    let dx = near.dirX, dz = near.dirZ;
    if (!r.o && preferHeading !== undefined && dx * Math.sin(preferHeading) + dz * Math.cos(preferHeading) < 0) { dx = -dx; dz = -dz; }
    const off = r.o ? 0 : r.w / 4;
    player.place(near.px - dz * off, near.pz + dx * off, Math.atan2(dx, dz));
    return true;
  }

  const sp = map.spawn;
  const sr = map.roads[sp.road];
  // shift into the right lane of the spawn road (one-way carriageway: right-most lane)
  const fx = Math.sin(sp.heading), fz = Math.cos(sp.heading);
  const laneOff = sr && sr.o ? Math.max(0, sr.w / 2 - 2.2) : (sr ? sr.w / 4 : 0);
  player.place(sp.x - fz * laneOff, sp.z + fx * laneOff, sp.heading);

  // Restore position after a live update of the hosted page.
  if (Number.isFinite(saved.x) && Number.isFinite(saved.z)) player.place(saved.x, saved.z, saved.heading || 0);

  const hud = new Hud(map, roads);
  const police = new Police({ traffic, hud, roads, map });
  // crashes: sparks / debris / smoke, damage, breakaway poles
  const crash = new CrashSystem({ scene, player, furniture: world.furniture, ground: null, hud });
  env.crash = crash;
  env.poles = crash.poles;
  env.onFlipped = () => hud.toast(`Your car is on its ${Math.abs(player.roll) > 2.3 ? 'roof' : 'side'}. Press R to flip it back over (and fix it).`, 6000);
  hud.onTeleport = (x, z) => { placeOnRoad(x, z, player.heading); afterMove(); };

  // ---------- photoreal (Google 3D Tiles via Cesium ion) vs classic (built from OSM) ----------
  let mode = 'classic';
  let photo = null;
  const onBridge = (x, z) => { const ri = roads.roadAt(x, z); return ri !== null && !!map.roads[ri].b; };
  // Surface just below y (follows ramps/bridges continuously); recovers if we ended up under the mesh.
  const groundFn = (x, z, y) => {
    if (!photo?.leveled) return null;
    const g = photo.groundAt(x, z, y + 1.6, 40);
    if (g !== null) return g;
    const ys = photo.groundsAt(x, z);
    if (!ys.length) return null;
    let best = ys[0];
    for (const h of ys) if (Math.abs(h - y) < Math.abs(best - y)) best = h;
    return best;
  };
  // Fresh placement: lowest surface (the road, not a tree or overpass above it) unless on a bridge.
  const groundInitFn = (x, z, bridge) => {
    if (!photo?.leveled) return null;
    const ys = photo.groundsAt(x, z);
    if (!ys.length) return null;
    const low = ys[ys.length - 1];
    if (!bridge) return low;
    for (const h of ys) if (h <= low + 14) return h; // highest deck within a sane height of the ground
    return low;
  };
  // Classic mode: real terrain (+ bridge decks) from the elevation grid; cheap enough to query freely.
  const classicGround = (x, z, y) => roads.surfaceHeight(x, z, y);
  const classicInit = (x, z, bridge) => roads.surfaceHeight(x, z, bridge ? 1e9 : T(x, z) + 0.5);
  function useClassicGround() {
    env.ground = map.terrain ? classicGround : null;
    crash?.setGround(env.ground);
    traffic.setGround(map.terrain ? classicGround : null, map.terrain ? classicInit : null, { cheap: true, blobs: false });
    player.groundPending = false;
    player.y = map.terrain ? classicInit(player.x, player.z, onBridge(player.x, player.z)) : 0;
    player.vy = 0;
    player.sync();
  }
  useClassicGround(); // default until/unless photoreal mode takes over
  const photoActive = () => mode === 'photo';
  let groundPendingSince = 0;
  function afterMove() {
    traffic.clear();
    traffic._seeded = false;
    police.reset();
    if (mode === 'photo') { player.groundPending = true; groundPendingSince = performance.now(); } else useClassicGround();
    snapCamera();
  }
  function applyMode(m) {
    if (m === 'photo' && (!photo || photo.failed)) {
      hud.toast(photo?.failed ? `Photoreal city unavailable (${photo.error.slice(0, 80)})` : 'Photoreal mode needs the hosted GitHub Pages version.');
      m = 'classic';
    }
    mode = m;
    try { localStorage.setItem('brookfield-drive-mode', m); } catch { /* storage unavailable */ }
    const on = m === 'photo';
    world.group.visible = !on;
    photo?.setVisible(on);
    sun.castShadow = !on;
    player.blob.visible = on;
    scene.fog.near = on ? 700 : 300;
    scene.fog.far = on ? 3400 : 1500;
    camera.far = on ? 4500 : 1650;
    camera.updateProjectionMatrix();
    env.trees = on ? null : world.treePoints;
    env.poles = on ? null : crash.poles; // the classic street furniture isn't there in the 3D city
    if (on) {
      env.ground = groundFn;
      crash.setGround(groundFn);
      traffic.setGround(groundFn, groundInitFn);
      player.groundPending = true; groundPendingSince = performance.now();
    } else useClassicGround();
    hud.setPhotoMode(on);
    document.getElementById('imagery-credit').hidden = on || !aerial;
    console.log(`[brookfield] mode: ${m}`);
  }

  // camera rig
  const CAM_MODES = ['chase', 'far', 'hood', 'top', 'orbit'];
  let camMode = Number.isInteger(saved.cam) ? saved.cam % CAM_MODES.length : 0;
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();
  let shake = 0;
  function camTarget(out) {
    const ch = player.camHeading ?? player.heading;
    const fx = Math.sin(ch), fz = Math.cos(ch);
    const v = Math.abs(player.speed);
    switch (CAM_MODES[camMode]) {
      case 'far': return out.set(player.x - fx * 16, player.y + 7.5, player.z - fz * 16);
      case 'hood': return out.set(player.x + fx * 0.15, player.y + 1.12, player.z + fz * 0.15); // driver's eye; car body hidden
      case 'top': return out.set(player.x + 0.01, player.y + 140, player.z + 0.01);
      case 'orbit': { const a = performance.now() / 5000; return out.set(player.x + Math.sin(a) * 6.5, player.y + 1.6, player.z + Math.cos(a) * 6.5); }
      default: { const d = 7.8 + v * 0.05; return out.set(player.x - fx * d, player.y + 2.9 + v * 0.012, player.z - fz * d); }
    }
  }
  function snapCamera() { camTarget(camPos); camera.position.copy(camPos); }
  snapCamera();
  const tmp = new THREE.Vector3();
  function updateCamera(dt) {
    {
      const spinning = Math.abs(player.spin || 0) > 0.8 || Math.abs(player.roll || 0) > 0.45;
      const target = spinning && player.groundSpeed > 3 ? Math.atan2(player.vx, player.vz) : player.heading;
      const d = Math.atan2(Math.sin(target - (player.camHeading ?? target)), Math.cos(target - (player.camHeading ?? target)));
      player.camHeading = (player.camHeading ?? target) + d * Math.min(1, dt * (spinning ? 2.2 : 9));
    }
    camTarget(tmp);
    if (env.ground && CAM_MODES[camMode] !== 'top') {
      const gy = photoActive() ? (photo?.leveled ? photo.groundAt(tmp.x, tmp.z, player.y + 6, 60) : null) : T(tmp.x, tmp.z);
      if (gy !== null && tmp.y < gy + 1.2) tmp.y = gy + 1.2;
    }
    const mode = CAM_MODES[camMode];
    player.group.visible = mode !== 'hood'; // otherwise the cabin/glass boxes block the view
    const k = mode === 'hood' || mode === 'orbit' ? 1 : 1 - Math.exp(-dt * (mode === 'top' ? 4 : 6));
    camPos.lerp(tmp, k);
    camera.position.copy(camPos);
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      shake = Math.max(0, shake - dt * 2.5);
    }
    const hd = mode === 'hood' || mode === 'top' ? player.heading : player.camHeading ?? player.heading;
    const fx = Math.sin(hd), fz = Math.cos(hd);
    if (mode === 'top') {
      camera.up.set(fx, 0, fz);
      look.set(player.x, player.y, player.z);
    } else if (mode === 'orbit') {
      camera.up.set(0, 1, 0);
      look.set(player.x, player.y + 0.7, player.z);
    } else {
      camera.up.set(0, 1, 0);
      const ahead = mode === 'hood' ? 30 : 5;
      look.set(player.x + fx * ahead, player.y + (mode === 'hood' ? 1.2 : 1.3), player.z + fz * ahead);
    }
    camera.lookAt(look);
    const fov = 62 + Math.min(16, Math.abs(player.speed) * 0.28);
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  }

  // shadow camera follows the player, snapped to texels to avoid shimmering
  const texel = (SH * 2) / 2048;
  function updateSun() {
    const cx = Math.round(player.x / texel) * texel, cz = Math.round(player.z / texel) * texel;
    sun.target.position.set(cx, player.y, cz);
    sun.position.set(cx + sunDir.x * 400, player.y + sunDir.y * 400, cz + sunDir.z * 400);
  }

  const input = new Input();
  const helpEl = document.getElementById('help');
  input.on('KeyC', () => { camMode = (camMode + 1) % CAM_MODES.length; });
  input.on('KeyV', () => { camMode = CAM_MODES.indexOf('orbit'); }); // showcase view of the car
  input.on('KeyM', () => hud.toggleBig());
  input.on('Escape', () => hud.toggleBig(false));
  input.on('KeyR', () => { placeOnRoad(player.x, player.z, player.heading); crash.repair(); afterMove(); });
  input.on('KeyP', () => applyMode(mode === 'photo' ? 'classic' : 'photo'));
  input.on('KeyT', () => { traffic.enabled = !traffic.enabled; if (!traffic.enabled) { traffic.clear(); police.reset(); } traffic._seeded = false; });
  input.on('KeyH', () => helpEl.classList.toggle('hidden'));
  input.on('KeyI', () => { const el = document.getElementById('spec'); el.hidden = !el.hidden; });
  // Stock (the real car) vs Sport tune; remembered between visits
  function applyTune(name) {
    player.setTune(name);
    try { localStorage.setItem('brookfield-drive-tune', player.tuneName); } catch { /* storage unavailable */ }
    const t = player.tune, sum = tuneSummary(t);
    document.getElementById('tune-name').textContent = t.label;
    document.querySelector('#speedo .redline').style.left = `${(t.shiftRpm / 7000) * 100}%`;
    document.getElementById('spec-tune').innerHTML = `<b>Driving now: ${t.label}</b> — ${sum.hp} hp, ${sum.lbft} lb-ft, limiter ${sum.limiter}, turning circle ${sum.turningFt} ft${player.tuneName === 'stock' ? ' (real car)' : ''}`;
  }
  let savedTune = null;
  try { savedTune = localStorage.getItem('brookfield-drive-tune'); } catch { /* storage unavailable */ }
  applyTune(savedTune || 'sport');
  input.on('KeyK', () => { applyTune(player.tuneName === 'sport' ? 'stock' : 'sport'); hud.toast(`${player.tune.label}: ${tuneSummary(player.tune).hp} hp`, 2500); });
  setTimeout(() => helpEl.classList.add('hidden'), 20000);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  // Keyboard input only reaches an embedded page after it's clicked.
  const hint = document.getElementById('focus-hint');
  const updateHint = () => { hint.hidden = document.hasFocus(); };
  addEventListener('focus', updateHint);
  addEventListener('blur', updateHint);
  addEventListener('pointerdown', () => { window.focus(); setTimeout(updateHint, 0); });
  setInterval(updateHint, 1000);

  window.claude?.hot?.snapshot?.(() => ({ x: player.x, z: player.z, heading: player.heading, cam: camMode }));

  if (CESIUM_TOKEN) {
    await status('Connecting to Google 3D city…');
    try {
      const { Photoreal } = await import('./photoreal.js');
      photo = new Photoreal({
        token: CESIUM_TOKEN, origin: map.origin, camera, renderer, scene,
        onError: () => { if (mode === 'photo') applyMode('classic'); },
      });
      let saved = null;
      try { saved = localStorage.getItem('brookfield-drive-mode'); } catch { /* storage unavailable */ }
      applyMode(saved === 'classic' ? 'classic' : 'photo'); // remembers your last choice (P)
    } catch (err) {
      console.warn('[brookfield] photoreal init failed', err);
    }
  }

  let last = performance.now();
  let physAcc = 0;
  const PHYS_DT = 1 / 120; // fixed physics step: the car moves in real time even if frames are slow
  let fpsAcc = 0, fpsFrames = 0;
  const stats = { fps: 0 };
  let attrTimer = 0;
  let lodTimer = 0;
  function frame(now) {
    const realDt = Math.min(0.25, (now - last) / 1000); // cap only for long stalls (tab switches)
    const dt = Math.min(0.05, realDt); // for camera/HUD smoothing
    last = now;
    input.poll();
    if (photo && mode === 'photo') {
      photo.update();
      // Calibrate "ground = y 0" once the detailed tiles have finished streaming (coarse tiles are tens of m off).
      if (!photo.leveled && photo.rootLoaded) {
        photo.firstRootAt ||= performance.now();
        const busy = (photo.tiles.stats?.downloading || 0) + (photo.tiles.stats?.parsing || 0) > 0;
        if (!busy || performance.now() - photo.firstRootAt > 10000) photo.levelAt(player.x, player.z);
      }
      if (player.groundPending && photo.leveled) {
        const busy = (photo.tiles.stats?.downloading || 0) + (photo.tiles.stats?.parsing || 0) > 0;
        const waited = performance.now() - groundPendingSince;
        if (!busy || waited > 8000) {
          const h = groundInitFn(player.x, player.z, onBridge(player.x, player.z));
          if (h !== null) { player.y = h; player.vy = 0; player.groundPending = false; snapCamera(); }
        }
      }
    }
    const frozen = mode === 'photo' && player.groundPending;
    hud.setLoading(frozen ? 'Loading the 3D city around you…' : '');
    if (!frozen) {
      physAcc += realDt;
      let impact = 0;
      while (physAcc >= PHYS_DT) {
        player.update(PHYS_DT, input, env);
        impact = Math.max(impact, player.impact);
        physAcc -= PHYS_DT;
      }
      player.updateVertical(realDt, env);
      if (impact > 4) shake = Math.min(1.2, impact * 0.08);
      traffic.update(realDt, player, now / 1000);
      police.update(realDt, player);
      crash.update(realDt, camera, renderer);
    }
    if (mode === 'classic') {
      if (aerial) aerial.update(player.x, player.z);
      lodTimer -= dt;
      if (lodTimer <= 0) { lodTimer = 0.5; world.updateLod(player.x, player.z); }
      world.furniture?.updateSignals(now / 1000);
    }
    updateCamera(dt);
    updateSun();
    hud.update(dt, player, traffic);
    attrTimer -= dt;
    if (attrTimer <= 0) { attrTimer = 1; hud.setPhotoAttributions(mode === 'photo' && photo ? photo.attributions() : null); }
    renderer.render(scene, camera);
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 1) { stats.fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // In photoreal mode keep the loading screen up until the ground under the car has streamed in.
  if (mode === 'photo') {
    await status('Streaming Google 3D Brookfield…');
    const t0 = performance.now();
    while (mode === 'photo' && player.groundPending && performance.now() - t0 < 30000) {
      statusEl.textContent = `Streaming Google 3D Brookfield… (${photo.loadedModels} tiles)`;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (mode === 'photo' && player.groundPending) {
      applyMode('classic');
      hud.toast('The 3D city is taking too long to load, so this is classic Brookfield. Press P to try again.');
    }
  }
  step = STEPS - 1;
  await status('Ready!');
  document.getElementById('hud').hidden = false;
  loadingEl.classList.add('done');
  updateHint();

  // handle for debugging / automated checks
  window.__game = { THREE, map, get aerial() { return aerial; }, roads, buildings, world, traffic, police, crash, env, player, renderer, scene, camera, hud, input, stats, placeOnRoad, afterMove, applyMode, get mode() { return mode; }, get photo() { return photo; }, setCam: (i) => { camMode = i; } };
}

function boot(saved) {
  main(saved || {}).catch((err) => {
    console.error(err);
    loadingEl.classList.add('error');
    statusEl.textContent = `Something went wrong: ${err.message}`;
  });
}
const hot = window.claude?.hot;
if (hot?.ready) hot.ready(boot);
else boot(hot?.data ?? {});

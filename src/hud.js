// HUD: speedometer, street-name sign, place name, rotating minimap, full map with click-to-teleport.
import { pointInRing } from './spatial.js';

const MPP = 4; // meters per pixel of the pre-rendered map

const ROAD_STYLE = {
  motorway: ['#f2914a', 1.6], motorway_link: ['#f2914a', 1.2], trunk: ['#f2a65a', 1.5], trunk_link: ['#f2a65a', 1.1],
  primary: ['#f4cf5d', 1.5], primary_link: ['#f4cf5d', 1.1], secondary: ['#f4dd8a', 1.4], secondary_link: ['#f4dd8a', 1.1],
  tertiary: ['#e9edf0', 1.3], tertiary_link: ['#e9edf0', 1.1], unclassified: ['#cfd5da', 1.1], residential: ['#cfd5da', 1.1],
  living_street: ['#cfd5da', 1], road: ['#cfd5da', 1], service: ['#7d878f', 0.9],
};
const ROAD_ORDER = ['service', 'living_street', 'road', 'residential', 'unclassified', 'tertiary_link', 'tertiary', 'secondary_link', 'secondary', 'primary_link', 'primary', 'trunk_link', 'trunk', 'motorway_link', 'motorway'];
const AREA_FILL = { water: '#2c5a85', park: '#2f5133', golf: '#34593a', reserve: '#2f5133', pitch: '#35603a', forest: '#26432b', wetland: '#2c4a3a', farm: '#3b4630', parking: '#30363b' };

export function roadLabel(r) {
  if (!r) return '';
  if (r.n) return r.n;
  if (r.r) return r.r;
  if (r.t.endsWith('_link')) return 'Ramp';
  if (r.t === 'service') return r.sv === 'parking_aisle' ? 'Parking lot' : r.sv === 'driveway' ? 'Driveway' : 'Service road';
  return 'Unnamed road';
}

export class Hud {
  constructor(map, roadIndex) {
    this.map = map;
    this.roadIndex = roadIndex;
    this.$ = (id) => document.getElementById(id);
    this.speedEl = this.$('speed');
    this.speedBar = this.$('speed-bar');
    this.streetEl = this.$('street');
    this.refEl = this.$('street-ref');
    this.placeEl = this.$('place');
    this.trafficEl = this.$('traffic-count');
    this.mini = this.$('minimap');
    this.miniCtx = this.mini.getContext('2d');
    this.bigWrap = this.$('bigmap');
    this.big = this.$('bigmap-canvas');
    this.bigCtx = this.big.getContext('2d');
    this.lastStreet = null;
    this.placeTimer = 0;
    this.streetTimer = 0;
    this.renderBaseMap();
    this.resizeMini();
    addEventListener('resize', () => { this.resizeMini(); if (this.bigOpen) this.drawBig(); });
    this.bigOpen = false;
    this.onTeleport = null;
    this.big.addEventListener('click', (e) => {
      const rect = this.big.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
      const b = this.map.bounds;
      const x = b.minX + fx * (b.maxX - b.minX), z = b.minZ + fy * (b.maxZ - b.minZ);
      this.onTeleport?.(x, z);
      this.toggleBig(false);
    });
  }

  // ---------- photoreal-mode bits ----------
  setPhotoMode(on) {
    this.$('photo-attr').hidden = !on;
    this.$('cesium-credit').hidden = !on;
  }

  // Attributions from the 3D tiles: Google requires its logo plus the live data credits on screen.
  setPhotoAttributions(list) {
    const el = this.$('photo-copy');
    if (!list) { el.textContent = ''; return; }
    const parts = [];
    for (const a of list) {
      if (a.type === 'string' && a.value) parts.push(a.value);
      else if (a.type === 'html' && a.value) {
        // keep only the text of html credits (never inject third-party markup)
        const doc = new DOMParser().parseFromString(a.value, 'text/html');
        const t = doc.body.textContent.trim();
        if (t) parts.push(t);
      }
    }
    const text = parts.join(' · ');
    if (text !== this._attrText) { this._attrText = text; el.textContent = text; el.title = text; }
  }

  toast(msg, ms = 6000) {
    const el = this.$('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.hidden = true; }, ms);
  }

  setLoading(msg) {
    const el = this.$('loading-chip');
    if ((msg || '') === (this._loadingMsg || '')) return;
    this._loadingMsg = msg;
    el.textContent = msg;
    el.hidden = !msg;
  }

  renderBaseMap() {
    const b = this.map.bounds;
    const W = Math.ceil((b.maxX - b.minX) / MPP), H = Math.ceil((b.maxZ - b.minZ) / MPP);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const X = (x) => (x - b.minX) / MPP, Z = (z) => (z - b.minZ) / MPP;
    ctx.fillStyle = '#1e2a22';
    ctx.fillRect(0, 0, W, H);
    const poly = (p) => {
      ctx.beginPath();
      ctx.moveTo(X(p[0]), Z(p[1]));
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(X(p[i]), Z(p[i + 1]));
      ctx.closePath();
    };
    for (const a of this.map.areas) {
      ctx.fillStyle = AREA_FILL[a.k] || AREA_FILL.park;
      poly(a.p);
      ctx.fill();
    }
    ctx.fillStyle = '#4a5157';
    for (const bl of this.map.buildings) { poly(bl.p); ctx.fill(); }
    // rails
    ctx.strokeStyle = '#6e6259';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 2]);
    for (const nd of this.map.rails) {
      ctx.beginPath();
      nd.forEach((n, i) => { const x = X(this.map.nodes[n * 2]), z = Z(this.map.nodes[n * 2 + 1]); i ? ctx.lineTo(x, z) : ctx.moveTo(x, z); });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const byType = new Map();
    for (const r of this.map.roads) {
      if (!byType.has(r.t)) byType.set(r.t, []);
      byType.get(r.t).push(r);
    }
    for (const t of ROAD_ORDER) {
      const list = byType.get(t);
      if (!list) continue;
      const [color, mult] = ROAD_STYLE[t] || ['#cfd5da', 1];
      ctx.strokeStyle = color;
      for (const r of list) {
        ctx.lineWidth = Math.max(1, (r.w / MPP) * mult);
        ctx.beginPath();
        r.nd.forEach((n, i) => { const x = X(this.map.nodes[n * 2]), z = Z(this.map.nodes[n * 2 + 1]); i ? ctx.lineTo(x, z) : ctx.moveTo(x, z); });
        ctx.stroke();
      }
    }
    // City of Brookfield limits
    const city = this.map.places.find((p) => p.city);
    if (city) {
      ctx.strokeStyle = 'rgba(160, 190, 255, 0.75)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([10, 6]);
      for (const ring of city.rings) { poly(ring); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    this.base = c;
  }

  resizeMini() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = this.mini.clientWidth || 210;
    this.mini.width = this.mini.height = Math.round(size * dpr);
    this.miniDpr = dpr;
  }

  placeAt(x, z) {
    for (const p of this.map.places) {
      if (!p.rings.some((r) => pointInRing(x, z, r))) continue;
      if (p.holes.some((h) => pointInRing(x, z, h))) continue;
      return p.n;
    }
    return '';
  }

  update(dt, player, traffic) {
    // true speed over the ground (m/s -> mph), including any sideways slide
    const mph = (player.groundSpeed ?? Math.abs(player.speed)) * 2.23694;
    this.speedEl.textContent = Math.round(mph);
    this.speedBar.style.width = `${Math.min(100, (mph / 155) * 100)}%`;
    this.$('gear').textContent = player.gearLabel ?? 'D';
    if (player.rpm !== undefined) {
      this.$('rpm-bar').style.width = `${Math.min(100, (player.rpm / 7000) * 100)}%`;
      this.$('rpm').textContent = Math.round(player.rpm / 50) * 50;
    }

    this.streetTimer -= dt;
    if (this.streetTimer <= 0) {
      this.streetTimer = 0.25;
      // Prefer the road whose surface we're actually on; fall back to the closest centerline nearby.
      const on = this.roadIndex.roadAt(player.x, player.z);
      const near = on === null ? this.roadIndex.nearest(player.x, player.z, 25) : null;
      const r = on !== null ? this.map.roads[on] : near ? this.map.roads[near.road] : null;
      const label = r ? roadLabel(r) : 'Off road';
      const ref = r && r.n && r.r ? r.r : '';
      const key = label + '|' + ref;
      if (key !== this.lastStreet) {
        this.lastStreet = key;
        this.streetEl.textContent = label;
        this.refEl.textContent = ref;
        this.refEl.style.display = ref ? '' : 'none';
        this.refEl.className = /^I-/.test(ref) ? 'shield interstate' : /^US /.test(ref) ? 'shield us' : /^(WIS|STH) /.test(ref) ? 'shield state' : 'shield county';
        this.$('street-sign').classList.toggle('off', !r);
      }
    }
    this.placeTimer -= dt;
    if (this.placeTimer <= 0) {
      this.placeTimer = 0.6;
      const p = this.placeAt(player.x, player.z);
      if (p !== this.lastPlace) {
        this.lastPlace = p;
        this.placeEl.textContent = p ? `${p}, Wisconsin` : 'Wisconsin';
      }
      this.trafficEl.textContent = traffic?.enabled ? `${traffic.count} cars nearby` : 'traffic off';
    }
    this.drawMini(player, traffic);
    if (this.bigOpen) this.drawBigMarker(player);
  }

  drawMini(player, traffic) {
    const ctx = this.miniCtx, S = this.mini.width, c = S / 2;
    const b = this.map.bounds;
    const radiusM = 260 + Math.min(260, Math.abs(player.speed) * 6);
    const k = (c / radiusM) * MPP; // screen px per base-map px
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1e2a22';
    ctx.fillRect(0, 0, S, S);
    ctx.translate(c, c);
    ctx.rotate(player.heading - Math.PI);
    ctx.scale(k, k);
    const px = (player.x - b.minX) / MPP, pz = (player.z - b.minZ) / MPP;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, -px, -pz);
    if (traffic?.enabled) {
      ctx.fillStyle = '#7fd3ff';
      const dotR = 2.2 / k * this.miniDpr;
      for (const car of traffic.cars) {
        const dx = (car.x - player.x) / MPP, dz = (car.z - player.z) / MPP;
        if (Math.abs(dx) > radiusM / MPP || Math.abs(dz) > radiusM / MPP) continue;
        ctx.beginPath();
        ctx.arc(dx, dz, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    // player arrow
    const a = 9 * this.miniDpr;
    ctx.save();
    ctx.translate(c, c);
    ctx.fillStyle = '#ff4a4a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * this.miniDpr;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.7, a * 0.8);
    ctx.lineTo(0, a * 0.4);
    ctx.lineTo(-a * 0.7, a * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // N marker on the rim
    const nAng = player.heading + Math.PI / 2; // screen direction of world north (-z) after the map rotation
    const nx = c + Math.cos(nAng) * (c - 13 * this.miniDpr), ny = c + Math.sin(nAng) * (c - 13 * this.miniDpr);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${12 * this.miniDpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);
  }

  toggleBig(force) {
    this.bigOpen = force ?? !this.bigOpen;
    this.bigWrap.classList.toggle('open', this.bigOpen);
    if (this.bigOpen) this.drawBig();
  }

  drawBig() {
    const b = this.map.bounds;
    const aspect = (b.maxX - b.minX) / (b.maxZ - b.minZ);
    const maxH = innerHeight * 0.86, maxW = innerWidth * 0.9;
    let h = maxH, w = h * aspect;
    if (w > maxW) { w = maxW; h = w / aspect; }
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.big.style.width = `${w}px`;
    this.big.style.height = `${h}px`;
    this.big.width = Math.round(w * dpr);
    this.big.height = Math.round(h * dpr);
    this.bigScale = this.big.width / this.base.width;
  }

  drawBigMarker(player) {
    const ctx = this.bigCtx, b = this.map.bounds;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, this.big.width, this.big.height);
    const x = ((player.x - b.minX) / (b.maxX - b.minX)) * this.big.width;
    const y = ((player.z - b.minZ) / (b.maxZ - b.minZ)) * this.big.height;
    const a = 11 * (this.big.width / parseFloat(this.big.style.width));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - player.heading);
    ctx.fillStyle = '#ff4a4a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -a); ctx.lineTo(a * 0.7, a * 0.8); ctx.lineTo(0, a * 0.4); ctx.lineTo(-a * 0.7, a * 0.8);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

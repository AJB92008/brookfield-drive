// Repair shops: the real auto repair and tire shops on the map, plus the Lexus and Toyota dealers'
// service departments. Pull into the green ring at one and stop, and the car gets fixed. R only puts
// the car back on the road; a car that can't drive (dead engine, broken driveline, two wheels gone)
// can be towed to the nearest shop with F.
import * as THREE from 'three';

const KINDS = new Set(['shop:car_repair', 'shop:tyres']);
const DEALERS = new Set(['Lexus of Brookfield', 'Toyota of Brookfield']);
const RING = 7.5;
const COLOR = 0x3ddc84;
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

function signTexture(name) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  // round green badge with a white wrench
  g.fillStyle = '#3ddc84';
  g.beginPath(); g.arc(128, 58, 50, 0, Math.PI * 2); g.fill();
  g.lineWidth = 6; g.strokeStyle = '#0d3b22'; g.stroke();
  g.save();
  g.translate(128, 58); g.rotate(-Math.PI / 4);
  g.fillStyle = '#fff';
  g.fillRect(-7, -6, 14, 44); // handle
  g.beginPath(); g.arc(0, -16, 17, 0, Math.PI * 2); g.fill(); // head
  g.fillStyle = '#3ddc84';
  g.fillRect(-6, -38, 12, 20); // jaw opening
  g.restore();
  // name plate
  g.font = 'bold 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = Math.min(250, g.measureText(name).width + 20);
  g.fillStyle = 'rgba(12,16,20,0.85)';
  g.fillRect(128 - w / 2, 118, w, 36);
  g.fillStyle = '#fff';
  g.fillText(name, 128, 137, 240);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RepairShops {
  // place(x, z, heading): move the car there (fresh traffic); ground(x, z): ground height for the current look
  constructor({ map, roads, scene, player, hud, crash, ground, place, onTow }) {
    this.player = player;
    this.hud = hud;
    this.crash = crash;
    this.ground = ground;
    this.place = place;
    this.onTow = onTow;
    this.shops = [];
    const ok = (r) => r.t !== 'motorway' && r.t !== 'motorway_link' && !(r.t === 'service' && /driveway|emergency|drive-through/.test(r.sv || ''));
    for (const p of map.pois) {
      if (!KINDS.has(p.k) && !(p.k === 'shop:car' && DEALERS.has(p.n))) continue;
      const near = roads.nearest(p.x, p.z, 160, ok);
      if (!near) continue;
      this.shops.push({ name: p.n || 'Repair shop', x: near.px, z: near.pz, heading: Math.atan2(near.dirX, near.dirZ), gy: 0, groundT: 0 });
    }
    // markers: a ring on the ground and a wrench sign over it
    this.group = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(RING - 0.6, RING, 48).rotateX(-Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(RING - 0.6, 48).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
    const discMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false });
    this.ringMat = ringMat;
    for (const s of this.shops) {
      const m = new THREE.Group();
      const ring = new THREE.Mesh(ringGeo, ringMat), disc = new THREE.Mesh(discGeo, discMat);
      ring.renderOrder = disc.renderOrder = 3;
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: signTexture(s.name), transparent: true, depthWrite: false }));
      sign.scale.set(6.4, 4, 1);
      sign.position.y = 5.2;
      m.add(ring, disc, sign);
      s.marker = m;
      this.group.add(m);
    }
    scene.add(this.group);
    this.$bar = document.getElementById('repair-bar');
    this.$fade = document.getElementById('fade');
    this.at = null; // shop we're in
    this.progress = 0;
    this.nearT = 0;
    this.nearest = null;
    this.towing = false;
    hud.shops = this.shops;
  }

  nearestTo(x, z) {
    let best = null, bd = Infinity;
    for (const s of this.shops) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    return best && { shop: best, d: bd };
  }

  // short text for the damage panel
  hint() { return this.nearest ? `${this.nearest.shop.name}, ${fmtDist(this.nearest.d)}` : null; }

  tow() {
    const dmg = this.crash.damage;
    if (this.towing) return;
    const n = this.nearestTo(this.player.x, this.player.z);
    if (!n) return;
    if (!dmg.wrecked) {
      this.hud.toast(dmg.any ? `A tow is for a car that can't drive. You can make it: ${n.shop.name} is ${fmtDist(n.d)} away (wrench on the map).` : 'Your car is fine: no tow needed.', 4500);
      return;
    }
    this.towing = true;
    this.onTow?.();
    this.$fade.classList.add('on');
    setTimeout(() => {
      const s = n.shop;
      this.place(s.x, s.z, s.heading);
      this.hud.toast(`Towed ${fmtDist(n.d)} to ${s.name}. Hold still while they fix it.`, 4500);
      this.$fade.classList.remove('on');
      this.towing = false;
    }, 700);
  }

  update(dt) {
    const P = this.player, dmg = this.crash.damage;
    this.nearT -= dt;
    if (this.nearT <= 0) {
      this.nearT = 1;
      this.nearest = this.nearestTo(P.x, P.z);
      for (const s of this.shops) {
        // keep the markers on the ground (the 3D city loads in as you get close)
        const d = Math.hypot(s.x - P.x, s.z - P.z);
        s.marker.visible = d < 1200;
        if (d < 600 || !s.placed) {
          const gy = this.ground?.(s.x, s.z);
          if (Number.isFinite(gy)) { s.gy = gy; s.placed = true; }
          s.marker.position.set(s.x, s.gy + 0.06, s.z);
        }
      }
    }
    this.ringMat.opacity = 0.6 + 0.3 * Math.sin(performance.now() / 280);
    // in a ring, stopped: repair (longer for a worse wreck)
    const n = this.nearest;
    const inRing = n && Math.hypot(n.shop.x - P.x, n.shop.z - P.z) < RING;
    const slow = (P.groundSpeed ?? Math.abs(P.speed)) < 1.5;
    if (inRing && dmg.any && slow) {
      if (this.at !== n.shop) { this.at = n.shop; this.progress = 0; }
      const need = 2.5 + Math.min(6, dmg.total / 15);
      this.progress += dt / need;
      this.$bar.hidden = false;
      this.$bar.innerHTML = `<span>Repairing at <b>${n.shop.name}</b></span><i style="--p:${Math.round(Math.min(1, this.progress) * 100)}%"></i>`;
      if (this.progress >= 1) {
        this.crash.repair();
        this.hud.toast(`Fixed up at ${n.shop.name}. Good as new.`, 3500);
        this.$bar.hidden = true;
        this.at = null;
      }
    } else {
      if (inRing && dmg.any && !slow) { this.$bar.hidden = false; this.$bar.innerHTML = `<span>Stop here to repair at <b>${n.shop.name}</b></span>`; }
      else this.$bar.hidden = true;
      if (!inRing) this.at = null;
      this.progress = 0;
    }
  }
}

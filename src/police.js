// Police. Patrol cars drive around as part of traffic. Drive 15+ mph over the posted limit near one,
// crash into people near one, or hit one, and they come after you: lights on, routing through the
// streets toward you, chasing you down up close, everyone else pulling over to let them by.
// Stay more than ~320 m from every cruiser for 10 s to escape. Stop with one on your bumper: busted.
const TO_MPH = 2.23694;

export class Police {
  constructor({ traffic, hud, roads, map }) {
    this.traffic = traffic;
    this.hud = hud;
    this.roads = roads;
    this.map = map;
    this.wanted = false;
    this.reason = '';
    this.speedT = 0;
    this.escapeT = 0;
    this.bustT = 0;
    this.cool = 0;
    this.pursuitT = 0;
    this.spawnT = 0;
    this.limit = null;
    this.limitTimer = 0;
    this.el = document.getElementById('wanted');
    this.reasonEl = document.getElementById('wanted-reason');
    this.escapeEl = document.getElementById('wanted-escape');
    this.hintEl = document.getElementById('wanted-hint');
    this.limitEl = document.getElementById('limit-sign');
    this.limitNum = document.getElementById('limit-num');
  }

  limitAt(x, z) {
    const ri = this.roads.roadAt(x, z);
    if (ri === null || this.map.roads[ri].t === 'service') return null;
    return Math.round(this.traffic.limits.mph[ri]);
  }

  reset() {
    for (const c of this.traffic.cars) if (c.pursuit) this.traffic.endPursuit(c);
    this.wanted = false;
    this.speedT = this.escapeT = this.bustT = 0;
    this.cool = 3;
    this.render();
  }

  nearestCop(x, z, pred = () => true) {
    let best = null, bd = Infinity;
    for (const c of this.traffic.cars) {
      if (!c.police || !pred(c)) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) { bd = d; best = c; }
    }
    return { car: best, d: bd };
  }

  update(dt, player) {
    const t = this.traffic;
    this.limitTimer -= dt;
    if (this.limitTimer <= 0) {
      this.limitTimer = 0.3;
      this.limit = this.limitAt(player.x, player.z);
      this.limitEl.hidden = this.limit === null;
      if (this.limit !== null) this.limitNum.textContent = this.limit;
    }
    if (!t.enabled) {
      if (this.wanted) this.reset();
      t.events.length = 0;
      return;
    }
    const mph = (player.groundSpeed ?? Math.abs(player.speed)) * TO_MPH;
    this.cool -= dt;
    if (!this.wanted) {
      const over = this.limit !== null ? mph - this.limit : 0;
      this.speedT = over >= 15 ? this.speedT + dt : Math.max(0, this.speedT - dt);
      const cop = this.nearestCop(player.x, player.z);
      if (this.cool <= 0) {
        if (this.speedT > 1 && cop.d < 150) this.start(`Speeding: ${Math.round(mph)} in a ${this.limit}`, player);
        for (const ev of t.events) {
          if (this.wanted) break;
          if (ev.car.police && ev.speed > 1.5) this.start('Hit a police car', player);
          else if (ev.speed > 5 && cop.d < 200) this.start('Reckless driving', player);
        }
      }
    }
    t.events.length = 0;
    if (this.wanted) this.pursue(dt, player, mph);
    this.render();
  }

  start(reason, player) {
    const t = this.traffic;
    this.wanted = true;
    this.reason = reason;
    this.pursuitT = this.escapeT = this.bustT = 0;
    this.spawnT = 4;
    const cops = t.cars.filter((c) => c.police && c.mode !== 'crash')
      .map((c) => [Math.hypot(c.x - player.x, c.z - player.z), c])
      .filter(([d]) => d < 420)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 2);
    for (const [, c] of cops) t.startPursuit(c);
    if (!cops.length) t.spawnPursuer(player.x, player.z, player.heading);
    this.hud.toast(`Police! ${reason}. Lose them, or pull over and get busted.`, 4500);
  }

  pursue(dt, player, mph) {
    const t = this.traffic;
    this.pursuitT += dt;
    const pursuers = t.cars.filter((c) => c.pursuit);
    // more units join the longer it goes on
    const want = this.pursuitT > 45 ? 3 : this.pursuitT > 18 ? 2 : 1;
    this.spawnT -= dt;
    if (pursuers.length < want && this.spawnT <= 0) {
      this.spawnT = 7;
      t.spawnPursuer(player.x, player.z, player.heading);
    }
    let dMin = Infinity;
    for (const c of pursuers) dMin = Math.min(dMin, Math.hypot(c.x - player.x, c.z - player.z));
    this.dMin = dMin;
    // busted: stopped with a cruiser right there
    this.bustT = dMin < 12 && mph < 4 ? this.bustT + dt : Math.max(0, this.bustT - dt * 0.5);
    if (this.bustT > 2.5) {
      this.finish(`Busted! ${this.reason}. The officer lets you off with a warning this time.`);
      return;
    }
    // escaped: far from every cruiser for a while
    this.escapeT = dMin > 320 && this.pursuitT > 6 ? this.escapeT + dt : Math.max(0, this.escapeT - dt * 2);
    if (this.escapeT > 10) this.finish('You lost the police.');
  }

  finish(msg) {
    for (const c of this.traffic.cars) if (c.pursuit) this.traffic.endPursuit(c);
    this.wanted = false;
    this.cool = 10;
    this.speedT = 0;
    this.hud.toast(msg, 5000);
  }

  render() {
    this.el.hidden = !this.wanted;
    if (!this.wanted) return;
    this.el.classList.toggle('flash', Math.floor(performance.now() / 250) % 2 === 0);
    this.reasonEl.textContent = this.reason;
    const busting = this.bustT > 0.3;
    this.escapeEl.style.width = `${Math.min(100, ((busting ? this.bustT / 2.5 : this.escapeT / 10) * 100))}%`;
    this.escapeEl.classList.toggle('bust', busting);
    this.hintEl.textContent = busting ? 'Pulling you over…' : this.escapeT > 0 ? 'Getting away…' : `Get away from them (${Number.isFinite(this.dMin) ? Math.round(this.dMin) : '—'} m)`;
  }
}

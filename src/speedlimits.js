// Posted speed limit (mph) for every road, used by the AI drivers and the HUD sign.
// 1. OSM maxspeed where it's tagged (all of Bluemound/Moorland/I-94 etc.)
// 2. otherwise the nearest tagged stretch of the same street (e.g. untagged blocks of Calhoun Rd)
// 3. otherwise Wisconsin defaults: 25 mph in residence districts (Wis. Stat. 346.57), class-based elsewhere
const DEFAULT_MPH = {
  motorway: 65, trunk: 55, primary: 40, secondary: 35, tertiary: 30, unclassified: 25,
  residential: 25, living_street: 15, road: 25, service: 15,
  motorway_link: 45, trunk_link: 35, primary_link: 30, secondary_link: 25, tertiary_link: 25,
};

export function computeSpeedLimits(map) {
  const { roads, nodes } = map;
  const mid = (r) => {
    const n = r.nd[r.nd.length >> 1];
    return [nodes[n * 2], nodes[n * 2 + 1]];
  };
  const byName = new Map();
  roads.forEach((r) => {
    if (!r.s || !r.n) return;
    const [x, z] = mid(r);
    if (!byName.has(r.n)) byName.set(r.n, []);
    byName.get(r.n).push({ mph: r.s, x, z });
  });
  const mph = new Float32Array(roads.length);
  const inferred = new Uint8Array(roads.length);
  roads.forEach((r, i) => {
    if (r.s) { mph[i] = r.s; return; }
    inferred[i] = 1;
    const same = r.n && byName.get(r.n);
    if (same && !/_link$/.test(r.t)) {
      const [x, z] = mid(r);
      let best = null, bd = 2500;
      for (const c of same) { const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { bd = d; best = c; } }
      if (best) { mph[i] = best.mph; return; }
    }
    mph[i] = DEFAULT_MPH[r.t] || 25;
  });
  return { mph, inferred };
}

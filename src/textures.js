import * as THREE from 'three';

// Seeded value noise -> grayscale detail texture (values ~0.75..1.0) that multiplies
// material/vertex colors so asphalt and grass don't look like flat plastic.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileableNoise(size, cells, rand) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const out = new Float32Array(size * size);
  const s = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, y0 = Math.floor(fy), ty = s(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, x0 = Math.floor(fx), tx = s(fx - x0);
      const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const a = g[y0 * cells + x0], b = g[y0 * cells + x1], c = g[y1 * cells + x0], d = g[y1 * cells + x1];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

export function makeDetailTexture({ seed = 1, lo = 0.72, hi = 1.0, grain = 0.12 } = {}) {
  const size = 512;
  const rand = mulberry32(seed);
  const octaves = [
    [4, 0.45], [8, 0.25], [16, 0.15], [64, 0.15],
  ].map(([cells, w]) => [tileableNoise(size, cells, rand), w]);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    let v = 0;
    for (const [n, w] of octaves) v += n[i] * w;
    v = v * (1 - grain) + rand() * grain;
    const c = Math.round((lo + (hi - lo) * v) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = c;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Left as NoColorSpace on purpose: it's a linear brightness multiplier, not a color image.
  tex.anisotropy = 8;
  return tex;
}

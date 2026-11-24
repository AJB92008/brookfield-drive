// Player car: low-poly model + arcade physics (grip-decay drift model).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const box = (w, h, l, x, y, z) => new THREE.BoxGeometry(w, h, l).translate(x, y, z);

function colorize(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo.toNonIndexed ? geo.toNonIndexed() : geo;
}

// Shared car shape (local +z = forward). Returns { body, details } geometries.
// `body` is uncolored (white) so InstancedMesh colors / material colors tint it.
export function carGeometries({ length = 4.5, width = 1.85, height = 1.0, cabinLen = 2.3, cabinH = 0.62 } = {}) {
  const body = mergeGeometries([
    colorize(box(width, 0.62, length, 0, 0.62, 0), 0xffffff),
    colorize(box(width * 0.86, cabinH, cabinLen, 0, 0.93 + cabinH / 2, -0.25), 0xffffff),
  ]);
  const glassY = 0.93 + cabinH / 2 + 0.03;
  const details = mergeGeometries([
    // windows band (slightly wider/longer than the cabin so it shows on all sides)
    colorize(box(width * 0.875, cabinH * 0.62, cabinLen * 0.92, 0, glassY, -0.25), 0x1d2a35),
    colorize(box(width * 0.8, cabinH * 0.5, 0.06, 0, glassY, -0.25 + cabinLen / 2 + 0.01), 0x1d2a35),
    // lights
    colorize(box(0.42, 0.16, 0.06, -width / 2 + 0.33, 0.72, length / 2 + 0.01), 0xfff6d8),
    colorize(box(0.42, 0.16, 0.06, width / 2 - 0.33, 0.72, length / 2 + 0.01), 0xfff6d8),
    colorize(box(0.42, 0.16, 0.06, -width / 2 + 0.33, 0.74, -length / 2 - 0.01), 0xc4141a),
    colorize(box(0.42, 0.16, 0.06, width / 2 - 0.33, 0.74, -length / 2 - 0.01), 0xc4141a),
    // wheels
    ...[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) =>
      colorize(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10).rotateZ(Math.PI / 2).translate(sx * (width / 2 - 0.08), 0.36, sz * (length / 2 - 0.85)), 0x161616)),
  ]);
  return { body, details };
}

let _blobTex = null;
// Soft dark ellipse used as a contact shadow under cars in photoreal mode.
export function blobTexture() {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.6)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

// Procedural facade/roof texture layers packed into one DataArrayTexture, plus the building material
// that samples it. Every layer is one "bay": 3.5 m wide x one floor tall (roofs: 3.5 m x 3 m).
// RGB = pattern color, A = how much the building's paint color (vertex color) tints that pixel
// (walls/shingles tint; glass, doors, trim keep their own color).
import * as THREE from 'three';

export const BAY_W = 3.5;
export const L = {
  SIDING_WIN: 0, SIDING: 1, BRICK_WIN: 2, BRICK: 3, STUCCO_WIN: 4, STUCCO: 5,
  STOREFRONT: 6, RIBBON: 7, GLASS: 8, METAL: 9, GARAGE: 10, DOOR: 11, SHINGLE: 12, FLATROOF: 13, DOCK: 14,
};
const N_LAYERS = 15;
const S = 256;

function rng(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

// Painter draws color into one canvas and the tint mask (white = take paint color) into another,
// so "fixed" colors (glass, trim, doors) keep full RGB precision.
class Painter {
  constructor(c, m) { this.c = c; this.m = m; }
  tint(g) { this.c.fillStyle = `rgb(${g},${g},${g})`; this.m.fillStyle = '#fff'; return this; }
  fixed(r, g, b) { this.c.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`; this.m.fillStyle = '#000'; return this; }
  rect(x, y, w, h) { this.c.fillRect(x, y, w, h); this.m.fillRect(x, y, w, h); return this; }
  glass(x, y, w, h) {
    const g = this.c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, 'rgb(78,96,114)');
    g.addColorStop(0.45, 'rgb(46,58,72)');
    g.addColorStop(0.55, 'rgb(98,118,138)');
    g.addColorStop(1, 'rgb(36,44,56)');
    this.c.fillStyle = g; this.m.fillStyle = '#000';
    return this.rect(x, y, w, h);
  }
}

function base(p, kind, rand) {
  if (kind === 'siding') {
    p.tint(236).rect(0, 0, S, S);
    for (let y = 0; y < S; y += 13) { p.tint(198).rect(0, y, S, 2); p.tint(248).rect(0, y + 2, S, 1); }
  } else if (kind === 'brick') {
    p.fixed(196, 190, 178).rect(0, 0, S, S); // mortar
    const bh = 10, bw = 30;
    for (let row = 0, y = 0; y < S; row++, y += bh) {
      for (let x = (row % 2) * -bw / 2; x < S; x += bw) p.tint(200 + Math.floor(rand() * 55)).rect(x + 1, y + 1, bw - 2, bh - 2);
    }
  } else if (kind === 'stucco') {
    p.tint(235).rect(0, 0, S, S);
    for (let i = 0; i < 2500; i++) p.tint(215 + Math.floor(rand() * 40)).rect(rand() * S, rand() * S, 2, 2);
  } else if (kind === 'metal') {
    p.tint(232).rect(0, 0, S, S);
    for (let x = 0; x < S; x += 16) { p.tint(196).rect(x, 0, 3, S); p.tint(250).rect(x + 3, 0, 2, S); }
  } else if (kind === 'concrete') {
    p.tint(232).rect(0, 0, S, S);
    for (let i = 0; i < 1500; i++) p.tint(218 + Math.floor(rand() * 30)).rect(rand() * S, rand() * S, 3, 3);
    p.tint(205).rect(0, S - 3, S, 3).rect(S - 3, 0, 3, S);
  }
}

function window_(p, x, y, w, h, { mullions = 1, trim = [244, 243, 238] } = {}) {
  p.fixed(...trim).rect(x - 6, y - 6, w + 12, h + 12);
  p.glass(x, y, w, h);
  p.fixed(...trim).rect(x + w / 2 - 2, y, 4, h);
  if (mullions > 1) p.rect(x, y + h / 2 - 2, w, 4);
  p.fixed(210, 208, 200).rect(x - 9, y + h + 6, w + 18, 5); // sill
}

function drawLayer(p, layer, rand) {
  switch (layer) {
    case L.SIDING_WIN: base(p, 'siding', rand); window_(p, 86, 70, 84, 96, { mullions: 2 }); break;
    case L.SIDING: base(p, 'siding', rand); break;
    case L.BRICK_WIN: base(p, 'brick', rand); window_(p, 86, 70, 84, 96, { mullions: 2, trim: [232, 228, 218] }); break;
    case L.BRICK: base(p, 'brick', rand); break;
    case L.STUCCO_WIN: base(p, 'stucco', rand); window_(p, 80, 68, 96, 100, { mullions: 2, trim: [90, 84, 78] }); break;
    case L.STUCCO: base(p, 'stucco', rand); break;
    case L.STOREFRONT: {
      base(p, 'stucco', rand);
      p.fixed(62, 64, 68).rect(0, 40, S, S - 40);
      p.glass(6, 48, S - 12, S - 62);
      p.fixed(62, 64, 68);
      for (let x = 0; x < S; x += 64) p.rect(x, 40, 6, S - 40);
      p.rect(0, 110, S, 5);
      p.tint(214).rect(0, 0, S, 40); // sign band (paint color)
      p.tint(180).rect(0, 36, S, 4);
      break;
    }
    case L.RIBBON:
      base(p, 'concrete', rand);
      p.fixed(70, 74, 78).rect(0, 84, S, 92);
      p.glass(0, 90, S, 80);
      p.fixed(150, 156, 160); for (let x = 0; x < S; x += 64) p.rect(x, 84, 4, 92);
      break;
    case L.GLASS:
      p.glass(0, 0, S, S);
      p.fixed(150, 158, 166); for (let x = 0; x < S; x += 64) p.rect(x, 0, 5, S);
      p.rect(0, 0, S, 7).rect(0, S - 30, S, 30);
      break;
    case L.METAL: base(p, 'metal', rand); break;
    case L.GARAGE: {
      base(p, 'siding', rand);
      p.fixed(244, 243, 238).rect(22, 64, S - 44, S - 64);
      p.fixed(222, 221, 216);
      for (let y = 64; y < S; y += 48) p.rect(22, y, S - 44, 4);
      for (let x = 22; x < S - 40; x += 53) for (let y = 70; y < S; y += 48) p.rect(x + 8, y + 8, 37, 28);
      p.fixed(250, 250, 248);
      for (let x = 22; x < S - 40; x += 53) for (let y = 70; y < S; y += 48) p.rect(x + 11, y + 11, 31, 22);
      break;
    }
    case L.DOOR: {
      base(p, 'siding', rand);
      p.fixed(244, 243, 238).rect(84, 52, 88, S - 52);
      const c = [[92, 36, 30], [38, 52, 70], [70, 50, 34], [236, 234, 228], [30, 30, 32]][Math.floor(rand() * 5)];
      p.fixed(...c).rect(94, 62, 68, S - 62);
      p.fixed(c[0] * 0.8, c[1] * 0.8, c[2] * 0.8).rect(102, 74, 22, 50).rect(132, 74, 22, 50).rect(102, 140, 22, 70).rect(132, 140, 22, 70);
      p.fixed(212, 180, 90).rect(148, 160, 6, 6);
      window_(p, 196, 80, 40, 90); window_(p, 20, 80, 40, 90);
      break;
    }
    case L.SHINGLE:
      p.tint(214).rect(0, 0, S, S);
      for (let row = 0, y = 0; y < S; row++, y += 12) {
        for (let x = (row % 2) * -10; x < S; x += 20) p.tint(190 + Math.floor(rand() * 60)).rect(x + 1, y, 18, 11);
        p.tint(150).rect(0, y + 10, S, 2);
      }
      break;
    case L.FLATROOF:
      p.tint(230).rect(0, 0, S, S);
      for (let i = 0; i < 2500; i++) p.tint(205 + Math.floor(rand() * 50)).rect(rand() * S, rand() * S, 2, 2);
      p.tint(205).rect(0, 0, S, 2);
      break;
    case L.DOCK:
      base(p, 'metal', rand);
      p.fixed(214, 214, 210).rect(40, 70, S - 80, S - 70);
      p.fixed(190, 190, 186); for (let y = 70; y < S; y += 22) p.rect(40, y, S - 80, 3);
      p.fixed(40, 40, 40).rect(30, 60, S - 60, 10).rect(30, 60, 10, S - 60).rect(S - 40, 60, 10, S - 60);
      break;
  }
}

export function makeFacadeTexture() {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c.getContext('2d', { willReadFrequently: true }); };
  const cc = mk(), mc = mk();
  const data = new Uint8Array(S * S * 4 * N_LAYERS);
  for (let l = 0; l < N_LAYERS; l++) {
    cc.clearRect(0, 0, S, S);
    mc.fillStyle = '#000'; mc.fillRect(0, 0, S, S);
    drawLayer(new Painter(cc, mc), l, rng(1000 + l * 77));
    const col = cc.getImageData(0, 0, S, S).data, msk = mc.getImageData(0, 0, S, S).data;
    const off = l * S * S * 4;
    for (let y = 0; y < S; y++) {
      const sy = S - 1 - y; // flip so v=0 is the bottom of the bay
      for (let x = 0; x < S; x++) {
        const si = (sy * S + x) * 4, di = off + (y * S + x) * 4;
        data[di] = col[si]; data[di + 1] = col[si + 1]; data[di + 2] = col[si + 2];
        data[di + 3] = msk[si]; // tint mask
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, S, S, N_LAYERS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Lambert material that tiles a facade layer per vertex: attribute `facade` = (u, v, layer).
// fract() repeats the bay; textureGrad with the unwrapped UV derivatives avoids seams at the wrap.
export function makeBuildingMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.facadeTex = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 facade;\nvarying vec3 vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform highp sampler2DArray facadeTex;\nvarying vec3 vFacade;')
      .replace('#include <color_fragment>', `
        vec2 fuv = vFacade.xy;
        vec4 ft = textureGrad(facadeTex, vec3(fract(fuv), floor(vFacade.z + 0.5)), dFdx(fuv), dFdy(fuv));
        diffuseColor.rgb *= mix(ft.rgb, ft.rgb * vColor.rgb, ft.a);
      `);
  };
  mat.customProgramCacheKey = () => 'facade-v2';
  return mat;
}

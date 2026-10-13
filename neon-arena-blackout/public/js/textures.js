// Procedural PBR texture generation (albedo, normal, roughness/metalness, emissive).
// Everything is generated at load time on <canvas>, so the game ships no image assets.
import * as THREE from 'three';

// ------------------------------------------------------------------ noise
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RND = (() => { const r = mulberry32(1337), a = new Float32Array(65536); for (let i = 0; i < a.length; i++) a[i] = r(); return a; })();
const hash = (i, j) => RND[(i & 255) | ((j & 255) << 8)];
const fade = t => t * t * (3 - 2 * t);
/** Tileable value noise: period p (integer cells). */
function vnoise(x, y, p, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const s = seed * 31;
  const a = hash(x0 + s, y0), b = hash(x1 + s, y0), c = hash(x0 + s, y1), d = hash(x1 + s, y1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(u, v, period, oct = 5, seed = 0, gain = 0.5) {
  let sum = 0, amp = 0.5, norm = 0, p = period;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(u * p, v * p, p, seed + o);
    norm += amp; amp *= gain; p *= 2;
  }
  return sum / norm;
}

// ------------------------------------------------------------------ helpers
function canvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
function toTexture(cnv, srgb, repeat = 1) {
  const t = new THREE.CanvasTexture(cnv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
let maxAniso = 4;
export function setMaxAnisotropy(v) { maxAniso = v; }

/**
 * Build a full PBR set from per-pixel callbacks.
 * fn(u, v, out) must fill out = { r,g,b (0..1 albedo), h (height 0..1), rough, metal, er,eg,eb (emissive) }
 */
function buildSet(size, fn, { normalStrength = 2, emissive = false, alpha = false } = {}) {
  const albedoC = canvas(size), ormC = canvas(size), normalC = canvas(size);
  const ac = albedoC.getContext('2d'), oc = ormC.getContext('2d'), nc = normalC.getContext('2d');
  const A = ac.createImageData(size, size), O = oc.createImageData(size, size), N = nc.createImageData(size, size);
  const H = new Float32Array(size * size);
  let E = null, EC = null, alphaC = null, AL = null;
  if (emissive) { EC = canvas(size); E = EC.getContext('2d').createImageData(size, size); }
  if (alpha) { alphaC = canvas(size); AL = alphaC.getContext('2d').createImageData(size, size); }
  const out = {};
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.r = out.g = out.b = 0.5; out.h = 0.5; out.rough = 0.6; out.metal = 0; out.er = out.eg = out.eb = 0; out.a = 1;
      fn(x / size, y / size, out);
      const i = y * size + x, j = i * 4;
      A.data[j] = clamp255(out.r); A.data[j + 1] = clamp255(out.g); A.data[j + 2] = clamp255(out.b); A.data[j + 3] = 255;
      O.data[j] = 255; O.data[j + 1] = clamp255(out.rough); O.data[j + 2] = clamp255(out.metal); O.data[j + 3] = 255;
      if (E) { E.data[j] = clamp255(out.er); E.data[j + 1] = clamp255(out.eg); E.data[j + 2] = clamp255(out.eb); E.data[j + 3] = 255; }
      if (AL) { const a = clamp255(out.a); AL.data[j] = AL.data[j + 1] = AL.data[j + 2] = a; AL.data[j + 3] = 255; }
      H[i] = out.h;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = H[y * size + ((x - 1 + size) % size)], r = H[y * size + ((x + 1) % size)];
      const u = H[((y - 1 + size) % size) * size + x], d = H[((y + 1) % size) * size + x];
      let nx = (l - r) * normalStrength * size / 256, ny = (d - u) * normalStrength * size / 256, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const j = (y * size + x) * 4;
      N.data[j] = (nx * 0.5 + 0.5) * 255; N.data[j + 1] = (ny * 0.5 + 0.5) * 255; N.data[j + 2] = (nz * 0.5 + 0.5) * 255; N.data[j + 3] = 255;
    }
  }
  ac.putImageData(A, 0, 0); oc.putImageData(O, 0, 0); nc.putImageData(N, 0, 0);
  if (E) EC.getContext('2d').putImageData(E, 0, 0);
  if (AL) alphaC.getContext('2d').putImageData(AL, 0, 0);
  return { albedoC, ormC, normalC, emissiveC: EC, alphaC };
}
const clamp255 = v => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function setToMaps(set) {
  return {
    map: toTexture(set.albedoC, true),
    normalMap: toTexture(set.normalC, false),
    roughnessMap: toTexture(set.ormC, false),
    metalnessMap: null, // assigned below (shares ORM texture)
    emissiveMap: set.emissiveC ? toTexture(set.emissiveC, true) : null,
    alphaMap: set.alphaC ? toTexture(set.alphaC, false) : null
  };
}
function finalize(set) { const m = setToMaps(set); m.metalnessMap = m.roughnessMap; return m; }

// ------------------------------------------------------------------ materials
/** Wet concrete slabs with seams and puddles. One texture tile = 4 m. */
export function floorMaps(size) {
  return finalize(buildSet(size, (u, v, o) => {
    const su = (u * 2) % 1, sv = (v * 2) % 1;              // 2x2 slabs per tile
    const seam = Math.min(su, 1 - su, sv, 1 - sv);
    const groove = smooth(0.004, 0.012, seam);
    const grain = fbm(u, v, 32, 4, 1);
    const big = fbm(u, v, 4, 4, 7);
    const puddle = smooth(0.5, 0.57, fbm(u, v, 3, 5, 3) + (big - 0.5) * 0.15);
    const speck = vnoise(u * 512, v * 512, 512, 9) > 0.93 ? 0.06 : 0;
    const base = 0.13 + grain * 0.08 + speck - (1 - groove) * 0.06;
    const grime = mix(1, 0.7, smooth(0.45, 0.7, big));
    o.r = base * grime * 0.92; o.g = base * grime * 0.97; o.b = base * grime * 1.12;
    if (puddle > 0) { const k = puddle * 0.45; o.r *= 1 - k; o.g *= 1 - k; o.b *= 1 - k * 0.8; }
    o.h = 0.5 + (grain - 0.5) * 0.35 - (1 - groove) * 0.5;
    o.h = mix(o.h, 0.5, puddle);
    o.rough = mix(0.42 + grain * 0.3 + (1 - groove) * 0.2, 0.03, puddle);
    o.metal = 0;
  }, { normalStrength: 2.2 }));
}

/** Industrial metal wall panels with seams, rivets, edge wear and rust streaks. One tile = 2 m. */
export function metalPanelMaps(size, tint = [0.23, 0.26, 0.31]) {
  return finalize(buildSet(size, (u, v, o) => {
    const pu = (u * 2) % 1, pv = (v * 2) % 1;
    const edge = Math.min(pu, 1 - pu, pv, 1 - pv);
    const seam = smooth(0.006, 0.016, edge);
    const rivetU = Math.abs(((pu * 8) % 1) - 0.5), rivetV = Math.min(pv, 1 - pv);
    const rivetD = Math.hypot(rivetU / 8, rivetV - 0.035);
    const rivet = 1 - smooth(0.006, 0.01, rivetD);
    const rivetD2 = Math.hypot(Math.abs(((pv * 8) % 1) - 0.5) / 8, Math.min(pu, 1 - pu) - 0.035);
    const rivet2 = 1 - smooth(0.006, 0.01, rivetD2);
    const rv = Math.max(rivet, rivet2);
    const brushed = fbm(u * 0.05, v, 256, 2, 4) * 0.5 + fbm(u, v, 16, 4, 5) * 0.5;
    const streak = smooth(0.55, 0.8, fbm(u * 6, v * 0.6, 4, 4, 11)) * smooth(0, 0.6, pv);
    const wear = smooth(0.03, 0.0, edge - fbm(u, v, 24, 3, 6) * 0.03);
    const dirt = fbm(u, v, 6, 5, 12);
    let c = 0.75 + brushed * 0.3;
    o.r = tint[0] * c; o.g = tint[1] * c; o.b = tint[2] * c;
    // rust / grime streaks
    o.r = mix(o.r, 0.18, streak * 0.6); o.g = mix(o.g, 0.11, streak * 0.6); o.b = mix(o.b, 0.07, streak * 0.6);
    // bright worn metal on edges
    o.r = mix(o.r, 0.55, wear * 0.6); o.g = mix(o.g, 0.57, wear * 0.6); o.b = mix(o.b, 0.6, wear * 0.6);
    const s = seam * (1 - rv * 0.2);
    o.r *= mix(0.3, 1, s); o.g *= mix(0.3, 1, s); o.b *= mix(0.3, 1, s);
    o.h = 0.5 + rv * 0.45 - (1 - seam) * 0.5 + (brushed - 0.5) * 0.05;
    o.rough = 0.32 + brushed * 0.18 + streak * 0.35 + dirt * 0.15 - wear * 0.15;
    o.metal = mix(0.9, 0.35, streak) * mix(1, 0.8, dirt);
  }, { normalStrength: 2.5 }));
}

/** Corrugated cargo-crate panel with a paint colour, frame and scratches. One tile = 1 face. */
export function crateMaps(size, paint, label) {
  const set = buildSet(size, (u, v, o) => {
    const frame = Math.min(u, 1 - u, v, 1 - v);
    const inFrame = smooth(0.07, 0.08, frame);
    const rib = Math.sin(u * Math.PI * 18) * 0.5 + 0.5;
    const scratch = smooth(0.78, 0.86, fbm(u * 4, v * 0.25, 8, 3, 21)) * smooth(0.6, 0.7, fbm(u, v, 12, 3, 22));
    const chip = smooth(0.66, 0.7, fbm(u, v, 10, 5, 23)) * (1 - inFrame * 0.6);
    const dirt = fbm(u, v, 5, 5, 24) * smooth(0.2, 1, v);
    const bare = Math.max(scratch, chip);
    let r = paint[0], g = paint[1], b = paint[2];
    const shade = mix(0.8, 1.05, rib * inFrame + (1 - inFrame) * 0.6);
    r *= shade; g *= shade; b *= shade;
    r = mix(r, 0.42, bare); g = mix(g, 0.43, bare); b = mix(b, 0.45, bare);
    r = mix(r, 0.08, dirt * 0.35); g = mix(g, 0.07, dirt * 0.35); b = mix(b, 0.06, dirt * 0.35);
    o.r = r; o.g = g; o.b = b;
    o.h = 0.5 + (inFrame ? rib * 0.35 * inFrame : 0) + (1 - inFrame) * 0.4 - bare * 0.05;
    o.rough = mix(0.55, 0.35, bare) + dirt * 0.2;
    o.metal = mix(0.15, 0.9, bare);
  }, { normalStrength: 3 });
  if (label) {
    const ctx = set.albedoC.getContext('2d');
    ctx.save();
    ctx.globalAlpha = 0.82; ctx.fillStyle = '#e8e4d8';
    ctx.font = `700 ${size * 0.11}px Orbitron, Arial, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(label, size / 2, size * 0.58);
    ctx.font = `600 ${size * 0.04}px Rajdhani, Arial, sans-serif`;
    ctx.fillText('MAX GROSS 24 000 KG · NEXUS LOGISTICS', size / 2, size * 0.66);
    ctx.restore();
  }
  return finalize(set);
}

/** Dark tech panel with emissive circuit traces. One tile = 2 m. */
export function techMaps(size, glow = [0, 0.9, 1]) {
  return finalize(buildSet(size, (u, v, o) => {
    const cell = 8;
    const cu = u * cell, cv = v * cell;
    const iu = Math.floor(cu), iv = Math.floor(cv), fu = cu - iu, fv = cv - iv;
    const hsh = hash(iu % cell, iv % cell);
    const panelEdge = Math.min(fu, 1 - fu, fv, 1 - fv);
    const seam = smooth(0.02, 0.05, panelEdge);
    // circuit traces: horizontal or vertical lines inside some cells
    let trace = 0;
    if (hsh > 0.55) trace = 1 - smooth(0.012, 0.03, Math.abs(fv - 0.5 + (hsh - 0.75) * 0.6));
    else if (hsh < 0.25) trace = 1 - smooth(0.012, 0.03, Math.abs(fu - 0.5 + (hsh - 0.12) * 1.2));
    const node = hsh > 0.85 ? 1 - smooth(0.04, 0.07, Math.hypot(fu - 0.5, fv - 0.5)) : 0;
    const g = fbm(u, v, 32, 3, 31);
    const base = 0.05 + g * 0.04;
    o.r = base; o.g = base * 1.05; o.b = base * 1.25;
    const e = Math.max(trace * 0.9, node) * seam;
    o.er = glow[0] * e; o.eg = glow[1] * e; o.eb = glow[2] * e;
    o.h = 0.5 - (1 - seam) * 0.4 + trace * 0.08;
    o.rough = 0.25 + g * 0.2;
    o.metal = 0.7;
  }, { normalStrength: 2, emissive: true }));
}

/** Board-formed concrete for the perimeter walls. One tile = 4 m. */
export function concreteMaps(size) {
  return finalize(buildSet(size, (u, v, o) => {
    const boards = smooth(0.0, 0.01, Math.abs(((v * 6) % 1) - 0.5) - 0.48) ;
    const tieU = Math.abs(((u * 4) % 1) - 0.5), tieV = Math.abs(((v * 3) % 1) - 0.5);
    const tie = 1 - smooth(0.012, 0.02, Math.hypot(tieU / 4, tieV / 3));
    const g = fbm(u, v, 16, 5, 41), big = fbm(u, v, 3, 4, 42);
    const stain = smooth(0.5, 0.8, fbm(u * 3, v * 0.4, 6, 4, 43)) * smooth(0.0, 0.8, v);
    let c = 0.17 + g * 0.1 - stain * 0.08 - boards * 0.03;
    o.r = c * 0.95; o.g = c; o.b = c * 1.08;
    o.r *= 1 - tie * 0.7; o.g *= 1 - tie * 0.7; o.b *= 1 - tie * 0.7;
    o.h = 0.5 + (g - 0.5) * 0.4 - tie * 0.5 - boards * 0.12 + (big - 0.5) * 0.1;
    o.rough = 0.75 + g * 0.2 - stain * 0.3;
    o.metal = 0;
  }, { normalStrength: 2 }));
}

/** Metal floor grating (alpha-tested so you can see through catwalks). One tile = 1 m. */
export function grateMaps(size) {
  return finalize(buildSet(size, (u, v, o) => {
    const gu = (u * 10) % 1, gv = (v * 4) % 1;
    const barU = Math.min(gu, 1 - gu), barV = Math.min(gv, 1 - gv);
    const solid = barU < 0.18 || barV < 0.06;
    const g = fbm(u, v, 16, 3, 51);
    o.r = 0.2 + g * 0.1; o.g = 0.21 + g * 0.1; o.b = 0.24 + g * 0.1;
    o.h = solid ? 0.7 : 0.2;
    o.rough = 0.45 + g * 0.3; o.metal = 0.85;
    o.a = solid ? 1 : 0;
  }, { normalStrength: 1.5, alpha: true }));
}

/** Ribbed painted drum (barrels). */
export function barrelMaps(size, paint) {
  const set = buildSet(size, (u, v, o) => {
    const rib = Math.abs(((v * 3) % 1) - 0.5);
    const ribH = 1 - smooth(0.02, 0.05, Math.abs(rib - 0.5 + 0.02));
    const chip = smooth(0.62, 0.68, fbm(u, v, 8, 5, 61));
    const dirt = fbm(u, v, 4, 4, 62) * smooth(0.3, 1, v);
    let r = paint[0], g = paint[1], b = paint[2];
    r = mix(r, 0.4, chip); g = mix(g, 0.4, chip); b = mix(b, 0.42, chip);
    r = mix(r, 0.07, dirt * 0.5); g = mix(g, 0.06, dirt * 0.5); b = mix(b, 0.05, dirt * 0.5);
    o.r = r; o.g = g; o.b = b;
    o.h = 0.5 + ribH * 0.4;
    o.rough = mix(0.45, 0.3, chip) + dirt * 0.3;
    o.metal = mix(0.2, 0.9, chip);
  }, { normalStrength: 3 });
  const ctx = set.albedoC.getContext('2d');
  ctx.fillStyle = 'rgba(240,200,40,.85)';
  ctx.fillRect(size * 0.1, size * 0.4, size * 0.22, size * 0.2);
  ctx.fillStyle = '#111'; ctx.font = `700 ${size * 0.12}px Arial`; ctx.textAlign = 'center';
  ctx.fillText('⚠', size * 0.21, size * 0.55);
  return finalize(set);
}

/** Lit skyline windows (emissive). */
export function windowMaps(size) {
  return finalize(buildSet(size, (u, v, o) => {
    const cu = u * 16, cv = v * 32, iu = Math.floor(cu), iv = Math.floor(cv), fu = cu - iu, fv = cv - iv;
    const win = fu > 0.18 && fu < 0.82 && fv > 0.25 && fv < 0.8;
    const h = hash(iu * 7 + 3, iv * 13 + 5);
    const g = fbm(u, v, 16, 3, 71);
    o.r = 0.05 + g * 0.03; o.g = 0.055 + g * 0.03; o.b = 0.07 + g * 0.03;
    o.rough = win ? 0.1 : 0.7; o.metal = win ? 0.6 : 0.2; o.h = win ? 0.45 : 0.55;
    if (win && h > 0.62) {
      const warm = hash(iu + 11, iv + 17) > 0.5;
      const k = 0.4 + hash(iu + 1, iv + 2) * 0.6;
      if (warm) { o.er = 1 * k; o.eg = 0.62 * k; o.eb = 0.3 * k; }
      else if (h > 0.9) { o.er = 1 * k; o.eg = 0.2 * k; o.eb = 0.75 * k; }
      else { o.er = 0.3 * k; o.eg = 0.85 * k; o.eb = 1 * k; }
    }
  }, { normalStrength: 1, emissive: true }));
}

/** Worn yellow/black hazard stripes (as an albedo/rough set). */
export function hazardMaps(size) {
  return finalize(buildSet(size, (u, v, o) => {
    const s = ((u + v) * 4) % 1 < 0.5;
    const wear = smooth(0.55, 0.7, fbm(u, v, 8, 5, 81));
    let r = s ? 0.85 : 0.03, g = s ? 0.62 : 0.03, b = s ? 0.05 : 0.03;
    r = mix(r, 0.25, wear); g = mix(g, 0.25, wear); b = mix(b, 0.27, wear);
    o.r = r; o.g = g; o.b = b; o.h = 0.5 - wear * 0.1; o.rough = mix(0.5, 0.35, wear); o.metal = mix(0.1, 0.8, wear);
  }, { normalStrength: 1 }));
}

/** Fine gun-metal for the weapon model. */
export function gunMetalMaps(size) {
  return finalize(buildSet(size, (u, v, o) => {
    const g = fbm(u, v, 64, 3, 91), wear = smooth(0.7, 0.8, fbm(u, v, 12, 4, 92));
    const c = 0.16 + g * 0.06 + wear * 0.3;
    o.r = c; o.g = c * 1.02; o.b = c * 1.08;
    o.h = 0.5 + (g - 0.5) * 0.2; o.rough = 0.38 + g * 0.2 - wear * 0.15; o.metal = 0.85;
  }, { normalStrength: 1 }));
}

/** Soft radial sprite (particles, flares, fog puffs). */
export function radialSprite(size = 128, inner = 0, falloff = 2.2) {
  const c = canvas(size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x / size - 0.5, y / size - 0.5) * 2;
    const a = d >= 1 ? 0 : Math.pow(1 - Math.max(0, d - inner) / (1 - inner), falloff);
    const j = (y * size + x) * 4; img.data[j] = img.data[j + 1] = img.data[j + 2] = 255; img.data[j + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** Soft billowy smoke puff sprite. */
export function smokeSprite(size = 128) {
  const c = canvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = fbm(u, v, 4, 4, 101);
    const a = Math.max(0, 1 - d) ** 1.5 * smooth(0.25, 0.75, n + (1 - d) * 0.35);
    const j = (y * size + x) * 4; img.data[j] = img.data[j + 1] = img.data[j + 2] = 255; img.data[j + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** Star-shaped muzzle flash sprite. */
export function flashSprite(size = 256) {
  const c = canvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x / size - 0.5, dy = y / size - 0.5, d = Math.hypot(dx, dy) * 2, ang = Math.atan2(dy, dx);
    const spikes = Math.pow(Math.abs(Math.cos(ang * 3.5)), 6) * 0.6 + Math.pow(Math.abs(Math.cos(ang * 2 + 0.4)), 12) * 0.4;
    const n = vnoise(ang * 6 + 20, d * 4, 64, 3);
    const r = 0.18 + spikes * 0.75 * (0.6 + n * 0.4);
    const a = Math.max(0, 1 - d / r) ** 1.4 + Math.max(0, 1 - d / 0.22) ** 2;
    const core = Math.max(0, 1 - d / 0.25);
    const j = (y * size + x) * 4;
    img.data[j] = 255; img.data[j + 1] = 200 + core * 55; img.data[j + 2] = 120 + core * 135; img.data[j + 3] = Math.min(1, a) * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** Bullet-hole decal with a scorched ring. */
export function bulletHoleSprite(size = 128) {
  const c = canvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size - 0.5, v = y / size - 0.5, d = Math.hypot(u, v) * 2, ang = Math.atan2(v, u);
    const n = vnoise(ang * 5 + 10, d * 3, 32, 7);
    const hole = 1 - smooth(0.12, 0.18, d);
    const scorch = (1 - smooth(0.2, 0.9 * (0.7 + n * 0.5), d)) * 0.85;
    const crack = Math.pow(Math.abs(Math.cos(ang * 4 + n * 3)), 40) * (1 - smooth(0.2, 0.7, d));
    const a = Math.max(hole, scorch, crack * 0.9);
    const j = (y * size + x) * 4;
    const cc = hole > 0.5 ? 5 : 20;
    img.data[j] = cc; img.data[j + 1] = cc; img.data[j + 2] = cc; img.data[j + 3] = Math.min(1, a) * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** UV-scale a BoxGeometry so textures keep a constant world-space density. */
export function worldUVBox(sx, sy, sz, tile = 2) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.attributes.uv;
  // faces: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile);
  }
  uv.needsUpdate = true;
  return g;
}
export { fbm, vnoise, mulberry32 };

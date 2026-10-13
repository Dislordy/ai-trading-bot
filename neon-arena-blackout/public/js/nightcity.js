// Dense "neon megacity" set dressing: spray-paint graffiti, glowing vending machines,
// trash and street clutter, stacked vertical neon signs, animated holo-ads on the
// megabuildings around the arena and holographic koi circling the reactor core.
// All brands and slogans are original.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './textures.js';

const Sim = window.NeonSim;
const A = Sim.ARENA_HALF;

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ graffiti
const TAGS = ['NO FUTURE', 'WAKE UP', 'FLATLINE', 'RUN FAST', 'GHOST', 'VOID', 'DEAD SIGNAL', 'NOBODY'];
const SPRAY = ['#ff2fb9', '#00f5ff', '#ffe600', '#b6ff4a', '#ff5a3c', '#ffffff', '#8a5cff'];
function graffitiTexture(rand, text) {
  return canvasTex(1024, 384, (x, w, h) => {
    const c1 = SPRAY[(rand() * SPRAY.length) | 0], c2 = SPRAY[(rand() * SPRAY.length) | 0];
    // background "throw-up" blobs
    for (let i = 0; i < 26; i++) {
      x.globalAlpha = 0.18 + rand() * 0.25; x.fillStyle = rand() > 0.5 ? c2 : '#111';
      x.beginPath(); x.ellipse(w * (0.15 + rand() * 0.7), h * (0.3 + rand() * 0.4), 30 + rand() * 120, 20 + rand() * 60, rand() * 3, 0, 6.3); x.fill();
    }
    x.globalAlpha = 1;
    // main tag: chunky outlined letters with a soft overspray halo
    x.save(); x.translate(w / 2, h / 2); x.rotate((rand() - 0.5) * 0.18);
    let fs = 170; x.font = `900 ${fs}px Impact, "Arial Black", sans-serif`;
    const tw = x.measureText(text).width; if (tw > w * 0.9) { fs *= w * 0.9 / tw; x.font = `900 ${fs}px Impact, "Arial Black", sans-serif`; }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = c1; x.shadowBlur = 28; x.lineJoin = 'round';
    x.strokeStyle = '#0a0a0a'; x.lineWidth = 26; x.strokeText(text, 0, 0);
    x.shadowBlur = 0; x.strokeStyle = c2; x.lineWidth = 12; x.strokeText(text, 0, 0);
    const g = x.createLinearGradient(0, -fs / 2, 0, fs / 2); g.addColorStop(0, '#fff'); g.addColorStop(0.35, c1); g.addColorStop(1, c1);
    x.fillStyle = g; x.fillText(text, 0, 0);
    // paint drips
    x.fillStyle = c1;
    for (let i = 0; i < 14; i++) { const dx = (rand() - 0.5) * tw * 0.9, len = 20 + rand() * 90; x.fillRect(dx, fs * 0.3, 4 + rand() * 4, len); x.beginPath(); x.arc(dx + 3, fs * 0.3 + len, 5, 0, 6.3); x.fill(); }
    x.restore();
    // speckled overspray
    for (let i = 0; i < 1500; i++) { x.globalAlpha = rand() * 0.5; x.fillStyle = rand() > 0.5 ? c1 : c2; x.fillRect(rand() * w, rand() * h, 2, 2); }
  });
}

// ------------------------------------------------------------------ vending machine front
function vendingTexture(brand, color) {
  return canvasTex(256, 448, (x, w, h) => {
    x.fillStyle = '#05070c'; x.fillRect(0, 0, w, h);
    const g = x.createLinearGradient(0, 0, 0, 110); g.addColorStop(0, color); g.addColorStop(1, '#000');
    x.fillStyle = g; x.fillRect(10, 10, w - 20, 100);
    x.fillStyle = '#fff'; x.font = '800 40px Orbitron, Arial'; x.textAlign = 'center'; x.shadowColor = color; x.shadowBlur = 16;
    x.fillText(brand, w / 2, 62); x.font = '600 18px Rajdhani, Arial'; x.fillText('ICE COLD · 24/7 · ¥200', w / 2, 92);
    x.shadowBlur = 0;
    // product window with rows of cans
    x.fillStyle = '#0c1422'; x.fillRect(16, 124, w - 72, 270);
    const cols = ['#ff2f4f', '#00e5ff', '#ffd400', '#b6ff4a', '#ff7ad9', '#ffffff'];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      const cx = 30 + c * 34, cy = 138 + r * 52;
      x.fillStyle = cols[(r * 2 + c) % cols.length]; x.fillRect(cx, cy, 22, 38);
      x.fillStyle = 'rgba(255,255,255,.55)'; x.fillRect(cx + 3, cy + 3, 4, 32);
      x.fillStyle = '#ff2fb9'; x.fillRect(cx - 4, cy + 42, 30, 3);
    }
    // keypad + coin slot
    x.fillStyle = '#1a2233'; x.fillRect(w - 50, 124, 34, 270);
    for (let i = 0; i < 12; i++) { x.fillStyle = i % 4 ? '#00e5ff' : '#ff2f4f'; x.fillRect(w - 44 + (i % 3) * 9, 140 + ((i / 3) | 0) * 14, 6, 8); }
    x.fillStyle = '#000'; x.fillRect(20, h - 44, w - 40, 30);
    x.fillStyle = color; x.fillRect(20, h - 46, w - 40, 3);
  });
}

// ------------------------------------------------------------------ vertical neon sign
function verticalSignTexture(chars, color) {
  return canvasTex(160, 160 * chars.length + 40, (x, w, h) => {
    x.fillStyle = 'rgba(8,4,14,0.92)'; x.fillRect(0, 0, w, h);
    x.strokeStyle = color; x.lineWidth = 6; x.shadowColor = color; x.shadowBlur = 18; x.strokeRect(8, 8, w - 16, h - 16);
    x.font = `700 118px "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    [...chars].forEach((ch, i) => {
      x.shadowBlur = 24; x.fillStyle = color; x.fillText(ch, w / 2, 100 + i * 160);
      x.shadowBlur = 4; x.fillStyle = '#fff'; x.globalAlpha = 0.85; x.fillText(ch, w / 2, 100 + i * 160); x.globalAlpha = 1;
    });
  });
}

// ------------------------------------------------------------------ animated holo-ad
const ADS = [
  { title: 'MOKU RAMEN', sub: 'もっと熱く · HOT NOODLES · 24H', color: '#ff5a3c' },
  { title: 'HELIX BIOWARE', sub: 'UPGRADE YOUR BODY · ボディ', color: '#00f5ff' },
  { title: 'SYNAPSE+', sub: 'FEEL EVERYTHING · 感じて', color: '#ff2fb9' },
  { title: 'ORBITAL AIR', sub: 'LEAVE THE CITY TONIGHT', color: '#ffd400' },
  { title: 'VANTA CHROME', sub: 'BE MORE THAN HUMAN · クローム', color: '#b6ff4a' },
  { title: 'NEON NOIR', sub: 'NIGHTLY · LIVE · 生放送', color: '#8a5cff' }
];
function adMaterial(ad, seed) {
  const map = canvasTex(1024, 512, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const g = x.createRadialGradient(w * 0.3, h * 0.45, 20, w * 0.3, h * 0.45, 420); g.addColorStop(0, ad.color); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = 0.45; x.fillStyle = g; x.fillRect(0, 0, w, h); x.globalAlpha = 1;
    // abstract product shape
    x.strokeStyle = '#fff'; x.lineWidth = 6; x.shadowColor = ad.color; x.shadowBlur = 30;
    x.beginPath(); x.arc(w * 0.22, h * 0.48, 120, 0, 6.3); x.stroke();
    x.beginPath(); x.arc(w * 0.22, h * 0.48, 70 + (seed % 3) * 12, 0, 6.3); x.stroke();
    let fs = 120; x.font = `800 ${fs}px Orbitron, Arial`;
    const tw = x.measureText(ad.title).width, maxW = w * 0.56; if (tw > maxW) { fs *= maxW / tw; x.font = `800 ${fs}px Orbitron, Arial`; }
    x.textAlign = 'left'; x.textBaseline = 'middle'; x.fillStyle = '#fff'; x.shadowBlur = 24; x.fillText(ad.title, w * 0.42, h * 0.42);
    x.font = '600 34px Rajdhani, "Noto Sans CJK JP", Arial'; x.fillStyle = ad.color; x.shadowBlur = 12; x.fillText(ad.sub, w * 0.42, h * 0.62);
    x.fillStyle = ad.color; x.fillRect(w * 0.42, h * 0.72, w * 0.5, 6);
  });
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, time: { value: seed * 3.1 }, color: { value: new THREE.Color(ad.color) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D map; uniform float time; uniform vec3 color; varying vec2 vUv;
      float h(float n){ return fract(sin(n) * 43758.5453); }
      void main(){
        vec2 uv = vUv;
        float slot = floor(time * 4.0);
        float glitch = step(0.93, h(slot)) * step(0.5, h(floor(uv.y * 30.0) + slot));
        uv.x += glitch * (h(slot + uv.y) - 0.5) * 0.08;
        vec3 c = texture2D(map, uv).rgb;
        c.r = texture2D(map, uv + vec2(0.004 * (1.0 + glitch * 4.0), 0.0)).r;
        float scan = 0.82 + 0.18 * sin(uv.y * 600.0 + time * 10.0);
        float flick = 0.85 + 0.15 * step(0.2, h(floor(time * 15.0)));
        float sweep = smoothstep(0.0, 0.03, abs(fract(uv.x - time * 0.12) - 0.5)) * 0.25 + 0.75;
        vec3 outc = c * scan * flick * sweep * 2.4 + color * 0.05;
        float edge = 1.0 - step(0.008, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        gl_FragColor = vec4(outc + color * edge * 3.0, 1.0);
      }`,
    side: THREE.DoubleSide, fog: false
  });
}

// ------------------------------------------------------------------ holographic koi
function koiGeometry() {
  const parts = [];
  const body = new THREE.SphereGeometry(0.5, 20, 14); body.scale(0.42, 0.34, 1.35); parts.push(body);
  const tail = new THREE.PlaneGeometry(0.9, 0.7, 6, 4); tail.rotateY(Math.PI / 2); tail.rotateZ(Math.PI / 2); tail.translate(0, 0, 0.95); parts.push(tail);
  for (const s of [-1, 1]) { const fin = new THREE.PlaneGeometry(0.45, 0.3, 2, 2); fin.rotateX(-Math.PI / 2); fin.rotateY(s * 0.6); fin.translate(s * 0.3, -0.08, -0.2); parts.push(fin); }
  const dorsal = new THREE.PlaneGeometry(0.5, 0.25, 3, 2); dorsal.rotateY(Math.PI / 2); dorsal.translate(0, 0.25, 0.05); parts.push(dorsal);
  for (const p of parts) { for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv'].includes(k)) p.deleteAttribute(k); }
  return mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p), false);
}
function koiMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(color) } },
    vertexShader: `uniform float time; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        vec3 p = position;
        float k = smoothstep(-0.6, 1.4, p.z);
        p.x += sin(p.z * 3.2 - time * 5.0) * 0.16 * k;
        vP = p;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float time; uniform vec3 color; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        float scan = 0.6 + 0.4 * sin(vP.y * 60.0 - time * 8.0);
        float scales = 0.75 + 0.25 * sin(vP.z * 40.0) * sin(vP.x * 40.0);
        float spots = step(0.55, fract(sin(dot(floor(vP.xz * 5.0), vec2(12.9, 78.2))) * 43758.5));
        vec3 c = mix(color, vec3(1.0), spots * 0.6);
        float a = (0.25 + f * 1.6) * scan * scales;
        gl_FragColor = vec4(c * a * 2.2, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
  });
}

// ------------------------------------------------------------------ build
export function addNightCity(root, Q) {
  const rand = mulberry32(2077);
  const updaters = [];
  const decalMat = map => new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3 });

  // graffiti on the inner faces of the perimeter walls (between pilasters, below the pipes)
  const spots = [
    [-21, 1.6, -A + 0.505, 0], [0, 1.4, -A + 0.505, 0], [14, 1.5, -A + 0.505, 0],
    [21, 1.6, A - 0.505, Math.PI], [0, 1.4, A - 0.505, Math.PI], [-14, 1.5, A - 0.505, Math.PI],
    [-A + 0.505, 1.5, -14, Math.PI / 2], [-A + 0.505, 1.4, 6, Math.PI / 2],
    [A - 0.505, 1.5, 14, -Math.PI / 2], [A - 0.505, 1.4, -6, -Math.PI / 2]
  ];
  spots.forEach(([x, y, z, ry], i) => {
    const w = 4.6 + rand() * 1.2;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.375), decalMat(graffitiTexture(rand, TAGS[i % TAGS.length])));
    m.position.set(x, y, z); m.rotation.y = ry; m.receiveShadow = true; root.add(m);
  });

  // vending machines (colliders live in shared/sim.js)
  const brands = [['VOLTA COLA', '#ff2f4f'], ['SYNTHI-POP', '#00e5ff'], ['KAZE TEA', '#b6ff4a'], ['NOVA ENERGY', '#ffd400']];
  const shell = new THREE.MeshStandardMaterial({ color: 0x1d2330, roughness: 0.35, metalness: 0.85, envMapIntensity: 1.4 });
  let vi = 0;
  for (const b of Sim.boxes) {
    if (b.kind !== 'vending') continue;
    const [brand, col] = brands[vi++ % brands.length];
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, sx = b.max[0] - b.min[0], sy = b.max[1], sz = b.max[2] - b.min[2];
    const g = new THREE.Group(); g.position.set(cx, 0, cz); g.rotation.y = b.dir[1] > 0 ? 0 : Math.PI; root.add(g);
    const body = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), shell); body.position.y = sy / 2; body.castShadow = body.receiveShadow = true; g.add(body);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(sx - 0.1, sy - 0.15), new THREE.MeshBasicMaterial({ map: vendingTexture(brand, col), color: new THREE.Color(1.8, 1.8, 1.8) }));
    front.position.set(0, sy / 2, sz / 2 + 0.006); g.add(front);
    const glow = new THREE.PointLight(col, Q.shadows ? 6 : 0, 5, 2); glow.position.set(0, 1.3, sz / 2 + 0.7); if (Q.shadows) g.add(glow);
    const topSign = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.08, 0.05), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(4) }));
    topSign.position.set(0, sy + 0.02, sz / 2 - 0.02); g.add(topSign);
    updaters.push(t => { const f = Math.sin(t * 31 + vi) > 0.992 ? 0.3 : 1; front.material.color.setScalar(1.8 * f); if (Q.shadows) glow.intensity = 6 * f; });
  }

  // trash bags + cardboard boxes in corners (cosmetic, knee height)
  const bagMat = new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.15 });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 0.95, metalness: 0 });
  const bagGeos = [], boxGeos = [];
  const clutter = [[-26.4, -9.5], [26.4, 9.5], [-9.6, -26.6], [9.6, 26.6], [-26.4, 9], [26.4, -9], [3.5, -26.6], [-3.5, 26.6]];
  for (const [x, z] of clutter) {
    for (let i = 0; i < 5; i++) {
      const g = new THREE.SphereGeometry(0.28 + rand() * 0.12, 10, 8);
      g.scale(1, 0.65 + rand() * 0.2, 0.9); g.rotateY(rand() * 3);
      g.translate(x + (rand() - 0.5) * 1.3, 0.2, z + (rand() - 0.5) * 0.7); bagGeos.push(g);
    }
    for (let i = 0; i < 2; i++) {
      const s = 0.35 + rand() * 0.25, g = new THREE.BoxGeometry(s, s * 0.8, s);
      g.rotateY(rand() * 3); g.translate(x + (rand() - 0.5) * 1.4, s * 0.4, z + (rand() - 0.5) * 0.6); boxGeos.push(g);
    }
  }
  const strip = gs => mergeGeometries(gs.map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g.toNonIndexed(); }), false);
  const bags = new THREE.Mesh(strip(bagGeos), bagMat); bags.castShadow = bags.receiveShadow = true; root.add(bags);
  const boxes = new THREE.Mesh(strip(boxGeos), boxMat); boxes.castShadow = boxes.receiveShadow = true; root.add(boxes);

  // vertical neon signs stacked on top of the perimeter walls
  const vSigns = [['ホテル', '#ff2fb9', -18, -A - 0.2, 0], ['バー', '#00f5ff', 9, -A - 0.2, 0], ['ネオン', '#ffd400', 18, A + 0.2, Math.PI], ['ラーメン', '#ff5a3c', -9, A + 0.2, Math.PI],
    ['クラブ', '#b6ff4a', -A - 0.2, 18, Math.PI / 2], ['夜', '#8a5cff', A + 0.2, -18, -Math.PI / 2]];
  for (const [txt, col, x, z, ry] of vSigns) {
    const h = 1.15 * [...txt].length + 0.3;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.15, h), new THREE.MeshBasicMaterial({ map: verticalSignTexture(txt, col), color: new THREE.Color(2.2, 2.2, 2.2), side: THREE.DoubleSide }));
    m.position.set(x, Sim.WALL_HEIGHT + 0.6 + h / 2, z); m.rotation.y = ry; root.add(m);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, h + 0.8, 0.08), new THREE.MeshStandardMaterial({ color: 0x111318, metalness: 0.9, roughness: 0.4 }));
    pole.position.set(x, Sim.WALL_HEIGHT + (h + 0.8) / 2, z); pole.rotation.y = ry; pole.translateZ(-0.06); root.add(pole);
    updaters.push(t => { m.material.color.setScalar(Math.sin(t * 17 + x) > 0.985 ? 0.4 : 2.2); });
  }

  // megabuilding facades with animated holo-ads ringing the arena
  const facadeMat = new THREE.MeshStandardMaterial({ color: 0x0b0d14, roughness: 0.6, metalness: 0.6 });
  const adCount = Q.extraLights ? 8 : 6;
  for (let i = 0; i < adCount; i++) {
    const ang = i / adCount * Math.PI * 2 + 0.35, dist = 44 + (i % 2) * 10;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const w = 12 + rand() * 6, h = w / 2, y = 16 + rand() * 14;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(w + 3, y + h + 12, 6), facadeMat);
    tower.position.set(x, (y + h + 12) / 2 - 1, z); tower.lookAt(0, tower.position.y, 0); tower.translateZ(-3.2); root.add(tower);
    const ad = new THREE.Mesh(new THREE.PlaneGeometry(w, h), adMaterial(ADS[i % ADS.length], i));
    ad.position.set(x, y, z); ad.lookAt(0, y * 0.6, 0); root.add(ad);
    updaters.push((t, dt) => { ad.material.uniforms.time.value += dt; });
  }

  // holographic koi circling above the reactor core
  const koiGeo = koiGeometry();
  const koi = [0xff7a2f, 0x00f5ff, 0xff2fb9].map((c, i) => {
    const m = new THREE.Mesh(koiGeo, koiMaterial(c)); m.scale.setScalar(1.7 - i * 0.2); m.renderOrder = 9; root.add(m);
    return { m, phase: i * 2.1, r: 4.6 + i * 0.9, y: 6.6 + i * 0.7, speed: 0.32 - i * 0.04 };
  });
  updaters.push((t, dt) => {
    for (const k of koi) {
      const a = k.phase + t * k.speed;
      k.m.position.set(Math.cos(a) * k.r, k.y + Math.sin(t * 0.8 + k.phase) * 0.5, Math.sin(a) * k.r);
      // +z (the tail) points back along the path, so the head (-z) leads
      k.m.lookAt(Math.cos(a - 0.15) * k.r, k.m.position.y, Math.sin(a - 0.15) * k.r);
      k.m.material.uniforms.time.value = t;
    }
  });

  return { update(t, dt) { for (const u of updaters) u(t, dt); } };
}

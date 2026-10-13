// Visual effects: particle systems, spark streaks, bullet tracers, impact decals,
// shell casings, muzzle flashes, death bursts, scan pulses, steam vents and dust.
import * as THREE from 'three';
import * as TX from './textures.js';

const Sim = window.NeonSim;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ point particles
class Particles {
  constructor(capacity, texture, blending, { sizeScale = 300 } = {}) {
    this.n = capacity; this.next = 0;
    this.pos = new Float32Array(capacity * 3); this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity); this.alpha = new Float32Array(capacity); this.rot = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3); this.life = new Float32Array(capacity); this.max = new Float32Array(capacity);
    this.grav = new Float32Array(capacity); this.drag = new Float32Array(capacity); this.s0 = new Float32Array(capacity); this.s1 = new Float32Array(capacity);
    this.a0 = new Float32Array(capacity); this.spin = new Float32Array(capacity); this.bounce = new Uint8Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry = g;
    const additive = blending === THREE.AdditiveBlending;
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, scale: { value: sizeScale } },
      vertexShader: `attribute float size; attribute float alpha; attribute float rot; attribute vec3 color; uniform float scale;
        varying vec3 vC; varying float vA; varying float vR;
        void main(){ vC = color; vA = alpha; vR = rot; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec3 vC; varying float vA; varying float vR;
        void main(){ vec2 p = gl_PointCoord - 0.5; float c = cos(vR), s = sin(vR); p = mat2(c,-s,s,c) * p + 0.5;
          vec4 t = texture2D(map, p); if (t.a * vA < 0.003) discard;
          gl_FragColor = vec4(vC * ${additive ? 't.a * vA' : '1.0'}, ${additive ? '1.0' : 't.a * vA'}); }`,
      transparent: true, depthWrite: false, blending
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }
  spawn(x, y, z, vx, vy, vz, o) {
    const i = this.next; this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    const c = o.color || [1, 1, 1];
    this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
    this.life[i] = this.max[i] = o.life || 1;
    this.grav[i] = o.gravity || 0; this.drag[i] = o.drag || 0;
    this.s0[i] = o.size || 0.1; this.s1[i] = o.endSize !== undefined ? o.endSize : this.s0[i];
    this.a0[i] = o.alpha !== undefined ? o.alpha : 1; this.spin[i] = o.spin || 0; this.rot[i] = Math.random() * 6.28;
    this.bounce[i] = o.bounce ? 1 : 0;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.size[i] = 0; } continue; }
      this.life[i] -= dt;
      const k = 1 - Math.max(0, this.life[i]) / this.max[i];
      const d = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.vel[j] *= d; this.vel[j + 1] = this.vel[j + 1] * d - this.grav[i] * dt; this.vel[j + 2] *= d;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.bounce[i] && this.pos[j + 1] < 0.02) { this.pos[j + 1] = 0.02; this.vel[j + 1] *= -0.35; this.vel[j] *= 0.6; this.vel[j + 2] *= 0.6; }
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      this.alpha[i] = this.a0[i] * (1 - k) * Math.min(1, k * 12 + 0.2);
      this.rot[i] += this.spin[i] * dt;
    }
    const a = this.geometry.attributes;
    a.position.needsUpdate = a.color.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = a.rot.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ spark streaks
class Sparks {
  constructor(capacity) {
    this.n = capacity; this.next = 0;
    this.pos = new Float32Array(capacity * 3); this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity); this.max = new Float32Array(capacity); this.col = new Float32Array(capacity * 3);
    this.vtx = new Float32Array(capacity * 6); this.vcol = new Float32Array(capacity * 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.vtx, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.vcol, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry = g;
    this.lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      vertexShader: 'attribute vec4 color; varying vec4 vC; void main(){ vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec4 vC; void main(){ gl_FragColor = vec4(vC.rgb * vC.a, 1.0); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    this.lines.frustumCulled = false;
  }
  spawn(x, y, z, vx, vy, vz, life, color) {
    const i = this.next; this.next = (this.next + 1) % this.n;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = this.max[i] = life; this.col.set(color, i * 3);
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      const j = i * 3, v = i * 6, c = i * 8;
      if (this.life[i] <= 0) { if (this.vcol[c + 3] !== 0) { this.vcol[c + 3] = this.vcol[c + 7] = 0; } continue; }
      this.life[i] -= dt;
      this.vel[j + 1] -= 9.8 * dt;
      const d = Math.exp(-1.5 * dt); this.vel[j] *= d; this.vel[j + 2] *= d;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < 0.01) { this.pos[j + 1] = 0.01; this.vel[j + 1] *= -0.3; }
      const tail = 0.022;
      this.vtx[v] = this.pos[j]; this.vtx[v + 1] = this.pos[j + 1]; this.vtx[v + 2] = this.pos[j + 2];
      this.vtx[v + 3] = this.pos[j] - this.vel[j] * tail; this.vtx[v + 4] = this.pos[j + 1] - this.vel[j + 1] * tail; this.vtx[v + 5] = this.pos[j + 2] - this.vel[j + 2] * tail;
      const a = Math.max(0, this.life[i] / this.max[i]);
      for (let e = 0; e < 2; e++) { this.vcol[c + e * 4] = this.col[j] * 4; this.vcol[c + e * 4 + 1] = this.col[j + 1] * 4; this.vcol[c + e * 4 + 2] = this.col[j + 2] * 4; this.vcol[c + e * 4 + 3] = a * (e ? 0.1 : 1); }
    }
    this.geometry.attributes.position.needsUpdate = this.geometry.attributes.color.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ main FX manager
export class Effects {
  constructor(scene, quality) {
    this.scene = scene; this.Q = quality;
    const glowTex = TX.radialSprite(64, 0, 2.2), smokeTex = TX.smokeSprite(128);
    this.glow = new Particles(quality.particles, glowTex, THREE.AdditiveBlending);
    this.smoke = new Particles(Math.round(quality.particles / 2), smokeTex, THREE.NormalBlending);
    this.debris = new Particles(Math.round(quality.particles / 3), TX.radialSprite(32, 0.6, 1), THREE.NormalBlending);
    this.sparks = new Sparks(Math.round(quality.particles / 2));
    this.smoke.points.renderOrder = 8; this.glow.points.renderOrder = 9; this.sparks.lines.renderOrder = 9;
    scene.add(this.glow.points, this.smoke.points, this.debris.points, this.sparks.lines);

    // tracers
    this.tracers = [];
    const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true); tracerGeo.rotateX(Math.PI / 2); tracerGeo.translate(0, 0, 0.5);
    const beamGeo = tracerGeo.clone();
    for (let i = 0; i < 32; i++) {
      const bolt = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      bolt.visible = beam.visible = false; bolt.frustumCulled = beam.frustumCulled = false;
      scene.add(bolt, beam);
      this.tracers.push({ bolt, beam, life: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), dist: 0, travel: 0 });
    }
    this.tracerIdx = 0;

    // decals
    this.decalMax = 160;
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshStandardMaterial({
      map: TX.bulletHoleSprite(128), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.95, metalness: 0
    }), this.decalMax);
    this.decals.count = 0; this.decalIdx = 0; this.decals.frustumCulled = false; this.decals.receiveShadow = true;
    scene.add(this.decals);

    // shell casings
    this.shellMax = 40;
    const brass = new THREE.MeshStandardMaterial({ color: 0xc8963e, metalness: 1, roughness: 0.28 });
    const sg = new THREE.CylinderGeometry(0.009, 0.009, 0.045, 8); sg.rotateZ(Math.PI / 2);
    this.shellMesh = new THREE.InstancedMesh(sg, brass, this.shellMax);
    this.shellMesh.castShadow = false; this.shellMesh.frustumCulled = false;
    this.shells = Array.from({ length: this.shellMax }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0 }));
    this.shellIdx = 0;
    for (let i = 0; i < this.shellMax; i++) this.shellMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    scene.add(this.shellMesh);

    // muzzle flashes (world) + pooled flash lights. Light count is fixed so shaders never recompile.
    this.flashTex = TX.flashSprite(128);
    this.flashes = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.visible = false; scene.add(s); this.flashes.push({ s, life: 0 });
    }
    this.flashIdx = 0;
    this.lights = [];
    for (let i = 0; i < quality.flashLights; i++) {
      const l = new THREE.PointLight(0xffaa66, 0, 9, 2); scene.add(l); this.lights.push({ l, life: 0, max: 0.06, peak: 0 });
    }
    this.lightIdx = 0;

    // shockwave rings (death, scan)
    this.rings = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); this.rings.push({ m, life: 0, max: 1, r: 1 });
    }
    this.ringIdx = 0;

    // ambient dust motes (GPU animated)
    const N = quality.dust;
    if (N) {
      const p = new Float32Array(N * 3), seed = new Float32Array(N);
      for (let i = 0; i < N; i++) { p.set([(Math.random() - 0.5) * 54, Math.random() * 7, (Math.random() - 0.5) * 54], i * 3); seed[i] = Math.random(); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      this.dust = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: { time: { value: 0 }, map: { value: glowTex } },
        vertexShader: `attribute float seed; uniform float time; varying float vA;
          void main(){ vec3 p = position; float t = time * (0.15 + seed * 0.2) + seed * 50.0;
            p += vec3(sin(t)*0.8, sin(t*0.7+seed*9.0)*0.5, cos(t*0.8)*0.8);
            vec4 mv = modelViewMatrix * vec4(p,1.0); float d = -mv.z;
            vA = smoothstep(0.5, 3.0, d) * (1.0 - smoothstep(14.0, 26.0, d)) * (0.4 + 0.6 * sin(t*3.0)*sin(t*3.0));
            gl_PointSize = (2.0 + seed * 3.0) * 6.0 / max(d, 0.5); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: 'uniform sampler2D map; varying float vA; void main(){ float a = texture2D(map, gl_PointCoord).a * vA; gl_FragColor = vec4(vec3(0.7,0.8,1.0) * a * 0.9, 1.0); }',
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
      }));
      this.dust.frustumCulled = false; scene.add(this.dust);
    }
    this.vents = [[-10, -10], [10, 10], [-16, 6], [16, -6], [5, -22], [-5, 22]].map(([x, z]) => ({ x, z, t: Math.random() }));
    this.time = 0;
  }

  // ---------------------------------------------------------------- spawners
  flashLight(pos, color = 0xffaa66, peak = 14, life = 0.06) {
    if (!this.lights.length) return;
    const L = this.lights[this.lightIdx]; this.lightIdx = (this.lightIdx + 1) % this.lights.length;
    L.l.position.copy(pos); L.l.color.set(color); L.life = L.max = life; L.peak = peak;
  }
  muzzleFlash(pos, dir, color = 0xffb070, scale = 0.55) {
    const F = this.flashes[this.flashIdx]; this.flashIdx = (this.flashIdx + 1) % this.flashes.length;
    F.s.position.copy(pos); F.s.material.color.set(color).multiplyScalar(3); F.s.material.rotation = Math.random() * 6.28;
    F.s.scale.setScalar(scale * (0.8 + Math.random() * 0.4)); F.s.visible = true; F.life = 0.045;
    this.flashLight(pos, color, 16);
    for (let i = 0; i < 3; i++) this.smoke.spawn(pos.x + dir.x * 0.2, pos.y + dir.y * 0.2, pos.z + dir.z * 0.2, dir.x * 1.2 + rnd(0.3), dir.y * 1.2 + 0.3 + rnd(0.2), dir.z * 1.2 + rnd(0.3),
      { life: 0.7 + Math.random() * 0.4, size: 0.12, endSize: 0.6, alpha: 0.18, color: [0.6, 0.62, 0.68], drag: 2.5, spin: rnd(1) });
  }
  tracer(from, to, color = 0x7ff8ff) {
    const T = this.tracers[this.tracerIdx]; this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length;
    T.from.copy(from); T.to.copy(to); T.dist = from.distanceTo(to); T.travel = 0; T.life = 0.35;
    const c = new THREE.Color(color);
    T.bolt.material.color.copy(c).multiplyScalar(6); T.beam.material.color.copy(c).multiplyScalar(0.9);
    T.bolt.visible = T.beam.visible = true;
    T.beam.position.copy(from); T.beam.lookAt(to); T.beam.scale.set(0.006, 0.006, T.dist);
  }
  shell(pos, vel) {
    const S = this.shells[this.shellIdx]; this.shellIdx = (this.shellIdx + 1) % this.shellMax;
    S.p.copy(pos); S.v.copy(vel); S.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6); S.w.set(rnd(25), rnd(25), rnd(25)); S.life = 3.5; S.bounces = 0;
    return S;
  }
  decal(point, normal) {
    _v.set(normal[0], normal[1], normal[2]);
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _v);
    _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * 6.28));
    const s = 0.7 + Math.random() * 0.6;
    _m.compose(_s.set(point.x + _v.x * 0.004, point.y + _v.y * 0.004, point.z + _v.z * 0.004), _q, new THREE.Vector3(s, s, s));
    this.decals.setMatrixAt(this.decalIdx, _m);
    this.decalIdx = (this.decalIdx + 1) % this.decalMax;
    this.decals.count = Math.min(this.decalMax, this.decals.count + 1);
    this.decals.instanceMatrix.needsUpdate = true;
  }
  /** Bullet impact on world geometry. kind = Sim box kind or 'floor'. */
  impact(point, normal, kind) {
    const n = normal || [0, 1, 0];
    const nx = n[0], ny = n[1], nz = n[2];
    this.decal(point, n);
    const wet = kind === 'floor';
    const metal = !wet && kind !== 'perimeter';
    // hot glow at the hole
    this.glow.spawn(point.x + nx * 0.02, point.y + ny * 0.02, point.z + nz * 0.02, 0, 0, 0, { life: 0.35, size: 0.22, endSize: 0.05, color: [1.6, 0.8, 0.35] });
    const count = metal ? 14 : 7;
    for (let i = 0; i < count; i++) {
      const sp = 3 + Math.random() * 6;
      this.sparks.spawn(point.x, point.y, point.z, (nx + rnd(0.9)) * sp, (ny + rnd(0.9) + 0.3) * sp, (nz + rnd(0.9)) * sp, 0.25 + Math.random() * 0.45, [1, 0.62 + Math.random() * 0.2, 0.25]);
    }
    if (wet) {
      for (let i = 0; i < 10; i++) this.debris.spawn(point.x, 0.03, point.z, rnd(1.2), 1.5 + Math.random() * 2.2, rnd(1.2), { life: 0.5, size: 0.025, color: [0.5, 0.6, 0.75], gravity: 9.8, alpha: 0.7, bounce: false });
    } else {
      for (let i = 0; i < 6; i++) this.debris.spawn(point.x, point.y, point.z, (nx + rnd(0.8)) * 2.5, (ny + rnd(0.8)) * 2.5 + 1, (nz + rnd(0.8)) * 2.5, { life: 0.9, size: 0.02 + Math.random() * 0.02, color: metal ? [0.12, 0.12, 0.14] : [0.3, 0.3, 0.32], gravity: 9.8, bounce: true });
    }
    for (let i = 0; i < 2; i++) this.smoke.spawn(point.x + nx * 0.1, point.y + ny * 0.1, point.z + nz * 0.1, nx * 0.6 + rnd(0.2), ny * 0.6 + 0.25, nz * 0.6 + rnd(0.2),
      { life: 1.2 + Math.random() * 0.6, size: 0.15, endSize: 0.9, alpha: wet ? 0.12 : 0.22, color: [0.5, 0.52, 0.58], drag: 1.8, spin: rnd(0.8) });
  }
  /** Bullet hitting a player: energy burst in their colour. */
  playerHit(point, dir, color, head) {
    const c = new THREE.Color(color);
    const col = [c.r * 2, c.g * 2, c.b * 2];
    for (let i = 0; i < (head ? 22 : 12); i++) {
      const sp = 1.5 + Math.random() * 4;
      this.glow.spawn(point.x, point.y, point.z, (-dir.x + rnd(1)) * sp, (rnd(1) + 0.4) * sp, (-dir.z + rnd(1)) * sp, { life: 0.35 + Math.random() * 0.3, size: 0.06, endSize: 0.01, color: col, drag: 3, gravity: 3 });
    }
    for (let i = 0; i < 8; i++) this.sparks.spawn(point.x, point.y, point.z, (dir.x + rnd(1)) * 5, (dir.y + rnd(1)) * 5 + 1, (dir.z + rnd(1)) * 5, 0.3, [c.r, c.g, c.b]);
    this.glow.spawn(point.x, point.y, point.z, 0, 0, 0, { life: 0.15, size: head ? 0.9 : 0.55, endSize: 0.1, color: col });
  }
  /** Body dissolving into drifting embers and ash (souls-like). */
  embers(pos, color) {
    const c = new THREE.Color(color);
    for (let i = 0; i < 90; i++) {
      const warm = Math.random() < 0.65;
      const col = warm ? [2.4, 0.9 + Math.random() * 0.5, 0.25] : [c.r * 2.5, c.g * 2.5, c.b * 2.5];
      this.glow.spawn(pos.x + rnd(0.45), pos.y + Math.random() * 1.0, pos.z + rnd(0.7), rnd(0.35), 0.5 + Math.random() * 1.2, rnd(0.35),
        { life: 1.6 + Math.random() * 1.8, size: 0.025 + Math.random() * 0.035, endSize: 0, color: col, drag: 0.6, gravity: -0.25 });
    }
    for (let i = 0; i < 6; i++) this.smoke.spawn(pos.x + rnd(0.4), pos.y + Math.random() * 0.6, pos.z + rnd(0.6), rnd(0.2), 0.35, rnd(0.2),
      { life: 2.6, size: 0.35, endSize: 1.8, alpha: 0.2, color: [0.18, 0.16, 0.16], drag: 0.6, spin: rnd(0.4) });
    this.glow.spawn(pos.x, pos.y + 0.4, pos.z, 0, 0, 0, { life: 0.5, size: 1.6, endSize: 0.2, color: [1.6, 0.6, 0.2] });
  }
  death(pos, color) {
    const c = new THREE.Color(color), col = [c.r * 2.5, c.g * 2.5, c.b * 2.5];
    for (let i = 0; i < 35; i++) {
      const th = Math.random() * 6.28, ph = Math.random() * 3.14, sp = 2 + Math.random() * 6;
      this.glow.spawn(pos.x, pos.y + 1, pos.z, Math.cos(th) * Math.sin(ph) * sp, Math.cos(ph) * sp + 2, Math.sin(th) * Math.sin(ph) * sp, { life: 0.6 + Math.random() * 0.8, size: 0.09, endSize: 0, color: col, drag: 2, gravity: 4 });
    }
    for (let i = 0; i < 30; i++) this.sparks.spawn(pos.x, pos.y + 1, pos.z, rnd(8), Math.random() * 8, rnd(8), 0.6 + Math.random() * 0.5, [c.r, c.g, c.b]);
    for (let i = 0; i < 8; i++) this.smoke.spawn(pos.x + rnd(0.4), pos.y + 0.4 + Math.random() * 1.2, pos.z + rnd(0.4), rnd(0.6), 0.6, rnd(0.6), { life: 2, size: 0.4, endSize: 2, alpha: 0.25, color: [0.35, 0.36, 0.42], drag: 1, spin: rnd(0.5) });
    this.glow.spawn(pos.x, pos.y + 1, pos.z, 0, 0, 0, { life: 0.25, size: 1.8, endSize: 0.3, color: col });
    this.ring(pos, color, 4, 0.5);
    this.flashLight(_v.set(pos.x, pos.y + 1, pos.z), color, 60, 0.35);
  }
  ring(pos, color, radius, life) {
    const R = this.rings[this.ringIdx]; this.ringIdx = (this.ringIdx + 1) % this.rings.length;
    R.m.position.set(pos.x, 0.05, pos.z); R.m.material.color.set(color).multiplyScalar(3); R.life = R.max = life; R.r = radius; R.m.visible = true;
  }
  dashTrail(pos, color) {
    const c = new THREE.Color(color);
    for (let i = 0; i < 4; i++) this.glow.spawn(pos.x + rnd(0.3), pos.y + 0.3 + Math.random() * 1.3, pos.z + rnd(0.3), 0, 0.2, 0, { life: 0.35, size: 0.12, endSize: 0, color: [c.r * 2, c.g * 2, c.b * 2] });
  }
  footSplash(pos) {
    for (let i = 0; i < 4; i++) this.debris.spawn(pos.x + rnd(0.15), 0.03, pos.z + rnd(0.15), rnd(0.8), 0.8 + Math.random(), rnd(0.8), { life: 0.35, size: 0.018, color: [0.45, 0.55, 0.7], gravity: 9.8, alpha: 0.5 });
  }

  // ---------------------------------------------------------------- update
  update(dt, camera) {
    this.time += dt;
    this.glow.update(dt); this.smoke.update(dt); this.debris.update(dt); this.sparks.update(dt);
    for (const T of this.tracers) {
      if (T.life <= 0) continue;
      T.life -= dt;
      T.travel += dt * 320;
      const head = Math.min(T.dist, T.travel), tail = Math.max(0, head - 6);
      if (tail >= T.dist || T.life <= 0) { T.bolt.visible = false; }
      else {
        _v.subVectors(T.to, T.from).normalize();
        T.bolt.position.copy(T.from).addScaledVector(_v, tail);
        T.bolt.lookAt(T.to);
        T.bolt.scale.set(0.012, 0.012, Math.max(0.01, head - tail));
      }
      const a = Math.max(0, T.life / 0.35);
      T.beam.material.opacity = a * a * 0.5;
      if (T.life <= 0) { T.beam.visible = false; T.bolt.visible = false; }
    }
    for (const F of this.flashes) if (F.life > 0) { F.life -= dt; if (F.life <= 0) F.s.visible = false; }
    for (const L of this.lights) {
      if (L.life > 0) { L.life -= dt; L.l.intensity = Math.max(0, L.life / L.max) * L.peak; }
      else if (L.l.intensity !== 0) L.l.intensity = 0;
    }
    for (const R of this.rings) {
      if (R.life <= 0) continue;
      R.life -= dt; const k = 1 - R.life / R.max;
      const s = 0.2 + (1 - Math.pow(1 - k, 3)) * R.r; R.m.scale.set(s, s, s);
      R.m.material.opacity = Math.max(0, 1 - k);
      if (R.life <= 0) R.m.visible = false;
    }
    // shells: simple rigid-body-ish bounce on the floor and box tops
    for (let i = 0; i < this.shellMax; i++) {
      const S = this.shells[i];
      if (S.life <= 0) continue;
      S.life -= dt;
      S.v.y -= 9.8 * dt; S.p.addScaledVector(S.v, dt);
      const ground = groundHeight(S.p.x, S.p.z, S.p.y);
      if (S.p.y < ground + 0.01) {
        S.p.y = ground + 0.01;
        if (S.v.y < -0.6 && S.bounces < 3 && this.onShellBounce) this.onShellBounce(S.p, S.bounces);
        S.bounces++;
        S.v.y *= -0.35; S.v.x *= 0.55; S.v.z *= 0.55; S.w.multiplyScalar(0.5);
        if (Math.abs(S.v.y) < 0.3) { S.v.y = 0; S.w.set(0, S.w.y * 0.9, 0); S.r.x = 0; S.r.z = Math.PI / 2; }
      }
      S.r.x += S.w.x * dt; S.r.y += S.w.y * dt; S.r.z += S.w.z * dt;
      const sc = S.life < 0.5 ? S.life * 2 : 1;
      _m.compose(S.p, _q.setFromEuler(S.r), _s.set(sc, sc, sc));
      this.shellMesh.setMatrixAt(i, _m);
      if (S.life <= 0) this.shellMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    this.shellMesh.instanceMatrix.needsUpdate = true;
    // steam vents
    for (const V of this.vents) {
      V.t -= dt;
      if (V.t <= 0) { V.t = 0.12 + Math.random() * 0.1; this.smoke.spawn(V.x + rnd(0.4), 0.05, V.z + rnd(0.2), rnd(0.15), 0.6 + Math.random() * 0.5, rnd(0.15), { life: 3 + Math.random(), size: 0.3, endSize: 2.2, alpha: 0.1, color: [0.55, 0.6, 0.7], drag: 0.4, spin: rnd(0.3) }); }
    }
    // rain splashes around the camera
    if (this.Q.rain) {
      const n = Math.round(this.Q.rain / 250);
      for (let i = 0; i < n; i++) {
        const x = camera.position.x + rnd(16), z = camera.position.z + rnd(16);
        const y = groundHeight(x, z, 30);
        this.debris.spawn(x, y + 0.02, z, rnd(0.5), 0.6 + Math.random() * 0.6, rnd(0.5), { life: 0.22, size: 0.012, color: [0.55, 0.65, 0.8], gravity: 9.8, alpha: 0.45 });
      }
    }
    if (this.dust) this.dust.material.uniforms.time.value = this.time;
  }
}
const rnd = s => (Math.random() * 2 - 1) * s;
/** Height of the highest walkable surface under (x,z) that is below y. */
export function groundHeight(x, z, y) {
  let g = 0;
  for (const b of Sim.boxes) {
    if (x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2] && b.max[1] <= y + 0.05 && b.max[1] > g) g = b.max[1];
  }
  return g;
}

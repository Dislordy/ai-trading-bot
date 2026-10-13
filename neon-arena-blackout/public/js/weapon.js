// First-person energy rifle: detailed PBR model, arms, recoil springs, sway, bob,
// aim-down-sights, keyframed reload, muzzle flash and an on-gun ammo display.
import * as THREE from 'three';
import * as TX from './textures.js';
import { buildRifle } from './gunmodel.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const Sim = window.NeonSim;

class Spring {
  constructor(k = 180, c = 18) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
  kick(v) { this.v += v; }
  update(dt) {
    // fixed sub-steps keep the spring stable at any frame rate
    const n = Math.ceil(dt / 0.004), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (-this.k * this.x - this.c * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
}
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * (3 - 2 * t);
const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));

export class Weapon {
  constructor(envMap) {
    this.scene = new THREE.Scene();
    this.scene.environment = envMap;
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 10);
    this.camera.userData.noReflect = true;

    // viewmodel lighting
    this.scene.add(new THREE.HemisphereLight(0x7a8cc0, 0x1a1024, 2.2));
    const key = new THREE.DirectionalLight(0xd0dcff, 3.2); key.position.set(1, 2, 0.6); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff3dc8, 2.6); rim.position.set(-2, 0.8, -1); this.scene.add(rim);
    const rim2 = new THREE.DirectionalLight(0x00e5ff, 2.2); rim2.position.set(2, -0.2, -1.5); this.scene.add(rim2);
    this.flashLight = new THREE.PointLight(0xffb070, 0, 2.5, 2); this.scene.add(this.flashLight);

    this.root = new THREE.Group(); this.scene.add(this.root);   // sway/bob/recoil applied here
    this.gun = new THREE.Group(); this.root.add(this.gun);
    this.buildRifle();
    this.buildArms();

    this.recoilZ = new Spring(220, 22); this.recoilRot = new Spring(160, 16); this.recoilYaw = new Spring(140, 14); this.recoilRoll = new Spring(120, 12);
    this.landY = new Spring(120, 14);
    this.swayX = 0; this.swayY = 0; this.bobPhase = 0; this.bobAmt = 0;
    this.aim = 0; this.equip = 0; this.flash = 0; this.lowerT = 0;
    this.hip = new THREE.Vector3(0.15, -0.17, -0.46);
    this.ads = new THREE.Vector3(0, -this.sightY, -0.3);
    this.reloadT = -1; this.lastAmmo = -1; this.inspectT = -1; this.heat = 0;
    this.events = {}; // callbacks for reload sound cues
  }

  buildRifle() {
    this.energyMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00f5ff).multiplyScalar(2.2) });
    const rifle = buildRifle({ energy: this.energyMat });
    const G = this.gun;
    G.add(rifle.group);
    const metal = rifle.mats.metal;
    const box = (w, h, d, m, x, y, z, rx = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.x = rx; G.add(o); return o; };
    this.muzzle = rifle.muzzle; this.mag = rifle.mag; this.magHome = rifle.magHome;
    this.handle = rifle.handle; this.handleHome = rifle.handleHome; this.coils = rifle.coils; this.cell = rifle.cell;
    // dangling charm on the sling point: a little neon skull on a chain (simple pendulum)
    this.charm = new THREE.Group(); rifle.charmPivot.add(this.charm);
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 0.045, 4), rifle.mats.chrome); chain.position.y = -0.0225; this.charm.add(chain);
    const skull = new THREE.Group(); skull.position.y = -0.052; this.charm.add(skull);
    const charmGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2fb9).multiplyScalar(2.5) });
    skull.add(new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), charmGlow));
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.008), charmGlow); jaw.position.y = -0.008; skull.add(jaw);
    this.charmAng = new THREE.Vector2(); this.charmVel = new THREE.Vector2(); this.prevRootPos = new THREE.Vector3();
    // holographic sight
    this.sightY = 0.088;
    box(0.008, 0.05, 0.05, metal, -0.026, 0.078, -0.03); box(0.008, 0.05, 0.05, metal, 0.026, 0.078, -0.03);
    box(0.06, 0.008, 0.05, metal, 0, 0.104, -0.03);
    box(0.06, 0.02, 0.07, metal, 0, 0.062, -0.03);
    const rc = document.createElement('canvas'); rc.width = rc.height = 128;
    const rx = rc.getContext('2d'); rx.strokeStyle = '#ff2fb9'; rx.fillStyle = '#ff2fb9'; rx.shadowColor = '#ff2fb9'; rx.shadowBlur = 8; rx.lineWidth = 5;
    rx.beginPath(); rx.arc(64, 64, 40, 0, Math.PI * 2); rx.stroke(); rx.beginPath(); rx.arc(64, 64, 6, 0, Math.PI * 2); rx.fill();
    for (const a of [0, 1, 2, 3]) { rx.save(); rx.translate(64, 64); rx.rotate(a * Math.PI / 2); rx.fillRect(-2, -58, 4, 12); rx.restore(); }
    const rtex = new THREE.CanvasTexture(rc); rtex.colorSpace = THREE.SRGBColorSpace;
    this.reticle = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.045), new THREE.MeshBasicMaterial({ map: rtex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(2, 2, 2) }));
    this.reticle.position.set(0, this.sightY, -0.04); G.add(this.reticle);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.046, 0.04), new THREE.MeshPhysicalMaterial({ color: 0x66ffee, transparent: true, opacity: 0.12, roughness: 0, metalness: 0, clearcoat: 1, envMapIntensity: 2 }));
    glass.position.set(0, 0.08, -0.05); G.add(glass);
    // on-gun ammo display
    this.ammoCanvas = document.createElement('canvas'); this.ammoCanvas.width = 128; this.ammoCanvas.height = 64;
    this.ammoTex = new THREE.CanvasTexture(this.ammoCanvas); this.ammoTex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.03), new THREE.MeshBasicMaterial({ map: this.ammoTex, color: new THREE.Color(2.2, 2.2, 2.2), transparent: true }));
    disp.position.set(-0.0362, 0.02, 0.05); disp.rotation.y = -Math.PI / 2; G.add(disp);
    // muzzle flash: crossed planes + front sprite
    const ft = TX.flashSprite(256);
    const fm = new THREE.MeshBasicMaterial({ map: ft, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(4, 3, 2.2) });
    this.flashGroup = new THREE.Group(); this.flashGroup.position.copy(this.muzzle.position); G.add(this.flashGroup);
    for (const r of [0, Math.PI / 2]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.36), fm); p.rotation.set(Math.PI / 2, r, 0); p.position.z = -0.14; this.flashGroup.add(p); }
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), fm); front.position.z = -0.02; this.flashGroup.add(front);
    this.flashFront = front;
    this.flashGroup.visible = false;
    this.ejectPort = rifle.ejectPort;
    G.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  }

  buildArms() {
    // Right: chrome cyberware forearm with glowing seams. Left: a battered plate gauntlet over cloth wraps.
    const chrome = new THREE.MeshStandardMaterial({ color: 0xc9d2e0, roughness: 0.12, metalness: 1, envMapIntensity: 2.6 });
    const chromeDark = new THREE.MeshStandardMaterial({ color: 0x8a94a6, roughness: 0.2, metalness: 1, envMapIntensity: 2.2 });
    const glowStrip = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5f56).multiplyScalar(3) });
    const pm = TX.armorPlateMaps(256, [0.16, 0.16, 0.18]);
    const plate = new THREE.MeshStandardMaterial({ map: pm.map, normalMap: pm.normalMap, roughnessMap: pm.roughnessMap, metalnessMap: pm.metalnessMap, roughness: 1, metalness: 1, envMapIntensity: 1.6 });
    const cm = TX.clothMaps(128, [0.11, 0.09, 0.08]);
    const wrap = new THREE.MeshStandardMaterial({ map: cm.map, normalMap: cm.normalMap, roughness: 0.95, metalness: 0 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.7, metalness: 0 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xb8892e, roughness: 0.3, metalness: 1, envMapIntensity: 2 });
    const mesh = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); return m; };
    const fingers = (g, mat) => {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) g.add(mesh(new RoundedBoxGeometry(0.011, 0.012, 0.022, 2, 0.003), mat, -0.018 + i * 0.012, -0.012 - j * 0.014, -0.05 - j * 0.012, 0.5 + j * 0.5));
      g.add(mesh(new RoundedBoxGeometry(0.012, 0.012, 0.03, 2, 0.003), mat, 0.03, -0.005, -0.03, 0.2, -0.5));
    };
    const cyberArm = () => {
      const g = new THREE.Group();
      g.add(mesh(new RoundedBoxGeometry(0.055, 0.04, 0.08, 3, 0.012), chromeDark, 0, 0, 0));
      fingers(g, chrome);
      g.add(mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.32, 16), chrome, 0, 0, 0.2, Math.PI / 2));
      g.add(mesh(new RoundedBoxGeometry(0.075, 0.03, 0.18, 2, 0.01), chromeDark, 0, 0.035, 0.16));
      g.add(mesh(new THREE.BoxGeometry(0.006, 0.006, 0.14), glowStrip, 0, 0.052, 0.16));
      for (const [ang, z] of [[0.9, 0.12], [-0.9, 0.22], [2.4, 0.3]]) g.add(mesh(new THREE.BoxGeometry(0.004, 0.004, 0.09), glowStrip, Math.sin(ang) * 0.042, Math.cos(ang) * 0.042 - 0.005, z));
      g.add(mesh(new THREE.TorusGeometry(0.04, 0.004, 6, 20), glowStrip, 0, 0, 0.06));
      // exposed hydraulic pistons along the underside
      for (const sx of [-0.018, 0.018]) g.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 6), chrome, sx, -0.04, 0.2, Math.PI / 2));
      return g;
    };
    const gauntlet = () => {
      const g = new THREE.Group();
      g.add(mesh(new RoundedBoxGeometry(0.058, 0.042, 0.08, 3, 0.012), plate, 0, 0, 0));
      fingers(g, plate);
      g.add(mesh(new THREE.CylinderGeometry(0.036, 0.044, 0.32, 14), wrap, 0, 0, 0.2, Math.PI / 2));
      // overlapping lames up the forearm with a gilded edge
      for (let i = 0; i < 4; i++) {
        const l = mesh(new RoundedBoxGeometry(0.086 - i * 0.002, 0.034, 0.06, 2, 0.012), plate, 0, 0.022, 0.06 + i * 0.05, -0.08);
        g.add(l);
        g.add(mesh(new THREE.BoxGeometry(0.08, 0.004, 0.006), gold, 0, 0.04, 0.032 + i * 0.05));
      }
      for (const z of [0.1, 0.24]) g.add(mesh(new THREE.TorusGeometry(0.046, 0.006, 6, 18), leather, 0, 0, z));
      return g;
    };
    const finish = g => { g.traverse(o => { if (o.isMesh) o.frustumCulled = false; }); return g; };
    this.rightArm = finish(cyberArm()); this.rightArm.position.set(0.0, -0.09, 0.08); this.rightArm.rotation.set(0.35, 0.25, 0); this.gun.add(this.rightArm);
    this.leftArm = finish(gauntlet()); this.leftHome = new THREE.Vector3(-0.005, -0.045, -0.36); this.leftArm.position.copy(this.leftHome);
    this.leftArm.rotation.set(0.25, -0.55, 0.3); this.leftHomeRot = this.leftArm.rotation.clone(); this.gun.add(this.leftArm);
  }

  drawAmmo(ammo, reloading) {
    const c = this.ammoCanvas.getContext('2d');
    c.clearRect(0, 0, 128, 64);
    c.fillStyle = 'rgba(0,20,30,.85)'; c.fillRect(0, 0, 128, 64);
    const low = ammo <= 6;
    c.fillStyle = reloading ? '#ffa23a' : low ? '#ff3b6b' : '#00f5ff';
    c.font = '700 40px Orbitron, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(reloading ? '--' : String(ammo).padStart(2, '0'), 64, 34);
    this.ammoTex.needsUpdate = true;
    const k = reloading ? 0.5 : low ? 1.8 : 2.2;
    this.energyBase = new THREE.Color(low && !reloading ? 0xff3b6b : 0x00f5ff).multiplyScalar(k);
  }

  fire(aiming) {
    const k = aiming ? 0.55 : 1;
    this.recoilZ.kick(1.6 * k);
    this.recoilRot.kick((5 + Math.random() * 2) * k);
    this.recoilYaw.kick((Math.random() - 0.5) * 3 * k);
    this.recoilRoll.kick((Math.random() - 0.5) * 6 * k);
    this.flash = 0.05;
    this.flashGroup.visible = true;
    this.flashGroup.rotation.z = Math.random() * Math.PI;
    this.flashGroup.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flashLight.intensity = 3;
    this.heat = Math.min(1.5, (this.heat || 0) + 0.45);
    this.inspectT = -1;
  }
  /** Weapon inspect (F): turn the rifle over to admire it. */
  inspect() { if (this.inspectT < 0 && this.reloadT < 0 && this.aim < 0.2) this.inspectT = 0; }
  land(strength) { this.landY.kick(-Math.min(1.5, strength) * 0.6); }
  respawn() { this.equip = 0; }

  /** World-space position of the muzzle, mapped from viewmodel space into the main camera. */
  muzzleWorld(mainCamera, out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(out); // in viewmodel camera space (vm camera sits at the origin)
    return mainCamera.localToWorld(out);
  }
  ejectWorld(mainCamera, out = new THREE.Vector3()) {
    this.ejectPort.getWorldPosition(out);
    return mainCamera.localToWorld(out);
  }

  /**
   * s: { dt, moveSpeed, grounded, aiming, mouseDX, mouseDY, reloadTicks, ammo, alive, dashing }
   */
  update(s) {
    const dt = s.dt;
    // ammo display
    const reloading = s.reloadTicks > 0;
    const key = s.ammo * 2 + (reloading ? 1 : 0);
    if (key !== this.lastAmmo) { this.lastAmmo = key; this.drawAmmo(s.ammo, reloading); }

    this.aim = lerp(this.aim, s.aiming && !reloading && s.alive ? 1 : 0, 1 - Math.exp(-dt * 14));
    this.equip = Math.min(1, this.equip + dt * 2.2);
    this.lowerT = lerp(this.lowerT, s.alive ? 0 : 1, 1 - Math.exp(-dt * 6));
    const aimK = 1 - this.aim * 0.85;

    // sway: weapon lags behind mouse motion
    this.swayX = lerp(this.swayX, THREE.MathUtils.clamp(-s.mouseDX * 0.0009, -0.05, 0.05) * aimK, 1 - Math.exp(-dt * 10));
    this.swayY = lerp(this.swayY, THREE.MathUtils.clamp(s.mouseDY * 0.0009, -0.05, 0.05) * aimK, 1 - Math.exp(-dt * 10));
    // bob
    const speedK = Math.min(1, s.moveSpeed / Sim.MOVE_SPEED) * (s.grounded ? 1 : 0.15);
    this.bobAmt = lerp(this.bobAmt, speedK, 1 - Math.exp(-dt * 8));
    this.bobPhase += dt * (6 + s.moveSpeed * 0.9);
    const bobX = Math.sin(this.bobPhase) * 0.011 * this.bobAmt * aimK;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.009 * this.bobAmt * aimK;
    const idle = Math.sin(performance.now() * 0.0012) * 0.0025 * aimK;

    const rz = this.recoilZ.update(dt), rr = this.recoilRot.update(dt), ry = this.recoilYaw.update(dt), rl = this.recoilRoll.update(dt), ly = this.landY.update(dt);

    // reload keyframes (synced to the simulation's reload timer)
    let rlT = -1;
    if (reloading) rlT = 1 - s.reloadTicks / Sim.RELOAD_TICKS;
    this.animateReload(rlT);

    const base = new THREE.Vector3().lerpVectors(this.hip, this.ads, ease(this.aim));
    const tiltIn = rlT >= 0 ? ease(seg(rlT, 0, 0.15)) * (1 - ease(seg(rlT, 0.82, 1))) : 0;
    const dashTilt = s.dashing ? 1 : 0;
    this.dashT = lerp(this.dashT || 0, dashTilt, 1 - Math.exp(-dt * 12));
    this.root.position.set(
      base.x + bobX + this.swayX * 0.6,
      base.y + bobY + idle + ly * 0.05 - (1 - ease(this.equip)) * 0.3 - this.lowerT * 0.4 - tiltIn * 0.03,
      base.z + rz * 0.035 * (1 - this.aim * 0.4)
    );
    this.root.rotation.set(
      rr * 0.035 + this.swayY + tiltIn * 0.35 - (1 - ease(this.equip)) * 0.6 + this.dashT * 0.1,
      ry * 0.02 + this.swayX + tiltIn * 0.25,
      rl * 0.01 + bobX * 1.5 + tiltIn * 0.55 - this.dashT * 0.25
    );
    // inspect animation: keyframed pose offsets, cancelled by aiming, reloading or dying
    if (this.inspectT >= 0) {
      if (reloading || s.aiming || !s.alive) this.inspectT = -1;
      else {
        this.inspectT += dt / 2.6;
        const K = [[0, [0, 0, 0, 0, 0, 0]], [0.18, [-0.1, 0.06, 0.1, 0.15, 1.0, 0.45]], [0.48, [-0.1, 0.07, 0.1, 0.2, 1.1, 0.5]],
          [0.66, [0.0, 0.07, 0.08, 0.1, -0.7, -0.55]], [0.86, [0.0, 0.06, 0.08, 0.05, -0.75, -0.5]], [1, [0, 0, 0, 0, 0, 0]]];
        const t = Math.min(1, this.inspectT);
        let i = 0; while (i < K.length - 2 && t > K[i + 1][0]) i++;
        const k = ease(seg(t, K[i][0], K[i + 1][0])), a = K[i][1], b = K[i + 1][1], v = a.map((x, j) => lerp(x, b[j], k));
        this.root.position.x += v[0]; this.root.position.y += v[1]; this.root.position.z += v[2];
        this.root.rotation.x += v[3]; this.root.rotation.y += v[4]; this.root.rotation.z += v[5];
        if (this.inspectT >= 1) this.inspectT = -1;
      }
    }
    // charm pendulum: hangs "down" in view space and swings with the rifle's motion
    const vel = this.root.position.clone().sub(this.prevRootPos).divideScalar(Math.max(dt, 1e-3));
    this.prevRootPos.copy(this.root.position);
    const n = Math.ceil(dt / 0.004), h = dt / n;
    for (let j = 0; j < n; j++) {
      this.charmVel.x += (-60 * Math.sin(this.charmAng.x) - 3 * this.charmVel.x) * h;
      this.charmVel.y += (-60 * Math.sin(this.charmAng.y) - 3 * this.charmVel.y) * h;
      this.charmAng.x += this.charmVel.x * h; this.charmAng.y += this.charmVel.y * h;
    }
    if (this.lastVel) { this.charmVel.x += (vel.z - this.lastVel.z) * 1.5; this.charmVel.y -= (vel.x - this.lastVel.x) * 1.5; }
    this.lastVel = vel;
    this.charm.rotation.set(-this.root.rotation.x + this.charmAng.x, 0, -this.root.rotation.z + this.charmAng.y);
    // plasma coils run hotter while firing, with a travelling pulse down the barrel
    this.heat = Math.max(0, this.heat - dt * 1.6);
    if (this.energyBase) this.energyMat.color.copy(this.energyBase).multiplyScalar(1 + this.heat * 1.4 + Math.sin(performance.now() * 0.004) * 0.08);
    const tt = performance.now() * 0.012;
    this.coils.forEach((c, j) => { const p = 1 + Math.max(0, Math.sin(tt - j * 0.9)) * 0.12 * (0.3 + this.heat); c.scale.set(p, p, 1); });
    // muzzle flash decay
    if (this.flash > 0) {
      this.flash -= dt;
      this.flashFront.material.opacity = 1;
      if (this.flash <= 0) this.flashGroup.visible = false;
    }
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 70);
    this.flashLight.position.set(this.root.position.x, this.root.position.y + 0.05, this.root.position.z - 0.6);
    this.reticle.material.opacity = 0.3 + this.aim * 0.7;
    this.root.visible = this.lowerT < 0.97;
    // FOV for ADS (viewmodel camera)
    this.camera.fov = lerp(60, 48, this.aim); this.camera.updateProjectionMatrix();
  }

  animateReload(t) {
    if (t < 0) {
      this.mag.position.copy(this.magHome); this.mag.rotation.set(0, 0, 0); this.mag.visible = true;
      this.leftArm.position.lerp(this.leftHome, 0.35); this.leftArm.rotation.set(
        lerp(this.leftArm.rotation.x, this.leftHomeRot.x, 0.35), lerp(this.leftArm.rotation.y, this.leftHomeRot.y, 0.35), lerp(this.leftArm.rotation.z, this.leftHomeRot.z, 0.35));
      this.handle.position.copy(this.handleHome);
      this.reloadT = -1;
      return;
    }
    const prev = this.reloadT; this.reloadT = t;
    const cue = (at, name) => { if (prev < at && t >= at && this.events[name]) this.events[name](); };
    cue(0.0001, 'start'); cue(0.22, 'magOut'); cue(0.62, 'magIn'); cue(0.8, 'charge');
    // 0.00-0.15 tilt (root), 0.15-0.35 hand to mag & pull out, 0.35-0.5 mag gone, 0.5-0.65 new mag in, 0.7-0.85 charge handle
    const out = ease(seg(t, 0.16, 0.34)), back = ease(seg(t, 0.44, 0.62));
    const magDrop = out * (1 - back);
    this.mag.position.set(this.magHome.x, this.magHome.y - magDrop * 0.35, this.magHome.z + magDrop * 0.05);
    this.mag.rotation.set(-magDrop * 0.4, 0, magDrop * 0.3);
    this.mag.visible = !(t > 0.34 && t < 0.44);
    // left hand travels to the magazine well and back
    const toMag = ease(seg(t, 0.08, 0.2)) * (1 - ease(seg(t, 0.64, 0.74)));
    const handTarget = new THREE.Vector3(this.mag.position.x - 0.01, this.mag.position.y - 0.1, this.mag.position.z + 0.02);
    this.leftArm.position.lerpVectors(this.leftHome, handTarget, toMag);
    this.leftArm.rotation.set(lerp(this.leftHomeRot.x, -0.2, toMag), lerp(this.leftHomeRot.y, -0.2, toMag), lerp(this.leftHomeRot.z, 0.6, toMag));
    // charging handle
    const pull = seg(t, 0.78, 0.84) * (1 - seg(t, 0.84, 0.9));
    this.handle.position.set(this.handleHome.x, this.handleHome.y, this.handleHome.z + pull * 0.06);
  }

  setSize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
}

// First-person energy rifle: detailed PBR model, arms, recoil springs, sway, bob,
// aim-down-sights, keyframed reload, muzzle flash and an on-gun ammo display.
import * as THREE from 'three';
import * as TX from './textures.js';

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
    this.reloadT = -1; this.lastAmmo = -1;
    this.events = {}; // callbacks for reload sound cues
  }

  buildRifle() {
    const gm = TX.gunMetalMaps(256);
    const metal = new THREE.MeshStandardMaterial({ map: gm.map, roughnessMap: gm.roughnessMap, metalnessMap: gm.metalnessMap, normalMap: gm.normalMap, roughness: 1, metalness: 1, envMapIntensity: 2.2 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.55, metalness: 0.05, envMapIntensity: 1.2 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x55657a, roughness: 0.28, metalness: 0.9, envMapIntensity: 2.4 });
    this.energyMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00f5ff).multiplyScalar(2.2) });
    const G = this.gun;
    const box = (w, h, d, m, x, y, z, rx = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.x = rx; G.add(o); return o; };
    const cyl = (r, l, m, x, y, z, seg = 16) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, seg), m); o.rotation.x = Math.PI / 2; o.position.set(x, y, z); G.add(o); return o; };
    // receiver & body
    box(0.07, 0.085, 0.36, metal, 0, 0, -0.05);
    box(0.074, 0.03, 0.3, accent, 0, -0.045, -0.06);
    box(0.04, 0.014, 0.32, metal, 0, 0.05, -0.06);
    for (let i = 0; i < 9; i++) box(0.046, 0.006, 0.012, metal, 0, 0.06, -0.19 + i * 0.03);
    // handguard with vents and energy channels
    box(0.066, 0.072, 0.27, polymer, 0, -0.005, -0.35);
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) box(0.004, 0.012, 0.03, accent, s * 0.034, 0.012, -0.27 - i * 0.045);
    for (const s of [-1, 1]) box(0.003, 0.008, 0.22, this.energyMat, s * 0.0345, -0.018, -0.35);
    // barrel + muzzle brake
    cyl(0.013, 0.22, metal, 0, 0.008, -0.56);
    cyl(0.022, 0.07, accent, 0, 0.008, -0.69, 8);
    for (let i = 0; i < 3; i++) box(0.05, 0.004, 0.008, this.energyMat, 0, 0.008, -0.665 - i * 0.02);
    this.muzzle = new THREE.Object3D(); this.muzzle.position.set(0, 0.008, -0.74); G.add(this.muzzle);
    // grip, trigger guard, stock
    box(0.036, 0.11, 0.05, polymer, 0, -0.085, 0.075, -0.32);
    box(0.012, 0.035, 0.06, metal, 0, -0.06, 0.0);
    box(0.05, 0.075, 0.2, polymer, 0, -0.012, 0.25);
    box(0.054, 0.09, 0.025, accent, 0, -0.016, 0.36);
    box(0.03, 0.02, 0.15, metal, 0, 0.03, 0.2);
    // magazine (separate group for the reload animation)
    this.mag = new THREE.Group(); this.mag.position.set(0, -0.06, -0.12); G.add(this.mag);
    this.magHome = this.mag.position.clone();
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.15, 0.075), polymer); mag.position.y = -0.07; mag.rotation.x = 0.12; this.mag.add(mag);
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 0.012), this.energyMat); cell.position.set(0, -0.07, 0.01); cell.rotation.x = 0.12; this.mag.add(cell);
    // charging handle
    this.handle = box(0.03, 0.012, 0.03, accent, 0.045, 0.03, 0.08);
    this.handleHome = this.handle.position.clone();
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
    disp.position.set(-0.0365, 0.005, -0.08); disp.rotation.y = -Math.PI / 2; G.add(disp);
    // muzzle flash: crossed planes + front sprite
    const ft = TX.flashSprite(256);
    const fm = new THREE.MeshBasicMaterial({ map: ft, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(4, 3, 2.2) });
    this.flashGroup = new THREE.Group(); this.flashGroup.position.copy(this.muzzle.position); G.add(this.flashGroup);
    for (const r of [0, Math.PI / 2]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.36), fm); p.rotation.set(Math.PI / 2, r, 0); p.position.z = -0.14; this.flashGroup.add(p); }
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), fm); front.position.z = -0.02; this.flashGroup.add(front);
    this.flashFront = front;
    this.flashGroup.visible = false;
    this.ejectPort = new THREE.Object3D(); this.ejectPort.position.set(0.04, 0.02, -0.02); G.add(this.ejectPort);
    G.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  }

  buildArms() {
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x323846, roughness: 0.8, metalness: 0.0 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x56637a, roughness: 0.32, metalness: 0.85, envMapIntensity: 2 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.7, metalness: 0.1 });
    const glowStrip = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00f5ff).multiplyScalar(3) });
    const makeArm = () => {
      const g = new THREE.Group();
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.045, 0.09), glove); g.add(hand);
      const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.05), glove); fingers.position.set(0, -0.02, -0.04); fingers.rotation.x = 0.6; g.add(fingers);
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.32, 12), sleeve); fore.rotation.x = Math.PI / 2; fore.position.z = 0.2; g.add(fore);
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, 0.18), armor); guard.position.set(0, 0.035, 0.16); g.add(guard);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.14), glowStrip); strip.position.set(0, 0.052, 0.16); g.add(strip);
      g.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
      return g;
    };
    this.rightArm = makeArm(); this.rightArm.position.set(0.0, -0.09, 0.08); this.rightArm.rotation.set(0.35, 0.25, 0); this.gun.add(this.rightArm);
    this.leftArm = makeArm(); this.leftHome = new THREE.Vector3(-0.005, -0.045, -0.36); this.leftArm.position.copy(this.leftHome);
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
    this.energyMat.color.set(low && !reloading ? 0xff3b6b : 0x00f5ff).multiplyScalar(k);
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
  }
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

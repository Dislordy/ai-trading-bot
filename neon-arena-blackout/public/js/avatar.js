// Third-person player avatars: articulated armoured runner with procedural
// walk/strafe/jump animation, aim pitch, rifle, shield bubble, x-ray scan ghost and name tag.
import * as THREE from 'three';
import * as TX from './textures.js';

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  const panel = TX.metalPanelMaps(256, [0.16, 0.18, 0.22]);
  shared = {
    armor: new THREE.MeshStandardMaterial({ map: panel.map, normalMap: panel.normalMap, roughnessMap: panel.roughnessMap, metalnessMap: panel.metalnessMap, color: 0xb8c4dc, roughness: 0.8, metalness: 0.85, envMapIntensity: 1.8 }),
    suit: new THREE.MeshStandardMaterial({ color: 0x2a2e3a, roughness: 0.75, metalness: 0.05 }),
    joint: new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.5, metalness: 0.6 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.35, metalness: 0.9, envMapIntensity: 1.3 }),
    visorGlass: new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.05, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2 }),
    xray: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xb6ff4a).multiplyScalar(1.5), transparent: true, opacity: 0.55, depthTest: false, depthWrite: false })
  };
  return shared;
}

const shieldShader = color => new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(color) }, time: { value: 0 }, strength: { value: 0 } },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position,1.0); vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 color; uniform float time; uniform float strength; varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main(){
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
      vec2 h = vec2(atan(vP.z, vP.x) * 6.0, vP.y * 12.0);
      vec2 g = abs(fract(h + vec2(0.0, time * 0.5)) - 0.5);
      float hex = smoothstep(0.42, 0.48, max(g.x, g.y));
      float scan = 0.5 + 0.5 * sin(vP.y * 20.0 - time * 6.0);
      float a = (f * 1.4 + hex * 0.35 * f + scan * 0.05) * strength;
      gl_FragColor = vec4(color * a * 2.5, 1.0);
    }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
});

function nameSprite(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.font = '700 30px Rajdhani, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = color; x.shadowBlur = 10; x.fillStyle = '#ffffff'; x.fillText(name.toUpperCase(), 128, 30);
  x.fillStyle = color; x.fillRect(78, 52, 100, 3);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(1.3, 0.325, 1);
  return s;
}

export class Avatar {
  constructor(color, name) {
    const S0 = sharedAssets();
    this.color = new THREE.Color(color);
    // Each runner gets armour with a subtle fresnel rim in their colour so they read against the dark arena.
    const rimColor = this.color.clone().multiplyScalar(0.9);
    const withRim = m => { const c = m.clone(); c.onBeforeCompile = sh => {
      sh.uniforms.rimColor = { value: rimColor };
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 rimColor;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += rimColor * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );');
    }; c.customProgramCacheKey = () => 'rim'; return c; };
    this.rimMats = [withRim(S0.armor), withRim(S0.suit)];
    const S = Object.assign({}, S0, { armor: this.rimMats[0], suit: this.rimMats[1] });
    this.glow = new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(3) });
    this.glowSoft = new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(1.4) });
    const g = this.group = new THREE.Group();
    const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const cyl = (r0, r1, h, s = 10) => new THREE.CylinderGeometry(r0, r1, h, s);

    // hips + legs
    this.hips = new THREE.Group(); this.hips.position.y = 0.95; g.add(this.hips);
    add(this.hips, box(0.36, 0.16, 0.22), S.armor, 0, 0, 0);
    add(this.hips, box(0.38, 0.03, 0.235), this.glowSoft, 0, 0.06, 0);
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(side * 0.11, -0.05, 0); this.hips.add(hip);
      add(hip, cyl(0.085, 0.07, 0.44), S.suit, 0, -0.22, 0);
      add(hip, box(0.13, 0.22, 0.1), S.armor, 0, -0.16, -0.06);
      const knee = new THREE.Group(); knee.position.y = -0.44; hip.add(knee);
      add(knee, new THREE.SphereGeometry(0.07, 10, 8), S.joint, 0, 0, 0);
      add(knee, cyl(0.07, 0.055, 0.42), S.suit, 0, -0.21, 0);
      add(knee, box(0.1, 0.26, 0.06), S.armor, 0, -0.17, -0.06);
      add(knee, box(0.015, 0.16, 0.012), this.glow, side * 0.045, -0.17, -0.095);
      add(knee, box(0.12, 0.08, 0.24), S.joint, 0, -0.44, -0.04);
      this.legs.push({ hip, knee });
    }
    // torso (pitches with aim)
    this.torso = new THREE.Group(); this.torso.position.y = 0.06; this.hips.add(this.torso);
    add(this.torso, box(0.4, 0.42, 0.24), S.suit, 0, 0.26, 0);
    add(this.torso, box(0.44, 0.3, 0.1), S.armor, 0, 0.32, -0.12, 0.08);
    add(this.torso, box(0.3, 0.025, 0.02), this.glow, 0, 0.34, -0.175);
    add(this.torso, box(0.025, 0.2, 0.02), this.glow, 0, 0.18, -0.165);
    const pack = add(this.torso, box(0.32, 0.36, 0.14), S.armor, 0, 0.3, 0.17);
    add(this.torso, cyl(0.05, 0.05, 0.3, 12), this.glow, 0, 0.3, 0.25);
    for (const side of [-1, 1]) add(this.torso, box(0.16, 0.08, 0.26), S.armor, side * 0.27, 0.48, 0, 0, 0, side * -0.3);
    // head
    this.head = new THREE.Group(); this.head.position.y = 0.58; this.torso.add(this.head);
    add(this.head, cyl(0.06, 0.07, 0.08), S.joint, 0, -0.04, 0);
    const helm = add(this.head, new THREE.SphereGeometry(0.165, 18, 14), S.armor, 0, 0.07, 0); helm.scale.set(1, 1.05, 1.12);
    const visor = add(this.head, new THREE.SphereGeometry(0.15, 18, 10, -0.9 + Math.PI / 2, 1.8, 1.25, 0.65), S.visorGlass, 0, 0.07, -0.02); visor.rotation.y = Math.PI;
    visor.scale.set(1.07, 1.05, 1.2);
    add(this.head, box(0.22, 0.022, 0.02), this.glow, 0, 0.075, -0.185);
    add(this.head, cyl(0.006, 0.006, 0.22, 4), S.joint, 0.11, 0.25, 0.06, 0, 0, -0.2);
    add(this.head, new THREE.SphereGeometry(0.014, 6, 4), this.glow, 0.13, 0.36, 0.06);
    // arms holding the rifle
    this.armsG = new THREE.Group(); this.armsG.position.y = 0.42; this.torso.add(this.armsG);
    const arm = (side, upperRot, foreRot, len0 = 0.3, len1 = 0.28) => {
      const sh = new THREE.Group(); sh.position.set(side * 0.27, 0, 0); sh.rotation.set(...upperRot); this.armsG.add(sh);
      add(sh, cyl(0.06, 0.05, len0), S.suit, 0, -len0 / 2, 0);
      add(sh, box(0.12, 0.14, 0.12), S.armor, 0, -0.04, 0);
      const el = new THREE.Group(); el.position.y = -len0; el.rotation.set(...foreRot); sh.add(el);
      add(el, cyl(0.05, 0.045, len1), S.suit, 0, -len1 / 2, 0);
      add(el, box(0.075, 0.18, 0.075), S.armor, 0, -len1 / 2, 0);
      add(el, box(0.07, 0.08, 0.09), S.joint, 0, -len1 - 0.02, 0);
      return sh;
    };
    // positive x-rotation swings a hanging limb forward (towards -z, the facing direction)
    arm(1, [1.05, 0, -0.12], [0.55, 0, 0]);
    arm(-1, [1.3, 0, 0.55], [0.3, 0, 0]);
    // rifle
    this.rifle = new THREE.Group(); this.rifle.position.set(0.1, -0.2, -0.32); this.armsG.add(this.rifle);
    add(this.rifle, box(0.06, 0.1, 0.62), S.gun, 0, 0, -0.1);
    add(this.rifle, box(0.04, 0.14, 0.07), S.gun, 0, -0.1, -0.05, 0.15);
    add(this.rifle, cyl(0.015, 0.015, 0.25, 8), S.gun, 0, 0.01, -0.52, Math.PI / 2);
    add(this.rifle, box(0.004, 0.012, 0.4), this.glow, 0.032, 0, -0.12);
    add(this.rifle, box(0.004, 0.012, 0.4), this.glow, -0.032, 0, -0.12);
    this.muzzle = new THREE.Object3D(); this.muzzle.position.set(0, 0.01, -0.66); this.rifle.add(this.muzzle);

    // shield bubble
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), shieldShader(this.color));
    this.shield.scale.set(0.75, 1.1, 0.75); this.shield.position.y = 0.95; this.shield.visible = false; g.add(this.shield);
    // x-ray ghost for scan pulse
    this.ghost = new THREE.Group();
    const gb = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 10), S.xray); gb.position.y = 0.85; this.ghost.add(gb);
    const gh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), S.xray); gh.position.y = 1.6; this.ghost.add(gh);
    this.ghost.traverse(o => { o.renderOrder = 999; }); this.ghost.visible = false; g.add(this.ghost);
    // name tag
    this.tag = nameSprite(name, '#' + this.color.getHexString()); this.tag.position.y = 2.15; g.add(this.tag);

    this.walkPhase = 0; this.moveBlend = 0; this.airBlend = 0; this.shieldK = 0; this.time = 0; this.lastPos = null;
    this.speed = 0;
  }

  /** st: { x,y,z, yaw, pitch, vx, vz, og, alive, shield, protect, dash } */
  update(dt, st) {
    this.time += dt;
    const g = this.group;
    g.visible = st.alive;
    g.position.set(st.x, st.y, st.z);
    g.rotation.y = st.yaw;
    // local velocity relative to facing
    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    const fwd = -(st.vx * sy + st.vz * cy), side = st.vx * cy - st.vz * sy;
    const speed = Math.hypot(st.vx, st.vz);
    this.speed = speed;
    this.moveBlend += ((st.og ? Math.min(1, speed / 6) : 0) - this.moveBlend) * (1 - Math.exp(-dt * 10));
    this.airBlend += ((st.og ? 0 : 1) - this.airBlend) * (1 - Math.exp(-dt * 10));
    const dir = fwd >= -0.3 ? 1 : -1;
    this.walkPhase += dt * speed * 1.55 * dir;
    const p = this.walkPhase, k = this.moveBlend;
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i], ph = p + i * Math.PI;
      L.hip.rotation.x = Math.sin(ph) * 0.65 * k + this.airBlend * (i ? 0.7 : 0.3);
      L.hip.rotation.z = THREE.MathUtils.clamp(side / 6, -1, 1) * 0.15 * k * (i ? 1 : -1);
      L.knee.rotation.x = -(Math.max(0, Math.sin(ph + 1.3)) * 0.9 * k + this.airBlend * (i ? 1.2 : 0.6));
    }
    this.hips.position.y = 0.95 - Math.abs(Math.cos(p)) * 0.04 * k - this.airBlend * 0.05;
    this.hips.rotation.y = Math.sin(p) * 0.08 * k;
    this.torso.rotation.y = -Math.sin(p) * 0.1 * k;
    this.torso.rotation.z = -THREE.MathUtils.clamp(side / 6, -1, 1) * 0.06;
    this.torso.rotation.x = st.pitch * 0.55 - 0.05 * k - (st.dash ? 0.25 : 0);
    this.head.rotation.x = st.pitch * 0.35;
    this.armsG.rotation.x = st.pitch * 0.45; // arms + rifle carry the rest of the aim pitch
    // shield
    this.shieldK += ((st.shield ? 1 : 0) - this.shieldK) * (1 - Math.exp(-dt * 8));
    this.shield.visible = this.shieldK > 0.02;
    this.shield.material.uniforms.strength.value = this.shieldK;
    this.shield.material.uniforms.time.value = this.time;
    // spawn protection shimmer
    const prot = st.protect ? 0.5 + 0.5 * Math.sin(this.time * 18) : 1;
    this.glow.color.copy(this.color).multiplyScalar(3 * prot + (st.protect ? 1 : 0));
  }
  muzzleWorld(out = new THREE.Vector3()) { this.group.updateMatrixWorld(true); return this.muzzle.getWorldPosition(out); }
  setXray(on) { this.ghost.visible = on; }
  dispose() {
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.glow.dispose(); this.glowSoft.dispose(); this.rimMats.forEach(m => m.dispose()); this.shield.material.dispose(); this.tag.material.map.dispose(); this.tag.material.dispose();
  }
}

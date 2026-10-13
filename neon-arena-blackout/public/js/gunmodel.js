// VX-9 "Kestrel" energy rifle — built from bevelled, extruded side silhouettes so it reads
// like a real machined firearm instead of stacked boxes. Shared by the first-person
// viewmodel (full detail) and third-person avatars (lite).
import * as THREE from 'three';
import * as TX from './textures.js';

let shared = null;
function materials() {
  if (shared) return shared;
  const gm = TX.gunMetalMaps(256);
  shared = {
    metal: new THREE.MeshStandardMaterial({ map: gm.map, roughnessMap: gm.roughnessMap, metalnessMap: gm.metalnessMap, normalMap: gm.normalMap, roughness: 1, metalness: 1, envMapIntensity: 2.2 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.6, metalness: 0.05, envMapIntensity: 1.1 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xd8c400, roughness: 0.45, metalness: 0.2, envMapIntensity: 1.2 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.08, metalness: 1, envMapIntensity: 2.8 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.9, metalness: 0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x88ffee, transparent: true, opacity: 0.25, roughness: 0.02, metalness: 0, clearcoat: 1, envMapIntensity: 2.5 }),
    label: (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
      x.fillStyle = '#d8c400'; x.fillRect(0, 0, 256, 64); x.fillStyle = '#111'; x.font = '800 30px Orbitron, Arial'; x.fillText('VX-9', 10, 38);
      x.font = '600 14px Rajdhani, Arial'; x.fillText('KESTREL ARMS · 6.8 PLASMA', 104, 26); x.fillText('⚠ HIGH VOLTAGE', 104, 46);
      for (let i = 0; i < 9; i++) x.fillRect(10 + i * 9, 48, 5, 10);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
    })()
  };
  return shared;
}

/** Extrude a side profile given as [z, y] points into a bevelled solid, centred on x. */
function sideProfile(points, depth, { holes = [], bevel = 0.004 } = {}) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world -x
  g.translate(depth / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}
const slot = (z0, z1, y0, y1) => [[z0, y0], [z1, y0], [z1, y1], [z0, y1]];

/**
 * Build the rifle. opts: { energy: THREE.Material, lite: boolean }
 * Returns { group, mag, magHome, handle, handleHome, muzzle, ejectPort, coils, cell, charmPivot }
 */
export function buildRifle({ energy, lite = false } = {}) {
  const M = materials();
  const G = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = G) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };

  // receiver (machined metal) with an ejection-port cut
  add(sideProfile([[0.13, 0.05], [0.13, -0.02], [0.06, -0.032], [0.02, -0.05], [-0.2, -0.05], [-0.2, 0.045], [-0.12, 0.058], [0.08, 0.058], [0.11, 0.054]], 0.062,
    { holes: lite ? [] : [slot(0.06, -0.02, 0.012, 0.034)] }), M.metal);
  // vented polymer handguard (the vents are real holes — you can see through them)
  const vents = lite ? [] : [0, 1, 2, 3].map(k => slot(-0.22 - k * 0.062, -0.262 - k * 0.062, -0.016, 0.016));
  add(sideProfile([[-0.18, 0.042], [-0.18, -0.046], [-0.46, -0.04], [-0.5, -0.022], [-0.5, 0.026], [-0.47, 0.042]], 0.07, { holes: vents }), M.polymer);
  // pistol grip + trigger guard + trigger
  add(sideProfile([[0.045, -0.04], [0.1, -0.04], [0.128, -0.152], [0.112, -0.168], [0.062, -0.162], [0.04, -0.082]], 0.034, { bevel: 0.006 }), M.polymer);
  add(sideProfile([[0.04, -0.045], [-0.055, -0.045], [-0.055, -0.088], [0.048, -0.092]], 0.01, { holes: [[[0.03, -0.053], [-0.044, -0.053], [-0.044, -0.078], [0.033, -0.08]]], bevel: 0.002 }), M.metal);
  add(new THREE.BoxGeometry(0.006, 0.022, 0.008), M.chrome, 0, -0.06, 0.012).rotation.x = 0.3;
  // skeleton stock with butt pad
  add(sideProfile([[0.12, 0.042], [0.36, 0.032], [0.38, 0.02], [0.38, -0.09], [0.355, -0.102], [0.3, -0.062], [0.12, -0.02]], 0.044,
    { holes: [[[0.17, 0.016], [0.32, 0.008], [0.332, -0.05], [0.3, -0.046], [0.17, -0.004]]] }), M.polymer);
  add(new THREE.BoxGeometry(0.05, 0.12, 0.02), M.rubber, 0, -0.03, 0.392);
  // top rail with ribs
  add(new THREE.BoxGeometry(0.026, 0.012, 0.3), M.metal, 0, 0.066, -0.05);
  if (!lite) for (let i = 0; i < 12; i++) add(new THREE.BoxGeometry(0.032, 0.007, 0.012), M.metal, 0, 0.074, -0.19 + i * 0.024);
  // barrel, shroud and exposed plasma coils
  const cyl = (r0, r1, len, mat, z, y = 0.006, seg = 16) => { const g = new THREE.CylinderGeometry(r0, r1, len, seg); g.rotateX(Math.PI / 2); return add(g, mat, 0, y, z); };
  cyl(0.013, 0.013, 0.26, M.chrome, -0.6);
  cyl(0.026, 0.026, 0.05, M.metal, -0.505, 0.006, 20);
  const coils = [];
  for (let i = 0; i < (lite ? 3 : 6); i++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.0045, 6, 18), energy);
    t.position.set(0, 0.006, -0.545 - i * 0.022); G.add(t); coils.push(t);
  }
  cyl(0.024, 0.02, 0.07, M.metal, -0.72, 0.006, 8);
  if (!lite) for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.05, 0.004, 0.01), energy, 0, 0.006, -0.7 - i * 0.02);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.006, -0.765); G.add(muzzle);
  // side plasma capacitor (glass tube with a glowing core) + feed cable
  const cell = cyl(0.009, 0.009, 0.09, energy, -0.06, 0.0, 10); cell.position.x = -0.04;
  const tube = cyl(0.016, 0.016, 0.1, M.glass, -0.06, 0.0, 14); tube.position.x = -0.04; tube.castShadow = false;
  for (const z of [-0.012, -0.108]) { const cap = cyl(0.018, 0.018, 0.01, M.chrome, z, 0, 14); cap.position.x = -0.04; }
  if (!lite) {
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.04, -0.005, -0.11), new THREE.Vector3(-0.045, -0.03, -0.25), new THREE.Vector3(-0.038, -0.012, -0.5)]);
    add(new THREE.TubeGeometry(curve, 16, 0.004, 6, false), M.rubber);
  }
  // hazard-yellow paint panel + manufacturer label on the right side
  add(new THREE.BoxGeometry(0.002, 0.02, 0.15), M.paint, 0.033, -0.022, -0.06);
  if (!lite) { const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.025), M.label); lab.position.set(0.0342, 0.028, -0.07); lab.rotation.y = Math.PI / 2; G.add(lab); }
  // magazine (own group for the reload animation): curved polymer mag with an energy window
  const mag = new THREE.Group(); mag.position.set(0, -0.06, -0.12); G.add(mag);
  add(sideProfile([[0.03, 0.01], [-0.03, 0.01], [-0.048, -0.15], [0.008, -0.162]], 0.036, { bevel: 0.004 }), M.polymer, 0, 0, 0, mag);
  const win = add(new THREE.BoxGeometry(0.04, 0.08, 0.012), energy, 0, -0.07, -0.005, mag); win.rotation.x = 0.13;
  // charging handle (right side)
  const handle = add(new THREE.BoxGeometry(0.02, 0.012, 0.03), M.chrome, 0.042, 0.032, 0.085);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(0.04, 0.024, 0.02); G.add(ejectPort);
  // sling point for a hanging charm
  const charmPivot = new THREE.Object3D(); charmPivot.position.set(-0.038, -0.03, -0.42); G.add(charmPivot);
  G.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  return { group: G, mag, magHome: mag.position.clone(), handle, handleHome: handle.position.clone(), muzzle, ejectPort, coils, cell, charmPivot, mats: M };
}

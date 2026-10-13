// Arena construction: PBR materials, lighting + shadows, planar floor reflections,
// height fog, volumetric light shafts, ground mist, rain, skyline and detailed props.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import * as TX from './textures.js';
import { addNightCity } from './nightcity.js';

const Sim = window.NeonSim;

// ------------------------------------------------------------------ height fog
// Replace three.js' distance fog with distance + exponential height fog so the
// arena floor sits in a dense, low-lying layer of mist.
export function installHeightFog() {
  THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogWorldPos;\n#endif';
  THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogWorldPos = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );\n#endif';
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
 uniform vec3 fogColor;
 varying float vFogDepth;
 varying vec3 vFogWorldPos;
 #ifdef FOG_EXP2
  uniform float fogDensity;
 #else
  uniform float fogNear;
  uniform float fogFar;
 #endif
 const float FOG_H_DENS = 0.075;
 const float FOG_H_FALL = 0.42;
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
 #ifdef FOG_EXP2
  float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
 #else
  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
 #endif
 float fogDist = length( vFogWorldPos - cameraPosition );
 float fdy = vFogWorldPos.y - cameraPosition.y;
 float fhc = exp( - FOG_H_FALL * max( cameraPosition.y, 0.0 ) );
 float fhp = exp( - FOG_H_FALL * max( vFogWorldPos.y, 0.0 ) );
 float fhInt = abs( fdy ) > 0.01 ? ( fhc - fhp ) / ( FOG_H_FALL * fdy ) : fhc;
 float hFog = 1.0 - exp( - FOG_H_DENS * fogDist * fhInt );
 fogFactor = clamp( fogFactor + hFog * ( 1.0 - fogFactor ), 0.0, 1.0 );
 gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}

// ------------------------------------------------------------------ static batching
// All static geometry is merged per material to keep draw calls low.
class StaticBatcher {
  constructor() { this.buckets = new Map(); }
  add(geometry, material, matrix, { cast = true, receive = true } = {}) {
    const g = geometry.index ? geometry.clone() : geometry.clone();
    g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    const key = material.uuid + (cast ? 'c' : '') + (receive ? 'r' : '');
    if (!this.buckets.has(key)) this.buckets.set(key, { material, cast, receive, geos: [] });
    this.buckets.get(key).geos.push(g.index ? g.toNonIndexed() : g);
  }
  box(material, cx, cy, cz, sx, sy, sz, opts = {}, tile = 2, rotY = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(1, 1, 1));
    this.add(TX.worldUVBox(sx, sy, sz, tile), material, m, opts);
  }
  flush(parent) {
    for (const b of this.buckets.values()) {
      const merged = mergeGeometries(b.geos, false);
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.castShadow = b.cast; mesh.receiveShadow = b.receive;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      b.geos.forEach(g => g.dispose());
    }
    this.buckets.clear();
  }
}
const M4 = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));

// ------------------------------------------------------------------ neon sign texture
function signTexture(text, color, { w = 1024, h = 256, font = 'Orbitron', sub = '' } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  let fs = h * (sub ? 0.46 : 0.58);
  ctx.font = `800 ${fs}px ${font}, Arial, sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > w * 0.86) { fs *= w * 0.86 / tw; ctx.font = `800 ${fs}px ${font}, Arial, sans-serif`; }
  for (const [blur, alpha] of [[40, 0.5], [18, 0.8], [4, 1]]) {
    ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = h * 0.035; ctx.strokeText(text, w / 2, h * (sub ? 0.42 : 0.5));
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 6; ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, h * (sub ? 0.42 : 0.5));
  if (sub) { ctx.font = `600 ${h * 0.16}px Rajdhani, Arial`; ctx.shadowBlur = 12; ctx.fillStyle = color; ctx.fillText(sub, w / 2, h * 0.82); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ------------------------------------------------------------------ shaders
const lightShaftMaterial = color => new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(color) }, time: { value: 0 }, intensity: { value: 0.55 } },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying float vA; varying vec3 vW;
    void main(){ vA = uv.y; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vV = -mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 color; uniform float time; uniform float intensity; varying vec3 vN; varying vec3 vV; varying float vA; varying vec3 vW;
    float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
    float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
    void main(){
      float rim = abs(dot(normalize(vN), normalize(vV)));
      rim = pow(rim, 2.5);
      float along = pow(vA, 1.6);
      float dust = 0.65 + 0.7 * n3(vW * 0.6 + vec3(0.0, -time * 0.4, time * 0.2));
      float a = rim * along * dust * intensity;
      float camFade = smoothstep(0.5, 4.0, length(vV));
      gl_FragColor = vec4(color * a * camFade, 1.0);
    }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
});

const mistMaterial = (height, tint) => new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, tint: { value: new THREE.Color(tint) }, layerY: { value: height } },
  vertexShader: `varying vec3 vW; varying vec3 vV; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vV = cameraPosition - w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform float time; uniform vec3 tint; uniform float layerY; varying vec3 vW; varying vec3 vV;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
    float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
    void main(){
      vec2 p = vW.xz * 0.09;
      float m = fbm(p + vec2(time*0.03, time*0.017) + layerY) * fbm(p*1.7 - vec2(time*0.02, -time*0.025));
      m = smoothstep(0.12, 0.55, m);
      vec3 V = normalize(vV);
      float grazing = smoothstep(0.0, 0.35, abs(V.y));
      float d = length(vV);
      float near = smoothstep(0.6, 5.0, d) * (1.0 - smoothstep(45.0, 75.0, d));
      float edge = 1.0 - smoothstep(26.0, 30.0, max(abs(vW.x), abs(vW.z)));
      gl_FragColor = vec4(tint, m * grazing * near * edge * 0.32);
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide
});

const skyMaterial = () => new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 } },
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: `uniform float time; varying vec3 vD;
    float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
    void main(){
      float y = vD.y;
      vec3 zenith = vec3(0.004,0.006,0.016), mid = vec3(0.016,0.016,0.045), horizon = vec3(0.16,0.045,0.14);
      vec3 c = mix(horizon, mid, smoothstep(-0.02, 0.18, y));
      c = mix(c, zenith, smoothstep(0.18, 0.8, y));
      // city light pollution with cyan/magenta banding
      float az = atan(vD.z, vD.x);
      c += vec3(0.0,0.07,0.09) * (0.5+0.5*sin(az*3.0+1.0)) * exp(-max(y,0.0)*14.0);
      c += vec3(0.09,0.0,0.06) * (0.5+0.5*sin(az*2.0-0.7)) * exp(-max(y,0.0)*9.0);
      // stars
      vec3 sp = floor(vD * 420.0);
      float s = step(0.9985, h(sp)) * smoothstep(0.15, 0.5, y);
      c += vec3(0.6,0.7,1.0) * s * (0.5 + 0.5 * sin(time * 2.0 + h(sp+1.0) * 40.0));
      // drifting cloud deck lit from below
      vec3 q = vD * vec3(3.0, 9.0, 3.0) + vec3(time * 0.004, 0.0, 0.0);
      vec3 qi = floor(q), qf = fract(q); qf = qf * qf * (3.0 - 2.0 * qf);
      float n = mix(mix(mix(h(qi), h(qi+vec3(1,0,0)), qf.x), mix(h(qi+vec3(0,1,0)), h(qi+vec3(1,1,0)), qf.x), qf.y),
                    mix(mix(h(qi+vec3(0,0,1)), h(qi+vec3(1,0,1)), qf.x), mix(h(qi+vec3(0,1,1)), h(qi+vec3(1,1,1)), qf.x), qf.y), qf.z);
      float cl = smoothstep(0.45, 0.85, n) * smoothstep(0.04, 0.25, y) * (1.0 - smoothstep(0.35, 0.75, y));
      c += vec3(0.06, 0.025, 0.07) * cl;
      gl_FragColor = vec4(c, 1.0);
    }`,
  side: THREE.BackSide, depthWrite: false, fog: false
});

const holoMaterial = (color, text) => {
  const tex = signTexture(text, color, { w: 1024, h: 512, sub: 'NEURAL LINK · ARENA FEED · LIVE' });
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(color) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D map; uniform float time; uniform vec3 color; varying vec2 vUv;
      void main(){
        vec2 uv = vUv;
        float glitch = step(0.985, fract(sin(floor(time*6.0)*91.7)*43758.5));
        uv.x += glitch * 0.03 * sin(uv.y * 80.0);
        vec4 t = texture2D(map, uv);
        float scan = 0.75 + 0.25 * sin(uv.y * 400.0 - time * 8.0);
        float band = smoothstep(0.0, 0.05, fract(uv.y * 1.5 - time * 0.25)) * 0.3 + 0.7;
        float frame = step(0.012, min(min(uv.x, 1.0-uv.x), min(uv.y, 1.0-uv.y)));
        vec3 c = t.rgb * scan * band * 2.6 + color * 0.08 * frame + color * (1.0-frame) * 2.0;
        float a = max(t.a * 0.95, 0.12 * frame + (1.0-frame));
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
  });
};

const rainMaterial = () => new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, center: { value: new THREE.Vector3() } },
  vertexShader: `attribute float seed; attribute float tip; uniform float time; uniform vec3 center; varying float vA;
    void main(){
      vec3 p = position;
      float fall = 24.0 + seed * 8.0;
      p.y = mod(p.y - time * fall, 26.0) - 2.0;
      p.x = center.x + mod(p.x - center.x + 30.0, 60.0) - 30.0;
      p.z = center.z + mod(p.z - center.z + 30.0, 60.0) - 30.0;
      p += vec3(0.08, 0.6, 0.04) * tip;
      vA = (1.0 - tip * 0.8) * smoothstep(-2.0, 1.5, p.y);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(vec3(0.55,0.7,0.9) * 0.6, vA * 0.35); }',
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});

// ------------------------------------------------------------------ world
export function createWorld(renderer, scene, quality) {
  const Q = quality;
  const T0 = performance.now();
  TX.setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  const texSize = Q.textures;
  const updaters = [];
  const batch = new StaticBatcher();
  const root = new THREE.Group(); root.name = 'arena'; scene.add(root);
  const neonEmitters = []; // positions for neon buzz audio
  let blockIndex = 0;

  // ---------- environment (IBL) built from a small neon "city" scene
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x06070f, side: THREE.BackSide })));
  const envPanel = (c, x, y, z, w, h, k = 6) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, y * 0.4, 0); envScene.add(m); };
  envPanel(0x00e5ff, 30, 6, -20, 18, 3); envPanel(0xff2fb9, -28, 8, 18, 16, 4); envPanel(0x7a4dff, 10, 10, 34, 20, 3);
  envPanel(0xffa040, -25, 4, -30, 10, 2, 3); envPanel(0x3060ff, 0, 40, 0, 40, 40, 0.12); envPanel(0xff2fb9, 32, 3, 25, 10, 2);
  envPanel(0x00e5ff, -34, 3, -4, 12, 2); envPanel(0x223355, 0, -6, 0, 60, 60, 0.4);
  const envRT = pmrem.fromScene(envScene, 0.035);
  scene.environment = envRT.texture;
  envScene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });

  // ---------- sky & fog
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), skyMaterial());
  sky.frustumCulled = false; sky.renderOrder = -1000; scene.add(sky);
  scene.background = new THREE.Color(0x02030a);
  // magenta-tinted smog, like light pollution scattering through a wet megacity night
  scene.fog = new THREE.FogExp2(0x150d22, 0.0165);
  updaters.push(t => { sky.material.uniforms.time.value = t; });

  // ---------- materials
  const std = (maps, o = {}) => new THREE.MeshStandardMaterial(Object.assign({
    map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.roughnessMap, metalnessMap: maps.metalnessMap,
    roughness: 1, metalness: 1, envMapIntensity: 0.9
  }, o));
  const floorM = TX.floorMaps(Math.max(512, texSize * 2));
  const metalM = TX.metalPanelMaps(texSize);
  const metalDarkM = TX.metalPanelMaps(texSize, [0.12, 0.13, 0.16]);
  const concreteM = TX.concreteMaps(texSize);
  const techCyanM = TX.techMaps(texSize, [0, 0.9, 1]);
  const techPinkM = TX.techMaps(texSize, [1, 0.15, 0.75]);
  const grateM = TX.grateMaps(256);
  const hazardM = TX.hazardMaps(256);
  const windowsM = TX.windowMaps(texSize);
  const crateVariants = [
    TX.crateMaps(texSize, [0.62, 0.2, 0.06], 'NX-07'),
    TX.crateMaps(texSize, [0.05, 0.3, 0.33], 'KZ-41'),
    TX.crateMaps(texSize, [0.2, 0.21, 0.23], 'BLK-3')
  ];
  const barrelVariants = [TX.barrelMaps(256, [0.45, 0.06, 0.05]), TX.barrelMaps(256, [0.07, 0.18, 0.4])];

  const mats = {
    metal: std(metalM, { normalScale: new THREE.Vector2(0.8, 0.8) }),
    metalDark: std(metalDarkM),
    concrete: std(concreteM, { metalness: 0, envMapIntensity: 0.5 }),
    techCyan: std(techCyanM, { emissive: 0xffffff, emissiveMap: techCyanM.emissiveMap, emissiveIntensity: 2.2 }),
    techPink: std(techPinkM, { emissive: 0xffffff, emissiveMap: techPinkM.emissiveMap, emissiveIntensity: 2.2 }),
    grate: std(grateM, { alphaMap: grateM.alphaMap, alphaTest: 0.5, side: THREE.DoubleSide }),
    hazard: std(hazardM),
    windows: std(windowsM, { emissive: 0xffffff, emissiveMap: windowsM.emissiveMap, emissiveIntensity: 1.6, envMapIntensity: 0.4 }),
    crates: crateVariants.map(m => std(m)),
    barrels: barrelVariants.map(m => std(m)),
    trimDark: new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.4, metalness: 0.9 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9, metalness: 0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0a1a2a, roughness: 0.05, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6, transparent: true, opacity: 0.55 }),
    neon: {}
  };
  const neon = (hex, k = 4) => {
    if (!mats.neon[hex + k]) mats.neon[hex + k] = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: true });
    return mats.neon[hex + k];
  };
  const CYAN = 0x00f5ff, PINK = 0xff2fb9, LIME = 0xb6ff4a, AMBER = 0xffa23a, VIOLET = 0x8a5cff;

  // ---------- floor with planar reflections in puddles
  const floorGeo = new THREE.PlaneGeometry(2 * Sim.ARENA_HALF, 2 * Sim.ARENA_HALF, 1, 1);
  const uvs = floorGeo.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 14, uvs.getY(i) * 14);
  const floorMat = std(floorM, { metalness: 0, envMapIntensity: Q.reflections ? 0.35 : 0.9, normalScale: new THREE.Vector2(0.9, 0.9) });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; root.add(floor);
  let reflector = null;
  const hideInReflection = [floor];
  if (Q.reflections) {
    const w = Math.round(innerWidth * Q.reflectionScale), h = Math.round(innerHeight * Q.reflectionScale);
    reflector = new Reflector(floorGeo, { textureWidth: w, textureHeight: h, clipBias: 0.002, multisample: 0 });
    reflector.rotation.x = -Math.PI / 2;
    reflector.material.colorWrite = false; reflector.material.depthWrite = false;
    reflector.renderOrder = -500;
    const orig = reflector.onBeforeRender;
    reflector.onBeforeRender = function (r, s, c) {
      if (c.isArrayCamera || c.userData.noReflect) return;
      for (const o of hideInReflection) o.visible = false;
      orig.call(this, r, s, c);
      for (const o of hideInReflection) o.visible = true;
    };
    root.add(reflector);
    const texMatrix = reflector.material.uniforms.textureMatrix.value;
    floorMat.onBeforeCompile = shader => {
      shader.uniforms.tReflect = { value: reflector.getRenderTarget().texture };
      shader.uniforms.reflMatrix = { value: texMatrix };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 reflMatrix;\nvarying vec4 vReflUv;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvReflUv = reflMatrix * vec4( position, 1.0 );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tReflect;\nvarying vec4 vReflUv;')
        .replace('#include <opaque_fragment>', `
          {
            vec4 ruv = vReflUv;
            ruv.xy += normal.xy * 0.045 * ruv.w;
            // roughness-scaled 5-tap blur approximates glossy reflections on damp concrete
            float br = roughnessFactor * 0.018 * ruv.w;
            vec3 refl = texture2DProj( tReflect, ruv ).rgb * 0.4;
            refl += texture2DProj( tReflect, ruv + vec4( br, 0.0, 0.0, 0.0 ) ).rgb * 0.15;
            refl += texture2DProj( tReflect, ruv - vec4( br, 0.0, 0.0, 0.0 ) ).rgb * 0.15;
            refl += texture2DProj( tReflect, ruv + vec4( 0.0, br * 1.6, 0.0, 0.0 ) ).rgb * 0.15;
            refl += texture2DProj( tReflect, ruv - vec4( 0.0, br * 1.6, 0.0, 0.0 ) ).rgb * 0.15;
            float wet = 1.0 - roughnessFactor; wet *= wet * 1.1;
            float ndv = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
            float fres = 0.08 + 0.92 * pow( 1.0 - ndv, 4.0 );
            float k = clamp( wet * fres * 1.15, 0.0, 0.92 );
            outgoingLight = outgoingLight * ( 1.0 - k * 0.6 ) + refl * k;
          }
          #include <opaque_fragment>`);
    };
  }

  // ---------- perimeter walls
  const A = Sim.ARENA_HALF, WH = Sim.WALL_HEIGHT;
  for (const b of Sim.boxes) {
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
    switch (b.kind) {
      case 'perimeter': {
        batch.box(mats.concrete, cx, cy, cz, sx, sy, sz, {}, 4);
        // cap and trim
        batch.box(mats.trimDark, cx, y1 + 0.12, cz, sx + 0.3, 0.24, sz + 0.3, {}, 2);
        const alongX = sx > sz;
        const inward = alongX ? (cz < 0 ? 1 : -1) : (cx < 0 ? 1 : -1);
        const faceOff = (alongX ? sz : sx) / 2;
        // neon base strip + top strip
        const stripColor = alongX ? CYAN : PINK;
        if (alongX) {
          batch.box(neon(stripColor, 3), cx, 0.12, cz + inward * (faceOff + 0.02), sx - 1, 0.05, 0.04, { cast: false });
          batch.box(neon(stripColor, 2.5), cx, y1 - 0.4, cz + inward * (faceOff + 0.02), sx - 1, 0.04, 0.04, { cast: false });
        } else {
          batch.box(neon(stripColor, 3), cx + inward * (faceOff + 0.02), 0.12, cz, 0.04, 0.05, sz - 1, { cast: false });
          batch.box(neon(stripColor, 2.5), cx + inward * (faceOff + 0.02), y1 - 0.4, cz, 0.04, 0.04, sz - 1, { cast: false });
        }
        // pilasters, pipes and wall lamps along the wall
        for (let s = -A + 3.5; s <= A - 3.5; s += 7) {
          const px = alongX ? s : cx + inward * (faceOff + 0.25), pz = alongX ? cz + inward * (faceOff + 0.25) : s;
          batch.box(mats.metalDark, px, WH / 2, pz, alongX ? 0.6 : 0.5, WH, alongX ? 0.5 : 0.6, {}, 2);
          batch.box(neon(AMBER, 2), alongX ? px : px + inward * 0.27, 4.6, alongX ? pz + inward * 0.27 : pz, alongX ? 0.3 : 0.04, 0.08, alongX ? 0.04 : 0.3, { cast: false });
        }
        const pipeGeo = new THREE.CylinderGeometry(0.12, 0.12, alongX ? sx - 1 : sz - 1, 10);
        for (const [h, off] of [[5.5, 0.35], [5.85, 0.5]]) {
          const m = alongX ? M4(cx, h, cz + inward * (faceOff + off), 0, 0, Math.PI / 2) : M4(cx + inward * (faceOff + off), h, cz, Math.PI / 2, 0, 0);
          batch.add(pipeGeo, mats.metal, m);
        }
        break;
      }
      case 'core': buildCore(b, cx, cz, sx, sy, sz); break;
      case 'block': buildBlock(b, cx, cy, cz, sx, sy, sz); break;
      case 'tower': buildTower(b, cx, cy, cz, sx, sy, sz); break;
      case 'wall': {
        batch.box(mats.metal, cx, cy, cz, sx, sy, sz, {}, 2);
        batch.box(mats.hazard, cx, y1 + 0.05, cz, sx + 0.06, 0.1, sz + 0.06, {}, 1);
        batch.box(mats.trimDark, cx, 0.15, cz, sx + 0.12, 0.3, sz + 0.12, {}, 2);
        const alongX = sx > sz;
        for (const sgn of [-1, 1]) {
          if (alongX) batch.box(neon(LIME, 1.4), cx, sy * 0.55, cz + sgn * (sz / 2 + 0.015), sx * 0.8, 0.03, 0.03, { cast: false });
          else batch.box(neon(LIME, 1.4), cx + sgn * (sx / 2 + 0.015), sy * 0.55, cz, 0.03, 0.03, sz * 0.8, { cast: false });
        }
        break;
      }
      case 'crate': {
        const h = Math.abs(Math.sin(cx * 12.9 + cz * 78.2)) * 3 | 0;
        const mat = mats.crates[h % 3];
        const g = new THREE.BoxGeometry(sx - 0.08, sy - 0.08, sz - 0.08);
        batch.add(g, mat, M4(cx, cy, cz));
        // corner posts + top/bottom frames
        for (const ix of [-1, 1]) for (const iz of [-1, 1]) batch.box(mats.trimDark, cx + ix * (sx / 2 - 0.05), cy, cz + iz * (sz / 2 - 0.05), 0.1, sy, 0.1);
        for (const yy of [y0 + 0.05, y1 - 0.05]) {
          batch.box(mats.trimDark, cx, yy, cz - sz / 2 + 0.05, sx, 0.1, 0.1); batch.box(mats.trimDark, cx, yy, cz + sz / 2 - 0.05, sx, 0.1, 0.1);
          batch.box(mats.trimDark, cx - sx / 2 + 0.05, yy, cz, 0.1, 0.1, sz); batch.box(mats.trimDark, cx + sx / 2 - 0.05, yy, cz, 0.1, 0.1, sz);
        }
        break;
      }
      case 'barrel': {
        const mat = mats.barrels[(Math.abs(cx * 3 + cz) | 0) % 2];
        batch.add(new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 20), mat, M4(cx, cy, cz, 0, cx + cz, 0));
        batch.add(new THREE.CylinderGeometry(sx / 2 - 0.03, sx / 2 - 0.03, 0.02, 20), mats.trimDark, M4(cx, y1 + 0.01, cz));
        for (const yy of [y0 + 0.02, y1 - 0.02]) batch.add(new THREE.TorusGeometry(sx / 2, 0.025, 6, 20), mats.metal, M4(cx, yy, cz, Math.PI / 2));
        break;
      }
      case 'catwalk': buildCatwalk(b, cx, cy, cz, sx, sy, sz); break;
      case 'stair': {
        batch.box(mats.metalDark, cx, cy, cz, sx, sy, sz, {}, 1);
        batch.box(mats.grate, cx, y1 + 0.005, cz, sx, 0.01, sz, { cast: false }, 1);
        // glowing nosing strips along both long edges of each step
        for (const sgn of [-1, 1]) {
          if (sz > sx) batch.box(neon(AMBER, 2.5), cx + sgn * (sx / 2 + 0.006), y1 - 0.03, cz, 0.012, 0.03, sz - 0.1, { cast: false });
          else batch.box(neon(AMBER, 2.5), cx, y1 - 0.03, cz + sgn * (sz / 2 + 0.006), sx - 0.1, 0.03, 0.012, { cast: false });
        }
        break;
      }
    }
  }

  function buildCore(b, cx, cz, sx, sy, sz) {
    batch.box(mats.techCyan, cx, sy / 2, cz, sx, sy, sz, {}, 2);
    batch.box(mats.trimDark, cx, 0.2, cz, sx + 0.4, 0.4, sz + 0.4);
    batch.box(mats.trimDark, cx, sy + 0.1, cz, sx + 0.3, 0.2, sz + 0.3);
    for (const ix of [-1, 1]) for (const iz of [-1, 1]) {
      batch.box(mats.metal, cx + ix * sx / 2, sy / 2, cz + iz * sz / 2, 0.45, sy + 0.3, 0.45);
      batch.box(neon(CYAN, 5), cx + ix * (sx / 2 + 0.23), sy / 2, cz + iz * (sz / 2 + 0.23), 0.04, sy - 0.6, 0.04, { cast: false });
    }
    // hazard ring on the floor around the core
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 3.75, 64), new THREE.MeshStandardMaterial({ map: TX.hazardMaps(256).map, roughness: 0.6, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -2 }));
    ring.material.map.repeat.set(10, 1);
    ring.rotation.x = -Math.PI / 2; ring.position.set(cx, 0.004, cz); ring.receiveShadow = true; root.add(ring);
    hideInReflection.push(ring);
    // animated energy rings + light beam
    const rings = new THREE.Group(); rings.position.set(cx, 0, cz); root.add(rings);
    const ringMat = neon(CYAN, 6);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(2.9 + i * 0.25, 0.035, 8, 96), ringMat);
      r.rotation.x = Math.PI / 2; r.position.y = 1.2 + i * 1.5; rings.add(r);
    }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.4, 40, 32, 1, true), lightShaftMaterial(0x00e5ff));
    beam.geometry.translate(0, 20, 0); beam.position.set(cx, sy, cz); beam.material.uniforms.intensity.value = 0.35;
    // uv.y = 1 at top for cylinders: invert so the beam is brightest at its base
    const uvA = beam.geometry.attributes.uv; for (let i = 0; i < uvA.count; i++) uvA.setY(i, 1 - uvA.getY(i));
    root.add(beam);
    const coreLight = new THREE.PointLight(0x00e5ff, 60, 18, 2); coreLight.position.set(cx, sy + 0.8, cz); root.add(coreLight);
    updaters.push(t => {
      rings.children.forEach((r, i) => { r.position.y = 1.0 + i * 1.6 + Math.sin(t * 1.3 + i * 2) * 0.35; r.rotation.z = t * (0.2 + i * 0.1); });
      beam.material.uniforms.time.value = t;
      coreLight.intensity = 50 + Math.sin(t * 3) * 10;
    });
    neonEmitters.push(new THREE.Vector3(cx, 2, cz));
  }

  function buildBlock(b, cx, cy, cz, sx, sy, sz) {
    const i = blockIndex++;
    const accent = [CYAN, PINK, VIOLET, LIME][i % 4];
    batch.box(i % 2 ? mats.metal : mats.metalDark, cx, cy, cz, sx, sy, sz, {}, 2);
    batch.box(mats.trimDark, cx, b.max[1] + 0.15, cz, sx + 0.25, 0.3, sz + 0.25);
    batch.box(mats.trimDark, cx, 0.25, cz, sx + 0.12, 0.5, sz + 0.12);
    batch.box(neon(accent, 4), cx, b.max[1] - 0.05, cz, sx + 0.27, 0.06, sz + 0.27, { cast: false });
    // windows band
    for (const [fx, fz, w] of [[0, 1, sx], [0, -1, sx], [1, 0, sz], [-1, 0, sz]]) {
      const px = cx + fx * (sx / 2 + 0.01), pz = cz + fz * (sz / 2 + 0.01);
      const rot = fx ? Math.PI / 2 : 0;
      batch.add(new THREE.BoxGeometry(w * 0.7, 0.7, 0.02), mats.glass, M4(px, sy * 0.68, pz, 0, rot, 0), { cast: false });
      batch.add(new THREE.BoxGeometry(w * 0.72, 0.05, 0.05), neon(accent, 2), M4(px, sy * 0.68 - 0.4, pz, 0, rot, 0), { cast: false });
    }
    // door with lit frame on the face pointing at the arena centre
    const toCenter = Math.abs(cx) > Math.abs(cz) ? [-Math.sign(cx), 0] : [0, -Math.sign(cz)];
    const dx = cx + toCenter[0] * ((toCenter[0] ? sx : 0) / 2 + 0.02), dz = cz + toCenter[1] * ((toCenter[1] ? sz : 0) / 2 + 0.02);
    const drot = toCenter[0] ? Math.PI / 2 : 0;
    batch.add(new THREE.BoxGeometry(1.2, 2.2, 0.06), mats.trimDark, M4(dx, 1.1, dz, 0, drot, 0));
    batch.add(new THREE.BoxGeometry(1.34, 0.05, 0.08), neon(accent, 5), M4(dx, 2.25, dz, 0, drot, 0), { cast: false });
    const sideOff = new THREE.Vector3(0.67, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), drot);
    for (const s of [-1, 1]) batch.add(new THREE.BoxGeometry(0.05, 2.2, 0.08), neon(accent, 5), M4(dx + sideOff.x * s, 1.1, dz + sideOff.z * s, 0, drot, 0), { cast: false });
    // rooftop details: AC units, vents, antenna
    const top = b.max[1] + 0.3;
    batch.box(mats.metal, cx - sx * 0.2, top + 0.4, cz - sz * 0.15, 1.4, 0.8, 1.0, {}, 1);
    batch.add(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 20), mats.trimDark, M4(cx - sx * 0.2, top + 0.83, cz - sz * 0.15));
    batch.box(mats.metalDark, cx + sx * 0.25, top + 0.25, cz + sz * 0.2, 0.8, 0.5, 0.8, {}, 1);
    batch.add(new THREE.CylinderGeometry(0.03, 0.05, 3, 6), mats.metal, M4(cx + sx * 0.3, top + 1.5, cz - sz * 0.3));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), neon(0xff2020, 8));
    beacon.position.set(cx + sx * 0.3, top + 3.05, cz - sz * 0.3); root.add(beacon);
    updaters.push(t => { beacon.visible = Math.sin(t * 3 + i) > 0.6; });
    // a neon sign on one outward face
    const signs = [['BAR 24H', PINK], ['NEXUS', CYAN], ['ラーメン', AMBER], ['DATA', LIME], ['HOTEL', VIOLET], ['CHROME', CYAN], ['ARCADE', PINK], ['SYNTH', LIME]];
    const [txt, col] = signs[i % signs.length];
    const sMat = new THREE.MeshBasicMaterial({ map: signTexture(txt, '#' + new THREE.Color(col).getHexString()), transparent: true, color: new THREE.Color(2.4, 2.4, 2.4), depthWrite: false, side: THREE.DoubleSide });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3.6, Math.max(sx, sz) * 0.75), 0.9), sMat);
    const out = [toCenter[0] * -1, toCenter[1] * -1];
    const sxo = cx + out[0] * (sx / 2 + 0.06), szo = cz + out[1] * (sz / 2 + 0.06);
    sign.position.set(out[0] ? sxo : cx, sy * 0.4, out[1] ? szo : cz);
    sign.rotation.y = out[0] ? out[0] * Math.PI / 2 : (out[1] < 0 ? Math.PI : 0);
    root.add(sign);
    let sl = null;
    if (i < 4 || Q.extraLights) { sl = new THREE.PointLight(col, 7, 7, 2); sl.position.copy(sign.position).add(new THREE.Vector3(out[0] * 1.2, 0, out[1] * 1.2)); root.add(sl); }
    updaters.push(t => {
      // occasional flicker
      const f = Math.sin(t * 37 + i * 9) > 0.97 || (Math.sin(t * 0.7 + i) > 0.985) ? 0.25 : 1;
      sMat.color.setScalar(2.4 * f); if (sl) sl.intensity = 7 * f;
    });
    neonEmitters.push(sign.position.clone());
  }

  function buildTower(b, cx, cy, cz, sx, sy, sz) {
    const pink = cx * cz > 0;
    batch.box(pink ? mats.techPink : mats.techCyan, cx, cy, cz, sx, sy, sz, {}, 2);
    batch.box(mats.trimDark, cx, b.max[1] + 0.1, cz, sx + 0.2, 0.2, sz + 0.2);
    for (const ix of [-1, 1]) for (const iz of [-1, 1]) batch.box(mats.metal, cx + ix * sx / 2, cy, cz + iz * sz / 2, 0.2, sy, 0.2);
    const bl = new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), neon(pink ? PINK : CYAN, 6));
    bl.position.set(cx, b.max[1] + 0.9, cz); root.add(bl);
    updaters.push(t => { bl.rotation.y = t * 1.5; bl.position.y = b.max[1] + 0.9 + Math.sin(t * 2 + cx) * 0.12; });
  }

  function buildCatwalk(b, cx, cy, cz, sx, sy, sz) {
    batch.box(mats.grate, cx, b.max[1] - 0.02, cz, sx, 0.04, sz, {}, 1);
    const alongX = sx > sz;
    // side beams
    if (alongX) { for (const s of [-1, 1]) batch.box(mats.metal, cx, cy, cz + s * (sz / 2 - 0.06), sx, sy, 0.12, {}, 1); }
    else { for (const s of [-1, 1]) batch.box(mats.metal, cx + s * (sx / 2 - 0.06), cy, cz, 0.12, sy, sz, {}, 1); }
    // cross beams
    const len = alongX ? sx : sz;
    for (let s = -len / 2 + 0.5; s <= len / 2 - 0.4; s += 1.25) {
      if (alongX) batch.box(mats.metalDark, cx + s, cy - 0.05, cz, 0.08, 0.12, sz); else batch.box(mats.metalDark, cx, cy - 0.05, cz + s, sx, 0.12, 0.08);
    }
    // railing on the open (inner) side
    const inner = alongX ? (cz < 0 ? 1 : -1) : (cx < 0 ? 1 : -1);
    const ry = b.max[1];
    for (let s = -len / 2 + 0.15; s <= len / 2 - 0.1; s += 1.2) {
      const px = alongX ? cx + s : cx + inner * (sx / 2 - 0.05), pz = alongX ? cz + inner * (sz / 2 - 0.05) : cz + s;
      batch.box(mats.metal, px, ry + 0.5, pz, 0.05, 1.0, 0.05, {}, 1);
      // support pillar to the ground
      batch.box(mats.metalDark, px, b.min[1] / 2, pz, 0.16, b.min[1], 0.16, {}, 1);
    }
    for (const h of [0.5, 1.0]) {
      const px = alongX ? cx : cx + inner * (sx / 2 - 0.05), pz = alongX ? cz + inner * (sz / 2 - 0.05) : cz;
      batch.add(new THREE.CylinderGeometry(0.025, 0.025, len, 6), mats.metal, alongX ? M4(px, ry + h, pz, 0, 0, Math.PI / 2) : M4(px, ry + h, pz, Math.PI / 2, 0, 0));
    }
    // under-deck strip light
    const px = alongX ? cx : cx + inner * (sx / 2 - 0.15), pz = alongX ? cz + inner * (sz / 2 - 0.15) : cz;
    batch.box(neon(VIOLET, 4), px, b.min[1] - 0.03, pz, alongX ? len - 0.4 : 0.05, 0.03, alongX ? 0.05 : len - 0.4, { cast: false });
    if (Q.extraLights) { const l = new THREE.PointLight(VIOLET, 10, 7, 2); l.position.set(px, b.min[1] - 0.4, pz); root.add(l); }
  }

  // ---------- big neon signs on perimeter walls + holographic billboard
  const wallSigns = [
    // mounted proud of the wall so the pilasters (which stick out 0.5 m) never cover them
    { text: 'BLACKOUT', color: '#ff2fb9', pos: [0, 4.3, -A + 1.12], rot: 0, w: 9 },
    { text: 'NEON ARENA', color: '#00f5ff', pos: [0, 4.3, A - 1.12], rot: Math.PI, w: 10 },
    { text: 'NO EXIT', color: '#b6ff4a', pos: [-A + 1.12, 4.4, -7], rot: Math.PI / 2, w: 6 },
    { text: 'SECTOR 07', color: '#ffa23a', pos: [A - 1.12, 4.4, 7], rot: -Math.PI / 2, w: 6.5 }
  ];
  for (const s of wallSigns) {
    const back = new THREE.Mesh(new THREE.BoxGeometry(s.w + 0.5, s.w / 4 - 0.2, 0.6), mats.metalDark);
    back.position.set(...s.pos); back.rotation.y = s.rot; back.translateZ(-0.31); back.castShadow = back.receiveShadow = true; root.add(back);
    const m = new THREE.MeshBasicMaterial({ map: signTexture(s.text, s.color), transparent: true, color: new THREE.Color(2.6, 2.6, 2.6), depthWrite: false });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.w / 4), m);
    sign.position.set(...s.pos); sign.rotation.y = s.rot; sign.translateZ(0.04); root.add(sign);
    const l = new THREE.PointLight(new THREE.Color(s.color), 30, 14, 2);
    l.position.copy(sign.position).add(new THREE.Vector3(Math.sin(s.rot) * 1.6, -0.6, Math.cos(s.rot) * 1.6));
    root.add(l);
    neonEmitters.push(sign.position.clone());
    updaters.push(t => { const f = Math.sin(t * 23 + s.w) > 0.985 ? 0.2 : 1; m.color.setScalar(2.6 * f); l.intensity = 30 * f; });
  }
  const holo = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), holoMaterial('#00f5ff', 'BLACKOUT'));
  holo.position.set(-8, 13, -A - 6); root.add(holo);
  const holo2 = new THREE.Mesh(new THREE.PlaneGeometry(14, 7), holoMaterial('#ff2fb9', 'NEXUS'));
  holo2.position.set(10, 12, A + 7); holo2.rotation.y = Math.PI; root.add(holo2);
  updaters.push(t => { holo.material.uniforms.time.value = t; holo2.material.uniforms.time.value = t + 3; });

  // ---------- floor markings (decals)
  const markMat = new THREE.MeshStandardMaterial({ color: 0xc9c4b0, roughness: 0.7, metalness: 0, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -1, depthWrite: false });
  for (const s of Sim.spawns) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.78, 40), markMat);
    r.rotation.x = -Math.PI / 2; r.position.set(s.x, 0.003, s.z); root.add(r); hideInReflection.push(r);
  }
  for (const [x, z, rot] of [[0, -13.5, 0], [0, 13.5, Math.PI], [-13.5, 0, Math.PI / 2], [13.5, 0, -Math.PI / 2]]) {
    const arrow = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 3), markMat);
    arrow.rotation.set(-Math.PI / 2, 0, rot); arrow.position.set(x, 0.003, z); root.add(arrow); hideInReflection.push(arrow);
  }
  // drains
  for (const [x, z] of [[-10, -10], [10, 10], [-16, 6], [16, -6], [5, -22], [-5, 22]]) batch.box(mats.grate, x, 0.003, z, 1.2, 0.006, 0.5, { cast: false }, 1);

  // ---------- hanging cables between buildings (catenary tubes)
  const cableMat = mats.rubber;
  const cable = (a, b, sag) => {
    const pts = [];
    for (let i = 0; i <= 20; i++) { const t = i / 20; const p = new THREE.Vector3().lerpVectors(a, b, t); p.y -= Math.sin(Math.PI * t) * sag; pts.push(p); }
    batch.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.025, 5, false), cableMat, new THREE.Matrix4(), { cast: true, receive: false });
  };
  cable(new THREE.Vector3(-14, 4.6, -9.5), new THREE.Vector3(-6.5, 4.3, -6.5), 1.0);
  cable(new THREE.Vector3(14, 4.6, 9.5), new THREE.Vector3(6.5, 4.3, 6.5), 1.0);
  cable(new THREE.Vector3(-A + 0.5, 6.5, -12), new THREE.Vector3(-17, 4.6, -12), 0.8);
  cable(new THREE.Vector3(A - 0.5, 6.5, 12), new THREE.Vector3(17, 4.6, 12), 0.8);
  cable(new THREE.Vector3(-2, 5.6, -2), new THREE.Vector3(-6.5, 4.3, -6.5), 0.5);
  cable(new THREE.Vector3(2, 5.6, 2), new THREE.Vector3(6.5, 4.3, 6.5), 0.5);
  cable(new THREE.Vector3(11.5, 4.1, -16.5), new THREE.Vector3(A - 0.5, 6.4, -20), 1.2);
  cable(new THREE.Vector3(-11.5, 4.1, 16.5), new THREE.Vector3(-A + 0.5, 6.4, 20), 1.2);

  // ---------- skyline (merged buildings with emissive windows)
  const sky1 = new StaticBatcher();
  const rand = TX.mulberry32(77);
  const antennaLights = [];
  for (let i = 0; i < 90; i++) {
    const ang = rand() * Math.PI * 2, dist = 48 + rand() * 80;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const w = 5 + rand() * 9, d = 5 + rand() * 9, h = 12 + rand() * (dist > 90 ? 60 : 40);
    sky1.box(mats.windows, x, h / 2 - 1, z, w, h, d, { cast: false, receive: false }, 22, rand() * Math.PI);
    if (rand() > 0.5) antennaLights.push(new THREE.Vector3(x, h + 0.5, z));
  }
  sky1.flush(root);
  const alGeo = new THREE.BufferGeometry().setFromPoints(antennaLights);
  const alMat = new THREE.PointsMaterial({ color: new THREE.Color(3, 0.2, 0.2), size: 0.9, map: TX.radialSprite(64, 0, 2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  root.add(new THREE.Points(alGeo, alMat));
  updaters.push(t => { alMat.opacity = 0.4 + 0.6 * (Math.sin(t * 2.2) > 0 ? 1 : 0.2); });

  // ---------- flying traffic
  const traffic = [];
  const carGeo = new THREE.BoxGeometry(2.4, 0.6, 1.1);
  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(carGeo, mats.metalDark); g.add(body);
    const lightCol = i % 2 ? 0xff2fb9 : 0x00f5ff;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 1.0), neon(lightCol, 8)); tail.position.x = -1.22; g.add(tail);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.9), neon(0xffffff, 6)); head.position.x = 1.22; g.add(head);
    const under = new THREE.Mesh(new THREE.BoxGeometry(2, 0.03, 0.8), neon(lightCol, 3)); under.position.y = -0.31; g.add(under);
    root.add(g);
    traffic.push({ g, r: 45 + rand() * 50, h: 20 + rand() * 25, speed: (0.04 + rand() * 0.05) * (i % 2 ? 1 : -1), phase: rand() * Math.PI * 2, ecc: 0.6 + rand() * 0.4 });
  }
  updaters.push(t => {
    for (const c of traffic) {
      const a = c.phase + t * c.speed;
      c.g.position.set(Math.cos(a) * c.r, c.h + Math.sin(t * 0.5 + c.phase) * 1.5, Math.sin(a) * c.r * c.ecc);
      const ahead = c.phase + (t + 0.1) * c.speed;
      c.g.lookAt(Math.cos(ahead) * c.r, c.g.position.y, Math.sin(ahead) * c.r * c.ecc);
      c.g.rotateY(-Math.PI / 2);
    }
  });

  // ---------- lighting
  scene.add(new THREE.HemisphereLight(0x3a4a7a, 0x0a0812, 1.0));
  const moon = new THREE.DirectionalLight(0x9db8ff, 1.5);
  moon.position.set(-22, 40, 14); moon.target.position.set(0, 0, 0);
  if (Q.shadows) {
    moon.castShadow = true;
    moon.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    const c = moon.shadow.camera; c.left = -34; c.right = 34; c.top = 34; c.bottom = -34; c.near = 5; c.far = 90;
    moon.shadow.bias = -0.0004; moon.shadow.normalBias = 0.035; moon.shadow.radius = 2;
  }
  scene.add(moon, moon.target);

  // Searchlights on towers outside the arena — sweeping, shadow-casting spot lights with light shafts.
  const searchlights = [];
  for (const [x, z, col, ph] of [[-31, -31, 0x9fe8ff, 0], [31, 31, 0xff7ad9, 2.2]]) {
    const towerG = new THREE.Group(); towerG.position.set(x, 0, z); root.add(towerG);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 15, 10), mats.metalDark); mast.position.y = 7.5; towerG.add(mast);
    const headM = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.4, 0.9, 16), mats.metal); headM.position.y = 15.3; towerG.add(headM);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), neon(col, 10)); headM.add(lens);
    const spot = new THREE.SpotLight(col, 2400, 0, 0.2, 0.55, 2);
    spot.position.set(x, 15.3, z);
    if (Q.shadows && Q.spotShadows) { spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0006; spot.shadow.normalBias = 0.04; spot.shadow.camera.near = 5; spot.shadow.camera.far = 70; }
    scene.add(spot, spot.target);
    const coneLen = 34;
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.45, Math.tan(0.2) * coneLen * 1.05, coneLen, 40, 1, true), lightShaftMaterial(col));
    // narrow end at the lamp, extending along +z so Object3D.lookAt() aims it at the target
    cone.geometry.translate(0, -coneLen / 2, 0); cone.geometry.rotateX(-Math.PI / 2);
    cone.position.copy(spot.position); root.add(cone);
    hideInReflection.push(cone);
    searchlights.push({ spot, cone, headM, lens, ph, x, z });
  }
  updaters.push(t => {
    for (const s of searchlights) {
      const tx = Math.sin(t * 0.21 + s.ph) * 15, tz = Math.cos(t * 0.17 + s.ph * 1.7) * 15;
      s.spot.target.position.set(tx, 0, tz); s.spot.target.updateMatrixWorld();
      s.cone.lookAt(tx, 0, tz);
      s.cone.material.uniforms.time.value = t;
      s.headM.lookAt(tx, 0, tz); s.headM.rotateX(Math.PI / 2);
      s.lens.position.set(0, -0.46, 0); s.lens.rotation.x = Math.PI / 2;
    }
  });

  // light shafts under the catwalk lamps / wall lamps (static, cheap)
  for (const [x, z, col] of [[-20, -24.5, 0xffc27a], [20, 24.5, 0xffc27a], [-24.5, 19, 0xffc27a], [24.5, -19, 0xffc27a], [-A + 1.2, -14, 0x7ae8ff], [A - 1.2, 14, 0x7ae8ff]]) {
    const h = x === -A + 1.2 || x === A - 1.2 ? 5.6 : 3.0;
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 1.5, h, 24, 1, true), lightShaftMaterial(col));
    cone.position.set(x, h / 2, z); cone.material.uniforms.intensity.value = 0.32; root.add(cone);
    hideInReflection.push(cone);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, 0.15, 12), neon(col, 6)); lamp.position.set(x, h, z); root.add(lamp);
    if (Q.extraLights || h > 4) { const pl = new THREE.SpotLight(col, 60, 9, 0.6, 0.8, 2); pl.position.set(x, h, z); pl.target.position.set(x, 0, z); scene.add(pl, pl.target); }
    updaters.push(t => { cone.material.uniforms.time.value = t; });
  }

  // ---------- ground mist layers
  const mists = [];
  if (Q.mist) {
    for (const [y, tint] of [[0.25, 0x2a3350], [0.8, 0x2b2245], [1.6, 0x1c2a40]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mistMaterial(y, tint));
      m.rotation.x = -Math.PI / 2; m.position.y = y; m.renderOrder = 5; root.add(m); mists.push(m);
      hideInReflection.push(m);
    }
    updaters.push(t => { for (const m of mists) m.material.uniforms.time.value = t; });
  }

  // ---------- rain
  let rain = null;
  if (Q.rain) {
    const N = Q.rain;
    const pos = new Float32Array(N * 6), seed = new Float32Array(N * 2), tip = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 60, y = Math.random() * 26, z = (Math.random() - 0.5) * 60, s = Math.random();
      pos.set([x, y, z, x, y, z], i * 6); seed[i * 2] = seed[i * 2 + 1] = s; tip[i * 2] = 0; tip[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seed, 1)); g.setAttribute('tip', new THREE.BufferAttribute(tip, 1));
    rain = new THREE.LineSegments(g, rainMaterial()); rain.frustumCulled = false; rain.renderOrder = 10; root.add(rain);
    hideInReflection.push(rain);
  }

  batch.flush(root);
  const city = addNightCity(root, Q);
  updaters.push((t, dt) => city.update(t, dt));
  console.info(`[world] built in ${(performance.now() - T0).toFixed(0)} ms`);

  return {
    root, reflector, neonEmitters, mats,
    update(t, dt, camera) {
      for (const u of updaters) u(t, dt);
      if (rain) { rain.material.uniforms.time.value = t; rain.material.uniforms.center.value.set(camera.position.x, 0, camera.position.z); }
    },
    setSize(w, h) { if (reflector) reflector.getRenderTarget().setSize(Math.round(w * Q.reflectionScale), Math.round(h * Q.reflectionScale)); }
  };
}

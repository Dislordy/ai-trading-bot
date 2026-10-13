// Post-processing chain: scene -> viewmodel (depth cleared) -> bloom -> cinematic
// grade (vignette, chromatic aberration, grain, damage pulse) -> ACES tone mapping.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, damage: { value: 0 }, lowHp: { value: 0 },
    aberration: { value: 0.0012 }, scan: { value: 0 }, dead: { value: 0 }, resolution: { value: new THREE.Vector2(1, 1) }
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time, damage, lowHp, aberration, scan, dead; uniform vec2 resolution; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      // digital glitch when hurt: horizontal block tearing
      float slot = floor(time * 24.0);
      float band = floor(uv.y * 28.0);
      float tear = step(0.86, h(vec2(band, slot))) * smoothstep(0.15, 0.6, damage);
      uv.x += (h(vec2(slot, band)) - 0.5) * 0.07 * tear;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      float ab = aberration * (1.0 + damage * 6.0 + tear * 25.0) * (0.3 + r2 * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv - c * ab * 2.0).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + c * ab * 2.0).b;
      #ifdef STREAKS
      // anamorphic lens streaks: bright neon smears horizontally with a cool blue tint
      // jittered taps (per pixel and per frame) dissolve into a smooth streak instead of ghost copies
      vec3 st = vec3(0.0);
      float jit = h(uv * resolution + fract(time * 7.0) * 61.0);
      for (int i = 0; i < 12; i++) {
        float d = (float(i) + jit) / 12.0;
        float o = d * d * 0.16, w = (1.0 - d) * (1.0 - d);
        st += max(texture2D(tDiffuse, uv + vec2(o, 0.0)).rgb - 2.0, 0.0) * w;
        st += max(texture2D(tDiffuse, uv - vec2(o, 0.0)).rgb - 2.0, 0.0) * w;
      }
      col += min(dot(st, vec3(0.33)), 6.0) * vec3(0.35, 0.6, 1.0) * 0.045;
      #endif
      // megacity grade: teal-shadowed blacks, warm sodium highlights, punchier saturation
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, col * vec3(0.85, 1.0, 1.12), 1.0 - smoothstep(0.0, 0.35, l));
      col = mix(col, col * vec3(1.08, 1.0, 0.86), smoothstep(0.6, 2.0, l));
      col = max(mix(vec3(l), col, 1.18), 0.0);
      col += vec3(0.004, 0.006, 0.012) * (1.0 - smoothstep(0.0, 0.08, l));
      // vignette (+ red pulse when hurt / low health)
      float vig = smoothstep(0.85, 0.2, r2 * 2.2);
      col *= mix(0.55, 1.0, vig);
      float pulse = lowHp * (0.6 + 0.4 * sin(time * 6.0));
      float edge = smoothstep(0.18, 0.75, r2 * 2.0);
      col = mix(col, vec3(0.55, 0.02, 0.05) * (0.6 + l), clamp(edge * (damage * 0.55 + pulse * 0.45), 0.0, 0.6));
      // scan pulse tint
      col += vec3(0.25, 0.5, 0.05) * scan * edge;
      // death desaturation
      col = mix(col, vec3(l) * vec3(1.0, 0.85, 0.85), dead * 0.8);
      // film grain + faint scanlines
      float g = h(vUv * resolution + fract(time) * 100.0) - 0.5;
      col += g * 0.025 * (1.0 + damage);
      col *= 0.985 + 0.015 * sin(vUv.y * resolution.y * 1.5);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`
};

export function createPost(renderer, scene, camera, vmScene, vmCamera, Q) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: Q.msaa });
  const composer = new EffectComposer(renderer, rt);
  // EffectComposer treats a custom target's size as CSS pixels; normalise via setSize below.
  const css = renderer.getSize(new THREE.Vector2());
  composer.addPass(new RenderPass(scene, camera));
  const vm = new RenderPass(vmScene, vmCamera); vm.clear = false; vm.clearDepth = true;
  composer.addPass(vm);
  let bloom = null;
  if (Q.bloom) {
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.7, 0.55, 0.85);
    composer.addPass(bloom);
  }
  const grade = new ShaderPass(GradeShader);
  if (Q.bloom) { grade.material.defines.STREAKS = ''; grade.material.needsUpdate = true; }
  grade.uniforms.resolution.value.set(size.x, size.y);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  composer.setSize(css.x, css.y);
  return {
    composer, grade, bloom,
    render(dt) { grade.uniforms.time.value += dt; composer.render(dt); },
    setSize(w, h) {
      composer.setSize(w, h);
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      grade.uniforms.resolution.value.set(s.x, s.y);
    }
  };
}

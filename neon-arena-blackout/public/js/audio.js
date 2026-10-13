// Procedurally synthesised audio with HRTF positional panning, distance-based
// gunshot variants, wall occlusion (low-pass muffling) and a convolution reverb bus.
const Sim = window.NeonSim;

// ------------------------------------------------------------------ DSP helpers
const TAU = Math.PI * 2;
function lp(buf, fc, sr) { const a = 1 - Math.exp(-TAU * fc / sr); let y = 0; for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = y; } return buf; }
function hp(buf, fc, sr) { const a = 1 - Math.exp(-TAU * fc / sr); let y = 0; for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = buf[i] - y; } return buf; }
function noise(n, seed = 1) { const b = new Float32Array(n); let s = seed * 9301 + 49297; for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; b[i] = (s / 2147483647) * 2 - 1; } return b; }
function normalize(b, peak = 0.9) { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i])); if (m > 0) for (let i = 0; i < b.length; i++) b[i] *= peak / m; return b; }
function softclip(b, drive = 1.5) { for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i] * drive); return b; }
function fadeEdges(b, sr, ms = 3) { const n = Math.min(b.length >> 1, Math.round(sr * ms / 1000)); for (let i = 0; i < n; i++) { const k = i / n; b[i] *= k; b[b.length - 1 - i] *= k; } return b; }
function sweepSine(n, sr, f0, f1, decay, { k = 1, phase = 0, shape = 'sin' } = {}) {
  const b = new Float32Array(n); let ph = phase;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = f1 + (f0 - f1) * Math.exp(-t * k * 10);
    ph += TAU * f / sr;
    const s = shape === 'saw' ? ((ph / TAU) % 1) * 2 - 1 : Math.sin(ph);
    b[i] = s * Math.exp(-t * decay);
  }
  return b;
}
function partials(n, sr, freqs, decays, amps) {
  const b = new Float32Array(n);
  for (let p = 0; p < freqs.length; p++) for (let i = 0; i < n; i++) b[i] += Math.sin(TAU * freqs[p] * i / sr) * Math.exp(-i / sr * decays[p]) * amps[p];
  return b;
}
function mixInto(dst, src, gain = 1, offset = 0) { for (let i = 0; i < src.length && i + offset < dst.length; i++) dst[i + offset] += src[i] * gain; return dst; }
function env(b, sr, fn) { for (let i = 0; i < b.length; i++) b[i] *= fn(i / sr); return b; }

// ------------------------------------------------------------------ sound designs
const designs = {
  shot(sr) {
    const n = Math.round(sr * 0.7), out = new Float32Array(n);
    mixInto(out, env(hp(noise(n, 3), 2500, sr), sr, t => Math.exp(-t * 95)), 0.9);
    mixInto(out, env(lp(noise(n, 4), 1600, sr), sr, t => Math.exp(-t * 16)), 0.8);
    mixInto(out, sweepSine(n, sr, 170, 42, 22, { k: 2.5 }), 1.1);
    mixInto(out, sweepSine(n, sr, 2600, 380, 26, { k: 1.4, shape: 'saw' }), 0.18);
    mixInto(out, env(lp(noise(n, 5), 700, sr), sr, t => Math.exp(-t * 4.5) * Math.min(1, t * 40)), 0.25);
    return fadeEdges(normalize(softclip(out, 1.8), 0.95), sr);
  },
  shotFar(sr) {
    const b = designs.shot(sr), n = Math.round(sr * 1.3), out = new Float32Array(n);
    mixInto(out, lp(lp(b, 1100, sr), 900, sr), 1);
    mixInto(out, env(lp(noise(n, 6), 400, sr), sr, t => Math.exp(-t * 2.6) * Math.min(1, t * 15)), 0.25);
    return fadeEdges(normalize(out, 0.8), sr);
  },
  dry(sr) {
    const n = Math.round(sr * 0.08), out = new Float32Array(n);
    mixInto(out, env(hp(noise(n, 7), 3000, sr), sr, t => Math.exp(-t * 300)), 0.6);
    mixInto(out, partials(n, sr, [3100, 5300], [120, 160], [0.4, 0.2]));
    return fadeEdges(normalize(out, 0.6), sr);
  },
  magOut(sr) {
    const n = Math.round(sr * 0.35), out = new Float32Array(n);
    mixInto(out, env(lp(hp(noise(n, 8), 800, sr), 4000, sr), sr, t => Math.exp(-t * 18) * Math.min(1, t * 60)), 0.5);
    mixInto(out, partials(Math.round(sr * 0.1), sr, [2300, 3900], [60, 80], [0.5, 0.3]));
    mixInto(out, partials(Math.round(sr * 0.12), sr, [1700, 3100], [50, 70], [0.4, 0.25]), 1, Math.round(sr * 0.12));
    return fadeEdges(normalize(out, 0.7), sr);
  },
  magIn(sr) {
    const n = Math.round(sr * 0.3), out = new Float32Array(n);
    mixInto(out, sweepSine(n, sr, 260, 140, 30), 0.8);
    mixInto(out, env(lp(noise(n, 9), 2500, sr), sr, t => Math.exp(-t * 60)), 0.7);
    mixInto(out, partials(Math.round(sr * 0.08), sr, [2900, 4700], [70, 90], [0.5, 0.3]), 1, Math.round(sr * 0.05));
    return fadeEdges(normalize(out, 0.85), sr);
  },
  charge(sr) {
    const n = Math.round(sr * 0.4), out = new Float32Array(n);
    for (const [off, f] of [[0, 2600], [0.11, 3400]]) {
      const o = Math.round(off * sr);
      mixInto(out, env(hp(noise(Math.round(sr * 0.05), 10 + off * 9), 2000, sr), sr, t => Math.exp(-t * 120)), 0.7, o);
      mixInto(out, partials(Math.round(sr * 0.2), sr, [f, f * 1.47, f * 2.13], [25, 35, 45], [0.35, 0.2, 0.12]), 1, o);
    }
    return fadeEdges(normalize(out, 0.8), sr);
  },
  hit(sr) {
    const n = Math.round(sr * 0.09);
    return fadeEdges(normalize(partials(n, sr, [1900, 3800], [55, 70], [1, 0.4]), 0.6), sr);
  },
  headshot(sr) {
    const n = Math.round(sr * 0.45), out = partials(n, sr, [2350, 4700, 7050, 3130], [9, 12, 16, 10], [1, 0.45, 0.2, 0.3]);
    mixInto(out, env(hp(noise(n, 11), 4000, sr), sr, t => Math.exp(-t * 200)), 0.5);
    return fadeEdges(normalize(out, 0.7), sr);
  },
  kill(sr) {
    const n = Math.round(sr * 0.55), out = new Float32Array(n);
    mixInto(out, env(partials(Math.round(sr * 0.25), sr, [880, 1760], [8, 10], [1, 0.3]), sr, t => Math.min(1, t * 200)));
    mixInto(out, env(partials(Math.round(sr * 0.4), sr, [1320, 2640, 1980], [7, 9, 8], [1, 0.3, 0.2]), sr, t => Math.min(1, t * 200)), 1, Math.round(sr * 0.09));
    return fadeEdges(normalize(out, 0.6), sr);
  },
  impactMetal(sr) {
    const n = Math.round(sr * 0.3), out = partials(n, sr, [1180, 2730, 4330, 6100], [16, 22, 30, 40], [0.6, 0.5, 0.35, 0.2]);
    mixInto(out, env(hp(noise(n, 12), 1500, sr), sr, t => Math.exp(-t * 90)), 0.9);
    return fadeEdges(normalize(out, 0.8), sr);
  },
  impactConcrete(sr) {
    const n = Math.round(sr * 0.22), out = env(lp(noise(n, 13), 2200, sr), sr, t => Math.exp(-t * 45));
    mixInto(out, sweepSine(n, sr, 160, 70, 35), 0.6);
    return fadeEdges(normalize(out, 0.8), sr);
  },
  impactWater(sr) {
    const n = Math.round(sr * 0.25), out = env(hp(noise(n, 14), 1800, sr), sr, t => Math.exp(-t * 28) * Math.min(1, t * 300));
    mixInto(out, sweepSine(n, sr, 900, 2600, 30, { k: 0.6 }), 0.15);
    return fadeEdges(normalize(out, 0.7), sr);
  },
  impactBody(sr) {
    const n = Math.round(sr * 0.2), out = sweepSine(n, sr, 900, 180, 25, { k: 1.5, shape: 'saw' });
    mixInto(out, env(lp(noise(n, 15), 1200, sr), sr, t => Math.exp(-t * 40)), 0.8);
    mixInto(out, sweepSine(n, sr, 120, 60, 30), 0.8);
    return fadeEdges(normalize(softclip(out, 2), 0.8), sr);
  },
  step(sr, v = 0) {
    const n = Math.round(sr * 0.16), out = env(lp(noise(n, 20 + v), 900 + v * 150, sr), sr, t => Math.exp(-t * 55) * Math.min(1, t * 500));
    mixInto(out, sweepSine(n, sr, 110 + v * 8, 60, 45), 0.7);
    mixInto(out, env(hp(noise(n, 30 + v), 3500, sr), sr, t => Math.exp(-t * 35) * Math.min(1, t * 200)), 0.25); // wet splash
    return fadeEdges(normalize(out, 0.6), sr);
  },
  land(sr) {
    const n = Math.round(sr * 0.3), out = env(lp(noise(n, 40), 700, sr), sr, t => Math.exp(-t * 25));
    mixInto(out, sweepSine(n, sr, 95, 45, 18), 1);
    mixInto(out, env(hp(noise(n, 41), 3000, sr), sr, t => Math.exp(-t * 20)), 0.3);
    return fadeEdges(normalize(out, 0.75), sr);
  },
  jump(sr) {
    const n = Math.round(sr * 0.2);
    return fadeEdges(normalize(env(lp(hp(noise(n, 42), 400, sr), 2500, sr), sr, t => Math.sin(Math.PI * t / 0.2) ** 2), 0.35), sr);
  },
  dash(sr) {
    const n = Math.round(sr * 0.45), src = noise(n, 43), out = new Float32Array(n);
    // swept band-pass via moving one-pole filters
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, fc = 300 + 3500 * Math.sin(Math.PI * Math.min(1, t / 0.4)) ** 2;
      const a = 1 - Math.exp(-TAU * fc / sr), a2 = 1 - Math.exp(-TAU * fc * 0.5 / sr);
      y1 += a * (src[i] - y1); y2 += a2 * (y1 - y2);
      out[i] = (y1 - y2) * Math.sin(Math.PI * Math.min(1, t / 0.45));
    }
    mixInto(out, sweepSine(n, sr, 200, 900, 6, { k: 0.4, shape: 'saw' }), 0.08);
    return fadeEdges(normalize(out, 0.7), sr);
  },
  shield(sr) {
    const n = Math.round(sr * 0.8), out = new Float32Array(n);
    for (const d of [1, 1.006, 0.994]) mixInto(out, env(sweepSine(n, sr, 260 * d, 820 * d, 0, { k: 0.25 }), sr, t => Math.min(1, t * 20) * Math.exp(-t * 3.5)), 0.4);
    mixInto(out, env(hp(noise(n, 44), 5000, sr), sr, t => Math.exp(-t * 6)), 0.1);
    return fadeEdges(normalize(out, 0.6), sr);
  },
  scan(sr) {
    const n = Math.round(sr * 1.6), out = new Float32Array(n);
    for (let r = 0; r < 4; r++) mixInto(out, partials(Math.round(sr * 0.5), sr, [1250, 2500], [9, 14], [1, 0.25]), Math.pow(0.45, r), Math.round(sr * r * 0.28));
    return fadeEdges(normalize(out, 0.6), sr);
  },
  hurt(sr) {
    const n = Math.round(sr * 0.35), out = sweepSine(n, sr, 140, 50, 14);
    mixInto(out, env(lp(noise(n, 45), 900, sr), sr, t => Math.exp(-t * 18)), 0.9);
    return fadeEdges(normalize(softclip(out, 3), 0.9), sr);
  },
  respawn(sr) {
    const n = Math.round(sr * 0.9), out = new Float32Array(n);
    for (const f of [220, 330, 440]) mixInto(out, env(sweepSine(n, sr, f, f * 2, 0, { k: 0.3, shape: 'saw' }), sr, t => Math.min(1, t * 8) * Math.exp(-t * 4)), 0.2);
    return fadeEdges(normalize(lp(out, 3000, sr), 0.5), sr);
  },
  tink(sr) {
    const n = Math.round(sr * 0.12);
    return fadeEdges(normalize(partials(n, sr, [4200, 6900, 9100], [40, 50, 70], [1, 0.6, 0.3]), 0.4), sr);
  },
  death(sr) {
    const n = Math.round(sr * 1.2), out = sweepSine(n, sr, 1200, 60, 3, { k: 0.5, shape: 'saw' });
    mixInto(out, env(lp(noise(n, 46), 1500, sr), sr, t => Math.exp(-t * 4)), 0.8);
    mixInto(out, sweepSine(n, sr, 90, 30, 4), 1);
    return fadeEdges(normalize(lp(softclip(out, 2), 4000, sr), 0.85), sr);
  },
  // loops
  rain(sr) {
    const n = Math.round(sr * 4), out = lp(hp(noise(n, 50), 600, sr), 6000, sr);
    for (let i = 0; i < out.length; i++) out[i] *= 0.35;
    const drop = partials(Math.round(sr * 0.02), sr, [3000], [200], [1]);
    let s = 7; for (let k = 0; k < 400; k++) { s = (s * 16807) % 2147483647; mixInto(out, drop, 0.15 + (s % 100) / 400, s % (n - drop.length)); }
    return loopable(out, sr);
  },
  hum(sr) {
    const n = Math.round(sr * 4), out = new Float32Array(n);
    for (const [f, a] of [[55, 0.5], [110, 0.25], [82.5, 0.15], [55.4, 0.4]]) for (let i = 0; i < n; i++) out[i] += Math.sin(TAU * f * i / sr) * a;
    mixInto(out, lp(noise(n, 51), 250, sr), 1.2);
    return loopable(normalize(out, 0.5), sr);
  },
  buzz(sr) {
    const n = Math.round(sr * 1), out = new Float32Array(n);
    for (let h = 1; h <= 8; h++) for (let i = 0; i < n; i++) out[i] += Math.sin(TAU * 120 * h * i / sr) / h * (h % 2 ? 1 : 0.5);
    lp(out, 1800, sr);
    mixInto(out, hp(noise(n, 52), 6000, sr), 0.05);
    return loopable(normalize(out, 0.5), sr);
  }
};
function loopable(b, sr) {
  // crossfade the tail into the head so the buffer loops seamlessly
  const x = Math.round(sr * 0.2), out = b.slice(0, b.length - x);
  for (let i = 0; i < x; i++) { const k = i / x; out[i] = out[i] * k + b[b.length - x + i] * (1 - k); }
  return out;
}

// ------------------------------------------------------------------ engine
export class AudioEngine {
  constructor() { this.ctx = null; this.buffers = {}; this.voices = 0; this.enabled = false; this.volume = 0.8; }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    const sr = ctx.sampleRate;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(ctx.destination);
    // convolution reverb bus (synthesised impulse response of a large concrete space)
    this.reverb = ctx.createConvolver();
    const irLen = Math.round(sr * 1.9), ir = ctx.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c), nz = noise(irLen, 60 + c); for (let i = 0; i < irLen; i++) d[i] = nz[i] * Math.exp(-i / sr * 3.2) * (i < sr * 0.01 ? i / (sr * 0.01) : 1); lp(d, 5000, sr); }
    this.reverb.buffer = ir;
    this.reverbGain = ctx.createGain(); this.reverbGain.gain.value = 0.35;
    this.reverb.connect(this.reverbGain); this.reverbGain.connect(this.master);
    for (const [name, fn] of Object.entries(designs)) {
      if (name === 'step') { for (let v = 0; v < 4; v++) this.buffers['step' + v] = this.toBuffer(fn(sr, v)); continue; }
      this.buffers[name] = this.toBuffer(fn(sr));
    }
    this.enabled = true;
  }
  toBuffer(data) { const b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate); b.copyToChannel(data, 0); return b; }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** Update the listener from the camera every frame. */
  updateListener(camera) {
    if (!this.enabled) return;
    const L = this.ctx.listener, e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14], fx = -e[8], fy = -e[9], fz = -e[10], ux = e[4], uy = e[5], uz = e[6];
    this.listenerPos = { x: px, y: py, z: pz };
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(px, t); L.positionY.setValueAtTime(py, t); L.positionZ.setValueAtTime(pz, t);
      L.forwardX.setValueAtTime(fx, t); L.forwardY.setValueAtTime(fy, t); L.forwardZ.setValueAtTime(fz, t);
      L.upX.setValueAtTime(ux, t); L.upY.setValueAtTime(uy, t); L.upZ.setValueAtTime(uz, t);
    } else { L.setPosition(px, py, pz); L.setOrientation(fx, fy, fz, ux, uy, uz); }
  }

  occluded(pos) {
    const l = this.listenerPos; if (!l) return false;
    const d = { x: pos.x - l.x, y: pos.y - l.y, z: pos.z - l.z }, len = Math.hypot(d.x, d.y, d.z);
    if (len < 0.5) return false;
    d.x /= len; d.y /= len; d.z /= len;
    const h = Sim.raycastWorld(l, d, len - 0.3);
    return !!(h && h.kind !== 'floor');
  }

  /**
   * Play a sound. opts: { pos (world position => 3D), volume, rate, reverb, detune }
   */
  play(name, opts = {}) {
    if (!this.enabled || this.voices > 56) return null;
    let buf = this.buffers[name];
    if (!buf) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    const vol = opts.volume !== undefined ? opts.volume : 1;
    src.playbackRate.value = (opts.rate || 1) * (1 + (Math.random() - 0.5) * (opts.vary !== undefined ? opts.vary : 0.06));
    const g = ctx.createGain(); g.gain.value = vol;
    let node = src;
    if (opts.pos) {
      if (this.occluded(opts.pos)) {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 0.5;
        node.connect(f); node = f; g.gain.value = vol * 0.55;
      }
      const p = ctx.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
      p.refDistance = opts.ref || 2.5; p.maxDistance = 120; p.rolloffFactor = opts.rolloff || 1.1;
      if (p.positionX) { p.positionX.value = opts.pos.x; p.positionY.value = opts.pos.y; p.positionZ.value = opts.pos.z; } else p.setPosition(opts.pos.x, opts.pos.y, opts.pos.z);
      node.connect(p); node = p;
    }
    node.connect(g); g.connect(this.master);
    const rv = opts.reverb !== undefined ? opts.reverb : 0.3;
    if (rv > 0) { const s = ctx.createGain(); s.gain.value = rv; g.connect(s); s.connect(this.reverb); }
    src.start();
    this.voices++;
    src.onended = () => { this.voices--; g.disconnect(); };
    return src;
  }

  /** Remote gunshot: near/far variants by distance. */
  gunshot(pos, own = false) {
    if (own) return this.play('shot', { volume: 0.55, reverb: 0.25 });
    const l = this.listenerPos || pos;
    const d = Math.hypot(pos.x - l.x, pos.y - l.y, pos.z - l.z);
    return this.play(d > 22 ? 'shotFar' : 'shot', { pos, volume: d > 22 ? 1.4 : 1.1, reverb: 0.45, ref: 4 });
  }

  /** Start ambient loops (rain, city hum, neon buzz at sign positions). */
  startAmbience(emitters = []) {
    if (!this.enabled || this.ambience) return;
    this.ambience = [];
    const loop = (name, vol, pos) => {
      const src = this.ctx.createBufferSource(); src.buffer = this.buffers[name]; src.loop = true;
      const g = this.ctx.createGain(); g.gain.value = vol;
      let node = src;
      if (pos) {
        const p = this.ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1.2; p.rolloffFactor = 1.6;
        if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
        src.connect(p); node = p;
      }
      node.connect(g); g.connect(this.master);
      src.start(0, Math.random() * src.buffer.duration);
      this.ambience.push(src);
    };
    loop('rain', 0.22); loop('hum', 0.18);
    for (const e of emitters.slice(0, 8)) loop('buzz', 0.05, e);
  }
}

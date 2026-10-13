// NEON ARENA: BLACKOUT — client entry point.
// Client-side prediction + server reconciliation for the local player,
// snapshot interpolation for remote players, effects/audio/HUD orchestration.
import * as THREE from 'three';
import { installHeightFog, createWorld } from './world.js';
import { Effects, groundHeight } from './effects.js';
import { Weapon } from './weapon.js';
import { Avatar } from './avatar.js';
import { AudioEngine } from './audio.js';
import { createPost } from './post.js';
import { Hud, escapeHtml } from './hud.js';

const Sim = window.NeonSim;
const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ settings & quality
const PRESETS = {
  low: { pixelRatio: 1, textures: 256, shadows: false, shadowSize: 0, spotShadows: false, reflections: false, reflectionScale: 0, bloom: false, msaa: 0, mist: false, rain: 0, particles: 700, dust: 0, flashLights: 1, extraLights: false },
  medium: { pixelRatio: 1.25, textures: 512, shadows: true, shadowSize: 1024, spotShadows: false, reflections: true, reflectionScale: 0.35, bloom: true, msaa: 0, mist: true, rain: 2500, particles: 1400, dust: 300, flashLights: 2, extraLights: false },
  high: { pixelRatio: 1.5, textures: 512, shadows: true, shadowSize: 2048, spotShadows: true, reflections: true, reflectionScale: 0.5, bloom: true, msaa: 4, mist: true, rain: 4000, particles: 2200, dust: 600, flashLights: 3, extraLights: false },
  ultra: { pixelRatio: 2, textures: 1024, shadows: true, shadowSize: 4096, spotShadows: true, reflections: true, reflectionScale: 0.75, bloom: true, msaa: 4, mist: true, rain: 6000, particles: 3200, dust: 900, flashLights: 4, extraLights: true }
};
const store = { get(k, d) { try { const v = localStorage.getItem('nab.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('nab.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } } };
const isTouch = matchMedia('(pointer:coarse)').matches;
const qualityName = new URLSearchParams(location.search).get('quality') || store.get('quality', isTouch ? 'low' : 'high');
const Q = PRESETS[qualityName] || PRESETS.high;
let sensitivity = store.get('sens', 1);
const audio = new AudioEngine();
audio.volume = store.get('vol', 0.8);

$('qualitySel').value = qualityName;
$('qualitySel').onchange = e => { store.set('quality', e.target.value); location.reload(); };
$('sensRange').value = sensitivity;
$('sensRange').oninput = e => { sensitivity = Number(e.target.value); store.set('sens', sensitivity); };
$('volRange').value = audio.volume;
$('volRange').oninput = e => { audio.setVolume(Number(e.target.value)); store.set('vol', Number(e.target.value)); };

// ------------------------------------------------------------------ renderer & scene
installHeightFog();
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
renderer.shadowMap.enabled = Q.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('scene').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);

let world, fx, weapon, post, hud;
const avatars = new Map();

// ------------------------------------------------------------------ network state
const socket = io({ transports: ['websocket', 'polling'] });
let myId = null, roomCode = null, isHost = false, meta = null, phase = 'home';
let serverOffset = null, lastSnapAt = 0, ping = 0;
const serverNow = () => performance.now() + (serverOffset || 0);
const renderServerTime = () => serverNow() - Sim.INTERP_DELAY_MS;

const local = {
  sim: Sim.newPlayerState(), prev: Sim.newPlayerState(), seq: 0, pending: [], outbox: [], acc: 0,
  yaw: 0, pitch: 0, recoilPitch: 0, recoilYaw: 0, hp: 100, alive: true, errorOffset: new THREE.Vector3(),
  cd: { shield: 0, scan: 0, shieldOn: 0 }, cdAt: 0, killedBy: '', deadAt: 0, stepDist: 0, wasOg: true,
  shotsInBurst: 0, lastFireT: 0
};
const remotes = new Map(); // id -> { buffer: [], state, stepDist, xrayUntil, lastFlags }

// ------------------------------------------------------------------ input
const keys = {};
let pointerLocked = false, mouseDown = false, aimDown = false, dashQueued = false, reloadQueued = false, mouseDX = 0, mouseDY = 0;
const mobileMove = { x: 0, z: 0 };
let mobileFire = false, mobileJump = false;
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
  if (e.repeat || phase !== 'playing') return;
  if (e.code === 'KeyR') reloadQueued = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dashQueued = true;
  if (e.code === 'KeyQ') ability('shield');
  if (e.code === 'KeyE') ability('scan');
  if (e.code === 'Tab') $('scoreboard').classList.remove('hidden');
});
document.addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') $('scoreboard').classList.add('hidden'); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = aimDown = false; });
renderer.domElement.addEventListener('click', () => { if (phase === 'playing' && !isTouch && renderer.domElement.requestPointerLock) renderer.domElement.requestPointerLock(); });
let skipMouse = 0;
document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === renderer.domElement; skipMouse = 2; if (!pointerLocked) mouseDown = aimDown = false; });
document.addEventListener('mousemove', e => {
  if (!pointerLocked || phase !== 'playing') return;
  // Browsers can report a huge bogus delta right after the pointer locks; drop it.
  if (skipMouse > 0) { skipMouse--; return; }
  if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
  const k = 0.0021 * sensitivity * (aimDown ? 0.6 : 1);
  local.yaw -= e.movementX * k; local.pitch = THREE.MathUtils.clamp(local.pitch - e.movementY * k, -1.4, 1.4);
  mouseDX += e.movementX; mouseDY += e.movementY;
});
document.addEventListener('mousedown', e => { if (!pointerLocked) return; if (e.button === 0) mouseDown = true; if (e.button === 2) aimDown = true; });
document.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; if (e.button === 2) aimDown = false; });
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('pointerdown', () => { audio.init(); if (world && audio.enabled) audio.startAmbience(world.neonEmitters); }, { capture: true });
$('dashBtn').onclick = () => { dashQueued = true; };
$('shieldBtn').onclick = () => ability('shield');
$('scanBtn').onclick = () => ability('scan');
function ability(type) { if (phase === 'playing' && local.alive) socket.emit('ability', { type }); }

// mobile controls
const stick = $('stick'), knob = $('knob'); let stickPointer = null, lookTouch = null, touchLast = null;
stick.addEventListener('pointerdown', e => { stickPointer = e.pointerId; stick.setPointerCapture(e.pointerId); moveStick(e); });
stick.addEventListener('pointermove', e => { if (e.pointerId === stickPointer) moveStick(e); });
function moveStick(e) {
  const r = stick.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = e.clientX - cx, dy = e.clientY - cy; const l = Math.hypot(dx, dy), max = 36;
  if (l > max) { dx = dx / l * max; dy = dy / l * max; }
  knob.style.left = (35 + dx) + 'px'; knob.style.top = (35 + dy) + 'px'; mobileMove.x = dx / max; mobileMove.z = -dy / max;
}
const resetStick = () => { stickPointer = null; mobileMove.x = mobileMove.z = 0; knob.style.left = '35px'; knob.style.top = '35px'; };
stick.addEventListener('pointerup', resetStick); stick.addEventListener('pointercancel', resetStick);
$('lookZone').addEventListener('pointerdown', e => { lookTouch = e.pointerId; touchLast = { x: e.clientX, y: e.clientY }; $('lookZone').setPointerCapture(e.pointerId); });
$('lookZone').addEventListener('pointermove', e => {
  if (e.pointerId !== lookTouch || !touchLast) return;
  const dx = e.clientX - touchLast.x, dy = e.clientY - touchLast.y;
  local.yaw -= dx * 0.006 * sensitivity; local.pitch = THREE.MathUtils.clamp(local.pitch - dy * 0.006 * sensitivity, -1.3, 1.3);
  mouseDX += dx * 2; mouseDY += dy * 2; touchLast = { x: e.clientX, y: e.clientY };
});
$('lookZone').addEventListener('pointerup', () => { lookTouch = null; touchLast = null; });
$('mobileFire').addEventListener('pointerdown', e => { e.preventDefault(); mobileFire = true; });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('mobileFire').addEventListener(ev, () => { mobileFire = false; });
$('mobileJump').addEventListener('pointerdown', () => { mobileJump = true; setTimeout(() => { mobileJump = false; }, 120); });
$('mobileReload').addEventListener('pointerdown', () => { reloadQueued = true; });

// ------------------------------------------------------------------ menus
function setScreen(s) {
  phase = s;
  for (const id of ['home', 'lobby', 'gameHud', 'results']) $(id).classList.add('hidden');
  if (s === 'home') $('home').classList.remove('hidden');
  if (s === 'lobby') $('lobby').classList.remove('hidden');
  if (s === 'playing') $('gameHud').classList.remove('hidden');
  if (s === 'results') $('results').classList.remove('hidden');
  $('mobileControls').classList.toggle('off', s !== 'playing');
  if (s !== 'playing' && document.pointerLockElement) document.exitPointerLock();
}
const showError = t => { $('homeError').textContent = t || ''; };
function connectResult(res) {
  if (!res || !res.ok) { showError(res?.error || 'Connection failed'); return; }
  myId = res.playerId; roomCode = res.code; isHost = res.host;
  $('roomCode').textContent = roomCode;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('lobbyHint').textContent = isHost ? 'You are the host. Start when at least two runners are connected.' : 'Connected. Waiting for the host to start.';
  setScreen('lobby'); showError('');
}
$('createBtn').onclick = () => socket.emit('createRoom', { name: $('nickname').value }, connectResult);
$('showJoinBtn').onclick = () => { $('joinRow').classList.toggle('hidden'); $('roomInput').focus(); };
$('joinBtn').onclick = () => socket.emit('joinRoom', { name: $('nickname').value, code: $('roomInput').value }, connectResult);
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nickname').addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });
$('nickname').value = store.get('name', 'Runner');
$('nickname').addEventListener('change', e => store.set('name', e.target.value));
$('startBtn').onclick = () => socket.emit('startMatch');
$('copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(roomCode); $('copyBtn').textContent = 'CODE COPIED'; } catch { $('copyBtn').textContent = 'ROOM CODE: ' + roomCode; } };
function leave() { if (socket.connected) socket.disconnect(); location.reload(); }
$('leaveBtn').onclick = leave; $('resultsLeaveBtn').onclick = leave;
$('rematchBtn').onclick = () => { socket.emit('rematch'); $('results').classList.add('hidden'); };

// ------------------------------------------------------------------ socket events
socket.on('connect_error', () => showError('Cannot connect to the game server. Refresh and try again.'));
socket.on('notice', t => hud && hud.notice(t));

socket.on('state', state => {
  meta = state;
  syncAvatars(state.players);
  isHost = state.host === myId;
  if (state.phase === 'lobby') {
    if (phase !== 'lobby' && phase !== 'home') setScreen('lobby');
    if (phase === 'home' && myId) setScreen('lobby');
    $('roomCode').textContent = state.code;
    $('lobbyPlayers').innerHTML = state.players.map(p => `<div class="playerpill"><b style="color:${p.color}">◆</b>${escapeHtml(p.name)}${p.id === state.host ? ' <small style="color:#789">HOST</small>' : ''}</div>`).join('');
    $('startBtn').disabled = state.players.length < 2;
    $('startBtn').textContent = state.players.length < 2 ? 'Start match — need 2 players' : 'Start match';
    $('lobbyHint').textContent = `${state.players.length}/8 runners connected` + (isHost ? ' · you are the host' : '');
    $('startBtn').classList.toggle('hidden', !isHost);
  } else if (state.phase === 'playing') {
    if (phase !== 'playing') enterMatch();
    const me = state.players.find(p => p.id === myId);
    if (me && hud) hud.score(me.score);
    if (hud) { hud.timer(state.timeLeft); hud.leaderboard(state.players, myId); hud.feed(state.feed); }
  } else if (state.phase === 'results') {
    if (phase !== 'results') setScreen('results');
  }
});

function enterMatch() {
  setScreen('playing');
  local.pending.length = 0; local.outbox.length = 0; local.acc = 0;
  for (const r of remotes.values()) r.buffer.length = 0;
  hud.notice('BLACKOUT INITIATED', 1600);
  weapon.respawn();
  if (!isTouch && renderer.domElement.requestPointerLock) renderer.domElement.requestPointerLock();
}
socket.on('matchStarted', () => { if (phase !== 'playing' && world) enterMatch(); });

socket.on('matchEnded', data => {
  $('winnerName').textContent = data.winner;
  $('resultRows').innerHTML = data.rankings.map(r => `<div class="resultrow"><b>#${r.place}</b><span><i style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${r.color}"></i>${escapeHtml(r.name)}<small style="display:block;color:#789">${r.kills} eliminations · ${r.deaths} defeats</small></span><b>${r.score}</b></div>`).join('');
  $('rematchBtn').classList.toggle('hidden', !isHost);
  setScreen('results');
});

socket.on('snap', snap => {
  const nowT = performance.now();
  const sample = snap.t - nowT;
  if (serverOffset === null || sample > serverOffset) serverOffset = sample; else serverOffset += (sample - serverOffset) * 0.02;
  lastSnapAt = nowT;
  local.hp = snap.hp;
  local.cd = snap.cd; local.cdAt = nowT;
  reconcile(snap);
  for (const e of snap.ps) {
    const [id, x, y, z, yaw, pitch, flags, vx, vz] = e;
    if (id === myId) continue;
    let r = remotes.get(id);
    if (!r) { r = { buffer: [], stepDist: 0, xrayUntil: 0, state: null, lastFlags: flags, dashT: 0 }; remotes.set(id, r); }
    r.buffer.push({ t: snap.t, x, y, z, yaw, pitch, flags, vx, vz });
    if (r.buffer.length > 40) r.buffer.shift();
  }
});

function reconcile(snap) {
  const s = local.sim;
  const wasAlive = local.alive;
  local.pending = local.pending.filter(i => i.s > snap.ack);
  const old = { x: s.x, y: s.y, z: s.z };
  Sim.copyState(snap.me, s);
  for (const input of local.pending) Sim.stepPlayer(s, input);
  local.alive = s.alive;
  if (snap.tp) {
    Sim.copyState(s, local.prev);
    local.errorOffset.set(0, 0, 0);
    local.yaw = snap.me.yaw; local.pitch = 0;
  } else {
    const dx = old.x - s.x, dy = old.y - s.y, dz = old.z - s.z;
    if (dx * dx + dy * dy + dz * dz > 9) { local.errorOffset.set(0, 0, 0); Sim.copyState(s, local.prev); }
    else { local.errorOffset.x += dx; local.errorOffset.y += dy; local.errorOffset.z += dz; local.prev.x -= dx; local.prev.y -= dy; local.prev.z -= dz; }
  }
  if (!wasAlive && local.alive) { /* respawn handled by 'respawned' event */ }
}

socket.on('shot', shot => {
  const shooter = avatars.get(shot.id);
  const end = new THREE.Vector3(...shot.e);
  const r = remotes.get(shot.id);
  const muzzle = shooter && r && r.state && r.state.alive ? shooter.muzzleWorld(new THREE.Vector3()) : new THREE.Vector3(...shot.o);
  const dir = end.clone().sub(muzzle).normalize();
  fx.tracer(muzzle, end, shooter ? shooter.color : 0xff36c7);
  fx.muzzleFlash(muzzle, dir, shooter ? shooter.color.clone().lerp(new THREE.Color(0xffd0a0), 0.5) : 0xffb070, 0.6);
  audio.gunshot(muzzle);
  if (shot.h) {
    const victim = avatars.get(shot.h);
    fx.playerHit(end, dir, victim ? victim.color : 0xffffff, false);
    audio.play('impactBody', { pos: end, volume: 0.7 });
  } else if (shot.n) {
    fx.impact(end, shot.n, shot.k);
    audio.play(impactSound(shot.k), { pos: end, volume: 0.8 });
  }
  // a near-miss whizz past your head
  if (local.alive && !shot.h) {
    const eye = cameraEye();
    const o = new THREE.Vector3(...shot.o), d = end.clone().sub(o), len = d.length(); d.normalize();
    const t = THREE.MathUtils.clamp(eye.clone().sub(o).dot(d), 0, len);
    const closest = o.clone().addScaledVector(d, t);
    if (closest.distanceTo(eye) < 1.6) audio.play('dash', { pos: closest, volume: 0.35, rate: 2.2 });
  }
});
const impactSound = k => (k === 'floor' ? 'impactWater' : k === 'perimeter' ? 'impactConcrete' : 'impactMetal');

socket.on('hit', h => {
  const pos = new THREE.Vector3(...h.p);
  const victim = avatars.get(h.id);
  if (h.blocked) { hud.hitmarker('blocked'); hud.damageNumber('IMMUNE', 'shield', pos); return; }
  fx.playerHit(pos, new THREE.Vector3().subVectors(pos, cameraEye()).normalize(), victim ? victim.color : 0xffffff, h.part === 'head');
  hud.hitmarker(h.k ? 'kill' : h.part === 'head' ? 'head' : '');
  hud.damageNumber(String(h.d), h.part === 'head' ? 'head' : h.shielded ? 'shield' : '', pos);
  audio.play(h.part === 'head' ? 'headshot' : 'hit', { volume: 0.55, vary: 0.02, reverb: 0 });
  if (h.k) {
    setTimeout(() => audio.play('kill', { volume: 0.6, reverb: 0.1, vary: 0 }), 70);
    const name = meta?.players.find(p => p.id === h.id)?.name || 'RUNNER';
    hud.killBanner(`<span class="pts">+${h.part === 'head' ? 125 : 100}</span><span class="who">ELIMINATED ${escapeHtml(name.toUpperCase())}</span>${h.part === 'head' ? ' <span class="hs">· HEADSHOT</span>' : ''}`);
  }
});

const damage = { pulse: 0, shake: 0 };
socket.on('hurt', h => {
  local.hp = h.hp;
  damage.pulse = Math.min(0.8, damage.pulse + h.d / 60); damage.shake = Math.min(1, damage.shake + h.d / 40);
  const dx = h.from[0] - local.sim.x, dz = h.from[1] - local.sim.z;
  const worldAng = Math.atan2(-dx, -dz); // yaw that would face the attacker
  hud.damageDirection(-(worldAng - local.yaw));
  audio.play('hurt', { volume: 0.7, reverb: 0.1 });
  hud.vitals(h.hp);
});

socket.on('killed', k => {
  const victim = avatars.get(k.victim), pos = new THREE.Vector3(...k.pos);
  fx.death(pos, victim ? victim.color : 0xffffff);
  audio.play('death', { pos: pos.clone().setY(pos.y + 1), volume: 1, reverb: 0.5 });
  if (k.victim === myId) {
    local.alive = false; local.deadAt = performance.now();
    local.killedBy = meta?.players.find(p => p.id === k.killer)?.name || '';
    local.deathPos = pos.clone();
    const killer = remotes.get(k.killer);
    local.deathLook = killer && killer.state ? new THREE.Vector3(killer.state.x, killer.state.y + 1.5, killer.state.z) : null;
  }
});
socket.on('respawned', r => {
  if (r.id === myId) { weapon.respawn(); audio.play('respawn', { volume: 0.6 }); hud.notice('REDEPLOYED', 900); }
  else setTimeout(() => { const st = remotes.get(r.id)?.state; if (st) fx.ring(st, avatars.get(r.id)?.color || 0xffffff, 2.5, 0.6); }, 150);
});
socket.on('abilityFx', a => {
  const st = a.id === myId ? local.sim : remotes.get(a.id)?.state;
  if (!st) return;
  const pos = new THREE.Vector3(st.x, st.y + 1, st.z);
  if (a.type === 'shield') { audio.play('shield', a.id === myId ? { volume: 0.6 } : { pos, volume: 0.8 }); if (a.id === myId) hud.notice('SHIELD ACTIVE'); }
  if (a.type === 'scan') { fx.ring(pos, 0xb6ff4a, 40, 1.4); audio.play('scan', a.id === myId ? { volume: 0.5 } : { pos, volume: 0.9 }); }
});
socket.on('scanPulse', d => {
  const until = performance.now() + d.duration;
  for (const q of d.players) { const r = remotes.get(q.id); if (r) r.xrayUntil = until; }
  scanFlash = 1;
  hud.notice(`NEURAL SCAN · ${d.players.length} SIGNAL${d.players.length === 1 ? '' : 'S'}`);
});
let scanFlash = 0;

function syncAvatars(players) {
  const ids = new Set(players.map(p => p.id));
  for (const [id, a] of avatars) if (!ids.has(id)) { scene.remove(a.group); a.dispose(); avatars.delete(id); remotes.delete(id); }
  for (const p of players) {
    if (p.id === myId || avatars.has(p.id)) continue;
    const a = new Avatar(p.color, p.name);
    a.group.visible = false;
    scene.add(a.group); avatars.set(p.id, a);
  }
}

// ping measurement
setInterval(() => { const t0 = performance.now(); socket.emit('ping2', 0, () => { ping = performance.now() - t0; }); }, 2000);

// ------------------------------------------------------------------ simulation tick (60 Hz, fixed)
const aimYaw = () => local.yaw + local.recoilYaw;
const aimPitch = () => THREE.MathUtils.clamp(local.pitch + local.recoilPitch, -1.45, 1.45);
function cameraEye(out = new THREE.Vector3()) { return out.set(local.sim.x, local.sim.y + Sim.EYE_HEIGHT, local.sim.z); }

function simTick() {
  let mx = 0, mz = 0;
  if (keys.KeyW || keys.ArrowUp) mz += 1; if (keys.KeyS || keys.ArrowDown) mz -= 1;
  if (keys.KeyD || keys.ArrowRight) mx += 1; if (keys.KeyA || keys.ArrowLeft) mx -= 1;
  mx += mobileMove.x; mz += mobileMove.z;
  let b = 0;
  if (keys.Space || mobileJump) b |= Sim.BTN.JUMP;
  if (dashQueued) { b |= Sim.BTN.DASH; dashQueued = false; }
  if (reloadQueued) { b |= Sim.BTN.RELOAD; reloadQueued = false; }
  const firing = (mouseDown && pointerLocked) || mobileFire;
  if (firing) b |= Sim.BTN.FIRE;
  if (aimDown) b |= Sim.BTN.ADS;
  const input = { s: ++local.seq, mx: Math.round(mx * 100) / 100, mz: Math.round(mz * 100) / 100, yaw: aimYaw(), pitch: aimPitch(), b };
  if (firing) input.vt = Math.round(renderServerTime());
  Sim.copyState(local.sim, local.prev);
  const wasOg = local.sim.og;
  const ev = Sim.stepPlayer(local.sim, input);
  local.pending.push(input); local.outbox.push(input);
  if (local.pending.length > 240) local.pending.shift();
  handleLocalEvents(ev, wasOg);
}

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Vector3(), _e = new THREE.Vector3();
function handleLocalEvents(ev, wasOg) {
  const s = local.sim;
  if (ev.fire) {
    const now = performance.now();
    local.shotsInBurst = now - local.lastFireT < 260 ? local.shotsInBurst + 1 : 0;
    local.lastFireT = now;
    // effects from the predicted shot (server decides damage)
    cameraEye(_o);
    const d = Sim.aimDirection(s.yaw, s.pitch); _d.set(d.x, d.y, d.z);
    const wh = Sim.raycastWorld(_o, d, Sim.MAX_RANGE);
    let endT = wh ? wh.t : Sim.MAX_RANGE, hitPlayer = null;
    for (const [id, r] of remotes) {
      if (!r.state || !r.state.alive) continue;
      const h = Sim.rayPlayer(_o, d, r.state, endT);
      if (h && h.t < endT) { endT = h.t; hitPlayer = id; }
    }
    const end = _o.clone().addScaledVector(_d, endT);
    weapon.fire(aimDown);
    camera.updateMatrixWorld();
    const muzzle = weapon.muzzleWorld(camera, _m);
    fx.tracer(muzzle, end, 0x7ff8ff);
    fx.flashLight(muzzle, 0xffb070, 10);
    audio.gunshot(null, true);
    if (!hitPlayer && wh) { fx.impact(end, wh.n, wh.kind); audio.play(impactSound(wh.kind), { pos: end, volume: 0.7 }); }
    // shell ejection
    const port = weapon.ejectWorld(camera, _e);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    fx.shell(port, right.multiplyScalar(2 + Math.random()).addScaledVector(up, 1.5 + Math.random()).add(new THREE.Vector3(s.vx, s.vy, s.vz)));
    // recoil pattern: steady vertical climb with a slight horizontal drift that grows during a burst
    const k = aimDown ? 0.6 : 1;
    local.recoilPitch += (0.018 + Math.min(local.shotsInBurst, 8) * 0.0018) * k;
    local.recoilYaw += (Math.sin(local.shotsInBurst * 1.7) * 0.004 + (Math.random() - 0.5) * 0.004) * k;
    camShake.kick = 1;
  }
  if (ev.dry) audio.play('dry', { volume: 0.7, reverb: 0 });
  if (ev.jump) audio.play('jump', { volume: 0.5, reverb: 0.1 });
  if (ev.land) { audio.play('land', { volume: 0.7, reverb: 0.15 }); weapon.land(1); camShake.land = 1; }
  if (ev.dash) { audio.play('dash', { volume: 0.7, reverb: 0.2 }); camShake.dash = 1; }
  // footsteps
  if (s.og && wasOg) {
    local.stepDist += Math.hypot(s.vx, s.vz) * Sim.DT;
    if (local.stepDist > 2.1) { local.stepDist = 0; audio.play('step' + (Math.random() * 4 | 0), { volume: 0.32, reverb: 0.05 }); if (s.y < 0.01) fx.footSplash(s); }
  }
}

// ------------------------------------------------------------------ remote interpolation
function sampleRemote(r, t) {
  const b = r.buffer;
  if (!b.length) return null;
  if (t <= b[0].t) return { ...b[0] };
  for (let i = b.length - 1; i > 0; i--) {
    const a = b[i - 1], c = b[i];
    if (t >= a.t && t <= c.t) {
      const k = (t - a.t) / (c.t - a.t || 1);
      // don't interpolate across teleports (respawn)
      if (Math.hypot(c.x - a.x, c.z - a.z) > 4) return { ...(k < 0.5 ? a : c) };
      let dy = c.yaw - a.yaw; if (dy > Math.PI) dy -= Math.PI * 2; if (dy < -Math.PI) dy += Math.PI * 2;
      return { t, x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k, yaw: a.yaw + dy * k, pitch: a.pitch + (c.pitch - a.pitch) * k, flags: k < 0.5 ? a.flags : c.flags, vx: a.vx + (c.vx - a.vx) * k, vz: a.vz + (c.vz - a.vz) * k };
    }
  }
  // past the newest snapshot: extrapolate briefly
  const last = b[b.length - 1], ex = Math.min(0.1, (t - last.t) / 1000);
  return { ...last, x: last.x + last.vx * ex, z: last.z + last.vz * ex };
}
function updateRemotes(dt) {
  const t = renderServerTime(), now = performance.now();
  for (const [id, r] of remotes) {
    const a = avatars.get(id);
    const s = sampleRemote(r, t);
    if (!a || !s) continue;
    const st = { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, vx: s.vx, vz: s.vz, alive: !!(s.flags & 1), shield: !!(s.flags & 2), og: !!(s.flags & 8), dash: !!(s.flags & 16), protect: !!(s.flags & 32) };
    // steps & dash trails
    if (st.alive && r.state && st.og) {
      r.stepDist += Math.hypot(st.x - r.state.x, st.z - r.state.z);
      if (r.stepDist > 2.0) { r.stepDist = 0; audio.play('step' + (Math.random() * 4 | 0), { pos: new THREE.Vector3(st.x, st.y + 0.1, st.z), volume: 0.75, ref: 2 }); if (st.y < 0.01) fx.footSplash(st); }
    }
    if (st.dash && st.alive) fx.dashTrail(st, a.color);
    if (r.state && r.state.og === false && st.og && st.alive) audio.play('land', { pos: new THREE.Vector3(st.x, st.y, st.z), volume: 0.5 });
    if (r.state && !(r.lastFlags & 16) && (s.flags & 16)) audio.play('dash', { pos: new THREE.Vector3(st.x, st.y + 1, st.z), volume: 0.8 });
    r.lastFlags = s.flags;
    r.state = st;
    a.update(dt, st);
    a.setXray(st.alive && now < r.xrayUntil);
    const dist = Math.hypot(st.x - camera.position.x, st.z - camera.position.z);
    a.tag.visible = dist < 28;
  }
}

// ------------------------------------------------------------------ camera
const camShake = { kick: 0, land: 0, dash: 0 };
let fovCur = 78, bobPhase = 0, attractT = 0;
function updateCamera(dt, alpha) {
  const s = local.sim, p = local.prev;
  // recoil recovery
  const rec = 1 - Math.exp(-dt * 7.5);
  local.recoilPitch -= local.recoilPitch * rec; local.recoilYaw -= local.recoilYaw * rec;
  local.errorOffset.multiplyScalar(Math.exp(-dt * 12));
  const x = p.x + (s.x - p.x) * alpha + local.errorOffset.x;
  const y = p.y + (s.y - p.y) * alpha + local.errorOffset.y;
  const z = p.z + (s.z - p.z) * alpha + local.errorOffset.z;
  const speed = Math.hypot(s.vx, s.vz);
  bobPhase += dt * (speed * 1.6);
  const bobK = s.og ? Math.min(1, speed / Sim.MOVE_SPEED) : 0;
  camShake.kick *= Math.exp(-dt * 20); camShake.land *= Math.exp(-dt * 8); camShake.dash *= Math.exp(-dt * 5);
  damage.shake *= Math.exp(-dt * 7); damage.pulse *= Math.exp(-dt * 3.5);
  let camY = y + Sim.EYE_HEIGHT + Math.abs(Math.sin(bobPhase)) * 0.035 * bobK - camShake.land * 0.12;
  let roll = Math.sin(bobPhase) * 0.004 * bobK + (Math.random() - 0.5) * damage.shake * 0.03;
  let yaw = aimYaw() + (Math.random() - 0.5) * damage.shake * 0.02;
  let pitch = aimPitch() + camShake.kick * 0.004 + (Math.random() - 0.5) * damage.shake * 0.02;
  if (!local.alive && local.deathPos) {
    // death cam: drop, roll and look at the killer
    const k = Math.min(1, (performance.now() - local.deadAt) / 600);
    camera.position.set(local.deathPos.x, THREE.MathUtils.lerp(local.deathPos.y + Sim.EYE_HEIGHT, local.deathPos.y + 0.45, k), local.deathPos.z);
    if (local.deathLook) {
      const d = local.deathLook.clone().sub(camera.position);
      yaw = THREE.MathUtils.lerp(yaw, Math.atan2(-d.x, -d.z), k * 0.6);
      pitch = THREE.MathUtils.lerp(pitch, Math.atan2(d.y, Math.hypot(d.x, d.z)), k * 0.6);
    }
    roll = 0.35 * k;
  } else camera.position.set(x, camY, z);
  camera.rotation.set(pitch, yaw, roll);
  const targetFov = (aimDown && local.alive ? 56 : 78) + camShake.dash * 10;
  fovCur += (targetFov - fovCur) * (1 - Math.exp(-dt * 12));
  if (Math.abs(camera.fov - fovCur) > 0.01) { camera.fov = fovCur; camera.updateProjectionMatrix(); }
}
let freeCam = null; // debug: { pos:[x,y,z], look:[x,y,z] } pins the menu camera
function attractCamera(dt) {
  if (freeCam) { camera.position.set(...freeCam.pos); camera.lookAt(...freeCam.look); return; }
  attractT += dt * 0.05;
  const r = 19, a = attractT;
  camera.position.set(Math.cos(a) * r, 6 + Math.sin(a * 2) * 1.5, Math.sin(a) * r);
  camera.lookAt(0, 2, 0);
}

// ------------------------------------------------------------------ main loop
let lastFrame = performance.now(), fpsAcc = 0, fpsFrames = 0, fps = 0, netSendAcc = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  const t = now / 1000;
  fpsAcc += dt; fpsFrames++; if (fpsAcc > 0.5) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

  if (phase === 'playing') {
    local.acc += dt;
    let steps = 0;
    while (local.acc >= Sim.DT && steps < 8) { local.acc -= Sim.DT; simTick(); steps++; }
    if (steps === 8) local.acc = 0;
    netSendAcc += dt;
    if (local.outbox.length && (netSendAcc >= 1 / 30 || local.outbox.length >= 4)) {
      netSendAcc = 0;
      while (local.outbox.length) socket.emit('in', local.outbox.splice(0, 10));
    }
    updateRemotes(dt);
    updateCamera(dt, local.acc / Sim.DT);
    // HUD
    const s = local.sim;
    hud.vitals(local.hp);
    hud.ammo(s.ammo, s.reload);
    hud.status(!pointerLocked && !isTouch ? 'CLICK TO LOCK AIM' : !local.alive ? 'REDEPLOYING…' : s.reload > 0 ? 'RELOADING…' : s.ammo === 0 ? 'EMPTY — PRESS R' : 'VX-9 ENERGY RIFLE');
    const since = now - local.cdAt;
    hud.ability('dashBtn', s.dashCd / Sim.DASH_COOLDOWN_TICKS, s.dashT > 0);
    hud.ability('shieldBtn', Math.max(0, local.cd.shield - since) / 9000, local.cd.shieldOn - since > 0);
    hud.ability('scanBtn', Math.max(0, local.cd.scan - since) / 12000, false);
    const moveSpread = Math.hypot(s.vx, s.vz) * 1.2 + (s.og ? 0 : 8);
    hud.crosshair(moveSpread + local.recoilPitch * 300, aimDown && local.alive);
    hud.net(`${Math.round(ping)} MS · ${fps} FPS · ${qualityName.toUpperCase()}`);
    hud.death(!local.alive, local.killedBy, Math.max(0, 2.5 - (now - local.deadAt) / 1000));
    hud.updateDamageNumbers(dt, camera);
    weapon.update({ dt, moveSpeed: Math.hypot(s.vx, s.vz), grounded: s.og, aiming: aimDown, mouseDX, mouseDY, reloadTicks: s.reload, ammo: s.ammo, alive: local.alive, dashing: s.dashT > 0 });
    const g = post.grade.uniforms;
    g.damage.value = damage.pulse; g.lowHp.value = local.alive && local.hp <= 35 ? (35 - local.hp) / 35 * 0.8 + 0.2 : 0;
    g.dead.value += ((local.alive ? 0 : 1) - g.dead.value) * (1 - Math.exp(-dt * 4));
    scanFlash *= Math.exp(-dt * 3); g.scan.value = scanFlash;
  } else {
    attractCamera(dt);
    if (weapon) weapon.update({ dt, moveSpeed: 0, grounded: true, aiming: false, mouseDX: 0, mouseDY: 0, reloadTicks: 0, ammo: Sim.MAG_SIZE, alive: false, dashing: false });
    if (post) { const g = post.grade.uniforms; g.damage.value = 0; g.lowHp.value = 0; g.dead.value = 0; }
  }
  mouseDX *= 0.5; mouseDY *= 0.5;
  if (!world) return;
  world.update(t, dt, camera);
  fx.update(dt, camera);
  camera.updateMatrixWorld();
  audio.updateListener(camera);
  post.render(dt);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  if (post) post.setSize(innerWidth, innerHeight);
  if (weapon) weapon.setSize(innerWidth, innerHeight);
  if (world) world.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ boot
async function boot() {
  $('loadStatus').textContent = 'Generating arena materials…';
  $('createBtn').disabled = $('showJoinBtn').disabled = true;
  try { await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 2500))]); } catch { /* fonts optional */ }
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  world = createWorld(renderer, scene, Q);
  fx = new Effects(scene, Q);
  fx.onShellBounce = (p, n) => audio.play('tink', { pos: p, volume: 0.25 / (n + 1), rate: 0.9 + Math.random() * 0.3, ref: 1.2 });
  weapon = new Weapon(scene.environment);
  weapon.events = {
    start: () => audio.play('magOut', { volume: 0.25, rate: 1.3, reverb: 0.05 }),
    magOut: () => audio.play('magOut', { volume: 0.55, reverb: 0.1 }),
    magIn: () => audio.play('magIn', { volume: 0.6, reverb: 0.1 }),
    charge: () => audio.play('charge', { volume: 0.6, reverb: 0.1 })
  };
  post = createPost(renderer, scene, camera, weapon.scene, weapon.camera, Q);
  hud = new Hud();
  // compile shaders up-front (including a throwaway avatar) to avoid hitches when the match starts
  const warm = new Avatar('#ffffff', 'warmup'); warm.group.position.set(0, -50, 0); warm.shield.visible = true; warm.ghost.visible = true; scene.add(warm.group);
  try { renderer.compile(scene, camera); renderer.compile(weapon.scene, weapon.camera); } catch { /* optional */ }
  scene.remove(warm.group); warm.dispose();
  $('loadStatus').textContent = `Graphics: ${qualityName.toUpperCase()} · ${renderer.capabilities.isWebGL2 ? 'WebGL 2' : 'WebGL'} ready`;
  $('createBtn').disabled = $('showJoinBtn').disabled = false;
  // debugging / automated-test hooks (do not grant anything the server would not accept from a normal client)
  window.__NAB = { renderer, scene, camera, world, fx, weapon, audio, local, remotes, avatars, socket, Sim, input: { fire: v => { mobileFire = v; }, aim: v => { aimDown = v; } }, setFreeCam: v => { freeCam = v; } };
}
requestAnimationFrame(frame);
boot().catch(err => { console.error(err); $('loadStatus').textContent = 'Failed to initialise graphics: ' + err.message; });

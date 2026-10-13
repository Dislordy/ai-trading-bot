'use strict';
/*
 * NEON ARENA: BLACKOUT — authoritative game server.
 *
 * Clients only send *inputs* (movement keys, view angles, buttons). The server
 * runs the shared simulation (shared/sim.js) at 60 Hz, owns every player's
 * position, ammo, health and score, performs hit detection with lag
 * compensation against a position history, and streams snapshots back.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { Server } = require('socket.io');
const Sim = require('./shared/sim');

const PORT = process.env.PORT || 3000;
const MATCH_MS = Number(process.env.MATCH_MS) || 4 * 60 * 1000;
const RESPAWN_MS = 2500;
const SPAWN_PROTECT_MS = 1600;
const MAX_PLAYERS = 8;
const MAX_QUEUE = 40;                  // max buffered input commands per player
const MAX_BUDGET = 0.3;                // seconds of simulation a client can "bank" (jitter tolerance)
const MAX_INPUTS_PER_TICK = 8;
const HISTORY_MS = 1000;
const ABILITIES = {
  shield: { duration: 2200, cooldown: 9000 },
  scan: { duration: 1400, cooldown: 12000 }
};
const COLORS = ['#00f5ff', '#ff36c7', '#b6ff4a', '#ffb347', '#9b7bff', '#ff5f6d', '#56e39f', '#f4f7ff'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 16 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three')));
app.get('/health', (_, res) => res.json({ ok: true, game: 'NEON ARENA: BLACKOUT', rooms: rooms.size }));

const rooms = new Map();
const now = () => performance.now();
const wallNow = () => Date.now();

function makeCode() {
  let code;
  do code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}
function addFeed(room, message, kind = 'info') {
  room.feed.push({ id: crypto.randomUUID(), message, kind, at: wallNow() });
  room.feed = room.feed.slice(-8);
}
function publicMeta(p) {
  return { id: p.id, name: p.name, color: p.color, score: p.score, kills: p.kills, deaths: p.deaths, alive: p.sim.alive, hp: p.hp };
}
function metaState(room) {
  return {
    code: room.code, phase: room.phase, host: room.hostId,
    timeLeft: room.phase === 'playing' ? Math.max(0, Math.ceil((room.endsAt - now()) / 1000)) : 0,
    players: [...room.players.values()].map(publicMeta), feed: room.feed.slice(-5)
  };
}
function emitMeta(room) { io.to(room.code).emit('state', metaState(room)); }

function chooseSpawn(room, self) {
  // Pick the spawn point that is furthest from every living enemy.
  let best = Sim.spawns[0], bestScore = -Infinity;
  for (const s of Sim.spawns) {
    if (!Sim.isFree(s.x, 0, s.z)) continue;
    let minD = 60;
    for (const q of room.players.values()) {
      if (q === self || !q.sim.alive) continue;
      minD = Math.min(minD, Math.hypot(q.sim.x - s.x, q.sim.z - s.z));
    }
    const score = minD + Math.random() * 4;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}
function placeAtSpawn(room, p) {
  const s = chooseSpawn(room, p);
  const keep = { yaw: Math.atan2(s.x, s.z), pitch: 0 }; // face the arena centre
  p.sim = Sim.newPlayerState(s.x, s.z);
  p.sim.yaw = keep.yaw;
  p.hp = 100;
  p.protectUntil = now() + SPAWN_PROTECT_MS;
  p.history = [];
  p.teleported = true; // tells the client to snap instead of smoothing
}

function stopTimer(room) { if (room.timer) clearInterval(room.timer); room.timer = null; }
function startMatch(room) {
  if (room.players.size < 2 || room.phase === 'playing') return false;
  room.phase = 'playing'; room.endsAt = now() + MATCH_MS; room.feed = []; room.winner = null; room.tick = 0;
  for (const p of room.players.values()) {
    Object.assign(p, { score: 0, kills: 0, deaths: 0, queue: [], budget: 0, shieldUntil: 0, shieldCdUntil: 0, scanCdUntil: 0, respawnAt: 0 });
  }
  for (const p of room.players.values()) placeAtSpawn(room, p);
  addFeed(room, 'BLACKOUT initiated. Good hunting.');
  stopTimer(room);
  room.timer = setInterval(() => {
    if (!rooms.has(room.code)) return stopTimer(room);
    if (now() >= room.endsAt) endMatch(room); else emitMeta(room);
  }, 500);
  io.to(room.code).emit('matchStarted', { endsIn: MATCH_MS });
  emitMeta(room);
  return true;
}
function endMatch(room) {
  if (room.phase !== 'playing') return;
  room.phase = 'results'; stopTimer(room);
  const ranked = [...room.players.values()].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
  io.to(room.code).emit('matchEnded', {
    winner: ranked[0] ? ranked[0].name : 'Nobody',
    rankings: ranked.map((p, i) => ({ place: i + 1, name: p.name, score: p.score, kills: p.kills, deaths: p.deaths, color: p.color }))
  });
  emitMeta(room);
}
function cleanRoom(code) {
  const room = rooms.get(code);
  if (room && room.players.size === 0) { stopTimer(room); rooms.delete(code); }
}

// ------------------------------------------------------- lag compensation
function recordHistory(room, t) {
  for (const p of room.players.values()) {
    p.history.push({ t, x: p.sim.x, y: p.sim.y, z: p.sim.z, alive: p.sim.alive });
    while (p.history.length && p.history[0].t < t - HISTORY_MS) p.history.shift();
  }
}
/** Where was this player at server time t? (linear interpolation of history) */
function positionAt(p, t) {
  const h = p.history;
  if (!h.length || t >= h[h.length - 1].t) return { x: p.sim.x, y: p.sim.y, z: p.sim.z, alive: p.sim.alive };
  if (t <= h[0].t) return h[0];
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (t >= a.t) {
      const k = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, alive: a.alive && b.alive };
    }
  }
  return h[0];
}

// ------------------------------------------------------------ combat
function handleShot(room, shooter, viewTime) {
  const t = now();
  const s = shooter.sim;
  const origin = Sim.eyeOf(s);
  const dir = Sim.aimDirection(s.yaw, s.pitch);
  const world = Sim.raycastWorld(origin, dir, Sim.MAX_RANGE);
  let maxT = world ? world.t : Sim.MAX_RANGE;
  // Rewind other players to what the shooter was looking at, within limits.
  const rewindT = Number.isFinite(viewTime) ? Math.min(t, Math.max(t - Sim.MAX_REWIND_MS, viewTime)) : t - Sim.INTERP_DELAY_MS;
  let best = null;
  for (const target of room.players.values()) {
    if (target === shooter || !target.sim.alive) continue;
    const pos = positionAt(target, rewindT);
    if (!pos.alive) continue;
    const hit = Sim.rayPlayer(origin, dir, pos, maxT);
    if (hit && (!best || hit.t < best.t)) best = { target, t: hit.t, part: hit.part };
  }
  const endT = best ? best.t : maxT;
  const end = { x: origin.x + dir.x * endT, y: origin.y + dir.y * endT, z: origin.z + dir.z * endT };
  const shot = {
    id: shooter.id,
    o: [r3(origin.x), r3(origin.y), r3(origin.z)],
    e: [r3(end.x), r3(end.y), r3(end.z)],
    n: !best && world ? world.n : null,
    k: !best && world ? world.kind : null,
    h: best ? best.target.id : null
  };
  io.to(room.code).except(shooter.id).emit('shot', shot);
  if (!best) return;

  const target = best.target;
  if (t < target.protectUntil) {
    io.to(shooter.id).emit('hit', { id: target.id, d: 0, part: best.part, k: false, p: shot.e, blocked: true });
    return;
  }
  const shielded = target.shieldUntil > t;
  const dmg = Sim.damageFor(best.part, best.t, shielded);
  target.hp = Math.max(0, target.hp - dmg);
  const killed = target.hp <= 0;
  io.to(shooter.id).emit('hit', { id: target.id, d: dmg, part: best.part, k: killed, p: shot.e, shielded });
  io.to(target.id).emit('hurt', { d: dmg, part: best.part, hp: target.hp, from: [r3(s.x), r3(s.z)], by: shooter.id });
  if (killed) {
    target.sim.alive = false; target.deaths++;
    target.respawnAt = t + RESPAWN_MS;
    shooter.kills++; shooter.score += best.part === 'head' ? 125 : 100;
    addFeed(room, `${shooter.name} ${best.part === 'head' ? '⊕ headshot' : '▸'} ${target.name}`, 'kill');
    io.to(room.code).emit('killed', { killer: shooter.id, victim: target.id, head: best.part === 'head', pos: [r3(target.sim.x), r3(target.sim.y), r3(target.sim.z)] });
    emitMeta(room);
  }
}
const r3 = v => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------ main loop
let lastLoop = now(), acc = 0;
function gameLoop() {
  const t = now();
  acc += Math.min(0.25, (t - lastLoop) / 1000);
  lastLoop = t;
  while (acc >= Sim.DT) {
    acc -= Sim.DT;
    for (const room of rooms.values()) if (room.phase === 'playing') tickRoom(room);
  }
}
function tickRoom(room) {
  const t = now();
  room.tick++;
  for (const p of room.players.values()) {
    p.budget = Math.min(MAX_BUDGET, p.budget + Sim.DT);
    let processed = 0;
    while (p.queue.length && p.budget >= Sim.DT - 1e-9 && processed < MAX_INPUTS_PER_TICK) {
      const input = p.queue.shift();
      p.budget -= Sim.DT; processed++;
      p.lastSeq = input.s;
      const ev = Sim.stepPlayer(p.sim, input);
      if (ev.fire) handleShot(room, p, input.vt);
    }
    if (!p.sim.alive && p.respawnAt && t >= p.respawnAt) {
      p.respawnAt = 0;
      placeAtSpawn(room, p);
      io.to(room.code).emit('respawned', { id: p.id });
      emitMeta(room);
    }
  }
  recordHistory(room, t);
  if (room.tick % Sim.SNAPSHOT_EVERY === 0) sendSnapshots(room, t);
}
function sendSnapshots(room, t) {
  const others = [];
  for (const p of room.players.values()) {
    const s = p.sim;
    const flags = (s.alive ? 1 : 0) | (p.shieldUntil > t ? 2 : 0) | (s.reload > 0 ? 4 : 0) | (s.og ? 8 : 0) | (s.dashT > 0 ? 16 : 0) | (t < p.protectUntil ? 32 : 0);
    others.push([p.id, r3(s.x), r3(s.y), r3(s.z), r3(s.yaw), r3(s.pitch), flags, r3(s.vx), r3(s.vz)]);
  }
  for (const p of room.players.values()) {
    const me = Sim.copyState(p.sim);
    io.to(p.id).emit('snap', {
      t: Math.round(t * 10) / 10,
      ack: p.lastSeq,
      me, hp: p.hp, tp: p.teleported || false,
      cd: { shield: Math.max(0, p.shieldCdUntil - t), scan: Math.max(0, p.scanCdUntil - t), shieldOn: Math.max(0, p.shieldUntil - t) },
      ps: others
    });
    p.teleported = false;
  }
}
setInterval(gameLoop, 1000 / 120);

// ------------------------------------------------------------ input validation
function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = Number(raw.s);
  if (!Number.isInteger(s) || s < 0) return null;
  const mx = Number(raw.mx), mz = Number(raw.mz), yaw = Number(raw.yaw), pitch = Number(raw.pitch);
  if (![mx, mz, yaw, pitch].every(Number.isFinite)) return null;
  const out = { s, mx: Sim.clamp(mx, -1, 1), mz: Sim.clamp(mz, -1, 1), yaw, pitch: Sim.clamp(pitch, -1.45, 1.45), b: (raw.b | 0) & 31 };
  if (raw.vt !== undefined && Number.isFinite(Number(raw.vt))) out.vt = Number(raw.vt);
  return out;
}

// ------------------------------------------------------------ sockets
io.on('connection', socket => {
  let roomCode = null;
  const getRoom = () => rooms.get(roomCode);
  const getMe = () => { const r = getRoom(); return r && r.players.get(socket.id); };

  socket.on('ping2', (_, cb) => { if (typeof cb === 'function') cb(now()); });

  socket.on('createRoom', ({ name } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return;
    if (roomCode) return cb({ ok: false, error: 'Leave your current room first.' });
    const code = makeCode();
    const room = { code, hostId: socket.id, phase: 'lobby', players: new Map(), feed: [], endsAt: 0, timer: null, tick: 0 };
    rooms.set(code, room);
    joinRoom(room, name, cb);
  });
  socket.on('joinRoom', ({ code, name } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') return;
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code and try again.' });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'This room is full (8 players maximum).' });
    if (room.phase === 'playing') return cb({ ok: false, error: 'That match is already in progress.' });
    if (roomCode) return cb({ ok: false, error: 'Leave your current room first.' });
    joinRoom(room, name, cb);
  });
  function joinRoom(room, rawName, cb) {
    const name = String(rawName || 'Runner').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Runner';
    const used = new Set([...room.players.values()].map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[room.players.size % COLORS.length];
    const p = {
      id: socket.id, name, color, score: 0, kills: 0, deaths: 0, hp: 100,
      sim: Sim.newPlayerState(0, 0), queue: [], budget: 0, lastSeq: -1, history: [],
      protectUntil: 0, shieldUntil: 0, shieldCdUntil: 0, scanCdUntil: 0, respawnAt: 0, teleported: true
    };
    room.players.set(socket.id, p);
    roomCode = room.code;
    socket.join(room.code);
    addFeed(room, `${name} connected`);
    cb({ ok: true, code: room.code, host: room.hostId === socket.id, playerId: socket.id });
    emitMeta(room);
  }

  socket.on('startMatch', () => {
    const room = getRoom();
    if (!room || room.hostId !== socket.id) return;
    if (!startMatch(room)) socket.emit('notice', 'At least two players are needed to start.');
  });

  // Batched input commands: [{ s, mx, mz, yaw, pitch, b, vt? }, ...]
  socket.on('in', batch => {
    const room = getRoom(), p = getMe();
    if (!room || !p || room.phase !== 'playing' || !Array.isArray(batch) || batch.length > 12) return;
    for (const raw of batch) {
      const input = sanitizeInput(raw);
      if (!input || input.s <= p.lastSeq) continue;
      const lastQueued = p.queue.length ? p.queue[p.queue.length - 1].s : p.lastSeq;
      if (input.s <= lastQueued) continue; // duplicates / reordering
      if (p.queue.length >= MAX_QUEUE) break; // flooding: excess commands are dropped
      p.queue.push(input);
    }
  });

  socket.on('ability', ({ type } = {}) => {
    const room = getRoom(), p = getMe();
    if (!room || room.phase !== 'playing' || !p || !p.sim.alive) return;
    const t = now();
    if (type === 'shield' && t >= p.shieldCdUntil) {
      p.shieldUntil = t + ABILITIES.shield.duration; p.shieldCdUntil = t + ABILITIES.shield.cooldown;
      io.to(room.code).emit('abilityFx', { id: p.id, type: 'shield' });
    } else if (type === 'scan' && t >= p.scanCdUntil) {
      p.scanCdUntil = t + ABILITIES.scan.cooldown;
      const found = [...room.players.values()].filter(q => q !== p && q.sim.alive).map(q => ({ id: q.id, x: r3(q.sim.x), y: r3(q.sim.y), z: r3(q.sim.z) }));
      socket.emit('scanPulse', { players: found, duration: ABILITIES.scan.duration });
      io.to(room.code).emit('abilityFx', { id: p.id, type: 'scan' });
    }
  });

  socket.on('rematch', () => {
    const room = getRoom();
    if (room && room.phase === 'results' && room.hostId === socket.id) { room.phase = 'lobby'; emitMeta(room); }
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) { addFeed(room, `${p.name} disconnected`); room.players.delete(socket.id); }
    if (room.hostId === socket.id) { const next = room.players.keys().next(); room.hostId = next.done ? null : next.value; }
    if (room.phase === 'playing' && room.players.size < 2) { room.phase = 'lobby'; stopTimer(room); addFeed(room, 'Match paused: waiting for another runner.'); }
    emitMeta(room);
    cleanRoom(room.code);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`NEON ARENA: BLACKOUT running on port ${PORT}`));
}
module.exports = { server, rooms, io };

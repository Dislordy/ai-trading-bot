'use strict';
// Unit tests for the shared simulation (movement, collision, ray casting).
const assert = require('assert');
const Sim = require('../shared/sim');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const input = (o = {}) => Object.assign({ mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0 }, o);
function run(p, inp, ticks) { const evs = []; for (let i = 0; i < ticks; i++) evs.push(Sim.stepPlayer(p, inp)); return evs; }

test('every spawn point is clear of geometry', () => {
  for (const s of Sim.spawns) assert.ok(Sim.isFree(s.x, 0, s.z), `spawn ${s.x},${s.z} is blocked`);
});

test('standing player stays grounded', () => {
  const p = Sim.newPlayerState(-18, -20);
  run(p, input(), 30);
  assert.strictEqual(p.y, 0); assert.ok(p.og);
});

test('walking forward moves along -z at roughly MOVE_SPEED', () => {
  const p = Sim.newPlayerState(-18, -20);
  run(p, input({ mz: 1 }), 60);
  assert.ok(Math.abs(p.x + 18) < 1e-6);
  assert.ok(p.z < -20 - 4.5 && p.z > -20 - 6.3, 'z=' + p.z);
});

test('walls block movement', () => {
  // Core spans x -2..2. Start east of it and walk west (yaw = +90deg looks along -x).
  const p = Sim.newPlayerState(4, 0);
  run(p, input({ mz: 1, yaw: Math.PI / 2 }), 120);
  assert.ok(p.x >= 2 + Sim.PLAYER_RADIUS - 1e-3, 'x=' + p.x);
});

test('jumping reaches ~1.36 m and lands', () => {
  const p = Sim.newPlayerState(-18, -20);
  let maxY = 0;
  Sim.stepPlayer(p, input({ b: Sim.BTN.JUMP }));
  for (let i = 0; i < 90; i++) { Sim.stepPlayer(p, input()); maxY = Math.max(maxY, p.y); }
  assert.ok(maxY > 1.2 && maxY < 1.5, 'maxY=' + maxY);
  assert.strictEqual(p.y, 0); assert.ok(p.og);
});

test('player can jump onto a crate', () => {
  // crate at (-4,-5) 1.4 wide, 1.1 tall; start south of it, walk north (-z) while jumping
  const p = Sim.newPlayerState(-4, -2.6);
  for (let i = 0; i < 80; i++) Sim.stepPlayer(p, input({ mz: i < 40 ? 1 : 0, b: i < 3 ? Sim.BTN.JUMP : 0 }));
  assert.ok(Math.abs(p.y - 1.1) < 0.01, 'y=' + p.y + ' z=' + p.z);
  assert.ok(p.og);
});

test('stairs lead up to the catwalk', () => {
  // NW stairs: bottom near x=-10.8, deck at x<-15, z ~ -26.7. Walk west (yaw=+90deg -> -x).
  const p = Sim.newPlayerState(-9.5, -26.7);
  run(p, input({ mz: 1, yaw: Math.PI / 2 }), 150);
  assert.ok(Math.abs(p.y - Sim.CATWALK_TOP) < 0.01, 'y=' + p.y);
  assert.ok(p.x < -15, 'x=' + p.x);
});

test('walking down stairs stays grounded (ground snapping)', () => {
  const p = Sim.newPlayerState(-20, -26.7); p.y = Sim.CATWALK_TOP + 1e-4;
  let air = 0;
  for (let i = 0; i < 120; i++) { Sim.stepPlayer(p, input({ mz: 1, yaw: -Math.PI / 2 })); if (!p.og) air++; }
  assert.strictEqual(p.y, 0); assert.ok(air < 5, 'air ticks=' + air);
});

test('dash bursts and has a cooldown', () => {
  const p = Sim.newPlayerState(-18, -20);
  const ev = Sim.stepPlayer(p, input({ mz: 1, b: Sim.BTN.DASH }));
  assert.ok(ev.dash);
  run(p, input({ mz: 1 }), Sim.DASH_TICKS);
  const ev2 = Sim.stepPlayer(p, input({ b: Sim.BTN.DASH }));
  assert.ok(!ev2.dash, 'dash should be on cooldown');
});

test('fire rate, ammo and reload are enforced by the simulation', () => {
  const p = Sim.newPlayerState(-18, -20);
  let shots = 0;
  for (let i = 0; i < 60; i++) if (Sim.stepPlayer(p, input({ b: Sim.BTN.FIRE })).fire) shots++;
  assert.ok(shots >= 5 && shots <= 6, 'shots in 1s=' + shots);
  for (let i = 0; i < 400; i++) Sim.stepPlayer(p, input({ b: Sim.BTN.FIRE }));
  // Mag emptied, reload kicked in automatically, firing resumed.
  assert.ok(p.ammo >= 0 && p.ammo <= Sim.MAG_SIZE);
  const q = Sim.newPlayerState(-18, -20); q.ammo = 3;
  Sim.stepPlayer(q, input({ b: Sim.BTN.RELOAD }));
  assert.ok(q.reload > 0);
  assert.ok(!Sim.stepPlayer(q, input({ b: Sim.BTN.FIRE })).fire, 'cannot fire while reloading');
  run(q, input(), Sim.RELOAD_TICKS);
  assert.strictEqual(q.ammo, Sim.MAG_SIZE);
});

test('walls block bullets', () => {
  const o = { x: 6, y: 1.6, z: 0 }, d = { x: -1, y: 0, z: 0 };
  const w = Sim.raycastWorld(o, d);
  assert.ok(w && Math.abs(w.t - 4) < 1e-6, 'core face expected at t=4');
  assert.deepStrictEqual(w.n, [1, 0, 0]);
});

test('player hitboxes: head, body, legs and misses', () => {
  const pos = { x: 0, y: 0, z: -10 };
  const o = { x: 0, y: 1.6, z: 0 };
  assert.strictEqual(Sim.rayPlayer(o, { x: 0, y: 0, z: -1 }, pos).part, 'head');
  const toBody = { x: 0, y: 1.15 - 1.6, z: -10 }; const l = Math.hypot(toBody.y, toBody.z);
  assert.strictEqual(Sim.rayPlayer(o, { x: 0, y: toBody.y / l, z: toBody.z / l }, pos).part, 'body');
  const toLeg = { y: 0.5 - 1.6, z: -10 }; const l2 = Math.hypot(toLeg.y, toLeg.z);
  assert.strictEqual(Sim.rayPlayer(o, { x: 0, y: toLeg.y / l2, z: toLeg.z / l2 }, pos).part, 'legs');
  assert.strictEqual(Sim.rayPlayer(o, { x: 0.2, y: 0, z: -0.98 }, pos), null);
});

test('damage model', () => {
  assert.strictEqual(Sim.damageFor('body', 10, false), 34);
  assert.strictEqual(Sim.damageFor('head', 10, false), 68);
  assert.ok(Sim.damageFor('body', 80, false) < 34);
  assert.ok(Sim.damageFor('body', 10, true) < 12);
});

console.log(`sim: ${passed} passed`);

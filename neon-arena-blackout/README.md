# NEON ARENA: BLACKOUT

A cyberpunk first-person multiplayer shooter for the browser, built with Three.js, Express and Socket.IO.
Version 2.0 is a full rework of the 0.1 prototype: a realistic rendering pipeline, real gunplay, and an
authoritative multiplayer server.

## Requirements
- Node.js 18 or newer
- A desktop browser with WebGL 2 (Chrome, Edge, Firefox, Safari 15+)

Three.js is installed with npm and served by the game server, so the game no longer depends on a CDN.
Google Fonts are optional; the game falls back to system fonts.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # simulation unit tests + server integration tests
```

Open http://localhost:3000, create a room and share the six-character code. Other devices on your LAN can join
through `http://<host-ip>:3000`. Deploy to any Node host that supports WebSockets (start command `npm start`).

## Controls
| Action | Key |
| --- | --- |
| Move | WASD / arrow keys |
| Aim / look | Mouse (click the view to lock the pointer) |
| Fire (full-auto) | Hold left mouse |
| Aim down sights | Hold right mouse |
| Reload | R (empty magazines reload automatically) |
| Jump | Space |
| Dash | Shift |
| Shield / Scan | Q / E |
| Scoreboard | Hold Tab |

Graphics quality (Low / Medium / High / Ultra), mouse sensitivity and volume are under **Settings** on the home
screen. You can also force a preset with `?quality=low|medium|high|ultra`.

## What's new in 2.0

### 1. Realistic graphics
- **PBR materials** for every surface: procedurally generated albedo, normal, roughness and metalness maps
  (wet concrete slabs, riveted steel panels, board-formed concrete, corrugated cargo crates, painted drums,
  circuit-traced tech panels, see-through steel grating). No image assets are shipped.
- **Image-based lighting** from a pre-filtered neon environment map, so metals pick up coloured reflections.
- **Dynamic shadows**: soft shadow-mapped moonlight plus two sweeping searchlights that cast moving shadows (High and up).
- **Reflections**: planar real-time reflections in the floor's puddles, blurred by surface roughness so damp
  concrete shows glossy streaks and standing water shows mirror-like neon.
- **Volumetric-looking fog**: exponential height fog injected into every material, animated ground-mist layers,
  light-shaft cones under searchlights and lamps, drifting dust motes, and rain with floor splashes.
- **Post-processing**: HDR bloom, ACES tone mapping, chromatic aberration, vignette, film grain, split toning,
  and a red damage/low-health pulse.
- **Detailed arena**: a reactor core with energy rings and a sky beam, neon-signed buildings with doors, windows,
  rooftop AC units and beacons, catwalks with railings and support pillars reached by lit staircases, pipes,
  hanging cables, steam vents, floor markings, holographic billboards, a city skyline with lit windows, and flying traffic.
- **Articulated player models** with walk, strafe and jump animation, aim pitch, a held rifle, a fresnel rim
  light in each runner's colour, a hex shield bubble, and a scan x-ray silhouette.

### 2. Better gunplay
- A detailed first-person energy rifle with arms, an on-gun ammo display and a holographic sight.
- **Recoil**: a camera kick that climbs during a burst with horizontal drift, spring-driven weapon kick,
  sway, walk bob, landing dip, and reduced recoil while aiming down sights.
- **Aim down sights** with FOV zoom and a holographic reticle.
- **Muzzle flashes**: crossed flash sprites plus a dynamic flash light on the viewmodel and in the world.
- **Reload animation**: the gun tilts, the hand pulls the magazine, a fresh one goes in, the charging handle racks.
  It is keyed to the simulation's reload timer, so it always matches the server.
- **Impact effects**: spark streaks, debris, smoke puffs, glowing bullet-hole decals, water splashes on the wet floor,
  energy bursts in the victim's colour, and death explosions with shockwave rings. Ejected shell casings bounce and clink.
- **Hit markers** confirmed by the server, with separate headshot, kill and spawn-protected styles. Also floating
  damage numbers, directional damage indicators, kill banners and a death cam that turns to face your killer.
- **Positional audio**: every sound is synthesised at load time and played through HRTF 3D panning. Gunshots switch
  to a distant variant at range, sounds behind walls are muffled, a convolution reverb bus adds space, and there are
  footsteps, near-miss whizzes, reload foley, shell tinks, rain ambience and neon buzz.

### 3. Real multiplayer (authoritative server)
- `shared/sim.js` holds the movement, collision, weapon and ray-casting code. The server and the browser run the same
  file, so they get the same results.
- **Clients send only inputs**: movement axes, view angles and buttons. The server runs every player at 60 Hz and owns
  position, velocity, ammo, reload, fire rate, health, damage and score. Position data sent by a client is ignored.
- **Client-side prediction with server reconciliation**: your own movement is instant. When a snapshot arrives the
  client rewinds to the server state, replays the inputs the server hasn't processed yet, and smooths any
  correction away.
- **Entity interpolation**: other players are drawn 100 ms in the past, between two snapshots (30 Hz), with brief
  extrapolation if a packet is late.
- **Server-side hit detection with lag compensation**: the server keeps 1 s of position history and rewinds targets to
  what the shooter saw (capped at 300 ms). Shots are traced from the server's own eye position against a head sphere
  and torso and leg capsules, and they are blocked by walls. Damage drops off with distance, headshots do 2x and
  shields reduce damage.
- **Anti-cheat validation**: inputs are sanitised and clamped. Each player has a simulation-time budget, so speed hacks
  and input flooding can't move anyone faster than real time. The fire rate and the magazine are enforced by the
  simulation. Spawn protection and respawns are decided by the server, which picks the spawn furthest from enemies.

## Project layout
```
server.js           Express + Socket.IO authoritative game server (60 Hz tick, snapshots, lag compensation)
shared/sim.js       Shared deterministic simulation (map, movement, collision, weapons, ray casts, damage)
public/index.html   UI markup + import map
public/css/         HUD and menu styles
public/js/main.js   Client: input, prediction/reconciliation, interpolation, game loop
public/js/world.js  Arena, materials, lights, shadows, reflections, fog, mist, rain, skyline
public/js/textures.js  Procedural PBR texture generator
public/js/effects.js   Particles, sparks, tracers, decals, shells, flashes, rings
public/js/weapon.js    First-person rifle, recoil/sway/ADS/reload animation
public/js/avatar.js    Third-person player models
public/js/audio.js     Procedural positional audio engine
public/js/post.js      Post-processing chain
public/js/hud.js       HUD rendering
test/               `npm test`: simulation unit tests and server integration tests
```

## Notes and limitations
- The server runs at 60 Hz and a match supports up to 8 players. The arena is a fixed, hand-built map.
- High and Ultra are meant for a dedicated GPU. Start with Medium on laptops and Low on mobile; touch controls are still experimental.
- Aim is not validated beyond basic sanity checks (that is out of scope for a browser game without kernel-level anti-cheat),
  but everything else that affects other players is computed by the server.

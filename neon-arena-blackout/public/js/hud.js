// DOM heads-up display: vitals, ammo pips, reload bar, ability cooldowns, dynamic
// crosshair, hit markers, damage numbers, damage direction arcs, kill banners, scoreboard.
const Sim = window.NeonSim;
const $ = id => document.getElementById(id);
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Hud {
  constructor() {
    this.pips = [];
    const pc = $('ammoPips');
    for (let i = 0; i < Sim.MAG_SIZE; i++) { const p = document.createElement('i'); pc.appendChild(p); this.pips.push(p); }
    this.last = {};
    this.dmgNums = [];
    this.gap = 6;
  }
  set(key, val, fn) { if (this.last[key] !== val) { this.last[key] = val; fn(val); } }

  vitals(hp) {
    this.set('hp', hp, v => {
      $('hp').textContent = v;
      $('healthFill').style.width = v + '%';
      $('healthGhost').style.width = v + '%';
      $('healthFill').classList.toggle('low', v <= 35);
    });
  }
  ammo(ammo, reloadTicks) {
    this.set('ammo', ammo, v => {
      $('ammo').textContent = v;
      this.pips.forEach((p, i) => p.classList.toggle('spent', i >= v));
      $('ammo').parentElement.classList.toggle('low', v <= 6);
    });
    const r = reloadTicks > 0 ? 1 - reloadTicks / Sim.RELOAD_TICKS : 0;
    this.set('reload', Math.round(r * 100), v => { $('reloadFill').style.width = v + '%'; });
  }
  status(text) { this.set('status', text, v => { $('weaponStatus').textContent = v; }); }
  score(score) { this.set('score', score, v => { $('score').textContent = String(v).padStart(3, '0'); }); }
  timer(t) { this.set('timer', t, v => { $('timer').textContent = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; }); }
  net(text) { this.set('net', text, v => { $('netStats').textContent = v; }); }
  ability(id, cdFrac, active) {
    this.set(id + 'cd', Math.round(cdFrac * 50), v => { $(id).style.setProperty('--cd', (v / 50).toFixed(2)); $(id).classList.toggle('ready', v === 0); });
    this.set(id + 'on', active, v => $(id).classList.toggle('active', v));
  }
  crosshair(spread, ads) {
    this.gap += (6 + spread - this.gap) * 0.35;
    const g = Math.round(this.gap * 2) / 2;
    this.set('gap', g, v => $('crosshair').style.setProperty('--gap', v + 'px'));
    this.set('ads', ads, v => $('crosshair').classList.toggle('ads', v));
  }
  hitmarker(kind) {
    const el = $('hitmarker');
    el.className = 'hitmarker';
    void el.offsetWidth;
    el.className = 'hitmarker show ' + kind;
  }
  damageNumber(text, cls, worldPos) {
    const el = document.createElement('div');
    el.className = 'dmgnum ' + (cls || '');
    el.textContent = text;
    $('dmgNums').appendChild(el);
    this.dmgNums.push({ el, pos: worldPos.clone(), t: 0, dx: (Math.random() - 0.5) * 40 });
  }
  updateDamageNumbers(dt, camera) {
    const w = innerWidth, h = innerHeight;
    for (let i = this.dmgNums.length - 1; i >= 0; i--) {
      const d = this.dmgNums[i];
      d.t += dt;
      if (d.t > 0.9) { d.el.remove(); this.dmgNums.splice(i, 1); continue; }
      const p = d.pos.clone().project(camera);
      if (p.z > 1) { d.el.style.opacity = 0; continue; }
      const x = (p.x * 0.5 + 0.5) * w + d.dx * d.t, y = (-p.y * 0.5 + 0.5) * h - d.t * 60;
      const s = d.t < 0.12 ? 1 + (0.12 - d.t) * 5 : 1;
      d.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%) scale(${s.toFixed(2)})`;
      d.el.style.left = '0'; d.el.style.top = '0';
      d.el.style.opacity = Math.min(1, (0.9 - d.t) * 3).toFixed(2);
    }
  }
  damageDirection(angle) {
    const el = document.createElement('div');
    el.className = 'dmgdir';
    el.style.transform = `rotate(${angle}rad)`;
    $('dmgDirs').appendChild(el);
    setTimeout(() => el.remove(), 1150);
  }
  killBanner(html) {
    const el = $('killBanner');
    el.innerHTML = html;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
  notice(text, ms = 1100) {
    const el = $('notice'); el.textContent = text; el.classList.add('show');
    clearTimeout(this.noticeT); this.noticeT = setTimeout(() => el.classList.remove('show'), ms);
  }
  leaderboard(players, myId) {
    const html = [...players].sort((a, b) => b.score - a.score || b.kills - a.kills)
      .map(p => `<div class="rankrow ${p.id === myId ? 'me' : ''}"><span><i style="background:${p.color}"></i>${escapeHtml(p.name)}</span><b>${p.score}</b></div>`).join('');
    this.set('lb', html, v => { $('leaderRows').innerHTML = v; });
    const sb = '<div class="scorerow head"><span>#</span><span>RUNNER</span><span>K</span><span>D</span><span>SCORE</span></div>' +
      [...players].sort((a, b) => b.score - a.score || b.kills - a.kills).map((p, i) =>
        `<div class="scorerow ${p.id === myId ? 'me' : ''}"><span>${i + 1}</span><span><i style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${p.color}"></i>${escapeHtml(p.name)}</span><span>${p.kills}</span><span>${p.deaths}</span><span>${p.score}</span></div>`).join('');
    this.set('sb', sb, v => { $('scoreRows').innerHTML = v; });
  }
  feed(items) {
    const html = items.slice(-4).map(f => `<div class="feeditem ${f.kind === 'kill' ? '' : 'info'}">${escapeHtml(f.message)}</div>`).join('');
    this.set('feed', html, v => { $('feed').innerHTML = v; });
  }
  death(show, by, respawnIn) {
    this.set('dead', show, v => { $('deathScreen').classList.toggle('hidden', !v); $('gameHud').classList.toggle('dead', v); });
    if (show) {
      this.set('by', by, v => { $('killedBy').innerHTML = v ? `by <b style="color:var(--pink)">${escapeHtml(v)}</b>` : ''; });
      this.set('rin', respawnIn, v => { $('respawnIn').textContent = v > 0 ? `REDEPLOYING IN ${v.toFixed(1)}s` : 'REDEPLOYING…'; });
    }
  }
}

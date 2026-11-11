(() => {
  const cvs = document.getElementById('c');
  const ctx = cvs.getContext('2d');
  const $ = id => document.getElementById(id);
  let W, H, DPR;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cvs.width = W * DPR; cvs.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (player) player.y = H - 70;
  }

  // ---------- background ----------
  const bgStars = [];
  function makeBg() {
    bgStars.length = 0;
    const n = Math.floor((window.innerWidth * window.innerHeight) / 4000);
    for (let i = 0; i < n; i++) bgStars.push({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + .2, t: Math.random() * 6, s: Math.random() * .02 + .005 });
  }

  // ---------- audio (tiny synth) ----------
  let actx = null;
  function beep(freq, dur = .1, type = 'sine', vol = .12, slide = 0) {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), actx.currentTime + dur);
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  }
  const NOTES = [523, 587, 659, 784, 880, 988, 1047, 1175, 1319, 1568];

  // ---------- state ----------
  let player = null, items = [], particles = [], floaters = [];
  let score, lives, level, combo, comboTimer, spawnT, elapsed, magnetT, shake, running = false, paused = false;
  let best = +localStorage.getItem('starcatcher-best') || 0;
  const keys = { left: 0, right: 0 };
  let pointerX = null;

  function showBest() {
    const t = best ? `Best: ${best}` : '';
    $('bestStart').textContent = t; $('bestOver').textContent = t;
  }
  showBest();

  function reset() {
    player = { x: W / 2, y: H - 70, w: 70, vx: 0, squash: 0 };
    items = []; particles = []; floaters = [];
    score = 0; lives = 3; level = 1; combo = 0; comboTimer = 0; spawnT = 0; elapsed = 0; magnetT = 0; shake = 0;
    pointerX = null;
    updateHud();
  }

  function updateHud() {
    $('score').textContent = score;
    $('level').textContent = 'LEVEL ' + level + (magnetT > 0 ? '  ·  MAGNET' : '');
    $('lives').textContent = '♥'.repeat(Math.max(0, lives));
  }

  // ---------- spawning ----------
  function spawn() {
    const r = Math.random();
    const speed = 120 + level * 22 + Math.random() * 60;
    const x = 30 + Math.random() * (W - 60);
    let type;
    const meteorChance = Math.min(.12 + level * .025, .38);
    if (r < meteorChance) type = 'meteor';
    else if (r < meteorChance + .06) type = 'rare';
    else if (r < meteorChance + .085 && lives < 5) type = 'heart';
    else if (r < meteorChance + .105) type = 'magnet';
    else type = 'star';
    const size = type === 'meteor' ? 16 + Math.random() * 12 : type === 'rare' ? 16 : 14;
    items.push({ type, x, y: -30, vy: type === 'meteor' ? speed * 1.15 : speed, vx: type === 'meteor' ? (Math.random() - .5) * 80 : 0, size, rot: Math.random() * 6, vr: (Math.random() - .5) * 4, wob: Math.random() * 6 });
  }

  function burst(x, y, color, n = 14, spd = 220) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * spd;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 1, decay: .8 + Math.random() * 1.2, color, r: Math.random() * 3 + 1 });
    }
  }
  function floatText(x, y, text, color) { floaters.push({ x, y, text, color, life: 1 }); }

  function showCombo() {
    const el = $('combo');
    if (combo >= 3) { el.textContent = `COMBO ×${comboMult()}  (${combo})`; el.style.opacity = 1; }
    else el.style.opacity = 0;
  }
  const comboMult = () => 1 + Math.floor(combo / 5);

  // ---------- update ----------
  function update(dt) {
    elapsed += dt;
    const newLevel = 1 + Math.floor(elapsed / 20);
    if (newLevel !== level) { level = newLevel; floatText(W / 2, H / 2, 'LEVEL ' + level, '#8ff7ff'); beep(660, .3, 'triangle', .1, 600); }

    // movement
    const accel = 2600, maxV = 620;
    if (keys.left || keys.right) {
      pointerX = null;
      player.vx += (keys.right - keys.left) * accel * dt;
      player.vx = Math.max(-maxV, Math.min(maxV, player.vx));
    } else if (pointerX !== null) {
      const target = pointerX;
      const prev = player.x;
      player.x += (target - player.x) * Math.min(1, dt * 16);
      player.vx = (player.x - prev) / dt;
    } else player.vx *= Math.pow(.002, dt);
    if (keys.left || keys.right || pointerX === null) player.x += player.vx * dt;
    player.x = Math.max(player.w / 2, Math.min(W - player.w / 2, player.x));
    player.squash *= Math.pow(.001, dt);

    if (magnetT > 0) { magnetT -= dt; if (magnetT <= 0) updateHud(); }
    if (comboTimer > 0) { comboTimer -= dt; if (comboTimer <= 0) { combo = 0; showCombo(); } }

    spawnT -= dt;
    if (spawnT <= 0) { spawn(); spawnT = Math.max(.22, .85 - level * .06) * (.6 + Math.random() * .8); }

    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.wob += dt * 3; it.rot += it.vr * dt;
      if (magnetT > 0 && it.type !== 'meteor') {
        const dx = player.x - it.x, dy = player.y - it.y, d = Math.hypot(dx, dy);
        if (d < 320) { it.x += dx / d * 380 * dt; it.y += dy / d * 200 * dt; }
      }
      it.y += it.vy * dt;
      it.x += (it.vx + (it.type === 'meteor' ? 0 : Math.sin(it.wob) * 20)) * dt;
      if (it.type === 'meteor' && Math.random() < .6) particles.push({ x: it.x, y: it.y - it.size * .5, vx: (Math.random() - .5) * 30, vy: -40, life: .7, decay: 2, color: Math.random() < .5 ? '#ff6a3d' : '#ffb03d', r: Math.random() * it.size * .3 + 2 });

      // collision
      const dx = Math.abs(it.x - player.x), dy = it.y - player.y;
      if (dx < player.w / 2 + it.size * .6 && dy > -28 && dy < 18) {
        items.splice(i, 1);
        catchItem(it);
        continue;
      }
      if (it.y > H + 40) {
        items.splice(i, 1);
        if (it.type === 'star' || it.type === 'rare') { if (combo > 0) { combo = 0; showCombo(); } }
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.life -= p.decay * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; f.y -= 50 * dt; f.life -= dt * .9;
      if (f.life <= 0) floaters.splice(i, 1);
    }
    shake *= Math.pow(.01, dt);
    for (const s of bgStars) s.t += s.s;
  }

  function catchItem(it) {
    player.squash = 1;
    if (it.type === 'meteor') {
      lives--; combo = 0; shake = 18; showCombo();
      burst(it.x, it.y, '#ff6a3d', 30, 320);
      beep(120, .4, 'sawtooth', .15, -80);
      floatText(it.x, it.y - 20, 'OUCH!', '#ff6a3d');
      updateHud();
      if (lives <= 0) gameOver();
      return;
    }
    if (it.type === 'heart') {
      lives = Math.min(5, lives + 1);
      burst(it.x, it.y, '#ff5fa2', 20); beep(784, .15, 'triangle'); setTimeout(() => beep(1047, .2, 'triangle'), 90);
      floatText(it.x, it.y - 20, '+1 ♥', '#ff5fa2'); updateHud(); return;
    }
    if (it.type === 'magnet') {
      magnetT = 7;
      burst(it.x, it.y, '#b28cff', 20); beep(400, .35, 'square', .06, 500);
      floatText(it.x, it.y - 20, 'MAGNET!', '#b28cff'); updateHud(); return;
    }
    combo++; comboTimer = 2.2;
    const base = it.type === 'rare' ? 50 : 10;
    const pts = base * comboMult();
    score += pts;
    burst(it.x, it.y, it.type === 'rare' ? '#8ff7ff' : '#ffd84a', it.type === 'rare' ? 24 : 12);
    beep(NOTES[Math.min(combo - 1, NOTES.length - 1) % NOTES.length], .12, 'triangle', .1);
    floatText(it.x, it.y - 20, '+' + pts, it.type === 'rare' ? '#8ff7ff' : '#ffd84a');
    showCombo(); updateHud();
  }

  // ---------- drawing ----------
  function starPath(x, y, r, rot, pts = 5, inner = .45) {
    ctx.beginPath();
    for (let i = 0; i < pts * 2; i++) {
      const rr = i % 2 ? r * inner : r, a = rot + i * Math.PI / pts - Math.PI / 2;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }

  function drawBg() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b0826'); g.addColorStop(.6, '#1d1150'); g.addColorStop(1, '#3a1a63');
    ctx.fillStyle = g; ctx.fillRect(-30, -30, W + 60, H + 60);
    for (const s of bgStars) {
      ctx.globalAlpha = .35 + Math.sin(s.t) * .3 + .3;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // hills
    ctx.fillStyle = '#140b38';
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, H - 30 - Math.sin(x * .006) * 18 - Math.sin(x * .017) * 8);
    ctx.lineTo(W, H); ctx.fill();
  }

  function drawItem(it) {
    ctx.save();
    if (it.type === 'star' || it.type === 'rare') {
      const c = it.type === 'rare' ? '#8ff7ff' : '#ffd84a';
      ctx.shadowColor = c; ctx.shadowBlur = it.type === 'rare' ? 26 : 16;
      ctx.fillStyle = c; starPath(it.x, it.y, it.size, it.rot); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,.7)'; starPath(it.x, it.y, it.size * .45, it.rot); ctx.fill();
      // trail
      ctx.globalAlpha = .25; ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(it.x, it.y - it.size); ctx.lineTo(it.x, it.y - it.size - 26); ctx.stroke();
    } else if (it.type === 'meteor') {
      ctx.shadowColor = '#ff6a3d'; ctx.shadowBlur = 24;
      ctx.translate(it.x, it.y); ctx.rotate(it.rot);
      ctx.fillStyle = '#7a3b2a';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, r = it.size * (i % 2 ? .82 : 1); ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#4f2419';
      ctx.beginPath(); ctx.arc(it.size * .3, -it.size * .2, it.size * .22, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(-it.size * .3, it.size * .3, it.size * .15, 0, 7); ctx.fill();
    } else if (it.type === 'heart') {
      ctx.shadowColor = '#ff5fa2'; ctx.shadowBlur = 20; ctx.fillStyle = '#ff5fa2';
      const s = it.size * .9 * (1 + Math.sin(it.wob * 2) * .08);
      ctx.translate(it.x, it.y);
      ctx.beginPath(); ctx.moveTo(0, s * .9);
      ctx.bezierCurveTo(-s * 1.6, -s * .2, -s * .6, -s * 1.3, 0, -s * .4);
      ctx.bezierCurveTo(s * .6, -s * 1.3, s * 1.6, -s * .2, 0, s * .9); ctx.fill();
    } else if (it.type === 'magnet') {
      ctx.shadowColor = '#b28cff'; ctx.shadowBlur = 22;
      ctx.strokeStyle = '#b28cff'; ctx.lineWidth = 3;
      for (let k = 0; k < 3; k++) { ctx.globalAlpha = 1 - k * .3; ctx.beginPath(); ctx.arc(it.x, it.y, it.size * (.4 + k * .35) + Math.sin(it.wob * 2) * 2, 0, 7); ctx.stroke(); }
    }
    ctx.restore();
  }

  function drawPlayer() {
    const p = player, sq = p.squash * .18;
    const tilt = Math.max(-.25, Math.min(.25, p.vx / 2400));
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(tilt); ctx.scale(1 + sq, 1 - sq);
    if (magnetT > 0) {
      ctx.strokeStyle = `rgba(178,140,255,${.25 + Math.sin(elapsed * 10) * .15})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, -6, 60 + Math.sin(elapsed * 6) * 6, 0, 7); ctx.stroke();
    }
    // glow
    const g = ctx.createRadialGradient(0, 0, 4, 0, 0, 70);
    g.addColorStop(0, 'rgba(255,230,140,.35)'); g.addColorStop(1, 'rgba(255,230,140,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 70, 0, 7); ctx.fill();
    // jar body
    const w = p.w / 2;
    ctx.fillStyle = 'rgba(160,220,255,.22)'; ctx.strokeStyle = 'rgba(220,245,255,.9)'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-w, -22); ctx.quadraticCurveTo(-w - 4, 18, -w * .7, 24);
    ctx.lineTo(w * .7, 24); ctx.quadraticCurveTo(w + 4, 18, w, -22);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // collected glow inside
    const fill = Math.min(1, (score % 500) / 500);
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(255,216,74,.55)'; ctx.fillRect(-w - 6, 24 - fill * 46, p.w + 12, 50);
    ctx.restore();
    // rim
    ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.ellipse(0, -22, w + 3, 6, 0, 0, 7); ctx.fill();
    // face
    ctx.fillStyle = '#0b0826';
    ctx.beginPath(); ctx.arc(-10, 2, 3, 0, 7); ctx.arc(10, 2, 3, 0, 7); ctx.fill();
    ctx.strokeStyle = '#0b0826'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 7, 5, .2, Math.PI - .2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,95,162,.5)';
    ctx.beginPath(); ctx.arc(-17, 9, 3.5, 0, 7); ctx.arc(17, 9, 3.5, 0, 7); ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.save();
    if (shake > .5) ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);
    drawBg();
    if (running || player) {
      for (const it of items) drawItem(it);
      if (player) drawPlayer();
      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center'; ctx.font = '700 22px Fredoka, sans-serif';
      for (const f of floaters) { ctx.globalAlpha = Math.max(0, f.life); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ---------- loop ----------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (running && !paused) update(dt);
    else for (const s of bgStars) s.t += s.s;
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- flow ----------
  function start() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (actx && actx.state === 'suspended') actx.resume();
    reset();
    running = true; paused = false;
    $('start').classList.add('hidden'); $('over').classList.add('hidden'); $('paused').classList.add('hidden');
    $('hud').classList.remove('hidden');
    beep(523, .1, 'triangle'); setTimeout(() => beep(784, .15, 'triangle'), 100);
  }
  function gameOver() {
    running = false;
    if (score > best) { best = score; localStorage.setItem('starcatcher-best', best); }
    $('final').textContent = score;
    showBest();
    if (score === best && score > 0) $('bestOver').textContent = '★ New best! ★';
    $('combo').style.opacity = 0;
    setTimeout(() => $('over').classList.remove('hidden'), 600);
  }
  function togglePause() {
    if (!running) return;
    paused = !paused;
    $('paused').classList.toggle('hidden', !paused);
  }

  $('play').onclick = start;
  $('again').onclick = start;
  $('resume').onclick = togglePause;

  window.addEventListener('keydown', e => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.left = 1;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.right = 1;
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause();
    if ((e.key === 'Enter' || e.key === ' ') && !running) { e.preventDefault(); start(); }
  });
  window.addEventListener('keyup', e => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.left = 0;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.right = 0;
  });
  const setPointer = e => { if (running && !paused) pointerX = e.clientX; };
  cvs.addEventListener('pointermove', setPointer);
  cvs.addEventListener('pointerdown', setPointer);
  window.addEventListener('blur', () => { keys.left = keys.right = 0; if (running && !paused) togglePause(); });
  window.addEventListener('resize', () => { resize(); makeBg(); });

  resize(); makeBg();
  requestAnimationFrame(loop);
})();

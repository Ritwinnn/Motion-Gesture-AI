/* ═══════════════════════════════════════════════════════
   CONFIG  — tune to match your Edge Impulse model
═══════════════════════════════════════════════════════ */
const LABELS   = ['shake', 'idle', 'up-down'];
const ICONS    = { shake: '📳', idle: '😴', 'up-down': '↕️' };
const COLORS   = { shake: '#f59e0b', idle: '#2dd4bf', 'up-down': '#a78bfa' };
const GLOWS    = { shake: 'glow-shake', idle: 'glow-idle', 'up-down': 'glow-updown' };
const FILLS    = {
  shake:    'linear-gradient(90deg,#f59e0b,#fcd34d)',
  idle:     'linear-gradient(90deg,#2dd4bf,#5eead4)',
  'up-down':'linear-gradient(90deg,#8b5cf6,#a78bfa)',
};

const EI_FREQ  = 62.5;
const EI_INT   = 1000 / EI_FREQ;   // ~16 ms
const WIN      = 62;                // windows model expects
const BUF_LEN  = WIN * 3;          // X,Y,Z interleaved

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
let buf = new Float32Array(BUF_LEN);
let bHead = 0, bFilled = false;
let active = false, cleanup = null, pollT = null;
let gx = 0, gy = 0, gz = 9.81;
const ALPHA = 0.8;

// Waveform history
const W_SAMPLES = 300;
const waveX = new Array(W_SAMPLES).fill(0);
const waveY = new Array(W_SAMPLES).fill(0);
const waveZ = new Array(W_SAMPLES).fill(0);

// FPS tracking
let frames = 0, lastFpsTime = performance.now(), fps = 60;

/* ═══════════════════════════════════════════════════════
   DOM
═══════════════════════════════════════════════════════ */
const canvas    = document.getElementById('waveCanvas');
const ctx       = canvas.getContext('2d');
const probList  = document.getElementById('probList');
const confCard  = document.getElementById('confCard');
const btnStart  = document.getElementById('btnStart');
const statusTxt = document.getElementById('statusTxt');

/* ═══════════════════════════════════════════════════════
   BUILD PROBABILITY ROWS
═══════════════════════════════════════════════════════ */
const probEls = {};
LABELS.forEach(lbl => {
  const row = document.createElement('div');
  row.className = 'prob-row';
  row.id = 'pr-' + lbl;
  row.innerHTML = `
    <div class="prob-label-row">
      <span class="prob-name">${lbl}</span>
      <span class="prob-pct" id="pp-${lbl}">0%</span>
    </div>
    <div class="prob-track">
      <div class="prob-fill" id="pf-${lbl}" style="background:${FILLS[lbl]}"></div>
    </div>`;
  probList.appendChild(row);
  probEls[lbl] = {
    row,
    fill: null,
    pct:  null,
  };
});
LABELS.forEach(l => {
  probEls[l].fill = document.getElementById('pf-' + l);
  probEls[l].pct  = document.getElementById('pp-' + l);
});

/* ═══════════════════════════════════════════════════════
   CANVAS — 60fps waveform
═══════════════════════════════════════════════════════ */
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width  = Math.floor(rect.width - 28);
  canvas.height = 100;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function drawWave() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0b0f';
  ctx.fillRect(0, 0, W, H);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let y = H / 4; y < H; y += H / 4) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  for (let x = 0; x < W; x += W / 8) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  const MID = H / 2, SCALE = H * 0.18;

  function drawLine(arr, color, lineW = 1.5) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    arr.forEach((v, i) => {
      const px = (i / (W_SAMPLES - 1)) * W;
      const py = MID - v * SCALE;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    // glow pass
    ctx.lineWidth = lineW * 3;
    ctx.globalAlpha = 0.12;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawLine(waveX, '#5b6ef5');
  drawLine(waveY, '#2dd4bf');
  drawLine(waveZ, '#a78bfa');

  // fps counter
  frames++;
  const now = performance.now();
  if (now - lastFpsTime > 500) {
    fps = Math.round(frames * 1000 / (now - lastFpsTime));
    frames = 0;
    lastFpsTime = now;
    document.getElementById('fpsBadge').textContent = fps + ' fps';
  }

  requestAnimationFrame(drawWave);
}
drawWave();

/* ═══════════════════════════════════════════════════════
   SAMPLE BUFFER
═══════════════════════════════════════════════════════ */
function pushSample(x, y, z) {
  buf[bHead]     = x;
  buf[bHead + 1] = y;
  buf[bHead + 2] = z;
  bHead = (bHead + 3) % BUF_LEN;
  if (!bHead) bFilled = true;

  waveX.push(x); waveX.shift();
  waveY.push(y); waveY.shift();
  waveZ.push(z); waveZ.shift();

  const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(3);
  document.getElementById('axX').textContent = fmt(x);
  document.getElementById('axY').textContent = fmt(y);
  document.getElementById('axZ').textContent = fmt(z);
}

function getFlat() {
  if (!bFilled) return buf.slice(0, bHead);
  const out = new Float32Array(BUF_LEN);
  out.set(buf.subarray(bHead));
  out.set(buf.subarray(0, bHead), BUF_LEN - bHead);
  return out;
}

/* ═══════════════════════════════════════════════════════
   CLASSIFIER
═══════════════════════════════════════════════════════ */
function runClassifier() {
  if (!bFilled && bHead < BUF_LEN * 0.5) return;
  const flat = getFlat();
  let probs;

  // Try WASM first
  if (window.run_classifier) {
    try {
      const r = window.run_classifier(flat, flat.length, false);
      if (r && r.result) probs = r.result.classification;
    } catch (e) { /* fall through */ }
  }

  if (!probs) probs = heuristic(flat);
  updateUI(probs);
}

function heuristic(flat) {
  let sX = 0, sY = 0, sZ = 0;
  const n = flat.length / 3;
  for (let i = 0; i < flat.length; i += 3) { sX += flat[i]; sY += flat[i+1]; sZ += flat[i+2]; }
  let mx = sX/n, my = sY/n, mz = sZ/n, vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < flat.length; i += 3) {
    vx += (flat[i]-mx)**2; vy += (flat[i+1]-my)**2; vz += (flat[i+2]-mz)**2;
  }
  vx /= n; vy /= n; vz /= n;
  const tv = vx + vy + vz;

  if (tv < 0.08) return { idle: 0.92, shake: 0.04, 'up-down': 0.04 };
  if (vz > vx * 1.5 && vz > vy * 1.5) {
    const u = Math.min(0.95, 0.5 + vz * 0.4);
    return { idle: 0.05, shake: 1 - u - 0.05, 'up-down': u };
  }
  const sh = Math.min(0.95, 0.4 + tv * 0.3);
  return { idle: 0.05, shake: sh, 'up-down': 1 - sh - 0.05 };
}

function updateUI(cl) {
  let best = null, bestP = -1;
  LABELS.forEach(l => { const p = cl[l] ?? 0; if (p > bestP) { bestP = p; best = l; } });

  LABELS.forEach(l => {
    const p = cl[l] ?? 0;
    probEls[l].fill.style.width = (p * 100).toFixed(1) + '%';
    probEls[l].pct.textContent  = (p * 100).toFixed(1) + '%';
    probEls[l].row.classList.toggle('best', l === best);
  });

  confCard.className = 'conf-card ' + (GLOWS[best] || '');
  document.getElementById('gestureIcon').textContent = ICONS[best] || '🔮';
  document.getElementById('gestureName').textContent = best || '–';
  document.getElementById('confPct').textContent     = (bestP * 100).toFixed(1) + '%';
  const fill = document.getElementById('confFill');
  fill.style.width      = (bestP * 100).toFixed(1) + '%';
  fill.style.background = FILLS[best] || 'var(--acc)';
}

/* ═══════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════ */
function setMode(id) {
  ['m0','m1','m2','m3'].forEach(m => document.getElementById(m).classList.remove('lit'));
  if (id) document.getElementById(id).classList.add('lit');
}
function setBadge(id, on) {
  const el = document.getElementById(id);
  el.classList.toggle('active', on);
  el.classList.toggle('off', !on);
}
function setStatus(t) { statusTxt.textContent = t; }

/* ═══════════════════════════════════════════════════════
   SENSOR TIERS
═══════════════════════════════════════════════════════ */

// Tier 1 — W3C LinearAccelerationSensor
async function tier1() {
  if (!('LinearAccelerationSensor' in window)) throw new Error('not supported');
  const s = new LinearAccelerationSensor({ frequency: EI_FREQ });
  await new Promise((res, rej) => {
    s.addEventListener('reading', res, { once: true });
    s.addEventListener('error',   rej, { once: true });
    s.start();
    setTimeout(rej, 3000);
  });
  const h = () => pushSample(s.x || 0, s.y || 0, s.z || 0);
  s.addEventListener('reading', h);
  setMode('m1');
  setStatus('Generic Sensor API active');
  return () => { s.removeEventListener('reading', h); s.stop(); };
}

// Tier 2 — DeviceMotionEvent.acceleration (gravity already removed by HW)
async function tier2() {
  if (!('DeviceMotionEvent' in window)) throw new Error('not supported');
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission();
    if (r !== 'granted') throw new Error('denied');
  }
  return new Promise((res, rej) => {
    let got = false;
    const h = e => {
      const a = e.acceleration;
      if (!a || a.x === null) return;
      got = true;
      pushSample(a.x || 0, a.y || 0, a.z || 0);
    };
    window.addEventListener('devicemotion', h);
    setTimeout(() => {
      if (!got) { window.removeEventListener('devicemotion', h); rej(new Error('no data')); }
      else { setMode('m2'); setStatus('HW Motion active'); res(() => window.removeEventListener('devicemotion', h)); }
    }, 1500);
  });
}

// Tier 3 — Soft gravity filter (high-pass on accelerationIncludingGravity)
async function tier3() {
  if (!('DeviceMotionEvent' in window)) throw new Error('not supported');
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission();
    if (r !== 'granted') throw new Error('denied');
  }
  return new Promise((res, rej) => {
    let got = false;
    const h = e => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null) return;
      got = true;
      gx = ALPHA * gx + (1 - ALPHA) * (a.x || 0);
      gy = ALPHA * gy + (1 - ALPHA) * (a.y || 0);
      gz = ALPHA * gz + (1 - ALPHA) * (a.z || 0);
      pushSample((a.x || 0) - gx, (a.y || 0) - gy, (a.z || 0) - gz);
    };
    window.addEventListener('devicemotion', h);
    setTimeout(() => {
      if (!got) { window.removeEventListener('devicemotion', h); rej(new Error('no data')); }
      else { setMode('m3'); setStatus('SW Filter active'); res(() => window.removeEventListener('devicemotion', h)); }
    }, 1500);
  });
}

// Demo — synthetic signal when no hardware is available
function demoMode() {
  let t = 0;
  const iv = setInterval(() => {
    t += EI_INT / 1000;
    const n  = () => (Math.random() - 0.5) * 0.18;
    const sh = Math.sin(t * 20) * Math.max(0, Math.sin(t * 0.8) - 0.2) * 7;
    const ud = Math.sin(t * 4.5) * Math.max(0, Math.sin(t * 0.22) - 0.45) * 6;
    pushSample(sh + n(), n() * 0.5, ud + Math.sin(t * 0.35) * 0.25 + n());
  }, EI_INT);
  setMode('m0');
  setStatus('Demo mode — no real sensor found');
  return () => clearInterval(iv);
}

/* ═══════════════════════════════════════════════════════
   START / STOP
═══════════════════════════════════════════════════════ */
async function start() {
  btnStart.disabled = true;
  btnStart.textContent = 'Connecting…';
  setBadge('badgeSensor', false);
  setBadge('badgeModel',  false);
  setBadge('badgeLive',   false);
  setStatus('Requesting sensor access…');

  let cl = null;
  try        { cl = await tier1(); }
  catch (e1) {
    try        { cl = await tier2(); }
    catch (e2) {
      try        { cl = await tier3(); }
      catch (e3) { cl = demoMode(); }
    }
  }

  cleanup = cl;
  active  = true;

  setBadge('badgeSensor', true);
  setBadge('badgeModel',  true);
  setTimeout(() => setBadge('badgeLive', true), 600);

  pollT = setInterval(runClassifier, EI_INT * 4);

  btnStart.disabled = false;
  btnStart.textContent = 'Stop';
  btnStart.classList.add('stop');
}

function stop() {
  if (cleanup) { cleanup(); cleanup = null; }
  if (pollT)   { clearInterval(pollT); pollT = null; }
  active = false;

  setBadge('badgeSensor', false);
  setBadge('badgeModel',  false);
  setBadge('badgeLive',   false);
  setMode(null);

  btnStart.textContent = 'Start Sensors';
  btnStart.classList.remove('stop');
  setStatus('Stopped. Tap to restart.');

  // reset axes
  ['axX','axY','axZ'].forEach(id => document.getElementById(id).textContent = '–');

  // reset waveform
  waveX.fill(0); waveY.fill(0); waveZ.fill(0);

  // reset buffer
  buf    = new Float32Array(BUF_LEN);
  bHead  = 0;
  bFilled = false;

  // reset prediction
  confCard.className = 'conf-card';
  document.getElementById('gestureIcon').textContent = '🤖';
  document.getElementById('gestureName').textContent = 'waiting';
  document.getElementById('confPct').textContent     = '–';
  document.getElementById('confFill').style.width    = '0%';
  LABELS.forEach(l => {
    probEls[l].fill.style.width = '0%';
    probEls[l].pct.textContent  = '0%';
    probEls[l].row.classList.remove('best');
  });
}

btnStart.addEventListener('click', () => { if (active) stop(); else start(); });

/* ── Load Edge Impulse WASM if present ── */
(function () {
  const s = document.createElement('script');
  s.src = './edge-impulse-standalone.js';
  s.onerror = () => console.warn('[MotionAI] edge-impulse-standalone.js not found — using heuristic demo classifier.');
  s.onload  = () => console.info('[MotionAI] Edge Impulse WASM loaded.');
  document.head.appendChild(s);
})();

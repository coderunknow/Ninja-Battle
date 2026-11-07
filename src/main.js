// Entry point: canvas setup, master clock, input, player chrome.
//
// Clock model
// -----------
// The animation position is a single number `t` (seconds into the production).
// Every frame we render *exactly* what the timeline says at `t` — the renderer has
// no memory. That makes pause, seek and replay trivially exact:
//   play   : t += dt * rate
//   pause  : stop advancing t, keep rendering the same t
//   seek   : t = target, then resync audio
// A slow-motion region simply scales `rate`, which keeps music in sync because
// the music scheduler is driven from the same `t`.

import { renderAt, initAssets, TOTAL_DURATION, compile } from './scene/stage.js';
import { AudioDirector } from './audio/director.js';
import { QUALITY, PROFILES, FrameGovernor } from './core/quality.js';
import { prebake } from './core/platform.js';
import { clamp, clamp01, lerp } from './core/math.js';

const $ = (id) => document.getElementById(id);

const canvas = $('stage');
const wrap = $('stage-wrap');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

const state = {
  t: 0,
  playing: false,
  started: false,
  rate: 1,
  muted: false,
  volume: 0.85,
  dragging: false,
  dragT: 0,
  showChrome: true,
  chromeTimer: 0,
  dpr: 1,
};

let director = null;
let governor = null;
let lastFrame = 0;
let fpsAcc = 0, fpsFrames = 0, fpsShown = 0;
let rafId = 0;
let dirty = true;

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------
function resize() {
  const rect = wrap.getBoundingClientRect();
  const w = Math.max(320, Math.floor(rect.width));
  const h = Math.max(180, Math.floor(rect.height));
  const maxDpr = PROFILES[QUALITY.mode].maxDpr;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * QUALITY.resolutionScale;
  state.dpr = dpr;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  // Bake the full-viewport grain/vignette/slow-motion sheets at the new backing
  // store size so the first frame after a resize (or fullscreen toggle) does not
  // stall while they are generated.
  prebake(ctx, canvas.width, canvas.height);
  dirty = true;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function activeSlowmo(t) {
  // the choreography declares slow-motion windows; they only affect playback rate
  const D = compile();
  if (!D.slowmo) return 1;
  for (const s of D.slowmo) {
    if (t >= s.t0 && t <= s.t1) {
      // ease in and out of the slow region
      const inn = clamp01((t - s.t0) / 0.25);
      const out = clamp01((s.t1 - t) / 0.35);
      const k = Math.min(inn, out);
      return lerp(1, s.rate, k);
    }
  }
  return 1;
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const dtRaw = lastFrame ? (now - lastFrame) : 16.7;
  lastFrame = now;
  const dt = Math.min(dtRaw, 100) / 1000;

  if (state.playing) {
    const rate = activeSlowmo(state.t);
    state.t += dt * rate;
    if (state.t >= TOTAL_DURATION) {
      state.t = TOTAL_DURATION;
      pause();
      onEnd();
    }
    dirty = true;
  }

  // fps measurement
  fpsAcc += dtRaw;
  fpsFrames++;
  if (fpsAcc >= 500) {
    fpsShown = Math.round((fpsFrames * 1000) / fpsAcc);
    fpsAcc = 0; fpsFrames = 0;
    const el = $('fps');
    if (el) el.textContent = `${fpsShown} fps`;
    if (governor && governor.push(1000 / Math.max(1, fpsShown)) && QUALITY.mode === 'high') {
      // auto-downgrade exactly once
      setQuality('performance', true);
    }
  }

  // audio
  if (director && state.playing) {
    director.update(state.t, true);
    director.engine.scheduleMusic(state.t, 0.5);
  }

  if (dirty) {
    dirty = false;
    draw();
    updateTimeUI();
  }
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  try {
    renderAt(ctx, state.t, w, h, { quality: QUALITY.mode });
  } catch (err) {
    // Never let a render error kill the player: report once and keep going.
    console.error('[render] failed at t=' + state.t.toFixed(2), err);
    ctx.restore();
    ctx.fillStyle = '#101318';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff8a7a';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText('Render error at t=' + state.t.toFixed(2) + ': ' + err.message, 24, 40);
    return;
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function play() {
  if (state.playing) return;
  if (state.t >= TOTAL_DURATION - 0.02) state.t = 0;
  state.playing = true;
  lastFrame = performance.now();
  setPlayIcon(true);
  $('chrome').classList.remove('fade');
  if (director) {
    director.seek(state.t);
    director.update(state.t, true);
  }
  dirty = true;
  showChromeTemporarily();
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  setPlayIcon(false);
  if (director) director.update(state.t, false);
  dirty = true;
  revealChrome();
}

function togglePlay() {
  if (!state.started) { begin(); return; }
  if (state.playing) pause(); else play();
}

function seek(t, fromUser = true) {
  state.t = clamp(t, 0, TOTAL_DURATION);
  if (director) director.seek(state.t);
  dirty = true;
  updateTimeUI();
  if (fromUser) showChromeTemporarily();
}

function replay() {
  state.t = 0;
  if (director) director.seek(0);
  state.playing = true;
  lastFrame = performance.now();
  setPlayIcon(true);
  dirty = true;
  revealChrome();
  toast('Replaying from the start');
}

function onEnd() {
  setPlayIcon(false);
  revealChrome();
  if (director) director.engine.setWind(0.2);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function fmt(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function setPlayIcon(playing) {
  $('icon-play').classList.toggle('hidden', playing);
  $('icon-pause').classList.toggle('hidden', !playing);
  $('playpause').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

let lastTimeStr = '';
function updateTimeUI() {
  const cur = fmt(state.t);
  const total = fmt(TOTAL_DURATION);
  const el = $('time');
  const str = `${cur} <span class="dim">/ ${total}</span>`;
  if (str !== lastTimeStr) { el.innerHTML = str; lastTimeStr = str; }
  const pct = (state.t / TOTAL_DURATION) * 100;
  $('scrub-fill').style.width = pct + '%';
  $('scrub-knob').style.left = pct + '%';
  $('scrub').setAttribute('aria-valuenow', state.t.toFixed(1));
  $('scrub').setAttribute('aria-valuetext', `${cur} of ${total}`);
}

function showChromeTemporarily(ms = 2600) {
  revealChrome();
  clearTimeout(state.chromeTimer);
  state.chromeTimer = setTimeout(() => {
    if (state.playing && !state.dragging) {
      $('chrome').classList.add('fade');
      wrap.classList.add('hide-cursor');
    }
  }, ms);
}

function revealChrome() {
  $('chrome').classList.remove('fade');
  wrap.classList.remove('hide-cursor');
  clearTimeout(state.chromeTimer);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1900);
}

function setQuality(mode, auto = false) {
  QUALITY.set(mode);
  $('quality').textContent = PROFILES[mode].label.toUpperCase();
  resize();
  dirty = true;
  if (auto) toast('Switched to Performance mode (frame rate)');
}

// scrub
const scrub = $('scrub');
function scrubTFromEvent(e) {
  const r = scrub.getBoundingClientRect();
  const x = clamp01((e.clientX - r.left) / r.width);
  return x * TOTAL_DURATION;
}
function updateTip(e) {
  const t = scrubTFromEvent(e);
  const tip = $('scrub-tip');
  const r = scrub.getBoundingClientRect();
  tip.textContent = fmt(t);
  tip.style.left = ((t / TOTAL_DURATION) * r.width) + 'px';
}
scrub.addEventListener('pointerdown', (e) => {
  if (!state.started) return;
  scrub.setPointerCapture(e.pointerId);
  state.dragging = true;
  scrub.classList.add('dragging');
  state.dragT = scrubTFromEvent(e);
  updateTip(e);
  seek(state.dragT);
  revealChrome();
});
scrub.addEventListener('pointermove', (e) => {
  if (!state.started) return;
  updateTip(e);
  if (!state.dragging) return;
  state.dragT = scrubTFromEvent(e);
  seek(state.dragT);
});
const endDrag = (e) => {
  if (!state.dragging) return;
  state.dragging = false;
  scrub.classList.remove('dragging');
  if (e.pointerId != null && scrub.hasPointerCapture?.(e.pointerId)) scrub.releasePointerCapture(e.pointerId);
  if (director) director.seek(state.t);
  showChromeTemporarily();
};
scrub.addEventListener('pointerup', endDrag);
scrub.addEventListener('pointercancel', endDrag);
scrub.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { seek(state.t - 2); e.preventDefault(); }
  if (e.key === 'ArrowRight') { seek(state.t + 2); e.preventDefault(); }
  if (e.key === 'Home') { seek(0); e.preventDefault(); }
  if (e.key === 'End') { seek(TOTAL_DURATION); e.preventDefault(); }
});

$('playpause').addEventListener('click', togglePlay);
$('replay').addEventListener('click', replay);
$('fullscreen').addEventListener('click', toggleFullscreen);
$('mute').addEventListener('click', toggleMute);
$('vol').addEventListener('input', (e) => {
  state.volume = Number(e.target.value) / 100;
  if (director) director.engine.setVolume(state.volume);
  if (state.muted && state.volume > 0) setMuted(false);
});
$('quality').addEventListener('click', () => {
  setQuality(QUALITY.mode === 'high' ? 'performance' : 'high');
});

function toggleMute() {
  setMuted(!state.muted);
}
function setMuted(m) {
  state.muted = m;
  if (director) director.engine.setMuted(m);
  $('icon-vol').classList.toggle('hidden', m);
  $('icon-mute').classList.toggle('hidden', !m);
  toast(m ? 'Sound off' : 'Sound on');
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    toast('Fullscreen unavailable');
  }
}
document.addEventListener('fullscreenchange', () => {
  setTimeout(resize, 60);
});

// keyboard
window.addEventListener('keydown', (e) => {
  if (!state.started) {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); begin(); }
    return;
  }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT') return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seek(state.t - (e.shiftKey ? 1 : 5)); break;
    case 'ArrowRight': e.preventDefault(); seek(state.t + (e.shiftKey ? 1 : 5)); break;
    case 'KeyK': togglePlay(); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyR': replay(); break;
    case 'Home': seek(0); break;
    case 'End': seek(TOTAL_DURATION); break;
    case 'Escape': break;
    default: break;
  }
});

// mouse idle -> hide chrome
wrap.addEventListener('pointermove', () => {
  if (!state.started) return;
  showChromeTemporarily();
});
wrap.addEventListener('pointerleave', () => {
  if (state.playing) { $('chrome').classList.add('fade'); wrap.classList.add('hide-cursor'); }
});
// click on the picture toggles play (but not on the chrome)
canvas.addEventListener('click', () => { if (state.started) togglePlay(); });

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.playing) pause();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function begin() {
  if (state.started) return;
  state.started = true;
  $('gate').classList.add('fade-out');
  $('chrome').classList.remove('hidden');

  // audio must be unlocked inside the gesture handler
  try {
    if (director) await director.unlock();
  } catch (err) {
    console.warn('[audio] unavailable, continuing silently', err);
  }
  resize();
  buildScrubMarks();
  play();
  showChromeTemporarily(3200);
}

function buildScrubMarks() {
  const marks = $('scrub-marks');
  const D = compile();
  const acts = [
    { t: 0, label: 'Act I' },
    { t: 26, label: 'II' },
    { t: 58, label: 'III' },
    { t: 80, label: 'IV' },
    { t: 118, label: 'V' },
  ];
  marks.innerHTML = '';
  for (const a of acts) {
    const i = document.createElement('i');
    i.style.left = (a.t / TOTAL_DURATION) * 100 + '%';
    i.title = a.label;
    marks.appendChild(i);
  }
}

async function boot() {
  resize();
  await initAssets();
  prebake(ctx, canvas.width, canvas.height);
  compile();
  director = new AudioDirector(compile());
  director.engine.setVolume(state.volume);
  governor = new FrameGovernor({ window: 120, targetMs: 26, enabled: false });
  $('begin').addEventListener('click', begin);
  // paint the first frame behind the gate so the transition has no black flash
  state.t = 0;
  draw();
  updateTimeUI();
  rafId = requestAnimationFrame(loop);
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  const g = document.getElementById('gate');
  if (g) {
    g.innerHTML = `<div class="gate-inner"><h1>Unable to start</h1><p style="color:#93a0b4;max-width:520px;margin:20px auto;line-height:1.6">${err.message}</p></div>`;
  }
});

// Expose a tiny debug surface for QA scripts (harmless in production).
window.__ninja = {
  get t() { return state.t; },
  set t(v) { seek(v); },
  get playing() { return state.playing; },
  play, pause, seek, replay,
  get director() { return director; },
  get state() { return state; },
  total: TOTAL_DURATION,
  renderAt,
  setQuality,
  canvas,
};

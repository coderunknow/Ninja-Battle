// Timeline / determinism / robustness test suite (no browser required).
//
// Verifies the properties the player depends on:
//   1. every timestamp in the production renders without throwing
//   2. rendering is deterministic: the same t always produces identical pixels
//   3. seeking is exact: rendering t directly equals rendering after a jump
//   4. no NaN / blank frames in actor state
//   5. no characters below the ground plane
//   6. audio cue list is monotonic and fully inside [0, duration]
//   7. audio music generator produces events across the whole timeline
import { setCanvasFactory } from '../src/core/platform.js';
import { createCanvas } from '@napi-rs/canvas';
import { renderAt, initAssets, TOTAL_DURATION, compile } from '../src/scene/stage.js';
import { resolveCast } from '../src/scene/actors.js';
import { musicInWindow } from '../src/audio/engine.js';

const W = 640, H = 360;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(`${name} ${detail}`);
  return false;
}

setCanvasFactory((w,h)=>{ const c=createCanvas(w,h); return c; });
await initAssets();
const D = compile();

// ---------------------------------------------------------------- 1. render sweep
const step = 0.5;
let rendered = 0;
const t0 = Date.now();
for (let t = 0; t <= TOTAL_DURATION; t += step) {
  try {
    renderAt(ctx, t, W, H, { quality: 'high' });
    rendered++;
  } catch (e) {
    check('render @' + t.toFixed(1), false, e.message);
    if (fail > 8) break;
  }
}
check('render sweep completes', true);
console.log(`  rendered ${rendered} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- 2. determinism
function frameHash(t) {
  renderAt(ctx, t, W, H, { quality: 'high' });
  const d = ctx.getImageData(0, 0, W, H).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    h ^= d[i]; h = Math.imul(h, 16777619);
    h ^= d[i + 1]; h = Math.imul(h, 16777619);
    h ^= d[i + 2]; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const probeTimes = [3.3, 27.4, 44.1, 67.25, 76.6, 99.9, 121.5, 168.7, 202.5, 240.0];
let detOk = true;
for (const t of probeTimes) {
  const a = frameHash(t);
  // render something else in between to prove there is no hidden state
  renderAt(ctx, 12.34, W, H, { quality: 'high' });
  renderAt(ctx, 199.9, W, H, { quality: 'high' });
  const b = frameHash(t);
  if (a !== b) { detOk = false; check('deterministic @' + t, false, `${a} != ${b}`); }
}
check('rendering is deterministic (no hidden state)', detOk);

// ---------------------------------------------------------------- 3. seek equivalence
// Simulate a player that scrubs around, then compare to a fresh render.
const seekTargets = [5, 60, 130, 175, 210, 250];
let seekOk = true;
for (const t of seekTargets) {
  const fresh = frameHash(t);
  // emulate scrub: jump forward, back, and land on t
  for (const j of [t + 40, t - 25, t + 3, t]) {
    renderAt(ctx, Math.max(0, Math.min(TOTAL_DURATION, j)), W, H, { quality: 'high' });
  }
  const after = frameHash(t);
  if (fresh !== after) { seekOk = false; check('seek equivalence @' + t, false); }
}
check('seeking reconstructs identical state', seekOk);

// ---------------------------------------------------------------- 4. actor sanity
let nanCount = 0, belowGround = 0, missing = 0;
for (let t = 0; t <= TOTAL_DURATION; t += 0.25) {
  const cast = resolveCast(D, t, D.cloneTracks);
  for (const key of ['n', 's']) {
    const st = cast[key];
    if (!st) { missing++; continue; }
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y)) nanCount++;
    for (const k in st.pose) if (!Number.isFinite(st.pose[k])) nanCount++;
    // feet must never sink more than a few units below the ground plane
    if (st.y > 6) belowGround++;
  }
}
check('all actors present at every sample', missing === 0, `missing=${missing}`);
check('no NaN in actor positions or poses', nanCount === 0, `n=${nanCount}`);
check('no character sinks through the ground', belowGround === 0, `n=${belowGround}`);

// ---------------------------------------------------------------- 5. audio cues
const cues = D.audio;
let mono = true;
for (let i = 1; i < cues.length; i++) if (cues[i].t < cues[i - 1].t) mono = false;
check('audio cue list is sorted', mono);
check('audio cues inside timeline', cues.every((c) => c.t >= 0 && c.t <= TOTAL_DURATION));
check('audio cue count is substantial', cues.length > 40, `${cues.length} cues`);

// ---------------------------------------------------------------- 6. music generator
let totalNotes = 0, emptySections = [];
for (let t = 0; t < TOTAL_DURATION; t += 4) {
  const notes = musicInWindow(t, t + 4);
  totalNotes += notes.length;
  if (notes.length === 0) emptySections.push(t);
}
check('music generates notes across the whole timeline', emptySections.length === 0,
  `empty at ${emptySections.slice(0, 5).join(',')}`);
console.log(`  music events in 4s windows: ${totalNotes} total`);

// ---------------------------------------------------------------- 7. fx sanity
let fxBad = 0;
for (const e of D.fx) {
  if (!Number.isFinite(e.t)) fxBad++;
  if (e.path && typeof e.path !== 'function') fxBad++;
}
check('every fx event has a valid time', fxBad === 0);

// ---------------------------------------------------------------- 8. camera sanity
let camBad = 0;
for (let t = 0; t <= TOTAL_DURATION; t += 1) {
  const { cameraAt } = await import('../src/scene/stage.js');
  const { View } = await import('../src/scene/camera.js');
  const v = new View(1280, 720);
  const cast = resolveCast(D, t, D.cloneTracks);
  const c = cameraAt(t, cast, v);
  if (!(c.zoom > 0.1 && c.zoom < 4) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) camBad++;
}
check('camera stays in a sane range', camBad === 0, `n=${camBad}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}

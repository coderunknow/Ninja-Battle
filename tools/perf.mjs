// Performance measurement (software rasteriser, worst case).
//
// Measures the per-frame cost of the full render pipeline. Because this sandbox
// has no GPU-accelerated browser, these numbers are a CPU-side upper bound: a
// real Chrome/Edge session with Canvas2D GPU acceleration is typically several
// times faster. Reported honestly as such in docs/QA.md.
import { setCanvasFactory } from '../src/core/platform.js';
import { createCanvas } from '@napi-rs/canvas';
import { renderAt, initAssets, TOTAL_DURATION } from '../src/scene/stage.js';

setCanvasFactory((w,h)=>{ const c=createCanvas(w,h); return c; });
await initAssets();
const W = 1920, H = 1080;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');

const samples = [];
for (let t = 0; t < TOTAL_DURATION; t += 1.0) {
  const t0 = process.hrtime.bigint();
  renderAt(ctx, t, W, H, { quality: 'high' });
  const t1 = process.hrtime.bigint();
  samples.push({ t, ms: Number(t1 - t0) / 1e6 });
}
samples.sort((a, b) => a.ms - b.ms);
const avg = samples.reduce((a, s) => a + s.ms, 0) / samples.length;
const p = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].ms;
const worst = samples.slice(-5);

console.log(`frames measured: ${samples.length}  @ ${W}x${H}  quality=high`);
console.log(`mean   ${avg.toFixed(1)} ms  (${(1000 / avg).toFixed(1)} fps CPU-bound)`);
console.log(`median ${p(0.5).toFixed(1)} ms`);
console.log(`p95    ${p(0.95).toFixed(1)} ms`);
console.log(`max    ${samples[samples.length - 1].ms.toFixed(1)} ms`);
console.log('slowest frames:', worst.map((s) => `${s.t.toFixed(0)}s=${s.ms.toFixed(0)}ms`).join(' '));

// quality mode comparison at 1280x720
const cv2 = createCanvas(1280, 720);
const ctx2 = cv2.getContext('2d');
for (const mode of ['high', 'performance']) {
  const t0 = process.hrtime.bigint();
  for (let t = 0; t < 120; t += 2) renderAt(ctx2, t, 1280, 720, { quality: mode });
  const t1 = process.hrtime.bigint();
  const n = 60;
  const ms = Number(t1 - t0) / 1e6 / n;
  console.log(`${mode.padEnd(12)} @1280x720: ${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(0)} fps CPU)`);
}

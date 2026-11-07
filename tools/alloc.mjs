// Measures per-frame heap allocation, which is the main source of GC hitches.
//   node tools/alloc.mjs [t0] [t1]
import { createCanvas } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import { renderAt, initAssets } from '../src/scene/stage.js';
setCanvasFactory((w, h) => createCanvas(w, h));
await initAssets();
const W = 1920, H = 1080;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');
const t0 = Number(process.argv[2] ?? 100);
const N = 120;
// warm up
for (let i = 0; i < 10; i++) renderAt(ctx, t0 + i * 0.016, W, H, {});
if (global.gc) global.gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) renderAt(ctx, t0 + i * 0.016, W, H, {});
const after = process.memoryUsage().heapUsed;
console.log(`heap delta over ${N} frames: ${((after - before) / 1024).toFixed(0)} KiB (${((after - before) / N / 1024).toFixed(1)} KiB/frame)`);

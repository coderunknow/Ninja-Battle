import { createCanvas } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import * as stage from '../src/scene/stage.js';
setCanvasFactory((w, h) => createCanvas(w, h));
await stage.initAssets();
const W = 1920, H = 1080;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');
for (const T of [172, 100, 202]) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 8; i++) stage.renderAt(ctx, T, W, H, { quality: 'high' });
  console.log(`t=${T}`, (Number(process.hrtime.bigint() - t0) / 1e6 / 8).toFixed(1) + ' ms');
}

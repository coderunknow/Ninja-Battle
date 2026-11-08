// Filmstrip QA: renders a window of the timeline and tiles it for inspection.
// usage: node tools/strip.mjs <t0> <t1> [count] [cols]
import { setCanvasFactory } from '../src/core/platform.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
import { renderAt, initAssets } from '../src/scene/stage.js';
setCanvasFactory((w,h)=>{ const c=createCanvas(w,h); return c; });
await initAssets();
const [t0, t1] = [Number(process.argv[2]), Number(process.argv[3])];
const count = Number(process.argv[4] || 12);
const cols = Number(process.argv[5] || 3);
const W = 640, H = 360;
const cv = createCanvas(W, H), ctx = cv.getContext('2d');
fs.mkdirSync('qa-out/strip', { recursive: true });
const tw = 420, th = 236;
const rows = Math.ceil(count / cols);
const sheet = createCanvas(tw * cols, (th + 15) * rows);
const sctx = sheet.getContext('2d');
sctx.fillStyle = '#000'; sctx.fillRect(0, 0, sheet.width, sheet.height);
for (let i = 0; i < count; i++) {
  const t = t0 + (t1 - t0) * (i / Math.max(1, count - 1));
  renderAt(ctx, t, W, H, { quality: 'high' });
  const p = `qa-out/strip/f${i}.png`;
  fs.writeFileSync(p, cv.toBuffer('image/png'));
  const img = await loadImage(p);
  const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + 15);
  sctx.drawImage(img, x, y, tw, th);
  sctx.fillStyle = '#7fd0ff'; sctx.font = '13px monospace';
  sctx.fillText(t.toFixed(2) + 's', x + 6, y + th + 12);
}
fs.writeFileSync('qa-out/strip.png', sheet.toBuffer('image/png'));
console.log('strip ok', t0, '-', t1);

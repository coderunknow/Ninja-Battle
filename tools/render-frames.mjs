// Headless QA renderer.
//
// The production render core has zero DOM dependencies, so the exact same modules
// that draw the browser canvas are loaded here against @napi-rs/canvas and rasterised
// to PNG. This is how the animation is visually inspected without a browser binary
// in the environment (see docs/QA.md).
//
//   node tools/render-frames.mjs <t1,t2,...> [--out qa-out] [--w 1280] [--h 720]
//   node tools/render-frames.mjs --sheet 0,20,40,... [--cols 3]
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import fs from 'node:fs';
import path from 'node:path';
import { renderAt, TOTAL_DURATION, initAssets } from '../src/scene/stage.js';

setCanvasFactory((w, h) => createCanvas(w, h));

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = getArg('--out', 'qa-out');
const W = Number(getArg('--w', 1280));
const H = Number(getArg('--h', 720));
const COLS = Number(getArg('--cols', 2));

let times = [];
const sheetIdx = args.indexOf('--sheet');
const posIdx = args.findIndex((a) => /^[\d.,]+$/.test(a));
if (posIdx >= 0) {
  times = args[posIdx].split(',').filter(Boolean).map(Number);
}
if (sheetIdx >= 0) {
  times = args[sheetIdx + 1].split(',').filter(Boolean).map(Number);
}
if (!times.length) {
  // default: 1 frame every 10s across the production
  for (let t = 0; t <= TOTAL_DURATION; t += 10) times.push(t);
}

fs.mkdirSync(OUT, { recursive: true });

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
await initAssets();

const files = [];
for (const t of times) {
  renderAt(ctx, t, W, H, { quality: 'high', exportMode: true });
  const name = `f_${String(t.toFixed(2)).padStart(7, '0')}.png`;
  const p = path.join(OUT, name);
  fs.writeFileSync(p, canvas.toBuffer('image/png'));
  files.push(p);
  console.log('rendered', p);
}

// Contact sheet for at-a-glance review of many frames at once.
if (files.length > 1) {
  const cols = COLS;
  const rows = Math.ceil(files.length / cols);
  const tw = 480, th = 270;
  const sheet = createCanvas(tw * cols, (th + 18) * rows);
  const sctx = sheet.getContext('2d');
  sctx.fillStyle = '#0b0d12';
  sctx.fillRect(0, 0, sheet.width, sheet.height);
  for (let i = 0; i < files.length; i++) {
    const img = await loadImage(files[i]);
    const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + 18);
    sctx.drawImage(img, x, y, tw, th);
    sctx.fillStyle = '#7fd0ff';
    sctx.font = '14px monospace';
    sctx.fillText(`${times[i].toFixed(1)}s`, x + 8, y + th + 14);
  }
  const sp = path.join(OUT, 'sheet.png');
  fs.writeFileSync(sp, sheet.toBuffer('image/png'));
  console.log('contact sheet', sp);
}

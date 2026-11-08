// Renders a frame and saves a magnified crop — for close inspection of faces,
// hands, joints and effect contact points.
//
//   node tools/crop.mjs <t> <cx> <cy> <w> <h> [scale]
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import { renderAt, initAssets } from '../src/scene/stage.js';
import fs from 'node:fs';
setCanvasFactory((w, h) => createCanvas(w, h));
await initAssets();
const [t, cx, cy, cw, ch, sc = 4] = process.argv.slice(2).map(Number);
// Match tools/probe.mjs so screen coordinates line up with the stills.
const W = Number(process.env.RW || 1280), H = Number(process.env.RH || 720);
const cv = createCanvas(W, H);
renderAt(cv.getContext('2d'), t, W, H, { quality: 'high' });
fs.mkdirSync('qa-out/crops', { recursive: true });
const base = `qa-out/crops/c${t.toFixed(1)}_${cx}_${cy}`;
fs.writeFileSync(base + '.png', cv.toBuffer('image/png'));
// crop + upscale with nearest-ish smoothing off
const out = createCanvas(cw * sc, ch * sc);
const octx = out.getContext('2d');
octx.imageSmoothingEnabled = false;
octx.drawImage(cv, cx, cy, cw, ch, 0, 0, cw * sc, ch * sc);
fs.writeFileSync(base + `_x${sc}.png`, out.toBuffer('image/png'));
console.log(base + `_x${sc}.png`);

// Large-scale character portrait for facial/joint/limb inspection.
//   node tools/portrait.mjs <naruto|sasuke> <clip> [t01] [scale] [scream] [angry]
import { createCanvas } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import { drawFighter } from '../src/rig/render.js';
import { sampleClip, NEUTRAL } from '../src/rig/clips.js';
import { makeRig } from '../src/rig/skeleton.js';
import fs from 'node:fs';
setCanvasFactory((w, h) => createCanvas(w, h));
const style = process.argv[2] || 'naruto';
const clipName = process.argv[3] || 'guard';
const t01 = Number(process.argv[4] ?? 0.5);
const SC = Number(process.argv[5] ?? 5);
const scream = Number(process.argv[6] ?? 0);
const angry = Number(process.argv[7] ?? 0.6);
const rig = makeRig();
const pose = sampleClip(clipName, t01) || NEUTRAL;
const W = 900, H = 1100;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');
ctx.fillStyle = '#1a1e28';
ctx.fillRect(0, 0, W, H);
// draw so the head lands near the top of the frame
ctx.save();
// auto-fit: figure height extends from about -rig.height*1.05 to +18
const figH = rig.height * 1.06 + 26;
if (process.env.FIT) {
  const sc = Math.min((H * 0.86) / figH, (W * 0.80) / (rig.height * 0.55));
  ctx.translate(W / 2, H * 0.87);
  ctx.scale(sc, sc);
} else {
  ctx.translate(W / 2, H * 0.98);
  ctx.scale(SC, SC);
}
drawFighter(ctx, { rig, pose, x: 0, y: 0, facing: 1, style, time: 1.0, flow: 0.4, scream, angry });
ctx.restore();
fs.mkdirSync('qa-out/portraits', { recursive: true });
const out = `qa-out/portraits/${style}-${clipName}-${t01}.png`;
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log(out);

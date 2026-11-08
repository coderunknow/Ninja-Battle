import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
setCanvasFactory((w,h)=>{ const c=createCanvas(w,h); return c; });
import fs from 'node:fs';
import { renderAt, initAssets, TOTAL_DURATION } from '../src/scene/stage.js';
await initAssets();
const W=1280,H=720;
const cv=createCanvas(W,H); const ctx=cv.getContext('2d');
const times = process.argv.slice(2).map(Number);
let errs=0;
fs.mkdirSync('qa-out', {recursive:true});
for (const t of times) {
  try {
    renderAt(ctx, t, W, H, { quality: 'high' });
    fs.writeFileSync(`qa-out/t${t.toFixed(1)}.png`, cv.toBuffer('image/png'));
  } catch(e) { errs++; console.error('FAIL at', t, e.message); }
}
// contact sheet
const cols=3, rows=Math.ceil(times.length/cols);
const tw=420,th=236;
const sheet=createCanvas(tw*cols, (th+16)*rows);
const sctx=sheet.getContext('2d');
sctx.fillStyle='#000'; sctx.fillRect(0,0,sheet.width,sheet.height);
const { loadImage } = await import('@napi-rs/canvas');
for (let i=0;i<times.length;i++){
  const img = await loadImage(`qa-out/t${times[i].toFixed(1)}.png`);
  const x=(i%cols)*tw, y=Math.floor(i/cols)*(th+16);
  sctx.drawImage(img, x, y, tw, th);
  sctx.fillStyle='#7fd0ff'; sctx.font='13px monospace';
  sctx.fillText(`${times[i].toFixed(1)}s`, x+6, y+th+12);
}
fs.writeFileSync('qa-out/sheet.png', sheet.toBuffer('image/png'));
console.log(errs?`${errs} FAILURES`:'all ok', '| sheet written');
process.exit(errs?1:0);

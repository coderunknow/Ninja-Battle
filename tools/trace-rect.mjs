// Traces which canvas draw call last changed a given screen pixel. Used to hunt
// down coordinate-space bugs (world rects leaking into screen space, etc).
//
//   node tools/trace-rect.mjs <t> [x] [y]
import { createCanvas } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import { renderAt, initAssets } from '../src/scene/stage.js';
setCanvasFactory((w, h) => createCanvas(w, h));
await initAssets();
const t = Number(process.argv[2] || 202.5);
const PX = Number(process.argv[3] || 640);
const PY = Number(process.argv[4] || 560);
const cv = createCanvas(1280, 720);
const ctx = cv.getContext('2d');
let last = null;
const methods = ['fill', 'fillRect', 'stroke', 'drawImage', 'putImageData'];
for (const m of methods) {
  const orig = ctx[m].bind(ctx);
  ctx[m] = (...a) => {
    const r = orig(...a);
    const d = ctx.getImageData(PX, PY, 1, 1).data;
    const key = `${d[0]},${d[1]},${d[2]},${d[3]}`;
    if (last !== null && key !== last) {
      const st = new Error().stack.split('\n')[3] || '';
      console.log(`(${PX},${PY}) ${last} -> ${key}  ctx.${m}  ${st.trim()}`);
    }
    last = key;
    return r;
  };
}
renderAt(ctx, t, 1280, 720, { quality: 'high' });

import { setCanvasFactory } from '../src/core/platform.js';
import { createCanvas } from '@napi-rs/canvas';
import * as world from '../src/scene/world.js';
import * as fx from '../src/fx/effects.js';
import * as stage from '../src/scene/stage.js';
import { View, evalKeys } from '../src/scene/camera.js';
import { resolveCast } from '../src/scene/actors.js';
import { drawFighter } from '../src/rig/render.js';

setCanvasFactory((w,h)=>{ const c=createCanvas(w,h); return c; });
await stage.initAssets();
const D = stage.compile();
const W = 1920, H = 1080;
const cv = createCanvas(W, H);
const ctx = cv.getContext('2d');
const T = 172; // slowest frame

function time(label, fn, n = 5) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  console.log(`${label.padEnd(26)} ${ms.toFixed(1)} ms`);
  return ms;
}

const view = new View(W, H);
const cast = resolveCast(D, T, D.cloneTracks);
const sky = stage.skyAt(T);
const cam = stage.cameraAt(T, cast, view);
view.set(cam);

time('drawSky', () => { ctx.setTransform(1,0,0,1,0,0); world.drawSky(ctx, view, sky); });
time('drawRidges', () => world.drawRidges(ctx, view, T, sky));
time('drawTreeline', () => { view.apply(ctx); world.drawTreeline(ctx, view, T, sky); ctx.setTransform(1,0,0,1,0,0); });
time('drawClouds', () => world.drawClouds(ctx, view, T, sky, 0));
time('drawWalls far', () => world.drawValleyWalls(ctx, view, T, sky, '255,200,150', 'far'));
time('drawWalls near', () => world.drawValleyWalls(ctx, view, T, sky, '255,200,150', 'near'));
time('drawStatues', () => world.drawStatues(ctx, view, T, sky, '255,200,150'));
time('drawGround', () => { view.apply(ctx); world.drawGround(ctx, view, T, sky, D.cracks); ctx.setTransform(1,0,0,1,0,0); });
time('drawMotes', () => { view.apply(ctx); world.drawMotes(ctx, view, T, sky, 1); ctx.setTransform(1,0,0,1,0,0); });
time('drawAtmosphere', () => world.drawAtmosphere(ctx, view, { wash: { x: 500, y: 400, r: 900, col: '255,200,150', a: 0.4 }, vignette: 0.55, grain: 0.055, time: T }));
time('drawFighter x1', () => { view.apply(ctx); drawFighter(ctx, { rig: stage.rigNaruto, pose: cast.n.pose, x: cast.n.x, y: cast.n.y, facing: cast.n.facing, style: 'naruto', time: T, flow: 0.2 }); ctx.setTransform(1,0,0,1,0,0); });
const alive = D.fx.filter(e => T >= e.t && T <= e.t + (e.dur ?? e.life ?? 1.2));
console.log('active fx:', alive.length, alive.map(e=>e.kind).join(','));
time('renderFx(all active)', () => { view.apply(ctx); fx.renderFx(alive, ctx, view, T); ctx.setTransform(1,0,0,1,0,0); });
time('FULL renderAt', () => { const v2 = new View(W,H); stage.renderAt(ctx, T, W, H, {quality:'high'}); });

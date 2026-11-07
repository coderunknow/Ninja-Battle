// Character sheet: renders one fighter through many clips side by side at high
// zoom, so proportions, joints, hair, clothing and silhouette can be audited.
//
//   node tools/charsheet.mjs [naruto|sasuke] [clip1,clip2,...]
import { createCanvas } from '@napi-rs/canvas';
import { setCanvasFactory } from '../src/core/platform.js';
import { drawFighter, fighterAnchors } from '../src/rig/render.js';
import { sampleClip, CLIPS, NEUTRAL } from '../src/rig/clips.js';
import { makeRig } from '../src/rig/skeleton.js';
import fs from 'node:fs';

setCanvasFactory((w, h) => createCanvas(w, h));
const who = process.argv[2] || 'naruto';
const list = (process.argv[3] || 'idle_guard,idle_ready,jab,cross,uppercut,kick_front,kick_round,run_fwd,jump_up,land,charge_n,arm_out')
  .split(',').filter(Boolean);

const CELL_W = 300, CELL_H = 460, SCALE = 2.0;
const cols = 6;
const rows = Math.ceil(list.length / cols);
const cv = createCanvas(CELL_W * cols, CELL_H * rows);
const ctx = cv.getContext('2d');
ctx.fillStyle = '#151821';
ctx.fillRect(0, 0, cv.width, cv.height);

const rig = makeRig();
list.forEach((name, i) => {
  const cx = (i % cols) * CELL_W + CELL_W / 2;
  const cy = Math.floor(i / cols) * CELL_H + CELL_H * 0.82;
  const clip = CLIPS[name];
  if (!clip) {
    ctx.fillStyle = '#f66';
    ctx.font = '14px monospace';
    ctx.fillText('? ' + name, cx - 40, cy - 200);
    return;
  }
  // mid-clip sample shows the pose at its most characteristic moment
  const dur = (clip.dur ?? 1);
  const pose = sampleClip(name, dur * 0.5);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(SCALE, SCALE);
  drawFighter(ctx, {
    rig, pose: pose || NEUTRAL, x: 0, y: 0, facing: 1,
    style: who, time: 1.0, flow: 0.3,
  });
  ctx.restore();
  // ground line
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.moveTo(cx - 110, cy); ctx.lineTo(cx + 110, cy); ctx.stroke();
  ctx.fillStyle = '#7fd0ff';
  ctx.font = '13px monospace';
  ctx.fillText(name, (i % cols) * CELL_W + 8, Math.floor(i / cols) * CELL_H + 18);
});
fs.mkdirSync('qa-out/sheets', { recursive: true });
const out = `qa-out/sheets/${who}-poses.png`;
fs.writeFileSync(out, cv.toBuffer('image/png'));
// also print the available clip names once
console.log(out);
console.log('clips:', Object.keys(CLIPS).join(', '));

// Titles, captions and the letterbox frame.
//
// Text is drawn in screen space with a synthesised serif/condensed look (no font
// files needed): a stacked shadow, a soft glow, and letter-spaced capitals.

import { clamp01, ease, smoothstep, lerp, TAU } from '../core/math.js';

const FONT_STACK = '"Trebuchet MS", "Segoe UI", system-ui, -apple-system, sans-serif';
const SERIF_STACK = 'Georgia, "Times New Roman", "DejaVu Serif", serif';

function spaced(ctx, text, x, y, spacing, draw) {
  // draw with manual letter spacing for a cinematic title look
  let cx = x;
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  cx = x - total / 2;
  ctx.textAlign = 'left';
  for (let i = 0; i < chars.length; i++) {
    draw(chars[i], cx, y);
    cx += widths[i] + spacing;
  }
  return total;
}

function shadowed(ctx, text, x, y, opts) {
  const { size, spacing = 6, font = SERIF_STACK, weight = '600', color = '#fff', glow, alpha = 1, blur = 18 } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  // glow
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    spaced(ctx, text, x, y, spacing, (c, cx, cy) => ctx.fillText(c, cx, cy));
    ctx.restore();
  }
  // dark drop
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  spaced(ctx, text, x + 1.5, y + 2, spacing, (c, cx, cy) => ctx.fillText(c, cx, cy));
  ctx.fillStyle = color;
  spaced(ctx, text, x, y, spacing, (c, cx, cy) => ctx.fillText(c, cx, cy));
  ctx.restore();
}

export function drawLetterbox(ctx, w, h, bar) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, bar);
  ctx.fillRect(0, h - bar, w, bar);
  // subtle inner gradient so the bar meets the image smoothly
  const g1 = ctx.createLinearGradient(0, bar, 0, bar + bar * 0.5);
  g1.addColorStop(0, 'rgba(0,0,0,0.5)');
  g1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g1;
  ctx.fillRect(0, bar, w, bar * 0.5);
  const g2 = ctx.createLinearGradient(0, h - bar, 0, h - bar * 1.5);
  g2.addColorStop(0, 'rgba(0,0,0,0.5)');
  g2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, h - bar * 1.5, w, bar * 0.5);
  ctx.restore();
}

export function drawTitles(ctx, w, h, titles, t) {
  const bar = Math.min(w, h) * 0.072;
  const cx = w / 2;
  for (const ti of titles) {
    const age = t - ti.t;
    if (age < 0 || age > ti.dur) continue;
    const u = age / ti.dur;
    const fin = smoothstep(clamp01(age / 0.55));
    const fout = smoothstep(clamp01((ti.dur - age) / 0.6));
    const a = Math.min(fin, fout);
    const slide = (1 - fin) * 16;

    if (ti.kind === 'location') {
      const y = h * 0.24 + slide;
      ctx.save();
      ctx.globalAlpha = a;
      const size = Math.max(15, Math.min(w * 0.017, h * 0.031));
      shadowed(ctx, ti.text, cx, y, { size, spacing: size * 0.5, color: 'rgba(245,240,232,0.96)', alpha: a, glow: 'rgba(255,214,160,0.5)' });
      // rule lines
      ctx.globalAlpha = a * 0.7;
      ctx.strokeStyle = 'rgba(255,220,170,0.7)';
      ctx.lineWidth = 1;
      const half = Math.min(w * 0.16, 210);
      ctx.beginPath();
      ctx.moveTo(cx - half, y + size * 0.7);
      ctx.lineTo(cx + half, y + size * 0.7);
      ctx.stroke();
      if (ti.sub) {
        const ss = Math.max(10, size * 0.5);
        ctx.font = `400 ${ss}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = a * 0.8;
        ctx.fillStyle = 'rgba(226,220,210,0.9)';
        ctx.fillText(ti.sub, cx, y + size * 0.7 + ss * 1.9);
      }
      ctx.restore();
    } else if (ti.kind === 'chapter') {
      const size = Math.max(22, Math.min(w * 0.045, h * 0.075));
      const y = h * 0.42;
      ctx.save();
      shadowed(ctx, ti.text, cx, y, { size, spacing: size * 0.28, color: '#fff8ec', alpha: a, glow: 'rgba(255,200,140,0.55)' });
      if (ti.sub) {
        const ss = Math.max(11, size * 0.26);
        ctx.globalAlpha = a * 0.9;
        ctx.font = `400 ${ss}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(240,232,222,0.92)';
        ctx.fillText(ti.sub, cx + 0.5, y + size * 0.9);
      }
      ctx.restore();
    } else if (ti.kind === 'line') {
      // subtitle-style dialogue at the bottom of the frame
      const size = Math.max(13, Math.min(w * 0.0185, h * 0.032));
      const y = h - bar - size * 1.6;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = `italic 400 ${size}px ${SERIF_STACK}`;
      ctx.textAlign = 'center';
      const tw = ctx.measureText(ti.text).width;
      // soft backing plate for legibility
      const pad = size * 0.7;
      const g = ctx.createLinearGradient(0, y - size * 1.5, 0, y + size * 0.7);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.45, `rgba(0,0,0,${0.42 * a})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - tw / 2 - pad * 3, y - size * 1.5, tw + pad * 6, size * 2.2);
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = ti.who === 'naruto' ? '#ffd9a8' : ti.who === 'sasuke' ? '#c8e0ff' : '#f2ece2';
      ctx.fillText(ti.text, cx, y);
      ctx.restore();
    } else if (ti.kind === 'final') {
      // placed above the fighters so the locked clash stays visible underneath
      const size = Math.max(24, Math.min(w * 0.048, h * 0.078));
      const y = h * 0.245;
      ctx.save();
      // slow rise + very slow fade so the open ending lingers
      const ry = y - (1 - fin) * 10;
      shadowed(ctx, ti.text, cx, ry, { size, spacing: size * 0.42, color: '#fffdf8', alpha: a, glow: 'rgba(255,240,220,0.7)', blur: 26 });
      if (ti.sub) {
        const ss = Math.max(11, size * 0.2);
        ctx.globalAlpha = a * 0.9;
        ctx.font = `italic 400 ${ss}px ${SERIF_STACK}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(238,232,224,0.92)';
        ctx.fillText(ti.sub, cx, ry + size * 0.92);
      }
      ctx.restore();
    } else if (ti.kind === 'credits') {
      const size = Math.max(20, Math.min(w * 0.038, h * 0.062));
      const y = h * 0.27;
      ctx.save();
      shadowed(ctx, ti.text, cx, y, { size, spacing: size * 0.32, color: '#fffaf2', alpha: a * 0.96, glow: 'rgba(255,225,180,0.5)' });
      if (ti.sub) {
        const ss = Math.max(11, size * 0.24);
        ctx.globalAlpha = a * 0.85;
        ctx.font = `400 ${ss}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(232,226,218,0.9)';
        ctx.fillText(ti.sub, cx, y + size * 0.95);
      }
      ctx.restore();
    }
  }
}

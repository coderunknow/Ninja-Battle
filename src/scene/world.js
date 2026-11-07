// World: the Valley of the Fallen — an original battlefield.
//
// Layers, back to front:
//   0 sky gradient, sun, god rays
//   1 far mountain ridges (3 parallax bands) + haze
//   2 cloud deck (drifting)
//   3 colossal broken guardian statues on the valley walls
//   4 mid-ground cliffs and rock spires
//   5 valley floor: cracked earth, scree, dust
//   6 foreground rocks / grass (heavy parallax, dark)
//
// Geometry is generated once from a deterministic hash at init and stored as point
// arrays; drawing is then just path filling, which keeps the frame cost flat and
// keeps the whole scene reproducible from the timeline.

import { hash, hash2, noise1, clamp, clamp01, lerp, TAU, smoothstep } from '../core/math.js';
import { postOverlay, cloudSprite, groundStrip, skyStrip, rgbCss } from '../core/platform.js';

let GEO = null;

function ridge(seed, x0, x1, baseY, amp, detail, roughness) {
  const pts = [];
  const n = 150;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = lerp(x0, x1, t);
    let y = baseY;
    for (let o = 0; o < detail; o++) {
      const f = 2 ** o * (1 + o * 0.35);
      y -= noise1(t * f * 3.1 + seed * 13.7, seed + o * 7) * amp * (roughness ** o);
    }
    // sharpen peaks
    y -= Math.abs(noise1(t * 9 + seed, seed + 3)) * amp * 0.25;
    y -= Math.abs(noise1(t * 26 + seed * 2, seed + 5)) * amp * 0.10;
    pts.push({ x, y });
  }
  return pts;
}

function cloudPuffs(seed, count) {
  const puffs = [];
  for (let i = 0; i < count; i++) {
    puffs.push({
      dx: (hash2(seed, i) - 0.5) * 260,
      dy: (hash2(seed + 1, i) - 0.5) * 34,
      r: 26 + hash2(seed + 2, i) * 54,
      a: 0.1 + hash2(seed + 3, i) * 0.2,
    });
  }
  return puffs;
}

export function buildWorld() {
  const R = {};
  R.far = ridge(1, -260, 260, -18, 74, 4, 0.55);
  R.mid = ridge(5, -190, 190, -8, 52, 4, 0.5);
  R.near = ridge(9, -140, 140, 4, 34, 3, 0.45);

  // clouds
  R.clouds = [];
  for (let i = 0; i < 16; i++) {
    R.clouds.push({
      x: -260 + hash(i * 7 + 1) * 520,
      y: -170 + hash(i * 7 + 2) * 120,
      s: 0.5 + hash(i * 7 + 3) * 1.4,
      drift: 0.35 + hash(i * 7 + 4) * 1.2,
      puffs: cloudPuffs(i * 13 + 5, 7 + Math.floor(hash(i) * 5)),
      depth: 0.2 + hash(i * 7 + 6) * 0.5,
    });
  }

  // Rock spires / cliff formations on the valley walls
  R.spires = [];
  for (let i = 0; i < 22; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (238 + hash(i * 11 + 3) * 150);
    const h = 34 + hash(i * 11 + 4) * 90;
    const w = 14 + hash(i * 11 + 5) * 34;
    const pts = [];
    const steps = 9;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const wid = w * (1 - t) ** 0.75 * (0.75 + 0.5 * noise1(t * 3 + i, 4));
      pts.push({ x: x + wid * (t % 2 ? 1 : -1) * 0.4, y: -baseY0(h) * t });
    }
    R.spires.push({ x, h, w, pts, side });
  }

  // Guardian statues (original designs, ruined)
  R.statues = [
    { x: -338, h: 400, fail: 0.34, seed: 8, side: -1 },
    { x: 346, h: 418, fail: 0.52, seed: 24, side: 1 },
  ];

  // Ground scree and cracks
  R.rocks = [];
  for (let i = 0; i < 90; i++) {
    R.rocks.push({
      x: (hash(i * 3 + 1) - 0.5) * 420,
      z: 0.15 + hash(i * 3 + 2) * 0.9, // depth cue: 0 = background floor
      r: 0.7 + hash(i * 3 + 3) * 2.6,
      rot: hash(i * 3 + 4) * TAU,
      shade: hash(i * 3 + 5),
    });
  }
  R.tufts = [];
  for (let i = 0; i < 60; i++) {
    R.tufts.push({
      x: (hash(i * 5 + 41) - 0.5) * 400,
      z: 0.3 + hash(i * 5 + 42) * 0.8,
      h: 3 + hash(i * 5 + 43) * 7,
      lean: (hash(i * 5 + 44) - 0.5) * 6,
      blades: 3 + Math.floor(hash(i * 5 + 45) * 3),
    });
  }
  R.fgRocks = [];
  for (let i = 0; i < 10; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    R.fgRocks.push({
      x: side * (30 + hash(i * 9 + 71) * 60),
      size: 26 + hash(i * 9 + 72) * 70,
      y: 10 + hash(i * 9 + 73) * 26,
      seed: i,
    });
  }
  return R;
}

const baseY0 = (h) => h;

// Visible world rectangle. Every ground/effects helper that runs inside the
// camera transform must work in *world* units, so we derive the visible extents
// from the view instead of using screen pixels.
export function worldBounds(view, pad = 260) {
  const halfW = view.w / (2 * view.scale);
  const halfH = view.h / (2 * view.scale);
  return {
    left: view.cx - halfW - pad,
    right: view.cx + halfW + pad,
    top: view.cy - halfH - pad,
    bottom: view.cy + halfH + pad,
    width: halfW * 2 + pad * 2,
  };
}

function ensureGeo() {
  if (!GEO) GEO = buildWorld();
  return GEO;
}

// ---------------------------------------------------------------------------
// Sky / lighting model
// ---------------------------------------------------------------------------
// `sky` is supplied by the timeline: {top, mid, bottom, sunX, sunY, sunColor,
// haze, mood}. Colours are raw rgb triples so they can be lerped.
export function drawSky(ctx, view, sky) {
  const { w, h } = view;
  // One vertical gradient for the whole dome. Earlier this was split into flat
  // bands with short blend strips, which left visible horizontal seams where the
  // next band overlapped the blend.
  const hz = Math.max(8, view.toScreenY(sky.horizonY ?? 0));
  const midMix = mixRgb(sky.mid, sky.bottom, 0.75);
  // Cached strip blit instead of rasterising a 4-stop gradient over the whole
  // viewport every frame (measured at ~11% of total frame cost).
  const strip = skyStrip(sky.top, sky.mid, midMix, hz, Math.min(1024, Math.max(64, hz)));
  if (strip) {
    ctx.drawImage(strip, 0, 0, 4, strip.height, 0, 0, w, hz + 1);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, rgb(sky.top));
    g.addColorStop(0.52, rgb(sky.mid));
    g.addColorStop(0.84, rgb(midMix));
    g.addColorStop(1, rgb(sky.bottom));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hz + 1);
  }
  // below the horizon the sky colour continues (the ground covers it)
  ctx.fillStyle = rgb(sky.bottom);
  ctx.fillRect(0, hz, w, Math.max(0, h - hz));

  // sun / moon disc + glow (small area, cheap)
  const sx = view.toScreenX(sky.sunX), sy = view.toScreenY(sky.sunY);
  const glowR = Math.max(24, (sky.sunR || 130) * view.zoom * view.scale);
  const a = sky.sunA ?? 1;
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
  sg.addColorStop(0, `rgba(${sky.sunColor},${0.5 * a})`);
  sg.addColorStop(0.2, `rgba(${sky.sunColor},${0.26 * a})`);
  sg.addColorStop(1, `rgba(${sky.sunColor},0)`);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = sg;
  ctx.fillRect(sx - glowR, sy - glowR, glowR * 2, glowR * 2);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(6, (sky.sunR || 18) * view.zoom * view.scale * 0.62), 0, TAU);
  ctx.fillStyle = `rgba(${sky.sunColor},${0.9 * a})`;
  ctx.fill();
}

function rgb(c, a = 1) {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ---------------------------------------------------------------------------
// Background layers
// ---------------------------------------------------------------------------
export function drawRidges(ctx, view, t, sky) {
  const G = ensureGeo();
  const bands = [
    { pts: G.far, par: 0.12, y: -170, col: mixRgb(sky.mid, sky.haze, 0.80), alpha: 0.95 },
    { pts: G.mid, par: 0.22, y: -128, col: mixRgb(sky.mid, sky.haze, 0.58), alpha: 0.97 },
    { pts: G.near, par: 0.36, y: -84, col: mixRgb(sky.bottom, sky.haze, 0.26), alpha: 0.99 },
  ];
  // NOTE: these ridges are drawn while the camera transform is active, so all
  // coordinates are world-height equivalents of screen edges, not `view.h`.
  // These ridges live in *screen* space (they are the far horizon), so they use
  // screen x — never `view.w` as if it were world units — and close well below
  // the frame bottom so no polygon edge can appear in shot.
  const x0 = -Math.max(400, view.w * 0.4);
  const x1 = view.w + Math.max(400, view.w * 0.4);
  // Each band is only a crest band: it is filled from its own ridgeline down to
  // a fixed depth and then fades out. Previously every band filled the whole
  // area below its crest, which both cost a fortune in overdraw and produced a
  // flat grey field instead of layered distance.
  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi];
    const depth = 46 + bi * 26;
    const yAt = (i) => view.toScreenY(b.pts[i].y + b.y);
    const crest = (dx) => {
      ctx.beginPath();
      for (let i = 0; i < b.pts.length; i++) {
        const x = lerp(x0, x1, i / (b.pts.length - 1)) + dx;
        if (i === 0) ctx.moveTo(x, yAt(i)); else ctx.lineTo(x, yAt(i));
      }
    };
    // body of the band, clipped to a strip under the crest
    crest(0);
    ctx.lineTo(x1, yAt(b.pts.length - 1) + depth);
    ctx.lineTo(x0, yAt(0) + depth);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    const g = ctx.createLinearGradient(0, 0, 0, view.h);
    // vertical gradient is wrong for a crest band; fade with a flat overlay
    ctx.fillStyle = rgb(b.col, b.alpha);
    ctx.fillRect(x0, 0, x1 - x0, view.h);
    // depth fade toward the bottom of the band
    const fadeTop = Math.min(...b.pts.map((_, i) => yAt(i))) + depth * 0.45;
    const fg = ctx.createLinearGradient(0, fadeTop, 0, fadeTop + depth * 0.9);
    fg.addColorStop(0, `rgba(${sky.haze.map(Math.round).join(',')},0)`);
    fg.addColorStop(1, `rgba(${sky.haze.map(Math.round).join(',')},0.9)`);
    ctx.fillStyle = fg;
    ctx.fillRect(x0, fadeTop, x1 - x0, depth);
    ctx.restore();

    // rim light along the crest
    ctx.save();
    ctx.globalAlpha = 0.20;
    ctx.strokeStyle = `rgb(${sky.sunColor})`;
    ctx.lineWidth = 1.4;
    crest(0);
    ctx.stroke();
    ctx.restore();
  }

  // haze band
  const hz = view.toScreenY(-4);
  // horizon haze: a flat wash (cheap) rather than a full-width gradient fill
  ctx.save();
  ctx.globalAlpha = 0.0;
  ctx.fillStyle = `rgb(${sky.haze})`;
  const hw = view.w / view.scale + 900;
  ctx.fillRect(view.cx - hw / 2, hz - 120 * view.zoom, hw, 150 * view.zoom);
  ctx.restore();
}

export function drawTreeline(ctx, view, t, sky) {
  // A silhouette of wind-bent pines along the far bank. Cheap, but it gives the
  // valley floor a scale reference and a strong horizontal. Drawn in world space
  // at the horizon line so it stays locked under the ridges during camera moves.
  const col = mixRgb(sky.bottom, sky.haze, 0.42);
  ctx.save();
  for (let i = 0; i < 52; i++) {
    const wx = -420 + i * 17 + hash(i * 7) * 11;
    const hgt = 7 + Math.pow(hash(i * 7 + 1), 1.6) * 30;
    const sway = noise1(t * 0.7 + i, 5) * 1.6;
    const jitterY = hash(i * 7 + 2) * 3;
    ctx.fillStyle = rgb(mixRgb(col, sky.haze, 0.25 + hash(i * 7 + 3) * 0.3), 0.62);
    ctx.beginPath();
    ctx.moveTo(wx - hgt * 0.19, 2 + jitterY);
    ctx.lineTo(wx + sway * 0.3, -hgt * 0.55);
    ctx.lineTo(wx - hgt * 0.11, -hgt * 0.6);
    ctx.lineTo(wx + sway * 0.6, -hgt);
    ctx.lineTo(wx + hgt * 0.11, -hgt * 0.58);
    ctx.lineTo(wx + hgt * 0.17, -hgt * 0.62);
    ctx.lineTo(wx + hgt * 0.21, 2 + jitterY);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawClouds(ctx, view, t, sky, wind) {
  const G = ensureGeo();
  for (const c of G.clouds) {
    // quantised colour so the sprite cache stays small across sky changes
    const col = mixRgb(sky.haze, sky.cloud, 0.35 + c.depth * 0.5);
    const colKey = col.map((v) => Math.round(v / 12) * 12).join(',');
    const s = c.s * view.zoom * 0.9 * view.scale;
    const sprite = cloudSprite(c.puffs, colKey, s);
    if (!sprite) continue;
    const drift = (t * c.drift * 0.55 + wind * 0.7) % 620;
    const wx = ((c.x + drift + 320) % 620) - 320;
    const x = view.toScreenX(wx);
    const y = view.toScreenY(c.y);
    if (x < -sprite.w || x > view.w + sprite.w) continue;
    // 1:1 blit at the baked size — no resampling, no scaling cost
    ctx.drawImage(sprite.canvas, Math.round(x - sprite.ox), Math.round(y - sprite.oy));
  }
}

// Great valley walls framing the battlefield.
//
// Two depth bands per side. Each is a jagged cliff mass running off the frame
// edges (so there is never a visible polygon border) with a vertical light
// gradient, a few faceted ledges, and haze pooling at its base.
export function drawValleyWalls(ctx, view, t, sky, lightRgb, which = 'all') {
  const y0 = view.toScreenY(0);
  const haze = sky.haze;
  const all = [
    {
      band: 'far', par: 0.26, inner: 700, top: -420, lean: 260,
      topCol: mixRgb(sky.mid, haze, 0.70), botCol: mixRgb(sky.mid, haze, 0.46),
      alpha: 0.62, rough: 40, seed: 3, rim: 0.10, ledges: 4, minFrac: 0.40, maxFrac: 0.54,
    },
    {
      band: 'near', par: 0.72, inner: 560, top: -460, lean: 380,
      topCol: mixRgb([40, 40, 52], haze, 0.16), botCol: [18, 19, 25],
      alpha: 1, rough: 22, seed: 11, rim: 0.22, ledges: 5, minFrac: 0.335, maxFrac: 0.47,
    },
  ];
  const bands = all.filter((b) => which === 'all' || b.band === which);

  for (const B of bands) {
    for (const side of [-1, 1]) {
      // `view.scale` already includes zoom. Multiplying by zoom again collapsed
      // both walls into frame centre on wide shots, which read as grey boxes.
      // The offset is also floored in *screen* pixels so that at very wide shots
      // the cliffs stay pinned to the sides instead of sweeping over the action.
      // Framing clamp: the cliff edge stays inside a band of the frame width, so
      // the corridor reads as closed on every shot instead of opening up.
      const innerPx = clamp(B.inner * view.scale, view.w * B.minFrac, view.w * B.maxFrac);
      const innerX = view.w / 2 + side * (innerPx - view.cx * B.par);
      const steps = 26;
      const edge = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const yy = lerp(y0 + 6, B.top, u);
        const lean = -side * Math.pow(u, 1.35) * B.lean * view.scale;
        const jag = noise1(u * 3.2 + B.par * 7 + B.seed, B.seed) * B.rough * view.scale
          + noise1(u * 9 + B.seed, B.seed + 4) * B.rough * 0.35 * view.scale;
        edge.push({ x: innerX + lean + jag, y: yy });
      }
      const farX = side * 4000;

      const path = () => {
        ctx.beginPath();
        ctx.moveTo(edge[0].x, edge[0].y);
        for (const p of edge) ctx.lineTo(p.x, p.y);
        ctx.lineTo(farX, B.top);
        ctx.lineTo(farX, view.h + 30);
        ctx.closePath();
      };

      // Depth without a full-height gradient: flat base + two short blend bands.
      path();
      ctx.fillStyle = rgb(B.botCol, B.alpha);
      ctx.fill();
      ctx.save();
      path();
      ctx.clip();
      const midCol = mixRgb(B.topCol, B.botCol, 0.55);
      // one continuous vertical ramp: no hard horizontal edge anywhere
      const g = ctx.createLinearGradient(0, B.top, 0, y0 + 60);
      g.addColorStop(0, rgb(B.topCol, B.alpha));
      g.addColorStop(0.35, rgb(mixRgb(B.topCol, midCol, 0.7), B.alpha));
      g.addColorStop(0.72, rgb(midCol, B.alpha));
      g.addColorStop(1, rgb(B.botCol, B.alpha));
      ctx.fillStyle = g;
      ctx.fillRect(-10, B.top - 10, view.w + 240, (y0 - B.top) + 80);
      ctx.restore();

      // ---- interior: soft strata + crevices.
      // Anything with straight edges at this scale reads as a floating box, so
      // the surface detail is built from low-alpha ellipses and noise-following
      // crevices that die out well inside the wall silhouette.
      ctx.save();
      path();
      ctx.clip();

      for (let f = 0; f < 14; f++) {
        const v = 0.05 + hash(B.seed + f * 3.7) * 0.9;
        const px = edge[Math.round(v * steps)].x - side * (20 + hash(B.seed + f * 5.1) * 300) * view.scale;
        const py = lerp(y0 + 6, B.top, v) + (hash(B.seed + f * 7.3) - 0.5) * 40 * view.scale;
        const rx = (60 + hash(B.seed + f * 9.1) * 220) * view.scale;
        const ry = rx * (0.16 + hash(B.seed + f * 11.3) * 0.2);
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, (hash(B.seed + f) - 0.5) * 0.35, 0, TAU);
        ctx.fillStyle = f % 3 === 0 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.055)';
        ctx.fill();
      }

      for (let f = 0; f < 9; f++) {
        const v = 0.1 + hash(B.seed + f * 13 + 2) * 0.85;
        const px = edge[Math.round(v * steps)].x - side * (10 + hash(B.seed + f * 17) * 160) * view.scale;
        const py = lerp(y0 + 6, B.top, v);
        const len = (80 + hash(B.seed + f * 19) * 260) * view.scale;
        const drift = (hash(B.seed + f * 23) - 0.5) * 0.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        for (let k = 1; k <= 5; k++) {
          const u = k / 5;
          ctx.lineTo(
            px - side * (noise1(v * 5 + u * 2 + f, B.seed + 2) * 0.5 + drift) * len * 0.5 - side * u * 6 * view.scale,
            py + u * len,
          );
        }
        ctx.strokeStyle = `rgba(0,0,0,${0.07 + hash(B.seed + f) * 0.07})`;
        ctx.lineWidth = Math.max(1, (1.2 + hash(B.seed + f * 3) * 2.4) * view.scale);
        ctx.stroke();
      }
      ctx.restore();

      // Rim light along the cliff edge, tapered to nothing toward the top: a
      // full-length constant stroke read as a stray hairline in the sky.
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, 1.6 * view.scale);
      for (let i = 1; i < edge.length; i++) {
        const u = i / (edge.length - 1);
        const a = B.rim * Math.pow(1 - u, 1.6) * smoothstep(0, 0.12, u);
        if (a <= 0.004) continue;
        ctx.globalAlpha = a;
        ctx.strokeStyle = `rgb(${lightRgb})`;
        ctx.beginPath();
        ctx.moveTo(edge[i - 1].x, edge[i - 1].y);
        ctx.lineTo(edge[i].x, edge[i].y);
        ctx.stroke();
      }
      ctx.restore();

      // haze pooling at the wall base — clipped to the wall silhouette so the
      // fill can never show up as a horizontal band across the frame
      const hz = haze.map(Math.round).join(',');
      ctx.save();
      path();
      ctx.clip();
      const fade = ctx.createLinearGradient(0, y0 - 150 * view.scale, 0, y0 + 20 * view.scale);
      fade.addColorStop(0, `rgba(${hz},0)`);
      fade.addColorStop(1, `rgba(${hz},${B.band === 'far' ? 0.34 : 0.22})`);
      ctx.fillStyle = fade;
      ctx.fillRect(Math.min(innerX, farX), y0 - 160 * view.scale, Math.abs(farX - innerX) + 300, 180 * view.scale);
      ctx.restore();
    }
  }
}

export function drawStatues(ctx, view, t, sky, lightRgb) {
  // Two colossal standing guardians flank the valley. Original design: robed,
  // faceless stone warriors, one still whole, one broken and headless.
  const G = ensureGeo();
  for (const s of G.statues) {
    const x = view.toScreenX(s.x);
    const y = view.toScreenY(0);
    const H = s.h * view.zoom;
    const W = H * 0.30;
    if (x < -W * 4 || x > view.w + W * 4) continue;
    const flip = s.side;
    const base = mixRgb([44, 46, 56], sky.haze, 0.10);
    const dark = mixRgb(base, [0, 0, 0], 0.42);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(flip, 1);

    // --- plinth
    ctx.fillStyle = rgb(dark, 0.98);
    ctx.beginPath();
    ctx.moveTo(-W * 1.15, 0);
    ctx.lineTo(-W * 0.95, -H * 0.06);
    ctx.lineTo(W * 0.95, -H * 0.06);
    ctx.lineTo(W * 1.15, 0);
    ctx.closePath();
    ctx.fill();

    // --- robe / body: tapered, wider at the base, narrowed shoulders
    const bh = H * (1 - s.fail);
    ctx.beginPath();
    ctx.moveTo(-W * 0.95, -H * 0.04);
    ctx.lineTo(-W * 0.7, -bh * 0.42);
    ctx.quadraticCurveTo(-W * 0.66, -bh * 0.8, -W * 0.56, -bh * 0.92);
    ctx.lineTo(W * 0.56, -bh * 0.92);
    ctx.quadraticCurveTo(W * 0.66, -bh * 0.8, W * 0.7, -bh * 0.42);
    ctx.lineTo(W * 0.95, -H * 0.04);
    ctx.closePath();
    ctx.fillStyle = rgb(base);
    ctx.fill();

    // robe folds (vertical strata)
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = rgb(dark, 0.85);
    for (let i = -3; i <= 3; i++) {
      ctx.lineWidth = W * (0.02 + 0.01 * Math.abs(i));
      ctx.beginPath();
      ctx.moveTo(W * i * 0.22, -bh * 0.9);
      ctx.lineTo(W * i * 0.3, -H * 0.04);
      ctx.stroke();
    }
    // weathered cracks & moss
    ctx.strokeStyle = rgb(dark, 0.6);
    ctx.lineWidth = W * 0.02;
    for (let i = 0; i < 7; i++) {
      const px = (hash(s.seed + i * 5) - 0.5) * W * 1.2;
      const py = -bh * (0.1 + hash(s.seed + i * 5 + 1) * 0.8);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + (hash(s.seed + i) - 0.5) * W * 0.3, py + H * 0.12);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(64,84,64,0.28)';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.ellipse((hash(s.seed + i) - 0.5) * W, -bh * (0.2 + hash(s.seed + i + 9) * 0.6), W * 0.16, H * 0.05, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // --- shoulders (broad slab)
    ctx.fillStyle = rgb(mixRgb(base, [255, 255, 255], 0.05));
    ctx.beginPath();
    ctx.moveTo(-W * 0.66, -bh * 1.0);
    ctx.lineTo(W * 0.66, -bh * 1.0);
    ctx.lineTo(W * 0.6, -bh * 0.93);
    ctx.lineTo(-W * 0.6, -bh * 0.93);
    ctx.closePath();
    ctx.fill();

    // --- arms: one hand resting on a sword hilt, the other broken off
    if (s.seed === 8) {
      // left arm down to a planted blade
      ctx.fillStyle = rgb(base);
      ctx.beginPath();
      ctx.moveTo(-W * 0.5, -bh * 0.95);
      ctx.quadraticCurveTo(-W * 0.86, -bh * 0.7, -W * 0.72, -H * 0.4);
      ctx.lineTo(-W * 0.52, -H * 0.42);
      ctx.quadraticCurveTo(-W * 0.62, -bh * 0.7, -W * 0.34, -bh * 0.9);
      ctx.closePath();
      ctx.fill();
      // giant blade planted in the ground
      ctx.beginPath();
      ctx.moveTo(-W * 0.76, -H * 0.42);
      ctx.lineTo(-W * 0.6, -H * 0.45);
      ctx.lineTo(-W * 0.66, H * 0.02);
      ctx.lineTo(-W * 0.72, H * 0.02);
      ctx.closePath();
      ctx.fillStyle = rgb(mixRgb(base, [170, 180, 200], 0.35));
      ctx.fill();
      // crossguard
      ctx.fillStyle = rgb(dark);
      ctx.fillRect(-W * 0.9, -H * 0.45, W * 0.44, H * 0.014);
    } else {
      // broken arm: jagged stump
      ctx.fillStyle = rgb(base);
      ctx.beginPath();
      ctx.moveTo(W * 0.44, -bh * 0.95);
      ctx.lineTo(W * 0.74, -bh * 0.62);
      ctx.lineTo(W * 0.62, -bh * 0.55);
      ctx.lineTo(W * 0.56, -bh * 0.62);
      ctx.lineTo(W * 0.36, -bh * 0.86);
      ctx.closePath();
      ctx.fill();
    }

    // --- head (missing on the broken one)
    if (s.fail < 0.5) {
      const hy = -bh * 1.1;
      // faceted helmet-style head
      ctx.beginPath();
      ctx.moveTo(-W * 0.2, hy + H * 0.05);
      ctx.lineTo(-W * 0.26, hy - H * 0.03);
      ctx.lineTo(-W * 0.16, hy - H * 0.085);
      ctx.lineTo(W * 0.16, hy - H * 0.085);
      ctx.lineTo(W * 0.26, hy - H * 0.03);
      ctx.lineTo(W * 0.2, hy + H * 0.05);
      ctx.closePath();
      ctx.fillStyle = rgb(mixRgb(base, [255, 255, 255], 0.07));
      ctx.fill();
      ctx.strokeStyle = rgb(dark, 0.7);
      ctx.lineWidth = Math.max(0.8, W * 0.012);
      ctx.stroke();
      // horned crown
      ctx.fillStyle = rgb(dark);
      ctx.beginPath();
      ctx.moveTo(-W * 0.3, hy - H * 0.04);
      ctx.lineTo(-W * 0.46, hy - H * 0.13);
      ctx.lineTo(-W * 0.1, hy - H * 0.06);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(W * 0.3, hy - H * 0.04);
      ctx.lineTo(W * 0.46, hy - H * 0.12);
      ctx.lineTo(W * 0.1, hy - H * 0.06);
      ctx.closePath();
      ctx.fill();
      // carved eye slit
      ctx.fillStyle = 'rgba(10,10,14,0.8)';
      ctx.fillRect(-W * 0.14, hy - H * 0.005, W * 0.28, H * 0.016);
    } else {
      // shattered neck
      ctx.fillStyle = rgb(dark);
      ctx.beginPath();
      ctx.moveTo(-W * 0.3, -bh);
      ctx.lineTo(-W * 0.18, -bh * 1.07);
      ctx.lineTo(0, -bh * 1.02);
      ctx.lineTo(W * 0.16, -bh * 1.08);
      ctx.lineTo(W * 0.3, -bh);
      ctx.closePath();
      ctx.fill();
    }

    // --- sunward rim light
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.30;
    ctx.strokeStyle = `rgb(${lightRgb})`;
    ctx.lineWidth = Math.max(1.2, W * 0.02);
    ctx.beginPath();
    ctx.moveTo(-W * 0.86, -H * 0.04);
    ctx.lineTo(-W * 0.66, -bh * 0.55);
    ctx.quadraticCurveTo(-W * 0.62, -bh * 0.86, -W * 0.44, -bh * 0.94);
    ctx.stroke();
    ctx.restore();

    // --- atmospheric fade so they sit inside the haze
    ctx.restore();

    ctx.restore();
  }
}

export function drawGround(ctx, view, t, sky, cracks, q = null) {
  const B = worldBounds(view, 420);
  const y0 = 0;                       // the ground plane in world units
  const depth = Math.max(240, B.bottom - y0);
  const grass = mixRgb(sky.ground, [78, 84, 62], 0.24);
  // Cached vertical gradient strip, blitted across the full world span. Building
  // a 10-stop gradient over a 4000x1200 area every frame was the single largest
  // remaining CPU cost; the palette only changes at sky keys.
  const stops = [
    [0, mixRgb(grass, sky.haze, 0.80)],
    [0.05, mixRgb(grass, sky.haze, 0.46)],
    [0.11, mixRgb(grass, sky.haze, 0.24)],
    [0.20, mixRgb(grass, sky.haze, 0.10)],
    [0.34, grass],
    [0.46, mixRgb(grass, [40, 40, 38], 0.18)],
    [0.58, mixRgb(grass, [30, 30, 30], 0.34)],
    [0.72, mixRgb(grass, [24, 24, 26], 0.50)],
    [0.86, mixRgb(grass, [18, 19, 22], 0.62)],
    [1, mixRgb(grass, [13, 14, 17], 0.74)],
  ];
  const qc = (c) => c.map((v) => Math.round(v / 4) * 4).join(',');
  const key = `ground|${stops.map(([, c]) => qc(c)).join('|')}`;
  const strip = groundStrip(key, null, null, 512, stops);
  if (strip) {
    ctx.drawImage(strip, B.left, y0, B.width, depth);
  } else {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + depth);
    for (const [p, c] of stops) g.addColorStop(p, rgbCss(c));
    ctx.fillStyle = g;
    ctx.fillRect(B.left, y0, B.width, depth);
  }

  // sunlit sheen along the horizon
  const sg = ctx.createLinearGradient(0, y0, 0, y0 + depth * 0.22);
  sg.addColorStop(0, `rgba(${sky.sunColor},0.08)`);
  sg.addColorStop(1, `rgba(${sky.sunColor},0)`);
  ctx.fillStyle = sg;
  ctx.fillRect(B.left, y0, B.width, depth * 0.22);

  // horizon line
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = `rgb(${sky.haze})`;
  ctx.fillRect(B.left, y0 - 1.2, B.width, 1.8);
  ctx.restore();

  const G = ensureGeo();
  const zToY = (z) => y0 + (z * z) * Math.min(depth, 300) * 0.9;

  // large terrain patches for ground variation
  for (let i = 0; i < 16; i++) {
    const px = (hash(i * 17 + 3) - 0.5) * 520;
    const pz = hash(i * 17 + 4);
    const py = zToY(pz * 0.9);
    const rx = 40 + hash(i * 17 + 5) * 150;
    const ry = rx * (0.1 + pz * 0.16);
    ctx.beginPath();
    ctx.ellipse(px, py, rx, ry, 0, 0, TAU);
    ctx.fillStyle = hash(i * 17 + 6) > 0.5
      ? `rgba(${mixRgb(grass, [40, 44, 34], 0.5).map(Math.round).join(',')},0.28)`
      : `rgba(${mixRgb(grass, [110, 104, 86], 0.4).map(Math.round).join(',')},0.20)`;
    ctx.fill();
  }

  // dry river bed meandering across the valley floor
  ctx.save();
  ctx.globalAlpha = 0.55;
  const rbY = (u) => y0 + 26 + u * 120 + Math.sin(u * 7.5 + 1.2) * 9;
  ctx.beginPath();
  ctx.moveTo(B.left, rbY(0));
  for (let i = 0; i <= 26; i++) ctx.lineTo(lerp(B.left, B.right, i / 26), rbY(i / 26));
  for (let i = 26; i >= 0; i--) ctx.lineTo(lerp(B.left, B.right, i / 26), rbY(i / 26) + 34);
  ctx.closePath();
  const rbg = ctx.createLinearGradient(0, y0 + 20, 0, y0 + 170);
  rbg.addColorStop(0, `rgba(${mixRgb(grass, [150, 146, 128], 0.5).map(Math.round).join(',')},0.30)`);
  rbg.addColorStop(1, `rgba(${mixRgb(grass, [26, 24, 22], 0.6).map(Math.round).join(',')},0.45)`);
  ctx.fillStyle = rbg;
  ctx.fill();
  ctx.restore();

  // mid-band rock outcrops: low, wide shapes that break up the floor
  for (let i = 0; i < 8; i++) {
    const bx = (hash(i * 31 + 3) - 0.5) * 300;
    const z = 0.06 + hash(i * 31 + 4) * 0.12;
    const yy = zToY(z);
    const s2 = 12 + hash(i * 31 + 5) * 26;
    ctx.beginPath();
    ctx.moveTo(bx - s2 * 1.6, yy);
    ctx.quadraticCurveTo(bx - s2 * 0.9, yy - s2 * 0.72, bx - s2 * 0.1, yy - s2 * 0.8);
    ctx.quadraticCurveTo(bx + s2 * 0.8, yy - s2 * 0.62, bx + s2 * 1.5, yy);
    ctx.closePath();
    ctx.fillStyle = `rgba(${mixRgb([64, 62, 56], sky.haze, 0.35).map(Math.round).join(',')},0.85)`;
    ctx.fill();
  }

  // scree with depth-scaled size and a cast shadow
  for (const r of G.rocks) {
    const yy = zToY(r.z * 0.9);
    const rad = r.r * (0.6 + r.z * 0.9);
    ctx.beginPath();
    ctx.ellipse(r.x + rad * 0.25, yy + rad * 0.16, rad * 1.35, rad * 0.5, 0, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(r.x, yy, rad * 1.25, rad * 0.6, r.rot * 0.2, 0, TAU);
    ctx.fillStyle = `rgba(${mixRgb(grass, [30, 28, 26], 0.55 + r.shade * 0.3).map(Math.round).join(',')},0.92)`;
    ctx.fill();
  }

  // grass tufts
  for (const tf of G.tufts) {
    const yy = zToY(tf.z * 0.8);
    ctx.strokeStyle = `rgba(${mixRgb([76, 88, 58], grass, 0.35).map(Math.round).join(',')},0.7)`;
    ctx.lineWidth = 1.1;
    for (let b = 0; b < tf.blades; b++) {
      const sway = noise1(t * 1.4 + tf.x * 0.1 + b, 7) * 2.4;
      ctx.beginPath();
      ctx.moveTo(tf.x + b * 1.6, yy);
      ctx.quadraticCurveTo(tf.x + b * 1.6 + tf.lean * 0.5, yy - tf.h * 0.6, tf.x + b * 1.6 + tf.lean + sway, yy - tf.h * 0.5);
      ctx.stroke();
    }
  }

  // scattered pebbles with a lit edge so the floor has readable texture
  const pebbleCount = (q && q.pebbles) || 150;
  for (let i = 0; i < pebbleCount; i++) {
    const px = (hash(i * 13 + 5) - 0.5) * 460;
    const pz = hash(i * 13 + 6);
    const py = zToY(pz * 0.95);
    const rr = (1.2 + hash(i * 13 + 7) * 4.2) * (0.5 + pz);
    ctx.beginPath();
    ctx.ellipse(px, py, rr * 1.3, rr * 0.55, 0, 0, TAU);
    ctx.fillStyle = `rgba(${mixRgb([70, 66, 58], [16, 15, 14], hash(i * 13 + 8)).map(Math.round).join(',')},0.75)`;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(px - rr * 0.15, py - rr * 0.16, rr * 0.8, rr * 0.26, 0, 0, TAU);
    ctx.fillStyle = `rgba(${mixRgb([150, 142, 124], [70, 66, 58], hash(i * 13 + 9)).map(Math.round).join(',')},0.28)`;
    ctx.fill();
  }

  drawCracks(ctx, view, cracks, t);

  // distance fog over the far ground so it blends into the haze
  const fg = ctx.createLinearGradient(0, y0 - 2, 0, y0 + depth * 0.30);
  fg.addColorStop(0, `rgba(${sky.haze.map(Math.round).join(',')},0.42)`);
  fg.addColorStop(1, `rgba(${sky.haze.map(Math.round).join(',')},0)`);
  ctx.fillStyle = fg;
  ctx.fillRect(B.left, y0 - 2, B.width, depth * 0.22);
}

function drawBoulder(ctx, x, y, s, seed, grass, sky) {
  const base = mixRgb(grass, [58, 54, 50], 0.6);
  // shadow
  ctx.beginPath();
  ctx.ellipse(x + s * 0.3, y + s * 0.22, s * 1.5, s * 0.35, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fill();
  // rock body
  ctx.beginPath();
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const a = Math.PI + (i / n) * Math.PI;
    const rr = s * (0.72 + hash(seed * 31 + i) * 0.5);
    const px = x + Math.cos(a) * rr * 1.15;
    const py = y + Math.sin(a) * rr * 0.95;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = rgb(base);
  ctx.fill();
  // lit top facet
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(x - s * 2, y - s * 0.2);
  ctx.lineTo(x + s * 2, y - s * 0.4);
  ctx.lineTo(x + s * 2, y + s * 2);
  ctx.lineTo(x - s * 2, y + s * 2);
  ctx.closePath();
  ctx.fillStyle = rgb(mixRgb(base, [150, 148, 132], 0.28));
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = `rgba(${sky.ground.map(Math.round).join(',')},0.5)`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawCracks(ctx, view, cracks, t) {
  if (!cracks || !cracks.length) return;
  for (const c of cracks) {
    if (c.t > t) continue;
    const age = t - c.t;
    const grow = clamp01(age / 0.35);
    const alpha = clamp01(c.power) * clamp01(1 - (age - 14) / 6, 0, 1) * 0.85;
    if (alpha <= 0.02) continue;
    const seed = c.seed | 0;
    const branches = 4 + Math.floor(hash(seed) * 5);
    ctx.save();
    ctx.translate(c.x, 2);
    ctx.scale(1, 0.35 + clamp01(c.depth ?? 0.5) * 0.5);
    ctx.globalAlpha = alpha;
    for (let b = 0; b < branches; b++) {
      const ang = (hash(seed + b * 3) - 0.5) * 2.2 + Math.PI / 2;
      const len = (18 + hash(seed + b * 3 + 1) * 70) * c.power * grow;
      const w = 1.6 + hash(seed + b) * 1.2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      let px = 0, py = 0, a = ang;
      const segs = 5;
      for (let sgm = 0; sgm < segs; sgm++) {
        a += (hash(seed + b * 7 + sgm) - 0.5) * 0.9;
        px += Math.cos(a) * (len / segs);
        py += Math.sin(a) * (len / segs);
        ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,214,150,${0.10 * alpha})`;
      ctx.lineWidth = w * 0.5;
      ctx.stroke();
    }
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, 46 * c.power);
    rg.addColorStop(0, `rgba(18,14,12,${0.5 * clamp01(1 - age / 18)})`);
    rg.addColorStop(1, 'rgba(18,14,12,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.ellipse(0, 0, 50 * c.power, 16 * c.power, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

export function drawForeground(ctx, view, t, sky) {
  // Large out-of-focus rocks in the bottom corners. They frame the shot and add
  // depth without ever covering the action (the fight lives in the centre band).
  const { w, h } = view;
  const rocks = [
    { sx: -0.03, sy: 1.09, s: 0.20, par: 0.9, seed: 3 },
    { sx: 1.01, sy: 1.11, s: 0.18, par: 0.9, seed: 9 },
  ];
  ctx.save();
  for (const r of rocks) {
    const x = w * r.sx - view.cx * r.par * 0.15;
    const y = h * r.sy;
    const s = Math.min(w, h) * r.s;
    ctx.beginPath();
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const a = Math.PI + (i / n) * Math.PI;
      const rr = s * (0.66 + hash(r.seed * 17 + i) * 0.6);
      const px = x + Math.cos(a) * rr * 1.2;
      const py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const fg = ctx.createLinearGradient(0, y - s * 0.9, 0, y + s * 0.4);
    fg.addColorStop(0, 'rgba(9,11,17,0.90)');
    fg.addColorStop(1, 'rgba(4,5,8,0.99)');
    ctx.fillStyle = fg;
    ctx.fill();
  }
  ctx.restore();
}

// Atmospheric particles: drifting motes / embers. Analytic in time.
export function drawMotes(ctx, view, t, sky, density = 1) {
  const n = Math.round(70 * density);
  const B = worldBounds(view, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const life = 6 + hash(i * 5 + 2) * 10;
    const ph = (t + hash(i * 5 + 3) * life) / life;
    const cycle = Math.floor(ph);
    const u = ph - cycle;
    const bx = hash(i * 5 + 4 + cycle * 31) * 2 - 1;
    const x = bx * 170 + u * 26 + view.cx * 0.35;
    const y = 60 - u * 140 + hash(i * 5 + 6) * 40 + view.cy * 0.25;
    if (x < B.left || x > B.right || y < B.top || y > B.bottom) continue;
    const a = Math.sin(u * Math.PI) * (0.16 + hash(i * 5 + 7) * 0.3);
    const r = 0.7 + hash(i * 5 + 8) * 1.7;
    ctx.globalAlpha = a;
    ctx.fillStyle = `rgb(${sky.mote})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

export function drawAtmosphere(ctx, view, o) {
  const { w, h } = view;
  if (o.wash) {
    // Elliptical glow, drawn as an arc path: no rectangular bounding box can
    // become visible the way it could with a clipped fillRect.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(o.wash.a);
    const r = o.wash.r;
    ctx.translate(o.wash.x, o.wash.y);
    ctx.scale(1, 0.62);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(${o.wash.col},0.46)`);
    g.addColorStop(0.4, `rgba(${o.wash.col},0.16)`);
    g.addColorStop(1, `rgba(${o.wash.col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Vignette + film grain arrive as a single pre-baked sheet: one 1:1 blit.
  const hasGrain = o.grain > 0;
  const variant = hasGrain ? (((o.time || 0) * 12) | 0) & 3 : 0;
  const sheet = postOverlay(ctx, w, h, o.vignette ?? 0.55, variant, hasGrain);
  if (sheet) {
    ctx.save();
    if (hasGrain) ctx.globalAlpha = Math.min(1, o.grain * 7.5);
    if (sheet.k === 1) ctx.drawImage(sheet.canvas, 0, 0);
    else ctx.drawImage(sheet.canvas, 0, 0, sheet.canvas.width, sheet.canvas.height, 0, 0, w, h);
    ctx.restore();
  }
}

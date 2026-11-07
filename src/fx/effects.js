// Visual effects.
//
// Every effect is *analytic*: given (event, current time) it derives particle
// positions from a closed-form ballistic/drag model seeded by a hash. There is no
// accumulated simulation state, so seeking to any timestamp reproduces the exact
// same frame — a hard requirement for the scrub bar to be trustworthy.
//
// Effects are additionally depth-sorted against characters by the stage.

import { hash, hash2, noise1, clamp, clamp01, lerp, TAU, ease, smoothstep } from '../core/math.js';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------
function glowDot(ctx, x, y, r, rgb, a) {
  if (r <= 0.2 || a <= 0.004) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(0.35, `rgba(${rgb},${a * 0.45})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function ring(ctx, x, y, r, rgb, a, w) {
  if (r <= 0 || a <= 0.004) return;
  const g = ctx.createRadialGradient(x, y, Math.max(0, r - w), x, y, r + w * 0.2);
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(0.7, `rgba(${rgb},${a * 0.75})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r + w * 0.2, 0, TAU);
  ctx.fill();
}

// Jagged lightning polyline (midpoint displacement). Deterministic in (seed, frame).
function jagged(ctx, x1, y1, x2, y2, seed, rough, depth) {
  const pts = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  let amp = rough;
  for (let d = 0; d < depth; d++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const off = (hash2(seed + d * 101 + i * 17, Math.floor(seed)) - 0.5) * amp;
      next.push({ x: mx - (dy / l) * off, y: my + (dx / l) * off });
      next.push(b);
    }
    pts.length = 0;
    pts.push(...next);
    amp *= 0.55;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  return pts;
}

// ---------------------------------------------------------------------------
// Effect renderers. Each receives (ctx, view, e, t) in WORLD coordinates.
// The caller has already applied the camera transform.
// ---------------------------------------------------------------------------

const FX = {};

// Dust / debris puff. e: {x, y, n, power, spread, col, dur, vy}
FX.dust = (ctx, view, e, t) => {
  const age = t - e.t;
  if (age < 0 || age > (e.dur ?? 1.4)) return;
  const u = age / (e.dur ?? 1.4);
  const n = e.n ?? 16;
  const pow = e.power ?? 1;
  const z = view.scale;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < n; i++) {
    const a1 = hash2(e.seed, i), a2 = hash2(e.seed, i + 100), a3 = hash2(e.seed, i + 200);
    const dir = e.dir ?? 1;
    const ang = -Math.PI / 2 + (a1 - 0.5) * (e.spread ?? 2.2) + (dir < 0 ? Math.PI : 0) * 0.5;
    const spd = (18 + a2 * 70) * pow;
    const drag = 2.6 + a3 * 1.6;
    const k = (1 - Math.exp(-drag * age)) / drag;
    const x = e.x + Math.cos(ang) * spd * k * (e.vx ?? 1) + (e.wind ?? 0) * age * 8;
    const y = e.y + Math.sin(ang) * spd * k + (e.vyb ?? 0) * k;
    const r = (4 + a3 * 16) * pow * (0.5 + u * 1.5) * (z / 1.5);
    const a = (1 - u) ** 1.6 * (e.alpha ?? 0.34) * (0.4 + a2 * 0.75);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const col = e.col || '150,140,125';
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

// Sparks: bright, fast, gravity-affected.
FX.sparks = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 0.6;
  if (age < 0 || age > dur) return;
  const u = age / dur;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const n = e.n ?? 18;
  const col = e.col || '255,220,140';
  for (let i = 0; i < n; i++) {
    const a1 = hash2(e.seed, i), a2 = hash2(e.seed, i + 60), a3 = hash2(e.seed, i + 120);
    const ang = (e.ang ?? -Math.PI / 2) + (a1 - 0.5) * (e.spread ?? 3.4);
    const spd = (60 + a2 * 260) * (e.power ?? 1);
    const g = 320;
    const x = e.x + Math.cos(ang) * spd * age;
    const y = e.y + Math.sin(ang) * spd * age + 0.5 * g * age * age * (e.g ?? 1);
    const vx = Math.cos(ang) * spd, vy = Math.sin(ang) * spd + g * age;
    const len = Math.min(26, Math.hypot(vx, vy) * 0.035) * (1 - u * 0.5);
    const a = (1 - u) * 0.95;
    ctx.strokeStyle = `rgba(${col},${a})`;
    ctx.lineWidth = (0.9 + a3 * 1.8) * (1 - u * 0.4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - vx * 0.02 * len, y - vy * 0.02 * len);
    ctx.stroke();
    glowDot(ctx, x, y, (2.5 + a3 * 3) * (1 - u), col, a * 0.5);
  }
  ctx.restore();
};

// Shockwave: expanding elliptical ring, ground-hugging.
FX.shock = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 0.7;
  if (age < 0 || age > dur) return;
  const u = clamp01(age / dur);
  const r = (e.r0 ?? 10) + (e.r1 ?? 140) * ease.outQuart(u);
  const a = (1 - u) ** 1.8 * (e.alpha ?? 0.7);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(e.x, e.y);
  ctx.scale(1, e.squash ?? 0.32);
  ring(ctx, 0, 0, r, e.col || '255,225,180', a, (e.w ?? 10) * (1 - u * 0.6));
  ring(ctx, 0, 0, r * 0.72, e.col || '255,255,240', a * 0.5, (e.w ?? 6) * (1 - u * 0.5));
  ctx.restore();
};

// Air-ring shockwave that expands in all directions (no squash).
FX.burstRing = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 0.5;
  if (age < 0 || age > dur) return;
  const u = clamp01(age / dur);
  const r = (e.r1 ?? 100) * ease.outExpo(u);
  const a = (1 - u) ** 2 * (e.alpha ?? 0.85);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ring(ctx, e.x, e.y, r, e.col || '255,240,210', a, (e.w ?? 8));
  ctx.restore();
};

// Fireball projectile with trail.
FX.fireball = (ctx, view, e, t) => {
  const age = t - e.t;
  if (age < 0) return;
  const u = clamp01(age / (e.life ?? 1.0));
  if (u >= 1) return;
  const p = e.path(age);
  const z = view.scale;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // trail
  for (let i = 12; i >= 0; i--) {
    const back = i * 0.028;
    const q = e.path(Math.max(0, age - back));
    const f = 1 - i / 13;
    const r = (e.size ?? 34) * f * (0.9 + 0.1 * noise1(age * 9 + i, 3));
    glowDot(ctx, q.x, q.y, r * 1.5, '255,140,40', 0.20 * f * (1 - u * 0.3));
  }
  // core
  const flick = 0.86 + 0.14 * noise1(age * 14, 7);
  glowDot(ctx, p.x, p.y, (e.size ?? 34) * 2.1 * flick, '255,120,30', 0.5);
  glowDot(ctx, p.x, p.y, (e.size ?? 34) * 1.15 * flick, '255,190,90', 0.85);
  glowDot(ctx, p.x, p.y, (e.size ?? 34) * 0.6 * flick, '255,250,225', 0.95);
  // crackling outer tongues
  ctx.strokeStyle = 'rgba(255,170,60,0.5)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + age * 6;
    const rr = (e.size ?? 34) * (1.1 + 0.4 * noise1(age * 7 + i, 9));
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(a) * rr * 0.6, p.y + Math.sin(a) * rr * 0.6);
    ctx.lineTo(p.x + Math.cos(a + 0.4) * rr, p.y + Math.sin(a + 0.4) * rr);
    ctx.stroke();
  }
  ctx.restore();
};

// Rasengan: rotating chakra sphere.
FX.rasengan = (ctx, view, e, t) => {
  const age = t - e.t;
  if (age < 0) return;
  const grow = clamp01(age / (e.grow ?? 0.45));
  const s = e.size ?? 26;
  const r = s * ease.outElastic(grow) * (1 + 0.04 * noise1(t * 12, 5));
  const fade = e.fade ? clamp01(1 - (t - e.fade) / 0.25) : 1;
  if (r < 1 || fade <= 0) return;
  const x = e.x, y = e.y;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glowDot(ctx, x, y, r * 3.4, '90,190,255', 0.30 * fade);
  glowDot(ctx, x, y, r * 2.0, '150,220,255', 0.5 * fade);
  glowDot(ctx, x, y, r * 1.12, '225,245,255', 0.9 * fade);

  // spinning shell filaments
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(age * 9);
  ctx.lineWidth = Math.max(1, r * 0.08);
  for (let i = 0; i < 5; i++) {
    const rr = r * (0.55 + i * 0.1);
    ctx.strokeStyle = `rgba(190,235,255,${(0.5 - i * 0.07) * fade})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, rr, rr * (0.42 + i * 0.09), i * 0.7 + age * 2, 0, Math.PI * 1.5);
    ctx.stroke();
  }
  // bright core
  glowDot(ctx, 0, 0, r * 0.75, '255,255,255', 0.85 * fade);
  ctx.restore();

  // outward chakra wisps
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + age * 3.4;
    const rr = r * (1.2 + 0.4 * hash2(e.seed, i));
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.85;
    glowDot(ctx, px, py, r * 0.36, '160,225,255', 0.4 * fade);
  }
  ctx.restore();
};

// Chidori / lightning aura around a hand.
FX.chidori = (ctx, view, e, t) => {
  const age = t - e.t;
  if (age < 0) return;
  const fade = e.fade ? clamp01(1 - (t - e.fade) / 0.2) : 1;
  if (fade <= 0) return;
  const amp = (e.amp ?? 1) * fade;
  const x = e.x, y = e.y;
  const r = (e.size ?? 22);
  const frame = Math.floor(t * 24);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  glowDot(ctx, x, y, r * 3.0, '90,150,255', 0.26 * amp);
  glowDot(ctx, x, y, r * 1.5, '150,200,255', 0.55 * amp);
  glowDot(ctx, x, y, r * 0.7, '235,245,255', 0.9 * amp);

  // chaotic branching bolts
  for (let i = 0; i < 7; i++) {
    const seed = (e.seed ?? 1) * 977 + i * 31 + frame * 13;
    const a = hash2(seed, 1) * TAU;
    const len = r * (1.5 + hash2(seed, 2) * 2.4);
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    ctx.strokeStyle = `rgba(190,225,255,${(0.85 * amp) * (0.5 + hash2(seed, 3) * 0.5)})`;
    ctx.lineWidth = 1.6 + hash2(seed, 4) * 1.4;
    jagged(ctx, x, y, ex, ey, seed, len * 0.45, 3);
    ctx.stroke();
    // white-hot core
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * amp})`;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  // arcs crawling over the arm
  if (e.arm) {
    const { x: ax, y: ay } = e.arm;
    for (let i = 0; i < 3; i++) {
      const seed = (e.seed ?? 1) * 613 + i * 7 + frame * 5;
      ctx.strokeStyle = `rgba(170,215,255,${0.6 * amp})`;
      ctx.lineWidth = 1.4;
      jagged(ctx, x, y, ax + (hash2(seed, 9) - 0.5) * 14, ay + (hash2(seed, 8) - 0.5) * 14, seed, 12, 2);
      ctx.stroke();
    }
  }
  ctx.restore();
};

// Impact flash: star-shaped additive burst + core.
FX.impact = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 0.34;
  if (age < 0 || age > dur) return;
  const u = clamp01(age / dur);
  const s = (e.size ?? 40) * ease.outExpo(u);
  const a = (1 - u) ** 1.4;
  const col = e.col || '255,245,220';
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(e.x, e.y);
  ctx.rotate(e.rot ?? 0);
  // tapered energy spikes (wide at the core, pointed at the tip)
  const spikes = e.spikes ?? 9;
  for (let i = 0; i < spikes; i++) {
    const ang = (i / spikes) * TAU + (hash2(e.seed, i) - 0.5) * 0.42;
    const len = s * (0.45 + hash2(e.seed, i + 40) * 0.85);
    const w = (s * 0.10 + hash2(e.seed, i + 80) * s * 0.07) * (1 - u * 0.4);
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang - 0.32) * s * 0.14, Math.sin(ang - 0.32) * s * 0.14);
    ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
    ctx.lineTo(Math.cos(ang + 0.32) * s * 0.14, Math.sin(ang + 0.32) * s * 0.14);
    ctx.closePath();
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, len);
    grd.addColorStop(0, `rgba(${col},${a * 0.95})`);
    grd.addColorStop(0.6, `rgba(${col},${a * 0.35})`);
    grd.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = grd;
    ctx.fill();
  }
  glowDot(ctx, 0, 0, s * 0.9, col, a * 0.85);
  glowDot(ctx, 0, 0, s * 0.45, '255,255,255', a);
  ctx.restore();
};

// Kunai projectile (with spin + trail).
FX.kunai = (ctx, view, e, t) => {
  const age = t - e.t;
  if (age < 0) return;
  const u = clamp01(age / (e.life ?? 0.8));
  if (u >= 1) return;
  const p = e.path(age);
  const ang = e.ang ?? Math.atan2(p.vy || 0, p.vx || 1);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  // trail
  ctx.globalCompositeOperation = 'lighter';
  const grad = ctx.createLinearGradient(-46, 0, 0, 0);
  grad.addColorStop(0, 'rgba(140,170,220,0)');
  grad.addColorStop(1, 'rgba(190,215,255,0.5)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-46, -1.6);
  ctx.lineTo(0, -3.4);
  ctx.lineTo(0, 3.4);
  ctx.lineTo(-46, 1.6);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // body
  ctx.beginPath();
  ctx.moveTo(11, 0);
  ctx.lineTo(-2, -3.6);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-2, 3.6);
  ctx.closePath();
  ctx.fillStyle = '#c8d4e2';
  ctx.fill();
  ctx.strokeStyle = '#3a4454';
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.fillStyle = '#31384a';
  ctx.fillRect(-11, -1.7, 7, 3.4);
  ctx.beginPath();
  ctx.arc(-12, 0, 2.6, 0, TAU);
  ctx.strokeStyle = '#8b95a6';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
};

// Chakra smoke / clone puff.
FX.puff = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 0.75;
  if (age < 0 || age > dur) return;
  const u = age / dur;
  ctx.save();
  const n = e.n ?? 14;
  for (let i = 0; i < n; i++) {
    const a1 = hash2(e.seed, i), a2 = hash2(e.seed, i + 50);
    const ang = a1 * TAU;
    const spd = (90 + a2 * 90) * (e.power ?? 1);
    const k = (1 - Math.exp(-4 * age)) / 4;
    const x = e.x + Math.cos(ang) * spd * k;
    const y = e.y + Math.sin(ang) * spd * k * 0.7 - age * 26;
    const r = (10 + a2 * 22) * (e.power ?? 1) * (0.4 + u * 1.6);
    const a = (1 - u) ** 1.5 * 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(230,240,255,${a})`);
    g.addColorStop(1, 'rgba(200,225,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

// Speed lines / motion streak (drawn in screen space by the stage, but authored
// in world coordinates here so they track the camera).
FX.streak = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 0.45;
  if (age < 0 || age > dur) return;
  const u = age / dur;
  const a = (1 - u) * (e.alpha ?? 0.5);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `rgba(${e.col || '200,225,255'},${a})`;
  const n = e.n ?? 12;
  for (let i = 0; i < n; i++) {
    const a1 = hash2(e.seed, i), a2 = hash2(e.seed, i + 30);
    const ox = (a1 - 0.5) * (e.h ?? 130);
    const oy = (a2 - 0.5) * (e.h ?? 130);
    const len = (e.len ?? 90) * (0.5 + a1);
    ctx.lineWidth = 0.8 + a2 * 1.8;
    ctx.beginPath();
    ctx.moveTo(e.x + ox, e.y + oy);
    ctx.lineTo(e.x + ox - len * (e.dx ?? 1), e.y + oy - len * (e.dy ?? 0));
    ctx.stroke();
  }
  ctx.restore();
};

// Water/debris chunks that arc out of the ground.
FX.debris = (ctx, view, e, t) => {
  const age = t - e.t;
  const dur = e.dur ?? 1.6;
  if (age < 0 || age > dur) return;
  const u = age / dur;
  ctx.save();
  const n = e.n ?? 10;
  for (let i = 0; i < n; i++) {
    const a1 = hash2(e.seed, i), a2 = hash2(e.seed, i + 40), a3 = hash2(e.seed, i + 80);
    const ang = -Math.PI / 2 + (a1 - 0.5) * 2.0;
    const spd = (70 + a2 * 150) * (e.power ?? 1);
    const g = 420;
    const x = e.x + Math.cos(ang) * spd * age;
    const y = e.y + Math.sin(ang) * spd * age + 0.5 * g * age * age;
    if (y > (e.groundY ?? 0) + 2) continue;
    const s = (2.2 + a3 * 7) * (e.power ?? 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(age * (1.4 + a3 * 5) + a1 * TAU);
    // irregular rock chunk with a lit facet
    ctx.beginPath();
    const verts = 5;
    for (let k = 0; k <= verts; k++) {
      const a = (k / verts) * TAU;
      const rr = s * (0.62 + hash2(e.seed + i * 13, k) * 0.6);
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr * 0.82;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const shade = 34 + Math.floor(a3 * 26);
    ctx.fillStyle = `rgba(${shade + 12},${shade + 8},${shade},${0.97 * (1 - u * 0.25)})`;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, -s * 0.35);
    ctx.lineTo(s * 0.1, -s * 0.55);
    ctx.lineTo(s * 0.45, s * 0.1);
    ctx.lineTo(-s * 0.2, s * 0.2);
    ctx.closePath();
    ctx.fillStyle = `rgba(${shade + 62},${shade + 56},${shade + 44},${0.5 * (1 - u * 0.3)})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(12,11,10,0.75)';
    ctx.lineWidth = Math.max(0.5, s * 0.09);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
};

// Energy collision core (final clash).
FX.collision = (ctx, view, e, t) => {
  const age = t - e.t;
  if (age < 0) return;
  const ramp = clamp01(age / (e.ramp ?? 1.2));
  const x = e.x, y = e.y;
  const R = (e.size ?? 60) * (0.3 + ramp * 0.9);
  const frame = Math.floor(t * 26);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // big soft bloom
  glowDot(ctx, x, y, R * 5.5, '255,170,80', 0.16 * ramp);
  glowDot(ctx, x, y, R * 3.0, '255,210,140', 0.26 * ramp);
  glowDot(ctx, x, y, R * 1.7, '255,245,220', 0.55 * ramp);
  glowDot(ctx, x, y, R * 0.9, '255,255,255', 0.95);
  // paired energy arcs (orange vs blue)
  for (let side = 0; side < 2; side++) {
    const col = side ? '150,200,255' : '255,160,60';
    const dir = side ? 1 : -1;
    for (let i = 0; i < 9; i++) {
      const seed = (e.seed ?? 3) * 91 + side * 17 + i * 7 + frame * 3;
      const a0 = -Math.PI / 2 + (i / 9) * TAU + noise1(t * 3 + i, 4 + side) * 0.5;
      const r0 = R * (0.4 + hash2(seed, 1) * 0.4);
      const r1 = R * (1.4 + hash2(seed, 2) * 1.9);
      ctx.strokeStyle = `rgba(${col},${(0.55 + hash2(seed, 3) * 0.4) * ramp})`;
      ctx.lineWidth = 1.6 + hash2(seed, 4) * 2.2;
      jagged(ctx, x + Math.cos(a0 + dir * 0.5) * r0, y + Math.sin(a0) * r0,
        x + Math.cos(a0 + dir * 0.3) * r1, y + Math.sin(a0) * r1, seed, r1 * 0.3, 3);
      ctx.stroke();
    }
  }
  // rotating arcs of colliding force
  ctx.translate(x, y);
  for (let i = 0; i < 4; i++) {
    ctx.rotate(age * 0.9);
    ctx.strokeStyle = `rgba(255,240,210,${0.3 * ramp})`;
    ctx.lineWidth = R * 0.06;
    ctx.beginPath();
    ctx.ellipse(0, 0, R * (1.3 + i * 0.28), R * (0.26 + i * 0.05), i * 0.9, 0, Math.PI * 1.4);
    ctx.stroke();
  }
  ctx.restore();
};

export function renderFx(events, ctx, view, t) {
  for (const e of events) {
    const fn = FX[e.kind];
    if (fn) fn(ctx, view, e, t);
  }
}

// Largest active light source — used to drive the global colour wash and the
// rim lighting on characters so effects actually illuminate the scene.
export function activeLight(events, t) {
  let best = null, bestScore = 0;
  for (const e of events) {
    if (!e.light) continue;
    const age = t - e.t;
    if (age < 0) continue;
    const dur = e.lightDur ?? 1.4;
    if (age > dur) continue;
    const u = age / dur;
    const env = Math.min(1, age / (e.lightRamp ?? 0.12)) * Math.exp(-u * 2.2);
    const score = env * (e.lightPower ?? 1);
    if (score > bestScore) {
      bestScore = score;
      best = { ...e, env, score };
    }
  }
  return best;
}

export { FX, glowDot, ring, jagged };

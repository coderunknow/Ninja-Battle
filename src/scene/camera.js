// Cinematic camera + world/screen projection.
//
// World units: 1 unit = 1 px at zoom 1 with a 1080p-tall viewport. The ground is
// y = 0, +y is down, characters stand around y = 0..-200.
//
// The camera is defined *purely* by timeline state (position, zoom, rotation,
// shake phase, roll) so any timestamp reconstructs exactly the same framing.

import { clamp, clamp01, lerp, TAU, noise1, fbm1, ease } from '../core/math.js';

export class View {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.zoom = 1;
    this.cx = 0;      // world x at screen centre
    this.cy = -100;   // world y at screen centre
    this.roll = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeR = 0;
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
  }

  // Camera "unit scale": how many pixels one world unit maps to at zoom 1.
  // 1080p -> 1.0; smaller windows shrink the world instead of cropping it.
  get unit() {
    return clamp(Math.min(this.h / 1080, this.w / 1920) * 1.45, 0.25, 3);
  }

  get scale() {
    return this.unit * this.zoom;
  }

  apply(ctx) {
    const s = this.scale;
    const w2 = this.w / 2, h2 = this.h / 2;
    ctx.translate(w2, h2);
    if (this.roll) ctx.rotate(this.roll);
    ctx.scale(s, s);
    ctx.translate(-this.cx + this.shakeX, -this.cy + this.shakeY);
  }

  toScreenX(wx) {
    const s = this.scale;
    return this.w / 2 + (wx - this.cx + this.shakeX) * s;
  }

  toScreenY(wy) {
    const s = this.scale;
    return this.h / 2 + (wy - this.cy + this.shakeY) * s;
  }

  fromScreen(sx, sy) {
    const s = this.scale;
    return { x: (sx - this.w / 2) / s + this.cx, y: (sy - this.h / 2) / s + this.cy };
  }

  // Parallax helper: returns a horizontal offset (world px) for a distant layer.
  parallaxOffset(k) {
    return this.cx * k;
  }

  set(c) {
    this.zoom = c.zoom;
    this.cx = c.x;
    this.cy = c.y;
    this.roll = c.roll || 0;
    const sk = c.shake || 0;
    const ph = c.shakePhase || 0;
    this.shakeX = sk * fbm1(ph * 1.7, 3, 2) * 0.9;
    this.shakeY = sk * fbm1(ph * 1.9 + 30, 5, 2) * 0.7;
    this.shakeR = sk * 0.0006 * fbm1(ph * 1.3 + 60, 8, 2);
  }
}

// ---------------------------------------------------------------------------
// Camera keyframe evaluation
// ---------------------------------------------------------------------------
// A camera "move" is a list of keyframes:
//   { t, x, y, zoom, roll?, shake?, ease?, hold? }
// With `push` enabled the move also produces a tiny continuous drift so no shot
// is ever perfectly static.

// Frame both fighters: returns the zoom that just fits `separation` world units
// with the given margin, given the viewport width in world units.
export function fitZoom(view, separation, margin = 1.5) {
  const worldW = view.w / view.unit;   // world units visible at zoom 1
  return clamp(worldW / Math.max(60, separation * margin), 0.25, 2.4);
}

export function sampleCamera(moves, t) {
  // find the active move
  let mv = moves[0];
  for (let i = 0; i < moves.length; i++) {
    if (t >= moves[i].t) mv = moves[i];
  }
  const keys = mv.keys;
  return evalKeys(keys, mv, t);
}

function keyPose(k) {
  return {
    x: k.x ?? 0, y: k.y ?? -100, zoom: k.zoom ?? 1, roll: k.roll ?? 0, shake: k.shake ?? 0,
  };
}

export function evalKeys(keys, mv, t) {
  let a = keyPose(keys[0]), b = keyPose(keys[0]);
  let u = 0, eased = 0;
  if (t >= keys[keys.length - 1].t) {
    a = b = keyPose(keys[keys.length - 1]);
    u = 1; eased = 1;
  } else if (t <= keys[0].t) {
    u = 0; eased = 0;
  } else {
    for (let i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i].t && t <= keys[i + 1].t) {
        a = keyPose(keys[i]);
        b = keyPose(keys[i + 1]);
        u = (t - keys[i].t) / Math.max(1e-6, keys[i + 1].t - keys[i].t);
        eased = (ease[keys[i + 1].ease] || ease.inOutCubic)(u);
        break;
      }
    }
  }
  const out = {
    x: lerp(a.x, b.x, eased),
    y: lerp(a.y, b.y, eased),
    zoom: lerp(a.zoom, b.zoom, eased),
    roll: lerp(a.roll, b.roll, eased),
    shake: lerp(a.shake, b.shake, eased),
  };
  // continuous hand-held drift (never dead still)
  const push = mv.push ?? 0.35;
  out.x += noise1(t * 0.21, 11) * push;
  out.y += noise1(t * 0.17, 23) * push * 0.7;
  out.zoom *= 1 + noise1(t * 0.13, 31) * 0.006 * (mv.breath ?? 1);
  out.roll += noise1(t * 0.11, 41) * 0.0012;
  out.shakePhase = t;
  return out;
}

// Impact shake: impulse envelopes are declared by choreography events and summed
// here so overlapping hits read as one heavier shake rather than a double jolt.
export function shakeFromEvents(events, t) {
  let s = 0;
  for (const e of events) {
    if (t < e.t || t > e.t + (e.dur ?? 0.5)) continue;
    const u = (t - e.t) / (e.dur ?? 0.5);
    s += (e.amp ?? 6) * Math.exp(-u * 5.2) * (1 - u);
  }
  return s;
}

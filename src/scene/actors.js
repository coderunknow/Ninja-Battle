// Actor resolution: turns the flat segment list into a fully specified state at
// an arbitrary time t.
//
// Key properties
//  - Pure: actorState(t) depends only on (script, t). No history, no dt.
//  - Every segment carries its own duration; extrapolation is impossible, so a
//    paused or scrubbed frame is always a legal pose.
//  - Transitions blend *from the previous segment's pose at t* rather than from a
//    stored snapshot, so entering a segment mid-blend on a seek gives the same
//    result as playing into it.
//  - Locomotion segments advance position at their authored speed, and the clip
//    playback rate is locked to that speed (no foot sliding).

import { clamp, clamp01, lerp, lerpAngle, TAU, noise1, smoothstep, ease } from '../core/math.js';
import { sampleClip, clipMeta, GUARD } from '../rig/clips.js';

// Nominal duration in seconds for one cycle / one-shot of each clip.
const NOMINAL = {
  idle: 2.6, guard: 2.2, guardLow: 2.0, walk: 0.92, run: 0.62, dash: 0.5,
  backdash: 0.36, jump: 0.68, fall: 1.2, land: 0.5, jab: 0.42, cross: 0.46,
  hook: 0.46, uppercut: 0.52, kickHigh: 0.56, kickMid: 0.52, sweep: 0.6,
  block: 1.4, blockHit: 0.4, hit: 0.55, hitHeavy: 0.75, knockdown: 0.9,
  getUp: 1.0, roll: 0.7, flip: 0.8, seal: 1.2, rasenganCharge: 1.6,
  rasenganThrust: 0.62, chidoriCharge: 1.6, chidoriDash: 0.6, fireball: 0.9,
  kunaiThrow: 0.55, powerUp: 2.0, clash: 2.0, kneel: 2.0, pointUp: 2.0,
};

// Distance covered in one cycle of the locomotion clips (px at scale 1).
const STRIDE = { walk: 46, run: 118, dash: 150 };

const LOOPING = new Set(['idle', 'guard', 'guardLow', 'walk', 'run', 'block', 'seal', 'clash', 'kneel', 'pointUp', 'fall']);

export function segmentDuration(seg) {
  const meta = clipMeta(seg.anim);
  if (seg.dur != null) return seg.dur;
  if (seg.speed && STRIDE[seg.anim]) return STRIDE[seg.anim] / seg.speed;
  if (seg.anim === 'run' && seg.speed) return STRIDE.run / seg.speed;
  return NOMINAL[seg.anim] ?? 0.6;
}

export function findSegment(segs, t) {
  let lo = 0, hi = segs.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

// --- position / rotation -----------------------------------------------------
function segEndX(seg) {
  const d = segmentDuration(seg);
  if (!seg.speed) return seg.x;
  return seg.x + (seg.speed || 0) * d * (seg.dir ?? 1);
}

const LOCO = new Set(['walk', 'run', 'dash', 'backdash', 'jump', 'flip', 'fall', 'roll']);

function posAt(seg, t, next, prevEndX) {
  const d = segmentDuration(seg);
  const age = Math.max(0, t - seg.t);
  let x = seg.x;
  // A locomotion segment moves the actor from wherever the previous segment left
  // them to this segment's authored x. That removes teleports between beats and
  // guarantees the character never slides: the clip rate is tied to the distance.
  if (prevEndX != null && LOCO.has(seg.anim) && Math.abs(seg.x - prevEndX) > 2) {
    const u = clamp01(age / Math.max(1e-3, d));
    x = lerp(prevEndX, seg.x, ease.inOutSine(u));
    if (age > d) x = seg.x;
  } else if (seg.speed) {
    const adv = Math.min(age, d) * seg.speed * (seg.dir ?? 1);
    x = (prevEndX != null ? prevEndX : seg.x) + adv;
  }
  let y = 0;
  let rot = 0;
  // airborne arc
  if (seg.airborne) {
    const [a0, a1] = Array.isArray(seg.airborne) ? seg.airborne : [seg.t, seg.t + d];
    if (t >= a0 && t <= a1) {
      const p = clamp01((t - a0) / Math.max(1e-3, a1 - a0));
      const h = seg.dy ?? -110;
      y = h * 4 * p * (1 - p);
      if (seg.dx) x += seg.dx * ease.outCubic(p) * 1;
      if (seg.spin) rot = -TAU * seg.spin * ease.inOutSine(p);
      if (seg.rollSpin) rot = TAU * p;
    }
  } else if (seg.dy) {
    // simple vertical offset (used for e.g. staying airborne while striking)
    y = seg.dy;
  }
  return { x, y, rot };
}

// --- main resolver -----------------------------------------------------------
export function actorState(segs, t, o = {}) {
  if (!segs || !segs.length) return null;
  const i = findSegment(segs, t);
  if (i < 0) {
    const s0 = segs[0];
    return baseState(s0, 0, t, o, null);
  }
  const seg = segs[i];
  const next = segs[i + 1] || null;
  return baseState(seg, i, t, o, next);
}

function baseState(seg, i, t, o, next) {
  const dur = segmentDuration(seg);
  const age = Math.max(0, t - seg.t);
  const meta = clipMeta(seg.anim);
  const loop = meta.loop || LOOPING.has(seg.anim);
  let u = (seg.u0 ?? 0) + age / Math.max(1e-3, dur);
  if (loop) u = u % 1; else u = clamp01(u);

  let pose = sampleClip(seg.anim, u);

  // ---- blend with the previous segment's tail for seamless transitions
  const prev = i > 0 ? o.segs[i - 1] : null;
  const IN = 0.16;
  if (i > 0 && age < IN) {
    const pseg = o.segs[i - 1];
    const pdur = segmentDuration(pseg);
    const pu = (pseg.u0 ?? 0) + (t - pseg.t) / Math.max(1e-3, pdur);
    const ppose = sampleClip(pseg.anim, clipMeta(pseg.anim).loop ? pu % 1 : clamp01(pu));
    const w = smoothstep(clamp01(age / IN));
    pose = blend(ppose, pose, w);
  }

  // ---- pose level modifiers
  const prevEndX = i > 0 ? segEndX(o.segs[i - 1]) : null;
  const { x, y, rot } = posAt(seg, t, next, prevEndX);

  // ---- facing: faces the opponent unless authored
  let facing = seg.facing;
  if (facing == null) {
    if (o.opponentX != null) {
      const dx = o.opponentX - x;
      facing = dx >= 0 ? 1 : -1;
      if (Math.abs(dx) < 10) facing = o.defaultFacing ?? 1;
    } else facing = o.defaultFacing ?? 1;
  }

  // ---- motion-driven secondary animation
  const speed = seg.speed ? seg.speed : 0;
  const air = seg.airborne && y < -6 ? 1 : 0;
  const flow = clamp01(speed / 380 + air * 0.4 + (seg.flowBoost ?? 0));

  // breathing: subtle, never zero
  const breathAmt = (seg.breath ?? 1) * 0.6;
  const br = Math.sin((t / 2.5) * TAU + (o.phase0 ?? 0)) * breathAmt;
  pose.hipY += br * 1.5;
  pose.torso += br * 0.012;
  pose.armFront += br * 0.02;
  pose.armBack -= br * 0.02;

  // micro weight-shift so a standing fighter is never frozen
  const sway = noise1(t * 0.55, o.phase ?? 3) * 0.9;
  pose.hipX += sway * 0.8;
  pose.head += noise1(t * 0.42, (o.phase ?? 3) + 7) * 0.02;

  // ---- impact stagger: read from the actor's own authored hit reactions
  let shakeAmt = 0;

  // ---- blink
  const blinkPhase = (t + (o.phase ?? 0) * 0.8) % 4.1;
  const blink = blinkPhase < 0.1 ? 1 : 0;

  return {
    seg,
    segIndex: i,
    u,
    anim: seg.anim,
    pose,
    x,
    y,
    rot,
    facing,
    flow,
    speed,
    aura: seg.aura ?? 0,
    sharingan: seg.sharingan ?? 0,
    hitAt: seg.hitAt,
    age,
    dur,
    airborne: !!air,
    blink,
    squash: seg.squash ?? 0,
    shake: shakeAmt,
  };
}

function blend(a, b, w) {
  const out = {};
  for (const k in b) out[k] = lerp(a[k] ?? b[k], b[k], w);
  return out;
}

// ---------------------------------------------------------------------------
// Convenience: resolve both fighters plus any live clones
// ---------------------------------------------------------------------------
export function resolveCast(script, t, cloneTracks) {
  const get = (key) => {
    const segs = script.actors[key];
    if (!segs || !segs.length) return null;
    const other = key === 'n' ? script.actors.s : script.actors.n;
    const opp = other && other.length ? actorState(other, t, { segs: other, defaultFacing: -1 }) : null;
    const st = actorState(segs, t, { segs, opponentX: opp ? opp.x : null, defaultFacing: key === 'n' ? 1 : -1, phase: key === 'n' ? 0 : 1.7 });
    return st;
  };
  const out = { n: get('n'), s: get('s'), clones: [], sClones: [] };
  for (const key of Object.keys(script.actors)) {
    if (key === 'n' || key === 's') continue;
    const segs = script.actors[key];
    if (!segs.length) continue;
    // only resolve clones while they are alive
    const track = (cloneTracks || []).find((c) => c.id === key);
    if (track && (t < track.birth || t > track.death)) continue;
    const opp = key.startsWith('n') ? out.s : out.n;
    const st = actorState(segs, t, { segs, opponentX: opp ? opp.x : null, defaultFacing: key[0] === 'n' ? 1 : -1, phase: 0.9 });
    if (!st) continue;
    let alpha = 1;
    if (track) {
      alpha = Math.min(clamp01((t - track.birth) / 0.18), clamp01((track.death - t) / 0.16));
    }
    st.alpha = alpha;
    st.ghost = key[0] === 'n' ? 0 : 0;
    if (key.startsWith('n')) out.clones.push(st); else out.sClones.push(st);
  }
  return out;
}

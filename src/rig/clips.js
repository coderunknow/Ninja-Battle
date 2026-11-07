// Pose clip library.
//
// A "clip" is a short hand-authored animation described by key poses. Each entry
// is [u, poseOverrides, easingIntoTThisKey]. Clips are sampled by normalised local
// time u in [0,1]. Because clips are pure functions of u, any point in the battle
// can be reconstructed instantly for seeking.
//
// Conventions (see skeleton.js):
//   torso  +forward lean      head  +nod forward
//   armFront +swing forward   armFrontElbow -bend (forearm up/forward)
//   legFront +thigh forward   legFrontKnee  +bend
//   hipY   -crouch (px, relative to standing hip height)

import { clamp01, ease, lerp } from '../core/math.js';

// Pass 0 = back view shoulder width squash, etc. kept minimal.
const NEUTRAL = {
  hipY: -6, hipX: 0, torso: 0.06, torsoTwist: 0, head: 0, headX: 0, headY: 0,
  armFront: 0.18, armFrontElbow: -0.35,
  armBack: -0.16, armBackElbow: -0.28,
  legFront: 0.14, legFrontKnee: 0.2,
  legBack: -0.16, legBackKnee: 0.16,
  handFront: 0, handBack: 0, gripFront: 1, gripBack: 1,
  propT: 0, glow: 0, scream: 0,
};

// Neutral standing pose (rest of the numbers come from NEUTRAL)
export const P = (o = {}) => ({ ...NEUTRAL, ...o });

// Stance presets
const GUARD = P({
  hipY: -12, hipX: 2, torso: 0.16, head: -0.02,
  armFront: 0.62, armFrontElbow: -1.62,
  armBack: 0.28, armBackElbow: -1.42,
  legFront: 0.42, legFrontKnee: 0.62,
  legBack: -0.5, legBackKnee: 0.3,
  footFront: 0.05, footBack: -0.3,
});
const CROUCH = P({
  hipY: -34, hipX: 0, torso: 0.34, head: -0.14,
  armFront: 0.9, armFrontElbow: -1.9,
  armBack: -0.4, armBackElbow: -1.4,
  legFront: 0.86, legFrontKnee: 1.25,
  legBack: -0.42, legBackKnee: 1.0,
  footFront: 0.2, footBack: -0.5,
});
const LUNGE = P({
  hipY: -22, hipX: 8, torso: 0.42, head: -0.12,
  armFront: 1.3, armFrontElbow: -0.6,
  armBack: -0.9, armBackElbow: -1.0,
  legFront: 0.95, legFrontKnee: 0.72,
  legBack: -1.0, legBackKnee: 0.22,
  footFront: 0.1, footBack: -0.55,
});
const AIR = P({
  hipY: -18, torso: 0.12,
  armFront: 0.9, armFrontElbow: -1.1,
  armBack: -0.7, armBackElbow: -1.2,
  legFront: 0.7, legFrontKnee: 1.1,
  legBack: -0.5, legBackKnee: 1.3,
});

// ---------------------------------------------------------------------------
// Keyed pose sampler
// ---------------------------------------------------------------------------
// keys: [u, pose, easeName?, extraHold?]
function keyed(keys, u) {
  u = clamp01(u);
  if (u <= keys[0][0]) return { ...keys[0][1] };
  const last = keys[keys.length - 1];
  if (u >= last[0]) return { ...last[1] };
  for (let i = 0; i < keys.length - 1; i++) {
    const [u0, p0] = keys[i];
    const [u1, p1, ez] = keys[i + 1];
    if (u >= u0 && u <= u1) {
      const raw = (u - u0) / Math.max(1e-6, u1 - u0);
      const t = (ease[ez] || ease.inOutSine)(raw);
      const out = {};
      for (const k in p0) out[k] = lerp(p0[k], p1[k] ?? p0[k], t);
      return out;
    }
  }
  return { ...last[1] };
}

// ---------------------------------------------------------------------------
// Clip definitions
// ---------------------------------------------------------------------------
export const CLIPS = {};

const def = (name, keys, meta = {}) => {
  CLIPS[name] = { keys, ...meta };
  return CLIPS[name];
};

// --- basic states -----------------------------------------------------------
def('idle', [[0, P({ hipY: -8, torso: 0.08, armFront: 0.2, armFrontElbow: -0.55, armBack: -0.2, armBackElbow: -0.5, legFront: 0.16, legFrontKnee: 0.24, legBack: -0.18, legBackKnee: 0.2 })]], { loop: true });

def('guard', [[0, GUARD]], { loop: true });
def('guardLow', [[0, { ...GUARD, hipY: -20, torso: 0.3, armFront: 0.8, armFrontElbow: -1.9, armBack: 0.3, armBackElbow: -1.9 }]], { loop: true });

def('run', [
  [0.0, P({ hipY: -14, hipX: 4, torso: 0.42, head: -0.2, armFront: -0.9, armFrontElbow: -1.5, armBack: 1.0, armBackElbow: -0.9, legFront: 1.0, legFrontKnee: 0.5, legBack: -0.85, legBackKnee: 1.25, footFront: 0.1, footBack: -0.6 })],
  [0.25, P({ hipY: -4, hipX: 2, torso: 0.4, head: -0.16, armFront: -0.2, armFrontElbow: -1.7, armBack: 0.2, armBackElbow: -1.2, legFront: 0.3, legFrontKnee: 1.15, legBack: -0.15, legBackKnee: 0.9, footFront: 0.3, footBack: -0.2 })],
  [0.5, P({ hipY: -14, hipX: 4, torso: 0.42, head: -0.2, armFront: 1.0, armFrontElbow: -0.9, armBack: -0.9, armBackElbow: -1.5, legFront: -0.85, legFrontKnee: 1.25, legBack: 1.0, legBackKnee: 0.5, footFront: -0.6, footBack: 0.1 })],
  [0.75, P({ hipY: -4, hipX: 2, torso: 0.4, head: -0.16, armFront: 0.2, armFrontElbow: -1.2, armBack: -0.2, armBackElbow: -1.7, legFront: -0.15, legFrontKnee: 0.9, legBack: 0.3, legBackKnee: 1.15, footFront: -0.2, footBack: 0.3 })],
  [1.0, P({ hipY: -14, hipX: 4, torso: 0.42, head: -0.2, armFront: -0.9, armFrontElbow: -1.5, armBack: 1.0, armBackElbow: -0.9, legFront: 1.0, legFrontKnee: 0.5, legBack: -0.85, legBackKnee: 1.25, footFront: 0.1, footBack: -0.6 })],
], { loop: true });

def('walk', [
  [0.0, P({ hipY: -9, hipX: 2, torso: 0.2, head: -0.06, armFront: -0.5, armFrontElbow: -0.8, armBack: 0.55, armBackElbow: -0.6, legFront: 0.55, legFrontKnee: 0.35, legBack: -0.5, legBackKnee: 0.55, footFront: 0.1, footBack: -0.3 })],
  [0.25, P({ hipY: -6, hipX: 1, torso: 0.18, head: -0.04, armFront: -0.15, armFrontElbow: -0.9, armBack: 0.15, armBackElbow: -0.8, legFront: 0.2, legFrontKnee: 0.7, legBack: -0.15, legBackKnee: 0.3, footFront: 0.3, footBack: -0.1 })],
  [0.5, P({ hipY: -9, hipX: 2, torso: 0.2, head: -0.06, armFront: 0.55, armFrontElbow: -0.6, armBack: -0.5, armBackElbow: -0.8, legFront: -0.5, legFrontKnee: 0.55, legBack: 0.55, legBackKnee: 0.35, footFront: -0.3, footBack: 0.1 })],
  [0.75, P({ hipY: -6, hipX: 1, torso: 0.18, head: -0.04, armFront: 0.15, armFrontElbow: -0.8, armBack: -0.15, armBackElbow: -0.9, legFront: -0.15, legFrontKnee: 0.3, legBack: 0.2, legBackKnee: 0.7, footFront: -0.1, footBack: 0.3 })],
  [1.0, P({ hipY: -9, hipX: 2, torso: 0.2, head: -0.06, armFront: -0.5, armFrontElbow: -0.8, armBack: 0.55, armBackElbow: -0.6, legFront: 0.55, legFrontKnee: 0.35, legBack: -0.5, legBackKnee: 0.55, footFront: 0.1, footBack: -0.3 })],
], { loop: true });

def('dash', [
  [0.0, P({ hipY: -14, torso: 0.3, armFront: -0.6, armFrontElbow: -1.0, armBack: -0.5, armBackElbow: -1.0, legFront: 0.7, legFrontKnee: 0.9, legBack: -0.6, legBackKnee: 0.7 })],
  [0.2, P({ hipY: -18, torso: 0.55, head: -0.25, armFront: -1.5, armFrontElbow: -0.5, armBack: -1.4, armBackElbow: -0.7, legFront: 1.4, legFrontKnee: 0.4, legBack: -1.2, legBackKnee: 0.5, footFront: 0.3, footBack: -0.7 })],
  [0.7, P({ hipY: -20, torso: 0.6, head: -0.3, armFront: -1.7, armFrontElbow: -0.45, armBack: -1.55, armBackElbow: -0.6, legFront: 0.9, legFrontKnee: 1.2, legBack: -0.9, legBackKnee: 0.6, footFront: 0.2, footBack: -0.6 })],
  [1.0, P({ hipY: -16, torso: 0.4, armFront: -0.7, armFrontElbow: -1.0, armBack: -0.6, armBackElbow: -1.0, legFront: 0.8, legFrontKnee: 0.8, legBack: -0.7, legBackKnee: 0.6 })],
], { loop: false });

def('backdash', [
  [0.0, GUARD],
  [0.22, P({ hipY: -16, torso: -0.1, head: 0.1, armFront: 0.4, armFrontElbow: -1.1, armBack: 0.1, armBackElbow: -1.1, legFront: -0.5, legFrontKnee: 0.9, legBack: 0.6, legBackKnee: 1.0 })],
  [0.6, P({ hipY: -6, torso: -0.24, head: 0.12, armFront: 0.9, armFrontElbow: -0.7, armBack: 0.5, armBackElbow: -0.9, legFront: 0.7, legFrontKnee: 0.6, legBack: -0.4, legBackKnee: 0.7 })],
  [1.0, GUARD],
], { loop: false, airborne: [0.15, 0.75] });

def('jump', [
  [0.0, CROUCH],
  [0.22, P({ hipY: -6, torso: 0.1, armFront: -0.3, armFrontElbow: -0.5, armBack: -0.4, armBackElbow: -0.5, legFront: 0.3, legFrontKnee: 0.2, legBack: -0.2, legBackKnee: 0.2, footFront: 0.5, footBack: 0.4 })],
  [0.5, { ...AIR, hipY: -10, legFront: 0.9, legFrontKnee: 0.7, legBack: -0.3, legBackKnee: 1.0, armFront: 0.6, armBack: -0.5 }],
  [1.0, { ...AIR, hipY: -8, legFront: 0.5, legFrontKnee: 1.0, legBack: -0.2, legBackKnee: 1.2 }],
], { loop: false, airborne: [0.2, 1] });

def('fall', [
  [0.0, { ...AIR, hipY: -6, armFront: 0.4, armFrontElbow: -0.9, armBack: -0.6, armBackElbow: -0.8, legFront: 0.5, legFrontKnee: 0.8, legBack: -0.3, legBackKnee: 1.0 }],
  [1.0, { ...AIR, hipY: -10, torso: 0.2, armFront: 0.2, armFrontElbow: -1.2, armBack: -0.4, armBackElbow: -1.1, legFront: 0.7, legFrontKnee: 1.2, legBack: -0.4, legBackKnee: 1.3 }],
], { loop: true, airborne: [0, 1] });

def('land', [
  [0.0, { ...AIR, hipY: -16, armFront: 0.5, armFrontElbow: -1.0, armBack: -0.5, armBackElbow: -1.0, legFront: 0.6, legFrontKnee: 1.1, legBack: -0.4, legBackKnee: 1.1 }],
  [0.16, P({ hipY: -40, hipX: 3, torso: 0.5, head: -0.2, armFront: 0.9, armFrontElbow: -1.5, armBack: -0.8, armBackElbow: -1.2, legFront: 0.95, legFrontKnee: 1.55, legBack: -0.7, legBackKnee: 1.3, footFront: 0.3, footBack: -0.4 })],
  [0.5, P({ hipY: -20, hipX: 2, torso: 0.24, head: -0.05, armFront: 0.5, armFrontElbow: -1.2, armBack: -0.4, armBackElbow: -1.1, legFront: 0.6, legFrontKnee: 0.9, legBack: -0.5, legBackKnee: 0.6 })],
  [1.0, GUARD],
], { loop: false });

// --- strikes ----------------------------------------------------------------
def('jab', [
  [0.0, GUARD],
  [0.16, { ...GUARD, hipY: -14, torso: 0.06, armFront: 0.4, armFrontElbow: -1.9, armBack: 0.2, armBackElbow: -1.5 }],
  [0.30, { ...GUARD, hipY: -13, hipX: 5, torso: 0.26, head: -0.08, armFront: 1.44, armFrontElbow: -0.1, armBack: 0.0, armBackElbow: -1.7, legFront: 0.5, legFrontKnee: 0.5 }],
  [0.44, { ...GUARD, hipY: -13, hipX: 5, torso: 0.28, head: -0.08, armFront: 1.5, armFrontElbow: -0.04, armBack: 0.0, armBackElbow: -1.7, legFront: 0.52, legFrontKnee: 0.48 }],
  [0.72, { ...GUARD, hipY: -13, torso: 0.18, armFront: 0.8, armFrontElbow: -1.2 }],
  [1.0, GUARD],
], { loop: false, hit: 0.32 });

def('cross', [
  [0.0, GUARD],
  [0.18, { ...GUARD, hipY: -14, hipX: -4, torso: 0.02, armBack: 0.9, armBackElbow: -2.0, armFront: 0.5, armFrontElbow: -1.8 }],
  [0.34, { ...GUARD, hipY: -12, hipX: 8, torso: 0.34, head: -0.1, armBack: 1.5, armBackElbow: -0.06, armFront: 0.2, armFrontElbow: -2.1, legFront: 0.55, legFrontKnee: 0.45, legBack: -0.7, legBackKnee: 0.2 }],
  [0.48, { ...GUARD, hipY: -12, hipX: 8, torso: 0.36, head: -0.1, armBack: 1.56, armBackElbow: -0.02, armFront: 0.2, armFrontElbow: -2.1, legFront: 0.56, legFrontKnee: 0.44 }],
  [0.74, { ...GUARD, hipY: -13, torso: 0.2, armBack: 0.7, armBackElbow: -1.3 }],
  [1.0, GUARD],
], { loop: false, hit: 0.36 });

def('hook', [
  [0.0, GUARD],
  [0.20, { ...GUARD, hipY: -16, hipX: -5, torso: -0.1, torsoTwist: -0.5, armFront: 0.1, armFrontElbow: -1.5, armBack: -0.2, armBackElbow: -1.9 }],
  [0.36, { ...GUARD, hipY: -12, hipX: 6, torso: 0.22, torsoTwist: 0.55, armFront: 1.1, armFrontElbow: -1.25, armBack: 0.4, armBackElbow: -1.9, legFront: 0.55, legFrontKnee: 0.5 }],
  [0.5, { ...GUARD, hipY: -12, hipX: 7, torso: 0.24, torsoTwist: 0.6, armFront: 1.2, armFrontElbow: -1.15, armBack: 0.4, armBackElbow: -1.9 }],
  [0.76, { ...GUARD, torso: 0.18, torsoTwist: 0.1, armFront: 0.7, armFrontElbow: -1.5 }],
  [1.0, GUARD],
], { loop: false, hit: 0.38 });

def('uppercut', [
  [0.0, GUARD],
  [0.2, { ...CROUCH, hipY: -38, armFront: 0.2, armFrontElbow: -2.1, torsoTwist: -0.3 }],
  [0.36, { ...GUARD, hipY: -6, hipX: 6, torso: 0.05, head: -0.24, armFront: 2.5, armFrontElbow: -0.5, armBack: -0.4, armBackElbow: -1.4, legFront: 0.3, legFrontKnee: 0.18, legBack: -0.5, legBackKnee: 0.5, footFront: -0.2 }],
  [0.52, { ...GUARD, hipY: -8, hipX: 6, torso: 0.02, head: -0.26, armFront: 2.7, armFrontElbow: -0.42, armBack: -0.5, armBackElbow: -1.3, legFront: 0.28, legFrontKnee: 0.2 }],
  [0.8, { ...GUARD, hipY: -14, torso: 0.2, armFront: 1.0, armFrontElbow: -1.3 }],
  [1.0, GUARD],
], { loop: false, hit: 0.4 });

def('kickHigh', [
  [0.0, GUARD],
  [0.2, { ...GUARD, hipY: -16, torso: -0.1, legFront: 0.5, legFrontKnee: 1.0, armFront: 0.3, armFrontElbow: -1.6 }],
  [0.36, P({ hipY: -8, hipX: 4, torso: -0.38, head: 0.1, armFront: 0.1, armFrontElbow: -1.7, armBack: -0.9, armBackElbow: -0.9, legFront: 2.05, legFrontKnee: 0.18, legBack: -0.2, legBackKnee: 0.25, footFront: -0.5, footBack: -0.1 })],
  [0.52, P({ hipY: -6, hipX: 4, torso: -0.42, head: 0.12, armFront: 0.0, armFrontElbow: -1.8, armBack: -1.0, armBackElbow: -0.8, legFront: 2.25, legFrontKnee: 0.1, legBack: -0.25, legBackKnee: 0.2, footFront: -0.6, footBack: -0.1 })],
  [0.8, { ...GUARD, hipY: -14, torso: 0.1, legFront: 0.8, legFrontKnee: 0.9, armFront: 0.5, armFrontElbow: -1.4 }],
  [1.0, GUARD],
], { loop: false, hit: 0.42 });

def('kickMid', [
  [0.0, GUARD],
  [0.18, { ...GUARD, hipY: -20, torso: 0.1, legFront: 0.8, legFrontKnee: 1.4, armFront: 0.5, armFrontElbow: -1.8 }],
  [0.34, P({ hipY: -10, hipX: 2, torso: -0.24, head: 0.06, armFront: 0.2, armFrontElbow: -1.9, armBack: -0.7, armBackElbow: -1.0, legFront: 1.75, legFrontKnee: 0.05, legBack: -0.15, legBackKnee: 0.3, footFront: -0.9, footBack: -0.1 })],
  [0.5, P({ hipY: -9, hipX: 2, torso: -0.26, head: 0.06, armFront: 0.15, armFrontElbow: -1.95, armBack: -0.75, armBackElbow: -0.95, legFront: 1.85, legFrontKnee: 0.02, legBack: -0.15, legBackKnee: 0.28, footFront: -0.95, footBack: -0.1 })],
  [0.78, { ...GUARD, legFront: 0.7, legFrontKnee: 1.0 }],
  [1.0, GUARD],
], { loop: false, hit: 0.4 });

def('sweep', [
  [0.0, GUARD],
  [0.2, { ...CROUCH, hipY: -42, torso: 0.5, armFront: 1.1, armFrontElbow: -1.2 }],
  [0.38, P({ hipY: -46, hipX: 4, torso: 0.55, head: -0.25, armFront: 1.2, armFrontElbow: -0.9, armBack: -1.3, armBackElbow: -0.4, legFront: 1.5, legFrontKnee: 0.05, legBack: -0.5, legBackKnee: 1.9, footFront: 0.3, footBack: -0.6 })],
  [0.55, P({ hipY: -46, hipX: 10, torso: 0.55, head: -0.25, armFront: 1.2, armFrontElbow: -0.9, armBack: -1.3, armBackElbow: -0.4, legFront: 1.7, legFrontKnee: 0.05, legBack: -0.6, legBackKnee: 1.85, footFront: 0.35, footBack: -0.6 })],
  [0.8, { ...CROUCH }],
  [1.0, GUARD],
], { loop: false, hit: 0.45 });

// --- defence ----------------------------------------------------------------
def('block', [
  [0.0, GUARD],
  [0.12, P({ hipY: -16, hipX: -2, torso: 0.1, head: 0.05, armFront: 0.75, armFrontElbow: -2.35, armBack: 0.6, armBackElbow: -2.2, legFront: 0.5, legFrontKnee: 0.8, legBack: -0.6, legBackKnee: 0.5 })],
  [0.3, P({ hipY: -18, hipX: -4, torso: 0.06, head: 0.08, armFront: 0.8, armFrontElbow: -2.45, armBack: 0.65, armBackElbow: -2.3, legFront: 0.55, legFrontKnee: 0.95, legBack: -0.65, legBackKnee: 0.6 })],
  [1.0, P({ hipY: -18, hipX: -2, torso: 0.1, head: 0.04, armFront: 0.78, armFrontElbow: -2.4, armBack: 0.62, armBackElbow: -2.25, legFront: 0.52, legFrontKnee: 0.9, legBack: -0.62, legBackKnee: 0.55 })],
], { loop: true });

def('blockHit', [
  [0.0, P({ hipY: -18, armFront: 0.8, armFrontElbow: -2.45, armBack: 0.65, armBackElbow: -2.3, torso: 0.06, legFront: 0.55, legFrontKnee: 0.95, legBack: -0.65, legBackKnee: 0.6 })],
  [0.12, P({ hipY: -26, hipX: -10, torso: -0.18, head: 0.2, armFront: 1.0, armFrontElbow: -2.6, armBack: 0.85, armBackElbow: -2.4, legFront: 0.75, legFrontKnee: 1.25, legBack: -0.45, legBackKnee: 0.9 })],
  [0.45, P({ hipY: -22, hipX: -6, torso: 0.0, head: 0.1, armFront: 0.85, armFrontElbow: -2.5, armBack: 0.7, armBackElbow: -2.35, legFront: 0.65, legFrontKnee: 1.1, legBack: -0.55, legBackKnee: 0.75 })],
  [1.0, P({ hipY: -18, hipX: -2, armFront: 0.78, armFrontElbow: -2.4, armBack: 0.62, armBackElbow: -2.25, legFront: 0.52, legFrontKnee: 0.9, legBack: -0.62, legBackKnee: 0.55, torso: 0.06 })],
], { loop: false });

def('hit', [
  [0.0, GUARD],
  [0.1, P({ hipY: -14, hipX: -6, torso: -0.3, head: 0.34, armFront: 0.2, armFrontElbow: -0.8, armBack: -0.7, armBackElbow: -0.6, legFront: 0.3, legFrontKnee: 0.5, legBack: -0.5, legBackKnee: 0.4 })],
  [0.34, P({ hipY: -18, hipX: -9, torso: -0.16, head: 0.22, armFront: 0.34, armFrontElbow: -1.0, armBack: -0.5, armBackElbow: -0.8, legFront: 0.45, legFrontKnee: 0.75, legBack: -0.6, legBackKnee: 0.6 })],
  [1.0, GUARD],
], { loop: false });

def('hitHeavy', [
  [0.0, GUARD],
  [0.08, P({ hipY: -12, hipX: -12, torso: -0.55, head: 0.5, armFront: -0.4, armFrontElbow: -0.5, armBack: -1.2, armBackElbow: -0.3, legFront: 0.7, legFrontKnee: 0.3, legBack: -0.9, legBackKnee: 0.2, footFront: -0.3 })],
  [0.3, P({ hipY: -10, hipX: -18, torso: -0.7, head: 0.55, armFront: -0.8, armFrontElbow: -0.35, armBack: -1.5, armBackElbow: -0.2, legFront: 0.9, legFrontKnee: 0.2, legBack: -1.1, legBackKnee: 0.15 })],
  [0.62, P({ hipY: -22, hipX: -14, torso: -0.3, head: 0.3, armFront: 0.0, armFrontElbow: -0.8, armBack: -0.8, armBackElbow: -0.6, legFront: 0.6, legFrontKnee: 0.6, legBack: -0.8, legBackKnee: 0.4 })],
  [1.0, GUARD],
], { loop: false, airborne: [0.0, 0.55] });

def('knockdown', [
  [0.0, P({ hipY: -10, hipX: -14, torso: -0.7, head: 0.5, armFront: -0.9, armFrontElbow: -0.3, armBack: -1.6, armBackElbow: -0.2, legFront: 1.0, legFrontKnee: 0.2, legBack: -1.2, legBackKnee: 0.1 })],
  [0.3, P({ hipY: -50, hipX: -22, torso: -1.2, head: 0.5, armFront: -1.6, armFrontElbow: -0.3, armBack: -2.0, armBackElbow: -0.2, legFront: 1.4, legFrontKnee: 0.5, legBack: -0.6, legBackKnee: 0.8 })],
  [0.55, P({ hipY: -60, hipX: -30, torso: -1.45, head: 0.4, armFront: -1.9, armFrontElbow: -0.25, armBack: -2.2, armBackElbow: -0.2, legFront: 1.7, legFrontKnee: 0.7, legBack: -0.2, legBackKnee: 1.0 })],
  [1.0, P({ hipY: -60, hipX: -30, torso: -1.45, head: 0.4, armFront: -1.9, armFrontElbow: -0.25, armBack: -2.2, armBackElbow: -0.2, legFront: 1.7, legFrontKnee: 0.7, legBack: -0.2, legBackKnee: 1.0 })],
], { loop: false, airborne: [0, 0.5] });

def('getUp', [
  [0.0, P({ hipY: -58, hipX: -20, torso: -1.1, head: 0.3, armFront: -1.0, armFrontElbow: -1.2, armBack: -1.8, armBackElbow: -0.4, legFront: 1.5, legFrontKnee: 0.9, legBack: -0.2, legBackKnee: 1.2 })],
  [0.35, P({ hipY: -50, hipX: -10, torso: -0.6, head: 0.2, armFront: 0.9, armFrontElbow: -1.6, armBack: -0.9, armBackElbow: -0.9, legFront: 1.5, legFrontKnee: 1.7, legBack: -0.8, legBackKnee: 0.5 })],
  [0.7, CROUCH],
  [1.0, GUARD],
], { loop: false });

def('roll', [
  [0.0, CROUCH],
  [0.25, P({ hipY: -50, hipX: 6, torso: 0.9, head: -0.4, armFront: 1.0, armFrontElbow: -2.0, armBack: 0.6, armBackElbow: -2.0, legFront: 1.6, legFrontKnee: 2.1, legBack: 1.5, legBackKnee: 2.0 })],
  [0.55, P({ hipY: -56, hipX: 0, torso: 1.2, head: -0.5, armFront: 0.6, armFrontElbow: -2.4, armBack: 0.5, armBackElbow: -2.4, legFront: 2.0, legFrontKnee: 2.4, legBack: 1.9, legBackKnee: 2.3 })],
  [0.8, CROUCH],
  [1.0, GUARD],
], { loop: false, roll: true });

def('flip', [
  [0.0, GUARD],
  [0.18, CROUCH],
  [0.4, P({ hipY: -14, torso: 1.0, head: -0.3, armFront: 1.6, armFrontElbow: -1.0, armBack: 1.4, armBackElbow: -1.0, legFront: 2.0, legFrontKnee: 2.0, legBack: 1.8, legBackKnee: 2.0 })],
  [0.7, P({ hipY: -14, torso: 0.6, head: -0.2, armFront: 1.0, armFrontElbow: -1.2, armBack: 0.9, armBackElbow: -1.2, legFront: 1.4, legFrontKnee: 1.6, legBack: 1.3, legBackKnee: 1.6 })],
  [1.0, GUARD],
], { loop: false, airborne: [0.15, 0.9], spin: 1 });

// --- ninjutsu ---------------------------------------------------------------
def('seal', [
  [0.0, GUARD],
  [0.2, P({ hipY: -16, torso: 0.05, head: 0.05, armFront: 0.9, armFrontElbow: -2.6, armBack: 0.85, armBackElbow: -2.55, legFront: 0.4, legFrontKnee: 0.7, legBack: -0.5, legBackKnee: 0.45 })],
  [1.0, P({ hipY: -16, torso: 0.05, head: 0.05, armFront: 0.92, armFrontElbow: -2.62, armBack: 0.87, armBackElbow: -2.57, legFront: 0.4, legFrontKnee: 0.7, legBack: -0.5, legBackKnee: 0.45 })],
], { loop: true });

def('rasenganCharge', [
  [0.0, GUARD],
  [0.25, P({ hipY: -22, hipX: -4, torso: 0.1, head: 0.05, armFront: 0.2, armFrontElbow: -2.6, armBack: 0.8, armBackElbow: -2.3, legFront: 0.55, legFrontKnee: 1.0, legBack: -0.7, legBackKnee: 0.6 })],
  [0.65, P({ hipY: -26, hipX: -6, torso: 0.14, head: 0.06, armFront: 0.16, armFrontElbow: -2.7, armBack: 0.9, armBackElbow: -2.25, legFront: 0.6, legFrontKnee: 1.15, legBack: -0.8, legBackKnee: 0.7, glow: 1 })],
  [1.0, P({ hipY: -26, hipX: -6, torso: 0.16, head: 0.05, armFront: 0.18, armFrontElbow: -2.72, armBack: 0.92, armBackElbow: -2.25, legFront: 0.62, legFrontKnee: 1.15, legBack: -0.8, legBackKnee: 0.7, glow: 1 })],
], { loop: false, hold: 0.95 });

def('rasenganThrust', [
  [0.0, P({ hipY: -26, hipX: -6, torso: 0.16, armFront: 0.18, armFrontElbow: -2.72, armBack: 0.92, armBackElbow: -2.25, legFront: 0.62, legFrontKnee: 1.15, legBack: -0.8, legBackKnee: 0.7, glow: 1 })],
  [0.14, P({ hipY: -30, hipX: -10, torso: 0.02, armFront: 0.0, armFrontElbow: -2.8, armBack: 1.1, armBackElbow: -2.3, legFront: 0.7, legFrontKnee: 1.3, legBack: -0.9, legBackKnee: 0.8, glow: 1 })],
  [0.32, P({ hipY: -14, hipX: 14, torso: 0.5, head: -0.15, armFront: 1.52, armFrontElbow: -0.12, armBack: -1.1, armBackElbow: -0.9, legFront: 1.15, legFrontKnee: 0.5, legBack: -1.25, legBackKnee: 0.15, footBack: -0.6, glow: 1 })],
  [0.62, P({ hipY: -14, hipX: 14, torso: 0.52, head: -0.16, armFront: 1.56, armFrontElbow: -0.08, armBack: -1.15, armBackElbow: -0.85, legFront: 1.18, legFrontKnee: 0.48, legBack: -1.28, legBackKnee: 0.12, glow: 1 })],
  [1.0, GUARD],
], { loop: false, hit: 0.34, thrust: true });

def('chidoriCharge', [
  [0.0, GUARD],
  [0.22, P({ hipY: -13, hipX: -4, torso: 0.0, head: 0.06, armFront: -0.9, armFrontElbow: -0.9, armBack: -0.3, armBackElbow: -1.9, legFront: 0.5, legFrontKnee: 0.75, legBack: -0.65, legBackKnee: 0.5 })],
  [0.6, P({ hipY: -12, hipX: -6, torso: -0.06, head: 0.1, armFront: -1.25, armFrontElbow: -0.55, armBack: -0.4, armBackElbow: -1.9, legFront: 0.55, legFrontKnee: 0.8, legBack: -0.7, legBackKnee: 0.5, glow: 1 })],
  [1.0, P({ hipY: -12, hipX: -6, torso: -0.05, head: 0.1, armFront: -1.3, armFrontElbow: -0.5, armBack: -0.45, armBackElbow: -1.9, legFront: 0.56, legFrontKnee: 0.82, legBack: -0.72, legBackKnee: 0.5, glow: 1 })],
], { loop: false, hold: 0.95 });

def('chidoriDash', [
  [0.0, P({ hipY: -12, hipX: -6, torso: -0.05, armFront: -1.3, armFrontElbow: -0.5, armBack: -0.45, armBackElbow: -1.9, legFront: 0.56, legFrontKnee: 0.82, legBack: -0.72, legBackKnee: 0.5, glow: 1 })],
  [0.18, P({ hipY: -18, hipX: -12, torso: 0.1, armFront: -1.7, armFrontElbow: -0.35, armBack: -1.4, armBackElbow: -0.7, legFront: 1.4, legFrontKnee: 0.55, legBack: -1.2, legBackKnee: 0.3, glow: 1 })],
  [0.5, P({ hipY: -20, hipX: 4, torso: 0.5, head: -0.2, armFront: 1.5, armFrontElbow: -0.1, armBack: -1.5, armBackElbow: -0.6, legFront: 1.3, legFrontKnee: 0.6, legBack: -1.3, legBackKnee: 0.25, glow: 1 })],
  [0.8, P({ hipY: -20, hipX: 6, torso: 0.52, head: -0.2, armFront: 1.56, armFrontElbow: -0.06, armBack: -1.5, armBackElbow: -0.6, legFront: 1.32, legFrontKnee: 0.58, legBack: -1.32, legBackKnee: 0.22, glow: 1 })],
  [1.0, GUARD],
], { loop: false, hit: 0.52, thrust: true });

def('fireball', [
  [0.0, GUARD],
  [0.2, P({ hipY: -14, hipX: -3, torso: 0.0, head: 0.06, armFront: 0.85, armFrontElbow: -2.5, armBack: 0.8, armBackElbow: -2.45, legFront: 0.5, legFrontKnee: 0.8, legBack: -0.6, legBackKnee: 0.5 })],
  [0.42, P({ hipY: -16, hipX: 2, torso: 0.34, head: -0.2, armFront: 1.35, armFrontElbow: -0.9, armBack: 0.4, armBackElbow: -2.6, legFront: 0.7, legFrontKnee: 0.7, legBack: -0.7, legBackKnee: 0.4, glow: 1 })],
  [0.62, P({ hipY: -16, hipX: 4, torso: 0.4, head: -0.28, armFront: 1.5, armFrontElbow: -0.5, armBack: 0.3, armBackElbow: -2.7, legFront: 0.75, legFrontKnee: 0.65, legBack: -0.75, legBackKnee: 0.35, glow: 1, scream: 0.4 })],
  [0.85, P({ hipY: -16, hipX: 2, torso: 0.3, head: -0.18, armFront: 1.3, armFrontElbow: -1.0, armBack: 0.4, armBackElbow: -2.5, legFront: 0.7, legFrontKnee: 0.7, legBack: -0.7, legBackKnee: 0.4, glow: 0.6 })],
  [1.0, GUARD],
], { loop: false, emit: 0.55 });

def('kunaiThrow', [
  [0.0, GUARD],
  [0.16, P({ hipY: -14, torso: 0.0, armBack: -1.9, armBackElbow: -1.6, armFront: 0.7, armFrontElbow: -1.9, legBack: -0.7, legBackKnee: 0.6 })],
  [0.3, P({ hipY: -14, torso: 0.36, head: -0.12, armBack: 1.35, armBackElbow: -0.2, armFront: 0.6, armFrontElbow: -1.4, legFront: 0.75, legFrontKnee: 0.55, legBack: -0.85, legBackKnee: 0.2 })],
  [0.36, P({ hipY: -14, torso: 0.4, head: -0.14, armBack: 1.5, armBackElbow: -0.05, armFront: 0.55, armFrontElbow: -1.35, legFront: 0.8, legFrontKnee: 0.5, legBack: -0.9, legBackKnee: 0.18 })],
  [0.7, { ...GUARD, armBack: 0.4, armBackElbow: -1.2 }],
  [1.0, GUARD],
], { loop: false, emit: 0.34, emitHand: 'back' });

def('powerUp', [
  [0.0, GUARD],
  [0.25, CROUCH],
  [0.5, P({ hipY: -6, hipX: 0, torso: -0.28, head: 0.3, armFront: -1.1, armFrontElbow: -0.55, armBack: -1.25, armBackElbow: -0.5, legFront: 0.45, legFrontKnee: 0.16, legBack: -0.45, legBackKnee: 0.16, scream: 1, glow: 1 })],
  [0.8, P({ hipY: -8, hipX: 0, torso: -0.34, head: 0.34, armFront: -1.35, armFrontElbow: -0.4, armBack: -1.5, armBackElbow: -0.35, legFront: 0.5, legFrontKnee: 0.12, legBack: -0.5, legBackKnee: 0.12, scream: 1, glow: 1 })],
  [1.0, P({ hipY: -10, hipX: 0, torso: -0.2, head: 0.2, armFront: -1.0, armFrontElbow: -0.7, armBack: -1.1, armBackElbow: -0.6, legFront: 0.4, legFrontKnee: 0.2, legBack: -0.4, legBackKnee: 0.2, glow: 0.7, scream: 0.3 })],
], { loop: false, aura: true });

def('clash', [
  [0.0, P({ hipY: -20, hipX: 10, torso: 0.44, head: -0.16, armFront: 1.5, armFrontElbow: -0.35, armBack: -0.9, armBackElbow: -1.2, legFront: 1.15, legFrontKnee: 0.65, legBack: -1.1, legBackKnee: 0.3, footBack: -0.5, glow: 1 })],
  [0.5, P({ hipY: -22, hipX: 12, torso: 0.48, head: -0.18, armFront: 1.56, armFrontElbow: -0.25, armBack: -1.0, armBackElbow: -1.15, legFront: 1.25, legFrontKnee: 0.62, legBack: -1.18, legBackKnee: 0.28, footBack: -0.55, glow: 1 })],
  [1.0, P({ hipY: -20, hipX: 10, torso: 0.46, head: -0.17, armFront: 1.53, armFrontElbow: -0.3, armBack: -0.95, armBackElbow: -1.18, legFront: 1.2, legFrontKnee: 0.63, legBack: -1.14, legBackKnee: 0.29, footBack: -0.52, glow: 1 })],
], { loop: true });

def('kneel', [
  [0.0, P({ hipY: -44, hipX: 4, torso: 0.5, head: -0.1, armFront: 0.9, armFrontElbow: -1.9, armBack: -0.6, armBackElbow: -0.9, legFront: 1.5, legFrontKnee: 2.0, legBack: -0.5, legBackKnee: 2.2 })],
  [1.0, P({ hipY: -44, hipX: 4, torso: 0.54, head: -0.12, armFront: 0.92, armFrontElbow: -1.92, armBack: -0.6, armBackElbow: -0.9, legFront: 1.5, legFrontKnee: 2.0, legBack: -0.5, legBackKnee: 2.2 })],
], { loop: true });

def('pointUp', [
  [0.0, P({ hipY: -10, torso: 0.08, armFront: 0.6, armFrontElbow: -1.2, armBack: -0.3, armBackElbow: -0.9, legFront: 0.35, legFrontKnee: 0.5, legBack: -0.4, legBackKnee: 0.3 })],
  [1.0, P({ hipY: -10, torso: 0.08, armFront: 0.65, armFrontElbow: -1.25, armBack: -0.3, armBackElbow: -0.9, legFront: 0.35, legFrontKnee: 0.5, legBack: -0.4, legBackKnee: 0.3 })],
], { loop: true });

// Sample a clip
export function sampleClip(name, u) {
  const c = CLIPS[name] || CLIPS.guard;
  return keyed(c.keys, u);
}

export function clipMeta(name) {
  return CLIPS[name] || CLIPS.guard;
}

export { GUARD, CROUCH, LUNGE, AIR, NEUTRAL };

// Deterministic math helpers. Everything here is pure: same input -> same output.
// The whole production is reconstructed from the timeline, so no Math.random() is
// allowed in state-producing code (only in purely decorative particle seeding,
// which still uses hashed values so that seeking reproduces the same frame).

export const TAU = Math.PI * 2;

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));

export const smoothstep = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// Easing set — deliberately richer than linear so nothing ever feels robotic.
export const ease = {
  linear: (t) => clamp01(t),
  inQuad: (t) => clamp01(t) ** 2,
  outQuad: (t) => 1 - (1 - clamp01(t)) ** 2,
  inOutQuad: (t) => {
    t = clamp01(t);
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  },
  inCubic: (t) => clamp01(t) ** 3,
  outCubic: (t) => 1 - (1 - clamp01(t)) ** 3,
  inOutCubic: (t) => {
    t = clamp01(t);
    return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  },
  outQuart: (t) => 1 - (1 - clamp01(t)) ** 4,
  inQuart: (t) => clamp01(t) ** 4,
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t))),
  inExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * clamp01(t) - 10)),
  inOutSine: (t) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2,
  outSine: (t) => Math.sin((clamp01(t) * Math.PI) / 2),
  outBack: (t, s = 1.70158) => {
    t = clamp01(t);
    const c = s + 1;
    return 1 + c * (t - 1) ** 3 + s * (t - 1) ** 2;
  },
  outElastic: (t) => {
    t = clamp01(t);
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  outBounce: (t) => {
    t = clamp01(t);
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

// --- Deterministic pseudo-random ------------------------------------------------
// Integer hash (xorshift-ish) used for particles, grain, debris placement.
export function hash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return (x >>> 0) / 4294967296;
}
export const hash2 = (a, b) => hash(a * 374761393 + b * 668265263);
export const hash3 = (a, b, c) => hash(a * 374761393 + b * 668265263 + c * 2147483647);

// Signed hash in [-1,1]
export const shash = (n) => hash(n) * 2 - 1;

// Cheap 1D value noise with smooth interpolation; used for wind, camera drift,
// hair flutter, cloth secondary motion.
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(i * 7919 + seed * 104729);
  const b = hash((i + 1) * 7919 + seed * 104729);
  return lerp(a, b, smoothstep(f)) * 2 - 1;
}
export function fbm1(x, seed = 0, oct = 3) {
  let v = 0, amp = 0.5, fr = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += noise1(x * fr, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    fr *= 2.07;
  }
  return v / norm;
}

// Angle helpers
export const wrapAngle = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
export const deg = (d) => (d * Math.PI) / 180;

// Critically damped-ish exponential smoothing that is stable for any dt.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// A short impulse envelope: rises fast, decays slow. u in [0,1] over duration.
export const impulse = (u, attack = 0.12, decay = 2.2) =>
  u <= 0 || u >= 1 ? 0 : (1 - Math.exp(-u / attack)) * Math.exp(-(u - 1) * decay);

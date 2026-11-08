// Rendering quality profiles + a tiny adaptive governor.
//
// `high` is the default on capable hardware. `performance` drops particle
// multipliers, disables film grain and reduces the render resolution scale,
// targeting integrated GPUs (Intel HD 620 class) and high-DPI laptops.
//
// The governor samples frame times and can auto-downgrade once, never oscillating.

export const QUALITY = {
  mode: 'high',        // 'high' | 'performance'
  resolutionScale: 1,  // multiplied into the backing store size
  auto: true,
  set(mode) {
    this.mode = mode;
    const p = PROFILES[mode];
    this.resolutionScale = p.resolutionScale;
    return p;
  },
};

export const PROFILES = {
  high: {
    label: 'High',
    resolutionScale: 1,
    motes: 1,
    pebbles: 150,
    grain: 0.055,
    letterbox: true,
    maxDpr: 2,
    shadowBlur: true,
    description: 'Full particles, film grain, 1:1 pixel density (capped at 2x DPR).',
  },
  performance: {
    label: 'Performance',
    resolutionScale: 0.8,
    motes: 0.45,
    pebbles: 70,
    grain: 0,
    letterbox: true,
    maxDpr: 1.25,
    shadowBlur: false,
    description: 'Reduced particle density, no grain, 0.8x render scale. For integrated graphics.',
  },
};

export class FrameGovernor {
  constructor(opts = {}) {
    this.window = opts.window ?? 90;
    this.targetMs = opts.targetMs ?? 20;  // allow some headroom below 60fps
    this.samples = [];
    this.downgraded = false;
    this.enabled = opts.enabled ?? true;
  }
  push(dtMs) {
    if (!this.enabled) return false;
    this.samples.push(dtMs);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.samples.length < this.window) return false;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    if (avg > this.targetMs && !this.downgraded) {
      this.downgraded = true;
      return true; // caller should downgrade once
    }
    return false;
  }
  get averageMs() {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
}

// Platform shim + offscreen render cache.
//
// The render core must run unchanged in two places: the browser canvas and the
// headless @napi-rs/canvas QA renderer. This module is the only place that knows
// how to allocate an extra canvas.
//
// It also owns the sprite cache that keeps the frame budget flat. Profiling the
// pipeline showed the dominant costs were *not* the character rig or the
// effects, but full-viewport rasterisation: a per-pixel film-grain loop, a
// 4-stop sky gradient, a radial vignette and gradient-filled clouds. Those are
// now baked once into sprites at their exact destination size and blitted 1:1,
// which is roughly 100x cheaper than either re-rasterising them or scaling a
// small sprite up to fill the screen.
//
// Every entry is keyed by content, so rendering stays deterministic: the same
// timeline position always produces the same pixels.

let factory = null;
const CACHE = new Map();
let entryBudget = 96 * 1024 * 1024;   // ~96 MB of cached pixels
let entryBytes = 0;

export function setCanvasFactory(fn) {
  factory = fn;
  CACHE.clear();
  PINNED.clear();
  entryBytes = 0;
}

export function makeCanvas(w, h) {
  const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
  if (factory) return factory(W, H);
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  }
  return null;
}

export function clearCache() {
  CACHE.clear();
  PINNED.clear();
  entryBytes = 0;
}

// Full-viewport sheets live in their own cache that is never evicted: they are
// the most expensive thing to rebuild, and letting transient sprites push them
// out caused re-baking every single frame.
const PINNED = new Map();

export const stats = { hits: 0, misses: 0, keys: [] };
function get(key, build) {
  if (CACHE.has(key)) { stats.hits++; return CACHE.get(key); }
  stats.misses++; if (stats.keys.length < 40) stats.keys.push(key);
  const v = build();
  if (v) {
    const bytes = (v.width || 0) * (v.height || 0) * 4;
    while (entryBytes + bytes > entryBudget && CACHE.size) {
      const k = CACHE.keys().next().value;
      const old = CACHE.get(k);
      entryBytes -= (old.width || 0) * (old.height || 0) * 4;
      CACHE.delete(k);
    }
    CACHE.set(key, v);
    entryBytes += bytes;
  }
  return v;
}

// ---------------------------------------------------------------- film grain
// Bakes a full-viewport speckle sheet. Two variants exist and the caller picks
// one per frame, which reads as animated grain without any per-frame cost.
export function grainSheet(ctx, w, h, variant = 0, density = 0.055) {
  const W = Math.ceil(w), H = Math.ceil(h);
  return get(`grain|${W}x${H}|${variant}|${density}`, () => {
    const cv = makeCanvas(W, H);
    if (!cv) return null;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const d = img.data;
    let s = (variant * 2654435761 + 12345) >>> 0;
    const rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const count = Math.round(W * H * density);
    for (let i = 0; i < count; i++) {
      const o = ((rnd() * W * H) | 0) * 4;
      const bright = rnd() > 0.5;
      const v = bright ? 255 : 0;
      d[o] = v; d[o + 1] = v; d[o + 2] = v;
      d[o + 3] = bright ? 46 : 40;
    }
    c2.putImageData(img, 0, 0);
    return cv;
  });
}

// ---------------------------------------------------------------- vignette
export function vignetteSprite(ctx, w, h, darkness) {
  const W = Math.ceil(w), H = Math.ceil(h);
  const dq = Math.round(darkness * 10) / 10;
  return get(`vig|${W}x${H}|${dq}`, () => {
    const cv = makeCanvas(W, H);
    if (!cv) return null;
    const c2 = cv.getContext('2d');
    const g = c2.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.36, W / 2, H * 0.48, Math.max(W, H) * 0.80);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, `rgba(0,0,0,${dq * 0.35})`);
    g.addColorStop(1, `rgba(0,0,0,${dq})`);
    c2.fillStyle = g;
    c2.fillRect(0, 0, W, H);
    return cv;
  });
}

// ---------------------------------------------------------------- post overlay
// Vignette and grain are baked into a single full-viewport sheet so the post
// pass is one 1:1 blit instead of two (and zero per-pixel work per frame).
// `bakeGrain` bakes speckles into the sheet (normal mode). In performance mode
// the caller passes bakeGrain=false and we cache the clean vignette alone.
export function postOverlay(ctx, w, h, darkness, variant = 0, bakeGrain = true, density = 0.018) {
  // Above ~2.2k pixels wide (e.g. a 4K backing store at 2x DPR) the sheets are
  // baked at half resolution: four full-res 4K grain sheets would cost >130 MB
  // of canvas memory, and the loss on a soft grain/vignette is invisible.
  const half = Math.max(w, h) > 2200;
  const k = half ? 0.5 : 1;
  const W = Math.ceil(w * k), H = Math.ceil(h * k);
  const dq = Math.round(darkness * 20) / 20;
  const key = `post|${W}x${H}|${dq}|${variant}|${bakeGrain ? 1 : 0}`;
  if (PINNED.has(key)) { stats.hits++; return PINNED.get(key); }
  stats.misses++;
  const cv = makeCanvas(W, H);
  if (!cv) return null;
  const c2 = cv.getContext('2d');
  const g = c2.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.34, W / 2, H * 0.48, Math.max(W, H) * 0.82);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.55, `rgba(0,0,0,${dq * 0.36})`);
  g.addColorStop(1, `rgba(0,0,0,${dq})`);
  c2.fillStyle = g;
  c2.fillRect(0, 0, W, H);

  if (bakeGrain) {
    // grain speckles, merged into the same sheet
    const img = c2.getImageData(0, 0, W, H);
    const d = img.data;
    let s = (variant * 2654435761 + 99991) >>> 0;
    const rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const count = Math.round(W * H * density);
    for (let i = 0; i < count; i++) {
      const o = ((rnd() * W * H) | 0) * 4;
      const bright = rnd() > 0.5;
      d[o] = bright ? 255 : 0;
      d[o + 1] = bright ? 255 : 0;
      d[o + 2] = bright ? 255 : 0;
      d[o + 3] = Math.max(d[o + 3], bright ? 26 : 20);
    }
    c2.putImageData(img, 0, 0);
  }
  const rec = { canvas: cv, k };
  PINNED.set(key, rec);
  return rec;
}

// Sky gradient: baked as a tall 1-D strip and stretched. The stops are quantised
// into the key so a sky key change rebuilds it once, not every frame.
export function skyStrip(top, mid, bottom, horizonPx, heightPx) {
  const q = (c) => c.map((v) => Math.round(v / 3) * 3).join(',');
  const key = `sky|${q(top)}|${q(mid)}|${q(bottom)}|${Math.round(horizonPx)}|${Math.round(heightPx)}`;
  return get(key, () => {
    const H = Math.max(16, Math.min(2048, Math.round(heightPx)));
    const cv = makeCanvas(4, H);
    if (!cv) return null;
    const c2 = cv.getContext('2d');
    const g = c2.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgbCss(top));
    g.addColorStop(0.52, rgbCss(mid));
    g.addColorStop(0.84, rgbCss([(mid[0] + bottom[0] * 3) / 4, (mid[1] + bottom[1] * 3) / 4, (mid[2] + bottom[2] * 3) / 4]));
    g.addColorStop(1, rgbCss(bottom));
    c2.fillStyle = g;
    c2.fillRect(0, 0, 4, H);
    return cv;
  });
}

// Ground gradient: baked as a vertical strip in world units and blitted. The
// gradient stops depend only on the sky palette and the visible depth, both of
// which are quantised in the key, so this is stable frame to frame.
export function groundStrip(key, top, bot, h, stops) {
  const H = Math.max(8, Math.min(1024, Math.ceil(h)));
  return get(key, () => {
    const cv = makeCanvas(8, H);
    if (!cv) return null;
    const c2 = cv.getContext('2d');
    const g = c2.createLinearGradient(0, 0, 0, H);
    for (const [p, col] of stops) g.addColorStop(p, rgbCss(col));
    c2.fillStyle = g;
    c2.fillRect(0, 0, 8, H);
    return cv;
  });
}

export function rgbCss(c) {
  return `rgb(${c.map((v) => Math.round(v)).join(',')})`;
}

// Slow-motion grade: a static radial cool wash, baked once per viewport size.
export function slowmoSheet(ctx, w, h, tint = '150,190,255') {
  const W = Math.ceil(w), H = Math.ceil(h);
  return get(`slow|${W}x${H}|${tint}`, () => {
    const cv = makeCanvas(W, H);
    if (!cv) return null;
    const c2 = cv.getContext('2d');
    const g = c2.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, `rgba(${tint},0)`);
    g.addColorStop(0.55, `rgba(${tint},0.45)`);
    g.addColorStop(1, `rgba(${tint},1)`);
    c2.fillStyle = g;
    c2.fillRect(0, 0, W, H);
    return { canvas: cv, k: 1 };
  });
}

// Warm the expensive baked sheets before playback starts, so the first frames
// do not hitch (baking a full-viewport grain sheet is a one-off ~30ms).
export function prebake(ctx, w, h) {
  for (let v = 0; v < 4; v++) postOverlay(ctx, w, h, 0.55, v, true);
  postOverlay(ctx, w, h, 0.55, 0, false);
  slowmoSheet(ctx, w, h);
}

// ---------------------------------------------------------------- clouds
// Baked at the requested display size so the draw is a 1:1 blit. The scale is
// quantised by the caller, which keeps the cache small while avoiding resampling.
export function cloudSprite(puffs, color, scale) {
  const s = Math.max(0.08, Math.round(scale * 20) / 20);
  const key = `cloud|${color}|${s}|${puffs.map((p) => `${p.r | 0},${p.dx | 0},${p.dy | 0},${p.a.toFixed(2)}`).join(';')}`;
  return get(key, () => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of puffs) {
      minX = Math.min(minX, p.dx - p.r);
      maxX = Math.max(maxX, p.dx + p.r);
      minY = Math.min(minY, p.dy - p.r);
      maxY = Math.max(maxY, p.dy + p.r);
    }
    const pad = 6 * s;
    const w = Math.ceil((maxX - minX) * s + pad * 2);
    const h = Math.ceil((maxY - minY) * s + pad * 2);
    if (w < 2 || h < 2 || w > 4096 || h > 4096) return null;
    const cv = makeCanvas(w, h);
    if (!cv) return null;
    const c2 = cv.getContext('2d');
    const ox = -minX * s + pad;
    const oy = -minY * s + pad;
    for (const p of puffs) {
      const px = p.dx * s + ox, py = p.dy * s + oy, r = p.r * s;
      const g = c2.createRadialGradient(px, py - r * 0.22, r * 0.08, px, py, r);
      g.addColorStop(0, `rgba(${color},${(p.a * 0.95).toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${color},${(p.a * 0.45).toFixed(3)})`);
      g.addColorStop(1, `rgba(${color},0)`);
      c2.fillStyle = g;
      c2.beginPath();
      c2.arc(px, py, r, 0, Math.PI * 2);
      c2.fill();
    }
    return { canvas: cv, w, h, ox, oy };
  });
}

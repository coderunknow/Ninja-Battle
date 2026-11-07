// Stage: composes a complete frame for a given timeline position.
//
// renderAt(ctx, t) is a pure function of (t, viewport) plus immutable compiled
// data. That is what makes pause/seek/replay exact: there is no accumulated state
// anywhere in the render path.
//
// Draw order (back to front):
//   sky -> far ridges -> clouds -> statues -> spires -> haze -> ground -> cracks
//   -> background FX (dust, debris) -> back characters -> characters
//   -> front FX (impacts, energy cores) -> atmosphere -> titles -> fade

import { clamp, clamp01, lerp, TAU, ease, smoothstep, noise1 } from '../core/math.js';
import { buildScript, TOTAL_DURATION, CAST } from './choreo.js';
import { resolveCast, findSegment, actorState } from './actors.js';
import { View, evalKeys, shakeFromEvents, fitZoom } from './camera.js';
import { buildWorld, drawSky, drawRidges, drawTreeline, drawClouds, drawStatues, drawValleyWalls, drawGround, drawForeground, drawMotes, drawAtmosphere } from './world.js';
import { renderFx, activeLight } from '../fx/effects.js';
import { drawFighter, fighterAnchors } from '../rig/render.js';
import { makeRig } from '../rig/skeleton.js';
import { drawTitles, drawLetterbox } from '../ui/titles.js';
import { QUALITY, PROFILES } from '../core/quality.js';
import { slowmoSheet } from '../core/platform.js';

export { TOTAL_DURATION };

let DATA = null;
export const rigNaruto = makeRig({ scale: 1, hair: 'naruto' });
export const rigSasuke = makeRig({ scale: 1, hair: 'spiky' });

export async function initAssets() {
  // Currently all art is procedural — nothing to load. Kept as an async entry
  // point so audio/asset loading can be awaited by the player.
  buildWorld();
  return true;
}

export function compile() {
  if (DATA) return DATA;
  const raw = buildScript();
  const sortByT = (a, b) => a.t - b.t;
  for (const k of Object.keys(raw.actors)) raw.actors[k].sort(sortByT);
  raw.camera.sort(sortByT);
  raw.fx.sort(sortByT);
  raw.audio.sort(sortByT);
  raw.events.sort(sortByT);
  raw.cracks.sort(sortByT);
  if (raw.skyKey) raw.skyKey.sort(sortByT);

  // camera moves must be non-overlapping for the sampler: clamp each move's end
  for (let i = 0; i < raw.camera.length; i++) {
    const mv = raw.camera[i];
    const next = raw.camera[i + 1];
    if (next) mv.end = next.t; else mv.end = Infinity;
  }

  // shake lookup buckets (1s windows) so frame cost stays flat
  const buckets = new Map();
  for (const e of raw.events) {
    if (!e.amp) continue;
    const b = Math.floor(e.t);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(e);
    const b2 = Math.floor(e.t) + 1;
    if (!buckets.has(b2)) buckets.set(b2, []);
    buckets.get(b2).push(e);
  }
  raw.shakeBuckets = buckets;
  DATA = raw;
  return DATA;
}

// --- sky interpolation -------------------------------------------------------
const SKY_DEFAULT = {
  top: [26, 32, 58], mid: [62, 66, 96], bottom: [148, 112, 96], ground: [54, 46, 46],
  haze: [150, 130, 122], sunColor: '255,214,170', sunA: 1, mote: '255,236,200',
  sunX: 34, sunY: -210, sunR: 26,
};

function skyAt(t) {
  const keys = DATA.skyKey && DATA.skyKey.length ? DATA.skyKey : [{ t: 0, ...SKY_DEFAULT }];
  let a = keys[0], b = keys[0];
  if (t <= keys[0].t) { a = b = keys[0]; }
  else if (t >= keys[keys.length - 1].t) { a = b = keys[keys.length - 1]; }
  else {
    for (let i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
    }
  }
  const u = b.t === a.t ? 0 : smoothstep(clamp01((t - a.t) / (b.t - a.t)));
  const mix = (ka, kb) => [
    lerp(ka[0], kb[0], u), lerp(ka[1], kb[1], u), lerp(ka[2], kb[2], u),
  ];
  const base = { ...SKY_DEFAULT, ...a };
  const bb = { ...SKY_DEFAULT, ...b };
  return {
    top: mix(base.top, bb.top),
    mid: mix(base.mid, bb.mid),
    bottom: mix(base.bottom, bb.bottom),
    ground: mix(base.ground, bb.ground),
    haze: mix(base.haze, bb.haze),
    sunColor: base.sunColor,
    sunA: lerp(base.sunA, bb.sunA, u),
    mote: base.mote,
    cloud: mix(base.cloud || [120, 122, 140], bb.cloud || [120, 122, 140], u),
    sunX: lerp(base.sunX ?? 34, bb.sunX ?? 34, u),
    sunY: lerp(base.sunY ?? -210, bb.sunY ?? -210, u),
    sunR: lerp(base.sunR ?? 26, bb.sunR ?? 26, u),
  };
}

// --- camera ------------------------------------------------------------------
function activeMove(t) {
  let mv = DATA.camera[0];
  for (let i = 0; i < DATA.camera.length; i++) {
    const m = DATA.camera[i];
    if (t >= m.t && (i === DATA.camera.length - 1 || t < DATA.camera[i + 1].t)) return m;
    if (t >= m.t) mv = m;
  }
  return mv;
}

/**
 * Camera solve.
 *
 * Hand-authored keys express *intent* (where to look and how tight), and the
 * solver turns that into a usable shot:
 *   on: 'both'  -> centred between the fighters, zoom clamped so both stay framed
 *   on: 'n'/'s' -> centred on that fighter (close-ups, over-the-shoulder)
 *   on: 'point' -> centred on the authored x/y (environment / aftermath shots)
 * The authored x/y stays as an *offset* so shots can be composed off-centre.
 */
function cameraAt(t, cast, view) {
  const mv = activeMove(t);
  const c = evalKeys(mv.keys, mv, t);
  const on = mv.on || 'both';
  const n = cast && cast.n, s = cast && cast.s;
  let focusX = c.x, focusY = c.y;

  if (on === 'both' && n && s) {
    const mid = (n.x + s.x) / 2;
    // frame the nearer-to-centre body, with a bias toward the taller subject
    focusX = mid + (c.x - 0) * 0.35;
    const sep = Math.abs(n.x - s.x);
    const fit = fitZoom(view, sep, mv.margin ?? 1.55);
    c.zoom = Math.min(c.zoom, Math.max(fit, mv.minZoom ?? 0.5));
    // keep the pair vertically centred on their chests
    const avgY = ((n.y || 0) + (s.y || 0)) / 2;
    focusY = avgY + c.y * 0.5 + (mv.yBias ?? 0);
  } else if ((on === 'n' || on === 's') && (on === 'n' ? n : s)) {
    const a = on === 'n' ? n : s;
    focusX = a.x + c.x * 0.25;
    focusY = (a.y || 0) + c.y * 0.55;
  } else {
    focusX = c.x;
    focusY = c.y;
  }

  c.x = focusX;
  c.y = focusY;

  let shake = 0;
  const bucket = DATA.shakeBuckets.get(Math.floor(t));
  if (bucket) shake = shakeFromEvents(bucket, t);
  c.shake += shake;
  return c;
}

// --- main render -------------------------------------------------------------
export function renderAt(ctx, t, w, h, opts = {}) {
  const DATA = compile();
  // Resolve the quality *profile*, not just its name: callers pass either a mode
  // string ('high' | 'performance') or a profile object.
  const mode = typeof opts.quality === 'string' ? opts.quality : (opts.quality && opts.quality.label ? null : QUALITY.mode);
  const q = opts.quality && typeof opts.quality === 'object' && 'motes' in opts.quality
    ? opts.quality
    : (PROFILES[mode] || PROFILES[QUALITY.mode] || PROFILES.high);
  const view = new View(w, h);
  if (opts.view) Object.assign(view, opts.view);
  view.setSize(w, h);

  const cast = resolveCast(DATA, t, DATA.cloneTracks);
  const cam = cameraAt(t, cast, view);
  view.set(cam);

  const sky = skyAt(t);
  const light = activeLight(DATA.fx, t);

  // ---- background (screen space for sky, world for geometry)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawSky(ctx, view, sky);
  drawRidges(ctx, view, t, sky);
  drawClouds(ctx, view, t, sky, 0);
  drawValleyWalls(ctx, view, t, sky, light ? light.light : sky.sunColor, 'far');
  drawStatues(ctx, view, t, sky, light ? light.light : sky.sunColor);
  drawValleyWalls(ctx, view, t, sky, light ? light.light : sky.sunColor, 'near');
  ctx.restore();

  // ---- world space
  ctx.save();
  view.apply(ctx);

  drawGround(ctx, view, t, sky, DATA.cracks, q);
  drawTreeline(ctx, view, t, sky);
  drawMotes(ctx, view, t, sky, q.motes);
  if (light) {
    // energy illuminates the ground around it
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const a = clamp01(light.score) * 0.5;
    const g = ctx.createRadialGradient(light.x, 0, 0, light.x, 0, 220);
    g.addColorStop(0, `rgba(${light.light},${0.22 * a})`);
    g.addColorStop(1, `rgba(${light.light},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(light.x, 0, 240, 60, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---- cast
  const drawActor = (st, style, opts2 = {}) => {
    if (!st) return null;
    const rig = style === 'naruto' ? rigNaruto : rigSasuke;
    const near = light ? clamp01(1 - Math.abs(light.x - st.x) / 260) * clamp01(light.score) : 0;
    const fall = st.airborne ? 0.55 : 1;
    // contact shadow fades with height
    const shadowA = 0.34 * fall * (st.alpha ?? 1);
    if (shadowA > 0.02) {
      ctx.save();
      ctx.globalAlpha = shadowA;
      const sy = 0;
      const g = ctx.createRadialGradient(st.x, sy, 0, st.x, sy, 42);
      g.addColorStop(0, 'rgba(0,0,0,0.75)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(st.x, sy, 44, 11, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    return drawFighter(ctx, {
      rig,
      pose: st.pose,
      x: st.x,
      y: st.y,
      facing: st.facing,
      rot: st.rot,
      scale: 1,
      style,
      time: t,
      flow: st.flow,
      alpha: st.alpha ?? 1,
      anger: 0.7,
      alert: 1,
      sharingan: st.sharingan,
      scream: st.pose.scream ?? 0,
      blink: st.blink,
      auraStrength: (st.aura ? 1 : 0) * 0.9,
      rimLight: near ? { rgb: light.light, a: near * 0.9 } : null,
      scalePulse: opts2.pulse || 1,
    });
  };

  const backC = [];
  const frontC = [];
  if (cast.n) backC.push([cast.n, 'naruto']);
  if (cast.s) backC.push([cast.s, 'sasuke']);
  for (const c of cast.clones) backC.push([c, 'naruto', true]);
  for (const c of cast.sClones) backC.push([c, 'sasuke', true]);
  backC.sort((a, b) => (a[0].y || 0) - (b[0].y || 0));

  // ---- effect anchoring
  // Effects authored with `who` (+ `hand`) are attached to the live skeleton at
  // render time, so a Rasengan/Chidori always sits in the character's hand even
  // mid-dash. `off` gives an authored offset from the anchor.
  const anchorOf = (who, hand) => {
    const st = who === 'n' ? cast.n : cast.s;
    if (!st) return null;
    const rig = who === 'n' ? rigNaruto : rigSasuke;
    const a = fighterAnchors({ rig, pose: st.pose, x: st.x, y: st.y, facing: st.facing, rot: st.rot, scale: 1 });
    if (hand === 'chest') return a.chest;
    if (hand === 'head') return a.head;
    if (hand === 'both') return { x: (a.frontHand.x + a.backHand.x) / 2, y: (a.frontHand.y + a.backHand.y) / 2 };
    if (hand === 'feet') return { x: a.frontFoot.x, y: a.frontFoot.y };
    return a.frontHand;
  };
  const anchorFx = (e) => {
    if (!e.who) return e;
    const p = anchorOf(e.who, e.hand);
    if (!p) return e;
    return { ...e, x: p.x + (e.offX || 0), y: p.y + (e.offY || 0) };
  };

  // background-ish fx (dust, debris, smoke, streaks) behind characters
  const bgFx = DATA.fx.filter((e) => !e.front && (e.kind === 'dust' || e.kind === 'debris' || e.kind === 'puff' || e.kind === 'streak'));
  const fgFx = DATA.fx.filter((e) => e.front || !(e.kind === 'dust' || e.kind === 'debris' || e.kind === 'puff' || e.kind === 'streak'));

  // only evaluate effects that could be alive (cheap window)
  const alive = (list) => list.filter((e) => t >= e.t && t <= e.t + (e.dur ?? e.life ?? 1.2) + 0.05);
  renderFx(alive(bgFx).map(anchorFx), ctx, view, t);

  const anchors = {};
  for (const [st, style, isClone] of backC) {
    const a = drawActor(st, style);
    if (!isClone) anchors[style] = a;
  }

  // foreground fx (impacts, energy, projectiles)
  renderFx(alive(fgFx).map(anchorFx), ctx, view, t);

  // energy dome for the final clash
  drawDome(ctx, view, t, light);

  ctx.restore();

  // ---- foreground rocks (parallax)
  drawForeground(ctx, view, t, sky);

  // ---- post
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const flash = flashAt(t);
  drawAtmosphere(ctx, view, {
    wash: light ? { x: view.toScreenX(light.x), y: view.toScreenY(light.y ?? -110), r: 480 * view.zoom, col: light.light, a: clamp01(light.score) * 0.55 } : null,
    vignette: 0.52 + (isSlow(t) ? 0.14 : 0),
    grain: q.grain,
    time: t,
  });
  if (isSlow(t)) drawSlowMotionOverlay(ctx, w, h, t);
  if (flash > 0.001) {
    ctx.fillStyle = `rgba(255,255,255,${clamp01(flash)})`;
    ctx.fillRect(0, 0, w, h);
  }
  // letterbox
  if (q.letterbox) drawLetterbox(ctx, w, h, Math.min(w, h) * 0.072);
  // titles
  drawTitles(ctx, w, h, DATA.titles, t);
  const fade = fadeAt(t);
  if (fade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${clamp01(fade)})`;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  return { view, cam, sky, light, cast };
}

function isSlow(t) {
  const D = DATA;
  if (!D.slowmo) return false;
  for (const s of D.slowmo) if (t >= s.t0 && t <= s.t1) return true;
  return false;
}

function drawSlowMotionOverlay(ctx, w, h, t) {
  // Cooling grade: a baked sheet blitted in screen mode, reads as "time has
  // stretched" without rasterising a full-viewport gradient every frame.
  const sheet = slowmoSheet(ctx, w, h);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.1;
  if (sheet) {
    if (sheet.k === 1) ctx.drawImage(sheet.canvas, 0, 0);
    else ctx.drawImage(sheet.canvas, 0, 0, sheet.canvas.width, sheet.canvas.height, 0, 0, w, h);
  }
  ctx.restore();
}

function drawDome(ctx, view, t, light) {
  // the expanding sphere of the final collision
  const D = DATA;
  if (t < 201.3 || t > 214) return;
  const u = clamp01((t - 201.3) / 12.0);
  const R = 60 + ease.outQuart(u) * 520;
  const a = (1 - u) * 0.30;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const x = 0, y = -120;
  const g = ctx.createRadialGradient(x, y, R * 0.55, x, y, R);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.75, `rgba(255,242,220,${a * 0.8})`);
  g.addColorStop(1, `rgba(255,255,255,0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, TAU);
  ctx.fill();
  // filaments
  ctx.strokeStyle = `rgba(255,250,235,${a * 0.9})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * TAU + t * 0.12;
    ctx.beginPath();
    ctx.arc(x, y, R * (0.82 + noise1(t + i, 3) * 0.1), ang, ang + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function flashAt(t) {
  const D = DATA;
  let f = 0;
  // white flash on huge impacts
  for (const e of D.events) {
    if (e.kind !== 'explode' && e.kind !== 'nova' && e.kind !== 'clash') continue;
    const age = t - e.t;
    if (age < 0 || age > 0.4) continue;
    const amp = e.kind === 'nova' ? 1 : e.kind === 'clash' ? 0.35 : 0.6;
    f = Math.max(f, amp * Math.exp(-age * 11));
  }
  // fade in at the very start, out at the very end
  if (t < 1.0) f = Math.max(f, 1 - t / 1.0);
  return Math.min(1, f);
}

function fadeAt(t) {
  if (t < 0.2) return 1 - t / 0.2;
  if (t > TOTAL_DURATION - 2.2) return (t - (TOTAL_DURATION - 2.2)) / 2.2;
  return 0;
}

export { cameraAt, skyAt, DATA as getData, isSlow };

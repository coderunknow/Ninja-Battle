// Choreography source of truth.
//
// The entire production is DATA: a flat list of action segments, camera moves,
// effect events, audio cues and title cards. Nothing accumulates frame-to-frame.
// `compile()` turns the data into typed arrays + per-frame cursors so that
// evaluating any timestamp costs O(1) per actor instead of scanning the script.
//
// Timeline structure (seconds):
//   0  - 26   ACT I    establishing the conflict
//   26 - 76   ACT II   close-combat exchange
//   76 - 132  ACT III  ninjutsu escalation
//   132-196   ACT IV   power escalation
//   196-258   ACT V    final clash + open ending

import { clamp01, lerp } from '../core/math.js';
import { sampleClip, clipMeta } from '../rig/clips.js';

export const TOTAL_DURATION = 258;

// Convenience authoring helpers ------------------------------------------------
const A = (from, dur, anim, o = {}) => ({ a: from, t: from, dur, anim, ...o });

export const CAST = { NARUTO: 'n', SASUKE: 's' };
const BASE_X = -120, BASE_S = 120;

// ---------------------------------------------------------------------------
// THE SCRIPT
// ---------------------------------------------------------------------------
export function buildScript() {
  const S = {
    actors: { n: [], s: [] },
    camera: [],
    fx: [],
    audio: [],
    events: [],      // hit / impact markers (shake, screen flash)
    cracks: [],
    titles: [],
    sky: [],
    marks: [],       // footstep / land dust markers are emitted as fx instead
  };

  S.cloneTracks = [];
  const N = (t, x, anim, o = {}) => S.actors.n.push({ t, x: BASE_X + x, anim, ...o });
  // secondary actors (shadow clones / lightning clones) get their own tracks
  const track = (id) => {
    if (!S.actors[id]) S.actors[id] = [];
    return S.actors[id];
  };
  const CL = (id, t, x, anim, o = {}) => track(id).push({ t, x: BASE_X + x, anim, ...o });
  const CLS = (id, t, x, anim, o = {}) => track(id).push({ t, x: BASE_S + x, anim, ...o });
  const K = (t, x, anim, o = {}) => S.actors.s.push({ t, x: BASE_S + x, anim, ...o });
  const CAM = (t, keys, o = {}) => S.camera.push({ t, keys, ...o });
  const FX = (o) => S.fx.push(o);
  const SFX = (t, id, o = {}) => S.audio.push({ t, id, ...o });

  // =========================================================================
  // ACT I — ESTABLISHING THE CONFLICT  (0 - 26)
  // =========================================================================
  CAM(0, [
    { t: 0, x: 0, y: -70, zoom: 0.72, ease: 'outCubic' },
    { t: 7.5, x: 10, y: -80, zoom: 0.82, ease: 'inOutSine' },
    { t: 13.5, x: -20, y: -92, zoom: 0.9, ease: 'inOutCubic' },
    { t: 19.5, x: 0, y: -96, zoom: 1.0, ease: 'inOutCubic' },
    { t: 25.5, x: 0, y: -100, zoom: 1.06 },
  ], { push: 0.5, breath: 1.4, margin: 2.6 });

  S.titles.push({ t: 1.6, dur: 5.4, kind: 'location', text: 'THE VALLEY OF THE FALLEN', sub: 'final valley · dusk' });
  S.titles.push({ t: 9.0, dur: 4.6, kind: 'chapter', text: 'ACT I', sub: 'the two who could not agree' });

  // establishing wind + first dust
  for (let t = 1; t < 24; t += 3.4) {
    FX({ t, kind: 'dust', x: -230 + Math.sin(t) * 60, y: -4, n: 12, power: 1.1, spread: 0.7, dur: 2.4, col: '150,150,150', alpha: 0.14, wind: 3 });
  }

  // Naruto: walks in from the far side and stops
  N(0, -180, 'walk', { u0: 0, speed: 44, dur: 13.4 });
  N(13.4, 4, 'guard', { breath: 1 });
  // Sasuke: already there, still, then turns his head
  K(0, 44, 'idle', { facing: -1 });
  K(13.0, 40, 'pointUp', {});
  K(17.0, 38, 'guard', {});

  // shared wind gusts pulse
  SFX(2.2, 'wind', { dur: 9 });
  SFX(15.0, 'wind', { dur: 8 });

  // slow push-in on faces at ~20s: low camera, tight frame
  CAM(25.5, [
    { t: 25.5, x: 0, y: -104, zoom: 1.06, ease: 'inOutCubic' },
    { t: 28.4, x: 6, y: -112, zoom: 1.34, ease: 'inOutCubic' },
  ], { push: 0.3 });

  // =========================================================================
  // ACT II — CLOSE COMBAT  (26 - 76)
  // =========================================================================
  // --- 26.0 Naruto dashes in; first exchange of punches/blocks
  N(26.0, 4, 'dash', { u0: 0, speed: 240, dur: 0.62 });
  N(26.62, -36, 'jab', { hitAt: 0.16 });
  K(26.62, 38, 'block', {});
  S.events.push({ t: 26.79, kind: 'hit', x: -16, y: -96, amp: 5, sfx: 'block', light: '255,230,190', lightDur: 0.3 });
  FX({ t: 26.79, kind: 'impact', x: -16, y: -96, size: 26, seed: 3, col: '255,240,205', dur: 0.22 });

  N(27.05, -36, 'cross', { hitAt: 0.19 });
  K(27.05, 38, 'blockHit', {});
  S.events.push({ t: 27.24, kind: 'hit', x: -14, y: -100, amp: 6, sfx: 'block2', light: '255,230,190', lightDur: 0.3 });
  FX({ t: 27.24, kind: 'sparks', x: -14, y: -100, n: 10, seed: 8, ang: 0.4, spread: 2.2, power: 0.7, dur: 0.35 });

  N(27.5, -36, 'hook', { hitAt: 0.38 });
  K(27.5, 38, 'backdash', { u0: 0.2, speed: 300, dur: 0.4 });
  S.events.push({ t: 27.86, kind: 'swish', sfx: 'swipe', });
  FX({ t: 27.72, kind: 'streak', x: -8, y: -104, n: 8, len: 44, h: 70, seed: 2, dur: 0.24 });

  N(27.98, -40, 'dash', { u0: 0, speed: 210, dur: 0.34 });
  K(28.3, 60, 'guard', {});
  N(28.34, -14, 'kickHigh', { hitAt: 0.42 });
  S.events.push({ t: 28.46, kind: 'whiff', sfx: 'swipe2' });

  // --- 28.6 Sasuke counter-attacks: side step + kick
  K(28.6, 56, 'flip', { u0: 0.1, dur: 0.7, dy: -70, spin: 0.35 });
  CAM(28.5, [
    { t: 28.5, x: 6, y: -112, zoom: 1.34, ease: 'outCubic' },
    { t: 29.4, x: 20, y: -120, zoom: 1.12, ease: 'inOutCubic' },
  ]);
  K(29.32, 40, 'kickMid', { hitAt: 0.4 });
  N(29.32, -30, 'blockHit', {});
  S.events.push({ t: 29.52, kind: 'hit', x: -6, y: -92, amp: 7, sfx: 'kick' });
  FX({ t: 29.52, kind: 'impact', x: -6, y: -92, size: 30, seed: 11, col: '210,230,255' });

  // --- 30.0 aerial exchange
  N(29.9, -30, 'backdash', { u0: 0.3, dy: -8, speed: 200, dur: 0.3 });
  N(30.2, -74, 'jump', { u0: 0.1, dur: 0.55, airborne: [30.32, 31.4] });
  K(30.32, 40, 'jump', { u0: 0.1, dur: 0.5, airborne: [30.45, 31.5] });
  CAM(29.9, [
    { t: 29.9, x: 10, y: -140, zoom: 1.1, ease: 'inOutCubic' },
    { t: 31.4, x: 4, y: -170, zoom: 1.24, ease: 'inOutSine' },
  ]);
  // they trade mid-air knees
  N(31.02, -60, 'kickMid', { hitAt: 0.4 });
  K(31.02, 26, 'block', {});
  FX({ t: 31.2, kind: 'impact', x: -16, y: -168, size: 24, seed: 13 });
  S.events.push({ t: 31.2, kind: 'hit', x: -16, y: -168, amp: 6, sfx: 'block' });

  K(31.36, 26, 'hook', { hitAt: 0.38 });
  N(31.36, -60, 'blockHit', {});
  S.events.push({ t: 31.55, kind: 'hit', x: -22, y: -166, amp: 7, sfx: 'block2' });
  FX({ t: 31.55, kind: 'sparks', x: -22, y: -166, n: 12, seed: 17, power: 0.8 });

  // --- 31.8 both land hard
  N(31.95, -96, 'land', { u0: 0.05, dur: 0.55 });
  K(31.9, 64, 'land', { u0: 0.05, dur: 0.55 });
  FX({ t: 32.12, kind: 'dust', x: -96, y: -2, n: 16, power: 1.0, dur: 1.2, seed: 21 });
  FX({ t: 32.06, kind: 'dust', x: 64, y: -2, n: 16, power: 1.0, dur: 1.2, seed: 22 });
  SFX(32.08, 'land', { p: 1 });

  // --- 32.4 rapid combo: 5 readable strikes with camera cuts
  CAM(32.2, [
    { t: 32.2, x: 0, y: -150, zoom: 1.2, ease: 'inOutCubic' },
    { t: 33.6, x: -10, y: -122, zoom: 1.02, ease: 'inOutCubic' },
  ]);
  const combo = [
    { t: 32.55, ax: -84, bx: 52, nc: 'jab', kc: 'block' },
    { t: 33.05, ax: -80, bx: 48, nc: 'cross', kc: 'blockHit' },
    { t: 33.55, ax: -76, bx: 44, nc: 'kickMid', kc: 'block' },
    { t: 34.05, ax: -72, bx: 40, nc: 'hook', kc: 'blockHit' },
    { t: 34.55, ax: -68, bx: 34, nc: 'uppercut', kc: 'dodge' },
  ];
  for (const c of combo) {
    N(c.t, c.ax, c.nc, { hitAt: 0.4 });
    if (c.kc === 'dodge') {
      K(c.t, c.bx, 'backdash', { u0: 0.05, speed: 320, dur: 0.3 });
    } else {
      K(c.t, c.bx, c.kc, {});
    }
    const hitT = c.t + (c.nc === 'uppercut' ? 0.18 : 0.14);
    S.events.push({ t: hitT, kind: 'hit', x: c.bx - 20, y: -100, amp: c.nc === 'uppercut' ? 8 : 5, sfx: c.kc === 'block' ? 'block' : 'block2' });
    FX({ t: hitT, kind: 'sparks', x: c.bx - 18, y: -100, n: 10, seed: Math.floor(c.t * 10), power: 0.7, ang: 0.2, spread: 2, dur: 0.3 });
    // camera micro-push on each impact
    CAM(c.t, [
      { t: c.t, x: (c.ax + c.bx) / 2 - 20, y: -104, zoom: 1.06, ease: 'outExpo' },
      { t: c.t + 0.22, x: (c.ax + c.bx) / 2 - 30, y: -106, zoom: 1.14, ease: 'inOutCubic' },
    ], { push: 0.2 });
  }
  SFX(32.4, 'combo', {});

  CAM(35.15, [
    { t: 35.15, x: -18, y: -108, zoom: 1.14, ease: 'inOutCubic' },
    { t: 36.4, x: -8, y: -112, zoom: 1.3, ease: 'inOutCubic' },
  ]);

  // --- 35.2 Sasuke's flurry back
  for (let i = 0; i < 4; i++) {
    const t = 35.3 + i * 0.42;
    K(t, 30 - i * 3, i % 2 ? 'cross' : 'jab', { hitAt: 0.33 });
    N(t, -56 + i * 3, i % 2 ? 'blockHit' : 'block', {});
    S.events.push({ t: t + 0.13, kind: 'hit', x: -32, y: -102, amp: 4.5, sfx: i % 2 ? 'block2' : 'block' });
    FX({ t: t + 0.13, kind: 'sparks', x: -30, y: -102, n: 8, seed: 40 + i, power: 0.6, dur: 0.26 });
  }
  // final sasuke kick sends naruto sliding back
  K(37.2, 22, 'kickHigh', { hitAt: 0.42 });
  N(37.2, -62, 'blockHit', {});
  N(37.62, -92, 'hit', { u0: 0.05 });
  N(38.0, -120, 'land', { u0: 0.1, dur: 0.5 });
  S.events.push({ t: 37.42, kind: 'bigHit', x: -44, y: -92, amp: 11, sfx: 'kickHeavy', light: '255,220,220' });
  FX({ t: 37.42, kind: 'impact', x: -44, y: -92, size: 54, seed: 23, col: '255,235,225' });
  FX({ t: 37.42, kind: 'shock', x: -44, y: -92, r0: 6, r1: 90, dur: 0.5, squash: 1, w: 6 });
  FX({ t: 38.16, kind: 'dust', x: -120, y: -2, n: 20, power: 1.3, dur: 1.5, seed: 24, dir: -1 });
  S.cracks.push({ t: 38.16, x: -120, power: 0.5, depth: 0.4, seed: 88 });

  CAM(37.2, [
    { t: 37.2, x: -8, y: -112, zoom: 1.3, ease: 'outExpo' },
    { t: 37.55, x: -44, y: -96, zoom: 1.0, ease: 'outExpo', shake: 0 },
    { t: 38.5, x: -70, y: -100, zoom: 0.94, ease: 'inOutCubic' },
  ], { push: 0.4 });

  // --- 38.8 stand-off, breathing, then chase
  N(38.6, -120, 'getUp', { dur: 0.85 });
  N(39.5, -118, 'guard', { breath: 1.4 });
  K(38.6, 22, 'guard', { breath: 1.2 });
  CAM(38.8, [
    { t: 38.8, x: -70, y: -100, zoom: 0.94, ease: 'inOutCubic' },
    { t: 41.2, x: -50, y: -104, zoom: 1.02, ease: 'inOutCubic' },
  ]);
  S.titles.push({ t: 39.0, dur: 3.2, kind: 'chapter', text: 'ACT II', sub: 'the first exchange' });

  // --- 41.4 running chase sequence
  N(41.4, -118, 'run', { u0: 0, speed: 300, dur: 1.0 });
  K(41.4, 22, 'run', { u0: 0.5, speed: 300, dur: 0.9, facing: -1 });
  CAM(41.4, [
    { t: 41.4, x: -50, y: -104, zoom: 1.0, ease: 'outCubic' },
    { t: 43.0, x: 10, y: -108, zoom: 0.92, ease: 'inOutCubic' },
  ], { push: 1.2 });
  N(42.4, -30, 'dash', { u0: 0, speed: 340, dur: 0.5 });
  K(42.5, 66, 'dash', { u0: 0, speed: 340, dur: 0.4, facing: -1 });
  // kunai exchange: Sasuke throws two kunai, Naruto deflects
  K(42.9, 60, 'kunaiThrow', { emit: 0.34 });
  FX({ t: 42.86, kind: 'kunai', x: 52, y: -116, path: kunaiPath(52, -116, -96, -100, 42.86, 0.42), life: 0.42, seed: 1, ang: Math.PI });
  SFX(42.86, 'kunai', { p: 1 });
  N(42.95, -20, 'block', {});
  FX({ t: 43.28, kind: 'sparks', x: -46, y: -104, n: 12, seed: 31, power: 0.8 });
  S.events.push({ t: 43.28, kind: 'clank', x: -46, y: -104, amp: 4, sfx: 'clank' });
  K(43.3, 52, 'kunaiThrow', { emit: 0.34 });
  FX({ t: 43.24, kind: 'kunai', x: 44, y: -140, path: kunaiPath(44, -140, -92, -84, 43.24, 0.44), life: 0.44, seed: 2 });
  SFX(43.24, 'kunai', { p: 0.9 });
  FX({ t: 43.68, kind: 'sparks', x: -50, y: -92, n: 10, seed: 33, power: 0.7 });
  N(43.4, -24, 'jab', { hitAt: 0.33 });

  // --- 44.0 Sasuke is grazed, Naruto presses
  CAM(43.6, [
    { t: 43.6, x: -20, y: -110, zoom: 1.05, ease: 'outCubic' },
    { t: 45.6, x: -6, y: -116, zoom: 1.22, ease: 'inOutCubic' },
  ]);
  N(44.2, -12, 'hook', { hitAt: 0.38 });
  K(44.2, 26, 'hit', {});
  S.events.push({ t: 44.34, kind: 'hit', x: 4, y: -118, amp: 8, sfx: 'punchHeavy' });
  FX({ t: 44.34, kind: 'impact', x: 4, y: -118, size: 40, seed: 41, col: '255,235,215' });
  FX({ t: 44.34, kind: 'dust', x: 24, y: -100, n: 8, power: 0.6, dur: 0.8, seed: 42 });

  // --- 45.0 Sasuke recovers and counters with a spinning kick
  K(45.3, 24, 'flip', { u0: 0.05, dur: 0.75, spin: 0.55 });
  K(46.0, 12, 'kickHigh', { hitAt: 0.42 });
  N(46.0, -26, 'blockHit', {});
  S.events.push({ t: 46.2, kind: 'hit', x: -8, y: -110, amp: 8, sfx: 'kick' });
  FX({ t: 46.2, kind: 'impact', x: -8, y: -110, size: 36, seed: 43 });
  CAM(45.2, [
    { t: 45.2, x: -6, y: -116, zoom: 1.22, ease: 'inOutCubic' },
    { t: 46.4, x: 0, y: -120, zoom: 0.98, ease: 'inOutCubic' },
  ]);

  // --- 46.4 Naruto sweeps, Sasuke jumps over it
  N(46.6, -26, 'sweep', { hitAt: 0.45 });
  K(46.6, 8, 'jump', { u0: 0.05, dur: 0.6, airborne: [46.7, 47.4] });
  FX({ t: 46.95, kind: 'dust', x: -14, y: -2, n: 12, power: 0.7, dur: 0.9, seed: 44 });
  FX({ t: 46.9, kind: 'streak', x: -14, y: -30, n: 10, len: 60, h: 20, seed: 45, dur: 0.3, dy: 0, dx: -1 });
  // Sasuke lands on Naruto's back and kicks him up
  K(47.4, 4, 'land', { u0: 0.05, dur: 0.4 });
  K(47.8, 8, 'uppercut', { hitAt: 0.4 });
  N(47.8, -34, 'hitHeavy', {});
  N(48.1, -56, 'fall', { airborne: [48.0, 49.1], dy: -150, dx: -60 });
  S.events.push({ t: 47.98, kind: 'bigHit', x: -18, y: -120, amp: 12, sfx: 'uppercut' });
  FX({ t: 47.98, kind: 'impact', x: -18, y: -120, size: 52, seed: 46, col: '255,230,240' });
  CAM(47.4, [
    { t: 47.4, x: 0, y: -120, zoom: 1.0, ease: 'outExpo' },
    { t: 48.1, x: -20, y: -150, zoom: 0.88, ease: 'inOutCubic' },
    { t: 49.3, x: -50, y: -110, zoom: 0.95, ease: 'inOutCubic' },
  ]);

  // --- 49.2 Naruto slams into the ground
  N(49.15, -96, 'land', { u0: 0.0, dur: 0.35 });
  N(49.4, -96, 'knockdown', { dur: 0.5 });
  FX({ t: 49.15, kind: 'dust', x: -96, y: -2, n: 26, power: 1.7, dur: 1.8, seed: 47 });
  FX({ t: 49.15, kind: 'debris', x: -96, y: -4, n: 12, power: 1.4, dur: 1.3, seed: 48 });
  FX({ t: 49.15, kind: 'shock', x: -96, y: -2, r0: 8, r1: 150, dur: 0.7, squash: 0.28, w: 12 });
  S.cracks.push({ t: 49.15, x: -96, power: 0.85, depth: 0.6, seed: 49 });
  S.events.push({ t: 49.15, kind: 'slam', amp: 16, sfx: 'slam' });
  SFX(49.15, 'slam', {});

  // --- 50.0 Sasuke lands, taunts; Naruto struggles up
  K(48.35, -6, 'land', { u0: 0.1, dur: 0.5 });
  K(48.9, -6, 'guard', { breath: 1 });
  CAM(49.6, [
    { t: 49.6, x: -60, y: -70, zoom: 1.0, ease: 'inOutCubic' },
    { t: 52.2, x: -40, y: -80, zoom: 1.1, ease: 'inOutCubic' },
  ]);
  S.titles.push({ t: 50.2, dur: 2.6, kind: 'line', text: '“You still don’t understand.”' });
  N(51.4, -96, 'getUp', { dur: 1.0 });
  N(52.4, -96, 'guardLow', { breath: 1.6 });
  S.audio.push({ t: 50.4, id: 'voiceSasuke1' });

  // --- 53.0 second clash: Naruto explodes into a run
  N(53.2, -96, 'dash', { u0: 0, speed: 300, dur: 0.42 });
  K(53.4, -2, 'guard', {});
  N(54.0, -52, 'cross', { hitAt: 0.33 });
  K(54.0, -6, 'block', {});
  for (let i = 0; i < 6; i++) {
    const t = 54.3 + i * 0.3;
    const nar = i % 2 === 0;
    if (nar) { N(t, -52 + i * 2, i % 4 === 0 ? 'jab' : 'hook', { hitAt: 0.33 }); K(t, -6, i % 4 === 0 ? 'block' : 'blockHit', {}); }
    else { K(t, -6, i % 4 === 1 ? 'cross' : 'jab', { hitAt: 0.33 }); N(t, -52 + i * 2, i % 4 === 1 ? 'block' : 'blockHit', {}); }
    S.events.push({ t: t + 0.11, kind: 'hit', x: -28, y: -110, amp: 3.4, sfx: i % 2 ? 'block' : 'block2' });
    FX({ t: t + 0.11, kind: 'sparks', x: -28, y: -110, n: 7, seed: 60 + i, power: 0.55, dur: 0.24 });
  }
  CAM(53.6, [
    { t: 53.6, x: -40, y: -100, zoom: 1.04, ease: 'outCubic' },
    { t: 56.0, x: -28, y: -108, zoom: 1.26, ease: 'inOutCubic' },
  ], { push: 0.6 });
  SFX(53.7, 'combo2', {});

  // --- 56.2 both leap back, breathing room (breath beat)
  N(56.2, -46, 'backdash', { u0: 0.1, speed: 320, dur: 0.4 });
  K(56.25, -2, 'backdash', { u0: 0.1, speed: 320, dur: 0.4 });
  N(56.7, -44, 'guardLow', { breath: 1.8 });
  K(56.7, -4, 'guard', { breath: 1.4 });
  CAM(56.3, [
    { t: 56.3, x: -28, y: -108, zoom: 1.26, ease: 'inOutCubic' },
    { t: 58.0, x: -30, y: -104, zoom: 1.02, ease: 'inOutCubic' },
  ]);

  // --- 58.0 Sasuke uses fire style for the first time (transition to Act III)
  S.titles.push({ t: 58.2, dur: 3.4, kind: 'chapter', text: 'ACT III', sub: 'ninjutsu' });
  K(58.4, -2, 'seal', {});
  FX({ t: 58.9, kind: 'puff', x: -2, y: -120, n: 16, power: 0.8, seed: 70, dur: 0.7 });
  SFX(58.9, 'seal', {});
  K(59.6, -2, 'fireball', { emit: 0.55 });
  // fireball
  const fb = 59.85;
  FX({
    t: fb, kind: 'fireball', x: -8, y: -116, size: 34, seed: 71, life: 1.0,
    path: (age) => ({ x: lerp(-8, -150, clamp01(age / 0.92)), y: -116 - Math.sin(clamp01(age / 0.92) * Math.PI) * 10 }),
  });
  SFX(fb, 'fireBreath', { dur: 1.1 });
  S.events.push({ t: fb, kind: 'flash', light: '255,140,50', lightDur: 1.3, lightPower: 1.1 });
  N(59.9, -58, 'backdash', { u0: 0, speed: 340, dur: 0.36 });
  // Naruto dodges: the fireball detonates on the ground behind him
  FX({ t: fb + 0.92, kind: 'impact', x: -150, y: -30, size: 150, seed: 72, col: '255,170,80', dur: 0.5, spikes: 13 });
  FX({ t: fb + 0.9, kind: 'burstRing', x: -150, y: -30, r1: 190, dur: 0.6, col: '255,150,60', w: 16, alpha: 0.9 });
  FX({ t: fb + 0.9, kind: 'dust', x: -150, y: -6, n: 30, power: 2.0, dur: 2.0, seed: 73, col: '120,100,85' });
  FX({ t: fb + 0.9, kind: 'debris', x: -150, y: -6, n: 16, power: 2.0, dur: 1.6, seed: 74 });
  FX({ t: fb + 0.95, kind: 'sparks', x: -150, y: -30, n: 26, power: 1.6, seed: 75, ang: -Math.PI / 2, spread: 2.6, g: 1.2 });
  S.cracks.push({ t: fb + 0.9, x: -150, power: 1.1, depth: 0.6, seed: 76 });
  S.events.push({ t: fb + 0.9, kind: 'explode', amp: 20, sfx: 'explosion' });
  SFX(fb + 0.9, 'explosion', {});
  CAM(59.7, [
    { t: 59.7, x: -30, y: -104, zoom: 1.02, ease: 'outCubic' },
    { t: 60.6, x: -70, y: -110, zoom: 0.94, ease: 'inOutCubic' },
    { t: fb + 0.9, x: -100, y: -100, zoom: 0.86, ease: 'outExpo' },
    { t: fb + 1.5, x: -110, y: -104, zoom: 0.92, ease: 'inOutCubic' },
  ], { push: 1.4 });

  // --- 62.0 Naruto answers with shadow clones
  N(62.0, -130, 'seal', {});
  N(62.9, -130, 'seal', { hold: true });
  SFX(62.9, 'kagebunshin', {});
  S.titles.push({ t: 63.0, dur: 2.4, kind: 'line', text: '“Shadow Clone Jutsu!”', who: 'naruto' });
  S.audio.push({ t: 63.0, id: 'voiceNaruto1' });
  // clone spawns — each gets its own actor track + lifetime
  const cloneXs = [-176, -150, -116, -92, -66];
  cloneXs.forEach((cx, i) => {
    const t = 63.3 + i * 0.09;
    FX({ t, kind: 'puff', x: cx, y: -100, n: 18, power: 1.1, seed: 80 + i, dur: 0.8 });
    FX({ t: t + 0.1, kind: 'dust', x: cx, y: -2, n: 8, power: 0.7, dur: 0.8, seed: 90 + i });
    const id = `n${i}`;
    S.cloneTracks.push({ id, birth: t, death: i < 3 ? 64.5 + (2 - i) * 0.28 : 66.4 });
    CL(id, t, cx, 'guard', {});
    CL(id + 'c', t + 0.45, cx, 'run', { u0: (i * 0.23) % 1, speed: 340, dur: 1.0 });
    // (the run segment is merged into the same track below)
    S.actors[id] = [S.actors[id][0], S.actors[id + 'c'][0]];
    delete S.actors[id + 'c'];
  });
  SFX(63.3, 'puff', {});
  CAM(62.4, [
    { t: 62.4, x: -110, y: -104, zoom: 0.92, ease: 'inOutCubic' },
    { t: 64.6, x: -80, y: -110, zoom: 1.04, ease: 'inOutCubic' },
  ], { push: 1.0 });

  // --- 64.4 Sasuke cuts through the clones (chidori-laced kunai)
  K(64.2, 40, 'kunaiThrow', { emit: 0.34 });
  for (let i = 0; i < 3; i++) {
    const t = 64.5 + i * 0.28;
    const cx = cloneXs[4 - i];
    FX({ t, kind: 'puff', x: cx, y: -100, n: 22, power: 1.4, seed: 100 + i, dur: 0.7 });
    FX({ t, kind: 'impact', x: cx, y: -100, size: 34, seed: 110 + i, col: '200,230,255', dur: 0.3 });
    S.events.push({ t, kind: 'pop', amp: 3, sfx: 'poof' });
    S.deadClones = S.deadClones || [];
    S.deadClones.push({ t, x: cx });
  }
  SFX(64.5, 'poof', {});

  // --- 66.0 Naruto's real body comes from above with a Rasengan
  N(65.6, -60, 'jump', { u0: 0.0, dur: 0.6, airborne: [65.7, 66.9], dy: -190 });
  N(66.0, -60, 'rasenganCharge', { u0: 0.1, hold: true });
  S.titles.push({ t: 66.1, dur: 2.6, kind: 'line', text: '“RASENGAN!”', who: 'naruto' });
  S.audio.push({ t: 66.1, id: 'voiceNaruto2' });
  SFX(66.2, 'rasenganCharge', { dur: 1.6 });
  // rasengan ball follows the hand
  const rasT = 66.35;
  FX({ t: rasT, kind: 'rasengan', who: 'n', hand: 'frontHand', x: 0, y: 0, size: 24, seed: 120, grow: 0.5, dur: 3.4, light: '120,200,255', lightDur: 2.0, lightPower: 1.3, lightRamp: 0.1 });
  N(66.9, -76, 'rasenganThrust', { hitAt: 0.34, dy: 0 });
  K(66.9, 10, 'blockHit', {});
  S.events.push({ t: 67.2, kind: 'bigHit', x: 0, y: -130, amp: 14, sfx: 'rasenganHit', light: '150,210,255', lightPower: 1.6 });
  FX({ t: 67.2, kind: 'impact', x: 0, y: -130, size: 90, seed: 121, col: '180,235,255', dur: 0.45, spikes: 14 });
  FX({ t: 67.2, kind: 'burstRing', x: 0, y: -130, r1: 170, dur: 0.55, col: '150,220,255', w: 18 });
  // Sasuke is sent flying
  K(67.35, 40, 'hitHeavy', {});
  K(67.8, 96, 'fall', { airborne: [67.5, 68.9], dx: 70, dy: -80 });
  FX({ t: 67.4, kind: 'streak', x: 20, y: -130, n: 16, len: 120, h: 90, seed: 122, dur: 0.45, dx: -1 });
  CAM(66.4, [
    { t: 66.4, x: -40, y: -140, zoom: 1.0, ease: 'inOutCubic' },
    { t: 67.2, x: -4, y: -136, zoom: 0.9, ease: 'outExpo' },
    { t: 68.4, x: 40, y: -120, zoom: 0.96, ease: 'inOutCubic' },
  ], { push: 1.2 });

  // --- 68.9 Sasuke crashes and slides
  K(68.85, 150, 'land', { u0: 0.0, dur: 0.4 });
  K(69.05, 150, 'knockdown', { dur: 0.4 });
  FX({ t: 68.85, kind: 'dust', x: 150, y: -2, n: 30, power: 1.8, dur: 1.9, seed: 130 });
  FX({ t: 68.85, kind: 'debris', x: 150, y: -4, n: 14, power: 1.5, dur: 1.4, seed: 131 });
  FX({ t: 68.85, kind: 'shock', x: 150, y: -2, r0: 8, r1: 140, dur: 0.6, squash: 0.3, w: 12 });
  S.cracks.push({ t: 68.85, x: 150, power: 0.9, depth: 0.5, seed: 132 });
  S.events.push({ t: 68.85, kind: 'slam', amp: 15, sfx: 'slam' });
  N(67.4, -80, 'land', { u0: 0.3, dur: 0.5 });
  N(67.9, -84, 'guard', { breath: 1.4 });

  // --- 70.0 Sasuke gets up; his eyes change
  K(70.8, 148, 'getUp', { dur: 1.2 });
  K(72.0, 146, 'guard', { breath: 1.6, sharingan: 1 });
  S.titles.push({ t: 71.2, dur: 2.8, kind: 'line', text: '“Now you’ll see what I really am.”' });
  S.audio.push({ t: 71.2, id: 'voiceSasuke2' });
  CAM(70.4, [
    { t: 70.4, x: 60, y: -110, zoom: 0.96, ease: 'inOutCubic' },
    { t: 73.4, x: 100, y: -118, zoom: 1.18, ease: 'inOutCubic' },
  ], { push: 0.5 });

  // =========================================================================
  // ACT III continues — chidori vs rasengan first clash (73 - 90)
  // =========================================================================
  K(73.4, 146, 'chidoriCharge', { hold: true });
  FX({ t: 73.9, kind: 'chidori', who: 's', hand: 'frontHand', x: 0, y: 0, size: 26, seed: 140, amp: 1.1, dur: 4.2, light: '150,200,255', lightDur: 2.4, lightPower: 1.4 });
  SFX(73.9, 'chidoriCharge', { dur: 2.2 });
  S.titles.push({ t: 74.0, dur: 2.2, kind: 'line', text: '“CHIDORI!”', who: 'sasuke' });
  S.audio.push({ t: 74.0, id: 'voiceSasuke3' });

  N(73.4, -84, 'rasenganCharge', { hold: true });
  FX({ t: 73.9, kind: 'rasengan', who: 'n', hand: 'frontHand', x: 0, y: 0, size: 26, seed: 141, grow: 0.5, dur: 4.2, light: '120,200,255', lightDur: 2.4, lightPower: 1.4 });
  SFX(73.9, 'rasenganCharge', { dur: 2.2 });
  CAM(73.6, [
    { t: 73.6, x: 40, y: -118, zoom: 1.18, ease: 'inOutCubic' },
    { t: 75.4, x: 40, y: -116, zoom: 0.86, ease: 'inOutCubic' },
  ]);

  // charge glow rising on both
  for (let i = 0; i < 8; i++) {
    FX({ t: 74.1 + i * 0.22, kind: 'puff', x: -100 + (i % 2 ? 8 : -8), y: -100, n: 5, power: 0.5, seed: 150 + i, dur: 0.6 });
  }

  // --- dash-in and collide
  N(75.5, -84, 'dash', { u0: 0, speed: 420, dur: 0.34 });
  K(75.55, 146, 'chidoriDash', { u0: 0, dur: 0.42 });
  const clash1 = 75.94;
  N(clash1, -16, 'clash', { hold: true });
  K(clash1, 16, 'clash', { hold: true });
  FX({ t: clash1, kind: 'collision', x: 0, y: -124, size: 46, seed: 160, ramp: 0.5, light: '255,200,140', lightDur: 4.0, lightPower: 2.0 });
  FX({ t: clash1, kind: 'burstRing', x: 0, y: -124, r1: 210, dur: 0.5, col: '255,240,210', w: 22 });
  FX({ t: clash1, kind: 'shock', x: 0, y: -2, r0: 20, r1: 260, dur: 0.9, squash: 0.22, w: 16, col: '255,230,190' });
  FX({ t: clash1, kind: 'dust', x: 0, y: -2, n: 30, power: 2.2, dur: 2.2, seed: 161 });
  FX({ t: clash1, kind: 'debris', x: 0, y: -6, n: 18, power: 2.2, dur: 1.8, seed: 162 });
  S.events.push({ t: clash1, kind: 'clash', amp: 22, sfx: 'clash' });
  SFX(clash1, 'clash', {});
  // hold the clash — energy pressure, camera shake builds
  for (let i = 0; i < 10; i++) {
    const tt = clash1 + 0.16 + i * 0.17;
    FX({ t: tt, kind: 'sparks', x: 0 + (i % 2 ? 14 : -14), y: -124 + (i % 3 - 1) * 16, n: 8, power: 1.2, seed: 170 + i, ang: Math.PI / 2, spread: 2.6, dur: 0.5 });
    S.events.push({ t: tt, kind: 'pressure', amp: 3, sfx: 'crackle' });
  }
  CAM(clash1, [
    { t: clash1, x: 0, y: -124, zoom: 0.86, ease: 'outExpo' },
    { t: clash1 + 0.55, x: 0, y: -128, zoom: 1.32, ease: 'outCubic' },
    { t: clash1 + 1.7, x: 0, y: -132, zoom: 1.44, ease: 'inOutSine' },
    { t: clash1 + 2.4, x: 0, y: -136, zoom: 1.5, ease: 'inOutSine' },
  ], { push: 2.2, breath: 2.2 });

  // --- 78.4 the clash breaks: both blown apart
  const brk1 = 78.4;
  FX({ t: brk1, kind: 'burstRing', x: 0, y: -126, r1: 340, dur: 0.7, col: '255,255,240', w: 30 });
  FX({ t: brk1, kind: 'impact', x: 0, y: -126, size: 190, seed: 180, col: '255,250,235', dur: 0.5, spikes: 16 });
  S.events.push({ t: brk1, kind: 'explode', amp: 26, sfx: 'bigBoom', light: '255,255,235', lightDur: 1.2 });
  SFX(brk1, 'bigBoom', {});
  N(brk1, -16, 'hitHeavy', {});
  K(brk1, 16, 'hitHeavy', {});
  N(brk1 + 0.2, -120, 'fall', { airborne: [brk1 + 0.2, brk1 + 1.4], dx: -90, dy: -60 });
  K(brk1 + 0.2, 120, 'fall', { airborne: [brk1 + 0.2, brk1 + 1.4], dx: 90, dy: -60 });
  N(brk1 + 1.45, -150, 'land', { u0: 0, dur: 0.4 });
  K(brk1 + 1.45, 150, 'land', { u0: 0, dur: 0.4 });
  FX({ t: brk1 + 1.45, kind: 'dust', x: -150, y: -2, n: 18, power: 1.2, dur: 1.4, seed: 181 });
  FX({ t: brk1 + 1.45, kind: 'dust', x: 150, y: -2, n: 18, power: 1.2, dur: 1.4, seed: 182 });
  S.cracks.push({ t: brk1 + 1.45, x: -150, power: 0.6, depth: 0.4, seed: 183 });
  S.cracks.push({ t: brk1 + 1.45, x: 150, power: 0.6, depth: 0.4, seed: 184 });
  S.events.push({ t: brk1 + 1.45, kind: 'slam', amp: 9, sfx: 'land' });
  CAM(brk1 - 0.1, [
    { t: brk1 - 0.1, x: 0, y: -136, zoom: 1.5, ease: 'outExpo' },
    { t: brk1 + 0.35, x: 0, y: -126, zoom: 0.62, ease: 'outExpo' },
    { t: brk1 + 1.6, x: 0, y: -100, zoom: 0.78, ease: 'inOutCubic' },
  ], { push: 1.6 });

  // =========================================================================
  // ACT IV — POWER ESCALATION (80 - 132)
  // =========================================================================
  S.titles.push({ t: 80.6, dur: 3.0, kind: 'chapter', text: 'ACT IV', sub: 'beyond the limit' });
  // --- 80.6 Naruto, on the ground, draws on more chakra
  N(80.5, -150, 'kneel', {});
  N(82.0, -150, 'powerUp', { dur: 2.2 });
  FX({ t: 82.1, kind: 'streak', x: -150, y: -100, n: 20, len: 130, h: 190, seed: 190, dur: 2.4, alpha: 0.32, col: '255,190,90', dx: 0, dy: 1 });
  S.audio.push({ t: 81.6, id: 'voiceNaruto3' });
  S.titles.push({ t: 82.2, dur: 2.8, kind: 'line', text: '“I won’t lose to you. Not again.”' });
  SFX(82.0, 'powerUp', { dur: 2.4 });
  for (let i = 0; i < 9; i++) {
    FX({ t: 82.2 + i * 0.22, kind: 'dust', x: -150 + (i % 2 ? 26 : -26), y: -4, n: 8, power: 1.1, dur: 1.4, seed: 200 + i, col: '190,140,70', alpha: 0.2 });
  }
  S.events.push({ t: 84.2, kind: 'flash', light: '255,180,70', lightDur: 1.8, lightPower: 1.6 });
  N(84.2, -150, 'guard', { breath: 2.0, aura: 1 });
  FX({ t: 84.2, kind: 'burstRing', x: -150, y: -110, r1: 190, dur: 0.6, col: '255,200,110', w: 20 });
  S.events.push({ t: 84.2, kind: 'powerSurge', amp: 12, sfx: 'surge', light: '255,190,90', lightDur: 2.4, lightPower: 1.4 });

  // --- 85 Sasuke watches, then mirrors the escalation
  K(82.0, 150, 'kneel', {});
  K(85.4, 150, 'powerUp', { dur: 2.0 });
  SFX(85.4, 'powerUp2', { dur: 2.2 });
  S.events.push({ t: 87.0, kind: 'flash', light: '150,190,255', lightDur: 1.6, lightPower: 1.5 });
  K(87.0, 150, 'guard', { breath: 2.0, aura: 1, sharingan: 1 });
  for (let i = 0; i < 10; i++) {
    const tt = 86.2 + i * 0.14;
    FX({ t: tt, kind: 'chidori', who: 's', hand: 'chest', offX: (i % 2 ? 30 : -30), offY: 40 - i * 6, x: 0, y: 0, size: 14, seed: 210 + i, amp: 0.8 });
  }
  S.events.push({ t: 87.0, kind: 'powerSurge', amp: 12, sfx: 'surge2', light: '150,200,255', lightDur: 2.4, lightPower: 1.4 });
  CAM(80.4, [
    { t: 80.4, x: 0, y: -100, zoom: 0.78, ease: 'inOutCubic' },
    { t: 83.4, x: -80, y: -110, zoom: 1.02, ease: 'inOutCubic' },
    { t: 86.4, x: 90, y: -110, zoom: 1.08, ease: 'inOutCubic' },
    { t: 88.6, x: 0, y: -118, zoom: 0.9, ease: 'inOutCubic' },
  ], { push: 1.2 });

  // --- 89.0 FIRE + WIND escalation: Sasuke's great fireball vs Naruto's clones
  S.titles.push({ t: 89.2, dur: 3.0, kind: 'line', text: '“KATON: GŌKAKYŪ NO JUTSU!”' });
  K(89.2, 150, 'fireball', { emit: 0.55 });
  const bigFire = 89.75;
  FX({
    t: bigFire, kind: 'fireball', x: 140, y: -118, size: 66, seed: 220, life: 1.6,
    path: (age) => ({ x: lerp(140, -120, clamp01(age / 1.5)), y: -110 - Math.sin(clamp01(age / 1.5) * Math.PI) * 26 }),
    light: '255,150,60', lightDur: 1.8, lightPower: 1.5,
  });
  SFX(bigFire, 'bigFire', { dur: 1.7 });
  S.events.push({ t: bigFire, kind: 'flash', light: '255,150,60', lightDur: 1.8, lightPower: 1.4 });
  CAM(89.4, [
    { t: 89.4, x: 90, y: -112, zoom: 1.04, ease: 'inOutCubic' },
    { t: 90.6, x: 20, y: -112, zoom: 0.88, ease: 'outExpo' },
    { t: bigFire + 1.5, x: -20, y: -112, zoom: 0.94, ease: 'inOutCubic' },
  ], { push: 1.4 });
  // Naruto answers with a wall of clones that body-block the fireball
  N(89.6, -120, 'seal', {});
  SFX(90.0, 'kagebunshin', {});
  const wall = [-150, -136, -122, -108, -94, -80];
  wall.forEach((cx, i) => {
    const t = 90.15 + i * 0.05;
    FX({ t, kind: 'puff', x: cx, y: -100, n: 14, power: 1.0, seed: 230 + i, dur: 0.7 });
    const id = `w${i}`;
    S.cloneTracks.push({ id, birth: t, death: bigFire + 1.36 + i * 0.02 });
    CL(id, t, cx, 'guardLow', {});
  });
  // hit the fireball
  const fireHit = bigFire + 1.28;
  FX({ t: fireHit, kind: 'impact', x: -70, y: -100, size: 170, seed: 240, col: '255,180,90', dur: 0.6, spikes: 15 });
  FX({ t: fireHit, kind: 'burstRing', x: -70, y: -100, r1: 250, dur: 0.7, col: '255,170,80', w: 24 });
  FX({ t: fireHit, kind: 'dust', x: -70, y: -2, n: 36, power: 2.4, dur: 2.4, seed: 241, col: '130,105,85' });
  FX({ t: fireHit, kind: 'sparks', x: -70, y: -100, n: 30, power: 2.0, seed: 242, spread: 3.0, g: 1 });
  S.events.push({ t: fireHit, kind: 'explode', amp: 22, sfx: 'explosion2', light: '255,170,80', lightDur: 1.6, lightPower: 1.8 });
  // all clones pop
  wall.forEach((cx, i) => {
    FX({ t: fireHit + 0.02 * i, kind: 'puff', x: cx, y: -100, n: 16, power: 1.2, seed: 250 + i, dur: 0.8 });
  });
  N(90.2, -140, 'jump', { u0: 0, dur: 0.6, airborne: [90.3, 91.6], dy: -170 });
  N(90.9, -140, 'guard', {});
  N(91.6, -60, 'land', { u0: 0.2, dur: 0.5 });
  N(91.9, -60, 'guard', { breath: 1.6, aura: 1 });
  S.cracks.push({ t: fireHit, x: -70, power: 1.3, depth: 0.7, seed: 243 });

  // --- 93.0 Sasuke shadows Naruto's clones with lightning clones
  S.titles.push({ t: 93.2, dur: 3.2, kind: 'chapter', text: 'ACT IV', sub: 'storm against wind' });
  K(93.4, 140, 'seal', {});
  SFX(93.8, 'chidoriCharge', { dur: 1.4 });
  const sClones = [120, 148, 176, 204, 232];
  sClones.forEach((cx, i) => {
    const t = 94.0 + i * 0.07;
    FX({ t, kind: 'chidori', x: cx, y: -112, size: 22, seed: 260 + i, amp: 0.9 });
    FX({ t, kind: 'puff', x: cx, y: -110, n: 10, power: 0.8, seed: 270 + i, dur: 0.6 });
    const id = `s${i}`;
    S.cloneTracks.push({ id, birth: t, death: 95.4 + i * 0.24 + 0.3 });
    CLS(id, t, cx, 'chidoriCharge', { hold: true, sharingar: 1, sharingan: 1 });
  });
  CAM(93.4, [
    { t: 93.4, x: -20, y: -112, zoom: 0.94, ease: 'inOutCubic' },
    { t: 95.2, x: 60, y: -118, zoom: 0.82, ease: 'inOutCubic' },
  ]);
  // both armies charge
  sClones.forEach((cx, i) => {
    CLS(`s${i}`, 94.6 + i * 0.05, cx, 'chidoriDash', { u0: 0, hitAt: 0.52, dir: -1 });
  });
  N(94.6, -60, 'run', { u0: 0, speed: 320, dur: 0.9 });
  SFX(94.6, 'armyCharge', {});
  // impacts across the field
  for (let i = 0; i < 7; i++) {
    const t = 95.4 + i * 0.24;
    const x = 120 - i * 28;
    FX({ t, kind: 'impact', x, y: -108 + (i % 3) * 12, size: 46, seed: 280 + i, col: '205,230,255', dur: 0.34, spikes: 10 });
    FX({ t, kind: 'sparks', x, y: -108 + (i % 3) * 12, n: 14, power: 1.1, seed: 290 + i, spread: 3.2, dur: 0.42 });
    FX({ t: t + 0.05, kind: 'puff', x: x + 20, y: -104, n: 12, power: 1.0, seed: 300 + i, dur: 0.7 });
    S.events.push({ t, kind: 'hit', x, y: -108, amp: 6, sfx: i % 2 ? 'lightningHit' : 'poof' });
  }
  CAM(95.2, [
    { t: 95.2, x: 60, y: -118, zoom: 0.82, ease: 'outCubic' },
    { t: 97.6, x: -10, y: -112, zoom: 1.0, ease: 'inOutCubic' },
  ], { push: 1.6 });

  // --- 97.6 the real Sasuke drops in from above with a lightning-charged strike
  K(97.0, 60, 'jump', { u0: 0.2, dur: 0.5, airborne: [97.1, 97.9], dy: -200 });
  K(97.5, 60, 'chidoriDash', { u0: 0.32, dur: 0.5 });
  N(97.6, -60, 'blockHit', {});
  const sStrike = 97.78;
  FX({ t: sStrike, kind: 'impact', x: -38, y: -110, size: 80, seed: 310, col: '190,225,255', dur: 0.4, spikes: 14 });
  FX({ t: sStrike, kind: 'chidori', x: -36, y: -110, size: 34, seed: 311, amp: 1.5 });
  S.events.push({ t: sStrike, kind: 'bigHit', amp: 15, sfx: 'lightningHit', light: '160,210,255', lightPower: 1.6 });
  N(97.9, -76, 'hitHeavy', {});
  N(98.4, -120, 'land', { u0: 0.05, dur: 0.45 });
  FX({ t: 98.4, kind: 'dust', x: -120, y: -2, n: 20, power: 1.4, dur: 1.5, seed: 312 });
  S.cracks.push({ t: 98.4, x: -120, power: 0.8, depth: 0.5, seed: 313 });
  CAM(97.2, [
    { t: 97.2, x: -10, y: -112, zoom: 1.0, ease: 'outExpo' },
    { t: 97.9, x: -46, y: -116, zoom: 1.3, ease: 'outExpo' },
    { t: 98.8, x: -80, y: -110, zoom: 1.0, ease: 'inOutCubic' },
  ], { push: 1.2 });

  // --- 99.0 Naruto gets back up, both are glowing; the fight becomes a duel
  N(99.4, -120, 'getUp', { dur: 0.9 });
  N(100.2, -120, 'guard', { breath: 1.8, aura: 1 });
  K(99.0, 30, 'guard', { breath: 1.6, aura: 1, sharingan: 1 });
  S.titles.push({ t: 100.4, dur: 3.4, kind: 'line', text: '“Then I’ll drag you back myself!”' });
  S.audio.push({ t: 100.4, id: 'voiceNaruto4' });

  // --- 101-115 high-speed duel with speed lines + alternated camera angles
  CAM(101.4, [
    { t: 101.4, x: -40, y: -110, zoom: 1.06, ease: 'inOutCubic' },
    { t: 104.0, x: 10, y: -130, zoom: 1.2, ease: 'inOutCubic' },
    { t: 107.0, x: -20, y: -100, zoom: 0.95, ease: 'inOutCubic' },
    { t: 110.0, x: 30, y: -140, zoom: 1.24, ease: 'inOutCubic' },
    { t: 113.0, x: -10, y: -110, zoom: 1.02, ease: 'inOutCubic' },
  ], { push: 1.8 });
  const duel = [
    [101.5, -90, 30, 'jab', 'block'],
    [101.95, -80, 20, 'cross', 'blockHit'],
    [102.4, -70, 10, 'kickMid', 'block'],
    [102.9, -60, 0, 'hook', 'dodge'],
    [103.4, -50, -6, 'uppercut', 'blockHit'],
    [103.9, -42, -10, 'jab', 'block'],
    [104.4, -34, -14, 'cross', 'blockHit'],
  ];
  for (const [t, nx, sx, nc, sc] of duel) {
    N(t, nx, nc, { hitAt: 0.36, aura: 1 });
    if (sc === 'dodge') K(t, sx, 'backdash', { u0: 0.05, speed: 300, dur: 0.28 });
    else K(t, sx, sc, { aura: 1 });
    const ht = t + 0.13;
    FX({ t: ht, kind: 'sparks', x: (nx + sx) / 2, y: -112, n: 10, power: 0.9, seed: 320 + Math.round(t * 10), spread: 2.4, dur: 0.3 });
    S.events.push({ t: ht, kind: 'hit', x: (nx + sx) / 2, y: -112, amp: 4.5, sfx: sc === 'block' ? 'block' : 'block2' });
  }
  // Sasuke answers
  for (let i = 0; i < 6; i++) {
    const t = 104.9 + i * 0.34;
    K(t, -14 + i * 2, i % 2 ? 'cross' : 'kickMid', { hitAt: 0.36, aura: 1 });
    N(t, -34 + i * 2, i % 2 ? 'blockHit' : 'block', { aura: 1 });
    FX({ t: t + 0.13, kind: 'impact', x: -24 + i * 2, y: -112, size: 26, seed: 330 + i, col: '215,235,255', dur: 0.24 });
    S.events.push({ t: t + 0.13, kind: 'hit', x: -24, y: -112, amp: 4.4, sfx: i % 2 ? 'block2' : 'block' });
  }
  SFX(101.5, 'duel', { dur: 5 });

  // --- 107 both take it to the air: continuous aerial sequence
  N(107.0, -40, 'jump', { u0: 0, dur: 0.6, airborne: [107.1, 108.4], dy: -180 });
  K(107.05, -8, 'jump', { u0: 0, dur: 0.6, airborne: [107.1, 108.4], dy: -180 });
  CAM(107.0, [
    { t: 107.0, x: -20, y: -100, zoom: 0.95, ease: 'outCubic' },
    { t: 108.3, x: -24, y: -190, zoom: 1.1, ease: 'inOutCubic' },
    { t: 110.2, x: -10, y: -170, zoom: 1.18, ease: 'inOutCubic' },
  ]);
  for (let i = 0; i < 5; i++) {
    const t = 107.5 + i * 0.3;
    N(t, -30 + i * 4, i % 2 ? 'kickHigh' : 'jab', { hitAt: 0.36, dy: -170, aura: 1 });
    K(t, 0 - i * 4, i % 2 ? 'block' : 'blockHit', { dy: -170, aura: 1 });
    FX({ t: t + 0.12, kind: 'impact', x: -14, y: -180, size: 30, seed: 340 + i, col: '230,240,255', dur: 0.26 });
    S.events.push({ t: t + 0.12, kind: 'hit', x: -14, y: -180, amp: 5, sfx: 'block' });
  }
  N(109.2, -46, 'land', { u0: 0.1, dur: 0.5 });
  K(109.25, -2, 'land', { u0: 0.1, dur: 0.5 });
  FX({ t: 109.5, kind: 'dust', x: -46, y: -2, n: 16, power: 1.2, dur: 1.3, seed: 350 });
  FX({ t: 109.55, kind: 'dust', x: -2, y: -2, n: 16, power: 1.2, dur: 1.3, seed: 351 });

  // --- 110.4 Sasuke's fire phoenix volley
  K(110.4, 30, 'seal', {});
  SFX(110.7, 'seal', {});
  CAM(110.2, [
    { t: 110.2, x: 10, y: -140, zoom: 1.18, ease: 'inOutCubic' },
    { t: 112.2, x: 6, y: -112, zoom: 0.98, ease: 'inOutCubic' },
  ]);
  for (let i = 0; i < 6; i++) {
    const t = 111.2 + i * 0.16;
    const y0 = -140 + i * 14;
    FX({
      t, kind: 'fireball', x: 22, y: y0, size: 20, seed: 360 + i, life: 0.9,
      path: (age) => ({ x: lerp(22, -70 - i * 10, clamp01(age / 0.8)), y: y0 + Math.sin(age * 6 + i) * 12 }),
    });
    N(t + 0.55, -60 - i * 12, 'flip', { u0: 0.05, dur: 0.4, spin: 0.7, dy: -10 });
    FX({ t: t + 0.82, kind: 'impact', x: -90 - i * 14, y: -20, size: 40, seed: 370 + i, col: '255,170,90', dur: 0.3 });
  }
  SFX(111.2, 'fireVolley', { dur: 1.2 });
  S.events.push({ t: 111.2, kind: 'flash', light: '255,160,80', lightDur: 1.4, lightPower: 1.2 });

  // --- 113.2 Naruto lands from the last flip and answers with a rasengan barrage
  N(113.6, -70, 'rasenganCharge', { hold: true, aura: 1 });
  FX({ t: 113.9, kind: 'rasengan', who: 'n', hand: 'frontHand', x: 0, y: 0, size: 22, seed: 380, grow: 0.4, dur: 1.6, light: '120,200,255', lightPower: 1.3, lightDur: 1.0 });
  SFX(113.9, 'rasenganCharge', { dur: 0.9 });
  N(114.6, -70, 'rasenganThrust', { hitAt: 0.34, aura: 1 });
  FX({ t: 114.4, kind: 'streak', x: -70, y: -110, n: 14, len: 110, h: 80, seed: 381, dur: 0.4, dx: -1 });
  K(114.6, 10, 'block', {});
  FX({ t: 114.9, kind: 'impact', x: -8, y: -112, size: 76, seed: 382, col: '180,235,255', dur: 0.4, spikes: 12 });
  FX({ t: 114.9, kind: 'burstRing', x: -8, y: -112, r1: 150, dur: 0.5, col: '150,215,255', w: 16 });
  S.events.push({ t: 114.9, kind: 'bigHit', amp: 14, sfx: 'rasenganHit', light: '150,215,255', lightPower: 1.5 });
  K(115.1, 40, 'hitHeavy', {});
  K(115.6, 90, 'land', { u0: 0, dur: 0.4 });
  FX({ t: 115.75, kind: 'dust', x: 90, y: -2, n: 22, power: 1.6, dur: 1.6, seed: 383 });
  S.cracks.push({ t: 115.75, x: 90, power: 0.85, depth: 0.5, seed: 384 });

  // =========================================================================
  // ACT IV end → ACT V: FINAL CLASH (117 - 258)
  // =========================================================================
  CAM(116.2, [
    { t: 116.2, x: 20, y: -110, zoom: 1.0, ease: 'inOutCubic' },
    { t: 119.0, x: 0, y: -104, zoom: 0.82, ease: 'inOutCubic' },
  ]);
  N(117.0, -80, 'guard', { breath: 1.8, aura: 1 });
  K(117.6, 86, 'getUp', { dur: 1.1 });
  K(118.8, 84, 'guard', { breath: 1.8, aura: 1, sharingan: 1 });
  S.titles.push({ t: 118.4, dur: 3.6, kind: 'chapter', text: 'ACT V', sub: 'the last word' });

  // --- 120 slow circling / staring down (tension beat)
  CAM(120.0, [
    { t: 120.0, x: 0, y: -104, zoom: 0.82, ease: 'inOutCubic' },
    { t: 124.0, x: -30, y: -114, zoom: 1.16, ease: 'inOutCubic' },
    { t: 127.0, x: 30, y: -114, zoom: 1.06, ease: 'inOutCubic' },
    { t: 130.0, x: 0, y: -110, zoom: 0.9, ease: 'inOutCubic' },
  ], { push: 0.6, breath: 1.6 });
  N(120.4, -80, 'walk', { u0: 0.2, speed: 22, dur: 3.0 });
  K(120.4, 84, 'walk', { u0: 0.7, speed: 20, dur: 3.0, facing: -1 });
  S.titles.push({ t: 121.0, dur: 3.4, kind: 'line', text: '“Why won’t you just give up?”' });
  S.audio.push({ t: 121.0, id: 'voiceSasuke4' });
  N(125.0, -80, 'guard', { breath: 2.0, aura: 1 });
  K(125.0, 84, 'guard', { breath: 2.0, aura: 1, sharingan: 1 });
  S.titles.push({ t: 126.2, dur: 3.4, kind: 'line', text: '“Because you’re my friend. That’s all.”' });
  S.audio.push({ t: 126.2, id: 'voiceNaruto5' });

  // --- 129 both begin the final charge: long windup, cross-cut
  K(129.4, 84, 'chidoriCharge', { hold: true, aura: 1, sharingan: 1 });
  FX({ t: 129.9, kind: 'chidori', who: 's', hand: 'frontHand', x: 0, y: 0, size: 30, seed: 400, amp: 1.3, dur: 36, fade: 165.2, light: '150,200,255', lightDur: 3.4, lightPower: 1.7 });
  SFX(129.9, 'chidoriCharge', { dur: 3.2 });
  for (let i = 0; i < 14; i++) {
    FX({ t: 130.2 + i * 0.2, kind: 'chidori', who: 's', hand: 'chest', offX: (i % 3 - 1) * 12, offY: (i % 2 ? 22 : -22), x: 0, y: 0, size: 16, seed: 410 + i, amp: 0.9, dur: 0.9 });
  }
  S.titles.push({ t: 130.0, dur: 2.6, kind: 'line', text: '“CHIDORI!”', who: 'sasuke' });
  S.audio.push({ t: 130.0, id: 'voiceSasuke5' });
  CAM(129.2, [
    { t: 129.2, x: 60, y: -116, zoom: 1.1, ease: 'inOutCubic' },
    { t: 131.6, x: 56, y: -118, zoom: 1.32, ease: 'inOutCubic' },
    { t: 133.2, x: -60, y: -118, zoom: 1.32, ease: 'inOutCubic' },
  ], { push: 1.0 });

  // cross-cut to Naruto
  N(131.4, -80, 'kneel', {});
  N(132.6, -80, 'powerUp', { dur: 1.8, aura: 1 });
  SFX(132.6, 'powerUp', { dur: 1.8 });
  S.events.push({ t: 134.2, kind: 'powerSurge', amp: 10, sfx: 'surge', light: '255,190,90', lightDur: 2.0, lightPower: 1.6 });
  N(134.4, -80, 'rasenganCharge', { hold: true, aura: 1 });
  FX({ t: 134.6, kind: 'rasengan', who: 'n', hand: 'frontHand', x: 0, y: 0, size: 34, seed: 420, grow: 0.8, dur: 32, fade: 165.2, light: '120,200,255', lightDur: 3.2, lightPower: 1.8 });
  SFX(134.6, 'rasenganCharge', { dur: 3.0 });
  S.titles.push({ t: 134.6, dur: 2.6, kind: 'line', text: '“RASENGAN!”', who: 'naruto' });
  S.audio.push({ t: 134.6, id: 'voiceNaruto6' });
  for (let i = 0; i < 12; i++) {
    FX({ t: 134.8 + i * 0.2, kind: 'puff', x: -98 + (i % 3 - 1) * 16, y: -116, n: 6, power: 0.6, seed: 430 + i, dur: 0.7 });
  }
  CAM(133.0, [
    { t: 133.0, x: -60, y: -118, zoom: 1.32, ease: 'inOutCubic' },
    { t: 136.0, x: -58, y: -120, zoom: 1.4, ease: 'inOutCubic' },
    { t: 138.0, x: 0, y: -130, zoom: 0.8, ease: 'inOutCubic' },
  ], { push: 1.0 });

  // --- 138 BOTH CHARGING: extreme wide, sky darkens
  S.skyKey = S.skyKey || [];
  S.skyKey.push({ t: 128, top: [30, 34, 62], mid: [58, 56, 92], bottom: [120, 92, 92], ground: [46, 40, 42], haze: [140, 110, 100], sunColor: '255,190,140', sunA: 0.9, mote: '255,230,190' });
  S.skyKey.push({ t: 138, top: [26, 28, 50], mid: [58, 44, 72], bottom: [118, 78, 82], ground: [44, 36, 40], haze: [140, 110, 110], sunColor: '255,170,140', sunA: 0.9, mote: '255,220,190' });
  S.skyKey.push({ t: 148, top: [22, 22, 44], mid: [46, 38, 66], bottom: [96, 70, 82], ground: [38, 34, 40], haze: [120, 104, 118], sunColor: '255,150,130', sunA: 0.85, mote: '210,225,255' });
  S.skyKey.push({ t: 165, top: [26, 24, 46], mid: [56, 42, 68], bottom: [110, 76, 86], ground: [42, 36, 42], haze: [130, 110, 120], sunColor: '255,160,140', sunA: 0.9, mote: '215,228,255' });
  S.skyKey.push({ t: 200, top: [12, 12, 30], mid: [34, 26, 52], bottom: [86, 54, 68], ground: [28, 24, 30], haze: [110, 88, 100], sunColor: '255,170,130', sunA: 0.85, mote: '230,225,255' });
  S.skyKey.push({ t: 230, top: [34, 30, 50], mid: [90, 70, 84], bottom: [170, 140, 120], ground: [60, 52, 50], haze: [200, 180, 170], sunColor: '255,235,210', sunA: 1, mote: '255,250,240' });
  S.skyKey.push({ t: 258, top: [40, 38, 58], mid: [100, 84, 96], bottom: [186, 158, 136], ground: [66, 58, 56], haze: [210, 190, 180], sunColor: '255,240,220', sunA: 1, mote: '255,255,250' });

  // rising debris / rocks floating during the charge (classic power trope)
  for (let i = 0; i < 22; i++) {
    const t0 = 139 + i * 0.22;
    const x = -160 + (i * 37) % 320;
    FX({ t: t0, kind: 'debris', x, y: -4, n: 3, power: 0.7, dur: 4.0, seed: 440 + i, groundY: -999 });
  }
  S.events.push({ t: 138.5, kind: 'charge', amp: 6, sfx: 'chargeAmbient', light: '255,210,150', lightDur: 20, lightPower: 0.55 });
  SFX(138.2, 'chargeAmbient', { dur: 20 });

  CAM(138.0, [
    { t: 138.0, x: 0, y: -130, zoom: 0.8, ease: 'inOutCubic' },
    { t: 142.0, x: 0, y: -104, zoom: 0.74, ease: 'outCubic' },
    { t: 147.0, x: 0, y: -100, zoom: 0.8, ease: 'inOutSine' },
  ], { push: 0.8, breath: 2.5 });

  // slow orbiting close-ups
  CAM(147.0, [
    { t: 147.0, x: -80, y: -120, zoom: 1.5, ease: 'inOutCubic' },
    { t: 151.0, x: -78, y: -122, zoom: 1.34, ease: 'inOutSine' },
    { t: 155.0, x: 84, y: -120, zoom: 1.5, ease: 'inOutCubic' },
    { t: 159.0, x: 82, y: -122, zoom: 1.3, ease: 'inOutSine' },
    { t: 163.0, x: 0, y: -118, zoom: 0.86, ease: 'inOutCubic' },
  ], { push: 0.7, breath: 1.8 });

  // wind rising, dust streaming
  for (let i = 0; i < 16; i++) {
    FX({ t: 148 + i * 0.9, kind: 'dust', x: -200 + (i * 53) % 400, y: -4, n: 10, power: 1.4, dur: 2.6, seed: 460 + i, col: '150,140,140', alpha: 0.16, wind: 8 });
  }

  // --- 165 final charge: both run across a collapsing battlefield
  N(163.6, -80, 'dash', { u0: 0, speed: 300, dur: 0.5, aura: 1 });
  K(163.6, 84, 'chidoriDash', { u0: 0, dur: 0.5, aura: 1, sharingan: 1 });
  CAM(163.2, [
    { t: 163.2, x: 0, y: -120, zoom: 0.72, ease: 'outCubic' },
    { t: 166.0, x: 0, y: -120, zoom: 0.62, ease: 'inOutCubic' },
    { t: 169.0, x: 0, y: -124, zoom: 1.1, ease: 'inOutCubic' },
  ], { push: 1.6 });

  // ground tearing between them
  for (let i = 0; i < 8; i++) {
    const t = 165.4 + i * 0.28;
    const x = -60 + i * 18;
    FX({ t, kind: 'dust', x, y: -2, n: 10, power: 1.3, dur: 1.2, seed: 470 + i });
    FX({ t, kind: 'debris', x, y: -4, n: 6, power: 1.2, dur: 1.0, seed: 480 + i });
    S.cracks.push({ t, x, power: 0.5, depth: 0.5, seed: 490 + i });
  }
  S.events.push({ t: 166, kind: 'rumble', amp: 5, sfx: 'rumble' });

  // the moment of contact — slow motion begins
  const clashT = 168.6;
  N(168.4, -46, 'clash', { hold: true, aura: 1 });
  K(168.4, 48, 'clash', { hold: true, aura: 1, sharingan: 1 });
  S.titles.push({ t: 168.3, dur: 2.4, kind: 'line', text: '“RASENGAN!!”  /  “CHIDORI!!”' });

  FX({ t: clashT, kind: 'collision', x: 0, y: -126, size: 90, seed: 500, ramp: 3.0, light: '255,210,150', lightDur: 30, lightPower: 2.4 });
  FX({ t: clashT, kind: 'burstRing', x: 0, y: -126, r1: 300, dur: 0.6, col: '255,255,240', w: 34 });
  FX({ t: clashT, kind: 'impact', x: 0, y: -126, size: 220, seed: 501, col: '255,255,245', dur: 0.55, spikes: 18 });
  FX({ t: clashT, kind: 'shock', x: 0, y: -2, r0: 20, r1: 400, dur: 1.2, squash: 0.2, w: 24, col: '255,240,210' });
  FX({ t: clashT, kind: 'dust', x: 0, y: -2, n: 40, power: 2.8, dur: 3.2, seed: 502 });
  FX({ t: clashT, kind: 'debris', x: 0, y: -6, n: 26, power: 2.6, dur: 2.4, seed: 503 });
  S.events.push({ t: clashT, kind: 'clash', amp: 30, sfx: 'finalClash' });
  SFX(clashT, 'finalClash', {});
  S.cracks.push({ t: clashT, x: 0, power: 1.6, depth: 0.8, seed: 504 });
  S.cracks.push({ t: clashT + 0.2, x: -40, power: 1.2, depth: 0.6, seed: 505 });
  S.cracks.push({ t: clashT + 0.3, x: 44, power: 1.2, depth: 0.6, seed: 506 });

  // continuous clashes during the face-off
  for (let i = 0; i < 26; i++) {
    const t = clashT + 0.3 + i * 0.34;
    FX({ t, kind: 'sparks', x: (i % 2 ? 24 : -24), y: -126 + (i % 4 - 1.5) * 22, n: 10, power: 1.5, seed: 510 + i, ang: Math.PI / 2, spread: 2.8, dur: 0.5 });
    FX({ t: t + 0.08, kind: 'impact', x: 0, y: -126, size: 40, seed: 540 + i, col: '255,235,200', dur: 0.24, spikes: 7 });
    S.events.push({ t, kind: 'pressure', amp: 4, sfx: 'crackle' });
  }
  // slow motion camera on the collision
  CAM(168.2, [
    { t: 168.2, x: 0, y: -124, zoom: 1.1, ease: 'outExpo' },
    { t: 168.7, x: 0, y: -128, zoom: 1.5, ease: 'outCubic' },
    { t: 172.0, x: 0, y: -130, zoom: 1.58, ease: 'inOutSine' },
    { t: 176.0, x: 0, y: -126, zoom: 1.28, ease: 'inOutSine' },
    { t: 180.0, x: 0, y: -128, zoom: 0.9, ease: 'inOutCubic' },
  ], { push: 2.4, breath: 2.4 });
  S.slowmo = [{ t0: 168.6, t1: 174.0, rate: 0.35 }, { t0: 185.0, t1: 189.0, rate: 0.45 }];

  // --- 181 the clash grows: both push harder, energy dome forms
  S.titles.push({ t: 181.0, dur: 3.4, kind: 'line', text: 'Neither will yield.' });
  for (let i = 0; i < 10; i++) {
    const t = 181 + i * 0.5;
    FX({ t, kind: 'burstRing', x: 0, y: -126, r1: 200 + i * 30, dur: 0.8, col: '255,240,215', w: 18, alpha: 0.6 });
    S.events.push({ t, kind: 'rumble', amp: 6, sfx: 'rumble' });
  }
  S.events.push({ t: 181, kind: 'dome', amp: 8, sfx: 'dome', light: '255,230,190', lightDur: 24, lightPower: 1.4 });
  SFX(181.0, 'dome', { dur: 24 });
  CAM(180.0, [
    { t: 180.0, x: 0, y: -128, zoom: 0.9, ease: 'inOutCubic' },
    { t: 184.0, x: 0, y: -130, zoom: 0.6, ease: 'inOutCubic' },
    { t: 189.0, x: 0, y: -132, zoom: 1.02, ease: 'inOutCubic' },
    { t: 192.0, x: 0, y: -140, zoom: 1.2, ease: 'inOutSine' },
  ], { push: 1.6, breath: 2.6 });

  // --- 193 memories / white flash beat: both silhouettes, slowed
  FX({ t: 193.0, kind: 'burstRing', x: 0, y: -130, r1: 420, dur: 0.9, col: '255,255,255', w: 40 });
  S.titles.push({ t: 193.2, dur: 4.0, kind: 'line', text: '“...you really are an idiot.”' });
  S.audio.push({ t: 193.2, id: 'voiceSasuke6' });
  S.titles.push({ t: 197.6, dur: 3.6, kind: 'line', text: '“Yeah. Your idiot.”' });
  S.audio.push({ t: 197.6, id: 'voiceNaruto7' });
  CAM(193.0, [
    { t: 193.0, x: 0, y: -140, zoom: 1.2, ease: 'inOutCubic' },
    { t: 196.6, x: -30, y: -132, zoom: 1.46, ease: 'inOutCubic' },
    { t: 200.0, x: 30, y: -132, zoom: 1.46, ease: 'inOutCubic' },
  ], { push: 0.6, breath: 2.0 });

  // --- 201 final expansion: the sphere engulfs everything
  const nova = 201.5;
  FX({ t: nova, kind: 'collision', x: 0, y: -128, size: 150, seed: 600, ramp: 0.2, light: '255,255,255', lightDur: 22, lightPower: 2.6 });
  FX({ t: nova, kind: 'burstRing', x: 0, y: -128, r1: 700, dur: 1.4, col: '255,255,250', w: 60 });
  FX({ t: nova + 0.1, kind: 'burstRing', x: 0, y: -128, r1: 520, dur: 1.6, col: '255,220,180', w: 44 });
  FX({ t: nova + 0.2, kind: 'shock', x: 0, y: -2, r0: 40, r1: 900, dur: 1.8, squash: 0.16, w: 40, col: '255,250,235' });
  FX({ t: nova, kind: 'dust', x: 0, y: -2, n: 60, power: 3.4, dur: 4.0, seed: 601 });
  FX({ t: nova, kind: 'debris', x: 0, y: -6, n: 40, power: 3.4, dur: 3.2, seed: 602 });
  S.events.push({ t: nova, kind: 'nova', amp: 40, sfx: 'nova', light: '255,255,255', lightDur: 6, lightPower: 3.0 });
  SFX(nova, 'nova', {});
  S.skyKey.push({ t: 201, top: [10, 12, 26], mid: [26, 22, 46], bottom: [80, 56, 66], ground: [24, 22, 28], haze: [120, 100, 110], sunColor: '255,240,220', sunA: 0.6, mote: '255,255,255' });
  S.skyKey.push({ t: 206, top: [26, 26, 40], mid: [70, 60, 76], bottom: [140, 116, 112], ground: [48, 44, 46], haze: [180, 170, 170], sunColor: '255,250,240', sunA: 1.1, mote: '255,255,255' });
  CAM(200.8, [
    { t: 200.8, x: 0, y: -132, zoom: 1.46, ease: 'outExpo' },
    { t: nova, x: 0, y: -130, zoom: 1.6, ease: 'outExpo' },
    { t: nova + 0.4, x: 0, y: -128, zoom: 0.52, ease: 'outExpo' },
    { t: 206.0, x: 0, y: -122, zoom: 0.70, ease: 'inOutSine' },
    { t: 210.0, x: 0, y: -118, zoom: 0.84, ease: 'inOutCubic' },
  ], { push: 2.0, breath: 2.0 });

  // --- 206 ENDING: whiteout fades into an unresolved image
  // Both fighters remain standing inside the dome of light, fists/wrists locked.
  N(200.0, -30, 'clash', { hold: true, aura: 1 });
  K(200.0, 32, 'clash', { hold: true, aura: 1, sharingan: 1 });
  N(210.0, -30, 'clash', { hold: true, aura: 1 });
  K(210.0, 32, 'clash', { hold: true, aura: 1, sharingan: 1 });
  // energy dissipating, smoke rising
  for (let i = 0; i < 14; i++) {
    FX({ t: 210 + i * 0.7, kind: 'dust', x: -80 + i * 12, y: -2, n: 10, power: 1.2, dur: 3.4, seed: 610 + i, alpha: 0.16 });
  }
  for (let i = 0; i < 9; i++) {
    FX({ t: 214 + i * 0.9, kind: 'sparks', x: (i % 2 ? 30 : -30), y: -120 + (i % 3 - 1) * 26, n: 6, power: 0.8, seed: 620 + i, dur: 1.4, g: 0.5 });
  }
  S.titles.push({ t: 213.0, dur: 5.0, kind: 'final', text: 'NO ONE WINS', sub: 'the valley remembers' });

  // camera pulls back into a final wide, then slowly craning up to the sky
  CAM(210.0, [
    { t: 210.0, x: 0, y: -118, zoom: 0.84, ease: 'inOutCubic' },
    { t: 218.0, x: 10, y: -116, zoom: 0.86, ease: 'inOutCubic' },
    { t: 226.0, x: 0, y: -124, zoom: 1.06, ease: 'inOutCubic' },
    { t: 238.0, x: 0, y: -170, zoom: 0.9, ease: 'inOutSine' },
    { t: 248.0, x: 0, y: -240, zoom: 0.66, ease: 'inOutSine' },
    { t: 258.0, x: 0, y: -300, zoom: 0.56, ease: 'inOutSine' },
  ], { push: 0.8, breath: 1.6 });
  S.titles.push({ t: 228.0, dur: 5.5, kind: 'line', text: 'The clash ends. The question does not.' });
  S.titles.push({ t: 240.0, dur: 14.0, kind: 'credits', text: 'NARUTO  vs  SASUKE', sub: 'a stickman cinematic' });

  return S;
}

// Straight-line projectile path helper used above
function kunaiPath(x0, y0, x1, y1, t0, dur) {
  return (age) => {
    const u = clamp01(age / dur);
    return { x: lerp(x0, x1, u), y: lerp(y0, y1, u) - Math.sin(u * Math.PI) * 14 };
  };
}

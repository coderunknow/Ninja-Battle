// Audio mix regression suite. Offline, deterministic, no device required.
//
// These are the numbers that were actually broken and measured during the
// round-2 audio pass; every check below corresponds to a defect that existed:
//   * score sat at -29 LUFS and got quieter as layers came in
//   * 42% of the energy in 60-120 Hz, under 1% above 4 kHz
//   * master bus clipped at 0 dBFS on taiko transients (+6.9 dBFS in an early run)
//   * every scripted `voice*` cue was silently dropped
//   * engine.sfx() ignored opts.at, so a pre-planned cue all fired at t=0
//   * a fresh panner/send per note leaked into the audio graph
//
// NOT covered here: how it sounds on a real device, or realtime glitching.
// That requires a real browser + audio hardware and is reported separately.
import './_alsa-shim.mjs';
import { OfflineAudioContext } from 'node-web-audio-api';
import { compile } from '../src/scene/stage.js';
import { CUE_MAP } from '../src/audio/director.js';

const SR = 48000;
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  (' + detail + ')' : ''}`); return true; }
  fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`);
  return false;
}

class Shim extends OfflineAudioContext {
  constructor(len) { super({ numberOfChannels: 2, length: len, sampleRate: SR }); }
}
function freshEngine(lenSec) {
  globalThis.window = { AudioContext: class extends OfflineAudioContext {
    constructor() { super({ numberOfChannels: 2, length: Math.ceil(SR * lenSec), sampleRate: SR }); }
  } };
  return import('../src/audio/engine.js');
}

function analyse(buf) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let pk = 0, sq = 0, clipped = 0;
  for (let i = 0; i < L.length; i++) {
    const m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (m > pk) pk = m;
    if (m >= 0.999) clipped++;
    sq += L[i] * L[i] + R[i] * R[i];
  }
  return { pk, rms: Math.sqrt(sq / (2 * L.length)), clipped };
}

// Octave-band energy share via a plain DFT over a decimated copy (cheap + enough
// to catch gross tonal imbalance).
function bandShares(buf) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  // Average several windows across the whole buffer. Analysing only the first
  // third of a second made the sub-bass check vacuous: it happened to land on a
  // pad-only moment and "passed" at 0.05%.
  const all = buf.getChannelData ? bandSharesFrame(L, R, 0, Math.min(L.length, 1 << 14)) : null;
  const acc = all.shares.map(() => 0);
  let frames = 0;
  const stride = 1 << 14;
  for (let off = 0; off + stride <= L.length; off += stride) {
    const f = bandSharesFrame(L, R, off, stride);
    f.shares.forEach((v, i) => { acc[i] += v; });
    frames++;
  }
  return { shares: acc.map((v) => v / Math.max(1, frames)), bands: all.bands };
}

function bandSharesFrame(L, R, off, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (L[off + i] + R[off + i]) * 0.5 * w;
  }
  // iterative radix-2 FFT
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const bands = [[20, 60], [60, 120], [120, 250], [250, 500], [500, 1000], [1000, 2000],
    [2000, 4000], [4000, 8000], [8000, 16000], [16000, 24000]];
  const tot = bands.map(() => 0);
  let all = 0;
  for (let k = 1; k < n / 2; k++) {
    const f = (k * SR) / n;
    const p = re[k] * re[k] + im[k] * im[k];
    all += p;
    bands.forEach(([lo, hi], bi) => { if (f >= lo && f < hi) tot[bi] += p; });
  }
  return { shares: tot.map((v) => v / (all || 1)), bands };
}

// ---------------------------------------------------------------- 1. cue wiring
{
  const script = compile();
  const unmapped = [];
  for (const a of script.audio || []) if (!CUE_MAP[a.id]) unmapped.push(`audio:${a.id}`);
  for (const e of script.events || []) if (e.sfx && !CUE_MAP[e.sfx]) unmapped.push(`event:${e.sfx}`);
  check('every scripted cue id maps to an sfx', unmapped.length === 0, unmapped.slice(0, 6).join(','));

  // The engine must actually implement every id the director can emit.
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../src/audio/engine.js', import.meta.url), 'utf8'));
  const missing = [];
  for (const id of new Set(Object.values(CUE_MAP))) {
    if (!src.includes(`case '${id}'`)) missing.push(id);
  }
  check('engine implements every mapped sfx id', missing.length === 0, missing.join(','));

  // voice cues specifically: they were scripted but produced silence.
  const voices = (script.audio || []).filter((a) => a.id.startsWith('voice'));
  check('script contains character vocalisations', voices.length >= 8, `${voices.length} lines`);
  check('every voice line has a handler', voices.every((v) => src.includes(`case '${v.id}'`)));
}

// ---------------------------------------------------------------- 2. no clipping
{
  const { AudioEngine } = await freshEngine(8);
  const e = new AudioEngine(); await e.unlock(); e.setVolume(1);
  e.sfx('bigBoom', { at: 0.1 }); e.sfx('finalClash', { at: 0.3 });
  e.sfx('nova', { at: 0.5 }); e.sfx('taikoHit', { at: 0.7 });
  const a = analyse(await e.ctx.startRendering());
  check('extreme cue stack does not clip', a.clipped === 0 && a.pk <= 1,
    `peak ${(20 * Math.log10(a.pk)).toFixed(2)} dBFS, ${a.clipped} clipped`);
}

// ---------------------------------------------------------------- 3. opts.at honoured
{
  const { AudioEngine } = await freshEngine(4);
  const e = new AudioEngine(); await e.unlock(); e.setVolume(1);
  // The engine runs a permanent ambient wind bed; silence it so the probe only
  // sees the cue (the bed is verified separately by the mix analysis).
  e.wind.g.gain.value = 0;
  e.sfx('slam', { at: 2.0 });
  const buf = await e.ctx.startRendering();
  const L = buf.getChannelData(0);
  let early = 0, late = 0;
  for (let i = 0; i < Math.floor(SR * 1.2); i++) early = Math.max(early, Math.abs(L[i]));
  for (let i = Math.floor(SR * 2.0); i < Math.min(L.length, SR * 2.2); i++) late = Math.max(late, Math.abs(L[i]));
  check('sfx(at) is scheduled at that time, not at t=0', early < 1e-4 && late > 0.01,
    `pre ${early.toExponential(1)}, at ${late.toFixed(3)}`);
}

// ---------------------------------------------------------------- 4. graph stays bounded
{
  const { AudioEngine, musicInWindow } = await freshEngine(20);
  const e = new AudioEngine(); await e.unlock(); e.setVolume(1);
  let n = 0;
  for (const ev of musicInWindow(100, 116)) {
    if (ev.time < 100 || ev.time >= 116) continue;
    e._playNote(ev, ev.time - 100); n++;
  }
  const buses = (e.panBuses || []).length;
  check('per-note scheduling does not create a panner per note', buses > 0 && buses <= 16,
    `${buses} shared pan buses for ${n} notes`);
}

// ---------------------------------------------------------------- 5. tonal balance
{
  const { AudioEngine, musicInWindow } = await freshEngine(12);
  const e = new AudioEngine(); await e.unlock(); e.setVolume(1);
  for (const ev of musicInWindow(166, 178)) {
    if (ev.time < 166 || ev.time >= 178) continue;
    e._playNote(ev, ev.time - 166);
  }
  const buf = await e.ctx.startRendering();
  const a = analyse(buf);
  const { shares, bands } = bandShares(buf);
  const pct = (i) => shares[i] * 100;
  check('climax has no clipping', a.clipped === 0, `${a.clipped}`);
  check('climax sub-bass (20-60 Hz) is controlled', pct(0) < 8, `${pct(0).toFixed(1)}%`);
  check('climax is not dominated by 60-120 Hz', pct(1) < 40, `${pct(1).toFixed(1)}%`);
  check('climax has presence above 2 kHz', pct(6) + pct(7) + pct(8) > 3,
    `${(pct(6) + pct(7) + pct(8)).toFixed(1)}%`);
  check('climax has a usable midrange', pct(5) > 6, `1-2k ${pct(5).toFixed(1)}%`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:'); for (const f of failures) console.log(' - ' + f); process.exit(1); }

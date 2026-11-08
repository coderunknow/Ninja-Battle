// Renders the REAL soundtrack offline to a WAV file using node-web-audio-api
// (a full Web Audio implementation, not a stub). This is how the music and SFX
// are verified for real: we can measure levels, clipping, spectral balance and
// produce a file that can actually be listened to.
//
//   node tools/audio-render.mjs [t0] [seconds] [out.wav]
import './_alsa-shim.mjs';

const { OfflineAudioContext } = await import('node-web-audio-api');

const t0 = Number(process.argv[2] ?? 0);
const dur = Number(process.argv[3] ?? 20);
const outPath = process.argv[4] || `qa-out/audio-${t0}-${t0 + dur}.wav`;
const SR = 48000;

const LENGTH = Math.ceil(SR * dur);
globalThis.AudioContext = OfflineAudioContext;
// The engine calls new AudioContext({ latencyHint }); offline requires an object
// with explicit channel/length/rate, so provide a compatible shim constructor.
class OfflineShim extends OfflineAudioContext {
  constructor(opts = {}) {
    super({ numberOfChannels: 2, length: LENGTH, sampleRate: SR });
  }
}
globalThis.AudioContext = OfflineShim;
globalThis.window = { AudioContext: OfflineShim };

const { AudioEngine } = await import('../src/audio/engine.js');
const engine = new AudioEngine();
await engine.unlock();
// Override the clock-independent injection for offline use: the engine already
// owns the offline context because window.AudioContext is the OfflineAudioContext.
engine.setVolume(Number(process.env.VOL ?? 0.85));
// REVERB=0 is a profiling switch only: it isolates how much of the render cost
// is the convolution reverb.
if (process.env.REVERB === '0') { engine.musicReverb.gain.value = 0; engine.reverbGain.gain.value = 0; }

// Collect every musical event in the window exactly once. (Scheduling window by
// window double-fires events whose bar overlaps a boundary, which summed to
// +7 dBFS and 10% clipped samples in a first attempt — a harness bug, not an
// engine bug, but it is why this pass dedupes on note identity.)
const { musicInWindow } = await import('../src/audio/engine.js');
const seen = new Set();
let evCount = 0;
for (const ev of (process.env.MUSIC_ONLY === '1' ? [] : musicInWindow(t0, t0 + dur))) {
  const key = `${ev.time.toFixed(4)}|${ev.inst}|${ev.freq.toFixed(3)}|${ev.dur.toFixed(3)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const when = Math.max(0, ev.time - t0);
  if (when >= dur) continue;
  // ART overrides the per-note articulation gain. ART=1 forces a flat,
  // unridden arrangement, which is how the section mix ride below is calibrated.
  if (process.env.ART) ev.art = Number(process.env.ART);
  engine._playNote(ev, when);
  evCount++;
}

// ---- Sound effects.
// The film's soundtrack is not just music: the script carries timeline audio
// cues plus per-hit sfx events. Rendering only music would measure a mix that
// nobody ever hears, and would also miss the clipping that dense hits cause.
// Cue mapping is duplicated from AudioDirector (which is bound to a realtime
// clock) so this offline pass stays a pure function of the timeline.
// Imported from the director so the offline render can never drift from what the
// player actually triggers.
const { CUE_MAP } = await import('../src/audio/director.js');
let sfxCount = 0;
if (process.env.NO_SFX !== '1' && process.env.MUSIC_ONLY !== '1') {
  const { compile } = await import('../src/scene/stage.js');
  const script = compile();
  const sfxCues = [];
  for (const a of script.audio || []) {
    const mapped = CUE_MAP[a.id];
    if (mapped) sfxCues.push({ t: a.t, id: mapped, opts: { ...a } });
  }
  for (const e of script.events || []) {
    if (!e.sfx) continue;
    const mapped = CUE_MAP[e.sfx];
    if (!mapped) continue;
    const amp = e.amp ?? 6;
    sfxCues.push({ t: e.t, id: mapped, opts: { vol: Math.min(1.2, 0.45 + amp / 22) } });
  }
  const seenCue = new Set();
  for (const c of sfxCues) {
    if (c.t < t0 || c.t >= t0 + dur) continue;
    const key = `${c.t.toFixed(3)}|${c.id}`;
    if (seenCue.has(key)) continue;
    seenCue.add(key);
    engine.sfx(c.id, { ...c.opts, at: c.t - t0 });
    sfxCount++;
  }
}

// Optional SFX test: SFX_TEST="clash,nova" fires those cue ids evenly.
if (process.env.SFX_TEST) {
  const ids = process.env.SFX_TEST.split(',');
  ids.forEach((id, i) => engine.sfx(id, { at: (i + 0.5) * (dur / ids.length) }));
}

const buf = await engine.ctx.startRendering();
const L = buf.getChannelData(0);
const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;

let peak = 0, sumSq = 0, clipped = 0, nan = 0;
for (let i = 0; i < L.length; i++) {
  const l = L[i], r = R[i];
  if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; continue; }
  const m = Math.max(Math.abs(l), Math.abs(r));
  if (m > peak) peak = m;
  if (m >= 0.999) clipped++;
  sumSq += l * l + r * r;
}
const rms = Math.sqrt(sumSq / (2 * L.length));
const db = (v) => (v <= 1e-9 ? -Infinity : 20 * Math.log10(v));

console.log(`rendered ${dur}s @ ${t0}s  (${evCount} music events, ${sfxCount} sfx cues)`);
console.log(`  peak     ${peak.toFixed(4)}  (${db(peak).toFixed(1)} dBFS)`);
console.log(`  rms      ${rms.toFixed(4)}  (${db(rms).toFixed(1)} dBFS)`);
console.log(`  clipped  ${clipped} samples (${(clipped / L.length * 100).toFixed(3)}%)`);
console.log(`  non-finite ${nan}`);

// ---- WAV out
fs.mkdirSync('qa-out', { recursive: true });
const n = L.length;
const bufOut = Buffer.alloc(44 + n * 4);
bufOut.write('RIFF', 0); bufOut.writeUInt32LE(36 + n * 4, 4); bufOut.write('WAVE', 8);
bufOut.write('fmt ', 12); bufOut.writeUInt32LE(16, 16); bufOut.writeUInt16LE(1, 20);
bufOut.writeUInt16LE(2, 22); bufOut.writeUInt32LE(SR, 24);
bufOut.writeUInt32LE(SR * 4, 28); bufOut.writeUInt16LE(4, 32); bufOut.writeUInt16LE(16, 34);
bufOut.write('data', 36); bufOut.writeUInt32LE(n * 4, 40);
const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
for (let i = 0; i < n; i++) {
  bufOut.writeInt16LE(clamp16(L[i]), 44 + i * 4);
  bufOut.writeInt16LE(clamp16(R[i]), 46 + i * 4);
}
fs.writeFileSync(outPath, bufOut);
console.log(`  wrote ${outPath}`);

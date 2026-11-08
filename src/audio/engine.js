// Audio engine.
//
// Design
// ------
// * Everything is synthesised with the Web Audio API at runtime: no audio files,
//   nothing to license, no network fetch, no autoplay-blocking asset loads.
// * The score is *composed*, not randomised: fixed tempo, fixed key, authored
//   chord progression / bass line / melody motifs / drum patterns per section,
//   aligned to the act structure of the fight.
// * Music is generated as a pure function of transport time (`musicInWindow`), so
//   seeking, pausing and replaying all stay perfectly in sync with the picture.
//   A short look-ahead scheduler renders the notes ahead of the playhead.
// * Sound effects are fired from the same master timeline cue list, with de-duping
//   so that a seek never machine-guns every historical cue.
// * Respects autoplay policy: the context is created/resumed only after an
//   explicit user gesture (the Begin button, or any transport control).

import { clamp, clamp01, hash, hash2, lerp } from '../core/math.js';

const BPM = 84;
const SPB = 60 / BPM;          // seconds per beat
const BAR = SPB * 4;           // 4/4
const ROOT = 50;               // D3 (MIDI)

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// --- composition -------------------------------------------------------------
// Chord progressions: Dm - Bb - F - C  (i - VI - III - VII), the classic
// heroic-sad progression. Voiced as scale degrees relative to ROOT.
const PROGRESSIONS = [
  { name: 'heroic', chords: [[0, 3, 7], [-2, 3, 7], [3, 7, 10], [-2, 2, 5]] },
  { name: 'battle', chords: [[0, 3, 7], [5, 8, 12], [3, 7, 10], [-2, 2, 5]] },
  { name: 'dark', chords: [[0, 3, 7], [-4, 0, 3], [-2, 3, 7], [-5, -2, 2]] },
];

// Melodic motifs (scale-degree-ish semitone offsets, one entry per beat or half bar)
const MOTIF_A = [
  [0, 3, 7, 10], [7, 5, 3, 0], [3, 7, 10, 12], [-2, 2, 7, 3],
  [0, 3, 7, 10], [12, 10, 7, 5], [3, 5, 7, 10], [7, 3, 0, -2],
];
const MOTIF_B = [
  [7, 7, 10, 12], [14, 12, 10, 7], [10, 12, 14, 15], [12, 10, 7, 5],
  [7, 7, 10, 12], [15, 14, 12, 10], [12, 10, 7, 5], [3, 5, 7, 10],
];

/**
 * Sections drive arrangement density. Each entry:
 *   t0, t1   seconds
 *   prog     index into PROGRESSIONS
 *   ride     per-section mix gain, calibrated by rendering each section with a
 *            flat arrangement (makeup=1, art=1) and solving for the gain that
 *            hits the loudness each section should occupy in the arc
 *   intensity 0..1 (drives layers/velocity)
 *   layers   { pad, strings, brass, choir, taiko, hats, bass, lead, bell }
 */
const SECTIONS = [
  { t0: 0, t1: 26, prog: 0, intensity: 0.22, ride: 0.5094, layers: { pad: 1, bell: 1, bass: 0.5, choir: 0.35 } },
  { t0: 26, t1: 50, prog: 1, intensity: 0.55, ride: 0.3716, layers: { pad: 1, strings: 1, taiko: 1, hats: 0.5, bass: 1, lead: 0.55 } },
  { t0: 50, t1: 58, prog: 0, intensity: 0.3, ride: 0.2897, layers: { pad: 1, bell: 1, bass: 0.5 } },
  { t0: 58, t1: 80, prog: 1, intensity: 0.65, ride: 0.3017, layers: { pad: 1, strings: 1, taiko: 1, hats: 0.7, bass: 1, brass: 0.6, lead: 0.6 } },
  { t0: 80, t1: 100, prog: 0, intensity: 0.5, ride: 0.2005, layers: { pad: 1, choir: 1, strings: 0.7, taiko: 0.7, bass: 0.8, bell: 0.6 } },
  { t0: 100, t1: 132, prog: 1, intensity: 0.85, ride: 0.5195, layers: { pad: 1, strings: 1, taiko: 1, hats: 1, bass: 1, brass: 0.9, lead: 0.85, choir: 0.5 } },
  { t0: 132, t1: 166, prog: 2, intensity: 0.7, ride: 0.4635, layers: { pad: 1, choir: 1, strings: 0.8, taiko: 0.8, bass: 1, bell: 0.5 } },
  { t0: 166, t1: 182, prog: 1, intensity: 1.0, ride: 0.6318, layers: { pad: 1, strings: 1, taiko: 1, hats: 1, bass: 1, brass: 1, lead: 1, choir: 0.8 } },
  { t0: 182, t1: 201, prog: 0, intensity: 0.9, ride: 0.4683, layers: { pad: 1, choir: 1, strings: 0.9, taiko: 0.6, bass: 1, lead: 0.7 } },
  { t0: 201, t1: 216, prog: 0, intensity: 0.35, ride: 0.4013, layers: { pad: 1, choir: 0.8, bell: 0.7, bass: 0.4 } },
  { t0: 216, t1: 240, prog: 0, intensity: 0.5, ride: 0.4232, layers: { pad: 1, choir: 1, strings: 0.6, bell: 0.8, bass: 0.6, lead: 0.4 } },
  { t0: 240, t1: 999, prog: 0, intensity: 0.3, ride: 0.4577, layers: { pad: 1, choir: 0.7, bell: 0.6, bass: 0.3 } },
];

function sectionAt(t) {
  for (const s of SECTIONS) if (t >= s.t0 && t < s.t1) return s;
  return SECTIONS[SECTIONS.length - 1];
}

/**
 * All musical events that start within [t0, t1). Pure function of time.
 * Returns { time, inst, freq, dur, vel, pan }
 */
export function musicInWindow(t0, t1) {
  const out = [];
  const barIndex0 = Math.floor(t0 / BAR) - 1;
  const barIndex1 = Math.floor(t1 / BAR) + 1;
  for (let b = barIndex0; b <= barIndex1; b++) {
    const barT = b * BAR;
    if (barT > t1 + BAR || barT + BAR < t0) continue;
    const sec = sectionAt(barT + 0.001);
    const prog = PROGRESSIONS[sec.prog];
    const chord = prog.chords[((b % 8) + 8) % 8 % prog.chords.length];
    const L = sec.layers;
    const I = sec.intensity;
    const measure = ((b % 8) + 8) % 8;

    // Articulation scaling: voices are written for a solo/mid arrangement. A
    // section with 9 layers playing has to play each of them softer than a
    // 3-layer intro or the master bus just squashes everything into a wall.
    const art = clamp(1.25 - 0.72 * I, 0.42, 1.32) * sec.ride;

    const push = (time, inst, freq, dur, vel, pan = 0) => {
      if (time + dur < t0 || time > t1) return;
      out.push({ time, inst, freq, dur, vel, pan, art });
    };

    // ---- pad: sustained chord, one per bar
    if (L.pad) {
      chord.forEach((sd, i) => {
        push(barT, 'pad', midi(ROOT + sd - 12), BAR * 1.05, 0.16 * I + 0.05, (i - 1) * 0.16);
      });
      // airy fifth above for width
      push(barT, 'pad', midi(ROOT + chord[2] + 12), BAR * 0.95, 0.07 * I, 0.3);
    }

    // ---- bass: root on 1 and 3 (or driving eighths at high intensity)
    if (L.bass) {
      const root = ROOT + chord[0] - 14;
      if (I > 0.75) {
        for (let k = 0; k < 8; k++) {
          const tt = barT + k * (BAR / 8);
          push(tt, 'bass', midi(root + (k % 4 === 3 ? 7 : 0)), BAR / 8 * 0.9, 0.26 * I, 0);
        }
      } else {
        push(barT, 'bass', midi(root), BAR / 2 * 0.95, 0.24 * I + 0.06, 0);
        push(barT + BAR / 2, 'bass', midi(root + (measure % 2 ? 7 : 0)), BAR / 2 * 0.9, 0.2 * I + 0.05, 0);
      }
    }

    // ---- strings: ostinato in sixteenths (battle energy)
    if (L.strings) {
      const base = ROOT + chord[1] + 12;
      const patt = [0, 3, 7, 3, 0, 3, 7, 10];
      for (let k = 0; k < 16; k++) {
        if (I < 0.5 && k % 2) continue;
        const tt = barT + k * (BAR / 16);
        push(tt, 'strings', midi(base + patt[k % patt.length]), BAR / 16 * 0.85, (0.10 + 0.1 * I) * (k % 4 === 0 ? 1.3 : 1), (k % 2 ? 0.25 : -0.25));
      }
    }

    // ---- choir: long vowel swells, one per two bars
    if (L.choir && b % 2 === 0) {
      chord.forEach((sd, i) => {
        push(barT, 'choir', midi(ROOT + sd), BAR * 2 * 0.98, 0.14 * I + 0.04, (i - 1) * 0.25);
      });
    }

    // ---- brass: stabs on 2 and 4
    if (L.brass) {
      for (const k of [1, 3]) {
        const tt = barT + k * SPB;
        chord.forEach((sd, i) => {
          push(tt, 'brass', midi(ROOT + sd + 12), SPB * 0.55, 0.13 * I, (i - 1) * 0.2);
        });
      }
      // downbeat hit
      push(barT, 'brass', midi(ROOT + chord[0] - 12), SPB * 1.4, 0.16 * I, 0);
    }

    // ---- taiko
    if (L.taiko) {
      const patt = I > 0.8
        ? [1, 0, 1, 1, 0, 1, 0, 1]
        : I > 0.45 ? [1, 0, 0, 1, 0, 0, 1, 0] : [1, 0, 0, 0, 0, 0, 0, 0];
      for (let k = 0; k < 8; k++) {
        if (!patt[k]) continue;
        push(barT + k * (BAR / 8), 'taiko', 60 + (k === 0 ? -12 : 0), 0.42, (0.5 + 0.3 * I) * (k === 0 ? 1 : 0.7), (k % 2 ? 0.12 : -0.12));
      }
      // fill at the end of every 4 bars
      if (b % 4 === 3) {
        for (let k = 0; k < 4; k++) {
          push(barT + BAR - SPB + k * (SPB / 4), 'taiko', 66, 0.3, 0.35 + k * 0.09, 0);
        }
      }
    }

    // ---- hats / shaker
    if (L.hats) {
      for (let k = 0; k < 16; k++) {
        if (k % 2 && I < 0.9) continue;
        push(barT + k * (BAR / 16), 'hat', 0, 0.07, (0.07 + 0.05 * I) * (k % 4 === 0 ? 1.5 : 1), 0.3);
      }
    }

    // ---- lead melody: motif A in the first half, B later (builds)
    if (L.lead && (measure % 2 === 0 || I > 0.8)) {
      const motif = (sec.intensity > 0.75 ? MOTIF_B : MOTIF_A)[measure % 8];
      motif.forEach((sd, k) => {
        const tt = barT + k * SPB;
        push(tt, 'lead', midi(ROOT + sd + 12), SPB * 1.1, (0.11 + 0.1 * I) * (k === 0 ? 1.25 : 1), 0.08 * Math.sin(k));
      });
    }

    // ---- bell / celesta accents
    if (L.bell) {
      const marks = [[0, 0], [2, 7], [3, 12]];
      for (const [k, sd] of marks) {
        push(barT + k * SPB, 'bell', midi(ROOT + chord[0] + sd + 12), 1.6, 0.09 * I + 0.02, k % 2 ? 0.35 : -0.35);
      }
    }
  }
  return out;
}

// --- engine ------------------------------------------------------------------
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.volume = 0.85;
    this.muted = false;
    this.schedTime = 0;         // last transport time scheduled
    this.lastSfxT = -1;
    this.noiseBuf = null;
    this.irBuf = null;
    this.stats = { voices: 0 };
  }

  async unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // ---- master chain: buses -> master EQ -> compressor -> limiter -> out
    //
    // Offline analysis of the original chain measured -29 LUFS with 42% of the
    // energy in 60-120 Hz and under 1% above 4 kHz: too quiet, and muddy. The
    // fix is tonal first (carve the sub, lift the presence band) and only then
    // level.
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;

    // low shelf: pull back the 20-120 Hz region that was swamping everything
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 130;
    this.eqLow.gain.value = -4.5;

    // presence lift so strings, hats and impacts actually read
    // Presence lift. Measured octave balance showed the score was bottom-heavy
    // and thin through the 1-2 kHz band where strings/brass carry their bite;
    // the climax had under 0.6% of its energy above 2 kHz.
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1500;
    this.eqMid.Q.value = 0.75;
    this.eqMid.gain.value = 4.5;

    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 2600;
    this.eqHigh.gain.value = 5.5;

    // deep cut below the mix's useful range
    this.eqRumble = ctx.createBiquadFilter();
    this.eqRumble.type = 'highpass';
    this.eqRumble.frequency.value = 32;
    this.eqRumble.Q.value = 0.6;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 20;
    this.comp.ratio.value = 3.0;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.24;

    // brick-wall safety limiter: catches transient peaks without squashing the
    // dynamics of the score
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;

    // Make-up gain: the synth voices are individually conservative so they sum
    // without distortion; this stage brings the whole score up to a sane level
    // instead of leaving it at -27 LUFS.
    this.makeup = ctx.createGain();
    this.makeup.gain.value = 2.9;

    // Tone restore + soft-clip ceiling.
    //
    // Measured on this exact chain: DynamicsCompressor with a 1 ms attack does
    // NOT brickwall a transient (a 1.0 peak in came out at 1.03), so the shaper
    // is what actually guarantees no clipped samples. Two traps found by
    // measuring the shaper in isolation:
    //   * `oversample: '4x'` interpolates, and the interpolator overshoots the
    //     curve on any sharp edge (0.94 ceiling measured 0.98 out), so the
    //     sample-domain ceiling is NOT honoured. `none` holds exactly.
    //   * a shelf placed *after* the clipper re-amplifies what was just
    //     clamped (+0.4 peak), so the air lift has to sit before it.
    this.air = ctx.createBiquadFilter();
    this.air.type = 'highshelf';
    this.air.frequency.value = 6500;
    this.air.gain.value = 3.5;
    this.softClip = ctx.createWaveShaper();
    this.softClip.curve = makeSoftClipCurve(16384, 0.62);
    this.softClip.oversample = 'none';
    this.air.connect(this.softClip).connect(ctx.destination);

    this.master
      .connect(this.eqLow).connect(this.eqMid).connect(this.eqHigh).connect(this.eqRumble)
      .connect(this.comp).connect(this.makeup).connect(this.limiter)
      .connect(this.air);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.86;
    this.sfxBus = ctx.createGain();
    // Sound effects sit ~2-3 dB above the bed at an impact, not 8 dB: measured
    // with the offline renderer, the old 0.95 put dense fight scenes 8.2 dB over
    // the music, which buries the score.
    this.sfxBus.gain.value = 0.42;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    // reverb send
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 3.2, 2.4);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.34;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.musicReverb = ctx.createGain();
    this.musicReverb.gain.value = 0.5;
    if (typeof window !== 'undefined' && window.__NO_REVERB__) this.musicReverb.gain.value = 0;
    this.musicReverb.connect(this.reverb);

    this.noiseBuf = makeNoise(ctx, 2.2);

    // persistent wind bed
    this.wind = this._makeWind();
    this.ready = true;
    // An OfflineAudioContext only advances inside startRendering(), where resume()
    // never settles — so only resume a realtime context. Callers that render
    // offline can therefore build the identical graph and then render it.
    if (typeof ctx.startRendering !== 'function') await ctx.resume();
    return true;
  }

  // Dynamic ducking: pull the music down briefly under a big impact so the SFX
  // and the moment both land. Callers pass transport-relative offsets.
  duck(when, amount = 0.45, hold = 0.35) {
    if (!this.ready || !this.musicBus) return;
    const t = Math.max(this.now, when);
    const g = this.musicBus.gain;
    const base = 0.86;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.02, base * (1 - amount)), t);
    g.linearRampToValueAtTime(base, t + hold);
  }

  setVolume(v) {
    this.volume = clamp01(v);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // --- music scheduling -----------------------------------------------------
  // `transport` is the master-timeline position in seconds. `lookahead` seconds of
  // music are rendered ahead of it.
  scheduleMusic(transport, lookahead = 0.45) {
    if (!this.ready) return;
    const from = Math.max(this.schedTime, transport);
    const to = transport + lookahead;
    if (to <= from) return;
    const events = musicInWindow(from, to);
    const t0 = this.now;
    for (const ev of events) {
      const when = t0 + (ev.time - transport);
      if (when < t0 - 0.05) continue;
      this._playNote(ev, Math.max(t0, when));
    }
    this.schedTime = to;
  }

  resync(transport) {
    // drop pending scheduling and jump: used by seek / replay
    this.schedTime = transport;
    this.lastSfxT = transport;
    // silence any tails from the previous position
    if (this.ready) {
      const t = this.now;
      // quick duck to avoid overlapping tails after a jump
      this.musicBus.gain.cancelScheduledValues(t);
      this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, t);
      this.musicBus.gain.linearRampToValueAtTime(0.0, t + 0.012);
      this.musicBus.gain.linearRampToValueAtTime(0.62, t + 0.16);
    }
  }

  _playNote(ev, when) {
    const ctx = this.ctx;
    const v = ev.vel;
    if (v < 0.005) return;
    // Stereo placement and articulation go through a small set of permanent
    // buses. This used to be three fresh nodes per note (panner -> articulation
    // gain -> music bus, plus a reverb send). Nothing ever stopped or
    // disconnected them, so they accumulated for the life of the context: an
    // offline render got 1.7x slower for every 5.5x more notes, and the same
    // leak would have grown the live graph for the whole 258 s film. Sharing the
    // buses keeps the graph flat, and articulation is folded into velocity, which
    // every voice already scales by.
    const vend = v * (ev.art ?? 1);
    if (vend < 0.005) return;
    const pan = this._panBus(ev.pan);

    switch (ev.inst) {
      case 'pad': this._pad(when, ev.freq, ev.dur, vend, pan); break;
      case 'strings': this._strings(when, ev.freq, ev.dur, vend, pan); break;
      case 'bass': this._bass(when, ev.freq, ev.dur, vend, pan); break;
      case 'brass': this._brass(when, ev.freq, ev.dur, vend, pan); break;
      case 'choir': this._choir(when, ev.freq, ev.dur, vend, pan); break;
      case 'taiko': this._taiko(when, ev.freq, ev.dur, vend, pan); break;
      case 'hat': this._hat(when, ev.dur, vend, pan); break;
      case 'lead': this._lead(when, ev.freq, ev.dur, vend, pan); break;
      case 'bell': this._bell(when, ev.freq, ev.dur, vend, pan); break;
      default: break;
    }
  }

  /** Shared stereo panner bus for |pan| <= 1, quantised to 9 positions. */
  _panBus(pan) {
    if (!this.panBuses) {
      this.panBuses = [];
      for (let i = 0; i < 9; i++) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = -0.85 + i * (1.7 / 8);
        p.connect(this.musicBus);
        const send = this.ctx.createGain();
        send.gain.value = 0.5;
        p.connect(send).connect(this.musicReverb);
        this.panBuses.push(p);
      }
    }
    const q = Math.round(((clamp(pan, -1, 1) + 1) / 2) * 8);
    return this.panBuses[q];
  }

  _osc(type, freq, when, stop, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    o.start(when);
    o.stop(stop);
    return o;
  }

  _pad(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    // The old 520 -> 1150 Hz sweep left the pad with almost no harmonic content,
    // which is why the mix measured 42% of its energy in 60-120 Hz and under 1%
    // above 2 kHz. Open it up so the pad contributes body AND presence.
    f.frequency.setValueAtTime(1500, when);
    f.frequency.linearRampToValueAtTime(3400, when + dur * 0.5);
    f.Q.value = 0.7;
    const att = Math.min(1.6, dur * 0.35);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + att);
    g.gain.setValueAtTime(v, when + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    for (const [dt, gg] of [[-7, 0.5], [0, 0.6], [6, 0.45], [12, 0.25]]) {
      const o = this._osc('sawtooth', freq, when, when + dur + 0.1, dt);
      const og = ctx.createGain();
      og.gain.value = gg;
      o.connect(og).connect(f);
    }
    // bright upper layer: octave-up triangle plus a fifth for shimmer
    for (const [mult, gg, dt] of [[2, 0.20, 3], [3, 0.09, -4]]) {
      const o2 = this._osc('triangle', freq * mult, when, when + dur + 0.1, dt);
      const g2 = ctx.createGain();
      g2.gain.value = gg;
      o2.connect(g2).connect(f);
    }
    f.connect(g).connect(dest);
  }

  _strings(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    // Section strings: keep the fundamental (a bandpass at 2.4x removed it and
    // left a pinched, nasal tone) and roll off above ~6 harmonics. The peaking
    // filter adds the body resonance a bowed string has around 2x F0.
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.min(9000, freq * 7);
    f.Q.value = 0.6;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = Math.min(6000, freq * 2);
    body.Q.value = 0.9;
    body.gain.value = 4.5;
    const fh = ctx.createBiquadFilter();
    fh.type = 'highpass';
    fh.frequency.value = Math.max(120, freq * 0.85);
    fh.Q.value = 0.7;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + 0.018);
    g.gain.exponentialRampToValueAtTime(v * 0.5, when + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0006, when + dur);
    for (const [dt, gg] of [[-5, 0.5], [5, 0.5]]) {
      const o = this._osc('sawtooth', freq, when, when + dur + 0.05, dt);
      const og = ctx.createGain();
      og.gain.value = gg;
      o.connect(og).connect(f);
    }
    f.connect(body).connect(fh).connect(g).connect(dest);
  }

  _bass(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    // Keep the fundamental but band-limit the very bottom, and add a saturated
    // harmonic layer. This is what makes a bass line audible on laptop speakers
    // instead of disappearing into sub-bass mud.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, when);
    lp.frequency.linearRampToValueAtTime(150, when + dur);
    lp.Q.value = 0.8;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 42;
    hp.Q.value = 0.7;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(v, when + 0.012);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0008, v * 0.55), when + Math.min(dur, 0.42));
    env.gain.exponentialRampToValueAtTime(0.0006, when + dur);

    const o = this._osc('triangle', freq, when, when + dur + 0.05);
    o.connect(lp);
    // saw an octave up, quiet: provides the upper harmonics that carry audibility
    const ob = this._osc('sawtooth', freq * 2, when, when + dur + 0.05, 4);
    const gb = ctx.createGain();
    gb.gain.value = 0.22;
    ob.connect(gb).connect(lp);
    lp.connect(hp).connect(env).connect(dest);
    void g;
  }

  _brass(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, when);
    f.frequency.linearRampToValueAtTime(2600, when + 0.07);
    f.frequency.exponentialRampToValueAtTime(900, when + dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + 0.03);
    g.gain.exponentialRampToValueAtTime(v * 0.4, when + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0006, when + dur);
    for (const [dt, gg, type] of [[-4, 0.5, 'sawtooth'], [4, 0.5, 'sawtooth'], [0, 0.3, 'square']]) {
      const o = this._osc(type, freq, when, when + dur + 0.05, dt);
      const og = ctx.createGain();
      og.gain.value = gg;
      o.connect(og).connect(f);
    }
    f.connect(g).connect(dest);
  }

  _choir(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 760;
    f1.Q.value = 3.5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1180;
    f2.Q.value = 4.5;
    const att = Math.min(1.3, dur * 0.3);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + att);
    g.gain.setValueAtTime(v, when + dur * 0.68);
    g.gain.exponentialRampToValueAtTime(0.0007, when + dur);
    for (const [dt, gg] of [[-9, 0.4], [-2, 0.4], [8, 0.35]]) {
      const o = this._osc('sawtooth', freq, when, when + dur + 0.1, dt);
      // vibrato
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 4.6 + dt * 0.1;
      const lg = this.ctx.createGain();
      lg.gain.value = 4.2;
      lfo.connect(lg).connect(o.detune);
      lfo.start(when);
      lfo.stop(when + dur + 0.1);
      const og = ctx.createGain();
      og.gain.value = gg;
      o.connect(og);
      og.connect(f1);
      og.connect(f2);
    }
    f1.connect(g);
    f2.connect(g);
    g.connect(dest);
  }

  _taiko(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const o = this._osc('sine', freq * 1.6, when, when + dur);
    o.frequency.setValueAtTime(freq * 1.7, when);
    o.frequency.exponentialRampToValueAtTime(freq * 0.62, when + 0.12);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v * 0.85, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    o.connect(g);
    // skin slap
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.setValueAtTime(1600, when);
    nf.frequency.exponentialRampToValueAtTime(320, when + 0.1);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(v * 0.5, when);
    ng.gain.exponentialRampToValueAtTime(0.0006, when + 0.14);
    n.connect(nf).connect(ng).connect(g);
    n.start(when);
    n.stop(when + 0.2);
    // Rumble guard: the pitch sweep bottoms out well below the drum's real
    // fundamental, which was piling 20-120 Hz energy into the climax and
    // masking the strings/choir. Cut what a taiko cannot actually produce.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 52;
    hp.Q.value = 0.7;
    g.connect(hp);

    // Rim/attack click in the 2-4 kHz presence band. A real taiko's snap is what
    // makes it read as a hit rather than a boom; without it the climax measured
    // under 0.6% above 2 kHz.
    const rn = ctx.createBufferSource();
    rn.buffer = this.noiseBuf;
    rn.playbackRate.value = 1.6;
    const rf = ctx.createBiquadFilter();
    rf.type = 'bandpass';
    rf.frequency.value = 2900;
    rf.Q.value = 1.1;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0, when);
    rg.gain.linearRampToValueAtTime(v * 0.30, when + 0.002);
    rg.gain.exponentialRampToValueAtTime(0.0005, when + 0.055);
    rn.connect(rf).connect(rg).connect(hp);
    rn.start(when);
    rn.stop(when + 0.08);
    hp.connect(dest);
  }

  _hat(when, dur, v, dest) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.playbackRate.value = 2.4;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, when);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    n.connect(f).connect(g).connect(dest);
    n.start(when);
    n.stop(when + dur + 0.02);
  }

  _lead(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2400, when);
    f.frequency.exponentialRampToValueAtTime(1500, when + dur);
    f.Q.value = 1.6;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + 0.05);
    g.gain.exponentialRampToValueAtTime(v * 0.55, when + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0006, when + dur);
    const o = this._osc('triangle', freq, when, when + dur + 0.05);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lg = ctx.createGain();
    lg.gain.value = 7;
    lfo.connect(lg).connect(o.detune);
    lfo.start(when); lfo.stop(when + dur + 0.05);
    const o2 = this._osc('sine', freq * 2, when, when + dur + 0.05);
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;
    o.connect(f);
    o2.connect(g2).connect(f);
    f.connect(g).connect(dest);
  }

  _bell(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, when + dur);
    for (const [mult, gg, type] of [[1, 1, 'sine'], [2.01, 0.4, 'sine'], [3.02, 0.16, 'sine'], [4.7, 0.07, 'sine']]) {
      const o = this._osc(type, freq * mult, when, when + dur + 0.05);
      const og = ctx.createGain();
      og.gain.value = gg;
      o.connect(og).connect(g);
    }
    g.connect(dest);
  }

  // --- wind bed -------------------------------------------------------------
  _makeWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = makeNoise(ctx, 4.0, true);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 480;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    // slow gust LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 320;
    lfo.connect(lg).connect(f.frequency);
    lfo.start();
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return { g, f };
  }

  setWind(amount) {
    if (!this.ready) return;
    this.wind.g.gain.setTargetAtTime(0.035 + 0.06 * clamp01(amount), this.ctx.currentTime, 0.4);
  }

  // --- sfx ------------------------------------------------------------------
  sfx(id, opts = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    // `at` schedules at an explicit context time (used by the offline renderer and
    // by anything that pre-plans cues); otherwise fire now, plus optional delay.
    const t = opts.at != null ? Math.max(opts.at, ctx.currentTime) : ctx.currentTime + (opts.delay ?? 0);

    // Per-category mix trim. Measured by rendering every cue alone: the sustained
    // charge loops (a 3 s rasengan whine) were the loudest thing in the film at
    // -12.6 dBFS rms, i.e. louder than the whole music bed, and would have
    // buried the score. Impacts stay hot because they are point events; beds and
    // charges get pulled down to sit under the music.
    const TRIM = {
      rasenganCharge: 0.32, chidoriCharge: 0.34, chargeAmbient: 0.38,
      dome: 0.42, rumble: 0.45, armyCharge: 0.38, crackleLoop: 0.35,
      wind: 0.50, crackle: 0.55, surge: 0.62, surge2: 0.62,
      nova: 0.72, bigBoom: 0.80, finalClash: 0.80, explosion2: 0.82,
      powerUp: 0.70, powerUp2: 0.70, seal: 0.70, rasenganHit: 0.85,
      voiceNaruto1: 1, voiceNaruto2: 1, voiceNaruto3: 1, voiceNaruto4: 1,
      voiceNaruto5: 1, voiceNaruto6: 1, voiceNaruto7: 1,
      voiceSasuke1: 1, voiceSasuke2: 1, voiceSasuke3: 1, voiceSasuke4: 1,
      voiceSasuke5: 1, voiceSasuke6: 1,
    };
    const d = (opts.vol ?? 1) * (TRIM[id] ?? 1);
    switch (id) {
      case 'punch': this._hit(t, 0.9 * d, 180, 0.09, 1500); break;
      case 'punchHeavy': this._hit(t, 1.25 * d, 120, 0.16, 1100); break;
      case 'kick': this._hit(t, 1.15 * d, 90, 0.14, 900); break;
      case 'kickHeavy': this._hit(t, 1.4 * d, 70, 0.2, 700); break;
      case 'block': this._clank(t, 0.5 * d, 2100, 0.06); break;
      case 'block2': this._clank(t, 0.6 * d, 1700, 0.08); break;
      case 'clank': this._clank(t, 0.8 * d, 3200, 0.12); break;
      case 'swipe': case 'swipe2': this._whoosh(t, 0.35 * d, 700, 2400, 0.16); break;
      case 'whoosh': this._whoosh(t, 0.4 * d, 400, 1800, 0.22); break;
      case 'land': this._thud(t, 0.7 * d, 90, 0.22); break;
      case 'slam': this._slam(t, 1.0 * d); break;
      case 'explosion': this._boom(t, 1.0 * d, 0.9); break;
      case 'explosion2': this._boom(t, 1.15 * d, 1.2); break;
      case 'bigBoom': this._boom(t, 1.3 * d, 1.6); break;
      case 'rasenganCharge': this._charge(t, 0.65 * d, 220, 900, opts.dur ?? 1.6); break;
      case 'chidoriCharge': this._crackle(t, 0.7 * d, opts.dur ?? 2.0); break;
      case 'rasenganHit': this._boom(t, 1.0 * d, 1.0, 520); break;
      case 'lightningHit': this._crackle(t, 0.9 * d, 0.35, true); this._boom(t, 0.7 * d, 0.5); break;
      case 'poof': this._poof(t, 0.5 * d); break;
      case 'puff': this._poof(t, 0.7 * d); break;
      case 'seal': this._charge(t, 0.4 * d, 300, 700, 1.1, true); break;
      case 'kunai': this._whoosh(t, 0.5 * d, 2400, 5200, 0.14); break;
      case 'wind': this._gust(t, opts.dur ?? 6, 0.5 * d); break;
      case 'powerUp': this._powerUp(t, 0.9 * d, opts.dur ?? 2.0); break;
      case 'powerUp2': this._powerUp(t, 0.9 * d, opts.dur ?? 2.0, true); break;
      case 'surge': this._surge(t, 0.9 * d); break;
      case 'surge2': this._surge(t, 0.9 * d, true); break;
      case 'clash': this._clash(t, 1.0 * d); break;
      case 'finalClash': this._clash(t, 1.4 * d); break;
      case 'crackle': this._crackle(t, 0.28 * d, 0.16, true); break;
      case 'rumble': this._rumble(t, 0.8 * d, 2.4); break;
      case 'dome': this._dome(t, 0.9 * d, opts.dur ?? 10); break;
      case 'nova': this._boom(t, 1.6 * d, 3.0, 70); this._crackle(t, 0.8 * d, 1.4, true); break;
      case 'fireBreath': this._fire(t, 0.9 * d, 1.0); break;
      case 'bigFire': this._fire(t, 1.1 * d, 1.6); break;
      case 'fireVolley': this._fire(t, 0.7 * d, 1.2); break;
      case 'chargeAmbient': this._dome(t, 0.4 * d, opts.dur ?? 20); break;
      case 'armyCharge': this._army(t, 0.8 * d); break;
      case 'crackleLoop': this._crackle(t, 0.2 * d, opts.dur ?? 2.0, true); break;
      case 'bossCharge': this._dome(t, 0.5 * d, opts.dur ?? 6); break;
      case 'combo': case 'combo2': case 'duel': this._whoosh(t, 0.42 * d, 600, 2600, 0.2); break;
      case 'voiceNaruto1': case 'voiceNaruto2': case 'voiceNaruto3':
      case 'voiceNaruto4': case 'voiceNaruto5': case 'voiceNaruto6':
      case 'voiceNaruto7': case 'voiceSasuke1': case 'voiceSasuke2':
      case 'voiceSasuke3': case 'voiceSasuke4': case 'voiceSasuke5':
      case 'voiceSasuke6':
        this._voice(t, (opts.vol ?? 0.62), id.replace('voice', '').toLowerCase());
        break;
      default: break;
    }
  }

  _env(node, t, attack, decay, peak) {
    node.gain.setValueAtTime(0, t);
    node.gain.linearRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0005, t + attack + decay);
  }

  _noise(t, dur, rate = 1) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.playbackRate.value = rate;
    n.start(t, dRand(t) * 1.5);
    n.stop(t + dur + 0.05);
    return n;
  }

  _out(node, wet = 0.2) {
    node.connect(this.sfxBus);
    const s = this.ctx.createGain();
    s.gain.value = wet;
    node.connect(s).connect(this.reverb);
  }

  _hit(t, v, f0, decay, lp) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this._env(g, t, 0.003, decay, v * 0.8);
    this._out(g, 0.25);
    // body thump
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * 2.2, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + decay * 0.9);
    o.start(t); o.stop(t + decay + 0.05);
    o.connect(g);
    // slap
    const n = this._noise(t, decay);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(lp, t);
    f.frequency.exponentialRampToValueAtTime(lp * 0.4, t + decay);
    f.Q.value = 1.2;
    const ng = ctx.createGain();
    this._env(ng, t, 0.002, decay * 0.7, v * 0.55);
    n.connect(f).connect(ng).connect(g);
  }

  _clank(t, v, freq, decay) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this._env(g, t, 0.002, decay, v * 0.7);
    this._out(g, 0.35);
    for (const [mult, gg] of [[1, 1], [1.72, 0.6], [2.63, 0.4], [4.1, 0.2]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq * mult;
      o.start(t); o.stop(t + decay + 0.05);
      const og = ctx.createGain();
      og.gain.value = gg;
      o.connect(og).connect(g);
    }
    const n = this._noise(t, decay);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2600;
    const ng = ctx.createGain();
    this._env(ng, t, 0.001, decay * 0.45, v * 0.7);
    n.connect(f).connect(ng).connect(g);
  }

  _whoosh(t, v, f0, f1, dur) {
    const ctx = this.ctx;
    const n = this._noise(t, dur);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.2;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    n.connect(f).connect(g);
    this._out(g, 0.18);
  }

  _thud(t, v, f0, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this._env(g, t, 0.004, dur, v);
    this._out(g, 0.3);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * 1.8, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + dur * 0.8);
    o.start(t); o.stop(t + dur + 0.05);
    o.connect(g);
    const n = this._noise(t, dur * 0.8);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const ng = ctx.createGain();
    this._env(ng, t, 0.003, dur * 0.5, v * 0.5);
    n.connect(f).connect(ng).connect(g);
  }

  _slam(t, v) {
    this._thud(t, v * 0.9, 52, 0.5);
    const ctx = this.ctx;
    const n = this._noise(t, 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.5);
    const g = ctx.createGain();
    this._env(g, t, 0.004, 0.5, v * 0.5);
    n.connect(f).connect(g);
    this._out(g, 0.35);
    // Rubble: deterministic pseudo-random offsets (a hash of the cue time), not
    // Math.random — the whole film is a pure function of t and offline renders
    // must be reproducible sample-for-sample.
    for (let i = 0; i < 6; i++) {
      const r1 = Math.abs(Math.sin((t + i * 7.13) * 91.7)) % 1;
      const r2 = Math.abs(Math.sin((t + i * 3.31) * 57.3)) % 1;
      this._thud(t + 0.06 + r1 * 0.4, v * 0.14, 220 + r2 * 300, 0.12);
    }
  }

  _boom(t, v, dur, lp = 900) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this._env(g, t, 0.006, dur, v * 0.8);
    this._out(g, 0.45);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(34, t + dur);
    o.start(t); o.stop(t + dur + 0.1);
    o.connect(g);
    const n = this._noise(t, dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2200, t);
    f.frequency.exponentialRampToValueAtTime(lp * 0.25, t + dur);
    const ng = ctx.createGain();
    this._env(ng, t, 0.005, dur * 0.9, v * 0.8);
    n.connect(f).connect(ng).connect(g);
  }

  _charge(t, v, f0, f1, dur, quiet = false) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.5, t + dur * 0.5);
    g.gain.linearRampToValueAtTime(v * 0.7, t + dur * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    this._out(g, 0.4);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(f0 * 1.5, t);
    o2.frequency.exponentialRampToValueAtTime(f1 * 2, t + dur);
    o2.start(t); o2.stop(t + dur + 0.05);
    const og = ctx.createGain();
    og.gain.value = 0.4;
    o.connect(g);
    o2.connect(og).connect(g);
    const n = this._noise(t, dur);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(f0 * 2, t);
    f.frequency.exponentialRampToValueAtTime(f1 * 2.2, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(v * 0.5, t + dur * 0.7);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    n.connect(f).connect(ng).connect(g);
  }

  _crackle(t, v, dur, shortBurst = false) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.55, t + Math.min(0.1, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    this._out(g, 0.3);
    // crackling noise bed
    const n = this._noise(t, dur, 1.6);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2200;
    n.connect(f).connect(g);
    // discrete electrical ticks
    const ticks = shortBurst ? 6 : Math.max(6, Math.round(dur * 26));
    for (let i = 0; i < ticks; i++) {
      const tt = t + (shortBurst ? dRand(i * 3.1 + 1) * dur : (i / ticks) * dur + dRand(i * 5.7 + 2) * 0.03);
      const tg = ctx.createGain();
      this._env(tg, tt, 0.001, 0.035 + dRand(i * 11.3) * 0.05, v * (0.25 + dRand(i * 2.9) * 0.35));
      tg.connect(this.sfxBus);
      const tn = ctx.createBufferSource();
      tn.buffer = this.noiseBuf;
      tn.playbackRate.value = 2.6;
      tn.start(tt, dRand(i * 17.1)); tn.stop(tt + 0.09);
      const tf = ctx.createBiquadFilter();
      tf.type = 'bandpass';
      tf.frequency.value = 3200 + dRand(i * 23.7) * 3400;
      tf.Q.value = 4;
      tn.connect(tf).connect(tg);
    }
    // electrical hum
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t);
    o.frequency.linearRampToValueAtTime(150, t + dur);
    const of = ctx.createBiquadFilter();
    of.type = 'bandpass';
    of.frequency.value = 900;
    of.Q.value = 6;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(v * 0.16, t + dur * 0.4);
    og.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    o.connect(of).connect(og).connect(g);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _poof(t, v) {
    const ctx = this.ctx;
    const n = this._noise(t, 0.28);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(420, t + 0.24);
    const g = ctx.createGain();
    this._env(g, t, 0.01, 0.26, v * 0.5);
    n.connect(f).connect(g);
    this._out(g, 0.3);
  }

  _gust(t, dur, v) {
    const ctx = this.ctx;
    const n = this._noise(t, dur, 0.8);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(300, t);
    f.frequency.linearRampToValueAtTime(700, t + dur * 0.4);
    f.frequency.linearRampToValueAtTime(260, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.5, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(v * 0.3, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    n.connect(f).connect(g);
    this._out(g, 0.25);
  }

  // ---- character vocalisations -------------------------------------------------
  // Original, synthesised formant vocalisations (no sampled or cloned human
  // voice anywhere in this project). Each line is a short, pitched, articulated
  // shout: a glottal source through three formant band-passes, with pitch and
  // formants moving over the syllable so it reads as an effort sound rather
  // than a tone burst. `kind` picks the vowel/contour so Naruto and Sasuke are
  // audibly different characters.
  _voice(t, v, kind) {
    const ctx = this.ctx;
    // Per-line syllables: [start, length, f0 start, f0 end]
    const LINES = {
      // Naruto: brighter, chestier, rising shout
      naruto1: [[0, 0.26, 205, 250], [0.30, 0.42, 260, 215]],
      naruto2: [[0, 0.22, 230, 275], [0.25, 0.34, 285, 240]],
      naruto3: [[0, 0.30, 195, 245], [0.34, 0.55, 250, 200]],
      naruto4: [[0, 0.24, 235, 290], [0.28, 0.60, 300, 235]],
      naruto5: [[0, 0.20, 250, 300], [0.23, 0.30, 305, 265]],
      naruto6: [[0, 0.26, 210, 260], [0.30, 0.48, 265, 225]],
      naruto7: [[0, 0.28, 225, 285], [0.32, 0.75, 295, 230]],
      // Sasuke: darker, narrower, lower — a clipped, tight shout
      sasuke1: [[0, 0.30, 148, 168], [0.34, 0.46, 172, 145]],
      sasuke2: [[0, 0.24, 155, 178], [0.27, 0.38, 182, 152]],
      sasuke3: [[0, 0.22, 140, 165], [0.25, 0.44, 168, 138]],
      sasuke4: [[0, 0.26, 152, 180], [0.30, 0.52, 185, 150]],
      sasuke5: [[0, 0.20, 145, 170], [0.23, 0.34, 174, 142]],
      sasuke6: [[0, 0.28, 138, 162], [0.32, 0.70, 166, 136]],
    };
    const line = LINES[kind] || LINES.naruto1;
    const bright = kind.startsWith('naruto');
    // Vowel targets. Formants have to be *boosted*, not merely passed: with
    // unity-gain band-passes the source's 1/n harmonic rolloff dominated and the
    // output measured as a plain buzzer with no vowel. Series peaking resonators
    // give the harmonic-dependent emphasis that makes it read as a voice.
    // Each entry is a vowel the line morphs through: [F1, F2, F3].
    const vowels = bright
      ? [[720, 1180, 2500], [500, 1750, 2480], [680, 1600, 2520]]
      : [[420, 850, 2250], [350, 1050, 2280], [430, 900, 2200]];

    const out = ctx.createGain();
    out.gain.value = v * 0.22;
    this._out(out, 0.30);

    // Formant bank, shared across syllables, glided per syllable.
    const fmt = [];
    const gains = bright ? [15, 12, 6] : [16, 11, 5];
    const qs = bright ? [6.0, 8.0, 9.0] : [7.0, 9.0, 10.0];
    let node = null;
    vowels[0].forEach((f0, i) => {
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking';
      pk.frequency.value = f0;
      pk.Q.value = qs[i];
      pk.gain.value = gains[i];
      if (node) node.connect(pk);
      node = pk;
      fmt.push(pk);
    });
    // tame the top so the buzz does not read as harshness
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = bright ? 4200 : 3200;
    lp.Q.value = 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = bright ? 130 : 95;
    hp.Q.value = 0.7;
    node.connect(lp).connect(hp).connect(out);

    line.forEach(([st, len, f0a, f0b], si) => {
      const at = t + st;
      const src = ctx.createOscillator();
      src.type = 'sawtooth';
      src.frequency.setValueAtTime(f0a, at);
      src.frequency.exponentialRampToValueAtTime(Math.max(40, f0b), at + len);
      // vibrato, delayed: a shout is straight until it runs out of air
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.4;
      const vibG = ctx.createGain();
      vibG.gain.setValueAtTime(0, at);
      vibG.gain.linearRampToValueAtTime(f0a * 0.030, at + len * 0.7);
      vib.connect(vibG).connect(src.frequency);

      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0, at);
      sg.gain.linearRampToValueAtTime(1, at + 0.018);
      sg.gain.setValueAtTime(1, at + len * 0.5);
      sg.gain.exponentialRampToValueAtTime(0.004, at + len);
      src.connect(sg);
      if (!si) sg.connect(fmt[0]); else sg.connect(fmt[0]);

      // consonant onset: a short band-passed noise burst reads as "k"/"t"/"sh"
      const n = this._noise(at, 0.07, 0.9);
      const nbp = ctx.createBiquadFilter();
      nbp.type = 'bandpass';
      nbp.frequency.value = bright ? 2700 : 1900;
      nbp.Q.value = 1.2;
      const ng = ctx.createGain();
      this._env(ng, at, 0.003, 0.07, v * 0.22);
      n.connect(nbp).connect(ng).connect(out);

      // glide formants toward this syllable's vowel
      const target = vowels[Math.min(vowels.length - 1, 1 + si)];
      fmt.forEach((pk, i) => {
        pk.frequency.linearRampToValueAtTime(target[i], at + len * 0.8);
      });
      src.start(at); src.stop(at + len + 0.02);
      vib.start(at); vib.stop(at + len + 0.02);
    });
  }

  _powerUp(t, v, dur, dark = false) {
    const base = dark ? 300 : 180;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.45, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(v * 0.6, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    this._out(g, 0.5);
    // rising harmonic stack
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'square';
      const f0 = base * (i + 1) * 0.75;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 2.6, t + dur);
      const og = ctx.createGain();
      og.gain.value = 0.18 / (i + 1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      o.connect(og).connect(lp).connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    }
    const n = this._noise(t, dur, 0.7);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(260, t);
    f.frequency.exponentialRampToValueAtTime(2000, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(v * 0.4, t + dur * 0.7);
    ng.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    n.connect(f).connect(ng).connect(g);
  }

  _surge(t, v, dark = false) {
    this._boom(t, v * 0.8, 0.7, dark ? 1600 : 900);
    this._whoosh(t, v * 0.7, 300, 4000, 0.6);
  }

  _clash(t, v) {
    this._boom(t, v * 1.1, 0.85, 700);
    this._clank(t, v * 0.7, 1500, 0.2);
    this._crackle(t, v * 0.8, 0.5, true);
    const ctx = this.ctx;
    const n = this._noise(t, 0.4);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(3000, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.35);
    const g = ctx.createGain();
    this._env(g, t, 0.002, 0.35, v * 0.5);
    n.connect(f).connect(g);
    this._out(g, 0.4);
  }

  _rumble(t, v, dur) {
    const ctx = this.ctx;
    const n = this._noise(t, dur, 0.45);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.55, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(v * 0.35, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    n.connect(f).connect(g);
    this._out(g, 0.2);
  }

  _dome(t, v, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.25, t + 1.2);
    g.gain.setValueAtTime(v * 0.25, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0003, t + dur);
    this._out(g, 0.6);
    // sustained cluster — the "pressure" of the clash
    for (const [fq, gg] of [[110, 0.5], [165, 0.35], [220, 0.3], [330, 0.18], [55, 0.4]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fq;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 620;
      const og = ctx.createGain();
      og.gain.value = gg;
      // slow beating
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.17 + dRand(t * 3.7) * 0.2;
      const lg = ctx.createGain();
      lg.gain.value = gg * 0.4;
      lfo.connect(lg).connect(og.gain);
      lfo.start(t); lfo.stop(t + dur);
      o.connect(og).connect(lp).connect(g);
      o.start(t); o.stop(t + dur);
    }
    const n = this._noise(t, dur, 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.8;
    f.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(v * 0.16, t + dur * 0.4);
    ng.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    n.connect(f).connect(ng).connect(g);
  }

  _fire(t, v, dur) {
    const ctx = this.ctx;
    const n = this._noise(t, dur, 0.9);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.9;
    f.frequency.setValueAtTime(600, t);
    f.frequency.linearRampToValueAtTime(1400, t + dur * 0.4);
    f.frequency.exponentialRampToValueAtTime(300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.6, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    n.connect(f).connect(g);
    this._out(g, 0.3);
    // roar body
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(70, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(v * 0.3, t + dur * 0.3);
    og.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    o.connect(lp).connect(og).connect(g);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _army(t, v) {
    for (let i = 0; i < 5; i++) {
      this._whoosh(t + i * 0.08, v * 0.3, 500, 2200, 0.35);
      this._crackle(t + i * 0.09, v * 0.3, 0.3, true);
    }
    this._rumble(t, v * 0.6, 1.4);
  }

  dispose() {
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* ignore */ }
    }
    this.ctx = null;
    this.ready = false;
  }
}

// Piecewise soft clipper: transparent (unity) below `knee`, then a tanh shoulder
// that asymptotes to 1.0. Used on the master bus as a true-peak safety net.
// Deterministic uniform [0,1) from a numeric seed. The soundtrack must be a pure
// function of the timeline so an offline render is reproducible for QA.
function dRand(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function makeSoftClipCurve(n, knee) {
  const c = new Float32Array(n);
  const ceil = 0.82;   // ~ -1.7 dBFS: leaves true-peak headroom for the DAC
  for (let i = 0; i < n; i++) {
    // The curve's domain is the full -1..1 sample range; anything beyond it is
    // clamped to the last entry, which is already at the ceiling.
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.min(Math.abs(x), 1);
    let y;
    if (a <= knee) y = a;
    else y = knee + (1 - knee) * Math.tanh(((a - knee) / (1 - knee)) * 1.25);
    c[i] = Math.sign(x) * y * ceil;
  }
  return c;
}

function makeNoise(ctx, seconds, deterministic = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    // deterministic when a loop bed is needed so the texture is stable
    d[i] = deterministic ? hash(i * 2654435761) * 2 - 1 : Math.random() * 2 - 1;
  }
  return buf;
}

function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // diffuse tail with a slow build (hall-like)
      const env = Math.pow(1 - t, decay) * Math.min(1, t * 24);
      d[i] = (dRand(i * 1.7) * 2 - 1) * env * 0.7;
    }
  }
  return buf;
}

export { BPM, BAR, SPB, SECTIONS };

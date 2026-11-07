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
 *   intensity 0..1 (drives layers/velocity)
 *   layers   { pad, strings, brass, choir, taiko, hats, bass, lead, bell }
 */
const SECTIONS = [
  { t0: 0, t1: 26, prog: 0, intensity: 0.22, layers: { pad: 1, bell: 1, bass: 0.5, choir: 0.35 } },
  { t0: 26, t1: 50, prog: 1, intensity: 0.55, layers: { pad: 1, strings: 1, taiko: 1, hats: 0.5, bass: 1, lead: 0.55 } },
  { t0: 50, t1: 58, prog: 0, intensity: 0.3, layers: { pad: 1, bell: 1, bass: 0.5 } },
  { t0: 58, t1: 80, prog: 1, intensity: 0.65, layers: { pad: 1, strings: 1, taiko: 1, hats: 0.7, bass: 1, brass: 0.6, lead: 0.6 } },
  { t0: 80, t1: 100, prog: 0, intensity: 0.5, layers: { pad: 1, choir: 1, strings: 0.7, taiko: 0.7, bass: 0.8, bell: 0.6 } },
  { t0: 100, t1: 132, prog: 1, intensity: 0.85, layers: { pad: 1, strings: 1, taiko: 1, hats: 1, bass: 1, brass: 0.9, lead: 0.85, choir: 0.5 } },
  { t0: 132, t1: 166, prog: 2, intensity: 0.7, layers: { pad: 1, choir: 1, strings: 0.8, taiko: 0.8, bass: 1, bell: 0.5 } },
  { t0: 166, t1: 182, prog: 1, intensity: 1.0, layers: { pad: 1, strings: 1, taiko: 1, hats: 1, bass: 1, brass: 1, lead: 1, choir: 0.8 } },
  { t0: 182, t1: 201, prog: 0, intensity: 0.9, layers: { pad: 1, choir: 1, strings: 0.9, taiko: 0.6, bass: 1, lead: 0.7 } },
  { t0: 201, t1: 216, prog: 0, intensity: 0.35, layers: { pad: 1, choir: 0.8, bell: 0.7, bass: 0.4 } },
  { t0: 216, t1: 240, prog: 0, intensity: 0.5, layers: { pad: 1, choir: 1, strings: 0.6, bell: 0.8, bass: 0.6, lead: 0.4 } },
  { t0: 240, t1: 999, prog: 0, intensity: 0.3, layers: { pad: 1, choir: 0.7, bell: 0.6, bass: 0.3 } },
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

    const push = (time, inst, freq, dur, vel, pan = 0) => {
      if (time + dur < t0 || time > t1) return;
      out.push({ time, inst, freq, dur, vel, pan });
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
      const root = ROOT + chord[0] - 24;
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

    // master chain: buses -> compressor -> master -> destination
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.62;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);

    // reverb send
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 3.2, 2.4);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.42;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.musicReverb = ctx.createGain();
    this.musicReverb.gain.value = 0.5;
    this.musicReverb.connect(this.reverb);

    this.noiseBuf = makeNoise(ctx, 2.2);

    // persistent wind bed
    this.wind = this._makeWind();
    this.ready = true;
    await ctx.resume();
    return true;
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
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(ev.pan, -1, 1);
    pan.connect(this.musicBus);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    pan.connect(send).connect(this.musicReverb);

    switch (ev.inst) {
      case 'pad': this._pad(when, ev.freq, ev.dur, v, pan); break;
      case 'strings': this._strings(when, ev.freq, ev.dur, v, pan); break;
      case 'bass': this._bass(when, ev.freq, ev.dur, v, pan); break;
      case 'brass': this._brass(when, ev.freq, ev.dur, v, pan); break;
      case 'choir': this._choir(when, ev.freq, ev.dur, v, pan); break;
      case 'taiko': this._taiko(when, ev.freq, ev.dur, v, pan); break;
      case 'hat': this._hat(when, ev.dur, v, pan); break;
      case 'lead': this._lead(when, ev.freq, ev.dur, v, pan); break;
      case 'bell': this._bell(when, ev.freq, ev.dur, v, pan); break;
      default: break;
    }
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
    f.frequency.setValueAtTime(520, when);
    f.frequency.linearRampToValueAtTime(1150, when + dur * 0.5);
    f.Q.value = 0.9;
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
    // a soft triangle an octave up for air
    const o2 = this._osc('triangle', freq * 2, when, when + dur + 0.1, 3);
    const g2 = ctx.createGain();
    g2.gain.value = 0.16;
    o2.connect(g2).connect(f);
    f.connect(g).connect(dest);
  }

  _strings(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq * 2.4;
    f.Q.value = 1.1;
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
    f.connect(g).connect(dest);
  }

  _bass(when, freq, dur, v, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(320, when);
    f.frequency.exponentialRampToValueAtTime(120, when + dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    const o = this._osc('triangle', freq, when, when + dur + 0.02);
    const o2 = this._osc('sine', freq * 0.5, when, when + dur + 0.02);
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    o.connect(f);
    o2.connect(g2).connect(f);
    f.connect(g).connect(dest);
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
    g.connect(dest);
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
    const t = ctx.currentTime + (opts.delay ?? 0);
    const d = opts.vol ?? 1;
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
      case 'combo': case 'combo2': case 'duel': case 'crackleLoop': break;
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
    n.start(t, Math.random() * 1.5);
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
    // rubble
    for (let i = 0; i < 6; i++) {
      this._thud(t + 0.06 + Math.random() * 0.4, v * 0.14, 220 + Math.random() * 300, 0.12);
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
      const tt = t + (shortBurst ? Math.random() * dur : (i / ticks) * dur + Math.random() * 0.03);
      const tg = ctx.createGain();
      this._env(tg, tt, 0.001, 0.035 + Math.random() * 0.05, v * (0.25 + Math.random() * 0.35));
      tg.connect(this.sfxBus);
      const tn = ctx.createBufferSource();
      tn.buffer = this.noiseBuf;
      tn.playbackRate.value = 2.6;
      tn.start(tt, Math.random()); tn.stop(tt + 0.09);
      const tf = ctx.createBiquadFilter();
      tf.type = 'bandpass';
      tf.frequency.value = 3200 + Math.random() * 3400;
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
      lfo.frequency.value = 0.17 + Math.random() * 0.2;
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
      d[i] = (Math.random() * 2 - 1) * env * 0.7;
    }
  }
  return buf;
}

export { BPM, BAR, SPB, SECTIONS };

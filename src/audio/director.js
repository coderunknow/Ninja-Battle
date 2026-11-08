// Audio director: turns timeline cues into engine calls.
//
// The cue list comes from the choreography, so audio is authored in the same
// place as the animation and always lands on the same frame. Cues are consumed
// as the playhead advances; after a seek the cursor jumps with the playhead so a
// single event can never retrigger in a burst.

import { AudioEngine } from './engine.js';

export const CUE_MAP = {
  // impacts
  block: 'block',
  block2: 'block2',
  clank: 'clank',
  punchHeavy: 'punchHeavy',
  kick: 'kick',
  kickHeavy: 'kickHeavy',
  uppercut: 'punchHeavy',
  slam: 'slam',
  swipe: 'swipe',
  swipe2: 'swipe2',
  pop: 'poof',
  poof: 'poof',
  hit: 'punch',
  bigHit: 'kickHeavy',
  whiff: 'whoosh',
  clank2: 'clank',
  // energy
  rasenganHit: 'rasenganHit',
  lightningHit: 'lightningHit',
  clash: 'clash',
  finalClash: 'finalClash',
  explosion: 'explosion',
  explosion2: 'explosion2',
  bigBoom: 'bigBoom',
  crackle: 'crackle',
  pressure: 'crackle',
  powerSurge: 'surge',
  surge: 'surge',
  surge2: 'surge2',
  explode: 'explosion',
  nova: 'nova',
  dome: 'dome',
  charge: 'chargeAmbient',
  rumble: 'rumble',
  flash: 'whoosh',
  swish: 'swipe',
  // one-shots
  wind: 'wind',
  land: 'land',
  kunai: 'kunai',
  seal: 'seal',
  kagebunshin: 'puff',
  puff: 'puff',
  fireBreath: 'fireBreath',
  bigFire: 'bigFire',
  fireVolley: 'fireVolley',
  armyCharge: 'armyCharge',
  rasenganCharge: 'rasenganCharge',
  chidoriCharge: 'chidoriCharge',
  powerUp: 'powerUp',
  powerUp2: 'powerUp2',
  combo: 'swipe',
  combo2: 'swipe2',
  duel: 'swipe',
  // Character vocalisations. These were scripted in the choreography but absent
  // from this map, so the director filtered every one of them out before the
  // engine ever saw it — 13 lines of dialogue that never played.
  chargeAmbient: 'chargeAmbient',
  voiceNaruto1: 'voiceNaruto1', voiceNaruto2: 'voiceNaruto2',
  voiceNaruto3: 'voiceNaruto3', voiceNaruto4: 'voiceNaruto4',
  voiceNaruto5: 'voiceNaruto5', voiceNaruto6: 'voiceNaruto6',
  voiceNaruto7: 'voiceNaruto7',
  voiceSasuke1: 'voiceSasuke1', voiceSasuke2: 'voiceSasuke2',
  voiceSasuke3: 'voiceSasuke3', voiceSasuke4: 'voiceSasuke4',
  voiceSasuke5: 'voiceSasuke5', voiceSasuke6: 'voiceSasuke6',
};

export class AudioDirector {
  constructor(script) {
    this.engine = new AudioEngine();
    this.script = script;
    this.cues = [];
    // timeline sfx cues
    for (const a of script.audio || []) {
      const mapped = CUE_MAP[a.id];
      if (!mapped) continue;
      this.cues.push({ t: a.t, id: mapped, opts: a });
    }
    // hit-event cues
    for (const e of script.events || []) {
      if (!e.sfx) continue;
      const mapped = CUE_MAP[e.sfx];
      if (!mapped) continue;
      const amp = e.amp ?? 6;
      this.cues.push({ t: e.t, id: mapped, opts: { vol: Math.min(1.2, 0.45 + amp / 22) } });
    }
    // ambient cues fired during the opening
    for (let t = 4; t < 200; t += 17) {
      this.cues.push({ t, id: 'wind', opts: { dur: 9, vol: 0.32 } });
    }
    this.cues.sort((a, b) => a.t - b.t);
    this.cursor = 0;
    this.lastT = 0;
  }

  async unlock() {
    return this.engine.unlock();
  }

  /** Advance cue playback to `t`. Fires cues in (lastT, t]. */
  update(t, playing) {
    if (!this.engine.ready) return;
    // wind bed follows the action
    this.engine.setWind(playing ? 1 : 0.4);
    if (!playing) {
      this.lastT = t;
      return;
    }
    if (t < this.lastT) {
      // rewound: reposition cursor without firing
      this.cursor = this._indexAfter(t);
      this.lastT = t;
      return;
    }
    // gather cues in window (max 40 per frame to avoid a pile-up after a jump)
    let fired = 0;
    const window = t - this.lastT;
    while (this.cursor < this.cues.length && this.cues[this.cursor].t < t) {
      const c = this.cues[this.cursor];
      if (c.t > this.lastT - 0.001) {
        // skip cues that are too far behind the playhead (seek safety)
        if (t - c.t < 0.28) {
          this.engine.sfx(c.id, c.opts);
          fired++;
        }
      }
      this.cursor++;
      if (fired > 40) break;
    }
    this.lastT = t;
  }

  _indexAfter(t) {
    let lo = 0, hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  seek(t) {
    this.cursor = this._indexAfter(t);
    this.lastT = t;
    this.engine.resync(t);
  }

  resyncAfterPause() {
    this.engine.resync(this.lastT);
  }
}

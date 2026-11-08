# Audio design and licensing position

## Licensing

**Nothing in this project is licensed from anyone, because nothing is
obtained from anyone.**

* No music files, loops, samples, stems, or SFX files exist in the repository.
* Nothing is fetched at runtime — the app makes zero network requests for media.
* Every sound is synthesised from scratch with the Web Audio API at playback
  time, from oscillators, noise buffers, filters and envelopes written in
  `src/audio/engine.js`.

There are therefore no title / creator / source / licence / filename entries to
record, and no attribution obligations. No material was ripped from episodes,
films, YouTube, streaming services, or sample packs.

If you replace the synthesiser with recorded music, you take on the obligation to
document, per track: title, creator, source URL, licence, and local filename — and
the licence must permit redistribution in this repository.

## Music

| Parameter | Value |
| --- | --- |
| Tempo | 84 BPM |
| Key | D minor |
| Progression | Dm – Bb – F – C (4-bar loop) |
| Voices | pad (detuned saw pair + lowpass), bass (triangle + sub), pluck (koto-ish, fast decay), taiko-style drum (filtered noise + sine drop) |
| Space | convolution reverb from a generated impulse response + master compressor |
| Sections | 12 arrangement sections keyed to act timings; instrumentation and density change with the edit |

The scheduler is a look-ahead window: `scheduleMusic(t, horizon)` is called from
the render loop, converts musical time to audio-context time, and queues events
one bar ahead. On seek, `resync(t)` cancels queued nodes and re-arms the window at
the new position, so scrubbing cannot leave the score out of phase with the
picture.

## SFX

~40 cues generated on demand (`engine.sfx(id)`), each a small graph of
oscillators/noise, envelopes and filters:

| Group | Cues |
| --- | --- |
| Movement | `whoosh_soft`, `whoosh_hard`, `step`, `land`, `slide` |
| Impact | `hit_soft`, `hit_hard`, `block`, `body_fall`, `crunch` |
| Chakra | `charge_n`, `charge_s`, `rasengan_spin`, `chidori_crackle`, `release` |
| Big | `clash`, `nova`, `shockwave`, `rumble`, `explode` |
| Ambience | `wind_gust` (every ~17 s), `room_tone` |
| Stings | `title_hit`, `drum_hit`, `bell` |

The director caps concurrent cues (40) and skips cues more than 0.28 s stale
after a seek, so fast scrubbing cannot produce a machine-gun burst of overlapping
impacts.

## Mix

Master chain: per-voice → instrument bus → dry + reverb send → master gain →
`DynamicsCompressor` → destination. The compressor keeps the big impacts from
clipping a laptop speaker while the wind bed stays audible underneath.

Volume and mute are owned by the player: the slider sets master gain, mute ramps
it to zero and restores the previous value. Both are exercised by
`tools/browser-sim.mjs`.

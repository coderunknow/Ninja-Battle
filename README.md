# Naruto vs Sasuke — a stickman cinematic

A ~4½-minute, fully deterministic, browser-native Canvas2D action short. Two
articulated stick fighters meet in a ruined valley, trade five acts of combat,
and end in an unresolved Rasengan/Chidori collision. There is no winner.

Everything is generated in code: the characters, the terrain, the effects, and
the entire soundtrack and SFX bed. There are **no binary assets, no fonts, no
image files and no audio files** in this repository, which also means there is
nothing to license.

* **Runtime:** vanilla ES modules + Canvas2D. Zero runtime dependencies.
* **Length:** 258 s (4:18), 16:9.
* **Targets:** Chrome / Edge (desktop). Firefox works but is untested here.
* **Determinism:** the whole film is a pure function of one scalar `t`.

---

## Quick start

```bash
npm install        # only installs the headless renderer used for QA
npm start          # static server on http://localhost:8080
```

Open <http://localhost:8080>, press **Begin**. Playback requires a click first so
the browser allows audio to start.

`npm start` runs `tools/serve.mjs`, a zero-dependency static file server. Any
static server works — the app is plain ES modules with no build step:

```bash
python3 -m http.server 8080        # also fine
npx serve .                        # also fine
```

> Opening `index.html` directly from the filesystem (`file://`) will **not**
> work: ES modules are blocked by the browser's origin policy. Use a server.

## Controls

| Input | Action |
| --- | --- |
| `Space` / `K` | play / pause |
| `←` / `→` | seek ∓2 s (`Shift` = ∓10 s) |
| `Home` / `End` | jump to start / end |
| `F` | toggle fullscreen |
| `M` | mute / unmute |
| `R` | replay from the start |
| Scrub bar | click or drag to seek; acts are marked, hover shows a tooltip |
| Quality button | switch High ⇄ Performance (see *Performance*) |

## Architecture

```
index.html            start gate + player chrome (no logic)
src/main.js           rAF loop, transport, input, fullscreen, adaptive quality
src/core/
  math.js             clamp/lerp/ease, hashes, 1D and 2D value noise, colour mix
  quality.js          quality profiles + FrameGovernor (one-shot downgrade)
  platform.js         offscreen-canvas shim + baked sprite cache (grain, vignette, clouds)
src/rig/
  skeleton.js         pose schema, blending, forward kinematics, IK arms/legs
  clips.js            ~36 hand-authored keyed clips (stances, strikes, dodges…)
  render.js           DOM-free stick-figure renderer + fighterAnchors()
src/scene/
  choreo.js           THE SCRIPT: cast, camera keys, FX events, audio cues, titles
  actors.js           segment evaluation, locomotion easing, cast resolution
  camera.js           View transform, fitZoom(), camera sampling, shake
  world.js            sky, ridges, cliffs, statues, ground, treeline, foreground
  stage.js            compile() + renderAt() — the single deterministic frame fn
src/fx/effects.js     ~30 effect kinds (rasengan, chidori, shockwaves, debris…)
src/audio/
  engine.js           Web Audio synth: instruments, reverb, music scheduler
  director.js         maps the script's cues onto the engine, handles seeks
src/ui/
  titles.js           letterbox, location cards, act cards, credits
  style.css           player theme, scrub bar, start gate
tools/                QA + dev tooling (see docs/QA.md)
```

`renderAt(ctx, t, w, h, opts)` in `src/scene/stage.js` is the whole film. It reads
no clock and holds no state between calls, so it renders identically in the
browser and in the headless Node QA harness, and seeking to any `t` reproduces
exactly the frame that playing to `t` would have produced.

### Editing the choreography

`src/scene/choreo.js` is the only file you need for staging changes:

```js
N(26.0, -180, 'walk', { speed: 46 });            // Naruto: start at 26s, walk in
N(34.2, -60,  'jab',  { speed: 0, hold: 0.1 });  // a strike
K(34.0,  60,  'guard');                          // Sasuke: guard
CAM(34.0, [{ t: 34.0, x: 0, y: -110, zoom: 1.5, on: 'both', margin: 2.4 }]);
FX({ t: 34.1, kind: 'impact', who: 'n', hand: 'frontHand', size: 16 });
SFX(34.1, 'hit_soft');
```

`N()`/`K()` are Naruto/Sasuke position+clip segments. Camera keys accept
`on: 'both' | 'n' | 's' | 'point'`; the authored `x`/`y` become an *offset* and
the solver picks a zoom that keeps both fighters in frame.

**Effects are anchored to the skeleton.** An FX event that names `who` and `hand`
(`frontHand`, `backHand`, `chest`, `head`, `feet`, `both`) is positioned by
`fighterAnchors()` against the live rig every frame, so a Rasengan stays in the
palm through the whole windup instead of drifting off the arm.

Characters have 22 animated DOF (per side: shoulder ×2, elbow, wrist, hip ×2,
knee, ankle, plus spine ×3, neck, head). Clips are keyed with explicit
anticipation and follow-through frames, and `render.js` adds squash/stretch and
secondary motion (hair, scarf, sash) on top of the sampled pose.

## Audio

100% synthesised at runtime with the Web Audio API — no files, nothing sampled,
nothing downloaded.

* **Music:** original 84 BPM progression in D minor (Dm–Bb–F–C), built from
  oscillator+filter voices (pad, bass, koto-like pluck, taiko-ish drum) with a
  generated convolution reverb. Twelve arrangement sections follow the act
  timings, so the score breathes with the edit.
* **SFX:** ~40 procedural cues (whooshes, impacts, chakra charge, lightning,
  shockwaves, wind bed, room tone) triggered from the script's event list.
* **Seek-safe:** the director binary-searches the cue list on seek and re-arms
  the music window, so scrubbing never desynchronises picture and sound.

Because everything is generated, **there is no third-party music or SFX to
attribute** — see `docs/AUDIO.md`.

## Performance

Two profiles, switchable from the player and auto-selected once by
`FrameGovernor` if the first ~90 frames average over 20 ms:

| | High | Performance |
| --- | --- | --- |
| Render scale | 1.0 (DPR capped 2) | 0.8 (DPR capped 1.25) |
| Particles | 100% | 45% |
| Film grain | on | off |
| Ground detail | 150 pebbles | 70 |

The frame cost was profiled and rebuilt around that measurement: gradient fills
and per-pixel loops were replaced by content-keyed baked sprites (full-viewport
grain+vignette sheet, cloud sprites blitted 1:1, flat-banded sky), which cut the
headless software-render cost by roughly 40%. Measured numbers, and the honest
limits of what could be measured without a browser, are in `docs/QA.md`.

## Documentation

* `docs/QA.md` — test strategy, every automated suite, the PASS/FAIL/NOT
  TESTED/BLOCKED matrix, measured timings, and visual QA notes per act.
* `docs/AUDIO.md` — the licensing position and the synthesis design.
* `docs/REPORT.md` — final report: approach, technical decisions, animation
  quality, evidence, acceptance checklist, known limitations, deliverables.

## Known limitations

* **Not verified in a real browser.** This environment has no Chrome/Edge
  binary and cannot download one. The player, audio engine and UI are covered by
  an integration suite that runs the *real* `src/main.js` against a stubbed DOM
  and Web Audio implementation (`tools/browser-sim.mjs`), and the render core is
  verified pixel-exactly headlessly — but true end-to-end playback, real
  audio output and hardware FPS are **NOT TESTED** here.
* **60 FPS target is unconfirmed.** See `docs/QA.md` for what was measured and
  why a GPU-accelerated browser should be much faster than the software
  rasteriser used here.
* Skinning is limited to a two-bone-per-limb stick silhouette; hands and feet
  are dots, by design.
* The valley is a 2.5D parallax stage — fighters move on a single ground plane.
* No mobile/touch layout; designed for 16:9 desktop.

## Licence

Project code: MIT. Characters are fan-art stick figures inspired by *Naruto*
(Masashi Kishimoto / Shueisha); no original artwork, footage, or audio is
included or redistributed.

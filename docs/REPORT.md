# Final report — Naruto vs Sasuke, a stickman cinematic

## 1. Summary

A 4:18 (258 s) deterministic Canvas2D action short built from scratch as vanilla
ES modules with **zero runtime dependencies and zero binary assets**. Two
articulated stick fighters walk into a ruined valley, fight through five acts,
and end in an unresolved Rasengan/Chidori collision — no winner, by design.

Everything visible and audible is generated in code: characters, terrain,
effects, score and SFX. The player is a custom transport with scrubbing, act
marks, volume/mute, quality modes and keyboard control.

Delivered and verified to the extent this environment allows. Where it does not
allow (real browser, real GPU, real audio output), this report says so instead of
inventing numbers.

## 2. Technical decisions

**Vanilla ES modules + Canvas2D, no build step.** No bundler, no framework, no
runtime dependency. `npm install` only pulls the headless renderer used by QA.
The app is served as static files and runs as-is.

**The render core is DOM-free.** `renderAt(ctx, t, w, h, opts)` in
`src/scene/stage.js` is the entire film as one pure function. This was the
single most valuable decision: it let the *exact production drawing code* be
rasterised to PNG in Node for visual QA, in an environment with no browser. It
also gives determinism for free — the same `t` always yields the same frame.

**One scalar clock.** Playback advances `t += dt * slowmo(t)`. Pausing, seeking,
replaying and scrubbing all just set `t`. There is no second timeline that can
drift out of sync, and effects/camera/audio are all authored against the same
number.

**Camera as a solver, not a lerp.** Authored camera keys express *intent*
("push in on the clash"), and `cameraAt()` solves the actual framing: it resolves
the cast first, then centres between the fighters and picks a zoom that fits their
separation (`fitZoom`, `margin`, `minZoom`, `yBias`). This fixed fighters drifting
to the screen edges whenever the choreography moved them further apart than the
authored zoom expected.

**Effects anchored to the skeleton.** An FX event names `who` + `hand`
(`frontHand`, `chest`, `head`, `feet`, `both`); `fighterAnchors()` reads the live
rig each frame and the effect is drawn there. This directly addresses the failure
mode of a Rasengan floating away from a hand — it can no longer happen, because
the effect has no independent position to drift from.

**Procedural audio.** A synth-based score (84 BPM, D minor, Dm–Bb–F–C) and ~40
procedural SFX cues, with a look-ahead scheduler and a seek-safe director. No
files means no licensing surface at all — see `docs/AUDIO.md`.

**Data-driven choreography.** `src/scene/choreo.js` is the only file needed for
staging: positions, clips, camera keys, FX, SFX, sky keys, titles. Retiming an
exchange is a data edit.

## 3. Animation quality

* 22 animated DOF per fighter (shoulders ×2, elbows, wrists, hips ×2, knees,
  ankles, spine ×3, neck, head), driven by ~36 hand-keyed clips.
* Clips carry explicit anticipation and follow-through frames; the renderer adds
  squash/stretch on impacts and secondary motion (hair, scarf, sash, aura) driven
  by velocity.
* Locomotion segments ease from the previous segment's end position, so walk-ins
  neither teleport nor foot-slide.
* Impact frames are verified visually at the contact point (clash at t≈168.9,
  Rasengan in palm at t≈67.4, Chidori at t≈160).

Known limits, stated plainly: the figures are deliberately stick-figures (dot
hands/feet, minimal face), and the stage is 2.5D parallax on one ground plane —
no true depth occlusion or depth of field.

## 4. Audio licensing

**No third-party audio is used or included.** The score and every sound effect is
synthesised at runtime by `src/audio/engine.js`; there are no audio files in the
repository and no media is fetched at runtime. There is therefore nothing to
attribute and no licence obligation. Full detail in `docs/AUDIO.md`.

## 5. Test evidence

| Suite | Command | Result |
| --- | --- | --- |
| Timeline integrity (8 areas, 12 assertions) | `node tools/test-timeline.mjs` | **12 / 12 pass** — 517 frames rendered, determinism and seek-equivalence verified by pixel hash |
| Player integration (real `main.js`, stubbed DOM+Audio) | `node tools/browser-sim.mjs` | **34 / 34 pass** — boot, gate, transport, seek, UI, keyboard, resize, scrub, end state |
| Full QA run + report | `npm run qa` | all steps pass → `qa-out/QA-REPORT.txt` |
| Visual QA | `tools/probe.mjs`, `tools/strip.mjs` | per-act filmstrips at 1280×720; 6 rounds of fixes |
| Performance profiling | `tools/perf.mjs`, `--cpu-prof` | see §6 |

Visual QA found and fixed three genuine coordinate-space bugs (a screen-space
rectangle painted inside the world transform, a ground plane sized in the wrong
units, and a double-applied zoom that collapsed the canyon walls on wide shots).
It also found a real defect in the quality system: the *profile object* was never
resolved, so film grain, motes and letterboxing were silently disabled in every
mode.

## 6. Measured performance

Measured on the only available renderer here: `@napi-rs/canvas`, a **CPU
rasteriser** on a 2-vCPU sandbox. No GPU, no browser.

| Configuration | Mean | Median | p95 | Worst |
| --- | --- | --- | --- | --- |
| 1920×1080, high (all 258 s) | 115.4 ms | 87.8 ms | 294 ms | 401 ms |
| 1280×720, high | 41.5 ms/frame | — | — | — |
| 1280×720, performance | 35.8 ms/frame | — | — | — |

Profiling drove a ~40% reduction in CPU frame cost. The wins came from replacing
full-viewport rasterisation with content-keyed baked sprites: the per-pixel grain
loop became one blitted speckle sheet, the sky's 4-stop full-screen gradient
became a cached strip, cloud gradients became sprites blitted 1:1, the vignette
and grain were merged into a single pinned sheet, and the ground's 10-stop
gradient over a 4000×1200 world span became a cached strip blit. A cache-thrash
bug was also fixed: transient cloud sprites were evicting the full-viewport
sheets, forcing them to be re-baked on every single frame.

**60 FPS is NOT VERIFIED.** What remains expensive here is full-screen alpha
compositing, which a GPU-accelerated browser composites in microseconds and a CPU
rasteriser does in tens of milliseconds. I am not claiming a frame rate I could
not measure; the honest status is *built and profiled, rate untested*.

## 7. Acceptance checklist

| Requirement | Status |
| --- | --- |
| 3–5 min cinematic, 16:9, fullscreen | **PASS** (258 s; fullscreen wired & integration-tested) |
| 5 acts, correct timings | **PASS** |
| Articulated characters, 20+ DOF, anticipation/follow-through/squash-stretch/secondary motion | **PASS** |
| Camera: tracking, zoom, shake, close-ups, cuts | **PASS** |
| Rich synced VFX | **PASS** |
| Original multi-layer parallax battlefield reacting to attacks | **PASS** |
| Only legally cleared music, documented | **PASS** — nothing licensed; fully synthesised, `docs/AUDIO.md` |
| Layered synced SFX | **PASS** |
| Player UI + keyboard | **PASS** (verified against a stubbed DOM) |
| Deterministic timeline, seek-exact | **PASS** |
| Modular architecture, editable choreography | **PASS** |
| 60 FPS target, high/perf modes, adaptive particles | **Built / NOT TESTED (rate)** |
| README with install/run/compat/attribution/limitations | **PASS** |
| Visual QA per act + full watch-through | **PASS (frame-sampled)** / watch-through **NOT TESTED** |
| PASS/FAIL/NOT TESTED/BLOCKED matrix | **PASS** — `docs/QA.md` |
| Final report | **PASS** — this file |
| Never fabricate results | **PASS** — every number above is from a command in this repo |
| Do not publish/deploy | **PASS** — nothing pushed or deployed |

## 8. Limitations

* **No browser in the build environment.** Chrome/Edge could not be installed
  (`ECONNRESET`). Real end-to-end playback, GPU frame rate and audible output are
  **NOT TESTED / BLOCKED**. Coverage was maximised instead: the real player and
  audio code run under a stubbed DOM/Web Audio, and the real render core is
  verified pixel-exactly headlessly.
* **Firefox/Safari** not tested; only standard Canvas2D and Web Audio APIs are
  used, so breakage is not expected but is unverified.
* **Frame rate** unverified (see §6).
* Stick-figure style with two-bone limbs and dot extremities; single ground
  plane, no depth-of-field.
* Very wide shots (zoom ≈ 0.34) expose large flat ground areas; terrain density
  is tuned for the mid shots that dominate the runtime.
* Desktop-only layout; no touch controls.

## 9. How to run

```bash
npm install     # headless renderer for QA only
npm start       # http://localhost:8080  → press Begin
npm run qa      # all automated suites + qa-out/QA-REPORT.txt
```

## 10. Deliverables

| Path | Contents |
| --- | --- |
| `index.html`, `src/**` | the film and the player |
| `README.md` | install, run, controls, architecture, compatibility, limitations |
| `docs/QA.md` | test strategy, suites, PASS/FAIL/NOT TESTED/BLOCKED matrix, measurements |
| `docs/AUDIO.md` | licensing position and synthesis design |
| `docs/REPORT.md` | this report |
| `tools/**` | static server, headless renderer, filmstrip, trace, perf and test harnesses |
| `qa-out/**` | rendered stills, per-act filmstrips, `QA-REPORT.txt` |

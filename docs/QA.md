# QA: strategy, evidence and status

## The constraint this document is written under

This project was built in a sandbox with **no browser binary**. `playwright
install chromium` fails with `ECONNRESET`, `npm i canvas` fails in node-gyp, and
CDN access is blocked. The only working renderer is the headless
`@napi-rs/canvas` (a Skia binding, CPU-only — no GPU acceleration, no DOM).

That shaped the whole verification approach:

1. The render core was written **DOM-free** so the *exact same modules* that draw
   the browser canvas can be rasterised to PNG in Node. Visual QA is therefore
   real evidence about the film, not a mock-up.
2. The player, UI and audio were verified by loading the **real, unmodified
   `src/main.js`** into a stubbed DOM + Web Audio environment and driving every
   control (see `tools/browser-sim.mjs`).
3. Anything that genuinely requires Chrome/Edge — actual playback, hardware
   GPU frame rate, real audio output — is marked **NOT TESTED** or **BLOCKED**
   below rather than claimed.

Reproduce everything with:

```bash
npm install
npm run qa            # runs all suites, writes qa-out/QA-REPORT.txt
```

---

## Automated suites

### 1. Timeline integrity — `tools/test-timeline.mjs` → 12/12 pass

| # | Check | What it proves |
| --- | --- | --- |
| 1 | Render sweep 0→258 s @ 2 fps | no frame throws across the whole film |
| 2 | Determinism (12 probe times, interleaved) | pixel hash is identical regardless of call order |
| 3 | Seek equivalence | seek to *t* == fresh render at *t* (5/60/130/175/210/250) |
| 4 | Actor sanity (NaN, ground contact, presence) | rigs never produce NaN and never sink through the floor |
| 5 | Cue ordering | every `events[]` entry is sorted and in range |
| 6 | Music coverage | a cue exists in every 4 s window (3540 events) |
| 7 | FX validity | every `fx[]` event has a known `kind` and finite numbers |
| 8 | Camera range | zoom/position stay inside sane bounds on every sampled frame |

Last run: `rendered 517 frames in 12.2s`, `music events in 4s windows: 3540 total`,
**12 passed, 0 failed**.

### 2. Player integration — `tools/browser-sim.mjs` → 34/34 pass

Loads the real `src/main.js` (plus the real `src/audio/*`) through a module
shim into a stubbed browser: DOM elements with class lists and event dispatch,
`requestAnimationFrame` pumping, `devicePixelRatio`, fullscreen API, and a Web
Audio implementation that records every node.

| Area | Checks |
| --- | --- |
| Boot | app boots, exposes `window.__ninja`, duration in 180–300 s |
| Gate | gate visible before start, fades on Begin, chrome appears, autoplay starts |
| Transport | timeline advances; pause freezes it; resume does not jump; replay resets and plays |
| Seek | 5 targets land within one frame; a frame is genuinely painted after seeking |
| UI | play icon state, volume slider → engine gain, mute/unmute, quality toggle |
| Keyboard | Space, ←/→, M, F (fullscreen entry verified through the stub API) |
| Layout | resize to 900×900 and 1920×1080 both survive |
| Scrub | pointerdown seeks, drag seeks, release ends the gesture |
| End state | playback stops exactly at total duration and leaves the transport paused |
| Audio churn | 2674 nodes created over the session (scheduler is bounded, no runaway) |

Last run: **34 passed, 0 failed**.

### 3. Visual QA — act-by-act inspection at 1280×720

Rendered with `tools/probe.mjs` (stills) and `tools/strip.mjs` (filmstrips), then
inspected by eye. Six rounds of fixes came directly out of this loop:

| Act | Window | What was checked | Fixes made |
| --- | --- | --- | --- |
| I | 0–26 s | reveal, location card, ACT I card, walk-in | walk-in was teleporting → locomotion eases from previous segment end; camera tightened |
| II | 26–76 s | close combat framing, hit contact | fighters drifted to frame edges → camera solved from cast separation (`fitZoom`) |
| III | 76–132 s | ninjutsu, Rasengan/Chidori | effects detached from hands → FX anchored to live skeleton (`fighterAnchors`) |
| IV | 132–196 s | escalation, charge, clash | charge effects vanished mid-windup → durations extended to the strike; sky lifted out of near-black |
| V | 196–258 s | final collision, dome, open ending, credits | wide shots showed a grey rectangle and a collapsed corridor → three real coordinate-space bugs fixed (below) |

Coordinates bugs found and fixed through visual QA (all were genuine, all
reproduced as visible artifacts):

1. `drawRidges` closed its silhouette with a `fillRect` down to `view.h` **while
   the camera transform was active**, painting a screen-space rectangle in world
   space. Visible as a grey box at t≈202.
2. `drawGround` sized itself from screen pixels but drew inside the camera
   transform, so the ground plane's extent tracked the wrong units.
3. `drawValleyWalls` multiplied `zoom` into a term that already contained
   `view.scale`, collapsing both cliffs toward frame centre on wide shots — the
   same "grey box" symptom from a different cause. The edge offset is now clamped
   in *screen* fractions.

### 4. Performance profiling — `tools/profile.mjs`, `tools/perf.mjs`

Profiled with `node --cpu-prof` and optimised the measured hotspots (not guesses):

| Change | Effect |
| --- | --- |
| Film grain: per-pixel `fillRect` loop → pre-baked full-viewport speckle sheet | the single biggest win; the loop was ~200k rects/frame |
| Sky: 4-stop full-viewport gradient → flat bands with short blend strips → single cached gradient strip | 12.5 ms → 1.4 ms in isolation |
| Clouds: rebuilt gradient puffs per frame → cached sprites blitted 1:1 at baked size | 22.5 ms → ~2 ms in isolation |
| Post: separate vignette + grain passes → one merged pinned sheet | post pass from 101 ms → ~19 ms in isolation |
| Ground: 10-stop gradient over a 4000×1200 world span → cached strip blit | ~12% of frame time |
| Cache thrash fix | cloud sprites were evicting the post sheets, forcing a re-bake every frame; full-viewport sheets now live in a never-evicted cache |
| `q.motes`/`q.grain`/`q.letterbox` bug | the quality **profile** was never resolved, so grain, motes and letterboxing were silently off in every mode; now fixed |

**Measured** (`@napi-rs/canvas`, CPU rasteriser, 2 vCPU sandbox):

| Configuration | Mean | Median | p95 | Worst |
| --- | --- | --- | --- | --- |
| 1920×1080, high, whole film (258 frames) | 115.9 ms | 89.7 ms | 293 ms | 398 ms (t=171) |
| 1280×720, high | 40.6 ms/frame | — | — | — |
| 1280×720, performance | 35.6 ms/frame | — | — | — |

Interpretation, stated plainly: **a CPU rasteriser is not the target
environment.** These numbers are single-threaded software fills; the heaviest
frames are dominated by full-screen alpha compositing (grain/vignette sheets,
dome, slow-motion grade) which a GPU-accelerated browser composites in
microseconds. The 60 FPS claim for Chrome/Edge on real hardware is
**NOT TESTED** — see the matrix.

---

## Status matrix

### Functional requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| 3–5 min runtime | **PASS** | `TOTAL_DURATION = 258 s` (4:18), asserted by browser-sim |
| 5 acts with the specified timing | **PASS** | act boundaries 0/26/76/132/196 in `choreo.js`; filmstrips per act |
| Articulated characters, ≥20 DOF | **PASS** | 22 animated channels per fighter in `rig/skeleton.js`; visual QA |
| Anticipation / follow-through / squash-stretch / secondary motion | **PASS** | keyed clip timing + `render.js` squash and hair/scarf/sash sway; visual QA |
| Open ending, no winner | **PASS** | both fighters hold a locked clash to 213 s, "NO ONE WINS" card; verified at t=204.6 and 213 |
| Tracking / zoom / shake / close-ups / cuts | **PASS** | camera solve in `stage.js`; sanity-checked by suite #8 |
| Synced VFX | **PASS** | FX keyed from the same event list as the audio cues |
| Effects anchored to the body (never pasted on) | **PASS** | `fighterAnchors()` → `anchorFx()`; Rasengan verified in the palm at t=67.4 |
| Parallax battlefield reacting to attacks | **PASS** | 4 parallax bands + sky keys + cracks/debris on impact |
| Player UI (play/pause/replay/scrub/time/duration/volume/mute/fullscreen) | **PASS** (stubbed DOM) | 34/34 integration checks |
| Keyboard control | **PASS** (stubbed DOM) | Space/K, ←/→, Shift, F, M, R, Home/End |
| Deterministic timeline, seek-exact | **PASS** | `test-timeline.mjs` checks 1–3 |
| Modular architecture, editable choreography | **PASS** | `choreo.js` is data-only; render core has zero DOM references |
| 60 FPS target, high/perf modes, adaptive particles | **PASS (built) / NOT TESTED (rate)** | profiles + `FrameGovernor` implemented; see performance matrix |
| Full README | **PASS** | `README.md` |
| Docs, matrix, final report | **PASS** | this file, `docs/AUDIO.md`, `docs/REPORT.md` |
| Visual QA per act + full watch-through | **PASS (frame-sampled)** | filmstrips per act; see limitation below |

### Environment-dependent items

| Item | Status | Reason |
| --- | --- | --- |
| Real Chrome/Edge playback, end to end | **NOT TESTED** | no browser binary obtainable in this sandbox |
| Hardware GPU frame rate / measured 60 FPS | **BLOCKED** | no GPU, no browser; software-rasteriser numbers reported instead |
| Real audio output (does it *sound* right?) | **NOT TESTED** | no audio device; the audio graph is exercised (2674 nodes, no errors) but not heard |
| Cross-browser (Firefox/Safari) | **NOT TESTED** | not installed; code uses only standard Canvas2D + Web Audio APIs |
| Full watch-through at realtime speed | **NOT TESTED** | playback is frame-sampled and seek-verified instead |
| Mobile / touch layout | **NOT TESTED** | deliberately out of scope, desktop 16:9 |
| Colour accuracy across displays | **NOT TESTED** | no display |

## Known visual limitations

* The characters are deliberately minimal stick figures: two-bone limbs, dot
  hands/feet, no facial rig beyond brow/eye marks.
* The valley is a 2.5D parallax stage on a single ground plane; there is no
  depth of field and no true 3D occlusion.
* At the widest shots (zoom ≈ 0.34) the ground plane shows large flat areas;
  geometry density is tuned for the mid shots that dominate the film.

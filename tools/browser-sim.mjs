// Headless integration test of the *real* player application.
//
// No browser binary is available in this environment, so we provide a faithful
// minimal DOM + Web Audio implementation and load src/main.js unmodified. That
// exercises the actual player code path: boot, gate, play/pause/seek/replay,
// volume/mute, quality switching, resize, keyboard shortcuts and cleanup.
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  return false;
};

// ---------------------------------------------------------------- fake DOM
class FakeClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, on) { const v = on === undefined ? !this.s.has(c) : on; if (v) this.s.add(c); else this.s.delete(c); return v; }
  contains(c) { return this.s.has(c); }
}

class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '85';
    this.width = 0; this.height = 0;
    this.clientWidth = 1280; this.clientHeight = 720;
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const a = this.listeners[type] || [];
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  dispatch(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn({ type, preventDefault() {}, ...ev });
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; }
  requestFullscreen() { return Promise.resolve(); }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return true; }
  getContext(kind) {
    if (this._ctx) return this._ctx;
    const cv = createCanvas(1280, 720);
    this._canvas = cv;
    this._ctx = cv.getContext('2d');
    return this._ctx;
  }
  focus() {}
}

const elements = new Map();
const ids = ['stage', 'stage-wrap', 'gate', 'begin', 'chrome', 'topbar', 'bottombar', 'playpause',
  'icon-play', 'icon-pause', 'replay', 'time', 'scrub', 'scrub-fill', 'scrub-knob', 'scrub-marks',
  'scrub-tip', 'scrub-buffer', 'mute', 'icon-vol', 'icon-mute', 'vol', 'quality', 'fps',
  'fullscreen', 'toast'];
for (const id of ids) elements.set(id, new FakeEl(id === 'stage' ? 'canvas' : id === 'vol' ? 'input' : 'div', id));
const wrapEl = elements.get('stage-wrap');

const listeners = {};
const documentShim = {
  fullscreenElement: null,
  documentElement: { requestFullscreen: () => { documentShim.fullscreenElement = {}; fireDoc('fullscreenchange'); return Promise.resolve(); } },
  exitFullscreen: () => { documentShim.fullscreenElement = null; fireDoc('fullscreenchange'); return Promise.resolve(); },
  hidden: false,
  getElementById: (id) => elements.get(id) || null,
  createElement: (t) => new FakeEl(t),
  addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  removeEventListener: (t, fn) => { const a = listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  querySelector: () => null,
};
function fireDoc(type) { for (const fn of listeners[type] || []) fn({ type }); }

// ---------------------------------------------------------------- fake Web Audio
class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
class Node {
  constructor(kind) { this.kind = kind; this.gain = new Param(1); this.frequency = new Param(440); this.detune = new Param(0); this.Q = new Param(1); this.pan = new Param(0); this.playbackRate = new Param(1); this.buffer = null; this.type = 'sine'; }
  connect(n) { this._c = n; return n; }
  disconnect() {}
  start() { this._started = true; }
  stop() { this._stopped = true; }
}
let audioNodes = 0;
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = new Node('dest');
    this._nodes = [];
  }
  _mk(kind) { audioNodes++; const n = new Node(kind); this._nodes.push(n); return n; }
  createGain() { return this._mk('gain'); }
  createOscillator() { return this._mk('osc'); }
  createBiquadFilter() { return this._mk('filter'); }
  createStereoPanner() { return this._mk('panner'); }
  createConvolver() { return this._mk('conv'); }
  createBufferSource() { return this._mk('bufsrc'); }
  createDynamicsCompressor() {
    const n = this._mk('comp');
    n.threshold = new Param(-24); n.knee = new Param(30); n.ratio = new Param(12);
    n.attack = new Param(0.003); n.release = new Param(0.25);
    return n;
  }
  createBuffer(ch, len) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, getChannelData: (i) => data[i], sampleRate: this.sampleRate };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

// ---------------------------------------------------------------- raf pump
let rafQueue = [];
let now = 0;
const performanceShim = { now: () => now };

const sandbox = {
  document: documentShim,
  window: null,
  navigator: { userAgent: 'headless-sim' },
  performance: performanceShim,
  KeyboardEvent: class {},
  console,
  setTimeout: (fn, ms) => setTimeout(fn, 0),
  clearTimeout,
  AudioContext: FakeAudioContext,
  devicePixelRatio: 2,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: (id) => { rafQueue[id - 1] = null; },
  addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  removeEventListener: (t, fn) => { const a = listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  innerWidth: 1280, innerHeight: 720,
  Math, Date, JSON, Object, Array, Number, String, Boolean, Error, Promise, Map, Set, Float32Array, isFinite, isNaN, parseInt, parseFloat,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// transpile ESM imports into a tiny module registry so the real main.js runs
const SRC = path.resolve('src');
const moduleCache = new Map();
async function loadModule(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const promise = (async () => {
    // resolve imports
    const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"];?/g;
    let shim = '';
    const specs = [];
    let m;
    let idx = 0;
    while ((m = importRe.exec(src))) {
      const [full, def, named, spec] = m;
      const target = path.resolve(path.dirname(file), spec);
      const mod = await loadModule(target);
      const id = `__m${idx++}`;
      specs.push({ id, mod });
      const parts = [];
      if (named) {
        for (const raw of named.split(',')) {
          const n = raw.trim();
          if (!n) continue;
          const [a, b] = n.split(/\s+as\s+/);
          parts.push(`${(b || a).trim()} = ${id}.${a.trim()}`);
        }
      }
      if (def) parts.push(`${def} = ${id}.default`);
      shim += `const ${id} = __mods[${JSON.stringify(id)}];\n${parts.join(';\n')};\n`;
    }
    let body = src.replace(importRe, '');
    body = body.replace(/export\s+default\s+/g, 'exports.default = ');
    body = body.replace(/export\s+(async\s+)?function\s+(\w+)/g, (_, asy, name) => {
      return `${asy ? 'async ' : ''}function ${name}`;
    });
    body = body.replace(/export\s+(const|let|var)\s+(\w+)/g, '$1 $2');
    // capture re-exports (`export { Foo }` / `export { Foo as Bar }`) before stripping
    const reexported = [];
    body = body.replace(/export\s*\{([^}]*)\}\s*;?/g, (_, inner) => {
      for (const raw of inner.split(',')) {
        const n = raw.trim();
        if (!n) continue;
        const [a, b] = n.split(/\s+as\s+/);
        reexported.push({ from: a.trim(), to: (b || a).trim() });
      }
      return '';
    });
    // classes and default-exported values
    body = body.replace(/export\s+class\s+(\w+)/g, 'class $1');
    body = body.replace(/export\s*\{[^}]*\}\s*from[^;]*;/g, '');
    // collect top level declarations to expose as module exports
    const declRe = /^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)|^class\s+(\w+)/gm;
    const names = [];
    let d;
    while ((d = declRe.exec(body))) names.push(d[1] || d[2] || d[3]);
    const mods = {};
    for (const s of specs) mods[s.id] = s.mod;
    const code = `
      const exports = {};
      ${shim}
      ${body}
      ${names.map((n) => `try { exports[${JSON.stringify(n)}] = ${n}; } catch {}`).join('\n')}
      ${reexported.map((r) => `try { exports[${JSON.stringify(r.to)}] = ${r.from}; } catch {}`).join('\n')}
      exports.default = exports.default || undefined;
      exports.__esModule = true;
      return exports;
    `;
    const fn = new vm.Script(`(function(__mods){ ${code} })`, { filename: file });
    const run = fn.runInContext(sandbox);
    return run(mods);
  })();
  moduleCache.set(file, promise);
  return promise;
}

// ---------------------------------------------------------------- run it
console.log('\n[browser-sim] loading the real player application…');
const main = await loadModule(path.join(SRC, 'main.js'));
// main.js has no exports but executes; allow microtasks to settle
await new Promise((r) => setTimeout(r, 120));

const N = sandbox.__ninja;
check('application boots and exposes its player', !!N);
check('total duration is between 3 and 5 minutes', N && N.total >= 180 && N.total <= 300, N && String(N.total));

function pump(frames, msPerFrame = 16.7) {
  for (let i = 0; i < frames; i++) {
    now += msPerFrame;
    const q = rafQueue; rafQueue = [];
    for (const fn of q) if (fn) fn(now);
    // allow promise chains to run
  }
}

// gate -> begin
pump(3);
const beginBtn = elements.get('begin');
check('gate is visible before start', !elements.get('gate').classList.contains('fade-out'));
beginBtn.dispatch('click', {});
await new Promise((r) => setTimeout(r, 60));
pump(5);
check('gate fades out after Begin', elements.get('gate').classList.contains('fade-out'));
check('player chrome becomes visible', !elements.get('chrome').classList.contains('hidden'));
check('playback started automatically', N.playing === true);

// advance ~2s of playback
pump(120);
check('timeline advances while playing', N.t > 1.0, `t=${N.t.toFixed(2)}`);
const tAfterPlay = N.t;

// pause -> freeze
N.pause();
pump(30);
check('pause freezes the timeline', Math.abs(N.t - tAfterPlay) < 0.001, `t=${N.t.toFixed(3)}`);
check('pause shows the play icon', !elements.get('icon-play').classList.contains('hidden'));

// resume does not jump
N.play();
pump(10);
check('resume continues from the paused position', N.t > tAfterPlay && N.t - tAfterPlay < 1.0, `dt=${(N.t - tAfterPlay).toFixed(3)}`);

// seek backwards/forwards
for (const target of [120, 42.5, 200, 7.25, 58.8]) {
  N.seek(target);
  pump(2);
  // playback advances for the two frames we pump, so allow ~2 frames of drift
  check(`seek to ${target}s`, Math.abs(N.t - target) < 0.08, `t=${N.t.toFixed(3)}`);
}

// seek must produce a fully rendered frame (no blank canvas)
N.seek(168.7);
pump(2);
const stageEl = elements.get('stage');
const px = stageEl._ctx.getImageData(640, 360, 1, 1).data;
check('frame is actually painted after seek', px[0] + px[1] + px[2] > 20, `rgb=${px[0]},${px[1]},${px[2]}`);

// replay
N.replay();
pump(3);
check('replay resets to the beginning', N.t < 0.6, `t=${N.t.toFixed(2)}`);
check('replay resumes playback', N.playing === true);

// volume + mute through the UI
const volEl = elements.get('vol');
volEl.value = '35';
volEl.dispatch('input', { target: volEl });
check('volume slider updates engine volume', Math.abs(N.state.volume - 0.35) < 0.01, String(N.state.volume));
elements.get('mute').dispatch('click', {});
check('mute toggles', N.state.muted === true);
elements.get('mute').dispatch('click', {});
check('unmute toggles back', N.state.muted === false);

// quality switching
elements.get('quality').dispatch('click', {});
pump(2);
check('quality switch does not break rendering', elements.get('quality').textContent.length > 0);
elements.get('quality').dispatch('click', {});
pump(2);

// keyboard shortcuts
const win = sandbox;
const keydown = (code, extra = {}) => { for (const fn of listeners.keydown || []) fn({ code, target: elements.get('stage'), preventDefault() {}, ...extra }); };
N.seek(60);
pump(1);
keydown('Space');
pump(2);
check('Space pauses', N.playing === false);
keydown('Space');
pump(2);
check('Space resumes', N.playing === true);
keydown('ArrowRight');
pump(1);
check('ArrowRight seeks forward', N.t > 62, `t=${N.t.toFixed(2)}`);
keydown('ArrowLeft');
pump(1);
check('ArrowLeft seeks backward', N.t < 62.5, `t=${N.t.toFixed(2)}`);
keydown('KeyM');
check('M mutes', N.state.muted === true);
keydown('KeyM');
keydown('KeyF');
await new Promise((r) => setTimeout(r, 30));
check('F requests fullscreen', !!documentShim.fullscreenElement);

// resize must not throw and must keep rendering
sandbox.innerWidth = 900; sandbox.innerHeight = 900;
for (const fn of listeners.resize || []) fn({});
pump(3);
check('window resize handled', true);
sandbox.innerWidth = 1920; sandbox.innerHeight = 1080;
for (const fn of listeners.resize || []) fn({});
pump(3);

// scrub dragging
const scrubEl = elements.get('scrub');
scrubEl.dispatch('pointerdown', { pointerId: 1, clientX: 320 });
check('scrub pointerdown seeks', Math.abs(N.t - (320 / 1280) * N.total) < 2, `t=${N.t.toFixed(2)}`);
scrubEl.dispatch('pointermove', { pointerId: 1, clientX: 960 });
check('scrub drag seeks', N.t > N.total * 0.6, `t=${N.t.toFixed(2)}`);
scrubEl.dispatch('pointerup', { pointerId: 1, clientX: 960 });

// --- regression: scrub markers must match the choreography's act boundaries
const markEls = elements.get('scrub-marks').children;
const script = N.script || null;
if (script && script.acts) {
  check('scrub markers come from the script act list',
    markEls.length === script.acts.length,
    `markers=${markEls.length} acts=${script.acts.length}`);
  const firstPct = parseFloat(markEls[0].style.left);
  const lastAct = script.acts[script.acts.length - 1];
  const lastPct = parseFloat(markEls[markEls.length - 1].style.left);
  check('last marker sits at the last act boundary',
    Math.abs(lastPct - (lastAct.t / N.total) * 100) < 0.01,
    `${lastPct.toFixed(2)}% vs ${((lastAct.t / N.total) * 100).toFixed(2)}%`);
  check('acts strictly increase', script.acts.every((a, i) => i === 0 || a.t > script.acts[i - 1].t));
} else {
  check('script exposes an act list for the scrub markers', false, 'script.acts missing');
}

// --- regression: keyboard seek intervals (2 s, Shift = 10 s)
N.seek(100); pump(1);
keydown('ArrowRight');
pump(1);
const dPlain = N.t - 100;
check('ArrowRight steps 2s', Math.abs(dPlain - 2) < 0.12, `dt=${dPlain.toFixed(2)}`);
N.seek(100); pump(1);
keydown('ArrowRight', { shiftKey: true });
pump(1);
const dShift = N.t - 100;
check('Shift+ArrowRight steps 10s', Math.abs(dShift - 10) < 0.12, `dt=${dShift.toFixed(2)}`);

// run to the end and make sure it stops cleanly
N.seek(N.total - 0.5);
pump(120);
check('playback stops at the end of the timeline', Math.abs(N.t - N.total) < 0.1, `t=${N.t.toFixed(2)}`);
check('playback is paused at the end', N.playing === false);

// audio node churn (leak detector proxy)
console.log(`\n[info] audio nodes created during the session: ${audioNodes}`);
check('audio scheduling stays bounded', audioNodes < 200000, `${audioNodes}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }

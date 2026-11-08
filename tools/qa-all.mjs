// One-shot QA runner: runs every automated check and writes a report.
//
//   npm run qa
//
// Steps:
//   1. timeline integrity suite   (tools/test-timeline.mjs)
//   2. player integration suite   (tools/browser-sim.mjs)  — real src/main.js,
//      real src/audio/*, in a stubbed DOM + Web Audio environment
//   3. frame render sweep         (tools/probe.mjs at act boundaries)
//   4. filmstrips                 (tools/strip.mjs per act)
//
// Results are written to qa-out/QA-REPORT.txt and summarised on stdout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'qa-out';
fs.mkdirSync(OUT, { recursive: true });

const lines = [];
let failed = 0;

function section(title) {
  lines.push('');
  lines.push('='.repeat(78));
  lines.push(title);
  lines.push('='.repeat(78));
}

function run(label, args, opts = {}) {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.trim().split('\n').slice(-14).join('\n');
  section(label);
  lines.push(tail);
  const ok = r.status === 0;
  if (!ok) failed++;
  lines.push(`RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  process.stdout.write(`${tail.split('\n').slice(-3).join('\n')}\n${ok ? '  PASS' : '  FAIL'}\n`);
  return ok;
}

const started = Date.now();

run('1. timeline integrity suite (tools/test-timeline.mjs)', ['tools/test-timeline.mjs']);
run('2. player integration suite (tools/browser-sim.mjs)', ['tools/browser-sim.mjs']);
run('3. act-boundary render sweep', ['tools/probe.mjs', '0', '18', '45', '76', '100', '132', '160', '168.9', '185', '201.5', '225', '250']);

// filmstrips: 8 samples per act, tiled
const acts = [
  ['act1', 0, 26],
  ['act2', 26, 76],
  ['act3', 76, 132],
  ['act5a', 132, 196],
  ['act5b', 196, 258],
];
for (const [name, a, b] of acts) {
  run(`4.${name} filmstrip ${a}s–${b}s`, ['tools/strip.mjs', String(a), String(b), '8', '4']);
  const src = path.join(OUT, 'strip.png');
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, `strip-${name}.png`));
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
lines.unshift(`Ninja-Battle QA report — ${new Date().toISOString()}`);
lines.unshift(`total wall time: ${elapsed}s   failures: ${failed}`);
fs.writeFileSync(path.join(OUT, 'QA-REPORT.txt'), lines.join('\n') + '\n');

console.log(`\n${failed ? `${failed} STEP(S) FAILED` : 'all QA steps passed'} — see ${OUT}/QA-REPORT.txt`);
process.exit(failed ? 1 : 0);

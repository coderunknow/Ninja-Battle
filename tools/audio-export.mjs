// Renders an arbitrary-length stretch of the real soundtrack to one WAV file.
//
//   node tools/audio-export.mjs <t0> <dur> <out.wav> [--chunk=32]
//         [--music-only] [--sfx-only] [--reverb=0]
//
// Why chunked: this Web Audio implementation (node-web-audio-api) costs roughly
// a fixed ~40 ms of CPU per scheduled note, and the film has ~2900 music notes
// plus several hundred cue events, so one monolithic 258 s render does not
// finish in any reasonable time. Each chunk is an independent offline context,
// rendered in its own process so nothing accumulates, then concatenated. The
// only thing lost across a chunk boundary is a reverb tail that is still fading
// (<= 3.2 s impulse, at -50 dB after 1.5 s); playing the chunks back to back is
// otherwise sample-accurate because the score is a pure function of time.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const opt = (name, dflt) => {
  const f = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=')[1] : dflt;
};
const t0 = Number(args[0] ?? 0);
const dur = Number(args[1] ?? 30);
const out = args[2] || `qa-out/export-${t0}-${t0 + dur}.wav`;
const chunk = Number(opt('chunk', 32));
const SR = 48000;

fs.mkdirSync(path.dirname(out), { recursive: true });
const tmpDir = fs.mkdtempSync('/tmp/audioexp-');
const parts = [];
let idx = 0;
const jobs = [];
for (let t = t0; t < t0 + dur; t += chunk) {
  const d = Math.min(chunk, t0 + dur - t);
  const p = path.join(tmpDir, `part-${String(idx).padStart(3, '0')}.wav`);
  jobs.push({ t, d, p });
  idx++;
}
console.error(`export ${dur}s from ${t0}s in ${jobs.length} chunks of ${chunk}s`);

let done = 0;
async function runOne(job) {
  const env = { ...process.env };
  if (flags.has('--music-only')) env.NO_SFX = '1';
  if (flags.has('--sfx-only')) env.MUSIC_ONLY = '1';
  const rv = opt('reverb', null);
  if (rv !== null) env.REVERB = rv;
  const c = spawn(process.execPath, ['tools/audio-render.mjs', String(job.t), String(job.d), job.p], {
    env, stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise((res, rej) => c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`chunk ${job.t} failed (${code})`)))));
  done++;
  console.error(`  ${String(done).padStart(3)}/${jobs.length}  t=${job.t}s`);
}
// Bounded parallelism: each chunk is CPU-bound; 2 at a time on this box.
const queue = [...jobs];
await Promise.all([0, 1].map(async () => { while (queue.length) await runOne(queue.shift()); }));

// ---- concatenate
const bufs = jobs.map((j) => fs.readFileSync(j.p));
let dataLen = 0;
const datas = bufs.map((b) => {
  const d = b.subarray(44);
  dataLen += d.length;
  return d;
});
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + dataLen, 4); head.write('WAVE', 8);
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28);
head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
head.write('data', 36); head.writeUInt32LE(dataLen, 40);
fs.writeFileSync(out, Buffer.concat([head, ...datas]));
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`wrote ${out}  (${(dataLen / 4 / SR).toFixed(2)} s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);

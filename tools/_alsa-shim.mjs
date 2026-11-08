// Bootstraps the real Web Audio native binding on a machine with no ALSA.
//
// The binding dlopens libasound.so.2. shim/build.sh generates an inert stub
// library from the binding's own undefined-symbol table (so it always exports
// exactly the 79 symbols the .node file asks for, at the version nodes it asks
// for), and this module makes sure that stub is on the loader path before
// node-web-audio-api is imported.
//
// LD_LIBRARY_PATH is read by the dynamic loader at process start, so it cannot
// usefully be set at runtime — this re-execs the script once with it in the
// environment. Import this module *before* node-web-audio-api. On a normal
// desktop with real ALSA installed it is a no-op.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const shimDir = path.join(repoRoot, 'shim');
const shimLib = path.join(shimDir, 'libasound.so.2');

if (fs.existsSync('/usr/lib/x86_64-linux-gnu/libasound.so.2')) {
  // real ALSA present: nothing to do
} else {
  if (!fs.existsSync(shimLib)) {
    try {
      execFileSync('bash', [path.join(shimDir, 'build.sh')], { stdio: 'inherit', cwd: repoRoot });
    } catch (e) {
      console.error('[alsa-shim] could not build the stub; audio rendering unavailable:', e.message);
      process.exit(3);
    }
  }
  const has = (process.env.LD_LIBRARY_PATH || '').split(':').includes(shimDir);
  if (!has) {
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, LD_LIBRARY_PATH: shimDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') },
    });
    process.exit(r.status ?? 1);
  }
}

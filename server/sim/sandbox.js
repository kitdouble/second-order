// Runs one simulated participant (sim/worker.js) in a sandboxed child process. No database or app
// imports here: the production simulation service (sim/service.js) runs without access to them.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER = resolve(root, 'server/sim/worker.js');
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 50 * 1024 * 1024;
const HEAP_MB = 256;

export function runLocally(payload) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      '--permission',
      `--allow-fs-read=${resolve(root, 'node_modules')}/`,
      `--allow-fs-read=${WORKER}`,
      `--max-old-space-size=${HEAP_MB}`,
      '--disable-warning=ExperimentalWarning',
      WORKER,
    ], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    let killedFor = null;
    const kill = (reason) => { killedFor = reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => kill(`It was stopped after ${TIMEOUT_MS / 1000} seconds. Does the timeline end?`), TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX_OUTPUT) kill(`Its data passed the ${MAX_OUTPUT / 1024 / 1024} MB limit for one simulated participant.`);
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killedFor) return resolvePromise({ error: `Simulation stopped. ${killedFor}`, logs: [] });
      try {
        resolvePromise(JSON.parse(out));
      } catch {
        const why = /heap out of memory|Allocation failed/i.test(err)
          ? `It ran out of memory (${HEAP_MB} MB for one simulated participant).`
          : `${err.trim().split('\n').slice(-3).join(' ') || 'No error output'} (exit ${code ?? signal}, ${out.length} bytes of output).`;
        resolvePromise({ error: `Simulation crashed. ${why}`, logs: [] });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}


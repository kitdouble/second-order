// Runs one simulated participant (sim/worker.js) in a sandboxed child process. No database or app
// imports here: the production simulation service (sim/service.js) runs without access to them.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER = resolve(root, 'server/sim/worker.js');
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 50 * 1024 * 1024;

export function runLocally(payload) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      '--permission',
      `--allow-fs-read=${resolve(root, 'node_modules')}/`,
      `--allow-fs-read=${WORKER}`,
      '--max-old-space-size=256',
      '--disable-warning=ExperimentalWarning',
      WORKER,
    ], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX_OUTPUT) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return resolvePromise({ error: `Stopped after ${TIMEOUT_MS / 1000} seconds (or too much output). Does the timeline end?`, logs: [] });
      try {
        resolvePromise(JSON.parse(out));
      } catch {
        resolvePromise({ error: `Simulation crashed (exit ${code}). ${err.trim().split('\n').slice(-3).join(' ')}`, logs: [] });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}


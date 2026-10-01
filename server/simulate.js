// Runs simulated participants through a saved version and summarises the data for the assistant.
import { request } from 'node:http';
import { db } from './db.js';
import { runLocally } from './sim/sandbox.js';
import { compileSimulation } from './compile.js';
import { findStudy, StudyError } from './studies.js';
import { fileUrl } from './stimuli.js';

/* ---------- Running one participant ---------- */

// In production the workers run in a separate, network-less service (sim/service.js) on a unix socket.
function runViaService(payload) {
  return new Promise((resolvePromise, reject) => {
    const req = request({ socketPath: process.env.SIM_SOCKET, path: '/run', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolvePromise(JSON.parse(body)); } catch { reject(new Error('Bad response from simulation service')); }
      });
    });
    req.on('error', () => reject(new StudyError('The simulation service is not running.')));
    req.end(JSON.stringify(payload));
  });
}

const runOne = (payload) => (process.env.SIM_SOCKET ? runViaService(payload) : runLocally(payload));

// One simulation at a time: the server is small.
let queue = Promise.resolve();
const exclusive = (fn) => {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
};

/* ---------- Summarising ---------- */

const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const csvCell = (v) => { const s = cell(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function summarise(runs) {
  const rows = runs.flatMap((r) => r.rows ?? []);
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const skip = new Set(['time_elapsed', 'rt', 'trial_index', 'stimulus', 'plugin_version', 'response']);
  const values = {};
  for (const c of columns) {
    if (skip.has(c)) continue;
    const counts = new Map();
    for (const row of rows) if (c in row) counts.set(cell(row[c]), (counts.get(cell(row[c])) ?? 0) + 1);
    if (counts.size > 0 && counts.size <= 12) values[c] = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  }
  return { columns, values };
}

export async function simulate(user, studyId, { version, participants = 3, recruitment = 'prolific', simulation_options = {} } = {}) {
  const study = findStudy(user, studyId);
  const v = version == null
    ? db.prepare('SELECT * FROM study_versions WHERE study_id = ? ORDER BY number DESC LIMIT 1').get(study.id)
    : db.prepare('SELECT * FROM study_versions WHERE study_id = ? AND number = ?').get(study.id, version);
  if (!v) throw new StudyError(version == null ? 'This study has no versions yet.' : `Version ${version} does not exist.`);

  const manifest = Object.fromEntries(Object.entries(JSON.parse(v.stimuli)).map(([name, sha]) => [name, fileUrl(name, sha)]));
  const bundle = await compileSimulation(v.code, manifest);

  return exclusive(async () => {
    const started = Date.now();
    const runs = [];
    for (let i = 0; i < participants; i++) {
      const t = Date.now();
      const result = await runOne({ bundle, recruitment, version: v.number, simulationOptions: simulation_options });
      runs.push({ ...result, ms: Date.now() - t });
    }

    const { columns, values } = summarise(runs);
    const first = runs.find((r) => r.rows?.length)?.rows ?? [];
    const firstColumns = [...new Set(first.flatMap(Object.keys))];
    const sample = [firstColumns.join(','), ...first.slice(0, 150).map((r) => firstColumns.map((c) => csvCell(r[c])).join(','))].join('\n');

    return {
      version: v.number,
      recruitment,
      participants: runs.map((r, i) => ({
        participant: i + 1,
        ok: !r.error,
        rows: r.rows?.length ?? 0,
        stopped: r.rows?.find((row) => row.stopped)?.stopped ?? null,
        error: r.error ?? null,
        console: r.logs?.length ? r.logs.slice(0, 10) : undefined,
        seconds: Math.round(r.ms / 100) / 10,
      })),
      columns,
      value_counts: values,
      first_participant_csv: sample + (first.length > 150 ? `\n… ${first.length - 150} more rows` : ''),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      ...(runs.some((r) => r.standIns?.length) && {
        stand_ins: `No simulation support in: ${[...new Set(runs.flatMap((r) => r.standIns ?? []))].join(', ')}. Those trials were finished with placeholder data (random rt; survey-html-form fields filled from the form). Check them in preview.`,
      }),
      note: 'Data-only simulation in a simulated browser: responses and RTs are random unless simulation_options say otherwise, and nothing is rendered or saved.',
    };
  });
}

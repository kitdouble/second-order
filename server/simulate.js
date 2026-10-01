// Runs simulated participants through the live experiment and summarises the data for the assistant.
import { request } from 'node:http';
import { db } from './db.js';
import { runLocally } from './sim/sandbox.js';
import { compileSimulation } from './compile.js';
import { findStudy, StudyError } from './studies.js';
import { fileUrl } from './stimuli.js';
import { documentSnapshot } from './documents.js';
import { ensureCurrent } from './live.js';

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

// Columns from jsPsych and the standard blocks that rarely matter when checking a design.
const TECHNICAL = new Set([
  'width', 'height', 'browser', 'browser_version', 'mobile', 'os', 'fullscreen', 'device_type', 'device_allowed',
  'consent_form', 'debrief_form', 'plugin_version', 'success', 'timeout', 'failed_files', 'load_time_ms',
  'rt_key_duration', 'internal_node_id', 'trial_type', 'attempt',
]);
const NEVER = new Set(['time_elapsed', 'rt', 'trial_index', 'stimulus', 'response']); // stimulus_name is kept

// Value counts per column. A column that has one value per participant (a condition, a counterbalancing
// group) is counted in participants, which is what matters for balance; anything else in rows.
export function summarise(runs) {
  const people = runs.map((r) => r.rows ?? []).filter((rows) => rows.length);
  const rows = people.flat();
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const design = {};
  const technical = {};
  for (const c of columns) {
    if (NEVER.has(c)) continue;
    const perPerson = people.map((p) => new Set(p.filter((row) => c in row).map((row) => cell(row[c]))));
    const constant = perPerson.every((values) => values.size === 1);
    const counts = new Map();
    if (constant) for (const values of perPerson) { const [v] = values; counts.set(v, (counts.get(v) ?? 0) + 1); }
    else for (const row of rows) if (c in row) counts.set(cell(row[c]), (counts.get(cell(row[c])) ?? 0) + 1);
    if (counts.size === 0 || counts.size > 12) continue;
    const entry = { unit: constant ? 'participants' : 'rows', counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])) };
    (TECHNICAL.has(c) ? technical : design)[c] = entry;
  }
  return { columns, design, technical };
}

export async function simulate(user, studyId, { participants = 3, recruitment = 'prolific', simulation_options = {} } = {}) {
  const study = findStudy(user, studyId);
  const v = await ensureCurrent(study.id); // the live experiment, with the study's current stimuli
  if (!v) throw new StudyError('This study has no experiment yet. Write it with update_experiment.');

  const manifest = Object.fromEntries(Object.entries(JSON.parse(v.stimuli)).map(([name, sha]) => [name, fileUrl(name, sha)]));
  const bundle = await compileSimulation(v.code, manifest, v.documents ? JSON.parse(v.documents) : documentSnapshot(v.created_at));

  return exclusive(async () => {
    const started = Date.now();
    const runs = [];
    for (let i = 0; i < participants; i++) {
      const t = Date.now();
      const result = await runOne({ bundle, recruitment, version: v.number, participant: i, simulationOptions: simulation_options });
      runs.push({ ...result, ms: Date.now() - t });
    }

    const { columns, design, technical } = summarise(runs);
    const first = runs.find((r) => r.rows?.length)?.rows ?? [];
    const firstColumns = [...new Set(first.flatMap(Object.keys))];
    const sample = [firstColumns.join(','), ...first.slice(0, 150).map((r) => firstColumns.map((c) => csvCell(r[c])).join(','))].join('\n');

    return {
      revision: v.number,
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
      value_counts: design,
      technical_value_counts: technical,
      first_participant_csv: sample + (first.length > 150 ? `\n… ${first.length - 150} more rows` : ''),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      ...(runs.some((r) => r.standIns?.length) && {
        stand_ins: `No simulation support in: ${[...new Set(runs.flatMap((r) => r.standIns ?? []))].join(', ')}. Those trials were finished with placeholder data (random rt; survey-html-form fields filled from the form). Check them in preview.`,
      }),
      note: 'Data-only simulation in a simulated browser: responses and RTs are random unless simulation_options say otherwise, and nothing is rendered or saved.',
    };
  });
}

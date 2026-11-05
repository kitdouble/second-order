// Study export and import (export_study, import_study).
//
// An export is one zip that is both a folder worth publishing (OSF, GitHub, a journal's supplement) and a
// file Second Order can import again:
//
//   <study id>/
//     README.md, second-order.json (the manifest import reads), CITATION.cff and LICENSE when asked for
//     experiment/experiment.js + package.json     the live code and the packages it was built with
//     stimuli/…                                   the live files under their names
//     standalone/index.html                       the experiment running in a browser with no server
//     versions/history.json, versions/v1-…/       revision notes, and saved versions with their code
//     documents/                                  the consent and debrief texts the experiment uses
//     data/participants.csv, trials.csv           for people; runs.jsonl, trials.jsonl for import
//
// Two modes. "publish" (default) is for sharing: participant IDs become P001, P002… everywhere (trial data
// included), URL parameters, user agents, completion URLs and test data are left out. "archive" keeps
// everything (owner only) for moving a study or keeping a full backup. Secrets (link tokens, run keys,
// resume tokens, ESM codes and survey keys) are never exported.
//
// Import always makes a new study owned by the importer: code is recompiled, stimuli stored, saved
// versions and revision notes restored, and data attached to closed "Imported" links.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Router } from 'express';
import { strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';
import { db, hash, newId, newToken, now } from './db.js';
import { config } from './config.js';
import { compileStandalone, RUNTIME_VERSION } from './compile.js';
import { checkName, extensionOf, FILES_DIR, MAX_FILE_BYTES } from './stimuli.js';
import { createStudy, findStudy, iso, StudyError } from './studies.js';
import { currentRevision, updateExperiment } from './live.js';
import { assess, rulesFor } from './quality.js';
import { browserOf } from './monitor.js';
import { documentSnapshot, EXAMPLE_DOCUMENT, studyDocuments } from './documents.js';

export const FORMAT = 'second-order-study';
export const FORMAT_VERSION = 1;
const LINK_MINUTES = 60;
const MAX_ZIP_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS import_links (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT,                       -- overrides the export's title
    expires_at  INTEGER NOT NULL
  );
`);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'version';
const csvCell = (v) => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns, records) => [columns.join(','), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/');
// Stimuli that are already compressed are stored, everything else deflated.
const COMPRESSED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'webm', 'mov', 'm4v']);
const storedFile = (sha) => join(FILES_DIR, sha);

/* ---------- Export ---------- */

export function createExportLink(user, studyId, { mode = 'publish', include_data = true, include_test, authors, license } = {}) {
  const study = findStudy(user, studyId, mode === 'archive' ? 'own' : 'view');
  if (!currentRevision(study.id)) throw new StudyError(`"${study.title}" has no experiment yet, so there is nothing to export.`);
  const options = { kind: 'study', mode, include_data, include_test: include_test ?? mode === 'archive', authors: authors ?? [], license: license ?? null };
  const token = newToken();
  db.prepare('INSERT INTO download_links (token_hash, study_id, user_id, options, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(hash(token), study.id, user.id, JSON.stringify(options), now() + LINK_MINUTES * 60 * 1000);
  return {
    url: `${config.origin}/api/downloads/${token}`,
    expires_in_minutes: LINK_MINUTES,
    mode,
    note: (mode === 'archive'
      ? 'Archive export: includes raw participant IDs, URL parameters and browser details, which are personal data. Keep it private; ' +
        'it is for backups and moving the study, not for publishing. '
      : 'Publish export: participant IDs are replaced with P001, P002… (also inside trial data), and URL parameters, browser strings, ' +
        'completion URLs and test data are left out. Free-text answers are kept as given, so the researcher should check them before ' +
        'sharing. ') +
      'Give the link to the researcher to open in their browser: the zip downloads directly and never passes through the chat. ' +
      'Anyone with the link can download it until it expires. It can be imported again with import_study.',
  };
}

// The documents an experiment uses: the ones it names, and the default when consent()/debrief() name none.
function usedDocuments(code, snapshot) {
  const named = [...code.matchAll(/document\s*:\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)].map((m) => m[1]);
  const keys = Object.keys(snapshot).filter((k) => !k.startsWith('_'));
  const fallback = '_default' in snapshot ? snapshot._default : (keys.find((k) => k !== EXAMPLE_DOCUMENT) ?? EXAMPLE_DOCUMENT);
  const usesBlocks = /\b(consent|debrief)\s*\(/.test(code);
  const used = [...new Set([...(usesBlocks && fallback ? [fallback] : []), ...named])].filter((k) => snapshot[k]);
  return { used, fallback: fallback ?? null };
}

// Everything in the export except the stimulus bytes, which are streamed from storage.
async function planExport(user, study, options) {
  const archive = options.mode === 'archive';
  const revision = currentRevision(study.id);
  const texts = [];   // [path, content]
  const files = [];   // [path, sha256 of the stored file]
  const warnings = [];
  const addText = (path, content) => texts.push([path, content]);

  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(study.owner_id)?.name ?? null;
  const live = Object.fromEntries(db.prepare('SELECT name, sha256 FROM stimuli WHERE study_id = ? ORDER BY name').all(study.id).map((r) => [r.name, r.sha256]));
  const revisions = db.prepare(
    'SELECT v.number, v.notes, v.created_at, u.name AS author FROM study_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.study_id = ? ORDER BY v.number'
  ).all(study.id);
  const saved = db.prepare(
    'SELECT s.*, u.name AS author FROM saved_versions s LEFT JOIN users u ON u.id = s.created_by WHERE s.study_id = ? ORDER BY s.number'
  ).all(study.id);

  // Stimuli: live files under their names; files only a saved version uses under versions/files/.
  const liveShas = new Set(Object.values(live));
  for (const [name, sha] of Object.entries(live)) files.push([`stimuli/${name}`, sha]);
  const extra = new Map();
  for (const v of saved) {
    for (const [name, sha] of Object.entries(JSON.parse(v.stimuli))) {
      if (!liveShas.has(sha) && !extra.has(sha)) extra.set(sha, `versions/files/${sha}.${extensionOf(name)}`);
    }
  }
  for (const [sha, path] of extra) files.push([path, sha]);
  const missing = files.filter(([, sha]) => !existsSync(storedFile(sha)));
  if (missing.length) throw new StudyError(`${missing.length} stimulus file(s) are missing from storage, so the study can't be exported exactly.`, { platform: true });

  // Code.
  const packages = JSON.parse(revision.packages);
  addText('experiment/experiment.js', revision.code);
  const deps = Object.fromEntries(Object.entries(packages).filter(([name]) => name !== 'second-order-runtime'));
  addText('experiment/package.json', JSON.stringify({
    name: study.id, private: true, type: 'module',
    description: `${study.title}: the experiment as run on Second Order (revision ${revision.number}). It imports blocks from "second-order", ` +
      'Second Order\'s block library, so it builds there; standalone/ has a ready-to-run build.',
    dependencies: deps,
  }, null, 2) + '\n');

  // Saved versions and revision notes.
  const versionPaths = {};
  for (const v of saved) {
    const dir = `versions/v${v.number}-${slug(v.name)}`;
    versionPaths[v.number] = dir;
    addText(`${dir}/experiment.js`, v.code);
    addText(`${dir}/stimuli.json`, JSON.stringify(JSON.parse(v.stimuli), null, 2) + '\n');
  }
  addText('versions/history.json', JSON.stringify({
    live_revision: revision.number,
    revisions: revisions.map((r) => ({ revision: r.number, notes: r.notes, by: r.author, at: iso(r.created_at) })),
    saved_versions: saved.map((v) => ({
      version: v.number, name: v.name, notes: v.notes, from_revision: v.revision, by: v.author, at: iso(v.created_at), path: versionPaths[v.number],
    })),
  }, null, 2) + '\n');

  // Consent and debrief texts, as fixed into the live revision.
  const snapshot = revision.documents ? JSON.parse(revision.documents) : studyDocuments(study.id);
  const { used, fallback } = usedDocuments(revision.code, snapshot);
  const docs = { _default: fallback, ...Object.fromEntries(used.map((k) => [k, snapshot[k]])) };
  for (const key of used) {
    for (const [kind, byRecruitment] of Object.entries(snapshot[key])) {
      for (const [recruitment, d] of Object.entries(byRecruitment)) {
        addText(`documents/${key}/${kind}-${recruitment}.html`,
          `<!-- ${d.title.replace(/--/g, '-')} | recorded in the data as: ${d.form_label.replace(/--/g, '-')} -->\n${d.html}\n`);
      }
    }
  }
  if (used.length) addText('documents/documents.json', JSON.stringify(docs, null, 2) + '\n');

  // Standalone build: stimuli from ../stimuli/, data downloaded at the end.
  const links = db.prepare("SELECT recruitment, COUNT(*) AS n FROM links WHERE study_id = ? AND kind = 'live' GROUP BY recruitment ORDER BY n DESC").all(study.id);
  const recruitment = ['prolific', 'sona', 'lab'].includes(links[0]?.recruitment) ? links[0].recruitment : 'prolific';
  let standalone = false;
  try {
    const manifest = Object.fromEntries(Object.keys(live).map((name) => [name, `../stimuli/${encodePath(name)}`]));
    const built = await compileStandalone(revision.code, manifest, docs);
    const configJson = JSON.stringify({ study: study.id, version: revision.number, recruitment }).replace(/</g, '\\u003c');
    addText('standalone/experiment.js', built.js);
    addText('standalone/experiment.css', built.css);
    addText('standalone/index.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${study.title.replace(/[<&]/g, '')}</title>
  <link rel="stylesheet" href="experiment.css">
  <script type="application/json" id="so-config">${configJson}</script>
  <script defer src="experiment.js"></script>
</head>
<body style="margin:0;background:#fff;color:#000">
  <div id="jspsych-target"></div>
</body>
</html>
`);
    standalone = true;
  } catch (err) {
    warnings.push(`The standalone build failed, so standalone/ is missing: ${err.message}`);
  }

  // Data.
  let dataInfo = { included: false };
  let columns = [];
  if (options.include_data) {
    const data = exportRuns(study, options);
    dataInfo = data.info;
    columns = data.columns;
    for (const [path, content] of data.texts) addText(path, content);
  }

  const esm = db.prepare('SELECT app_title, schedule, survey_url FROM esm_studies WHERE study_id = ?').get(study.id);
  let rules = study.exclusion_rules ? JSON.parse(study.exclusion_rules) : null;
  if (rules?.exclude_participants?.length && !archive) {
    rules = { ...rules, exclude_participants: rules.exclude_participants.map((id) => dataInfo.pseudonyms?.get(id)).filter(Boolean) };
  }

  if (options.authors?.length) addText('CITATION.cff', citation(study, options));
  if (options.license) {
    addText('LICENSE', `${study.title}\n\nLicensed under ${options.license}: https://spdx.org/licenses/${encodeURIComponent(options.license)}.html\n` +
      'This covers the materials and data in this folder. The jsPsych packages in standalone/experiment.js are MIT licensed.\n');
  }

  const manifest = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    exported_at: iso(now()),
    exported_from: config.origin,
    mode: options.mode,
    study: {
      id: study.id, title: study.title, description: study.description, owner, created: iso(study.created_at),
      ...(study.based_on && { follow_up_of: { id: study.based_on, copied_from: study.based_on_from } }),
    },
    experiment: { path: 'experiment/experiment.js', revision: revision.number, packages, runtime: RUNTIME_VERSION, standalone },
    stimuli: live,
    documents: { default: fallback, used },
    exclusion_rules: rules,
    esm: esm ? { app_title: esm.app_title, schedule: JSON.parse(esm.schedule), ...(esm.survey_url && { survey_url: esm.survey_url }) } : null,
    data: (({ pseudonyms: _p, ...rest }) => rest)(dataInfo),
    warnings,
  };

  addText('README.md', readme(study, manifest, { revisions, saved, versionPaths, columns, recruitment, extra: extra.size }));
  const fileHashes = {};
  for (const [path, content] of texts) fileHashes[path] = sha256(content);
  for (const [path, sha] of files) fileHashes[path] = sha;
  manifest.files = fileHashes;
  return { manifest, texts, files };
}

// Runs, trials, assignments and events: CSVs for people, JSON lines for import.
function exportRuns(study, options) {
  const archive = options.mode === 'archive';
  const includeTest = archive ? options.include_test !== false : false;
  const runs = db.prepare(
    `SELECT r.*, v.number AS revision, l.kind AS link_kind, l.recruitment, l.label AS link_label, l.completion_url,
            l.created_at AS link_created, l.closed_at AS link_closed
     FROM runs r JOIN study_versions v ON v.id = r.version_id JOIN links l ON l.token = r.link_token
     WHERE r.study_id = ?${includeTest ? '' : ' AND r.is_test = 0'} ORDER BY r.started_at, r.id`
  ).all(study.id);

  // Publish: P001, P002… in order of first session.
  const pseudonyms = new Map();
  if (!archive) {
    const width = Math.max(3, String(runs.length).length);
    for (const run of runs) {
      if (run.participant_id && !pseudonyms.has(run.participant_id)) pseudonyms.set(run.participant_id, `P${String(pseudonyms.size + 1).padStart(width, '0')}`);
    }
  }
  const pid = (id) => (archive ? id : id == null ? null : pseudonyms.get(id) ?? null);
  const scrub = (data) => {
    if (archive || !pseudonyms.size) return data;
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = typeof v === 'string' && pseudonyms.has(v) ? pseudonyms.get(v) : v;
    return out;
  };

  const rules = rulesFor(study);
  const trialsOf = db.prepare('SELECT trial_index, data, received_at FROM trials WHERE run_id = ? ORDER BY trial_index');
  const assignmentsOf = db.prepare('SELECT name, value FROM assignments WHERE run_id = ? ORDER BY name');
  const eventsOf = db.prepare('SELECT kind, message, trial_index, trial_name, detail, at FROM run_events WHERE run_id = ? ORDER BY id');

  const linkKeys = new Map();
  const runLines = [];
  const trialLines = [];
  const participants = [];
  const trialRecords = [];
  const conditionNames = new Set();
  let trialCount = 0;
  for (const run of runs) {
    const rows = trialsOf.all(run.id);
    const parsed = rows.map((t) => JSON.parse(t.data));
    const quality = assess(run, parsed, rules);
    const assignments = Object.fromEntries(assignmentsOf.all(run.id).map((a) => [a.name, a.value]));
    Object.keys(assignments).forEach((n) => conditionNames.add(n));
    if (!linkKeys.has(run.link_token)) linkKeys.set(run.link_token, linkKeys.size + 1);
    const params = JSON.parse(run.params);

    runLines.push(JSON.stringify({
      run_id: run.id,
      link: {
        key: linkKeys.get(run.link_token), kind: run.link_kind, recruitment: run.recruitment, label: run.link_label,
        created_at: run.link_created, closed_at: run.link_closed, ...(archive && { completion_url: run.completion_url }),
      },
      revision: run.revision,
      is_test: run.is_test,
      participant_id: pid(run.participant_id),
      params: archive ? params : {},
      user_agent: archive ? run.user_agent : null,
      device: run.user_agent ? browserOf(run.user_agent) : null,
      started_at: run.started_at, finished_at: run.finished_at, last_seen_at: run.last_seen_at, stopped: run.stopped,
      last_trial_index: run.last_trial_index, last_trial_name: run.last_trial_name, seed: run.seed,
      checkpoint_block: run.checkpoint_block, checkpoint_trial: run.checkpoint_trial, attempts: run.attempts, bytes: run.bytes,
      assignments,
      events: eventsOf.all(run.id).map((e) => (archive ? e : { ...e, detail: null })),
    }));

    participants.push({
      participant_id: pid(run.participant_id), run_id: run.id, revision: run.revision, test: run.is_test === 1,
      recruitment: run.recruitment, link_label: run.link_label, status: quality.status,
      started: iso(run.started_at), finished: iso(run.finished_at), minutes: quality.minutes, attempts: run.attempts,
      device: run.user_agent ? browserOf(run.user_agent) : null, trials: rows.length,
      ...Object.fromEntries(Object.entries(assignments).map(([n, v]) => [`condition_${n}`, v])),
      excluded: quality.excluded, exclusion_reasons: quality.reasons.join('; '),
      ...(archive && { user_agent: run.user_agent, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param_${k}`, v])) }),
    });

    rows.forEach((t, i) => {
      const data = scrub(parsed[i]);
      trialLines.push(JSON.stringify({ run_id: run.id, trial_index: t.trial_index, received_at: t.received_at, data }));
      trialRecords.push({
        run_id: run.id, participant_id: pid(run.participant_id), revision: run.revision, test: run.is_test === 1,
        run_status: quality.status, excluded: quality.excluded, ...data,
      });
    });
    trialCount += rows.length;
  }

  const firstP = ['participant_id', 'run_id', 'revision', 'test', 'recruitment', 'link_label', 'status', 'started', 'finished', 'minutes', 'attempts', 'device', 'trials'];
  const pCols = [...new Set(participants.flatMap(Object.keys))];
  const participantColumns = [...firstP, ...[...conditionNames].sort().map((n) => `condition_${n}`), 'excluded', 'exclusion_reasons',
    ...pCols.filter((c) => !firstP.includes(c) && !c.startsWith('condition_') && !['excluded', 'exclusion_reasons'].includes(c))];

  const firstT = ['run_id', 'participant_id', 'revision', 'test', 'run_status', 'excluded'];
  const tCols = [];
  const seen = new Set(firstT);
  for (const r of trialRecords) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); tCols.push(k); }
  const trialColumns = [...firstT, ...tCols];

  const texts = [
    ['data/participants.csv', toCsv(participantColumns, participants)],
    ['data/trials.csv', toCsv(trialColumns, trialRecords)],
    ['data/runs.jsonl', runLines.length ? runLines.join('\n') + '\n' : ''],
    ['data/trials.jsonl', trialLines.length ? trialLines.join('\n') + '\n' : ''],
  ];

  // ESM sessions counted by a hosted survey (not imported: they belong to the app enrolment).
  const esm = db.prepare(`SELECT * FROM esm_sessions WHERE study_id = ?${includeTest ? '' : ' AND is_test = 0'} ORDER BY completed_at`).all(study.id);
  if (esm.length) {
    const esmIds = new Map();
    const esmPid = (id) => {
      if (archive) return id;
      if (!esmIds.has(id)) esmIds.set(id, `E${String(esmIds.size + 1).padStart(3, '0')}`);
      return esmIds.get(id);
    };
    texts.push(['data/esm_sessions.csv', toCsv(
      ['participant_id', 'session_number', 'notification_time', 'completed', 'test', ...(archive ? ['response_id'] : [])],
      esm.map((s) => ({
        participant_id: esmPid(s.participant_id), session_number: s.session_number, notification_time: s.notification_time,
        completed: iso(s.completed_at), test: s.is_test === 1, response_id: s.response_id,
      })),
    )]);
  }

  return {
    texts,
    columns: trialColumns,
    info: {
      included: true,
      include_test: includeTest,
      pseudonymised: !archive,
      runs: runs.length,
      participants: archive ? new Set(runs.map((r) => r.participant_id).filter(Boolean)).size : pseudonyms.size,
      trials: trialCount,
      esm_sessions: esm.length,
      pseudonyms,
    },
  };
}

function citation(study, options) {
  const quote = (s) => JSON.stringify(String(s));
  const authors = options.authors.map((name) => {
    const parts = String(name).trim().split(/\s+/);
    return parts.length > 1
      ? `  - family-names: ${quote(parts.at(-1))}\n    given-names: ${quote(parts.slice(0, -1).join(' '))}`
      : `  - name: ${quote(parts[0])}`;
  });
  return [
    'cff-version: 1.2.0',
    'message: "If you use these materials or data, please cite them as below."',
    `title: ${quote(study.title)}`,
    'type: dataset',
    'authors:',
    ...authors,
    `date-released: ${new Date().toISOString().slice(0, 10)}`,
    ...(options.license ? [`license: ${quote(options.license)}`] : []),
    ...(study.description ? [`abstract: ${quote(study.description)}`] : []),
    '',
  ].join('\n');
}

function readme(study, manifest, { revisions, saved, versionPaths, columns, recruitment, extra }) {
  const d = manifest.data;
  const lines = [
    `# ${study.title}`,
    '',
    study.description ?? '',
    '',
    `Exported from [Second Order](${config.origin}) on ${manifest.exported_at.slice(0, 10)} (${manifest.mode} export of study \`${study.id}\`, ` +
      `live revision ${manifest.experiment.revision}).`,
    '',
    '## Contents',
    '',
    '| Path | What it is |',
    '| --- | --- |',
    '| `experiment/experiment.js` | The experiment as it runs now: a jsPsych module (`buildTimeline`) using Second Order\'s blocks |',
    '| `experiment/package.json` | The exact jsPsych package versions it was built with |',
    `| \`stimuli/\` | The ${Object.keys(manifest.stimuli).length} stimulus file(s), under the names the code uses |`,
    ...(manifest.experiment.standalone ? ['| `standalone/` | A ready-to-run build of the experiment that needs no server (below) |'] : []),
    `| \`versions/\` | Notes for all ${revisions.length} revision(s), and the code of ${saved.length} saved version(s)${extra ? ` (with ${extra} file(s) only they use, in \`versions/files/\`)` : ''} |`,
    ...(manifest.documents.used.length ? ['| `documents/` | The consent and debrief texts the experiment shows, as approved |'] : []),
    ...(d.included ? [
      '| `data/participants.csv` | One row per session: status, timing, conditions, exclusions |',
      '| `data/trials.csv` | One row per trial, with the session\'s details first |',
      '| `data/*.jsonl` | The same data in the form Second Order imports |',
    ] : []),
    ...(d.esm_sessions ? ['| `data/esm_sessions.csv` | Experience sampling sessions counted by the hosted survey |'] : []),
    '| `second-order.json` | Manifest: lets Second Order import this folder again, and checks every file\'s SHA-256 |',
    '',
  ];
  if (manifest.experiment.standalone) {
    lines.push(
      '## Running the experiment',
      '',
      'Serve this folder with any static web server and open `standalone/`, for example:',
      '',
      '```sh',
      'python3 -m http.server 8000',
      '# then open http://localhost:8000/standalone/',
      '```',
      '',
      '(Opening `standalone/index.html` straight from disk works for many experiments, but browsers block audio and some files that way.)',
      '',
      'Nothing is sent anywhere: at the end the data downloads as CSV and JSON. URL options:',
      '',
      `- \`?recruitment=prolific\`, \`sona\` or \`lab\`: which version of the consent and payment blocks to show (default \`${recruitment}\`).`,
      '- `?condition=…` (or the name given to `assignCondition`): fix a condition. Otherwise conditions are picked at random; the live study balanced them on the server.',
      '- `?participant=…`: an ID recorded as `participant_id` in the data.',
      ...(manifest.esm ? ['- `?session=3`: run that session of the experience sampling schedule.'] : []),
      '',
    );
  }
  lines.push(
    '## Building from source',
    '',
    '`experiment/experiment.js` imports blocks (consent, device checks, demographics, stimulus helpers) from `second-order`, Second Order\'s ' +
      'block library, so it builds inside Second Order. The standalone build already has them compiled in.',
    '',
  );
  if (d.included) {
    lines.push(
      '## Data',
      '',
      `${d.runs} session(s) from ${d.participants} participant(s), ${d.trials} trial rows${d.include_test ? ', including test (preview) sessions' : ''}.`,
      '',
      d.pseudonymised
        ? 'Participant IDs are replaced with P001, P002… in order of first session (in the trial data too). URL parameters, browser strings and ' +
          'completion URLs are left out; `device` is only the browser and operating system. Free-text answers are as participants gave them: check ' +
          'them for identifying details before sharing.'
        : '**This is an archive export with raw participant IDs, URL parameters and browser strings. These are personal data: do not publish it.**',
      '',
      '`excluded` and `exclusion_reasons` apply the study\'s exclusion rules (`exclusion_rules` in `second-order.json`); nothing is removed. ' +
        '`revision` is the code revision a session ran (see `versions/history.json`).',
      '',
      'Columns in `data/trials.csv`:',
      '',
      columns.map((c) => `\`${c}\``).join(', '),
      '',
    );
  }
  if (saved.length) {
    lines.push('## Saved versions', '', ...saved.map((v) => `- **v${v.number}: ${v.name}** (${iso(v.created_at).slice(0, 10)}, from revision ${v.revision}) \`${versionPaths[v.number]}/\`${v.notes ? `: ${v.notes}` : ''}`), '');
  }
  lines.push(
    '## Importing into Second Order',
    '',
    'Ask Claude or ChatGPT to "import a study" (the `import_study` tool) and drop this zip on the page it links. Import makes a new study with ' +
      'the code, stimuli, saved versions, revision notes and data.',
    '',
  );
  return lines.join('\n');
}

// Streams entries into a zip on res, waiting whenever the client is slower than we are.
function zipStream(res, root) {
  let failed = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failed = err;
      return res.destroy(err);
    }
    res.write(chunk);
    if (final) res.end();
  });
  const settle = async () => {
    if (res.writableNeedDrain) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    if (failed || res.destroyed) throw failed ?? new Error('Download cancelled');
  };
  return {
    async text(path, content) {
      const entry = new ZipDeflate(`${root}/${path}`, { level: 6 });
      zip.add(entry);
      entry.push(strToU8(content), true);
      await settle();
    },
    async file(path, source, compress) {
      const entry = new ZipDeflate(`${root}/${path}`, { level: compress ? 6 : 0 });
      zip.add(entry);
      for await (const chunk of createReadStream(source)) {
        entry.push(chunk);
        await settle();
      }
      entry.push(new Uint8Array(0), true);
      await settle();
    },
    end: () => zip.end(),
  };
}

/** GET /api/downloads/:token for a study export. */
export async function sendExport(user, studyId, options, res) {
  const study = findStudy(user, studyId, options.mode === 'archive' ? 'own' : 'view');
  const { manifest, texts, files } = await planExport(user, study, options);
  const stamp = new Date().toISOString().slice(0, 10);
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.attachment(`${study.id}-${options.mode}-${stamp}.zip`).type('application/zip');
  const zip = zipStream(res, study.id);
  try {
    await zip.text('second-order.json', JSON.stringify(manifest, null, 2) + '\n');
    for (const [path, content] of texts) await zip.text(path, content);
    for (const [path, sha] of files) await zip.file(path, storedFile(sha), !COMPRESSED.has(extensionOf(path)));
    zip.end();
  } catch (err) {
    if (!res.destroyed) res.destroy(err);
  }
}

/* ---------- Import ---------- */

export function createImportLink(user, { title } = {}) {
  const token = newToken();
  db.prepare('INSERT INTO import_links (token_hash, user_id, title, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), user.id, title?.trim() || null, now() + LINK_MINUTES * 60 * 1000);
  return {
    url: `${config.origin}/import/${token}`,
    expires_in_minutes: LINK_MINUTES,
    note: 'Give this link to the researcher: they drop the study export (.zip) on the page, which shows the new study when it is done. ' +
      'Ask them to tell you when it has finished, then list_studies or get_study. Anyone with the link can import a study into this account until it expires.',
  };
}

function openImportLink(token) {
  const row = db.prepare(
    `SELECT l.*, u.id AS uid, u.email, u.name, u.role, u.lab_member FROM import_links l JOIN users u ON u.id = l.user_id
     WHERE l.token_hash = ? AND l.expires_at > ?`
  ).get(hash(String(token)), now());
  if (!row) return null;
  return {
    tokenHash: row.token_hash, title: row.title, expiresAt: row.expires_at,
    user: { id: row.uid, email: row.email, name: row.name, role: row.role, lab_member: Boolean(row.lab_member) },
  };
}

// A zip entry's name as a safe relative path, or null for entries to skip.
function entryPath(name) {
  const path = name.replace(/\\/g, '/');
  if (path.endsWith('/')) return null;
  const parts = path.split('/');
  if (parts.some((p) => p === '..' || p === '') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new StudyError(`The zip contains an unsafe path: ${name}`);
  }
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store' || parts.at(-1).startsWith('._')) return null;
  return parts.join('/');
}

// Unzips a stream into dir, streaming (the zip is never held in memory). Returns the relative paths.
async function extract(stream, dir) {
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  const paths = [];
  const open = new Set();
  let error = null;
  let received = 0;
  let written = 0;
  unzip.onfile = (file) => {
    if (error) return;
    try {
      const path = entryPath(file.name);
      if (!path) return;
      if (paths.length >= MAX_ENTRIES) throw new StudyError(`The zip has more than ${MAX_ENTRIES} files.`);
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      const fd = openSync(target, 'w');
      open.add(fd);
      paths.push(path);
      file.ondata = (err, chunk, final) => {
        if (error) return;
        if (err) {
          error = new StudyError(`Couldn't unzip ${file.name}: ${err.message}`);
          return;
        }
        written += chunk.length;
        if (written > MAX_UNZIPPED_BYTES) {
          error = new StudyError('The unzipped export is too large to import.', { platform: true });
          return;
        }
        writeSync(fd, chunk);
        if (final) {
          closeSync(fd);
          open.delete(fd);
        }
      };
      file.start();
    } catch (err) {
      error = err instanceof StudyError ? err : new StudyError(`Couldn't unzip ${file.name}: ${err.message}`);
    }
  };
  try {
    for await (const chunk of stream) {
      received += chunk.length;
      if (received > MAX_ZIP_BYTES) error ??= new StudyError(`The zip is larger than ${MAX_ZIP_BYTES / 1024 ** 3} GB.`, { platform: true });
      if (error) break;
      unzip.push(chunk);
    }
    if (!error) unzip.push(new Uint8Array(0), true);
  } catch (err) {
    error ??= new StudyError(`That doesn't look like a zip file (${err.message}).`);
  } finally {
    for (const fd of open) closeSync(fd);
  }
  if (error) throw error;
  if (!paths.length) throw new StudyError('That doesn\'t look like a zip file, or it is empty.');
  if (open.size) throw new StudyError('The zip ended early: it may not have uploaded completely.');
  return paths;
}

async function fileSha(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

// Copies an extracted file into content-addressed storage and returns its sha256.
async function storeFile(path, knownSha) {
  const { size } = statSync(path);
  const name = path.split('/').pop();
  if (size === 0) throw new StudyError(`${name} is empty.`);
  if (size > MAX_FILE_BYTES) throw new StudyError(`${name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`, { platform: true });
  const sha = knownSha ?? (await fileSha(path));
  const target = storedFile(sha);
  if (!existsSync(target)) {
    const tmp = join(FILES_DIR, `.upload-${newToken()}`);
    copyFileSync(path, tmp);
    renameSync(tmp, target);
  }
  return sha;
}

async function* jsonLines(path) {
  if (!existsSync(path)) return;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    n++;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      throw new StudyError(`${path.split('/').slice(-2).join('/')} line ${n} isn't valid JSON.`);
    }
  }
}

// Removes a half-imported study: data rows first (runs don't cascade from studies), then the study.
function removeStudy(studyId) {
  const runIds = 'SELECT id FROM runs WHERE study_id = ?';
  db.prepare(`DELETE FROM trials WHERE run_id IN (${runIds})`).run(studyId);
  db.prepare(`DELETE FROM run_events WHERE run_id IN (${runIds})`).run(studyId);
  db.prepare(`DELETE FROM assignments WHERE run_id IN (${runIds})`).run(studyId);
  db.prepare('DELETE FROM runs WHERE study_id = ?').run(studyId);
  db.prepare('DELETE FROM studies WHERE id = ?').run(studyId);
}

const inBatch = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

/** Imports an extracted export from dir as a new study owned by user. */
export async function importFromDir(user, dir, paths, { title } = {}) {
  // The export's root folder: where second-order.json is (zips re-made from a repository add a folder).
  const manifestPath = paths.filter((p) => p === 'second-order.json' || p.endsWith('/second-order.json')).sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) throw new StudyError('This isn\'t a Second Order study export: there is no second-order.json in it.');
  const root = join(dir, dirname(manifestPath));
  const at = (path) => join(root, path);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(at('second-order.json'), 'utf8'));
  } catch {
    throw new StudyError('second-order.json isn\'t valid JSON.');
  }
  if (manifest.format !== FORMAT) throw new StudyError('second-order.json isn\'t a Second Order study manifest.');
  if (!(manifest.format_version <= FORMAT_VERSION)) {
    throw new StudyError(`This export was made by a newer Second Order (format ${manifest.format_version}); this one reads up to ${FORMAT_VERSION}.`, { platform: true });
  }

  // Check every listed file. Changed code or stimuli are imported as they are now (and reported);
  // changed or missing participant data is refused.
  const listed = manifest.files ?? {};
  const changed = [];
  const missingFiles = [];
  const shas = {};
  for (const [path, expected] of Object.entries(listed)) {
    if (!existsSync(at(path))) {
      missingFiles.push(path);
      continue;
    }
    shas[path] = await fileSha(at(path));
    if (shas[path] !== expected) changed.push(path);
  }
  // Without data/runs.jsonl the study is imported without data (the way to import an export whose data was edited).
  const withData = existsSync(at('data/runs.jsonl'));
  const vital = (p) => (withData && p.endsWith('.jsonl')) || p === manifest.experiment?.path || p.startsWith('stimuli/') || p.startsWith('versions/');
  if (missingFiles.filter(vital).length) throw new StudyError(`Files are missing from the export: ${missingFiles.filter(vital).slice(0, 10).join(', ')}`);
  const changedData = changed.filter((p) => p.endsWith('.jsonl'));
  if (changedData.length) {
    throw new StudyError(`The participant data in this export was changed after it was exported (${changedData.join(', ')}), so it isn't imported. ` +
      'Import the original export, or remove data/ from the zip to import the study without data.');
  }

  const code = readFileSync(at(manifest.experiment?.path ?? 'experiment/experiment.js'), 'utf8');

  // Stimuli: names checked, bytes stored once by content.
  const live = {};
  for (const name of Object.keys(manifest.stimuli ?? {})) {
    checkName(name);
    live[name] = await storeFile(at(`stimuli/${name}`), shas[`stimuli/${name}`]);
  }
  // Also any files the stimuli folder holds that the manifest doesn't list (added after exporting).
  const stimuliRoot = at('stimuli');
  if (existsSync(stimuliRoot)) {
    const walk = (rel) => {
      for (const entry of readdirSync(join(stimuliRoot, rel), { withFileTypes: true })) {
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(name);
        else if (!(name in live)) live[name] = null;
      }
    };
    walk('');
    for (const name of Object.keys(live).filter((n) => live[n] === null)) {
      checkName(name);
      live[name] = await storeFile(join(stimuliRoot, name));
      changed.push(`stimuli/${name}`);
    }
  }
  // Files only saved versions use.
  const history = existsSync(at('versions/history.json')) ? JSON.parse(readFileSync(at('versions/history.json'), 'utf8')) : { revisions: [], saved_versions: [] };
  const versionFiles = new Map();
  if (existsSync(at('versions/files'))) {
    for (const file of readdirSync(at('versions/files'))) versionFiles.set(file.replace(/\.[^.]+$/, ''), at(`versions/files/${file}`));
  }
  const liveShas = new Set(Object.values(live));
  const savedVersions = [];
  for (const v of history.saved_versions ?? []) {
    const files = JSON.parse(readFileSync(at(`${v.path}/stimuli.json`), 'utf8'));
    for (const sha of Object.values(files)) {
      if (liveShas.has(sha) || existsSync(storedFile(sha))) continue;
      if (!versionFiles.has(sha)) throw new StudyError(`Saved version ${v.version} needs a file that isn't in the export (${sha.slice(0, 12)}…).`);
      await storeFile(versionFiles.get(sha), sha);
    }
    savedVersions.push({ ...v, code: readFileSync(at(`${v.path}/experiment.js`), 'utf8'), stimuli: files });
  }

  // The study, its files and revision history, then the live revision compiled here.
  const source = manifest.study ?? {};
  const imported = `imported from ${manifest.exported_from ?? 'another Second Order'} (${source.id ?? 'unknown study'}), ${manifest.mode} export of ${String(manifest.exported_at ?? '').slice(0, 10)}`;
  const study = createStudy(user, {
    title: title ?? source.title ?? 'Imported study',
    description: source.description ?? null,
    basedOn: source.id ?? null,
    basedOnFrom: imported,
    exclusionRules: manifest.exclusion_rules ? JSON.stringify(manifest.exclusion_rules) : null,
  });
  const liveRevision = Number(manifest.experiment?.revision) || 1;
  const notesByRevision = new Map((history.revisions ?? []).map((r) => [r.revision, r]));
  const codeByRevision = new Map(savedVersions.map((v) => [v.from_revision, v.code]));
  let result;
  try {
    inBatch(() => {
      const insert = db.prepare('INSERT INTO stimuli (study_id, name, sha256, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [name, sha] of Object.entries(live)) insert.run(study.id, name, sha, statSync(storedFile(sha)).size, user.id, now());
      // Earlier revisions keep their numbers (data rows refer to them) and notes; their code is only known when a saved version came from them.
      const placeholder = db.prepare(
        `INSERT INTO study_versions (id, study_id, number, notes, code, packages, stimuli, bundle_js, bundle_css, bundle_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', '{}', '', '', '', ?, ?)`
      );
      for (let n = 1; n < liveRevision; n++) {
        const r = notesByRevision.get(n);
        const by = r?.by ? ` [by ${r.by}]` : '';
        placeholder.run(newId(), study.id, n, `${r?.notes ?? ''}${by}`.trim() || null, codeByRevision.get(n) ?? '', user.id, Date.parse(r?.at) || now());
      }
    });
    const liveNotes = notesByRevision.get(liveRevision)?.notes;
    result = await updateExperiment(user, study.id, { code, notes: `${liveNotes ? `${liveNotes} ` : ''}[${imported}]` });
  } catch (err) {
    removeStudy(study.id);
    throw err;
  }

  const counts = { runs: 0, trials: 0 };
  try {
    const revisionIds = new Map(db.prepare('SELECT id, number FROM study_versions WHERE study_id = ?').all(study.id).map((r) => [r.number, r.id]));
    const liveId = revisionIds.get(result.revision);
    inBatch(() => {
      const insert = db.prepare(
        'INSERT INTO saved_versions (id, study_id, number, name, notes, code, stimuli, revision, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const v of savedVersions) {
        insert.run(newId(), study.id, v.version, v.name, v.notes ?? null, v.code, JSON.stringify(v.stimuli), v.from_revision ?? 0, user.id, Date.parse(v.at) || now());
      }
    });

    // Runs, each on a closed "Imported" link standing for the link it came in on.
    const links = new Map();
    const runIds = new Map();
    const insertLink = db.prepare(
      `INSERT INTO links (token, study_id, version_id, kind, recruitment, completion_url, label, created_by, created_at, closed_at)
       VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)`
    );
    const insertRun = db.prepare(
      `INSERT INTO runs (id, link_token, study_id, version_id, is_test, key_hash, participant_id, params, user_agent, started_at, finished_at, bytes,
         stopped, last_seen_at, last_trial_index, last_trial_name, seed, checkpoint_block, checkpoint_trial, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAssignment = db.prepare('INSERT INTO assignments (run_id, name, value, at) VALUES (?, ?, ?, ?)');
    const insertEvent = db.prepare('INSERT INTO run_events (run_id, kind, message, trial_index, trial_name, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const taken = db.prepare('SELECT 1 FROM runs WHERE id = ?');
    const addRun = (r) => {
      const key = r.link?.key ?? 0;
      if (!links.has(key)) {
        const token = newToken();
        const recruitment = ['prolific', 'sona', 'lab', 'none'].includes(r.link?.recruitment) ? r.link.recruitment : 'none';
        const label = `Imported: ${r.link?.label ?? (r.link?.kind === 'preview' ? 'preview (test data)' : recruitment)}`;
        insertLink.run(token, study.id, liveId, recruitment, r.link?.completion_url ?? null, label, user.id, r.link?.created_at ?? now(), now());
        links.set(key, token);
      }
      const id = typeof r.run_id === 'string' && /^[0-9a-f-]{36}$/.test(r.run_id) && !taken.get(r.run_id) ? r.run_id : newId();
      runIds.set(r.run_id, id);
      insertRun.run(id, links.get(key), study.id, revisionIds.get(r.revision) ?? liveId, r.is_test ? 1 : 0, hash(newToken()),
        r.participant_id ?? null, JSON.stringify(r.params ?? {}), r.user_agent ?? null, r.started_at ?? now(), r.finished_at ?? null, r.bytes ?? 0,
        r.stopped ?? null, r.last_seen_at ?? null, r.last_trial_index ?? null, r.last_trial_name ?? null, r.seed ?? null,
        r.checkpoint_block ?? 0, r.checkpoint_trial ?? 0, r.attempts ?? 1);
      for (const [name, value] of Object.entries(r.assignments ?? {})) insertAssignment.run(id, name, String(value), r.started_at ?? now());
      for (const e of r.events ?? []) insertEvent.run(id, e.kind ?? 'other', e.message ?? '', e.trial_index ?? null, e.trial_name ?? null, e.detail ?? null, e.at ?? now());
      counts.runs++;
    };
    const insertTrial = db.prepare('INSERT INTO trials (run_id, trial_index, data, received_at) VALUES (?, ?, ?, ?)');
    const addTrial = (t) => {
      const id = runIds.get(t.run_id);
      if (!id) throw new StudyError(`data/trials.jsonl has a trial for a session that isn't in data/runs.jsonl (${t.run_id}).`);
      insertTrial.run(id, t.trial_index, JSON.stringify(t.data ?? {}), t.received_at ?? now());
      counts.trials++;
    };
    // In batches, so participants' requests aren't held up by one long transaction.
    const batched = async (path, add) => {
      let batch = [];
      for await (const row of jsonLines(path)) {
        batch.push(row);
        if (batch.length >= 1000) {
          const rows = batch;
          inBatch(() => rows.forEach(add));
          batch = [];
        }
      }
      if (batch.length) inBatch(() => batch.forEach(add));
    };
    if (withData) {
      await batched(at('data/runs.jsonl'), addRun);
      await batched(at('data/trials.jsonl'), addTrial);
    }
  } catch (err) {
    removeStudy(study.id);
    throw err;
  }

  // Consent and debrief texts come from this Second Order's library.
  const warnings = [...(manifest.warnings ?? [])];
  const library = documentSnapshot();
  const absent = (manifest.documents?.used ?? []).filter((k) => k !== manifest.documents?.default && !library[k]);
  if (absent.length) {
    warnings.push(`The experiment names consent/debrief document(s) this Second Order doesn't have: ${absent.join(', ')}. Their texts are in documents/ ` +
      'in the export; save them with save_document (after the researcher confirms the wording) or write the text inline.');
  }
  const here = studyDocuments(study.id);
  const hereDefault = '_default' in here ? here._default : Object.keys(here).find((k) => !k.startsWith('_') && k !== EXAMPLE_DOCUMENT) ?? EXAMPLE_DOCUMENT;
  if (manifest.documents?.used?.includes(manifest.documents.default) && manifest.documents.default !== hereDefault) {
    warnings.push(`consent()/debrief() without a document used "${manifest.documents.default}" where this was exported; here they use ` +
      `${hereDefault ? `"${hereDefault}"` : 'no default (they need a document or inline text)'}. Check the texts before collecting data.`);
  }
  if (manifest.data?.included && !withData) warnings.push('The export\'s data/runs.jsonl was not in the zip, so the study was imported without data.');
  if (manifest.esm) warnings.push('This was an experience sampling study: its schedule is in second-order.json (esm). Set it up again with set_esm_schedule.');
  if (manifest.data?.esm_sessions) warnings.push('Experience sampling sessions counted by a hosted survey are in data/esm_sessions.csv but are not imported.');

  return {
    study_id: study.id,
    title: title ?? source.title,
    imported_from: imported,
    revision: result.revision,
    preview_url: result.preview_url,
    dashboard_url: result.dashboard_url,
    stimuli: Object.keys(live).length,
    saved_versions: savedVersions.length,
    sessions_imported: counts.runs,
    trials_imported: counts.trials,
    ...(manifest.data?.pseudonymised && { participant_ids: 'pseudonymised (P001, P002…) in this export' }),
    ...(changed.length && { changed_since_export: changed }),
    ...(warnings.length && { warnings }),
    note: 'A new study owned by you. Imported sessions are on closed "Imported" participant links; new participants need a new link (create_participant_link).',
  };
}

export const imports = Router();

const expired = (res) => res.status(404).json({ error: 'This import link has expired. Ask Claude or ChatGPT for a new one.' });

imports.get('/:token', (req, res) => {
  const link = openImportLink(req.params.token);
  if (!link) return expired(res);
  res.json({ expiresAt: link.expiresAt, maxGb: MAX_ZIP_BYTES / 1024 ** 3 });
});

// PUT /api/imports/:token with the zip as the body. One import per link.
imports.put('/:token', async (req, res) => {
  const link = openImportLink(req.params.token);
  if (!link) return expired(res);
  db.prepare('DELETE FROM import_links WHERE token_hash = ?').run(link.tokenHash);
  const dir = mkdtempSync(join(tmpdir(), 'so-import-'));
  try {
    const paths = await extract(req, dir);
    res.json(await importFromDir(link.user, dir, paths, { title: link.title }));
  } catch (err) {
    // The link is used up only by a successful import.
    db.prepare('INSERT OR IGNORE INTO import_links (token_hash, user_id, title, expires_at) VALUES (?, ?, ?, ?)')
      .run(link.tokenHash, link.user.id, link.title, link.expiresAt);
    if (err instanceof StudyError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

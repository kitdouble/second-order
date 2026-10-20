// The participant-facing origin (run.2ndorder.live). It serves experiment pages and accepts their
// data, and nothing else: no sessions, no admin API, no access to the main site's cookies.
import express from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { db, hash, newId, newToken, now } from './db.js';
import { FILES_DIR, MIME, fileUrl } from './stimuli.js';
import { compileDashboard, RUNTIME_VERSION } from './compile.js';
import { currentRevision, ensureCurrent } from './live.js';
import { documentSnapshot } from './documents.js';
import { appRun, codeForRun, esmApp } from './esm.js';
import { StudyError } from './studies.js';

const MAX_TRIAL_BYTES = 5 * 1024 * 1024; // audio/video/sketchpad responses can be large
const MAX_RUN_BYTES = 100 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // jsPsych and plugins set inline styles
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'", // data can only go back to Second Order
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const fail = (res, status, error) => res.status(status).json({ error });

const RECRUITMENT_PARAMS = {
  prolific: { id: 'PROLIFIC_PID', keep: ['PROLIFIC_PID', 'STUDY_ID', 'SESSION_ID'] },
  sona: { id: 'id', keep: ['id'] },
  lab: { keep: [] },
  none: { keep: [] },
};

export const runApp = express.Router();

runApp.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

// Every link runs its study's live experiment (rebuilt first if the study's stimuli changed).
runApp.get('/s/:token', async (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE token = ?').get(req.params.token);
  if (!link) return res.status(404).type('html').send(page('<p>This study link is not valid.</p>'));
  if (link.closed_at) return res.status(410).type('html').send(page('<p>This study is closed. Thank you for your interest.</p>'));
  let revision;
  try {
    revision = await ensureCurrent(link.study_id);
  } catch (err) {
    console.error(`Rebuild failed for ${link.study_id}:`, err.message);
    return res.status(500).type('html').send(page('<p>This study can\'t be shown right now. Please try again later.</p>'));
  }
  if (!revision) return res.status(404).type('html').send(page('<p>This study is not ready yet.</p>'));

  const config = JSON.stringify({ token: link.token, mode: link.kind, recruitment: link.recruitment, version: revision.number }).replace(/</g, '\\u003c');
  const asset = `/v/${revision.id}.${revision.bundle_hash}`;
  res.type('html').send(page('', `
    <link rel="stylesheet" href="${asset}.css">
    <script type="application/json" id="so-config">${config}</script>
    <script defer src="${asset}.js"></script>`));
});

function page(body, head = '', title = 'Research study') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="color-scheme" content="light">
  <title>${title}</title>${head}
</head>
<body style="margin:0;background:#fff;color:#000">
  <div id="jspsych-target">${body ? `<div style="max-width:560px;margin:20vh auto 0;padding:0 16px;font:18px/1.5 system-ui,sans-serif;text-align:center">${body}</div>` : ''}</div>
</body>
</html>`;
}

// The researcher dashboard for the live experiment, reached with the study's preview token. It may be
// framed (Claude and ChatGPT show it inside the chat); it changes nothing and saves nothing.
runApp.get('/d/:token', async (req, res) => {
  res.set('Content-Security-Policy', CSP.replace("frame-ancestors 'none'", 'frame-ancestors *'));
  const link = db.prepare("SELECT l.study_id, s.title FROM links l JOIN studies s ON s.id = l.study_id WHERE l.token = ? AND l.kind = 'preview'").get(req.params.token);
  if (!link) return res.status(404).type('html').send(page('<p>This dashboard link is not valid.</p>'));
  const current = await ensureCurrent(link.study_id);
  if (!current) return res.status(404).type('html').send(page('<p>This study has no experiment yet.</p>'));
  const row = { ...db.prepare('SELECT * FROM study_versions WHERE id = ?').get(current.id), title: link.title };

  let { dash_hash: hash } = row;
  if (!row.dash_js || row.dash_build !== RUNTIME_VERSION) {
    const stimuli = JSON.parse(row.stimuli);
    const manifest = Object.fromEntries(Object.entries(stimuli).map(([name, sha]) => [name, fileUrl(name, sha)]));
    try {
      const built = await compileDashboard(row.code, manifest, row.documents ? JSON.parse(row.documents) : documentSnapshot());
      db.prepare('UPDATE study_versions SET dash_js = ?, dash_css = ?, dash_hash = ?, dash_build = ? WHERE id = ?')
        .run(built.js, built.css, built.hash, RUNTIME_VERSION, row.id);
      hash = built.hash;
    } catch (err) {
      return res.status(500).type('html').send(page(`<p>The dashboard could not be built: ${String(err.message).replace(/[<&]/g, '')}</p>`));
    }
  }

  const config = JSON.stringify({
    title: row.title, version: row.number, notes: row.notes, packages: JSON.parse(row.packages), stimuli: Object.keys(JSON.parse(row.stimuli)),
  }).replace(/</g, '\\u003c');
  const asset = `/dv/${row.id}.${hash}`;
  res.type('html').send(page('', `
    <link rel="stylesheet" href="${asset}.css">
    <script type="application/json" id="so-config">${config}</script>
    <script defer src="${asset}.js"></script>`, 'Dashboard'));
});

runApp.get('/dv/:file', (req, res) => {
  const m = req.params.file.match(/^([0-9a-f-]{36})\.([0-9a-f]{16})\.(js|css)$/);
  if (!m) return res.sendStatus(404);
  const v = db.prepare('SELECT dash_js, dash_css, dash_hash FROM study_versions WHERE id = ?').get(m[1]);
  if (!v || v.dash_hash !== m[2]) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
    .type(m[3] === 'js' ? 'application/javascript' : 'text/css')
    .send(m[3] === 'js' ? v.dash_js : v.dash_css);
});

// Bundles are immutable per version, so they cache forever.
runApp.get('/v/:file', (req, res) => {
  const m = req.params.file.match(/^([0-9a-f-]{36})\.([0-9a-f]{16})\.(js|css)$/);
  if (!m) return res.sendStatus(404);
  const v = db.prepare('SELECT bundle_js, bundle_css, bundle_hash FROM study_versions WHERE id = ?').get(m[1]);
  if (!v?.bundle_js || v.bundle_hash !== m[2]) return res.sendStatus(404); // only the live revision keeps its bundle
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
    .type(m[3] === 'js' ? 'application/javascript' : 'text/css')
    .send(m[3] === 'js' ? v.bundle_js : v.bundle_css);
});

// Stimulus files, by content hash. Sandboxed so an SVG opened directly can't run script.
runApp.get('/f/:file', (req, res) => {
  const m = req.params.file.match(/^([0-9a-f]{64})\.([a-z0-9]+)$/);
  if (!m || !(m[2] in MIME)) return res.sendStatus(404);
  res.set({
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin', // the chat panel shows thumbnails
  });
  // Cache headers only travel with the file itself, never with an error.
  const headers = { 'Content-Type': MIME[m[2]], 'Cache-Control': 'public, max-age=31536000, immutable' };
  res.sendFile(join(FILES_DIR, m[1]), { headers }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

runApp.use('/api', express.json({ limit: MAX_TRIAL_BYTES + 64 * 1024 }));

const RESUME_WINDOW = 24 * 60 * 60 * 1000; // an unfinished live run can be picked up for a day
const ACTIVE_WINDOW = 30 * 60 * 1000;      // unfinished runs count towards balancing for 30 minutes

const newSeed = () => randomBytes(8).toString('hex');

function startRun(link, { participantId, params, userAgent, revisionId }) {
  const id = newId();
  const key = newToken();
  const resumeToken = link.kind === 'live' ? newToken() : null;
  const seed = newSeed();
  db.prepare(
    `INSERT INTO runs (id, link_token, study_id, version_id, is_test, key_hash, participant_id, params, user_agent, started_at,
                       last_seen_at, seed, resume_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, link.token, link.study_id, revisionId, link.kind === 'preview' ? 1 : 0, hash(key), participantId,
    JSON.stringify(params), userAgent, now(), now(), seed, resumeToken && hash(resumeToken));
  return { id, key, seed, attempt: 1, resume_token: resumeToken, resume: null };
}

// Pick up an unfinished run: new key, keep its seed, drop the rows of the block it was part-way through.
function resumeRun(run) {
  const key = newToken();
  const resumeToken = newToken();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM trials WHERE run_id = ? AND trial_index >= ?').run(run.id, run.checkpoint_trial);
    db.prepare(
      'UPDATE runs SET key_hash = ?, resume_hash = ?, attempts = attempts + 1, last_seen_at = ?, bytes = (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM trials WHERE run_id = ?) WHERE id = ?'
    ).run(hash(key), hash(resumeToken), now(), run.id, run.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    id: run.id, key, seed: run.seed, attempt: run.attempts + 1, resume_token: resumeToken,
    resume: { block: run.checkpoint_block, trial_offset: run.checkpoint_trial },
  };
}

runApp.post('/api/runs', (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE token = ?').get(String(req.body?.token));
  if (!link) return fail(res, 404, 'This study link is not valid.');
  if (link.closed_at) return fail(res, 410, 'This study is closed. Thank you for your interest.');

  const rules = RECRUITMENT_PARAMS[link.recruitment];
  const given = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
  const params = Object.fromEntries(rules.keep.filter((k) => typeof given[k] === 'string').map((k) => [k, given[k].slice(0, 200)]));
  const participantId = rules.id ? params[rules.id] : null;
  const userAgent = String(req.get('user-agent') ?? '').slice(0, 300);
  const revisionId = currentRevision(link.study_id)?.id;
  if (!revisionId) return fail(res, 404, 'This study is not ready yet.');

  // ESM: the phone app opens a session per prompt, so one participant has many runs.
  const app = appRun(link, given);
  if (app) {
    const session = { participantId: app.participantId, params: app.params, userAgent, revisionId };
    if (link.kind === 'preview') return res.json(startRun(link, session));
    if (!app.participantId) return fail(res, 400, 'Please open this survey from the study app.');
    // A reload continues this prompt's session, never an earlier prompt's.
    const unfinished = db.prepare(
      `SELECT * FROM runs WHERE participant_id = ? AND link_token = ? AND finished_at IS NULL AND started_at > ?
         AND json_extract(params, '$.sessionNumber') IS ? AND json_extract(params, '$.notificationTime') IS ?
       ORDER BY started_at DESC LIMIT 1`
    ).get(app.participantId, link.token, now() - RESUME_WINDOW, app.params.sessionNumber ?? null, app.params.notificationTime ?? null);
    if (unfinished?.version_id === revisionId) return res.json(resumeRun(unfinished));
    return res.json(startRun(link, session));
  }

  if (link.kind === 'preview') return res.json(startRun(link, { participantId, params, userAgent, revisionId }));

  if (rules.id && (!participantId || participantId.includes('%'))) {
    return fail(res, 400, link.recruitment === 'prolific' ? 'Please open this study from Prolific.' : 'Please open this study from SONA.');
  }

  // One completion per participant per study, across all of its live links.
  if (participantId) {
    const done = db.prepare(
      `SELECT 1 FROM runs WHERE study_id = ? AND participant_id = ? AND is_test = 0 AND finished_at IS NOT NULL AND stopped IS NULL`
    ).get(link.study_id, participantId);
    if (done) return fail(res, 409, 'You have already taken part in this study. Thank you!');
  }

  // Resume: this browser's token, or the same participant ID on this link, within a day.
  const token = typeof req.body?.resume === 'string' ? req.body.resume : null;
  const unfinished = (token && db.prepare(
    'SELECT * FROM runs WHERE resume_hash = ? AND link_token = ? AND finished_at IS NULL AND started_at > ?'
  ).get(hash(token), link.token, now() - RESUME_WINDOW))
    ?? (participantId && db.prepare(
      'SELECT * FROM runs WHERE participant_id = ? AND link_token = ? AND finished_at IS NULL AND started_at > ? ORDER BY started_at DESC LIMIT 1'
    ).get(participantId, link.token, now() - RESUME_WINDOW));
  // Resume only into the same experiment: after an update, block positions may no longer match.
  if (unfinished && (!participantId || unfinished.participant_id === participantId) && unfinished.version_id === revisionId) {
    return res.json(resumeRun(unfinished));
  }
  res.json(startRun(link, { participantId, params, userAgent, revisionId }));
});

function ownedRun(req, res) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
  if (!run || run.key_hash !== hash(String(req.body?.key))) {
    fail(res, 403, 'This session is not valid.');
    return null;
  }
  return run;
}

runApp.post('/api/runs/:id/data', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  if (run.finished_at) return fail(res, 409, 'This session has already finished.');
  const index = Number(req.body.trial_index);
  if (!Number.isInteger(index) || index < 0 || typeof req.body.data !== 'object') return fail(res, 400, 'Invalid trial data.');
  const json = JSON.stringify(req.body.data);
  if (run.bytes + json.length > MAX_RUN_BYTES) return fail(res, 413, 'Too much data for one session.');

  // A retried trial replaces itself rather than duplicating.
  db.prepare('INSERT OR REPLACE INTO trials (run_id, trial_index, data, received_at) VALUES (?, ?, ?, ?)')
    .run(run.id, index, json, now());
  const name = typeof req.body.trial_name === 'string' ? req.body.trial_name.slice(0, 120) : null;
  db.prepare('UPDATE runs SET bytes = bytes + ?, last_seen_at = ?, last_trial_index = ?, last_trial_name = ? WHERE id = ?')
    .run(json.length, now(), index, name, run.id);
  res.json({ ok: true });
});

// After each top-level timeline item: where a resumed run continues from.
runApp.post('/api/runs/:id/checkpoint', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  const block = Number(req.body.block);
  const trials = Number(req.body.trial_count);
  if (!Number.isInteger(block) || !Number.isInteger(trials) || block < run.checkpoint_block) return fail(res, 400, 'Invalid checkpoint.');
  db.prepare('UPDATE runs SET checkpoint_block = ?, checkpoint_trial = ?, last_seen_at = ? WHERE id = ?').run(block, trials, now(), run.id);
  res.json({ ok: true });
});

// Errors from the participant's browser, for study_status. Capped per run.
runApp.post('/api/runs/:id/events', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(run.id).n;
  if (count >= 30) return res.json({ ok: true });
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  db.prepare('INSERT INTO run_events (run_id, kind, message, trial_index, trial_name, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(run.id, req.body.kind === 'error' ? 'error' : 'other', str(req.body.message, 500) ?? 'Unknown error',
      Number.isInteger(req.body.trial_index) ? req.body.trial_index : null, str(req.body.trial_name, 120), str(req.body.detail, 4000), now());
  res.json({ ok: true });
});

// Balanced condition assignment: the least-used condition on this link, counting completed runs and runs
// active in the last 30 minutes. Stable per run, so a resumed participant keeps their condition.
runApp.post('/api/runs/:id/assign', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  const name = String(req.body.name ?? '');
  const conditions = Array.isArray(req.body.conditions) ? req.body.conditions.map(String).slice(0, 50) : [];
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name) || conditions.length < 2 || conditions.some((c) => c.length > 200)) {
    return fail(res, 400, 'Invalid assignment request.');
  }
  // Preview (test) runs can be put in a condition from the preview link (?condition=speed), to check each one.
  const chosen = String(req.body.chosen ?? '');
  if (run.is_test && conditions.includes(chosen)) {
    db.prepare('INSERT OR REPLACE INTO assignments (run_id, name, value, at) VALUES (?, ?, ?, ?)').run(run.id, name, chosen, now());
    return res.json({ value: chosen });
  }
  const existing = db.prepare('SELECT value FROM assignments WHERE run_id = ? AND name = ?').get(run.id, name);
  if (existing) return res.json({ value: existing.value });

  db.exec('BEGIN IMMEDIATE');
  try {
    const counts = Object.fromEntries(conditions.map((c) => [c, 0]));
    const rows = db.prepare(
      `SELECT a.value, COUNT(*) AS n FROM assignments a JOIN runs r ON r.id = a.run_id
       WHERE r.link_token = ? AND a.name = ? AND r.stopped IS NULL
         AND (r.finished_at IS NOT NULL OR COALESCE(r.last_seen_at, r.started_at) > ?)
       GROUP BY a.value`
    ).all(run.link_token, name, now() - ACTIVE_WINDOW);
    for (const row of rows) if (row.value in counts) counts[row.value] = row.n;
    const fewest = Math.min(...Object.values(counts));
    const candidates = conditions.filter((c) => counts[c] === fewest);
    const value = candidates[randomInt(candidates.length)];
    db.prepare('INSERT INTO assignments (run_id, name, value, at) VALUES (?, ?, ?, ?)').run(run.id, name, value, now());
    db.exec('COMMIT');
    res.json({ value });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// The esmCode block: an enrolment code for an ESM study, the same one each time for this run.
runApp.post('/api/runs/:id/esm-code', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  try {
    res.json({ code: codeForRun(run, req.body.study) });
  } catch (err) {
    if (err instanceof StudyError) return fail(res, 400, err.message);
    throw err;
  }
});

// The completion URL is only revealed here, so it can't be read before doing the study. Runs a block
// stopped early (wrong device, stimuli failed to load) end without it.
runApp.post('/api/runs/:id/finish', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  const stopped = typeof req.body.stopped === 'string' ? req.body.stopped.slice(0, 40) : null;
  if (!run.finished_at) db.prepare('UPDATE runs SET finished_at = ?, stopped = ? WHERE id = ?').run(now(), stopped, run.id);
  if (stopped || run.stopped) return res.json({ redirect: null });
  const link = db.prepare('SELECT recruitment, completion_url FROM links WHERE token = ?').get(run.link_token);
  let redirect = link.completion_url;
  if (redirect && link.recruitment === 'sona') redirect = redirect.replace('XXXX', encodeURIComponent(run.participant_id));
  res.json({ redirect });
});

// The MetaForge phone apps' endpoints, for ESM studies.
runApp.use(esmApp);

runApp.use((_req, res) => res.status(404).type('text').send('Not found'));

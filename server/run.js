// The participant-facing origin (run.2ndorder.live). It serves experiment pages and accepts their
// data, and nothing else: no sessions, no admin API, no access to the main site's cookies.
import express from 'express';
import { db, hash, newId, newToken, now } from './db.js';

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

runApp.get('/s/:token', (req, res) => {
  const link = db.prepare(
    `SELECT l.*, v.number, v.bundle_hash, v.id AS vid FROM links l JOIN study_versions v ON v.id = l.version_id WHERE l.token = ?`
  ).get(req.params.token);
  if (!link) return res.status(404).type('html').send(page('<p>This study link is not valid.</p>'));
  if (link.closed_at) return res.status(410).type('html').send(page('<p>This study is closed. Thank you for your interest.</p>'));

  const config = JSON.stringify({ token: link.token, mode: link.kind, version: link.number }).replace(/</g, '\\u003c');
  const asset = `/v/${link.vid}.${link.bundle_hash}`;
  res.type('html').send(page('', `
    <link rel="stylesheet" href="${asset}.css">
    <script type="application/json" id="so-config">${config}</script>
    <script defer src="${asset}.js"></script>`));
});

function page(body, head = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="color-scheme" content="light">
  <title>Research study</title>${head}
</head>
<body style="margin:0;background:#fff;color:#000">
  <div id="jspsych-target">${body ? `<div style="max-width:560px;margin:20vh auto 0;padding:0 16px;font:18px/1.5 system-ui,sans-serif;text-align:center">${body}</div>` : ''}</div>
</body>
</html>`;
}

// Bundles are immutable per version, so they cache forever.
runApp.get('/v/:file', (req, res) => {
  const m = req.params.file.match(/^([0-9a-f-]{36})\.([0-9a-f]{16})\.(js|css)$/);
  if (!m) return res.sendStatus(404);
  const v = db.prepare('SELECT bundle_js, bundle_css, bundle_hash FROM study_versions WHERE id = ?').get(m[1]);
  if (!v || v.bundle_hash !== m[2]) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
    .type(m[3] === 'js' ? 'application/javascript' : 'text/css')
    .send(m[3] === 'js' ? v.bundle_js : v.bundle_css);
});

runApp.use('/api', express.json({ limit: MAX_TRIAL_BYTES + 64 * 1024 }));

runApp.post('/api/runs', (req, res) => {
  const link = db.prepare('SELECT * FROM links WHERE token = ?').get(String(req.body?.token));
  if (!link) return fail(res, 404, 'This study link is not valid.');
  if (link.closed_at) return fail(res, 410, 'This study is closed. Thank you for your interest.');

  const rules = RECRUITMENT_PARAMS[link.recruitment];
  const given = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
  const params = Object.fromEntries(rules.keep.filter((k) => typeof given[k] === 'string').map((k) => [k, given[k].slice(0, 200)]));
  const participantId = rules.id ? params[rules.id] : null;
  if (link.kind === 'live' && rules.id && (!participantId || participantId.includes('%'))) {
    return fail(res, 400, link.recruitment === 'prolific'
      ? 'Please open this study from Prolific.'
      : 'Please open this study from SONA.');
  }

  const id = newId();
  const key = newToken();
  db.prepare(
    `INSERT INTO runs (id, link_token, study_id, version_id, is_test, key_hash, participant_id, params, user_agent, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, link.token, link.study_id, link.version_id, link.kind === 'preview' ? 1 : 0, hash(key),
    participantId, JSON.stringify(params), String(req.get('user-agent') ?? '').slice(0, 300), now());
  res.json({ id, key });
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
  db.prepare('UPDATE runs SET bytes = bytes + ? WHERE id = ?').run(json.length, run.id);
  res.json({ ok: true });
});

// The completion URL is only revealed here, so it can't be read before doing the study.
runApp.post('/api/runs/:id/finish', (req, res) => {
  const run = ownedRun(req, res);
  if (!run) return;
  if (!run.finished_at) db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(now(), run.id);
  const link = db.prepare('SELECT recruitment, completion_url FROM links WHERE token = ?').get(run.link_token);
  let redirect = link.completion_url;
  if (redirect && link.recruitment === 'sona') redirect = redirect.replace('XXXX', encodeURIComponent(run.participant_id));
  res.json({ redirect });
});

runApp.use((_req, res) => res.status(404).type('text').send('Not found'));

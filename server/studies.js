// Studies, immutable versions, links and collected data. Every function takes the acting user and
// enforces access: owners see their own studies, admins see all.
import { randomBytes } from 'node:crypto';
import { db, newId, newToken, now } from './db.js';
import { config } from './config.js';
import { compileExperiment } from './compile.js';

export class StudyError extends Error {}

const slugify = (title) =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'study';

export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function linkUrl(link) {
  const base = `${config.runOrigin}/s/${link.token}`;
  if (link.recruitment === 'prolific') return `${base}?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`;
  if (link.recruitment === 'sona') return `${base}?id=%SURVEY_CODE%`;
  return base;
}

/* ---------- Studies ---------- */

export function createStudy(user, { title, description }) {
  const id = `${slugify(title)}-${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT INTO studies (id, title, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, title.trim(), description?.trim() || null, user.id, now());
  return { id, title };
}

export function listStudies(user) {
  return db.prepare(
    `SELECT s.id, s.title, u.name AS owner, s.created_at,
            (SELECT MAX(number) FROM study_versions v WHERE v.study_id = s.id) AS latest_version,
            (SELECT COUNT(*) FROM runs r WHERE r.study_id = s.id AND r.is_test = 0) AS participants,
            (SELECT COUNT(*) FROM runs r WHERE r.study_id = s.id AND r.is_test = 0 AND r.finished_at IS NOT NULL) AS completed
     FROM studies s JOIN users u ON u.id = s.owner_id
     WHERE s.owner_id = ? OR ? = 'admin'
     ORDER BY s.created_at DESC`
  ).all(user.id, user.role).map((s) => ({ ...s, created_at: iso(s.created_at) }));
}

export function findStudy(user, studyId) {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(String(studyId));
  if (!study || (study.owner_id !== user.id && user.role !== 'admin')) {
    throw new StudyError(`No study "${studyId}". Use list_studies to see your studies.`);
  }
  return study;
}

function findVersion(study, number) {
  const version = number == null
    ? db.prepare('SELECT * FROM study_versions WHERE study_id = ? ORDER BY number DESC LIMIT 1').get(study.id)
    : db.prepare('SELECT * FROM study_versions WHERE study_id = ? AND number = ?').get(study.id, number);
  if (!version) throw new StudyError(number == null ? 'This study has no versions yet. Save one with save_version.' : `Version ${number} does not exist.`);
  return version;
}

const linkSummary = (link, version) => ({
  url: linkUrl(link),
  kind: link.kind,
  version: version ?? db.prepare('SELECT number FROM study_versions WHERE id = ?').get(link.version_id).number,
  recruitment: link.recruitment,
  label: link.label,
  status: link.closed_at ? `closed ${iso(link.closed_at)}` : 'open',
  ...(link.kind === 'live' ? runCounts('link_token', link.token) : {}),
});

function runCounts(column, value) {
  return db.prepare(
    `SELECT COUNT(*) AS started, COUNT(finished_at) AS completed FROM runs WHERE ${column} = ? AND is_test = 0`
  ).get(value);
}

export function describeStudy(user, studyId, versionNumber) {
  const study = findStudy(user, studyId);
  const versions = db.prepare('SELECT id, number, notes, packages, created_at FROM study_versions WHERE study_id = ? ORDER BY number').all(study.id);
  const shown = versions.length ? findVersion(study, versionNumber) : null;
  const links = db.prepare("SELECT * FROM links WHERE study_id = ? AND kind = 'live' ORDER BY created_at").all(study.id);
  return {
    id: study.id,
    title: study.title,
    description: study.description,
    participants: runCounts('study_id', study.id),
    versions: versions.map((v) => ({ number: v.number, notes: v.notes, created_at: iso(v.created_at) })),
    participant_links: links.map((l) => linkSummary(l)),
    ...(shown && {
      version: shown.number,
      preview_url: linkUrl(db.prepare("SELECT * FROM links WHERE version_id = ? AND kind = 'preview'").get(shown.id)),
      packages: JSON.parse(shown.packages),
      code: shown.code,
    }),
  };
}

/* ---------- Versions ---------- */

export async function saveVersion(user, studyId, { code, notes }) {
  const study = findStudy(user, studyId);
  const compiled = await compileExperiment(code); // throws CompileError with line numbers

  const versionId = newId();
  const previewToken = newToken();
  let number;
  db.exec('BEGIN IMMEDIATE');
  try {
    number = (db.prepare('SELECT MAX(number) AS n FROM study_versions WHERE study_id = ?').get(study.id).n ?? 0) + 1;
    db.prepare(
      `INSERT INTO study_versions (id, study_id, number, notes, code, packages, bundle_js, bundle_css, bundle_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(versionId, study.id, number, notes?.trim() || null, code, JSON.stringify(compiled.packages),
      compiled.js, compiled.css, compiled.hash, user.id, now());
    db.prepare(
      `INSERT INTO links (token, study_id, version_id, kind, recruitment, created_by, created_at)
       VALUES (?, ?, ?, 'preview', 'none', ?, ?)`
    ).run(previewToken, study.id, versionId, user.id, now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    version: number,
    preview_url: linkUrl({ token: previewToken, recruitment: 'none' }),
    packages: compiled.packages,
    warnings: compiled.warnings,
  };
}

/* ---------- Participant links ---------- */

const COMPLETION_PATTERNS = {
  prolific: /^https:\/\/app\.prolific\.com\/submissions\/complete\?cc=[A-Za-z0-9]+$/,
  sona: /^https:\/\/[a-z0-9-]+\.sona-systems\.com\/.*survey_code=XXXX/,
};

export function createLink(user, studyId, { version, recruitment, completion_url, label }) {
  const study = findStudy(user, studyId);
  const v = findVersion(study, version);
  if (COMPLETION_PATTERNS[recruitment] && !COMPLETION_PATTERNS[recruitment].test(completion_url ?? '')) {
    throw new StudyError(recruitment === 'prolific'
      ? 'Prolific links need the completion URL from Prolific, like https://app.prolific.com/submissions/complete?cc=ABC123'
      : 'SONA links need the completion URL from the SONA study page, with survey_code=XXXX left as is.');
  }
  const token = newToken();
  db.prepare(
    `INSERT INTO links (token, study_id, version_id, kind, recruitment, completion_url, label, created_by, created_at)
     VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?)`
  ).run(token, study.id, v.id, recruitment, COMPLETION_PATTERNS[recruitment] ? completion_url : null,
    label?.trim() || null, user.id, now());
  return linkSummary(db.prepare('SELECT * FROM links WHERE token = ?').get(token), v.number);
}

export function closeLink(user, studyId, url) {
  const study = findStudy(user, studyId);
  const token = String(url).match(/\/s\/([A-Za-z0-9_-]+)/)?.[1] ?? String(url);
  const link = db.prepare("SELECT * FROM links WHERE token = ? AND study_id = ? AND kind = 'live'").get(token, study.id);
  if (!link) throw new StudyError('No participant link with that URL in this study.');
  if (!link.closed_at) db.prepare('UPDATE links SET closed_at = ? WHERE token = ?').run(now(), token);
  return linkSummary(db.prepare('SELECT * FROM links WHERE token = ?').get(token));
}

/* ---------- Data ---------- */

const csvCell = (value) => {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One row per trial, with the run's details first so every row stands on its own.
export function exportData(user, studyId, { version, include_test = false, completed_only = false, max_rows = 2000 } = {}) {
  const study = findStudy(user, studyId);
  const where = ['r.study_id = ?'];
  const args = [study.id];
  if (version != null) { where.push('v.number = ?'); args.push(version); }
  if (!include_test) where.push('r.is_test = 0');
  if (completed_only) where.push('r.finished_at IS NOT NULL');

  const rows = db.prepare(
    `SELECT r.id AS run_id, v.number AS version, r.is_test, r.participant_id, r.params,
            r.started_at, r.finished_at, t.data
     FROM runs r JOIN study_versions v ON v.id = r.version_id JOIN trials t ON t.run_id = r.id
     WHERE ${where.join(' AND ')}
     ORDER BY r.started_at, t.trial_index
     LIMIT ?`
  ).all(...args, max_rows + 1);

  const truncated = rows.length > max_rows;
  const records = rows.slice(0, max_rows).map((row) => ({
    run_id: row.run_id,
    version: row.version,
    test: row.is_test === 1,
    participant_id: row.participant_id,
    ...Object.fromEntries(Object.entries(JSON.parse(row.params)).map(([k, v]) => [`param_${k}`, v])),
    run_started: iso(row.started_at),
    run_completed: iso(row.finished_at),
    ...JSON.parse(row.data),
  }));
  const all = [...new Set(records.flatMap(Object.keys))];
  const first = ['run_id', 'version', 'test', 'participant_id', ...all.filter((c) => c.startsWith('param_')), 'run_started', 'run_completed'];
  const columns = [...first.filter((c) => all.includes(c)), ...all.filter((c) => !first.includes(c))];
  const csv = [columns.join(','), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n');

  const runs = db.prepare(
    `SELECT COUNT(*) AS started, COUNT(r.finished_at) AS completed FROM runs r JOIN study_versions v ON v.id = r.version_id
     WHERE ${where.join(' AND ')}`
  ).get(...args);
  return { runs, rows: records.length, truncated, csv };
}

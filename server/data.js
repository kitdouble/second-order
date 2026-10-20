// Data outside the chat (expiring download links) and withdrawals (deleting a participant's data).
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { db, hash, newToken, now } from './db.js';
import { config } from './config.js';
import { exportData, findStudy, iso, StudyError } from './studies.js';
import { forgetParticipant } from './esm.js';

const DOWNLOAD_MINUTES = 60;

export function createDownloadLink(user, studyId, { format = 'csv', include_test = false, completed_only = false, exclusions = 'none' } = {}) {
  const study = findStudy(user, studyId);
  const token = newToken();
  db.prepare('INSERT INTO download_links (token_hash, study_id, user_id, options, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(hash(token), study.id, user.id, JSON.stringify({ format, include_test, completed_only, exclusions }), now() + DOWNLOAD_MINUTES * 60 * 1000);
  return {
    url: `${config.origin}/api/downloads/${token}`,
    expires_in_minutes: DOWNLOAD_MINUTES,
    note: 'Give this link to the researcher to open in their browser; the file downloads directly and its contents never pass through the chat. ' +
      'Anyone with the link can download until it expires.',
  };
}

export const downloads = Router();

// GET /api/downloads/:token: the full data set (no row limit), built when downloaded.
downloads.get('/:token', (req, res) => {
  const link = db.prepare(
    `SELECT d.*, u.id AS uid, u.role FROM download_links d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND d.expires_at > ?`
  ).get(hash(String(req.params.token)), now());
  if (!link) return res.status(404).type('text').send('This download link has expired. Ask Claude or ChatGPT for a new one.');
  const options = JSON.parse(link.options);
  const user = { id: link.uid, role: link.role };
  let study;
  try {
    study = findStudy(user, link.study_id);
  } catch {
    return res.status(403).type('text').send('You no longer have access to this study.');
  }
  const data = exportData(user, study.id, { ...options, max_rows: Infinity });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = `${study.id}${options.include_test ? '-with-test' : ''}-${stamp}`;
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (options.format === 'json') {
    res.attachment(`${name}.json`).type('application/json').send(JSON.stringify(data.records, null, 1));
  } else {
    res.attachment(`${name}.csv`).type('text/csv').send(data.csv);
  }
});

const pidHash = (id) => createHash('sha256').update(`second-order:${id}`).digest('hex').slice(0, 16);

/**
 * Delete data: one participant (by platform ID, e.g. a withdrawal request), one session (run id), or all
 * test (preview) data. The deletion is logged without the data or the raw participant ID.
 */
export function deleteData(user, studyId, { participant_id, run_id, test_data = false, reason }) {
  const study = findStudy(user, studyId, 'own');
  const chosen = [participant_id, run_id, test_data || null].filter(Boolean).length;
  if (chosen !== 1) throw new StudyError('Give exactly one of participant_id, run_id or test_data: true.');

  let where;
  let args;
  let scope;
  if (participant_id) { where = 'participant_id = ?'; args = [String(participant_id)]; scope = 'participant'; }
  else if (run_id) { where = 'id = ?'; args = [String(run_id)]; scope = 'run'; }
  else { where = 'is_test = 1'; args = []; scope = 'test'; }

  const runs = db.prepare(`SELECT id FROM runs WHERE study_id = ? AND ${where}`).all(study.id, ...args);
  if (!runs.length) throw new StudyError(`Nothing found to delete for that ${scope === 'test' ? 'study (no test data)' : scope}.`);

  db.exec('BEGIN IMMEDIATE');
  try {
    // Trials, events and assignments go with their runs (foreign keys cascade).
    db.prepare(`DELETE FROM runs WHERE study_id = ? AND ${where}`).run(study.id, ...args);
    if (participant_id) forgetParticipant(study.id, String(participant_id)); // ESM: ends the app enrolment too
    db.prepare('INSERT INTO deletions (study_id, runs, participant_id_hash, scope, reason, deleted_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(study.id, runs.length, participant_id ? pidHash(participant_id) : null, scope, reason?.slice(0, 500) ?? null, user.id, now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    deleted_sessions: runs.length,
    scope,
    note: scope === 'test' ? 'All preview (test) data for this study was deleted.'
      : 'Deleted permanently, including from future downloads. Copies already downloaded and the server\'s daily backups (kept 14 days) still contain it until they age out.',
  };
}

export function deletionLog(user, studyId) {
  const study = findStudy(user, studyId);
  return db.prepare('SELECT scope, runs, reason, at FROM deletions WHERE study_id = ? ORDER BY at DESC').all(study.id)
    .map((d) => ({ ...d, at: iso(d.at) }));
}

/* ---------- Summaries (aggregates that fit in the chat when the trial rows don't) ---------- */

const MAX_GROUPS = 5000;
const round = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const median = (sorted) => (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// One row per group (e.g. per participant and condition): row count, and for each value column its mean,
// sd and median (numbers) or the share true (true/false columns), over the rows that have it.
export function summariseData(user, studyId, { group_by = ['participant_id'], values, ...options }) {
  const { runs, records, columns } = exportData(user, studyId, { ...options, max_rows: Infinity, offset: 0 });
  const unknown = [...group_by, ...values].filter((c) => !columns.includes(c));
  if (records.length && unknown.length) {
    throw new StudyError(`No column ${unknown.map((c) => `"${c}"`).join(', ')} in these rows. Columns: ${columns.slice(0, 80).join(', ')}`);
  }

  const groups = new Map();
  for (const row of records) {
    const key = JSON.stringify(group_by.map((c) => row[c] ?? null));
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= MAX_GROUPS) throw new StudyError(`More than ${MAX_GROUPS} groups: group by fewer or coarser columns.`);
      g = { key: group_by.map((c) => row[c] ?? null), rows: 0, values: Object.fromEntries(values.map((c) => [c, []])) };
      groups.set(key, g);
    }
    g.rows += 1;
    for (const c of values) if (row[c] != null && row[c] !== '') g.values[c].push(row[c]);
  }

  // A column is summarised as true/false when every value in it is a boolean, otherwise as numbers.
  const kind = Object.fromEntries(values.map((c) => [c, records.every((r) => r[c] == null || r[c] === '' || typeof r[c] === 'boolean') ? 'share' : 'number']));
  const header = [...group_by, 'n_rows', ...values.flatMap((c) => (kind[c] === 'share' ? [`${c}_n`, `${c}_share_true`] : [`${c}_n`, `${c}_mean`, `${c}_sd`, `${c}_median`]))];
  const out = [...groups.values()].map((g) => {
    const cells = [...g.key, g.rows];
    for (const c of values) {
      if (kind[c] === 'share') {
        const vs = g.values[c];
        cells.push(vs.length, vs.length ? round(vs.filter(Boolean).length / vs.length) : null);
      } else {
        const xs = g.values[c].map(asNumber).filter((x) => x !== null).sort((a, b) => a - b);
        const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
        const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)) : null;
        cells.push(xs.length, round(mean), round(sd), xs.length ? round(median(xs)) : null);
      }
    }
    return cells;
  });
  const csvCell = (v) => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header.join(','), ...out.map((cells) => cells.map(csvCell).join(','))].join('\n');
  return { runs, rows: records.length, groups: out.length, csv };
}

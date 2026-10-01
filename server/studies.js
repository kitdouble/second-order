// Studies, access, participant links and collected data. Every function takes the acting user and
// enforces access (owner and admins, editor, viewer). The live experiment and saved versions: live.js.
import { randomBytes } from 'node:crypto';
import { db, newId, newToken, now } from './db.js';
import { config } from './config.js';
import { currentManifest, extensionOf, fileUrl, MIME } from './stimuli.js';
import { currentRevision, listSavedVersions, savedVersion as savedVersionRow } from './live.js';
import { studyStatus as statusFor } from './monitor.js';
import { assess, rulesFor } from './quality.js';

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

export const dashboardUrl = (previewToken) => `${config.runOrigin}/d/${previewToken}`;

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
            CASE WHEN s.owner_id = ? OR ? = 'admin' THEN 'owner' ELSE m.role END AS your_role,
            (SELECT MAX(number) FROM study_versions v WHERE v.study_id = s.id) AS latest_version,
            (SELECT COUNT(*) FROM runs r WHERE r.study_id = s.id AND r.is_test = 0) AS participants,
            (SELECT COUNT(*) FROM runs r WHERE r.study_id = s.id AND r.is_test = 0 AND r.finished_at IS NOT NULL) AS completed
     FROM studies s JOIN users u ON u.id = s.owner_id
     LEFT JOIN study_members m ON m.study_id = s.id AND m.user_id = ?
     WHERE s.owner_id = ? OR ? = 'admin' OR m.user_id IS NOT NULL
     ORDER BY s.created_at DESC`
  ).all(user.id, user.role, user.id, user.id, user.role).map((s) => ({ ...s, created_at: iso(s.created_at) }));
}

/* ---------- Access: owner (and admins), editor, viewer ---------- */

const RANK = { view: 1, edit: 2, own: 3 };
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

export function roleIn(user, study) {
  if (user.role === 'admin' || study.owner_id === user.id) return 'owner';
  return db.prepare('SELECT role FROM study_members WHERE study_id = ? AND user_id = ?').get(study.id, user.id)?.role ?? null;
}

// need: 'view' (read, data), 'edit' (versions, links, stimuli), 'own' (delete data, members).
export function findStudy(user, studyId, need = 'view') {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(String(studyId));
  const role = study && roleIn(user, study);
  if (!role) throw new StudyError(`No study "${studyId}". Use list_studies to see your studies.`);
  if (ROLE_RANK[role] < RANK[need]) {
    throw new StudyError(`You have ${role} access to "${study.title}"; this needs ${need === 'own' ? 'owner' : 'editor'} access. Ask the study's owner.`);
  }
  return { ...study, your_role: role };
}

export function shareStudy(user, studyId, { email, role }) {
  const study = findStudy(user, studyId, 'own');
  const member = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(String(email).trim());
  if (!member) throw new StudyError(`No Second Order account for ${email}. An admin can invite them first (create_invite).`);
  if (member.id === study.owner_id) throw new StudyError(`${member.name} owns this study already.`);
  db.prepare(
    `INSERT INTO study_members (study_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (study_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(study.id, member.id, role, user.id, now());
  return { shared_with: `${member.name} <${member.email}>`, role, study: study.title };
}

export function listMembers(user, studyId) {
  const study = findStudy(user, studyId, 'view');
  const owner = db.prepare('SELECT name, email FROM users WHERE id = ?').get(study.owner_id);
  const members = db.prepare(
    `SELECT u.name, u.email, m.role, m.added_at FROM study_members m JOIN users u ON u.id = m.user_id WHERE m.study_id = ? ORDER BY m.added_at`
  ).all(study.id);
  return [{ ...owner, role: 'owner' }, ...members.map((m) => ({ name: m.name, email: m.email, role: m.role, added: iso(m.added_at) }))];
}

export function removeMember(user, studyId, email) {
  const study = findStudy(user, studyId, 'own');
  const { changes } = db.prepare(
    'DELETE FROM study_members WHERE study_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)'
  ).run(study.id, String(email).trim());
  if (!changes) throw new StudyError(`${email} isn't a member of this study.`);
  return { removed: email };
}

const linkSummary = (link) => ({
  url: linkUrl(link),
  kind: link.kind,
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

/** The study and its live experiment (or, with savedVersion, that saved version's code). */
export function describeStudy(user, studyId, savedVersion) {
  const study = findStudy(user, studyId);
  const revision = currentRevision(study.id);
  const preview = db.prepare("SELECT token FROM links WHERE study_id = ? AND kind = 'preview' ORDER BY created_at DESC LIMIT 1").get(study.id);
  const links = db.prepare("SELECT * FROM links WHERE study_id = ? AND kind = 'live' ORDER BY created_at").all(study.id);
  const shownVersion = savedVersion != null ? savedVersionRow(study.id, savedVersion) : null;
  return {
    id: study.id,
    title: study.title,
    your_role: study.your_role,
    description: study.description,
    participants: runCounts('study_id', study.id),
    participant_links: links.map(linkSummary),
    saved_versions: listSavedVersions(study.id),
    ...(revision && {
      revision: revision.number,
      updated: iso(revision.created_at),
      update_notes: revision.notes,
      preview_url: preview && linkUrl({ token: preview.token, recruitment: 'none' }),
      dashboard_url: preview && dashboardUrl(preview.token),
      packages: JSON.parse(revision.packages),
      stimuli: Object.keys(currentManifest(study.id)),
    }),
    ...(shownVersion
      ? { showing: `saved version ${shownVersion.number} (${shownVersion.name})`, code: shownVersion.code }
      : revision ? { code: revision.code } : { note: 'No experiment yet: write it with update_experiment.' }),
  };
}

/** Everything the in-chat panel shows for a study. */
export function panelState(user, studyId) {
  const study = describeStudy(user, studyId);
  if (!study.revision) throw new StudyError('This study has no experiment yet. Write it with update_experiment.');
  const stimuli = Object.entries(currentManifest(study.id)).sort(([a], [b]) => a.localeCompare(b)).map(([name, sha]) => ({
    name, type: MIME[extensionOf(name)] ?? 'application/octet-stream', url: `${config.runOrigin}${fileUrl(name, sha)}`,
  }));
  const { code: _code, packages: _packages, ...rest } = study;
  return { ...rest, stimuli, status: statusFor(user, study.id) };
}

/* ---------- Participant links ---------- */

const COMPLETION_PATTERNS = {
  prolific: /^https:\/\/app\.prolific\.com\/submissions\/complete\?cc=[A-Za-z0-9]+$/,
  sona: /^https:\/\/[a-z0-9-]+\.sona-systems\.com\/.*survey_code=XXXX/,
};

export function createLink(user, studyId, { recruitment, completion_url, label }) {
  const study = findStudy(user, studyId, 'edit');
  const v = currentRevision(study.id);
  if (!v) throw new StudyError('Write the experiment (update_experiment) before creating a participant link.');
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
  return { ...linkSummary(db.prepare('SELECT * FROM links WHERE token = ?').get(token)), note: 'Runs the live experiment, including any later updates.' };
}

export function closeLink(user, studyId, url) {
  const study = findStudy(user, studyId, 'edit');
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
export function exportData(user, studyId, { include_test = false, completed_only = false, max_rows = 2000, exclusions = 'none' } = {}) {
  const study = findStudy(user, studyId);
  const where = ['r.study_id = ?'];
  const args = [study.id];
  if (!include_test) where.push('r.is_test = 0');
  if (completed_only) where.push('r.finished_at IS NOT NULL AND r.stopped IS NULL');

  // Exclusion rules are judged per session, over all of its rows.
  let judged = null;
  if (exclusions !== 'none') {
    const rules = rulesFor(study);
    const runs = db.prepare(`SELECT r.* FROM runs r JOIN study_versions v ON v.id = r.version_id WHERE ${where.join(' AND ')}`).all(...args);
    const rowsOf = db.prepare('SELECT data FROM trials WHERE run_id = ?');
    judged = new Map(runs.map((run) => [run.id, assess(run, rowsOf.all(run.id).map((t) => JSON.parse(t.data)), rules)]));
    if (exclusions === 'drop') {
      const keep = [...judged].filter(([, q]) => !q.excluded).map(([id]) => id);
      where.push(keep.length ? `r.id IN (${keep.map(() => '?').join(',')})` : '0');
      args.push(...keep);
    }
  }

  const rows = db.prepare(
    `SELECT r.id AS run_id, v.number AS revision, r.is_test, r.participant_id, r.params,
            r.started_at, r.finished_at, r.stopped, t.data
     FROM runs r JOIN study_versions v ON v.id = r.version_id JOIN trials t ON t.run_id = r.id
     WHERE ${where.join(' AND ')}
     ORDER BY r.started_at, t.trial_index
     LIMIT ?`
  ).all(...args, Number.isFinite(max_rows) ? max_rows + 1 : -1);

  const truncated = rows.length > max_rows;
  const records = rows.slice(0, max_rows).map((row) => ({
    run_id: row.run_id,
    revision: row.revision,
    test: row.is_test === 1,
    participant_id: row.participant_id,
    ...Object.fromEntries(Object.entries(JSON.parse(row.params)).map(([k, v]) => [`param_${k}`, v])),
    run_started: iso(row.started_at),
    run_completed: iso(row.finished_at),
    run_status: row.finished_at ? (row.stopped ? `stopped: ${row.stopped}` : 'completed') : 'incomplete',
    ...(judged && { excluded: judged.get(row.run_id)?.excluded ?? false, exclusion_reasons: judged.get(row.run_id)?.reasons.join('; ') ?? '' }),
    ...JSON.parse(row.data),
  }));
  const all = [...new Set(records.flatMap(Object.keys))];
  const first = ['run_id', 'revision', 'test', 'participant_id', ...all.filter((c) => c.startsWith('param_')), 'run_started', 'run_completed', 'run_status', 'excluded', 'exclusion_reasons'];
  const columns = [...first.filter((c) => all.includes(c)), ...all.filter((c) => !first.includes(c))];
  const csv = [columns.join(','), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n');

  const runs = db.prepare(
    `SELECT COUNT(*) AS started, COUNT(r.finished_at) AS completed FROM runs r JOIN study_versions v ON v.id = r.version_id
     WHERE ${where.join(' AND ')}`
  ).get(...args);
  return { runs, rows: records.length, truncated, csv, records, columns };
}

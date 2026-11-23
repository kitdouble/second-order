// Notes the assistants (Claude, ChatGPT) leave about the platform itself: bugs, limitations, missing
// tools, unclear docs. Admins read them with list_feedback and close them with resolve_feedback.
import { db, newId, now, SELF_SERVICE_USER } from './db.js';
import { findStudy } from './studies.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    study_id     TEXT,                       -- context only; no foreign key so notes outlive the study
    kind         TEXT NOT NULL,              -- bug | limitation | suggestion | docs
    tool         TEXT,                       -- the tool it concerns, if any
    client       TEXT,                       -- which assistant wrote it, e.g. "Claude" or "ChatGPT"
    summary      TEXT NOT NULL,
    details      TEXT,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'wontfix')),
    resolution   TEXT,
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER,
    resolved_by  TEXT REFERENCES users(id)
  );
`);

// Reports from the self-service ESM pages: an email to reply to, if the person gave one.
if (!db.prepare('PRAGMA table_info(feedback)').all().some((c) => c.name === 'contact')) db.exec('ALTER TABLE feedback ADD COLUMN contact TEXT');

const SHORT = 8; // ids are shown and accepted as their first 8 characters

export function leaveFeedback(user, { study_id, kind, tool, client, summary, details }) {
  if (study_id) findStudy(user, study_id); // only attach studies the caller can see
  const id = newId();
  db.prepare(
    `INSERT INTO feedback (id, user_id, study_id, kind, tool, client, summary, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, user.id, study_id ?? null, kind, tool ?? null, client ?? null, summary.trim(), details?.trim() || null, now());
  return { id: id.slice(0, SHORT), saved: 'Thanks. The Second Order maintainers will read this.' };
}

export function listFeedback({ status = 'open', limit = 50 } = {}) {
  const rows = db.prepare(
    `SELECT f.id, f.kind, f.tool, f.client, f.summary, f.details, f.contact, f.status, f.resolution, f.study_id,
            s.title AS study_title, u.name AS from_user,
            datetime(f.created_at / 1000, 'unixepoch') AS created,
            datetime(f.resolved_at / 1000, 'unixepoch') AS resolved
     FROM feedback f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN studies s ON s.id = f.study_id
     WHERE ? = 'all' OR f.status = ?
     ORDER BY f.created_at DESC LIMIT ?`
  ).all(status, status, limit);
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status').all().map((r) => [r.status, r.n])
  );
  return { counts, notes: rows.map(({ contact, ...r }) => ({ ...r, ...(contact && { reply_to: contact }), id: r.id.slice(0, SHORT) })) };
}

export function resolveFeedback(user, { ids, status = 'resolved', resolution }) {
  const update = db.prepare(
    `UPDATE feedback SET status = ?, resolution = ?, resolved_at = ?, resolved_by = ?
     WHERE id LIKE ? || '%'`
  );
  const results = ids.map((id) => {
    const matches = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE id LIKE ? || '%'").get(id).n;
    if (matches !== 1) return { id, error: matches ? 'ambiguous id' : 'not found' };
    update.run(status, resolution ?? null, now(), user.id, id);
    return { id, status };
  });
  return { results };
}

// Secrets people may paste when describing a problem: owner and edit links, and the keys in Web Service URLs.
const scrub = (text) => String(text ?? '')
  .replace(/(\/esm-edit\/)[A-Za-z0-9_-]{16,}/g, '$1[private link removed]')
  .replace(/([?&]key=)[A-Za-z0-9_-]{16,}/g, '$1[removed]');

/**
 * "Report a problem" on the self-service ESM pages (no account). Saved as feedback from the built-in
 * self-service account, with the page it came from and, from an owner or edit link, the study.
 */
export function reportFromPage({ studyId = null, page, summary, details, contact, userAgent }) {
  const id = newId();
  const browser = String(userAgent ?? '').slice(0, 160);
  db.prepare(
    `INSERT INTO feedback (id, user_id, study_id, kind, tool, client, summary, details, contact, created_at)
     VALUES (?, ?, ?, 'bug', NULL, ?, ?, ?, ?, ?)`
  ).run(id, SELF_SERVICE_USER, studyId, `ESM web page: ${page}`, scrub(summary).trim(),
    [scrub(details).trim(), browser && `Browser: ${browser}`].filter(Boolean).join('\n\n') || null, contact?.trim() || null, now());
  return { id: id.slice(0, SHORT), saved: 'Thanks: the Second Order maintainers will read this.' };
}

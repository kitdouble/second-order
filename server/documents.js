// The consent and debrief library. Each document (e.g. "hrec-2022-796") has versions of its consent and
// debrief texts per recruitment (prolific, sona, lab, or any). Versions are never changed, only added;
// each study version compiles with the latest texts at the time it was saved, so editing a document
// never changes a running study.
//
// Placeholders filled by the blocks: {{minutes}}, {{payment}} (Prolific), {{credit}} (SONA), {{logo}}.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now } from './db.js';
import { iso, StudyError } from './studies.js';

const here = dirname(fileURLToPath(import.meta.url));

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id           INTEGER PRIMARY KEY,
    doc_key      TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('consent', 'debrief')),
    recruitment  TEXT NOT NULL CHECK (recruitment IN ('prolific', 'sona', 'lab', 'any')),
    title        TEXT NOT NULL,
    form_label   TEXT NOT NULL,            -- recorded in the data (consent_form / debrief_form)
    html         TEXT NOT NULL,
    change_note  TEXT,
    created_by   TEXT,                     -- null for the built-in seed
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_key ON documents(doc_key, kind, recruitment, created_at);
`);

// A placeholder protocol so a fresh install has something to run: wording to be replaced, not ethics-approved.
// Real protocols are added with save_document and never live in the code. The oldest document that is not
// this one is what consent() and debrief() use when no `document` is given (see server/lib/documents.js).
export const EXAMPLE_DOCUMENT = 'example-protocol';
const COMPENSATION = {
  prolific: '<p>You will receive {{payment}} for completing the study, through Prolific. [Explain what happens if the study is not completed.]</p>',
  sona: '<p>You will receive {{credit}} course credit for completing the study. [Explain what happens if the study is not completed.]</p>',
  lab: '<p>[Describe any payment or credit, or state that there is none.]</p>',
};
const TEMPLATE_DEBRIEF_LABEL = 'TEMPLATE debrief (not ethics approved)';
if (!db.prepare('SELECT 1 FROM documents WHERE doc_key = ?').get(EXAMPLE_DOCUMENT)) {
  const read = (file) => readFileSync(resolve(here, `documents/${EXAMPLE_DOCUMENT}.${file}.html`), 'utf8');
  const insert = db.prepare(
    `INSERT INTO documents (doc_key, kind, recruitment, title, form_label, html, change_note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Placeholder template', NULL, ?)`
  );
  for (const recruitment of ['prolific', 'sona', 'lab']) {
    insert.run(
      EXAMPLE_DOCUMENT, 'consent', recruitment, `Participant Information Statement (${recruitment}) TEMPLATE`,
      `TEMPLATE consent ${recruitment} (not ethics approved)`, read('consent').replace('<!-- compensation -->', COMPENSATION[recruitment]), now()
    );
  }
  insert.run(EXAMPLE_DOCUMENT, 'debrief', 'any', 'Debrief TEMPLATE', TEMPLATE_DEBRIEF_LABEL, read('debrief'), now());
}

// The text of each (document, kind, recruitment) as it stood at time `at` (the first text if it is older).
const latest = (at = Number.MAX_SAFE_INTEGER) => db.prepare(
  `SELECT d.* FROM documents d
   WHERE d.created_at = COALESCE(
     (SELECT MAX(created_at) FROM documents x WHERE x.doc_key = d.doc_key AND x.kind = d.kind AND x.recruitment = d.recruitment AND x.created_at <= ?),
     (SELECT MIN(created_at) FROM documents x WHERE x.doc_key = d.doc_key AND x.kind = d.kind AND x.recruitment = d.recruitment))
   ORDER BY d.doc_key, d.kind, d.recruitment`
).all(at);

/** {key: {consent: {prolific: {...}}, debrief: {...}}} of the texts at time `at` (default now), as fixed into a study version. */
export function documentSnapshot(at) {
  const snapshot = {};
  const firstRow = Object.fromEntries(db.prepare('SELECT doc_key, MIN(id) AS first FROM documents GROUP BY doc_key').all().map((r) => [r.doc_key, r.first]));
  for (const d of latest(at).sort((a, b) => firstRow[a.doc_key] - firstRow[b.doc_key])) {
    ((snapshot[d.doc_key] ??= {})[d.kind] ??= {})[d.recruitment] = { id: d.id, title: d.title, form_label: d.form_label, html: d.html };
  }
  return snapshot;
}

export function listDocuments() {
  return latest().map((d) => ({
    document: d.doc_key, kind: d.kind, recruitment: d.recruitment, title: d.title, form_label: d.form_label,
    versions: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE doc_key = ? AND kind = ? AND recruitment = ?').get(d.doc_key, d.kind, d.recruitment).n,
    updated: iso(d.created_at),
  }));
}

export function getDocument({ document, kind, recruitment, version }) {
  const versions = db.prepare(
    `SELECT d.*, u.name AS author FROM documents d LEFT JOIN users u ON u.id = d.created_by
     WHERE doc_key = ? AND kind = ? AND recruitment = ? ORDER BY created_at`
  ).all(document, kind, recruitment);
  if (!versions.length) throw new StudyError(`No ${kind} for ${recruitment} in "${document}". Use list_documents.`);
  const shown = version ? versions[version - 1] : versions.at(-1);
  if (!shown) throw new StudyError(`Version ${version} doesn't exist (there are ${versions.length}).`);
  return {
    document, kind, recruitment, version: versions.indexOf(shown) + 1, of: versions.length,
    title: shown.title, form_label: shown.form_label, html: shown.html,
    history: versions.map((v, i) => ({ version: i + 1, form_label: v.form_label, by: v.author ?? 'Meta Lab kit', at: iso(v.created_at), note: v.change_note })),
  };
}

// Only the person who created a document (or an admin) changes it; the built-in one is admin-only.
export function saveDocument(user, { document, kind, recruitment, title, form_label, html, change_note, researcher_confirmed }) {
  if (researcher_confirmed !== true) {
    throw new StudyError('Not saved. Show the researcher the exact wording (or the changes) first, and save only after they explicitly confirm.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(document)) throw new StudyError('document must be a short id like "hrec-2024-123" (lowercase, digits, -).');
  const first = db.prepare('SELECT created_by FROM documents WHERE doc_key = ? ORDER BY created_at LIMIT 1').get(document);
  if (first && first.created_by !== user.id && user.role !== 'admin') {
    throw new StudyError(first.created_by
      ? `"${document}" belongs to someone else; ask them or an admin to change it.`
      : `"${document}" is the lab's built-in protocol; only an admin can change it.`);
  }
  const previous = db.prepare('SELECT * FROM documents WHERE doc_key = ? AND kind = ? AND recruitment = ? ORDER BY created_at DESC LIMIT 1')
    .get(document, kind, recruitment);
  if (previous && previous.html === html && previous.form_label === form_label) throw new StudyError('Nothing changed.');
  if (previous && previous.form_label === form_label) {
    throw new StudyError(`form_label is unchanged ("${form_label}"). Give the new text its own label (e.g. its approved version and date) so the data shows which text each participant saw.`);
  }
  db.prepare(
    `INSERT INTO documents (doc_key, kind, recruitment, title, form_label, html, change_note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(document, kind, recruitment, title ?? previous?.title ?? `${kind} (${recruitment})`, form_label, html, change_note ?? null, user.id, now());
  return {
    saved: `${document} ${kind} (${recruitment}): ${form_label}`,
    note: 'Live experiments that use this document pick it up on their next load (they rebuild automatically). Saved versions are unaffected until restored.',
  };
}

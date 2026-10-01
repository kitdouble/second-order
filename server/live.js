// A study has one live experiment. Saving it (update_experiment) replaces it straight away for everyone,
// open participant links included. Each save is recorded as an internal revision, so data rows say
// exactly which code they came from, but nothing is pinned to old revisions: stimuli are always the
// study's current files.
//
// Saved versions are snapshots the researcher asks for ("save a version"): the code and its files, kept
// until deleted, and restorable.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, newId, newToken, now } from './db.js';
import { compileExperiment } from './compile.js';
import { currentManifest, FILES_DIR, fileUrl } from './stimuli.js';
import { documentSnapshot } from './documents.js';
import { findStudy, iso, StudyError } from './studies.js';
import { config } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS saved_versions (
    id          TEXT PRIMARY KEY,
    study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    name        TEXT NOT NULL,
    notes       TEXT,
    code        TEXT NOT NULL,
    stimuli     TEXT NOT NULL,              -- JSON {name: sha256}: these files are kept while the version exists
    revision    INTEGER NOT NULL,           -- the live revision it was saved from
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    UNIQUE (study_id, number)
  );
`);

const mb = (bytes) => Math.round(bytes / 1024 / 102.4) / 10;

/* ---------- The live revision ---------- */

export function currentRevision(studyId) {
  return db.prepare('SELECT * FROM study_versions WHERE study_id = ? ORDER BY number DESC LIMIT 1').get(studyId) ?? null;
}

const sameManifest = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

async function build(studyId, { code, notes, userId }) {
  const stimuli = currentManifest(studyId);
  const urls = Object.fromEntries(Object.entries(stimuli).map(([name, sha]) => [name, fileUrl(name, sha)]));
  const documents = documentSnapshot();
  const compiled = await compileExperiment(code, urls, documents); // throws CompileError with line numbers

  const id = newId();
  let number;
  db.exec('BEGIN IMMEDIATE');
  try {
    number = (db.prepare('SELECT MAX(number) AS n FROM study_versions WHERE study_id = ?').get(studyId).n ?? 0) + 1;
    db.prepare(
      `INSERT INTO study_versions (id, study_id, number, notes, code, packages, stimuli, documents, bundle_js, bundle_css, bundle_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, studyId, number, notes?.trim() || null, code, JSON.stringify(compiled.packages), JSON.stringify(stimuli),
      JSON.stringify(documents), compiled.js, compiled.css, compiled.hash, userId, now());
    // Only the live revision needs its bundles; older ones keep their code for the record.
    db.prepare("UPDATE study_versions SET bundle_js = '', bundle_css = '', dash_js = NULL, dash_css = NULL WHERE study_id = ? AND id != ?")
      .run(studyId, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { revision: db.prepare('SELECT * FROM study_versions WHERE id = ?').get(id), compiled, stimuli };
}

// Stimuli and consent/debrief texts are live: if either changed since the last build, rebuild (once) before serving.
const rebuilding = new Map();
export async function ensureCurrent(studyId) {
  const revision = currentRevision(studyId);
  if (!revision) return null;
  const docsUnchanged = (revision.documents ?? '') === JSON.stringify(documentSnapshot());
  if (sameManifest(JSON.parse(revision.stimuli), currentManifest(studyId)) && docsUnchanged && revision.bundle_js) return revision;
  if (!rebuilding.has(studyId)) {
    rebuilding.set(studyId, build(studyId, { code: revision.code, notes: 'Rebuilt: stimuli or consent texts changed', userId: revision.created_by })
      .then((r) => r.revision)
      .finally(() => rebuilding.delete(studyId)));
  }
  return rebuilding.get(studyId);
}

/** The study's preview link (one per study, stable across updates). */
export function previewToken(study, revisionId, userId) {
  const existing = db.prepare("SELECT token FROM links WHERE study_id = ? AND kind = 'preview' ORDER BY created_at DESC LIMIT 1").get(study.id);
  if (existing) return existing.token;
  const token = newToken();
  db.prepare("INSERT INTO links (token, study_id, version_id, kind, recruitment, created_by, created_at) VALUES (?, ?, ?, 'preview', 'none', ?, ?)")
    .run(token, study.id, revisionId, userId, now());
  return token;
}

export async function updateExperiment(user, studyId, { code, notes }) {
  const study = findStudy(user, studyId, 'edit');
  const hadParticipants = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE study_id = ? AND is_test = 0').get(study.id).n;
  const { revision, compiled, stimuli } = await build(study.id, { code, notes, userId: user.id });
  const token = previewToken(study, revision.id, user.id);
  return {
    revision: revision.number,
    preview_url: `${config.runOrigin}/s/${token}`,
    dashboard_url: `${config.runOrigin}/d/${token}`,
    packages: compiled.packages,
    stimuli: Object.keys(stimuli).length,
    warnings: compiled.warnings,
    note: hadParticipants
      ? 'Live now for everyone, including open participant links (people part-way through keep the page they have; a reload gets this one and restarts the study).'
      : 'Live now.',
  };
}

/* ---------- Saved versions (only when the researcher asks) ---------- */

export function saveVersion(user, studyId, { name, notes }) {
  const study = findStudy(user, studyId, 'edit');
  const revision = currentRevision(study.id);
  if (!revision) throw new StudyError('Nothing to save yet: write the experiment with update_experiment first.');
  const number = (db.prepare('SELECT MAX(number) AS n FROM saved_versions WHERE study_id = ?').get(study.id).n ?? 0) + 1;
  const stimuli = currentManifest(study.id);
  db.prepare(
    `INSERT INTO saved_versions (id, study_id, number, name, notes, code, stimuli, revision, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), study.id, number, name.trim(), notes?.trim() || null, revision.code, JSON.stringify(stimuli), revision.number, user.id, now());
  return { saved_version: number, name, files: Object.keys(stimuli).length, from_revision: revision.number };
}

export function listSavedVersions(studyId) {
  return db.prepare('SELECT number, name, notes, stimuli, revision, created_at FROM saved_versions WHERE study_id = ? ORDER BY number').all(studyId)
    .map((v) => ({ version: v.number, name: v.name, notes: v.notes, files: Object.keys(JSON.parse(v.stimuli)).length, from_revision: v.revision, saved: iso(v.created_at) }));
}

export function savedVersion(studyId, number) {
  const v = db.prepare('SELECT * FROM saved_versions WHERE study_id = ? AND number = ?').get(studyId, number);
  if (!v) throw new StudyError(`There is no saved version ${number}. list with get_study.`);
  return v;
}

// Make a saved version live again: its code and exactly its files.
export async function restoreVersion(user, studyId, { version, researcher_confirmed }) {
  const study = findStudy(user, studyId, 'edit');
  if (researcher_confirmed !== true) {
    throw new StudyError('Not restored. This replaces the live experiment and its files; confirm with the researcher first (and offer to save the current one as a version).');
  }
  const v = savedVersion(study.id, version);
  const files = JSON.parse(v.stimuli);
  const missing = Object.values(files).filter((sha) => !exists(sha));
  if (missing.length) throw new StudyError(`${missing.length} of this version's files are missing from storage; it can't be restored exactly.`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM stimuli WHERE study_id = ?').run(study.id);
    const insert = db.prepare('INSERT INTO stimuli (study_id, name, sha256, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [name, sha] of Object.entries(files)) insert.run(study.id, name, sha, sizeOf(sha), user.id, now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const result = await updateExperiment(user, studyId, { code: v.code, notes: `Restored saved version ${v.number} (${v.name})` });
  collectGarbage();
  return { restored: `${v.number}: ${v.name}`, ...result };
}

export function deleteSavedVersion(user, studyId, { version, researcher_confirmed }) {
  const study = findStudy(user, studyId, 'own');
  if (researcher_confirmed !== true) throw new StudyError('Not deleted. Confirm with the researcher first: this cannot be undone.');
  const v = savedVersion(study.id, version);
  db.prepare('DELETE FROM saved_versions WHERE id = ?').run(v.id);
  return { deleted_version: `${v.number}: ${v.name}`, ...collectGarbage() };
}

/* ---------- Storage ---------- */

function sizeOf(sha) {
  try {
    return statSync(join(FILES_DIR, sha)).size;
  } catch {
    return 0;
  }
}
const exists = (sha) => sizeOf(sha) > 0;

// Files are kept while a study's current stimuli or a saved version refers to them.
function referenced() {
  const refs = new Set(db.prepare('SELECT DISTINCT sha256 FROM stimuli').all().map((r) => r.sha256));
  for (const v of db.prepare('SELECT stimuli FROM saved_versions').all()) for (const sha of Object.values(JSON.parse(v.stimuli))) refs.add(sha);
  return refs;
}

const GRACE_MS = 60 * 60 * 1000; // files written in the last hour may belong to an upload in progress

/** Delete stored files nothing refers to. */
export function collectGarbage() {
  const refs = referenced();
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(FILES_DIR)) {
    const path = join(FILES_DIR, name);
    const stat = statSync(path);
    if (now() - stat.mtimeMs < GRACE_MS) continue;
    if (!name.startsWith('.upload-') && (!/^[0-9a-f]{64}$/.test(name) || refs.has(name))) continue;
    rmSync(path, { force: true });
    files++;
    bytes += stat.size;
  }
  return { files_deleted: files, mb_freed: mb(bytes) };
}

export function storageReport(user, studyId) {
  const study = findStudy(user, studyId);
  const current = [...new Set(db.prepare('SELECT sha256 FROM stimuli WHERE study_id = ?').all(study.id).map((r) => r.sha256))];
  const saved = db.prepare('SELECT * FROM saved_versions WHERE study_id = ? ORDER BY number').all(study.id);
  const allRefs = referenced();
  const versions = saved.map((v) => {
    const shas = [...new Set(Object.values(JSON.parse(v.stimuli)))];
    // Freed if deleted: files that neither the live study nor any other saved version (of any study) uses.
    const others = new Set(db.prepare('SELECT DISTINCT sha256 FROM stimuli').all().map((r) => r.sha256));
    for (const o of db.prepare('SELECT stimuli FROM saved_versions WHERE id != ?').all(v.id)) for (const sha of Object.values(JSON.parse(o.stimuli))) others.add(sha);
    return {
      version: v.number, name: v.name, saved: iso(v.created_at), files: shas.length,
      mb: mb(shas.reduce((s, sha) => s + sizeOf(sha), 0)),
      mb_freed_if_deleted: mb(shas.filter((sha) => !others.has(sha)).reduce((s, sha) => s + sizeOf(sha), 0)),
    };
  });
  return {
    study: study.id,
    live_files: { files: current.length, mb: mb(current.reduce((s, sha) => s + sizeOf(sha), 0)) },
    saved_versions: versions,
    note: `Files are stored once by content and shared, so deleting a saved version frees only files nothing else uses. Removed files are deleted from the server ` +
      `unless a saved version keeps them. Server-wide: ${allRefs.size} files in use.`,
  };
}

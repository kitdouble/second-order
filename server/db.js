import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credentials (
    id            TEXT PRIMARY KEY,           -- base64url credential id
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key    BLOB NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT,                       -- JSON array
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );

  -- Tokens are stored hashed; the raw token only ever exists in the link / cookie.
  CREATE TABLE IF NOT EXISTS invites (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL COLLATE NOCASE,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    created_by  TEXT REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    used_by     TEXT REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  -- Pending WebAuthn ceremonies, keyed by an id held in a short-lived cookie.
  CREATE TABLE IF NOT EXISTS challenges (
    id           TEXT PRIMARY KEY,
    challenge    TEXT NOT NULL,
    invite_hash  TEXT,
    user_id      TEXT,                       -- user the new passkey will belong to
    expires_at   INTEGER NOT NULL
  );

  /* ---------- OAuth (for Claude / ChatGPT connectors) ---------- */

  -- Registered (DCR) or fetched (client ID metadata document) clients.
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id   TEXT PRIMARY KEY,
    info        TEXT NOT NULL,              -- JSON OAuthClientInformationFull
    created_at  INTEGER NOT NULL
  );

  -- An /authorize request waiting for the person to sign in and approve.
  CREATE TABLE IF NOT EXISTS oauth_requests (
    id              TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    state           TEXT,
    scopes          TEXT NOT NULL,
    resource        TEXT,
    expires_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash       TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    scopes          TEXT NOT NULL,
    resource        TEXT,
    expires_at      INTEGER NOT NULL
  );

  -- Access and refresh tokens; a grant id ties a refresh chain together so it can be revoked as one.
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash  TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    grant_id    TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes      TEXT NOT NULL,
    resource    TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);

  /* ---------- Experiments ---------- */

  CREATE TABLE IF NOT EXISTS studies (
    id          TEXT PRIMARY KEY,           -- readable slug, e.g. stroop-k2f9
    title       TEXT NOT NULL,
    description TEXT,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL
  );

  -- Versions are immutable: every save makes a new one, compiled once.
  CREATE TABLE IF NOT EXISTS study_versions (
    id          TEXT PRIMARY KEY,
    study_id    TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    notes       TEXT,
    code        TEXT NOT NULL,
    packages    TEXT NOT NULL,              -- JSON {name: version} actually bundled
    bundle_js   TEXT NOT NULL,
    bundle_css  TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    UNIQUE (study_id, number)
  );

  -- A link runs exactly one version. Preview links mark their data as test data.
  CREATE TABLE IF NOT EXISTS links (
    token           TEXT PRIMARY KEY,
    study_id        TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    version_id      TEXT NOT NULL REFERENCES study_versions(id),
    kind            TEXT NOT NULL CHECK (kind IN ('preview', 'live')),
    recruitment     TEXT NOT NULL CHECK (recruitment IN ('prolific', 'sona', 'lab', 'none')),
    completion_url  TEXT,
    label           TEXT,
    created_by      TEXT NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    closed_at       INTEGER
  );

  CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    link_token      TEXT NOT NULL REFERENCES links(token),
    study_id        TEXT NOT NULL,
    version_id      TEXT NOT NULL,
    is_test         INTEGER NOT NULL,
    key_hash        TEXT NOT NULL,          -- the browser proves it owns the run with this key
    participant_id  TEXT,                   -- Prolific PID or SONA id
    params          TEXT NOT NULL,          -- JSON of recruitment URL parameters
    user_agent      TEXT,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    bytes           INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS runs_study ON runs(study_id);

  CREATE TABLE IF NOT EXISTS trials (
    run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    trial_index INTEGER NOT NULL,
    data        TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, trial_index)
  );
`);

// Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS won't add them).
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('runs', 'stopped', 'TEXT'); // why a block ended the run early, e.g. "device"
addColumn('study_versions', 'stimuli', "TEXT NOT NULL DEFAULT '{}'"); // JSON {name: sha256} fixed at save
// Dashboard bundle, built on first view and rebuilt when the dashboard code (package version) changes.
addColumn('study_versions', 'dash_js', 'TEXT');
addColumn('study_versions', 'dash_css', 'TEXT');
addColumn('study_versions', 'dash_hash', 'TEXT');
addColumn('study_versions', 'dash_build', 'TEXT');

export const now = () => Date.now();
export const DAY = 24 * 60 * 60 * 1000;
export const newId = () => randomUUID();
export const newToken = () => randomBytes(32).toString('base64url');
export const hash = (token) => createHash('sha256').update(token).digest('hex');

export function createInvite({ email, name, role = 'member', createdBy = null }) {
  const token = newToken();
  db.prepare(
    `INSERT INTO invites (token_hash, email, name, role, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(hash(token), email.trim(), name.trim(), role, createdBy, now(), now() + config.inviteDays * DAY);
  return { token, url: `${config.origin}/invite/${token}` };
}

export function findOpenInvite(token) {
  return db
    .prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(hash(String(token)), now());
}

export function pruneExpired() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  for (const table of ['challenges', 'oauth_requests', 'oauth_codes', 'oauth_tokens', 'upload_links']) {
    db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now());
  }
}

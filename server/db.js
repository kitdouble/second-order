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
`);

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
  for (const table of ['challenges', 'oauth_requests', 'oauth_codes', 'oauth_tokens']) {
    db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now());
  }
}

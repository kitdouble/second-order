// Database schema, shared by the researcher app and the ingest service.
// Idempotent: both services run migrate() on start. An advisory lock stops
// them racing each other.

export const SCHEMA_VERSION = 1;

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT,
  tier        TEXT NOT NULL CHECK (tier IN ('lab_head','trusted','supervised')),
  disabled    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time sign-in links (invites and new-device links). Only hashes stored.
CREATE TABLE IF NOT EXISTS login_links (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  created_by  UUID REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id        UUID NOT NULL REFERENCES users(id),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  used           BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id     UUID NOT NULL REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS studies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT UNIQUE NOT NULL,
  title          TEXT NOT NULL,
  owner_id       UUID NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','in_review','approved','piloting','pilot_review','live','paused','closed')),
  status_note    TEXT,
  current_hash   TEXT,
  approved_hash  TEXT,
  live_hash      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spec_versions (
  hash         TEXT PRIMARY KEY,
  study_id     UUID NOT NULL REFERENCES studies(id),
  yaml         TEXT NOT NULL,
  spec         JSONB NOT NULL,
  parent_hash  TEXT,
  message      TEXT,
  created_by   UUID REFERENCES users(id),
  created_via  TEXT NOT NULL,
  validation   JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spec_versions_study ON spec_versions (study_id, created_at DESC);

-- QA, simulation, pilot and drift reports, tied to a hash.
CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id    UUID NOT NULL REFERENCES studies(id),
  hash        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        JSONB NOT NULL,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_lookup ON reports (study_id, hash, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id      UUID NOT NULL REFERENCES studies(id),
  hash          TEXT NOT NULL,
  gate          TEXT NOT NULL CHECK (gate IN ('pilot','go_live')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','changes_requested','superseded')),
  summary       TEXT,
  requested_by  UUID REFERENCES users(id),
  decided_by    UUID REFERENCES users(id),
  decision_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);

-- Comments and AI findings. Findings carry severity and must be resolved.
CREATE TABLE IF NOT EXISTS comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id     UUID NOT NULL REFERENCES studies(id),
  hash         TEXT,
  author_id    UUID REFERENCES users(id),
  via          TEXT NOT NULL,
  body         TEXT NOT NULL,
  severity     TEXT CHECK (severity IN ('blocker','concern','consider')),
  path         TEXT,
  source       TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','ai_reviewer','ai_critic')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','note')),
  resolution   TEXT,
  resolved_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_study ON comments (study_id, created_at);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id    UUID NOT NULL REFERENCES studies(id),
  hash        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('verification','design_critic','analysis_check')),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','done','superseded')),
  claimed_at  TIMESTAMPTZ,
  done_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id           UUID NOT NULL REFERENCES studies(id),
  hash               TEXT NOT NULL,
  phase              TEXT NOT NULL CHECK (phase IN ('pilot','main')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','closed')),
  status_note        TEXT,
  prolific_study_id  TEXT,
  completion_code    TEXT,
  max_n              INTEGER NOT NULL,
  reward             NUMERIC,
  budget             NUMERIC,
  started_by         UUID REFERENCES users(id),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  study_id        UUID NOT NULL REFERENCES studies(id),
  hash            TEXT NOT NULL,
  deployment_id   UUID REFERENCES deployments(id),
  phase           TEXT NOT NULL CHECK (phase IN ('pilot','main','preview')),
  condition       TEXT NOT NULL,
  levels          JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','complete','declined','abandoned','withdrawn')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  minutes         NUMERIC,
  meta            JSONB,
  scored          JSONB,
  quality_flags   JSONB
);
CREATE INDEX IF NOT EXISTS sessions_deploy ON sessions (deployment_id, status);

-- The only place Prolific IDs live. No MCP tool reads this table.
CREATE TABLE IF NOT EXISTS participant_ids (
  session_id          TEXT PRIMARY KEY REFERENCES sessions(id),
  study_id            UUID NOT NULL REFERENCES studies(id),
  prolific_pid        TEXT NOT NULL,
  prolific_session_id TEXT,
  prolific_study_id   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS participant_once ON participant_ids (study_id, prolific_pid);

CREATE TABLE IF NOT EXISTS trials (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL,
  step         TEXT NOT NULL,
  trial_index  INTEGER NOT NULL,
  data         JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, step, trial_index)
);

CREATE TABLE IF NOT EXISTS preview_tokens (
  token_hash  TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  created_by  UUID REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS stop_checks (
  id             BIGSERIAL PRIMARY KEY,
  study_id       UUID NOT NULL REFERENCES studies(id),
  deployment_id  UUID NOT NULL REFERENCES deployments(id),
  n_included     INTEGER NOT NULL,
  n_x            INTEGER,
  n_y            INTEGER,
  bf10           DOUBLE PRECISION,
  decision       TEXT NOT NULL,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id    UUID NOT NULL REFERENCES studies(id),
  kind        TEXT NOT NULL CHECK (kind IN ('analysis','note','codes')),
  title       TEXT,
  content     TEXT NOT NULL,
  data_hash   TEXT,
  exploratory BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID REFERENCES users(id),
  created_via TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lab_settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   UUID,
  client    TEXT NOT NULL,
  action    TEXT NOT NULL,
  study_id  UUID,
  hash      TEXT,
  detail    JSONB
);
CREATE INDEX IF NOT EXISTS audit_study ON audit_log (study_id, at DESC);
`;

const done = new WeakMap();

/** Creates tables if needed. Safe to call on every start. */
export function migrate(pool) {
  if (!done.has(pool)) {
    const p = (async () => {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(424242)");
        await client.query(SQL);
      } finally {
        await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
        client.release();
      }
    })().catch((e) => {
      done.delete(pool);
      throw e;
    });
    done.set(pool, p);
  }
  return done.get(pool);
}

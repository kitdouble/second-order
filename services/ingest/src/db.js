// Postgres access for the ingest service (Neon in production).
import pg from "pg";

let pool = null;
let migrated = null;

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10_000,
      // Neon requires TLS; the connection string carries sslmode=require.
    });
  }
  return pool;
}

// Creates the table on first use. Idempotent.
export function migrate() {
  if (!migrated) {
    migrated = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS trials (
          id           BIGSERIAL PRIMARY KEY,
          study_hash   TEXT        NOT NULL,
          session_id   TEXT        NOT NULL,
          trial_index  INTEGER     NOT NULL,
          data         JSONB       NOT NULL,
          received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (session_id, trial_index)
        );
        CREATE INDEX IF NOT EXISTS trials_study_idx ON trials (study_hash);
      `)
      .catch((err) => {
        migrated = null; // allow a retry on the next request
        throw err;
      });
  }
  return migrated;
}

export async function ping() {
  await getPool().query("SELECT 1");
}

/**
 * Inserts a validated batch. Re-sent trials (same session and index) are
 * ignored, so the browser can retry safely after a network failure.
 * Returns { accepted, duplicates }.
 */
export async function insertBatch({ study_hash, session_id, trials }) {
  await migrate();
  const values = [];
  const params = [];
  trials.forEach((t, i) => {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb)`);
    params.push(study_hash, session_id, t.trial_index, JSON.stringify(t.data));
  });
  const result = await getPool().query(
    `INSERT INTO trials (study_hash, session_id, trial_index, data)
     VALUES ${values.join(", ")}
     ON CONFLICT (session_id, trial_index) DO NOTHING`,
    params,
  );
  return { accepted: result.rowCount, duplicates: trials.length - result.rowCount };
}

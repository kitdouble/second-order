// Postgres pool for the ingest service (Neon in production).
import pg from "pg";
import { migrate } from "@so/core/db";

let pool = null;

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

export async function ready() {
  const p = getPool();
  await migrate(p);
  return p;
}

export async function q(text, params) {
  const p = await ready();
  return p.query(text, params);
}

/** Runs fn(client) in a transaction. */
export async function tx(fn) {
  const p = await ready();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

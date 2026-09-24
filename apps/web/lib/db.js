// Postgres access for the researcher app.
import pg from "pg";
import { migrate } from "@so/core/db";

export const dbConfigured = () => Boolean(process.env.DATABASE_URL);

function pool() {
  if (!globalThis.__soPool) {
    globalThis.__soPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10_000 });
  }
  return globalThis.__soPool;
}

export async function q(text, params = []) {
  const p = pool();
  await migrate(p);
  return p.query(text, params);
}

export async function one(text, params = []) {
  return (await q(text, params)).rows[0] ?? null;
}

export async function tx(fn) {
  const p = pool();
  await migrate(p);
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** JSONB parameters must be strings: node-postgres sends JS arrays as SQL arrays. */
export const j = (v) => JSON.stringify(v ?? null);

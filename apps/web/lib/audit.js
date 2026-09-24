import { q, j } from "./db.js";

/** Append-only log. `client` is web, or the MCP client name (e.g. "mcp:Claude"). */
export async function audit(actor, action, { studyId = null, hash = null, detail = {} } = {}) {
  await q("INSERT INTO audit_log (user_id, client, action, study_id, hash, detail) VALUES ($1,$2,$3,$4,$5,$6)", [
    actor?.user?.id ?? null,
    actor?.client ?? "web",
    action,
    studyId,
    hash,
    j(detail),
  ]);
}

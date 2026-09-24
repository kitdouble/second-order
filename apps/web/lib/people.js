// Lab members, tiers and sign-in links. Lab head only.
import { q, one } from "./db.js";
import { createLoginLink } from "./auth.js";
import { audit } from "./audit.js";
import { ServiceError } from "./studies.js";

const requireHead = (actor) => {
  if (actor.user.tier !== "lab_head") throw new ServiceError("Only the lab head manages people.", 403);
};

export async function listPeople(actor) {
  requireHead(actor);
  return (
    await q(
      `SELECT u.*, (SELECT count(*) FROM studies s WHERE s.owner_id = u.id AND s.slug <> '_library') AS studies,
              (SELECT max(created_at) FROM web_sessions w WHERE w.user_id = u.id) AS last_sign_in,
              (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
       FROM users u ORDER BY u.disabled, u.created_at`,
    )
  ).rows;
}

export async function addPerson(actor, { name, tier }) {
  requireHead(actor);
  if (!name?.trim()) throw new ServiceError("Give a name.");
  if (!["trusted", "supervised", "lab_head"].includes(tier)) throw new ServiceError("Unknown tier.");
  const u = await one("INSERT INTO users (name, tier) VALUES ($1,$2) RETURNING *", [name.trim(), tier]);
  const token = await createLoginLink(u.id, actor.user.id, 7);
  await audit(actor, "person_added", { detail: { person: u.id, tier } });
  return { user: u, token };
}

export async function issueLink(actor, userId) {
  requireHead(actor);
  const u = await one("SELECT * FROM users WHERE id = $1", [userId]);
  if (!u) throw new ServiceError("No such person.");
  const token = await createLoginLink(u.id, actor.user.id, 7);
  await audit(actor, "sign_in_link_issued", { detail: { person: u.id } });
  return { user: u, token };
}

export async function setTier(actor, userId, tier) {
  requireHead(actor);
  if (!["trusted", "supervised", "lab_head"].includes(tier)) throw new ServiceError("Unknown tier.");
  if (userId === actor.user.id && tier !== "lab_head") throw new ServiceError("You can't demote yourself.");
  await q("UPDATE users SET tier = $2 WHERE id = $1", [userId, tier]);
  await audit(actor, "tier_changed", { detail: { person: userId, tier } });
}

export async function setDisabled(actor, userId, disabled) {
  requireHead(actor);
  if (userId === actor.user.id) throw new ServiceError("You can't disable yourself.");
  await q("UPDATE users SET disabled = $2 WHERE id = $1", [userId, disabled]);
  if (disabled) {
    await q("DELETE FROM web_sessions WHERE user_id = $1", [userId]);
    await q("UPDATE oauth_tokens SET revoked = true WHERE user_id = $1", [userId]);
  }
  await audit(actor, disabled ? "person_disabled" : "person_enabled", { detail: { person: userId } });
}

export async function listConnections(actor) {
  return (
    await q(
      `SELECT t.client_id, c.client_name, max(t.created_at) AS last_token, count(*) FILTER (WHERE NOT t.revoked AND t.expires_at > now()) AS live_tokens
       FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id WHERE t.user_id = $1 GROUP BY t.client_id, c.client_name ORDER BY 3 DESC`,
      [actor.user.id],
    )
  ).rows;
}

export async function revokeConnection(actor, clientId) {
  await q("UPDATE oauth_tokens SET revoked = true WHERE user_id = $1 AND client_id = $2", [actor.user.id, clientId]);
  await audit(actor, "connection_revoked", { detail: { client_id: clientId } });
}

export async function auditLog(actor, limit = 200) {
  requireHead(actor);
  return (
    await q(
      `SELECT a.at, a.client, a.action, a.hash, a.detail, u.name AS user_name, s.slug FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN studies s ON s.id = a.study_id ORDER BY a.at DESC LIMIT $1`,
      [limit],
    )
  ).rows;
}

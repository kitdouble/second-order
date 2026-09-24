// OAuth 2.1 authorisation server for MCP clients (Claude, ChatGPT).
// Dynamic client registration, authorisation code + PKCE (S256), rotating
// refresh tokens. Tokens are stored hashed.
import { q, one, tx, j } from "./db.js";
import { newToken, sha256, s256 } from "./tokens.js";

export const ACCESS_TTL_S = 3600;
const REFRESH_DAYS = 60;

export function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function registerClient(body) {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || !uris.every(validRedirect)) return { error: "invalid_redirect_uri", error_description: "redirect_uris must be https (or http on localhost)." };
  const name = String(body.client_name ?? "MCP client").slice(0, 100);
  const clientId = `so_${newToken(12)}`;
  await q("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,$2,$3)", [clientId, name, j(uris)]);
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function getClient(clientId) {
  return one("SELECT * FROM oauth_clients WHERE client_id = $1", [clientId]);
}

export async function issueCode({ clientId, userId, redirectUri, codeChallenge }) {
  const code = newToken(24);
  await q(
    "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')",
    [sha256(code), clientId, userId, redirectUri, codeChallenge],
  );
  return code;
}

async function issueTokens(c, clientId, userId) {
  const access = newToken(32);
  const refresh = newToken(32);
  await c.query("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES ($1,'access',$2,$3, now() + make_interval(secs => $4))", [
    sha256(access),
    clientId,
    userId,
    ACCESS_TTL_S,
  ]);
  await c.query("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES ($1,'refresh',$2,$3, now() + make_interval(days => $4))", [
    sha256(refresh),
    clientId,
    userId,
    REFRESH_DAYS,
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "studies" };
}

const err = (error, error_description) => ({ error, error_description });

export async function tokenRequest(p) {
  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier || !p.client_id) return err("invalid_request", "code, code_verifier and client_id are required.");
    return tx(async (c) => {
      const row = (
        await c.query("UPDATE oauth_codes SET used = true WHERE code_hash = $1 AND NOT used AND expires_at > now() RETURNING *", [sha256(p.code)])
      ).rows[0];
      if (!row) return err("invalid_grant", "Code is invalid, used or expired.");
      if (row.client_id !== p.client_id) return err("invalid_grant", "Code was issued to another client.");
      if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return err("invalid_grant", "redirect_uri mismatch.");
      if (s256(p.code_verifier) !== row.code_challenge) return err("invalid_grant", "PKCE check failed.");
      return issueTokens(c, row.client_id, row.user_id);
    });
  }
  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) return err("invalid_request", "refresh_token is required.");
    return tx(async (c) => {
      const row = (
        await c.query(
          "UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1 AND kind = 'refresh' AND NOT revoked AND expires_at > now() RETURNING *",
          [sha256(p.refresh_token)],
        )
      ).rows[0];
      if (!row) return err("invalid_grant", "Refresh token is invalid or expired.");
      if (p.client_id && p.client_id !== row.client_id) return err("invalid_grant", "Token was issued to another client.");
      const user = (await c.query("SELECT disabled FROM users WHERE id = $1", [row.user_id])).rows[0];
      if (!user || user.disabled) return err("invalid_grant", "User is disabled.");
      return issueTokens(c, row.client_id, row.user_id);
    });
  }
  return err("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** Resolves a Bearer token to { user, client } or null. */
export async function bearerActor(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!m) return null;
  const row = await one(
    `SELECT u.*, c.client_name FROM oauth_tokens t JOIN users u ON u.id = t.user_id JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND NOT t.revoked AND t.expires_at > now() AND NOT u.disabled`,
    [sha256(m[1].trim())],
  );
  if (!row) return null;
  const { client_name, ...user } = row;
  return { user, client: `mcp:${client_name}` };
}

export function authServerMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["studies"],
  };
}

export function resourceMetadata(base) {
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: ["studies"],
    bearer_methods_supported: ["header"],
    resource_name: "Second Order",
  };
}
